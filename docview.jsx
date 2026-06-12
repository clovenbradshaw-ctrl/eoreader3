/* ============================================================ Document pane */

const ENT_COLOR = { person: '#2a6fdb', place: '#1f8a5b', org: '#8a6a16', thing: '#6b7280' };

/* highlight known entity names inside a sentence (explore mode) */
function highlightEntities(text, byType, onEntity) {
  const all = [];
  for (const [cls, names] of Object.entries(byType || {})) for (const n of names) all.push({ n, cls });
  all.sort((a, b) => b.n.length - a.n.length);
  if (!all.length) return text;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\b(' + all.map(e => esc(e.n)).join('|') + ')\\b', 'g');
  const out = []; let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    const name = m[0];
    if (m.index > last) out.push(text.slice(last, m.index));
    const hit = all.find(e => e.n === name);
    out.push(<span key={k++} className={'ent ' + (hit ? hit.cls : '')} onClick={(e) => { e.stopPropagation(); onEntity && onEntity(name); }}>{name}</span>);
    last = m.index + name.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function ProseDoc({ doc, explore, onEntity, activeEntity, flashSent, onCite }) {
  const proj = window.EOEngine.projectEntities(doc);
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
        {doc.blocks.map((b, bi) => {
          if (b.type === 'h1') return <h1 key={bi} className="doc-h1">{b.text}</h1>;
          if (b.type === 'h2') return <div key={bi} className="doc-h2">{b.text}</div>;
          return (
            <p key={bi} className="doc-p">
              {b.sentences.map(s => (
                <span key={s.i} id={'sent-' + doc.id + '-' + s.i} className={'sent' + (flashSent === s.i ? ' flash' : '')}>
                  {explore && <span className="sidx" title="cite this sentence" onClick={() => onCite(doc.id, s.i)}>s{s.i}</span>}
                  {explore ? highlightEntities(s.t, proj.byType, onEntity) : s.t}{' '}
                </span>
              ))}
            </p>
          );
        })}
      </div>
    </div>
  );
}

/* spreadsheet + live pivot */
function TableDoc({ doc, initialSpec }) {
  const [spec, setSpec] = React.useState(initialSpec || { groupBy: null, aggregate: null, sortBy: null, filters: [] });
  React.useEffect(() => { if (initialSpec) setSpec(initialSpec); }, [initialSpec]);
  const fold = window.foldPivot(doc, spec);
  const [openGroups, setOpenGroups] = React.useState({});
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
                      <tr key={ri} className="member"><td>{r[key0]}</td>
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
                <tr key={ri}>{doc.columns.map(c => (
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
        : cur.kind === 'table' ? <TableDoc doc={cur.doc} initialSpec={tableSpec} />
        : <ProseDoc doc={cur.doc} explore={explore} onEntity={onEntity} activeEntity={activeEntity} flashSent={flashSent} onCite={onCite} />}
    </aside>
  );
}

Object.assign(window, { DocPane, ProseDoc, TableDoc, EntityView, EntityModal });
