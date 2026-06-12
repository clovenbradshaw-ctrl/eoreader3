/* ============================================================
   read — does the conversation field carry the entry node the
   walk throws away?  Gates: conversation-carried entry seeding in
   traverseGraph (the field as a prior on where the walk starts).

   traverseGraph picks its entry nodes from namedEntitiesIn — the
   entities the CURRENT question names — and never consults the
   conversation field. The claim under test: on anaphoric follow-ups
   ("what about his role"), the question string carries no anchor but
   the field already holds it hot, so the activation the walk needs is
   already computed and sitting unused.

   For each turn of an anchor-annotated conversation (the analyst marks
   which on-page referent the turn turns on; the annotation scores the
   engine, it is never fed to it), the simulation runs exactly the
   app's turn order — decay, walk, answer mechanically, deposit matter
   entities + answer cites at weight 1 — and records, at walk time:

     • named      — the anchor is among the walk's entry nodes
     • hot        — the anchor sits in the field at ≥ the dial's heat
                    floor (thinkingBudget(3).wmHeatFloor = 0.25) and
                    resolves onto this document's graph
     • top-1/2    — the anchor's rank among the hot resolvable
                    entities, heaviest first (the seed the wired walk
                    would actually take)
     • walk-null  — the shipped walk returned null (no entry at all)

   The bar, declared before the run:
     carry     ≥ 60% — of anchor-bearing turns whose question does NOT
                       name the anchor, the anchor is hot at the floor
                       (the field holds what the walk discards)
     precision ≥ 80% — of those same turns where ANY entity is hot,
                       the anchor sits in the top 2 by heat (seeding
                       rarely starts a wrong walk)
   Both pass → build entry seeding (top-2 hot at the budget's
   wmHeatFloor, so the dial's floor stays byte-inert). Either fails →
   the field is not a usable prior on the walk; not built.

   Read-only over the shipped engine; no embedder; deterministic.
   Run:  node tools/predictive/read-conv-entry.js
   ============================================================ */
'use strict';
const path = require('path');
const { loadEngine } = require(path.join(__dirname, '..', '..', 'tests', 'harness.js'));
const FIX = require('./fixtures');

const HOPS = 2;              // shipped ceiling: thinkingBudget(3).graphHops
const WM_HEAT_FLOOR = 0.25;  // thinkingBudget(3).wmHeatFloor — the dial's ceiling
const TOP_SEED = 2;          // entry seeds the wired walk would take

// same name normalization read1 uses to compare field labels to entity names
const norm = (s) => String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const nameMatches = (a, b) => {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = na.split(' '), sb = new Set(nb.split(' '));
  return sa.length <= nb.split(' ').length ? sa.every(w => sb.has(w)) : nb.split(' ').every(w => new Set(sa).has(w));
};

let buildFails = 0;
function buildCheck(cond, msg) { if (!cond) { buildFails++; console.error('  BUILD-CHECK FAIL: ' + msg); } }

