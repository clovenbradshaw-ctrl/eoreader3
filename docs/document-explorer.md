# The document explorer — the graph as an x-ray, on two axes

*Design note. Not yet built. This captures the pivot: from an app you only
**chat with** to one you **explore** — where the rich graph the engine already
induces is rendered as an x-ray of the document, and a second graph, the
**graph of significance between documents**, develops as a corpus accretes.
Chat does not go away; it becomes one lens on a node rather than the front door.*

---

## The shift

Today Cleo is a chat app with a document docked beside it (`split` / `chat` /
`doc` layouts, `app.jsx:323`). The intelligence is mechanical — `engine.js`
induces a real graph from every document — but that graph is only ever consumed
*indirectly*, as retrieval scope behind a worded answer. The richest artifact
the system produces is never the thing the user looks at.

The pivot makes the graph the surface. A document becomes something you can see
*through* — an x-ray — and a corpus becomes a field of documents pulled together
by the entities, claims, themes and citations they share. Reading is no longer a
single act at a single depth; it is a position you choose on two axes.

This is **additive**. It is a fourth layout mode, a new view, and one new engine
module — not a rewrite. `app.jsx` is already state-driven (no router),
already multi-document (`docs`, `openTabs`, `sources`, projects), already
tab-based. The seams exist.

## The two axes

The user's framing: two dials that turn the reading up and down. Both already
exist as latent structure in the engine; the explorer is what finally exposes
them.

### Vertical — resolution (how deep the scan goes)

The engine reads through nine operators —
`NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC` — and the confidence and
scoring layers already organise the world into three stacked **domains**
(`eoconfidence.js`, `eoscore.js`):

| Stratum | Domain | Operators | What renders at this depth |
|---|---|---|---|
| **Floor** | Existence | NUL, SIG, INS | tokens, sentences, every word's fate — the word-walk `graphaudit.jsx` already draws (`GaxReading`) |
| **Middle** | Structure | SEG, CON, DEF | entities, kin, page-stated assertions |
| **Ceiling** | Significance | SYN, EVA, REC | relations between referents, induced rules, LLM-level inference and phrasing |

The vertical axis is a dial over these strata. At the floor the x-ray is the raw
segmentation — closest to the ink. As you turn it up, entities precipitate out,
then relations, then the inferred and the learned. "Early segmentation vs. the
high-level LLM activity" is precisely the bottom and the top of this ladder. The
dial does not re-run anything; it chooses **which strata of an already-computed
graph are drawn**, with everything above the cut faded or hidden.

### Horizontal — time (which clock is running)

`audit.js` already keeps an append-only event log with per-sentence provenance,
and `eomri.jsx` already ticks through it frame-by-frame. The scrubber exists; it
is trapped inside a single chat turn. The insight that it *shifts* is the key
move — the same control points at three different clocks depending on what you
are looking at:

1. **Ingestion time** — replay a document's graph assembling as it is read. The
   `_events` log on the doc is the tape.
2. **Reasoning time** — the existing per-turn MRI playback (`eomri.jsx`,
   `EOMRI.traceFromTurn`): how *this answer* was reached.
3. **Corpus time** — how the between-document significance graph grew as
   documents were added. The newest clock; needs the corpus layer below.

The horizontal axis is a single scrubber whose meaning is set by the current
selection: a document selected → ingestion time; a turn selected → reasoning
time; the whole corpus → corpus time.

## The graph of significance — the genuinely new layer

Within a document the graph is solved: `graphSnapshot(doc)` yields entities,
edges, assertions, kin, all reconciled. **Between** documents there is nothing —
entities reconcile only within a doc, projects merely group `docIds`
(`app.jsx`). The new work is a layer that lifts N independent document graphs
into one **corpus graph**.

### The data model

A bipartite-leaning graph over two node kinds:

- **Document nodes** — one per loaded doc. Carry mass (entity count, word
  count), kind, ingestion timestamp.
- **Entity nodes** — reconciled *across* documents. The connector tissue: an
  entity present in three docs is one node with three document attachments.

Edges between document nodes are derived and **weighted by significance** — the
four signals the design selects, in recommended build order:

1. **Shared entities** *(phase 1 — already computable)*. Two docs are linked
   when they name the same reconciled entity; weight scales with the entities'
   mass (`entity.mass` already exists). The most concrete signal and the only
   one needing no new inference — it falls straight out of cross-document
   reconciliation.
2. **Citation / source links** *(phase 1 — structure already present)*. Web
   sources and Wikipedia ingests already carry reference structure
   (`doc.wiki.references`, the `cleo-fetch/1` provenance). When one doc was
   fetched from or cites another, that is a hard, directed edge — nearly free.
