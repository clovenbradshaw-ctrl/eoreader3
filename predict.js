/* ============================================================ Predictive fold
   The reading reaches FORWARD. As the engine walks a document it settles a
   fold; this layer adds the forward arrow as recorded evidence: at each span the
   reading carries an EXPECTATION of what comes next, and when the actual span
   lands we keep the DELTA between them. Coherence when the document confirms the
   expectation; rupture when it breaks it.

   Two design facts from the stack decide the shape here:
     · The local model exposes no per-token logprobs, so Tier-1 surprisal is not
       buildable yet — it's a hard prerequisite (a model-binding patch), not a
       thing to approximate by generation.
     · Embeddings ARE ready (EOEmbed → 384-d, L2-normalized, cosine = dot).
   So the EXPECTATION is an embedding-space vector — a recency-weighted trajectory
   of the spans just read — and the delta is measured against the next span's
   embedding. The faithful generative prediction (one sentence of "what happens
   next") and the logprob surprisal layer slot in later, auditor-facing; their
   seams are named below.

   HARD CONSTRAINTS honored here:
     · Observational only. Everything in this module is a PURE pass over the
       events the walk already emitted (doc._events) plus span embeddings. It
       computes and records; it never feeds back into the walk, and the walk's
       output is byte-identical whether or not this runs.
     · Talker isolation. Coefficients, deltas and expectations live only on the
       reading-modal's UI state. They may shape what surfaces; they are never
       what the talker reads. Nothing here is wired into the answer pipeline.
   ============================================================ */
