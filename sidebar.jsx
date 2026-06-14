/* ============================================================ Sidebar ===== */
function Sidebar({ collapsed, onToggle, docs, openTabs, activeDoc, onOpenDoc, onUpload,
                   chats, activeChat, onNewChat, onSelectChat, model, onModelClick, onRulesClick,
                   onSettingsClick, enabledRules, modelStatus,
                   projects, activeProject, onSelectProject, onNewProject, onDeleteProject, onClearProject,
                   onRenameProject, onNewProjectWithDoc, onAddDocToProject, onRemoveDocFromProject, onToggleDocInProject,
                   sourceIds, onToggleSource }) {
  const iconFor = (d) => d.kind === 'table' ? 'table' : 'doc';
  const inScope = (id) => sourceIds && sourceIds.has(id);
  const docById = (id) => docs.find(d => d.id === id);
  const projList = projects || [];

  // Local UI state for moving documents in and out of projects: which projects
  // are expanded to show their members, which document's "file into a project"
  // menu is open, which project name is being edited, and which project a
  // dragged document is hovering over (so the drop target can light up).
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [menuFor, setMenuFor] = React.useState(null);
  const [renaming, setRenaming] = React.useState(null);
  const [dropTarget, setDropTarget] = React.useState(null);
  const [dragDoc, setDragDoc] = React.useState(null);
  const renameCancelRef = React.useRef(false);

  const toggleExpand = (id) => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const commitRename = (id, value) => { onRenameProject && onRenameProject(id, value); setRenaming(null); };

  // The file-into-project menu closes on any click outside it (or its trigger).
  React.useEffect(() => {
    if (!menuFor) return;
    const onDown = (e) => {
      const t = e.target;
      if (!t || !t.closest || (!t.closest('.sb-addmenu') && !t.closest('[data-proj-add]'))) setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [menuFor]);

  // ---- drag a document onto a project to add it (no need to select it) ----
  const DOC_MIME = 'application/x-cleo-doc';
  const dragHasDoc = (e) => {
    try { return [...(e.dataTransfer && e.dataTransfer.types || [])].includes(DOC_MIME); } catch (_) { return false; }
  };
  const onDocDragStart = (id) => (e) => {
    setDragDoc(id);
    try { e.dataTransfer.setData(DOC_MIME, id); e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'copy'; } catch (_) {}
  };
  const onDocDragEnd = () => { setDragDoc(null); setDropTarget(null); };
  const onProjDragOver = (id) => (e) => {
    if (!dragHasDoc(e) && dragDoc == null) return;   // let file drags fall through to the app dropzone
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    if (dropTarget !== id) setDropTarget(id);
  };
  const onProjDragLeave = (id) => () => setDropTarget(t => t === id ? null : t);
  const onProjDrop = (id) => (e) => {
    let dId = '';
    try { dId = e.dataTransfer.getData(DOC_MIME) || e.dataTransfer.getData('text/plain'); } catch (_) {}
    if (!dId) dId = dragDoc;
    if (dId) { e.preventDefault(); e.stopPropagation(); onAddDocToProject && onAddDocToProject(dId, id); }
    setDropTarget(null); setDragDoc(null);
  };

  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')} aria-label="Workspace navigation">
      <div className="sb-top">
        <div className="brand"><span className="glyph">Cl</span> Cleo</div>
        <button className="sb-icon-btn" title="Collapse sidebar" onClick={onToggle}><Icon name="sidebar" size={18} /></button>
      </div>

      <button className="sb-new" onClick={onNewChat}><Icon name="plus" size={16} /> New chat</button>

      <div className="sb-search">
        <span className="s-ic"><Icon name="search" size={15} /></span>
        <input placeholder="Search" />
      </div>

      <div className="sb-scroll">
        {chats.length > 0 && (
          <div className="sb-section">
            <div className="sb-label">Chats</div>
            {chats.map(c => (
              <div key={c.id} className={'sb-item' + (c.id === activeChat ? ' active' : '') + (c.forkedFrom ? ' forked' : '')}
                   onClick={() => onSelectChat(c.id)}
                   title={c.forkedFrom ? 'Forked conversation' : c.title}>
                {c.forkedFrom && <span className="ti"><Icon name="fork" size={14} /></span>}
                <span className="tl">{c.title}</span>
              </div>
            ))}
          </div>
        )}

        <div className="sb-section">
          <div className="sb-label">Projects <span className="count">{projList.length}</span>
            <button className="sb-mini" title="New project from the current sources" onClick={onNewProject}><Icon name="plus" size={13} /></button>
          </div>
          {projList.length === 0 && <div className="sb-empty">Group documents into a project to engage them together. Start one from the current sources with the + above, or from any document's folder button.</div>}
          {projList.map(p => {
            const open = expanded.has(p.id);
            const members = p.docIds.map(docById).filter(Boolean);
            return (
              <div key={p.id} className="sb-proj">
                <div className={'sb-item' + (p.id === activeProject ? ' active' : '') + (dropTarget === p.id ? ' droptarget' : '')}
                     onClick={() => onSelectProject(p.id)}
                     onDragOver={onProjDragOver(p.id)} onDragLeave={onProjDragLeave(p.id)} onDrop={onProjDrop(p.id)}
                     title={'Engage “' + p.name + '” — ' + p.docIds.length + ' source' + (p.docIds.length !== 1 ? 's' : '')}>
                  <button className="sb-caret" title={open ? 'Hide documents' : 'Show documents'}
                          onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}>
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
                  </button>
                  <span className="ti"><Icon name="folder" size={16} /></span>
                  {renaming === p.id
                    ? <input className="sb-rename" autoFocus defaultValue={p.name}
                             onClick={(e) => e.stopPropagation()}
                             onKeyDown={(e) => {
                               if (e.key === 'Enter') { e.preventDefault(); renameCancelRef.current = true; commitRename(p.id, e.target.value); }
                               else if (e.key === 'Escape') { e.preventDefault(); renameCancelRef.current = true; setRenaming(null); }
                             }}
                             onBlur={(e) => { if (renameCancelRef.current) { renameCancelRef.current = false; return; } commitRename(p.id, e.target.value); }} />
                    : <span className="tl" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(p.id); }}>{p.name}</span>}
                  <span className="count">{p.docIds.length}</span>
                  <button className="sb-x rn" title="Rename project" onClick={(e) => { e.stopPropagation(); setRenaming(p.id); }}><Icon name="edit" size={12} /></button>
                  <button className="sb-x" title="Delete project" onClick={(e) => { e.stopPropagation(); onDeleteProject(p.id); }}><Icon name="x" size={12} /></button>
                </div>
                {open && (
                  <div className="sb-members">
                    {members.length === 0 && <div className="sb-empty sub">No documents yet — drag one here, or use a document's folder button.</div>}
                    {members.map(d => (
                      <div key={d.id} className="sb-item member" onClick={() => onOpenDoc(d.id)} title={d.name}>
                        <span className="ti"><Icon name={iconFor(d)} size={14} /></span>
                        <span className="tl">{d.name}</span>
                        <button className="sb-x" title={'Remove from “' + p.name + '”'}
                                onClick={(e) => { e.stopPropagation(); onRemoveDocFromProject(d.id, p.id); }}><Icon name="x" size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {activeProject && <button className="sb-link" onClick={onClearProject}>Clear project scope</button>}
        </div>

        <div className="sb-section">
          <div className="sb-label">Documents <span className="count">{docs.length}</span>
            {onUpload && <button className="sb-mini" title="Upload a document (.txt, .md, .csv)" onClick={onUpload}><Icon name="upload" size={13} /></button>}
          </div>
          {docs.length === 0 && (
            <button type="button" className="sb-dropzone" onClick={onUpload}>
              <Icon name="upload" size={16} />
              <span className="dz-main">Upload a document</span>
              <span className="dz-sub">or drop a file anywhere · .txt, .md, .csv</span>
            </button>
          )}
          {docs.map(d => {
            const filed = projList.some(p => p.docIds.includes(d.id));
            return (
              <div key={d.id} className="sb-docrow">
                <div className={'sb-item' + (openTabs.includes(d.id) ? ' active' : '') + (dragDoc === d.id ? ' dragging' : '')}
                     draggable
                     onDragStart={onDocDragStart(d.id)} onDragEnd={onDocDragEnd}
                     onClick={() => onOpenDoc(d.id)}>
                  <span className="ti"><Icon name={iconFor(d)} size={16} /></span>
                  <span className="tl">{d.name}</span>
                  {d.id === activeDoc && <span className="tdot" />}
                  <button data-proj-add className={'sb-src proj' + (filed ? ' on' : '') + (menuFor === d.id ? ' open' : '')}
                          title={filed ? 'In a project — manage' : 'Add to a project'}
                          onClick={(e) => { e.stopPropagation(); setMenuFor(m => m === d.id ? null : d.id); }}>
                    <Icon name="folder" size={13} />
                  </button>
                  <button className={'sb-src' + (inScope(d.id) ? ' on' : '')}
                    title={inScope(d.id) ? 'Remove from sources' : 'Add as a source'}
                    onClick={(e) => { e.stopPropagation(); onToggleSource(d.id); }}>
                    <Icon name={inScope(d.id) ? 'check' : 'plus'} size={13} />
                  </button>
                </div>
                {menuFor === d.id && (
                  <div className="sb-addmenu">
                    <div className="sb-addmenu-h">{projList.length ? 'File “' + d.name + '” into' : 'No projects yet'}</div>
                    {projList.map(p => {
                      const inIt = p.docIds.includes(d.id);
                      return (
                        <button key={p.id} className={'sb-addmenu-row' + (inIt ? ' on' : '')}
                                title={inIt ? 'Remove from this project' : 'Add to this project'}
                                onClick={() => onToggleDocInProject(d.id, p.id)}>
                          <span className="mk"><Icon name={inIt ? 'check' : 'plus'} size={13} /></span>
                          <span className="tl">{p.name}</span>
                          <span className="count">{p.docIds.length}</span>
                        </button>
                      );
                    })}
                    <button className="sb-addmenu-row new" onClick={() => { setMenuFor(null); onNewProjectWithDoc && onNewProjectWithDoc(d.id); }}>
                      <span className="mk"><Icon name="folder" size={13} /></span>
                      <span className="tl">New project…</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {docs.length > 0 && onUpload && (
            <button type="button" className="sb-dropzone slim" onClick={onUpload}>
              <Icon name="plus" size={14} /><span className="dz-main">Add another document</span>
            </button>
          )}
        </div>
      </div>

      <div className="sb-foot">
        {onSettingsClick && (
          <div className="sb-foot-row" onClick={onSettingsClick}>
            <span className="ti"><Icon name="settings" size={17} /></span>
            <span className="rt">Settings</span>
          </div>
        )}
        <div className="sb-foot-row" onClick={onRulesClick}>
          <span className="ti"><Icon name="layers" size={17} /></span>
          <span className="rt">Rules</span>
          <span className="model-chip">{enabledRules} on</span>
        </div>
        <div className="sb-foot-row" data-model-trigger onClick={onModelClick}>
          <span className={'pulse' + (modelStatus === 'loading' ? ' load' : modelStatus === 'ready' ? '' : ' idle')} />
          <span className="rt">{model.name}</span>
          <span className="model-chip">{model.provider === 'anthropic'
            ? (modelStatus === 'ready' ? 'connected' : modelStatus === 'loading' ? 'connecting' : 'cloud')
            : (modelStatus === 'ready' ? 'loaded' : modelStatus === 'loading' ? 'loading' : 'local')}</span>
        </div>
      </div>
    </aside>
  );
}
window.Sidebar = Sidebar;
