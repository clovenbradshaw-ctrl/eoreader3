# Extraction targets

> The *picture* the strangle-in-place of `engine.js` and `app.jsx` is
> aiming at. Not a deployment plan, not a clean-room rewrite. The actual
> extraction happens here, module by module, with the existing test
> suites becoming the acceptance criteria.
>
> For the reference implementation of each holon's shape, see
> [`clovenbradshaw-ctrl/eoreader4`](https://github.com/clovenbradshaw-ctrl/eoreader4).
> That repo is **not** a future deployment — it's a frozen picture of
> what each interface should look like after extraction. Use it as the
> shape, not as the migration.
>
> Source-level risk per holon is in
> [`engine-extraction-notes.md`](engine-extraction-notes.md).

## Two non-negotiable rules

1. **State lives in the log.** `eo-core` owns `appendEvent` and
   `projectGraph`. Every other module is a pure function over
   projections. If a module needs to remember something, it emits an
   event. No private graph state, no closure-captured mutables. This is
   the line `allowlist.js` already draws ("MAY NOT touch: `projectGraph`,
   the nine-operator vocabulary, the append-only log"); the fork just
   makes it physical.

2. **Nothing below the orchestrator imports `llm.js` or `embed.js`.**
   `phrase` and `embed` are received as parameters. This is what the
   four holons that already exist (`shape.js`, `composition.js`,
   `addressee.js`, `compute.js`) get right — and it is exactly what lets
   the `binding` / `coref` / `relation` / `cross-source` suites run in
   Node with fakes. Without this discipline, no extraction is testable.

## The DAG

```
                    eo-core
        (log · 9 operators · projectGraph · address encoder)
                       │ depends on NOTHING
        ┌──────────────┼──────────────┐
      parse         retrieve         (compute.js, tablequery.js —
        │              │             already modules; not redoing)
        │            fold
        │              │
        │            answer ──── (mechanical: no model, ever)
        │              │
        └───── ground ─┘   (bindCitations + veto battery + envelope)
                       │
               turn orchestrator
         (stages.reduce; audit becomes a projection of the fold)
                       │
         orchestrator injects phrase (llm.js), embed (embed.js)
```

## Extraction order

Front-load the genome and the integrity guarantee:

1. **`eo-core`** — trunk; can't cleanly cut branches until it's defined.
   Pinned by `eoaddress` + `site`. Golden-master safe **only after**
   the `READING_RULES.decay_gamma` read inside `projectGraph` is
   addressed (see engine-extraction-notes §2). ~20 internal call sites
   become imports.
2. **`retrieve`** — smaller, cleaner, depends only on core. A
   confidence-builder before the hard cuts.
3. **`ground`** — jumped ahead of parse. Isolating the integrity
   guarantee before the parse churn means an attribution change can't
   accidentally relax grounding. Pinned by `cross-source` / `relation` /
   `binding`. Depends only on core + retrieve + injected `embed`.
4. **`parse`** — fork-within-the-fork: extract `extractEoGraph`, then
   decompose its per-sentence emitters (chrome → entity → kin →
   SVO→SYN/CON → SIG → admission SEG). Pinned by `coref` / `roles` /
   `relation`. **Note:** `extractEoGraph` is not pure today; the parse
   holon will own `TRANSCRIPT_ACTIVE` and `LANGUAGE_MODULES` explicitly
   (engine-extraction-notes §3).
5. **`fold`** — falls out easily once core exists.
6. **`answer`** — wires in already-modular `compute.js` / `tablequery.js`;
   keeps the no-model property.
7. **Turn-as-reduce** — the deepest cut. See §"Turn as fold" below.

**Invariant:** at the end of every extraction PR, the existing test
suite is green and the app is shippable. Never more than one holon
away from a green build — the fork itself has to survive interruption.

## Step 0 — clean the bench (do these first)

Drawing seams around dead weight makes the seams ambiguous. Each is a
small, focused PR; together they remove the noise that would force
premature seam decisions.

- [ ] Delete `eoscore.js` — not loaded, no caller.
- [ ] Delete `enrich.js` — 1,253 lines, no live call site
  (`window.EOEnrich` invoked only by tests).
- [ ] Resolve the shape fork — either finish `shape.js`'s
  `runDraftingLoop` as the real two-pass answerer or delete the
  `shapeNote` plumbing in `phrase` / `buildUserContent` /
  `assembleMessages`. Right now both are carried for the benefit of
  neither.
- [ ] Fix the lying gate comments. The inline comments at
  `engine.js:879` and `:919` say "OFF by default" but the seeded values
  are `true`. These paths fire on every turn and belong in `ground`;
  an auditor reading the source is being misled.
- [ ] Decide `seedEvents`. `import-structure.js:679` computes layout
  DEF/NUL/CON events; `app.jsx:1147` destructures only `{text,
  provenance}` and drops them. Either wire the structure channel into
  `parseDocument` or stop computing it. See
  `engine-extraction-notes.md` §5.
- [ ] Unify the three overlapping table detectors in `routeTurn`
  (`engine.js:13948`) — `parsePivot.empty` vs column-substring vs
  `looksLikeTableQuery`.

None of these changes are extractions; they are bench-clearing. Each is
independently safe with the existing suite.

## Interface contracts (target shapes, from eoreader4)

The shapes below are the *target* for each holon's public `index.js`
after extraction. They simplify away things the real engine has (kin,
audio adapters, the rules ledger, the EO-MRI); those belong in the
strangled modules but aren't fixed by this picture.

### `core` — the genome

```js
import { createLog, projectGraph, eoAddressOfEvent, OPERATORS } from './core/index.js';

const log = createLog({ docId });
log.append({ op: 'INS', id, label, sentIdx });
log.retract(refSeq, reason);
const { entities, edges, frame, rev } = projectGraph(log, frame);
const addr = eoAddressOfEvent(event);  // { operator, act, site, resolution }
```

- `projectGraph` memoized on `(log.length, frameSig, rulesRev)`. The
  third key element is the engine-specific fix — see
  engine-extraction-notes §2.
- `OPERATORS` is the frozen nine: NUL, SEG, DEF, SIG, **CON**, EVA, INS,
  SYN, REC. Listed-as-eight in eoreader3 README is wrong; CON is real
  and central (`engine.js:6855, 6924`).

### `parse` — text → events

```js
import { parseText } from './parse/index.js';

const { docId, text, sentences, log, tokensBySentence, admission } =
  parseText(text, { docId, transcriptHandler, languageModules });
```

The target signature receives `languageModules` and `transcriptHandler`
as parameters — not from module scope as today. That's the change that
makes parse a holon. See engine-extraction-notes §3.

### `retrieve` — query → spans

```js
import { retrieveLexical, retrieveSemantic, retrieveHybrid } from './retrieve/index.js';

const lex = retrieveLexical(doc, query, k);
const sem = await retrieveSemantic(doc, query, embedder, k);   // no-op if embedder cold
const all = await retrieveHybrid(doc, query, embedder, k);     // max-pool dedup
```

`embedder` is injected at every call. Nothing in `retrieve` imports
`embed.js`.

### `ground` — the integrity guarantee

```js
import { bindCitations, runVetoes, VETOES } from './ground/index.js';

const bound = bindCitations(draft, spans);
//   → [{ claim, citation: 's3' | null, score }]
const { fired, refuse } = runVetoes({ draft, bound, question });
//   → { fired: [{ id, message, refuses }], refuse: boolean }
```

- The model **never writes `[sN]`**. The binder does, mechanically.
- Vetoes are a list of pure predicates (`VETOES`). Adding a veto = adding
  to that list. No hidden veto site anywhere else.

### `fold` — spans → note

```js
import { foldNote, impressionQuery } from './fold/index.js';

const { text, sources } = foldNote(spans);
const impression = await impressionQuery(doc, query, embedder, k);
```

### `answer` — mechanical paths (no model, ever)

```js
import { tryMechanical } from './answer/index.js';

const maybe = tryMechanical(doc, question);  // null if no mechanical match
```

Must not import `llm.js`. The mechanical paths are the largest UX win
on cold start — the model never warms for a math question.

### `model` — swappable LLM backends + embedder

```js
import { createModel, createMiniLMEmbedder } from './model/index.js';

const model = createModel('webllm', { /* opts */ });
await model.load(onProgress);
const out = await model.phrase(messages, { maxTokens, temperature });
```

Backends register themselves at import. Embedder is independent.

### `audit` — the optimization surface

```js
import { createAuditLog } from './audit/index.js';

const audit = createAuditLog({ capacity: 300 });
const turn = audit.turn(question);
turn.step('retrieve', { ms, n, top });
turn.finish({ route, prompt, rawOutput, bound, vetoes, answer, sources });
audit.exportJSONL();
```

Schema `eo-audit/1`. **Verbatim** prompt and raw output are load-bearing
for every grounded turn — without them you can't tell whether the model
or the spans were the problem.

### `turn` — the named-stages reduce

```js
import { stages, runTurn } from './turn/index.js';

const PIPELINE = ['route', 'retrieve', 'fold', 'prompt', 'llm',
                  'bind', 'veto', 'settle'];
const result = await runTurn({ question, doc, model, embedder, auditLog });
```

Each `stage` is `(ctx) → ctx`. Pipeline composes via reduce. A stage
returning `{ terminate: true }` short-circuits (e.g. math / who).

## Turn as fold — same spine, two levels

This is the deepest move. Today `audit.js` records every step
(`route · intent · ground · retrieve · traverse · llm · veto · settle`)
as parallel bookkeeping. Making the turn a literal `stages.reduce(…)`
means the audit log becomes **a projection of the stage fold itself**:

- The document is a fold of its event log.
- The turn is a fold of its stage fold.
- The audit is the projection of the turn fold, same shape as the
  projection of the document log.

Same spine, two levels. The code admits the holonic structure the data
already has.

Mechanically:

```js
const run = (stages, ctx0, onStep) =>
  stages.reduce(async (acc, stage) => {
    const ctx = await acc;
    if (ctx.terminate) return ctx;
    const t0 = performance.now();
    const next = await stages[stage](ctx);
    onStep(stage, next, performance.now() - t0);
    return next;
  }, Promise.resolve(ctx0));
```

The audit's `step` becomes the `onStep` callback. There is no separate
bookkeeping to drift.

## What this is NOT

- Not a migration plan. The map's §6 (keep / cut / enhance) is the
  migration plan.
- Not a spec to copy line-by-line. The shapes simplified away kin, audio
  adapters, the rules ledger, the EO-MRI — those belong in the
  strangled modules but aren't fixed here.
- Not authoritative on internals. The existing test suites are the
  source of truth for what each holon must do.
