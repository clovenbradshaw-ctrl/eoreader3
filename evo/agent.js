/* ============================================================
   evo/agent.js — the reasoning agent: observe → hypothesize → patch
   → argue. Two pluggable providers behind one interface:

     live    — the Anthropic API. Reads the trace battery + the current
               quality breakdown (one Messages call per generation),
               forms one hypothesis, emits STRUCTURED edits + a written
               argument. Also serves the 2c integration rubric and the
               talker LLM. Uses the official @anthropic-ai/sdk (lazy-
               required) with claude-opus-4-8 + adaptive thinking.

     offline — a deterministic, budget-free scripted agent. No network,
               no key. Proposes a small, real sequence of hypotheses
               (verified to move the battery) so a full `evo:run` works
               and produces an actionable proposal with zero setup, and
               so the loop is testable in CI. The story it tells is real:
               a clean-parity win, an over-correction that costs honesty,
               a constitutionally-rejected attempt to game the metric, and
               a regression — the tension the whole loop exists to surface.

   provider:'auto' uses live when ANTHROPIC_API_KEY is set, else offline.

   The agent only ever emits structured edits; the runner renders + the
   allowlist validates them. The agent cannot reach past its sandbox.
   ============================================================ */
'use strict';
const { traceDocument } = require('./engine-host');

/* ---- OBSERVE — the trace battery the agent reads (step 1) ---- */
async function observe(EOEngine, loadFixtures) {
  const out = { binding: [], stalls: [], integration: [] };
  for (const kind of ['binding', 'stalls', 'integration']) {
    for (const fx of loadFixtures(kind)) {
      const tr = await traceDocument(EOEngine, { name: fx.id + '.txt', text: fx.doc, id: fx.id });
      out[kind].push({
        id: fx.id, genre: fx.genre || null,
        counts: tr.counts,
        entities: tr.entities.filter(e => e.type === 'person').map(e => ({ name: e.name, gender: e.gender, mass: e.mass })),
        stalls: tr.nulls.filter(n => n.reason && n.reason.startsWith('pronoun-stall'))
          .map(n => ({ at: n.sentence_idx, surface: n.surface, competing: (n.competing || []).slice(0, 3).map(c => c.siteName + ':' + c.score) })),
        sigs: tr.sigs.map(s => ({ at: s.sentence_idx, speaker: s.speaker, how: s.attributed })),
      });
    }
  }
  return out;
}

/* compact text rendering of the trace battery + quality, for the prompt */
function renderTraces(traces, baseline) {
  const L = [];
  L.push('CURRENT QUALITY (composite ' + baseline.composite.toFixed(4) + '):');
  L.push('  2a pronoun-binding accuracy: ' + baseline.components.binding.toFixed(3));
  L.push('  2b stall honesty (F1):       ' + baseline.components.stall.toFixed(3) + '  (TP' + baseline.stall.TP + ' FP' + baseline.stall.FP + ' FN' + baseline.stall.FN + ' TN' + baseline.stall.TN + ')');
  L.push('  2c integration:              ' + baseline.components.integration.toFixed(3));
  L.push('');
  for (const kind of ['binding', 'stalls', 'integration']) {
    L.push('## ' + kind + ' fixtures');
    for (const d of traces[kind]) {
      L.push('- ' + d.id + ' [' + (d.genre || '') + '] people: ' + d.entities.map(e => e.name + '(' + (e.gender || '?') + ',m' + (e.mass || 0).toFixed(1) + ')').join(', '));
      if (d.stalls.length) L.push('    stalls: ' + d.stalls.map(s => 's' + s.at + ' "' + s.surface + '" {' + s.competing.join(' ') + '}').join('; '));
      if (d.sigs && d.sigs.length) L.push('    attributions: ' + d.sigs.map(s => 's' + s.at + '→' + s.speaker + '<' + s.how + '>').join(' '));
    }
  }
  return L.join('\n');
}

