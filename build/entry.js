/* Production bundle entry. Mirrors index.html's script order, but compiled and
   bundled by esbuild so the browser downloads no Babel compiler and transpiles
   nothing at runtime. llm.js is intentionally NOT bundled — it dynamic-imports
   WebLLM from a CDN on demand — so dist/index.html loads it as a plain script. */
import './globals.js';
import '../engine.js';
import '../store.js';
import '../data.jsx';
import '../pivot.jsx';
import '../icons.jsx';
import '../sidebar.jsx';
import '../chat.jsx';
import '../docview.jsx';
import '../rulesets.jsx';
import '../app.jsx';
