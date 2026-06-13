/* ============================================================
   evo/experiments/prompt-audit.js

   Examine the prompts the engine builds for the SMALL local model
   (WebLLM: Qwen2.5 0.5B/1.5B, Llama 3.2 1B, Phi 3.5 mini — q4f16
   prebuilds with a 4096-token context window).

   The pipeline under audit (mirrors app.jsx runGroundedScope → llm.js):

     intent  = classifyIntent(q)            — 'who'/'confirm' never reach the model
     ctx     = contextScope(scope, q, 6)    — or salientContext for summaries
     trav    = traverseScope(scope, q, hops)  (depth > 1)
     ctx     = readingContext(scope, trav, ctx)  — the graph speaks first
     sys     = EOLLM.systemFor('grounded', task, true, depth)
     msgs    = EOLLM.assembleMessages({ sys, history, contextText: ctx, question, grounded: true })
     phrase: temperature 0.12, max_tokens 180–520 by depth/task

   This harness assembles those EXACT artifacts over the corpus — no model,
   no API, deterministic — and measures what a 0.5B–3B model is actually
   handed: how big, how much of the 4k context it consumes, how many
   instructions it must hold, whether the graph preamble leaks the noise
   entities the queryability experiment found, and how honest the chars/4
   token estimate is on CJK text.

   Usage:
     node evo/experiments/prompt-audit.js                # tables
     node evo/experiments/prompt-audit.js --json out.json
     node evo/experiments/prompt-audit.js --dump pg219   # print one full prompt verbatim
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEngine } = require('../engine-host');

const REPO = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(__dirname, '..', 'corpus');

/* WebLLM prebuilt context window for every model the app ships (data.jsx):
   Qwen2.5-0.5B/1.5B, Llama-3.2-1B, Phi-3.5-mini — all 4096 in the MLC
   q4f16_1 prebuild configs. The budget math below is against this. */
const MODEL_CTX = 4096;

const DOCS = [
  { file: 'pg219.txt',  title: 'Heart of Darkness', lang: 'en' },
  { file: 'pg1237.txt', title: 'Father Goriot', lang: 'en' },
  { file: 'pg5200.txt', title: 'Metamorphosis', lang: 'en' },
  { file: 'pg600.txt',  title: 'Notes from Underground', lang: 'en' },
  { file: 'pg34901.txt', title: 'On Liberty', lang: 'en' },
  { file: 'pg3300.txt', title: 'Wealth of Nations', lang: 'en' },
  { file: 'akutagawa_rashomon.txt', title: 'Rashomon', lang: 'ja' },
];

function stripBoilerplate(t) {
  const a = t.indexOf('*** START');
  const start = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(start, b >= 0 ? b : t.length).trim();
}

/* Load llm.js for its pure prompt functions (systemFor / assembleMessages /
   summarizeTurns). It publishes onto `window`; nothing network-touching runs
   at load time (the WebLLM import is lazy, inside load()). */
function loadLLM() {
  const code = fs.readFileSync(path.join(REPO, 'llm.js'), 'utf8');
  const sandbox = { window: {}, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'llm.js' });
  return sandbox.window.EOLLM;
}

const est = (s) => Math.ceil(String(s || '').length / 4);  // llm.js's own estimate
/* A truer token estimate: CJK runs ~1 token/char (Qwen/Llama tokenizers),
   Latin ~1 token per 4 chars. Used to grade the chars/4 estimate, not to
   replace it. */
function estReal(s) {
  const str = String(s || '');
  let cjk = 0;
  for (const ch of str) if (/[　-鿿豈-﫿ｦ-ﾟ]/.test(ch)) cjk++;
  return Math.ceil(cjk + (str.length - cjk) / 4);
}

const r2 = (x) => Math.round(x * 100) / 100;
const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };

/* Count imperative instructions in a system prompt — a coarse load measure
   for a 0.5B model: each "never / do not / only / exactly / no X" clause is
   one more constraint it must hold while writing. */
