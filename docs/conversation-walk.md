# The conversation field as a prior on the graph walk

*Built. The read that gated it: `tools/predictive/read-conv-entry.js`
(deterministic, embedder-free, read-only over the engine as it stood before
the build). The build it gated: conversation-carried entry seeding in
`traverseGraph` / `traverseScope` (engine.js), wired at the app's traverse
call. Pinned by the "conversation field carries the entry" group in
`tests/engine.test.js`. Additive and opt-in — all 152 parity snapshots
unchanged.*

---

## The split this repairs

The reader ran two activation systems that did not talk.

- **Reading activation** — gravity mass/momentum, the cursor, force between
  co-occurring nodes. A living field that steers the reading.
- **Conversation activation** — `conversationField`: each settled turn
  deposits heat on the entities it named and the sentences it cited; heat
  decays by the medium's own γ per turn; `buildWorkingMemory` reads it into
  hot/warm/cold bands.

The conversation heat fed the prompt and nothing else. `traverseGraph` picked
its entry nodes from `namedEntitiesIn` — only the entities the **current
question string** names — and then flooded. The field was never consulted for
where the walk starts. So an anaphoric follow-up ("what about his role")
named almost nothing, the walk returned null, and the anchor the conversation
had been circling for three turns sat hot in the field, computed and unused.

In the classic spreading-activation sense (Collins & Loftus; ACT-R's
activation equation), residual activation from recent use should prime where
search begins. The reader had the decay and the heat; it lacked the priming.

## The read

`node tools/predictive/read-conv-entry.js`

Anchor-annotated conversations (`anchorConversations()` in
`tools/predictive/fixtures.js`): five entity-rich documents (NDP, dispatch,
steward, veranda, Voss), 28 turns, each anchor the analyst's call of which
on-page referent the turn turns on — scored against the engine, never fed to
it. The simulation runs the app's exact turn order: decay, walk, answer
mechanically, deposit matter entities + answer cites at weight 1.

The bar, declared before the run:

- **carry ≥ 60%** — of anchor-bearing turns whose question does NOT name the
  anchor, the anchor is hot at the dial's heat floor (0.25)
- **precision ≥ 80%** — of those turns where any entity is hot, the anchor
  sits in the top 2 by heat (seeding rarely starts a wrong walk)

Measured, on the engine before the build:

| population | n | result |
| --- | --- | --- |
| anchor-bearing turns | 26 | 10 named in the question, 16 not |
| unnamed-anchor turns: shipped walk NULL (no entry at all) | 13/16 | 81% |
| unnamed-anchor turns: anchor HOT at the floor (carry) | 13/16 | **81% — PASS** |
| unnamed-anchor turns: anchor top-1 by heat | 13/16 | 81% |
| anchor in top-2 where any heat (precision) | 13/16 | **81% — PASS** |
| walk-NULL turns a top-2 seed recovers | 10/13 | — |

The three misses share one shape: the conversation had genuinely moved on
(the anchor cooled below the floor, or was never deposited because the turn
that introduced it named it only obliquely). Those are decay working as
designed, not seeding failures.

## The build

`traverseGraph(doc, query, hops, field, heatFloor)` — two new optional
arguments. The top-2 field entities at/above `heatFloor`, resolved onto this
document's graph, join the named entities as hop-0 entry nodes, `via: "hot in
the conversation (heat …)"`. A named entry is never displaced or duplicated.
A question naming nothing now walks when the conversation carries an anchor;
it still returns null when both the question and the field are empty.

The result carries `fieldEntries` separately from `entries`, and the prompt
(`readingContext` / `readingNotes`) labels them honestly: *"It turns on Tom
Turner (Tom Turner carried by the conversation, not named in this
question)."* Legible-THAT: the trace records that the conversation carried
the entry, and with how much heat, never a claim about why.

Parity, three ways:

- callers that pass no field get byte-identical behavior (the suite's 152
  golden snapshots are untouched);
- at the dial's floor, `graphHops` is 0 and `wmHeatFloor` is ∞ — the walk
  never runs and nothing is carried;
- the app passes `conversationField` + `budget.wmHeatFloor` at its one
  traverse call (app.jsx), so the same dial that buys the walk buys the
  carrying.

## Not built (yet)

The conversation named three places the field could enter the walk. This
build is **entry selection only** — the change that stands on its own:

- **Expansion bias** — preferring warm neighbors when a hop chooses what to
  follow. Needs its own read: how often does the warm branch hold the answer
  when the blind branch does not?
- **Target and stop** — conversation focus as part of the seeker's
  satisfaction criterion ("close enough" = close to what the conversation is
  about). Belongs to the seeker build, not the walk.

The deeper unification stands as the direction: a conversation about a text
is a second reading of it, guided by questions instead of page order. One
activation law, two sources of deposit — the page and the chat. This build
makes the chat's deposits steer the walk's start; the rest of the physics is
still split.
