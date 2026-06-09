/* ============================================================
   App — wires the real engine: upload/paste → parse → explore + chat.
   Mechanical grounded answers always work; the local LLM (if loaded)
   only phrases them, citations bound mechanically either way.
   ============================================================ */
const { useState, useEffect, useRef, useCallback, useMemo } = React;
// Diagnostics flag (§5): set window.EO_DEBUG = true in the console to surface
// the errors that are otherwise swallowed by resilience catches. Off by default
// so a normal session stays quiet, but failures become diagnosable on demand.
if (typeof window !== 'undefined' && window.EO_DEBUG === undefined) window.EO_DEBUG = false;
const eoWarn = (...a) => { if (typeof window !== 'undefined' && window.EO_DEBUG) console.warn('[Cleon]', ...a); };
if (typeof window !== 'undefined') window.eoWarn = eoWarn;

// Audit log shim — records the chat pipeline when window.EOAudit is present,
// and no-ops cleanly when it isn't. Keeps the call sites in the chat path terse.
const AUD = (m, ...a) => { try { const A = window.EOAudit; return A && A[m] ? A[m](...a) : undefined; } catch (e) { eoWarn('audit', m, e); } };
const auditScope = (scope) => (scope || []).map(d => ({ id: d.id, name: d.name, kind: d.kind }));
// Re-run the (deterministic, cheap) scope retrieval purely to capture the scored
// hits for the trace — the engine stays untouched, so this never changes routing.
const auditHits = (scope, q, k = 6) => {
  try {
    return (window.EOEngine.retrieveScope(scope, q, k) || [])
      .map(h => ({ docId: h.docId, idx: h.i, score: Math.round((h.score || 0) * 1e4) / 1e4, overlap: h.overlap, text: h.t }));
  } catch (e) { return []; }
};
// Catch the one failure the mechanical veto can't see: a "summary" that is just
// one source span echoed back verbatim binds and audits clean, but is not an
// answer. spanCoverage = what fraction of the DRAFT is just this SPAN — shared
// 5-gram shingles over the DRAFT's own shingles. Directional on purpose: a real
// answer that merely quotes a span scores low (most of it is the answer's own
// words), while a draft that IS the span scores ~1. The earlier min(draft, span)
// denominator broke on short spans — any retrieved line of ≤5 words is a single
// shingle, so the denominator collapsed to 1 and every grounded answer that
// quoted it read as a 1.0 "echo" and got vetoed (e.g. "[Scanned at 300dpi /
// Univ. Lib.").
const spanCoverage = (draft, span) => {
  const grams = (s) => {
    const w = String(s).toLowerCase().replace(/\{\{[^}]*\}\}/g, '').match(/[a-z0-9']+/g) || [];
    const g = new Set();
    for (let i = 0; i + 5 <= w.length; i++) g.add(w.slice(i, i + 5).join(' '));
    if (!g.size && w.length) g.add(w.join(' '));   // short text: whole-string gram
    return g;
  };
  const gd = grams(draft), gs = grams(span);
  if (!gd.size || !gs.size) return 0;
  let shared = 0; for (const x of gd) if (gs.has(x)) shared++;
  return shared / gd.size;
};
// Is `text` essentially a copy of one of the retrieved spans? (the degenerate
// echo). Threshold mirrors the old sentinel_draft_overlap (0.82).
const echoesASpan = (scope, q, text, k = 6) => {
  try {
    const hits = window.EOEngine.retrieveScope(scope, q, k) || [];
    return hits.some(h => spanCoverage(text, h.t) >= 0.82);
  } catch (e) { return false; }
};

let _uid = 0; const uid = (p) => p + '-' + (++_uid);
// After restoring persisted docs/chats, advance the uid counter past every
// restored id so a new upload this session can't collide with a stored one.
const bumpUid = (ids) => { for (const id of (ids || [])) { const m = String(id).match(/-(\d+)$/); if (m) _uid = Math.max(_uid, parseInt(m[1], 10)); } };

// Which local model to start on. The 0.5B is a fine phone default — small
// download, runs anywhere — but on a desktop it's too small to phrase well, so
// default desktops to the 1.5B "balanced" model. Either can be switched live
// from the picker; switching now releases the old model before loading the new.
const defaultModel = () => {
  const by = (id) => window.MODELS.find(m => m.id === id);
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;
  return (phone ? by('qwen-05') : by('qwen-15')) || window.MODELS[0];
};

// Human-readable label for an ingest phase. The phases are the medium's own
// ontology: existence (the text and its sentences come to be) → structure (the
// reading that relates them) → significance (projecting what matters).
const INGEST_LABEL = {
  loading: 'Loading into memory',
  segmenting: 'Splitting into sentences',
  reading: 'Reading the structure',
  projecting: 'Weighing what matters',
};

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [docs, setDocs] = useState([]);
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState('new');
  const [messages, setMessages] = useState([]);
  // The conversation's SOURCE SET: docIds the chat grounds against, shown as
  // chips. Added intentionally (on upload, via the + menu, or by a project), not
  // just by being the focused tab. Empty falls back to the active doc.
  const [sources, setSources] = useState([]);
  // Projects are named, persistent source sets. Selecting one loads its docs as
  // the scope; editing the scope while a project is active updates the project.
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('auto');
  // Thinking depth: the effort dial (1 = reflex/today … 3 = deepest). Persisted in
  // prefs. Level 1 resolves every depth knob to its inert floor, so it is
  // byte-identical to current Cleon — the parity floor. Mirrored into a ref for
  // the async settle paths, and the turn's resolved budget into another.
  const [depth, setDepth] = useState(1);
  const depthRef = useRef(1); depthRef.current = depth;
  const turnBudgetRef = useRef(null);
  // This turn's associative links (Phase 3) — read by the inference void (Phase 4).
  const turnAssocRef = useRef([]);
  const [busy, setBusy] = useState(false);

  const [rules, setRules] = useState(window.RULESETS.map(r => ({ ...r })));
  // Per-language reading mode: { en:'original'|'learning', … }. Empty/missing
  // means Self-learning (the shipped, adaptive behavior). Persisted with prefs.
  const [langModes, setLangModes] = useState({});
  const [rulesOpen, setRulesOpen] = useState(false);
  // Auditing mode: a glass box over the chat pipeline (window.EOAudit), inspected
  // in a drawer and exportable as JSONL. Recording is on by default.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditEnabled, setAuditEnabled] = useState(() => (window.EOAudit ? window.EOAudit.isEnabled() : true));
  const [auditCount, setAuditCount] = useState(0);
  // Glass-box export toggles: include the extraction half (graph + processing)
  // and/or the chat half (audit turns). Persisted with prefs. Both on by default.
  const [exportIngestion, setExportIngestion] = useState(true);
  const [exportOutput, setExportOutput] = useState(true);
  const [model, setModel] = useState(defaultModel);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelStatus, setModelStatus] = useState('idle'); // idle | loading | ready
  const [modelProgress, setModelProgress] = useState(0);
  // Staged-ingest progress: null when idle, else { phase, stage, pct, name }.
  const [ingestStatus, setIngestStatus] = useState(null);

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
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const mobileRef = useRef(isMobile);
  mobileRef.current = isMobile;
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);
  const bodyRef = useRef(null);
  const fileRef = useRef(null);
  const dragCount = useRef(0);

  const docsById = useMemo(() => Object.fromEntries(docs.map(d => [d.id, d])), [docs]);
  const docsRef = useRef(docs); docsRef.current = docs;
  const flashTimer = useRef(null);
  // Did the previous turn route to the document? Feeds conversation continuity so
  // an anaphoric follow-up ("tell me more about it") stays on the page.
  const lastGroundedRef = useRef(false);
  // Local persistence: `hydrated` gates the save effects so the initial empty
  // state can't overwrite stored data before it's read back; `suppressReparse`
  // lets hydration set the restored rule toggles without re-parsing the docs we
  // just restored (which would also double-count the engine's learning).
  const hydrated = useRef(false);
  const suppressReparse = useRef(false);
  // Monotonic token so a fresh ingest / rule re-parse supersedes an in-flight
  // one instead of two heavy parses fighting over the heap at once.
  const ingestTok = useRef(0);

  // Push rule changes into the engine, then re-parse open docs so
  // extraction-phase rules (δ, two-sighting, the anaphora discount and
  // pronoun gate) take effect — those decisions are baked into the event
  // log at parse time. Replay-phase rules re-derive on the next projection.
  const firstRules = useRef(true);
  useEffect(() => {
    window.EO_RULES = rules;
    if (window.EOEngine && window.EOEngine.applyRules) window.EOEngine.applyRules(rules);
    // Push per-language modes too: Original freezes a language to its shipped
    // baseline. Like extraction rules, this is a parse-time decision, so the
    // re-parse below makes a mode flip take effect on already-open documents.
    if (window.EOEngine && window.EOEngine.setLanguageModes) window.EOEngine.setLanguageModes(langModes);
    if (firstRules.current) { firstRules.current = false; return; } // no docs at mount
    // Hydration restored these toggles; the restored docs already reflect them,
    // so push the rules to the engine (above) but skip the re-parse. (§3)
    if (suppressReparse.current) { suppressReparse.current = false; return; }
    // Re-read open docs under the new rules, staged like a fresh ingest and one
    // document at a time, so toggling a rule on a long document doesn't freeze.
    const targets = docsRef.current.filter(d => d._text != null);
    if (!targets.length) return;
    const tok = ++ingestTok.current;
    (async () => {
      setBusy(true);
      for (const d of targets) {
        if (tok !== ingestTok.current) break;          // superseded by a newer parse
        setIngestStatus({ phase: 'structure', stage: 'reading', pct: 0, name: d.name });
        let nd;
        try {
          nd = await window.EOEngine.parseDocument(d._name || d.name, d._text, d.id, (p) => {
            if (tok !== ingestTok.current) return;
            setIngestStatus({ phase: p.phase, stage: p.stage, pct: p.total ? p.done / p.total : null, name: d.name });
          });
        } catch (e) { eoWarn('re-parse failed for', d.name, e); continue; }
        if (tok !== ingestTok.current) break;
        setDocs(ds => ds.map(x => x.id === nd.id ? nd : x));
      }
      if (tok === ingestTok.current) { setIngestStatus(null); setBusy(false); }
    })();
  }, [rules, langModes]);

  // ---- local persistence (§3): rehydrate on load, then save on change. ----
  // Documents, the running chat, rule toggles, UI prefs, and the engine's
  // induced learning all live on the device so a refresh doesn't wipe the
  // workspace. Everything is best-effort — storage may be unavailable.
  useEffect(() => {
    if (!window.EOStore) { hydrated.current = true; return; }
    let cancelled = false;
    // Persist the engine's learned rules-ledger delta whenever it grows.
    window.EO_onLedgerChange = (events) => { try { window.EOStore.saveLedger(events); } catch (e) {} };
    (async () => {
      // Restore learning BEFORE any document is parsed this session, so the
      // induced reading rules carry over instead of starting cold.
      try {
        const led = window.EOStore.loadLedger();
        if (led.length && window.EOEngine && window.EOEngine._restoreLedger) window.EOEngine._restoreLedger(led);
      } catch (e) {}

      const prefs = window.EOStore.loadPrefs();
      if (prefs && !cancelled) {
        if (Array.isArray(prefs.rules) && prefs.rules.length) {
          suppressReparse.current = true;
          setRules(rs => rs.map(r => { const p = prefs.rules.find(x => x.id === r.id); return p ? { ...r, ...p } : r; }));
        }
        if (prefs.modelId) { const m = window.MODELS.find(x => x.id === prefs.modelId); if (m) setModel(m); }
        if (Array.isArray(prefs.projects)) { setProjects(prefs.projects); bumpUid(prefs.projects.map(p => p.id)); }
        if (prefs.activeProject) setActiveProject(prefs.activeProject);
        if (prefs.mode) setMode(prefs.mode);
        if (typeof prefs.depth === 'number') setDepth(prefs.depth);
        if (typeof prefs.splitRatio === 'number') setSplitRatio(prefs.splitRatio);
        if (typeof prefs.explore === 'boolean') setExplore(prefs.explore);
        if (typeof prefs.auditEnabled === 'boolean') { setAuditEnabled(prefs.auditEnabled); if (window.EOAudit) window.EOAudit.setEnabled(prefs.auditEnabled); }
        if (typeof prefs.exportIngestion === 'boolean') setExportIngestion(prefs.exportIngestion);
        if (typeof prefs.exportOutput === 'boolean') setExportOutput(prefs.exportOutput);
        // Restored docs were parsed under the saved modes, so suppress the
        // re-parse the same way rule toggles do (batched into one render).
        if (prefs.langModes && typeof prefs.langModes === 'object') { suppressReparse.current = true; setLangModes(prefs.langModes); }
      }

      let savedDocs = [], savedChat = null, savedAudit = [];
      try { [savedDocs, savedChat, savedAudit] = await Promise.all([window.EOStore.loadDocs(), window.EOStore.loadChat(), window.EOStore.loadAudit()]); } catch (e) {}
      if (cancelled) { hydrated.current = true; return; }
      // Restore the persisted glass-box trace (best-effort; survives reloads
      // until the user clears it).
      if (savedAudit.length && window.EOAudit && window.EOAudit.restore) { try { window.EOAudit.restore(savedAudit); } catch (e) {} }

      const docIds = new Set();
      if (savedDocs.length) { setDocs(savedDocs); savedDocs.forEach(d => docIds.add(d.id)); bumpUid(savedDocs.map(d => d.id)); }
      if (savedChat) {
        if (Array.isArray(savedChat.messages)) setMessages(savedChat.messages);
        if (Array.isArray(savedChat.chats)) { setChats(savedChat.chats); bumpUid(savedChat.chats.map(c => c.id)); }
        if (savedChat.activeChat) setActiveChat(savedChat.activeChat);
        // only re-open tabs whose backing document actually came back
        const tabOK = (id) => id.startsWith('@ent/') ? docIds.has(id.split('/')[1]) : docIds.has(id);
        if (Array.isArray(savedChat.openTabs)) setOpenTabs(savedChat.openTabs.filter(tabOK));
        if (savedChat.activeTab && tabOK(savedChat.activeTab)) setActiveTab(savedChat.activeTab);
        if (Array.isArray(savedChat.sources)) setSources(savedChat.sources.filter(id => docIds.has(id)));
        // Restore the chat's working-memory field so a reload keeps what the
        // conversation was carrying (best-effort; reset on a new/switched chat).
        if (savedChat.field && window.EOEngine && window.EOEngine.conversationField) {
          try { window.EOEngine.conversationField.restore(savedChat.field); } catch (e) {}
        }
      }
      hydrated.current = true;
    })();
    return () => { cancelled = true; window.EO_onLedgerChange = null; };
  }, []);

  useEffect(() => {
    if (!hydrated.current || !window.EOStore) return;
    const t = setTimeout(() => window.EOStore.saveDocs(docs), 450);
    return () => clearTimeout(t);
  }, [docs]);
  useEffect(() => {
    if (!hydrated.current || !window.EOStore) return;
    const t = setTimeout(() => window.EOStore.saveChat({
      messages, chats, activeChat, openTabs, activeTab, sources,
      // The conversation field (working memory) is chat-scoped: it rides in the
      // chat snapshot, NOT the cross-session learned ledger. Pointers only.
      field: (window.EOEngine && window.EOEngine.conversationField) ? window.EOEngine.conversationField.snapshot() : null,
    }), 450);
    return () => clearTimeout(t);
  }, [messages, chats, activeChat, openTabs, activeTab, sources]);
  useEffect(() => {
    if (!hydrated.current || !window.EOStore) return;
    window.EOStore.savePrefs({ rules, langModes, modelId: model.id, mode, depth, splitRatio, explore, projects, activeProject, auditEnabled, exportIngestion, exportOutput });
  }, [rules, langModes, model, mode, depth, splitRatio, explore, projects, activeProject, auditEnabled, exportIngestion, exportOutput]);
  // Persist the audit trace (debounced) on every change, so the glass box
  // survives reloads. EOAudit.clear() fires a notify too, so an intentional
  // wipe persists as empty automatically — "persist unless wiped". The
  // hydrated gate skips the save that restore() itself would trigger on load.
  useEffect(() => {
    if (!window.EOAudit || !window.EOStore) return;
    let t = null;
    const save = () => { if (!hydrated.current) return; clearTimeout(t); t = setTimeout(() => window.EOStore.saveAudit(window.EOAudit.all()), 600); };
    const off = window.EOAudit.subscribe(save);
    return () => { clearTimeout(t); off(); };
  }, []);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  // Keep the topbar's turn count in sync with the recorder. setState bails out when
  // the count is unchanged, so per-step notifications don't re-render the app.
  useEffect(() => {
    if (!window.EOAudit) return;
    const update = () => setAuditCount(window.EOAudit.count());
    update();
    return window.EOAudit.subscribe(update);
  }, []);
  const toggleAudit = (on) => {
    const v = on != null ? on : !auditEnabled;
    setAuditEnabled(v);
    if (window.EOAudit) window.EOAudit.setEnabled(v);
  };

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
  // ---- conversation scope (sources) ----
  // Editing the scope while a project is active keeps that project in sync, so a
  // project always reflects the set you're actually working with.
  const addSource = (id) => {
    setSources(s => s.includes(id) ? s : [...s, id]);
    if (activeProject) setProjects(ps => ps.map(p => p.id === activeProject && !p.docIds.includes(id) ? { ...p, docIds: [...p.docIds, id] } : p));
  };
  const removeSource = (id) => {
    setSources(s => s.filter(x => x !== id));
    if (activeProject) setProjects(ps => ps.map(p => p.id === activeProject ? { ...p, docIds: p.docIds.filter(x => x !== id) } : p));
  };
  const toggleSource = (id) => (sources.includes(id) ? removeSource : addSource)(id);
  // ---- projects (named source sets) ----
  const selectProject = (id) => {
    const p = projects.find(x => x.id === id);
    if (!p) return;
    setActiveProject(id);
    const ids = p.docIds.filter(d => docsById[d]);
    setSources(ids);
    setOpenTabs(t => { const set = new Set(t); ids.forEach(d => set.add(d)); return [...set]; });
    if (ids[0]) setActiveTab(ids[0]);
    showToast('Project “' + p.name + '” — ' + ids.length + ' source' + (ids.length !== 1 ? 's' : ''));
    if (mobileRef.current) setCollapsed(true);
  };
  const newProject = () => {
    const fallback = 'Project ' + (projects.length + 1);
    const name = ((window.prompt && window.prompt('Name this project', fallback)) || '').trim() || fallback;
    const id = uid('p');
    setProjects(ps => [{ id, name, docIds: sources.slice() }, ...ps]);
    setActiveProject(id);
    showToast('Created project “' + name + '”');
  };
  const deleteProject = (id) => {
    setProjects(ps => ps.filter(p => p.id !== id));
    if (activeProject === id) setActiveProject(null);
  };
  const clearProject = () => setActiveProject(null);
  // The documents the turn grounds against: the explicit source set if any,
  // otherwise the focused doc (preserves the single-doc experience).
  const scopeList = () => {
    const ds = sources.map(id => docsById[id]).filter(Boolean);
    if (ds.length) return ds;
    const b = backingDoc();
    return b ? [b] : [];
  };

  const openTab = useCallback((id) => {
    setOpenTabs(t => t.includes(id) ? t : [...t, id]);
    setActiveTab(id);
    // phones show one pane at a time: opening a doc brings it fullscreen.
    if (mobileRef.current) { setLayout('doc'); setCollapsed(true); }
    else setLayout(l => l === 'chat' ? 'split' : l);
  }, []);

  const closeTab = (id) => {
    setOpenTabs(t => {
      const next = t.filter(x => x !== id);
      if (activeTab === id) setActiveTab(next[next.length - 1] || null);
      return next;
    });
  };

  // ---- ingest ----
  // Staged so a long document can't crash the tab: existence (load → segment)
  // → structure (read) → significance (project), each phase reported and yielded
  // between chunks. The work is the same; it's just sliced so memory rises and
  // falls instead of spiking in one synchronous blast. Slower, but it finishes.
  const ingest = async (name, text) => {
    // Dedupe: the same file (same name + identical content) already loaded →
    // focus the existing tab instead of adding a second identical copy.
    const dup = docsRef.current.find(d => d.name === name && d._text === text);
    if (dup) {
      setOpenTabs(t => t.includes(dup.id) ? t : [...t, dup.id]);
      setActiveTab(dup.id); addSource(dup.id);
      showToast('“' + name + '” is already loaded.');
      return dup;
    }
    const id = uid('doc');
    const tok = ++ingestTok.current;
    setBusy(true);
    setIngestStatus({ phase: 'existence', stage: 'loading', pct: 0, name });
    let doc;
    try {
      doc = await window.EOEngine.parseDocument(name, text, id, (p) => {
        if (tok !== ingestTok.current) return;          // superseded — stop reporting
        const pct = p.total ? p.done / p.total : null;
        setIngestStatus({ phase: p.phase, stage: p.stage, pct, name });
      });
    } catch (e) {
      if (tok === ingestTok.current) { setIngestStatus(null); setBusy(false); }
      showToast('Could not read that file.'); return null;
    }
    // Always commit a new document — the user explicitly added it and nothing
    // else will reproduce it. Only the banner / busy flag belong to whichever
    // parse is newest, so a rule re-read that started meanwhile owns the UI.
    setDocs(ds => [...ds, doc]);
    setOpenTabs(t => [...t, id]); setActiveTab(id); addSource(id);
    // Stay chat-first after an upload on every device: the doc is added as a
    // tab but doesn't seize the stage. The user opens it (split on desktop,
    // fullscreen on a phone) from the view toggle when they actually want it.
    setLayout('chat');
    if (doc.kind === 'prose') setExplore(true);
    setTableSpec(null);
    showToast('Added “' + name + '” · ' + doc.meta);
    if (tok === ingestTok.current) { setIngestStatus(null); setBusy(false); }
    return doc;
  };
  // Read files into memory ONE AT A TIME, then ingest. Serial on purpose: two
  // big files decoding + parsing at once is exactly the memory spike we're
  // trying to avoid. The FileReader step is the literal "load into memory" stage.
  const handleFiles = async (fileList) => {
    const files = [...fileList];
    for (const f of files) {
      let text;
      try {
        text = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(r.error || new Error('read failed'));
          r.readAsText(f);
        });
      } catch (e) { showToast('Could not read “' + f.name + '”.'); continue; }
      await ingest(f.name, text);
    }
  };
  const onExample = (ex) => ingest(ex.name, ex.text);

  // ---- citations / entities ----
  const flashCitation = useCallback((docId, idx) => {
    setOpenTabs(t => t.includes(docId) ? t : [...t, docId]);
    setActiveTab(docId);
    // following a citation on a phone brings the document fullscreen to show it.
    if (mobileRef.current) { setLayout('doc'); setCollapsed(true); }
    else setLayout(l => l === 'chat' ? 'split' : l);
    setExplore(true);
    setFlashSent(idx);
    // The target tab may have only just mounted, so wait for the node (a few
    // frames) and bring it to the CENTRE of the doc scroller — geometry via
    // getBoundingClientRect, correct regardless of offsetParent. (Was a single
    // 90ms timeout + offsetTop-150, which often fired before paint and left the
    // cited sentence off-screen.)
    let tries = 0;
    const bring = () => {
      const node = document.getElementById('sent-' + docId + '-' + idx);
      if (!node) { if (tries++ < 20) requestAnimationFrame(bring); return; }
      const sc = node.closest('.doc-scroll');
      if (sc) {
        const top = sc.scrollTop + (node.getBoundingClientRect().top - sc.getBoundingClientRect().top) - (sc.clientHeight - node.clientHeight) / 2;
        sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } else node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    requestAnimationFrame(bring);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashSent(null), 2600);
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

  // auto-load on startup so the demo is live with the actual model. The default
  // (MODELS[0]) is the smallest, most mobile-friendly model, so it begins
  // downloading right away on phones too rather than waiting for the first turn.
  useEffect(() => {
    if (window.EOLLM && window.EOLLM.hasWebGPU()) loadModel(model);
    // Warm the structure-layer embedding reader in the background so the first
    // escalation isn't also paying the (one-time, cached) model download. Inert
    // if embed.js is absent or the model fails to load — routing stays lexical.
    try { if (window.EOEmbed && window.EOEmbed.warm) window.EOEmbed.warm(); } catch (e) {}
  }, []);

  // ---- responsive: collapse the sidebar to an off-canvas drawer on phones and
  // keep the body to a single pane (side-by-side split doesn't fit a phone). ----
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const apply = (matches) => {
      setIsMobile(matches);
      if (matches) { setCollapsed(true); setLayout(l => l === 'split' ? 'chat' : l); }
      else setCollapsed(false);
    };
    apply(mq.matches);
    const on = (e) => apply(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
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

  // strip citation/void markup so prior turns read as plain text in history
  const stripMarkup = (s) => String(s).replace(/\{\{(?:cite|void|infer):[^}]*\}\}/g, '').replace(/\s+([.,;:])/g, '$1').trim();
  // the running conversation, as plain {role, content} turns for the model
  const historyFor = () => messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.typing && !m.loading && m.text)
    .map(m => ({ role: m.role, content: stripMarkup(m.text) }));

  const streamInto = (patch) => (d) => setMessages(m => {
    const c = m.slice(); const prev = c[c.length - 1];
    // Spread `prev` first so streaming a token never drops fields already on the
    // message (auditId, mode, audit); the explicit keys and caller patch win.
    c[c.length - 1] = { ...prev, role: 'assistant', text: (prev.text || '') + d, streaming: true, ...patch };
    return c;
  });

  // Deposit a settled, document-grounded turn into the conversation field
  // (working memory): warm the entities it named and the sentences it cited, so
  // the NEXT turn can carry them forward. Always runs (depth-independent); what
  // the depth dial governs is how much of the field is read back into a prompt.
  const depositSettled = (scope, q, cites) => {
    const F = window.EOEngine && window.EOEngine.conversationField;
    if (!F) return;
    let matter = [];
    try { matter = (window.EOEngine.referentsScope(scope, q) || {}).matter || []; } catch (e) {}
    try { F.deposit({ entities: matter, sentences: (cites || []).map(c => ({ docId: c.docId, idx: c.idx })) }, 1); }
    catch (e) { eoWarn('field deposit', e); }
  };

  // Build the heat-ranked working memory carried INTO this turn from the
  // (already-decayed, pre-deposit) field, and record it as a `working-memory`
  // audit step. Legible-THAT: the step shows the carried hot/warm/cold subgraph,
  // never a claim about why the field linked things. Null at the dial's floor
  // (∞ heat floor) — the prompt then takes today's exact path (parity).
  const buildWMForTurn = (scope, q) => {
    const E = window.EOEngine, budget = turnBudgetRef.current;
    if (!E || !E.buildWorkingMemory || !E.conversationField || !budget || !isFinite(budget.wmHeatFloor)) return null;
    let wm;
    try { wm = E.buildWorkingMemory(scope, E.conversationField, budget, q); } catch (e) { eoWarn('buildWorkingMemory', e); return null; }
    if (!wm || !(wm.hot.length || wm.warm.length || wm.cold.length || wm.recalled.length)) return null;
    try {
      AUD('step', 'working-memory', {
        depth: budget.level, heatFloor: budget.wmHeatFloor,
        hot: wm.hot.map(h => ({ label: h.entity, heat: h.heat, sents: (h.sents || []).length })),
        warm: wm.warm.map(w => ({ label: w.entity, via: w.oneHopFrom })),
        cold: wm.cold.map(c => ({ label: c.label, range: c.sentRange })),
        recalled: (wm.recalled || []).map(r => ({ docId: r.docId, i: r.i })),
      });
    } catch (e) { eoWarn('working-memory step', e); }
    return wm;
  };

  // Iterative seeking (depth > 1): after the base retrieval, keep sub-querying on
  // the query clusters the support hasn't covered yet — bounded by the budget's
  // max seek rounds, and stopping early when a round's novelty falls below the
  // floor (delta by another name: keep going only while the pull is real). Each
  // extra round is its own numbered `retrieve` audit step. At the floor this is
  // never reached (maxSeekRounds 1); the caller uses today's contextScope.
  const seekContext = (scope, q, budget) => {
    const E = window.EOEngine, k = 6, r4 = (x) => Math.round((x || 0) * 1e4) / 1e4;
    const chosen = new Map();
    const add = (hs) => { for (const h of (hs || [])) { const key = h.docId + ':' + h.i; if (!chosen.has(key)) chosen.set(key, h); } };
    try { add(E.retrieveScope(scope, q, k)); } catch (e) { eoWarn('seek base', e); }
    // Round 1 is already recorded by the caller's model-context retrieve step.
    let matter = []; try { matter = (E.referentsScope(scope, q) || {}).matter || []; } catch (e) {}
    const support = () => [...chosen.values()].map(h => h.t).join(' ');
    let gaps = E.coverageGaps(q, support());
    let prevN = gaps.n;
    for (let r = 2; r <= budget.maxSeekRounds; r++) {
      if (!gaps.uncovered.length) break;                         // fully covered — nothing left to seek
      const subq = gaps.uncovered.concat(matter).join(' ');
      let more = []; try { more = E.retrieveScope(scope, subq, k); } catch (e) { break; }
      const before = chosen.size;
      add(more);
      const g2 = E.coverageGaps(q, support());
      const novelty = r4((g2.n - prevN) / (gaps.d || 1));        // fraction of NEW query terms this round covered
      AUD('step', 'retrieve', { round: r, k, engine: 'seek', subquery: subq, novelty,
        covered: g2.n + '/' + g2.d, newHits: chosen.size - before,
        hits: (more || []).slice(0, 6).map(h => ({ docId: h.docId, idx: h.i, score: r4(h.score), text: h.t })) });
      prevN = g2.n; gaps = g2;
      if (chosen.size === before) break;                         // nothing new came back
      if (novelty < budget.seekNoveltyFloor) break;              // the pull is too weak to justify another round
    }
    const top = [...chosen.values()].sort((a, b) => b.score - a.score).slice(0, 10);
    try { return E.contextFromHits(scope, top); } catch (e) { return E.contextScope(scope, q, k); }
  };

  // Phase 3: associative wandering (deepest depth, embedder-backed). From the
  // spans the answer is built on, find embedding-near sentences the page never
  // lexically connects, delta-gate them against the doc's own gravity, warm the
  // survivors by association (the field, for the next turn's working memory, and
  // this turn's context), and log each deposit as an `associate` step — legible
  // THAT the field linked them, never the geometry of why. No embedder => no-op.
  const augmentByAssociation = async (scope, q, ctx, budget) => {
    const E = window.EOEngine;
    try {
      const prim = E.routePrimary(scope, q) || scope[0];
      if (!prim || prim.kind !== 'prose' || !E.associativeNeighbors) return ctx;
      const srcSpans = (E.retrieveScope([prim], q, 6) || []).map(h => h.i);
      if (!srcSpans.length) return ctx;
      const neigh = await E.associativeNeighbors(prim, srcSpans, budget, 5);
      const kept = (neigh || []).filter(n => n.clearedDelta);
      if (!kept.length) return ctx;
      const from = srcSpans.slice(0, 3).map(i => 's' + i);
      const links = [];
      for (const n of kept) {
        try { E.conversationField && E.conversationField.deposit({ sentences: [{ docId: prim.id, idx: n.i }] }, budget.assocCoupling); } catch (e) {}
        AUD('step', 'associate', { from, to: 's' + n.i, coupling: budget.assocCoupling, sim: n.sim, clearedDelta: true });
        links.push({ docId: prim.id, from: srcSpans.slice(0, 3), to: n.i, sim: n.sim });
      }
      turnAssocRef.current = links;                       // hand the links to the inference void (Phase 4)
      return ctx + '\n' + kept.map(n => `[${prim.id}:${n.i}] ${n.t}`).join('\n');
    } catch (e) { eoWarn('associate', e); return ctx; }
  };

  // Phase 4: the inference void. If a model answer cited BOTH ends of an
  // associative link (Phase 3) that cleared the inference floor, the connecting
  // claim was the reader's inference, not the page's statement — mark it
  // {{infer:…}} and badge the answer `inferred` (a third status between grounded
  // and held). Gated by the inference-void rule + a finite floor (deepest depth)
  // + links present, so it never fires at the floor or without an embedder.
  const inferRuleOn = () => rules.some(r => r.id === 'inference-void' && r.installed && r.enabled);
  const markInferences = (res, budget) => {
    const E = window.EOEngine;
    if (!E || !E.markInferred || !res || !budget || !isFinite(budget.inferBindFloor) || !inferRuleOn()) return res;
    const links = turnAssocRef.current || [];
    if (!links.length) return res;
    const pairs = [];
    for (const lk of links) { if (lk.sim >= budget.inferBindFloor) for (const a of (lk.from || [])) pairs.push({ docId: lk.docId, a, b: lk.to }); }
    if (!pairs.length) return res;
    let marked; try { marked = E.markInferred(res.text, pairs); } catch (e) { return res; }
    if (!marked.inferred.length) return res;
    const label = marked.inferred.map(p => '[s' + p.a + '] and [s' + p.b + ']').join(', ');
    AUD('step', 'infer', { pairs: marked.inferred, floor: budget.inferBindFloor });
    return { ...res, text: marked.text, audit: { ...res.audit, status: 'inferred',
      note: 'Inferred via association between ' + label + ' — the field linked them, the page never stated the connection.' } };
  };

  // Phase 6: the legibility boundary marker. When a kept model answer relates
  // DISTANT cited spans into a claim and no mechanical/embedding step (an
  // inference, an association) explains the bridge, that last step is the model's
  // own reasoning — and the glass box can show what it drew on, not how it
  // crossed. Emit a quiet `opaque` step: the void applied to the instrument
  // itself. Rare and honest (gated by a thinking depth + a real span gap), never
  // decorative; at the floor the trace is unchanged.
  const OPAQUE_SPAN_GAP = 4;
  const noteOpaque = (res, decision) => {
    const budget = turnBudgetRef.current;
    if (!budget || budget.level <= 1) return;
    if (!decision || decision.indexOf('model') !== 0) return;
    if (!res || !res.audit || !res.audit.grounded || res.audit.status === 'inferred') return;
    const idxs = [...new Set((res.cites || []).map(c => c.idx))];
    if (idxs.length < 2) return;
    const lo = Math.min(...idxs), hi = Math.max(...idxs);
    if (hi - lo < OPAQUE_SPAN_GAP) return;               // adjacent spans: an ordinary local synthesis
    AUD('step', 'opaque', { spans: idxs, note: 'The phrasing related distant passages [s' + lo + '…s' + hi + '] into one claim — the trace can show what it drew on, not how it bridged them. That last step is the model\'s.' });
  };

  const runMechanicalScope = (scope, q) => {
    // Capture the deterministic basis of the answer for the trace: intent, the
    // matter/anti-matter referents, and the scored retrieval hits.
    let intent = null, refs = null;
    try { intent = window.EOEngine.classifyIntent(q); } catch (e) {}
    try { refs = window.EOEngine.referentsScope(scope, q); } catch (e) {}
    AUD('step', 'intent', { intent });
    if (refs) AUD('step', 'referents', { matter: refs.matter, antimatter: refs.antimatter });
    AUD('step', 'retrieve', { k: 6, engine: 'mechanical', hits: auditHits(scope, q, 6) });
    const plan = window.EOEngine.answerScope(scope, q);
    const primary = window.EOEngine.routePrimary(scope, q) || scope[0];
    replaceLast({ role: 'assistant', text: plan.text, audit: plan.audit, mode: mode === 'creative' ? 'creative' : 'grounded' });
    if (plan.tableSpec && primary) { openTab(primary.id); setTableSpec({ ...plan.tableSpec }); }
    if (plan.cites && plan.cites.length) setTimeout(() => flashCitation(plan.cites[0].docId, plan.cites[0].idx), 380);
    depositSettled(scope, q, plan.cites);
    AUD('end', { engine: 'mechanical', text: plan.text, audit: plan.audit, cites: plan.cites || [], tableSpec: plan.tableSpec || null });
    setBusy(false);
  };

  // Plain conversation with the model — multi-turn, no document forced in,
  // no citations. This is the default; it should feel like a simple chat app.
  // When a document IS open, the answer carries an explicit "not grounded"
  // audit so it can never be mistaken for a cited, document-drawn answer —
  // the app's whole promise is that grounded and ungrounded look different. (1b)
  const runChat = async (q, history, modeTag, ctx, docOpen) => {
    const ungroundedAudit = docOpen
      ? { status: 'plain', grounded: false, note: 'Answered from the model’s general knowledge — not drawn from the open document.' }
      : null;
    const attempt = (hist, budget) => window.EOLLM.phrase({
      mlcKey: model.mlc, question: q, history: hist, contextText: ctx || '',
      mode: modeTag === 'creative' ? 'creative' : 'chat',
      grounded: false, budget, onToken: streamInto({ mode: modeTag }),
    });
    try {
      replaceLast({ role: 'assistant', text: '', mode: modeTag, streaming: true });
      let full;
      try {
        full = await attempt(history, undefined);
      } catch (e1) {
        // Most local-model failures mid-session are context / VRAM pressure,
        // not bad input. Retry once with just the last couple of turns and a
        // tight budget before giving up — recovers the common case silently.
        AUD('step', 'error', { where: 'chat', attempt: 1, message: String((e1 && e1.message) || e1) });
        replaceLast({ role: 'assistant', text: '', mode: modeTag, streaming: true });
        full = await attempt(history.slice(-2), 2200);
      }
      replaceLast({ role: 'assistant', text: full, audit: ungroundedAudit, mode: modeTag });
      AUD('end', { engine: 'model', text: full, audit: ungroundedAudit, cites: [] });
    } catch (e) {
      const msg = 'I couldn’t finish that one locally — the model likely ran out of memory or context. Try a shorter message, pick a smaller model from the switcher, or ask about an open document and I’ll answer it mechanically.';
      replaceLast({ role: 'assistant', text: msg, audit: null });
      AUD('step', 'error', { where: 'chat', fatal: true, message: String((e && e.message) || e) });
      AUD('end', { engine: 'none', text: msg, audit: null, reason: 'model-failed' });
    }
    setBusy(false);
  };

  // Document-referencing turn: feed the model the relevant passages and bind
  // citations mechanically. The seeker still decides what's there to say —
  // "who" is exact-mechanical; no ground → honest hold; the model only phrases.
  const runGroundedScope = async (scope, q, history, semanticHits) => {
    const intent = window.EOEngine.classifyIntent(q);
    AUD('step', 'intent', { intent });
    if (intent === 'who') { AUD('step', 'route', { detour: 'who → mechanical' }); runMechanicalScope(scope, q); return; }
    // Semantic recall already located the material → trust it for ground; else the
    // usual lexical hasGround check decides whether the page can answer.
    const hasSemantic = !!(semanticHits && semanticHits.length);
    const perDocGround = scope.map(d => ({ id: d.id, name: d.name, has: window.EOEngine.hasGround(d, q) }));
    const grounded = hasSemantic || perDocGround.some(d => d.has);
    AUD('step', 'ground', { hasGround: grounded, perDoc: perDocGround, viaSemantic: hasSemantic });
    if (!grounded) { AUD('step', 'route', { detour: 'no-ground → mechanical' }); runMechanicalScope(scope, q); return; }
    // Context: semantically-recovered spans if we have them, else the lexical
    // scope context — but above the dial's floor, a factual ask iteratively seeks
    // the parts of the question its first retrieval didn't cover (Phase 2). At the
    // floor (maxSeekRounds 1) and for summaries/semantic recall, this is untouched.
    const budget = turnBudgetRef.current;
    const useSeek = !!(budget && budget.maxSeekRounds > 1 && !hasSemantic && intent !== 'summary');
    let ctx = hasSemantic
      ? window.EOEngine.contextFromHits(scope, semanticHits)
      : (useSeek ? seekContext(scope, q, budget) : window.EOEngine.contextScope(scope, q, 6));
    const task = intent === 'summary' ? 'summary' : 'answer';
    AUD('step', 'retrieve', { k: 6, task, engine: 'model-context', hits: auditHits(scope, q, 6) });
    // Associative wandering (Phase 3, deepest depth + embedder): warm in spans the
    // page never lexically connects. No embedder ⇒ ctx unchanged (graph-hop only).
    if (budget && budget.assocCoupling > 0 && window.EOEmbed && window.EOEmbed.ready()) {
      ctx = await augmentByAssociation(scope, q, ctx, budget);
    }
    // Heat-ranked working memory carried into the prompt (depth > 1; null at floor).
    const wm = buildWMForTurn(scope, q);
    try {
      replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
      let full = await window.EOLLM.phrase({
        mlcKey: model.mlc, question: q, contextText: ctx, history, mode: 'grounded', task,
        grounded: true, onToken: streamInto({ mode: 'grounded' }), workingMemory: wm,
      });
      full = window.EOEngine.dedupeSentences(full);   // small models loop; drop repeats
      // Reconsideration (Phase 5, deepest depth): a refused summary is not a
      // summary — SEG the plan and re-route to free composition rather than
      // recycling the refusal. One re-plan per turn (mirrors the echo-veto).
      // (the model is necessarily ready here — phrase() above just succeeded)
      if (budget && budget.replan && task === 'summary' &&
          window.EOEngine.looksRefused && window.EOEngine.looksRefused(full)) {
        AUD('step', 'plan-seg', { from: 'grounded-summary', to: 'creative', reason: 'the model refused the summary' });
        lastGroundedRef.current = false;
        runChat(q, history, 'creative', ctx, true);
        return;
      }
      const settle = (res, decision) => {
        // Only a model-phrased answer can carry an inference void; a mechanical
        // fallback states only what the page does.
        if (decision && decision.indexOf('model') === 0) res = markInferences(res, budget);
        replaceLast({ role: 'assistant', text: res.text, audit: res.audit, mode: 'grounded' });
        if (res.cites && res.cites.length) setTimeout(() => flashCitation(res.cites[0].docId, res.cites[0].idx), 380);
        depositSettled(scope, q, res.cites);
        noteOpaque(res, decision);                        // edge-of-trace marker (Phase 6)
        AUD('end', { engine: decision, text: res.text, audit: res.audit, cites: res.cites || [] });
      };
      if (/passages?\s+do\s?n.?t\s+say/i.test(full) || full.trim().length < 3) {
        AUD('step', 'veto', { decision: 'mechanical', reason: 'model declined / empty' });
        settle(window.EOEngine.answerScope(scope, q), 'mechanical (model declined)');
      } else {
        // DEGENERACY VETO (audit-reject retry, ported from eo-extractor.html):
        // a near-verbatim copy of one retrieved span binds and audits clean but
        // is not an answer — the failure the grounding checks can't see. Reject
        // once, re-prompt the model under a stricter rule, and only then fall to
        // the mechanical answer. Mainly bites summaries on a small model.
        if (echoesASpan(scope, q, full)) {
          AUD('step', 'veto', { decision: 'reject', reason: 'echoes a single span — retrying under a stricter rule' });
          let stricter = ctx + '\n\nDo NOT copy or lightly reword any single passage. Compose a fresh ' +
            (task === 'summary' ? 'summary that synthesizes across the passages in your own words.' : 'answer in your own words.');
          // Reconsideration (Phase 5, deepest depth): retry via the GAP, not just
          // "stricter" — find what the question still doesn't cover and re-retrieve
          // on it, so the second pass has new material rather than the same spans.
          if (budget && budget.replan) {
            try {
              const gaps = window.EOEngine.coverageGaps(q, ctx);
              if (gaps.uncovered.length) {
                const more = window.EOEngine.retrieveScope(scope, gaps.uncovered.join(' '), 4) || [];
                if (more.length) {
                  stricter += '\n' + window.EOEngine.contextFromHits(scope, more);
                  AUD('step', 'plan-seg', { from: 'echo-veto', to: 'gap-retrieve', reason: 'uncovered: ' + gaps.uncovered.join(', ') });
                }
              }
            } catch (e) { eoWarn('veto-gap', e); }
          }
          let retry = '';
          try {
            replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
            retry = await window.EOLLM.phrase({
              mlcKey: model.mlc, question: q, contextText: stricter, history, mode: 'grounded', task,
              grounded: true, onToken: streamInto({ mode: 'grounded' }), workingMemory: wm,
            });
            retry = window.EOEngine.dedupeSentences(retry);
          } catch (e) { retry = ''; }
          // If the retry still echoes (or came back empty), the model can't do
          // this turn — use the mechanical portrait answer, which never echoes.
          if (!retry || retry.trim().length < 3 || echoesASpan(scope, q, retry)) {
            AUD('step', 'veto', { decision: 'mechanical', reason: 'retry still echoed — using the mechanical answer' });
            settle(window.EOEngine.answerScope(scope, q), 'mechanical (echo veto)');
            setBusy(false);
            return;
          }
          full = retry;   // retry produced a real answer; fall through to bind it
        }
        // SOFTENED VETO across the whole scope. The page still overrules the
        // model, but a draft that genuinely binds is no longer thrown away whole
        // just because it named one unsupported term — that term is marked as a
        // void and the (better) phrasing is kept, badged as a caveat. Only a
        // draft that won't bind to ANY source falls back to the mechanical answer.
        const perDoc = scope.map(d => new Set(window.EOEngine.inventedTerms(d, full)));
        const invented = perDoc.length ? [...perDoc[0]].filter(t => perDoc.every(s => s.has(t))) : [];
        const bound = window.EOEngine.bindCitationsScope(scope, full, q, intent);
        if (!bound.audit.grounded) {
          // Unmoored: the phrasing matched no passage — use the mechanical answer.
          // Reconsideration (Phase 5): at the deepest depth, read a factual draft
          // that binds nothing as a question the page does not address, not a
          // failed answer — the mechanical reading surfaces that silence/void.
          if (budget && budget.replan) AUD('step', 'plan-seg', { from: 'factual', to: 'question-about-silence', reason: 'the draft bound to nothing on the page' });
          AUD('step', 'veto', { decision: 'mechanical', reason: 'unbound', invented, boundGrounded: false, boundCovers: bound.audit.covers });
          settle(window.EOEngine.answerScope(scope, q), 'mechanical (veto)');
        } else if (invented.length) {
          // Grounded, but names term(s) the page doesn't contain: KEEP the draft,
          // strike those terms as voids, downgrade the badge to an honest caveat.
          const list = invented.length > 1 ? invented.slice(0, -1).join(', ') + ' and ' + invented[invented.length - 1] : invented[0];
          const caveated = { ...bound, text: window.EOEngine.voidInvented(bound.text, invented),
            audit: { ...bound.audit, status: 'warn',
              note: `Phrased by the model and grounded in the passages, but it named ${list} — which the document doesn’t contain, shown struck as unverified.` } };
          AUD('step', 'veto', { decision: 'model-caveat', invented, boundGrounded: true, boundCovers: bound.audit.covers });
          settle(caveated, 'model + caveat');
        } else {
          AUD('step', 'veto', { decision: 'model', invented: [], boundGrounded: true, boundCovers: bound.audit.covers });
          settle(bound, 'model + mechanical cite');
        }
      }
    } catch (e) { AUD('step', 'error', { where: 'grounded', message: String((e && e.message) || e) }); runMechanicalScope(scope, q); return; }
    setBusy(false);
  };

  const send = async (text) => {
    const q = (text != null ? text : input).trim();
    if (!q || busy) return;
    setInput('');

    // hero: a long paste with no doc is a document to read, not a question
    const noDocs = docs.length === 0;
    if (noDocs && (q.length > 140 || /\n/.test(q))) { ingest('Pasted text.txt', q); return; }

    const history = historyFor();
    setMessages(m => [...m, { role: 'user', text: q }, { role: 'assistant', typing: true }]);
    setBusy(true); ensureChat(q);

    const doc = backingDoc();
    const scope = scopeList();   // explicit source chips, else the focused doc
    const canLLM = !!(window.EOLLM && window.EOLLM.hasWebGPU());
    const wasLoaded = canLLM && window.EOLLM.isLoaded(model.mlc);

    // Thinking depth → this turn's budget (inert at depth 1). Decay the
    // conversation field one tick of conversational time at turn start, before
    // this turn deposits into it — recent topics stay warm, dropped ones cool.
    const budget = (window.EOEngine && window.EOEngine.thinkingBudget) ? window.EOEngine.thinkingBudget(depth) : null;
    turnBudgetRef.current = budget;
    turnAssocRef.current = [];
    try { window.EOEngine && window.EOEngine.conversationField && window.EOEngine.conversationField.decayTurn(); }
    catch (e) { eoWarn('field decay', e); }

    // Open the turn's audit record before anything branches, so the routing
    // decision, model load, retrieval and the model call all attach to it.
    const auditId = AUD('begin', {
      input: q, mode, depth, budget,
      scope: auditScope(scope),
      model: { id: model.id, name: model.name, mlc: model.mlc },
      hasWebGPU: canLLM, modelLoadedAtStart: wasLoaded,
      prevGrounded: lastGroundedRef.current,
    });
    // Pin the turn's audit id to the assistant message so its inline "thinking"
    // panel can read the trace. replaceLast/patchLast/streamInto all spread the
    // prior message, so this id rides through every settle path. (null when
    // recording is paused → the panel renders nothing.)
    if (auditId) patchLast({ auditId });

    // load the real model on demand if it isn't ready yet
    if (canLLM && !wasLoaded) {
      patchLast({ typing: false, loading: true, loadPct: modelProgress, loadName: model.name });
      const ok = await loadModel(model);
      AUD('step', 'model', { action: 'load', model: model.name, ok: !!ok });
      patchLast({ loading: false, typing: true });
    }
    const ready = !!(window.EOLLM && window.EOLLM.isLoaded(model.mlc));
    AUD('set', { modelReady: ready });

    // CREATIVE: free composition (needs the model). Phrases over doc passages
    // if one is open, otherwise writes freely. Never cited.
    if (mode === 'creative') {
      if (!ready) {
        const msg = 'Creative mode needs the local model, which isn’t available here. Grounded answers from a document still work.';
        AUD('step', 'route', { path: 'creative', referencing: scope.length > 0, blocked: 'model-unavailable' });
        replaceLast({ role: 'assistant', text: msg, audit: null });
        AUD('end', { engine: 'none', text: msg, audit: null, reason: 'creative-needs-model' });
        setBusy(false); return;
      }
      lastGroundedRef.current = false;
      const ctx = scope.length ? window.EOEngine.contextScope(scope, q, 6) : '';
      AUD('step', 'route', { path: 'creative', referencing: scope.length > 0 });
      if (scope.length) AUD('step', 'retrieve', { k: 6, engine: 'creative-context', hits: auditHits(scope, q, 6) });
      runChat(q, history, 'creative', ctx, scope.length > 0); return;
    }

    // CREATIVE COMPOSITION in auto mode: "write a song/poem/story about this".
    // It references the open doc, so the cost-ordered router below would send it
    // to the grounded summary path — whose prompt only yields a 2–4 sentence
    // overview, so the model refuses ("I cannot provide a song") and recycles the
    // summary. A generative form can't be a grounded QA answer; route it to the
    // same free-composition path the Creative toggle uses, grounded on the
    // passages when a document is open. (Explicit grounded/creative modes are
    // left to their own branches.)
    if (mode === 'auto' && ready && window.EOEngine.isCreativeCompose(q)) {
      lastGroundedRef.current = false;
      const ctx = scope.length ? window.EOEngine.contextScope(scope, q, 6) : '';
      AUD('step', 'route', { path: 'creative', referencing: scope.length > 0, reason: 'creative-compose' });
      if (scope.length) AUD('step', 'retrieve', { k: 6, engine: 'creative-context', hits: auditHits(scope, q, 6) });
      runChat(q, history, 'creative', ctx, scope.length > 0); return;
    }

    // COST-ORDERED ROUTING (existence → structure → significance). The router is
    // mechanical and cheap; it returns a band. Only the 'escalate' band pays for
    // embedding recall, and only the cheap layers ever DECIDE — the model phrases.
    let route;
    if (mode === 'grounded' && scope.length) {
      route = { decision: 'mechanical', confidence: 'forced', reason: 'grounded-mode',
                primary: window.EOEngine.routePrimary(scope, q) || scope[0] };
    } else if (scope.length) {
      route = window.EOEngine.routeTurn(scope, q, { prevGrounded: lastGroundedRef.current });
    } else {
      route = { decision: 'chat', confidence: 'none', reason: 'no-scope' };
    }

    // ESCALATE: doc-directed but lexical signal was weak/absent. Pay for embedding
    // recall (degrades to lexical when no embedder). A real hit recovers the locus
    // and the turn becomes grounded; otherwise it's ordinary chat.
    let semanticHits = null;
    if (route.decision === 'escalate') {
      const { hits, reader } = await window.EOEngine.retrieveHybrid(scope, q, 6);
      const recovered = hits.length && (reader.indexOf('embedding') >= 0 ? hits.some(h => h.semantic) : true);
      AUD('step', 'escalate', { reason: route.reason, reader, found: hits.length, recovered: !!recovered });
      if (recovered) { route.decision = 'mechanical'; route.confidence = 'recovered'; semanticHits = hits.filter(h => h.semantic).length ? hits : null; route.primary = route.primary || window.EOEngine.routePrimary(scope, q) || scope[0]; }
      else { route.decision = 'chat'; }
    }

    const referencing = route.decision === 'mechanical';
    lastGroundedRef.current = referencing;

    if (referencing) {
      const primary = route.primary || window.EOEngine.routePrimary(scope, q) || scope[0];
      const useLLM = ready && primary && primary.kind === 'prose';
      AUD('step', 'route', { referencing: true, reason: route.reason, confidence: route.confidence,
        path: useLLM ? 'grounded-llm' : 'mechanical',
        primary: primary ? { id: primary.id, name: primary.name, kind: primary.kind } : null });
      if (useLLM) { runGroundedScope(scope, q, history, semanticHits); return; }
      runMechanicalScope(scope, q); return;   // tables, or no model → mechanical pivot / grounded answer
    }

    // plain chat
    AUD('step', 'route', { referencing: false, reason: route.reason, path: ready ? 'plain-chat' : 'plain-unavailable' });
    if (ready) { runChat(q, history, undefined, '', !!doc); return; }
    const msg = canLLM
      ? 'The local model isn’t ready yet — give it a moment. Meanwhile, upload a document and I can answer questions about it directly, with citations.'
      : 'This browser can’t run the local model (no WebGPU), so I can’t free-chat here. Upload a document or paste text and I’ll still answer questions about it, with citations.';
    replaceLast({ role: 'assistant', text: msg, audit: null });
    AUD('end', { engine: 'none', text: msg, audit: null, reason: canLLM ? 'model-not-ready' : 'no-webgpu' });
    setBusy(false);
  };

  // Reset the conversation field on a fresh or switched chat — working memory is
  // chat-scoped, matching newChat's reset semantics (distinct from the learned ledger).
  const resetField = () => { try { window.EOEngine && window.EOEngine.conversationField && window.EOEngine.conversationField.reset(); } catch (e) { eoWarn('field reset', e); } };
  const newChat = () => { setMessages([]); setActiveChat('new'); lastGroundedRef.current = false; resetField(); if (mobileRef.current) setCollapsed(true); };
  const selectChat = (id) => { setActiveChat(id); lastGroundedRef.current = false; resetField(); if (mobileRef.current) setCollapsed(true); };

  // ---- rules ----
  const toggleRule = (id) => setRules(rs => rs.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  const setLangMode = (lang, mode) => setLangModes(m => (m[lang] === mode ? m : { ...m, [lang]: mode }));
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
    depth, onDepth: setDepth,
    onAttach: () => fileRef.current.click(), busy,
    sources: sources.map(id => docsById[id]).filter(Boolean).map(d => ({ id: d.id, name: d.name, kind: d.kind })),
    addable: docs.filter(d => !sources.includes(d.id)).map(d => ({ id: d.id, name: d.name, kind: d.kind })),
    onAddSource: addSource, onRemoveSource: removeSource,
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
        enabledRules={enabledRules} modelStatus={modelStatus}
        projects={projects} activeProject={activeProject}
        onSelectProject={selectProject} onNewProject={newProject}
        onDeleteProject={deleteProject} onClearProject={clearProject}
        sourceIds={new Set(sources)} onToggleSource={toggleSource} />

      {isMobile && !collapsed && <div className="sb-backdrop" onClick={() => setCollapsed(true)} />}

      <main className="workspace" aria-label="Chat workspace">
        <header className="topbar">
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
          <button className="tb-pill" onClick={() => setAuditOpen(true)} title="Glass box — the extracted graph and every step the chat takes, exportable as JSONL">
            <Icon name="activity" size={15} /> Glass box{auditCount ? ' · ' + auditCount : ''}
            {auditEnabled && <span className="dot rec" title="Recording" />}
          </button>
          <button className="tb-pill" onClick={() => setRulesOpen(true)}><Icon name="layers" size={15} /> {enabledRules} rules on</button>
        </header>

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
      </main>

      {rulesOpen && <RulesDrawer rules={rules} langModes={langModes}
        learnedByLang={window.EOEngine && window.EOEngine.learnedVerbsByLang ? window.EOEngine.learnedVerbsByLang() : {}}
        onToggle={toggleRule} onInstall={installRule} onSetLangMode={setLangMode} onImport={importRules} onClose={() => setRulesOpen(false)} onToast={showToast} />}
      {auditOpen && <AuditDrawer onClose={() => setAuditOpen(false)} enabled={auditEnabled} onToggle={toggleAudit} onToast={showToast}
                      docs={docs} exportIngestion={exportIngestion} exportOutput={exportOutput}
                      onExportIngestion={setExportIngestion} onExportOutput={setExportOutput} />}
      {modelOpen && <ModelPopover models={window.MODELS} current={model} onPick={pickModel} onClose={() => setModelOpen(false)} anchor={{ left: 16, bottom: 64 }}
                     status={modelStatus} progress={modelProgress} />}
      {entityModal && (() => { const d = docsById[entityModal.docId]; return d ? (
        <EntityModal doc={d} name={entityModal.name} onCite={flashCitation} onEntity={(n) => setEntityModal({ docId: d.id, name: n })}
          onOpenTab={openEntityTab} onClose={() => setEntityModal(null)} />
      ) : null; })()}
      {dragOver && <div className="drop-veil"><div className="drop-card"><Icon name="upload" size={26} /> Drop to read</div></div>}
      {ingestStatus && (
        <div className="ingest-banner">
          <span className="ib-spin" />
          <div className="ib-main">
            <div className="ib-head">
              <span className="ib-phase">{ingestStatus.phase}</span>
              <span className="ib-stage">{INGEST_LABEL[ingestStatus.stage] || ingestStatus.stage}</span>
              {ingestStatus.name && <span className="ib-name">· {ingestStatus.name}</span>}
              {ingestStatus.pct != null && <b className="ib-pct">{Math.round(ingestStatus.pct * 100)}%</b>}
            </div>
            <div className="ib-bar"><div className={'ib-fill' + (ingestStatus.pct == null ? ' indet' : '')}
              style={ingestStatus.pct != null ? { width: Math.round(ingestStatus.pct * 100) + '%' } : undefined} /></div>
          </div>
        </div>
      )}
      {toast && <div className="toast"><span className="tk"><Icon name="check" size={15} /></span>{toast}</div>}
    </div>
  );
}

// A single render throw used to blank #root with no recovery; this catches it
// and offers a reload instead of a white screen. (§5)
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { if (typeof window !== 'undefined' && window.EO_DEBUG) console.error('[Cleon] render error', err, info); }
  render() {
    if (this.state.err) {
      return (
        <div className="crash" role="alert">
          <h1>Something went wrong.</h1>
          <p>Cleon hit an unexpected error while rendering. Your documents and chat are saved locally — reloading usually recovers.</p>
          <button className="hero-action primary" onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
