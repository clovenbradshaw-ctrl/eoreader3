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

The directory architecture above is **data + dev tooling**: it stores the
assertion and is genuinely "no code into the engine." But making a pack actually
*read* is a separate question, and an audit of `engine.js` against the
`el-classical-v1` design found a gap worth stating plainly.

**Today the engine reads exactly one file** — `memory/conventions.jsonl`
(`index.html:34`, and the Node tools). `memory/packs/*.jsonl` is **not on the
reading path**. And even if it were, the pack's rules have no consumers:

| Capability the pack assumes | Reality in engine.js | Verdict |
|---|---|---|
| Table-driven **stem fold** off the paradigm | only fixed diacritic/case fold, `foldDiacritics()` `:2366` | **absent** |
| **`case_roles`** deed-finder | endpoints hardcoded positional — `// first noun = subject, last verb = main verb, last noun = object` `:4210` | **absent** |
| **Bound-pronoun** / pro-drop subject from a verb suffix | subject signals only from overt pronouns/names | **absent** |
| `postpositive_particles`, `switch_reference`, `augment_fold`, `crasis/elision`, `orthographic_fold` | no consumer of any | **absent** |
| Unknown `rule` handling | `loadConventions` silently skips any `rule` not in `READING_RULES` `:1010` | confirmed |
| `DEF property:"table"` | `projectConventions` reads only `DEF path:"value"` `:960` | confirmed (table data dropped) |

The `zh` sub-word gram-mining (`:3124–3166`, driven by `pack.function_chars`) is
the one structural precedent for a table-driven split, but it is fixed-shape
(2–4 char CJK grams), not a configurable ending-strip.

So the charter line *"tables into a pack, no code into the engine"* holds for
**storing** the assertion (done) but **not** for making Greek read. That is a
three-layer job:

- **Layer A — data + architecture (this change).** The pack file, the three
  trees, lineage, INDEX, the validator. No engine change; tests stay green.
  `el-classical-v1` is an admitted assertion, inert by design until B and C.
- **Layer B — the engine reads packs.** Wire `loadConventions` / `index.html` /
  the Node tools to load `memory/packs/*.jsonl` alongside `conventions.jsonl`
  (with enable/disable), and extend `projectConventions` to carry
  `DEF property:…` structured tables into convention values. Adjust
  `tests/conventions.test.js` so packs are an additive channel and the
  `conventions.jsonl ≡ seeds ⇒ zero deltas` contract still holds. Medium; still
  no new *reading* behavior.
- **Layer C — the organs.** Build the table-driven stem fold at the admission
  gate, the `case_roles`-consuming deed-finder, and the bound-pronoun resolver
  that mints a subject SIG from a `conjugation_endings` table — plus the
  crasis/elision/orthographic folds and switch-reference. This is real new
  engine code. It is *universal* (English bonds get the same defaulted slots),
  but it is new: the organs are not currently "inert and waiting," they are
  absent.

Each Layer-C organ is meant to stay register-agnostic and inert when its tables
are empty (like the chrome gate), so adding Welsh or Sanskrit later is writing
tables, not extending the engine again — but the **first** richly-inflected pack
pays to build the organs.

## Open questions

- **Stance face.** The design argues every CON should carry
  `{grain, voice, mood, polarity}`, populated from morphology where a register
  marks it and defaulted where it doesn't (English → `{Figure, active,
  indicative, asserted}`). Greek forces this (aorist vs imperfect grain; middle
  voice; the optative/subjunctive moods). This is a Layer-C+ change to the bond
  schema and the appendix's "Stance face stops being op-fixed" note; `seq 2006`
  holds it as an open assertion. Tracked, not yet built.
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
