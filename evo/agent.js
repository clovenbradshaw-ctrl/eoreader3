/* ============================================================
   evo/agent.js — the reasoning agent: observe → investigate →
   hypothesize → patch → argue. Two pluggable providers:

     live    — the Anthropic API. Reads the trace battery + the current
               quality breakdown, may INVESTIGATE with a probe tool
               (ingest a document, ask the engine a question, inject a
               sample input, see how it reads), then proposes ONE change
               via a propose_change tool with a written argument. Also
               serves the 2c rubric and the talker LLM. Uses the official
               @anthropic-ai/sdk (lazy-required) with claude-opus-4-8 +
               adaptive thinking. Token-metered against a continuable max.

     offline — a deterministic, zero-token scripted agent so a full
               `evo:run` works with no key and the loop is testable. Its
               story is real: a clean-parity win, an over-correction that
               costs honesty, a constitutionally-rejected attempt to game
               the metric, and a regression.

   provider:'auto' uses live when ANTHROPIC_API_KEY is set, else offline.
   The agent only emits structured edits; the runner renders + the
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
          .map(n => ({ at: n.sentence_idx, surface: n.surface, competing: ((n.observed && n.observed.competing) || n.competing || []).slice(0, 3).map(c => c.siteName + ':' + c.score) })),
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

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
}

/* =====================  OFFLINE provider  ===================== */
function offlineAgent() {
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
    tokensUsed() { return 0; },
    extendBudget() {},
    async rubricScore() { return null; },
    async talker() { return null; },
  };
}

