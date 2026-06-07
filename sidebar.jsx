/* ============================================================ Sidebar ===== */
function Sidebar({ collapsed, onToggle, docs, openTabs, activeDoc, onOpenDoc,
                   chats, activeChat, onNewChat, onSelectChat, model, onModelClick, onRulesClick,
                   enabledRules, modelStatus }) {
  const iconFor = (d) => d.kind === 'table' ? 'table' : 'doc';
  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="sb-top">
        <div className="brand"><span className="glyph">Cl</span> Cleon</div>
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
              <div key={c.id} className={'sb-item' + (c.id === activeChat ? ' active' : '')} onClick={() => onSelectChat(c.id)}>
                <span className="tl">{c.title}</span>
              </div>
            ))}
          </div>
        )}

        <div className="sb-section">
          <div className="sb-label">Documents <span className="count">{docs.length}</span></div>
          {docs.length === 0 && <div className="sb-empty">Upload or paste to add a document.</div>}
          {docs.map(d => (
            <div key={d.id} className={'sb-item' + (openTabs.includes(d.id) ? ' active' : '')} onClick={() => onOpenDoc(d.id)}>
              <span className="ti"><Icon name={iconFor(d)} size={16} /></span>
              <span className="tl">{d.name}</span>
              {d.id === activeDoc && <span className="tdot" />}
            </div>
          ))}
        </div>
      </div>

      <div className="sb-foot">
        <div className="sb-foot-row" onClick={onRulesClick}>
          <span className="ti"><Icon name="layers" size={17} /></span>
          <span className="rt">Rules</span>
          <span className="model-chip">{enabledRules} on</span>
        </div>
        <div className="sb-foot-row" onClick={onModelClick}>
          <span className={'pulse' + (modelStatus === 'loading' ? ' load' : modelStatus === 'ready' ? '' : ' idle')} />
          <span className="rt">{model.name}</span>
          <span className="model-chip">{modelStatus === 'ready' ? 'loaded' : modelStatus === 'loading' ? 'loading' : 'local'}</span>
        </div>
      </div>
    </aside>
  );
}
window.Sidebar = Sidebar;
