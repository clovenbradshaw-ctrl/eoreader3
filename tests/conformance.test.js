/* ============================================================
   Tests for the reading-conformance checker (tools/conformance.js).

   The spec is docs/reading-conformance.md: seven invariants, each
   scored as one bit of a 7-bit vector in dependency order
   (ADMISSION BINDING SPEECH COMPANY DARK WEIGHT CUSTOM).

   Two frozen fixtures carry the contract:
     · a CONFORMING log (the Harbor log) that scores 1 1 1 1 1 1 1 —
       proof the checker can be satisfied, not just offended;
     · a TORONTO-SHAPED log reproducing the witness corpus of
       2026-06-11 in miniature (footer chrome minted as referents,
       deeds filed as SYN, a metaphor speaking by fallback, fragment
       DEFs, unmarked dark, furniture read with no chrome custom)
       that scores 0 0 0 0 0 1 0 — the permanent failing corpus.

   Then each invariant is flipped in isolation (break one law in the
   conforming log, exactly one bit falls), the session-side advisory
   checks are exercised, and the checker is run against a live parse.

   Run with `node tests/conformance.test.js`.
   ============================================================ */
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../tools/conformance');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }
const laws = (res, inv) => res.bits[inv].findings.map(f => f.law);

/* ---- fixture builder: a coherent cleon-ingestion/1 dump from spans + events ---- */
function buildDump(name, spans, events, entities, lexicon) {
  const evBySent = new Map();
  const ops = {};
  for (const ev of events) {
    ops[ev.op] = (ops[ev.op] || 0) + 1;
    if (ev.sentence_idx == null) continue;
    if (!evBySent.has(ev.sentence_idx)) evBySent.set(ev.sentence_idx, []);
    evBySent.get(ev.sentence_idx).push(ev);
  }
  const sentences = spans.map((t, i) => {
    const evs = evBySent.get(i) || [];
    const o = {}; for (const e of evs) o[e.op] = (o[e.op] || 0) + 1;
    return { i, chars: t.length, words: t.split(/\s+/).length, terms: 0, events: evs.length, ops: o, ents: [] };
  });
  const dark = sentences.filter(s => s.events === 0).length;
  return {
    schema: 'cleon-ingestion/1', at: '2026-06-11T00:00:00.000Z',
    doc: { id: name, name, kind: 'prose', lang: 'en', sentences: spans.length },
    words: { occurrences: 0, indexed: 0, stop: 0, dropped: 0 },
    coverage: { sentences: spans.length, withEvents: spans.length - dark, dark },
    counts: { events: events.length, ops, entities: entities.length },
    spans, lexicon: lexicon || [], stopwords: [], sentences, entities, events,
  };
}

