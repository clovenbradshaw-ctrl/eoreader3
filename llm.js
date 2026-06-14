/* ============================================================
   EO Reader — optional local LLM (WebLLM / WebGPU).
   The mechanical engine answers without this. When a model is loaded,
   it only PHRASES answers over retrieved context; citations are still
   bound mechanically by the engine, never written by the model.
   ============================================================ */
(function () {
  let enginePromise = null;
  let loadedModel = null;
  let mod = null;
  let loadToken = 0;   // bumped per load(); a superseded in-flight build goes inert
  let activeWorker = null;   // the Web Worker hosting the in-flight/resident engine
  let activeCancel = null;   // call to reject the in-flight build promptly (user cancel)
  let loadingActive = false; // a load is genuinely in flight (gates cancelLoad)
  let workerBroken = false;  // the worker path failed to establish once — stop retrying it
  let activeGen = null;      // the currently-streaming generation: { abort() } — set by interrupt()

  // The sentinel a stopped stream throws so callers can tell a user interrupt
  // apart from a real failure (and never retry it / never show an error). It
  // carries whatever text had streamed so far, so the audit trace can keep the
  // partial draft. `isAbort` is the single predicate every settle path checks.
  const abortedError = (partial) => Object.assign(new Error('Stopped.'), { code: 'ABORTED', partial: partial || '' });
  const isAbort = (e) => !!(e && e.code === 'ABORTED');

  const hasWebGPU = () => typeof navigator !== 'undefined' && !!navigator.gpu;

  // ---- Anthropic (Claude) backend ----------------------------------------
  // A second backend alongside the local WebLLM models: route a turn to the
  // Claude API instead of the user's GPU. A model whose key is prefixed
  // 'anthropic:' (e.g. 'anthropic:claude-opus-4-8') is served here, so every
  // existing call site that threads `model.mlc` through load()/phrase()/
  // isLoaded() keeps working unchanged. This is the path that still works when
  // there's no WebGPU or the model CDN is blocked — the two usual reasons local
  // loading fails — so it doubles as the fallback for those.
  const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
  const ANTHROPIC_KEY_LS = 'eo-anthropic-key';
  let anthropicKey = null;
  try { anthropicKey = (typeof localStorage !== 'undefined' && localStorage.getItem(ANTHROPIC_KEY_LS)) || null; } catch (_) {}
  const isAnthropic = (key) => typeof key === 'string' && key.indexOf('anthropic:') === 0;
  const anthropicModelId = (key) => String(key).slice('anthropic:'.length);
  const hasAnthropicKey = () => !!anthropicKey;
  // Store (or clear, with a falsy value) the API key. Persisted to localStorage
  // so it survives reloads — the same device-local storage the rest of the app
  // uses; the key never leaves the browser except on the call to Anthropic.
  function setAnthropicKey(k) {
    anthropicKey = (k && String(k).trim()) || null;
    try {
      if (typeof localStorage !== 'undefined') {
        if (anthropicKey) localStorage.setItem(ANTHROPIC_KEY_LS, anthropicKey);
        else localStorage.removeItem(ANTHROPIC_KEY_LS);
      }
    } catch (_) {}
    return anthropicKey;
  }

  // Stream a turn from the Claude API, emitting text deltas to onDelta and
  // returning the full text. The messages array is the same OpenAI-style shape
  // assembleMessages() builds for WebLLM; here the single leading `system`
  // message becomes Anthropic's top-level `system` and the rest map to the
  // user/assistant turns. Uses fetch + SSE directly (no SDK import) so this
  // path carries no CDN dependency — exactly what makes it a dependable
  // fallback when the model CDN is the thing that's failing. Note: Opus/Sonnet
  // 4.x reject `temperature`, so it is deliberately not sent.
  async function streamAnthropic({ model, messages, maxTokens, onDelta }) {
    if (!anthropicKey) throw Object.assign(new Error('Add your Anthropic API key to use Claude.'), { code: 'NOKEY' });
    const system = (messages || []).filter(m => m && m.role === 'system').map(m => m.content).filter(Boolean).join('\n\n');
    const msgs = (messages || []).filter(m => m && m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
    const body = {
      model,
      // Claude is more expansive than the small local models; floor the cap so a
      // grounded answer sized for a 0.5B model (as low as ~180) isn't truncated.
      max_tokens: Math.max(1024, (maxTokens | 0) || 1024),
      stream: true,
      messages: msgs.length ? msgs : [{ role: 'user', content: ' ' }],
    };
    if (system) body.system = system;
    // Interruptible: an AbortController aborts the fetch (and so the SSE read)
    // the instant the user hits Stop, halting the request server-side instead of
    // draining tokens into the void. Registered as the active generation so
    // interrupt() can find it; `aborted` distinguishes a user stop from a real
    // network drop in the catch below.
    const ctrl = new AbortController();
    let aborted = false, full = '';
    const gen = { abort() { aborted = true; try { ctrl.abort(); } catch (_) {} } };
    activeGen = gen;
    try {
      let resp;
      try {
        resp = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            // Anthropic gates browser (CORS) calls behind this opt-in header.
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (aborted) throw abortedError(full);
        throw Object.assign(new Error('Could not reach the Claude API — check your connection.'), { code: 'ANTHROPIC_NET' });
      }
      if (!resp.ok || !resp.body) {
        let msg = `Claude API error (${resp.status}).`;
        if (resp.status === 401) msg = 'Claude rejected the API key (401). Check the key and try again.';
        else { try { const j = await resp.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (_) {} }
        throw Object.assign(new Error(msg), { code: 'ANTHROPIC', status: resp.status });
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.indexOf('data:') !== 0) continue;          // skip `event:` lines and blanks
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let evt; try { evt = JSON.parse(data); } catch (_) { continue; }
            if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
              const d = evt.delta.text || '';
              if (d) { full += d; if (onDelta) onDelta(d); }
            } else if (evt.type === 'error') {
              throw Object.assign(new Error((evt.error && evt.error.message) || 'Claude streaming error.'), { code: 'ANTHROPIC' });
            }
          }
        }
      } catch (e) {
        if (aborted) throw abortedError(full);   // the abort surfaces as a read error — keep the partial
        throw e;
      }
      return full;
    } finally {
      if (activeGen === gen) activeGen = null;
    }
  }

  // Run a Claude turn that may call tools. Unlike streamAnthropic (which streams
  // one plain answer), this drives the native tool_use loop NON-streaming: each
  // step posts the conversation; if Claude asks to run a tool, runTool(name,
  // input) executes it locally (e.g. window.EOPython.run over the document) and
  // its result is fed back as a tool_result, looping until Claude returns a
  // final text answer. The model phrases over the execution result — it never
  // reports a number it computed in its own head as grounded. Plain streaming
  // turns (streamAnthropic / streamChat) are untouched; this is a separate entry
  // point used only when a computational tool is offered. Returns
  // { text, calls:[{name,input,output}], steps }. calls carries every tool run
  // so the chat loop can deposit them into the audit and surface them to the user.
  async function runAnthropicTools({ model, system, messages, tools, runTool, maxTokens, maxSteps }) {
    if (!anthropicKey) throw Object.assign(new Error('Add your Anthropic API key to use Claude.'), { code: 'NOKEY' });
    const steps = Math.max(1, (maxSteps | 0) || 4);
    const headers = {
      'content-type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const msgs = (messages || []).slice();
    const calls = [];
    let text = '';
    for (let i = 0; i < steps; i++) {
      const body = { model, max_tokens: Math.max(1024, (maxTokens | 0) || 1024), messages: msgs };
      if (tools && tools.length) body.tools = tools;
      if (system) body.system = system;
      let resp;
      try {
        resp = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (e) {
        throw Object.assign(new Error('Could not reach the Claude API — check your connection.'), { code: 'ANTHROPIC_NET' });
      }
      if (!resp.ok) {
        let msg = `Claude API error (${resp.status}).`;
        if (resp.status === 401) msg = 'Claude rejected the API key (401). Check the key and try again.';
        else { try { const j = await resp.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (_) {} }
        throw Object.assign(new Error(msg), { code: 'ANTHROPIC', status: resp.status });
      }
      let data; try { data = await resp.json(); } catch (e) { throw Object.assign(new Error('Claude returned an unreadable response.'), { code: 'ANTHROPIC' }); }
      const content = Array.isArray(data.content) ? data.content : [];
      text = content.filter(b => b && b.type === 'text').map(b => b.text || '').join('').trim();
      const toolUses = content.filter(b => b && b.type === 'tool_use');
      if (!toolUses.length || data.stop_reason !== 'tool_use') return { text, calls, steps: i + 1 };
      // Record Claude's turn verbatim (the tool_use blocks must round-trip), run
      // each tool, and feed the results back for the next phrasing pass.
      msgs.push({ role: 'assistant', content });
      const results = [];
      for (const tu of toolUses) {
        let out;
        try { out = await runTool(tu.name, tu.input || {}); }
        catch (e) { out = { ok: false, stderr: String((e && e.message) || e) }; }
        calls.push({ name: tu.name, input: tu.input || {}, output: out });
        const contentStr = typeof out === 'string' ? out : JSON.stringify(out);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: contentStr || '(no output)' });
      }
      msgs.push({ role: 'user', content: results });
    }
    return { text, calls, steps, exhausted: true };
  }

  // ---- wllama (CPU / WebAssembly) backend ---------------------------------
  // A third backend alongside WebLLM (GPU) and Anthropic (cloud): llama.cpp
  // compiled to WebAssembly, running a GGUF model on the CPU with NO WebGPU.
  // This is the dependable local fallback for the two cases that leave the GPU
  // path empty — a browser without WebGPU (Firefox/Safari today) and a GPU
  // model whose download stalls or fails — so chat still gets phrasing instead
  // of dropping silently to mechanical-only. A model whose key is prefixed
  // 'wllama:' is served here; every call site threading mlcKey through
  // load()/streamChat()/isLoaded() keeps working unchanged.
  //
  // Pinned to an exact version (like the WebLLM import) so a floating major
  // can't change the loader/stream API under us. Everything network-facing is
  // overridable on window for self-hosting or to track a new release without a
  // code change: EO_WLLAMA (inject the module {Wllama, wasmPaths}, also the
  // test seam), EO_WLLAMA_VERSION, EO_WLLAMA_CDN, EO_WLLAMA_WASM, and
  // EO_WLLAMA_MODELS (the id→GGUF registry).
  const WLLAMA_PREFIX = 'wllama:';
  const WLLAMA_VERSION = '3.4.1';
  const isWllama = (key) => typeof key === 'string' && key.indexOf(WLLAMA_PREFIX) === 0;
  const wllamaId = (key) => String(key).slice(WLLAMA_PREFIX.length);
  // id → GGUF source, centralized here the way WebLLM's prebuiltAppConfig keys
  // are: data.jsx references a short, stable id ('wllama:qwen25-05b'). Small
  // Q4_K_M quants chosen to stay usable on a CPU; weights download once from
  // Hugging Face (its resolve endpoint sends browser-friendly CORS) and are
  // cached on the device (useCache) so a refresh re-instantiates without
  // re-downloading.
  // Per-model registry: {name, url, bytes?, quant?}. `bytes` is the GGUF size
  // (used to surface a sensible "this much will download" hint and to size the
  // progress estimate when the server omits Content-Length); `quant` is the
  // weight precision, surfaced as a quality tier in the picker so the user can
  // pick a higher-quality version of the same base model without knowing what
  // Q4_K_M means. Adding a new entry — a Q5 of an existing model, a different
  // 1B — is a single object literal; no other code change is required.
  // Each entry carries an `urls` ARRAY of equivalent mirrors — bartowski first
  // (the canonical), then community alternatives (unsloth) so a 503 / DNS
  // hiccup on one host falls through to the next without surfacing as a failed
  // load. `bytes` is the expected GGUF size, used as a progress estimate when
  // the server omits Content-Length; `quant` is the weight precision, surfaced
  // as a quality tier in the picker. Adding a model = one object literal;
  // adding a new mirror to an existing one = one URL in its array.
  const WLLAMA_MODELS = (typeof window !== 'undefined' && window.EO_WLLAMA_MODELS) || {
    // Tiny: the seamless fallback. ~95 MB downloads in seconds on any connection,
    // and we pre-fetch it on first launch so a later "GPU stalled" event swaps
    // over with no fetch at all — only wllama init.
    'smollm2-135m': { name: 'SmolLM2 135M', urls: ['https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf'], bytes: 95 * 1024 * 1024, quant: 'Q4_K_M' },
    'smollm2-360m': { name: 'SmolLM2 360M', urls: ['https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf'], bytes: 270 * 1024 * 1024, quant: 'Q4_K_M' },
    'qwen25-05b':   { name: 'Qwen2.5 0.5B', urls: ['https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'], bytes: 380 * 1024 * 1024, quant: 'Q4_K_M' },
    'qwen25-05b-q8':{ name: 'Qwen2.5 0.5B (high quality)', urls: ['https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q8_0.gguf'], bytes: 530 * 1024 * 1024, quant: 'Q8_0' },
    'llama32-1b':   { name: 'Llama 3.2 1B', urls: [
      'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
      'https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    ], bytes: 770 * 1024 * 1024, quant: 'Q4_K_M' },
    'llama32-1b-q8':{ name: 'Llama 3.2 1B (high quality)', urls: ['https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q8_0.gguf'], bytes: 1320 * 1024 * 1024, quant: 'Q8_0' },
    'llama32-3b':   { name: 'Llama 3.2 3B', urls: [
      'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
      'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    ], bytes: 2020 * 1024 * 1024, quant: 'Q4_K_M' },
  };
  // Helper: a registry entry exposes its mirror list as `urls`; older callers
  // still see a `url` shorthand pointing at the primary. An UPLOADED entry has
  // a `blob` instead and no URLs, so this returns [] for it (the blob path in
  // buildWllama handles those).
  const wllamaUrls = (src) => (src && src.urls && src.urls.length) ? src.urls : (src && src.url ? [src.url] : []);
  // User-uploaded GGUFs. Session-only — File handles can't be persisted to
  // localStorage, so a refresh loses them. Kept in a separate map so the
  // canonical registry (wllamaModels()) only carries URL-backed entries.
  const WLLAMA_UPLOADED = {};
  function registerUploadedModel(id, file) {
    if (!id || !file) return null;
    WLLAMA_UPLOADED[String(id)] = { name: file.name || String(id), blob: file };
    return WLLAMA_PREFIX + String(id);
  }
  const wllamaSource = (key) => {
    const id = wllamaId(key);
    return WLLAMA_UPLOADED[id] || WLLAMA_MODELS[id] || null;
  };
  const wllamaModels = () => Object.assign({}, WLLAMA_MODELS);

  // MODEL TIER (WI-3, the L2 veto). The truthfulness laws bite differently by
  // model capacity, so the talker needs one honest label for "how much can this
  // model be trusted to compose grounded prose":
  //   'api'     — Anthropic (Claude): composes reliably.
  //   'capable' — a large local model (≳2B params): the softened veto is correct.
  //   'small'   — a sub-2B local model: it cannot compose from the page without
  //               drift, so on this tier the system underclaims (see WI-6).
  // Sizing: wllama (CPU) entries carry an authoritative GGUF `bytes`; the WebGPU
  // (MLC) keys encode their parameter count instead ("…0.5B…", "…3B…"), so size
  // those from the key. Anything we cannot size defaults to 'capable' — never
  // harden a path we cannot measure (that keeps today's behavior for it).
  const TIER_SMALL_MAX_BYTES = 1.6 * 1024 * 1024 * 1024;   // ≈1.6 GB ⇒ ~sub-2B at Q4/Q8
  // Billions of parameters parsed from a model id ("…1.5B…" → 1.5, "…360M…" →
  // 0.36), or null when no size token is present. NOT used for wllama ids (their
  // "05b" shorthand misreads as 5B — those size by bytes); for the MLC keys the
  // "0.5B"/"3B" form is unambiguous.
  function modelParamsB(key) {
    const s = String(key == null ? '' : key);
    let m = s.match(/(\d+(?:\.\d+)?)\s*b\b/i);
    if (m) return parseFloat(m[1]);
    m = s.match(/(\d+(?:\.\d+)?)\s*m\b/i);
    if (m) return parseFloat(m[1]) / 1000;
    return null;
  }
  function modelTier(mlcKey) {
    if (isAnthropic(mlcKey)) return 'api';
    if (isWllama(mlcKey)) {
      const src = wllamaSource(mlcKey);
      if (!src) return 'small';                            // unknown id ⇒ fail safe (underclaim)
      if (typeof src.bytes !== 'number') return 'capable'; // uploaded GGUF: user's choice, don't harden
      return src.bytes < TIER_SMALL_MAX_BYTES ? 'small' : 'capable';
    }
    const pB = modelParamsB(mlcKey);
    if (pB == null) return 'capable';                      // unrecognizable → don't harden
    return pB < 2 ? 'small' : 'capable';
  }

  // The CPU model used for the automatic fallback (no WebGPU / GPU stall). The
  // smallest viable model wins this slot — at ~95 MB it downloads in seconds
  // and runs anywhere wllama can — so when a GPU model stalls or there's no
  // WebGPU here, the swap is immediate rather than a several-minute wait. Pick
  // higher quality from the picker once you've used the page enough to want it.
  function fallbackKey() {
    const id = (typeof window !== 'undefined' && window.EO_CPU_FALLBACK_ID) || 'smollm2-135m';
    if (WLLAMA_MODELS[id]) return WLLAMA_PREFIX + id;
    const first = Object.keys(WLLAMA_MODELS)[0];
    return first ? WLLAMA_PREFIX + first : null;
  }
  const hasWasm = () => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  // Quiet logger: wllama is chatty on stdout otherwise. Errors still surface.
  const WLLAMA_LOGGER = { debug() {}, log() {}, warn() {}, error(...a) { try { console.error(...a); } catch (_) {} } };

  let wllamaMod = null;     // memoized { Wllama, wasmPaths }
  let activeWllama = null;  // the resident wllama instance (freed on unload/cancel)
  async function importWllama() {
    if (wllamaMod) return wllamaMod;
    if (typeof window !== 'undefined' && window.EO_WLLAMA) { wllamaMod = window.EO_WLLAMA; return wllamaMod; }
    const ver = (typeof window !== 'undefined' && window.EO_WLLAMA_VERSION) || WLLAMA_VERSION;
    // IMPORTANT: import the package's EXPLICIT ESM entry, not esm.run / jsdelivr's
    // `/+esm` auto-bundle. wllama 3.4.1's package.json `main` points at a
    // non-existent root `index.js`, so `/+esm` (and esm.run, which redirects to
    // it) 404s — which is exactly the "CPU model never loads" failure we kept
    // hitting. The real ESM bundle is at `esm/index.js` and is self-contained.
    // We try a list of CDN bases in order so one CDN hiccup falls through to the
    // next. window.EO_WLLAMA_CDN (a full module URL) still overrides everything.
    const override = (typeof window !== 'undefined' && window.EO_WLLAMA_CDN) || null;
    const bases = [
      'https://cdn.jsdelivr.net/npm/@wllama/wllama@' + ver + '/esm',
      'https://unpkg.com/@wllama/wllama@' + ver + '/esm',
      'https://esm.sh/@wllama/wllama@' + ver + '/esm',
    ];
    const work = (async () => {
      let m = null, usedBase = null, lastErr = null;
      const tryUrls = override ? [override] : bases.map(b => b + '/index.js');
      for (let i = 0; i < tryUrls.length; i++) {
        try {
          m = await import(/* @vite-ignore */ tryUrls[i]);
          usedBase = override ? null : bases[i];
          lastErr = null;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!m) throw lastErr || new Error('Could not load the CPU model runtime from any CDN.');
      const Wllama = m.Wllama || (m.default && m.default.Wllama) || m.default;
      // wllama 3.4.1's pathConfig wants a single `default` pointing at the one
      // unified wasm (esm/wasm/wllama.wasm); the old single-thread/multi-thread
      // keys are obsolete and, lacking `default`, make loadModel throw
      // '"default" is missing from pathConfig'. Overridable via EO_WLLAMA_WASM.
      let wasmPaths = (typeof window !== 'undefined' && window.EO_WLLAMA_WASM) || null;
      if (!wasmPaths) {
        const base = usedBase || bases[0];
        wasmPaths = { 'default': base + '/wasm/wllama.wasm' };
      }
      return { Wllama, wasmPaths };
    })();
    let to;
    const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(Object.assign(new Error('Loading the CPU model runtime from the CDN timed out — check your connection or any content blocker, then try again.'), { code: 'IMPORT_TIMEOUT' })), IMPORT_TIMEOUT_MS); });
    try { wllamaMod = await Promise.race([work, timeout]); }
    finally { clearTimeout(to); }
    return wllamaMod;
  }

  // wllama's own CacheManager is **OPFS-backed** in v3.x (its cache-manager.d.ts
  // says so verbatim), so the durable side-cache I'd planned to layer on top is
  // already there — bytes that survive a tab refresh, a few-day gap, even a
  // "clear cache" that spares site data. Calling loadModelFromUrl with
  // useCache:true is what writes to it; a subsequent load with the same URL
  // reads from OPFS and skips the network. The robustness gap we kept seeing
  // was browser-side eviction of best-effort storage, which persistStorage()
  // now mitigates — see the boot-time call.
  //
  // What's new here:
  //  - urls is an ARRAY. We try each in order; a 503 / DNS hiccup on bartowski
  //    falls through to unsloth without surfacing as a failed load. Once any
  //    mirror succeeds, wllama caches its bytes and the next session uses them.
  //  - parallelDownloads bumped to 4 so a fresh download uses the bandwidth.
  //  - cacheStatus / clearCache talk to wllama's cacheManager directly, so
  //    the picker badge and the "stuck cache" escape hatch agree with what's
  //    actually on disk.

  // Compute wllama's OPFS filename for a URL: hashSHA1(url) + '_' + filename.
  // Lets cacheStatus check the cache without instantiating a Wllama (so the
  // picker badge stays cheap), and matches what wllama writes byte for byte.
  async function wllamaCacheName(url) {
    try {
      const enc = new TextEncoder().encode(url);
      const digest = await crypto.subtle.digest('SHA-1', enc);
      const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      const file = (url.split('/').pop() || '').split('?')[0];
      return hex + '_' + file;
    } catch (_) { return null; }
  }
  async function wllamaCacheHas(url) {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') return false;
    try {
      const name = await wllamaCacheName(url);
      if (!name) return false;
      const root = await navigator.storage.getDirectory();
      await root.getFileHandle(name);
      return true;
    } catch (_) { return false; }
  }
  async function wllamaCachedAny(src) {
    for (const u of wllamaUrls(src)) {
      try { if (await wllamaCacheHas(u)) return true; } catch (_) {}
    }
    return false;
  }

  // Pre-import the runtime (small JS + wasm) WITHOUT loading a model, so the
  // later switch-to-CPU pays only the model download, not the runtime fetch +
  // compile. This is the cheap "keep a backup ready" step: a single resident
  // engine is the architecture's invariant, so we can't hold a warm CPU model
  // alongside a live GPU one — but we CAN have the runtime cached and ready.
  async function prewarmFallback() { try { return await importWllama(); } catch (e) { return null; } }

  // Pre-fetch the fallback CPU model into wllama's OPFS cache, in the
  // background, so a later "GPU stalled" event swaps in the CPU model with no
  // download at all — only wllama init. This is what makes the fallback FEEL
  // instantaneous instead of taking minutes. Idempotent: a no-op once the
  // file is on disk; safe to call every boot. Silent on failure — a fetch
  // miss just leaves the user without the pre-warm.
  async function prewarmFallbackModel() {
    try {
      const key = fallbackKey();
      if (!key) return false;
      const src = wllamaSource(key);
      if (!src) return false;
      const urls = wllamaUrls(src);
      if (!urls.length) return false;
      if (await wllamaCachedAny(src)) return true;
      const { Wllama, wasmPaths } = await importWllama();
      const tmp = new Wllama(wasmPaths, { parallelDownloads: 4, logger: WLLAMA_LOGGER });
      for (const url of urls) {
        try {
          if (typeof tmp.cacheManager === 'object' && tmp.cacheManager && typeof tmp.cacheManager.download === 'function') {
            await tmp.cacheManager.download(url);
          } else {
            // Older wllama without cacheManager.download — just download into
            // memory and discard; the bytes don't stick, but we tried.
            await fetch(url).then(r => r && r.body && r.body.getReader());
          }
          return true;
        } catch (_) {}
      }
      return false;
    } catch (_) { return false; }
  }

  // Build (and resolve to) a resident wllama engine for `mlcKey`. wllama's
  // loadModelFromUrl handles the parallel download + OPFS-backed cache, and
  // we wrap it in a multi-URL fallback: a 503 on bartowski falls through to
  // unsloth without breaking the load. Bytes are sticky once any mirror
  // succeeds, so a refresh re-instantiates from disk with no network hit.
  async function buildWllama(mlcKey, onProgress, myToken) {
    const { Wllama, wasmPaths } = await importWllama();
    if (typeof Wllama !== 'function') throw new Error('The CPU model runtime (wllama) did not load.');
    const src = wllamaSource(mlcKey);
    if (!src) throw new Error('Unknown on-device model: ' + mlcKey);
    // Multi-thread needs SharedArrayBuffer, which needs cross-origin isolation
    // (COOP+COEP). Without it wllama runs single-thread; we only pass n_threads
    // when isolation is present so we never trip an unsupported multi-thread path.
    const isolated = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated);
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const instance = new Wllama(wasmPaths, { parallelDownloads: 4, logger: WLLAMA_LOGGER });
    activeWllama = instance;
    const loadOpts = {
      n_ctx: (typeof window !== 'undefined' && +window.EO_WLLAMA_NCTX) || 4096,
      useCache: true,
      progressCallback: ({ loaded, total }) => {
        if (myToken !== loadToken) return;                 // superseded → go inert
        const p = total ? loaded / total : 0;
        if (onProgress) onProgress(p, total ? 'Downloading the on-device model — ' + Math.round(p * 100) + '%' : 'Downloading the on-device model…');
      },
    };
    if (isolated) loadOpts.n_threads = Math.min(4, Math.max(1, cores - 1));

    // Uploaded GGUFs come in as a Blob/File rather than a URL; loadModel() reads
    // the bytes directly without going through the cache (the file is already
    // on the user's disk, so caching adds nothing here).
    if (src.blob) {
      if (typeof instance.loadModel !== 'function')
        throw new Error('This build of the CPU runtime can’t load a model from a file.');
      const { useCache, progressCallback, ...blobOpts } = loadOpts;
      await instance.loadModel([src.blob], blobOpts);
    } else {
      // Registry models: walk the mirror list in order. A 503 / DNS hiccup on
      // the primary (bartowski) falls through to the next mirror (unsloth)
      // without surfacing as a failed load. Once any mirror succeeds, wllama
      // caches its bytes in OPFS and the next session loads from disk.
      const urls = wllamaUrls(src);
      if (!urls.length) throw new Error('No download URL for ' + mlcKey);
      let lastErr = null;
      for (let i = 0; i < urls.length; i++) {
        try {
          await instance.loadModelFromUrl(urls[i], loadOpts);
          lastErr = null;
          break;
        } catch (e) {
          if (e && e.code === 'CANCEL') throw e;
          if (myToken !== loadToken) throw Object.assign(new Error('Model load canceled'), { code: 'CANCEL' });
          lastErr = e;
          if (i < urls.length - 1 && onProgress) {
            onProgress(0, 'That source is unavailable — trying the next mirror…');
          }
        }
      }
      if (lastErr) throw lastErr;
    }

    if (myToken !== loadToken) { try { await instance.exit(); } catch (_) {} if (activeWllama === instance) activeWllama = null; throw Object.assign(new Error('Model load canceled'), { code: 'CANCEL' }); }
    if (onProgress) onProgress(1, '');
    return {
      wllama: instance,
      unload: async () => { try { await instance.exit(); } finally { if (activeWllama === instance) activeWllama = null; } },
    };
  }

  // Stream a turn from a resident wllama instance. wllama ≥3 is OpenAI-shaped —
  // createChatCompletion({ messages, stream:true, onData }) with chunks like
  // chunk.choices[0].delta.content — but older builds streamed cumulative text
  // via onNewToken(…, currentText). We pass BOTH callbacks and a superset of
  // option names and tolerate every chunk shape, so a version bump can't break
  // the stream (the same defensive stance clearCache takes across WebLLM
  // versions). Returns the full raw text; deltas go to onDelta.
  async function streamWllama({ instance, messages, temperature, maxTokens, onDelta }) {
    if (!instance || typeof instance.createChatCompletion !== 'function')
      throw new Error('The CPU model is not ready.');
    let full = '', prevCumulative = '', aborted = false;
    const emit = (s) => { if (s) { full += s; if (onDelta) onDelta(s); } };
    const onChunk = (chunk) => {
      if (chunk == null) return;
      if (typeof chunk === 'string') { emit(chunk); return; }
      // cumulative-text shape: currentText grows each chunk → emit the delta
      if (typeof chunk.currentText === 'string') { const d = chunk.currentText.slice(prevCumulative.length); prevCumulative = chunk.currentText; emit(d); return; }
      const c = chunk.choices && chunk.choices[0];
      if (!c) return;
      if (c.delta && c.delta.content != null) emit(c.delta.content);
      else if (c.text != null) emit(c.text);
      else if (c.message && c.message.content != null) emit(c.message.content);
    };
    const nPredict = Math.max(16, (maxTokens | 0) || 256);
    const temp = typeof temperature === 'number' ? temperature : 0.4;
    // Interruptible like the other backends: an AbortController stops generation
    // (wllama honors abortSignal), and the partial rides out on the ABORTED
    // sentinel so interrupt()/Stop keeps the words already streamed. Older
    // environments without AbortController fall back to the instance's own
    // interrupt() if present.
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const gen = { abort() { aborted = true; if (ctrl) { try { ctrl.abort(); } catch (_) {} } else { try { instance.interrupt && instance.interrupt(); } catch (_) {} } } };
    activeGen = gen;
    const opts = {
      messages, stream: true,
      onData: onChunk,
      onNewToken: (_t, _p, currentText) => { if (typeof currentText === 'string') onChunk({ currentText }); },
      nPredict, max_tokens: nPredict,
      temperature: temp, top_k: 40, top_p: 0.9,
      sampling: { temp, top_k: 40, top_p: 0.9 },
    };
    if (ctrl) opts.abortSignal = ctrl.signal;
    try {
      const res = await instance.createChatCompletion(opts);
      // If the streaming callbacks never fired (non-streaming build, or a shape we
      // didn't pre-wire), recover the final text from the return value.
      if (!full && res != null) {
        if (typeof res === 'string') emit(res);
        else if (typeof res.currentText === 'string') emit(res.currentText);
        else if (res.choices && res.choices[0]) emit((res.choices[0].message && res.choices[0].message.content) || res.choices[0].text || '');
        else if (typeof res[Symbol.asyncIterator] === 'function') { for await (const ch of res) onChunk(ch); }
      }
    } catch (e) {
      if (aborted) throw abortedError(full);   // the abort surfaces as a reject — keep the partial
      throw e;
    } finally {
      if (activeGen === gen) activeGen = null;
    }
    if (aborted) throw abortedError(full);
    return full;
  }

  // Stream a chat completion, routing by the model key: the Claude API for an
  // 'anthropic:' key, the resident wllama (CPU) engine for a 'wllama:' key, the
  // resident WebLLM (GPU) engine otherwise. Returns the full raw text; deltas go
  // to onDelta. The single point where the backends diverge — everything above
  // (prompt assembly, think gating, audit) is shared.
  async function streamChat({ mlcKey, messages, temperature, maxTokens, onDelta }) {
    if (isAnthropic(mlcKey))
      return streamAnthropic({ model: anthropicModelId(mlcKey), messages, maxTokens, onDelta });
    const eng = await load(mlcKey);
    if ((eng && eng.wllama) || isWllama(mlcKey))
      return streamWllama({ instance: eng && eng.wllama, messages, temperature, maxTokens, onDelta });
    let full = '', aborted = false;
    const res = await eng.chat.completions.create({ messages, temperature, max_tokens: maxTokens, stop: STOP_SEQUENCES, stream: true });
    // interrupt() asks WebLLM to stop generating (interruptGenerate ends the
    // iterator); the `aborted` guard also breaks the loop immediately so no late
    // chunk slips through. The partial rides out on the ABORTED sentinel.
    const gen = { abort() { aborted = true; try { eng.interruptGenerate && eng.interruptGenerate(); } catch (_) {} } };
    activeGen = gen;
    try {
      for await (const chunk of res) {
        if (aborted) break;
        const d = chunk.choices?.[0]?.delta?.content || '';
        if (d) { full += d; if (onDelta) onDelta(d); }
      }
    } finally {
      if (activeGen === gen) activeGen = null;
    }
    if (aborted) throw abortedError(full);
    return full;
  }

  // Stop whatever turn is currently streaming (Claude SSE or WebLLM). The stream
  // throws the ABORTED sentinel, which the UI settles as a stopped reply keeping
  // the partial text. A no-op (false) when nothing is generating, so it can't
  // disturb an idle app. Generation only — model DOWNLOADS are stopped by
  // cancelLoad(); the UI calls both so Stop works at either stage.
  function interrupt() {
    const g = activeGen;
    if (!g) return false;
    try { g.abort(); } catch (_) {}
    return true;
  }

  // The model runtime won't load forever: a dead/blocked CDN (esm.run) used to
  // leave the import pending with no signal, which looked exactly like a frozen
  // download. Race the import against a timeout so it fails loudly instead.
  const IMPORT_TIMEOUT_MS = 30000;
  async function importWebLLM() {
    if (mod) return mod;
    // A test seam (and an injection point for an alternate runtime): if a module
    // is supplied on window, use it instead of reaching for the network.
    if (typeof window !== 'undefined' && window.EO_WEBLLM) { mod = window.EO_WEBLLM; return mod; }
    // ESM CDN — loaded on demand so the app starts instantly without it.
    // Pinned to an exact version (was unversioned): a floating major could
    // change the loader API or model defaults under us with no warning.
    const imported = import('https://esm.run/@mlc-ai/web-llm@0.2.79');
    let to;
    const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(Object.assign(new Error('Loading the model runtime from the CDN timed out — check your connection or any content blocker, then try again.'), { code: 'IMPORT_TIMEOUT' })), IMPORT_TIMEOUT_MS); });
    try { mod = await Promise.race([imported, timeout]); }
    finally { clearTimeout(to); }
    return mod;
  }

  // Host the engine in a Web Worker so the multi-GB download + WASM/shader
  // compile run OFF the main thread — the UI stays responsive during a load
  // instead of freezing (worst on the 7–8B models, which the unload-before-load
  // fix lets you reach but which then locked the page while compiling). The
  // worker imports the SAME pinned WebLLM build; it's a blob so the app needs no
  // extra file (index.html ships no CSP, so blob workers are allowed).
  function spawnWorker() {
    const src =
      'import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm@0.2.79";' +
      'const h = new WebWorkerMLCEngineHandler();' +
      'self.onmessage = (m) => h.onmessage(m);';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url, { type: 'module' });
    URL.revokeObjectURL(url);
    return w;
  }

  // Terminating a worker frees its WebGPU device along with the thread, so wrap
  // unload() to also kill the worker. Every existing eng.unload() call site (the
  // model-switch release, the superseded-build cleanup) then frees the worker
  // for free, with no other code needing to know a worker is involved.
  function bindWorker(eng, worker) {
    activeWorker = worker;
    const origUnload = (eng.unload && eng.unload.bind(eng)) || (async () => {});
    eng.unload = async () => {
      try { await origUnload(); }
      finally { if (activeWorker === worker) activeWorker = null; try { worker.terminate(); } catch (_) {} }
    };
    return eng;
  }

  // Prefer a worker engine; fall back to a main-thread engine ONLY if the worker
  // fails to even establish (blocked, unsupported, dead CDN). A cancel/terminate
  // or a genuine load error is NOT a reason to abandon the worker path for the
  // session — those propagate so the caller (buildOnce) handles them.
  const WORKER_HANDSHAKE_MS = 20000;
  // WebLLM's default cache backend is the Cache API, which the browser treats
  // as best-effort — even with navigator.storage.persist() granted, our users
  // keep coming back to a refreshed tab whose shards are gone. Forcing the
  // IndexedDB backend (useIndexedDBCache: true) puts the shards in IndexedDB
  // instead, which is the more durable bucket on every major engine: a tab
  // refresh, a few-day gap, even a "clear cache" that spares site data leaves
  // these alive. Combined with persistStorage(), this is what locks the
  // multi-GB download to a one-time cost. The prebuiltAppConfig (the model
  // registry WebLLM ships) is spread first so we don't drop any entries.
  function webllmAppConfig() {
    try {
      const m = mod; if (!m) return undefined;
      const base = m.prebuiltAppConfig || {};
      return Object.assign({}, base, { useIndexedDBCache: true });
    } catch (_) { return undefined; }
  }
  async function createEngine(mlcKey, opts) {
    const webllm = await importWebLLM();
    const appConfig = webllmAppConfig();
    const optsWithConfig = appConfig ? Object.assign({}, opts, { appConfig }) : opts;
    if (!workerBroken && typeof Worker !== 'undefined' && typeof webllm.CreateWebWorkerMLCEngine === 'function') {
      let worker = null, sawProgress = false;
      try {
        worker = spawnWorker();
        activeWorker = worker;
        const userCb = optsWithConfig && optsWithConfig.initProgressCallback;
        const wrapped = Object.assign({}, optsWithConfig, {
          initProgressCallback: (r) => { sawProgress = true; if (userCb) userCb(r); },
        });
        // A worker whose module import is blocked would otherwise leave the
        // engine handshake pending forever; surface that as a rejection.
        const failed = new Promise((_, rej) => {
          worker.onerror = () => rej(Object.assign(new Error('worker failed to start'), { _establish: true }));
          worker.onmessageerror = () => rej(Object.assign(new Error('worker message error'), { _establish: true }));
        });
        failed.catch(() => {});
        let hsTimer = null;
        const handshake = new Promise((_, rej) => {
          hsTimer = setTimeout(() => {
            if (!sawProgress) rej(Object.assign(new Error('worker handshake timeout'), { _establish: true }));
          }, WORKER_HANDSHAKE_MS);
          if (hsTimer && hsTimer.unref) hsTimer.unref();   // the watchdog must never itself hold the page/process open
        });
        try {
          const eng = await Promise.race([
            webllm.CreateWebWorkerMLCEngine(worker, mlcKey, wrapped),
            failed, handshake,
          ]);
          return bindWorker(eng, worker);
        } finally { clearTimeout(hsTimer); }
      } catch (e) {
        try { worker && worker.terminate(); } catch (_) {}
        if (activeWorker === worker) activeWorker = null;
        // Only blame (and disable) the worker path if it never got going.
        if (e && e._establish && !sawProgress) {
          workerBroken = true;
          if (typeof console !== 'undefined') console.warn('Worker engine unavailable; loading on the main thread instead.', e);
          // fall through to the main-thread engine below
        } else {
          throw e;   // cancel or a real load error — let buildOnce deal with it
        }
      }
    }
    return webllm.CreateMLCEngine(mlcKey, optsWithConfig);
  }

  // No init-progress callback for this long ⇒ the download has stalled. WebLLM
  // fires the callback per fetched chunk and per compiled shader, so a full
  // minute of total silence is a genuine hang (a dropped connection, a blocked
  // CDN, a corrupt cache entry), never just a slow-but-moving download — every
  // callback re-arms the watchdog. Overridable for tests via window.EO_STALL_MS.
  const STALL_MS = (typeof window !== 'undefined' && +window.EO_STALL_MS) || 60000;

  // One build attempt, guarded by a stall watchdog. Resolves with the engine, or
  // rejects with code:'STALL' if no progress arrives for STALL_MS — so a hung
  // fetch surfaces as a recoverable error instead of an eternal spinner. A build
  // that finishes after the watchdog gave up (or after a newer load superseded
  // it) unloads itself so it can't leak GPU memory.
  function buildOnce(mlcKey, onProgress, myToken) {
    return new Promise((resolve, reject) => {
      let settled = false, timer = null;
      const finish = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); if (activeCancel === cancelThis) activeCancel = null; fn(val); };
      // Registered so cancelLoad() can reject THIS build immediately (with a
      // distinct code) instead of waiting out the stall watchdog.
      const cancelThis = () => finish(reject, Object.assign(new Error('Model load canceled'), { code: 'CANCEL' }));
      activeCancel = cancelThis;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(reject, Object.assign(new Error('Model download stalled'), { code: 'STALL' })), STALL_MS);
      };
      arm();
      Promise.resolve(createEngine(mlcKey, {
        initProgressCallback: (r) => {
          if (myToken !== loadToken) return;                       // superseded by a newer load → go inert
          arm();                                                   // progress arrived → reset the stall clock
          if (onProgress) onProgress((r && r.progress) || 0, (r && r.text) || '');
        },
      })).then(
        (eng) => { if (settled) { try { eng && eng.unload && eng.unload(); } catch (_) {} return; } finish(resolve, eng); },
        (err) => finish(reject, err),
      );
    });
  }

  // Load (and cache) a model. onProgress(0..1, text). A stalled download is
  // retried once — resuming from the shards already cached, so only the missing
  // bytes refetch — before the error surfaces.
  async function load(mlcKey, onProgress) {
    // Claude needs no download — "loading" is just confirming a key is present.
    // Release any resident WebGPU engine first so switching backends frees the
    // GPU, then mark this the resident model with a sentinel engine so
    // isLoaded() reports true.
    if (isAnthropic(mlcKey)) {
      if (loadedModel === mlcKey && enginePromise) return enginePromise;
      if (!anthropicKey) throw Object.assign(new Error('Add your Anthropic API key to use Claude.'), { code: 'NOKEY' });
      if (enginePromise) {
        const prev = enginePromise; enginePromise = null; loadedModel = null;
        try { const eng = await prev; if (eng && eng.unload) await eng.unload(); } catch (e) {}
      }
      loadToken++;                       // supersede any in-flight WebLLM build
      loadedModel = mlcKey;
      enginePromise = Promise.resolve({ anthropic: true });
      return enginePromise;
    }
    // wllama (CPU): no WebGPU needed, so this branch sits ABOVE the WebGPU gate.
    // Same release-then-build, token-guarded, retry-on-stall shape as the GPU
    // path, so a switch frees the prior engine and a superseded build goes inert.
    if (isWllama(mlcKey)) {
      if (loadedModel === mlcKey && enginePromise) return enginePromise;
      if (enginePromise) {
        const prev = enginePromise; enginePromise = null; loadedModel = null;
        try { const eng = await prev; if (eng && eng.unload) await eng.unload(); } catch (e) {}
      }
      loadedModel = mlcKey;
      const myToken = ++loadToken;
      loadingActive = true;
      const attempt = buildWllama(mlcKey, onProgress, myToken);
      enginePromise = attempt;
      try { await attempt; }
      catch (e) {
        if (myToken === loadToken) { enginePromise = null; loadedModel = null; }
        throw e;
      } finally {
        if (myToken === loadToken) loadingActive = false;
      }
      return enginePromise;
    }
    if (!hasWebGPU()) throw new Error('WebGPU is not available in this browser. Chrome/Edge 113+ or a WebGPU-enabled browser is required for the local model.');
    if (loadedModel === mlcKey && enginePromise) return enginePromise;
    // Switching models: release the resident engine FIRST. A larger model
    // loaded on top of a smaller one is the usual reason a switch appears to
    // "do nothing" — the GPU is still holding the old weights, so the new load
    // OOMs or stalls. Unload, then build the new one on a clear device.
    if (enginePromise) {
      const prev = enginePromise;
      enginePromise = null; loadedModel = null;
      try { const eng = await prev; if (eng && eng.unload) await eng.unload(); } catch (e) {}
    }
    loadedModel = mlcKey;
    const myToken = ++loadToken;
    loadingActive = true;
    const attempt = (async () => {
      try {
        return await buildOnce(mlcKey, onProgress, myToken);
      } catch (e) {
        // A stall is usually a transient drop. Retry once (cached shards make it
        // quick — only the missing bytes refetch); only if THAT stalls too does
        // the error propagate.
        if (e && e.code === 'STALL' && myToken === loadToken) {
          if (onProgress) onProgress(0, 'Download stalled — retrying…');
          return await buildOnce(mlcKey, onProgress, myToken);
        }
        throw e;
      }
    })();
    enginePromise = attempt;
    try {
      await attempt;          // surface a build failure here, not on first turn
    } catch (e) {
      if (myToken === loadToken) { enginePromise = null; loadedModel = null; }   // honest isLoaded(); allow retry. Don't clobber a newer load.
      throw friendlyError(e);
    } finally {
      if (myToken === loadToken) loadingActive = false;   // a newer load keeps its own flag
    }
    return enginePromise;
  }

  // User-facing cancel for an in-flight load. Bumps the load token so the build
  // goes inert, hard-terminates the worker so a wedged/slow download stops NOW
  // (not after the stall timeout), and rejects the in-flight build with
  // code:'CANCEL' so the caller can fail quietly. No-op once a load has settled,
  // so it can never tear down a model that's already loaded and running.
  function cancelLoad() {
    if (!loadingActive) return false;
    loadingActive = false;
    loadToken++;
    enginePromise = null; loadedModel = null;
    const c = activeCancel; activeCancel = null;
    if (c) c();                                        // settle the in-flight build as CANCEL first
    const w = activeWorker; activeWorker = null;
    if (w) { try { w.terminate(); } catch (_) {} }     // then hard-stop the worker so the download halts now
    const lw = activeWllama; activeWllama = null;
    if (lw && lw.exit) { try { lw.exit(); } catch (_) {} }   // free the CPU runtime too
    return true;
  }

  function friendlyError(e) {
    if (e && e.code === 'STALL')
      return new Error('The model download stalled — the connection stopped responding. Already-downloaded parts are cached, so loading the model again resumes where it left off.');
    return e;
  }

  // Ask the browser to mark this origin's storage PERSISTENT, so the cached
  // model shards (IndexedDB for WebLLM, Cache API for wllama) can't be evicted
  // under storage pressure. Without this, a multi-GB model can quietly disappear
  // between sessions and the next load re-downloads everything from scratch —
  // exactly the "hard redownload" we're trying to avoid. Idempotent: skips the
  // ask if persistence is already granted; resolves to the final state. A
  // no-op (false) on browsers without the Storage API. Call once on boot.
  async function persistStorage() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage) return false;
      if (typeof navigator.storage.persisted === 'function') {
        try { if (await navigator.storage.persisted()) return true; } catch (_) {}
      }
      if (typeof navigator.storage.persist !== 'function') return false;
      return !!(await navigator.storage.persist());
    } catch (_) { return false; }
  }

  // Whether a model's weights are already on disk in this browser. Tells the
  // UI when a row in the picker is a fast re-instantiate (no download) rather
  // than a multi-gigabyte fetch. Best-effort across backends:
  //  - Anthropic: nothing to cache.
  //  - wllama: check OPFS for ANY of the model's mirror URLs. wllama's cache
  //    keys files by hashSHA1(url)+'_'+filename, so a primary-then-fallback
  //    download leaves bytes that satisfy the FIRST URL match too.
  //  - WebLLM: use the library's own hasModelInCache helper, which reads the
  //    IndexedDB bucket we force on for durability.
  // Resolves to { cached, kind } so callers can render a badge without
  // knowing the backend; unknown flips false rather than throwing.
  async function cacheStatus(mlcKey) {
    if (isAnthropic(mlcKey)) return { cached: false, kind: 'cloud' };
    if (isWllama(mlcKey)) {
      try {
        const src = wllamaSource(mlcKey);
        if (!src) return { cached: false, kind: 'cpu' };
        const cached = await wllamaCachedAny(src);
        return { cached, kind: 'cpu' };
      } catch (_) { return { cached: false, kind: 'cpu' }; }
    }
    try {
      const webllm = await importWebLLM();
      if (typeof webllm.hasModelInCache === 'function') {
        const yes = await webllm.hasModelInCache(mlcKey, webllmAppConfig());
        return { cached: !!yes, kind: 'gpu' };
      }
    } catch (_) {}
    return { cached: false, kind: 'gpu' };
  }

  // Whole-origin storage usage. The browser doesn't itemize by feature, so we
  // surface the totals (bytes used / bytes available) and let the UI present
  // them; per-model bytes would require parsing the cache directly. Resolves
  // to null on browsers without the Storage API.
  async function storageEstimate() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
      const e = await navigator.storage.estimate();
      return { usage: (e && e.usage) || 0, quota: (e && e.quota) || 0 };
    } catch (_) { return null; }
  }

  // Wipe a model's cached weights/config so the next load re-downloads from
  // scratch — the escape hatch when a half-finished download left a corrupt
  // shard that keeps re-stalling on every reload. Best-effort and feature-
  // detected across versions; resolves false if nothing could be cleared.
  // wllama: walk every mirror URL and delete its OPFS entry by name. WebLLM:
  // its own delete helpers.
  async function clearCache(mlcKey) {
    if (isWllama(mlcKey)) {
      let did = false;
      const src = wllamaSource(mlcKey);
      const urls = wllamaUrls(src);
      // Delete OPFS files directly so we don't need to spin up a Wllama
      // instance (which is heavy and itself touches the cache).
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
        try {
          const root = await navigator.storage.getDirectory();
          for (const u of urls) {
            try {
              const name = await wllamaCacheName(u);
              if (!name) continue;
              await root.removeEntry(name);
              did = true;
            } catch (_) {}
          }
        } catch (_) {}
      }
      // Also wipe any legacy Cache-API entry from an older wllama build.
      try {
        if (typeof caches !== 'undefined') {
          const keys = await caches.keys();
          for (const k of keys) {
            for (const u of urls) {
              try { const c = await caches.open(k); if (await c.delete(u)) did = true; } catch (_) {}
            }
          }
        }
      } catch (_) {}
      return did;
    }
    try {
      const webllm = await importWebLLM();
      if (typeof webllm.deleteModelAllInfoInCache === 'function') { await webllm.deleteModelAllInfoInCache(mlcKey, webllmAppConfig()); return true; }
      let did = false;
      for (const name of ['deleteModelInCache', 'deleteModelWasmInCache', 'deleteChatConfigInCache'])
        if (typeof webllm[name] === 'function') { try { await webllm[name](mlcKey, webllmAppConfig()); did = true; } catch (_) {} }
      return did;
    } catch (_) { return false; }
  }

  function isLoaded(mlcKey) { return loadedModel === mlcKey && !!enginePromise; }

  // Pick the system prompt for the turn.
  //  - plain chat (grounded=false, not creative): just be Cleo and converse,
  //    using the running history. No document is forced in.
  //  - grounded: answer strictly from the supplied passages; citations are
  //    bound mechanically afterward, never written by the model.
  //  - creative: free composition over any supplied passages.
  function systemFor(mode, task, grounded, depth = 1, opts) {
    if (mode === 'creative')
      return 'You are Cleo, a private assistant running locally in the user\'s browser. Use any supplied passages as raw material to compose freely. Do not add citation markers.';
    if (grounded) {
      // The notes-and-spans framing. The old prompts treated the model as a
      // hostile witness ("Answer using ONLY the supplied passages… never add
      // anything") — which produced literalism over substitution: "who wrote
      // it?" answered "The author wrote it." while the span carried the name,
      // because echoing the question's noun stays closer to "the passages'
      // own wording" than pulling the name out. The reframe: spans are
      // verbatim quotes to trust and USE; notes are the reader's own graph
      // understanding, usually right, sometimes wrong; spans win conflicts.
      // One prompt replaces six near-duplicates, with NO length
      // prescriptions — the model answers as it sees fit; depth scales
      // max_tokens (the real bound) and nothing else. Faithfulness is now a
      // STAMP, not a gag (the "stamp, not gate" move): for what the document
      // covers, the span is the truth here and outside knowledge never
      // overrides it; but a question the passages simply don't touch is
      // answered plainly rather than stonewalled — the talker is no longer
      // ordered to source ONLY from the spans, because that floor turned a
      // synonym or an aside into a confident "the document is silent." What
      // the document didn't witness is flagged MECHANICALLY (inventedTerms /
      // the residual absence flag / the WI-7 witness degree), so the talker
      // needn't hedge about sourcing — the stamp tells that truth, never the
      // talker's voice. What it no longer carries (Brief 2) is the absence
      // ORDER — the talker is not told to "say the document doesn't say"; low
      // witness rides the stamp (WI-7), so absence is a measurement the system
      // reports, never a sentence the talker speaks. Span trust is graded, not
      // flat: the passages are witnessed evidence, with coverage tracked for
      // the talker rather than asserted by it. The one summary-specific line
      // is the degeneracy guard (don't hand back a single span as the
      // summary), which is faithfulness, not length.
      const lines = [
        'You\'re Cleo, a helpful assistant running locally in the user\'s browser. You\'re in the middle of a conversation with them about a document you\'ve been reading together.',
        '',
        'Two kinds of context come with each turn:',
        '- Spans — passages we found in the document, quoted exactly. They\'re your witnessed evidence: lean on them and answer from what they show. How fully they cover the question is tracked for you, so you needn\'t vouch for their completeness — just use what\'s there.',
        '- Your notes — your own understanding from reading the document. Usually right, sometimes wrong. Good for shape, connections, and who-is-who.',
        '',
        'Write in your own voice — say it the way it wants to be said. You are not handed a template or told how sure to sound; just answer well from what is here.',
        '',
        'If a span and a note disagree, the span wins. If a span contains a name, date, or title that answers the question, use it directly — don\'t echo the question\'s wording back. When a fact is in neither the spans nor your notes, the document hasn\'t witnessed it — the system flags that for you, mechanically, so you don\'t have to vouch for it or warn about it yourself.',
        '',
        'For anything the document does cover, what the spans show is its truth here — don\'t override a span with outside knowledge. But don\'t stonewall a question the passages simply don\'t touch: if you know the answer, give it plainly rather than refusing, and let the automatic flag mark what the document didn\'t witness. Read the spans for the name, date, or detail the question asks before drawing any conclusion.',
      ];
      if (task === 'summary') {
        lines.push('');
        lines.push('Right now they want a summary: say what the document is about in your own words, drawing the spans together — never copy or lightly reword a single span as the whole answer.');
      }
      lines.push('');
      if (opts && opts.provenanceKeys) {
        // Provenance binds at generation (the relation_gate rule): the model
        // tags each claim with the span it was BUILT from, and the engine's
        // bindClaimKeys verifies each tag against its own span — never
        // re-retrieving a better-agreeing one. Off by default; without the
        // option this prompt is byte-identical to before.
        lines.push('After each factual claim, write the tag of the span you actually used, exactly as it appears above — like [s12], placed just before the period. One tag per claim. If a claim is your synthesis across several spans, tag the one that most directly supports it; if nothing you were handed supports a claim, write [s?] rather than inventing a tag.');
      } else {
        lines.push('Don\'t write citation markers like [s1] — those are added mechanically after you write.');
      }
      return lines.join('\n');
    }
    return 'You are Cleo, a private assistant that runs entirely in the user\'s browser via WebGPU — you are a local open-weights model, not ChatGPT or Claude, and nothing the user types ever leaves their device. Chat naturally and concisely, using the conversation so far for context. Do not invent facts about real people, places, or events: if you are not sure something is true, say you are not sure rather than making something up — a confident wrong answer is worse than an honest "I\'m not certain." A document may be open; when the user asks about its contents you are handed the exact passages, so you never need to guess at what a document says. If the user is clearly asking about an open document but you were not handed a relevant passage, say so and offer to look it up, rather than guessing at what it contains. The history may be partly condensed: the most recent turns are verbatim, while earlier ones are folded into a short, index-tagged recap (lines like "#3 user: …"). Treat that recap as faithful but lossy — rely on it for the gist, and if the user needs the exact earlier wording, say so plainly rather than reconstructing it from the recap, since the precise turns can be recalled mechanically by index. If the user asks for several things at once, do the most important one well and offer to continue with the rest one at a time, rather than doing all of them shallowly — you have a human-sized sense of how much you can do at once. If you don\'t know something, say so plainly.';
  }

  // Chat-history policy.
  //  - The most recent RECENT_TURNS turns are always kept verbatim.
  //  - Everything older is folded into a single compact recap so the model keeps
  //    the gist without spending the whole context budget on stale turns. The
  //    recap is mechanical (no model call), so it can never hallucinate, and each
  //    folded line is tagged with its absolute turn index.
  //  - Because every turn keeps its index, an exact span can be pulled back out
  //    verbatim with recallSpan() when an answer needs the precise earlier wording.
  const RECENT_TURNS = 8;         // most recent turns kept word-for-word
  const SUMMARY_LINE_CHARS = 160; // per-turn cap inside the condensed recap
  const WM_RECENT_TURNS = 3;      // verbatim window shrinks when working memory carries continuity

  function condense(s, cap = SUMMARY_LINE_CHARS) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > cap ? t.slice(0, cap - 1).trimEnd() + '…' : t;
  }

  // Fold a block of older turns into one index-tagged recap message. `startIndex`
  // is the absolute index (into the full history) of the first folded turn.
  function summarizeTurns(turns, startIndex = 0) {
    const lines = turns.map((m, i) =>
      `#${startIndex + i} ${m.role === 'assistant' ? 'Cleo' : 'user'}: ${condense(m.content)}`);
    return {
      role: 'system',
      content:
        `Earlier conversation, condensed (turns #${startIndex}–#${startIndex + turns.length - 1}). ` +
        `This recap is lossy; the exact wording of any turn can be recalled by index. Do not treat omissions as facts.\n` +
        lines.join('\n'),
    };
  }

  // Pull an exact, verbatim span of earlier turns back out of the full history by
  // absolute turn index — the precise-recall escape hatch for when the condensed
  // recap is not enough. Inclusive range; out-of-range indices are clamped. When
  // `to` is omitted a single turn is returned.
  function recallSpan(history, from, to) {
    const hist = Array.isArray(history) ? history : [];
    const a = Math.max(0, from | 0);
    const b = Math.min(hist.length - 1, (to == null ? from : to) | 0);
    const out = [];
    for (let i = a; i <= b; i++)
      if (hist[i] && hist[i].content) out.push({ index: i, role: hist[i].role, content: hist[i].content });
    return out;
  }

  // Render the heat-ranked working memory (depth > 1) as the model's own
  // NOTES — first-person voice ("things you noticed"), joined into the user
  // message's notes block rather than the system prompt. Notes are turn
  // context, not standing instruction: this is what lets the grounded
  // reframe ("your notes — usually right, sometimes wrong") actually pay
  // off, and it's where who-is-who answers come from when retrieval has no
  // lexical hook. Empty ⇒ '' ⇒ the prompt is byte-identical to having none.
  function renderNotes(wm) {
    if (!wm) return '';
    const hot = wm.hot || [], warm = wm.warm || [], cold = wm.cold || [], recalled = wm.recalled || [];
    if (!hot.length && !warm.length && !cold.length && !recalled.length) return '';
    const out = [];
    if (hot.length) {
      out.push('Things in focus right now:');
      for (const h of hot.slice(0, 5)) {
        const s = (h.sents || []).map(x => x && x.t).filter(Boolean).slice(0, 2).join(' ');
        out.push(`- ${h.entity}${s ? ' — ' + condense(s, 220) : ''}`);
      }
    }
    if (warm.length) {
      out.push('Connected, one step away:');
      for (const w of warm.slice(0, 4)) out.push(`- ${w.entity} (via ${w.oneHopFrom})${w.portraitLine ? ': ' + condense(w.portraitLine, 160) : ''}`);
    }
    if (recalled.length) {
      out.push('Earlier material that came back into view:');
      for (const r of recalled.slice(0, 3)) if (r && r.t) out.push(`- ${condense(r.t, 200)}`);
    }
    if (cold.length) {
      const rng = (c) => c.sentRange ? ` [s${c.sentRange[0]}${c.sentRange[1] !== c.sentRange[0] ? '–s' + c.sentRange[1] : ''}]` : '';
      out.push('Other things you noticed (mention if relevant): ' + cold.slice(0, 8).map(c => c.label + rng(c)).join(', '));
    }
    return out.join('\n');
  }
  const renderWorkingMemory = renderNotes;   // legacy name (sandbox / prompt lab)

  // Assemble the chat messages: system + a condensed recap of older turns + as
  // many recent turns verbatim as fit the budget + this turn. Exposed for
  // testing. `est` is a coarse chars/4 token estimate — good enough to keep us
  // off the context ceiling. Past RECENT_TURNS, older turns are summarized rather
  // than dropped, and any recent turn that won't fit verbatim is folded into the
  // recap too, so nothing silently vanishes from the model's view.
  // `workingMemory` (depth > 1) is the heat-ranked hot/warm/cold subgraph: it
  // folds into the system message and shrinks the verbatim recency window, since
  // heat now carries the continuity. Absent/empty ⇒ byte-identical to before.
  // Token estimate for budget math. chars/4 is right for English but
  // under-counts CJK ~2.4x (a CJK char is ~1 token in the shipped models'
  // tokenizers) — a Japanese document would blow the window while the
  // estimator believed it was at 40%. CJK chars count as 1 token each.
  const CJK_RE = /[　-鿿豈-﫿ｦ-ﾟ]/;
  function estTokens(s) {
    const str = String(s || '');
    let cjk = 0;
    for (const ch of str) if (CJK_RE.test(ch)) cjk++;
    return Math.ceil(cjk + (str.length - cjk) / 4);
  }
  // Default assembly budget. Every shipped model is a 4096-token WebLLM
  // prebuild; the budget must leave room for the reply (max_tokens ≤ 520) and
  // estimator error. The old default (7000) exceeded the window outright and
  // leaned on the caller's catch-retry to recover.
  const DEFAULT_BUDGET = 3300;

  // ---- the shape pass, dissolved (Brief 2 + the form-as-stamp patch) ----
  // The old "shape pass" was a blind per-turn LLM call that emitted a note
  // welding three jobs together — the move, the register, and how sure to
  // sound — while seeing the title but never the spans, which let it leak
  // world knowledge and set confidence before any evidence was in. It is
  // dissolved. Its three jobs go to the three things that own them, and NONE
  // of them is a string handed to the talker:
  //   • the MOVE (what kind of answer this is) is the router's intent —
  //     mechanical and auditable (engine.js classifyIntent), upstream;
  //   • the FORM is NOT a template handed in — that would be steering. It is a
  //     per-genre embedding CENTROID the OUTPUT is measured against, AFTER, as a
  //     second stamp beside the witness degree (shape.js · formDegree). The
  //     talker writes voice-only here; nothing about layout enters the prompt.
  //     "This feels like the wrong KIND of answer" is a distance, not a spec —
  //     and the centroid is never unfolded into words the model reads.
  //   • the CONFIDENCE (how sure to sound) is read off the witness stamp
  //     (WI-7), after the evidence is in — never assigned ahead.
  // So there is no FORM_LIBRARY of prompt strings and no shapePass call: the
  // grounded prompt below is voice-only, and `buildUserContent` no longer
  // appends any how-to-answer block.

  // The grounded user message, tiered: question first (orientation), then the
  // spans quoted exactly, then the reader's notes, then the closing question.
  // Brief 2: there is NO how-to-answer block — the talker writes voice-only.
  // Form is measured on the OUTPUT afterward (a centroid stamp), never handed
  // in as structure; confidence rides the witness stamp, not an instruction.
  // The question still closes the message — long context would otherwise push
  // it out of the model's recency window. Non-grounded callers (plain chat,
  // creative) keep their old shapes; a grounded caller that still passes a
  // prebuilt blob (the summary sample) gets the same frame around the blob.
  // `shapeNote` is accepted for call-site stability but is no longer rendered:
  // Brief 2 removed the how-to-answer block (the talker writes voice-only; form
  // is a stamp measured on the output, never a prompt input). A non-empty value
  // still keeps the assembled message non-trivial, but nothing about layout is
  // ever shown to the model.
  function buildUserContent({ question, docTitle, spans, notesProse, contextText, grounded, shapeNote }) {
    if (!grounded) return contextText ? `Passages:\n${contextText}\n\n${question}` : question;
    const hasSpans = Array.isArray(spans) && spans.length > 0;
    if (!hasSpans && !notesProse && !contextText) return question;
    const parts = [`The user just asked: ${question}`, ''];
    parts.push('Context for this turn:');
    if (docTitle) parts.push(`You've been reading a document called "${docTitle}".`);
    parts.push('');
    if (hasSpans) {
      parts.push('Sentences from the document that look relevant, quoted exactly:');
      for (const s of spans) parts.push(`  [${s.tag != null ? s.tag : 's' + s.idx}] ${s.text}`);
      parts.push('');
    } else if (contextText) {
      parts.push('Material from the document:');
      parts.push(contextText);
      parts.push('');
    }
    if (notesProse) {
      parts.push('Your notes on the document (your understanding from reading it — usually right, sometimes wrong):');
      parts.push(notesProse);
      parts.push('');
    }
    parts.push(`Answer the user's question: ${question}`);
    return parts.join('\n');
  }

  function assembleMessages({ sys, history, contextText, question, grounded, budget = DEFAULT_BUDGET, recentTurns = RECENT_TURNS, workingMemory = null, spans = null, notes = '', docTitle = '', shapeNote = '' }) {
    const est = (m) => estTokens((m && m.content) || '');
    // Working memory renders as the model's own notes and joins any
    // graph-derived notes in the USER message — turn context, not standing
    // instruction. The system message stays bare (plus the recap below).
    const wmBlock = renderNotes(workingMemory);
    const notesProse = [String(notes || '').trim(), wmBlock].filter(Boolean).join('\n\n');
    const userContent = buildUserContent({ question, docTitle, spans, notesProse, contextText, grounded, shapeNote });
    const sysFull = sys;
    const head = { role: 'system', content: sysFull };
    const tail = { role: 'user', content: userContent };
    let used = est(head) + est(tail);

    const hist = (Array.isArray(history) ? history : []).filter(m => m && m.content);
    // The most recent turns are the verbatim window; the rest are candidates for
    // condensing. Heat-ranked working memory carries continuity, so when it is
    // present the verbatim window shrinks to reclaim that prompt bandwidth.
    const rt = wmBlock ? Math.min(recentTurns, WM_RECENT_TURNS) : recentTurns;
    const splitAt = Math.max(0, hist.length - rt);
    const recent = hist.slice(splitAt);

    // Keep as many recent turns verbatim as the budget allows, newest first; any
    // that don't fit fall back into the recap rather than being dropped outright.
    const kept = [];
    let firstKept = recent.length; // index (within `recent`) of the oldest verbatim turn
    for (let i = recent.length - 1; i >= 0; i--) {
      const t = est(recent[i]);
      if (used + t > budget) break;
      used += t; firstKept = i;
      kept.unshift({ role: recent[i].role === 'assistant' ? 'assistant' : 'user', content: recent[i].content });
    }

    // Everything before the verbatim window gets condensed into one recap. If even
    // the recap overflows, drop its oldest lines (and advance the start index) until
    // it fits — oldest context degrades first, but only after being condensed.
    const foldEnd = splitAt + firstKept; // exclusive: all turns before the kept window
    let toFold = hist.slice(0, foldEnd);
    let startIdx = 0;
    let summary = null;
    while (toFold.length) {
      const s = summarizeTurns(toFold, startIdx);
      if (used + est(s) <= budget) { summary = s; used += est(s); break; }
      toFold = toFold.slice(1); startIdx++;
    }

    // MLC/WebLLM accepts exactly one `system` message, and it must be first:
    // a second one makes chat.completions.create() throw ("System prompt should
    // always be the first message in `messages`"), which silently drops every
    // grounded turn onto the mechanical fallback. The condensed recap is
    // system-level context, so fold it into the head prompt rather than emitting
    // it as its own system message.
    const head2 = summary ? { role: 'system', content: `${sysFull}\n\n${summary.content}` } : head;
    return [head2, ...kept, tail];
  }

  // ---- reasoning-model think gating ----
  // Reasoning builds (Qwen3, R1 distills) emit `<think>…</think>` before the
  // answer. Without gating, the reasoning streams to the UI as if it were the
  // answer — and a turn that hits max_tokens mid-think ships raw chain-of-
  // thought as the reply, which the verifier then grades. The stream filter
  // drops think content as it arrives (with a small look-behind so a tag
  // split across deltas is still caught); the post-strip drops any unclosed
  // think tail (the max_tokens cutoff case). The audit record keeps the FULL
  // text verbatim, think included — that's exactly what audit mode exists
  // for; only the user-visible stream and the returned answer are filtered.
  // NOTE: `</think>` is deliberately NOT a stop sequence — the answer FOLLOWS
  // the close tag, so stopping there would truncate every reasoning turn to
  // nothing. Stops cover only end-of-turn markers sloppy templates leak.
  const STOP_SEQUENCES = ['<|im_end|>', '<|eot_id|>'];
  function stripThink(text) {
    return String(text == null ? '' : text).replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  }
  // A stateful per-turn delta filter: feed() each chunk, emitting only
  // outside-think text via onToken; flush() releases the held look-behind.
  function makeThinkFilter(onToken) {
    let inThink = false, buf = '';
    const emit = (s) => { if (s && onToken) onToken(s); };
    return {
      feed(d) {
        if (!d) return;
        buf += d;
        while (buf.length) {
          if (!inThink) {
            const open = buf.indexOf('<think>');
            if (open === -1) {
              // Hold the last 7 chars back in case a tag splits across deltas.
              if (buf.length > 7) { emit(buf.slice(0, -7)); buf = buf.slice(-7); }
              break;
            }
            emit(buf.slice(0, open));
            buf = buf.slice(open + 7);
            inThink = true;
          } else {
            const close = buf.indexOf('</think>');
            if (close === -1) { buf = buf.slice(-8); break; }   // discard think, keep tail for the close tag
            buf = buf.slice(close + 8);
            inThink = false;
          }
        }
      },
      flush() { if (!inThink) emit(buf); buf = ''; },
    };
  }

  // The answer pass's token ceiling. Depth scales the grounded caps (summary
  // 260→520, answer 180→420); lvl 1 holds today's exact ceilings. An explicit
  // `override` — the shape layer's best-fit budget, sized from the matched
  // archetype's own length (shape.js §9) — WINS when present, clamped to a safe
  // window so a 4096-token prebuild always has room for the assembled prompt
  // (max_tokens ≤ 520, per the DEFAULT_BUDGET math). With no override the result
  // is byte-identical to the old inline formula, so callers that don't pass one
  // are unchanged (parity).
  function resolveMaxTokens({ mode, grounded, task, depth, override }) {
    const lvl = Math.min(3, Math.max(1, (depth | 0) || 1));
    const base = mode === 'creative' ? 320
      : grounded ? (task === 'summary' ? 260 + (lvl - 1) * 130 : 180 + (lvl - 1) * 120)
      : 360;
    if (typeof override === 'number' && isFinite(override) && override > 0)
      return Math.max(24, Math.min(520, Math.round(override)));
    return base;
  }

  // Stream a turn. Plain chat passes history with no passages; grounded/summary
  // pass retrieved passages. onToken(deltaText). `maxTokens` (optional) lets the
  // shape layer set the ceiling from the best-fit archetype's length; unset, the
  // depth-scaled default applies (parity).
  async function phrase({ mlcKey, question, contextText, history, mode, task, grounded, onToken, budget, workingMemory, depth, sysOverride, spans, notes, docTitle, shapeNote, maxTokens, provenanceKeys }) {
    // Thinking depth (1 reflex … 3 deepest) shapes the grounded phrasing and how
    // much room the answer gets. Absent/1 ⇒ today's prompt and token caps (parity).
    const lvl = Math.min(3, Math.max(1, (depth | 0) || 1));
    // sysOverride lets the sandbox's prompt lab try a candidate talker prompt;
    // unset everywhere else, so normal chat is byte-identical (parity holds).
    const sys = sysOverride || systemFor(mode, task, grounded, lvl, provenanceKeys ? { provenanceKeys: true } : undefined);
    const messages = assembleMessages({ sys, history, contextText, question, grounded, budget, workingMemory, spans, notes, docTitle, shapeNote });
    const temperature = mode === 'creative' ? 0.8 : (grounded ? 0.12 : 0.4);
    // Deeper reading earns more room to synthesize: the grounded caps grow with the
    // dial (summary 260→520, answer 180→420). lvl 1 holds today's exact ceilings,
    // unless the shape layer hands in a best-fit budget (maxTokens), which wins.
    const max_tokens = resolveMaxTokens({ mode, grounded, task, depth: lvl, override: maxTokens });
    const max_tokens_shaped = (typeof maxTokens === 'number' && isFinite(maxTokens) && maxTokens > 0) || undefined;
    // Audit hook (no-op unless window.EOAudit is present): record the EXACT prompt
    // the model saw, its parameters, its raw output, and the wall time — so
    // auditing mode can show what was sent and what came back, verbatim.
    const A = (typeof window !== 'undefined') ? window.EOAudit : null;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const recLLM = (output, extra) => {
      if (!A || !A.step) return;
      try {
        A.step('llm', Object.assign({
          mode, task: task || null, grounded: !!grounded, mlcKey,
          params: { temperature, max_tokens, max_tokens_shaped, depth: lvl, budget: budget || null },
          system: sys,
          messages: messages.map(m => ({ role: m.role, chars: (m.content || '').length, content: m.content })),
          output,
          ms: Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0),
        }, extra || {}));
      } catch (e) {}
    };
    let full = '';
    const gate = makeThinkFilter(onToken);
    try {
      full = await streamChat({ mlcKey, messages, temperature, maxTokens: max_tokens, onDelta: (d) => gate.feed(d) });
      gate.flush();
    } catch (e) {
      if (isAbort(e)) {
        // A user interrupt: flush whatever the gate held, keep the partial draft
        // in the trace (marked interrupted), then let the caller settle it.
        try { gate.flush(); } catch (_) {}
        recLLM(stripThink(String(e.partial || '')).trim(), { interrupted: true });
        throw e;
      }
      recLLM(full, { error: String((e && e.message) || e) });   // record the failed attempt, then let the caller handle it
      throw e;
    }
    // The audit keeps the verbatim text (think content intact); the caller
    // gets the stripped answer. `filtered` marks the records where they differ.
    const out = stripThink(full);
    recLLM(full.trim(), out !== full.trim() ? { filtered: out } : undefined);
    return out;
  }

  window.EOLLM = { hasWebGPU, hasAnthropicKey, setAnthropicKey, isAnthropic, isWllama, hasWasm, wllamaModels, modelTier, modelParamsB, registerUploadedModel, fallbackKey, prewarmFallback, prewarmFallbackModel, load, cancelLoad, interrupt, isAbort, isLoaded, clearCache, persistStorage, cacheStatus, storageEstimate, phrase, runAnthropicTools, systemFor, assembleMessages, buildUserContent, renderNotes, renderWorkingMemory, summarizeTurns, recallSpan, RECENT_TURNS, DEFAULT_BUDGET, estTokens, resolveMaxTokens, stripThink, makeThinkFilter };
})();
