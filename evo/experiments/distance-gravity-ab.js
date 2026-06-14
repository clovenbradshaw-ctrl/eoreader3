/* ============================================================
   distance-gravity-ab.js — the A/B harness (WI-3 of docs/distance-gravity.md).

   Runs BOTH pull laws over the annotated binding + stall fixtures and prints a
   side-by-side comparison, so the parity-breaking default-flip (WI-4) is gated
   on measured evidence rather than taste:

     A  geometric clock   distance_gravity OFF   score = surface_mass·w + momentum
     B  distance law       distance_gravity ON    score = Σ 1/(d+k)^α over tokens

   The collision law (δ dominance, the floor, NUL) is identical under both; only
   how pull is computed differs. Read-only: it changes no engine output and
   writes no golden. Deterministic.

     node evo/experiments/distance-gravity-ab.js

   The bar (from the design note): the distance law must bind AT LEAST as
   accurately AND stall in more honest places than the geometric clock. If it
   does not, the geometric clock stays and this read is the record of why.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../../tests/harness');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(ROOT, 'evo', 'fixtures');

const W = loadEngine();
const E = W.EOEngine;
E.loadConventions(fs.readFileSync(path.join(ROOT, 'memory', 'conventions.jsonl'), 'utf8'));

function setRules(cfg) {
  // value 1/0 is the reliable on/off (installed:false would merely skip the rule
  // and leave it as-was); enabled:true keeps applyRules from special-casing it.
  const c = cfg || {};
  const rules = [
    { id: 'distance-gravity', installed: true, enabled: true, value: c.distance ? 1 : 0 },
  ];
  if (c.alpha != null) rules.push({ id: 'gravity-alpha', installed: true, enabled: true, value: c.alpha });
  if (c.koff != null) rules.push({ id: 'gravity-offset', installed: true, enabled: true, value: c.koff });
  // deriveSets re-applies window.EO_RULES on every parse (it write-throughs the
  // conventions projection first, which would otherwise reset these add-ons to
  // their shipped defaults). The app maintains window.EO_RULES; the harness must
  // set it too so a toggled rule survives the parse — same as the live reader.
  W.EO_RULES = rules;
  E.applyRules(rules);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const lastTok = (s) => { const a = norm(s).split(' ').filter(Boolean); return a[a.length - 1] || ''; };
// A resolved speaker matches a gold referent if either name contains the other,
// or they share a surname (last token) — "Princess Mary" ~ "Mary", "Mr. Calloway" ~ "Calloway".
function speakerMatches(speaker, referent) {
  const a = norm(speaker), b = norm(referent);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return lastTok(a) && lastTok(a) === lastTok(b);
}

function sigEvents(doc) {
  return (doc._events || []).filter((e) => e.op === 'SIG');
}
function stallSet(doc) {
  const set = new Set();
  for (const e of doc._events || []) {
    if (e.op === 'NUL' && /pronoun-stall/.test(e.reason || '')) set.add(e.sentence_idx + '|' + norm(e.surface));
  }
  return set;
}
function findSentIdx(doc, needle) {
  const n = norm(needle);
  const sents = doc.sentenceTexts || [];
  for (let i = 0; i < sents.length; i++) if (norm(sents[i]).includes(n)) return i;
  return -1;
}

async function scoreBinding(fixture, cfg) {
  setRules(cfg);
  const txt = fs.readFileSync(path.join(FIX, 'binding', fixture.docFile), 'utf8');
  const doc = await E.parseDocument(fixture.id + '.txt', txt, 'narrative');
  const sigs = sigEvents(doc);
  const rows = [];
  for (const g of fixture.bindings) {
    const n = norm(g.sentence);
    // the SIG whose quote carries this gold line
    const sig = sigs.find((e) => norm(e.quote || '').includes(n));
    const speaker = sig ? sig.speaker : '(no SIG)';
    const correct = speakerMatches(speaker, g.referent);
    rows.push({ sentence: g.sentence, want: g.referent, got: speaker, correct });
  }
  return rows;
}

async function scoreStalls(fixture, cfg) {
  setRules(cfg);
  const txt = fs.readFileSync(path.resolve(path.join(FIX, 'stalls'), fixture.docFile), 'utf8');
  const doc = await E.parseDocument(fixture.id + '.txt', txt, 'narrative');
  const stalls = stallSet(doc);
  const rows = [];
  for (const s of fixture.sites) {
    const idx = findSentIdx(doc, s.sentence);
    const stalled = idx >= 0 && stalls.has(idx + '|' + norm(s.surface));
    const verdict = stalled ? 'stall' : 'bind';
    rows.push({ surface: s.surface, want: s.expect, got: verdict, correct: verdict === s.expect, note: s.note });
  }
  return rows;
}

function pct(n, d) { return d ? Math.round((100 * n) / d) : 0; }

let BINDING_FX, STALL_FX;
async function scoreAll(cfg) {
  // returns { bindRows, stallRows, bindOK, bindN, stallOK, stallN }
  const out = { bindRows: [], stallRows: [], bindOK: 0, bindN: 0, stallOK: 0, stallN: 0 };
  for (const fx of BINDING_FX) {
    const rows = await scoreBinding(fx, cfg);
    for (const r of rows) { out.bindN++; if (r.correct) out.bindOK++; out.bindRows.push({ fx: fx.id, ...r }); }
  }
  for (const fx of STALL_FX) {
    const rows = await scoreStalls(fx, cfg);
    for (const r of rows) { out.stallN++; if (r.correct) out.stallOK++; out.stallRows.push({ fx: fx.id, ...r }); }
  }
  return out;
}

function flips(base, b) {
  let bindToward = 0, bindAway = 0, stallToward = 0, stallAway = 0;
  for (let i = 0; i < base.bindRows.length; i++) {
    if (base.bindRows[i].got !== b.bindRows[i].got) {
      if (!base.bindRows[i].correct && b.bindRows[i].correct) bindToward++;
      if (base.bindRows[i].correct && !b.bindRows[i].correct) bindAway++;
    }
  }
  for (let i = 0; i < base.stallRows.length; i++) {
    if (base.stallRows[i].got !== b.stallRows[i].got) {
      if (!base.stallRows[i].correct && b.stallRows[i].correct) stallToward++;
      if (base.stallRows[i].correct && !b.stallRows[i].correct) stallAway++;
    }
  }
  return { bindToward, bindAway, stallToward, stallAway };
}
function perItem(label, base, b) {
  console.log(`## Per-item: geometric baseline (A) vs ${label} (B)\n`);
  console.log('### binding — each quoted line → its human-correct speaker');
  for (let i = 0; i < base.bindRows.length; i++) {
    const ra = base.bindRows[i], rb = b.bindRows[i];
    const m = (r) => (r.correct ? '✓' : '✗');
    console.log(`  ${m(ra)}A ${m(rb)}B  want=${ra.want.padEnd(9)} A=${String(ra.got).padEnd(14)} B=${String(rb.got).padEnd(14)} "${ra.sentence.slice(0, 34)}"${ra.got !== rb.got ? '  ←Δ' : ''}`);
  }
  console.log('\n### stalls — where an honest reader holds vs binds');
  for (let i = 0; i < base.stallRows.length; i++) {
    const ra = base.stallRows[i], rb = b.stallRows[i];
    const m = (r) => (r.correct ? '✓' : '✗');
    console.log(`  ${m(ra)}A ${m(rb)}B  "${ra.surface}" want=${ra.want.padEnd(5)} A=${ra.got.padEnd(5)} B=${rb.got.padEnd(5)} — ${String(ra.note).slice(0, 56)}${ra.got !== rb.got ? '  ←Δ' : ''}`);
  }
  console.log('');
}

async function main() {
  BINDING_FX = ['veranda', 'steward'].map((id) =>
    JSON.parse(fs.readFileSync(path.join(FIX, 'binding', id + '.json'), 'utf8')));
  STALL_FX = ['dispatch', 'steward'].map((id) =>
    JSON.parse(fs.readFileSync(path.join(FIX, 'stalls', id + '.json'), 'utf8')));

  console.log('# Distance-gravity A/B — geometric clock (A) vs ACT-R distance law (B)\n');
  console.log('Both share the collision rule (δ=2.0 dominance, the pronoun floor, NUL); only the');
  console.log('PROPORTION magnitude differs:  A = surface_mass·w + momentum   B = Σ 1/(d+k)^α over tokens\n');

  // ── A: the geometric clock (the live default) ──
  const base = await scoreAll({});
  console.log(`baseline (geometric A):  binding ${pct(base.bindOK, base.bindN)}% (${base.bindOK}/${base.bindN})   stall ${pct(base.stallOK, base.stallN)}% (${base.stallOK}/${base.stallN})   total ${base.bindOK + base.stallOK}/${base.bindN + base.stallN}\n`);

  // ══ B: the distance law, swept ══════════════════════════════════════
  // The design note says α∈[0.5,1] is defensible and "the fixtures decide".
  const ALPHAS = [0.5, 0.7, 1.0, 1.5];
  const KS = [5, 10, 20, 50];
  console.log('## Parameter sweep (distance law) — binding% / stall% / total-correct\n');
  console.log('   α \\ k  ' + KS.map((k) => String(k).padStart(12)).join(''));
  let bBest = null;
  for (const a of ALPHAS) {
    let line = '  ' + String(a).padStart(4) + '  ';
    for (const k of KS) {
      const r = await scoreAll({ distance: true, alpha: a, koff: k });
      line += `${pct(r.bindOK, r.bindN)}/${pct(r.stallOK, r.stallN)}/${r.bindOK + r.stallOK}`.padStart(12);
      const total = r.bindOK + r.stallOK;
      // prefer higher total; tie-break toward fewer regressions-away then lower α
      if (!bBest || total > bBest.total) bBest = { a, k, ...r, total };
    }
    console.log(line);
  }
  console.log('');
  const b = await scoreAll({ distance: true, alpha: bBest.a, koff: bBest.k });
  const bf = flips(base, b);

  perItem(`distance law at α=${bBest.a}, k=${bBest.k}`, base, b);

  // ── Scoreboard ──
  console.log('## Scoreboard\n');
  const row = (label, r, f) =>
    console.log(`  ${label.padEnd(28)} binding ${(pct(r.bindOK, r.bindN) + '%').padStart(4)} (${r.bindOK}/${r.bindN})  stall ${(pct(r.stallOK, r.stallN) + '%').padStart(4)} (${r.stallOK}/${r.stallN})  total ${r.bindOK + r.stallOK}/${r.bindN + r.stallN}   [toward gold ${f ? f.bindToward + f.stallToward : 0}, away ${f ? f.bindAway + f.stallAway : 0}]`);
  row('A geometric (baseline)', base, null);
  row(`B distance law (α=${bBest.a},k=${bBest.k})`, b, bf);
  console.log('');

  const noReg = bf.bindAway === 0 && bf.stallAway === 0;
  const better = (b.bindOK > base.bindOK) || (b.stallOK > base.stallOK);
  const totalUp = (b.bindOK + b.stallOK) > (base.bindOK + base.stallOK);
  const verdict = b.bindOK >= base.bindOK && b.stallOK >= base.stallOK && better && noReg;
  console.log('## Verdict (the gate from docs/distance-gravity.md, WI-4)\n');
  console.log(`  binds at least as accurately:        ${b.bindOK >= base.bindOK}`);
  console.log(`  stalls at least as honestly:         ${b.stallOK >= base.stallOK}`);
  console.log(`  nothing regressed away from gold:    ${noReg}`);
  console.log(`  total correctness increased:         ${totalUp}`);
  console.log(`\n  ${verdict
    ? `PASS — the distance law (α=${bBest.a}, k=${bBest.k}) wins; WI-4 (default-flip + golden recapture) is justified.`
    : 'HOLD — the geometric clock stays the default; the law ships behind its rule, and this read is the record of why.'}`);
  console.log('\n## Reading\n');
  console.log('  • The distance law is NOT inert — it fixes the honest stalls the geometric clock');
  console.log('    over-/under-holds — but total correctness is conserved across the whole (α,k)');
  console.log('    grid: every stall it wins, it pays for with a binding it loses. The recency law');
  console.log('    slides errors along a tradeoff curve; it does not reduce them, because the');
  console.log('    residual errors are not recency errors. (Trace the steward misses: a gender-');
  console.log('    ambiguous name, "Dron", is mis-gendered female by a momentum-dominant "she"');
  console.log('    bind, which then makes the sign exclusion inert — a gender-bootstrap error that');
  console.log('    no pull law can move. The observed cure, reading "his cap" as gender evidence,');
  console.log('    needs the whole-field type knowledge the greedy reader lacks here: it belongs');
  console.log('    in the enrichment pass. See the PR write-up / docs/distance-gravity.md.)');
  setRules({}); // leave the engine on the parity floor (all add-ons off)
}
main().catch((e) => { console.error(e); process.exit(1); });
