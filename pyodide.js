/* ============================================================
   pyodide.js — computational grounding, the second mechanical source.

   The EO engine grounds PROSE: it reads text and binds claims to lines. It
   structurally cannot answer COMPUTATIONAL questions — sum a column, compute a
   rate, join two tables, count rows in a CSV. This module sits BESIDE the
   engine as a second deterministic grounding source: Python over the loaded
   document, in the browser, via Pyodide. A computed number is glass-box in
   exactly the way a cited line is — the code that produced it, its stdout, and
   its result are all deposited into the audit. The model still only PHRASES.
   It does not compute the answer; it describes a result mechanical execution
   produced. Treat Python execution as a peer to retrieval, not a new brain.

   The privacy promise is load-bearing here. Python runs in the same browser
   sandbox the engine already lives in, on a document that is already local.
   Nothing in this module sends document content over the network:

     1. OFF BY DEFAULT. The runtime is never loaded at page load, and never
        merely because the toggle flipped — only on the first actual run.
     2. OFF THE MAIN THREAD. Python runs in a Web Worker, so a runaway or
        long computation can be terminated on a timeout without freezing the UI.
     3. NETWORK EGRESS BLOCKED. After Pyodide and its packages have loaded, the
        worker neuters its fetch / XMLHttpRequest / WebSocket bridges, so code
        executed via run() cannot reach the network (pyfetch / js fetch throw).
     4. CONFIGURABLE. The version and CDN base are pinned but overridable on
        window (EO_PYODIDE_*), mirroring how llm.js lets a deploy redirect the
        model CDN — for tests and air-gapped installs.

   Published as window.EOPython. Every call is defensive: a Python failure can
   never break a chat turn, it returns { ok:false, stderr } instead of throwing.
   ============================================================ */
