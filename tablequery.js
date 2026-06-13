/* ============================================================
   tablequery.js — schema-aware natural-language → table filter.

   The pivot parser (pivot.jsx) classifies tokens against a table's columns and
   a narrow set of structural cues. It is fast and model-free, but it drops the
   most common real question — "clients from Mexico" — on the floor: "from" is
   not one of its cues, so the value never binds and the fold returns every row.

   This module closes that gap WITHOUT hardcoding any particular dataset. It
   reads the loaded table's OWN schema — its real columns, their types, and the
   distinct values of each categorical column — and resolves a request in two
   mechanical-first layers:

     1) A deterministic scan finds which column actually CONTAINS the value the
        question names ("mexico" → the Country column, case- and accent-
        insensitively). That alone turns "clients from Mexico" into
        Country = Mexico, no model required.

     2) When the request is genuinely ambiguous — a value lives in several
        columns, the wording names a column without a value, or conditions are
        stacked — an optional small local model reads a COMPACT card of this
        table's schema and either proposes the filter or asks one short
        clarifying question. The model may only choose columns and values that
        exist; the fold still computes the count. This is the back-and-forth.

   Published as window.EOTableQuery. Pure logic — the model is injected by the
   caller (app.jsx threads window.EOLLM.phrase), so this file runs in Node tests
   with no window at all.
   ============================================================ */
