/* ============================================================
   Adapter library — smoke-level contract tests, one per adapter.

   For every registered adapter:
     1. its manifest validates against adapters/manifest-schema.json,
     2. load() is idempotent and ready() becomes true after,
     3. run() on a small canned input returns at least one event,
     4. every event has the required fields and types from the contract,
     5. confidence is in [0,1],
     6. region shape matches the modality.

   ML-backed adapters (tesseract, whisper, trocr, clip, minilm, tree-sitter)
   resolve their runtime from injected window.EO_* seams here — the same seams
   the browser uses for self-hosting — so the contract is exercised offline. The
   deterministic adapters (pdf.js, papaparse) run their real built-in paths, and
   pdf-text runs END-TO-END against tests/fixtures/sample.pdf, including through
   window.EOAdapters.runFor('pdf-text', …).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadAdapters, MANIFEST_FILES, ROOT } = require('./adapters-harness.js');

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ FAIL — ' + name + (extra ? '\n      ' + extra : '')); }
};

// Order-independent deep-equality via stable stringify (key-sorted).
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const deepEqual = (a, b) => stable(a) === stable(b);

// ---- fake runtimes (the window.EO_* injection seams) ----------------------
function inject(win) {
  win.eoWarn = (m) => { (win.__warns = win.__warns || []).push(String(m)); };

  win.EO_TESSERACT = {
    createWorker: async () => ({
      recognize: async () => ({ data: { text: 'Hello', words: [{ text: 'Hello', confidence: 91, bbox: { x0: 10, y0: 20, x1: 80, y1: 44 } }] } }),
      terminate: async () => {},
    }),
  };

  win.EO_TRANSFORMERS = {
    pipeline: async (task) => {
      if (task === 'automatic-speech-recognition') {
        return async () => ({ text: 'hello world', language: 'english', chunks: [
          { timestamp: [0, 1.2], text: 'hello', avg_logprob: -0.2 },
          { timestamp: [1.2, 2.0], text: 'world', avg_logprob: -0.5 },
        ] });
      }
      if (task === 'image-to-text') return async () => [{ generated_text: 'Recognized text' }];
      if (task === 'image-feature-extraction') return async () => ({ data: Float32Array.from({ length: 512 }, () => 0.05) });
      if (task === 'feature-extraction') return async () => ({ data: Float32Array.from({ length: 512 }, () => 0.04) });
      return async () => ({});
    },
  };

  // The resident MiniLM embedder the minilm adapter wraps.
  let embReady = false;
  win.EOEmbed = {
    ready: () => embReady,
    warm() {},
    embedSentences: async (arr) => { embReady = true; return arr.map(() => Float32Array.from({ length: 384 }, () => 0.1)); },
    embedQuery: async () => { embReady = true; return Float32Array.from({ length: 384 }, () => 0.1); },
    MODEL: 'Xenova/all-MiniLM-L6-v2',
  };

  // A web-tree-sitter-shaped fake: Parser.init / Parser.Language.load /
  // new Parser().setLanguage().parse() → rootNode.namedChildren.
  function mkNode(type, text, start) {
    return {
      type, text, startIndex: start, endIndex: start + text.length,
      descendantsOfType: (t) => t !== 'identifier' ? [] :
        (text.match(/[A-Za-z_]\w*/g) || [])
          .filter(w => !/^(function|const|let|var|def|class|return|pass)$/.test(w))
          .map(w => ({ type: 'identifier', text: w })),
    };
  }
  class FakeParser {
    setLanguage(l) { this._lang = l; }
    parse(src) {
      const lang = (this._lang && this._lang.name) || 'javascript';
      const s = String(src);
      const lines = s.split('\n').filter(l => l.trim().length);
      let pos = 0;
      const children = lines.map(line => {
        const start = s.indexOf(line, pos); pos = start + line.length;
        const type = lang === 'python'
          ? (/^\s*def\b/.test(line) ? 'function_definition' : /^\s*class\b/.test(line) ? 'class_definition' : 'expression_statement')
          : (/\bfunction\b/.test(line) ? 'function_declaration' : /^\s*(const|let|var)\b/.test(line) ? 'lexical_declaration' : 'expression_statement');
        return mkNode(type, line, start);
      });
      return { rootNode: { type: 'program', namedChildren: children, children, startIndex: 0, endIndex: s.length, text: s } };
    }
  }
  FakeParser.init = async () => {};
  FakeParser.Language = { load: async (url) => ({ name: /python/.test(url) ? 'python' : 'javascript' }) };
  win.EO_TREESITTER = { Parser: FakeParser };
  // pdf.js and papaparse are intentionally NOT injected → their real built-in
  // deterministic paths run (and prove the contract end-to-end).
}