(function () {
  'use strict';
  const win = (typeof window !== 'undefined') ? window : {};

  const PREF_KEY = 'cleo.python.enabled';   // device-local, independent of the React tree
  const DEFAULT_TIMEOUT_MS = 15000;
  const OUT_CAP = 20000;                       // cap stdout / result so a runaway print stays bounded

  // Pinned, overridable (the EO_* idiom from llm.js). The base is jsdelivr,
  // already preconnected in index.html.
  function pyVersion() { return String(win.EO_PYODIDE_VERSION || '0.26.4'); }
  function indexURL() {
    if (win.EO_PYODIDE_INDEX_URL != null) return String(win.EO_PYODIDE_INDEX_URL || '');
    return 'https://cdn.jsdelivr.net/pyodide/v' + pyVersion() + '/full/';
  }
  function packages() {
    if (Array.isArray(win.EO_PYODIDE_PACKAGES)) return win.EO_PYODIDE_PACKAGES.slice();
    return ['pandas'];   // numpy rides in as a dependency; CSVs are the primary target
  }

  /* ---- the pref (off by default). EOPython owns the persisted flag; the app
     reads/writes it through enabled()/setEnabled() the same channel theme and
     reduce-motion use, and wires it on load and on change. ---- */
  let _enabled = false;
  try { _enabled = (typeof localStorage !== 'undefined' && localStorage.getItem(PREF_KEY) === '1'); } catch (e) {}
  function enabled() { return !!_enabled; }
  function setEnabled(on) {
    _enabled = !!on;
    try { if (typeof localStorage !== 'undefined') { if (_enabled) localStorage.setItem(PREF_KEY, '1'); else localStorage.removeItem(PREF_KEY); } } catch (e) {}
    return _enabled;
  }

  /* ============================================================
     The worker body. Self-contained: it imports Pyodide from the CDN, loads the
     packages, then locks down network egress before any user code runs. It
     speaks a tiny protocol with the main thread:
       main → worker : { type:'init', indexURL, packages }
                       { type:'run',  id, code, files }
       worker → main : { type:'progress', phase, loaded, total }
                       { type:'ready' } | { type:'init-error', error }
                       { type:'result', id, ok, stdout, stderr, result }
     ============================================================ */
  function workerSource() {
    function body() {
      let pyodide = null;

      // After the runtime and its packages have loaded, sever every network
      // bridge reachable from executed Python (pyfetch / js fetch / sockets).
      function lockdownNetwork() {
        const blocked = function () { throw new Error('network egress is disabled in Cleo (documents stay local)'); };
        try { self.fetch = blocked; } catch (e) {}
        try { self.XMLHttpRequest = function () { throw new Error('network egress is disabled in Cleo'); }; } catch (e) {}
        try { self.WebSocket = function () { throw new Error('network egress is disabled in Cleo'); }; } catch (e) {}
        try { self.importScripts = blocked; } catch (e) {}
      }

      async function init(indexURL, pkgs) {
        self.importScripts(indexURL + 'pyodide.js');
        pyodide = await self.loadPyodide({
          indexURL,
          stdout: () => {},
          stderr: () => {},
        });
        self.postMessage({ type: 'progress', phase: 'runtime', loaded: 1, total: 2 });
        if (pkgs && pkgs.length) await pyodide.loadPackage(pkgs);
        self.postMessage({ type: 'progress', phase: 'packages', loaded: 2, total: 2 });
        // A Python-side stringifier: a DataFrame/Series renders as a table, every
        // other value as its repr — so the structured result is legible.
        pyodide.runPython(
          'def __eo_to_text(v):\n' +
          '    try:\n' +
          '        import pandas as pd\n' +
          '        if isinstance(v, (pd.DataFrame, pd.Series)):\n' +
          '            return v.to_string()\n' +
          '    except Exception:\n' +
          '        pass\n' +
          '    try:\n' +
          '        return repr(v)\n' +
          '    except Exception:\n' +
          '        return str(v)\n'
        );
        lockdownNetwork();
        self.postMessage({ type: 'ready' });
      }

      async function run(id, code, files) {
        let stdout = '', stderr = '', resultStr = '';
        const capture = (which) => (s) => { if (which === 'out') stdout += s + '\n'; else stderr += s + '\n'; };
        try {
          // Write the document(s) into the in-memory FS as local data only.
          for (const f of (files || [])) {
            try { pyodide.FS.writeFile(f.name, f.data); } catch (e) {}
          }
          pyodide.setStdout({ batched: capture('out') });
          pyodide.setStderr({ batched: capture('err') });
          let result;
          try {
            result = await pyodide.runPythonAsync(code);
          } finally {
            pyodide.setStdout({ batched: () => {} });
            pyodide.setStderr({ batched: () => {} });
          }
          try {
            if (result !== undefined && result !== null) {
              const toText = pyodide.globals.get('__eo_to_text');
              resultStr = toText(result);
              if (toText && toText.destroy) toText.destroy();
            }
          } catch (e) { resultStr = String(result); }
          try { if (result && result.destroy) result.destroy(); } catch (e) {}
          self.postMessage({ type: 'result', id, ok: true, stdout, stderr, result: resultStr });
        } catch (e) {
          self.postMessage({ type: 'result', id, ok: false, stdout, stderr: (stderr + String((e && e.message) || e)).trim(), result: resultStr });
        }
      }

      self.onmessage = async (ev) => {
        const m = ev.data || {};
        if (m.type === 'init') {
          try { await init(m.indexURL, m.packages); }
          catch (e) { self.postMessage({ type: 'init-error', error: String((e && e.message) || e) }); }
        } else if (m.type === 'run') {
          run(m.id, m.code, m.files);
        }
      };
    }
    return '(' + body.toString() + ')()';
  }

  /* ============================================================
     The main-thread driver. Owns the worker lifecycle, lazy load, and the
     per-run timeout that terminates a runaway computation.
     ============================================================ */
  let _worker = null;
  let _readyPromise = null;     // memoized load (resolves once the worker is ready)
  let _ready = false;
  let _seq = 0;
  const _pending = new Map();   // id → { resolve, timer, t0 }
  let _blobURL = null;

  function ready() { return _ready; }

  function teardown(reason) {
    if (_worker) { try { _worker.terminate(); } catch (e) {} }
    _worker = null; _ready = false; _readyPromise = null;
    for (const [id, p] of _pending) {
      clearTimeout(p.timer);
      try { p.resolve({ ok: false, stdout: '', stderr: reason || 'worker stopped', result: '', durationMs: Math.round((now() - p.t0)), truncated: false }); } catch (e) {}
      _pending.delete(id);
    }
  }

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // Lazily load the runtime — ONLY on first actual use. Never at page load,
  // never merely because the toggle flipped. Returns a Promise that resolves
  // when Python is ready to run; onProgress(fraction, phase) reports load steps.
  function ensureLoaded(onProgress) {
    if (_ready && _worker) return Promise.resolve(true);
    if (_readyPromise) return _readyPromise;
    _readyPromise = new Promise((resolve, reject) => {
      try {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
          throw new Error('Web Workers are unavailable in this browser, so local Python cannot run.');
        }
        if (!_blobURL) _blobURL = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
        const w = new Worker(_blobURL);
        _worker = w;
        w.onmessage = (ev) => {
          const m = ev.data || {};
          if (m.type === 'progress') { if (onProgress) { try { onProgress((m.loaded || 0) / (m.total || 1), m.phase); } catch (e) {} } return; }
          if (m.type === 'ready') { _ready = true; resolve(true); return; }
          if (m.type === 'init-error') { teardown('init failed'); reject(new Error(m.error || 'Pyodide failed to load')); return; }
          if (m.type === 'result') {
            const p = _pending.get(m.id);
            if (!p) return;
            clearTimeout(p.timer);
            _pending.delete(m.id);
            const stdout = String(m.stdout || ''), result = String(m.result || '');
            const truncated = stdout.length > OUT_CAP || result.length > OUT_CAP;
            p.resolve({
              ok: !!m.ok,
              stdout: stdout.length > OUT_CAP ? stdout.slice(0, OUT_CAP) + '\n…[truncated]' : stdout,
              stderr: String(m.stderr || ''),
              result: result.length > OUT_CAP ? result.slice(0, OUT_CAP) + '\n…[truncated]' : result,
              durationMs: Math.round(now() - p.t0),
              truncated,
            });
          }
        };
        w.onerror = (e) => { teardown('worker error: ' + ((e && e.message) || 'unknown')); reject(new Error((e && e.message) || 'Pyodide worker error')); };
        w.postMessage({ type: 'init', indexURL: indexURL(), packages: packages() });
      } catch (e) {
        _readyPromise = null;
        reject(e);
      }
    });
    return _readyPromise;
  }

  // Run Python over the loaded document. files: [{ name, data }] are written to
  // the in-memory FS (local data only). Resolves to a structured, glass-box
  // record — never throws. A computation past timeoutMs terminates the worker
  // and returns { ok:false, stderr:'timeout' } so the tab cannot freeze.
  async function run({ code, files, timeoutMs } = {}) {
    const t0 = now();
    if (!code || !String(code).trim()) return { ok: false, stdout: '', stderr: 'no code', result: '', durationMs: 0, truncated: false };
    try { await ensureLoaded(); }
    catch (e) { return { ok: false, stdout: '', stderr: String((e && e.message) || e), result: '', durationMs: Math.round(now() - t0), truncated: false }; }
    if (!_worker) return { ok: false, stdout: '', stderr: 'runtime unavailable', result: '', durationMs: Math.round(now() - t0), truncated: false };
    const id = ++_seq;
    const limit = (timeoutMs | 0) > 0 ? (timeoutMs | 0) : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        _pending.delete(id);
        // A runaway computation: kill the worker (so it cannot keep burning a
        // core) and surface a timeout. The runtime reloads lazily on next run.
        teardown('timeout');
        resolve({ ok: false, stdout: '', stderr: 'timeout', result: '', durationMs: Math.round(now() - t0), truncated: false });
      }, limit);
      _pending.set(id, { resolve, timer, t0 });
      try { _worker.postMessage({ type: 'run', id, code: String(code), files: files || [] }); }
      catch (e) { clearTimeout(timer); _pending.delete(id); resolve({ ok: false, stdout: '', stderr: String((e && e.message) || e), result: '', durationMs: Math.round(now() - t0), truncated: false }); }
    });
  }

  // Free the runtime (used by a "clear" affordance / tests). Idempotent.
  function dispose() { teardown('disposed'); }

  win.EOPython = {
    enabled, setEnabled, ready, ensureLoaded, run, dispose,
    // exposed for introspection / tests
    _internals: { indexURL, pyVersion, packages, workerSource },
  };
})();
