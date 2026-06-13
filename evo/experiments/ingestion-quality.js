/* ============================================================
   evo/experiments/ingestion-quality.js

   Measure the quality of INGESTION — the parse/extraction that builds the
   graph — over the corpus, with extra weight on CHROME-HEAVY documents
   (tables of contents, running headers, footnotes, figure/section labels,
   page numbers). Deterministic; no model.

   Four facets, all "lower is better" except typing/assertions:

     chromeRate   — fraction of admitted entities that are document chrome
                    (CHAPTER/SECTION/CONTENTS/Figure/Appendix/ALL-CAPS heads/
                    roman numerals/page numbers). Chrome nodes are dead weight
                    a querier and a longform writer both have to wade past.
     personLock   — proper-name entities typed `thing` that look like people
                    (a heavy figure NER missed): the typing the graph should
                    have but doesn't. The "Marlow is a thing" failure.
     fragmentRate — entities whose normalized name is a token-subset of another
                    same-type entity (Eugène ⊂ Eugène de Rastignac): one
                    referent split into shards.
     assertions/heavy — DEF assertions per heavy figure: how much the reading
                    can say about what its figures ARE. Higher is better.

   Usage:
     node evo/experiments/ingestion-quality.js
     node evo/experiments/ingestion-quality.js --json out.json
     node evo/experiments/ingestion-quality.js --engine=/path/to/engine.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, normName } = require('../engine-host');

const CORPUS = path.join(__dirname, '..', 'corpus');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CAP = parseInt(arg('--cap', '20000'), 10);
const enginePath = (process.argv.find(a => a.startsWith('--engine=')) || '').split('=')[1] || undefined;

function strip(t) {
  const a = t.indexOf('*** START');
  const s = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(s, b >= 0 ? b : t.length).trim();
}
function corpus(file) { return strip(fs.readFileSync(path.join(CORPUS, file), 'utf8')).slice(0, CAP); }

// A synthetic CHROME BOMB: dense title-page + apparatus + running headers,
// the worst case for an extractor. Real names are sparse among the furniture.
const CHROME_BOMB = `THE HARBOR COMMISSION REPORT

A Treatise on Tidal Works
By Eleanor Voss, Chief Engineer
Translated by Thomas Reed
With an Introduction by the Board

CONTENTS

I. The Estuary
II. The Breakwater
III. The Long Watch

PART I

THE ESTUARY

Page 12

Figure 4. The tidal gauge at dawn.

Eleanor Voss inspected the breakwater on Tuesday. She had warned the Board for years.
Thomas Reed disagreed with her in the third meeting. He kept the old charts.

[See Appendix B]

Table 2. Recorded tide heights, 1890-1895.

CHAPTER II

THE BREAKWATER

Page 13

Voss argued that the wall would fail. Reed said it would hold.
The Commission met again in November. They could not agree.

* Footnote: the gauge was later moved.

NOTES

1. Voss, Tidal Works, p. 40.
2. Reed, Charts, p. 12.`;

const BATTERY = [
  { id: 'federalist', file: 'pg18.txt', chrome: 'heavy' },
  { id: 'wealth', file: 'pg3300.txt', chrome: 'heavy' },
  { id: 'liberty', file: 'pg34901.txt', chrome: 'heavy' },
  { id: 'hod', file: 'pg219.txt', chrome: 'light' },
  { id: 'goriot', file: 'pg1237.txt', chrome: 'light' },
  { id: 'meta', file: 'pg5200.txt', chrome: 'light' },
];

// chrome surface patterns — structural apparatus, not referents
const CHROME_RE = /^(chapter|section|subsection|part|book|volume|canto|contents|appendix|addendum|figure|fig|plate|table|exhibit|diagram|note|notes|footnote|page|introduction|preface|foreword|index|illustration)\b/i;
const ROMAN_RE = /^[ivxlcdm]+\.?$/i;
const ALLCAPS_RE = /^[A-Z][A-Z .'-]{3,}$/;       // a run of capitals (a heading)
const BYLINE_RE = /^(by|translated by|edited by|illustrated by)\b/i;

function isChrome(name) {
  const t = String(name).replace(/\s+/g, ' ').trim();
  return CHROME_RE.test(t) || ROMAN_RE.test(t) || BYLINE_RE.test(t) || (ALLCAPS_RE.test(t) && t.split(' ').length <= 4);
}
// looks like a person's proper name (for the personLock measure): capitalized,
// 1-3 tokens, no digits, not chrome, not an obvious place/org word.
const PLACE_ORG_HINT = /\b(street|road|avenue|river|sea|ocean|bay|point|harbor|harbour|company|corporation|commission|board|department|office|firm|llc|inc|university|hospital|park|square|hall|house)\b/i;
function looksPersonal(name) {
  const t = String(name).trim();
  if (isChrome(t) || /\d/.test(t) || PLACE_ORG_HINT.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 1 && words.length <= 3 && /^[A-Z]/.test(words[0]) && /^[A-Z]/.test(words[words.length - 1]);
}

async function measure(E, id, text) {
  const doc = await E.parseDocument(id + '.txt', text, id);
  let ents = [];
  try { ents = (E.graphSnapshot(doc).entities) || []; } catch (e) {}
  let portrait = {}; try { portrait = E.graphPortrait(doc) || {}; } catch (e) {}
  const heavy = (portrait.heavy || []).slice(0, 8);
  const n = ents.length || 1;

  const chrome = ents.filter(e => isChrome(e.name));
  const personLock = ents.filter(e => e.type === 'thing' && looksPersonal(e.name));
  // fragmentation: same-type subset-name shards
  let shards = 0; const shardNames = [];
  for (let i = 0; i < ents.length; i++) for (let j = 0; j < ents.length; j++) {
    if (i === j || ents[i].type !== ents[j].type) continue;
    const a = normName(ents[i].name), b = normName(ents[j].name);
    if (!a || !b || a === b) continue;
    const sa = new Set(a.split(' ')), sb = new Set(b.split(' '));
    if (sa.size < sb.size && [...sa].every(w => sb.has(w))) { shards++; shardNames.push(ents[i].name + '⊂' + ents[j].name); break; }
  }
  const heavyPerson = heavy.length ? heavy.filter(e => e.type === 'person').length / heavy.length : 0;

  return {
    id, entities: ents.length,
    chrome: chrome.length, chromeRate: chrome.length / n, chromeNames: chrome.slice(0, 6).map(e => e.name),
    personLock: personLock.length, personLockNames: personLock.slice(0, 6).map(e => e.name),
    fragments: shards, fragmentRate: shards / n, shardNames: shardNames.slice(0, 5),
    heavyPersonRate: heavyPerson,
    assertions: (portrait.assertions || []).length, assertionsPerHeavy: heavy.length ? (portrait.assertions || []).length / heavy.length : 0,
    heavyTypes: heavy.map(e => e.name + ':' + e.type),
  };
}

const r3 = (x) => Math.round(x * 1000) / 1000;
function fmt(rows, cols) {
  const w = cols.map(c => Math.max(c.h.length, ...rows.map(r => String(c.f(r)).length)));
  const line = cs => cs.map((s, i) => String(s).padEnd(w[i])).join('  ');
  return [line(cols.map(c => c.h)), line(w.map(x => '-'.repeat(x))), ...rows.map(r => line(cols.map(c => c.f(r))))].join('\n');
}

(async () => {
  const E = loadEngine(enginePath ? { enginePath } : {}).EOEngine;
  const jsonOut = arg('--json', null);
  console.log('engine: ' + (enginePath || 'engine.js (baseline)') + '  ·  cap ' + CAP + '\n');

  const rows = [];
  rows.push(await measure(E, 'chromebomb', CHROME_BOMB));
  for (const d of BATTERY) rows.push(await measure(E, d.id, corpus(d.file)));

  console.log('=== INGESTION QUALITY ===');
  console.log(fmt(rows, [
    { h: 'doc', f: r => r.id },
    { h: 'ents', f: r => r.entities },
    { h: 'chrome', f: r => r.chrome + ' (' + r3(r.chromeRate) + ')' },
    { h: 'personLock', f: r => r.personLock },
    { h: 'frags', f: r => r.fragments },
    { h: 'heavy-person%', f: r => r3(r.heavyPersonRate) },
    { h: 'assert/heavy', f: r => r3(r.assertionsPerHeavy) },
  ]));

  console.log('\n=== DETAIL ===');
  for (const r of rows) {
    console.log(`\n${r.id}:`);
    if (r.chromeNames.length) console.log('  chrome admitted: ' + r.chromeNames.join(', '));
    if (r.personLockNames.length) console.log('  people typed thing (lock): ' + r.personLockNames.join(', '));
    if (r.shardNames.length) console.log('  fragments: ' + r.shardNames.join(', '));
    console.log('  heavy: ' + r.heavyTypes.join(', '));
  }

  // aggregate
  const mean = k => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  console.log('\n=== AGGREGATE (mean over ' + rows.length + ' docs) ===');
  console.log('  chromeRate     ' + r3(mean('chromeRate')) + '   (lower better)');
  console.log('  personLock     ' + r3(mean('personLock')) + ' /doc  (lower better — people the typing missed)');
  console.log('  fragmentRate   ' + r3(mean('fragmentRate')) + '   (lower better)');
  console.log('  heavyPerson%   ' + r3(mean('heavyPersonRate')) + '   (higher better)');
  console.log('  assert/heavy   ' + r3(mean('assertionsPerHeavy')) + '   (higher better)');

  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ schema: 'cleo-ingestion/1', at: new Date().toISOString(), engine: enginePath || 'baseline', rows }, null, 1)); console.log('\nwrote ' + jsonOut); }
})().catch(e => { console.error(e); process.exit(1); });
