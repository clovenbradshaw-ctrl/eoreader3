/* ============================================================ Document pane */

const ENT_COLOR = { person: '#2a6fdb', place: '#1f8a5b', org: '#8a6a16', thing: '#6b7280' };

/* Compile the entity highlighter ONCE per projection, not once per sentence.
   The old highlightEntities rebuilt an alternation regex on every call; over a
   long document in explore mode that was thousands of recompiles per render. */
function buildEntityMatcher(byType) {
  const all = [];
  for (const [cls, names] of Object.entries(byType || {})) for (const n of names) all.push({ n, cls });
  if (!all.length) return null;
  all.sort((a, b) => b.n.length - a.n.length);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\b(' + all.map(e => esc(e.n)).join('|') + ')\\b', 'g');
  const cls = new Map(all.map(e => [e.n, e.cls]));
  return { re, cls };
}

/* Highlight known entity names inside one sentence using a prebuilt matcher. */
function renderWithEntities(text, matcher, onEntity) {
  if (!matcher) return text;
  const { re, cls } = matcher;
  re.lastIndex = 0;
  const out = []; let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    const name = m[0];
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span key={k++} className={'ent ' + (cls.get(name) || '')} onClick={(e) => { e.stopPropagation(); onEntity && onEntity(name); }}>{name}</span>);
    last = m.index + name.length;
    if (re.lastIndex === m.index) re.lastIndex++;   // never spin on a zero-width hit
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : text;
}

// How the document is sliced for rendering. A very long paragraph is broken
// into rows of at most ROW_SENTENCES spans so one mega-paragraph can't mount
// thousands of nodes at once; rows are grouped into pages, and pages are
// revealed a few per frame. This keeps the tab responsive while a big document
// streams in — and, because every page eventually mounts, citations and the
// browser's Find still reach the whole text once it has settled.
const ROW_SENTENCES = 25;   // max spans in one <p> — caps a mega-paragraph
const PAGE_ROWS = 8;        // rows per memoized page (≤ 200 spans/page)
const INITIAL_PAGES = 4;    // shown on first paint (fills a screen, stays snappy)
const STEP_PAGES = 4;       // pages added per animation frame thereafter

/* One revealed page: a memoized slab of rows. It only re-renders when its own
   props change — crucially, `flash` is the flashed sentence index ONLY when it
   falls inside this page (else -1), so following a citation re-renders just the
   one page that owns it, not the whole document. */
const ProsePage = React.memo(function ProsePage({ rows, startRow, docId, explore, matcher, flash, onEntity, onCite, foldOn, foldCursor, onPick }) {
  return rows.map((r, j) => {
    const key = startRow + j;
    if (r.type === 'h1') return <h1 key={key} className="doc-h1">{r.text}</h1>;
    if (r.type === 'h2') return <div key={key} className="doc-h2">{r.text}</div>;
    return (
      <p key={key} className="doc-p">
        {r.sentences.map(s => (
          <span key={s.i} id={'sent-' + docId + '-' + s.i}
                className={'sent' + (flash === s.i ? ' flash' : '') + (foldOn ? ' fold-pick' : '') + (foldCursor === s.i ? ' fold-cursor' : '')}
                onClick={foldOn ? (e) => { e.stopPropagation(); onPick(s.i); } : undefined}>
            {explore && <span className="sidx" title="cite this sentence" onClick={(e) => { e.stopPropagation(); onCite(docId, s.i); }}>s{s.i}</span>}
            {explore ? renderWithEntities(s.t, matcher, onEntity) : s.t}{' '}
          </span>
        ))}
      </p>
    );
  });
});

