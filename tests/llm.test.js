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

// A fresh module wired to a fake WebGPU + a fake WebLLM runtime, so load()'s
// download path (the stall watchdog, the resume-retry, cache-clearing) can be
// exercised in Node without the CDN. `webllm` stands in for the imported module
// (it needs CreateMLCEngine; optionally the delete* cache helpers); `stallMs`
// shrinks the watchdog so a "stall" resolves in milliseconds.
function loadLLMWith({ webllm, stallMs }) {
  const window = { EO_WEBLLM: webllm };
  if (stallMs != null) window.EO_STALL_MS = stallMs;
  const sandbox = { window, console, performance, navigator: { gpu: {} }, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'llm.js'), 'utf8'), sandbox, { filename: 'llm.js' });
  return sandbox.window.EOLLM;
}
const fakeEngine = () => ({ unloaded: false, unload() { this.unloaded = true; } });

// Like loadLLMWith, but also exposes a fake Worker/Blob/URL so load()'s WORKER
// path runs (off-main-thread engine, terminate-on-unload, cancel). `workers`
// collects every spawned worker so a test can assert on terminate(); a worker
// fires onerror on the next tick when `workerOnError` is set (simulating a
// blocked import → main-thread fallback). The fake webllm supplies
// CreateWebWorkerMLCEngine; CreateMLCEngine is the fallback the worker path
// should normally avoid.
function loadLLMWithWorker({ webllm, stallMs, workerOnError }) {
  const workers = [];
  class FakeWorker {
    constructor() {
      this.terminated = false; this.onerror = null; this.onmessageerror = null;
      workers.push(this);
      if (workerOnError) setTimeout(() => { if (this.onerror) this.onerror({ message: 'blocked' }); }, 0);
    }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  const window = { EO_WEBLLM: webllm };
  if (stallMs != null) window.EO_STALL_MS = stallMs;
  const sandbox = {
    window, console, performance, navigator: { gpu: {} }, setTimeout, clearTimeout,
    Worker: FakeWorker, Blob: function () {}, URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'llm.js'), 'utf8'), sandbox, { filename: 'llm.js' });
  return { LLM: sandbox.window.EOLLM, workers };
}

// A FAKE wllama runtime, injected via the window.EO_WLLAMA seam, so the CPU
// backend (load → loadModelFromUrl, streamChat → createChatCompletion) runs in
// Node with no CDN and no real WASM. The fake records loads/chats/exits and
// streams whatever chunks the test's `stream(opts)` supplies — the point is to
// exercise every chunk shape streamWllama tolerates (OpenAI delta, choices.text,
// cumulative currentText, and recover-from-return).
function makeFakeWllama(behavior = {}) {
  const calls = { loads: [], chats: [], exits: 0 };
  class FakeWllama {
    constructor(paths, cfg) { this.paths = paths; this.cfg = cfg; }
    async loadModelFromUrl(url, opts) {
      calls.loads.push({ url, opts });
      if (behavior.loadDelayMs) await new Promise(r => setTimeout(r, behavior.loadDelayMs));
      if (opts && opts.progressCallback) { opts.progressCallback({ loaded: 50, total: 100 }); opts.progressCallback({ loaded: 100, total: 100 }); }
    }
    async createChatCompletion(opts) {
      calls.chats.push(opts);
      if (behavior.stream) behavior.stream(opts);
      return behavior.finalReturn;
    }
    async exit() { calls.exits++; }
  }
  return { mod: { Wllama: FakeWllama, wasmPaths: { default: 'fake.wasm' } }, calls };
}
// Like loadLLMWith, but for the CPU path: no navigator.gpu (hasWebGPU must be
// false — the CPU path can't depend on it), WebAssembly present (hasWasm true),
// and the fake runtime on window.EO_WLLAMA.
function loadLLMWithWllama(mod) {
  const window = { EO_WLLAMA: mod };
  const sandbox = { window, console, performance, setTimeout, clearTimeout, navigator: {}, WebAssembly: { instantiate() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'llm.js'), 'utf8'), sandbox, { filename: 'llm.js' });
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

