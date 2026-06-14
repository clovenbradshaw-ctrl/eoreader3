# The composition layer — long-form, grounded documents

The turn-scale grounded loop, lifted to the scale of a composition. This is the
build that lets a small model produce a long document whose every claim is bound
to evidence, whose plan is revisable by the drafting, whose form is *graded*
against a learned prototype rather than filled into a mold, and whose entire
production is reviewable as an event log.

It is **not** a generator with a longer context window, not a planner-then-drafter
pipeline with a fixed outline, not a template-filler. The model is one component
inside a loop; this is the long-form version of that loop.

## Where it lives

- **`composition.js`** (`window.EOComposition`) — the engine. Pure and
  dependency-injected (generation, embedding, retrieval and the form library are
  passed *in*, never imported), so the whole layer is exercised in Node with
  fakes and no WebGPU. It carries the event log, the fold, the grain-relative
  witness, the form stamp, the monitor, and the talker orchestration.
- **`compose.jsx`** (`window.CompositionView`) — the surface. Two panes over one
  fold: the revisable plan on the left, the assembled draft on the right. It
  wires the real engine (`EOEngine.retrieveScope`), the real talker
  (`EOLLM.phrase`), the real embedder (`EOEmbed`) and the form library
  (`EOFormLibrary`) into the injected deps the module expects.
- **`tests/composition.test.js`** — the pure core (fold, witness, monitor,
  generateUnit) with fakes. **`tests/compose.smoke.js`** — mounts the component
  through jsdom so the two-pane view is proven to render.

A composition is a new `doc.kind` (`'composition'`); with none open the engine
behaves identically to today. It is deliberately **not** added to the chat's
source scope — it is something the system *writes*, not a corpus it reads — so it
never enters retrieval, working memory, or the grounded prompt. The
non-breaking floor holds: parity stays byte-exact (202/202).

## The objects, all in the Given-Log

Everything is a log event on `doc._events`. The document the user sees is a
**fold** of the log (`EOComposition.fold`). State is never stored; it is derived
by replay — the same architectural rule as the turn-scale Given-Log, lifted to
the composition scale. Editing the document is appending events. **Undo is
supersession by REC.**

| object | op · kind | what it is |
|---|---|---|
| **Doc** | `doc` | the top-level container (id, frame_id, created_at) |
| **Frame** | `DEF · frame` | the rhetorical problem as an object: thesis/question, reader, goal, constraints, genre. Revisable — a later frame supersedes it |
| **Unit** | `DEF · unit` | a node of the plan tree carrying a *job* (direction, not content), an order, a parent. A re-DEF of the same id is a plan edit (rewrite-job / reorder / reparent) |
| **Draft** | `INS · draft` | the prose attached to a unit, with `source_events` (what the talker drew from) and a Confidence |
| **Stamp** | `EVA · stamp` | the computed Confidence on a draft + a tag. Produced by the audit, not the talker; re-stamping is frequent |
| **Hole** | `NUL · hole` | an explicit owed unit. The event still exists in the log, but the Figure/Ground/Pattern *grain* knob is no longer a surface control — every draft is witnessed as **Figure** (citation coverage) by default, the same shape a chat answer is graded on |
| **Route** | `DEF · route` | the monitor's decision (advance/revise/fetch/escalate/restructure) carrying the named predicate that fired |
| **Plan-Edit-By-Draft** | `REC · plan-edit-by-draft` | a record of *why* the plan moved, driven by a draft. User-driven for now; the monitor will emit it once the standing operator ships |
| **(supersede)** | `REC · supersede` | the undo primitive — drops its target from the fold; itself supersedable (redo) |

The unit's **state** is itself a fold over later events: `owed` until a draft
attaches; `drafted` when one is current; `contested` when flagged; `held` when
accepted as final-for-now.

## Confidence is a vector

Every gate is a predicate over a **Confidence vector** with named components — no
scalar collapse. Each is a degree in [0,1] **or null** (not measured). A null
component is shown as `null`, never as zero, and never blocks a gate: we do not
assert what we did not measure.

| component | meaning | status this build |
|---|---|---|
| `witness` | how much of the prose a span backs (grain-relative) | **live** |
| `form` | how much it looks like its genre (cosine to the centroid) | **live** (null until `form-genres.jsonl` is populated) |
| `coherence` | how it sits against the whole, under the live frame | null until the **standing operator** (phase three) |
| `retrieval` | whether the retriever found material | **live** |
| `temporal` | the freshness of the spans | null (later) |
| `frame` | the job's alignment with the doc's goal | **live** when an embedder is resident |

### The grain-relative witness

