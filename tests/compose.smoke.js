/* Mount the composition artifact (compose.jsx → window.CompositionView) through
   jsdom — the same way the markdown / message-boundary checks render the real
   client components — so the two-pane view, the plan tree, the confidence bars
   and the action surface are proven to render without a hook or runtime error,
   which the pure composition.test.js (the fold/witness/monitor) cannot catch.

   Run with `node tests/compose.smoke.js`. */
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
global.IS_REACT_ACT_ENVIRONMENT = true;

const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/act\(|deprecated/.test(s)) return; origErr.apply(console, a); };

// indirect eval runs in global scope, so a top-level `function Icon` / IIFE in an
// eval'd file becomes global — exactly how the other client tests resolve Icon.
function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
for (const f of ['composition.js', 'icons.jsx', 'compose.jsx']) run(f);
const W = window;

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }

ok(typeof W.CompositionView === 'function', 'compose.jsx published window.CompositionView');
ok(typeof W.EOComposition === 'object', 'composition.js published window.EOComposition');

const container = window.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
const model = { name: 'Test model', mlc: 'test:model' };

// (1) an EMPTY composition doc — proves the frame editor and empty states render
let appended = [];
const emptyLog = W.EOComposition.newDoc({ genre: 'plain-report' });
const emptyDoc = { id: emptyLog[0].id, name: 'Untitled', kind: 'composition', _events: emptyLog, frame_id: emptyLog[1].id };
let threw = null;
try {
  TestUtils.act(() => {
    root.render(React.createElement(W.CompositionView, {
      doc: emptyDoc, onAppend: (id, evts) => { appended.push([id, evts]); }, model, modelReady: false, allDocs: [], onCite() {},
    }));
  });
} catch (e) { threw = e; }
ok(!threw, 'an empty composition renders without throwing' + (threw ? ' — ' + threw.message : ''));
let html = container.innerHTML;
ok(/Plan/.test(html) && /Draft/.test(html), 'both panes render (Plan / Draft headers)');
ok(/Set the thesis or question/.test(html) || /cmp-frame/.test(html), 'the frame editor renders');
ok(/No plan yet/.test(html), 'the empty plan shows its prompt');
ok(/Plan from frame/.test(html) && /\+ Unit/.test(html), 'the doc action surface renders');

// (2) a POPULATED fold — a unit, drafted, stamped (figure-grounded, advance) —
// proves the prose, the confidence vector bars, the tag and the band render
const C = W.EOComposition;
const [doc, frame] = C.newDoc({ thesis_or_question: 'Evictions rose', genre: 'plain-report' });
const u = C.make.unit({ doc_id: doc.id, job: 'report the count', order: 0 });
const draft = C.make.draft({ doc_id: doc.id, unit_id: u.id, prose: 'The city recorded twelve thousand filings.', source_events: [{ docId: 'd1', idx: 4 }] });
const stamp = C.make.stamp({ doc_id: doc.id, unit_id: u.id, draft_id: draft.id, tag: 'figure-grounded',
  confidence: C.confidence({ witness: 0.72, retrieval: 0.8 }) });
const route = C.make.route({ doc_id: doc.id, unit_id: u.id, decision: 'advance', predicate: 'witness >= 0.4 AND form >= 0.5 AND (coherence null OR >= 0.5)', triggered_by: C.confidence({ witness: 0.72 }) });
const fullDoc = { id: doc.id, name: 'Evictions', kind: 'composition', _events: [doc, frame, u, draft, stamp, route], frame_id: frame.id };
threw = null;
try {
  TestUtils.act(() => {
    root.render(React.createElement(W.CompositionView, { doc: fullDoc, onAppend() {}, model, modelReady: true, allDocs: [], onCite() {} }));
  });
} catch (e) { threw = e; }
ok(!threw, 'a populated composition renders without throwing' + (threw ? ' — ' + threw.message : ''));
html = container.innerHTML;
ok(/report the count/.test(html), 'the unit job renders in the plan tree');
ok(/The city recorded twelve thousand filings/.test(html), 'the drafted prose renders in the draft pane');
ok(/figure-grounded/.test(html), 'the witness tag renders as a word');
ok(/witness/.test(html) && /coherence/.test(html), 'the full confidence vector renders (all six components labelled)');
ok(/null/.test(html), 'an unmeasured component renders as null, not zero');
ok(/band-advance/.test(html), 'the monitor route colours the band (advance)');

setTimeout(() => {
  console.log(`\ncompose.smoke.js — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('FAILURES:\n' + fails.map(s => '  - ' + s).join('\n')); process.exit(1); }
}, 30);
