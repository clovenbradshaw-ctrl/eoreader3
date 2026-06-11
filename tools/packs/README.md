# Conformance packs — conventions, not engine

Register packs for the reading-conformance instrument
(`tools/conformance.js`). Invariant 7 of `docs/reading-conformance.md`
applies to the instrument itself: the check logic knows only the four laws
and the operator schema, and **every surface criterion lives here**, where
it can be doubted, replaced, or disabled per register without touching a
check.

A pack is plain JSON, merged **key-wise** over the checker's
`DEFAULT_PACK` — state only the keys your register changes (a stated array
replaces the default wholesale). The `_register` key is a human note and is
ignored by the checker. A dump's own marks always outrank a pack heuristic:
chrome marked dark with `reason: chrome` in the log needs no pattern here.

```sh
node tools/conformance.js dump.json --pack tools/packs/gutenberg.json
node evo/experiments/conformance-sweep.js            # picks packs per register
node evo/experiments/conformance-sweep.js --bare     # default pack everywhere
```

| pack | register | what it states |
|---|---|---|
| `gutenberg.json` | English books under Project Gutenberg apparatus | chrome: contents/chapter/section heads, roman-numeral lines, `[Illustration…]`, transcriber boilerplate, ALL-CAPS title lines |
| `es.json` | Spanish narrative (engine `es` frame) | Spanish pronouns and function words; chrome: capítulo/índice/prólogo/tasa front matter |
| `zh.json` | Chinese narrative (engine `zh` frame) | Chinese pronouns; chrome: 第N回/章/卷 heads, bracketed apparatus |
| `ja.json` | Japanese narrative (Aozora bunko; read under the engine's zh frame today) | Japanese pronouns; chrome: 底本/入力/校正 colophon, ※ notes, bare kanji-numeral section heads |

These packs are the conformance instrument's conventions. The engine's own
reading conventions live elsewhere (`memory/conventions.jsonl`, the rules
ledger) and are admitted through the gate — seen twice, with provenance.
The two must never blur: a pattern needed to *read* a register belongs to
the engine's conventions through admission; a pattern needed to *judge* a
dump of that register belongs here.
