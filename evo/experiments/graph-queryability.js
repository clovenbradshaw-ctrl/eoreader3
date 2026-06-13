/* ============================================================
   evo/experiments/graph-queryability.js

   "Run experiments to see what creates better GRAPHS for querying
   against — use the corpus to experiment with."

   The reading engine turns a document into a GRAPH (entities + their
   mentions, speech-attribution signals, DEF assertions, relations) and
   every answer is a query AGAINST that graph. So "a better graph for
   querying" is a graph that:

     - RESOLVES   — speech lands on a named speaker, not "?"
     - CONSOLIDATES — the same person is one referent, not three shards
                      ("Marlow" / "Charlie Marlow" split = a worse graph)
     - COVERS     — entity-bearing structure reaches most sentences
     - ANSWERS    — when you ask "who is X", the engine returns a grounded,
                    cited answer rather than a void

   This harness measures those four facets DETERMINISTICALLY over the
   public-domain corpus (no API, no embedder fires in Node, so a parse is
   a pure function of (text, rules) — every number here reproduces
   bit-exact). It then SWEEPS the engine's tunable physics — the only
   knobs the evo constitution lets a candidate move — and reports which
   settings build the most queryable graph, and at what cost.

   It NEVER writes engine.js. It tunes a loaded engine instance in memory
   via EOEngine.applyRules() and re-parses; the repo's engine.js is read,
   not changed. (To turn a finding into a shipped change you still go
   through `npm run evo:run` / `evo:accept`.)

   Usage:
     node evo/experiments/graph-queryability.js              # full sweep, prints table
     node evo/experiments/graph-queryability.js --json out.json
     node evo/experiments/graph-queryability.js --cap 10000  # truncate docs harder (faster)
     node evo/experiments/graph-queryability.js --quick      # baseline + a few configs
     node evo/experiments/graph-queryability.js --topk 4     # entities probed per doc
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, normName, sameName } = require('../engine-host');

const CORPUS_DIR = path.join(__dirname, '..', 'corpus');

/* ---------- the corpus battery ----------
   The English narrative + essay docs are the engine's home turf
   (en-narrative-v1): the queryability ranking is computed over these.
   The cross-language docs are a DIAGNOSTIC only — the engine reads them
   thinly because its conventions are English-only, which is exactly the
   gap a future language module would close. They are reported, never
   ranked, so a language the engine can't yet read doesn't punish a
   physics knob that's doing fine on English. */
const BATTERY = [
  { file: 'pg219.txt',   title: 'Heart of Darkness',      lang: 'en', genre: 'narrative' },
  { file: 'pg1237.txt',  title: 'Father Goriot',          lang: 'en', genre: 'narrative' },
  { file: 'pg5200.txt',  title: 'Metamorphosis',          lang: 'en', genre: 'narrative' },
  { file: 'pg600.txt',   title: 'Notes from Underground',  lang: 'en', genre: 'narrative' },
  { file: 'pg34901.txt', title: 'On Liberty',             lang: 'en', genre: 'essay' },
  { file: 'pg3300.txt',  title: 'Wealth of Nations',       lang: 'en', genre: 'essay' },
];
const DIAGNOSTIC = [
  { file: 'pg2000.txt',              title: 'Don Quijote',  lang: 'es', genre: 'narrative' },
  { file: 'pg22367.txt',             title: 'Die Verwandlung', lang: 'de', genre: 'narrative' },
  { file: 'akutagawa_rashomon.txt',  title: 'Rashomon',     lang: 'ja', genre: 'narrative' },
  { file: 'soseki_kokoro.txt',       title: 'Kokoro',       lang: 'ja', genre: 'narrative' },
];

/* ---------- the sweep grid ----------
   One-at-a-time around the shipped defaults (the evo-evolvable physics).
   Each entry is a UI-rule id applyRules() understands and the values to
   try; the shipped value is marked so the table can show deltas. */
