/* ============================================================
   external.js — the external-knowledge stratum, shipped.

   Cleo reads in a closed world: every claim is bound to a line on the page
   and audited mechanically. This module is the ONE deliberate crack in that
   wall — an opt-in reference desk that fetches an encyclopaedia article
   (Wikipedia) and a dictionary entry (Wiktionary) for a term the reader could
   not fully resolve on its own. It exists to answer the residual the engine's
   read leaves behind (see docs/external-knowledge-read.md): an abstract noun
   the greedy pass mistyped, a proper referent typed too generically.

   It is governed by four disciplines carried over from the dev-side read
   instrument (tools/external/), because sending a surface form off-device is
   the one thing the rest of the app never does:

     1. CONSENT + CONFIGURABILITY. Nothing is queried until the user asks, and
        every call goes through the same proxy host the app already uses for
        conventions (n8n.intelechia.com). Clear window.EO_REFERENCE_PROXY to
        disable the stratum entirely and keep the reader strictly local.

     2. RATE LIMITED. One shared scheduler throttles every lookup — a minimum
        interval between calls and a concurrency cap — so a page full of
        entities cannot stampede the proxy or Wikimedia. Retries back off.

     3. PRIORITISED. The reader's residual is ranked by how serious the gap is
        (classifyNeeds): a recurring, generically-typed proper referent is a
        worse hole than a one-off. A budget spends the network on the worst
        holes first; the rest abstain (`skipped`) rather than queue forever.

     4. ABSTAIN, NEVER FABRICATE + STAMPED. With the proxy off, no cache, or a
        miss, a lookup returns a status (`disabled` / `pending` / `miss` /
        `gated`) — never a guessed answer. Every hit is frozen to the local
        store and carries { src, term, url, fetched_at, hash }, the same basis
        a shipped external fact would carry, so the desk is auditable and a
        repeat read is paid once.

   A hard PRIVATE-INDIVIDUAL GATE refuses to resolve a courtesy-title personal
   name the document introduces by name — the reader must not turn a private
   person into a world-claim.

   Published as window.EOExternal (and module.exports for the Node test). Pure
   transport + policy: it holds no React and no engine reference, so it is
   unit-testable with an injected fetch and clock.
   ============================================================ */
