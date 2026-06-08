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

function foldPivot(doc, spec) {
  spec = spec || {};
  let rows = doc.rows.slice();
  for (const f of (spec.filters || [])) {
    rows = rows.filter(r => String(r[f.col] ?? '').toLowerCase() === String(f.val).toLowerCase());
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

/* fuzzy column matcher — never invents a column */
function matchCol(frag, cols) {
  const f = String(frag || '').toLowerCase().trim();
  if (!f) return null;
  let best = null;
  for (const c of cols) {
    const lc = c.toLowerCase().replace(/_/g, ' ');
    let score = 0;
    if (f === lc || f === c.toLowerCase()) score = 100;
    else if (f.split(/\s+/).includes(lc)) score = 80;
    else if (lc.includes(f) || f.includes(lc)) score = 55;
    if (score > (best?.score || 0)) best = { col: c, score };
  }
  return best && best.score >= 55 ? best.col : null;
}

/* natural language → pivot spec (mechanical, no model) */
function parsePivot(question, doc) {
  const cols = doc.columns;
  const q = ' ' + String(question || '').toLowerCase() + ' ';
  const spec = { groupBy: null, aggregate: null, sortBy: null, filters: [] };
  let m;
  // group by
  if ((m = q.match(/\b(?:by|per|for each|grouped by|group by)\s+([a-z_ ]+?)(?:\s|,|$)/))) {
    const c = matchCol(m[1], cols); if (c) spec.groupBy = c;
  }
  // "which/what <col> closed/had/leads …" implies grouping by that column
  if (!spec.groupBy && (m = q.match(/\b(?:which|what|whose)\s+([a-z_ ]+?)\s+(?:closed|had|has|have|made|makes|won|got|gets|leads|led|is|are|was|were|sold|sells|brought|brings|did|does)\b/))) {
    const c = matchCol(m[1], cols); if (c) spec.groupBy = c;
  }
  const superlative = /\b(most|highest|largest|top|best|leads?|led|biggest|greatest|maximum|max)\b/.test(q);
  // aggregate
  if (/\b(count|how many|number of|tally)\b/.test(q)) spec.aggregate = { op: 'count', col: null };
  else if ((m = q.match(/\b(sum|total)\s+(?:of\s+|the\s+)?([a-z_ ]+?)(?:\s|$)/))) { const c = matchCol(m[2], cols) || (doc.numeric || [])[0]; if (c) spec.aggregate = { op: 'sum', col: c }; }
  else if ((m = q.match(/\b(average|avg|mean)\s+(?:of\s+|the\s+)?([a-z_ ]+?)(?:\s|$)/))) { const c = matchCol(m[2], cols) || (doc.numeric || [])[0]; if (c) spec.aggregate = { op: 'avg', col: c }; }
  else if (/\b(total value|value)\b/.test(q) && spec.groupBy) spec.aggregate = { op: 'sum', col: (doc.numeric || [])[0] };
  // superlative over a measure with no explicit aggregate → sum the primary numeric
  if (spec.groupBy && !spec.aggregate && superlative && /\b(value|total|amount|revenue|sales|sum|deal|deals)\b/.test(q) && (doc.numeric || [])[0]) {
    spec.aggregate = { op: 'sum', col: doc.numeric[0] };
  }
  // sort
  const desc = /\b(desc|descending|high(?:est)? to low|largest first|most first|top|reverse)\b/.test(q);
  const asc = /\b(asc|ascending|low(?:est)? to high|smallest first)\b/.test(q);
  if ((m = q.match(/\bsort(?:ed)?\s+by\s+([a-z_ ]+?)(?:\s|$)/))) { const c = matchCol(m[1], cols); if (c) spec.sortBy = { col: c, dir: desc ? 'desc' : 'asc' }; }
  else if (desc || asc) {
    if (spec.aggregate && spec.aggregate.op !== 'count') spec.sortBy = { col: spec.aggregate.col, dir: desc ? 'desc' : 'asc' };
    else if (spec.groupBy && spec.aggregate) spec.sortBy = { col: spec.groupBy, dir: desc ? 'desc' : 'asc' };
    else if (doc.numeric && doc.numeric[0]) spec.sortBy = { col: doc.numeric[0], dir: desc ? 'desc' : 'asc' };
  }
  if (desc && spec.groupBy && spec.aggregate && !spec.sortBy) spec.sortBy = { col: spec.aggregate.col, dir: 'desc' };
  // a superlative ("most", "highest", "leads") sorts groups by their measure, descending
  if (superlative && spec.groupBy && !spec.sortBy) {
    const sCol = (spec.aggregate && spec.aggregate.op !== 'count') ? spec.aggregate.col : '__agg';
    spec.sortBy = { col: sCol, dir: 'desc' };
  }
  // filter: COL = VALUE / where status won
  let fm; const fre = /\b(?:where|with|only|status)\s+([a-z_ ]+?)\s*(?:=|is|equals)?\s*["']?([a-z0-9_]+)["']?/g;
  while ((fm = fre.exec(q)) !== null) { const c = matchCol(fm[1], cols); if (c) spec.filters.push({ col: c, op: 'eq', val: fm[2] }); }
  // bare value filter — "total revenue FOR GADGET": "Gadget" is a value, not a
  // column, so match a question word against the distinct values of a
  // low-cardinality column and filter to it. Without this, a question naming a
  // category never narrows the fold. (1d)
  const taken = new Set(spec.filters.map(f => String(f.val).toLowerCase()));
  const valIndex = new Map(); // value(lc) -> column
  for (const c of cols) {
    if ((doc.numeric || []).includes(c) || (doc.date || []).includes(c)) continue;
    const vals = new Set((doc.rows || []).map(r => String(r[c] ?? '').trim()).filter(Boolean));
    if (vals.size && vals.size <= Math.max(30, (doc.rows || []).length * 0.6)) {
      for (const v of vals) { const k = v.toLowerCase(); if (!valIndex.has(k)) valIndex.set(k, c); }
    }
  }
  for (const w of (q.match(/[a-z0-9][a-z0-9'’\-]*/g) || [])) {
    if (w.length < 3 || taken.has(w) || matchCol(w, cols)) continue;
    const col = valIndex.get(w);
    if (col) { spec.filters.push({ col, op: 'eq', val: w }); taken.add(w); }
  }
  const empty = !spec.groupBy && !spec.aggregate && !spec.sortBy && !spec.filters.length;
  return { spec, empty };
}

Object.assign(window, { foldPivot, parsePivot, matchCol, num, fmtMoney, fmtNum, aggregate });