/* =====================  OFFLINE provider  ===================== */
function offlineAgent() {
  // A verified, deterministic sequence. Each entry is a full hypothesis.
  const script = [
    {
      target: 'inertia_delta 2.0 → 1.75',
      statement: 'The dominance gate δ=2.0 is too strict: it over-stalls a pronoun whose referent is actually unambiguous to a reader. Lower it to 1.75.',
      rationale: 'In steward, "she said" before "Then tell them the grain is theirs" is unmistakably Princess Mary, yet she leads the runner-up by only ~1.85×, just under δ=2.0, so the binder stalls (a false stall). The genuinely-contested sites in dispatch (them/she/It, all ≤1.2× ratios) and steward\'s "it"=the-land stay contested at 1.75, so honest stalls survive while the false one resolves.',
      argument: 'Stall honesty rises because the gate stops refusing a bind a reader would make confidently, without becoming trigger-happy on the genuinely ambiguous sites. This is the dominance ratio doing its job at a better-calibrated threshold — not a weakening of the stall mechanism, which still fires on every low-ratio contest. The collision law (δ dominance, NUL on a tie) is unchanged; only the threshold moved.',
      predicted: '2b stall honesty up (the false stall on steward s14 clears; dispatch + steward "it" stay stalled)',
      edits: [{ kind: 'rule-value', rule: 'inertia_delta', value: 1.75 }],
    },
    {
      target: 'inertia_delta 1.75 → 1.6',
      statement: 'If lowering δ helped, push it further to 1.6 and bind even more.',
      rationale: 'Tests the hypothesis that monotonically lowering the dominance ratio keeps helping. It should NOT: at some point a genuinely-contested site (the land "it", ratio ~1.64) falls below the gate and the binder forces a wrong bind, suppressing an honest stall.',
      argument: 'This is the over-correction the two-fitness design exists to catch. A quality-only agent chasing fewer stalls would take it; the stall-honesty F1 punishes it because suppressing an honest stall is an integrity loss, not a win.',
      predicted: '2b stall honesty DOWN (an honest stall is suppressed) — should be rejected as a null/regression',
      edits: [{ kind: 'rule-value', rule: 'inertia_delta', value: 1.6 }],
    },
    {
      target: 'pronoun_resolution_floor 0.1 → 0.0',
      statement: 'Remove the absolute floor under the winning pronoun score so the binder always commits to its best candidate instead of stalling.',
      rationale: 'This would directly raise apparent confidence by eliminating void resolutions. It is exactly the move a metric-gaming agent makes to look more decisive.',
      argument: 'It must not be allowed: the floor is "the binder\'s right to say I don\'t know" — a medium-constant, not in the MAY-evolve set. Removing it would let the agent manufacture confidence by abolishing honest abstention. The constitution rejects this before it runs.',
      predicted: 'REJECTED by the allowlist (medium-constant, not evolvable) — no rerun, no cost',
      edits: [{ kind: 'rule-value', rule: 'pronoun_resolution_floor', value: 0.0 }],
    },
    {
      target: 'mass_weight 0.1 → 0.4',
      statement: 'Make heavy characters stickier in pronoun resolution by raising the surface-mass coefficient.',
      rationale: 'Hypothesis: weighting accumulated name-mass more heavily will help bind pronouns to the obvious protagonist.',
      argument: 'It backfires: heavier mass lets a high-mass speaker (Dron) capture "she/he" away from the correct lighter referent, lowering binding accuracy. A plausible-sounding physics change that the binding fixtures falsify.',
      predicted: '2a binding accuracy DOWN — should not be surfaced',
      edits: [{ kind: 'rule-value', rule: 'mass_weight', value: 0.4 }],
    },
  ];
  let i = 0;
  return {
    provider: 'offline',
    async hypothesize() { return i < script.length ? script[i++] : null; },
    recordResult() {},
    exhausted() { return false; },
    calls() { return 0; },
    async rubricScore() { return null; },   // 2c stays stubbed offline
    async talker() { return null; },         // talker uses fallbackSignificance offline
  };
}

