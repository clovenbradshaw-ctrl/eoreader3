# Web sources — external pages as first-class groundable sources

A page found on the web becomes a Cleo **source** with provenance: segmented and
embedded and admitted through the **same gates** an uploaded document travels.
Claims that rely on it cite it the way claims cite an uploaded file, and the veto
checks them the same way. This is a *sourcing* function, not a model tool — the
local WebLLM never reaches the network. It **proposes**; the mechanical layer
fetches, admits, and binds.

This document is the implementation record for the spec (*External Source
Admission Spec, v0.1*): what was built, where it lives, and the three places the
real code forced a reconciliation against the spec's inferred file shapes.

## Architecture

```
Browser (Cleo tab)                         Server (your box)
-------------------                         -----------------
deep-read rewalk → fetch-proposal
        │ user confirms (explicit, costed)
  websource.js ── POST /search ─────────▶  cleon-search-proxy ─▶ SearXNG JSON
        │        ◀── result list ───────                         (no fetch yet)
        │ user picks results
  websource.js ── POST /fetch ──────────▶  cleon-search-proxy ─▶ server GET
        │        ◀── {text, provenance}─                         + readability + sha256
  admit as source: parseDocument (SEG → embed → graph)
        │ store as web-source/1, enters retrieval ranking
  rewalk re-fires affected groundings
```

| Piece | Where | Status |
|---|---|---|
| Stateless server proxy (`/search`, `/fetch`) | `proxy/cleon-search-proxy.js` (+ `proxy/README.md`, `proxy/package.json`) | **built, tested** (`tests/proxy.test.js`) |
| SearXNG backend config | `searxng/docker-compose.yml`, `searxng/settings.yml` | **built** |
| Browser ingestion module (`window.EOWebSource`) | `websource.js` | **built, tested** (`tests/websource.test.js`) |
| `cleo-fetch/1` audit log | `audit.js` (`recordFetch` / `fetchLog`) | **built, tested** |
| web-source persistence (freeze, supersede, retract) | `store.js` | **built** |
| script wiring | `index.html` (after `external.js`) | **built** |
| deep-read web-search UI, source chips, cost confirm, proposal surfacing | `chat.jsx` / `app.jsx` | **staged** — seam below |
| `needs-external` triage bin + `fetch-proposal` emission in the rewalk | `llm.js` | **staged** — seam below |
| `cleo-fetch/1` inline rendering | `auditview.jsx` | **staged** — seam below |
| **cross-source** two-sighting promotion / over-merge guard | `engine.js` | **staged** — see §"The deep part" |

Enable it by pointing the tab at a proxy (off by default — the privacy thesis
bakes in no public endpoint):

```js
window.EO_SEARCH_PROXY = 'https://your-proxy.example';
window.EOWebSource.setConfig({ bearer: '…optional shared token…' });
```

## The three reconciliations the real code forced

The spec was written against *inferred* file shapes and says: where a real file
differs, adapt the file to meet the contract's **intent**. Three places needed a
judgment call; each preserves the spec's invariant while fitting the real engine.

1. **Engine doc kind stays `prose`; the *store record* carries `web-source`.**
   The spec imagined `kind: "web-source"` flowing through the engine. The real
   engine gates **~20 code paths** on `doc.kind === 'prose'` (projection,
   retrieval, answer, portraits…). Forcing a new kind through all of them is a
   high-risk, parity-breaking edit. Instead a web source is admitted *as a prose
   document* via `engine.parseDocument` — which **is** the identical pipeline the
   spec demands (the document segmenter with abbreviation-rejoin for "Mr."/"Inc."/
   "v.", then SEG → embed → graph) — and its web identity rides as **additive
   metadata** (`doc.sourceKind = 'web-source'`, `doc.web = {…provenance}`,
   `doc._webRecord`). The persisted `web-source/1` record keeps `kind:
   'web-source'` exactly as the spec writes it. Net effect: the engine sees a
   normal prose source (so all 202 parity snapshots are byte-identical), and the
   store/UI/citation layer sees a web source.

2. **The engine doc id is colon-free; the record id keeps `web:<hash16>`.**
   Citation markers render as `{{cite:docId:idx:sN}}` and `chat.jsx` parses the
   payload with `split(':')`. A doc id of `web:abc…` would corrupt that split.
   So the **record id** is `web:<first 16 hex of content_hash>` (spec §5.1, and
   the citation `source_id`), while the **engine doc id** is the same string with
   the colon swapped for a hyphen (`web-<hash16>`). `EOWebSource.engineDocId()`
   and `recordForDocId()` are the deterministic, reversible bridge.

3. **The fetch schema is `cleo-fetch/1`, not `cleon-fetch/1`.** The repo's audit
   family is `cleo-*` (`cleo-audit/1`, `cleo-external/1`, `cleo-enrich/1`). The
   fetch log joins that family as `cleo-fetch/1` so the glass box stays uniform;
   the spec's `cleon-fetch/1` is the same record under the repo's naming.

## The contracts

**`web-source/1`** (store record, `store.js`) — `{ schema, id: "web:<hash16>",
kind: "web-source", url, final_url, title, byline, excerpt, retrieval_query,
engine, fetched_at, content_hash, text, segments, embeddings_ref, status }`.
`status` ∈ `active | superseded | retracted`.

**`cleo-fetch/1`** (audit, `audit.js`) — `{ schema, ts, action: "search"|"fetch",
query?, url?, final_url?, engine, result_count?, content_hash?, http_status,
latency_ms, proxy, triggered_by }`. `triggered_by` ∈ `deep-read | user-action` —
**never `chat`** (enforced in code, not just docs).

