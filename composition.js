/* ============================================================
   Cleo — the composition layer (long-form, grounded documents).

   This is the turn-scale loop lifted to the scale of a composition. A
   composition Doc is NOT a generator with a longer context window; it is a
   small model held inside the same loop the rest of the engine runs — one
   component that only phrases, inside a machine that grounds, stamps, and
   revises mechanically.

   THE ARCHITECTURE, restated as code:
     • Everything is a log event. The document the user sees is a FOLD of the
       log. State is never stored; it is derived by replay. Editing the
       document is appending events. Undo is supersession by REC. This is the
       same rule as the turn-scale Given-Log, at composition scale.
     • Every confidence is a VECTOR with named components (witness, form,
       coherence, retrieval, temporal, frame). No scalar collapse. A component
       that was not measured is null — never zero.
     • Every gate is a PREDICATE over that vector. The monitor reads a Stamp
       and emits a Route naming the predicate that fired.
     • Form is GRADED against a learned prototype (a genre centroid), never
       handed to the talker as a spec. The plan is DIRECTION, revisable to the
       end. Standing is DERIVED, not stored (the coherence component; null
       until the standing operator ships — phase three).

   Pure and dependency-injected: generation (EOLLM.phrase), embedding
   (EOEmbed), retrieval (EOEngine.retrieve) and the form library (EOShape) are
   passed IN, never imported — so the whole layer is exercised in Node with
   fakes (tests/composition.test.js) and no WebGPU. Published as
   window.EOComposition. With no composition Doc open, the engine behaves
   identically to today: this file mints nothing on its own.
   ============================================================ */
