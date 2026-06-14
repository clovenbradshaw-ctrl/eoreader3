/* ============================================================
   WebLLM Service Worker engine host (OPT-IN).

   This file is only used when the app is run with window.EO_WEBLLM_SW = true
   (see swEnabled() / registerWebLLMSW() in llm.js). With it registered, a
   loaded model stays resident in the service worker across page reloads, so a
   refresh re-attaches to the running engine instead of re-instantiating the
   weights into the GPU.

   It carries ONLY WebLLM's message handler — deliberately no `fetch` event
   listener — so registering it does NOT intercept or cache any of the app's
   own requests; it changes nothing about how the site itself loads. The model
   weights are still cached by WebLLM (IndexedDB, forced on in llm.js).

   Pinned to the same WebLLM version as importWebLLM() in llm.js so the page and
   the worker speak the same engine protocol. A module worker (registered with
   { type: 'module' }) is what lets this `import` resolve.
   ============================================================ */
import { ServiceWorkerMLCEngineHandler } from 'https://esm.run/@mlc-ai/web-llm@0.2.79';

let handler;

// Take over an open page as soon as we install/activate so the very first load
// after enabling the flag is handled, without requiring a second reload.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  handler = new ServiceWorkerMLCEngineHandler();
  event.waitUntil(self.clients.claim());
});

// If the worker was already activated before this script (re)ran, make sure the
// handler exists so queued engine messages are served.
if (!handler) {
  try { handler = new ServiceWorkerMLCEngineHandler(); } catch (_) { /* set up on activate */ }
}
