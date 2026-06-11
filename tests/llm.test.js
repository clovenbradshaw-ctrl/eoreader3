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
  ok(/What I remember about it/.test(last.content), 'the user message carries the notes block');
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

// The grounded user message in the soft "respond to the user" frame: a plain
// instruction, the user's message up front, then the engine's material offered
// as AMBIENT context ("things on my mind that may or may not be relevant")
// rather than a brief to fill — and the old imperative scaffolding ("What this
// turn wants:" / "Answer the user's question:") gone, since the small model read
// that as the answer and parroted it. The message rides the closing line too
// (recency / anti-drift). A grounded caller without spans (the summary sample)
// gets the same frame around its blob; plain chat and creative are unchanged.
group('buildUserContent — ambient context frame, user message first and last', () => {
  const spans = [{ idx: 12, text: 'Until recently, his son served at Solaren.' }, { tag: 's11', text: 'The Director is David Corman.' }];
  const u = LLM.buildUserContent({ question: 'whose son is mentioned?', docTitle: 'NDP.txt', spans, notesProse: 'The son mentioned at [s12] is David Corman’s.', grounded: true });
  ok(u.startsWith('Respond to the user.'), 'opens with the plain instruction');
  ok(/^User: whose son is mentioned\?$/m.test(u), 'the user message rides up front');
  ok(/Now write your reply to the user\. They asked: whose son is mentioned\?$/.test(u), 'closes by restating the message (recency)');
  ok(/things on my mind that may or may not be relevant/i.test(u), 'context is framed as ambient, not a brief');
  ok(/From "NDP\.txt", word for word:/.test(u) && /\[s12\] Until recently/.test(u) && /\[s11\] The Director/.test(u), 'spans are listed verbatim with their tags, under the document');
  ok(/What I remember about it/.test(u) && /David Corman’s/.test(u), 'notes are their own tier');
  ok(u.indexOf('word for word') < u.indexOf('What I remember'), 'spans come before notes');
  ok(!/What this turn wants/.test(u) && !/Answer the user's question/.test(u), 'the old imperative scaffolding is gone (no parroting hook)');

  const blob = LLM.buildUserContent({ question: 'summarize this', contextText: '[s0] line one\n[s1] line two', grounded: true });
  ok(blob.startsWith('Respond to the user.'), 'blob fallback keeps the soft frame');
  ok(/^User: summarize this$/m.test(blob), 'blob fallback carries the user message');
  ok(/From the document:/.test(blob) && /\[s0\] line one/.test(blob), 'the blob rides as ambient material');

  eq(LLM.buildUserContent({ question: 'hi', grounded: false }), 'hi', 'plain chat: bare question unchanged');
  eq(LLM.buildUserContent({ question: 'write a poem', contextText: '[s0] x', grounded: false }),
    'Passages:\n[s0] x\n\nwrite a poem', 'creative/ungrounded passage shape unchanged');
  eq(LLM.buildUserContent({ question: 'q', grounded: true }), 'q', 'grounded with no material at all: bare question');
});

// The shape pass: a director's note, not a rubric. The system prompt is the
// taste surface — it characterizes the move and never answers; the note rides
// the context block as "what they seem to be after," before the spans, framed
// as one of the things on mind rather than an instruction to fulfil.
group('shape pass — a director\'s note folded into the context block', () => {
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
  ok(/· What they seem to be after: Bibliographic lookup/.test(u), 'the note rides as one of the things on mind');
  ok(u.indexOf('User: who wrote it?') < u.indexOf('What they seem to be after'), 'the user message orients first');
  ok(u.indexOf('What they seem to be after') < u.indexOf('word for word'), 'the note precedes the spans');
  ok(!/What this turn wants/.test(u), 'no imperative "What this turn wants:" header (the parroting hook)');
  const bare = LLM.buildUserContent({ question: 'q', spans: [{ idx: 1, text: 'x' }], grounded: true, shapeNote: '' });
  ok(!/What they seem to be after/.test(bare), 'no note ⇒ no empty block (answer pass unchanged)');
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

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
})();
