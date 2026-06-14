/* ============================================================
   tools/predictive/router-fixtures.js — analyst-labeled batteries for the
   router-reading gate (read-router.js, Phase 0 of the "router is a reading"
   brief). Everything here is input data; the read changes no engine output.

   Three batteries:
     • intentBattery()      — prompts with the analyst's call of which of the
                              five classifyIntent classes they are, plus the
                              prompt's grammatical KIND. Ground truth for B.1
                              (does the parse's operator shape recover intent
                              as well as the regex cascade?). The labels score
                              both readers; they are fed to neither.
     • resolutionBattery()  — extra anchor-annotated pronoun/ellipsis turns to
                              supplement fixtures.anchorConversations() for B.2
                              (chat figure vs document salience) and B.3
                              (confidence calibration). Crafted to span the
                              three NUL states: a dominant figure (resolved,
                              high confidence), two co-deposited figures
                              (ambiguous, mid), and a faded one (low / absent).
     • acquisitionBattery() — pronoun/ellipsis ACQUISITION turns with a prior
                              that seeds a hot figure, and the analyst's call of
                              the entity a correctly-built query must name.
                              Ground truth for Read C / B.4 (does a query built
                              from the resolved binding beat pickQuery on the
                              raw string?).

   The corpora (NDP, VOSS, the binding fixtures) are reused from fixtures.js so
   anchors project onto the same graphs the conversation-walk read measured.
   ============================================================ */
'use strict';
const FIX = require('./fixtures');

/* ---- B.1: the intent battery ----------------------------------------------
   `intent` is the analyst's call ∈ the five classifyIntent classes:
     who      — a request for the CAST / list of people (not "who is <X>",
                which is a factual identity ask).
     summary  — a request ABOUT the document as a whole.
     command  — an imperative aimed OUTSIDE the page (acquire / search / fetch).
     confirm  — an assertion or yes/no offered for verification.
     factual  — a specific fact question (the residual; the cascade's default).
   `kind` is the grammatical shape, so the read can score questions and
   fragments specifically (the brief: the parse was tuned on prose; a prompt is
   interrogative, imperative, and elliptical). One of:
     question | fragment | imperative | declarative
   The battery deliberately overweights `question` and `fragment`. */
function intentBattery() {
  return [
    // — who (cast / list) —
    { q: 'who is in this story', intent: 'who', kind: 'question' },
    { q: 'who are the characters', intent: 'who', kind: 'question' },
    { q: 'who all appears here', intent: 'who', kind: 'question' },
    { q: 'list the people in the document', intent: 'who', kind: 'imperative' },
    { q: 'the cast?', intent: 'who', kind: 'fragment' },
    { q: 'main characters', intent: 'who', kind: 'fragment' },
    { q: 'everyone who shows up', intent: 'who', kind: 'fragment' },

    // — summary (about the whole document) —
    { q: 'what is this about', intent: 'summary', kind: 'question' },
    { q: "what's the main point", intent: 'summary', kind: 'question' },
    { q: 'what kind of document is this', intent: 'summary', kind: 'question' },
    { q: 'summarize this', intent: 'summary', kind: 'imperative' },
    { q: 'give me the gist', intent: 'summary', kind: 'imperative' },
    { q: 'tl;dr', intent: 'summary', kind: 'fragment' },
    { q: 'overview?', intent: 'summary', kind: 'fragment' },
    { q: 'the gist of it', intent: 'summary', kind: 'fragment' },

    // — command (acquire / act outside the page) —
    { q: 'search wikipedia for Frank', intent: 'command', kind: 'imperative' },
    { q: 'look up the Treaty of Versailles', intent: 'command', kind: 'imperative' },
    { q: 'google cadaver dogs', intent: 'command', kind: 'imperative' },
    { q: 'websearch the company', intent: 'command', kind: 'imperative' },
    { q: 'find the article on socialism', intent: 'command', kind: 'imperative' },
    { q: 'can you search for the author', intent: 'command', kind: 'question' },
    { q: 'look up his employer', intent: 'command', kind: 'imperative' },
    { q: 'pull up the wiki page for Voss', intent: 'command', kind: 'imperative' },

    // — confirm (assert / verify) —
    { q: 'you said he runs the firm', intent: 'confirm', kind: 'declarative' },
    { q: 'Tom is the president, right?', intent: 'confirm', kind: 'question' },
    { q: "so it's a nonprofit?", intent: 'confirm', kind: 'question' },
    { q: 'that is correct, yes?', intent: 'confirm', kind: 'fragment' },
    { q: 'it sounds like a shell company', intent: 'confirm', kind: 'declarative' },
    { q: 'Tom Turner is the president', intent: 'confirm', kind: 'declarative' },
    { q: 'is that who pays the assessment', intent: 'confirm', kind: 'question' },
    { q: 'you mentioned a rival firm', intent: 'confirm', kind: 'declarative' },

    // — factual (a specific fact; includes "who is <X>") —
    { q: 'who is Tom Turner', intent: 'factual', kind: 'question' },
    { q: 'what did Corman call the arrangement', intent: 'factual', kind: 'question' },
    { q: 'where is Voss Point', intent: 'factual', kind: 'question' },
    { q: 'when is the council vote', intent: 'factual', kind: 'question' },
    { q: 'what does the DMC do', intent: 'factual', kind: 'question' },
    { q: 'why did he want to row tonight', intent: 'factual', kind: 'question' },
    { q: 'what about his role', intent: 'factual', kind: 'fragment' },
    { q: 'his job?', intent: 'factual', kind: 'fragment' },
    { q: 'her side of it', intent: 'factual', kind: 'fragment' },
    { q: 'how much is the assessment', intent: 'factual', kind: 'question' },
    { q: 'what happened to the boat', intent: 'factual', kind: 'question' },
  ];
}

