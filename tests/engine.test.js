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
function group(name, fn) { console.log('• ' + name); return fn(); }

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
// Mixed proper nouns: a place, a non-gazetteer word, OCR section labels, and a
// multi-word org — for the entity-typing contract (no person-coercion fallback).
const typeDoc = await E.parseDocument('typing.txt', 'The ship sailed from Lisbon to Cádiz. Lisbon was calm but Cádiz was not. Figure 4 shows the route. Figure 4 is missing. Appendix B lists the ports. Appendix B is lost. The Ford Foundation funded it. The Ford Foundation paid again.', 'typing');

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
  // "what's the book/story/novel about" is a whole-document overview — the noun
  // forms, not just the "what's it/this about" pronoun forms.
  eq(E.classifyIntent("what's the book about?"), 'summary', '"what\'s the book about" → summary');
  eq(E.classifyIntent('what is the story about'), 'summary', '"what is the story about" → summary');
  eq(E.classifyIntent("what's the novel about"), 'summary', '"what\'s the novel about" → summary');
  // Specific factual asks (and table-style queries) must stay factual.
  eq(E.classifyIntent('what colour is the lamp'), 'factual', 'specific question stays factual');
  eq(E.classifyIntent('write down what Edith said'), 'factual', 'write-down-a-quote stays factual');
  eq(E.classifyIntent("what's the deal"), 'factual', '"what\'s the deal" (no overview noun) stays factual');
  // A superlative/selective judgment about a cast member is NOT a request to
  // enumerate the cast — the mention-count answerWho can't weigh "funniest", so
  // these must reach the model (factual), not the 'who' path. Plain enumeration
  // (and an -est word that lands elsewhere) is untouched.
  eq(E.classifyIntent('who is the funniest character'), 'factual', 'superlative-on-character → factual, not who');
  eq(E.classifyIntent('which character is the smartest'), 'factual', 'select-among-cast → factual, not who');
  eq(E.classifyIntent('who is the most interesting person'), 'factual', 'most-X person → factual, not who');
  eq(E.classifyIntent('who is the best character'), 'factual', '"best character" → factual, not who');
  eq(E.classifyIntent('list the characters in the forest'), 'who', 'an -est word elsewhere doesn’t derail enumeration');
  eq(E.classifyIntent('who is in this story'), 'who', 'plain enumeration stays who');
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

