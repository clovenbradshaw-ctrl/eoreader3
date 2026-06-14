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

  // Brief 2 (+ form-as-stamp patch): there is no shape prompt at all. The form
  // is a measured stamp (shape.js), never a prompt — so the entry is declared,
  // not a live model prompt.
  const shape = PF.promptById('shape');
  ok(shape.live === false, 'the shape entry is declared (no live model prompt — form is a measured stamp)');
  ok(/dissolved/i.test(shape.blurb) && /centroid|stamp/i.test(shape.blurb), 'the shape entry describes the dissolved shape pass / form-as-stamp');
  ok(!/FORM_LIBRARY/.test(String(LLM.FORM_LIBRARY)) && LLM.FORM_LIBRARY === undefined, 'there is no FORM_LIBRARY of prompt strings on EOLLM');
  ok(typeof LLM.formFor !== 'function', 'there is no formFor prompt-cue helper on EOLLM');
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

group('the shape pass is dissolved — no model call on any tier (the headline)', () => {
  // Brief 2: there is no shape-pass model call. The old per-tier "is it fed?"
  // verdict is gone; the verdict is fixed — dissolved — regardless of tier.
  for (const key of ['anthropic:claude-opus-4-8', 'wllama:llama32-3b', 'wllama:smollm2-135m']) {
    const sh = PF.shape(key);
    eq(sh.dissolved, true, key + ': the shape pass is reported dissolved');
    eq(sh.gating.modelCall, false, key + ': no shape-pass model call');
    eq(sh.gating.active, false, key + ': never active — there is no model call to be active');
  }
  // Its three jobs, three holders.
  const sh = PF.shape('anthropic:claude-opus-4-8');
  ok(/router/i.test(sh.move.holder) && /classifyIntent/i.test(sh.move.source), 'the MOVE is held by the router (classifyIntent)');
  ok(/centroid|stamp/i.test(sh.form.holder) && /formDegree/.test(sh.form.source), 'the FORM is a per-genre centroid measured on the output (a stamp)');
  ok(/witness|stamp/i.test(sh.confidence.holder) && /WI-7|truthfulness/i.test(sh.confidence.source), 'the CONFIDENCE is held by the witness stamp (WI-7)');
});

group('the talker writes voice-only — the form is NOT in the prompt (proof)', () => {
  const sh = PF.shape('anthropic:claude-opus-4-8');
  ok(sh.lands.live, 'buildUserContent rendered a sample answer-pass user message');
  ok(sh.lands.voiceOnly === true && sh.lands.noteMarker === null, 'there is no form/how-to-answer marker to inject');
  // The sample is a real grounded answer-pass message; it must carry the spans
  // and the question but NO how-to-answer / form block of any kind.
  ok(/quoted exactly/.test(sh.lands.sampleUserMessage), 'the sample carries the spans');
  ok(!/How to lay this answer out/i.test(sh.lands.sampleUserMessage), 'no "how to lay this answer out" block');
  ok(!/Editor's note/i.test(sh.lands.sampleUserMessage) && !/form only/i.test(sh.lands.sampleUserMessage), 'no editor\'s-note or form block at all — the talker writes voice-only');
});

group('flows bind to live prompts; the shape pass is gone', () => {
  const flows = {};
  for (const f of PF.flows()) flows[f.id] = f;
  ok(flows['grounded-llm'].usesShapePass === false, 'grounded-llm no longer uses a shape pass (dissolved)');
  ok(!flows['grounded-llm'].calls.some((c) => c.id === 'shape'), 'there is no shape-pass call in the grounded flow');
  ok(flows['plain-chat'].usesShapePass === false, 'plain-chat does not use the shape pass');
  ok(flows['creative'].usesShapePass === false, 'creative does not use the shape pass');
  ok(flows['mechanical'].calls.length === 0, 'mechanical makes zero model calls');
  // The grounded flow's single model call (the answer pass) binds the live grounded prompt.
  const answer = flows['grounded-llm'].calls.find((c) => c.id === 'answer');
  ok(answer.promptResolved && answer.promptResolved.text === LLM.systemFor('auto', 'qa', true, 1), 'the grounded answer call binds the live grounded prompt');
});

group('drift() is clean against the real llm.js', () => {
  const d = PF.drift();
  ok(d.ok === true, 'no drift errors against the live code');
  eq(d.issues.filter((i) => i.level === 'error').length, 0, 'zero error-level drift issues');
  ok(d.checked >= 3, 'the drift check actually exercised the live prompts (grounded / plain / creative; the shape pass is no longer a live prompt)');
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
  // Brief 2: the shape pass is dissolved as a structural fact, so the verdict
  // holds even with no engine — there is no model call to be "active".
  ok(snap.shape.dissolved === true, 'the shape pass reports dissolved even with no engine');
  ok(snap.shape.gating.active === false, 'never a false "yes" — there is no shape-pass model call');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
