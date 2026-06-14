# form-genres — the FORM library builder

`form-genres.jsonl` (in the repo root) is the **second** exemplar library. It is
*not* Cleo's voice — that is `exemplars.jsonl`, which is authored. This one is
output **form**: real public-domain / openly-licensed instances of each output
genre, so the centroid per genre is the learned *shape* of that form and a
draft's output can be cosined against it.

It is loaded as its **own** library (`window.EOFormLibrary`, the twin of
`EOShapeLibrary`) and scored against its own genres only — `news-article` vs
`obituary` vs `recipe` is a real contrast; `news-article` vs Cleo's `playful` is
noise, which is exactly why the two libraries never share a file.

## The genres

`news-article`, `obituary`, `recipe`, `encyclopedic-summary`, `plain-report`,
`letter`.

## Building it

The corpus is fetched, never transcribed. `fetch.mjs` reads `sources.json` (the
manifest of real PD/open sources), pulls each, slices one-or-more clean
instances of the genre, and stamps each record with `source`, `license`, and
`retrieved`.

```sh
node tools/form-genres/fetch.mjs --live        # pay the network, freeze, write
node tools/form-genres/fetch.mjs --validate     # check provenance on every line
node tools/form-genres/fetch.mjs --genre=recipe # one genre only
node tools/form-genres/fetch.mjs --direct       # hit origins directly
node tools/form-genres/fetch.mjs --proxy=URL    # override the proxy base
```

Without `--live` the tool runs in **replay** mode: it uses only frozen fetches
(under `cache/`) and pays no network. With no freeze and no `--live` a source is
**skipped, not invented** — a form exemplar with no real source does not go in
the file.

## Three disciplines (borrowed from `tools/external`)

1. **Freeze / replay.** Every payload is frozen under `cache/` keyed by URL, so
   the corpus the file was built from is the version actually fetched.
2. **Abstain, never fabricate.** No source reached ⇒ the record is omitted.
3. **Stamped.** `source`, `license`, `retrieved` on every record — auditable
   provenance, carried into runtime memory by `shape.js`'s `parseExemplars`.

## No vectors, ever

This tool stores **text and provenance only**. `shape.js` embeds each response
at load through the resident MiniLM and recomputes centroids on an embedder
swap, for free — a centroid is a projection recomputed by the fold, never a
thing of record.

## Fair game

Public domain, or an open license that permits this use, with provenance
recorded per record:

- **Project Gutenberg** PD texts — cookbooks (`recipe`), letter collections
  (`letter`).
- **1911 Encyclopædia Britannica** (PD) — `encyclopedic-summary`.
- **Chronicling America** (LOC) pre-1923 newspapers (PD by age) —
  `news-article` and obituaries of the **long dead** (never modern ones).
- **US federal works** (PD by statute) — NWS forecasts, court syllabi —
  `plain-report`.

Nothing copyrighted, paywalled, scraped against terms, or modern.

> Note: in a Claude Code web environment the source hosts (and the proxy) must
> be added to the environment's **network egress allowlist** before `--live`
> can reach them; otherwise every fetch returns 403 and the tool abstains.
