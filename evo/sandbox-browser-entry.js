/* Browser entry for the in-browser sandbox. esbuild bundles this (with
   allowlist.js, patch.js, sandbox.browser.js) into evo/sandbox.bundle.js,
   an IIFE that publishes the sandbox API on window — so the no-build
   static site loads one plain script. Regenerate: npm run evo:sandbox-build */
'use strict';
window.EVO_ALLOWLIST = require('./allowlist');
window.EVO_PATCH = require('./patch');
window.EVO_SANDBOX = require('./sandbox.browser');
