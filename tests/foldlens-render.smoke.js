/* Smoke: mount the REAL FoldLens (docview.jsx) — the integral-fold lens — in its
   three states: empty (no cursor), the full holonic ladder, and a shallow depth.
   Confirms it renders the rungs, the cursor quote, the depth control and the
   breadcrumb without throwing, and that the depth dial slices the ladder. Runs
   the client component through jsdom, like reading-render.smoke.js. The engine's
   holonicFold is stubbed with a representative ladder (its real shape is pinned
   mechanically in fold.test.js). Run with `node tests/foldlens-render.smoke.js`. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://example.com/' });
const { window } = dom;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

const React = require('react');
const ReactDOMClient = require('react-dom/client');
const TestUtils = require('react-dom/test-utils');
window.React = React;
global.window = window; global.document = window.document;
try { Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true }); } catch (_) {}
global.React = React;
global.IS_REACT_ACT_ENVIRONMENT = true;
const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated/.test(s)) return; origErr.apply(console, a); };

function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
for (const f of ['icons.jsx', 'docview.jsx']) run(f);
const W = window;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } };

ok(typeof W.FoldLens === 'function', 'FoldLens is exported on window');

// A representative ladder — the exact shape EOEngine.holonicFold returns.
const LADDER = {
  cursor: 142, cursorText: 'We were the first to see it.', depth: 3, maxDepth: 3,
  rungs: [
    { depth: 0, level: 'document',  label: 'hod.txt',         start: 0,   end: 143, count: 143, fold: 'It mostly centers on Marlow and Kurtz.' },
    { depth: 1, level: 'section',   label: 'II',              start: 98,  end: 143, count: 45,  fold: 'Up to here the chapter turns on the river.' },
    { depth: 2, level: 'paragraph', label: 'this paragraph',  start: 139, end: 143, count: 4,   fold: 'These lines weigh the steamer’s progress.' },
    { depth: 3, level: 'sentence',  label: 'this sentence',   start: 142, end: 143, count: 1,   fold: 'We were the first to see it.' },
  ],
};
W.EOEngine = { holonicFold: (doc, c) => (c == null ? null : LADDER) };

const container = W.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
const levels = () => [...container.querySelectorAll('.fl-level')].map(n => n.textContent).join(' | ');

// ── State 1: empty (no cursor) ─────────────────────────────────────────────
let threw = null;
try { TestUtils.act(() => { root.render(React.createElement(W.FoldLens, { doc: { id: 'hod' }, cursor: null, depth: 99, onDepth() {}, onJump() {} })); }); } catch (e) { threw = e; }
ok(!threw, 'FoldLens mounts with no cursor' + (threw ? ' — ' + threw.message : ''));
ok(/Click any sentence/.test(container.textContent), 'empty state prompts the reader to click a sentence');

// ── State 2: the full holonic ladder (depth 99 → clamped to maxDepth 3) ─────
threw = null;
try { TestUtils.act(() => { root.render(React.createElement(W.FoldLens, { doc: { id: 'hod' }, cursor: 142, depth: 99, onDepth() {}, onJump() {} })); }); } catch (e) { threw = e; }
ok(!threw, 'FoldLens mounts with a cursor' + (threw ? ' — ' + threw.message : ''));
ok(container.querySelectorAll('.fl-rung').length === 4, 'all four rungs render at full depth');
ok(/Document/.test(levels()) && /Section · II/.test(levels()) && /Paragraph/.test(levels()) && /Sentence/.test(levels()),
   'every holonic level is labeled (Document › Section · II › Paragraph › Sentence)');
ok(/It mostly centers on Marlow and Kurtz\./.test(container.textContent), 'the document-rung fold prose renders');
ok(/“We were the first to see it\.”/.test(container.textContent), 'the cursor sentence is quoted at the top');
const range = container.querySelector('#fl-depth-range');
ok(range && Number(range.value) === 3 && Number(range.max) === 3, 'the depth slider clamps to maxDepth and shows it');

// ── State 3: a shallow depth slices the ladder to the outer holons ──────────
threw = null;
try { TestUtils.act(() => { root.render(React.createElement(W.FoldLens, { doc: { id: 'hod' }, cursor: 142, depth: 1, onDepth() {}, onJump() {} })); }); } catch (e) { threw = e; }
ok(!threw, 'FoldLens mounts at a shallow depth');
ok(container.querySelectorAll('.fl-rung').length === 2, 'depth 1 shows only the document + section rungs');
ok(!/Sentence/.test(levels()), 'the inner sentence/paragraph rungs are hidden below the chosen depth');

if (fail) console.error('foldlens-render FAILURES:\n  - ' + fails.join('\n  - '));
console.log(`foldlens-render: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
