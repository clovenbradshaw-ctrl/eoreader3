/* Verify Cleo's replies render Markdown (renderAnswer in chat.jsx) while
   keeping citation chips and degrading gracefully on partial/streaming input.
   Runs the REAL client renderer through jsdom, the same way the message-boundary
   check does, since the renderer only runs in the browser. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');
const nlp = require('compromise');

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
global.nlp = nlp; global.React = React; global.performance = window.performance;
global.setTimeout = setTimeout; global.IS_REACT_ACT_ENVIRONMENT = true;

const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated/.test(s)) return; origErr.apply(console, a); };

function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
for (const f of ['pivot.jsx', 'engine.js', 'audit.js', 'data.jsx', 'icons.jsx', 'chat.jsx']) run(f);
const W = window;

const md = [
  '# Heading one',
  '',
  'A paragraph with **bold**, *italic*, ***both***, ~~struck~~ and `inline code`,',
  'plus a [link](https://example.com) and a citation {{cite:doc1:3:s3}}.',
  '',
  '## Heading two',
  '',
  '- first bullet',
  '- second bullet with **emphasis**',
  '  - nested bullet',
  '',
  '1. step one',
  '2. step two',
  '',
  '> a quoted line',
  '',
  '```',
  'const x = 1; // fenced code',
  '```',
  '',
  '---',
  '',
  'A snake_case_name and 2 * 3 * 4 must stay literal.',
].join('\n');

const messages = [
  { role: 'user', text: 'show me markdown' },
  { role: 'assistant', text: md, audit: { status: 'clean', grounded: true, covers: '3/3', stable: true } },
  // streaming / partial markdown: an unclosed bold and an open fence must not throw
  { role: 'assistant', text: 'streaming **partial and ```\nopen fence', streaming: true },
];
const composerProps = { value: '', onChange() {}, onSend() {}, mode: 'auto', onMode() {}, onAttach() {}, busy: false, sources: [], addable: [] };

let cited = null;
const container = window.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
TestUtils.act(() => { root.render(React.createElement(W.ChatPane, { messages, onCite: (d, i) => { cited = [d, i]; }, composerProps })); });

setTimeout(() => {
  const q = (sel) => container.querySelector(sel);
  const html = container.innerHTML;
  const asst = container.querySelectorAll('.msg-asst')[0];

  const checks = [
    ['app mounted',              !!q('.chat-stream')],
    ['h1 heading',               !!asst.querySelector('h1') && /Heading one/.test(asst.querySelector('h1').textContent)],
    ['h2 heading',               !!asst.querySelector('h2')],
    ['bold (strong)',            !!asst.querySelector('strong')],
    ['italic (em)',              !!asst.querySelector('em')],
    ['bold+italic nests em',     !!asst.querySelector('strong em')],
    ['strikethrough (del)',      !!asst.querySelector('del')],
    ['inline code',              !!asst.querySelector('code.md-code-inline')],
    ['fenced code block',        !!asst.querySelector('pre.md-code-block code') && /const x = 1/.test(asst.querySelector('pre.md-code-block').textContent)],
    ['unordered list + nesting', !!asst.querySelector('ul.md-list li') && !!asst.querySelector('ul.md-list ul.md-list')],
    ['ordered list',             !!asst.querySelector('ol.md-list li')],
    ['blockquote',               !!asst.querySelector('blockquote.md-quote')],
    ['horizontal rule',          !!asst.querySelector('hr.md-hr')],
    ['safe link w/ target+rel',  !!asst.querySelector('a.md-link[href="https://example.com"][target="_blank"]') && /noopener/.test(asst.querySelector('a.md-link').getAttribute('rel'))],
    ['citation chip preserved',  !!asst.querySelector('button.cite') && /s3/.test(asst.querySelector('button.cite').textContent)],
    ['snake_case left literal',  /snake_case_name/.test(asst.textContent)],
    ['bare asterisks literal',   /2 \* 3 \* 4/.test(asst.textContent)],
    ['no raw markdown leaked',   !/(^|[^`])#{1,6}\s/.test(asst.textContent.replace(/```[\s\S]*?```/g, '')) && !asst.textContent.includes('**bold**')],
    ['partial bold not thrown',  /streaming/.test(html) && html.includes('**partial')],
  ];

  // citation chip is actually wired to onCite
  try { asst.querySelector('button.cite').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); } catch (_) {}
  checks.push(['citation onCite fires', Array.isArray(cited) && cited[0] === 'doc1' && cited[1] === 3]);

  let ok = true;
  for (const [name, pass] of checks) { console.log((pass ? 'PASS  ' : 'FAIL  ') + name); if (!pass) ok = false; }
  console.log(ok ? '\nPASS — Markdown renders, citations survive, partial input is safe.' : '\nFAIL');
  process.exit(ok ? 0 : 1);
}, 60);
