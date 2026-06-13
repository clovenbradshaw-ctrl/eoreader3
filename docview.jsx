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
const ProsePage = React.memo(function ProsePage({ rows, startRow, docId, explore, matcher, flash, onEntity, onCite }) {
  return rows.map((r, j) => {
    const key = startRow + j;
    if (r.type === 'h1') return <h1 key={key} className="doc-h1">{r.text}</h1>;
    if (r.type === 'h2') return <div key={key} className="doc-h2">{r.text}</div>;
    return (
      <p key={key} className="doc-p">
        {r.sentences.map(s => (
          <span key={s.i} id={'sent-' + docId + '-' + s.i} className={'sent' + (flash === s.i ? ' flash' : '')}>
            {explore && <span className="sidx" title="cite this sentence" onClick={() => onCite(docId, s.i)}>s{s.i}</span>}
            {explore ? renderWithEntities(s.t, matcher, onEntity) : s.t}{' '}
          </span>
        ))}
      </p>
    );
  });
});

function ProseDoc({ doc, explore, onEntity, activeEntity, flashSent, onCite }) {
  const proj = window.EOEngine.projectEntities(doc);
  // Keep the per-page callbacks stable so React.memo can actually skip pages:
  // onEntity from the app isn't memoized, so route both through refs.
  const onEntityRef = React.useRef(onEntity); onEntityRef.current = onEntity;
  const onCiteRef = React.useRef(onCite); onCiteRef.current = onCite;
  const stableEntity = React.useCallback((n) => onEntityRef.current && onEntityRef.current(n), []);
  const stableCite = React.useCallback((d, i) => onCiteRef.current && onCiteRef.current(d, i), []);

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
            onEntity={stableEntity} onCite={stableCite} />
        ))}
        {visible < pages.length && (
          <div className="prose-more" role="status" aria-live="polite">
            <span className="pm-orb" aria-hidden="true" /> Reading the rest of the document… {Math.round(visible / pages.length * 100)}%
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- custom record views (per-table layouts, saved locally) ----------
   A table's identity for saved views is its column signature, so the same
   schema keeps its views across reloads and even a re-import of the file. */
function tableSig(doc) { return ((doc && doc.columns) || []).join('¦'); }

// The fallback "show everything" view — what a table opens with before any
// custom view is applied. drawer = today's side panel; columns = 1.
function defaultView(doc) {
  return { id: null, name: 'All fields', layout: 'drawer', columns: 1, fields: (doc.columns || []).slice(), links: [] };
}

// Resolve one data link for one record: find rows in another loaded table whose
// foreign key matches this record's local key and pull the chosen column. Pure
// and defensive — returns { missing:true } when the linked table isn't loaded.
function resolveLink(record, link, tablesBySig) {
  const src = tablesBySig[link.fromSig];
  if (!src) return { missing: true };
  const key = String(record[link.on.local] == null ? '' : record[link.on.local]).trim().toLowerCase();
  const hits = (src.rows || []).filter(r => String(r[link.on.foreign] == null ? '' : r[link.on.foreign]).trim().toLowerCase() === key);
  return { src, hits, values: hits.map(r => r[link.show]) };
}

/* spreadsheet + live pivot + customizable record views */
function TableDoc({ doc, initialSpec, tables }) {
  const sig = tableSig(doc);
  const [spec, setSpec] = React.useState(initialSpec || { groupBy: null, aggregate: null, sortBy: null, filters: [] });
  React.useEffect(() => { if (initialSpec) setSpec(initialSpec); }, [initialSpec]);
  const fold = window.foldPivot(doc, spec);
  const [openGroups, setOpenGroups] = React.useState({});
  // The clicked record (a row), shown in the record panel. Cleared on close or
  // when the open document changes, so a panel from one CSV can't linger over
  // another. Stored as the row object itself; the panel reads every column off
  // it. (Pivoted/grouped views still show one record per data row, so the
  // record panel works the same way in both layouts.)
  const [activeRecord, setActiveRecord] = React.useState(null);
  // The saved views for this table and the effective record-view config (`view`
  // — layout, column count, visible/ordered fields, cross-table links). The
  // editor overlay edits a draft of it; the view bar switches between saved ones.
  const [views, setViews] = React.useState([]);
  const [view, setView] = React.useState(() => defaultView(doc));
  // When the editor is open, `editorView` is the config it snapshots — the
  // current view for an edit, or a fresh copy (no id/name) for a new one.
  const [editorView, setEditorView] = React.useState(null);
  const editorOpen = editorView != null;
  const openNew = () => setEditorView({ ...view, id: null, name: '' });
  const openEdit = () => setEditorView(view);

  const persist = (list, activeId) => {
    try {
      const store = (window.EOStore && window.EOStore.loadViews) ? window.EOStore.loadViews() : {};
      const prev = (store[sig] && store[sig].active) || null;
      store[sig] = { views: list, active: activeId === undefined ? prev : activeId };
      window.EOStore && window.EOStore.saveViews && window.EOStore.saveViews(store);
    } catch (e) {}
  };
  const applyViewObj = (v, remember) => {
    setView({ id: v.id, name: v.name, layout: v.layout || 'drawer', columns: v.columns || 1,
      fields: (v.fields && v.fields.length ? v.fields.slice() : doc.columns.slice()), links: (v.links || []).map(l => ({ ...l })) });
    if (v.spec) setSpec(v.spec); else setSpec({ groupBy: null, aggregate: null, sortBy: null, filters: [] });
    if (remember) persist(views, v.id || null);
  };

  // Load saved views when the table changes; auto-apply the last-used one unless
  // chat drove a pivot into this tab (initialSpec wins then).
  React.useEffect(() => {
    setActiveRecord(null);
    let entry = null;
    try { const s = (window.EOStore && window.EOStore.loadViews) ? window.EOStore.loadViews() : {}; entry = s[sig] || null; } catch (e) {}
    const list = entry && Array.isArray(entry.views) ? entry.views : [];
    setViews(list);
    const remembered = !initialSpec && entry && entry.active && list.find(v => v.id === entry.active);
    if (remembered) applyViewObj(remembered, false); else setView(defaultView(doc));
  }, [doc.id]);

  const applyView = (id) => {
    if (!id) { setView(defaultView(doc)); setSpec({ groupBy: null, aggregate: null, sortBy: null, filters: [] }); persist(views, null); return; }
    const v = views.find(x => x.id === id); if (v) applyViewObj(v, true);
  };
  // Save the editor's draft (combined with the live pivot spec) as a named view.
  const saveDraft = (draft) => {
    const id = draft.id || ('vw' + Math.random().toString(36).slice(2, 8));
    const name = (draft.name || '').trim() || ('View ' + (views.length + 1));
    const obj = { id, name, layout: draft.layout, columns: draft.columns, fields: draft.fields.slice(), links: draft.links.map(l => ({ ...l })), spec: { ...spec } };
    const list = views.some(v => v.id === id) ? views.map(v => v.id === id ? obj : v) : [...views, obj];
    setViews(list); persist(list, id);
    setView({ id, name, layout: obj.layout, columns: obj.columns, fields: obj.fields.slice(), links: obj.links.map(l => ({ ...l })) });
    setEditorView(null);
  };
  const deleteView = (id) => {
    const list = views.filter(v => v.id !== id);
    const clearing = view.id === id;
    setViews(list); persist(list, clearing ? null : undefined);
    if (clearing) setView(defaultView(doc));
  };
  const setLayout = (layout) => setView(v => ({ ...v, layout }));

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
    <div className="tabledoc">
      <div className="doc-scroll">
      <div className="tableview">
        <div className="view-bar">
          <span className="vb-label"><Icon name="layers" size={13} /> View</span>
          <select aria-label="Saved view" value={view.id || ''} onChange={e => applyView(e.target.value || null)}>
            <option value="">All fields (default)</option>
            {views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <button className="vb-btn" onClick={openNew}><Icon name="plus" size={13} /> New view</button>
          {view.id && <button className="vb-btn" onClick={openEdit}><Icon name="edit" size={13} /> Edit</button>}
          {view.id && <button className="vb-btn danger" onClick={() => deleteView(view.id)} title="Delete this view"><Icon name="trash" size={13} /></button>}
          <span className="vb-hint">click a row to open its record</span>
        </div>
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
      </div>
      </div>
      {activeRecord && (
        <RecordPanel doc={doc} record={activeRecord} view={view} tables={tables}
          onClose={() => setActiveRecord(null)} onLayout={setLayout} onCustomize={openEdit} />
      )}
      {editorOpen && (
        <ViewEditor doc={doc} tables={tables} view={editorView} onSave={saveDraft} onClose={() => setEditorView(null)} />
      )}
    </div>
  );
}

/* The clicked record, shown either as the side drawer (default) or as a
   full-width panel pinned over the table area — same width as the table, never
   taller than it (it lives inside .tabledoc, which is exactly the table region
   below the tabs). Fields render in 1–3 columns per the view, and any data
   links pull matching values from other loaded tables. Values format the same
   way the cells do: money as currency, numerics with thousands separators,
   status as the colored chip. */
function RecordPanel({ doc, record, view, tables, onClose, onLayout, onCustomize }) {
  const dialogRef = window.useDialog(onClose);
  const full = view.layout === 'full';
  const numCols = doc.numeric || [];
  const fmt = (col, v, d) => { d = d || doc;
    return (d.money || []).includes(col) ? window.fmtMoney(window.num(v))
      : (d.numeric || []).includes(col) ? window.fmtNum(window.num(v)) : v; };
  const tablesBySig = React.useMemo(() => {
    const m = {}; for (const t of (tables || [])) m[tableSig(t)] = t; return m;
  }, [tables]);
  const cols = Math.max(1, Math.min(3, view.columns || 1));
  // Respect an explicit (even empty) field list; only an absent one shows all.
  const fields = (Array.isArray(view.fields) ? view.fields : doc.columns).filter(c => doc.columns.includes(c));
  const title = record[doc.columns[0]];

  const fieldBlock = (key, label, valNode, isNum) => (
    <div key={key} className="rec-field">
      <div className="rec-label">{label}</div>
      <div className={'rec-value' + (isNum ? ' num' : '')}>{valNode}</div>
    </div>
  );
  const renderOwn = (c) => {
    const v = record[c];
    const empty = v == null || v === '';
    if (empty) return <span className="rec-empty">—</span>;
    if (c === 'status' && ['won', 'open', 'lost'].includes(String(v).toLowerCase())) return <span className={'status-tag ' + String(v).toLowerCase()}>{v}</span>;
    return fmt(c, v);
  };
  const renderLink = (link) => {
    const r = resolveLink(record, link, tablesBySig);
    if (r.missing) return { node: <span className="rec-empty" title="that table isn’t loaded right now">⚠ table not loaded</span>, isNum: false };
    if (!r.hits.length) return { node: <span className="rec-empty">— no match</span>, isNum: false };
    const isNum = (r.src.numeric || []).includes(link.show);
    const shown = r.values.slice(0, 4).map(v => (v == null || v === '' ? '—' : fmt(link.show, v, r.src))).join(' · ');
    return { node: <span>{shown}{r.values.length > 4 ? ' · +' + (r.values.length - 4) : ''}</span>, isNum };
  };

  const head = (
    <div className="drawer-head">
      <div className="row1">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rec-eyebrow">{doc.name} · record · <b>{view.name}</b></div>
          <h2 className="rec-title">{title}</h2>
        </div>
        <div className="rec-head-tools">
          <button className="rec-tool" onClick={onCustomize} title="Customize this view"><Icon name="settings" size={16} /></button>
          <button className="rec-tool" onClick={() => onLayout(full ? 'drawer' : 'full')}
                  title={full ? 'Collapse to side panel' : 'Expand to full width'}>
            <Icon name={full ? 'collapse' : 'expand'} size={16} />
          </button>
          <button className="x" onClick={onClose} aria-label="Close record"><Icon name="x" size={18} /></button>
        </div>
      </div>
    </div>
  );
  const body = (
    <div className="drawer-body record-body">
      <div className={'record-fields cols-' + cols} style={{ '--rec-cols': cols }}>
        {fields.map(c => fieldBlock(c, c, renderOwn(c), numCols.includes(c)))}
      </div>
      {view.links && view.links.length > 0 && (
        <div className="rec-links">
          <div className="rec-section"><Icon name="link" size={12} /> Linked data</div>
          <div className={'record-fields cols-' + cols} style={{ '--rec-cols': cols }}>
            {view.links.map(link => { const r = renderLink(link); return fieldBlock(link.id, link.label || link.show, r.node, r.isNum); })}
          </div>
        </div>
      )}
    </div>
  );

  if (full) {
    return (
      <div className="record-full" role="dialog" aria-modal="true"
           aria-label={'Record ' + title} tabIndex={-1} ref={dialogRef}>
        {head}{body}
      </div>
    );
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer record-drawer" role="dialog" aria-modal="true"
           aria-label={'Record ' + title} tabIndex={-1} ref={dialogRef}
           onClick={e => e.stopPropagation()}>
        {head}{body}
      </div>
    </div>
  );
}

/* The view editor: name the view, pick its record layout (side drawer vs
   full-width) and 1–3 field columns, choose & reorder which fields show, and
   add data links that pull a column from another loaded table matched on a key.
   Saving stores it locally (keyed by the table's column signature) alongside the
   live pivot spec, so the whole table state restores when the view is picked. */
function ViewEditor({ doc, tables, view, onSave, onClose }) {
  const dialogRef = window.useDialog(onClose);
  const [draft, setDraft] = React.useState(() => ({
    id: view.id || null,
    name: view.id ? (view.name || '') : '',
    layout: view.layout || 'drawer',
    columns: view.columns || 1,
    fields: (Array.isArray(view.fields) ? view.fields.slice() : doc.columns.slice()),
    links: (view.links || []).map(l => ({ ...l })),
  }));
  const upd = (patch) => setDraft(d => ({ ...d, ...patch }));
  const linkTables = (tables || []);   // every loaded table (self-joins allowed)

  const toggleField = (c) => upd({ fields: draft.fields.includes(c) ? draft.fields.filter(x => x !== c) : [...draft.fields, c] });
  const moveField = (c, dir) => {
    const f = draft.fields.slice(); const i = f.indexOf(c); const j = i + dir;
    if (i < 0 || j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]]; upd({ fields: f });
  };
  const hidden = doc.columns.filter(c => !draft.fields.includes(c));

  const addLink = () => {
    const src = linkTables[0]; if (!src) return;
    upd({ links: [...draft.links, {
      id: 'lk' + Math.random().toString(36).slice(2, 8), fromSig: tableSig(src), fromName: src.name,
      on: { local: doc.columns[0], foreign: src.columns[0] }, show: src.columns[1] || src.columns[0],
      label: src.name + ' · ' + (src.columns[1] || src.columns[0]),
    }] });
  };
  const updLink = (id, patch) => upd({ links: draft.links.map(l => l.id === id ? { ...l, ...patch } : l) });
  const setLinkSrc = (id, sig) => {
    const src = linkTables.find(t => tableSig(t) === sig); if (!src) return;
    updLink(id, { fromSig: sig, fromName: src.name, on: { local: doc.columns[0], foreign: src.columns[0] }, show: src.columns[1] || src.columns[0], label: src.name + ' · ' + (src.columns[1] || src.columns[0]) });
  };
  const delLink = (id) => upd({ links: draft.links.filter(l => l.id !== id) });

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer view-editor" role="dialog" aria-modal="true" aria-label="Customize view"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2 style={{ flex: 1 }}>{draft.id ? 'Edit view' : 'New view'}</h2>
            <button className="x" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
          </div>
          <p>A saved layout for this table’s records — width, columns, which fields, and data pulled from other tables.</p>
        </div>
        <div className="drawer-body view-editor-body">
          <div className="ve-section">
            <h3>Name</h3>
            <input className="ve-name" value={draft.name} placeholder="e.g. Deal card" onChange={e => upd({ name: e.target.value })} />
          </div>

          <div className="ve-section">
            <h3>Width</h3>
            <div className="ve-seg">
              <button className={draft.layout === 'drawer' ? 'on' : ''} onClick={() => upd({ layout: 'drawer' })}>Side drawer</button>
              <button className={draft.layout === 'full' ? 'on' : ''} onClick={() => upd({ layout: 'full' })}>Full width</button>
            </div>
          </div>

          <div className="ve-section">
            <h3><Icon name="columns" size={12} /> Field columns</h3>
            <div className="ve-seg">
              {[1, 2, 3].map(n => <button key={n} className={draft.columns === n ? 'on' : ''} onClick={() => upd({ columns: n })}>{n}</button>)}
            </div>
          </div>

          <div className="ve-section">
            <h3>Fields</h3>
            {draft.fields.map((c, i) => (
              <div key={c} className="ve-field-row">
                <input type="checkbox" checked onChange={() => toggleField(c)} aria-label={'Show ' + c} />
                <span className="nm">{c}</span>
                <button className="ve-mini" disabled={i === 0} onClick={() => moveField(c, -1)} aria-label="Move up">↑</button>
                <button className="ve-mini" disabled={i === draft.fields.length - 1} onClick={() => moveField(c, 1)} aria-label="Move down">↓</button>
              </div>
            ))}
            {hidden.map(c => (
              <div key={c} className="ve-field-row off">
                <input type="checkbox" checked={false} onChange={() => toggleField(c)} aria-label={'Show ' + c} />
                <span className="nm">{c}</span>
              </div>
            ))}
          </div>

          <div className="ve-section">
            <h3><Icon name="link" size={12} /> Data links</h3>
            {!linkTables.length && <div className="ve-empty">Load another CSV to pull linked data into a record.</div>}
            {draft.links.map(link => {
              const src = linkTables.find(t => tableSig(t) === link.fromSig);
              return (
                <div key={link.id} className="ve-link">
                  <div className="ve-link-head">
                    <input value={link.label} onChange={e => updLink(link.id, { label: e.target.value })} aria-label="Link label" />
                    <button className="ve-mini" onClick={() => delLink(link.id)} aria-label="Remove link"><Icon name="trash" size={13} /></button>
                  </div>
                  <div className="ve-link-grid">
                    <div><label>From table</label>
                      <select value={link.fromSig} onChange={e => setLinkSrc(link.id, e.target.value)}>
                        {linkTables.map((t, i) => <option key={i} value={tableSig(t)}>{t.name}</option>)}
                      </select></div>
                    <div><label>Show column</label>
                      <select value={link.show} onChange={e => updLink(link.id, { show: e.target.value })}>
                        {(src ? src.columns : []).map(c => <option key={c} value={c}>{c}</option>)}
                      </select></div>
                    <div><label>Match this table’s</label>
                      <select value={link.on.local} onChange={e => updLink(link.id, { on: { ...link.on, local: e.target.value } })}>
                        {doc.columns.map(c => <option key={c} value={c}>{c}</option>)}
                      </select></div>
                    <div><label>to their</label>
                      <select value={link.on.foreign} onChange={e => updLink(link.id, { on: { ...link.on, foreign: e.target.value } })}>
                        {(src ? src.columns : []).map(c => <option key={c} value={c}>{c}</option>)}
                      </select></div>
                  </div>
                </div>
              );
            })}
            {!!linkTables.length && <button className="vb-btn" onClick={addLink}><Icon name="plus" size={13} /> Add data link</button>}
          </div>
        </div>
        <div className="ve-footer">
          <button className="ve-save" onClick={() => onSave(draft)}>Save view</button>
          <button className="ve-cancel" onClick={onClose}>Cancel</button>
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
                  explore, onToggleExplore, onEntity, activeEntity, flashSent, onCite, tableSpec }) {
  const resolve = (id) => {
    if (id.startsWith('@ent/')) {
      const [, docId, ...rest] = id.split('/'); return { kind: 'entity', doc: docsById[docId], name: decodeURIComponent(rest.join('/')) };
    }
    const d = docsById[id]; return d ? { kind: d.kind, doc: d } : null;
  };
  const cur = activeTab ? resolve(activeTab) : null;
  // Every loaded table — passed to the record view so data links can pull a
  // column from a sibling table matched on a shared key.
  const tables = React.useMemo(() => Object.values(docsById).filter(d => d && d.kind === 'table'), [docsById]);
  const iconFor = (id) => {
    if (id.startsWith('@ent/')) return 'sparkle';
    const d = docsById[id]; return !d ? 'doc' : d.kind === 'table' ? 'table' : 'doc';
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
        </div>
      </div>
      {!cur ? <div className="empty-doc">No document open</div>
        : cur.kind === 'entity' ? <EntityView doc={cur.doc} name={cur.name} onCite={onCite} onEntity={onEntity} />
        : cur.kind === 'table' ? <TableDoc key={cur.doc.id} doc={cur.doc} initialSpec={tableSpec} tables={tables} />
        : <ProseDoc key={cur.doc.id} doc={cur.doc} explore={explore} onEntity={onEntity} activeEntity={activeEntity} flashSent={flashSent} onCite={onCite} />}
    </aside>
  );
}

Object.assign(window, { DocPane, ProseDoc, TableDoc, EntityView, EntityModal, RecordPanel, ViewEditor });
