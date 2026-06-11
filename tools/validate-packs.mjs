#!/usr/bin/env node
/* ============================================================
   tools/validate-packs.mjs — well-formedness gate for the convention packs
   in memory/packs/ (and candidates in memory/drafts/).

   The engine folds these fragments like any other ledger events; this checks
   the same contracts tests/conventions.test.js pins for memory/conventions.jsonl,
   scoped to each pack FILE in isolation:

     - every line parses as JSON
     - op is in the nine-operator eo vocabulary
     - seq strictly increases within the file (append-only)
     - the pack declares its module (INS kind:module), and every convention's
       `module` field matches a module declared in the same file
     - every member-of edge targets a convention declared in the same file
     - every INS kind:convention is epistemic:'assertion', revisable:true
       (the charter: every convention is an assertion, contextual and revisable)
     - every DEF names a slot (path or property) and carries a value

   It does NOT re-validate memory/conventions.jsonl — tests/conventions.test.js
   owns that, including the file≡seeds drift contract a standalone pack has no
   part in.

   Usage:
     node tools/validate-packs.mjs                 # all packs + drafts
     node tools/validate-packs.mjs memory/packs/el-classical-v1.jsonl
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OPS = new Set(['INS', 'SYN', 'DEF', 'SIG', 'NUL', 'SEG', 'CON', 'EVA', 'REC']);

function listDefault() {
  const dirs = [path.join(ROOT, 'memory', 'packs'), path.join(ROOT, 'memory', 'drafts')];
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (f.endsWith('.jsonl') && f !== 'INDEX.jsonl') out.push(path.join(d, f));
    }
  }
  return out;
}

function validate(file) {
  const errs = [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const records = [];
  let lastSeq = -Infinity;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    let r;
    try { r = JSON.parse(t); } catch (e) { errs.push(`L${i + 1}: not JSON (${e.message})`); return; }
    records.push(r);
    if (!OPS.has(r.op)) errs.push(`L${i + 1}: op '${r.op}' not in the eo vocabulary`);
    if (typeof r.seq !== 'number' || !(r.seq > lastSeq)) errs.push(`L${i + 1}: seq ${r.seq} not strictly increasing (prev ${lastSeq})`);
    if (typeof r.seq === 'number') lastSeq = r.seq;
  });

  const moduleIds = new Set(records.filter(r => r.op === 'INS' && r.kind === 'module').map(r => r.id));
  if (!moduleIds.size) errs.push("no INS kind:module — a pack must declare the module it carries");
  const conventionIds = new Set(records.filter(r => r.op === 'INS' && r.kind === 'convention').map(r => r.id));

  for (const r of records) {
    if (r.op === 'INS' && r.kind === 'convention') {
      if (r.epistemic !== 'assertion' || r.revisable !== true) errs.push(`${r.id}: a convention must be epistemic:'assertion', revisable:true`);
      if (r.module && moduleIds.size && !moduleIds.has(r.module)) errs.push(`${r.id}: module '${r.module}' is not declared in this file`);
    }
    if (r.op === 'SYN' && r.v === 'member-of' && !conventionIds.has(r.o)) {
      errs.push(`member-of edge '${r.s}' → '${r.o}' targets an undeclared convention`);
    }
    if (r.op === 'DEF') {
      if (r.target == null) errs.push(`DEF with no target (seq ${r.seq})`);
      else if (r.path == null && r.property == null) errs.push(`DEF on '${r.target}' names no slot (path|property)`);
      else if (!('value' in r)) errs.push(`DEF on '${r.target}' carries no value`);
    }
  }
  return { file, records: records.length, errs };
}

const args = process.argv.slice(2);
const files = args.length ? args : listDefault();
if (!files.length) { console.log('no pack files found under memory/packs/ or memory/drafts/'); process.exit(0); }

let failed = 0;
for (const f of files) {
  const abs = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
  const { records, errs } = validate(abs);
  const rel = path.relative(ROOT, abs);
  if (errs.length) { failed++; console.error(`✗ ${rel} — ${errs.length} problem(s):`); for (const e of errs) console.error('   - ' + e); }
  else console.log(`✓ ${rel} — ${records} records, well-formed`);
}
console.log(failed ? `\n✗ ${failed} pack(s) failed validation` : `\n✓ all packs well-formed`);
process.exit(failed ? 1 : 0);
