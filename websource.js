/* ============================================================
   websource.js — external web documents as first-class groundable sources.

   Cleo reads in a closed world: every claim is bound to a line on the page and
   audited mechanically. external.js opened one narrow crack (an encyclopaedia /
   dictionary reference desk). This module opens a wider, governed one: a page
   found on the web becomes a Cleo SOURCE — segmented, embedded, and admitted
   through the SAME gates an uploaded document travels, with full provenance.
   Claims that rely on it cite it the same way claims cite an uploaded file, and
   the veto checks them the same way.

   This is a SOURCING function, not a model tool. The local WebLLM never reaches
   the network. It proposes; this mechanical layer fetches, admits, and binds.
   The disciplines are inherited from external.js and made stricter here:

     1. NO FREEFORM WEB TOOL. The model cannot call fetch. It can only emit a
        `fetch-proposal` (buildFetchProposal); a human confirms before anything
        leaves the browser.
     2. NO CHAT PATH. Casual conversation never triggers a network request. The
        module exposes no chat hook, and a fetch whose `triggered_by` is 'chat'
        is refused — the chat-isolation invariant is enforced in code, not docs.
     3. DISCOVERY ≠ COMMITMENT. search() is cheap and lists candidates; fetchPage()
        is the committing act and REQUIRES explicit user confirmation (the cost
        notice states that the query reaches public engines).
     4. COMPUTES NOTHING THE PROXY COMPUTED. The proxy holds key custody, runs the
        readability extraction, and computes the content hash. This module
        normalises the payload into a `web-source/1` record and hands it to the
        engine's document pipeline. It never re-fetches and never re-hashes.
     5. FROZEN + STALENESS-AWARE. A source freezes its content at fetched_at via
        content_hash. A re-fetch that changes the hash supersedes (never
        overwrites) the old record and marks dependent groundings stale.

   Published as window.EOWebSource (and module.exports for the Node test). Pure
   transport + policy: it holds no React. The engine, store, audit, fetch and
   clock are all injectable, so it is unit-testable with no browser.

   See docs/web-source-admission.md for the full design and the spec
   reconciliations (engine doc kind, the cleo-fetch/1 schema name).
   ============================================================ */
