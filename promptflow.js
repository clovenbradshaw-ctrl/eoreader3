/* ============================================================
   Prompt-flow registry (window.EOPromptFlow).

   The single, machine-readable description of HOW a user turn becomes (or
   doesn't become) a model call, and WHAT prompt the model sees when it does.
   It is the data behind the Prompt-flow dashboard (promptflow.jsx) and the
   prose map in docs/prompt-flows.md.

   The governing rule: derive, don't duplicate. Every prompt STRING is read
   live from llm.js — `EOLLM.systemFor(...)`, `EOLLM.SHAPE_SYSTEM`,
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
        label: 'Shape pass — system (the editor)',
        role: 'system',
        source: 'llm.js · SHAPE_SYSTEM',
        flowHint: 'grounded-llm (stage 1), repair (retry)',
        blurb: "The editor beside Cleo. Before the answer pass, it hands a one-breath director's note — what the user is after, what register fits, what a bad answer looks like. It never answers and never states document facts.",
        read: (L) => (Array.isArray(L.SHAPE_SYSTEM) ? L.SHAPE_SYSTEM.join('\n') : String(L.SHAPE_SYSTEM || '')),
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
      { id: 'shape.maxTokens', label: 'Shape-pass max tokens', value: 90, unit: 'tokens', source: 'llm.js · shapePass', live: false, note: 'Keeps the director\'s note to 2–4 sentences.' },
      { id: 'shape.temperature', label: 'Shape-pass temperature', value: 0.3, unit: '', source: 'llm.js · shapePass', live: false },
    ];
  }

  // ---- the shape pass: is its prompt actually fed to the model? --------------
  // The dashboard's headline question. `mlcKey` is the currently-selected model;
  // its TIER (read live from EOLLM.modelTier) decides whether the shape prompt
  // is sent at all. The note the shape pass returns is injected into the ANSWER
  // pass's user message by buildUserContent — we render a live sample of exactly
  // that so the "is it fed in?" answer is visible, not asserted.
  function shape(mlcKey) {
    const sys = live((L) => (Array.isArray(L.SHAPE_SYSTEM) ? L.SHAPE_SYSTEM.join('\n') : String(L.SHAPE_SYSTEM || '')), UNAVAILABLE);
    const tierRead = live((L) => L.modelTier(mlcKey), null);
    const tier = tierRead.ok ? tierRead.value : null;

    // A live render of the answer-pass USER message carrying a sample editor's
    // note — proof that, when active, the note IS handed to the answering model
    // (last block, just before "Answer the user's question").
    const sampleNote = "Bibliographic lookup. They want the name — pull it straight from the span; don't restate the question back at them.";
    const sample = live((L) => L.buildUserContent({
      question: 'who wrote it?',
      docTitle: 'The Time Machine',
      spans: [{ tag: 's12', text: 'The book was written by H. G. Wells and first published in 1895.' }],
      notesProse: 'A short scientific romance; the narrator is known only as the Time Traveller.',
      contextText: '',
      grounded: true,
      shapeNote: sampleNote,
    }), '');

    // Active ⇔ tier is capable/api AND a model is loaded. `null` tier means we
    // can't read it (EOLLM missing) — report indeterminate, not a false "yes".
    const active = tier == null ? null : tier !== 'small';

    return {
      system: { source: 'llm.js · SHAPE_SYSTEM', live: sys.ok, text: sys.value, why: sys.why || null },
      // Where the note lands in the next prompt (live sample of buildUserContent).
      lands: {
        source: 'llm.js · buildUserContent',
        live: sample.ok,
        sampleNote,
        sampleUserMessage: sample.value,
        // The marker the dashboard highlights inside the sample.
        noteMarker: "Editor's note on HOW to handle this turn",
      },
      gating: {
        model: mlcKey || null,
        tier,
        active,
        // The two-call shape of an ACTIVE turn.
        calls: [
          { n: 1, label: 'Shape pass', system: 'shape', produces: "an editor's note (2–4 sentences)", conditional: true },
          { n: 2, label: 'Answer pass', system: 'grounded', consumes: "the note, injected last in the user message", conditional: false },
        ],
        usedBy: ['grounded-llm (always, when active)', 'repair (model-phrased retry only)'],
        skippedBy: [
          "plain-chat, mechanical, creative, creative-compose, computation, confirm, dechrome, no-ground-fallback",
        ],
        // The live reasons the shape prompt is NOT fed to the model.
        skipReasons: [
          { id: 'small-tier', when: "modelTier(model) === 'small' (sub-2B local)", source: 'app.jsx:2366', meaning: "The small tier never free-composes. It runs runGroundedSmall instead: join-and-rephrase the already-bound mechanical reading over a cite set fixed before it speaks. No director's note — it is net-negative on a 0.5B and costs a second serial call. The audit records `shape · skipped`." },
          { id: 'no-model', when: 'no model loaded (isLoaded(model) false)', source: 'app.jsx:1852 · shapeFor', meaning: 'shapeFor returns an empty note; the answer pass runs with no editor\'s note.' },
          { id: 'failed', when: 'shapePass throws, or the note contains <think>, or strips to empty', source: 'app.jsx:1856–1875', meaning: 'Degrades to an empty note; the answer pass runs exactly as it would with no shape pass (parity).' },
        ],
        // What it MEANS when the note is empty on an otherwise-active path.
        whenInactive: "The grounded answer pass still runs — buildUserContent simply omits the editor's-note block — so the model composes the answer directly from the spans and notes, with no guidance about register or move. Nothing about grounding or citation binding changes; only the director's note is absent.",
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
        blurb: 'The largest flow: two stages, the full veto stack, the mechanical reading riding along.',
        calls: [
          { id: 'shape', label: 'Shape pass', prompt: 'shape', conditional: 'capable/api tier + model loaded', note: "produces the editor's note" },
          { id: 'answer', label: 'Answer pass', prompt: 'grounded', conditional: null, note: "editor's note injected last in the user message" },
        ],
        usesShapePass: true,
        vetoes: ['degeneracy', 'model-declined', 'shape-echo', 'meta-head', 'unbound', 'assertion', 'relation-gate', 'kin-subject', 'invented', 'envelope', 'small-join-only'],
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
          { id: 'shape', label: 'Shape pass', prompt: 'shape', conditional: 'model-phrased retry path only', note: 'on tagged history' },
          { id: 'answer', label: 'Answer pass', prompt: 'grounded', conditional: 'model-phrased retry path only', note: '+ repair addendum' },
        ],
        usesShapePass: true,
        vetoes: ['echoes-prior', 'model-declined', 'shape-echo', 'binding-stack'],
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
      { id: 'shape-echo', label: 'Shape-note echo', where: 'echoesShapeNote(full, shapeNote) / looksLikeNote', onMatch: 'Fall back to mechanical or refuse.' },
      { id: 'meta-head', label: 'Meta-head (WI-2)', where: 'peelMetaHead(full, shapeNote)', onMatch: 'Peel the leading meta clause, bind the tail; nothing left → residual / mechanical.' },
      { id: 'echoes-prior', label: 'Echo across turns', where: 'echoesPriorReply(text, prior)', onMatch: 'Flag "same answer as before" and keep.' },
      { id: 'unbound', label: 'Unbound (no passage matched)', where: 'binding audit grounded === false', onMatch: 'WI-4: residual (void target + bound subject material), else mechanical, else refuse — never the kept-unbound overclaim.', dominant: true },
      { id: 'assertion', label: 'Assertion contradiction', where: 'checkAssertionsScope', onMatch: 'Keep with caveat.' },
      { id: 'relation-gate', label: 'Relation-gate mismatch', where: 'checkRelationsScope (gate ON)', onMatch: 'Keep with caveat.' },
      { id: 'kin-subject', label: 'Kin-subject mismatch', where: 'checkKinSubjectsScope', onMatch: 'Keep with caveat.' },
      { id: 'invented', label: 'Invented terms', where: 'inventedTerms(full)', onMatch: 'Keep, strike with voidInvented, mark warn.' },
      { id: 'envelope', label: 'Grounding envelope drift', where: 'groundingEnvelope (embedder + gate)', onMatch: 'Mark binding warn.' },
      { id: 'small-join-only', label: 'Small-tier join-only (WI-6)', where: "tier === 'small' rephrase adds a token / invents / binds outside the fixed cite set", onMatch: 'Discard the rephrase, serve the mechanical reading.' },
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
        shape: shapeStep ? { skipped: !!shapeStep.skipped, tier: shapeStep.tier || null, hasNote: !!shapeStep.note } : null,
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
