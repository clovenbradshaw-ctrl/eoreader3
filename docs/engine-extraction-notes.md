# engine.js extraction notes

> Source-level reading of `engine.js` and `app.jsx`, for the strangle
> plan in [`extraction-targets.md`](extraction-targets.md). Anchored by
> `file:line`. Not deduced from the map.

## 1. Call-site distribution of `projectGraph`

The map calls out "~60 internal couplings." The actual count is **~20**,
as grepped from the live source:

| File             | Sites   |
|------------------|---------|
| `engine.js`      | 15      |
| `composition.js` | 1       |
| `tests/walker-survival.js` | 2 (uses `E._projectGraph`) |

The in-engine call sites are clustered:

- `engine.js:3688, 3764, 4083` — early projections (probably summary / first reading).
- `engine.js:6482` — inside parse, post-admission.
- `engine.js:6827` — the definition.
- `engine.js:7978, 8021, 8461` — retrieval-adjacent (this is where the memo win concentrates).
- `engine.js:9749–9821, 10636` — graph audit / impression / field measurement.
- `engine.js:13069, 14441` — late path, route + final fold.

The memoization win is still real — most call sites read the same
`(events, frame)` repeatedly inside a single turn — but the surface to
rewrite during extraction is smaller than the map suggested.

## 2. `projectGraph` is NOT a pure function of `(events, frame)`

Definition at `engine.js:6827`:

```js
function projectGraph(events, frame = {}) {
  const horizon = (frame.cursor == null || !isFinite(frame.cursor)) ? Infinity : frame.cursor;
  const edgeAffinity = (frame && frame.edgeAffinity) || null;
  …
  // § Pass 2.5: field measurement under the current frame
  const γ = READING_RULES.decay_gamma.value;    // ← ！……… line 7052
  …
}
```

