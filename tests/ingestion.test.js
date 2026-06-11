/* ============================================================
   Tests for the ingestion audit (engine.js → ingestionReport /
   classifyTokens). These pin the contract the audit UI relies on:
   the per-word classification is bit-identical to the engine's own
   tokenizer (the audit cannot lie about what is indexed), every word
   is accounted for, and the report's provenance is sound.

   Run with `node tests/ingestion.test.js`.
   ============================================================ */
'use strict';
const { loadEngine, VOSS, CSV, makeBigDoc } = require('./harness');
const E = loadEngine().EOEngine;

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

async function main() {
  const voss = await E.parseDocument('Voss.txt', VOSS, 'voss');
  const deals = await E.parseDocument('deals.csv', CSV, 'deals');

  group('classifyTokens — the audit reflects the engine, not a copy of it', () => {
    // The 'term' forms classifyTokens reports MUST equal tok() exactly, span by
    // span. If this drifts, the audit is lying about what gets indexed.
    let drift = 0;
    for (const t of voss.sentenceTexts) {
      const a = JSON.stringify(E.classifyTokens(t).flatMap(x => x.terms));
      const b = JSON.stringify(E.tok(t));
      if (a !== b) drift++;
    }
    eq(drift, 0, 'classifyTokens term-forms are bit-identical to tok() across every span');
    // Each word carries exactly one fate.
    const all = E.classifyTokens('The keeper saw an ox by Voss-Point.');
    ok(all.every(w => ['term', 'stop', 'drop'].includes(w.kind)), 'every word is classified term/stop/drop');
    ok(all.some(w => w.kind === 'term' && w.terms.length > 1), 'a hyphenated word yields multiple index forms');
    ok(all.find(w => w.w === 'The').kind === 'stop', '"The" is a stopword (carried, unindexed)');
    ok(all.find(w => w.w === 'ox').kind === 'drop', 'a short non-stopword ("ox") is dropped — too short to index');
  });

  group('ingestionReport — shape + the whole text is accounted for', () => {
    const r = E.ingestionReport(voss);
    eq(r.schema, 'cleon-ingestion/1', 'schema stamped');
    eq(r.doc.sentences, voss.sentenceTexts.length, 'sentence count matches the doc');
    // Every single word lands in exactly one bucket: nothing silently vanishes.
    eq(r.words.indexed + r.words.stop + r.words.dropped, r.words.occurrences, 'every word is accounted for (indexed + stop + dropped = total)');
    ok(r.words.occurrences > r.words.indexed, 'the prose carries more words than it indexes (stopwords exist)');
    eq(r.words.uniqueTerms, r.lexicon.length, 'uniqueTerms matches the lexicon length');
    ok(r.lexicon.every(t => t.count >= 1 && Array.isArray(t.sents)), 'every lexicon term has a count and a span list');
    ok(r.lexicon.every(t => t.sents.every(si => voss.sentenceTexts[si] != null)), 'every lexicon span index resolves to a real span');
    ok(r.lexicon.every(t => t.sents.every(si => voss.sentenceTexts[si].toLowerCase().includes(t.token.split('-')[0]))),
       'a term actually appears in each span it is indexed under');
  });

  group('ingestionReport — coverage (dark spans) is honest', () => {
    const r = E.ingestionReport(voss);
    eq(r.coverage.sentences, voss.sentenceTexts.length, 'coverage counts all spans');
    eq(r.coverage.withEvents + r.coverage.dark, r.coverage.sentences, 'every span is either lit or dark');
    // A span with no event in _events must be reported dark, and vice versa.
    const evSents = new Set((voss._events || []).map(e => e.sentence_idx).filter(i => i != null));
    const reportedLit = r.sentences.filter(s => s.events > 0).map(s => s.i);
    ok(reportedLit.every(i => evSents.has(i)), 'a span reported "with events" really carries events');
    eq(r.sentences.filter(s => s.events === 0).length, r.coverage.dark, 'dark count matches the per-span summary');
  });

  group('ingestionReport — entity terms are flagged + counts agree', () => {
    const r = E.ingestionReport(voss);
    const named = r.lexicon.filter(t => t.entity).map(t => t.token);
    ok(named.includes('edith'), 'the heaviest character surfaces as a flagged entity term');
    eq(r.words.entityTerms, named.length, 'entityTerms count matches the flagged terms');
    eq(r.counts.entities, E.projectEntities(voss).entities.length, 'entity count matches projectEntities');
    eq(r.counts.events, (voss._events || []).length, 'event count matches the log');
    const ops = {}; for (const ev of voss._events) ops[ev.op] = (ops[ev.op] || 0) + 1;
    eq(JSON.stringify(r.counts.ops), JSON.stringify(ops), 'op tally matches the log');
  });

  group('textGraph — the whole text is in the graph, every word meaningful', () => {
    const g = E.textGraph(voss);
    eq(g.schema, 'cleon-textgraph/1', 'schema stamped');
    eq(g.coverage.lit + g.coverage.chrome + g.coverage.dark, g.coverage.spans, 'every span is exactly one of lit / chrome / dark');
    eq(g.spans.length, voss.sentenceTexts.length, 'a node exists for every span — nothing summarized away');
    ok(g.spans.every(s => s.kind !== 'dark' || s.reason != null), 'every dark span carries its written reason');
    eq(g.words.indexed + g.words.stop + g.words.dropped, g.words.occurrences, 'every word is accounted: indexed + stop + dropped = all');
    ok(g.spans.some(s => s.referents.length && s.kind === 'lit'), 'lit spans hang on the referents sighted in them');
    ok(g.referents.every(r => r.frame && /^frame:/.test(r.frame)), 'every referent carries its frame');
    eq(E.textGraph(deals), null, 'a table has no prose text graph');
  });

  group('ingestionReport — tables carry no word graph', () => {
    eq(E.ingestionReport(deals), null, 'a table returns null (no prose graph)');
    eq(E.ingestionReport(null), null, 'a missing doc returns null');
  });

  console.log('• ingestionReport — a long document is handled, completely');
  {
    const big = await E.parseDocument('big.txt', makeBigDoc(120), 'big');
    const r = E.ingestionReport(big);
    ok(r && r.doc.sentences > 200, 'a 120-paragraph doc parses into many spans');
    eq(r.words.indexed + r.words.stop + r.words.dropped, r.words.occurrences, 'word accounting still balances at scale');
    eq(r.sentences.length, r.doc.sentences, 'a per-span summary exists for every span (nothing capped away)');
    ok(r.events.length === big._events.length, 'the full event log is carried, uncapped');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