(function () {
  'use strict';

  const RECORD_SCHEMA = 'web-source/1';
  const FETCH_SCHEMA = 'cleo-fetch/1';   // the cleo-* audit family (spec called it cleon-fetch/1)
  const CITATION_TYPE = 'web-source';
  const PROXY_ID = 'cleon-search-proxy';

  /* ---- configuration (mirrors external.js's injectable idiom) ----
     Everything the module touches the outside world through is read from `config`
     so a test can patch it; the proxy base is also read live from `window` so a
     console override or a settings change takes effect without a reload. */
  const config = {
    maxResults: 8,                 // default discovery breadth
    engines: ['bing', 'duckduckgo'],   // reddit & others rate-limit a single IP (spec §4.1)
    maxRetries: 3,                 // on network error / 429 / 5xx, exponential backoff
    backoffMs: 800,
    activeCap: 24,                 // soft cap on active web sources per session (spec §14)
    proxy: null,                   // explicit proxy base; null ⇒ read window.EO_SEARCH_PROXY
    bearer: null,                  // optional shared bearer token issued at deploy time
    fetchImpl: null,               // injectable; defaults to global fetch
    now: null,                     // injectable clock; defaults to () => new Date()
    store: null,                   // injectable persistence; defaults to window.EOStore
    audit: null,                   // injectable audit recorder; defaults to window.EOAudit
    engine: null,                  // injectable reading engine; defaults to window.EOEngine
  };
  function setConfig(patch) { Object.assign(config, patch || {}); return cfg(); }

  function proxyBase() {
    if (config.proxy != null) return config.proxy || '';
    if (typeof window !== 'undefined' && 'EO_SEARCH_PROXY' in window) {
      return window.EO_SEARCH_PROXY == null ? '' : String(window.EO_SEARCH_PROXY);
    }
    return '';   // off by default — the privacy thesis: no public endpoint baked in
  }
  function cfg() { return Object.assign({}, config, { proxy: proxyBase(), enabled: !!proxyBase() }); }
  function enabled() { return !!proxyBase(); }

  const _fetch = () => config.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const _store = () => config.store || (typeof window !== 'undefined' ? window.EOStore : null);
  const _audit = () => config.audit || (typeof window !== 'undefined' ? window.EOAudit : null);
  const _engine = () => config.engine || (typeof window !== 'undefined' ? window.EOEngine : null);
  const _now = () => (config.now ? config.now() : new Date());
  const _iso = () => _now().toISOString();
  const _ms = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function backoff(attempt) {
    const wait = config.backoffMs * Math.pow(2, attempt - 1);
    return new Promise(resolve => setTimeout(resolve, wait));
  }

  /* ---- the proxy transport. POST JSON to {proxy}{path}; retry transient
     failures (network / 429 / 5xx). Throws e.disabled when the proxy is off or
     no fetch is available, so the caller can surface the right status and admit
     nothing. Carries the optional bearer (kept in config / on the server; never
     in document data). ---- */
  async function postJSON(path, body) {
    const base = proxyBase();
    if (!base) { const e = new Error('search proxy disabled'); e.disabled = true; throw e; }
    const f = _fetch();
    if (!f) { const e = new Error('no fetch available'); e.disabled = true; throw e; }
    const url = base.replace(/\/$/, '') + path;
    const headers = { 'content-type': 'application/json' };
    if (config.bearer) headers['authorization'] = 'Bearer ' + config.bearer;
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await f(url, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (netErr) {
        if (attempt++ < config.maxRetries) { await backoff(attempt); continue; }
        throw netErr;
      }
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (res.ok) return data || {};
      if ((res.status === 429 || res.status >= 500) && attempt++ < config.maxRetries) { await backoff(attempt); continue; }
      const msg = (data && data.error) || ('request returned ' + res.status);
      const e = new Error(msg); e.status = res.status; e.http_status = res.status; throw e;
    }
  }

  /* ============================================================
     Audit — every external touch is logged as a cleo-fetch/1 record (spec §10).
     `triggered_by` is NEVER 'chat': a chat-triggered fetch is a broken build, so
     it is refused here AND in the recorder. The record carries no document data,
     only the network metadata a reader needs to see which turns touched the net.
     ============================================================ */
  function emitFetchAudit(rec) {
    const full = Object.assign({ schema: FETCH_SCHEMA, ts: _iso(), proxy: PROXY_ID }, rec || {});
    if (full.triggered_by === 'chat') {
      // The chat-isolation invariant (spec §10). Never record it; signal loudly.
      const e = new Error('web fetch from the chat path is forbidden (chat-isolation invariant)');
      e.chatIsolation = true; throw e;
    }
    if (!full.triggered_by) full.triggered_by = 'user-action';
    try { const A = _audit(); if (A && A.recordFetch) A.recordFetch(full); } catch (e) {}
    return full;
  }

  /* ============================================================
     4.1 / 11 — DISCOVERY. Cheap; lists candidates the human picks from. Does NOT
     fetch page bodies. The cost notice (costNotice) is what the UI must show
     before the FIRST network hop, because even discovery forwards the query
     terms to the upstream engines — the proxy hides the IP, not the query.
     ============================================================ */
  function costNotice(q) {
    const term = String(q == null ? '' : q).trim();
    return 'This sends ' + (term ? '“' + term + '”' : 'your query')
      + ' through your proxy to public search engines, which see the query text, '
      + 'and fetches only the pages you select.';
  }

  async function search(q, opts) {
    opts = opts || {};
    const query = String(q == null ? '' : q).trim();
    if (!query) { const e = new Error('empty query'); e.empty = true; throw e; }
    // Guard the chat-isolation invariant BEFORE any network hop (spec §10/§13.3):
    // even discovery forwards query terms upstream, so a chat trigger must never
    // reach the proxy in the first place.
    if (opts.triggered_by === 'chat') {
      const e = new Error('web search from the chat path is forbidden (chat-isolation invariant)');
      e.chatIsolation = true; throw e;
    }
    const body = {
      q: query,
      max_results: opts.max_results || config.maxResults,
      engines: opts.engines || config.engines,
    };
    const t0 = _ms();
    let data, err = null;
    try { data = await postJSON('/search', body); }
    catch (e) { err = e; }
    const results = (data && Array.isArray(data.results)) ? data.results : [];
    emitFetchAudit({
      action: 'search', query, engine: (body.engines || []).join('+'),
      result_count: results.length, http_status: err ? (err.http_status || 0) : 200,
      latency_ms: Math.round(_ms() - t0),
      triggered_by: opts.triggered_by || 'deep-read',
    });
    if (err) throw err;
    return {
      query: (data && data.query) || query,
      fetched_at: (data && data.fetched_at) || _iso(),
      results: results.map(normalizeResult),
    };
  }
  function normalizeResult(r) {
    r = r || {};
    return {
      title: String(r.title || ''), url: String(r.url || ''),
      snippet: String(r.snippet || ''), engine: String(r.engine || ''),
      score: typeof r.score === 'number' ? r.score : 0,
    };
  }

  /* ============================================================
     4.2 / 11 — COMMITMENT. fetchPage() is the committing act and REQUIRES
     explicit confirmation (opts.confirmed === true). Without it, nothing leaves
     the browser — the function throws a cost-required error and fires no
     network. This is the code form of spec §13.4 (explicit cost).
     ============================================================ */
  async function fetchPage(url, opts) {
    opts = opts || {};
    const u = String(url == null ? '' : url).trim();
    if (!u) { const e = new Error('empty url'); e.empty = true; throw e; }
    if (opts.confirmed !== true) {
      const e = new Error('a web fetch requires explicit user confirmation: ' + costNotice(opts.retrieval_query || ''));
      e.costRequired = true; e.notice = costNotice(opts.retrieval_query || '');
      throw e;
    }
    if (opts.triggered_by === 'chat') {
      const e = new Error('web fetch from the chat path is forbidden (chat-isolation invariant)');
      e.chatIsolation = true; throw e;
    }
    const body = { url: u, retrieval_query: opts.retrieval_query || '', engine: opts.engine || '' };
    const t0 = _ms();
    let data, err = null;
    try { data = await postJSON('/fetch', body); }
    catch (e) { err = e; }
    if (!err && data && data.error) { err = new Error(data.error); err.http_status = data.http_status || 0; }
    emitFetchAudit({
      action: 'fetch', url: u, final_url: (data && data.final_url) || u,
      engine: body.engine, content_hash: (data && data.content_hash) || null,
      http_status: err ? (err.http_status || 0) : ((data && data.http_status) || 200),
      latency_ms: Math.round(_ms() - t0),
      triggered_by: opts.triggered_by || 'user-action',
    });
    if (err) throw err;
    return data;
  }

  /* ============================================================
     5.1 — NORMALISE a /fetch payload into a web-source/1 record. Computes nothing
     the proxy already computed (uses the proxy's content_hash). segments and
     embeddings_ref are filled at admission, not here.
     ============================================================ */
  function toRecord(payload) {
    payload = payload || {};
    const hash = String(payload.content_hash || '');
    if (!hash) { const e = new Error('payload carries no content_hash; refusing to admit'); e.badPayload = true; throw e; }
    const hex = hash.replace(/^sha256[-:]/i, '');   // id is the first 16 HEX chars (spec §5.1)
    return {
      schema: RECORD_SCHEMA,
      id: 'web:' + hex.slice(0, 16),
      kind: 'web-source',
      url: String(payload.url || ''),
      final_url: String(payload.final_url || payload.url || ''),
      title: String(payload.title || payload.final_url || payload.url || 'Untitled web source'),
      byline: payload.byline == null ? null : String(payload.byline),
      excerpt: payload.excerpt == null ? null : String(payload.excerpt),
      retrieval_query: String(payload.retrieval_query || ''),
      engine: String(payload.engine || ''),
      fetched_at: String(payload.fetched_at || _iso()),
      content_hash: hash,
      text: String(payload.text || ''),
      segments: [],
      embeddings_ref: null,
      status: 'active',
    };
  }

  /* ============================================================
     5.2 — ADMISSION. A web source travels the IDENTICAL pipeline an uploaded
     document travels. We route record.text through the engine's parseDocument,
     which runs the DOCUMENT segmenter (abbreviation-rejoin: "Mr.", "Inc.", "v.",
     section numbers) — NOT the draft splitter — and the same SEG → embed → graph
     path (spec §5.2.1/§5.2.2). The resulting engine doc keeps kind:'prose' so the
     ~20 prose-gated engine paths (retrieval, projection, answer) all run
     unchanged; the web-source identity rides as additive provenance metadata
     (doc.web / doc.sourceKind / doc._webRecord). The store record stays
     kind:'web-source' (spec §5.1). See docs/web-source-admission.md.

     Returns { record, doc } — the doc is the retrievable referent the app adds to
     its scope, so the engine's two-sighting gate counts this source's sightings
     alongside the loaded document's (cross-source corroboration, spec §5.2.3).
     ============================================================ */
  async function admit(recordOrPayload, opts) {
    opts = opts || {};
    const record = recordOrPayload && recordOrPayload.schema === RECORD_SCHEMA
      ? recordOrPayload : toRecord(recordOrPayload);
    const E = _engine();
    if (!E || !E.parseDocument) { const e = new Error('reading engine unavailable'); e.noEngine = true; throw e; }
    const name = record.title || record.final_url || record.url || record.id;
    // The engine doc id must be COLON-FREE: citation markers render as
    // {{cite:docId:idx:sN}} and the chat parser splits the payload on ':'. The
    // store record keeps the spec id (web:<hash16>); the engine sees web-<hash16>.
    const doc = await E.parseDocument(name, record.text, engineDocId(record));
    // Fill the record's segments from the engine's own segmentation, so the
    // persisted record and the engine doc agree on segment ids (s0, s1, …).
    const segs = (doc.sentenceTexts || []).map((t, i) => ({ id: 's' + i, text: String(t) }));
    record.segments = segs;
    record.embeddings_ref = record.id;   // opaque handle: the engine owns the vectors
    // Additive provenance on the engine doc — never read by the prose gates.
    doc.sourceKind = 'web-source';
    doc.web = {
      url: record.url, final_url: record.final_url, title: record.title,
      byline: record.byline, excerpt: record.excerpt,
      fetched_at: record.fetched_at, content_hash: record.content_hash,
      retrieval_query: record.retrieval_query, engine: record.engine,
    };
    doc._webRecord = record;
    if (opts.persist !== false) { try { await saveRecord(record); } catch (e) {} }
    return { record, doc };
  }

  /* ============================================================
     6 — CITATION. A claim grounded in a web source carries a `web-source`
     citation (spec §6). The engine produces a sentence-level cite {docId, idx};
     this maps it to the web citation, computing char_span as the [start,end] of
     the binding tokens WITHIN the cited segment text — the same span the veto's
     token-existence check reasons over.
     ============================================================ */
  // The engine doc id for a record: the spec id with its colon swapped for a
  // hyphen, because citation markers embed the doc id in a ':'-delimited payload
  // (chat.jsx). Deterministic and reversible via recordForDocId.
  function engineDocId(record) {
    const id = (record && record.id) || '';
    return String(id).replace(/:/g, '-');
  }
  // Resolve an engine cite's docId back to its web-source record.
  function recordForDocId(docId, records) {
    const d = String(docId || '');
    return (records || []).find(r => r && engineDocId(r) === d) || null;
  }
  function toWebCitation(record, segIdx, segText, bindingTokens) {
    record = record || {};
    const span = spanOfTokens(segText, bindingTokens);
    return {
      type: CITATION_TYPE,
      source_id: record.id,
      segment_id: 's' + segIdx,
      char_span: span,
      url: record.final_url || record.url || '',
      fetched_at: record.fetched_at || '',
      content_hash: record.content_hash || '',
    };
  }
  // The smallest [start,end] in `text` covering the binding tokens (case-insensitive,
  // word-boundary). Falls back to [0, text.length] when tokens aren't located, so a
  // citation always carries a concrete span the veto can read.
  function spanOfTokens(text, tokens) {
    const s = String(text == null ? '' : text);
    const toks = (Array.isArray(tokens) ? tokens : String(tokens || '').split(/\s+/))
      .map(t => String(t || '').trim()).filter(Boolean);
    if (!toks.length) return [0, s.length];
    const lc = s.toLowerCase();
    let lo = Infinity, hi = -Infinity;
    for (const tk of toks) {
      const t = tk.toLowerCase().replace(/[^a-z0-9'’-]/g, '');
      if (!t) continue;
      let i = lc.indexOf(t);
      while (i !== -1) {
        const before = i === 0 || /[^a-z0-9'’-]/.test(lc[i - 1]);
        const after = i + t.length >= lc.length || /[^a-z0-9'’-]/.test(lc[i + t.length]);
        if (before && after) { lo = Math.min(lo, i); hi = Math.max(hi, i + t.length); break; }
        i = lc.indexOf(t, i + 1);
      }
    }
    if (lo === Infinity) return [0, s.length];
    return [lo, hi];
  }

  /* The veto's extra checks for a web citation, at emission time (spec §6):
       • the source status must be 'active' (not retracted / superseded),
       • the stored content_hash must match the hash on the citation (a mismatch
         means the page changed under the claim — stale, must re-fire),
       • the cited span must actually contain the binding tokens (token-existence,
         parity with internal sources).
     Returns { ok, reason } — total, never throws. The engine still runs its own
     token-existence veto; this is the web-source-specific gate on top. */
  function verifyCitation(citation, record, bindingTokens) {
    citation = citation || {}; record = record || {};
    if (record.status !== 'active') return { ok: false, reason: 'source ' + (record.status || 'missing') };
    if (citation.content_hash && record.content_hash && citation.content_hash !== record.content_hash) {
      return { ok: false, reason: 'hash mismatch (stale)' };
    }
    if (bindingTokens != null) {
      const seg = segmentText(record, citation.segment_id);
      const span = citation.char_span || [0, (seg || '').length];
      const cited = String(seg || '').slice(span[0], span[1]).toLowerCase();
      const toks = (Array.isArray(bindingTokens) ? bindingTokens : String(bindingTokens).split(/\s+/))
        .map(t => String(t || '').toLowerCase().replace(/[^a-z0-9'’-]/g, '')).filter(Boolean);
      const present = toks.every(t => cited.indexOf(t) !== -1);
      if (!present) return { ok: false, reason: 'binding tokens absent from cited span' };
    }
    return { ok: true, reason: 'active; hash matches' };
  }
  function segmentText(record, segId) {
    const segs = (record && record.segments) || [];
    const hit = segs.find(s => s.id === segId);
    if (hit) return hit.text;
    const m = /^s(\d+)$/.exec(String(segId || ''));
    if (m && segs[+m[1]]) return segs[+m[1]].text;
    return '';
  }

  /* ============================================================
     8 — STALENESS. A citation is stale when the source's content_hash no longer
     matches the hash recorded on the citation. supersede() creates a NEW
     web-source/1 record from a re-fetched payload (a different hash ⇒ a different
     id), marks the OLD record status:'superseded' (retained for the audit trail),
     and returns the citations that must re-fire. It does NOT overwrite (spec §8).
     ============================================================ */
  function isStale(citation, record) {
    if (!citation || !record) return false;
    if (!citation.content_hash || !record.content_hash) return false;
    return citation.content_hash !== record.content_hash;
  }
  async function supersede(oldRecord, newPayload, opts) {
    opts = opts || {};
    const newRecord = newPayload && newPayload.schema === RECORD_SCHEMA ? newPayload : toRecord(newPayload);
    if (oldRecord && newRecord.content_hash === oldRecord.content_hash) {
      // Same bytes — not a change. Nothing supersedes; the old record stands.
      return { newRecord: oldRecord, superseded: null, unchanged: true, refire: [] };
    }
    if (oldRecord) oldRecord.status = 'superseded';
    const citations = Array.isArray(opts.citations) ? opts.citations : [];
    const refire = oldRecord ? citations.filter(c => c && c.source_id === oldRecord.id) : [];
    if (opts.persist !== false) {
      try { if (oldRecord) await saveRecord(oldRecord); await saveRecord(newRecord); } catch (e) {}
    }
    return { newRecord, superseded: oldRecord || null, unchanged: false, refire };
  }

  /* ============================================================
     9 — RETRACTION. The user retracts a web source: status:'retracted', its
     segments leave retrieval, its sightings retract through SEG, and the
     groundings that depended on it re-fire. An entity admitted ONLY because this
     source supplied its second sighting falls back to NUL — which must be VISIBLE
     in the audit, not silent (spec §9). We set the status + return the re-fire
     signal (the affected source id + citations); the app re-runs grounding over
     the reduced scope and the turn audit shows the NUL fallback.
     ============================================================ */
  async function retract(record, opts) {
    opts = opts || {};
    if (!record) { const e = new Error('no record to retract'); e.badPayload = true; throw e; }
    record.status = 'retracted';
    if (opts.persist !== false) { try { await saveRecord(record); } catch (e) {} }
    const citations = Array.isArray(opts.citations) ? opts.citations : [];
    const refire = citations.filter(c => c && c.source_id === record.id);
    // A glass-box note so the retraction is legible in the trace (spec §9/§10).
    try { const A = _audit(); if (A && A.step) A.step('web-retract', { source_id: record.id, url: record.final_url || record.url, refire: refire.length }); } catch (e) {}
    return { record, refire, removeFromScope: record.id };
  }

  /* ============================================================
     7.1 — THE PROPOSER. The rewalk's needs-external bin emits a fetch-proposal;
     the model proposes the query, it does NOT execute it. This shapes that
     proposal. Proposer-only: nothing here fetches. The UI surfaces it; the user
     edits the query and confirms; only then does fetchPage() run.
     ============================================================ */
  function buildFetchProposal(p) {
    p = p || {};
    return {
      kind: 'fetch-proposal',
      target_claim_id: String(p.target_claim_id || ''),
      suggested_query: String(p.suggested_query || ''),
      rationale: String(p.rationale || ''),
    };
  }

  /* ============================================================
     Persistence — thin wrappers over the store's web-source helpers (store.js).
     Defensive: a storage failure degrades to no-op, never throws into a fetch.
     The content-hash index lets a re-paste of the same URL find the frozen
     record and pay no network (parity with external.js's freeze cache).
     ============================================================ */
  async function saveRecord(record) {
    const st = _store();
    if (st && st.saveWebSource) return st.saveWebSource(record);
    return false;
  }
  async function loadRecords() {
    const st = _store();
    if (st && st.loadWebSources) { const r = await st.loadWebSources(); return Array.isArray(r) ? r : []; }
    return [];
  }
  async function findByHash(contentHash) {
    const st = _store();
    if (st && st.findWebSourceByHash) return st.findWebSourceByHash(contentHash);
    const all = await loadRecords();
    return all.find(r => r && r.content_hash === contentHash) || null;
  }
  function activeCount(records) {
    return (records || []).filter(r => r && r.status === 'active').length;
  }
  // The soft cap (spec §14): a warning, not a hard limit. Returns a notice string
  // when the active count is at/over the cap, else null.
  function capNotice(records) {
    const n = activeCount(records);
    if (n >= config.activeCap) {
      return n + ' active web sources in scope (soft cap ' + config.activeCap
        + '). More sources widen retrieval noise; consider retracting stale ones.';
    }
    return null;
  }

  const api = {
    RECORD_SCHEMA, FETCH_SCHEMA, CITATION_TYPE, PROXY_ID,
    setConfig, cfg, enabled, costNotice,
    search, fetchPage,
    toRecord, admit, engineDocId, recordForDocId,
    toWebCitation, verifyCitation, spanOfTokens, segmentText,
    isStale, supersede, retract, buildFetchProposal,
    saveRecord, loadRecords, findByHash, activeCount, capNotice,
  };
  if (typeof window !== 'undefined') window.EOWebSource = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
