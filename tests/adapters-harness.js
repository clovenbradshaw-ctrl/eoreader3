/* ============================================================
   Shared loader for the adapter library, for Node-side tests and tooling.

   The adapter files are plain browser scripts (IIFEs publishing onto window,
   like engine.js / embed.js). We load them into a jsdom window the same way the
   browser would, then read the registry back out. Library loading (transformers
   /tesseract/pdf.js/tree-sitter) is never reached during registration; tests
   inject fakes via the `inject` hook before calling load()/run().
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

// Load order mirrors index.html: contract + registry first, then the impls.
const IMPLS = [
  'adapters/ocr/tesseract.js',
  'adapters/ocr/trocr.js',
  'adapters/asr/whisper.js',
  'adapters/parse/pdfjs.js',
  'adapters/parse/papaparse.js',
  'adapters/parse/treesitter.js',
  'adapters/layout/docling-lite.js',
  'adapters/embed/minilm.js',
  'adapters/embed/clip.js',
];

// adapter id → its manifest JSON file (the published, schema-validated artifact).
const MANIFEST_FILES = {
  'ocr-tesseract': 'adapters/ocr/manifest.tesseract.json',
  'ocr-trocr-printed': 'adapters/ocr/manifest.trocr.json',
  'ocr-trocr-handwritten': 'adapters/ocr/manifest.trocr-handwritten.json',
  'asr-whisper-tiny': 'adapters/asr/manifest.whisper-tiny.json',
  'asr-whisper-base': 'adapters/asr/manifest.whisper-base.json',
  'asr-whisper-small': 'adapters/asr/manifest.whisper-small.json',
  'pdf-text-pdfjs': 'adapters/parse/manifest.pdfjs.json',
  'csv-parse-papaparse': 'adapters/parse/manifest.papaparse.json',
  'code-ast-treesitter': 'adapters/parse/manifest.treesitter.json',
  'doc-layout-docling-lite': 'adapters/layout/manifest.docling-lite.json',
  'text-embed-minilm': 'adapters/embed/manifest.minilm.json',
  'image-text-embed-clip': 'adapters/embed/manifest.clip.json',
};

function loadAdapters(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://cleo.test/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const win = dom.window;
  // A browser has WebAssembly; jsdom's window may not expose it. Mirror it so
  // the registry's backend probe behaves as it would in a real browser.
  if (typeof win.WebAssembly === 'undefined' && typeof WebAssembly !== 'undefined') win.WebAssembly = WebAssembly;
  if (typeof opts.inject === 'function') opts.inject(win);
  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  load('adapters/contract.js');
  load('adapters/registry.js');
  IMPLS.forEach(load);
  return { dom, window: win, EOAdapters: win.EOAdapters, EOAdapterContract: win.EOAdapterContract, ROOT };
}

module.exports = { loadAdapters, IMPLS, MANIFEST_FILES, ROOT };
