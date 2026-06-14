/* ============================================================
   OCR adapter — Microsoft TrOCR via transformers.js.

   Registers two adapters that share this file and the transformers.js runtime
   but wrap different weights:
     • ocr-trocr-printed      → Xenova/trocr-small-printed
     • ocr-trocr-handwritten  → Xenova/trocr-small-handwritten

   Same event shape as the Tesseract adapter (capability "ocr", modality
   "image", one event with payload { text }). Heavier than Tesseract — WebGPU
   preferred, ~250 MB of weights — but more accurate on degraded printed
   documents and the only path for handwriting.

   CONFIDENCE: TrOCR (a seq2seq decoder) exposes no calibrated confidence. We
   declare the semantics as "heuristic" and emit a PRESENCE flag — 1 when the
   model produced non-empty text, 0 when it did not. That is the heuristic,
   stated plainly and emitted as-is; it is ordinal (text vs no text), never to
   be read as a probability. (See the spec on confidence honesty.)
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const TRANSFORMERS_URL = 'https://esm.run/@huggingface/transformers@3.0.2';
  let modP = null;
  async function transformers() {
    if (window.EO_TRANSFORMERS) return window.EO_TRANSFORMERS;
    if (!modP) modP = import(TRANSFORMERS_URL);
    return modP;
  }

  function buildAdapter(spec) {
    const manifest = {
      id: spec.id,
      name: spec.name,
      version: '1.0.0',
      category: 'perceptual',
      modality: 'image',
      capability: 'ocr',
      modelRef: { runtime: 'transformersjs', model: spec.model, version: '3.0.2', weightsBytes: 250 * 1024 * 1024 },
      resources: { backend: 'webgpu', memMB: 260, expectedLatencyMs: 1200 },
      confidenceSemantics: 'heuristic',
      failureModes: [
        'no calibrated confidence — emits a presence flag (1 = text produced, 0 = none)',
        'weights (~250 MB) fail to download / WebGPU unavailable (reported as a failure event)',
        spec.kind === 'handwritten' ? 'cursive or overlapping handwriting may transcribe poorly' : 'heavy layout / multi-column pages are out of scope (single text line per call)',
      ],
      output: { event: 'one per input image', payload: '{ text: string }' },
      meta: { kind: spec.kind },
    };
    const ref = { id: manifest.id, version: manifest.version };

    let pipe = null, pipeP = null, _ready = false;
    async function load() {
      if (pipe) { _ready = true; return; }
      if (!pipeP) {
        pipeP = (async () => {
          const { pipeline } = await transformers();
          pipe = await pipeline('image-to-text', spec.model);
          _ready = true;
          return pipe;
        })();
      }
      await pipeP;
    }
    const ready = () => _ready;

    async function run(input) {
      await load();
      let out;
      try { out = await pipe(input); }
      catch (e) { return [C.failureEvent(ref, 'trocr failed: ' + (e && e.message), { recoverable: true })]; }
      const first = Array.isArray(out) ? out[0] : out;
      const text = String((first && (first.generated_text || first.text)) || '');
      return [C.event({
        adapter: ref,
        region: { kind: 'bbox', x: 0, y: 0, w: 0, h: 0 },
        confidence: text.trim() ? 1 : 0,   // declared heuristic: presence flag
        payload: { text },
        meta: { kind: spec.kind, note: 'confidence is a presence flag, not a probability' },
      })];
    }

    async function unload() { pipe = null; pipeP = null; _ready = false; }
    return { manifest, load, ready, run, unload };
  }

  window.EOAdapters.register(buildAdapter({ id: 'ocr-trocr-printed', name: 'TrOCR (printed)', model: 'Xenova/trocr-small-printed', kind: 'printed' }));
  window.EOAdapters.register(buildAdapter({ id: 'ocr-trocr-handwritten', name: 'TrOCR (handwritten)', model: 'Xenova/trocr-small-handwritten', kind: 'handwritten' }));
})();
