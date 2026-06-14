/* ============================================================
   Tests for eoconfidence.js — confidence as a vector, not a number.
   Pins the three invariants: null ≠ zero ≠ low; predicates name the
   components they read; the conservation read (honest absence ≠
   confabulation); summarize always names its projection.

   Run with `node tests/eoconfidence.test.js`.
   ============================================================ */
'use strict';
const C = require('../eoconfidence');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

group('mk — seven components, missing defaults to null (not 0)', () => {
  const c0 = C.mk({});
  eq(Object.keys(c0).length, 7, 'seven components present');
  eq(c0.witness, null, 'missing component is null, not 0');
  eq(C.mk({ witness: 0 }).witness, 0, 'zero is a valid, distinct value');
  let threw = false; try { C.mk({ witness: 1.5 }); } catch (e) { threw = true; } ok(threw, 'out-of-range > 1 throws');
  threw = false; try { C.mk({ form: -0.1 }); } catch (e) { threw = true; } ok(threw, 'negative throws');
});

group('surfaceable — null ≠ zero in the honest-absence clause', () => {
  ok(C.surfaceable(C.mk({ witness: 0.5 }), 'Figure'), 'grounded figure surfaces');
  ok(!C.surfaceable(C.mk({ witness: 0.2 }), 'Figure'), 'thin figure does not surface');
  ok(C.surfaceable(C.mk({ witness: null }), 'Ground'), 'null witness on a non-Figure (honest absence) surfaces');
  ok(!C.surfaceable(C.mk({ witness: null }), 'Figure'), 'null witness on a Figure does not surface');
  ok(!C.surfaceable(C.mk({ witness: 0 }), 'Ground'), 'witness ZERO (confabulation) does not surface even at Ground — zero ≠ null');
});

group('route — null is not low (not-asked ≠ unwitnessed)', () => {
  eq(C.route(C.mk({ witness: 0.1, retrieval: 0.1 })), 'fetch', 'both low → fetch');
  eq(C.route(C.mk({ witness: 0.1, retrieval: 0.8 })), 'repair', 'witness low, retrieval high → repair');
  eq(C.route(C.mk({ witness: 0.8, form: 0.2 })), 'repair', 'form low, witness high → repair');
  eq(C.route(C.mk({ witness: 0.8, retrieval: 0.8 })), 'pass', 'all good → pass');
  eq(C.route(C.mk({ witness: null, retrieval: null })), 'pass', 'null witness does NOT route to fetch');
});

group('advance — coherence + upstream witness, never a coherent claim on thin evidence', () => {
  ok(C.canAdvance(C.mk({ coherence: 0.7 }), [C.mk({ witness: 0.6 })]), 'coherent with solid upstream advances');
  ok(!C.canAdvance(C.mk({ coherence: 0.7 }), [C.mk({ witness: 0.1 })]), 'coherent but thin upstream cannot advance');
  ok(!C.canAdvance(C.mk({ coherence: null }), []), 'null coherence (no standing operator) cannot affirm advance');
});

group('gradeWitness — the conservation read', () => {
  eq(C.gradeWitness({ grain: 'Figure', coverage: 0 }).tag, 'confabulation', 'massless figure = confabulation');
  eq(C.gradeWitness({ grain: 'Figure', coverage: 0.9 }).tag, 'figure-grounded', 'grounded figure');
  eq(C.gradeWitness({ grain: 'Ground', isAbsence: true }).witness, 1.0, 'honest absence at Ground scores 1.0');
  eq(C.gradeWitness({ grain: 'Ground', isAbsence: true }).tag, 'honest-absence', 'honest-absence tag');
  eq(C.gradeWitness({ grain: 'Figure', isAbsence: true }).tag, 'grain-mismatch', 'absence at a Figure grain = grain-mismatch');
  eq(C.gradeWitness({ grain: 'Figure', isAbsence: true }).witness, null, 'grain-mismatch witness is null, not a low score');
  eq(C.gradeWitness({ grain: 'Pattern', k_observed: 3, k_required: 3 }).tag, 'pattern-grounded', 'pattern grounded at k');
  eq(C.gradeWitness({ grain: 'Pattern', k_observed: 1, k_required: 3 }).tag, 'pattern-partial', 'pattern partial below k');
});

group('summarize — names its projection, logs every call', () => {
  let logged = null;
  const v = C.summarize(C.mk({ witness: 0.8, form: 0.4 }), 'grounding', (rec) => { logged = rec; });
  eq(v, 0.8, 'grounding summary = witness component');
  eq(logged && logged.projection, 'witness', 'the projection was named and logged');
  const ov = C.projection(C.mk({ witness: 0.5, form: 0.5 }), 'overall');
  ok(ov.value > 0.49 && ov.value < 0.51, 'overall geomean of equal components');
  eq(C.projection(C.mk({ witness: 0, form: 0.5 }), 'overall').value, 0, 'a zero tanks the geomean (intolerant by design)');
  let threw = false; try { C.summarize(C.mk({}), 'bogus'); } catch (e) { threw = true; } ok(threw, 'unknown purpose throws');
});

console.log(`\n${fail === 0 ? '✓' : '✗'} eoconfidence — ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.error('  ' + f); process.exit(1); }
