/* ============================================================
   OCR adapter — Tesseract.js (capability "ocr", modality "image").

   Wraps tesseract.js (the WASM build of the Tesseract engine). One event per
   detected word, region.kind "bbox", payload { text }, confidence is
   Tesseract's per-word score normalized from [0,100] to [0,1].

   CALIBRATION (declared in the manifest): Tesseract's confidence is a HEURISTIC,
   not a calibrated probability. Treat it as ordinal (rank words), not metric
   (do not read 0.7 as "70% likely correct"). We emit it as-is — no invention.

   The library is resolved from, in order: an injected window.EO_TESSERACT (the
   test seam), a global window.Tesseract (UMD script tag), or a dynamic import
   from unpkg (a host index.html already trusts). Loading is lazy: registration
   costs nothing, the worker spins up on first load()/run().
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const manifest = {
    id: 'ocr-tesseract',
    name: 'Tesseract OCR',
    version: '1.0.0',
    category: 'perceptual',
    modality: 'image',
    capability: 'ocr',
    modelRef: { runtime: 'tesseract', model: 'tesseract.js/eng', version: '5' },
    resources: { backend: 'wasm', memMB: 60, expectedLatencyMs: 1500 },
    confidenceSemantics: 'heuristic',
    failureModes: [
      'low-confidence words on degraded or low-DPI scans',
      'no text regions found (returns zero events)',
      'worker/WASM load failure (reported as a failure event)',
    ],
    output: { event: 'one per detected word', payload: '{ text: string }' },
    meta: { calibration: 'per-word confidence is heuristic — ordinal, not metric', lang: 'eng', cdn: 'https://unpkg.com/tesseract.js@5' },
  };
  const ref = { id: manifest.id, version: manifest.version };

  let worker = null, workerP = null, _ready = false;

  async function resolveLib() {
    if (window.EO_TESSERACT) return window.EO_TESSERACT;
    if (window.Tesseract) return window.Tesseract;
    const mod = await import('https://unpkg.com/tesseract.js@5');
    return mod.default || mod;
  }

  async function load() {
    if (worker) { _ready = true; return; }
    if (!workerP) {
      workerP = (async () => {
        const T = await resolveLib();
        // tesseract.js v5: createWorker(lang) returns a ready worker.
        const w = await T.createWorker(manifest.meta.lang);
        worker = w;
        _ready = true;
        return w;
      })();
    }
    await workerP;
  }
  const ready = () => _ready;

  async function run(input, opts) {
    await load();
    let res;
    try {
      res = await worker.recognize(input, opts || {});
    } catch (e) {
      return [C.failureEvent(ref, 'tesseract recognize failed: ' + (e && e.message), { recoverable: true })];
    }
    const data = (res && res.data) || {};
    const words = Array.isArray(data.words) ? data.words : [];
    const events = [];
    for (const w of words) {
      const b = w.bbox || {};
      events.push(C.event({
        adapter: ref,
        region: { kind: 'bbox', x: b.x0 || 0, y: b.y0 || 0, w: (b.x1 || 0) - (b.x0 || 0), h: (b.y1 || 0) - (b.y0 || 0) },
        // Tesseract reports 0..100; clamp to [0,1] and emit the heuristic as-is.
        confidence: Math.max(0, Math.min(1, (typeof w.confidence === 'number' ? w.confidence : 0) / 100)),
        payload: { text: String(w.text == null ? '' : w.text) },
        meta: { level: 'word' },
      }));
    }
    // No per-word boxes (some builds only give whole-page text): emit one event
    // for the page rather than dropping the observation.
    if (!events.length && data.text) {
      events.push(C.event({
        adapter: ref,
        region: { kind: 'bbox', x: 0, y: 0, w: 0, h: 0 },
        confidence: Math.max(0, Math.min(1, (typeof data.confidence === 'number' ? data.confidence : 0) / 100)),
        payload: { text: String(data.text) },
        meta: { level: 'page' },
      }));
    }
    return events;
  }

  async function unload() {
    try { if (worker && worker.terminate) await worker.terminate(); } catch (_) {}
    worker = null; workerP = null; _ready = false;
  }

  window.EOAdapters.register({ manifest, load, ready, run, unload });
})();
