/* ============================================================
   evo/experiments/site-histogram.js

   The Site face per document, in numbers — the read-only first step of
   the Nine-Sites work. The fold today reads only one terrain of nine
   (Existence × Figure → Thing). Before any prosifier is written, the
   spec asks one question: when we walk the event log of an essay, do
   the Interpretation-row cells (Paradigm and Lens) carry mass — or does
   the bias live upstream, in what DEF actually deposits?

   This harness answers that question by running EOEngine.foldTerrains
   over the English battery (narratives + essays) and printing the
   nine-cell mass histogram per document. The Domain rows are listed in
   reading order (Existence / Structure / Interpretation), with each
   row showing the three Time columns (Ground / Figure / Pattern).

   The histogram per row also reports a SHARE — that cell's mass over
   the document total — so a row's distribution is visible at a glance
   regardless of document length. This is the input that section 5 of
   the spec calls for: pick the normalization constant by looking at the
   measured nine-cell distributions, not by intuition.

   This script writes nothing to engine.js. It is a pure read.

   Usage:
     node evo/experiments/site-histogram.js              # full battery
     node evo/experiments/site-histogram.js --json out.json
     node evo/experiments/site-histogram.js --cap 20000  # cap per-doc chars
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../engine-host');

const CORPUS_DIR = path.join(__dirname, '..', 'corpus');

/* The English battery, narratives and essays both — the bias the fold
   has on argument only shows when essays sit alongside novels. */
const BATTERY = [
  { file: 'pg219.txt',   title: 'Heart of Darkness',     lang: 'en', genre: 'narrative' },
  { file: 'pg1237.txt',  title: 'Father Goriot',         lang: 'en', genre: 'narrative' },
  { file: 'pg5200.txt',  title: 'Metamorphosis',         lang: 'en', genre: 'narrative' },
  { file: 'pg600.txt',   title: 'Notes from Underground', lang: 'en', genre: 'narrative' },
  { file: 'pg34901.txt', title: 'On Liberty',            lang: 'en', genre: 'essay' },
  { file: 'pg3300.txt',  title: 'Wealth of Nations',     lang: 'en', genre: 'essay' },
];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function stripBoilerplate(t) {
  const a = t.indexOf('*** START');
  const start = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(start, b >= 0 ? b : t.length).trim();
}

function loadDoc(entry, cap) {
  const raw = fs.readFileSync(path.join(CORPUS_DIR, entry.file), 'utf8');
  return stripBoilerplate(raw).slice(0, cap);
}

const r1 = (x) => Math.round(x * 10) / 10;
const pct = (num, den) => den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

/* The grid in reading order: Existence (NUL/SIG/INS), Structure (SEG/CON/SYN),
   Interpretation (DEF/EVA/REC). Time columns: Ground, Figure, Pattern. */
const ROWS = [
  { row: 'Existence',      cells: ['Void',       'Thing', 'Kind'] },
  { row: 'Structure',      cells: ['Field',      'Link',  'Network'] },
  { row: 'Interpretation', cells: ['Atmosphere', 'Lens',  'Paradigm'] },
];

function totalMass(mass) {
  let s = 0;
  for (const k of Object.keys(mass)) s += mass[k];
  return s;
}

function formatGrid(mass, count) {
  const total = totalMass(mass);
  const out = [];
  out.push(pad('row', 17) + '  ' +
           pad('Ground', 24) + pad('Figure', 24) + pad('Pattern', 24));
  out.push('-'.repeat(17 + 2 + 24 * 3));
  for (const { row, cells } of ROWS) {
    const fields = cells.map(name => {
      const m = mass[name] || 0, c = count[name] || 0;
      const s = pct(m, total);
      return `${name}: ${lpad(r1(m), 7)} (${lpad(c, 4)} ev, ${lpad(s + '%', 5)})`;
    });
    out.push(pad(row, 17) + '  ' + fields.map(f => pad(f, 24)).join(''));
  }
  out.push('');
  out.push(`total mass = ${r1(total)}, total events = ${Object.values(count).reduce((a,b)=>a+b,0)}`);
  return out.join('\n');
}

