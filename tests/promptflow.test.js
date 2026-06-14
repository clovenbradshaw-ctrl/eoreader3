/* ============================================================
   Tests for the prompt-flow registry (promptflow.js → window.EOPromptFlow).

   The registry is the data behind the Prompt-flow dashboard. Its whole promise
   is "tied to the actual prompt structure": every prompt STRING is read live
   from llm.js, never copied. This test is the enforcement of that promise — it
   loads llm.js and promptflow.js into ONE vm context (so window.EOPromptFlow
   sees the real window.EOLLM) and asserts the registry resolves the live
   prompts, the shape-pass verdict tracks modelTier, and the drift check is
   clean against the real code. If a prompt is renamed, a tier boundary moves,
   or a conditional is relocated in llm.js, an assertion here fails — which is
   exactly the signal to update the dashboard rather than let it drift.

   Run with `node tests/promptflow.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// One sandbox, both scripts: llm.js publishes window.EOLLM, promptflow.js reads
// it back out. No model is ever loaded — the registry only calls the pure
// prompt-assembly helpers, which are CDN-free.
function load() {
  const sandbox = { window: {}, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'llm.js'), 'utf8'), sandbox, { filename: 'llm.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'promptflow.js'), 'utf8'), sandbox, { filename: 'promptflow.js' });
  if (!sandbox.window.EOLLM) throw new Error('llm.js did not publish window.EOLLM');
  if (!sandbox.window.EOPromptFlow) throw new Error('promptflow.js did not publish window.EOPromptFlow');
  return { LLM: sandbox.window.EOLLM, PF: sandbox.window.EOPromptFlow };
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); fn(); }

const { LLM, PF } = load();

group('the registry publishes a resolved snapshot', () => {
  const snap = PF.snapshot({ mlcKey: 'anthropic:claude-opus-4-8' });
  ok(snap && typeof snap === 'object', 'snapshot() returns an object');
  ok(snap.eollm === true, 'snapshot sees EOLLM as loaded');
  ok(Array.isArray(snap.prompts) && snap.prompts.length >= 4, 'snapshot carries the prompt inventory');
  ok(Array.isArray(snap.flows) && snap.flows.length >= 6, 'snapshot carries the flow catalogue');
  ok(Array.isArray(snap.dispatcher) && snap.dispatcher.length >= 7, 'snapshot carries the dispatcher cascade');
});

group('prompts are read LIVE from llm.js (not duplicated)', () => {
  const grounded = PF.promptById('grounded');
  ok(grounded && grounded.live === true, 'grounded prompt is marked live');
  // The exact bytes the model would get from systemFor — proof it is the live
  // value, not a copy that could drift.
  eq(grounded.text, LLM.systemFor('auto', 'qa', true, 1), 'grounded text === live systemFor(grounded)');
  ok(/Spans/.test(grounded.text) && /notes/i.test(grounded.text), 'grounded prompt carries the spans-and-notes framing');

  const plain = PF.promptById('plain');
  eq(plain.text, LLM.systemFor('auto', 'qa', false, 1), 'plain text === live systemFor(plain)');
  ok(plain.text !== grounded.text, 'plain and grounded are genuinely different prompts');

  const creative = PF.promptById('creative');
  eq(creative.text, LLM.systemFor('creative', 'qa', false, 1), 'creative text === live systemFor(creative)');
  ok(/compose freely/i.test(creative.text), 'creative prompt is the free-composition one');

  const shape = PF.promptById('shape');
  const liveShape = Array.isArray(LLM.SHAPE_SYSTEM) ? LLM.SHAPE_SYSTEM.join('\n') : String(LLM.SHAPE_SYSTEM);
  eq(shape.text, liveShape, 'shape system text === live SHAPE_SYSTEM');
  ok(/editor/i.test(shape.text), 'shape prompt is the editor / director\'s-note one');
});

group('conditional variants resolve live and actually add lines', () => {
  const grounded = PF.promptById('grounded');
  const summary = grounded.variants.find((v) => v.id === 'grounded.summary');
  ok(summary && summary.ok, 'summary variant resolves');
  ok(Array.isArray(summary.added) && summary.added.length >= 1, 'summary variant adds at least one line over the base');
  ok(summary.added.join(' ').toLowerCase().includes('summary'), 'the added line is the summary degeneracy guard');

  const gate = grounded.variants.find((v) => v.id === 'grounded.relation_gate');
  ok(gate && gate.ok, 'relation-gate variant resolves');
  eq(gate.text, LLM.systemFor('auto', 'qa', true, 1, { provenanceKeys: true }), 'gate text === live systemFor(provenanceKeys)');
  ok(/\[s12\]|tag/i.test(gate.added.join(' ')), 'the gate variant adds the tag-each-claim instruction');
});

group('live parameters mirror EOLLM', () => {
  const byId = {};
  for (const p of PF.params()) byId[p.id] = p;
  eq(byId.DEFAULT_BUDGET.value, LLM.DEFAULT_BUDGET, 'DEFAULT_BUDGET mirrors EOLLM');
  eq(byId.RECENT_TURNS.value, LLM.RECENT_TURNS, 'RECENT_TURNS mirrors EOLLM');
});

group('the shape-pass verdict tracks modelTier (the headline question)', () => {
  // api / capable → the shape prompt IS fed to the model.
  const api = PF.shape('anthropic:claude-opus-4-8');
  eq(api.gating.tier, 'api', 'Claude is the api tier');
  eq(api.gating.active, true, 'shape pass is active (fed to the model) on the api tier');

  const capable = PF.shape('wllama:llama32-3b');
  eq(capable.gating.tier, 'capable', '3B CPU model is capable');
  eq(capable.gating.active, true, 'shape pass is active on the capable tier');

  // small → the shape prompt is SKIPPED (the user's specific question).
  const small = PF.shape('wllama:smollm2-135m');
  eq(small.gating.tier, 'small', '135M CPU model is small');
  eq(small.gating.active, false, 'shape pass is SKIPPED (not fed) on the small tier');
  ok(small.gating.skipReasons.some((r) => r.id === 'small-tier'), 'the small-tier skip reason is named');
  ok(/runGroundedSmall|join/i.test(small.gating.skipReasons.find((r) => r.id === 'small-tier').meaning), 'it explains the join-only replacement');
  ok(/composes the answer directly/i.test(small.gating.whenInactive) || /omits the editor/i.test(small.gating.whenInactive), 'it explains what an empty note means downstream');
});

group("the shape note is shown landing IN the next prompt (fed-in proof)", () => {
  const sh = PF.shape('anthropic:claude-opus-4-8');
  ok(sh.system.live && /editor/i.test(sh.system.text), 'the live SHAPE_SYSTEM is carried');
  ok(sh.lands.live, 'buildUserContent rendered a sample answer-pass user message');
  ok(sh.lands.sampleUserMessage.includes(sh.lands.noteMarker), 'the sample user message contains the editor\'s-note marker');
  ok(sh.lands.sampleUserMessage.includes(sh.lands.sampleNote), 'the editor\'s note text is injected into the user message');
  // It must land LAST — just before the trailing "Answer the user's question".
  const noteAt = sh.lands.sampleUserMessage.indexOf(sh.lands.noteMarker);
  const answerAt = sh.lands.sampleUserMessage.lastIndexOf('Answer the user');
  ok(noteAt > 0 && answerAt > noteAt, 'the note lands last, just before "Answer the user\'s question"');
});

group('flows bind to live prompts; shape-pass usage is correct', () => {
  const flows = {};
  for (const f of PF.flows()) flows[f.id] = f;
  ok(flows['grounded-llm'].usesShapePass === true, 'grounded-llm uses the shape pass');
  ok(flows['plain-chat'].usesShapePass === false, 'plain-chat does not use the shape pass');
  ok(flows['creative'].usesShapePass === false, 'creative does not use the shape pass');
  ok(flows['mechanical'].calls.length === 0, 'mechanical makes zero model calls');
  // The grounded flow's answer call resolves to the live grounded prompt.
  const answer = flows['grounded-llm'].calls.find((c) => c.id === 'answer');
  ok(answer.promptResolved && answer.promptResolved.text === LLM.systemFor('auto', 'qa', true, 1), 'the grounded answer call binds the live grounded prompt');
});

group('drift() is clean against the real llm.js', () => {
  const d = PF.drift();
  ok(d.ok === true, 'no drift errors against the live code');
  eq(d.issues.filter((i) => i.level === 'error').length, 0, 'zero error-level drift issues');
  ok(d.checked >= 4, 'the drift check actually exercised the live prompts');
});

group('the registry degrades safely when EOLLM is absent', () => {
  // A fresh vm with promptflow.js but NO llm.js — the dashboard must not throw.
  const sandbox = { window: {}, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'promptflow.js'), 'utf8'), sandbox, { filename: 'promptflow.js' });
  const bare = sandbox.window.EOPromptFlow;
  let threw = null, snap = null;
  try { snap = bare.snapshot({ mlcKey: 'x' }); } catch (e) { threw = e; }
  ok(!threw, 'snapshot() does not throw without EOLLM');
  ok(snap && snap.eollm === false, 'snapshot reports EOLLM missing');
  ok(snap.drift.ok === false, 'drift flags the missing engine');
  ok(snap.shape.gating.active === null, 'the shape verdict is indeterminate (not a false yes) with no engine');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
