/* ============================================================
   read 2 — trajectory predictability of the next span.
   Gates mechanisms B (rank by surprise) and C (heat as prediction
   error); E rides the same answer.

   Maintain a predicted next-span centroid as the region's centroid
   trajectory — the γ-decayed running centroid of the last few spans,
   using the medium's own γ = 0.7 — and measure how well it predicts
   the actual next span, separately on narrative, essay/argument, and
   journalism.

   Three baselines make "predicts" mean something:
     gravity      cos(actual, whole-document centroid) — a predictor
                  that just says "this document"
     persistence  cos(actual, previous sentence)
     rank         where the actual next sentence falls when ALL
                  sentences are ranked by closeness to the prediction
                  (the candidate-ranking move mechanism B would make)

   The spec's worry, measured directly: argument moves discontinuously
   and the jumps are structure, not error — so the trajectory score is
   split at paragraph boundaries. If cross-boundary cosine collapses on
   argument, ranking by deviation flags every normal break as surprise.

   Read-only. No engine path is touched; this is geometry over the
   shipped reader's sentence stream.
   ============================================================ */
'use strict';
const path = require('path');
const { loadEngine } = require(path.join(__dirname, '..', '..', 'tests', 'harness.js'));
const emb = require('./embed-node');
const FIX = require('./fixtures');

const GAMMA = 0.7;   // the medium's decay, reused as the trajectory's
const WINDOW = 4;    // how many prior spans the centroid carries

function predictedAt(vecs, i) {
  // γ-weighted centroid of the last WINDOW sentences, newest heaviest.
  const dim = vecs[0].length;
  const v = new Float64Array(dim);
  let used = 0;
  for (let k = 1; k <= WINDOW && i - k >= 0; k++) {
    const w = Math.pow(GAMMA, k - 1);
    const r = vecs[i - k];
    for (let d = 0; d < dim; d++) v[d] += w * r[d];
    used++;
  }
  if (!used) return null;
  let n = 0; for (let d = 0; d < dim; d++) n += v[d] * v[d];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(dim);
  for (let d = 0; d < dim; d++) out[d] = v[d] / n;
  return out;
}

function centroidOf(vecs) {
  const dim = vecs[0].length;
  const v = new Float64Array(dim);
  for (const r of vecs) for (let d = 0; d < dim; d++) v[d] += r[d];
  let n = 0; for (let d = 0; d < dim; d++) n += v[d] * v[d];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(dim);
  for (let d = 0; d < dim; d++) out[d] = v[d] / n;
  return out;
}

/* Mark which kept sentences open a paragraph: walk the raw text with a
   cursor; a sentence whose preceding gap holds a blank line is a
   paragraph opener. Best-effort (a sentence the cursor can't find keeps
   the previous flag state as 'unknown' and is excluded from the split). */
function paragraphStarts(rawText, sentences) {
  const flags = new Array(sentences.length).fill(null);
  let cursor = 0;
  let lastEnd = 0;
  for (let i = 0; i < sentences.length; i++) {
    const probe = String(sentences[i] || '').slice(0, 48).trim();
    if (!probe) continue;
    const at = rawText.indexOf(probe, cursor);
    if (at < 0) continue;
    const gap = rawText.slice(lastEnd, at);
    flags[i] = /\n\s*\n/.test(gap);
    lastEnd = at + probe.length;
    cursor = at + probe.length;
  }
  return flags;
}

async function main() {
  await emb.init();
  const E = loadEngine().EOEngine;

  const perDoc = [];
  for (const spec of FIX.documents()) {
    const doc = await E.parseDocument(spec.name, spec.text, spec.id);
    const chrome = new Set(doc._chrome || []);
    const keptIdx = [];
    const kept = [];
    (doc.sentenceTexts || []).forEach((t, i) => { if (!chrome.has(i) && t && t.trim()) { keptIdx.push(i); kept.push(t); } });
    if (kept.length < WINDOW + 4) { perDoc.push({ id: spec.id, genre: spec.genre, skipped: 'too short', sents: kept.length }); continue; }
    const vecs = await emb.embedSentences(kept);
    const global = centroidOf(vecs);
    const paraFlag = paragraphStarts(spec.text, kept);

    const spans = [];
    for (let i = WINDOW; i < vecs.length; i++) {
      const pred = predictedAt(vecs, i);
      if (!pred) continue;
      const cosT = emb.cos(pred, vecs[i]);
      const cosG = emb.cos(global, vecs[i]);
      const cosP = emb.cos(vecs[i - 1], vecs[i]);
      // rank: where does the ACTUAL next sentence fall among all candidates
      // outside the window, ranked by closeness to the prediction?
      let better = 0, total = 0;
      for (let j = 0; j < vecs.length; j++) {
        if (j >= i - WINDOW && j < i) continue;   // the window itself is not a candidate
        total++;
        if (j !== i && emb.cos(pred, vecs[j]) > cosT) better++;
      }
      spans.push({ i, cosT, cosG, cosP, beats: cosT > cosG, rankPct: total > 1 ? better / (total - 1) : 0, para: paraFlag[i] });
    }
    perDoc.push({ id: spec.id, genre: spec.genre, sents: kept.length, spans });
  }

  // ---- aggregate by genre ----
  const groups = new Map();
  const agg = (k) => { if (!groups.has(k)) groups.set(k, []); return groups.get(k); };
  for (const d of perDoc) if (d.spans) { agg(d.genre).push(...d.spans); agg('ALL').push(...d.spans); }
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const f = (x) => isNaN(x) ? '—' : x.toFixed(3);
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';

  const table = [...groups.entries()].map(([genre, spans]) => {
    const within = spans.filter(s => s.para === false);
    const breaks = spans.filter(s => s.para === true);
    return {
      genre, spans: spans.length,
      'cos traj': f(mean(spans.map(s => s.cosT))),
      'cos gravity': f(mean(spans.map(s => s.cosG))),
      'cos prev': f(mean(spans.map(s => s.cosP))),
      'beats gravity': pct(spans.filter(s => s.beats).length, spans.length),
      'median rank': isNaN(median(spans.map(s => s.rankPct))) ? '—' : Math.round(100 * median(spans.map(s => s.rankPct))) + '%',
      'top-10% rank': pct(spans.filter(s => s.rankPct <= 0.10).length, spans.length),
      'traj within-para': f(mean(within.map(s => s.cosT))),
      'traj at-break': f(mean(breaks.map(s => s.cosT))),
      'breaks judged': breaks.length + '/' + (within.length + breaks.length),
    };
  });
  const docRows = perDoc.map(d => d.spans ? ({
    doc: d.id, genre: d.genre, spans: d.spans.length,
    'cos traj': f(mean(d.spans.map(s => s.cosT))),
    'beats gravity': pct(d.spans.filter(s => s.beats).length, d.spans.length),
    'median rank': Math.round(100 * median(d.spans.map(s => s.rankPct))) + '%',
  }) : ({ doc: d.id, genre: d.genre, spans: 0, 'cos traj': d.skipped, 'beats gravity': '—', 'median rank': '—' }));
  return { table, docRows };
}

module.exports = { run: main };
if (require.main === module) main().then(r => { console.table(r.docRows); console.table(r.table); }).catch(e => { console.error(e); process.exit(1); });
