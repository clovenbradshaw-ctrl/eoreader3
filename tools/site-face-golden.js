/* ============================================================
   tools/site-face-golden.js — the parallel golden for the Site-face
   correction (the site_entity_cell rule). The spec ships the Entity-cell
   rename and the SIG/NUL Object-coordinate fix behind a flag, off by
   default, with a parallel golden generated and DIFFED on the journalism
   + essay fixtures before the flag flips. This produces that artifact:
   each document parsed through the flag-OFF path (today's grid, the cell
   named 'Thing', SIG/NUL defaulting to Object Figure) and the flag-ON
   path (the cell named 'Entity'; a NUL stall and an unattributed SIG
   read Object Ground and generate Void), side by side, written to
   tests/golden-site-face.json.

     node tools/site-face-golden.js          # generate + diff
     node tools/site-face-golden.js --check  # re-generate, diff vs committed

   The diff it prints is the redistribution: how much mass left the
   (Existence, Figure) cell for Void, and by which operator. Everything
   off the Existence row must be identical on both sides — the fix
   touches one cell name and two operators' Object coordinate, nothing
   else.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require(path.join(__dirname, '..', 'tests', 'harness.js'));
const FIX = require('./predictive/fixtures');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT = path.join(ROOT, 'tests', 'golden-site-face.json');

const r2 = (x) => Math.round(x * 100) / 100;

async function buildSide(flagOn) {
  const W = loadEngine();
  const E = W.EOEngine;
  if (flagOn) {
    // standing host rules, exactly as the app maintains them — they
    // survive the ledger commits a parse triggers (verb induction)
    W.EO_RULES = [{ id: 'site-entity-cell', installed: true, enabled: true, value: 1 }];
    E.applyRules(W.EO_RULES);
  }
  const docs = [];
  for (const spec of FIX.documents()) {
    if (spec.genre !== 'journalism' && spec.genre !== 'essay') continue;
    const doc = await E.parseDocument(spec.name, spec.text, spec.id);
    // the op × site matrix, addressed through the one generating path
    const matrix = {};
    let stampedOffGrid = 0;
    const siteNames = new Set(E.EO_SITES);
    for (const ev of doc._events || []) {
      const s = E.eoSiteOfEvent(ev);
      if (!s) continue;
      const w = (ev.mass != null && Number.isFinite(ev.mass)) ? ev.mass : 1;
      if (!matrix[ev.op]) matrix[ev.op] = {};
      matrix[ev.op][s] = r2((matrix[ev.op][s] || 0) + w);
      if (ev.site != null && !siteNames.has(ev.site)) stampedOffGrid++;
    }
    const terrains = E.foldTerrains(doc);
    const cells = {};
    if (terrains) for (const [name, c] of Object.entries(terrains)) cells[name] = { mass: c.mass, bookkeeping: c.bookkeeping, events: c.events.length };
    docs.push({ id: spec.id, name: spec.name, genre: spec.genre, events: (doc._events || []).length,
                sites: [...siteNames], matrix, cells, stampedOffGrid });
  }
  return { flag: E.siteEntityCellEnabled(), docs };
}

async function main() {
  const off = await buildSide(false);
  const on = await buildSide(true);
  if (off.flag !== false || on.flag !== true) throw new Error('flag plumbing broken: off=' + off.flag + ' on=' + on.flag);

  // the redistribution summary the spec asks to confirm: mass that left the
  // (Existence, Figure) cell, split by operator
  const moved = {};
  for (let i = 0; i < off.docs.length; i++) {
    const a = off.docs[i], b = on.docs[i];
    for (const op of Object.keys(a.matrix)) {
      const was = (a.matrix[op] || {}).Thing || 0;
      const now = (b.matrix[op] || {}).Entity || 0;
      const d = r2(was - now);
      if (d) moved[op] = r2((moved[op] || 0) + d);
    }
  }

  const artifact = { schema: 'site-face-parallel-golden/1', generated: 'tools/site-face-golden.js',
                     entityMassMovedToVoidByOp: moved, off: off.docs, on: on.docs };
  const json = JSON.stringify(artifact, null, 1);

  if (process.argv.includes('--check')) {
    const prev = fs.readFileSync(ARTIFACT, 'utf8');
    if (prev === json) { console.log('✓ site-face parallel golden matches committed artifact'); return; }
    console.error('✗ site-face parallel golden DRIFTED from committed artifact');
    process.exit(1);
  }
  fs.writeFileSync(ARTIFACT, json);
  console.log('✓ site-face parallel golden →', path.relative(ROOT, ARTIFACT));
  for (let i = 0; i < off.docs.length; i++) {
    const a = off.docs[i], b = on.docs[i];
    const offThing = Object.values(a.matrix).reduce((s, row) => s + (row.Thing || 0), 0);
    const onEntity = Object.values(b.matrix).reduce((s, row) => s + (row.Entity || 0), 0);
    const onVoid = (b.cells.Void || {}).mass || 0, offVoid = (a.cells.Void || {}).mass || 0;
    console.log('  [' + a.id + '] (Existence,Figure) cell ' + r2(offThing) + ' ("Thing") → ' + r2(onEntity)
      + ' ("Entity") · Void ' + r2(offVoid) + ' → ' + r2(onVoid));
  }
  console.log('  moved to Void, by operator: ' + (Object.keys(moved).length ? JSON.stringify(moved) : 'nothing'));
}

main().catch(e => { console.error(e); process.exit(2); });
