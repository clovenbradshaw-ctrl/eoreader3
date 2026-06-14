/* ============================================================
   Prompt-flow registry (window.EOPromptFlow).

   The single, machine-readable description of HOW a user turn becomes (or
   doesn't become) a model call, and WHAT prompt the model sees when it does.
   It is the data behind the Prompt-flow dashboard (promptflow.jsx) and the
   prose map in docs/prompt-flows.md.

   The governing rule: derive, don't duplicate. Every prompt STRING is read
   live from llm.js — `EOLLM.systemFor(...)`,
   `EOLLM.buildUserContent(...)` — at the moment `snapshot()` runs. So when a
   prompt is edited in llm.js, the dashboard shows the new text with no edit
   here, and the visualization tracks the code automatically. The numbers
   (`DEFAULT_BUDGET`, `RECENT_TURNS`) are read live too.

   What CANNOT be derived live (the dispatcher's control flow and the two
   addenda that live as inline string literals in app.jsx) is DECLARED here,
   each marked `live:false` with its `source`, and pinned by a Node test
   (tests/promptflow.test.js) plus a runtime `drift()` check, so a change in
   llm.js that breaks an assumption here is caught rather than silently stale.

   Published as window.EOPromptFlow. Pure data + live reads; no model is ever
   loaded or called from this module. Safe to evaluate in Node (the test loads
   it in a vm context alongside llm.js and reads the registry back out).
   ============================================================ */
