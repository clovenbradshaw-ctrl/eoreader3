/* ============================================================
   evo/scorer.js — the QUALITY battery (Fitness 2, the hill).

   Three components, weighted into a composite the loop tries to RAISE:

     2a  Pronoun-binding accuracy  (deterministic, no API)
         Labeled speech-attribution sites: which referent does the engine
         bind each quoted line to? Scored against hand-annotated speakers.
         Fraction correct. (Speech attribution via "he/she said" IS a
         pronoun→referent binding — the Mary-vs-Dron case.)

     2b  Stall honesty            (deterministic, no API)
         Labeled sites marked should-stall (ambiguous) or should-bind
         (clear). Did NUL fire where it should and stay quiet where it
         shouldn't? F1 over stall placement. Punishes an agent for
         suppressing stalls to look confident; rewards honest not-knowing.

     2c  Integration quality      (one API call per fixture, or a stub)
         The candidate engine's grounded reading of a doc, judged on a
         fixed rubric (traces to source, epistemic framing, captures what
         the doc turns on, invents no connections). The gameable one —
         which is why it is the lightest third and why a human selects.

   2a/2b are deterministic and reproduce bit-exact: in Node no embedder /
   LLM reader fires, so a parse is a pure function of (text, rules). 2c is
   stubbed to a fixed value unless a live integration scorer is injected.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, traceDocument, sameName, normName } = require('./engine-host');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
// "Good reading" as four facets — three deterministic, one holistic — with the
// deterministic ones (binds the right referents, stalls honestly, stays
// grounded and fabricates nothing) outweighing the gameable API rubric.
const DEFAULT_WEIGHTS = { binding: 0.30, stall: 0.30, grounding: 0.20, integration: 0.20 };
const INTEGRATION_STUB = 0.70;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}

/* Load every *.json fixture in a sub-battery; resolve docFile → text. */
function loadFixtures(kind) {
  const dir = path.join(FIXTURES_DIR, kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!fx.doc && fx.docFile) fx.doc = fs.readFileSync(path.join(dir, fx.docFile), 'utf8');
    fx._file = f;
    return fx;
  });
}

const wsNorm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* Resolve a label's sentence locator to a sentence index. A locator is a
   substring of the target sentence (whitespace-insensitive). Returns -1 if
   not found. Prefers the SHORTEST matching sentence to disambiguate. */
function locate(sentenceTexts, locator) {
  const needle = wsNorm(locator);
  let best = -1, bestLen = Infinity;
  for (let i = 0; i < sentenceTexts.length; i++) {
    const hay = wsNorm(sentenceTexts[i]);
    if (hay.includes(needle) && hay.length < bestLen) { best = i; bestLen = hay.length; }
  }
  return best;
}

/* ---- 2a — binding accuracy ---- */
async function scoreBinding(EOEngine, fixtures) {
  let correct = 0, total = 0;
  const detail = [];
  for (const fx of fixtures) {
    const tr = await traceDocument(EOEngine, { name: fx.id + '.txt', text: fx.doc, id: fx.id });
    for (const b of (fx.bindings || [])) {
      total++;
      const idx = locate(tr.sentenceTexts, b.sentence);
      // The binding is observable as the SIG (speech) speaker at that sentence,
      // optionally narrowed by a quote snippet.
      const sigs = tr.sigs.filter(s => s.sentence_idx === idx);
      let sig = sigs[0];
      if (b.quote && sigs.length > 1) sig = sigs.find(s => wsNorm(s.quote).includes(wsNorm(b.quote))) || sig;
      const bound = sig && sig.speaker && sig.speaker !== '?' ? sig.speaker : null;
      const ok = bound != null && sameName(bound, b.referent);
      if (ok) correct++;
      detail.push({ fixture: fx.id, sentence_idx: idx, expected: b.referent, bound, attributed: sig ? sig.attributed : null, ok });
    }
  }
  return { score: total ? correct / total : 1, correct, total, detail };
}