`witnessGrain({ prose, spans, grain })` measures the talker's **own** settled
prose against the spans it was given — string overlap only, so it runs with no
embedder. The grain is no longer a knob the surface exposes; every unit is
witnessed as **Figure**, but the other grains remain in the engine for when a
later phase reintroduces them mechanically:

- **Figure** (the default) → citation coverage: the fraction of content
  witnessed by a span. Tags `figure-grounded` / `confabulation` (claims with no
  span) / `grain-mismatch`.
- **Ground** → honest-absence-if-warranted: an absence assertion is witnessed
  when the spans are genuinely silent on the thing it denies. Tags
  `honest-absence` / `confabulation` (the spans contradict it).
- **Pattern** → corroboration count: a claim is a pattern only with ≥2
  instances. Tags `pattern-grounded` / `pattern-partial` (one instance).

Witness, unlike form, may reach 1 (full coverage). Form never does — matching the
centroid exactly is the average, the death of a particular answer.

## The loop

`generateUnit` is the loop in one call: **retrieve** material against the unit's
job → **phrase** it through the membrane (the talker sees the job, the spans, a
thin slice of neighbouring drafts for the seam, and the frame text — never the
whole document, the genre prototype as words, or any operator vocabulary) →
**stamp** it (witness, form, retrieval, frame) → **route** it.

**Grounded the way a chat answer is.** A grounded unit (the default; `creative`
is the opt-out) is phrased through the *same* path a chat reply takes — the
canonical grounded system prompt, the retrieved spans handed in as witnessed
evidence, the grounded params — so a section is grounded exactly like a turn.
The talker's citation markers (`{{cite:doc:idx}}` or the grounded prompt's `[sN]`
tags) are resolved by `bindTalkerCites` into the draft's `source_events` and
stripped, so the canvas reads as clean prose with the evidence links intact. In
**creative** mode the same spans are offered as raw material and the talker
composes freely (witness still measured, just not leaned on).

The **monitor** reads the stamp and emits a Route naming the predicate, per the
v3 gate table:

```
witness ≥ .4 AND form ≥ .5 AND (coherence null OR ≥ .5)   → advance
witness < .4 AND retrieval ≥ .5                            → revise   (found, but unused)
witness < .4 AND retrieval < .5                            → fetch    (reach for more)
form < .5 AND witness ≥ .4                                 → revise   (shape off, grounding fine)
coherence < .4 AND others fine                             → revise | restructure
persistent low coherence across a branch                  → restructure (a Plan-Edit-By-Draft)
```

A **reread** (`restamp`) re-runs the Confidence against the current state without
changing the draft; if the stamps drift the next route may demand a revise.

## The UX

A single artifact surface, two panes over the same fold:

- **The plan pane** — the frame at the top (editable), then the unit tree. Each
  node shows its job, state, and a confidence sparkline; children nest under
  their parent to whatever depth the document grew. The colour **band** (owed /
  advance / revise / fetch / contested / held) is the one place a scalar
  projection appears; the predicate that produced it shows on hover. Reorder,
  rewrite-job, cut.
- **The draft pane** — the assembled doc in tree order. Each unit shows its prose
  (directly editable), its full Confidence vector as labelled bars, its tag as a
  word, the spans it drew from as links, and the monitor's route. Units in flight
  stream.
- **The action surface** — contextual: Draft / Revise / Restamp / Hold / Mark
  contested on a unit; ▶ Go / Outline only / + Unit / Restamp all / Undo on the
  doc. Every action is an event, so every action is undoable.

Two **outset dials** sit at the top of the frame, because they change the whole
run and you set them before pressing Go: **Length** (≈ words — the target the
autopilot writes toward) and **Mode** (grounded vs creative). The other surfaced
settings — Genre, Source corpus, Talker model — change behaviour too; no
per-token knobs are exposed, on the bet that the model is a small, replaceable
component and tuning it per doc is the wrong layer.

## Starting to write

There are two on-ramps, because "set a thesis, outline, then draft each unit"
is too many steps before anything appears:

