/* ============================================================
   cleon-search-proxy.js — the server-side half of the web-source function.

   A browser-only app cannot fetch arbitrary cross-origin pages (CORS) and
   cannot hold a search credential without exposing it. Both problems live on
   the server; nothing else moves server-side. This is the ONLY networked
   component, and it is stateless by design — no query is persisted.

   Two endpoints (spec §4), separating DISCOVERY from COMMITMENT so the user
   admits specific results rather than a bulk dump:

     POST /search  { q, max_results, engines }
        → self-hosted SearXNG JSON API (/search?format=json). Maps results.
          Does NOT fetch page bodies. Cheap.
     POST /fetch   { url, retrieval_query, engine }
        → server-side GET (sane UA, hard size cap, follow redirects, record the
          final URL), @mozilla/readability extraction over jsdom, whitespace
          normalisation, sha256 over the normalised text. The committing act.

   Security (spec §4.3): credentials live only here; CORS is restricted to the
   Cleo origin and additionally gated by an optional shared bearer token; no
   request logging retains query text; robots and a per-host rate limit are
   respected; concurrent fetches are capped.

   Design note: the PURE helpers (sha256, normaliseText, mapSearchResults,
   buildSearxngUrl, cors/bearer guards, size cap) carry no heavy dependency and
   are exported for unit tests. The readability extraction lazy-requires
   @mozilla/readability + jsdom only when /fetch actually runs, so the module
   loads (and is testable) without them installed.

   Run:  SEARXNG_URL=http://127.0.0.1:8080 ALLOW_ORIGINS=https://cleo.example \
         BEARER_TOKEN=… node proxy/cleon-search-proxy.js
   ============================================================ */
'use strict';

const http = require('http');
const crypto = require('crypto');

/* ---------------------------------------------------------------- pure helpers */

// sha256-hex over a string (the content hash the browser trusts and never
// recomputes). Prefixed so the algorithm is legible in the record.
function sha256(text) {
  return 'sha256-' + crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

// Collapse runs of whitespace, normalise newlines, trim — the canonical text the
// hash is computed over and the engine segments. Stable across re-fetches of the
// same bytes, so an unchanged page yields an identical hash.
function normaliseText(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

// Build the SearXNG JSON query URL. engines is an allow-list of upstream engines
// (bing, duckduckgo — reddit & friends rate-limit a single IP, spec §4.1).
function buildSearxngUrl(base, q, engines) {
  const u = new URL('/search', base.replace(/\/$/, '') + '/');
  u.searchParams.set('q', String(q || ''));
  u.searchParams.set('format', 'json');
  if (Array.isArray(engines) && engines.length) u.searchParams.set('engines', engines.join(','));
  return u.toString();
}

// Map the SearXNG JSON payload into the discovery result list (spec §4.1).
function mapSearchResults(searxng, max) {
  const rows = (searxng && Array.isArray(searxng.results)) ? searxng.results : [];
  const out = rows.slice(0, max || 8).map(r => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: String(r.content || r.snippet || ''),
    engine: String((Array.isArray(r.engines) && r.engines[0]) || r.engine || ''),
    score: typeof r.score === 'number' ? r.score : 0,
  })).filter(r => r.url);
  return out;
}

// CORS headers for an allow-listed origin. allow is a Set/array of exact origins;
// '*' opens it (dev only — the JSON endpoint is a free proxy if left open).
function corsHeaders(origin, allow) {
  const list = allow instanceof Set ? allow : new Set(allow || []);
  const ok = list.has('*') || (origin && list.has(origin));
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Vary': 'Origin',
  };
  if (ok) h['Access-Control-Allow-Origin'] = list.has('*') ? '*' : origin;
  return { ok, headers: h };
}

// Constant-time-ish bearer check. When no token is configured the gate is open
// (single-user / trusted-network deploys); when set, the header must match.
function checkBearer(authHeader, token) {
  if (!token) return true;
  const got = String(authHeader || '').replace(/^Bearer\s+/i, '');
  if (got.length !== token.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token)); }
  catch (e) { return false; }
}

// A page body is admissible only under the hard size cap (default 2 MB, spec §4.2).
function withinSizeCap(byteLength, cap) {
  const limit = cap || 2 * 1024 * 1024;
  return typeof byteLength === 'number' && byteLength >= 0 && byteLength <= limit;
}

