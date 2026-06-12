/* ============================================================
   Tests for the Site face (engine.js → EO_SITE_GRID / eoSiteOfEvent /
   the site_entity_cell rule). The cube has three dimensions (Mode,
   Domain, Object) and the Site face is Domain × Object: nine GENERATED
   cells, products of two coordinates, never points on an axis. These
   pin the level discipline:

   - the (Existence, Figure) cell is named 'Entity' under the
     site_entity_cell rule ('Thing', the legacy misname, with it off —
     the parity floor);
   - the entity subtypes (thing/person/place/org) live BENEATH the
     Entity cell on the entityType axis and never enter a site slot
     (the ingestion audit fails them as level errors);
   - SIG and NUL stop collapsing into the Entity cell by default: with
     the rule on, a NUL stall and an unattributed SIG read Object
     Ground and generate Void; an attributed SIG resolves on its
     speaker;
   - the cell is always generated from (Domain, Object) through the
     single path (eoSiteOfEvent) — every stamped site re-derives to
     itself, no second source of truth.

   Run with `node tests/site.test.js`.
   ============================================================ */
'use strict';
const { loadEngine, VOSS } = require('./harness');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

const SUBTYPES = ['thing', 'person', 'place', 'org', 'record'];

function engineWithFlag(on) {
  const W = loadEngine();
  if (on) {
    W.EO_RULES = [{ id: 'site-entity-cell', installed: true, enabled: true, value: 1 }];
    W.EOEngine.applyRules(W.EO_RULES);
  }
  return W.EOEngine;
}

