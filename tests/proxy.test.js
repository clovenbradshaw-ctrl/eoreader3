/* ============================================================
   tests/proxy.test.js — the cleon-search-proxy contract (spec §4).

   The proxy's pure helpers (sha256, normalise, result mapping, CORS/bearer
   guards, size cap, robots) carry no heavy dependency and are unit-tested here.
   The HTTP layer (routing, CORS allowlist, bearer gate, /search mapping) is
   exercised against a live server on an ephemeral port with an INJECTED upstream
   fetch — no real network, no SearXNG. The /fetch readability path lazy-requires
   @mozilla/readability + jsdom; we assert the graceful NO_READABILITY contract
   when they are absent.

   Run with `node tests/proxy.test.js`.
   ============================================================ */
'use strict';
const P = require('../proxy/cleon-search-proxy.js');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name) { console.log('• ' + name); }

async function main() {
  group('sha256 — deterministic, prefixed, content-keyed');
  eq(P.sha256('hello'), P.sha256('hello'), 'same text → same hash');
  ok(P.sha256('hello') !== P.sha256('hellp'), 'different text → different hash');
  ok(/^sha256-[0-9a-f]{64}$/.test(P.sha256('x')), 'hash is sha256-<64 hex>');

  group('normaliseText — stable whitespace canonicalisation');
  eq(P.normaliseText('  a\r\n\r\n\r\n b   c \t d  '), 'a\n\nb c d', 'collapses runs, trims, caps blank lines');
  eq(P.sha256(P.normaliseText('a  b')), P.sha256(P.normaliseText('a\tb')), 'normalisation makes the hash robust to spacing');

  group('buildSearxngUrl — JSON format, engine allow-list');
  const su = P.buildSearxngUrl('http://sx:8080', 'who financed the bridge', ['bing', 'duckduckgo']);
  ok(su.indexOf('format=json') !== -1, 'requests JSON output');
  ok(su.indexOf('engines=bing%2Cduckduckgo') !== -1, 'forwards the engine allow-list');
  ok(/q=who\+financed|q=who%20financed/.test(su), 'encodes the query');

  group('mapSearchResults — SearXNG payload → discovery rows');
  const mapped = P.mapSearchResults({ results: [
    { title: 'A', url: 'http://a', content: 'snip', engines: ['bing'], score: 0.7 },
    { title: 'B', url: '', content: 'no url' },
    { title: 'C', url: 'http://c', snippet: 'alt' },
  ] }, 8);
  eq(mapped.length, 2, 'rows without a url are dropped');
  eq(mapped[0].snippet, 'snip', 'content maps to snippet');
  eq(mapped[0].engine, 'bing', 'engines[0] maps to engine');
  eq(mapped[1].snippet, 'alt', 'falls back to snippet field');
  eq(P.mapSearchResults({ results: [1, 2, 3].map(i => ({ title: '' + i, url: 'http://' + i })) }, 2).length, 2, 'respects max_results');

  group('corsHeaders — allowlist restricted to the Cleo origin (§4.3)');
  ok(P.corsHeaders('https://cleo.test', ['https://cleo.test']).ok, 'an allow-listed origin passes');
  ok(!P.corsHeaders('https://evil.test', ['https://cleo.test']).ok, 'an unknown origin is rejected');
  eq(P.corsHeaders('https://cleo.test', ['https://cleo.test']).headers['Access-Control-Allow-Origin'], 'https://cleo.test', 'echoes the exact origin');
  ok(P.corsHeaders('https://anything', ['*']).ok, "'*' opens it (dev only)");

  group('checkBearer — optional shared token, custody on the server (§4.3)');
  ok(P.checkBearer('', '') === true, 'no token configured → gate open');
  ok(P.checkBearer('Bearer s3cret', 's3cret') === true, 'matching bearer passes');
  ok(P.checkBearer('Bearer wrong', 's3cret') === false, 'mismatched bearer fails');
  ok(P.checkBearer('', 's3cret') === false, 'missing bearer when one is required fails');

  group('withinSizeCap — the hard 2 MB cap (§4.2)');
  ok(P.withinSizeCap(1000, 2048) === true, 'under the cap is fine');
  ok(P.withinSizeCap(4096, 2048) === false, 'over the cap is rejected');

  group('robotsAllows — conservative robots respect (§4.3)');
  ok(P.robotsAllows('User-agent: *\nDisallow: /private', '/private/page', 'CleoWebSource') === false, 'a matching Disallow denies');
  ok(P.robotsAllows('User-agent: *\nDisallow: /private', '/public/page', 'CleoWebSource') === true, 'an unrelated path is allowed');
  ok(P.robotsAllows('', '/anything', 'CleoWebSource') === true, 'absent robots → allow');

  group('extractReadable — graceful when the deps are absent');
  let threwNoDeps = false, extracted = null;
  try { extracted = P.extractReadable('<html><body><article><p>Hello world.</p></article></body></html>', 'http://x'); }
  catch (e) { threwNoDeps = (e.code === 'NO_READABILITY'); }
  ok(threwNoDeps || (extracted && /Hello world/.test(extracted.text)), 'either extracts (deps present) or throws NO_READABILITY (deps absent) — never a hard crash');

  group('HTTP layer — routing, CORS, bearer, /search mapping (live server, injected upstream)');
  const upstream = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ results: [{ title: 'Greenfield', url: 'http://x/1', content: 'restoration', engines: ['bing'], score: 0.9 }] }),
    headers: { get: () => '' },
  });
  const { server } = P.createServer({ port: 0, allowOrigins: ['https://cleo.test'], bearer: 'tok', fetchImpl: upstream });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const hdr = (extra) => Object.assign({ 'content-type': 'application/json', origin: 'https://cleo.test' }, extra || {});

  try {
    let r = await fetch(base + '/search', { method: 'POST', headers: hdr({ authorization: 'Bearer tok' }), body: JSON.stringify({ q: 'bridge' }) });
    let j = await r.json();
    eq(r.status, 200, 'an allowed, authed /search returns 200');
    eq(j.results.length, 1, 'and maps the upstream results');
    eq(r.headers.get('access-control-allow-origin'), 'https://cleo.test', 'CORS echoes the Cleo origin');

    r = await fetch(base + '/search', { method: 'POST', headers: hdr({ authorization: 'Bearer nope' }), body: JSON.stringify({ q: 'bridge' }) });
    eq(r.status, 401, 'a bad bearer is rejected');

    r = await fetch(base + '/search', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test', authorization: 'Bearer tok' }, body: '{}' });
    eq(r.status, 403, 'a disallowed origin is rejected');

    r = await fetch(base + '/search', { method: 'OPTIONS', headers: hdr({}) });
    eq(r.status, 204, 'preflight from an allowed origin returns 204');

    r = await fetch(base + '/search', { method: 'GET', headers: hdr({ authorization: 'Bearer tok' }) });
    eq(r.status, 405, 'a non-POST method is rejected');
  } finally {
    await new Promise(r => server.close(r));
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — cleon-search-proxy: ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
