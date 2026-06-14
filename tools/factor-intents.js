/* ============================================================
   tools/factor-intents.js — Phase 2 of Brief 3: FACTOR the voice-intent space.

       node tools/factor-intents.js            # factor exemplars.jsonl
       node tools/factor-intents.js --k=8       # number of PCA components
       node tools/factor-intents.js --ends=6    # exemplars to print per pole

   The enrichment (Phase 1) widened every thin intent to the stability floor so
   the centroids sit in the real range. THIS reads the axes back out, the way
   the brief asks: run shape.js's pca() (power iteration + deflation) over the
   embedded responses, name the poles where the structure is clear, and produce
   the SEPARABILITY evidence Phase 3 needs before any merge / split / cut.

   It prints, never decides:
     • per-intent centroids and the pairwise cosine MATRIX — the closest pairs
       are merge candidates (two names, one region), the confidence pair
       (hedge-uncertain vs commit-opinion) is reported explicitly because
       Brief 2 evicts confidence to the stamp;
     • global PCA — explained variance per component and the exemplars at each
       pole, so an axis can be hand-labeled (register short↔long, hedged↔
       committed, lookup↔synthesis, stance toward the source);
     • a per-intent SPREAD / bimodality read — an intent whose own cloud splits
       in two is a split candidate (one label on two moves).

   The embeddings are computed at run, never stored — exactly as the app does
   it. This needs the resident MiniLM; in Node that is the vendored model under
   .models/ (run `node tools/predictive/fetch-model.js` once, needs network).
   With no model it ABSTAINS with instructions rather than inventing a factoring
   — PCA on a space you couldn't embed is noise wearing the shape of an answer.

   NOTHING here writes to exemplars.jsonl or to any prompt. The centroid and the
   axes stay a MEASURE: this tool reports them for a human to read and decide on,
   and the hard rule stands — no centroid-derived feature list ever reaches the
   talker's prompt before it writes.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const K = parseInt((ARGV.find(a => a.startsWith('--k=')) || '').split('=')[1] || '8', 10);
const ENDS = parseInt((ARGV.find(a => a.startsWith('--ends=')) || '').split('=')[1] || '5', 10);

// shape.js is a browser IIFE; load it in a vm and read window.EOShape back out
// (the same trick tests/shape.test.js uses), so we score with the SAME pca /
// cosine / centroid the runtime uses.
function loadShape() {
  const sandbox = { window: {}, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shape.js'), 'utf8'), sandbox, { filename: 'shape.js' });
  return sandbox.window.EOShape;
}

function fmt(x, n) { return (x >= 0 ? ' ' : '') + x.toFixed(n == null ? 3 : n); }

async function main() {
  const S = loadShape();
  if (!S) { console.error('shape.js did not publish EOShape'); process.exit(1); }

  const text = fs.readFileSync(path.join(ROOT, 'exemplars.jsonl'), 'utf8');
  const ex = S.parseExemplars(text);
  const intents = [...new Set(ex.map(e => e.intent))].sort();
  console.log(`${ex.length} exemplars · ${intents.length} intents\n`);

  // --- embed, or abstain -------------------------------------------------
  let embed;
  try {
    const E = require('./predictive/embed-node.js');
    // a probe forces model init; the shim returns null (not a throw) when the
    // model isn't vendored, so treat a falsy vector as "no embedder" too.
    const probe = await E.embedQuery('probe');
    if (!probe || !probe.length) throw new Error('embedder returned no vector (MiniLM not vendored)');
    embed = (texts) => E.embedSentences(texts);
  } catch (e) {
    console.error('ABSTAIN — no embedder available (' + e.message + ').');
    console.error('PCA needs the real embedding space; on Node that is the vendored MiniLM.');
    console.error('Run `node tools/predictive/fetch-model.js` once (needs network), then re-run.');
    console.error('\nWithout it, factoring would be noise wearing the shape of an answer — so this');
    console.error('tool stops here rather than invent axes. Phase 1 (enrichment) is unaffected.');
    process.exit(2);
  }

  console.log('embedding ' + ex.length + ' responses (computed at run, never stored)…');
  const vecs = await embed(ex.map(e => e.response));
  ex.forEach((e, i) => { e.responseVec = vecs[i]; });

  // --- per-intent centroids + pairwise separation matrix -----------------
  const cents = {};
  for (const it of intents) {
    const rows = ex.filter(e => e.intent === it).map(e => e.responseVec);
    cents[it] = S.centroid(rows);
  }
  const pairs = [];
  for (let i = 0; i < intents.length; i++)
    for (let j = i + 1; j < intents.length; j++) {
      const a = intents[i], b = intents[j];
      pairs.push({ a, b, sim: S.cosine(cents[a], cents[b]) });
    }
  pairs.sort((p, q) => q.sim - p.sim);

  console.log('\n=== closest intent centroids (merge candidates: two names, one region) ===');
  for (const p of pairs.slice(0, 12)) console.log('  ' + fmt(p.sim) + '   ' + p.a + '  ~  ' + p.b);

  console.log('\n=== the confidence pair (Brief 2 evicts confidence to the stamp) ===');
  const conf = pairs.find(p =>
    (p.a === 'hedge-uncertain' && p.b === 'commit-opinion') ||
    (p.b === 'hedge-uncertain' && p.a === 'commit-opinion'));
  if (conf) {
    const rank = pairs.indexOf(conf) + 1;
    console.log('  hedge-uncertain ~ commit-opinion: cos ' + fmt(conf.sim)
      + '   (rank ' + rank + ' of ' + pairs.length + ' pairs by closeness)');
    console.log('  → if this pair separates along no axis but the confidence one, it is one');
    console.log('    thing, and confidence rides the stamp — a candidate to evict, not keep.');
  }

  // --- global PCA: explained variance + exemplars at each pole -----------
  console.log('\n=== global PCA over the whole space (name the poles where clear) ===');
  const { components, explained } = S.pca(vecs, K);
  const totalVar = explained.reduce((a, b) => a + b, 0) || 1;
  components.forEach((c, ci) => {
    const scored = ex.map(e => ({ e, p: S.dot(e.responseVec, c) })).sort((a, b) => a.p - b.p);
    const neg = scored.slice(0, ENDS);
    const pos = scored.slice(-ENDS).reverse();
    const intentTilt = (arr) => {
      const cc = {};
      for (const { e } of arr) cc[e.intent] = (cc[e.intent] || 0) + 1;
      return Object.entries(cc).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '×' + v).join(', ');
    };
    console.log(`\n  PC${ci + 1}  (explains ~${(100 * explained[ci] / totalVar).toFixed(1)}% of captured variance)`);
    console.log('    − pole intents: ' + intentTilt(neg));
    neg.forEach(({ e }) => console.log('        − [' + e.intent + '] ' + e.response.slice(0, 90).replace(/\s+/g, ' ')));
    console.log('    + pole intents: ' + intentTilt(pos));
    pos.forEach(({ e }) => console.log('        + [' + e.intent + '] ' + e.response.slice(0, 90).replace(/\s+/g, ' ')));
  });

  // --- per-intent spread / bimodality (split candidates) -----------------
  console.log('\n=== per-intent spread (high spread + a gap ⇒ split candidate) ===');
  const rows = [];
  for (const it of intents) {
    const es = ex.filter(e => e.intent === it);
    const c = cents[it];
    const sims = es.map(e => S.cosine(e.responseVec, c));
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    const min = Math.min(...sims);
    // 1-D bimodality probe: project onto the intent's own PC1, look for a gap.
    const sub = S.pca(es.map(e => e.responseVec), 1);
    let gap = 0;
    if (sub.components && sub.components[0]) {
      const proj = es.map(e => S.dot(e.responseVec, sub.components[0])).sort((a, b) => a - b);
      for (let i = 1; i < proj.length; i++) gap = Math.max(gap, proj[i] - proj[i - 1]);
    }
    rows.push({ it, n: es.length, cohesion: mean, min, gap });
  }
  rows.sort((a, b) => a.cohesion - b.cohesion);
  console.log('  intent                         n   cohesion   min-sim   max-gap');
  for (const r of rows)
    console.log('  ' + r.it.padEnd(30) + String(r.n).padStart(2)
      + '   ' + fmt(r.cohesion) + '    ' + fmt(r.min) + '   ' + fmt(r.gap));
  console.log('\n  (low cohesion or a large max-gap flags an intent whose cloud may be two moves.)');

  console.log('\nDone. These are MEASURES for a human to read — no axis or centroid is written');
  console.log('to any prompt, and nothing here mutates exemplars.jsonl.');
}

main().catch(e => { console.error(e); process.exit(1); });
