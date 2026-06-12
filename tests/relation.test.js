/* ============================================================
   tests/relation.test.js — the relation gate (the inversion fix).

   The failure this guards: a summary built from on-topic words whose
   subject–predicate–object inverts against the relation the page holds —
   "the Association cannot afford its bills" when the page says the OWNERS
   pay. Every word semantically fine, the citation binder happily staples a
   span on, and the agency is backwards. The gate checks the claim's
   relation against the graph's (and the span's own live read), holds
   inversions, wrong speakers, and named subjects the edge doesn't carry.

   The embedder appears ONLY as a similarity scorer (predicate
   compatibility, description↔name paraphrase); these tests run it as a
   canned stub — the real-model measurements live in
   tools/predictive/read3.js. Without an embedder the gate degrades to
   lexical: the strict swap still flags, the paraphrased inversion waits.

   Everything is behind the relation_gate rule, OFF by default — the first
   assertions pin that floor.
   ============================================================ */
'use strict';
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }

// The NDP fixture (the Tom Turner self-dealing article from
// evo/experiments/question-probe.js — the document whose summary
// inversion motivates the gate).
const NDP = `Downtown Nashville Security: Who Pays, Who Profits

Downtown business owners pay an annual assessment to the Nashville Downtown Partnership. The Partnership is meant to fund cleaning, marketing, and security for the district.

The security contract is unusual. It is run through a recently created entity called NDMC PSO LLC — a shell company of the District Management Corporation (the DMC), created by the same person who runs the DMC and who then hires his own firm, NDP, to manage the downtown security operations through it. That person is Tom Turner.

Tom Turner is the president of the Nashville Downtown Partnership. He also chairs the board of the District Management Corporation. Christina Kane, a parking customer, said "it's like nobody cares." David Corman, who leads the rival firm Solaren Risk Management, called the arrangement "Operation Flood the Zone."

The Metro Council will vote on the contract next month. Council member Freddie O'Connell wrote on Twitter that the deal "deserves real scrutiny." Mayor Cooper has not commented.`;

/* A canned embedder: known pairs get designed cosines, every other surface
   gets a hash-bucket one-hot (distinct strings ⇒ cosine 0, same string ⇒ 1).
   Slots 0–7 are reserved for the dictionary so designed and hashed vectors
   never collide. cos(afford, pay) = 0.62 is the value measured on the app's
   real MiniLM-q8 (tools/predictive/read3.js). */
function stubEmbed() {
  const DIM = 64;
  const d = (pairs) => { const v = new Float32Array(DIM); for (const [i, x] of pairs) v[i] = x; return v; };
  const DICT = new Map([
    ['afford', d([[0, 1]])],
    ['pay', d([[0, 0.62], [1, Math.sqrt(1 - 0.62 * 0.62)]])],
  ]);
  const vecOf = (s) => {
    const k = String(s == null ? '' : s).toLowerCase().trim();
    if (DICT.has(k)) return DICT.get(k);
    let h = 0; for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
    const v = new Float32Array(DIM); v[8 + (Math.abs(h) % (DIM - 8))] = 1;
    return v;
  };
  return {
    ready: () => true, warm: () => {},
    embedQuery: async (s) => vecOf(s),
    embedSentences: async (a) => (a || []).map(vecOf),
    MODEL: 'stub',
    _set: (key, vec) => DICT.set(String(key).toLowerCase().trim(), vec),
    _d: d,
  };
}

