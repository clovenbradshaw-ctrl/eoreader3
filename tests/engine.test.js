/* ============================================================
   Behavioural tests for the deterministic engine — the "unconscious
   process" that runs on every turn beneath the language model.

   No framework: a tiny assert runner. Run with `node tests/engine.test.js`.
   These pin the mechanical contract (parse / retrieve / route / answer /
   void / fold / cite) so the speed work that follows can be proven
   behaviour-preserving.
   ============================================================ */
'use strict';
const { loadEngine, VOSS, CSV } = require('./harness');
const ENG = loadEngine();
const E = ENG.EOEngine;
const parsePivot = (q, doc) => ENG.parsePivot(q, doc);

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); fn(); }

// A table with a money column (revenue) AND a plain count column (units),
// plus low-cardinality category columns, for the currency/pivot tests.
const SALES = `product,region,units,revenue
Widget,West,120,2400
Gadget,East,80,5600
Widget,East,200,4000
Gadget,West,50,3500`;

async function main() {
const voss = await E.parseDocument('Voss.txt', VOSS, 'voss');
const deals = await E.parseDocument('deals.csv', CSV, 'deals');
const sales = await E.parseDocument('sales.csv', SALES, 'sales');

group('parse — prose', () => {
  eq(voss.kind, 'prose', 'prose doc detected as prose');
  ok(voss.sentences.length >= 10, 'short story split into >= 10 sentences');
  eq(voss.sentences.length, voss.sentenceTexts.length, 'sentences and sentenceTexts agree');
  ok(Array.isArray(voss._events) && voss._events.length > 0, 'event log is populated');
});

group('parse — table', () => {
  eq(deals.kind, 'table', 'csv detected as table');
  eq(deals.rows.length, 14, 'all 14 data rows parsed');
  ok(deals.columns.includes('agent') && deals.columns.includes('value'), 'header parsed as columns');
});

group('entities — projection', () => {
  const { entities } = E.projectEntities(voss);
  const names = entities.map(e => e.name);
  ok(names.includes('Edith'), 'Edith surfaces as an entity');
  ok(names.some(n => /Sefton|Marlow/.test(n)), 'a second figure (Sefton/Marlow) surfaces');
  ok(entities[0].mass >= entities[entities.length - 1].mass, 'entities sorted by mass, descending');
  ok(entities.every(e => e.sents.length > 0), 'every entity is anchored to >= 1 sentence');
});

group('retrieve — relevance', () => {
  const hits = E.retrieve(voss, 'boat to the mainland', 3);
  ok(hits.length > 0, 'a content query returns hits');
  ok(hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score), 'hits sorted by score');
  ok(hits.some(h => /mainland|boat/i.test(h.t)), 'a top hit actually mentions boat/mainland');
  eq(E.retrieve(voss, 'the of a to', 3).length, 0, 'an all-stopword query retrieves nothing');
});

group('route — referencesDoc', () => {
  ok(E.referencesDoc(voss, 'who is in this story?'), 'a "who" question routes to the doc');
  ok(E.referencesDoc(voss, 'summarize this'), 'a summary request routes to the doc');
  ok(E.referencesDoc(voss, 'what does Marlow want?'), 'naming an entity routes to the doc');
  ok(!E.referencesDoc(voss, 'thanks, that really helps'), 'pure chit-chat does NOT route to the doc');
  ok(!E.referencesDoc(voss, 'tell me a joke about penguins'), 'an unrelated request stays conversational');
  ok(E.referencesDoc(deals, 'which region closed the most'), 'a column-named question routes to the table');
});

group('route — possessives (1a)', () => {
  ok(E.referencesDoc(voss, "what colour is Edith's kettle?"),
    "a possessive entity (Edith's) still routes the question to the document");
  ok(E.referencesDoc(voss, "what is in Sefton's boat?"),
    "a possessive on a second figure also routes to the document");
  ok(E.retrieve(voss, "Edith's kettle").some(h => /kettle/i.test(h.t)),
    "a possessive query retrieves the sentence its root token appears in");
  eq(JSON.stringify(E.tok("Edith's car")), JSON.stringify(['edith', 'car']),
    "tok strips the possessive 's to the root token");
});

