/* ============================================================
   ingest-adapters — the perceptual-ingest bridge (window.EOIngestAdapters).

   Pure unit tests for the glue that routes a dropped file to its adapter and
   folds the adapter's events back into the text the engine reads. No DOM, no
   adapters, no network — plain event objects in, strings out.

   The load-bearing assertion: the WebVTT a speech file folds into is recognized
   as a TRANSCRIPT by the engine's own cue regex (a verbatim copy of engine.js's
   TC_LINE_RE), so the timecodes become turn structure rather than sentence text.
   ============================================================ */
'use strict';
const B = require('../ingest-adapters.js');

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ FAIL — ' + name + (extra ? '\n      ' + extra : '')); }
};

// ---- a verbatim copy of engine.js's transcript-cue typography --------------
const _TC = '\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,3})?';
const TC_LINE_RE = new RegExp('^\\s*(?:\\[' + _TC + '\\]|\\(' + _TC + '\\)|' + _TC + ')(?:\\s*(?:-->|–|—|,)\\s*(?:\\[?' + _TC + '\\]?))?\\s*$');

// ---- event builders (the contract shape, minimally) ------------------------
const asrEvent = (start, end, text, extra) => Object.assign({
  id: 'e', adapter: { id: 'asr-whisper-base', version: '1.1.0' },
  region: { kind: 'timerange', start, end }, confidence: 0.9,
  payload: { text, language: 'en' }, t: '', meta: { device: 'wasm', dtype: 'q8' },
}, extra || {});
const ocrWord = (x, y, w, h, text, conf) => ({
  id: 'e', adapter: { id: 'ocr-tesseract', version: '1.0.0' },
  region: { kind: 'bbox', x, y, w, h }, confidence: conf == null ? 0.8 : conf,
  payload: { text }, t: '', meta: { level: 'word' },
});
const pdfRun = (page, y, text, fontSize) => ({
  id: 'e', adapter: { id: 'pdf-text-pdfjs', version: '1.0.0' },
  region: { kind: 'bbox', x: 0, y, w: 10, h: fontSize || 10 }, confidence: 1,
  payload: { text, fontSize: fontSize || 10, fontName: 'F' }, t: '', meta: { page },
});
const failEvent = (msg) => ({
  id: 'e', adapter: { id: 'asr-whisper-base', version: '1.1.0' },
  region: { kind: 'charoffset', start: 0, end: 0 }, confidence: 0,
  payload: { error: msg }, t: '', meta: { kind: 'failure', recoverable: false },
});

// ---- routeFile -------------------------------------------------------------
ok('routes .mp3 by extension to asr', B.routeFile({ name: 'talk.mp3' }).capability === 'asr');
ok('routes audio/* MIME (no ext) to asr', B.routeFile({ name: 'clip', type: 'audio/mpeg' }).capability === 'asr');
ok('routes .png to ocr', B.routeFile({ name: 'scan.PNG' }).capability === 'ocr');
ok('routes image/* MIME to ocr', B.routeFile({ name: 'shot', type: 'image/jpeg' }).capability === 'ocr');
ok('routes .pdf to pdf-text', B.routeFile({ name: 'paper.pdf' }).capability === 'pdf-text');
ok('routes application/pdf MIME to pdf-text', B.routeFile({ name: 'p', type: 'application/pdf' }).capability === 'pdf-text');
ok('keeps .txt on the text path', B.routeFile({ name: 'notes.txt' }).kind === 'text');
ok('keeps .csv on the text path', B.routeFile({ name: 'data.csv' }).kind === 'text');
ok('keeps text/plain MIME on the text path', B.routeFile({ name: 'x', type: 'text/plain' }).kind === 'text');
ok('.vtt is transcript-AS-TEXT, not asr', B.routeFile({ name: 'subs.vtt' }).kind === 'text');
ok('unknown type declines honestly', B.routeFile({ name: 'mystery.xyz' }).kind === 'unsupported');

