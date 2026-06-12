/* ============================================================
   read 1 — prediction-accuracy of the top-down guess.
   Gates mechanism A (SEM_FLOOR as a precision parameter).

   For each turn of a scripted conversation, form the top-down
   prediction of where the answer sits BEFORE paying for cosine, from
   exactly the ingredients mechanism A would use:

     • the figure-graph footprint of the entities the turn names
       (projectEntities sents, closed over the heavy figures the way
       impressionQuery closes its region),
     • conversationField heat (hot entities' footprints + the warmed
       sentences ±1, at the budget's wmHeatFloor),
     • continuesPrior-style continuity (an anaphoric follow-up with no
       new off-page subject carries the prior turn's region forward).

   Then pay for the embedder once and ask where IT thinks the answer
   sits (top-k cosine ≥ SEM_FLOOR over non-chrome sentences). The
   embedder CONFIRMS the guess when its top hit lands inside the
   predicted region; VIOLATES it when none of its top-3 do.

   Read-only: the engine is exercised exactly as shipped; nothing is
   patched and no output changes. The verdict is a table.
   ============================================================ */
'use strict';
const path = require('path');
const { loadEngine } = require(path.join(__dirname, '..', '..', 'tests', 'harness.js'));
const emb = require('./embed-node');
const FIX = require('./fixtures');

const SEM_FLOOR = 0.45;      // the engine's own floor (engine.js SEM_FLOOR)
const WM_HEAT_FLOOR = 0.25;  // thinkingBudget(3).wmHeatFloor — the dial's ceiling
const TOPK = 3;
const HEAVY_CLOSE = 4;       // figures the region closes over (impressionQuery's cap)

// the ruliad's anaphor class isn't exported; mirror the common members.
const ANAPHORS = new Set(['he', 'she', 'it', 'they', 'him', 'her', 'them',
  'his', 'hers', 'their', 'theirs', 'its', 'that', 'this', 'these', 'those']);

const norm = (s) => String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const nameMatches = (a, b) => {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = na.split(' '), sb = new Set(nb.split(' '));
  return sa.length <= nb.split(' ').length ? sa.every(w => sb.has(w)) : nb.split(' ').every(w => new Set(sa).has(w));
};

function predictRegion(E, doc, q, state) {
  const region = new Set();
  const ents = state.entCache.get(doc.id);
  // 1) figures the turn names → their whole footprint
  let matter = [];
  try { matter = (E.referentsScope([doc], q) || {}).matter || []; } catch (e) {}
  for (const name of matter)
    for (const e of ents)
      if (nameMatches(name, e.name)) for (const i of (e.sents || [])) region.add(i);
  // 2) conversation heat: hot entities' footprints + warmed sentences ±1
  const snap = E.conversationField.snapshot();
  for (const he of (snap.entities || [])) {
    if (he.heat < WM_HEAT_FLOOR) continue;
    for (const e of ents)
      if (nameMatches(he.label || he.key, e.name)) for (const i of (e.sents || [])) region.add(i);
  }
  for (const hs of (snap.sentences || [])) {
    if (hs.heat < WM_HEAT_FLOOR || hs.docId !== doc.id) continue;
    for (const d of [-1, 0, 1]) { const i = hs.idx + d; if (i >= 0 && i < doc.sentenceTexts.length) region.add(i); }
  }
  // 3) continuity: an anaphoric turn naming nothing new carries the prior region
  const toks = String(q).toLowerCase().match(/[\p{L}]+/gu) || [];
  const anaphoric = toks.some(t => ANAPHORS.has(t));
  let antimatter = [];
  try { antimatter = (E.referentsScope([doc], q) || {}).antimatter || []; } catch (e) {}
  if (state.prevGrounded && anaphoric && !antimatter.length)
    for (const i of state.prevRegion) region.add(i);
  // 4) close over the heavy figures the region touches (impressionQuery's move)
  const heavy = [...ents].sort((a, b) => (b.mass || 0) - (a.mass || 0)).slice(0, HEAVY_CLOSE);
  for (const e of heavy)
    if ((e.sents || []).some(i => region.has(i)))
      for (const i of e.sents) region.add(i);
  return region;
}

