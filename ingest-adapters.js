/* ============================================================
   Cleo — the perceptual-ingest bridge (window.EOIngestAdapters).

   The adapter library (window.EOAdapters) turns a non-text file into EVENTS —
   ASR segments, OCR words, PDF text runs — each with confidence and provenance.
   But the spec is strict: an adapter does NOT interpret. Turning those events
   back into the text the reading engine ingests is the PACK's job, one altitude
   up. This module is that pack-side glue for the "add a file" flow: it decides
   which adapter a dropped file wants, and it folds the adapter's events into a
   string the engine reads — a WebVTT transcript for speech (so the engine's
   transcript reader turns timecodes into turn structure), reading-ordered prose
   for OCR and PDF.

   It is pure and dependency-free (no DOM, no adapter calls) so the conversion
   is exercised in Node with plain event objects. app.jsx supplies the File and
   runs the adapter; this only routes and folds.

   Published as window.EOIngestAdapters; also module.exports under Node.
   ============================================================ */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window
    : (typeof self !== 'undefined') ? self
    : (typeof globalThis !== 'undefined') ? globalThis : {};

  // ---- file → route --------------------------------------------------------
  // How a freshly-added file should be read. "text" keeps the existing
  // readAsText path BYTE-FOR-BYTE (the parity floor for the formats the app
  // already read); "adapter" routes through a perceptual/parsing adapter by
  // capability; "unsupported" is an honest decline. Decided from the file's
  // name and MIME type only — both are advisory, so we check each.
  const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba|webm)$/i;
  const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?|avif|heic|heif)$/i;
  const PDF_EXT   = /\.pdf$/i;
  // The text formats the reader already handled (plus a few obvious siblings).
  // .vtt/.srt are transcripts AS TEXT — the engine reads their typography, so
  // they belong on the text path, not the ASR adapter.
  const TEXT_EXT  = /\.(txt|text|md|markdown|mdown|mkd|csv|tsv|tab|log|vtt|srt)$/i;

  function routeFile(file) {
    const name = (file && file.name) || '';
    const type = String((file && file.type) || '').toLowerCase();
    // Text first, so nothing the app used to read is rerouted.
    if (TEXT_EXT.test(name) || type === 'text/plain' || type === 'text/csv' || type.indexOf('text/') === 0) {
      return { kind: 'text' };
    }
    if (type.indexOf('audio/') === 0 || AUDIO_EXT.test(name)) {
      return { kind: 'adapter', capability: 'asr', stage: 'transcribing', verb: 'Transcribed', gerund: 'Transcribing' };
    }
    if (type.indexOf('image/') === 0 || IMAGE_EXT.test(name)) {
      return { kind: 'adapter', capability: 'ocr', stage: 'recognizing', verb: 'Read', gerund: 'Reading the text in' };
    }
    if (type === 'application/pdf' || PDF_EXT.test(name)) {
      return { kind: 'adapter', capability: 'pdf-text', stage: 'extracting', verb: 'Extracted text from', gerund: 'Extracting text from' };
    }
    return { kind: 'unsupported' };
  }

  // The browser `accept` attribute for the file picker — derived from the same
  // routing so the picker and the dispatcher never drift.
  const ACCEPT = [
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.log', '.vtt', '.srt', 'text/plain',
    'audio/*', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac',
    'image/*', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff',
    'application/pdf', '.pdf',
  ].join(',');

  // ---- event helpers -------------------------------------------------------
  const isFailure = (e) => !!(e && e.meta && e.meta.kind === 'failure');
  const evText = (e) => (e && e.payload && typeof e.payload.text === 'string') ? e.payload.text : '';
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

  // seconds → "HH:MM:SS.mmm" (the WebVTT/SRT-ish cue shape the engine's
  // TC_LINE_RE matches, so a cue line reads as transcript structure).
  function fmtTimecode(sec) {
    let s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const whole = Math.floor(s);
    const ms = Math.min(999, Math.round((s - whole) * 1000));
    const p = (n, w) => String(n).padStart(w, '0');
    return p(h, 2) + ':' + p(m, 2) + ':' + p(whole, 2) + '.' + p(ms, 3);
  }

  // ---- folders: events → text ----------------------------------------------
  // ASR → WebVTT. The engine reads timecodes as turn boundaries (never sentence
  // content) and any "Speaker:" labels Whisper emits as attribution. One cue per
  // segment; the WEBVTT header and each "-->" line are the cue typography the
  // transcript reader counts (≥2 segments clears its threshold).
  function asrToVtt(events) {
    const lines = ['WEBVTT', ''];
    let n = 0;
    for (const e of (events || [])) {
      if (isFailure(e)) continue;
      const text = evText(e).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const r = e.region || {};
      const start = num(r.start) != null ? r.start : 0;
      let end = num(r.end) != null ? r.end : start;
      if (!(end > start)) end = start + 0.001;
      lines.push(fmtTimecode(start) + ' --> ' + fmtTimecode(end));
      lines.push(text);
      lines.push('');
      n++;
    }
    return n ? lines.join('\n').trim() + '\n' : '';
  }

  // OCR → reading-ordered text. Words arrive in reading order; a downward jump
  // in the top-y beyond ~0.6 of the median word height starts a new line. A
  // whole-page event (no per-word boxes) is used verbatim.
  function ocrToText(events) {
    const words = (events || []).filter(e => !isFailure(e) && evText(e).trim());
    if (!words.length) return '';
    if (words.length === 1 && words[0].meta && words[0].meta.level === 'page') {
      return evText(words[0]).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    }
    const hs = words.map(w => (w.region && num(w.region.h)) || 0).filter(h => h > 0).sort((a, b) => a - b);
    const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    const gap = medH ? medH * 0.6 : Infinity;   // no heights → one line
    let out = '', prevY = null;
    for (const w of words) {
      const t = evText(w).trim();
      const y = (w.region && num(w.region.y));
      if (out) out += (prevY != null && y != null && (y - prevY) > gap) ? '\n' : ' ';
      out += t;
      if (y != null) prevY = y;
    }
    return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  }

  // PDF → text. Runs arrive per page in stream order. A page change (meta.page)
  // is a paragraph break; within a page a y-shift beyond ~half the font size is
  // a line break; otherwise runs join with a single space unless already
  // whitespace-bounded. (Born-digital extraction; intra-line spacing follows the
  // producer's runs — declared as a limitation in the PDF adapter's manifest.)
  function pdfToText(events) {
    const runs = (events || []).filter(e => !isFailure(e) && evText(e) !== '');
    if (!runs.length) return '';
    let out = '', prevY = null, prevPage = null;
    for (const e of runs) {
      const t = evText(e);
      const r = e.region || {};
      const page = (e.meta && e.meta.page != null) ? e.meta.page : null;
      const y = num(r.y);
      const fs = num(e.payload && e.payload.fontSize) || num(r.h) || 10;
      const gap = Math.max(2, fs * 0.5);
      if (out) {
        if (prevPage != null && page != null && page !== prevPage) out += '\n\n';
        else if (prevY != null && y != null && Math.abs(y - prevY) > gap) out += '\n';
        else if (!/\s$/.test(out) && !/^\s/.test(t)) out += ' ';
      }
      out += t;
      if (y != null) prevY = y;
      if (page != null) prevPage = page;
    }
    return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---- provenance ----------------------------------------------------------
  // A compact, serializable record of HOW the text was produced — which adapter,
  // its mean (heuristic) confidence, device/precision, detected language, and any
  // non-fatal failures — to ride on the doc for the audit and the toast. Never
  // read as calibrated: confidence semantics live in the adapter's manifest.
  function summarize(capability, events) {
    const list = events || [];
    const real = list.filter(e => !isFailure(e));
    const fails = list.filter(isFailure);
    let sum = 0, cn = 0, adapter = null, device = null, dtype = null, language = null;
    for (const e of real) {
      if (typeof e.confidence === 'number') { sum += e.confidence; cn++; }
      if (!adapter && e.adapter && e.adapter.id) adapter = e.adapter;
      if (e.meta) { device = device || e.meta.device || null; dtype = dtype || e.meta.dtype || null; }
      if (e.payload && e.payload.language) language = language || e.payload.language;
    }
    return {
      via: capability,
      adapter: adapter ? adapter.id : null,
      adapterVersion: adapter ? adapter.version : null,
      events: real.length,
      confidenceMean: cn ? Math.round((sum / cn) * 1000) / 1000 : null,
      device, dtype, language,
      failures: fails.map(f => (f.payload && f.payload.error) || 'adapter failure'),
    };
  }

  // The one call app.jsx makes after running an adapter: fold the events into
  // { text, provenance } for the right capability.
  function eventsToText(capability, events) {
    const list = Array.isArray(events) ? events : [];
    let text = '';
    if (capability === 'asr') text = asrToVtt(list);
    else if (capability === 'ocr') text = ocrToText(list);
    else if (capability === 'pdf-text') text = pdfToText(list);
    else text = list.filter(e => !isFailure(e)).map(evText).filter(Boolean).join('\n').trim();
    return { text, provenance: summarize(capability, list) };
  }

  // Every event was a failure (a hard decline) vs. at least one observation.
  const allFailed = (events) => Array.isArray(events) && events.length > 0 && events.every(isFailure);
  const firstError = (events) => {
    const f = (events || []).find(isFailure);
    return f ? ((f.payload && f.payload.error) || 'adapter failure') : null;
  };

  G.EOIngestAdapters = {
    routeFile, ACCEPT,
    eventsToText, asrToVtt, ocrToText, pdfToText,
    fmtTimecode, summarize, allFailed, firstError, isFailure,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = G.EOIngestAdapters;
})();
