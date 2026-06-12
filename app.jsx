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

// The on-device CPU (wllama) model used as the automatic fallback: the MODELS
// entry whose key matches EOLLM.fallbackKey(). It's the local path that still
// runs when there's no WebGPU and when a GPU model stalls/fails.
const cpuFallbackModel = () => {
  const L = typeof window !== 'undefined' ? window.EOLLM : null;
  const key = L && L.fallbackKey && L.fallbackKey();
  return (key && window.MODELS.find(m => m.mlc === key)) || window.MODELS.find(m => m.provider === 'wllama') || null;
};

// Which local model to start on. The 0.5B is a fine phone default — small
// download, runs anywhere — but on a desktop it's too small to phrase well, so
// default desktops to the 1.5B "balanced" model. Either can be switched live
// from the picker; switching now releases the old model before loading the new.
const defaultModel = () => {
  const by = (id) => window.MODELS.find(m => m.id === id);
  const L = typeof window !== 'undefined' ? window.EOLLM : null;
  // No WebGPU and no Claude key → the on-device CPU model is the only local path
  // that can actually run here (Firefox/Safari today), so default straight to it
  // instead of a GPU model that would just fail to load.
  if (L && L.hasWebGPU && !L.hasWebGPU() && !(L.hasAnthropicKey && L.hasAnthropicKey()) && (!L.hasWasm || L.hasWasm())) {
    const cpu = cpuFallbackModel();
    if (cpu) return cpu;
  }
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
  easing: 'Easing memory — almost there',
};
// The three phases of the staged parse, in the medium's own order, shown as a
// stepper so a long ingest reads as graceful progress rather than a stall.
const INGEST_PHASES = [
  { id: 'existence', label: 'Find' },
  { id: 'structure', label: 'Read' },
  { id: 'significance', label: 'Weigh' },
];

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
  // Thinking depth is pinned at the deepest stop — every turn runs the full
  // budget. thinkingBudget() clamps to its DEPTH_LEVELS ceiling, so any value
  // ≥ that works; the literal here is the contract. The turn's resolved budget
  // rides through the async settle paths in a ref.
  const turnBudgetRef = useRef(null);
  // This turn's associative links (Phase 3) — read by the inference void (Phase 4).
  const turnAssocRef = useRef([]);
  // The shape-steering exemplar library, once loaded+embedded (shape.js §9).
  // Populated lazily in the background the first eligible turn; null until then.
  const shapeLibRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const [rules, setRules] = useState(window.RULESETS.map(r => ({ ...r })));
  // Per-language reading mode: { en:'original'|'learning', … }. Empty/missing
  // means Self-learning (the shipped, adaptive behavior). Persisted with prefs.
  const [langModes, setLangModes] = useState({});
  const [rulesOpen, setRulesOpen] = useState(false);
  // Auditing mode: a glass box over the chat pipeline (window.EOAudit), inspected
  // in a drawer and exportable as JSONL. Recording is on by default.
  const [auditOpen, setAuditOpen] = useState(false);
  // Ingestion audit: a glass box over the BUILD — the graph word by word, in
  // reading order, with per-word fate + full provenance (window.EOEngine.ingestionReport).
  const [graphAuditOpen, setGraphAuditOpen] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);
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
  const [modelLoadText, setModelLoadText] = useState(''); // WebLLM's live status line ("12MB fetched…", "Loading GPU shaders…")
  const [anthropicKeySet, setAnthropicKeySet] = useState(!!(window.EOLLM && window.EOLLM.hasAnthropicKey && window.EOLLM.hasAnthropicKey()));
  // Gate for the startup auto-load: flipped true once local persistence has
  // rehydrated (or is known absent). The auto-load waits for it so it resumes
  // the model the user actually had selected — restored from prefs — rather than
  // racing hydration and loading the default. That race was why a refresh came
  // back to an UNloaded model: the effect fired on mount with defaultModel(),
  // hydration then swapped `model` to the saved one, and nothing loaded it.
  const [bootReady, setBootReady] = useState(false);
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
  // Has ANY turn in this chat routed to the document? Sticky (reset only on a
  // new/switched chat) so one mis-routed turn can't strand every later
  // follow-up off the page — the observed cascade: a follow-up drops to plain
  // chat, prevGrounded flips false, and "but why not?" / "explain why" can
  // never find their way back to the document again.
  const everGroundedRef = useRef(false);
  // The last grounded turn's question and citations — the carry. A follow-up
  // with no lexical signal of its own ("but why not?") is re-asked THROUGH
  // this material: the prior question's words plus the prior answer's cited
  // sentences are the retrieval seed the bare follow-up lacks.
  const lastCarryRef = useRef(null);
  // How many repair turns this chat has absorbed — cycles the acknowledgment
  // phrasing so a frustrated user is never answered with the same opener twice.
  const repairCountRef = useRef(0);
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
            setIngestStatus({ phase: p.phase, stage: p.stage, pct: p.total ? p.done / p.total : null, name: d.name,
              easing: p.stage === 'easing', usedMB: p.usedMB, capMB: p.capMB });
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
    if (!window.EOStore) { hydrated.current = true; setBootReady(true); return; }
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
      if (savedDocs.length) {
        setDocs(savedDocs); savedDocs.forEach(d => docIds.add(d.id)); bumpUid(savedDocs.map(d => d.id));
        // Rebuild the local span table for restored docs (h → doc/sentence),
        // so provenance anchors stay resolvable on-device without a re-parse.
        if (window.EOEngine && window.EOEngine._provenance) {
          for (const d of savedDocs) { try { window.EOEngine._provenance.registerDocSpans(d); } catch (e) {} }
        }
      }
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
      hydrated.current = true; setBootReady(true);
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
    window.EOStore.savePrefs({ rules, langModes, modelId: model.id, mode, splitRatio, explore, projects, activeProject, auditEnabled, exportIngestion, exportOutput });
  }, [rules, langModes, model, mode, splitRatio, explore, projects, activeProject, auditEnabled, exportIngestion, exportOutput]);
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

  // ---- the convention proposer (idle, budgeted, toggleable) ----
  // After a parse leaves registered friction, and only when the local model
  // is loaded and the chat is quiet, run one proposal turn at idle priority.
  // The engine owns everything that matters (friction, the closed grammar,
  // anchors, admission); this is just the scheduler. Never blocks a turn:
  // if the chat takes the floor before the idle slot fires, stand down.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const proposeArmed = useRef(false);
  const maybeProposeConventions = () => {
    const E = window.EOEngine;
    if (!E || !E.proposerStatus || proposeArmed.current) return;
    let st; try { st = E.proposerStatus(); } catch (e) { return; }
    if (!st.eligible) return;
    if (!(window.EOLLM && window.EOLLM.isLoaded(model.mlc))) return;   // model loaded…
    proposeArmed.current = true;
    const idle = (fn) => (typeof requestIdleCallback === 'function')
      ? requestIdleCallback(fn, { timeout: 30000 }) : setTimeout(fn, 4000);
    idle(async () => {
      proposeArmed.current = false;
      try {
        if (busyRef.current) return;                                   // …and idle
        const r = await E.runProposerTurn({
          llm: (sys, user) => window.EOLLM.phrase({
            mlcKey: model.mlc, question: user, history: [], mode: 'chat',
            grounded: false, sysOverride: sys,
          }),
        });
        const n = (r && r.accepted) ? r.accepted.length : 0;
        if (r && r.ran && n) {
          showToast('The reader proposed ' + n + ' reading convention' + (n > 1 ? 's' : '') + ' — review under Glass box → Proposals.');
        }
      } catch (e) { eoWarn('proposer', e); }
    });
  };
  // a model finishing its load may unlock proposals for already-read docs
  useEffect(() => { if (modelStatus === 'ready') maybeProposeConventions(); }, [modelStatus]);

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
        setIngestStatus({ phase: p.phase, stage: p.stage, pct, name,
          easing: p.stage === 'easing', usedMB: p.usedMB, capMB: p.capMB });
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
    // the parse may have registered friction (or co-witnessed a pending
    // proposal); give the proposer its idle slot
    if (doc.kind === 'prose') maybeProposeConventions();
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
    // Claude: no WebGPU and no download — just needs the API key. Without one,
    // stay idle and let the model popover collect it (it shows a key field for
    // an Anthropic model). With one, "loading" resolves instantly.
    if (m.provider === 'anthropic') {
      if (!window.EOLLM.hasAnthropicKey()) { setModelStatus('idle'); return false; }
      setModelStatus('loading'); setModelProgress(0); setModelLoadText('');
      try {
        await window.EOLLM.load(m.mlc);
        setModelStatus('ready'); setModelLoadText(''); return true;
      } catch (e) {
        setModelStatus('idle'); setModelLoadText('');
        showToast(e.message || 'Could not connect to Claude');
        return false;
      }
    }
    // wllama (CPU): no WebGPU needed. The GGUF downloads once from Hugging Face
    // and runs on the CPU; progress streams the same way the GPU path does.
    if (m.provider === 'wllama') {
      if (window.EOLLM.hasWasm && !window.EOLLM.hasWasm()) { setModelStatus('idle'); showToast('This browser can’t run the on-device CPU model (no WebAssembly).'); return false; }
      setModelStatus('loading'); setModelProgress(0); setModelLoadText('');
      try {
        await window.EOLLM.load(m.mlc, (p, text) => { setModelProgress(p); if (text) setModelLoadText(text); });
        setModelStatus('ready'); setModelLoadText(''); return true;
      } catch (e) {
        setModelStatus('idle'); setModelLoadText('');
        if (!(e && e.code === 'CANCEL')) showToast(e.message || 'CPU model failed to load');
        return false;
      }
    }
    if (!window.EOLLM.hasWebGPU()) {
      // A GPU model was selected but this browser has no WebGPU. Rather than
      // sit idle (mechanical-only), drop to the on-device CPU model.
      setModelStatus('idle');
      if (window.EO_CPU_FALLBACK !== 'off') return fallbackToCPU();
      return false;
    }
    setModelStatus('loading'); setModelProgress(0); setModelLoadText('');
    try {
      await window.EOLLM.load(m.mlc, (p, text) => { setModelProgress(p); if (text) setModelLoadText(text); });
      setModelStatus('ready'); setModelLoadText(''); return true;
    } catch (e) {
      setModelStatus('idle'); setModelLoadText('');
      if (e && e.code === 'CANCEL') return false;  // a user cancel is not an error
      // A GPU model that stalled or failed to load leaves chat with no phrasing.
      // Fall to the on-device CPU model so answers still get worded (the user's
      // "backup ready when the GPU ones haven't loaded or are stalled").
      const cpu = cpuFallbackModel();
      if (window.EO_CPU_FALLBACK !== 'off' && cpu && cpu.id !== m.id && window.EOLLM.hasWasm && window.EOLLM.hasWasm()) {
        showToast('The GPU model ' + (e.code === 'STALL' ? 'stalled' : 'wouldn’t load') + ' — switching to the on-device CPU model.');
        return fallbackToCPU();
      }
      showToast(e.message || 'Model failed to load');
      return false;
    }
  };
  // Switch the active model to the on-device CPU model and load it. The single
  // resident-engine invariant means we can't hold a warm CPU model beside a live
  // GPU one — so the switch happens at the moment it's needed (no WebGPU at
  // startup, or a GPU stall/failure), with the runtime pre-warmed for speed.
  const fallbackToCPU = async () => {
    const cpu = cpuFallbackModel();
    if (!cpu) return false;
    if (window.EOLLM && window.EOLLM.hasWasm && !window.EOLLM.hasWasm()) return false;
    setModel(cpu); setModelStatus('idle');
    return loadModel(cpu);
  };
  // Save (or clear) the Claude API key from the model popover. Saving a key for
  // the currently-selected Anthropic model immediately loads it.
  const setAnthropicKey = (k) => {
    if (!window.EOLLM || !window.EOLLM.setAnthropicKey) return;
    const saved = window.EOLLM.setAnthropicKey(k);
    setAnthropicKeySet(!!saved);
    if (saved && model && model.provider === 'anthropic') loadModel(model);
    else if (!saved && model && model.provider === 'anthropic') setModelStatus('idle');
  };
  const pickModel = (m) => { setModel(m); setModelStatus('idle'); loadModel(m); };
  // Download every recorded turn — including the exact prompt the model saw and
  // its raw output on each call — as one JSON file, straight from the chat page.
  // Empty when audit recording is paused (the dot next to the title is off).
  const exportPrompts = () => {
    const A = window.EOAudit;
    if (!A || !A.count || A.count() === 0) {
      showToast(A && A.isEnabled && !A.isEnabled() ? 'Recording is paused — turn it on in Audit, then ask again.' : 'No turns recorded yet.');
      return;
    }
    const ok = A.downloadJSON && A.downloadJSON();
    showToast(ok ? 'Exported ' + A.count() + ' turn' + (A.count() === 1 ? '' : 's') + ' with all prompts.' : 'Could not export the prompts.');
  };
  // Stop an in-flight download. Terminates the worker so it halts immediately
  // rather than running on in the background.
  const cancelModel = () => {
    try { if (window.EOLLM && window.EOLLM.cancelLoad) window.EOLLM.cancelLoad(); } catch (e) {}
    setModelStatus('idle'); setModelProgress(0); setModelLoadText('');
  };
  // Escape hatch for a download that keeps stalling on a corrupt half-written
  // cache: wipe the cached shards, then re-download from scratch.
  const resetModel = async () => {
    try { if (window.EOLLM && window.EOLLM.clearCache) await window.EOLLM.clearCache(model.mlc); } catch (e) {}
    loadModel(model);
  };

  // auto-load on startup so the app is live with the actual model. Waits for
  // bootReady (hydration done) so it RESUMES the model the user last selected —
  // restored from prefs — instead of the default. Weights are cached (WebLLM
  // cache / wllama useCache), so this re-instantiates fast and re-downloads
  // nothing: a refresh comes back to a loaded model.
  useEffect(() => {
    if (!bootReady || !window.EOLLM) return;
    if (model.provider === 'anthropic') {
      // A persisted Claude selection resumes if its key is stored; otherwise stay
      // idle and let the popover collect the key.
      if (window.EOLLM.hasAnthropicKey()) loadModel(model);
    } else if (model.provider === 'wllama') {
      loadModel(model);                      // on-device CPU — no WebGPU needed
    } else if (window.EOLLM.hasWebGPU()) {
      loadModel(model);
      // Keep the CPU backup READY: pre-import the wllama runtime (small, cached)
      // in the background so a later GPU stall can switch to it without also
      // paying the runtime fetch. The model weights still download on switch.
      if (window.EO_CPU_FALLBACK !== 'off') { try { window.EOLLM.prewarmFallback && window.EOLLM.prewarmFallback(); } catch (e) {} }
    } else {
      // A GPU model with no WebGPU here → drop straight to the on-device CPU model.
      if (window.EO_CPU_FALLBACK !== 'off') fallbackToCPU();
    }
    // Warm the structure-layer embedding reader in the background so the first
    // escalation isn't also paying the (one-time, cached) model download. Inert
    // if embed.js is absent or the model fails to load — routing stays lexical.
    try { if (window.EOEmbed && window.EOEmbed.warm) window.EOEmbed.warm(); } catch (e) {}
  }, [bootReady]);

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

  // ---- mobile keyboard: track the visual viewport so the composer stays pinned
  // just above the on-screen keyboard. The layout height normally follows the
  // full screen (100dvh); when the soft keyboard opens it overlaps the page on
  // iOS Safari (and older Android), hiding the input. visualViewport.height
  // shrinks to the space the keyboard leaves, so we mirror it into --app-height
  // so the layout (and the bottom-pinned composer) fits the visible area. ----
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let raf = 0;
    const sync = () => {
      raf = 0;
      root.style.setProperty('--app-height', vv.height + 'px');
      // when the keyboard scrolls the layout viewport (iOS Safari), reset it so
      // the app's top edge stays aligned with the visible area.
      if (vv.offsetTop > 0 && (window.innerHeight - vv.height) > 120) {
        window.scrollTo(0, 0);
      }
    };
    const onChange = () => { if (!raf) raf = requestAnimationFrame(sync); };
    sync();
    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', onChange);
    return () => {
      vv.removeEventListener('resize', onChange);
      vv.removeEventListener('scroll', onChange);
      if (raf) cancelAnimationFrame(raf);
      root.style.removeProperty('--app-height');
    };
  }, []);

  // keep an in-chat "loading model" message in sync with download progress and
  // WebLLM's live status line (so a slow-but-moving download reads as alive, not
  // stuck, and a stall/retry is visible)
  useEffect(() => {
    setMessages(m => {
      if (!m.length) return m; const last = m[m.length - 1];
      if (last && last.loading) { const c = m.slice(); c[c.length - 1] = { ...last, loadPct: modelProgress, loadText: modelLoadText }; return c; }
      return m;
    });
  }, [modelProgress, modelLoadText]);

  // ---- chat ----
  const ensureChat = (q) => {
    if (activeChat === 'new') {
      const id = uid('c'); setChats(cs => [{ id, title: q.length > 32 ? q.slice(0, 32) + '…' : q }, ...cs]); setActiveChat(id);
    }
  };
  const replaceLast = (patch) => setMessages(m => { const c = m.slice(); c[c.length - 1] = { ...c[c.length - 1], ...patch, typing: false }; return c; });
  const patchLast = (patch) => setMessages(m => { const c = m.slice(); c[c.length - 1] = { ...c[c.length - 1], ...patch }; return c; });

  // strip citation/void markup so prior turns read as plain text in history
  const stripMarkup = (s) => String(s).replace(/\{\{(?:cite|void|infer|absent):[^}]*\}\}/g, '').replace(/\s+([.,;:])/g, '$1').trim();
  // HISTORY HYGIENE: a prior turn that was vetoed, went out ungrounded, or
  // earned a warn badge re-enters the history WEARING that badge — never as
  // clean assistant text the model will defend. Handed its own unverified
  // reply as something it apparently said, a small model defends it, because
  // the history says it happened; the tag breaks that spiral at the source.
  // Prepended (not appended) so it survives the recap's tail truncation.
  const epistemicTag = (m) => {
    if (m.role !== 'assistant' || !m.text) return '';
    if (m.mode === 'creative') return '[an earlier creative composition, not a document answer] ';
    // A RETRACTED turn outranks its badge: the claim wore a clean chip when it
    // went out, and only a later graph-check caught it — the badge can't see
    // a false proposition built from true tokens, so the retraction marker is
    // the only thing standing between the model and re-defending the claim.
    if (m.retracted) return '[an earlier reply containing a claim that was later checked against the page and RETRACTED — do not repeat or defend it] ';
    // The user pushed back on this reply (a repair turn followed it). Without
    // the tag, the model re-reads its rejected answer as something that simply
    // happened and serves it again — the loop the user is objecting to.
    if (m.objected) return '[the user said this reply missed their question — do not repeat or defend it] ';
    const a = m.audit;
    if (!a) return '';
    if (a.status === 'plain') return '[an earlier reply from general knowledge, not the document] ';
    if (a.status === 'warn' && a.grounded) return '[an earlier reply with terms the document does not contain struck as unverified — do not repeat or defend the struck parts] ';
    if (a.grounded === false) return '[an earlier reply that was NOT verified against the document — do not repeat or defend its claims] ';
    return '';
  };
  // the running conversation, as plain {role, content} turns for the model
  const historyFor = () => messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.typing && !m.loading && m.text)
    .map(m => ({ role: m.role, content: epistemicTag(m) + stripMarkup(m.text) }));

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
    // Stash the carry for follow-up turns (see lastCarryRef): every settled
    // grounded turn becomes the retrieval seed the next elliptical turn rides.
    lastCarryRef.current = { q: String(q || ''), cites: (cites || []).slice(0, 8) };
    const F = window.EOEngine && window.EOEngine.conversationField;
    if (!F) return;
    let matter = [];
    try { matter = (window.EOEngine.referentsScope(scope, q) || {}).matter || []; } catch (e) {}
    try { F.deposit({ entities: matter, sentences: (cites || []).map(c => ({ docId: c.docId, idx: c.idx })) }, 1); }
    catch (e) { eoWarn('field deposit', e); }
  };

  // The follow-up's retrieval seed: the turn's own words plus the previous
  // grounded turn's question and its cited sentences (verbatim document text,
  // so the seed can never inject model phrasing into retrieval). "but why
  // not?" carries no document tokens; the question it follows does.
  const carryQuery = (scope, q) => {
    const c = lastCarryRef.current;
    if (!c) return null;
    const texts = [];
    for (const ct of c.cites || []) {
      const d = scope.find(x => x.id === ct.docId);
      const t = d && d.sentenceTexts && d.sentenceTexts[ct.idx];
      if (t) texts.push(t);
    }
    const seed = (c.q + ' ' + texts.join(' ')).trim();
    return seed ? (String(q) + ' ' + seed) : null;
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
    let gaps; try { gaps = E.coverageGaps(q, support()); } catch (e) { eoWarn('seek gaps', e); gaps = { uncovered: [], n: 0, d: 1 }; }
    let prevN = gaps.n;
    for (let r = 2; r <= budget.maxSeekRounds; r++) {
      if (!gaps.uncovered.length) break;                         // fully covered — nothing left to seek
      // A gap can only be sought if the term exists SOMEWHERE in the sources.
      // Sub-querying on a meta-word from the user's own phrasing ("mistakes")
      // spends the round on words ABOUT the question instead of words on the
      // page — drop the unseekable terms, and stop when nothing seekable is left.
      let seekable = gaps.uncovered, unseekable = [];
      try {
        seekable = E.seekableTerms ? E.seekableTerms(scope, gaps.uncovered) : gaps.uncovered;
        unseekable = gaps.uncovered.filter(t => !seekable.includes(t));
      } catch (e) { eoWarn('seekable', e); }
      if (!seekable.length) {
        AUD('step', 'retrieve', { round: r, k, engine: 'seek', skipped: true, unseekable,
          note: 'the uncovered terms appear nowhere in the sources — nothing left to seek' });
        break;
      }
      const subq = seekable.concat(matter).join(' ');
      let more = []; try { more = E.retrieveScope(scope, subq, k); } catch (e) { break; }
      const before = chosen.size;
      add(more);
      const g2 = E.coverageGaps(q, support());
      const novelty = r4((g2.n - prevN) / (gaps.d || 1));        // fraction of NEW query terms this round covered
      AUD('step', 'retrieve', { round: r, k, engine: 'seek', subquery: subq, novelty,
        unseekable: unseekable.length ? unseekable : undefined,
        covered: g2.n + '/' + g2.d, newHits: chosen.size - before,
        hits: (more || []).slice(0, 6).map(h => ({ docId: h.docId, idx: h.i, score: r4(h.score), text: h.t })) });
      prevN = g2.n; gaps = g2;
      if (chosen.size === before) break;                         // nothing new came back
      if (novelty < budget.seekNoveltyFloor) break;              // the pull is too weak to justify another round
    }
    return [...chosen.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  };

  // Phase 3: associative wandering (deepest depth, embedder-backed). From the
  // spans the answer is built on, find embedding-near sentences the page never
  // lexically connects, delta-gate them against the doc's own gravity, warm the
  // survivors by association (the field, for the next turn's working memory, and
  // this turn's context), and log each deposit as an `associate` step — legible
  // THAT the field linked them, never the geometry of why. No embedder => no-op.
  // Returns the kept neighbor hits; the caller folds them into the turn's spans.
  const associateKept = async (scope, q, budget) => {
    const E = window.EOEngine;
    try {
      const prim = E.routePrimary(scope, q) || scope[0];
      if (!prim || prim.kind !== 'prose' || !E.associativeNeighbors) return [];
      const srcSpans = (E.retrieveScope([prim], q, 6) || []).map(h => h.i);
      if (!srcSpans.length) return [];
      const neigh = await E.associativeNeighbors(prim, srcSpans, budget, 5);
      const kept = (neigh || []).filter(n => n.clearedDelta);
      if (!kept.length) return [];
      const from = srcSpans.slice(0, 3).map(i => 's' + i);
      const links = [];
      for (const n of kept) {
        try { E.conversationField && E.conversationField.deposit({ sentences: [{ docId: prim.id, idx: n.i }] }, budget.assocCoupling); } catch (e) {}
        AUD('step', 'associate', { from, to: 's' + n.i, coupling: budget.assocCoupling, sim: n.sim, clearedDelta: true });
        links.push({ docId: prim.id, from: srcSpans.slice(0, 3), to: n.i, sim: n.sim });
      }
      turnAssocRef.current = links;                       // hand the links to the inference void (Phase 4)
      return kept.map(n => ({ docId: prim.id, i: n.i, t: n.t }));
    } catch (e) { eoWarn('associate', e); return []; }
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

  // The conversation's hottest entity — what an anaphoric proposition ("he was
  // not a speaker") is about. A pointer into the same field working memory
  // already reads; null on a cold field, and the engine then declines to parse
  // the pronoun rather than guessing.
  const hotEntity = () => {
    try {
      const snap = window.EOEngine.conversationField.snapshot();
      const top = (snap.entities || [])[0];
      return (top && (top.label || top.key)) || null;
    } catch (e) { return null; }
  };

  // RETRACTION — a SEG against the system's own utterance. When a graph-check
  // (CONFIRM intent) finds a proposition unsupported, and a PRIOR assistant
  // turn asserted that same proposition affirmatively, the old turn is the
  // thing that's wrong: flag it `retracted` (history hygiene re-tags it) and
  // say so in the new answer. Without this, a correction the user deposits
  // three times accrues nowhere — the false claim stands un-retracted in
  // history while every new turn re-reads it as something that happened.
  const maybeRetract = (scope, plan) => {
    const E = window.EOEngine;
    const checks = (plan && plan.checks) || [];
    // the propositions the graph FAILED to support, in their affirmative form
    const failed = checks.filter(c =>
      (!c.negated && (c.verdict === 'denied-by-absence' || c.verdict === 'unattested' || c.verdict === 'contradicted')) ||
      (c.negated && (c.verdict === 'confirmed' || c.verdict === 'confirmed-by-absence')));
    if (!failed.length) return plan;
    const prior = messages.filter(m => m.role === 'assistant' && m.text && !m.retracted);
    const retractions = [];
    for (const c of failed) {
      const subjToks = E.tok(c.subject), predToks = E.tok(c.predicate).slice(0, 2);
      if (!subjToks.length || !predToks.length) continue;
      for (const m of prior) {
        const plain = String(m.text).replace(/\{\{[^}]*\}\}/g, ' ');
        for (const sent of (E.splitDraft ? E.splitDraft(plain) : [plain])) {
          const ls = ' ' + sent.toLowerCase() + ' ';
          if (!subjToks.every(t => ls.includes(t)) || !predToks.every(t => ls.includes(t))) continue;
          if (/\b(?:not|never|no)\b|n['’]t\b/.test(ls)) continue;     // it already denied it
          retractions.push({ msg: m, sentence: sent.trim(), subject: c.subject, predicate: c.predicate });
          break;
        }
        if (retractions.some(r => r.msg === m)) break;   // one retraction per check is enough
      }
    }
    if (!retractions.length) return plan;
    for (const r of retractions) {
      setMessages(ms => ms.map(m => m === r.msg ? { ...m, retracted: true } : m));
      AUD('step', 'retract', { claim: r.sentence, subject: r.subject, predicate: r.predicate,
        note: 'A prior reply asserted this; the graph-check does not support it. The old turn re-enters history flagged RETRACTED.' });
    }
    const said = retractions[0];
    return { ...plan, text: plan.text +
      `\n\nI’m also retracting an earlier claim of mine — I had said: “${said.sentence}” That isn’t supported by the page’s recorded events, and the earlier reply now carries the retraction.` };
  };

  // Mechanical turn over the scope. `givenPlan` lets a caller hand in an
  // already-computed answer (the CONFIRM detour) without re-deriving it.
  const runMechanicalScope = (scope, q, givenPlan) => {
    // Capture the deterministic basis of the answer for the trace: intent, the
    // matter/anti-matter referents, and the scored retrieval hits.
    let intent = null, refs = null;
    try { intent = window.EOEngine.classifyIntent(q); } catch (e) {}
    try { refs = window.EOEngine.referentsScope(scope, q); } catch (e) {}
    AUD('step', 'intent', { intent });
    if (refs) AUD('step', 'referents', { matter: refs.matter, antimatter: refs.antimatter });
    AUD('step', 'retrieve', { k: 6, engine: 'mechanical', hits: auditHits(scope, q, 6) });
    let plan = givenPlan || window.EOEngine.answerScope(scope, q, { hotEntity: hotEntity() });
    if (plan.checks) {
      AUD('step', 'confirm', { checks: plan.checks.map(c => ({ subject: c.subject, predicate: c.predicate, negated: !!c.negated, verdict: c.verdict })) });
      try { plan = maybeRetract(scope, plan); } catch (e) { eoWarn('retract', e); }
    }
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
  const runChat = async (q, history, modeTag, ctx, docOpen, mech) => {
    const ungroundedAudit = docOpen
      ? { status: 'plain', grounded: false, note: 'Answered from the model’s general knowledge — not drawn from the open document.' }
      : null;
    // A document question we couldn't ground still gets the model's answer; the
    // page's own (deterministic) reading rides along as a click-to-view panel.
    const mechPanel = (mech && mech.text) ? { text: mech.text, audit: mech.audit, cites: mech.cites || [] } : null;
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
      replaceLast({ role: 'assistant', text: full, audit: ungroundedAudit, mode: modeTag, mechanical: mechPanel });
      AUD('end', { engine: 'model', text: full, audit: ungroundedAudit, cites: [] });
    } catch (e) {
      const msg = 'I couldn’t finish that one locally — the model likely ran out of memory or context. Try a shorter message, pick a smaller model from the switcher, or ask about an open document and I’ll answer it mechanically.';
      replaceLast({ role: 'assistant', text: msg, audit: null });
      AUD('step', 'error', { where: 'chat', fatal: true, message: String((e && e.message) || e) });
      AUD('end', { engine: 'none', text: msg, audit: null, reason: 'model-failed' });
    }
    setBusy(false);
  };

  // ---- CONVERSATIONAL REPAIR ----
  // The router decided this turn is about the EXCHANGE — the user pushing back
  // on the previous reply ("you're not listening", "yeah it does", "no — the
  // son of someone involved with NDP"). A conversation partner doesn't run the
  // complaint through retrieval as if it were a fresh question; it (1) marks
  // the rejected reply so history hygiene stops the model defending it,
  // (2) reconstructs the question actually under repair — the last user turn
  // that wasn't itself a repair move, plus every refinement deposited since —
  // (3) re-reads THAT, and (4) never re-serves a reply the user already
  // rejected: better to say it's stuck than to repeat itself a third time.
  const REPAIR_ACKS = {
    frustration: [
      'You’re right to push back — let me re-read instead of repeating myself.',
      'Fair. I keep giving you the same thing; here’s the closest the page actually comes.',
      'I hear you — taking the question from the top.',
    ],
    contradiction: [
      'Let me look again rather than insist.',
      'You may be right — re-reading.',
      'Checking again instead of repeating myself.',
    ],
    refinement: [
      'Got it — taking that as the question.',
      'Right, with that correction:',
      'Re-reading with that in mind.',
    ],
    support: [
      'Fair question — here’s what in the text I was leaning on:',
      'Let me point at the lines behind that:',
      'Here’s where the page actually backs that up:',
    ],
  };
  // Flag the most recent settled assistant reply as objected-to; epistemicTag
  // re-tags it in every future prompt.
  const markObjected = () => setMessages(ms => {
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      if (m.role === 'assistant' && m.text && !m.typing && !m.loading) {
        if (m.objected) return ms;
        const c = ms.slice(); c[i] = { ...m, objected: true }; return c;
      }
    }
    return ms;
  });
  // The question under repair: walk the user turns backward, collecting the
  // content of repair-shaped turns as refinements, until the first turn that
  // wasn't itself a repair move — that's the anchor being re-asked.
  const repairAnchor = () => {
    const E = window.EOEngine;
    const users = messages.filter(m => m.role === 'user' && m.text);
    const refinements = [];
    let anchor = null;
    for (let i = users.length - 1; i >= 0; i--) {
      let rep = null;
      try { rep = E.repairSignal(users[i].text); } catch (e) {}
      if (rep) { if (rep.content) refinements.unshift(users[i].text); continue; }
      anchor = users[i].text; break;
    }
    return { anchor, refinements };
  };
  const runRepairScope = async (scope, q, history, repair) => {
    const E = window.EOEngine;
    const { anchor, refinements } = repairAnchor();
    const priorReplies = messages.filter(m => m.role === 'assistant' && m.text && !m.typing).map(m => m.text);
    const lastReply = priorReplies.length ? priorReplies[priorReplies.length - 1] : '';
    // The retry probe: the anchor question + the recent refinements + this
    // turn's own content (when it carries any) + any kin term the disputed
    // reply argued about (a contradiction of "no son is mentioned" re-asks
    // about the son).
    const parts = [anchor, ...refinements.slice(-3)];
    if (repair.content) parts.push(q);
    let probe = [...new Set(parts.filter(Boolean))].join(' ').trim();
    // SUPPORT/EVIDENCE repair: the user is asking what in the text backs the
    // PRIOR reply ("what makes you say that?"). The retrieval target is the
    // substance of that reply, not the anaphoric, content-free question about
    // it — seed the probe with the reply's own content terms (markup stripped,
    // void terms already gone) so the re-read lands on the passages behind it.
    if (repair.kind === 'support' && lastReply) {
      try {
        const replyTerms = E.supportProbeTerms(scope, lastReply, 20);
        if (replyTerms.length) probe = [probe, ...replyTerms].filter(Boolean).join(' ').trim();
      } catch (e) { eoWarn('support probe', e); }
    }
    try {
      const kin = E.kinAsked(probe + ' ' + lastReply);
      for (const k of kin) if (!new RegExp('\\b' + k, 'i').test(probe)) probe += ' ' + k;
    } catch (e) {}
    if (!probe) probe = q;
    AUD('step', 'repair', { kind: repair.kind, anchor, refinements, probe });
    const turnIdx = repairCountRef.current++;
    const ackList = REPAIR_ACKS[repair.kind] || REPAIR_ACKS.refinement;
    const ack = ackList[turnIdx % ackList.length];
    // The rejected reply enters THIS prompt already wearing its tag (the
    // objected flag set by the caller only reaches future historyFor calls).
    const tagged = (() => {
      const h = history.slice();
      for (let i = h.length - 1; i >= 0; i--) {
        if (h[i].role === 'assistant') {
          if (!/^\[/.test(h[i].content)) h[i] = { ...h[i], content: '[the user said this reply missed their question — do not repeat or defend it] ' + h[i].content };
          break;
        }
      }
      return h;
    })();
    const stuck = () => {
      // Even the stuck message must not repeat itself — pick the first variant
      // the chat hasn't already heard.
      const variants = [
        'I’ve re-read the document for this and I keep landing on the same lines, so the page may simply not say it'
          + (anchor ? ' — what I’m trying to answer is: “' + anchor + '”' : '') + '. '
          + 'If you can give me a name or an exact phrase from the text, I’ll chase that instead.',
        'Still stuck on this one — the re-read brought back nothing new. A name or exact phrase from the text would give me something to chase.',
        'I don’t have anything new on this; I’d rather say so than repeat myself again.',
      ];
      let text = variants.find(v => !E.echoesPriorReply(v, priorReplies)) || variants[variants.length - 1];
      if (repair.kind === 'frustration' && text === variants[0]) text = 'I hear you, and I don’t want to keep repeating myself. ' + text;
      const audit = { status: 'notes', grounded: true, covers: '0/1', stable: true,
        note: 'Held — the re-read found nothing new, and saying so beats re-serving a reply the user already rejected.' };
      lastGroundedRef.current = true;
      replaceLast({ role: 'assistant', text, audit, mode: 'grounded' });
      AUD('end', { engine: 'repair-stuck', text, audit, cites: [] });
      setBusy(false);
    };
    const settleRepair = (body, engine) => {
      // The retry landed on a reply already sent. Two very different cases:
      // a NON-answer (a hold, a "don't say") must never be re-served — that
      // loop is what the user is objecting to. But a substantive, cited
      // answer that the re-read independently re-derives IS the answer;
      // withholding it would be worse. Serve it flagged as re-confirmed.
      const echoed = E.echoesPriorReply(body.text, priorReplies);
      if (echoed && !(body.audit && body.audit.grounded && (body.cites || []).length)) {
        AUD('step', 'veto', { decision: 'stuck', reason: 'the retry reproduced a non-answer the user already rejected' });
        return stuck();
      }
      const echoOpeners = [
        'I re-read rather than repeat myself, and I land in the same place — I do think this is what the page holds:',
        'Checked again: the page gives me the same line. As far as this document goes, this is the answer:',
        'Re-read once more and it still comes back to this:',
      ];
      const opener = echoed ? echoOpeners[turnIdx % echoOpeners.length] : ack;
      const audit = body.audit
        ? { ...body.audit, note: 'Opens with a conversational acknowledgment of the pushback; the claims after it: ' + (body.audit.note || 'audited as usual.') }
        : body.audit;
      const text = opener + '\n\n' + body.text;
      lastGroundedRef.current = !!(audit && audit.grounded);
      replaceLast({ role: 'assistant', text, audit, mode: 'grounded' });
      if (body.cites && body.cites.length) setTimeout(() => flashCitation(body.cites[0].docId, body.cites[0].idx), 380);
      depositSettled(scope, probe, body.cites);
      AUD('end', { engine, text, audit, cites: body.cites || [] });
      setBusy(false);
    };
    // The mechanical re-read of the repaired question — the floor. A clean
    // record-backed answer (kin/assertion/void) outranks re-phrasing: phrasing
    // is what just failed the user.
    let mech = null;
    try { mech = E.answerScope(scope, probe, { hotEntity: hotEntity() }); } catch (e) { eoWarn('repair mech', e); }
    AUD('step', 'retrieve', { k: 6, engine: 'repair-probe', hits: auditHits(scope, probe, 6) });
    if (mech && mech.audit && (mech.audit.status === 'clean' || mech.audit.status === 'warn')) {
      return settleRepair(mech, 'mechanical (repair)');
    }
    const ready = !!(window.EOLLM && window.EOLLM.isLoaded(model.mlc));
    const tier = E.contextPartsScope(scope, probe, 6);
    const primaryDoc = E.routePrimary(scope, probe) || scope[0];
    if (ready && (tier.spans.length || tier.notes.length)) {
      try {
        // The shape pass sees the tagged history, so the rejected reply and
        // the pushback are in its view — repair register comes out naturally.
        const shapeNote = await shapeFor(scope, q, tagged, primaryDoc);
        // Size the budget from the reconstructed question (probe), not the
        // complaint; intent is left for the prompt match to infer (shape.js §9).
        const shapeMax = await shapeBudgetFor(probe, null, shapeNote);
        replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
        const sysOverride = window.EOLLM.systemFor('grounded', 'answer', true, 1)
          + '\n\nThe user has said your earlier replies missed their question — do not repeat any earlier reply; answer the question afresh from the spans and notes, and if they truly do not answer it, say exactly what they DO establish about the subject instead.';
        let full = await window.EOLLM.phrase({
          mlcKey: model.mlc, question: probe, history: tagged,
          spans: tier.spans, notes: tier.notes.join('\n'),
          docTitle: (primaryDoc && primaryDoc.name) || '', shapeNote, maxTokens: shapeMax,
          mode: 'grounded', task: 'answer', grounded: true, sysOverride,
          onToken: streamInto({ mode: 'grounded' }), depth: turnBudgetRef.current && turnBudgetRef.current.level,
        });
        full = E.dedupeSentences(full);
        const declined = modelDeclined(full) || echoesShapeNote(full, shapeNote);
        if (!declined && !E.echoesPriorReply(full, priorReplies)) {
          const perDoc = scope.map(d => new Set(E.inventedTerms(d, full)));
          const invented = perDoc.length ? [...perDoc[0]].filter(t => perDoc.every(s => s.has(t))) : [];
          const bound = E.bindCitationsScope(scope, full, probe, 'factual', { hotEntity: hotEntity() });
          // The kin-subject veto runs here too: a repair that re-serves the
          // possessor wearing the kin's role would pass the bind check again.
          let kinMismatches = [];
          try { kinMismatches = E.checkKinSubjectsScope(scope, full) || []; } catch (e) {}
          if (bound.audit.grounded && !invented.length && !kinMismatches.length) {
            AUD('step', 'veto', { decision: 'model', invented: [], boundGrounded: true, boundCovers: bound.audit.covers });
            return settleRepair(bound, 'model + mechanical cite (repair)');
          }
          AUD('step', 'veto', { decision: 'mechanical',
            reason: !bound.audit.grounded ? 'unbound' : kinMismatches.length ? 'kin-subject-mismatch' : 'invented terms',
            invented, kinMismatches: kinMismatches.map(m => ({ possessor: m.possessor, kin: m.kin, sent: m.sent, claim: m.claim, docId: m.docId })),
            boundGrounded: bound.audit.grounded, boundCovers: bound.audit.covers });
        } else {
          AUD('step', 'veto', { decision: 'mechanical', reason: declined ? 'model declined / empty' : 'the model reproduced a rejected reply' });
        }
      } catch (e) {
        AUD('step', 'error', { where: 'repair', message: String((e && e.message) || e) });
      }
    }
    if (mech && mech.audit && mech.audit.grounded && mech.audit.status !== 'held') return settleRepair(mech, 'mechanical (repair)');
    return stuck();
  };

  // Run the shape pass for a grounded turn: question + recent turns + doc
  // title + a hint that header metadata exists. Returns the director's note,
  // or '' on any failure (the answer pass then runs unchanged). A note that
  // arrives as leaked reasoning is dropped rather than passed along.
  const shapeFor = async (scope, q, history, primaryDoc) => {
    try {
      if (!window.EOLLM || !window.EOLLM.shapePass || !window.EOLLM.isLoaded(model.mlc)) return '';
      const meta = (window.EOEngine.docMetadata && primaryDoc) ? window.EOEngine.docMetadata(primaryDoc) : null;
      const fieldsOn = meta && meta.fields ? Object.keys(meta.fields) : [];
      const t0 = performance.now();
      let note = await window.EOLLM.shapePass({
        mlcKey: model.mlc, question: q, history,
        docTitle: (primaryDoc && primaryDoc.name) || '',
        metaHint: fieldsOn.length ? fieldsOn.join(', ') : '',
      });
      note = String(note || '').trim();
      // A shape note SPEAKS about the user ("They're asking for…"), so the
      // reasoning-preamble heuristics don't apply here — only raw think tags
      // disqualify a note.
      if (/<\/?think/i.test(note)) note = '';
      // The note must never carry document content, but a small editor model
      // leaks it as quoted "example answers" — and the answering model then
      // copies the example verbatim (the observed trace: the note's own
      // "bad answer would be…" sample became the reply's opening line).
      // Strip quoted spans of 4+ words; short quoted register words survive.
      note = note.replace(/["“](?:[^"“”]{0,80}?\s){3,}[^"“”]*?["”]/g, '')
        .replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
      AUD('step', 'shape', { note: note || null, ms: Math.round(performance.now() - t0) });
      return note;
    } catch (e) { eoWarn('shape', e); return ''; }
  };

  // The shape layer's best-fit token budget for this turn (shape.js §9): match
  // the prompt against the archetype PROMPTS and size the answer's max_tokens
  // from the best-fit archetype's own length. Returns undefined — i.e. keep
  // today's depth-scaled cap (parity) — unless the exemplar library is already
  // loaded AND the embedder is resident, so it never triggers a model download
  // and never blocks a turn on a first-time library embed: the first eligible
  // turn warms the library in the background and uses the default budget; later
  // turns get the shaped one. Any failure ⇒ undefined ⇒ today's cap.
  const shapeBudgetFor = async (q, intent, shapeNote) => {
    try {
      if (!window.EOShape || typeof window.EOShapeLibrary !== 'function') return undefined;
      if (!(window.EOEmbed && window.EOEmbed.ready())) return undefined;   // never trigger a download
      let lib = shapeLibRef.current;
      if (!lib) {
        window.EOShapeLibrary().then(l => { if (l) shapeLibRef.current = l; }).catch(() => {});
        return undefined;   // warming; this turn keeps the default cap
      }
      if (!lib.readyPrompts || !lib.readyPrompts()) return undefined;
      const qv = await window.EOEmbed.embedSentences([q]);
      const queryVec = qv && qv[0];
      if (!queryVec) return undefined;
      const target = lib.select({ intent: intent || null, shapeNote: shapeNote || '', queryVec });
      const tb = target && window.EOShape.tokenBudgetFor(target);
      if (!tb) return undefined;
      AUD('step', 'shape-tokens', { maxTokens: tb.maxTokens, basis: tb.basis, intent: target.intent || null, prompt_match: target.prompt_match || null });
      return tb.maxTokens;
    } catch (e) { eoWarn('shape-tokens', e); return undefined; }
  };

  // Did the model decline (or leak) instead of answering? A grounded draft
  // that says the material doesn't cover it, or that arrives as raw
  // chain-of-thought (reasoning preamble / think tags the llm layer's
  // stripping couldn't tag), falls to the mechanical answer.
  const modelDeclined = (full) => {
    const t = String(full == null ? '' : full).trim();
    if (!t || t.length < 3) return true;
    if (/(passages?|spans?|notes?|document)\s+(?:do|does)\s?n.?t\s+(?:say|mention|cover|answer)/i.test(t)) return true;
    try { if (window.EOEngine.looksLeakedReasoning && window.EOEngine.looksLeakedReasoning(t)) return true; } catch (e) {}
    return false;
  };

  // The grounded pass parroting the director's note back ("The user is
  // asking about…") is a non-answer in the note's voice — meta about the
  // question, never a claim from the page. It costs a full bind-and-fail
  // round downstream and a misleading 'unbound' trace; catch it here by
  // overlap with the note itself and decline it by name.
  const echoesShapeNote = (full, note) => {
    try {
      const t = String(full == null ? '' : full).trim(), n = String(note == null ? '' : note).trim();
      if (!t || !n) return false;
      const tt = new Set(window.EOEngine.tok(t));
      const nt = new Set(window.EOEngine.tok(n));
      if (!tt.size || nt.size < 4) return false;
      let hit = 0; for (const x of nt) if (tt.has(x)) hit++;
      // most of the note's vocabulary, in a reply no bigger than the note's
      // register — a real answer subsumes note words inside page content
      return hit / nt.size >= 0.7 && tt.size <= nt.size * 2;
    } catch (e) { return false; }
  };

  // Document-referencing turn: feed the model the relevant passages and bind
  // citations mechanically. The seeker still decides what's there to say —
  // "who" is exact-mechanical; no ground → honest hold; the model only phrases.
  const runGroundedScope = async (scope, q, history, semanticHits) => {
    const intent = window.EOEngine.classifyIntent(q);
    AUD('step', 'intent', { intent });
    // CONFIRM/DENY: a proposition is checked against the graph, never phrased
    // by the model — the grounded-QA prompt presents an assertion as a
    // question, and a small model resolves the confusion by quoting the user
    // back as if they were the passage. This one stays mechanical-primary by
    // design (handing a proposition to the model degrades the answer); only
    // when the proposition parses and a source's graph can check it.
    if (intent === 'confirm') {
      let checked = null;
      try { checked = window.EOEngine.answerConfirmScope(scope, q, { hotEntity: hotEntity() }); }
      catch (e) { eoWarn('confirm', e); }
      if (checked) { AUD('step', 'route', { detour: 'confirm → graph-check (mechanical)' }); runMechanicalScope(scope, q, checked); return; }
    }
    // ABOUT THE HTML / DE-CHROMING: a turn about the page chrome itself — what
    // was stripped, what the footer/byline/masthead holds — is read against the
    // FULL content (the de-chromed band included) and answered mechanically from
    // the structure band, never phrased by the model. Mechanical-primary like
    // CONFIRM; inert unless a loaded source actually carries chrome (the scope
    // answer is null, and the turn falls through to the ordinary path).
    let aboutChromeTurn = false;
    try { aboutChromeTurn = window.EOEngine.aboutChrome && window.EOEngine.aboutChrome(q); } catch (e) {}
    if (aboutChromeTurn) {
      let stripped = null;
      try { stripped = window.EOEngine.answerDechromeScope(scope, q, { hotEntity: hotEntity() }); }
      catch (e) { eoWarn('dechrome', e); }
      if (stripped) { AUD('step', 'route', { detour: 'about-html → de-chrome report (mechanical)' }); runMechanicalScope(scope, q, stripped); return; }
    }
    // The deterministic reading of this turn — the cast-list count for a "who"
    // ask, the best mechanical answer otherwise. It is NO LONGER the primary
    // reply for a document question (the model phrases it with citations); it
    // rides along on the settled message as the "exact mechanical reading" the
    // user can click to view. Best-effort: a failure just means no panel.
    let mech = null;
    try { mech = window.EOEngine.answerScope(scope, q, { hotEntity: hotEntity() }); } catch (e) { eoWarn('mechanical reading', e); }
    // Semantic recall already located the material → trust it for ground; else the
    // usual lexical hasGround check decides whether the page can answer.
    const hasSemantic = !!(semanticHits && semanticHits.length);
    const perDocGround = scope.map(d => ({ id: d.id, name: d.name, has: window.EOEngine.hasGround(d, q) }));
    const grounded = hasSemantic || perDocGround.some(d => d.has);
    AUD('step', 'ground', { hasGround: grounded, perDoc: perDocGround, viaSemantic: hasSemantic });
    // No passage answers this. Rather than serve the mechanical reading as the
    // reply, talk it through with the model (ungrounded, badged "not from the
    // document") and keep the mechanical reading one click away — "always give
    // chat": a doc question we can't ground becomes conversation, not a hold.
    if (!grounded) { AUD('step', 'route', { detour: 'no-ground → chat' }); runChat(q, history, undefined, '', true, mech); return; }
    // Context, tiered (spans + notes) for factual asks: semantically-recovered
    // spans if we have them, else the lexical parts — and above the dial's
    // floor, a factual ask iteratively seeks the parts of the question its
    // first retrieval didn't cover (Phase 2). The summary sample stays a
    // curated blob (the salient picks read as one piece); buildUserContent
    // frames a blob the same way.
    const budget = turnBudgetRef.current;
    // A "who appears" turn wants the cast as context, not lexical retrieval —
    // the same per-doc entity sample the mechanical reading counts from. Treat
    // it like a summary for context-building (blob, no seek) so the model
    // phrases the cast in prose with citations; the exact count rides along as
    // the click-to-view mechanical reading.
    const wantsBlob = intent === 'summary' || intent === 'who';
    const useSeek = !!(budget && budget.maxSeekRounds > 1 && !hasSemantic && !wantsBlob);
    const task = intent === 'summary' ? 'summary' : 'answer';
    let ctx = '', parts = null;
    if (wantsBlob) {
      ctx = window.EOEngine.contextScope(scope, q, 6);
    } else if (hasSemantic) {
      parts = window.EOEngine.partsFromHits(scope, semanticHits);
    } else if (useSeek) {
      parts = window.EOEngine.partsFromHits(scope, seekContext(scope, q, budget));
    } else {
      parts = window.EOEngine.contextPartsScope(scope, q, 6);
    }
    AUD('step', 'retrieve', { k: 6, task, engine: 'model-context', hits: auditHits(scope, q, 6) });
    // GRAPH TRAVERSAL (depth > 1): depth buys graph work, not just more
    // retrieval. Walk out from the entities the question names PLUS the
    // entities the conversation field holds hot — an anaphoric follow-up
    // names almost nothing, but the field already carries its anchor, so
    // the walk starts where the conversation has been. The page's
    // assertions, its drawn relations, co-occurrence — the walk's reading
    // heads the prompt, with the sentences attached along the walk as
    // added evidence. The walk itself is recorded as the trace. No entry
    // nodes ⇒ no-op; at the floor graphHops is 0 and wmHeatFloor is ∞,
    // so it never runs and nothing is carried (parity).
    if (budget && budget.graphHops > 0 && task !== 'summary') {
      try {
        const trav = window.EOEngine.traverseScope(scope, q, budget.graphHops,
          window.EOEngine.conversationField, budget.wmHeatFloor);
        if (trav) {
          AUD('step', 'traverse', {
            hops: budget.graphHops, entries: trav.entries, fieldEntries: trav.fieldEntries,
            perDoc: trav.perDoc.map(p => ({
              docId: p.docId, entries: p.entries, fieldEntries: p.fieldEntries, walked: p.walked,
              assertions: p.assertions.map(a => ({ subject: a.subject, is: a.is, sent: a.sent })),
              edges: p.edges,
              evidence: p.sentences.map(s => ({ idx: s.i, via: s.via, text: s.t })),
            })),
          });
          if (parts) {
            const rn = window.EOEngine.readingNotes(scope, trav);
            parts.notes = [...rn.notes, ...parts.notes];
            for (const s of rn.spans)
              if (!parts.spans.some(x => x.docId === s.docId && x.idx === s.idx)) parts.spans.push(s);
          } else {
            ctx = window.EOEngine.readingContext(scope, trav, ctx);
          }
        }
      } catch (e) { eoWarn('traverse', e); }
    }
    // Associative wandering (Phase 3, deepest depth + embedder): warm in spans the
    // page never lexically connects. No embedder ⇒ nothing kept (graph-hop only).
    if (budget && budget.assocCoupling > 0 && window.EOEmbed && window.EOEmbed.ready()) {
      const kept = await associateKept(scope, q, budget);
      if (kept.length) {
        if (parts) {
          const add = window.EOEngine.partsFromHits(scope, kept).spans;
          for (const s of add)
            if (!parts.spans.some(x => x.docId === s.docId && x.idx === s.idx)) parts.spans.push(s);
        } else {
          ctx += '\n' + kept.map(n => `[${n.docId}:${n.i}] ${n.t}`).join('\n');
        }
      }
    }
    // Heat-ranked working memory carried into the prompt (depth > 1; null at floor).
    const wm = buildWMForTurn(scope, q);
    const primaryDoc = window.EOEngine.routePrimary(scope, q) || scope[0];
    // IMPRESSION QUERY (the embedder as a fuzzy graph query): alongside the
    // lexical retrieval, query the page by MEANING — gather the semantically
    // related region and hand the model both the verbatim related spans AND the
    // integral (fold) of that region as a note. Lightweight: only when the
    // embedder is already resident (warmed in the background), reusing the cached
    // sentence vectors. No embedder ⇒ nothing (the lexical paths answer as before).
    if (window.EOEmbed && window.EOEmbed.ready() && primaryDoc && primaryDoc.kind === 'prose'
        && window.EOEngine.impressionQuery) {
      try {
        const imp = await window.EOEngine.impressionQuery(primaryDoc, q, { spans: 4, region: 12 });
        if (imp && (imp.fold || imp.spans.length)) {
          AUD('step', 'impression', { region: imp.idxs.length, spans: imp.spans.map(s => 's' + s.i) });
          const note = window.EOEngine.impressionNote(imp.fold);
          if (parts) {
            if (note) parts.notes = [...parts.notes, note];
            for (const s of imp.spans)
              if (!parts.spans.some(x => x.docId === primaryDoc.id && x.idx === s.i))
                parts.spans.push({ docId: primaryDoc.id, idx: s.i, tag: 's' + s.i, text: s.t });
          } else if (ctx) {
            ctx += (note ? '\n\n' + note : '') + '\n' + imp.spans.map(s => `[s${s.i}] ${s.t}`).join('\n');
          }
        }
      } catch (e) { eoWarn('impression', e); }
    }
    // THE SHAPE PASS (two-stage answering): a small first call characterizes
    // the turn — a director's note on what the user is actually after — and
    // the answer pass speaks freely with that note as guidance, not a leash.
    // It sees the question, recent turns, the doc title, and whether header
    // metadata exists — never the spans or notes, so it decides what KIND of
    // turn this is instead of trying to answer it. Any failure degrades to
    // an empty note and the answer pass runs exactly as before.
    const shapeNote = await shapeFor(scope, q, history, primaryDoc);
    // Best-fit token budget from the matched archetype's length (shape.js §9);
    // undefined keeps today's depth-scaled cap. Reused by the stricter retry.
    const shapeMax = await shapeBudgetFor(q, intent, shapeNote);
    // The relation gate (relation_gate rule, OFF by default). Up, it changes
    // three things on this path: the model tags each claim with the span it
    // used (provenance binds at generation), the tags are consumed by
    // bindClaimKeysScope with the old binder as unkeyed-only fallback, and
    // every draft claim is checked relation-against-relation. Down ⇒ every
    // step below is byte-identical to today (the parity floor).
    const gateOn = !!(window.EOEngine.relationGateEnabled && window.EOEngine.relationGateEnabled());
    try {
      replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
      let full = await window.EOLLM.phrase({
        mlcKey: model.mlc, question: q, contextText: ctx, history, mode: 'grounded', task,
        spans: parts ? parts.spans : null, notes: parts ? parts.notes.join('\n') : '',
        docTitle: (primaryDoc && primaryDoc.name) || '', shapeNote, maxTokens: shapeMax,
        grounded: true, onToken: streamInto({ mode: 'grounded' }), workingMemory: wm,
        depth: budget && budget.level, provenanceKeys: gateOn,
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
        runChat(q, history, 'creative', ctx, true).catch(turnFailed('chat'));
        return;
      }
      // When the model's draft is rejected for an egregious reason (declined,
      // echoed the editor's note, or echoed a single span even after a
      // stricter retry), DON'T substitute a mechanically-generated portrait
      // and present it as if it were the model's reply — that's the "system
      // response" the user reads as Cleon answering when in fact the model
      // failed. Refuse honestly: a plain chat message naming the failure, an
      // audit error step for the trace, and an 'end' that records the
      // refusal. The bind-failure paths below (unbound, contradicts-assertion,
      // kin-mismatch) keep their mechanical fallback — those still have a
      // grounded signal pointing at the page, just not the one the model
      // tried to draft.
      const refuseModel = (reason, message) => {
        const audit = { status: 'error', grounded: false, covers: '0/1', stable: false,
          note: 'Refused — the model\'s draft failed audit (' + reason + '). Rather than substitute a mechanically-generated answer that would look like the model\'s reply, the turn surfaces the failure honestly.' };
        AUD('step', 'error', { where: 'grounded', message: 'refused: ' + reason });
        lastGroundedRef.current = false;
        replaceLast({ role: 'assistant', text: message, audit, mode: 'grounded' });
        AUD('end', { engine: 'refused (' + reason + ')', text: message, audit, cites: [] });
        setBusy(false);
      };
      const settle = (res, decision) => {
        // Only a model-phrased answer can carry an inference void; a mechanical
        // fallback states only what the page does.
        if (decision && decision.indexOf('model') === 0) res = markInferences(res, budget);
        // ACROSS-TURN ECHO: the reply is (near-)identical to one already sent
        // in this chat — a different question landed on the same dead end, or
        // the model reproduced itself. Re-serving it silently is the loop the
        // user reads as "you're not listening"; flag it conversationally.
        try {
          const prior = messages.filter(m => m.role === 'assistant' && m.text && !m.typing).map(m => m.text);
          if (window.EOEngine.echoesPriorReply(res.text, prior)) {
            AUD('step', 'veto', { decision: 'flagged', reason: 'repeats an earlier reply — flagged in the answer' });
            const substantive = !!(res.audit && res.audit.grounded && (res.cites || []).length);
            res = { ...res,
              text: (substantive
                ? 'Same answer as before, for this one too:'
                : 'I notice this is the same answer I gave before — if it isn’t what you’re after, point me at a name or phrase from the text and I’ll chase that instead.')
                + '\n\n' + res.text,
              audit: res.audit ? { ...res.audit, note: 'Repeats an earlier reply (flagged conversationally in the opening line). ' + (res.audit.note || '') } : res.audit };
          }
        } catch (e) { eoWarn('echo flag', e); }
        // The deterministic reading rides along as a click-to-view panel, but
        // only when the MODEL phrased the answer — a mechanical fallback (veto)
        // already IS this reading, so a panel would just echo the reply.
        const showMech = mech && mech.text && /^model/.test(String(decision || '')) && mech.text !== res.text
          ? { text: mech.text, audit: mech.audit, cites: mech.cites || [] } : null;
        replaceLast({ role: 'assistant', text: res.text, audit: res.audit, mode: 'grounded', mechanical: showMech });
        if (res.cites && res.cites.length) setTimeout(() => flashCitation(res.cites[0].docId, res.cites[0].idx), 380);
        depositSettled(scope, q, res.cites);
        noteOpaque(res, decision);                        // edge-of-trace marker (Phase 6)
        AUD('end', { engine: decision, text: res.text, audit: res.audit, cites: res.cites || [] });
      };
      if (modelDeclined(full)) {
        AUD('step', 'veto', { decision: 'refused', reason: 'model declined / empty / leaked reasoning' });
        refuseModel('model_declined',
          'I drafted, but the model came back empty (or refused to answer, or leaked raw reasoning instead of an answer). I’d rather say so than substitute a generated stand-in — try rephrasing, or point me at the line you want me to read.');
      } else if (echoesShapeNote(full, shapeNote)) {
        AUD('step', 'veto', { decision: 'refused', reason: 'echoed the director’s note — meta about the question, not an answer' });
        refuseModel('note_echo',
          'I drafted a reply, but it just paraphrased the editor’s guidance about the question rather than reading the document — that’s a non-answer in the shape of one. I’d rather say so than serve it. Try rephrasing, or point me at a passage you want me to read.');
      } else {
        // DEGENERACY VETO (audit-reject retry, ported from eo-extractor.html):
        // a near-verbatim copy of one retrieved span binds and audits clean but
        // is not an answer — the failure the grounding checks can't see. Reject
        // once, re-prompt the model under a stricter rule, and only then fall to
        // the mechanical answer. Mainly bites summaries on a small model.
        if (echoesASpan(scope, q, full)) {
          AUD('step', 'veto', { decision: 'reject', reason: 'echoes a single span — retrying under a stricter rule' });
          // The stricter rule is an instruction, so it rides the system prompt;
          // the spans/notes tiers stay as they are.
          const stricterSys = window.EOLLM.systemFor('grounded', task, true, (budget && budget.level) || 1, gateOn ? { provenanceKeys: true } : undefined)
            + '\n\nDo NOT copy or lightly reword any single span. Compose a fresh '
            + (task === 'summary' ? 'summary that synthesizes across the spans in your own words.' : 'answer in your own words.');
          let stricterCtx = ctx;
          // Reconsideration (Phase 5, deepest depth): retry via the GAP, not just
          // "stricter" — find what the question still doesn't cover and re-retrieve
          // on it, so the second pass has new material rather than the same spans.
          if (budget && budget.replan) {
            try {
              const support = parts ? parts.spans.map(s => s.text).join(' ') : ctx;
              const gaps = window.EOEngine.coverageGaps(q, support);
              if (gaps.uncovered.length) {
                const more = window.EOEngine.retrieveScope(scope, gaps.uncovered.join(' '), 4) || [];
                if (more.length) {
                  if (parts) {
                    for (const s of window.EOEngine.partsFromHits(scope, more).spans)
                      if (!parts.spans.some(x => x.docId === s.docId && x.idx === s.idx)) parts.spans.push(s);
                  } else {
                    stricterCtx += '\n' + window.EOEngine.contextFromHits(scope, more);
                  }
                  AUD('step', 'plan-seg', { from: 'echo-veto', to: 'gap-retrieve', reason: 'uncovered: ' + gaps.uncovered.join(', ') });
                }
              }
            } catch (e) { eoWarn('veto-gap', e); }
          }
          let retry = '';
          try {
            replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
            retry = await window.EOLLM.phrase({
              mlcKey: model.mlc, question: q, contextText: stricterCtx, history, mode: 'grounded', task,
              spans: parts ? parts.spans : null, notes: parts ? parts.notes.join('\n') : '',
              docTitle: (primaryDoc && primaryDoc.name) || '', shapeNote, sysOverride: stricterSys, maxTokens: shapeMax,
              grounded: true, onToken: streamInto({ mode: 'grounded' }), workingMemory: wm,
              depth: budget && budget.level, provenanceKeys: gateOn,
            });
            retry = window.EOEngine.dedupeSentences(retry);
          } catch (e) { retry = ''; }
          // If the retry still echoes (or came back empty), the model can't do
          // this turn — refuse honestly rather than substitute a mechanical
          // portrait. The portrait would land as if it were the model's reply.
          if (!retry || retry.trim().length < 3 || echoesASpan(scope, q, retry)) {
            AUD('step', 'veto', { decision: 'refused', reason: 'retry still echoed — refusing rather than serving a mechanical stand-in' });
            refuseModel('echo_after_retry',
              'I drafted, retried under a stricter rule, and both attempts just echoed a single passage instead of synthesizing — the model can’t do this turn. I’d rather say so than substitute a fallback. Try a more specific question, or point me at the line you want me to read.');
            return;
          }
          full = retry;   // retry produced a real answer; fall through to bind it
        }
        // SOFTENED VETO across the whole scope. The page still overrules the
        // model, but a draft that genuinely binds is no longer thrown away whole
        // just because it named one unsupported term — that term is marked as a
        // void and the (better) phrasing is kept, badged as a caveat. Only a
        // draft that won't bind to ANY source falls back to the mechanical answer.
        // With the gate up the draft carries the model's own span tags —
        // strip them for the term/claim checks so a tag never reads as an
        // invented term; the keyed binder consumes them from `full` itself.
        const fullForChecks = gateOn ? full.replace(/\[s(?:\d+|\?)\]/g, ' ') : full;
        const perDoc = scope.map(d => new Set(window.EOEngine.inventedTerms(d, fullForChecks)));
        const invented = perDoc.length ? [...perDoc[0]].filter(t => perDoc.every(s => s.has(t))) : [];
        let bound = (gateOn && window.EOEngine.bindClaimKeysScope)
          ? window.EOEngine.bindClaimKeysScope(scope, full, q, intent, { hotEntity: hotEntity() })
          : window.EOEngine.bindCitationsScope(scope, full, q, intent, { hotEntity: hotEntity() });
        // KIN-SUBJECT VETO (every depth — binding is not correctness): a
        // claim can bind cleanly to a kin sentence ("…his son served as
        // Director…") while hanging the kin's role on the POSSESSOR — the
        // citation is faithful to a real sentence and still misattributes
        // its subject. The parse recorded who the possessive resolves to;
        // check the draft's subjects against it, claim against record.
        let kinMismatches = [];
        try { kinMismatches = window.EOEngine.checkKinSubjectsScope(scope, fullForChecks) || []; }
        catch (e) { eoWarn('kin-subject-check', e); }
        // RELATION GATE (relation_gate rule): the draft's claims checked
        // relation-against-relation — agency inversion, wrong speaker, a
        // named subject the edge doesn't carry. Its own audit step, every
        // run; flag down ⇒ never reached.
        let relationMismatches = [];
        if (gateOn && window.EOEngine.checkRelationsScope) {
          try { relationMismatches = await window.EOEngine.checkRelationsScope(scope, fullForChecks) || []; }
          catch (e) { eoWarn('relation-check', e); }
          AUD('step', 'relation-gate', {
            keyed: bound.keyed || 0,
            held: (bound.held || []).map(h => ({ key: h.key, claim: h.claim })),
            mismatches: relationMismatches.map(m => ({ kind: m.kind, claim: m.claim, docId: m.docId,
              edge: m.edge ? `${m.edge.s} —${m.edge.v}→ ${m.edge.o}` : null, sent: m.edge ? m.edge.sent : null })),
          });
        }
        // GROUNDING ENVELOPE (mechanism D, embedder-backed): each cited
        // claim's embedding distance to the span its OWN footnote names —
        // drift from the cited source flags; style never does. Vacuous
        // without the embedder; its own audit step when it checks anything.
        if (gateOn && window.EOEmbed && window.EOEmbed.ready() && window.EOEngine.groundingEnvelope && primaryDoc) {
          try {
            const env = await window.EOEngine.groundingEnvelope(primaryDoc, bound.text);
            if (env.checked) {
              AUD('step', 'envelope', { checked: env.checked, leaks: env.leaks,
                impressionistic: env.impressionistic, strong: env.strong,
                rows: env.rows.map(r => ({ idx: r.idx, cos: r.cos, band: r.band })) });
              if (env.leaks) bound = { ...bound, audit: { ...bound.audit, status: 'warn',
                note: (bound.audit.note || '') + ` ${env.leaks} cited claim(s) drifted from their own span (embedding envelope) — treat those citations with care.` } };
            }
          } catch (e) { eoWarn('envelope', e); }
        }
        // PROPOSITIONAL VETO (every depth — promoted from behind the dial):
        // the string-layer checks above wave through a draft that NEGATES what
        // the page itself asserted — "X was not Y" binds cleanly while the
        // graph holds DEF X is Y. Audit the draft's claims against the page's
        // recorded assertions, claim against claim; a contradiction falls back
        // to the mechanical answer with the disagreement named in the trace.
        let contradictions = [];
        if (budget && budget.assertionCheck) {
          try { contradictions = window.EOEngine.checkAssertionsScope(scope, fullForChecks) || []; }
          catch (e) { eoWarn('assertion-check', e); }
        }
        // The user asked for this: when the model's draft trips a binding or
        // consistency check, KEEP the model's answer and flag it rather than
        // silently swapping in the mechanical reading. The mechanical reading
        // still rides along as the click-to-view "Exact mechanical reading"
        // panel (settle attaches it for any 'model…' decision), so the page's
        // own answer is never lost — the model's phrasing just leads, wearing
        // an honest caveat badge.
        const flagModel = (reason, note) => {
          const flagged = { ...bound,
            audit: { ...(bound.audit || {}), status: 'warn',
              note: note + (bound.audit && bound.audit.note ? ' ' + bound.audit.note : '') } };
          settle(flagged, 'model (flagged: ' + reason + ')');
        };
        if (!bound.audit.grounded) {
          // Unmoored: the phrasing matched no passage. Kept and flagged; the
          // mechanical reading is one click away.
          if (budget && budget.replan) AUD('step', 'plan-seg', { from: 'factual', to: 'question-about-silence', reason: 'the draft bound to nothing on the page' });
          AUD('step', 'veto', { decision: 'model-flagged', reason: 'unbound', invented, boundGrounded: false, boundCovers: bound.audit.covers });
          flagModel('unbound', 'Phrased by the model, but it didn’t bind to any passage in the document — kept and flagged. The exact mechanical reading is one click away.');
        } else if (contradictions.length) {
          AUD('step', 'veto', { decision: 'model-flagged', reason: 'contradicts-assertion',
            contradictions: contradictions.map(c => ({ subject: c.subject, is: c.is, sent: c.sent, claim: c.claim, docId: c.docId })),
            boundGrounded: true, boundCovers: bound.audit.covers });
          flagModel('contradicts-assertion', 'Kept the model’s answer, but it conflicts with what the page asserts (see the trace) — flagged. The page’s mechanical reading is one click away.');
        } else if (relationMismatches.length) {
          // A claim whose relation contradicts its deposited edge: kept but
          // flagged, mirroring the assertion and kin flags.
          AUD('step', 'veto', { decision: 'model-flagged', reason: 'relation-mismatch',
            relationMismatches: relationMismatches.map(m => ({ kind: m.kind, claim: m.claim, docId: m.docId })),
            boundGrounded: bound.audit.grounded, boundCovers: bound.audit.covers });
          flagModel('relation-mismatch', 'Kept the model’s answer, but one claim’s relation doesn’t match the page’s recorded edge — flagged. The mechanical reading is one click away.');
        } else if (kinMismatches.length) {
          AUD('step', 'veto', { decision: 'model-flagged', reason: 'kin-subject-mismatch',
            kinMismatches: kinMismatches.map(m => ({ possessor: m.possessor, kin: m.kin, sent: m.sent, claim: m.claim, docId: m.docId })),
            boundGrounded: bound.audit.grounded, boundCovers: bound.audit.covers });
          flagModel('kin-subject-mismatch', 'Kept the model’s answer, but it may hang a role on the wrong person (kin vs possessor) — flagged. The mechanical reading is one click away.');
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

  // A streaming path (grounded / chat) runs DETACHED from runTurn — it is fired
  // and not awaited, then resets busy itself when it settles. If its promise
  // rejects instead, nothing else releases the composer, and a stranded `busy` is
  // exactly what silently stops the user from sending again. Attach this to every
  // such dispatch so a failure there still resets busy and surfaces it honestly.
  const turnFailed = (where) => (e) => {
    eoWarn(where, e);
    try { AUD('step', 'error', { where, fatal: true, message: String((e && e.message) || e) }); } catch (_) {}
    replaceLast({ role: 'assistant', text: 'Something went wrong while answering — please try again.', audit: null });
    try { AUD('end', { engine: 'none', text: '', audit: null, reason: where + '-error' }); } catch (_) {}
    setBusy(false);
  };

  // Outer guard around turn routing: a throw in the router itself (or in an
  // awaited router step like the escalation retrieval) must never leave busy
  // stuck true. runTurn dispatches to the detached streaming paths and returns;
  // this only catches a synchronous routing fault or a rejected await within it.
  const send = async (text) => {
    try { await runTurn(text); }
    catch (e) {
      eoWarn('send', e);
      try { AUD('step', 'error', { where: 'send', fatal: true, message: String((e && e.message) || e) }); } catch (_) {}
      replaceLast({ role: 'assistant', text: 'Something went wrong starting that turn — please try again.', audit: null });
      try { AUD('end', { engine: 'none', text: '', audit: null, reason: 'send-error' }); } catch (_) {}
      setBusy(false);
    }
  };

  const runTurn = async (text) => {
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
    const canLLM = !!(window.EOLLM && (model.provider === 'anthropic'
      ? window.EOLLM.hasAnthropicKey()
      : model.provider === 'wllama'
      ? (!window.EOLLM.hasWasm || window.EOLLM.hasWasm())
      : window.EOLLM.hasWebGPU()));
    const wasLoaded = canLLM && window.EOLLM.isLoaded(model.mlc);

    // Resolve this turn's budget at the deepest stop (thinkingBudget clamps to
    // its DEPTH_LEVELS ceiling). Decay the conversation field one tick of
    // conversational time at turn start, before this turn deposits into it —
    // recent topics stay warm, dropped ones cool.
    const budget = (window.EOEngine && window.EOEngine.thinkingBudget) ? window.EOEngine.thinkingBudget(999) : null;
    turnBudgetRef.current = budget;
    turnAssocRef.current = [];
    try { window.EOEngine && window.EOEngine.conversationField && window.EOEngine.conversationField.decayTurn(); }
    catch (e) { eoWarn('field decay', e); }

    // Open the turn's audit record before anything branches, so the routing
    // decision, model load, retrieval and the model call all attach to it.
    const auditId = AUD('begin', {
      input: q, mode, budget,
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
      patchLast({ typing: false, loading: true, loadPct: modelProgress, loadName: model.name, loadCloud: model.provider === 'anthropic', loadCpu: model.provider === 'wllama' });
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
      runChat(q, history, 'creative', ctx, scope.length > 0).catch(turnFailed('chat')); return;
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
      runChat(q, history, 'creative', ctx, scope.length > 0).catch(turnFailed('chat')); return;
    }

    // COST-ORDERED ROUTING (existence → structure → significance). The router is
    // mechanical and cheap; it returns a band. Only the 'escalate' band pays for
    // embedding recall, and only the cheap layers ever DECIDE — the model phrases.
    let route;
    if (mode === 'grounded' && scope.length) {
      route = { decision: 'mechanical', confidence: 'forced', reason: 'grounded-mode',
                primary: window.EOEngine.routePrimary(scope, q) || scope[0] };
    } else if (scope.length) {
      // hadReply: repair needs a conversation to repair — any settled assistant
      // reply counts, grounded or not (the trace's "someone's son is mentioned"
      // followed a PLAIN-chat miss, so prevGrounded alone would drop it).
      const hadReply = messages.some(m => m.role === 'assistant' && m.text && !m.typing && !m.loading);
      route = window.EOEngine.routeTurn(scope, q, { prevGrounded: lastGroundedRef.current, hadReply, everGrounded: everGroundedRef.current });
    } else {
      route = { decision: 'chat', confidence: 'none', reason: 'no-scope' };
    }

    // REPAIR: the turn pushes back on the previous reply rather than asking
    // fresh content. Mark the rejected reply (history hygiene), then re-read
    // the question actually under repair instead of retrieving on the complaint.
    if (route.decision === 'repair') {
      const primary = route.primary || window.EOEngine.routePrimary(scope, q) || scope[0];
      AUD('step', 'route', { referencing: true, reason: route.reason, confidence: route.confidence,
        path: 'repair', primary: primary ? { id: primary.id, name: primary.name, kind: primary.kind } : null });
      markObjected();
      runRepairScope(scope, q, history, route.repair || { kind: 'frustration', content: false }).catch(turnFailed('repair'));
      return;
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

    // CARRY-GROUNDED: a follow-up with no lexical signal of its own is re-asked
    // THROUGH the previous grounded turn's material — its question plus its
    // cited sentences (verbatim page text) seed the retrieval the bare turn
    // can't. Two shapes ride it: a turn the router already kept on the page as
    // continuity ("but why not?", "tell me more about it" — which used to pass
    // routing and then die at the runner's no-ground check), and a failed
    // escalate (question-no-lexical) in a conversation that HAS been on the
    // page — the observed cascade where "what is the craziest stuff in there?"
    // fell to plain chat and the model could only parrot its previous answer.
    // No carry material, or nothing retrieved through it ⇒ exactly the old
    // behavior.
    if (!semanticHits && lastCarryRef.current
        && (lastGroundedRef.current || everGroundedRef.current)
        && (route.reason === 'continuity'
            || (route.decision === 'chat' && route.reason === 'question-no-lexical'))) {
      const cq = carryQuery(scope, q);
      let carryHits = [];
      try { carryHits = cq ? window.EOEngine.retrieveScope(scope, cq, 6) : []; } catch (e) { eoWarn('carry', e); }
      AUD('step', 'carry', { reason: route.reason, found: carryHits.length,
        recovered: !!(carryHits.length && route.decision === 'chat') });
      if (carryHits.length) {
        semanticHits = carryHits;
        if (route.decision === 'chat') {
          route.decision = 'mechanical'; route.confidence = 'carry';
          route.reason += '+carry';
          route.primary = route.primary || window.EOEngine.routePrimary(scope, cq) || scope[0];
        }
      }
    }

    const referencing = route.decision === 'mechanical';
    lastGroundedRef.current = referencing;
    if (referencing) everGroundedRef.current = true;

    if (referencing) {
      const primary = route.primary || window.EOEngine.routePrimary(scope, q) || scope[0];
      const useLLM = ready && primary && primary.kind === 'prose';
      AUD('step', 'route', { referencing: true, reason: route.reason, confidence: route.confidence,
        path: useLLM ? 'grounded-llm' : 'mechanical',
        primary: primary ? { id: primary.id, name: primary.name, kind: primary.kind } : null });
      if (useLLM) { runGroundedScope(scope, q, history, semanticHits).catch(turnFailed('grounded')); return; }
      runMechanicalScope(scope, q); return;   // tables, or no model → mechanical pivot / grounded answer
    }

    // plain chat
    AUD('step', 'route', { referencing: false, reason: route.reason, path: ready ? 'plain-chat' : 'plain-unavailable' });
    if (ready) { runChat(q, history, undefined, '', !!doc).catch(turnFailed('chat')); return; }
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
  const newChat = () => { setMessages([]); setActiveChat('new'); lastGroundedRef.current = false; everGroundedRef.current = false; lastCarryRef.current = null; repairCountRef.current = 0; resetField(); if (mobileRef.current) setCollapsed(true); };
  const selectChat = (id) => { setActiveChat(id); lastGroundedRef.current = false; everGroundedRef.current = false; lastCarryRef.current = null; repairCountRef.current = 0; resetField(); if (mobileRef.current) setCollapsed(true); };

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
        onUpload={() => fileRef.current && fileRef.current.click()}
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
            <Icon name="activity" size={15} /> <span className="tb-pill-lbl">Glass box{auditCount ? ' · ' + auditCount : ''}</span>
            {auditEnabled && <span className="dot rec" title="Recording" />}
          </button>
          {docs.some(d => d.kind === 'prose') && (
            <button className="tb-pill tb-pill-adv" onClick={() => setGraphAuditOpen(true)} title="Ingestion audit — the graph as it is built, word by word, in reading order, with full provenance">
              <Icon name="book" size={15} /> <span className="tb-pill-lbl">Ingestion</span>
            </button>
          )}
          <button className="tb-pill" onClick={() => setRulesOpen(true)}><Icon name="layers" size={15} /> <span className="tb-pill-lbl">{enabledRules} rules on</span></button>
          {window.EVO_SANDBOX && <button className="tb-pill tb-pill-adv" onClick={() => setSandboxOpen(true)} title="Sandbox — evolve the reading laws in an isolated in-browser engine; the agent proposes, you select"><Icon name="sparkle" size={15} /> <span className="tb-pill-lbl">Sandbox</span></button>}
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
                  <ChatPane messages={messages} onCite={flashCitation} composerProps={composerProps} narrow={showDocPane} wide={layout === 'chat'} onExportPrompts={exportPrompts} />
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
      {sandboxOpen && <SandboxDrawer onClose={() => setSandboxOpen(false)} onToast={showToast} mlcKey={model && model.mlc} modelReady={modelStatus === 'ready'} />}
      {auditOpen && <AuditDrawer onClose={() => setAuditOpen(false)} enabled={auditEnabled} onToggle={toggleAudit} onToast={showToast}
                      docs={docs} exportIngestion={exportIngestion} exportOutput={exportOutput}
                      onExportIngestion={setExportIngestion} onExportOutput={setExportOutput} />}
      {graphAuditOpen && <GraphAuditDrawer onClose={() => setGraphAuditOpen(false)} onToast={showToast} docs={docs} />}
      {modelOpen && <ModelPopover models={window.MODELS} current={model} onPick={pickModel} onClose={() => setModelOpen(false)} anchor={{ left: 16, bottom: 64 }}
                     status={modelStatus} progress={modelProgress} loadText={modelLoadText} onReset={resetModel} onCancel={cancelModel}
                     webgpu={!!(window.EOLLM && window.EOLLM.hasWebGPU && window.EOLLM.hasWebGPU())}
                     anthropicKeySet={anthropicKeySet} onSetAnthropicKey={setAnthropicKey} />}
      {entityModal && (() => { const d = docsById[entityModal.docId]; return d ? (
        <EntityModal doc={d} name={entityModal.name} onCite={flashCitation} onEntity={(n) => setEntityModal({ docId: d.id, name: n })}
          onOpenTab={openEntityTab} onClose={() => setEntityModal(null)} />
      ) : null; })()}
      {dragOver && <div className="drop-veil"><div className="drop-card"><Icon name="upload" size={26} /> Drop to read</div></div>}
      {ingestStatus && (() => {
        const easing = !!ingestStatus.easing;
        const curIdx = INGEST_PHASES.findIndex(p => p.id === ingestStatus.phase);
        const indet = easing || ingestStatus.pct == null;
        return (
          <div className={'ingest-banner' + (easing ? ' easing' : '')} role="status" aria-live="polite">
            <span className={'ib-orb' + (easing ? ' easing' : '')} aria-hidden="true" />
            <div className="ib-main">
              <div className="ib-head">
                <span className="ib-stage">{INGEST_LABEL[ingestStatus.stage] || ingestStatus.stage}</span>
                {ingestStatus.name && <span className="ib-name">· {ingestStatus.name}</span>}
                {easing && ingestStatus.usedMB != null
                  ? <span className="ib-mem" title="Holding under the memory ceiling so the tab stays stable">{ingestStatus.usedMB} / {ingestStatus.capMB} MB</span>
                  : ingestStatus.pct != null && <b className="ib-pct">{Math.round(ingestStatus.pct * 100)}%</b>}
              </div>
              <div className="ib-bar"><div className={'ib-fill' + (indet ? ' indet' : '') + (easing ? ' ease' : '')}
                style={!indet ? { width: Math.round(ingestStatus.pct * 100) + '%' } : undefined} /></div>
              <div className="ib-steps" aria-hidden="true">
                {INGEST_PHASES.map((p, i) => (
                  <span key={p.id} className={'ib-step' + (curIdx > i ? ' done' : curIdx === i ? ' on' : '')}>
                    <span className="ib-dot" />{p.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
      {toast && <div className="toast"><span className="tk"><Icon name="check" size={15} /></span>{toast}</div>}
    </div>
  );
}

// A single render throw used to blank #root with no recovery; this catches it
// and offers a reload instead of a white screen. (§5)
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { if (typeof console !== 'undefined') console.error('[Cleon] render error', err, info); }
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