/* ---- the CONFORMING fixture: the Harbor log ---- */
function makeConformingDump() {
  const spans = [
    /*0*/ 'Subscribe',
    /*1*/ 'Harbor Notes',
    /*2*/ 'Eleanor Voss inspected the breakwater on Tuesday.',
    /*3*/ 'Voss warned the Board about the breakwater.',
    /*4*/ '"The wall will fail," Voss said.',
    /*5*/ 'Thomas Reed disagreed with Voss in the third meeting.',
    /*6*/ 'Reed kept the old charts.',
    /*7*/ 'A gull crossed the harbor.',
    /*8*/ '"It will hold," said Reed.',
    /*9*/ 'Eleanor Voss and the Board met again in November.',
    /*10*/ 'Contact Submit Advertise',
  ];
  let q = 0;
  const ev = (id, op, fields) => Object.assign({ id, seq: q++, op }, fields);
  const events = [
    ev('ev-0', 'REC', { target: 'rule:attribution_verbs', action: 'add-token', value: 'said', ledger_lid: 'lid-0', basis: { slot_sightings: 2 }, reason: 'induced from the quote slot — typography, not lexicon', sentence_idx: null, src: 'verb-induction' }),
    ev('ev-1', 'NUL', { sentence_idx: 0, reason: 'chrome', src: 'register' }),
    ev('ev-2', 'NUL', { sentence_idx: 1, reason: 'chrome', src: 'register' }),
    ev('ev-3', 'INS', { target: 'Eleanor Voss', entityType: 'person', referent_id: 'r-1', sentence_idx: 2, src: 'two-sighting' }),
    ev('ev-4', 'INS', { target: 'Board', entityType: 'org', referent_id: 'r-3', sentence_idx: 3, src: 'two-sighting' }),
    ev('ev-5', 'SYN', { method: 'gravity', sites: ['eleanor voss', 'voss'], siteNames: ['Eleanor Voss', 'Voss'], canonical: 'Eleanor Voss', referent_ids: ['r-1', 'r-4'], canonical_referent_id: 'r-1', total_mentions: 4, observed: { frame: { at_sentence: 3, rules_rev: 1, gamma: 0.7, delta: 2 }, force: 2.1, mass: 2, momentum: 1.2, overlap: 1 }, sentence_idx: 3, src: 'inline-gravity' }),
    ev('ev-6', 'CON', { s: 'Voss', v: 'warned', o: 'the Board', sRef: 'r-1', oRef: 'r-3', sentence_idx: 3, src: 'svo' }),
    ev('ev-7', 'SIG', { speaker: 'Eleanor Voss', quote: 'The wall will fail', speakerHint: { name: 'Eleanor Voss', referent_id: 'r-1' }, attributed: 'named', sentence_idx: 4, src: 'quote' }),
    ev('ev-8', 'SIG', { speaker: '?', quote: 'So be it', speakerHint: null, attributed: 'unattributed', sentence_idx: 4, src: 'quote' }),
    ev('ev-9', 'INS', { target: 'Thomas Reed', entityType: 'person', referent_id: 'r-2', sentence_idx: 5, src: 'two-sighting' }),
    ev('ev-10', 'CON', { s: 'Thomas Reed', v: 'disagreed with', o: 'Voss', sRef: 'r-2', oRef: 'r-1', sentence_idx: 5, src: 'svo' }),
    ev('ev-11', 'DEF', { target: 'Thomas Reed', path: 'gender', value: 'm', sentence_idx: 6, src: 'pronoun-binding' }),
    ev('ev-12', 'NUL', { sentence_idx: 7, reason: 'no-event', src: 'register' }),
    ev('ev-13', 'SIG', { speaker: 'Thomas Reed', quote: 'It will hold', speakerHint: { name: 'Thomas Reed', referent_id: 'r-2' }, attributed: 'named', sentence_idx: 8, src: 'quote' }),
    ev('ev-14', 'DEF', { target: 'Eleanor Voss', path: 'frame', value: 'frame:9a3b1c2d', sentence_idx: 9, src: 'frame-mint' }),
    ev('ev-15', 'DEF', { target: 'Thomas Reed', path: 'frame', value: 'frame:0e4f5a6b', sentence_idx: 9, src: 'frame-mint' }),
    ev('ev-16', 'DEF', { target: 'Board', path: 'frame', value: 'frame:7c8d9e0f', sentence_idx: 9, src: 'frame-mint' }),
    ev('ev-17', 'NUL', { sentence_idx: 10, reason: 'chrome', src: 'register' }),
  ];
  const entities = [
    { name: 'Eleanor Voss', key: 'eleanor voss', type: 'person', mentions: 4, mass: 4, sents: [2, 3, 4, 9] },
    { name: 'Thomas Reed', key: 'thomas reed', type: 'person', mentions: 3, mass: 3, sents: [5, 6, 8] },
    { name: 'Board', key: 'board', type: 'org', mentions: 2, mass: 2, sents: [3, 9] },
  ];
  return buildDump('harbor.txt', spans, events, entities, [{ token: 'breakwater', count: 2, sents: [2, 3] }]);
}

/* ---- the FAILING fixture: the Toronto Life corpus of 2026-06-11, in miniature.
   Event ids echo the spec's witnesses (ev-0, ev-3…ev-8, ev-15, ev-25, ev-37,
   ev-41, ev-76, ev-370, ev-452, ev-465, ev-490). Frozen: this is the permanent
   failing corpus, and its vector is pinned at 0 0 0 0 0 1 0. ---- */
