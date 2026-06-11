/* ============================================================
   tests/depicts-model.test.js — the model-backed depicted-act evaluator.

   The autonomous consumer of the local model: a background classifier asks the
   model to name the depicted act of each UNclassified verb and caches it; the
   synchronous evaluator depictedAct consults that cache. The model is the
   weakest reader — capped at its coupling — so it tips an unclassified verb but
   never overrides the lexicon, and never needs a human in the loop.

   Tested with a MOCK model (no WebGPU in Node); the real call is EOLLM.ask.
   ============================================================ */
'use strict';
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }
function group(n) { console.log('• ' + n); }

async function main() {
  const E = loadEngine().EOEngine;
  await E.parseDocument('seed.txt', 'A short tale. Marianne walked to the harbor.', 'seed');

  group('closed grammar — only "verb: LABEL" in the four labels is kept');
  {
    const got = E._parseDepictsReply('cut: SEVER\nsome chatter\nmarry: FUSE\nfoo: BANANA\nhold: STATE', ['cut', 'marry', 'foo', 'hold']);
    ok(got.get('cut') === 'SEG', 'SEVER → SEG');
    ok(got.get('marry') === 'SYN', 'FUSE → SYN');
    ok(got.get('hold') === 'STATE', 'STATE → STATE');
    ok(!got.has('foo'), 'an off-grammar label (BANANA) is dropped');
    ok(E._depictsClassifyPrompt(['cut']).includes('SEVER'), 'the prompt offers the closed label set');
  }

  group('autonomous classify — the model tips unclassified verbs, lexicon still wins');
  {
    E.enableModelDepicts();
    const ask = async () => 'frobnicate: SEVER\nbork: STATE\nsplork: RELATE\nglorp: BANANA';
    const res = await E.classifyDepictedActs(['frobnicate', 'cut', 'bork', 'splork', 'glorp'], ask);
    ok(res.classified === 3, 'three unclassified verbs classified; cut (lexicon) was never asked (' + res.classified + ')');
    ok(E.depictedAct('frobnicate') && E.depictedAct('frobnicate').op === 'SEG', 'frobnicate → SEG (from the model)');
    ok(E.depictedAct('bork') && E.depictedAct('bork').state === true, 'bork → STATE (from the model)');
    ok(E.depictedAct('splork') && E.depictedAct('splork').op === 'CON', 'splork → CON (RELATE)');
    ok(E.depictedAct('glorp') === null, 'glorp stays unclassified (off-grammar dropped)');
    ok(E.depictedAct('cut') && E.depictedAct('cut').op === 'SEG', 'cut stays SEG — the lexicon, not the model');
    ok(E.depictedAct('frobnicate').w <= 0.6, 'the model vote is capped at its coupling (≤ 0.6)');
  }

  group('robustness — a model error never throws; classification is idempotent');
  {
    const r = await E.classifyDepictedActs(['zzz'], async () => { throw new Error('boom'); });
    ok(r.classified === 0 && !('throw' in r), 'a model error returns {classified:0}, never throws');
    ok(E.depictedAct('zzz') === null, 'the failed verb stays unclassified');
    const r2 = await E.classifyDepictedActs(['frobnicate'], async () => 'frobnicate: FUSE');
    ok(r2.asked === 0, 'an already-cached verb is not re-asked (frobnicate stays SEG, not re-flipped to SYN)');
    ok(E.depictedAct('frobnicate').op === 'SEG', 'the cached classification is stable');
  }

  group('queue — the unclassified relation verbs a doc offers the classifier');
  {
    const doc = { _events: [{ op: 'CON', v: 'frobnicate' }, { op: 'CON', v: 'cut' }, { op: 'SYN', v: 'bork' }, { op: 'CON', v: 'cut' }] };
    // fresh engine so nothing is cached
    const E2 = loadEngine().EOEngine;
    await E2.parseDocument('s.txt', 'A tale. Marianne walked.', 's');
    const q = E2.unclassifiedDepictsVerbs(doc);
    ok(q.includes('frobnicate') && q.includes('bork'), 'unclassified verbs are queued (frobnicate, bork)');
    ok(!q.includes('cut'), 'a lexicon-known verb (cut) is never queued');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