/* =====================  LIVE provider (Anthropic)  ===================== */
function liveAgent({ budget, model, maxRubricDocChars, tokenMax, maxProbeRounds }) {
  const DOC_CAP = maxRubricDocChars || 4000;
  const PROBE_ROUNDS = maxProbeRounds != null ? maxProbeRounds : 4;
  const MODEL = model || 'claude-opus-4-8';
  let TOKEN_MAX = tokenMax || 150000;
  let calls = 0, tokens = 0, client = null;

  const getClient = () => {
    if (client) return client;
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch (e) { throw new Error('live provider needs the Anthropic SDK: `npm install @anthropic-ai/sdk` (or run with --provider offline)'); }
    client = new Anthropic(); // reads ANTHROPIC_API_KEY
    return client;
  };
  const track = (resp) => {
    const u = resp.usage || {};
    tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  };
  const textOf = (resp) => (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  async function raw(req) { calls++; const resp = await getClient().messages.create(req); track(resp); return resp; }
  async function call({ system, user, maxTokens, thinking }) {
    const req = { model: MODEL, max_tokens: maxTokens || 4096, system, messages: [{ role: 'user', content: user }] };
    if (thinking) req.thinking = { type: 'adaptive' };
    return textOf(await raw(req));
  }

  const SYSTEM = [
    'You evolve a deterministic reading engine by proposing ONE small, testable change per turn.',
    'You may ONLY change: physics constants decay_gamma / inertia_delta / mass_weight; any READING_RULES entry whose src is hardcoded-seed or a language-module; or the talker portrait prompts.',
    'You may NEVER touch the EVA checks, the grounder, citation binding, the operator vocabulary, parity, the golden snapshots, or the quality fixtures — those are the constitution and are rejected mechanically before any rerun.',
    'Parity is a floor you may break only when the quality gain clearly justifies a deliberate golden recapture; prefer changes that keep parity clean. Stall honesty punishes you for suppressing honest "I don\'t know" stalls — never raise confidence by abolishing abstention.',
    'First INVESTIGATE if useful: call probe_engine to ingest a document (a fixture id, a corpus filename like "pg219.txt", or raw text) and ask the engine a question — inject sample inputs and see how it reads them. Then call propose_change EXACTLY ONCE with your hypothesis and structured edits.',
    'Each edit is one of: {"kind":"rule-value","rule":NAME,"value":NUMBER_OR_BOOL}, {"kind":"rule-tokens-add","rule":NAME,"tokens":[...]}, {"kind":"rule-tokens-remove","rule":NAME,"tokens":[...]}, {"kind":"prompt-edit","slot":"system"|"retry","find":TEXT,"replace":TEXT}.',
  ].join('\n');

  const TOOLS = [
    {
      name: 'probe_engine',
      description: 'Ingest a document and ask the current reading engine a question. Returns its grounded answer, the entities it found, and where it stalled (NUL). Use to investigate before proposing — inject sample inputs and see how the engine reads them.',
      input_schema: { type: 'object', properties: { doc: { type: 'string', description: 'a fixture id (e.g. "steward"), a corpus filename (e.g. "pg219.txt"), or raw text' }, query: { type: 'string', description: 'the question to ask the engine about the doc' } }, required: ['doc', 'query'] },
    },
    {
      name: 'propose_change',
      description: 'Propose ONE change to evolve the engine. Call exactly once when ready.',
      input_schema: { type: 'object', properties: { target: { type: 'string' }, statement: { type: 'string' }, rationale: { type: 'string' }, argument: { type: 'string' }, predicted_component: { type: 'string', enum: ['binding', 'stall', 'integration'] }, edits: { type: 'array', items: { type: 'object' } } }, required: ['target', 'statement', 'edits'] },
    },
  ];

  const finish = (h) => { if (!h || !Array.isArray(h.edits) || !h.edits.length) return null; h.predicted = h.predicted_component || h.predicted; return h; };

  return {
    provider: 'live',
    tokensUsed() { return tokens; },
    tokenMax() { return TOKEN_MAX; },
    calls() { return calls; },
    exhausted() { return tokens >= TOKEN_MAX || calls >= budget; },
    extendBudget(extra) { TOKEN_MAX += (extra || tokenMax || 150000); },
    recordResult() {},

    async hypothesize({ traces, baseline, history, probe }) {
      if (this.exhausted()) return null;
      const hist = history.filter(h => h.state).slice(-6).map(h =>
        '- ' + (h.hypothesis ? h.hypothesis.target : '?') + ' → ' + h.state +
        (h.qualityDelta != null ? ' (Δ' + h.qualityDelta.toFixed(4) + (h.parity ? ', parity ' + (h.parity.clean ? 'clean' : h.parity.diffs + ' diffs') : '') + ')' : '') +
        (h.note ? ' — ' + h.note : '')).join('\n');
      const messages = [{ role: 'user', content: [
        renderTraces(traces, baseline), '',
        history.length ? 'PRIOR ATTEMPTS THIS RUN (learn from these — do not repeat a rejected or null move):\n' + hist : 'First hypothesis of the run.', '',
        'Investigate with probe_engine if useful, then call propose_change once.',
      ].join('\n') }];

      for (let round = 0; round <= PROBE_ROUNDS; round++) {
        if (this.exhausted()) break;
        const resp = await raw({ model: MODEL, max_tokens: 8000, system: SYSTEM, tools: TOOLS, thinking: { type: 'adaptive' }, messages });
        const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
        const propose = toolUses.find(t => t.name === 'propose_change');
        if (propose) return finish(propose.input);
        const probes = toolUses.filter(t => t.name === 'probe_engine');
        if (!probes.length) { const j = finish(parseJson(textOf(resp))); if (j) return j; break; }
        // preserve the assistant turn verbatim (incl. thinking blocks) for the tool-use round
        messages.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const p of probes) {
          let r; try { r = probe ? await probe(p.input) : { error: 'probe unavailable' }; } catch (e) { r = { error: String(e.message || e) }; }
          results.push({ type: 'tool_result', tool_use_id: p.id, content: JSON.stringify(r).slice(0, 2000) });
        }
        messages.push({ role: 'user', content: results });
      }
      // round cap hit without a proposal — one last no-tools ask for the JSON
      if (this.exhausted()) return null;
      messages.push({ role: 'user', content: 'Stop investigating and respond now with ONLY a JSON object: {"target","statement","rationale","argument","predicted_component","edits":[...]}.' });
      return finish(parseJson(textOf(await raw({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages }))));
    },

    async rubricScore(fx, grounded) {
      if (this.exhausted()) return null;
      const system = 'You are a strict reading-quality grader. Score 0.0–1.0 on this rubric, averaging four criteria each in [0,1]: (1) does the reading TRACE to the source, inventing no facts; (2) is the framing EPISTEMIC ("the reading", "the document carries") not ontological ("the text says X is true"); (3) does it CAPTURE what the document turns on; (4) does it AVOID inventing connections the source does not make. Respond with ONLY a JSON object {"score": NUMBER, "why": SHORT}.';
      const src = fx.doc.length > DOC_CAP ? fx.doc.slice(0, DOC_CAP) + '\n…[truncated]' : fx.doc;
      const user = 'RUBRIC FOCUS: ' + (fx.rubric_focus || fx.question || '(general)') + '\n\nSOURCE DOCUMENT:\n' + src + '\n\nTHE ENGINE\'S GROUNDED READING:\n' + grounded;
      const j = parseJson(await call({ system, user, maxTokens: 1024 }));
      return j && typeof j.score === 'number' ? Math.max(0, Math.min(1, j.score)) : null;
    },

    async talker(sys, userMsg) {
      if (this.exhausted()) return '';
      return await call({ system: sys, user: userMsg, maxTokens: 700 });
    },
  };
}

/* ---- factory ---- */
function create(opts = {}) {
  let provider = opts.provider || 'auto';
  if (provider === 'auto') provider = process.env.ANTHROPIC_API_KEY ? 'live' : 'offline';
  if (provider === 'live') return liveAgent({ budget: opts.budget != null ? opts.budget : 60, model: opts.model, maxRubricDocChars: opts.maxRubricDocChars, tokenMax: opts.tokenMax, maxProbeRounds: opts.maxProbeRounds });
  return offlineAgent();
}

module.exports = { create, observe, renderTraces };
