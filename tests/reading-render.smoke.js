/* Smoke: mount the REAL ReadingModal (reading.jsx) in both of its states — the
   live reading (a streamed `session`) and the finished reading (a `result` with
   figures, glimpses and counts) — and confirm it renders the movements, the
   figures, the counts and the two choices without throwing. Also exercises
   makeReadingResult over a hand-built doc. Runs the client component through
   jsdom, like eomri-render.smoke.js. Run with `node tests/reading-render.smoke.js`. */
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
global.setInterval = setInterval; global.clearInterval = clearInterval;
global.IS_REACT_ACT_ENVIRONMENT = true;
const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated/.test(s)) return; origErr.apply(console, a); };

function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
// Icon + useDialog live in icons.jsx; reading.jsx provides ReadingModal +
// makeReadingResult. Reduced motion → the reveal settles at once (no timers).
window.document.documentElement.classList.add('reduce-motion');
for (const f of ['icons.jsx', 'reading.jsx']) run(f);
const W = window;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } };

ok(typeof W.ReadingModal === 'function', 'ReadingModal is exported on window');
ok(typeof W.makeReadingResult === 'function', 'makeReadingResult is exported on window');

// makeReadingResult over a hand-built prose doc (engine stubbed for figures).
W.EOEngine = { projectEntities: () => ({ entities: [
  { name: 'Gregor', type: 'person', raw: 42, sents: [0] },
  { name: 'Prague', type: 'place', raw: 7, sents: [2] },
] }) };
const doc = { kind: 'prose', name: 'kafka.txt', meta: '1,240 words · prose', _text: 'word '.repeat(1240),
  blocks: [
    { type: 'p', sentences: [{ i: 0, t: 'One morning Gregor woke transformed.' }, { i: 1, t: 'It was no dream.' }] },
    { type: 'p', sentences: [{ i: 2, t: 'He looked toward Prague.' }] },
  ] };
const result = W.makeReadingResult(doc);
ok(result && result.sentences === 3 && result.paragraphs === 2, 'result counts sentences + paragraphs');
ok(result && result.figures.length === 2 && result.figures[0].name === 'Gregor', 'result ranks figures by mentions');
ok(result && result.glimpses.length >= 2, 'result carries glimpse sentences');

const container = W.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);

// ── State 1: live reading (session only, no result) ───────────────────────
let threw = null;
try {
  TestUtils.act(() => { root.render(React.createElement(W.ReadingModal, {
    session: { name: 'kafka.txt', phase: 'structure', stage: 'reading', pct: 0.4, done: 40, total: 100, big: false },
    result: null, onOpenChat() {}, onOpenDoc() {}, onClose() {},
  })); });
} catch (e) { threw = e; }
ok(!threw, 'ReadingModal mounts in the live-reading state' + (threw ? ' — ' + threw.message : ''));
let text = container.textContent || '';
ok(/Reading/.test(text) && /kafka\.txt/.test(text), 'shows the reading eyebrow + the doc name');
ok(/Find/.test(text) && /Read/.test(text) && /Weigh/.test(text), 'shows the Find · Read · Weigh movements');
ok(/Reading the structure/.test(text), 'shows the live stage line');
ok(!/Bring into chat/.test(text), 'no CTAs while still reading');

// ── State 2: finished reading (result present) ────────────────────────────
let chat = 0, openDoc = 0;
let threw2 = null;
try {
  TestUtils.act(() => { root.render(React.createElement(W.ReadingModal, {
    session: null, result, onOpenChat() { chat++; }, onOpenDoc() { openDoc++; }, onClose() {},
  })); });
} catch (e) { threw2 = e; }
ok(!threw2, 'ReadingModal mounts in the finished-reading state' + (threw2 ? ' — ' + threw2.message : ''));
text = container.textContent || '';
ok(/Gregor/.test(text) && /Prague/.test(text), 'surfaces the figures it found');
ok(/sentences/.test(text) && /paragraphs/.test(text), 'shows the measured counts');
ok(/Bring into chat/.test(text) && /Open document/.test(text), 'offers both choices');

// the choices fire their callbacks
const buttons = [...container.querySelectorAll('button.rm-btn')];
const primary = container.querySelector('button.rm-btn-primary');
TestUtils.act(() => { primary.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); });
ok(chat === 1, '"Bring into chat" invokes onOpenChat');
const openBtn = buttons.find(b => !b.classList.contains('rm-btn-primary'));
TestUtils.act(() => { openBtn.dispatchEvent(new W.MouseEvent('click', { bubbles: true })); });
ok(openDoc === 1, '"Open document" invokes onOpenDoc');

// table docs read differently — rows/columns, no figures
const tableResult = W.makeReadingResult({ kind: 'table', name: 's.csv', meta: '120 rows', rows: new Array(120), columns: ['a', 'b'] });
let threw3 = null;
try {
  TestUtils.act(() => { root.render(React.createElement(W.ReadingModal, { session: null, result: tableResult, onOpenChat() {}, onOpenDoc() {}, onClose() {} })); });
} catch (e) { threw3 = e; }
ok(!threw3, 'ReadingModal mounts for a table result' + (threw3 ? ' — ' + threw3.message : ''));
text = container.textContent || '';
ok(/rows/.test(text) && /columns/.test(text), 'a table reading shows rows + columns');

TestUtils.act(() => { root.unmount(); });

console.log(`\nreading-render: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
