/* ============================================================ Sidebar ===== */
function Sidebar({ collapsed, onToggle, docs, docStatus, openTabs, activeDoc, onOpenDoc, onUpload,
                   chats, activeChat, onNewChat, onSelectChat, model, onModelClick,
                   onSettingsClick, modelStatus,
                   projects, activeProject, onSelectProject, onNewProject, onDeleteProject, onClearProject,
                   sourceIds, onToggleSource }) {
  const iconFor = (d) => d.kind === 'table' ? 'table' : 'doc';
  const inScope = (id) => sourceIds && sourceIds.has(id);
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
          <div className="sb-label">Projects <span className="count">{(projects || []).length}</span>
            <button className="sb-mini" title="New project from the current sources" onClick={onNewProject}><Icon name="plus" size={13} /></button>
          </div>
          {(!projects || projects.length === 0) && <div className="sb-empty">Group sources into a project to engage them together.</div>}
          {(projects || []).map(p => (
            <div key={p.id} className={'sb-item' + (p.id === activeProject ? ' active' : '')} onClick={() => onSelectProject(p.id)}>
              <span className="ti"><Icon name="folder" size={16} /></span>
              <span className="tl">{p.name}</span>
              <span className="count">{p.docIds.length}</span>
              <button className="sb-x" title="Delete project" onClick={(e) => { e.stopPropagation(); onDeleteProject(p.id); }}><Icon name="x" size={12} /></button>
            </div>
          ))}
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
            const st = docStatus && docStatus[d.id];
            return (
            <div key={d.id} className={'sb-item' + (openTabs.includes(d.id) ? ' active' : '')} onClick={() => onOpenDoc(d.id)}>
              <span className="ti"><Icon name={iconFor(d)} size={16} /></span>
              <span className="tl">{d.name}</span>
              {st && <span className={'doc-state ' + st.state}
                title={st.state === 'indexing'
                  ? 'Embedding this document’s sentences for semantic search — a one-time pass.'
                  : 'Re-reading this document under the current rules.'}>
                {st.state === 'indexing' ? 'Indexing…' : 'Reading…'}
              </span>}
              {d.id === activeDoc && !st && <span className="tdot" />}
              <button className={'sb-src' + (inScope(d.id) ? ' on' : '')}
                title={inScope(d.id) ? 'Remove from sources' : 'Add as a source'}
                onClick={(e) => { e.stopPropagation(); onToggleSource(d.id); }}>
                <Icon name={inScope(d.id) ? 'check' : 'plus'} size={13} />
              </button>
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