const { window: win, EOAdapters: A, EOAdapterContract: Ct } = loadAdapters({ inject });

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters/manifest-schema.json'), 'utf8'));
const fixtureBytes = fs.readFileSync(path.join(ROOT, 'tests/fixtures/sample.pdf'));

// Canned inputs per adapter id.
const docRuns = [
  { payload: { text: 'THE TITLE', fontSize: 24 }, region: { kind: 'bbox', x: 72, y: 700, w: 200, h: 24 } },
  { payload: { text: 'Some ordinary body text here.', fontSize: 12 }, region: { kind: 'bbox', x: 72, y: 680, w: 300, h: 12 } },
  { payload: { text: '1 2 3 4 5 6 7 8 9 0', fontSize: 12 }, region: { kind: 'bbox', x: 72, y: 660, w: 200, h: 12 } },
];
const CASES = {
  'ocr-tesseract': () => [new win.Blob(['img'])],
  'ocr-trocr-printed': () => [new win.Blob(['img'])],
  'ocr-trocr-handwritten': () => [new win.Blob(['img'])],
  'asr-whisper-tiny': () => [new Float32Array(1600)],
  'asr-whisper-base': () => [new Float32Array(1600)],
  'asr-whisper-small': () => [new Float32Array(1600)],
  'pdf-text-pdfjs': () => [fixtureBytes],
  'csv-parse-papaparse': () => ['name,age,city\nAna,31,Lagos\nLuis,27,Lima'],
  'code-ast-treesitter': () => ['function add(a, b) { return a + b; }\nconst x = add(1, 2);', { language: 'javascript' }],
  'doc-layout-docling-lite': () => [docRuns],
  'text-embed-minilm': () => ['auto and car mean the same thing'],
  'image-text-embed-clip': () => ['a photo of a cat'],
};

