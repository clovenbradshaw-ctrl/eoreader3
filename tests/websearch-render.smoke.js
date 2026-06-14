/* Smoke: mount the REAL WebSearchPanel (websearch.jsx) over a FAKE
   window.EOWebSource and drive the discovery → cost-confirm → fetch → ingest
   flow, asserting it renders and behaves without throwing. Runs the client
   component through jsdom, like eomri-render.smoke.js. The network/admission is
   the fake; this verifies the UI wiring (the part Node can't reach through
   websource.test.js). Run with `node tests/websearch-render.smoke.js`. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://example.com/' });
const { window } = dom;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
try { Object.defineProperty(window, 'performance', { value: { now: () => Date.now() }, configurable: true }); } catch (_) {}

const React = require('react');
const ReactDOMClient = require('react-dom/client');
const TestUtils = require('react-dom/test-utils');
window.React = React;
global.window = window; global.document = window.document;
try { Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true }); } catch (_) {}
global.React = React; global.performance = window.performance;
global.setTimeout = setTimeout; global.clearTimeout = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
const origErr = console.error;
// Filter known jsdom/React-in-Node artifacts: act() warnings, and the
// `activeElement.attachEvent` restore-path TypeError React throws when it
// re-syncs a controlled input under jsdom (harmless — no assertion depends on it).
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated|attachEvent/.test(s)) return; origErr.apply(console, a); };

function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
for (const f of ['icons.jsx', 'websearch.jsx']) run(f);
const W = window;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } };
const tick = () => new Promise(r => setTimeout(r, 0));

// A fake EOWebSource: records calls, answers from a fixed table. NO network.
const calls = { search: 0, fetch: [] };
let ingested = null;
W.EOWebSource = {
  enabled: () => true,
  costNotice: (q) => 'This sends “' + (q || '') + '” through your proxy to public search engines, which see the query text.',
  async search(q) { calls.search++; return { query: q, results: [
    { title: 'Greenfield Bridge', url: 'https://example.org/greenfield', snippet: 'restoration financed in 1987', engine: 'bing', score: 0.9 },
  ] }; },
  async fetchPage(url, opts) {
    if (opts.confirmed !== true) { const e = new Error('costRequired'); e.costRequired = true; throw e; }
    calls.fetch.push({ url, opts });
    return { url, final_url: url, title: 'Greenfield Bridge', text: 'The Zorblatt Foundation financed it.', content_hash: 'sha256-abc', fetched_at: '2026-06-14T00:00:00Z', retrieval_query: opts.retrieval_query, engine: opts.engine };
  },
};

const container = W.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
const onIngest = async (payload) => { ingested = payload; };

async function main() {
  let threw = null;
  try { TestUtils.act(() => { root.render(React.createElement(W.WebSearchPanel, { onClose() {}, onIngest, onToast() {} })); }); }
  catch (e) { threw = e; }
  ok(!threw, 'WebSearchPanel mounts without throwing' + (threw ? ' — ' + threw.message : ''));
  ok(/Add a web source/.test(container.textContent || ''), 'the panel chrome rendered');
  ok(/public search engines/.test(container.textContent || ''), 'the cost notice (query reaches public engines) is shown up front');

  // Drive the flow through TestUtils.Simulate, which invokes React's own
  // handlers directly — robust across jsdom's native-event quirks.
  const input = container.querySelector('input');
  ok(!!input, 'a search input is present (proxy configured → ready state)');
  await TestUtils.act(async () => { TestUtils.Simulate.change(input, { target: { value: 'who financed greenfield bridge' } }); });
  await TestUtils.act(async () => { TestUtils.Simulate.submit(container.querySelector('form.ws-search')); await tick(); });
  ok(calls.search === 1, 'submitting the form called EOWebSource.search once');
  ok(/Greenfield Bridge/.test(container.textContent || ''), 'the result is rendered');

  // clicking "Add as source" must NOT fetch — it opens the cost confirmation first
  const addBtn = [...container.querySelectorAll('button')].find(b => /Add as source/.test(b.textContent));
  ok(!!addBtn, 'an "Add as source" button is present');
  await TestUtils.act(async () => { TestUtils.Simulate.click(addBtn); await tick(); });
  ok(calls.fetch.length === 0, 'clicking Add fires NO fetch — confirmation is required first (explicit cost)');
  ok(/Fetch this page now\?/.test(container.textContent || ''), 'the cost confirmation is shown before fetching');

  // confirm → fetch + ingest
  const confirmBtn = [...container.querySelectorAll('button')].find(b => /Confirm & fetch/.test(b.textContent));
  ok(!!confirmBtn, 'a Confirm & fetch button is present');
  await TestUtils.act(async () => { TestUtils.Simulate.click(confirmBtn); await tick(); });
  ok(calls.fetch.length === 1, 'confirming fired exactly one fetch');
  ok(calls.fetch[0].opts.confirmed === true, 'the fetch was made with confirmed:true');
  ok(ingested && ingested.content_hash === 'sha256-abc', 'the fetched payload was handed to onIngest (admission)');
  ok(/Added as source/.test(container.textContent || ''), 'the result shows it was added');

  TestUtils.act(() => { root.unmount(); });

  // the OFF state: no proxy → a self-documenting panel, not a hidden feature
  W.EOWebSource.enabled = () => false;
  const c2 = W.document.createElement('div'); W.document.body.appendChild(c2);
  const r2 = ReactDOMClient.createRoot(c2);
  let offThrew = null;
  try { TestUtils.act(() => { r2.render(React.createElement(W.WebSearchPanel, { onClose() {}, onIngest, onToast() {} })); }); }
  catch (e) { offThrew = e; }
  ok(!offThrew, 'the off-state renders without throwing');
  ok(/EO_SEARCH_PROXY/.test(c2.textContent || ''), 'the off-state tells the user how to enable it (EO_SEARCH_PROXY)');
  TestUtils.act(() => { r2.unmount(); });

  console.log(`\nwebsearch-render: ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
