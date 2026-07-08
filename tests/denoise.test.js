/* ============================================================
   tests/denoise.test.js — admission/typing de-noising (D5).

   Two production-guards keep a narrative summary clean:

   1. Interjection stoplist — a bare exclamatory capital (God!, Heavens!,
      Goodness!, Christmas) reads as a proper noun to NER but names no referent
      in narrative. Such a bare single token never enters the entity layer. A
      multiword name that merely contains the word ("Joe Christmas", "God of
      War") is unaffected — only the standalone token is filtered.

   2. Frame de-collision — a frame hashes an entity's edge-neighbourhood, so
      structurally identical entities share one. A zero-edge entity has no
      structure, and JSON.stringify([]) === "[]" used to hash every isolated
      referent into ONE frame. Each isolated entity must instead get its own.

   Run with `node tests/denoise.test.js`.
   ============================================================ */
'use strict';
const { loadEngine } = require('./harness');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) { pass++; } else { fail++; fails.push(m); console.error('  ✗ ' + m); } }

async function main() {
  const E = loadEngine().EOEngine;

  console.log('• interjection stoplist — bare God!/Christmas name no referent');
  // God and Christmas each appear repeatedly out-of-quote, so the two-sighting
  // gate would admit them — only the stoplist holds them out (without it,
  // "Christmas" is admitted as a referent, as the pre-fix engine does).
  const T1 = [
    'God had not been kind to Gregor that long cold winter.',
    'Even God could not have foreseen the strange change in him.',
    'It was almost Christmas in the cold grey city outside.',
    'Christmas had always been the favourite season of the family.',
    'Gregor Samsa lay quite still in the narrow bed.',
  ].join(' ');
  const d1 = await E.parseDocument('denoise1.txt', T1, 'narrative');
  const names1 = E.projectEntities(d1).entities.map(e => (e.name || '').toLowerCase());
  ok(names1.some(n => /gregor/.test(n)), 'the real character (Gregor) is admitted');
  ok(!names1.includes('god'), 'the interjection "God" is NOT an entity');
  ok(!names1.includes('christmas'), 'the holiday word "Christmas" is NOT an entity');

  console.log('• frame de-collision — isolated entities do not share one frame');
  const T2 = [
    'The first prize went to Johann Sebastian at the northern hall.',
    'Johann Sebastian smiled warmly at the cheering crowd there.',
    'The second prize went to Pyotr Ilyich at the southern hall.',
    'Pyotr Ilyich bowed to the cheering crowd in the south.',
  ].join(' ');
  const d2 = await E.parseDocument('denoise2.txt', T2, 'narrative');
  const frames = (d2._events || []).filter(e => e.op === 'DEF' && e.path === 'frame');
  const zero = frames.filter(f => f.basis && f.basis.edges === 0);
  ok(zero.length >= 2, 'at least two zero-edge entities to compare (got ' + zero.length + ')');
  const vals = new Set(zero.map(f => f.value));
  ok(vals.size === zero.length,
    'each zero-edge entity has a DISTINCT frame, no hash("[]") collision (' + zero.length + ' entities, ' + vals.size + ' frames)');

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
