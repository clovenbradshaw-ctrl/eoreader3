/* ============================================================
   Tests for the LLM prompt assembly (llm.js → window.EOLLM).

   llm.js is a browser script: an IIFE that publishes onto `window` and
   only dynamic-imports WebLLM from a CDN inside load()/phrase() — never at
   module load, and never from the pure helpers exercised here. So, like the
   engine/audit harnesses, we run it in a vm context with a fake `window` and
   read window.EOLLM back out.

   The contract under test is the one MLC/WebLLM enforces: a chat request may
   carry exactly one `system` message, and it must be first. assembleMessages
   used to emit a SECOND system message for the condensed history recap, which
   made chat.completions.create() throw "System prompt should always be the
   first message in `messages`." and silently dropped every grounded turn onto
   the mechanical fallback (i.e. summaries came back as raw, concatenated
   passages). This pins that down.

   Run with `node tests/llm.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadLLM() {
  const sandbox = { window: {}, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'llm.js'), 'utf8'), sandbox, { filename: 'llm.js' });
  if (!sandbox.window.EOLLM) throw new Error('llm.js did not publish window.EOLLM');
  return sandbox.window.EOLLM;
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); fn(); }

const LLM = loadLLM();
const systemCount = (messages) => messages.filter(m => m.role === 'system').length;

group('a condensed recap does not become a second system message', () => {
  // A history long enough that older turns are folded into a recap. Before the
  // fix that recap was emitted as its own system message at index 1 — the exact
  // shape WebLLM rejects, breaking grounded summaries for any real conversation.
  const history = [];
  for (let i = 0; i < 12; i++)
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} content` });

  const messages = LLM.assembleMessages({
    sys: 'SYS', history, contextText: '[s1] hello there',
    question: 'what is this?', grounded: true, recentTurns: 4,
  });

  eq(systemCount(messages), 1, 'exactly one system message');
  eq(messages[0].role, 'system', 'the system message is first');
  ok(messages.slice(1).every(m => m.role !== 'system'), 'no later message carries role:system');
  ok(messages[0].content.startsWith('SYS'), 'base system prompt is preserved at the front');
  ok(/Earlier conversation, condensed/.test(messages[0].content), 'the recap is folded into the system message');
  const last = messages[messages.length - 1];
  eq(last.role, 'user', 'the final message is the current user turn');
  ok(/what is this\?/.test(last.content), 'the question survives into the final user message');
});

group('short history needs no recap — still one system message, first', () => {
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const messages = LLM.assembleMessages({
    sys: 'SYS', history, contextText: '', question: 'continue', grounded: false,
  });
  eq(systemCount(messages), 1, 'exactly one system message');
  eq(messages[0].role, 'system', 'the system message is first');
  eq(messages[0].content, 'SYS', 'nothing is folded in when no turn is condensed');
});

group('no history — bare system + question', () => {
  const messages = LLM.assembleMessages({
    sys: 'SYS', history: [], contextText: '[s0] a passage',
    question: 'summarize', grounded: true,
  });
  eq(systemCount(messages), 1, 'exactly one system message');
  eq(messages[0].role, 'system', 'the system message is first');
  eq(messages.length, 2, 'system + the single user turn');
});

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
