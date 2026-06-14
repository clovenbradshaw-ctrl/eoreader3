/* ============================================================
   tests/websource.test.js — web sources as first-class groundable sources.

   websource.js is pure transport + policy (no React): the proxy fetch, the
   clock, the store, the audit recorder and the reading engine are all
   injectable, so we exercise it with fakes + the REAL engine loaded into a VM
   (evo/engine-host), and assert the spec's falsifiable acceptance criteria
   (§13) that live at this layer:

     • grounding parity  — a web source is grounded and cited like an uploaded doc
     • veto parity       — a fabricated claim about it is rejected
     • chat isolation    — no search/fetch ever fires from the chat path
     • explicit cost     — a fetch requires confirmation; the notice names the leak
     • staleness         — a re-fetch with a new hash supersedes, never overwrites
     • retraction        — status flips, dependents re-fire, the touch is legible
     • provenance        — every web citation resolves to a record whose hash matches

   Run with `node tests/websource.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEngine } = require('../evo/engine-host');

const ROOT = path.resolve(__dirname, '..');
const WS = require('../websource.js');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name) { console.log('• ' + name); }
async function throws(fn, pred, msg) {
  try { await fn(); ok(false, msg + ' (did not throw)'); }
  catch (e) { ok(pred ? pred(e) : true, msg + (pred ? '' : '')); }
}

/* ---- a real EOAudit, loaded the way audit.test.js loads it ---- */
function loadAudit() {
  const sandbox = { window: {}, console }; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'audit.js'), 'utf8'), sandbox, { filename: 'audit.js' });
  return sandbox.window.EOAudit;
}

/* ---- a Map-backed store implementing the web-source helpers store.js adds ---- */
function fakeStore() {
  const m = new Map();
  return {
    async loadWebSources() { return [...m.values()]; },
    async saveWebSources(list) { m.clear(); for (const r of list) m.set(r.id, r); return true; },
    async saveWebSource(r) { if (!r || !r.id) return false; m.set(r.id, r); return true; },
    async findWebSourceByHash(h) { for (const r of m.values()) if (r.content_hash === h) return r; return null; },
    _map: m,
  };
}

/* ---- a fake proxy: records every call, answers /search and /fetch from a
   table the test controls. Mirrors the cleon-search-proxy contract (§4). ---- */
function fakeProxy(routes) {
  const calls = [];
  async function f(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body, headers: (init && init.headers) || {} });
    const key = url.replace(/^.*(\/search|\/fetch).*$/, '$1');
    const r = routes[key];
    const out = typeof r === 'function' ? r(body) : r;
    return {
      ok: out.ok !== false, status: out.status || 200,
      json: async () => out.json,
    };
  }
  return { f, calls };
}

// One canned page with a DISTINCTIVE fact answerable only from it.
const PAGE = {
  url: 'https://example.org/greenfield',
  final_url: 'https://example.org/greenfield',
  title: 'The Greenfield Bridge Restoration',
  byline: 'A. Writer', excerpt: 'How a 1987 restoration was financed.',
  text: 'The Greenfield Bridge had fallen into disrepair by the 1980s. '
      + 'The Zorblatt Foundation financed the Greenfield Bridge restoration in 1987. '
      + 'The work was completed two years later.',
  content_hash: 'sha256-aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
  http_status: 200, content_type: 'text/html',
  fetched_at: '2026-06-14T00:00:00Z', retrieval_query: 'who financed greenfield bridge', engine: 'bing',
};

