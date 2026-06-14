/* ============================================================
   Tests for eoscore.js — the layered position scorer. In Node there is no
   embedder, so this exercises the cue layer + graceful degrade + that the
   output is always a valid classification Confidence (margin only; the no-cue
   default carries margin null, not 0 — null ≠ zero ≠ low). The embedding
   layers (ablation/substitution) are exercised in the browser and the A/B
   harness, where an embedder is present.

   Run with `node tests/eoscore.test.js`.
   ============================================================ */
'use strict';
const { loadEngine } = require('./harness');
const EOScore = require('../eoscore');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

async function main() {
  const W = loadEngine();
  const E = W.EOEngine;
  const sc = EOScore.createScorer({ objectOf: E.objectOf });   // inject the engine's cue layer

  const active = await sc.ready();
  eq(active, false, 'no embedder ⇒ embeddings inactive (graceful degrade)');
  eq(sc.layers().join(','), 'cue', 'cue layer only without an embedder');

  await group('object — cue prior; the no-cue default is not a confident call', async () => {
    const ground = await sc.classifyObject('the market mood shifted overnight', 'market');
    eq(ground.value, 'Ground', 'an ambient mass noun reads Ground');
    eq(ground.confidence.margin, 0.5, 'a cue hit carries a margin');
    ok(ground.evidence.includes('cue'), 'evidence names the cue layer');
    const pat = await sc.classifyObject('it is a kind of seabird', 'kind');
    eq(pat.value, 'Pattern', 'a category noun reads Pattern');
    const fig = await sc.classifyObject('Edith lit the lamp', 'Edith');
    eq(fig.value, 'Figure', 'a specific existent defaults to Figure');
    eq(fig.confidence.margin, null, 'the no-cue default is NOT confident — margin null, not 0');
    eq(fig.confidence.witness, null, 'a classification leaves the evidence components null');
  });

  await group('domain — seed cues; null when no confident cue', async () => {
    const interp = await sc.classifyDomain('what does the lamp mean here', 'mean');
    eq(interp.value, 'Interpretation', 'a meaning predicate reads Interpretation');
    eq(interp.confidence.margin, 0.5, 'a domain cue hit carries a margin');
    const none = await sc.classifyDomain('zzz', 'zzz');
    eq(none.confidence.margin, null, 'no cue ⇒ margin null (not a guess)');
  });

  console.log(`\n${fail === 0 ? '✓' : '✗'} eoscore — ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of fails) console.error('  ' + f); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
