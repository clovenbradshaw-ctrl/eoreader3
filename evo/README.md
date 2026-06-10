# evo/ — the evolution scaffold

A development-only agentic loop that evolves the Cleon reading engine. An
agent reads the engine's own traces, proposes one change to the *physics* or
the *prompts*, applies it in a sandbox, reruns the harness, scores the result
against two fitness functions in tension, and surfaces a diff plus an argument
for a human to select. **It never ships, never touches production, never merges
itself.**

> The agent amends the laws; it never amends the constitution. It proposes; you
> select. Parity is the floor, quality is the hill, and the tension between them
> is the only reason the loop moves at all.

## The one idea this protects

Parity alone rewards standing still — any behavior change risks a golden diff,
so an agent optimizing only for parity learns to propose nothing. So the loop
runs **two** scores in tension:

- **Parity (the floor)** — `tests/parity.js` against `tests/golden.json`, run on
  the candidate engine. Zero diffs = behavior unchanged. The agent may not
  *silently* break it.
- **Quality (the hill)** — a composite the agent climbs, computed on a labeled
  battery under `evo/fixtures/`:
  - **2a pronoun-binding accuracy** (deterministic, no API) — does each quoted
    line bind to the correct speaker?
  - **2b stall honesty, F1** (deterministic, no API) — did `NUL` fire where a
    site is genuinely ambiguous and stay quiet where it's clear? This is the
    component that punishes an agent for suppressing honest "I don't know"
    stalls to look confident.
  - **2c integration quality** (one API call per fixture, or a fixed stub) — a
    rubric over the engine's grounded reading. The gameable one, so it is the
    lightest third and a human sits at selection.

  Default weights (on the ledger in `config.json`): binding 0.35, stall 0.35,
  integration 0.30 — the two deterministic components outweigh the gameable one
  on purpose.

A change is **clean** (0 parity diffs + quality up → mergeable on quality
alone), a **justified break** (parity diffs + quality up past threshold →
requires a human golden recapture), a **regression** (parity diffs + quality
flat/down → auto-rejected), or **null** (clean but no gain).

## The constitution (enforced by `allowlist.js`)

**MAY evolve:** the physics constants `decay_gamma` / `inertia_delta` /
`mass_weight` (and the distance-gravity rules `gravity_alpha` / `gravity_offset`
if present); any `READING_RULES` entry whose `src` is `hardcoded-seed` or a
`language-module:*` (attribution patterns, pronoun inventories, title tokens,
clitic suffixes, …); and the talker portrait prompts (`system` + retry).

**MAY NOT touch (rejected mechanically, before any rerun):** the mechanical EVA
checks (`evaDraft`), the grounder (`groundTalkerOutput`, `bindCitations`), the
nine-operator vocabulary and `projectGraph` replay, the append-only log, and the
agent's own exams — `tests/parity.js`, `tests/golden.json`, and the fixtures.
The audit/grounding thresholds (`audit_bind_floor`, `audit_resemblance`,
`audit_paraphrase_strong`) are carved out as constitutional even though their
`src` is `hardcoded-seed`, because they parameterize the citation-binding
integrity guarantee.

The gate is **positive allow-listing**: a change is accepted only if every line
it touches sits inside an evolvable region, so the constitutional surfaces are
excluded by construction.

## Run it

```sh
npm run evo:run                 # a full session → a proposal + observations
npm run evo:review <run-id>     # print the proposal: diff, deltas, argument, REC log
npm run evo:accept <run-id>     # the ONLY path to engine.js; re-runs npm test as a final gate
npm run evo:reject <run-id>     # archive the run, keep the observations, discard the patch
npm run evo:score               # print the current quality baseline (deterministic)
```

### Corpus experiments (what makes a *queryable* graph)

```sh
npm run evo:experiment          # measure graph queryability over the corpus + sweep the physics
```