- **▶ Go (autopilot).** One press, no brief to write first. If you never said
  what the document is, it **reads the sources and frames it for you** —
  proposing a thesis, reader, goal, and genre from a sample of the corpus
  (`EOComposition.deriveFrame`, streamed as `Reading the sources…`); your own
  frame fields always win, it only fills the blanks. Then it outlines from that
  frame — *streamed into the plan pane so you watch the sections arrive* — then
  drafts every unit in order, each streaming its tokens, with a live status
  (`Reading the sources…`, `Outlining…`, `Drafting 3/6 — …`, `Deepening a
  section…`) in place of a dead "working…". The freshly-derived frame is threaded
  straight into the outline and every draft, so the in-flight run uses it before
  the fold re-derives. After a plan exists the same button reads **Write the
  rest**. `Outline only` still plans without drafting (from whatever frame you've
  set); per-unit `Draft`/`Revise` remain. With no corpus loaded there is nothing
  to frame from, so Go falls back to outlining the existing frame — the
  non-breaking floor.

  **It tessellates to length — spirals within spirals.** Once the top sections
  are drafted, while the document is still under the **Length** dial's target,
  the autopilot deepens its most-developed section into subsections
  (`planFromUnit`), drafts those, and repeats — the same outline→draft loop
  applied at finer and finer grain, so the tree grows as deep as the length
  needs. A running registry tracks each unit's words without waiting for a
  re-fold; the recursion is bounded (`CMP_MAX_DEPTH`, `CMP_MAX_UNITS`) so "any
  length" still terminates. Each section gets a per-unit word budget derived from
  the target, and grounded vs creative follows the **Mode** dial.
- **Open as a document (promote a chat answer).** Every assistant reply in the
  chat carries an *Open as document* action. It seeds a composition from that
  answer with no model wait: each paragraph becomes a talker-authored unit,
  citation markers become the draft's evidence links, Markup is flattened, and
  the question that prompted the reply becomes the thesis. You land in the canvas
  with real prose already there — edit it (your changes are marked yours), ask
  the talker to keep writing, or query it (`EOComposition.seedFromProse`).

## Editing, provenance, and querying

The draft pane is a **directly-editable document canvas** — click anywhere in
the prose and type. Clicking a paragraph's prose opens a seamless inline editor
(same type, a faint focus ring, cursor at the click); clicking elsewhere on the
paragraph selects it and reveals its full audit (the confidence vector, the tag,
the spans it drew from, the route). Every contiguous stretch of prose carries an
inline author chip (`[you]` / `talker`) and your runs a subtle underline, so
authorship reads right in the flow.

**Authorship is tracked per sentence, by diff — not token by token, never per
keystroke.** Each edit emits one Draft event (coalesced on blur); the new prose
is diffed against the prior draft at the sentence level, and a sentence that is
new or changed is attributed to `user` while the rest carry their prior author.
So a talker draft you lightly edit ends up mostly `talker` with your touched
sentences `user` — the *changes* are what carry a new author, at a sane grain.
The fold surfaces this provenance; the canvas groups consecutive same-author
sentences into runs, underlines yours, and chips each run with its author
(`EOComposition.diffProvenance` / `authorship`).

**The document is queryable by the chat, as significance-level content.**
`EOComposition.project(doc)` folds the log into a prose-shaped object — `id`,
`kind: 'prose'`, `sentences`, `sentenceTexts`, `blocks`, an empty `_events` —
that the engine's `retrieveScope` reads like any source. `scopeList` in `app.jsx`
maps any composition in scope to this projection and **auto-includes every open
composition with drafted content**, so "what does my document say about X" works
whenever one is open. The talker sees only the **text** — the spans handed to the
model are plain sentences with no author labels — while the per-sentence
authorship rides in the projection's `_provenance`, traceable in the audit and on
the canvas. The composition's raw event log is never graph-projected (the
projection carries an empty `_events`, so `projectGraph([])` yields nothing); a
composition is never put into chat scope as its raw self, only as its projection.

## What ships here, and what is staged

This build lands **phases one and two** of the spec, plus the Confidence vector
and the monitor:

- **Phase one** — the plan-as-log and the artifact that renders the fold:
  generate-unit, edit-plan, edit-unit-prose, undo, all as events.
- **Phase two** — the witness stamp and the form stamp at unit scale, with the
  monitor's witness/form/retrieval predicates live.
- **The editable document canvas** — direct editing with per-sentence authorship
  provenance (diff-based), and the composition made queryable by the chat
  through its projection (talker sees only text; authorship traceable in the
  audit). Auto-queryable whenever the document is open.

Staged, with the architecture set up to receive them:

- **Phase three** — the standing operator and the `coherence` component. Until it
  ships, `coherence` is null (and so never blocks a gate), and `contested` /
  Plan-Edit-By-Draft are reachable only by hand.
- **Phase four** — the monitor's restructure path emitting Plan-Edit-By-Draft on
  its own (the knowledge-transforming move). Requires the standing operator.
- **Phase five** — full bidirectional, non-linear UX: plan-from-draft, free-order
  drafting with holes routed to fetch, the full reread with a doc-level stamp.

## The constraint, restated

No mold. The plan is direction, revisable to the end. Form is graded, never
handed. Standing is derived, not stored. The talker only phrases. Every
confidence is a vector. Every gate is a predicate. Every event is in the log.
The artifact is the fold.
