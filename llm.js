/* ============================================================
   EO Reader — optional local LLM (WebLLM / WebGPU).
   The mechanical engine answers without this. When a model is loaded,
   it only PHRASES answers over retrieved context; citations are still
   bound mechanically by the engine, never written by the model.
   ============================================================ */
(function () {
  let enginePromise = null;
  let loadedModel = null;
  let mod = null;
  let loadToken = 0;   // bumped per load(); a superseded in-flight build goes inert

  const hasWebGPU = () => typeof navigator !== 'undefined' && !!navigator.gpu;

  // The model runtime won't load forever: a dead/blocked CDN (esm.run) used to
  // leave the import pending with no signal, which looked exactly like a frozen
  // download. Race the import against a timeout so it fails loudly instead.
  const IMPORT_TIMEOUT_MS = 30000;
  async function importWebLLM() {
    if (mod) return mod;
    // A test seam (and an injection point for an alternate runtime): if a module
    // is supplied on window, use it instead of reaching for the network.
    if (typeof window !== 'undefined' && window.EO_WEBLLM) { mod = window.EO_WEBLLM; return mod; }
    // ESM CDN — loaded on demand so the app starts instantly without it.
    // Pinned to an exact version (was unversioned): a floating major could
    // change the loader API or model defaults under us with no warning.
    const imported = import('https://esm.run/@mlc-ai/web-llm@0.2.79');
    let to;
    const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(Object.assign(new Error('Loading the model runtime from the CDN timed out — check your connection or any content blocker, then try again.'), { code: 'IMPORT_TIMEOUT' })), IMPORT_TIMEOUT_MS); });
    try { mod = await Promise.race([imported, timeout]); }
    finally { clearTimeout(to); }
    return mod;
  }

  async function createEngine(mlcKey, opts) {
    const webllm = await importWebLLM();
    return webllm.CreateMLCEngine(mlcKey, opts);
  }

  // No init-progress callback for this long ⇒ the download has stalled. WebLLM
  // fires the callback per fetched chunk and per compiled shader, so a full
  // minute of total silence is a genuine hang (a dropped connection, a blocked
  // CDN, a corrupt cache entry), never just a slow-but-moving download — every
  // callback re-arms the watchdog. Overridable for tests via window.EO_STALL_MS.
  const STALL_MS = (typeof window !== 'undefined' && +window.EO_STALL_MS) || 60000;

  // One build attempt, guarded by a stall watchdog. Resolves with the engine, or
  // rejects with code:'STALL' if no progress arrives for STALL_MS — so a hung
  // fetch surfaces as a recoverable error instead of an eternal spinner. A build
  // that finishes after the watchdog gave up (or after a newer load superseded
  // it) unloads itself so it can't leak GPU memory.
  function buildOnce(mlcKey, onProgress, myToken) {
    return new Promise((resolve, reject) => {
      let settled = false, timer = null;
      const finish = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); fn(val); };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(reject, Object.assign(new Error('Model download stalled'), { code: 'STALL' })), STALL_MS);
      };
      arm();
      Promise.resolve(createEngine(mlcKey, {
        initProgressCallback: (r) => {
          if (myToken !== loadToken) return;                       // superseded by a newer load → go inert
          arm();                                                   // progress arrived → reset the stall clock
          if (onProgress) onProgress((r && r.progress) || 0, (r && r.text) || '');
        },
      })).then(
        (eng) => { if (settled) { try { eng && eng.unload && eng.unload(); } catch (_) {} return; } finish(resolve, eng); },
        (err) => finish(reject, err),
      );
    });
  }

  // Load (and cache) a model. onProgress(0..1, text). A stalled download is
  // retried once — resuming from the shards already cached, so only the missing
  // bytes refetch — before the error surfaces.
  async function load(mlcKey, onProgress) {
    if (!hasWebGPU()) throw new Error('WebGPU is not available in this browser. Chrome/Edge 113+ or a WebGPU-enabled browser is required for the local model.');
    if (loadedModel === mlcKey && enginePromise) return enginePromise;
    // Switching models: release the resident engine FIRST. A larger model
    // loaded on top of a smaller one is the usual reason a switch appears to
    // "do nothing" — the GPU is still holding the old weights, so the new load
    // OOMs or stalls. Unload, then build the new one on a clear device.
    if (enginePromise) {
      const prev = enginePromise;
      enginePromise = null; loadedModel = null;
      try { const eng = await prev; if (eng && eng.unload) await eng.unload(); } catch (e) {}
    }
    loadedModel = mlcKey;
    const myToken = ++loadToken;
    const attempt = (async () => {
      try {
        return await buildOnce(mlcKey, onProgress, myToken);
      } catch (e) {
        // A stall is usually a transient drop. Retry once (cached shards make it
        // quick — only the missing bytes refetch); only if THAT stalls too does
        // the error propagate.
        if (e && e.code === 'STALL' && myToken === loadToken) {
          if (onProgress) onProgress(0, 'Download stalled — retrying…');
          return await buildOnce(mlcKey, onProgress, myToken);
        }
        throw e;
      }
    })();
    enginePromise = attempt;
    try {
      await attempt;          // surface a build failure here, not on first turn
    } catch (e) {
      if (myToken === loadToken) { enginePromise = null; loadedModel = null; }   // honest isLoaded(); allow retry. Don't clobber a newer load.
      throw friendlyError(e);
    }
    return enginePromise;
  }

  function friendlyError(e) {
    if (e && e.code === 'STALL')
      return new Error('The model download stalled — the connection stopped responding. Already-downloaded parts are cached, so loading the model again resumes where it left off.');
    return e;
  }

  // Wipe a model's cached weights/config so the next load re-downloads from
  // scratch — the escape hatch when a half-finished download left a corrupt
  // shard that keeps re-stalling on every reload. Best-effort and feature-
  // detected across WebLLM versions; resolves false if nothing could be cleared.
  async function clearCache(mlcKey) {
    try {
      const webllm = await importWebLLM();
      if (typeof webllm.deleteModelAllInfoInCache === 'function') { await webllm.deleteModelAllInfoInCache(mlcKey); return true; }
      let did = false;
      for (const name of ['deleteModelInCache', 'deleteModelWasmInCache', 'deleteChatConfigInCache'])
        if (typeof webllm[name] === 'function') { try { await webllm[name](mlcKey); did = true; } catch (_) {} }
      return did;
    } catch (_) { return false; }
  }

  function isLoaded(mlcKey) { return loadedModel === mlcKey && !!enginePromise; }

  // Pick the system prompt for the turn.
  //  - plain chat (grounded=false, not creative): just be Cleon and converse,
  //    using the running history. No document is forced in.
  //  - grounded: answer strictly from the supplied passages; citations are
  //    bound mechanically afterward, never written by the model.
  //  - creative: free composition over any supplied passages.
  function systemFor(mode, task, grounded, depth = 1) {
    if (mode === 'creative')
      return 'You are Cleon, a private assistant running locally in the user\'s browser. Use any supplied passages as raw material to compose freely. Do not add citation markers.';
    if (grounded) {
      // The notes-and-spans framing. The old prompts treated the model as a
      // hostile witness ("Answer using ONLY the supplied passages… never add
      // anything") — which produced literalism over substitution: "who wrote
      // it?" answered "The author wrote it." while the span carried the name,
      // because echoing the question's noun stays closer to "the passages'
      // own wording" than pulling the name out. The reframe: spans are
      // verbatim quotes to trust and USE; notes are the reader's own graph
      // understanding, usually right, sometimes wrong; spans win conflicts.
      // One prompt replaces six near-duplicates, with NO length
      // prescriptions — the model answers as it sees fit; depth scales
      // max_tokens (the real bound) and nothing else. The faithfulness
      // contract survives: nothing beyond what was handed over, a plain
      // "the document doesn't say" refusal (the veto's modelDeclined
      // watches for that shape), and no model-written citation markers —
      // binding stays mechanical. The one summary-specific line is the
      // degeneracy guard (don't hand back a single span as the summary),
      // which is faithfulness, not length.
      const lines = [
        'You\'re Cleon, a helpful assistant running locally in the user\'s browser. You\'re in the middle of a conversation with them about a document you\'ve been reading together.',
        '',
        'Two kinds of context come with each turn:',
        '- Spans — exact sentences quoted verbatim from the document. Trust them; lean on them whenever a fact is in there.',
        '- Your notes — your own understanding from reading the document. Usually right, sometimes wrong. Good for shape, connections, and who-is-who.',
        '',
        'If a span and a note disagree, the span wins. If a span contains a name, date, or title that answers the question, use it directly — don\'t echo the question\'s wording back. Don\'t add facts that are in neither the spans nor your notes. If neither covers the question, say plainly that the document doesn\'t say, rather than guessing — you don\'t have the whole document, just what you were handed.',
      ];
      if (task === 'summary') {
        lines.push('');
        lines.push('Right now they want a summary: say what the document is about in your own words, drawing the spans together — never copy or lightly reword a single span as the whole answer.');
      }
      lines.push('');
      lines.push('Don\'t write citation markers like [s1] — those are added mechanically after you write.');
      return lines.join('\n');
    }
    return 'You are Cleon, a private assistant that runs entirely in the user\'s browser via WebGPU — you are a local open-weights model, not ChatGPT or Claude, and nothing the user types ever leaves their device. Chat naturally and concisely, using the conversation so far for context. Do not invent facts about real people, places, or events: if you are not sure something is true, say you are not sure rather than making something up — a confident wrong answer is worse than an honest "I\'m not certain." A document may be open; when the user asks about its contents you are handed the exact passages, so you never need to guess at what a document says. If the user is clearly asking about an open document but you were not handed a relevant passage, say so and offer to look it up, rather than guessing at what it contains. The history may be partly condensed: the most recent turns are verbatim, while earlier ones are folded into a short, index-tagged recap (lines like "#3 user: …"). Treat that recap as faithful but lossy — rely on it for the gist, and if the user needs the exact earlier wording, say so plainly rather than reconstructing it from the recap, since the precise turns can be recalled mechanically by index. If the user asks for several things at once, do the most important one well and offer to continue with the rest one at a time, rather than doing all of them shallowly — you have a human-sized sense of how much you can do at once. If you don\'t know something, say so plainly.';
  }

  // Chat-history policy.
  //  - The most recent RECENT_TURNS turns are always kept verbatim.
  //  - Everything older is folded into a single compact recap so the model keeps
  //    the gist without spending the whole context budget on stale turns. The
  //    recap is mechanical (no model call), so it can never hallucinate, and each
  //    folded line is tagged with its absolute turn index.
  //  - Because every turn keeps its index, an exact span can be pulled back out
  //    verbatim with recallSpan() when an answer needs the precise earlier wording.
  const RECENT_TURNS = 8;         // most recent turns kept word-for-word
  const SUMMARY_LINE_CHARS = 160; // per-turn cap inside the condensed recap
  const WM_RECENT_TURNS = 3;      // verbatim window shrinks when working memory carries continuity

  function condense(s, cap = SUMMARY_LINE_CHARS) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > cap ? t.slice(0, cap - 1).trimEnd() + '…' : t;
  }

  // Fold a block of older turns into one index-tagged recap message. `startIndex`
  // is the absolute index (into the full history) of the first folded turn.
  function summarizeTurns(turns, startIndex = 0) {
    const lines = turns.map((m, i) =>
      `#${startIndex + i} ${m.role === 'assistant' ? 'Cleon' : 'user'}: ${condense(m.content)}`);
    return {
      role: 'system',
      content:
        `Earlier conversation, condensed (turns #${startIndex}–#${startIndex + turns.length - 1}). ` +
        `This recap is lossy; the exact wording of any turn can be recalled by index. Do not treat omissions as facts.\n` +
        lines.join('\n'),
    };
  }

  // Pull an exact, verbatim span of earlier turns back out of the full history by
  // absolute turn index — the precise-recall escape hatch for when the condensed
  // recap is not enough. Inclusive range; out-of-range indices are clamped. When
  // `to` is omitted a single turn is returned.
  function recallSpan(history, from, to) {
    const hist = Array.isArray(history) ? history : [];
    const a = Math.max(0, from | 0);
    const b = Math.min(hist.length - 1, (to == null ? from : to) | 0);
    const out = [];
    for (let i = a; i <= b; i++)
      if (hist[i] && hist[i].content) out.push({ index: i, role: hist[i].role, content: hist[i].content });
    return out;
  }

  // Render the heat-ranked working memory (depth > 1) as the model's own
  // NOTES — first-person voice ("things you noticed"), joined into the user
  // message's notes block rather than the system prompt. Notes are turn
  // context, not standing instruction: this is what lets the grounded
  // reframe ("your notes — usually right, sometimes wrong") actually pay
  // off, and it's where who-is-who answers come from when retrieval has no
  // lexical hook. Empty ⇒ '' ⇒ the prompt is byte-identical to having none.
  function renderNotes(wm) {
    if (!wm) return '';
    const hot = wm.hot || [], warm = wm.warm || [], cold = wm.cold || [], recalled = wm.recalled || [];
    if (!hot.length && !warm.length && !cold.length && !recalled.length) return '';
    const out = [];
    if (hot.length) {
      out.push('Things in focus right now:');
      for (const h of hot.slice(0, 5)) {
        const s = (h.sents || []).map(x => x && x.t).filter(Boolean).slice(0, 2).join(' ');
        out.push(`- ${h.entity}${s ? ' — ' + condense(s, 220) : ''}`);
      }
    }
    if (warm.length) {
      out.push('Connected, one step away:');
      for (const w of warm.slice(0, 4)) out.push(`- ${w.entity} (via ${w.oneHopFrom})${w.portraitLine ? ': ' + condense(w.portraitLine, 160) : ''}`);
    }
    if (recalled.length) {
      out.push('Earlier material that came back into view:');
      for (const r of recalled.slice(0, 3)) if (r && r.t) out.push(`- ${condense(r.t, 200)}`);
    }
    if (cold.length) {
      const rng = (c) => c.sentRange ? ` [s${c.sentRange[0]}${c.sentRange[1] !== c.sentRange[0] ? '–s' + c.sentRange[1] : ''}]` : '';
      out.push('Other things you noticed (mention if relevant): ' + cold.slice(0, 8).map(c => c.label + rng(c)).join(', '));
    }
    return out.join('\n');
  }
  const renderWorkingMemory = renderNotes;   // legacy name (sandbox / prompt lab)

  // Assemble the chat messages: system + a condensed recap of older turns + as
  // many recent turns verbatim as fit the budget + this turn. Exposed for
  // testing. `est` is a coarse chars/4 token estimate — good enough to keep us
  // off the context ceiling. Past RECENT_TURNS, older turns are summarized rather
  // than dropped, and any recent turn that won't fit verbatim is folded into the
  // recap too, so nothing silently vanishes from the model's view.
  // `workingMemory` (depth > 1) is the heat-ranked hot/warm/cold subgraph: it
  // folds into the system message and shrinks the verbatim recency window, since
  // heat now carries the continuity. Absent/empty ⇒ byte-identical to before.
  // Token estimate for budget math. chars/4 is right for English but
  // under-counts CJK ~2.4x (a CJK char is ~1 token in the shipped models'
  // tokenizers) — a Japanese document would blow the window while the
  // estimator believed it was at 40%. CJK chars count as 1 token each.
  const CJK_RE = /[　-鿿豈-﫿ｦ-ﾟ]/;
  function estTokens(s) {
    const str = String(s || '');
    let cjk = 0;
    for (const ch of str) if (CJK_RE.test(ch)) cjk++;
    return Math.ceil(cjk + (str.length - cjk) / 4);
  }
  // Default assembly budget. Every shipped model is a 4096-token WebLLM
  // prebuild; the budget must leave room for the reply (max_tokens ≤ 520) and
  // estimator error. The old default (7000) exceeded the window outright and
  // leaned on the caller's catch-retry to recover.
  const DEFAULT_BUDGET = 3300;

  // ---- the shape pass (two-stage answering) ----
  // A small first call that characterizes the TURN — a director's note, not
  // a rubric: what the user is actually after, what register fits, what a
  // bad answer would look like. The answer pass then speaks freely with the
  // note as guidance, not a leash. The shape pass sees the question, a
  // little recent history, the doc title, and whether header metadata
  // exists — deliberately NOT the spans or notes, so it decides what kind
  // of turn this is instead of getting lured into answering it (a note that
  // answers the question just gets paraphrased by the answer pass: wasted
  // compute and a worse answer). The taste lives in the examples below.
  const SHAPE_SYSTEM = [
    'You are the editor sitting beside Cleon, a local assistant that answers questions about a document it has read. Before Cleon answers, you hand it a one-breath director\'s note: what the user is actually after this turn, what register fits, and what a bad answer would look like. You characterize the move — you never answer the question yourself, and you never state facts about the document.',
    '',
    'Examples of the notes you write:',
    '',
    'Question: "what\'s the point of the book?"',
    'Note: They\'re asking for the through-line — what the book is about beneath its plot. Synthesis, not lookup: they want your reading, not a quote. A literalist answer that hugs the passages will frustrate them; so will a generic book-report thesis. Pull from your notes, name a tension you actually noticed, and commit to a view. Conversational.',
    '',
    'Question: "who wrote it?"',
    'Note: Bibliographic lookup. They want the name. One line, no hedging, and never "the author" — say the name if the header metadata or a span has it; if nothing does, say what\'s missing.',
    '',
    'Question (right after Cleon listed characters, including obvious boilerplate): "project gutenberg is a character?"',
    'Note: Pushback, and they\'re right — that\'s boilerplate, not a character. Acknowledge the mistake without grovelling and give the cleaner answer. This is repair, not fresh retrieval; don\'t re-serve the old list.',
    '',
    'Question: "thanks, that helps"',
    'Note: Not a question — acknowledgment. A sentence back, warm, no new material unless they ask.',
    '',
    'Write 2–4 plain sentences in that voice. The note is guidance for HOW to answer — never the answer itself, and never new facts.',
  ].join('\n');

  async function shapePass({ mlcKey, question, history, docTitle, metaHint }) {
    const eng = await load(mlcKey);
    const recent = (Array.isArray(history) ? history : []).slice(-4)
      .map(m => `${m.role === 'assistant' ? 'Cleon' : 'user'}: ${condense(m.content, 200)}`).join('\n');
    const user = [
      docTitle ? `Document open: "${docTitle}".` : 'A document is open.',
      metaHint ? `Header metadata on hand: ${metaHint}.` : '',
      recent ? `\nRecent turns:\n${recent}` : '',
      `\nUser just asked: "${question}"`,
      '\nWhat does this turn want? Reply with the note only.',
    ].filter(Boolean).join('\n');
    const messages = [{ role: 'system', content: SHAPE_SYSTEM }, { role: 'user', content: user }];
    const A = (typeof window !== 'undefined') ? window.EOAudit : null;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let full = '';
    try {
      const res = await eng.chat.completions.create({ messages, temperature: 0.3, max_tokens: 90, stop: STOP_SEQUENCES, stream: true });
      for await (const chunk of res) full += chunk.choices?.[0]?.delta?.content || '';
    } catch (e) {
      if (A && A.step) try { A.step('llm', { mode: 'shape', grounded: false, mlcKey, system: SHAPE_SYSTEM, messages: messages.map(m => ({ role: m.role, chars: (m.content || '').length, content: m.content })), output: full, error: String((e && e.message) || e), ms: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0) }); } catch (_) {}
      throw e;
    }
    const note = stripThink(full);
    if (A && A.step) try { A.step('llm', { mode: 'shape', grounded: false, mlcKey, params: { temperature: 0.3, max_tokens: 90 }, system: SHAPE_SYSTEM, messages: messages.map(m => ({ role: m.role, chars: (m.content || '').length, content: m.content })), output: full.trim(), filtered: note !== full.trim() ? note : undefined, ms: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0) }); } catch (_) {}
    return note;
  }

  // The grounded user message, tiered: the question first (orientation), the
  // shape note (the director's read of what this turn wants), the spans
  // quoted exactly, the notes as their own epistemic level, and the question
  // again as the closing instruction — without the second occurrence, long
  // context pushes the question out of the model's recency window and
  // answers drift. Non-grounded callers (plain chat, creative) keep their
  // old shapes; a grounded caller that still passes a prebuilt blob (the
  // summary sample) gets the same frame around the blob.
  function buildUserContent({ question, docTitle, spans, notesProse, contextText, grounded, shapeNote }) {
    if (!grounded) return contextText ? `Passages:\n${contextText}\n\n${question}` : question;
    const hasSpans = Array.isArray(spans) && spans.length > 0;
    if (!hasSpans && !notesProse && !contextText && !shapeNote) return question;
    const parts = [`The user just asked: ${question}`, ''];
    if (shapeNote) {
      parts.push('What this turn wants:');
      parts.push(String(shapeNote).trim());
      parts.push('');
    }
    parts.push('Context for this turn:');
    if (docTitle) parts.push(`You've been reading a document called "${docTitle}".`);
    parts.push('');
    if (hasSpans) {
      parts.push('Sentences from the document that look relevant, quoted exactly:');
      for (const s of spans) parts.push(`  [${s.tag != null ? s.tag : 's' + s.idx}] ${s.text}`);
      parts.push('');
    } else if (contextText) {
      parts.push('Material from the document:');
      parts.push(contextText);
      parts.push('');
    }
    if (notesProse) {
      parts.push('Your notes on the document (your understanding from reading it — usually right, sometimes wrong):');
      parts.push(notesProse);
      parts.push('');
    }
    parts.push(`Answer the user's question: ${question}`);
    return parts.join('\n');
  }

  function assembleMessages({ sys, history, contextText, question, grounded, budget = DEFAULT_BUDGET, recentTurns = RECENT_TURNS, workingMemory = null, spans = null, notes = '', docTitle = '', shapeNote = '' }) {
    const est = (m) => estTokens((m && m.content) || '');
    // Working memory renders as the model's own notes and joins any
    // graph-derived notes in the USER message — turn context, not standing
    // instruction. The system message stays bare (plus the recap below).
    const wmBlock = renderNotes(workingMemory);
    const notesProse = [String(notes || '').trim(), wmBlock].filter(Boolean).join('\n\n');
    const userContent = buildUserContent({ question, docTitle, spans, notesProse, contextText, grounded, shapeNote });
    const sysFull = sys;
    const head = { role: 'system', content: sysFull };
    const tail = { role: 'user', content: userContent };
    let used = est(head) + est(tail);

    const hist = (Array.isArray(history) ? history : []).filter(m => m && m.content);
    // The most recent turns are the verbatim window; the rest are candidates for
    // condensing. Heat-ranked working memory carries continuity, so when it is
    // present the verbatim window shrinks to reclaim that prompt bandwidth.
    const rt = wmBlock ? Math.min(recentTurns, WM_RECENT_TURNS) : recentTurns;
    const splitAt = Math.max(0, hist.length - rt);
    const recent = hist.slice(splitAt);

    // Keep as many recent turns verbatim as the budget allows, newest first; any
    // that don't fit fall back into the recap rather than being dropped outright.
    const kept = [];
    let firstKept = recent.length; // index (within `recent`) of the oldest verbatim turn
    for (let i = recent.length - 1; i >= 0; i--) {
      const t = est(recent[i]);
      if (used + t > budget) break;
      used += t; firstKept = i;
      kept.unshift({ role: recent[i].role === 'assistant' ? 'assistant' : 'user', content: recent[i].content });
    }

    // Everything before the verbatim window gets condensed into one recap. If even
    // the recap overflows, drop its oldest lines (and advance the start index) until
    // it fits — oldest context degrades first, but only after being condensed.
    const foldEnd = splitAt + firstKept; // exclusive: all turns before the kept window
    let toFold = hist.slice(0, foldEnd);
    let startIdx = 0;
    let summary = null;
    while (toFold.length) {
      const s = summarizeTurns(toFold, startIdx);
      if (used + est(s) <= budget) { summary = s; used += est(s); break; }
      toFold = toFold.slice(1); startIdx++;
    }

    // MLC/WebLLM accepts exactly one `system` message, and it must be first:
    // a second one makes chat.completions.create() throw ("System prompt should
    // always be the first message in `messages`"), which silently drops every
    // grounded turn onto the mechanical fallback. The condensed recap is
    // system-level context, so fold it into the head prompt rather than emitting
    // it as its own system message.
    const head2 = summary ? { role: 'system', content: `${sysFull}\n\n${summary.content}` } : head;
    return [head2, ...kept, tail];
  }

  // ---- reasoning-model think gating ----
  // Reasoning builds (Qwen3, R1 distills) emit `<think>…</think>` before the
  // answer. Without gating, the reasoning streams to the UI as if it were the
  // answer — and a turn that hits max_tokens mid-think ships raw chain-of-
  // thought as the reply, which the verifier then grades. The stream filter
  // drops think content as it arrives (with a small look-behind so a tag
  // split across deltas is still caught); the post-strip drops any unclosed
  // think tail (the max_tokens cutoff case). The audit record keeps the FULL
  // text verbatim, think included — that's exactly what audit mode exists
  // for; only the user-visible stream and the returned answer are filtered.
  // NOTE: `</think>` is deliberately NOT a stop sequence — the answer FOLLOWS
  // the close tag, so stopping there would truncate every reasoning turn to
  // nothing. Stops cover only end-of-turn markers sloppy templates leak.
  const STOP_SEQUENCES = ['<|im_end|>', '<|eot_id|>'];
  function stripThink(text) {
    return String(text == null ? '' : text).replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  }
  // A stateful per-turn delta filter: feed() each chunk, emitting only
  // outside-think text via onToken; flush() releases the held look-behind.
  function makeThinkFilter(onToken) {
    let inThink = false, buf = '';
    const emit = (s) => { if (s && onToken) onToken(s); };
    return {
      feed(d) {
        if (!d) return;
        buf += d;
        while (buf.length) {
          if (!inThink) {
            const open = buf.indexOf('<think>');
            if (open === -1) {
              // Hold the last 7 chars back in case a tag splits across deltas.
              if (buf.length > 7) { emit(buf.slice(0, -7)); buf = buf.slice(-7); }
              break;
            }
            emit(buf.slice(0, open));
            buf = buf.slice(open + 7);
            inThink = true;
          } else {
            const close = buf.indexOf('</think>');
            if (close === -1) { buf = buf.slice(-8); break; }   // discard think, keep tail for the close tag
            buf = buf.slice(close + 8);
            inThink = false;
          }
        }
      },
      flush() { if (!inThink) emit(buf); buf = ''; },
    };
  }

  // The answer pass's token ceiling. Depth scales the grounded caps (summary
  // 260→520, answer 180→420); lvl 1 holds today's exact ceilings. An explicit
  // `override` — the shape layer's best-fit budget, sized from the matched
  // archetype's own length (shape.js §9) — WINS when present, clamped to a safe
  // window so a 4096-token prebuild always has room for the assembled prompt
  // (max_tokens ≤ 520, per the DEFAULT_BUDGET math). With no override the result
  // is byte-identical to the old inline formula, so callers that don't pass one
  // are unchanged (parity).
  function resolveMaxTokens({ mode, grounded, task, depth, override }) {
    const lvl = Math.min(3, Math.max(1, (depth | 0) || 1));
    const base = mode === 'creative' ? 320
      : grounded ? (task === 'summary' ? 260 + (lvl - 1) * 130 : 180 + (lvl - 1) * 120)
      : 360;
    if (typeof override === 'number' && isFinite(override) && override > 0)
      return Math.max(24, Math.min(520, Math.round(override)));
    return base;
  }

  // Stream a turn. Plain chat passes history with no passages; grounded/summary
  // pass retrieved passages. onToken(deltaText). `maxTokens` (optional) lets the
  // shape layer set the ceiling from the best-fit archetype's length; unset, the
  // depth-scaled default applies (parity).
  async function phrase({ mlcKey, question, contextText, history, mode, task, grounded, onToken, budget, workingMemory, depth, sysOverride, spans, notes, docTitle, shapeNote, maxTokens }) {
    const eng = await load(mlcKey);
    // Thinking depth (1 reflex … 3 deepest) shapes the grounded phrasing and how
    // much room the answer gets. Absent/1 ⇒ today's prompt and token caps (parity).
    const lvl = Math.min(3, Math.max(1, (depth | 0) || 1));
    // sysOverride lets the sandbox's prompt lab try a candidate talker prompt;
    // unset everywhere else, so normal chat is byte-identical (parity holds).
    const sys = sysOverride || systemFor(mode, task, grounded, lvl);
    const messages = assembleMessages({ sys, history, contextText, question, grounded, budget, workingMemory, spans, notes, docTitle, shapeNote });
    const temperature = mode === 'creative' ? 0.8 : (grounded ? 0.12 : 0.4);
    // Deeper reading earns more room to synthesize: the grounded caps grow with the
    // dial (summary 260→520, answer 180→420). lvl 1 holds today's exact ceilings,
    // unless the shape layer hands in a best-fit budget (maxTokens), which wins.
    const max_tokens = resolveMaxTokens({ mode, grounded, task, depth: lvl, override: maxTokens });
    const max_tokens_shaped = (typeof maxTokens === 'number' && isFinite(maxTokens) && maxTokens > 0) || undefined;
    // Audit hook (no-op unless window.EOAudit is present): record the EXACT prompt
    // the model saw, its parameters, its raw output, and the wall time — so
    // auditing mode can show what was sent and what came back, verbatim.
    const A = (typeof window !== 'undefined') ? window.EOAudit : null;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const recLLM = (output, extra) => {
      if (!A || !A.step) return;
      try {
        A.step('llm', Object.assign({
          mode, task: task || null, grounded: !!grounded, mlcKey,
          params: { temperature, max_tokens, max_tokens_shaped, depth: lvl, budget: budget || null },
          system: sys,
          messages: messages.map(m => ({ role: m.role, chars: (m.content || '').length, content: m.content })),
          output,
          ms: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0),
        }, extra || {}));
      } catch (e) {}
    };
    let full = '';
    const gate = makeThinkFilter(onToken);
    try {
      const res = await eng.chat.completions.create({ messages, temperature, max_tokens, stop: STOP_SEQUENCES, stream: true });
      for await (const chunk of res) {
        const d = chunk.choices?.[0]?.delta?.content || '';
        if (d) { full += d; gate.feed(d); }
      }
      gate.flush();
    } catch (e) {
      recLLM(full, { error: String((e && e.message) || e) });   // record the failed attempt, then let the caller handle it
      throw e;
    }
    // The audit keeps the verbatim text (think content intact); the caller
    // gets the stripped answer. `filtered` marks the records where they differ.
    const out = stripThink(full);
    recLLM(full.trim(), out !== full.trim() ? { filtered: out } : undefined);
    return out;
  }

  window.EOLLM = { hasWebGPU, load, isLoaded, clearCache, phrase, shapePass, SHAPE_SYSTEM, systemFor, assembleMessages, buildUserContent, renderNotes, renderWorkingMemory, summarizeTurns, recallSpan, RECENT_TURNS, DEFAULT_BUDGET, estTokens, resolveMaxTokens, stripThink, makeThinkFilter };
})();
