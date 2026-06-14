#!/usr/bin/env node
/* ============================================================
   tools/form-genres/fetch.mjs — build the FORM-GENRES exemplar library
   from real public-domain / openly-licensed sources.

   This is the OTHER library (see the form brief). exemplars.jsonl is Cleo's
   own voice and is authored, never fetched. THIS file, form-genres.jsonl, is
   output FORM — how a news article looks, how an obituary looks, how a recipe
   looks — and every instance is a REAL public-domain or openly-licensed
   document with its papers attached. The centroid per genre is the learned
   shape of that form; the talker's output gets cosined against it.

       node tools/form-genres/fetch.mjs              # replay frozen fetches
                                                     # only (abstain, no net)
       node tools/form-genres/fetch.mjs --live       # pay the network, freeze
       node tools/form-genres/fetch.mjs --direct     # hit origins directly
                                                     # (default: the proxy)
       node tools/form-genres/fetch.mjs --proxy=URL  # override the proxy base
       node tools/form-genres/fetch.mjs --genre=recipe   # one genre only
       node tools/form-genres/fetch.mjs --validate   # check the OUTPUT file's
                                                     # provenance, write nothing

   THREE DISCIPLINES, borrowed from tools/external/lookup.js so the build stays
   honest and reproducible:

     1. FREEZE / REPLAY. Every fetched payload is frozen under cache/ keyed by
        its URL. A replay run (no --live) answers from the freeze and pays no
        network; the corpus the file was built from is the version actually
        fetched, never silently re-pulled.

     2. ABSTAIN, NEVER FABRICATE. With no freeze and no --live, a source is
        skipped, not invented. A form exemplar with no real source does not go
        in the file. (The brief's hard rule: no provenance, no record.)

     3. STAMPED. Every record carries source, license, and retrieved — the
        provenance the brief requires. The text + provenance are the record;
        the EMBEDDING is never written here (shape.js recomputes it at load
        through the resident MiniLM, so an embedder swap re-folds for free).

   NO VECTORS are produced or stored by this tool. Text and provenance only.
   ============================================================ */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(__dirname, 'cache');
const OUT = path.join(ROOT, 'form-genres.jsonl');
const MANIFEST = path.join(__dirname, 'sources.json');

const ARGV = process.argv.slice(2);
const LIVE = ARGV.includes('--live');
const DIRECT = ARGV.includes('--direct');
const VALIDATE = ARGV.includes('--validate');
const ONLY = (ARGV.find(a => a.startsWith('--genre=')) || '').split('=')[1] || null;
const PROXY = (ARGV.find(a => a.startsWith('--proxy=')) || '').split('=')[1]
  || process.env.EO_REFERENCE_PROXY
  || 'https://n8n.intelechia.com/webhook/feed';
const TODAY = new Date().toISOString().slice(0, 10);

/* ---- freeze / replay -------------------------------------------------- */
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function cachePath(url) { return path.join(CACHE_DIR, sha1(url) + '.txt'); }
function readFreeze(url) {
  try { return fs.readFileSync(cachePath(url), 'utf8'); } catch (e) { return null; }
}
function writeFreeze(url, text) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(url), text);
}

// Fetch one URL as text, through the proxy unless --direct. Replay from the
// freeze when present; only pay the network under --live. Returns null on any
// failure or an empty body — the caller abstains rather than inventing.
async function getText(url) {
  const frozen = readFreeze(url);
  if (frozen != null) return frozen;
  if (!LIVE) { warn('skip (no freeze, no --live): ' + url); return null; }
  const target = DIRECT ? url : (PROXY + '?url=' + encodeURIComponent(url));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(target, { headers: { 'user-agent': 'cleo-form-genres/1 (public-domain corpus build)' } });
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim()) { writeFreeze(url, text); return text; }
        warn('empty body: ' + url); return null;
      }
      if (res.status === 429 || res.status >= 500) { await sleep(800 * Math.pow(2, attempt)); continue; }
      warn('HTTP ' + res.status + ': ' + url); return null;
    } catch (e) {
      if (attempt < 3) { await sleep(800 * Math.pow(2, attempt)); continue; }
      warn('fetch failed (' + e.message + '): ' + url); return null;
    }
  }
  return null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function warn(m) { process.stderr.write('  · ' + m + '\n'); }

