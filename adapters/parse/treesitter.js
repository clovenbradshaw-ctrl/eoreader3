/* ============================================================
   Code AST adapter — web-tree-sitter (capability "code-ast", modality "code").
   Deterministic: confidence 1.0, semantics "deterministic".

   One event per top-level node (refinable later), region.kind "node" with byte
   offsets, payload { type, text, identifiers }.

   tree-sitter ships a separate WASM grammar per language; this single adapter
   loads them ON DEMAND by the language tag passed to run(input, { language }).
   It ships with JavaScript and Python grammars; more are one entry in
   meta.grammars. (The interface spec floats a per-language MANIFEST; the build
   prompt's file layout pins a single treesitter manifest, so this adapter is one
   manifest carrying many grammars — noted in the PR description.)

   The runtime is resolved from window.EO_TREESITTER (test seam), a global
   window.TreeSitter, or a CDN import, and is read defensively so it works across
   web-tree-sitter API revisions (default-export Parser vs named { Parser,
   Language }).
   ============================================================ */
(function () {
  'use strict';
  if (!window.EOAdapters || !window.EOAdapterContract) return;
  const C = window.EOAdapterContract;

  const GRAMMARS = {
    javascript: 'https://tree-sitter.github.io/tree-sitter-javascript.wasm',
    python: 'https://tree-sitter.github.io/tree-sitter-python.wasm',
  };

  const manifest = {
    id: 'code-ast-treesitter',
    name: 'Code AST (tree-sitter)',
    version: '1.0.0',
    category: 'parsing',
    modality: 'code',
    capability: 'code-ast',
    modelRef: { runtime: 'deterministic', model: 'web-tree-sitter', version: '0.x' },
    resources: { backend: 'wasm', memMB: 40, expectedLatencyMs: 100 },
    confidenceSemantics: 'deterministic',
    failureModes: [
      'unsupported language tag (reported as a failure event)',
      'grammar WASM fails to download (reported as a failure event)',
      'syntactically broken source still parses, with ERROR nodes in the tree',
    ],
    output: { event: 'one per top-level node', payload: '{ type: string, text: string, identifiers: string[] }' },
    meta: { grammars: GRAMMARS, languages: Object.keys(GRAMMARS) },
  };
  const ref = { id: manifest.id, version: manifest.version };

  let TSmod = null, TSmodP = null, inited = false;
  const grammarCache = Object.create(null);

  async function resolveLib() {
    if (window.EO_TREESITTER) return window.EO_TREESITTER;
    if (window.TreeSitter) return window.TreeSitter;
    if (!TSmodP) TSmodP = import('https://cdn.jsdelivr.net/npm/web-tree-sitter@0.22.6/+esm');
    return TSmodP;
  }
  const ParserOf = (mod) => mod.Parser || mod.default || mod;
  const LanguageOf = (mod, Parser) => mod.Language || (Parser && Parser.Language);

  async function ensureInit() {
    if (inited) return TSmod;
    TSmod = await resolveLib();
    const Parser = ParserOf(TSmod);
    if (Parser && typeof Parser.init === 'function') await Parser.init();
    inited = true;
    return TSmod;
  }

  async function load() { await ensureInit(); }
  const ready = () => inited;

  async function grammar(lang) {
    if (grammarCache[lang]) return grammarCache[lang];
    const url = GRAMMARS[lang];
    if (!url) throw new Error('unsupported language: ' + lang);
    const Parser = ParserOf(TSmod);
    const Language = LanguageOf(TSmod, Parser);
    grammarCache[lang] = await Language.load(url);
    return grammarCache[lang];
  }

  // Collect identifier-ish leaf text under a node, robust to API differences.
  function identifiers(node) {
    const out = [];
    if (node && typeof node.descendantsOfType === 'function') {
      try { for (const d of node.descendantsOfType('identifier')) out.push(d.text); return [...new Set(out)]; } catch (_) {}
    }
    (function walk(n) {
      if (!n) return;
      const type = n.type || '';
      if (/identifier|name/.test(type) && n.text) out.push(n.text);
      const kids = n.namedChildren || n.children || [];
      for (const k of kids) walk(k);
    })(node);
    return [...new Set(out)];
  }

  async function run(input, opts) {
    const lang = (opts && (opts.language || opts.lang)) || 'javascript';
    try { await ensureInit(); } catch (e) { return [C.failureEvent(ref, 'tree-sitter init failed: ' + (e && e.message), { recoverable: true })]; }
    let Lang;
    try { Lang = await grammar(lang); }
    catch (e) { return [C.failureEvent(ref, e && e.message, { recoverable: false, meta: { language: lang } })]; }

    const Parser = ParserOf(TSmod);
    const parser = new Parser();
    parser.setLanguage(Lang);
    const src = String(input == null ? '' : input);
    const tree = parser.parse(src);
    const root = tree && tree.rootNode;
    const tops = (root && (root.namedChildren || root.children)) || [];
    const events = tops.map(node => C.event({
      adapter: ref,
      region: { kind: 'node', start: node.startIndex || 0, end: node.endIndex || 0 },
      confidence: 1,
      payload: { type: node.type || 'node', text: node.text != null ? node.text : src.slice(node.startIndex || 0, node.endIndex || 0), identifiers: identifiers(node) },
      meta: { language: lang },
    }));
    try { if (parser.delete) parser.delete(); } catch (_) {}
    return events;
  }

  async function unload() { inited = false; TSmod = null; TSmodP = null; for (const k of Object.keys(grammarCache)) delete grammarCache[k]; }

  window.EOAdapters.register({ manifest, load, ready, run, unload });
})();