async function main() {
  await emb.init();
  const W = loadEngine();
  const E = W.EOEngine;
  W.EOEmbed = emb.asEOEmbed();   // resident, exactly as a warmed browser session

  const docs = new Map();
  const vecs = new Map();
  const entCache = new Map();
  const wanted = new Set(FIX.conversations().map(c => c.docId));
  for (const spec of FIX.documents()) {
    if (!wanted.has(spec.id)) continue;
    const doc = await E.parseDocument(spec.name, spec.text, spec.id);
    docs.set(spec.id, { doc, genre: spec.genre });
    vecs.set(spec.id, await emb.embedSentences(doc.sentenceTexts || []));
    entCache.set(spec.id, (E.projectEntities(doc).entities || []));
  }

  const turnsOut = [];
  for (const conv of FIX.conversations()) {
    const { doc, genre } = docs.get(conv.docId);
    const dv = vecs.get(conv.docId);
    const chrome = new Set(doc._chrome || []);
    const n = (doc.sentenceTexts || []).length;
    E.conversationField.reset();
    const state = { entCache, prevGrounded: false, prevRegion: new Set() };

    for (const turn of conv.turns) {
      E.conversationField.decayTurn();
      // — the top-down guess, BEFORE any embedding —
      const region = predictRegion(E, doc, turn.q, state);
      // — the embedder's verdict —
      const qv = await emb.embedQuery(turn.q);
      const scored = [];
      for (let i = 0; i < dv.length; i++) {
        if (chrome.has(i)) continue;
        const s = emb.cos(qv, dv[i]);
        if (s >= SEM_FLOOR) scored.push({ i, s });
      }
      scored.sort((a, b) => b.s - a.s);
      const top = scored.slice(0, TOPK);
      const guessed = region.size > 0;
      const abstained = top.length === 0;
      const hit1 = guessed && !abstained && region.has(top[0].i);
      const hit3 = guessed && !abstained && top.some(h => region.has(h.i));
      turnsOut.push({
        docId: conv.docId, genre, q: turn.q,
        guessed, abstained,
        hit1, hit3,
        regionFrac: n ? region.size / n : 0,
        regionSize: region.size, nSents: n,
        top: top.map(h => ({ i: h.i, s: +h.s.toFixed(4) })),
      });
      // — answer mechanically and deposit, as a settled turn would —
      let ans = null;
      try { ans = E.answer(doc, turn.q); } catch (e) { ans = null; }
      const cites = (ans && ans.cites) || [];
      let matter = [];
      try { matter = (E.referentsScope([doc], turn.q) || {}).matter || []; } catch (e) {}
      E.conversationField.deposit({ entities: matter, sentences: cites.map(c => ({ docId: doc.id, idx: c.idx })) }, 1);
      state.prevGrounded = !!(ans && ans.audit && ans.audit.grounded !== false);
      state.prevRegion = region;
    }
  }

  // ---- aggregate ----
  const rows = new Map();
  const agg = (key) => {
    if (!rows.has(key)) rows.set(key, { turns: 0, guessed: 0, abstained: 0, judged: 0, hit1: 0, hit3: 0, fracSum: 0 });
    return rows.get(key);
  };
  for (const t of turnsOut) {
    for (const key of [t.genre, 'ALL']) {
      const r = agg(key);
      r.turns++;
      if (t.guessed) { r.guessed++; r.fracSum += t.regionFrac; }
      if (t.abstained) r.abstained++;
      if (t.guessed && !t.abstained) {
        r.judged++;
        if (t.hit1) r.hit1++;
        if (t.hit3) r.hit3++;
      }
    }
  }
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
  const table = [...rows.entries()].map(([key, r]) => ({
    corpus: key, turns: r.turns,
    guessed: pct(r.guessed, r.turns),
    'region size': r.guessed ? pct(r.fracSum / r.guessed, 1) : '—',
    'embed abstained': pct(r.abstained, r.turns),
    judged: r.judged,
    'confirm@1': pct(r.hit1, r.judged),
    'confirm@3': pct(r.hit3, r.judged),
    'violate@3': pct(r.judged - r.hit3, r.judged),
    'lift@1': (r.judged && r.fracSum / Math.max(1, r.guessed) > 0)
      ? ((r.hit1 / r.judged) / (r.fracSum / r.guessed)).toFixed(1) + 'x' : '—',
  }));
  return { turns: turnsOut, table };
}

module.exports = { run: main };
if (require.main === module) main().then(r => {
  console.table(r.table);
  console.log(JSON.stringify(r.turns, null, 1));
}).catch(e => { console.error(e); process.exit(1); });
