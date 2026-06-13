/* ============================================================
   Pivot engine — pure, deterministic fold over table rows.
   Mirrors the EO reader's pivot: no model touches the data.
   Also a tiny natural-language → spec parser so chat questions
   against a table compute directly.
   ============================================================ */
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const fmtMoney = (v) => v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US');
// Plain numeric formatting (thousands separators, no currency) for count-like
// numeric columns — keeps "120 units" from being rendered as "$120". (1c)
const fmtNum = (v) => v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-US');

function aggregate(rows, agg) {
  if (!agg || agg.op === 'count') return { op: 'count', value: rows.length, label: rows.length + '' };
  const nums = rows.map(r => num(r[agg.col])).filter(n => n != null);
  if (!nums.length) return { op: agg.op, col: agg.col, value: null, label: '—' };
  let v;
  if (agg.op === 'sum') v = nums.reduce((a, b) => a + b, 0);
  else if (agg.op === 'avg') v = nums.reduce((a, b) => a + b, 0) / nums.length;
  else if (agg.op === 'max') v = Math.max(...nums);
  else if (agg.op === 'min') v = Math.min(...nums);
  return { op: agg.op, col: agg.col, value: Math.round(v * 100) / 100 };
}

// Filter equality is accent-, case-, and whitespace-insensitive: real data
// mixes "México"/"Mexico"/" mexico ", and a resolved filter must match every
// variant that means the same value (not just the one stored form it snapped to).
const _fEq = (a, b) => {
  const n = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  return n(a) === n(b);
};

function foldPivot(doc, spec) {
  spec = spec || {};
  let rows = doc.rows.slice();
  for (const f of (spec.filters || [])) {
    rows = rows.filter(r => _fEq(r[f.col], f.val));
  }
  const isMoneyCol = (c) => (doc.money || []).includes(c);
  if (!spec.groupBy) {
    if (spec.sortBy) {
      const { col, dir } = spec.sortBy, s = dir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const na = num(a[col]), nb = num(b[col]);
        if (na != null && nb != null) return s * (na - nb);
        return s * String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
      });
    }
    return { kind: 'flat', columns: doc.columns, rows, total: rows.length, isMoneyCol };
  }
  const gb = spec.groupBy;
  const groups = new Map();
  for (const r of rows) {
    const k = (r[gb] ?? '(blank)') + '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let arr = [...groups.entries()].map(([key, grows]) => ({
    key, rows: grows, count: grows.length, agg: aggregate(grows, spec.aggregate),
  }));
  if (spec.sortBy) {
    const s = spec.sortBy.dir === 'desc' ? -1 : 1;
    if (spec.sortBy.col === gb) arr.sort((a, b) => s * a.key.localeCompare(b.key));
    else arr.sort((a, b) => s * ((a.agg.value || 0) - (b.agg.value || 0)));
  } else arr.sort((a, b) => a.key.localeCompare(b.key));
  return { kind: 'grouped', groupBy: gb, aggregate: spec.aggregate, groups: arr, total: rows.length, isMoneyCol };
}

/* ---- token classification over the table's CLOSED vocabulary ---------------
   The pivot vocabulary is known and finite: the column names come from the CSV
   header, the aggregates are a fixed set (count/sum/avg/min/max), and there are
   a handful of structural cues (by/where/sort/…). So we don't pattern-match the
   infinite ways to phrase a sentence — we tokenize the question and LABEL each
   token against those known sets, then assemble the spec from the labels,
   independent of word order or wrapper words. "What is the total value by
   region?", "region totals", and "break value down per region" all collapse to
   the same spec. Anything that wanted to be a column but bound to nothing is
   returned in `unbound` so the answer can SAY SO instead of dropping it and
   stamping itself grounded. */

