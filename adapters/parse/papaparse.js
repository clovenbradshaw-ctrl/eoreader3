/* ============================================================
   CSV adapter — tabular text → typed rows (capability "csv-parse", modality
   "table"). Deterministic: confidence 1.0, semantics "deterministic".

   One event per data row, region.kind "row" (the row index), payload is the
   typed row object (header → value).

   Prefers papaparse (window.EO_PAPAPARSE, a global window.Papa, or a CDN
   import); falls back to a built-in RFC-4180-ish parser (quotes, escaped quotes,
   embedded newlines, numeric coercion) so the contract runs with no dependency
   in Node and at file://.
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const manifest = {
    id: 'csv-parse-papaparse',
    name: 'CSV parser (papaparse)',
    version: '1.0.0',
    category: 'parsing',
    modality: 'table',
    capability: 'csv-parse',
    modelRef: { runtime: 'deterministic', model: 'papaparse', version: '5.x' },
    resources: { backend: 'cpu', memMB: 10, expectedLatencyMs: 50 },
    confidenceSemantics: 'deterministic',
    failureModes: [
      'ragged rows (more/fewer fields than the header) — extra fields are dropped, missing are empty',
      'ambiguous delimiter when papaparse is absent (built-in assumes comma)',
    ],
    output: { event: 'one per data row', payload: 'typed row object (header → value)' },
    meta: { cdn: 'https://cdn.jsdelivr.net/npm/papaparse@5' },
  };
  const ref = { id: manifest.id, version: manifest.version };

  let _ready = false, lib = null, libP = null;
  async function resolveLib() {
    if (window.EO_PAPAPARSE) return window.EO_PAPAPARSE;
    if (window.Papa) return window.Papa;
    if (!libP) libP = (async () => { try { const m = await import('https://cdn.jsdelivr.net/npm/papaparse@5.4.1/+esm'); return m.default || m; } catch (_) { return null; } })();
    return libP;
  }
  async function load() { lib = await resolveLib(); _ready = true; }
  const ready = () => _ready;

  async function toText(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.text === 'function') return input.text();   // File / Blob
    if (input && typeof input.arrayBuffer === 'function') return bytesToText(new Uint8Array(await input.arrayBuffer()));
    return String(input == null ? '' : input);
  }
  function bytesToText(u) { try { return new TextDecoder('utf-8').decode(u); } catch (_) { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return s; } }

  const coerce = (v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) { const n = Number(t); if (isFinite(n)) return n; }
    return v;
  };

  // Built-in RFC-4180-ish parser → array of arrays.
  function parseGrid(text) {
    const rows = []; let row = []; let field = ''; let inQ = false; let i = 0; const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
  }

  function viaBuiltin(text) {
    const grid = parseGrid(text);
    if (!grid.length) return [];
    const header = grid[0];
    const out = [];
    for (let r = 1; r < grid.length; r++) {
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = coerce(grid[r][c] == null ? '' : grid[r][c]);
      out.push(obj);
    }
    return out;
  }

  async function run(input, opts) {
    await load();
    let text;
    try { text = await toText(input); }
    catch (e) { return [C.failureEvent(ref, 'csv read failed: ' + (e && e.message), { recoverable: false })]; }
    let rows;
    if (lib && typeof lib.parse === 'function') {
      const res = lib.parse(text, Object.assign({ header: true, dynamicTyping: true, skipEmptyLines: true }, opts || {}));
      rows = (res && res.data) || [];
    } else {
      rows = viaBuiltin(text);
    }
    return rows.map((obj, i) => C.event({
      adapter: ref,
      region: { kind: 'row', index: i },
      confidence: 1,
      payload: obj,
      meta: { via: (lib && lib.parse) ? 'papaparse' : 'builtin' },
    }));
  }

  async function unload() { lib = null; libP = null; _ready = false; }

  window.EOAdapters.register({ manifest, load, ready, run, unload });
})();
