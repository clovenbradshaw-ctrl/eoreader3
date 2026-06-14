/* ============================================================
   Tests for the COMPOSITION layer (composition.js → window.EOComposition).

   composition.js is a browser IIFE that publishes onto `window` and imports
   nothing — generation, embedding, retrieval and the form library are injected
   — so, like the shape/engine harnesses, we run it in a vm context with a fake
   `window` and read window.EOComposition back out. Everything here is pure:
   fake retrievers, generators and embedders stand in for the engine/LLM/embed,
   so the whole layer is exercised with no WebGPU and no network.

   Covers, by spec phase:
     • the Confidence vector — named components, null never zero, no collapse
     • Phase one — the plan-as-log and its fold: doc/frame/unit/draft/stamp,
       latest-wins, undo by supersession (REC), redo, plan edits, cut, tree
       order, assemble
     • Phase two — the grain-relative witness stamp (Figure/Ground/Pattern) and
       the form stamp, and the monitor's predicates over the vector
     • generateUnit — retrieve → phrase → stamp → route, end to end with fakes
     • the non-breaking floor — an empty/garbage log folds to nothing, no throw

   Run with `node tests/composition.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadComposition() {
  const sandbox = { window: {}, console, performance, Date, Math };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'composition.js'), 'utf8'), sandbox, { filename: 'composition.js' });
  if (!sandbox.window.EOComposition) throw new Error('composition.js did not publish window.EOComposition');
  return sandbox.window.EOComposition;
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function near(a, b, msg, tol) { ok(Math.abs(a - b) <= (tol || 1e-6), `${msg} (got ${a}, want ≈${b})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

const C = loadComposition();

// A tiny monotonic clock so events appended in sequence get strictly-increasing
// ts even when the test runs faster than 1ms — the fold's "latest wins" tie-break
// is created_at, but draft/stamp ordering keys on ts, so we bump it explicitly.
let _t = 1000;
function at(e) { e.ts = ++_t; return e; }

group('the module publishes its surface', () => {
  for (const fn of ['fold', 'confidence', 'decide', 'witnessGrain', 'stampDraft', 'generateUnit', 'newDoc', 'make', 'assemble'])
    ok(typeof C[fn] === 'function' || typeof C[fn] === 'object', 'exports ' + fn);
  ok(Array.isArray(C.COMPONENTS) && C.COMPONENTS.length === 6, 'six named confidence components');
});

group('Confidence — named components, null is null (never zero), clamped, no collapse', () => {
  const c = C.confidence({ witness: 0.7, retrieval: 1.4, form: -0.2 });
  eq(c.witness, 0.7, 'witness carried through');
  eq(c.retrieval, 1, 'retrieval clamped to 1');
  eq(c.form, 0, 'a measured-but-negative form clamps to 0');
  eq(c.coherence, null, 'an UNMEASURED component is null, never 0');
  eq(c.temporal, null, 'temporal null until wired');
  eq(c.frame, null, 'frame null until measured');
  ok(typeof c !== 'number', 'a Confidence is a vector, never a scalar');
});

group('Phase one — newDoc spins up a doc + its frame', () => {
  const log = C.newDoc({ thesis_or_question: 'Why evictions rose', reader: 'a city council', goal: 'persuade', genre: 'plain-report' });
  eq(log.length, 2, 'a doc and a frame');
  const f = C.fold(log);
  ok(f.doc && f.frame, 'fold surfaces the doc and the frame');
  eq(f.frame.thesis_or_question, 'Why evictions rose', 'the frame carries the thesis');
  eq(f.frame.genre, 'plain-report', 'the frame points at a genre');
  eq(f.units.length, 0, 'a fresh doc owes no units yet');
  eq(f.doc.frame_id, f.frame.id, 'the doc references its frame');
});

group('Phase one — a unit is owed, then drafted, then stamped (state folds over events)', () => {
  const [doc, frame] = C.newDoc({ goal: 'inform', genre: 'plain-report' });
  const u = at(C.make.unit({ doc_id: doc.id, job: 'Open with the scale of the problem', order: 0 }));
  let f = C.fold([doc, frame, u]);
  eq(f.units.length, 1, 'one unit');
  eq(f.units[0].state, 'owed', 'a unit with no draft is owed');

  const d = at(C.make.draft({ doc_id: doc.id, unit_id: u.id, prose: 'Evictions climbed sharply last year.', confidence: C.confidence({ witness: 0.6 }) }));
  f = C.fold([doc, frame, u, d]);
  eq(f.units[0].state, 'drafted', 'a unit with a live draft is drafted');
  eq(f.units[0].draft.prose, 'Evictions climbed sharply last year.', 'the live draft prose is surfaced');

  const s = at(C.make.stamp({ doc_id: doc.id, unit_id: u.id, draft_id: d.id, confidence: C.confidence({ witness: 0.6, form: 0.7 }), tag: 'figure-grounded' }));
  f = C.fold([doc, frame, u, d, s]);
  eq(f.units[0].stamp.tag, 'figure-grounded', 'the live stamp tag is surfaced');
  eq(f.units[0].confidence.form, 0.7, 'the unit reads its confidence off the live stamp');
});

group('Phase one — editing prose appends a draft; latest wins; undo is supersession by REC; redo', () => {
  const [doc, frame] = C.newDoc({});
  const u = at(C.make.unit({ doc_id: doc.id, job: 'state the claim', order: 0 }));
  const d1 = at(C.make.draft({ doc_id: doc.id, unit_id: u.id, prose: 'First draft.' }));
  const d2 = at(C.make.draft({ doc_id: doc.id, unit_id: u.id, prose: 'Second draft.' }));
  let log = [doc, frame, u, d1, d2];
  eq(C.fold(log).units[0].draft.prose, 'Second draft.', 'the latest draft is live');

  // undo: supersede d2 → d1 becomes live again
  const undo = at(C.make.supersede(d2.id, 'undo'));
  log = [doc, frame, u, d1, d2, undo];
  eq(C.fold(log).units[0].draft.prose, 'First draft.', 'undo (REC supersede) reverts to the prior draft');

  // redo: supersede the undo → d2 live again
  const redo = at(C.make.supersede(undo.id, 'redo'));
  log = [doc, frame, u, d1, d2, undo, redo];
  eq(C.fold(log).units[0].draft.prose, 'Second draft.', 'redo (superseding the undo) restores the latest draft');

  // undo the only draft on a fresh unit → back to owed
  const [doc2, frame2] = C.newDoc({});
  const v = at(C.make.unit({ doc_id: doc2.id, job: 'x', order: 0 }));
  const dv = at(C.make.draft({ doc_id: doc2.id, unit_id: v.id, prose: 'only.' }));
  const undov = at(C.make.supersede(dv.id));
  eq(C.fold([doc2, frame2, v, dv, undov]).units[0].state, 'owed', 'undoing the only draft returns the unit to owed');
});

group('Phase one — plan edits: re-DEF latest-wins (reorder / rewrite-job), cut removes, tree by parent+order', () => {
  const [doc, frame] = C.newDoc({});
  const a = at(C.make.unit({ doc_id: doc.id, id: 'unit-A', job: 'intro', order: 1 }));
  const b = at(C.make.unit({ doc_id: doc.id, id: 'unit-B', job: 'body', order: 0 }));
  let f = C.fold([doc, frame, a, b]);
  eq(f.tree[0].id, 'unit-B', 'siblings sort by order (B before A)');

  // rewrite-job + reorder by re-DEFing the same id (a plan edit)
  const a2 = at(C.make.unit({ doc_id: doc.id, id: 'unit-A', job: 'intro, sharper', order: -1 }));
  f = C.fold([doc, frame, a, b, a2]);
  eq(f.unitsById['unit-A'].job, 'intro, sharper', 'the latest DEF of a unit wins (rewrite-job)');
  eq(f.tree[0].id, 'unit-A', 'the reorder took (A now first)');

  // a PARTIAL edit (only the job) must NOT reset order/parent — the bug make.unit
  // would cause if it injected order/parent defaults on every DEF.
  const nested = at(C.make.unit({ doc_id: doc.id, id: 'unit-N', parent_id: 'unit-A', order: 5, job: 'nested' }));
  const nestedEdit = at(C.make.unit({ doc_id: doc.id, id: 'unit-N', job: 'nested, reworded' }));
  f = C.fold([doc, frame, a, b, a2, nested, nestedEdit]);
  eq(f.unitsById['unit-N'].job, 'nested, reworded', 'a partial edit rewrites the job');
  eq(f.unitsById['unit-N'].order, 5, 'a partial edit preserves the order');
  eq(f.unitsById['unit-N'].parent_id, 'unit-A', 'a partial edit preserves the parent (stays nested)');

  // a child unit nests under its parent
  const child = at(C.make.unit({ doc_id: doc.id, id: 'unit-A1', parent_id: 'unit-A', job: 'sub', order: 0 }));
  f = C.fold([doc, frame, a, b, a2, child]);
  const A = f.tree.find(n => n.id === 'unit-A');
  ok(A && A.children.length === 1 && A.children[0].id === 'unit-A1', 'a child nests under its parent in the tree');

  // cut B
  const cut = at(C.make.edit({ doc_id: doc.id, edit_kind: 'cut', affected_unit_ids: ['unit-B'], reason: 'redundant' }));
  f = C.fold([doc, frame, a, b, a2, child, cut]);
  ok(!f.unitsById['unit-B'], 'a cut unit is gone from the fold');
  eq(f.units.length, 2, 'two units remain after the cut');
});

group('Phase one — assemble reads the draft pane straight through in tree order', () => {
  const [doc, frame] = C.newDoc({});
  const a = at(C.make.unit({ doc_id: doc.id, id: 'u1', job: 'one', order: 0 }));
  const b = at(C.make.unit({ doc_id: doc.id, id: 'u2', job: 'two', order: 1 }));
  const da = at(C.make.draft({ doc_id: doc.id, unit_id: 'u1', prose: 'Alpha.' }));
  const db = at(C.make.draft({ doc_id: doc.id, unit_id: 'u2', prose: 'Beta.' }));
  const f = C.fold([doc, frame, a, b, da, db]);
  eq(C.assemble(f), 'Alpha.\n\nBeta.', 'the assembled doc is the drafts in tree order');
});

group('Phase two — the grain-relative witness: Figure / Ground / Pattern', () => {
  const span = 'The city recorded twelve thousand eviction filings in 2023, up from nine thousand.';
  // Figure: a claim mostly covered by the span (one unwitnessed flourish) →
  // figure-grounded, high degree, held strictly below 1 by the unbound token.
  const fig = C.witnessGrain({ grain: 'Figure', prose: 'The city recorded twelve thousand eviction filings in 2023, mostly downtown.', spans: [span] });
  eq(fig.tag, 'figure-grounded', 'a Figure claim covered by a span is figure-grounded');
  ok(fig.degree >= 0.6, 'its witness degree is high (' + fig.degree + ')');
  ok(fig.degree < 1, 'an unwitnessed token holds it below 1 (the asymptote approached, not reached)');
  // a claim fully inside the span legitimately reaches full witness
  const full = C.witnessGrain({ grain: 'Figure', prose: 'The city recorded twelve thousand eviction filings in 2023.', spans: [span] });
  near(full.degree, 1, 'full coverage is full witness — witness, unlike form, may reach 1');

  // Figure with NO span → confabulation
  const conf = C.witnessGrain({ grain: 'Figure', prose: 'Evictions were caused by a secret ordinance.', spans: [] });
  eq(conf.tag, 'confabulation', 'a Figure claim with no span at all is confabulation');
  eq(conf.degree, 0, 'and witnesses none of its content');

  // Ground: an absence that matches the absence pattern set and is warranted → honest-absence
  const ground = C.witnessGrain({ grain: 'Ground', prose: 'The record does not establish who owned the building.', spans: [span] });
  eq(ground.tag, 'honest-absence', 'a warranted Ground absence is honest-absence');
  ok(ground.degree >= 0.8, 'a warranted absence carries a high witness');

  // Ground but the "absent" thing is actually in the spans → not honest
  const falseAbsence = C.witnessGrain({ grain: 'Ground', prose: 'The record does not mention eviction filings in 2023.', spans: [span] });
  ok(falseAbsence.tag !== 'honest-absence', 'an absence the spans contradict is not honest-absence (got ' + falseAbsence.tag + ')');

  // Pattern: one corroborating instance → pattern-partial; two → pattern-grounded
  const one = C.witnessGrain({ grain: 'Pattern', prose: 'Rents rose across the district.', spans: ['Rents rose across the district last spring.'] });
  eq(one.tag, 'pattern-partial', 'a Pattern claim with a single instance is partial');
  const two = C.witnessGrain({ grain: 'Pattern', prose: 'Rents rose across the district.', spans: ['Rents rose across the district last spring.', 'Across the district, rents rose again in the fall.'] });
  eq(two.tag, 'pattern-grounded', 'a Pattern claim with two instances is grounded');
});

group('Phase two — stampDraft builds the vector; form is null when no library (never zero)', () => {
  const st = C.stampDraft({ grain: 'Figure', prose: 'Evictions rose.', spans: ['Evictions rose sharply.'], retrieval: 0.8 });
  ok(st.confidence.witness != null, 'witness is measured');
  eq(st.confidence.form, null, 'form is NULL with no library — not zero');
  eq(st.confidence.retrieval, 0.8, 'retrieval rides through');
  eq(st.confidence.coherence, null, 'coherence is null until the standing operator (phase three)');
  ok(['figure-grounded', 'confabulation'].includes(st.tag), 'a tag is attached');

  // a fake form library proves the form component wires through when present
  const fakeLib = { formDegree: (genre, vec) => (genre === 'plain-report' ? 0.66 : null) };
  const st2 = C.stampDraft({ grain: 'Figure', prose: 'x rose.', spans: ['x rose.'], genre: 'plain-report', draftVec: [1, 0], formLib: fakeLib });
  eq(st2.confidence.form, 0.66, 'with a library, form is the genre-centroid cosine');
});

group('Phase two — the monitor: predicates over the vector, null never blocks', () => {
  const adv = C.decide(C.confidence({ witness: 0.6, form: 0.7 }));
  eq(adv.decision, 'advance', 'witness & form fine, coherence null → advance');
  ok(/witness >= 0.4/.test(adv.predicate), 'the advance predicate is named in v3 vocabulary');

  const advNullForm = C.decide(C.confidence({ witness: 0.6 }));
  eq(advNullForm.decision, 'advance', 'an unmeasured form (null) does NOT block advance');

  const revise = C.decide(C.confidence({ witness: 0.2, retrieval: 0.8 }));
  eq(revise.decision, 'revise', 'witness<0.4 but retrieval>=0.5 → revise (talker ignored what was found)');

  const fetch = C.decide(C.confidence({ witness: 0.2, retrieval: 0.1 }));
  eq(fetch.decision, 'fetch', 'witness<0.4 and retrieval<0.5 → fetch more material');

  const reshape = C.decide(C.confidence({ witness: 0.7, form: 0.2 }));
  eq(reshape.decision, 'revise', 'form off but grounding fine → revise (re-draft same material)');
  ok(/form < 0.5/.test(reshape.predicate), 'the form predicate is named');

  const restructure = C.decide(C.confidence({ witness: 0.7, form: 0.7 }), { persistentLowCoherence: true });
  eq(restructure.decision, 'restructure', 'persistent low coherence across a branch → restructure');
});

// The remaining groups include an async one (generateUnit); run them inside an
// async IIFE so every assertion settles before the summary prints — a group
// whose promise the runner didn't await could otherwise fail silently after it.
(async () => {
await group('generateUnit — retrieve → phrase → stamp → route, end to end with fakes', async () => {
  const [doc, frame] = C.newDoc({ goal: 'inform', genre: 'plain-report' });
  const unit = C.make.unit({ doc_id: doc.id, job: 'report the eviction count', order: 0 });
  // a fake retriever that returns a strong, on-topic span; a fake talker that
  // phrases using the material; a fake embedder (any vector).
  const retrieve = async (job) => ([{ text: 'The city logged twelve thousand eviction filings in 2023.', score: 2.0, docId: doc.id, idx: 4 }]);
  const phrase = async ({ system, user }) => 'The city logged twelve thousand eviction filings in 2023.';
  const embed = async (t) => [0.1, 0.2, 0.3];
  const out = await C.generateUnit({ unit, frame, doc_id: doc.id, retrieve, phrase, embed });
  ok(out.draft && out.stamp && out.route, 'generateUnit emits a draft, a stamp, and a route');
  eq(out.draft.kind, 'draft', 'the draft is an INS draft event');
  eq(out.stamp.kind, 'stamp', 'the stamp is an EVA stamp event');
  ok(out.confidence.witness >= 0.6, 'witness is high (the talker used the material)');
  ok(out.draft.source_events.length >= 1, 'the draft records the events it drew from');
  // the route advances (witness high, form null, coherence null)
  eq(out.route.decision, 'advance', 'the monitor advances a well-grounded unit');

  // fold the whole composition log and confirm the unit shows drafted+advance
  const f = C.fold([doc, frame, unit, out.draft, out.stamp, out.route]);
  eq(f.units[0].state, 'drafted', 'the generated unit is drafted');
  eq(f.units[0].band, 'advance', 'and its colour band is advance');

  // a talker that ignores the material confabulates → the monitor does NOT advance
  const phraseBad = async () => 'A clandestine cabal secretly orchestrated everything.';
  const out2 = await C.generateUnit({ unit, frame, doc_id: doc.id, retrieve, phrase: phraseBad, embed });
  ok(out2.confidence.witness < 0.4, 'an ungrounded draft has low witness');
  ok(out2.route.decision === 'revise', 'with material found but unused, the monitor routes to revise');
});

group('the non-breaking floor — empty / garbage logs fold to nothing, never throw', () => {
  ok(C.fold([]).units.length === 0, 'an empty log folds to no units');
  let threw = false;
  try { C.fold(null); C.fold(undefined); C.fold([null, 1, 'x', {}]); } catch (e) { threw = true; }
  ok(!threw, 'a null/garbage log never throws');
  const w = C.witnessGrain({ prose: '', spans: [] });
  eq(w.degree, null, 'witness on empty prose is null, not zero');
});

console.log(`\ncomposition.test.js — ${pass} passed, ${fail} failed`);
if (fail) { console.error('FAILURES:\n' + fails.map(s => '  - ' + s).join('\n')); process.exit(1); }
})();
