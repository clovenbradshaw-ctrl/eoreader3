/* ============================================================
   tests/depicts.test.js — the depicted act carried on a CON bond.

   The reader connects; the clause may report a cut. Two addresses, never one
   field: the bond's `op` is always CON (the reading act of binding two
   referents), and `depicts` carries the story-world transformation the verb
   reports — SEG for a cut, SYN for a fusion, {state:true} for a standing
   relation, nothing when the verb is unclassified.

   Also: the autonomous evaluator (the local model) is a soft weight capped at
   its coupling — it can tip an unclassified verb but never override the lexicon.
   "A little evaluative consciousness, just a weighting; not a tie-breaker."
   ============================================================ */
'use strict';
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }
function group(n) { console.log('• ' + n); }

async function main() {
  const E = loadEngine().EOEngine;
  // a parse applies the en module and builds the live verb-class sets
  await E.parseDocument('seed.txt', 'A short tale. Marianne walked to the harbor and watched the boats.', 'seed');

  group('depicted act — the verb-class lexicon (mechanical, full weight)');
  {
    const d = (v) => E.depictedAct(v);
    ok(d('cut') && d('cut').op === 'SEG', 'cut → depicts SEG (a severing)');
    ok(d('cuts') && d('cuts').op === 'SEG', 'cuts (inflected) → SEG');
    ok(d('severed') && d('severed').op === 'SEG', 'severed → SEG');
    ok(d('married') && d('married').op === 'SYN', 'married → SYN (a fusion making a new unit)');
    ok(d('merge') && d('merge').op === 'SYN', 'merge → SYN');
    ok(d('owns') && d('owns').state === true, 'owns → a state, no depicted op');
    ok(d('resembles') && d('resembles').state === true, 'resembles → state');
    ok(d('xyzzy') === null, 'an unclassified verb commits to nothing (null)');
    ok(d('cut') && d('cut').obj === 'figure', 'an event depicts onto a figure');
  }

  group('autonomous evaluator — a soft weight, never a tie-breaker');
  {
    // the model votes SEG on an unclassified verb and SYN on a classified one
    E.setDepictsEvaluator((head) =>
      head === 'frobnicate' ? { op: 'SEG', weight: 0.6 } :
      head === 'cut' ? { op: 'SYN', weight: 0.6 } : null);
    ok(E.depictedAct('frobnicate') && E.depictedAct('frobnicate').op === 'SEG',
      'the model tips an UNCLASSIFIED verb (frobnicate → SEG)');
    ok(E.depictedAct('cut') && E.depictedAct('cut').op === 'SEG',
      'the model CANNOT override the lexicon (cut stays SEG though the model voted SYN)');
    E.setDepictsEvaluator(null);
    ok(E.depictedAct('frobnicate') === null, 'evaluator off → the unclassified verb is null again');
  }

  group('on the bond — depicts rides a real CON, op stays CON');
  {
    // The English proper-name CON is starved today (Brutus/Caesar admit as
    // entities but don't resolve in the SVO pass — the separate resolution bug),
    // so the depicted act is shown on the Greek path, where the case-role
    // deed-finder resolves both endpoints deterministically. depicts attaches
    // wherever a CON fires; the en path lights up once resolution is fixed.
    const fs = require('fs'); const path = require('path');
    E.loadConventionPacks(fs.readFileSync(path.join(__dirname, '..', 'memory', 'packs', 'el-classical-v1.jsonl'), 'utf8'));
    const TXT = ['Κῦρος βασιλεὺς ἦν.', 'ὁ Κῦρος ἵππον εἶχεν.',
      'τὸν ἵππον ὁ Κῦρος ἔλυσεν.', 'ὁ ἵππος ἔφυγεν.'].join(' ');
    const g = E._extractGreekGraph(TXT, 0);
    const con = g.events.find(e => e.op === 'CON' && e.depicts);
    ok(con, 'a Greek CON carries a depicts address');
    ok(con && con.op === 'CON', 'the bond op stays CON (the reading act), never the depicted op');
    ok(con && ['figure', 'pattern', 'ground'].includes(con.depicts.obj), 'depicts.obj is the Time-column grain the aspect marks');
    ok(con && con.depicts.voice, 'depicts carries the voice the morphology marks');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
