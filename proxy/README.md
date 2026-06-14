# cleon-search-proxy

The server-side half of the Cleo **web-source** function (see
`../docs/web-source-admission.md` and the spec). A browser-only app cannot fetch
arbitrary cross-origin pages (CORS) and cannot hold a search credential without
exposing it — both problems live on the server. This is the **only** networked
component, and it is **stateless by design**: no query is persisted.

Discovery is separated from commitment so the user admits specific results
rather than a bulk dump. Discovery is cheap; the fetch is the committing act.

## Endpoints

### `POST /search`
```json
{ "q": "string", "max_results": 8, "engines": ["bing", "duckduckgo"] }
```
Calls the self-hosted SearXNG JSON API (`/search?format=json`) and maps results.
Does **not** fetch page bodies.
```json
{ "query": "…", "fetched_at": "ISO", "results": [
  { "title": "…", "url": "…", "snippet": "…", "engine": "bing", "score": 0.0 } ] }
```

### `POST /fetch`
```json
{ "url": "string", "retrieval_query": "string", "engine": "bing" }
```
Server-side GET (sane User-Agent, hard 2 MB cap, follows redirects and records
the final URL), `@mozilla/readability` extraction over `jsdom`, whitespace
normalisation, `sha256` over the normalised text.
```json
{ "url": "…", "final_url": "…", "title": "…", "byline": null, "excerpt": null,
  "text": "normalized plain text", "content_hash": "sha256-…", "http_status": 200,
  "content_type": "text/html", "fetched_at": "ISO", "retrieval_query": "…", "engine": "bing" }
```
Errors return `{ "error": "string", "http_status": 4xx|5xx }`; the browser
surfaces the error and admits nothing.

## Security (spec §4.3)

- **Key custody.** Any backend credential lives only in this process's
  environment — never shipped to the client.
- **CORS allowlist.** Set `ALLOW_ORIGINS` to the exact Cleo origin(s). The JSON
  endpoint is a free proxy to upstream engines if left open, so additionally set
  `BEARER_TOKEN` (a shared token issued at deploy time) — or restrict by CIDR at
  your reverse proxy.
- **No query logging.** Only status + path are logged, never query text. The
  proxy keeps no durable state.
- **Robots + rate limit.** `robots.txt` is respected (conservative), with a
  per-host minimum interval and a concurrent-fetch cap.

> The proxy hides the **origin IP**. It does **not** hide the **query text** from
> the upstream engines (Google/Bing). The Cleo UI states this in its cost
> confirmation before the first network hop.

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `SEARXNG_URL` | `http://127.0.0.1:8080` | the self-hosted SearXNG base |
| `ALLOW_ORIGINS` | `(none)` | comma-separated exact origins for CORS |
| `BEARER_TOKEN` | `(none)` | shared token required on every request when set |
| `MAX_BYTES` | `2097152` | hard page size cap (2 MB) |
| `USER_AGENT` | `CleoWebSource/0.1 …` | UA sent upstream |
| `FETCH_TIMEOUT_MS` | `15000` | per-fetch timeout |
| `PER_HOST_INTERVAL_MS` | `1000` | per-host rate limit |
| `MAX_CONCURRENT_FETCH` | `4` | concurrent /fetch cap |

## Run

```bash
cd proxy
npm install
SEARXNG_URL=http://127.0.0.1:8080 \
ALLOW_ORIGINS=https://cleo.example \
BEARER_TOKEN=$(openssl rand -hex 16) \
npm start
```

Then in the Cleo tab set the proxy base (and the bearer, if used):

```js
window.EO_SEARCH_PROXY = 'https://your-proxy.example';
// optional, if BEARER_TOKEN is set on the proxy:
window.EOWebSource.setConfig({ bearer: '…the same token…' });
```

Clear `window.EO_SEARCH_PROXY` to disable the web-source function entirely and
keep the reader strictly local.

## n8n alternative

The same contract (`POST /search`, `POST /fetch` with the JSON shapes above) can
be satisfied by an n8n webhook workflow on the existing n8n deployment. The
browser does not care which serves it. A dedicated Node service is easier to
lock down and reason about; n8n is faster to stand up.

## Tests

The pure helpers and the HTTP layer (with an injected upstream fetch — no real
network) are covered by `../tests/proxy.test.js`, run as part of `npm test` at
the repo root.
