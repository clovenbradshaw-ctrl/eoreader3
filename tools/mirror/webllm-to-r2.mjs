#!/usr/bin/env node
/* ============================================================
   tools/mirror/webllm-to-r2.mjs — mirror WebLLM model artifacts for self-hosting

   WebLLM ships its model weights from Hugging Face and its wasm libs from a
   GitHub CDN. That shared, rate-limited path is the single biggest source of
   slow/flaky first loads. This tool pulls the artifacts down into a local tree
   laid out EXACTLY the way the app's CDN hook (window.EO_WEBLLM_CDN) expects,
   so you can sync it to a bucket you control (Cloudflare R2 is the usual pick:
   free egress, behind the edge, HTTP/3):

       <out>/models/<model_id>/...     ← the `model` artifacts (ndarray shards,
                                          tokenizer, mlc-chat-config.json)
       <out>/libs/<file>.wasm          ← the `model_lib` wasm, by basename

   It does NOT touch any bucket itself (no credentials, no SDK) — it only
   downloads + lays out files and prints the exact upload commands. You run the
   upload (and set CORS via cors.json in this folder), so the footgun-prone
   header/credential steps stay in your hands. See README.md.

   ── Input ────────────────────────────────────────────────────────────────
   A JSON array of the WebLLM model_list entries you want to host. The real
   source of truth is WebLLM's own prebuiltAppConfig, so generate it from the
   browser console rather than hand-writing URLs:

       node tools/mirror/webllm-to-r2.mjs --print-snippet

   paste the printed snippet into the app's console, save the output as
   models.json, then:

       node tools/mirror/webllm-to-r2.mjs --config models.json

   ── Usage ────────────────────────────────────────────────────────────────
     --config <path>     model_list JSON (default: tools/mirror/models.json)
     --out <dir>         output root   (default: tools/mirror/out)
     --concurrency <n>   parallel file downloads (default: 4)
     --weights-only      mirror only the model/ artifacts (skip libs/)
     --libs-only         mirror only the libs/ wasm (skip model/)
     --dry-run           list files + sizes, download nothing
     --print-snippet     print the console snippet to generate models.json
     --help
   ============================================================ */

import { mkdir, stat, rename, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const a = { config: join(HERE, 'models.json'), out: join(HERE, 'out'), concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--config') a.config = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--concurrency') a.concurrency = Math.max(1, +argv[++i] || 4);
    else if (k === '--weights-only') a.weightsOnly = true;
    else if (k === '--libs-only') a.libsOnly = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--print-snippet') a.printSnippet = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

const SNIPPET = `// Run in the app's browser console (any page that has loaded the model picker).
// Edit the WANT list to the models you actually offer, then save the output as
// tools/mirror/models.json.
(async () => {
  const WANT = [
    'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  ];
  const m = await import('https://esm.run/@mlc-ai/web-llm@0.2.79');
  const list = m.prebuiltAppConfig.model_list
    .filter(x => WANT.includes(x.model_id))
    .map(({ model_id, model, model_lib }) => ({ model_id, model, model_lib }));
  console.log(JSON.stringify(list, null, 2));
  try { await navigator.clipboard.writeText(JSON.stringify(list, null, 2)); console.log('(copied to clipboard)'); } catch {}
})();`;

const HELP = `mirror WebLLM model artifacts for self-hosting (see header / README.md)

  node tools/mirror/webllm-to-r2.mjs --print-snippet      # how to make models.json
  node tools/mirror/webllm-to-r2.mjs --config models.json # download into ./out
  node tools/mirror/webllm-to-r2.mjs --config models.json --dry-run

flags: --config --out --concurrency --weights-only --libs-only --dry-run --print-snippet`;

// huggingface.co/<owner>/<repo>/resolve/<rev>/<subpath> → its pieces.
function parseHf(url) {
  const m = /^https?:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/?(.*)$/.exec(String(url || ''));
  if (!m) return null;
  return { owner: m[1], repo: m[2], rev: m[3], sub: (m[4] || '').replace(/\/+$/, '') };
}

async function fetchRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      // 4xx (other than 429) won't fix themselves — fail fast.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error('HTTP ' + res.status + ' for ' + url);
      }
      lastErr = new Error('HTTP ' + res.status + ' for ' + url);
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));   // 1s, 2s, 4s, 8s
  }
  throw lastErr;
}