group('intent — classification', () => {
  eq(E.classifyIntent('who are the characters'), 'who', 'who-intent');
  eq(E.classifyIntent('give me a summary'), 'summary', 'summary-intent');
  eq(E.classifyIntent('what did the keeper say'), 'factual', 'factual-intent');
});

group('answer — grounded paths', () => {
  const who = E.answer(voss, 'who is in this');
  ok(/Edith/.test(who.text), 'who-answer names Edith');
  ok(who.audit.grounded, 'who-answer is grounded');

  const fact = E.answer(voss, 'what did the keeper say about the boat');
  ok(/\{\{cite:voss:\d+:s\d+\}\}/.test(fact.text), 'factual answer carries a bound citation');
  ok(fact.audit.grounded, 'factual answer is grounded');

  const vd = E.answer(voss, 'What did Zorthax say?');
  ok(/void|⊥/.test(vd.text), 'a question about an absent term resolves to the void');
  eq(vd.audit.status, 'warn', 'void answer is flagged warn');
});

// AUDIT-FIRST: the engine must resolve/audit before it stamps "grounded".
group('audit gates the answer (audit-first)', () => {
  // Scoped void even when ANOTHER term matched — the "Napoleon → Elena" bug:
  // Zorthax is absent, Edith is present, but the absent named entity wins.
  const mixed = E.answer(voss, 'What did Zorthax say to Edith?');
  ok(/Zorthax/.test(mixed.text) && /void|⊥/.test(mixed.text), 'an absent named entity voids even when another term matched');
  ok(!mixed.audit.grounded || mixed.audit.status === 'warn', 'the mixed-match answer is not a clean grounded answer');

  // Thin coverage is HELD, not green: one weak hit (boat) cannot carry three
  // absent content terms.
  const held = E.answer(voss, 'boat quantum algorithm flux');
  eq(held.audit.status, 'held', 'a thinly-covered answer is held, not grounded');
  eq(held.audit.grounded, false, 'a held answer is explicitly NOT grounded');
  ok(/\{\{cite:voss:\d+:s\d+\}\}/.test(held.text), 'a held answer still shows the closest cited line for verification');

  // A genuinely covered factual answer stays grounded.
  const good = E.answer(voss, 'what did the keeper say about the boat');
  ok(good.audit.grounded, 'a well-covered factual answer is still grounded');
});

// ANTI-MATTER REFERENTS: names the query points at with no matter on the page.
group('anti-matter referents', () => {
  // every absent referent is surfaced, not just the first
  const multi = E.answer(voss, 'Did Caesar meet Napoleon at Voss Point?');
  ok(/Caesar/.test(multi.text) && /Napoleon/.test(multi.text), 'all anti-matter referents are surfaced, not just the first');
  eq(multi.audit.covers, '0/2', 'two anti-matter referents → covers 0/2');
  ok(/Voss Point/.test(multi.text), 'a present (matter) referent is acknowledged in the hold');
  ok(/\{\{void:Caesar\}\}/.test(multi.text), 'an anti-matter referent renders as a marked void span');

  // a single absent name still holds; a fully-present query does not
  const one = E.answer(voss, 'What did Zorthax say?');
  eq(one.audit.status, 'warn', 'a lone anti-matter referent holds (warn)');
  ok(!/appears nowhere/.test(E.answer(voss, 'what did Edith carry').text), 'an all-matter query does not trip the void');
});

group('void / invented terms', () => {
  eq(JSON.stringify(E.inventedTerms(voss, 'Zorthax met Blorbo')), JSON.stringify(['Zorthax', 'Blorbo']),
    'capitalised terms absent from the page are flagged invented');
  eq(E.inventedTerms(voss, 'Edith and Marlow spoke').length, 0,
    'real entities are NOT flagged invented');
});

group('table — deterministic fold', () => {
  const a = E.answer(deals, 'total value by agent');
  ok(/Grouped by \*\*agent\*\*/.test(a.text), 'fold groups by agent');
  ok(/Beaumont/.test(a.text) && /\$\d/.test(a.text), 'fold reports a money total per agent');
  ok(a.audit.grounded, 'fold is grounded (computed mechanically)');
});