3. **Thematic gravity** *(phase 2)*. Embedding similarity between documents via
   the existing `embed.js` / `EOEmbed`, so two docs with no shared *named*
   entity but the same subject still attract. Reuses the distance/gravity model
   already documented in `docs/distance-gravity.md`.
4. **Contradiction** *(phase 3 — highest value, most inference)*. One doc
   asserts *X is Y*, another asserts *X is Z*. Needs assertion comparison across
   docs (DEF events keyed by reconciled subject). The signal that turns the
   explorer from a similarity map into an argument map; deferred because it
   leans hardest on the engine.

Significance is the edge weight: a function of shared-entity mass, citation
hardness, thematic proximity, and contradiction salience. The same three-domain
grain the engine already uses (Existence / Structure / Significance) decides
*which* edges a given vertical-axis setting reveals — shared entities are a
Structure-level link, contradictions a Significance-level one.

### Cross-document reconciliation

The one hard prerequisite. Within-doc reconciliation already runs at parse time;
the corpus layer needs the same idea one level up: when is "Nashville" in doc A
the same node as "Nashville" in doc B? Phase 1 starts deliberately simple —
exact reconciled-surface-form match, weighted by mass — and deepens toward
embedding-backed entity matching (reusing `EOEmbed`) and, eventually, the
reference desk's disambiguation (`reference.jsx`) for the ambiguous cases. Simple
first keeps the corpus graph honest and debuggable before it gets clever.

## Where it lives (the seams)

Mirroring the **composition layer** precedent (`docs/composition-layer.md`): a
pure, dependency-injected engine module that runs in Node with fakes, plus a thin
view that wires the real engine into it. Nothing imported that needs WebGPU.

- **`corpus.js`** (`window.EOCorpus`) — *new.* The pure engine. Takes the array
  of per-doc graph snapshots and produces the corpus graph: reconciles entities,
  scores edges, exposes the corpus-time event log. Generation, embedding and
  retrieval are passed **in**, never imported — so the whole layer is exercised
  in Node with fakes, like `composition.js`.
- **`explorer.jsx`** (`window.ExplorerView`) — *new.* The surface. A graph
  canvas with the vertical resolution dial on one edge and the horizontal time
  scrubber on the other. Selecting a node sets what the scrubber means and what
  chat is scoped to.
- **`app.jsx`** — a fourth layout mode (`explore`) beside `split`/`chat`/`doc`,
  added to the existing toggle (`app.jsx:323`, `app.jsx:4712`). Additive; with
  the corpus empty it is inert.
- **Reused as-is:** `graphSnapshot`/`extractEoGraph` (`engine.js`) for the
  per-doc graphs; `embed.js` for thematic gravity and fuzzy reconciliation;
  `audit.js` `_events` for ingestion-time playback; `eomri.jsx` for
  reasoning-time playback; `graphaudit.jsx`'s word-walk as the floor-depth render.

### Non-breaking floor

Same contract the composition layer holds: the explorer is additive and opt-in.
With no corpus built the engine behaves identically to today; parity snapshots
stay byte-exact. The corpus layer is **read-derived** — like the turn-scale and
composition Given-Logs, the corpus graph is a *fold* of per-doc snapshots and an
event log, never stored authoritative state. Rebuild it by replay.

## Build order

The phasing is chosen so every slice is shippable and the next one composes onto
it:

1. **Corpus engine, phase-1 edges, no UI.** `corpus.js` with exact-match
   reconciliation, shared-entity and citation edges, Node tests with fakes. The
   invisible foundation; provable without a browser.
2. **Explore view, static.** `explorer.jsx` renders the corpus graph; click a
   doc node to open it in the existing `doc` view. No axes yet — just the map.
3. **Vertical axis.** Wire the resolution dial to the three strata over a
   selected document's graph (the x-ray proper), reusing `graphSnapshot` and the
   floor-depth word-walk.
4. **Horizontal axis.** Wire the scrubber to ingestion time first (`_events`
   tape), then let selection switch it to reasoning time (`eomri.jsx`) and
   corpus time.
5. **Deeper edges.** Thematic gravity (phase 2), then contradiction (phase 3),
   then embedding-backed reconciliation.

Chat is folded back in at step 2: selecting any node scopes the existing
composer to it, so the explorer and the grounded chat are two views on one
corpus rather than two apps.

## Open questions to resolve before phase 1

- **Edge thresholds.** A corpus of many documents that all mention common
  entities (dates, "the city") will over-connect. Reconciliation must inherit the
  engine's stopword/admission discipline so the floor doesn't flood the field.
- **Scale.** A force-directed canvas over hundreds of documents and thousands of
  entities needs decimation tied to the vertical axis — the depth dial doubles as
  a level-of-detail control, not only a semantic one.
- **Corpus-time provenance.** Ingestion and reasoning times have real event
  tapes; corpus time needs its own append-only log of when each doc and edge
  entered, so the third clock has something true to scrub.