(function () {
  'use strict';
  const SCHEMA = 'cleo-composition/1';

  // ---- ids -----------------------------------------------------------------
  // Monotonic per-load counter, salted so two folds in one session never
  // collide. Event ids are content-free handles, like the engine's span hashes.
  let _seq = 0;
  const _salt = Math.random().toString(36).slice(2, 6);
  function newId(prefix) { return (prefix || 'ev') + '-' + _salt + '-' + (++_seq).toString(36); }
  // Re-seat the counter past the highest id already in a log, so a restored Doc
  // never re-mints an id that the log already holds.
  function reseat(events) {
    for (const e of (events || [])) {
      for (const v of [e && e.id, e && e.target]) {
        const m = /-([0-9a-z]+)$/.exec(String(v || ''));
        if (m) { const n = parseInt(m[1], 36); if (Number.isFinite(n)) _seq = Math.max(_seq, n); }
      }
    }
  }

  const now = () => Date.now();

  // ============================================================ Confidence
  // The v3 confidence vector. Components are named by what they MEAN; each is a
  // degree in [0,1] or null (not measured). No scalar collapse: a Confidence is
  // never reduced to one number except for the single colour projection in the
  // UI, and there the predicate that produced it travels alongside.
  const COMPONENTS = ['witness', 'form', 'coherence', 'retrieval', 'temporal', 'frame'];
  function clamp01(x) { return x == null ? null : (x < 0 ? 0 : (x > 1 ? 1 : x)); }
  function confidence(partial) {
    const c = {};
    for (const k of COMPONENTS) c[k] = (partial && partial[k] != null) ? clamp01(+partial[k]) : null;
    return c;
  }
  // A component is "blocking-low" only when it was actually measured AND falls
  // below its floor. A null (un-measured) component never condemns a unit — the
  // asymptotic-truthfulness rule: we do not assert what we did not measure.
  function low(v, floor) { return v != null && v < floor; }
  function high(v, floor) { return v == null || v >= floor; }  // null reads as "not below"

  // ============================================================ event makers
  // Each maker stamps op + kind + id + ts and returns a plain, JSON-cloneable
  // object — the same shape the ingestion log uses (INS/DEF/SIG/NUL/SEG/EVA/REC).
  function ev(op, kind, fields) {
    return Object.assign({ op, kind, id: newId(kind), ts: now() }, fields || {});
  }
  const make = {
    doc: (f) => Object.assign({ kind: 'doc', id: f.id || newId('doc'), created_at: now(), ts: now() }, f),
    frame: (f) => ev('DEF', 'frame', Object.assign({ revisable: true }, f)),
    // A unit DEF carries ONLY the fields the caller sets (plus revisable): a
    // re-DEF of the same id is a plan edit (rewrite-job / reorder / reparent /
    // set-grain / contest), and the fold merges it latest-wins — so it must not
    // inject order/parent/state defaults that would silently reset the unit it
    // is editing. Creation (addUnit / planFromFrame) supplies its own order.
    unit: (f) => ev('DEF', 'unit', Object.assign({ revisable: true }, f)),
    draft: (f) => ev('INS', 'draft', Object.assign({ revisable: true, source_events: [] }, f)),
    stamp: (f) => ev('EVA', 'stamp', Object.assign({ revisable: true }, f)),
    hole: (f) => ev('NUL', 'hole', Object.assign({}, f)),
    route: (f) => ev('DEF', 'route', Object.assign({ revisable: true }, f)),
    planEdit: (f) => ev('REC', 'plan-edit-by-draft', Object.assign({ revisable: true }, f)),
    // a structural plan edit that is NOT draft-driven (user dragged/cut/split)
    edit: (f) => ev('REC', 'plan-edit', Object.assign({ revisable: true }, f)),
    hold: (f) => ev('DEF', 'hold', Object.assign({ revisable: true }, f)),
    // generic supersession — the undo primitive. Drops `target` from the fold.
    supersede: (targetId, why) => ev('REC', 'supersede', { target: targetId, reason: why || 'undo' }),
  };

  // ============================================================ the fold
  // Replay the log into the document the user sees. Nothing here is stored on
  // the Doc; call it again and you get the same projection. Mirrors the
  // engine's projectGraph: events in, derived state out.
  //
  // Resolution order:
  //   1. supersession — a live REC/supersede drops its target; a supersede can
  //      itself be superseded (redo), so we settle the active set to a fixpoint.
  //   2. doc + frame — latest live event of each wins (frame is revisable).
  //   3. units — DEF 'unit' events keyed by id, latest-wins merge; ids named in
  //      a live cut/drop plan-edit are removed. Tree from parent_id + order.
  //   4. drafts — latest live INS 'draft' per unit is the live draft.
  //   5. stamps — latest live EVA 'stamp' per draft is the live stamp.
  //   6. holes / routes / holds — latest live per unit.
  //   7. unit STATE — folded: held > contested > drafted(+route) > owed.
  function fold(events) {
    const log = Array.isArray(events) ? events : [];

    // (1) settle supersession to a fixpoint. A supersede is "active" only if it
    // is not itself the target of another active supersede.
    const supersedes = log.filter(e => e && e.op === 'REC' && e.kind === 'supersede' && e.target);
    let dropped = new Set();
    for (let pass = 0; pass < 8; pass++) {
      const next = new Set();
      for (const s of supersedes) if (!dropped.has(s.id)) next.add(s.target);
      let changed = next.size !== dropped.size;
      if (!changed) for (const t of next) if (!dropped.has(t)) { changed = true; break; }
      dropped = next;
      if (!changed) break;
    }
    const live = log.filter(e => e && !dropped.has(e.id) && !(e.op === 'REC' && e.kind === 'supersede'));

    // (2) doc + frame
    let doc = null, frame = null;
    for (const e of live) {
      if (e.kind === 'doc') doc = e;
      else if (e.kind === 'frame') frame = e;     // latest live frame wins (revision supersedes posture)
    }

    // (3) units
    const cut = new Set();
    for (const e of live) {
      if ((e.kind === 'plan-edit' || e.kind === 'plan-edit-by-draft') &&
          (e.edit_kind === 'cut' || e.edit_kind === 'drop-unit'))
        for (const id of (e.affected_unit_ids || [])) cut.add(id);
    }
    const unitById = new Map();
    for (const e of live) {
      if (e.kind !== 'unit') continue;
      const prev = unitById.get(e.id) || {};
      // latest-wins field merge (a re-DEF of the same id is a plan edit:
      // rewrite-job, reorder, reparent). Keep the original ts as created_at.
      unitById.set(e.id, Object.assign({}, prev, e, { created_at: prev.created_at || e.ts }));
    }
    for (const id of cut) unitById.delete(id);

    // (4) drafts — keyed by unit, latest live wins
    const draftByUnit = new Map();
    const draftById = new Map();
    for (const e of live) {
      if (e.kind !== 'draft') continue;
      draftById.set(e.id, e);
      const cur = draftByUnit.get(e.unit_id);
      if (!cur || e.ts >= cur.ts) draftByUnit.set(e.unit_id, e);
    }

    // (5) stamps — keyed by draft, latest live wins
    const stampByDraft = new Map();
    for (const e of live) {
      if (e.kind !== 'stamp') continue;
      const cur = stampByDraft.get(e.draft_id);
      if (!cur || e.ts >= cur.ts) stampByDraft.set(e.draft_id, e);
    }

    // (6) holes / routes / holds per unit (latest live wins)
    const holeByUnit = new Map(), routeByUnit = new Map(), heldUnits = new Set();
    for (const e of live) {
      if (e.kind === 'hole') { const c = holeByUnit.get(e.unit_id); if (!c || e.ts >= c.ts) holeByUnit.set(e.unit_id, e); }
      else if (e.kind === 'route') { const c = routeByUnit.get(e.unit_id); if (!c || e.ts >= c.ts) routeByUnit.set(e.unit_id, e); }
      else if (e.kind === 'hold') { if (e.held === false) heldUnits.delete(e.unit_id); else heldUnits.add(e.unit_id); }
    }

    // assemble each unit with its live draft, stamp, route, hole, and folded state
    const units = [];
    for (const u of unitById.values()) {
      const draft = draftByUnit.get(u.id) || null;
      const stamp = draft ? (stampByDraft.get(draft.id) || null) : null;
      const route = routeByUnit.get(u.id) || null;
      const hole = holeByUnit.get(u.id) || null;
      let state;
      if (heldUnits.has(u.id)) state = 'held';
      else if (route && route.decision === 'restructure') state = 'contested';
      else if (u.contested) state = 'contested';
      else if (draft) state = 'drafted';
      else state = 'owed';
      units.push(Object.assign({}, u, {
        state,
        draft, stamp, route, hole,
        confidence: stamp ? stamp.confidence : (draft ? draft.confidence : null),
        // band is the colour projection (the one place a scalar appears); the
        // route's predicate travels with it for the hover.
        band: bandFor(state, route),
      }));
    }
    // tree order: by parent then by `order` (missing order reads as 0), stable
    units.sort((a, b) => ((a.order || 0) - (b.order || 0)) || (a.created_at - b.created_at));
    const tree = buildTree(units);

    // plan-edit-by-draft annotations, newest first (the reasons the plan moved)
    const planEdits = live.filter(e => e.kind === 'plan-edit-by-draft')
      .sort((a, b) => b.ts - a.ts);

    return {
      schema: SCHEMA, doc, frame,
      units, tree,
      unitsById: Object.fromEntries(units.map(u => [u.id, u])),
      planEdits,
      // counts the UI leans on
      counts: {
        units: units.length,
        owed: units.filter(u => u.state === 'owed').length,
        drafted: units.filter(u => u.state === 'drafted').length,
        held: units.filter(u => u.state === 'held').length,
        contested: units.filter(u => u.state === 'contested').length,
        holes: units.filter(u => u.hole).length,
      },
      dropped: [...dropped],
      _live: live,
    };
  }

  function buildTree(units) {
    const byId = new Map(units.map(u => [u.id, Object.assign({ children: [] }, u)]));
    const roots = [];
    for (const u of byId.values()) {
      if (u.parent_id && byId.has(u.parent_id)) byId.get(u.parent_id).children.push(u);
      else roots.push(u);
    }
    const sortRec = (list) => { list.sort((a, b) => ((a.order || 0) - (b.order || 0)) || (a.created_at - b.created_at)); for (const n of list) sortRec(n.children); };
    sortRec(roots);
    return roots;
  }

  // The colour band — owed | advance | revise | fetch | contested | held — the
  // single scalar projection. The predicate that produced it is on the route.
  function bandFor(state, route) {
    if (state === 'held') return 'held';
    if (state === 'contested') return 'contested';
    if (state === 'owed') return 'owed';
    if (route && ['advance', 'revise', 'fetch', 'restructure'].includes(route.decision))
      return route.decision === 'restructure' ? 'contested' : route.decision;
    return 'drafted';
  }

  // ============================================================ the witness
  // The v3 grain-relative witness, measured on the talker's OWN settled prose
  // against the spans it was given. Figure as citation coverage, Ground as
  // honest-absence-if-warranted, Pattern as corroboration count — with a
  // grain-mismatch flag when the prose is the wrong shape for the grain it owes.
  // Pure: prose + spans + grain in, {degree, tag, detail} out. No model, no
  // engine — string overlap only — so it runs in Node with no embedder.
  const STOP = new Set(('a an the and or but if then else for of to in on at by with from into over under is are was were be been '
    + 'being am do does did doing have has had having will would shall should can could may might must not no nor so than too very '
    + 'just only also this that these those it its he she they them his her their there here who whom which what when where why how '
    + 'as up out off down about above below into onto upon i we you us me my your our said say says a.m p.m').split(/\s+/));
  // The natural-language absence set — a Ground claim's own typography. A small
  // inline pack here (like audit.js's WITNESS_STOP); the substrate-spec's pull
  // is to lift it into a tagged pack, deferred until the standing operator.
  const ABSENCE_RE = /\b(no|not|never|without|absent|absence|silent on|fails? to|does not|do not|doesn'?t|don'?t|did not|didn'?t|cannot|can'?t|n'?t|none|nothing|nowhere|lacks?|missing|unestablished|not establish(?:ed)?|not mentioned|not recorded)\b/i;
  function contentTokens(text) {
    return (String(text == null ? '' : text).toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || [])
      .map(w => w.replace(/['’]s$/, '')).filter(w => w.length > 2 && !STOP.has(w));
  }
  function splitSentences(text) {
    return String(text == null ? '' : text).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  }
  const BIND_FLOOR = 0.4;       // a sentence binds when this fraction of its content is in a span
  const PATTERN_TARGET = 2;     // a pattern needs this many corroborating spans

  function witnessGrain(opts) {
    const o = opts || {};
    const grain = o.grain || 'Figure';
    const prose = String(o.prose || '');
    const spans = (o.spans || []).map(s => (typeof s === 'string' ? s : (s && (s.text || s.t)) || ''));
    const spanTokenSets = spans.map(s => new Set(contentTokens(s)));
    const sentences = splitSentences(prose);

    if (!sentences.length) return { degree: null, tag: 'empty', detail: { sentences: 0 } };

    // per-sentence binding: how much of each sentence's content sits in a span,
    // and across how many distinct spans (the corroboration count).
    const per = sentences.map(sent => {
      const toks = contentTokens(sent);
      if (!toks.length) return { toks: 0, covered: 0, spans: 0, absence: ABSENCE_RE.test(sent) };
      let bestCovered = 0, corroborating = 0;
      for (const set of spanTokenSets) {
        let c = 0; for (const t of toks) if (set.has(t)) c++;
        if (c > 0) corroborating++;
        if (c > bestCovered) bestCovered = c;
      }
      return { toks: toks.length, covered: bestCovered, spans: corroborating, absence: ABSENCE_RE.test(sent) };
    });

    const totalToks = per.reduce((a, p) => a + p.toks, 0) || 1;

    if (grain === 'Ground') {
      // Honest absence: the unit OWES a context/absence. A sentence that asserts
      // an absence is witnessed when no span carries the thing it denies (the
      // page is genuinely silent); a positive claim under a Ground grain is the
      // wrong shape (grain-mismatch).
      const absent = per.filter(p => p.absence);
      const positive = per.filter(p => !p.absence && p.toks > 0);
      if (!absent.length) return { degree: clamp01(coverage(per, totalToks)), tag: 'grain-mismatch', detail: { reason: 'Ground grain, but the draft asserts no absence' } };
      // warranted when the absence sentences find little in the spans (silence)
      const leak = absent.reduce((a, p) => a + p.covered, 0);
      const warranted = leak === 0;
      const deg = warranted ? 0.9 : Math.max(0, 0.9 - leak / totalToks);
      // a mostly-positive draft that happens to contain one "not" is not really Ground
      const tag = !warranted ? 'confabulation' : (positive.length > absent.length ? 'grain-mismatch' : 'honest-absence');
      return { degree: clamp01(deg), tag, detail: { absentSentences: absent.length, leak } };
    }

    if (grain === 'Pattern') {
      // Corroboration count: a claim is a pattern only with ≥ PATTERN_TARGET
      // instances. One instance is real but partial.
      const maxCorrob = per.reduce((a, p) => Math.max(a, p.spans), 0);
      const covered = per.reduce((a, p) => a + p.covered, 0);
      const deg = clamp01((covered / totalToks) * Math.min(1, maxCorrob / PATTERN_TARGET));
      let tag;
      if (maxCorrob >= PATTERN_TARGET) tag = 'pattern-grounded';
      else if (maxCorrob === 1) tag = 'pattern-partial';
      else tag = 'confabulation';
      return { degree: deg, tag, detail: { corroboration: maxCorrob, target: PATTERN_TARGET } };
    }

    // Figure (default): citation coverage. Witnessed content = covered tokens of
    // sentences that bind; an unbound content sentence witnesses none of itself.
    let wit = 0, denom = 0, bound = 0, claims = 0;
    for (const p of per) {
      if (!p.toks) continue;
      denom += p.toks;
      claims++;
      const frac = p.covered / p.toks;
      if (frac >= BIND_FLOOR) { wit += p.covered; bound++; }
    }
    const deg = denom ? clamp01(wit / denom) : null;
    let tag;
    if (!spans.length) tag = claims ? 'confabulation' : 'empty';
    else if (deg != null && deg >= BIND_FLOOR && bound) tag = 'figure-grounded';
    else if (per.some(p => p.absence) && bound === 0) tag = 'grain-mismatch';   // really a Ground claim
    else tag = 'confabulation';
    return { degree: deg, tag, detail: { boundSentences: bound, claims } };
  }
  function coverage(per, total) { return per.reduce((a, p) => a + p.covered, 0) / (total || 1); }

  // ============================================================ the stamp
  // Compute the Confidence vector for a draft. witness from the grain measure;
  // form from the genre centroid (null when the form library is degraded/empty,
  // never zero — the honest "not measured"); retrieval rides through from the
  // retrieval step; frame from the job↔goal alignment when an embedding is
  // available; coherence/temporal null until phases three / later wire them.
  function stampDraft(opts) {
    const o = opts || {};
    const w = witnessGrain({ prose: o.prose, spans: o.spans, grain: o.grain });
    let form = null;
    if (o.formLib && o.draftVec != null && o.genre) {
      try { form = o.formLib.formDegree(o.genre, o.draftVec); } catch (e) { form = null; }
    } else if (typeof o.form === 'number') form = clamp01(o.form);
    const conf = confidence({
      witness: w.degree,
      form,
      coherence: o.coherence != null ? o.coherence : null,
      retrieval: o.retrieval != null ? o.retrieval : null,
      temporal: o.temporal != null ? o.temporal : null,
      frame: o.frame != null ? o.frame : null,
    });
    return { confidence: conf, tag: w.tag, witness_detail: w.detail };
  }

  // ============================================================ the monitor
  // Predicates over the Confidence vector → a Route. Every decision names the
  // gate that fired, in v3 vocabulary, so it is auditable. A null component
  // never blocks (high() reads null as "not below"); a component only condemns
  // when it was measured and fell short. Floors per the spec.
  const FLOOR = { witness: 0.4, form: 0.5, coherence: 0.4, retrieval: 0.5 };
  function decide(conf, ctx) {
    const c = conf || {};
    const o = ctx || {};
    const W = c.witness, F = c.form, CO = c.coherence, R = c.retrieval;
    let decision, predicate;

    // Persistent low coherence across a branch → the plan itself is the problem.
    if (o.persistentLowCoherence) {
      decision = 'restructure'; predicate = 'coherence < 0.4 across multiple units';
    }
    // witness fine, form fine, coherence fine (or null) → hold and move on
    else if (high(W, FLOOR.witness) && W != null && high(F, FLOOR.form) && high(CO, FLOOR.coherence)) {
      decision = 'advance';
      predicate = 'witness >= 0.4 AND form >= 0.5 AND (coherence null OR >= 0.5)';
    }
    // witness low but the retriever found material → the talker didn't use it
    else if (low(W, FLOOR.witness) && high(R, FLOOR.retrieval) && R != null) {
      decision = 'revise'; predicate = 'witness < 0.4 AND retrieval >= 0.5';
    }
    // witness low and retrieval thin → reach out for more material
    else if (low(W, FLOOR.witness) && low(R, FLOOR.retrieval)) {
      decision = 'fetch'; predicate = 'witness < 0.4 AND retrieval < 0.5';
    }
    // shape off but grounding fine → redraft with the same material
    else if (low(F, FLOOR.form) && high(W, FLOOR.witness) && W != null) {
      decision = 'revise'; predicate = 'form < 0.5 AND witness >= 0.4';
    }
    // coherence low while the rest is fine → fit the unit to the doc, or (if the
    // unit is isolated-right) the doc to the unit
    else if (low(CO, FLOOR.coherence) && high(W, FLOOR.witness) && high(F, FLOOR.form)) {
      decision = o.isolated ? 'restructure' : 'revise';
      predicate = 'coherence < 0.4 AND others fine';
    }
    // witness unmeasured (no draft yet, or no spans) → fetch is the safe owe
    else if (W == null) {
      decision = 'fetch'; predicate = 'witness null (nothing measured yet)';
    }
    else { decision = 'revise'; predicate = 'no advance gate met'; }

    return { decision, predicate, triggered_by: confidence(c) };
  }

  // ============================================================ the talker
  // generateUnit: retrieve material against the unit's job, phrase it through
  // the membrane, stamp it, and route it — returning the events to append. The
  // talker never receives the whole document, the genre prototype as words, or
  // any operator vocabulary. It phrases the chunk. That is its job.
  //
  // deps (all injected; absent ones degrade, never throw):
  //   retrieve(job)          -> [{text, score, docId, idx}]  (EOEngine-backed)
  //   phrase({system,user,max_tokens}) -> string             (EOLLM-backed)
  //   embed(text)            -> vec | null                   (EOEmbed-backed)
  //   formLib                -> window.EOShape library (formDegree)
  //   frame                  -> the live frame event (thesis/reader/goal/genre)
  //   neighbors              -> [{job, prose}] thin slice for seam coherence
  async function generateUnit(deps) {
    const d = deps || {};
    const unit = d.unit || {};
    const frame = d.frame || {};
    const job = String(unit.job || '');

    // 1. retrieve against the job
    let spans = [];
    try { if (d.retrieve) spans = (await d.retrieve(job)) || []; } catch (e) { spans = []; }
    spans = spans.slice(0, d.maxSpans || 8).map(s => ({
      text: (typeof s === 'string') ? s : (s.text || s.t || ''),
      score: (s && typeof s.score === 'number') ? s.score : null,
      docId: s && s.docId, idx: s && (s.idx != null ? s.idx : s.i),
    })).filter(s => s.text);

    // 2. phrase the chunk through the membrane (job + spans + frame text only)
    const prompt = buildTalkerPrompt({ job, frame, spans, neighbors: d.neighbors || [] });
    let prose = '';
    try {
      if (d.phrase) prose = String((await d.phrase({ system: prompt.system, user: prompt.user, max_tokens: d.maxTokens || 320 })) || '');
    } catch (e) { prose = ''; }
    prose = prose.trim();

    // 3. stamp — witness (grain-relative), form (genre centroid), retrieval
    let draftVec = null;
    try { if (d.embed && prose) draftVec = await d.embed(prose); } catch (e) { draftVec = null; }
    const grain = (unit.hole && unit.hole.owed_grain) || unit.owed_grain || 'Figure';
    const retrieval = retrievalDegree(spans);
    let frameDeg = null;
    if (d.embed && frame && frame.goal) {
      try {
        const gv = await d.embed(String(frame.goal || frame.thesis_or_question || ''));
        const jv = await d.embed(job);
        if (gv && jv) frameDeg = cosineSafe(gv, jv);
      } catch (e) { frameDeg = null; }
    }
    const st = stampDraft({
      prose, spans, grain,
      draftVec, genre: frame.genre, formLib: d.formLib,
      retrieval, frame: frameDeg,
    });

    // 4. emit the events: a Draft, its Stamp, and the monitor's Route. The
    // talker authored every sentence here, so the provenance is uniformly
    // 'talker' — a later user edit re-attributes the sentences it changes.
    const draft = make.draft({
      unit_id: unit.id, prose,
      author: 'talker',
      provenance: splitSentences(prose).map(t => ({ text: t, author: 'talker' })),
      source_events: spans.map(s => ({ docId: s.docId, idx: s.idx })).filter(s => s.docId != null),
      confidence: st.confidence, doc_id: d.doc_id,
    });
    const stamp = make.stamp({
      draft_id: draft.id, unit_id: unit.id,
      confidence: st.confidence, tag: st.tag, doc_id: d.doc_id,
    });
    const r = decide(st.confidence, {});
    const route = make.route({
      unit_id: unit.id, decision: r.decision, predicate: r.predicate,
      triggered_by: r.triggered_by, doc_id: d.doc_id,
    });
    return { draft, stamp, route, prose, spans, confidence: st.confidence, tag: st.tag };
  }

  // The talker's prompt. Spans first as factual material to use; the job and the
  // frame last as closing guidance about WHAT this chunk is for — never the
  // whole doc, never the genre prototype unfolded into words, never an operator.
  function buildTalkerPrompt(o) {
    const spans = o.spans || [];
    const frame = o.frame || {};
    const lines = [];
    lines.push('You are writing ONE passage of a longer document. Write only this passage — flowing prose, no headings, no list unless the material demands it. Use the material below; do not invent facts it does not contain. If the material does not establish something the passage needs, say so plainly rather than guessing.');
    const system = lines.join('\n');

    const u = [];
    if (spans.length) {
      u.push('Material (verbatim, to use and stay within):');
      spans.forEach((s, i) => u.push('[' + (i + 1) + '] ' + s.text));
      u.push('');
    }
    if (o.neighbors && o.neighbors.length) {
      u.push('The passage just before / after (for a smooth seam — do not repeat them):');
      for (const n of o.neighbors) if (n && n.prose) u.push('… ' + String(n.prose).slice(-240));
      u.push('');
    }
    if (frame.thesis_or_question) u.push('The document overall: ' + frame.thesis_or_question);
    if (frame.reader) u.push('Written for: ' + frame.reader);
    u.push('');
    u.push('Write this passage: ' + (o.job || ''));
    return { system, user: u.join('\n') };
  }

  // retrieval degree: did the retriever find usable material? The top score,
  // softened so a single strong hit reads as "found things". Null when no scores.
  function retrievalDegree(spans) {
    const scored = (spans || []).map(s => s && s.score).filter(x => typeof x === 'number');
    if (!scored.length) return spans && spans.length ? 0.5 : 0;  // hits with no score read as "found something"
    const top = Math.max.apply(null, scored);
    // scores are unbounded relevance; map to [0,1] generously (found-anything floor)
    return clamp01(top >= 1 ? Math.min(1, 0.5 + top / 10) : top);
  }
  function cosineSafe(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return null;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const den = Math.sqrt(na) * Math.sqrt(nb);
    return den ? clamp01(dot / den) : null;
  }

  // ============================================================ doc helpers
  // Spin up a fresh composition Doc: the doc event + its frame, returned as the
  // opening log. The UI appends these to doc._events and folds.
  function newDoc(opts) {
    const o = opts || {};
    const docId = o.id || newId('comp');
    const doc = make.doc({ id: docId, doc_id: docId });
    const frame = make.frame({
      doc_id: docId,
      thesis_or_question: o.thesis_or_question || '',
      reader: o.reader || '',
      goal: o.goal || '',
      constraints: o.constraints || [],
      genre: o.genre || 'plain-report',
    });
    doc.frame_id = frame.id;
    return [doc, frame];
  }

  // The assembled prose, in tree order — the draft pane's straight-through read,
  // and the input to a full reread / doc-level stamp (phase five).
  function assemble(folded) {
    const out = [];
    const walk = (nodes) => { for (const n of nodes) { const dr = n.draft; if (dr && dr.prose) out.push(dr.prose); walk(n.children || []); } };
    walk((folded && folded.tree) || []);
    return out.join('\n\n');
  }

  // ============================================================ provenance
  // Authorship is tracked per SENTENCE, derived by diff — NOT token by token,
  // and never per keystroke. When a user edits a unit's prose, each sentence
  // that survives (normalized) from the prior draft keeps its prior author; a
  // sentence that is new or changed is attributed to the editor. So a talker
  // draft the user lightly edits ends up mostly 'talker' with the touched
  // sentences 'user' — the CHANGES are what carry a new author, at a sane grain.
  function normSent(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function diffProvenance(prevProse, prevProv, newProse, author) {
    const prevSents = splitSentences(prevProse || '');
    const newSents = splitSentences(newProse || '');
    const priorAuthor = new Map();
    for (let k = 0; k < prevSents.length; k++) {
      const a = (prevProv && prevProv[k] && prevProv[k].author) || 'talker';
      const key = normSent(prevSents[k]);
      if (!priorAuthor.has(key)) priorAuthor.set(key, a);   // first occurrence wins
    }
    return newSents.map(s => {
      const carried = priorAuthor.get(normSent(s));
      return { text: s, author: carried || (author || 'user') };
    });
  }
  // A count of who wrote the live document, sentence by sentence — the
  // surface-level "you wrote N of M" the canvas shows. Derived, never stored.
  function authorship(folded) {
    let user = 0, talker = 0, total = 0;
    const walk = (nodes) => { for (const n of nodes) {
      const dr = n.draft; if (dr && dr.prose) {
        const sents = splitSentences(dr.prose);
        const prov = (dr.provenance && dr.provenance.length === sents.length) ? dr.provenance : null;
        for (let k = 0; k < sents.length; k++) {
          const a = prov ? prov[k].author : (dr.author || 'talker');
          total++; if (a === 'user') user++; else talker++;
        }
      }
      walk(n.children || []);
    } };
    walk((folded && folded.tree) || []);
    return { user, talker, total };
  }

  // ============================================================ the projection
  // Make the composition QUERYABLE: project the fold into a prose-doc-shaped
  // object (id / kind:'prose' / sentences / sentenceTexts / blocks) the engine's
  // retrieveScope can read directly — so the chat model can query the document
  // "at significance level" the same way it reads any source. Each sentence
  // carries its authorship + owning unit in `_provenance`, so who wrote what
  // stays traceable in the audit/UI — but the talker only ever sees the text:
  // the spans handed to the model are plain sentences, no author labels, the
  // membrane discipline intact. Carries no _events, so the graph/working-memory
  // path that keys on the composition log never runs over a projection.
  function project(doc) { return projectFold(fold((doc && doc._events) || []), doc); }
  function projectFold(folded, doc) {
    const docId = (doc && doc.id) || (folded.doc && folded.doc.id) || 'comp';
    const sentences = [], provenance = [], blocks = [];
    let i = 0;
    const walk = (nodes) => { for (const n of nodes) {
      const dr = n.draft;
      if (dr && dr.prose) {
        const sents = splitSentences(dr.prose);
        const prov = (dr.provenance && dr.provenance.length === sents.length) ? dr.provenance : null;
        const blk = [];
        for (let k = 0; k < sents.length; k++) {
          sentences.push({ i, t: sents[k] });
          provenance.push({ i, author: prov ? prov[k].author : (dr.author || 'talker'), unit_id: n.id });
          blk.push({ i, t: sents[k] });
          i++;
        }
        if (blk.length) blocks.push({ type: 'p', sentences: blk });
      }
      walk(n.children || []);
    } };
    walk(folded.tree || []);
    const name = (doc && doc.name) || (folded.frame && folded.frame.thesis_or_question) || 'composition';
    return {
      id: docId, name, kind: 'prose',
      sentences, sentenceTexts: sentences.map(s => s.t), blocks,
      // an EMPTY event log: the projection flows through every graph/working-memory
      // path (projectGraph([]) yields nothing), so the composition's REAL event
      // log is never graph-projected — only its prose is retrievable.
      _events: [],
      _projection: true, _provenance: provenance, _empty: sentences.length === 0,
    };
  }

  window.EOComposition = {
    SCHEMA, COMPONENTS, FLOOR, BIND_FLOOR, PATTERN_TARGET,
    newId, reseat,
    confidence, low, high, clamp01,
    make, ev,
    fold, buildTree, bandFor,
    witnessGrain, stampDraft, decide,
    generateUnit, buildTalkerPrompt, retrievalDegree,
    newDoc, assemble,
    diffProvenance, authorship, project, projectFold,
    contentTokens, splitSentences, cosineSafe,
  };
})();