const DEFAULTS = {
  'decay-gamma': 0.7, 'inertia-delta': 2.0, 'mass-weight': 0.1,
  'anaphora-weight': 0.4, 'quote-weight': 0.4, 'pronoun-floor': 0.1,
  'two-sighting': 2,
};
const SWEEP = {
  // ADMISSION — what becomes an entity at all. The dominant lever on graph
  // SHAPE (the cross-language diagnostic shows why): two-sighting=1 admits a
  // single-token surface on first sight (more nodes, more noise, more shards);
  // =3 is stricter (fewer nodes, cleaner, but misses lightly-mentioned figures).
  'two-sighting':    [1, 3],
  // PHYSICS — momentum, gravity, pronoun binding. Tunes RESOLUTION, not shape.
  'decay-gamma':     [0.5, 0.85, 0.95],
  'inertia-delta':   [1.3, 1.6, 3.0],
  'mass-weight':     [0.05, 0.3, 0.6],
  'anaphora-weight': [0.2, 0.7, 1.0],
  'quote-weight':    [0.2, 0.7],
  'pronoun-floor':   [0.0, 0.05, 0.25],
};
const QUICK_SWEEP = { 'decay-gamma': [0.95], 'mass-weight': [0.3], 'pronoun-floor': [0.0] };

/* The weights that turn the four facets into one "queryability" number.
   Deliberately weighted toward what a USER feels — does the question get
   a grounded answer (answerability) and does speech land on a speaker
   (resolution) — over raw structural tidiness. */
const Q_WEIGHTS = { answerability: 0.25, resolution: 0.20, consolidation: 0.20, precision: 0.20, coverage: 0.15 };

// ---------- helpers ----------
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const hasFlag = (n) => process.argv.includes(n);
const r3 = (x) => Math.round(x * 1000) / 1000;
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/* Strip Project Gutenberg boilerplate so the graph forms over real prose,
   not the license header. No-op for the Aozora (JP) texts, which carry no
   markers. */
function stripBoilerplate(t) {
  const a = t.indexOf('*** START');
  const start = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(start, b >= 0 ? b : t.length).trim();
}

function loadDoc(entry, cap) {
  const raw = fs.readFileSync(path.join(CORPUS_DIR, entry.file), 'utf8');
  return stripBoilerplate(raw).slice(0, cap);
}

/* ---------- the four facets, measured on one parsed graph ---------- */
function measureGraph(E, doc, topk) {
  const events = doc._events || [];
  const sentN = (doc.sentenceTexts || []).length || 1;
  const snap = (() => { try { return E.graphSnapshot(doc); } catch (e) { return { entities: [], edges: [], assertions: [] }; } })();
  const entities = snap.entities || [];

  // RESOLUTION — speech that lands on a named speaker, not "?".
  const sigs = events.filter(e => e.op === 'SIG');
  const sigResolved = sigs.filter(s => s.speaker && s.speaker !== '?').length;
  const resolution = sigs.length ? sigResolved / sigs.length : 1;

  // CONSOLIDATION — the same person should be ONE referent. Count entities
  // whose normalized name is a token-subset of another same-typed entity's
  // (the "Marlow" ⊂ "Charlie Marlow" shard); each such pair is a graph the
  // querier has to reconcile by hand. consolidation = 1 − shard rate.
  let shards = 0;
  for (let i = 0; i < entities.length; i++) {
    for (let j = 0; j < entities.length; j++) {
      if (i === j) continue;
      const a = entities[i], b = entities[j];
      if (a.type !== b.type) continue;
      const na = normName(a.name), nb = normName(b.name);
      if (!na || !nb || na === nb) continue;
      // a is a proper token-subset of b → a is likely a shard of b
      const sa = new Set(na.split(' ')), sb = new Set(nb.split(' '));
      if (sa.size < sb.size && [...sa].every(w => sb.has(w))) { shards++; break; }
    }
  }
  const consolidation = entities.length ? 1 - Math.min(1, shards / entities.length) : 1;

  // COVERAGE — fraction of sentences reached by entity-bearing structure
  // (an INS birth, a SIG speech, or a DEF assertion). A graph that only
  // touches a quarter of the page leaves three-quarters unqueryable.
  const touched = new Set();
  for (const e of events) {
    if ((e.op === 'INS' || e.op === 'SIG' || e.op === 'DEF') && e.sentence_idx != null) touched.add(e.sentence_idx);
  }
  const coverage = touched.size / sentN;

  // PRECISION — are the nodes real names, or capitalized noise? A genuine
  // proper noun ("Marlow", "London") almost never appears lowercased; a
  // capitalized common noun or abstraction ("Darkness", "Civilization",
  // "Change", "Eastern") admitted from a sentence-initial or emphatic capital
  // usually DOES occur lowercase elsewhere on the page. So: a single-token
  // entity whose lowercased surface also appears as a standalone lowercase word
  // in the text is flagged as a likely noise node. Noise nodes are dead weight
  // a querier has to wade past. precision = 1 − noise rate. Deterministic, no
  // labels: the text grades itself.
  const lowerTokens = new Set(String(doc._text || (doc.sentenceTexts || []).join(' '))
    .split(/[^A-Za-zÀ-ÿ]+/).filter(w => w && w === w.toLowerCase()).map(w => w.toLowerCase()));
  const noiseNodes = entities.filter(e => !/\s/.test(e.name) && lowerTokens.has(String(e.name).toLowerCase().replace(/[^a-zà-ÿ]/g, '')));
  const precision = entities.length ? 1 - noiseNodes.length / entities.length : 1;

  // ANSWERABILITY — ask the graph about its own heaviest figures. For the
  // top-K entities by mass, "who/what is X" should return a GROUNDED, CITED
  // answer. This is the closest deterministic proxy for "can I query it".
  const top = entities.slice().sort((a, b) => (b.mass || 0) - (a.mass || 0)).slice(0, topk);
  let hits = 0;
  for (const ent of top) {
    const stem = ent.type === 'person' ? 'who is ' : 'what is ';
    let ok = false;
    try {
      const a = E.answer(doc, stem + ent.name);
      ok = !!(a && a.audit && a.audit.grounded && (a.cites || []).length >= 1);
    } catch (e) { ok = false; }
    if (ok) hits++;
  }
  const answerability = top.length ? hits / top.length : 0;

  // diagnostics (reported, not scored)
  const stalls = events.filter(e => e.op === 'NUL' && e.reason && String(e.reason).startsWith('pronoun-stall')).length;
  const personRate = top.length ? top.filter(e => e.type === 'person').length / top.length : 0;

  const Q = Q_WEIGHTS.answerability * answerability + Q_WEIGHTS.resolution * resolution
    + Q_WEIGHTS.consolidation * consolidation + Q_WEIGHTS.precision * precision + Q_WEIGHTS.coverage * coverage;

  return {
    Q, answerability, resolution, consolidation, precision, coverage,
    noise: noiseNodes.length, noiseNames: noiseNodes.slice(0, 8).map(e => e.name),
    // raw counts so the aggregate can MICRO-average (sum num / sum den) across
    // the battery — otherwise a speechless doc's resolution=1 default dilutes
    // the very knobs (mass, γ, pronoun-floor) that only bite where speech exists.
    probed: top.length, hits, touched: touched.size,
    entities: entities.length, edges: (snap.edges || []).length, assertions: (snap.assertions || []).length,
    sigTotal: sigs.length, sigResolved, shards, stalls, stallRate: stalls / sentN, personRate, sentences: sentN,
  };
}

