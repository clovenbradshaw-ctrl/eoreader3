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

  // The timeline: one record per embedded span. `embeddings` is aligned to
  // sentence index 0..M-1 (a prefix is fine — records only run while embeddings
  // exist). Each record keeps the delta whole enough to sort later: the
  // coefficient ("how true it seemed"), the magnitude (the miss size), the sign,
  // and whether the miss-direction cleared the noise gate.
  function buildTimeline(doc, embeddings, opts) {
    opts = opts || {};
    const hl = opts.halfLife || EXPECT_HALFLIFE;
    const confirm = opts.confirmFloor != null ? opts.confirmFloor : CONFIRM_FLOOR;
    const gate = opts.gateFloor != null ? opts.gateFloor : GATE_FLOOR;
    const sites = siteKinds(doc);
    if (!embeddings || !embeddings.length) return [];
    const rows = [];
    for (let i = 0; i < embeddings.length; i++) {
      const act = embeddings[i];
      const site = sites.get(i) || null;
      if (!act) { rows.push({ i, coefficient: null, magnitude: null, sign: 'coherence', site, directionGated: false }); continue; }
      const exp = expectation(embeddings, i, hl);
      if (!exp) { rows.push({ i, coefficient: null, magnitude: null, sign: 'coherence', site, directionGated: false }); continue; }
      const coeff = Math.max(-1, Math.min(1, dot(exp, act)));
      const mag = Math.sqrt(Math.max(0, 2 - 2 * coeff));   // unit vectors ⇒ ‖a−b‖
      rows.push({
        i,
        coefficient: Math.round(coeff * 1000) / 1000,
        magnitude: Math.round(mag * 1000) / 1000,
        sign: coeff >= confirm ? 'coherence' : 'rupture',
        directionGated: mag >= gate,
        site,
      });
    }
    return rows;
  }

  // A one-glance read of a whole timeline: how many spans carried a real
  // expectation, how many ruptured, the mean coefficient (aboutness pull), and
  // the single most surprising span.
  function summarize(timeline) {
    let measured = 0, ruptures = 0, sum = 0, peak = null;
    for (const r of (timeline || [])) {
      if (r.coefficient == null) continue;
      measured++; sum += r.coefficient;
      if (r.sign === 'rupture') ruptures++;
      if (!peak || r.magnitude > peak.magnitude) peak = r;
    }
    return { measured, ruptures, meanCoefficient: measured ? Math.round(sum / measured * 1000) / 1000 : null, peak };
  }

  // Orchestration for the live unfold: embed the prose (a bounded prefix so a
  // long book can't stall the moment), build the timeline, and hand back a
  // playback the reading modal can play forward. Returns null when there's no
  // embedder, nothing to read, or too little to predict from — the modal then
  // falls back to its plain reveal. Async (embedding is async); pure side-effect.
  async function buildPlayback(doc, base, opts) {
    opts = opts || {};
    const cap = opts.cap || 600;
    const Embed = (typeof window !== 'undefined') && window.EOEmbed;
    if (!Embed || !doc || doc.kind !== 'prose') return null;
    const texts = (doc.sentenceTexts || (doc.sentences || []).map(s => s && s.t) || []).map(t => String(t || ''));
    const n = Math.min(texts.length, cap);
    if (n < 3) return null;                       // too short to carry an expectation
    let embeddings;
    try { embeddings = await Embed.embedSentences(texts.slice(0, n)); }
    catch (e) { embeddings = null; }
    if (!embeddings || !embeddings.length) return null;
    const timeline = buildTimeline(doc, embeddings, opts);
    const spans = timeline.map(r => Object.assign({ t: texts[r.i] || '' }, r));
    return {
      spans,
      summary: summarize(timeline),
      total: texts.length,
      capped: n < texts.length ? n : null,
      // SEAMS (built nothing): the faithful layers attach here when ready —
      //   generated_text: local_predict at sites (auditor-only, never talker)
      //   surprisal:      per-token logprobs once the model binding exposes them
    };
  }

  const EOPredict = {
    SiteKind, CONFIRM_FLOOR, GATE_FLOOR, EXPECT_HALFLIFE,
    expectation, siteKinds, buildTimeline, summarize, buildPlayback,
    _dot: dot, _unit: unit,
  };
  if (typeof window !== 'undefined') window.EOPredict = EOPredict;
  if (typeof module !== 'undefined' && module.exports) module.exports = EOPredict;
})();
