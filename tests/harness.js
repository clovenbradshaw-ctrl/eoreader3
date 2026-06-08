/* ============================================================
   Test harness for the Cleon reading engine.

   engine.js / pivot.jsx are browser scripts: they run as an IIFE and
   publish onto `window` (window.EOEngine, window.parsePivot, …) and
   read the global `nlp` (compromise). There is no module boundary, so
   we load them into a shared `vm` context whose global object carries
   `window`, `nlp`, and `performance`, then read the published API back
   out. This lets the *unconscious process* — the deterministic engine
   that runs beneath the LLM — be exercised and timed from Node.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nlp = require('compromise');

const ROOT = path.resolve(__dirname, '..');

function loadEngine() {
  // One shared context so engine.js can see window.parsePivot from pivot.jsx.
  const sandbox = { window: {}, nlp, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['pivot.jsx', 'engine.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  if (!sandbox.window.EOEngine) throw new Error('engine did not publish window.EOEngine');
  return sandbox.window;
}

/* ---- fixtures: the two example documents shipped in data.jsx ---- */
const VOSS = `The Lamp at Voss Point

The storm had been promising itself all afternoon, and by the time Edith reached the head of the stairs it had stopped pretending. She set the kettle down and listened. Below her, the keeper was already moving through the lower room, and she could hear Sefton arguing with him about the boat.

"You cannot row to the mainland tonight," the keeper said. "No one could."

"Marlow is on the mainland," Sefton answered, "and Marlow is expecting me." He said it as though that settled the matter, which, to Sefton, it did. Edith came down the last three steps and stood where the lamplight reached her.

"He will still be there in the morning," she said. "Harrow has never once been kind to a small boat, and Voss Point least of all." The keeper looked at her with something like gratitude, and Sefton, for the first time that evening, said nothing.

By midnight the wind had taken the shutter on the seaward side, and the three of them sat close to the lamp. Edith thought about Marlow, whom she had never met, waiting on the mainland with a lantern of his own.`;

const CSV = `deal_id,agent,region,closed,value,status
D-1042,Okonkwo,West,2026-01-09,84000,won
D-1043,Rhee,East,2026-01-15,51500,won
D-1044,Okonkwo,West,2026-01-28,127000,won
D-1045,Delgado,South,2026-02-02,39000,lost
D-1046,Rhee,East,2026-02-11,66000,won
D-1047,Beaumont,North,2026-02-19,142500,won
D-1048,Delgado,South,2026-02-24,47000,won
D-1049,Okonkwo,West,2026-03-03,98000,open
D-1050,Beaumont,North,2026-03-09,73000,won
D-1051,Rhee,East,2026-03-14,58000,open
D-1052,Delgado,South,2026-03-18,61000,won
D-1053,Beaumont,North,2026-03-22,119000,won
D-1054,Okonkwo,West,2026-03-27,156000,won
D-1055,Rhee,East,2026-03-31,44000,lost`;

/* ---- a larger, realistic prose doc for benchmarking the per-turn path ----
   Built from a fixed vocabulary so retrieval, entity projection and the
   void paths all have real spread (named people/places, recurring terms).
   Deterministic: same `n` always yields the same text. */
function makeBigDoc(nParas = 60) {
  const people = ['Edith', 'Sefton', 'Marlow', 'Harrow', 'Voss', 'the keeper', 'Delgado', 'Okonkwo'];
  const places = ['the mainland', 'Voss Point', 'the lower room', 'the seaward shutter', 'the head of the stairs'];
  const things = ['the lamp', 'the boat', 'the kettle', 'the lantern', 'the storm', 'the shutter'];
  const verbs = ['watched', 'remembered', 'argued about', 'carried', 'lit', 'abandoned', 'repaired', 'questioned'];
  const adv = ['that evening', 'by midnight', 'before the storm broke', 'against the wind', 'without a word'];
  const pick = (arr, k) => arr[k % arr.length];
  const paras = [];
  for (let p = 0; p < nParas; p++) {
    const sents = [];
    const nS = 3 + (p % 4);
    for (let s = 0; s < nS; s++) {
      const k = p * 7 + s * 3;
      const who = pick(people, k), place = pick(places, k + 1), thing = pick(things, k + 2);
      const v = pick(verbs, k + 3), a = pick(adv, k + 4);
      sents.push(`${who[0].toUpperCase() + who.slice(1)} ${v} ${thing} near ${place} ${a}.`);
    }
    paras.push(sents.join(' '));
  }
  return 'The Long Watch at Voss Point\n\n' + paras.join('\n\n');
}

module.exports = { loadEngine, VOSS, CSV, makeBigDoc, ROOT };