function countConstraints(sys) {
  const m = String(sys).match(/\b(never|do not|don't|only|exactly|no\b|must|always|rather than|instead of)\b/gi);
  return m ? m.length : 0;
}

/* The noise-entity lexicon from the queryability experiment: capitalized
   common nouns the graph admits as entities. If these surface in the graph
   preamble ("It turns on Darkness", "appears with Change in …"), the noise
   has propagated from the graph into the model's prompt. */
function noiseEntitiesOf(E, doc) {
  const snap = (() => { try { return E.graphSnapshot(doc); } catch (e) { return { entities: [] }; } })();
  const lower = new Set(String(doc._text || '').split(/[^A-Za-zÀ-ÿ]+/)
    .filter(w => w && w === w.toLowerCase()).map(w => w.toLowerCase()));
  return (snap.entities || []).filter(e => !/\s/.test(e.name)
    && lower.has(String(e.name).toLowerCase().replace(/[^a-zà-ÿ]/g, ''))).map(e => e.name);
}

/* Chrome passages: retrieved lines that are title-page furniture, not prose —
   short, early, no verb shape. "[s0] Heart of Darkness / [s1] by Joseph
   Conrad / [s2] Contents" reaching the model as "passages from the document"
   is retrieval grabbing chrome. */
function countChrome(ctx) {
  let n = 0;
  for (const line of String(ctx).split('\n')) {
    const m = /^\[s(\d+)[^\]]*\]\s*(.*)$/.exec(line);
    if (m && +m[1] <= 6 && m[2].trim().length > 0 && m[2].trim().length < 40) n++;
  }
  return n;
}

/* Assemble one grounded turn exactly as app.jsx does (empty history = the
   first question of a session; history pressure is audited separately). */
function assembleTurn(E, L, doc, q, depth) {
  const task = E.classifyIntent(q) === 'summary' ? 'summary' : 'answer';
  const budget = E.thinkingBudget(depth);
  let ctx = E.contextScope([doc], q, 6);
  let trav = null, preamble = false;
  if (budget.graphHops > 0 && task !== 'summary') {
    try { trav = E.traverseScope([doc], q, budget.graphHops); } catch (e) {}
    if (trav) { ctx = E.readingContext([doc], trav, ctx); preamble = true; }
  }
  const sys = L.systemFor('grounded', task, true, depth);
  const messages = L.assembleMessages({ sys, history: [], contextText: ctx, question: q, grounded: true });
  const maxTokens = task === 'summary' ? 260 + (depth - 1) * 130 : 180 + (depth - 1) * 120;
  return { task, depth, sys, ctx, trav, preamble, messages, maxTokens };
}

function measureTurn(turn, noiseNames) {
  const all = turn.messages.map(m => m.content).join('\n');
  const passages = (turn.ctx.match(/^\[s?\d+[^\]]*\]/gm) || []).length;
  // The graph speaks in two places: the depth>1 traversal preamble, and the
  // salient header every summary-path context leads with ("What the reading
  // came to rest on: …"). Noise entities leak through EITHER.
  const header = turn.preamble ? turn.ctx.split('\n\nPassages:')[0]
    : (turn.ctx.split('\n\n[')[0].startsWith('What the reading') ? turn.ctx.split('\n\n[')[0] : '');
  const preLines = turn.preamble ? (header.match(/^- /gm) || []).length : 0;
  const noiseHits = noiseNames.filter(n => new RegExp('\\b' + n.replace(/[^\w]/g, '') + '\\b').test(header));
  const estTok = est(all), realTok = estReal(all);
  return {
    task: turn.task, depth: turn.depth,
    sysChars: turn.sys.length, sysConstraints: countConstraints(turn.sys),
    ctxChars: turn.ctx.length, passages, preambleLines: preLines,
    chrome: countChrome(turn.ctx),
    estTokens: estTok, realTokens: realTok, estDrift: r2(realTok / Math.max(1, estTok)),
    pctOfWindow: r2((realTok + turn.maxTokens) / MODEL_CTX * 100),
    maxTokens: turn.maxTokens,
    noiseLeaked: noiseHits,
  };
}

function fmtTable(rows, cols) {
  const widths = cols.map((c) => Math.max(c.h.length, ...rows.map(r => String(c.f(r)).length)));
  const line = (cells) => cells.map((s, i) => String(s).padEnd(widths[i])).join('  ');
  return [line(cols.map(c => c.h)), line(widths.map(w => '-'.repeat(w))),
    ...rows.map(r => line(cols.map(c => c.f(r))))].join('\n');
}