`evo/experiments/graph-queryability.js` is a read-only study, not part of the
selection loop: it builds the engine's graph over the public-domain corpus and
scores how *queryable* it is (does speech resolve, do entities consolidate, are
the nodes real names or capitalized noise, does "who is X" return a grounded
answer), then sweeps the runtime-tunable physics to see what moves it. The
finding — physics is saturated, admission precision is the lever — is written up
in `evo/experiments/RESULTS.md`. It tunes a loaded engine in memory and never
writes `engine.js`.

`evo:run` writes:
- `evo/proposals/<run-id>.md` — the human-facing report: **"how to improve the
  app"**, the diff, the argument, an evidence table, and what else was tried.
- `evo/proposals/<run-id>.diff` — the patch `evo:accept` applies.
- `evo/observations/<run-id>.md` — every generation's hypothesis, parity/quality
  deltas, and a **REC log** in the engine's own nine-operator vocabulary (the
  engine's evolution recorded in the same operators as everything else it does).

## Providers & the API budget

The agent has two providers, chosen by `provider: "auto"` in `config.json`:

- **offline** (default when no key) — a deterministic, zero-token scripted
  agent. A full `evo:run` works with no setup and produces a real proposal.
  Used for the demo and for CI.
- **live** — the Anthropic API (`@anthropic-ai/sdk`, `claude-opus-4-8`, adaptive
  thinking). It **asks you for the API key** if `ANTHROPIC_API_KEY` is unset
  (press enter to fall back to offline). Per hypothesis it may first
  **investigate**: a bounded tool-use loop where it ingests a document (a
  fixture id, a corpus filename like `pg219.txt`, or raw text), asks the engine
  a question, and sees how it reads — *injecting sample inputs* — before it
  proposes. Then it changes the code, the runner reruns + scores, and offers
  the report.

**Token frugality** (experimental phase), all in `config.json`:

- `tokenMax` — the **primary** governor. The live agent meters input+output
  tokens across every call; when the cap is reached the run **pauses and asks
  you to continue** (extend) rather than silently stopping. Set it small and
  extend deliberately.
- `apiCallBudget` — a secondary hard ceiling on call count.
- `maxProbeRounds` — how many times the agent may probe the engine per
  hypothesis before it must propose.
- `integrationSampleSize` / `maxRubricDocChars` — bound how many 2c fixtures get
  a live rubric and truncate the source sent to the judge.
- `scoreTalkerLive` — off by default (the talker LLM would double call volume).

To use the live provider: `npm install @anthropic-ai/sdk`, then run `evo:run`
and paste the key when asked (or export `ANTHROPIC_API_KEY`).

## Layout

```
evo/
  runner.js        # the generation loop, sandbox, scoring, classifier, REC logger, CLI
  agent.js         # observe → hypothesize → patch → argue (offline + live providers)
  scorer.js        # the quality battery (2a/2b deterministic, 2c API/stub)
  allowlist.js     # the constitution as code (path + target validation)
  patch.js         # render structured edits → source + unified diff, re-validate
  engine-host.js   # load a candidate engine into a VM (mirrors tests/harness.js) + traces
  config.json      # weights, thresholds, budgets, models
  fixtures/
    binding/       # 2a: docs + labeled speaker bindings
    stalls/        # 2b: docs + labeled should-stall / should-bind sites
    integration/   # 2c: docs (+ rubric focus) across genres incl. non-Latin script
  corpus/          # public-domain texts to experiment with (Gutenberg EN + Aozora JP)
  work/<run-id>/   # branch copy + sandbox (gitignored)
  observations/<run-id>.md   # the REC log (gitignored)
  proposals/<run-id>.{md,diff}  # the proposal (gitignored)
```

The `corpus/` is experiment material — public-domain literature in several
languages (English classics from Project Gutenberg; Akutagawa, Dazai, and Sōseki
from Aozora Bunko). The Japanese texts make the *language-module* evolution
surface concrete: the engine reads them thinly because its conventions are
English-only, which is exactly what a future language module would evolve.

Run artifacts (`work/`, `observations/*.md`, `proposals/*`) are gitignored — they
are per-run, local, and regenerated by `evo:run`.
