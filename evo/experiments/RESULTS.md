# What creates a better graph for querying against?

A corpus experiment over the reading engine. The engine turns a document into
a **graph** (entities + mentions, speech signals, DEF assertions, relations)
and every answer is a query **against** that graph — so "a better graph" is one
that *resolves* speech, *consolidates* a person into one referent, *covers* the
page, admits *precise* nodes (real names, not capitalized noise), and actually
*answers* when you ask about its heaviest figures.

`graph-queryability.js` measures those five facets **deterministically** over
the public-domain corpus (no API, no embedder fires in Node, so a parse is a
pure function of `(text, rules)` and every number reproduces bit-exact), then
**sweeps** the engine's runtime-tunable physics and reports which settings build
the most queryable graph — and at what cost.

```sh
npm run evo:experiment                          # full sweep, prints the tables below
node evo/experiments/graph-queryability.js --json out.json
node evo/experiments/graph-queryability.js --quick     # fewer configs, faster
```

The harness only ever tunes a **loaded engine instance in memory** via
`EOEngine.applyRules()` and re-parses. It never writes `engine.js`. Turning a
finding into a shipped change still goes through `npm run evo:run` / `evo:accept`.

## The composite

`Q = 0.25·answerability + 0.20·resolution + 0.20·consolidation + 0.20·precision + 0.15·coverage`

| facet | what it measures | how (no labels) |
|---|---|---|
| **answerability** | ask "who/what is X" of the top-K entities by mass — does it return a *grounded, cited* answer? | `EOEngine.answer()` audit |
| **resolution** | speech that lands on a named speaker, not `?` | resolved SIG / total SIG (micro-averaged) |
| **consolidation** | the same person is one referent, not a `Marlow` ⊂ `Charlie Marlow` shard | token-subset shard rate |
| **precision** | are nodes real names, or capitalized noise? a proper noun rarely appears lowercased — a common-noun capital ("Darkness") usually does | single-token entity whose lowercased surface also occurs lowercase in the text |
| **coverage** | fraction of sentences reached by entity-bearing structure | INS/SIG/DEF sentence set |

## Headline finding

**The runtime-tunable knobs are saturated; the lever on graph quality is
admission precision.**

Across the *entire* sweep — `decay-gamma`, `inertia-delta`, `mass-weight`,
`anaphora-weight`, `quote-weight`, `pronoun-floor`, and the one admission knob
`applyRules()` exposes, `two-sighting` — the **max ΔQ is 0.001**. On clean
English, resolution and consolidation are already pinned at **1.0** and the
heavy entities are all answerable, so momentum/gravity/binding physics has
almost nothing left to move. *That is a good result for the shipped engine:* the
defaults are robustly near-optimal and there is no free lunch in the physics.

The Q that *is* left on the table sits in **precision**. Denoising admission
would lift mean precision from **0.897 → 1.0** and Q by **+0.021** — an order of
magnitude past the entire physics sweep — and that surface (the language-module
disqualify lists) is **not reachable by `applyRules()`**: improving it is a code
change, and this experiment localizes exactly where.

### Queryability ranking (English battery, 6 docs)

Every config lands at Q ≈ 0.84; the spread is noise. Representative rows:

| config | Q | ΔQ | answer | resolv | consol | precis | cover |
|---|---|---|---|---|---|---|---|
| baseline (shipped) | 0.843 | — | 0.926 | 1.0 | 1.0 | 0.897 | 0.212 |
| two-sighting=1 / =3 | 0.843 | +0 | 0.926 | 1.0 | 1.0 | 0.897 | 0.212 |
| anaphora/quote/pronoun-floor (all) | 0.843 | +0 | 0.926 | 1.0 | 1.0 | 0.897 | 0.212 |
| inertia-delta=3 | 0.841 | −0.001 | 0.926 | 1.0 | 1.0 | 0.897 | 0.204 |
| mass-weight=0.6 | 0.841 | −0.001 | 0.926 | 1.0 | 1.0 | 0.897 | 0.203 |

The only facet any knob touches is **coverage**, and only via small stall-rate
shifts: a heavier `mass-weight` / `inertia-delta` makes the binder stall more
(holding beats inventing), which trims coverage a hair. Nothing improves Q.

### Where the noise is (baseline, per doc)

