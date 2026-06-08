# Cleon

A private, in-browser assistant for reading documents. Cleon is a ChatGPT-style
chat app with a twist: when you ask about a document you've loaded, its answers
are **grounded** — every claim is bound to the exact line it came from and
audited mechanically, not by the language model.

Everything runs locally. Documents never leave your browser, and the optional
language model runs on your own GPU via WebGPU.

## Running it

It's a static site — no build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

Open `index.html` through a server (not `file://`) so the engine and component
scripts load. A WebGPU-capable browser (Chrome/Edge 113+) is needed for the
local model; without one, grounded answers and pivots still work mechanically.

### Optional production build

The no-build flow ships React's dev build and the Babel compiler to the browser.
For a deploy, an optional esbuild step precompiles the JSX and bundles React +
compromise + the engine + the UI into one minified, production file (no
Babel-in-browser, no React/compromise CDN):

```sh
npm install        # dev deps incl. esbuild + react
npm run build      # → ./dist  (serve dist/index.html)
```

### Local storage & privacy

Documents, the running chat, rule toggles, and the engine's induced learning are
saved on the device (IndexedDB + localStorage), so a refresh keeps your
workspace — nothing is uploaded. Set `window.EO_DEBUG = true` in the console to
surface errors that resilience catches otherwise swallow.

## How it works

The intelligence is **mechanical**; the language model only phrases things.

- **`engine.js`** — the reading engine. Parses prose (sentence indexing, entity
  extraction) and tables, does retrieval, decides whether a message is about the
  open document (`referencesDoc`), binds `[sN]` citations, and computes the
  grounded / coverage / stable audit. Deterministic; no model involved.
- **`llm.js`** — optional local model (WebLLM / WebGPU, e.g. Qwen2.5). It holds
  the conversation and phrases answers. On a document question it's handed the
  retrieved passages and its output is checked and re-cited mechanically — it
  never writes its own citations and never overrides the page.
- **`pivot.jsx`** — deterministic pivot/fold over tables (totals, counts,
  grouping) driven by a small natural-language → spec parser.
- **UI** (`app.jsx`, `chat.jsx`, `docview.jsx`, `sidebar.jsx`, `rulesets.jsx`,
  `icons.jsx`) — React via in-browser Babel; `styles.css` for the look.
- **`data.jsx`** — example documents, model list, and the reading rulesets.
- **`store.js`** — local persistence (IndexedDB for docs/chat, localStorage for
  prefs/rules and the learned rules-ledger delta).

### Chat behaviour

By default Cleon just talks with you — multi-turn, with the conversation passed
to the model intact. It only pulls in document context when you're actually
referencing the loaded document (asking what it says, who's in it, summarizing
it, naming something from it). That keeps ordinary conversation simple while
document questions stay grounded and cited.

## Reading rules

The "reading rules" in the side panel are the toggleable parameters the engine
reads under (decay, inertia, anaphora handling, and so on). They can be turned
on/off, exported as JSON, and imported — parsing stores only invariants, and the
entity/prominence views are re-projected from the current rules without a
re-parse.

## Tests

The app needs no build, but the engine has a Node test harness (dev-only):

```sh
npm install      # pulls compromise, the engine's POS tagger
npm test         # behavioural suite + bit-exact golden parity
npm run bench    # per-turn timing of the mechanical pipeline
```

`tests/README.md` explains the harness. The suite pins the mechanical contract
(parse / retrieve / route / answer / void / fold / cite) and the parity check
guards it against drift, so engine changes can be proven behaviour-preserving.

## Design notes

`docs/operator-void.md` captures a planned next phase (distinguishing a missing
*operator*/shape from missing *content*) to build on top of the current engine.
