/* ============================================================
   tests/identity.test.js — identity precedence over lexical surface.

   Pins the SYN repair spec (A1–A4) with the regression cases drawn from a
   real ingestion of the Wikipedia "Howard Shore" article, where the
   token-overlap gravity reader merged distinct referents on shared TAIL
   tokens (Winnipeg/Toronto Symphony Orchestra, five distinct awards into
   one node, the subject's father into the subject), generic bare heads
   ("Canadian", "Music Festival") entered the entity layer as merge
   magnets, the canonical/key pick was order-dependent (keys that weren't
   sub-phrases of their names), and MediaWiki chrome (== headings ==, the
   short-description line) glued into prose sentences because dechrome
   never saw it standing alone.

   The contract:
     · A1 — merge eligibility is IDENTITY (suffix/subsequence containment,
       specifier agreement, type agreement); overlap only ranks admitted
       pulls. Distinct specifiers never merge; honest short forms still do.
     · A2 — generic bare heads (demonyms, all-generic phrases) mint no
       nodes; they may still be ABSORBED as sightings of established names.
     · A3 — canonical and key are recomputed deterministically over the
       merged cluster; key derives from the canonical (key ⊂ name by
       construction); same text ⇒ same identities, every firing.
     · A4 — MediaWiki structure is gated as chrome before the entity layer
       (headings isolated to their own spine lines), and the article
       composer drops reference/external-link bands whole.

   No framework: the tiny assert runner. Run with
   `node tests/identity.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEngine } = require('./harness');

const ROOT = path.resolve(__dirname, '..');
const E = loadEngine().EOEngine;

function loadExternal() {
  const sandbox = { window: {}, console, module: { exports: {} }, setTimeout, clearTimeout, Date, JSON, Math };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'external.js'), 'utf8'), sandbox, { filename: 'external.js' });
  return sandbox.window.EOExternal;
}
const X = loadExternal();

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// A condensed biography carrying every false-merge shape from the real
// ingestion: head-sharing orchestras and awards, an award named after a
// person, a generic festival reuse, surname coreference, and a relative
// who shares the subject's surname but not his given name. Every entity
// the assertions require to SURVIVE is sighted in two distinct sentences
// (the engine's two-sighting admission gate), with bare surnames placed
// mid-sentence where the tagger can see them.
const BIO = [
  'Howard Shore is a Canadian composer of film scores.',
  'The press praised Howard Shore for decades of work.',
  'Shore conducted the Winnipeg Symphony Orchestra in 2001.',
  'The Winnipeg Symphony Orchestra welcomed him back a year later.',
  'The Toronto Symphony Orchestra performed his work in March.',
  'He toured with the Toronto Symphony Orchestra that spring.',
  'The American Symphony Orchestra joined the tour.',
  'He wrote a piece for the American Symphony Orchestra in 2004.',
  'The London Philharmonic Orchestra recorded the trilogy.',
  'He returned to the London Philharmonic Orchestra for the finale.',
  'The China Philharmonic Orchestra played the suite in Beijing.',
  'He rehearsed with the China Philharmonic Orchestra for a week.',
  'Shore won three Academy Awards for the trilogy.',
  'He earned those Academy Awards across a single decade.',
  'He also received four Golden Globe Awards over his career.',
  'The voters handed him Golden Globe Awards twice in one stretch.',
  'The Grammy Awards honored him three times.',
  'He thanked the Grammy Awards committee on stage.',
  'The Genie Awards recognized his early work.',
  'He flew home to accept the Genie Awards trophy.',
  'The Golden Globe meant the most to him.',
  'David Cronenberg hired Shore for nearly every film.',
  'Shore worked with Cronenberg on a dozen scores.',
  'Martin Scorsese also worked with Shore.',
  'He admired Scorsese deeply.',
  'Shore received the Max Steiner Film Music Achievement Award in Vienna.',
  'The orchestra played when he accepted the Max Steiner Film Music Achievement Award.',
  'Max Steiner himself had been a studio composer.',
  'The historians still write about Max Steiner.',
  'The Bridgehampton Chamber Music Festival hosted Shore as composer in residence.',
  'He premiered a quartet at the Bridgehampton Chamber Music Festival.',
  'The Music Festival drew a large crowd.',
  'His father, Mac Shore, ran a clothing store in Toronto.',
  'The shop made Mac Shore a fixture of his street.',
].join(' ');

// A wiki-shaped payload: the short description, inline == headings ==, and
// a reference band — exactly what the extracts endpoint hands the composer.
const WIKI_PAYLOAD = {
  title: 'Howard Shore',
  description: 'Canadian film score composer (born 1946)',
  text: [
    'Howard Leslie Shore OC (born October 18, 1946) is a Canadian composer and conductor.',
    'He is known for his film scores.',
    '',
    '== Early life and career ==',
    'Shore was born in Toronto.',
    'When Shore was 13, he met Lorne Michaels at a summer camp.',
    '',
    '=== 2001–2006 ===',
    'Shore composed the trilogy scores in this period.',
    '',
    '== External links ==',
    'Howard Shore at IMDb.',
    'Howard Shore Interview at Tracksounds.',
  ].join('\n'),
  url: 'https://en.wikipedia.org/wiki/Howard_Shore',
};

async function main() {
  const doc = await E.parseDocument('bio.txt', BIO, 'bio');
  const docAgain = await E.parseDocument('bio2.txt', BIO, 'bio2');
  const ents = E.projectEntities(doc).entities;
  const entsAgain = E.projectEntities(docAgain).entities;
  const byForm = (s) => ents.find(e =>
    (e.surfaceForms || []).some(f => String(f).toLowerCase() === s.toLowerCase())
    || String(e.name).toLowerCase() === s.toLowerCase());

  group('A1 — distinct identities never merge', () => {
    const win = byForm('Winnipeg Symphony Orchestra');
    const tor = byForm('Toronto Symphony Orchestra');
    const am = byForm('American Symphony Orchestra');
    ok(win && tor && am, 'all three symphony orchestras exist as entities');
    ok(win && tor && am && new Set([win.key, tor.key, am.key]).size === 3,
      'shared "Symphony Orchestra" tail does not fuse the orchestras');
    const lon = byForm('London Philharmonic Orchestra');
    const chi = byForm('China Philharmonic Orchestra');
    ok(lon && chi && lon.key !== chi.key, 'the philharmonics stay apart');
    const awards = ['Academy Awards', 'Golden Globe Awards', 'Grammy Awards', 'Genie Awards'].map(byForm);
    ok(awards.every(Boolean), 'all four awards exist as entities');
    ok(awards.every(Boolean) && new Set(awards.map(e => e.key)).size === 4,
      'shared "Awards" head does not pool four awards into one node');
    const steiner = byForm('Max Steiner');
    ok(steiner && !/award/i.test(steiner.name), 'Max Steiner the person is not the award named after him');
    const award = ents.find(e => /steiner/i.test(e.key) && /award/i.test(e.key));
    ok(award && steiner && award.key !== steiner.key, 'the Max Steiner award is its own node');
    const mac = byForm('Mac Shore');
    const howard = byForm('Howard Shore');
    ok(mac && howard && mac.key !== howard.key, 'the father (Mac Shore) is not absorbed into the subject');
  });

  group('A1 — genuine coreference still merges', () => {
    const cron = byForm('David Cronenberg');
    ok(cron && byForm('Cronenberg') === cron, 'Cronenberg → David Cronenberg (surname short form)');
    const scor = byForm('Martin Scorsese');
    ok(scor && byForm('Scorsese') === scor, 'Scorsese → Martin Scorsese');
    const howard = byForm('Howard Shore');
    ok(howard && byForm('Shore') === howard, 'bare Shore binds to the subject (mass decides WITHIN identity)');
    const globe = byForm('Golden Globe Awards');
    ok(globe && byForm('Golden Globe') === globe, '"Golden Globe" is an honest prefix short form (generic tail dropped)');
  });

  group('A2 — generic bare heads are not entities', () => {
    ok(!ents.some(e => e.key === 'canadian'), 'a bare demonym never becomes an entity');
    ok(!ents.some(e => /^(the )?music festival$/i.test(e.name)), '"Music Festival" is no standalone node');
    const bridge = byForm('Bridgehampton Chamber Music Festival');
    ok(bridge, 'the full festival name survives as the entity');
    ok(bridge && byForm('Music Festival') === bridge, 'the generic reuse is absorbed into the compound, never swallows it');
  });

  group('A3 — deterministic canonical, key ⊂ name', () => {
    for (const e of ents) {
      eq(e.key, norm(e.name), 'key derives from the canonical name (' + e.name + ')');
    }
    const cron = byForm('David Cronenberg');
    ok(cron && cron.name === 'David Cronenberg', 'the fullest mention is the canonical, not whichever form hosted the merge');
    eq(JSON.stringify(ents.map(e => [e.key, e.name, e.type])),
       JSON.stringify(entsAgain.map(e => [e.key, e.name, e.type])),
       'the same text projects the same identities on every firing');
  });

  group('A4 — the article composer drops boilerplate bands, keeps structure', () => {
    const composed = X.articleDocText(WIKI_PAYLOAD);
    ok(/^Howard Shore\.$/m.test(composed), 'the title is its own punctuated paragraph');
    ok(/^Canadian film score composer \(born 1946\)\.$/m.test(composed), 'the short description is its own punctuated paragraph');
    ok(!/IMDb|Tracksounds|External links/i.test(composed), 'the External-links band is dropped whole (no citable link rows)');
    ok(/== Early life and career ==/.test(composed), 'content headings are kept for the chrome gate');
    const inner = X.stripWikiSections('== Notes ==\nfootnote text\n== Career ==\nReal prose.');
    ok(!/footnote/.test(inner) && /Real prose/.test(inner), 'band stripping is per-section, not a tail chop');
  });

  const wdoc = await E.parseDocument('wiki.txt', X.articleDocText(WIKI_PAYLOAD), 'wiki');
  const chromeSet = new Set(wdoc._chrome || []);
  const wents = E.projectEntities(wdoc).entities;

  group('A4 — MediaWiki chrome is gated before the entity layer', () => {
    const dc = wdoc._dechrome;
    ok(dc && dc.present && dc.count >= 2, 'dechrome registers a verdict on MediaWiki input (was present:false)');
    const headingLines = (wdoc.sentenceTexts || []).map((t, i) => [String(t).trim(), i])
      .filter(([t]) => /^={2,6}[^=].*={2,6}$/.test(t));
    ok(headingLines.length >= 2, 'headings stand alone as their own spine lines (not glued into prose)');
    ok(headingLines.every(([, i]) => chromeSet.has(i)), 'every standalone heading line is chrome-gated');
    ok(!(wdoc.sentenceTexts || []).some(t => /={2}/.test(t) && !/^={2,6}/.test(String(t).trim())),
      'no == markup survives inside a prose sentence');
    ok(!wents.some(e => /==|early life/i.test(e.key)), 'heading text mints no entities');
    ok(!wents.some(e => e.key === 'canadian' || /^howard shore canadian/i.test(e.key)),
      'the short-description line seeds no polluted span');
    const shores = wents.filter(e => /\bshore\b/i.test(e.key));
    eq(shores.length, 1, 'the subject resolves to exactly one node');
    ok(shores[0] && shores[0].type === 'person', 'the subject is typed person');
    ok(shores[0] && shores[0].key === norm(shores[0].name), 'the subject key agrees with its name');
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
