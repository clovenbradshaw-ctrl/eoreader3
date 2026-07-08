/* ============================================================
   tests/coref.test.js — a gendered title blocks a cross-gender fusion.

   "Mr. Samsa" and "Mrs. Samsa" share only the surname once the title is
   stripped (the title is a STOP token for the index), so token gravity used to
   fuse the whole family — Gregor, Mr. and Mrs. Samsa — into one mis-keyed node
   (name "Gregor Samsa", key "mrs. samsa"), pooling every mention and starving
   the graph of distinct pairs to connect. A gendered title is identity
   evidence: a known gender conflict now keeps the referents apart.

   Two same-gender, same-surname people — the son "Gregor Samsa" and the father
   "Mr. Samsa" — also stay apart now (Fix 2 / D3): the gendered title is retained
   in the identity sequence (contentSeqOf), so the equal-arity specifier-
   disagreement veto in namesCoRefer fires instead of reading "Mr. Samsa" as a
   short form of "Gregor Samsa". This pins both the gender split and the title split.
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

  console.log('• coref — same-gender same-surname son and father stay apart (Fix 2 / D3)');
  // The son "Gregor Samsa" and the father "Mr. Samsa" share gender (male) and
  // surname; only the gendered title tells them apart. Before, "Mr. Samsa" →
  // [samsa] read as a short form of "Gregor Samsa" → [gregor, samsa] and the
  // two males fused. The retained title makes them equal-arity-but-different,
  // so namesCoRefer's specifier-disagreement veto keeps them distinct.
  const gregor = ents.find(e => /^gregor\b/i.test(e.name || ''));
  const father = ents.find(e => /^mr\.?\s+samsa\b/i.test(e.name || ''));
  ok(gregor, 'a "Gregor Samsa" (son) node exists');
  ok(father, 'a "Mr. Samsa" (father) node exists');
  ok(gregor && father && gregor.key !== father.key,
    'son and father are different referents (' + (gregor && gregor.key) + ' vs ' + (father && father.key) + ')');
  ok(gregor && gregor.type === 'person' && father && father.type === 'person',
    'both the son and the father are typed person');

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
