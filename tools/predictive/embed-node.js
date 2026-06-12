/* ============================================================
   tools/predictive/embed-node.js — the browser's embedder, in Node.

   The measurement reads (read1/2/3) need the SAME reader the app uses:
   Xenova/all-MiniLM-L6-v2 at dtype q8, mean-pooled, L2-normalized —
   exactly what embed.js builds in the browser. This shim exposes the
   EOEmbed surface ({ ready, warm, embedQuery, embedSentences, MODEL })
   so it can be attached to the engine sandbox's `window` and so the
   tools can score cosine themselves.

   The model is vendored locally (never committed — .models/ is
   gitignored) because this environment cannot reach huggingface.co.
   Run `node tools/predictive/fetch-model.js` once to populate it from
   npm-registry tarballs that carry the identical ONNX files.

   Embeddings are quantities only. Nothing here routes or phrases.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const LOCAL = path.join(ROOT, '.models');

let extractor = null;

async function init() {
  if (extractor) return extractor;
  if (!fs.existsSync(path.join(LOCAL, MODEL, 'onnx', 'model_quantized.onnx')))
    throw new Error('local MiniLM not found — run `node tools/predictive/fetch-model.js` first');
  const t = require('@huggingface/transformers');
  t.env.localModelPath = LOCAL;
  t.env.allowRemoteModels = false;          // measurement must never reach the network
  extractor = await t.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  return extractor;
}

// Batch to keep peak memory flat on the long corpus docs.
const BATCH = 32;
async function embedSentences(sentences) {
  if (!extractor || !sentences || !sentences.length) return null;
  const rows = [];
  for (let i = 0; i < sentences.length; i += BATCH) {
    const out = await extractor(sentences.slice(i, i + BATCH).map(s => String(s == null ? '' : s)),
      { pooling: 'mean', normalize: true });
    for (const r of out.tolist()) rows.push(Float32Array.from(r));
  }
  return rows;
}
async function embedQuery(text) {
  const v = await embedSentences([String(text || '')]);
  return v && v[0] ? v[0] : null;
}

function cos(a, b) { let d = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) d += a[i] * b[i]; return d; }

/* The EOEmbed-shaped view, attachable to the engine sandbox's window so
   embedder-gated engine paths (docSentVectors, impressionQuery, …) run in
   Node exactly as they do in the browser once the model is resident. */
function asEOEmbed() {
  return {
    ready: () => !!extractor,
    warm: () => { /* init() is explicit in Node */ },
    embedQuery, embedSentences, MODEL,
  };
}

/* A tiny per-key vector cache for surface strings (entity names, verb
   phrases) so alignment scoring doesn't re-embed the same span. */
function makeCache() {
  const m = new Map();
  return async (text) => {
    const k = String(text == null ? '' : text).toLowerCase().trim();
    if (!k) return null;
    if (m.has(k)) return m.get(k);
    const v = await embedQuery(k);
    m.set(k, v);
    return v;
  };
}

module.exports = { init, embedSentences, embedQuery, cos, asEOEmbed, makeCache, MODEL, LOCAL };
