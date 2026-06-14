# Prompt Flow Map

How a user turn becomes (or doesn't become) a model call, and what prompt
the model sees when it does. File:line references are the locations at
the time of writing; the flow names, predicates, and prompt text are the
durable scaffolding.

> **Live companion:** the **Prompt flow** dashboard (toolbar pill →
> `promptflow.jsx`, data from `window.EOPromptFlow`) renders this same map
> from the code — every prompt string is read live from `llm.js`, so it can't
> drift the way these hand-written file:line refs do. It also shows, for the
> currently-selected model, whether the shape/editor prompt is actually fed to
> the model or skipped. See `docs/prompt-flow-dashboard.md`.

## A. Dispatcher decision tree

The single entry point is `runTurn` in `app.jsx:2616`, which assembles
the conversation and walks the cascade below. The FIRST match wins; all
later checks are skipped.

| # | Branch                                | File:line          | Predicate                                                                                          | Outcome                                     |
|---|---------------------------------------|--------------------|----------------------------------------------------------------------------------------------------|---------------------------------------------|
| 1 | Mechanical arithmetic                 | app.jsx:2707       | `EOCompute.detect(q, scope)` returns a math.js expression                                          | Deterministic answer; no LLM                |
| 2 | Computational grounding (Python)      | app.jsx:2738       | `mode !== 'creative'`, model ready, Python toggle on, tabular doc in scope                         | `runComputeScope` (1783)                    |
| 3 | Creative mode (toggle)                | app.jsx:2751       | `mode === 'creative'`                                                                              | `runChat(.., 'creative', ..)` (1410)        |
| 4 | Creative compose (auto)               | app.jsx:2774       | `mode === 'auto'` && `EOEngine.isCreativeCompose(q)` (engine.js:7845)                              | `runChat(.., 'creative', ..)`               |
| 5 | Forced grounded mode                  | app.jsx:2786       | `mode === 'grounded'` && scope non-empty                                                           | Builds a synthetic `mechanical` route       |
| 6 | Cost-ordered router                   | app.jsx:2794       | scope non-empty; calls `EOEngine.routeTurn(scope, q, ctx)` (engine.js:11452)                       | See §A.6                                    |
| 7 | No-scope chat                         | app.jsx:~2797      | scope empty                                                                                        | Synthetic `chat` route                      |
| 8 | Repair                                | app.jsx:2806       | `route.decision === 'repair'`                                                                      | `runRepairScope` (1512); marks prior reply  |
| 9 | Escalate (hybrid recall)              | app.jsx:2815       | `route.decision === 'escalate'`                                                                    | `retrieveHybrid` then re-route              |
| 10| Carry-grounded                        | app.jsx:2835       | no semantic hits + prior carry + (`continuity` \| `question-no-lexical`)                           | Re-retrieve through prior material          |
| 11| Mechanical / grounded-LLM             | app.jsx:~2858–2867 | `route.decision === 'mechanical'`; `useLLM = ready && primary.kind === 'prose'`                    | `runGroundedScope` (1905) or `runMechanicalScope` (1382) |
| 12| Plain chat (or unavailable)           | app.jsx:~2871      | `route.decision === 'chat'`; model ready or not                                                    | `runChat(q, history, undefined, '', !!doc)` |

### A.6 `routeTurn` decision reasons

`routeTurn` returns one of `mechanical`, `escalate`, `chat`, or `repair`,
with a `reason` string the audit log surfaces. In order of check
(engine.js:11452):

| reason                 | line  | predicate                                                                            | decision    |
|------------------------|-------|--------------------------------------------------------------------------------------|-------------|
| `no-scope`             | 11454 | no documents in scope                                                                | chat        |
| `command`              | 11459 | `intent === 'command'` (search/google/look up imperatives)                           | chat        |
| `repair:*`             | 11464 | prior reply exists AND intent='factual' AND `repairSignal(q)` matches                | repair      |
| `who` / `summary`      | 11475 | `intent === 'who'` or `'summary'`                                                    | mechanical  |
| `pivot`                | 11478 | `parsePivot(q, d)` non-empty                                                         | mechanical  |
| `table-column`         | 11482 | question contains a known column name                                                | mechanical  |
| `names-entity`         | 11486 | `namesEntity(d, q)` true for any doc (engine.js:8105)                                | mechanical  |
| `strong-lexical`       | 11491 | `retrieveScope` hit with score ≥ 0.5 or overlap ≥ 2                                  | mechanical  |
| `weak-lexical`         | 11493 | hits exist but below the strong threshold                                            | escalate    |
| `antimatter-void`      | 11497 | a named referent absent from every source                                            | mechanical  |
| `continuity`           | 11500 | `continuesPrior(d, q, ctx)` true                                                     | mechanical  |
| `question-no-lexical`  | 11506 | wh-led question, zero lexical hits                                                   | escalate    |
| `no-signal`            | 11507 | none of the above                                                                    | chat        |

Intent comes from `classifyIntent` (engine.js:7741): one of `who`,
`summary`, `command`, `confirm`, `factual`. `'command'` is the
recently-added class for assistant-directed imperatives ("search for X",
"google X", "look up X") — it routes to `chat` regardless of any
lexical/entity overlap with the open document.

## B. Flow catalogue

Each flow has its own runner and its own prompt-assembly path. Output
processing (citations, vetoes, salvage) is flow-specific.

### B.1 `plain-chat`

- **Runner**: `runChat` (app.jsx:1410)
- **Reached when**: route decision is `chat` (no-scope, command, no-signal, or failed escalate)
- **System prompt**: ungrounded, llm.js:1047
- **Stages**: one LLM call; first attempt with full history, retry once with last 2 turns + 2200-token budget on VRAM/context failure (app.jsx:~1430–1460)
- **Shape pass**: none
- **Veto/salvage**: none beyond the retry; output streams straight through
- **History wrapping**: full history with epistemic tags (`epistemicTag` at app.jsx:1090)
- **Mechanical panel**: only when a doc is open and a mechanical reading was computed alongside (no-ground fallback path)

### B.2 `mechanical`

- **Runner**: `runMechanicalScope` (app.jsx:1382)
- **Reached when**: route decision is `mechanical` AND (no LLM ready, OR primary doc is a table)
- **System prompt**: none; `EOEngine.answerScope(scope, q, {hotEntity})` produces text directly
- **Stages**: zero LLM calls
- **Veto/salvage**: `maybeRetract` runs if the plan carries checks; no model output to veto
- **History wrapping**: the plan's text and audit are written as-is
- **Audit decision**: `mechanical (<reason>)`

### B.3 `grounded-llm`

The largest flow; two stages, full veto stack, mechanical reading rides
along.

- **Runner**: `runGroundedScope` (app.jsx:1905)
- **Reached when**: route decision is `mechanical` AND primary is `prose` AND model is ready
- **Stage 1 — shape pass**:
  - `EOLLM.shapePass({ mlcKey, question, history, docTitle, metaHint })` (llm.js:1186)
  - System prompt: `SHAPE_SYSTEM` (llm.js:1166), examples-driven editor's-note format
  - User content: doc title + bibliographic-header hint + last 4 turns + question
  - Sampling: `temperature: 0.3`, `maxTokens: 90`
  - Output: 2–4 sentences describing the *move*, never facts
  - Returns `''` on failure (the answer stage proceeds without a note)
- **Stage 2 — answer pass**:
  - `EOLLM.phrase` (llm.js:1389)
  - System prompt: grounded, llm.js:1017 (with a summary-specific line at 1032 and a relation-gate variant at 1041)
  - User content: assembled by `buildUserContent` (llm.js:1232) — question, doc title, spans (quoted verbatim with `[s##]` tags), notes prose, **editor's note last** (llm.js:1254), then a repeated "Answer the user's question: …"
- **Context tiers** (chosen at app.jsx:1884–1943):
  1. summary/who intent → `contextScope` curated blob
  2. recovered embedding hits → `partsFromHits(semanticHits)`
  3. `seekContext` → iterative refinement
  4. `contextPartsScope` → lexical fallback
  - Graph traversal at depth > floor, working memory injected as notes, associative wander when embedder is warm
- **Veto/salvage**: see §E (degeneracy veto, model declined, shape-note echo, unbound, assertion contradiction, relation-gate mismatch, kin-subject, invented terms, grounding envelope)
- **History wrapping**: settled message carries audit `{ status, grounded, covers, stable, note }`; mechanical reading attaches as a click-to-view `mech` panel when the decision starts with `model`

### B.4 `repair`

- **Runner**: `runRepairScope` (app.jsx:1512)
- **Reached when**: `repairSignal` matched (engine.js:7866); kinds are `frustration`, `contradiction`, `refinement`, `support`
- **Pre-step**: `markObjected()` (app.jsx:1486) tags the prior assistant reply with `objected: true`, which makes future `historyFor` calls prepend the wrapper from app.jsx:1100; called from the dispatcher at app.jsx:2806
- **Mechanical re-read**: rebuilds an anchor question from the most recent non-repair turn + collected refinements + this turn's content, calls `answerScope` on that probe
- **Stages**: zero or two LLM calls
  - If mechanical re-read is clean/warn → settle on it
  - Otherwise, with model ready: shape pass on tagged history + answer pass with the repair-stricter system addendum
- **Repair-stricter addendum** (appended to the standard grounded system):
  ```
  The user has said your earlier replies missed their question — do not
  repeat any earlier reply; answer the question afresh from the spans
  and notes, and if they truly do not answer it, say exactly what they
  DO establish about the subject instead.
  ```
- **Acknowledgments**: one of the `REPAIR_ACKS` variants (frustration / contradiction / refinement / support) is prepended to the final text
- **Veto/salvage**: `echoesPriorReply`, `modelDeclined`, `echoesShapeNote`, plus the standard binding stack; on failure, falls back to mechanical or a "stuck" message

### B.5 `creative` / `creative-compose`

- **Runner**: `runChat(.., 'creative', ctx, scope.length > 0)` (app.jsx:1410, dispatched at 2685 or 2701)
- **Reached when**: user toggled Creative mode, OR `isCreativeCompose(q)` detected a song/poem/story/etc. (engine.js:7845)
- **System prompt**: llm.js:998 — "Use any supplied passages as raw material to compose freely. Do not add citation markers."
- **Stages**: one LLM call
- **Context**: `EOEngine.contextScope(scope, q, 6)` (ungrounded passages, no `[s##]` tags) when a doc is open; empty string otherwise
- **Veto/salvage**: none — citations are explicitly disabled
- **History wrapping**: epistemic tag at app.jsx:1091 marks the turn as `[an earlier creative composition, not a document answer]` in future history calls

### B.6 `computation`

- **Runner**: `runComputeScope` (app.jsx:1783)
- **Reached when**: tabular doc in scope, Python toggle on, model ready
- **System prompt**: assembled in `runComputeScope` (app.jsx:~1820–1870); names the CSV columns and the `run_python` tool
- **Stages**: tool-loop with Anthropic (native `tool_use`); fenced-Python extraction with local wllama
- **Veto/salvage**: every Python execution is audited (code, stdout, stderr, result, duration); a failed call settles as an honest answer, never a broken turn
- **History wrapping**: audit carries the `compute` step with all executions

### B.7 `escalate` (transitional)

- **Trigger**: `route.decision === 'escalate'` (weak-lexical or question-no-lexical)
- **Step**: `EOEngine.retrieveHybrid(scope, q, 6)` (app.jsx:~2816) — lexical hits first, then embedding recall if available
- **Recovery**: on hits, re-route to grounded-llm with `confidence: 'recovered'`; on miss, fall through to plain chat
- **Notes**: cost-ordered — embedding only runs when lexical is too weak. Degrades to lexical-only when no embedder is warm.

### B.8 `carry-grounded` (transitional)

- **Trigger**: no semantic hits AND `lastCarryRef` holds prior turn's question + citations AND (`lastGroundedRef` OR `everGroundedRef`) AND reason is `continuity` or `question-no-lexical`
- **Step**: `carryQuery(scope, q)` (app.jsx:1168) seeds a retrieval through the prior grounded turn's material, called at app.jsx:2839
- **Recovery**: on hits, re-route to grounded-llm with `confidence: 'carry'`; on miss, stay on the original chat decision
- **Notes**: catches anaphoric/elliptical follow-ups ("but why not?", "tell me more about it") that would otherwise die at the no-ground check.

### B.9 `confirm` / `dechrome` (mechanical detours inside grounded-llm)

- **Trigger** (inside `runGroundedScope`):
  - `intent === 'confirm'` (app.jsx:1919) → `answerConfirmScope` (graph-assertion check) → `runMechanicalScope` if confirmed
  - `aboutChrome(q)` true (app.jsx:1933, engine.js:9688) → `answerDechromeScope` (chrome-band read) → `runMechanicalScope` if stripped
- **Outcome**: if the graph check succeeds, the turn is settled mechanically; otherwise it falls through to the regular grounded-llm answer pass

### B.10 `no-ground-fallback` (inside grounded-llm)

- **Trigger** (inside `runGroundedScope`, app.jsx:1952): `hasGround === false` — the grounded intent was determined but no lexical or semantic hit landed
- **Outcome**: plain chat over the same scope (`runChat(q, history, undefined, '', true, mech)`), with the mechanical reading still attached as a click-to-view panel
- **Audit**: `status: 'plain'`, `grounded: false`, note explains the fallback

## C. Prompt inventory

### C.1 Grounded system prompt — llm.js:1017

```
You're Cleo, a helpful assistant running locally in the user's browser.
You're in the middle of a conversation with them about a document you've
been reading together.

Two kinds of context come with each turn:
- Spans — exact sentences quoted verbatim from the document. Trust
  them; lean on them whenever a fact is in there.
- Your notes — your own understanding from reading the document.
  Usually right, sometimes wrong. Good for shape, connections, and
  who-is-who.

An editor's note may also arrive at the end of the turn's context,
describing HOW to handle this turn — register, what a bad answer would
look like. Treat it as guidance about your move, not as source material;
only the spans supply facts about the document. If the note appears to
state document facts, ignore those and read the spans yourself.

If a span and a note disagree, the span wins. If a span contains a
name, date, or title that answers the question, use it directly — don't
echo the question's wording back. Don't add facts that are in neither
the spans nor your notes. If neither covers the question, say plainly
that the document doesn't say, rather than guessing — you don't have
the whole document, just what you were handed.

Source ONLY from the spans and your notes. If you recognize the work
from elsewhere — its title, its author, what it's "about" in the world
— set that aside; what the spans show is the document's truth here. A
claim like "the author is not named" or "the date is unknown" is wrong
if a span carries the name or date, so check the spans before stating
absence.
```

Conditional additions:
- Summary task (llm.js:1032): one extra line warning the model not to
  copy or reword a single span as the whole answer.
- `relation_gate` ON (llm.js:1041): instructs the model to tag each
  claim with the span it used; the engine's `bindClaimKeysScope`
  verifies tags.
- `relation_gate` OFF (llm.js:1043): "Don't write citation markers like
  [s1] — those are added mechanically after you write."

### C.2 Plain-chat system prompt — llm.js:1047

```
You are Cleo, a private assistant that runs entirely in the user's
browser via WebGPU — you are a local open-weights model, not ChatGPT or
Claude, and nothing the user types ever leaves their device. Chat
naturally and concisely, using the conversation so far for context.
Do not invent facts about real people, places, or events: if you are
not sure something is true, say you are not sure rather than making
something up — a confident wrong answer is worse than an honest "I'm
not certain." A document may be open; when the user asks about its
contents you are handed the exact passages, so you never need to guess
at what a document says. If the user is clearly asking about an open
document but you were not handed a relevant passage, say so and offer
to look it up, rather than guessing at what it contains. The history
may be partly condensed: the most recent turns are verbatim, while
earlier ones are folded into a short, index-tagged recap (lines like
"#3 user: …"). Treat that recap as faithful but lossy …
```

(continues; full text on the single line at llm.js:1047)

### C.3 Creative system prompt — llm.js:998

```
You are Cleo, a private assistant running locally in the user's
browser. Use any supplied passages as raw material to compose freely.
Do not add citation markers.
```

### C.4 Shape-pass system prompt — `SHAPE_SYSTEM`, llm.js:1166

```
You are the editor sitting beside Cleo, a local assistant that answers
questions about a document it has read. Before Cleo answers, you hand
it a one-breath director's note: what the user is actually after this
turn, what register fits, and what a bad answer would look like. You
characterize the move — you never answer the question yourself, and
you never state facts about the document.

Examples of the notes you write:

Question: "what's the point of the book?"
Note: They're asking for the through-line — what the book is about
beneath its plot. Synthesis, not lookup: they want your reading, not a
quote. […]

Question: "who wrote it?"
Note: Bibliographic lookup. They want the name. […]

Question (right after Cleo listed characters, including obvious
boilerplate): "project gutenberg is a character?"
Note: Pushback, and they're right — that's boilerplate, not a
character. […]

Question: "thanks, that helps"
Note: Not a question — acknowledgment. […]

Write 2–4 plain sentences in that voice. The note is guidance for HOW
to answer — never the answer itself, and never new facts.
```

### C.5 Repair addendum (added to the grounded system) — app.jsx:1546

```
The user has said your earlier replies missed their question — do not
repeat any earlier reply; answer the question afresh from the spans
and notes, and if they truly do not answer it, say exactly what they
DO establish about the subject instead.
```

### C.6 Degeneracy-veto retry addendum — app.jsx (in `runGroundedScope` retry path)

```
Do NOT copy or lightly reword any single span. Compose a fresh
[summary | answer] in your own words.
```

## D. Shape note: where it lands in the prompt

The note returned by `shapePass` is injected by `buildUserContent`
(llm.js:1232) as the LAST block of the grounded user message, just
before the trailing "Answer the user's question: …" line. The exact
preamble (llm.js:1254):

```
Editor's note on HOW to handle this turn (guidance about register and
approach — not facts about the document; only the spans supply facts):
<note text>
```

Flows that DO use the shape pass:
- `grounded-llm` (always; falls back to `''` on shapePass failure)
- `repair` (model-phrased retry path only)

Flows that DO NOT use the shape pass:
- `plain-chat`, `mechanical`, `creative`, `creative-compose`,
  `computation`, `confirm`, `dechrome`, `no-ground-fallback`
- `escalate` and `carry-grounded` are transitional; they hand off to
  `grounded-llm` or `plain-chat`, which decide for themselves.

On a small model, the note's tail position is exactly the spot the
model continues rather than obeys; the trace that motivated the
recently-added `command` intent showed turn-2's answer pass echoing the
shape note verbatim. The downstream veto (`echoesShapeNote`,
app.jsx:1749) catches a full echo; a leaked clause prepended to a real
sentence is not always caught.

## E. Veto / salvage lanes

All veto checks live in `runGroundedScope` and `runRepairScope`. Order
matters — the first match settles the turn.

| Veto                              | Predicate / where                                                                     | On match                                                |
|-----------------------------------|----------------------------------------------------------------------------------------|---------------------------------------------------------|
| Degeneracy (single-span echo)     | `echoesASpan(scope, q, full)` (app.jsx:85, called ~2183)                              | Retry once with the C.6 addendum; refuse if retry also echoes |
| Model declined                    | `modelDeclined(full)` (app.jsx:1736)                                                  | Fall back to mechanical if usable, else refuse honestly |
| Shape-note echo                   | `echoesShapeNote(full, shapeNote)` (app.jsx:1749) or `looksLikeNote` (~1765)          | Fall back to mechanical or refuse                       |
| **Meta-head (WI-2)**              | `peelMetaHead(full, shapeNote)` — leading meta clause ("The user is asking…", "Not the document.") | Peel the head, bind the tail; if nothing remains → residual / mechanical |
| Echo across turns                 | `EOEngine.echoesPriorReply(text, prior)` (~app.jsx:2131)                              | Flag "same answer as before" + keep                     |
| **Unbound (no passage matched)**  | binding audit `grounded === false`                                                    | **WI-4: residual (void target + bound subject material), else mechanical, else refuse — never the kept-unbound overclaim** |
| Assertion contradiction           | `checkAssertionsScope` returns contradictions                                          | Keep with caveat                                        |
| Relation-gate mismatch            | `checkRelationsScope` (relation_gate ON)                                              | Keep with caveat                                        |
| Kin-subject mismatch              | `checkKinSubjectsScope`                                                               | Keep with caveat                                        |
| Invented terms                    | `inventedTerms(full)` returns non-empty                                                | Keep, strike with `voidInvented`, mark warn             |
| Grounding envelope drift          | `groundingEnvelope` reports leaks (embedder + relation_gate)                          | Mark binding `warn`                                     |
| **Small-tier join-only (WI-6)**   | `tier === 'small'` → `runGroundedSmall` rephrase adds a token / invents / binds outside the fixed cite set | Discard the rephrase, serve the mechanical reading (coverage 1/1 either way) |
| Repair-stage echoes prior reply   | `echoesPriorReply` in repair (app.jsx:1582)                                           | Stuck message instead                                   |
| Plain-chat failure                | LLM call throws non-abort error (~app.jsx:1430)                                       | Retry once with last 2 turns + 2200-token budget; honest error if it fails again |

`modelDeclined` and `echoesShapeNote` are the two that exit to either
`mechanical` (if a mechanical reading is usable) or `refused`
(honest error). The user-visible report on `refused` is the "I drafted
a reply, but the model came back empty / failed audit" message.

**The unbound lane is the dominant truthfulness term.** Keeping a draft
that bound to no passage *as a clean assertion* is the one dishonest move
(it overstates binding status). WI-4 does not discard the draft and speak
the mechanical reading in its place — that was the inversion. Instead the
talker's own sentence is **served as the residual**: its unsupported terms
struck (`{{void:…}}`), the absent target flagged (`{{absent:…}}`), settled
`status: 'residual'` (grounded, a success) with the witness degree (§I)
reading low so the gap is visible *without the talker asserting silence*.
The mechanical reading rides as click-to-view evidence, never as the reply;
an honest refusal is reserved for when the model produced no prose to stamp.
The per-turn unbound count (glass box, §I) is therefore 0 by construction.

## F. History wrapping (`epistemicTag`)

Every assistant message gets a wrapper prepended on its way back into
the model's history. The wrapper lives in `app.jsx:1090` and is applied
by `historyFor` (app.jsx:1109) before every model call.

| Condition                                          | Wrapper (app.jsx:line)                                                                          |
|----------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `mode === 'creative'`                              | `[an earlier creative composition, not a document answer]` (1091)                               |
| `m.retracted`                                      | `[an earlier reply containing a claim that was later checked against the page and RETRACTED — do not repeat or defend it]` (1096) |
| `m.objected` (set by `markObjected` on repair)     | `[the user said this reply missed their question — do not repeat or defend it]` (1100)          |
| `audit.status === 'plain'`                         | `[an earlier reply from general knowledge, not the document]` (1103)                            |
| `audit.status === 'warn' && audit.grounded`        | `[an earlier reply with terms the document does not contain struck as unverified — do not repeat or defend the struck parts]` (1104) |
| `audit.grounded === false`                         | `[an earlier reply that was NOT verified against the document — do not repeat or defend its claims]` (1105) |

**WI-1 (the monotonicity floor, law L1) closed the contamination
cascade.** The wrapper still PREPENDS its badge, but the body it wraps is
now the *model-facing* text, not the display text: `historyFor`
(app.jsx:1109) maps `epistemicTag(m) + stripMarkup(histTextFor(m))`, and
`histTextFor` returns a neutral marker — `(no verified answer this turn)`
— for every non-clean settle (`audit.grounded === false`, `warn`, or
`plain`; refusals with `status === 'error'` are left as-is, being clean
meta-messages already). So a vetoed answer's tokens never ride forward:
the model sees the badge and the marker, never the salvaged-tail garbage a
0.5B used to pattern-match on. The real text stays on `m.text` for the UI
and for the index-recall escape hatch (`recallSpan` reads raw turns, not
this assembled view). Clean turns are byte-identical to before, so parity
holds. The condensed recap inherits the marker because `summarizeTurns`
consumes `historyFor`'s output.

An across-turn L1 check (`l1Violations`, app.jsx) verifies the invariant:
zero by construction; any non-clean turn whose tokens still ride forward
is recorded on the turn header (`l1Violations`) and surfaced in the glass
box as a ⚠ L1 badge (§I).

## G. Small-model and budget notes

- `DEFAULT_BUDGET` (llm.js:1154): 3300 tokens for the assembled
  context.
- Plain-chat retry (app.jsx:~1430): 2200 tokens, last 2 turns only —
  cuts the loss on VRAM exhaustion.
- Shape pass: `temperature: 0.3`, `maxTokens: 90` (llm.js:1207). Tight
  budget keeps the editor's note to 2–4 sentences.
- Recent-turn cap: `RECENT_TURNS = 8` (llm.js:1058) verbatim;
  `WM_RECENT_TURNS = 3` (llm.js:1060) when working memory is carrying
  continuity (the older turns spill earlier to make room).
- Per-turn condensed-recap cap: `SUMMARY_LINE_CHARS = 160`
  (llm.js:1059).
- Anthropic path (llm.js:64): no `temperature` is ever sent (Opus /
  Sonnet 4.x reject it); `max_tokens` is floored at 1024 in the
  computation flow (app.jsx:~1745) because Claude is more expansive.
- CPU-fallback model (app.jsx:~100): phone default Qwen 0.5B; desktop
  default Llama-3.2 3B.
- **Model tier (WI-3), `EOLLM.modelTier(mlcKey)` (llm.js):** the one
  inference-time branch keyed on model capacity. Three tiers — `small`
  (sub-2B local, sized from the wllama registry `bytes` or the MLC key's
  param token), `capable` (large local), `api` (Anthropic). On the
  `small` tier the grounded path:
  - skips the shape pass (net-negative on a 0.5B, and it spends a second
    serial call) — the audit records `shape · skipped`;
  - never free-composes: it takes the join-only path (`runGroundedSmall`,
    WI-6) over the already-bound mechanical reading, capped at
    `SMALL_MAX_TOKENS = 220`;
  - hardens the veto: a partial bind settles as residual / mechanical,
    never kept-with-caveat.
  `capable`/`api` turns are unchanged by the tier gate (they keep the
  shape pass, the depth-scaled cap, and the softened veto).
- **Convergence loop (WI-5)** runs on `capable`/`api` only
  (`runGroundedScope`, gated on `budget.replan`): bind → compute the
  uncovered gap (`coverageGaps`) → re-retrieve on the gap → re-pass, until
  the bound-claim set stops growing (`converged`) or the gap is unfillable
  (`residual-void`, handed to WI-4). Bounded by `MAX_CONVERGE_ROUNDS = 3`;
  the stop reason is recorded as a `converge-stop` step. A turn whose first
  pass already covers the question adds no passes, so the well-covered case
  is exactly today's single pass.
- Embedder gating: grounding envelope, impression query, associative
  wander, and the semantic half of `retrieveHybrid` all skip silently
  when `EOEmbed.ready()` is false. The lexical-first short-circuit
  means a confident lexical hit never pays the embedder cost.

## H. Routing-reason cheat sheet

A turn's audit log carries `path` (the runner that owned it) and
`reason` (the router's verdict). Common combinations:

| `path`            | `reason` examples                                                |
|-------------------|------------------------------------------------------------------|
| `grounded-llm`    | `strong-lexical`, `names-entity`, `continuity`, `pivot`          |
| `mechanical`      | `who`, `summary`, `pivot`, `table-column`, `antimatter-void`, `continuity` |
| `plain-chat`      | `no-scope`, `no-signal`, `command`, escalate-recovered-miss      |
| `plain-unavailable`| any of the above when no model is loaded                         |
| `creative`        | `creative-mode-toggle`, `creative-compose`                       |
| `repair`          | `repair:frustration`, `repair:contradiction`, `repair:refinement`, `repair:support` |
| `compute`         | `compute` (Python over tabular)                                  |
| `calculation`     | math.js direct                                                   |

If a turn appears wrong, the audit's `path` + `reason` is the right
place to start: it names which runner the dispatcher chose and why.

## I. Asymptotic truthfulness (the bound / void / unbound frame)

The grounded path is organized around one invariant: the system should
approach complete truthfulness *from below*, never claim to have reached
it, and never regress. Truthfulness here is honesty about binding status,
not possession of truth. Every claim has three honest relations to the
evidence:

- **bound** — its tokens match a witness span/source (a citation).
- **void** — its target is absent from what was retrieved; recorded as a
  registered absence (`{{void:…}}` / `{{absent:…}}`) and said out loud.
- **unbound** — asserted without a witness. The one dishonest move; it
  overstates binding status.

Per turn, outputs rank by: (1) **unbound count must be 0** (the dominant
term — one unbound assertion is strictly worse than the void in its
place); (2) **coverage** = bound / (bound + relevant voids), rising toward
1; (3) **voids are explicit**, never silent. Two laws the architecture
enforces: **L1 monotonicity** — no turn may feed a prior turn's
unwitnessed tokens into a later turn (WI-1); **L2 approach-from-below** —
when a draft cannot fully bind, the truthful move is the void, never the
partial keep (WI-3/WI-4).

It is asymptotic, not reachable: each turn sees only what was retrieved (a
partial view; the convergence loop adds views), and any binding is
defeasible (later evidence can overturn it — Rule 9). The target is
convergence under a standing revision channel, not arrival.

**The instrument (WI-7).** `EOAudit.truthfulness(final)` (audit.js)
attaches a `truth` block to every settled turn — `{ bound, voids,
unbound, coverage, degree, witnessed, witnessContent, witness }` —
computed uniformly in `end()`, so grounded, chat, mechanical, residual,
repair and compute turns are all measured. The glass box (auditview.jsx)
surfaces it:

- a per-turn chip `N✓ M⟨⟩ K⊥ · D% witnessed` (unbound `K` shown in alarm
  if ever non-zero);
- a ⚠ L1 badge when a turn's assembled history carried a prior turn's
  unverified tokens (`turn.l1Violations`);
- a per-session summary (`TruthSummary`): unbound total (must be 0), L1
  carry-forward (must be 0), and the witness-degree trace — the
  approximation climbing toward the asymptote.

**The witness DEGREE (the asymptote, re-attached).** A stamp that says
verified / not-verified is still arithmetic, just relocated; to leave the
floor the stamp has to carry *degree*. `witnessOnProse` (audit.js) measures,
on the talker's **own** settled prose, the fraction of each sentence's
content tokens that a span witnesses: a sentence that bound to a span
witnesses its content; a `{{void:…}}`/`{{absent:…}}` subtracts what the page
could not carry; an unbound sentence witnesses nothing. The turn `degree` is
the content-weighted mean; the session degree is `Σwitnessed / Σcontent`
across turns. Any standing void or unbound sentence holds it strictly below
1 — approached from below, never reached. This is the quantity the asymptote
attaches to: degree of witness on what was *said*, not a literal string
match (the floor the earlier framing was stuck on).

**The type gate (DEF — the fourth NUL state).** The veto used to decide
"is this capitalized span a referent the page should carry?" with
`body.includes(token)`, an existence-layer operator doing significance-layer
work: a sentence-initial "Give"/"Based"/"Sure"/"What's" was harvested as a
name, failed the substring test, fell into antimatter, and annihilated the
turn. `nonReferentialCaps` (engine.js) now classifies each capitalized token
by **shape** (compromise POS in context) before the presence test. A
*referent* is a nominal (Noun/ProperNoun, not a Pronoun); a *structural*
token (connective, discourse adverb) or *pragmatic* one (imperative verb,
interrogative, interjection, contraction) is **not truth-apt** — the fourth
NUL state (present / absent / never-set are the other three) — and can never
reach antimatter or be struck as invented. Derived, never enumerated: the
same surface flips by role ("Give me the gist" ⇒ dropped vs "The Give was
generous" ⇒ kept), which no word list can do. `referents` / `referentsScope`
/ `inventedTerms` all gate this way.

**EO mapping.** DEF defines what is even truth-apt (the type gate) and the
binding criterion; EVA tests each claim against it (the binder, the vetoes
— now *stamps*, `coverageGaps`); REC restructures when EVA cannot conclude
(gap-retrieve, the convergence loop, the residual). The witness degree is
the approximation, complete witness the asymptote, defeasibility what keeps
it open.

**The grounder never speaks in the talker's place.** The veto stamps; it no
longer gates-and-substitutes. A mis-classified token becomes a `{{void:…}}`
flag on the talker's own sentence (served, read), not a discard. The WI-4
residual attaches a registered-absence flag to the talker's sentence rather
than prepending the mechanical reading as a body; `runGroundedSmall` serves
the talker's flagged rephrase rather than the mechanical text when join-only
breaks; and the mechanical reading rides as click-to-view **evidence** (the
glass box), never as the reply. No raw span or mechanical reading is ever
the chat reply in the grounded path.

**Parity floor.** The type gate edits goldened engine functions *on
purpose* (`referents` / `referentsScope` / `inventedTerms`) — that freeze
was exactly why the defect was unreachable. The change is parity-safe on the
*old* fixtures (a real name, present or absent, is unchanged; only
non-nominals drop) and `tests/parity.js` is re-goldened with **corrected
fixtures** that pin the new invariant: a sentence-initial "Give" produces no
antimatter referent and "Based"/"Sure"/"What's" are never struck invented,
with none of those words in any list. The instrument additions (WI-7 degree)
and the orchestration changes live in audit.js / auditview.jsx / app.jsx.
`tests/typegate.test.js` is the behavioral pin.
