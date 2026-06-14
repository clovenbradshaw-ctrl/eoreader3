/* Regenerate the adapter manifest JSON files from the inline manifests the
   implementations register with, so the published JSON artifacts and the
   runtime manifests can never drift.

       node tools/gen-adapter-manifests.js

   The contract test (tests/adapters.test.js) asserts every JSON file still
   deep-equals its implementation's manifest, so if you edit an inline manifest
   without rerunning this, the test fails. */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadAdapters, MANIFEST_FILES, ROOT } = require('../tests/adapters-harness.js');

const { EOAdapters } = loadAdapters();
let n = 0;
for (const a of EOAdapters.all()) {
  const rel = MANIFEST_FILES[a.manifest.id];
  if (!rel) { console.error('No manifest path mapped for adapter "' + a.manifest.id + '" — update MANIFEST_FILES.'); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(a.manifest, null, 2) + '\n');
  console.log('wrote', rel);
  n++;
}
console.log('✓ ' + n + ' adapter manifests written');
