# Packs, sources, and provenance

How bulk, externally-sourced conventions enter a ledger whose charter says
conventions are **assertions, never facts**. The layout is what makes that claim
operationally true when the conventions arrive in bulk from outside: sources are
claims, packs are admitted claims, the lineage is the audit trail, and the
ledger is what the engine actually believes today.

## The three kinds of data a pack wants

| Kind | The work | Best sources |
|---|---|---|
| Paradigm tables | the `DEF` work (declensions, conjugations) | UniMorph (TSV, ~150 langs, CC-BY); Wiktionary Lua modules; Wikidata Lexemes |
| Closed-class inventories | the `SYN member-of` work (function words) | Universal Dependencies (POS-tagged, 140+ langs); spaCy/Stanza stop-words; stopwords-iso |
| Fold rules | orthography, sandhi, mutation, crasis | Apertium (GPL); Helsinki FST / Giellatekno; CLTK for classical |

Attribution verbs and particles are distributional, not paradigmatic: the honest
route is a UD `ccomp`/`parataxis` quoted-speech query for verbs, and a reference
grammar for particles (Denniston for Greek). Per-language specialists worth
knowing: Whitaker's Words / Collatinus (Latin), Perseus Morpheus (Ancient
Greek), INRIA Sanskrit Heritage, Buckwalter (Arabic), OpenCorpora/pymorphy2
(Russian).

## Decision: three trees, not one

```
memory/
  conventions.jsonl              # the append-only ledger ≡ shipped seeds, unchanged
  packs/
    INDEX.jsonl                  # {module_id, language, version, depends_on, status, home}
    el-classical-v1.jsonl        # one fragment per pack (first line = module INS / charter)
  drafts/
    el-classical-v2.jsonl        # candidates not yet witnessed/merged
sources/
  unimorph/ ud/ wiktionary/ apertium/   # raw external data you don't own
    <lang>/ … + MANIFEST.jsonl          # one row/file: sha256, version, license, retrieved_at
provenance/
  el-classical-v1.lineage.jsonl  # row-level: pack-seq ↔ source-row ↔ witness-events
```

- **`sources/`** is external data you do not own — fetched on a date, licensed,
  externally versioned. Treat like `node_modules`. The engine never reads it.
- **`memory/packs/`** is your derived assertions — small, hand-auditable, every
  row a REC the engine folds. The only tree the engine reads.
- **`provenance/`** is the bridge — for any REC, which source rows fed it and
  which witnesses admitted it.