(function () {
  'use strict';

  const LLM = () => (typeof window !== 'undefined' && window.EOLLM) || null;

  // Run a live read against llm.js; never throw out into the dashboard. A
  // failed read becomes an explicit "(unavailable)" the drift check reports.
  function live(fn, fallback) {
    try {
      const L = LLM();
      if (!L) return { ok: false, value: fallback, why: 'EOLLM not loaded' };
      const v = fn(L);
      if (v == null || v === '') return { ok: false, value: fallback, why: 'empty' };
      return { ok: true, value: v };
    } catch (e) {
      return { ok: false, value: fallback, why: String((e && e.message) || e) };
    }
  }

  const UNAVAILABLE = '(prompt unavailable — EOLLM not loaded)';

  // ---- the live prompt inventory --------------------------------------------
  // Each entry's `text` is produced by CALLING the live llm.js function, so the
  // dashboard renders whatever the code says today. `variants` are the
  // conditional additions (the same system prompt under a different task / a
  // rule toggle), each resolved live and diffed against the base.
  function promptDefs() {
    return [
      {
        id: 'grounded',
        label: 'Grounded answer — system',
        role: 'system',
        source: 'llm.js · systemFor(grounded)',
        flowHint: 'grounded-llm, repair',
        blurb: 'The notes-and-spans contract: trust the verbatim spans, treat your own notes as usually-right, never write citation markers (those bind mechanically). One prompt replaced six near-duplicates.',
        read: (L) => L.systemFor('auto', 'qa', true, 1),
        variants: [
          {
            id: 'grounded.summary',
            label: '+ summary task',
            when: "task === 'summary'",
            blurb: 'One extra degeneracy-guard line: draw the spans together, never hand back a single span as the whole summary.',
            read: (L) => L.systemFor('auto', 'summary', true, 1),
          },
          {
            id: 'grounded.relation_gate',
            label: '+ relation gate ON',
            when: 'relation_gate rule enabled (off by default)',
            blurb: 'Provenance binds at generation: the model tags each claim with the span it used ([s12]); bindClaimKeysScope verifies each tag against its own span.',
            read: (L) => L.systemFor('auto', 'qa', true, 1, { provenanceKeys: true }),
          },
        ],
      },
      {
        id: 'plain',
        label: 'Plain chat — system',
        role: 'system',
        source: 'llm.js · systemFor(plain)',
        flowHint: 'plain-chat, no-ground-fallback',
        blurb: 'Ungrounded conversation. "You are a local open-weights model, not ChatGPT or Claude." Honest uncertainty over confident guessing; the condensed-recap caveat.',
        read: (L) => L.systemFor('auto', 'qa', false, 1),
        variants: [],
      },
      {
        id: 'creative',
        label: 'Creative compose — system',
        role: 'system',
        source: 'llm.js · systemFor(creative)',
        flowHint: 'creative, creative-compose',
        blurb: 'Free composition over supplied passages as raw material. Citations explicitly disabled.',
        read: (L) => L.systemFor('creative', 'qa', false, 1),
        variants: [],
      },
      {
        id: 'shape',
        label: 'The dissolved shape pass (no prompt — form is a measured stamp)',
        role: 'data',
        source: 'shape.js · formDegree',
        flowHint: 'grounded-llm (output measured, after)',
        live: false,
        blurb: "Brief 2 dissolved the blind shape-pass model call, and the form-as-stamp patch put the FORM out of the prompt entirely. There is no shape prompt: the MOVE is the router's intent, the FORM is a per-genre embedding centroid the OUTPUT is cosined against afterward (a stamp beside the witness degree, with a data-derived floor, a single structural-drift correction, and a learning update path), and the CONFIDENCE reads off the witness stamp. The talker writes voice-only; the centroid is never unfolded into prompt words.",
        text: 'There is no shape/form prompt. Form is measured on the output as a cosine against a per-genre centroid (shape.js · formDegree) and rides as a stamp — never handed to the talker.',
        variants: [],
      },
      // The two addenda below are inline string literals in app.jsx, not llm.js
      // exports — so they are DECLARED, not read live, and the drift check skips
      // them. They are appended to the grounded system prompt on their paths.
      {
        id: 'repair-addendum',
        label: 'Repair addendum (declared)',
        role: 'system-append',
        source: 'app.jsx · runRepairScope',
        flowHint: 'repair (model-phrased retry)',
        live: false,
        blurb: 'Appended to the grounded system on the repair retry path.',
        text:
          'The user has said your earlier replies missed their question — do not repeat any earlier reply; answer the question afresh from the spans and notes, and if they truly do not answer it, say exactly what they DO establish about the subject instead.',
        variants: [],
      },
      {
        id: 'degeneracy-addendum',
        label: 'Degeneracy-veto retry addendum (declared)',
        role: 'system-append',
        source: 'app.jsx · runGroundedScope retry',
        flowHint: 'grounded-llm (single-span echo retry)',
        live: false,
        blurb: 'Appended on the one degeneracy retry, after the first draft merely reworded a single span.',
        text:
          'Do NOT copy or lightly reword any single span. Compose a fresh [summary | answer] in your own words.',
        variants: [],
      },
    ];
  }

  function resolvePrompt(def) {
    if (def.live === false) {
      return {
        id: def.id, label: def.label, role: def.role, source: def.source,
        flowHint: def.flowHint, blurb: def.blurb, live: false,
        ok: true, text: def.text || '', variants: [],
      };
    }
    const base = live(def.read, UNAVAILABLE);
    const variants = (def.variants || []).map((v) => {
      const r = live(v.read, UNAVAILABLE);
      return {
        id: v.id, label: v.label, when: v.when, blurb: v.blurb,
        ok: r.ok, why: r.why || null, text: r.value,
        // The added lines, isolated by diffing against the base prompt.
        added: r.ok && base.ok ? diffAdded(base.value, r.value) : null,
      };
    });
    return {
      id: def.id, label: def.label, role: def.role, source: def.source,
      flowHint: def.flowHint, blurb: def.blurb, live: true,
      ok: base.ok, why: base.why || null, text: base.value,
      variants,
    };
  }

  // The lines a variant adds on top of the base prompt (set difference by line,
  // order-preserving). Used to show a relation-gate / summary toggle as a small
  // additive diff instead of a second full wall of text.
  function diffAdded(base, variant) {
    const baseLines = new Set(String(base).split('\n'));
    return String(variant).split('\n').filter((l) => l.trim() && !baseLines.has(l));
  }

  function prompts() { return promptDefs().map(resolvePrompt); }
  function promptById(id) { return prompts().find((p) => p.id === id) || null; }

  // ---- live parameters ------------------------------------------------------
  function params() {
    const L = LLM();
    const get = (k, d) => (L && L[k] != null ? L[k] : d);
    return [
      { id: 'DEFAULT_BUDGET', label: 'Assembled-context budget', value: get('DEFAULT_BUDGET', null), unit: 'tokens', source: 'llm.js', note: 'Leaves room for the reply on a 4096-token window.' },
      { id: 'RECENT_TURNS', label: 'Verbatim recent turns', value: get('RECENT_TURNS', null), unit: 'turns', source: 'llm.js', note: 'Older turns fold into a single index-tagged recap.' },
    ];
  }

  // ---- the dissolved shape pass: who holds each of its three jobs? -----------
  // Brief 2. The dashboard's old headline question — "is the shape prompt fed to
  // the model?" — no longer applies: there is no shape-pass model call. The note
  // that once welded three jobs together is dissolved, each going to the thing
  // that owns it. This reports the three holders, live, and shows the FORM cue
  // landing in the answer-pass message exactly as before (last block) — proof it
  // is handed in as STRUCTURE, with no model call generating it.
  function shape(mlcKey) {
    // The talker writes VOICE-ONLY: a live render of the answer-pass user message
    // proves there is NO how-to-answer block in it (the form never enters the
    // prompt — it is measured on the output afterward).
    const voiceOnly = live((L) => L.buildUserContent({
      question: 'what is this about?',
      docTitle: 'The Time Machine',
      spans: [{ tag: 's12', text: 'The book was written by H. G. Wells and first published in 1895.' }],
      notesProse: 'A short scientific romance; the narrator is known only as the Time Traveller.',
      contextText: '',
      grounded: true,
    }), '');
    const hasFormCapability = live((L) => true, false);   // shape.js holds it; reported as available

    return {
      // No per-turn model call generates how to answer. The verdict is fixed:
      // dissolved. (Kept as `gating.active = false` so any consumer that read the
      // old shape verdict sees an unambiguous "not a model call", never a yes.)
      dissolved: true,
      move: {
        holder: 'router', source: 'engine.js · classifyIntent', live: true,
        note: 'The MOVE (what kind of answer this is) is the router\'s intent — mechanical, auditable, decided upstream from the question alone.',
      },
      form: {
        holder: 'genre centroid (a stamp)', source: 'shape.js · formDegree / formFloor / depositForm', live: hasFormCapability.ok,
        note: 'The FORM is NOT handed to the talker — that would be steering. It is a per-genre embedding CENTROID the OUTPUT is measured against, after: a cosine stamp (formDegree) beside the witness degree. When the output sits below the genre\'s own typical fit (formFloor, data-derived) a single structural-drift correction (named axes, never the centroid) runs. The centroid stays a vector and updates from good outputs (depositForm, REC); it is never unfolded into prompt words.',
      },
      confidence: {
        holder: 'witness stamp', source: 'audit.js · truthfulness (WI-7)', live: true,
        note: 'The CONFIDENCE (how sure to sound) reads off the witness degree after the evidence is in — never assigned ahead by a note.',
      },
      // Proof the form does NOT enter the prompt: the answer-pass message is
      // voice-only (no how-to-answer block).
      lands: {
        source: 'llm.js · buildUserContent',
        live: voiceOnly.ok,
        voiceOnly: true,
        sampleUserMessage: voiceOnly.value,
        // There is no in-prompt form marker anymore.
        noteMarker: null,
      },
      gating: {
        model: mlcKey || null,
        // There is no shape-pass model call on any tier — `active:false` always.
        active: false,
        modelCall: false,
        note: 'Dissolved: no shape-pass model call on any tier. The talker writes voice-only from the witnessed spans; form is measured on the output as a stamp.',
      },
    };
  }

  // ---- the dispatcher cascade (DECLARED; first match wins) -------------------
  // Mirrors docs/prompt-flows.md §A. file:line are indicative (the code is the
  // truth); the flow names + predicates are the durable scaffolding.
  function dispatcher() {
    return [
      { n: 1, id: 'arith', label: 'Mechanical arithmetic', loc: 'app.jsx · runTurn', predicate: 'EOCompute.detect(q, scope) returns a math.js expression', outcome: 'Deterministic answer; no LLM', flow: 'calculation' },
      { n: 2, id: 'compute', label: 'Computational grounding (Python)', loc: 'app.jsx · runComputeScope', predicate: "mode ≠ 'creative', model ready, Python toggle on, tabular doc in scope", outcome: 'runComputeScope', flow: 'computation' },
      { n: 3, id: 'creative-toggle', label: 'Creative mode (toggle)', loc: 'app.jsx · runTurn', predicate: "mode === 'creative'", outcome: 'runChat(creative)', flow: 'creative' },
      { n: 4, id: 'creative-auto', label: 'Creative compose (auto)', loc: 'engine.js · isCreativeCompose', predicate: "mode === 'auto' && isCreativeCompose(q)", outcome: 'runChat(creative)', flow: 'creative' },
      { n: 5, id: 'forced-grounded', label: 'Forced grounded mode', loc: 'app.jsx · runTurn', predicate: "mode === 'grounded' && scope non-empty", outcome: 'synthetic mechanical route', flow: 'grounded-llm' },
      { n: 6, id: 'router', label: 'Cost-ordered router', loc: 'engine.js · routeTurn', predicate: 'scope non-empty → routeTurn(scope, q, ctx)', outcome: 'see routing table', flow: '(routeTurn)' },
      { n: 7, id: 'no-scope', label: 'No-scope chat', loc: 'app.jsx · runTurn', predicate: 'scope empty', outcome: 'synthetic chat route', flow: 'plain-chat' },
      { n: 8, id: 'repair', label: 'Repair', loc: 'app.jsx · runRepairScope', predicate: "route.decision === 'repair'", outcome: 'runRepairScope; marks prior reply', flow: 'repair' },
      { n: 9, id: 'escalate', label: 'Escalate (hybrid recall)', loc: 'app.jsx · runTurn', predicate: "route.decision === 'escalate'", outcome: 'retrieveHybrid then re-route', flow: 'escalate' },
      { n: 10, id: 'carry', label: 'Carry-grounded', loc: 'app.jsx · carryQuery', predicate: 'no semantic hits + prior carry + (continuity | question-no-lexical)', outcome: 'retrieve through prior material', flow: 'carry-grounded' },
      { n: 11, id: 'mechanical', label: 'Mechanical / grounded-LLM', loc: 'app.jsx · runGroundedScope / runMechanicalScope', predicate: "route.decision === 'mechanical'; useLLM = ready && primary is prose", outcome: 'runGroundedScope or runMechanicalScope', flow: 'grounded-llm' },
      { n: 12, id: 'chat', label: 'Plain chat (or unavailable)', loc: 'app.jsx · runChat', predicate: "route.decision === 'chat'", outcome: 'runChat', flow: 'plain-chat' },
    ];
  }

  // routeTurn's verdicts (docs/prompt-flows.md §A.6).
  function routing() {
    return [
      { reason: 'no-scope', predicate: 'no documents in scope', decision: 'chat' },
      { reason: 'command', predicate: "intent === 'command' (search/google/look-up imperatives)", decision: 'chat' },
      { reason: 'repair:*', predicate: "prior reply AND intent='factual' AND repairSignal(q)", decision: 'repair' },
      { reason: 'who / summary', predicate: "intent === 'who' | 'summary'", decision: 'mechanical' },
      { reason: 'pivot', predicate: 'parsePivot(q, d) non-empty', decision: 'mechanical' },
      { reason: 'table-column', predicate: 'question contains a known column name', decision: 'mechanical' },
      { reason: 'names-entity', predicate: 'namesEntity(d, q) true for any doc', decision: 'mechanical' },
      { reason: 'strong-lexical', predicate: 'retrieveScope hit score ≥ 0.5 or overlap ≥ 2', decision: 'mechanical' },
      { reason: 'weak-lexical', predicate: 'hits exist but below the strong threshold', decision: 'escalate' },
      { reason: 'antimatter-void', predicate: 'a named referent absent from every source', decision: 'mechanical' },
      { reason: 'continuity', predicate: 'continuesPrior(d, q, ctx) true', decision: 'mechanical' },
      { reason: 'question-no-lexical', predicate: 'wh-led question, zero lexical hits', decision: 'escalate' },
      { reason: 'no-signal', predicate: 'none of the above', decision: 'chat' },
    ];
  }

  // ---- the flow catalogue (DECLARED topology + LIVE prompt binding) ---------
  // Each flow names the prompt IDs it uses; the dashboard resolves the text live.
  // `calls` is the per-flow model-call pipeline — the "how prompts are triggered"
  // spine the dashboard draws.
  function flowDefs() {
    return [
      {
        id: 'grounded-llm', label: 'Grounded LLM', kind: 'llm',
        runner: 'runGroundedScope', reachedWhen: "route = mechanical AND primary is prose AND model ready",
        blurb: 'The largest flow: one model call (the shape pass is dissolved), the full veto stack, the mechanical reading riding along as evidence.',
        calls: [
          { id: 'answer', label: 'Answer pass', prompt: 'grounded', conditional: null, note: "the move's FORM cue (looked up, not generated) lands last in the user message" },
        ],
        usesShapePass: false,
        vetoes: ['degeneracy', 'model-declined', 'form-echo', 'meta-head', 'unbound', 'assertion', 'relation-gate', 'kin-subject', 'invented', 'envelope', 'small-flagged'],
        auditPath: 'grounded-llm',
      },
      {
        id: 'plain-chat', label: 'Plain chat', kind: 'llm',
        runner: 'runChat', reachedWhen: 'route = chat (no-scope, command, no-signal, failed escalate)',
        blurb: 'One ungrounded call. Retry once on a VRAM/context failure with the last 2 turns and a tighter budget.',
        calls: [{ id: 'chat', label: 'Chat', prompt: 'plain', conditional: null, note: 'full history with epistemic tags' }],
        usesShapePass: false,
        vetoes: ['plain-chat-failure'],
        auditPath: 'plain-chat',
      },
      {
        id: 'mechanical', label: 'Mechanical', kind: 'no-llm',
        runner: 'runMechanicalScope', reachedWhen: 'route = mechanical AND (no LLM ready OR primary is a table)',
        blurb: 'Zero model calls. answerScope produces the text directly; the model only ever phrases, and here it does not even do that.',
        calls: [],
        usesShapePass: false,
        vetoes: ['maybeRetract'],
        auditPath: 'mechanical',
      },
      {
        id: 'repair', label: 'Repair', kind: 'llm',
        runner: 'runRepairScope', reachedWhen: 'repairSignal matched (frustration / contradiction / refinement / support)',
        blurb: "Marks the prior reply objected, re-reads mechanically, and — if that is not clean — re-answers with the repair addendum on a tagged history.",
        calls: [
          { id: 'answer', label: 'Answer pass', prompt: 'grounded', conditional: 'model-phrased retry path only', note: '+ repair addendum; the move\'s FORM cue lands last' },
        ],
        usesShapePass: false,
        vetoes: ['echoes-prior', 'model-declined', 'form-echo', 'binding-stack'],
        auditPath: 'repair',
      },
      {
        id: 'creative', label: 'Creative compose', kind: 'llm',
        runner: 'runChat(creative)', reachedWhen: 'Creative toggle, or isCreativeCompose(q) (song/poem/story…)',
        blurb: 'One call over ungrounded passages. Citations explicitly disabled; no veto stack.',
        calls: [{ id: 'compose', label: 'Compose', prompt: 'creative', conditional: null, note: 'ungrounded passages, no [s##] tags' }],
        usesShapePass: false,
        vetoes: [],
        auditPath: 'creative',
      },
      {
        id: 'computation', label: 'Computation (Python)', kind: 'llm-tools',
        runner: 'runComputeScope', reachedWhen: 'tabular doc in scope, Python toggle on, model ready',
        blurb: 'A tool-loop: the model writes Python over the CSV schema; execution is local and every run is audited. The model phrases; the figure is mechanical.',
        calls: [{ id: 'tools', label: 'Tool loop', prompt: null, conditional: null, note: 'system assembled in runComputeScope; names the CSV columns + run_python tool' }],
        usesShapePass: false,
        vetoes: ['every-exec-audited'],
        auditPath: 'compute',
      },
      {
        id: 'escalate', label: 'Escalate', kind: 'transitional',
        runner: 'retrieveHybrid', reachedWhen: "route.decision === 'escalate' (weak-lexical / question-no-lexical)",
        blurb: 'Cost-ordered recall: lexical first, embeddings only when lexical is too weak. On hits → grounded-llm (recovered); on miss → plain chat.',
        calls: [],
        usesShapePass: false,
        vetoes: [],
        auditPath: '(hands off)',
      },
      {
        id: 'carry-grounded', label: 'Carry-grounded', kind: 'transitional',
        runner: 'carryQuery', reachedWhen: "no semantic hits + prior carry + (continuity | question-no-lexical)",
        blurb: 'Catches anaphoric follow-ups ("but why not?") by retrieving through the prior grounded turn\'s material. On hits → grounded-llm (carry); on miss → the original chat decision.',
        calls: [],
        usesShapePass: false,
        vetoes: [],
        auditPath: '(hands off)',
      },
      {
        id: 'no-ground-fallback', label: 'No-ground fallback', kind: 'llm',
        runner: 'runGroundedScope → runChat', reachedWhen: 'inside grounded-llm: hasGround === false (no lexical or semantic hit landed)',
        blurb: 'Plain chat over the same scope, with the mechanical reading still attached as a click-to-view panel. Audit: status plain, grounded false.',
        calls: [{ id: 'chat', label: 'Chat', prompt: 'plain', conditional: null, note: 'mechanical reading attached' }],
        usesShapePass: false,
        vetoes: [],
        auditPath: 'plain-chat',
      },
    ];
  }

  function flows() {
    const byId = {};
    for (const p of prompts()) byId[p.id] = p;
    return flowDefs().map((f) => ({
      ...f,
      calls: (f.calls || []).map((c) => ({
        ...c,
        promptResolved: c.prompt ? (byId[c.prompt] || null) : null,
      })),
    }));
  }

  // ---- veto / salvage lanes (docs/prompt-flows.md §E) -----------------------
  function vetoes() {
    return [
      { id: 'degeneracy', label: 'Degeneracy (single-span echo)', where: 'echoesASpan(scope, q, full)', onMatch: 'Retry once with the degeneracy addendum; refuse if the retry also echoes.' },
      { id: 'model-declined', label: 'Model declined', where: 'modelDeclined(full)', onMatch: 'Fall back to mechanical if usable, else refuse honestly.' },
      { id: 'form-echo', label: 'Form-cue echo', where: 'echoesShapeNote(full, formCue) / looksLikeNote', onMatch: 'Refuse / serve the stamped talker sentence — never the mechanical reading as the reply.' },
      { id: 'meta-head', label: 'Meta-head (WI-2)', where: 'peelMetaHead(full, formCue)', onMatch: 'Peel the leading meta clause, bind the tail; nothing left → residual on the talker sentence.' },
      { id: 'echoes-prior', label: 'Echo across turns', where: 'echoesPriorReply(text, prior)', onMatch: 'Flag "same answer as before" and keep.' },
      { id: 'unbound', label: 'Unbound (no passage matched)', where: 'binding audit grounded === false', onMatch: "WI-4 (Brief 1): serve the talker's OWN sentence as the residual — unsupported terms struck, absent target flagged, witness degree low — never the mechanical reading swapped in. status 'residual', so the unbound count stays 0.", dominant: true },
      { id: 'assertion', label: 'Assertion contradiction', where: 'checkAssertionsScope', onMatch: 'Keep with caveat.' },
      { id: 'relation-gate', label: 'Relation-gate mismatch', where: 'checkRelationsScope (gate ON)', onMatch: 'Keep with caveat.' },
      { id: 'kin-subject', label: 'Kin-subject mismatch', where: 'checkKinSubjectsScope', onMatch: 'Keep with caveat.' },
      { id: 'invented', label: 'Invented terms', where: 'inventedTerms(full)', onMatch: 'Keep, strike with voidInvented, mark warn.' },
      { id: 'envelope', label: 'Grounding envelope drift', where: 'groundingEnvelope (embedder + gate)', onMatch: 'Mark binding warn.' },
      { id: 'small-flagged', label: 'Small-tier join-only (WI-6)', where: "tier === 'small' rephrase adds a token / invents / binds outside the fixed cite set", onMatch: "Brief 1: serve the talker's rephrase with the additions struck (witness degree marks the gap); the mechanical reading rides as evidence, never as the reply." },
      { id: 'plain-chat-failure', label: 'Plain-chat failure', where: 'LLM call throws non-abort error', onMatch: 'Retry once with last 2 turns + tighter budget; honest error if it fails again.' },
    ];
  }

  // ---- history wrapping (epistemicTag, §F) ----------------------------------
  function historyWrapping() {
    return [
      { when: "mode === 'creative'", wrap: '[an earlier creative composition, not a document answer]' },
      { when: 'm.retracted', wrap: '[an earlier reply … RETRACTED — do not repeat or defend it]' },
      { when: 'm.objected (repair)', wrap: '[the user said this reply missed their question — do not repeat or defend it]' },
      { when: "audit.status === 'plain'", wrap: '[an earlier reply from general knowledge, not the document]' },
      { when: "audit.status === 'warn' && grounded", wrap: '[an earlier reply with unverified terms struck — do not repeat the struck parts]' },
      { when: 'audit.grounded === false', wrap: '[an earlier reply NOT verified against the document — do not repeat or defend its claims]' },
    ];
  }

  // ---- recent activity (LIVE, from the glass box) ---------------------------
  // The other half of "tied to reality": what actually fired. The audit records
  // path/reason per turn and the exact system+messages of each llm step. We read
  // it back (read-only) so the dashboard can show real fired prompts, not just
  // the ones that COULD fire.
  function activity(limit) {
    const A = (typeof window !== 'undefined' && window.EOAudit) || null;
    if (!A || typeof A.all !== 'function') return { available: false, turns: [] };
    let turns = [];
    try { turns = A.all() || []; } catch (e) { return { available: false, turns: [] }; }
    const out = turns.slice(-(limit || 12)).reverse().map((t) => {
      const steps = (t && t.steps) || [];
      const llmCalls = steps.filter((s) => s && s.t === 'llm').map((s) => ({
        mode: s.mode || (s.grounded ? 'grounded' : 'chat'),
        grounded: !!s.grounded,
        systemChars: typeof s.system === 'string' ? s.system.length : (Array.isArray(s.system) ? s.system.join('\n').length : null),
        params: s.params || null,
        skipped: !!s.skipped,
      }));
      const shapeStep = steps.find((s) => s && s.t === 'shape');
      return {
        id: t.id,
        path: (t.audit && t.audit.path) || t.path || null,
        reason: (t.audit && t.audit.reason) || t.reason || null,
        llmCalls,
        shape: shapeStep ? { generated: !!shapeStep.generated, move: shapeStep.move || null, form: shapeStep.form || null } : null,
      };
    });
    return { available: true, turns: out };
  }

  // ---- drift check ----------------------------------------------------------
  // The runtime guard that "tied to the actual structure" is still true: every
  // LIVE prompt must resolve to non-empty text, the live params must be present,
  // and modelTier must classify the canonical keys. Anything off is surfaced in
  // the dashboard (and pinned harder by tests/promptflow.test.js).
  function drift() {
    const issues = [];
    const L = LLM();
    if (!L) {
      issues.push({ level: 'error', id: 'no-eollm', msg: 'EOLLM is not loaded — prompts cannot be read live.' });
      return { ok: false, issues, checked: 0 };
    }
    const ps = prompts().filter((p) => p.live !== false);
    for (const p of ps) {
      if (!p.ok || !p.text || p.text === UNAVAILABLE) {
        issues.push({ level: 'error', id: 'prompt:' + p.id, msg: `Live prompt "${p.label}" did not resolve (${p.why || 'empty'}).` });
      }
      for (const v of p.variants || []) {
        if (!v.ok) issues.push({ level: 'warn', id: 'variant:' + v.id, msg: `Variant "${v.label}" did not resolve (${v.why || 'empty'}).` });
        else if (v.added != null && v.added.length === 0) issues.push({ level: 'warn', id: 'variant-noop:' + v.id, msg: `Variant "${v.label}" adds nothing over the base prompt — the conditional may have moved.` });
      }
    }
    for (const par of params().filter((x) => x.live !== false)) {
      if (par.value == null) issues.push({ level: 'warn', id: 'param:' + par.id, msg: `Live parameter "${par.label}" is missing from EOLLM.` });
    }
    // modelTier must still split small from large/api the way the dashboard
    // assumes — the headline shape-pass verdict depends on it.
    if (typeof L.modelTier === 'function') {
      const expect = [['anthropic:claude-x', 'api'], ['wllama:smollm2-135m', 'small'], ['Llama-3.2-3B-Instruct-q4f16_1-MLC', 'capable']];
      for (const [key, want] of expect) {
        let got = null; try { got = L.modelTier(key); } catch (e) {}
        if (got !== want) issues.push({ level: 'warn', id: 'tier:' + key, msg: `modelTier("${key}") = ${got}, dashboard assumed ${want}.` });
      }
    } else {
      issues.push({ level: 'error', id: 'no-modeltier', msg: 'EOLLM.modelTier is missing — the shape-pass verdict cannot be computed.' });
    }
    return { ok: issues.filter((i) => i.level === 'error').length === 0, issues, checked: ps.length };
  }

  // ---- the snapshot: one resolved tree the dashboard renders ----------------
  function snapshot(opts) {
    opts = opts || {};
    return {
      generatedAt: Date.now(),
      eollm: !!LLM(),
      params: params(),
      prompts: prompts(),
      dispatcher: dispatcher(),
      routing: routing(),
      flows: flows(),
      shape: shape(opts.mlcKey),
      vetoes: vetoes(),
      historyWrapping: historyWrapping(),
      activity: opts.withActivity === false ? { available: false, turns: [] } : activity(opts.activityLimit),
      drift: drift(),
    };
  }

  const EOPromptFlow = {
    snapshot, prompts, promptById, params, shape, dispatcher, routing,
    flows, vetoes, historyWrapping, activity, drift,
  };

  if (typeof window !== 'undefined') window.EOPromptFlow = EOPromptFlow;
  if (typeof module !== 'undefined' && module.exports) module.exports = EOPromptFlow;
})();