// Minimal robots.txt check: does any applicable User-agent group Disallow the
// path? Conservative — an unparseable or absent robots is treated as allow, a
// matching Disallow as deny. (A full RFC 9309 implementation is the production
// hardening; this covers the common deny.)
function robotsAllows(robotsTxt, pathname, ua) {
  if (!robotsTxt) return true;
  const lines = String(robotsTxt).split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
  let applies = false, groupUA = false; const disallows = [];
  const star = []; let starActive = false;
  for (const line of lines) {
    const m = /^(user-agent|disallow|allow)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      groupUA = val === '*' || (ua && val && ua.toLowerCase().indexOf(val.toLowerCase()) !== -1);
      starActive = val === '*';
      applies = groupUA;
    } else if (key === 'disallow') {
      if (applies && val) disallows.push(val);
      if (starActive && val) star.push(val);
    }
  }
  const rules = disallows.length ? disallows : star;
  return !rules.some(p => pathname.indexOf(p) === 0);
}

/* ---------------------------------------------------------- readability (lazy) */

// Extract the readable article from raw HTML. Lazy-requires @mozilla/readability
// + jsdom so the module loads without them (the pure helpers stay testable).
// Strips scripts/styles/tracking before extraction. Returns { title, byline,
// excerpt, text } with text normalised.
function extractReadable(html, url) {
  let JSDOM, Readability;
  try { ({ JSDOM } = require('jsdom')); ({ Readability } = require('@mozilla/readability')); }
  catch (e) { const err = new Error('readability deps missing: ' + e.message); err.code = 'NO_READABILITY'; throw err; }
  const dom = new JSDOM(String(html || ''), { url: url || 'https://localhost/' });
  const doc = dom.window.document;
  doc.querySelectorAll('script, style, noscript, iframe, svg, [aria-hidden="true"]').forEach(n => n.remove());
  let article = null;
  try { article = new Readability(doc).parse(); } catch (e) { article = null; }
  const rawText = (article && article.textContent) || doc.body && doc.body.textContent || '';
  return {
    title: (article && article.title) || (doc.title || ''),
    byline: (article && article.byline) || null,
    excerpt: (article && article.excerpt) || null,
    text: normaliseText(rawText),
  };
}

/* --------------------------------------------------------------- the service */