(function () {
  'use strict';

  const SCHEMA = 'cleo-external/1';
  const DEFAULT_PROXY = 'https://n8n.intelechia.com/webhook/feed';

  /* ---- configuration (mirrors the EO_CONVENTIONS_ENDPOINT idiom) ----
     The proxy is read live from window each call so a console override or a
     settings change takes effect without a reload. Everything else lives in a
     mutable config the app (or a test) can patch. */
  const config = {
    intervalMs: 1100,     // ≥ this between two scheduled network starts (~1/s, polite)
    concurrency: 1,       // one in flight at a time through the proxy
    maxRetries: 3,        // on 429 / 5xx, with exponential backoff
    backoffMs: 800,       // base backoff; doubles each retry
    budget: 12,           // default max live lookups per prioritised batch
    cacheCap: 400,        // most-recent frozen records kept in the local store
    lookupEndpoint: null, // the normalized server-side /lookup?q= endpoint (chat enrichment)
    fetchImpl: null,      // injectable; defaults to global fetch
    now: null,            // injectable clock; defaults to Date.now
    setTimer: null,       // injectable timer; defaults to setTimeout
    store: null,          // injectable persistence; defaults to window.EOStore
  };
  function setConfig(patch) { Object.assign(config, patch || {}); return cfg(); }
  function cfg() { return Object.assign({ proxy: proxyBase(), lookup: lookupBase(), enabled: !!proxyBase() }, config); }

  function proxyBase() {
    if (config.proxy != null) return config.proxy || '';
    if (typeof window !== 'undefined' && 'EO_REFERENCE_PROXY' in window) {
      return window.EO_REFERENCE_PROXY == null ? '' : String(window.EO_REFERENCE_PROXY);
    }
    return DEFAULT_PROXY;
  }
  // The normalized one-call endpoint (the n8n "Lookup (normalize)" node): returns
  // { query, found, encyclopedia, dictionary, sources } server-side, so the chat
  // enrichment is a single GET, not the desk's two proxied hops. Defaults to the
  // same host's /lookup; clear EO_REFERENCE_LOOKUP (or the proxy) to disable.
  function lookupBase() {
    if (config.lookupEndpoint != null) return config.lookupEndpoint || '';
    if (typeof window !== 'undefined' && 'EO_REFERENCE_LOOKUP' in window) {
      return window.EO_REFERENCE_LOOKUP == null ? '' : String(window.EO_REFERENCE_LOOKUP);
    }
    const p = proxyBase();
    return p ? p.replace(/\/[^/]*$/, '/lookup') : ''; // …/webhook/feed → …/webhook/lookup
  }
  const _timer = (fn, ms) => (config.setTimer || ((f, m) => setTimeout(f, m)))(fn, ms);
  const _fetch = () => config.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const _store = () => config.store || (typeof window !== 'undefined' ? window.EOStore : null);

  /* ---- a content tag for the basis stamp (cyrb53; not security, just identity).
     The Node read instrument uses sha256; in the browser an integrity tag is
     enough to key the freeze and show provenance, so we keep it sync + deps-free. */
  function hashTag(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return 'cyrb53:' + n.toString(16);
  }

  /* ============================================================
     The shared rate-limited, priority scheduler.

     ONE instance throttles the whole app: a per-entity click and a "look up
     the N most serious" batch draw from the same queue, so the user can never
     drive the proxy past the configured rate however they trigger lookups.
     Jobs carry a severity; when several wait, the heaviest goes first.
     ============================================================ */
  function createScheduler(get) {
    const queue = [];
    let active = 0, last = -Infinity, seq = 0, pumping = false;
    const now = () => (get().now || Date.now)();
    const timer = (fn, ms) => (get().setTimer || ((f, m) => setTimeout(f, m)))(fn, ms);

    function pump() {
      pumping = false;
      if (!queue.length) return;
      if (active >= get().concurrency) return;
      const wait = get().intervalMs - (now() - last);
      if (wait > 0) { schedulePump(wait); return; }
      queue.sort((a, b) => b.severity - a.severity || a.seq - b.seq);
      const job = queue.shift();
      active++; last = now();
      Promise.resolve()
        .then(job.run)
        .then((v) => job.resolve(v), (e) => job.reject(e))
        .then(() => { active--; schedulePump(0); });
      if (active < get().concurrency) schedulePump(get().intervalMs); // stagger the next start
    }
    function schedulePump(ms) {
      if (pumping && ms <= 0) return;
      pumping = true;
      timer(pump, Math.max(0, ms));
    }
    return {
      add(run, severity) {
        return new Promise((resolve, reject) => {
          queue.push({ run, resolve, reject, severity: severity || 0, seq: seq++ });
          schedulePump(0);
        });
      },
      pending() { return queue.length + active; },
    };
  }
  const scheduler = createScheduler(() => config);

  /* ============================================================
     The two sources. Each names its upstream URL and normalises the raw
     payload into a compact, render-ready shape + a found flag. The query logic
     mirrors the reference-desk prototype exactly (search → summary for the
     encyclopaedia; the REST definition endpoint for the lexicon).
     ============================================================ */
  const SOURCES = {
    // Wikipedia — a claim about the WORLD (the dangerous tier).
    wikipedia: {
      label: 'Encyclopædia', host: 'en.wikipedia.org', register: 'world',
      // a two-step fetch: list=search to pick the best title, then the REST
      // summary. Each upstream hop is scheduled separately, so the limiter
      // throttles real proxy requests, not lookups (a lookup is 1–2 requests).
      async fetch(term, severity) {
        const searchUrl = 'https://en.wikipedia.org/w/api.php?format=json&action=query&list=search&srlimit=6&srsearch=' + encodeURIComponent(term);
        const searchTxt = await proxyText(searchUrl, severity);
        const search = safeJSON(searchTxt);
        const hits = (search && search.query && search.query.search) || [];
        if (!hits.length) return { found: false, url: searchUrl, text: searchTxt, payload: { title: null } };
        const title = hits[0].title;
        const sumUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(String(title).replace(/ /g, '_'));
        const sumTxt = await proxyText(sumUrl, severity);
        const sum = safeJSON(sumTxt) || {};
        return { found: true, url: sumUrl, text: sumTxt, payload: normalizeWiki(sum, hits) };
      },
    },
    // Wiktionary — a claim about LANGUAGE (the safe tier).
    wiktionary: {
      label: 'Lexicon', host: 'en.wiktionary.org', register: 'language',
      async fetch(term, severity) {
        const url = 'https://en.wiktionary.org/api/rest_v1/page/definition/'
          + encodeURIComponent(String(term).trim().toLowerCase().replace(/ /g, '_'));
        const txt = await proxyText(url, severity);
        const data = safeJSON(txt);
        const norm = data ? normalizeWiktionary(data) : null;
        return { found: !!(norm && norm.entries.length), url, text: txt, payload: norm || { entries: [] } };
      },
    },
  };

  function safeJSON(txt) { try { return JSON.parse(txt); } catch (e) { return null; } }

  // Strip HTML to readable text (the REST payloads carry markup). We never
  // inject this as HTML downstream, so this is the whole sanitiser we need.
  function stripTags(html) {
    return String(html == null ? '' : html)
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function normalizeWiki(sum, hits) {
    const url = (sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page)
      || (sum.title ? 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(sum.title).replace(/ /g, '_')) : null);
    const description = sum.description || '';
    return {
      title: sum.title || (hits[0] && hits[0].title) || null,
      description,
      extract: sum.extract || '',
      thumbnail: (sum.thumbnail && sum.thumbnail.source) || null,
      page: url,
      // a retype SUGGESTION derived from the one-line description — a proposal
      // for the reader, never auto-applied to the closed-world graph.
      typeGuess: guessType(description),
      others: (hits || []).slice(1, 6).map(h => ({ title: h.title, snippet: stripTags(h.snippet) })),
    };
  }

  function normalizeWiktionary(data) {
    const langKeys = Object.keys(data).filter(k => Array.isArray(data[k]));
    const groups = data.en || (langKeys.length ? data[langKeys[0]] : []);
    const entries = [];
    for (const g of (groups || [])) {
      const defs = (g.definitions || [])
        .map(d => ({ definition: stripTags(d.definition), example: d.examples && d.examples.length ? stripTags(d.examples[0]) : null }))
        .filter(d => d.definition);
      if (defs.length) entries.push({ partOfSpeech: (g.partOfSpeech || '—'), definitions: defs });
    }
    return { lang: data.en ? 'en' : (langKeys[0] || null), entries };
  }

  // Map a Wikipedia one-line description to the engine's entity subtype, so a
  // generically-typed referent can be offered a better type. Conservative:
  // returns null unless a cue is unambiguous.
  const TYPE_CUES = [
    ['org', /\b(part(y|ies)|organi[sz]ation|company|corporation|agency|department|institution|university|college|school|club|union|committee|commission|bureau|board|firm|nonprofit|ngo|charity|team|band|network|league|association|ministry|council|authority)\b/i],
    ['place', /\b(city|cities|town|country|countries|state|province|region|county|village|river|mountain|lake|island|capital|district|neighbou?rhood|street|road|building|park|continent|nation|municipality|territory|borough|prefecture|peninsula)\b/i],
    ['person', /\b(politician|author|writer|actor|actress|singer|musician|player|footballer|athlete|artist|painter|composer|scientist|philosopher|economist|president|minister|senator|lawyer|judge|journalist|engineer|general|officer|\bborn\b)\b/i],
  ];
  function guessType(desc) {
    const d = String(desc || '');
    for (const [type, re] of TYPE_CUES) if (re.test(d)) return type;
    return null;
  }

  /* ---- the proxy transport: every upstream goes through it, rate-limited ----
     `proxyText` is the scheduled unit — it draws a slot from the shared limiter
     (severity orders contended requests), so the throttle is at real-request
     granularity. `rawProxyText` is the actual fetch + transient-retry, run
     inside that slot. Throws on a disabled proxy or a non-2xx the retries could
     not clear, so lookup() can mark the right status. */
  function proxyText(target, severity) {
    return scheduler.add(() => rawProxyText(target), severity || 0);
  }
  async function rawProxyText(target) {
    const base = proxyBase();
    if (!base) { const e = new Error('reference proxy disabled'); e.disabled = true; throw e; }
    return rawGet(base + '?url=' + encodeURIComponent(target));
  }
  // The actual fetch + transient-retry, on a full URL. Used by both the proxied
  // desk hops and the direct /lookup endpoint. Throws e.disabled if no fetch.
  async function rawGet(url) {
    const f = _fetch();
    if (!f) { const e = new Error('no fetch available'); e.disabled = true; throw e; }
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await f(url);
      } catch (netErr) {
        if (attempt++ < config.maxRetries) { await backoff(attempt); continue; }
        throw netErr;
      }
      if (res.ok) return res.text();
      // 429 / 5xx are transient: back off and retry. 4xx (except 429) are not.
      if ((res.status === 429 || res.status >= 500) && attempt++ < config.maxRetries) { await backoff(attempt); continue; }
      const e = new Error('request returned ' + res.status); e.status = res.status; throw e;
    }
  }
  function backoff(attempt) {
    const ms = config.backoffMs * Math.pow(2, attempt - 1);
    return new Promise(resolve => _timer(resolve, ms));
  }

  /* ============================================================
     The freeze cache — Tier-2 cold store, in miniature, in the browser.
     A hit is written to EOStore (IndexedDB) keyed by `<src>|<term>`; a repeat
     read is answered from the freeze and pays no network. Defensive: any
     storage failure degrades to in-memory for the session, never throws.
     ============================================================ */
  const CACHE_KEY = 'refcache';
  let _mem = null;          // { [src|term]: record }
  let _loaded = false;
  async function loadCache() {
    if (_loaded) return _mem;
    _mem = {};
    try {
      const st = _store();
      if (st && st.kvGet) { const v = await st.kvGet(CACHE_KEY); if (v && typeof v === 'object') _mem = v; }
    } catch (e) { _mem = _mem || {}; }
    _loaded = true;
    return _mem;
  }
  async function freeze(key, record) {
    const mem = await loadCache();
    mem[key] = record;
    // bound the store: drop the oldest beyond cacheCap (by fetched_at).
    const keys = Object.keys(mem);
    if (keys.length > config.cacheCap) {
      keys.sort((a, b) => (mem[a].basis.fetched_at < mem[b].basis.fetched_at ? -1 : 1));
      for (const k of keys.slice(0, keys.length - config.cacheCap)) delete mem[k];
    }
    try { const st = _store(); if (st && st.kvPut) await st.kvPut(CACHE_KEY, mem); } catch (e) {}
  }
  async function clearCache() {
    _mem = {}; _loaded = true;
    try { const st = _store(); if (st && st.kvPut) await st.kvPut(CACHE_KEY, {}); } catch (e) {}
  }

  /* ============================================================
     The private-individual gate. A courtesy title + a short personal name is a
     person the document introduces by name; resolving them against the world
     is exactly the over-reach the stratum must refuse. Ported from the read
     instrument (tools/external/read.js: looksPrivatePerson).
     ============================================================ */
  const TITLE = /^(mr|mrs|ms|miss|mx|dr|sir|lady|lord|prof|professor|rev|fr|sister|brother)\.?$/i;
  function privateIndividual(term, type) {
    const toks = String(term || '').trim().split(/\s+/);
    if (TITLE.test(toks[0]) && toks.length <= 3) return true;
    return false;
  }

  /* ============================================================
     The seriousness scorer — which residual deserves the network first.

     Mirrors tools/external/read.js's residual classification: an abstract noun
     the greedy pass left as `thing` is a safe LANGUAGE gap (→ wiktionary); a
     well-formed proper referent typed generically is a WORLD gap (→ wikipedia,
     the risky tier). Noise and already-good types earn nothing. Severity adds
     a salience term (how often the surface recurs), so a name that carries the
     piece outranks a one-off of the same shape.
     ============================================================ */
  const ABSTRACT_SUFFIX = /(ism|ity|tion|sion|logy|ance|ence|ness|ship|ery|acy|ment|ude)$/i;
  const ORG_SUFFIX = /(partnership|corporation|council|management|company|committee|department|authority|association|commission|bureau|agency|court|ministry|board|office|university|institute|foundation|party|patrol|llc|inc|co)$/i;
  const LAW_CUE = /\b(act|bill|code|amendment|statute|ordinance)\b/i;
  const FRAGMENT = new Set(['should', 'not', 'be', 'same', 'such', 'between', 'from', 'against',
    'considered', 'conferred', 'exposed', 'compared', 'answered', 'into', 'and', 'of', 'the', 'to',
    'which', 'that', 'this', 'are', 'is', 'must']);

  function looksAbstract(name) {
    return /^[A-Z][a-z]+$/.test(name) && ABSTRACT_SUFFIX.test(name) && name.split(/\s+/).length === 1;
  }
  function looksOrg(name) {
    return name.split(/\s+/).some(w => ORG_SUFFIX.test(w)) || (/\bof\b/.test(name) && /[A-Z]/.test(name));
  }
  function looksNoise(name) {
    const toks = String(name).split(/\s+/);
    if (toks.length > 1 && toks.slice(1).some(w => FRAGMENT.has(w.toLowerCase()))) return true;
    if (toks.some(w => /(considered|conferred|exposed|compared|answered|restraining)$/i.test(w))) return true;
    return false;
  }

  // Classify ONE entity into a need (or null if external knowledge is not the
  // instrument). `entity` is the engine's projected shape: { name, type, key, mass, raw, gender }.
  function classifyOne(entity) {
    const name = String(entity.name || '').trim();
    if (!name) return null;
    const type = entity.type || 'thing';
    const salience = Math.max(1, entity.mass || entity.raw || 1);
    const sal = Math.log(1 + salience);
    if (privateIndividual(name, type)) {
      return { term: name, key: entity.key || name, type, source: 'wikipedia', kind: 'referent',
        gated: true, reason: 'private-individual', severity: 0, mass: salience };
    }
    if (looksNoise(name)) return null; // a heading / TOC fragment — a lookup fabricates
    // already a usable proper type: not a residual the desk should chase.
    if (type === 'person' || type === 'org') return null;
    if (looksAbstract(name)) {
      return { term: name, key: entity.key || name, type, source: 'wiktionary', kind: 'abstract-kind',
        gated: false, reason: 'abstract noun mistyped generic', severity: 2.0 + sal, mass: salience };
    }
    if (type === 'place' && name.split(/\s+/).length === 1) return null; // single-word place: assume correct
    if (looksOrg(name) || LAW_CUE.test(name)) {
      return { term: name, key: entity.key || name, type, source: 'wikipedia', kind: 'org-or-law',
        gated: false, reason: 'proper referent mistyped generic', severity: 3.0 + sal, mass: salience };
    }
    if (/^[A-Z]/.test(name) && name.split(/\s+/).length >= 2) {
      return { term: name, key: entity.key || name, type, source: 'wikipedia', kind: 'referent',
        gated: false, reason: 'multiword proper referent typed generic', severity: 2.5 + sal, mass: salience };
    }
    return null;
  }

  // Rank a document's entities by how badly they need an outside source. Pure,
  // no network — drives the UI's "N serious unknowns" affordance and the order
  // resolveNeeds spends its budget in.
  function classifyNeeds(entities, opts) {
    const includeGated = !!(opts && opts.includeGated);
    const needs = [];
    for (const e of (entities || [])) {
      const n = classifyOne(e);
      if (!n) continue;
      if (n.gated && !includeGated) continue;
      needs.push(n);
    }
    needs.sort((a, b) => b.severity - a.severity);
    return needs;
  }

  /* ============================================================
     The lookup itself. Resolves one (source, term) to:
       { status:'hit',     basis, payload }   frozen or freshly fetched
       { status:'miss',    basis }            source reached, nothing found
       { status:'gated',   reason }           private-individual gate
       { status:'disabled' }                  proxy cleared / no fetch
       { status:'pending' }                   offline + uncached → abstain
       { status:'error',   error }            transport failed
     Always consults the freeze first; freezes every hit. Shares the global
     rate limiter via the scheduler (severity orders contended calls).
     ============================================================ */
  async function lookup(src, term, opts) {
    opts = opts || {};
    if (!SOURCES[src]) throw new Error('unknown source: ' + src);
    term = String(term == null ? '' : term).trim();
    if (!term) return { status: 'miss', basis: null };
    // the world tier honours the private-individual gate; the language tier
    // (Wiktionary) is about words, so a name there is harmless.
    if (src === 'wikipedia' && !opts.allowPrivate && privateIndividual(term, opts.type)) {
      return { status: 'gated', reason: 'private-individual' };
    }
    const key = src + '|' + term.toLowerCase();
    const mem = await loadCache();
    if (Object.prototype.hasOwnProperty.call(mem, key)) {
      const rec = mem[key];
      return rec.found ? { status: 'hit', basis: rec.basis, payload: rec.payload, cached: true }
                       : { status: 'miss', basis: rec.basis, cached: true };
    }
    if (!proxyBase() || !_fetch()) return { status: 'disabled' };
    if (opts.replayOnly) return { status: 'pending' }; // abstain: no freeze, caller asked not to pay

    const sev = opts.severity || 0;
    try {
      const out = await SOURCES[src].fetch(term, sev);
      const basis = { src, term, url: out.url, fetched_at: new Date().toISOString(), hash: hashTag(out.text || ''), schema: SCHEMA };
      await freeze(key, { found: out.found, basis, payload: out.found ? out.payload : null });
      return out.found ? { status: 'hit', basis, payload: out.payload } : { status: 'miss', basis };
    } catch (e) {
      if (e && e.disabled) return { status: 'disabled' };
      return { status: 'error', error: String((e && e.message) || e) };
    }
  }

  const encyclopaedia = (term, opts) => lookup('wikipedia', term, opts);
  const lexicon = (term, opts) => lookup('wiktionary', term, opts);

  // Both registers for one term — the reference desk's two columns.
  async function refdesk(term, opts) {
    const [enc, lex] = await Promise.all([
      encyclopaedia(term, opts),
      lexicon(term, opts),
    ]);
    return { term, encyclopaedia: enc, lexicon: lex };
  }

  /* ============================================================
     Chat enrichment — one normalized call to the /lookup endpoint.

     The server-side node returns { query, found, encyclopedia, dictionary,
     sources } already tag-stripped, so a chat message's reference card is a
     single rate-limited GET (not the desk's two proxied hops). Same freeze /
     replay / abstain / gate discipline as lookup().
     ============================================================ */
  function normalizeLookup(data) {
    if (!data || typeof data !== 'object') return null;
    return {
      query: data.query || null,
      found: !!data.found,
      encyclopedia: data.encyclopedia || null,
      dictionary: data.dictionary || null,
      sources: Array.isArray(data.sources) ? data.sources : [],
    };
  }

  async function enrichTerm(q, opts) {
    opts = opts || {};
    q = String(q == null ? '' : q).trim();
    if (!q) return { status: 'miss' };
    if (!opts.allowPrivate && privateIndividual(q, opts.type)) return { status: 'gated', reason: 'private-individual', query: q };
    const key = 'lookup|' + q.toLowerCase();
    const mem = await loadCache();
    if (Object.prototype.hasOwnProperty.call(mem, key)) {
      const rec = mem[key];
      return rec.found ? { status: 'hit', query: q, basis: rec.basis, payload: rec.payload, cached: true }
                       : { status: 'miss', query: q, basis: rec.basis, cached: true };
    }
    const base = lookupBase();
    if (!base || !_fetch()) return { status: 'disabled' };
    if (opts.replayOnly) return { status: 'pending', query: q };
    const url = base + (base.indexOf('?') === -1 ? '?' : '&') + 'q=' + encodeURIComponent(q);
    try {
      const txt = await scheduler.add(() => rawGet(url), opts.severity || 0);
      const data = safeJSON(txt);
      const payload = normalizeLookup(data);
      const found = !!(payload && payload.found);
      const basis = { src: 'lookup', term: q, url, fetched_at: new Date().toISOString(), hash: hashTag(txt || ''), schema: SCHEMA };
      await freeze(key, { found, basis, payload: found ? payload : null });
      return found ? { status: 'hit', query: q, basis, payload } : { status: 'miss', query: q, basis };
    } catch (e) {
      if (e && e.disabled) return { status: 'disabled' };
      return { status: 'error', error: String((e && e.message) || e), query: q };
    }
  }

  /* ============================================================
     article() — the knowledge-augmentation fetch (chat with Wikipedia).

     For ingesting a real source into the graph, the lead-paragraph summary is
     too thin. This pulls the FULL plain-text article (search → extracts) so the
     grounded reader has a whole document to cite. Self-contained on the feed
     proxy (no /lookup node needed). Rate-limited, cached, gated, abstaining.
     The text is capped so a parse stays responsive and the freeze stays small.
     ============================================================ */
  const ARTICLE_CAP = 24000;

  function normalizeArticle(title, page, hits, fullText) {
    const t = (page && page.title) || title;
    const url = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(t).replace(/ /g, '_'));
    const text = String(fullText || '').slice(0, ARTICLE_CAP);
    const intro = (text.split(/\n+/).find(p => p.trim().length > 0) || text.slice(0, 400)).trim();
    return {
      title: t, url,
      description: (page && page.description) || null,
      thumbnail: (page && page.thumbnail && page.thumbnail.source) || null,
      text,
      intro: intro.length > 600 ? intro.slice(0, 600) + '…' : intro,
      also_see: (hits || []).slice(1, 6).map(h => h.title),
      typeGuess: guessType((page && page.description) || ''),
    };
  }

  async function article(q, opts) {
    opts = opts || {};
    q = String(q == null ? '' : q).trim();
    if (!q) return { status: 'miss' };
    if (!opts.allowPrivate && privateIndividual(q, opts.type)) return { status: 'gated', reason: 'private-individual', query: q };
    const key = 'article|' + q.toLowerCase();
    const mem = await loadCache();
    if (Object.prototype.hasOwnProperty.call(mem, key)) {
      const rec = mem[key];
      return rec.found ? { status: 'hit', query: q, basis: rec.basis, payload: rec.payload, cached: true }
                       : { status: 'miss', query: q, basis: rec.basis, cached: true };
    }
    if (!proxyBase() || !_fetch()) return { status: 'disabled' };
    if (opts.replayOnly) return { status: 'pending', query: q };
    try {
      const searchUrl = 'https://en.wikipedia.org/w/api.php?format=json&action=query&list=search&srlimit=6&srsearch=' + encodeURIComponent(q);
      const searchTxt = await proxyText(searchUrl, opts.severity || 0);
      const hits = ((safeJSON(searchTxt) || {}).query || {}).search || [];
      if (!hits.length) {
        const basis = { src: 'article', term: q, url: searchUrl, fetched_at: new Date().toISOString(), hash: hashTag(searchTxt || ''), schema: SCHEMA };
        await freeze(key, { found: false, basis, payload: null });
        return { status: 'miss', query: q, basis };
      }
      const title = hits[0].title;
      const exUrl = 'https://en.wikipedia.org/w/api.php?format=json&action=query&prop=extracts%7Cdescription%7Cpageimages'
        + '&explaintext=1&exlimit=1&redirects=1&piprop=thumbnail&pithumbsize=320&titles=' + encodeURIComponent(title);
      const exTxt = await proxyText(exUrl, opts.severity || 0);
      const pages = (((safeJSON(exTxt) || {}).query) || {}).pages || null;
      const page = pages ? pages[Object.keys(pages)[0]] : null;
      const fullText = page && page.extract ? String(page.extract) : '';
      const found = !!fullText.trim();
      const payload = normalizeArticle(title, page, hits, fullText);
      const basis = { src: 'article', term: q, url: exUrl, fetched_at: new Date().toISOString(), hash: hashTag(exTxt || ''), schema: SCHEMA };
      await freeze(key, { found, basis, payload: found ? payload : null });
      return found ? { status: 'hit', query: q, basis, payload } : { status: 'miss', query: q, basis };
    } catch (e) {
      if (e && e.disabled) return { status: 'disabled' };
      return { status: 'error', error: String((e && e.message) || e), query: q };
    }
  }

  // Pick the term worth looking up from a free-text chat message: a quoted
  // phrase, else the longest capitalized run (after stripping a question
  // lead-in), else the cleaned remainder. Pure — drives the chat enrichment.
  function pickQuery(text) {
    let t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const quoted = /["“”'’]([^"“”'’]{2,60})["“”'’]/.exec(t);
    if (quoted && quoted[1].trim()) return quoted[1].trim();
    t = t.replace(/^(?:tell me about|tell me|explain|define|describe|summari[sz]e|give me|show me)\b[\s,:'-]*/i, '')
         // strip a RUN of leading question / auxiliary words ("what is", "who was")
         .replace(/^(?:(?:who|what|which|where|when|why|how|whose|whom|is|are|was|were|do|does|did|can|could|would|should)\b[\s,:'-]*)+/i, '')
         .replace(/[?.!]+\s*$/, '').trim();
    const caps = t.match(/\b[A-Z][\w'’-]+(?:\s+(?:of|the|and|de|van|von|du|la|le)\s+[A-Z][\w'’-]+|\s+[A-Z][\w'’-]+)*\b/g) || [];
    if (caps.length) { caps.sort((a, b) => b.length - a.length); return caps[0]; }
    return t ? t.slice(0, 60).trim() : null;
  }

  // Does this turn EXPLICITLY ask to acquire an article — a lookup verb or an
  // acquisition frame ("look up / find / pull up / search / get the article on
  // X", or "who is / what is / tell me about <ProperName>")? A bare factual or
  // follow-up question ("what are his inspirations?", "when was he born?") is
  // intent: factual, NOT intent: acquire, and must never reach the fetcher.
  // The discriminator for the who/what/tell-me frames is a proper-name target
  // in the ORIGINAL casing — "what are his inspirations" has none, so it is
  // factual; "who is Howard Shore" does, so it is an acquisition candidate
  // (still gated downstream by corpus-resolution and the active-subject
  // follow-up check — naming alone never forces a fetch). Pure.
  function acquireIntent(text) {
    const q = String(text == null ? '' : text);
    const t = ' ' + q.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim() + ' ';
    // explicit lookup verbs / acquisition frames — these carry their own
    // acquisition force regardless of a capitalized target
    if (/\b(look\s+(?:up\b|\w+\s+up\b)|pull\s+up\b|search(?:\s+for)?\b|google\b|wikipedia\b|find\s+(?:me\s+)?(?:the\s+)?(?:article|page|entry|wiki|info|information)\b|get\s+(?:me\s+)?(?:the\s+)?(?:article|page|entry|info|information)\b|read\s+(?:up\s+)?(?:on|about)\b)/.test(t)) return true;
    // definitional / orientation frames acquire only when they name a proper
    // subject (a capitalized target after the frame, in the original casing)
    if (/\b(who\s+(?:is|was|are|were)|what\s+(?:is|are|was|were)|what's|tell me about)\b/.test(t)
        && /\b(?:who\s+(?:is|was|are|were)|what\s+(?:is|are|was|were)|what's|tell\s+me\s+about)\b[^.?!,;:]*?\b\p{Lu}[\p{Ll}'’-]+/u.test(q))
      return true;
    return false;
  }

  /* ============================================================
     Wikipedia article → ingestible document text.

     The plain-text extract arrives with its outline inline (== Heading ==)
     and its reference apparatus at the tail. Three moves before ingestion:
       · the title and short description become their own PUNCTUATED
         paragraphs — unpunctuated, the segmenter glues them into the first
         body sentence ("Howard Shore Canadian film score composer (born
         1946)" as sentence 0), which seeds a polluted entity span;
       · boilerplate bands (References, External links, See also, Notes,
         Further reading…) are dropped WHOLE — their link rows otherwise
         outrank prose in name-overlap retrieval and leak into citations
         ("Howard Shore at IMDb" as a top hit);
       · section headings are kept verbatim: the engine's chrome gate reads
         them as structure (never prose), and they stay fold boundaries.
     ============================================================ */
  const WIKI_DROP_SECTIONS = /^(references|external links|see also|notes|further reading|sources|citations|footnotes|works cited)$/i;
  function stripWikiSections(text) {
    const out = [];
    let dropLevel = 0;
    for (const line of String(text == null ? '' : text).split('\n')) {
      const h = line.match(/^\s*(={2,6})\s*(.+?)\s*\1\s*$/);
      if (h) {
        const level = h[1].length;
        if (dropLevel && level <= dropLevel) dropLevel = 0;
        if (!dropLevel && WIKI_DROP_SECTIONS.test(h[2].trim())) { dropLevel = level; continue; }
      }
      if (!dropLevel) out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function articleDocText(p) {
    if (!p) return '';
    const dot = (s) => { s = String(s == null ? '' : s).trim(); return s ? (/[.!?…]$/.test(s) ? s : s + '.') : ''; };
    const parts = [];
    if (p.title) parts.push(dot(p.title));
    if (p.description) parts.push(dot(p.description));
    const body = stripWikiSections((p.text && p.text.trim()) ? p.text : (p.intro || ''));
    if (body) parts.push(body);
    if (p.url) parts.push('Source: ' + p.url);
    return parts.filter(Boolean).join('\n\n').trim();
  }

  /* ============================================================
     The prioritised, budgeted batch. Spend at most `budget` live lookups on
     the most serious needs; the rest come back `skipped` (abstain). Results
     stream through opts.onResult so the UI can fill in as the rate limiter
     releases each call. Honours an AbortSignal so navigating away stops it.
     ============================================================ */
  async function resolveNeeds(needs, opts) {
    opts = opts || {};
    const budget = opts.budget == null ? config.budget : opts.budget;
    const ranked = (needs || []).slice().sort((a, b) => b.severity - a.severity);
    const results = new Map();
    const fire = [];
    ranked.forEach((need, i) => {
      if (need.gated) { results.set(need.key, { need, status: 'gated', reason: need.reason }); emit(opts, need, results.get(need.key)); return; }
      if (i >= budget) { results.set(need.key, { need, status: 'skipped', reason: 'budget' }); emit(opts, need, results.get(need.key)); return; }
      fire.push(need);
    });
    await Promise.all(fire.map(async (need) => {
      if (opts.signal && opts.signal.aborted) { results.set(need.key, { need, status: 'skipped', reason: 'aborted' }); return; }
      const r = await lookup(need.source, need.term, { severity: need.severity, type: need.type });
      const out = Object.assign({ need }, r);
      results.set(need.key, out);
      emit(opts, need, out);
    }));
    return results;
  }
  function emit(opts, need, result) { if (opts.onResult) { try { opts.onResult(need, result); } catch (e) {} } }

  /* ---- consent: an explicit, remembered grant before the first off-device
     query. Kept in localStorage so it is independent of the React tree. ---- */
  const CONSENT_KEY = 'cleo.reference.consent';
  function hasConsent() {
    try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch (e) { return false; }
  }
  function grantConsent() { try { localStorage.setItem(CONSENT_KEY, '1'); } catch (e) {} return true; }
  function revokeConsent() { try { localStorage.removeItem(CONSENT_KEY); } catch (e) {} }

  const api = {
    SCHEMA,
    cfg, setConfig,
    classifyNeeds, lookup, encyclopaedia, lexicon, refdesk, resolveNeeds,
    enrichTerm, article, pickQuery, acquireIntent,
    stripWikiSections, articleDocText,
    hasConsent, grantConsent, revokeConsent,
    clearCache,
    enabled: () => !!proxyBase() && !!_fetch(),
    // exposed for the test harness / introspection
    _internals: {
      createScheduler, hashTag, stripTags, normalizeWiki, normalizeWiktionary,
      normalizeLookup, normalizeArticle, guessType, classifyOne, privateIndividual,
      looksAbstract, looksOrg, looksNoise, proxyBase, lookupBase, loadCache, freeze, SOURCES,
    },
  };

  if (typeof window !== 'undefined') window.EOExternal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