/* ---- 2b — stall honesty (F1 over stall placement) ---- */
async function scoreStall(EOEngine, fixtures) {
  let TP = 0, FP = 0, FN = 0, TN = 0;
  const detail = [];
  for (const fx of fixtures) {
    const tr = await traceDocument(EOEngine, { name: fx.id + '.txt', text: fx.doc, id: fx.id });
    for (const site of (fx.sites || [])) {
      const idx = locate(tr.sentenceTexts, site.sentence);
      const nullsHere = tr.nulls.filter(n => n.sentence_idx === idx &&
        (!site.surface || (n.surface && wsNorm(n.surface) === wsNorm(site.surface))));
      const stalled = nullsHere.length > 0;
      const shouldStall = site.expect === 'stall';
      if (shouldStall && stalled) TP++;
      else if (!shouldStall && stalled) FP++;
      else if (shouldStall && !stalled) FN++;
      else TN++;
      detail.push({ fixture: fx.id, sentence_idx: idx, expect: site.expect, stalled, ok: shouldStall === stalled });
    }
  }
  const precision = (TP + FP) ? TP / (TP + FP) : 1;
  const recall = (TP + FN) ? TP / (TP + FN) : 1;
  const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 1;
  // When there are no positive (stall) cases at all, fall back to accuracy so a
  // battery of only clear sites still scores honestly.
  const score = (TP + FN) === 0 ? (TN + FP ? TN / (TN + FP) : 1) : f1;
  return { score, f1, precision, recall, TP, FP, FN, TN, detail };
}

/* ---- 2d — grounding fidelity (deterministic, no API) ----
   The faithfulness facet of good reading: when asked, the engine's answer
   stays GROUNDED (cited, or honestly held rather than invented) and the veto
   finds NOTHING fabricated. A guard the agent can raise only by reading more
   faithfully — never by editing the (constitutional) grounder/veto itself. */
async function scoreGrounding(EOEngine, fixtures) {
  let sum = 0, n = 0;
  const detail = [];
  for (const fx of fixtures) {
    const doc = await EOEngine.parseDocument(fx.id + '.txt', fx.doc, fx.id);
    const q = fx.question || 'what is this about';
    let grounded = false, clean = true, cites = 0;
    try { const a = EOEngine.answer(doc, q); grounded = !!(a.audit && a.audit.grounded); cites = (a.cites || []).length; } catch (e) {}
    try { clean = (EOEngine.inventedTerms(doc, q) || []).length === 0; } catch (e) {}
    const s = (grounded ? 0.5 : 0) + (clean ? 0.5 : 0);
    sum += s; n++;
    detail.push({ fixture: fx.id, grounded, clean, cites, score: s });
  }
  return { score: n ? sum / n : 1, detail };
}

/* ---- 2c — integration quality ---- */
// `integrationScorer(fx, groundedAnswer)` → number in [0,1], or null to use
// the stub. Injected by the runner/agent in E3 (live Anthropic rubric).
async function scoreIntegration(EOEngine, fixtures, opts = {}) {
  const judge = typeof opts.integrationScorer === 'function' ? opts.integrationScorer : null;
  const stub = opts.integrationStub != null ? opts.integrationStub : INTEGRATION_STUB;
  const talkerLlm = typeof opts.talkerLlm === 'function' ? opts.talkerLlm : null;
  // Frugality: only the first `sampleSize` fixtures get a live rubric call;
  // the rest use the stub. Bounds Anthropic tokens in the experimental phase.
  const sampleSize = opts.integrationSampleSize != null ? opts.integrationSampleSize : Infinity;
  let sum = 0, n = 0, judged = 0;
  const detail = [];
  for (const fx of fixtures) {
    const tr = await traceDocument(EOEngine, { name: fx.id + '.txt', text: fx.doc, id: fx.id });
    // The candidate engine's grounded reading: the talker portrait (the
    // integration output) when there are heavy figures, else a grounded answer.
    let grounded = null;
    try {
      const p = await EOEngine.talkerPortrait(tr._doc, talkerLlm ? { llm: talkerLlm } : {});
      if (p) grounded = [p.existence, p.structure, p.significance].filter(Boolean).join('\n\n');
    } catch (e) { /* fall through */ }
    if (!grounded && fx.question) {
      try { grounded = (EOEngine.answer(tr._doc, fx.question) || {}).text || null; } catch (e) {}
    }
    let s, live = false;
    if (judge && grounded && judged < sampleSize) {
      try { s = await judge(fx, grounded); live = s != null; } catch (e) { s = null; }
      if (live) judged++;
    }
    if (s == null) s = stub;
    sum += s; n++;
    detail.push({ fixture: fx.id, score: s, live, chars: grounded ? grounded.length : 0 });
  }
  return { score: n ? sum / n : stub, detail };
}

