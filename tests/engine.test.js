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
const E = loadEngine().EOEngine;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); fn(); }

const voss = E.parseDocument('Voss.txt', VOSS, 'voss');
const deals = E.parseDocument('deals.csv', CSV, 'deals');

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

group('bindCitations — mechanical binding', () => {
  const bc = E.bindCitations(voss, 'Edith set the kettle down and listened.', 'what did Edith do', 'factual');
  ok(/\{\{cite:voss:\d+:s\d+\}\}/.test(bc.text), 'a paraphrase of a real sentence gets a citation bound');
  ok(bc.audit.grounded, 'a well-supported answer audits as grounded');
  const bad = E.bindCitations(voss, 'The spaceship departed for Jupiter at dawn.', 'unrelated', 'factual');
  ok(!bad.audit.grounded, 'an unsupported answer is NOT marked grounded');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
