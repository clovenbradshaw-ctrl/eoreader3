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
- **`audit.js`** — the audit recorder (`window.EOAudit`). Records each chat
  turn's pipeline step by step and exports it as JSONL. In-memory; deterministic;
  no model involved.
- **UI** (`app.jsx`, `chat.jsx`, `docview.jsx`, `sidebar.jsx`, `rulesets.jsx`,
  `auditview.jsx`, `icons.jsx`) — React via in-browser Babel; `styles.css` for
  the look.
- **`data.jsx`** — example documents, model list, and the reading rulesets.
- **`store.js`** — local persistence (IndexedDB for docs/chat, localStorage for
  prefs/rules and the learned rules-ledger delta).

### Chat behaviour

By default Cleon just talks with you — multi-turn, with the conversation passed
to the model intact. It only pulls in document context when you're actually
referencing the loaded document (asking what it says, who's in it, summarizing
it, naming something from it). That keeps ordinary conversation simple while
document questions stay grounded and cited.

Prior turns re-enter the model's history with **epistemic tags**: a reply that
was vetoed, went out ungrounded, or carried struck (unverified) terms is
prefixed with a note saying so, so the model never defends an earlier answer
the system itself didn't stand behind.

### Transcripts

A transcript declares itself through its own typography — timecode lines
(`0:00:14.240,0:00:16.560`, SRT/WebVTT cues, `[00:14]`) and `Speaker N:` /
`NAME:` turn labels — and the reader adapts the same way it does for Spanish
or Chinese. Timecodes become structure (turn boundaries), never sentence
content; speaker labels become attribution (each turn's sentences land on
their voice through the same SIG events quoted speech earns). A council
meeting reads as voices and turns — who spoke, how much, about whom — rather
than a soup of stray capitals and timestamps.

### Thinking depth

The composer's effort dial (1–3) buys *graph* work, not just more retrieval.
Above the floor, a factual turn **walks the document graph** out from the
entities the question names — the page's recorded assertions (DEF events), its
drawn relations, co-occurrence — and the prompt opens with that reading before
the verbatim passages. At the deepest stop a **propositional veto** audits the
draft against the page's own assertions: a draft that denies what the page
asserts ("X was not Y" while the graph holds *X is Y*) binds cleanly at the
string layer and is caught only here, claim against claim. Depth 1 is the
parity floor — byte-identical to the reflex pipeline.

### Auditing the chat

Because the intelligence is mechanical, every chat turn is a sequence of
explicit decisions — and the **Audit** drawer (the topbar button) is a glass box
over them. For each turn it records, step by step:

- **route** — did the turn reference a source in scope, and why; which path it
  took (grounded-LLM, mechanical, plain chat, creative);
- **intent / ground / referents** — `who` vs `summary` vs `factual`, whether the
  page can answer, and the matter / anti-matter (void) referents the question
  names;
- **retrieve** — the passages actually retrieved, each with its relevance score
  (deeper turns add numbered *seek* rounds, with unseekable query terms named);
- **traverse** — the graph walk (depth > 1): entry nodes, the assertions and
  relations held along the walk, and the evidence sentences it gathered;
- **llm** — the *exact* prompt the model saw (system + assembled history +
  passages), its parameters, and the raw text it streamed back, verbatim;
- **veto** — the mechanical check: any invented terms, whether the phrasing
  re-bound to the page, whether the draft contradicts a recorded assertion
  (deepest depth), and whether the model's draft or the mechanical answer
  won;
- **answer** — the final text, citations, and the grounded / coverage / stable
  audit it ended on.

Recording is on by default and in-memory (a capped ring buffer); the durable
artifact is the **Export JSONL** button — one self-contained turn per line
(schema `cleon-audit/1`), ready for `jq`/grep or a notebook. Copy and Clear sit
beside it, and recording can be paused. This is the tool for the question "why
did it answer that?" — when a `summarize` returns raw opening lines, or a
retrieval grabs page chrome, the trace shows exactly where.

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