async function main() {
  // ---- 1. the floor: gate off by default, embedder absent ⇒ vacuous ----
  const W1 = loadEngine();
  const E1 = W1.EOEngine;
  console.log('• relation gate — default-off floor and lexical degradation (no embedder)');
  ok(E1.relationGateEnabled() === false, 'relation_gate ships OFF — the parity floor');
  const doc1 = await E1.parseDocument('NDP.txt', NDP, 'ndp');
  const swap1 = await E1.checkRelations(doc1, 'The Partnership pays downtown business owners an annual assessment.');
  ok(swap1.length === 1 && swap1[0].kind === 'inverted', 'the strict swap flags LEXICALLY (no embedder needed): ' + JSON.stringify(swap1.map(m => m.kind)));
  const assoc1 = await E1.checkRelations(doc1, 'The Association cannot afford its bills.');
  ok(assoc1.length === 0, 'cold embedder: the paraphrased inversion does NOT flag (degrades to lexical, never guesses)');
  const faith1 = await E1.checkRelations(doc1, 'Downtown owners pay an annual assessment to the Partnership.');
  ok(faith1.length === 0, 'faithful paraphrase passes without the embedder');
  const env1 = await E1.groundingEnvelope(doc1, 'Owners pay. {{cite:ndp:1:s1}}');
  ok(env1.checked === 0 && env1.rows.length === 0, 'groundingEnvelope is vacuous without the embedder');

  // ---- 2. the embedder as similarity scorer (canned) ----
  console.log('• relation gate — the inversion fix, embedder as quantity supplier');
  const W2 = loadEngine();
  const E2 = W2.EOEngine;
  const stub = stubEmbed();
  W2.EOEmbed = stub;
  const doc2 = await E2.parseDocument('NDP.txt', NDP, 'ndp');

  const assoc = await E2.checkRelations(doc2, 'The Association cannot afford its bills.');
  ok(assoc.length === 1 && assoc[0].kind === 'foreign-subject',
    '"The Association cannot afford its bills" FLAGS against the owner-pays edge: ' + JSON.stringify(assoc.map(m => m.kind)));
  ok(assoc.length && assoc[0].subjectAbsentFromPage === true,
    'the flag records that the subject is absent from the whole page (the void machinery\'s read)');
  ok(assoc.length && /downtown business owners/i.test(assoc[0].edge.s) && /pay/i.test(assoc[0].edge.v),
    'the held claim points at the owner-pays edge — the footnote disagrees with the claim visibly');

  const faithful = await E2.checkRelations(doc2, 'Downtown owners pay an annual assessment to the Partnership.');
  ok(faithful.length === 0, 'the faithful owners-pay paraphrase PASSES — the bar\'s second half');
  const faithful2 = await E2.checkRelations(doc2, 'Business owners pay the Nashville Downtown Partnership every year.');
  ok(faithful2.length === 0, 'a reworded owners-pay claim passes too');

  const hired = await E2.checkRelations(doc2, 'NDP hired Tom Turner to run the District Management Corporation.');
  ok(hired.length >= 1 && hired.some(m => m.kind === 'inverted'),
    '"NDP hired Tom Turner" flags inverted against the DEF-derived Turner—hires→NDP edge');
  const hires = await E2.checkRelations(doc2, 'Tom Turner hires his own firm to manage downtown security.');
  ok(hires.length === 0, 'the faithful self-dealing claim passes');

  // The NDP quotes' SIG records are themselves FALLBACK guesses (neither
  // Kane nor Corman was promoted, so the mass-weighted fallback hands both
  // quotes to Tom Turner). The gate must not hold a claim against the
  // reader's own speculation — no flag, even though the claim is wrong.
  const fallbackVoice = await E2.checkRelations(doc2, 'Christina Kane called the arrangement Operation Flood the Zone.');
  ok(fallbackVoice.length === 0, 'a fallback-attributed SIG carries no verdict — the gate never holds a claim against a guess');

  // Wrong-speaker needs a CONFIDENT attribution and two projected figures.
  const DIALOGUE = 'Marta Voss met Henrik Stahl in the workshop. ' +
    '"The bridge will hold the winter load," said Marta Voss. ' +
    'Henrik Stahl shook his head at the drawings. ' +
    '"The cables are far too thin," said Henrik Stahl.';
  const doc3 = await E2.parseDocument('bridge.txt', DIALOGUE, 'bridge');
  const wrongVoice = await E2.checkRelations(doc3, 'Henrik Stahl said the bridge will hold the winter load.');
  ok(wrongVoice.length >= 1 && wrongVoice[0].kind === 'wrong-speaker',
    'an attribution hung on the wrong figure flags wrong-speaker via the confident SIG record: ' + JSON.stringify(wrongVoice.map(m => m.kind)));
  const rightVoice = await E2.checkRelations(doc3, 'Marta Voss said the bridge will hold the winter load.');
  ok(rightVoice.length === 0, 'the true attribution passes the SIG check');

  // ---- 3. provenance binds at generation ----
  console.log('• bindClaimKeys — the key is the source, never a costume');
  const tagged = 'Tom Turner is the president of the Nashville Downtown Partnership [s6]. The Metro Council will vote on the contract next month. [s10]';
  const bk = E2.bindClaimKeys(doc2, tagged, 'who is tom turner', 'factual');
  ok(/\{\{cite:ndp:6:s6\}\}/.test(bk.text), 'a tag before the period binds its claim to ITS span (s6)');
  ok(/\{\{cite:ndp:10:s10\}\}/.test(bk.text), 'a tag after the period is pulled back onto the sentence it closes (s10)');
  ok(!/\[s\d+\]/.test(bk.text), 'model-written tags never survive into the shipped text');
  ok(bk.keyed === 2 && bk.held.length === 0, 'both claims keyed, none held');

  // citation-as-costume defense: a claim VERBATIM from s10 but keyed to s2
  // must hold, not re-bind to the better-agreeing span
  const costume = E2.bindClaimKeys(doc2, 'The Metro Council will vote on the contract next month [s2].', 'what happens', 'factual');
  ok(costume.held.length === 1 && costume.held[0].key === 2,
    'a key that does not resolve HOLDS the claim — it is never overwritten by a better-agreeing span');
  ok(!/\{\{cite/.test(costume.text), 'the held claim ships uncited');
  ok(costume.audit.status === 'warn' && /HELD/.test(costume.audit.note), 'holding is named in the audit');

  // unkeyed claims fall back to the old binder — fallback only
  const unkeyed = E2.bindClaimKeys(doc2, 'The Metro Council will vote on the contract next month.', 'what happens', 'factual');
  ok(/\{\{cite:ndp:10:s10\}\}/.test(unkeyed.text), 'an unkeyed claim still binds through the fallback binder');
  ok(/fallback binder/.test(unkeyed.audit.note), 'the audit says the fallback served it');

  // ---- 4. the grounding-leak envelope (mechanism D) ----
  console.log('• groundingEnvelope — distance from the claim\'s OWN span, never a library');
  const s1 = doc2.sentenceTexts[1];
  const e2v = stub._d([[2, 1]]), e3v = stub._d([[3, 1]]);
  stub._set('Owners pay an assessment to the Partnership every year.', e2v);
  stub._set(s1, e2v);                                       // claim ≡ its span → strong
  stub._set('The lighthouse keeper rowed to Jupiter at dawn.', e3v);  // claim ⊥ its span → leak
  const envText = 'Owners pay an assessment to the Partnership every year. {{cite:ndp:1:s1}} ' +
    'The lighthouse keeper rowed to Jupiter at dawn. {{cite:ndp:2:s2}}';
  const env = await E2.groundingEnvelope(doc2, envText);
  ok(env.checked === 2, 'every cited claim is checked (' + env.checked + ')');
  ok(env.rows[0] && env.rows[0].band === 'strong', 'a claim that stays with its span reads strong');
  ok(env.rows[1] && env.rows[1].band === 'leak' && env.leaks === 1,
    'a claim that drifted from its own citation reads as a LEAK');

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
