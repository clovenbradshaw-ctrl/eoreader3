/* ============================================================
   walker-survival.js — measurement harness for the traverseGraph
   survival-vs-document-length hypothesis. READ-ONLY over the engine:
   it loads the shipped engine via tests/harness.js, parses gold
   documents, runs E.traverseGraph(doc, q, 2) (the shipped dial
   ceiling, READING_RULES 'graph-walk-hops' = 2), and REPLICATES the
   walk's BFS + gather step in this file (same projected data the
   engine reads: projectEntities / _projectGraph / assertionsOf /
   kinRecords) to expose what the engine's API does not return:
   per-hop frontier sizes and the pre-cap gather (the sentences
   collected BEFORE `.slice(0, 12)`).

   Replication is validated per triple: the replica's kept-12 indices
   and walked node names must equal the engine's own output exactly.

   Gold triples: (document, question, answer sentence indices).
   - SHORT  (<100 sents):  evo/fixtures/*.txt, questions hand-written
     against the PARSED sentence list; answer indices located post-parse
     by verbatim needle match (never by eyeballing the raw text).
   - MEDIUM (100-400) / LONG (400+): the same fixture payloads embedded
     verbatim into deterministic neutral-narrative padding at controlled
     positions (early 10% / middle 50% / late 90%), with HUB variants:
     a city (Carthage) in ~30% of padding sentences plus connector
     sentences tying the payload's people to it.

   Run:  node tests/walker-survival.js
   Deterministic. Writes nothing. Not wired into package.json.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, ROOT } = require('./harness');

const E = loadEngine().EOEngine;
const HOPS = 2; // shipped ceiling: READING_RULES 'graph-walk-hops' value 2 → thinkingBudget(3).graphHops

/* ---------- deterministic neutral padding (cast disjoint from payloads) ----------
   Two recurring cast members per sentence (a real co-occurrence web, like a
   long document's). With hub set, ~30% of sentences put both people IN the
   hub city, so the hub co-occurs with everyone. */
function makePadding(nParas, hub) {
  const cast = ['Ainsley', 'Barrow', 'Corliss', 'Devereux', 'Ellison', 'Fairweather', 'Galloway', 'Hartley',
                'Jardine', 'Loxley', 'Mercer', 'Norwood', 'Ostrander', 'Pemberton', 'Quill', 'Rutherford'];
  const places = ['the quay', 'the mill road', 'the customs house', 'the north field', 'the chandlery', 'the tide wall'];
  const things = ['the ledgers', 'the ropes', 'the survey poles', 'the carts', 'the lockbox', 'the signal lamps'];
  const verbs = ['checked', 'counted', 'mended', 'argued over', 'carried', 'stacked', 'inspected', 'traded'];
  const advs = ['before dawn', 'after the market closed', 'in the wet season', 'against the schedule', 'without complaint'];
  const paras = []; let k = 0;
  for (let p = 0; p < nParas; p++) {
    const sents = []; const nS = 3 + (p % 4);
    for (let s = 0; s < nS; s++) {
      k++;
      const a = cast[k % cast.length], b = cast[(k * 5 + 3) % cast.length]; // never equal mod 16
      const v = verbs[k % verbs.length], th = things[(k + 2) % things.length];
      const pl = places[(k + 4) % places.length], ad = advs[(k + 1) % advs.length];
      if (hub && (k % 10) < 3) sents.push(`${a} met ${b} in ${hub} ${ad}.`);
      else sents.push(`${a} ${v} ${th} with ${b} near ${pl} ${ad}.`);
    }
    paras.push(sents.join(' '));
  }
  return paras;
}

function fixtureParas(rel) {
  // payload = the fixture's body paragraphs, verbatim, minus its title line
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').trim().split(/\n\n+/).slice(1);
}
function buildPadded(title, nParas, frac, payloadParas, hub, connectors) {
  const body = makePadding(nParas, hub);
  const at = Math.max(0, Math.min(body.length, Math.round(body.length * frac)));
  const payload = connectors ? [...payloadParas, connectors] : payloadParas;
  return title + '\n\n' + [...body.slice(0, at), ...payload, ...body.slice(at)].join('\n\n');
}

