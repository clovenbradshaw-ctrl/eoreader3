# The text & chat mechanics — a map, and a selection

*A functional map of how Cleo ingests a document and chats with it, read through
the project's own EO lens; then an assessment as a selective force — what is
load-bearing, where efficiency is left on the table, what is dead weight — and a
Koestler "watchmakers" reading of where stable sub-assemblies would make the
whole stronger.*

Scope: the path that matters for **ingest a document and chat with it
efficiently with a local model, auditably**. UX chrome that doesn't bear on that
is deliberately left aside. Every claim below is anchored to wired code
(`file:line`); where the prose in the README or in-source comments disagrees with
the running code, that divergence is called out — it is itself a finding.

---

## 0. The lens: what EO actually is, in code

EO is not a module; it is a **coordinate system for cognition**. Every act of
reading or answering is located at a **three-fold address** on a 3×3×3 cube
(`engine.js:3213–3365`):

- **Identity / Mode** — Differentiate · Relate · Generate
- **Space / Domain** — Existence · Structure · Interpretation
- **Time / grain** — Ground · Figure · Pattern

Three readable faces, each a 3×3 grid:

| Face | Axes | Answers | Code |
|---|---|---|---|
| **ACT** | Identity × Space | *what operation* (the operator) | `EO_MODE_OF_OP`/`EO_DOMAIN_OF_OP` `engine.js:3242,3318` |
| **SITE** | Space × Time | *where the mark landed* | `EO_SITE_GRID` `engine.js:3213` |
| **RESOLUTION** | Identity × Time | *how the target is held* | `EO_RESOLUTION_GRID` `engine.js:3326` |

The address of any event is `operator(Site, Resolution)` — e.g. `INS(Entity,
Making)`, `NUL(Void, Clearing)` — computed at read-time by `eoAddressOfEvent` /
`eoNotation` (`engine.js:3351,3365`). Nothing is stamped on the event; the log
stays the single source of truth.

**The nine operators** (the ACT face). The README lists eight; the ninth is
**CON**, the binding bond, and it is the most important one:

| | Existence | Structure | Interpretation |
|---|---|---|---|
| **Differentiate** | **NUL** hold/stall | **SEG** resplit | **DEF** assert/define |
| **Relate** | **SIG** attribute | **CON** bond | **EVA** evaluate frames |
| **Generate** | **INS** instantiate | **SYN** synthesize | **REC** learn a rule |

This matters for the map because **the operators are the vocabulary the whole
system speaks** — ingestion emits them, the graph is their projection, the audit
records in them, the evolution scaffold recapitulates in them. They are the
genome.

---

## 1. The spine: one architecture, stated once

> **The append-only log is the source of truth. Everything you see is a recomputed
> projection of it.**

```
  text ──parse──▶  append-only event log  ──projectGraph──▶  graph (entities, edges)
                   (per-doc events[], 9 ops)      │
                                                  ├──▶ retrieval / answer / fold
                   global RULES_LEDGER ───────────┤
                                                  └──▶ audit (EOAudit) / EO-MRI
```

- Per-doc log: `const events = []` (`engine.js:4406`), surfaced as `doc._events`
  (`:7745`). Append-only — even a retraction is *written* as a new `SEG` event
  (`:6336`, "nothing is unwritten").
- Global rules log: `RULES_LEDGER` (`engine.js:2411`); `REC` events point into it.
- Projection: `projectGraph(events, frame)` (`engine.js:6827`) — a pure fold;
  union-find replays SYN(merge)/SEG(split) in seq order; all field weights
  (mass/momentum/gravity) are *recomputed each call* (`:7038`).
- The composition layer (`composition.js`) is the **same idea at document scale**:
  a Doc is a fold of its own log; undo is supersession.

This is the architecturally important fact, and we return to it in §7: the
**data model is already holonic** (stable intermediate form you can always rebuild
from), even though the **code is not**.

---

## 2. Ingestion pipeline (text → graph)

Wired path:

