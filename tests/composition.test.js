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
  ok(Array.isArray(C.COMPONENTS) && C.COMPONENTS.length === 7, 'seven named confidence components');
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

group('Phase one — a frame revision stales dependent units (coherence null, band revise); a restructure survivor reads unstamped', () => {
  const [doc, frame] = C.newDoc({ genre: 'plain-report' });
  const u = at(C.make.unit({ doc_id: doc.id, id: 'u1', job: 'state the count', order: 0 }));
  const d = at(C.make.draft({ doc_id: doc.id, unit_id: 'u1', prose: 'The city logged twelve thousand filings.' }));
  const s = at(C.make.stamp({ doc_id: doc.id, unit_id: 'u1', draft_id: d.id, confidence: C.confidence({ witness: 0.7, form: 0.7 }), tag: 'figure-grounded' }));
  const r = at(C.make.route({ doc_id: doc.id, unit_id: 'u1', decision: 'advance', predicate: 'witness >= 0.4 AND form >= 0.5' }));

  // under the standing (single) frame the unit is settled, not stale
  let f = C.fold([doc, frame, u, d, s, r]);
  eq(f.units[0].band, 'advance', 'under the standing frame the unit advances');
  eq(f.units[0].frame_stale, false, 'and is not frame-stale');
  eq(f.counts.stale, 0, 'no stale units yet');

  // revise the frame (a later frame event, genre flipped) — the stamp predates it
  const frame2 = at(C.make.frame({ doc_id: doc.id, genre: 'obituary' }));
  f = C.fold([doc, frame, u, d, s, r, frame2]);
  eq(f.frame.genre, 'obituary', 'the latest frame wins (the revision supersedes the posture)');
  eq(f.units[0].frame_stale, true, 'a stamp minted before the new frame is stale');
  eq(f.units[0].band, 'revise', 'a frame-staled unit routes to revise (reconsider under the new spec)');
  eq(f.units[0].confidence.coherence, null, 'its coherence reads null — it must be re-derived under the new frame');
  eq(f.counts.stale, 1, 'the stale unit is counted');

  // a draft re-stamped AFTER the revision is measured against the live frame → not stale
  const d2 = at(C.make.draft({ doc_id: doc.id, unit_id: 'u1', prose: 'A fresh draft under the new frame.' }));
  const s2 = at(C.make.stamp({ doc_id: doc.id, unit_id: 'u1', draft_id: d2.id, confidence: C.confidence({ witness: 0.7 }), tag: 'figure-grounded' }));
  eq(C.fold([doc, frame, u, d, s, r, frame2, d2, s2]).units[0].frame_stale, false, 'a draft re-stamped after the revision is no longer stale');

  // a drafted unit that was never stamped (a restructure survivor) reads unstamped
  const u2 = at(C.make.unit({ doc_id: doc.id, id: 'u2', job: 'orphan', order: 1 }));
  const d3 = at(C.make.draft({ doc_id: doc.id, unit_id: 'u2', prose: 'Drafted, never scored.' }));
  const g = C.fold([doc, frame, u2, d3]);
  eq(g.units[0].state, 'drafted', 'a draft with no stamp is still drafted');
  eq(g.units[0].unstamped, true, 'but is flagged unstamped (no verdict on any band)');
  eq(g.counts.unstamped, 1, 'and counted, so the loop can find and score it');
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

group('Phase two — stampDraft mechanical re-citation rescue (the local-model paraphrase)', () => {
  // a faithful paraphrase that reuses NONE of the span's words — what a small
  // local model emits — so the token-overlap witness sees nothing.
  const prose = 'Climbing to roughly three hundred and thirty metres, it long reigned as the loftiest thing built by people.';
  const spans = ['The tower is 330 m tall and was the tallest man-made edifice in the world for 41 years.'];
  const bare = C.stampDraft({ grain: 'Figure', prose, spans });
  eq(bare.tag, 'confabulation', 'without the grounder, a token-distant paraphrase reads as confabulation');
  ok(bare.confidence.witness < 0.4, 'and its lexical witness is below the floor');
  eq(bare.rescued, false, 'a stamp with no grounder is not marked rescued');

  // the grounder (engine.groundTalkerOutput, here faked) bound every sentence to
  // a real source line → the rescue credits it.
  const rescued = C.stampDraft({ grain: 'Figure', prose, spans, grounded: { degree: 1, grounded: true } });
  eq(rescued.rescued, true, 'the stamp records that a rescue applied');
  eq(rescued.tag, 'figure-grounded', 'a bound paraphrase is re-tagged figure-grounded, not confabulation');
  ok(rescued.confidence.witness >= 0.4, 'the witness is lifted to the grounder coverage');
  eq(C.decide(rescued.confidence).decision, 'advance', 'so the monitor advances instead of a futile fetch');

  // safety — the rescue NEVER lowers an already-grounded witness (parity).
  const strong = C.stampDraft({ grain: 'Figure', prose: 'The tower is 330 m tall.', spans: ['The tower is 330 m tall.'], grounded: { degree: 0.2, grounded: true } });
  ok(strong.confidence.witness > 0.4 && !strong.rescued, 'a strong lexical witness ignores a weaker grounder signal (no downgrade)');

  // safety — a grounder that bound NOTHING (a real confabulation) does not lift.
  const stillConfab = C.stampDraft({ grain: 'Figure', prose, spans, grounded: { degree: 0, grounded: false } });
  eq(stillConfab.tag, 'confabulation', 'a confabulation the grounder cannot bind stays confabulation');
  ok(!stillConfab.rescued, 'and is not marked rescued');
});

group('Phase two — parseOutline strips a model lead-in and list markers (item 2/6)', () => {
  const withPreamble = 'Here are the proposed sections:\n1. Introduction\n2. The design and its critics\n3. Records and height';
  const jobs = C.parseOutline(withPreamble);
  eq(jobs.length, 3, 'the lead-in line is dropped; three jobs remain');
  eq(jobs[0], 'Introduction', 'a numbered marker is stripped from the first job');
  ok(!jobs.some(j => /here are/i.test(j)), 'the preamble never becomes a job');
  eq(C.parseOutline('I. Introduction\nII. History\nIII. Impact').join('|'), 'Introduction|History|Impact', 'roman-numeral markers are stripped');
  eq(C.parseOutline('Introduction\nThe history\nThe impact').length, 3, 'a clean one-job-per-line reply keeps every line (no false preamble drop)');
  eq(C.parseOutline('Introduction\nThe history')[0], 'Introduction', 'and its first line is kept as a job');
  eq(C.parseOutline('').length, 0, 'empty text yields no jobs');
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

group('Phase three (voice) — a target voice is scored as style alignment; drift routes to revise, null never blocks', () => {
  ok(C.COMPONENTS.includes('voice'), 'voice is a named confidence component');
  ok(C.FLOOR.voice != null, 'voice carries a floor');

  // styleVector is a fixed-length fingerprint; identical prose aligns fully, a
  // very different register aligns less (the mean-centred cosine is discriminative).
  const terse = 'Rents rose. Evictions followed. Families left.';
  const ornate = 'In the fullness of that difficult year, as the cost of shelter climbed inexorably beyond reach, a great many households found themselves compelled, reluctantly and with no small grief, to depart their homes.';
  eq(C.styleVector(terse).length, C.styleVector(ornate).length, 'the style fingerprint is fixed-length regardless of input');
  near(C.voiceDegree(terse, terse), 1, 'a draft in exactly the target voice aligns fully', 1e-9);
  ok(C.voiceDegree(terse, ornate) < C.voiceDegree(terse, terse), 'a draft in a very different register aligns less than an identical one');
  eq(C.voiceDegree('anything at all', null), null, 'no target voice → voice is not measured (null)');

  // the monitor gates on voice exactly like form: below floor with witness fine → revise
  const drift = C.decide(C.confidence({ witness: 0.7, voice: 0.2 }));
  eq(drift.decision, 'revise', 'witness fine but voice below floor → revise (redraft to the voice)');
  ok(/voice < 0.5/.test(drift.predicate), 'the voice predicate is named in v3 vocabulary');
  eq(C.decide(C.confidence({ witness: 0.7 })).decision, 'advance', 'an unmeasured voice (null) never blocks advance');
  eq(C.decide(C.confidence({ witness: 0.7, voice: 0.8 })).decision, 'advance', 'a voice at/above floor advances');
});

group('provenance — authorship per SENTENCE, by diff (changes carry the new author, not keystrokes)', () => {
  // a talker draft of two sentences; the user edits the second, keeps the first
  const talkerProse = 'The city logged twelve thousand filings. Most were downtown.';
  const talkerProv = C.splitSentences(talkerProse).map(t => ({ text: t, author: 'talker' }));
  const edited = 'The city logged twelve thousand filings. I think the cause was the rent freeze ending.';
  const prov = C.diffProvenance(talkerProse, talkerProv, edited, 'user');
  eq(prov.length, 2, 'one provenance entry per sentence');
  eq(prov[0].author, 'talker', 'an unchanged sentence keeps the talker as its author');
  eq(prov[1].author, 'user', 'a changed/new sentence is attributed to the user (the CHANGE carries the author)');

  // authorship summary over a fold
  const [doc, frame] = C.newDoc({});
  const u = at(C.make.unit({ doc_id: doc.id, id: 'u1', job: 'x', order: 0 }));
  const d = at(C.make.draft({ doc_id: doc.id, unit_id: 'u1', prose: edited, provenance: prov }));
  const a = C.authorship(C.fold([doc, frame, u, d]));
  eq(a.total, 2, 'two sentences total'); eq(a.user, 1, 'one is the user’s'); eq(a.talker, 1, 'one is the talker’s');
});

group('the projection — a queryable prose shape, provenance traceable, talker sees only text', () => {
  const [doc, frame] = C.newDoc({ thesis_or_question: 'Evictions', genre: 'plain-report' });
  const u1 = at(C.make.unit({ doc_id: doc.id, id: 'u1', job: 'count', order: 0 }));
  const u2 = at(C.make.unit({ doc_id: doc.id, id: 'u2', job: 'cause', order: 1 }));
  const d1 = at(C.make.draft({ doc_id: doc.id, unit_id: 'u1', prose: 'Filings rose to twelve thousand.', author: 'talker', provenance: [{ text: 'Filings rose to twelve thousand.', author: 'talker' }] }));
  const d2 = at(C.make.draft({ doc_id: doc.id, unit_id: 'u2', prose: 'I attribute it to the rent freeze ending.', author: 'user', provenance: [{ text: 'I attribute it to the rent freeze ending.', author: 'user' }] }));
  const fdoc = { id: doc.id, name: 'Evictions', kind: 'composition', _events: [doc, frame, u1, u2, d1, d2] };
  const proj = C.project(fdoc);
  eq(proj.kind, 'prose', 'the projection is a prose-shaped doc the retriever can read');
  eq(proj.sentences.length, 2, 'one indexed sentence per draft sentence, in tree order');
  eq(proj.sentenceTexts[0], 'Filings rose to twelve thousand.', 'sentence 0 is the first unit, verbatim — just text');
  ok(Array.isArray(proj.blocks) && proj.blocks.length === 2, 'blocks mirror the units');
  ok(Array.isArray(proj._events) && proj._events.length === 0, 'the projection carries an EMPTY event log — the composition’s real events are never graph-projected');
  // provenance rides alongside (traceable) but is OUT of the sentence text the talker sees
  eq(proj._provenance[0].author, 'talker', 'sentence 0 traces to the talker');
  eq(proj._provenance[1].author, 'user', 'sentence 1 traces to the user');
  eq(proj._provenance[1].unit_id, 'u2', 'and to its owning unit');
  ok(!/talker|user|author/.test(proj.sentenceTexts.join(' ')), 'no authorship vocabulary leaks into the text the talker would read');
  // an empty composition projects cleanly (no drafts yet)
  const empty = C.project({ id: 'e', _events: C.newDoc({}) });
  ok(empty._empty && empty.sentences.length === 0, 'an undrafted composition projects to an empty (but valid) prose shape');
});

group('seed-from-prose — turn a chat answer into an editable, talker-authored composition', () => {
  const text = 'The city logged twelve thousand eviction filings in 2023 {{cite:d1:4}}. Most were downtown.\n\nThe rent freeze ended in spring {{cite:d1:9}}, which many tie to the surge.';
  const folded = C.fold(C.seedFromProse({ text, thesis: 'Why did evictions rise?', genre: 'plain-report' }));
  eq(folded.frame.thesis_or_question, 'Why did evictions rise?', 'the question that prompted the answer becomes the frame thesis');
  eq(folded.counts.units, 2, 'each paragraph becomes a unit');
  const u0 = folded.tree[0];
  ok(/twelve thousand/.test(u0.draft.prose), 'the prose is carried verbatim');
  ok(!/\{\{cite/.test(u0.draft.prose), 'citation tokens are stripped from the prose the canvas shows');
  eq(u0.draft.author, 'talker', 'a seeded draft is authored by the talker (not you)');
  ok(u0.draft.provenance.length === 2 && u0.draft.provenance.every(p => p.author === 'talker'), 'every sentence traces to the talker until you edit');
  ok(u0.draft.source_events.some(s => s.docId === 'd1' && s.idx === 4), 'citations survive as the draft’s evidence links');

  // markup is flattened so the canvas reads as a document, and a lone heading
  // labels the unit that follows it
  const f2 = C.fold(C.seedFromProse({ text: '## Findings\n\nA **bold** point and a [link](http://x).' }));
  const last = f2.tree[f2.tree.length - 1];
  ok(!/\*\*|\]\(|^#/.test(last.draft.prose), 'bold / link / heading markup is flattened');
  ok(/bold point/.test(last.draft.prose) && /link/.test(last.draft.prose), 'the words survive the flattening');
  ok(/Findings/.test(last.job), 'a lone heading line becomes the following unit’s job');

  eq(C.fold(C.seedFromProse({ text: '   ' })).counts.units, 0, 'empty / whitespace prose seeds no units (just the frame)');
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

await group('generateUnit — the re-citation rescue credits a paraphrase, refuses a confabulation', async () => {
  const [doc, frame] = C.newDoc({ goal: 'inform', genre: 'plain-report' });
  const unit = C.make.unit({ doc_id: doc.id, job: 'Introduction', order: 0 });   // a generic job
  const retrieve = async () => [];                       // the generic job retrieves nothing (item 6, observed live)
  const embed = async () => [0.1, 0.2, 0.3];
  // a faithful paraphrase that reuses none of the corpus's words
  const phrase = async () => 'Rising over the Champ de Mars, the iron monument honours the engineer whose firm assembled it.';
  // the grounder binds every sentence to a real line (what groundTalkerOutput does)
  const ground = async () => ({ degree: 1, grounded: true, cites: [{ docId: doc.id, idx: 2 }] });
  const out = await C.generateUnit({ unit, frame, doc_id: doc.id, retrieve, phrase, embed, ground });
  eq(out.rescued, true, 'a paraphrase whose generic job retrieved nothing is rescued by the grounder');
  ok(out.confidence.witness >= 0.4, 'its witness is lifted above the floor');
  eq(out.route.decision, 'advance', 'so the monitor advances instead of fetch');
  ok(out.draft.source_events.length >= 1 && out.draft.source_events[0].idx === 2, 'the per-sentence cites become the source_events where the job retrieved none');

  // a genuine confabulation: the grounder binds nothing → no rescue, stays low
  const groundNone = async () => ({ degree: 0, grounded: false, cites: [] });
  const out2 = await C.generateUnit({ unit, frame, doc_id: doc.id, retrieve, phrase, embed, ground: groundNone });
  ok(!out2.rescued, 'a confabulation the grounder cannot bind is not rescued');
  ok(out2.confidence.witness == null || out2.confidence.witness < 0.4, 'and its witness stays below the floor');
  eq(out2.route.decision, 'fetch', 'with nothing retrieved or bound, the monitor fetches');
});

await group('evaluateProse + the rewrite loop — "is it succeeding?", "is it repeating?", guided correction', async () => {
  const [doc, frame] = C.newDoc({ goal: 'inform', genre: 'plain-report' });
  const unit = C.make.unit({ doc_id: doc.id, job: 'report the eviction count', order: 0 });
  const spans = [{ text: 'The city logged twelve thousand eviction filings in 2023.', score: 2.0, docId: doc.id, idx: 4 }];
  const embed = async () => [0.1, 0.2, 0.3];
  const deps = { unit, frame, embed };

  // the loop's success test: the monitor's decision over the candidate
  const good = await C.evaluateProse(deps, 'The city logged twelve thousand eviction filings in 2023.', spans);
  eq(good.decision, 'advance', 'a grounded passage evaluates as succeeding (advance) → the loop can stop');
  ok(good.score > 0, 'and carries a positive score');
  const bad = await C.evaluateProse(deps, 'A clandestine cabal secretly orchestrated everything.', spans);
  eq(bad.decision, 'revise', 'an ungrounded passage (material found, unused) routes to revise → the loop rewrites');
  ok(bad.score < good.score, 'and scores below the grounded one (so an improving rewrite is detectable)');
  ok(typeof bad.predicate === 'string' && bad.predicate.length > 0, 'the evaluation names the gate that fired');

  // error-correction guidance is concrete and keyed to the shortfall
  ok(/material/i.test(C.reviseGuidance(bad.decision, bad.predicate)), 'a witness/retrieval shortfall → guidance points at the source material');
  ok(/coherent|contradiction/i.test(C.reviseGuidance('restructure', 'coherence < 0.4 across multiple units')), 'a restructure shortfall → guidance points at coherence');

  // the improvement metric weights witness most and never credits the unmeasured
  ok(C.scoreConfidence({ witness: 0.8 }) > C.scoreConfidence({ witness: 0.2 }), 'a higher witness scores higher');
  eq(C.scoreConfidence({}), 0, 'nothing measured → score 0 (no false credit)');

  // the "not getting in its own way" signals: novelty + sentence dedup
  const existing = 'The tower is 330 metres tall. It opened in 1889.';
  ok(C.noveltyRatio(existing, 'A separate report covers visitor numbers and ticketing.') > 0.5, 'fresh material reads as novel → keep expanding');
  ok(C.noveltyRatio(existing, 'The tower is 330 metres tall.') < 0.2, 'a restatement reads as NOT novel → stop expanding');
  const deduped = C.dropDuplicateSentences(existing, 'The tower is 330 metres tall. A genuinely different clause follows here.');
  ok(!/330 metres tall/.test(deduped) && /genuinely different/.test(deduped), 'duplicate sentences are dropped, genuinely new ones kept');

  // the corrective rewrite carries the guidance into the prompt
  ok(/FIX-THIS-SPECIFICALLY/.test(C.buildRevisePrompt({ job: unit.job, frame, spans, draft: 'x', guidance: 'FIX-THIS-SPECIFICALLY' }).user),
    'buildRevisePrompt threads the guidance into the rewrite instruction');
});

await group('voice end-to-end — a frame carrying a target voice makes evaluateProse measure it', async () => {
  const voice = 'Rents rose. Evictions followed. Families left.';
  const [doc, frame] = C.newDoc({ goal: 'inform', genre: 'plain-report', voice });
  eq(frame.voice, voice, 'the frame carries the target voice');
  const unit = C.make.unit({ doc_id: doc.id, job: 'report the count', order: 0 });
  const spans = [{ text: 'The city logged twelve thousand eviction filings in 2023.', score: 2, docId: doc.id, idx: 4 }];
  const ev = await C.evaluateProse({ unit, frame }, 'The city logged twelve thousand eviction filings in 2023.', spans);
  ok(ev.confidence.voice != null, 'with a target voice on the frame, the draft is given a measured voice score');

  // a frame WITHOUT a target voice leaves the band unmeasured (null), never zero
  const [, frame2] = C.newDoc({ goal: 'inform', genre: 'plain-report' });
  const ev2 = await C.evaluateProse({ unit, frame: frame2 }, 'Some prose.', spans);
  eq(ev2.confidence.voice, null, 'no target voice on the frame → voice null (not measured)');
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
