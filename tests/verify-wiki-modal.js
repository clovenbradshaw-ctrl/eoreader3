/* Verify the Wikipedia search modal (reference.jsx → window.WikiSearchModal):
   the composer button's destination. Mounts the REAL component through jsdom,
   driving the REAL external.js (with an injected fetch) so the whole path runs —
   search → render the article close to source → pull its citations through. The
   renderer only runs in the browser, so this mirrors verify-markdown's harness.

   Asserts: a search lists real candidates; opening one renders the article HTML
   (sanitised — no <script>/navbox) with its reference list; "Add to graph" hands
   the payload (with references + a per-sentence footnote map) up to onIngest. */
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
<table class="infobox"><caption>Dolphin</caption><tr><td><img src="//upload.wikimedia.org/d.jpg"></td></tr></table>
<p><b>Dolphins</b> are aquatic mammals.<sup class="reference"><a href="#cite_note-a-1">[1]</a></sup> They are widespread.<sup class="reference"><a href="#cite_note-b-2">[2]</a></sup></p>
<h2><span class="mw-headline">Diet</span><span class="mw-editsection">[edit]</span></h2>
<p>They eat fish and squid.<sup class="reference"><a href="#cite_note-c-3">[3]</a></sup></p>
<h2>References</h2>
<ol class="references">
<li id="cite_note-a-1"><cite>Smith (2020). <a class="external text" href="https://example.com/smith">smith</a></cite></li>
<li id="cite_note-b-2"><cite>Jones (2019). <a class="external text" href="https://bbc.co.uk/d">bbc</a></cite></li>
<li id="cite_note-c-3"><cite>Doe (2021). <a class="external text" href="https://nature.com/x">nature</a></cite></li>
</ol>
<div class="navbox">NAVBOX JUNK</div>
<script>danger()</script>
</div>`;
async function fakeFetch(full) {
  const inner = decodeURIComponent(String(full).split('?url=')[1] || '');
  const ok = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });
  if (/list=search/.test(inner)) {
    return ok({ query: { search: [{ title: 'Dolphin', snippet: 'aquatic <span class="searchmatch">mammal</span>' }, { title: 'Dolphin (disambiguation)', snippet: 'other uses' }] } });
  }
  if (/action=parse/.test(inner)) return ok({ parse: { title: 'Dolphin', displaytitle: 'Dolphin', text: { '*': ARTICLE_HTML } } });
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

(async function main() {
  const root = document.getElementById('root');
  const client = ReactDOMClient.createRoot(root);
  let ingested = null;
  const onIngest = (payload) => { ingested = payload; return Promise.resolve({ id: 'doc1', name: 'Wikipedia · ' + payload.title }); };

  await TestUtils.act(async () => { client.render(React.createElement(W.WikiSearchModal, { initialQuery: 'dolphin', onClose: () => {}, onIngest, onOpenDoc: () => {} })); });
  // initial search fires from the seed query; let the (throttled) fetch settle
  for (let i = 0; i < 40 && !root.querySelector('.wiki-option'); i++) await sleep(10);

  const opts = root.querySelectorAll('.wiki-option');
  ok(opts.length >= 2, 'a search lists the real candidate articles (no chat guess)');
  ok(/Dolphin/.test(root.textContent), 'the candidate title shows');

  await click(opts[0]);                                   // open the first article
  for (let i = 0; i < 40 && !root.querySelector('.wiki-article'); i++) await sleep(10);

  const article = root.querySelector('.wiki-article');
  ok(!!article, 'the chosen article renders in the reader');
  ok(/aquatic mammals/.test(article.innerHTML), 'article body rendered close to source (its own HTML)');
  ok(article.innerHTML.indexOf('danger()') === -1, 'embedded <script> was stripped before render');
  ok(article.innerHTML.indexOf('NAVBOX JUNK') === -1, 'navbox chrome dropped from the render');
  ok(!!root.querySelector('.references') || /Smith \(2020\)/.test(article.textContent), 'the reference list is shown for sourcing through');
  ok(/source/i.test(root.textContent) && /Wikipedia cites/i.test(root.textContent), 'the foot surfaces the sources Wikipedia cites');

  const addBtn = [...root.querySelectorAll('button')].find(b => /add to graph/i.test(b.textContent));
  ok(!!addBtn, 'an "Add to graph" action is offered');
  await click(addBtn);
  await sleep(20);
  ok(ingested && ingested.title === 'Dolphin', 'Add to graph hands the article payload up to be ingested');
  ok(ingested && ingested.references && ingested.references.length === 3, 'the payload carries the article’s citations');
  ok(ingested && (ingested.footnotes || []).some(f => f.refs && f.refs.length), 'the payload carries a per-sentence footnote map');

  await TestUtils.act(async () => { client.unmount(); });
  console.log(`\n${fail ? '✗' : 'PASS —'} Wikipedia search modal: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
