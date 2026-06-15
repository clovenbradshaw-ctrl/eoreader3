/* Verify the Wikipedia search modal (reference.jsx → window.WikiSearchModal):
   the composer button's destination. Mounts the REAL component through jsdom,
   driving the REAL external.js (with an injected fetch) so the whole path runs —
   live search (no Enter) → tag several articles → add them all to the graph,
   each rendered close to source with its citations pulled through. The renderer
   only runs in the browser, so this mirrors verify-markdown's harness. */
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
global.React = React; global.performance = window.performance; global.setTimeout = setTimeout;
global.DOMParser = window.DOMParser;            // external.js uses the browser parser when present
global.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom throws inside its focus-event machinery during a passive effect (the
// dialog's focus trap); focus isn't under test, so neutralise it for quiet output.
try { window.HTMLElement.prototype.focus = function () {}; } catch (_) {}

const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated/.test(s)) return; origErr.apply(console, a); };

/* ---- the only "world" this test sees: a canned Wikipedia API behind a fake
   fetch (the proxy passes ?url= through, same as external.test.js) ---- */
const ARTICLE_HTML = `<div class="mw-parser-output">
<table class="infobox"><caption>Article</caption><tr><td><img src="//upload.wikimedia.org/d.jpg"></td></tr></table>
<p><b>Subject</b> is an aquatic mammal.<sup class="reference"><a href="#cite_note-a-1">[1]</a></sup> It is widespread.<sup class="reference"><a href="#cite_note-b-2">[2]</a></sup></p>
<h2><span class="mw-headline">Diet</span><span class="mw-editsection">[edit]</span></h2>
<p>It eats fish and squid.<sup class="reference"><a href="#cite_note-c-3">[3]</a></sup></p>
<h2>References</h2>
<ol class="references">
<li id="cite_note-a-1"><cite>Smith (2020). <a class="external text" href="https://example.com/smith">smith</a></cite></li>
<li id="cite_note-b-2"><cite>Jones (2019). <a class="external text" href="https://bbc.co.uk/d">bbc</a></cite></li>
<li id="cite_note-c-3"><cite>Doe (2021). <a class="external text" href="https://nature.com/x">nature</a></cite></li>
</ol>
<div class="navbox">NAVBOX JUNK</div>
<script>danger()</script>
</div>`;
const searches = [];                            // every list=search term, to prove live search fired
async function fakeFetch(full) {
  const inner = decodeURIComponent(String(full).split('?url=')[1] || '');
  const ok = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });
  if (/list=search/.test(inner)) {
    const term = decodeURIComponent((/srsearch=([^&]+)/.exec(inner) || [])[1] || '');
    searches.push(term);
    return ok({ query: { search: [{ title: 'Dolphin', snippet: 'aquatic <span class="searchmatch">mammal</span>' }, { title: 'Porpoise', snippet: 'related cetacean' }] } });
  }
  if (/action=parse/.test(inner)) {
    const title = decodeURIComponent((/[?&]page=([^&]+)/.exec(inner) || [])[1] || 'Dolphin');
    return ok({ parse: { title, displaytitle: title, text: { '*': ARTICLE_HTML } } });
  }
  return { ok: false, status: 404, async text() { return 'nope'; } };
}

function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
run('external.js');
for (const f of ['icons.jsx', 'reference.jsx']) run(f);
const W = window;

const X = W.EOExternal;
const kv = {};
X.setConfig({ proxy: 'http://proxy.test/feed', fetchImpl: fakeFetch, store: { kvGet: async (k) => kv[k], kvPut: async (k, v) => { kv[k] = v; return true; } }, intervalMs: 1, maxRetries: 1 });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const click = (el) => TestUtils.act(() => { el.dispatchEvent(new W.Event('click', { bubbles: true })); });
const waitFor = async (fn, n = 60) => { for (let i = 0; i < n && !fn(); i++) await sleep(10); };

(async function main() {
  const root = document.getElementById('root');
  const client = ReactDOMClient.createRoot(root);
  const ingestCalls = [];
  const onIngest = (payload) => { ingestCalls.push(payload.title); return Promise.resolve({ id: 'doc-' + ingestCalls.length, name: 'Wikipedia · ' + payload.title }); };

  // open with no seed query — search must happen as you type, not on Enter
  await TestUtils.act(async () => { client.render(React.createElement(W.WikiSearchModal, { initialQuery: '', onClose: () => {}, onIngest, onOpenDoc: () => {} })); });
  ok(searches.length === 0, 'no search until the reader types (nothing leaves on open)');

  const input = root.querySelector('.wiki-search-input');
  ok(!!input, 'the search box is present');
  // type a query WITHOUT pressing Enter — the debounce should fire the search
  await TestUtils.act(async () => { TestUtils.Simulate.change(input, { target: { value: 'dolphin' } }); });
  await waitFor(() => searches.length > 0);
  ok(searches.includes('dolphin'), 'live search fires from typing alone (no Enter / button)');
  await waitFor(() => root.querySelectorAll('.wiki-opt-row').length >= 2);

  const rows = root.querySelectorAll('.wiki-opt-row');
  ok(rows.length >= 2, 'candidate articles are listed');
  const checks = root.querySelectorAll('.wiki-opt-check');
  ok(checks.length >= 2, 'each result has a tag checkbox');

  // tag BOTH candidates, then add them in one go
  await click(checks[0]);
  await click(checks[1]);
  await waitFor(() => /2\s*tagged/i.test(root.textContent), 30);
  ok(/2\s*tagged/i.test(root.textContent), 'tagging multiple articles accumulates a count');
  const addBtn = [...root.querySelectorAll('button')].find(b => /add 2 to graph/i.test(b.textContent));
  ok(!!addBtn, 'a single "Add 2 to graph" action ingests the whole tagged set');
  await click(addBtn);
  await waitFor(() => ingestCalls.length >= 2, 120);
  ok(ingestCalls.length === 2, 'both tagged articles are ingested');
  ok(ingestCalls.includes('Dolphin') && ingestCalls.includes('Porpoise'), 'each distinct article ingested once');

  // open one article: it renders close to source, sanitised, with its citations
  await waitFor(() => root.querySelectorAll('.wiki-option').length >= 1);
  await click(root.querySelector('.wiki-option'));
  await waitFor(() => !!root.querySelector('.wiki-article'));
  const article = root.querySelector('.wiki-article');
  ok(!!article, 'a tagged/opened article renders in the reader');
  ok(/aquatic mammal/.test(article.innerHTML), 'article body rendered from its own HTML');
  ok(article.innerHTML.indexOf('danger()') === -1, 'embedded <script> stripped before render');
  ok(article.innerHTML.indexOf('NAVBOX JUNK') === -1, 'navbox chrome dropped from the render');
  ok(/Wikipedia cites/i.test(root.textContent), 'the foot surfaces the sources Wikipedia cites');

  // the article we already ingested shows as added (deduped), not re-offered
  await waitFor(() => /Added/i.test(root.textContent), 30);
  ok(/Added/i.test(root.textContent), 'an already-ingested article reads as added');

  await TestUtils.act(async () => { client.unmount(); });
  console.log(`\n${fail ? '✗' : 'PASS —'} Wikipedia search modal: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
