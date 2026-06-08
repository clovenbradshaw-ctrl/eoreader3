# Engine tests & benchmark

The app is a no-build static site, but the engine in `engine.js` is the
deterministic core — what the README calls the *mechanical* intelligence and
what runs, unprompted, on **every** chat turn beneath the language model
(route → retrieve → fold/answer → bind citations). This folder lets that
"unconscious process" be exercised and timed from Node.

## Running

```sh
npm install      # pulls compromise (the engine's POS tagger), dev-only
npm test         # behavioural suite + learning suite + golden parity check
npm run bench    # per-turn timing
npm run demo     # narrated demo of the engine getting smarter over use
```

## What's here

- **`harness.js`** — loads `engine.js` + `pivot.jsx` into a shared `vm`
  context (they publish onto `window` and read global `nlp`), then hands back
  `window`. Also carries the two sample documents from `data.jsx` and a
  deterministic large-doc generator for benchmarking.
- **`engine.test.js`** — 38 behavioural assertions over the mechanical
  contract: prose/table parsing, entity projection, retrieval relevance, chat
  routing (`referencesDoc`), intent, grounded answers, the void path, table
  folds, and citation binding.
- **`parity.js`** — captures the exact output of every path the speed work
  touches across a battery of queries (`golden.json`), so an optimisation can
  be proven to change timing only, never an answer. `--update` re-captures.
- **`bench.js`** — replays a battery of turns against one parsed document (the
  real case: parse once, ask many) and reports median ms/turn and turns/sec.
- **`learning.test.js`** — 14 assertions that the engine *gets smarter over
  use* (below).
- **`demo-learning.js`** — the same behaviour, narrated (`npm run demo`).

## Does it get smarter over use? — yes, and here's how it's tested

The engine ships **no hardcoded speech-verb lexicon**. It *induces* the
speech-verb class from each document's own typography (the quote-attribution
slot), admits a verb after **two sightings**, and accrues **mass** (confidence)
on every confirming sighting. That state lives in a module-level rules ledger,
so it **carries across documents** in a session. The new `_learnedVerbs()`
export makes the induced class and its mass observable, and SIG events expose an
`attributed` field (`named` = clean verb-based attribution vs. `fallback`/`none`).

`learning.test.js` pins this empirically:

- **starts empty** — a fresh engine has induced nothing; a never-seen verb can't
  be cleanly attributed.
- **two-sighting admission** — a verb seen once is not admitted; seen twice it is
  (at mass 2).
- **cross-document transfer** — a sentence whose speaker can only be recovered by
  *knowing* the verb (`"…," quemished Mira.`) attributes via a weak positional
  guess on a **cold** engine, but cleanly (`named`) once the engine has read the
  verb in a **prior** document. Reading changed how the later text is read.
- **confidence accrues** — mass grows with confirming use (2 → 5), while a lone
  single sighting correctly moves it by 0 (the two-sighting guard holds across
  docs).
- **rules, never content** — the learned record holds verbs, never the names or
  prose of the documents.

## The speed change this verifies

`retrieve()` re-tokenised every sentence of the document on every call, and
`retrieve` fires several times per turn (routing, context gathering, and once
per sentence of the model's reply in `bindCitations`). A sentence's tokens
depend only on its text and a fixed stoplist, so they're invariant for the
document's lifetime. Memoising the per-sentence token sets (and the lowercased
body used by the void paths), keyed by document identity, removes the
redundant work.

Measured here (`node tests/bench.js`):

| Document | Before | After | Speedup |
| --- | --- | --- | --- |
| 271 sentences | 2.67 ms/turn (375/s) | 0.46 ms/turn (2,159/s) | ~5.8× |
| 1081 sentences | 10.47 ms/turn (96/s) | 1.68 ms/turn (597/s) | ~6.2× |

`npm test` confirms all 38 behavioural checks pass and all 152 parity
snapshots are bit-identical to the pre-change engine — the answers are
unchanged; only the work is gone.