// Damerau-Levenshtein: small enough to run per token, and the transposition
// rule catches the most common typo ("reigon" → "region", distance 1).
function editDistance(a, b) {
  a = String(a); b = String(b); const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = []; for (let i = 0; i <= m; i++) { d[i] = new Array(n + 1).fill(0); d[i][0] = i; }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
const normTok = (s) => String(s || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
// Match a word to a column: exact first, then typo-tolerant by edit distance
// scaled to the column's length. Returns { col, exact, dist } or null.
function matchColumn(frag, cols, widen = 0) {
  const f = normTok(frag); if (!f) return null;
  let best = null;
  for (const c of cols) {
    const lc = normTok(c);
    if (f === lc) return { col: c, exact: true, dist: 0 };
    const tol = (lc.length <= 4 ? 1 : 2) + widen;
    const dd = editDistance(f, lc);
    if (dd <= tol && (!best || dd < best.dist)) best = { col: c, exact: false, dist: dd };
  }
  return best;
}
/* back-compat: the old name, now typo-tolerant; returns a column name or null */
function matchCol(frag, cols) { const m = matchColumn(frag, cols); return m ? m.col : null; }

const AGG_WORDS = { count: 'count', tally: 'count', sum: 'sum', total: 'sum', totals: 'sum', summed: 'sum', average: 'avg', avg: 'avg', mean: 'avg', max: 'max', maximum: 'max', min: 'min', minimum: 'min' };
const GROUP_CUES = new Set(['by', 'per', 'grouped', 'group', 'across']);
const FILTER_CUES = new Set(['where', 'with', 'only', 'filter']);
const SORT_DESC = new Set(['desc', 'descending', 'top', 'most', 'highest', 'largest', 'biggest', 'greatest', 'leading', 'leads', 'led', 'reverse', 'best']);
const SORT_ASC = new Set(['asc', 'ascending', 'lowest', 'smallest', 'least', 'bottom']);

/* natural language → pivot spec, by token classification (mechanical, no model).
   Returns { spec, empty, unbound, notes } — unbound/notes are new and additive;
   callers that only read spec/empty are unaffected. */
function parsePivot(question, doc) {
  const cols = doc.columns || [];
  const measures = new Set([...(doc.numeric || []), ...(doc.money || [])]);
  const dates = new Set(doc.date || []);
  const isMeasure = (c) => measures.has(c);
  const isCategorical = (c) => !measures.has(c) && !dates.has(c);
  const spec = { groupBy: null, aggregate: null, sortBy: null, filters: [] };
  const unbound = []; const notes = [];

  // distinct-value index for low-cardinality categorical columns (value → column)
  const valIndex = new Map();
  for (const c of cols) {
    if (!isCategorical(c)) continue;
    const vals = new Set((doc.rows || []).map(r => String(r[c] ?? '').trim().toLowerCase()).filter(Boolean));
    if (vals.size && vals.size <= Math.max(30, (doc.rows || []).length * 0.6))
      for (const v of vals) if (!valIndex.has(v)) valIndex.set(v, c);
  }

  const W = (String(question || '').toLowerCase().match(/[a-z0-9][a-z0-9'’\-]*/g) || []);
  const used = new Array(W.length).fill(false);
  // a token in a column slot (after a cue): bind it, note a typo correction, or
  // record it as unbound with a suggestion.
  const wantColumn = (j) => {
    const w = W[j]; if (!w) return null;
    const m = matchColumn(w, cols);
    if (m) { if (!m.exact) notes.push(`read “${w}” as “${m.col}”`); return m.col; }
    const near = matchColumn(w, cols, 1);
    unbound.push({ token: w, role: 'column', suggestion: near ? near.col : null });
    return null;
  };

  // 1) aggregate words + count phrases
  let aggOp = null;
  for (let i = 0; i < W.length; i++) {
    if (AGG_WORDS[W[i]]) { aggOp = aggOp || AGG_WORDS[W[i]]; used[i] = true; }
    if ((W[i] === 'how' && W[i + 1] === 'many') || (W[i] === 'number' && W[i + 1] === 'of')) { aggOp = aggOp || 'count'; used[i] = used[i + 1] = true; }
  }

  // 2) group cues: "by/per/across <col>", "group by <col>", "for each <col>"
  for (let i = 0; i < W.length; i++) {
    const forEach = W[i] === 'for' && W[i + 1] === 'each';
    if (!GROUP_CUES.has(W[i]) && !forEach) continue;
    used[i] = true; let j = i + 1;
    if (forEach) { used[j] = true; j++; }
    if (W[j] === 'by') { used[j] = true; j++; }
    while (j < W.length && (used[j] || ['the', 'a', 'an'].includes(W[j]))) { used[j] = true; j++; }
    if (j < W.length && !spec.groupBy) {
      const col = wantColumn(j);
      if (col) { used[j] = true; if (isCategorical(col)) spec.groupBy = col; }
    }
  }

  // 3) filter cues: "where/with/only <col> [is|=] <value>"
  for (let i = 0; i < W.length; i++) {
    if (!FILTER_CUES.has(W[i]) || used[i]) continue;
    used[i] = true; let j = i + 1;
    while (j < W.length && ['the', 'a', 'an'].includes(W[j])) { used[j] = true; j++; }
    const cm = (j < W.length) ? matchColumn(W[j], cols) : null;
    let fcol = null;
    if (cm) { fcol = cm.col; if (!cm.exact) notes.push(`read “${W[j]}” as “${cm.col}”`); used[j] = true; j++; }
    while (j < W.length && ['is', 'are', 'equals', 'equal', 'to', 'of', '='].includes(W[j])) { used[j] = true; j++; }
    if (j < W.length) {
      const v = W[j];
      if (fcol && isCategorical(fcol)) { spec.filters.push({ col: fcol, op: 'eq', val: v }); used[j] = true; }
      else if (valIndex.has(v)) { spec.filters.push({ col: valIndex.get(v), op: 'eq', val: v }); used[j] = true; }
    }
  }

  // 4) bare-value filters — an unused token that is a distinct value of a
  //    categorical column ("total revenue for Gadget")
  for (let i = 0; i < W.length; i++) {
    if (used[i]) continue;
    const w = W[i]; if (w.length < 3 || matchColumn(w, cols)) continue;
    if (valIndex.has(w) && !spec.filters.some(f => f.val === w)) { spec.filters.push({ col: valIndex.get(w), op: 'eq', val: w }); used[i] = true; }
  }

  // 5) the measure column (first named measure), then the aggregate
  let measureCol = null;
  for (let i = 0; i < W.length; i++) { const m = matchColumn(W[i], cols); if (m && isMeasure(m.col)) { measureCol = m.col; used[i] = true; break; } }
  if (aggOp === 'count') spec.aggregate = { op: 'count', col: null };
  else if (aggOp) spec.aggregate = { op: aggOp, col: measureCol || (doc.money || [])[0] || (doc.numeric || [])[0] || null };

  // 6) a leftover categorical column with no cue → group by it ("region totals")
  if (!spec.groupBy) for (let i = 0; i < W.length; i++) {
    if (used[i]) continue;
    const m = matchColumn(W[i], cols);
    if (m && isCategorical(m.col)) { if (!m.exact) notes.push(`read “${W[i]}” as “${m.col}”`); spec.groupBy = m.col; used[i] = true; break; }
  }
  // 7) a measure named with a grouping but no explicit aggregate → sum it
  if (!spec.aggregate && spec.groupBy && measureCol) spec.aggregate = { op: 'sum', col: measureCol };

  // 8) sort / superlative
  let dir = null;
  for (const w of W) { if (SORT_DESC.has(w)) dir = 'desc'; else if (SORT_ASC.has(w)) dir = 'asc'; }
  for (let i = 0; i < W.length; i++) {
    if (!['sort', 'sorted', 'order', 'ordered', 'rank', 'ranked'].includes(W[i])) continue;
    let j = i + 1; if (W[j] === 'by') j++;
    const m = (j < W.length) ? matchColumn(W[j], cols) : null;
    if (m) spec.sortBy = { col: m.col, dir: dir || 'asc' };
  }
  if (!spec.sortBy && dir) {
    if (spec.aggregate && spec.aggregate.op !== 'count') spec.sortBy = { col: spec.aggregate.col, dir };
    else if (spec.groupBy && spec.aggregate) spec.sortBy = { col: spec.groupBy, dir };
    else if ((doc.numeric || [])[0]) spec.sortBy = { col: doc.numeric[0], dir };
  }
  if (dir === 'desc' && spec.groupBy && spec.aggregate && !spec.sortBy) spec.sortBy = { col: spec.aggregate.col, dir: 'desc' };

  const empty = !spec.groupBy && !spec.aggregate && !spec.sortBy && !spec.filters.length;
  return { spec, empty, unbound, notes };
}

Object.assign(window, { foldPivot, parsePivot, matchCol, num, fmtMoney, fmtNum, aggregate });