```
handleFiles (app.jsx:1165)
  └─ routeFile (ingest-adapters.js:40)         text? → readAsText | audio/img/pdf → adapter
       ├─ [adapter path] EOAdapters.runFor → events → eventsToText
       │     └─ EOImportStructure.reconstruct (import-structure.js:679)  words→lines→columns→furniture
       └─ ingest (app.jsx:974) → parseDocument (engine.js:7787)
             ├─ parseTable (:7654)            tabular
             └─ parseProse (:7730)
                   └─ extractEoGraph (engine.js:4223)   ← the core reader
                         · detectLanguage / applyLanguageModule
                         · readTranscript (timecodes / Speaker:)
                         · sentence index  _segmentParagraph (:4182, via compromise)
                         · Pass 0: attribution-verb induction → REC + ledger (:4430)
                         · per-sentence loop (:5040–6320, ~1280 lines):
                              chrome gate → INS/SYN/NUL (entities) → DEF/kin
                              → SVO → SYN/CON (relations) → SIG (attribution)
                         · admission gate → SEG retractions (:6331)
                   └─ overlays: rebuildBlocks · attachEdgeAffinity (embed) · computeDechrome
```

**What runs on every plain `.txt`** (CORE): sentence index, `tok` (`engine.js:41`,
the single tokenizer), chrome gate (`isChrome` `:3064`), entity admission
(`addEnts` `:5208`, two-sighting), in-pass pronoun resolution, DEF/copular, kin,
SVO→SYN/CON, SIG attribution, admission SEG, `projectGraph`, `computeDechrome`,
lazy `docMetadata`, and `attachEdgeAffinity` (only if the embedder is warm).

**Special-modality only** (audio/OCR/PDF/layout): the whole adapter layer +
`import-structure.js`. Plain text keeps the byte-for-byte read path.

**The inverted index** people expect isn't on the critical path: retrieval uses a
per-sentence forward token-`Set` (`sentTokSets` `:8588`, WeakMap-cached); the true
term→postings map is built **only in the audit** (`ingestionReport` `:10726`).

### Auditability of ingestion — strong
`graphaudit.jsx` (the Ingestion drawer) is a live glass box over the parse: every
word classified inline by *calling* the engine's own `classifyTokens`
(`engine.js:10676`), so it cannot drift from what retrieval indexes; full
append-only log, filterable; `cleo-ingestion/1` JSON export; offline conformance
scoring (§5).

---

## 3. Chat turn pipeline (question → grounded answer)

Orchestrator: **`runTurn` (app.jsx:4340)**. `chat.jsx` only renders and fires
`onSend`. Routing is **cost-ordered** — the cheapest mechanical paths get first
refusal before a model is ever loaded:

```
runTurn (app.jsx:4340)
  1. /wiki, hero-paste-as-doc, bubble + paint yield (setTimeout 0)
  2. MATH      EOCompute.detect (compute.js:237)        mechanical, no model
  3. WIKI desk (offer only, never auto-pull)
  4. VERBATIM  runVerbatimScope                          mechanical
  5. load model on demand
  6. COMPUTE toggle (Python) runComputeScope             model writes code, py runs local
  7. CREATIVE  runChat('creative')                       model, never cited
  8. routeTurn (engine.js:13919) → band:
       repair    → runRepairScope            (re-reads the question under repair)
       escalate  → retrieveHybrid → recover or chat
       carry     → re-ask bare follow-up through prior cited material
       mechanical→ smart-table | runGroundedScope | runMechanicalScope
       else      → runChat (plain)
```

**Mechanical (no model):** math, verbatim, CONFIRM/DENY (`answerConfirm`
`engine.js:11520`), about-chrome (`answerAboutChrome` `:11692`), table pivot/value,
who/summary, antimatter-void. **Model-phrased:** grounded-LLM, plain chat,
creative.

### The grounded path — `runGroundedScope` (app.jsx:3008–3768, ~760 lines)

```
classifyIntent → confirm / de-chrome detours
mech = answerScope            (mechanical reading, kept as EVIDENCE only, never the reply)
ground gate                   (no ground → plain chat, badged "not from the document")
RETRIEVE                      contextScope | semantic | seekContext (≤4 rounds) | default
  notes lead with the INTEGRAL FOLD  (foldNote → foldForQuery, engine.js:10617)
GRAPH WALK   traverseScope    (entry = named + conversation-hot entities)
IMPRESSION   impressionQuery  (embed query → region → fold the region into one note)
PHRASE       EOLLM.phrase ×1  ← exactly ONE model call (the "shape pass" is dead, §6)
CONVERGE     ≤3 rounds        coverageGaps → retrieve → phrase → re-bind, stop when cites stop growing
FORM pass    measureForm      one structural rephrase if below the genre floor
BIND         bindCitationsScope (engine.js:12583) — model never writes [sN]; re-cited mechanically
VETOES       assertion · kin · relation · cross-source · grounding-envelope · invented · unbound
SETTLE       markInferences · deposit conversation field · depositForm centroid
```