/* ---- text hygiene ----------------------------------------------------- */
const norm = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
const words = (s) => norm(s).split(/\s+/).filter(Boolean);
function clamp(s, maxWords) {
  const w = words(s);
  if (w.length <= maxWords) return norm(s);
  // trim at a sentence boundary near the cap so the instance reads clean.
  let cut = w.slice(0, maxWords).join(' ');
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastStop > cut.length * 0.5) cut = cut.slice(0, lastStop + 1);
  return norm(cut);
}
// Project Gutenberg boilerplate: keep only the body between the START/END marks.
function stripGutenberg(text) {
  const t = String(text || '');
  const start = t.match(/\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  const end = t.match(/\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  let body = t;
  if (start) body = body.slice(start.index + start[0].length);
  if (end) { const e = body.match(/\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i); if (e) body = body.slice(0, e.index); }
  return body;
}
function blocks(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
}

/* ---- the genre slicers -------------------------------------------------
   Each takes the raw payload + the manifest entry and returns an array of
   { response, user_turn?, context_sketch? } — one clean instance of the form
   per element. Conservative on purpose: better to emit fewer clean instances
   than to admit boilerplate that pollutes the centroid. The curator trims
   further by hand; the SHAPE is the signal, so the subject washing out is the
   point. */
const MEASURE = /\b(cup|cups|tablespoon|teaspoon|tbsp|tsp|pound|pounds|ounce|ounces|quart|pint|gill|pinch|dozen)\b/i;
const COOK = /\b(bake|boil|stir|simmer|mix|add|pour|beat|knead|chop|slice|serve|season|melt|fry|roast|oven|saucepan)\b/i;

const SLICERS = {
  // Old cookbooks: a short Title-Case heading, then a body that talks
  // measurements and cooking verbs. Keep the heading + body as one instance.
  'gutenberg-recipe'(raw, entry) {
    const out = [];
    for (const b of blocks(stripGutenberg(raw))) {
      const lines = b.split('\n');
      const head = lines[0].trim();
      const body = b;
      const isHead = head.length <= 60 && /[A-Za-z]/.test(head) && !/[.]$/.test(head)
        && head === head.replace(/\s+/g, ' ');
      if (isHead && MEASURE.test(body) && COOK.test(body) && words(body).length >= 20) {
        out.push({
          response: clamp(body, 160),
          user_turn: 'how do you make ' + head.toLowerCase().replace(/\.$/, ''),
          context_sketch: 'A request for a recipe — title, ingredients, method.',
        });
      }
      if (out.length >= (entry.max || 30)) break;
    }
    return out;
  },

  // Wikisource MediaWiki extract JSON → the lead of the article.
  'wikisource-article'(raw) {
    let lead = '';
    try {
      const j = JSON.parse(raw);
      const pages = j && j.query && j.query.pages;
      const first = pages && Object.values(pages)[0];
      lead = (first && first.extract) || '';
    } catch (e) { lead = ''; }
    if (!lead) return [];
    const para = blocks(lead)[0] || lead;
    if (words(para).length < 25) return [];
    return [{
      response: clamp(para, 140),
      user_turn: 'what is it / give me the entry on this',
      context_sketch: 'A request that wants an encyclopedic summary — define, then place.',
    }];
  },

  // Chronicling America search JSON → a coherent article paragraph from OCR.
  'chronam-article'(raw, entry) {
    return chronamSlice(raw, entry, false);
  },
  'chronam-obituary'(raw, entry) {
    return chronamSlice(raw, entry, true);
  },

  // NWS forecast JSON → the detailed-forecast prose for a couple of periods.
  'nws-forecast'(raw) {
    try {
      const j = JSON.parse(raw);
      const periods = (j && j.properties && j.properties.periods) || [];
      const parts = periods.slice(0, 3).map(p => p.name + ': ' + p.detailedForecast).filter(s => /:/.test(s) && s.length > 20);
      if (!parts.length) return [];
      return [{
        response: clamp(parts.join(' '), 130),
        user_turn: "what's the forecast",
        context_sketch: 'A request that wants a plain report — neutral, factual, no first person.',
      }];
    } catch (e) { return []; }
  },

  // Generic substantial paragraph (federal report transcriptions, etc.).
  'gutenberg-paragraph'(raw, entry) {
    const out = [];
    for (const b of blocks(stripGutenberg(raw))) {
      if (words(b).length >= 40 && words(b).length <= 180 && /[.]/.test(b) && !/gutenberg/i.test(b)) {
        out.push({
          response: clamp(b, 150),
          user_turn: 'summarize the report',
          context_sketch: 'A request that wants a plain factual report.',
        });
      }
      if (out.length >= (entry.max || 12)) break;
    }
    return out;
  },

  // A published letter: a block opening on a salutation, kept through its body.
  'gutenberg-letter'(raw, entry) {
    const out = [];
    const body = stripGutenberg(raw);
    const SAL = /\b(My dear|Dear|Dearest|My dearest)\b[^\n]{0,40}[,—-]/;
    for (const b of blocks(body)) {
      if (SAL.test(b.split('\n').slice(0, 2).join(' ')) && words(b).length >= 30 && words(b).length <= 220) {
        out.push({
          response: clamp(b, 200),
          user_turn: 'write it as a letter',
          context_sketch: 'A request that wants the letter form — salutation, body, close.',
        });
      }
      if (out.length >= (entry.max || 25)) break;
    }
    return out;
  },
};

// Shared Chronicling America OCR slicing. `obit` narrows to the window around
// death/funeral language so an obituary instance is the obituary, not the whole
// column it shared a page with.
const DEATH = /\b(died|death|funeral|obituary|deceased|passed away|interment|burial|survived by|late residence)\b/i;
function chronamSlice(raw, entry, obit) {
  let items = [];
  try {
    const j = JSON.parse(raw);
    items = (j && j.items) || [];
  } catch (e) { return []; }
  const out = [];
  for (const it of items) {
    const ocr = String(it.ocr_eng || '');
    if (!ocr) continue;
    // Pick the most article-like paragraph: longish, sentence-bearing, and (for
    // obituaries) carrying death language.
    const cands = blocks(ocr).filter(p => {
      const w = words(p).length;
      if (w < 30 || w > 220) return false;
      if (!/[.]/.test(p)) return false;
      return obit ? DEATH.test(p) : true;
    });
    if (!cands.length) continue;
    const pick = cands.sort((a, b) => Math.abs(words(a).length - 90) - Math.abs(words(b).length - 90))[0];
    out.push({
      response: clamp(pick, 150),
      user_turn: obit ? 'write an obituary' : 'write it as a news article',
      context_sketch: obit
        ? 'A request that wants the obituary form — name, life, survivors, services.'
        : 'A request that wants the news form — lede first, then detail.',
      _meta: {
        paper: it.title || '', date: it.date || '', place: (it.place_of_publication || ''), lccn: it.lccn || '',
        page_url: it.id ? ('https://chroniclingamerica.loc.gov' + it.id) : '',
      },
    });
    if (out.length >= (entry.max || 20)) break;
  }
  return out;
}

/* ---- URL builders for the search/api source types --------------------- */
function chronamSearchUrl(entry) {
  const p = new URLSearchParams(entry.params || {});
  return 'https://chroniclingamerica.loc.gov/search/pages/results/?' + p.toString();
}
function wikisourceUrl(title) {
  const p = new URLSearchParams({
    action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'plain',
    format: 'json', redirects: '1', titles: title,
  });
  return 'https://en.wikisource.org/w/api.php?' + p.toString();
}
async function nwsForecastUrl(point) {
  // api.weather.gov gridpoint forecast. The `point` is "OFFICE/x,y".
  return 'https://api.weather.gov/gridpoints/' + point + '/forecast';
}

/* ---- record assembly -------------------------------------------------- */
function makeId(genre, entryIdx, instIdx, response) {
  return genre + '-' + String(entryIdx).padStart(2, '0') + '-' + String(instIdx).padStart(2, '0') + '-' + sha1(response).slice(0, 6);
}
function provenanceNote(entry, meta) {
  const bits = [entry.source];
  if (meta && meta.paper) bits.push(meta.paper + (meta.date ? ', ' + meta.date : '') + (meta.place ? ' (' + meta.place + ')' : ''));
  if (meta && meta.page_url) bits.push(meta.page_url);
  return bits.filter(Boolean).join(' — ');
}

async function collectGenre(genre, entries) {
  const records = [];
  for (let ei = 0; ei < entries.length; ei++) {
    const entry = entries[ei];
    let instances = [];
    if (entry.type === 'file') {
      const raw = await getText(entry.url);
      if (raw) instances = (SLICERS[entry.slicer] || (() => []))(raw, entry);
    } else if (entry.type === 'wikisource') {
      for (const title of entry.titles || []) {
        const raw = await getText(wikisourceUrl(title));
        if (raw) instances.push(...(SLICERS[entry.slicer] || (() => []))(raw, entry));
      }
    } else if (entry.type === 'search' && entry.api === 'chronam') {
      const raw = await getText(chronamSearchUrl(entry));
      if (raw) instances = (SLICERS[entry.slicer] || (() => []))(raw, entry);
    } else if (entry.type === 'search' && entry.api === 'weather-gov') {
      for (const pt of entry.points || []) {
        const raw = await getText(await nwsForecastUrl(pt));
        if (raw) instances.push(...(SLICERS[entry.slicer] || (() => []))(raw, entry));
      }
    }
    instances.slice(0, entry.max || 999).forEach((inst, ii) => {
      const meta = inst._meta || null;
      const rec = {
        id: makeId(genre, ei, ii, inst.response),
        intent: genre,
        user_turn: inst.user_turn || '',
        context_sketch: inst.context_sketch || '',
        response: inst.response,
        source: provenanceNote(entry, meta),
        license: entry.license,
        retrieved: TODAY,
        notes: 'form-genres corpus · ' + entry.license,
      };
      records.push(rec);
    });
    process.stderr.write('  ' + genre + ' [' + (entry.url || entry.api || entry.type) + ']: ' + instances.length + ' instance(s)\n');
  }
  return records;
}

/* ---- validate mode: provenance must be complete, license must be open -- */
function validate() {
  if (!fs.existsSync(OUT)) { console.error('no ' + OUT + ' to validate'); process.exit(1); }
  const lines = fs.readFileSync(OUT, 'utf8').split('\n');
  let n = 0, bad = 0;
  const byGenre = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('#')) continue;
    let rec; try { rec = JSON.parse(t); } catch (e) { console.error('✗ unparseable: ' + t.slice(0, 60)); bad++; continue; }
    n++;
    byGenre[rec.intent] = (byGenre[rec.intent] || 0) + 1;
    const miss = [];
    if (!rec.intent) miss.push('intent');
    if (!rec.response) miss.push('response');
    if (!rec.source) miss.push('source');
    if (!rec.license) miss.push('license');
    if (!rec.retrieved) miss.push('retrieved');
    if (miss.length) { console.error('✗ ' + (rec.id || '?') + ' missing: ' + miss.join(', ')); bad++; }
    if (rec.license && !/public domain|cc by|cc0|cc-by|openly licensed/i.test(rec.license)) {
      console.error('✗ ' + (rec.id || '?') + ' license not clearly open: ' + rec.license); bad++;
    }
  }
  console.log('\n' + n + ' records · ' + Object.keys(byGenre).length + ' genres');
  for (const g of Object.keys(byGenre).sort()) console.log('  ' + g + ': ' + byGenre[g]);
  if (bad) { console.error('\n' + bad + ' provenance/license problem(s).'); process.exit(1); }
  console.log('\nprovenance complete on every record.');
}