function makeTorontoDump() {
  const spans = [
    /*0*/ 'Terror in the Streets',
    /*1*/ 'Subscribe',
    /*2*/ 'Latest Issue',
    /*3*/ 'By Anna Chen And Toronto Life',
    /*4*/ 'Tse Chi Lop ran a syndicate known as Sam Gor.',
    /*5*/ 'The syndicate moved methamphetamine across five countries.',
    /*6*/ 'Investigators compared Tse to El Chapo.',
    /*7*/ '"We never lose," Tse told an associate.',
    /*8*/ 'Sam Gor earned seventeen billion dollars in a year.',
    /*9*/ 'El Chapo was worth a fraction of that.',
    /*10*/ 'Often the money moved through casinos.',
    /*11*/ 'Advertisement This',
    /*12*/ 'Contact', /*13*/ 'Submit', /*14*/ 'Advertise', /*15*/ 'Renew', /*16*/ 'Manage', /*17*/ 'Terms',
  ];
  let q = 0;
  const ev = (id, op, fields) => Object.assign({ id, seq: q++, op }, fields);
  const events = [
    // the one law followed twice over: a custom admitted through the gate…
    ev('ev-0', 'REC', { target: 'rule:attribution_verbs', action: 'add-token', value: 'says', ledger_lid: 'lid-0', basis: { slot_sightings: 2 }, reason: 'typography, not lexicon', sentence_idx: null, src: 'verb-induction' }),
    // …and the dump-wide WEIGHT discipline (measurements only in observed.frame)
    ev('ev-1', 'INS', { target: 'Streets', entityType: 'thing', referent_id: 'r-0', sentence_idx: 0, src: 'first-sighting' }),
    ev('ev-490', 'INS', { target: 'Latest Issue', entityType: 'thing', referent_id: 'r-10', sentence_idx: 2, src: 'first-sighting' }),
    ev('ev-16', 'INS', { target: 'Anna Chen And', entityType: 'person', referent_id: 'r-11', sentence_idx: 3, src: 'first-sighting' }),
    ev('ev-17', 'INS', { target: 'Toronto', entityType: 'place', referent_id: 'r-12', sentence_idx: 3, src: 'first-sighting' }),
    ev('ev-18', 'DEF', { target: 'And Toronto', path: 'class', value: 'a byline fragment', sentence_idx: 3, src: 'apposition' }),
    ev('ev-41', 'DEF', { target: 'Toronto', path: 'class', value: 'his', sentence_idx: 3, src: 'apposition' }),
    ev('ev-20', 'INS', { target: 'Tse', entityType: 'person', referent_id: 'r-1', sentence_idx: 4, src: 'first-sighting' }),
    ev('ev-21', 'INS', { target: 'Sam Gor', entityType: 'person', referent_id: 'r-2', sentence_idx: 4, src: 'first-sighting' }),
    ev('ev-25', 'SYN', { s: 'Tse Chi Lop', v: 'syndicate known', o: 'Sam Gor', sHint: null, oHint: null, observed: { frame: { at_sentence: 4, rules_rev: 1, gamma: 0.7, delta: 2 }, overlap: 0.4 }, sentence_idx: 4, src: 'svo' }),
    ev('ev-22', 'INS', { target: 'El Chapo', entityType: 'thing', referent_id: 'r-13', sentence_idx: 6, src: 'first-sighting' }),
    ev('ev-26', 'SYN', { s: 'Investigators', v: 'compared', o: 'El Chapo', sHint: null, oHint: null, sentence_idx: 6, src: 'svo' }),
    ev('ev-76', 'SIG', { speaker: 'Jeff Bezos', quote: 'Terror in the Streets', speakerHint: null, attributed: 'fallback', sentence_idx: 0, src: 'quote' }),
    ev('ev-30', 'SYN', { s: 'Tse', v: 'told', o: 'associate', sHint: null, oHint: null, sentence_idx: 7, src: 'svo' }),
    ev('ev-452', 'SIG', { speaker: 'Sam Gor', quote: 'We never lose', speakerHint: { name: 'Sam Gor', referent_id: 'r-2' }, attributed: 'named', sentence_idx: 7, src: 'quote' }),
    ev('ev-27', 'SYN', { s: 'Sam Gor', v: 'earned', o: 'year', sHint: null, oHint: null, sentence_idx: 8, src: 'svo' }),
    ev('ev-465', 'SIG', { speaker: 'Sam Gor', quote: 'seventeen billion in a year', speakerHint: { name: 'Sam Gor', referent_id: 'r-2' }, attributed: 'named', sentence_idx: 8, src: 'quote' }),
    ev('ev-37', 'DEF', { target: 'El Chapo', path: 'class', value: 'worth a fraction of that', sentence_idx: 9, src: 'copular' }),
    ev('ev-370', 'DEF', { target: 'Often', path: 'class', value: 'how the money moved', sentence_idx: 10, src: 'apposition' }),
    ev('ev-15', 'INS', { target: 'Advertisement This', entityType: 'thing', referent_id: 'r-9', sentence_idx: 11, src: 'first-sighting' }),
    ev('ev-3', 'INS', { target: 'Contact', entityType: 'thing', referent_id: 'r-3', sentence_idx: 12, src: 'first-sighting' }),
    ev('ev-4', 'INS', { target: 'Submit', entityType: 'thing', referent_id: 'r-4', sentence_idx: 13, src: 'first-sighting' }),
    ev('ev-5', 'INS', { target: 'Advertise', entityType: 'thing', referent_id: 'r-5', sentence_idx: 14, src: 'first-sighting' }),
    ev('ev-6', 'INS', { target: 'Renew', entityType: 'thing', referent_id: 'r-6', sentence_idx: 15, src: 'first-sighting' }),
    ev('ev-7', 'INS', { target: 'Manage', entityType: 'thing', referent_id: 'r-7', sentence_idx: 16, src: 'first-sighting' }),
    ev('ev-8', 'INS', { target: 'Terms', entityType: 'thing', referent_id: 'r-8', sentence_idx: 17, src: 'first-sighting' }),
  ];
  const entities = [
    { name: 'Tse', key: 'tse', type: 'person', mentions: 3, mass: 3, sents: [4, 6, 7] },
    { name: 'Sam Gor', key: 'sam gor', type: 'person', mentions: 3, mass: 3, sents: [4, 8] },
    { name: 'El Chapo', key: 'el chapo', type: 'thing', mentions: 2, mass: 2, sents: [6, 9] },
    { name: 'Streets', key: 'streets', type: 'thing', mentions: 1, mass: 1, sents: [0] },
    { name: 'Latest Issue', key: 'latest issue', type: 'thing', mentions: 1, mass: 1, sents: [2] },
    { name: 'Anna Chen And', key: 'anna chen and', type: 'person', mentions: 1, mass: 1, sents: [3] },
    { name: 'Toronto', key: 'toronto', type: 'place', mentions: 1, mass: 1, sents: [3] },
    { name: 'Advertisement This', key: 'advertisement this', type: 'thing', mentions: 1, mass: 1, sents: [11] },
    { name: 'Contact', key: 'contact', type: 'thing', mentions: 1, mass: 1, sents: [12] },
    { name: 'Submit', key: 'submit', type: 'thing', mentions: 1, mass: 1, sents: [13] },
    { name: 'Advertise', key: 'advertise', type: 'thing', mentions: 1, mass: 1, sents: [14] },
    { name: 'Renew', key: 'renew', type: 'thing', mentions: 1, mass: 1, sents: [15] },
    { name: 'Manage', key: 'manage', type: 'thing', mentions: 1, mass: 1, sents: [16] },
    { name: 'Terms', key: 'terms', type: 'thing', mentions: 1, mass: 1, sents: [17] },
  ];
  return buildDump('toronto-life.txt', spans, events, entities,
    [{ token: 'guzmán', count: 1, sents: [9] }, { token: 'syndicate', count: 2, sents: [4, 5] }]);
}

