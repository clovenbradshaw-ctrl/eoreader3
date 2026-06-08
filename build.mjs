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
import { mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
mkdirSync(DIST, { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(ROOT, 'build', 'entry.js')],
  bundle: true,
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
copyFileSync(join(ROOT, 'styles.css'), join(DIST, 'styles.css'));

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cleon</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="styles.css" />
</head>
<body>
<div id="root"></div>
<!-- optional local model (dynamic-imports WebLLM from a CDN on demand) -->
<script src="llm.js"></script>
<script src="embed.js"></script>
<!-- everything else: React (production) + compromise + engine + UI, prebuilt -->
<script src="app.bundle.js"></script>
</body>
</html>
`;
writeFileSync(join(DIST, 'index.html'), HTML);

const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`\n✓ built → dist/  (${(bytes / 1024).toFixed(0)} KB; React/compromise/engine/UI bundled, no Babel-in-browser)`);