/* ---------- the document set ---------- */
const FIX = {
  steward: 'evo/fixtures/binding/steward.txt',
  veranda: 'evo/fixtures/binding/veranda.txt',
  dispatch: 'evo/fixtures/stalls/dispatch.txt',
  darkness: 'evo/fixtures/integration/darkness.txt',
  fieldnotes: 'evo/fixtures/integration/field-notes.txt',
  ledger: 'evo/fixtures/integration/ledger.txt',
  treatise: 'evo/fixtures/integration/treatise.txt',
  rashomon: 'evo/fixtures/integration/rashomon.txt',
};
const HUB = 'Carthage';
const CONN = {
  dispatch: 'Vance had come up to the council from Carthage in the spring. Ruiz still wrote to Carthage for the survey records.',
  steward: 'Dron had walked the road from Carthage twice that winter. Princess Mary kept her letters from Carthage in the storeroom.',
};
function docSpecs() {
  const specs = [];
  for (const key of Object.keys(FIX)) specs.push({ key, text: fs.readFileSync(path.join(ROOT, FIX[key]), 'utf8') });
  const P = { dispatch: fixtureParas(FIX.dispatch), steward: fixtureParas(FIX.steward), veranda: fixtureParas(FIX.veranda) };
  // MEDIUM (~150 sents): plain padding, payload early/mid/late + one hub variant
  specs.push({ key: 'med-early-dispatch', text: buildPadded('The Harbor Season', 30, 0.10, P.dispatch) });
  specs.push({ key: 'med-mid-steward', text: buildPadded('The Estate Season', 30, 0.50, P.steward) });
  specs.push({ key: 'med-late-veranda', text: buildPadded('The Inheritance Season', 30, 0.90, P.veranda) });
  specs.push({ key: 'med-hub-mid-dispatch', text: buildPadded('The Harbor Year', 30, 0.50, P.dispatch, HUB, CONN.dispatch) });
  // LONG (~520 sents): plain early/mid/late + hub variants early/late
  specs.push({ key: 'long-early-dispatch', text: buildPadded('The Harbor Decade', 115, 0.10, P.dispatch) });
  specs.push({ key: 'long-mid-veranda', text: buildPadded('The Inheritance Decade', 115, 0.50, P.veranda) });
  specs.push({ key: 'long-late-steward', text: buildPadded('The Estate Decade', 115, 0.90, P.steward) });
  specs.push({ key: 'long-hub-early-dispatch', text: buildPadded('The Carthage Dispatch', 115, 0.10, P.dispatch, HUB, CONN.dispatch) });
  specs.push({ key: 'long-hub-late-dispatch', text: buildPadded('The Carthage Vote', 115, 0.90, P.dispatch, HUB, CONN.dispatch) });
  specs.push({ key: 'long-hub-late-steward', text: buildPadded('The Carthage Account', 115, 0.90, P.steward, HUB, CONN.steward) });
  return specs;
}

/* ---------- gold triples ----------
   qid = question family (same question text wherever it appears), so
   survival can be compared for the SAME question across lengths.
   needles: verbatim substrings of the answer sentence(s); answer indices
   are located post-parse in doc.sentenceTexts. expectMiss: the doc
   projects no matching entities — a designed entry-miss probe. */
