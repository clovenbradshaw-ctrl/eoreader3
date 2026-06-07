/* ============================================================
   App — wires the real engine: upload/paste → parse → explore + chat.
   Mechanical grounded answers always work; the local LLM (if loaded)
   only phrases them, citations bound mechanically either way.
   ============================================================ */
const { useState, useEffect, useRef, useCallback, useMemo } = React;
let _uid = 0; const uid = (p) => p + '-' + (++_uid);

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [docs, setDocs] = useState([]);
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState('new');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('auto');
  const [busy, setBusy] = useState(false);

  const [rules, setRules] = useState(window.RULESETS.map(r => ({ ...r })));
  const [rulesOpen, setRulesOpen] = useState(false);
  const [model, setModel] = useState(window.MODELS[0]);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelStatus, setModelStatus] = useState('idle'); // idle | loading | ready
  const [modelProgress, setModelProgress] = useState(0);

  const [openTabs, setOpenTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [layout, setLayout] = useState('split'); // split | chat | doc
  const [explore, setExplore] = useState(false);
  const [activeEntity, setActiveEntity] = useState(null);
  const [flashSent, setFlashSent] = useState(null);
  const [tableSpec, setTableSpec] = useState(null);
  const [entityModal, setEntityModal] = useState(null);

  const [splitRatio, setSplitRatio] = useState(0.46);
  const [dragging, setDragging] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);
  const bodyRef = useRef(null);
  const fileRef = useRef(null);
  const dragCount = useRef(0);

  const docsById = useMemo(() => Object.fromEntries(docs.map(d => [d.id, d])), [docs]);

  // Push rule changes into the engine, then re-parse open docs so
  // extraction-phase rules (δ, two-sighting, the anaphora discount and
  // pronoun gate) take effect — those decisions are baked into the event
  // log at parse time. Replay-phase rules re-derive on the next projection.
  const firstRules = useRef(true);
  useEffect(() => {
    window.EO_RULES = rules;
    if (window.EOEngine && window.EOEngine.applyRules) window.EOEngine.applyRules(rules);
    if (firstRules.current) { firstRules.current = false; return; } // no docs at mount
    setDocs(ds => ds.map(d => (d._text != null
      ? window.EOEngine.parseDocument(d._name || d.name, d._text, d.id)
      : d)));
  }, [rules]);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  const backingDoc = () => {
    if (activeTab) {
      if (activeTab.startsWith('@ent/')) return docsById[activeTab.split('/')[1]] || null;
      if (docsById[activeTab]) return docsById[activeTab];
    }
    return docs[docs.length - 1] || null;
  };
  const proseDocFor = () => {
    const b = backingDoc(); if (b && b.kind === 'prose') return b;
    return docs.filter(d => d.kind === 'prose').slice(-1)[0] || null;
  };

  const openTab = useCallback((id) => {
    setOpenTabs(t => t.includes(id) ? t : [...t, id]);
    setActiveTab(id);
    setLayout(l => l === 'chat' ? 'split' : l);
  }, []);

  const closeTab = (id) => {
    setOpenTabs(t => {
      const next = t.filter(x => x !== id);
      if (activeTab === id) setActiveTab(next[next.length - 1] || null);
      return next;
    });
  };

  // ---- ingest ----
  const ingest = (name, text) => {
    const id = uid('doc');
    let doc;
    try { doc = window.EOEngine.parseDocument(name, text, id); }
    catch (e) { showToast('Could not read that file.'); return null; }
    setDocs(ds => [...ds, doc]);
    setOpenTabs(t => [...t, id]); setActiveTab(id); setLayout('split');
    if (doc.kind === 'prose') setExplore(true);
    setTableSpec(null);
    showToast('Added “' + name + '” · ' + doc.meta);
    return doc;
  };
  const handleFiles = (fileList) => {
    const files = [...fileList];
    files.forEach(f => { const r = new FileReader(); r.onload = () => ingest(f.name, String(r.result)); r.readAsText(f); });
  };
  const onExample = (ex) => ingest(ex.name, ex.text);

  // ---- citations / entities ----
  const flashCitation = useCallback((docId, idx) => {
    setOpenTabs(t => t.includes(docId) ? t : [...t, docId]);
    setActiveTab(docId);
    setLayout(l => l === 'chat' ? 'split' : l);
    setExplore(true);
    setTimeout(() => {
      setFlashSent(idx);
      const node = document.getElementById('sent-' + docId + '-' + idx);
      if (node) { const sc = node.closest('.doc-scroll'); if (sc) sc.scrollTo({ top: node.offsetTop - 150, behavior: 'smooth' }); }
      setTimeout(() => setFlashSent(null), 1900);
    }, 90);
  }, []);

  const onEntity = (name) => {
    const d = proseDocFor() || docs.find(x => x.kind === 'prose') || docs[0];
    if (!d) return;
    setActiveEntity(name);
    setEntityModal({ docId: d.id, name });
  };
  const openEntityTab = (docId, name) => { openTab('@ent/' + docId + '/' + encodeURIComponent(name)); };

  // ---- model: load the real local model for the demo ----
  const loadModel = async (m) => {
    if (!window.EOLLM) { showToast('Local model module unavailable.'); return false; }
    if (!window.EOLLM.hasWebGPU()) { setModelStatus('idle'); return false; }
    setModelStatus('loading'); setModelProgress(0);
    try {
      await window.EOLLM.load(m.mlc, (p) => setModelProgress(p));
      setModelStatus('ready'); return true;
    } catch (e) { setModelStatus('idle'); showToast(e.message || 'Model failed to load'); return false; }
  };
  const pickModel = (m) => { setModel(m); setModelStatus('idle'); loadModel(m); };

  // auto-load on startup so the demo is live with the actual model
  useEffect(() => {
    if (window.EOLLM && window.EOLLM.hasWebGPU()) loadModel(model);
  }, []);

  // keep an in-chat "loading model" message in sync with download progress
  useEffect(() => {
    setMessages(m => {
      if (!m.length) return m; const last = m[m.length - 1];
      if (last && last.loading) { const c = m.slice(); c[c.length - 1] = { ...last, loadPct: modelProgress }; return c; }
      return m;
    });
  }, [modelProgress]);

  // ---- chat ----
  const ensureChat = (q) => {
    if (activeChat === 'new') {
      const id = uid('c'); setChats(cs => [{ id, title: q.length > 32 ? q.slice(0, 32) + '…' : q }, ...cs]); setActiveChat(id);
    }
  };
  const replaceLast = (patch) => setMessages(m => { const c = m.slice(); c[c.length - 1] = { ...c[c.length - 1], ...patch, typing: false }; return c; });
  const patchLast = (patch) => setMessages(m => { const c = m.slice(); c[c.length - 1] = { ...c[c.length - 1], ...patch }; return c; });

  const runMechanical = (doc, q) => {
    const plan = window.EOEngine.answer(doc, q);
    replaceLast({ role: 'assistant', text: plan.text, audit: plan.audit, mode: mode === 'creative' ? 'creative' : 'grounded' });
    if (plan.tableSpec && doc) { openTab(doc.id); setTableSpec({ ...plan.tableSpec }); }
    if (plan.cites && plan.cites.length) setTimeout(() => flashCitation(plan.cites[0].docId, plan.cites[0].idx), 380);
    setBusy(false);
  };

  const runLLM = async (doc, q) => {
    // SEEKER (mechanical) decides what there is to say. The model only
    // phrases it. Meta-asks route by intent; "who" is exact-mechanical;
    // if the seeker finds no ground, fall to the mechanical hold / void.
    const intent = doc && doc.kind === 'prose' ? window.EOEngine.classifyIntent(q) : 'chat';
    if (doc && doc.kind === 'prose') {
      if (intent === 'who') { runMechanical(doc, q); return; }
      if (!window.EOEngine.hasGround(doc, q)) { runMechanical(doc, q); return; }
    }
    const ctx = doc ? window.EOEngine.context(doc, q, 6) : '';
    const task = mode === 'creative' ? 'creative' : (intent === 'summary' ? 'summary' : 'answer');
    try {
      replaceLast({ role: 'assistant', text: '', mode, streaming: true });
      let full = '';
      full = await window.EOLLM.phrase({
        mlcKey: model.mlc, question: q, contextText: ctx, mode, task,
        onToken: (d) => { full += d; setMessages(m => { const c = m.slice(); c[c.length - 1] = { role: 'assistant', text: full, mode, streaming: true }; return c; }); },
      });
      if (!doc || mode === 'creative') replaceLast({ role: 'assistant', text: full, audit: null, mode });
      else if (/passages?\s+do\s?n.?t\s+say/i.test(full) || full.trim().length < 3) {
        const mech = window.EOEngine.answer(doc, q);
        replaceLast({ role: 'assistant', text: mech.text, audit: mech.audit, mode });
        if (mech.cites && mech.cites.length) setTimeout(() => flashCitation(mech.cites[0].docId, mech.cites[0].idx), 380);
      } else {
        // MECHANICAL VETO: if the model invented a name that's nowhere in
        // the document, or its phrasing won't bind, discard it and show
        // the mechanical grounded answer instead. The model never wins
        // over the page.
        const invented = window.EOEngine.inventedTerms(doc, full);
        const bound = window.EOEngine.bindCitations(doc, full, q, intent);
        if (invented.length || !bound.audit.grounded) {
          const mech = window.EOEngine.answer(doc, q);
          replaceLast({ role: 'assistant', text: mech.text, audit: mech.audit, mode });
          if (mech.cites && mech.cites.length) setTimeout(() => flashCitation(mech.cites[0].docId, mech.cites[0].idx), 380);
        } else {
          replaceLast({ role: 'assistant', text: bound.text, audit: bound.audit, mode });
          if (bound.cites && bound.cites.length) setTimeout(() => flashCitation(bound.cites[0].docId, bound.cites[0].idx), 380);
        }
      }
    } catch (e) { if (doc) runMechanical(doc, q); else replaceLast({ role: 'assistant', text: 'The local model hit an error mid-answer. Try again, or add a document and I’ll answer from it directly.', audit: null }); return; }
    setBusy(false);
  };

  const send = async (text) => {
    const q = (text != null ? text : input).trim();
    if (!q || busy) return;
    setInput('');

    // hero: a long paste with no doc is a document to read, not a question
    const noDocs = docs.length === 0;
    if (noDocs && (q.length > 140 || /\n/.test(q))) { ingest('Pasted text.txt', q); return; }

    setMessages(m => [...m, { role: 'user', text: q }, { role: 'assistant', typing: true }]);
    setBusy(true); ensureChat(q);

    const doc = backingDoc();
    const canLLM = !!(window.EOLLM && window.EOLLM.hasWebGPU());

    // load the real model on demand if it isn't ready yet
    if (canLLM && !window.EOLLM.isLoaded(model.mlc)) {
      patchLast({ typing: false, loading: true, loadPct: modelProgress, loadName: model.name });
      await loadModel(model);
      patchLast({ loading: false, typing: true });
    }
    const ready = !!(window.EOLLM && window.EOLLM.isLoaded(model.mlc));

    if (!doc) {
      if (ready) { runLLM(null, q); return; }
      replaceLast({ role: 'assistant', text: canLLM
        ? 'The local model isn’t ready yet. Add a document or paste some text and I’ll answer straight from it.'
        : 'This browser doesn’t support WebGPU, so the local model can’t run here. Add a document or paste text and I’ll still answer from it, with citations.', audit: null });
      setBusy(false); return;
    }
    const useLLM = ready && (doc.kind === 'prose');
    if (mode === 'creative' && !ready) { replaceLast({ role: 'assistant', text: 'Creative mode needs the local model, which isn’t available here. Grounded answers still work.', audit: null }); setBusy(false); return; }
    if (useLLM) runLLM(doc, q);
    else runMechanical(doc, q);
  };

  const newChat = () => { setMessages([]); setActiveChat('new'); };
  const selectChat = (id) => { setActiveChat(id); };

  // ---- rules ----
  const toggleRule = (id) => setRules(rs => rs.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  const installRule = (id) => {
    setRules(rs => rs.map(r => r.id === id ? { ...r, installed: !r.installed, enabled: !r.installed } : r));
    const r = rules.find(x => x.id === id); showToast(r.installed ? r.name + ' removed' : r.name + ' installed and enabled');
  };
  const importRules = (newRules) => setRules(rs => {
    const ids = new Set(rs.map(r => r.id));
    const add = newRules.filter(r => !ids.has(r.id));
    const upd = rs.map(r => { const n = newRules.find(x => x.id === r.id); return n ? { ...r, ...n } : r; });
    return [...upd, ...add];
  });

  // ---- drag-drop: counter so the veil can't get stuck; global reset ----
  const onDragEnter = (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragCount.current++; setDragOver(true);
  };
  const onDragOverApp = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); };
  const onDragLeaveApp = () => { dragCount.current = Math.max(0, dragCount.current - 1); if (dragCount.current === 0) setDragOver(false); };
  const onDropApp = (e) => { e.preventDefault(); dragCount.current = 0; setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); };
  useEffect(() => {
    const clear = () => { dragCount.current = 0; setDragOver(false); };
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear); window.removeEventListener('blur', clear); };
  }, []);

  // ---- divider drag ----
  useEffect(() => {
    if (!dragging) return;
    const move = (e) => { const rect = bodyRef.current.getBoundingClientRect(); let r = (e.clientX - rect.left) / rect.width; setSplitRatio(Math.max(0.28, Math.min(0.72, r))); };
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [dragging]);

  const composerProps = {
    value: input, onChange: setInput, onSend: () => send(), mode, onMode: setMode,
    onAttach: () => fileRef.current.click(), busy,
  };

  const hasTabs = openTabs.length > 0;
  const showHero = !hasTabs && messages.length === 0;
  const enabledRules = rules.filter(r => r.installed && r.enabled).length;
  const chatTitle = activeChat === 'new' ? 'New chat' : (chats.find(c => c.id === activeChat)?.title || 'Chat');
  const showChat = layout !== 'doc';
  const showDocPane = hasTabs && layout !== 'chat';

  return (
    <div className="app"
         onDragEnter={onDragEnter} onDragOver={onDragOverApp} onDragLeave={onDragLeaveApp} onDrop={onDropApp}>
      <input ref={fileRef} type="file" accept=".txt,.md,.csv,.tsv,text/plain" multiple style={{ display: 'none' }}
             onChange={e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; }} />

      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(c => !c)}
        docs={docs} openTabs={openTabs} activeDoc={activeTab} onOpenDoc={openTab}
        chats={chats} activeChat={activeChat} onNewChat={newChat} onSelectChat={selectChat}
        model={model} onModelClick={() => setModelOpen(o => !o)} onRulesClick={() => setRulesOpen(true)}
        enabledRules={enabledRules} modelStatus={modelStatus} />

      <div className="workspace">
        <div className="topbar">
          {collapsed && <button className="tb-btn" onClick={() => setCollapsed(false)} title="Show sidebar"><Icon name="sidebar" size={18} /></button>}
          <div className="tb-title">{chatTitle}{hasTabs && <span className="sub">· {docs.length} document{docs.length > 1 ? 's' : ''}</span>}</div>
          <div className="tb-spacer" />
          {hasTabs && (
            <div className="view-seg topbar-seg">
              <button className={layout === 'chat' ? 'on' : ''} onClick={() => setLayout('chat')} title="Fullscreen chat"><Icon name="read" size={14} /></button>
              <button className={layout === 'split' ? 'on' : ''} onClick={() => setLayout('split')} title="Split"><Icon name="sidebar" size={14} /></button>
              <button className={layout === 'doc' ? 'on' : ''} onClick={() => setLayout('doc')} title="Fullscreen document"><Icon name="expand" size={14} /></button>
            </div>
          )}
          <button className="tb-pill" onClick={() => setRulesOpen(true)}><Icon name="layers" size={15} /> {enabledRules} rules on</button>
        </div>

        <div className="body" ref={bodyRef}>
          {showHero ? (
            <div className="pane-chat" style={{ flex: 1 }}>
              <Hero composerProps={composerProps} onAttach={() => fileRef.current.click()} onExample={onExample} dragOver={dragOver} />
            </div>
          ) : (
            <React.Fragment>
              {showChat && (
                <div style={{ flexBasis: showDocPane ? (splitRatio * 100) + '%' : '100%', flexGrow: showDocPane ? 0 : 1, flexShrink: 0, display: 'flex', minWidth: 0 }}>
                  <ChatPane messages={messages} onCite={flashCitation} composerProps={composerProps} narrow={showDocPane} wide={layout === 'chat'} />
                </div>
              )}
              {showDocPane && showChat && <div className={'divider' + (dragging ? ' dragging' : '')} onMouseDown={() => setDragging(true)} />}
              {showDocPane && (
                <DocPane openTabs={openTabs} activeTab={activeTab} docsById={docsById}
                  onActivate={setActiveTab} onClose={closeTab} layout={layout} onLayout={setLayout}
                  explore={explore} onToggleExplore={() => setExplore(x => !x)}
                  onEntity={onEntity} activeEntity={activeEntity} flashSent={flashSent} onCite={flashCitation} tableSpec={tableSpec} />
              )}
            </React.Fragment>
          )}
        </div>
      </div>

      {rulesOpen && <RulesDrawer rules={rules} onToggle={toggleRule} onInstall={installRule} onImport={importRules} onClose={() => setRulesOpen(false)} onToast={showToast} />}
      {modelOpen && <ModelPopover models={window.MODELS} current={model} onPick={pickModel} onClose={() => setModelOpen(false)} anchor={{ left: 16, bottom: 64 }}
                     status={modelStatus} progress={modelProgress} />}
      {entityModal && (() => { const d = docsById[entityModal.docId]; return d ? (
        <EntityModal doc={d} name={entityModal.name} onCite={flashCitation} onEntity={(n) => setEntityModal({ docId: d.id, name: n })}
          onOpenTab={openEntityTab} onClose={() => setEntityModal(null)} />
      ) : null; })()}
      {dragOver && <div className="drop-veil"><div className="drop-card"><Icon name="upload" size={26} /> Drop to read</div></div>}
      {toast && <div className="toast"><span className="tk"><Icon name="check" size={15} /></span>{toast}</div>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
