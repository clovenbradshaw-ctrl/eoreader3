/* ============================================================
   Cleo — the Cleo-wide adapter registry.

   Published as window.EOAdapters. The registry is the one piece that knows the
   CONTRACT and nothing else: it never knows a model, never enumerates a
   capability in a constant, never carries model-specific logic. Capabilities
   are DISCOVERED from the manifests adapters register with — add an adapter and
   its capability appears; remove it and the capability is gone.

   Packs ask for what they need by CAPABILITY, never by adapter id:

       const events = await window.EOAdapters.runFor('ocr', someBlob);

   selected(capability) resolves which adapter answers, in this order:
     1. the user's explicit choice (localStorage eo.adapters.preferred.<cap>),
     2. the performance profile (localStorage eo.adapters.profile) — browser
        prefers the lightest, desktop the middle, maximum the heaviest,
     3. the first runnable adapter in registration order.
   Adapters that cannot run on this device's backend are filtered out of the
   resolution (and rendered disabled, with the reason, in the picker).
   ============================================================ */
(function () {
  'use strict';
  const C = window.EOAdapterContract;
  const warn = (msg, e) => { try { (window.eoWarn || console.warn)('[EOAdapters] ' + msg, e || ''); } catch (_) {} };
  if (!C) { warn('contract.js must load before registry.js — registry inert'); return; }

  // Registration order is preserved (the array); ids index into it. Both are
  // the registry's only state — everything else is derived.
  const list = [];
  const byIdMap = Object.create(null);

  const PREF_PREFIX = 'eo.adapters.preferred.';   // + capability
  const PROFILE_KEY = 'eo.adapters.profile';
  const PROFILES = ['browser', 'desktop', 'maximum'];
  const DEFAULT_PROFILE = 'desktop';

  // ---- backend capability probes (generic; no model knowledge) -------------
  const hasWebGPU = () => typeof navigator !== 'undefined' && !!navigator.gpu;
  const hasWasm = () => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';

  // Can this adapter run on the current device? The only gate is the manifest's
  // declared backend. cpu always; wasm needs WebAssembly; webgpu needs navigator.gpu.
  function canRun(a) {
    const b = a && a.manifest && a.manifest.resources && a.manifest.resources.backend;
    if (b === 'webgpu' && !hasWebGPU()) return { ok: false, reason: 'Requires WebGPU — not available in this browser' };
    if (b === 'wasm' && !hasWasm()) return { ok: false, reason: 'Requires WebAssembly — not available here' };
    return { ok: true, reason: '' };
  }

  // ---- storage helpers (best-effort; absent storage degrades to defaults) --
  function lsGet(k) { try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch (_) { return null; } }
  function lsSet(k, v) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch (_) {} }

  function profile() { const p = lsGet(PROFILE_KEY); return PROFILES.indexOf(p) >= 0 ? p : DEFAULT_PROFILE; }
  function setProfile(p) {
    if (PROFILES.indexOf(p) < 0) return;
    lsSet(PROFILE_KEY, p);
    dispatch({ profile: p });
  }
  function preferred(cap) { return lsGet(PREF_PREFIX + cap) || null; }
  function setPreferred(cap, id) {
    if (id) lsSet(PREF_PREFIX + cap, id); else lsDel(PREF_PREFIX + cap);
    dispatch({ capability: cap });
  }

  function dispatch(detail) {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('eo.adapters.changed', { detail: detail || {} }));
      }
    } catch (_) {}
  }

  // ---- registration ---------------------------------------------------------
  function register(adapter) {
    if (!adapter || !adapter.manifest) { warn('register: adapter is missing a manifest'); return false; }
    const v = C.validateManifest(adapter.manifest);
    if (!v.ok) { warn('register: invalid manifest for "' + (adapter.manifest.id || '?') + '": ' + v.errors.join('; ')); return false; }
    if (typeof adapter.load !== 'function' || typeof adapter.run !== 'function' || typeof adapter.ready !== 'function') {
      warn('register: adapter "' + adapter.manifest.id + '" must implement load(), ready(), run()'); return false;
    }
    const id = adapter.manifest.id;
    if (byIdMap[id]) { warn('register: duplicate adapter id "' + id + '" ignored'); return false; }
    list.push(adapter);
    byIdMap[id] = adapter;
    return true;
  }

  // ---- discovery (everything derived from the registered manifests) --------
  const all = () => list.slice();
  const byId = (id) => byIdMap[id] || null;
  const byCapability = (cap) => list.filter(a => a.manifest.capability === cap);
  // Capabilities are DISCOVERED, never enumerated in a constant.
  const capabilities = () => [...new Set(list.map(a => a.manifest.capability))].sort();
  const ids = () => list.map(a => a.manifest.id);

  const mem = (a) => (a.manifest.resources && a.manifest.resources.memMB) || 0;
  const indexOf = (a) => list.indexOf(a);

  // Pick from a pool by the performance-profile hint. browser → lightest,
  // maximum → heaviest, desktop → the middle. Ties break by registration order.
  function pickByProfile(pool, prof) {
    if (!pool.length) return null;
    const sorted = pool.slice().sort((a, b) => (mem(a) - mem(b)) || (indexOf(a) - indexOf(b)));
    if (prof === 'browser') return sorted[0];
    if (prof === 'maximum') return sorted[sorted.length - 1];
    return sorted[Math.floor((sorted.length - 1) / 2)];   // desktop ≈ middle
  }

  // The resolution every pack relies on. Returns null when nothing for this
  // capability can run on this device (the pack then tries another path).
  function selected(cap) {
    const here = byCapability(cap);
    if (!here.length) return null;
    const prefId = preferred(cap);
    if (prefId) {
      const a = byId(prefId);
      if (a && a.manifest.capability === cap && canRun(a).ok) return a;
      // a stale/unusable preference falls through to the profile default
    }
    const runnable = here.filter(a => canRun(a).ok);
    return pickByProfile(runnable, profile());
  }

  // The common-case utility: pick, warm, run. Packs use this for the one-liner.
  async function runFor(cap, input, opts) {
    const a = selected(cap);
    if (!a) throw new Error('EOAdapters: no runnable adapter for capability "' + cap + '"');
    await a.load();
    return a.run(input, opts);
  }

  window.EOAdapters = {
    register,
    all, byId, byCapability, capabilities, ids,
    selected, runFor, canRun,
    profile, setProfile, preferred, setPreferred, PROFILES,
    hasWebGPU, hasWasm,
  };
})();