Mixing them forces either huge git churn (every re-pull touches the ledger) or
lost lineage (you can't tell which scrape gave you κύριος as a masc o-stem).

## Pack lifecycle: the witness gate at pack scale

```
source dump ──compile──▶ memory/drafts/<pack>.jsonl ──witness gate──▶ memory/packs/<pack>.jsonl
 (a claim)               (first sighting: source claim)   (2nd sighting:    (admitted assertion)
                                                           reader's text)
```

Bulk imports get **no fast path**. A draft loads in a reduced-trust frame and
never projects as admitted convention; it promotes only when enough rows are
confirmed against real text. Promotion thresholds tune per pack (closed-class
~50%, paradigm tables ~30%). This is the architecture's "two sightings" promise
made operational: the source is the first sighting, the text is the second, and
a pack that never gets a second witness stays `draft` rather than becoming ground
truth.

## Lineage, MANIFEST, licensing

- **MANIFEST.jsonl** (per source dir): `{path, sha256, source, version, license,
  retrieved_at, retrieval_url}`. The only way lineage stays honest across
  re-pulls — a 4.0 → 4.1 upgrade diffs to `update` RECs only where the source
  changed its claim.
- **lineage row**: `{pack_seq, pack_id, source, source_rows, compiled_at,
  compiler, witnesses}`. The witness runner appends to `witnesses` (or emits a
  thin ledger REC pointing back here), keeping the ledger small and the lineage
  rich.
- **license** is recorded in MANIFEST and inherited via `basis`, not smeared
  across rows. A pack inherits the **strictest** license among its sources —
  worth knowing before shipping a mixed-bag pack.
- **build determinism**: same source + same compiler version = same pack bytes.
  Tag every pack with its compiler version and refuse to load a pack whose
  compiler version the engine doesn't recognize, exactly as it would refuse an
  unknown schema.

## Engine-integration status — the honest part

Storing the assertion was genuinely "no code into the engine." Making Greek
*read* was not — an audit found that **none** of the organs the design assumed
("inert universal organs with a table bolted on") actually existed: the
deed-finder was hardcoded positional (`engine.js:4210`), there was no stem fold
(only a fixed diacritic normalizer, `:2366`), no pro-drop path, and
`loadConventions` silently skipped any rule it didn't know (`:1010`). They have
now been **built** — table-driven and inert by default — across three layers.

**Layer A — data + architecture.** The pack file, the three trees, lineage,
INDEX, the validator. No engine change.

**Layer B — the engine reads packs.** `loadConventionPacks` loads
`memory/packs/*.jsonl` as an **additive channel** (the Node tools; `index.html`
via `INDEX.jsonl`); `projectConventions` carries `DEF property:…` structured
tables into a convention's `data`; a pack registers its module. `conventions.jsonl`
stays ≡ seeds — packs never land seed deltas, so the drift test is untouched.

**Layer C — the organs.** `extractGreekGraph` (a self-contained extractor on the
`extractCodeGraph` pattern, reached only when `detectLanguage ⇒ 'grc'`) reads the
`GREEK` tables that `buildGreekOrgans` fills from the pack:

| Capability | Built | Where |
|---|---|---|
| table-driven **stem fold** (crasis/elision, movable-ν, augment, ending strip → stem key) | ✓ | `gfold` / `greekNounAnalyses` / `greekVerbAnalyses` |
| **article agreement** (case/number/gender constrains the noun) | ✓ | the agreement pass |
| **case→role deed-finder** (nom → source, acc → target; order-blind) | ✓ | the deed loop |
| **bound-pronoun** / pro-drop subject from the verb ending | ✓ | the deed loop (`bound_subject`) |
| **Stance face** on every Greek bond `{grain, voice, mood, polarity}`; aorist/imperfect → Figure/Pattern | ✓ | `stance_face` |
| postpositive particles / function words as `grammar` (never indexed) | ✓ | `analyzeGreekToken` |

`tests/greek.test.js` exercises all of it; the 152 parity snapshots are
byte-identical (the organs never run for en/es/zh/code). Each organ is inert
when its table is empty, so the next inflected pack (Latin, Russian, Sanskrit) is
tables, not new engine code — the first richly-inflected pack paid to build them.

**Still open (revisable, not yet built).** Third-declension consonant+σ
interactions (γ/κ/χ+σ→ξ …); the dual; dative/genitive/vocative role edges (only
nominative/accusative deeds today); the genitive absolute; ὁ δέ switch-reference
resolution; middle-voice self-benefit nuance; mood beyond a defaulted indicative
(optative/subjunctive/imperative detection); indirect discourse (ὅτι/infinitive);
attribution-verb speech CONs; agreement at a distance (only adjacent article
agreement today). These stay as the pack's open assertions (`seq 2006`, 2033,
2034, 2062) — the honest edge of what reads.

## Open questions

- **Stance face.** Every Greek CON now carries `{grain, voice, mood, polarity}`,
  populated from the verb's morphology (`stance_face` in `extractGreekGraph`),
  with the aorist/imperfect split landing Figure vs Pattern grain. What is *not*
  yet done is making the slots first-class on **every** language's bonds
  (English bonds would carry the defaults `{Figure, active, indicative,
  asserted}` explicitly) and reading the moods beyond a defaulted indicative —
  the broader "Stance face stops being op-fixed" change. `seq 2006` holds the
  grain rule as a revisable assertion.
- **Compiler language.** The source→pack compilers were sketched in Python
  (`compile_unimorph_to_pack.py`). This repo is pure Node/JS (`tools/*.js`,
  `*.mjs`); the validator added here is Node to match. Recommendation: Node
  compilers under `tools/packs-build/` (no new toolchain, can import engine
  helpers), unless a Python-only linguistics lib (CLTK) forces otherwise for a
  specific source.
- **`build/` collision.** The sketch put compilers in a top-level `build/`;
  that directory already holds the esbuild entry. Pack build scripts go under
  `tools/` (alongside `gen-conventions.js`, `conformance.js`), the established
  home for source→artifact transformers.

## See also

- `memory/packs/README.md` — the three things named "pack"; how to validate.
- `memory/drafts/README.md` — draft vs `status: draft`.
- `sources/README.md`, `provenance/README.md` — MANIFEST and lineage formats.
- `memory/README.md` — the conventions ledger and its provenance anchors.