// ---- fmtTimecode -----------------------------------------------------------
ok('fmtTimecode(0)', B.fmtTimecode(0) === '00:00:00.000');
ok('fmtTimecode(1.2)', B.fmtTimecode(1.2) === '00:00:01.200');
ok('fmtTimecode(3661.5) carries hours', B.fmtTimecode(3661.5) === '01:01:01.500');
ok('fmtTimecode clamps sub-ms (no 4-digit ms)', /^\d\d:\d\d:\d\d\.\d{3}$/.test(B.fmtTimecode(1.9999)));
ok('fmtTimecode(-5) floors at zero', B.fmtTimecode(-5) === '00:00:00.000');

// ---- asrToVtt: the transcript trigger --------------------------------------
{
  const vtt = B.asrToVtt([asrEvent(0, 1.2, 'hello'), asrEvent(1.2, 2.0, 'world')]);
  const lines = vtt.split('\n');
  const cueLines = lines.filter(l => l.indexOf('-->') >= 0);
  ok('asrToVtt emits a WEBVTT header', /^WEBVTT/.test(vtt));
  ok('asrToVtt emits one cue per segment', cueLines.length === 2);
  ok('every cue line matches the engine TC_LINE_RE', cueLines.every(l => TC_LINE_RE.test(l.trim())),
    JSON.stringify(cueLines));
  // The engine counts WEBVTT + each cue line as a "cue"; ≥3 with content flips
  // its isTranscript decision (cues >= 3 && content > 0).
  const cueCount = (/^WEBVTT/m.test(vtt) ? 1 : 0) + cueLines.length;
  ok('cue count clears the transcript threshold (>=3)', cueCount >= 3, 'cueCount=' + cueCount);
  ok('segment text survives as content', /hello/.test(vtt) && /world/.test(vtt));
}
ok('asrToVtt skips failure events', !/error/.test(B.asrToVtt([asrEvent(0, 1, 'kept'), failEvent('boom')])));
ok('asrToVtt is empty with no real segments', B.asrToVtt([failEvent('x')]) === '');
ok('asrToVtt handles a null/0 end timestamp', /-->/.test(B.asrToVtt([asrEvent(0, null, 'one chunk')])));

// ---- ocrToText (now reconstructs via EOImportStructure) --------------------
{
  // Faithful reconstruction joins same-line words and reflows wrapped lines into
  // reading-order prose — the old flat fold split every visual line at its wrap.
  const txt = B.ocrToText([
    ocrWord(0, 10, 20, 12, 'The'), ocrWord(25, 10, 30, 12, 'quick'),
    ocrWord(0, 40, 25, 12, 'brown'), ocrWord(30, 40, 20, 12, 'fox'),
  ]);
  ok('ocrToText joins words on a line with spaces', /The quick/.test(txt));
  ok('ocrToText reflows wrapped lines into reading order', /quick brown/.test(txt), JSON.stringify(txt));
}
ok('ocrToText uses a page-level event verbatim',
  B.ocrToText([{ region: { kind: 'bbox', x: 0, y: 0, w: 0, h: 0 }, confidence: 0.8, payload: { text: 'Whole page text.' }, meta: { level: 'page' }, adapter: { id: 'ocr-tesseract', version: '1.0.0' } }]) === 'Whole page text.');
ok('ocrToText is empty with no words', B.ocrToText([failEvent('x')]) === '');