function reportEvents(cells, name, n) {
  const arr = cells[name] || [];
  if (!arr.length) return;
  console.log(`  ${name} — top ${Math.min(n, arr.length)}/${arr.length} events:`);
  for (const ev of arr.slice(0, n)) {
    const t = (ev.target == null) ? '(no target)' : String(ev.target).slice(0, 40);
    console.log(`    seq=${ev.seq} op=${ev.op} sent=${ev.sentence_idx} mass=${r1(ev.mass)} target="${t}"`);
  }
}

(async () => {
  const cap = parseInt(arg('--cap', '60000'), 10);
  const jsonOut = arg('--json', null);
  const detail = process.argv.includes('--detail');

  console.log(`# Nine-Sites histogram — corpus pass (cap ${cap} chars/doc)\n`);
  const E = loadEngine().EOEngine;

  const all = [];
  for (const entry of BATTERY) {
    const text = loadDoc(entry, cap);
    const id = entry.file.replace('.txt', '');
    const doc = await E.parseDocument(entry.file, text, id);
    const terr = E.foldTerrains(doc);
    if (!terr) { console.log(`(skipped ${entry.title} — no terrain reading)`); continue; }

    console.log(`## ${entry.title}  [${entry.genre}]  (${doc.sentenceTexts.length} sents, ${doc._events.length} events)`);
    console.log(formatGrid(terr.mass, terr.count));
    if (detail) {
      console.log('');
      reportEvents(terr.cells, 'Paradigm', 5);
      reportEvents(terr.cells, 'Lens', 5);
      reportEvents(terr.cells, 'Atmosphere', 5);
    }
    console.log('');

    all.push({
      id, title: entry.title, genre: entry.genre,
      sentences: doc.sentenceTexts.length,
      events: doc._events.length,
      mass: terr.mass,
      count: terr.count,
    });
  }

  // Aggregate by genre — the spec's question in one number.
  const byGenre = {};
  for (const r of all) {
    if (!byGenre[r.genre]) byGenre[r.genre] = { mass: {}, count: {}, n: 0 };
    const g = byGenre[r.genre];
    g.n++;
    for (const k of Object.keys(r.mass)) g.mass[k] = (g.mass[k] || 0) + r.mass[k];
    for (const k of Object.keys(r.count)) g.count[k] = (g.count[k] || 0) + r.count[k];
  }
  console.log('## Aggregate by genre\n');
  for (const genre of Object.keys(byGenre)) {
    const g = byGenre[genre];
    console.log(`### ${genre}  (${g.n} doc${g.n === 1 ? '' : 's'}, summed mass)`);
    console.log(formatGrid(g.mass, g.count));
    console.log('');
  }

  // The spec's pass/fail criterion, stated as numbers:
  //   "If Paradigm and Lens carry mass on essays, the rest is prose plus a
  //    normalization constant. If they starve, the bias was never in the fold."
  console.log('## Spec gate — does the Interpretation row light up on essays?\n');
  for (const r of all) {
    const t = totalMass(r.mass);
    const intMass = (r.mass.Atmosphere || 0) + (r.mass.Lens || 0) + (r.mass.Paradigm || 0);
    const paradigm = pct(r.mass.Paradigm || 0, t);
    const lens     = pct(r.mass.Lens     || 0, t);
    const intShare = pct(intMass,         t);
    console.log(`  [${r.genre.padEnd(9)}] ${r.title.padEnd(28)} Paradigm=${lpad(paradigm + '%', 6)}  Lens=${lpad(lens + '%', 6)}  Interp row=${lpad(intShare + '%', 6)}`);
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ cap, docs: all, byGenre }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