async function main() {
  ok('window.EOAdapterContract is published', !!Ct);
  ok('window.EOAdapters is published', !!A);
  ok('all adapters registered without warnings', !(win.__warns && win.__warns.length), (win.__warns || []).join(' | '));
  ok('manifest-schema.json mirrors EOAdapterContract.MANIFEST_SCHEMA', deepEqual(schema, Ct.MANIFEST_SCHEMA));

  const adapters = A.all();
  ok('12 adapters registered', adapters.length === 12, 'got ' + adapters.length + ': ' + A.ids().join(', '));

  // ---- per-adapter contract smoke ----
  for (const a of adapters) {
    const id = a.manifest.id;
    const tag = '[' + id + '] ';

    // 1. manifest validates against the published schema
    const v = Ct.jsonSchemaValidate(schema, a.manifest);
    ok(tag + 'manifest validates against manifest-schema.json', v.ok, v.errors.join('; '));

    // manifest JSON file exists, validates, and equals the inline manifest
    const rel = MANIFEST_FILES[id];
    ok(tag + 'has a manifest JSON file', !!rel && fs.existsSync(path.join(ROOT, rel)));
    if (rel && fs.existsSync(path.join(ROOT, rel))) {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      ok(tag + 'JSON manifest equals the inline manifest', deepEqual(j, a.manifest));
      ok(tag + 'JSON manifest validates against schema', Ct.jsonSchemaValidate(schema, j).ok);
    }

    // 2. load() idempotent, ready() true after
    await a.load(); await a.load();
    ok(tag + 'ready() is true after load()', a.ready() === true);

    // 3. run() returns >= 1 event
    const mk = CASES[id];
    ok(tag + 'has a smoke case', !!mk);
    if (!mk) continue;
    const args = mk();
    let events;
    try { events = await a.run(args[0], args[1]); }
    catch (e) { ok(tag + 'run() did not throw', false, String(e && e.stack || e)); continue; }
    ok(tag + 'run() returns >= 1 event', Array.isArray(events) && events.length >= 1, 'got ' + (events && events.length));
    if (!events || !events.length) continue;

    // 4/5/6. every event conforms
    for (const e of events) {
      const ev = Ct.validateEvent(e);
      ok(tag + 'event conforms to the contract', ev.ok, ev.errors.join('; '));
      ok(tag + 'confidence in [0,1]', typeof e.confidence === 'number' && e.confidence >= 0 && e.confidence <= 1, 'conf=' + e.confidence);
      ok(tag + 'region shape matches modality (' + a.manifest.modality + ')', Ct.regionMatchesModality(e.region, a.manifest.modality), 'region=' + JSON.stringify(e.region));
      ok(tag + 'event provenance names this adapter+version', e.adapter && e.adapter.id === id && e.adapter.version === a.manifest.version);
    }
  }

  // ---- targeted assertions the smoke loop can't express --------------------

  // pdf-text END-TO-END: real built-in extraction of the fixture's two runs.
  const pdf = A.byId('pdf-text-pdfjs');
  const pe = await pdf.run(fixtureBytes);
  ok('pdf-text extracts both runs from the fixture', pe.length === 2, 'got ' + pe.length);
  ok('pdf-text reads the title run verbatim', pe.some(e => e.payload.text === 'Hello Cleo'));
  ok('pdf-text reads the body run verbatim', pe.some(e => e.payload.text === 'Adapter contract proof'));
  ok('pdf-text recovers font size', pe.some(e => e.payload.fontSize === 24));
  ok('pdf-text confidence is deterministic 1.0', pe.every(e => e.confidence === 1) && pdf.manifest.confidenceSemantics === 'deterministic');

  // Acceptance #6: runFor('pdf-text', someBlob) works end-to-end. (Node's
  // global Blob has arrayBuffer(); jsdom's stub does not, so we use the real one
  // here — in a browser every Blob carries arrayBuffer().)
  const blobEvents = await A.runFor('pdf-text', new Blob([fixtureBytes]));
  ok("runFor('pdf-text', Blob) returns extracted runs", blobEvents.length === 2 && blobEvents.some(e => e.payload.text === 'Hello Cleo'));

  // csv-parse: typed rows, deterministic.
  const csv = A.byId('csv-parse-papaparse');
  const ce = await csv.run('name,age,city\nAna,31,Lagos\nLuis,27,Lima');
  ok('csv-parse yields one event per data row', ce.length === 2);
  ok('csv-parse coerces numeric cells', ce[0].payload.age === 31 && typeof ce[0].payload.age === 'number');
  ok('csv-parse keeps string cells', ce[0].payload.city === 'Lagos');
  ok('csv-parse region is the row index', ce[1].region.kind === 'row' && ce[1].region.index === 1);

  // tree-sitter: BOTH JavaScript and Python grammars (acceptance #3).
  const ts = A.byId('code-ast-treesitter');
  const jsEv = await ts.run('function add(a, b) { return a + b; }\nconst x = add(1, 2);', { language: 'javascript' });
  const pyEv = await ts.run('def add(a, b):\n    return a + b\nclass Foo:\n    pass', { language: 'python' });
  ok('tree-sitter parses JavaScript into top-level nodes', jsEv.length >= 1 && jsEv.every(e => e.region.kind === 'node'));
  ok('tree-sitter parses Python into top-level nodes', pyEv.length >= 1 && pyEv.every(e => e.region.kind === 'node'));
  ok('tree-sitter extracts identifiers', jsEv.some(e => Array.isArray(e.payload.identifiers) && e.payload.identifiers.length));
  ok('tree-sitter reports an unsupported language as a failure event', (await ts.run('x = 1', { language: 'klingon' })).some(e => e.meta && e.meta.kind === 'failure'));

  // minilm: dim 384, deterministic.
  const ml = A.byId('text-embed-minilm');
  const me = await ml.run('auto and car mean the same thing');
  ok('minilm emits a 384-dim vector', me.length === 1 && me[0].payload.dim === 384 && ArrayBuffer.isView(me[0].payload.vec));

  // clip: 512-dim for both text and image inputs.
  const clip = A.byId('image-text-embed-clip');
  const ct = await clip.run('a photo of a cat');
  const ci = await clip.run({ width: 2, height: 2 }, { kind: 'image' });
  ok('clip text embedding is 512-dim, charoffset region', ct[0].payload.dim === 512 && ct[0].region.kind === 'charoffset');
  ok('clip image embedding is 512-dim, bbox region', ci[0].payload.dim === 512 && ci[0].region.kind === 'bbox');

  // ---- registry behavior ----
  ok('capabilities are DISCOVERED from manifests', deepEqual(A.capabilities(),
    ['asr', 'code-ast', 'csv-parse', 'doc-layout', 'image-text-embed', 'ocr', 'pdf-text', 'text-embed']));
  ok('byCapability(ocr) returns all three OCR adapters', A.byCapability('ocr').length === 3);
  ok('canRun gates a WebGPU adapter off where no GPU', A.canRun(A.byId('ocr-trocr-printed')).ok === false);
  ok('canRun allows a wasm adapter', A.canRun(A.byId('asr-whisper-tiny')).ok === true);

  // preference persistence + the change event
  let changed = 0; win.addEventListener('eo.adapters.changed', () => { changed++; });
  A.setPreferred('asr', 'asr-whisper-base');
  ok('preference is written to localStorage', win.localStorage.getItem('eo.adapters.preferred.asr') === 'asr-whisper-base');
  ok('eo.adapters.changed fired on setPreferred', changed >= 1);
  ok('selected() honors a runnable preference', A.selected('asr').manifest.id === 'asr-whisper-base');
  A.setPreferred('ocr', 'ocr-trocr-printed');   // webgpu → not runnable here
  ok('selected() falls back when the preference cannot run', A.selected('ocr').manifest.id === 'ocr-tesseract');
  A.setPreferred('asr', null);
  ok('clearing a preference removes it', !win.localStorage.getItem('eo.adapters.preferred.asr'));

  // performance profile drives the default pick
  A.setProfile('browser');
  ok('profile persists', A.profile() === 'browser');
  ok("browser profile picks the lightest runnable asr (tiny < base)", A.selected('asr').manifest.id === 'asr-whisper-tiny');
  A.setProfile('maximum');
  ok('maximum profile picks the heaviest runnable asr', A.selected('asr').manifest.id === 'asr-whisper-base'); // small is webgpu → filtered out here
  A.setProfile('desktop');

  // negative paths
  win.__warns = [];
  ok('register() rejects an invalid manifest', A.register({ manifest: { id: 'Bad Id' }, load() {}, ready() {}, run() {} }) === false);
  let threw = false; try { await A.runFor('no-such-capability', 'x'); } catch (_) { threw = true; }
  ok('runFor() throws for an unknown capability', threw);

  // ---- regression: TrOCR normalizes a Blob/File the image pipeline rejects ----
  // transformers.js' image pipeline throws "Unsupported input type: object" on a
  // raw File/Blob it doesn't recognize; the adapter must convert it to a blob:
  // URL string first. jsdom lacks URL.createObjectURL, so inject one plus a
  // STRICT pipeline that rejects non-string input, and confirm run() succeeds
  // and hands the pipeline a string (not the raw object).
  {
    let seen, made = 0;
    const env = loadAdapters({ inject: (w) => {
      w.URL.createObjectURL = () => 'blob:cleo/' + (++made);
      w.URL.revokeObjectURL = () => {};
      w.EO_TRANSFORMERS = { pipeline: async (task) => async (input) => {
        if (task !== 'image-to-text') return {};
        seen = input;
        if (typeof input !== 'string') throw new Error('Unsupported input type: ' + typeof input);
        return [{ generated_text: 'Recognized text' }];
      } };
    } });
    // control: the strict pipeline really rejects a raw object (the live bug)
    let rejected = false;
    try { await (await env.window.EO_TRANSFORMERS.pipeline('image-to-text'))(new env.window.Blob(['x'])); } catch (_) { rejected = true; }
    ok('[trocr] (control) the strict image pipeline rejects a raw Blob', rejected);
    const ev = await env.EOAdapters.byId('ocr-trocr-printed').run(new env.window.Blob(['imgbytes']));
    const e0 = Array.isArray(ev) && ev[0];
    ok('[trocr] a Blob input no longer fails — it is normalized first',
      !!e0 && !(e0.meta && e0.meta.kind === 'failure'), JSON.stringify(e0 && e0.payload));
    ok('[trocr] the pipeline received a string (blob: URL), not the raw object', typeof seen === 'string', 'seen=' + typeof seen);
    ok('[trocr] the recognized text rides on the event', !!e0 && e0.payload && e0.payload.text === 'Recognized text');
  }

  console.log(failed
    ? ('\n✗ FAIL — ' + passed + ' passed, ' + failed + ' failed')
    : ('\n✓ PASS — ' + passed + ' adapter contract checks passed, 0 failed'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
