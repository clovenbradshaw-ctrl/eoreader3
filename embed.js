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

  // Embed an array of sentences → array of Float32Array (one row per sentence).
  async function embedSentences(sentences) {
    const ex = await ensure();
    if (!ex || !sentences || !sentences.length) return null;
    try {
      const out = await ex(sentences, { pooling: 'mean', normalize: true });
      // out is a [n,384] Tensor; .tolist() → nested arrays. Convert rows to
      // Float32Array for fast dot products in the engine.
      const rows = out.tolist();
      return rows.map(r => Float32Array.from(r));
    } catch (e) { if (window.eoWarn) window.eoWarn('embedSentences failed', e); return null; }
  }

  // Embed a single query string → Float32Array (or null).
  async function embedQuery(text) {
    const v = await embedSentences([String(text || '')]);
    return v && v[0] ? v[0] : null;
  }

  window.EOEmbed = { ready, warm, embedQuery, embedSentences, MODEL };
})();
