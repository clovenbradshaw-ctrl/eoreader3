# Round 2 — the scale check, and what the small model is actually handed

Two studies this round, both deterministic and reproducible from the repo:

1. **Scale check** — the round-1 queryability sweep re-run at 30,000 chars/doc
   (round 1 used 14,000): does "physics is saturated, admission precision is
   the lever" survive longer documents? (`results-cap30k.json`)
2. **Prompt audit** — `prompt-audit.js`, a new harness that assembles the
   *exact* prompts the small local model (Qwen2.5 0.5B/1.5B, Llama 3.2 1B,
   Phi 3.5 mini — all 4096-token WebLLM prebuilds) is handed over the corpus,
   and measures them. (`npm run evo:prompts`)

The headline: **the round-1 finding strengthens with scale, and the prompt
audit shows the graph noise doesn't stay in the graph — it leads the prompt.**

---

## Part A — scale check (cap 30k)

### The finding holds, and gets worse

| | cap 14k (round 1) | cap 30k (round 2) |
|---|---|---|
| noise nodes / battery | 13 | **31** |
| mean admission precision | 0.897 | **0.847** |
| precision headroom on Q | +0.021 | **+0.031** |
| best tunable gain on Q | +0.000 (saturated) | +0.017 |

Noise **scales super-linearly with document length** — double the text, 2.4×
the junk nodes. New arrivals at 30k: `Administration`, `Come` (Heart of
Darkness), `Pity` (Father Goriot), `Good` (Metamorphosis), `You`, `Underground`,
`Stay` (Notes from Underground), and On Liberty jumps from 2 to **13** noise
nodes (`Liberty`, `Logic_`, `Revolution_`, …). Notes from Underground's
precision falls to 0.583 and its *answerability* falls 0.8 → 0.6 — the junk is
now heavy enough to crowd real figures out of the top-5 the harness queries.

### One genuine physics signal appears at scale

At 14k every knob was flat. At 30k, one config separates:

| config | Q | ΔQ | what moved |
|---|---|---|---|
| `inertia-delta=3` | 0.840 | **+0.017** | answerability 0.90 → 0.967 |
| `decay-gamma=0.95` | 0.833 | +0.009 | answerability 0.90 → 0.933 |
| `mass-weight=0.3/0.6` | 0.832 | +0.009/+0.008 | answerability 0.90 → 0.933 |
| baseline | 0.824 | — | |

On longer documents, a stricter dominance gate (δ=3) and slower momentum decay
(γ=0.95) keep the genuinely heavy figures sticky enough to stay answerable. A
real signal, worth a candidate `evo:run` — but it is still **half** the
precision headroom (+0.017 vs +0.031), and unlike the precision problem it
doesn't grow with document length. The round-1 recommendation stands; the
priority order is unchanged. (The harness's "WHERE THE LEVER IS" summary now
computes this ratio instead of asserting it.)

### The Genevieve case — the graph's heaviest node is invisible to retrieval

Found while auditing a starved prompt. In the Father Goriot slice, the
top-mass entity is `Genevieve` (mass 5.8, typed **person**). It is a shard of
the street name *Rue Neuve-Sainte-Genevieve*. And:

```
retrieve(doc, 'what does Genevieve do?')  →  0 hits     (19 occurrences in the text)
hasGround(doc, …)                         →  false
```

The graph's surface extractor splits hyphenated compounds, so `Genevieve`
becomes an entity; the retriever's tokenizer does not, so `Neuve-Sainte-Genevieve`
never matches the query token `genevieve`. The graph's heaviest node **cannot
be queried through retrieval at all**. The `hasGround` guard correctly routes
the turn to the mechanical path (the model is never handed an empty context),
but mechanically the answer is a void for an entity the entity panel ranks #1.
Three defects in one node: admission noise (a street fragment), mistyping
(`person`), and a graph↔retrieval tokenization asymmetry.

---

## Part B — the prompt audit

What `prompt-audit.js` measures, per corpus doc × query × depth: the exact
system prompt, the assembled context (passages + graph preamble), token sizes
against the 4096-token window the shipped models actually have, and whether the
graph's noise reaches the model.

### B1. The system prompts themselves

| variant | chars | ~tokens | constraints |
|---|---|---|---|
| plain chat | 1490 | 373 | 7 |
| grounded answer, depth 1/2/3 | 342/416/458 | 86–115 | 7–8 |
| grounded summary, depth 1/3 | 361/478 | 91–120 | 3 |
| creative | 163 | 41 | 1 |