`READING_RULES` is a module-scoped `const` at `engine.js:377` (§"the
rules of reading made auditable"). `projectGraph` reads
`READING_RULES.decay_gamma.value` directly in Pass 2.5 — the field
measurement that drives mass, momentum, and gravity-based edge weights.

The comment at `engine.js:7040–7047` is honest about this:

> Mass, momentum, gravity, overlap are NOT stored on events — they are
> measurements of the field relative to this frame: this replay, run
> under the current rules, couplings, and cursor… Change γ, demote a
> token, recalibrate a reader, move the cursor: same events, different
> measurements.

So: `projectGraph` is pure on `(events, frame, READING_RULES)`. The
comment treats γ as part of the frame conceptually — the code reads it
from module scope.

### Implications for the eo-core extraction PR

Two options, listed in order of preference:

**(a) Lift `decay_gamma` (and any other `READING_RULES.*` read) into
the frame parameter.** Pre-resolve at each call site:

```js
const frame = {
  cursor, edgeAffinity,
  rules: { decay_gamma: READING_RULES.decay_gamma.value },
};
const g = projectGraph(events, frame);
```

Now `projectGraph` is genuinely a pure function of its parameters,
the memo key `(events.length, frameSig)` is correct, and the rules
become an explicit dependency at every call site. The 20 call sites
are manageable; this is the cleanest cut.

**(b) Include a rules-rev token in the memo key.** Keep the closure
over `READING_RULES` but add a counter that bumps on any mutation:

```js
const key = `${events.length}:${frameSig}:${RULES_REV}`;
```

This is closer to today's behavior and works as long as
`READING_RULES` mutates through one chokepoint. Risk: any future
uncounted mutation silently stales the memo.

**Recommendation:** (a) for the eo-core PR. It's the one extraction
that permanently fixes the impurity — not a workaround.

### What else `projectGraph` reads from module scope

From the read of `engine.js:6827–7100`:

| Name | Kind | Risk |
|---|---|---|
| `READING_RULES.decay_gamma.value` | mutable rule value | the impurity above |
| `normSurface` | pure helper | comes along trivially |
| `pickCanonicalForm` | pure helper | comes along trivially |
| `PRONOUN_LEAD_SET` | frozen constant | comes along trivially |
| `isPronoun` | pure helper | comes along trivially |
| `isSiteSyn`, `isTextSyn`, `slotsOf` | locals | already inside the function |

Only `READING_RULES` is a live extraction risk. The helpers are pure
and can be co-extracted into `eo-core/internal/`.

## 3. `extractEoGraph` has explicit module-scope side effects

Definition at `engine.js:4223`:

```js
async function extractEoGraph(text, onProgress) {
  const LANG = detectLanguage(text);
  applyLanguageModule(LANG);          // ← mutates LANGUAGE_MODULES
  TRANSCRIPT_ACTIVE = false;          // ← mutates module-let at :229
  …
  if (LANG === 'en') {
    TRANSCRIPT = readTranscript(text);
    if (TRANSCRIPT) {
      LANGUAGE_MODULES['transcript-v1'] = { … enabled: true, … };  // ← mutates
    } else if (LANGUAGE_MODULES['transcript-v1']) {
      LANGUAGE_MODULES['transcript-v1'].enabled = false;          // ← mutates
    }
  }
  TRANSCRIPT_ACTIVE = !!TRANSCRIPT;   // ← mutates
  …
}
```

The declarations:
- `let TRANSCRIPT_ACTIVE = false;` at `engine.js:229`
- `const LANGUAGE_MODULES = { … };` at `engine.js:319` (object is `const`,
  its contents are mutated)

### Implications for the parse extraction PR

The parse holon must **own** `TRANSCRIPT_ACTIVE` and
`LANGUAGE_MODULES` explicitly. Two reasonable shapes:

**(a) Pass them in, return them out.**

```js
const { events, languageModules, transcriptActive } =
  parseText(text, { languageModules, transcriptActive });
```

Makes parse a pure function of its inputs; the caller is responsible for
threading state. Verbose but legible.

**(b) Bind a parser instance.**

```js
const parser = createParser({ languageModules });
const doc = await parser.parse(text);   // mutates parser.languageModules, parser.transcriptActive
```

The parser instance owns the state. Multiple parsers can coexist with
different module sets.

The map's `binding` / `coref` suites today work because tests construct
fresh state for each case. Either shape satisfies that; (b) is closer
to the current call site.

**Recommendation:** (b). The parse holon becomes a factory, not a pure
function; the state stays at the holon boundary; the existing tests
port with one line of setup.

## 4. CON is the ninth operator — confirmed in source

Line 6855:

```js
const isRelationEdge = (ev) => isTextSyn(ev) || ev.op === 'CON';
```

Line 6924:

```js
if (!['SYN', 'CON', 'DEF', 'SIG', 'INS'].includes(ev.op)) continue;
```

CON is a first-class operator in `projectGraph`. The README's
8-operator list is stale; the map is correct.

The operator vocabulary in eoreader4 is therefore right:
`NUL, SEG, DEF, SIG, CON, EVA, INS, SYN, REC`.

## 5. `seedEvents` confirmed dropped on the live path

`app.jsx:1147`:

```js
const { text, provenance } = B.eventsToText(route.capability, events);
```

Only `text` and `provenance` are destructured from the adapter events;
`seedEvents` are never read. Confirmed: the layout structure channel
computed in `import-structure.js:679` does not reach `parseDocument` on
the live path.

### Implications for step 0 (bench-clearing)

This is a phase-zero decision, not an extraction risk. Options:

- **Stop computing.** Delete the `seedEvents` reconstruction from
  `import-structure.js`. Smaller bench, less drift.
- **Wire it.** Change `app.jsx:1147` to also pass `seedEvents`, and
  teach `parseDocument` to ingest them. Adds a real structure channel
  the graph has been missing.

The map flags this as undecided; resolve before freezing the `parse`
interface, so the seam reflects the actual data flow.

## 6. The `tok` closure

Definition at `engine.js:41`:

```js
const tok = (s) => {
  const raw = (String(s).toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || [])
    .map(t => t.replace(/['’]s$/, ''));
  …
  return out.filter(t => t.length > 2 && !QA_STOP.has(t));
};
```

`tok` is a `const` arrow function at file scope. It closes over
`QA_STOP`, which is a module-scoped constant defined a few lines above
(line 28–30) — frozen set, no mutation observed.

**Implication:** `tok` is pure. It can move to `eo-core/internal/tok.js`
(or `parse/internal/tok.js`) trivially. No closure-state risk. The map's
emphasis on "the single tokenizer" is correct — keeping it the only
tokenizer in the system is a discipline, not a refactor.

## 7. Recommended PR sequence

With the source-level findings in place, the first three PRs are:

**PR-0a, 0b, 0c, 0d, 0e** — Step 0 (bench-clearing). Each independently
safe with the existing suite.

**PR-1 (eo-core extraction).** Pull `READING_RULES.decay_gamma` (and any
other live reads) into the `frame` parameter at every call site. Move
`projectGraph`, `OPERATORS`, the address encoder, the helpers
(`normSurface`, `pickCanonicalForm`, `PRONOUN_LEAD_SET`, `isPronoun`),
and the log to `src/core/`. Add the memoization keyed on
`(log.length, frameSig)` — now safe because the function is genuinely
pure. Pinned by `eoaddress` and `site`.

**PR-2 (retrieve).** Smaller, cleaner, model not involved. Confidence-
builder.

**PR-3 (ground).** The integrity guarantee. Pinned by `cross-source` /
`relation` / `binding`. The veto battery becomes a list of pure
predicates as in eoreader4's `src/ground/veto.js#VETOES`.

At the end of every PR the existing suite must be green and the app
shippable. Never more than one holon away from a green build.
