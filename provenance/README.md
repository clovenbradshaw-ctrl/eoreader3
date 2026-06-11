# provenance/

The **bridge** between sources and packs: for any pack REC, which source rows
fed it and which witness events admitted it. One file per pack,
`<pack>.lineage.jsonl`, kept out of the ledger so the ledger stays small and the
lineage stays rich.

A lineage row (the source-compiled shape):

```json
{"pack_seq": 2011, "pack_id": "el-classical-v1:decl_1",
 "source": "unimorph/grc/grc", "source_rows": [4521, 4522, 4530],
 "compiled_at": "2026-06-11T…", "compiler": "tools/packs-build/unimorph.mjs@v0.3",
 "witnesses": []}
```

For a **hand-authored** pack like `el-classical-v1`, `source` names a reference
work and `basis` carries the citation; `compiler` is `"hand-authored"`.

## The witness join

When the reader runs and a pack-sourced row fires against real text, the witness
runner appends to `witnesses` (better: emits a REC in the ledger pointing at this
lineage row — `witnessed seq N, basis: text-anchor:<h>`). The ledger gets the
thin pointer; you join back here to ask *"which source/reference rows did this
text confirm?"* This is the two-sighting gate made operational at pack scale:
the lineage row is the first sighting (the claim); the witness is the second.

`witnesses: []` everywhere in `el-classical-v1.lineage.jsonl` is the honest
current state — the pack is a claim from reference grammars that **no Greek text
has yet confirmed in this reader**. It stays `draft` until it does.

## Why this lives outside the hot path

Projection cost stays `O(ledger)`. Lineage is queried only when someone asks
*"why does the engine believe this?"* — never during a parse. License,
likewise, is recoverable from the `sources/*/MANIFEST.jsonl` row a `basis`
points at, not copied onto every assertion.
