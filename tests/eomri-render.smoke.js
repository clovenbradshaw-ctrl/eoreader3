/* Smoke: mount the REAL EOMRIInstrument (eomri.jsx) over a seeded
   window.EOAudit and confirm it renders live turns without throwing —
   exercising the grounded, null-form, absence and ungrounded render
   branches that traceFromTurn produces. Runs the client component through
   jsdom, like verify-markdown.js. Run with `node tests/eomri-render.smoke.js`. */
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
for (const f of ['pivot.jsx', 'engine.js', 'audit.js', 'eomri.jsx']) run(f);
const W = window;

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } };

// Seed three REAL turns the way the chat pipeline records them.
const A = W.EOAudit;
function record(input, steps, final) {
  A.begin({ input, mode: 'grounded', model: { name: 'test' } });
  for (const s of (steps || [])) A.step(s.t, s);
  A.end(final);
}
record('who wrote it, and when was it published?',
  [{ t: 'retrieve', k: 6, engine: 'embedding', hits: [{ score: 0.81, idx: 12, text: 'written by H. G. Wells, 1895' }] }],
  { engine: 'model', text: 'It was written by H. G. Wells in 1895{{cite:doc1:12:s12}}.',
    cites: [{ docId: 'doc1', idx: 12 }], audit: { status: 'clean', grounded: true, covers: '1/1', stable: true }, form: { degree: 0.86 } });
record("what was the author's stance?",   // ungrounded → fluent on thin air, AND no form measured (null-form branch)
  [{ t: 'retrieve', k: 6, engine: 'embedding', hits: [] }],
  { engine: 'model', text: 'He was a committed Fabian socialist.', cites: [],
    audit: { status: 'warn', grounded: false, covers: '0/1', stable: true } });
record('how does it compare to his later work?',   // absence
  [{ t: 'retrieve', k: 6, engine: 'embedding', hits: [] }],
  { engine: 'mechanical', text: "I don't have anything on his later novels in what I was handed.",
    cites: [], audit: { status: 'held', grounded: true, covers: '0/1', stable: true, note: "Held rather than invented." } });

ok(A.all().filter(t => t.done).length === 3, 'three settled turns recorded');

const container = W.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
let threw = null;
try {
  TestUtils.act(() => { root.render(React.createElement(W.EOMRIInstrument, { onClose() {} })); });
} catch (e) { threw = e; }
ok(!threw, 'EOMRIInstrument mounts over real audit turns without throwing' + (threw ? ' — ' + threw.message : ''));

const text = container.textContent || '';
ok(/real turn/.test(text), 'the top bar reports it is reading real turns from the audit log');
ok(text.indexOf('H. G. Wells') !== -1 || text.indexOf('who wrote it') !== -1, 'a real turn (question or answer) is on screen');
ok(/EO-MRI/.test(text), 'the instrument chrome rendered');

// a second render (the play loop has scheduled a setState by now) must not throw
let reRenderThrew = null;
try { TestUtils.act(() => { root.render(React.createElement(W.EOMRIInstrument, { onClose() {} })); }); }
catch (e) { reRenderThrew = e; }
ok(!reRenderThrew, 'a re-render does not throw');

TestUtils.act(() => { root.unmount(); });   // clears play/type timers so the process can exit

console.log(`\neomri-render: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
process.exit(0);
