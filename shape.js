/* ============================================================
   Cleon — the SHAPE layer (shape-steered generation).

   The content layer (engine.js) hands the model what's true and relevant;
   THIS layer steers the model toward the right FORM. They are kept apart on
   purpose: content owns what to say (spans, notes, citations, the verifier);
   shape owns how to say it (length, register, commitment, structure). The
   model does the linguistic work of joining them.

   "Thinking" here is the iterative search for the right shape for an answer
   whose content is already settled. A small drafting loop re-asks the same
   model with shape-revision instructions between drafts, scores each draft
   against a library of pre-written exemplars, and exits when the draft lands
   in the target shape's basin — or honestly reports that it didn't.

   Five pieces, all pure and dependency-injected so they run in Node (the
   test harness) with no WebGPU and no network:
     1. the exemplar library          — parse + cache response embeddings
     2. the discriminative score (§5)  — s_t − s_c: in-basin vs. competitors
     3. the adaptive threshold (§5)    — higher where shapes crowd together
     4. the interpretable axes (§6/§7) — structural features → revision notes
     5. the drafting controller (§4)   — the loop that replaces a one-shot call

   Generation (EOLLM.phrase) and embedding (EOEmbed.embedQuery) are passed IN
   as functions; this module never imports them. So the live app wires the
   real model + embedder, while tests inject fakes. With no library loaded the
   module is inert and callers fall back to the existing single-call path —
   parity holds.

   Published as window.EOShape.
   ============================================================ */
