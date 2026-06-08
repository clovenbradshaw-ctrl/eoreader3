/* ============================================================
   Tests for the audit recorder (audit.js → window.EOAudit).

   audit.js is a browser script: an IIFE that publishes onto `window`.
   Like the engine harness, we run it in a vm context with a fake
   `window`, then exercise the recorder and assert the JSONL contract:
   one self-contained, valid-JSON turn per line.

   Run with `node tests/audit.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadAudit() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'audit.js'), 'utf8'), sandbox, { filename: 'audit.js' });
  if (!sandbox.window.EOAudit) throw new Error('audit.js did not publish window.EOAudit');
  return sandbox.window.EOAudit;
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); fn(); }

const A = loadAudit();

group('records a turn as one JSONL line', () => {
  A.clear();
  const id = A.begin({ input: 'what is this about?', mode: 'auto', scope: [{ id: 'd1', name: 'Doc', kind: 'prose' }], model: { id: 'm', name: 'M' } });
  ok(typeof id === 'string' && id.length > 0, 'begin returns a turn id');
  A.step('route', { path: 'grounded-llm', referencing: true });
  A.step('intent', { intent: 'summary' });
  A.step('llm', { mode: 'grounded', output: 'hello', messages: [{ role: 'system', chars: 3, content: 'sys' }] });
  A.set({ modelReady: true });
  A.end({ engine: 'model', text: 'hello', audit: { grounded: true, covers: '1/1', status: 'clean', stable: true } });
  eq(A.count(), 1, 'one turn recorded');

  const lines = A.toJSONL().split('\n');
  eq(lines.length, 1, 'one JSONL line for one turn');
  const t = JSON.parse(lines[0]);                 // each line must be valid JSON on its own
  eq(t.schema, 'cleon-audit/1', 'schema stamped on the turn');
  eq(t.input, 'what is this about?', 'input captured');
  eq(t.mode, 'auto', 'mode captured');
  eq(t.modelReady, true, 'set() merged a late field');
  eq(t.steps.length, 3, 'three steps recorded');
  eq(t.steps[0].t, 'route', 'first step is the route decision');
  ok(typeof t.steps[0].dt === 'number', 'each step carries a dt offset');
  eq(t.done, true, 'turn marked done');
  eq(t.final.engine, 'model', 'final engine captured');
  ok(typeof t.ms === 'number', 'turn duration recorded');
  ok(!('_t0' in t), 'internal timing anchor is not serialized');
});

group('orphan steps ignored; a new begin opens a new turn', () => {
  A.step('orphan', { x: 1 });                      // no current turn → ignored
  const first = JSON.parse(A.toJSONL().split('\n')[0]);
  eq(first.steps.length, 3, 'a step after end does not attach to the closed turn');
  A.begin({ input: 'second', mode: 'grounded' });
  A.end({ engine: 'mechanical' });
  eq(A.count(), 2, 'second turn recorded');
  eq(A.toJSONL().split('\n').length, 2, 'two turns → two JSONL lines');
});

group('pause stops recording; resume continues', () => {
  A.clear(); eq(A.count(), 0, 'cleared to empty');
  A.setEnabled(false);
  const id = A.begin({ input: 'while paused' });
  ok(id === null, 'begin returns null while paused');
  eq(A.count(), 0, 'no turn recorded while paused');
  A.setEnabled(true);
  A.begin({ input: 'after resume' }); A.end({ engine: 'none' });
  eq(A.count(), 1, 'recording resumes after un-pausing');
});

group('snapshots are detached from the caller', () => {
  A.clear();
  const scope = [{ id: 'd', name: 'Doc', kind: 'prose' }];
  A.begin({ input: 'x', scope });
  scope[0].name = 'MUTATED';                       // mutate the source after begin
  A.end({ engine: 'none' });
  const t = JSON.parse(A.toJSONL());
  eq(t.scope[0].name, 'Doc', 'begin snapshotted scope rather than holding a reference');
});

group('subscribe fires on change and unsubscribes cleanly', () => {
  A.clear();
  let hits = 0; const off = A.subscribe(() => { hits++; });
  A.begin({ input: 'sub' }); A.step('route', { path: 'x' }); A.end({ engine: 'none' });
  ok(hits >= 3, 'listener fired on begin/step/end');
  off();
  const was = hits; A.begin({ input: 'after' }); A.end({ engine: 'none' });
  eq(hits, was, 'unsubscribe stops further notifications');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
