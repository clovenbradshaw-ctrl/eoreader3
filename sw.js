/* Cleo self-host service worker.

   The ONLY thing this does is serve WebLLM model files that the app has already
   downloaded — as a single zip from a self-host bucket — and unzipped into a
   Cache. A slow or VPN'd connection then fetches the multi-GB weights ONCE as a
   single resumable stream instead of ~30 separate shard requests (each its own
   request that can stall), and WebLLM reads them back locally.

   It is deliberately tiny and inert by default: it only ever touches requests
   whose URL contains the self-host prefix below (a synthetic, same-origin path
   the app points WebLLM at). EVERY other request — the app's own scripts, the
   model runtime, Hugging Face, anything — passes straight through untouched, so
   installing it can't change how the rest of the site loads. The app only
   registers it when a model is actually configured for self-hosting
   (window.EO_WEBLLM_SELFHOST); absent that, this file is never fetched. */

'use strict';

const SELFHOST_CACHE = 'cleo-webllm-selfhost-v1';
const SELFHOST_PREFIX = '/__webllm__/';

// Take over as soon as possible so the very first model fetch is intercepted.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  let path = '';
  try { path = new URL(event.request.url).pathname; } catch (_) { return; }
  if (path.indexOf(SELFHOST_PREFIX) === -1) return;   // not ours → default network
  // Serve from the unzipped cache. A miss falls through to the network (which
  // 404s the synthetic URL) so the app's load fails loudly and falls back to
  // the model's real origin, rather than hanging.
  event.respondWith(
    caches.open(SELFHOST_CACHE)
      .then((cache) => cache.match(event.request, { ignoreSearch: true, ignoreVary: true }))
      .then((hit) => hit || fetch(event.request))
      .catch(() => fetch(event.request)),
  );
});
