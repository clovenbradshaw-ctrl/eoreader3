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
const abbrDoc = await E.parseDocument('abbr.txt', 'Report\n\nWe checked No. 12 and Fig. 3 below. Dr. Pell signed off.', 'abbr');
const noiseDoc = await E.parseDocument('noise.txt', 'SECOND WIFE\n\nMauricio Pellegrini married again. SECOND WIFE was the chapter title. Mauricio kept the old maps. I N scanned this page. I N appears once more.', 'noise');
// A second prose source with entities disjoint from voss, for multi-doc scope.
const harbor = await E.parseDocument('harbor.txt', 'The Harbor Office\n\nByrne logged the tides each dawn. Tessaro reviewed the charts and frowned. Byrne said the channel had shifted overnight.', 'harbor');

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

// Anaphora is resolved through the ruliad (READING_RULES.anaphor_pronouns) and a
// conversation-continuity signal, not a hand-written follow-up regex.
group('route — conversation continuity (ruliad anaphor)', () => {
  // Inert without context → byte-identical to before, so parity stays pinned.
  ok(!E.referencesDoc(voss, 'tell me more about it'), 'a bare anaphor does NOT route on its own');
  // A prior grounded turn lets an anaphoric follow-up continue on the page.
  ok(E.referencesDoc(voss, 'tell me more about it', { prevGrounded: true }), 'an anaphoric follow-up continues the grounded turn');
  ok(E.referencesDoc(voss, 'and what about her?', { prevGrounded: true }), 'a third-person pronoun follow-up routes to the doc');
  // Continuity never drags a fresh topic or chit-chat onto the page.
  ok(!E.referencesDoc(voss, 'tell me a joke about penguins', { prevGrounded: true }), 'a new topic does not continue just because the last turn was grounded');
  ok(!E.referencesDoc(voss, 'thanks, that really helps', { prevGrounded: true }), 'gratitude ("that helps") does not continue — demonstratives are excluded');
  ok(!E.referencesDoc(voss, 'is he related to Zorthax?', { prevGrounded: true }), 'an anaphor plus a new, absent name is a new topic, not a continuation');
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
  // Generative whole-document asks must reach the summary (salient-sample) path,
  // not the factual one — otherwise they retrieve a single lexically-overlapping
  // line and the model parrots it instead of synthesizing.
  eq(E.classifyIntent('write a report about this'), 'summary', 'write-a-report → summary');
  eq(E.classifyIntent('write an essay'), 'summary', 'write-an-essay → summary');
  eq(E.classifyIntent('write the essay'), 'summary', 'write-the-essay → summary');
  eq(E.classifyIntent('give me a rundown'), 'summary', 'give-me-a-rundown → summary');
  eq(E.classifyIntent('write about this document'), 'summary', 'write-about-this-document → summary');
  // Specific factual asks (and table-style queries) must stay factual.
  eq(E.classifyIntent('what colour is the lamp'), 'factual', 'specific question stays factual');
  eq(E.classifyIntent('write down what Edith said'), 'factual', 'write-down-a-quote stays factual');
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

// Lexical knowledge lives in the ruliad (READING_RULES.sentence_abbreviations),
// not hardcoded in the segmenter.
group('segmenter — abbreviations rejoin (ruliad-driven)', () => {
  ok(!abbrDoc.sentenceTexts.some(t => /^\s*12\b/.test(t)), 'a number after "No." is not split into its own sentence');
  ok(abbrDoc.sentenceTexts.some(t => /No\. 12 and Fig\. 3 below/.test(t)), 'the reference abbreviations stay in one sentence');
});

group('entity extraction — header/fragment noise filtered', () => {
  const names = E.projectEntities(noiseDoc).entities.map(e => e.name);
  ok(names.some(n => /Mauricio/.test(n)), 'a real repeated name still surfaces');
  ok(!names.some(n => /^second wife$/i.test(n)), 'an all-caps multi-word header does not surface as a person');
  ok(!names.includes('I N'), 'a spaced single-letter OCR fragment does not surface');
});

// The conversation grounds against an explicit SET of sources (chips/projects),
// not just the active tab. A scope of one is identical to the single-doc path.
group('scope — grounding across an explicit source set', () => {
  const scope = [voss, harbor];
  ok(E.referencesScope(scope, 'what does Marlow want?'), 'a query about the first source routes to the scope');
  ok(E.referencesScope(scope, 'what did Byrne log at dawn?'), 'a query about the second source routes to the scope');
  ok(!E.referencesScope(scope, 'tell me a joke about penguins'), 'an unrelated request stays conversational');

  eq(E.routePrimary(scope, 'what did Byrne log at dawn?').id, harbor.id, 'a Byrne question routes to the harbor source');
  eq(E.routePrimary(scope, 'what did Marlow see at Voss Point?').id, voss.id, 'a Voss question routes to the lighthouse source');

  const hits = E.retrieveScope(scope, 'Byrne tides Marlow keeper', 6);
  ok(hits.some(h => h.docId === harbor.id), 'retrieval reaches the harbor source');
  ok(hits.some(h => h.docId === voss.id), 'retrieval also reaches the lighthouse source');
  ok(hits.every(h => h.docId), 'every scope hit is tagged with its source id');

  eq(E.referentsScope(scope, 'did Byrne ever meet Marlow?').antimatter.length, 0, 'names each present in some source are not voids');
  ok(E.referentsScope(scope, 'what did Zorthax say?').antimatter.includes('Zorthax'), 'a name absent from every source is anti-matter');

  // Scope-aware voids: a name living in the OTHER source is not voided here.
  ok(!/void:/.test(E.answerScope(scope, 'what did Marlow and Tessaro discuss?').text),
    'a name in another source is not voided when answering across scope');
  ok(/void:/.test(E.answer(voss, 'what did Marlow and Tessaro discuss?').text),
    'against a single doc, the absent name IS a void (contrast)');
});

group('void / invented terms', () => {
  eq(JSON.stringify(E.inventedTerms(voss, 'Zorthax met Blorbo')), JSON.stringify(['Zorthax', 'Blorbo']),
    'capitalised terms absent from the page are flagged invented');
  eq(E.inventedTerms(voss, 'Edith and Marlow spoke').length, 0,
    'real entities are NOT flagged invented');
  // (1a) A real entity named in the possessive ("Edith's") must not be flagged —
  // the body check strips a trailing 's first, mirroring namesEntity.
  eq(E.inventedTerms(voss, "Edith's kettle was warm").length, 0,
    'a real entity in possessive form (Edith’s) is not flagged invented');
  // voidInvented marks each flagged term as {{void:term}} so a kept-but-caveated
  // answer shows it struck rather than passing it off as grounded.
  eq(E.voidInvented('Zorthax met Edith', ['Zorthax']), '{{void:Zorthax}} met Edith',
    'voidInvented wraps an invented term and leaves real ones alone');
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

// Cost-ordered router + hybrid recall: the conversation layer obeying the same
// cheap-reader-first law the entity layer does. routeTurn is sync; retrieveHybrid
// is async and, with no window.EOEmbed in the Node harness, MUST degrade to a
// pure-lexical result identical to retrieveScope (so golden parity is untouched).
const hyb = await E.retrieveHybrid([voss], 'boat to the mainland', 6);
const hybMiss = await E.retrieveHybrid([voss], 'zzzqqq nonsense token', 6);
group('routing — cost-ordered bands (existence → structure → significance)', () => {
  const band = (q, docs) => E.routeTurn(docs || [voss], q, {});
  // SIGNIFICANCE — who/summary always belong to the source (graph portrait answers).
  eq(band('who is in this story').reason, 'who', 'who → mechanical (significance)');
  eq(band('summarize this').decision, 'mechanical', 'summary → mechanical (significance)');
  // STRUCTURE — strong lexical overlap answers now; it is never bypassed for the model.
  eq(band('what did the keeper say about the boat').reason, 'strong-lexical', 'strong overlap → mechanical');
  // STRUCTURE (entity) — a named figure locks to the page before lexical scoring.
  eq(band('what did Edith do').reason, 'names-entity', 'a named entity → mechanical');
  // STRUCTURE (table) — a parseable pivot is an exact lock.
  eq(band('total value by agent', [deals]).reason, 'pivot', 'a pivotable table query → mechanical');
  // EXISTENCE floor — an absent proper noun stays doc-directed (resolves to the void).
  eq(band('What did Zorthax say?').reason, 'antimatter-void', 'an absent name → void, not chat');
  // The ambiguous middle — a doc-directed question with no lexical signal escalates,
  // which is exactly where embedding recall earns its keep.
  eq(band('what colour is the automobile').decision, 'escalate', 'paraphrase miss → escalate band');
  // No signal at all → ordinary conversation; the model never had to decide routing.
  eq(band('tell me a joke').decision, 'chat', 'chit-chat → chat');
  eq(E.routeTurn([], 'anything', {}).decision, 'chat', 'no scope → chat');
  // HYBRID degradation (pre-computed above): no embedder ⇒ pure lexical, no throw.
  eq(hyb.reader, 'lexical', 'retrieveHybrid degrades to lexical with no embedder');
  ok(hyb.hits.length > 0, 'lexical hits still returned on a real overlap');
  eq(hybMiss.reader, 'lexical', 'a miss with no embedder stays lexical (no throw)');
  eq(hybMiss.hits.length, 0, 'a true miss returns no hits');
  ok(/^\[s\d+\] /.test(E.contextFromHits([voss], hyb.hits.slice(0, 1))), 'contextFromHits tags a single-doc span [sN]');
});

// The thinking-depth dial: level 1 is the parity floor (every knob inert =
// today), and turning it up spends more. The budget is the only thing the
// deeper-thinking paths read, so pinning the floor here pins parity above.
group('thinking depth — the dial floor is today, deeper opens up', () => {
  const b1 = E.thinkingBudget(1);
  eq(b1.maxSeekRounds, 1, 'depth 1 → one seek round (today)');
  eq(b1.seekNoveltyFloor, 1, 'depth 1 → novelty floor 1 (never continue)');
  eq(b1.assocDelta, Infinity, 'depth 1 → no associative wander (δ=∞)');
  eq(b1.assocCoupling, 0, 'depth 1 → wanderer does not press (coupling 0)');
  eq(b1.wmHeatFloor, Infinity, 'depth 1 → nothing carried hot (∞ heat floor)');
  eq(b1.inferBindFloor, Infinity, 'depth 1 → never infer');
  eq(b1.replan, false, 'depth 1 → no reconsideration');
  eq(E.thinkingBudget(0).maxSeekRounds, 1, 'an out-of-range depth clamps to the reflex floor');
  const b3 = E.thinkingBudget(3);
  ok(b3.maxSeekRounds > 1, 'deepest allows more than one seek round');
  ok(isFinite(b3.assocDelta) && b3.assocCoupling > 0, 'deepest enables associative wander');
  ok(isFinite(b3.wmHeatFloor), 'deepest gives working memory a finite heat floor');
  ok(b3.replan, 'deepest allows reconsideration');
  const r2 = E.thinkingBudget(2).maxSeekRounds;
  ok(r2 >= b1.maxSeekRounds && r2 <= b3.maxSeekRounds, 'depth 2 sits between the floor and the deepest');
});

// The conversation field is chat-scoped working memory: deposited by settled
// turns, decayed by the medium's own γ, holding pointers (never text), and
// serializable so it can ride in the chat snapshot.
group('conversation field — deposit / decay / snapshot / restore / reset', () => {
  const F = E.conversationField;
  F.reset();
  eq(F.snapshot().entities.length, 0, 'field starts empty after reset');
  eq(F.snapshot().turn, 0, 'turn counter starts at 0');
  F.deposit({ entities: ['Edith', 'the boat'], sentences: [{ docId: 'voss', idx: 2 }] }, 1);
  F.deposit({ entities: ['Edith'] }, 1);
  let snap = F.snapshot();
  eq(snap.entities[0].label, 'Edith', 'the twice-deposited entity is hottest');
  eq(snap.entities[0].heat, 2, 'repeat deposits accumulate heat');
  eq(snap.sentences.length, 1, 'a cited sentence is tracked as a pointer');
  eq(snap.sentences[0].docId, 'voss', 'the sentence pointer carries its docId');
  ok(!('t' in snap.sentences[0]) && !('text' in snap.sentences[0]), 'the field holds no document text, only pointers');
  const before = snap.entities[0].heat;
  F.decayTurn();
  snap = F.snapshot();
  eq(snap.turn, 1, 'decayTurn advances the conversational clock');
  ok(snap.entities[0].heat < before, 'heat cools after a turn');
  const saved = F.snapshot();
  F.reset();
  eq(F.snapshot().entities.length, 0, 'reset clears the field');
  F.restore(saved);
  eq(F.snapshot().entities.length, saved.entities.length, 'restore rebuilds the carried entities');
  eq(F.snapshot().turn, saved.turn, 'restore rebuilds the turn counter');
  F.reset();
});

// Working memory reads the field through the budget into a hot/warm/cold
// subgraph. It needs NO embedder (graph-hop only), so it works in the Node
// harness exactly as it degrades in the browser — and it is empty at the floor.
group('working memory — hot/warm/cold subgraph (no embedder, parity at floor)', () => {
  const F = E.conversationField; F.reset();
  F.deposit({ entities: ['Edith'], sentences: [{ docId: 'voss', idx: 1 }] }, 1);
  F.deposit({ entities: ['Edith', 'Sefton'] }, 1);
  // Floor depth ⇒ empty (the prompt then takes today's exact path).
  const wmFloor = E.buildWorkingMemory([voss], F, E.thinkingBudget(1), 'what about the boat');
  eq(wmFloor.hot.length, 0, 'floor depth carries nothing hot');
  eq(wmFloor.warm.length, 0, 'floor depth carries nothing warm');
  // Deeper ⇒ the carried entities surface, each with its document sentences, and
  // a one-hop graph neighbor warms alongside.
  const wm = E.buildWorkingMemory([voss], F, E.thinkingBudget(3), 'what about the boat');
  const edith = wm.hot.find(h => h.entity === 'Edith');
  ok(edith, 'the carried entity Edith is hot at depth 3');
  ok(edith.sents.length > 0 && edith.sents.every(s => typeof s.t === 'string'), 'a hot entity resolves to its verbatim document sentences');
  ok(wm.warm.length > 0 && wm.warm.every(w => w.oneHopFrom), 'warm entities are one graph-hop from a hot one');
  ok(wm.hot.every(h => h.heat >= E.thinkingBudget(3).wmHeatFloor), 'every hot entity clears the budget heat floor');
  F.reset();
});

// recallByHeat rewarms a cooled, carried sentence to full text when it overlaps
// the new query — old-but-relevant material reconstructs into the hot zone.
group('recall by heat — a cooled carried sentence comes back', () => {
  const F = E.conversationField; F.reset();
  const boatIdx = voss.sentenceTexts.findIndex(t => /boat/i.test(t));
  ok(boatIdx >= 0, 'the fixture has a sentence mentioning the boat');
  F.deposit({ entities: ['Sefton'], sentences: [{ docId: 'voss', idx: boatIdx }] }, 1);
  F.decayTurn(); F.decayTurn();                     // let it cool
  const rec = E.recallByHeat([voss], F, 'tell me again about the boat');
  ok(rec.some(r => r.i === boatIdx && /boat/i.test(r.t)), 'a cooled carried sentence overlapping the query is recalled with full text');
  eq(E.recallByHeat([voss], F, 'the of a to').length, 0, 'an all-stopword query recalls nothing');
  F.reset();
});

// coverageGaps augments coverage: same n/d, plus WHICH query clusters the support
// leaves uncovered — the aim point for an iterative-seeking sub-query.
group('coverage gaps — which query clusters are uncovered', () => {
  const support = 'Edith set the kettle down and listened.';
  const cg = E.coverageGaps('what did Edith carry to the lantern', support);
  const cov = E.coverage('what did Edith carry to the lantern', support);
  eq(cg.n, cov.n, 'coverageGaps agrees with coverage on the covered count');
  eq(cg.d, cov.d, 'coverageGaps agrees with coverage on the total count');
  ok(cg.covered.includes('edith'), 'a covered content token is reported as covered');
  ok(cg.uncovered.includes('lantern') && cg.uncovered.includes('carry'), 'absent content tokens are reported as uncovered');
  eq(cg.covered.length + cg.uncovered.length, cg.d, 'covered + uncovered partition the query clusters');
  const full = E.coverageGaps('Edith kettle', 'Edith set the kettle down');
  eq(full.uncovered.length, 0, 'a fully-covered query leaves no gaps');
});

// The embedder as a wandering reader degrades cleanly: with no window.EOEmbed in
// the Node harness, associativeNeighbors no-ops to [] (the app then keeps to its
// graph-hop working memory), so the no-embedder path is unchanged.
const assocMiss = await E.associativeNeighbors(voss, [1, 2, 3], E.thinkingBudget(3), 5);
const assocTable = await E.associativeNeighbors(deals, [0], E.thinkingBudget(3), 5);
const assocNoSpans = await E.associativeNeighbors(voss, [], E.thinkingBudget(3), 5);
group('associative wandering — no embedder degrades to nothing', () => {
  ok(Array.isArray(assocMiss), 'associativeNeighbors always returns an array');
  eq(assocMiss.length, 0, 'with no embedder, no associative neighbors are drawn (degrades to graph-hop)');
  eq(assocTable.length, 0, 'a table source yields no associative neighbors');
  eq(assocNoSpans.length, 0, 'no source spans ⇒ nothing to wander from');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
