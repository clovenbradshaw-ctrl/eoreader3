/* tablequery.test.js — the schema-aware NL → table filter resolver.
   Pure module (no harness, no window): require it directly and assert the
   mechanical layer, value snapping, model-output validation, and the
   ambiguity → clarify → disambiguation back-and-forth. */
'use strict';
const TQ = require('../tablequery.js');

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log('• ' + name); } else { failed++; console.log('✗ FAIL — ' + name); } };
const eq = (name, a, b) => ok(name + '  (got ' + JSON.stringify(a) + ')', JSON.stringify(a) === JSON.stringify(b));

// A small, deliberately messy table: a value ("Mexico") that lives in two
// columns, mixed accents/spellings ("México"/"Mexico"), and a multi-word value.
const rows = [
  { 'First Name': 'Ana',   Country: 'México',      'Birth State': 'Jalisco',    'Entry Status': 'Detained' },
  { 'First Name': 'Luis',  Country: 'Mexico',      'Birth State': 'Mexico',     'Entry Status': 'Released' },
  { 'First Name': 'Marta', Country: 'Guatemala',   'Birth State': 'Petén',      'Entry Status': 'Detained' },
  { 'First Name': 'Jo',    Country: 'El Salvador', 'Birth State': 'San Miguel', 'Entry Status': 'Released' },
  { 'First Name': 'Sam',   Country: 'MEXICO',      'Birth State': 'Sonora',     'Entry Status': 'Detained' },
];
const doc = { kind: 'table', name: 'Client Info',
  columns: ['First Name', 'Country', 'Birth State', 'Entry Status'], numeric: [], date: [], money: [], rows };

// --- the deterministic scan finds which column holds the value ---------------
const guat = TQ.mechanicalResolve(doc, 'clients from Guatemala');
eq('unambiguous value binds its column', guat.spec.filters, [{ col: 'Country', op: 'eq', val: 'Guatemala' }]);
ok('unambiguous resolve is confident', guat.confident === true);

const salv = TQ.mechanicalResolve(doc, 'show me clients from el salvador');
eq('multi-word value matches', salv.spec.filters, [{ col: 'Country', op: 'eq', val: 'El Salvador' }]);

// --- a value in two columns is ambiguous → no silent guess ------------------
const mex = TQ.mechanicalResolve(doc, 'clients from Mexico');
ok('ambiguous value yields no filter', mex.spec.filters.length === 0);
ok('ambiguous value is reported', mex.ambiguities.length === 1 && mex.ambiguities[0].columns.length === 2);

// --- the back-and-forth: naming the column resolves the ambiguity -----------
const dis = TQ.mechanicalResolve(doc, 'clients where Country = Mexico');
eq('mentioned column disambiguates', dis.spec.filters.map(f => f.col), ['Country']);

// --- value snapping is accent-/case-insensitive -----------------------------
ok('snapValue maps "mexico" to a real stored form', /m.xico/i.test(TQ.snapValue(doc, 'Country', 'mexico') || ''));
ok('snapValue handles accents', !!TQ.snapValue(doc, 'Country', 'méxico'));

// --- model output is parsed and validated against the real schema -----------
const action = TQ.parseAction('Sure: {"filters":[{"column":"Country","value":"mexico"}],"clarify":null} ✓');
ok('parseAction extracts the JSON object', !!action && Array.isArray(action.filters));
const v = TQ.validate(doc, action);
eq('validate snaps column + value', v.spec.filters.map(f => f.col), ['Country']);
ok('validate reports no unknowns for a real column/value', v.unknown.length === 0);

const bad = TQ.validate(doc, { filters: [{ column: 'Nope', value: 'x' }] });
ok('validate drops a hallucinated column', bad.spec.filters.length === 0 && bad.unknown.length === 1);

// --- routing signal ----------------------------------------------------------
ok('looksLikeTableQuery true for a value question', TQ.looksLikeTableQuery('clients from Mexico', doc) === true);
ok('looksLikeTableQuery false for chit-chat', TQ.looksLikeTableQuery('hello how are you today', doc) === false);

// --- resolve() orchestration (async) ----------------------------------------
(async () => {
  const r1 = await TQ.resolve({ doc, query: 'clients from Guatemala' });
  ok('resolve → spec for a clean question (no model)', r1.kind === 'spec' && r1.spec.filters[0].col === 'Country');

  const r2 = await TQ.resolve({ doc, query: 'clients from Mexico' });
  ok('resolve → clarify for an ambiguous value (no model)', r2.kind === 'clarify' && r2.options.length === 2);

  const fakeLLM = async () => '{"filters":[{"column":"Country","value":"Mexico"}],"clarify":null}';
  const r3 = await TQ.resolve({ doc, query: 'clients from Mexico', llm: fakeLLM });
  ok('resolve → model disambiguates to Country', r3.kind === 'spec' && r3.spec.filters[0].col === 'Country');

  const askLLM = async () => '{"filters":[],"clarify":"Country or Birth State?","options":["Country","Birth State"]}';
  const r4 = await TQ.resolve({ doc, query: 'anyone tied to Mexico', llm: askLLM });
  ok('resolve → model may ask its own clarifying question', r4.kind === 'clarify' && r4.options.length === 2);

  console.log(failed ? ('\n✗ FAIL — ' + passed + ' passed, ' + failed + ' failed') : ('\n✓ PASS — ' + passed + ' passed, 0 failed'));
  process.exit(failed ? 1 : 0);
})();