| doc | genre | ents | Q | precis | noise nodes |
|---|---|---|---|---|---|
| Metamorphosis | narrative | 2 | 0.878 | **1.0** | — (clean) |
| On Liberty | essay | 45 | 0.909 | 0.956 | `Mind_`, `Women_` (italic emphasis) |
| Father Goriot | narrative | 26 | 0.836 | 0.962 | `Civilization` |
| Heart of Darkness | narrative | 36 | 0.868 | 0.917 | `Darkness`, `Director`, `Change` |
| Notes from Underground | narrative | 8 | 0.766 | 0.75 | `But`, `Well` (sentence-initial markers) |
| Wealth of Nations | essay | 9 | 0.752 | **0.444** | `Nature`, `Causes`, `Wealth`, `Nations`, `Industry` |

Three noise families, all admitted from a capital the engine read as a name:

1. **Capitalized abstractions** — `Darkness`, `Civilization`, `Destiny`, `Change`.
2. **Title / running-header words** — `Nature`, `Causes`, `Wealth`, `Nations`
   (straight out of *An Inquiry into the Nature and Causes of the Wealth of
   Nations*). Non-fiction with a titular header is the worst case (precision 0.44).
3. **Sentence-initial discourse markers** — `But`, `Well`, leading a sentence.

A secondary, related defect the run surfaces qualitatively: **mistyping**.
`Marlow:thing`, `London:thing`, `Director:thing` — the heaviest character in
Heart of Darkness is typed `thing`, which is exactly the kind of node a
"who is …" query should rank as a person. Typing isn't in the scored composite
(no labels), but it rides the same admission path.

## The cross-language diagnostic (not ranked)

Baseline physics, four non-English docs, reported to **size the language-module
opportunity** — not to grade the physics (the en-narrative conventions are
English-only by design):

| doc | lang | ents | Q | answer | cover |
|---|---|---|---|---|---|
| Die Verwandlung | de | 231 | 0.961 | 1.0 | 0.783 |
| Don Quijote | es | 38 | 0.877 | 1.0 | 0.215 |
| Rashomon | ja | 41 | 0.631 | **0.0** | 0.206 |
| Kokoro | ja | 127 | 0.630 | **0.0** | 0.202 |

This is the same admission story from both ends:

- **German over-admits.** German capitalizes *every* noun, so
  `promote_requires_uppercase_first` lets 231 "entities" in and coverage reads
  0.78 — a graph that looks rich but is mostly common nouns. The high Q is the
  precision proxy's blind spot for a language where capitals aren't names; it is
  a *false* richness, the mirror image of the English noise problem.
- **Japanese under-admits.** No case distinction → the uppercase gate admits
  almost nothing queryable → **answerability 0.0**. The engine reads it thinly,
  exactly as documented.

Both confirm the headline: **what creates a better (or worse) graph for querying
is the admission/typing policy, not the momentum physics.**

## Recommendation for the evolution loop

The physics is done — leave `decay-gamma` / `inertia-delta` / `mass-weight` /
the couplings / `pronoun-floor` at their shipped values; the sweep shows no win
there on English. Point the agent at **admission precision** instead, which is
on the evolvable `language-module:en-narrative-v1` surface:

1. **Reject capitalized common nouns / abstractions** that also occur lowercase
   in the same document — the exact signal the precision proxy uses. Cheapest,
   highest-yield change (recovers the `Darkness` / `Nature` / `Wealth` family).
2. **Strip running-title / header words** before promotion (the Gutenberg
   title bleeds into `Wealth of Nations` as five noise nodes).
3. **Disqualify sentence-initial discourse markers** (`But`, `Well`, `And`, …)
   from promotion — extend `base_stopwords` / a lead-disqualify list.
4. **Improve person typing** so a heavy human figure (`Marlow`) isn't `thing`,
   which would also lift "who is …" answerability.

Each is a change to an evolvable rule list (not the constitution, not the
physics constants), so it is exactly the kind of proposal `npm run evo:run` is
built to make and a human to select. This experiment is the *observation* that
justifies aiming it there: **on this corpus, a better graph for querying is a
cleaner one, not a differently-weighted one.**

## Reproducing / extending

- Add a doc to `BATTERY` (English, ranked) or `DIAGNOSTIC` (other languages,
  reported only) in `graph-queryability.js`.
- Widen the sweep in `SWEEP`, or re-weight `Q_WEIGHTS`.
- `--cap N` truncates each doc to N chars (default 14000; lower = faster);
  `--topk K` sets how many heavy entities get probed for answerability.
- `--json out.json` dumps every per-doc facet for a notebook. A snapshot of the
  baseline run lives in `results.json`.

Full run ≈ 95 s on the dev container (20 configs × 6 docs + 4 diagnostics).
