/* ============================================================
   Tests for the three-fold address projection (engine.js →
   EO_MODE_OF_OP / EO_RESOLUTION_GRID / eoObjectOfEvent /
   eoAddressOfEvent / eoNotation). The reader was act-face biased:
   it recorded only the operator (Mode×Domain). These pin that the
   full ⟨Mode, Domain, Object⟩ address re-derives from an event with
   no second source of truth, and that Mode is a lookup (Site
   collapses it) while Object is read from the target.

   Run with `node tests/eoaddress.test.js`.
   ============================================================ */
'use strict';
const { loadEngine, VOSS } = require('./harness');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

async function main() {
  const W = loadEngine();
  W.EO_RULES = [{ id: 'site-entity-cell', installed: true, enabled: true, value: 1 }];
  W.EOEngine.applyRules(W.EO_RULES);
  const E = W.EOEngine;

  group('Mode is a lookup — the operator triad column, not the Domain row', () => {
    eq(E.EO_MODE_OF_OP.NUL, 'Differentiate', 'NUL Differentiates');
    eq(E.EO_MODE_OF_OP.SEG, 'Differentiate', 'SEG Differentiates');
    eq(E.EO_MODE_OF_OP.DEF, 'Differentiate', 'DEF Differentiates (not Generate — the column, not the row)');
    eq(E.EO_MODE_OF_OP.SIG, 'Relate', 'SIG Relates');
    eq(E.EO_MODE_OF_OP.INS, 'Generate', 'INS Generates');
    eq(E.EO_MODE_OF_OP.REC, 'Generate', 'REC Generates');
  });

  group('Resolution grid — Mode × Object, nine generated cells', () => {
    eq(E.EO_RESOLUTION_GRID.Generate.Figure, 'Making', 'Generate × Figure = Making');
    eq(E.EO_RESOLUTION_GRID.Differentiate.Ground, 'Clearing', 'Differentiate × Ground = Clearing');
    eq(E.EO_RESOLUTION_GRID.Differentiate.Pattern, 'Unraveling', 'Differentiate × Pattern = Unraveling');
    eq(E.EO_RESOLUTION_GRID.Relate.Figure, 'Binding', 'Relate × Figure = Binding');
  });

  group('eoAddressOfEvent — the full ⟨Mode, Domain, Object⟩ + the two generated cells', () => {
    const a = E.eoAddressOfEvent({ op: 'INS', target: 'Edith' });
    eq(a.mode, 'Generate', 'INS mode'); eq(a.domain, 'Existence', 'INS domain');
    eq(a.object, 'Figure', 'INS of a referent reads Object Figure');
    eq(a.site, 'Entity', 'INS site = Entity'); eq(a.resolution, 'Making', 'INS resolution = Making');
    eq(a.site, E.eoSiteOfEvent({ op: 'INS', target: 'Edith' }), 'address site agrees with eoSiteOfEvent (one source)');

    const n = E.eoAddressOfEvent({ op: 'NUL' });
    eq(n.object, 'Ground', 'NUL reads Object Ground (preserved non-resolution)');
    eq(n.site, 'Void', 'NUL site = Void'); eq(n.resolution, 'Clearing', 'NUL resolution = Differentiate × Ground = Clearing');

    const d = E.eoAddressOfEvent({ op: 'DEF', target: 'the doctrine of signs' });
    eq(d.domain, 'Interpretation', 'DEF domain'); eq(d.object, 'Pattern', 'a doctrine reads Object Pattern');
    eq(d.site, 'Paradigm', 'DEF of a doctrine = Paradigm');
  });

  group('eoNotation — operator(Site, Resolution)', () => {
    eq(E.eoNotation({ op: 'INS', target: 'Edith' }), 'INS(Entity, Making)', 'INS notation');
    eq(E.eoNotation({ op: 'NUL' }), 'NUL(Void, Clearing)', 'NUL notation');
  });

  const v = await E.parseDocument('Voss.txt', VOSS, 'voss');
  group('a real parse — every stamped event projects a coherent full address', () => {
    const evs = (v._events || []).filter(e => e.site != null);
    ok(evs.length > 0, 'the parse stamped events');
    eq(evs.filter(e => { const ad = E.eoAddressOfEvent(e); return !ad || ad.site !== e.site; }).length, 0,
       'every event address agrees with its stamped site');
    eq(evs.filter(e => { const ad = E.eoAddressOfEvent(e); return !(ad.mode && ad.resolution); }).length, 0,
       'every event projects a mode and a resolution');
  });

  console.log(`\n${fail === 0 ? '✓' : '✗'} eo address — ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of fails) console.error('  ' + f); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
