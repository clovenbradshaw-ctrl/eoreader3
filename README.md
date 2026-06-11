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
  retrieved **spans** (verbatim sentences, trusted) and its own **notes** (the
  graph's reading — assertions, kin records, header metadata, working memory —
  "usually right, sometimes wrong"), preceded by a small **shape pass**: a
  director's-note call that characterizes what the turn wants before the
  answer pass writes. Reasoning-model `<think>` blocks are gated out of the
  stream and the answer (the audit keeps them verbatim). Output is checked
  and re-cited mechanically — the model never writes its own citations and
  never overrides the page.
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
the system itself didn't stand behind. A reply the user pushed back on gets
the same treatment — tagged *"the user said this reply missed their
question"* — so a rejected answer can't keep re-entering the prompt as
something that simply happened.

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
author'…"). The answer pass then speaks freely with that note as guidance,
not a leash: spans are verbatim quotes to trust and *use* ("if a span
contains a name, date, or title that answers the question, use it directly —
don't echo the question's wording back"), notes are the reader's own
understanding, spans win conflicts, and there are no hardcoded length
prescriptions — the model answers as it sees fit, bounded by `max_tokens`.
The shape note is recorded as its own audit step; a failed or empty shape
pass degrades to the bare answer pass, and with no model at all the
mechanical paths answer as ever. Citations stay mechanical throughout.

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
(`exemplars.jsonl` — 373 exemplars across 22 intents: lookup, synthesis,
connect-passages, clarify-question, pushback-repair, hedge-uncertain,
disagree-with-source, refusal-without-condescension, out-of-scope-offer,
name-tension, meta-about-cleon, and the rest). Their *content* is incidental
and their *shape* is the signal — full length range (two-word answers to
essay-length syntheses, plus a few ASCII diagrams), and **both poles of every
interpretable axis** anchored via each line's `anchor_axes` (short↔long,
committed↔hedged, warm↔dry, prose↔structured, …) so the axes survive an
embedder swap as centroid differences. Each exemplar's response is embedded
once (the resident MiniLM, borrowed lazily so an exemplar vector never triggers
a download) and cached. A draft is scored not by raw cosine to its target but **discriminatively**
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
the verbatim passages. Depth 1 is the parity floor — byte-identical to the
reflex pipeline — with one deliberate exception: the **propositional veto**,
which audits every kept draft against the page's own assertions. A draft that
denies what the page asserts ("X was not Y" while the graph holds *X is Y*)
binds cleanly at the string layer and is caught only here, claim against
claim — and a token-level check also *certifies* a draft that recombines
on-page names into a false proposition, so this check is the floor of what
"grounded" means, not a luxury the dial buys. It runs at every depth (still a
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
  (deeper turns add numbered *seek* rounds, with unseekable query terms named);
- **traverse** — the graph walk (depth > 1): entry nodes, the assertions and
  relations held along the walk, and the evidence sentences it gathered;
- **llm** — the *exact* prompt the model saw (system + assembled history +
  passages), its parameters, and the raw text it streamed back, verbatim;
- **veto** — the mechanical check: any invented terms, whether the phrasing
  re-bound to the page, whether the draft contradicts a recorded assertion
  (every depth), and whether the model's draft or the mechanical answer
  won;
- **confirm / retract** — for a proposition-checking turn, each claim and the
  graph's verdict on it (confirmed / contradicted / attested-by-absence), and
  any earlier reply of the assistant's the check caused to be retracted;
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
