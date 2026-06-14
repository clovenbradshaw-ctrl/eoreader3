/* ============================================================
   ASR adapter — OpenAI Whisper (Xenova builds) via transformers.js.

   Registers three adapters sharing this file and runtime:
     • asr-whisper-tiny   → Xenova/whisper-tiny   (~75 MB)
     • asr-whisper-base   → Xenova/whisper-base   (~145 MB)
     • asr-whisper-small  → Xenova/whisper-small  (~480 MB, desktop-only: WebGPU)

   Capability "asr", modality "audio". Input is an AudioBuffer or a Float32Array
   of mono PCM at 16 kHz. One event per transcribed segment, region.kind
   "timerange", payload { text, language }.

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

  // AudioBuffer → Float32Array (channel 0); a Float32Array passes through.
  function toPCM(input) {
    if (!input) return input;
    if (typeof input.getChannelData === 'function') return input.getChannelData(0);
    return input;
  }

  function buildAdapter(spec) {
    const manifest = {
      id: spec.id,
      name: spec.name,
      version: '1.0.0',
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
      ],
      output: { event: 'one per segment', payload: '{ text: string, language: string }' },
      meta: { sampleRateHz: 16000, size: spec.size },
    };
    const ref = { id: manifest.id, version: manifest.version };

    let pipe = null, pipeP = null, _ready = false;
    async function load() {
      if (pipe) { _ready = true; return; }
      if (!pipeP) {
        pipeP = (async () => {
          const { pipeline } = await transformers();
          pipe = await pipeline('automatic-speech-recognition', spec.model);
          _ready = true;
          return pipe;
        })();
      }
      await pipeP;
    }
    const ready = () => _ready;

    async function run(input, opts) {
      await load();
      const audio = toPCM(input);
      let out;
      try {
        out = await pipe(audio, Object.assign({ return_timestamps: true, chunk_length_s: 30 }, opts || {}));
      } catch (e) {
        return [C.failureEvent(ref, 'whisper transcription failed: ' + (e && e.message), { recoverable: true })];
      }
      const lang = (out && out.language) || (opts && opts.language) || 'en';
      const chunks = (out && Array.isArray(out.chunks) && out.chunks.length)
        ? out.chunks
        : [{ timestamp: [0, null], text: (out && out.text) || '' }];
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
          meta: { from: lp != null ? 'avg_logprob' : 'presence' },
        });
      });
    }

    async function unload() { pipe = null; pipeP = null; _ready = false; }
    return { manifest, load, ready, run, unload };
  }

  window.EOAdapters.register(buildAdapter({ id: 'asr-whisper-tiny', name: 'Whisper tiny', model: 'Xenova/whisper-tiny', size: 'tiny', bytes: 75 * 1024 * 1024, backend: 'wasm', memMB: 90, latency: 1200 }));
  window.EOAdapters.register(buildAdapter({ id: 'asr-whisper-base', name: 'Whisper base', model: 'Xenova/whisper-base', size: 'base', bytes: 145 * 1024 * 1024, backend: 'wasm', memMB: 170, latency: 2200 }));
  // small is the desktop-only option: declared WebGPU so the picker disables it
  // where no GPU is present.
  window.EOAdapters.register(buildAdapter({ id: 'asr-whisper-small', name: 'Whisper small', model: 'Xenova/whisper-small', size: 'small', bytes: 480 * 1024 * 1024, backend: 'webgpu', memMB: 520, latency: 4000 }));
})();
