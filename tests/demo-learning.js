/* ============================================================
   A narrated demo of the engine getting smarter over use.

   It reads a short sequence of documents and, after each, prints the
   speech-verb class it has INDUCED (with mass = confidence). Then it shows
   one held-out sentence read by a cold engine vs. one that has done the
   reading: the attribution goes from a weak positional guess to a clean,
   verb-based attribution — purely because the engine learned the verb.

     node tests/demo-learning.js
   ============================================================ */
'use strict';
const { loadEngine } = require('./harness');

const show = (E) => {
  const v = E._learnedVerbs();
  return v.length ? v.map(x => `${x.verb}·${x.mass}`).join('  ') : '(nothing yet)';
};
const attrOf = async (E, text, mark) => {
  const s = ((await E._extractEoGraph(text)).events || []).find(e => e.op === 'SIG' && (e.quote || '').includes(mark));
  return s ? `${s.speaker} [${s.attributed}]` : '(no speech detected)';
};

const corpus = [
  [`"You cannot row tonight," murmured the keeper. "No one could," murmured Edith.`, 'murmured'],
  [`"Marlow is waiting," fretted Sefton. "He will keep," fretted Edith.`, 'fretted'],
  [`"The wind has the shutter," murmured Marlow. "Then we sit by the lamp," murmured Edith.`, 'murmured again'],
];

async function main() {
console.log('═══ The engine starts with NO speech verbs ═══');
const E = loadEngine().EOEngine;
console.log('  learned:', show(E), '\n');

for (let i = 0; i < corpus.length; i++) {
  const [doc, note] = corpus[i];
  await E.parseDocument('d' + i, doc, 'd' + i);
  console.log(`After document ${i + 1} (${note}):`);
  console.log('  learned:', show(E), '\n');
}

console.log('═══ A held-out sentence, read cold vs. by the engine that has read the corpus ═══');
const HELD = `"The boat is lost," murmured Voss.`;   // inverted attribution via a learned verb
console.log('  sentence:', HELD);
console.log('  cold engine :', await attrOf(loadEngine().EOEngine, HELD, 'boat is lost'), '  ← positional guess');
console.log('  taught engine:', await attrOf(E, HELD, 'boat is lost'), '  ← clean, verb-based attribution');
}

main().catch(e => { console.error(e); process.exit(1); });
