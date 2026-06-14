/* ============================================================
   Optional production build (§2).

   The app ships as a no-build static site (index.html) for hackability —
   but that ships React's dev build and the full Babel compiler to every
   visitor and transpiles eight JSX files in the browser on each load.

   This step removes all of that: esbuild precompiles the JSX and bundles
   React + ReactDOM + compromise + the engine + the UI into one minified,
   production (NODE_ENV=production) file. The only things left on a CDN are
   the web fonts and the on-demand model weights.

       npm run build      →  ./dist  (open dist/index.html or serve it)

   The dev flow (python3 -m http.server on the repo root) is untouched.
   ============================================================ */
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
mkdirSync(DIST, { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(ROOT, 'build', 'entry.js')],
  bundle: true,
  // mathjs is loaded as a plain CDN script (window.math); compute.js resolves it
  // from there in the browser and only falls back to require('mathjs') in Node
  // (tests). Mark it external so esbuild leaves that require alone instead of
  // pulling the whole package into the bundle.
  external: ['mathjs'],
  outfile: join(DIST, 'app.bundle.js'),
  format: 'iife',
  minify: true,
  sourcemap: true,
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  loader: { '.jsx': 'jsx', '.js': 'js' },
  define: { 'process.env.NODE_ENV': '"production"' },
  target: ['es2019'],
  logLevel: 'info',
  metafile: true,
});

// llm.js stays a separate plain script (dynamic CDN import of WebLLM); styles
// are copied verbatim.
copyFileSync(join(ROOT, 'llm.js'), join(DIST, 'llm.js'));
copyFileSync(join(ROOT, 'embed.js'), join(DIST, 'embed.js'));
// shape.js is a plain script too (it imports nothing — generation and embedding
// are injected); the exemplar library it scores against rides alongside.
copyFileSync(join(ROOT, 'shape.js'), join(DIST, 'shape.js'));
copyFileSync(join(ROOT, 'exemplars.jsonl'), join(DIST, 'exemplars.jsonl'));
// the form-genres library rides alongside the voice library, scored separately.
copyFileSync(join(ROOT, 'form-genres.jsonl'), join(DIST, 'form-genres.jsonl'));
copyFileSync(join(ROOT, 'styles.css'), join(DIST, 'styles.css'));
// the adapter library stays plain scripts too (each dynamic-imports its model
// runtime from a CDN on demand), so it is copied verbatim rather than bundled.
cpSync(join(ROOT, 'adapters'), join(DIST, 'adapters'), { recursive: true });
// the perceptual-ingest bridge is a plain script (pure, no imports) — copied too.
copyFileSync(join(ROOT, 'ingest-adapters.js'), join(DIST, 'ingest-adapters.js'));

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cleo</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="styles.css" />
<!-- Theme before first paint (mirrors index.html); kept in sync by settings.jsx. -->
<script>
  (function () {
    try {
      var p = JSON.parse(localStorage.getItem('cleo.prefs') || '{}') || {};
      var t = p.theme || 'system';
      var dark = t === 'dark' || (t !== 'light' && window.matchMedia
        && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      if (p.reduceMotion) document.documentElement.classList.add('reduce-motion');
    } catch (e) {}
  })();
</script>
</head>
<body>
<div id="root"></div>
<!-- optional local model (dynamic-imports WebLLM from a CDN on demand) -->
<script src="llm.js"></script>
<script src="embed.js"></script>
<!-- the adapter library (window.EOAdapters) — plain scripts, models load lazily -->
<script src="adapters/contract.js"></script>
<script src="adapters/registry.js"></script>
<script src="adapters/ocr/tesseract.js"></script>
<script src="adapters/ocr/trocr.js"></script>
<script src="adapters/asr/whisper.js"></script>
<script src="adapters/parse/pdfjs.js"></script>
<script src="adapters/parse/papaparse.js"></script>
<script src="adapters/parse/treesitter.js"></script>
<script src="adapters/layout/docling-lite.js"></script>
<script src="adapters/embed/minilm.js"></script>
<script src="adapters/embed/clip.js"></script>
<!-- the perceptual-ingest bridge (window.EOIngestAdapters) — plain script -->
<script src="ingest-adapters.js"></script>
<!-- the shape layer + its lazily-embedded exemplar library -->
<script src="shape.js"></script>
<script>
  (function () {
    let p = null;
    window.EOShapeLibrary = function () {
      if (p) return p;
      p = (async () => {
        try {
          if (!window.EOShape) return null;
          const res = await fetch('exemplars.jsonl');
          if (!res.ok) return null;
          const text = await res.text();
          const embed = (texts) => (window.EOEmbed && window.EOEmbed.embedSentences)
            ? window.EOEmbed.embedSentences(texts) : null;
          return await window.EOShape.load(text, embed);
        } catch (e) { return null; }
      })();
      return p;
    };
    let fp = null;
    window.EOFormLibrary = function () {
      if (fp) return fp;
      fp = (async () => {
        try {
          if (!window.EOShape) return null;
          const res = await fetch('form-genres.jsonl');
          if (!res.ok) return null;
          const text = await res.text();
          const embed = (texts) => (window.EOEmbed && window.EOEmbed.embedSentences)
            ? window.EOEmbed.embedSentences(texts) : null;
          return await window.EOShape.load(text, embed);
        } catch (e) { return null; }
      })();
      return fp;
    };
  })();
</script>
<!-- math.js (window.math) — the deterministic evaluator behind the chat's
     calculator; compute.js (bundled below) resolves it from here. -->
<script src="https://cdn.jsdelivr.net/npm/mathjs@13.2.3/lib/browser/math.js"></script>
<!-- everything else: React (production) + compromise + engine + UI, prebuilt -->
<script src="app.bundle.js"></script>
</body>
</html>
`;
writeFileSync(join(DIST, 'index.html'), HTML);

const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`\n✓ built → dist/  (${(bytes / 1024).toFixed(0)} KB; React/compromise/engine/UI bundled, no Babel-in-browser)`);
