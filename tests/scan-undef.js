/* Static scan for the crash class that just bit ModelPopover: an identifier
   referenced in a component body but never declared (not a param, local, import,
   or known global) — a ReferenceError the moment that branch renders. */
'use strict';
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.resolve(__dirname, '..');
const FILES = ['data.jsx', 'icons.jsx', 'sidebar.jsx', 'chat.jsx', 'docview.jsx',
  'rulesets.jsx', 'auditview.jsx', 'graphaudit.jsx', 'sandbox.jsx', 'pivot.jsx', 'app.jsx'];

// browser + app globals that are legitimately free identifiers
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'console', 'React', 'ReactDOM', 'nlp',
  'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'localStorage',
  'sessionStorage', 'location', 'history', 'Blob', 'URL', 'FileReader', 'File',
  'Worker', 'TextDecoder', 'TextEncoder', 'Math', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Promise', 'Symbol', 'Error', 'TypeError', 'RangeError', 'isNaN',
  'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'NaN', 'Infinity', 'undefined', 'globalThis', 'structuredClone', 'queueMicrotask',
  'getComputedStyle', 'matchMedia', 'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'Intl', 'crypto', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent',
  'CustomEvent', 'ResizeObserver', 'IntersectionObserver', 'MutationObserver',
  'requestIdleCallback', 'cancelIdleCallback', 'Reflect', 'Proxy', 'BigInt',
  'arguments', 'eval', 'module', 'exports', 'require', 'process',
]);

let findings = 0;
for (const file of FILES) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', plugins: ['jsx'] }); }
  catch (e) { console.log(`PARSE FAIL ${file}: ${e.message}`); continue; }

  // collect every top-level (program-scope) binding name across ALL files first?
  // These files share one global scope at runtime (script tags), so a function
  // defined in data.jsx is visible in app.jsx. Gather program-level decls per file
  // and treat the union as available globals.
  traverse(ast, {
    Program(p) {
      for (const name of Object.keys(p.scope.bindings)) GLOBALS.add(name);
    },
  });
}

// second pass: flag references whose binding can't be resolved and isn't global
for (const file of FILES) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let ast;
  try { ast = parser.parse(code, { sourceType: 'script', plugins: ['jsx'] }); } catch (e) { continue; }
  traverse(ast, {
    ReferencedIdentifier(p) {
      const name = p.node.name;
      if (p.scope.hasBinding(name)) return;   // bound as param/local/import in scope chain
      if (GLOBALS.has(name)) return;          // browser global or a top-level (window) decl in any file
      // ignore JSX member/namespace and object keys
      const fn = p.getFunctionParent();
      const where = fn && fn.node && (fn.node.id && fn.node.id.name);
      console.log(`${file}:${p.node.loc.start.line}  undeclared '${name}'` + (where ? `  (in ${where})` : ''));
      findings++;
    },
  });
}
console.log(findings ? `\n${findings} suspect identifier(s).` : '\nNo undeclared identifiers found.');
process.exit(findings ? 1 : 0);