/* The full battery. Returns per-component scores + the weighted composite. */
async function scoreAll(EOEngine, opts = {}) {
  const cfg = readConfig();
  const weights = opts.weights || cfg.weights || DEFAULT_WEIGHTS;
  const integrationFx = loadFixtures('integration');
  const binding = await scoreBinding(EOEngine, loadFixtures('binding'));
  const stall = await scoreStall(EOEngine, loadFixtures('stalls'));
  const grounding = await scoreGrounding(EOEngine, integrationFx);
  const integration = await scoreIntegration(EOEngine, integrationFx, {
    integrationStub: opts.integrationStub != null ? opts.integrationStub : cfg.integrationStub,
    integrationScorer: opts.integrationScorer,
    talkerLlm: opts.talkerLlm,
    integrationSampleSize: opts.integrationSampleSize != null ? opts.integrationSampleSize : cfg.integrationSampleSize,
  });
  const composite = weights.binding * binding.score + weights.stall * stall.score
    + (weights.grounding || 0) * grounding.score + weights.integration * integration.score;
  return {
    weights,
    components: { binding: binding.score, stall: stall.score, grounding: grounding.score, integration: integration.score },
    composite,
    binding, stall, grounding, integration,
  };
}

const r3 = (x) => Math.round(x * 1000) / 1000;

function formatReport(res) {
  const c = res.components, w = res.weights;
  const lines = [];
  lines.push('quality composite = ' + r3(res.composite));
  lines.push('  2a binding accuracy  ' + r3(c.binding) + '   (w ' + w.binding + ')  — ' + res.binding.correct + '/' + res.binding.total + ' bindings');
  lines.push('  2b stall honesty F1  ' + r3(c.stall) + '   (w ' + w.stall + ')  — P ' + r3(res.stall.precision) + ' R ' + r3(res.stall.recall) + ' (TP' + res.stall.TP + ' FP' + res.stall.FP + ' FN' + res.stall.FN + ' TN' + res.stall.TN + ')');
  lines.push('  2d grounding fidelity ' + r3(c.grounding) + '  (w ' + (w.grounding || 0) + ')  — ' + res.grounding.detail.filter(d => d.grounded && d.clean).length + '/' + res.grounding.detail.length + ' grounded & fabrication-free');
  lines.push('  2c integration       ' + r3(c.integration) + '   (w ' + w.integration + ')  — ' + (res.integration.detail.some(d => d.live) ? 'live rubric' : 'stub ' + r3(res.integration.score)));
  return lines.join('\n');
}

module.exports = {
  loadFixtures, scoreBinding, scoreStall, scoreGrounding, scoreIntegration, scoreAll,
  formatReport, locate, DEFAULT_WEIGHTS, INTEGRATION_STUB,
};

/* ---- CLI: print the baseline quality of the repo engine ---- */
if (require.main === module) {
  (async () => {
    const argEngine = process.argv.find(a => a.startsWith('--engine='));
    const enginePath = argEngine ? argEngine.split('=')[1] : undefined;
    const W = loadEngine(enginePath ? { enginePath } : {});
    const res = await scoreAll(W.EOEngine);
    console.log('engine: ' + (enginePath || 'engine.js (baseline)'));
    console.log(formatReport(res));
    if (process.argv.includes('--json')) console.log('\n' + JSON.stringify(res, (k, v) => k === '_doc' ? undefined : v, 1));
  })().catch(e => { console.error(e); process.exit(1); });
}
