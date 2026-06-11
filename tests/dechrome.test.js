/* ============================================================
   De-chroming: the document-level verdict over the chrome gate.

   Pins the contract for the non-destructive de-chrome pass and the
   about-the-html / about-the-de-chroming route:
     · the pass records what the chrome gate set aside, by block, with prov;
     · it is non-destructive — the full page stays in the spine, no event
       is minted, so the append-only log (and golden parity) is untouched;
     · ordinary retrieval reads the de-chromed view (no more "retrieval
       grabs page chrome"), and only a turn about the chrome opts back into
       the full content;
     · a turn about the html / the de-chroming is answered mechanically
       from the structure band, cited to the lines it set aside.

   No framework: a tiny assert runner. Run with `node tests/dechrome.test.js`.
   ============================================================ */
'use strict';
const { loadEngine, VOSS } = require('./harness');
const E = loadEngine().EOEngine;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

// A scraped web article: nav / share / byline / copyright / subscribe chrome
// wrapped around two sentences of actual article prose.
const WEB = [
  'Home About us Contact Subscribe',
  'Share Tweet Facebook Email',
  'By Jane Reporter',
  'The mayor announced a new park on Tuesday.',
  'Residents gathered downtown to celebrate the decision.',
  '© 2024 The Daily Bugle. All rights reserved.',
  'Subscribe now for $9.99 a month.',
].join('\n\n');

async function main() {
  const web = await E.parseDocument('web.txt', WEB, 'web');
  const voss = await E.parseDocument('Voss.txt', VOSS, 'voss');

  group('pass — a doc that appears to have chrome', () => {
    const dc = web._dechrome;
    ok(dc && dc.present, 'web article registers a de-chroming verdict');
    ok(dc.web === true, 'verdict flags web chrome (the html)');
    ok(dc.count >= 2, 'at least the byline + copyright/subscribe lines are set aside');
    ok(dc.segments.length >= 1, 'set-aside lines are grouped into segments');
    ok(dc.spans.every(i => web._chrome.includes(i)), 'every de-chrome span is a chrome-gated line');
    ok(dc.removed_chars > 0 && dc.total_sentences === web.sentenceTexts.length, 'summary tallies chars/sentences');
    ok(Object.keys(dc.by_reason).length >= 1, 'set-aside lines are labelled by reason');
  });

  group('pass — SEG-shaped verdicts with provenance', () => {
    const dc = web._dechrome;
    const seg = dc.segments[0];
    eq(seg.op, 'SEG', 'each segment is a SEG-shaped boundary decision');
    eq(seg.stance, 'Dissecting', 'the SEG carries the dissecting stance');
    ok(/^chrome:/.test(seg.reason), 'the reason names it as chrome');
    ok(Array.isArray(seg.prov) && seg.prov.length > 0, 'the segment carries content-hash provenance');
    ok(seg.prov.every(h => typeof h === 'string' && h.length === 16), 'prov is a 16-char span hash');
    ok(typeof seg.sample === 'string' && seg.sample.length > 0, 'the segment shows a sample of what it set aside');
  });

  group('non-destructive — the full page is kept, no event minted', () => {
    // every chrome line is still present, verbatim, in the spine
    ok(web._chrome.every(i => typeof web.sentenceTexts[i] === 'string' && web.sentenceTexts[i].length > 0),
       'set-aside lines stay verbatim in the spine (recoverable)');
    // the de-chrome verdict never enters the append-only event log
    const segInLog = (web._events || []).some(ev => ev && ev.reason && /^chrome:/.test(String(ev.reason)));
    ok(!segInLog, 'no de-chrome SEG leaks into the append-only event log (parity holds)');
  });

  group('retrieve — de-chromed by default, full content on demand', () => {
    // "subscribe" lives only in chrome; the default (de-chromed) view misses it
    const def = E.retrieve(web, 'subscribe monthly', 6);
    ok(def.every(h => !web._chrome.includes(h.i)), 'default retrieval never returns a chrome line');
    // opting into the full content reaches the stripped band
    const full = E.retrieve(web, 'subscribe monthly', 6, { includeChrome: true });
    ok(full.some(h => web._chrome.includes(h.i)), 'includeChrome reaches the stripped subscribe line');
  });

  group('retrieve — a chrome-free doc is byte-identical (parity)', () => {
    eq(voss._dechrome.present, false, 'a clean literary text has no chrome');
    const a = JSON.stringify(E.retrieve(voss, 'boat to the mainland', 6));
    const b = JSON.stringify(E.retrieve(voss, 'boat to the mainland', 6, { includeChrome: true }));
    eq(a, b, 'with no chrome, includeChrome changes nothing');
  });

  group('route — aboutChrome detects the turn', () => {
    ok(E.aboutChrome('what did you strip from the html?'), 'detects "what did you strip from the html"');
    ok(E.aboutChrome('show me the page chrome'), 'detects "show me the page chrome"');
    ok(E.aboutChrome('what does the footer say'), 'detects a footer question');
    ok(E.aboutChrome('who is the byline?'), 'detects a byline question');
    ok(!E.aboutChrome('what did the keeper say about the boat'), 'an ordinary content question is not about chrome');
    ok(!E.aboutChrome('summarize this'), '"summarize this" is not about chrome');
  });

  group('answer — mechanical de-chrome report, cited', () => {
    const a = E.answerAboutChrome(web, 'what did you strip from the html?');
    ok(a && typeof a.text === 'string' && a.text.length > 0, 'returns a grounded report');
    ok(a.cites.length > 0 && a.cites.every(c => web._chrome.includes(c.idx)), 'every cite points at a set-aside line');
    ok(a.audit && a.audit.grounded === true && /mechanical/i.test(a.audit.note), 'audit marks it grounded + mechanical');
    // it never claims an ordinary turn or a clean doc
    ok(E.answerAboutChrome(voss, 'what did you strip?') === null, 'returns null on a doc with no chrome');
  });

  group('answer — full content queried against on a chrome question', () => {
    // "bugle" lives only in the copyright/masthead chrome line; a chrome turn
    // must reach it, cited, even though the de-chromed view hides it
    const a = E.answerAboutChrome(web, 'what does the footer say about the bugle?');
    ok(a && /bugle/i.test(a.text), 'the answer surfaces the chrome line that names the Bugle');
    ok(a.cites.some(c => /bugle/i.test(web.sentenceTexts[c.idx])), 'and cites it');
  });

  group('answer() — routes an about-chrome turn to the report', () => {
    const a = E.answer(web, 'what did you strip out as chrome?');
    ok(a && /set aside|web chrome|apparatus/i.test(a.text), 'answer() returns the de-chrome report');
    // an ordinary question on the same doc is unaffected
    const b = E.answer(web, 'what did the mayor announce?');
    ok(b && /park/i.test(b.text), 'an ordinary content question still answers from the article');
  });

  group('ingestion report — surfaces the de-chroming', () => {
    const rep = E.ingestionReport(web);
    ok(rep && rep.dechrome && rep.dechrome.present, 'the ingestion report carries the de-chrome summary');
    eq(rep.dechrome.count, web._dechrome.count, 'report and doc agree on the count');
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nfailures:\n' + fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
