/* ============================================================
   Tests for the SHAPE layer (shape.js → window.EOShape).

   shape.js is a browser IIFE that publishes onto `window` and imports
   nothing — generation and embedding are injected — so, like the engine/llm
   harnesses, we run it in a vm context with a fake `window` and read
   window.EOShape back out. Everything here is pure: fake embedders and fake
   generators stand in for EOEmbed/EOLLM, so the whole shape layer is exercised
   with no WebGPU and no network.

   Covers: exemplar parsing, the discriminative score (§5), the adaptive
   threshold (§5), the interpretable axes / revision instructions (§6/§7),
   PCA (§7), the exemplar library, and the drafting controller's three exit
   conditions (§4/§10) — landed, converged-and-failed, budget-exhausted —
   plus the invariant that the model never sees a numeric score.

   Run with `node tests/shape.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadShape() {
  const sandbox = { window: {}, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'shape.js'), 'utf8'), sandbox, { filename: 'shape.js' });
  if (!sandbox.window.EOShape) throw new Error('shape.js did not publish window.EOShape');
  return sandbox.window.EOShape;
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function near(a, b, msg, tol) { ok(Math.abs(a - b) <= (tol || 1e-6), `${msg} (got ${a}, want ≈${b})`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

const S = loadShape();

// A deterministic fake embedder: maps a tag in the text to a fixed direction.
// Handles both the batch shape (library load: string[] → vec[]) and the single
// shape (the loop: string → vec) the module calls it with.
function unit(v) { const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1; return v.map(x => x / n); }
const DIR = {
  '[LOOKUP]': [1, 0, 0], '[LOOKUP2]': unit([0.9, 0.1, 0]), '[SYNTH]': [0, 1, 0], '[SYNTH2]': unit([0.1, 0.9, 0]),
  // prompt-side tags (§9): a prompt embeds near its intent's archetype prompts
  '[QLOOKUP]': [1, 0, 0], '[QLOOKUP2]': unit([0.95, 0.05, 0]), '[QSYNTH]': [0, 1, 0], '[QSYNTH2]': unit([0.05, 0.95, 0]),
};
function vecForText(s) {
  for (const tag of Object.keys(DIR)) if (String(s).indexOf(tag) !== -1) return DIR[tag];
  return [0, 0, 1];
}
function fakeEmbed(x) { return Array.isArray(x) ? x.map(vecForText) : vecForText(x); }

group('parseExemplars — defensive JSONL, weight defaults, ids assigned', () => {
  const text = [
    '// a comment',
    '# another comment',
    '',
    '{"intent":"lookup","response":"It is 1934.","shape_tags":["short"]}',
    'not json at all',
    '{"intent":"lookup"}',                 // no response → skipped
    '{"response":"orphan"}',               // no intent → skipped
    '{"id":"keep-me","intent":"synthesis","response":"A reading.","weight":2.5}',
    '{"id":"with-axes","intent":"dry","response":"Noted.","anchor_axes":["pole:short","pole:dry"]}',
  ].join('\n');
  const ex = S.parseExemplars(text);
  eq(ex.length, 3, 'only the well-formed records survive');
  eq(ex[0].weight, 1, 'weight defaults to 1 (the Hebbian field, §11)');
  ok(/^ex-/.test(ex[0].id), 'a missing id is assigned');
  eq(ex[1].id, 'keep-me', 'an explicit id is kept');
  eq(ex[1].weight, 2.5, 'an explicit weight is kept');
  ok(Array.isArray(ex[0].shape_tags), 'shape_tags is always an array');
  ok(Array.isArray(ex[0].anchor_axes) && ex[0].anchor_axes.length === 0, 'anchor_axes defaults to an empty array');
  eq(JSON.stringify(ex[2].anchor_axes), JSON.stringify(['pole:short', 'pole:dry']), 'declared anchor_axes are carried through');
});

// The real shape-steering library (merged from PR #58) — 373 exemplars across
// 22 intents, every line valid JSON, ids unique, both poles of every axis
// anchored via anchor_axes. The shape layer pulls from THIS, not a placeholder.
group('the merged exemplars.jsonl parses and spans the real intent range', () => {
  const text = fs.readFileSync(path.join(ROOT, 'exemplars.jsonl'), 'utf8');
  const ex = S.parseExemplars(text);
  ok(ex.length >= 300, 'the full library has hundreds of exemplars (got ' + ex.length + ')');
  const intents = new Set(ex.map(e => e.intent));
  ok(intents.size >= 20, 'it spans the full intent range (got ' + intents.size + ' intents)');
  for (const want of ['lookup', 'synthesis', 'clarify-question', 'connect-passages',
    'pushback-repair', 'refusal-without-condescension', 'hedge-uncertain', 'disagree-with-source'])
    ok(intents.has(want), 'intent present: ' + want);
  eq(new Set(ex.map(e => e.id)).size, ex.length, 'all ids are unique');
  ok(ex.every(e => typeof e.weight === 'number'), 'every exemplar carries a numeric weight (defaulted; §11)');
  ok(ex.every(e => Array.isArray(e.anchor_axes)), 'every exemplar carries anchor_axes');
  ok(ex.some(e => e.anchor_axes.length > 0), 'the library declares axis poles');
  ok(ex.every(e => e.response && e.response.length), 'every exemplar has a response');
});

group('vector math — cosine normalizes, dot is raw', () => {
  near(S.cosine([1, 0, 0], [1, 0, 0]), 1, 'identical ⇒ 1');
  near(S.cosine([1, 0, 0], [0, 1, 0]), 0, 'orthogonal ⇒ 0');
  near(S.cosine([2, 0, 0], [3, 0, 0]), 1, 'cosine is scale-invariant');
  near(S.dot([2, 0, 0], [3, 0, 0]), 6, 'dot is the raw product');
});

group('discriminativeScore (§5) — s_t − s_c, in-basin vs competitors', () => {
  const target = {
    targetExemplars: [{ id: 't', responseVec: [1, 0, 0] }],
    competitorExemplars: [{ id: 'c', responseVec: [0, 1, 0] }],
  };
  const onTarget = S.discriminativeScore([1, 0, 0], target);
  near(onTarget.s_t, 1, 'on-target draft: s_t = 1');
  near(onTarget.s_c, 0, 'on-target draft: s_c = 0');
  near(onTarget.score, 1, 'score = s_t − s_c');
  eq(onTarget.target, 't', 'reports the matched target id');
  eq(onTarget.nearestCompetitor, 'c', 'reports the nearest competitor id');

  const onCompetitor = S.discriminativeScore([0, 1, 0], target);
  ok(onCompetitor.score < 0, 'a draft in a competing shape scores negative');

  const noComp = S.discriminativeScore([1, 0, 0], { targetExemplars: [{ id: 't', responseVec: [1, 0, 0] }], competitorExemplars: [] });
  near(noComp.s_c, 0, 'no competitors ⇒ s_c = 0 (nothing to be confused with)');
  near(noComp.score, 1, 'score falls back to s_t when the region is empty of competitors');
});

group('adaptiveThreshold (§5) — higher where shapes crowd together', () => {
  const target = [{ responseVec: [1, 0, 0], weight: 1 }];
  const sparse = S.adaptiveThreshold(target, [{ responseVec: [0, 1, 0] }]);          // competitor far
  const dense = S.adaptiveThreshold(target, [{ responseVec: unit([0.95, 0.05, 0]) }]); // competitor close
  ok(dense > sparse, 'a nearby competing shape raises the bar (dense > sparse)');
  ok(sparse >= S.THRESHOLD.lo - 1e-9 && dense <= S.THRESHOLD.hi + 1e-9, 'threshold stays within [lo, hi]');
  near(sparse, S.THRESHOLD.lo, 'an isolated target sits at the floor', 1e-6);
});

group('structuralFeatures — interpretable axes from the text (§6/§7)', () => {
  eq(S.structuralFeatures('1934.').words, 1, 'a bare date is one word');
  ok(S.structuralFeatures('I think it might possibly be so, perhaps.').hedgeDensity > 0, 'hedges are counted');
  eq(S.structuralFeatures('plain committed statement.').hedgeDensity, 0, 'a committed line has no hedges');
  ok(S.structuralFeatures('- one\n- two\n- three').lists >= 3, 'list markers are counted');
  ok(S.structuralFeatures('I did. My turn. Me, myself.').firstPersonDensity > 0, 'first-person is counted');
});

group('revisionInstruction (§7) — natural-language drift, up to two axes', () => {
  const targetShort = ['It is 1934.'];   // short, committal
  const longHedged = 'Well, I think it might possibly be that, perhaps, the year was something like 1934, though I could be wrong and it may be slightly off, arguably.';
  const r1 = S.revisionInstruction(longHedged, targetShort);
  ok(/concise/.test(r1.instruction), 'a long draft against a short target → "more concise"');
  ok(/hedg|committed/.test(r1.instruction), 'a hedged draft against a committal target → less hedging');
  ok(r1.drift.length >= 1, 'drift axes are reported for the audit');

  const targetProse = ['It follows a small crew over one season as a routine job turns sour, and it asks what they owe each other once it is over.'];
  const asList = '- point one\n- point two\n- point three\n- point four';
  const r2 = S.revisionInstruction(asList, targetProse);
  ok(/prose/.test(r2.instruction), 'a list against a prose target → "flowing prose"');
});

group('pca (§7 proper) — recovers the dominant axis', () => {
  const pts = [[3, 0], [-3, 0], [1, 0], [-1, 0], [2, 0], [-2, 0]];   // variance only along dim 0
  const { components } = S.pca(pts, 1);
  ok(components.length === 1, 'one component requested, one returned');
  near(Math.abs(components[0][0]), 1, 'PC1 aligns with the varying axis', 1e-3);
  near(Math.abs(components[0][1]), 0, 'PC1 has no weight on the flat axis', 1e-3);
  const proj = S.projectError([4, 0], components);
  near(Math.abs(proj[0]), 4, 'projecting onto PC1 recovers the magnitude', 1e-3);
});

(async function run() {
  await group('createLibrary — embeds responses once, clusters by intent, scores', async () => {
    const exemplars = S.parseExemplars([
      '{"id":"L1","intent":"lookup","response":"[LOOKUP] near"}',
      '{"id":"L2","intent":"lookup","response":"[LOOKUP2] far"}',
      '{"id":"S1","intent":"synthesis","response":"[SYNTH] a"}',
      '{"id":"S2","intent":"synthesis","response":"[SYNTH2] b"}',
    ].join('\n'));
    const lib = S.createLibrary(exemplars, { embed: fakeEmbed });
    ok(!lib.ready(), 'a fresh library is not ready until loaded');
    await lib.load();
    ok(lib.ready(), 'after load() the library is ready');
    ok(lib.exemplars.every(e => e.responseVec), 'every response is embedded and cached');

    const target = lib.select({ intent: 'lookup', shapeNote: 'They want the name.', noteVec: [1, 0, 0] });
    eq(target.intent, 'lookup', 'select carries the intent');
    eq(target.shape_note, 'They want the name.', 'select carries the shape note (§8)');
    ok(target.target_exemplar_ids.length <= 5 && target.target_exemplar_ids.length >= 1, 'target ids are a small cluster');
    ok(target.target_exemplar_ids.every(id => id === 'L1' || id === 'L2'), 'targets are drawn from the intent cluster');
    eq(target.target_exemplar_ids[0], 'L1', 'the note vector ranks the nearest exemplar first');
    ok(target.competitorExemplars.every(e => e.intent === 'synthesis'), 'competitors are the other intents');
    ok(target.threshold >= S.THRESHOLD.lo && target.threshold <= S.THRESHOLD.hi, 'a threshold is computed');
    ok(Array.isArray(target.axes_to_emphasize), 'axis hints are produced (§8)');

    ok(lib.score([1, 0, 0], target).score > 0, 'a lookup-shaped draft scores positive against the lookup target');
    ok(lib.score([0, 1, 0], target).score < 0, 'a synthesis-shaped draft scores negative against the lookup target');
  });

  // §9 — prompt → archetype matching + length-derived token budget.
  function promptLib() {
    const exemplars = S.parseExemplars([
      '{"id":"L1","intent":"lookup","user_turn":"[QLOOKUP] who wrote it","response":"[LOOKUP] Balzac."}',
      '{"id":"L2","intent":"lookup","user_turn":"[QLOOKUP2] the author?","response":"[LOOKUP2] By Balzac."}',
      '{"id":"S1","intent":"synthesis","user_turn":"[QSYNTH] what is the point of all this","response":"[SYNTH] A reading that develops a tension across several sentences and keeps unfolding long enough to be clearly the longer shape, with clauses and more clauses besides."}',
      '{"id":"S2","intent":"synthesis","user_turn":"[QSYNTH2] what does it mean","response":"[SYNTH2] Another extended synthesis, also long, several clauses, developed at length."}',
    ].join('\n'));
    return S.createLibrary(exemplars, { embed: fakeEmbed });
  }

  await group('§9 prompt matching — embeds prompts, matches by prompt-to-prompt, infers intent', async () => {
    const lib = promptLib();
    await lib.load();
    ok(lib.readyPrompts(), 'after load() the prompts are embedded too');
    ok(lib.exemplars.every(e => e.promptVec), 'every exemplar with a user_turn carries a promptVec');

    const m = lib.matchPrompt([1, 0, 0]);                 // a lookup-shaped prompt
    ok(m, 'matchPrompt returns a result when prompts are embedded');
    eq(m.intent, 'lookup', 'the nearest archetype prompts infer the intent');
    eq(m.best.id, 'L1', 'the single best prompt match is reported');
    ok(m.confidence > 0.5, 'a clean lookup prompt is confidently lookup (got ' + m.confidence + ')');
    ok(Array.isArray(m.matches) && m.matches.length >= 1, 'the nearest matches are listed for feedback');

    const synth = lib.matchPrompt([0, 1, 0]);
    eq(synth.intent, 'synthesis', 'a synthesis-shaped prompt infers synthesis');

    const ambiguous = lib.matchPrompt(unit([1, 1, 0]));   // sits between the two shapes
    ok(ambiguous.confidence < m.confidence, 'a prompt between shapes is reported less confidently (§9)');
  });

  await group('§9 select(queryVec) — infers intent and ranks by prompt similarity', async () => {
    const lib = promptLib();
    await lib.load();
    // No intent supplied: the query embedding alone picks the cluster.
    const target = lib.select({ queryVec: [1, 0, 0], shapeNote: 'they want the name' });
    eq(target.intent, 'lookup', 'queryVec infers the intent when the caller omits it');
    eq(target.target_exemplar_ids[0], 'L1', 'the cluster is ranked by prompt-to-prompt similarity');
    ok(target.prompt_match && target.prompt_match.best_id === 'L1', 'the prompt match rides the target for the audit');
    ok(target.competitorExemplars.every(e => e.intent !== 'lookup'), 'competitors are the other intents');

    // Backward compatible: no queryVec ⇒ note/weight ranking, prompt_match null.
    const noQuery = lib.select({ intent: 'lookup', noteVec: [1, 0, 0] });
    eq(noQuery.prompt_match, null, 'without a query embedding there is no prompt match (parity)');
    ok(noQuery.target_exemplar_ids[0] === 'L1', 'the noteVec path still ranks by response fit');
  });

  await group('§9 tokenBudgetFor — sizes max_tokens from the best-fit length', async () => {
    const lib = promptLib();
    await lib.load();
    const lookup = lib.select({ queryVec: [1, 0, 0] });
    const synth = lib.select({ queryVec: [0, 1, 0] });
    const bl = S.tokenBudgetFor(lookup), bs = S.tokenBudgetFor(synth);
    ok(bl && typeof bl.maxTokens === 'number', 'a budget is returned for a matched shape');
    ok(bl.maxTokens >= S.TOKEN_BUDGET.floor && bl.maxTokens <= S.TOKEN_BUDGET.ceil, 'the budget is clamped to the safe window');
    eq(bl.maxTokens, S.TOKEN_BUDGET.floor, 'a one-line lookup archetype yields the floor budget');
    ok(bs.maxTokens > bl.maxTokens, 'a long synthesis archetype yields a larger budget than a lookup (' + bs.maxTokens + ' > ' + bl.maxTokens + ')');
    eq(bl.basis.exemplar_id, 'L1', 'the budget records the archetype it was sized from (auditable)');
    ok(typeof bl.basis.best_fit_tokens === 'number', 'the basis records the best-fit length');
    // No targets ⇒ no budget (caller keeps the default cap).
    eq(S.tokenBudgetFor({ targetExemplars: [] }), null, 'an empty target shape yields no budget');
    eq(S.tokenBudgetFor(null), null, 'a null target shape yields no budget');
  });

  await group('§9 tokenBudgetFor — works on a degraded (unembedded) library', async () => {
    const lib = S.createLibrary(S.parseExemplars([
      '{"id":"L1","intent":"lookup","user_turn":"who wrote it","response":"Balzac."}',
    ].join('\n')), { embed: () => null });
    await lib.load();
    ok(!lib.readyPrompts(), 'no embedder ⇒ prompts not embedded, matching off');
    const target = lib.select({ intent: 'lookup' });           // weight-ordered, no vectors
    const b = S.tokenBudgetFor(target);
    ok(b && b.maxTokens >= S.TOKEN_BUDGET.floor, 'the length budget needs no embeddings — it reads the response text');
  });

  await group('createLibrary — degraded (no embedder) disables scoring, keeps clustering', async () => {
    const lib = S.createLibrary(S.parseExemplars('{"id":"L1","intent":"lookup","response":"x"}'), { embed: () => null });
    await lib.load();
    ok(!lib.ready(), 'a library whose embedder yields nothing stays not-ready');
    const target = lib.select({ intent: 'lookup' });
    ok(target && target.intent === 'lookup', 'clustering still works without vectors');
    eq(lib.score([1, 0, 0], target), null, 'scoring is disabled in the degraded state (caller falls back)');
  });

  // The drafting loop — the core mechanism (§4). A target with one exemplar and
  // one competitor; fake generate() returns crafted drafts; fake embed maps each
  // to a vector with a known score. Threshold 0.2.
  function targetWith(threshold, competitor) {
    return {
      intent: 'lookup', shape_note: 'one line, committal',
      target_exemplar_ids: ['t'],
      targetExemplars: [{ id: 't', response: 'It is 1934.', responseVec: [1, 0, 0], weight: 1 }],
      competitorExemplars: competitor === false ? [] : [{ id: 'c', response: 'A long hedged reading, perhaps.', responseVec: [0, 1, 0] }],
      threshold, axes_to_emphasize: ['short', 'committal'],
    };
  }

  await group('drafting loop — lands on draft 1 when the first draft is in-basin', async () => {
    const calls = [];
    const res = await S.runDraftingLoop({
      targetShape: targetWith(0.2),
      baseInstruction: 'BASE',
      generate: async (arg) => { calls.push(arg); return '[on target]'; },
      embed: async () => [1, 0, 0],
    });
    eq(res.attempts, 1, 'one draft suffices');
    ok(res.landed && !res.soft_fail, 'it landed cleanly');
    eq(res.response, '[on target]', 'the landed draft is returned');
    eq(calls[0].instruction, 'BASE', 'the first draft uses the base shape framing');
    eq(calls[0].prior, null, 'the first draft has no prior');
  });

  await group('drafting loop — revises, then lands on a later draft', async () => {
    const seen = [];
    let n = 0;
    const res = await S.runDraftingLoop({
      targetShape: targetWith(0.2),
      baseInstruction: 'BASE',
      generate: async (arg) => { seen.push(arg); return 'd' + (++n); },
      embed: async (text) => (text === 'd1' ? [0, 1, 0] : [1, 0, 0]),   // d1 misses, d2 lands
    });
    eq(res.attempts, 2, 'lands on the second draft');
    ok(res.landed, 'it eventually landed');
    eq(seen[0].instruction, 'BASE', 'draft 1 uses the base framing');
    ok(seen[1].instruction !== 'BASE' && seen[1].instruction.length > 0, 'draft 2 uses a revision instruction');
    ok(seen[1].prior && seen[1].prior.response === 'd1', 'draft 2 sees the prior draft text');
    ok(!('score' in (seen[1].prior || {})), 'the prior handed to the model carries no numeric score (§4)');
  });

  await group('drafting loop — the model never sees a numeric score (§4)', async () => {
    const seen = [];
    await S.runDraftingLoop({
      targetShape: targetWith(0.9),   // never lands → several revisions
      baseInstruction: 'BASE',
      generate: async (arg) => { seen.push(arg); return 'draft'; },
      embed: async () => unit([0.5, 0.5, 0]),
      maxDrafts: 3,
    });
    for (const arg of seen) {
      ok(!('score' in arg) && !('s_t' in arg), 'generate args carry no score field');
      if (arg.prior) ok(!('score' in arg.prior), 'the prior draft carries no score field');
      ok(typeof arg.instruction === 'string', 'generate only ever receives natural-language instruction');
    }
  });

  await group('drafting loop — converged-and-failed stops early (§10)', async () => {
    const res = await S.runDraftingLoop({
      targetShape: targetWith(0.2),
      generate: async () => 'stuck',
      embed: async () => unit([0.5, 0.5, 0]),   // score 0 every time, < 0.2
      maxDrafts: 4, epsilon: 0.01,
    });
    ok(!res.landed && res.soft_fail, 'a non-improving run soft-fails');
    eq(res.reason, 'converged', 'it stops on convergence, not budget');
    ok(res.attempts < 4, 'it does not spend the whole draft budget (got ' + res.attempts + ')');
  });

  await group('drafting loop — budget exhausted while still improving (§10)', async () => {
    let n = 0;
    const scores = [0.1, 0.2, 0.3, 0.4];   // strictly improving, never reaches 0.9
    const res = await S.runDraftingLoop({
      targetShape: targetWith(0.9, false),   // no competitor ⇒ score = cos to target
      generate: async () => 'd' + (++n),
      embed: async () => { const s = scores[Math.min(n - 1, scores.length - 1)]; return [s, Math.sqrt(1 - s * s), 0]; },
      maxDrafts: 4, epsilon: 0.01,
    });
    eq(res.attempts, 4, 'it spends the full budget while improving');
    ok(!res.landed && res.soft_fail, 'budget exhaustion is a soft-fail');
    eq(res.reason, 'budget', 'the reason is budget, not convergence');
    near(res.finalScore, 0.4, 'the best (last) score is returned', 1e-6);
  });

  await group('drafting loop — degraded library returns honestly after one draft', async () => {
    const res = await S.runDraftingLoop({
      targetShape: targetWith(0.2),
      generate: async () => 'only draft',
      embed: async () => null,   // unscored
    });
    eq(res.attempts, 1, 'no scoring ⇒ one draft, no spinning');
    eq(res.response, 'only draft', 'the single draft is returned');
    ok(!res.soft_fail, 'an unscored result is not labeled a soft-fail');
    eq(res.reason, 'unscored', 'the reason is recorded honestly');
  });

  await group('drafting loop — the audit trail is structured for later (§11)', async () => {
    const res = await S.runDraftingLoop({
      targetShape: targetWith(0.2),
      baseInstruction: 'BASE',
      generate: async () => 'x',
      embed: async () => [1, 0, 0],
    });
    const a = res.audit;
    ok(a, 'an audit object is returned');
    eq(a.intent, 'lookup', 'the audit logs the target intent (not just embeddings)');
    ok(Array.isArray(a.target_exemplar_ids) && a.target_exemplar_ids[0] === 't', 'target exemplar IDs are logged');
    ok(Array.isArray(a.axes_to_emphasize), 'axis hints are logged');
    eq(typeof a.landed, 'boolean', 'landed-vs-soft-fail is logged');
    ok(Array.isArray(a.drafts) && a.drafts.length === res.attempts, 'every draft is in the trail');
    ok(a.drafts[0].drift !== undefined, 'structured drift axes are logged per draft, not just scores');
  });

  await group('load() convenience — parse + build + embed the real merged library', async () => {
    const text = fs.readFileSync(path.join(ROOT, 'exemplars.jsonl'), 'utf8');
    const lib = await S.load(text, fakeEmbed);
    ok(lib.ready(), 'the real library loads and embeds');
    const target = lib.select({ intent: 'connect-passages', shapeNote: 'draw the link the page leaves implicit' });
    ok(target && target.intent === 'connect-passages', 'a real intent selects a real cluster');
    ok(target.target_exemplar_ids.length >= 1, 'targets are drawn from the cluster');
    ok(target.competitorExemplars.length > 0, 'real competitors exist for the discriminative score');
    // The merged library declares poles, so the axis hints come from its own
    // anchor_axes rather than the structural fallback.
    ok(target.axes_to_emphasize.length > 0, 'axis hints are drawn from the library\'s declared poles');
  });

  // ----- the form-genres library (the SECOND library) ---------------------
  // exemplars.jsonl is Cleo's voice (authored); form-genres.jsonl is output
  // FORM (fetched, public-domain). They are scored apart on purpose: a form
  // library's competitors are the other GENRES, never assistant-voice moves.

  group('parseExemplars carries provenance (source / license / retrieved)', () => {
    const text = [
      '{"intent":"recipe","response":"Mix and bake.","source":"Farmer 1918, Gutenberg #65061","license":"Public domain","retrieved":"2026-06-14"}',
      '{"intent":"lookup","response":"Balzac."}',   // voice exemplar: no provenance, defaults to ''
    ].join('\n');
    const ex = S.parseExemplars(text);
    eq(ex.length, 2, 'both records parse');
    eq(ex[0].source, 'Farmer 1918, Gutenberg #65061', 'source is carried into memory for the audit');
    eq(ex[0].license, 'Public domain', 'license is carried into memory');
    eq(ex[0].retrieved, '2026-06-14', 'retrieved date is carried into memory');
    eq(ex[1].source, '', 'a voice exemplar with no provenance defaults source to empty');
    eq(ex[1].license, '', 'license defaults to empty when absent');
  });

  await group('form-genres loads as its OWN library, scored against its own genres', async () => {
    // A small fixture standing in for the fetched corpus: two GENRES, embedded
    // by the same fake embedder the rest of the suite uses ([LOOKUP]/[SYNTH] are
    // just two directions — here they stand for two form clusters).
    const formJsonl = [
      '{"intent":"recipe","response":"[LOOKUP] Cream the butter; add flour; bake.","source":"Farmer 1918","license":"Public domain","retrieved":"2026-06-14"}',
      '{"intent":"recipe","response":"[LOOKUP] Boil the rice; drain; serve.","source":"Beeton 1861","license":"Public domain","retrieved":"2026-06-14"}',
      '{"intent":"obituary","response":"[SYNTH] He died at his residence, survived by three children.","source":"Chronicling America 1901","license":"Public domain","retrieved":"2026-06-14"}',
      '{"intent":"obituary","response":"[SYNTH] She passed away after a long illness; services Thursday.","source":"Chronicling America 1899","license":"Public domain","retrieved":"2026-06-14"}',
    ].join('\n');
    const formLib = await S.load(formJsonl, fakeEmbed);
    ok(formLib.ready(), 'the form library loads and embeds its own responses');

    const target = formLib.select({ intent: 'recipe', shapeNote: 'a recipe' });
    ok(target && target.intent === 'recipe', 'a genre selects its own cluster');
    ok(target.targetExemplars.every(e => e.intent === 'recipe'), 'targets are all recipe instances');
    ok(target.competitorExemplars.length > 0, 'competitors exist for the discriminative score');
    ok(target.competitorExemplars.every(e => e.intent === 'obituary'),
      'competitors are drawn from the OTHER genre (obituary), never from voice intents');

    // The score is the form degree: a recipe-shaped draft sits in the recipe
    // basin and OUT of the obituary basin (positive s_t − s_c).
    const recipeDraftVec = fakeEmbed('[LOOKUP] Sift the sugar; fold; bake.');
    const scored = formLib.score(recipeDraftVec, target);
    ok(scored && scored.score > 0, 'a recipe-shaped draft scores positively against its own genre');
  });

  group('form-genres.jsonl on disk — every record is fair game, provenance complete', () => {
    const fp = path.join(ROOT, 'form-genres.jsonl');
    ok(fs.existsSync(fp), 'the form library file exists');
    const ex = S.parseExemplars(fs.readFileSync(fp, 'utf8'));   // never throws on header-only
    const ALLOWED = new Set(['news-article', 'obituary', 'recipe', 'encyclopedic-summary', 'plain-report', 'letter']);
    // Header-only until the fetch runs; once filled, every record must be a real
    // public-domain / openly-licensed instance with its papers attached.
    for (const r of ex) {
      ok(ALLOWED.has(r.intent), 'genre is one of the six form genres: ' + r.intent);
      ok(r.source && r.source.length > 0, 'record ' + r.id + ' names its source');
      ok(/public domain|cc by|cc0|cc-by|openly licensed/i.test(r.license), 'record ' + r.id + ' carries an open/PD license: ' + r.license);
      ok(r.retrieved && /^\d{4}-\d{2}-\d{2}$/.test(r.retrieved), 'record ' + r.id + ' carries a retrieval date');
      ok(r.response && r.response.length > 0, 'record ' + r.id + ' has form prose');
    }
    console.log('  · form-genres.jsonl: ' + ex.length + ' record(s)'
      + (ex.length === 0 ? ' (header-only — run tools/form-genres/fetch.mjs --live to fill)' : ''));
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
})();
