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
    mod = await import('https://esm.run/@mlc-ai/web-llm');
    return mod;
  }

  // Load (and cache) a model. onProgress(0..1, text).
  async function load(mlcKey, onProgress) {
    if (!hasWebGPU()) throw new Error('WebGPU is not available in this browser. Chrome/Edge 113+ or a WebGPU-enabled browser is required for the local model.');
    if (loadedModel === mlcKey && enginePromise) return enginePromise;
    loadedModel = mlcKey;
    const webllm = await importWebLLM();
    enginePromise = webllm.CreateMLCEngine(mlcKey, {
      initProgressCallback: (r) => { if (onProgress) onProgress(r.progress ?? 0, r.text || ''); },
    });
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
        ? 'You are Cleon. Summarize the supplied passages faithfully in 2 to 4 sentences, using only what they state. Do not add anything not present in them. Do not write citation markers; those are added mechanically afterward.'
        : 'You are Cleon. Answer using ONLY the supplied passages. Reply in one or two sentences, staying close to the passages\' own facts and wording. Never add anything the passages do not state. If they do not answer the question, reply exactly: The passages don\'t say. Do not write citation markers like [s1]; those are added mechanically afterward.';
    return 'You are Cleon, a private assistant that runs entirely in the user\'s browser via WebGPU — you are a local open-weights model, not ChatGPT or Claude, and nothing the user types ever leaves their device. Chat naturally and concisely, using the conversation so far for context. A document may be open; when the user asks about its contents you are handed the exact passages, so you never need to guess at what a document says. If the user asks for several things at once, do the most important one well and offer to continue with the rest one at a time, rather than doing all of them shallowly — you have a human-sized sense of how much you can do at once. If you don\'t know something, say so plainly.';
  }

  // Assemble the chat messages: system + as much recent history as fits the
  // budget (oldest turns dropped, never summarized) + this turn. Exposed for
  // testing. `est` is a coarse chars/4 token estimate — good enough to keep us
  // off the context ceiling without condensing healthy conversations.
  function assembleMessages({ sys, history, contextText, question, grounded, budget = 7000 }) {
    const est = (m) => Math.ceil(((m && m.content) || '').length / 4);
    const userContent = (grounded && contextText)
      ? `Passages from the document:\n${contextText}\n\nUsing only the passages above, answer: ${question}`
      : (contextText ? `Passages:\n${contextText}\n\n${question}` : question);
    const head = { role: 'system', content: sys };
    const tail = { role: 'user', content: userContent };
    let used = est(head) + est(tail);
    const kept = [];
    const hist = Array.isArray(history) ? history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const m = hist[i];
      if (!m || !m.content) continue;
      const t = est(m);
      if (used + t > budget) break;   // near the ceiling — drop the oldest, don't condense
      used += t; kept.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    return [head, ...kept, tail];
  }

  // Stream a turn. Plain chat passes history with no passages; grounded/summary
  // pass retrieved passages. onToken(deltaText).
  async function phrase({ mlcKey, question, contextText, history, mode, task, grounded, onToken }) {
    const eng = await load(mlcKey);
    const sys = systemFor(mode, task, grounded);
    const messages = assembleMessages({ sys, history, contextText, question, grounded });
    const res = await eng.chat.completions.create({
      messages,
      temperature: mode === 'creative' ? 0.8 : (grounded ? 0.12 : 0.5),
      max_tokens: mode === 'creative' ? 320 : (grounded ? (task === 'summary' ? 260 : 180) : 400),
      stream: true,
    });
    let full = '';
    for await (const chunk of res) {
      const d = chunk.choices?.[0]?.delta?.content || '';
      if (d) { full += d; if (onToken) onToken(d); }
    }
    return full.trim();
  }

  window.EOLLM = { hasWebGPU, load, isLoaded, phrase, systemFor, assembleMessages };
})();
