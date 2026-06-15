/* ============================================================
   Cleo — faithful import (window.EOImportStructure).

   Layer A of the Faithful Given-Log Import spec. A positioned-event adapter
   (pdf.js text runs, Tesseract/TrOCR words) hands us one event per run, each
   carrying region {x,y,w,h}, payload {text, fontSize?, fontName?}, meta {page?,
   level?} and a confidence. The defect this module repairs is that the old fold
   (`pdfToText` / `ocrToText`) projected that page to a flat character string
   using a single y-gap signal, throwing away x (columns, indentation), font
   (heading vs body, weight) and the page-relative position that marks furniture.
   The downstream operators then ran on a residue.

   reconstruct(events, modality) rebuilds, from run geometry alone and
   genre-blind:

       reconstruct(events, modality) -> {
         body,        // reading-order prose: furniture removed, wraps reflowed,
                      //   delimiter columns dropped — what becomes sentenceTexts
         blocks,      // [{ id, role, text, region, page, fontSize, fontName, align }]
         furniture,   // [{ text, region, pages:[...] }]  held, never deleted
         seedEvents,  // pre-operator events to fold into the Given-Log (NUL …)
         uncertain,   // OCR: low-confidence runs, marked, never dropped
         ...stats
       }

   The same words / lines / columns / reading-order / furniture primitives run
   for every modality; `modality` only sets the event source's quirks — the PDF
   coordinate space is y-up (origin bottom-left), OCR pixel space is y-down, and
   OCR carries a load-bearing per-word confidence that PDF does not (born-digital
   text is confidence ≈ 1). The transcript (VTT) fold is NOT in this defect class
   and is left untouched by the bridge.

   Pure and dependency-free (no DOM, no adapter calls, no engine import) so it is
   exercised in Node with plain event objects, like ingest-adapters.js.

   Published as window.EOImportStructure; also module.exports under Node.
   ============================================================ */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window
    : (typeof self !== 'undefined') ? self
    : (typeof globalThis !== 'undefined') ? globalThis : {};

  // ---- small numeric / string helpers --------------------------------------
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
  const collapseWS = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  // The furniture key: collapse whitespace, lowercase, and fold every digit run
  // to '#', so "Page 1 of 15" and "Page 2 of 15" share one normalized form.
  const normForm = (s) => collapseWS(s).toLowerCase().replace(/\d+/g, '#');
  function median(arr) {
    const a = arr.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  const mode = (arr) => {
    const c = new Map(); let best = null, bestN = 0;
    for (const v of arr) { const n = (c.get(v) || 0) + 1; c.set(v, n); if (n > bestN) { bestN = n; best = v; } }
    return best;
  };

  // ---- the void-marker FORMAT (mirrors engine.js formatVoidMarker /
  // formatAbsentMarker so this module stays dependency-free). The engine maps
  // these typed markers when the structure channel folds seedEvents; we only
  // build the string, never the engine's behavior. -------------------------
  function formatVoidMarker(kind, term) {
    return (kind && kind !== 'unspecified') ? `{{void:${kind}:${term}}}` : `{{void:${term}}}`;
  }
  function formatAbsentMarker(kind, doc, receipt) {
    const body = doc ? `${doc}:${receipt}` : String(receipt == null ? '' : receipt);
    return (kind && kind !== 'unspecified') ? `{{absent:${kind}:${body}}}` : `{{absent:${body}}}`;
  }

  // Lone caption/box delimiters — the right-margin `)` column of a legal caption,
  // table rules, etc. A token that is ONLY these characters carries no prose.
  const DELIM_RE = /^[)(\]\[|}{·•]+$/;
  // A list marker that opens a line: a bullet, or a short "a." / "1)" / "(iv)".
  const LIST_RE = /^(?:[•▪◦‣·*]|[-–—](?=\s)|\(?[A-Za-z0-9]{1,3}[.)])\s+/;
  const BOLD_RE = /bold|black|heavy|semibold|demi/i;
  // Low-frequency relational tokens that sit alone between two proper-noun runs
  // (the "v." candidate). Layer A only MARKS these; Layer B learns which one, in
  // which region, means what — so this list is a candidate sieve, not a grammar.
  const RELATIONAL_RE = /^(?:v\.?|vs\.?|versus|&|and|in\s+re:?)$/i;
  // A page-number / running-footer shape (after digit-folding): "#", "page #",
  // "page # of #", "- # -". Used to recognize furniture in a margin band.
  const PAGENUM_RE = /^(?:[-–—]?\s*#\s*(?:of\s*#)?\s*[-–—]?|page\s*#(?:\s*of\s*#)?|p\.?\s*#)$/i;

  const isFailure = (e) => !!(e && e.meta && e.meta.kind === 'failure');
  const evText = (e) => (e && e.payload && typeof e.payload.text === 'string') ? e.payload.text : '';

  // One adapter event → one internal run with a filled-in geometry.
  function toRun(e, i) {
    const r = e.region || {};
    const x = num(r.x) || 0, y = num(r.y) || 0;
    let w = num(r.w), h = num(r.h);
    const fontSize = num(e.payload && e.payload.fontSize) || (h && h > 0 ? h : null) || 10;
    const text = evText(e);
    if (w == null || w <= 0) w = Math.max(0, text.length * fontSize * 0.5);   // estimate when absent
    if (h == null || h <= 0) h = fontSize;
    const page = (e.meta && e.meta.page != null) ? e.meta.page : 1;
    const conf = (typeof e.confidence === 'number' && isFinite(e.confidence)) ? e.confidence : null;
    return { i, text, x, y, w, h, fontSize, fontName: String((e.payload && e.payload.fontName) || ''), page, conf };
  }

  // ---- step 1+2: runs → lines (baseline grouping + word join) ---------------
  // `top` increases DOWN the page for both axes, so reading order is always
  // ascending `top`. PDF is y-up (origin bottom-left), OCR pixel space is y-down.
  const topOf = (run, yAxis) => (yAxis === 'up' ? -run.y : run.y);

  // Join the x-sorted runs of one line into text, repairing kerning
  // fragmentation: a sub-space horizontal gap concatenates ("P"+"laintiff" →
  // "Plaintiff"); an inter-word gap inserts a single space. Returns the line
  // text plus the per-token spans (text + x extent) for column / relational
  // detection downstream.
  function joinLine(runs, fontSize) {
    const tokens = [];
    let acc = '';
    let prevRight = null;
    const spaceGap = Math.max(1, fontSize * 0.22);   // < this and unspaced ⇒ kerning, not a word break
    for (const r of runs) {
      const t = r.text;
      if (!t) continue;
      if (acc) {
        const gap = (prevRight != null) ? (r.x - prevRight) : 0;
        const bounded = /\s$/.test(acc) || /^\s/.test(t);
        if (!bounded && gap > spaceGap) acc += ' ';
        // else: kerning fragment or already whitespace-bounded — concatenate.
      }
      const startLen = acc.length;
      acc += t;
      tokens.push({ text: t, x: r.x, right: r.x + r.w, at: startLen, conf: r.conf, run: r });
      prevRight = r.x + r.w;
    }
    return { text: acc.replace(/[ \t]+/g, ' ').trim(), tokens };
  }

  function buildLines(runs, yAxis) {
    const sorted = runs.slice().sort((a, b) => {
      const ta = topOf(a, yAxis), tb = topOf(b, yAxis);
      return ta !== tb ? ta - tb : a.x - b.x;
    });
    const medH = median(runs.map(r => r.h)) || median(runs.map(r => r.fontSize)) || 10;
    const tol = medH * 0.6;
    const lines = [];
    let cur = null;
    for (const r of sorted) {
      const t = topOf(r, yAxis);
      if (cur && Math.abs(t - cur.top) <= tol) {
        cur.runs.push(r); cur.top = (cur.top * (cur.runs.length - 1) + t) / cur.runs.length;
      } else {
        if (cur) lines.push(cur);
        cur = { runs: [r], top: t };
      }
    }
    if (cur) lines.push(cur);
    // finalize each line: x-sort, join, geometry
    return lines.map((ln) => {
      ln.runs.sort((a, b) => a.x - b.x);
      const fontSize = median(ln.runs.map(r => r.fontSize)) || 10;
      const j = joinLine(ln.runs, fontSize);
      const x0 = Math.min(...ln.runs.map(r => r.x));
      const x1 = Math.max(...ln.runs.map(r => r.x + r.w));
      const y0 = Math.min(...ln.runs.map(r => r.y));
      const y1 = Math.max(...ln.runs.map(r => r.y + r.h));
      const confs = ln.runs.map(r => r.conf).filter(c => c != null);
      return {
        text: j.text, tokens: j.tokens, runs: ln.runs,
        top: ln.top, x0, x1, y0, y1, fontSize,
        fontName: mode(ln.runs.map(r => r.fontName)) || '',
        page: ln.runs[0].page,
        conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
        minConf: confs.length ? Math.min(...confs) : null,
        words: j.text ? j.text.split(/\s+/).filter(Boolean).length : 0,
        role: null, furniture: false,
      };
    }).filter(ln => ln.text || ln.tokens.length);
  }

  // ---- step 3 (caption box): drop a vertical column of lone delimiters -------
  // The right-margin `)` column of a legal caption is a stack of lone-delimiter
  // tokens sharing an x. Cluster them; a cluster on ≥3 lines is a delimiter
  // column — strip those tokens so the fold never opens with `) ) ) ) )`.
  function stripDelimiterColumns(lines, fontSize) {
    const cands = [];   // { lineIdx, tokIdx, x }
    lines.forEach((ln, li) => {
      ln.tokens.forEach((tk, ti) => {
        const s = collapseWS(tk.text);
        if (s && DELIM_RE.test(s) && s.length <= 3) cands.push({ li, ti, x: (tk.x + tk.right) / 2 });
      });
    });
    if (cands.length < 3) return { columns: [], removed: 0 };
    const tol = Math.max(6, fontSize * 1.5);
    const used = new Array(cands.length).fill(false);
    const columns = [];
    let removed = 0;
    for (let i = 0; i < cands.length; i++) {
      if (used[i]) continue;
      const group = [i];
      for (let j = i + 1; j < cands.length; j++) {
        if (!used[j] && Math.abs(cands[j].x - cands[i].x) <= tol) { group.push(j); used[j] = true; }
      }
      used[i] = true;
      const distinctLines = new Set(group.map(k => cands[k].li));
      if (distinctLines.size < 3) continue;   // not a column, just stray punctuation
      // strip the tokens (mark; rebuild text after)
      for (const k of group) lines[cands[k].li].tokens[cands[k].ti]._strip = true;
      removed += group.length;
      const xs = group.map(k => cands[k].x);
      columns.push({ x: median(xs), lines: distinctLines.size, page: lines[cands[group[0]].li].page });
    }
    if (removed) {
      for (const ln of lines) {
        if (!ln.tokens.some(t => t._strip)) continue;
        const kept = ln.tokens.filter(t => !t._strip);
        ln.tokens = kept;
        ln.text = collapseWS(kept.map(t => t.text).join(' '));
        ln.words = ln.text ? ln.text.split(/\s+/).filter(Boolean).length : 0;
        if (kept.length) { ln.x0 = Math.min(...kept.map(t => t.x)); ln.x1 = Math.max(...kept.map(t => t.right)); }
      }
    }
    return { columns, removed };
  }

  // ---- step 5: furniture (cross-page repetition + margin band) --------------
  // Per-page relative position: 0 = page top, 1 = page bottom.
  function pageRelative(lines) {
    const byPage = new Map();
    for (const ln of lines) { (byPage.get(ln.page) || byPage.set(ln.page, []).get(ln.page)).push(ln); }
    for (const [, arr] of byPage) {
      const tops = arr.map(l => l.top);
      const lo = Math.min(...tops), hi = Math.max(...tops), span = (hi - lo) || 1;
      const xs0 = arr.map(l => l.x0), x1s = arr.map(l => l.x1);
      const xlo = Math.min(...xs0), xhi = Math.max(...x1s), xspan = (xhi - xlo) || 1;
      for (const l of arr) {
        l.relY = (l.top - lo) / span;     // 0 = page top, 1 = page bottom (reading space)
        l.relX = (l.x0 - xlo) / xspan;
      }
    }
    return byPage;
  }

  function detectFurniture(lines, byPage, bodyFont) {
    const nPages = byPage.size;
    const furnitureLines = new Set();

    // (a) cross-page repetition: same normalized form at a near-identical
    // vertical band on ≥ half the pages.
    if (nPages >= 2) {
      const groups = new Map();   // key -> { lines:[], pages:Set }
      for (const ln of lines) {
        const nf = normForm(ln.text);
        if (!nf) continue;
        const band = Math.round(ln.relY / 0.04);   // ~4% vertical buckets
        const key = nf + '@' + band;
        let g = groups.get(key);
        if (!g) groups.set(key, g = { lines: [], pages: new Set(), nf });
        g.lines.push(ln); g.pages.add(ln.page);
      }
      const need = Math.max(2, Math.ceil(nPages / 2));
      for (const [, g] of groups) {
        if (g.pages.size >= need) for (const ln of g.lines) { ln.furniture = true; ln._furnReason = 'repeat'; furnitureLines.add(ln); }
      }
    }

    // (b) margin band (works on a single page too): a SHORT line in the extreme
    // top/bottom band that is a page-number shape, a lone delimiter, a tiny
    // detached fragment, or already a repeat — and is not heading-sized body.
    for (const [, arr] of byPage) {
      const bodyTops = arr.filter(l => !l.furniture && l.words >= 4).map(l => l.top);
      const bodyLo = bodyTops.length ? Math.min(...bodyTops) : null;
      const bodyHi = bodyTops.length ? Math.max(...bodyTops) : null;
      const gaps = [];
      const sorted = arr.slice().sort((a, b) => a.top - b.top);
      for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].top - sorted[i - 1].top);
      const lineGap = median(gaps) || (bodyFont * 1.2) || 12;
      for (const ln of arr) {
        if (ln.furniture) continue;
        const inTop = ln.relY <= 0.09, inBot = ln.relY >= 0.91;
        if (!inTop && !inBot) continue;
        const nf = normForm(ln.text);
        const isDelim = DELIM_RE.test(collapseWS(ln.text));     // a lone box/table rule
        const pagey = PAGENUM_RE.test(nf);                      // "page # of #", "- # -"
        const detached = bodyLo != null && (
          (inTop && bodyLo - ln.top > lineGap * 1.6) || (inBot && ln.top - bodyHi > lineGap * 1.6));
        const small = ln.words <= 4 && ln.fontSize <= bodyFont * 1.15;
        const sentence = /[.!?]["')\]]?$/.test(ln.text) && ln.words > 4;   // protect real sentences
        // Page-number shape or a lone delimiter is furniture on its shape alone;
        // a small detached fragment is furniture only when there IS a body block
        // for it to sit in the margin of (so a one-line document isn't eaten).
        if (!sentence && (pagey || isDelim || (detached && small))) {
          ln.furniture = true; ln._furnReason = 'margin'; furnitureLines.add(ln);
        }
      }
    }
    return furnitureLines;
  }

  // ---- step 4: roles --------------------------------------------------------
  function assignRoles(lines, byPage, bodyFont) {
    const firstPage = Math.min(...[...byPage.keys()]);
    // The head-region is everything on the first page above the first heading or
    // the first multi-line body paragraph — a geometric guess, refined by Layer B.
    const fp = (byPage.get(firstPage) || []).filter(l => !l.furniture).sort((a, b) => a.top - b.top);
    let firstBodyTop = Infinity;
    for (let i = 0; i < fp.length; i++) {
      const ln = fp[i];
      const big = ln.fontSize >= bodyFont * 1.18 || BOLD_RE.test(ln.fontName);
      const para = ln.words >= 6 && i + 1 < fp.length && Math.abs(fp[i + 1].top - ln.top) < (bodyFont * 2);
      if (big || para) { firstBodyTop = ln.top; break; }
    }
    // No first-body block found ⇒ there is no caption above it. Disable the
    // head-region so a body-only page is not swallowed as "above the body".
    if (firstBodyTop === Infinity) firstBodyTop = -Infinity;
    for (const ln of lines) {
      if (ln.furniture) { ln.role = 'furniture'; continue; }
      const big = (ln.fontSize >= bodyFont * 1.18) || BOLD_RE.test(ln.fontName);
      const shortLine = ln.words > 0 && ln.words <= 12;
      if (ln.page === firstPage && ln.top < firstBodyTop) { ln.role = 'head-region'; continue; }
      if (big && shortLine && !/[.!?]$/.test(ln.text)) { ln.role = 'heading'; continue; }
      if (LIST_RE.test(ln.text)) { ln.role = 'list-item'; continue; }
      ln.role = 'body';
    }
  }

  // ---- step 6: relational-token candidates (marked, NOT interpreted) --------
  function markRelational(lines) {
    const out = [];
    const head = lines.filter(l => l.role === 'head-region');
    head.forEach((ln, k) => {
      const t = collapseWS(ln.text);
      if (!t || !RELATIONAL_RE.test(t)) return;
      const above = head.slice(0, k).reverse().find(l => /\p{Lu}/u.test(l.text));
      const below = head.slice(k + 1).find(l => /\p{Lu}/u.test(l.text));
      if (above && below) {
        ln.relational = true;
        out.push({ token: t, page: ln.page, region: lineRegion(ln), above: above.text, below: below.text });
      }
    });
    return out;
  }

  // ---- OCR: low-confidence tail of the document's own distribution ----------
  // Tesseract's confidence is heuristic and ordinal (per its manifest), so the
  // rule is RELATIVE: flag the document's own low tail, and only when a tail
  // exists (a uniformly-confident scan flags nothing). Marked, never dropped.
  function markUncertain(lines) {
    // The body words' own confidence distribution (furniture is already out).
    const confs = [];
    for (const ln of lines) { if (ln.furniture) continue; for (const tk of ln.tokens) if (tk.conf != null) confs.push(tk.conf); }
    if (confs.length < 6) return [];
    const sorted = confs.slice().sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    // Find the largest gap in the lower half — the natural break between a
    // low-confidence cluster and the document's bulk. Relative, not a hard
    // threshold (Tesseract's confidence is ordinal): a tight, uniformly high
    // scan has no such gap and flags nothing.
    const half = Math.max(2, Math.ceil(sorted.length * 0.5));
    let bestGap = 0, thr = null;
    for (let i = 1; i < half; i++) { const g = sorted[i] - sorted[i - 1]; if (g > bestGap) { bestGap = g; thr = sorted[i - 1]; } }
    if (thr == null || bestGap < 0.18 || thr >= p50) return [];   // no clear low tail
    if (sorted.filter(c => c <= thr).length > sorted.length * 0.4) return [];   // not a tail if it's ~half the doc
    const uncertain = [];
    for (const ln of lines) {
      if (ln.furniture) continue;
      for (const tk of ln.tokens) {
        if (tk.conf == null) continue;
        if (tk.conf <= thr && tk.conf < p50) {
          tk.uncertain = true;
          uncertain.push({ text: tk.text, confidence: tk.conf, page: ln.page,
            region: { x: tk.x, y: tk.run ? tk.run.y : 0, w: Math.max(0, tk.right - tk.x), h: tk.run ? tk.run.h : 0 },
            marker: formatVoidMarker('unspecified', collapseWS(tk.text)) });
        }
      }
      ln.uncertain = ln.tokens.some(t => t.uncertain);
    }
    return uncertain;
  }

  // ---- block assembly + reading order → body --------------------------------
  function lineRegion(ln) {
    return { x: ln.x0, y: ln.y0, w: Math.max(0, ln.x1 - ln.x0), h: Math.max(0, ln.y1 - ln.y0) };
  }
  function unionRegion(group) {
    const x0 = Math.min(...group.map(l => l.x0)), y0 = Math.min(...group.map(l => l.y0));
    const x1 = Math.max(...group.map(l => l.x1)), y1 = Math.max(...group.map(l => l.y1));
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
  function alignOf(group, pageLeft, pageRight) {
    const x0 = Math.min(...group.map(l => l.x0)), x1 = Math.max(...group.map(l => l.x1));
    const W = (pageRight - pageLeft) || 1;
    const leftGap = (x0 - pageLeft) / W, rightGap = (pageRight - x1) / W;
    if (leftGap > 0.12 && rightGap > 0.12 && Math.abs(leftGap - rightGap) < 0.12) return 'center';
    if (rightGap < leftGap * 0.4 && leftGap > 0.12) return 'right';
    return 'left';
  }
  // De-hyphenate a wrapped word and join two body lines into flowing prose.
  function reflowJoin(acc, next) {
    if (/[­-]$/.test(acc) && /^[a-zß-ÿ]/.test(next)) return acc.replace(/[­-]$/, '') + next;
    return acc + ' ' + next;
  }

  function buildBlocks(lines, byPage, bodyFont, yAxis) {
    const blocks = [];
    let bid = 0;
    const pages = [...byPage.keys()].sort((a, b) => a - b);
    for (const page of pages) {
      const arr = (byPage.get(page) || []).slice().sort((a, b) => a.top - b.top);
      const pageLeft = Math.min(...arr.map(l => l.x0));
      const pageRight = Math.max(...arr.map(l => l.x1));
      const bodyArr = arr.filter(l => l.role === 'body');
      const gaps = [];
      for (let i = 1; i < bodyArr.length; i++) gaps.push(bodyArr[i].top - bodyArr[i - 1].top);
      const lineGap = median(gaps) || bodyFont * 1.3;
      let cur = null;
      const flush = () => {
        if (!cur) return;
        let text;
        // body and list-item lines are wrapped prose — reflow (and de-hyphenate).
        // head-region keeps its line structure (a caption is read mechanically).
        if (cur.role === 'body' || cur.role === 'list-item') text = cur.lines.reduce((a, l, i) => i === 0 ? l.text : reflowJoin(a, l.text), '');
        else text = cur.lines.map(l => l.text).join('\n');
        blocks.push({
          id: 'b' + (bid++), role: cur.role, text,
          region: unionRegion(cur.lines), page,
          fontSize: Math.round((median(cur.lines.map(l => l.fontSize)) || bodyFont) * 10) / 10,
          fontName: mode(cur.lines.map(l => l.fontName)) || '',
          align: alignOf(cur.lines, pageLeft, pageRight),
          regionId: mode(cur.lines.map(l => l.regionId).filter(Boolean)) || undefined,
          regionRole: mode(cur.lines.map(l => l.regionRole).filter(Boolean)) || undefined,
          uncertain: cur.lines.some(l => l.uncertain) || undefined,
          relational: cur.lines.some(l => l.relational) || undefined,
        });
        cur = null;
      };
      let prev = null;
      for (const ln of arr) {
        if (ln.furniture || ln.role === 'furniture') { flush(); prev = ln; continue; }
        let startNew;
        if (!cur) startNew = true;
        else if (ln.role === 'heading') startNew = true;                 // each heading its own block
        else if (ln.role === 'list-item') startNew = true;               // a marker always opens a new item
        else if (ln.role === 'body') {
          // a body line continues the current paragraph OR the wrapped tail of a
          // list item, unless a paragraph break (vertical gap) or first-line
          // indent intervenes. Body after a heading/head-region starts fresh.
          startNew = (cur.role !== 'body' && cur.role !== 'list-item')
            || !!(prev && ((ln.top - prev.top) > lineGap * 1.5
              || (ln.x0 > prev.x0 + bodyFont * 1.4 && prev.x0 <= pageLeft + bodyFont)));
        } else startNew = (cur.role !== ln.role);   // head-region: merge consecutive lines
        if (startNew) { flush(); cur = { role: ln.role, lines: [ln] }; }
        else cur.lines.push(ln);
        prev = ln;
      }
      flush();
    }
    return blocks;
  }

  // ============================================================ LAYOUT LAYER
  //  The subject-type firewall. Layout facts are events whose SUBJECT is a
  //  region (a box on the page): a `DEF(region, role, header)`, a
  //  `DEF(region, position, top-right)`, a `CON(captionRegion, below,
  //  figureRegion)`, a `NUL(region, furniture)`. Content facts are events and
  //  spans whose subject is a referent. They reach a talker through different
  //  doors: the layout slot queries subjectType:'region' only. So a render path
  //  literally cannot pull a layout fact into a content slot.
  //
  //  A doc-layout adapter (YOLO-DocLayNet / docling-lite) supplies region roles
  //  from its closed class; absent one, the regions are synthesized from the
  //  geometric blocks so the events and the separation exist from the first
  //  wire-up — feeding the audit and the Reading view before any talker note.
  //  Two deterministic functions turn geometry into spoken tokens, salience-
  //  gated so ordinary body position is never narrated.

  // region role (closed class) → the block role it drives
  const REGION_ROLE_TO_BLOCK = {
    'page-header': 'furniture', 'page-footer': 'furniture', 'header': 'furniture', 'footer': 'furniture',
    'title': 'heading', 'list': 'list-item', 'table': 'table', 'caption': 'caption',
    'picture': 'furniture', 'figure': 'figure', 'signature': 'signature', 'text': 'body', 'body': 'body',
  };
  // block role → the region role its synthesized region carries
  const BLOCK_ROLE_TO_REGION = {
    heading: 'title', 'head-region': 'caption', 'list-item': 'list',
    body: 'text', table: 'table', signature: 'signature', figure: 'figure', caption: 'caption',
  };
  // region role → the spoken noun the talker hears (never the token itself)
  const ROLE_LABEL = {
    'page-header': 'header', 'header': 'header', 'page-footer': 'footer', 'footer': 'footer',
    'title': 'title', 'caption': 'caption', 'table': 'table', 'figure': 'figure', 'picture': 'figure',
    'signature': 'signature', 'list': 'list', 'text': 'block', 'body': 'block',
  };
  const roleLabel = (role) => ROLE_LABEL[role] || 'block';
  // The salience gate: a region earns a position only off the main reading flow
  // or carrying a non-body role. Body text gets no position.
  const isSalientRole = (role) => role !== 'text' && role !== 'body';

  function overlapArea(a, b) {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return x * y;
  }

  // doc-layout adapter events → uniform regions.
  function parseLayoutRegions(events) {
    const out = []; let k = 0;
    for (const e of (events || [])) {
      if (isFailure(e)) continue;
      const kind = (e.payload && (e.payload.kind || e.payload.role));
      if (!kind) continue;
      const r = e.region || {};
      out.push({ id: e.id || ('reg' + (k++)), role: String(kind).toLowerCase(),
        box: { x: num(r.x) || 0, y: num(r.y) || 0, w: num(r.w) || 0, h: num(r.h) || 0 },
        page: (e.meta && e.meta.page != null) ? e.meta.page : 1,
        confidence: (typeof e.confidence === 'number') ? e.confidence : null, source: 'adapter' });
    }
    return out;
  }

  // When a layout model is present, its region roles override the geometric
  // role guess (header → furniture, title → heading, …) — the spec rule.
  function bindLayoutToLines(lines, regions) {
    for (const ln of lines) {
      const lb = lineRegion(ln);
      let best = null, bestA = 0;
      for (const rg of regions) { if (rg.page !== ln.page) continue; const a = overlapArea(lb, rg.box); if (a > bestA) { bestA = a; best = rg; } }
      if (!best || bestA <= 0) continue;
      ln.regionId = best.id; ln.regionRole = best.role; ln.regionConfidence = best.confidence;
      const mapped = REGION_ROLE_TO_BLOCK[best.role];
      if (mapped === 'furniture') { ln.furniture = true; ln._furnReason = 'layout'; ln.role = 'furniture'; }
      else if (mapped) { ln.role = mapped; ln.furniture = false; }
    }
  }

  // per-page frame = the union box of all content on that page (the cartography
  // reference). A sub-region's frame can differ; we carry 'page' here.
  function pageFrames(byPage) {
    const frames = new Map();
    for (const [pg, arr] of byPage) {
      const x0 = Math.min(...arr.map(l => l.x0)), y0 = Math.min(...arr.map(l => l.y0));
      const x1 = Math.max(...arr.map(l => l.x1)), y1 = Math.max(...arr.map(l => l.y1));
      frames.set(pg, { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) });
    }
    return frames;
  }

  // Fuzzy cartography: a box (+ frame + orientation) → a closed zone token, a
  // reading-space position, and a `witnessed` flag. Reading space puts 0 at the
  // page top regardless of the source axis; orientation remaps a rotated scan.
  function describePosition(box, frame, yAxis, orientation) {
    orientation = orientation || 0;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    let relX = (cx - frame.x) / frame.w;
    const rawRelY = (cy - frame.y) / frame.h;
    let relY = (yAxis === 'up') ? (1 - rawRelY) : rawRelY;       // 0 = page top
    if (orientation === 180) { relX = 1 - relX; relY = 1 - relY; }
    else if (orientation === 90) { const t = relX; relX = relY; relY = 1 - t; }
    else if (orientation === 270) { const t = relX; relX = 1 - relY; relY = t; }
    const wide = box.w / frame.w > 0.6, tall = box.h / frame.h > 0.5;
    const hz = relX < 0.34 ? 'left' : (relX > 0.66 ? 'right' : 'center');
    const vt = relY < 0.34 ? 'top' : (relY > 0.66 ? 'bottom' : 'middle');
    let zone;
    if (wide && vt !== 'middle') zone = vt;                      // a band across the top / bottom
    else if (vt === 'middle') zone = (hz === 'center') ? 'center' : hz;
    else zone = vt + (hz === 'center' ? '' : '-' + hz);         // top / top-left / bottom-right …
    return { zone, relX: Math.round(relX * 100) / 100, relY: Math.round(relY * 100) / 100, wide, tall, frame: 'page' };
  }
  // The artifact-register phrase — "a header runs across the top". The talker
  // hears only this, never the zone token, the box, or the role token.
  function positionPhrase(zone, label, wide, tall) {
    const where = {
      'top': wide ? 'runs across the top' : 'sits at the top',
      'bottom': wide ? 'runs across the bottom' : 'sits at the bottom',
      'top-left': 'sits in the top left', 'top-right': 'sits in the top right',
      'bottom-left': 'sits at the bottom left', 'bottom-right': 'sits at the bottom right',
      'left': 'runs down the left', 'right': 'runs down the right',
      'center': tall ? 'fills the middle' : 'sits in the center',
    }[zone] || ('sits in the ' + zone);
    return 'a ' + label + ' ' + where;
  }

  // Qualitative spatial relation between two regions → a token + a phrase.
  function describeRelation(a, b, yAxis) {
    const contains = (p, q) => q.box.x >= p.box.x - 1 && q.box.y >= p.box.y - 1
      && q.box.x + q.box.w <= p.box.x + p.box.w + 1 && q.box.y + q.box.h <= p.box.y + p.box.h + 1;
    const la = roleLabel(a.role), lb = roleLabel(b.role);
    if (contains(a, b)) return { token: 'contains', phrase: `the ${la} contains the ${lb}` };
    if (contains(b, a)) return { token: 'within', phrase: `the ${la} sits within the ${lb}` };
    const readTop = (box) => yAxis === 'up' ? -(box.y + box.h / 2) : (box.y + box.h / 2);
    const xOverlap = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
    if (xOverlap > 0) return (readTop(a.box) < readTop(b.box))
      ? { token: 'above', phrase: `the ${la} sits above the ${lb}` }
      : { token: 'below', phrase: `the ${la} sits below the ${lb}` };
    return (a.box.x + a.box.w <= b.box.x)
      ? { token: 'left-of', phrase: `the ${la} sits to the left of the ${lb}` }
      : { token: 'right-of', phrase: `the ${la} sits to the right of the ${lb}` };
  }

  // Regions from the layout adapter, else synthesized from the geometric blocks
  // + held furniture, so the firewall holds with or without a layout model.
  function buildRegions(blocks, furniture, frameByPage, layoutRegions, yAxis) {
    if (layoutRegions && layoutRegions.length) {
      return layoutRegions.map(rg => Object.assign({}, rg, {
        furniture: REGION_ROLE_TO_BLOCK[rg.role] === 'furniture',
        label: roleLabel(rg.role),
      }));
    }
    const regions = [];
    for (const b of blocks) {
      regions.push({ id: b.id, role: BLOCK_ROLE_TO_REGION[b.role] || 'text', box: b.region, page: b.page,
        confidence: null, source: 'geometry', furniture: false, label: roleLabel(BLOCK_ROLE_TO_REGION[b.role] || 'text') });
    }
    let k = 0;
    for (const f of furniture) {
      const pg = (f.pages && f.pages[0]) || 1;
      const fr = frameByPage.get(pg) || { x: 0, y: 0, w: 1, h: 1 };
      const cy = f.region.y + f.region.h / 2;
      const relY = (yAxis === 'up') ? (1 - (cy - fr.y) / fr.h) : (cy - fr.y) / fr.h;
      const role = relY <= 0.5 ? 'page-header' : 'page-footer';
      regions.push({ id: 'furn' + (k++), role, box: f.region, page: pg, confidence: null,
        source: 'geometry', furniture: true, label: roleLabel(role) });
    }
    return regions;
  }

  // Emit the region-subject layout events + pre-rendered notes. Every event
  // carries subjectType:'region' — the firewall — and the detector's confidence.
  function emitLayout(regions, frameByPage, yAxis, orientation) {
    const events = [], notes = [];
    for (const rg of regions) {
      const conf = rg.confidence;
      const witnessed = conf == null || conf >= 0.5;             // approach-from-below: hedge/drop the unsure
      events.push({ op: 'DEF', subject: rg.id, subjectType: 'region', path: 'role', value: rg.role,
        box: rg.box, page: rg.page, confidence: conf, basis: 'layout' });
      if (rg.furniture) {
        events.push({ op: 'NUL', subject: rg.id, subjectType: 'region', reason: 'furniture',
          marker: formatAbsentMarker('never-set', '', 'furniture'), box: rg.box, page: rg.page,
          confidence: conf, basis: 'layout' });
      }
      if (isSalientRole(rg.role)) {
        const frame = frameByPage.get(rg.page) || { x: 0, y: 0, w: 1, h: 1 };
        const pos = describePosition(rg.box, frame, yAxis, orientation);
        const phrase = positionPhrase(pos.zone, rg.label, pos.wide, pos.tall);
        events.push({ op: 'DEF', subject: rg.id, subjectType: 'region', path: 'position', value: pos.zone,
          frame: pos.frame, phrase, witnessed, confidence: conf, page: rg.page, basis: 'layout-cartography' });
        if (witnessed) notes.push({ regionId: rg.id, role: rg.role, zone: pos.zone, phrase, source: rg.source, confidence: conf });
      }
    }
    // Region relations: a caption against the nearest figure / table / picture it
    // overlaps in x on the same page (the named caption-below-figure case).
    const relations = [];
    const captions = regions.filter(r => r.role === 'caption');
    const figures = regions.filter(r => r.role === 'figure' || r.role === 'picture' || r.role === 'table');
    for (const cap of captions) {
      let best = null, bestO = 0;
      for (const fig of figures) {
        if (fig.page !== cap.page) continue;
        const o = Math.min(cap.box.x + cap.box.w, fig.box.x + fig.box.w) - Math.max(cap.box.x, fig.box.x);
        if (o > bestO) { bestO = o; best = fig; }
      }
      if (best && bestO > 0) {
        const rel = describeRelation(cap, best, yAxis);
        events.push({ op: 'CON', subject: cap.id, subjectType: 'region', rel: rel.token, object: best.id,
          phrase: rel.phrase, page: cap.page, basis: 'layout-cartography' });
        relations.push({ a: cap.id, b: best.id, token: rel.token, phrase: rel.phrase });
        notes.push({ regionId: cap.id, role: 'caption', zone: rel.token, phrase: rel.phrase, source: cap.source, confidence: cap.confidence });
      }
    }
    return { events, notes, relations };
  }

  // ---- the one call: events (+ modality) → faithful structure ---------------
  function reconstruct(events, modality, opts) {
    modality = modality || 'pdf';
    opts = opts || {};
    const yAxis = opts.yAxis || (modality === 'ocr' ? 'down' : 'up');
    const empty = { body: '', blocks: [], furniture: [], seedEvents: [], uncertain: [],
      relationalCandidates: [], columns: [], regions: [], layoutNotes: [], layoutRelations: [], modality,
      stats: { pages: 0, lines: 0, blocks: 0, furnitureLines: 0, droppedDelimiters: 0, uncertainRuns: 0, regions: 0, layoutEvents: 0, layoutNotes: 0 } };

    const list = (events || []).filter(e => !isFailure(e) && evText(e) !== '');
    if (!list.length) return empty;

    // OCR page-level shortcut: a single whole-page event has no per-word boxes
    // to reconstruct — use its text verbatim (one body block), as the old fold did.
    if (modality === 'ocr' && list.length === 1 && list[0].meta && list[0].meta.level === 'page') {
      const body = evText(list[0]).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
      const r = list[0].region || {};
      return Object.assign({}, empty, {
        body,
        blocks: [{ id: 'b0', role: 'body', text: body, region: { x: r.x || 0, y: r.y || 0, w: r.w || 0, h: r.h || 0 }, page: 1, fontSize: num(r.h) || 0, fontName: '', align: 'left' }],
        stats: Object.assign({}, empty.stats, { pages: 1, lines: 1, blocks: 1 }),
      });
    }

    const runs = list.map(toRun);
    // Lines are built PER PAGE (runs on different pages can share a y), then
    // concatenated in page order — the spine of reading order.
    const runsByPage = new Map();
    for (const r of runs) (runsByPage.get(r.page) || runsByPage.set(r.page, []).get(r.page)).push(r);
    let lines = [];
    for (const pk of [...runsByPage.keys()].sort((a, b) => a - b)) lines = lines.concat(buildLines(runsByPage.get(pk), yAxis));
    if (!lines.length) return empty;

    const bodyFont = median(lines.map(l => l.fontSize)) || 10;
    const colInfo = stripDelimiterColumns(lines, bodyFont);
    lines = lines.filter(ln => ln.text || ln.tokens.length);   // drop lines emptied by column strip

    const byPage = pageRelative(lines);
    detectFurniture(lines, byPage, bodyFont);
    assignRoles(lines, byPage, bodyFont);
    // A doc-layout model, when present, overrides the geometric role guess with
    // its region roles (header → furniture, title → heading, …).
    const layoutRegions = parseLayoutRegions(opts.layout || []);
    if (layoutRegions.length) bindLayoutToLines(lines, layoutRegions);
    const relationalCandidates = markRelational(lines);
    const uncertain = modality === 'ocr' ? markUncertain(lines) : [];

    const blocks = buildBlocks(lines, byPage, bodyFont, yAxis);

    // body: every non-furniture block, in reading order, paragraph-separated.
    // Furniture is held out (it never reaches sentenceTexts or the talker).
    const body = blocks.filter(b => b.role !== 'furniture').map(b => b.text)
      .join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

    // furniture: one entry per repeated form / margin item, with the pages it
    // appeared on, held and never deleted.
    const furnitureGroups = new Map();
    for (const ln of lines) {
      if (!ln.furniture) continue;
      const key = normForm(ln.text) + '|' + ln._furnReason;
      let g = furnitureGroups.get(key);
      if (!g) furnitureGroups.set(key, g = { text: collapseWS(ln.text), region: lineRegion(ln), pages: new Set(), reason: ln._furnReason });
      g.pages.add(ln.page);
    }
    const furniture = [...furnitureGroups.values()].map(g => ({ text: g.text, region: g.region, pages: [...g.pages].sort((a, b) => a - b), reason: g.reason }));

    // Layout layer: regions (from the doc-layout adapter, else synthesized),
    // turned into region-subject events under the salience gate + the
    // cartography. The events / separation exist from the first wire-up.
    const frameByPage = pageFrames(byPage);
    const regions = buildRegions(blocks, furniture, frameByPage, layoutRegions, yAxis);
    const layout = emitLayout(regions, frameByPage, yAxis, opts.orientation || 0);

    // seedEvents: the Given-Log pre-events, split by SUBJECT TYPE — the
    // firewall. Region-subject layout events (role / position / relation /
    // furniture NUL) and, for OCR, run-subject NULs (an uncertain read is not a
    // confident assertion, so it must never seed a DEF/INS/CON).
    const seedEvents = layout.events.slice();
    for (const u of uncertain) {
      seedEvents.push({ op: 'NUL', subjectType: 'run', reason: 'uncertain', kind: 'unspecified',
        marker: u.marker, text: u.text, region: u.region, page: u.page,
        confidence: u.confidence, basis: 'ocr-confidence' });
    }

    const furnitureLines = lines.filter(l => l.furniture).length;
    return {
      body, blocks, furniture, seedEvents, uncertain, relationalCandidates,
      columns: colInfo.columns, modality,
      regions: regions.map(r => ({ id: r.id, role: r.role, box: r.box, page: r.page, confidence: r.confidence, source: r.source, furniture: !!r.furniture })),
      layoutNotes: layout.notes, layoutRelations: layout.relations,
      stats: {
        pages: byPage.size, lines: lines.length, blocks: blocks.length,
        furnitureLines, droppedDelimiters: colInfo.removed, uncertainRuns: uncertain.length,
        regions: regions.length, layoutEvents: layout.events.length, layoutNotes: layout.notes.length,
      },
    };
  }

  G.EOImportStructure = {
    reconstruct,
    // the cartography + firewall helpers, exposed for tests / reuse
    describePosition, describeRelation, positionPhrase, parseLayoutRegions,
    formatVoidMarker, formatAbsentMarker, normForm, _toRun: toRun,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = G.EOImportStructure;
})();
