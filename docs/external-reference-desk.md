# The reference desk — the external-knowledge stratum, shipped

`docs/external-knowledge-read.md` is **step 1**: a read-only measurement that
asked whether an outside lookup could fix the reader's residual, and found the
live APIs unreachable from the build environment (HTTP 403). This is the
shipped face of that stratum — the lookup, now reachable through a proxy,
rate-limited and prioritised, surfaced in the document pane as a reference desk:
the **encyclopaedia** article (Wikipedia) beside the **lexicon** entry
(Wiktionary), for one term.

It is the single deliberate crack in the app's closed world. Everywhere else,
*documents never leave your browser*; here, when you ask, a **surface form**
(an entity name — never the document text) is sent to Wikipedia and Wiktionary
through the proxy. Four disciplines keep that honest, carried over from the
dev-side read instrument (`tools/external/`):

1. **Consent + configurability.** Nothing is queried until you ask, and the
   first query takes a remembered consent. Every call goes through the same
   proxy host the app already uses for conventions
   (`n8n.intelechia.com/webhook/feed?url=<encoded upstream>`). Clear
   `window.EO_REFERENCE_PROXY` (set it to `''` or `null` before the scripts
   load, or in the console) to disable the stratum entirely.

2. **Rate limited.** One shared scheduler throttles *every* lookup — a minimum
   interval between real proxy requests (default ~1/s) and a concurrency cap of
   1 — so a page full of entities, or a rapid click-through, can never stampede
   the proxy or Wikimedia. Transient failures (429 / 5xx) back off and retry.

3. **Prioritised.** The reader's residual is ranked by how serious the gap is
   (`classifyNeeds`, mirroring the read instrument's classification): a
   recurring, generically-typed proper referent is a worse hole than a one-off,
   and an abstract noun mistyped as a generic `thing` routes to the **safe**
   language tier (Wiktionary) while a proper referent routes to the riskier
   **world** tier (Wikipedia). A budget spends the network on the worst holes
   first; the rest abstain (`skipped`) rather than queue forever.

4. **Abstain, never fabricate + stamped.** With the proxy off, no cache, or a
   miss, a lookup returns a status (`disabled` / `pending` / `miss` / `gated`)
   — never a guessed answer. Every hit is **frozen** to the local store
   (IndexedDB) and carries `{ src, term, url, fetched_at, hash }`, the same
   basis a shipped external fact would carry, so a repeat read is paid once and
   the desk is auditable. The provenance is shown under each result.

A hard **private-individual gate** refuses the world tier for a courtesy-title
personal name the document introduces by name (`Mrs. Mill`, `Dr. Smith`): the
reader must not turn a private person into a world-claim. The Wiktionary
(language) tier is not gated — a name there is harmless.

## What it does *not* do

The desk **proposes; it never overrides the page.** A Wikipedia one-line
description may suggest a better type for a generically-typed entity ("Wikipedia
reads this as an *org*"), but that is shown as a proposal — it does not mutate
the closed-world graph, retype the entity, or alter any grounded answer. The
mechanical reading and its audit are unchanged; the parity snapshots are
byte-identical.

## Where it lives

| Piece | File |
|---|---|
| Transport + policy (proxy, rate limiter, priority queue, two sources, freeze cache, gate) | `external.js` (`window.EOExternal`) |
| The desk + the prioritised batch bar (React) | `reference.jsx` (`window.ReferenceDesk`, `window.ReferenceDeskBar`) |
| Surfaced in the entity modal / entity tab, and in Explore mode | `docview.jsx` |
| Generic IndexedDB kv for the freeze | `store.js` (`kvGet` / `kvPut`) |
| Offline tests (injected fetch + clock + store) | `tests/external.test.js` |

`external.js` holds no React and no engine reference — fetch, the clock, and the
store are injectable — so the entire policy surface is unit-tested with a fake
fetch and no network.

## The two registers (`EOExternal`)

```js
EOExternal.classifyNeeds(entities)   // rank the residual by seriousness (pure, no network)
EOExternal.refdesk(term)             // → { encyclopaedia, lexicon } for one term
EOExternal.encyclopaedia(term)       // Wikipedia: search → summary
EOExternal.lexicon(term)             // Wiktionary: REST definition
EOExternal.resolveNeeds(needs, { budget, onResult })  // prioritised, budgeted, rate-limited batch
EOExternal.cfg() / setConfig(patch)  // proxy, intervalMs, concurrency, budget, …
```

Each result is `{ status, basis?, payload? }` where `status ∈ { hit, miss,
pending, gated, disabled, skipped, error }`. A `hit` payload is render-ready
(encyclopaedia: title, description, extract, thumbnail, a type *suggestion*,
other matches; lexicon: part-of-speech groups with definitions and an example),
already stripped of markup.
