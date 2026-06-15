/* Verify the Wikipedia search modal (reference.jsx → window.WikiSearchModal):
   the composer button's / "/wikipedia" destination. Mounts the REAL component
   through jsdom on the REAL external.js (injected fetch), exercising the whole
   path — suggestion chips → live search (no Enter) → rich rows with thumbnails →
   inline preview → add several articles as sources, each pulling its citations
   through. The renderer only runs in the browser, so this mirrors verify-markdown. */
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
global.DOMParser = window.DOMParser;
global.IS_REACT_ACT_ENVIRONMENT = true;
try { window.HTMLElement.prototype.focus = function () {}; } catch (_) {}   // jsdom focus throws in a passive effect; not under test

const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated/.test(s)) return; origErr.apply(console, a); };

/* ---- canned Wikipedia API behind a fake fetch (proxy passes ?url= through) ---- */
const ARTICLE_HTML = `<div class="mw-parser-output">
<p><b>Subject</b> is a thing.<sup class="reference"><a href="#cite_note-a-1">[1]</a></sup> It is notable.<sup class="reference"><a href="#cite_note-b-2">[2]</a></sup></p>
<h2>References</h2>
<ol class="references">
<li id="cite_note-a-1"><cite>Smith (2020). <a class="external text" href="https://example.com/s">s</a></cite></li>
<li id="cite_note-b-2"><cite>Jones (2019). <a class="external text" href="https://bbc.co.uk/d">b</a></cite></li>
</ol></div>`;
const searches = [];                            // every generator=search term (proves live search fired)
async function fakeFetch(full) {
  const inner = decodeURIComponent(String(full).split('?url=')[1] || '');
  const ok = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });
  if (/generator=search/.test(inner)) {
    searches.push(decodeURIComponent((/gsrsearch=([^&]+)/.exec(inner) || [])[1] || ''));
    return ok({ query: { pages: {
      '12': { pageid: 12, index: 1, title: 'Dolphin', description: 'aquatic mammal', extract: 'Dolphins are aquatic mammals. They are widespread.', thumbnail: { source: 'https://upload.wikimedia.org/d.jpg' } },
      '34': { pageid: 34, index: 2, title: 'Porpoise', description: 'related cetacean', extract: 'A porpoise is a small toothed whale.' },
    } } });
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
const waitFor = async (fn, n = 80) => { for (let i = 0; i < n && !fn(); i++) await sleep(10); };

(async function main() {
  const root = document.getElementById('root');
  const client = ReactDOMClient.createRoot(root);
  const ingestCalls = [];
  const onIngest = (payload) => { ingestCalls.push({ title: payload.title, refs: (payload.references || []).length }); return Promise.resolve({ id: 'doc-' + ingestCalls.length, name: 'Wikipedia · ' + payload.title }); };

  await TestUtils.act(async () => { client.render(React.createElement(W.WikiSearchModal, { initialQuery: '', onClose: () => {}, onIngest })); });
  ok(searches.length === 0, 'no search on open — nothing leaves until the reader acts');
  const chips = root.querySelectorAll('.wiki-suggest');
  ok(chips.length >= 3, 'the empty state offers suggestion chips to seed a search');

  // a suggestion chip seeds + runs a search
  await click(chips[0]);
  await waitFor(() => root.querySelectorAll('.wiki-row').length >= 2);
  ok(searches.length >= 1, 'a suggestion chip fires a search');
  const rows = root.querySelectorAll('.wiki-row');
  ok(rows.length >= 2, 'rich result rows render');
  ok(!!root.querySelector('.wiki-row-thumb'), 'a result carries a thumbnail (or placeholder)');
  ok(/aquatic mammal/.test(root.textContent), 'the one-line description shows on the row');

  // live search: typing alone fires another search, no Enter
  const before = searches.length;
  const input = root.querySelector('.wiki-search-input');
  await TestUtils.act(async () => { TestUtils.Simulate.change(input, { target: { value: 'dolphin' } }); });
  await waitFor(() => searches.length > before);
  ok(searches.includes('dolphin'), 'live search fires from typing alone (no Enter / button)');
  await waitFor(() => root.querySelectorAll('.wiki-row').length >= 2);

  // expand a row → inline preview with extract + read-more link
  await click(root.querySelector('.wiki-row-head'));
  await waitFor(() => !!root.querySelector('.wiki-row-expand'));
  ok(!!root.querySelector('.wiki-row-expand'), 'a row expands to an inline preview');
  ok(/Dolphins are aquatic mammals/.test(root.querySelector('.wiki-row-extract').textContent), 'the preview shows the intro extract');
  const readMore = root.querySelector('.wiki-row-readmore');
  ok(readMore && /en\.wikipedia\.org\/wiki\/Dolphin/.test(readMore.getAttribute('href')), 'a "read the full article" link points to Wikipedia');

  // add several articles, one row at a time
  const addBtns = () => [...root.querySelectorAll('.wiki-row-add')].filter(b => !b.disabled);
  await click(addBtns()[0]);
  await waitFor(() => ingestCalls.length >= 1, 120);
  ok(ingestCalls.length === 1, 'per-row "Add source" ingests that article');
  ok(ingestCalls[0].refs === 2, 'adding pulls the article’s citations through (full fetch, not the snippet)');
  await waitFor(() => /1 article added/.test(root.textContent), 40);
  ok(/1 article added/.test(root.textContent), 'the footer counts the added source');

  await click(addBtns()[0]);                    // the now-first still-addable row
  await waitFor(() => ingestCalls.length >= 2, 120);
  ok(ingestCalls.length === 2 && ingestCalls[0].title !== ingestCalls[1].title, 'a second article adds independently (multiple sources)');
  await waitFor(() => /2 articles added/.test(root.textContent), 40);
  ok(/2 articles added/.test(root.textContent), 'the footer reflects multiple sources');
  ok([...root.querySelectorAll('.wiki-row-add')].some(b => /Added/.test(b.textContent)), 'an added row reads as Added');

  await TestUtils.act(async () => { client.unmount(); });
  console.log(`\n${fail ? '✗' : 'PASS —'} Wikipedia search modal: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
