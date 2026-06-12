/* ============================================================
   tools/predictive/fixtures.js — corpora and batteries for the three
   predictive-processing reads. Everything here is input data; the reads
   change no engine output.

   The NDP article is the crafted Tom Turner self-dealing piece from
   evo/experiments/question-probe.js — the journalism fixture whose
   summary inversion ("the Association cannot afford…") motivates the
   relation gate. Kept verbatim; if question-probe's copy changes, this
   one should follow.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'evo', 'corpus');
const FIX = path.join(ROOT, 'evo', 'fixtures');

const CAP = 20000;   // same slice question-probe reads — parse + embed stay cheap

function strip(t) {
  const a = t.indexOf('*** START');
  const s = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(s, b >= 0 ? b : t.length).trim();
}
const corpus = (file) => strip(fs.readFileSync(path.join(CORPUS, file), 'utf8')).slice(0, CAP);
const fixture = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');

const NDP = `Downtown Nashville Security: Who Pays, Who Profits

Downtown business owners pay an annual assessment to the Nashville Downtown Partnership. The Partnership is meant to fund cleaning, marketing, and security for the district.

The security contract is unusual. It is run through a recently created entity called NDMC PSO LLC — a shell company of the District Management Corporation (the DMC), created by the same person who runs the DMC and who then hires his own firm, NDP, to manage the downtown security operations through it. That person is Tom Turner.

Tom Turner is the president of the Nashville Downtown Partnership. He also chairs the board of the District Management Corporation. Christina Kane, a parking customer, said "it's like nobody cares." David Corman, who leads the rival firm Solaren Risk Management, called the arrangement "Operation Flood the Zone."

The Metro Council will vote on the contract next month. Council member Freddie O'Connell wrote on Twitter that the deal "deserves real scrutiny." Mayor Cooper has not commented.`;

// The two fixture documents tests/harness.js ships (VOSS) plus the evo set.
const VOSS = require(path.join(ROOT, 'tests', 'harness.js')).VOSS;

/* ---- documents by genre ----
   journalism — reported fact, actors, quotes, discontinuous moves
   essay      — sustained argument (the trajectory worry's home ground)
   narrative  — scene-to-scene continuity (where trajectory should hold) */
function documents() {
  return [
    { id: 'ndp', name: 'NDP.txt', genre: 'journalism', text: NDP },
    { id: 'dispatch', name: 'dispatch.txt', genre: 'journalism', text: fixture('stalls/dispatch.txt') },
    { id: 'liberty', name: 'liberty.txt', genre: 'essay', text: corpus('pg34901.txt') },
    { id: 'wealth', name: 'wealth.txt', genre: 'essay', text: corpus('pg3300.txt') },
    { id: 'federalist', name: 'federalist.txt', genre: 'essay', text: corpus('pg18.txt') },
    { id: 'treatise', name: 'treatise.txt', genre: 'essay', text: fixture('integration/treatise.txt') },
    { id: 'darkness', name: 'darkness.txt', genre: 'narrative', text: corpus('pg219.txt') },
    { id: 'goriot', name: 'goriot.txt', genre: 'narrative', text: corpus('pg1237.txt') },
    { id: 'voss', name: 'Voss.txt', genre: 'narrative', text: VOSS },
  ];
}

/* ---- read 1: scripted conversations ----
   Each sequence is a turn list over one document. Turns marked
   `continues: true` are anaphoric follow-ups (the continuity ingredient);
   the rest stand alone. Journalism + essay only, per the spec.
   The questions deliberately mix entity-named turns (where the top-down
   guess has a footprint to point at) with paraphrase turns (where it
   leans on heat alone). */
function conversations() {
  return [
    { docId: 'ndp', turns: [
      { q: 'who pays the assessment' },
      { q: 'what is the security contract' },
      { q: 'who is Tom Turner' },
      { q: 'tell me more about him', continues: true },
      { q: 'what did David Corman call the arrangement' },
      { q: 'what does his rival firm do', continues: true },
      { q: 'what happens next month' },
      { q: 'has the mayor said anything' },
    ] },
    { docId: 'dispatch', turns: [
      { q: 'what did the council decide' },
      { q: 'who argued for demolition' },
      { q: 'what did Ruiz say' },
      { q: 'what was her side of it', continues: true },
      { q: 'what did the engineer report' },
      { q: 'how did the vote go' },
    ] },
    { docId: 'liberty', turns: [
      { q: 'what is this essay about' },
      { q: 'what is the tyranny of the majority' },
      { q: 'when may power be exercised over an individual' },
      { q: 'what does it say about that principle', continues: true },
      { q: 'what about freedom of opinion' },
      { q: 'what is the struggle between liberty and authority' },
      { q: 'what does society exact from its members' },
    ] },
    { docId: 'wealth', turns: [
      { q: 'what is the division of labour' },
      { q: 'what is the example of the pin maker' },
      { q: 'why does it increase production' },
      { q: 'what else does it depend on', continues: true },
      { q: 'what do philosophers and porters have in common' },
      { q: 'what is the propensity to truck and barter' },
    ] },
    { docId: 'federalist', turns: [
      { q: 'what is this paper arguing for' },
      { q: 'what are the dangers of faction' },
      { q: 'why is a republic better than a democracy' },
      { q: 'what does it say about that difference', continues: true },
    ] },
    { docId: 'treatise', turns: [
      { q: 'what does a thermometer do' },
      { q: 'what is the dream of the costless reading' },
      { q: 'what does the instrument negotiate', continues: true },
    ] },
  ];
}

