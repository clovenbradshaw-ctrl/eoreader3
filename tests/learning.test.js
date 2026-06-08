/* ============================================================
   Does the engine actually process text — and does it get SMARTER over
   use? The reading engine has no hardcoded speech-verb lexicon: it INDUCES
   the speech-verb class from each document's own typography (the
   quote-attribution slot), admits a verb after two sightings, accrues mass
   on every confirming sighting, and persists that in a module-level rules
   ledger that carries across documents in a session.

   These tests pin that learning behaviour empirically, via the engine's
   own observable outputs:
     - SIG events from _extractEoGraph carry an `attributed` field:
       'named' = clean verb-based attribution, 'fallback'/'none' = it could
       not use the verb.
     - _learnedVerbs() reports the induced verb class and each verb's mass.

   Run with `node tests/learning.test.js`.
   ============================================================ */
'use strict';
const { loadEngine } = require('./harness');

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => c ? pass++ : (fail++, fails.push(m), console.error('  ✗ ' + m));
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const group = (n, fn) => { console.log('• ' + n); fn(); };

const sigsOf = (E, text) => (E._extractEoGraph(text).events || []).filter(e => e.op === 'SIG');
const attrFor = (E, text, mark) => {
  const s = sigsOf(E, text).find(e => (e.quote || '').includes(mark));
  return s ? s.attributed : null;
};
// n inverted-attribution sentences ("...," <verb> Name.) — the construction
// whose speaker can ONLY be recovered if <verb> is known to be a speech verb.
const NAMES = ['Mira', 'Toman', 'Sela', 'Edith', 'Marlow'];
const novelDoc = (verb, n) =>
  Array.from({ length: n }, (_, i) => `"Line ${i} here," ${verb} ${NAMES[i % NAMES.length]}.`).join(' ');

group('starts empty — no hardcoded speech verbs', () => {
  const E = loadEngine().EOEngine;
  eq(JSON.stringify(E._learnedVerbs()), '[]', 'a fresh engine has induced no speech verbs');
  // and so a never-seen verb cannot be cleanly attributed cold
  ok(attrFor(E, `"The bridge is out," zlorped Mira.`, 'bridge') !== 'named',
    'cold, a never-seen verb yields no clean (named) attribution');
});

group('induction — two-sighting admission within a document', () => {
  const E1 = loadEngine().EOEngine;
  sigsOf(E1, `"Once only," brindled Mira.`);                       // x1
  ok(!E1._learnedVerbs().some(v => v.verb === 'brindled'), 'a verb seen ONCE is not admitted');

  const E2 = loadEngine().EOEngine;
  sigsOf(E2, `"Once," brindled Mira. "Twice," brindled Toman.`);   // x2
  const lv = E2._learnedVerbs().find(v => v.verb === 'brindled');
  ok(lv, 'a verb seen TWICE in a document is admitted');
  eq(lv && lv.mass, 2, 'an admitted verb carries mass equal to its sightings');
});

group('gets smarter over use — cross-document transfer', () => {
  const TEST = `"The bridge is out," quemished Mira.`;     // single sighting of a novel verb

  const cold = loadEngine().EOEngine;
  const coldAttr = attrFor(cold, TEST, 'bridge');

  const primed = loadEngine().EOEngine;
  sigsOf(primed, novelDoc('quemished', 3));                // a PRIOR document teaches the verb
  const primedAttr = attrFor(primed, TEST, 'bridge');

  ok(coldAttr !== 'named', `cold engine cannot cleanly attribute the verb (was ${JSON.stringify(coldAttr)})`);
  eq(primedAttr, 'named', 'after learning the verb from a prior document, the SAME sentence attributes cleanly');
  ok(coldAttr !== primedAttr, 'reading the prior document measurably changed how the test sentence is read');
});

group('confidence accrues — mass grows with confirming use', () => {
  const E = loadEngine().EOEngine;
  const massOf = (v) => { const x = E._learnedVerbs().find(e => e.verb === v); return x ? x.mass : 0; };

  E.parseDocument('a', novelDoc('flunsed', 2), 'a');
  const m1 = massOf('flunsed');
  E.parseDocument('b', `"Just once," flunsed Mira.`, 'b');         // single sighting — guarded out
  const m2 = massOf('flunsed');
  E.parseDocument('c', novelDoc('flunsed', 3), 'c');               // three confirming sightings
  const m3 = massOf('flunsed');

  eq(m1, 2, 'first document admits the verb at mass 2');
  eq(m2, 2, 'a lone single sighting does NOT move mass (two-sighting guard holds across docs)');
  eq(m3, 5, 'confirming sightings accrue mass (2 + 3)');
  ok(m3 > m1, 'the engine grows strictly more confident in the verb with use');
});

group('learns rules, never content', () => {
  const E = loadEngine().EOEngine;
  E.parseDocument('x', novelDoc('snerked', 2), 'x');
  const verbs = E._learnedVerbs().map(v => v.verb);
  ok(verbs.includes('snerked'), 'the learning record holds the induced verb');
  ok(!verbs.includes('Mira') && !verbs.some(v => /[A-Z]/.test(v)),
    'the learning record holds rules (lowercase verbs), never document content (names)');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
