# The types of void — VOID is a site, NUL is an act

*A deliberate amendment, by hand, gated by `parity.js` and the goldens. Additive:
the void marker gains an optional **kind**, and a bare `{{void:term}}` /
`{{absent:doc:receipt}}` maps to kind `unspecified` and renders exactly as today.*

## The one word doing the work of many absences

The system had one word, **void**, and it was carrying at least seven different
absences under it. Telling someone a thing is absent is not enough — they need to
know whether it was **never there**, was **there and is gone**, is **somewhere
else**, or **cannot be there at all**. The first cut is the seam between two
things the word *void* was fusing:

- **VOID is the site of nothingness.** A place. A noun. When you ask about a
  thing and the location the question points to holds nothing, that location is
  Void. Its determinate forms are the **four terrains** below.
- **NUL is the non-transformation.** The operator that abstains — the act of
  holding rather than changing. NUL ≠ Void. NUL is what the system *does* when
  there is nothing to do; Void is where it *stands* when it does it. Its forms
  are the **two abstentions** below. They are not voids, because the material is
  present.

A third thing is neither: a **fabrication** with no site — the struck term.

## The seven kinds

### Four terrains of VOID — facts about the site (carried on the markers)

| kind | Nyāya | what it is | renders as |
|---|---|---|---|
| **never-set** | prior absence (prāgabhāva) | the slot was never filled; the page never addressed it | *the document does not say* — with the scan receipt |
| **cleared** | destruction absence (pradhvaṃsābhāva) | a claim that held, then was superseded/retracted; it has a history | *said earlier, and since corrected* — naming what replaced it |
| **elsewhere** | mutual absence (anyonyābhāva) | the named thing is not *this* thing; a real referent, not in this scope | *not in this document* (cross-source: *…but source B mentions it*) |
| **impossible** | absolute absence (atyantābhāva) | a denied presupposition; the site cannot hold the thing | *the question assumes what the page denies* |

### Two abstentions of NUL — facts about the act (NUL events / `{{infer}}`, never voids)

| kind | what it is | renders as |
|---|---|---|
| **ambiguous** | present but unresolvable between candidates; δ-dominance not met, NUL holds | *could be A or B, held* |
| **inference** | the endpoints are on the page, the connection is not; NUL declines the edge | *the page does not connect these* (both endpoints shown) |

### One fabrication — a fact about the system

| kind | what it is | renders as |
|---|---|---|
| **invented** | an INS that should never have fired — a term with no site, **system** provenance | a strike: *this word is not on the page* |

`elsewhere` is the user naming an absent thing; `invented` is the *system* naming
one. That pair is the one an auditor most needs separated, and sharing the bare
`{{void:term}}` marker was the worst of the conflations.

## The marker grammar (a strict superset)

```
{{void:term}}                (legacy) → kind 'unspecified', renders as today
{{void:kind:term}}           (typed)    e.g. {{void:elsewhere:Tom Turner}}, {{void:invented:Zorthax}}
{{absent:doc:receipt}}       (legacy) → kind 'unspecified'
{{absent:kind:doc:receipt}}  (typed)    e.g. {{absent:never-set:voss:no line asserts X}}
```

A marker is **typed** iff its first `:`-segment is a known kind
(`never-set · cleared · elsewhere · impossible · invented · unspecified`). Bare
terms and doc ids never collide with a kind name (proper nouns / source ids), so
every old marker still parses, and `countVoids` (the `{{void:|{{absent:` prefix)
and `witnessOnProse` (the marker *name*, not the kind) are unchanged. The
abstentions get **no** void marker: `ambiguous` is a binding state + pronoun-stall
NUL event; `inference` is `{{infer}}` (not counted by `countVoids`).

Helpers live in `engine.js` (the constitutional core) and are exported:
`VOID_KINDS`, `isVoidKind`, `voidKindIsTerrain`, `voidKindLabel`,
`parseVoidMarker`, `parseAbsentMarker`, `formatVoidMarker`, `formatAbsentMarker`;
the per-kind audit tally is `EOAudit.voidsByKind`.

## Where each is computed

| kind | detector |
|---|---|
| never-set | the scanned `{{absent:…}}` + receipt producers (`answerConfirm`, `bindCitations`, the residual/confirm absence lines) |
| cleared | `maybeRetract` (app.jsx) — the supersession marker naming the retracted claim |
| elsewhere | `referents` → antimatter (`answer`); the cross-source pointer is `crossSourceElsewhere` (`answerScope`) |
| impossible | `detectImpossible` / `answerImpossible` — a loaded question whose presupposition the page actively denies |
| ambiguous | the pronoun-stall NUL event + `resolveBinding` state `ambiguous` (already an act) |
| inference | `markInferred` → `{{infer}}` (already an act, not a void) |
| invented | `voidInvented` → `{{void:invented:…}}` (the strike, system provenance) |

## The membrane

The grounder computes which it is; the **talker is never told the type by name**.
It is handed prose, spans/candidates, and phrases — the vocabulary stays out of
the prompt. The terrains render as states of the site, the abstentions as acts,
the fabrication as a strike, all post-hoc and mechanically. Same membrane.

## The constraint, restated

VOID answers *where there is nothing*; NUL answers *where the system chose not to
move*. never-set carries a receipt, cleared carries a history, elsewhere carries a
pointer, impossible carries a denied presupposition; ambiguous carries its
candidates, inference carries its withheld link; invented is charged to the
system. The system stops saying *absent* when it could say *which* absence — and
stops calling an act of holding an empty place.

## See also

- `docs/void-typology-read.md` — the Phase 0 read (the conflation counts that
  sized this build), regenerated by `node tools/predictive/read-voids.js --write`.
- `tests/void-kinds.test.js` — one fixture per kind, the seam fix, and the parity
  floor.
