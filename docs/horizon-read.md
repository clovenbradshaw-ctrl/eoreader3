# The horizon read — Phase 0 of the semantic-antimatter amendment

Embedder: Xenova/all-MiniLM-L6-v2 @ q8 (warm)
Alignment floor (relation_align_floor, the engine's own constant): 0.45
Method: each string is embedded 6× one-at-a-time and averaged before
quantizing — onnxruntime's parallel reductions jitter a single q8 embed by ~±0.02,
enough to flip a boundary probe across the floor. That jitter is itself the outer
horizon surfacing as instability: a cosine within ~0.02 of the floor is noise.

## Outer horizon — name↔name is noise (representational blindness)

The highest cosine between two DISTINCT admitted entities. A name-rescue
would have to clear this with referential meaning; it has none — the signal
is shared tokens and register, not identity.

| corpus | admitted entities | name↔name max | at |
|---|---|---|---|
| ndp | 3 | 0.340 | District Management Corporation × Nashville Downtown Partnership |
| goriot | 11 | 0.591 | Genevieve × Rue Nueve-Sainte-Genevieve |

The alignment floor is 0.45. name↔name cosine reaches into and past
that band on shared tokens alone, so there is no headroom for a correct name
match to stand out. **The name↔name channel reads EMPTY — confirmed live.**

## The probe table

| ch | corpus | probe | label | nearest admitted | cosine | ruling |
|---|---|---|---|---|---|---|
| NN | ndp | Sorensen | void | Tom Turner | 0.293 | void holds |
| NN | ndp | Halloran | void | Tom Turner | 0.186 | void holds |
| B | ndp | the downtown business group | rescue | Nashville Downtown Partnership | 0.630 | rescue (correct, clears floor) |
| B | ndp | the merchants group that funds cleaning and security | rescue | District Management Corporation | 0.308 | no rescue (below floor) |
| B | ndp | the shell company operator | rescue | District Management Corporation | 0.404 | correct target but below floor (0.404) |
| B | ndp | the corporation that owns the security shell | rescue | District Management Corporation | 0.386 | correct target but below floor (0.386) |
| B | ndp | the partnership president | rescue | Nashville Downtown Partnership | 0.471 | **MISFIRE** (wrong entity, clears floor) |
| B | ndp | the man who runs the security deal | rescue | District Management Corporation | 0.257 | no rescue (below floor) |
| B | ndp | the weather forecast | void | District Management Corporation | 0.102 | void holds |
| B | ndp | the football match results | void | Tom Turner | 0.040 | void holds |
| B | ndp | a recipe for sourdough bread | void | District Management Corporation | 0.090 | void holds |
| A | ndp | Tom Turner | rescue | — | n/a | orthographic (no cosine) |
| A | ndp | Nashville Downtown Partnreship | rescue | — | n/a | orthographic (no cosine) |
| 0 | ndp | Zorthax | void | Tom Turner | 0.226 | void holds |

## Shell verdict, per channel

| channel | rescue floor | void ceiling | shell |
|---|---|---|---|
| A (orthographic) | n/a | n/a | EXEMPT (no cosine — build per Phase 1) |
| NN (name↔name) | n/a | 0.293 | EMPTY → DO NOT BUILD (no rescue clears the floor) |
| B (descr→name) | 0.630 | 0.471 | EMPTY → DO NOT BUILD (a false nomination clears the floor) |
| 0 (true void) | n/a | 0.226 | CONTROL (true void holds @0.226) |

## Verdict

- **Channel A (orthographic): BUILD.** It spends no cosine and is exempt from
  this gate. Highest value, lowest risk — the witness is the admitted surface
  plus the transform that maps it. This is Phase 1.
- **Channel C (coref / alias): BUILD.** Mechanical, no threshold, no Phase 0
  gate. It reuses the chains the engine already builds. Handles the name↔name
  identity case correctly, because coreference is the page's own structure —
  not the embedder guessing two names mean the same thing.
- **Channel NN (name↔name): DO NOT BUILD.** The outer horizon is real on this
  embedder: distinct admitted names cosine up into and past the alignment
  floor on shared tokens alone, with zero referential validity. Forbidden in
  code, not in comments (SPEC §11).
- **Channel B (description→name): shell EMPTY — Phase 4 is NOT authorized.**
  The operating floor is fixed at 0.45 (SPEC §4 forbids a new threshold). At
  that floor a CONFIDENT MISFIRE clears: a false nomination reaches 0.471 ≥ 0.45,
  where the description's own words pull it toward the wrong admitted entity
  ("the partnership president" lands on the Partnership, not its president). The
  one clean rescue ("the downtown business group") rides shared tokens, and five
  of six honest descriptions never clear the floor at all. A correct rescue is
  not separable from a wrong one at the only threshold the constitution allows —
  the inner horizon, document gravity reabsorbing the rescue, exactly the risk
  SPEC §9 names. Channel B does not ship until a corpus reads its shell OPEN with
  the floor held at its measured value. The lexical floor loses nothing by waiting.

> The embedding may nominate. It may never adjudicate. Phase 0 is a read, not
> a build: it changed no engine output. The channels it authorizes (A, C) ride
> a witness; the channel it kills (NN) and the channel it defers (B) never get
> to sign a ruling.

