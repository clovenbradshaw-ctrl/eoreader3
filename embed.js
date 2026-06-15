/* ============================================================
   Cleo — optional embedding reader (transformers.js / MiniLM).

   The STRUCTURE layer's recall booster: when lexical token overlap misses a
   paraphrase ("auto" vs "car"), cosine over sentence embeddings recovers the
   locus the tokens couldn't. It never decides routing and never phrases — it
   only returns candidate sentences for the mechanical layers to use, exactly as
   the embedder reader does in entity reconciliation. The app degrades to pure
   lexical whenever this module is absent or fails to load.

   Published as window.EOEmbed. Loads on demand (first embed call), so the app
   starts instantly without paying for it. Vectors are L2-normalized by the
   pipeline (normalize:true), so cosine similarity is a plain dot product.
   ============================================================ */
(function () {
  'use strict';
  const MODEL = 'Xenova/all-MiniLM-L6-v2';
  let extractorPromise = null;   // the loaded feature-extraction pipeline
  let failed = false;            // a load failure latches: don't retry every turn
  let mod = null;

  // The pipeline is async to LOAD but we want a cheap sync ready() for the
  // cost-ordered router's short-circuit. ready() is true only once the pipeline
  // has actually resolved at least once.
  let extractor = null;

  async function importTransformers() {
    if (mod) return mod;
    // ESM CDN, pinned — mirrors how llm.js loads WebLLM. v3 is the @huggingface
    // scope; the @xenova alias also resolves. Pin to avoid silent API drift.
    mod = await import('https://esm.run/@huggingface/transformers@3.0.2');
    return mod;
  }

  async function ensure() {
    if (extractor) return extractor;
    if (failed) return null;
    if (!extractorPromise) {
      extractorPromise = (async () => {
        try {
          const { pipeline } = await importTransformers();
          // WASM by default (works everywhere); the pipeline picks WebGPU when
          // available. dtype q8 keeps the download small (~25MB) and is plenty
          // for recall-quality cosine.
          const ex = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
          extractor = ex;
          return ex;
        } catch (e) { failed = true; extractorPromise = null; if (window.eoWarn) window.eoWarn('embed load failed', e); return null; }
      })();
    }
    return extractorPromise;
  }

  function ready() { return !!extractor; }
  // Kick off the load without blocking — call once at startup so the first
  // escalation isn't also paying the model download.
  function warm() { if (!extractor && !failed) ensure(); }

  // How many sentences to embed per inference call. A whole large document
  // (~1800 sentences for a full novel) embedded in ONE ex() call is a single
  // multi-second synchronous WASM matmul that blocks the main thread — the
  // browser shows "Page Unresponsive" and every in-flight turn (any backend,
  // even Claude) appears to hang. Splitting into small batches and YIELDING to
  // the event loop between them keeps each step short enough that the page
  // stays responsive; total work is the same, just no longer one frozen block.
  // Overridable via window.EO_EMBED_BATCH.
  const EMBED_BATCH = (typeof window !== 'undefined' && +window.EO_EMBED_BATCH) || 24;
  const yieldToEventLoop = () => new Promise(res => setTimeout(res, 0));

  // ---- indexing activity (the whole-document embed) -----------------------
  // A single query embed is cheap and silent; embedding a WHOLE document — the
  // first question that needs semantic recall, or the structure reconciler —
  // is the multi-second pass the batching above exists to keep from freezing
  // the tab. It used to run with NO UI trace at all, so a large upload would go
  // quiet and "feel" hung (was it tie-breaking with an LLM? nothing said). We
  // broadcast its progress so the host can name it — a sidebar "Indexing…"
  // chip, a banner, a glass-box step. Best-effort and browser-only; with no
  // listeners it costs a single object assignment per batch.
  let activity = { busy: false, done: 0, total: 0, doc: null };
  const actListeners = new Set();
  function emitActivity(patch) {
    activity = Object.assign({}, activity, patch);
    for (const fn of actListeners) { try { fn(activity); } catch (e) {} }
  }
  function onActivity(fn) {
    if (typeof fn !== 'function') return () => {};
    actListeners.add(fn);
    return () => actListeners.delete(fn);
  }

  // Embed an array of sentences → array of Float32Array (one row per sentence).
  // Batched + yielding so a large document never freezes the tab (see EMBED_BATCH).
  // `opts.doc` ({ id, name }) labels a whole-document pass so the host can show
  // WHICH document is being indexed; it is purely advisory and may be omitted.
  async function embedSentences(sentences, opts) {
    const ex = await ensure();
    if (!ex || !sentences || !sentences.length) return null;
    try {
      // Small inputs: one call, no batching overhead (the common query case).
      // No activity broadcast — a single query embed isn't worth a status line.
      if (sentences.length <= EMBED_BATCH) {
        const out = await ex(sentences, { pooling: 'mean', normalize: true });
        return out.tolist().map(r => Float32Array.from(r));
      }
      // A whole-document pass: announce it so the host can surface "indexing"
      // status, report progress per batch, and ALWAYS close it out (finally),
      // so a mid-pass throw can't leave the UI stuck showing work that stopped.
      const doc = (opts && opts.doc) || null;
      emitActivity({ busy: true, done: 0, total: sentences.length, doc });
      const rows = [];
      try {
        for (let i = 0; i < sentences.length; i += EMBED_BATCH) {
          const batch = sentences.slice(i, i + EMBED_BATCH);
          const out = await ex(batch, { pooling: 'mean', normalize: true });
          // out is a [n,384] Tensor; .tolist() → nested arrays. Convert rows to
          // Float32Array for fast dot products in the engine.
          for (const r of out.tolist()) rows.push(Float32Array.from(r));
          emitActivity({ done: Math.min(i + EMBED_BATCH, sentences.length) });
          // Let the browser paint / handle input between batches, so embedding a
          // long document doesn't lock the page.
          if (i + EMBED_BATCH < sentences.length) await yieldToEventLoop();
        }
      } finally {
        emitActivity({ busy: false, doc: null });
      }
      return rows;
    } catch (e) { if (window.eoWarn) window.eoWarn('embedSentences failed', e); return null; }
  }

  // Embed a single query string → Float32Array (or null).
  async function embedQuery(text) {
    const v = await embedSentences([String(text || '')]);
    return v && v[0] ? v[0] : null;
  }

  window.EOEmbed = { ready, warm, embedQuery, embedSentences, onActivity, getActivity: () => activity, MODEL };
})();
