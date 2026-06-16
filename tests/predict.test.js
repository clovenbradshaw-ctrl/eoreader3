/* Unit tests for the predictive fold (predict.js): the forward expectation, the
   fused surprise timeline (Tier 0 mechanical + the embedding semantic channel,
   each z-scored above a local baseline), the site kinds read off the event log,
   and the summary. Pure functions — no embedder, no DOM.

   These cover the spec's Tier-0 acceptance: structural surprise spikes with NO
   probe (test 2), and the mechanical floor is style-blind by construction
   (test 3's Tier-0 half). Test 1 (a non-structural surprise the floor misses)
   is the LM probe's reason to exist and is deferred with it.
   Run with `node tests/predict.test.js`. */
'use strict';
const P = require('../predict.js');

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } };
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-3 : e);
const v = (...xs) => Float32Array.from(xs);

// A document of `n` calm sentences (one INS each), optionally with a structural
// surprise at `spikeAt`: extra fresh names + a contested pronoun stall.
function calmDoc(n, spikeAt) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({ op: 'INS', sentence_idx: i, target: 'e' + i, observed: { mass: 1, momentum: 1 } });
    if (i === spikeAt) {
      events.push({ op: 'INS', sentence_idx: i, target: 'x' + i });
      events.push({ op: 'INS', sentence_idx: i, target: 'y' + i });
      events.push({ op: 'NUL', reason: 'pronoun-stall:contested', sentence_idx: i, observed: { competing: [{}, {}] } });
    }
  }
  return { kind: 'prose', _events: events, sentenceTexts: Array.from({ length: n }, (_, i) => 'sentence ' + i + '.') };
}

// ── expectation: recency-weighted, re-normalized to the unit sphere ─────────
ok(P.expectation([v(1, 0)], 0) === null, 'no expectation at the opening span');
{
  const exp = P.expectation([v(1, 0), v(1, 0), v(1, 0)], 3);
  ok(exp && near(exp[0], 1) && near(exp[1], 0), 'expectation of a steady run points the same way (unit)');
  ok(near(Math.hypot(exp[0], exp[1]), 1), 'expectation is unit-normalized');
}

// ── embedding channel: raw delta + per-span embSign ─────────────────────────
{
  const embs = [v(1, 0), v(1, 0), v(1, 0), v(1, 0), v(-1, 0)];
  const tl = P.buildTimeline({ _events: [] }, embs);
  ok(tl.length === 5, 'one record per span');
  ok(tl[0].coefficient === null && tl[0].embSign === null, 'opening span has no embedding delta');
  ok(tl[1].embSign === 'coherence' && near(tl[1].coefficient, 1), 'a confirmed span reads coherence (coeff≈1)');
  ok(tl[4].embSign === 'rupture' && tl[4].coefficient < 0, 'a flipped span reads rupture (coeff<0)');
  ok(near(tl[4].magnitude, 2, 0.01), 'a full reversal has magnitude≈2');
  ok(tl[4].directionGated === true, 'a big miss clears the direction gate');
}
{
  const a = v(1, 0), b = v(Math.cos(0.15), Math.sin(0.15));
  const tl = P.buildTimeline({ _events: [] }, [a, a, b]);
  ok(tl[2].magnitude < P.GATE_FLOOR, 'a near-miss stays below the gate magnitude');
  ok(tl[2].directionGated === false, 'a near-miss is not admitted to the direction index');
}

// ── Tier 0: structural surprise spikes WITHOUT a probe (spec test 2) ────────
{
  const n = 40, at = 20;
  const tl = P.buildTimeline(calmDoc(n, at), null, { n });   // no embeddings at all
  ok(tl.length === n, 'mechanical timeline runs with no embedder');
  ok(tl[at].emb === null, 'no semantic channel without embeddings');
  ok(tl[at].struct === true && tl[at].sign === 'rupture', 'the structural surprise spikes on Tier 0 alone');
  ok(tl[at].components.nul === 1 && tl[at].components.ins === 3, 'the spike carries its component breakdown (glass box)');
  ok(tl[5].sign === 'coherence' && tl[12].sign === 'coherence', 'calm sentences do not spike');
  const s = P.summarize(tl);
  ok(s.ruptures >= 1 && s.structuralRuptures >= 1, 'summary counts the structural rupture');
  ok(s.peak && s.peak.i === at, 'summary points at the most surprising span');
  ok(s.measured === n, 'every span is measured (mechanical floor is always on)');
}

// ── Tier 0 is style-blind: identical structure ⇒ identical surprise ─────────
{
  const a = calmDoc(30, 15);
  const b = calmDoc(30, 15);
  b.sentenceTexts = b.sentenceTexts.map(t => 'A FLORIDE, ARCHAICAL RENDERING of ' + t);  // different prose, same events
  const ra = P.mechanicalRaw(a, 30).raw, rb = P.mechanicalRaw(b, 30).raw;
  ok(JSON.stringify(ra) === JSON.stringify(rb), 'mechanical surprise ignores diction — structure alone drives it');
}

// ── rolling local baseline: flat ⇒ no spike; an outlier ⇒ a spike ───────────
{
  const flat = P.rollingZ(new Array(12).fill(1), 30, 8);
  ok(flat.every(z => z === 0), 'a flat series produces no surprise (z=0 everywhere)');
  const arr = new Array(15).fill(1); arr[14] = 9;
  const z = P.rollingZ(arr, 30, 8);
  ok(z[14] >= P.Z_SPIKE, 'an outlier above its neighborhood spikes');
  ok(z[5] === 0, 'a value with too little baseline behind it stays 0');
}

// ── fusion: the semantic channel can spike where structure is flat ──────────
{
  const n = 20;
  const embs = []; for (let i = 0; i < n; i++) embs.push(i === 15 ? v(-1, 0) : v(1, 0));
  const doc = calmDoc(n);                                   // one INS each ⇒ structurally flat
  const tl = P.buildTimeline(doc, embs, { n });
  ok(tl[15].struct === false, 'no structural change at the semantic turn');
  ok(tl[15].semantic === true, 'the semantic channel spikes where the meaning turns');
  ok(tl[15].sign === 'rupture', 'fusion (OR) marks the span surprising on the semantic channel alone');
}

// ── siteKinds: reference vs event boundaries off the event log ──────────────
{
  const doc = {
    _events: [
      { op: 'SIG', speaker: 'Alice', sentence_idx: 1 },
      { op: 'SIG', speaker: 'Bob', sentence_idx: 2 },
      { op: 'NUL', reason: 'pronoun-stall:below-floor', sentence_idx: 3 },
      { op: 'NUL', reason: 'signal-birth', sentence_idx: 6 },
    ],
    _sections: [{ start_sentence: 5, label: 'II' }],
  };
  const sk = P.siteKinds(doc);
  ok(sk.get(2) === P.SiteKind.EventBoundary, 'a speaker change is an event boundary');
  ok(sk.get(3) === P.SiteKind.ReferenceBoundary, 'a pronoun stall is a reference boundary');
  ok(sk.get(6) === P.SiteKind.ReferenceBoundary, 'a freshly-opened signal is a reference boundary');
  ok(sk.get(5) === P.SiteKind.EventBoundary, 'a section break is an event boundary');
  ok(!sk.has(1), 'the first speaker, with nothing before it, is not a boundary');
}

console.log(`\npredict: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
