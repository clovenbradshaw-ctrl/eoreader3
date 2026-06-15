/* Unit tests for the predictive fold (predict.js): the forward expectation, the
   span timeline (coefficient / magnitude / sign / direction gate), the site
   kinds read off the event log, and the summary. Pure functions — no embedder,
   no DOM. Run with `node tests/predict.test.js`. */
'use strict';
const P = require('../predict.js');

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } };
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-3 : e);
const v = (...xs) => Float32Array.from(xs);

// ── expectation: recency-weighted, re-normalized to the unit sphere ─────────
ok(P.expectation([v(1, 0)], 0) === null, 'no expectation at the opening span');
{
  const exp = P.expectation([v(1, 0), v(1, 0), v(1, 0)], 3);
  ok(exp && near(exp[0], 1) && near(exp[1], 0), 'expectation of a steady run points the same way (unit)');
  ok(near(Math.hypot(exp[0], exp[1]), 1), 'expectation is unit-normalized');
}

// ── buildTimeline: coherence on a steady run, rupture on a flip ─────────────
{
  const embs = [v(1, 0), v(1, 0), v(1, 0), v(1, 0), v(-1, 0)];
  const tl = P.buildTimeline({ _events: [] }, embs);
  ok(tl.length === 5, 'one record per embedded span');
  ok(tl[0].coefficient === null && tl[0].sign === 'coherence', 'opening span has no coefficient');
  ok(tl[1].sign === 'coherence' && near(tl[1].coefficient, 1), 'a confirmed span is coherence with coeff≈1');
  ok(tl[4].sign === 'rupture' && tl[4].coefficient < 0, 'a flipped span ruptures with negative coeff');
  ok(near(tl[4].magnitude, 2, 0.01), 'a full reversal has magnitude≈2');
  ok(tl[4].directionGated === true, 'a big miss clears the direction gate');
}

// ── gate: a small miss does NOT clear the direction gate ────────────────────
{
  // nearly-aligned vectors → tiny delta, below GATE_FLOOR
  const a = v(1, 0), b = v(Math.cos(0.15), Math.sin(0.15));
  const tl = P.buildTimeline({ _events: [] }, [a, a, b]);
  ok(tl[2].magnitude < P.GATE_FLOOR, 'a near-miss stays below the gate magnitude');
  ok(tl[2].directionGated === false, 'a near-miss is not admitted to the direction index');
}

// ── siteKinds: reference vs event boundaries off the event log ──────────────
{
  const doc = {
    _events: [
      { op: 'SIG', speaker: 'Alice', sentence_idx: 1 },
      { op: 'SIG', speaker: 'Bob', sentence_idx: 2 },     // speaker change → EventBoundary
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

// ── timeline carries the site onto the span record ──────────────────────────
{
  const embs = [v(1, 0), v(0, 1), v(1, 0)];
  const tl = P.buildTimeline({ _events: [{ op: 'NUL', reason: 'pronoun-stall:x', sentence_idx: 2 }] }, embs);
  ok(tl[2].site === P.SiteKind.ReferenceBoundary, 'the site kind rides onto the span record');
}

// ── summarize ───────────────────────────────────────────────────────────────
{
  const embs = [v(1, 0), v(1, 0), v(-1, 0), v(1, 0)];
  const s = P.summarize(P.buildTimeline({ _events: [] }, embs));
  ok(s.measured === 3, 'summary counts only spans that carried an expectation');
  ok(s.ruptures >= 1, 'summary counts the ruptures');
  ok(s.peak && s.peak.i === 2, 'summary points at the most surprising span');
  ok(s.meanCoefficient != null, 'summary reports a mean coefficient');
}

console.log(`\npredict: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