The **grounded prompts are lean and well-shaped** for a small model: one task,
explicit faithfulness contract, an exact refusal string ("The passages don't
say.") the app can detect mechanically, and the no-self-written-citations rule
that keeps binding mechanical. Depth scales the *asked-for length*, not the
contract — good design.

The **plain-chat prompt is the heavy one**: 1490 chars in a single
paragraph carrying seven distinct behavioral contracts (identity, no-invention,
document deferral, lossy-recap handling, recall-by-index, multi-ask triage,
honest uncertainty). For Qwen2.5-0.5B this is a lot of standing instruction to
hold across a long chat — and it's the prompt used for *every* ungrounded turn.
Worth a sandbox Prompt-Lab experiment: the recap-handling and multi-ask clauses
only matter in long sessions; a short core + conditionally-appended clauses
(recap clause only when a recap is actually folded in) would cut the standing
load roughly in half.

### B2. Intent routing — one phrasing falls in the gap

`who` and `confirm` turns never reach the model (mechanical / graph-check):
correct and well-protected. But:

| phrasing | route | context the model gets |
|---|---|---|
| "what happens to NAME?" | **summary** | generic salient sample — *chosen with no knowledge of NAME* |
| "what happen**ed** to NAME?" | factual | k=6 retrieval for the question |

The `what happens` branch of `classifyIntent` routes to summary
unconditionally. A user asking about a *specific entity* in present tense gets
passages sampled for a whole-document overview, and a summary system prompt —
the model is then asked about NAME while holding paragraphs that may never
mention NAME. The fix is one guard: check `namesEntity(doc, q)` before letting
the `what happens` regex classify as summary. (Routing, not constitution — but
`classifyIntent` isn't on the evolvable list, so this is a human change, not an
agent proposal.)

### B3. Assembled prompt sizes — comfortable on English, dishonest on CJK

First-turn grounded prompts are modest: **17–36% of the 4k window** including
reply room. Depth 3 adds the graph walk (2–7 preamble lines) and grows factual
contexts from 1–6 passages to 4–15 — the depth dial buys real material, priced
at ~5–10% of the window. No first-turn overflow risk on English.

Two budget problems sit underneath:

- **The default assembly budget (7000 est-tokens) exceeds the 4096-token
  window of every shipped model.** History only starts folding once the chars/4
  estimate passes 7000 — ~1.7× past the real ceiling. The 20-turn synthetic
  session reaches 84% of the window *with* the recap mechanism engaged;
  app.jsx's catch-retry (`history.slice(-2)`, budget 2200) is the load-bearing
  recovery for exactly this overflow. The budget should be ≤ ~3300 for 4k
  models, minus `max_tokens`.
- **The chars/4 estimate under-counts CJK by ~2.4×** (measured on Rashomon:
  est 290 tokens, real ~708). A Japanese document plus history will blow the
  window while the estimator believes it's at 40%. One line fixes the
  estimator: count CJK chars as ~1 token each.

### B4. The graph noise leads the prompt

This is where the two experiments meet. Every summary context opens with the
salient header — *"What the reading came to rest on: …"* — built from the
graph's heavy entities. For every noisy document, **the round-1 noise nodes
are in that header**, ahead of all the passages:

| doc | header the model reads first |
|---|---|
| Heart of Darkness | …came to rest on: Chapman, Marlow, **Darkness**, Ravenna… |
| Father Goriot | …**Civilization**… |
| Notes from Underground | …**But**, **Well**… |
| Wealth of Nations | …**Nature**, **Causes**, **Wealth**, **Nations**… |

The header exists to tell the model what the reading noticed, so the model
synthesizes from the reading instead of parroting a span — a good mechanism
faithfully reporting a noisy graph. A 0.5B model handed *"the reading came to
rest on But, Well"* is being invited to write a summary around two discourse
markers. The same leak reaches depth-3 factual prompts through the graph-walk
preamble ("Nearby in the graph: Nature, Causes…" on Wealth of Nations).

**This upgrades the round-1 recommendation from "cleaner entity panel" to
"cleaner prompts":** admission noise is not a cosmetic defect in a side panel;
it is text the small model is told to treat as the document's own emphasis.

Also in the passages: **title-page chrome**. 1–5 of the salient picks per doc
are furniture — `[s0] Heart of Darkness`, `[s1] by Joseph Conrad`,
`[s2] Contents` — because salientContext takes the first sentences of the
document and of each block. Harmless-looking, but on a 16-passage budget,
3 chrome lines is ~20% of the evidence the model gets.

### B5. The talker-portrait prompt — the well-built one

System 425 chars (~107 tokens, 6 constraints), user blocks ~215 tokens,
one-paragraph ask, EVA-audited draft, one retry that *names the rejection
reasons*, deterministic fallback if both drafts fail, and a final guard that
throws if machinery vocabulary leaks. This is the prompt the evo loop is
allowed to evolve — and the audit's view is that it's already the
best-engineered prompt in the system; the evolvable headroom is in the
*portrait content* it's handed (which inherits the same graph noise), not the
instruction text.

---

## What this round recommends

In priority order:

1. **Tighten admission (unchanged from round 1, now with teeth):** the noise
   is in the model's prompts, not just the panel, and it grows super-linearly
   with document length. Evolvable surface; right shape for an `evo:run`
   proposal.
2. **Fix the `what happens to NAME?` routing gap** — one `namesEntity` guard
   in `classifyIntent` (human change; not on the evolvable list).
3. **Make the token budget honest:** default ≤ ~3300 for the 4k models and a
   CJK-aware estimator in `llm.js` (`est`). Two small human changes.
4. **Close the graph↔retrieval tokenization asymmetry** (the Genevieve case):
   either retrieval tokenizes hyphen compounds into parts, or admission keeps
   the full retrievable surface. Until then the graph can rank an entity #1
   that no retrieval-backed question can reach.
5. **Skip chrome in salient picks** — don't spend passage slots on title-page
   furniture.
6. **Sandbox candidate: a lighter plain-chat prompt** — conditional clauses
   instead of the 373-token monolith; testable in the existing Prompt Lab.
7. **(From the scale check)** `inertia-delta=3` / `decay-gamma=0.95` are worth
   a candidate run for long documents — real but secondary (+0.017 vs +0.031,
   and it doesn't compound with length the way noise does).

## Addendum — recommendations 1–5 implemented

The five mechanical recommendations above were applied (engine.js + llm.js;
goldens recaptured — 5 intended snapshot diffs, all noise-removal; all 406
behavioral tests pass; the fixture battery is unchanged at 0.815):

1. **Admission tightened** — new evolvable rule `lowercase_evidence_disqualify`
   (en-narrative-v1): a single-token capitalized surface whose word also stands
   lowercase in the same document is a common noun, not a name. Plus Gutenberg
   italic underscores (`_Mind_`) stripped in `cleanEntitySurface`.
2. **Routing guard** — "what happens to NAME?" (capitalized target) now routes
   factual; bare "what happens?" / "what happens in the story" still summarize.
3. **Honest budget** — `llm.js` default assembly budget 7000 → 3300 (fits the
   4096 window with the 520-token max reply), and the token estimator counts
   CJK chars as ~1 token (120 JA chars → 120, was 30).
4. **Hyphen asymmetry closed** — `tok()` also emits the parts of hyphenated
   compounds, so `retrieve(doc, "what does Genevieve do?")` goes 0 → 5 hits.
5. **Chrome skipped** — `salientContext` drops short, punctuation-less
   title-page lines from its picks (with a fallback if that empties them).

Skipped by design: #6 (the lighter plain-chat prompt — the report's own advice
is to test it in the sandbox Prompt Lab first) and #7 (physics retune — a
candidate for a future `evo:run`, not a default change).

Measured after (14k battery, `results-after-fixes.json`):

| | before | after |
|---|---|---|
| Q (baseline config) | 0.843 | **0.881** |
| admission precision | 0.897 | **1.000** (0 noise nodes, was 13) |
| answerability | 0.926 | **1.000** |
| noise leaked into prompts | Darkness / Nature·Causes·Wealth·Nations / But·Well | **none** |
| "what happens to Gregor?" | generic salient sample | 6 Gregor passages, grounded, 3 cites |

## Reproducing

```sh
npm run evo:experiment                                  # round-1 harness (14k cap)
node evo/experiments/graph-queryability.js --cap 30000  # the scale check
npm run evo:prompts                                     # the prompt audit
node evo/experiments/prompt-audit.js --dump pg219       # one full prompt, verbatim
```

Snapshots: `results.json` (14k), `results-cap30k.json` (30k),
`prompt-audit.json`. All numbers above are deterministic — no API, no
embedder fires in Node.
