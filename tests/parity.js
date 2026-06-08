/* ============================================================
   Golden-parity check. Captures the exact output of every engine path
   the speed work touches (retrieve / referencesDoc / hasGround / answer /
   context / inventedTerms / bindCitations) across a battery of queries on
   both sample docs and a large synthetic one.

     node tests/parity.js --update   # capture golden from current engine
     node tests/parity.js            # assert current engine matches golden

   Run --update on the BASELINE engine, optimise, then run bare to prove
   the optimisation changed timing only — never an answer.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, VOSS, CSV, makeBigDoc } = require('./harness');
const E = loadEngine().EOEngine;

const GOLDEN = path.join(__dirname, 'golden.json');
const round = (x) => Math.round(x * 1e6) / 1e6;

const QUERIES = [
  'who is in this story', 'summarize this', 'what did the keeper say about the boat',
  'what does Marlow want', 'boat to the mainland', 'the storm on the seaward side',
  'What did Zorthax say?', 'thanks that really helps', 'tell me a joke',
  'where is Voss Point', 'who argued about the boat', 'lamp at midnight',
];
const ANSWERS = [
  'Edith set the kettle down and listened.',
  'The keeper said no one could row to the mainland tonight.',
  'Sefton wanted to reach Marlow on the mainland.',
  'The spaceship departed for Jupiter at dawn.',
];

function snapshotProse(doc, tag) {
  const out = {};
  for (const q of QUERIES) {
    out[`retrieve:${q}`] = E.retrieve(doc, q, 6).map(s => ({ i: s.i, score: round(s.score), overlap: s.overlap }));
    out[`refDoc:${q}`] = E.referencesDoc(doc, q);
    out[`hasGround:${q}`] = E.hasGround(doc, q);
    out[`context:${q}`] = E.context(doc, q, 6);
    const a = E.answer(doc, q);
    out[`answer:${q}`] = { text: a.text, audit: a.audit, cites: a.cites || null };
    out[`invented:${q}`] = E.inventedTerms(doc, q);
  }
  for (const ans of ANSWERS) {
    const bc = E.bindCitations(doc, ans, 'q', 'factual');
    out[`bind:${ans}`] = { text: bc.text, audit: bc.audit, cites: bc.cites };
  }
  return { [tag]: out };
}

function snapshot() {
  const voss = E.parseDocument('Voss.txt', VOSS, 'voss');
  const big = E.parseDocument('big.txt', makeBigDoc(60), 'big');
  return { ...snapshotProse(voss, 'voss'), ...snapshotProse(big, 'big') };
}

const current = snapshot();

if (process.argv.includes('--update')) {
  fs.writeFileSync(GOLDEN, JSON.stringify(current, null, 1));
  console.log('✓ golden updated →', path.relative(process.cwd(), GOLDEN),
    `(${Object.keys(current.voss).length + Object.keys(current.big).length} snapshots)`);
  process.exit(0);
}

if (!fs.existsSync(GOLDEN)) { console.error('No golden.json — run `node tests/parity.js --update` first.'); process.exit(2); }
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

let diffs = 0;
for (const tag of Object.keys(current)) {
  for (const key of Object.keys(current[tag])) {
    const a = JSON.stringify(current[tag][key]);
    const b = JSON.stringify((golden[tag] || {})[key]);
    if (a !== b) { diffs++; if (diffs <= 12) console.error(`  ✗ ${tag} / ${key}\n      now:  ${a}\n      was:  ${b}`); }
  }
}
const n = Object.keys(current.voss).length + Object.keys(current.big).length;
console.log(`\n${diffs === 0 ? '✓ PARITY' : '✗ DRIFT'} — ${n} snapshots, ${diffs} differ from golden`);
process.exit(diffs ? 1 : 0);
