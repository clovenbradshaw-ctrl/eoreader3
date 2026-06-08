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
// 5-gram shingle overlap between two strings (0..1). Used to catch the one
// failure the mechanical veto can't see: a "summary" that is just one source
// span echoed back verbatim binds and audits clean, but is not an answer.
const shingleOverlap = (a, b) => {
  const grams = (s) => {
    const w = String(s).toLowerCase().replace(/\{\{[^}]*\}\}/g, '').match(/[a-z0-9']+/g) || [];
    const g = new Set();
    for (let i = 0; i + 5 <= w.length; i++) g.add(w.slice(i, i + 5).join(' '));
    if (!g.size && w.length) g.add(w.join(' '));   // short text: whole-string gram
    return g;
  };
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0; for (const x of ga) if (gb.has(x)) shared++;
  return shared / Math.min(ga.size, gb.size);
};
// Is `text` essentially a copy of one of the retrieved spans? (the degenerate
// echo). Threshold mirrors the old sentinel_draft_overlap (0.82).
const echoesASpan = (scope, q, text, k = 6) => {
  try {
    const hits = window.EOEngine.retrieveScope(scope, q, k) || [];
    return hits.some(h => shingleOverlap(text, h.t) >= 0.82);
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
  const [busy, setBusy] = useState(false);

  const [rules, setRules] = useState(window.RULESETS.map(r => ({ ...r })));
  const [rulesOpen, setRulesOpen] = useState(false);
  // Auditing mode: a glass box over the chat pipeline (window.EOAudit), inspected
  // in a drawer and exportable as JSONL. Recording is on by default.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditEnabled, setAuditEnabled] = useState(() => (window.EOAudit ? window.EOAudit.isEnabled() : true));
  const [auditCount, setAuditCount] = useState(0);
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
  }, [rules]);

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
        if (typeof prefs.splitRatio === 'number') setSplitRatio(prefs.splitRatio);
        if (typeof prefs.explore === 'boolean') setExplore(prefs.explore);
        if (typeof prefs.auditEnabled === 'boolean') { setAuditEnabled(prefs.auditEnabled); if (window.EOAudit) window.EOAudit.setEnabled(prefs.auditEnabled); }
      }

      let savedDocs = [], savedChat = null;
      try { [savedDocs, savedChat] = await Promise.all([window.EOStore.loadDocs(), window.EOStore.loadChat()]); } catch (e) {}
      if (cancelled) { hydrated.current = true; return; }

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
    const t = setTimeout(() => window.EOStore.saveChat({ messages, chats, activeChat, openTabs, activeTab, sources }), 450);
    return () => clearTimeout(t);
  }, [messages, chats, activeChat, openTabs, activeTab, sources]);
  useEffect(() => {
    if (!hydrated.current || !window.EOStore) return;
    window.EOStore.savePrefs({ rules, modelId: model.id, mode, splitRatio, explore, projects, activeProject, auditEnabled });
  }, [rules, model, mode, splitRatio, explore, projects, activeProject, auditEnabled]);

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
  const stripMarkup = (s) => String(s).replace(/\{\{(?:cite|void):[^}]*\}\}/g, '').replace(/\s+([.,;:])/g, '$1').trim();
  // the running conversation, as plain {role, content} turns for the model
  const historyFor = () => messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.typing && !m.loading && m.text)
    .map(m => ({ role: m.role, content: stripMarkup(m.text) }));

  const streamInto = (patch) => (d) => setMessages(m => {
    const c = m.slice(); const prev = c[c.length - 1];
    c[c.length - 1] = { role: 'assistant', text: (prev.text || '') + d, streaming: true, ...patch };
    return c;
  });

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
  const runGroundedScope = async (scope, q, history) => {
    const intent = window.EOEngine.classifyIntent(q);
    AUD('step', 'intent', { intent });
    if (intent === 'who') { AUD('step', 'route', { detour: 'who → mechanical' }); runMechanicalScope(scope, q); return; }
    const perDocGround = scope.map(d => ({ id: d.id, name: d.name, has: window.EOEngine.hasGround(d, q) }));
    const grounded = perDocGround.some(d => d.has);
    AUD('step', 'ground', { hasGround: grounded, perDoc: perDocGround });
    if (!grounded) { AUD('step', 'route', { detour: 'no-ground → mechanical' }); runMechanicalScope(scope, q); return; }
    const ctx = window.EOEngine.contextScope(scope, q, 6);
    const task = intent === 'summary' ? 'summary' : 'answer';
    AUD('step', 'retrieve', { k: 6, task, engine: 'model-context', hits: auditHits(scope, q, 6) });
    try {
      replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
      let full = await window.EOLLM.phrase({
        mlcKey: model.mlc, question: q, contextText: ctx, history, mode: 'grounded', task,
        grounded: true, onToken: streamInto({ mode: 'grounded' }),
      });
      const settle = (res, decision) => {
        replaceLast({ role: 'assistant', text: res.text, audit: res.audit, mode: 'grounded' });
        if (res.cites && res.cites.length) setTimeout(() => flashCitation(res.cites[0].docId, res.cites[0].idx), 380);
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
          const stricter = ctx + '\n\nDo NOT copy or lightly reword any single passage. Compose a fresh ' +
            (task === 'summary' ? 'summary that synthesizes across the passages in your own words.' : 'answer in your own words.');
          let retry = '';
          try {
            replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
            retry = await window.EOLLM.phrase({
              mlcKey: model.mlc, question: q, contextText: stricter, history, mode: 'grounded', task,
              grounded: true, onToken: streamInto({ mode: 'grounded' }),
            });
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
        // MECHANICAL VETO across the whole scope: a name present in NONE of the
        // sources is invented; if the phrasing won't bind to any source, discard
        // it for the mechanical answer. The model never wins over the page(s).
        const perDoc = scope.map(d => new Set(window.EOEngine.inventedTerms(d, full)));
        const invented = perDoc.length ? [...perDoc[0]].filter(t => perDoc.every(s => s.has(t))) : [];
        const bound = window.EOEngine.bindCitationsScope(scope, full, q, intent);
        const useModel = !(invented.length || !bound.audit.grounded);
        AUD('step', 'veto', { decision: useModel ? 'model' : 'mechanical', invented, boundGrounded: bound.audit.grounded, boundCovers: bound.audit.covers });
        settle(useModel ? bound : window.EOEngine.answerScope(scope, q), useModel ? 'model + mechanical cite' : 'mechanical (veto)');
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

    // Open the turn's audit record before anything branches, so the routing
    // decision, model load, retrieval and the model call all attach to it.
    AUD('begin', {
      input: q, mode,
      scope: auditScope(scope),
      model: { id: model.id, name: model.name, mlc: model.mlc },
      hasWebGPU: canLLM, modelLoadedAtStart: wasLoaded,
      prevGrounded: lastGroundedRef.current,
    });

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

    // The one routing decision: is the user referencing a source in scope?
    // Grounded mode forces it; Auto lets the engine decide across the whole
    // source set, with continuity from the previous turn so an anaphoric
    // follow-up stays on the page. Otherwise it's a conversation with the model.
    let referencing = false, refReason = 'no-scope';
    if (scope.length > 0) {
      if (mode === 'grounded') { referencing = true; refReason = 'grounded-mode'; }
      else { referencing = window.EOEngine.referencesScope(scope, q, { prevGrounded: lastGroundedRef.current }); refReason = referencing ? 'references-scope' : 'not-referenced'; }
    }
    lastGroundedRef.current = referencing;

    if (referencing) {
      const primary = window.EOEngine.routePrimary(scope, q) || scope[0];
      const useLLM = ready && primary && primary.kind === 'prose';
      AUD('step', 'route', { referencing: true, reason: refReason, path: useLLM ? 'grounded-llm' : 'mechanical',
        primary: primary ? { id: primary.id, name: primary.name, kind: primary.kind } : null });
      if (useLLM) { runGroundedScope(scope, q, history); return; }
      runMechanicalScope(scope, q); return;   // tables, or no model → mechanical pivot / grounded answer
    }

    // plain chat
    AUD('step', 'route', { referencing: false, reason: refReason, path: ready ? 'plain-chat' : 'plain-unavailable' });
    if (ready) { runChat(q, history, undefined, '', !!doc); return; }
    const msg = canLLM
      ? 'The local model isn’t ready yet — give it a moment. Meanwhile, upload a document and I can answer questions about it directly, with citations.'
      : 'This browser can’t run the local model (no WebGPU), so I can’t free-chat here. Upload a document or paste text and I’ll still answer questions about it, with citations.';
    replaceLast({ role: 'assistant', text: msg, audit: null });
    AUD('end', { engine: 'none', text: msg, audit: null, reason: canLLM ? 'model-not-ready' : 'no-webgpu' });
    setBusy(false);
  };

  const newChat = () => { setMessages([]); setActiveChat('new'); lastGroundedRef.current = false; if (mobileRef.current) setCollapsed(true); };
  const selectChat = (id) => { setActiveChat(id); lastGroundedRef.current = false; if (mobileRef.current) setCollapsed(true); };

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
          <button className="tb-pill" onClick={() => setAuditOpen(true)} title="Audit — see every step the chat takes, exportable as JSONL">
            <Icon name="activity" size={15} /> Audit{auditCount ? ' · ' + auditCount : ''}
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

      {rulesOpen && <RulesDrawer rules={rules} onToggle={toggleRule} onInstall={installRule} onImport={importRules} onClose={() => setRulesOpen(false)} onToast={showToast} />}
      {auditOpen && <AuditDrawer onClose={() => setAuditOpen(false)} enabled={auditEnabled} onToggle={toggleAudit} onToast={showToast} />}
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