async function main() {
  const Eoff = engineWithFlag(false);
  const Eon = engineWithFlag(true);

  group('the grid — nine generated cells, the flag renames exactly one', () => {
    eq(Eoff.EO_SITES.length, 9, 'flag off: nine cells');
    eq(Eon.EO_SITES.length, 9, 'flag on: nine cells');
    ok(Eoff.EO_SITES.includes('Thing') && !Eoff.EO_SITES.includes('Entity'), 'flag off: the legacy cell name Thing, no Entity');
    ok(Eon.EO_SITES.includes('Entity') && !Eon.EO_SITES.includes('Thing'), 'flag on: the cell is Entity, Thing is gone from the face');
    eq(Eon.EO_SITE_GRID.Existence.Figure, 'Entity', 'Entity is the (Existence, Figure) product');
    const offRest = Eoff.EO_SITES.filter(s => s !== 'Thing').join(',');
    const onRest = Eon.EO_SITES.filter(s => s !== 'Entity').join(',');
    eq(onRest, offRest, 'the other eight cells are untouched by the rename');
    ok(!Eon.EO_SITES.some(s => SUBTYPES.includes(s.toLowerCase())), 'no entity subtype is one of the nine cells');
  });

  group('SIG and NUL — the Object coordinate, not the cell label', () => {
    // flag off: the legacy Figure default (the collapse this work corrects)
    eq(Eoff.eoSiteOfEvent({ op: 'NUL' }), 'Thing', 'flag off: a NUL falls through to the Figure default');
    eq(Eoff.eoSiteOfEvent({ op: 'SIG', speaker: '?' }), 'Thing', 'flag off: an unattributed SIG falls through to the Figure default');
    // flag on: a stall is an existence that has not yet become a figure
    eq(Eon.eoSiteOfEvent({ op: 'NUL' }), 'Void', 'flag on: a NUL reads Object Ground → Void');
    eq(Eon.eoSiteOfEvent({ op: 'SIG', speaker: '?' }), 'Void', 'flag on: an unattributed SIG reads Object Ground → Void');
    eq(Eon.eoSiteOfEvent({ op: 'SIG' }), 'Void', 'flag on: a SIG with no speaker at all reads Object Ground → Void');
    // attribution is what moves a SIG off Void and onto an Entity
    eq(Eon.eoSiteOfEvent({ op: 'SIG', speaker: 'Edith' }), 'Entity', 'flag on: an attributed SIG resolves on its speaker → Entity');
    // the untouched operators keep their coordinates
    eq(Eon.eoSiteOfEvent({ op: 'INS', target: 'Edith' }), 'Entity', 'flag on: an INS of a referent generates Entity');
    eq(Eon.eoSiteOfEvent({ op: 'CON', o: 'Edith' }), Eoff.eoSiteOfEvent({ op: 'CON', o: 'Edith' }), 'CON is untouched by the flag');
    eq(Eon.eoSiteOfEvent({ op: 'DEF', target: 'the doctrine of signs' }), Eoff.eoSiteOfEvent({ op: 'DEF', target: 'the doctrine of signs' }), 'DEF is untouched by the flag');
  });

  const vOff = await Eoff.parseDocument('Voss.txt', VOSS, 'voss-off');
  const vOn = await Eon.parseDocument('Voss.txt', VOSS, 'voss-on');

  group('the stamp — one generating path, site ∈ EO_SITES, no level crossing', () => {
    for (const [E, doc, tag] of [[Eoff, vOff, 'off'], [Eon, vOn, 'on']]) {
      const names = new Set(E.EO_SITES);
      const stamped = (doc._events || []).filter(ev => ev.site != null);
      ok(stamped.length > 0, `flag ${tag}: the parse stamped sites`);
      eq(stamped.filter(ev => !names.has(ev.site)).length, 0, `flag ${tag}: every stamped site is one of the nine cells`);
      // the stamp re-derives to itself: the cell is generated, never copied
      eq(stamped.filter(ev => E.eoSiteOfEvent(ev) !== ev.site).length, 0, `flag ${tag}: every stamp equals its (Domain, Object) product`);
    }
    // the word collision the rename dissolves: under the legacy grid the cell
    // name 'Thing' and the subtype 'thing' are the same word at two levels
    ok((vOff._events || []).some(ev => SUBTYPES.includes(String(ev.site || '').toLowerCase())),
       'flag off: the legacy cell name collides with the subtype (the documented level error)');
    eq((vOn._events || []).filter(ev => ev.site != null && SUBTYPES.includes(String(ev.site).toLowerCase())).length, 0,
       'flag on: no entityType value stands in a site slot — the collision cannot return');
    const nulsOn = (vOn._events || []).filter(ev => ev.op === 'NUL' && ev.site);
    ok(nulsOn.every(ev => ev.site === 'Void'), 'flag on: every stamped NUL sits on Void');
    ok(!(vOn._events || []).some(ev => ev.site === 'Thing'), 'flag on: no event carries the legacy cell name');
  });

  group('the ingestion audit — the level guard', () => {
    const r = Eon.ingestionReport(vOn);
    ok(r.sites && r.sites.cells, 'the report carries the site audit');
    eq(r.sites.invalid.length, 0, 'a clean parse audits clean');
    ok(Object.keys(r.sites.cells).every(s => Eon.EO_SITES.includes(s)), 'the audit tally is keyed by the nine cells');
    // forge the level error the guard exists for: a subtype in the site slot
    const forged = (vOn._events || []).find(ev => ev.site != null);
    const was = forged.site;
    forged.site = 'thing';
    const r2 = Eon.ingestionReport(vOn);
    eq(r2.sites.invalid.length, 1, 'a subtype written into a site slot fails the audit');
    ok(r2.sites.invalid[0].level_error === true, 'and is named for what it is: a level error');
    forged.site = was;
  });

  group('the subtype — a refinement beneath the Entity cell, never a tenth cell', () => {
    eq(Eon.eoAddress('Entity', 'person'), 'Entity / person', 'the address reads cell first, subtype beneath');
    eq(Eon.eoAddress('Kind', 'person'), 'Kind', 'a subtype refines nothing outside the Entity cell');
    eq(Eon.eoAddress(null, 'person'), null, 'no site, no address');
    const r = Eon.ingestionReport(vOn);
    const person = (r.entities || []).find(e => e.type === 'person' && e.site === 'Entity');
    ok(person && person.address === 'Entity / person', 'a person referent snapshots as "Entity / person"');
  });

  console.log(`\n${fail === 0 ? '✓' : '✗'} site face — ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of fails) console.error('  ' + f); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