// PIVOT BY TOKEN CLASSIFICATION: robust to phrasing, word order, typos; and it
// surfaces what it couldn't bind instead of silently dropping it.
group('table — token-classified pivot (robust phrasing)', () => {
  // a question wrapper / trailing '?' must not break the grouping
  const a = parsePivot('total value by region', deals).spec;
  const b = parsePivot('What is the total value by region?', deals).spec;
  eq(a.groupBy, 'region', 'plain phrasing groups by region');
  eq(b.groupBy, 'region', 'a question wrapper + "?" still groups by region');
  eq(JSON.stringify(a), JSON.stringify(b), 'wrapper words do not change the spec');
  eq(b.aggregate && b.aggregate.op, 'sum', 'aggregate is sum');
  eq(b.aggregate && b.aggregate.col, 'value', 'measure is value');

  // word order independent: "region totals" with no cue still groups by region
  const ord = parsePivot('region totals', deals).spec;
  eq(ord.groupBy, 'region', 'a leftover categorical column groups even without a "by" cue');

  // a typo on the column is corrected (edit distance), not dropped
  const typo = parsePivot('total value by reigon', deals);
  eq(typo.spec.groupBy, 'region', 'a column typo ("reigon") is read as "region", not dropped');
  ok(typo.notes.some(n => /reigon/.test(n) && /region/.test(n)), 'the typo correction is reported');

  // the broken filter regex bug: "where status is won" must not manufacture a
  // phantom filter — exactly one correct filter, status = won
  const filt = parsePivot('total value where status is won', deals).spec;
  eq(filt.filters.length, 1, 'one filter, not a phantom from an overlapping substring');
  eq(filt.filters[0].col, 'status', 'filter column is status');
  eq(filt.filters[0].val, 'won', 'filter value is won');
  ok(!filt.groupBy, 'the filter column is not mistaken for a grouping');

  // an unmatched column token is surfaced, not swallowed under a green chip
  const miss = parsePivot('total value by quarter', deals);
  ok(miss.unbound.some(u => u.token === 'quarter'), 'an unmatched column token is reported as unbound');
  const missAns = E.answer(deals, 'total value by quarter');
  ok(/quarter/.test(missAns.text), 'the answer says it could not bind "quarter"');
  ok(missAns.audit.status !== 'clean', 'an unbound token keeps the answer off the clean/green chip');
});

group('table — money vs plain numeric (1c)', () => {
  ok(sales.money.includes('revenue'), 'a revenue column is detected as money');
  ok(!sales.money.includes('units'), 'a plain count column (units) is NOT money');
  ok(sales.numeric.includes('units') && sales.numeric.includes('revenue'), 'both are still numeric');
});

group('table — scalar total surfaces the figure (1d)', () => {
  const a = E.answer(sales, 'total revenue for Gadget');
  ok(/\$9,100/.test(a.text), 'a bare-value question filters to Gadget and states the money total');
  eq(a.audit.covers, '1/1', 'a produced figure covers fully');

  const u = E.answer(sales, 'total units for Widget');
  ok(/\b320\b/.test(u.text), 'a units total reports the figure (320)');
  ok(!/\$/.test(u.text), 'a non-money total is NOT formatted as currency');

  const bare = E.answer(sales, 'show me the table');
  eq(bare.audit.covers, '0/1', 'a query with no measure does NOT over-claim coverage');
});

group('bindCitations — mechanical binding', () => {
  const bc = E.bindCitations(voss, 'Edith set the kettle down and listened.', 'what did Edith do', 'factual');
  ok(/\{\{cite:voss:\d+:s\d+\}\}/.test(bc.text), 'a paraphrase of a real sentence gets a citation bound');
  ok(bc.audit.grounded, 'a well-supported answer audits as grounded');
  const bad = E.bindCitations(voss, 'The spaceship departed for Jupiter at dawn.', 'unrelated', 'factual');
  ok(!bad.audit.grounded, 'an unsupported answer is NOT marked grounded');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