/* Apply a config (UI-rule overrides) then re-parse a doc fresh — the
   extraction-phase rules (δ, mass, pronoun-floor) are baked at parse time,
   so a config change only lands on a NEW parse. */
async function parseUnder(E, config, name, text, id) {
  const ui = Object.keys(DEFAULTS).map(k => ({ id: k, enabled: true, value: config[k] != null ? config[k] : DEFAULTS[k] }));
  E.applyRules(ui);
  return E.parseDocument(name, text, id);
}

async function scoreConfig(E, config, docs, topk) {
  const per = [];
  for (const d of docs) {
    const doc = await parseUnder(E, config, d.file, d.text, d.id);
    per.push({ id: d.id, title: d.title, lang: d.lang, genre: d.genre, ...measureGraph(E, doc, topk) });
  }
  return per;
}

// build the list of configs: baseline + OAT sweep (+ a tuned combo filled in later)
function buildConfigs(sweep) {
  const configs = [{ label: 'baseline (shipped)', config: {} }];
  for (const knob of Object.keys(sweep)) {
    for (const v of sweep[knob]) {
      configs.push({ label: `${knob}=${v}`, knob, value: v, config: { [knob]: v } });
    }
  }
  return configs;
}

function fmtTable(rows, cols) {
  const head = cols.map(c => c.h);
  const widths = cols.map((c, i) => Math.max(c.h.length, ...rows.map(r => String(c.f(r)).length)));
  const line = (cells) => cells.map((s, i) => String(s).padEnd(widths[i])).join('  ');
  const out = [line(head), line(widths.map(w => '-'.repeat(w)))];
  for (const r of rows) out.push(line(cols.map(c => c.f(r))));
  return out.join('\n');
}

