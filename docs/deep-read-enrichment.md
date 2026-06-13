# Deep-Read Enrichment Spec (`cleo-enrich/1`)

**Scope.** A second, offline pass over a finished `cleo-graph/1` graph. The
streaming reader (`engine.js`) is greedy: it commits structure as text arrives,
with only the entity field seen so far. This pass rewalks the whole graph with
the entire field present and repairs, mints, and composes what the greedy pass
could not — then emits an enriched graph plus a per-operation ledger
(`cleo-enrich/1`) that is the publishable receipt for every change.

Implemented in `enrich.js` (publishes `window.EOEnrich`); exercised by
`tests/enrich.test.js` against the NDP/Corman fixture.

## The whole spec in one sentence

**If a rule can decide it, the model never sees it.** The tiny CPU model is not
a reader and not an author — it is a discriminator: a binding oracle consulted
only where a mechanical rule cannot decide, and only ever through a
closed-choice, grammar-constrained, one-token answer with a first-class abstain.
Mechanics enumerate candidates generously; the model prunes narrowly.

## The contract

`EOEnrich.enrich({ graph, sentences, model?, budget? })` → a Promise of
`{ graph, ledger, header, convergence, alignment }`. Pure function of its
inputs: re-running yields byte-identical output. With no `model` it runs in
**degraded mode** — boundary repair, mechanical retypes, exact-alias merges,
mechanical composition — and marks every model-dependent decision `deferred`.

### The alignment precondition (do not skip)

The graph addresses sentences **by index only** and carries no raw text.
`sentences[]` MUST be the identical segmentation that produced the graph. A
misaligned array silently produces correct-looking, wrong enrichments — the most
dangerous failure in the system. `validateAlignment` checks count, index range,
and a surface spot-check, and **aborts with a structured error** on mismatch.

## The model surface (thin by design)

Every model call is a closed-choice, grammar-constrained, one-token answer:

| decision  | grammar                       | abstain |
| --------- | ----------------------------- | ------- |
| anaphora  | `1` `2` `3` `4` `N`           | `N`     |
| merge     | `Y` `N` `?`                   | `?`     |
| type      | `P` `O` `H` `T`               | —       |
| support   | `F` `P` `N`                   | `N`     |

Static prefixes are byte-identical per decision type (KV-cache reuse). Every
hard discrimination runs **permute-and-agree**: the same decision is asked twice
with the options reordered; only a choice that survives the reorder is accepted
(`2/2`), and a flip abstains (`1/2`) and routes to the genuinely-open bin. This
is both a debias against sub-1B position bias and the smallest instance of the
deep-read thesis — the binding that survives a reordering of the lens is settled.

## The role-consistency veto

`subjectMatch(claimSubjectKey, citedIdx, …)` is the fix for the headline bug: a
grounding that cites a real sentence but assigns its predicate to the **wrong
subject** (the Corman/son conflation). The veto mechanically extracts the cited
sentence's grammatical subject and requires it to canonicalize to the claimed
subject (or be coref-linked this run). A mutation that fails to bind is
discarded — no penalty — and routed to re-attribution or abstain.

## The passes (run in dependency order, to a fixed point)

0. **Boundary repair** — strip orphan punctuation (`DMC)` → `DMC`), extend
   strict-prefix truncations (`District Management` → `District Management
   Corporation`), demote standalone role nouns (`Director`). Pure mechanical.
1. **Canonicalization** — blocking generates candidate pairs (shared token /
   containment / edit-similarity); exact-alias and acronym merges are
   mechanical; ambiguous pairs go to the merge oracle. Sub-places like *South
   Nashville* are deliberately **not** auto-merged into *Nashville*.
2. **Type repair** — flag org-head/role-noun suspects, ask the type oracle only
   on the suspects.
3. **Kin / possessive site-minting (the Corman fix)** — a `his son` mints a
   distinct `kin:son:<possessor>` person site, then re-attaches the kin clause's
   predicate off the possessor and onto the new site, vetoed by `subjectMatch`.
4. **Anaphora + null triage** — re-walk `graph.nulls` against the clean
   inventory and sort each into `resolved` / `artifact:*` / `open:textual`. The
   integrity of the `open` bin (genuine textual ambiguity, the journalistic
   signal) is the value of the whole pass.
5. **Composition + spine** — compose transitive edges across sentences
   (`Turner→DMC`, `DMC→NDP` ⇒ `Turner→NDP`), validate each with a support call,
   and order the keystone + support links into `graph.spine`, each link carrying
   its `basis_sentence_idx`.
6. **Adversarial support + silence** — re-judge each claim against its sentence
   and flag over-reach; mechanically detect unfilled claim slots and emit them as
   `omission:*` nulls — an auto-generated records-request list (e.g.
   *self-dealing asserted; the contract was never shown*).

## The ledger (`cleo-enrich/1`)

One flat-JSONL record per operation (mirrors `cleo-audit/1`), carrying
`basis_sentence_idx` (the receipt), the `subject_match` veto result,
`model_calls`, `frames_agreed`, a `confidence` of `settled | supported | open`,
and an `abstained` flag. A header line records the convergence trace (passes
run, mutations per pass, whether the run settled on its own or hit budget). No
abstained op ever carries a structural mutation.

## Fixed point & idempotence

A sweep runs passes 0–6 once; sweeps iterate until no mutation is produced,
`maxPasses` is reached, or the model-call budget is spent (after which the run
continues mechanical-only to convergence). Stable keys (`kin:son:corman`, merged
canonical keys) plus existence guards make the pass idempotent: enriching an
already-enriched graph yields no structural mutations and a byte-identical graph.