function defaultConfig() {
  return {
    port: +(process.env.PORT || 8787),
    searxngUrl: process.env.SEARXNG_URL || 'http://127.0.0.1:8080',
    allowOrigins: (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    bearer: process.env.BEARER_TOKEN || '',
    maxBytes: +(process.env.MAX_BYTES || 2 * 1024 * 1024),
    userAgent: process.env.USER_AGENT || 'CleoWebSource/0.1 (+https://github.com/clovenbradshaw-ctrl/eoreader3)',
    fetchTimeoutMs: +(process.env.FETCH_TIMEOUT_MS || 15000),
    perHostIntervalMs: +(process.env.PER_HOST_INTERVAL_MS || 1000),
    maxConcurrentFetch: +(process.env.MAX_CONCURRENT_FETCH || 4),
    fetchImpl: null,   // injectable for tests; defaults to global fetch
  };
}

function readJSONBody(req, cap) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > (cap || 1 << 20)) { reject(new Error('request body too large')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function createServer(cfg) {
  const config = Object.assign(defaultConfig(), cfg || {});
  const allow = new Set(config.allowOrigins);
  const _fetch = config.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const lastHostHit = new Map();   // host → last fetch ms (per-host rate limit)
  let inFlight = 0;

  function sendJSON(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}));
    res.end(body);
  }

  async function handleSearch(body) {
    const q = String((body && body.q) || '').trim();
    if (!q) { const e = new Error('missing q'); e.http_status = 400; throw e; }
    const engines = (body && body.engines) || ['bing', 'duckduckgo'];
    const max = (body && body.max_results) || 8;
    const url = buildSearxngUrl(config.searxngUrl, q, engines);
    const res = await _fetch(url, { headers: { 'User-Agent': config.userAgent, 'Accept': 'application/json' } });
    if (!res.ok) { const e = new Error('searxng returned ' + res.status); e.http_status = 502; throw e; }
    const json = await res.json();
    return { query: q, fetched_at: new Date().toISOString(), results: mapSearchResults(json, max) };
  }

  async function handleFetch(body) {
    const target = String((body && body.url) || '').trim();
    if (!/^https?:\/\//i.test(target)) { const e = new Error('url must be http(s)'); e.http_status = 400; throw e; }
    const u = new URL(target);
    // per-host rate limit
    const last = lastHostHit.get(u.host) || 0;
    const wait = config.perHostIntervalMs - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastHostHit.set(u.host, Date.now());
    // robots
    try {
      const rRes = await _fetch(u.origin + '/robots.txt', { headers: { 'User-Agent': config.userAgent } });
      if (rRes.ok) { const txt = await rRes.text(); if (!robotsAllows(txt, u.pathname, config.userAgent)) { const e = new Error('blocked by robots.txt'); e.http_status = 403; throw e; } }
    } catch (e) { if (e.http_status === 403) throw e; /* robots fetch failure ⇒ allow */ }
    // the GET, redirect-following, with a timeout
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
    let res;
    try { res = await _fetch(target, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': config.userAgent, 'Accept': 'text/html,application/xhtml+xml' } }); }
    finally { clearTimeout(timer); }
    const contentType = res.headers.get ? (res.headers.get('content-type') || '') : '';
    const clen = res.headers.get ? +(res.headers.get('content-length') || 0) : 0;
    if (clen && !withinSizeCap(clen, config.maxBytes)) { const e = new Error('page exceeds size cap'); e.http_status = 413; throw e; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!withinSizeCap(buf.length, config.maxBytes)) { const e = new Error('page exceeds size cap'); e.http_status = 413; throw e; }
    const html = buf.toString('utf8');
    const article = extractReadable(html, res.url || target);
    return {
      url: target,
      final_url: res.url || target,
      title: article.title,
      byline: article.byline,
      excerpt: article.excerpt,
      text: article.text,
      content_hash: sha256(article.text),
      http_status: res.status,
      content_type: contentType,
      fetched_at: new Date().toISOString(),
      retrieval_query: String((body && body.retrieval_query) || ''),
      engine: String((body && body.engine) || ''),
    };
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const { ok: corsOk, headers: cors } = corsHeaders(origin, allow);
    if (req.method === 'OPTIONS') { res.writeHead(corsOk ? 204 : 403, cors); res.end(); return; }
    if (origin && !corsOk) { sendJSON(res, 403, { error: 'origin not allowed', http_status: 403 }, cors); return; }
    if (!checkBearer(req.headers.authorization, config.bearer)) { sendJSON(res, 401, { error: 'bad bearer token', http_status: 401 }, cors); return; }
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'method not allowed', http_status: 405 }, cors); return; }

    let body;
    try { body = await readJSONBody(req, 1 << 16); }
    catch (e) { sendJSON(res, 400, { error: 'bad request body', http_status: 400 }, cors); return; }

    try {
      if (req.url.startsWith('/search')) { sendJSON(res, 200, await handleSearch(body), cors); return; }
      if (req.url.startsWith('/fetch')) {
        if (inFlight >= config.maxConcurrentFetch) { sendJSON(res, 429, { error: 'too many concurrent fetches', http_status: 429 }, cors); return; }
        inFlight++;
        try { sendJSON(res, 200, await handleFetch(body), cors); }
        finally { inFlight--; }
        return;
      }
      sendJSON(res, 404, { error: 'not found', http_status: 404 }, cors);
    } catch (e) {
      const status = e.http_status || 500;
      // No query text in logs (spec §4.3): log status + path only.
      console.error('[cleon-search-proxy] ' + req.url + ' → ' + status + ' ' + (e.code || ''));
      sendJSON(res, status, { error: e.message || 'proxy error', http_status: status }, cors);
    }
  });

  return { server, config, handleSearch, handleFetch, listen: (cb) => server.listen(config.port, cb) };
}

// Run directly: node proxy/cleon-search-proxy.js
if (require.main === module) {
  const { listen, config } = createServer();
  listen(() => console.log('cleon-search-proxy listening on :' + config.port
    + ' → SearXNG ' + config.searxngUrl
    + ' | origins ' + (config.allowOrigins.join(', ') || '(none — set ALLOW_ORIGINS)')
    + ' | bearer ' + (config.bearer ? 'required' : 'OPEN (set BEARER_TOKEN)')));
}

module.exports = {
  sha256, normaliseText, buildSearxngUrl, mapSearchResults,
  corsHeaders, checkBearer, withinSizeCap, robotsAllows, extractReadable,
  createServer, defaultConfig,
};
