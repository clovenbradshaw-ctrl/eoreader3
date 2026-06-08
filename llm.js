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

  const hasWebGPU = () => typeof navigator !== 'undefined' && !!navigator.gpu;

  async function importWebLLM() {
    if (mod) return mod;
    // ESM CDN — loaded on demand so the app starts instantly without it.
    // Pinned to an exact version (was unversioned): a floating major could
    // change the loader API or model defaults under us with no warning.
    mod = await import('https://esm.run/@mlc-ai/web-llm@0.2.79');
    return mod;
  }

  // Load (and cache) a model. onProgress(0..1, text).
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
    const webllm = await importWebLLM();
    try {
      enginePromise = webllm.CreateMLCEngine(mlcKey, {
        initProgressCallback: (r) => { if (onProgress) onProgress(r.progress ?? 0, r.text || ''); },
      });
      await enginePromise;          // surface a build failure here, not on first turn
    } catch (e) {
      enginePromise = null; loadedModel = null;   // keep isLoaded() honest; allow retry
      throw e;
    }
    return enginePromise;
  }

  function isLoaded(mlcKey) { return loadedModel === mlcKey && !!enginePromise; }

  // Pick the system prompt for the turn.
  //  - plain chat (grounded=false, not creative): just be Cleon and converse,
  //    using the running history. No document is forced in.
  //  - grounded: answer strictly from the supplied passages; citations are
  //    bound mechanically afterward, never written by the model.
  //  - creative: free composition over any supplied passages.
  function systemFor(mode, task, grounded) {
    if (mode === 'creative')
      return 'You are Cleon, a private assistant running locally in the user\'s browser. Use any supplied passages as raw material to compose freely. Do not add citation markers.';
    if (grounded)
      return task === 'summary'
        ? 'You are Cleon. In 2 to 4 sentences, say what the passages are ABOUT in your own words — the figures, what is claimed of them, and how it moves. Synthesize across the passages; never copy or lightly reword a single line as the whole answer. Use only what they state, add nothing not present, and write no citation markers; those are added mechanically afterward.'
        : 'You are Cleon. Answer using ONLY the supplied passages. Reply in one or two sentences, staying close to the passages\' own facts and wording. Never add anything the passages do not state. If they do not answer the question, reply exactly: The passages don\'t say. Do not write citation markers like [s1]; those are added mechanically afterward.';
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

  // Assemble the chat messages: system + a condensed recap of older turns + as
  // many recent turns verbatim as fit the budget + this turn. Exposed for
  // testing. `est` is a coarse chars/4 token estimate — good enough to keep us
  // off the context ceiling. Past RECENT_TURNS, older turns are summarized rather
  // than dropped, and any recent turn that won't fit verbatim is folded into the
  // recap too, so nothing silently vanishes from the model's view.
  function assembleMessages({ sys, history, contextText, question, grounded, budget = 7000, recentTurns = RECENT_TURNS }) {
    const est = (m) => Math.ceil(((m && m.content) || '').length / 4);
    const userContent = (grounded && contextText)
      ? `Passages from the document:\n${contextText}\n\nUsing only the passages above, answer: ${question}`
      : (contextText ? `Passages:\n${contextText}\n\n${question}` : question);
    const head = { role: 'system', content: sys };
    const tail = { role: 'user', content: userContent };
    let used = est(head) + est(tail);

    const hist = (Array.isArray(history) ? history : []).filter(m => m && m.content);
    // The most recent `recentTurns` turns are the verbatim window; the rest are
    // candidates for condensing.
    const splitAt = Math.max(0, hist.length - recentTurns);
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
    const head2 = summary ? { role: 'system', content: `${sys}\n\n${summary.content}` } : head;
    return [head2, ...kept, tail];
  }

  // Stream a turn. Plain chat passes history with no passages; grounded/summary
  // pass retrieved passages. onToken(deltaText).
  async function phrase({ mlcKey, question, contextText, history, mode, task, grounded, onToken, budget }) {
    const eng = await load(mlcKey);
    const sys = systemFor(mode, task, grounded);
    const messages = assembleMessages({ sys, history, contextText, question, grounded, budget });
    const temperature = mode === 'creative' ? 0.8 : (grounded ? 0.12 : 0.4);
    const max_tokens = mode === 'creative' ? 320 : (grounded ? (task === 'summary' ? 260 : 180) : 360);
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
          params: { temperature, max_tokens, budget: budget || null },
          system: sys,
          messages: messages.map(m => ({ role: m.role, chars: (m.content || '').length, content: m.content })),
          output,
          ms: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0),
        }, extra || {}));
      } catch (e) {}
    };
    let full = '';
    try {
      const res = await eng.chat.completions.create({ messages, temperature, max_tokens, stream: true });
      for await (const chunk of res) {
        const d = chunk.choices?.[0]?.delta?.content || '';
        if (d) { full += d; if (onToken) onToken(d); }
      }
    } catch (e) {
      recLLM(full, { error: String((e && e.message) || e) });   // record the failed attempt, then let the caller handle it
      throw e;
    }
    const out = full.trim();
    recLLM(out);
    return out;
  }

  window.EOLLM = { hasWebGPU, load, isLoaded, phrase, systemFor, assembleMessages, summarizeTurns, recallSpan, RECENT_TURNS };
})();
