# The external-knowledge stratum — step 1, the fix-rate read

This directory is **step 1** of the external-knowledge-stratum spec: the
read-only measurement that gates the build. Nothing here changes engine
output, writes to the log, or ships in the app. It only measures.

```sh
npm run external:read            # deterministic enumeration + replay frozen lookups
node tools/external/read.js --live   # also pay the network; freezes results to cache/
```

The report lands at `docs/external-knowledge-read.md`.

## What it does

The spec wants the lookup to fire on the **residual** — where the reading
broke: NUL stalls, entities that fell to a generic type, unexpanded aliases.
`read.js` enumerates that residual from the live engine trace (no network),
then classifies each failure by **whether external knowledge is even the
right instrument**:

- a **contested-coreference stall** (a pronoun or ambiguous name pulling
  between referents already on the page) is a discourse gap — no dictionary
  or Wikidata entry says which known referent it binds to;
- an **admission-noise** entity (a heading / table-of-contents fragment) is
  an extraction gap — a lookup returns nothing or fabricates;
- the remainder — an abstract noun mistyped `thing` (→ dictionary, the safe
  source) and a well-formed proper referent mistyped (→ Wikidata, the
  dangerous one) — is the **knowledge-shaped** residual a lookup could fix.

The headline is the knowledge-shaped fraction: the *upper bound* on any
achievable fix rate. Low ⇒ the failures are an extraction problem, not a
knowledge problem, and the stratum would polish the wrong layer.

## `lookup.js` — the two sources, behind a freeze/replay cache

`lookup.js` is the instrument, not the shipped stratum. It reads the
dictionary and Wikidata APIs and **freezes** each hit to `cache/<source>.json`
keyed by the query — the Tier-2 cold-store instinct in miniature, and a
later live run can diff against it. Crucially it **abstains rather than
fabricates**: offline with no cache entry, a lookup returns `pending`, never
a guessed answer, so a fix rate is never a fiction. Every frozen record
carries the same `{ src, id, url, fetched_at, hash }` basis a shipped
external DEF would carry.

## Status

The current run is **replay-only**: the live APIs are unreachable in the
build environment (HTTP 403), so every `fix`/`no-fix` cell reads `pending`.
The deterministic findings (which failures are knowledge-shaped at all) need
no network and stand; the measured fix rate needs a `--live` run on a
networked machine, ideally over the real journalism corpus rather than the
two crafted in-repo fixtures. See `docs/external-knowledge-read.md` for the
verdict.