/* ---- read 3: the claims battery ----
   final.text-shaped claims, each a single sentence a model summary could
   ship. `expect` is the analyst's call (used to score the prototype, not
   to steer it): faithful claims must NOT flag; the inversions must.
   The first two NDP rows are the spec's bar:
     • "Association cannot afford" must flag against the owner-pays edge
     • the faithful owners-pay paraphrase must pass. */
function claims() {
  return [
    // — NDP: the canonical set —
    { docId: 'ndp', claim: 'The Association cannot afford its bills.', expect: 'flag', why: 'invented subject; agency inverted against the owner-pays edge' },
    { docId: 'ndp', claim: 'Downtown owners pay an annual assessment to the Partnership.', expect: 'pass', why: 'faithful paraphrase of the owner-pays edge' },
    { docId: 'ndp', claim: 'Business owners pay the Nashville Downtown Partnership every year.', expect: 'pass', why: 'faithful reworded owner-pays' },
    { docId: 'ndp', claim: 'The Partnership pays downtown business owners an annual assessment.', expect: 'flag', why: 'subject and object swapped on the pay edge' },
    { docId: 'ndp', claim: 'Tom Turner hires his own firm to manage downtown security.', expect: 'pass', why: 'faithful to the self-dealing structure' },
    { docId: 'ndp', claim: 'NDP hired Tom Turner to run the District Management Corporation.', expect: 'flag', why: 'agency inverted: the firm does not hire the man' },
    { docId: 'ndp', claim: 'Tom Turner is the president of the Nashville Downtown Partnership.', expect: 'pass', why: 'DEF-backed role claim' },
    { docId: 'ndp', claim: 'David Corman called the arrangement Operation Flood the Zone.', expect: 'pass', why: 'span-bound attribution' },
    { docId: 'ndp', claim: 'Solaren Risk Management manages the downtown security operations.', expect: 'flag', why: 'foreign subject: the rival firm holds no manage edge' },
    { docId: 'ndp', claim: 'The Metro Council will vote on the contract next month.', expect: 'pass', why: 'verbatim-adjacent span claim' },
    { docId: 'ndp', claim: 'Mayor Cooper has not commented.', expect: 'pass', why: 'stated negative, span-bound' },
    { docId: 'ndp', claim: 'The district is policed by volunteers from the Partnership.', expect: 'pass', why: 'false but relation-invisible — it rides a span; the invented-terms veto owns "volunteers", not the gate' },
    // — dispatch: the harbor vote —
    { docId: 'dispatch', claim: 'Alderman Vance opened for the motion to demolish.', expect: 'pass', why: 'span-bound' },
    { docId: 'dispatch', claim: 'Ruiz argued that the timbers were unsafe.', expect: 'flag', why: 'attribution inverted: that is Vance’s argument' },
    { docId: 'dispatch', claim: 'Ruiz said the harbor was the last of its kind on the coast.', expect: 'pass', why: 'faithful attribution' },
    // — voss: narrative control —
    { docId: 'voss', claim: 'Sefton wanted to reach Marlow on the mainland.', expect: 'pass', why: 'faithful relational claim' },
    { docId: 'voss', claim: 'Marlow was trying to reach Sefton at Voss Point.', expect: 'flag', why: 'direction of the expectation inverted' },
    { docId: 'voss', claim: 'The keeper said no one could row to the mainland tonight.', expect: 'pass', why: 'span-bound attribution' },
    { docId: 'voss', claim: 'Edith argued with the keeper about the boat.', expect: 'flag', why: 'wrong subject: Sefton argued, Edith listened' },
  ];
}

module.exports = { NDP, VOSS, documents, conversations, claims, corpus, fixture, CAP };