// List every file in an HF repo subtree. recursive=1 returns the whole tree;
// MLC repos are small (dozens of files), so a single page is plenty.
async function listRepoFiles(owner, repo, rev, sub) {
  const api = `https://huggingface.co/api/models/${owner}/${repo}/tree/${rev}?recursive=1`;
  const res = await fetchRetry(api);
  const tree = await res.json();
  let files = (Array.isArray(tree) ? tree : []).filter(e => e && e.type === 'file');
  if (sub) files = files.filter(e => e.path === sub || e.path.startsWith(sub + '/'));
  return files.map(e => ({ path: e.path, size: e.size || 0 }));
}

const human = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';

async function exists(path, size) {
  try { const s = await stat(path); return size ? s.size === size : s.size > 0; } catch { return false; }
}

async function download(url, dest, size, dryRun) {
  if (await exists(dest, size)) return { skipped: true, bytes: size || 0 };
  if (dryRun) return { planned: true, bytes: size || 0 };
  await mkdir(dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await fetchRetry(url);
  const got = +res.headers.get('content-length') || size || 0;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);                       // atomic: a crash leaves only .part, so reruns resume
  return { downloaded: true, bytes: got };
}

// A tiny concurrency-bounded map so a model with many shards doesn't open a
// hundred sockets at once (and so one slow shard doesn't serialize the rest).
async function pmap(items, n, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (args.printSnippet) { console.log(SNIPPET); return; }

  let entries;
  try { entries = JSON.parse(await readFile(args.config, 'utf8')); }
  catch (e) {
    console.error('Could not read model_list JSON at ' + args.config + '\n' + (e.message || e));
    console.error('\nGenerate it first:  node tools/mirror/webllm-to-r2.mjs --print-snippet');
    process.exitCode = 1; return;
  }
  if (!Array.isArray(entries) || !entries.length) { console.error('Config is not a non-empty array of model_list entries.'); process.exitCode = 1; return; }

  let total = 0, fileCount = 0;
  for (const e of entries) {
    if (!e || !e.model_id) { console.warn('skipping entry with no model_id'); continue; }
    console.log('\n• ' + e.model_id);

    if (!args.libsOnly) {
      const hf = parseHf(e.model);
      if (!hf) { console.warn('  ! could not parse model URL (not a huggingface resolve URL): ' + e.model); }
      else {
        const files = await listRepoFiles(hf.owner, hf.repo, hf.rev, hf.sub);
        const subPrefix = hf.sub ? hf.sub + '/' : '';
        await pmap(files, args.concurrency, async (f) => {
          const rel = f.path.startsWith(subPrefix) ? f.path.slice(subPrefix.length) : f.path;
          const url = `https://huggingface.co/${hf.owner}/${hf.repo}/resolve/${hf.rev}/${f.path}`;
          const dest = join(args.out, 'models', e.model_id, rel);
          const r = await download(url, dest, f.size, args.dryRun);
          total += r.bytes || 0; fileCount++;
          console.log('  ' + (r.skipped ? 'have' : r.planned ? 'plan' : ' got') + '  models/' + e.model_id + '/' + rel + '  (' + human(f.size || r.bytes || 0) + ')');
        });
      }
    }

    if (!args.weightsOnly && e.model_lib) {
      const file = String(e.model_lib).split('?')[0].split('/').pop();
      const dest = join(args.out, 'libs', file);
      const r = await download(e.model_lib, dest, 0, args.dryRun);
      total += r.bytes || 0; fileCount++;
      console.log('  ' + (r.skipped ? 'have' : r.planned ? 'plan' : ' got') + '  libs/' + file + '  (' + human(r.bytes || 0) + ')');
    } else if (!args.weightsOnly) {
      console.warn('  ! no model_lib in this entry — the wasm lib will not be mirrored');
    }
  }

  console.log('\n' + (args.dryRun ? 'Would mirror ' : 'Mirrored ') + fileCount + ' files, ~' + human(total) + ' → ' + args.out);
  if (!args.dryRun) {
    console.log('\nNext — upload with immutable cache headers (these artifacts are content-addressed, so they never change):');
    console.log('  rclone copy ' + args.out + ' r2:YOUR_BUCKET --header-upload "Cache-Control: public, max-age=31536000, immutable"');
    console.log('  # or: aws s3 sync ' + args.out + ' s3://YOUR_BUCKET --endpoint-url https://<acct>.r2.cloudflarestorage.com \\');
    console.log('  #        --cache-control "public, max-age=31536000, immutable"');
    console.log('\nThen apply CORS (tools/mirror/cors.json) and set in the app:  window.EO_WEBLLM_CDN = "https://cdn.yourdomain.com"');
  }
}

main().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
