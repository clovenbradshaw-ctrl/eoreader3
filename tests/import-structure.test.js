/* ============================================================
   import-structure — faithful import (window.EOImportStructure).

   Layer A of the Faithful Given-Log Import spec, plus the layout/content
   firewall. Pure unit tests: plain positioned-event objects in (PDF text runs,
   OCR words, doc-layout regions), reconstructed structure out. No DOM, no
   adapters, no engine — exercised in Node exactly like ingest-adapters.test.js.

   What these pin:
     • words rejoin (kerning), wrapped lines reflow, hyphens heal;
     • the caption `)` column is isolated and dropped, never `) ) ) ) )`;
     • furniture (running headers, page numbers) is held out of `body`;
     • OCR carries per-word confidence; the low tail is marked, never dropped,
       and never written into `body` as confident text;
     • the subject-type firewall: layout facts are region-subject events,
       content facts are referent/run spans — they never share a slot;
     • the cartography (describePosition / describeRelation) yields closed
       tokens + artifact-register phrases under a salience gate;
     • reconstruction is pure / deterministic.

   Run with `node tests/import-structure.test.js`.
   ============================================================ */
'use strict';
const IS = require('../import-structure.js');

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ FAIL — ' + name + (extra ? '\n      ' + extra : '')); }
};

// ---- event builders -------------------------------------------------------
// A PDF text run: born-digital, y-UP (origin bottom-left), confidence ≈ 1.
const run = (page, x, y, text, fontSize, fontName) => ({
  id: 'e', adapter: { id: 'pdf-text-pdfjs', version: '1.0.0' },
  region: { kind: 'bbox', x, y, w: Math.max(1, String(text).length * (fontSize || 10) * 0.5), h: fontSize || 10 },
  confidence: 1, payload: { text, fontSize: fontSize || 10, fontName: fontName || 'F' }, meta: { page },
});
// An OCR word: pixel space, y-DOWN (origin top-left), heuristic confidence.
const word = (x, y, text, conf) => ({
  id: 'e', adapter: { id: 'ocr-tesseract', version: '1.0.0' },
  region: { kind: 'bbox', x, y, w: Math.max(6, String(text).length * 9), h: 14 },
  confidence: conf == null ? 0.95 : conf, payload: { text }, meta: { level: 'word' },
});
// A doc-layout region (docling-lite / YOLO-DocLayNet shape).
const region = (id, x, y, w, h, kind, conf) => ({
  id, adapter: { id: 'doc-layout-docling-lite', version: '1.0.0' },
  region: { kind: 'bbox', x, y, w, h }, confidence: conf == null ? 0.9 : conf, payload: { kind }, meta: { page: 1 },
});
const failEvent = () => ({ payload: { error: 'boom' }, meta: { kind: 'failure' } });

// ---- 1. words: kerning + de-hyphenation -----------------------------------
{
  const r = IS.reconstruct([
    run(1, 90, 610, 'P', 11), run(1, 96, 610, 'laintiff', 11),                 // kerning fragments
    run(1, 150, 610, 'is a corporation duly orga-', 11),                       // hyphen wrap …
    run(1, 72, 596, 'nized under the laws of the state.', 11),                 // … continuation
  ], 'pdf');
  ok('kerning fragments rejoin ("P laintiff" → "Plaintiff")', /Plaintiff/.test(r.body) && !/P laintiff/.test(r.body), JSON.stringify(r.body));
  ok('a hyphen wrap heals ("orga-\\nnized" → "organized")', /organized/.test(r.body) && !/orga-/.test(r.body), JSON.stringify(r.body));
  ok('the wrapped line reflows into one span (no mid-sentence break)', /duly organized under the laws/.test(r.body));
}

// ---- 2. lines / reflow / page break / heading -----------------------------
{
  const r = IS.reconstruct([
    run(1, 100, 760, 'A Bold Title', 16, 'Helvetica-Bold'),
    run(1, 72, 720, 'This is the first line of a paragraph that wraps', 11),
    run(1, 72, 706, 'onto a second line and should reflow as one span.', 11),
    run(2, 72, 760, 'Second page body begins here.', 11),
  ], 'pdf');
  ok('a bold, short line is tagged heading', r.blocks.some(b => b.role === 'heading' && /Bold Title/.test(b.text)));
  ok('wrapped body lines reflow into one paragraph', /that wraps onto a second line and should reflow as one span\./.test(r.body));
  ok('a page change is a paragraph break', /\n\nSecond page body begins here\./.test(r.body), JSON.stringify(r.body));
  ok('lines never merge across pages by a shared y (paragraph break holds)', /as one span\.\n\nSecond page body/.test(r.body), JSON.stringify(r.body));
}

