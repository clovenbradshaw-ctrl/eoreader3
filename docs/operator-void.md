# Operator voids & the shape-rule ledger

*Design note. Not yet built — captured here so the engine port can finish first,
then this lands on top of the working base.*

## The bug this fixes

Prompt: **"make an ascii chart of what it's saying"**, asked against an essay the
user wrote. The walker NUL'd:

> *"nothing in the index was reached — there is no x to difference."*

That is **false**. The content ("what it's saying") was fully reachable — the
essay is indexed s0–s262. What was actually missing was the **shape**: the engine
has no procedure for the output form "ascii chart", and no way to *say so*.

```
 PROMPT:  "make an ascii chart"   of   "what it's saying"
           └────────┬─────────┘        └────────┬────────┘
              OPERATION (a shape)          ARGUMENT (content)
                    │                            │
         ┌──────────▼──────────┐      ┌──────────▼──────────┐
         │ shape "ascii chart" │      │  index / fold        │
         │   → NOT FOUND  (∅)  │      │  reachable?  YES      │
         └─────────────────────┘      └──────────────────────┘
                    │                            │
        ∅ is on the OPERATOR            content is GROUNDABLE

   the system reported ∅(content) when the real gap was ∅(operator)
```

The auditor then compounded it: it read the model's explanation ("the text is a
series of events…") as a **content claim**, found no span backing it, and
rejected it — correct mechanics, wrong target. The model had no channel to say
*"this is about the operator, not the page."*

## The fix: two void types

The walker today knows exactly one failure — the **referent void** ("the name
you asked for isn't on the page"). Keep it. Add a second.

```
  ∅(content)   → NUL          honest hold  (already works, keep unchanged)
  ∅(operator)  → REC → learn  recognize the missing shape, then route by risk
```

A turn is classified on two independent axes before the walk commits to NUL:

1. **content reachable?** — does `fold()`/retrieval reach anything? (existing test)
2. **operator known?** — is there a shape-rule whose trigger embedding is
   cosine-close to the request's operation clause?

A NUL is only honest when **content** is the gap. If content is reachable but the
operator is unknown, the turn is an operator void, not a referent void.

## Default move: threshold-gated (chosen)

On an operator void, the first move depends on how novel the shape is — measured
as cosine distance from the request to the nearest shape-rule in the ledger.

```
  sim = max cosine( emb(operation_clause), rule.trigger )  over ledger

  sim ≥ θ_apply      → APPLY the matched rule silently (familiar shape)
  θ_ask ≤ sim < θ_apply → APPLY but flag low confidence in the audit badge
  sim < θ_ask        → REC: "I can read it; I don't have a shape for X —
                              show me one example and I'll keep the rule"
```

So low-risk / familiar shapes (close to "make a table", "summarize", a learned
"ascii chart") just run. Genuinely novel shapes stop and ask for an exemplar
rather than guess. Thresholds `θ_apply`, `θ_ask` start conservative and are
themselves tunable rules in the ledger.

When the shape is reachable enough to attempt, the **content** still grounds
normally: fold the essay, render it into the shape, audit the rendering against
retrieved spans the same way prose answers are audited today.

## The shape-rule ledger: rules, never content

This reuses the engine's existing induction pattern. `READING_RULES.attribution_verbs`
already starts empty and induces the speech-verb class from typography — *"any
word observed in the slot twice is admitted; first admission logs a REC, every
confirmation adds mass."* Shape-rules are the same machine on a second axis:
output shapes, admitted from **exemplars** instead of typographic slots, keyed by
**cosine** instead of a slot position.

```
LONG-TERM MEMORY  =  rules, never content
  rule := { id, trigger_embedding, procedure, mass, born_seq }
  born:   on contact with an exemplar (the user showing what the shape is)
  recall: new request ──emb──► cosine ► nearest rule(s)  →  threshold gate above
  mass:   +1 each time it fires uncorrected;  decays (γ) if it stops being right
```

Invariants:

- **No content is stored.** Not the essay, not the conversation. Only the
  procedure and the embedding of the exemplar that taught it. (Same contract as
  the current rules ledger: `engine.js` stores invariants — what was observed —
  never weighted state.)
- **One exemplar admits, repetition confirms.** First sighting logs a REC and
  mints the rule; later cosine-close contacts add mass. A rule's weight is its
  history of being right, exactly as attribution verbs accrue mass.
- **Generalization is automatic.** "chart this", "draw a diagram", "make a
  table" all land near the same neighborhood as a learned "ascii chart" rule, so
  one exemplar covers a family of phrasings.
- **Correction is a SEG.** If an applied shape-rule produces the wrong form and
  the user corrects it, that's a split/repartition of the rule's trigger region —
  same correction path the entity resolver already uses for bad merges.

## Where it plugs in

- **Classification** sits in `runChatTurn` *before* `decideState` can return a
  terminal NUL: split the request into operation vs. argument clauses, test both
  voids, and route an operator void to the REC path instead of NUL.
- **Persistence** extends the existing rules ledger (the OPFS `eo-rules/ledger.json`
  store) with a `shape` bucket of `{trigger_embedding, procedure, mass}` events.
  The embedder is already loaded for reconciliation (`Xenova/all-MiniLM-L6-v2`);
  reuse it for trigger embeddings.
- **Audit** gains a third channel beside grounded/covers/stable: *operator known
  (applied | learned-this-turn | asked)* — so the badge can show "rendered via a
  learned shape" distinctly from "grounded in spans".

## What this is not

- Not a content memory. The ledger never grows with what documents say.
- Not a general code interpreter. A shape-rule is a *procedure the model follows*,
  induced from an exemplar — not arbitrary executable code.
- Not a replacement for NUL. Referent voids still hold. This only stops the
  engine from mislabeling an operator gap as a content gap.