(function () {
  'use strict';

  // Tunable floors (exposed on the namespace for sweeps).
  //  CONFIRM_FLOOR — coefficient at/above which a span CONFIRMS the expectation
  //                  (coherence); below it the reading was wrong here (rupture).
  //  GATE_FLOOR    — delta magnitude at/above which the miss-DIRECTION is real
  //                  signal rather than noise. Most predictions are roughly
  //                  right; their tiny deltas point every which way. The
  //                  direction axis only means something above this gate. (The
  //                  direction index itself is a later build; we carry the flag.)
  const CONFIRM_FLOOR = 0.5;
  const GATE_FLOOR = 0.9;
  // How fast the expectation forgets older spans (in spans). A short half-life
  // makes the reading expect the local trajectory; a long one, the whole run.
  const EXPECT_HALFLIFE = 4;

  // Local-baseline normalization (spec §Tier-1(b), applied to BOTH channels):
  // surprise is deviation ABOVE a rolling local baseline, never an absolute. A
  // genuine event spikes above its own neighborhood; a uniformly busy (or ornate)
  // stretch has a high-but-flat baseline and produces no spike.
  const BASELINE_WINDOW = 30;   // sentences in the trailing local baseline
  const BASELINE_MIN = 8;       // need this many before a z-score means anything
  const Z_SPIKE = 2;            // z at/above which a channel has "spiked"

  // Tier 0 — mechanical surprise weights. The structural prediction errors the
  // engine already computes: a fresh INS (a name arrived where none was
  // extrapolated), a contested NUL stall (a referent that won't resolve — the
  // shell-company case), a strained/contested SYN bind (it barely held), a fresh
  // CON relation. The NUL stall is weighted highest: a reference that fails to
  // resolve is the strongest structural surprise an investigation cares about.
  const MECH_WEIGHTS = { ins: 1.0, nul: 1.6, bind: 1.1, con: 0.7 };

  // The three site kinds the brief triages on. Elsewhere a span is read but not
  // flagged; at a site the miss is high-value (a contested reference, a cut).
  const SiteKind = { ReferenceBoundary: 'ReferenceBoundary', EventBoundary: 'EventBoundary', SurprisalSpike: 'SurprisalSpike' };

  function dot(a, b) {
    let d = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) d += a[i] * b[i];
    return d;
  }
  function norm(v) { return Math.sqrt(dot(v, v)); }
  function unit(v) {
    const m = norm(v); if (!m) return null;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / m;
    return out;
  }

  // The expectation at span i: a recency-weighted mean of the unit embeddings of
  // the spans before it, re-normalized to the unit sphere so it lives in the
  // same space as an actual embedding. This is the TAIL of the arrow — "what the
  // reading expected this sort of thing to be," kept whole. null at the opening
  // (nothing precedes the first span to expect from).
  function expectation(embeddings, i, halfLife) {
    if (i <= 0) return null;
    const hl = halfLife || EXPECT_HALFLIFE;
    const dim = embeddings[0] ? embeddings[0].length : 0;
    if (!dim) return null;
    const acc = new Float32Array(dim);
    let any = false;
    for (let j = i - 1; j >= 0; j--) {
      const e = embeddings[j]; if (!e) continue;
      const w = Math.pow(0.5, (i - 1 - j) / hl);
      for (let k = 0; k < dim; k++) acc[k] += w * e[k];
      any = true;
      if (w < 0.02) break;            // older spans are forgotten — stop summing
    }
    return any ? unit(acc) : null;
  }

  // Site kinds, read straight off the event log the walk already produced. A
  // pronoun stall or a freshly-opened signal is a REFERENCE boundary (the
  // reading is unsure who); a speaker change or a section break is an EVENT
  // boundary (the scene moved). Returns Map<sentenceIdx, SiteKind>.
  function siteKinds(doc) {
    const out = new Map();
    const events = (doc && doc._events) || [];
    let lastSpeaker = null;
    for (const ev of events) {
      const i = ev.sentence_idx;
      if (i == null) continue;
      if (ev.op === 'NUL') {
        const r = String(ev.reason || '');
        if (r.indexOf('pronoun-stall') === 0 || r === 'signal-birth') out.set(i, SiteKind.ReferenceBoundary);
      } else if (ev.op === 'SIG' && ev.speaker && ev.speaker !== '?') {
        if (lastSpeaker != null && ev.speaker !== lastSpeaker && !out.has(i)) out.set(i, SiteKind.EventBoundary);
        lastSpeaker = ev.speaker;
      }
    }
    // Section boundaries — the document's own scene marks.
    for (const s of (doc && doc._sections) || []) {
      if (s && s.start_sentence != null && !out.has(s.start_sentence)) out.set(s.start_sentence, SiteKind.EventBoundary);
    }
    return out;
  }

  // Tier 0 — mechanical surprise, free, off the event log the walk already
  // produced. Per sentence: a fresh INS, a contested NUL stall, a strained or
  // contested SYN bind (low `observed.force`, or competitors), a fresh CON
  // relation. Returns the raw per-sentence score and its component breakdown
  // (kept for the glass box — the curve is showable and disputable). Style-blind
  // by construction: it never sees a token, only structure.
  function mechanicalRaw(doc, n, weights) {
    const W = Object.assign({}, MECH_WEIGHTS, weights || {});
    const comp = [];
    for (let i = 0; i < n; i++) comp.push({ ins: 0, nul: 0, bind: 0, con: 0 });
    for (const ev of (doc && doc._events) || []) {
      const i = ev.sentence_idx;
      if (i == null || i < 0 || i >= n) continue;
      if (ev.op === 'INS') comp[i].ins += 1;
      else if (ev.op === 'NUL') { const r = String(ev.reason || ''); if (r.indexOf('pronoun-stall') === 0 || r === 'signal-birth') comp[i].nul += 1; }
      else if (ev.op === 'SYN') {
        const f = ev.observed && ev.observed.force;
        const strain = Math.max(0, 1 - (f == null ? 1 : f));               // a weak bind is a surprised bind
        const contested = (ev.observed && ev.observed.competing && ev.observed.competing.length) ? 0.5 : 0;
        comp[i].bind += strain + contested;
      } else if (ev.op === 'CON') comp[i].con += 1;
    }
    const raw = comp.map(c => W.ins * c.ins + W.nul * c.nul + W.bind * c.bind + W.con * c.con);
    return { raw, comp };
  }

  // Deviation above the rolling LOCAL baseline (causal: only the reading-so-far).
  // null inputs are gaps (skipped from the baseline, null in the output); a
  // value with too little baseline behind it, or a flat neighborhood, reads 0.
  function rollingZ(values, window, minN) {
    window = window || BASELINE_WINDOW; minN = minN || BASELINE_MIN;
    const n = values.length, out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (values[i] == null) continue;
      const lo = Math.max(0, i - window + 1), buf = [];
      for (let j = lo; j <= i; j++) { const v = values[j]; if (v != null) buf.push(v); }
      if (buf.length < minN) { out[i] = 0; continue; }
      let m = 0; for (const v of buf) m += v; m /= buf.length;
      let s = 0; for (const v of buf) s += (v - m) * (v - m); s = Math.sqrt(s / buf.length);
      out[i] = s < 1e-6 ? 0 : Math.round(((values[i] - m) / s) * 1000) / 1000;
    }
    return out;
  }

  // The timeline: one record per span (0..n-1). FUSION of two channels, each
  // z-scored against its own rolling baseline, combined OR-above-threshold:
  //   · mech — Tier 0 structural surprise (always on, free).
  //   · emb  — embedding-expectation surprise (a cheap semantic channel; the
  //            faithful Tier-1 LM probe is deferred behind this seam).
  // Embeddings are optional: with none, the mechanical floor still plays. Each
  // record also keeps the raw embedding delta (coefficient/magnitude/embSign)
  // for the direction work, and which channel(s) spiked.
  function buildTimeline(doc, embeddings, opts) {
    opts = opts || {};
    const hl = opts.halfLife || EXPECT_HALFLIFE;
    const confirm = opts.confirmFloor != null ? opts.confirmFloor : CONFIRM_FLOOR;
    const gate = opts.gateFloor != null ? opts.gateFloor : GATE_FLOOR;
    const win = opts.baselineWindow || BASELINE_WINDOW;
    const zSpike = opts.zSpike != null ? opts.zSpike : Z_SPIKE;
    const sites = siteKinds(doc);
    const hasEmb = !!(embeddings && embeddings.length);
    const n = opts.n || (hasEmb ? embeddings.length : ((doc && (doc.sentenceTexts || doc.sentences)) || []).length || 0);
    if (!n) return [];

    const { raw: mraw, comp } = mechanicalRaw(doc, n, opts.weights);
    const mechZ = rollingZ(mraw, win, BASELINE_MIN);

    const embRaw = new Array(n).fill(null);
    const coeffArr = new Array(n).fill(null);
    const magArr = new Array(n).fill(null);
    if (hasEmb) {
      for (let i = 0; i < n; i++) {
        const act = embeddings[i]; if (!act) continue;
        const exp = expectation(embeddings, i, hl); if (!exp) continue;
        const c = Math.max(-1, Math.min(1, dot(exp, act)));
        coeffArr[i] = Math.round(c * 1000) / 1000;
        magArr[i] = Math.round(Math.sqrt(Math.max(0, 2 - 2 * c)) * 1000) / 1000;
        embRaw[i] = 1 - c;                            // higher ⇒ more surprising
      }
    }
    const embZ = rollingZ(embRaw, win, BASELINE_MIN);

    const rows = [];
    for (let i = 0; i < n; i++) {
      const mz = mechZ[i] == null ? 0 : mechZ[i];
      const ez = embZ[i];
      const fused = ez == null ? mz : Math.max(mz, ez);
      rows.push({
        i,
        surprise: Math.round(fused * 1000) / 1000,
        mech: Math.round(mz * 1000) / 1000,
        emb: ez == null ? null : Math.round(ez * 1000) / 1000,
        sign: fused >= zSpike ? 'rupture' : 'coherence',
        struct: mz >= zSpike,                          // Tier 0 spiked here
        semantic: ez != null && ez >= zSpike,          // the semantic channel spiked
        components: comp[i],
        coefficient: coeffArr[i],
        magnitude: magArr[i],
        embSign: coeffArr[i] == null ? null : (coeffArr[i] < confirm ? 'rupture' : 'coherence'),
        directionGated: magArr[i] != null && magArr[i] >= gate,
        site: sites.get(i) || null,
      });
    }
    return rows;
  }

  // A one-glance read of a whole timeline: spans, how many ruptured (and via
  // which channel), the mean embedding coefficient, and the most surprising span.
  function summarize(timeline) {
    let measured = 0, ruptures = 0, structural = 0, semantic = 0, sum = 0, cnt = 0, peak = null;
    for (const r of (timeline || [])) {
      measured++;
      if (r.sign === 'rupture') ruptures++;
      if (r.struct) structural++;
      if (r.semantic) semantic++;
      if (r.coefficient != null) { sum += r.coefficient; cnt++; }
      if (!peak || r.surprise > peak.surprise) peak = r;
    }
    return {
      measured, ruptures, structuralRuptures: structural, semanticRuptures: semantic,
      meanCoefficient: cnt ? Math.round(sum / cnt * 1000) / 1000 : null, peak,
    };
  }

  // Orchestration for the live unfold. Tier 0 (mechanical) always runs — no
  // model, no download — so the reading plays even with no embedder. If the
  // embedder is present, the semantic channel is fused in (a bounded prefix so a
  // long book can't stall the moment). Returns null only when there's nothing to
  // read. Async (embedding is async); a pure side-effect over the settled walk.
  async function buildPlayback(doc, base, opts) {
    opts = opts || {};
    const cap = opts.cap || 600;
    if (!doc || doc.kind !== 'prose') return null;
    const texts = (doc.sentenceTexts || (doc.sentences || []).map(s => s && s.t) || []).map(t => String(t || ''));
    const n = Math.min(texts.length, cap);
    if (n < 3) return null;                          // too short to read forward
    let embeddings = null;
    const Embed = (typeof window !== 'undefined') && window.EOEmbed;
    if (Embed) { try { embeddings = await Embed.embedSentences(texts.slice(0, n)); } catch (e) { embeddings = null; } }
    const timeline = buildTimeline(doc, embeddings, Object.assign({ n }, opts));
    const spans = timeline.map(r => Object.assign({ t: texts[r.i] || '' }, r));
    return {
      spans,
      summary: summarize(timeline),
      total: texts.length,
      capped: n < texts.length ? n : null,
      hasEmbeddings: !!(embeddings && embeddings.length),
      // SEAMS (built nothing): the faithful Tier-1 LM probe attaches here when
      // ready — a SEPARATE tiny causal LM (transformers.js, ~80–135M) emitting
      // next-token surprisal, z-scored like the channels above, fused as a third
      // OR term. Its logits are reachable (unlike the MLC answer model), so it is
      // a real build, gated on test 1 (a non-structural surprise the floor misses).
    };
  }

  const EOPredict = {
    SiteKind, CONFIRM_FLOOR, GATE_FLOOR, EXPECT_HALFLIFE, BASELINE_WINDOW, BASELINE_MIN, Z_SPIKE, MECH_WEIGHTS,
    expectation, siteKinds, mechanicalRaw, rollingZ, buildTimeline, summarize, buildPlayback,
    _dot: dot, _unit: unit,
  };
  if (typeof window !== 'undefined') window.EOPredict = EOPredict;
  if (typeof module !== 'undefined' && module.exports) module.exports = EOPredict;
})();