// Heat-ranked working memory (thinking depth > 1) renders as the model's own
// NOTES inside the USER message — turn context, not standing instruction —
// without breaking the one-system-message-first invariant, and still shrinks
// the verbatim recency window. Absent/empty working memory must be
// byte-identical to having none.
group('working memory becomes first-person notes in the user message (depth > 1)', () => {
  const wm = {
    hot: [{ entity: 'Edith', heat: 2, sents: [{ i: 1, t: 'She set the kettle down and listened.' }] }],
    warm: [{ entity: 'Marlow', oneHopFrom: 'Edith', portraitLine: 'Edith thought about Marlow.' }],
    cold: [{ label: 'the boat', sentRange: [3, 3] }],
    recalled: [],
  };
  const history = [];
  for (let i = 0; i < 10; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} content here` });
  const messages = LLM.assembleMessages({ sys: 'SYS', history, contextText: '[s1] hi', question: 'what now?', grounded: true, workingMemory: wm });
  eq(systemCount(messages), 1, 'exactly one system message with working memory present');
  eq(messages[0].role, 'system', 'the system message is first');
  ok(messages.slice(1).every(m => m.role !== 'system'), 'working memory does not become a second system message');
  ok(messages[0].content.startsWith('SYS'), 'the base system prompt is preserved at the front');
  ok(!/Things in focus/.test(messages[0].content), 'the notes do NOT live in the system message');
  const last = messages[messages.length - 1];
  eq(last.role, 'user', 'the final message is the current user turn');
  ok(/Your notes on the document/.test(last.content), 'the user message carries the notes block');
  ok(/Edith/.test(last.content) && /Marlow/.test(last.content), 'hot and warm entities appear in the notes');
  ok(/the boat/.test(last.content), 'a cooled pointer is listed in the notes');
  ok(/^Things in focus right now:/m.test(LLM.renderNotes(wm)), 'notes render in the model\'s own voice');
});

group('working memory shrinks the verbatim recency window', () => {
  const history = [];
  for (let i = 0; i < 12; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` });
  const wm = { hot: [{ entity: 'Edith', sents: [] }], warm: [], cold: [], recalled: [] };
  const verbatim = (msgs) => msgs.slice(1, -1).length;   // drop the system head and the tail question
  const withWM = LLM.assembleMessages({ sys: 'SYS', history, contextText: '', question: 'q', grounded: false, budget: 100000, workingMemory: wm });
  const without = LLM.assembleMessages({ sys: 'SYS', history, contextText: '', question: 'q', grounded: false, budget: 100000 });
  ok(verbatim(withWM) <= 3, 'with working memory, at most 3 turns are kept verbatim');
  ok(verbatim(without) > verbatim(withWM), 'without working memory, more turns are kept verbatim');
});

group('no working memory ⇒ byte-identical to before (parity floor)', () => {
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const base = { sys: 'SYS', history, contextText: '[s1] x', question: 'q', grounded: true };
  const a = LLM.assembleMessages(base);
  const b = LLM.assembleMessages({ ...base, workingMemory: null });
  const c = LLM.assembleMessages({ ...base, workingMemory: { hot: [], warm: [], cold: [], recalled: [] } });
  eq(JSON.stringify(a), JSON.stringify(b), 'workingMemory:null matches the no-arg path');
  eq(JSON.stringify(a), JSON.stringify(c), 'an empty workingMemory matches the no-arg path');
  eq(LLM.renderWorkingMemory(null), '', 'renderWorkingMemory(null) is empty');
  eq(LLM.renderWorkingMemory({ hot: [], warm: [], cold: [], recalled: [] }), '', 'an empty working memory renders empty');
});