/* ---- main ------------------------------------------------------------- */
async function main() {
  if (VALIDATE) return validate();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const genres = Object.keys(manifest).filter(g => !g.startsWith('_') && (!ONLY || g === ONLY));
  if (!LIVE && !DIRECT) process.stderr.write('replay mode (no --live): only frozen fetches are used.\n');
  process.stderr.write('transport: ' + (DIRECT ? 'direct' : ('proxy ' + PROXY)) + '\n\n');

  const all = [];
  for (const genre of genres) {
    process.stderr.write('# ' + genre + '\n');
    const recs = await collectGenre(genre, manifest[genre]);
    all.push(...recs);
  }

  if (!all.length) {
    process.stderr.write('\nno instances collected. With no --live and an empty cache this is expected'
      + ' — run with --live once the source hosts are reachable.\n');
    return;
  }

  // Write the library: one JSON object per line, sorted by genre then id so the
  // file is stable across runs. NO vectors — text and provenance only.
  const header = [
    '// form-genres.jsonl — the FORM library (NOT Cleo\'s voice; that is exemplars.jsonl).',
    '// Real public-domain / openly-licensed instances of each output genre. Built by',
    '// tools/form-genres/fetch.mjs from tools/form-genres/sources.json. Every record',
    '// carries source + license + retrieved. No vectors are stored: shape.js embeds the',
    '// response at load through the resident MiniLM and recomputes on an embedder swap.',
  ].join('\n');
  all.sort((a, b) => (a.intent < b.intent ? -1 : a.intent > b.intent ? 1 : (a.id < b.id ? -1 : 1)));
  const body = all.map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(OUT, header + '\n' + body + '\n');
  process.stderr.write('\nwrote ' + all.length + ' records → ' + path.relative(ROOT, OUT) + '\n');
  process.stderr.write('run `node tools/form-genres/fetch.mjs --validate` to check provenance.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
