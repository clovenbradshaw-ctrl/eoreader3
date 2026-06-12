/* ============================================================
   tools/entity-cell-split.js — the cheap read in front of the Site-face
   correction: how much of the (Existence, Figure) cell's mass — the cell
   today named 'Thing', properly 'Entity' — was deposited by each operator?

   SIG and NUL are Existence-triad operators whose Object coordinate
   defaults to Figure (an unattributed SIG's speaker is '?'; a NUL has no
   clean target), so both land on the (Existence, Figure) cell by default,
   not by observation. This read splits the cell's mass by depositing
   operator — and splits SIG by attribution, because under the proposed
   coordinate fix only an UNATTRIBUTED SIG moves to Void (an attributed
   SIG legitimately resolves on its speaker and stays on Entity).

   Pure observation: parses each document once, addresses every event via
   eoSiteOfEvent (the one generating path), changes nothing.

   Usage: node tools/entity-cell-split.js
     reads the journalism + essay fixtures from tools/predictive/fixtures.js
   ============================================================ */
'use strict';
const path = require('path');
const { loadEngine } = require('../tests/harness');
const FIX = require('./predictive/fixtures');

const r2 = (x) => +x.toFixed(2);
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—');

async function run() {
  const E = loadEngine().EOEngine;
  const CELL = E.EO_SITE_GRID.Existence.Figure;   // the cell under read ('Thing' today, 'Entity' after the rename)
  console.log('\n# (Existence, Figure) cell — "' + CELL + '" — mass split by depositing operator');
  console.log('# journalism + essay fixtures (tools/predictive/fixtures.js); mass = ev.mass when present, else 1');

  const docs = FIX.documents().filter(d => d.genre === 'journalism' || d.genre === 'essay');
  const agg = { ops: {}, cellMass: 0, totalMass: 0, sigUnattr: 0, sigAttr: 0 };

  for (const spec of docs) {
    const doc = await E.parseDocument(spec.name, spec.text, spec.id);
    const events = doc._events || [];
    const ops = {};
    let cellMass = 0, totalMass = 0, sigUnattr = 0, sigAttr = 0;
    for (const ev of events) {
      const s = E.eoSiteOfEvent(ev);
      if (!s) continue;
      const w = (ev.mass != null && Number.isFinite(ev.mass)) ? ev.mass : 1;
      totalMass += w;
      if (s !== CELL) continue;
      cellMass += w;
      ops[ev.op] = (ops[ev.op] || 0) + w;
      if (ev.op === 'SIG') {
        if (ev.speaker && ev.speaker !== '?') sigAttr += w; else sigUnattr += w;
      }
    }
    agg.cellMass += cellMass; agg.totalMass += totalMass;
    agg.sigUnattr += sigUnattr; agg.sigAttr += sigAttr;
    for (const [op, w] of Object.entries(ops)) agg.ops[op] = (agg.ops[op] || 0) + w;

    console.log('\n## ' + spec.name + ' (' + spec.genre + ') — ' + events.length + ' events');
    console.log('   cell mass ' + r2(cellMass) + ' of ' + r2(totalMass) + ' total (' + pct(cellMass, totalMass) + ' of all site mass)');
    for (const op of Object.keys(ops).sort((a, b) => ops[b] - ops[a])) {
      let note = '';
      if (op === 'SIG') note = '   (unattributed ' + r2(sigUnattr) + ' · attributed ' + r2(sigAttr) + ')';
      console.log('     ' + op.padEnd(4) + r2(ops[op]).toString().padStart(9) + '  ' + pct(ops[op], cellMass).padStart(7) + ' of cell' + note);
    }
  }

  console.log('\n# aggregate across journalism + essays');
  console.log('  cell mass ' + r2(agg.cellMass) + ' of ' + r2(agg.totalMass) + ' total site mass (' + pct(agg.cellMass, agg.totalMass) + ')');
  for (const op of Object.keys(agg.ops).sort((a, b) => agg.ops[b] - agg.ops[a])) {
    let note = '';
    if (op === 'SIG') note = '   (unattributed ' + r2(agg.sigUnattr) + ' · attributed ' + r2(agg.sigAttr) + ')';
    console.log('    ' + op.padEnd(4) + r2(agg.ops[op]).toString().padStart(10) + '  ' + pct(agg.ops[op], agg.cellMass).padStart(7) + ' of cell' + note);
  }
  // The redistribution Change 3 would actually perform: NUL + unattributed SIG move to Void.
  const moves = (agg.ops.NUL || 0) + agg.sigUnattr;
  console.log('\n  would move to Void under the coordinate fix (NUL + unattributed SIG): '
    + r2(moves) + ' (' + pct(moves, agg.cellMass) + ' of the cell)');
  console.log('  would remain on the cell: ' + r2(agg.cellMass - moves) + ' (' + pct(agg.cellMass - moves, agg.cellMass) + ')');
}

run().catch(e => { console.error(e); process.exit(2); });
