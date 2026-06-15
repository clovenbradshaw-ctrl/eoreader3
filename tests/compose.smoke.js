/* Mount the composition artifact (compose.jsx → window.CompositionView) through
   jsdom — the same way the markdown / message-boundary checks render the real
   client components — so the clean Google-Docs surface AND the (toggled) plan
   tree / confidence bars / action surface are proven to render without a hook or
   runtime error, which the pure composition.test.js (the fold/witness/monitor)
   cannot catch. Quill is not loaded here, so the editor exercises its textarea
   fallback — exactly the degraded path the surface must hold.

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
// jsdom omits the legacy attachEvent/detachEvent that React's dev-mode focus /
// selection-restore shim probes when a field gains focus inside act(); stub them
// so focusing the inline editor doesn't raise a spurious (browser-absent) error.
try { window.HTMLElement.prototype.attachEvent = function () {}; window.HTMLElement.prototype.detachEvent = function () {}; } catch (_) {}

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
function click(el) { TestUtils.act(() => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); }

ok(typeof W.CompositionView === 'function', 'compose.jsx published window.CompositionView');
ok(typeof W.EOComposition === 'object', 'composition.js published window.EOComposition');

const container = window.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
const model = { name: 'Test model', mlc: 'test:model' };

// (1) an EMPTY composition doc — the clean Google-Docs surface is the default;
// the plan/grounding/confidence framework is one ⚙ toggle away.
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
ok(/cmp-clean\b/.test(html), 'the clean Google-Docs surface is the default view');
ok(!!container.querySelector('.cmp-clean-thesis'), 'the topic field renders on the clean surface');
ok(/✍ Write/.test(html), 'the Write action renders on the clean surface');
ok(!!container.querySelector('.cmp-clean-frame-toggle'), 'the ⚙ Framework toggle renders');
ok(/Set what this document is about/.test(html), 'the empty clean surface shows its prompt');
ok(!/cmp-split/.test(html), 'the framework two-pane view is hidden by default');

// toggling ⚙ Framework reveals the plan / frame editor / action surface
click(container.querySelector('.cmp-clean-frame-toggle'));
html = container.innerHTML;
ok(/Plan/.test(html) && /Document/.test(html), 'the framework view shows both panes (Plan / Document)');
ok(/Set the thesis or question/.test(html) || /cmp-frame/.test(html), 'the frame editor renders in the framework view');
ok(/No plan yet/.test(html), 'the empty plan shows its prompt');
ok(/Write it/.test(html) && /Outline only/.test(html) && /\+ Unit/.test(html), 'the doc action surface renders (Write / Outline / + Unit)');
ok(!!container.querySelector('.cmp-readview'), 'the framework view offers a way back to the reading surface');

// (2) a POPULATED fold — a unit, drafted by the talker, lightly edited by the
// user so authorship is mixed; stamped figure-grounded / advance.
const C = W.EOComposition;
const [doc, frame] = C.newDoc({ thesis_or_question: 'Evictions rose', genre: 'plain-report' });
const u = C.make.unit({ doc_id: doc.id, job: 'report the count', order: 0 });
const prose = 'The city recorded twelve thousand filings. I think the freeze ending drove it.';
const provenance = [
  { text: 'The city recorded twelve thousand filings.', author: 'talker' },
  { text: 'I think the freeze ending drove it.', author: 'user' },
];
const draft = C.make.draft({ doc_id: doc.id, unit_id: u.id, prose, author: 'user', provenance, source_events: [{ docId: 'd1', idx: 4 }] });
const stamp = C.make.stamp({ doc_id: doc.id, unit_id: u.id, draft_id: draft.id, tag: 'figure-grounded',
  confidence: C.confidence({ witness: 0.72, retrieval: 0.8 }) });
const route = C.make.route({ doc_id: doc.id, unit_id: u.id, decision: 'advance', predicate: 'witness >= 0.4 AND form >= 0.5 AND (coherence null OR >= 0.5)', triggered_by: C.confidence({ witness: 0.72 }) });
const fullDoc = { id: doc.id, name: 'Evictions', kind: 'composition', _events: [doc, frame, u, draft, stamp, route], frame_id: frame.id };
// reset the tree so the empty-doc's framework toggle doesn't leak as component
// state into this render — a fresh instance starts on the clean surface again
TestUtils.act(() => { root.render(null); });
threw = null;
try {
  TestUtils.act(() => {
    root.render(React.createElement(W.CompositionView, { doc: fullDoc, onAppend() {}, model, modelReady: true, allDocs: [], onCite() {} }));
  });
} catch (e) { threw = e; }
ok(!threw, 'a populated composition renders without throwing' + (threw ? ' — ' + threw.message : ''));
html = container.innerHTML;
// the clean surface shows the assembled body in the editor (textarea fallback,
// since Quill isn't loaded in jsdom) and offers to continue writing
const ta = container.querySelector('.cmp-doc-ta');
ok(!!ta && /The city recorded twelve thousand filings/.test(ta.value || ''), 'the assembled document renders in the clean editor');
ok(/✍ Continue/.test(html), 'with content, the clean action becomes Continue');

// toggle to the framework view for the audit
click(container.querySelector('.cmp-clean-frame-toggle'));
html = container.innerHTML;
ok(/report the count/.test(html), 'the unit job renders in the plan tree');
ok(/The city recorded twelve thousand filings/.test(html), 'the drafted prose renders in the document pane');
// the epistemic "grain" (Figure/Ground/Pattern) is gone from the section elements
ok(!container.querySelector('.cmp-grain') && !container.querySelector('.cmp-mini-sel') && !/grain/i.test(html),
  'no "grain" badge or selector rides on a section — sections are content-type-neutral');
// the document KIND is free text (a datalist of suggestions), so any content —
// a recipe, a technical manual — can be declared, not just a fixed genre list
ok(!!container.querySelector('input[list="cmp-genres"]') && !!container.querySelector('datalist#cmp-genres'),
  'the document-kind field is a free-text input with suggestions (structure any kind of content)');
ok(/technical-manual/.test(html) && /recipe/.test(html), 'the kind suggestions span structured genres (recipe … technical-manual)');
// authorship runs are shaded; only the user's run carries a chip now — the
// model's grounded prose reads clean (no "talker" chip)
ok(/cmp-by-talker/.test(html) && /cmp-by-user/.test(html), 'authorship runs are shaded (your edits vs the grounded draft)');
ok(/cmp-chip cmp-by-user/.test(html) && />you</.test(html), 'your edit carries a "you" chip in the flow');
ok(!/cmp-chip cmp-by-talker/.test(html), "the model's grounded prose carries no 'talker' chip");
ok(/sentences yours/.test(html), 'the authorship summary renders (you wrote N of M)');
ok(/band-advance/.test(html), 'the monitor route colours the band (advance)');

// clicking the card (not the prose) selects → reveals the unit's full audit
const card = container.querySelector('#cmp-card-' + u.id);
ok(!!card, 'the unit is a paragraph in the document canvas');
click(card);
html = container.innerHTML;
ok(/figure-grounded/.test(html), 'selecting reveals the witness tag as a word');
ok(/witness/.test(html) && /coherence/.test(html) && /voice/.test(html), 'selecting reveals the full confidence vector (all seven components labelled)');
ok(/null/.test(html), 'an unmeasured component renders as null, not zero');

// clicking the prose itself turns that paragraph into a seamless inline editor
const proseEl = container.querySelector('#cmp-card-' + u.id + ' .cmp-prose');
ok(!!proseEl, 'the prose is present to click into');
click(proseEl);
ok(!!container.querySelector('.cmp-prose-edit'), 'clicking the prose opens an inline editor (click anywhere and type)');

// (3) the projection — proves the composition is queryable as a prose shape,
// provenance traceable, talker-facing text carrying no authorship vocabulary
const proj = C.project(fullDoc);
ok(proj.kind === 'prose' && proj.sentences.length === 2, 'the composition projects to a queryable prose shape');
ok(proj._provenance[1].author === 'user' && !/talker|user/.test(proj.sentenceTexts.join(' ')), 'authorship is traceable in the projection, absent from the text the talker reads');

// (4) the "✍ Continue" autopilot EXTENDS a finished document — the regression
// guard for the dead button. A fully-drafted doc has nothing "owed", so the old
// write() built an empty todo and silently did nothing; Continue must now plan
// the NEXT sections (told what's already written) and draft them. Stub the model
// so the click produces real appends, then assert new units + prose arrive.
const contAppends = [];
const contDoc = { id: doc.id, name: 'Evictions', kind: 'composition', _events: [doc, frame, u, draft, stamp, route], frame_id: frame.id };
W.EOLLM = {
  isLoaded: () => true,
  phrase: async (opts) => {
    const sys = String((opts && opts.sysOverride) || '');
    if (/one job per line/i.test(sys)) return 'The policy response\nWhat comes next';            // an outline reply
    return 'The freeze ending pushed filings past every prior monthly record in the county.';     // a section draft
  },
};
TestUtils.act(() => { root.render(null); });
TestUtils.act(() => {
  root.render(React.createElement(W.CompositionView, {
    doc: contDoc, onAppend: (id, evts) => { for (const e of evts) contAppends.push(e); }, model, modelReady: true, allDocs: [], onCite() {},
  }));
});
const continueBtn = Array.from(container.querySelectorAll('.cmp-act.primary')).find(b => /Continue/.test(b.textContent || ''));
ok(!!continueBtn, 'the populated doc offers a ✍ Continue button to click');
if (continueBtn) click(continueBtn);

// let the autopilot's async write loop (plan → draft) drain, then assert it grew
// the document instead of the old silent no-op. onAppend fires synchronously
// inside the loop, so we depend on the appends, not on a React re-render.
setTimeout(() => {
  const newUnits = contAppends.filter(e => e && e.kind === 'unit' && e.id !== u.id);
  const newDrafts = contAppends.filter(e => e && e.kind === 'draft' && e.unit_id !== u.id);
  ok(newUnits.length > 0, '✍ Continue on a fully-drafted doc plans NEW sections (no longer a silent no-op)');
  ok(newDrafts.length > 0, 'and drafts prose into them — the document actually grows');
  ok(contAppends.some(e => e && e.kind === 'plan-edit-by-draft' && e.reason === 'continued the document'),
    'the continuation is recorded honestly in the log (a "continued the document" plan edit)');

  console.log(`\ncompose.smoke.js — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('FAILURES:\n' + fails.map(s => '  - ' + s).join('\n')); process.exit(1); }
}, 100);