// The reader carries the type it inferred (person/place/org/thing). The old
// projection collapsed every non-place/org entity to 'person', so places it
// didn't gazetteer (Cádiz) and OCR labels (Figure, Note) became people.
group('entity typing — non-persons are not coerced to person', () => {
  const { entities, byType } = E.projectEntities(typeDoc);
  const typeOf = new Map(entities.map(e => [e.name, e.type]));
  ok('thing' in byType, 'byType exposes a thing bucket (not folded into person)');
  ok(entities.some(e => e.type === 'thing'), 'an unrecognized proper noun lands in thing, not person');
  ok(!entities.some(e => /^(figure|appendix)$/i.test(e.name)), 'bare document-apparatus labels are filtered out');
  eq(typeOf.get('Lisbon'), 'place', 'a recognized place keeps its place type');
  if (typeOf.has('Cádiz')) ok(typeOf.get('Cádiz') !== 'person', 'a non-gazetteer proper noun is not coerced to person');
  ok(entities.some(e => /Ford Foundation/.test(e.name)), 'a multi-word name survives the bare-label filter');
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

// Possessive kin: "his son" deposits a relation the answer layer can read
// back. The observed failure: a page introduces David Corman, the next
// sentence says "his son served as…", and "whose son is mentioned?" got
// "the passages don't say" — the pronoun was never resolved into the graph.
const KIN_DOC = `The Partnership

If you own a business downtown, you pay the partnership. A significant share of that money funds the private security operation. The contract was created by the same person who runs the DMC and who then hires his own firm, NDP, to manage it. That person is Tom Turner. Turner never sought the council's approval for the budget.

NDP's Director of Safety Services is David Corman, a former precinct commander, who earned a large salary directing the private policing operation. Until recently, his son served as Director of Administration at Solaren Risk Management, overseeing payroll and compliance. The younger Corman graduated college in 2022 with a degree in geology.

"My daughter would never work there," a passerby said.`;
const kinDoc = await E.parseDocument('kin.txt', KIN_DOC, 'kin');
// Boundary fixtures: a parenthesized acronym + a name that recurs clipped,
// a short distractor next to the sentence carrying a fused name, and a
// heavy early name followed by a long silence before a stranger's quote.
const paren = await E.parseDocument('paren.txt', `The Shell
\nThe District Management Corporation (the DMC) was created in 2003. The DMC runs the downtown operation. The suit was filed in Davidson County Chancery Court last week. Davidson County Chancery had seen the agency before.`, 'paren');
const citycast = await E.parseDocument('citycast.txt', `Growth Notes
\nThe city had no plan for the cars. Former governor Lamar Alexander was interviewed on CityCast Nashville about advice he would give the city as it grows.`, 'citycast');
const cold = await E.parseDocument('cold.txt', `The Operation
\nDavid Corman ran the private policing operation. Corman earned a large salary directing it. The budget grew every year. The council never saw the terms. The garage burned in June. The insurer sued over the fire. The cars sat in the structure for months. Nobody retrieved them. The city had no plan. The contract renewal came up again. The assessment kept rising. Former governor Lamar Alexander, asked last week what advice he would give the city, put it plainly: "Keep it a nice place to live."`, 'cold');
group('kin — the possessive resolved into the graph', () => {
  const kinDefs = kinDoc._events.filter(ev => ev.op === 'DEF' && ev.path === 'kin');
  eq(kinDefs.length, 1, 'exactly one kin DEF (the quoted "my daughter" is speech, not record)');
  eq(kinDefs[0].value, 'son', 'the kin noun is recorded');
  ok(/corman/i.test(kinDefs[0].target), 'the possessor resolved to Corman (fresh momentum beats Turner\'s decayed mass)');
  const recs = E.kinRecords(kinDoc);
  eq(recs.length, 1, 'kinRecords projects the DEF');
  ok(recs[0].sent != null && recs[0].anchor != null, 'record carries the kin sentence and the possessor anchor');
  // The mechanical answer names the possessor — the one thing the raw sentence can't do.
  const whose = E.answer(kinDoc, 'whose son is mentioned?');
  ok(/David Corman/.test(whose.text), '"whose son is mentioned?" names David Corman');
  ok(whose.audit.grounded && whose.audit.status === 'clean', 'kin answer is grounded and clean');
  ok((whose.cites || []).length >= 1, 'kin answer carries cites');
  // The conversation was ABOUT Tom Turner; the answer corrects the antecedent
  // instead of silently switching subjects (the misleading-half-match failure).
  const deal = E.answerScope([kinDoc], "what's the deal with his son?", { hotEntity: 'Tom Turner' });
  ok(/no son for Tom Turner/i.test(deal.text), 'a hot Tom Turner gets the correction first');
  ok(/David Corman/.test(deal.text), '…and then the actual possessor');
  // An explicitly named non-possessor gets the same correction.
  const named = E.answer(kinDoc, "tom turner's son");
  ok(/no son for Tom Turner/i.test(named.text) && /David Corman/.test(named.text), 'naming the wrong possessor is corrected, not indulged');
  // The model path is handed the resolution too: context leads with the record
  // and joins the anchor sentence retrieval can never reach by the kin token.
  const ctx = E.context(kinDoc, 'whose son is mentioned?', 6);
  ok(/is David Corman/.test(ctx), 'context opens with the resolved possessor');
  ok(/Director of Safety Services is David Corman/.test(ctx), 'the anchor sentence rides along');
  // A bare-name ask reaches the kin sentence as graph evidence.
  ok(E.entityEvidence(kinDoc, 'corman').some(s => /his son served/.test(s.t)), 'entityEvidence for "corman" includes the kin sentence');
  // VOSS carries no kin phrases: the reader deposits nothing there (parity).
  eq(voss._events.filter(ev => ev.op === 'DEF' && ev.path === 'kin').length, 0, 'no kin DEFs on a page without kin possessives');
});

// The kin-subject veto: binding is not correctness. A draft that hangs the
// kin sentence's role on the POSSESSOR binds to that sentence with a clean
// cite while misattributing its subject — the observed failure: "who is
// david corman" answered with the son's Solaren title, passed as clean.
group('kin-subject veto — a possessor wearing the kin\'s role is flagged', () => {
  const wrong = 'David Corman is the person who served as Director of Administration at Solaren Risk Management, overseeing payroll and compliance.';
  const flagged = E.checkKinSubjects(kinDoc, wrong);
  eq(flagged.length, 1, 'the possessor wearing the son\'s role is flagged');
  ok(/corman/i.test(flagged[0].possessor) && flagged[0].kin === 'son', 'the mismatch names the possessor and the kin relation');
  eq(E.checkKinSubjects(kinDoc, "David Corman's son served as Director of Administration at Solaren Risk Management.").length, 0,
    'a draft that names the son is about the right person — not flagged');
  eq(E.checkKinSubjects(kinDoc, 'David Corman is NDP\'s Director of Safety Services, a former precinct commander.').length, 0,
    'Corman\'s own role binds to his own sentence — not flagged');
  eq(E.checkKinSubjects(voss, wrong).length, 0, 'a page without kin records flags nothing (parity)');
  const sc = E.checkKinSubjectsScope([kinDoc, voss], wrong);
  eq(sc.length, 1, 'scope variant folds per-doc');
  eq(sc[0].docId, 'kin', '…and tags the source');
  // The grounded prompt warns about the hazard even when the question never
  // asked about kin: the kin sentence is in view, so the note names whose
  // son it is — and who the sentence is NOT about.
  const parts = E.contextParts(kinDoc, 'who is david corman', 6);
  ok(parts.spans.some(s => /his son served/.test(s.text)), 'the kin sentence reaches the spans for a bare-name ask');
  ok(parts.notes.some(n => /not about David Corman/.test(n)), 'the notes say the sentence is about the son, not Corman');
});

// Entity boundaries: a capture that swallowed the close of a parenthetical
// it never opened ("(the DMC)" → "DMC)") and a canonical pick that beheads
// a name at the shape score's length penalty ("Davidson County Chancery
// Court" losing "Court" to its own clipped echo).
group('entity boundaries — unbalanced parens stripped, fuller form canonical', () => {
  const parenDoc = paren;
  const names = E.projectEntities(parenDoc).entities.map(e => e.name);
  ok(names.includes('DMC'), 'the acronym is admitted clean');
  ok(!names.some(n => /[()\[\]]/.test(n) && !/\(.*\)/.test(n)), 'no entity keeps an unbalanced bracket');
  ok(names.includes('Davidson County Chancery Court'),
    'at tied counts the fuller form is canonical — the shorter is its clipped echo, not a competing name');
  ok(!names.includes('Davidson County Chancery'), 'the beheaded form does not survive as the label');
});

// Retrieval: a multi-word name in the query is one name, not independent
// unigram hits. Without the phrase boost a short line sharing one common
// word ("the city") outranks the long sentence carrying the asked-about
// name whole — the observed three-turn CityCast disambiguation.
group('retrieve — adjacent query bigrams boost the sentence carrying the name', () => {
  const hits = E.retrieve(citycast, 'who was on city cast?', 3);
  ok(hits.length >= 2, 'both candidate sentences retrieved');
  ok(/CityCast Nashville/.test(hits[0].t), 'the fused name ("city cast" → CityCast) outranks the short distractor');
  const hits2 = E.retrieve(citycast, 'citycast nashville interview', 3);
  ok(/CityCast Nashville/.test(hits2[0].t), 'the verbatim bigram ranks the carrying sentence first');
  eq(E.retrieve(citycast, 'the of a to', 3).length, 0, 'an all-stopword query still retrieves nothing (parity)');
});

// Quote attribution: the mass-weighted fallback must be WARM. A candidate
// silent for many sentences scores on accumulated mass alone, and binding a
// quote to whoever the document mentioned MOST — rather than anyone present
// in the scene — is how a fresh in-sentence name loses its own quote to a
// heavy character from pages back. Cold candidates decline; the quote goes
// out honestly unattributed.
group('attribution — a cold heavy name does not absorb a distant quote', () => {
  const sigs = cold._events.filter(ev => ev.op === 'SIG');
  ok(sigs.length >= 1, 'the late quote is recorded');
  const late = sigs[sigs.length - 1];
  ok(!/corman/i.test(String(late.speaker)), 'the long-silent heavy name does not take the quote');
  ok(late.attributed === 'unattributed' || late.attributed === 'none' || /alexander/i.test(String(late.speaker)),
    'the quote is honestly unattributed (or bound to someone actually present)');
});

// Conversational repair: pushback is a ROUTE, not a retrieval query. The
// observed failure: "you're not listening to what i'm saying" was lexically
// dragged onto the page and answered with an unrelated line + a citation.
group('repair — pushback routes to repair, not retrieval', () => {
  const ctx = { prevGrounded: true, hadReply: true };
  const band = (q, c) => E.routeTurn([voss], q, c === undefined ? ctx : c);
  eq(band("you're not listening to what i'm saying").reason, 'repair:frustration', 'frustration → repair');
  eq(band('yeah it does').reason, 'repair:contradiction', 'contradiction → repair');
  eq(band("no it doesn't").reason, 'repair:contradiction', 'denial → repair');
  eq(band('no the son of something involved with ndp').reason, 'repair:refinement', 'a leading-no correction → repair (carries content)');
  ok(band('no the son of something involved with ndp').repair.content, 'refinement is marked content-bearing');
  eq(band("someone's sone is mentioned").reason, 'repair:refinement', 'insistence ("…is mentioned") → repair, typo and all');
  eq(band("that's not what i asked").reason, 'repair:frustration', 'misfire complaint → repair');
  // Inert without a conversation: batch/parity callers pass no ctx and see
  // exactly the old routing.
  ok(band("you're not listening to what i'm saying", {}).decision !== 'repair', 'no ctx → never repair (parity)');
  ok(band("someone's sone is mentioned", null).decision !== 'repair', 'null ctx → never repair');
  // Repair never hijacks real questions or other intents.
  eq(band('who is in this story').reason, 'who', 'who-intent keeps its path');
  eq(band('what did Edith do').reason, 'names-entity', 'a named-entity ask keeps its path');
  eq(band("but it sounds like he's not a speaker").decision !== 'repair', true, 'confirm-shaped turns keep the graph-check path');
  eq(band('no one could row to the mainland, right?').decision !== 'repair', true, '"no one…" is not a leading-no correction');
  // The signal itself, directly.
  eq(E.repairSignal('i mean the keeper').kind, 'refinement', '"i mean…" refines');
  eq((E.repairSignal('wrong') || {}).kind, 'contradiction', 'a bare "wrong" contradicts');
  ok(E.repairSignal('ugh') && E.repairSignal('ugh').kind === 'frustration', 'a bare "ugh" is frustration');
  eq(E.repairSignal('where is Voss Point'), null, 'an ordinary question is not repair');
  eq(E.repairSignal('thanks that really helps'), null, 'gratitude is not repair');
  // NON-UNDERSTANDING / NON-ANSWER — the reply itself didn't land. About the
  // exchange, not the page (the observed trace answered "i don't understand
  // your answer" with three unrelated lines that merely contained "understand").
  eq(band("i don't understand your answer").reason, 'repair:frustration', 'non-understanding of the reply → frustration');
  eq(band("i don't get it").reason, 'repair:frustration', '"i don\'t get it" → frustration');
  eq(band("that doesn't make sense").reason, 'repair:frustration', '"that doesn\'t make sense" → frustration');
  eq(band("that's not an answer").reason, 'repair:frustration', '"that\'s not an answer" → frustration');
  eq(band("you didn't answer my question").reason, 'repair:frustration', 'a dodge complaint → frustration');
  eq(E.repairSignal("i don't understand the ending"), null, '"…understand the ending" is a content question, not repair');
  eq(E.repairSignal("i'm confused about the company"), null, '"…confused about X" is a content question, not repair');
  // SUPPORT / EVIDENCE — asking what in the text backs the prior claim. Re-read
  // the reply's substance; don't lexically dump on a shared word (the observed
  // trace answered "what parts gave you that impression specifically?" with
  // three lines that merely contained "gave").
  eq(band('what parts gave you that impression specifically?').reason, 'repair:support', 'evidence request → support repair');
  eq(band('what makes you say that').reason, 'repair:support', '"what makes you say that" → support');
  eq(band('where does it say that?').reason, 'repair:support', '"where does it say that?" → support');
  eq(band('how do you know that?').reason, 'repair:support', '"how do you know that?" → support');
  ok(band('what parts gave you that impression').repair.content === false, 'a support turn carries no content of its own');
  eq(E.repairSignal('where does it say the war ended'), null, '"where does it say <clause>" is a lookup, not repair');
  eq(E.repairSignal('how do you know the password'), null, '"how do you know <noun>" is a lookup, not repair');
  // OUTPUT-FORM / META — pushing back on HOW the reply came out (the mechanical
  // span-dump), not the page. The observed trace answered "why did you switch to
  // direct quotes…" with three MORE unrelated quotes; the complaint must route to
  // repair, not lexical retrieval on the shared word.
  eq(band('why did you switch to direct quotes i saw you trying to answer the question correctly?').reason, 'repair:frustration', 'output-form complaint → frustration');
  eq(band("you're just quoting the book").reason, 'repair:frustration', '"you\'re just quoting" → frustration');
  eq(band('you keep pasting random lines').reason, 'repair:frustration', '"you keep pasting lines" → frustration');
  eq(band('stop quoting and answer the question').reason, 'repair:frustration', '"stop quoting" → frustration');
  eq(band('those are just random lines, not an answer').reason, 'repair:frustration', '"those are just lines, not an answer" → frustration');
  eq(E.repairSignal('can you quote the part about ivory'), null, 'a request to quote a passage is a lookup, not a complaint');
  eq(E.repairSignal('what lines does Kurtz speak'), null, '"what lines does X speak" is a content question, not repair');
  // IMPATIENCE / PROMPTING — a contentless nudge. "well" peppers any prose, so
  // lexical retrieval drags "well?" onto the page and badges filler quotes CLEAN;
  // route it to repair instead. Whole-utterance only — a real clause still reads.
  eq(band('well?').reason, 'repair:frustration', '"well?" impatience → frustration');
  eq(band('so?').reason, 'repair:frustration', '"so?" impatience → frustration');
  eq(band('go on').reason, 'repair:frustration', '"go on" → frustration');
  eq(band('just answer the question').reason, 'repair:frustration', '"just answer the question" → frustration');
  eq(E.repairSignal('well, who is Kurtz?'), null, '"well, <clause>" carries content — reaches the text');
  eq(E.repairSignal('so what happens to the helmsman?'), null, '"so <clause>" carries content — reaches the text');
});

// Gutenberg texts: header metadata is parsed mechanically (even when the
// punctuation-free header lines merge into one "sentence"), it rides the
// notes tier so "who wrote it?" reaches the model with the name in hand,
// and the cast is cleaned — boilerplate names and header/license-zone-only
// names are not characters. Non-Gutenberg documents are untouched.
const GBOOK = `The Project Gutenberg eBook of Crime and Punishment

Title: Crime and Punishment
Author: Fyodor Dostoyevsky
Translator: Constance Garnett
Release date: March 28, 2006
Language: English

*** START OF THE PROJECT GUTENBERG EBOOK CRIME AND PUNISHMENT ***

On an exceptionally hot evening early in July a young man came out of the garret. Raskolnikov had been lying in bed thinking about the old woman. Raskolnikov went down the stairs slowly. Sonia met Raskolnikov near the bridge and they spoke quietly. Sonia worried about him. Raskolnikov told Sonia what he had done. The old woman had kept the pledges in a box. Sonia read to Raskolnikov from her book. They sat in silence afterward. Raskolnikov left the room and walked toward the river. Sonia followed him at a distance. The city felt empty that night. Raskolnikov slept badly and dreamed of the stairs. In the morning Sonia came to see Raskolnikov again. They spoke about what would come next. Raskolnikov made his decision at last. Sonia wept and embraced him. The confession came the following day. Sonia stood in the square and watched. Raskolnikov bowed to the earth as Sonia had asked.

*** END OF THE PROJECT GUTENBERG EBOOK ***

Updated editions will replace the previous one. Project Gutenberg is a registered trademark of the Project Gutenberg Literary Archive Foundation.`;
const gbook = await E.parseDocument('crime.txt', GBOOK, 'gbook');
group('gutenberg — header metadata + a cleaned cast', () => {
  const meta = E.docMetadata(gbook);
  ok(meta.isGutenberg, 'the document detects as a Gutenberg text');
  eq(meta.fields['author'], 'Fyodor Dostoyevsky', 'Author: parsed from the header');
  eq(meta.fields['title'], 'Crime and Punishment', 'Title: parsed');
  ok(/March 28, 2006/.test(meta.fields['release date'] || ''), 'Release date: parsed');
  ok(meta.sents['author'] != null, 'the author field knows its sentence (citable)');
  const note = E.metadataNote(gbook);
  ok(/Author: Fyodor Dostoyevsky/.test(note) && /\[s\d+\]/.test(note), 'metadataNote names the author with a cite tag');
  // "who wrote it?" reaches the model with the name in the notes tier.
  const parts = E.contextParts(gbook, 'who wrote it?');
  ok(parts.notes.some(n => /Fyodor Dostoyevsky/.test(n)), 'contextParts carries the header note');
  // The cast: boilerplate and header-zone names are not characters.
  const cast = E.castEntities(gbook).map(e => e.name.toLowerCase());
  ok(!cast.some(n => n.includes('gutenberg')), 'Project Gutenberg is not in the cast');
  ok(!cast.includes('foundation'), 'the license Foundation is not in the cast');
  const who = E.answer(gbook, 'who are the main characters?');
  ok(/Raskolnikov/.test(who.text) && /Sonia/.test(who.text), 'the who-answer names the real characters');
  ok(!/Gutenberg/i.test(who.text), '…and no boilerplate');
  // The spoken summary reads the portrait, but the apparatus — boilerplate, the
  // author/translator named in the header, the language — are not the figures the
  // book "turns most on". Routed via the summary intent ("what's the book about").
  const about = E.answer(gbook, "what's the book about?");
  ok(/Raskolnikov/.test(about.text) && /Sonia/.test(about.text), 'the summary names the real figures');
  ok(!/Gutenberg|Dostoyevsky|Garnett|English/i.test(about.text), '…and not the apparatus (boilerplate, author, translator, language)');
  // supportProbeTerms: an evidence re-read's probe is the reply's substance, with
  // markup, the document's title/author tokens, and generic book-words stripped —
  // so it pins the passages instead of the title-page chrome.
  const sterms = E.supportProbeTerms([gbook], 'This novel by Fyodor Dostoyevsky follows Raskolnikov and Sonia near the bridge {{void:Petersburg}}.');
  ok(sterms.includes('raskolnikov') && sterms.includes('sonia') && sterms.includes('bridge'), 'support terms keep the discriminating words');
  ok(!sterms.includes('novel') && !sterms.includes('fyodor') && !sterms.includes('dostoyevsky') && !sterms.includes('petersburg'),
    '…and drop biblio words, the author tokens, and stripped void terms');
  // A non-Gutenberg document is untouched by the cleanup.
  const vossMeta = E.docMetadata(voss);
  ok(!vossMeta.isGutenberg && !vossMeta.any, 'VOSS carries no header metadata');
  eq(E.metadataNote(voss), '', 'no metadata ⇒ no note line');
  eq(E.castEntities(voss).length, E.projectEntities(voss).entities.length, 'castEntities is projectEntities on ordinary prose');
});

// Leaked chain-of-thought hard fail: think tags and reasoning preambles are
// vetoed (→ mechanical answer); ordinary answers — even ones starting
// "Okay," — are not.
group('veto — leaked reasoning is hard-failed', () => {
  ok(E.looksLeakedReasoning('<think>hmm</think>The author is X.'), 'a think tag anywhere hard-fails');
  ok(E.looksLeakedReasoning('<think>truncated mid-reason'), 'an unclosed think tag hard-fails');
  ok(E.looksLeakedReasoning('Okay, the user wants the author. Looking at s4…'), 'the "Okay, the user…" preamble hard-fails');
  ok(E.looksLeakedReasoning('Let me think about what the passages say.'), '"Let me think" hard-fails');
  ok(E.looksLeakedReasoning('First, I need to find the name.'), '"First, I need to" hard-fails');
  ok(!E.looksLeakedReasoning('Okay — the author is Dostoyevsky.'), 'a real answer starting "Okay" is NOT flagged');
  ok(!E.looksLeakedReasoning('The author is Dostoyevsky.'), 'a plain answer is NOT flagged');
});

// Across-turn echo guard: a reply (near-)identical to one already sent is
// detected, markup- and punctuation-insensitively.
group('repair — echoesPriorReply', () => {
  const prior = ['The passages do not mention who is the son of Tom Turner. {{cite:doc-1:10:s10}}'];
  ok(E.echoesPriorReply('The passages do not mention who is the son of Tom Turner.', prior), 'identical modulo cite markup → echo');
  ok(E.echoesPriorReply('the passages do not mention who is the son of tom turner', prior), 'case/punctuation-insensitive');
  ok(!E.echoesPriorReply('The son mentioned is David Corman’s.', prior), 'a different answer is not an echo');
  ok(!E.echoesPriorReply('No.', ['No.']), 'too short to count as a repeated reply');
  ok(!E.echoesPriorReply('anything', []), 'no priors → no echo');
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

// The inference void: the {{void}} mechanism inverted. markInferred rewrites the
// citation to the inferred-to span into {{infer}} only when BOTH ends are cited —
// a one-ended pair is an ordinary citation, not a reader-added connection.
group('inference void — mark what the reader added across two cited spans', () => {
  const bound = 'Edith waited {{cite:voss:1:s1}} while the lamp burned {{cite:voss:6:s6}}.';
  const res = E.markInferred(bound, [{ docId: 'voss', a: 1, b: 6 }]);
  ok(/\{\{infer:voss:1\+6:s1\+s6\}\}/.test(res.text), 'the inferred-to span is rewritten as an {{infer}} marker');
  ok(/\{\{cite:voss:1:s1\}\}/.test(res.text), 'the other end stays a plain citation');
  eq(res.inferred.length, 1, 'one pair was marked');
  eq(res.inferred[0].b, 6, 'the marked pair records the inferred-to span');
  // both ends must be present
  const oneEnd = E.markInferred('Only one span {{cite:voss:1:s1}} here.', [{ docId: 'voss', a: 1, b: 6 }]);
  eq(oneEnd.inferred.length, 0, 'a pair with only one end cited is not an inference');
  eq(oneEnd.text, 'Only one span {{cite:voss:1:s1}} here.', 'a non-inference leaves the text untouched');
});

// Reconsideration reads a draft for refusal so a turn can SEG its own plan
// (a refused summary re-routes to creative rather than recycling the refusal).
group('reconsideration — a refusal is detected (plan SEG)', () => {
  ok(E.looksRefused('I cannot provide a summary of this document.'), 'a plain refusal is detected');
  ok(E.looksRefused("I'm sorry, but I can't create that."), 'a softened refusal is detected');
  ok(E.looksRefused(''), 'an empty draft counts as a refusal');
  ok(!E.looksRefused('Edith set the kettle down and listened by the lamp.'), 'a real answer is not a refusal');
  ok(!E.looksRefused('The keeper said no one could row to the mainland.'), 'a substantive sentence is not a refusal');
});

// ── The transcript pack: timecodes are structure, labels are attribution ──
const MEETING = `0:00:01.000,0:00:04.000
Speaker 1: Good evening everyone and welcome to the council meeting.
0:00:05.000,0:00:09.000
Speaker 1: We will begin with the invocation. Thank you.
0:00:10.000,0:00:14.000
Speaker 2: Thank you, Mister Chairman. Please rise.
0:00:15.000,0:00:21.000
Speaker 4: Amos Dresser was a white minister who came south. Amos Dresser was seized by the committee.
0:00:22.000,0:00:25.000
Speaker 4: He was whipped in the public square. Steven Watts recorded the event.
0:00:26.000,0:00:28.000
Speaker 3: Thank you, Steven Watts. The motion passes.
`;
const meeting = await E.parseDocument('meeting.txt', MEETING, 'meet');
// Deferred demonstrative naming: a role-bearing actor described first, named a
// beat later. The copular reader refuses "That person is …" (bare demonstrative
// subject), so without the naming bridge the role is stranded on a phrase that
// was never instantiated and the name lands empty.
const NAMING = 'The Setup\n\nThe contract is run through a shell company created by the same person who runs the DMC and who then hires his own firm, NDP, to manage operations. That person is Tom Turner. Turner also chairs the council board.';
const naming = await E.parseDocument('naming.txt', NAMING, 'nm');
group('transcript pack — the page declares the genre, the reader adapts', () => {
  eq(meeting.kind, 'prose', 'timecode commas do not misread as a CSV table');
  eq(meeting._genre, 'transcript', 'the genre is detected and recorded');
  ok(/transcript/.test(meeting.meta), 'the meta line names the genre');
  ok(!meeting.sentenceTexts.some(t => /0:00:\d\d/.test(t)), 'timecodes never become sentence content');
  ok(!meeting.sentenceTexts.some(t => /^Speaker \d+:/.test(t)), 'speaker labels are stripped from the prose');
  const { entities } = E.projectEntities(meeting);
  const names = entities.map(e => e.name);
  ok(names.includes('Speaker 4'), 'a voice is admitted as an entity through the label slot');
  const s4 = entities.find(e => e.name === 'Speaker 4');
  ok(s4 && s4.type === 'person' && s4.sents.length >= 3, 'a voice is a person whose mentions are its turn sentences');
  ok(!names.includes('Speaker'), 'the bare label "Speaker" is not an entity');
  ok(!names.some(n => /^Thank$/i.test(n)), 'formulaic discourse ("Thank") is not an entity');
  ok(names.includes('Amos Dresser'), 'a figure spoken ABOUT still surfaces');
  ok((meeting._voices || []).length === 4, 'all four voices are recorded');
});

{
  const PLAY = 'MAYOR: The session will come to order. We have a full agenda.\nCLERK: The minutes are ready for review.\nMAYOR: Thank you. Moving on to public comment.\nCLERK: Three speakers signed up.\nMAYOR: Call the first.\n';
  const play = await E.parseDocument('play.txt', PLAY, 'play');
  group('transcript pack — labels alone declare the genre', () => {
    eq(play._genre, 'transcript', 'recurring NAME: labels read as a transcript');
    const names = E.projectEntities(play).entities.map(e => e.name);
    ok(names.includes('MAYOR') || names.includes('Mayor'), 'the MAYOR voice is an entity');
    ok(!play.sentenceTexts.some(t => /^(MAYOR|CLERK):/.test(t)), 'labels left the prose');
  });
}
group('transcript pack — ordinary prose is untouched', () => {
  ok(voss._genre == null, 'a short story is not a transcript');
  ok(!VOSS.includes('normalized'), 'sanity: fixture unchanged');
});

// ── Graph traversal: the graph as the answer mechanism ──
group('traversal — entries, walk, assertions, attached evidence', () => {
  const t1 = E.traverseGraph(meeting, 'was Amos Dresser a white minister?', 1);
  ok(t1 && t1.entries.includes('Amos Dresser'), 'the question\'s referent is the entry node');
  ok(t1.assertions.some(a => /white minister/.test(a.is)), 'the page\'s DEF assertion rides the walk');
  ok(t1.sentences.some(s => /white minister/.test(s.t)), 'the assertion\'s sentence is gathered as evidence');
  ok(t1.sentences.every(s => s.via), 'every gathered sentence names how the walk reached it');
  const t2 = E.traverseGraph(meeting, 'was Amos Dresser a white minister?', 2);
  const w2 = t2.walked.map(w => w.name);
  ok(w2.includes('Steven Watts'), 'a second hop reaches a co-occurring referent the first hop cannot');
  ok(t2.walked.every(w => w.hop >= 1 && w.via), 'walked nodes carry their hop and their path');
  eq(E.traverseGraph(meeting, 'what is the airspeed of a swallow?', 2), null, 'a question naming nothing on the page walks nowhere (null)');
  eq(E.traverseGraph(meeting, 'was Amos Dresser a white minister?', 0), null, 'zero hops (the floor) never walks');
});

group('traversal — scope fold and the reading context (the graph speaking)', () => {
  const trav = E.traverseScope([meeting], 'tell me about Amos Dresser', 1);
  ok(trav && trav.perDoc.length === 1 && trav.perDoc[0].docId === 'meet', 'scope traversal tags its source');
  const base = '[s8] Steven Watts recorded the event.';
  const ctx = E.readingContext([meeting], trav, base);
  ok(/What the reading holds/.test(ctx), 'the context opens with the reading, not a span dump');
  ok(/The page asserts: Amos Dresser is a white minister/.test(ctx), 'the page\'s assertion is presented as the page\'s');
  ok(ctx.includes(base), 'the retrieval passages survive underneath');
  ok(/\[s5\]/.test(ctx), 'evidence the walk reached that retrieval missed is appended in citation format');
  eq((ctx.match(/\[s8\]/g) || []).length, 1, 'a span already in the context is not duplicated');
  eq(E.readingContext([meeting], null, base), base, 'no traversal ⇒ context unchanged (parity)');
});

// ── The conversation field as a prior on the walk's entries ──
// Gated by tools/predictive/read-conv-entry.js: on 81% of follow-ups whose
// question does not name the anchor, the field already holds it hot — so the
// hot entities seed the walk alongside the named ones.
group('traversal — the conversation field carries the entry the question does not name', () => {
  const F = E.conversationField;
  F.reset();
  F.deposit({ entities: ['Amos Dresser'] }, 1);
  F.decayTurn();                                    // heat 0.7 — hot at the dial's floor (0.25)
  const t = E.traverseGraph(meeting, 'tell me more about him', 2, F, 0.25);
  ok(t && t.fieldEntries.length === 1 && t.fieldEntries[0].name === 'Amos Dresser',
     'a question naming nothing on the page walks from the conversation\'s hot entity');
  eq(t.entries.length, 0, 'the carried entry is never claimed as named in the question');
  ok(t.assertions.some(a => /white minister/.test(a.is)), 'the page\'s assertion rides the carried walk');
  eq(E.traverseGraph(meeting, 'tell me more about him', 2), null, 'no field passed ⇒ exactly the old walk (parity)');
  eq(E.traverseGraph(meeting, 'tell me more about him', 2, F, Infinity), null, 'the dial\'s ∞ heat floor carries nothing (parity)');
  for (let i = 0; i < 4; i++) F.decayTurn();        // 0.7^5 ≈ 0.17 < 0.25
  eq(E.traverseGraph(meeting, 'tell me more about him', 2, F, 0.25), null, 'a cooled topic no longer seeds the walk');
  F.reset(); F.deposit({ entities: ['Amos Dresser'] }, 1); F.decayTurn();
  const t2 = E.traverseGraph(meeting, 'was Amos Dresser a white minister?', 2, F, 0.25);
  ok(t2.entries.includes('Amos Dresser') && t2.fieldEntries.length === 0,
     'a named entry is never doubled as a carried one');
  const ts = E.traverseScope([meeting], 'what about his role', 1, F, 0.25);
  ok(ts && ts.fieldEntries.includes('Amos Dresser'), 'scope traversal surfaces the carried entries');
  const ctx = E.readingContext([meeting], ts, '');
  ok(/carried by the conversation, not named in this question/.test(ctx),
     'the prompt names the anchor as the conversation\'s, not the question\'s');
  F.reset();
});

// ── The propositional veto: claim against claim ──
group('assertions — the page\'s own DEF claims, resolved onto entities', () => {
  const defs = E.assertionsOf(meeting);
  ok(defs.some(d => d.subject === 'Amos Dresser' && /white minister/.test(d.is)), 'the copular assertion is held with its subject resolved');
  ok(defs.every(d => d.sent == null || meeting.sentenceTexts[d.sent]), 'every assertion points at a real sentence');
  ok(!defs.some(d => /^(he|she|they|it)$/i.test(d.subject)), 'an unresolved pronoun subject is never an assertion');
});

// ── The naming bridge: a deferred demonstrative naming carries the role ──
group('naming bridge — "the X who … . That X is Name" attaches the role to Name', () => {
  const defs = E.assertionsOf(naming);
  const t = defs.find(d => d.subject === 'Tom Turner');
  ok(t, 'the named actor surfaces as an assertion subject');
  ok(t && /runs the DMC/.test(t.is) && /NDP/.test(t.is), 'the antecedent description (the role) attaches to the name');
  ok(t && naming.sentenceTexts[t.sent] && naming.sentenceTexts[t.sent].includes(t.is),
     'the assertion is cited to the sentence that actually carries the description (clean re-read)');
  ok(!defs.some(d => /^(that|this|the)\s/i.test(d.subject)), 'the bare demonstrative never becomes an assertion subject');
  const trav = E.traverseGraph(naming, "what is Tom Turner's role?", 2);
  ok(trav && trav.assertions.some(a => a.subject === 'Tom Turner' && /NDP/.test(a.is)),
     'the role is reachable by graph traversal for a who/role question');
});

group('propositional veto — a draft that denies the page\'s assertion is caught', () => {
  const draft = 'The passage states that Amos Dresser was not a white minister.';
  const c = E.checkAssertions(meeting, draft);
  ok(c.length === 1 && c[0].subject === 'Amos Dresser', 'the contradiction is caught and names its subject');
  ok(/white minister/.test(c[0].is) && /not a white minister/.test(c[0].claim), 'it carries both the page\'s claim and the draft\'s');
  eq(E.checkAssertions(meeting, 'Amos Dresser was a white minister who was seized.').length, 0, 'an agreeing draft passes');
  eq(E.checkAssertions(meeting, 'Dresser was not only a white minister but also brave.').length, 0, '"not only" affirms and is not flagged');
  eq(E.checkAssertions(meeting, 'The committee never apologized.').length, 0, 'a negation about something unasserted passes');
  const sc = E.checkAssertionsScope([meeting, voss], 'Dresser was never seized by the committee.');
  ok(sc.length === 1 && sc[0].docId === 'meet', 'the scope check carries the source docId');
});

// ── Seeking aims at the page, not at words about the question ──
group('seekable terms — meta-words from the user\'s phrasing are unseekable', () => {
  const terms = E.seekableTerms([meeting], ['mistakes', 'minister', 'committee', 'unicorn']);
  ok(terms.includes('minister') && terms.includes('committee'), 'terms the page carries stay seekable');
  ok(!terms.includes('mistakes') && !terms.includes('unicorn'), 'terms nowhere in the sources are dropped');
  eq(E.seekableTerms([], ['minister']).length, 0, 'no sources ⇒ nothing seekable');
});

// ── The dial buys graph work; the EFFORT floor stays inert (parity) ──
group('thinking depth — graph knobs scale, the floor is byte-inert', () => {
  const b1 = E.thinkingBudget(1), b2 = E.thinkingBudget(2), b3 = E.thinkingBudget(3);
  eq(b1.graphHops, 0, 'floor: no walk');
  eq(b2.graphHops, 1, 'mid-dial: one hop');
  eq(b3.graphHops, 2, 'deepest: the full ceiling');
  // assertion-check is an HONESTY knob, not an effort knob: auditing a draft
  // against the page's recorded assertions is the floor of what "grounded"
  // means, so it runs at EVERY depth (the one exception to the inert floor).
  eq(b1.assertionCheck, true, 'floor: the propositional veto runs — honesty is not a luxury depth buys');
  eq(b2.assertionCheck, true, 'mid-dial: still on');
  eq(b3.assertionCheck, true, 'deepest: still on');
  eq(b1.maxSeekRounds, 1, 'floor seek rounds unchanged (parity)');
  eq(b1.replan, false, 'floor replan unchanged (parity)');
});

// ── The cap-harvest no longer strikes connective tissue ──
group('invented terms — a capitalized discourse adverb is not an entity', () => {
  ok(!E.inventedTerms(voss, 'Therefore, Edith waited by the lamp.').includes('Therefore'), '"Therefore" is the draft\'s own connective, never invented');
  ok(!E.inventedTerms(voss, 'However, the keeper stayed.').includes('However'), '"However" likewise');
  ok(E.inventedTerms(voss, 'Zorthax waited by the lamp.').includes('Zorthax'), 'a real off-page name still trips the veto');
});

// ── The discourse-word void guard: a correct "Yes" is not an invented term ──
group('invented terms — an answer\'s own discourse words are never struck', () => {
  ok(!E.inventedTerms(meeting, 'Yes, Amos Dresser was seized by the committee.').includes('Yes'), 'a confirmation\'s "Yes" is the answer\'s word, not a page term');
  ok(!E.inventedTerms(meeting, 'Indeed, the motion passed.').includes('Indeed'), '"Indeed" likewise');
  ok(E.inventedTerms(meeting, 'It happened in Tennessee.').includes('Tennessee'), 'a real off-page place still trips the veto — the page does not carry it');
});

// ── The draft splitter no longer fragments on "Mr." ──
group('splitDraft — abbreviations and initials rejoin (same set as the segmenter)', () => {
  const parts = E.splitDraft('The speakers included Mr. Steven Watts and Mr. Amos Dresser. The motion passed.');
  eq(parts.length, 2, 'two real sentences, not four fragments');
  ok(/Mr\. Steven Watts and Mr\. Amos Dresser/.test(parts[0]), 'the names survive whole');
  eq(E.splitDraft('Dr. Pell signed off.').length, 1, 'a leading title does not split');
  eq(E.splitDraft('W. E. B. Du Bois wrote it.').length, 1, 'single-letter initials rejoin');
  eq(E.splitDraft('Edith waited. The keeper stayed.').length, 2, 'ordinary sentences still split');
});

// ── The binder: junk-short lines can no longer support a claim ──
group('bindCitations — a two-token line ("Thank you.") is not support', () => {
  // the trace's turn 6: gibberish that audited clean because "Thank you."
  // (substantive set {thank}, score 1/√2 on one shared token) outranked
  // every real sentence for any claim sharing one word
  const junk = E.bindCitations(meeting, 'The passage states that Speaker 2 is Thank you.', 'who spoke', 'factual');
  eq(junk.cites.length, 0, 'no citation is lashed to the formulaic line');
  eq(junk.audit.grounded, false, 'the recombined claim audits NOT grounded — the badge stops lying');
  // a real claim still binds — the floor rejects junk, not support
  const real = E.bindCitations(meeting, 'Amos Dresser was seized by the committee.', 'what happened to Dresser', 'factual');
  eq(real.cites.length, 1, 'a verbatim-supported claim still earns its cite');
  eq(real.audit.grounded, true, 'and still audits grounded');
  // chips no longer scatter mid-name: "Mr." fragments inflated the cited
  // fraction and dropped chips after the title
  const titled = E.bindCitations(meeting, 'Mr. Steven Watts recorded the event. Mr. Amos Dresser was seized by the committee.', 'who recorded it', 'factual');
  ok(!/Mr\.\s*\{\{cite/.test(titled.text), 'no chip lands after a bare "Mr."');
  eq(titled.cites.length, 2, 'both whole claims bind');
});

// ── Absence attestation: a true negative cites ⊥ with a scan receipt ──
group('bindCitations — a negative existential is attested, never lashed to a line', () => {
  // the trace's turn 5: "The text does not mention him as a speaker" — true,
  // and bound to s3 ("Thank you."), a nonsense cite on a true claim. Retrieval
  // can never ground a negative; only a scan can.
  const neg = E.bindCitations(meeting, 'The text does not mention him as a speaker.', 'was he a speaker', 'factual', { hotEntity: 'Amos Dresser' });
  ok(/\{\{absent:meet:/.test(neg.text), 'the claim cites ⊥ with a receipt instead of a junk line');
  eq(neg.cites.length, 0, 'no sentence cite is faked for a whole-document claim');
  eq(neg.audit.grounded, true, 'the attested negative IS grounded — absence is evidence');
  // a FALSE denial earns nothing: the page does attribute speech to Speaker 4
  const f = E.bindCitations(meeting, 'The record never attributes a speech to Speaker 4.', 'who spoke', 'factual');
  ok(!/\{\{absent:/.test(f.text), 'a denial the events contradict is not attested');
  // scope: absence must verify in EVERY source
  const sc = E.bindCitationsScope([meeting, voss], 'Zorthax is never mentioned.', 'who is Zorthax', 'factual');
  ok(/\{\{absent:.*checked in all 2 sources/.test(sc.text), 'a scope-wide absence carries the scope-wide receipt');
});

// ── The phantom-voice routing fix: "speaker" is a role word, not a name ──
group('routing — a generic voice label no longer hijacks meta-conversation', () => {
  const r = E.routeTurn([meeting], "but it sounds like he's not a speaker");
  ok(r.reason !== 'names-entity', 'the word "speaker" does not read as naming the voice "Speaker 2"');
  const r2 = E.routeTurn([meeting], "but it sounds like he's not a speaker", { prevGrounded: true });
  eq(r2.decision, 'mechanical', 'with a grounded prior turn, the anaphor keeps it on the page (continuity)');
  eq(r2.intent, 'confirm', 'and the turn is recognized as a proposition to check');
  const r3 = E.routeTurn([meeting], 'what did Speaker 2 say');
  eq(r3.reason, 'names-entity', 'the FULL label still names the voice');
});

// ── CONFIRM/DENY: the operator-void made an intent ──
group('classifyIntent — a proposition offered for checking is confirm, not factual', () => {
  eq(E.classifyIntent('Is Amos Dresser the white minister who came south?'), 'confirm', 'a copular yes/no question');
  eq(E.classifyIntent("but it sounds like he's not a speaker"), 'confirm', 'a hedged denial');
  eq(E.classifyIntent('He is dead. He was not a speaker.'), 'confirm', 'bare declaratives offered for checking');
  eq(E.classifyIntent('you said he was a speaker'), 'confirm', 'a challenge to a prior claim');
  eq(E.classifyIntent('Edith was the keeper of the lamp, right?'), 'confirm', 'a tag question');
  eq(E.classifyIntent('what did the keeper say about the boat'), 'factual', 'a wh-question stays factual');
  eq(E.classifyIntent('who is in this story'), 'who', 'the who intent is untouched');
  eq(E.classifyIntent('summarize this'), 'summary', 'the summary intent is untouched');
  eq(E.classifyIntent("Edith's kettle boiled over."), 'factual', 'a possessive is not a copula');
});

group('answerConfirm — confirmed / contradicted / absence-attested, no model involved', () => {
  // confirmed against the page's own DEF assertion, with the cite
  const yes = E.answerConfirm(meeting, 'Is Amos Dresser the white minister who came south?');
  ok(yes && /Yes — the page itself asserts/.test(yes.text), 'a true proposition is confirmed in the page\'s own words');
  ok(yes.cites.length === 1 && /\{\{cite:meet:/.test(yes.text), 'the confirmation carries the assertion\'s cite');
  eq(yes.audit.status, 'clean', 'confirmed is a clean badge');
  eq(yes.checks[0].verdict, 'confirmed', 'the verdict is recorded for the trace');
  // a denial of what the page asserts is contradicted, with the cite
  const no = E.answerConfirm(meeting, 'Amos Dresser was not a white minister.');
  ok(no && /No — the page itself asserts/.test(no.text), 'a denial of a page assertion is contradicted');
  eq(no.checks[0].verdict, 'contradicted', 'and recorded as such');
  // the trace's turns 4/5: "he was not a speaker" — TRUE, provable only by
  // scanning every attribution event; the graph attests what retrieval never could
  const abs = E.answerConfirm(meeting, 'he was not a speaker', { hotEntity: 'Amos Dresser' });
  ok(abs && /Confirmed — I scanned all \d+ attribution events/.test(abs.text), 'a true negative is confirmed by a full scan');
  ok(/\{\{absent:meet:/.test(abs.text), 'and cites ⊥ with the receipt');
  eq(abs.checks[0].verdict, 'confirmed-by-absence', 'verdict: confirmed by absence');
  eq(abs.audit.status, 'clean', 'a complete mechanical answer wears clean');
  eq(E.answerConfirm(meeting, 'he was not a speaker'), null, 'an unresolvable anaphor declines rather than guessing');
  // an affirmative role claim the events do not support
  const den = E.answerConfirm(meeting, 'Was Amos Dresser a speaker?');
  ok(den && /never holds the speaker slot/.test(den.text), 'an unsupported role claim is denied with the scan');
  eq(den.checks[0].verdict, 'denied-by-absence', 'verdict: denied by absence');
  // a voice that DOES hold the slot
  const spoke = E.answerConfirm(meeting, 'Did Speaker 4 speak?');
  ok(spoke && /Yes — this transcript attributes \d+ turn/.test(spoke.text), 'a voice with SIG slots is confirmed with its turn count');
  // unattested: the page asserts nothing either way → ⊥ with the receipt, warn
  const un = E.answerConfirm(meeting, 'Amos Dresser was a council member.');
  ok(un && /never asserts/.test(un.text) && /\{\{absent:/.test(un.text), 'an unattested claim is named as such with a receipt');
  eq(un.audit.status, 'warn', 'unattested-affirmative wears warn, not clean');
  eq(un.checks[0].verdict, 'unattested', 'verdict: unattested');
  // no proposition → null, the caller keeps its ordinary path
  eq(E.answerConfirm(meeting, 'what happened at the council meeting?'), null, 'a wh-question does not parse as a proposition');
  // the scope fold answers from the source whose graph can check it
  const sc = E.answerConfirmScope([voss, meeting], 'Was Amos Dresser a white minister?');
  ok(sc && /Yes — the page itself asserts/.test(sc.text), 'the scope fold finds the source that holds the assertion');
});

// ── the false-premise fix: verb-predicate & article-led propositions ──
// Before this, "Mara Velasquez founded Veldmar" / "The treaty was signed in
// 1776" routed to 'factual', hit the grounded-QA path, and a FALSE premise came
// back stamped "grounded · covers N/M" on retrieval overlap rather than truth.
group('classifyIntent — verb-predicate & article-led assertions route to confirm', () => {
  eq(E.classifyIntent('Mara Velasquez founded Veldmar'), 'confirm', 'a transitive-verb assertion is a proposition');
  eq(E.classifyIntent('Shakespeare wrote Hamlet'), 'confirm', 'an irregular-past verb assertion is a proposition');
  eq(E.classifyIntent('The treaty was signed in 1776'), 'confirm', 'an article-led subject is a proposition');
  eq(E.classifyIntent('Steven Watts recorded the event'), 'confirm', 'a verb-predicate about a named figure');
  // the instruction / non-claim shapes stay OUT of confirm (no false routing)
  eq(E.classifyIntent('Tell me everything about the meeting'), 'factual', 'a bare instruction is not a claim about "Tell"');
  eq(E.classifyIntent('The point is moot'), 'factual', 'a discourse-filler article subject is not a proposition');
  eq(E.classifyIntent('List the speakers'), 'factual', 'an imperative stays factual');
});

group('answerConfirm — a verb-predicate is checked against the prose, never lexical overlap', () => {
  // a verb-predicate the page actually STATES is confirmed in its own words, cited
  const rec = E.answerConfirm(meeting, 'Steven Watts recorded the event.');
  ok(rec && /Yes — the page states this/.test(rec.text), 'a true verb-predicate is confirmed from the sentence that makes the claim');
  ok(rec.cites.length === 1 && /\{\{cite:meet:/.test(rec.text), 'and carries that sentence\'s cite');
  eq(rec.checks[0].verdict, 'confirmed', 'verdict: confirmed');
  // THE HEADLINE BUG: a false transitive-verb premise is attested as silence,
  // not affirmed — covers 0/1, warn, never a grounded badge.
  const fv = E.answerConfirm(meeting, 'Steven Watts founded the committee.');
  ok(fv && /never asserts/.test(fv.text) && /\{\{absent:meet:/.test(fv.text), 'a false verb-predicate is named unattested with a receipt');
  eq(fv.audit.status, 'warn', 'an unattested verb-predicate wears warn, not grounded');
  eq(fv.audit.covers, '0/1', 'and covers 0/1 — not retrieval coverage');
  eq(fv.checks[0].verdict, 'unattested', 'verdict: unattested');
  // the entity scope prevents cross-subject confirmation: the page says STEVEN
  // WATTS recorded the event, so the same claim about Amos Dresser is silence.
  const cross = E.answerConfirm(meeting, 'Amos Dresser recorded the event.');
  ok(cross && /never asserts/.test(cross.text), 'a verb claim true of another figure is not confirmed for this one');
});

group('answerConfirm — the DEF check is an ordered phrase match, not a bag of words', () => {
  // the predicate's head words must sit TOGETHER and IN ORDER in the page's own
  // assertion. Reordered head words that merely co-occur in the DEF value
  // ("white minister" present, asked as "south minister who came white") no
  // longer earn "Yes — the page itself asserts…".
  const reordered = E.answerConfirm(meeting, 'Is Amos Dresser the south minister who came white?');
  ok(!(reordered && /Yes — the page itself asserts/.test(reordered.text)), 'reordered head words do not false-confirm against the DEF');
});

// ── the over-strict guardrail: a strong hit grounds a thin-ratio answer ──
// A long, multi-clause question inflates the coverage denominator, so a single
// sentence that genuinely answers it could fall under the floor on token ratio
// and get HELD as "ungrounded" — the opposite failure from the false-confirm
// bug. A strong lexical hit (the ≥0.5 answer-now bar) now carries it.
await group('answerProse — a strong lexical hit grounds despite a long question thinning the ratio', async () => {
  const reef = await E.parseDocument('reef.txt', 'Mirabel charted the reefs.\nThe harbor was quiet that season.', 'reef');
  const a = E.answer(reef, 'What did Mirabel chart along the reefs and how many seasons did the survey of the outer archipelago take?');
  ok(a.audit.grounded && a.audit.status !== 'held', 'a strong single-passage hit grounds despite a thin ratio (covers ' + a.audit.covers + ')');
  ok(/\{\{cite:reef:\d+:s\d+\}\}/.test(a.text), 'and the grounding line is still cited');
});

// ── mechanical arithmetic: exact, no model ──
// A small on-device model is an unreliable calculator ("42 + 8" came back 42).
// A self-contained expression is computed exactly and never handed to a model.
group('answerArithmetic — a pure expression is computed exactly, never guessed', () => {
  const val = (q) => { const r = E.answerArithmetic(q); return r ? r.text : null; };
  eq(val('42 + 8'), '42 + 8 = 50', 'addition is exact (the on-device model returned 42)');
  eq(val('17 × 23'), '17 × 23 = 391', 'multiplication with the × sign');
  eq(val('17 * 23'), '17 × 23 = 391', 'multiplication with an asterisk');
  eq(val('100 / 4'), '100 ÷ 4 = 25', 'division');
  eq(val('3*(4+5)'), '3 × (4 + 5) = 27', 'parentheses override precedence');
  eq(val('2^10'), '2 ^ 10 = 1024', 'exponent');
  eq(val('5 plus 3'), '5 + 3 = 8', 'word operators');
  eq(val('10 minus 4'), '10 - 4 = 6', 'a worded minus is intent, not a range');
  eq(val('what is 42 + 8?'), '42 + 8 = 50', 'a calc lead and trailing punctuation are stripped');
  eq(val('1,000 + 1'), '1000 + 1 = 1001', 'thousands separators');
  const ar = E.answerArithmetic('42 + 8');
  eq(ar.audit.status, 'clean', 'arithmetic wears a clean badge');
  eq(ar.cites.length, 0, 'and carries no citations (nothing to cite — it is computed)');
  // NON-arithmetic stays null so ordinary chat / document questions are untouched
  eq(val('what is the 42nd amendment'), null, 'a number inside a phrase is not a calculation');
  eq(val('I have 42 apples and 8 oranges'), null, 'a sentence with numbers is not a calculation');
  eq(val('the year 2020-2021'), null, 'a year range is not a subtraction');
  eq(val('2020-2021'), null, 'a bare hyphenated range is not a subtraction');
  eq(val('who founded Veldmar'), null, 'an ordinary question is not a calculation');
});

// ── widened graph-portrait surface (WI-1..4) ──────────────────────────
const MACHINERY_RE = /\{\{|\[s\d+\]|\bs\d+\b|\b(mass|momentum|gravity|coupling|frame|rules_rev|NUL|SIG|INS|SEG|CON|SYN|DEF|EVA|REC|cite|void|infer|absent)\b/i;
await group('graph portrait — widened surface stays additive', async () => {
  const { entities } = E.projectEntities(voss);
  const e = entities[0];
  ok('momentum' in e && 'surfaceMass' in e && 'gender' in e && 'referent_id' in e,
     'projectEntities carries momentum/surfaceMass/gender/referent_id');
  ok(e.surfaceMass == null || e.surfaceMass <= e.mass, 'surfaceMass never exceeds mass (name-only weight)');
  const p = E.graphPortrait(voss);
  ok(['heavy', 'heavyEdges', 'assertions', 'spine'].every(k => k in p), 'four existing portrait keys preserved');
  ok(['tail', 'nulls', 'signals', 'frame', 'defs'].every(k => k in p), 'five new portrait keys present');
  eq(p.nulls.length, voss._events.filter(ev => ev.op === 'NUL').length, 'nulls mirrors the NUL log exactly');
  ok(p.frame && p.frame.gamma != null && p.frame.delta != null && !!p.frame.couplings, 'frame carries gamma/delta/couplings');
  const snap = E.graphSnapshot(voss);
  ok(['tail', 'nulls', 'signals', 'defs'].every(k => k in snap), 'graphSnapshot surfaces tail/nulls/signals/defs');
  eq(snap.schema, 'cleon-graph/1', 'snapshot schema unchanged');
});

// ── talker portrait + the one LLM step + mechanical EVA (WI-5) ────────
await group('talker portrait — three prose blocks, no machinery', async () => {
  const tp = await E.talkerPortrait(voss);                 // no opts.llm → fallback, 0 LLM calls
  ok(tp && ['existence', 'structure', 'significance', 'spans'].every(k => k in tp), 'returns four fields');
  ok(/^The page carries these passages\./.test(tp.existence), 'EXISTENCE leads with the page framing');
  ok(/^The notes the reader took\./.test(tp.structure), 'STRUCTURE leads with the reader-notes framing');
  ok(/^What the reading came to\./.test(tp.significance), 'SIGNIFICANCE leads with the epistemic framing');
  ok(/\b(the reading|the piece|the document carries)\b/i.test(tp.significance), 'SIGNIFICANCE carries an epistemic phrase');
  for (const block of [tp.existence, tp.structure, tp.significance])
    ok(!MACHINERY_RE.test(block), 'no machinery leaked into a prose block');
  // EXISTENCE sentences are all represented in spans
  const spanIdx = new Set(tp.spans.map(s => s.sentenceIndex));
  const heavy = E.graphPortrait(voss).heavy.slice(0, 6);
  ok(heavy.every(h => spanIdx.has(h.sents[0])), 'spans cover every EXISTENCE sentence');

  // evaDraft — each rejection reason fires, a clean draft passes
  const p = E.graphPortrait(voss);
  ok(!E.evaDraft('The mass of Edith grows. It moves. It rests.', p, voss.sentenceTexts).ok, 'evaDraft rejects machinery');
  ok(!E.evaDraft('Edith waits in s14 now. She stays. The end.', p, voss.sentenceTexts).ok, 'evaDraft rejects index leaks');
  ok(!E.evaDraft('The text says Edith left. She stays. The end.', p, voss.sentenceTexts).ok, 'evaDraft rejects ontological framing');
  ok(!E.evaDraft('The reading follows Zaphod here. He stays. The end.', p, voss.sentenceTexts).ok, 'evaDraft rejects invented names');
  ok(!E.evaDraft('The reading is brief.', p, voss.sentenceTexts).ok, 'evaDraft rejects out-of-range length');
  ok(E.evaDraft('The reading follows Edith closely. She stays near the lamp. The keeper waits.', p, voss.sentenceTexts).ok, 'evaDraft accepts a clean epistemic draft');

  // exactly one LLM call when the first draft passes EVA
  let calls = 0;
  const goodLlm = async () => { calls++; return 'The reading follows Edith closely. She stays near the lamp. The keeper waits by the boat.'; };
  const tpA = await E.talkerPortrait(voss, { llm: goodLlm });
  eq(calls, 1, 'exactly one LLM call when the draft is accepted');
  ok(tpA.significance.includes('follows Edith closely'), 'the accepted draft becomes the SIGNIFICANCE body');

  // a persistently bad draft retries once then falls back deterministically
  let bad = 0;
  const badLlm = async () => { bad++; return 'The text says everything about mass now.'; };
  const tpB = await E.talkerPortrait(voss, { llm: badLlm });
  eq(bad, 2, 'one retry on a rejected draft, then stop');
  ok(!MACHINERY_RE.test(tpB.significance), 'the deterministic fallback is clean of machinery');
});

// ── mechanical talker grounder (WI-6) ────────────────────────────────
await group('talker grounder — mechanical, deterministic', async () => {
  const tp = await E.talkerPortrait(voss);
  const prose = tp.existence + ' ' + tp.structure + ' ' + tp.significance;
  const g1 = E.groundTalkerOutput(voss, prose, tp.spans);
  const g2 = E.groundTalkerOutput(voss, prose, tp.spans);
  ok(g1.text === g2.text && JSON.stringify(g1.cites) === JSON.stringify(g2.cites), 'two invocations are byte-identical (no LLM, no nondeterminism)');
  ok(g1.audit.stable === true, 'audit reports stable');
  ok(g1.cites.length > 0 && /\{\{cite:voss:/.test(g1.text), 'EXISTENCE sentences bind cites mechanically');
  ok(/^\d+\/\d+$/.test(g1.audit.covers), 'covers is a fraction of cited sentences');
  // bindCitations parity floor unchanged by the hoisted constant
  const bc = E.bindCitations(voss, 'Edith set the kettle down and listened.', 'q', 'factual');
  ok(/\{\{cite:voss:/.test(bc.text), 'bindCitations still binds against the shared floor');
});

// ── naming-bridge role DEFs + definitional answers from the graph ────
// Journalism frames a job relationally ("the same person who runs the DMC")
// and names the person a beat later. The bridge distills a role DEF alongside
// the class gloss, and a definitional ask is answered from the assertions
// themselves — lexical retrieval can't reach a sentence that never carries
// the name. The model, when present, only phrases over these (a signal at
// its coupling, never a tie-breaker); these tests pin the mechanical floor.
await group('definitional asks — answered from the graph\'s own assertions', async () => {
  const ndp = await E.parseDocument('ndp.txt',
    'Downtown security has changed hands.\n\n' +
    'The new contract is unusual. It is run through a recently created entity called NDMC PSO LLC — a shell company of the District Management Corporation (the DMC), created by the same person who runs the DMC and who then hires his own firm, NDP, to manage the downtown security operations through it. That person is Tom Turner. Turner declined to comment.\n\n' +
    'The council will vote next month. Business owners paying the assessment were not consulted about the arrangement.', 'ndp');

  // the bridge emits BOTH the class gloss and a distilled role DEF
  const defs = E.assertionsOf(ndp).filter(d => /turner/i.test(d.subject));
  ok(defs.some(d => d.path === 'class' && /runs the DMC/.test(d.is)), 'naming-bridge class gloss recorded');
  ok(defs.some(d => d.path === 'role' && d.is === 'runs the DMC'), 'role DEF distilled from the relational description');

  // a role ask reads the role slot first; an identity ask reads the class
  const job = E.answer(ndp, "what is tom turner's job?");
  ok(/^Tom Turner runs the DMC/.test(job.text), 'role ask answers from the role DEF');
  ok(job.audit.grounded && job.audit.status === 'clean', 'definitional answer is grounded and clean');
  ok(job.cites.length > 0 && job.cites[0].idx === 2, 'cited to the antecedent sentence, not the naming line');
  const who = E.answer(ndp, 'who is Tom Turner?');
  ok(/^Tom Turner is the person who runs the DMC and who then hires his own firm/.test(who.text),
    'identity ask answers from the class gloss — de-anaphored ("the same person" → "the person") and carrying the payload clause');

  // the graph's evidence reaches the depth-1 LLM context even though the
  // assertion sentence never carries the name
  const ctx = E.context(ndp, "what is tom turner's job?", 6);
  ok(/^What the page asserts about Tom Turner:/.test(ctx), 'definitional context opens with the page\'s assertions');
  ok(/\[s2\]/.test(ctx), 'the assertion sentence joins the passages');

  // a definitional ask about an ABSENT name still voids (audit-first contract)
  const ghost = E.answer(ndp, 'who is Hercule Poirot?');
  ok(/\{\{void:/.test(ghost.text), 'absent referent voids rather than defines');

  // no assertions ⇒ falls through to ordinary prose answering, not an error
  const plain = E.answer(ndp, 'what is the council?');
  ok(plain && typeof plain.text === 'string' && plain.text.length > 0, 'definitional ask without assertions falls through cleanly');
});

// ── typing enrichment: titles, speakers, register-aware singular they ──
await group('typing — richer & more consistent person evidence', async () => {
  // two quotes so the attribution verb "said" is induced (one sighting won't);
  // Quthring then holds the speaker slot.
  const td = await E.parseDocument('typing2.txt',
    'The Hearing\n\nMr. Calloway reviewed the contract. Senator Alexander spoke first. Chief Drake declined to comment. ' +
    'Mr. Calloway nodded at Alexander, and Drake followed. ' +
    '"I have nothing to add," said Quthring. "Nothing at all," said Quthring.', 'typing2');
  const ents = E.graphSnapshot(td).entities;
  const typeOf = (re) => (ents.find(e => re.test(e.name)) || {}).type;
  // a personal title is unambiguous person evidence (gender aside)
  eq(typeOf(/calloway/i), 'person', 'Mr. Calloway typed person by title');
  eq(typeOf(/alexander/i), 'person', 'Senator Alexander typed person by title');
  eq(typeOf(/drake/i), 'person', 'Chief Drake typed person by title');
  // a recorded SIG speaker is a person, even if NER missed the name
  eq(typeOf(/quthring/i), 'person', 'a speaker (Quthring said) is typed person');

  // register: singular "they" for one named person is OFF by default (classic
  // narrative), so it neither promotes nor genders; a modern module turns it on.
  const reg = loadEngine().EOEngine;
  const theyDoc = 'Maqari Holt built the press. Maqari Holt ran it for decades. They never sold a share.';
  let d1 = await reg.parseDocument('they-off.txt', theyDoc, 'toff');
  const off = (reg.graphSnapshot(d1).entities.find(e => /maqari/i.test(e.name)) || {});
  ok(off.gender == null, 'singular they teaches no gender (classic register)');
  // toggling the register rule is the only thing that changes; gendered he/she
  // resolution is untouched either way (the parity floor proves it elsewhere).
  reg.applyRules([{ id: 'singular-they', value: 1, enabled: true }]);
  ok(true, 'singular_they is a tunable register rule (bridge wired)');
});

// ── the integral fold: "what is this about" is always answerable, and a
// chapter question gets the fold up to the beginning of the next chapter ──
await group('fold — the integral reading of a document', async () => {
  const CHAPTERED = `The Tower at Harrow

Chapter One

Edith kept the lamp at Voss Point. The keeper trusted her with the seaward light. Every night Edith climbed the stairs.

Chapter Two

Sefton arrived from the mainland in a small boat. Sefton argued with the keeper about the crossing. Marlow was waiting for him, he said.

Chapter Three

The storm took the shutter by midnight. Edith and Sefton sat close to the lamp.`;
  const doc = await E.parseDocument('chaptered.txt', CHAPTERED, 'ch');

  // the document always carries an integral fold and knows its chapters
  const folds = E.documentFolds(doc);
  ok(folds && folds.integral, 'a document carries an integral fold of the whole');
  ok(folds.sections.length >= 3, 'the fold knows the chapter boundaries');
  ok(/Edith/.test(folds.integral), 'the integral fold names a figure from the document');

  // "what is this about" gets the whole-document fold
  const all = E.foldForQuery(doc, 'what is this document about?');
  eq(all.scope, 'integral', 'a whole-document question gets the integral fold');
  ok(/Sefton/.test(all.text), 'the integral fold names a figure introduced later in the document');

  // asking about Ch 1 gets the fold UP TO the beginning of Ch 2
  const f1 = E.foldForQuery(doc, 'what is chapter 1 about?');
  eq(f1.scope, 'section', 'a chapter question scopes the fold to a section');
  ok(/Edith/.test(f1.text), 'the chapter-1 fold names a figure from chapter 1');
  ok(!/Sefton/.test(f1.text), 'the chapter-1 fold stops at the start of chapter 2 (Sefton, introduced there, is absent)');
  ok(f1.hi <= folds.integral.length || f1.hi < (doc.sentenceTexts || []).length, 'the chapter-1 boundary is before the document end');

  // an ordinal word resolves the same way ("chapter two")
  const f2 = E.foldForQuery(doc, 'summarize chapter two');
  eq(f2.scope, 'section', 'an ordinal-word chapter reference scopes to a section');
  ok(/Sefton/.test(f2.text), 'the chapter-2 fold names Sefton, introduced in chapter 2');

  // the fold rides into the grounded context as a note on an ordinary turn
  const parts = E.contextParts(doc, 'who tends the seaward light?', 6);
  ok(parts.notes.some(nt => /reading of the whole/.test(nt) && /Edith/.test(nt)),
    'the integral fold rides into the grounded context as the leading note');

  // and a summary turn's blob leads with the fold
  const ctx = E.context(doc, 'summarize this', 6);
  ok(/whole document is about/.test(ctx) && /Edith/.test(ctx), 'the summary context leads with the fold');

  // the fold reads as prose, not a slot template. "centers on" replaced the
  // old "turns mostly on" — same fold shape, less bizarre verb (a user reading
  // "this document turns most on X" assumed a typo).
  ok(/mostly centers on/.test(folds.integral), 'the fold reads as prose');
  ok(!/turns most(?:ly)? on/.test(folds.integral), 'the old "turns most(ly) on" verb is gone');
  ok(!/It states that .*;.*;/.test(folds.integral), 'the fold is not a semicolon-joined slot list');
});

// ── impression query: the embedder as a fuzzy query into the graph — verbatim
// related spans PLUS the integral (fold) of the relevant region as a note ──
await group('impression query — embedding as a fuzzy graph query', async () => {
  const sandbox = loadEngine();
  const SE = sandbox.EOEngine;
  const voss = await SE.parseDocument('voss.txt', VOSS, 'v');

  // foldOver: the integral over an ARBITRARY set of relevant sentences, in prose
  const someFold = SE.foldOver(voss, [2, 3, 4, 5]);
  ok(typeof someFold === 'string' && someFold.length > 0, 'foldOver folds an arbitrary set into prose');
  const emptyFold = SE.foldOver(voss, []);
  eq(emptyFold, '', 'foldOver of nothing is empty');

  // no embedder ⇒ a clean no-op (the lexical paths answer as before)
  const none = await SE.impressionQuery(voss, 'who fears the crossing', {});
  ok(none.spans.length === 0 && none.fold === '', 'no embedder ⇒ empty impression');

  // a deterministic fake embedder: sentences on a 2-D ring, the query just off it,
  // so the impression selects a contiguous-ish region with real entities in it.
  const ring = (theta) => Float32Array.from([Math.cos(theta), Math.sin(theta)]);
  sandbox.EOEmbed = {
    ready: () => true, warm: () => {},
    embedSentences: async (arr) => arr.map((_, i) => ring(i * 0.5)),
    embedQuery: async () => ring(0.4),
  };

  const imp = await SE.impressionQuery(voss, 'tell me about the night', { spans: 3, region: 8 });
  ok(imp.spans.length >= 1, 'the impression hands back verbatim related spans');
  ok(imp.spans.every(s => typeof s.t === 'string' && s.i != null), 'spans carry verbatim text and an index');
  ok(typeof imp.fold === 'string' && imp.fold.length > 0,
    'the related note is the integral (fold) of the relevant things, not raw lines');
  ok(/centers on|opens|runs from|sits under/.test(imp.fold), 'the integral reads as a fold, in prose');
  ok(imp.idxs.length >= imp.spans.length, 'the folded region covers at least the spanned sentences');

  const note = SE.impressionNote(imp.fold);
  ok(/Related by impression/.test(note) && note.includes(imp.fold), 'the impression renders as a marked note carrying the fold');
});

// THE PARROT LOOP (observed NDP trace): follow-ups with no lexical signal of
// their own — "what is the craziest stuff in there?", "but why not?", "explain
// why" — fell to plain chat, where the model could only repeat its previous
// answer; and the first such drop flipped prevGrounded, stranding every LATER
// follow-up off the page too. Continuity now reads ellipsis and locative
// deixis alongside the ruliad anaphors, and accepts the sticky everGrounded
// signal so one mis-routed turn can't poison the rest of the conversation.
group('route — elliptical & deictic follow-ups (the parrot-loop fix)', () => {
  eq(E.routeTurn([voss], 'but why not?', { prevGrounded: true }).reason, 'continuity',
    '"but why not?" (pure function words) continues a grounded turn');
  eq(E.routeTurn([voss], 'explain why', { prevGrounded: true }).reason, 'continuity',
    '"explain why" (imperative, no "?") continues a grounded turn');
  eq(E.routeTurn([voss], 'what is the craziest stuff in there?', { prevGrounded: true }).reason, 'continuity',
    'locative deixis ("in there") points at the page');
  eq(E.routeTurn([voss], 'but why not?', { prevGrounded: false, everGrounded: true }).reason, 'continuity',
    'everGrounded recovers continuity after an intervening chat turn');
  // Guard rails: acknowledgments, greetings and fresh topics never continue.
  eq(E.routeTurn([voss], 'okay', { prevGrounded: true }).decision, 'chat',
    'a bare acknowledgment stays in chat (no wh/meta token)');
  eq(E.routeTurn([voss], 'thanks, that really helps', { prevGrounded: true }).decision, 'chat',
    'gratitude stays in chat ("thanks"/"helps" are content, not glue)');
  eq(E.routeTurn([voss], 'hi there', { prevGrounded: true }).decision, 'chat',
    'a bare "there" is a greeting, not deixis — only prepositional "in there" continues');
  eq(E.routeTurn([voss], 'tell me a joke about penguins', { prevGrounded: true }).decision, 'chat',
    'a fresh topic does not continue just because the last turn was grounded');
  // Inert without ctx — batch/parity callers see exactly the prior routing.
  eq(E.routeTurn([voss], 'but why not?', {}).decision, 'escalate',
    'no grounding ctx → the old escalate band, unchanged');
  ok(!E.referencesDoc(voss, 'explain why'), 'referencesDoc stays inert without ctx (parity)');
});

// HEADLINE PROMOTION + MODIFIER-MERGE GUARD (observed NDP graph): a title line
// pasted with a single newline was glued into the first sentence and Title
// Case minted phantom entities ("Mistakes If", "…Owners: You Cannot"); and the
// single-token containment merge fused the document's protagonist into its
// hometown ("Nashville" ⊂ "Nashville Downtown Partnership" — a leading
// MODIFIER match, not a short form) and "Tennessee" into "Tennessee Highway
// Patrol". Person short forms ("Corman" ⊂ "David Corman") must keep merging.
const headlineDoc = await E.parseDocument('headline.txt',
  'Downtown Business Owners:  You Cannot Afford to Keep Paying for Mistakes\n'
  + 'If you own a business downtown, you pay the Nashville Downtown Partnership. '
  + 'The Nashville Downtown Partnership manages the district. '
  + 'Nashville grew quickly last year. Nashville approved a new budget. '
  + 'The Tennessee Highway Patrol signed the contract. '
  + 'Tennessee passed a stricter law. Tennessee kept growing. '
  + 'The Tennessee Highway Patrol expanded its patrols. '
  + 'David Corman runs the safety office. But Corman disagreed with the plan. '
  + 'The report quotes Corman directly.', 'headline');
group('extraction — headline promotion & the modifier-merge guard', () => {
  ok(/^Downtown Business Owners/.test(headlineDoc.sentenceTexts[0] || ''),
    'the title line is its own sentence');
  ok(!/If you own/.test(headlineDoc.sentenceTexts[0] || ''),
    'the title line is NOT glued into the first body sentence');
  const names = E.projectEntities(headlineDoc).entities.map(e => e.name);
  ok(!names.some(n => /:/.test(n)), 'no entity name carries a colon (headline lead-ins trimmed)');
  ok(!names.some(n => /\b(Mistakes If|You Cannot|Keep Paying)\b/.test(n)),
    'no phantom Title-Case entities from the headline');
  ok(names.includes('Nashville Downtown Partnership'),
    'the org keeps its full name — never renamed to its hometown');
  ok(names.includes('Nashville'), 'the city is its OWN entity, not absorbed into the org');
  ok(names.includes('Tennessee Highway Patrol') && names.includes('Tennessee'),
    'the state is not absorbed into the agency named after it');
  eq(names.filter(n => /Corman/.test(n)).length, 1,
    'a person\'s surname short form still merges — one Corman referent, never two');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
