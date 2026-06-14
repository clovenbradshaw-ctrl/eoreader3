/* ============================================================
   Cross-modal embedding adapter — CLIP (Xenova/clip-vit-base-patch32) via
   transformers.js. Capability "image-text-embed", modality "image+text".

   This is the adapter the standing operator uses for cross-modal evidence
   checks: a claim made in text can be checked against an image when both land
   in CLIP's shared space and the cosine carries the standing measurement.

   One event per input, payload { vec: Float32Array, dim: 512 } (L2-normalized so
   cosine is a dot product). An embedding is deterministic — confidence 1.0,
   semantics "deterministic". region.kind is "bbox" for an image input,
   "charoffset" for text.

   FAILURE MODE worth stating: exact cross-modal cosine relies on CLIP's
   projection heads being applied identically to both towers; this adapter uses
   transformers.js feature-extraction pipelines and should be verified before a
   pack leans on the absolute cosine value (declared in the manifest).
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const MODEL = 'Xenova/clip-vit-base-patch32';
  const TRANSFORMERS_URL = 'https://esm.run/@huggingface/transformers@3.0.2';
  let modP = null;
  async function transformers() {
    if (window.EO_TRANSFORMERS) return window.EO_TRANSFORMERS;
    if (!modP) modP = import(TRANSFORMERS_URL);
    return modP;
  }

  const manifest = {
    id: 'image-text-embed-clip',
    name: 'CLIP image+text embeddings',
    version: '1.0.0',
    category: 'embedding',
    modality: 'image+text',
    capability: 'image-text-embed',
    modelRef: { runtime: 'transformersjs', model: MODEL, version: '3.0.2', weightsBytes: 150 * 1024 * 1024 },
    resources: { backend: 'wasm', memMB: 180, expectedLatencyMs: 600 },
    confidenceSemantics: 'deterministic',
    failureModes: [
      'shared-space cosine depends on matched projection heads — verify before relying on the absolute cosine',
      'weights (~150 MB) fail to download (reported as a failure event)',
      'unrecognized input kind (reported as a failure event)',
    ],
    output: { event: 'one per input', payload: '{ vec: Float32Array, dim: 512 }' },
    meta: { dim: 512 },
  };
  const ref = { id: manifest.id, version: manifest.version };

  const pipes = Object.create(null);
  let _ready = false;
  async function pipeFor(task) {
    if (pipes[task]) return pipes[task];
    const { pipeline } = await transformers();
    pipes[task] = await pipeline(task, MODEL);
    return pipes[task];
  }
  async function load() { await pipeFor('image-feature-extraction').catch(() => {}); _ready = true; }
  const ready = () => _ready;

  function isImage(input) {
    if (typeof input === 'string') return /^(data:image|https?:).*/i.test(input) && /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(input) || /^data:image/i.test(input);
    if (typeof Blob !== 'undefined' && input instanceof Blob) return true;
    if (typeof ImageData !== 'undefined' && input instanceof ImageData) return true;
    return !!(input && (input.width != null && input.height != null));
  }

  function toVec(out) {
    let raw = null;
    if (!out) return null;
    if (out.data && out.data.length != null) raw = out.data;
    else if (typeof out.tolist === 'function') { const l = out.tolist(); raw = Array.isArray(l[0]) ? l[0] : l; }
    else if (Array.isArray(out)) raw = Array.isArray(out[0]) ? out[0] : out;
    if (!raw) return null;
    const v = Float32Array.from(raw);
    let norm = 0; for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;   // L2-normalize for cosine
    return v;
  }

  async function run(input, opts) {
    await load();
    const kind = (opts && opts.kind) || (isImage(input) ? 'image' : 'text');
    const task = kind === 'image' ? 'image-feature-extraction' : 'feature-extraction';
    let out;
    try { const pipe = await pipeFor(task); out = await pipe(input); }
    catch (e) { return [C.failureEvent(ref, 'clip embed failed: ' + (e && e.message), { recoverable: true })]; }
    const vec = toVec(out);
    if (!vec) return [C.failureEvent(ref, 'clip produced no vector', { recoverable: true })];
    const region = kind === 'image'
      ? { kind: 'bbox', x: 0, y: 0, w: (input && input.width) || 0, h: (input && input.height) || 0 }
      : { kind: 'charoffset', start: 0, end: String(input == null ? '' : input).length };
    return [C.event({
      adapter: ref,
      region,
      confidence: 1,
      payload: { vec, dim: vec.length },
      meta: { kind, model: MODEL, normalized: true },
    })];
  }

  async function unload() { for (const k of Object.keys(pipes)) delete pipes[k]; _ready = false; }

  window.EOAdapters.register({ manifest, load, ready, run, unload });
})();
