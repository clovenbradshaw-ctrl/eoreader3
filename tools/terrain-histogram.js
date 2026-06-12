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

   Usage: node tools/terrain-histogram.js [--entity-cell] [pattern...]
     (no args)               every file under evo/corpus/
     pg34901 pg3300 pg18     the three named essays
     --entity-cell           run with the site_entity_cell rule ON (the
                             Entity-cell rename + SIG/NUL coordinate fix)
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../tests/harness');

const CORPUS = path.resolve(__dirname, '..', 'evo', 'corpus');

const COL_ORDER = ['Ground', 'Figure', 'Pattern'];
// Cell names come from the engine's live grid, so the histogram follows the
// site_entity_cell rule (Thing legacy / Entity corrected) instead of pinning
// the labels here.
function rowOrder(E) {
  return Object.entries(E.EO_SITE_GRID).map(([name, row]) => ({ name, cells: COL_ORDER.map(c => row[c]) }));
}

function pickFiles(patterns) {
  const all = fs.readdirSync(CORPUS).filter(f => f.endsWith('.txt')).sort();
  if (!patterns.length) return all;
  return all.filter(f => patterns.some(p => f.includes(p)));
}

function fmt(x) { return String(x).padStart(8, ' '); }
function subst(cell) { return +(cell.mass - (cell.bookkeeping || 0)).toFixed(2); }

function maxCellName(cells) {
  let best = null, max = -Infinity;
  for (const k of Object.keys(cells)) {
    if (subst(cells[k]) > max) { max = subst(cells[k]); best = k; }
  }
  return { name: best, mass: max };
}

function rowTotals(rows, cells) {
  const out = {};
  for (const r of rows) {
    out[r.name] = +r.cells.reduce((s, c) => s + (cells[c] ? subst(cells[c]) : 0), 0).toFixed(2);
  }
  return out;
}
function colTotals(rows, cells) {
  const out = { Ground: 0, Figure: 0, Pattern: 0 };
  for (const r of rows) {
    for (let i = 0; i < r.cells.length; i++) {
      const c = r.cells[i];
      out[COL_ORDER[i]] += cells[c] ? subst(cells[c]) : 0;
    }
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(2);
  return out;
}

async function run() {
  const args = process.argv.slice(2);
  const entityCell = args.includes('--entity-cell');
  const files = pickFiles(args.filter(a => a !== '--entity-cell'));
  if (!files.length) {
    console.error('no corpus files matched');
    process.exit(1);
  }
  const W = loadEngine();
  const { EOEngine } = W;
  if (entityCell) {
    // same standing-host-rules path the app uses; survives ledger commits
    W.EO_RULES = [{ id: 'site-entity-cell', installed: true, enabled: true, value: 1 }];
    EOEngine.applyRules(W.EO_RULES);
  }
  const ROWS = rowOrder(EOEngine);
  // Header
  const header = ['document'.padEnd(34), ...COL_ORDER.map(c => c.padStart(8))].join(' ');
  console.log('\n# nine-cell Site terrain histogram — mass per cell (count fallback)');
  console.log('# rows: ' + ROWS.map(r => r.name + ' (' + r.cells.join('/') + ')').join(' · ')
    + (entityCell ? '   [site_entity_cell ON]' : ''));

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
    console.log('  (substantive mass shown; reader-machinery bookkeeping in [brackets])');
    console.log('');
    console.log('  ' + header);
    for (const row of ROWS) {
      const line = row.name.padEnd(16);
      const parts = row.cells.map((c, i) => {
        const cell = cells[c];
        const label = (c + '(' + COL_ORDER[i][0] + ')').padEnd(15);
        const bk = cell && cell.bookkeeping ? ' [' + cell.bookkeeping + ']' : '';
        return label + fmt(cell ? subst(cell) : 0) + bk.padEnd(9);
      });
      console.log('  ' + line + parts.join(' '));
    }
    const rt = rowTotals(ROWS, cells);
    const ct = colTotals(ROWS, cells);
    const best = maxCellName(cells);
    const total = rt.Existence + rt.Structure + rt.Interpretation;
    console.log('');
    console.log('  row sums          Existence ' + fmt(rt.Existence) + '  Structure ' + fmt(rt.Structure) + '  Interpretation ' + fmt(rt.Interpretation));
    console.log('  col sums          Ground    ' + fmt(ct.Ground)    + '  Figure    ' + fmt(ct.Figure)    + '  Pattern        ' + fmt(ct.Pattern));
    console.log('  heaviest cell     ' + best.name + ' (substantive mass ' + best.mass + ', ' + ((best.mass / Math.max(total, 1)) * 100).toFixed(1) + '%)');
    console.log('  interp share      ' + ((rt.Interpretation / Math.max(total, 1)) * 100).toFixed(1) + '%   (Paradigm ' + subst(cells.Paradigm) + ', Lens ' + subst(cells.Lens) + ', Atmosphere ' + subst(cells.Atmosphere) + ')');
    summary.push({
      file, sentences: nSents, events: nEvents, total: +total.toFixed(2),
      best: best.name, bestMass: best.mass,
      paradigm: subst(cells.Paradigm), lens: subst(cells.Lens), atmosphere: subst(cells.Atmosphere),
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