(async () => {
  const cap = parseInt(arg('--cap', '14000'), 10);
  const topk = parseInt(arg('--topk', '5'), 10);
  const quick = hasFlag('--quick');
  const jsonOut = arg('--json', null);
  const sweep = quick ? QUICK_SWEEP : SWEEP;

  console.log('loading corpus (cap ' + cap + ' chars/doc, top-' + topk + ' entities probed)…');
  const battery = BATTERY.map(e => ({ ...e, id: e.file.replace('.txt', ''), text: loadDoc(e, cap) }));
  const diag = DIAGNOSTIC.map(e => ({ ...e, id: e.file.replace('.txt', ''), text: loadDoc(e, cap) }));

  const E = loadEngine().EOEngine;
  const configs = buildConfigs(sweep);
  console.log('scoring ' + configs.length + ' configs × ' + battery.length + ' English docs …\n');

  // score every config over the English battery
  const t0 = Date.now();
  for (const c of configs) {
    c.per = await scoreConfig(E, c.config, battery, topk);
    c.agg = aggregate(c.per);
  }

  // a tuned combo: take the single best non-baseline value per knob (by Q),
  // stack them, and score it — does combining the OAT winners compound?
  const base = configs[0];
  const tuned = {};
  for (const knob of Object.keys(sweep)) {
    const cands = configs.filter(c => c.knob === knob);
    const best = cands.concat([base]).sort((a, b) => b.agg.Q - a.agg.Q)[0];
    if (best !== base && best.value != null) tuned[knob] = best.value;
  }
  let tunedCfg = null;
  if (Object.keys(tuned).length) {
    tunedCfg = { label: 'tuned combo ' + JSON.stringify(tuned), config: tuned };
    tunedCfg.per = await scoreConfig(E, tuned, battery, topk);
    tunedCfg.agg = aggregate(tunedCfg.per);
    configs.push(tunedCfg);
  }

  // cross-language diagnostic, baseline physics only
  const diagPer = await scoreConfig(E, {}, diag, topk);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ---------- report ----------
  const ranked = configs.slice().sort((a, b) => b.agg.Q - a.agg.Q);
  const baseQ = base.agg.Q;
  console.log('=== QUERYABILITY RANKING (English battery, ' + battery.length + ' docs) ===');
  console.log(fmtTable(ranked, [
    { h: 'config', f: r => r.label },
    { h: 'Q', f: r => r3(r.agg.Q) },
    { h: 'ΔQ', f: r => (r === base ? '—' : (r.agg.Q >= baseQ ? '+' : '') + r3(r.agg.Q - baseQ)) },
    { h: 'answer', f: r => r3(r.agg.answerability) },
    { h: 'resolv', f: r => r3(r.agg.resolution) },
    { h: 'consol', f: r => r3(r.agg.consolidation) },
    { h: 'precis', f: r => r3(r.agg.precision) },
    { h: 'cover', f: r => r3(r.agg.coverage) },
    { h: 'noise', f: r => r3(r.agg.noise) },
  ]));

  console.log('\n=== BASELINE per-doc (shipped physics) ===');
  console.log(fmtTable(base.per, [
    { h: 'doc', f: r => r.title.slice(0, 22) },
    { h: 'genre', f: r => r.genre },
    { h: 'sents', f: r => r.sentences },
    { h: 'ents', f: r => r.entities },
    { h: 'Q', f: r => r3(r.Q) },
    { h: 'answer', f: r => r3(r.answerability) },
    { h: 'resolv', f: r => r.sigResolved + '/' + r.sigTotal },
    { h: 'precis', f: r => r3(r.precision) },
    { h: 'cover', f: r => r3(r.coverage) },
    { h: 'noise (examples)', f: r => r.noise + (r.noiseNames.length ? ' · ' + r.noiseNames.slice(0, 5).join(', ') : '') },
  ]));

  console.log('\n=== CROSS-LANGUAGE DIAGNOSTIC (baseline physics; NOT ranked) ===');
  console.log('The engine reads non-English thinly by design (English-only conventions).');
  console.log('These numbers size the language-module opportunity, they do not grade the physics.');
  console.log(fmtTable(diagPer, [
    { h: 'doc', f: r => r.title.slice(0, 16) },
    { h: 'lang', f: r => r.lang },
    { h: 'sents', f: r => r.sentences },
    { h: 'ents', f: r => r.entities },
    { h: 'Q', f: r => r3(r.Q) },
    { h: 'answer', f: r => r3(r.answerability) },
    { h: 'cover', f: r => r3(r.coverage) },
  ]));

  // ---------- the conclusion, drawn programmatically ----------
  // How much can the TUNABLE knobs move Q (the spread across the sweep), vs how
  // much Q is left on the table by admission noise (the precision headroom,
  // which no runtime knob here reaches)? The bigger number names the lever.
  const sweepQs = configs.map(c => c.agg.Q);
  const bestGain = Math.max(...sweepQs) - baseQ;
  const physicsSpread = Math.max(...sweepQs) - Math.min(...sweepQs);
  const precisionHeadroom = Q_WEIGHTS.precision * (1 - base.agg.precision);
  const denoisedQ = base.agg.Q + precisionHeadroom;
  const ratio = bestGain > 0 ? (precisionHeadroom / bestGain).toFixed(1) + 'x' : '∞';
  console.log('\n=== WHERE THE LEVER IS ===');
  console.log('  tunable knobs (physics + two-sighting): best gain over baseline = +' + r3(bestGain)
    + ' (spread ' + r3(physicsSpread) + ')'
    + '  → ' + (bestGain < 0.005 ? 'SATURATED. The shipped defaults are robustly near-optimal on English.'
      : 'best: ' + ranked[0].label + '.'));
  if (base.agg.noise >= 1) {
    console.log('  admission PRECISION: mean ' + r3(base.agg.precision) + ' (' + Math.round(base.agg.noise) + ' noise nodes / battery)'
      + '  → denoising admission would lift Q to ~' + r3(denoisedQ) + ' (+' + r3(precisionHeadroom) + '), '
      + ratio + ' the best tunable gain.');
    console.log('  Noise lives in capitalized common nouns / title words / sentence-initial markers ("Darkness", "Nature", "But").');
    console.log('  That surface is the language-module disqualify lists (base_stopwords, *_lead_disqualify) — evolvable, but NOT reachable by applyRules().');
    console.log('  → the experiment hands the evo loop a concrete target: tighten admission, not the physics.');
  } else {
    console.log('  admission PRECISION: mean ' + r3(base.agg.precision) + ' — no noise nodes detected; the admission lever has been pulled.');
  }

  console.log('\nscored in ' + elapsed + 's. Q weights: ' + JSON.stringify(Q_WEIGHTS));

  if (jsonOut) {
    const payload = {
      schema: 'cleo-graph-experiment/1', at: new Date().toISOString(),
      cap, topk, qWeights: Q_WEIGHTS, defaults: DEFAULTS, elapsed: +elapsed,
      configs: configs.map(c => ({ label: c.label, config: c.config, agg: c.agg, per: c.per })),
      diagnostic: diagPer,
    };
    fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 1));
    console.log('wrote ' + jsonOut);
  }
})().catch(e => { console.error(e); process.exit(1); });