// ---- 3. caption: the `)` column is isolated and dropped --------------------
{
  const ev = [
    run(1, 90, 740, 'Travelers Casualty Insurance Co.', 11), run(1, 300, 740, ')', 11),
    run(1, 300, 726, ')', 11),
    run(1, 120, 712, 'v.', 11), run(1, 300, 712, ')', 11),
    run(1, 300, 698, ')', 11),
    run(1, 90, 684, 'Block by Block, Inc.', 11), run(1, 300, 684, ')', 11),
    run(1, 250, 640, 'COMPLAINT', 14, 'Times-Bold'),
    run(1, 72, 600, 'The body of the complaint follows with enough words to be a paragraph.', 11),
  ];
  const r = IS.reconstruct(ev, 'pdf');
  ok('the fold never opens with a `)` column', !/\)\s*\)/.test(r.body), JSON.stringify(r.body.slice(0, 60)));
  ok('the `)` delimiter column is dropped', r.stats.droppedDelimiters >= 4 && r.columns.length >= 1);
  ok('party names survive un-beheaded ("Block by Block")', /Block by Block/.test(r.body));
  ok('the head-region "v." is flagged as a relational candidate', r.relationalCandidates.some(c => /^v\.?$/.test(c.token)));
  ok('the relational candidate sits between two proper-noun runs',
    r.relationalCandidates.some(c => /Travelers/.test(c.above) && /Block/.test(c.below)));
}

// ---- 4. furniture: cross-page repetition + margin band --------------------
{
  const ev = [
    run(1, 72, 780, 'EFILED 06/04/2026 CASE NO. 24-1234', 8),                  // running header p1 …
    run(2, 72, 780, 'EFILED 06/04/2026 CASE NO. 24-1234', 8),                  // … and p2 (repeat)
    run(1, 72, 400, 'Body paragraph one has several words to anchor the page.', 11),
    run(2, 72, 400, 'Body paragraph two also has several words on this page.', 11),
    run(2, 290, 60, 'Page 2 of 2', 9),                                         // footer page number
  ];
  const r = IS.reconstruct(ev, 'pdf');
  ok('a running header repeated across pages is furniture', r.furniture.some(f => /EFILED/.test(f.text)));
  ok('furniture is held out of body (never spliced into prose)', !/EFILED/.test(r.body));
  ok('the repeated header records the pages it appeared on', r.furniture.some(f => /EFILED/.test(f.text) && f.pages.length === 2));
  ok('a page-number footer is furniture, out of body', r.furniture.some(f => /Page 2 of 2/.test(f.text)) && !/Page 2 of 2/.test(r.body));
  ok('body keeps the real paragraphs', /Body paragraph one/.test(r.body) && /Body paragraph two/.test(r.body));
  ok('every furniture group emits a region-subject NUL', r.seedEvents.filter(s => s.op === 'NUL' && s.reason === 'furniture').every(s => s.subjectType === 'region'));
}

// a one-line document is NOT eaten as margin furniture
ok('a single short line is not mistaken for furniture',
  /Hello/.test(IS.reconstruct([run(1, 72, 400, 'Hello', 12)], 'pdf').body));

