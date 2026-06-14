/* ============================================================
   ASR adapter — OpenAI Whisper (Xenova builds) via transformers.js.

   Registers three adapters sharing this file and runtime:
     • asr-whisper-tiny   → Xenova/whisper-tiny   (~75 MB)
     • asr-whisper-base   → Xenova/whisper-base   (~145 MB)
     • asr-whisper-small  → Xenova/whisper-small  (~480 MB, desktop-only: WebGPU)

   Capability "asr", modality "audio". Input is an AudioBuffer, a Float32Array of
   mono PCM at 16 kHz, or an encoded clip (Blob / File / ArrayBuffer / byte view).
   One event per transcribed segment, region.kind "timerange", payload
   { text, language }.

   BEST-IN-BROWSER EXECUTION. Two things decide transcription quality in the
   browser, and both are handled here rather than left to defaults:

     1. DEVICE + PRECISION. When a GPU is present we run on WebGPU at fp16 —
        close to the native model's word-error rate and roughly an order of
        magnitude faster than wasm. With no GPU we run on wasm at int8 (q8), the
        only practical CPU path; int8 has higher WER, which the manifest is
        honest about. If WebGPU is present but fails to initialize we fall back
        to wasm once. The chosen device/precision rides on every event's meta,
        so the audit shows how a segment was actually produced.

     2. SAMPLE RATE. Whisper wants 16 kHz mono. Browser-decoded audio is almost
        always 44.1/48 kHz and often stereo; fed raw, Whisper transcribes
        time-warped nonsense. Every non-PCM input is downmixed and resampled to
        16 kHz (OfflineAudioContext, with a dependency-free linear fallback)
        before it reaches the model. A Float32Array is taken as already-16 kHz
        mono — the contract's fast path.

   CONFIDENCE: Whisper exposes no calibrated confidence. When the runtime
   surfaces a per-segment avg_logprob we derive confidence = exp(avg_logprob)
   (a probability-shaped heuristic); otherwise we emit a presence flag (1 when
   the segment carried text). Either way the manifest declares it "heuristic" —
   never read as calibrated. (Spec: confidence honesty is load-bearing.)
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const TRANSFORMERS_URL = 'https://esm.run/@huggingface/transformers@3.0.2';
  let modP = null;
  async function transformers() {
    if (window.EO_TRANSFORMERS) return window.EO_TRANSFORMERS;
    if (!modP) modP = import(TRANSFORMERS_URL);
    return modP;
  }

  const TARGET_SR = 16000;
  const hasWebGPU = () => typeof navigator !== 'undefined' && !!navigator.gpu;

  // The execution plan. WebGPU/fp16 where a GPU exists (small is GPU-only by
  // manifest, so it always takes this path); wasm/int8 otherwise.
  function planFor(spec) {
    if (spec.backend === 'webgpu' || hasWebGPU()) return { device: 'webgpu', dtype: 'fp16' };
    return { device: 'wasm', dtype: 'q8' };
  }

  // ---- audio normalization → mono Float32Array at 16 kHz ---------------------
  const kindOf = (x) => Object.prototype.toString.call(x);
  function audioCtor(which) {
    const g = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : {});
    return which === 'offline'
      ? (g.OfflineAudioContext || g.webkitOfflineAudioContext || null)
      : (g.AudioContext || g.webkitAudioContext || null);
  }

  async function toMono16k(input) {
    if (input == null) return input;
    const t = kindOf(input);
    if (t === '[object Float32Array]') return input;                 // already 16 kHz mono PCM
    if (t === '[object Float64Array]') return Float32Array.from(input);
    if (typeof input.getChannelData === 'function') return resampleMono16k(input);   // AudioBuffer
    return resampleMono16k(await decodeAudio(input));               // encoded clip → decode → resample
  }

  async function decodeAudio(input) {
    const AC = audioCtor('online');
    if (!AC) throw new Error('Web Audio API unavailable — pass a 16 kHz mono Float32Array');
    let ab;
    if (input instanceof ArrayBuffer) ab = input;
    else if (typeof input.arrayBuffer === 'function') ab = await input.arrayBuffer();        // Blob / File
    else if (ArrayBuffer.isView(input)) ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    else throw new Error('unsupported audio input');
    const ctx = new AC();
    try { return await ctx.decodeAudioData(ab.slice(0)); }
    finally { try { ctx.close(); } catch (_) {} }
  }

  async function resampleMono16k(buf) {
    const chans = buf.numberOfChannels || 1;
    if (buf.sampleRate === TARGET_SR && chans === 1) return buf.getChannelData(0);
    const OAC = audioCtor('offline');
    if (OAC) {
      const frames = Math.max(1, Math.ceil(buf.duration * TARGET_SR));
      const oac = new OAC(1, frames, TARGET_SR);                 // 1-channel destination = downmix to mono
      const src = oac.createBufferSource();
      src.buffer = buf; src.connect(oac.destination); src.start(0);
      return (await oac.startRendering()).getChannelData(0);
    }
    return linearMono16k(buf);                                   // last resort if OfflineAudioContext is missing
  }

  // Dependency-free degrade: average channels, then linear-interpolate to 16 kHz.
  function linearMono16k(buf) {
    const chans = buf.numberOfChannels || 1, n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < chans; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chans; }
    const ratio = TARGET_SR / buf.sampleRate;
    const outLen = Math.max(1, Math.round(n * ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i / ratio, i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), f = x - i0;
      out[i] = mono[i0] * (1 - f) + mono[i1] * f;
    }
    return out;
  }

  function buildAdapter(spec) {
    const manifest = {
      id: spec.id,
      name: spec.name,
      version: '1.1.0',
      category: 'perceptual',
      modality: 'audio',
      capability: 'asr',
      modelRef: { runtime: 'transformersjs', model: spec.model, version: '3.0.2', weightsBytes: spec.bytes },
      resources: { backend: spec.backend, memMB: spec.memMB, expectedLatencyMs: spec.latency },
      confidenceSemantics: 'heuristic',
      failureModes: [
        'no calibrated confidence — derived from avg_logprob when present, else a presence flag',
        'language auto-detect can be wrong on short or noisy clips',
        'weights fail to download / backend unavailable (reported as a failure event)',
        'audio is resampled to 16 kHz mono in-browser; an unsupported container can fail to decode (reported as a failure event)',
        'WebGPU (fp16) is preferred when present and falls back to wasm (int8) if it cannot initialize — int8 has higher WER',
      ],
      output: { event: 'one per segment', payload: '{ text: string, language: string }' },
      meta: { sampleRateHz: 16000, size: spec.size, device: 'webgpu→wasm', dtype: 'fp16→q8' },
    };
    const ref = { id: manifest.id, version: manifest.version };

    let pipe = null, pipeP = null, _ready = false, _plan = null;
    async function load() {
      if (pipe) { _ready = true; return; }
      if (!pipeP) {
        pipeP = (async () => {
          const { pipeline } = await transformers();
          const want = planFor(spec);
          try {
            pipe = await pipeline('automatic-speech-recognition', spec.model, want);
            _plan = want;
          } catch (e) {
            // WebGPU can be present yet fail to acquire an adapter; drop to wasm once.
            if (want.device !== 'webgpu') throw e;
            const fb = { device: 'wasm', dtype: 'q8' };
            pipe = await pipeline('automatic-speech-recognition', spec.model, fb);
            _plan = fb;
          }
          _ready = true;
          return pipe;
        })();
      }
      await pipeP;
    }
    const ready = () => _ready;

    async function run(input, opts) {
      await load();
      let audio;
      try { audio = await toMono16k(input); }
      catch (e) { return [C.failureEvent(ref, 'audio decode/resample failed: ' + (e && e.message), { recoverable: false })]; }
      let out;
      try {
        // chunk_length_s/stride_length_s drive Whisper's long-form path (overlap
        // de-duplicated by the runtime); language/task pass through from opts.
        out = await pipe(audio, Object.assign({ return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 }, opts || {}));
      } catch (e) {
        return [C.failureEvent(ref, 'whisper transcription failed: ' + (e && e.message), { recoverable: true })];
      }
      const lang = (out && out.language) || (opts && opts.language) || 'en';
      const chunks = (out && Array.isArray(out.chunks) && out.chunks.length)
        ? out.chunks
        : [{ timestamp: [0, null], text: (out && out.text) || '' }];
      const device = (_plan && _plan.device) || 'wasm', dtype = (_plan && _plan.dtype) || 'q8';
      return chunks.map(ch => {
        const ts = ch.timestamp || [0, null];
        const text = String(ch.text == null ? '' : ch.text);
        // avg_logprob (if the runtime exposes it) → exp() is probability-shaped;
        // otherwise a presence flag. Declared heuristic either way.
        const lp = (typeof ch.avg_logprob === 'number') ? ch.avg_logprob
          : (typeof ch.confidence === 'number') ? Math.log(Math.max(1e-6, ch.confidence)) : null;
        const conf = lp != null ? Math.max(0, Math.min(1, Math.exp(lp))) : (text.trim() ? 1 : 0);
        return C.event({
          adapter: ref,
          region: { kind: 'timerange', start: ts[0] == null ? 0 : ts[0], end: ts[1] == null ? (ts[0] == null ? 0 : ts[0]) : ts[1] },
          confidence: conf,
          payload: { text, language: lang },
          meta: { from: lp != null ? 'avg_logprob' : 'presence', device, dtype },
        });
      });
    }

    async function unload() { pipe = null; pipeP = null; _ready = false; _plan = null; }
    return { manifest, load, ready, run, unload };
  }

  window.EOAdapters.register(buildAdapter({ id: 'asr-whisper-tiny', name: 'Whisper tiny', model: 'Xenova/whisper-tiny', size: 'tiny', bytes: 75 * 1024 * 1024, backend: 'wasm', memMB: 90, latency: 1200 }));
  window.EOAdapters.register(buildAdapter({ id: 'asr-whisper-base', name: 'Whisper base', model: 'Xenova/whisper-base', size: 'base', bytes: 145 * 1024 * 1024, backend: 'wasm', memMB: 170, latency: 2200 }));
  // small is the desktop-only option: declared WebGPU so the picker disables it
  // where no GPU is present.
  window.EOAdapters.register(buildAdapter({ id: 'asr-whisper-small', name: 'Whisper small', model: 'Xenova/whisper-small', size: 'small', bytes: 480 * 1024 * 1024, backend: 'webgpu', memMB: 520, latency: 4000 }));
})();
