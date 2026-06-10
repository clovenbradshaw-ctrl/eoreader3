/* ============================================================
   evo/runner.js — the generation loop, the sandbox, the scoring, the
   parity-state classifier, the REC logger, and the human-selection
   commands (run / review / accept / reject).

   The loop PROPOSES and TESTS. The human MERGES. There is no autonomous
   merge path: evo:accept is the only way a change reaches engine.js, and
   a human types it. The runner's job is to surface candidates worth a
   human's judgment — with the evidence to judge them.

   Sandbox: each candidate is evaluated in evo/work/<run-id>/sandbox/, a
   copy-in mini-repo (candidate engine.js + the real tests + golden.json,
   node_modules symlinked). The real working tree is never written during
   a run; engine.js / tests / golden.json are also chmod'd read-only for
   the duration as belt-and-suspenders.

   Fitness:
     Parity (the floor)  — node tests/parity.js on the candidate vs golden.
     Quality (the hill)  — evo/scorer.js composite on the candidate.
   The tension between them is the whole point: parity may not silently
   break; quality is what the agent climbs; a break is allowed only when
   quality justifies a human-authorized golden recapture.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..');
const WORK = path.join(__dirname, 'work');
const OBS = path.join(__dirname, 'observations');
const PROPOSALS = path.join(__dirname, 'proposals');

const scorer = require('./scorer');
const { loadEngine } = require('./engine-host');
const { renderEdits } = require('./patch');
const agent = require('./agent');

function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}

/* ---- small utils ---- */
const r4 = (x) => Math.round(x * 10000) / 10000;
const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
function chmodSafe(p, mode) { try { fs.chmodSync(p, mode); } catch (e) {} }

function lockReadOnly(paths) {
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) { chmodSafe(p, 0o555); for (const f of fs.readdirSync(p)) lockReadOnly([path.join(p, f)]); }
    else chmodSafe(p, 0o444);
  }
}
function unlock(paths) {
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) { chmodSafe(p, 0o755); for (const f of fs.readdirSync(p)) unlock([path.join(p, f)]); }
    else chmodSafe(p, 0o644);
  }
}

