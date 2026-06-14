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
const eoWarn = (...a) => { if (typeof window !== 'undefined' && window.EO_DEBUG) console.warn('[Cleo]', ...a); };
if (typeof window !== 'undefined') window.eoWarn = eoWarn;

// Audit log shim — records the chat pipeline when window.EOAudit is present,
// and no-ops cleanly when it isn't. Keeps the call sites in the chat path terse.
const AUD = (m, ...a) => { try { const A = window.EOAudit; return A && A[m] ? A[m](...a) : undefined; } catch (e) { eoWarn('audit', m, e); } };
const auditScope = (scope) => (scope || []).map(d => ({ id: d.id, name: d.name, kind: d.kind }));

// ---- computational grounding helpers (pyodide.js) ----
// A table doc keeps no raw CSV (the parser returns columns + rows); rebuild it
// faithfully so Python reads the same data the user sees, entirely on-device.
const csvCell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const tableToCSV = (doc) => {
  const cols = doc.columns || [];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of (doc.rows || [])) lines.push(cols.map(c => csvCell(r[c])).join(','));
  return lines.join('\n');
};
// A safe, stable filename for the in-FS CSV the model's code will read.
const tableSlug = (doc) => (String(doc.name || 'data').replace(/\.[^.]*$/, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'data') + '.csv';
// The SCHEMA the model needs to write code — column names, inferred types, and a
// few sample rows. On the Claude path this (not the full table) is what travels:
// the code runs locally over the whole file, but the model only sees the shape.
const tableSchemaText = (doc, fileName) => {
  const cols = doc.columns || [];
  const typeOf = (c) => (doc.money || []).includes(c) ? 'money' : (doc.numeric || []).includes(c) ? 'number'
    : (doc.date || []).includes(c) ? 'date' : 'text';
  const colLines = cols.map(c => '  - ' + c + ' (' + typeOf(c) + ')').join('\n');
  const sample = (doc.rows || []).slice(0, 5);
  const sampleCSV = [cols.join(',')].concat(sample.map(r => cols.map(c => csvCell(r[c])).join(','))).join('\n');
  return 'A CSV file named "' + fileName + '" is available in the working directory (read it with pandas: pd.read_csv("' + fileName + '")).\n'
    + 'It has ' + (doc.rows || []).length + ' rows and these columns:\n' + colLines
    + '\n\nThe first few rows:\n' + sampleCSV;
};
// Pull the first fenced Python block out of a local model's reply, mechanically
// (the rest of Cleo extracts structure by parsing, never by trusting the model
// to self-report). Empty string when there is no block.
const extractPyFence = (text) => {
  const m = /```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/i.exec(String(text || ''));
  return m ? m[1].trim() : '';
};
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
// download, runs anywhere. On a desktop Llama 3.2 3B in q4f16_1 is the sweet
// spot: strong synthesis, ~2.3 GB downloads once and stays on disk via OPFS/
// IndexedDB, and the fp16 build runs faster than fp32 on Apple Silicon and
// any healthy fp16 GPU. Either can be switched live from the picker; switching
// now releases the old model before loading the new.
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
  return (phone ? by('qwen-05') : by('llama-3')) || by('llama-1') || window.MODELS[0];
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
  // The answer-mode control (Auto / Grounded / Creative) in the composer is
  // hidden by default — every chat just runs on Auto, which reads each question
  // and grounds or composes on its own. A reader who wants the explicit toggle
  // back turns it on in Settings; the choice persists with prefs. While it's
  // hidden the mode is held at 'auto' (the effect below), so a value left over
  // from when it was shown can't keep steering turns from behind a hidden control.
  const [showModeToggle, setShowModeToggle] = useState(false);
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
  // Device-local preferences, gathered in the Settings drawer. Theme is
  // 'system' | 'light' | 'dark' (system follows the OS); reduce-motion mutes
  // animation. Both persist with prefs and apply to <html> via the effects below.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState('system');
  const [reduceMotion, setReduceMotion] = useState(false);
  // Computational grounding (pyodide.js): when on, a computational turn may run
  // Python locally over the loaded document (on by default). The pref persists
  // through savePrefs like theme/reduce-motion, and is wired to EOPython on load
  // and on change. EOPython owns its own persisted flag too, so enabled() is
  // authoritative even before the React tree hydrates.
  // Computational grounding (pyodide) is ON by default — a returning user's
  // stored choice still wins during hydration. The runtime is fetched only on
  // the first actual run, so default-on costs nothing at load.
  const [pythonEnabled, setPythonEnabled] = useState(true);
  const [auditEnabled, setAuditEnabled] = useState(() => (window.EOAudit ? window.EOAudit.isEnabled() : true));
  // Show the per-answer grounding badge (grounded · covers · stable + its note).
  // Some readers want the answer without the audit chrome; persisted with prefs.
  const [groundingInfo, setGroundingInfo] = useState(true);
  const [auditCount, setAuditCount] = useState(0);
  // Glass-box export toggles: include the extraction half (graph + processing)
  // and/or the chat half (audit turns). Persisted with prefs. Both on by default.
  const [exportIngestion, setExportIngestion] = useState(true);
  const [exportOutput, setExportOutput] = useState(true);
  // Wikipedia reference desk (external.js): tri-state. 'off' never contacts it
  // (fully local); 'auto' (default) takes a stab only when a turn passes the
  // acquisition gate (an explicit "look up X" with the subject not already in the
  // corpus); 'on' takes a stab on every substantive message. A stab is only the
  // lightweight OPTIONS search — a full article is pulled in only when the reader
  // picks a candidate — so even 'on' never eagerly fetches.
  const [wikiMode, setWikiMode] = useState('auto');
  // Per-message reference-desk FORCE ("take a stab now"): the composer Wikipedia
  // button (in the 'auto'/'on' modes) flags THIS message to search Wikipedia for
  // options, bypassing the acquisition gate. One-shot — consumed/cleared on send.
  const [forceEnrich, setForceEnrich] = useState(false);
  const [model, setModel] = useState(defaultModel);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelStatus, setModelStatus] = useState('idle'); // idle | loading | ready
  const [modelProgress, setModelProgress] = useState(0);
  const [modelLoadText, setModelLoadText] = useState(''); // WebLLM's live status line ("12MB fetched…", "Loading GPU shaders…")
  // User-picked backup models, in order. Three slots; an unset slot is null.
  // When the active model fails to load (stalls, no WebGPU, etc.) the load
  // path walks this list (skipping the model that just failed and any backups
  // that can't run here) before falling back to the automatic CPU pick.
  // Persisted with prefs as `fallbackModelIds`.
  const [fallbackModelIds, setFallbackModelIds] = useState([null, null, null]);
  // User-uploaded GGUF models. Session-only: the File reference is held in
  // llm.js's in-memory registry and lost on refresh, so these entries are not
  // persisted to prefs.
  const [uploadedModels, setUploadedModels] = useState([]);
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
  // Smart parse: route data questions through the schema-aware resolver (model
  // in the loop, back-and-forth on ambiguity). On by default; remembered.
  const [smartParse, setSmartParse] = useState(true);
  // Saved views per table: { [docId]: [{ id, name, spec, createdAt }] }. Shown
  // under the table and reopenable as a tab. Persisted in prefs.
  const [savedViews, setSavedViews] = useState({});

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
        const big = (d._text ? d._text.length : 0) > 1500000;
        setIngestStatus({ phase: 'structure', stage: 'reading', pct: 0, name: d.name, big });
        let nd;
        try {
          nd = await window.EOEngine.parseDocument(d._name || d.name, d._text, d.id, (p) => {
            if (tok !== ingestTok.current) return;
            setIngestStatus({ phase: p.phase, stage: p.stage, pct: p.total ? p.done / p.total : null, name: d.name, big,
              done: p.done, total: p.total,
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
    if (!window.EOStore) { try { if (window.EOPython) window.EOPython.setEnabled(true); } catch (e) {} hydrated.current = true; setBootReady(true); return; }
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
        if (Array.isArray(prefs.fallbackModelIds)) {
          const slots = [null, null, null];
          for (let i = 0; i < 3; i++) {
            const id = prefs.fallbackModelIds[i];
            if (id && window.MODELS.find(x => x.id === id)) slots[i] = id;
          }
          setFallbackModelIds(slots);
        }
        if (Array.isArray(prefs.projects)) { setProjects(prefs.projects); bumpUid(prefs.projects.map(p => p.id)); }
        if (prefs.activeProject) setActiveProject(prefs.activeProject);
        if (prefs.mode) setMode(prefs.mode);
        if (typeof prefs.showModeToggle === 'boolean') setShowModeToggle(prefs.showModeToggle);
        if (typeof prefs.splitRatio === 'number') setSplitRatio(prefs.splitRatio);
        if (typeof prefs.explore === 'boolean') setExplore(prefs.explore);
        if (typeof prefs.auditEnabled === 'boolean') { setAuditEnabled(prefs.auditEnabled); if (window.EOAudit) window.EOAudit.setEnabled(prefs.auditEnabled); }
        if (typeof prefs.exportIngestion === 'boolean') setExportIngestion(prefs.exportIngestion);
        if (typeof prefs.exportOutput === 'boolean') setExportOutput(prefs.exportOutput);
        // Reference-desk mode (tri-state). Prefer a stored wikiMode; else migrate
        // the legacy boolean — true (eager) → 'on', false (the old default) →
        // 'auto' (the new gated default). New users with neither key keep 'auto'.
        if (prefs.wikiMode === 'off' || prefs.wikiMode === 'auto' || prefs.wikiMode === 'on') setWikiMode(prefs.wikiMode);
        else if (typeof prefs.wikiEnrich === 'boolean') setWikiMode(prefs.wikiEnrich ? 'on' : 'auto');
        if (prefs.theme === 'system' || prefs.theme === 'light' || prefs.theme === 'dark') setTheme(prefs.theme);
        if (typeof prefs.reduceMotion === 'boolean') setReduceMotion(prefs.reduceMotion);
        if (typeof prefs.groundingInfo === 'boolean') setGroundingInfo(prefs.groundingInfo);
        if (typeof prefs.pythonEnabled === 'boolean') { setPythonEnabled(prefs.pythonEnabled); if (window.EOPython) window.EOPython.setEnabled(prefs.pythonEnabled); }
        else if (window.EOPython) window.EOPython.setEnabled(true);   // computational grounding on by default for new users
        if (typeof prefs.smartParse === 'boolean') setSmartParse(prefs.smartParse);
        if (prefs.savedViews && typeof prefs.savedViews === 'object') setSavedViews(prefs.savedViews);
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
    window.EOStore.savePrefs({ rules, langModes, modelId: model.id, fallbackModelIds, mode, showModeToggle, splitRatio, explore, projects, activeProject, auditEnabled, exportIngestion, exportOutput, wikiMode, theme, reduceMotion, groundingInfo, pythonEnabled, smartParse, savedViews });
  }, [rules, langModes, model, fallbackModelIds, mode, showModeToggle, splitRatio, explore, projects, activeProject, auditEnabled, exportIngestion, exportOutput, wikiMode, theme, reduceMotion, groundingInfo, pythonEnabled, smartParse, savedViews]);
  // Hiding the answer-mode control means every turn runs on Auto: hold `mode`
  // there whenever the toggle is off, so a 'grounded'/'creative' left in prefs
  // (or any stray set) can't keep steering turns from behind a hidden control.
  // Re-enabling the toggle simply leaves the reader on Auto to start from.
  useEffect(() => { if (!showModeToggle && mode !== 'auto') setMode('auto'); }, [showModeToggle, mode]);
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

  // Apply the theme to <html data-theme>. In 'system' mode, follow the OS and
  // re-resolve when it flips. The early inline script in index.html sets the
  // first paint; this keeps it in sync as the preference changes.
  useEffect(() => {
    const apply = () => (window.EOTheme ? window.EOTheme.apply(theme) : null);
    apply();
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => apply();
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on); };
  }, [theme]);
  useEffect(() => {
    try { document.documentElement.classList.toggle('reduce-motion', !!reduceMotion); } catch (e) {}
  }, [reduceMotion]);
  // Wire the computational-grounding pref through to EOPython on change (and on
  // load, above). EOPython.setEnabled only flips a flag — it never loads the
  // runtime, which stays lazy until the first actual run.
  const setPython = useCallback((v) => { setPythonEnabled(!!v); try { if (window.EOPython) window.EOPython.setEnabled(!!v); } catch (e) {} }, []);

  // The one destructive affordance: wipe every device-local trace and reload
  // cold. hydrated is flipped off first so the debounced persistence effects
  // can't re-save state on the way out.
  const clearLocalData = useCallback(async () => {
    hydrated.current = false;
    try { if (window.EOAudit && window.EOAudit.clear) window.EOAudit.clear(); } catch (e) {}
    try { if (window.EOStore && window.EOStore.clearAll) await window.EOStore.clearAll(); } catch (e) {}
    try { location.reload(); } catch (e) {}
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
    // The implicit grounding doc follows what's actually OPEN. A closed/detached
    // document must not linger as scope: once you move on, plain chat shouldn't
    // be answered against a doc you've put away. (The old `docs[last]` fallback
    // kept the last-loaded doc in scope forever, even with no tab open.)
    if (activeTab && openTabs.includes(activeTab)) {
      if (activeTab.startsWith('@ent/')) return docsById[activeTab.split('/')[1]] || null;
      if (docsById[activeTab]) return docsById[activeTab];
    }
    for (let i = openTabs.length - 1; i >= 0; i--) {
      const t = openTabs[i];
      const id = t && t.startsWith('@ent/') ? t.split('/')[1] : t;
      if (docsById[id]) return docsById[id];
    }
    return null;
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
    // Closing a document detaches it from the conversation's implicit scope, so
    // plain chat after you move on isn't answered against a doc you've put away.
    // A named project owns its source set explicitly, so leave those alone.
    if (!activeProject) setSources(s => s.filter(x => x !== id));
  };

  // ---- the convention proposer (idle, budgeted, toggleable) ----
  // After a parse leaves registered friction, and only when the local model
  // is loaded and the chat is quiet, run one proposal turn at idle priority.
  // The engine owns everything that matters (friction, the closed grammar,
  // anchors, admission); this is just the scheduler. Never blocks a turn:
  // if the chat takes the floor before the idle slot fires, stand down.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  // Generation guard: every turn captures the current value at dispatch; Stop
  // (and the start of a fresh turn) bumps it, so any in-flight settle that wakes
  // up afterward sees itself superseded and stands down rather than clobbering
  // the stopped reply. The same token pattern the ingest path uses.
  const genRef = useRef(0);
  const genStale = (g) => genRef.current !== g;
  // A live mirror of `messages` so stopTurn can read the in-flight turn's shape
  // synchronously (from a click handler) without going stale on a closure.
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Monotonic turn clock — FIX 3: stamps enrichment-ingested docs so the
  // provisional sweep can reap ones that never grounded an answer after a few turns.
  const turnSeqRef = useRef(0);
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
    // A big paste is read deliberately — staged and breathed so the tab stays
    // alive — so the banner says so rather than looking stalled.
    const big = (text ? text.length : 0) > 1500000;
    setBusy(true);
    setIngestStatus({ phase: 'existence', stage: 'loading', pct: 0, name, big });
    let doc;
    try {
      doc = await window.EOEngine.parseDocument(name, text, id, (p) => {
        if (tok !== ingestTok.current) return;          // superseded — stop reporting
        const pct = p.total ? p.done / p.total : null;
        setIngestStatus({ phase: p.phase, stage: p.stage, pct, name, big,
          done: p.done, total: p.total,
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

  // Whether a model can even attempt to load here — Claude needs its key,
  // wllama needs WebAssembly, WebLLM needs WebGPU. Lets the fallback walker
  // skip a backup that has no chance instead of burning a slot on a guaranteed
  // failure. Mirrors the per-provider gates in loadModel.
  const canRunModel = (m) => {
    if (!m || !window.EOLLM) return false;
    if (m.provider === 'anthropic') return !!(window.EOLLM.hasAnthropicKey && window.EOLLM.hasAnthropicKey());
    if (m.provider === 'wllama') return !window.EOLLM.hasWasm || !!window.EOLLM.hasWasm();
    return !!(window.EOLLM.hasWebGPU && window.EOLLM.hasWebGPU());
  };
  // Resolve the configured backup ids to runnable models, in order, skipping
  // whichever models have already been tried this attempt (so a chain that
  // walks through every slot can't loop back onto the failed default). Falls
  // back to the automatic CPU pick when the user hasn't configured a backup
  // that fits — the dependable "answer still gets worded" guarantee the page
  // used to give unconditionally. Returns null when nothing viable is left.
  const fallbackModelIdsRef = useRef(fallbackModelIds);
  fallbackModelIdsRef.current = fallbackModelIds;
  const nextFallback = (tried) => {
    const seen = tried instanceof Set ? tried : new Set(tried || []);
    for (const id of fallbackModelIdsRef.current || []) {
      if (!id || seen.has(id)) continue;
      const m = window.MODELS.find(x => x.id === id);
      if (m && canRunModel(m)) return m;
      seen.add(id);
    }
    const cpu = cpuFallbackModel();
    if (cpu && !seen.has(cpu.id) && canRunModel(cpu)) return cpu;
    return null;
  };
  // Why a backup ran — surfaced in the toast so the user knows the switch
  // wasn't silent. STALL gets its own phrasing because the page used to mention it.
  const failReason = (e) => (e && e.code === 'STALL') ? 'stalled' : 'wouldn’t load';

  // ---- model: load the real local model for the demo ----
  // `_tried` accumulates the model ids attempted during a single fallback walk,
  // so a chain that exhausts every configured backup can't loop back onto a
  // model that already failed this run. External callers (pickModel, the
  // auto-load effect, the Claude key setter) start with no `_tried` — every
  // user-driven load is a fresh attempt.
  const loadModel = async (m, _tried) => {
    if (!window.EOLLM) { showToast('Local model module unavailable.'); return false; }
    const tried = _tried instanceof Set ? _tried : new Set();
    if (m && m.id) tried.add(m.id);
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
        const next = nextFallback(tried);
        if (window.EO_CPU_FALLBACK !== 'off' && next) {
          showToast('Claude ' + failReason(e) + ' — switching to “' + next.name + '”.');
          return loadAsFallback(next, tried);
        }
        showToast(e.message || 'Could not connect to Claude');
        return false;
      }
    }
    // wllama (CPU): no WebGPU needed. The GGUF downloads once from Hugging Face
    // and runs on the CPU; progress streams the same way the GPU path does.
    if (m.provider === 'wllama') {
      if (window.EOLLM.hasWasm && !window.EOLLM.hasWasm()) {
        setModelStatus('idle');
        const next = nextFallback(tried);
        if (window.EO_CPU_FALLBACK !== 'off' && next) {
          showToast('This browser can’t run the on-device CPU model — switching to “' + next.name + '”.');
          return loadAsFallback(next, tried);
        }
        showToast('This browser can’t run the on-device CPU model (no WebAssembly).');
        return false;
      }
      setModelStatus('loading'); setModelProgress(0); setModelLoadText('');
      try {
        await window.EOLLM.load(m.mlc, (p, text) => { setModelProgress(p); if (text) setModelLoadText(text); });
        setModelStatus('ready'); setModelLoadText(''); return true;
      } catch (e) {
        setModelStatus('idle'); setModelLoadText('');
        if (e && e.code === 'CANCEL') return false;
        const next = nextFallback(tried);
        if (window.EO_CPU_FALLBACK !== 'off' && next) {
          showToast('The CPU model ' + failReason(e) + ' — switching to “' + next.name + '”.');
          return loadAsFallback(next, tried);
        }
        showToast(e.message || 'CPU model failed to load');
        return false;
      }
    }
    if (!window.EOLLM.hasWebGPU()) {
      // A GPU model was selected but this browser has no WebGPU. Fall through
      // the configured backups (CPU model picked first if available).
      setModelStatus('idle');
      if (window.EO_CPU_FALLBACK !== 'off') {
        const next = nextFallback(tried);
        if (next) return loadAsFallback(next, tried);
      }
      return false;
    }
    setModelStatus('loading'); setModelProgress(0); setModelLoadText('');
    try {
      await window.EOLLM.load(m.mlc, (p, text) => { setModelProgress(p); if (text) setModelLoadText(text); });
      setModelStatus('ready'); setModelLoadText(''); return true;
    } catch (e) {
      setModelStatus('idle'); setModelLoadText('');
      if (e && e.code === 'CANCEL') return false;  // a user cancel is not an error
      // The active model failed; walk the user's backup chain so phrasing
      // doesn't drop to mechanical-only.
      const next = nextFallback(tried);
      if (window.EO_CPU_FALLBACK !== 'off' && next) {
        showToast('The GPU model ' + failReason(e) + ' — switching to “' + next.name + '”.');
        return loadAsFallback(next, tried);
      }
      showToast(e.message || 'Model failed to load');
      return false;
    }
  };
  // Activate a backup model and load it. The single resident-engine invariant
  // means we can't hold a warm second model beside the active one — so the
  // switch happens at the moment it's needed. setModel here pins the user's
  // backup as the active model, so subsequent turns route through it; the
  // selection persists with prefs the same way a manual pick would.
  const loadAsFallback = async (m, tried) => {
    if (!m) return false;
    setModel(m); setModelStatus('idle');
    return loadModel(m, tried);
  };
  // Kept for the auto-load path below (cpuFallbackModel is the auto default
  // when the user hasn't configured a backup that fits). Walks the chain too,
  // so a user-picked backup wins over the hardcoded CPU pick when present.
  const fallbackToCPU = async () => {
    const next = nextFallback(null);
    if (!next) return false;
    return loadAsFallback(next);
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
  // Register a user-uploaded GGUF as a new wllama (CPU) model, add it to the
  // popover list, and immediately pick it. Session-only — see uploadedModels.
  const uploadModel = (file) => {
    if (!file) return;
    if (!window.EOLLM || !window.EOLLM.registerUploadedModel) { showToast('Local model module unavailable.'); return; }
    if (window.EOLLM.hasWasm && !window.EOLLM.hasWasm()) { showToast('This browser can’t run uploaded models (no WebAssembly).'); return; }
    if (!/\.gguf$/i.test(file.name)) { showToast('Upload a .gguf file — that’s the format the on-device CPU runtime reads.'); return; }
    const id = 'up-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const mlcKey = window.EOLLM.registerUploadedModel(id, file);
    if (!mlcKey) { showToast('Couldn’t register the uploaded model.'); return; }
    const mb = file.size / (1024 * 1024);
    const size = mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
    const name = file.name.replace(/\.gguf$/i, '') || 'Uploaded model';
    const m = { id, name, detail: size + ' · uploaded · CPU', provider: 'wllama', mlc: mlcKey, uploaded: true };
    setUploadedModels(prev => [...prev, m]);
    pickModel(m);
  };
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
  // Ask the browser to mark this origin's storage persistent the instant the
  // app boots, BEFORE any model load. Best-effort: Chrome grants from a
  // heuristic (visits, engagement) with no prompt; Firefox shows a permission
  // prompt on the next user gesture. Either way, getting the ask in early
  // means a download that starts a second later will be writing to a bucket
  // the browser has already promised not to evict — the single biggest
  // mitigation against the "I just had to reinstall on refresh" failure mode.
  const [storagePersisted, setStoragePersisted] = useState(null);
  useEffect(() => {
    if (!window.EOLLM || !window.EOLLM.persistStorage) return;
    (async () => {
      try {
        const ok = await window.EOLLM.persistStorage();
        setStoragePersisted(!!ok);
      } catch (e) {}
    })();
  }, []);
  // Re-attempt persistence on the first user click anywhere in the app — that
  // gesture is what Firefox needs to show the permission prompt, and a denied
  // request earlier in this session may now succeed.
  useEffect(() => {
    if (storagePersisted) return;
    if (!window.EOLLM || !window.EOLLM.persistStorage) return;
    let armed = true;
    const retry = async () => {
      if (!armed) return; armed = false;
      try {
        const ok = await window.EOLLM.persistStorage();
        if (ok) setStoragePersisted(true);
      } catch (e) {}
    };
    document.addEventListener('pointerdown', retry, { once: true, capture: true });
    return () => { armed = false; document.removeEventListener('pointerdown', retry, { capture: true }); };
  }, [storagePersisted]);

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
      // AND pre-fetch the tiny fallback GGUF into OPFS in the background, so a
      // later GPU stall swaps over with NO download — only wllama init. This
      // is what makes the fallback feel instant instead of a several-minute
      // wait while a multi-hundred-MB model trickles in over the wire.
      if (window.EO_CPU_FALLBACK !== 'off') {
        try { window.EOLLM.prewarmFallback && window.EOLLM.prewarmFallback(); } catch (e) {}
        try { window.EOLLM.prewarmFallbackModel && window.EOLLM.prewarmFallbackModel(); } catch (e) {}
      }
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
  // A settle clears the in-flight flags by default (typing always; streaming
  // unless the patch re-asserts it, as the streaming-start placeholders do) — so
  // a finished reply never lingers as "generating" and the Stop affordance is
  // never offered over a settled message.
  const replaceLast = (patch) => setMessages(m => { const c = m.slice(); c[c.length - 1] = { ...c[c.length - 1], streaming: false, ...patch, typing: false }; return c; });
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
  // WI-1 — THE MONOTONICITY FLOOR (law L1). The epistemicTag above WEARS a badge
  // but still hands the model the turn's actual tokens; a small model imitates
  // the salvaged tail no matter what the badge says. So split DISPLAY text from
  // MODEL-FACING text: a turn that did not settle clean re-enters history as a
  // neutral marker, never its own unverified words. The real text stays on
  // m.text for the UI and for the index-recall escape hatch the recap promises
  // (recallSpan reads the raw turns, not this assembled view). Clean turns are
  // byte-identical to before (histTextFor returns m.text), so parity holds.
  // An explicit m.histText set at a settle wins, then mode, then the audit.
  const HIST_NEUTRAL = '(no verified answer this turn)';
  // A settle whose tokens must NOT ride forward: unbound (grounded === false),
  // warn, or plain. Refused turns (status 'error') are excluded — they already
  // store a clean meta-message, so they are left as is (epistemicTag tags them).
  const histNonClean = (a) => !!(a && a.status !== 'error'
    && (a.status === 'plain' || a.status === 'warn' || a.grounded === false));
  const histTextFor = (m) => {
    if (m.role !== 'assistant') return m.text;
    if (typeof m.histText === 'string') return m.histText;   // explicit override at settle
    if (m.mode === 'creative') return m.text;                // a creative composition rides (its own tag)
    // A non-clean settle does not carry forward its tokens — only the neutral
    // marker. retracted/objected keep their text (epistemicTag's strong "do not
    // defend" markers, and the repair path re-reads them verbatim).
    return histNonClean(m.audit) ? HIST_NEUTRAL : m.text;
  };
  // L1 instrument (WI-7): the prior assistant turns whose unverified tokens would
  // ride forward into THIS turn's model history — i.e. a non-clean turn that is
  // NOT neutralized. Zero by construction (histTextFor neutralizes every such
  // turn); a non-zero result is a monotonicity violation worth surfacing.
  const l1Violations = () => {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.text || m.typing || m.loading) continue;
      if (histNonClean(m.audit) && histTextFor(m) !== HIST_NEUTRAL)
        out.push({ turn: i, status: (m.audit && m.audit.status) || null });
    }
    return out;
  };
  // the running conversation, as plain {role, content} turns for the model
  const historyFor = () => messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.typing && !m.loading && m.text)
    .map(m => ({ role: m.role, content: epistemicTag(m) + stripMarkup(histTextFor(m)) }));

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
    // FIX 3b: a provisional enrichment doc this answer actually cited has earned
    // its place — clear the flag so the sweep won't reap it.
    const citedIds = new Set((cites || []).map(c => c && c.docId).filter(Boolean));
    if (citedIds.size) setDocs(ds => ds.some(d => citedIds.has(d.id) && d.provisional)
      ? ds.map(d => (citedIds.has(d.id) && d.provisional) ? { ...d, provisional: false } : d) : ds);
    const F = window.EOEngine && window.EOEngine.conversationField;
    if (!F) return;
    let matter = [];
    try { matter = (window.EOEngine.referentsScope(scope, q) || {}).matter || []; } catch (e) {}
    try { F.deposit({ entities: matter, sentences: (cites || []).map(c => ({ docId: c.docId, idx: c.idx })) }, 1); }
    catch (e) { eoWarn('field deposit', e); }
  };

  // FIX 3c — provisional-source sweep. Enrichment-ingested docs are tagged
  // provisional at ingest (ingestExternalSource) and cleared when an answer
  // cites them (depositSettled). One that never grounds is junk that keeps
  // competing for primary selection and retrieval, so reap it: `force` (a chat
  // switch/reset) drops every provisional doc; otherwise only those older than
  // the TTL in turns. User-uploaded docs (no provenance flag) are never touched.
  const PROVISIONAL_TTL = 2;
  const sweepProvisional = (force) => {
    const seq = turnSeqRef.current;
    const doomed = new Set((docsRef.current || [])
      .filter(d => d && d.provisional === true && d.provenance === 'enrichment'
        && (force || typeof d.provTurn !== 'number' || seq - d.provTurn >= PROVISIONAL_TTL))
      .map(d => d.id));
    if (!doomed.size) return;
    const docId = (t) => (t && t.startsWith && t.startsWith('@ent/')) ? t.split('/')[1] : t;
    setDocs(ds => ds.filter(d => !doomed.has(d.id)));
    setSources(s => s.filter(id => !doomed.has(id)));
    setOpenTabs(t => t.filter(x => !doomed.has(docId(x))));
    setActiveTab(a => doomed.has(docId(a)) ? null : a);
    if (activeProject) setProjects(ps => ps.map(p => p.id === activeProject ? { ...p, docIds: p.docIds.filter(id => !doomed.has(id)) } : p));
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
      const prim = E.routePrimary(scope, q, { hotEntity: hotEntity() }) || scope[0];
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
    const primary = window.EOEngine.routePrimary(scope, q, { hotEntity: hotEntity() }) || scope[0];
    replaceLast({ role: 'assistant', text: plan.text, audit: plan.audit, mode: mode === 'creative' ? 'creative' : 'grounded' });
    if (plan.tableSpec && primary) { openTab(primary.id); setTableSpec({ ...plan.tableSpec }); }
    if (plan.cites && plan.cites.length) setTimeout(() => flashCitation(plan.cites[0].docId, plan.cites[0].idx), 380);
    depositSettled(scope, q, plan.cites);
    AUD('end', { engine: 'mechanical', text: plan.text, audit: plan.audit, cites: plan.cites || [], tableSpec: plan.tableSpec || null });
    setBusy(false);
  };

  // Open a table doc in its own tab with a spec applied (the "expand into a tab"
  // affordance, and how a saved view reopens). Mirrors runMechanicalScope's
  // open+spec move; the user triggers it explicitly here.
  const applyTableView = (docId, spec) => {
    if (!docId) return;
    openTab(docId);
    setTableSpec(spec ? { ...spec } : { groupBy: null, aggregate: null, sortBy: null, filters: [] });
  };
  // Persist a named view under its table (appears beneath the spreadsheet and is
  // reopenable). De-duped by identical spec; the name defaults to a plain-language
  // description of the filter.
  const saveTableView = (docId, spec, name) => {
    if (!docId || !spec) return;
    const doc = docsById[docId];
    const nm = (name && String(name).trim())
      || (window.EOTableQuery && doc ? window.EOTableQuery.describe(doc, spec) : 'Saved view');
    const list = savedViews[docId] || [];
    if (list.some(v => JSON.stringify(v.spec) === JSON.stringify(spec))) { showToast('That view is already saved.'); return; }
    const view = { id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: nm, spec: { ...spec }, createdAt: Date.now() };
    setSavedViews(sv => ({ ...sv, [docId]: [...(sv[docId] || []), view] }));
    showToast('Saved view “' + nm + '”.');
  };
  const deleteTableView = (docId, viewId) => {
    setSavedViews(sv => ({ ...sv, [docId]: (sv[docId] || []).filter(v => v.id !== viewId) }));
  };

  // The model adapter the schema resolver calls: a plain (system, user, history)
  // completion over the loaded model. Returns '' when no model is ready, so the
  // resolver degrades to its mechanical layer.
  const callTableLLM = async (system, user, hist) => {
    if (!(window.EOLLM && window.EOLLM.isLoaded(model.mlc))) return '';
    try {
      return await window.EOLLM.phrase({
        mlcKey: model.mlc, sysOverride: system, question: user,
        history: Array.isArray(hist) ? hist : [], grounded: false, mode: 'chat', maxTokens: 240,
      });
    } catch (e) { eoWarn('table-llm', e); return ''; }
  };

  // SMART TABLE QUERY — schema-aware filtering with the model in the loop and a
  // back-and-forth when the request is ambiguous. The model only chooses WHICH
  // column/value to filter on; foldPivot computes the count mechanically, so the
  // number stays exact and grounded. Falls back to the plain pivot path when the
  // resolver finds nothing table-shaped.
  const runTableQuery = async (scope, q, primary, history) => {
    const myGen = genRef.current;
    const TQ = window.EOTableQuery;
    if (!TQ || !primary || primary.kind !== 'table') { runMechanicalScope(scope, q); return; }
    const ready = !!(window.EOLLM && window.EOLLM.isLoaded(model.mlc));
    AUD('step', 'route', { referencing: true, reason: 'table-smart', path: ready ? 'table-llm' : 'table-mechanical',
      primary: { id: primary.id, name: primary.name, kind: primary.kind } });
    let result = null;
    // Keep the back-and-forth tight: the small model only needs the recent
    // clarify exchange, not the whole chat (and a 0.5B's context is precious).
    try { result = await TQ.resolve({ doc: primary, query: q, history: (history || []).slice(-4), llm: ready ? callTableLLM : null }); }
    catch (e) { eoWarn('tablequery', e); }
    if (genStale(myGen)) return;

    if (result && result.kind === 'clarify') {
      AUD('step', 'clarify', { question: result.question, options: result.options || [] });
      replaceLast({ role: 'assistant', text: result.question, audit: null, mode: 'grounded',
        clarify: { options: result.options || [] } });
      AUD('end', { engine: 'mechanical', text: result.question, audit: null });
      setBusy(false);
      return;
    }

    if (result && result.kind === 'spec') {
      const spec = result.spec;
      let fold = null;
      try { fold = window.foldPivot(primary, spec); } catch (e) { eoWarn('fold', e); }
      const total = (primary.rows || []).length;
      const matched = fold ? fold.total : total;
      const noun = /clients?\b/i.test(primary.name || '') ? 'clients' : 'rows';
      const hasFilter = !!(spec.filters && spec.filters.length);
      const filterDesc = (spec.filters || []).map(f => `${f.col} = ${f.val}`).join(' and ');
      const fmtN = (n) => Number(n).toLocaleString('en-US');
      const moneyCol = (c) => (primary.money || []).includes(c);
      let text;
      if (spec.groupBy && fold && fold.kind === 'grouped') {
        const top = fold.groups.slice(0, 8).map(g => {
          const v = (spec.aggregate && g.agg && g.agg.value != null)
            ? (moneyCol(spec.aggregate.col) ? window.fmtMoney(g.agg.value) : window.fmtNum(g.agg.value))
            : g.count;
          return `${g.key} (${v})`;
        }).join(', ');
        const more = fold.groups.length > 8 ? `, … ${fold.groups.length - 8} more` : '';
        text = `Grouped by **${spec.groupBy}**${hasFilter ? ` where ${filterDesc}` : ''}: ${top}${more}.`;
      } else if (spec.aggregate && spec.aggregate.op !== 'count') {
        const agg = window.aggregate ? window.aggregate((fold && fold.rows) || [], spec.aggregate) : null;
        const val = agg && agg.value != null
          ? (moneyCol(spec.aggregate.col) ? window.fmtMoney(agg.value) : window.fmtNum(agg.value)) : '—';
        text = `**${val}** — the ${spec.aggregate.op}${spec.aggregate.col ? ' of ' + spec.aggregate.col : ''}${hasFilter ? ` where ${filterDesc}` : ''}, over ${fmtN(matched)} ${noun}.`;
      } else if (hasFilter) {
        text = `That matches **${fmtN(matched)}** of ${fmtN(total)} ${noun} — where ${filterDesc}.`;
      } else {
        text = `**${fmtN(matched)}** ${noun}.`;
      }
      const desc = result.describe || (TQ.describe ? TQ.describe(primary, spec) : filterDesc);
      replaceLast({ role: 'assistant', text,
        audit: { status: 'clean', grounded: true, covers: '1/1', stable: true,
          note: 'Folded mechanically from ' + primary.name + ' — the model only chose the filter; the figure is exact.' },
        mode: 'grounded', tableView: { docId: primary.id, spec, matched, describe: desc } });
      AUD('end', { engine: 'mechanical', text, tableSpec: spec });
      setBusy(false);
      return;
    }

    // Nothing table-shaped — let the existing mechanical pivot path answer.
    runMechanicalScope(scope, q);
  };

  // Plain conversation with the model — multi-turn, no document forced in,
  // no citations. This is the default; it should feel like a simple chat app.
  // When a document IS open, the answer carries an explicit "not grounded"
  // audit so it can never be mistaken for a cited, document-drawn answer —
  // the app's whole promise is that grounded and ungrounded look different. (1b)
  const runChat = async (q, history, modeTag, ctx, docOpen, mech) => {
    const myGen = genRef.current;
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
        // A user interrupt is not a model failure — never retry it (that would
        // start a fresh stream); let it fall through to the stop handling below.
        if (window.EOLLM.isAbort(e1) || genStale(myGen)) throw e1;
        // Most local-model failures mid-session are context / VRAM pressure,
        // not bad input. Retry once with just the last couple of turns and a
        // tight budget before giving up — recovers the common case silently.
        AUD('step', 'error', { where: 'chat', attempt: 1, message: String((e1 && e1.message) || e1) });
        replaceLast({ role: 'assistant', text: '', mode: modeTag, streaming: true });
        full = await attempt(history.slice(-2), 2200);
      }
      if (genStale(myGen)) return;                  // stopped while streaming — stopTurn owns the message
      replaceLast({ role: 'assistant', text: full, audit: ungroundedAudit, mode: modeTag, mechanical: mechPanel });
      AUD('end', { engine: 'model', text: full, audit: ungroundedAudit, cites: [] });
    } catch (e) {
      if (window.EOLLM.isAbort(e) || genStale(myGen)) return;   // stopped — settled by stopTurn, show no error
      const msg = 'I couldn’t finish that one locally — the model likely ran out of memory or context. Try a shorter message, pick a smaller model from the switcher, or ask about an open document and I’ll answer it mechanically.';
      replaceLast({ role: 'assistant', text: msg, audit: null });
      AUD('step', 'error', { where: 'chat', fatal: true, message: String((e && e.message) || e) });
      AUD('end', { engine: 'none', text: msg, audit: null, reason: 'model-failed' });
    }
    if (!genStale(myGen)) setBusy(false);
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
    const myGen = genRef.current;
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
    // A correction rebinds to the active subject, not the mis-bound document:
    // "no, that's Noah Kahan's inspirations" returns the turn to Howard Shore
    // (the held subject), it doesn't refine within Kahan. Discourse precedence
    // carries that here too.
    const primaryDoc = E.routePrimary(scope, probe, { hotEntity: hotEntity() }) || scope[0];
    if (ready && (tier.spans.length || tier.notes.length)) {
      try {
        // The shape pass sees the tagged history, so the rejected reply and
        // the pushback are in its view — repair register comes out naturally.
        const shapeNote = await shapeFor(scope, q, tagged, primaryDoc);
        // Size the budget from the reconstructed question (probe), not the
        // complaint; intent is left for the prompt match to infer (shape.js §9).
        const shapeMax = await shapeBudgetFor(probe, null, shapeNote);
        if (genStale(myGen)) return;                  // stopped during the shape pass — stand down
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
        if (genStale(myGen)) return;                  // stopped while streaming the repair — stopTurn owns it
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
        if (window.EOLLM.isAbort(e) || genStale(myGen)) return;   // stopped — leave the partial in place
        AUD('step', 'error', { where: 'repair', message: String((e && e.message) || e) });
      }
    }
    if (genStale(myGen)) return;
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

  // FIX 4: a draft that is literally the editor's note (a "Note: …" preamble, or
  // verbatim the shape note) is meta about the question, never an answer — caught
  // even when it shares too little vocabulary for echoesShapeNote's overlap test.
  const looksLikeNote = (full, note) => {
    const t = String(full == null ? '' : full).trim();
    if (!t) return false;
    if (/^note\s*:/i.test(t)) return true;
    const n = String(note == null ? '' : note).trim();
    return !!n && t === n;
  };

  // COMPUTATIONAL turn (pyodide.js): the second mechanical grounding source.
  // The model writes Python; Python run locally over the loaded CSV produces the
  // figure; the model phrases over that result and never reports a number it
  // computed in its own head. Two backends: Claude uses native tool_use (it
  // decides when to compute); a local model is steered to emit a single fenced
  // python block, which we parse out deterministically rather than trusting it
  // to self-report. Every execution is deposited as a glass-box `compute` step
  // and surfaced on the message. Defensive throughout: a Python failure settles
  // as an honest answer, never a broken turn.
  const runComputeScope = async (doc, q, history) => {
    const myGen = genRef.current;
    const fileName = tableSlug(doc);
    let csv = '';
    try { csv = tableToCSV(doc); } catch (e) { eoWarn('compute csv', e); }
    const files = [{ name: fileName, data: csv }];
    const schema = tableSchemaText(doc, fileName);
    const calls = [];   // every Python execution this turn — for the audit and the message panel

    // Run one code block locally, recording it as a `compute` step (the code, its
    // stdout/stderr, the structured result, the duration) so a computed figure is
    // as traceable as a cited line.
    const execPython = async (code) => {
      let res;
      try { res = await window.EOPython.run({ code, files, timeoutMs: 15000 }); }
      catch (e) { res = { ok: false, stdout: '', stderr: String((e && e.message) || e), result: '', durationMs: 0, truncated: false }; }
      const rec = { code: String(code || ''), ok: !!res.ok, stdout: res.stdout || '', stderr: res.stderr || '',
                    result: res.result || '', durationMs: res.durationMs || 0, truncated: !!res.truncated };
      calls.push(rec);
      AUD('step', 'compute', rec);
      return res;
    };
    const payload = () => ({ fileName, columns: doc.columns || [], calls: calls.slice() });
    const computedAudit = (ok) => ok
      ? { status: 'computed', grounded: true, covers: '1/1', stable: true,
          note: 'Computed locally with Python over “' + doc.name + '”. The code and its output are in the glass box and below.' }
      : { status: 'warn', grounded: false, covers: null,
          note: 'Tried to compute with Python, but it did not return a usable result. The code and any error are below.' };

    try {
      // ---- Claude API path: native tool_use ----
      if (window.EOLLM.isAnthropic && window.EOLLM.isAnthropic(model.mlc)) {
        const tools = [{
          name: 'run_python',
          description: 'Run Python (pandas is available) locally over the loaded CSV to compute an answer. The CSV file is already in the working directory; the data never leaves the device. Use this for any counting, summing, grouping, sorting, joining, or rate calculation over the data. The code\'s printed output and return value are given back to you.',
          input_schema: { type: 'object', properties: {
            code: { type: 'string', description: 'Python source to execute. Read the CSV with pandas and print or return the result.' },
          }, required: ['code'] },
        }];
        const system = 'You are Cleo, answering a question about a tabular document the user loaded. You have a run_python tool that executes Python (with pandas) locally over the data, on the user\'s device.\n\n'
          + schema + '\n\n'
          + 'When the question needs any calculation over the data, call run_python with code that computes it and prints or returns the answer, then state the answer in plain words and name the columns and the operation you used. If no calculation is needed, just answer. Never invent a number; every figure must come from the tool output.';
        const msgs = (history || []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
          .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
        msgs.push({ role: 'user', content: q });
        patchLast({ typing: true });
        const modelId = String(model.mlc).replace(/^anthropic:/, '');
        const out = await window.EOLLM.runAnthropicTools({
          model: modelId, system, messages: msgs, tools, maxTokens: 1024, maxSteps: 5,
          runTool: async (name, input) => {
            if (name !== 'run_python' || !input || !input.code) return { ok: false, stderr: 'no code provided' };
            const r = await execPython(input.code);
            return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, result: r.result, durationMs: r.durationMs };
          },
        });
        if (genStale(myGen)) return;
        const ranOk = calls.length ? calls[calls.length - 1].ok : true;
        const ok = ranOk && !!(out.text && out.text.trim());
        const text = (out.text || '').trim()
          || (calls.length ? 'I ran the computation but came back without a phrased answer. The raw result is below.' : 'I could not produce an answer.');
        const audit = calls.length ? computedAudit(ok) : { status: 'plain', grounded: false, covers: null, note: 'Answered without computing — no calculation was needed.' };
        replaceLast({ role: 'assistant', text, audit, mode: 'grounded', compute: calls.length ? payload() : null });
        AUD('end', { engine: calls.length ? 'compute' : 'compute-none', text, audit: calls.length ? audit : null, cites: [] });
        setBusy(false);
        return;
      }

      // ---- Local-model path: the fenced-block convention ----
      // First pass: the model emits a single fenced python block iff a
      // computation is needed; otherwise it answers in words. We parse the
      // fence out mechanically rather than relying on the model to self-report.
      const fenceSys = 'You are Cleo. The user asked about a CSV table loaded locally on this device. You can run Python (pandas available) over it.\n\n'
        + schema + '\n\n'
        + 'If answering needs a calculation over the data (counting, summing, grouping, sorting, rates, joins), reply with ONE fenced Python code block and nothing else. The code must read "' + fileName + '" with pandas and print the answer. If no calculation is needed, answer the question in plain words instead, with no code block.';
      let first = '';
      try { first = await window.EOLLM.phrase({ mlcKey: model.mlc, question: q, contextText: schema, history, mode: 'chat', grounded: false, sysOverride: fenceSys }); }
      catch (e) { if (window.EOLLM.isAbort(e) || genStale(myGen)) return; first = ''; }
      if (genStale(myGen)) return;
      const code = extractPyFence(first);
      if (!code) {
        const text = (first || '').trim() || 'I could not produce an answer.';
        const audit = { status: 'plain', grounded: false, covers: null, note: 'Answered without computing — no calculation was needed.' };
        replaceLast({ role: 'assistant', text, audit, mode: 'grounded' });
        AUD('end', { engine: 'compute-none', text, audit: null, cites: [] });
        setBusy(false);
        return;
      }
      const r = await execPython(code);
      if (genStale(myGen)) return;
      // Second pass: phrase over the execution result, streamed in. The result
      // rides as the only material; the model states the figure, names the
      // columns/operation, and never invents.
      const resultBlock = 'Python was run locally over the table. Here is exactly what it produced:\n\n'
        + '[code]\n' + code + '\n\n[stdout]\n' + (r.stdout || '(none)') + '\n\n[result]\n' + (r.result || '(none)')
        + (r.ok ? '' : '\n\n[error]\n' + (r.stderr || 'failed'));
      const phraseSys = 'You are Cleo. A computation was just run locally over the user\'s CSV. State the answer in plain words, using ONLY the numbers in the result below. Name the columns and the operation. Do not invent any figure. If the computation failed, say so plainly and briefly.';
      replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
      let answer = '';
      try { answer = await window.EOLLM.phrase({ mlcKey: model.mlc, question: q, contextText: resultBlock, history, mode: 'chat', grounded: false, sysOverride: phraseSys, onToken: streamInto({ mode: 'grounded' }) }); }
      catch (e) { if (window.EOLLM.isAbort(e) || genStale(myGen)) return; answer = ''; }
      if (genStale(myGen)) return;
      const text = (answer || '').trim()
        || (r.ok ? ('The computation returned:\n\n' + (r.result || r.stdout || '(no output)')) : ('The computation failed: ' + (r.stderr || 'unknown error')));
      const audit = computedAudit(r.ok);
      replaceLast({ role: 'assistant', text, audit, mode: 'grounded', compute: payload() });
      AUD('end', { engine: 'compute', text, audit, cites: [] });
      setBusy(false);
    } catch (e) {
      if (window.EOLLM.isAbort(e) || genStale(myGen)) return;   // stopped — settled by stopTurn
      eoWarn('compute', e);
      AUD('step', 'error', { where: 'compute', message: String((e && e.message) || e) });
      const text = 'I hit a problem running the computation: ' + String((e && e.message) || e) + '.';
      const audit = calls.length ? computedAudit(false) : null;
      replaceLast({ role: 'assistant', text, audit, mode: 'grounded', compute: calls.length ? payload() : null });
      AUD('end', { engine: 'compute-error', text, audit, cites: [] });
      setBusy(false);
    }
  };

  // WI-3 caps the small tier's generation low: a 0.5B emitting hundreds of
  // tokens of "grounded" prose is mostly drift. The rephrase only needs room to
  // re-join the mechanical reading, never to expand it. Also the convergence
  // iteration ceiling (WI-5) — a ceiling, never the terminator.
  const SMALL_MAX_TOKENS = 220;
  const MAX_CONVERGE_ROUNDS = 3;

  // WI-2 — peel a single leading META clause: an unbound assertion ("The user is
  // asking…", "Not the document itself.") glued to a real bound sentence. It
  // passes the full-echo vetoes (the tail is a real answer) yet is a lie about
  // the head, so it must never reach binding or history. Peel when the head
  // opens with a known meta phrase OR overlaps the director's note heavily, then
  // bind the remainder. Conservative by design: a clean answer comes back
  // byte-for-byte (peeled === null), so clean turns are unaffected.
  const META_OPENER = /^(?:the user is asking|the user wants|this turn|the question is|the question asks|not the document|note)\b/i;
  const peelMetaHead = (full, note) => {
    let text = String(full == null ? '' : full);
    const peeled = [];
    for (let i = 0; i < 3; i++) {                       // unstack a short run of meta heads
      const lead = text.replace(/^\s+/, '');
      const m = lead.match(/^([^.!?\n:]{0,160}[.!?:\n])\s+(\S[\s\S]*)$/);
      if (!m) break;
      const head = m[1].trim(), rest = m[2].trim();
      if (!rest) break;                                 // never strip the only sentence
      let overlap = false;
      if (!META_OPENER.test(head) && note) {
        try {
          const ht = new Set(window.EOEngine.tok(head)), nt = new Set(window.EOEngine.tok(String(note)));
          if (ht.size >= 3 && nt.size) {
            let hit = 0; for (const x of ht) if (nt.has(x)) hit++;
            overlap = head.split(/\s+/).length <= 16 && hit / ht.size >= 0.6;
          }
        } catch (e) {}
      }
      if (!META_OPENER.test(head) && !overlap) break;
      peeled.push(head);
      text = rest;
    }
    return { text: peeled.length ? text : full, peeled: peeled.length ? peeled.join(' ') : null };
  };

  // WI-6 — SMALL-TIER JOIN-ONLY SMOOTHING (coverage 1.0 by construction). The
  // mechanical reading (answer(), goldened) is already deterministic and bound.
  // The model never composes from the page, so it cannot invent from the page:
  // hand it the already-bound text with a join-and-rephrase-ONLY rule (no adding,
  // no selecting), then re-bind the rephrase. If it introduces ANY token outside
  // the bound text, any invented entity, or any cite outside the set fixed before
  // it spoke, discard the rephrase and serve the mechanical text. Either way
  // every claim traces to a pre-existing cite, so the model cannot change binding
  // status and coverage is 1/1.
  const runGroundedSmall = async (scope, q, history, opts) => {
    const myGen = genRef.current;
    const E = window.EOEngine;
    const { mech, intent, budget } = opts || {};
    const mechUsable = !!(mech && mech.text && mech.text.trim() && mech.audit
      && mech.audit.status !== 'held'
      && (mech.audit.status === 'clean' || mech.audit.status === 'warn' || mech.audit.grounded));
    const settleSmall = (text, audit, cites, decision, mechPanel) => {
      if (genStale(myGen)) return;
      lastGroundedRef.current = !!(audit && audit.grounded);
      replaceLast({ role: 'assistant', text, audit, mode: 'grounded', mechanical: mechPanel || null });
      if (cites && cites.length) setTimeout(() => flashCitation(cites[0].docId, cites[0].idx), 380);
      depositSettled(scope, q, cites);
      AUD('end', { engine: decision, text, audit, cites: cites || [] });
      setBusy(false);
    };
    // No usable bound reading to smooth (a hold/void): serve the mechanical
    // reading honestly — the small tier never free-composes.
    if (!mechUsable) { AUD('step', 'veto', { decision: 'mechanical', reason: 'small tier, no bound reading to smooth' }); runMechanicalScope(scope, q); return; }
    const ready = !!(window.EOLLM && window.EOLLM.isLoaded(model.mlc));
    if (!ready) { settleSmall(mech.text, mech.audit, mech.cites || [], 'mechanical (small, model not ready)'); return; }

    const mechPlain = String(mech.text).replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const level = (budget && budget.level) || 1;
    const sys = window.EOLLM.systemFor('grounded', 'answer', true, level)
      + '\n\nThe answer below is already correct and fully cited. Your ONLY job is to rephrase it into one or two natural sentences: join the points and smooth the wording. Do NOT add any fact, name, number, place, or detail that is not already in it, and do NOT bring in anything from your own knowledge. If you cannot improve it, repeat it unchanged.';
    let re = '';
    try {
      replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
      re = await window.EOLLM.phrase({
        mlcKey: model.mlc, question: q, contextText: mechPlain, history,
        mode: 'grounded', task: 'answer', grounded: true, sysOverride: sys,
        maxTokens: SMALL_MAX_TOKENS, onToken: streamInto({ mode: 'grounded' }), depth: level,
      });
      if (genStale(myGen)) return;
      re = E.dedupeSentences(re);
    } catch (e) {
      if (window.EOLLM.isAbort(e) || genStale(myGen)) return;
      AUD('step', 'error', { where: 'grounded-small', message: String((e && e.message) || e) });
      settleSmall(mech.text, mech.audit, mech.cites || [], 'mechanical (small, rephrase failed)');
      return;
    }
    // EVA: the cite set is fixed (mech.cites). The rephrase may only re-join the
    // already-bound text. It breaks join-only if it is empty, invents an entity,
    // adds a content token absent from the bound text, fails to bind, or binds to
    // a cite outside the fixed set.
    const stripped = String(re || '').replace(/\{\{[^}]*\}\}/g, ' ');
    let added = []; try { added = E.coverageGaps(stripped, mechPlain).uncovered || []; } catch (e) {}
    let invented = []; try { const per = scope.map(d => new Set(E.inventedTerms(d, stripped))); invented = per.length ? [...per[0]].filter(t => per.every(s => s.has(t))) : []; } catch (e) {}
    let boundRe = null; try { boundRe = E.bindCitationsScope(scope, re, q, intent, { hotEntity: hotEntity() }); } catch (e) {}
    const fixed = new Set((mech.cites || []).map(c => c.docId + ':' + c.idx));
    const newCite = !!(boundRe && (boundRe.cites || []).some(c => !fixed.has(c.docId + ':' + c.idx)));
    const empty = !re || re.trim().length < 3;
    if (empty || added.length || invented.length || newCite || !(boundRe && boundRe.audit && boundRe.audit.grounded)) {
      AUD('step', 'veto', { decision: 'mechanical',
        reason: empty ? 'rephrase empty' : invented.length ? 'rephrase invented terms'
          : added.length ? 'rephrase added unbound tokens' : newCite ? 'rephrase bound outside the fixed cite set' : 'rephrase did not bind',
        added, invented });
      settleSmall(mech.text, mech.audit, mech.cites || [], 'mechanical (small, rephrase discarded)');
      return;
    }
    // Kept: every cite is from the set fixed before the model spoke, and no token
    // was added — so the smoothed phrasing leads and the exact mechanical reading
    // rides as the click-to-view panel. Coverage 1/1 by construction.
    AUD('step', 'veto', { decision: 'model-join', reason: 'rephrase stayed within the bound text; cites unchanged', covers: '1/1' });
    const audit = { ...mech.audit, status: mech.audit.status === 'warn' ? 'warn' : 'clean',
      note: 'Small-tier join-only: the model re-joined the mechanical reading without adding anything; every claim traces to a citation fixed before it spoke. ' + (mech.audit.note || '') };
    const mechPanel = mech.text !== boundRe.text ? { text: mech.text, audit: mech.audit, cites: mech.cites || [] } : null;
    settleSmall(boundRe.text, audit, boundRe.cites || mech.cites || [], 'model join + mechanical cite (small)', mechPanel);
  };

  // Document-referencing turn: feed the model the relevant passages and bind
  // citations mechanically. The seeker still decides what's there to say —
  // "who" is exact-mechanical; no ground → honest hold; the model only phrases.
  const runGroundedScope = async (scope, q, history, semanticHits) => {
    const myGen = genRef.current;
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
    // WI-3 — MODEL TIER (the L2 veto). How much can this model be trusted to
    // compose grounded prose? 'small' (sub-2B local) cannot, so it takes the
    // join-only path (WI-6) and never free-composes; 'capable'/'api' run the
    // free composition + convergence loop (WI-5). Default 'capable' if the
    // tier helper is unavailable (older llm.js) — i.e. today's behavior.
    const tier = (window.EOLLM && window.EOLLM.modelTier) ? window.EOLLM.modelTier(model.mlc) : 'capable';
    AUD('step', 'tier', { tier, model: model.mlc });
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
    // Discourse precedence: the active subject (conversation field) holds the
    // bound document, so a follow-up never silently rebinds to whichever
    // source has the strongest content-word overlap.
    const primaryDoc = window.EOEngine.routePrimary(scope, q, { hotEntity: hotEntity() }) || scope[0];
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
    // WI-6 — SMALL TIER: do not free-compose. The model can't compose from the
    // page reliably, so it never gets to; it only joins-and-rephrases the
    // already-bound mechanical reading, over a cite set fixed before it speaks.
    // The shape pass is skipped here (net-negative on a small model, and it
    // spends a second serial call) — the audit records the skip.
    if (tier === 'small') {
      AUD('step', 'shape', { skipped: true, tier: 'small', reason: 'small tier joins-and-rephrases the mechanical reading; no director\'s note, no free composition' });
      runGroundedSmall(scope, q, history, { mech, primaryDoc, intent, budget }).catch(turnFailed('grounded-small'));
      return;
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
    if (genStale(myGen)) return;                  // stopped during shaping — stand down
    try {
      replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
      let full = await window.EOLLM.phrase({
        mlcKey: model.mlc, question: q, contextText: ctx, history, mode: 'grounded', task,
        spans: parts ? parts.spans : null, notes: parts ? parts.notes.join('\n') : '',
        docTitle: (primaryDoc && primaryDoc.name) || '', shapeNote, maxTokens: shapeMax,
        grounded: true, onToken: streamInto({ mode: 'grounded' }), workingMemory: wm,
        depth: budget && budget.level, provenanceKeys: gateOn,
      });
      if (genStale(myGen)) return;                  // stopped while streaming — stopTurn owns the message
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
      // response" the user reads as Cleo answering when in fact the model
      // failed. Refuse honestly: a plain chat message naming the failure, an
      // audit error step for the trace, and an 'end' that records the
      // refusal. The bind-failure paths below (unbound, contradicts-assertion,
      // kin-mismatch) keep their mechanical fallback — those still have a
      // grounded signal pointing at the page, just not the one the model
      // tried to draft.
      const refuseModel = (reason, message) => {
        if (genStale(myGen)) return;                  // stopped — stopTurn already settled the message
        const audit = { status: 'error', grounded: false, covers: '0/1', stable: false,
          note: 'Refused — the model\'s draft failed audit (' + reason + '). Rather than substitute a mechanically-generated answer that would look like the model\'s reply, the turn surfaces the failure honestly.' };
        AUD('step', 'error', { where: 'grounded', message: 'refused: ' + reason });
        lastGroundedRef.current = false;
        replaceLast({ role: 'assistant', text: message, audit, mode: 'grounded' });
        AUD('end', { engine: 'refused (' + reason + ')', text: message, audit, cites: [] });
        setBusy(false);
      };
      const settle = (res, decision) => {
        if (genStale(myGen)) return;                  // stopped — stopTurn already settled the message
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
      // FIX 4: prefer the deterministic mechanical reading over a canned refusal
      // when the model's draft can't be served — a clean exact-reading IS a real
      // answer. NEVER render the editor note or an empty string. Refuse honestly
      // only when there is no usable mechanical reading to fall back on.
      const mechUsable = !!(mech && mech.text && mech.text.trim()
        && mech.audit && mech.audit.status !== 'held'
        && (mech.audit.status === 'clean' || mech.audit.status === 'warn' || mech.audit.grounded));
      const fallbackMechOrRefuse = (reason, message) => {
        if (genStale(myGen)) return;
        if (mechUsable) {
          AUD('step', 'veto', { decision: 'mechanical', reason: reason + ' → mechanical reading (no model answer to serve)' });
          settle({ text: mech.text, audit: mech.audit, cites: mech.cites || [] }, 'mechanical (' + reason + ')');
          return;
        }
        refuseModel(reason, message);
      };
      // WI-4 — THE TRUTHFUL RESIDUAL (a first-class answer, not a failure). When
      // binding the full target fails but the page DOES establish material about
      // the subject, the honest move is: void the absent target explicitly, then
      // give the bound subject material with its cites. This generalizes the
      // repair addendum to the main path. It settles as 'residual' — a success
      // (grounded, carrying no unbound assertion), distinct from 'error'
      // (refused). Returns true when it settled, false when it can't (no clearly
      // absent target, or no bound subject material) so the caller falls back.
      const residualAnswer = (reason) => {
        if (genStale(myGen)) return false;
        if (!mechUsable) return false;                      // no bound subject material to give
        let target = null;
        try { target = (window.EOEngine.referentsScope(scope, q).antimatter || [])[0] || null; } catch (e) {}
        if (!target) return false;                          // no clearly-absent target to void
        const docId = (primaryDoc && primaryDoc.id) || (scope[0] && scope[0].id) || '';
        const voidLine = `The document doesn’t establish ${target}. {{absent:${docId}:no presence found for “${target}”}}`;
        const text = voidLine + ' Here is what it does establish about the subject:\n\n' + mech.text;
        const audit = { status: 'residual', grounded: true, covers: (mech.audit && mech.audit.covers) || null, stable: true,
          note: `The target (${target}) is absent from what the page establishes, so it is voided explicitly; the bound subject material follows, cited. A residual answer (success), not an overclaim.` };
        AUD('step', 'veto', { decision: 'residual', reason, target, boundCovers: audit.covers });
        settle({ text, audit, cites: mech.cites || [] }, 'residual (' + reason + ')');
        return true;
      };
      if (modelDeclined(full)) {
        AUD('step', 'veto', { decision: 'refused', reason: 'model declined / empty / leaked reasoning' });
        fallbackMechOrRefuse('model_declined',
          'I drafted, but the model came back empty (or refused to answer, or leaked raw reasoning instead of an answer), and I have no clean reading of the page to fall back on. Try rephrasing, or point me at the line you want me to read.');
      } else if (echoesShapeNote(full, shapeNote) || looksLikeNote(full, shapeNote)) {
        AUD('step', 'veto', { decision: 'refused', reason: 'echoed the director’s note — meta about the question, not an answer' });
        fallbackMechOrRefuse('note_echo',
          'I drafted a reply, but it just paraphrased the editor’s guidance about the question rather than reading the document, and I have no clean reading to fall back on. Try rephrasing, or point me at a passage you want me to read.');
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
            if (genStale(myGen)) return;              // stopped during the stricter retry — stand down
            retry = window.EOEngine.dedupeSentences(retry);
          } catch (e) { if (window.EOLLM.isAbort(e) || genStale(myGen)) return; retry = ''; }
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
        // WI-5 — CONVERGENCE STOP (the DEF→EVA→REC loop). Re-retrieve on the
        // uncovered gap and re-pass until the bound-claim set stops growing
        // (converged at the question's resolution) or the residual gap is
        // unfillable (hand it to WI-4 as a void). Iteration is bounded; the token
        // cap is a ceiling, not the terminator. Capable/api only — the small tier
        // already converged in one pass (WI-6). A turn whose first pass already
        // covers the question adds no passes (stop = 'converged' on round 1), so
        // the well-covered case is exactly today's single pass.
        let convergeStop = 'single-pass', residualGap = [];
        if (budget && budget.replan) {
          const citeKeys = (b) => new Set(((b && b.cites) || []).map(c => c.docId + ':' + c.idx));
          const support = () => (parts ? parts.spans.map(s => s.text).join(' ') : ctx);
          let prevKeys; try { prevKeys = citeKeys(window.EOEngine.bindCitationsScope(scope, full, q, intent, { hotEntity: hotEntity() })); } catch (e) { prevKeys = new Set(); }
          for (let round = 1; round < MAX_CONVERGE_ROUNDS; round++) {
            let gaps; try { gaps = window.EOEngine.coverageGaps(q, full + ' ' + support()); } catch (e) { break; }
            if (!gaps.uncovered.length) { convergeStop = 'converged'; break; }   // resolution reached
            let more = []; try { more = window.EOEngine.retrieveScope(scope, gaps.uncovered.join(' '), 4) || []; } catch (e) { more = []; }
            if (!more.length) { convergeStop = 'residual-void'; residualGap = gaps.uncovered.slice(0, 6); break; }   // gap unfillable
            let added = false;
            if (parts) {
              for (const s of window.EOEngine.partsFromHits(scope, more).spans)
                if (!parts.spans.some(x => x.docId === s.docId && x.idx === s.idx)) { parts.spans.push(s); added = true; }
            } else {
              const extra = window.EOEngine.contextFromHits(scope, more);
              if (extra) { ctx += '\n' + extra; added = true; }
            }
            if (!added) { convergeStop = 'converged'; break; }                   // nothing new to add
            AUD('step', 'converge', { round, uncovered: gaps.uncovered, retrieved: more.length });
            if (genStale(myGen)) return;
            let next;
            try {
              replaceLast({ role: 'assistant', text: '', mode: 'grounded', streaming: true });
              next = await window.EOLLM.phrase({
                mlcKey: model.mlc, question: q, contextText: ctx, history, mode: 'grounded', task,
                spans: parts ? parts.spans : null, notes: parts ? parts.notes.join('\n') : '',
                docTitle: (primaryDoc && primaryDoc.name) || '', shapeNote, maxTokens: shapeMax,
                grounded: true, onToken: streamInto({ mode: 'grounded' }), workingMemory: wm,
                depth: budget && budget.level, provenanceKeys: gateOn,
              });
              if (genStale(myGen)) return;
              next = window.EOEngine.dedupeSentences(next);
            } catch (e) { if (window.EOLLM.isAbort(e) || genStale(myGen)) return; break; }
            if (!next || next.trim().length < 3) { convergeStop = 'converged'; break; }
            let nextKeys; try { nextKeys = citeKeys(window.EOEngine.bindCitationsScope(scope, next, q, intent, { hotEntity: hotEntity() })); } catch (e) { nextKeys = new Set(); }
            let grew = false; for (const k of nextKeys) if (!prevKeys.has(k)) { grew = true; break; }
            full = next;
            if (!grew) { convergeStop = 'converged'; break; }                    // bound-claim set stopped growing
            prevKeys = nextKeys;
            if (round === MAX_CONVERGE_ROUNDS - 1) convergeStop = 'iteration-cap';
          }
          AUD('step', 'converge-stop', { stop: convergeStop, residual: residualGap });
        }
        // WI-2 — peel any leading meta head off the converged draft, ahead of the
        // term/claim checks, so an unbound head never reaches binding or history.
        const peeled = peelMetaHead(full, shapeNote);
        if (peeled.peeled) { AUD('step', 'veto', { decision: 'peel-head', head: peeled.peeled, reason: 'leading meta clause stripped (WI-2)' }); full = peeled.text; }
        if (!full || full.trim().length < 3) {
          // Nothing real remained after peeling — route to the truthful residual
          // or the mechanical reading; never settle an empty/meta draft.
          if (!residualAnswer('empty-after-peel')) fallbackMechOrRefuse('empty_after_peel',
            'After stripping a meta preamble the draft had no actual answer left, and I have no clean reading of the page to fall back on. Try rephrasing, or point me at the line you want me to read.');
          if (!genStale(myGen)) setBusy(false);
          return;
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
        // WI-5 → WI-4: the convergence loop hit an unfillable residual gap. If
        // the answer still bound, append a registered absence for the residual,
        // so the turn settles on its best bound pass PLUS an explicit void on
        // what the sources could not cover (never silence on the gap).
        if (convergeStop === 'residual-void' && residualGap.length && bound.audit.grounded) {
          const terms = residualGap.join(', ');
          const rdoc = (primaryDoc && primaryDoc.id) || (scope[0] && scope[0].id) || '';
          bound = { ...bound, text: bound.text + ` {{absent:${rdoc}:the document does not cover ${terms}}}`,
            audit: { ...bound.audit, note: (bound.audit.note || '') + ` Residual gap left as a registered absence: ${terms}.` } };
        }
        const flagModel = (reason, note) => {
          const flagged = { ...bound,
            audit: { ...(bound.audit || {}), status: 'warn',
              note: note + (bound.audit && bound.audit.note ? ' ' + bound.audit.note : '') } };
          settle(flagged, 'model (flagged: ' + reason + ')');
        };
        if (!bound.audit.grounded) {
          // WI-4 / law L2 — the draft bound to NOTHING. Keeping it would be the
          // one dishonest move: an unbound assertion, the dominant truthfulness
          // term. Underclaim instead — the truthful residual when the page
          // establishes subject material (void the absent target, give the bound
          // subject material), else the mechanical reading, else an honest
          // refusal. Never the kept-unbound overclaim. (unbound count stays 0.)
          if (budget && budget.replan) AUD('step', 'plan-seg', { from: 'factual', to: 'question-about-silence', reason: 'the draft bound to nothing on the page' });
          AUD('step', 'veto', { decision: 'residual-or-mechanical', reason: 'unbound', invented, boundGrounded: false, boundCovers: bound.audit.covers });
          if (!residualAnswer('unbound')) fallbackMechOrRefuse('unbound',
            'I drafted an answer, but it didn’t bind to any passage in the document, and I have no clean reading of the page to fall back on — so I’d rather not assert it than overstate it. Try rephrasing, or point me at the line you want me to read.');
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
    } catch (e) {
      if (window.EOLLM.isAbort(e) || genStale(myGen)) return;   // stopped — settled by stopTurn, no fallback
      AUD('step', 'error', { where: 'grounded', message: String((e && e.message) || e) }); runMechanicalScope(scope, q); return;
    }
    if (!genStale(myGen)) setBusy(false);
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

  // ---- chat with Wikipedia (external.js knowledge augmentation) ----
  // Reference-desk mode setter (FIX 5). Any mode that may fetch ('auto'/'on')
  // records the proxy consent once; 'off' never requests it (and never fetches).
  const changeWikiMode = (next) => {
    if (next !== 'off' && next !== 'auto' && next !== 'on') return;
    setWikiMode(next);
    if (next !== 'off') { try { window.EOExternal && window.EOExternal.grantConsent && window.EOExternal.grantConsent(); } catch (e) {} }
  };
  // The composer Wikipedia button is a per-message FORCE ("take a stab now") in
  // the active modes — it bypasses the acquisition gate for the next send only
  // (it offers options to research; it does not fetch). Pressing it implies
  // consent to consult the desk, recorded once.
  const toggleForceEnrich = () => setForceEnrich(v => {
    const next = !v;
    if (next) { try { window.EOExternal && window.EOExternal.grantConsent && window.EOExternal.grantConsent(); } catch (e) {} }
    return next;
  });

  // Commit an externally-sourced document into the graph WITHOUT the upload
  // path's UI seizure (no tab focus, no layout change, no busy flip): it is a
  // background source the turn pulled in, surfaced through the chip + the card.
  const ingestExternalSource = async (name, text) => {
    const dup = docsRef.current.find(d => d.name === name);
    if (dup) return dup;
    const id = uid('doc');
    let doc;
    try { doc = await window.EOEngine.parseDocument(name, text, id); }
    catch (e) { eoWarn('external source parse', e); return null; }
    // FIX 3a: mark it provisional — a background enrichment grab earns its place
    // in the corpus only by grounding an answer (depositSettled clears the flag);
    // until then the sweep can reap it so it never competes for primary/retrieval.
    doc.provenance = 'enrichment'; doc.provisional = true; doc.provTurn = turnSeqRef.current;
    setDocs(ds => ds.some(d => d.id === doc.id) ? ds : [...ds, doc]);
    return doc;
  };

  // Render a Wikipedia article payload into an ingestible prose document.
  // Article payload → ingestible text. EOExternal owns the composition
  // (punctuated title/description paragraphs, boilerplate bands dropped,
  // headings kept for the chrome gate); the raw join survives only as the
  // fallback for an older external.js.
  const buildWikiDocText = (p) => {
    const X = window.EOExternal;
    if (X && X.articleDocText) return X.articleDocText(p);
    const parts = [];
    if (p.title) parts.push(p.title);
    if (p.description) parts.push(p.description);
    parts.push('');
    parts.push((p.text && p.text.trim()) ? p.text.trim() : (p.intro || ''));
    parts.push('');
    if (p.url) parts.push('Source: ' + p.url);
    return parts.join('\n').trim();
  };

  // An acquisition term is AMBIGUOUS against the active subject when it is a
  // bare single token that the active subject's multi-word name also carries
  // ("look up Shore" while "Howard Shore" is active — could mean this Shore or
  // another). A fully distinct multi-word name ("look up Pauly Shore") is not
  // ambiguous and still fetches. Narrow by design: better to fetch a clearly
  // new subject than to block it.
  const _termCollidesWithActive = (term, hot) => {
    const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const a = norm(term), b = norm(hot);
    if (!a || !b || a === b) return false;
    const aw = a.split(' ');
    if (aw.length !== 1 || aw[0].length < 3) return false;
    const bw = b.split(' ');
    return bw.length > 1 && bw.includes(aw[0]);
  };

  // Decide whether THIS turn should take a stab at Wikipedia. The acquisition
  // gate (intent + identity + corpus-resolution + active-subject follow-up) is
  // unchanged and still FAILS CLOSED — a missing or throwing decider SUPPRESSES
  // the off-device search rather than waving it through. A turn that clears the
  // gate (or is forced past it) never fetches an article on its own: it runs a
  // lightweight OPTIONS search and offers the candidates on the live reply ("want
  // me to research one of these?"), and only when the reader picks one does the
  // full article get pulled in (runWikiSearch, on click). `opts.force` — the
  // per-message FORCE button or 'on' mode — does NOT fetch; it only BYPASSES the
  // gate so any message takes a stab (corpus resolution still short-circuits to
  // an already-ingested doc). The deep fetch is always a click away.
  const chatWikipedia = async (q, turnId, opts) => {
    const X = window.EOExternal;
    if (!X || !X.enabled || !X.enabled()) return null;
    const E = window.EOEngine;
    const force = !!(opts && opts.force);
    const term = (X.pickQuery && X.pickQuery(q)) || q;
    // A vague follow-up ("tell me more", "why?") names no new subject — keep
    // chatting against whatever Wikipedia articles are already in scope rather
    // than pulling a spurious one. The substantive turn did the ingest.
    if (!term || term.length < 3 || /^(more|it|that|this|them|those|they|he|she|why|how|ok|okay|yes|no|sure|tell|again|continue|else|next|so|and|but)$/i.test(term)) return null;
    // ── Acquisition gate (intent + identity decide, never the bare proper noun).
    // FIX 2 — the gate FAILS CLOSED: a reference-desk fetch is the privileged,
    // off-device action, so a missing or throwing decider SUPPRESSES it rather
    // than waving it through. A per-message force ('on' mode or the composer
    // button) skips the intent/identity gate (but never the corpus check below).
    // EXPLICIT acquisition = the message itself asks to look something up (a
    // lookup verb / frame, or "who is / what is <ProperName>"). Computed once: it
    // gates the auto path AND tells the caller this offer earns a coordinated
    // reply, instead of a model free-association that contradicts the card.
    let explicit = false;
    try { explicit = !!(X.acquireIntent && X.acquireIntent(q)); } catch (e) { eoWarn('acquireIntent', e); }
    const hot = (!force && typeof hotEntity === 'function') ? hotEntity() : null;
    if (!force) {
      //   (1) the turn must EXPLICITLY ask to acquire (a lookup verb / frame). A
      //       bare factual or follow-up question ("what are his inspirations?")
      //       is intent: factual and never reaches the fetcher.
      if (typeof X.acquireIntent !== 'function') return null;
      if (!explicit) return null;
      //   (3) a follow-up bound to the active subject answers against the held
      //       document — nothing to acquire. With an active subject we MUST be
      //       able to prove it isn't such a follow-up, or we don't fetch.
      if (hot) {
        if (!E || typeof E.discourseBinding !== 'function') return null;
        let b; try { b = E.discourseBinding(scopeList(), q, { hotEntity: hot }); } catch (e) { eoWarn('discourseBinding', e); return null; }
        if (b && b.hold) return null;
      }
    }
    //   (2) corpus resolution FIRST (even when forced): a subject already
    //       ingested (resolved by entity, not surface) binds to the existing
    //       document — no re-fetch, no duplicate. FIX 2 fail-closed: if we can't
    //       check the corpus, we can't prove a fetch is warranted, so we don't.
    if (!E || typeof E.resolveSubjectDoc !== 'function') return null;
    let have; try { have = E.resolveSubjectDoc(docsRef.current, term); } catch (e) { eoWarn('resolveSubjectDoc', e); return null; }
    if (have) { addSource(have.id); return { doc: have }; }
    // Ambiguous acquisition (a bare token that collides with the active subject —
    // "look up Shore" while a different Shore is active) must not silently
    // fetch-and-swap; hold (gate only — a force overrides).
    if (!force && hot && _termCollidesWithActive(term, hot)) return null;
    // The turn reaches here either because the gate decided it (Auto) or because
    // a force waved it past the gate ('on' mode / the per-message button). EITHER
    // WAY it only takes a stab and OFFERS options — it NEVER pulls a full article
    // in on its own. The CALLER fires the lightweight search and surfaces the
    // candidates; the reader picks one (runWikiSearch) and only THEN is the
    // article fetched and ingested. An EXPLICIT lookup ("search wikipedia for X")
    // additionally earns a coordinated reply (the card is the answer); a soft
    // force ('on' mode / the button on a chatty message) shows the card alongside
    // the model's reply. This turn injects no doc: it answers from what's already
    // in scope, and the chosen article grounds later turns.
    return { offered: true, term, explicit };
  };

  // The "initial search → offer options" step (the AUTOMATIC path). A cheap
  // list=search surfaces the candidate articles for the term; the reader then
  // chooses which (if any) to research. The only off-device request here is the
  // search — nothing is fetched in full or ingested until the reader picks an
  // option (runWikiSearch → fetchWikiArticle). Best-effort; drives the live
  // message's card by turnId through its searching → options lifecycle.
  const offerWikiOptions = async (turnId, term) => {
    const X = window.EOExternal;
    const tag = (patch) => setMessages(ms => ms.map(m => m.turnId === turnId ? { ...m, enrichment: patch } : m));
    try { X && X.grantConsent && X.grantConsent(); } catch (e) {}
    // Returns the final outcome ({ status, term, options? }) so a caller settling a
    // coordinated reply can match its words to what the card shows.
    // Older external.js without the options search → degrade to a single editable
    // confirm card (the picked term), so the feature still works.
    if (!X || typeof X.searchOptions !== 'function') { tag({ status: 'confirm', term }); return { status: 'confirm', term }; }
    tag({ status: 'searching', term });
    let res;
    try { res = await X.searchOptions(term); }
    catch (e) { res = { status: 'error', error: String((e && e.message) || e) }; }
    if (!res || res.status === 'disabled') { tag(null); return { status: 'disabled', term }; }          // lookups off → no card
    if (res.status === 'gated') { tag({ status: 'gated', term }); return { status: 'gated', term }; }
    if (res.status === 'error') { tag({ status: 'error', term, error: res.error }); return { status: 'error', term, error: res.error }; }
    if (res.status === 'hit' && res.options && res.options.length) { const options = res.options.slice(0, 6); tag({ status: 'options', term, options }); return { status: 'options', term, options }; }
    tag({ status: 'no-options', term }); return { status: 'no-options', term };
  };

  // The coordinated reply for an EXPLICIT Wikipedia lookup ("search wikipedia for
  // dolphins"). The options card IS the substantive output; this is the short,
  // honest line that pairs with it — never a model "summary" of an article it has
  // not read (the local model fabricates one, contradicting the card). Tailored to
  // the search outcome so the words match what the card actually shows. Picking a
  // match is no longer a dead end: the click reads that article and answers with
  // citations in the same reply (runWikiSearch → answerFromWikiPick).
  const wikiOfferReply = (term, res) => {
    const t = '“' + term + '”';
    const status = res && res.status;
    if (status === 'options') {
      const opts = (res && res.options) || [];
      if (opts.length === 1) return `I found one Wikipedia match for ${t}: “${opts[0].title}”. Click it and I’ll read the full article and answer with citations.`;
      return `I searched Wikipedia for ${t} — the matches are above. Pick one and I’ll read the full article and answer with citations, rather than summarizing it from memory.`;
    }
    if (status === 'gated') return `I held back on ${t} — it reads as a private individual, and the reference desk doesn’t resolve people against Wikipedia.`;
    if (status === 'error') return `I tried to search Wikipedia for ${t} but couldn’t reach it just now. Give it a moment and try again.`;
    if (status === 'disabled') return `Wikipedia lookups are off, so I can’t search for ${t}. Turn the reference desk on and I’ll pull the article in.`;
    if (status === 'confirm') return `I can search Wikipedia for ${t} — confirm the term in the card above and I’ll read the article and answer with citations.`;
    return `I searched Wikipedia for ${t} but didn’t find a matching article. Try different wording, or ask me something else.`;
  };

  // The reader chose an article to research (or confirmed the single term on the
  // fallback card). This is the thin click handler; answerFromWikiPick owns the
  // read → ground → settle and resets busy on every exit. The card does not await
  // it, so a throw here can't strand the composer — surface it and release busy.
  const runWikiSearch = (turnId, rawTerm) => {
    answerFromWikiPick(turnId, rawTerm).catch((e) => { eoWarn('wiki-research', e); setBusy(false); });
  };

  // The reader dismissed the proposed search — clear the card, fetch nothing.
  const dismissWikiSearch = (turnId) => setMessages(ms => ms.map(m => m.turnId === turnId ? { ...m, enrichment: null } : m));

  // The actual off-device fetch: pull the article, drive the live message's card
  // through its loading → result lifecycle, and ingest a hit as a citable source.
  // `deferred` selects the footer copy — `false` (the only live caller now) means
  // the answer settles in THIS reply right below the card; `true` is the legacy
  // "ask a follow-up" footer. Returns `{ doc, status }` — the ingested doc (so the
  // caller can thread it into scope and ground on it) and the upstream status
  // (hit / miss / gated / error) so the caller can word an honest line on a
  // non-hit without re-reading React state. Best-effort throughout.
  const fetchWikiArticle = async (turnId, term, deferred) => {
    const X = window.EOExternal;
    const tag = (patch) => setMessages(ms => ms.map(m => m.turnId === turnId ? { ...m, enrichment: patch } : m));
    try { X.grantConsent && X.grantConsent(); } catch (e) {}
    tag({ loading: true, term });
    let res;
    try { res = await X.article(term); }
    catch (e) { res = { status: 'error', error: String((e && e.message) || e) }; }
    const base = { ...res, term, query: (res && res.query) || term };
    tag(base);
    const status = (res && res.status) || 'error';
    if (status !== 'hit' || !res.payload) return { doc: null, status };
    const name = 'Wikipedia · ' + res.payload.title;
    let doc = docsRef.current.find(d => d.name === name);
    if (!doc) {
      const text = buildWikiDocText(res.payload);
      if (text && text.replace(/\s+/g, ' ').trim().length > 60) doc = await ingestExternalSource(name, text);
    }
    if (doc) { addSource(doc.id); tag({ ...base, ingested: { id: doc.id, name, deferred: !!deferred } }); }
    return { doc: doc || null, status };
  };

  // The reader picked an article from the offer (or confirmed the single term):
  // make good on what the offer promised — "I'll read the full article and answer
  // with citations" — instead of ingesting in silence and waiting for a re-ask.
  // Pull the article in, then settle a GROUNDED answer about it INTO THIS REPLY,
  // the article card pinned above it (the shape chat.jsx already lays out: card on
  // top, the response below reads from it). Honest the whole way — the card shows
  // the reading state, the reply shows the thinking indicator, and the settled
  // answer is bound to the article's lines, or to its mechanical reading when no
  // model is available here (a miss/gate/error settles an honest line, never a
  // fabricated answer). Owns busy + the generation guard end to end.
  const answerFromWikiPick = async (turnId, rawTerm) => {
    const X = window.EOExternal;
    const term = String(rawTerm == null ? '' : rawTerm).trim();
    if (!X || !X.enabled || !X.enabled() || !term) return;
    if (busyRef.current) return;                 // a turn is already in flight — ignore the click
    const myGen = ++genRef.current;              // a fresh generation; Stop (or a new turn) supersedes it
    setBusy(true);

    // The settle helpers (replaceLast/streamInto) write to the LAST message, so
    // the grounded answer needs the right message to be last. Two cases:
    //  • an EXPLICIT-lookup offer ("pick one and I'll read it") IS this reply, so
    //    reuse it in place — the offer line becomes the grounded answer, the card
    //    above it (the shape chat.jsx lays out). Marked `wikiOffer` at settle time.
    //  • a SOFT offer sits beside a real answer the reader already saw (a doc reply
    //    with a "research this?" card), so don't clobber it: append a fresh reply
    //    below and move the card onto it. Same if the reader sent something after
    //    the offer (it's no longer last).
    const ms0 = messagesRef.current || [];
    const xi = ms0.findIndex(m => m.turnId === turnId);
    const offerMsg = xi >= 0 ? ms0[xi] : null;
    const reuse = xi >= 0 && xi === ms0.length - 1 && !!(offerMsg && offerMsg.wikiOffer);
    let cardTurnId = turnId;
    if (reuse) {
      patchLast({ typing: true, loading: false, streaming: false, interrupted: false, text: '' });
    } else {
      cardTurnId = 'wt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      setMessages(m => [...m.map(mm => mm.turnId === turnId ? { ...mm, enrichment: null } : mm),
                        { role: 'assistant', typing: true, turnId: cardTurnId }]);
    }

    // What the reader actually asked, recovered from the user turn that opened
    // this offer — so a real content question ("who is …") is answered as asked,
    // while a bare acquisition frame ("search wikipedia for …") becomes a grounded
    // overview of the article they chose.
    let originalQ = '';
    for (let i = xi - 1; i >= 0; i--) { const m = ms0[i]; if (m && m.role === 'user' && m.text) { originalQ = m.text; break; } }

    // Pull + ingest the article. The card runs reading → added, keyed to the reply
    // that will hold the answer; deferred:false — the answer settles right below it.
    let doc = null, status = 'error';
    try { const r = await fetchWikiArticle(cardTurnId, term, false); doc = r && r.doc; status = (r && r.status) || 'error'; }
    catch (e) { eoWarn('wiki-fetch', e); }
    if (genStale(myGen)) return;                 // stopped during the fetch

    if (!doc) {
      // miss / gated / error: the card already shows why. Settle a short honest
      // line that matches it — never a fabricated answer (abstain, never fabricate).
      const t = '“' + term + '”';
      const why = status === 'gated'
        ? `I held back on ${t} — it reads as a private individual, and the reference desk doesn’t resolve people against Wikipedia.`
        : status === 'error'
        ? `I couldn’t reach Wikipedia for ${t} just now. Give it a moment and try again.`
        : `I couldn’t find a Wikipedia article for ${t}.`;
      replaceLast({ role: 'assistant', text: why, audit: null });
      AUD('end', { engine: 'reference', text: why, audit: null, reason: status || 'no-article' });
      setBusy(false);
      return;
    }

    // The grounded question: the reader's own question when it carried real
    // content, else an overview of the article they chose.
    const isBareLookupFrame = (s) => {
      const x = String(s || '').trim().toLowerCase();
      if (!x) return true;
      const lead = /^(search|look\s*up|lookup|find|google|pull\s*up|bring\s*up|show\s*me)\b/.test(x);
      const wh = /\b(who|what|which|whom|whose|when|where|why|how)\b/.test(x);
      return lead && !wh;                        // a pure acquisition frame, no content question
    };
    const title = doc.name.replace(/^Wikipedia · /, '');
    const gq = (originalQ && !isBareLookupFrame(originalQ)) ? originalQ : ('Tell me about ' + title);

    let scope = scopeList();
    if (!scope.some(d => d.id === doc.id)) scope = [doc, ...scope];   // state may not have flushed; thread it in directly
    const history = historyFor();

    // A fresh turn budget (mirrors runTurn) and the model, loaded on demand.
    const budget = (window.EOEngine && window.EOEngine.thinkingBudget) ? window.EOEngine.thinkingBudget(999) : null;
    turnBudgetRef.current = budget; turnAssocRef.current = [];
    const canLLM = !!(window.EOLLM && (model.provider === 'anthropic'
      ? window.EOLLM.hasAnthropicKey()
      : model.provider === 'wllama'
      ? (!window.EOLLM.hasWasm || window.EOLLM.hasWasm())
      : window.EOLLM.hasWebGPU()));

    // Open the grounded answer's audit record (the offer turn closed its own) and
    // pin it to this reply, so the thinking panel shows the grounded trace.
    const auditId = AUD('begin', {
      input: gq, mode, budget,
      scope: auditScope(scope),
      model: { id: model.id, name: model.name, mlc: model.mlc },
      hasWebGPU: canLLM, via: 'wikipedia-pick', term: title,
    });
    if (auditId) patchLast({ auditId });

    if (canLLM && !window.EOLLM.isLoaded(model.mlc)) {
      patchLast({ typing: false, loading: true, loadPct: modelProgress, loadName: model.name, loadCloud: model.provider === 'anthropic', loadCpu: model.provider === 'wllama' });
      const ok = await loadModel(model);
      if (genStale(myGen)) return;                // stopped during the load — stopTurn already settled
      AUD('step', 'model', { action: 'load', model: model.name, ok: !!ok });
      patchLast({ loading: false, typing: true });
    }
    const ready = !!(window.EOLLM && window.EOLLM.isLoaded(model.mlc));
    AUD('set', { modelReady: ready });

    lastGroundedRef.current = true; everGroundedRef.current = true;
    const useLLM = ready && doc.kind === 'prose';
    AUD('step', 'route', { referencing: true, reason: 'wikipedia-pick', confidence: 'forced',
      path: useLLM ? 'grounded-llm' : 'mechanical',
      primary: { id: doc.id, name: doc.name, kind: doc.kind } });
    // runGroundedScope / runMechanicalScope settle the reply and reset busy.
    if (useLLM) { runGroundedScope(scope, gq, history, null).catch(turnFailed('grounded')); return; }
    runMechanicalScope(scope, gq);
  };

  // Outer guard around turn routing: a throw in the router itself (or in an
  // awaited router step like the escalation retrieval) must never leave busy
  // stuck true. runTurn dispatches to the detached streaming paths and returns;
  // this only catches a synchronous routing fault or a rejected await within it.
  // Stop the turn that's mid-flight: halt the model (generation OR an in-flight
  // download), invalidate the generation so no late settle clobbers the result,
  // and freeze the in-progress assistant message as a STOPPED reply that keeps
  // whatever streamed so far. Idle → no-op, so the Stop button is inert between
  // turns. The audit trace is closed as `stopped` so the thinking panel settles.
  const stopTurn = () => {
    if (!busyRef.current) return;
    // Only act on a genuine in-flight chat turn — an assistant placeholder that's
    // still typing/loading/streaming. Other busy states (e.g. ingest enrichment)
    // own their own lifecycle and must not have a settled reply rewritten.
    const m = messagesRef.current || [];
    const last = m.length ? m[m.length - 1] : null;
    const inFlight = !!(last && last.role === 'assistant' && (last.typing || last.loading || last.streaming));
    if (!inFlight) return;
    genRef.current++;                                            // supersede every in-flight settle
    try { window.EOLLM && window.EOLLM.interrupt && window.EOLLM.interrupt(); } catch (e) { eoWarn('interrupt', e); }
    try { window.EOLLM && window.EOLLM.cancelLoad && window.EOLLM.cancelLoad(); } catch (e) {}   // also halt a model still downloading
    setMessages(cur => {
      if (!cur.length) return cur;
      const c = cur.slice(); const l = c[c.length - 1];
      if (!l || l.role !== 'assistant') return cur;
      const partial = l.text && l.text.trim() ? l.text : '';
      c[c.length - 1] = { ...l, typing: false, loading: false, streaming: false, interrupted: true, text: partial };
      return c;
    });
    try { AUD('end', { engine: 'stopped', text: '', audit: null, reason: 'user-interrupt' }); } catch (e) {}
    setBusy(false);
  };

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
    // Open a fresh generation. Stop (and any later turn) bumps this; the awaits
    // below and the detached streaming paths all stand down once superseded.
    const myGen = ++genRef.current;

    // hero: a long paste with no doc is a document to read, not a question
    const noDocs = docs.length === 0;
    if (noDocs && (q.length > 140 || /\n/.test(q))) { ingest('Pasted text.txt', q); return; }

    const history = historyFor();
    const turnId = 'wt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setMessages(m => [...m, { role: 'user', text: q }, { role: 'assistant', typing: true, turnId }]);
    setBusy(true); ensureChat(q);
    // FIX 3c: advance the turn clock and reap any aged-out provisional enrichment
    // docs that never grounded an answer (so they stop competing for primary).
    turnSeqRef.current++;
    sweepProvisional(false);
    // Consume the per-message reference-desk FORCE (composer Wikipedia button):
    // read it for this turn and clear the one-shot flag.
    const forcedThisMessage = forceEnrich;
    if (forcedThisMessage) setForceEnrich(false);

    // Paint the send immediately. The user's bubble and the typing indicator are
    // committed above, but everything that follows on this turn — routing, graph
    // traversal, retrieval, prompt building in the detached runners — is heavy
    // synchronous work that would otherwise block the browser from painting that
    // feedback, so a send feels frozen while the turn churns. Yield one macrotask
    // so React flushes and the browser paints the bubble + "…" before the work
    // starts; the turn then proceeds, lagging on its own without holding the UI.
    await new Promise(res => setTimeout(res, 0)); // yield to paint

    // CHAT WITH WIKIPEDIA: consult the reference desk per the mode —
    //   off  → never (the composer FORCE button is hidden, so a force can't reach)
    //   auto → only when the acquisition gate passes
    //   on   → every substantive turn, past the gate (a standing "always take a
    //          stab"); the FORCE button does the same for one send.
    // In every case the turn only TAKES A STAB and offers options — it never pulls
    // an article in on its own (the reader clicks an option to ingest one, which
    // grounds later turns). chatWikipedia returns a small decision: { doc } for an
    // ALREADY-ingested corpus match (threaded into this turn's scope), or
    // { offered, term, explicit } for an options offer — an EXPLICIT lookup gets a
    // coordinated reply below, a soft force shows the card alongside the model's
    // reply. `force` ('on' / the button) bypasses the gate, not the offer.
    let injectedDoc = null;
    let wikiOffer = null;
    const forceWiki = wikiMode === 'on' || forcedThisMessage;
    if (wikiMode !== 'off' && window.EOExternal && window.EOExternal.enabled && window.EOExternal.enabled()) {
      let wr = null;
      try { wr = await chatWikipedia(q, turnId, { force: forceWiki }); } catch (e) { eoWarn('wiki-chat', e); }
      if (wr && wr.doc) injectedDoc = wr.doc;             // an already-ingested corpus match, threaded into scope
      else if (wr && wr.offered) {
        wikiOffer = wr;
        // A SOFT offer ('on' mode / the button on a chatty message) shows the card
        // alongside the model's reply — fire it now and let the turn proceed. An
        // EXPLICIT lookup ("search wikipedia for X") is decided once scope is known
        // (below): a turn-taking card when there's nothing to ground on, else a
        // side-offer beside the grounded answer.
        if (!wr.explicit) offerWikiOptions(turnId, wr.term).catch((e) => eoWarn('wiki-options', e));
      }
    }

    let doc = backingDoc() || injectedDoc;
    let scope = scopeList();   // explicit source chips, else the focused doc
    if (injectedDoc && !scope.some(d => d.id === injectedDoc.id)) scope = [injectedDoc, ...scope];

    // An EXPLICIT lookup ("search wikipedia for X") with NOTHING in scope to
    // ground on takes over the turn: the options card is the answer, settled below
    // with a coordinated reply so the model never fabricates a "summary" (abstain,
    // never fabricate). With a document already in scope the card is only a
    // side-offer — fire it now and let the turn ground on the doc as usual (so
    // "search the document for X" still answers from the document). A soft offer
    // ('on' mode / the button on a chatty message) was already fired above.
    const wikiTakeover = !!(wikiOffer && wikiOffer.explicit && !scope.length);
    if (wikiOffer && wikiOffer.explicit && !wikiTakeover) offerWikiOptions(turnId, wikiOffer.term).catch((e) => eoWarn('wiki-options', e));

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
    // WI-7 (law L1): record whether any prior non-clean turn would carry its
    // unverified tokens into THIS turn's assembled model history. Zero by
    // construction (histTextFor neutralizes every such turn); a non-empty list
    // is a monotonicity violation, surfaced in the glass box.
    { const l1 = l1Violations(); if (l1.length) AUD('set', { l1Violations: l1 }); }

    // DETERMINISTIC ARITHMETIC (mechanical, no model). A turn that is
    // essentially a math expression is evaluated by math.js; figures that also
    // appear in an open source are bound to their line so the worked math is
    // checkable. Non-math turns return null here and fall through to ordinary
    // routing. Runs before the model loads — a sum shouldn't wake a model.
    let calc = null;
    try { calc = (window.EOCompute && window.EOCompute.detect) ? window.EOCompute.detect(q, scope) : null; }
    catch (e) { eoWarn('calc', e); }
    if (calc) {
      lastGroundedRef.current = false;
      AUD('step', 'route', { referencing: calc.cites.length > 0, reason: 'calculation', path: 'calc' });
      AUD('step', 'calculation', { shown: calc.shown, eval: calc.eval, display: calc.display, result: calc.result, operands: calc.operands, cites: calc.cites });
      replaceLast({ role: 'assistant', text: calc.text, audit: null, mode: 'grounded', calc });
      AUD('end', { engine: 'mechanical', text: calc.text, audit: calc.audit, cites: calc.cites });
      setBusy(false);
      return;
    }

    // EXPLICIT WIKIPEDIA SEARCH with nothing to ground on. The turn asked, in so
    // many words, to look something up ("search wikipedia for dolphins"), the
    // subject isn't already in the corpus, and no document is in scope — so the
    // OPTIONS card is the answer. Run the search, show the matches, and settle a
    // short honest reply that points at them; do NOT wake the model to "summarize
    // Wikipedia" from memory, which contradicts the card and fabricates (abstain,
    // never fabricate). Picking a match then reads that article and answers with
    // citations IN PLACE — this reply becomes the grounded answer (the offer line
    // is marked `wikiOffer` so answerFromWikiPick reuses it rather than appending).
    if (wikiTakeover) {
      lastGroundedRef.current = false;
      const res = await offerWikiOptions(turnId, wikiOffer.term);
      if (genStale(myGen)) return;                        // stopped during the search
      const reply = wikiOfferReply(wikiOffer.term, res);
      const clickable = !!(res && (res.status === 'options' || res.status === 'confirm'));
      AUD('step', 'route', { referencing: false, reason: 'wiki-offer', path: 'wiki-offer' });
      replaceLast({ role: 'assistant', text: reply, audit: null, wikiOffer: clickable });
      AUD('end', { engine: 'reference', text: reply, audit: null, reason: (res && res.status) || 'offered' });
      setBusy(false);
      return;
    }

    // load the real model on demand if it isn't ready yet
    if (canLLM && !wasLoaded) {
      patchLast({ typing: false, loading: true, loadPct: modelProgress, loadName: model.name, loadCloud: model.provider === 'anthropic', loadCpu: model.provider === 'wllama' });
      const ok = await loadModel(model);
      if (genStale(myGen)) return;                  // stopped during the load — stopTurn already settled
      AUD('step', 'model', { action: 'load', model: model.name, ok: !!ok });
      patchLast({ loading: false, typing: true });
    }
    const ready = !!(window.EOLLM && window.EOLLM.isLoaded(model.mlc));
    AUD('set', { modelReady: ready });

    // COMPUTATION: the opt-in second mechanical source (pyodide.js). When the
    // toggle is on, a model is ready, and a tabular source is in scope, give the
    // turn the option to COMPUTE — the EO engine grounds prose but structurally
    // cannot sum a column or group a CSV. The model still only phrases; Python
    // run locally produces the figure, and the code + its output ride into the
    // audit and onto the message. The model decides whether a computation is
    // needed (native tool_use for Claude, a parsed fenced block for a local
    // model), so a non-computational table question still answers in words.
    if (mode !== 'creative' && ready && window.EOPython && window.EOPython.enabled && window.EOPython.enabled()) {
      const pyDoc = scope.find(d => d && d.kind === 'table' && Array.isArray(d.rows) && d.rows.length);
      // Smart parse owns filter/slice/group questions it can resolve from the
      // table's own schema (faster, grounded, with clarify + save-as-view);
      // Python stays the tool for computations the fold can't express, so it
      // yields when the smart path would claim this turn.
      const smartOwns = pyDoc && smartParse && window.EOTableQuery && window.EOTableQuery.looksLikeTableQuery(q, pyDoc);
      if (pyDoc && !smartOwns) {
        AUD('step', 'route', { referencing: true, path: 'compute', reason: 'computation toggle',
          primary: { id: pyDoc.id, name: pyDoc.name, kind: pyDoc.kind } });
        lastGroundedRef.current = true; everGroundedRef.current = true;
        runComputeScope(pyDoc, q, history).catch(turnFailed('compute'));
        return;
      }
    }

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
                primary: window.EOEngine.routePrimary(scope, q, { hotEntity: hotEntity() }) || scope[0] };
    } else if (scope.length) {
      // hadReply: repair needs a conversation to repair — any settled assistant
      // reply counts, grounded or not (the trace's "someone's son is mentioned"
      // followed a PLAIN-chat miss, so prevGrounded alone would drop it).
      const hadReply = messages.some(m => m.role === 'assistant' && m.text && !m.typing && !m.loading);
      route = window.EOEngine.routeTurn(scope, q, { prevGrounded: lastGroundedRef.current, hadReply, everGrounded: everGroundedRef.current, hotEntity: hotEntity() });
    } else {
      route = { decision: 'chat', confidence: 'none', reason: 'no-scope' };
    }

    // REPAIR: the turn pushes back on the previous reply rather than asking
    // fresh content. Mark the rejected reply (history hygiene), then re-read
    // the question actually under repair instead of retrieving on the complaint.
    if (route.decision === 'repair') {
      const primary = route.primary || window.EOEngine.routePrimary(scope, q, { hotEntity: hotEntity() }) || scope[0];
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
      if (genStale(myGen)) return;                  // stopped during the recall — stand down
      const recovered = hits.length && (reader.indexOf('embedding') >= 0 ? hits.some(h => h.semantic) : true);
      AUD('step', 'escalate', { reason: route.reason, reader, found: hits.length, recovered: !!recovered });
      if (recovered) { route.decision = 'mechanical'; route.confidence = 'recovered'; semanticHits = hits.filter(h => h.semantic).length ? hits : null; route.primary = route.primary || window.EOEngine.routePrimary(scope, q, { hotEntity: hotEntity() }) || scope[0]; }
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
          route.primary = route.primary || window.EOEngine.routePrimary(scope, cq, { hotEntity: hotEntity() }) || scope[0];
        }
      }
    }

    const referencing = route.decision === 'mechanical';
    lastGroundedRef.current = referencing;
    if (referencing) everGroundedRef.current = true;

    if (referencing) {
      const primary = route.primary || window.EOEngine.routePrimary(scope, q, { hotEntity: hotEntity() }) || scope[0];
      // SMART TABLE PATH: a data question over a table runs through the schema-
      // aware resolver — it reads THIS table's real columns and values, resolves
      // "clients from Mexico" to Country = Mexico, and asks a short clarifying
      // question when a value is ambiguous (the back-and-forth). The fold still
      // computes the count. Off (Smart parse) → the plain pivot path below.
      if (smartParse && primary && primary.kind === 'table' && window.EOTableQuery) {
        runTableQuery(scope, q, primary, history).catch(turnFailed('table'));
        return;
      }
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
  const newChat = () => { sweepProvisional(true); setMessages([]); setActiveChat('new'); lastGroundedRef.current = false; everGroundedRef.current = false; lastCarryRef.current = null; repairCountRef.current = 0; resetField(); if (mobileRef.current) setCollapsed(true); };
  const selectChat = (id) => { sweepProvisional(true); setActiveChat(id); lastGroundedRef.current = false; everGroundedRef.current = false; lastCarryRef.current = null; repairCountRef.current = 0; resetField(); if (mobileRef.current) setCollapsed(true); };

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

  // A chat turn is generating (Stop is offered) when busy AND the last message
  // is an in-flight assistant placeholder — never during ingest or other busy
  // states, which own their own lifecycle.
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const generating = busy && !!lastMsg && lastMsg.role === 'assistant'
    && (lastMsg.typing || lastMsg.loading || lastMsg.streaming);

  const composerProps = {
    value: input, onChange: setInput, onSend: () => send(), onStop: stopTurn, generating, mode, onMode: setMode, showModeToggle,
    onAttach: () => fileRef.current.click(), busy,
    sources: sources.map(id => docsById[id]).filter(Boolean).map(d => ({ id: d.id, name: d.name, kind: d.kind })),
    addable: docs.filter(d => !sources.includes(d.id)).map(d => ({ id: d.id, name: d.name, kind: d.kind })),
    onAddSource: addSource, onRemoveSource: removeSource,
    wikiMode, forceEnrich, onForceEnrich: toggleForceEnrich,
    smartParse, onSmartParse: () => setSmartParse(v => !v), hasTable: docs.some(d => d.kind === 'table'),
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
        onSettingsClick={() => setSettingsOpen(true)}
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
                  <ChatPane messages={messages} onCite={flashCitation} composerProps={composerProps} narrow={showDocPane} wide={layout === 'chat'} onExportPrompts={exportPrompts} showGrounding={groundingInfo} onConfirmWiki={runWikiSearch} onDismissWiki={dismissWikiSearch} onOpenDoc={openTab}
                    onApplyTableView={applyTableView} onSaveTableView={saveTableView} onQuickReply={send} />
                </div>
              )}
              {showDocPane && showChat && <div className={'divider' + (dragging ? ' dragging' : '')} onMouseDown={() => setDragging(true)} />}
              {showDocPane && (
                <DocPane openTabs={openTabs} activeTab={activeTab} docsById={docsById}
                  onActivate={setActiveTab} onClose={closeTab} layout={layout} onLayout={setLayout}
                  explore={explore} onToggleExplore={() => setExplore(x => !x)}
                  onEntity={onEntity} activeEntity={activeEntity} flashSent={flashSent} onCite={flashCitation} tableSpec={tableSpec}
                  savedViews={savedViews} onApplyView={applyTableView} onSaveView={saveTableView} onDeleteView={deleteTableView} />
              )}
            </React.Fragment>
          )}
        </div>
      </main>

      {rulesOpen && <RulesDrawer rules={rules} langModes={langModes}
        learnedByLang={window.EOEngine && window.EOEngine.learnedVerbsByLang ? window.EOEngine.learnedVerbsByLang() : {}}
        onToggle={toggleRule} onInstall={installRule} onSetLangMode={setLangMode} onImport={importRules} onClose={() => setRulesOpen(false)} onToast={showToast} />}
      {sandboxOpen && <SandboxDrawer onClose={() => setSandboxOpen(false)} onToast={showToast} mlcKey={model && model.mlc} modelReady={modelStatus === 'ready'} />}
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)}
        theme={theme} onTheme={setTheme} reduceMotion={reduceMotion} onReduceMotion={setReduceMotion}
        pythonEnabled={pythonEnabled} onPythonEnabled={setPython} pythonAvailable={!!window.EOPython}
        groundingInfo={groundingInfo} onGroundingInfo={setGroundingInfo}
        showModeToggle={showModeToggle} onShowModeToggle={setShowModeToggle}
        wikiMode={wikiMode} onWikiMode={changeWikiMode}
        models={window.MODELS.concat(uploadedModels)} defaultModelId={model.id} onDefaultModel={(id) => { const m = window.MODELS.concat(uploadedModels).find(x => x.id === id); if (m) pickModel(m); }}
        fallbackModelIds={fallbackModelIds} onFallbackModelIds={setFallbackModelIds}
        onClearData={clearLocalData} storageOK={!!(window.EOStore && window.EOStore.available)} />}
      {auditOpen && <AuditDrawer onClose={() => setAuditOpen(false)} enabled={auditEnabled} onToggle={toggleAudit} onToast={showToast}
                      docs={docs} exportIngestion={exportIngestion} exportOutput={exportOutput}
                      onExportIngestion={setExportIngestion} onExportOutput={setExportOutput} />}
      {graphAuditOpen && <GraphAuditDrawer onClose={() => setGraphAuditOpen(false)} onToast={showToast} docs={docs} />}
      {modelOpen && <ModelPopover models={window.MODELS.concat(uploadedModels)} current={model} onPick={pickModel} onClose={() => setModelOpen(false)} anchor={{ left: 16, bottom: 64 }}
                     status={modelStatus} progress={modelProgress} loadText={modelLoadText} onReset={resetModel} onCancel={cancelModel}
                     webgpu={!!(window.EOLLM && window.EOLLM.hasWebGPU && window.EOLLM.hasWebGPU())}
                     anthropicKeySet={anthropicKeySet} onSetAnthropicKey={setAnthropicKey}
                     onUploadModel={uploadModel} />}
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
                  : ingestStatus.pct != null && (
                    <b className="ib-pct">{Math.round(ingestStatus.pct * 100)}%
                      {ingestStatus.total ? <span className="ib-count"> · {Number(ingestStatus.done || 0).toLocaleString()} / {Number(ingestStatus.total).toLocaleString()}</span> : null}
                    </b>)}
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
              {ingestStatus.big && <div className="ib-note">Large document — reading it carefully, a piece at a time, so the tab stays responsive. This can take a moment.</div>}
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
  componentDidCatch(err, info) { if (typeof console !== 'undefined') console.error('[Cleo] render error', err, info); }
  render() {
    if (this.state.err) {
      return (
        <div className="crash" role="alert">
          <h1>Something went wrong.</h1>
          <p>Cleo hit an unexpected error while rendering. Your documents and chat are saved locally — reloading usually recovers.</p>
          <button className="hero-action primary" onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
