/* ============================================================
   tools/external/lookup.js — the two outside sources, behind a
   freeze/replay cache.

   Two sources, two risk levels (see the coder spec):
     • dictionary  (api.dictionaryapi.dev)  — a claim about LANGUAGE
     • wikidata     (wikidata.org wbsearch)  — a claim about the WORLD

   This module is the read's instrument, NOT the shipped stratum. It only
   ever READS: it never writes a DEF, never touches the log, never mutates
   a document. It answers one question per term — "would this source have
   resolved/typed this?" — and records the raw payload it saw.

   Three rules, so the read stays honest:

   1. FREEZE / REPLAY. A hit is frozen to cache/<source>.json keyed by the
      query (the Tier-2 cold-store instinct, in miniature: the payload the
      read depended on is the version actually fetched, never re-fetched).
      A cached term is answered from the freeze; the network is paid once.

   2. ABSTAIN, NEVER FABRICATE. With no cache entry and no `--live`, the
      lookup returns { status: 'pending' } — it does not guess what the API
      would say. A fix-rate computed from guesses would be a fiction; the
      read reports `pending` cells as pending and the gate accounts for
      them honestly. This is the same parity-floor discipline the engine
      keeps: no source reachable ⇒ the stratum is vacuous, not invented.

   3. STAMPED. Every frozen record carries { src, query, url, fetched_at,
      hash } — the same basis a shipped external DEF would carry — so the
      freeze is auditable and a later live run can diff against it.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, 'cache');
const SOURCES = {
  dictionary: {
    url: (term) => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term.toLowerCase())}`,
  },
  wikidata: {
    url: (term) => `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(term)}&language=en&format=json&limit=5`,
  },
};

function sha256(s) { return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex'); }
function cacheFile(src) { return path.join(CACHE_DIR, src + '.json'); }

function loadCache(src) {
  try { return JSON.parse(fs.readFileSync(cacheFile(src), 'utf8')); }
  catch (e) { return {}; }
}
function saveCache(src, obj) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(src), JSON.stringify(obj, null, 2));
}

/* Resolve one term against one source. Returns one of:
     { status: 'hit',     basis, payload }   — frozen or freshly fetched
     { status: 'miss',    basis }            — source reached, nothing found
     { status: 'pending' }                   — no cache, no network (read abstains)
     { status: 'error', error }              — network failed under --live
   `live` opts the call into the network (and freezes the result). */
async function lookup(src, term, { live = false } = {}) {
  if (!SOURCES[src]) throw new Error('unknown source: ' + src);
  const cache = loadCache(src);
  if (Object.prototype.hasOwnProperty.call(cache, term)) {
    const rec = cache[term];
    return rec.found ? { status: 'hit', basis: rec.basis, payload: rec.payload }
                     : { status: 'miss', basis: rec.basis };
  }
  if (!live) return { status: 'pending' };

  const url = SOURCES[src].url(term);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'cleo-external-read/1 (read-only measurement)' } });
    const text = await res.text();
    const found = res.status === 200 && text.length > 0 && !/no definitions found/i.test(text);
    let payload = null;
    try { payload = JSON.parse(text); } catch (e) { payload = text; }
    const basis = { src, id: term, url, fetched_at: new Date().toISOString(), hash: sha256(text), http: res.status };
    cache[term] = { found, basis, payload: found ? payload : null };
    saveCache(src, cache);
    return found ? { status: 'hit', basis, payload } : { status: 'miss', basis };
  } catch (e) {
    return { status: 'error', error: String(e.message || e) };
  }
}

module.exports = { lookup, sha256, SOURCES };