(function () {
  'use strict';

  /* ---- vector math -------------------------------------------------------
     EOEmbed L2-normalizes every vector (normalize:true), so for live vectors
     cosine IS a plain dot product. cosine() normalizes defensively anyway so
     hand-built test vectors (and any unnormalized input) behave. */
  function dot(a, b) {
    if (!a || !b) return 0;
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }
  function norm(a) { return Math.sqrt(dot(a, a)) || 1; }
  function cosine(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    return dot(a, b) / (norm(a) * norm(b));
  }
  // Weighted mean of rows → a centroid. weights default to 1 (the Hebbian
  // multiplier of §11; the update loop is deferred but the field flows through
  // here from day one, so the data shape is forward-compatible).
  function centroid(rows, weights) {
    const live = rows.filter(Boolean);
    if (!live.length) return null;
    const d = live[0].length;
    const out = new Float32Array(d);
    let wsum = 0;
    for (let r = 0; r < live.length; r++) {
      const w = weights && weights[r] != null ? weights[r] : 1;
      wsum += w;
      for (let i = 0; i < d; i++) out[i] += live[r][i] * w;
    }
    if (wsum) for (let i = 0; i < d; i++) out[i] /= wsum;
    return out;
  }

  /* ---- the exemplar library (§3.2) ---------------------------------------
     A JSONL file of pre-written responses spanning every shape Cleon makes.
     Each line: { intent, shape_tags, user_turn, context_sketch, response,
     notes, weight }. The content is deliberately topic-neutral — the SHAPE is
     the signal. parseExemplars is defensive like the conventions loader:
     blank lines, // comments, and malformed JSON are skipped, never thrown. */
  function parseExemplars(text) {
    const out = [];
    const lines = String(text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//') || line.startsWith('#')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (e) { continue; }
      if (!rec || typeof rec !== 'object') continue;
      // intent + response are the load-bearing fields; the rest default.
      if (!rec.intent || !rec.response) continue;
      out.push({
        id: rec.id || ('ex-' + (out.length + 1)),
        intent: String(rec.intent),
        shape_tags: Array.isArray(rec.shape_tags) ? rec.shape_tags : [],
        // The library declares each exemplar's anchored poles ("pole:short",
        // "pole:committed", …) — both ends of every interpretable axis, so the
        // axes survive an embedder swap as centroid differences (§7). Carried
        // through and used for axis hints below.
        anchor_axes: Array.isArray(rec.anchor_axes) ? rec.anchor_axes : [],
        user_turn: rec.user_turn || '',
        context_sketch: rec.context_sketch || '',
        response: String(rec.response),
        notes: rec.notes || '',
        weight: typeof rec.weight === 'number' ? rec.weight : 1,
      });
    }
    return out;
  }

  /* ---- interpretable structural features (§6 v2 / §7) --------------------
     The revision instruction between drafts has to be natural language the
     model can act on ("shorter", "less hedged", "drop the list") — not "move
     0.3 along PC-47". §7 reaches that via PCA over the embeddings, hand-labeled
     at the extremes. That labeling needs the real (finalized) embedding space,
     so for v1 we use the structural features §6 v2 already names — length,
     lists, hedging, first-person, sentence-length variance — which ARE the
     interpretable axes, computed straight from the text, no labeling step.
     pca()/projectError() below provide the §7-proper machinery for when the
     library has stabilized and the axes can be labeled. */
  const HEDGES = ['maybe', 'perhaps', 'might', 'could', 'possibly', 'seems', 'seem',
    'likely', 'arguably', 'presumably', 'somewhat', 'rather', 'fairly', 'i think',
    'i suppose', 'sort of', 'kind of', 'probably', 'apparently', 'i guess', 'not sure'];
  // Committal adverbials only — no bare copulas ("is"/"are"), which substring-
  // match common words and inflate the count. commitDensity is informational
  // (it rides the feature record); the commitment AXIS keys off hedgeDensity.
  const COMMITTAL = ['clearly', 'certainly', 'definitely', 'plainly',
    'the answer is', 'in fact', 'indeed', 'without question'];
  const FIRST_PERSON = /\b(i|i'm|i've|i'll|i'd|me|my|mine|myself)\b/gi;

  function countMatches(haystack, needles) {
    const t = ' ' + String(haystack || '').toLowerCase() + ' ';
    let n = 0;
    for (const w of needles) { let from = 0, idx; while ((idx = t.indexOf(w, from)) !== -1) { n++; from = idx + w.length; } }
    return n;
  }
  function structuralFeatures(text) {
    const t = String(text || '');
    const words = t.trim() ? t.trim().split(/\s+/) : [];
    const wc = words.length || 1;
    const sentences = t.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    const sentLens = sentences.map(s => s.split(/\s+/).length);
    const paragraphs = t.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const listMarkers = (t.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) || []).length;
    const ascii = /```|(?:^|\n)\s*\|.*\|/.test(t) ? 1 : 0;
    const fp = (t.match(FIRST_PERSON) || []).length;
    const hedge = countMatches(t, HEDGES);
    const commit = countMatches(t, COMMITTAL);
    const mean = sentLens.length ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
    const variance = sentLens.length ? sentLens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sentLens.length : 0;
    return {
      words: words.length,
      sentences: sentences.length,
      paragraphs: paragraphs.length,
      lists: listMarkers,
      ascii,
      hedgeDensity: hedge / wc,
      commitDensity: commit / wc,
      firstPersonDensity: fp / wc,
      sentLenVar: variance,
    };
  }
  function avgFeatures(texts) {
    const fs = texts.map(structuralFeatures);
    if (!fs.length) return structuralFeatures('');
    const keys = Object.keys(fs[0]);
    const out = {};
    for (const k of keys) out[k] = fs.reduce((a, f) => a + f[k], 0) / fs.length;
    return out;
  }

  /* The labeled axes (§7): each maps a structural feature to the two
     natural-language directions a draft can be nudged. `move(draft, target)`
     returns the phrase that moves the draft TOWARD the target, or '' if the
     gap on this axis is too small to mention. Kept to the handful that are
     both interpretable and actionable; sentence-length variance and ascii ride
     the audit's drift record but don't generate instructions (keeps the note
     to "up to two" clean directions, per §7). */
  const AXES = [
    {
      name: 'length',
      val: f => f.words,
      // relative gap, since "30 words too long" means different things at 20 vs 400 words
      gap: (d, t) => (d.words - t.words) / Math.max(40, t.words),
      min: 0.35,
      phrase: g => g > 0 ? 'more concise' : 'fuller and more developed',
    },
    {
      name: 'commitment',
      val: f => f.hedgeDensity,
      gap: (d, t) => d.hedgeDensity - t.hedgeDensity,
      min: 0.02,
      phrase: g => g > 0 ? 'more committed and direct, with less hedging' : 'a touch more measured',
    },
    {
      name: 'structure',
      val: f => f.lists,
      gap: (d, t) => d.lists - t.lists,
      min: 1,
      phrase: g => g > 0 ? 'written as flowing prose rather than a list' : 'broken into clear points',
    },
    {
      name: 'warmth',
      val: f => f.firstPersonDensity,
      gap: (d, t) => t.firstPersonDensity - d.firstPersonDensity,   // target warmer ⇒ positive ⇒ warm up
      min: 0.02,
      phrase: g => g > 0 ? 'warmer and more personal' : 'more neutral and less first-person',
    },
  ];

  // Decompose a draft's shape error against the target exemplars into the
  // axes that differ most, and translate the top two into a revision note.
  // This is the structured feedback that makes drafting a coarse gradient
  // descent in shape-space: the model is told to move along named dimensions,
  // never to vaguely "do better". The numeric drift rides the audit; the model
  // sees only the natural-language note (§4 — showing it its own score would
  // create a worse objective).
  function decomposeDrift(draftText, targetTexts) {
    const d = structuralFeatures(draftText);
    const t = avgFeatures(targetTexts || []);
    const drift = AXES.map(ax => {
      const g = ax.gap(d, t);
      return { axis: ax.name, gap: g, magnitude: Math.abs(g), over: g > 0, phrase: ax.phrase(g) };
    }).filter(x => x.magnitude >= AXES.find(a => a.name === x.axis).min)
      .sort((a, b) => b.magnitude - a.magnitude);
    return drift;
  }
  function revisionInstruction(draftText, targetTexts) {
    const drift = decomposeDrift(draftText, targetTexts);
    const top = drift.slice(0, 2);
    if (!top.length) return { drift, instruction: 'Keep the substance; just tighten the phrasing.' };
    const phrases = top.map(x => x.phrase);
    const joined = phrases.length === 1 ? phrases[0] : phrases[0] + ' and ' + phrases[1];
    return { drift, instruction: 'Make it ' + joined + '.' };
  }

  /* ---- PCA over embeddings (§7 proper) -----------------------------------
     Provided for when the library stabilizes and the axes can be hand-labeled
     against the real embedding space. Power iteration with deflation — no
     external dependency. Not on the v1 drafting path (structural features carry
     it), but exposed and tested so the §7 upgrade is a labeling step, not a
     build step. */
  function pca(vectors, k) {
    const rows = (vectors || []).filter(Boolean);
    if (rows.length < 2) return { mean: rows[0] ? Float32Array.from(rows[0]) : null, components: [], explained: [] };
    const d = rows[0].length;
    const mean = centroid(rows);
    const X = rows.map(r => { const v = new Float32Array(d); for (let i = 0; i < d; i++) v[i] = r[i] - mean[i]; return v; });
    const comps = [], explained = [];
    const want = Math.min(k || 6, d, rows.length - 1);
    for (let c = 0; c < want; c++) {
      let v = new Float32Array(d);
      for (let i = 0; i < d; i++) v[i] = Math.sin(i + 1 + c) || 1;   // deterministic seed
      let nv = norm(v); for (let i = 0; i < d; i++) v[i] /= nv;
      for (let iter = 0; iter < 64; iter++) {
        const nx = new Float32Array(d);
        for (const x of X) { const p = dot(x, v); for (let i = 0; i < d; i++) nx[i] += p * x[i]; }
        nv = norm(nx); if (!nv) break;
        for (let i = 0; i < d; i++) nx[i] /= nv;
        let delta = 0; for (let i = 0; i < d; i++) delta += Math.abs(nx[i] - v[i]);
        v = nx; if (delta < 1e-7) break;
      }
      // Rayleigh quotient ≈ eigenvalue (variance captured).
      let lam = 0; for (const x of X) { const p = dot(x, v); lam += p * p; }
      explained.push(lam / X.length);
      comps.push(v);
      for (const x of X) { const p = dot(x, v); for (let i = 0; i < d; i++) x[i] -= p * v[i]; }   // deflate
    }
    return { mean, components: comps, explained };
  }
  function projectError(errVec, components) {
    return (components || []).map(c => dot(errVec, c));
  }

  /* ---- the discriminative score (§5) -------------------------------------
     A raw cosine to the target is the wrong measure. What matters is whether a
     draft is UNAMBIGUOUSLY in the target basin — closer to the target than to
     any competing shape.
        s_t = similarity to the target exemplars (the selected ones)
        s_c = similarity to the nearest exemplar of a DIFFERENT intent
        score = s_t − s_c
     Positive ⇒ closer to the target shape than to any competitor; magnitude ⇒
     how confidently shaped. With no competitors loaded, s_c = 0 (nothing to be
     confused with). The model never sees this number (§4). */
  function maxSim(vec, exemplars) {
    let best = -Infinity, who = null;
    for (const ex of exemplars || []) {
      if (!ex || !ex.responseVec) continue;
      const s = cosine(vec, ex.responseVec);
      if (s > best) { best = s; who = ex; }
    }
    return who ? { sim: best, exemplar: who } : { sim: 0, exemplar: null };
  }
  function discriminativeScore(vec, targetShape) {
    if (!targetShape) return null;
    const t = maxSim(vec, targetShape.targetExemplars);
    const c = maxSim(vec, targetShape.competitorExemplars);
    const s_t = t.exemplar ? t.sim : 0;
    const s_c = c.exemplar ? c.sim : 0;
    return {
      score: s_t - s_c,
      s_t, s_c,
      target: t.exemplar ? t.exemplar.id : null,
      nearestCompetitor: c.exemplar ? c.exemplar.id : null,
    };
  }

  /* ---- the adaptive threshold (§5) ---------------------------------------
     Adaptive to local exemplar density. In a DENSE region (a competing shape
     sits close to the target) require a bigger margin — there's more to be
     ambiguous against. In a SPARSE region (the target cluster is isolated) a
     small margin is already decisive. The threshold scales UP with how close
     the nearest competitor sits to the target centroid. Returned as part of
     target_shape so the loop carries its own bar. */
  const THRESHOLD = { base: 0.02, k: 0.30, lo: 0.04, hi: 0.30 };
  function adaptiveThreshold(targetExemplars, competitorExemplars, opts) {
    const o = Object.assign({}, THRESHOLD, opts || {});
    const tc = centroid((targetExemplars || []).map(e => e.responseVec).filter(Boolean),
      (targetExemplars || []).map(e => e.weight));
    if (!tc) return o.lo;
    const near = maxSim(tc, competitorExemplars);     // how close the nearest competing shape sits
    const proximity = Math.max(0, near.exemplar ? near.sim : 0);
    return Math.max(o.lo, Math.min(o.hi, o.base + o.k * proximity));
  }

  /* ---- which axes most distinguish this cluster (§8 axes_to_emphasize) ----
     A hint for the FIRST draft. When the library declares poles (anchor_axes),
     use the cluster's OWN declared poles — the library knows what shape it's
     anchoring better than a structural guess ("pole:short", "pole:committed").
     Otherwise fall back to the structural axes on which the cluster departs
     most from the library as a whole ("lookup" comes out short + committal;
     "synthesis" longer + warmer), computed from data so it still tracks a
     library that ships no pole labels. */
  function axesToEmphasize(targetExemplars, allExemplars) {
    const poleCounts = {};
    for (const e of targetExemplars || [])
      for (const a of e.anchor_axes || []) {
        const p = String(a).replace(/^pole:/, '').trim();
        if (p) poleCounts[p] = (poleCounts[p] || 0) + 1;
      }
    const declared = Object.keys(poleCounts).sort((a, b) => poleCounts[b] - poleCounts[a]);
    if (declared.length) return declared.slice(0, 4);
    const t = avgFeatures((targetExemplars || []).map(e => e.response));
    const g = avgFeatures((allExemplars || []).map(e => e.response));
    const tags = [];
    if (g.words && (t.words - g.words) / g.words < -0.2) tags.push('short');
    if (g.words && (t.words - g.words) / g.words > 0.2) tags.push('developed');
    if (t.hedgeDensity < g.hedgeDensity - 0.01) tags.push('committal');
    if (t.hedgeDensity > g.hedgeDensity + 0.01) tags.push('measured');
    if (t.firstPersonDensity > g.firstPersonDensity + 0.01) tags.push('warm');
    if (t.lists > g.lists + 0.5) tags.push('structured');
    return tags;
  }

  /* ---- the exemplar library, embedded once ------------------------------
     Embeds each exemplar's RESPONSE one time at load and caches the vector on
     the record (responseVec). Embedding is injected (EOEmbed.embedSentences in
     the app, a fake in tests). If embedding is unavailable the library loads in
     a DEGRADED state: select() still returns intent clustering, but scoring
     returns null and the controller refuses — callers fall back to a single
     phrasing call, exactly as before (parity). */
  function createLibrary(exemplars, deps) {
    const lib = (exemplars || []).slice();
    const embed = deps && deps.embed;        // (texts:string[]) => Promise<vec[]|null>
    let embedded = false;

    async function load() {
      if (embedded || !embed || !lib.length) return self;
      try {
        const vecs = await embed(lib.map(e => e.response));
        if (vecs && vecs.length === lib.length) {
          for (let i = 0; i < lib.length; i++) lib[i].responseVec = vecs[i];
          embedded = true;
        }
      } catch (e) { /* degraded: no vectors, scoring disabled */ }
      return self;
    }

    function byIntent(intent) { return lib.filter(e => e.intent === intent); }
    function ready() { return embedded; }

    // Build the structured target_shape (§8) from the shape pass's output. The
    // shape pass (a small LLM call, in llm.js) supplies intent + a free-prose
    // note; HERE we attach the library physics: the nearest exemplars in the
    // intent cluster, the competitor set, the adaptive threshold, and the
    // first-draft axis hints. noteVec (the embedded shape note) ranks the
    // target cluster — §6 v1's "embed the shape-pass output against the
    // response space". Returns null if no exemplars match (caller falls back).
    function select(opts) {
      const o = opts || {};
      const intent = o.intent || null;
      let cluster = intent ? byIntent(intent) : lib.slice();
      if (!cluster.length) cluster = lib.slice();              // unknown intent ⇒ whole library
      if (!cluster.length) return null;
      const k = o.k || 5;
      // Rank by the shape note's embedding when we have it; else keep weight order.
      let ranked = cluster;
      if (o.noteVec && embedded) {
        ranked = cluster.map(e => ({ e, s: cosine(o.noteVec, e.responseVec) }))
          .sort((a, b) => b.s - a.s).map(x => x.e);
      } else {
        ranked = cluster.slice().sort((a, b) => (b.weight || 1) - (a.weight || 1));
      }
      const targetExemplars = ranked.slice(0, k);
      const competitorExemplars = intent ? lib.filter(e => e.intent !== intent) : [];
      return {
        intent,
        shape_note: o.shapeNote || '',
        target_exemplar_ids: targetExemplars.map(e => e.id),
        targetExemplars,
        competitorExemplars,
        threshold: adaptiveThreshold(targetExemplars, competitorExemplars),
        axes_to_emphasize: axesToEmphasize(targetExemplars, lib),
      };
    }

    function score(vec, targetShape) {
      if (!embedded || !targetShape) return null;
      return discriminativeScore(vec, targetShape);
    }

    const self = { load, ready, select, score, byIntent, exemplars: lib };
    return self;
  }

  /* ---- the drafting controller (§4) -------------------------------------
     The core mechanism — replaces a one-shot phrasing call with a short loop:

       for attempt in 1..maxDrafts:
         instruction = (attempt 1) base shape framing
                       (else)      revision note from the prior draft's drift
         draft = generate(instruction, prior)      # CONTENT is stable across
         score = discriminativeScore(embed(draft)) # drafts; only shape varies
         if score >= threshold:  land, exit
         if not improving:       stop (converged-and-failed)
       fall through → best draft so far, soft_fail

     generate() and embed() are injected. generate receives only natural
     language — instruction + the prior draft's text + its NL critique — never
     a numeric score (§4). The full sequence is returned as the audit trail
     (§11): every instruction, draft, score, and drift axis, plus whether the
     turn landed cleanly or soft-failed. Easy turns exit on draft 1. */
  async function runDraftingLoop(opts) {
    const o = opts || {};
    const generate = o.generate;                       // ({instruction, attempt, prior}) => Promise<string>
    const embed = o.embed;                             // (text) => Promise<vec|null>
    const target = o.targetShape;
    if (typeof generate !== 'function') throw new Error('runDraftingLoop: generate() is required');
    const maxDrafts = Math.max(1, o.maxDrafts || 4);
    const epsilon = o.epsilon != null ? o.epsilon : 0.01;
    const threshold = (target && target.threshold != null) ? target.threshold : (o.threshold != null ? o.threshold : 0.1);
    const targetTexts = (target && target.targetExemplars || []).map(e => e.response);
    const scoreOf = o.score || ((vec) => discriminativeScore(vec, target));

    const drafts = [];
    const baseInstruction = o.baseInstruction
      || ((target && target.shape_note) ? target.shape_note : '')
      || 'Answer in the shape this turn calls for.';

    let bestScore = -Infinity, stagnation = 0;

    for (let attempt = 1; attempt <= maxDrafts; attempt++) {
      const prev = drafts.length ? drafts[drafts.length - 1] : null;
      const revision = prev ? revisionInstruction(prev.response, targetTexts) : null;
      const instruction = attempt === 1 ? baseInstruction : revision.instruction;
      // The model sees the prior draft and its NL critique — never the score.
      const prior = prev ? { response: prev.response, critique: revision ? revision.instruction : '' } : null;

      const response = await generate({ instruction, attempt, prior });
      let vec = null, scored = null;
      if (typeof embed === 'function') { try { vec = await embed(response); } catch (e) { vec = null; } }
      if (vec) scored = scoreOf(vec);
      const drift = decomposeDrift(response, targetTexts);
      const s = scored && typeof scored.score === 'number' ? scored.score : null;

      drafts.push({
        attempt, instruction, response,
        score: s, s_t: scored ? scored.s_t : null, s_c: scored ? scored.s_c : null,
        nearestCompetitor: scored ? scored.nearestCompetitor : null,
        drift: drift.map(x => ({ axis: x.axis, over: x.over, magnitude: round(x.magnitude) })),
      });

      // No score available (degraded library): one draft, return it honestly.
      if (s == null) return finalize(drafts, target, threshold, { landed: false, soft_fail: false, reason: 'unscored' });

      if (s >= threshold) return finalize(drafts, target, threshold, { landed: true, soft_fail: false });

      // Convergence: the best score hasn't improved by ≥ epsilon for two
      // straight attempts → stop spending drafts (§10).
      if (s > bestScore + epsilon) { bestScore = s; stagnation = 0; }
      else { stagnation++; if (stagnation >= 2) return finalize(drafts, target, threshold, { landed: false, soft_fail: true, reason: 'converged' }); }
    }
    // Budget exhausted without landing (§10).
    return finalize(drafts, target, threshold, { landed: false, soft_fail: true, reason: 'budget' });
  }

  function round(x) { return Math.round(x * 1000) / 1000; }
  function bestOf(drafts) {
    return drafts.reduce((best, d) => (d.score != null && (best == null || d.score > best.score) ? d : best), null) || drafts[drafts.length - 1];
  }
  function finalize(drafts, target, threshold, outcome) {
    const chosen = outcome.landed ? drafts[drafts.length - 1] : bestOf(drafts);
    return {
      response: chosen ? chosen.response : '',
      landed: !!outcome.landed,
      soft_fail: !!outcome.soft_fail,
      reason: outcome.reason || (outcome.landed ? 'landed' : 'soft_fail'),
      attempts: drafts.length,
      finalScore: chosen ? chosen.score : null,
      threshold,
      // The audit trail (§11): structured drift axes (not just scores), the
      // target exemplar IDs (not just embeddings), and landed-vs-soft-fail —
      // the substrate the Hebbian update loop will need later, logged now.
      audit: {
        intent: target ? target.intent : null,
        shape_note: target ? target.shape_note : '',
        target_exemplar_ids: target ? target.target_exemplar_ids : [],
        axes_to_emphasize: target ? target.axes_to_emphasize : [],
        threshold,
        landed: !!outcome.landed,
        soft_fail: !!outcome.soft_fail,
        drafts: drafts.map(d => ({ attempt: d.attempt, instruction: d.instruction, score: d.score, drift: d.drift, response: d.response })),
      },
    };
  }

  // Convenience: parse + build + embed a library in one call (the app's path).
  async function load(jsonlText, embed) {
    const lib = createLibrary(parseExemplars(jsonlText), { embed });
    await lib.load();
    return lib;
  }

  window.EOShape = {
    // vector math
    dot, cosine, centroid,
    // library
    parseExemplars, createLibrary, load,
    // features / axes
    structuralFeatures, avgFeatures, decomposeDrift, revisionInstruction, AXES,
    pca, projectError,
    // scoring
    discriminativeScore, adaptiveThreshold, axesToEmphasize, THRESHOLD,
    // the loop
    runDraftingLoop, bestOf,
  };
})();
