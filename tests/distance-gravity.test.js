/* ============================================================
   tests/distance-gravity.test.js — the ACT-R distance-gravity law.

   Pins three things:
     1. gravityPull — the pure power-law kernel (purity, monotonicity, the
        exponent/offset behavior, the formula value). This is the contract the
        binder and the A/B harness both consume.
     2. The parity floor — distance_gravity ships OFF, so the default reader is
        byte-identical (the global golden in tests/parity.js proves the rest).
     3. Wiring — with the rule ON (via window.EO_RULES, the way deriveSets
        re-applies host settings on every parse), the binder actually consults
        token-distance: the steward over-stall the design note calls out — "she"
        before "Then tell them the grain is theirs" — flips from a stall to a
        bind, the effect evo/experiments/distance-gravity-ab.js measures.

   The law is a swap of HOW pull is computed, not a default change; the geometric
   clock stays the live default (the A/B read returns HOLD), so this is the test
   of an available, parity-safe capability, not of a flipped behavior.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('./harness');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }
function approx(a, b, eps, m) { ok(Math.abs(a - b) <= (eps || 1e-9), `${m} (${a} ≈ ${b})`); }

async function main() {
  const W = loadEngine();
  const E = W.EOEngine;
  const P = E.gravityPull;

  console.log('• gravityPull — the pure ACT-R kernel');
  // purity: same inputs, same output, no sequential state
  ok(P([{ pos: 0, w: 1 }], 10, 0.5, 20) === P([{ pos: 0, w: 1 }], 10, 0.5, 20), 'deterministic: two calls at one cursor are identical');
  // empty / ahead-of-cursor contribute nothing
  ok(P([], 10, 0.5, 20) === 0, 'no mentions ⇒ zero pull');
  ok(P([{ pos: 50, w: 1 }], 10, 0.5, 20) === 0, 'a mention ahead of the cursor (d<0) never pulls');
  // monotonicity: a nearer mention pulls harder than a farther one
  ok(P([{ pos: 9 }], 10, 0.5, 20) > P([{ pos: 0 }], 10, 0.5, 20), 'a nearer mention out-pulls a farther one');
  // summation over mentions
  approx(P([{ pos: 0 }, { pos: 8 }], 10, 0.5, 20), P([{ pos: 0 }], 10, 0.5, 20) + P([{ pos: 8 }], 10, 0.5, 20), 1e-9, 'pull is the sum over mentions');
  // the formula itself: Σ w/(d+k)^α
  approx(P([{ pos: 4, w: 2 }], 10, 0.5, 20), 2 / Math.sqrt((10 - 4) + 20), 1e-9, 'matches Σ w/(d+k)^α exactly');
  // weight defaults to 1, and a bare number position is accepted
  approx(P([5], 10, 1.0, 0), 1 / 5, 1e-9, 'bare position + α=1,k=0 ⇒ 1/d');
  // α controls how sharply recency wins: a larger α widens the near/far ratio
  const near = [{ pos: 95 }], far = [{ pos: 5 }];
  const ratio = (a) => P(near, 100, a, 20) / P(far, 100, a, 20);
  ok(ratio(1.0) > ratio(0.5), 'a larger α makes recency win harder (steeper power law)');
  // k softens: a larger offset pulls the near/far ratio toward 1
  const rk = (k) => P(near, 100, 0.5, k) / P(far, 100, 0.5, k);
  ok(rk(5) > rk(80), 'a larger k softens the near/far contrast');

  console.log('• the parity floor — the law ships OFF');
  ok(E.distanceGravityEnabled() === false, 'distance_gravity is OFF by default (the parity floor)');

  console.log('• wiring — ON, the binder consults token distance (the steward over-stall flips)');
  const stewardPath = path.join(__dirname, '..', 'evo', 'fixtures', 'binding', 'steward.txt');
  const steward = fs.readFileSync(stewardPath, 'utf8');
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const grainLine = 'then tell them the grain is theirs';
  async function sheStallsAtGrain(on) {
    // deriveSets re-applies window.EO_RULES on each parse; set it the way the app does.
    W.EO_RULES = [{ id: 'distance-gravity', installed: true, enabled: true, value: on ? 1 : 0 }];
    E.applyRules(W.EO_RULES);
    const doc = await E.parseDocument('steward.txt', steward, 'narrative');
    const idx = (doc.sentenceTexts || []).findIndex((t) => norm(t).includes(grainLine));
    return (doc._events || []).some((e) => e.op === 'NUL' && /pronoun-stall/.test(e.reason || '')
      && e.sentence_idx === idx && norm(e.surface) === 'she');
  }
  const offStall = await sheStallsAtGrain(false);
  const onStall = await sheStallsAtGrain(true);
  ok(offStall === true, 'OFF (geometric clock): the δ gate over-stalls "she" at the grain line');
  ok(onStall === false, 'ON (distance law): recency lets "she" clear the gate and bind');
  ok(E.distanceGravityEnabled() === true, 'the rule reads ON after window.EO_RULES is set');
  // restore the floor for any later loader reuse
  W.EO_RULES = [{ id: 'distance-gravity', installed: true, enabled: true, value: 0 }];
  E.applyRules(W.EO_RULES);

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
