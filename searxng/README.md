# SearXNG for Cleo web sources

Self-hosted [SearXNG](https://github.com/searxng/searxng) is the **default and
only required** search backend (spec §2). Managed LLM-native search APIs (Tavily,
Exa, Perplexity, Brave Answers) receive the user's query text and leak the
investigation to a third party — they violate the privacy thesis and are not in
the default build. SearXNG aggregates public engines; the `cleon-search-proxy`
in front of it hides the origin IP.

> The proxy hides the **IP**, not the **query text** — SearXNG still forwards
> query terms to Bing/DuckDuckGo. The Cleo UI states this in its cost
> confirmation.

## Bring it up

```bash
cd searxng
# edit settings.yml: set a real server.secret_key (openssl rand -hex 32)
docker compose up -d
curl 'http://127.0.0.1:8080/search?q=test&format=json' | head
```

Then point the proxy at it:

```bash
cd ../proxy && SEARXNG_URL=http://127.0.0.1:8080 npm start
```

## The two settings that matter (`settings.yml`)

1. **JSON output** — `search.formats` must include `json`; the proxy calls
   `/search?q=…&format=json`.
2. **Limiter off** — `server.limiter: false` for single-user operation, or
   requests from the proxy's "abnormal" User-Agent are rejected.

Prefer `bing` and `duckduckgo`; disable `reddit` and friends, which rate-limit a
single IP and inject silent timeouts that skew the merged list.

Bind SearXNG to **localhost** and keep the proxy as the only thing in front of
it. Do not expose `:8080` publicly.
