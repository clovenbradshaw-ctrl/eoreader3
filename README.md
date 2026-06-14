# Cleo

A private, in-browser assistant for reading documents. Cleo is a ChatGPT-style
chat app with a twist: when you ask about a document you've loaded, its answers
are **grounded** — every claim is bound to the exact line it came from and
audited mechanically, not by the language model.

Everything runs locally. Documents never leave your browser, and the optional
language model runs on your own device — on the GPU via WebGPU where it's
available, and otherwise on the CPU via WebAssembly (llama.cpp/wllama), so a
browser without WebGPU (Firefox/Safari today) still gets worded answers, not
just mechanical ones. A cloud option (the Claude API, with your own key) is
there too. The model only phrases; the grounding is mechanical either way.

## Running it

It's a static site — no build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

Open `index.html` through a server (not `file://`) so the engine and component
scripts load. A WebGPU-capable browser (Chrome/Edge 113+) runs the GPU models;
without WebGPU the app falls back to an on-device **CPU model** (llama.cpp via
WebAssembly) so answers are still phrased — and grounded answers and pivots work
mechanically regardless of any model.

The CPU model runs single-threaded out of the box. To unlock multi-threaded CPU
inference (faster), serve the app cross-origin-isolated — with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` headers. Without them it simply
stays single-thread; nothing breaks.

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
workspace — nothing is uploaded. The **selected model** is remembered too, and
the app re-loads it on startup once persistence has rehydrated, so a refresh
comes back to a loaded model rather than the default — and because the weights
are cached (WebLLM's cache / the CPU model's `useCache`), that re-load
re-downloads nothing. Set `window.EO_DEBUG = true` in the console to surface
errors that resilience catches otherwise swallow.

The one deliberate exception is the **reference desk / chat-with-Wikipedia**
(`external.js`): when you explicitly ask — by clicking an entity's desk, or by
toggling **Wikipedia** on in the chat composer — a *surface form* or a query
term (e.g. "Nashville Downtown Partnership" — never the document text) is sent
to Wikipedia and Wiktionary through the same proxy the app already uses for
conventions. With the toggle on, the fetched **article is ingested into the
graph** as a real, citable source and the grounded answer reads and cites it
(so you can chat with Wikipedia even with no document loaded). It is opt-in (a
remembered consent), rate-limited, prioritised, and gated against resolving
private individuals. Clear `window.EO_REFERENCE_PROXY` to disable it and keep
the reader strictly local. See `docs/external-reference-desk.md`.

A second, separate opt-in is **computational grounding** (`pyodide.js`,
`window.EOPython`): turned on in Settings, it lets Cleo run Python locally over
a loaded CSV to answer questions a prose reader structurally can't — sum a
column, count rows, group and sort. It is on by default and the runtime (loaded
from `cdn.jsdelivr.net`, the same CDN as the models) is fetched only on the
first actual run, never at page load. Python runs in a Web Worker with network
egress blocked, so executed code cannot reach the network and document content
never leaves the device on the local-model path. The model still only phrases:
mechanical execution produces the figure, and the exact code, its stdout, and
its result are deposited in the glass-box audit (a `compute` step) and shown on
the message. On the Claude API path the model sees only the table's **schema**
(column names, types, a few sample rows) and the `code` it writes; that code
runs locally over the whole file, so the full data is not sent — it travels
under the same consent as any other Claude turn, no wider.

## How it works

The intelligence is **mechanical**; the language model only phrases things.

- **`engine.js`** — the reading engine. Parses prose (sentence indexing, entity
  extraction) and tables, does retrieval, decides whether a message is about the
  open document (`referencesDoc`), binds `[sN]` citations, and computes the
  grounded / coverage / stable audit. Deterministic; no model involved.
- **`llm.js`** — the optional model layer, with three interchangeable backends
  behind one interface (`load`/`phrase`/`isLoaded`, routed by the model key):
  **WebLLM** on the GPU (WebGPU, e.g. Qwen2.5), an on-device **CPU** model
  (llama.cpp via WebAssembly / wllama, a `wllama:` key — GGUF weights pulled once
  from Hugging Face and cached), and **Claude** over the Anthropic API (an
  `anthropic:` key). The CPU model is also the automatic **fallback**: with no
  WebGPU it's the default local path, and if a GPU model's download stalls or
  fails the app switches to it so chat keeps getting phrased answers instead of
  dropping to mechanical-only (the runtime is pre-warmed in the background so the
  switch is quick). Whichever backend, it holds the conversation and phrases
  answers. On a document question it's handed the retrieved **spans** (verbatim
  sentences, trusted) and its own **notes** (the graph's reading — assertions,
  kin records, header metadata, working memory — "usually right, sometimes
  wrong"), preceded by a small **shape pass**: a director's-note call that
  characterizes what the turn wants before the answer pass writes. Reasoning-model
  `<think>` blocks are gated out of the stream and the answer (the audit keeps
  them verbatim). Output is checked and re-cited mechanically — the model never
  writes its own citations and never overrides the page.
- **`pivot.jsx`** — deterministic pivot/fold over tables (totals, counts,
  grouping) driven by a small natural-language → spec parser.
- **`tablequery.js`** — schema-aware table filtering (`window.EOTableQuery`).
  Reads the loaded table's **own** columns and distinct values to turn a plain
  question — "clients from Mexico" — into a real filter (`Country = Mexico`),
  matching values case- and accent-insensitively. When a value is ambiguous (it
  lives in several columns) it asks one short clarifying question and continues
  the **back-and-forth**; an auto-loaded small local model handles the harder
  intent and disambiguation, but only ever picks columns/values that exist —
  `foldPivot` still computes the count, so the number stays exact. The result
  can be expanded into a tab and **saved as a view** under the table.
- **`compute.js`** — the auditable calculator (`window.EOCompute`). When a turn
  is essentially a math expression ("15% of $240,000", "sqrt(144)+3^2"), math.js
  evaluates it deterministically (BigNumber precision, so money doesn't drift)
  and the model is bypassed entirely — the number you see is the engine's, never
  the model's mental arithmetic. Figures that also appear in an open source are
  bound to the exact line they came from, so the chat's **Show the math** panel
  lets you check each input (the one error an evaluator can't catch: right
  arithmetic over a wrong number). Non-math turns return null and fall through to
  ordinary routing. Deterministic; no model involved.
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

By default Cleo just talks with you — multi-turn, with the conversation passed
to the model intact. It only pulls in document context when you're actually
referencing the loaded document (asking what it says, who's in it, summarizing
it, naming something from it). That keeps ordinary conversation simple while
document questions stay grounded and cited.

Prior turns re-enter the model's history with **epistemic tags**: a reply that
was vetoed, went out ungrounded, or carried struck (unverified) terms is
prefixed with a note saying so, so the model never defends an earlier answer
the system itself didn't stand behind. A reply the user pushed back on gets
the same treatment — tagged *"the user said this reply missed their
question"* — so a rejected answer can't keep re-entering the prompt as
something that simply happened.

### The integral fold (what is this about, always answerable)

A model handed only the passages a question retrieved can answer that question
but not the prior one — *"what is this document about?"* — because no single
retrieval carries the whole. So every turn that touches the page also carries
the document's **integral fold**: a mechanical, cumulative condensation read
from the start up to a boundary, the way an integral accumulates as you move
along it. The fold of the *whole* document (boundary = the last sentence) is
the standing overview; it rides into the grounded prompt as the leading note
(*"What the document is about, your reading of the whole: …"*), so "what is this
about" is answerable on any turn, not just an explicit `summarize`.

The fold is the graph's own reading, scoped to a prefix and said in **prose** —
the heaviest figures the window turns on (with what the text takes them to be
folded into the same sentence), the arc across the chapters it crosses, and an
opening line to anchor the gist, joined into flowing sentences rather than a slot
template. No model touches it (`documentFold` / `documentFolds`, `prosifyFold`,
cached per rules-revision on the doc).

And it is **cumulative**, so a chapter scopes it: ask about Ch 1 and you get the
fold *up to the beginning of Ch 2* — the reading so far, with figures introduced
only in later chapters absent. A chapter reference is read mechanically
(`foldForQuery`): its own heading ("the Fountain") or an ordinal ("chapter 2",
"part three", "section IV") selects the section whose end boundary the fold runs
to. A turn with no chapter reference gets the integral fold of the whole.
Chapter boundaries are the same standalone-heading structure the rest of the
reader leverages — "structure is what folds leverage."

### The impression query (embedding as a fuzzy query into the graph)

The embedder isn't a tangent generator — it's **another way to query the graph**:
impressionistically, by *meaning* rather than by the words the question happened
to use. Seeded from the question's embedding, `impressionQuery` gathers the
sentences the page reads as related (cosine ≥ a floor) — the **relevant region** —
then does two things the lexical path can't:

- it hands the model the top related sentences **verbatim** (citable spans), and
- it folds the **whole region into one note** — the **integral of the relevant
  things**, not the raw lines. This reuses the same fold operator the integral
  fold uses (`foldOver`, which condenses *any* set of sentences, not just a
  `[0, hi)` prefix).

Before folding, the region **closes over the figures it touches** — a name the
impression surfaced pulls its other mentions into the set — so the integral
covers a figure's whole footprint, not just the sentences cosine happened to
rank. That closure is the self-re-prompting: an impression of a name re-queries
the graph for the rest of that name.

So the model receives the verbatim related spans *and* a synthesized note —
*"related by impression… gathered into one picture"* — that reads as the reader's
understanding of the relevant material, weighed as a note (usually right,
sometimes a tangent), not as quotation. It's lightweight: it fires only when the
embedder is already resident (the same MiniLM the rest of the app warms in the
background), reusing the cached sentence vectors, so it costs only the query
embedding, and it's recorded as its own `impression` audit step. With no embedder
it is a clean no-op (`impressionQuery` returns nothing and the lexical
spans/notes answer exactly as before — the parity floor holds).

### When you push back (conversational repair)

Not every turn is content. "you're not listening to what i'm saying",
"yeah it does", "no — the son of someone involved with NDP" are about the
**exchange**: the previous reply failed and the user is saying so. Fed to the
ordinary pipeline these go badly two different ways — retrieval drags the
complaint onto the page by token overlap and answers it with an unrelated
line, or the router finds no signal and a tiny model shrugs in plain chat.

So pushback is a first-class **route**, detected mechanically before any
lexical reader can claim the turn (frustration / contradiction / refinement —
a leading "no…" correction, or an insistence like "someone's son IS
mentioned"). A repair turn (1) tags the rejected reply in history, (2)
reconstructs the question actually under repair — the last user turn that
wasn't itself a repair move, plus every refinement deposited since — and
(3) re-reads *that*, not the complaint. And it never re-serves a rejected
reply verbatim: a re-read that re-derives the same **substantive, cited**
answer goes out flagged as re-confirmed ("I land in the same place — I do
think this is what the page holds"), while a re-read that only reproduces a
non-answer says it's stuck and asks for a hook, in different words each
time. The same guard runs on ordinary turns: an answer (near-)identical to
one already sent is flagged in the reply instead of repeated as if new.

### Whose son? (possessive kin)

"Until recently, his son served as Director of Administration…" holds WHOSE
son only through the pronoun — and a sentence retrieval hands to a small
model with "his" unresolved is an answer the model cannot give. The parse
now reads possessive kin ("his/her son/mother/wife…", narration only): the
possessor resolves under the same activation law every pronoun obeys —
locally first (a possessive determiner is a local anaphor: persons named in
the same or previous sentence), then page-wide, with the same δ-dominance
stall rights — and lands as a kin DEF in the graph. "Whose son is
mentioned?" is then answered mechanically, possessor named and cited; the
grounded prompt opens with the resolved record; and a question that aims the
kin at the *wrong* person ("Tom Turner's son") is corrected, not indulged —
"The page records no son for Tom Turner; the son it mentions is David
Corman's." Kin nouns are a language-module convention (`kin_terms` in
`memory/conventions.jsonl`), like every other lexical inventory.

### The two-pass answer (shape, then phrasing)

A grounded turn is two calls through the same resident model. First the
**shape pass**: a tiny call (≈90 tokens) that reads the question, the last
few turns, and the doc title — never the spans or notes, so it can't be
lured into answering — and writes a one-breath director's note: what the
user is actually after, what register fits, what a bad answer would look
like ("Bibliographic lookup. They want the name. One line, never 'the
author'…"). The answer pass sees the spans first as factual material and
the note last, as closing guidance about HOW to answer — labeled as such,
so the grounded prompt can name it ("an editor's note may also arrive…
treat it as guidance, not source material"). The reorder is a leak guard:
the note used to ride between the question and the spans, where a small
model read it as a synopsis and pre-framed the spans it hadn't reached yet;
spans-before-note inverts that, so even a note that mistakenly states facts
can't outweigh the spans below it. Spans are verbatim quotes to trust and
*use*, notes are the reader's own understanding, spans win conflicts, and
there are no hardcoded length prescriptions — the model answers as it sees
fit, bounded by `max_tokens`. The shape note is recorded as its own audit
step; a failed or empty shape pass degrades to the bare answer pass, and
with no model at all the mechanical paths answer as ever. Citations stay
mechanical throughout.

When the answer pass itself fails in an egregious way — the model declines
or comes back empty, parrots the director's note as if it were the answer,
or echoes a single passage even after a stricter retry — the turn now
**refuses** rather than substituting a mechanically-generated portrait. A
mechanical fallback in those cases would land as if the model had answered,
and the user reads the result as Cleo talking when in fact the draft was
rejected; refusing names the failure plainly ("I drafted, but the model
came back empty…") and emits an audit error step instead. The bind-failure
paths (unbound, contradicts-assertion, kin-subject-mismatch) keep their
mechanical fallback — those still have a grounded signal pointing at the
page, just not the one the model tried to draft.

Gutenberg-style header metadata (`Title:` / `Author:` / `Release date:`…)
is parsed mechanically, cached on the document, and joined to the notes
tier with cite tags — so "who wrote it?" reaches the model with the name in
hand instead of competing with content retrieval. On Gutenberg texts the
cast is also cleaned: boilerplate names ("Project Gutenberg") and names
living only in the header or license tail are not characters.

### The shape layer (shape-steered generation)

The shape pass above is the seed of a larger split: **content** (what's true
and relevant) and **shape** (how to say it) are handled by independent
subsystems, so neither prompt has to encode both. The content layer
(`engine.js`) owns spans, notes, citations, and the verifier; the **shape
layer** (`shape.js`, published as `window.EOShape`) owns the form — length,
register, commitment, structure — and steers the model toward it. The model
does the linguistic work of joining them.

Form is measured against a library of pre-written **exemplars**
(`exemplars.jsonl` — 430 exemplars across 22 intents: lookup, synthesis,
connect-passages, clarify-question, pushback-repair, hedge-uncertain,
disagree-with-source, refusal-without-condescension, out-of-scope-offer,
name-tension, meta-about-cleo, and the rest, every intent held above a
stability floor so its centroid is a learned shape and not the memory of a
handful of answers). Their *content* is incidental
and their *shape* is the signal — full length range (two-word answers to
essay-length syntheses, plus a few ASCII diagrams), and **both poles of every
interpretable axis** anchored via each line's `anchor_axes` (short↔long,
committed↔hedged, warm↔dry, prose↔structured, …) so the axes survive an
embedder swap as centroid differences. Those axes can be read back out of the
embedded space by **`tools/factor-intents.js`** (`npm run factor-intents`),
which runs shape.js's `pca()` over the responses and reports the exemplars at
each pole (to hand-label an axis), the pairwise centroid separation between
intents (close pairs are merge candidates; the `hedge-uncertain`↔`commit-opinion`
confidence pair is called out explicitly, since confidence rides the stamp), and
a per-intent spread read (a cloud that splits in two is a split candidate). It
embeds at run, writes to no prompt, and abstains rather than invent a factoring
if the embedder is absent. Each exemplar's response **and its
prompt** (`user_turn`) are embedded once (the resident MiniLM, borrowed lazily
so an exemplar vector never triggers a download) and cached — the response
vectors score drafts, the prompt vectors match incoming questions (§9 below).
A draft is scored not by raw cosine to its target but **discriminatively**
(§5): `s_t − s_c`, its similarity to the target shape minus its similarity to
the nearest *competing* shape — positive means it sits unambiguously in the
target's basin. The bar is **adaptive**: higher where shapes crowd together
(more to be confused with), lower where the target is isolated.

"Thinking," then, is the iterative search for the right shape for an answer
whose content is already settled. The **drafting controller** (`runDraftingLoop`)
re-asks the same model with the content held fixed and only a shape-revision
instruction varying between drafts. Revisions are natural language the model
can act on — "more concise," "less hedging," "as prose, not a list" — derived
from the draft's drift along interpretable axes (the library's declared poles
where it has them, else structural features: length, hedging, structure,
first-person warmth), never a numeric score (showing the model its own cosine
would make a worse objective). The loop exits on three conditions
(§10): **landed** (score clears the threshold), **converged-and-failed**
(drafts stop improving), or **budget** (four drafts). A non-landing turn
returns its best draft, honestly marked `soft_fail`, with a full audit trail —
every instruction, draft, score, and drift axis — structured from day one to
feed a later Hebbian update over the exemplar weights (§11; the update itself
is deferred).

Everything in the shape layer is pure and dependency-injected — generation
(`EOLLM.phrase`) and embedding (`EOEmbed`) are passed *in*, never imported — so
the whole thing is exercised in Node with fakes (`tests/shape.test.js`) and no
WebGPU. It ships as the measurement substrate plus the controller, exposed
(`window.EOShape`) and pulling from the full merged library; replacing the live
single-call phrasing with the loop is the remaining forward step (it has open
UX questions — how to surface drafting and soft-fails), and is parity-safe until
then (the answer path is unchanged, and the golden snapshots are byte-identical).
The reasoning-model `<think>`-leak filter the loop depends on — drafts must be
think-clean before they reach the embedder — already ships in `llm.js`.

### Prompt matching and length-shaped tokens (§9)

The exemplars carry both halves of an exchange — the archetype answer *and* the
prompt it answers — so the shape layer reads the incoming turn against the
**prompts** the archetypes answer, not only the responses they produce. Each
`user_turn` is embedded alongside its response, and `lib.matchPrompt(queryVec)`
returns the nearest archetype prompts, an **inferred intent** (a similarity-
weighted vote over the neighbours), and a **discriminative confidence** —
`s_top` minus the nearest prompt of a *different* intent — so a question that
sits between two shapes reads as low-confidence rather than forced. `select()`
takes the question's embedding (`queryVec`), infers the intent when the caller
didn't supply one, and ranks the cluster by prompt-to-prompt similarity (blended
with the shape note's fit where both are present). This is the learning/feedback
loop: a given prompt now names the response *type* it wants, and the match rides
the audit (`shape-tokens` step) so the choice is inspectable.

Matching the prompt to its archetype also settles the answer's **length**.
`tokenBudgetFor(target)` sizes `max_tokens` from the best-fit archetype's own
length — a one-line lookup archetype yields a tight budget (which keeps a small
model from rambling past the shape), an essay-length synthesis a generous one —
padded for headroom and clamped to a safe window (≤ 520, so a 4096-token
prebuild always has room for the prompt). The bound stays a *bound*: there are
still no length prescriptions in the prompt, and the model answers as it sees
fit beneath the cap. `EOLLM.resolveMaxTokens` applies the budget as an opt-in
override — absent it, the default caps are byte-identical to before, so a
session with no embedder or no loaded library answers exactly as it did
(`app.jsx` only reaches for a shaped budget once MiniLM is already resident and
the library has loaded, warming it in the background and never blocking a turn).

### The form-genres library (a second, fetched library)

`exemplars.jsonl` is Cleo's own **voice** — 22 intents (lookup, synthesis, dry,
playful, pushback-repair…) authored in her register. You cannot fetch those
from the wild: there is no public corpus of Cleo being dry, and pouring outside
prose into those intents would poison the centroids with a voice that isn't
hers. So output **form** lives in a *separate* library, `form-genres.jsonl`,
built from **real public-domain / openly-licensed** instances of each genre —
how a news article looks, an obituary, a recipe, an encyclopedic summary, a
plain report, a letter. The centroid per genre is the learned *shape* of that
form; a draft's output is cosined against it for the form degree, the subject
washing out across many varied instances.

The two libraries are kept apart on purpose. The discriminative score draws
competitors from every *other* intent in the same library — so if `news-article`
shared a file with `dry` and `playful`, a news draft would be scored against
assistant-voice moves, which is noise. Loaded as its own library
(`window.EOFormLibrary`, the twin of `EOShapeLibrary`), `news-article` is scored
against `obituary` against `recipe` — a real contrast. Same loader, same lazy
MiniLM embed at load, same parity fallback (resolves `null` when absent or
unreachable). **No vectors are ever stored**: the responses are embedded at
load and recompute against the new space on any embedder swap, for free — store
text and provenance only.

Every record carries **provenance** — `source`, `license`, `retrieved` —
carried into memory by `parseExemplars` so a form exemplar's papers travel with
it in the runtime audit. A record with no provenance does not go in the file.
Fair game is Project Gutenberg public-domain texts (cookbooks for `recipe`,
letter collections for `letter`), the 1911 *Encyclopædia Britannica* for
`encyclopedic-summary`, Chronicling America pre-1923 newspapers for
`news-article` and obituaries of the **long dead**, and US federal works
(NWS forecasts, court syllabi) for `plain-report` — nothing copyrighted,
paywalled, scraped against terms, or modern.

The corpus is built by **`tools/form-genres/fetch.mjs`** from a manifest
(`tools/form-genres/sources.json`), mirroring the external desk's discipline:
freeze/replay (the version actually fetched is the version of record),
abstain-never-fabricate (no source reached ⇒ skipped, not invented), and a
stamped provenance on every record. It fetches through the same proxy the
reference desk uses (or `--direct`), and **stores no embeddings**.

```
node tools/form-genres/fetch.mjs --live       # pay the network, freeze, write
node tools/form-genres/fetch.mjs --validate    # check every record's provenance
```

The hard rule carries forward from the shape layer: a centroid stays a
*measure*. It is never read, summarized into "what a news article contains,"
and written into a prompt. The shape is tacit — a distance, not a spec. The
moment a fetched corpus becomes a feature list in the talker's prompt, it is a
checklist again.

### Checking a claim (CONFIRM/DENY)

Not every turn is a question. "Is Amos Dresser the white minister…?", "but it
sounds like he's not a speaker", "you said he was a speaker" — these *propose a
proposition* and ask the reading to check it. Handed to the grounded-QA prompt,
a small model mangles them (an assertion presented as a question reads as text
to report on, and the model ends up quoting the user back as if they were the
passage). So they are a first-class intent, answered **mechanically against the
graph**: the proposition is parsed and checked against the page's recorded
assertions (DEF events) and attribution slots (SIG events), returning
*confirmed* with the assertion's own cite, *contradicted* with the same, or
attested against the scan — no model involved.

True **negatives cite ⊥ with a receipt**. "Never mentioned as a speaker" is a
claim about the whole document — no single line can support it, and retrieval
used to lash it to whatever short line shared a token. Instead the events are
scanned in full and the claim carries an `[⊥]` chip whose tooltip is the
receipt ("holds no speaker slot in 14 attribution events"). The same move the
anti-matter void makes for absent terms, extended to absent roles and mentions.

And when a check fails a claim **the assistant itself made earlier**, the old
reply is **retracted**: flagged in the chat, re-tagged in the model's history
("…RETRACTED — do not repeat or defend it"), and the retraction said out loud
in the new answer — a correction the user deposits actually lands somewhere.

### Conflation across sources (the cross-source veto)

Load two sources and a question that hands the model both at once and a third
failure appears, invisible to every check that reads one document at a time. Ask
for an essay on *Oracle's ethics* with a Larry Ellison article **and** a Nashville
police-surveillance article in scope, and the model writes "Oracle's partnership
with the Metropolitan Nashville Police Department to deploy 15 fixed cameras" —
each sentence binding cleanly (the camera words really do live on the page it
cites) while the *bridge between the two documents* is the model's own. It was
never Oracle that deployed the cameras; the subject lives only in the Ellison
article, the cameras only in the police one, and **no page joins them**. The
within-source vetoes (assertion, kin, relation) each read a single graph and
structurally cannot see it.

The fix is to read the **draft's own graph** — each claim resolved to the source
it binds to — against the sources' entity membership. A claim whose governing
subject is an entity *absent* from the source it cites but *present* in another
in-scope source is a cross-source attribution: held and flagged, the
misattribution named in the trace ("ties Oracle, from the Ellison article, to
something that appears only in the surveillance doc, where Oracle is never
mentioned"). The topic is **carried across sentences** the way a reader carries
one, so an anaphor inherits it — "*The company's* partnership…" is read as
Oracle's, and flags, even though the sentence never says the name. Conservative
by construction: it needs two or more sources, a named topic, and a clean bind;
an entity shared across sources is not foreign and never flags, and a definite
reference local to the cited doc ("the cameras", whose head noun lives there) is
read as that page's own, not the topic's — the failure direction of every
heuristic is a missed flag, never a false one. Behind the *Cross-Source
Attribution* rule (off by default — the parity floor); on, it keeps the model's
answer and downgrades the badge to an honest caveat, exactly like the vetoes
beside it. `tests/cross-source.test.js` pins the catch, the topic carry, and the
zero-false-flag bar.

### De-chroming (the page, minus its chrome)

A web article arrives wrapped in **chrome** — the nav row, the share buttons,
the byline, the cookie banner, the "5 min read", the copyright tail. The reader
already gates each such line as it ingests (the `chrome_patterns` convention:
nav menus, share/social rows, subscription appeals, bylines, copyright, a
line-leading `©`, book front matter): a chrome line stays verbatim in the spine
so it re-displays, but it reaches no operator emitter, so it mints no phantom
people, places, or claims. What's new is reading that verdict **at the scale of
the whole document**. A non-destructive **de-chroming pass** (`computeDechrome`)
groups the gated lines into contiguous blocks, labels each by what it is
(navigation, share row, subscription appeal, byline, copyright, article meta…),
and records a **SEG-shaped boundary decision** per block carrying the raw span's
content hash as provenance. Nothing is removed — the full page is still in the
spine — so a wrong strip is recoverable, because the raw given was registered
before the strip. The summary rides the document (`doc._dechrome`) and the
ingestion report (`ingestionReport(...).dechrome`).

The de-chroming then **steers retrieval**. Ordinary questions read the
**de-chromed view**: `retrieve` scores past the gated lines, so a summary no
longer grabs the share bar and "who's in this" no longer mints the byline as a
character. But a turn **about the html / the chrome / the de-chroming itself** —
"what did you strip?", "what does the footer say?", "show me the page chrome" —
is detected mechanically (`aboutChrome`) and answered against the **full
content** (the stripped band included, `retrieve(..., { includeChrome: true })`).
Like CONFIRM/DENY, it's a first-class **mechanical route**: the report is read
straight off the structure band, every line cited to its span, the model never
phrasing it. The page keeps its chrome; you just have to ask for it.

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

Every turn runs at the deepest stop. A factual turn **walks the document
graph** out from the entities the question names — the page's recorded
assertions (DEF events), its drawn relations, co-occurrence — and the prompt
opens with that reading before the verbatim passages. Iterative seek rounds,
associative wandering, working-memory carry-forward, the inference void, and
reconsideration are all live; each knob's value (in the rules drawer) is the
ceiling the turn spends. The **propositional veto** audits every kept draft
against the page's own assertions: a draft that denies what the page asserts
("X was not Y" while the graph holds *X is Y*) binds cleanly at the string
layer and is caught only here, claim against claim — and a token-level check
also *certifies* a draft that recombines on-page names into a false
proposition, so this check is the floor of what "grounded" means (still a
rule; disable *Propositional Veto* to turn it off).

### Auditing the chat

Because the intelligence is mechanical, every chat turn is a sequence of
explicit decisions — and the **Audit** drawer (the topbar button) is a glass box
over them. For each turn it records, step by step:

- **route** — did the turn reference a source in scope, and why; which path it
  took (grounded-LLM, mechanical, plain chat, creative);
- **intent / ground / referents** — `who` vs `summary` vs `confirm` vs
  `factual`, whether the page can answer, and the matter / anti-matter (void)
  referents the question names;
- **retrieve** — the passages actually retrieved, each with its relevance score
  (turns add numbered *seek* rounds, with unseekable query terms named);
- **traverse** — the graph walk: entry nodes, the assertions and relations
  held along the walk, and the evidence sentences it gathered;
- **llm** — the *exact* prompt the model saw (system + assembled history +
  passages), its parameters, and the raw text it streamed back, verbatim;
- **veto** — the mechanical check: any invented terms, whether the phrasing
  re-bound to the page, whether the draft contradicts a recorded assertion,
  and whether the model's draft or the mechanical answer won;
- **confirm / retract** — for a proposition-checking turn, each claim and the
  graph's verdict on it (confirmed / contradicted / attested-by-absence), and
  any earlier reply of the assistant's the check caused to be retracted;
- **answer** — the final text, citations, and the grounded / coverage / stable
  audit it ended on.

Recording is on by default and in-memory (a capped ring buffer); the durable
artifact is the **Export JSONL** button — one self-contained turn per line
(schema `cleo-audit/1`), ready for `jq`/grep or a notebook. Copy and Clear sit
beside it, and recording can be paused. This is the tool for the question "why
did it answer that?" — when a `summarize` returns raw opening lines, or a
retrieval grabs page chrome, the trace shows exactly where.

### Auditing the ingestion (every word, in reading order)

The chat audit answers "why did it say that?"; the **Ingestion** drawer (its own
topbar button, shown once a prose source is loaded) answers the prior, more
skeptical question — **"what did it actually do to my text on the way in?"** The
entity view shows the proper-noun cast, which makes it easy to assume the rest of
the words were dropped. They weren't, and this is the glass box that proves it,
word by word. It reads the document the way a person does — left to right, top to
bottom — and refuses to summarize anything away:

- **Overview** — the ingestion report card: every word's fate as a proportion bar
  (**indexed** content word / **stopword**, carried but not searched / **dropped**,
  too short or outside the index's character class), span coverage (how many
  sentences deposited a graph event vs. went *dark*), and the event tally by kind.
- **Reading** — the centrepiece: a walk through the source in reading order with
  **every word classified inline** (indexed terms highlighted, names boxed,
  stopwords dimmed, dropped words struck through), and beneath each span the events
  it deposited. A ▶ **Read** control advances span by span, slowly, like a human;
  the window *moves* rather than growing, so a whole book never lands in the DOM at
  once. Each span carries its content hash (`sha256(span)[:16]`) as its anchor.
- **Lexicon** — the inverted index actually built: every distinct word, its count,
  its fate, and the spans it occurs in (click one to jump the reader to it).
  Searchable; stopwords and dropped words shown alongside the index terms, not
  hidden — filter them in or out.
- **Entities / Graph** — the cast and the assertions/relations/kin, each one traced
  to the **source span it came from** (the chat-side Graph tab shows the claim; this
  shows the claim *and* the line, so you can check it). Bidirectional: every derived
  fact links to its span, and every span shows what it produced.
- **Events** — the full append-only log (`INS` / `DEF` / `SIG` / `SYN` / `NUL` /
  `SEG` / `EVA` / `REC`), filterable by kind and searchable, each row expandable to
  its raw fields and its source span. Nothing capped.

The per-word classification is not a re-implementation of the tokenizer — it *calls*
it (`EOEngine.classifyTokens`), so what the audit shows is bit-identical to what
retrieval indexes; the audit cannot drift from the engine. The whole report is one
self-contained JSON object (schema `cleo-ingestion/1`, `EOEngine.ingestionReport`)
behind the **Export JSON** button — spans, lexicon, coverage, entities, and the
event log, ready for `jq` or a notebook. `tests/ingestion.test.js` pins the
contract (tokenizer fidelity, total word accounting, honest coverage); the parse
itself is untouched, so golden parity holds.

### Conformance: the seven invariants

What an ingestion log *should* hold is written down once, as law:
`docs/reading-conformance.md` defines seven invariants over the append-only log
(ADMISSION, BINDING, SPEECH, COMPANY, DARK, WEIGHT, CUSTOM), each with a
mechanical check and a witness from the permanent failing corpus (the Toronto
Life ingestion of 2026-06-11, which scores `0 0 0 0 0 1 0`).
`tools/conformance.js` is the instrument: it scores any exported
`cleo-ingestion/1` dump as the 7-bit vector, citing the exact events that earn
each violation, with optional session-side advisory checks over a
`cleo-audit/1` JSONL export.

```sh
npm run conformance -- dump.json            # score an exported dump
node tools/conformance.js --parse some.txt  # parse with the live engine, then score
```

The checker honors invariant 7 itself: its check logic knows only the operator
schema, and every surface criterion (chrome patterns, lexicons, thresholds)
lives in a replaceable pack (`--pack`; register packs for Gutenberg books,
Spanish, Chinese, and Aozora-Japanese live in `tools/packs/`).
`tests/conformance.test.js` pins a conforming log at `1 1 1 1 1 1 1`, the
failing corpus at `0 0 0 0 0 1 0`, and the live engine's current bits — the
rebuild's scoreboard, meant to flip left to right.
`npm run evo:conformance` sweeps the evo corpus (English and not) through the
instrument under its per-register packs and reports the vectors, the
violated-law histogram behind each 0, and sample witnesses.

## Reading rules

The "reading rules" in the side panel are the toggleable parameters the engine
reads under (decay, inertia, anaphora handling, and so on). They can be turned
on/off, exported as JSON, and imported — parsing stores only invariants, and the
entity/prominence views are re-projected from the current rules without a
re-parse.

### Convention proposals (provenance-anchored)

The local model has one more job besides phrasing answers: **proposing reading
conventions** from friction the engine registered mechanically — a `LABEL:`
line bound to no speaker three times, a `* * *` separator read as a sentence,
a pronoun stalling on the same pair. It proposes in one plain sentence citing
engine-minted span handles; it never commits. The engine mints everything
real: **provenance anchors** (`sha256(span)[:16]` + an optional quantized
embedding signature — content hashes, never names or locations, resolvable
only on the device that read the source), the candidate records, and their log
positions. A proposal enters the conventions log as a *signal* below the
admission threshold by construction, because admission requires independent
spans **and at least one non-model witness** — the model can never be its own
witness. A later document matching the proposed shape co-witnesses it
automatically; the Glass box → **Proposals** channel offers one-tap Confirm
(instant admission) or Reject (a SEG that decays the signal and, repeated,
feeds the veto lexicon). Admission lands the pattern through the rules ledger
and the next parse reads differently — `tests/conventions.test.js` proves the
whole path, and the *Convention Proposals* rule (side panel) toggles and
budgets it.

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

`docs/operator-void.md` captures the operator-void idea (distinguishing a
missing *operator*/shape from missing *content*). The CONFIRM/DENY intent is
its first delivered shape: "verify this proposition" used to misfile as a
content question, and now has its own operator.