(async () => {
  const cap = parseInt(arg('--cap', '14000'), 10);
  const dump = arg('--dump', null);
  const jsonOut = arg('--json', null);

  const E = loadEngine().EOEngine;
  const L = loadLLM();

  /* ---- 1. the static system prompts themselves ---- */
  console.log('=== 1. SYSTEM PROMPT INVENTORY (llm.js systemFor) ===');
  const variants = [];
  for (const [mode, task, grounded, depth, label] of [
    ['chat', null, false, 1, 'plain chat'],
    ['grounded', 'answer', true, 1, 'grounded answer, depth 1'],
    ['grounded', 'answer', true, 2, 'grounded answer, depth 2'],
    ['grounded', 'answer', true, 3, 'grounded answer, depth 3'],
    ['grounded', 'summary', true, 1, 'grounded summary, depth 1'],
    ['grounded', 'summary', true, 3, 'grounded summary, depth 3'],
    ['creative', null, false, 1, 'creative'],
  ]) {
    const s = L.systemFor(mode, task, grounded, depth);
    variants.push({ label, chars: s.length, tokens: est(s), constraints: countConstraints(s), text: s });
  }
  console.log(fmtTable(variants, [
    { h: 'variant', f: r => r.label },
    { h: 'chars', f: r => r.chars },
    { h: '~tokens', f: r => r.tokens },
    { h: 'constraints', f: r => r.constraints },
  ]));

  /* ---- 2. intent routing: which phrasings reach the model with what ---- */
  console.log('\n=== 2. INTENT ROUTING — what each phrasing earns as context ===');
  console.log('(who → mechanical, never the model; confirm → graph-check, never the model;');
  console.log(' summary → salient sample + portrait header; factual → k=6 retrieval [+ graph walk at depth>1])');
  const PHRASINGS = [
    'who is NAME?', 'is NAME a sailor?', 'summarize this document',
    'what happens to NAME?', 'what happened to NAME?', 'what does NAME do?',
    'where does NAME go?', 'how does NAME change?', 'tell me about NAME',
    'what is this about?', 'walk me through the story',
  ];
  const routeRows = PHRASINGS.map(p => {
    const intent = E.classifyIntent(p.replace('NAME', 'Gregor'));
    const dest = intent === 'who' ? 'mechanical (no model)'
      : intent === 'confirm' ? 'graph-check (no model)'
      : intent === 'summary' ? 'model + SALIENT sample (generic)'
      : 'model + k=6 retrieval for the question';
    return { p, intent, dest };
  });
  console.log(fmtTable(routeRows, [
    { h: 'phrasing', f: r => r.p },
    { h: 'intent', f: r => r.intent },
    { h: 'context the model gets', f: r => r.dest },
  ]));
  const misroutes = routeRows.filter(r => /happens|happened/.test(r.p) && r.intent === 'summary');
  if (misroutes.length) {
    console.log('  ⚠ "' + misroutes.map(m => m.p).join('", "') + '" name a specific entity but route to the');
    console.log('    GENERIC summary sample — the model is asked about NAME while holding passages chosen');
    console.log('    with no knowledge of NAME. ("what happened to NAME?" routes factually; the present');
    console.log('    tense alone flips the route.)');
  }

  /* ---- 3. assembled grounded prompts over the corpus ---- */
  console.log('\n=== 3. ASSEMBLED GROUNDED PROMPTS (first turn, vs ' + MODEL_CTX + '-token window) ===');
  const rows = [];
  const dumps = [];
  for (const d of DOCS) {
    const text = stripBoilerplate(fs.readFileSync(path.join(CORPUS, d.file), 'utf8')).slice(0, cap);
    const doc = await E.parseDocument(d.file, text, d.file.replace('.txt', ''));
    const noise = noiseEntitiesOf(E, doc);
    const snap = (() => { try { return E.graphSnapshot(doc); } catch (e) { return { entities: [] }; } })();
    const top = (snap.entities || []).slice().sort((a, b) => (b.mass || 0) - (a.mass || 0))[0];
    const queries = [
      { q: 'summarize this document', kind: 'summary' },
      // a phrasing that routes FACTUAL, so depth>1 buys the graph walk
      ...(top ? [{ q: 'what does ' + top.name + ' do?', kind: 'factual' }] : []),
    ];
    for (const { q, kind } of queries) {
      for (const depth of [1, 3]) {
        const turn = assembleTurn(E, L, doc, q, depth);
        const m = measureTurn(turn, noise);
        rows.push({ doc: d.title, lang: d.lang, q: kind, ...m });
        if (dump && d.file.includes(dump) && depth === 3 && kind === 'factual') dumps.push({ d, q, turn });
      }
    }
  }
  console.log(fmtTable(rows, [
    { h: 'doc', f: r => r.doc.slice(0, 18) },
    { h: 'query', f: r => r.q },
    { h: 'depth', f: r => r.depth },
    { h: 'passages', f: r => r.passages },
    { h: 'walk', f: r => r.preambleLines ? r.preambleLines + ' lines' : '—' },
    { h: 'chrome', f: r => r.chrome || '—' },
    { h: 'ctx chars', f: r => r.ctxChars },
    { h: 'est tok', f: r => r.estTokens },
    { h: 'real tok', f: r => r.realTokens },
    { h: 'drift', f: r => r.estDrift + 'x' },
    { h: '% of 4k', f: r => r.pctOfWindow },
    { h: 'noise leaked', f: r => r.noiseLeaked.length ? r.noiseLeaked.join(',') : '—' },
  ]));
  const starved = rows.filter(r => r.passages <= 1 && r.q === 'factual');
  if (starved.length) {
    console.log('  Starved factual rows (≤1 passage): in the live app hasGround() routes these to the');
    console.log('  MECHANICAL path before the model is called — the model never sees an empty context.');
    console.log('  But the starvation itself is the graph↔retrieval gap: the question names the');
    console.log('  graph\'s heaviest entity and retrieval cannot find a single passage for it.');
  }

  /* ---- 4. history pressure: the budget math in a long session ---- */
  const DEF_BUDGET = L.DEFAULT_BUDGET != null ? L.DEFAULT_BUDGET : 7000;
  const estimator = typeof L.estTokens === 'function' ? L.estTokens : (s) => est(s);
  console.log('\n=== 4. HISTORY PRESSURE (synthetic 20-turn session, ~300-token turns; default budget ' + DEF_BUDGET + ') ===');
  const mkTurn = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: ('turn ' + i + ': ') + 'the quick brown fox jumps over the lazy dog and keeps going. '.repeat(20) });
  const hist = Array.from({ length: 20 }, (_, i) => mkTurn(i));
  const sys1 = L.systemFor('grounded', 'answer', true, 1);
  for (const budget of [...new Set([7000, DEF_BUDGET, 2200])]) {
    const msgs = L.assembleMessages({ sys: sys1, history: hist, contextText: '[s1] A passage.', question: 'and then?', grounded: true, budget });
    const total = msgs.reduce((a, m) => a + estimator(m.content), 0);
    const verbatim = msgs.length - 2;
    const recap = /Earlier conversation, condensed/.test(msgs[0].content);
    console.log('  budget ' + budget + (budget === DEF_BUDGET ? ' (default)' : '') + ': ' + verbatim + ' verbatim turns'
      + (recap ? ' + condensed recap folded into system' : ', no recap') + ' → ~' + total + ' est tokens'
      + '  (' + r2((total + 300) / MODEL_CTX * 100) + '% of the 4k window with a 300-token reply)');
  }
  if (DEF_BUDGET + 520 > MODEL_CTX) {
    console.log('  ⚠ the default budget (' + DEF_BUDGET + ') + max reply (520) exceeds the ' + MODEL_CTX + '-token window —');
    console.log('    the assembly only sheds history past the real ceiling; the caller\'s catch-retry');
    console.log('    (history.slice(-2), budget 2200) is the load-bearing recovery.');
  } else {
    console.log('  default budget (' + DEF_BUDGET + ') + max reply (520) fits the ' + MODEL_CTX + '-token window.');
  }
  const cjkProbe = 'ある日の暮方の事である。'.repeat(10);
  console.log('  CJK estimator check: ' + cjkProbe.length + ' JA chars → est ' + estimator(cjkProbe)
    + ' tokens (chars/4 would say ' + Math.ceil(cjkProbe.length / 4) + ')');

  /* ---- 5. the talker-portrait prompt (the evolvable one) ---- */
  console.log('\n=== 5. TALKER PORTRAIT PROMPT (engine.js talkerPortrait — evolvable surface) ===');
  {
    const text = stripBoilerplate(fs.readFileSync(path.join(CORPUS, 'pg1237.txt'), 'utf8')).slice(0, cap);
    const doc = await E.parseDocument('pg1237.txt', text, 'goriot-talker');
    let captured = null;
    await E.talkerPortrait(doc, { llm: (sys, user) => { captured = { sys, user }; return ''; } });
    if (captured) {
      console.log('  system: ' + captured.sys.length + ' chars (~' + est(captured.sys) + ' tok), '
        + countConstraints(captured.sys) + ' constraints');
      console.log('  user (existence+structure blocks): ' + captured.user.length + ' chars (~' + est(captured.user) + ' tok)');
      console.log('  contract: one paragraph, epistemic framing, EVA-audited, one retry with rejection');
      console.log('  reasons appended, deterministic fallback if both drafts fail.');
    } else {
      console.log('  (no heavy figures in this slice — portrait skipped)');
    }
  }

  if (dumps.length) {
    for (const { d, q, turn } of dumps) {
      console.log('\n=== FULL PROMPT DUMP — ' + d.title + ' · "' + q + '" · depth 3 ===');
      for (const m of turn.messages) console.log('--- ' + m.role + ' (' + m.content.length + ' chars) ---\n' + m.content);
    }
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ schema: 'cleo-prompt-audit/1', at: new Date().toISOString(), modelCtx: MODEL_CTX, variants, rows }, null, 1));
    console.log('\nwrote ' + jsonOut);
  }
})().catch(e => { console.error(e); process.exit(1); });