async function main() {
  const E = loadEngine().EOEngine;
  console.log('read-conv-entry — is the walk\'s missing entry already hot in the conversation field?');
  console.log(`hops = ${HOPS}, heat floor = ${WM_HEAT_FLOOR} (thinkingBudget(3): graphHops ${E.thinkingBudget(3).graphHops}, wmHeatFloor ${E.thinkingBudget(3).wmHeatFloor})\n`);

  const docs = new Map();
  for (const spec of FIX.anchorDocuments()) {
    const doc = await E.parseDocument(spec.name, spec.text, spec.id);
    docs.set(spec.id, { doc, entities: E.projectEntities(doc).entities || [] });
  }
  // every annotated anchor must project as a graph node, or the row is unmeasurable
  for (const conv of FIX.anchorConversations()) {
    const { entities } = docs.get(conv.docId);
    for (const turn of conv.turns) {
      for (const a of (turn.anchor == null ? [] : [].concat(turn.anchor)))
        buildCheck(entities.some(e => nameMatches(a, e.name)),
          `anchor '${a}' (${conv.docId}: "${turn.q}") projects no entity`);
    }
  }

  const rows = [];
  for (const conv of FIX.anchorConversations()) {
    const { doc, entities } = docs.get(conv.docId);
    E.conversationField.reset();
    for (const turn of conv.turns) {
      E.conversationField.decayTurn();
      // — what the walk would see at traverse time: post-decay, pre-deposit —
      const snap = E.conversationField.snapshot();
      const hotResolved = [];
      for (const he of (snap.entities || [])) {       // snapshot is heaviest-first
        if (he.heat < WM_HEAT_FLOOR) continue;
        const ent = entities.find(e => nameMatches(he.label || he.key, e.name));
        if (ent && !hotResolved.some(h => h.name === ent.name)) hotResolved.push({ name: ent.name, heat: he.heat });
      }
      let trav = null;
      try { trav = E.traverseGraph(doc, turn.q, HOPS); } catch (e) {}
      const anchors = turn.anchor == null ? [] : [].concat(turn.anchor);
      const row = {
        docId: conv.docId, q: turn.q, continues: !!turn.continues,
        anchored: anchors.length > 0,
        walkNull: !trav,
        entries: trav ? trav.entries : [],
        hot: hotResolved.map(h => `${h.name}@${h.heat.toFixed(2)}`),
      };
      if (anchors.length) {
        row.named = !!(trav && trav.entries.some(n => anchors.some(a => nameMatches(a, n))));
        const rank = hotResolved.findIndex(h => anchors.some(a => nameMatches(a, h.name)));
        row.anchorHot = rank >= 0;
        row.anchorTop1 = rank === 0;
        row.anchorTopSeed = rank >= 0 && rank < TOP_SEED;
        row.anyHot = hotResolved.length > 0;
      }
      rows.push(row);
      // — answer mechanically and deposit, as a settled turn would —
      let ans = null;
      try { ans = E.answer(doc, turn.q); } catch (e) { ans = null; }
      let matter = [];
      try { matter = (E.referentsScope([doc], turn.q) || {}).matter || []; } catch (e) {}
      E.conversationField.deposit({ entities: matter, sentences: ((ans && ans.cites) || []).map(c => ({ docId: doc.id, idx: c.idx })) }, 1);
    }
  }

  /* ---------- per-turn table ---------- */
  console.log('per-turn (anchor-bearing turns; ✓named = the question itself hands the walk the anchor):');
  console.log('  turn                                                  named  hot   top1  top2  walk     field (hot, heaviest first)');
  for (const r of rows.filter(r => r.anchored)) {
    const id = `${r.docId}: ${r.q}`;
    const f = (b) => (b ? '✓' : '·').padEnd(5);
    console.log(`  ${id.padEnd(54)}${f(r.named)} ${f(r.anchorHot)} ${f(r.anchorTop1)} ${f(r.anchorTopSeed)} ${(r.walkNull ? 'NULL' : 'ran').padEnd(7)}  ${r.hot.join(', ') || '—'}`);
  }

  /* ---------- aggregates ---------- */
  const A = rows.filter(r => r.anchored && r.named);
  const B = rows.filter(r => r.anchored && !r.named);
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
  const bHot = B.filter(r => r.anchorHot);
  const bAnyHot = B.filter(r => r.anyHot);
  const bSeedRight = bAnyHot.filter(r => r.anchorTopSeed);
  console.log('\naggregates:');
  console.log(`  anchor-bearing turns: ${A.length + B.length}  (anchor named in the question: ${A.length};  not named: ${B.length})`);
  console.log(`  of the ${B.length} unnamed-anchor turns:`);
  console.log(`    walk NULL (no entry at all):        ${B.filter(r => r.walkNull).length}  (${pct(B.filter(r => r.walkNull).length, B.length)})`);
  console.log(`    walk ran from a non-anchor entry:   ${B.filter(r => !r.walkNull).length}  (${pct(B.filter(r => !r.walkNull).length, B.length)})`);
  console.log(`    anchor HOT at the floor (carry):    ${bHot.length}  (${pct(bHot.length, B.length)})`);
  console.log(`    anchor top-1 by heat:               ${B.filter(r => r.anchorTop1).length}  (${pct(B.filter(r => r.anchorTop1).length, B.length)})`);
  console.log(`    anchor in top-${TOP_SEED} (precision):        ${bSeedRight.length}/${bAnyHot.length} of turns with any heat  (${pct(bSeedRight.length, bAnyHot.length)})`);
  const recovered = B.filter(r => r.walkNull && r.anchorTopSeed).length;
  console.log(`    walk-NULL turns a top-${TOP_SEED} seed recovers: ${recovered}/${B.filter(r => r.walkNull).length}`);

  /* ---------- the bar ---------- */
  const carry = B.length ? bHot.length / B.length : 0;
  const precision = bAnyHot.length ? bSeedRight.length / bAnyHot.length : 0;
  const carryOK = carry >= 0.60, precOK = precision >= 0.80;
  console.log('\nthe bar (declared in the header before the run):');
  console.log(`  carry     ${pct(bHot.length, B.length)} (needs ≥60%)  → ${carryOK ? 'PASS' : 'FAIL'}`);
  console.log(`  precision ${pct(bSeedRight.length, bAnyHot.length)} (needs ≥80%)  → ${precOK ? 'PASS' : 'FAIL'}`);
  console.log(carryOK && precOK
    ? '  verdict: the field carries the anchor the walk throws away — entry seeding is sound to build.'
    : '  verdict: the field is not a usable prior on the walk\'s entries — not built.');

  console.log(`\nchecks: ${buildFails} build-check failures, ${rows.length} turns`);
  if (buildFails) process.exitCode = 1;
  return { rows, carry, precision, carryOK, precOK };
}

module.exports = { run: main };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
