# Terrain discriminators — making `never-set` stop being the default

*Design note. Not yet built — captured here so the spec can drop on a branch
ready-made. Items 1 and 2 of the void-terrain punch list, written against the
code as it stands, with the exact lines and fields each step needs.*

## The bug this fixes

The four terrains of VOID (`never-set`, `cleared`, `elsewhere`, `impossible`)
are not unwired — they are **siloed by codepath**. Each terrain is whatever its
one feature happens to stamp, never a judgment about the absence itself:

```
  never-set   →  the main never-set loop          (engine.js ~11560–11640)
  impossible  →  answerImpossible, a separate path (engine.js ~11782, via answer() 11816)
  cleared     →  the app retracting its OWN replies (app.jsx ~2110–2120)
  elsewhere   →  the cross-source path
```

Nothing routes between them. So **terrain = which feature fired**, not
**terrain = what the absence is**. The visible cost: when a page *actively
denies* X, the main loop still stamps `never-set` ("the page never says X") —
mere silence — because the only code that knows "page denies the premise" lives
in a path the loop never calls. And when the *document itself* asserts X and
later takes it back, nothing produces `cleared` at all — the only `cleared`
emitter retracts the assistant's own earlier turns, never the page's.

This note specs the two missing discriminators. The headline finding from
reading the code: **they are the same kernel** — a scan for a sentence that
mentions the subject and negates the predicate — entered from two places. That
is why item 4 (a single void-terrain router) is the principled fix and not just
tidy-up: 1 and 2 hand it its two discriminators, already sharing one body.

---

## The shared kernel

Both discriminators ask the same question of the scope: *is there a sentence
that names the subject and denies the predicate?* That question is already
answered, once, inside `detectImpossible`:

```js
// engine.js ~11770–11779  (today, private to detectImpossible)
const NEG = /\b(?:not|never|no|cannot|denied|denies|deny|acquitted|cleared|
              exonerated|refuted|false|untrue)\b|n['’]t\b/i;
for (let i = 0; i < texts.length; i++) {
  const raw = texts[i] || '', lc = raw.toLowerCase();
  if (!subjToks.some(t => lc.includes(t))) continue;     // names the subject
  if (!NEG.test(raw)) continue;                          // carries a denial
  // cessation-verb skip: "did not stop embezzling" affirms the act, so the
  // negation scoping over "stop" is NOT a denial of the act
  if (/\b(?:stop|stopp|cease|quit|gave?\s+up|gives?\s+up|no\s+longer)\b/i.test(lc)) continue;
  if (!actStems.some(a => lc.includes(a))) continue;     // denies THIS predicate
  return { subject, action, idx: i, denial: raw.trim() };
}
```

This is locked inside `detectImpossible`, which is **gated behind a
presupposition-query parse** (`_loadedPresupposition`, `engine.js:11750`) that
only recognizes "when did X *stop* Y" / "is X *still* Y". So the main loop, which
runs on parsed propositions rather than those query shapes, can never reach it by
calling `answerImpossible` — it would return null every time.

**Step 0 (prerequisite for both items): lift the scan out.** Extract a free
function with no dependence on the presupposition parse:

```js
// proposed: a terrain primitive, called from anywhere with a subject + predicate
//   denialOf(texts, subjToks, predStems, opts) → { idx, denial } | null
function denialOf(texts, subjToks, predStems, { cessationSkip = true } = {}) {
  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i] || '', lc = raw.toLowerCase();
    if (!subjToks.some(t => lc.includes(t))) continue;
    if (!NEG.test(raw)) continue;
    if (cessationSkip && /\b(?:stop|stopp|cease|quit|gave?\s+up|gives?\s+up|no\s+longer)\b/i.test(lc)) continue;
    if (!predStems.some(a => lc.includes(a))) continue;
    return { idx: i, denial: raw.trim() };
  }
  return null;
}
```

`detectImpossible` then becomes a thin caller of `denialOf` (no behaviour
change — it keeps its query-shape gate, its subject-known check, and its receipt;
it just delegates the scan). The two new entry points below call `denialOf`
directly.

> **Accuracy note.** This is *not* "call code that exists" — `detectImpossible`
> cannot be called from the loop as-is. It is "**factor the scan out, then call
> it from three places.**" The substance already exists (the regex, the
> cessation skip); the wiring does not.

---

