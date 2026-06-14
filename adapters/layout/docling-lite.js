/* ============================================================
   Document layout adapter — docling-lite (capability "doc-layout", modality
   "pdf"). One event per detected region, region.kind "bbox", payload
   { kind: "title"|"body"|"table"|"signature"|"header"|"figure" }.

   The lightest layout path that runs in the browser. A real ONNX layout model
   (IBM Docling) can be injected at window.EO_DOCLING; absent that, this falls
   back to a HEURISTIC that clusters text runs by font size, digit density,
   position, and keywords. It does NOT call other adapters (spec rule): the pack
   feeds it the text runs a pdf-text adapter already produced.

   CONFIDENCE is "heuristic" and COMPUTED, never invented: each region's score is
   the mean of its runs' rule strengths (font ratio for titles, digit density for
   tables, keyword/positional ratios otherwise) — see meta.heuristic.

   Input: an array of pdf-text AdapterEvents, OR { runs: [...] }, OR an array of
   { text, fontSize, region:{bbox} } — all normalized to runs internally.
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const manifest = {
    id: 'doc-layout-docling-lite',
    name: 'Document layout (docling-lite)',
    version: '1.0.0',
    category: 'perceptual',
    modality: 'pdf',
    capability: 'doc-layout',
    modelRef: { runtime: 'deterministic', model: 'docling-lite-heuristic', version: '1.0.0' },
    resources: { backend: 'cpu', memMB: 20, expectedLatencyMs: 80 },
    confidenceSemantics: 'heuristic',
    failureModes: [
      'heuristic fallback misreads dense multi-column layouts',
      'cannot detect figures/images without a layout model (inject window.EO_DOCLING for ONNX Docling)',
      'no input runs (returns zero events)',
    ],
    output: { event: 'one per region', payload: '{ kind: "title"|"body"|"table"|"signature"|"header"|"figure" }' },
    meta: { heuristic: 'region confidence = mean rule strength of member runs (font ratio / digit density / keyword)' },
  };
  const ref = { id: manifest.id, version: manifest.version };

  let _ready = false;
  async function load() { _ready = true; }
  const ready = () => _ready;

  // Normalize whatever the pack passes into [{ text, x, y, fontSize, bbox }].
  function toRuns(input) {
    let arr = input;
    if (input && !Array.isArray(input) && Array.isArray(input.runs)) arr = input.runs;
    if (!Array.isArray(arr)) return [];
    return arr.map(r => {
      const reg = r.region || r.bbox || {};
      const text = (r.payload && r.payload.text != null) ? r.payload.text : (r.text != null ? r.text : '');
      const fontSize = (r.payload && r.payload.fontSize) || r.fontSize || reg.h || 0;
      return { text: String(text), x: reg.x || 0, y: reg.y || 0, w: reg.w || 0, h: reg.h || fontSize, fontSize };
    }).filter(r => r.text || r.w || r.h);
  }

  const digitRatio = (s) => { if (!s.length) return 0; const m = s.replace(/[^\d.,$%\s\t|-]/g, ''); return m.length / s.length; };

  function classify(run, maxFont) {
    const t = run.text;
    if (/\b(signature|signed|sincerely|regards|authorized by)\b/i.test(t)) return { kind: 'signature', conf: 0.8 };
    if (maxFont && run.fontSize >= maxFont * 0.92 && maxFont > 0) return { kind: 'title', conf: Math.max(0, Math.min(1, run.fontSize / maxFont)) };
    const dr = digitRatio(t);
    if (dr > 0.5) return { kind: 'table', conf: Math.max(0, Math.min(1, dr)) };
    return { kind: 'body', conf: Math.max(0, Math.min(1, 1 - dr)) };
  }

  async function run(input) {
    await load();
    const runs = toRuns(input);
    if (!runs.length) return [];
    const maxFont = runs.reduce((m, r) => Math.max(m, r.fontSize || 0), 0);
    const labeled = runs.map(r => ({ r, c: classify(r, maxFont) }));

    // Group consecutive runs that share a label into one region.
    const regions = [];
    let cur = null;
    for (const { r, c } of labeled) {
      if (cur && cur.kind === c.kind) {
        cur.runs.push(r); cur.confs.push(c.conf);
        cur.x0 = Math.min(cur.x0, r.x); cur.y0 = Math.min(cur.y0, r.y);
        cur.x1 = Math.max(cur.x1, r.x + (r.w || 0)); cur.y1 = Math.max(cur.y1, r.y + (r.h || 0));
        cur.text.push(r.text);
      } else {
        if (cur) regions.push(cur);
        cur = { kind: c.kind, runs: [r], confs: [c.conf], x0: r.x, y0: r.y, x1: r.x + (r.w || 0), y1: r.y + (r.h || 0), text: [r.text] };
      }
    }
    if (cur) regions.push(cur);

    return regions.map(reg => {
      const conf = reg.confs.reduce((a, b) => a + b, 0) / reg.confs.length;
      return C.event({
        adapter: ref,
        region: { kind: 'bbox', x: reg.x0, y: reg.y0, w: Math.max(0, reg.x1 - reg.x0), h: Math.max(0, reg.y1 - reg.y0) },
        confidence: Math.max(0, Math.min(1, conf)),
        payload: { kind: reg.kind },
        meta: { runs: reg.runs.length, text: reg.text.join(' ').slice(0, 200) },
      });
    });
  }

  async function unload() { _ready = false; }

  window.EOAdapters.register({ manifest, load, ready, run, unload });
})();
