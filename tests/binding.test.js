/* ============================================================
   tests/binding.test.js — the active-referent binding (Phase 1) and the
   tool-query builder that consumes it (Phase 3).

   The brief: "the field points at the best guess." The active referent the next
   turn reads is a defeasible BINDING — surface (the Given the person typed),
   name (the Meant it resolved to, read by existing consumers), a base-rate-
   calibrated confidence, and one of the three NUL states (resolved | ambiguous
   | absent) — never a settled entity. resolveBinding is the ONE resolution the
   router and the tool-query builder share, so a pronoun resolved once steers
   both the route and the Wikipedia query.

   Everything is behind the binding_resolution rule, OFF by default. OFF,
   resolveBinding is byte-identical to today's hotEntity (the heaviest hot
   entity, name only, confidence null) and bindingQuery never rewrites a query —
   the parity floor. These tests exercise the ON path (applyRules flips it).

   Run with `node tests/binding.test.js`.
   ============================================================ */
'use strict';
const { loadEngine } = require('./harness');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name) { console.log('• ' + name); }

// NDP: Tom Turner is the dominant figure; the DMC and the Partnership are the
// other projected entities; David Corman is a rival quoted once (NOT a top
// projected entity — the B1″ case).
const NDP = require('../tools/predictive/fixtures').NDP;