## Item 1 — `impossible` from the main never-set loop

### What the loop does today

The never-set loop has **three branches**. They differ in whether they even look
for a denial:

```
 branch 1  verb+object scan          engine.js 11565–11589   ← DETECTS the denial, discards it
 branch 2  page's own DEF assertions  engine.js 11591–11605   ← no negation scan
 branch 3  recorded-assertion scan    engine.js 11622–11639   ← no negation scan
```

Branch 1 already finds the denying sentence and **throws it away**:

```js
// engine.js:11573 — inside the per-sentence confirmation scan
if (/\b(?:not|never|cannot|no longer)\b|n['’]t\b/i.test(raw)) continue;  // a denial isn't a confirmation
...
} else {
  // engine.js:11586 — falls through to here and stamps mere silence
  lines.push(`The page never asserts that ${subject} ${p.predicate}. … {{absent:never-set:${doc.id}:…}}`);
}
```

The denial that would justify `impossible` is detected at `11573` and dropped on
the floor; the proposition then lands on `never-set` at `11582`/`11586`.
Branches 2 and 3 never scan for a denial at all, so they cannot tell silence from
denial either.

### The fix

Before any branch emits its bare `never-set` stamp, run `denialOf` against the
subject + predicate. If it returns a hit, emit `impossible` instead, citing the
denying sentence.

```js
// in each of the three branches, replacing the bare never-set emit:
const dn = denialOf(texts, subjToks, tok(p.predicate).map(_PRESUP_STEM).filter(t => t.length > 3));
if (dn) {
  const receipt = `the page denies that ${subject} ${p.predicate}`;
  const cm = ` {{cite:${doc.id}:${dn.idx}:s${dn.idx}}}`;
  lines.push(`The page actively denies that ${subject} ${p.predicate}${cm} — it says: “${dn.denial}” ` +
             formatAbsentMarker('impossible', doc.id, receipt));
  checks.push({ ...p, subject, verdict: 'impossible' });   // see verdict note
} else {
  // …the existing never-set emit, unchanged
}
```

Notes that keep this conservative (matching the spirit of `detectImpossible`):

- **Branch 1**: this *replaces* the silent `continue` at `11573`'s downstream
  fall-through — the denial it already saw now becomes the marker instead of
  being discarded. (The `continue` at 11573 itself stays; it still must not let a
  denial count as a *confirmation*. The promotion happens at the fall-through,
  where `hit == null`.)
- **Negation polarity already handled**: the loop's `p.negated` flag still
  governs the surrounding sentence. A *denied* predicate against a page that
  *also* denies it is agreement, not impossibility — `denialOf` should only
  promote when `!p.negated` (an affirmative ask the page denies). Spell this out
  in the branch guard so a "X is not Y?" against "X is never Y" stays on the
  ordinary confirmed-by-absence path.
- **New verdict `impossible`**: the audit consumer in `app.jsx` (the `failed`
  filter at `app.jsx:2083–2085`) keys off verdict strings. `impossible` is a
  *grounded* answer (the page spoke), so it must **not** join `failed` — confirm
  it is excluded there, or the `cleared` self-retraction path will mis-fire on it.

---

## Item 2 — within-document supersession → `cleared`

### What `cleared` covers today

The only `cleared` producer is in `app.jsx`:

```js
// app.jsx:2087 — the population it walks
const prior = messages.filter(m => m.role === 'assistant' && m.text && !m.retracted);
…
// app.jsx:2110–2120 — emits cleared for a SELF-retraction
const clearedMark = E.formatAbsentMarker('cleared', cdoc, clearedReceipt);
```

It retracts the **assistant's own** earlier replies. The destruction-absence
terrain (pradhvaṃsābhāva) properly also covers the **document** asserting X and
later taking it back — *that* sense has no producer anywhere.

### The event-log dependency check (the thing the punch list flagged "confirm before building")

The supersession check wants two facts. Reading the event log:

| field | needed for | status |
|---|---|---|
| **(a)** the asserting event's sentence index | the `cleared` receipt's "said earlier at s_N" | **present.** Every event carries `sentence_idx`; a DEF assertion is `{ op:'DEF', path, value, sentence_idx, sentence, … }` (`engine.js:3747`). `defs`/assertions also expose `.sent`. |
| **(b)** a link from the asserting event to the contradicting one | "and s_M supersedes it" | **absent.** The ops are only `INS`/`DEF`/`SYN`; there is no `NEG`/`RETRACT`/supersession op and no polarity flag on prose events. (The one polarity field, `engine.js:4050–4071`, is Greek-parser-only.) |