function ProseDoc({ doc, explore, foldLens, onEntity, activeEntity, flashSent, onCite }) {
  const proj = window.EOEngine.projectEntities(doc);
  // Keep the per-page callbacks stable so React.memo can actually skip pages:
  // onEntity from the app isn't memoized, so route both through refs.
  const onEntityRef = React.useRef(onEntity); onEntityRef.current = onEntity;
  const onCiteRef = React.useRef(onCite); onCiteRef.current = onCite;
  const stableEntity = React.useCallback((n) => onEntityRef.current && onEntityRef.current(n), []);
  const stableCite = React.useCallback((d, i) => onCiteRef.current && onCiteRef.current(d, i), []);

  // The integral-fold lens: clicking a sentence sets a cursor; the lens reads
  // the holonic fold up to it. Cursor is per-document (reset when the open doc
  // changes, or when the lens is switched off); depth is a sticky preference.
  // Click the same sentence again to clear the cursor.
  const [cursor, setCursor] = React.useState(null);
  const [foldDepth, setFoldDepth] = React.useState(99);
  React.useEffect(() => { setCursor(null); }, [doc.id]);
  React.useEffect(() => { if (!foldLens) setCursor(null); }, [foldLens]);
  const pickRef = React.useRef(null);
  pickRef.current = (i) => setCursor(c => (c === i ? null : i));
  const stablePick = React.useCallback((i) => pickRef.current && pickRef.current(i), []);
  const jumpTo = React.useCallback((i) => {
    const el = document.getElementById('sent-' + doc.id + '-' + i);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [doc.id]);

  const matcher = React.useMemo(() => (explore ? buildEntityMatcher(proj.byType) : null), [proj, explore]);

  // Flatten blocks into render rows (splitting any over-long paragraph), then
  // group rows into pages with their sentence-index span (for flash routing).
  const pages = React.useMemo(() => {
    const rows = [];
    for (const b of (doc.blocks || [])) {
      if (b.type === 'h1' || b.type === 'h2') { rows.push({ type: b.type, text: b.text }); continue; }
      const ss = b.sentences || [];
      if (ss.length <= ROW_SENTENCES) { rows.push({ type: 'p', sentences: ss }); continue; }
      for (let i = 0; i < ss.length; i += ROW_SENTENCES) rows.push({ type: 'p', sentences: ss.slice(i, i + ROW_SENTENCES) });
    }
    const out = [];
    for (let i = 0; i < rows.length; i += PAGE_ROWS) {
      const slice = rows.slice(i, i + PAGE_ROWS);
      let lo = Infinity, hi = -Infinity;
      for (const r of slice) if (r.type === 'p') for (const s of r.sentences) { if (s.i < lo) lo = s.i; if (s.i > hi) hi = s.i; }
      out.push({ start: i, rows: slice, lo: lo === Infinity ? null : lo, hi: hi === -Infinity ? null : hi });
    }
    return out;
  }, [doc]);

  // Progressive reveal: start with a few pages, then add a few per frame until
  // the whole document is mounted. Resets when the open document changes.
  const [visible, setVisible] = React.useState(INITIAL_PAGES);
  React.useEffect(() => { setVisible(INITIAL_PAGES); }, [doc.id]);
  React.useEffect(() => {
    if (visible >= pages.length) return;
    const raf = requestAnimationFrame(() => setVisible(v => Math.min(pages.length, v + STEP_PAGES)));
    return () => cancelAnimationFrame(raf);
  }, [visible, pages.length, doc.id]);
  // Following a citation may target a sentence below the reveal frontier — jump
  // the frontier so the node exists for the scroll-into-view to find.
  React.useEffect(() => {
    if (flashSent == null) return;
    const idx = pages.findIndex(p => p.lo != null && flashSent >= p.lo && flashSent <= p.hi);
    if (idx >= 0) setVisible(v => Math.max(v, Math.min(pages.length, idx + 2)));
  }, [flashSent, pages]);

  return (
    <div className={'prose-wrap' + (foldLens ? ' with-lens' : '')}>
      <div className={'doc-scroll' + (explore ? ' explore-on' : '')}>
        {explore && (
          <div className="explore-bar">
            <span className="xl">In this document</span>
            {proj.entities.slice(0, 18).map(e => (
              <button key={e.key} className={'ent-pill' + (activeEntity === e.name ? ' active' : '')} onClick={() => onEntity(e.name)}>
                <span className="swatch" style={{ background: ENT_COLOR[e.type] || ENT_COLOR.person }} />
                {e.name}<span className="n">{e.raw}</span>
              </button>
            ))}
            {!proj.entities.length && <span className="xl" style={{ opacity: .7 }}>no entities found</span>}
          </div>
        )}
        {explore && window.ReferenceDeskBar && <window.ReferenceDeskBar entities={proj.entities} />}
        <div className="prose">
          {pages.slice(0, visible).map(pg => (
            <ProsePage key={pg.start} startRow={pg.start} rows={pg.rows} docId={doc.id}
              explore={explore} matcher={matcher}
              flash={(flashSent != null && pg.lo != null && flashSent >= pg.lo && flashSent <= pg.hi) ? flashSent : -1}
              foldOn={!!foldLens} foldCursor={(cursor != null && pg.lo != null && cursor >= pg.lo && cursor <= pg.hi) ? cursor : -1}
              onEntity={stableEntity} onCite={stableCite} onPick={stablePick} />
          ))}
          {visible < pages.length && (
            <div className="prose-more" role="status" aria-live="polite">
              <span className="pm-orb" aria-hidden="true" /> Reading the rest of the document… {Math.round(visible / pages.length * 100)}%
            </div>
          )}
        </div>
      </div>
      {foldLens && <FoldLens doc={doc} cursor={cursor} depth={foldDepth} onDepth={setFoldDepth} onJump={jumpTo} />}
    </div>
  );
}

// The named holonic levels — the nest of wholes-that-are-also-parts a document
// folds along. The fold "at a given cursor, to a given degree of holonic depth"
// walks this ladder outward from the line to the whole document.
const HOLON_LEVEL = {
  document:  { name: 'Document',  hint: 'the whole document, read from its first line up to here' },
  section:   { name: 'Section',   hint: 'this chapter / section, read from its start up to here' },
  paragraph: { name: 'Paragraph', hint: 'this paragraph, read up to here' },
  sentence:  { name: 'Sentence',  hint: 'the line itself — the irreducible holon' },
};

/* The integral-fold lens. At the clicked sentence (the cursor) it shows the
   nest of containing holons — document ⊃ chapter ⊃ paragraph ⊃ sentence — each
   folded CUMULATIVELY up to the cursor, the way an integral accumulates along
   its path. The depth dial sets how far the nest unfolds: 0 is just the whole-
   document integral (the standing overview), and each step zooms in toward the
   line. The fold is mechanical — window.EOEngine.holonicFold — no model phrases
   it; rung 0 is exactly the integral fold documentFold computes. */
function FoldLens({ doc, cursor, depth, onDepth, onJump }) {
  const ladder = React.useMemo(
    () => (cursor == null || !window.EOEngine.holonicFold ? null : window.EOEngine.holonicFold(doc, cursor)),
    [doc.id, cursor]
  );
  if (!ladder) {
    return (
      <aside className="fold-lens" aria-label="Integral fold">
        <div className="fl-head"><Icon name="layers" size={15} /> <span>Integral fold</span></div>
        <div className="fl-empty">
          Click any sentence to read the document’s <b>integral fold</b> — its cumulative,
          mechanical reading from the start up to that point — then turn the <b>holonic depth</b>
          dial to zoom from the whole document down to the chapter, the paragraph, and the line.
        </div>
      </aside>
    );
  }
  const maxD = ladder.maxDepth;
  const shown = Math.max(0, Math.min(depth, maxD));
  const rungs = ladder.rungs.slice(0, shown + 1);
  const crumb = rungs.map(r => HOLON_LEVEL[r.level].name).join(' › ');
  return (
    <aside className="fold-lens" aria-label="Integral fold">
      <div className="fl-head">
        <Icon name="layers" size={15} /> <span>Integral fold</span>
        <button className="fl-cursor" title="scroll to this sentence" onClick={() => onJump(ladder.cursor)}>at s{ladder.cursor}</button>
      </div>
      <div className="fl-quote" title="scroll to this sentence" onClick={() => onJump(ladder.cursor)}>“{ladder.cursorText}”</div>
      <div className="fl-depth">
        <label htmlFor="fl-depth-range">Holonic depth</label>
        <input id="fl-depth-range" type="range" min="0" max={maxD} value={shown} step="1"
               onChange={e => onDepth(parseInt(e.target.value, 10))}
               disabled={maxD === 0} aria-label="Holonic depth" />
        <span className="fl-num">{shown}<span className="fl-den"> / {maxD}</span></span>
      </div>
      <div className="fl-crumb">{crumb}</div>
      <div className="fl-rungs">
        {rungs.map(r => (
          <div key={r.depth} className={'fl-rung lvl-' + r.level} style={{ marginLeft: r.depth * 12 }}>
            <div className="fl-rung-head" title={HOLON_LEVEL[r.level].hint}>
              <span className="fl-level">{HOLON_LEVEL[r.level].name}{r.level === 'section' && r.label ? ' · ' + r.label : ''}</span>
              <button className="fl-scope" title="scroll to where this reading begins" onClick={() => onJump(r.start)}>
                {r.count > 1 ? 's' + r.start + '–s' + (r.end - 1) + ' · ' + r.count + ' sentences' : 's' + r.start}
              </button>
            </div>
            <div className="fl-rung-body">{r.fold ? r.fold : <span className="fl-thin">— nothing folded yet at this scope —</span>}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/* A spec → one-line description, for view chips / tooltips. */
function describeSpec(doc, spec) {
  if (window.EOTableQuery && window.EOTableQuery.describe) return window.EOTableQuery.describe(doc, spec);
  const parts = (spec.filters || []).map(f => f.col + ' = ' + f.val);
  let s = parts.join(' and ') || 'all rows';
  if (spec.groupBy) s += ', by ' + spec.groupBy;
  if (spec.aggregate) s += ', ' + spec.aggregate.op + (spec.aggregate.col ? '(' + spec.aggregate.col + ')' : '');
  return s;
}

/* spreadsheet + live pivot */
function TableDoc({ doc, initialSpec, savedViews, onApplyView, onSaveView, onDeleteView }) {
  const [spec, setSpec] = React.useState(initialSpec || { groupBy: null, aggregate: null, sortBy: null, filters: [] });
  React.useEffect(() => { if (initialSpec) setSpec(initialSpec); }, [initialSpec]);
  const fold = window.foldPivot(doc, spec);
  const [openGroups, setOpenGroups] = React.useState({});
  // The clicked record (a row), shown in the side panel. Cleared on close or
  // when the open document changes, so a panel from one CSV can't linger over
  // another. Stored as the row object itself; the panel reads every column off
  // it. (Pivoted/grouped views still show one record per data row, so the side
  // panel works the same way in both layouts.)
  const [activeRecord, setActiveRecord] = React.useState(null);
  React.useEffect(() => { setActiveRecord(null); }, [doc.id]);
  const numCols = doc.numeric || [];
  const moneyCols = doc.money || [];
  const key0 = doc.columns[0];
  // Money → dollars; other numeric columns → plain thousands-separated numbers
  // so a count column isn't shown as currency; everything else verbatim. (1c)
  const fmt = (col, v) => moneyCols.includes(col) ? window.fmtMoney(window.num(v))
    : numCols.includes(col) ? window.fmtNum(window.num(v)) : v;
  const set = (patch) => setSpec(s => ({ ...s, ...patch }));
  const active = spec.groupBy || spec.aggregate || spec.sortBy || (spec.filters && spec.filters.length);

  return (
    <div className="doc-scroll">
      <div className="tableview">
        <div className="pivot-controls">
          <div className="pc"><span className="lbl">Group by</span>
            <select aria-label="Group by column" value={spec.groupBy || ''} onChange={e => set({ groupBy: e.target.value || null })}>
              <option value="">—</option>{doc.columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select></div>
          <div className="pc"><span className="lbl">Measure</span>
            <select aria-label="Measure" value={spec.aggregate ? spec.aggregate.op : ''} onChange={e => {
              const op = e.target.value; if (!op) return set({ aggregate: null });
              set({ aggregate: { op, col: op === 'count' ? null : (spec.aggregate?.col || numCols[0]) } });
            }}>
              <option value="">—</option><option value="count">count</option><option value="sum">sum</option>
              <option value="avg">avg</option><option value="max">max</option><option value="min">min</option>
            </select>
            {spec.aggregate && spec.aggregate.op !== 'count' && numCols.length > 0 && (
              <select aria-label="Measure column" value={spec.aggregate.col || ''} onChange={e => set({ aggregate: { ...spec.aggregate, col: e.target.value } })}>
                {numCols.map(c => <option key={c} value={c}>{c}</option>)}
              </select>)}
          </div>
          <div className="pc"><span className="lbl">Sort</span>
            <select aria-label="Sort by column" value={spec.sortBy ? spec.sortBy.col : ''} onChange={e => set({ sortBy: e.target.value ? { col: e.target.value, dir: spec.sortBy?.dir || 'desc' } : null })}>
              <option value="">—</option>{doc.columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {spec.sortBy && (
              <select aria-label="Sort direction" value={spec.sortBy.dir} onChange={e => set({ sortBy: { ...spec.sortBy, dir: e.target.value } })}>
                <option value="desc">↓ desc</option><option value="asc">↑ asc</option>
              </select>)}
          </div>
          {active && <button className="reset" onClick={() => setSpec({ groupBy: null, aggregate: null, sortBy: null, filters: [] })}>Reset</button>}
        </div>

        {fold.kind === 'grouped' ? (
          <React.Fragment>
            <div className="pv-note">Grouped by <b>{fold.groupBy}</b>{fold.aggregate ? <span> · <b>{fold.aggregate.op}{fold.aggregate.col ? '(' + fold.aggregate.col + ')' : ''}</b></span> : null} · folded mechanically.</div>
            <table className="grid">
              <thead><tr><th>{fold.groupBy}</th><th className="num">count</th>
                <th className="num">{fold.aggregate ? fold.aggregate.op + (fold.aggregate.col ? '(' + fold.aggregate.col + ')' : '') : ''}</th></tr></thead>
              <tbody>
                {fold.groups.map((g, gi) => (
                  <React.Fragment key={g.key}>
                    <tr className="grp" onClick={() => setOpenGroups(o => ({ ...o, [gi]: !o[gi] }))}>
                      <td>{g.key}</td><td className="num">{g.count}</td>
                      <td className="num">{g.agg.value == null ? '—' : (fold.isMoneyCol(fold.aggregate?.col) ? window.fmtMoney(g.agg.value) : window.fmtNum(g.agg.value))}</td>
                    </tr>
                    {openGroups[gi] && g.rows.map((r, ri) => (
                      <tr key={ri} className="member clickable" onClick={() => setActiveRecord(r)}>
                        <td>{r[key0]}</td>
                        <td className="num" colSpan={2}>{doc.columns.slice(1).map(c => fmt(c, r[c])).join('  ·  ')}</td></tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </React.Fragment>
        ) : (
          <table className="grid">
            <thead><tr>{doc.columns.map(c => <th key={c} className={numCols.includes(c) ? 'num' : ''}>{c}</th>)}</tr></thead>
            <tbody>
              {fold.rows.map((r, ri) => (
                <tr key={ri} className="clickable" onClick={() => setActiveRecord(r)}>{doc.columns.map(c => (
                  <td key={c} className={numCols.includes(c) ? 'num' : ''}>
                    {c === 'status' && ['won', 'open', 'lost'].includes(String(r[c]).toLowerCase())
                      ? <span className={'status-tag ' + r[c].toLowerCase()}>{r[c]}</span> : fmt(c, r[c])}
                  </td>))}</tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="pv-note" style={{ marginTop: 10 }}>{fold.total} rows · pivot questions you ask in chat are computed here directly.</div>
        {/* Saved views live under the table: reopen a filtered slice, or save the
            current one. Populated from chat ("Save as view") or this button. */}
        {((savedViews && savedViews.length) || active) && (
          <div className="saved-views">
            <span className="sv-label">Saved views</span>
            {(savedViews || []).map(v => (
              <span key={v.id} className="sv-chip" title={describeSpec(doc, v.spec)}>
                <button className="sv-open" onClick={() => onApplyView && onApplyView(doc.id, v.spec)}>{v.name}</button>
                {onDeleteView && <button className="sv-x" onClick={() => onDeleteView(doc.id, v.id)} aria-label={'Delete view ' + v.name}>×</button>}
              </span>
            ))}
            {active && onSaveView && (
              <button className="sv-save" onClick={() => onSaveView(doc.id, spec)}>
                <Icon name="plus" size={13} /> Save current view
              </button>
            )}
          </div>
        )}
      </div>
      {activeRecord && <RecordPanel doc={doc} record={activeRecord} onClose={() => setActiveRecord(null)} />}
    </div>
  );
}

/* Side panel showing every field of a clicked record. Slides in over the table
   using the shared .overlay/.drawer chrome (same affordance as Rules/Settings).
   Values format the same way the cells do: money as currency, numerics with
   thousands separators, status as the colored chip. */
function RecordPanel({ doc, record, onClose }) {
  const dialogRef = window.useDialog(onClose);
  const numCols = doc.numeric || [];
  const moneyCols = doc.money || [];
  const fmt = (col, v) => moneyCols.includes(col) ? window.fmtMoney(window.num(v))
    : numCols.includes(col) ? window.fmtNum(window.num(v)) : v;
  const title = record[doc.columns[0]];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer record-drawer" role="dialog" aria-modal="true"
           aria-label={'Record ' + title} tabIndex={-1} ref={dialogRef}
           onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rec-eyebrow">{doc.name} · record</div>
              <h2 className="rec-title">{title}</h2>
            </div>
            <button className="x" onClick={onClose} aria-label="Close record"><Icon name="x" size={18} /></button>
          </div>
        </div>
        <div className="drawer-body record-body">
          {doc.columns.map(c => {
            const v = record[c];
            const empty = v == null || v === '';
            const isStatus = c === 'status' && !empty && ['won', 'open', 'lost'].includes(String(v).toLowerCase());
            const isNum = numCols.includes(c);
            return (
              <div key={c} className="rec-field">
                <div className="rec-label">{c}</div>
                <div className={'rec-value' + (isNum ? ' num' : '')}>
                  {empty ? <span className="rec-empty">—</span>
                    : isStatus ? <span className={'status-tag ' + String(v).toLowerCase()}>{v}</span>
                    : fmt(c, v)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* entity detail rendered as a pane (when opened as a tab) */
function EntityView({ doc, name, onCite, onEntity }) {
  const d = window.EOEngine.entityDetail(doc, name);
  if (!d) return <div className="empty-doc">No notes for “{name}”.</div>;
  return (
    <div className="doc-scroll">
      <div className="entity-pane">
        <div className="ent-head">
          <span className="ent-dot" style={{ background: ENT_COLOR[d.type] || ENT_COLOR.person }} />
          <span className="ent-title">{d.name}</span>
          <span className={'phase-tag ' + d.type}>{d.type}</span>
        </div>
        <div className="ent-stats">
          <span><b>{d.raw}</b> mentions</span><span><b>{d.sentences.length}</b> sentences</span>
          <span>mass <b>{d.mass}</b></span><span className="ent-src">in {doc.name}</span>
        </div>
        {d.cooc.length > 0 && (
          <div className="ent-cooc">
            <div className="ent-sub">Appears with</div>
            {d.cooc.map(([n, c]) => <button key={n} className="ent-pill" onClick={() => onEntity(n)}>{n}<span className="n">{c}</span></button>)}
          </div>
        )}
        <div className="ent-sub">Every mention</div>
        {d.sentences.map(s => (
          <div key={s.i} className="ent-sent" onClick={() => onCite(doc.id, s.i)}>
            <span className="sidx">s{s.i}</span> {s.t}
          </div>
        ))}
        {window.ReferenceDesk && <window.ReferenceDesk term={d.name} type={d.type} />}
      </div>
    </div>
  );
}

/* the compact entity modal (pivot point), with "open as tab" */
function EntityModal({ doc, name, onCite, onEntity, onOpenTab, onClose }) {
  const d = window.EOEngine.entityDetail(doc, name);
  const dialogRef = window.useDialog(onClose);
  if (!d) return null;
  return (
    <div className="overlay center" onClick={onClose}>
      <div className="ent-modal" role="dialog" aria-modal="true" aria-label={'Entity: ' + d.name}
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="ent-modal-head">
          <span className="ent-dot" style={{ background: ENT_COLOR[d.type] || ENT_COLOR.person }} />
          <span className="ent-title">{d.name}</span>
          <span className={'phase-tag ' + d.type}>{d.type}</span>
          <div style={{ flex: 1 }} />
          <button className="ghost-pill" onClick={() => { onOpenTab(doc.id, d.name); onClose(); }}><Icon name="doc" size={14} /> Open as tab</button>
          <button className="x" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>
        <div className="ent-stats">
          <span><b>{d.raw}</b> mentions</span><span><b>{d.sentences.length}</b> sentences</span><span>mass <b>{d.mass}</b></span>
        </div>
        {d.cooc.length > 0 && (
          <div className="ent-cooc">
            {d.cooc.slice(0, 6).map(([n, c]) => <button key={n} className="ent-pill" onClick={() => onEntity(n)}>{n}<span className="n">{c}</span></button>)}
          </div>
        )}
        <div className="ent-modal-body">
          {d.sentences.slice(0, 8).map(s => (
            <div key={s.i} className="ent-sent" onClick={() => { onCite(doc.id, s.i); onClose(); }}>
              <span className="sidx">s{s.i}</span> {s.t}
            </div>
          ))}
          {d.sentences.length > 8 && <div className="ent-more" onClick={() => { onOpenTab(doc.id, d.name); onClose(); }}>+ {d.sentences.length - 8} more — open as tab</div>}
          {window.ReferenceDesk && <window.ReferenceDesk term={d.name} type={d.type} />}
        </div>
      </div>
    </div>
  );
}

/* the doc pane shell: tabs + tools + content */
function DocPane({ openTabs, activeTab, docsById, onActivate, onClose, layout, onLayout,
                  explore, onToggleExplore, onEntity, activeEntity, flashSent, onCite, tableSpec,
                  savedViews, onApplyView, onSaveView, onDeleteView,
                  allDocs, model, modelReady, onEnsureModel, onCompositionEvent }) {
  // The integral-fold lens toggle (prose only). Local + session-scoped: it
  // persists across tab switches (DocPane stays mounted) but, unlike Explore,
  // isn't written to prefs — the cursor it reads is per-document anyway.
  const [foldOn, setFoldOn] = React.useState(false);
  const resolve = (id) => {
    if (id.startsWith('@ent/')) {
      const [, docId, ...rest] = id.split('/'); return { kind: 'entity', doc: docsById[docId], name: decodeURIComponent(rest.join('/')) };
    }
    const d = docsById[id]; return d ? { kind: d.kind, doc: d } : null;
  };
  const cur = activeTab ? resolve(activeTab) : null;
  const iconFor = (id) => {
    if (id.startsWith('@ent/')) return 'sparkle';
    const d = docsById[id]; return !d ? 'doc' : d.kind === 'table' ? 'table' : d.kind === 'composition' ? 'edit' : 'doc';
  };
  const labelFor = (id) => {
    if (id.startsWith('@ent/')) { const [, , ...rest] = id.split('/'); return decodeURIComponent(rest.join('/')); }
    return docsById[id] ? docsById[id].name : id;
  };

  return (
    <aside className="pane-doc" aria-label="Document viewer" style={{ flex: 1, minWidth: 0 }}>
      <div className="doc-tabs">
        {openTabs.map(id => (
          <button key={id} className={'doc-tab' + (id === activeTab ? ' active' : '')} onClick={() => onActivate(id)}>
            <span className="ti"><Icon name={iconFor(id)} size={15} /></span>
            <span className="tt">{labelFor(id)}</span>
            <span className="tx" onClick={e => { e.stopPropagation(); onClose(id); }}><Icon name="x" size={13} /></span>
          </button>
        ))}
        <div className="doc-toolspacer" />
        <div className="doc-tools">
          {cur && cur.kind === 'prose' && (
            <button className={'doc-tool' + (explore ? ' on' : '')} onClick={onToggleExplore} title="Highlight people, places, and who speaks">
              <Icon name="sparkle" size={15} /> Explore
            </button>
          )}
          {cur && cur.kind === 'prose' && (
            <button className={'doc-tool' + (foldOn ? ' on' : '')} onClick={() => setFoldOn(v => !v)}
                    title="Click a sentence to read the integral fold up to it, at any holonic depth">
              <Icon name="layers" size={15} /> Fold
            </button>
          )}
        </div>
      </div>
      {!cur ? <div className="empty-doc">No document open</div>
        : cur.kind === 'entity' ? <EntityView doc={cur.doc} name={cur.name} onCite={onCite} onEntity={onEntity} />
        : cur.kind === 'table' ? <TableDoc doc={cur.doc} initialSpec={tableSpec}
            savedViews={(savedViews && savedViews[cur.doc.id]) || []} onApplyView={onApplyView} onSaveView={onSaveView} onDeleteView={onDeleteView} />
        : cur.kind === 'composition' ? (window.CompositionView
            ? <window.CompositionView key={cur.doc.id} doc={cur.doc} onAppend={onCompositionEvent} model={model} modelReady={modelReady} onEnsureModel={onEnsureModel} allDocs={allDocs || []} onCite={onCite} />
            : <div className="empty-doc">Composition layer not loaded.</div>)
        : <ProseDoc key={cur.doc.id} doc={cur.doc} explore={explore} foldLens={foldOn} onEntity={onEntity} activeEntity={activeEntity} flashSent={flashSent} onCite={onCite} />}
    </aside>
  );
}

Object.assign(window, { DocPane, ProseDoc, TableDoc, EntityView, EntityModal, RecordPanel, FoldLens });
