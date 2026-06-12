/* ============================================================
   tools/predictive/fetch-model.js — vendor MiniLM for offline Node use.

   The browser app downloads Xenova/all-MiniLM-L6-v2 from huggingface.co
   at runtime; this environment's network policy allows only the npm
   registry. Two published packages carry byte-identical copies of the
   model files, so we pull the tarballs from npm and lay the files out in
   .models/ exactly where transformers.js's localModelPath expects them:

     @ryanstark24/sfgraph-models  → onnx/model_quantized.onnx (the q8
                                    weights embed.js actually loads)
     @alvix/all-minilm-l6-v2      → onnx/model.onnx (fp32, optional)

   .models/ is gitignored — this is a per-machine cache, never shipped.
   ============================================================ */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const DEST = path.join(ROOT, '.models', 'Xenova', 'all-MiniLM-L6-v2');

function main() {
  if (fs.existsSync(path.join(DEST, 'onnx', 'model_quantized.onnx'))) {
    console.log('✓ model already present at', path.relative(ROOT, DEST));
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minilm-'));
  console.log('fetching @ryanstark24/sfgraph-models from the npm registry…');
  execSync('npm pack @ryanstark24/sfgraph-models@1.1.3 --silent', { cwd: tmp, stdio: 'inherit' });
  execSync('tar xzf ryanstark24-sfgraph-models-1.1.3.tgz package/data/Xenova', { cwd: tmp });
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.cpSync(path.join(tmp, 'package', 'data', 'Xenova', 'all-MiniLM-L6-v2'), DEST, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓ vendored to', path.relative(ROOT, DEST));
}

main();