const Q = {
  S1: { q: 'What did Dron say about the peasants and the grain?', needles: ['peasants will not take the grain', 'not leave the village'], entries: ['Dron'] },
  S2: { q: 'What did Princess Mary decide to do with the grain?', needles: ['the grain is theirs', 'I give it freely'], entries: ['Princess Mary'] },
  S3: { q: 'Who was waiting for Princess Mary in the cold storeroom?', needles: ['Dron was waiting'], entries: ['Princess Mary'] },
  S4: { q: 'What did Dron believe about the French?', needles: ['believe the French are coming'], entries: ['Dron', 'French'] },
  V1: { q: "What did Mr. Calloway say about the uncle's estate?", needles: ['estate is smaller'], entries: ['Mr. Calloway'] },
  V2: { q: 'What did Harriet say about selling the house?', needles: ["sell my uncle's house"], entries: ['Harriet'] },
  V3: { q: "How long had Calloway handled the family's affairs?", needles: ['thirty years'], entries: ['Mr. Calloway'] },
  D1: { q: 'What did Vance argue about the timbers?', needles: ['timbers were unsafe'], entries: ['Vance'] },
  D2: { q: 'What did Ruiz say about the harbor?', needles: ['last of its kind on the coast'], entries: ['Ruiz'] },
  D3: { q: 'How did Vance and Ruiz leave after the vote?', needles: ['left by the same door'], entries: ['Vance', 'Ruiz'] },
  R1: { q: 'Where does 羅生門 stand?', needles: ['朱雀大路'], entries: ['羅生門'] },
  X1: { q: 'Where was the Nellie at anchor?', needles: ['swung to her anchor'], entries: [], expectMiss: true },
  X2: { q: 'What did Holloway bring at noon?', needles: ['sampling frames'], entries: [], expectMiss: true },
  X3: { q: 'Who gave the largest single gift to the subscription?', needles: ['largest single gift'], entries: [], expectMiss: true },
  X4: { q: 'What is calibration according to this treatise?', needles: ['moral practice'], entries: [], expectMiss: true },
};
const TRIPLES = [
  // SHORT — raw fixtures
  ['steward', 'S1'], ['steward', 'S2'], ['steward', 'S3'], ['steward', 'S4'],
  ['veranda', 'V1'], ['veranda', 'V2'], ['veranda', 'V3'],
  ['dispatch', 'D1'], ['dispatch', 'D2'], ['dispatch', 'D3'],
  ['rashomon', 'R1'],
  ['darkness', 'X1'], ['fieldnotes', 'X2'], ['ledger', 'X3'], ['treatise', 'X4'],
  // MEDIUM
  ['med-early-dispatch', 'D1'], ['med-early-dispatch', 'D2'], ['med-early-dispatch', 'D3'],
  ['med-mid-steward', 'S1'], ['med-mid-steward', 'S2'], ['med-mid-steward', 'S3'],
  ['med-late-veranda', 'V1'], ['med-late-veranda', 'V2'],
  ['med-hub-mid-dispatch', 'D1'], ['med-hub-mid-dispatch', 'D3'],
  // LONG
  ['long-early-dispatch', 'D1'], ['long-early-dispatch', 'D3'],
  ['long-mid-veranda', 'V1'], ['long-mid-veranda', 'V2'],
  ['long-late-steward', 'S1'], ['long-late-steward', 'S2'], ['long-late-steward', 'S3'],
  ['long-hub-early-dispatch', 'D1'], ['long-hub-early-dispatch', 'D3'],
  ['long-hub-late-dispatch', 'D1'], ['long-hub-late-dispatch', 'D2'], ['long-hub-late-dispatch', 'D3'],
  ['long-hub-late-steward', 'S1'], ['long-hub-late-steward', 'S2'],
];

/* ---------- replica of traverseGraph's BFS + pre-cap gather ----------
   A faithful port of engine.js traverseGraph (~9689), over the same
   projections the engine reads. Seeded with the ENGINE's own entry names
   (trav.entries) — namedEntitiesIn's hit depends only on the entity's
   name string vs the query, so filtering projectEntities by that name set
   reproduces the entry list (and its order) exactly. Returns the per-hop
   frontier sizes and the pre-cap pick set the engine throws away. */
const _keyWithin = (a, b) => (' ' + b + ' ').includes(' ' + a + ' ');
function replicateWalk(doc, trav, hops) {
  const { entities } = E.projectEntities(doc);
  const entryNames = new Set(trav.entries);
  const entries = entities.filter(e => entryNames.has(e.name));
  let edges = []; try { edges = E._projectGraph(doc._events).edges || []; } catch (e) { }
  const defs = E.assertionsOf(doc);
  const byKey = new Map(entities.map(e => [e.key, e]));
  const walked = new Map();
  for (const e of entries) walked.set(e.key, { entity: e, hop: 0 });
  let frontier = entries.map(e => e.key);
  const frontierSizes = [frontier.length];
  for (let h = 1; h <= hops && frontier.length; h++) {
    const next = [];
    for (const key of frontier) {
      const here = byKey.get(key); if (!here) continue;
      for (const ed of edges) {
        const otherKey = ed.a === key ? ed.b : ed.b === key ? ed.a : null;
        if (!otherKey || walked.has(otherKey) || !byKey.has(otherKey)) continue;
        walked.set(otherKey, { entity: byKey.get(otherKey), hop: h });
        next.push(otherKey);
      }
      const co = [];
      for (const other of entities) {
        if (walked.has(other.key)) continue;
        const shared = other.sents.filter(s => here.sents.includes(s)).length;
        if (shared) co.push({ other, shared });
      }
      co.sort((a, b) => b.shared - a.shared);
      for (const { other } of co.slice(0, 3)) {
        walked.set(other.key, { entity: other, hop: h });
        next.push(other.key);
      }
    }
    frontier = next;
    frontierSizes.push(next.length);
  }
  const walkedKeys = new Set(walked.keys());
  const heldDefs = defs.filter(d => walkedKeys.has(d.key)
    || (d.key.length >= 4 && [...walkedKeys].some(k => _keyWithin(k, d.key) || _keyWithin(d.key, k))));
  const picks = new Map();
  const take = (i) => { if (i != null && i >= 0 && i < doc.sentenceTexts.length && !picks.has(i)) picks.set(i, true); };
  for (const d of heldDefs) take(d.sent);
  for (const r of E.kinRecords(doc)) {
    if (walkedKeys.has(r.key) || (r.key.length >= 4 && [...walkedKeys].some(k => _keyWithin(k, r.key) || _keyWithin(r.key, k))))
      take(r.sent);
  }
  for (const w of walked.values()) for (const i of w.entity.sents.slice(0, w.hop === 0 ? 3 : 1)) take(i);
  const preCap = [...picks.keys()].sort((a, b) => a - b);
  const kept = preCap.slice(0, 12);
  const walkedNames = [...walked.values()].filter(w => w.hop > 0).map(w => w.entity.name);
  return { frontierSizes, walkedNames, preCap, kept, entities };
}

