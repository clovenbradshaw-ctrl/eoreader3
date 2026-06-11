# memory/packs/

Per-register **convention packs** — one JSONL fragment per pack, each a slice of
the same append-only ledger as `memory/conventions.jsonl`, kept in its own file
for legibility and per-pack toggling. A pack is a register of conventions
(`el-classical-v1`, `la-classical-v1`, …) expressed in the engine's eo
vocabulary (`INS` / `SYN` / `DEF` / `REC`). The build picture is *one ledger
logically, many files physically*: `cat memory/conventions.jsonl
memory/packs/*.jsonl | sort_by_seq`.

Every row carries its `module`, so even after concatenation a row knows which
pack it came from. By convention the first line of a pack is its module's `INS`
(a one-line table of contents); `el-classical-v1` leads with a
`REC charter-amendment` stating *why* the pack exists, then the `INS module`.

`INDEX.jsonl` is the registry: `{module_id, language, version, depends_on,
status, home}` per module — three packs in you want it, ten packs in you need
it. `status` is `stable | draft | deprecated`.

## Three things named "pack" — keep them distinct

| Location | What it is | Who reads it |
|---|---|---|
| `memory/conventions.jsonl` | The ledger ≡ shipped seeds: `core`, `en/es/zh-narrative-v1`, `code-v1`. The drift test pins **file ≡ seeds ⇒ zero deltas**. | the engine (`loadConventions`) |
| `memory/packs/*.jsonl` | **Additional** register packs (this directory), e.g. `el-classical-v1`. | the engine, *once pack-loading is wired* — see below |
| `tools/packs/*.json` | The **conformance instrument's** packs — surface criteria for *judging* a dump, not for *reading*. A different system entirely. | `tools/conformance.js` |

The last two must never blur: a pattern needed to *read* a register is a
convention here; a pattern needed to *judge* a dump of that register lives in
`tools/packs/`.

## Status: not yet on the engine's reading path

Today the engine fetches exactly one file — `memory/conventions.jsonl`
(`index.html:34`, and the Node tools). **`memory/packs/*.jsonl` is not loaded
yet.** `el-classical-v1` is therefore stored as an *asserted pack* but is inert
with respect to reading behavior, for two reasons the architecture itself
predicts:

1. **No consuming organs.** `loadConventions` silently skips any convention
   whose `rule` is not in `READING_RULES` (`engine.js:1010`), and
   `projectConventions` only reads `DEF path:"value"`, not the pack's
   `DEF property:"table"` (`engine.js:960`). Nothing folds `case_roles`,
   `declension_endings`, `conjugation_endings`, the stem fold, … — they don't
   exist as organs yet (the deed-finder is hardcoded positional,
   `engine.js:4210`).
2. **No witnesses.** A bulk/curated import is the *first* sighting (the source's
   claim). Promotion waits on the *second* — the same surface confirmed against
   real text the reader encounters. Until then a pack sits as `draft`, never
   promoted to ground truth.

This is the charter working as designed: a pack is an **assertion**, admitted by
witnesses, revisable, with provenance — not imported as fact. See
`docs/packs-and-sources.md` for the full architecture and the engine-integration
plan (what "wire pack-loading" and "build the organs" actually entail).

Validate any pack against the same contracts the ledger obeys:

```sh
npm run packs:validate                                  # all packs + drafts
node tools/validate-packs.mjs memory/packs/el-classical-v1.jsonl
```