// ---- 5. OCR: confidence tail marked, furniture out, body talker-safe ------
{
  const ev = [
    word(40, 8, 'Vallee', 0.95), word(110, 8, 'page', 0.95), word(150, 8, '3', 0.95),  // top header
    word(20, 30, 'ERIC', 0.9),                                                          // logo token
    word(60, 200, 'The', 0.96), word(95, 200, 'system', 0.95), word(170, 200, 'reads', 0.95), word(250, 200, 'DIERAC', 0.18),
    word(60, 220, 'the', 0.96), word(95, 220, 'input', 0.95), word(175, 220, 'languaces', 0.21),
    word(60, 240, 'and', 0.97), word(100, 240, 'returns', 0.95), word(190, 240, 'output', 0.96),
    word(300, 760, '6', 0.9),                                                           // footer page number
  ];
  const r = IS.reconstruct(ev, 'ocr');
  ok('OCR reads top-to-bottom (y-down): "The system reads"', /The system reads/.test(r.body));
  ok('the low-confidence tail is marked uncertain', r.uncertain.map(u => u.text).sort().join(',') === 'DIERAC,languaces');
  ok('uncertain runs stay in body as PLAIN text (coverage honest)', /DIERAC/.test(r.body) && /languaces/.test(r.body));
  ok('body carries NO void markup (the talker is never handed `{{…}}`)', !/\{\{/.test(r.body));
  ok('an uncertain run never seeds a confident op (it is a run-subject NUL)',
    r.seedEvents.some(s => s.reason === 'uncertain' && s.subjectType === 'run' && s.op === 'NUL'));
  ok('OCR margin tokens (header / logo / page #) are furniture, out of body',
    !/Vallee|ERIC/.test(r.body) && !/\b6\b/.test(r.body) && r.furniture.length >= 2);
}
// a uniformly-confident scan flags nothing (relative tail, not a hard threshold)
{
  const clean = [
    word(60, 200, 'Annual', 0.97), word(120, 200, 'report', 0.96), word(60, 220, 'for', 0.95),
    word(95, 220, 'the', 0.96), word(130, 220, 'fiscal', 0.95), word(190, 220, 'year', 0.97),
    word(60, 240, 'ending', 0.94), word(120, 240, 'in', 0.96), word(150, 240, 'spring', 0.95),
  ];
  ok('a uniformly-confident scan marks nothing uncertain', IS.reconstruct(clean, 'ocr').uncertain.length === 0);
}
// a whole-page OCR event (no per-word boxes) is used verbatim
ok('an OCR page-level event is used verbatim',
  IS.reconstruct([{ region: { x: 0, y: 0, w: 0, h: 0 }, confidence: 0.8, payload: { text: 'Whole page text.' }, meta: { level: 'page' } }], 'ocr').body === 'Whole page text.');

// ---- 6. the layout/content firewall + role override -----------------------
{
  const ev = [
    run(1, 72, 770, 'CONFIDENTIAL — DRAFT HEADER', 9),
    run(1, 240, 740, 'ANNUAL REPORT', 16, 'Bold'),
    run(1, 72, 700, 'This is the body of the document with plenty of words here.', 11),
  ];
  const layout = [
    region('hdr', 70, 765, 320, 14, 'page-header', 0.9),
    region('ttl', 235, 735, 140, 22, 'title', 0.95),
    region('bdy', 70, 695, 340, 14, 'text', 0.88),
  ];
  const r = IS.reconstruct(ev, 'pdf', { layout });
  ok('a doc-layout page-header region overrides geometry → furniture', r.regions.some(x => x.id === 'hdr' && x.furniture));
  ok('the header is held out of body once layout marks it furniture', !/CONFIDENTIAL/.test(r.body));
  ok('every layout event is region-subject (the firewall)',
    r.seedEvents.filter(s => /^(layout|layout-cartography)$/.test(s.basis)).every(s => s.subjectType === 'region'));
  ok('a role DEF is on the region, not a referent', r.seedEvents.some(s => s.op === 'DEF' && s.path === 'role' && s.subject === 'hdr' && s.subjectType === 'region'));
  ok('a furniture region emits a region-subject NUL', r.seedEvents.some(s => s.op === 'NUL' && s.subject === 'hdr' && s.subjectType === 'region'));
  ok('the body region earns NO position (salience gate)',
    !r.seedEvents.some(s => s.path === 'position' && s.subject === 'bdy'));
  ok('a non-body region earns a position DEF', r.seedEvents.some(s => s.path === 'position' && s.subject === 'hdr'));
  ok('layout notes are pre-rendered artifact-register phrases (no tokens/coords)',
    r.layoutNotes.length >= 1 && r.layoutNotes.every(n => typeof n.phrase === 'string' && !/\{|\[|\d{2,}/.test(n.phrase)));
  ok('a layout note carries its detector source + confidence (for the gated talker flip)',
    r.layoutNotes.some(n => n.source === 'adapter' && typeof n.confidence === 'number'));
}

// ---- 7. cartography units --------------------------------------------------
{
  const frame = { x: 0, y: 0, w: 100, h: 100 };
  // y-down (OCR pixel space)
  ok('describePosition: a wide top band → zone "top"', IS.describePosition({ x: 5, y: 2, w: 90, h: 6 }, frame, 'down', 0).zone === 'top');
  ok('describePosition: bottom-right corner → "bottom-right"', IS.describePosition({ x: 80, y: 88, w: 15, h: 8 }, frame, 'down', 0).zone === 'bottom-right');
  ok('describePosition: dead center → "center"', IS.describePosition({ x: 42, y: 45, w: 16, h: 10 }, frame, 'down', 0).zone === 'center');
  // y-up (PDF space): a box near the TOP of the page has high y → reads as "top"
  ok('describePosition respects a y-up axis (high y = top)', IS.describePosition({ x: 5, y: 92, w: 90, h: 6 }, frame, 'up', 0).zone === 'top');
  // orientation: a 180° rotation maps top-left to bottom-right
  ok('describePosition remaps a 180° rotation', IS.describePosition({ x: 2, y: 2, w: 10, h: 6 }, frame, 'down', 180).zone === 'bottom-right');
  ok('a position phrase is artifact-register', /^a header runs across the top$/.test(IS.positionPhrase('top', 'header', true, false)));

  // describeRelation: a caption below a figure (y-down: larger y = lower)
  const cap = { role: 'caption', box: { x: 10, y: 60, w: 50, h: 10 } };
  const fig = { role: 'figure', box: { x: 10, y: 10, w: 50, h: 40 } };
  ok('describeRelation: caption below figure (y-down)', IS.describeRelation(cap, fig, 'down').token === 'below');
  ok('describeRelation: figure above caption (y-down)', IS.describeRelation(fig, cap, 'down').token === 'above');
  const outer = { role: 'table', box: { x: 0, y: 0, w: 100, h: 100 } };
  const inner = { role: 'caption', box: { x: 20, y: 20, w: 20, h: 10 } };
  ok('describeRelation: containment', IS.describeRelation(outer, inner, 'down').token === 'contains');
  ok('describeRelation: left-of when no x-overlap', IS.describeRelation({ role: 'figure', box: { x: 0, y: 0, w: 20, h: 20 } }, { role: 'caption', box: { x: 60, y: 0, w: 20, h: 20 } }, 'down').token === 'left-of');
}

// a caption-below-figure relation lands as a region-subject CON
{
  const ev = [run(1, 72, 700, 'Body text with several words to anchor reading order.', 11)];
  const layout = [
    region('fig1', 100, 400, 200, 120, 'figure', 0.9),
    region('cap1', 100, 360, 200, 16, 'caption', 0.85),
  ];
  const r = IS.reconstruct(ev, 'pdf', { layout });
  ok('a caption/figure adjacency emits a region-subject CON', r.seedEvents.some(s => s.op === 'CON' && s.subjectType === 'region' && s.rel && s.object));
  ok('the CON carries a pre-rendered relation phrase', r.layoutRelations.some(rel => /caption|figure/.test(rel.phrase)));
}

// ---- 8. shape contract + determinism + edges ------------------------------
{
  const r = IS.reconstruct([run(1, 72, 700, 'Hello world this is a sentence.', 11)], 'pdf');
  ok('the return carries the spec shape {body, blocks, furniture, seedEvents}',
    typeof r.body === 'string' && Array.isArray(r.blocks) && Array.isArray(r.furniture) && Array.isArray(r.seedEvents));
  ok('blocks carry geometry attributes {role, region, page, fontSize, align}',
    r.blocks.every(b => b.role && b.region && b.page != null && typeof b.fontSize === 'number' && b.align));
}
{
  const ev = [run(1, 72, 720, 'Determinism check line one wraps here', 11), run(1, 72, 706, 'into line two for the reflow.', 11)];
  ok('reconstruction is deterministic (pure)', IS.reconstruct(ev, 'pdf').body === IS.reconstruct(ev, 'pdf').body);
}
ok('no events → empty structure', IS.reconstruct([], 'pdf').body === '' && IS.reconstruct([], 'pdf').blocks.length === 0);
ok('all-failure events → empty', IS.reconstruct([failEvent(), failEvent()], 'pdf').body === '');
ok('PDF modality flags nothing uncertain (born-digital, confidence ≈ 1)',
  IS.reconstruct([run(1, 72, 700, 'Born digital text needs no confidence tail.', 11)], 'pdf').uncertain.length === 0);

console.log(failed
  ? ('\n✗ FAIL — ' + passed + ' passed, ' + failed + ' failed')
  : ('\n✓ PASS — ' + passed + ' faithful-import checks passed, 0 failed'));
process.exit(failed ? 1 : 0);