async function main() {
  group('fold — diacritics and case meet before absence is declared', () => {
    eq(C.fold('Guzmán'), 'guzman', 'Guzmán folds to guzman');
    eq(C.fold('  EL  Chapo '), 'el chapo', 'case + whitespace fold');
  });

  group('chrome pack — furniture is recognized, prose is not', () => {
    ok(C.isChromeSpan('Contact Submit Advertise Renew Manage Terms', C.DEFAULT_PACK), 'a footer link run is chrome');
    ok(C.isChromeSpan('By Anna Chen And Toronto Life', C.DEFAULT_PACK), 'a byline is chrome');
    ok(C.isChromeSpan('Advertisement This', C.DEFAULT_PACK), 'an ad slug is chrome');
    ok(!C.isChromeSpan('Terror in the Streets', C.DEFAULT_PACK), 'a title with function words is not claimed by the heuristic');
    ok(!C.isChromeSpan('Tse Chi Lop ran a syndicate known as Sam Gor.', C.DEFAULT_PACK), 'a finished sentence is never chrome');
    ok(!C.isChromeSpan('"Marlow Is Waiting"', C.DEFAULT_PACK), 'quoted speech is never chrome');
  });

  group('register packs — conventions live in JSON, never in the checks', () => {
    const packsDir = path.join(__dirname, '..', 'tools', 'packs');
    const load = (n) => Object.assign({}, C.DEFAULT_PACK, JSON.parse(fs.readFileSync(path.join(packsDir, n + '.json'), 'utf8')));
    const g = load('gutenberg');
    ok(C.isChromeSpan('CONTENTS', g), 'gutenberg: a contents head is chrome');
    ok(C.isChromeSpan('Chapter II.', g), 'gutenberg: a chapter head is chrome');
    ok(C.isChromeSpan('XIV', g), 'gutenberg: a roman-numeral line is chrome');
    ok(C.isChromeSpan('[Illustration: The lamp at dusk.]', g), 'gutenberg: an illustration bracket is chrome');
    ok(C.isChromeSpan('FATHER GORIOT', g), 'gutenberg: an all-caps title line is chrome');
    ok(!C.isChromeSpan('The whale swam on, indifferent to the harpoon.', g), 'gutenberg: prose stays prose');
    const es = load('es');
    ok(C.isChromeSpan('Capítulo primero', es), 'es: a capítulo head is chrome');
    ok(es.pronouns.includes('ella') && !es.pronouns.includes('he'), 'es: the pronoun inventory is Spanish');
    const zh = load('zh');
    ok(C.isChromeSpan('第一回', zh), 'zh: a chapter head (第一回) is chrome');
    ok(zh.pronouns.includes('他'), 'zh: the pronoun inventory is Chinese');
    const ja = load('ja');
    ok(C.isChromeSpan('底本：青空文庫', ja), 'ja: an Aozora colophon line is chrome');
    ok(C.isChromeSpan('一', ja), 'ja: a bare kanji-numeral section head is chrome');
  });

  group('the conforming log scores 1 1 1 1 1 1 1', () => {
    const res = C.checkDump(makeConformingDump());
    eq(res.vectorString, '1 1 1 1 1 1 1', 'all seven invariants followed');
    ok(res.conformant, 'the dump conforms');
    eq(res.bits.BINDING.stats.con, 2, 'both bonds are CON');
    eq(res.bits.BINDING.stats.syn_synthesis, 1, 'the merger stays SYN — synthesis, not a bond');
    eq(res.bits.DARK.stats.dark, 4, 'four spans deposited nothing (two chrome, one quiet, one footer)');
    eq(res.bits.DARK.stats.unmarked, 0, 'every dark span carries its reason');
  });

  group('the Toronto-shaped corpus scores 0 0 0 0 0 1 0 — the permanent failing corpus', () => {
    const res = C.checkDump(makeTorontoDump());
    eq(res.vectorString, '0 0 0 0 0 1 0', 'six of seven violated, WEIGHT followed');
    const adm = res.bits.ADMISSION.findings.map(f => f.detail).join(' | ');
    for (const name of ['Contact', 'Submit', 'Advertise', 'Renew', 'Manage', 'Terms', 'Advertisement This', 'Latest Issue']) {
      ok(adm.includes(`"${name}"`), `ADMISSION witnesses the one-mention chrome referent "${name}"`);
    }
    ok(res.bits.BINDING.findings.some(f => f.law === 'deed-misfiled' && f.events.includes('ev-25')), 'BINDING witnesses ev-25: Tse—Sam Gor filed as SYN, not CON');
    eq(res.bits.BINDING.stats.con, 0, 'zero bonds in the graph');
    ok(res.bits.SPEECH.findings.some(f => f.law === 'fallback-without-agency' && f.events.includes('ev-76')), 'SPEECH witnesses ev-76: the title handed to Jeff Bezos by fallback, no agency in the log');
    ok(res.bits.COMPANY.findings.some(f => f.law === 'def-target-not-referent' && f.events.includes('ev-370')), 'COMPANY witnesses ev-370: "Often" defined though it is no referent');
    ok(res.bits.COMPANY.findings.some(f => f.law === 'def-value-fragment' && f.events.includes('ev-37')), 'COMPANY witnesses ev-37: El Chapo defined as a copied fragment');
    ok(res.bits.COMPANY.findings.some(f => f.law === 'def-value-fragment' && f.events.includes('ev-41')), 'COMPANY witnesses ev-41: Toronto defined as "his"');
    ok(res.bits.DARK.findings.some(f => f.detail.includes('s5')), 'DARK witnesses the unmarked dark span s5');
    eq(res.bits.WEIGHT.bit, 1, 'WEIGHT is the one bit the corpus follows — measurements live in observed.frame');
    ok(res.bits.CUSTOM.findings.some(f => f.law === 'register-without-customs'), 'CUSTOM witnesses furniture read as prose with no chrome custom');
    ok(!res.bits.CUSTOM.findings.some(f => f.events.includes('ev-0')), 'CUSTOM does not blame ev-0 — "says" was admitted through the gate');
  });

  group('each law flips exactly its own bit', () => {
    const flip = (mutate) => {
      const d = structuredClone(makeConformingDump());
      mutate(d);
      return C.checkDump(d).vectorString;
    };
    eq(flip(d => { d.entities[2].sents = [3]; }), '0 1 1 1 1 1 1', 'a single-sighting referent fails ADMISSION alone');
    eq(flip(d => { d.events.find(e => e.id === 'ev-6').op = 'SYN'; }), '1 0 1 1 1 1 1', 'a resolved deed filed as SYN fails BINDING alone');
    eq(flip(d => { Object.assign(d.events.find(e => e.id === 'ev-8'), { speaker: 'Jeff Bezos', attributed: 'fallback' }); }), '1 1 0 1 1 1 1', 'fallback onto a name with no agency in the log fails SPEECH alone');
    eq(flip(d => { d.events.find(e => e.id === 'ev-7').attributed = 'fallback'; }), '1 1 1 1 1 1 1', 'fallback onto proven agency (Voss is subject of a deed) satisfies the law');
    eq(flip(d => { d.events.find(e => e.id === 'ev-11').target = 'Often'; }), '1 1 1 0 1 1 1', 'a DEF on a non-referent fails COMPANY alone');
    eq(flip(d => { delete d.events.find(e => e.id === 'ev-12').reason; }), '1 1 1 1 0 1 1', 'an unmarked dark span fails DARK alone');
    eq(flip(d => { d.events.find(e => e.id === 'ev-10').confidence = 0.97; }), '1 1 1 1 1 0 1', 'confidence stored on an event fails WEIGHT alone');
    eq(flip(d => { d.events.find(e => e.id === 'ev-0').basis.slot_sightings = 1; }), '1 1 1 1 1 1 0', 'a rule admitted on one sighting fails CUSTOM alone');
  });

  group('more of the laws, individually', () => {
    const d1 = structuredClone(makeConformingDump());
    d1.events.find(e => e.id === 'ev-6').sRef = null;   // CON kept, referent dropped
    const r1 = C.checkDump(d1);
    ok(laws(r1, 'BINDING').includes('bond-without-referents') || r1.bits.BINDING.bit === 1,
       'a CON that cannot name two referents is a bond written near the names — or the surface still resolves it');
    const d2 = structuredClone(makeConformingDump());
    d2.events.find(e => e.id === 'ev-14').value = 'inspected the breakwater';
    eq(C.checkDump(d2).bits.COMPANY.bit, 0, 'a frame DEF whose value is a clause fragment fails COMPANY');
    const d3 = structuredClone(makeConformingDump());
    d3.entities.push({ name: 'Harbor Watch', key: 'harbor watch', type: 'org', mentions: 2, mass: 2, sents: [2, 5] });
    const r3 = C.checkDump(d3);
    ok(laws(r3, 'COMPANY').includes('entity-without-frame'), 'an admitted entity with no frame DEF fails COMPANY — what cannot be tested cannot be known');
    const d4 = structuredClone(makeConformingDump());
    d4.events.find(e => e.id === 'ev-13').attributed = 'continuation';
    ok(laws(C.checkDump(d4), 'SPEECH').includes('continuation-without-prior'), 'a continuation with no prior confident attribution fails SPEECH');
    const d5 = structuredClone(makeConformingDump());
    d5.events.push({ id: 'ev-x', seq: 99, op: 'SIG', speaker: 'Board', quote: 'Approved', speakerHint: { name: 'Board' }, attributed: 'named', sentence_idx: 9, src: 'quote' });
    ok(laws(C.checkDump(d5), 'SPEECH').includes('speechless-type'), 'an org speaking with no transmuting DEF fails SPEECH');
    d5.events.push({ id: 'ev-y', seq: 98, op: 'DEF', target: 'Board', path: 'class', value: 'person', sentence_idx: 9, src: 'speech-implies-person' });
    eq(C.checkDump(d5).bits.SPEECH.bit, 1, 'the same org speaks legitimately after a transmuting DEF');
  });

  group('EVA — frames must meet when documents do', () => {
    const a = makeConformingDump();
    const b = structuredClone(a); b.doc.name = 'harbor-2.txt';
    const r = C.checkDump(a, { reports: [a, b] });
    eq(r.bits.COMPANY.bit, 0, 'two documents with zero EVA fail COMPANY');
    ok(laws(r, 'COMPANY').includes('frames-never-met'), 'the finding names the law');
    b.counts.ops.EVA = 3;
    eq(C.checkDump(a, { reports: [a, b] }).bits.COMPANY.bit, 1, 'EVA firing across the set satisfies it');
  });

  group('session checks are advisory — they never move a bit', () => {
    const toronto = makeTorontoDump();
    const turns = [
      { id: 'turn-3', steps: [{ t: 'retrieve', hits: [{ idx: 9, score: 0.30, text: 'a gun in a mouth' }] }], final: { engine: 'model', text: 'He put a gun in his mouth.', audit: { grounded: true } } },
      { id: 'turn-10', steps: [{ t: 'retrieve', hits: [], unseekable: ['guzman'] }], final: { engine: 'mechanical', text: '' } },
      { id: 'turn-12', steps: [{ t: 'retrieve', hits: [{ idx: 2, score: 0.21, text: 'x' }] }], final: { engine: 'mechanical', text: 'The document does not mention this. [⊥]' } },
      { id: 'turn-13', steps: [{ t: 'proposals', proposals: [{ sentence: 'treat everything as chrome', sids: new Array(32).fill('h') }] }], final: { text: '' } },
    ];
    const f = C.checkSession(turns, [toronto]);
    ok(f.some(x => x.law === 'below-floor-served' && x.turn === 'turn-3'), 'a 0.30 hit served as the answer is flagged (floor 0.34)');
    ok(f.some(x => x.law === 'badge-without-frame' && x.turn === 'turn-3'), 'a grounded badge naming no frame is flagged');
    ok(f.some(x => x.law === 'fold-before-absence' && x.turn === 'turn-10'), '"guzman" unseekable while guzmán sits in the lexicon is flagged');
    ok(!f.some(x => x.turn === 'turn-12'), 'a below-floor turn that attests absence is honest — not flagged');
    ok(f.some(x => x.law === 'degenerate-proposal' && x.turn === 'turn-13'), 'one proposal citing 32 friction spans is flagged');
    eq(C.checkDump(toronto).vectorString, '0 0 0 0 0 1 0', 'the dump vector is untouched by session findings');
  });

  group('CLI — vector, JSON report, exit code', () => {
    const tmp = path.join(os.tmpdir(), 'conformance-fixture-' + process.pid + '.json');
    const out = path.join(os.tmpdir(), 'conformance-report-' + process.pid + '.json');
    fs.writeFileSync(tmp, JSON.stringify(makeTorontoDump()));
    let status = 0, stdout = '';
    try {
      stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'conformance.js'), tmp, '--quiet', '--json', out], { encoding: 'utf8' });
    } catch (e) { status = e.status; stdout = String(e.stdout || ''); }
    eq(status, 1, 'a nonconformant dump exits 1');
    ok(stdout.includes('0 0 0 0 0 1 0'), 'the vector is printed');
    const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
    eq(rep.schema, 'cleon-conformance/1', 'the JSON report is stamped');
    eq(rep.conformant, false, 'the JSON report carries the verdict');
    eq(rep.dumps[0].vectorString, '0 0 0 0 0 1 0', 'the JSON report carries the vector');
    fs.unlinkSync(tmp); fs.unlinkSync(out);
  });

  /* ---- the live engine, scored AS DEPLOYED (conventions hydrated, the way
     the app loads). This is the rebuild's scoreboard: these pins record what
     the engine does TODAY, and each one is meant to flip as its invariant is
     fixed — left to right, test after each bit. Update the expectation when a
     bit lands; never delete it.
       Already flipped: DARK (the chrome gate + ingestionReport write every
     dark span's reason); WEIGHT (stall measurements live under observed). */
  console.log('• live engine — the checker reads a real ingestion dump (hydrated)');
  {
    const { loadEngine } = require('./harness');
    const E = loadEngine().EOEngine;
    E.loadConventions(fs.readFileSync(path.join(__dirname, '..', 'memory', 'conventions.jsonl'), 'utf8'));
    const WEB = [
      'Terror in the Streets', '',
      '* About us * Contact * Advertise * Subscribe *', '',
      'By Anna Chen | June 11, 2026', '',
      'Subscribe now for just $5 a month.', '',
      'Tse Chi Lop ran a syndicate known as Sam Gor. The syndicate moved methamphetamine across five countries.',
      'Tse was arrested in Amsterdam last year. Investigators compared Tse to El Chapo more than once.',
      'Reporters called him the Jeff Bezos of the drug trade. "We never lose," Tse told an associate.',
      'Sam Gor earned seventeen billion dollars in a year. El Chapo was worth a fraction of that.',
      'Often the money moved through casinos.', '',
      'Advertisement This', '', 'Latest Issue',
      'Contact Submit Advertise Renew Manage Terms',
    ].join('\n');
    const doc = await E.parseDocument('web.txt', WEB, 'web');
    const report = E.ingestionReport(doc);
    const res = C.checkDump(report);
    eq(res.vector.length, 7, 'a live dump scores as seven bits');
    // the chrome gate → report → checker seam: gated spans deposit nothing
    // and carry their reason, which the checker reads as the dump's own mark
    const reasons = Object.fromEntries(report.sentences.filter(s => s.reason).map(s => [report.spans[s.i].slice(0, 12), s.reason]));
    eq(reasons['* About us *'], 'chrome', 'an asterisk nav row is gated and carries reason chrome');
    eq(reasons['By Anna Chen'], 'chrome', 'a pipe-dated byline is gated and carries reason chrome');
    ok(!report.entities.some(e => /anna chen/i.test(e.name)), 'the gated byline mints no referent');
    eq(res.bits.DARK.bit, 1, 'DARK holds: every dark span carries its written reason (chrome / no-event)');
    eq(res.bits.WEIGHT.bit, 1, 'WEIGHT holds: the engine keeps measurements inside observed.frame');
    eq(res.bits.SPEECH.bit, 1, 'SPEECH holds here: the metaphor sentence mints no Bezos attribution');
    eq(res.bits.ADMISSION.bit, 0, 'ADMISSION fails today: one-mention names (title words, fragments) are still minted (flip me when the gate lands)');
    eq(res.bits.BINDING.bit, 0, 'BINDING fails today: deeds the fold can resolve are still filed as SYN — fragmentation starves the CON path (flip me when bonds land)');
    eq(res.bits.COMPANY.bit, 0, 'COMPANY fails today: copular fragments, no frames (flip me when frames land)');
    eq(res.bits.CUSTOM.bit, 0, 'CUSTOM fails today: footer link-runs are read with no admitted chrome custom for them (flip me when the custom is admitted)');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