(function () {
  'use strict';

  /* ---- normalization: case- and accent-insensitive, punctuation-flattened --- */
  const deburr = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = (s) => deburr(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const normTight = (s) => deburr(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  // Function words and table chrome that must never be matched AS a value, so
  // "show me the cases" can't bind "me"/"the" to some stray one-letter cell.
  const STOP = new Set(('a an and or the of for from in into on at to by with as is are was were be been ' +
    'show me list give all any some how many number count total sum average avg mean min max most least ' +
    'top bottom group grouped per each where which who whom whose that this these those there here ' +
    'do does did has have had can could would should will what when why find filter only just about ' +
    'records record rows row entries entry results result data table client clients case cases people ' +
    'person between over under above below more less than then them they it its their our your my').split(' '));

  // Aggregate cue words → op (mirrors pivot.jsx so detection agrees).
  const AGG = { count: 'count', tally: 'count', sum: 'sum', total: 'sum', totals: 'sum', summed: 'sum',
    average: 'avg', avg: 'avg', mean: 'avg', max: 'max', maximum: 'max', min: 'min', minimum: 'min' };

  const isArr = Array.isArray;
  const cols = (doc) => (doc && isArr(doc.columns)) ? doc.columns : [];
  const rows = (doc) => (doc && isArr(doc.rows)) ? doc.rows : [];

  function columnKinds(doc) {
    const numeric = new Set(doc.numeric || []);
    const date = new Set(doc.date || []);
    const money = new Set(doc.money || []);
    const categorical = cols(doc).filter(c => !numeric.has(c) && !date.has(c));
    return { numeric, date, money, categorical };
  }

  /* ---- the per-table value index, built once and cached on the doc ----------
     For each categorical column we collect its distinct values (normalized →
     {raw, count}). Columns that are clearly free text or identifiers (too many
     distinct values) are flagged high-cardinality: they make poor filter
     targets, so we keep their name but not a value list. Discovery samples up
     to SAMPLE rows for speed on very wide/tall tables; the EXACT count always
     comes later from foldPivot over every row, never from this index. */
  const SAMPLE = 6000;          // rows scanned to discover distinct values
  const MAX_DISTINCT = 200;     // above this a column is "high-cardinality"
  const _cache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

  function buildIndex(doc) {
    const { categorical } = columnKinds(doc);
    const rs = rows(doc);
    const n = Math.min(rs.length, SAMPLE);
    const perCol = new Map();          // col -> Map(normVal -> {raw, count})
    const overflow = new Set();        // cols that blew past MAX_DISTINCT
    for (const c of categorical) perCol.set(c, new Map());
    for (let i = 0; i < n; i++) {
      const r = rs[i];
      for (const c of categorical) {
        if (overflow.has(c)) continue;
        const raw = r[c];
        if (raw == null || raw === '') continue;
        const v = String(raw).trim();
        if (!v) continue;
        const nv = norm(v);
        if (!nv) continue;
        const m = perCol.get(c);
        const hit = m.get(nv);
        if (hit) hit.count++;
        else {
          m.set(nv, { raw: v, count: 1 });
          if (m.size > MAX_DISTINCT) { overflow.add(c); perCol.set(c, new Map()); }
        }
      }
    }
    // value → [cols] reverse index, only for in-bounds (low-cardinality) columns
    const byValue = new Map();
    for (const [c, m] of perCol) {
      if (overflow.has(c) || !m.size) continue;
      for (const nv of m.keys()) {
        if (!byValue.has(nv)) byValue.set(nv, []);
        byValue.get(nv).push(c);
      }
    }
    return { perCol, overflow, byValue, sampled: n < rs.length };
  }

  function index(doc) {
    if (!_cache) return buildIndex(doc);
    let hit = _cache.get(doc);
    // rebuild if the row identity changed (re-parse / new data)
    if (!hit || hit._rows !== rows(doc)) { hit = buildIndex(doc); hit._rows = rows(doc); _cache.set(doc, hit); }
    return hit;
  }

  /* ---- column name matching (typo-tolerant), reusing pivot's matcher --------
     Falls back to a local normalized-equality match when pivot.jsx isn't loaded
     (Node tests), so validation still snaps obvious column names. */
  function matchColumn(frag, doc) {
    if (typeof window !== 'undefined' && window.matchCol) {
      const c = window.matchCol(frag, cols(doc));
      if (c) return c;
    }
    const f = normTight(frag);
    if (!f) return null;
    for (const c of cols(doc)) if (normTight(c) === f) return c;
    // light contains-match for short fragments ("country" in "Birth Country")
    for (const c of cols(doc)) { const cc = normTight(c); if (cc.includes(f) && f.length >= 4) return c; }
    return null;
  }

  // Snap a free-text value to a real distinct value of a column. Exact (normed)
  // first; then a single-edit / substring fall-back so "mexcio" or "mexican"
  // still find "Mexico". Returns the column's STORED form (what foldPivot
  // compares against) or null.
  function snapValue(doc, col, value) {
    const ix = index(doc);
    const m = ix.perCol.get(col);
    if (!m || !m.size) return null;
    const nv = norm(value);
    if (!nv) return null;
    if (m.has(nv)) return m.get(nv).raw;
    // contains either way (handles "new york city" vs "New York", "mexican" vs "Mexico")
    let best = null;
    for (const [k, info] of m) {
      if (k === nv) return info.raw;
      if (k.includes(nv) || nv.includes(k)) {
        if (!best || info.count > best.count) best = info;
      }
    }
    return best ? best.raw : null;
  }

  /* ---- the deterministic core: which columns contain the values named? -------
     Scans the query for the distinct values of every (low-cardinality)
     categorical column. Longer value phrases win over shorter ones, so
     "El Salvador" beats a stray "el". Returns one entry per distinct value
     found, each carrying every column that holds it (→ ambiguity signal). */
  function findValueMatches(doc, query) {
    const ix = index(doc);
    const q = ' ' + norm(query) + ' ';
    const found = [];
    const seen = new Set();
    for (const [col, m] of ix.perCol) {
      if (ix.overflow.has(col)) continue;
      for (const [nv, info] of m) {
        if (nv.length < 3 || STOP.has(nv)) continue;
        if (q.indexOf(' ' + nv + ' ') === -1) continue;
        const key = nv;
        if (seen.has(key)) { const e = found.find(f => f.norm === key); if (e && !e.columns.includes(col)) e.columns.push(col); continue; }
        seen.add(key);
        found.push({ norm: nv, raw: info.raw, columns: [col], count: info.count, len: nv.length });
      }
    }
    // Drop a value that is wholly contained, as a word-run, inside a longer
    // matched value ("york" when "new york" also matched) — keep the specific one.
    found.sort((a, b) => b.len - a.len);
    const kept = [];
    for (const f of found) {
      if (kept.some(k => k.norm !== f.norm && (' ' + k.norm + ' ').includes(' ' + f.norm + ' '))) continue;
      kept.push(f);
    }
    return kept;
  }

  // Does a column name appear verbatim in the query? (word-boundary, normalized)
  function mentionsColumn(doc, query) {
    const q = ' ' + norm(query) + ' ';
    const hits = [];
    for (const c of cols(doc)) {
      const nc = norm(c);
      if (nc.length >= 3 && q.indexOf(' ' + nc + ' ') !== -1) hits.push(c);
    }
    return hits;
  }

  function aggOp(query) {
    for (const w of norm(query).split(' ')) if (AGG[w]) return AGG[w];
    if (/\bhow many\b|\bnumber of\b/.test(norm(query))) return 'count';
    return null;
  }

  /* ---- looksLikeTableQuery: cheap routing signal for engine.routeTurn --------
     True when the query names a value the table holds, names a column, or asks
     for an aggregate. Lets the router lock a data question to the table even
     when pivot.jsx's narrower parse comes back empty. Cached index keeps it
     cheap on repeat turns. */
  function looksLikeTableQuery(query, doc) {
    if (!doc || doc.kind !== 'table' || !rows(doc).length) return false;
    try {
      if (findValueMatches(doc, query).length) return true;
      if (mentionsColumn(doc, query).length) return true;
      if (aggOp(query)) return true;
    } catch (e) {}
    return false;
  }

  /* ---- mechanical resolution: a spec straight from the schema scan ----------
     Combines the value-column matches (the filters) with pivot.jsx's own read
     of grouping/aggregate (so "count clients from Mexico by entry status" still
     groups). Reports any ambiguous value (matched >1 column) so the caller can
     ask. Never invents — every filter points at a real column and a stored
     value. */
  function mechanicalResolve(doc, query) {
    const matches = findValueMatches(doc, query);
    const mentioned = new Set(mentionsColumn(doc, query));
    const filters = [];
    const ambiguities = [];
    for (const m of matches) {
      let chosen = m.columns;
      // A value in several columns is disambiguated when the query also NAMES one
      // of those columns — this is what makes the back-and-forth land: answering
      // "Country = Mexico" (or "the Country one") resolves the earlier ambiguity.
      if (chosen.length > 1) {
        const narrowed = chosen.filter(c => mentioned.has(c));
        if (narrowed.length === 1) chosen = narrowed;
      }
      if (chosen.length === 1) filters.push({ col: chosen[0], op: 'eq', val: m.raw });
      else ambiguities.push({ value: m.raw, columns: m.columns.slice() });
    }
    // borrow grouping/aggregate from the pivot parser when present
    let groupBy = null, aggregate = null, sortBy = null;
    try {
      if (typeof window !== 'undefined' && window.parsePivot) {
        const pv = window.parsePivot(query, doc).spec || {};
        groupBy = pv.groupBy || null;
        aggregate = pv.aggregate || null;
        sortBy = pv.sortBy || null;
        // pivot may also have bound a filter we didn't (e.g. "status is won");
        // merge any it found on columns we haven't already filtered.
        for (const f of (pv.filters || [])) {
          if (!filters.some(x => x.col === f.col) && !ambiguities.some(a => a.columns.includes(f.col))) {
            const snapped = snapValue(doc, f.col, f.val);
            filters.push({ col: f.col, op: 'eq', val: snapped || f.val });
          }
        }
      }
    } catch (e) {}
    if (!aggregate) { const op = aggOp(query); if (op === 'count') aggregate = { op: 'count', col: null }; }
    const spec = { groupBy, aggregate, sortBy, filters };
    const confident = (filters.length > 0 || groupBy || aggregate) && ambiguities.length === 0;
    return { spec, ambiguities, confident, matches };
  }

  /* ---- a compact schema card for the model ----------------------------------
     Ranked by relevance to the query so a 300-column table still fits a small
     model's context: columns whose name or values touch the query come first,
     each shown with its type and (for categorical, low-cardinality columns) a
     short sample of real values — including the ones detected in the query, so
     the model can see that "Mexico" lives under Country. */
  function schemaCard(doc, query, opts) {
    opts = opts || {};
    const maxCols = opts.maxCols || 26;
    const sampleVals = opts.sampleVals || 12;
    const { numeric, date, money, categorical } = columnKinds(doc);
    const ix = index(doc);
    const catSet = new Set(categorical);
    const detected = findValueMatches(doc, query);
    const detectedCols = new Set();
    for (const d of detected) for (const c of d.columns) detectedCols.add(c);
    const qn = ' ' + norm(query) + ' ';
    const score = (c) => {
      let s = 0;
      if (detectedCols.has(c)) s += 100;                       // holds a queried value
      const nc = norm(c);
      if (nc && qn.indexOf(' ' + nc + ' ') !== -1) s += 60;    // named in the query
      for (const w of nc.split(' ')) if (w.length >= 4 && qn.indexOf(' ' + w + ' ') !== -1) s += 20;
      if (catSet.has(c) && !ix.overflow.has(c)) s += 4;        // filterable
      return s;
    };
    const ranked = cols(doc).slice().sort((a, b) => score(b) - score(a)).slice(0, maxCols);
    // keep the table's own column order among the chosen, for readability
    const chosen = cols(doc).filter(c => ranked.includes(c));
    const typeOf = (c) => money.has(c) ? 'money' : numeric.has(c) ? 'number' : date.has(c) ? 'date' : 'text';
    const lines = chosen.map(c => {
      let line = '- ' + c + ' (' + typeOf(c) + ')';
      if (catSet.has(c) && !ix.overflow.has(c)) {
        const m = ix.perCol.get(c);
        if (m && m.size) {
          // sample: detected values first, then most common
          const vals = [...m.values()].sort((a, b) => b.count - a.count).map(v => v.raw);
          const det = detected.filter(d => d.columns.includes(c)).map(d => d.raw);
          const ordered = [...new Set([...det, ...vals])].slice(0, sampleVals);
          line += ' — e.g. ' + ordered.map(v => '“' + v + '”').join(', ');
          if (m.size > ordered.length) line += ', … (' + m.size + ' values)';
        }
      } else if (catSet.has(c)) {
        line += ' — many distinct values (free text/id)';
      }
      return line;
    });
    return lines.join('\n');
  }

  /* ---- the model contract --------------------------------------------------- */
  function systemPrompt(doc, query) {
    const name = (doc && doc.name) || 'the table';
    return [
      'You convert a question about a data table into a filter over that table\'s REAL columns and values.',
      'Use ONLY the columns and values listed below. Never invent a column or a value.',
      '',
      'Table: "' + name + '" (' + rows(doc).length.toLocaleString('en-US') + ' rows)',
      'Columns (most relevant first):',
      schemaCard(doc, query),
      '',
      'Reply with ONE JSON object and nothing else:',
      '{"filters":[{"column":"<exact column name>","value":"<exact value shown above>"}],',
      ' "groupBy":"<column name or null>",',
      ' "aggregate":{"op":"count|sum|avg|min|max","column":"<number column or null>"} or null,',
      ' "clarify":"<one short question>" or null,',
      ' "options":["<choice>", ...]}',
      '',
      'Rules:',
      '- Match values case- and accent-insensitively to the listed values (e.g. "mexico" → "Mexico").',
      '- If the question maps cleanly to columns/values, fill "filters" and set "clarify" to null.',
      '- If a value could belong to MORE THAN ONE column, or you cannot tell which column is meant, set "clarify" to a short question, put the candidate columns in "options", and leave "filters" empty.',
      '- "groupBy"/"aggregate" only when the question asks to group, count, total, or average; otherwise null.',
      '- Output JSON only.',
    ].join('\n');
  }

  // Pull the first balanced {...} object out of a model reply and parse it.
  function parseAction(text) {
    if (!text) return null;
    const s = String(text);
    const a = s.indexOf('{');
    if (a === -1) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = a; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    let obj = null;
    try { obj = JSON.parse(s.slice(a, end + 1)); } catch (e) { return null; }
    return (obj && typeof obj === 'object') ? obj : null;
  }

  // Validate a model action against the real schema: snap columns and values,
  // drop anything that can't be made real, and surface what couldn't bind.
  function validate(doc, action) {
    const out = { filters: [], groupBy: null, aggregate: null, sortBy: null };
    const unknown = [];
    if (!action || typeof action !== 'object') return { spec: out, unknown, clarify: null, options: [] };
    for (const f of (isArr(action.filters) ? action.filters : [])) {
      const colName = f && (f.column || f.col);
      const val = f && (f.value != null ? f.value : f.val);
      if (colName == null || val == null) continue;
      const col = matchColumn(colName, doc);
      if (!col) { unknown.push({ role: 'column', token: String(colName) }); continue; }
      const snapped = snapValue(doc, col, val);
      out.filters.push({ col, op: 'eq', val: snapped != null ? snapped : String(val) });
      if (snapped == null) unknown.push({ role: 'value', token: String(val), column: col });
    }
    if (action.groupBy) { const c = matchColumn(action.groupBy, doc); if (c) out.groupBy = c; else unknown.push({ role: 'column', token: String(action.groupBy) }); }
    if (action.aggregate && action.aggregate.op) {
      const op = String(action.aggregate.op).toLowerCase();
      if (['count', 'sum', 'avg', 'min', 'max'].includes(op)) {
        let c = null;
        if (op !== 'count' && action.aggregate.column) c = matchColumn(action.aggregate.column, doc);
        out.aggregate = { op, col: c };
      }
    }
    const clarify = (action.clarify && String(action.clarify).trim()) || null;
    const options = isArr(action.options) ? action.options.map(o => String(o)).filter(Boolean).slice(0, 6) : [];
    return { spec: out, unknown, clarify, options };
  }

  // Turn a spec into a one-line, plain-language description of what it selects.
  function describe(doc, spec) {
    const parts = [];
    for (const f of (spec.filters || [])) parts.push(f.col + ' = ' + f.val);
    let s = parts.length ? parts.join(' and ') : 'all rows';
    if (spec.groupBy) s += ', grouped by ' + spec.groupBy;
    if (spec.aggregate) s += ', ' + spec.aggregate.op + (spec.aggregate.col ? ' of ' + spec.aggregate.col : '');
    return s;
  }

  function specIsEmpty(spec) {
    return !spec || (!(spec.filters && spec.filters.length) && !spec.groupBy && !spec.aggregate && !spec.sortBy);
  }

  // A deterministic clarify when a value sits in several columns and no model is
  // around (or the model didn't disambiguate): ask which column is meant.
  function clarifyForAmbiguity(doc, amb) {
    const v = amb.value;
    const labels = amb.columns.map(c => c + ' = ' + v);
    return {
      kind: 'clarify',
      question: '“' + v + '” shows up in more than one field. Which did you mean?',
      options: labels,
      pending: { value: v, columns: amb.columns.slice() },
    };
  }

  /* ---- resolve: the orchestrator the chat turn calls ------------------------
     Mechanical-first, model-for-ambiguity. `llm` is async (system, user) =>
     text; omit it and resolution stays purely mechanical. `history` is the
     prior back-and-forth (array of {role, content}) so a follow-up answer
     ("the Country one") lands. Returns one of:
       { kind:'spec',    spec, describe }            → fold it and show the count
       { kind:'clarify', question, options, pending} → ask, then resolve next turn
       { kind:'none' }                               → not a table request
  */
  async function resolve(args) {
    const { doc, query, history, llm } = args || {};
    if (!doc || doc.kind !== 'table') return { kind: 'none' };

    const mech = mechanicalResolve(doc, query);

    // Clean, unambiguous mechanical hit → use it directly. Cheapest path, and it
    // covers the headline case ("clients from Mexico") with no model at all.
    if (mech.confident && !mech.ambiguities.length) {
      return { kind: 'spec', spec: mech.spec, describe: describe(doc, mech.spec), source: 'mechanical' };
    }

    // Otherwise consult the model when one is available: it can disambiguate, read
    // intent the scan missed, or ask the user. Falls through to mechanical/own
    // clarify when there's no model or it doesn't produce something usable.
    if (typeof llm === 'function') {
      let raw = null;
      try { raw = await llm(systemPrompt(doc, query), query, history || []); } catch (e) { raw = null; }
      const action = parseAction(raw);
      if (action) {
        const v = validate(doc, action);
        if (v.clarify) return { kind: 'clarify', question: v.clarify, options: v.options, source: 'model' };
        if (!specIsEmpty(v.spec)) return { kind: 'spec', spec: v.spec, describe: describe(doc, v.spec), unknown: v.unknown, source: 'model' };
      }
    }

    // No model resolution. If the scan saw an ambiguous value, ask about it.
    if (mech.ambiguities.length) return clarifyForAmbiguity(doc, mech.ambiguities[0]);

    // A partial mechanical spec (e.g. just an aggregate, or filters we did bind)
    // is still better than nothing.
    if (!specIsEmpty(mech.spec)) return { kind: 'spec', spec: mech.spec, describe: describe(doc, mech.spec), source: 'mechanical' };

    return { kind: 'none' };
  }

  const api = {
    resolve, mechanicalResolve, looksLikeTableQuery,
    findValueMatches, mentionsColumn, snapValue, matchColumn,
    schemaCard, systemPrompt, parseAction, validate, describe, specIsEmpty,
    columnKinds, _index: index,
  };
  if (typeof window !== 'undefined') window.EOTableQuery = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