**Veto philosophy (current):** the content vetoes **keep the model's draft and
flag it** (the mechanical reading rides as click-to-view evidence); only declined
/ empty / note-echo / echo-after-retry / unbound-with-no-prose **refuse
honestly**. The old "discard and substitute the mechanical portrait" is gone.

### Auditability of the turn — strong
`audit.js` / `window.EOAudit` records every turn step-by-step (schema
`cleo-audit/1`, 300-turn ring): `route · intent · ground · retrieve · traverse ·
llm · veto · confirm · answer`. The **`llm` step records the exact verbatim
prompt and raw output** (`llm.js:2006`) — the load-bearing part. At settle it
computes **WI-7 truthfulness** (`audit.js:149`): bound / voids / unbound (must be
0) / coverage / per-sentence witness degree. JSONL export. A separate
`cleo-fetch/1` log enforces the chat-isolation invariant (refuses any
`triggered_by:'chat'`, `audit.js:243`).

---

## 4. The model layer (llm.js) — phrasing only

Three backends behind one interface (`load`/`phrase`/`isLoaded`, routed by model
key, `llm.js:864`): **WebLLM** (WebGPU, default desktop = Llama-3.2-3B),
**wllama** (CPU/WASM, fallback = SmolLM2-135M, pre-warmed), **Claude** (API).
`recommendModel`/`probeDevice` (`:533,411`) pick by device without importing a
runtime. The embedder (MiniLM-q8, `embed.js`) is separate, warmed in the
background, and every consumer no-ops when it's cold — the hot lexical path never
blocks on it.

Prompt assembly (`systemFor` `:1608`, `buildUserContent` `:1814`,
`assembleMessages` `:1840`): grounded system prompt → spans (verbatim, trusted) →
notes (the reading, "usually right") → question repeated last for recency; last 4
turns verbatim, older folded to one mechanical recap. `<think>` blocks filtered
from the stream, kept verbatim in the audit. Token budget from the shape layer's
archetype length (`tokenBudgetFor`), clamped ≤520.

---

## 5. Instrumentation & the EO-native audit

| Instrument | File | State |
|---|---|---|
| **Glass box** (turn audit) | `auditview.jsx` ← `audit.js` | **live, load-bearing** |
| **Ingestion audit** | `graphaudit.jsx` | **live, load-bearing** |
| **EO-MRI** (the cube scan) | `eomri.jsx` | live, **visualization-only** (read-only) |
| **Conformance** (7 invariants) | `tools/conformance.js` | live but **offline CLI, ingestion-only** |
| **Vector confidence** | `eoconfidence.js` | **staged — not loaded in index.html** |
| **Position scorer** | `eoscore.js` | **dead — not loaded, no caller** |

The seven conformance invariants (Act-face laws): ADMISSION, BINDING, SPEECH,
COMPANY, DARK, WEIGHT, CUSTOM. Site and Resolution faces are *displayed* but never
scored.

**The auditability gap that matters:** the richest epistemic instrument the
project designed — confidence as a 7-component vector with `null ≠ zero ≠ low`
(`eoconfidence.js`) — is **dark**. The live audit still uses scalar
`covers`/`grounded` fields. The cube is fully defined and encoded; its richer
measurement layers (vector confidence, per-turn conformance, Site/Resolution
scoring, the operator-void distinction) are staged-and-unloaded or design-only.

---

## 6. The selection — keep, enhance, cut

Acting as the selective force. The fitness function is: *fastest, most stable path
to a grounded, audited answer from a local model.*

### KEEP — load-bearing, do not touch lightly
- **The log + projection spine** (`events[]`, `RULES_LEDGER`, `projectGraph`) — the
  whole guarantee rests here.
- **The 9-operator EO encoder** (`eoAddressOfEvent`, the grids) — the shared
  vocabulary.
- **`extractEoGraph` per-sentence loop** — the reader.
- **`bindCitations` + the veto battery** (assertion, kin, invented, unbound) — this
  *is* "grounded." Mechanical, never model-written.
- **`audit.js` / EOAudit + the verbatim `llm` step** — the troubleshooting surface.
- **`compute.js` (math) and `tablequery.js`** — real determinate value the model
  can't match, and cheap.
