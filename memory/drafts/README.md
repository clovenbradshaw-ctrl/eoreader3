# memory/drafts/

**Candidate packs** — bulk-imported from a source or in-progress, not yet
witnessed against text. A draft is the *first sighting* (the source's claim); a
draft does not merge into `memory/packs/` until the witness gate has confirmed
enough of its rows against real text (the *second* sighting). The engine should
be able to load a draft in a **reduced-trust frame**, but a draft never projects
as admitted convention.

The promotion criterion is tunable per pack — a closed-class inventory
(prepositions, particles) might promote at ~50% of rows witnessed; a paradigm
table at ~30%, since most endings only ever appear with a handful of stems.

```
memory/drafts/
  el-classical-v2.jsonl     # a revision candidate, not yet merged
  cy-modern-v1.jsonl        # an in-progress pack (Welsh, initial mutations)
```

## Where el-classical-v1 sits

`el-classical-v1` is a deliberate, hand-curated v1 — so it lives in
`memory/packs/` as the canonical fragment, not here. But it carries
`status: draft` in `memory/packs/INDEX.jsonl`, because the *field* and the
*directory* mean different things:

- **drafts/ (directory)** — bulk or in-progress candidates, physically separate.
- **status: draft (field)** — *any* pack not yet promoted to `stable`, whatever
  directory it lives in. `el-classical-v1` is curated but unwitnessed and its
  organs are unbuilt, so it is `draft` in status while living in `packs/`.

Bulk UniMorph/Wiktionary imports land **here** first; `el-classical-v2` and
later revisions land here until witnesses promote them.