/* ---- sandbox: copy-in mini-repo for a candidate engine ---- */
const SANDBOX_FILES = ['pivot.jsx', 'audit.js', 'llm.js', 'embed.js', 'store.js', 'package.json', 'package-lock.json'];
function makeSandbox(runId) {
  const dir = path.join(WORK, runId, 'sandbox');
  ensureDir(dir);
  for (const f of SANDBOX_FILES) {
    const src = path.join(REPO, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  // tests/ copied verbatim (incl. golden.json) — the candidate's exam.
  ensureDir(path.join(dir, 'tests'));
  for (const f of fs.readdirSync(path.join(REPO, 'tests'))) {
    fs.copyFileSync(path.join(REPO, 'tests', f), path.join(dir, 'tests', f));
  }
  // node_modules symlinked (read-only deps, never written).
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) { try { fs.symlinkSync(path.join(REPO, 'node_modules'), nm, 'dir'); } catch (e) {} }
  return dir;
}

function writeCandidate(sandboxDir, engineSource) {
  fs.writeFileSync(path.join(sandboxDir, 'engine.js'), engineSource);
}

/* ---- candidate parity: run tests/parity.js in the sandbox vs golden ---- */
function candidateParity(sandboxDir) {
  let out, code = 0;
  try { out = cp.execFileSync('node', ['tests/parity.js'], { cwd: sandboxDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
  const m = out.match(/(\d+)\s+snapshots?,\s+(\d+)\s+differ/);
  const total = m ? +m[1] : null, diffs = m ? +m[2] : (code === 0 ? 0 : null);
  return { diffs, total, clean: diffs === 0, raw: out.trim().split('\n').slice(-3).join('\n') };
}

/* ---- candidate behavioral gate: the non-parity test files must pass ---- */
function candidateTests(sandboxDir) {
  const files = ['tests/engine.test.js', 'tests/learning.test.js', 'tests/audit.test.js', 'tests/llm.test.js'];
  for (const f of files) {
    try { cp.execFileSync('node', [f], { cwd: sandboxDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); }
    catch (e) { return { ok: false, failed: f, raw: ((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(-6).join('\n') }; }
  }
  return { ok: true };
}

/* ---- classify a candidate (the mechanical decision, step 6) ---- */
function classify(parityDiffs, qualityDelta, c) {
  const win = c.qualityWinThreshold != null ? c.qualityWinThreshold : 0.01;
  const just = c.justifiedBreakThreshold != null ? c.justifiedBreakThreshold : 0.03;
  if (parityDiffs === 0) {
    return qualityDelta >= win
      ? { state: 'clean-win', surface: true, note: 'pure tuning that did not move the snapshotted paths; mergeable on quality alone' }
      : { state: 'null', surface: false, note: 'clean parity but no quality gain' };
  }
  return qualityDelta >= just
    ? { state: 'justified-break', surface: true, note: 'a real behavior change the quality gain justifies; REQUIRES human golden recapture' }
    : { state: 'regression', surface: false, note: 'broke behavior without paying for it; auto-rejected' };
}

/* ---- evaluate ONE candidate (edits applied to the baseline engine) ----
   This is the E2 core: hand-feed it `edits` to test sandbox + scoring +
   classification without any agent. Returns the full generation record. */
async function evaluateCandidate(runId, edits, baseline, c) {
  const rec = { edits, ok: false };
  const rendered = renderEdits(baseline.source, edits);
  rec.rendered = { ok: rendered.ok, touchedRegions: rendered.touchedRegions, rejected: rendered.rejected, accepted: rendered.accepted.map(a => a.edit) };
  if (!rendered.ok) {
    rec.state = 'rejected-by-allowlist';
    rec.note = rendered.rejected.map(r => r.reason).join('; ');
    return rec; // no rerun, no API cost — out of bounds
  }
  rec.diff = rendered.diff;

  const sandboxDir = makeSandbox(runId);
  writeCandidate(sandboxDir, rendered.newSource);

  // behavioral gate first (cheap to reason about; a broken engine is no candidate)
  const tests = candidateTests(sandboxDir);
  if (!tests.ok) { rec.state = 'broken'; rec.surface = false; rec.note = 'behavioral test failed: ' + tests.failed; rec.tests = tests; return rec; }

  const parity = candidateParity(sandboxDir);
  rec.parity = parity;

  const W = loadEngine({ enginePath: path.join(sandboxDir, 'engine.js') });
  const q = await scorer.scoreAll(W.EOEngine, baseline.scoreOpts || {});
  rec.quality = { composite: q.composite, components: q.components, stall: { TP: q.stall.TP, FP: q.stall.FP, FN: q.stall.FN, TN: q.stall.TN } };
  rec.qualityDelta = q.composite - baseline.quality.composite;
  rec.componentDeltas = {
    binding: q.components.binding - baseline.quality.components.binding,
    stall: q.components.stall - baseline.quality.components.stall,
    integration: q.components.integration - baseline.quality.components.integration,
  };

  const cls = classify(parity.diffs, rec.qualityDelta, c);
  rec.state = cls.state; rec.surface = cls.surface; rec.note = cls.note;
  rec.ok = true;
  return rec;
}

/* ---- REC logging: the engine's own evolution, in its own operators ---- */
function recBlock(edit, gen) {
  // Mirror the engine's REC event shape (op REC, target rule:X, old→new, basis).
  const target = edit.kind === 'prompt-edit' ? 'prompt:talkerPortrait.' + edit.slot : 'rule:' + edit.rule;
  const action = edit.kind === 'rule-value' ? 'set-value'
    : edit.kind === 'rule-tokens-add' ? 'add-tokens'
    : edit.kind === 'rule-tokens-remove' ? 'remove-tokens'
    : 'edit-prompt';
  const val = edit.kind === 'rule-value' ? edit.value
    : edit.tokens ? edit.tokens.join(', ')
    : (edit.find + ' → ' + edit.replace);
  return [
    '    { op: REC, stance: Recursing,',
    '      target: ' + target + ', action: ' + action + ',',
    '      new_value: ' + JSON.stringify(val) + ',',
    '      basis: ' + JSON.stringify(gen.hypothesis ? gen.hypothesis.predicted : 'tuning') + ',',
    '      reason: ' + JSON.stringify(gen.hypothesis ? gen.hypothesis.rationale : 'agent-proposed') + ' }',
  ].join('\n');
}

function appendObservation(runId, text) {
  ensureDir(OBS);
  fs.appendFileSync(path.join(OBS, runId + '.md'), text + '\n');
}

/* ---- the full generation loop (step 1-8) ---- */
async function cmdRun(opts = {}) {
  const c = cfg();
  const runId = opts.runId || ('run-' + nowStamp());
  ensureDir(path.join(WORK, runId));
  const realLocks = [path.join(REPO, 'engine.js'), path.join(REPO, 'tests'), path.join(REPO, 'tests', 'golden.json')];

  // budgeted, pluggable agent (live Anthropic when keyed, else deterministic offline)
  const ag = agent.create({
    provider: opts.provider || c.provider || 'auto',
    budget: c.apiCallBudget != null ? c.apiCallBudget : 8,
    model: (c.models || {}).agent,
    maxRubricDocChars: c.maxRubricDocChars,
  });

  // baseline: the repo engine + its quality. The source the agent patches.
  const baseSource = fs.readFileSync(path.join(REPO, 'engine.js'), 'utf8');
  const scoreOpts = buildScoreOpts(c, ag);
  const W0 = loadEngine();
  const baseQuality = await scorer.scoreAll(W0.EOEngine, scoreOpts);
  const baseline = { source: baseSource, quality: baseQuality, scoreOpts };

  appendObservation(runId, observationHeader(runId, ag, baseQuality));

  // OBSERVE — trace battery for the agent.
  const traces = await agent.observe(W0.EOEngine, scorer.loadFixtures);

  const generations = [];
  const N = opts.generations || c.generations || 8;
  let best = null;

  console.log('▶ evo run ' + runId + '  (provider: ' + ag.provider + ', up to ' + N + ' generations)');
  console.log('  baseline composite ' + r4(baseQuality.composite) + '  (bind ' + r4(baseQuality.components.binding) + ', stall ' + r4(baseQuality.components.stall) + ', integ ' + r4(baseQuality.components.integration) + ')\n');

  lockReadOnly(realLocks);
  try {
    for (let g = 0; g < N; g++) {
      if (ag.exhausted()) { console.log('  · API budget exhausted — stopping at generation ' + g); break; }
      // HYPOTHESIZE — one proposal (offline: scripted & deterministic; live: one API call)
      const hyp = await ag.hypothesize({ traces, baseline: baseQuality, history: generations });
      if (!hyp) { console.log('  · agent has no further hypotheses — stopping'); break; }

      // PATCH + RERUN + SCORE + DECIDE
      const gen = await evaluateCandidate(runId, hyp.edits, baseline, c);
      gen.hypothesis = hyp;
      gen.gen = g;
      generations.push(gen);

      logGeneration(runId, gen);
      printGeneration(gen);

      if (gen.surface && (!best || gen.qualityDelta > best.qualityDelta)) best = gen;
      ag.recordResult(gen); // failure & success both inform the next hypothesis
    }
  } finally {
    unlock(realLocks);
  }

  // SURFACE — at most one proposal for a human.
  const summary = writeProposal(runId, best, baseline, generations, ag);
  fs.writeFileSync(path.join(WORK, runId, 'run.json'), JSON.stringify({ runId, best: best ? best.gen : null, generations: generations.map(stripGen), baselineComposite: baseQuality.composite, provider: ag.provider, apiCalls: ag.calls() }, null, 2));

  console.log('\n' + summary.banner);
  return { runId, best, generations };
}

function buildScoreOpts(c, ag) {
  // Wire the live integration rubric only when the agent has a live provider;
  // otherwise the 2c component is the deterministic stub. Token guards:
  // integrationSampleSize bounds live 2c calls per scoring; the talker LLM is
  // off unless scoreTalkerLive is set (it would double call volume).
  if (ag.provider !== 'live') return { integrationStub: c.integrationStub };
  const opts = {
    integrationStub: c.integrationStub,
    integrationScorer: (fx, grounded) => ag.rubricScore(fx, grounded),
    integrationSampleSize: c.integrationSampleSize,
  };
  if (c.scoreTalkerLive) opts.talkerLlm = (sys, user) => ag.talker(sys, user);
  return opts;
}

function stripGen(g) {
  return { gen: g.gen, state: g.state, surface: g.surface, qualityDelta: g.qualityDelta, componentDeltas: g.componentDeltas, parity: g.parity ? { diffs: g.parity.diffs } : null, hypothesis: g.hypothesis ? { target: g.hypothesis.target, edits: g.hypothesis.edits } : null, note: g.note };
}

/* ---- per-generation logging (observations + console) ---- */
function logGeneration(runId, gen) {
  const h = gen.hypothesis || {};
  const lines = [];
  lines.push('\n## Generation ' + gen.gen + ' — ' + gen.state);
  lines.push('');
  lines.push('**Hypothesis.** ' + (h.statement || '(none)'));
  if (h.rationale) lines.push('');
  if (h.rationale) lines.push('> ' + h.rationale);
  lines.push('');
  if (gen.state === 'rejected-by-allowlist') {
    lines.push('**Rejected by the constitution before any rerun** (no API cost): ' + gen.note);
    appendObservation(runId, lines.join('\n'));
    return;
  }
  if (gen.state === 'broken') {
    lines.push('**Broke a behavioral test** (' + gen.note + ') — reverted.');
    appendObservation(runId, lines.join('\n'));
    return;
  }
  lines.push('**Parity:** ' + (gen.parity.clean ? 'CLEAN (0 diffs)' : 'BREAK (' + gen.parity.diffs + '/' + gen.parity.total + ' snapshot diffs)'));
  lines.push('**Quality:** composite ' + r4(gen.quality.composite) + '  (Δ ' + (gen.qualityDelta >= 0 ? '+' : '') + r4(gen.qualityDelta) + ')');
  lines.push('  - 2a binding ' + r4(gen.quality.components.binding) + ' (Δ ' + sign(gen.componentDeltas.binding) + ')');
  lines.push('  - 2b stall   ' + r4(gen.quality.components.stall) + ' (Δ ' + sign(gen.componentDeltas.stall) + ')  TP' + gen.quality.stall.TP + ' FP' + gen.quality.stall.FP + ' FN' + gen.quality.stall.FN + ' TN' + gen.quality.stall.TN);
  lines.push('  - 2c integ   ' + r4(gen.quality.components.integration) + ' (Δ ' + sign(gen.componentDeltas.integration) + ')');
  lines.push('**Decision:** ' + gen.state + ' — ' + gen.note);
  // REC events — the engine's own evolution in the nine-operator vocabulary
  lines.push('');
  lines.push('REC log (the change, in the engine\'s own operators):');
  lines.push('```');
  for (const e of gen.hypothesis.edits) lines.push(recBlock(e, gen));
  lines.push('```');
  appendObservation(runId, lines.join('\n'));
}
const sign = (x) => (x >= 0 ? '+' : '') + r4(x);

function printGeneration(gen) {
  const tag = { 'clean-win': '✓ CLEAN WIN', 'justified-break': '⚑ JUSTIFIED BREAK', 'regression': '✗ regression', 'null': '· null', 'broken': '✗ broken', 'rejected-by-allowlist': '⊘ rejected (constitution)' }[gen.state] || gen.state;
  const h = gen.hypothesis || {};
  let line = '  gen ' + gen.gen + ': ' + tag + '  ' + (h.target || '');
  if (gen.qualityDelta != null) line += '  Δquality ' + sign(gen.qualityDelta);
  if (gen.parity) line += '  parity ' + (gen.parity.clean ? 'clean' : gen.parity.diffs + ' diffs');
  console.log(line);
  if (gen.state === 'rejected-by-allowlist') console.log('         ' + gen.note);
}

function observationHeader(runId, ag, baseQuality) {
  return [
    '# Evolution run ' + runId,
    '',
    'Provider: ' + ag.provider + '. Baseline composite ' + r4(baseQuality.composite) +
      ' (binding ' + r4(baseQuality.components.binding) + ', stall ' + r4(baseQuality.components.stall) + ', integration ' + r4(baseQuality.components.integration) + ').',
    '',
    'The agent amends the laws; it never amends the constitution. Every change below was validated against evo/allowlist.js before it ran. The human selects; the loop only proposes.',
  ].join('\n');
}

/* ---- the proposal: the actionable output for a human coder (step 8) ---- */
function writeProposal(runId, best, baseline, generations, ag) {
  ensureDir(PROPOSALS);
  const diffPath = path.join(PROPOSALS, runId + '.diff');
  const mdPath = path.join(PROPOSALS, runId + '.md');

  if (!best) {
    const md = noWinReport(runId, baseline, generations);
    fs.writeFileSync(mdPath, md);
    fs.writeFileSync(diffPath, '');
    return { banner: 'No candidate worth surfacing this run. See ' + path.relative(REPO, mdPath) + ' for what was tried and why each was rejected.' };
  }

  best.runId = runId; // so the recommendation can print the accept command
  fs.writeFileSync(diffPath, best.diff);
  const md = winReport(runId, best, baseline, generations);
  fs.writeFileSync(mdPath, md);
  return {
    banner: [
      (best.state === 'justified-break' ? '⚑ JUSTIFIED BREAK' : '✓ CLEAN WIN') + ' — proposal written.',
      '  Review:  npm run evo:review ' + runId,
      '  Accept:  npm run evo:accept ' + runId + (best.state === 'justified-break' ? '   (will recapture goldens)' : ''),
      '  Reject:  npm run evo:reject ' + runId,
      '  Report:  ' + path.relative(REPO, mdPath),
    ].join('\n'),
  };
}

function winReport(runId, best, baseline, generations) {
  const h = best.hypothesis;
  const cd = best.componentDeltas;
  const L = [];
  L.push('# Proposal ' + runId);
  L.push('');
  L.push('**' + (best.state === 'justified-break' ? 'Justified parity break' : 'Clean-parity win') + '.** ' +
    'Composite quality ' + r4(baseline.quality.composite) + ' → ' + r4(best.quality.composite) +
    ' (Δ ' + sign(best.qualityDelta) + '). Parity ' + (best.parity.clean ? 'unchanged (0 diffs).' : best.parity.diffs + ' golden snapshots changed.'));
  L.push('');
  L.push('## How to improve the app');
  L.push('');
  L.push(recommendation(best));
  L.push('');
  L.push('## The change');
  L.push('');
  L.push('```diff');
  L.push(best.diff.trim());
  L.push('```');
  L.push('');
  L.push('## The argument');
  L.push('');
  L.push(h.argument || h.rationale || '(none)');
  L.push('');
  L.push('## The evidence');
  L.push('');
  L.push('| component | weight | baseline | candidate | Δ |');
  L.push('|---|---|---|---|---|');
  L.push(row('2a pronoun-binding accuracy', baseline.quality.weights.binding, baseline.quality.components.binding, best.quality.components.binding, cd.binding));
  L.push(row('2b stall honesty (F1)', baseline.quality.weights.stall, baseline.quality.components.stall, best.quality.components.stall, cd.stall));
  L.push(row('2c integration quality', baseline.quality.weights.integration, baseline.quality.components.integration, best.quality.components.integration, cd.integration));
  L.push('');
  L.push('Stall confusion on the candidate: TP ' + best.quality.stall.TP + ', FP ' + best.quality.stall.FP + ', FN ' + best.quality.stall.FN + ', TN ' + best.quality.stall.TN + '.');
  L.push('');
  if (best.state === 'justified-break') {
    L.push('> This change moves snapshotted behavior. `evo:accept` will recapture `tests/golden.json` and re-run the suite as a final gate. Hand-diff the recaptured goldens before committing.');
  } else {
    L.push('> Parity is clean: the golden snapshots are byte-identical, so this is mergeable on the quality gain alone. `evo:accept` applies the diff and re-runs the suite as a final gate.');
  }
  L.push('');
  L.push('## What else was tried');
  L.push('');
  for (const g of generations) L.push('- gen ' + g.gen + ': ' + g.state + ' — ' + (g.hypothesis ? g.hypothesis.target : '') + ' (Δquality ' + (g.qualityDelta != null ? sign(g.qualityDelta) : 'n/a') + (g.parity ? ', parity ' + (g.parity.clean ? 'clean' : g.parity.diffs + ' diffs') : '') + ')');
  L.push('');
  L.push('Full REC log and per-generation trace: `evo/observations/' + runId + '.md`.');
  return L.join('\n') + '\n';
}

function recommendation(best) {
  const h = best.hypothesis;
  const winning = (cd) => {
    const names = [];
    if (cd.binding > 0.0005) names.push('pronoun-binding accuracy');
    if (cd.stall > 0.0005) names.push('stall honesty');
    if (cd.integration > 0.0005) names.push('integration quality');
    return names;
  };
  const moved = winning(best.componentDeltas);
  const what = (best.hypothesis.edits || []).map(e =>
    e.kind === 'rule-value' ? '`READING_RULES.' + e.rule + '` → `' + e.value + '`'
      : e.kind && e.kind.startsWith('rule-tokens') ? '`READING_RULES.' + e.rule + '` (' + (e.kind === 'rule-tokens-add' ? 'add ' : 'remove ') + (e.tokens || []).join(', ') + ')'
      : 'the talker `' + e.slot + '` prompt').join(' and ');
  const lines = [];
  lines.push('Change ' + what + ' in `engine.js`. ' +
    'On the labeled battery this ' + (moved.length ? 'improved ' + moved.join(' and ') : 'moved quality') +
    ' (composite Δ ' + sign(best.qualityDelta) + ')' +
    (best.parity.clean ? ' with **no change to any golden snapshot** — it is a pure tuning the existing tests already bless.' : ', at the cost of ' + best.parity.diffs + ' golden snapshots that must be deliberately recaptured.'));
  lines.push('');
  lines.push('Run `npm run evo:accept ' + best.runId + '` to apply it (it re-runs `npm test` as a final gate' + (best.parity.clean ? '' : ' after recapturing goldens') + '), or apply the diff above by hand. The agent could not touch `evaDraft`, the grounder, parity, or the fixtures — so this is a change to the reading *laws*, not to the checks that keep it honest.');
  return lines.join('\n');
}

function row(name, w, b, c, d) {
  return '| ' + name + ' | ' + w + ' | ' + r4(b) + ' | ' + r4(c) + ' | ' + sign(d) + ' |';
}

function noWinReport(runId, baseline, generations) {
  const L = ['# Proposal ' + runId + ' — no surfaced candidate', ''];
  L.push('Baseline composite ' + r4(baseline.quality.composite) + '. Nothing this run cleared the bar (a clean-parity quality gain, or a parity break the quality justified).');
  L.push('');
  L.push('## What was tried');
  for (const g of generations) L.push('- gen ' + g.gen + ': ' + g.state + ' — ' + (g.hypothesis ? g.hypothesis.target : '') + ' — ' + (g.note || ''));
  L.push('');
  L.push('The failures are signal, not waste: each is logged with its parity and quality deltas in `evo/observations/' + runId + '.md`, and feeds the next run\'s hypotheses.');
  return L.join('\n') + '\n';
}

/* ---- review / accept / reject ---- */
function loadRun(runId) {
  const p = path.join(WORK, runId, 'run.json');
  if (!fs.existsSync(p)) throw new Error('no such run: ' + runId + ' (looked in ' + path.relative(REPO, p) + ')');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function cmdReview(runId) {
  const mdPath = path.join(PROPOSALS, runId + '.md');
  if (!fs.existsSync(mdPath)) throw new Error('no proposal for ' + runId);
  console.log(fs.readFileSync(mdPath, 'utf8'));
}

function cmdReject(runId) {
  const run = loadRun(runId);
  // Keep the observations (the learning), archive the run dir, discard the patch.
  const archive = path.join(WORK, '_rejected');
  ensureDir(archive);
  const diffPath = path.join(PROPOSALS, runId + '.diff');
  if (fs.existsSync(diffPath)) fs.renameSync(diffPath, path.join(archive, runId + '.diff'));
  rmrf(path.join(WORK, runId, 'sandbox'));
  console.log('✓ rejected ' + runId + ' — patch discarded, observations kept (evo/observations/' + runId + '.md), sandbox cleaned.');
  void run;
}

function cmdAccept(runId) {
  const run = loadRun(runId);
  const diffPath = path.join(PROPOSALS, runId + '.diff');
  if (!fs.existsSync(diffPath) || !fs.readFileSync(diffPath, 'utf8').trim()) throw new Error('no diff to accept for ' + runId);
  const best = (run.generations || []).find(g => g.gen === run.best);
  const justified = best && best.state === 'justified-break';

  const enginePath = path.join(REPO, 'engine.js');
  const backup = enginePath + '.evo-bak';
  fs.copyFileSync(enginePath, backup);
  const goldenPath = path.join(REPO, 'tests', 'golden.json');
  const goldenBackup = goldenPath + '.evo-bak';
  fs.copyFileSync(goldenPath, goldenBackup);

  const revert = (msg) => {
    fs.copyFileSync(backup, enginePath); fs.unlinkSync(backup);
    fs.copyFileSync(goldenBackup, goldenPath); fs.unlinkSync(goldenBackup);
    console.error('✗ accept aborted and reverted: ' + msg);
    process.exit(1);
  };

  // Apply the diff by re-rendering the best edits onto the CURRENT engine
  // (robust to line drift since proposal time), then re-validate.
  const edits = best && best.hypothesis ? best.hypothesis.edits : null;
  if (!edits) revert('proposal carries no structured edits to apply');
  const cur = fs.readFileSync(enginePath, 'utf8');
  const rendered = renderEdits(cur, edits);
  if (!rendered.ok) revert('edits no longer validate against the current engine: ' + rendered.rejected.map(r => r.reason).join('; '));
  fs.writeFileSync(enginePath, rendered.newSource);
  console.log('· applied diff to engine.js');

  if (justified) {
    console.log('· justified break — recapturing goldens (node tests/parity.js --update)');
    try { cp.execFileSync('node', ['tests/parity.js', '--update'], { cwd: REPO, stdio: 'inherit' }); }
    catch (e) { revert('golden recapture failed'); }
  }

  // Final gate: the merged engine must pass its own (possibly recaptured) tests.
  console.log('· final gate: npm test');
  try { cp.execFileSync('npm', ['test'], { cwd: REPO, stdio: 'inherit' }); }
  catch (e) { revert('post-merge npm test failed'); }

  fs.unlinkSync(backup); fs.unlinkSync(goldenBackup);
  console.log('\n✓ accepted ' + runId + ' — engine.js updated' + (justified ? ' and goldens recaptured' : '') + ', npm test green. A human typed the command; the machine checked the work.');
}

/* ---- CLI ---- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  (async () => {
    if (idx('--review') >= 0) return cmdReview(args[idx('--review') + 1]);
    if (idx('--accept') >= 0) return cmdAccept(args[idx('--accept') + 1]);
    if (idx('--reject') >= 0) return cmdReject(args[idx('--reject') + 1]);
    const provider = idx('--provider') >= 0 ? args[idx('--provider') + 1] : undefined;
    const generations = idx('--generations') >= 0 ? +args[idx('--generations') + 1] : undefined;
    await cmdRun({ provider, generations });
  })().catch(e => { console.error(e && e.message || e); process.exit(1); });
}

module.exports = { evaluateCandidate, classify, makeSandbox, candidateParity, candidateTests, cmdRun, cmdReview, cmdAccept, cmdReject };
