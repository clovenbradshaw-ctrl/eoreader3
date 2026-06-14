/* ============================================================
   PDF text adapter — born-digital PDF → text runs (capability "pdf-text",
   modality "pdf"). This is the canonical proof of the contract: there is no ML
   in it, so confidence is 1.0 with semantics "deterministic".

   One event per text run, region.kind "bbox", payload { text, fontSize,
   fontName }.

   Two code paths, identical output shape:
     • PREFERRED — pdfjs-dist (resolved from window.EO_PDFJS, a global
       window.pdfjsLib, or a CDN import). Handles real-world PDFs, including
       FlateDecode-compressed content streams.
     • FALLBACK — a built-in, dependency-free extractor for UNCOMPRESSED content
       streams (the PDF text operators BT…ET / Tf / Td / Tj). It needs no
       library and no network, so the contract runs end-to-end in Node and at
       file://. Compressed or complex PDFs need the pdfjs path; that scope is
       declared in the manifest's failureModes.
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const manifest = {
    id: 'pdf-text-pdfjs',
    name: 'PDF text (pdf.js)',
    version: '1.0.0',
    category: 'parsing',
    modality: 'pdf',
    capability: 'pdf-text',
    modelRef: { runtime: 'deterministic', model: 'pdfjs-dist', version: '4.x' },
    resources: { backend: 'cpu', memMB: 30, expectedLatencyMs: 200 },
    confidenceSemantics: 'deterministic',
    failureModes: [
      'scanned/image-only PDFs carry no text layer (use the OCR adapter instead)',
      'built-in fallback reads UNCOMPRESSED content streams only — compressed (FlateDecode) PDFs need the pdf.js path',
      'malformed PDF binary (reported as a failure event)',
    ],
    output: { event: 'one per text run', payload: '{ text: string, fontSize: number, fontName: string }' },
    meta: { cdn: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76' },
  };
  const ref = { id: manifest.id, version: manifest.version };

  let _ready = false;
  let lib = null, libP = null;
  async function resolveLib() {
    if (window.EO_PDFJS) return window.EO_PDFJS;
    if (window.pdfjsLib) return window.pdfjsLib;
    if (!libP) {
      libP = (async () => {
        try {
          const mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs');
          const m = mod.default || mod;
          try { if (m.GlobalWorkerOptions) m.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs'; } catch (_) {}
          return m;
        } catch (_) { return null; }   // no lib → built-in fallback handles it
      })();
    }
    return libP;
  }
  async function load() { lib = await resolveLib(); _ready = true; }
  const ready = () => _ready;

  async function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    // Any typed array / DataView / Buffer (incl. cross-realm) → byte view.
    if (input && typeof input === 'object' && ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());   // Blob / File
    if (typeof input === 'string') { const u = new Uint8Array(input.length); for (let i = 0; i < input.length; i++) u[i] = input.charCodeAt(i) & 0xff; return u; }
    if (input && input.data) return toBytes(input.data);
    throw new Error('unsupported PDF input (expected Blob, ArrayBuffer, Uint8Array, or string)');
  }

  // ---- preferred path: pdfjs-dist ------------------------------------------
  async function viaPdfjs(L, bytes) {
    const pdf = await L.getDocument({ data: bytes }).promise;
    const events = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      for (const it of (tc.items || [])) {
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        const fontSize = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || 0;
        events.push(C.event({
          adapter: ref,
          region: { kind: 'bbox', x: tr[4] || 0, y: tr[5] || 0, w: it.width || 0, h: it.height || fontSize },
          confidence: 1,
          payload: { text: String(it.str || ''), fontSize, fontName: String(it.fontName || '') },
          meta: { page: p, via: 'pdfjs' },
        }));
      }
    }
    return events;
  }

  // ---- fallback path: built-in extractor for uncompressed streams ----------
  function bytesToLatin1(u) { let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return s; }

  // Tokenize a content stream into operands/operators, handling literal and hex
  // strings (with escapes) so '(' inside text never confuses the scan.
  function tokenize(s) {
    const toks = []; let i = 0; const n = s.length;
    const delim = /[\s()<>\[\]{}\/%]/;
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }
      if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      if (c === '(') {
        let depth = 1, j = i + 1, str = '';
        const oct = { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1 };
        const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        while (j < n && depth > 0) {
          const ch = s[j];
          if (ch === '\\') {
            const nx = s[j + 1];
            if (nx in esc) { str += esc[nx]; j += 2; continue; }
            if (oct[nx]) { let o = nx; j += 2; for (let k = 0; k < 2 && oct[s[j]]; k++) { o += s[j]; j++; } str += String.fromCharCode(parseInt(o, 8) & 0xff); continue; }
            j += 2; continue;   // backslash-newline (line continuation) and unknowns
          }
          if (ch === '(') { depth++; str += ch; j++; continue; }
          if (ch === ')') { depth--; if (depth > 0) str += ch; j++; continue; }
          str += ch; j++;
        }
        toks.push({ t: 'str', v: str }); i = j; continue;
      }
      if (c === '<') {
        if (s[i + 1] === '<') { toks.push({ t: 'op', v: '<<' }); i += 2; continue; }
        let j = i + 1, hex = ''; while (j < n && s[j] !== '>') { hex += s[j]; j++; } j++;
        hex = hex.replace(/\s+/g, ''); if (hex.length % 2) hex += '0';
        let str = ''; for (let k = 0; k < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.substr(k, 2), 16) & 0xff);
        toks.push({ t: 'str', v: str }); i = j; continue;
      }
      if (c === '>') { if (s[i + 1] === '>') { toks.push({ t: 'op', v: '>>' }); i += 2; continue; } i++; continue; }
      if (c === '[' || c === ']') { toks.push({ t: 'op', v: c }); i++; continue; }
      if (c === '/') { let j = i + 1, nm = ''; while (j < n && !delim.test(s[j])) { nm += s[j]; j++; } toks.push({ t: 'name', v: nm }); i = j; continue; }
      if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) { let j = i, num = ''; while (j < n && /[-+.\d]/.test(s[j])) { num += s[j]; j++; } toks.push({ t: 'num', v: parseFloat(num) }); i = j; continue; }
      let j = i, op = ''; while (j < n && !delim.test(s[j])) { op += s[j]; j++; } toks.push({ t: 'op', v: op || s[i] }); i = (j > i ? j : i + 1);
    }
    return toks;
  }

  function extractRuns(content) {
    const toks = tokenize(content);
    const runs = [];
    let st = [];
    let fontSize = 0, fontName = '', x = 0, y = 0, arr = null;
    const lastNum = () => { for (let k = st.length - 1; k >= 0; k--) if (st[k].t === 'num') return st[k].v; return 0; };
    const lastName = () => { for (let k = st.length - 1; k >= 0; k--) if (st[k].t === 'name') return st[k].v; return ''; };
    const nums = () => st.filter(o => o.t === 'num').map(o => o.v);
    for (const tk of toks) {
      if (tk.t !== 'op') {
        if (arr && tk.t === 'str') arr.push(tk.v);
        st.push(tk);
        continue;
      }
      const op = tk.v;
      if (op === 'BT') { st = []; x = 0; y = 0; }
      else if (op === 'ET') { st = []; }
      else if (op === '[') { arr = []; }
      else if (op === ']') { /* keep arr until TJ */ }
      else if (op === 'Tf') { fontSize = lastNum() || fontSize; fontName = lastName() || fontName; st = []; }
      else if (op === 'Td' || op === 'TD') { const a = nums(); if (a.length >= 2) { x += a[a.length - 2]; y += a[a.length - 1]; } st = []; }
      else if (op === 'Tm') { const a = nums(); if (a.length >= 6) { x = a[4]; y = a[5]; } st = []; }
      else if (op === 'T*') { st = []; }
      else if (op === 'Tj') {
        const last = st.length && st[st.length - 1].t === 'str' ? st[st.length - 1].v : '';
        if (last) runs.push({ text: last, x, y, fontSize, fontName });
        st = [];
      }
      else if (op === 'TJ') {
        const text = (arr || []).join('');
        if (text) runs.push({ text, x, y, fontSize, fontName });
        arr = null; st = [];
      }
      else { st = []; }
    }
    return runs;
  }

  function viaBuiltin(bytes) {
    const s = bytesToLatin1(bytes);
    const events = [];
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m;
    while ((m = re.exec(s))) {
      const content = m[1];
      // Skip obviously binary/compressed streams (a quick text-operator probe).
      if (content.indexOf('BT') < 0 && content.indexOf('Tj') < 0 && content.indexOf('TJ') < 0) continue;
      for (const r of extractRuns(content)) {
        events.push(C.event({
          adapter: ref,
          region: { kind: 'bbox', x: r.x, y: r.y, w: Math.max(0, r.text.length * (r.fontSize || 10) * 0.5), h: r.fontSize || 0 },
          confidence: 1,
          payload: { text: r.text, fontSize: r.fontSize || 0, fontName: r.fontName || '' },
          meta: { via: 'builtin' },
        }));
      }
    }
    return events;
  }

  async function run(input) {
    await load();
    let bytes;
    try { bytes = await toBytes(input); }
    catch (e) { return [C.failureEvent(ref, e && e.message, { recoverable: false })]; }
    if (lib && lib.getDocument) {
      try { const ev = await viaPdfjs(lib, bytes); if (ev.length) return ev; } catch (_) { /* fall through */ }
    }
    return viaBuiltin(bytes);
  }

  async function unload() { lib = null; libP = null; _ready = false; }

  window.EOAdapters.register({ manifest, load, ready, run, unload });
})();