So the spec **cannot read a stored contradiction link** — there isn't one. It
must **derive** the supersession at read time, with the same `denialOf` kernel
from Step 0, anchored to the asserting event's `sentence_idx`:

```
  for each subject+predicate the loop is about to stamp never-set:
    A := the page's own asserting event for (subject, predicate)   // DEF/SYN with sentence_idx
    if A exists:
      D := denialOf(texts AFTER A.sentence_idx, subjToks, predStems)   // a LATER denial in scope
      if D and D.idx > A.sentence_idx:
        emit cleared, receipt = `the page asserted this at s${A.sentence_idx}
                                  (“${A.sentence}”) and superseded it at s${D.idx}`
        carry both indices on the marker
```

This is **the item-1 kernel run with a position constraint**: assert-then-deny
rather than deny-outright. Confirm before building only that the asserting event
is reachable from the loop — branch 2 already has `held` (the matching DEF,
`engine.js:11596–11598`) with `held.sent`, so the anchor is in hand exactly where
the supersession check belongs. Branch 3 has the recorded assertions via `defs`
(`d.sent`).

### Scope correctness (folds in item 3)

Once a *document* `cleared` exists, the `app.jsx` path becomes one legitimate
case among two. Emit both through a single shape with a `source` field so the
audit drawer can tell them apart:

```
  {{absent:cleared:DOC:RECEIPT}}            ← today: implicitly self
  → carry source explicitly in the receipt or marker:
     cleared/self      "I said it earlier and the graph-check doesn't support it"   (app.jsx)
     cleared/document  "the page said it at s_N and superseded it at s_M"           (engine loop)
```

Whether `source` rides as a marker segment or as the leading clause of the
receipt is an open call — the only requirement is that `voidsByKind`
(`audit.js:73`) still tallies both as `cleared`, and the chip can render
"I corrected myself" distinctly from "the page corrected itself."

---

## Why this is item 4's groundwork, not a detour

After Steps 0–2, every absence in the never-set loop flows through one decision:

```
                         ┌─────────────────────────────────────────┐
   subject, predicate ──►│  terrain(subject, predicate, scope, hist)│
                         └───────────────┬─────────────────────────┘
                  ┌──────────────────────┼──────────────────────┐
        denialOf hit              denialOf hit AFTER          no assertion,
        (no prior assert)          a prior assertion          no denial
              │                          │                        │
          impossible                  cleared                 never-set
        (page denies)            (page superseded)          (mere silence)
```

`elsewhere` joins as the fourth arm (subject not among this scope's referents).
The router is small precisely *because* items 1 and 2 share `denialOf` — it is
one scan, read three ways by what surrounds the hit. Until then `never-set`
stays the catch-all: the marker can carry the distinction, but the reading
doesn't make it.

## Touch list

| step | file / lines | change |
|---|---|---|
| 0 | `engine.js` ~11770–11779 | extract `denialOf`; `detectImpossible` delegates to it (no behaviour change) |
| 1 | `engine.js` 11573 (branch 1), 11591–11639 (branches 2/3) | promote a detected denial to `impossible` instead of stamping `never-set`; guard on `!p.negated`; new `impossible` verdict |
| 1 | `app.jsx` 2083–2085 | ensure the new `impossible` verdict is **excluded** from the `failed` set |
| 2 | `engine.js` loop, anchored on `held.sent` (11596) / `defs` `d.sent` | derive assert-then-deny supersession via `denialOf` with a `idx > A.sentence_idx` constraint; emit `cleared` carrying both indices |
| 3 | `app.jsx` 2110–2120 + engine emit | add a `source: self|document` distinction to both `cleared` emitters |
| 5 (sep.) | `audit.js:72` vs `engine.js:9025` | a one-line test asserting `VOID_KIND_SET` ≡ `VOID_KINDS`, or import the frozen constant when the engine is present |
| 6 (sep.) | test titles, `docs/operator-void.md` | pin the count: **6 VOID kinds** (4 terrains + `invented` + `unspecified`) + **2 NUL acts** (`ambiguous`, `inference`) = the ambiguous "seven" |
