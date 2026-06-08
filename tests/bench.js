/* ============================================================
   Benchmark the per-turn "unconscious process": the deterministic work
   the engine does on every chat message before the model says anything —
   route (referencesDoc), then either fold/answer or gather LLM context,
   then bind citations onto a model-style answer.

   We hold ONE parsed document (the real case: a doc is parsed once, then
   asked many questions) and replay a battery of turns against it, the way
   the chat loop does. Reports median ms/turn and turns/sec.

     node tests/bench.js [paragraphs] [iterations]
   ============================================================ */
'use strict';
const { loadEngine, makeBigDoc } = require('./harness');
const E = loadEngine().EOEngine;

const PARAS = Number(process.argv[2] || 120);
const ITERS = Number(process.argv[3] || 400);

const TURNS = [
  'who is in this story',
  'summarize what happens',
  'what did Edith do near the lamp',
  'tell me about the boat to the mainland',
  'where is Voss Point and the seaward shutter',
  'thanks, that is helpful',           // chit-chat — routes away
  'what does Marlow remember about the storm',
  'who argued near the head of the stairs',
];
// a model-style answer to exercise bindCitations (the per-sentence retrieve path)
const MODEL_ANSWER =
  'Edith carried the lamp near the seaward shutter that evening. ' +
  'Sefton argued about the boat before the storm broke. ' +
  'The keeper repaired the shutter against the wind.';

const doc = E.parseDocument('big.txt', makeBigDoc(PARAS), 'big');
console.log(`doc: ${doc.sentences.length} sentences · ${PARAS} paragraphs · ${ITERS} iterations`);

// One full turn, exactly as the chat loop drives it.
function turn(q) {
  const refs = E.referencesDoc(doc, q);          // routing — runs every message
  if (!refs) return 0;                           // chit-chat: model handles it, no grounding
  const intent = E.classifyIntent(q);
  E.hasGround(doc, q);
  const ctx = E.context(doc, q, 6);              // passages handed to the model
  E.bindCitations(doc, MODEL_ANSWER, q, intent); // model replies → citations bound mechanically
  return ctx.length;
}

// warm up (parse-time caches, JIT)
for (let i = 0; i < 30; i++) for (const q of TURNS) turn(q);

const samples = [];
for (let it = 0; it < ITERS; it++) {
  const t0 = performance.now();
  for (const q of TURNS) turn(q);
  samples.push((performance.now() - t0) / TURNS.length);
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const p95 = samples[Math.floor(samples.length * 0.95)];
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

console.log(`  median   ${median.toFixed(4)} ms/turn`);
console.log(`  mean     ${mean.toFixed(4)} ms/turn`);
console.log(`  p95      ${p95.toFixed(4)} ms/turn`);
console.log(`  throughput  ${Math.round(1000 / median).toLocaleString()} turns/sec`);