/* Aggregate per-doc rows into config-level facets. The four scored facets are
   MICRO-averaged (sum numerator / sum denominator) so each is grounded in the
   evidence that exists corpus-wide — speechless docs add 0/0 to resolution
   rather than a free 1.0 — and the aggregate Q is recomputed from them. The
   diagnostics (stall%, entities, …) stay simple per-doc means. */
function aggregate(per) {
  const sum = (f) => per.reduce((a, p) => a + f(p), 0);
  const ratio = (num, den) => (den ? num / den : 1);
  const answerability = ratio(sum(p => p.hits), sum(p => p.probed));
  const resolution = ratio(sum(p => p.sigResolved), sum(p => p.sigTotal));
  const consolidation = 1 - Math.min(1, ratio(sum(p => p.shards), sum(p => p.entities)) || 0);
  const precision = 1 - Math.min(1, ratio(sum(p => p.noise), sum(p => p.entities)) || 0);
  const coverage = ratio(sum(p => p.touched), sum(p => p.sentences));
  const Q = Q_WEIGHTS.answerability * answerability + Q_WEIGHTS.resolution * resolution
    + Q_WEIGHTS.consolidation * consolidation + Q_WEIGHTS.precision * precision + Q_WEIGHTS.coverage * coverage;
  return {
    Q, answerability, resolution, consolidation, precision, coverage,
    noise: sum(p => p.noise),
    stallRate: mean(per.map(p => p.stallRate)), personRate: mean(per.map(p => p.personRate)),
    entities: mean(per.map(p => p.entities)), edges: mean(per.map(p => p.edges)), assertions: mean(per.map(p => p.assertions)),
    sigResolved: sum(p => p.sigResolved), sigTotal: sum(p => p.sigTotal),
  };
}
