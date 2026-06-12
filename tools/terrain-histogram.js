/* ============================================================
   tools/terrain-histogram.js — print the nine-cell Site terrain
   histogram (Existence × Time / Structure × Time / Interpretation × Time)
   for every document in evo/corpus, so the spec's section 2b read can
   be eyeballed before any fold prose is written.

   Pure observation: loads the engine via the test harness, parses each
   corpus file once, and calls EOEngine.foldTerrains(doc). The Interpretation
   row (Atmosphere / Lens / Paradigm) is what the essays must populate for
   the fold change to be tractable at all — if Paradigm and Lens come up
   starved on essays the work is upstream of the fold.

   Usage: node tools/terrain-histogram.js [pattern...]
     (no args)               every file under evo/corpus/
     pg34901 pg3300 pg18     the three named essays
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../tests/harness');

const CORPUS = path.resolve(__dirname, '..', 'evo', 'corpus');

const ROW_ORDER = [
  { name: 'Existence',      cells: ['Void', 'Thing', 'Kind'] },
  { name: 'Structure',      cells: ['Field', 'Link', 'Network'] },
  { name: 'Interpretation', cells: ['Atmosphere', 'Lens', 'Paradigm'] },
];
const COL_ORDER = ['Ground', 'Figure', 'Pattern'];

function pickFiles(patterns) {
  const all = fs.readdirSync(CORPUS).filter(f => f.endsWith('.txt')).sort();
  if (!patterns.length) return all;
  return all.filter(f => patterns.some(p => f.includes(p)));
}

function fmt(x) { return String(x).padStart(8, ' '); }

function maxCellName(cells) {
  let best = null, max = -Infinity;
  for (const k of Object.keys(cells)) {
    if (cells[k].mass > max) { max = cells[k].mass; best = k; }
  }
  return { name: best, mass: max };
}

function rowTotals(cells) {
  const out = {};
  for (const r of ROW_ORDER) {
    out[r.name] = +r.cells.reduce((s, c) => s + (cells[c] ? cells[c].mass : 0), 0).toFixed(2);
  }
  return out;
}
function colTotals(cells) {
  const out = { Ground: 0, Figure: 0, Pattern: 0 };
  for (const r of ROW_ORDER) {
    for (let i = 0; i < r.cells.length; i++) {
      const c = r.cells[i];
      out[COL_ORDER[i]] += cells[c] ? cells[c].mass : 0;
    }
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(2);
  return out;
}

async function run() {
  const args = process.argv.slice(2);
  const files = pickFiles(args);
  if (!files.length) {
    console.error('no corpus files matched');
    process.exit(1);
  }
  const { EOEngine } = loadEngine();
  // Header
  const header = ['document'.padEnd(34), ...COL_ORDER.map(c => c.padStart(8))].join(' ');
  console.log('\n# nine-cell Site terrain histogram — mass per cell (count fallback)');
  console.log('# rows: Existence (Void/Thing/Kind) · Structure (Field/Link/Network) · Interpretation (Atmosphere/Lens/Paradigm)');

  const summary = [];
  for (const file of files) {
    const full = path.join(CORPUS, file);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); }
    catch (e) { console.error('  ! ' + file + ': ' + e.message); continue; }
    console.log('\n## ' + file + '  (' + text.length.toLocaleString() + ' chars)');
    const t0 = Date.now();
    let doc;
    try {
      doc = await EOEngine.parseDocument(file, text, file);
    } catch (e) {
      console.error('  ! parse failed: ' + e.message);
      continue;
    }
    const cells = EOEngine.foldTerrains(doc);
    if (!cells) { console.log('  (no events)'); continue; }
    const parseMs = Date.now() - t0;
    const nEvents = (doc._events || []).length;
    const nSents = (doc.sentenceTexts || []).length;
    console.log('  ' + nSents.toLocaleString() + ' sentences · ' + nEvents.toLocaleString() + ' events · parse ' + parseMs + ' ms');
    console.log('');
    console.log('  ' + header);
    for (const row of ROW_ORDER) {
      const line = row.name.padEnd(16);
      const parts = row.cells.map((c, i) => {
        const cell = cells[c];
        const label = (c + '(' + COL_ORDER[i][0] + ')').padEnd(15);
        return label + fmt(cell ? cell.mass : 0);
      });
      console.log('  ' + line + parts.join('  '));
    }
    const rt = rowTotals(cells);
    const ct = colTotals(cells);
    const best = maxCellName(cells);
    const total = rt.Existence + rt.Structure + rt.Interpretation;
    console.log('');
    console.log('  row sums          Existence ' + fmt(rt.Existence) + '  Structure ' + fmt(rt.Structure) + '  Interpretation ' + fmt(rt.Interpretation));
    console.log('  col sums          Ground    ' + fmt(ct.Ground)    + '  Figure    ' + fmt(ct.Figure)    + '  Pattern        ' + fmt(ct.Pattern));
    console.log('  heaviest cell     ' + best.name + ' (mass ' + best.mass + ', ' + ((best.mass / Math.max(total, 1)) * 100).toFixed(1) + '%)');
    console.log('  interp share      ' + ((rt.Interpretation / Math.max(total, 1)) * 100).toFixed(1) + '%   (Paradigm ' + cells.Paradigm.mass + ', Lens ' + cells.Lens.mass + ', Atmosphere ' + cells.Atmosphere.mass + ')');
    summary.push({
      file, sentences: nSents, events: nEvents, total: +total.toFixed(2),
      best: best.name, bestMass: best.mass,
      paradigm: cells.Paradigm.mass, lens: cells.Lens.mass, atmosphere: cells.Atmosphere.mass,
      interpTotal: rt.Interpretation, interpShare: +((rt.Interpretation / Math.max(total, 1)) * 100).toFixed(1),
    });
  }

  // Tail summary: one line per document, sortable by interp share
  console.log('\n\n# summary — share of Interpretation-row mass per document');
  console.log('  ' + 'document'.padEnd(34) + ' events     heaviest          paradigm    lens   atmos   interp%');
  summary.sort((a, b) => b.interpShare - a.interpShare);
  for (const s of summary) {
    console.log('  ' + s.file.padEnd(34)
      + String(s.events).padStart(7) + '   '
      + (s.best + ' (' + s.bestMass + ')').padEnd(18)
      + ' ' + String(s.paradigm).padStart(8)
      + ' ' + String(s.lens).padStart(7)
      + ' ' + String(s.atmosphere).padStart(7)
      + '   ' + s.interpShare + '%');
  }
}

run().catch(e => { console.error(e); process.exit(2); });