/* ---------- run ---------- */
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
let buildFails = 0;
function buildCheck(cond, msg) { if (!cond) { buildFails++; console.error('  BUILD-CHECK FAIL: ' + msg); } }

async function main() {
  console.log('walker-survival — traverseGraph answer-survival vs document length');
  console.log('hops = ' + HOPS + ' (shipped ceiling; thinkingBudget(3).graphHops = ' + E.thinkingBudget(3).graphHops + ')\n');

  const docs = new Map();
  console.log('documents:');
  for (const spec of docSpecs()) {
    const doc = await E.parseDocument(spec.key + '.txt', spec.text, spec.key);
    docs.set(spec.key, doc);
    const ents = E.projectEntities(doc).entities;
    let edges = []; try { edges = E._projectGraph(doc._events).edges || []; } catch (e) { }
    const top3 = [...ents].sort((a, b) => b.mass - a.mass).slice(0, 3);
    console.log(`  ${spec.key.padEnd(24)} ${String(doc.sentences.length).padStart(4)} sents  ${String(ents.length).padStart(2)} entities  ${String(edges.length).padStart(2)} edges  top-3-by-mass: ${top3.map(e => e.name + '(m' + e.mass + ',|s|=' + e.sents.length + ')').join(' ') || '—'}`);
  }

  const rows = [];
  let validationFails = 0;
  for (const [docKey, qid] of TRIPLES) {
    const doc = docs.get(docKey);
    const spec = Q[qid];
    const texts = doc.sentenceTexts;
    // (a) locate the answer post-parse, by verbatim needle
    const answerIdx = [...new Set(spec.needles.flatMap(n => texts.map((t, i) => t.includes(n) ? i : -1).filter(i => i >= 0)))].sort((a, b) => a - b);
    buildCheck(answerIdx.length >= 1, `${qid}@${docKey}: no sentence matches needles ${JSON.stringify(spec.needles)}`);
    buildCheck(answerIdx.length <= spec.needles.length + 1, `${qid}@${docKey}: needles match ${answerIdx.length} sentences (collision with padding?)`);

    const trav = E.traverseGraph(doc, spec.q, HOPS);
    const row = {
      docKey, qid, sents: doc.sentences.length, answerIdx,
      pos: answerIdx.length ? Math.round(100 * answerIdx[0] / doc.sentences.length) / 100 : null,
      bucket: doc.sentences.length < 100 ? 'short' : doc.sentences.length <= 400 ? 'medium' : 'long',
      hubDoc: /hub/.test(docKey),
    };
    if (!trav) {
      row.entryMiss = true;
      row.missKind = spec.expectMiss ? 'designed' : 'observed';
      const nEnts = E.projectEntities(doc).entities.length;
      row.missReason = nEnts === 0 ? 'doc projects 0 entities' : 'question names no projected entity';
      if (!spec.expectMiss) console.error(`  NOTE: OBSERVED entry-miss ${qid}@${docKey} (${row.missReason}) — a measured engine failure, not a harness error`);
    } else {
      row.entryMiss = false;
      buildCheck(!spec.expectMiss, `${qid}@${docKey}: designed entry-miss probe unexpectedly walked`);
      // (b) note when a question-named entity fails to parse out of the padded doc
      for (const want of spec.entries) if (!trav.entries.includes(want))
        console.error(`  NOTE: partial entry ${qid}@${docKey}: expected '${want}', engine resolved [${trav.entries}]`);
      const rep = replicateWalk(doc, trav, HOPS);
      row.walkedNames = rep.walkedNames;
      const keptEng = trav.sentences.map(s => s.i);
      const okKept = JSON.stringify(rep.kept) === JSON.stringify(keptEng);
      const okWalk = JSON.stringify(rep.walkedNames) === JSON.stringify(trav.walked.map(w => w.name));
      if (!okKept || !okWalk) { validationFails++; console.error(`  VALIDATION FAIL ${qid}@${docKey}: kept ${JSON.stringify(rep.kept)} vs engine ${JSON.stringify(keptEng)}; walked ok=${okWalk}`); }
      const top3 = [...rep.entities].sort((a, b) => b.mass - a.mass).slice(0, 3).map(e => e.name);
      const top3spread = [...rep.entities].sort((a, b) => b.sents.length - a.sents.length).slice(0, 3).map(e => e.name);
      Object.assign(row, {
        entries: trav.entries, nEntries: trav.entries.length,
        frontier: rep.frontierSizes, maxFrontier: Math.max(...rep.frontierSizes),
        walkedCount: rep.walkedNames.length,
        preCap: rep.preCap.length, kept: keptEng.length,
        gathered: answerIdx.some(i => rep.preCap.includes(i)),
        survived: answerIdx.some(i => keptEng.includes(i)),
        hubMassReach: trav.walked.some(w => top3.includes(w.name)),
        hubSpreadReach: trav.walked.some(w => top3spread.includes(w.name)),
        entryIsHub: trav.entries.some(n => top3.includes(n)),
      });
      row.drowned = row.gathered && !row.survived;
    }
    rows.push(row);
  }

  /* ---------- per-triple table ---------- */
  console.log('\nper-triple results:');
  console.log('  triple                          bucket  sents  ans@      entries  frontier      pre-cap  kept  gathered  survived  hub-mass  note');
  for (const r of rows) {
    const id = `${r.qid}@${r.docKey}`;
    if (r.entryMiss) {
      console.log(`  ${id.padEnd(32)}${r.bucket.padEnd(8)}${String(r.sents).padStart(5)}  ${String(r.answerIdx.join('/')).padEnd(10)}ENTRY-MISS/${r.missKind} (${r.missReason})`);
    } else {
      console.log(`  ${id.padEnd(32)}${r.bucket.padEnd(8)}${String(r.sents).padStart(5)}  ${String(r.answerIdx.join('/')).padEnd(10)}${String(r.nEntries).padStart(7)}  ${r.frontier.join('→').padEnd(12)}  ${String(r.preCap).padStart(7)}  ${String(r.kept).padStart(4)}  ${String(r.gathered).padEnd(8)}  ${String(r.survived).padEnd(8)}  ${String(r.hubMassReach).padEnd(8)}  ${r.drowned ? 'DROWNED-BY-CAP' : (!r.gathered ? 'never-gathered' : '')}`);
    }
  }

  /* ---------- bucket aggregates ---------- */
  console.log('\nsurvival by length bucket:');
  console.log('  bucket   n   miss(designed)  miss(observed)  survival(all)  survival(entry-hit)  drowned-by-cap  never-gathered  mean-pre-cap  mean-kept  mean-max-frontier  max-pre-cap');
  for (const b of ['short', 'medium', 'long']) {
    const all = rows.filter(r => r.bucket === b);
    const hit = all.filter(r => !r.entryMiss);
    const sv = hit.filter(r => r.survived);
    const md = all.filter(r => r.entryMiss && r.missKind === 'designed').length;
    const mo = all.filter(r => r.entryMiss && r.missKind === 'observed').length;
    console.log(`  ${b.padEnd(7)}${String(all.length).padStart(4)}${String(md).padStart(15)}${String(mo).padStart(16)}  ${pct(sv.length, all.length).padStart(12)}  ${pct(sv.length, hit.length).padStart(18)}  ${String(hit.filter(r => r.drowned).length).padStart(13)}  ${String(hit.filter(r => !r.gathered).length).padStart(13)}  ${f1(mean(hit.map(r => r.preCap))).padStart(11)}  ${f1(mean(hit.map(r => r.kept))).padStart(8)}  ${f1(mean(hit.map(r => r.maxFrontier))).padStart(16)}  ${String(Math.max(0, ...hit.map(r => r.preCap))).padStart(10)}`);
  }

  /* ---------- same question across lengths ---------- */
  console.log('\nsame question across lengths (survived; "·" = not run, MISS = entry-miss):');
  const fams = [...new Set(rows.map(r => r.qid))];
  console.log('  qid   ' + ['short', 'medium', 'med-hub', 'long', 'long-hub'].map(s => s.padEnd(22)).join(''));
  for (const f of fams) {
    const cells = ['short', 'medium', 'med-hub', 'long', 'long-hub'].map(col => {
      const sel = rows.filter(r => r.qid === f && (
        col === 'short' ? r.bucket === 'short'
          : col === 'medium' ? (r.bucket === 'medium' && !r.hubDoc)
            : col === 'med-hub' ? (r.bucket === 'medium' && r.hubDoc)
              : col === 'long' ? (r.bucket === 'long' && !r.hubDoc)
                : (r.bucket === 'long' && r.hubDoc)));
      if (!sel.length) return '·'.padEnd(22);
      return sel.map(r => (r.entryMiss ? 'MISS' : r.survived ? 'LIVE' : r.drowned ? 'DROWNED' : 'lost') + '@' + (r.pos != null ? r.pos : '?')).join(' ').padEnd(22);
    });
    console.log('  ' + f.padEnd(6) + cells.join(''));
  }

  /* ---------- frontier vs length ---------- */
  console.log('\nfrontier vs document length (per entry-hit triple):');
  for (const r of rows.filter(r => !r.entryMiss))
    console.log(`  ${String(r.sents).padStart(5)} sents  frontier ${r.frontier.join('→').padEnd(12)} max ${String(r.maxFrontier).padStart(3)}  walked ${String(r.walkedCount).padStart(3)}  (${r.qid}@${r.docKey})  [${(r.walkedNames || []).join(', ')}]`);

  /* ---------- cap pressure ---------- */
  console.log('\ncap pressure (pre-cap gather vs kept, entry-hit only):');
  for (const b of ['short', 'medium', 'long']) {
    const hit = rows.filter(r => r.bucket === b && !r.entryMiss);
    if (!hit.length) continue;
    const over = hit.filter(r => r.preCap > 12);
    console.log(`  ${b.padEnd(7)} mean drown factor ${f1(mean(hit.map(r => r.preCap / Math.max(1, r.kept))))}x  triples-over-cap ${over.length}/${hit.length}  worst ${Math.max(0, ...hit.map(r => r.preCap))} gathered → 12 kept`);
  }

  /* ---------- hub cross-tab (long bucket) ---------- */
  console.log('\nhub-reach × survival, LONG bucket (entry-hit only; hub = walk passed through a top-3-by-mass entity):');
  const long = rows.filter(r => r.bucket === 'long' && !r.entryMiss);
  for (const reach of [true, false]) {
    const sel = long.filter(r => r.hubMassReach === reach);
    console.log(`  hub-reached=${String(reach).padEnd(5)} n=${sel.length}  survived=${sel.filter(r => r.survived).length}  lost=${sel.filter(r => !r.survived).length}`);
  }
  const longSpread = long.filter(r => r.hubSpreadReach);
  console.log(`  (supplementary: top-3-by-SPREAD reach in long bucket: n=${longSpread.length}, survived=${longSpread.filter(r => r.survived).length})`);

  /* ---------- position effect ---------- */
  console.log('\nanswer position vs survival (medium+long, entry-hit only):');
  for (const [name, lo, hi] of [['early third', 0, 1 / 3], ['middle third', 1 / 3, 2 / 3], ['late third', 2 / 3, 1.01]]) {
    const sel = rows.filter(r => r.bucket !== 'short' && !r.entryMiss && r.pos >= lo && r.pos < hi);
    console.log(`  ${name.padEnd(13)} n=${sel.length}  survived=${sel.filter(r => r.survived).length} (${pct(sel.filter(r => r.survived).length, sel.length)})`);
  }

  console.log(`\nchecks: ${validationFails} replication mismatches, ${buildFails} build-check failures, ${rows.length} triples`);
  if (validationFails || buildFails) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