- **The integral fold and impression query** — genuine capabilities, well-cached.

### ENHANCE — efficiency left on the table (ranked)
1. **Memoize `projectGraph`.** It is the heaviest reducer and is re-run 15+ times
   per turn (~60 call sites, `engine.js`), several over the *same unchanged* log.
   A memo keyed on `(events.length, frameSig)` would erase most per-turn graph
   cost — the single biggest win, and safe because the log is append-only.
   *(This is "cache the assembled watch; keep the parts tray" — see §7.)*
2. **Cache per-claim retrieval/embedding inside the converge loop.**
   `bindCitationsScope` does `retrieve(doc, sentence, 1)` per claim, and the loop
   re-binds 3–5 near-identical drafts (`app.jsx:3484,3515`); `groundingEnvelope`
   re-embeds each claim/span with no memo (`engine.js:13852`). Key on
   `(docId, sentence-hash, RULES_REV)`.
3. **Share the query embedding.** It is computed independently by retrieval,
   `shapeBudgetFor` (`app.jsx:2638`), and `measureForm` (`:2664`) on the same turn.
4. **`predict.js` should reuse `_docVecCache`** instead of re-embedding up to 600
   sentences at ingest (`predict.js:291`) — duplicate work on the same document.
5. **Prompt size / cross-turn reuse.** The grounded system prompt is large and
   re-sent every turn with no prefix caching; on a 0.5–3B local model this is the
   dominant fixed cost. Trim it, and exploit backend prefix caching where the
   window is stable.
6. **Make the post-hoc form stamp lazy.** `measureForm` runs a MiniLM inference
   after *every* grounded answer for a stamp the user may not open.

### CUT or RESOLVE — dead weight and unfinished forks (each is carrying cost for no live benefit)
- **`eoscore.js`** — not loaded, no caller. Remove, or wire it. (~129 lines + a test.)
- **`enrich.js`** — 1,253 lines, **no call site in the app** (`window.EOEnrich`
  invoked only by tests). Remove, or wire the deferred enrichment pass.
- **The dead shape pass.** `shapeFor` hard-returns `''` (`app.jsx:2618`); the
  `shapeNote` parameter is threaded through `phrase`/`buildUserContent`/
  `assembleMessages` and never rendered. **Decide one of two:** (a) finish wiring
  `shape.js`'s `runDraftingLoop` (built, tested, *zero live call sites*) as the
  real two-pass answerer, or (b) delete the vestigial plumbing and the stale
  "two-stage answering" comment block (`app.jsx:3221–3228`). Right now you pay the
  maintenance of both and the benefit of neither.
- **`form-genres.jsonl` is effectively empty** → the composition `form`
  confidence component is *always null*. Either fill it (`tools/form-genres/
  fetch.mjs`) or stop instantiating the second `EOFormLibrary` and claiming a form
  stamp exists.
- **Three overlapping table detectors** in `routeTurn` (`parsePivot.empty` vs
  column-substring vs `looksLikeTableQuery`, `engine.js:13948`) — unify into one.
- **`referencesDoc` (`engine.js:9644`) is vestigial** on the live path
  (`routeTurn` is what runs); it survives for tests. Mark it test-only or fold it
  in, so two routers can't drift.
- **Layout `seedEvents` are computed and dropped.** `import-structure.js`
  reconstructs region-subject DEF/NUL/CON events, but `ingestViaAdapter` consumes
  only `{text, provenance}` (`app.jsx:1147`) — the structure channel never reaches
  `parseDocument`. Either wire it or stop computing it.

### FIX — cheap, high-trust (documentation lying to the next reader)
- **The `relation_gate` / `binding_resolution` comments are false.** Inline
  comments throughout say "OFF by default — the parity floor," but the seed values
  are **`true`** (`engine.js:879,919`). These paths (keyed binding, the relation
  check, the grounding envelope) fire on *every* turn. Correct the comments — an
  auditor reading the source is currently being misled about what runs.
- The README's "two-pass shape (≈90 tokens)" and `docs/eo-mri.md`'s address
  derivation describe behavior the code no longer has (one phrase call;
  `eomriAddress` is partly heuristic). Reconcile.

---

## 7. Koestler's watchmakers — where sub-assemblies make it stronger