async function main() {
  const W = loadEngine();
  const E = W.EOEngine;
  const A = loadAudit();
  const store = fakeStore();
  const proxy = fakeProxy({
    '/search': (b) => ({ json: {
      query: b.q, fetched_at: '2026-06-14T00:00:00Z',
      results: [
        { title: 'Greenfield Bridge', url: PAGE.url, snippet: 'restoration financed in 1987', engine: 'bing', score: 0.9 },
        { title: 'Other', url: 'https://x.test/2', snippet: 'unrelated', engine: 'duckduckgo', score: 0.3 },
      ],
    } }),
    '/fetch': (b) => ({ json: Object.assign({}, PAGE, { retrieval_query: b.retrieval_query, engine: b.engine }) }),
  });

  WS.setConfig({
    proxy: 'https://proxy.test/api', bearer: 'secret-token',
    fetchImpl: proxy.f, store, audit: A, engine: E,
    now: () => new Date('2026-06-14T00:00:00Z'),
  });

  // ---------------------------------------------------------------- DISCOVERY
  group('search() — discovery lists candidates and logs a cleo-fetch/1 record');
  A.clear();
  const res = await WS.search('who financed greenfield bridge', { engines: ['bing', 'duckduckgo'], max_results: 5 });
  eq(res.results.length, 2, 'two normalized results returned');
  eq(res.results[0].url, PAGE.url, 'first result carries its url');
  eq(proxy.calls[0].body.max_results, 5, 'max_results forwarded to the proxy');
  ok(proxy.calls[0].headers.authorization === 'Bearer secret-token', 'bearer token attached (custody on the proxy, never in data)');
  const flog = A.fetchLog();
  eq(flog.length, 1, 'one fetch-log record written');
  eq(flog[0].schema, 'cleo-fetch/1', 'record carries the cleo-fetch/1 schema');
  eq(flog[0].action, 'search', 'action is search');
  eq(flog[0].triggered_by, 'deep-read', 'discovery defaults triggered_by to deep-read, never chat');
  eq(flog[0].result_count, 2, 'result_count logged');

  group('costNotice() — names the privacy leak the user is consenting to (§11/§13.4)');
  const notice = WS.costNotice('greenfield bridge');
  ok(/public search engines/i.test(notice) && /query/i.test(notice), 'notice states the query reaches public engines');

  // ----------------------------------------------------------------- COMMIT
  group('fetchPage() — refuses to fire without explicit confirmation (§13.4)');
  const before = proxy.calls.length;
  await throws(() => WS.fetchPage(PAGE.url, { retrieval_query: 'q' }),
    (e) => e.costRequired === true && /public search engines/i.test(e.notice || ''),
    'an unconfirmed fetch throws costRequired and fires NO network');
  eq(proxy.calls.length, before, 'no network call was made for the unconfirmed fetch');

  group('fetchPage() — a confirmed fetch commits and logs a cleo-fetch/1 record');
  A.clearFetches();
  const payload = await WS.fetchPage(PAGE.url, { confirmed: true, retrieval_query: 'who financed greenfield bridge', engine: 'bing' });
  eq(payload.content_hash, PAGE.content_hash, 'proxy payload returned verbatim (we compute nothing it computed)');
  const f2 = A.fetchLog();
  eq(f2[0].action, 'fetch', 'fetch action logged');
  eq(f2[0].content_hash, PAGE.content_hash, 'fetch record carries the content hash');
  eq(f2[0].triggered_by, 'user-action', 'a confirmed fetch is user-action, never chat');

  // ------------------------------------------------------------ CHAT ISOLATION
  group('chat isolation — no search/fetch ever fires from the chat path (§13.3)');
  A.clearFetches();
  const callsBeforeChat = proxy.calls.length;
  await throws(() => WS.search('anything', { triggered_by: 'chat' }), (e) => e.chatIsolation === true,
    'search from the chat path is refused');
  await throws(() => WS.fetchPage(PAGE.url, { confirmed: true, triggered_by: 'chat' }), (e) => e.chatIsolation === true,
    'fetch from the chat path is refused');
  eq(proxy.calls.length, callsBeforeChat, 'NO network call fired from the chat path under any phrasing');
  eq(A.fetchLog().length, 0, 'and no cleo-fetch/1 record was written for a chat trigger');
  eq(A.recordFetch({ action: 'fetch', triggered_by: 'chat' }), null, 'the recorder itself refuses a chat-triggered record');

  // ------------------------------------------------------------- NORMALIZATION
  group('toRecord() — a /fetch payload becomes a web-source/1 record (§5.1)');
  const rec = WS.toRecord(payload);
  eq(rec.schema, 'web-source/1', 'schema stamped');
  eq(rec.kind, 'web-source', 'kind is web-source');
  eq(rec.id, 'web:' + PAGE.content_hash.replace(/^sha256-/, '').slice(0, 16), 'id is web:<first 16 hex of content_hash> (§5.1)');
  eq(rec.status, 'active', 'a fresh record is active');
  eq(rec.content_hash, PAGE.content_hash, 'content hash carried from the proxy, not recomputed');
  await throws(() => WS.toRecord({ text: 'x' }), (e) => e.badPayload === true, 'a payload with no content_hash is refused (never admit unprovenanced text)');

  group('engine doc id is colon-free so citation markers parse (chat.jsx split on ":")');
  ok(WS.engineDocId(rec).indexOf(':') === -1, 'engineDocId() strips the colon');
  ok(WS.recordForDocId(WS.engineDocId(rec), [rec]) === rec, 'recordForDocId() reverses the mapping');

  // ---------------------------------------------------------------- ADMISSION
  group('admit() — a web source travels the identical document pipeline (§5.2)');
  const { record, doc } = await WS.admit(payload);
  eq(doc.kind, 'prose', 'the ENGINE doc is prose — the ~20 prose-gated engine paths run unchanged');
  eq(doc.sourceKind, 'web-source', 'the web identity rides as additive provenance metadata');
  eq(doc.web.content_hash, PAGE.content_hash, 'provenance carried onto the engine doc');
  ok(doc.id.indexOf(':') === -1, 'engine doc id is colon-free');
  ok(record.segments.length >= 2, 'the record is segmented by the engine document segmenter (abbreviation-rejoin, §5.2.1)');
  ok((await store.findWebSourceByHash(PAGE.content_hash)), 'the record was frozen to the store (re-paste pays no network)');
  const ents = (E.projectEntities(doc).entities || []).map(e => e.name.toLowerCase());
  ok(ents.some(n => /zorblatt|greenfield|foundation/.test(n)), 'the web source mints real entities: ' + JSON.stringify(ents.slice(0, 6)));

  // ------------------------------------------------------- GROUNDING PARITY §13.1
  group('grounding parity — an answer from the web source cites it with a real char_span (§13.1, §13.9)');
  const answerText = 'The Zorblatt Foundation financed the Greenfield Bridge restoration.';
  const bound = E.bindCitations(doc, answerText, 'who financed the greenfield bridge restoration', 'factual');
  ok(bound.cites.length >= 1, 'the claim grounded against the web source: ' + JSON.stringify(bound.cites));
  ok(bound.audit.grounded === true, 'the binder reports grounded');
  const cite = bound.cites[0];
  const segText = doc.sentenceTexts[cite.idx];
  const bindingTokens = ['Zorblatt', 'Foundation', 'Greenfield', 'Bridge'];
  const webCite = WS.toWebCitation(record, cite.idx, segText, bindingTokens);
  eq(webCite.type, 'web-source', 'the citation type is web-source (§6)');
  eq(webCite.source_id, record.id, 'it resolves to the web-source record id');
  eq(webCite.content_hash, record.content_hash, 'provenance integrity: citation hash === record hash (§13.9)');
  ok(Array.isArray(webCite.char_span) && webCite.char_span[1] > webCite.char_span[0], 'a real char_span');
  const spanText = segText.slice(webCite.char_span[0], webCite.char_span[1]).toLowerCase();
  ok(bindingTokens.every(t => spanText.indexOf(t.toLowerCase()) !== -1), 'the char_span contains the binding tokens: "' + spanText + '"');
  eq(WS.verifyCitation(webCite, record, bindingTokens).ok, true, 'the web-source veto passes the honest citation');

  // ----------------------------------------------------------- VETO PARITY §13.2
  group('veto parity — a fabricated claim about the web source is rejected (§13.2)');
  const fabricated = 'Dragons guarded the lunar vault every Tuesday.';
  const vetoed = E.bindCitations(doc, fabricated, 'who financed the greenfield bridge restoration', 'factual');
  eq(vetoed.cites.length, 0, 'a fully off-page fabrication binds to nothing');
  eq(vetoed.audit.grounded, false, 'and is reported ungrounded');
  // the web-source-specific veto: a citation whose span omits the binding tokens fails
  const badCite = WS.toWebCitation(record, cite.idx, segText, []);
  eq(WS.verifyCitation(badCite, record, ['dragons', 'lunar']).ok, false, 'verifyCitation rejects a span missing the binding tokens');

  // ------------------------------------------------------------- STALENESS §13.7
  group('staleness — a re-fetch with a new hash supersedes, never overwrites (§13.7, §8)');
  ok(WS.isStale(webCite, record) === false, 'a fresh citation is not stale');
  const mutated = Object.assign({}, PAGE, { text: PAGE.text + ' A later editor changed the funder to the Acme Trust.', content_hash: 'sha256-9999000011112222333344445555666677778888999900001111222233334444' });
  const sup = await WS.supersede(record, mutated, { citations: [webCite] });
  ok(sup.newRecord.id !== record.id, 'a new record with a new id is created (not an overwrite)');
  eq(sup.superseded.status, 'superseded', 'the old record is retained as superseded (audit trail)');
  eq(sup.refire.length, 1, 'the citation bound to the old hash is marked to re-fire');
  ok(WS.isStale(webCite, sup.newRecord) === true, 'the old citation is now stale against the new record');
  eq(WS.verifyCitation(webCite, sup.newRecord).ok, false, 'and the veto rejects the stale grounding (hash mismatch)');
  const unchanged = await WS.supersede(record, Object.assign({}, PAGE), { citations: [webCite] });
  eq(unchanged.unchanged, true, 'a re-fetch with the SAME hash supersedes nothing');

  // ------------------------------------------------------------ RETRACTION §13.8
  group('retraction — status flips, dependents re-fire, the touch is legible (§13.8, §9)');
  const rec2 = WS.toRecord(payload);   // a fresh, active record (same id, status active)
  A.clear();
  A.begin({ input: 'retract greenfield' });
  const ret = await WS.retract(rec2, { citations: [webCite] });
  A.end({ engine: 'none' });
  eq(ret.record.status, 'retracted', 'the source is retracted');
  eq(ret.refire.length, 1, 'the grounding it supplied re-fires');
  eq(ret.removeFromScope, rec2.id, 'the source is signalled for removal from retrieval scope');
  eq(WS.verifyCitation(webCite, rec2, bindingTokens).ok, false, 'a citation into a retracted source no longer verifies');
  const steps = (A.all()[0] && A.all()[0].steps) || [];
  ok(steps.some(s => s.t === 'web-retract'), 'the retraction is recorded as a glass-box step (legible, not silent)');

  // -------------------------------------------------------------- THE PROPOSER §7
  group('the proposer — the model proposes a query; it never fetches (§7.1)');
  const prop = WS.buildFetchProposal({ target_claim_id: 'c12', suggested_query: 'greenfield bridge funding', rationale: 'unanswerable from the frame' });
  eq(prop.kind, 'fetch-proposal', 'a fetch-proposal is shaped');
  eq(prop.suggested_query, 'greenfield bridge funding', 'it carries the suggested query the user can edit');

  group('soft cap — a warning, not a hard limit (§14)');
  WS.setConfig({ activeCap: 1 });
  ok(/soft cap/.test(WS.capNotice([{ status: 'active' }, { status: 'active' }]) || ''), 'over the soft cap yields a warning');
  eq(WS.capNotice([{ status: 'retracted' }]), null, 'retracted sources do not count toward the cap');
  WS.setConfig({ activeCap: 24 });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — websource.js: ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
