# Self-hosting the WebLLM models

By default WebLLM downloads model **weights** from Hugging Face and the model
**wasm libs** from a GitHub CDN. That shared, rate-limited path is the biggest
cause of slow and flaky first loads (429s, occasional 5xx, region-variable edge
speed). Hosting the artifacts on a bucket you control — Cloudflare R2 is the
usual pick (free egress, behind Cloudflare's edge, HTTP/3) — fixes that.

The app already supports it: set `window.EO_WEBLLM_CDN` to your bucket's base
URL and `llm.js` rewrites every model to your mirror (see `webllmAppConfig()`),
expecting this layout:

```
<base>/models/<model_id>/      # the MLC weight artifacts (shards, tokenizer, config)
<base>/libs/<file>.wasm        # the model_lib wasm, by basename
```

`webllm-to-r2.mjs` produces exactly that layout locally. It downloads only — it
never touches your bucket — so credentials and the upload stay with you.

## 1. Generate the model list

The source of truth is WebLLM's own `prebuiltAppConfig`, so dump it from the
browser rather than hand-writing URLs:

```sh
node tools/mirror/webllm-to-r2.mjs --print-snippet
```

Paste the printed snippet into the app's browser console, edit the `WANT` array
to the models you actually offer, and save the output as
`tools/mirror/models.json`.

## 2. Download the artifacts

```sh
node tools/mirror/webllm-to-r2.mjs --config tools/mirror/models.json
# preview first with --dry-run; tune parallelism with --concurrency 8
```

Output lands in `tools/mirror/out/` (git-ignored). Re-runs are resumable: a
finished file is skipped, and an interrupted one leaves only a `.part`.

## 3. Upload with the right headers

The artifacts are content-addressed (the quantization is in the path), so they
never change — cache them forever and **don't** gzip/brotli them (quantized
binary weights don't compress).

```sh
# Cloudflare R2 via rclone
rclone copy tools/mirror/out r2:YOUR_BUCKET \
  --header-upload "Cache-Control: public, max-age=31536000, immutable"

# or the S3 API
aws s3 sync tools/mirror/out s3://YOUR_BUCKET \
  --endpoint-url https://<account>.r2.cloudflarestorage.com \
  --cache-control "public, max-age=31536000, immutable"
```

## 4. CORS + range requests

WebLLM fetches shards with CORS and uses range requests, so the bucket must
allow them. Edit `cors.json` (set `AllowedOrigins` to your app's origin) and
apply it:

```sh
aws s3api put-bucket-cors --bucket YOUR_BUCKET \
  --endpoint-url https://<account>.r2.cloudflarestorage.com \
  --cors-configuration file://tools/mirror/cors.json
```

`Accept-Ranges: bytes` must be exposed (it is, in `cors.json`) so resumable /
parallel shard fetches work.

## 5. Point the app at your mirror

Set this before the model loads (e.g. an inline script in `index.html`, or your
deployment's config):

```js
window.EO_WEBLLM_CDN = "https://cdn.yourdomain.com";
```

Entries the app can't fully map (a model missing from your mirror) keep their
original Hugging Face URLs, so a partial mirror degrades gracefully rather than
breaking — you can mirror just your default model first and expand later.

> The on-device **CPU** models (wllama GGUFs) are separate; they already carry
> mirror fallbacks and have their own `window.EO_WLLAMA_*` overrides in `llm.js`.
