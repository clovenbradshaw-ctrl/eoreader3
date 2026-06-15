/* ============================================================
   Tests for the device probe + auto model recommendation
   (llm.js → window.EOLLM.probeDevice / recommendModel).

   llm.js is a browser IIFE that publishes onto `window` and only imports the
   model runtimes from a CDN inside load()/phrase() — never from the probe or
   the recommender exercised here. So, like the other llm harnesses, we run it
   in a vm context with a fake `window`/`navigator` and read window.EOLLM back
   out. recommendModel takes an explicit { probe } and { models }, so the whole
   mapping (device profile → exact catalog key) is tested deterministically with
   no WebGPU and no network; a fake OPFS drives the cached-upgrade path.

   Run with `node tests/recommend.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// Build a fresh module per case so memoized state (the adapter probe) never
// leaks between tests. `extra` is merged onto the sandbox; `win` onto window.
function freshLLM(extra, win) {
  const window = Object.assign({}, win || {});
  const sandbox = Object.assign({
    window, console, performance, setTimeout, clearTimeout,
    TextEncoder, WebAssembly: global.WebAssembly,
    crypto: global.crypto || nodeCrypto.webcrypto,
  }, extra || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'llm.js'), 'utf8'), sandbox, { filename: 'llm.js' });
  if (!sandbox.window.EOLLM) throw new Error('llm.js did not publish window.EOLLM');
  return sandbox.window.EOLLM;
}

// The model catalog, mirroring data.jsx MODELS[].mlc (the keys the recommender
// returns). Only id + mlc + provider matter to recommendModel.
const CATALOG = [
  { id: 'qwen-05',   mlc: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC' },
  { id: 'qwen-15',   mlc: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' },
  { id: 'llama-1',   mlc: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' },
  { id: 'llama-3',   mlc: 'Llama-3.2-3B-Instruct-q4f16_1-MLC' },
  { id: 'qwen3-17',  mlc: 'Qwen3-1.7B-q4f16_1-MLC' },
  { id: 'mistral-7', mlc: 'Mistral-7B-Instruct-v0.3-q4f16_1-MLC' },
  { id: 'llama-8',   mlc: 'Llama-3.1-8B-Instruct-q4f16_1-MLC' },
  { id: 'cpu-smol-135', provider: 'wllama', mlc: 'wllama:smollm2-135m' },
  { id: 'cpu-smol-360', provider: 'wllama', mlc: 'wllama:smollm2-360m' },
  { id: 'cpu-qwen-05',  provider: 'wllama', mlc: 'wllama:qwen25-05b' },
  { id: 'cpu-llama-1',  provider: 'wllama', mlc: 'wllama:llama32-1b' },
  { id: 'cpu-llama-3',  provider: 'wllama', mlc: 'wllama:llama32-3b' },
  { id: 'claude-opus',   provider: 'anthropic', mlc: 'anthropic:claude-opus-4-8' },
  { id: 'claude-sonnet', provider: 'anthropic', mlc: 'anthropic:claude-sonnet-4-6' },
  { id: 'claude-haiku',  provider: 'anthropic', mlc: 'anthropic:claude-haiku-4-5' },
];

// A complete device profile with sane "nothing here" defaults, overridable per
// case. recommendModel reads exactly these fields.
function profile(over) {
  return Object.assign({
    webgpu: false, adapter: false, gpu: false, fallbackAdapter: false,
    maxBufferMB: 0, maxStorageMB: 0, gpuVendor: '', gpuArchitecture: '', gpuDescription: '',
    deviceMemoryGB: null, cores: null, mobile: false, wasm: false, anthropicKey: false,
  }, over || {});
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

(async () => {
  const L = freshLLM();
  const rec = (probe, opts) => L.recommendModel(Object.assign({ probe: profile(probe), models: CATALOG }, opts || {}));

  await group('GPU tier — scales the pick to the device', async () => {
    const high = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 8, maxBufferMB: 2048, maxStorageMB: 2048, wasm: true });
    eq(high.path, 'gpu', 'capable GPU → gpu path');
    eq(high.tier, 'high', '8 GB RAM + healthy budget → high tier');
    eq(high.key, 'Llama-3.2-3B-Instruct-q4f16_1-MLC', 'high tier → the 3B sweet spot (never auto 7-8B)');
    ok(typeof high.reason === 'string' && high.reason.length > 0, 'a human reason rides along');

    const mid = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 4, maxBufferMB: 1024, maxStorageMB: 1024, wasm: true });
    eq(mid.tier, 'mid', '4 GB RAM → mid tier');
    eq(mid.key, 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 'mid tier → 1B');

    const low = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 2, maxBufferMB: 512, maxStorageMB: 512, wasm: true });
    eq(low.tier, 'low', '2 GB RAM → low tier');
    eq(low.key, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'low tier → 0.5B');

    const phone = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 8, maxBufferMB: 2048, maxStorageMB: 2048, mobile: true, wasm: true });
    eq(phone.tier, 'low', 'mobile GPU is capped at low regardless of RAM');
    eq(phone.key, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'mobile GPU → 0.5B');
  });

  await group('GPU tier — RAM unknown (Safari/Firefox): lean on the GPU budget', async () => {
    const big = await rec({ webgpu: true, gpu: true, deviceMemoryGB: null, maxBufferMB: 2048, maxStorageMB: 2048, wasm: true });
    eq(big.tier, 'high', 'no RAM signal + ≥1 GB GPU budget → high');
    eq(big.key, 'Llama-3.2-3B-Instruct-q4f16_1-MLC', 'high → 3B');

    const constrained = await rec({ webgpu: true, gpu: true, deviceMemoryGB: null, maxBufferMB: 256, maxStorageMB: 128, wasm: true });
    eq(constrained.tier, 'low', 'a storage-binding limit at the spec floor → low');
    eq(constrained.key, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'constrained adapter → 0.5B');
  });

  await group('GPU tier — a weak GPU beside lots of RAM is NOT promoted', async () => {
    // The regression guard. deviceMemory is SYSTEM RAM (Chrome caps it at 8), so
    // a weak integrated GPU reads as "8 GB" too. The pick must follow the GPU
    // buffer budget, not the RAM — else nearly every Chrome desktop got handed
    // the 3B/~2.3 GB model and a modest GPU spent first load stalling on a
    // multi-GB download it couldn't compile ("way slower, never ready").
    const weak = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 8, maxBufferMB: 256, maxStorageMB: 128, wasm: true });
    eq(weak.tier, 'low', '8 GB RAM but a 128 MB storage-binding floor → low (not high)');
    eq(weak.key, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'weak GPU → the light 0.5B, never the 3B');

    const modest = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 8, maxBufferMB: 768, maxStorageMB: 768, wasm: true });
    eq(modest.tier, 'mid', '8 GB RAM + a midrange GPU budget → mid (not high)');
    eq(modest.key, 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 'modest GPU → 1B, not 3B');

    const noLimits = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 8, maxBufferMB: 0, maxStorageMB: 0, wasm: true });
    eq(noLimits.tier, 'low', 'no GPU budget signal → low (size down, never assume capable)');

    // A genuinely capable GPU is still picked high — the budget earns it, the
    // RAM reading no longer hands it out for free.
    const capable = await rec({ webgpu: true, gpu: true, deviceMemoryGB: 8, maxBufferMB: 4096, maxStorageMB: 2048, wasm: true });
    eq(capable.tier, 'high', 'a healthy GPU budget still earns high');
    eq(capable.key, 'Llama-3.2-3B-Instruct-q4f16_1-MLC', 'capable GPU → the 3B sweet spot');
  });

  await group('Software (fallback) adapter is treated as no real GPU', async () => {
    const fb = await rec({ webgpu: true, gpu: false, fallbackAdapter: true, wasm: true, cores: 8, deviceMemoryGB: 8 });
    eq(fb.path, 'cpu', 'fallback adapter → CPU path');
    eq(fb.key, 'wllama:llama32-1b', 'strong CPU still picked underneath a software adapter');
    ok(/gpu acceleration/i.test(fb.reason), 'reason names the missing hardware GPU');
  });

  await group('CPU tier — no WebGPU, scaled by cores + RAM', async () => {
    const high = await rec({ webgpu: false, wasm: true, cores: 8, deviceMemoryGB: 8 });
    eq(high.path, 'cpu', 'no WebGPU → cpu path');
    eq(high.tier, 'high', '8 cores + 8 GB → high');
    eq(high.key, 'wllama:llama32-1b', 'high CPU → 1B');

    const mid = await rec({ webgpu: false, wasm: true, cores: 4, deviceMemoryGB: 4 });
    eq(mid.tier, 'mid', '4 cores + 4 GB → mid');
    eq(mid.key, 'wllama:qwen25-05b', 'mid CPU → 0.5B');

    const low = await rec({ webgpu: false, wasm: true, cores: 2, deviceMemoryGB: 2 });
    eq(low.tier, 'low', '2 cores + 2 GB → low');
    eq(low.key, 'wllama:smollm2-360m', 'low CPU → 360M');

    const phone = await rec({ webgpu: false, wasm: true, cores: 8, deviceMemoryGB: 8, mobile: true });
    eq(phone.tier, 'tiny', 'mobile CPU → tiny');
    eq(phone.key, 'wllama:smollm2-135m', 'mobile CPU → 135M (tiny download)');
  });

  await group('No local backend — Claude when keyed, else the CPU fallback', async () => {
    const cloud = await rec({ webgpu: false, wasm: false, anthropicKey: true });
    eq(cloud.path, 'cloud', 'no GPU/WASM but a key → cloud path');
    eq(cloud.key, 'anthropic:claude-haiku-4-5', 'cloud → Haiku (fast & low-cost)');

    const none = await rec({ webgpu: false, wasm: false, anthropicKey: false });
    eq(none.key, 'wllama:smollm2-135m', 'nothing runnable → hand back the CPU fallback key');
  });

  await group('Catalog filtering — a missing ladder entry falls through', async () => {
    const trimmed = CATALOG.filter(m => m.mlc !== 'Llama-3.2-3B-Instruct-q4f16_1-MLC');
    const r = await L.recommendModel({ probe: profile({ webgpu: true, gpu: true, deviceMemoryGB: 8, maxBufferMB: 2048, maxStorageMB: 2048, wasm: true }), models: trimmed });
    eq(r.key, 'Qwen3-1.7B-q4f16_1-MLC', 'no 3B in the catalog → next rung of the high ladder');
  });

  await group('preferCached — an already-downloaded, better model wins (instant)', async () => {
    // A fake OPFS where every getFileHandle resolves ⇒ every wllama model reads
    // as cached. The upgrade pass should then prefer the strongest same-path
    // model at or above the recommended one — never a downgrade.
    const navigator = { storage: { getDirectory: async () => ({ getFileHandle: async () => ({}) }) } };
    const Lc = freshLLM({ navigator });
    const probe = profile({ webgpu: false, wasm: true, cores: 8, deviceMemoryGB: 8 });   // → recommends 1B

    const up = await Lc.recommendModel({ probe, models: CATALOG, preferCached: true });
    eq(up.key, 'wllama:llama32-3b', 'a cached, stronger CPU model is preferred');
    ok(/already downloaded|instantly/i.test(up.reason), 'reason explains it was already on disk');

    const off = await Lc.recommendModel({ probe, models: CATALOG, preferCached: false });
    eq(off.key, 'wllama:llama32-1b', 'preferCached:false sticks to the fresh tier pick');

    // With no stronger model in the catalog, the cached tiny ones must NOT pull
    // the pick down — the score gate blocks every downgrade.
    const noBetter = CATALOG.filter(m => m.mlc !== 'wllama:llama32-3b');
    const stay = await Lc.recommendModel({ probe, models: noBetter, preferCached: true });
    eq(stay.key, 'wllama:llama32-1b', 'cached smaller models never downgrade the pick');
    ok(!/already downloaded/i.test(stay.reason), 'no upgrade ⇒ the tier reason stands');
  });

  await group('probeDevice — overrides and the mobile flag', async () => {
    const inj = { webgpu: true, gpu: true, deviceMemoryGB: 16, mobile: false, wasm: true };
    const Lo = freshLLM({}, { EO_PROBE_OVERRIDE: inj });
    const p = await Lo.probeDevice();
    eq(p, inj, 'EO_PROBE_OVERRIDE short-circuits the probe');

    // No navigator.gpu ⇒ webgpu false; EO_DEVICE_MOBILE forces the mobile flag.
    const Lm = freshLLM({ navigator: {} }, { EO_DEVICE_MOBILE: true });
    const pm = await Lm.probeDevice();
    eq(pm.webgpu, false, 'no navigator.gpu → webgpu false');
    eq(pm.gpu, false, 'no adapter → not a usable GPU');
    eq(pm.mobile, true, 'EO_DEVICE_MOBILE forces mobile:true');
    // A full no-backend profile still recommends a coherent fallback.
    const rm = await Lm.recommendModel({ models: CATALOG });
    ok(!!rm.key, 'recommendModel always resolves to some key');
  });

  await group('Empty catalog — null key, never a throw', async () => {
    const r = await L.recommendModel({ probe: profile({ webgpu: true, gpu: true, deviceMemoryGB: 8 }), models: [] });
    eq(r.key, null, 'no catalog → null key (caller keeps its default)');
  });

  await group('primePump — exposed, safe off-DOM, every backend', async () => {
    ok(typeof L.primePump === 'function', 'primePump is exposed on EOLLM');
    // This harness runs with no `document`, so priming is a pure no-op here — it
    // must not throw for any backend key, nor for the keyless boot prime.
    let threw = false;
    try {
      L.primePump('Llama-3.2-3B-Instruct-q4f16_1-MLC');
      L.primePump('wllama:smollm2-135m');
      L.primePump('anthropic:claude-haiku-4-5');
      L.primePump();
    } catch (_) { threw = true; }
    ok(!threw, 'primePump never throws (no-op without a document)');
  });

  await group('self-host (zip) — config, gating, and entry mapping', async () => {
    const Ls = freshLLM({}, { EO_WEBLLM_SELFHOST: { 'Llama-3.2-3B-Instruct-q4f16_1-MLC': 'https://b/x.zip' } });
    eq(Ls.selfHostZipUrl('Llama-3.2-3B-Instruct-q4f16_1-MLC'), 'https://b/x.zip', 'reads the configured zip URL');
    eq(Ls.selfHostZipUrl('Qwen3-1.7B-q4f16_1-MLC'), null, 'an unconfigured model has no self-host URL');
    // No document/caches/serviceWorker in this harness ⇒ unsupported ⇒ gated OFF
    // even when configured, so the normal load runs (never a half-built zip path).
    eq(Ls.isSelfHosted('Llama-3.2-3B-Instruct-q4f16_1-MLC'), false, 'gated off where the browser features are absent');
    const Lw = freshLLM({}, { EO_WEBLLM_SELFHOST: { 'wllama:llama32-3b': 'https://b/x.zip' } });
    eq(Lw.isSelfHosted('wllama:llama32-3b'), false, 'CPU/wllama keys are out of scope for the WebLLM zip path');

    // The built-in mirror ships ON by default (our Google Cloud bucket, for the
    // desktop-default Llama 3.2 3B) with NO window config — so a slow/stalled
    // load has a single-stream fallback out of the box.
    const Ld = freshLLM({});
    ok(/^https:\/\/storage\.googleapis\.com\/.*Llama-3\.2-3B.*\.zip$/.test(Ld.selfHostZipUrl('Llama-3.2-3B-Instruct-q4f16_1-MLC') || ''),
      'the built-in Google mirror is configured by default (no window config needed)');
    eq(Ld.selfHostZipUrl('Qwen3-1.7B-q4f16_1-MLC'), null, 'a model with no built-in mirror still has none');
    // An explicit empty map is the off switch.
    const Loff = freshLLM({}, { EO_WEBLLM_SELFHOST: {} });
    eq(Loff.selfHostZipUrl('Llama-3.2-3B-Instruct-q4f16_1-MLC'), null, 'window.EO_WEBLLM_SELFHOST = {} turns the mirror off');

    // Entry → the flat filename WebLLM requests at the base: basename, wrapper
    // folder stripped, directory + degenerate names dropped.
    eq(L.selfHostEntryName('params_shard_0.bin'), 'params_shard_0.bin', 'flat name kept');
    eq(L.selfHostEntryName('Llama-3.2-3B-Instruct-q4f16_1-MLC/ndarray-cache.json'), 'ndarray-cache.json', 'wrapper folder stripped');
    eq(L.selfHostEntryName('a/b/tokenizer.json'), 'tokenizer.json', 'nested path → basename');
    eq(L.selfHostEntryName('model/'), null, 'directory entry dropped');
    eq(L.selfHostEntryName('weird/..'), null, 'a ".." basename is rejected');
    eq(L.selfHostEntryName(''), null, 'empty rejected');
  });

  console.log(`\nrecommend.test: ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of fails) console.error('   - ' + f); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exitCode = 1; });