Koestler's parable: **Hora** builds watches from stable sub-assemblies, so an
interruption costs only the current sub-assembly; **Tempus** builds monolithically,
so any interruption collapses the whole and he never finishes. The stable
intermediate form — the *holon* — is what survives interruption and what
evolution can select on.

**Cleo's data is Hora. Cleo's code is Tempus.**

- *Hora, already won:* the append-only log is the stable intermediate form. You can
  lose the in-memory graph at any moment and rebuild it by replay; undo is
  supersession; a composition is a fold of its log. Interruption is cheap because
  the parts tray is durable. This is exactly the right spine, and it's the reason
  recovery, audit, and the evo scaffold all work.

- *Tempus, the liability:* the **code** that operates on that data is two
  monoliths. `engine.js` is **14,693 lines in one file** (`projectGraph` ~660
  lines, the per-sentence loop ~1,280 lines, ~60 internal `projectGraph` couplings);
  `app.jsx` is **5,029 lines**, with `runGroundedScope` a single **760-line**
  function. A change to attribution risks the projector; a change to retrieval
  risks the grounder; nothing can be assembled or tested in true isolation. This is
  the watch that collapses when the bench is jogged.

The tell is that **the tests are already decomposed but the source is not.** There
are independent suites — `binding`, `relation`, `coref`, `roles`, `site`,
`eoaddress`, `distance-gravity`, `cross-source` — each pinning a sub-assembly that
*does not exist as a module*. The seams are already drawn; only the code hasn't
been cut along them.

### The recommended sub-assemblies (each a holon: own interface, own tests, swappable, survives interruption)

1. **`eo-core`** — the log, the nine operators, `projectGraph`, the address
   encoder. The genome / the constitution. Everything depends on it; it depends on
   nothing. The evo scaffold's `allowlist.js` already names this boundary ("MAY NOT
   touch: `projectGraph`, the nine-operator vocabulary, the append-only log") — that
   constitutional line *is* the module boundary, latent.
2. **`parse`** — `extractEoGraph` + the per-sentence emitters (chrome, entity, kin,
   relation, attribution). Pinned by `binding`/`coref`/`roles`/`relation` tests.
3. **`retrieve`** — `retrieve`, `retrieveScope`, hybrid, seek.
4. **`fold`** — folds, impression, terrains (already well-cached and cohesive).
5. **`answer`** — the mechanical answerers (who/summary/confirm/kin/define/prose).
6. **`ground`** — `bindCitations` + the veto battery + grounding envelope. Pinned by
   `cross-source`/`relation`/`binding`. This is the integrity guarantee; isolating
   it is the highest-value cut.

   And at the turn scale: **`runGroundedScope` → a pipeline of named pure stages**
   (retrieve → notes → phrase → converge → form → bind → veto → settle), each
   independently testable. The 760-line function is the turn-level Tempus watch.

**Use the modules you already did right as the template.** `shape.js`,
`composition.js`, `addressee.js`, and `compute.js` are *already* good holons: pure,
dependency-injected (generation and embedding are passed *in*, never imported),
fully exercised in Node with fakes, swappable. They survive interruption — you can
test and replace any of them without lighting up WebGPU. That discipline is the
finished sub-assembly; `engine.js` and `app.jsx` are the ones still built on the
bench in one piece. The selective pressure is clear: **make the code mirror the
data — stable sub-assemblies over a durable log — so that a change to one face can
no longer collapse the projection or the grounder.**

> The data already knows it is a nest of holons (`holonicFold`: "a document is a
> nest of wholes-that-are-also-parts"). Let the code admit the same.

---

## Appendix: doc/comment ↔ code divergences found while mapping

| Claim (README / comments) | Reality in code |
|---|---|
| Two-pass "shape pass (≈90 tokens)" before the answer | `shapeFor` returns `''`; exactly one `phrase()` per turn (`app.jsx:2618,3247`) |
| `relation_gate` / `binding_resolution` "OFF by default" | seeded **`true`**, fire every turn (`engine.js:879,919`) |
| Composition `form` stamp via genre centroids | `form-genres.jsonl` empty → component always `null` |
| Confidence as a named vector (`eoconfidence.js`) | not loaded; live audit uses scalar `covers`/`grounded` |
| Layout firewall events reach the graph | `seedEvents` computed in `import-structure.js`, dropped at `app.jsx:1147` |
| `enrich.js` deferred enrichment pass | no live call site; dormant |
| Eight operators (README) | **nine** — CON is the ninth and the central one |
</content>
</invoke>
