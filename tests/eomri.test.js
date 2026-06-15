/* ============================================================
   Tests for the EO-MRI real-data seam (eomri.jsx →
   window.EOMRI.traceFromTurn). The instrument used to run only canned
   scenarios; these pin that a real window.EOAudit turn — the shape the
   chat pipeline records (route → ground → retrieve → phrase → veto →
   cite) — converts into an instrument trace whose witness is the audit's
   WI-7 degree, whose grounds are the turn's own citations resolved to
   their retrieved span text, and whose per-sentence 3-fold address comes
   from the engine's OWN encoder (eoAddressOfEvent / eoNotation), never a
   hand-rolled guess.

   The eomri helpers are pure JS living after the React component; we load
   the engine (window.EOEngine) and audit.js (window.EOAudit) into one vm
   context, then eval just that pure tail so traceFromTurn is callable from
   Node. Run with `node tests/eomri.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nlp = require('compromise');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

// One vm context carrying the engine + the audit recorder + the eomri seam.
function loadSeam() {
  const sandbox = { window: {}, nlp, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['pivot.jsx', 'engine.js', 'audit.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  if (!sandbox.window.EOEngine) throw new Error('engine did not publish window.EOEngine');
  if (!sandbox.window.EOAudit) throw new Error('audit.js did not publish window.EOAudit');
  // Eval just the pure-JS tail of eomri.jsx (helpers + traceFromTurn + the
  // window.EOMRI assignment) — everything from EOMRI_STOP up to, but not
  // including, the React-component export line.
  const src = fs.readFileSync(path.join(ROOT, 'eomri.jsx'), 'utf8');
  const start = src.indexOf('const EOMRI_STOP');
  const end = src.indexOf('\nObject.assign(window, { EOMRIDrawer');
  if (start < 0 || end < 0) throw new Error('could not locate the eomri.jsx pure-JS seam');
  vm.runInContext(src.slice(start, end), sandbox, { filename: 'eomri.seam.js' });
  if (!sandbox.window.EOMRI || typeof sandbox.window.EOMRI.traceFromTurn !== 'function') {
    throw new Error('eomri seam did not publish window.EOMRI.traceFromTurn');
  }
  return sandbox.window;
}

// Build a turn the way app.jsx's AUD shim records one, finalizing truthfulness
// exactly as audit.js end() does (so final.truth is the real WI-7 object).
function turn(W, id, input, steps, final) {
  final = Object.assign({}, final);
  try { final.truth = W.EOAudit.truthfulness(final); } catch (e) {}
  return { id, input, mode: 'grounded', done: true, steps: steps || [], final };
}
const fr = (tr, op, pred) => (tr.frames || []).filter(f => f.op === op && (!pred || pred(f)));

async function main() {
  const W = loadSeam();
  const TF = W.EOMRI.traceFromTurn;

  group('seam vocabularies stay name-aligned with the cube', () => {
    eq(W.EOMRI.OPERATORS.length, 9, 'nine operators');
    eq(W.EOMRI.SITES[0][1], 'Thing', 'the (Existence, Figure) cell is spelled Thing (the instrument grid)');
    ok(typeof TF === 'function', 'traceFromTurn is published and callable');
    eq(TF(null), null, 'a null turn yields null (→ scenarios)');
    eq(TF({ final: { text: '' } }), null, 'an empty answer yields null');
  });

  group('a grounded turn with inline citations', () => {
    const t = turn(W, 'turn-1', 'who wrote it, and when was it published?',
      [{ t: 'route', path: 'grounded', reason: 'who/when · strong lexical hits' },
       { t: 'intent', intent: 'lookup' },
       { t: 'retrieve', k: 6, engine: 'embedding', hits: [
         { score: 0.81, idx: 12, text: 'written by H. G. Wells, 1895' },
         { score: 0.74, idx: 7, text: 'first published in the spring of 1895' }] },
       { t: 'ground', hasGround: true },
       { t: 'veto', decision: 'model', boundGrounded: true, boundCovers: '2/2' }],
      { engine: 'model',
        text: 'It was written by H. G. Wells in 1895{{cite:doc1:12:s12}}. It was first published that same spring{{cite:doc1:7:s7}}.',
        cites: [{ docId: 'doc1', idx: 12 }, { docId: 'doc1', idx: 7 }],
        audit: { status: 'clean', grounded: true, covers: '2/2', stable: true },
        form: { degree: 0.86, move: 'lookup' } });
    const tr = TF(t);
    ok(!!tr, 'produces a trace');
    eq(tr.verdictWord, 'grounded', 'verdict is grounded');
    eq(tr.tone, '#3ddc84', 'tone is green');
    eq(tr.genre, 'lookup', 'genre read from an Existence question');
    eq(fr(tr, 'log', f => f.kind === 'question')[0].text, t.input, 'the ask is the real input');
    eq(fr(tr, 'log', f => f.kind === 'retrieval').length, 2, 'both retrieved spans become Given-Log frames');
    eq(fr(tr, 'log', f => f.kind === 'draft').length, 1, 'a model turn shows a talker draft');
    const sents = fr(tr, 'sentence');
    eq(sents.length, 2, 'two answer sentences');
    eq(sents[0].grounds[0].id, 's12', 'the cite resolves to its span id');
    eq(sents[0].grounds[0].text, 'written by H. G. Wells, 1895', 'and to the retrieved span TEXT (real data)');
    ok(sents[0].witness >= 0.99, 'a fully-cited, void-free sentence is fully witnessed');
    ok(!sents[0].alarm && !sents[0].absence, 'a grounded sentence raises no alarm');
    // the address is the engine's own — for an Existence/Figure target: INS(Thing, Making)
    const addr = W.EOEngine.eoAddressOfEvent({ op: 'INS', target: 'written by H. G. Wells, 1895' });
    eq(sents[0].notation, 'INS(' + (addr.site === 'Entity' ? 'Thing' : addr.site) + ', ' + addr.resolution + ')',
      'notation matches the engine encoder');
    eq(sents[0].site, addr.site === 'Entity' ? 'Thing' : addr.site, 'produced Site matches the engine encoder');
    eq(fr(tr, 'learn')[0].mode, 'lit', 'grounded + accepted → the loop is allowed to drift');
    const asy = fr(tr, 'asymptote')[0];
    ok(asy && Math.abs(asy.value - (t.final.truth.degree)) < 1e-6, 'asymptote IS the WI-7 witness degree');
    // both claims reword their span (…"in 1895", "that same spring") — grounded,
    // not verbatim; the per-claim ledger counts CLAIMS, not query tokens
    eq(tr.ledger.claims, 2, 'ledger counts both claims');
    eq(tr.ledger.grounded, 2, 'both reworded claims read grounded');
    eq(tr.ledger.verbatim, 0, 'neither is a word-for-word quote');
    ok(sents[0].verbatim === false, 'a reworded claim is not stamped verbatim');
  });

  group('verbatim vs grounded — the two honest tiers, never "verified"', () => {
    // a claim that lifts its span's OWN words reads verbatim; a faithful reword of
    // the same span reads grounded. Both are bound (green); neither claims truth.
    const t = turn(W, 'turn-vg', 'what does the title page say, and when did it print?',
      [{ t: 'route', path: 'grounded', reason: 'strong lexical hits' },
       { t: 'intent', intent: 'lookup' },
       { t: 'retrieve', k: 6, engine: 'embedding', hits: [
         { score: 0.9, idx: 12, text: 'written by H. G. Wells, 1895' },
         { score: 0.8, idx: 7, text: 'first published in the spring of 1895' }] },
       { t: 'ground', hasGround: true },
       { t: 'veto', decision: 'model', boundGrounded: true, boundCovers: '2/2' }],
      { engine: 'model',
        // sentence 1 quotes s12 word-for-word; sentence 2 rewords s7
        text: 'The page reads: written by H. G. Wells, 1895{{cite:doc1:12:s12}}. It reached print that same spring{{cite:doc1:7:s7}}.',
        cites: [{ docId: 'doc1', idx: 12 }, { docId: 'doc1', idx: 7 }],
        audit: { status: 'clean', grounded: true, covers: '2/2', stable: true },
        form: { degree: 0.86, move: 'lookup' } });
    const tr = TF(t);
    const sents = fr(tr, 'sentence');
    eq(sents.length, 2, 'two answer sentences');
    ok(sents[0].verbatim === true, "the word-for-word claim reads VERBATIM (the span's own words)");
    ok(sents[1].verbatim === false, 'the reworded claim reads GROUNDED, not verbatim');
    ok(!sents[0].alarm && !sents[1].alarm, 'both bound claims are honest (no alarm)');
    eq(tr.ledger.claims, 2, 'ledger counts both claims');
    eq(tr.ledger.verbatim, 1, 'one verbatim (the page speaking)');
    eq(tr.ledger.grounded, 1, 'one grounded (a faithful reword)');
    eq(tr.ledger.confabulation, 0, 'no confabulation');
  });

  group('the ledger inherits the relation gate — a held claim is not grounded', () => {
    // the model bound a span on backwards agency ("the Partnership pays owners");
    // the gate held it (inverted). It cited a span, so it would read grounded — but
    // the ledger and badge must demote it to a caught fabrication, never grounded.
    const claim = 'The Partnership pays the owners an annual assessment';
    const t = turn(W, 'turn-rg', 'who pays whom?',
      [{ t: 'route', path: 'grounded', reason: 'strong lexical hits' },
       { t: 'retrieve', k: 6, engine: 'embedding', hits: [
         { score: 0.8, idx: 1, text: 'Downtown owners pay an annual assessment to the Partnership' }] },
       { t: 'ground', hasGround: true },
       { t: 'relation-gate', keyed: 0, held: [],
         mismatches: [{ kind: 'inverted', claim: claim, docId: 'doc1', edge: 'owners —pay→ the Partnership', sent: 1 }] },
       { t: 'veto', decision: 'model', boundGrounded: true, boundCovers: '1/1' }],
      { engine: 'model',
        text: claim + '{{cite:doc1:1:s1}}.',
        cites: [{ docId: 'doc1', idx: 1 }],
        audit: { status: 'warn', grounded: true, covers: '1/1', stable: true },
        form: { degree: 0.8, move: 'lookup' } });
    const tr = TF(t);
    const s = fr(tr, 'sentence')[0];
    eq(s.gateHeld, 'inverted', 'the held claim carries the gate verdict');
    ok(s.alarm, 'a gate-held claim is not honest — it lights the alarm');
    ok(!s.verbatim, 'and is never verbatim');
    eq(tr.ledger.flagged, 1, 'the ledger counts it FLAGGED (a caught fabrication)');
    eq(tr.ledger.grounded, 0, 'so the grounded count excludes the fabrication that merely cleared overlap');
    eq(tr.ledger.verbatim, 0, 'nor verbatim');
  });

  group('fluent on thin air — an ungrounded assertion', () => {
    const t = turn(W, 'turn-2', "what was the author's political stance?",
      [{ t: 'route', path: 'grounded', reason: 'wh-question' },
       { t: 'retrieve', k: 6, engine: 'embedding', hits: [] },
       { t: 'veto', decision: 'residual', reason: 'unbound — served as a stamped talker sentence' }],
      { engine: 'model',
        text: 'He was a committed Fabian socialist whose politics shaped the book.',
        cites: [], audit: { status: 'warn', grounded: false, covers: '0/1', stable: true } });
    const tr = TF(t);
    eq(tr.verdictWord, 'flagged', 'verdict is flagged');
    eq(tr.tone, '#ff8a3d', 'tone is orange');
    const s = fr(tr, 'sentence')[0];
    ok(s.alarm, 'the ungrounded sentence lights the alarm');
    ok(!s.absence, 'it is a confabulation, not an absence');
    ok(s.site !== 'Void', 'an asserted Figure lands at its Site, NOT Void');
    eq(s.grounds.length, 0, 'no grounds — fluent on nothing');
    ok(s.witness < 0.35, 'witness is low');
    eq(tr.ledger.confabulation, 1, 'the ledger tallies one confabulation, not a grounded claim');
    eq(tr.ledger.verbatim + tr.ledger.grounded, 0, 'and nothing reads as bound');
    eq(fr(tr, 'learn')[0].mode, 'blocked', 'learning is blocked, not drifted');
    eq(fr(tr, 'log', f => f.kind === 'fetch').length, 1, 'and the turn is routed to fetch');
    // the no-hit retrieval reads as cold (deriveOps must not light INS/SEG for it)
    ok(/no span|no source/i.test(fr(tr, 'log', f => f.kind === 'retrieval')[0].text), 'cold retrieval line');
  });

  group('an honest absence (held, covers 0/1)', () => {
    const t = turn(W, 'turn-3', "how does this compare to Wells' later novels?",
      [{ t: 'route', path: 'grounded', reason: 'out of scope' },
       { t: 'retrieve', k: 6, engine: 'embedding', hits: [] }],
      { engine: 'mechanical',
        text: "I don't have anything on his later novels in what I was handed.",
        cites: [], audit: { status: 'held', grounded: true, covers: '0/1', stable: true,
          note: "Held rather than invented — the page wouldn't carry an answer." } });
    const tr = TF(t);
    eq(tr.verdictWord, 'held', 'verdict is held');
    eq(tr.tone, '#ffb800', 'tone is amber');
    const s = fr(tr, 'sentence')[0];
    ok(s.absence, 'the sentence is a registered absence');
    eq(s.object, 'Ground', 'absence reads Object Ground (the honest non-resolution)');
    eq(s.site, 'Void', 'and lands at Void');
    eq(fr(tr, 'learn')[0].mode, 'fetch', 'a cold miss broadens ingestion, learns nothing yet');
  });

  group('an honest refusal (no model / non-answer)', () => {
    const t = turn(W, 'turn-4', 'summarize the document',
      [{ t: 'route', path: 'plain-unavailable', reason: 'model-not-ready' }],
      { engine: 'none', text: 'Load a local model first, and I’ll read the document for you.',
        audit: null, reason: 'model-not-ready' });
    const tr = TF(t);
    eq(tr.verdictWord, 'refused', 'verdict is refused');
    eq(tr.tone, '#ff3b52', 'tone is red');
  });

  group('a mechanical reading that cites via cites[], not inline markers', () => {
    const t = turn(W, 'turn-5', 'how many people are named?',
      [{ t: 'retrieve', k: 6, engine: 'mechanical', hits: [{ score: 1, idx: 3, text: 'Edith came down the last three steps' }] }],
      { engine: 'mechanical', text: 'Five people are named in the document.',
        cites: [{ docId: 'doc1', idx: 3 }],
        audit: { status: 'clean', grounded: true, covers: '1/1', stable: true, note: 'Counted directly.' } });
    const tr = TF(t);
    eq(tr.verdictWord, 'grounded', 'a grounded mechanical reading is grounded');
    const s = fr(tr, 'sentence')[0];
    ok(s.grounds.length >= 1, 'the turn cites[] are surfaced as grounds');
    eq(s.grounds[0].id, 's3', 'resolved to the cited span id');
    eq(s.grounds[0].text, 'Edith came down the last three steps', 'and to the span text');
  });

  console.log(`\neomri: ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
