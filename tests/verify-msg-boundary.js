/* Verify the per-message boundary in the real (client) renderer — error
   boundaries only engage there. A message whose render genuinely throws
   (non-string `audit.covers` → TypeError in AuditBadge) must be contained:
   the surrounding messages still render, the raw text survives, and the app
   does not unmount. */
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

// silence the expected React error-boundary console noise; keep real failures
const origErr = console.error;
console.error = (...a) => { const s = a.map(x => (x && x.stack) || String(x)).join(' '); if (/covers\.split|message render|The above error|ErrorBoundary/.test(s)) return; origErr.apply(console, a); };

function run(file) {
  let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.jsx')) code = babel.transform(code, { presets: [require('@babel/preset-react')], filename: file }).code;
  (0, eval)(code);
}
for (const f of ['pivot.jsx', 'engine.js', 'audit.js', 'data.jsx', 'icons.jsx', 'chat.jsx']) run(f);
const W = window;

const messages = [
  { role: 'user', text: 'hello there' },
  { role: 'assistant', text: 'A real answer that must survive as raw text.',
    audit: { status: 'clean', grounded: true, covers: 5 /* non-string → throws */, stable: true } },
  { role: 'assistant', text: 'Following answer renders fine.' },
];
const composerProps = { value: '', onChange() {}, onSend() {}, mode: 'auto', onMode() {}, onAttach() {}, busy: false, sources: [], addable: [] };

const container = window.document.getElementById('root');
const root = ReactDOMClient.createRoot(container);
TestUtils.act(() => { root.render(React.createElement(W.ChatPane, { messages, onCite() {}, composerProps })); });

setTimeout(() => {
  const html = container.innerHTML;
  const rendered = !!container.querySelector('.chat-stream');
  const rawSurvived = html.includes('must survive as raw text');
  const notice = html.includes('display error');
  const neighborsOk = html.includes('hello there') && html.includes('Following answer renders fine');
  console.log('app still mounted (chat-stream present):', rendered);
  console.log('crashing message shown as raw text:', rawSurvived);
  console.log('inline display-error notice shown:', notice);
  console.log('neighbouring messages still rendered:', neighborsOk);
  const ok = rendered && rawSurvived && notice && neighborsOk;
  console.log(ok ? '\nPASS — one bad message is contained; the chat and app survive.' : '\nFAIL');
  process.exit(ok ? 0 : 1);
}, 60);
