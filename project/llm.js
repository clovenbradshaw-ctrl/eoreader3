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

  // Stream a phrasing pass over retrieved context. onToken(deltaText).
  async function phrase({ mlcKey, question, contextText, mode, task, onToken }) {
    const eng = await load(mlcKey);
    const sys = mode === 'creative'
      ? 'You are a writer. Use the supplied passages as raw material to compose freely. Do not add citation markers.'
      : task === 'summary'
        ? 'You summarize the supplied passages faithfully in 2 to 4 sentences, using only what they state. Do not add anything not present in them. Do not write citation markers; those are added mechanically afterward.'
        : 'You answer using ONLY the supplied passages. Reply in one or two sentences, staying close to the passages\' own facts and wording. Never add anything the passages do not state. If they do not answer the question, reply exactly: The passages don\'t say. Do not write citation markers like [s1]; those are added mechanically afterward.';
    const user = (contextText ? `Passages:\n${contextText}\n\n` : '') + `Question: ${question}`;
    const res = await eng.chat.completions.create({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: mode === 'creative' ? 0.8 : 0.12,
      max_tokens: mode === 'creative' ? 320 : (task === 'summary' ? 260 : 180), stream: true,
    });
    let full = '';
    for await (const chunk of res) {
      const d = chunk.choices?.[0]?.delta?.content || '';
      if (d) { full += d; if (onToken) onToken(d); }
    }
    return full.trim();
  }

  window.EOLLM = { hasWebGPU, load, isLoaded, phrase };
})();
