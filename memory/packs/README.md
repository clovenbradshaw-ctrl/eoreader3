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

## Status: on the reading path for Greek

The engine now loads `memory/packs/*.jsonl` as an **additive channel** alongside
`memory/conventions.jsonl` — `loadConventionPacks` in the Node tools, and
`index.html` (via `INDEX.jsonl`) in the browser. `conventions.jsonl` stays ≡
seeds (the drift test is untouched; packs never land seed deltas).

`el-classical-v1` carries **reading organs**, built table-driven in the engine
and exercised by `tests/greek.test.js`:

- a **stem fold** at admission — crasis/elision expand, movable-ν and augment
  strip, declension/conjugation endings strip → the site key is the stem, so
  Κῦρος / Κύρου / Κῦρον fold to one site (`greek-stem-fold`);
- **article agreement** — an article governing a noun constrains its
  case/number/gender;
- a **case→role deed-finder** — CON endpoints from morphology, not position
  (nominative → source, accusative → target), `greek-case-role`;
- a **bound-pronoun resolver** — pro-drop: a finite verb with no overt
  nominative still mints a subject;
- the **Stance face** on every Greek bond — `{grain, voice, mood, polarity}`,
  with the aorist/imperfect split landing Figure vs Pattern grain.

Every organ is **inert when its tables are empty**, and the whole Greek path is
reached only when `detectLanguage ⇒ 'grc'` — so the 152 parity snapshots
(en/es/zh/code) are byte-identical.

It is still `status: draft`: confirmed by a synthetic test rather than a real
Greek corpus (no text **witnesses** yet — the source/grammar claim is only the
first sighting), and deeper morphology remains open (3rd-declension σ-stems,
dual, mood beyond indicative, genitive absolute, switch-reference, indirect
discourse). See `docs/packs-and-sources.md` for the full picture.

Validate any pack against the same contracts the ledger obeys:

```sh
npm run packs:validate                                  # all packs + drafts
node tools/validate-packs.mjs memory/packs/el-classical-v1.jsonl
```
