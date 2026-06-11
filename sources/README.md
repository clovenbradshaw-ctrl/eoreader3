# sources/

Raw **external data you do not own** — the shoulders the packs stand on.
UniMorph dumps, Universal Dependencies treebanks, Wiktionary scrapes, Apertium
transducers, FSTs. Treat this tree like `node_modules`: fetched on a date, at a
version, under a license; bulky; externally versioned; never hand-edited.

The running engine **never touches this tree** — it is dev-time tooling. The
engine reads only the compiled `memory/packs/*.jsonl`. Re-pulling UniMorph 4.1
recompiles packs; it does not redeploy the engine.

```
sources/
  unimorph/   grc/ la/ ru/ …     MANIFEST.jsonl
  ud/         UD_Ancient_Greek-Perseus/ …   MANIFEST.jsonl
  wiktionary/ grc-2026-06-01.json …          MANIFEST.jsonl
  apertium/   apertium-grc/ …                MANIFEST.jsonl
```

## MANIFEST.jsonl — one row per file

The only way lineage stays honest across re-pulls. One JSON object per line:

```json
{"path":"unimorph/grc/grc","sha256":"…","source":"unimorph","version":"4.0",
 "license":"CC-BY-4.0","retrieved_at":"2026-06-11T00:00:00Z",
 "retrieval_url":"https://github.com/unimorph/grc"}
```

When a source upgrades (4.0 → 4.1) the MANIFEST changes, the `provenance/`
lineage rows get a new source pointer, and a diff emits `update` RECs **only
where the source actually changed its claim**. Without manifests, source
upgrades become silent re-imports and the ledger's epistemic story is fiction.

## Licensing — recorded here, inherited by the pack

`basis` fields in RECs point at a manifest row and inherit its license, instead
of smearing notices across thousands of ledger rows. A pack inherits the
**strictest** license among its sources, which is what matters for
redistribution:

| source | license | caveat |
|---|---|---|
| UniMorph, UD | CC-BY | cite and you're done |
| Wiktionary | CC-BY-SA | share-alike propagates to the pack |
| Apertium, most FSTs | GPL | same caveat |
| Buckwalter | permissive | — |
| Perseus | CC-BY-SA | share-alike |

## Note on this checkout

No external dumps are committed here. Outbound network in this remote
environment is governed by the session's network policy, and large licensed
corpora do not belong in git regardless. The directory carries its structure and
schema; pulls land on a machine that has fetch access.

**`el-classical-v1` was hand-authored from reference grammars, not compiled from
a source dump** (Smyth, Denniston, the Cambridge Grammar — see
`provenance/el-classical-v1.lineage.jsonl`). It therefore has no `sources/`
entry; its first witnesses will be Greek texts the reader reads, not a TSV.