/* ---- B.2 / B.3: supplementary resolution turns ----------------------------
   Anchor-annotated conversations over the same documents, focused on the three
   NUL states the brief insists must not collapse. Each turn:
     anchor      — the on-page referent the pronoun/ellipsis turns on (the
                   analyst's call; null when the field should hold no antecedent).
     state       — the analyst's call of the honest resolution state for the
                   READ to score itself against:
                     resolved  — one figure clearly dominant
                     ambiguous — two figures genuinely in contention
                     absent    — the field carries no antecedent (cold/faded)
     continues   — anaphoric follow-up (carries no name of its own).
   These supplement fixtures.anchorConversations() (16 pronoun turns) so the
   calibration bins have spread. */
function resolutionBattery() {
  return [
    { docId: 'ndp', turns: [
      { q: 'who is Tom Turner', anchor: 'Tom Turner' },
      { q: 'what is his role', continues: true, anchor: 'Tom Turner', state: 'resolved' },
      { q: 'and his firm?', continues: true, anchor: 'Tom Turner', state: 'resolved' },
      // David Corman now named alongside Tom: two figures in play.
      { q: 'what did David Corman say about it', anchor: 'David Corman' },
      { q: 'what does his firm do', continues: true, anchor: 'David Corman', state: 'ambiguous' },
      // a cold turn: nobody has been the figure (mayor never deposited).
      { q: 'has anyone else weighed in', anchor: null, state: 'absent' },
    ] },
    { docId: 'voss', turns: [
      { q: 'who is Sefton', anchor: 'Sefton' },
      { q: 'what does he want', continues: true, anchor: 'Sefton', state: 'resolved' },
      { q: 'what did Edith think', anchor: 'Edith' },
      { q: 'what did she say to him', continues: true, anchor: ['Edith', 'Sefton'], state: 'ambiguous' },
      { q: 'why', continues: true, anchor: 'Edith', state: 'resolved' },
    ] },
    { docId: 'steward', turns: [
      { q: 'what did Dron believe', anchor: 'Dron' },
      { q: 'what did he do about the grain', continues: true, anchor: 'Dron', state: 'resolved' },
      // a brand-new cold ellipsis with no prior figure deposited for it.
      { q: 'and the weather that winter?', anchor: null, state: 'absent' },
    ] },
  ];
}

/* ---- Read C / B.4: the acquisition battery --------------------------------
   Each case seeds a hot figure with `setup` turns, then issues an acquisition
   turn whose query CANNOT be built from the raw string alone (it names the
   target only by pronoun / ellipsis). `expect` is the entity a correctly
   resolved query must name; `surface` is the pronoun the field must resolve.
   The two `control` cases name the target outright — the resolved builder must
   not regress them. */
function acquisitionBattery() {
  return [
    { docId: 'ndp', setup: ['who is Tom Turner'], q: 'look up his employer', surface: 'his', expect: 'Tom Turner' },
    { docId: 'ndp', setup: ['who is Tom Turner', 'tell me more about him'], q: 'search wikipedia for him', surface: 'him', expect: 'Tom Turner' },
    { docId: 'voss', setup: ['who is Sefton'], q: 'look him up', surface: 'him', expect: 'Sefton' },
    { docId: 'dispatch', setup: ['what did Ruiz say about the harbor'], q: 'find her on wikipedia', surface: 'her', expect: 'Ruiz' },
    { docId: 'steward', setup: ['what did Princess Mary decide'], q: 'look up her estate', surface: 'her', expect: 'Princess Mary' },
    // controls: the raw string already names the target; resolution must not break it.
    { docId: 'ndp', setup: ['who is Tom Turner'], q: 'look up the Metro Council', surface: null, expect: 'Metro Council', control: true },
    { docId: 'ndp', setup: [], q: 'search wikipedia for Frank', surface: null, expect: 'Frank', control: true },
  ];
}

/* The documents the batteries reference, by id (reused from fixtures.js). */
function documentsById() {
  const out = {};
  for (const spec of FIX.anchorDocuments()) out[spec.id] = spec;
  return out;
}

module.exports = { intentBattery, resolutionBattery, acquisitionBattery, documentsById };
