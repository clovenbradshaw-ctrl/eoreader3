/* ============================================================
   tests/conventions.test.js — the conventions graph (conventions.jsonl).

   Three contracts:
     1. WELL-FORMED — every line parses; ops are eo vocabulary; seq is
        strictly increasing; member-of edges point at declared conventions.
     2. NO DRIFT — projecting the file and loading it into a fresh engine
        reproduces the engine's shipped seeds EXACTLY, for every covered
        convention in every module. The file and the code cannot disagree.
     3. LIVE — loadConventions actually rebuilds the lexical sets (a changed
        inventory is visible in behavior), and a missing/garbled file is
        harmless (fallback to seeds).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../evo/engine-host');

const FILE = path.join(__dirname, '..', 'conventions.jsonl');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

async function main() {
  const text = fs.readFileSync(FILE, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());

  group('well-formed — an eo-operation log', () => {
    const OPS = new Set(['INS', 'SYN', 'DEF', 'SIG', 'NUL', 'SEG', 'CON', 'EVA', 'REC']);
    let lastSeq = -1, parsed = 0, badOp = 0, badSeq = 0;
    const conventionIds = new Set();
    const danglingEdges = [];
    const records = [];
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch (e) { continue; }
      parsed++;
      records.push(r);
      if (!OPS.has(r.op)) badOp++;
      if (!(r.seq > lastSeq)) badSeq++;
      lastSeq = r.seq;
      if (r.op === 'INS' && r.kind === 'convention') conventionIds.add(r.id);
    }
    for (const r of records) if (r.op === 'SYN' && r.v === 'member-of' && !conventionIds.has(r.o)) danglingEdges.push(r.o);
    eq(parsed, lines.length, 'every line parses as JSON (' + parsed + '/' + lines.length + ')');
    eq(badOp, 0, 'every op is in the nine-operator vocabulary');
    eq(badSeq, 0, 'seq strictly increases (append-only log)');
    eq(danglingEdges.length, 0, 'every member-of edge targets a declared convention' + (danglingEdges.length ? ' (dangling: ' + danglingEdges.slice(0, 3).join(', ') + ')' : ''));
    ok(conventionIds.size >= 60, 'covers a real inventory (' + conventionIds.size + ' conventions)');
  });

  await group('no drift — the file and the seeds agree exactly', async () => {
    const seedE = loadEngine().EOEngine;             // untouched seeds
    const fileE = loadEngine().EOEngine;             // fresh instance
    const res = fileE.loadConventions(text);
    ok(res.records === lines.length, 'loadConventions consumed every record');
    ok(res.applied >= 25, 'applied the en-narrative conventions (' + res.applied + ')');
    ok(res.packApplied >= 40, 'applied the es/zh/code conventions (' + res.packApplied + ')');
    const a = seedE._conventionsExport(), b = fileE._conventionsExport();
    for (const [modId, mod] of Object.entries(a.modules)) {
      for (const [rule, value] of Object.entries(mod.conventions)) {
        eq(b.modules[modId].conventions[rule], value, modId + ':' + rule + ' identical after load');
      }
      eq(b.modules[modId].props, mod.props, modId + ' module props identical');
    }
  });

  await group('live — the graph actually drives the reading', async () => {
    // Append one membership edge (make "Zonk" an article), load, and watch
    // the reading change — the file is load-bearing, not decorative. Then a
    // garbled file is harmless.
    const E = loadEngine().EOEngine;
    const records = text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    // Append ONE membership edge — "zonkmaster" joins the role-title heads —
    // and the naming bridge can suddenly distill a role DEF it could not
    // before. Pure convention→regex→reading; no NER anywhere in the path.
    records.push({ seq: 99990, op: 'SYN', s: 'zonkmaster', v: 'member-of', o: 'en-narrative-v1:role_title_heads' });
    const TXT = 'The Appointment\n\nThe contract was arranged by the same person who is the zonkmaster of the docks. That person is Tom Turner.';
    const roleOf = async (id) => {
      const d = await E.parseDocument(id + '.txt', TXT, id);
      return (E.assertionsOf(d) || []).some(a => a.path === 'role' && /zonkmaster/i.test(a.is));
    };
    const before = await roleOf('s1');
    E.loadConventions(records);
    const after = await roleOf('s2');
    ok(!before && after,
      'an appended member-of edge changes the reading (zonkmaster became a role-title head: role DEF ' + before + ' → ' + after + ')');
    const E2 = loadEngine().EOEngine;
    const junk = E2.loadConventions('not json\n{"op":"INS"\n42\n');
    ok(junk.applied === 0 && junk.packApplied === 0, 'a garbled file applies nothing and never throws (fallback to seeds)');
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