// ---- pdfToText (now reconstructs via EOImportStructure) --------------------
{
  // A born-digital page: a larger-font heading, a body line, then a second page.
  // Reconstruction tags the heading, reflows body, and breaks pages with a
  // blank line (geometry-faithful, not the old single-y-gap flat fold).
  const pr = (page, x, y, text, fs) => ({ id: 'e', adapter: { id: 'pdf-text-pdfjs', version: '1.0.0' },
    region: { kind: 'bbox', x, y, w: Math.max(1, text.length * (fs || 10) * 0.5), h: fs || 10 },
    confidence: 1, payload: { text, fontSize: fs || 10, fontName: 'F' }, meta: { page } });
  const txt = B.pdfToText([pr(1, 72, 700, 'A Heading', 16), pr(1, 72, 672, 'First line of body.', 11), pr(2, 72, 700, 'Second page.', 11)]);
  ok('pdfToText breaks pages with a blank line', /\n\nSecond page\./.test(txt), JSON.stringify(txt));
  ok('pdfToText keeps a larger-font heading distinct from the body', /A Heading\n\nFirst line of body\./.test(txt), JSON.stringify(txt));
  // same-baseline runs at increasing x join with a space (kerning gaps do not)
  ok('pdfToText joins same-line runs with a space',
    /Hello world/.test(B.pdfToText([pr(1, 72, 700, 'Hello', 11), pr(1, 110, 700, 'world', 11)])));
}
// the reconstruction rides onto the fold's structure + provenance digest
{
  const r = B.eventsToText('pdf-text', [
    { id: 'e', region: { kind: 'bbox', x: 72, y: 700, w: 40, h: 11 }, confidence: 1, payload: { text: 'Body', fontSize: 11, fontName: 'F' }, meta: { page: 1 }, adapter: { id: 'pdf-text-pdfjs', version: '1.0.0' } },
  ]);
  ok('eventsToText(pdf-text) returns reconstructed structure', r.structure && Array.isArray(r.structure.blocks));
  ok('eventsToText(pdf-text) rides a compact structure digest on provenance', r.provenance.structure && r.provenance.structure.reconstructed === true);
}

// ---- eventsToText dispatch + provenance ------------------------------------
{
  const r = B.eventsToText('asr', [asrEvent(0, 1.2, 'hi'), asrEvent(1.2, 2, 'there'), failEvent('soft')]);
  ok('eventsToText(asr) returns VTT text', /^WEBVTT/.test(r.text));
  ok('provenance names the adapter', r.provenance.adapter === 'asr-whisper-base');
  ok('provenance records the capability', r.provenance.via === 'asr');
  ok('provenance averages confidence over real events', r.provenance.confidenceMean === 0.9, String(r.provenance.confidenceMean));
  ok('provenance counts only real events', r.provenance.events === 2);
  ok('provenance captures device/precision', r.provenance.device === 'wasm' && r.provenance.dtype === 'q8');
  ok('provenance carries the soft failure', r.provenance.failures.length === 1 && r.provenance.failures[0] === 'soft');
}
ok('eventsToText(pdf-text) dispatches to pdfToText', /Body/.test(B.eventsToText('pdf-text', [pdfRun(1, 700, 'Body')]).text));
ok('eventsToText(ocr) dispatches to ocrToText', /Word/.test(B.eventsToText('ocr', [ocrWord(0, 0, 10, 10, 'Word')]).text));

// ---- allFailed / firstError ------------------------------------------------
ok('allFailed true when every event is a failure', B.allFailed([failEvent('a'), failEvent('b')]) === true);
ok('allFailed false with a mixed batch', B.allFailed([asrEvent(0, 1, 'ok'), failEvent('b')]) === false);
ok('allFailed false on an empty batch', B.allFailed([]) === false);
ok('firstError returns the first failure message', B.firstError([asrEvent(0, 1, 'ok'), failEvent('the reason')]) === 'the reason');
ok('firstError null when nothing failed', B.firstError([asrEvent(0, 1, 'ok')]) === null);

// ---- ACCEPT ----------------------------------------------------------------
ok('ACCEPT advertises audio, images, and PDF', /audio\/\*/.test(B.ACCEPT) && /image\/\*/.test(B.ACCEPT) && /application\/pdf/.test(B.ACCEPT));
ok('ACCEPT keeps the text formats', /\.txt/.test(B.ACCEPT) && /\.csv/.test(B.ACCEPT));

console.log(failed
  ? ('\n✗ FAIL — ' + passed + ' passed, ' + failed + ' failed')
  : ('\n✓ PASS — ' + passed + ' ingest-bridge checks passed, 0 failed'));
process.exit(failed ? 1 : 0);