async function main() {
  const E = loadEngine().EOEngine;
  const doc = await E.parseDocument('NDP.txt', NDP, 'ndp');
  const F = E.conversationField;
  const seed = (names) => { F.reset(); F.decayTurn(); F.deposit({ entities: names }, 1); };
  const FLOOR = { heatFloor: 0.25 };

  group('parity floor — binding_resolution ships OFF, resolveBinding is hotEntity');
  eq(E.bindingResolutionEnabled(), false, 'binding_resolution ships OFF');
  seed(['Tom Turner']);
  {
    const b = E.resolveBinding([doc], 'what about his role', F, FLOOR);
    const topName = (F.snapshot().entities[0] || {}).label;
    eq(b.name, topName, 'OFF: binding.name is the heaviest hot entity (=hotEntity)');
    eq(b.confidence, null, 'OFF: confidence is null (no calibrated guess on the parity floor)');
    eq(b.via, null, 'OFF: no via label');
    // OFF, a cold field returns null exactly like hotEntity()
    F.reset();
    eq(E.resolveBinding([doc], 'what about his role', F, FLOOR).name, null, 'OFF + cold field: name null (hotEntity null)');
  }

  // flip the dial on for the rest
  E.applyRules([{ id: 'binding-resolution', enabled: true, value: 1 }]);
  eq(E.bindingResolutionEnabled(), true, 'applyRules turns binding_resolution ON');

  group('the precedence ladder — explicit name > chat figure > document floor');
  seed(['Tom Turner']);
  {
    // 1. an explicit name the source carries wins, even one mentioned once and
    //    NOT a top projected entity, even over a hot chat figure.
    const named = E.resolveBinding([doc], 'who is David Corman', F, FLOOR);
    eq(named.name, 'David Corman', 'explicit name in the prompt wins over the hot chat figure');
    eq(named.state, 'resolved', 'explicit name → resolved');
    eq(named.via, 'named in the question', 'via records the explicit-name win');

    // 2. the underspecified case falls to the chat field's hot figure
    const pron = E.resolveBinding([doc], 'what about his role', F, FLOOR);
    eq(pron.name, 'Tom Turner', 'a bare pronoun resolves to the hot chat figure');
    eq(pron.surface, 'his', 'the Given (the surface pronoun) is carried');
    ok(/^chat-field top-1 heat/.test(pron.via), 'via records THAT the chat carried it, with the heat — got ' + pron.via);

    // 3. document salience is the floor — reached only when the field is cold
    F.reset();
    const floorB = E.resolveBinding([doc], 'what about his role', F, FLOOR);
    eq(floorB.name, 'Tom Turner', 'cold field → document salience (the heaviest figure) is the floor');
    eq(floorB.via, 'document salience', 'via records the document-salience floor');
  }

  group('the chat field outweighs document salience (reference is a speaker act)');
  {
    // the conversation made the Partnership the figure, though Tom Turner is the
    // document's heaviest. The user's pronoun must resolve to what THEY made hot.
    seed(['Nashville Downtown Partnership']);
    const b = E.resolveBinding([doc], 'what does it fund', F, FLOOR);
    const docTop = (E.projectEntities(doc).entities[0] || {}).name;
    eq(docTop, 'Tom Turner', 'precondition: the document\'s heaviest figure is Tom Turner');
    eq(b.name, 'Nashville Downtown Partnership', 'the chat figure beats the document\'s salience');
  }

  group('the three NUL states never collapse');
  {
    // resolved — one dominant figure
    seed(['Tom Turner']);
    eq(E.resolveBinding([doc], 'what about his role', F, FLOOR).state, 'resolved', 'a dominant figure → resolved');

    // ambiguous — two figures co-deposited at equal heat
    F.reset(); F.decayTurn(); F.deposit({ entities: ['Tom Turner', 'District Management Corporation'] }, 1);
    const amb = E.resolveBinding([doc], 'what does it do', F, FLOOR);
    eq(amb.state, 'ambiguous', 'two figures tied at the floor → ambiguous (not a coin-flip pick)');
    ok(amb.runnerUp != null, 'an ambiguous binding records the runner-up it is contending with');
    // held by STATE, not by a low confidence number: the confidence stays
    // calibrated (seated on the measured tie hit-rate), the hold is state-driven.
    ok(amb.confidence != null, 'an ambiguous binding still carries a calibrated confidence');

    // absent — no antecedent anywhere
    F.reset();
    eq(E.resolveBinding([], 'what about his role', F, FLOOR).state, 'absent', 'empty scope + cold field → absent');
  }

  group('confidence is base-rate-calibrated (seated on the read, not raw heat)');
  {
    seed(['Tom Turner']);
    eq(E.resolveBinding([doc], 'who is David Corman', F, FLOOR).confidence, 0.95, 'named → binding_conf_named');
    eq(E.resolveBinding([doc], 'what about his role', F, FLOOR).confidence, 0.75, 'chat dominant → binding_conf_chat (the measured ~0.75 hit-rate, not 1.0)');
    F.reset();
    eq(E.resolveBinding([doc], 'what about his role', F, FLOOR).confidence, 0.6, 'doc floor → binding_conf_doc (~0.61)');
  }

  group('bindingQuery — the tool query is built from the binding, not the raw string');
  {
    seed(['Tom Turner']);
    const b = E.resolveBinding([doc], 'look up his employer', F, FLOOR);
    eq(E.bindingQuery('look up his employer', b), 'look up Tom Turner employer',
      'the surface pronoun is resolved to the binding name before the query is built');
    // a query that already names the target is unchanged (no surface to resolve)
    const c = E.resolveBinding([doc], 'look up the Metro Council', F, FLOOR);
    eq(E.bindingQuery('look up the Metro Council', c), 'look up the Metro Council',
      'a query with no pronoun is returned unchanged');
    // a binding with no name (absent) never rewrites
    eq(E.bindingQuery('look him up', { surface: 'him', name: null }), 'look him up',
      'an absent binding never rewrites the query');
  }

  group('Phase 2 — the router consumes the binding (anaphoric turn → names-entity, not continuity)');
  {
    seed(['Tom Turner']);
    const b = E.resolveBinding([doc], 'what about his role', F, FLOOR);
    const ctx = { everGrounded: true, prevGrounded: true, hadReply: true, hotEntity: b.name, hotBinding: b };
    const r = E.routeTurn([doc], 'what about his role', ctx);
    eq(r.decision, 'mechanical', 'a carried anaphoric follow-up still routes mechanical');
    eq(r.reason, 'names-entity', 'it routes for the RIGHT reason (the carried referent), not continuity');
    eq(r.via, 'binding', 'the route records that the carried binding supplied the entity');
    // parity: with the dial OFF the same turn falls back to continuity (today)
    E.applyRules([{ id: 'binding-resolution', enabled: true, value: 0 }]);
    const off = E.routeTurn([doc], 'what about his role', { everGrounded: true, prevGrounded: true, hadReply: true, hotEntity: 'Tom Turner' });
    eq(off.reason, 'continuity', 'OFF: the same turn routes as continuity — the parity floor, unchanged');
    E.applyRules([{ id: 'binding-resolution', enabled: true, value: 1 }]);
  }

  group('Phase 2 — the answer consumes the binding (witnesses where the raw pronoun could not)');
  {
    seed(['Tom Turner']);
    const ctx = { hotBinding: E.resolveBinding([doc], 'what about his role', F, FLOOR) };
    const a = E.answerResolved([doc], 'what about his role', ctx);
    ok(a && (a.cites || []).length > 0, 'the resolved answer BINDS (cites the page) — got ' + ((a.cites || []).length) + ' cites');
    ok(a && !(a.audit && a.audit.absent), 'it is no longer an honest absence — the referent was resolved');
    ok(a && /Tom Turner/.test(a.text || ''), 'the answer is about the carried figure — got: ' + (a && a.text || '').slice(0, 60));
    // parity: OFF, answerResolved is exactly answerScope (the bare pronoun → absence)
    E.applyRules([{ id: 'binding-resolution', enabled: true, value: 0 }]);
    const off = E.answerResolved([doc], 'what about his role', ctx);
    const base = E.answerScope([doc], 'what about his role', ctx);
    eq(off.text, base.text, 'OFF: answerResolved === answerScope (the parity floor)');
    E.applyRules([{ id: 'binding-resolution', enabled: true, value: 1 }]);
  }

  group('Phase 4 — depositTurn weights the named subject above incidental mentions');
  {
    // ON: the user named Tom Turner; the answer also mentions the DMC. The
    // subject must out-mass the co-mentioned org, or the next bare pronoun ties.
    F.reset(); F.decayTurn();
    E.depositTurn(F, 'who is Tom Turner', 'Tom Turner runs the District Management Corporation.');
    const snap = F.snapshot();
    const tom = snap.entities.find(e => /tom turner/i.test(e.label || e.key));
    const dmc = snap.entities.find(e => /district management/i.test(e.label || e.key));
    ok(tom && dmc && tom.heat > dmc.heat, 'ON: the named subject out-masses the co-mentioned org — got ' + (tom && tom.heat) + ' vs ' + (dmc && dmc.heat));
    // OFF: byte-identical to today — every name deposits at weight 1
    E.applyRules([{ id: 'binding-resolution', enabled: true, value: 0 }]);
    F.reset(); F.decayTurn();
    E.depositTurn(F, 'who is Tom Turner', 'Tom Turner runs the District Management Corporation.');
    const s2 = F.snapshot();
    const tom2 = s2.entities.find(e => /tom turner/i.test(e.label || e.key));
    const dmc2 = s2.entities.find(e => /district management/i.test(e.label || e.key));
    ok(tom2 && dmc2 && tom2.heat === dmc2.heat, 'OFF: every name deposits at weight 1 (parity floor) — got ' + (tom2 && tom2.heat) + ' vs ' + (dmc2 && dmc2.heat));
    E.applyRules([{ id: 'binding-resolution', enabled: true, value: 1 }]);
  }

  group('acceptance — "a document about Frank, then what about his role / look up his employer"');
  {
    // Frank ≈ Tom Turner here (the fixture's self-dealing protagonist).
    seed(['Tom Turner']);                                   // "who is Tom Turner" settled
    const role = E.resolveBinding([doc], 'what about his role', F, FLOOR);
    eq(role.name, 'Tom Turner', '"his" resolves to the figure the conversation made, not a figure merely on the page');
    ok(role.surface === 'his' && /chat-field/.test(role.via), 'the resolution is legible: his → chat-field → Tom Turner');
    const look = E.resolveBinding([doc], 'look up his employer', F, FLOOR);
    eq(E.bindingQuery('look up his employer', look), 'look up Tom Turner employer',
      'the acquisition query names Tom Turner\'s employer, not the word "his"');
    // end to end: the carried follow-up now ROUTES for the right reason AND ANSWERS
    const r = E.routeTurn([doc], 'what about his role', { everGrounded: true, prevGrounded: true, hadReply: true, hotEntity: role.name, hotBinding: role });
    eq(r.reason, 'names-entity', 'routes mechanically for the right reason (the carried referent)');
    const ans = E.answerResolved([doc], 'what about his role', { hotBinding: role });
    ok((ans.cites || []).length > 0, 'and the reply binds to the page (witnessed), not held as absence');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