/* =====================  LIVE provider (Anthropic)  ===================== */
function liveAgent({ budget, model, maxRubricDocChars }) {
  const DOC_CAP = maxRubricDocChars || 4000;
  let client = null;
  const getClient = () => {
    if (client) return client;
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch (e) { throw new Error('live provider needs the Anthropic SDK: `npm install @anthropic-ai/sdk` (or run with --provider offline)'); }
    client = new Anthropic(); // reads ANTHROPIC_API_KEY
    return client;
  };
  const MODEL = model || 'claude-opus-4-8';
  let calls = 0;

  async function call({ system, user, maxTokens, thinking }) {
    calls++;
    const req = { model: MODEL, max_tokens: maxTokens || 4096, system, messages: [{ role: 'user', content: user }] };
    if (thinking) req.thinking = { type: 'adaptive' };
    const resp = await getClient().messages.create(req);
    return (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }

  const SYSTEM = [
    'You evolve a deterministic reading engine by proposing ONE small, testable change per turn.',
    'You may ONLY change: physics constants decay_gamma / inertia_delta / mass_weight; any READING_RULES entry whose src is hardcoded-seed or a language-module; or the talker portrait prompts.',
    'You may NEVER touch the EVA checks, the grounder, citation binding, the operator vocabulary, parity, the golden snapshots, or the quality fixtures — those are the constitution and are rejected mechanically.',
    'Parity is a floor you may break only when the quality gain clearly justifies a deliberate golden recapture; prefer changes that keep parity clean. Stall honesty punishes you for suppressing honest "I don\'t know" stalls — do not try to raise confidence by abolishing abstention.',
    'Respond with ONLY a JSON object: {"target": short label, "statement": one sentence, "rationale": why, grounded in the trace, "argument": why a human should accept it, "predicted_component": "binding"|"stall"|"integration", "edits": [ ... ]}.',
    'Each edit is one of: {"kind":"rule-value","rule":NAME,"value":NUMBER_OR_BOOL}, {"kind":"rule-tokens-add","rule":NAME,"tokens":[...]}, {"kind":"rule-tokens-remove","rule":NAME,"tokens":[...]}, {"kind":"prompt-edit","slot":"system"|"retry","find":TEXT,"replace":TEXT}.',
  ].join('\n');

  function parseJson(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < 0) return null;
    try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
  }

  return {
    provider: 'live',
    async hypothesize({ traces, baseline, history }) {
      if (calls >= budget) return null;
      const hist = history.filter(h => h.state).slice(-6).map(h =>
        '- ' + (h.hypothesis ? h.hypothesis.target : '?') + ' → ' + h.state +
        (h.qualityDelta != null ? ' (Δ' + h.qualityDelta.toFixed(4) + (h.parity ? ', parity ' + (h.parity.clean ? 'clean' : h.parity.diffs + ' diffs') : '') + ')' : '') +
        (h.note ? ' — ' + h.note : '')).join('\n');
      const user = [
        renderTraces(traces, baseline),
        '',
        history.length ? 'PRIOR ATTEMPTS THIS RUN (learn from these — do not repeat a rejected or null move):\n' + hist : 'First hypothesis of the run.',
        '',
        'Propose ONE change most likely to raise the composite while keeping parity clean. Return only the JSON object.',
      ].join('\n');
      const text = await call({ system: SYSTEM, user, maxTokens: 8000, thinking: true });
      const h = parseJson(text);
      if (!h || !Array.isArray(h.edits) || !h.edits.length) return null;
      h.predicted = h.predicted_component || h.predicted;
      return h;
    },
    recordResult() {},
    exhausted() { return calls >= budget; },
    calls() { return calls; },

    // 2c integration rubric — one call per fixture document.
    async rubricScore(fx, grounded) {
      if (calls >= budget) return null;
      const system = 'You are a strict reading-quality grader. Score 0.0–1.0 on this rubric, averaging four criteria each in [0,1]: (1) does the reading TRACE to the source, inventing no facts; (2) is the framing EPISTEMIC ("the reading", "the document carries") not ontological ("the text says X is true"); (3) does it CAPTURE what the document turns on; (4) does it AVOID inventing connections the source does not make. Respond with ONLY a JSON object {"score": NUMBER, "why": SHORT}.';
      // Truncate the source to bound tokens (frugality). The reading is short.
      const src = fx.doc.length > DOC_CAP ? fx.doc.slice(0, DOC_CAP) + '\n…[truncated]' : fx.doc;
      const user = 'RUBRIC FOCUS: ' + (fx.rubric_focus || fx.question || '(general)') + '\n\nSOURCE DOCUMENT:\n' + src + '\n\nTHE ENGINE\'S GROUNDED READING:\n' + grounded;
      const text = await call({ system, user, maxTokens: 1024 });
      const j = parseJson(text);
      const s = j && typeof j.score === 'number' ? Math.max(0, Math.min(1, j.score)) : null;
      return s;
    },

    // talker LLM — produces the significance paragraph the talker portrait
    // composes (so evolved prompts actually move 2c when live).
    async talker(sys, userMsg) {
      if (calls >= budget) return '';
      return await call({ system: sys, user: userMsg, maxTokens: 700 });
    },
  };
}

/* ---- factory ---- */
function create(opts = {}) {
  let provider = opts.provider || 'auto';
  if (provider === 'auto') provider = process.env.ANTHROPIC_API_KEY ? 'live' : 'offline';
  if (provider === 'live') return liveAgent({ budget: opts.budget != null ? opts.budget : 24, model: opts.model });
  return offlineAgent();
}

module.exports = { create, observe, renderTraces };
