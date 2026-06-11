/* ============================================================
   tests/coref.test.js — a gendered title blocks a cross-gender fusion.

   "Mr. Samsa" and "Mrs. Samsa" share only the surname once the title is
   stripped (the title is a STOP token for the index), so token gravity used to
   fuse the whole family — Gregor, Mr. and Mrs. Samsa — into one mis-keyed node
   (name "Gregor Samsa", key "mrs. samsa"), pooling every mention and starving
   the graph of distinct pairs to connect. A gendered title is identity
   evidence: a known gender conflict now keeps the referents apart.

   (Two same-gender same-surname people — Gregor and his father — still merge;
   that is the harder coref, out of scope here. This pins the gender split.)
   ============================================================ */
'use strict';
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }

async function main() {
  const E = loadEngine().EOEngine;
  const TXT = ['Gregor Samsa woke from troubled dreams.', 'Mr. Samsa was angry at the lodgers.',
    'Mrs. Samsa wept for her son.', 'Gregor Samsa heard Mr. Samsa shouting.',
    'Mrs. Samsa called to Grete.', 'Mr. Samsa struck Gregor Samsa.', 'Mrs. Samsa thanked Grete.'].join(' ');
  const doc = await E.parseDocument('meta.txt', TXT, 'meta');
  const ents = E.projectEntities(doc).entities;

  console.log('• coref — a gendered title blocks a cross-gender surname fusion');
  const samsa = ents.filter(e => /samsa/i.test(e.key || ''));
  const fem = samsa.find(e => e.gender === 'f');
  const masc = samsa.find(e => e.gender === 'm');
  ok(fem, 'a FEMALE Samsa node exists (Mrs. Samsa is not pooled into the family)');
  ok(masc, 'a MALE Samsa node exists, distinct from the female one');
  ok(fem && masc && fem.key !== masc.key, 'the male and female Samsa nodes are different referents');
  ok(samsa.length >= 2, 'the family no longer collapses to one node (' + samsa.length + ' Samsa nodes)');
  // the reported symptom: a node whose key asserts a gender its name contradicts
  const misKeyed = ents.find(e => /^mrs\.?\s/i.test(e.key || '') && e.gender === 'm');
  ok(!misKeyed, 'no male node is keyed "mrs. …" — the mrs. samsa key-collapse is gone');

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
