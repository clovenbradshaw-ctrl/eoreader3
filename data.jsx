/* ============================================================
   Cleon — configuration (not sample data).
   Models, the rule registry (auditable/exportable), example RAW text
   the engine parses live, and the rule-pack schema + authoring prompt.
   ============================================================ */

/* ---------------- local models (WebLLM / WebGPU) ---------------- */
const MODELS = [
  { id: 'qwen-05', name: 'Qwen2.5 0.5B', detail: '~350 MB · fastest', mlc: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC' },
  { id: 'qwen-15', name: 'Qwen2.5 1.5B', detail: '~900 MB · balanced', mlc: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' },
  { id: 'llama-1', name: 'Llama 3.2 1B', detail: '~700 MB', mlc: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' },
  { id: 'phi-35',  name: 'Phi 3.5 mini', detail: '~2.3 GB · smartest', mlc: 'Phi-3.5-mini-instruct-q4f16_1-MLC' },
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
    desc: 'A term your question names that appears nowhere in the sources resolves to the single void, citable as [⊥] — rather than being papered over with an invented answer.' },
  { id: 'two-voice', group: 'Chatting & grounding', phase: 'chat', name: 'Seeker / Talker Split', glyph: '⇉',
    layer: 'structure', mass: 9, src: 'core pack', installed: true, enabled: true, locked: false,
    desc: 'Two voices share the work: a seeker navigates the index (it sees the addresses), a talker phrases the answer (it never does). Keeps phrasing and provenance separable.' },
  { id: 'mode-policy', group: 'Chatting & grounding', phase: 'chat', name: 'Mode Policy (auto)', glyph: '◎',
    layer: 'structure', mass: 4, src: 'core pack', installed: true, enabled: true, locked: false,
    desc: 'Auto reads your question and composes only for creative asks; grounded never invents, even if asked; creative composes freely and is not fact-checked.' },
  { id: 'cross-check', group: 'Chatting & grounding', phase: 'chat', name: 'Source Cross-Check', glyph: '⇄',
    layer: 'significance', mass: 4, src: 'add-on', installed: false, enabled: false, locked: false,
    desc: 'When a table and a prose source are tagged together, a third pass compares them and flags disagreements instead of silently picking one.' },

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
];

const RULE_GROUPS = ['Languages', 'Parsing', 'Chatting & grounding', 'Medium constants'];

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
`You are authoring a rule pack for Cleon, an in-browser grounded document reader.
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

Object.assign(window, { MODELS, RULESETS, RULE_GROUPS, RULE_PACK_SCHEMA, AUTHOR_PROMPT, EXAMPLE_PACK, EXAMPLES });