// The grounded prompt is the notes-and-spans framing: spans are verbatim and
// win conflicts; notes are the reader's own understanding; names/dates in a
// span are USED, not echoed back. No hardcoded length prescriptions — the
// model answers as it sees fit (depth scales max_tokens, nothing else, so
// the prompt is identical at every depth). The faithfulness contract
// survives the reframe: a plain "the document doesn't say" refusal (the
// veto's modelDeclined watches that shape), no model-written citations, and
// the summary keeps its degeneracy guard (never a single span as the answer).
group('the grounded prompt: notes-and-spans framing, no length prescriptions', () => {
  const ans1 = LLM.systemFor('grounded', 'answer', true, 1);
  const ans2 = LLM.systemFor('grounded', 'answer', true, 2);
  const ans3 = LLM.systemFor('grounded', 'answer', true, 3);
  const sum1 = LLM.systemFor('grounded', 'summary', true, 1);
  const sum3 = LLM.systemFor('grounded', 'summary', true, 3);

  eq(ans1, LLM.systemFor('grounded', 'answer', true), 'answer @ depth 1 == default (no depth arg)');
  eq(ans1, ans2, 'depth does not change the prompt (it scales max_tokens instead)');
  eq(ans2, ans3, 'the prompt is one prompt at every depth');
  eq(sum1, sum3, 'the summary prompt is depth-invariant too');
  ok(!/\b(one or two|2 to 4|4 to 6) sentences\b/.test(ans1 + sum1), 'no sentence-count prescriptions anywhere');
  ok(/never copy or lightly reword a single span/.test(sum1), 'the summary keeps its degeneracy guard');
  ok(!/never copy or lightly reword/.test(ans1), 'the answer prompt carries no summary instruction');

  for (const [name, s] of [['answer', ans1], ['summary', sum1]]) {
    ok(/the span wins/.test(s), `${name}: spans win over notes`);
    ok(/use it directly — don't echo the question's wording back/.test(s), `${name}: substitution over literalism (the "who wrote it?" fix)`);
    ok(/say plainly that the document doesn't say/.test(s), `${name}: keeps a plain, detectable refusal`);
    ok(/citation markers/.test(s), `${name}: still forbids model-written citations`);
    ok(/in neither the spans nor your notes/i.test(s), `${name}: nothing beyond spans + notes`);
  }
});

// resolveMaxTokens: depth scales the grounded caps; the shape layer's best-fit
// budget (override) wins when present, clamped to the safe window. With no
// override the result is byte-identical to the old inline formula (parity).
group('resolveMaxTokens — depth-scaled default, shape override wins, clamped', () => {
  const R = (a) => LLM.resolveMaxTokens(a);
  // Parity: the exact ceilings the old inline formula produced.
  eq(R({ grounded: true, task: 'answer', depth: 1 }), 180, 'grounded answer @ depth 1 == 180 (today)');
  eq(R({ grounded: true, task: 'answer', depth: 3 }), 420, 'grounded answer @ depth 3 == 420');
  eq(R({ grounded: true, task: 'summary', depth: 1 }), 260, 'grounded summary @ depth 1 == 260');
  eq(R({ grounded: true, task: 'summary', depth: 3 }), 520, 'grounded summary @ depth 3 == 520');
  eq(R({ mode: 'creative' }), 320, 'creative == 320');
  eq(R({ grounded: false }), 360, 'plain chat == 360');
  eq(R({ grounded: true, task: 'answer' }), 180, 'absent depth is treated as depth 1 (parity)');
  // Override: the shape layer's best-fit budget takes over, clamped to [24, 520].
  eq(R({ grounded: true, task: 'answer', depth: 1, override: 64 }), 64, 'a shape budget overrides the default cap');
  eq(R({ grounded: true, task: 'answer', depth: 3, override: 40 }), 40, 'the override wins regardless of depth');
  eq(R({ grounded: true, task: 'answer', override: 5 }), 24, 'a tiny override is floored at 24');
  eq(R({ grounded: true, task: 'answer', override: 9000 }), 520, 'a huge override is capped at 520');
  eq(R({ grounded: true, task: 'answer', override: 0 }), 180, 'a non-positive override is ignored (default applies)');
  eq(R({ grounded: true, task: 'answer', override: 'x' }), 180, 'a non-numeric override is ignored (parity)');
  eq(R({ grounded: true, task: 'answer', override: 99.6 }), 100, 'a fractional override is rounded');
});

// The tiered user message: question first (orientation), spans quoted
// exactly, notes as their own level, the question again as the closing
// instruction. A grounded caller without spans (the summary sample) gets the
// same frame around its blob; plain chat and creative are unchanged.
group('buildUserContent — tiered spans/notes, question first and last', () => {
  const spans = [{ idx: 12, text: 'Until recently, his son served at Solaren.' }, { tag: 's11', text: 'The Director is David Corman.' }];
  const u = LLM.buildUserContent({ question: 'whose son is mentioned?', docTitle: 'NDP.txt', spans, notesProse: 'The son mentioned at [s12] is David Corman’s.', grounded: true });
  ok(u.startsWith('The user just asked: whose son is mentioned?'), 'opens with the question (orientation)');
  ok(/Answer the user's question: whose son is mentioned\?$/.test(u), 'closes with the question (instruction)');
  ok(/reading a document called "NDP\.txt"/.test(u), 'names the document');
  ok(/quoted exactly:/.test(u) && /\[s12\] Until recently/.test(u) && /\[s11\] The Director/.test(u), 'spans are listed with their tags');
  ok(/Your notes on the document/.test(u) && /David Corman’s/.test(u), 'notes are their own tier');
  ok(u.indexOf('quoted exactly') < u.indexOf('Your notes'), 'spans come before notes');

  const blob = LLM.buildUserContent({ question: 'summarize this', contextText: '[s0] line one\n[s1] line two', grounded: true });
  ok(blob.startsWith('The user just asked: summarize this'), 'blob fallback keeps the question-first frame');
  ok(/Material from the document:/.test(blob) && /\[s0\] line one/.test(blob), 'the blob rides as material');

  eq(LLM.buildUserContent({ question: 'hi', grounded: false }), 'hi', 'plain chat: bare question unchanged');
  eq(LLM.buildUserContent({ question: 'write a poem', contextText: '[s0] x', grounded: false }),
    'Passages:\n[s0] x\n\nwrite a poem', 'creative/ungrounded passage shape unchanged');
  eq(LLM.buildUserContent({ question: 'q', grounded: true }), 'q', 'grounded with no material at all: bare question');
});

// The shape pass: a director's note, not a rubric. The system prompt is the
// taste surface — it characterizes the move and never answers; the note
// rides the user message AFTER the spans, as closing guidance about HOW to
// answer. The old order (note before spans, labeled "What this turn wants:")
// let a small model read the note as a synopsis and pre-frame the spans it
// hadn't reached yet — Cleon parroted "the author is not named" even when
// the Author: span sat right below. Spans-before-note inverts that.
group('shape pass — a director\'s note AFTER spans, framed as guidance', () => {
  ok(/never answer the question yourself/.test(LLM.SHAPE_SYSTEM), 'the shape prompt forbids answering');
  ok(/never state facts about the document/.test(LLM.SHAPE_SYSTEM), '…and forbids inventing document facts');
  ok(/what's the point of the book\?/.test(LLM.SHAPE_SYSTEM), 'synthesis example present (the taste lives in examples)');
  ok(/who wrote it\?/.test(LLM.SHAPE_SYSTEM) && /never "the author"/.test(LLM.SHAPE_SYSTEM), 'lookup example demands the name, not "the author"');
  ok(/project gutenberg is a character\?/.test(LLM.SHAPE_SYSTEM) && /repair, not fresh retrieval/.test(LLM.SHAPE_SYSTEM), 'pushback example routes as repair');
  ok(typeof LLM.shapePass === 'function', 'shapePass is exposed');

  const u = LLM.buildUserContent({
    question: 'who wrote it?', docTitle: 'crime.txt',
    spans: [{ idx: 4, text: 'Author: Fyodor Dostoyevsky' }],
    notesProse: '', grounded: true,
    shapeNote: 'Bibliographic lookup. They want the name — one line.',
  });
  ok(/Editor's note on HOW to handle this turn[^\n]*:\nBibliographic lookup/.test(u), 'the note has its own block, labeled as guidance about HOW (not WHAT)');
  ok(/not facts about the document; only the spans supply facts/.test(u), 'the label spells out that the note is not source material');
  ok(u.indexOf('The user just asked') < u.indexOf("Editor's note"), 'question orients first');
  ok(u.indexOf('quoted exactly') < u.indexOf("Editor's note"), 'spans come BEFORE the editor note (facts before guidance, so a leaky note can\'t pre-frame the spans)');
  ok(u.indexOf("Editor's note") < u.lastIndexOf("Answer the user's question"), 'the editor note closes the context, just above the answer prompt');
  const bare = LLM.buildUserContent({ question: 'q', spans: [{ idx: 1, text: 'x' }], grounded: true, shapeNote: '' });
  ok(!/Editor's note/.test(bare), 'no note ⇒ no empty block (answer pass unchanged)');
  ok(!/What this turn wants/.test(u) && !/What this turn wants/.test(bare), 'the old "What this turn wants:" label is gone (read as a synopsis by small models)');

  // The grounded system prompt names the editor's note as a third context
  // type and tells Cleon it's guidance, not source — the standing guard
  // that backs the reorder. Without it, a model that still reads the note
  // as facts has nothing in the system prompt to pull it back.
  const sys = LLM.systemFor('grounded', 'answer', true, 1);
  ok(/editor.s note/i.test(sys), 'grounded system prompt names the editor\'s note');
  ok(/guidance about your move, not as source material/i.test(sys), '…and frames it as guidance, not source');
  ok(/only the spans supply facts/i.test(sys), '…and pins facts to the spans');
});

// Reasoning-model think gating: tagged chain-of-thought never reaches the
// user — not in the stream (the delta filter), not in the returned answer
// (the post-strip) — including when max_tokens cuts the turn mid-think and
// the close tag never arrives.
group('think gating — reasoning never reaches the user', () => {
  eq(LLM.stripThink('<think>step 1… step 2…</think>The author is Dostoyevsky.'),
    'The author is Dostoyevsky.', 'a closed think block is stripped from the returned text');
  eq(LLM.stripThink('<think>ran out of tok'), '', 'an UNCLOSED think tail (max_tokens cutoff) is dropped entirely');
  eq(LLM.stripThink('plain answer, no tags'), 'plain answer, no tags', 'text without tags passes through');
  eq(LLM.stripThink('a<think>x</think>b<think>y</think>c'), 'abc', 'multiple think blocks all stripped');

  // The streaming filter: emit only outside-think text, even when the tags
  // split across deltas; flush() releases the held look-behind at stream end.
  const seen = [];
  const f = LLM.makeThinkFilter(d => seen.push(d));
  for (const d of ['Hello <th', 'ink>secret reaso', 'ning</thi', 'nk> world!']) f.feed(d);
  f.flush();
  eq(seen.join(''), 'Hello  world!', 'split-across-deltas tags are caught; only non-think text streams');
  const seen2 = [];
  const f2 = LLM.makeThinkFilter(d => seen2.push(d));
  f2.feed('<think>never closes because max_tokens'); f2.flush();
  eq(seen2.join(''), '', 'an unclosed think stream emits nothing');
  const seen3 = [];
  const f3 = LLM.makeThinkFilter(d => seen3.push(d));
  f3.feed('no tags at all'); f3.flush();
  eq(seen3.join(''), 'no tags at all', 'tag-free streaming is unchanged');
});

// ---- the download path: stall watchdog + resume-retry + cache reset ----
// The bug these pin down: load() used to await WebLLM's CreateMLCEngine with no
// timeout, so a hung shard fetch (or a dead CDN) left the promise pending
// forever — the progress bar froze and never recovered. Now a stall surfaces as
// a recoverable error, a transient stall self-heals via one resume-retry, and a
// genuinely moving (slow) download is never mistaken for a stall.
async function groupA(name, fn) { console.log('• ' + name); await fn(); }

(async () => {
  await groupA('a stalled download rejects (does not hang) and isLoaded stays false', async () => {
    // CreateMLCEngine that never resolves and never reports progress — the exact
    // shape of a hung fetch. With a 20ms watchdog, load() retries once and then
    // rejects in ~40ms instead of hanging.
    const LLM = loadLLMWith({ stallMs: 20, webllm: { CreateMLCEngine: () => new Promise(() => {}) } });
    let threw = false, msg = '';
    const t0 = Date.now();
    try { await LLM.load('Stuck-Model', () => {}); } catch (e) { threw = true; msg = e.message || ''; }
    ok(threw, 'load() rejects on a stall rather than hanging forever');
    ok(/stall/i.test(msg), 'the error explains the download stalled');
    ok(/cached|resume/i.test(msg), 'the error tells the user a retry resumes from cache');
    ok(Date.now() - t0 < 2000, 'it gives up promptly (watchdog fired) instead of blocking');
    eq(LLM.isLoaded('Stuck-Model'), false, 'a stalled model never reports as loaded');
  });

  await groupA('a transient stall self-heals via one resume-retry', async () => {
    // First build stalls (no progress, never resolves); the retry succeeds. The
    // watchdog must abandon the first attempt and the second must win.
    let calls = 0;
    const eng = fakeEngine();
    const LLM = loadLLMWith({ stallMs: 20, webllm: {
      CreateMLCEngine: () => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve(eng); },
    } });
    const out = await LLM.load('Flaky-Model', () => {});
    eq(calls, 2, 'the first (stalled) build is retried exactly once');
    ok(out === eng, 'the resume-retry resolves to the engine');
    eq(LLM.isLoaded('Flaky-Model'), true, 'after the retry the model reports loaded');
  });

  await groupA('a slow-but-moving download is never killed by the watchdog', async () => {
    // Progress ticks every 10ms under a 40ms watchdog: each tick re-arms it, so
    // a genuinely-downloading model resolves even though it takes longer than one
    // watchdog window end-to-end. Progress text reaches the caller.
    const eng = fakeEngine();
    const seen = [];
    const LLM = loadLLMWith({ stallMs: 40, webllm: {
      CreateMLCEngine: (key, opts) => new Promise((resolve) => {
        let n = 0;
        const tick = () => {
          n++;
          opts.initProgressCallback({ progress: n / 4, text: 'Fetching shard ' + n });
          if (n >= 4) resolve(eng); else setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
      }),
    } });
    const out = await LLM.load('Slow-Model', (p, text) => seen.push([p, text]));
    ok(out === eng, 'a steadily-progressing download resolves');
    ok(seen.length >= 4, 'every progress tick is forwarded to the caller');
    ok(seen.some(([, t]) => /Fetching shard/.test(t || '')), 'WebLLM\'s live status text reaches the UI (so it reads as alive, not stuck)');
    ok(Math.abs(seen[seen.length - 1][0] - 1) < 1e-9, 'progress reaches 100%');
  });

  await groupA('clearCache wipes a model\'s cached shards (the stuck-cache escape hatch)', async () => {
    let cleared = null;
    const LLM = loadLLMWith({ stallMs: 20, webllm: {
      CreateMLCEngine: () => Promise.resolve(fakeEngine()),
      deleteModelAllInfoInCache: async (k) => { cleared = k; },
    } });
    const did = await LLM.clearCache('Corrupt-Model');
    eq(did, true, 'clearCache reports it cleared something');
    eq(cleared, 'Corrupt-Model', 'the right model\'s cache is wiped');
    const none = await loadLLMWith({ stallMs: 20, webllm: { CreateMLCEngine: () => Promise.resolve(fakeEngine()) } }).clearCache('X');
    eq(none, false, 'clearCache is a no-op (false) when the runtime exposes no cache helpers');
  });

  // ---- the worker path: off-main-thread load, terminate-on-switch, cancel ----
  // Loading on the main thread froze the UI for the whole multi-GB compile. The
  // engine now runs in a Web Worker; switching models terminates the old worker
  // (freeing the GPU device), a worker that can't start falls back to the main
  // thread, and a user can cancel an in-flight load outright.
  await groupA('the engine loads in a Worker, and switching models terminates the old one', async () => {
    const made = [];
    const webllm = {
      CreateWebWorkerMLCEngine: (worker, key, opts) => {
        if (opts && opts.initProgressCallback) opts.initProgressCallback({ progress: 1, text: 'ready' });
        const e = fakeEngine(); e.key = key; made.push(key); return Promise.resolve(e);
      },
      CreateMLCEngine: () => { throw new Error('main-thread engine used despite an available worker'); },
    };
    const { LLM, workers } = loadLLMWithWorker({ stallMs: 1000, webllm });
    const e1 = await LLM.load('Model-A', () => {});
    ok(e1 && e1.key === 'Model-A', 'load resolves to the worker-hosted engine');
    eq(made.length, 1, 'the worker engine was built (not the main-thread one)');
    eq(workers.length, 1, 'one worker was spawned');
    eq(workers[0].terminated, false, 'the worker stays alive while its model is resident');
    await LLM.load('Model-B', () => {});
    eq(workers[0].terminated, true, 'switching models terminates the previous worker (frees the GPU device)');
    eq(LLM.isLoaded('Model-B'), true, 'the newly-loaded model reports ready');
  });

  await groupA('a worker that can\'t start falls back to the main thread (load still succeeds)', async () => {
    let workerTries = 0, mainBuilds = 0;
    const webllm = {
      CreateWebWorkerMLCEngine: () => { workerTries++; return new Promise(() => {}); },   // never resolves; onerror drives the fallback
      CreateMLCEngine: (key, opts) => { mainBuilds++; if (opts && opts.initProgressCallback) opts.initProgressCallback({ progress: 1, text: 'ready' }); return Promise.resolve(fakeEngine()); },
    };
    const { LLM, workers } = loadLLMWithWorker({ stallMs: 1000, webllm, workerOnError: true });
    const e = await LLM.load('Fallback-Model', () => {});
    ok(workerTries >= 1, 'the worker path is attempted first');
    eq(mainBuilds, 1, 'it falls back to a main-thread engine when the worker fails to start');
    ok(e && typeof e.unload === 'function', 'load resolves to an engine after the fallback');
    eq(workers[0].terminated, true, 'the dead worker is terminated, not left running');
    eq(LLM.isLoaded('Fallback-Model'), true, 'the model reports ready after falling back');
  });

  await groupA('cancelLoad stops an in-flight worker load (CANCEL) and never tears down a ready model', async () => {
    const webllm = {
      CreateWebWorkerMLCEngine: (worker, key, opts) => {
        if (opts && opts.initProgressCallback) opts.initProgressCallback({ progress: 0.2, text: 'fetching' });
        return new Promise(() => {});   // progresses, then hangs → a genuine in-flight load
      },
      CreateMLCEngine: () => { throw new Error('fell through to the main thread on cancel'); },
    };
    const { LLM, workers } = loadLLMWithWorker({ stallMs: 5000, webllm });
    let err = null;
    const p = LLM.load('Cancellable', () => {}).then(() => 'resolved', (e) => { err = e; return 'rejected'; });
    await new Promise(r => setTimeout(r, 5));   // let the build start and report progress
    eq(LLM.cancelLoad(), true, 'cancelLoad reports it canceled an in-flight load');
    eq(await p, 'rejected', 'the in-flight load rejects when canceled');
    ok(err && err.code === 'CANCEL', 'it rejects with a CANCEL code so the UI can stay quiet');
    eq(workers[0].terminated, true, 'the worker is terminated so the download halts immediately');
    eq(LLM.isLoaded('Cancellable'), false, 'a canceled model never reports loaded');
    eq(LLM.cancelLoad(), false, 'cancelLoad is a no-op when nothing is loading (can\'t tear down a ready model)');
  });

  // ---- the wllama (CPU / WebAssembly) backend ----
  // The dependable fallback that phrases when there's no WebGPU or a GPU model
  // stalls. These pin the dispatch (a wllama: key routes to the CPU runtime, not
  // WebGPU) and the chunk-shape tolerance, against a fake runtime.
  group('wllama backend — key detection, registry, and the fallback key', () => {
    ok(LLM.isWllama('wllama:qwen25-05b'), 'a wllama: key is detected');
    ok(!LLM.isWllama('anthropic:claude-opus-4-8'), 'an anthropic key is not a wllama key');
    ok(!LLM.isWllama('Qwen2.5-0.5B-Instruct-q4f16_1-MLC'), 'a WebLLM (GPU) key is not a wllama key');
    ok(typeof LLM.fallbackKey() === 'string' && /^wllama:/.test(LLM.fallbackKey()), 'fallbackKey() names a wllama model');
    const reg = LLM.wllamaModels();
    ok(reg && Object.keys(reg).length >= 1, 'wllamaModels() exposes the id→source registry');
    ok(Object.values(reg).every(m => m && /^https?:/.test(m.url)), 'every registry entry carries a model URL');
  });

  await groupA('a wllama model loads on the CPU (no WebGPU) and reports ready', async () => {
    const { mod, calls } = makeFakeWllama({ stream: () => {} });
    const LLM2 = loadLLMWithWllama(mod);
    eq(LLM2.hasWebGPU(), false, 'the CPU path runs with no WebGPU present');
    ok(LLM2.hasWasm(), 'hasWasm() is true when WebAssembly exists');
    const seen = [];
    const eng = await LLM2.load('wllama:qwen25-05b', (p, t) => seen.push([p, t]));
    ok(eng && eng.wllama, 'load resolves to an engine carrying the wllama instance');
    eq(LLM2.isLoaded('wllama:qwen25-05b'), true, 'isLoaded is true after the CPU model loads');
    eq(calls.loads.length, 1, 'the GGUF is loaded exactly once');
    ok(/huggingface\.co/.test(calls.loads[0].url), 'it loads the registry’s model URL');
    ok(seen.some(([p]) => Math.abs(p - 1) < 1e-9), 'download progress reaches 100%');
  });

  await groupA('streamWllama tolerates every chunk shape (via phrase → streamChat)', async () => {
    // OpenAI delta shape: chunk.choices[0].delta.content
    let LLM2 = loadLLMWithWllama(makeFakeWllama({ stream: (opts) => {
      opts.onData({ choices: [{ delta: { content: 'Hel' } }] });
      opts.onData({ choices: [{ delta: { content: 'lo' } }] });
    } }).mod);
    let toks = [];
    let out = await LLM2.phrase({ mlcKey: 'wllama:qwen25-05b', question: 'hi', mode: 'chat', grounded: false, history: [], onToken: d => toks.push(d) });
    eq(out, 'Hello', 'OpenAI delta chunks stream and concatenate');
    eq(toks.join(''), 'Hello', '…and reach onToken as deltas');

    // choices[0].text shape
    LLM2 = loadLLMWithWllama(makeFakeWllama({ stream: (opts) => {
      opts.onData({ choices: [{ text: 'Hi ' }] });
      opts.onData({ choices: [{ text: 'there' }] });
    } }).mod);
    out = await LLM2.phrase({ mlcKey: 'wllama:qwen25-05b', question: 'hi', mode: 'chat', grounded: false, history: [], onToken: () => {} });
    eq(out, 'Hi there', 'choices[].text chunks are handled too');

    // cumulative currentText via onNewToken (older streaming API): deltas are
    // computed from the growing cumulative string.
    LLM2 = loadLLMWithWllama(makeFakeWllama({ finalReturn: 'Hello!', stream: (opts) => {
      opts.onNewToken('A', 'A', 'Hel');
      opts.onNewToken('B', 'B', 'Hello');
      opts.onNewToken('C', 'C', 'Hello!');
    } }).mod);
    toks = [];
    out = await LLM2.phrase({ mlcKey: 'wllama:qwen25-05b', question: 'hi', mode: 'chat', grounded: false, history: [], onToken: d => toks.push(d) });
    eq(out, 'Hello!', 'cumulative currentText is turned into deltas');
    eq(toks.join(''), 'Hello!', '…with no duplication across chunks');

    // no streaming callbacks fire → recover the final text from the return value
    LLM2 = loadLLMWithWllama(makeFakeWllama({ finalReturn: 'Recovered', stream: () => {} }).mod);
    out = await LLM2.phrase({ mlcKey: 'wllama:qwen25-05b', question: 'hi', mode: 'chat', grounded: false, history: [], onToken: () => {} });
    eq(out, 'Recovered', 'a non-streaming build still yields its answer (recovered from the return)');
  });

  await groupA('cancelLoad frees an in-flight CPU load (CANCEL) and leaves it unloaded', async () => {
    const { mod, calls } = makeFakeWllama({ loadDelayMs: 30, stream: () => {} });
    const LLM2 = loadLLMWithWllama(mod);
    const p = LLM2.load('wllama:qwen25-05b', () => {}).then(() => 'resolved', (e) => 'rejected:' + (e && e.code));
    await new Promise(r => setTimeout(r, 5));        // load in-flight, before the GGUF resolves
    eq(LLM2.cancelLoad(), true, 'cancelLoad reports it canceled the in-flight CPU load');
    ok(calls.exits >= 1, 'cancel frees the CPU runtime (exit was called)');
    eq(await p, 'rejected:CANCEL', 'the canceled CPU load rejects with a CANCEL code');
    eq(LLM2.isLoaded('wllama:qwen25-05b'), false, 'a canceled CPU model never reports loaded');
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
})();
