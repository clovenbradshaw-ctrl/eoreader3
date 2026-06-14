/* ============================================================
   Text embedding adapter — declares the RESIDENT embedder (window.EOEmbed,
   Xenova/all-MiniLM-L6-v2) as an adapter so the spec governs it too and call
   sites can swap it without changing.

   Capability "text-embed", modality "text". One event per input string,
   region.kind "charoffset" (the span embedded), payload { vec: Float32Array,
   dim: number }. An embedding is a deterministic function of its input, so
   confidence is 1.0 with semantics "deterministic" (a vector is not a
   probability — see the spec; we do not invent one).
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const manifest = {
    id: 'text-embed-minilm',
    name: 'MiniLM text embeddings',
    version: '1.0.0',
    category: 'embedding',
    modality: 'text',
    capability: 'text-embed',
    modelRef: { runtime: 'transformersjs', model: 'Xenova/all-MiniLM-L6-v2', version: '3.x', weightsBytes: 25 * 1024 * 1024 },
    resources: { backend: 'wasm', memMB: 45, expectedLatencyMs: 120 },
    confidenceSemantics: 'deterministic',
    failureModes: [
      'window.EOEmbed absent or failed to load (reported as a failure event)',
      'very long inputs are truncated by the model context (~256 tokens)',
    ],
    output: { event: 'one per input string', payload: '{ vec: Float32Array, dim: number }' },
    meta: { note: 'wraps the resident window.EOEmbed used by retrieval/recall' },
  };
  const ref = { id: manifest.id, version: manifest.version };

  const E = () => window.EOEmbed;
  let _ready = false;

  async function load() {
    const e = E();
    if (!e) throw new Error('window.EOEmbed is not available');
    if (e.ready && e.ready()) { _ready = true; return; }
    // Force the resident pipeline to resolve so ready() flips true after load().
    try { await e.embedSentences(['']); } catch (_) {}
    _ready = !!(e.ready && e.ready());
  }
  const ready = () => !!(E() && E().ready && E().ready());

  async function run(input, opts) {
    const e = E();
    if (!e) return [C.failureEvent(ref, 'window.EOEmbed is not available', { recoverable: false })];
    const arr = Array.isArray(input) ? input.map(String) : [String(input == null ? '' : input)];
    let vecs;
    try { vecs = await e.embedSentences(arr); }
    catch (err) { return [C.failureEvent(ref, 'embed failed: ' + (err && err.message), { recoverable: true })]; }
    if (!vecs) return [C.failureEvent(ref, 'embedder returned no vectors', { recoverable: true })];
    _ready = true;
    return vecs.map((vec, i) => C.event({
      adapter: ref,
      region: { kind: 'charoffset', start: 0, end: arr[i].length },
      confidence: 1,
      payload: { vec, dim: vec.length },
      meta: { model: (e.MODEL || manifest.modelRef.model), pooling: 'mean', normalized: true },
    }));
  }

  async function unload() { _ready = false; }

  window.EOAdapters.register({ manifest, load, ready, run, unload });
})();