**`web-source` citation** (`websource.js` `toWebCitation`) — `{ type:
"web-source", source_id, segment_id, char_span, url, fetched_at, content_hash }`.
The `char_span` is the `[start,end]` of the binding tokens within the cited
segment — the same span the veto's token-existence check reads.

## Invariants, enforced in code

- **Chat isolation (§13.3).** `EOWebSource` exposes no chat hook. `search()` and
  `fetchPage()` refuse a `triggered_by: 'chat'` *before* any network hop, and
  `EOAudit.recordFetch` drops a chat-triggered record. A `cleo-fetch/1` with
  `triggered_by: 'chat'` is an impossible state, not a logged one.
- **Explicit cost (§13.4).** `fetchPage(url)` throws `costRequired` unless
  `{ confirmed: true }` is passed, and `costNotice()` states that the query
  reaches public engines. Discovery shows the notice before the first hop too.
- **Proposer-only (§7).** The model can only `buildFetchProposal(...)`; nothing in
  the module fetches from a proposal. A human edits the query and confirms.
- **Frozen + staleness (§8).** A source freezes at `fetched_at` via
  `content_hash`. `supersede()` mints a **new** record (new id) on a changed hash,
  marks the old `superseded` (retained), and returns the citations to re-fire. It
  never overwrites.
- **Retraction (§9).** `retract()` flips `status` to `retracted`, returns the
  re-fire signal and the scope-removal id, and records a `web-retract` glass-box
  step so the fallback to NUL is legible, not silent.
- **Provenance integrity (§13.9).** `verifyCitation()` requires `status ===
  'active'` **and** `citation.content_hash === record.content_hash` **and** the
  cited span to contain the binding tokens.

## Acceptance criteria — coverage today

Engine-backed Node tests (`tests/websource.test.js`, using the real engine via
`evo/engine-host`) and `tests/proxy.test.js`:

| # | Criterion | Status |
|---|---|---|
| 1 | Grounding parity (cites a `web-source` with a real `char_span`) | ✅ engine-backed |
| 2 | Veto parity (a fabricated claim is rejected) | ✅ engine-backed |
| 3 | Chat isolation (no `cleo-fetch/1` from chat) | ✅ |
| 4 | Explicit cost (confirmation states the query reaches public engines) | ✅ |
| 7 | Staleness (re-fetch → new record, old `superseded`, grounding re-fires) | ✅ |
| 8 | Retraction (status flips, dependents re-fire, legible) | ✅ mechanics |
| 9 | Provenance integrity (citation hash === record hash) | ✅ |
| 5 | Two-sighting **promotion** across doc + web source | ⏳ the deep part |
| 6 | Over-merge guard across sources | ⏳ the deep part |

## The deep part — cross-source two-sighting promotion (§5.2.3, §5.3, §13.5/6)

The spec's most novel claim — "an entity seen once in the loaded document and
once in the web source now has two sightings and is admitted" — requires the
engine to count sightings and canonicalize **across two separate documents**
before the admission gate. The real engine admits entities **per document**: the
two-sighting gate (`admitAnchors`, `engine.js:~1584`; `_checkAdmission`, `~1992`)
runs inside `extractEoGraph` over one document's text, and canonicalization
(`pickCanonicalForm`, `~6338`) is per-document. There is a cross-source *veto*
(`checkCrossSource`) but no cross-source *promotion*.

So cross-source promotion is genuinely unbuilt engine work, deliberately **not**
faked with a passing test. The integration point, for the next step:

1. Build the merged surface set over the scope `[loadedDoc, webDoc]` and run
   canonicalization **first** (§5.3's axiom: canonicalization precedes the count),
   unifying `Mr. Turner` (doc) with `Tom Turner` (web) — and *only* when the
   over-merge guard (already enforced within a doc: distinct people sharing a
   surname stay distinct) holds across sources.
2. Then count sightings on the unified site; an entity with one doc sighting and
   one web sighting clears the gate.
3. Log both surface forms and the canonical target to the glass box on every
   web-driven promotion (a promotion that cannot name its two surface forms is a
   bug, §5.3).

`websource.js` already makes the web source a real prose source whose sightings
are real and countable; what remains is the cross-source unification pass and its
re-fire on frame shift (§7.2).

## The UI / rewalk seam (staged)

The React UI and the `llm.js` rewalk are not Node-verifiable in this repo's test
harness, so they are staged behind the stable `window.EOWebSource` seam rather
than shipped half-run. To wire them:

- **`llm.js` rewalk** — add the `needs-external` null bin to the triage; when the
  rewalk reaches it, emit `EOWebSource.buildFetchProposal({ target_claim_id,
  suggested_query, rationale })` (the proposer-only contract — never fetch).
- **`chat.jsx` / `app.jsx`** — a deep-read "search the web" button (never a chat
  side effect) calls `EOWebSource.search(q)` after showing `costNotice(q)`; the
  user picks results; `EOWebSource.fetchPage(url, { confirmed: true })` →
  `EOWebSource.admit(payload)`; add the returned doc to the answer scope; render
  a globe-glyph source chip with provenance and a retract control
  (`EOWebSource.retract`). `styles.css` gets `.source-chip--web` styling.
- **`auditview.jsx`** — render `EOAudit.fetchLog()` (`cleo-fetch/1`) inline in the
  trace, so a reader sees exactly which turns touched the network.
