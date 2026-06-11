/* ============================================================
   evo/experiments/conformance-sweep.js

   Run the corpus through the reading-conformance instrument
   (tools/conformance.js) and report how we do: one 7-bit vector
   per document (ADMISSION BINDING SPEECH COMPANY DARK WEIGHT
   CUSTOM), the violated-law histogram behind each 0, and sample
   witnesses. Deterministic; no model.

   Each document is scored under the conformance pack of its
   REGISTER (tools/packs/*.json — gutenberg apparatus, Spanish,
   Chinese, Aozora-Japanese), because the surface criteria are
   conventions, not engine: the same checks read every register,
   only the pack changes. `--bare` scores everything under the
   default (web-shaped) pack instead, to show what the invented
   conventions buy.

   Usage:
     node evo/experiments/conformance-sweep.js
     node evo/experiments/conformance-sweep.js --docs hod,quijote --verbose
     node evo/experiments/conformance-sweep.js --cap 40000 --json out.json
     node evo/experiments/conformance-sweep.js --bare
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../engine-host');
const C = require('../../tools/conformance');

const CORPUS = path.join(__dirname, '..', 'corpus');
const PACKS = path.join(__dirname, '..', '..', 'tools', 'packs');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const CAP = parseInt(arg('--cap', '20000'), 10);
const VERBOSE = has('--verbose');
const BARE = has('--bare');
const ONLY = (arg('--docs', '') || '').split(',').filter(Boolean);

const BATTERY = [
  // English, Gutenberg apparatus
  { id: 'federalist', file: 'pg18.txt', lang: 'en', pack: 'gutenberg' },
  { id: 'wealth', file: 'pg3300.txt', lang: 'en', pack: 'gutenberg' },
  { id: 'liberty', file: 'pg34901.txt', lang: 'en', pack: 'gutenberg' },
  { id: 'hod', file: 'pg219.txt', lang: 'en', pack: 'gutenberg' },
  { id: 'goriot', file: 'pg1237.txt', lang: 'en', pack: 'gutenberg' },
  { id: 'meta', file: 'pg5200.txt', lang: 'en', pack: 'gutenberg' },
  { id: 'underground', file: 'pg600.txt', lang: 'en', pack: 'gutenberg' },
  // Non-English
  { id: 'quijote', file: 'pg2000.txt', lang: 'es', pack: 'es' },
  { id: 'noli', file: 'pg47584.txt', lang: 'es', pack: 'es' },
  { id: 'hongloumeng', file: 'pg24264.txt', lang: 'zh', pack: 'zh' },
  { id: 'botchan', file: 'soseki_botchan.txt', lang: 'ja→zh', pack: 'ja' },
  { id: 'rashomon', file: 'akutagawa_rashomon.txt', lang: 'ja→zh', pack: 'ja' },
  { id: 'verwandlung', file: 'pg22367.txt', lang: 'de→en', pack: 'gutenberg' },
  { id: 'veljesta', file: 'pg11940.txt', lang: 'fi→en', pack: 'gutenberg' },
];

function strip(t) {
  const a = t.indexOf('*** START');
  const s = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(s, b >= 0 ? b : t.length).trim();
}
function loadPack(name) {
  if (BARE || !name) return null;
  const p = path.join(PACKS, name + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

const r2 = (x) => Math.round(x * 100) / 100;
function fmt(rows, cols) {
  const w = cols.map(c => Math.max(c.h.length, ...rows.map(r => String(c.f(r)).length)));
  const line = cs => cs.map((s, i) => String(s).padEnd(w[i])).join('  ');
  return [line(cols.map(c => c.h)), line(w.map(x => '-'.repeat(x))), ...rows.map(r => line(cols.map(c => c.f(r))))].join('\n');
}

(async () => {
  const E = loadEngine().EOEngine;
  console.log(`conformance sweep · cap ${CAP} chars · packs: ${BARE ? 'BARE (default web pack)' : 'per-register (tools/packs)'}\n`);

  const rows = [];
  for (const d of BATTERY) {
    if (ONLY.length && !ONLY.includes(d.id)) continue;
    const text = strip(fs.readFileSync(path.join(CORPUS, d.file), 'utf8')).slice(0, CAP);
    const doc = await E.parseDocument(d.id + '.txt', text, d.id);
    const report = E.ingestionReport(doc);
    if (!report) { console.log(`${d.id}: no prose report (kind=${doc && doc.kind})`); continue; }
    const res = C.checkDump(report, { pack: loadPack(d.pack) || undefined });
    const lawHist = {};
    for (const k of C.INVARIANTS) for (const f of res.bits[k].findings) lawHist[f.law] = (lawHist[f.law] || 0) + 1;
    rows.push({
      id: d.id, lang: d.lang, pack: BARE ? 'default' : d.pack,
      sents: report.doc.sentences, ents: report.counts.entities, events: report.counts.events,
      ops: report.counts.ops, vector: res.vectorString, res, lawHist,
      detectedLang: report.doc.lang,
    });
  }

  console.log('=== VECTORS (ADMISSION BINDING SPEECH COMPANY DARK WEIGHT CUSTOM) ===');
  console.log(fmt(rows, [
    { h: 'doc', f: r => r.id },
    { h: 'lang', f: r => r.lang + (r.detectedLang !== r.lang.split('→')[0] && !r.lang.includes('→') ? '!' + r.detectedLang : '') },
    { h: 'pack', f: r => r.pack },
    { h: 'sents', f: r => r.sents },
    { h: 'ents', f: r => r.ents },
    { h: 'events', f: r => r.events },
    { h: 'vector', f: r => r.vector },
  ]));

  console.log('\n=== WHY (violated-law histogram per doc) ===');
  for (const r of rows) {
    const hist = Object.entries(r.lawHist).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}×${c}`).join('  ');
    console.log(`${r.id.padEnd(12)} ${hist || '(conformant)'}`);
  }

  console.log('\n=== SAMPLE WITNESSES ===');
  for (const r of rows) {
    const picks = [];
    for (const k of C.INVARIANTS) for (const f of r.res.bits[k].findings.slice(0, VERBOSE ? 6 : 1)) picks.push(`  [${k}/${f.law}] ${f.detail}`);
    if (!picks.length) continue;
    console.log(`\n${r.id}:`);
    for (const p of picks.slice(0, VERBOSE ? 40 : 7)) console.log(p);
  }

  // aggregate: per-bit pass rate across the corpus
  console.log('\n=== AGGREGATE (pass rate per invariant, ' + rows.length + ' docs) ===');
  C.INVARIANTS.forEach((k, i) => {
    const passed = rows.filter(r => r.res.vector[i] === 1).length;
    console.log(`  ${k.padEnd(9)} ${passed}/${rows.length}  ${r2(passed / rows.length)}`);
  });

  const jsonOut = arg('--json', null);
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      schema: 'cleon-conformance-sweep/1', at: new Date().toISOString(), cap: CAP, bare: BARE,
      rows: rows.map(r => ({ id: r.id, lang: r.lang, pack: r.pack, sents: r.sents, ents: r.ents, events: r.events, ops: r.ops, vector: r.vector, laws: r.lawHist })),
    }, null, 1));
    console.log('\nwrote ' + jsonOut);
  }
})().catch(e => { console.error(e); process.exit(1); });
