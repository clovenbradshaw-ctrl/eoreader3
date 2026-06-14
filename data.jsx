/* ============================================================
   Cleo — configuration (not sample data).
   Models, the rule registry (auditable/exportable), example RAW text
   the engine parses live, and the rule-pack schema + authoring prompt.
   ============================================================ */

/* ---------------- local models (WebLLM / WebGPU) ----------------
   Listed smallest-first: app.jsx defaults to the lightest entry (MODELS[0])
   on a fresh load, so the first item must stay the most mobile-friendly one.
   The "higher-end" tier below are full 7B–9B instruct models — far better at
   phrasing/synthesis, but they download GBs of weights and need a discrete
   GPU with the VRAM noted (a laptop iGPU will OOM). All `mlc` keys are exact
   entries in @mlc-ai/web-llm@0.2.79's prebuiltAppConfig (the pinned loader);
   bumping the version in llm.js is what unlocks newer ones.   */
const MODELS = [
  // light · run almost anywhere with WebGPU
  { id: 'qwen-05',  name: 'Qwen2.5 0.5B', detail: '~350 MB · fastest',     mlc: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC' },
  { id: 'qwen-15',  name: 'Qwen2.5 1.5B', detail: '~900 MB · balanced',    mlc: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' },
  { id: 'llama-1',  name: 'Llama 3.2 1B', detail: '~700 MB',               mlc: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' },
  // Llama 3.2 3B in q4f16_1: the desktop default. ~2.3 GB downloads once and
  // stays on disk via OPFS/IndexedDB; on Apple Silicon (and any GPU with
  // healthy fp16) the half-precision build runs faster and lighter than
  // q4f32_1 with no quality penalty worth noticing on a 3B model. The fp32
  // variant is kept around for hardware where fp16 misbehaves.
  { id: 'llama-3',     name: 'Llama 3.2 3B',         detail: '~2.3 GB · default · best balance of size and quality', mlc: 'Llama-3.2-3B-Instruct-q4f16_1-MLC' },
  { id: 'llama-3-f32', name: 'Llama 3.2 3B (fp32)',  detail: '~2.7 GB · for GPUs where fp16 misbehaves',              mlc: 'Llama-3.2-3B-Instruct-q4f32_1-MLC' },
  { id: 'qwen3-17', name: 'Qwen3 1.7B',   detail: '~2.0 GB · newer-gen',   mlc: 'Qwen3-1.7B-q4f16_1-MLC' },
  { id: 'phi-35',   name: 'Phi 3.5 mini', detail: '~2.3 GB',               mlc: 'Phi-3.5-mini-instruct-q4f16_1-MLC' },
  // higher-end · need a discrete GPU (multi-GB download, much stronger phrasing)
  { id: 'mistral-7', name: 'Mistral 7B',   detail: '~4.6 GB · needs 8 GB GPU',          mlc: 'Mistral-7B-Instruct-v0.3-q4f16_1-MLC' },
  { id: 'llama-8',   name: 'Llama 3.1 8B', detail: '~5.0 GB · needs 8 GB GPU',          mlc: 'Llama-3.1-8B-Instruct-q4f16_1-MLC' },
  { id: 'qwen-7',    name: 'Qwen2.5 7B',   detail: '~5.1 GB · needs 8 GB GPU',          mlc: 'Qwen2.5-7B-Instruct-q4f16_1-MLC' },
  { id: 'qwen3-8',   name: 'Qwen3 8B',     detail: '~5.7 GB · newest · needs 8 GB GPU', mlc: 'Qwen3-8B-q4f16_1-MLC' },
  { id: 'gemma2-9',  name: 'Gemma 2 9B',   detail: '~6.4 GB · highest quality',         mlc: 'gemma-2-9b-it-q4f16_1-MLC' },
  // on-device CPU · llama.cpp via WebAssembly (wllama) — NO WebGPU required, so
  // these run where the GPU models can't (Firefox/Safari) and stand in as the
  // automatic fallback when a GPU model stalls. Slower than the GPU tier, but
  // works anywhere; the GGUF downloads once from Hugging Face and is cached. The
  // `provider:'wllama'` + `wllama:` key routes them to the CPU backend in llm.js.
  // The tiny one is the automatic fallback: ~95 MB downloads in seconds and is
  // pre-fetched into wllama's OPFS cache on first launch, so a GPU stall swaps
  // over with no fetch — only wllama init. The Q8 variants are the same models
  // at higher precision: one click for noticeably better phrasing, slower on
  // the CPU but a modest step up in download size. The 3B is the strongest
  // CPU option, on par with the GPU default if you don't have WebGPU.
  { id: 'cpu-smol-135',   name: 'SmolLM2 135M',                detail: '~95 MB · CPU · instant fallback',   provider: 'wllama', mlc: 'wllama:smollm2-135m' },
  { id: 'cpu-smol-360',   name: 'SmolLM2 360M',                detail: '~270 MB · CPU · fastest',           provider: 'wllama', mlc: 'wllama:smollm2-360m' },
  { id: 'cpu-qwen-05',    name: 'Qwen2.5 0.5B',                detail: '~400 MB · CPU · balanced',          provider: 'wllama', mlc: 'wllama:qwen25-05b' },
  { id: 'cpu-qwen-05-q8', name: 'Qwen2.5 0.5B (high quality)', detail: '~550 MB · CPU · Q8 — better words', provider: 'wllama', mlc: 'wllama:qwen25-05b-q8' },
  { id: 'cpu-llama-1',    name: 'Llama 3.2 1B',                detail: '~800 MB · CPU · capable',           provider: 'wllama', mlc: 'wllama:llama32-1b' },
  { id: 'cpu-llama-1-q8', name: 'Llama 3.2 1B (high quality)', detail: '~1.3 GB · CPU · Q8 — best words',   provider: 'wllama', mlc: 'wllama:llama32-1b-q8' },
  { id: 'cpu-llama-3',    name: 'Llama 3.2 3B',                detail: '~2.0 GB · CPU · strongest',         provider: 'wllama', mlc: 'wllama:llama32-3b' },
  // cloud · Anthropic (Claude) — needs an API key, runs no download, and works
  // without WebGPU. The `mlc` key carries an 'anthropic:' prefix so llm.js
  // routes it to the Claude API; the value after the colon is the exact model id.
  { id: 'claude-opus',   name: 'Claude Opus 4.8',   detail: 'Anthropic API · most capable',   provider: 'anthropic', mlc: 'anthropic:claude-opus-4-8' },
  { id: 'claude-sonnet', name: 'Claude Sonnet 4.6', detail: 'Anthropic API · balanced',       provider: 'anthropic', mlc: 'anthropic:claude-sonnet-4-6' },
  { id: 'claude-haiku',  name: 'Claude Haiku 4.5',  detail: 'Anthropic API · fast & low-cost', provider: 'anthropic', mlc: 'anthropic:claude-haiku-4-5' },
];

/* ---------------- the rule registry ----------------
   Every rule is a first-class, auditable object. `live:true` marks a
   rule the engine reads at runtime (toggling it changes how documents
   are read / answered). Weights are values on the RULE, never baked
   into a document's event log — they are applied at projection time.   */
const RULESETS = [
  // ── Languages (extraction) ──
  { id: 'en-narrative', group: 'Languages', phase: 'extraction', name: 'English Narrative', glyph: 'EN',
    layer: 'surface', mass: '∞', src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Speech verbs, pronoun gender, “X said / said X” attribution, capitalization as a proper-noun cue. The default reader for English prose.' },
  { id: 'tables', group: 'Languages', phase: 'extraction', name: 'CSV & Tables', glyph: 'TB',
    layer: 'surface', mass: '∞', src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Reads a header row as a schema and each row as a record. Drives the spreadsheet view and the pivot engine — no model touches the data.' },
  { id: 'es-narrative', group: 'Languages', phase: 'extraction', name: 'Spanish Narrative', glyph: 'ES',
    layer: 'surface', mass: 12, src: 'language pack', installed: true, enabled: false, locked: false,
    desc: 'Raya (—) dialogue with mid-quote attribution, guillemets, gendered articles, don/doña as lowercase name heads.' },
  { id: 'code', group: 'Languages', phase: 'extraction', name: 'Source Code', glyph: '{}',
    layer: 'surface', mass: 5, src: 'language pack', installed: true, enabled: false, locked: false,
    desc: 'A line is a sentence. Declaration is an insertion, assignment a definition, a call an edge between scopes.' },
  { id: 'zh-narrative', group: 'Languages', phase: 'extraction', name: 'Chinese Narrative', glyph: '中',
    layer: 'surface', src: 'language pack', installed: false, enabled: false, locked: false,
    desc: 'No case, no whitespace. Names are mined as repeated 2–4 character runs; speech attributes through the colon-quote slot.' },
  { id: 'transcript', group: 'Languages', phase: 'extraction', name: 'Transcripts & Captions', glyph: '⏱',
    layer: 'surface', mass: 8, src: 'genre pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Timecode lines and cue counters read as structure, never sentence content; “Speaker N:” / “NAME:” labels read as attribution through the same SIG slot quoted speech uses — a meeting reads as voices and turns, not a soup of stray capitals.' },

  // ── Parsing (extraction) ──
  { id: 'attribution', group: 'Parsing', phase: 'extraction', name: 'Attribution Induction', glyph: 'A→',
    layer: 'structure', mass: 47, src: 'core pack', installed: true, enabled: true, locked: false,
    desc: 'Learns speech verbs from the page’s own typography rather than a fixed list — whatever recurs in the quote-attribution slot is admitted after two sightings.' },
  { id: 'reconcile', group: 'Parsing', phase: 'extraction', name: 'Entity Reconciliation', glyph: '≡',
    layer: 'structure', mass: 23, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'A cold pass that merges surfaces pointing at one referent (Andrew / Prince Andrew) by token overlap. Turn it off to keep every surface distinct.' },
  { id: 'quote-weight', group: 'Parsing', phase: 'extraction', name: 'Quote-Interior Weighting', glyph: '“”',
    layer: 'significance', value: 0.4, mass: 8, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Mentions inside quoted speech warm a referent at this weight (0.4) instead of full — speech about someone is weaker presence than narration of them. Off ⇒ every mention counts equally.' },
  { id: 'anaphora-weight', group: 'Parsing', phase: 'extraction', name: 'Anaphora Coupling', glyph: '↩',
    layer: 'significance', value: 0.4, mass: 8, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Mass a pronoun BINDING deposits, at this weight (0.4) instead of full — a binding is an inference, not an observation, so it can’t count as full evidence for the next binding. Breaks the rich-get-richer loop that turns a heavy name into a black hole. Off ⇒ pronouns warm at full strength (the old runaway).' },
  { id: 'site-entity-cell', group: 'Parsing', phase: 'extraction', name: 'Entity Cell (Site face)', glyph: '⊞',
    layer: 'existence', value: 1, mass: 4, src: 'add-on', installed: false, enabled: false, locked: false, live: true,
    desc: 'Names the Site face’s (Existence, Figure) cell Entity — its proper name among the nine generated cells; the subtypes thing/person/place/org live beneath it, never in a site slot — and corrects the SIG/NUL Object coordinate: a stall or an unattributed quote reads Ground and lands on Void instead of defaulting into Entity. Off ⇒ today’s grid (cell labeled “Thing”), byte-identical.' },
  { id: 'distance-gravity', group: 'Parsing', phase: 'extraction', name: 'Distance Gravity (ACT-R)', glyph: '∝',
    layer: 'significance', value: 1, mass: 4, src: 'add-on', installed: false, enabled: false, locked: false, live: true,
    desc: 'Swaps the geometric clock (mass_weight × surface_mass + momentum) for a power law of recency over TOKEN distance: a candidate’s pull is Σ 1/(d+k)^α, d = cursor − each past surface mention (Anderson & Schooler 1991 — the memory that reads a power-law world matches it). Heavy-and-far vs light-and-near then falls out of the law instead of out of mass_weight, and a 60-word sentence ages the field more than a 5-word one (token distance, not the segmenter’s period count). The collision law (δ, floor, stall) is unchanged. Off ships today’s bindings byte-identical; takes effect on the next parse.' },

  // ── Chatting & grounding (chat) ──
  { id: 'auditor', group: 'Chatting & grounding', phase: 'chat', name: 'Grounded Auditor', glyph: '✓',
    layer: 'significance', mass: '∞', src: 'core pack', installed: true, enabled: true, locked: true, live: true,
    desc: 'Checks every answer against what was re-read: each claim on the page, every part of the question covered, the reading stable. Drives the badge under each answer.' },
  { id: 'cite-binding', group: 'Chatting & grounding', phase: 'chat', name: 'Citation Binding', glyph: 'sN',
    layer: 'significance', value: 0.34, mass: 6, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Minimum overlap a claim needs before a [sN] chip is stamped onto it. Citations are bound mechanically by the checker — never written by the model. Raise it for stricter provenance.' },
  { id: 'paraphrase', group: 'Chatting & grounding', phase: 'chat', name: 'Close-Paraphrase Acceptance', glyph: '≈',
    layer: 'significance', value: 0.74, mass: 6, src: 'core pack', installed: true, enabled: true, locked: false,
    desc: 'Accepts a reworded-but-faithful claim as grounded when its meaning matches a retrieved span closely enough. Lower it and the auditor demands near-verbatim support.' },
  { id: 'void', group: 'Chatting & grounding', phase: 'chat', name: 'Void Resolution [⊥]', glyph: '⊥',
    layer: 'significance', mass: 3, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'A term your question names that appears nowhere in the sources resolves to the single void, citable as [⊥] — rather than being papered over with an invented answer. The same move grounds true NEGATIVES: “never mentioned as a speaker” can’t cite a line (no single sentence supports a claim about the whole document), so it cites ⊥ with a scan receipt — every attribution event checked, the count in the chip.' },
  { id: 'inference-void', group: 'Chatting & grounding', phase: 'chat', name: 'Inference Void [∴]', glyph: '∴',
    layer: 'significance', mass: 3, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'The void inverted: marks what the READER ADDED. When a deep answer connects two cited spans the page never connects (an association that clears the inference floor), the claim is badged inferred — a third status between grounded and held — and shown as [sA+sB]. Off ⇒ such claims read as ordinary citations.' },
  { id: 'two-voice', group: 'Chatting & grounding', phase: 'chat', name: 'Seeker / Talker Split', glyph: '⇉',
    layer: 'structure', mass: 9, src: 'core pack', installed: true, enabled: true, locked: false,
    desc: 'Two voices share the work: a seeker navigates the index (it sees the addresses), a talker phrases the answer (it never does). Keeps phrasing and provenance separable.' },
  { id: 'mode-policy', group: 'Chatting & grounding', phase: 'chat', name: 'Mode Policy (auto)', glyph: '◎',
    layer: 'structure', mass: 4, src: 'core pack', installed: true, enabled: true, locked: false,
    desc: 'Auto reads your question and composes only for creative asks; grounded never invents, even if asked; creative composes freely and is not fact-checked.' },
  { id: 'cross-check', group: 'Chatting & grounding', phase: 'chat', name: 'Source Cross-Check', glyph: '⇄',
    layer: 'significance', mass: 4, src: 'add-on', installed: false, enabled: false, locked: false,
    desc: 'When a table and a prose source are tagged together, a third pass compares them and flags disagreements instead of silently picking one.' },
  { id: 'relation-gate', group: 'Chatting & grounding', phase: 'chat', name: 'Relation Gate', glyph: '⇋',
    layer: 'significance', value: 1, mass: 4, src: 'add-on', installed: false, enabled: false, locked: false, live: true,
    desc: 'The inversion fix. Provenance binds at generation (the model tags each claim with the span it used; the old binder serves only unkeyed claims), and every claim’s subject–predicate–object is checked against the relations the page deposited — a claim whose agency inverts against its edge (“the Association cannot afford” when the OWNERS pay), names the wrong speaker, or hangs the act on a figure the edge doesn’t carry is held and flagged, never waved through with a clean cite. Off ships today’s behavior byte-identical.' },
  { id: 'convention-proposals', group: 'Chatting & grounding', phase: 'chat', name: 'Convention Proposals', glyph: '✎',
    layer: 'structure', value: 3, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Lets the local model propose reading conventions from registered friction — repeated shapes the reading hit and could not consume (a “LABEL:” line bound to no speaker, a *** line read as a sentence). It proposes in one plain sentence citing engine-minted spans; it never commits: a proposal is a signal until an independent document or your one-tap Confirm corroborates it past the admission threshold (the model can never be its own witness). The value is the per-session proposal budget; runs only at idle and never blocks a turn. Review pending proposals in the Glass box.' },

  // ── Thinking depth (chat) — what the effort dial spends ──
  // Each rule's `value` is its CEILING (the value at the deepest setting); the
  // dial scales each knob from an inert floor up to it. At the lowest depth every
  // knob is inert, so the dial's floor is byte-identical to today. Tunable and
  // exportable like any rule (export the set as a "deep reading" profile).
  { id: 'max-seek-rounds', group: 'Thinking depth', phase: 'chat', name: 'Max Seek Rounds', glyph: '↻',
    layer: 'structure', value: 4, mass: 6, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Ceiling on iterative retrieval cycles a turn may run at the deepest setting. 1 = today’s single-pass reflex; higher lets a turn keep seeking on the parts of the question it hasn’t covered yet. The dial scales between 1 and this.' },
  { id: 'seek-novelty-floor', group: 'Thinking depth', phase: 'chat', name: 'Seek Novelty Floor', glyph: 'δⁿ',
    layer: 'significance', value: 0.15, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'A further seeking round must add at least this fraction of newly-covered query terms to justify itself; below it, stop. δ by another name — keep going only while the pull is real.' },
  { id: 'assoc-delta', group: 'Thinking depth', phase: 'chat', name: 'Association δ', glyph: '≈δ',
    layer: 'structure', value: 1.6, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Dominance ratio an embedding connection must clear to survive into working memory. Higher ⇒ only strong associative leaps; lower ⇒ more wandering. Floor depth ⇒ no wander.' },
  { id: 'assoc-coupling', group: 'Thinking depth', phase: 'chat', name: 'Association Coupling', glyph: '⇝',
    layer: 'significance', value: 0.6, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'How hard the wandering embedder-reader presses on the page (its reader coupling). Turning depth up raises it; the wanderer leans harder. Floor depth ⇒ it does not press.' },
  { id: 'wm-heat-floor', group: 'Thinking depth', phase: 'chat', name: 'Working-Memory Heat Floor', glyph: '♨',
    layer: 'significance', value: 0.25, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Heat threshold for what counts as “hot” in working memory. Depth widens the warm band (more carried-forward context) at the cost of prompt budget. Floor depth ⇒ nothing is carried hot.' },
  { id: 'infer-bind-floor', group: 'Thinking depth', phase: 'chat', name: 'Inference Bind Floor', glyph: '⊢',
    layer: 'significance', value: 0.62, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'How close an association must be before the system will phrase an inference across two spans and badge it “inferred”. Floor depth ⇒ never infer.' },
  { id: 'replan-enabled', group: 'Thinking depth', phase: 'chat', name: 'Reconsideration', glyph: '⟲',
    layer: 'structure', value: 1, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Whether a turn may reconsider its own plan (re-route / re-intent) after drafting. Only active at the deepest setting; off at low depth.' },
  { id: 'graph-walk-hops', group: 'Thinking depth', phase: 'chat', name: 'Graph Walk Hops', glyph: '⬡',
    layer: 'structure', value: 2, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'How many hops a turn may walk the document graph out from the entities the question names — the page’s assertions, its drawn relations, co-occurrence — gathering the sentences attached along the walk. Depth buys graph work, not just more retrieval. Floor depth ⇒ no walk (retrieval only).' },
  { id: 'assertion-check', group: 'Thinking depth', phase: 'chat', name: 'Propositional Veto', glyph: '⊨',
    layer: 'significance', value: 1, mass: 4, src: 'core pack', installed: true, enabled: true, locked: false, live: true,
    desc: 'Whether a draft is audited against the page’s own recorded assertions (DEF events) before it is kept — a draft that denies what the page asserts (“X was not Y” against DEF X is Y) is set aside with the disagreement named. Claim against claim, not string against string. Runs at EVERY depth: token-level checks certify a draft that recombines on-page names into a false proposition, and this is the check that catches it — the floor of what “grounded” means, not a luxury the dial buys.' },

  // ── Medium constants (locked physics) ──
  { id: 'two-sighting', group: 'Medium constants', phase: 'medium', name: 'Two-Sighting Admission', glyph: '2×',
    layer: 'existence', value: 2, mass: '∞', src: 'medium constant', installed: true, enabled: true, locked: true, live: true,
    desc: 'A single-token surface must be observed twice before it is admitted as an entity — filters sentence-initial capitalization artifacts.' },
  { id: 'decay-gamma', group: 'Medium constants', phase: 'medium', name: 'Momentum Decay γ', glyph: 'γ',
    layer: 'significance', value: 0.7, mass: '∞', src: 'medium constant', installed: true, enabled: true, locked: true,
    desc: 'Each referent’s momentum is multiplied by γ between sentences — recent mentions stay warm, old ones cool.' },
  { id: 'inertia-delta', group: 'Medium constants', phase: 'medium', name: 'Inertia δ', glyph: 'δ',
    layer: 'structure', value: 2.0, mass: '∞', src: 'medium constant', installed: true, enabled: true, locked: true,
    desc: 'Dominance ratio for resolution: the heaviest pull must be ≥ δ× the second pull to absorb, else the surfaces stall and the reader abstains. The SAME δ now gates pronoun binding — a contested “it”/“they”/“he” resolves to the void instead of forcing the heaviest wrong answer.' },
  { id: 'pronoun-floor', group: 'Medium constants', phase: 'medium', name: 'Pronoun Floor', glyph: '⊥p',
    layer: 'significance', value: 0.1, mass: '∞', src: 'medium constant', installed: true, enabled: true, locked: false, live: true,
    desc: 'Absolute floor on a winning pronoun-resolution score. Below it, nothing is warm enough to claim the pronoun and it resolves to the void rather than binding the best cold candidate. Companion to δ, giving the binder its right to say “I don’t know.”' },
  { id: 'eva-energy', group: 'Medium constants', phase: 'medium', name: 'Reading Energy', glyph: 'E',
    layer: 'significance', value: 1.0, mass: '∞', src: 'medium constant', installed: true, enabled: true, locked: true,
    desc: 'Energy each reading act carries. A reader’s attention deposit distributes exactly this much across a stall’s candidates — a flat (torn) read is physically inert.' },
  { id: 'gravity-alpha', group: 'Medium constants', phase: 'medium', name: 'Gravity Exponent α', glyph: 'α',
    layer: 'significance', value: 0.5, mass: '∞', src: 'medium constant', installed: true, enabled: true, locked: false, live: true,
    desc: 'Power-law exponent for Distance Gravity (only live when that rule is on). Inverse-square (α=2) is flux through a sphere in three dimensions; text is one-dimensional, so the empirically fitted human value is ≈0.5.' },
  { id: 'gravity-offset', group: 'Medium constants', phase: 'medium', name: 'Gravity Offset k', glyph: 'k',
    layer: 'structure', value: 20, mass: '∞', src: 'medium constant', installed: true, enabled: true, locked: false, live: true,
    desc: 'Softening offset (in tokens) for Distance Gravity (only live when that rule is on): pull = Σ 1/(d+k)^α. Keeps an intra-sentence mention from near-infinite pull; about a typical sentence length.' },
];

const RULE_GROUPS = ['Languages', 'Parsing', 'Chatting & grounding', 'Thinking depth', 'Medium constants'];

// The depth-governed rule ids, surfaced as their own tier in the rules drawer.
// Every turn runs at the deepest stop (thinkingBudget()'s ceiling), so these
// knobs are always live; their values are the ceilings the turn spends.
const DEPTH_IDS = ['max-seek-rounds', 'seek-novelty-floor', 'assoc-delta', 'assoc-coupling', 'wm-heat-floor', 'infer-bind-floor', 'replan-enabled'];

/* ---------------- the three tiers of the rules drawer ----------------
   Laws ≠ rules. The MEDIUM is the physics — the four binding-laws and their
   constants, language-independent and always on; you read them, you don't
   toggle them. LANGUAGE RULESETS are the ruliad — surface conventions that
   plug in and out per language, each in Original (shipped-only, frozen) or
   Self-learning (adaptive) mode. GROUNDING is the cross-cutting QA layer:
   how answers are cited and audited, not a language convention. The flat
   RULESETS list above still backs every card; these just regroup it. */

// Tier 1 — the medium: the four binding-laws (the layer ladder), read-only,
// in existence → structure → significance order, sign before proportion.
const MEDIUM_LAWS = [
  { layer: 'existence',    name: 'Confinement', glyph: '⊙',
    desc: 'The admission threshold. A surface must be sighted to admission before it exists as a referent at all — one binding-law freezes out here.' },
  { layer: 'structure',    name: 'Charge', glyph: '±',
    desc: 'Sign / polar exclusion. A referent carries a sign (gender); same sign repels, applied as a hard exclusion before any magnitude is weighed. The first of the structure pair.' },
  { layer: 'structure',    name: 'Gravity', glyph: 'δ',
    desc: 'Proportion — the δ dominance ratio. Among the survivors of the sign exclusion, the heaviest pull must out-pull the runner-up by δ or the field abstains to the void. Built on the poles.' },
  { layer: 'significance', name: 'Weak', glyph: '⚡',
    desc: 'Flavor change. The one law that changes an established type — a thing promoted to a person, an unknown made gendered. Everything else conserves type.' },
];
// The medium constants, shown as the laws' read-only parameters (RULESETS ids).
const MEDIUM_PARAM_IDS = ['two-sighting', 'inertia-delta', 'pronoun-floor', 'decay-gamma', 'eva-energy', 'quote-weight', 'anaphora-weight'];

// Tier 2 — language rulesets: one card per language. `lang` is the engine's
// language code (drives the per-language Original/Self-learning mode); `ruleId`
// is the backing RULESETS language rule (its enable toggle); `induces` marks the
// narrative languages that learn speech-verb conventions (the mode is inert for
// the others). `advanced` lists the shared parsing rules folded into the card.
const LANGUAGES = [
  { lang: 'en',   ruleId: 'en-narrative', name: 'English',      glyph: 'EN', induces: true,
    conventions: 'stopwords · pronouns & their gender · titles · “X said / said X” attribution · capitalization as a proper-noun cue' },
  { lang: 'zh',   ruleId: 'zh-narrative', name: 'Mandarin',     glyph: '中', induces: true,
    conventions: 'no case, no whitespace · names mined as repeated 2–4 character runs · colon-quote attribution' },
  { lang: 'es',   ruleId: 'es-narrative', name: 'Spanish',      glyph: 'ES', induces: true,
    conventions: 'raya (—) dialogue with mid-quote attribution · guillemets · gendered articles · don/doña as name heads' },
  { lang: 'code', ruleId: 'code',         name: 'JavaScript',   glyph: '{}', induces: false,
    conventions: 'a line is a sentence · declaration = insertion · assignment = definition · a call = an edge between scopes' },
  { lang: 'csv',  ruleId: 'tables',       name: 'CSV & Tables', glyph: 'TB', induces: false,
    conventions: 'header row = schema · each row = a record · drives the spreadsheet & pivot engine, no model touches the data' },
];
// Parsing rules shared by the narrative languages, surfaced in their advanced view.
const LANG_SHARED_PARSING = ['attribution', 'reconcile'];

// Tier 3 — grounding: cross-cutting QA conventions (RULESETS ids), chat phase.
const GROUNDING_IDS = ['auditor', 'cite-binding', 'paraphrase', 'void', 'inference-void', 'two-voice', 'mode-policy', 'cross-check', 'relation-gate'];

/* ---------------- rule-pack schema + LLM authoring prompt ---------------- */
const RULE_PACK_SCHEMA = {
  pack: 'my-pack-id',
  name: 'My Rule Pack',
  version: '1.0',
  group: 'Parsing',
  phase: 'extraction',
  rules: [
    {
      id: 'my-rule',
      name: 'My Rule',
      glyph: 'MR',
      group: 'Parsing',
      phase: 'extraction',
      layer: 'structure',
      value: null,
      desc: 'One sentence on what this rule does and what turning it off changes.',
    },
  ],
};

const AUTHOR_PROMPT =
`You are authoring a rule pack for Cleo, an in-browser grounded document reader.
A rule pack is a JSON object that adds installable, toggleable reading rules.

Return ONLY a JSON object with this exact shape:

{
  "pack": "kebab-case-id",
  "name": "Human Name",
  "version": "1.0",
  "group": "Languages" | "Parsing" | "Chatting & grounding",
  "phase": "extraction" | "chat",
  "rules": [
    {
      "id": "kebab-case-id",          // unique
      "name": "Human Name",
      "glyph": "≤2 chars or 1 symbol", // shown on the card
      "group": "Languages" | "Parsing" | "Chatting & grounding",
      "phase": "extraction" | "chat", // extraction = changes parsing; chat = changes answering
      "layer": "existence" | "structure" | "significance",
      "value": <number|null>,         // a weight/threshold the engine reads, or null
      "desc": "One sentence: what it does, and what turning it OFF changes."
    }
  ]
}

Rules of the medium:
- "phase":"extraction" rules shape what gets parsed (names, speech, segmentation).
- "phase":"chat" rules shape how answers are grounded, cited, and audited.
- A rule with a numeric "value" is read live at runtime; do not bake weights into documents.
- Keep each "desc" to one honest sentence. No marketing.
- Do NOT invent a "Medium constants" pack — those are locked physics.

Output the JSON only, no prose.`;

const EXAMPLE_PACK = JSON.stringify({
  pack: 'legal-en', name: 'Legal English', version: '1.0', group: 'Parsing', phase: 'extraction',
  rules: [
    { id: 'defined-terms', name: 'Defined-Term Capture', glyph: '§', group: 'Parsing', phase: 'extraction',
      layer: 'structure', value: null, desc: 'Treats a capitalized term in quotes followed by “means” as a defined entity; off ⇒ such terms are ordinary nouns.' },
    { id: 'party-roles', name: 'Party Role Binding', glyph: '⚖', group: 'Parsing', phase: 'extraction',
      layer: 'structure', value: null, desc: 'Binds role labels (Buyer, Seller, Licensor) to the party they were defined as; off ⇒ roles stay generic.' },
  ],
}, null, 2);

/* ---------------- example RAW text (parsed live by the engine) ---------------- */
const EXAMPLES = [
  {
    id: 'voss', name: 'The Lamp at Voss Point.txt', icon: 'book', label: 'A short story',
    text:
`The Lamp at Voss Point

The storm had been promising itself all afternoon, and by the time Edith reached the head of the stairs it had stopped pretending. She set the kettle down and listened. Below her, the keeper was already moving through the lower room, and she could hear Sefton arguing with him about the boat.

"You cannot row to the mainland tonight," the keeper said. "No one could."

"Marlow is on the mainland," Sefton answered, "and Marlow is expecting me." He said it as though that settled the matter, which, to Sefton, it did. Edith came down the last three steps and stood where the lamplight reached her.

"He will still be there in the morning," she said. "Harrow has never once been kind to a small boat, and Voss Point least of all." The keeper looked at her with something like gratitude, and Sefton, for the first time that evening, said nothing.

By midnight the wind had taken the shutter on the seaward side, and the three of them sat close to the lamp. Edith thought about Marlow, whom she had never met, waiting on the mainland with a lantern of his own.`,
  },
  {
    id: 'deals', name: 'meridian_q1_deals.csv', icon: 'table', label: 'A spreadsheet',
    text:
`deal_id,agent,region,closed,value,status
D-1042,Okonkwo,West,2026-01-09,84000,won
D-1043,Rhee,East,2026-01-15,51500,won
D-1044,Okonkwo,West,2026-01-28,127000,won
D-1045,Delgado,South,2026-02-02,39000,lost
D-1046,Rhee,East,2026-02-11,66000,won
D-1047,Beaumont,North,2026-02-19,142500,won
D-1048,Delgado,South,2026-02-24,47000,won
D-1049,Okonkwo,West,2026-03-03,98000,open
D-1050,Beaumont,North,2026-03-09,73000,won
D-1051,Rhee,East,2026-03-14,58000,open
D-1052,Delgado,South,2026-03-18,61000,won
D-1053,Beaumont,North,2026-03-22,119000,won
D-1054,Okonkwo,West,2026-03-27,156000,won
D-1055,Rhee,East,2026-03-31,44000,lost`,
  },
];

Object.assign(window, { MODELS, RULESETS, RULE_GROUPS, RULE_PACK_SCHEMA, AUTHOR_PROMPT, EXAMPLE_PACK, EXAMPLES,
  MEDIUM_LAWS, MEDIUM_PARAM_IDS, LANGUAGES, LANG_SHARED_PARSING, GROUNDING_IDS, DEPTH_IDS });
