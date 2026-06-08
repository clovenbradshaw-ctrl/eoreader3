/* ============================================================
   Cleon reading engine — the real EO graph extractor.

   Ported from eo-extractor.html: the language packs, the rules
   ledger, extractEoGraph (the nine EO operators — NUL/SIG/INS/
   SEG/CON/SYN/DEF/EVA/REC), and projectGraph (events → entities).
   A thin adapter at the bottom maps the graph to the doc / entity /
   QA shapes the Cleon UI consumes, and keeps the mechanical
   retrieval, coverage, void, and citation-binding paths.

   CONTRACT, unchanged: parsing stores only invariants (the event
   log). Mass, momentum, and the entity view are PROJECTED at runtime
   from the log under the current rules — change a rule, re-project,
   no re-parse.

   Depends on global `nlp` (compromise.js), loaded before this file.
   ============================================================ */
(function () {
  'use strict';

  /* ---- QA-side helpers: retrieval / coverage / citation binding ----
     A compact stoplist used only by the question-answering paths
     (retrieve, coverage, void detection). The extractor has its own,
     richer, rule-driven stop sets (STOP, PRONOUNS, …) defined below. */
  const QA_STOP = new Set(('a an the and or but if then else for of to in on at by with from into over under '
    + 'is are was were be been being am do does did doing have has had having will would shall should can could '
    + 'may might must not no nor so than too very just only also this that these those it its it\'s he she they '
    + 'him her them his hers their there here who whom which what when where why how as up out off down about '
    + 'again further once more most some any all each few other such own same one two i we you us me my your our '
    + 'said say says tell about above below between through during before after').split(/\s+/));

  // Possessives are stripped to their root ("edith's" → "edith") so a question
  // about "Edith's car" matches the document's "edith" token. Without this, the
  // possessive surface never equals the bare entity token and a question about
  // the document's own characters misroutes to ungrounded chat. (1a)
  const tok = (s) => (String(s).toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || [])
    .map(t => t.replace(/['’]s$/, ''))
    .filter(t => t.length > 2 && !QA_STOP.has(t));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* ============================================================
     ===============  REAL ENGINE (ported verbatim)  ============
     ============================================================ */
const DISCOURSE_JUNK = new Set([
  'today','yesterday','tomorrow','now','then','here','there','meanwhile',
  'however','moreover','furthermore','therefore','also','still','yet',
  'according','reportedly','apparently','allegedly',
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'january','february','march','april','may','june','july','august',
  'september','october','november','december',
  // Stopwords that compromise sometimes mis-tags as proper nouns at sentence start
  'not','almost','because','while','since','although','though',
]);

// ── READING_RULES: the rules of reading made auditable ───────────
// Every rule the reader applies is a first-class object: it has mass
// (count of confirmations), provenance (where it came from), an EO
// layer (existence / structure / significance), and a description.
//
// Holonically: the rules themselves obey the EO triad. They exist
// (rules in the ledger), they cluster structurally (lexical / physics /
// shape), and they have significance (mass and dominance). Rules with
// mass=Infinity are constants of the medium — like γ, like c. Rules
// with finite mass started as hardcoded seeds and can be revised as
// the system reads more text and accumulates corrections.
//
// The reading system improves by accumulating mass on rules that are
// confirmed and demoting rules that user SEGs imply are wrong. For
// now, this object is read-only and visible in the Rules tab so the
// reader can see WHAT it knows about reading — the meta-layer made
// transparent before the learning loop is wired up.
// ── Language modules registry ─────────────────────────────────────
//
// EO's core reading dynamics — mass, momentum, decay, gravity-based
// SYN, signal birth/collapse, the nine operators — are language-
// universal: they describe how any cognition tracks referents across
// surface mentions. The lexical, syntactic, and typographic
// conventions are NOT universal: speech verbs ("said"), pronouns ("he"),
// gender mapping, capitalization-as-proper-noun-cue, quote marks,
// clitic suffixes, attribution patterns ("X said" vs "said X"), titles
// (Princess/Mr/Lady), adverbial heads — all of this lives at the
// language and genre level.
//
// The English narrative module bundles everything English-and-novel-
// specific into one disable-able unit. Disable it and the core still
// runs: INS, SYN by gravity over normalized surface tokens, mass
// accumulation, the event log. What stops working: attribution parsing
// (no speech verb list), pronoun gender resolution (no he/she mapping),
// title-based gender (no Princess→f), English contraction rejection,
// English stopword filtering.
//
// Future modules: ru-narrative (Russian patronymics, Cyrillic case-
// less proper nouns, different quote marks « »), zh-narrative (no
// capitalization signal, different attribution conventions), de-formal
// (German noun capitalization breaks the capital-first heuristic), etc.
// Surface detectors per language. Each pack supplies ONLY how this
// language marks names, speech, pronouns, and boundaries. The grammar —
// the nine operators plus scope, replacement, and exeunt — is the core
// and is shared. Code is a pack like any other, which is the proof.
const LANG_PACKS = {
  es: {
    id: 'es-narrative-v1', name: 'Spanish Narrative Conventions', language: 'es',
    rules: {
      pronouns: ['él', 'ella', 'ellos', 'ellas', 'le', 'les', 'lo', 'la', 'los', 'las', 'se', 'me', 'te', 'nos', 'os', 'yo', 'tú', 'usted', 'ustedes', 'quien', 'quienes'],
      person_pronouns: ['él', 'ella', 'le', 'quien', 'quienes', 'usted'],
      nonperson_pronouns: ['lo', 'eso', 'esto', 'aquello'],
      female_pronouns: ['ella', 'ellas'],
      male_pronouns: ['él', 'ellos'],
      female_titles: ['doña', 'señora', 'señorita', 'reina', 'princesa', 'duquesa', 'condesa', 'sor'],
      male_titles: ['don', 'señor', 'rey', 'príncipe', 'duque', 'conde', 'fray', 'capitán'],
      title_tokens: ['don', 'doña', 'señor', 'señora', 'señorita', 'fray', 'sor', 'rey', 'reina', 'príncipe', 'princesa', 'duque', 'duquesa', 'conde', 'condesa', 'capitán', 'general', 'caballero'],
      base_stopwords: ['que', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero', 'porque', 'como', 'cuando', 'donde', 'muy', 'más', 'menos', 'también', 'todo', 'toda', 'todos', 'todas', 'este', 'esta', 'ese', 'esa', 'aquel', 'aquella', 'con', 'sin', 'por', 'para', 'sobre', 'entre', 'hasta', 'desde', 'había', 'fue', 'era', 'ser', 'estar', 'hay', 'sus', 'del', 'al'],
      function_words: ['otro', 'otra', 'otros', 'otras', 'cada', 'mucho', 'mucha', 'muchos', 'muchas', 'poco', 'poca', 'algunos', 'algunas', 'varios', 'varias', 'ambos'],
      articles: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
      adverb_heads: ['cuando', 'mientras', 'aunque', 'porque', 'si', 'donde', 'como', 'pues', 'luego', 'entonces', 'antes', 'después'],
      prep_lead_disqualify: ['en', 'de', 'a', 'por', 'para', 'con', 'sin', 'sobre', 'entre', 'hacia', 'hasta', 'desde', 'contra', 'según', 'durante', 'tras', 'ante', 'bajo'],
      pronoun_lead_disqualify: ['su', 'sus', 'mi', 'mis', 'tu', 'tus', 'nuestro', 'nuestra', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'otro', 'otra', 'cada', 'todo', 'toda', 'algunos', 'muchas', 'muchos'],
      name_connectors: ['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e'],
      clitic_suffixes: [],
      quote_pairs: [['\u00AB', '\u00BB'], ['\u201C', '\u201D'], ['"', '"']],
      promote_requires_uppercase_first: true,
    },
    name_prefix_lower: ['don', 'doña', 'fray', 'sor'],
    dash_dialogue: true,
    desc: 'Spanish narrative: raya (—) dialogue with mid-quote attribution inserts, guillemets, gendered articles, don/doña as lowercase name heads. Attribution verbs induce from the dash slot.',
  },
  zh: {
    id: 'zh-narrative-v1', name: 'Chinese Narrative Conventions', language: 'zh',
    rules: {
      pronouns: ['他', '她', '它', '他们', '她们', '它们', '我', '你', '您', '我们', '你们', '咱们', '自己'],
      person_pronouns: ['他', '她', '他们', '她们', '您', '你', '我'],
      nonperson_pronouns: ['它', '它们', '这', '那'],
      female_pronouns: ['她', '她们'],
      male_pronouns: ['他', '他们'],
      female_titles: [], male_titles: [], title_tokens: [],
      base_stopwords: [], function_words: [], articles: [],
      adverb_heads: [], prep_lead_disqualify: [], pronoun_lead_disqualify: [],
      name_connectors: [], clitic_suffixes: [],
      quote_pairs: [['\u201C', '\u201D'], ['\u300C', '\u300D'], ['\u300E', '\u300F']],
      promote_requires_uppercase_first: false,
    },
    // High-frequency function characters: a candidate name containing
    // any of these is structure, not a site.
    function_chars: '的了是在和与就都也又被把不这那您吗呢吧啊很太没么哪并且或者如果但因为所以然后还已经只能可以个一二两三上下中出来去到说着过给对从向最为之其于以及即使虽然',
    colon_attribution: true,
    desc: 'Chinese narrative: no case, no whitespace. Names are mined as repeated 2-4 character sequences (the two-sighting rule, generalized). Speech attributes through the colon-quote slot (说：「…」). Pronoun speakers resolve through prior subject position.',
  },
  code: {
    id: 'code-v1', name: 'Code Conventions', language: 'code',
    rules: {
      pronouns: [], person_pronouns: [], nonperson_pronouns: [], female_pronouns: [], male_pronouns: [],
      female_titles: [], male_titles: [], title_tokens: [],
      base_stopwords: [], function_words: [], articles: [],
      adverb_heads: [], prep_lead_disqualify: [], pronoun_lead_disqualify: [],
      name_connectors: [], clitic_suffixes: [],
      quote_pairs: [['"', '"'], ["'", "'"], ['`', '`']],
      promote_requires_uppercase_first: false,
    },
    desc: 'Code as text. A line is a sentence. Declaration is INS; assignment is DEF (replacement); a call is a clause edge from the enclosing scope; a scope is a scene. A binding is on stage from declaration until shadowed or scope exit — the stage semantics are not a metaphor here, they are the language.',
  },
};
let ACTIVE_LANG = 'en';
function detectLanguage(text) {
  const s = String(text);
  const sample = s.slice(0, 6000);
  let han = 0, total = 0;
  for (const ch of sample) { if (/\s/.test(ch)) continue; total++; if (/[\u4e00-\u9fff]/.test(ch)) han++; }
  if (total > 0 && han / total > 0.05) return 'zh';
  const lines = sample.split('\n');
  const codey = lines.filter(l => /[{};]\s*$|^\s*(function|const|let|var|class|def|import|return|if\s*\(|for\s*\()\b|=>/.test(l)).length;
  if (codey >= 3 && codey / Math.max(1, lines.filter(l => l.trim()).length) > 0.25) return 'code';
  // Spanish only on genuinely Spanish-exclusive signal: ñ or inverted
  // punctuation are near-unique; otherwise require several Spanish
  // function words that are NOT English homographs. "don" is excluded —
  // it matches inside "don't" — and é/ü alone are loanword noise.
  // CSV: several rows of consistent comma-delimited fields. Prose has
  // irregular comma counts; a table does not.
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length >= 3) {
    const counts = nonEmpty.map(l => (l.match(/,/g) || []).length);
    const mode = counts.slice().sort((a, b) => counts.filter(x => x === a).length - counts.filter(x => x === b).length).pop();
    if (mode >= 1 && counts.filter(c => c === mode).length / counts.length >= 0.7) return 'csv';
  }
  if (/[ñ¿¡]/.test(sample)) return 'es';
  const esWords = (sample.match(/\b(que|los|las|una|unos|unas|pero|porque|más|está|están|fueron|había|señor|señora|también|cuando|donde|hacia|desde|del|sus|eso|esa|esto|aquella|caballero)\b/gi) || []).length;
  if (esWords >= 5) return 'es';
  return 'en';
}
// Structured sources declare their relations; unstructured ones withhold
// them. The mode decides whether the inference apparatus engages.
function modeForLang(lang) { return (lang === 'csv' || lang === 'json' || lang === 'html' || lang === 'code') ? 'structured' : 'unstructured'; }

const LANGUAGE_MODULES = {
  'en-narrative-v1': {
    id: 'en-narrative-v1',
    name: 'English Narrative Conventions',
    version: '1.0',
    applies_to: { language: 'en', mode: 'narrative_fiction' },
    enabled: true,
    provides: [
      'attribution_patterns',
      'pronouns', 'person_pronouns', 'nonperson_pronouns',
      'female_pronouns', 'male_pronouns',
      'female_titles', 'male_titles', 'title_tokens',
      'base_stopwords', 'function_words',
      'clitic_suffixes', 'adverb_heads', 'name_connectors',
      'prep_lead_disqualify', 'pronoun_lead_disqualify',
      'articles', 'quote_pairs',
      'continuation_inheritance',
    ],
    desc: 'Lexical and syntactic rules for English-language fiction. Speech verbs, pronouns with binary gender encoding, English clitic contractions, capitalization as proper-noun cue, "X said"/"said X" attribution patterns, same-sentence continuation inheritance. Disable when reading non-English text or non-narrative text.',
  },
};

// ── Reader registry ───────────────────────────────────────────────
// Bodies in the medium. There is no judge standing outside the field:
// every evidence source — token gravity, the embedding cold pass, the
// in-browser LLM, the human — is a READER whose attention deposits
// energy under the same law and submits to the same δ. A reader's
// coupling constant scales its deposits. Coupling is not authority;
// it is how hard this reader presses on the page.
//
// Calibration is mechanical and lives in the ledger: joins later
// overturned by SEG count against the reader that pressed for them,
// and REC events shrink the coupling of readers whose deposits keep
// preceding corrections. The medium disciplines its instruments —
// all of them by the same procedure.
const READER_REGISTRY = {
  gravity: {
    id: 'gravity', kind: 'heuristic', coupling: 1.0, adjustable: false,
    desc: 'Inline token-gravity reader. Deposits via mention touches during the warm pass; F = (mass + momentum) × token-overlap, resolved under δ.',
  },
  embedder: {
    id: 'embedder', kind: 'model', coupling: 1.0, adjustable: true,
    desc: 'MiniLM cold-pass reader. Joins decayed sites by token Jaccard with embedding-centroid confirmation.',
  },
  llm: {
    id: 'llm', kind: 'model', coupling: 0.6, adjustable: true,
    desc: 'Generative reader (Qwen 0.5B, in-browser, automatic). Reads each stalled sentence and deposits a NORMALIZED attention distribution over the stall\'s candidates (EVA). Conservation makes a torn (flat) read physically inert. It never resolves anything itself — the re-collision under δ does.',
  },
  human: {
    id: 'human', kind: 'human', coupling: 5.0, adjustable: false,
    desc: 'The heaviest body in the medium. Manual merges and SEG splits are very-high-coupling deposits, not exceptions to the physics.',
  },
  sentinel: {
    id: 'sentinel', kind: 'heuristic', coupling: 0.8, adjustable: true,
    desc: 'Production supervisor. Watches the system\u2019s own output as it is made \u2014 draft against draft, draft against goal, and draft against the source when the piece stands in for one \u2014 and stops the loop with a spoken reason when another pass would only repeat. The trips are mechanical (overlap, budget, stalled error); its one model verdict per turn deposits at this coupling like any other reader\u2019s.',
  },
};

const READING_RULES = {
  // ── Medium constants — the physics of reading itself ──
  decay_gamma: {
    value: 0.7, mass: Infinity, layer: 'significance', src: 'medium-constant', module: 'core',
    desc: 'Momentum decay rate per sentence. Each site\'s momentum is multiplied by γ between sentences — recent mentions stay warm, old mentions cool.',
  },
  inertia_delta: {
    value: 2.0, mass: Infinity, layer: 'structure', src: 'medium-constant', module: 'core',
    desc: 'Dominance ratio for gravitational collision. If the heaviest pull is ≥ δ × the second pull, it absorbs; otherwise the surfaces stall and NUL fires. The SAME δ gates re-collisions after EVA deposits — no reader gets a different law.',
  },
  eva_energy_budget: {
    value: 1.0, mass: Infinity, layer: 'significance', src: 'medium-constant', module: 'core',
    desc: 'Energy each reading act carries. An EVA deposit distributes exactly this much momentum across a stall\'s candidates, scaled by the reader\'s coupling. Conservation gives abstention for free: a flat distribution deposits everywhere equally and changes no relative pull.',
  },
  quote_interior_coupling: {
    value: 0.4, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Weight on mentions that occur inside quoted speech. Speech ABOUT someone is weaker presence than narration of them: a quote-interior mention warms the site at this coupling, not full strength. Events carry only the invariant in_quote flag; the weight is read live from this rule at replay, so a REC retuning it re-derives all historical quote-interior physics. Also the basis of the named-arrival gate: a name arriving inside a quote cannot consume a signal born from narration pronouns.',
  },
  two_sighting_admission: {
    value: 2, mass: Infinity, layer: 'existence', src: 'medium-constant', module: 'core',
    desc: 'Single-token surfaces must be observed twice before admission, to filter sentence-initial capitalization artifacts.',
  },

  // ── Lexical filters — sourced from the active language module ──
  base_stopwords: {
    value: ['the','and','for','are','with','that','this','from','what','when','where','how','who','why','have','has','was','were','will','can','could','would','should','please','tell','about','any','their','them','they','some','all','into','than','then','also','been','very','just','more','most','such','say','said','its','our','your','his','her','one','two','only','over','under','out','here','there','these','those','which','while','same','each','because','being','does','did','doing','done','having','make','made','give','given','take','took','use','used','using','need','want','know','think','show','found','find'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Common English function words and auxiliaries. Not identity-bearing.',
  },
  title_tokens: {
    value: ['prince','princess','count','countess','king','queen','lord','lady','mr','mrs','miss','sir','dame','lieutenant','captain','colonel','major','general','admiral','emperor','empress','tsar','czar','duke','duchess','earl','baron','baroness','governor','mayor','president','dr','prof','professor'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Titles of rank or address. Sharing a title alone is not identity — Prince Andrew ≠ Prince Bagratión.',
  },
  sentence_abbreviations: {
    value: ['mr','mrs','ms','mx','dr','prof','rev','fr','hon','capt','col','gen','sgt','cpl','lt','sr','jr','st','mt','messrs','mlle','mme'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Abbreviations whose trailing period does NOT end a sentence (a title before a name: "Dr." , "Mr."). The segmenter rejoins a sentence cut after one of these so a citation never lands mid-name. Lives here in the ruliad — extend, export, or disable it like any reading rule — rather than being hardcoded in the segmenter. Short forms only (never sentence-final); the full words live in title_tokens.',
  },
  function_words: {
    value: ['own','much','many','few','less','every','another','other','both','either','neither','several','various'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Determiners and quantifiers. Pass the length-3 substantive filter but carry no identity.',
  },
  pronouns: {
    value: ['he','she','it','they','him','her','them','his','hers','its','their','theirs','this','that','these','those','who','whom','i','we','you','us','me'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Pronouns. Bind by type/momentum (working memory), not by shared substantive tokens.',
  },
  anaphor_pronouns: {
    value: ['he','she','it','they','him','her','them','his','hers','its','their','theirs'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Third-person personal pronouns — the anaphors that carry a topic across turns. Routing reads this class for conversation continuity: a follow-up like "tell me more about it" continues the previous grounded turn. Excludes first/second person (I, you, we) and the demonstratives this/that (which dominate gratitude — "that helps"), so continuity never drags chit-chat onto the page.',
  },
  person_pronouns: {
    value: ['he','she','him','her','his','hers','who','whom'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Pronouns that resolve only to person-typed sites.',
  },
  nonperson_pronouns: {
    value: ['it','this','that'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Pronouns that prefer non-person sites.',
  },
  female_pronouns: {
    value: ['she','her','hers'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Pronouns that resolve to female-gendered sites.',
  },
  male_pronouns: {
    value: ['he','him','his'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Pronouns that resolve to male-gendered sites.',
  },
  female_titles: {
    value: ['princess','queen','countess','duchess','lady','dame','mrs','miss','ms','mademoiselle','baroness','empress'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Titles that mark a person as female. Sets gender=f on the site at first sighting.',
  },
  male_titles: {
    value: ['prince','king','count','duke','lord','sir','mr','baron','emperor','tsar','czar','earl'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Titles that mark a person as male. Sets gender=m on the site at first sighting.',
  },
  mass_weight: {
    value: 0.1, mass: Infinity, layer: 'significance', src: 'medium-constant', module: 'core',
    desc: 'Coefficient on SURFACE mass when scoring pronoun resolution candidates: score = surface_mass × mass_weight + momentum. Surface mass is the weight earned from the name actually appearing on the page; inferred mass (from prior pronoun bindings) is excluded from the score so the binder cannot treat its own guesses as evidence for its next guess. Keeps heavy characters sticky against fresh-but-light competitors without letting them become black holes.',
  },
  anaphora_coupling: {
    value: 0.4, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Weight on mass deposited by a pronoun BINDING, exactly parallel to quote_interior_coupling. A binding is an inference, not an observation: it warms the site at this coupling, not full strength. This breaks the rich-get-richer loop where inferred mass compounds into a runaway cluster (mass earned only from "it"/"they"/"he" resolving to it). Read live at replay, so retuning re-derives all historical anaphoric physics.',
  },
  pronoun_resolution_floor: {
    value: 0.1, mass: Infinity, layer: 'significance', src: 'medium-constant', module: 'core',
    desc: 'Absolute floor on the winning pronoun-resolution score. Below it, no site is warm enough to claim the pronoun and it resolves to the void rather than binding the best cold candidate. The companion to the δ dominance gate (inertia_delta), applied to pronoun binding — the one reader that previously always picked a winner. Holding beats inventing.',
  },
  pronoun_lead_disqualify: {
    value: ['his','her','their','its','our','my','your','this','that','these','those','another','other','every','all','some','any','many','much','few','more','most','less'],
    mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Leading words that disqualify a surface from becoming an entity. "his family", "their noses", "another two days" are references, not sites.',
  },

  // ── Language-module additions: attribution, contractions, syntax ──
  attribution_verbs: {
    value: [],
    mass: 0, layer: 'structure', src: 'learned', module: 'core',
    desc: 'Speech verbs, induced from typography rather than seeded. The closing-quote slot — quote mark, then a lowercase word, then a name or subject (",” said Alpátych / !” roared the peasant) — and its mirror before an opening quote (He said: "...) define the class positionally. Any word observed in the slot twice is admitted; first admission logs a REC, every confirmation adds mass. Starts EMPTY: attribution bootstraps from the text itself, in any language whose typography marks quotes. The early quotes of a fresh text go unattributed until the tally builds — that is the honest cost of not being told.',
  },
  attribution_patterns: {
    value: {
      after_quote: [
        { name: 'verb_NAME',     pattern: '^[”"\'’]?[\\s,;:\\-—]*(?:VERBS)\\s+(NAME)',        capture: 'name' },
        { name: 'verb_pronoun',  pattern: '^[”"\'’]?[\\s,;:\\-—]*(?:VERBS)\\s+(he|she|him|her|they)\\b', capture: 'pronoun' },
        { name: 'pronoun_verb',  pattern: '^[”"\'’]?[\\s,;:\\-—]*(he|she|they)\\s+(?:VERBS)\\b', capture: 'pronoun' },
        { name: 'NAME_verb',     pattern: '^[”"\'’]?[\\s,;:\\-—]*(NAME)\\s+(?:VERBS)\\b',        capture: 'name' },
        { name: 'trailing_pronoun', pattern: '^[”"\'’]?[\\s,;:\\-—]*(he|she|they)\\b', capture: 'pronoun' },
      ],
      before_quote: {
        skip_if_prior_quote: true,
        find_verb: 'VERBS',
        subject_search: ['pronoun:He|She|They', 'name:NAME'],
      },
      placeholders: { VERBS: '<attribution_verbs>', NAME: '<proper_noun_regex>' },
    },
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'English narrative attribution conventions. After-quote patterns are tried in priority order; before-quote analysis runs only if no prior quote in the same sentence (otherwise the verb belongs to the earlier quote). Patterns are templates expanded with attribution_verbs and proper_noun_regex.',
  },
  continuation_inheritance: {
    value: { enabled: true, scope: 'same_sentence', requires_confident_origin: true },
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'English convention: a second quote in the same sentence without its own attribution continues the prior speaker. Only inherits from confident attribution (not from mass-weighted fallback guesses).',
  },
  clitic_suffixes: {
    value: ['t','s','re','ll','d','ve','m'],
    mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'English clitic suffixes. A capitalized token whose post-apostrophe part matches one of these is a contraction (Won\'t, Don\'t, We\'ve), not a name. O\'Brien survives — "Brien" doesn\'t match.',
  },
  adverb_heads: {
    value: ['when','as','while','after','before','then','though','although','because','since','if','until','unless','whereas','whether'],
    mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'English subordinating conjunctions and adverbial heads. Stripped from the start of a candidate entity surface — "When Princess Mary entered" → "Princess Mary entered".',
  },
  name_connectors: {
    value: ['of','the','and','or','de','da','van','von','du','la','le','el','al','di','del','der','den','ten'],
    mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Lowercase words that can appear mid-name without disqualifying it: "Lives of the Saints", "Joan of Arc", "Vincent van Gogh", "Catherine de Medici". Mostly Western European naming connectors plus English articles.',
  },
  prep_lead_disqualify: {
    value: ['in','on','at','by','from','to','with','after','before','during','through','into','onto','until','since','about','against','among','between','within','without','above','below','behind','beyond','near','off'],
    mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'English prepositions and conjunctions that head descriptive phrases ("In the vicinity of", "By the time"). A surface starting with one of these is a reference, not an entity.',
  },
  articles: {
    value: ['a','an','the'],
    mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'English articles stripped from the start of entity surfaces. "the Marshal" → "Marshal".',
  },
  quote_pairs: {
    value: [['“','”'], ['"','"'], ['‘','’'], ["'","'"]],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Quote delimiter pairs used in this language. English uses curly and straight double quotes (and matching singles). Languages like French use «» and German uses „".',
  },

  // ── Shape rules — what counts as a promotable entity surface ──
  promote_requires_uppercase_first: {
    value: true, mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Surfaces must start with an uppercase letter to be promoted to entities. Works for Latin-script languages with case distinction. Does NOT work for Chinese, Japanese, Hebrew, Arabic (no case) or German (every noun capitalized).',
  },
  promote_requires_multiword_or_INS: {
    value: true, mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Single-word capitalized surfaces (like "Grass") only become entities if they were INS-confirmed by NER admission. Multi-word capital-bookended phrases are admitted.',
  },

  // ── Reconciliation thresholds — cold pass — universal mechanics ──
  cold_token_jaccard: {
    value: 0.3, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Minimum Jaccard overlap on substantive tokens for cold-pass SYN absorption via token signal alone.',
  },
  cold_embedding_sim: {
    value: 0.88, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Minimum embedding centroid similarity to allow cold-pass SYN absorption when token Jaccard is weak.',
  },
  cold_weak_token_floor: {
    value: 0.1, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Minimum token Jaccard required even when embedding signal is strong. Prevents purely contextual merges of unrelated surfaces.',
  },
  // ── Auditor — semantic grounding of paraphrase ──────────────────
  audit_paraphrase_strong: {
    value: 0.74, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Embedding cosine at or above which a claim the lexical auditor could not place is accepted as a CLOSE PARAPHRASE of a retrieved span — counts as grounded. The reworded-but-faithful case.',
  },
  audit_resemblance: {
    value: 0.58, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Embedding cosine at or above which a claim merely RESEMBLES a retrieved span — no longer a warning, but flagged as impressionistic, not verbatim. Below it, the claim is a genuine leak. Embeddings are good at exactly one thing: this is that one thing, kept in its place.',
  },
  audit_bind_floor: {
    value: 0.55, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Minimum page-match score a claim needs before the binder stamps a [sN] chip onto it. A chip is the mechanics asserting provenance; a borderline match stays grounded in the badge but earns no chip. Resemblance never earns one.',
  },
  // \u2500\u2500 Sentinel \u2014 in-flight supervision of the system's own production \u2500\u2500
  sentinel_draft_overlap: {
    value: 0.82, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: '5-gram shingle overlap between consecutive redrafts at or above which the composition has reached a fixed point \u2014 another pass would not change it. The sentinel stops the loop and keeps the best draft. The walker already obeys this law ("stop when another pass would not change it"); this is the same law applied to the system\u2019s own writing.',
  },
  sentinel_budget_ratio: {
    value: 1.6, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'A draft running past this multiple of the predicted length is runaway, not development. The sentinel trims at a sentence boundary and stops.',
  },
  sentinel_max_drafts: {
    value: 4, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Hard ceiling on drafts per turn (the one-shot plus redrafts). The fixed-point check and the error integral should stop the loop first; this guards a model that never converges.',
  },
};

// Helper: is a language module enabled?
function moduleEnabled(modId) {
  const mod = LANGUAGE_MODULES[modId];
  return !!(mod && mod.enabled);
}
const EN_NARRATIVE_ENABLED = moduleEnabled('en-narrative-v1');

// Derived sets — built from READING_RULES, used for hot-path lookups.
// When a language module is disabled, its rules' values remain in the
// dict (for inspection) but the derived sets are populated from empty
// arrays — so downstream code that checks `STOP.has(x)` etc. naturally
// degrades to no-filter behavior.
function mod_values(ruleName) {
  const rule = READING_RULES[ruleName];
  if (!rule) return [];
  if (ruleName === 'attribution_verbs') return getAttribVerbs();
  if (rule.module === 'core') return rule.value;
  return moduleEnabled(rule.module) ? rule.value : [];
}
// attribution_verbs.value is bucketed per language; induction writes to
// the active bucket only.
function getAttribVerbs() {
  const rule = READING_RULES.attribution_verbs;
  if (!rule) return [];
  if (Array.isArray(rule.value)) rule.value = { en: rule.value };  // migrate
  if (!rule.value[ACTIVE_LANG]) rule.value[ACTIVE_LANG] = [];
  return rule.value[ACTIVE_LANG];
}
let STOP, PRONOUNS, PERSON_PRONOUNS, NONPERSON_PRONOUNS, FEMALE_PRONOUNS,
    MALE_PRONOUNS, FEMALE_TITLES, MALE_TITLES, CLITIC_SUFFIXES, ADVERB_HEADS,
    NAME_CONNECTORS, PREP_LEAD_DISQUALIFY, ARTICLES, ATTRIB_VERB_LIST, ABBREVIATIONS,
    ANAPHOR_PRONOUNS;
function rebuildLangSets() {
  STOP = new Set([
    ...mod_values('base_stopwords'),
    ...mod_values('title_tokens'),
    ...mod_values('function_words'),
  ]);
  PRONOUNS = new Set(mod_values('pronouns'));
  ANAPHOR_PRONOUNS = new Set(mod_values('anaphor_pronouns'));
  PERSON_PRONOUNS = new Set(mod_values('person_pronouns'));
  NONPERSON_PRONOUNS = new Set(mod_values('nonperson_pronouns'));
  FEMALE_PRONOUNS = new Set(mod_values('female_pronouns'));
  MALE_PRONOUNS = new Set(mod_values('male_pronouns'));
  FEMALE_TITLES = new Set(mod_values('female_titles'));
  MALE_TITLES = new Set(mod_values('male_titles'));
  CLITIC_SUFFIXES = new Set(mod_values('clitic_suffixes'));
  ADVERB_HEADS = new Set(mod_values('adverb_heads'));
  NAME_CONNECTORS = new Set(mod_values('name_connectors'));
  PREP_LEAD_DISQUALIFY = new Set(mod_values('prep_lead_disqualify'));
  ARTICLES = new Set(mod_values('articles'));
  ATTRIB_VERB_LIST = getAttribVerbs().join('|');
  ABBREVIATIONS = new Set(mod_values('sentence_abbreviations'));
}
// Apply a language pack: write its detectors into the rules with
// provenance, register the module, rebuild the lexical sets. English
// is itself just a pack — the values already in the rules.
function applyLanguageModule(lang) {
  // A pack toggle is a FRAME change — the same gesture as scrubbing the
  // cursor. No values are swapped or backed up: the frame selects which
  // buckets the fold reads, and the derived view is written through.
  ACTIVE_LANG = lang;
  const pid = PACK_FOR_LANG[lang];
  if (!pid) { rebuildLangSets(); return; }   // csv/json/html: keep the current frame
  const enMod = LANGUAGE_MODULES['en-narrative-v1'];
  if (enMod) enMod.enabled = (lang === 'en');
  if (lang !== 'en') {
    const pack = LANG_PACKS[lang];
    if (pack) LANGUAGE_MODULES[pack.id] = {
      id: pack.id, name: pack.name, version: '1.0',
      applies_to: { language: pack.language, mode: lang === 'code' ? 'source' : 'narrative' },
      enabled: true, provides: Object.keys(pack.rules), desc: pack.desc,
    };
  }
  ENABLED_PACKS.clear(); ENABLED_PACKS.add('core'); ENABLED_PACKS.add(pid);
  deriveSets(projectRules(RULES_LEDGER, currentFrame()));
}
function moduleEnabledForLang(modId) { return modId === 'core' || (LANGUAGE_MODULES[modId] && LANGUAGE_MODULES[modId].enabled); }

// Set the per-language reading mode. modeMap: { en:'original'|'learning', … }.
// 'original' freezes a language to its shipped baseline (induction is skipped
// and the fold drops that bucket's learned delta); 'learning' (default) is the
// adaptive shipped behavior. Re-folds the live view and bumps RULES_REV; the
// host then re-parses open docs (induction is a parse-time decision). The
// learned delta is hidden, never erased — switch back and it returns. Returns
// the new rev. Called with no/empty original modes, this is a no-op for parity.
function setLanguageModes(modeMap) {
  ORIGINAL_LANGS.clear();
  if (modeMap && typeof modeMap === 'object') {
    for (const [lang, mode] of Object.entries(modeMap)) if (mode === 'original') ORIGINAL_LANGS.add(lang);
  }
  _projMemo = null;                                        // a mode change invalidates the fold memo
  deriveSets(projectRules(RULES_LEDGER, currentFrame()));   // re-derive the live view + RULES_REV
  return RULES_REV;
}
// Read-only: the current mode for each known language (default 'learning').
function languageModes() {
  const out = {};
  for (const lang of [...Object.keys(PACK_FOR_LANG), 'csv']) out[lang] = ORIGINAL_LANGS.has(lang) ? 'original' : 'learning';
  return out;
}

// ── RULES LEDGER ─────────────────────────────────────────────────────
// Rule state stops being a mutable dictionary and becomes a pure fold
// over a rules ledger. Packs are replayable regions of that ledger you
// frame in or out; toggling a pack is a frame change, the same gesture
// as scrubbing the cursor. Generation can come from anywhere; admission
// is mechanical; the only authority a rule has is its mass and its
// survival record. Per-document logs keep recording what a reading did,
// but their rule-RECs are receipts carrying a ledger_lid pointer to the
// authoritative event — the fold never reads receipts, so nothing
// double-counts.
const RULES_LEDGER = [];
let _LEDGER_LID = 0;
// Revision of the rule-state. No longer a counter: deriveSets sets it to
// the projection's rev — (max folded seq) ⊕ hash(enabled packs). Move the
// cursor, toggle a pack, append an event — same log, different rev.
let RULES_REV = 0;
const ENABLED_PACKS = new Set(['core', 'en-narrative-v1']);
const PACK_FOR_LANG = { en: 'en-narrative-v1', es: 'es-narrative-v1', zh: 'zh-narrative-v1', code: 'code-v1' };
const PACK_LANG = Object.fromEntries(Object.entries(PACK_FOR_LANG).map(([l, p]) => [p, l]));
// ── Per-language reading mode ────────────────────────────────────────
// A language can read in one of two modes. SELF-LEARNING (default, the
// shipped behavior) induces speech-verb conventions from each document's
// typography and accrues mass on the ledger. ORIGINAL pins the language to
// its shipped baseline: induction is skipped (no new conventions are learned)
// and the fold ignores that bucket's non-shipped delta, so the reading uses
// only seed tokens — frozen and deterministic. This set holds the language
// codes currently in Original mode; empty means everything is Self-learning,
// which is byte-for-byte the historical reading (the golden-parity contract).
const ORIGINAL_LANGS = new Set();
function _originalSig() { return ORIGINAL_LANGS.size ? ('§om:' + [...ORIGINAL_LANGS].sort().join(',')) : ''; }
// The phase tag is load-bearing: replay-phase rules re-derive over
// existing logs for free; extract-phase rules shape what gets emitted,
// so changing them on an already-read document requires re-extraction.
const REPLAY_PHASE_IDS = new Set(['decay_gamma', 'inertia_delta', 'eva_energy_budget',
  'quote_interior_coupling', 'anaphora_coupling', 'audit_paraphrase_strong', 'audit_resemblance', 'audit_bind_floor',
  'proposal_auto_accept_sim', 'sentinel_draft_overlap', 'sentinel_budget_ratio', 'sentinel_max_drafts']);
function _rulePhase(id) { return REPLAY_PHASE_IDS.has(id) ? 'replay' : 'extract'; }
function _packsKey(packs) { return [...packs].sort().join('|'); }
function _strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h >>> 0; }

function ledgerAppend(ev) {
  ev.seq = RULES_LEDGER.length;
  ev.lid = ev.lid || ('L' + (++_LEDGER_LID) + '-' + Date.now().toString(36));
  ev.ts = ev.ts || Date.now();
  if (!ev.op) ev.op = 'REC';
  RULES_LEDGER.push(ev);
  _projMemo = null;
  return ev;
}
// Runtime mutations commit through here: append, re-project, write the
// derived view through, persist. The fold is the only path to rule state.
function ledgerCommit(ev) {
  const e = ledgerAppend(ev);
  deriveSets(projectRules(RULES_LEDGER, currentFrame()));
  scheduleLedgerSave();
  return e;
}

// compileLiteralPacks: the shipped literals become shipped event
// fragments, mechanically — per rule one declare (bucket per its module
// tag, 'core' for medium constants), then one add-token per list entry
// with mass 1 and basis 'shipped', or one set-value for scalars/flags/
// objects. English stops being privileged: pack:en-narrative-v1 is just
// the fragment that ships enabled by default.
let _SEEDED = false;
function compileLiteralPacks() {
  if (_SEEDED) return;
  _SEEDED = true;
  const emit = (ev) => { ev.shipped = true; ev.src = ev.src || 'pack-install'; ledgerAppend(ev); };
  const kindOf = (v) => Array.isArray(v) ? 'list' : (typeof v === 'boolean' ? 'flag' : (typeof v === 'number' ? 'scalar' : 'object'));
  const tokenize = (id, v) => (id === 'quote_pairs') ? v.map(p => JSON.stringify(p)) : v.slice();
  // 1. the en/core literals already in READING_RULES
  for (const [id, r] of Object.entries(READING_RULES)) {
    const bucket = (r.module && r.module !== 'core') ? r.module : 'core';
    const kind = id === 'attribution_verbs' ? 'list' : kindOf(r.value);
    emit({ target: 'rule:' + id, action: 'declare', bucket,
      meta: { id, kind, layer: r.layer, phase: _rulePhase(id), desc: r.desc, src0: r.src, locked: r.mass === Infinity },
      mass: r.mass === Infinity ? 0 : (kind === 'list' ? 0 : r.mass) });
    if (kind === 'list') {
      const toks = id === 'attribution_verbs' ? [] : tokenize(id, r.value);
      for (const t of toks) emit({ target: 'rule:' + id, action: 'add-token', bucket, value: t, mass: 1, basis: 'shipped' });
    } else {
      emit({ target: 'rule:' + id, action: 'set-value', bucket, value: r.value, mass: r.mass === Infinity ? 0 : r.mass, basis: 'shipped', src: r.src === 'medium-constant' ? 'pack-install' : 'pack-install' });
    }
  }
  // 2. the language packs — per-pack buckets, accumulation not overwrite
  for (const [lang, pack] of Object.entries(LANG_PACKS)) {
    for (const [id, v] of Object.entries(pack.rules)) {
      if (!READING_RULES[id]) continue;          // packs only re-skin known rules
      const kind = kindOf(v);
      // a pack DECLARING a rule marks the bucket as providing it — an
      // empty list is a real provision ("this language has no titles"),
      // distinct from a rule the pack never speaks to.
      emit({ target: 'rule:' + id, action: 'declare', bucket: pack.id, meta: { id, kind }, mass: 0 });
      if (kind === 'list') {
        for (const t of tokenize(id, v)) emit({ target: 'rule:' + id, action: 'add-token', bucket: pack.id, value: t, mass: 1, basis: 'shipped' });
      } else {
        emit({ target: 'rule:' + id, action: 'set-value', bucket: pack.id, value: v, mass: 1, basis: 'shipped' });
      }
    }
  }
  // 3. readers ride the same fold
  for (const [id, r] of Object.entries(READER_REGISTRY)) {
    emit({ target: 'reader:' + id, action: 'declare', bucket: 'core',
      meta: { id, kind: 'reader', rkind: r.kind, adjustable: r.adjustable, desc: r.desc } });
    emit({ target: 'reader:' + id, action: 'set-coupling', bucket: 'core', value: r.coupling, basis: 'shipped' });
  }
}

// projectRules(ledger, frame): the pure fold.
//   lists  — per (bucket, token), net mass = Σ add − Σ remove over enabled
//            buckets, seq ≤ upTo; live if net > 0 in ANY enabled bucket;
//            mass sums across enabled buckets. Order = first-admission order.
//   scalars— resolve 'latest' by default (a trajectory, not a vote);
//            'mass' resolves by greatest supporting mass, recency ties.
//   flags  — OR over enabled buckets unless declared resolve:'all'.
//   locked — only src:'calibration' set-values may move a medium constant.
let _projMemo = null;
function projectRules(ledger, frame = {}) {
  const packs = frame.packs || ENABLED_PACKS;
  const upTo = frame.upTo == null ? Infinity : frame.upTo;
  const _omSig = _originalSig();   // '' when no language is in Original mode → identical key/rev
  const memoKey = ledger.length + '§' + _packsKey(packs) + '§' + upTo + _omSig;
  if (_projMemo && _projMemo.key === memoKey) return _projMemo.val;
  const rules = {};   // id → { kind, layer, phase, desc, locked, src0, perBucket, tokens?, value?, mass, _cands }
  const readers = {};
  let maxSeq = -1;
  const ensure = (id, kind) => rules[id] || (rules[id] = { id, kind, layer: null, phase: _rulePhase(id), desc: '', locked: false, src0: null, resolve: kind === 'flag' ? 'or' : 'latest', perBucket: {}, mass: 0, _cands: [] });
  for (const ev of ledger) {
    if (ev.seq > upTo) break;
    const m = /^(rule|reader|pack|route):(.+)$/.exec(ev.target || '');
    if (!m) continue;
    const [, kindTag, id] = m;
    if (kindTag === 'reader') {
      if (!readers[id]) readers[id] = { id, coupling: 1, meta: null };
      if (ev.action === 'declare') readers[id].meta = ev.meta || null;
      else if (ev.action === 'set-coupling' && (packs.has(ev.bucket) || ev.bucket === 'core')) { readers[id].coupling = ev.value; maxSeq = Math.max(maxSeq, ev.seq); }
      continue;
    }
    if (kindTag !== 'rule') continue;
    if (ev.action === 'declare') {
      const r = ensure(id, (ev.meta && ev.meta.kind) || 'list');
      if (!r._declared) {           // first declare wins the shape
        r._declared = true;
        if (ev.meta) { r.kind = ev.meta.kind || r.kind; r.layer = ev.meta.layer || r.layer; r.phase = ev.meta.phase || r.phase; r.desc = ev.meta.desc || r.desc; r.locked = !!ev.meta.locked; r.src0 = ev.meta.src0 || null; if (ev.meta.resolve) r.resolve = ev.meta.resolve; }
      }
      r.mass += (ev.mass || 0);
      // a declare marks the bucket as PROVIDING this rule — presence,
      // even with zero tokens, so an enabled empty provision overrides
      if (ev.bucket) {
        if (!r.perBucket[ev.bucket]) r.perBucket[ev.bucket] = { tokens: new Map(), order: [], latest: undefined, enabled: false };
        if (packs.has(ev.bucket) || ev.bucket === 'core') r.perBucket[ev.bucket].enabled = true;
      }
      continue;
    }
    if (!packs.has(ev.bucket) && ev.bucket !== 'core') {
      // disabled bucket: still ensure shape exists, contribute nothing
      ensure(id, ev.action === 'add-token' || ev.action === 'remove-token' ? 'list' : 'scalar');
      // record the bucket's existence for per-bucket views
      const r0 = rules[id]; if (!r0.perBucket[ev.bucket]) r0.perBucket[ev.bucket] = { tokens: new Map(), order: [], latest: undefined, enabled: false };
      const pb0 = r0.perBucket[ev.bucket];
      if (ev.action === 'add-token') { const k = String(ev.value); if (!pb0.tokens.has(k)) pb0.order.push(k); pb0.tokens.set(k, (pb0.tokens.get(k) || 0) + (ev.mass != null ? ev.mass : 1)); }
      else if (ev.action === 'remove-token') { const k = String(ev.value); pb0.tokens.set(k, (pb0.tokens.get(k) || 0) - (ev.mass != null ? ev.mass : 1)); }
      else if (ev.action === 'set-value') pb0.latest = { value: ev.value, mass: ev.mass || 1, seq: ev.seq, src: ev.src };
      continue;
    }
    // ORIGINAL mode: a language pinned to its shipped baseline ignores its
    // induced (non-shipped) tokens — only seed conventions contribute. The
    // bucket's shape is still ensured so an empty provision reads as empty,
    // not absent. No-op while ORIGINAL_LANGS is empty (the parity path).
    if (ORIGINAL_LANGS.size && !ev.shipped && ORIGINAL_LANGS.has(PACK_LANG[ev.bucket])) {
      ensure(id, ev.action === 'add-token' || ev.action === 'remove-token' ? 'list' : 'scalar');
      continue;
    }
    maxSeq = Math.max(maxSeq, ev.seq);
    const r = ensure(id, ev.action === 'add-token' || ev.action === 'remove-token' ? 'list' : 'scalar');
    if (!r.perBucket[ev.bucket]) r.perBucket[ev.bucket] = { tokens: new Map(), order: [], latest: undefined, enabled: true };
    const pb = r.perBucket[ev.bucket]; pb.enabled = true;
    if (ev.action === 'add-token') {
      const k = String(ev.value);
      if (!pb.tokens.has(k)) pb.order.push(k);
      pb.tokens.set(k, (pb.tokens.get(k) || 0) + (ev.mass != null ? ev.mass : 1));
      r.mass += (ev.mass != null ? ev.mass : 1);
    } else if (ev.action === 'remove-token') {
      const k = String(ev.value);
      pb.tokens.set(k, (pb.tokens.get(k) || 0) - (ev.mass != null ? ev.mass : 1));
    } else if (ev.action === 'set-value') {
      if (r.locked && pb.latest !== undefined && ev.src !== 'calibration') continue;  // medium constant
      pb.latest = { value: ev.value, mass: ev.mass || 1, seq: ev.seq, src: ev.src };
      r._cands.push(pb.latest);
      r.mass += (ev.mass || 1);
    }
  }
  // settle values
  for (const r of Object.values(rules)) {
    if (r.kind === 'list') {
      const seen = new Set(); const tokens = []; const perTokMass = {};
      for (const [b, pb] of Object.entries(r.perBucket)) {
        if (!pb.enabled) continue;
        for (const k of pb.order) {
          const net = pb.tokens.get(k) || 0;
          if (net <= 0) continue;
          perTokMass[k] = (perTokMass[k] || 0) + net;
          if (!seen.has(k)) { seen.add(k); tokens.push(k); }
        }
      }
      r.tokens = tokens; r.tokenMass = perTokMass;
    } else {
      const cands = r._cands;
      if (cands.length) {
        if (r.resolve === 'mass') {
          let best = cands[0];
          for (const c of cands) if (c.mass > best.mass || (c.mass === best.mass && c.seq > best.seq)) best = c;
          r.value = best.value; r.valueSrc = best.src;
        } else {
          const last = cands[cands.length - 1];
          r.value = last.value; r.valueSrc = last.src;
        }
        if (r.kind === 'flag' && r.resolve !== 'all') {
          // OR over enabled buckets' latest
          let any = false, sawTrue = false;
          for (const pb of Object.values(r.perBucket)) if (pb.enabled && pb.latest !== undefined) { any = true; sawTrue = sawTrue || !!pb.latest.value; }
          if (any) r.value = sawTrue;
        } else if (r.kind === 'flag' && r.resolve === 'all') {
          let any = false, allTrue = true;
          for (const pb of Object.values(r.perBucket)) if (pb.enabled && pb.latest !== undefined) { any = true; allTrue = allTrue && !!pb.latest.value; }
          if (any) r.value = allTrue;
        }
      }
    }
    delete r._cands; delete r._declared;
  }
  const rev = ((maxSeq + 1) ^ _strHash(_packsKey(packs) + _omSig)) >>> 0;
  const val = { rules, readers, rev, packs: new Set(packs), upTo };
  _projMemo = { key: memoKey, val };
  return val;
}

function currentFrame() { return { packs: ENABLED_PACKS, upTo: Infinity }; }
function frameForLang(lang) {
  const pid = PACK_FOR_LANG[lang] || PACK_FOR_LANG.en;   // unknown langs keep the en frame (old behavior)
  return { packs: new Set(['core', pid]), upTo: Infinity };
}

// deriveSets(projection, {apply}) — turn a projection into the hot-path
// view. apply:true writes through into READING_RULES / READER_REGISTRY
// and rebuilds the derived Sets (the live objects every read site
// already uses — they become the projection's materialized view).
// apply:false returns a detached snapshot, used by the golden tests to
// compare the fold against the literal path without contaminating it.
const _LIST_RULE_IDS = ['base_stopwords', 'title_tokens', 'function_words', 'pronouns', 'person_pronouns',
  'nonperson_pronouns', 'female_pronouns', 'male_pronouns', 'female_titles', 'male_titles',
  'pronoun_lead_disqualify', 'clitic_suffixes', 'adverb_heads', 'name_connectors',
  'prep_lead_disqualify', 'articles', 'quote_pairs'];
function deriveSets(proj, opts = {}) {
  const apply = opts.apply !== false;
  const langOfFrame = (() => { for (const p of proj.packs) if (PACK_LANG[p]) return PACK_LANG[p]; return 'en'; })();
  const listVal = (id) => {
    const r = proj.rules[id];
    if (!r || r.kind !== 'list') return [];
    return id === 'quote_pairs' ? r.tokens.map(t => JSON.parse(t)) : r.tokens.slice();
  };
  const attribByLang = (() => {
    const r = proj.rules.attribution_verbs;
    const out = { en: [] };   // 'en' key always present (shape parity with the migrated literal)
    if (r) for (const [b, pb] of Object.entries(r.perBucket)) {
      if (b === 'core') continue;   // the declare's provenance bucket, not a language
      const lang = PACK_LANG[b] || b;
      out[lang] = out[lang] || [];
      for (const k of pb.order) if ((pb.tokens.get(k) || 0) > 0) out[lang].push(k);
    }
    if (!out[langOfFrame]) out[langOfFrame] = [];
    return out;
  })();
  const snap = {
    STOP: [...new Set([...listVal('base_stopwords'), ...listVal('title_tokens'), ...listVal('function_words')])],
    PRONOUNS: listVal('pronouns'), PERSON_PRONOUNS: listVal('person_pronouns'),
    NONPERSON_PRONOUNS: listVal('nonperson_pronouns'), FEMALE_PRONOUNS: listVal('female_pronouns'),
    MALE_PRONOUNS: listVal('male_pronouns'), FEMALE_TITLES: listVal('female_titles'),
    MALE_TITLES: listVal('male_titles'), CLITIC_SUFFIXES: listVal('clitic_suffixes'),
    ADVERB_HEADS: listVal('adverb_heads'), NAME_CONNECTORS: listVal('name_connectors'),
    PREP_LEAD_DISQUALIFY: listVal('prep_lead_disqualify'), ARTICLES: listVal('articles'),
    ATTRIB_VERB_LIST: (attribByLang[langOfFrame] || []).join('|'),
    attribByLang, lang: langOfFrame, rev: proj.rev,
  };
  if (!apply) return snap;
  // write-through: rules that have enabled events become the literal
  // entries' values; rules untouched by enabled buckets keep their
  // current literal state (preserving the old leftover behavior for
  // packs that don't provide a rule).
  for (const [id, r] of Object.entries(proj.rules)) {
    if (id === 'attribution_verbs') {
      const live = READING_RULES.attribution_verbs;
      live.value = attribByLang;
      live.mass = r.mass;
      continue;
    }
    const target = READING_RULES[id];
    if (r.kind === 'list') {
      const enabledBuckets = Object.entries(r.perBucket).filter(([, pb]) => pb.enabled);
      if (!enabledBuckets.length) continue;
      const v = id === 'quote_pairs' ? r.tokens.map(t => JSON.parse(t)) : r.tokens.slice();
      const nonCore = enabledBuckets.map(([b]) => b).filter(b => b !== 'core');
      const mod = nonCore.length === 1 ? nonCore[0] : (nonCore.length ? 'multi' : 'core');
      if (!target) { READING_RULES[id] = { value: v, mass: r.mass, layer: r.layer, src: r.src0 || 'learned', module: mod, desc: r.desc }; }
      else { target.value = v; target.mass = r.mass; if (mod !== 'core') { target.module = mod; target.src = 'language-module:' + mod; } else if (r.src0) { target.src = r.src0; target.module = 'core'; } }
    } else {
      if (r.value === undefined) continue;
      if (!target) { READING_RULES[id] = { value: r.value, mass: r.mass, layer: r.layer || 'significance', src: r.valueSrc === 'rule-learning' ? 'learned' : (r.src0 || 'learned'), module: 'core', desc: r.desc }; }
      else { target.value = r.value; if (Number.isFinite(r.mass) && target.mass !== Infinity) target.mass = r.mass; }
    }
  }
  for (const [id, rd] of Object.entries(proj.readers)) {
    if (READER_REGISTRY[id]) READER_REGISTRY[id].coupling = rd.coupling;
  }
  RULES_REV = proj.rev;
  rebuildLangSets();
  return snap;
}

  /* Persist the LEARNED part of the rules ledger so the engine's induced
     reading rules (the speech-verb class and its accrued mass) survive a page
     reload — learning that compounds across visits, not just across one
     session. Shipped seed events are excluded (they re-seed at init); only the
     events a reading actually appended are serialized. The host registers
     `window.EO_onLedgerChange` to do the storage write; debounced so a long
     ingest that appends many verb events writes once, not once per token.
     A no-op anywhere that hook isn't present (e.g. the Node test harness). */
  let _ledgerSaveTimer = null;
  function scheduleLedgerSave() {
    if (typeof window === 'undefined' || typeof window.EO_onLedgerChange !== 'function') return;
    if (_ledgerSaveTimer) clearTimeout(_ledgerSaveTimer);
    _ledgerSaveTimer = setTimeout(() => {
      _ledgerSaveTimer = null;
      try { window.EO_onLedgerChange(_serializeLedger()); } catch (e) {}
    }, 600);
  }
  // The learned delta beyond the shipped seeds — what's worth persisting.
  function _serializeLedger() { return RULES_LEDGER.filter(e => !e.shipped).map(e => ({ ...e })); }
  // Replay persisted learning events into a freshly-seeded ledger, then
  // re-derive. Re-sequenced under the current ledger so seq stays contiguous;
  // idempotent enough that a double call only re-appends (callers restore once).
  function _restoreLedger(events) {
    if (!Array.isArray(events) || !events.length) return false;
    for (const ev of events) { const copy = { ...ev }; delete copy.seq; ledgerAppend(copy); }
    deriveSets(projectRules(RULES_LEDGER, currentFrame()));
    return true;
  }

  /* Drive the rules fold from load, exactly as the standalone tool does
     (minus loadRulesLedger, which read learned events from OPFS). */
  compileLiteralPacks();
  deriveSets(projectRules(RULES_LEDGER, currentFrame()));
let MASS_WEIGHT = READING_RULES.mass_weight.value;
const COPULAR = /^(is|was|are|were|am|been|being|becomes?|became|remained?|remains)$/i;

// Determine gender from a name's leading title token. "Princess Mary" → 'f',
// "Prince Andrew" → 'm', "Marshal" / "Napoleon" → null (unknown).
function genderFromName(name) {
  if (!name) return null;
  const first = String(name).toLowerCase().split(/\s+/)[0].replace(/[.,]/g, '');
  if (FEMALE_TITLES.has(first)) return 'f';
  if (MALE_TITLES.has(first)) return 'm';
  return null;
}

function isPronoun(s) { return PRONOUNS.has(String(s).toLowerCase().trim()); }
function looksProper(s) { return /^\p{Lu}[\p{L}\p{M}\p{N}'’.-]*(\s+\p{Lu}[\p{L}\p{M}\p{N}'’.-]*)*$/u.test(String(s).trim()); }
function normSurface(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

function tokenSetOf(name) {
  const raw = (String(name).toLowerCase().match(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) || [])
    .filter(t => t.length > 1 && !STOP.has(t));
  // Add conservative singular stems so plural/singular variants bind:
  //   Cossacks → {cossacks, cossack}, Russians → {russians, russian},
  //   cities → {cities, city}, churches → {churches, church}.
  // Stems shorter than 3 chars or already in STOP are skipped.
  const expanded = new Set(raw);
  for (const t of raw) {
    if (t.length <= 4) continue;
    let stem = null;
    if (t.endsWith('ies')) stem = t.slice(0, -3) + 'y';
    else if (t.endsWith('sses')) stem = t.slice(0, -2);                 // dresses → dress
    else if (t.endsWith('ches') || t.endsWith('shes') || t.endsWith('xes')) stem = t.slice(0, -2);
    else if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) stem = t.slice(0, -1);
    if (stem && stem.length >= 3 && !STOP.has(stem)) expanded.add(stem);
  }
  return expanded;
}

function aliasRelation(aTok, bTok) {
  if (!aTok.size || !bTok.size) return 'disjoint';
  let shared = 0;
  for (const t of aTok) if (bTok.has(t)) shared++;
  if (shared === 0) return 'disjoint';
  const aSub = shared === aTok.size, bSub = shared === bTok.size;
  if (aSub && bSub) return 'same';
  if (aSub || bSub) return 'alias';
  return 'conflict';
}

function tryAdmit(surface, isPropNoun, tentatives) {
  const trimmed = String(surface).trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (DISCOURSE_JUNK.has(lower)) return false;
  if (/^\d{4}$/.test(trimmed)) return false;
  if (/^[$€£¥]?[\d,.]+\s*(million|billion|trillion|thousand|m|b|k)?$/i.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const multi = tokens.length > 1;
  const properLong = isPropNoun && trimmed.length >= 4;
  if (properLong || multi) return true;
  const k = normSurface(trimmed);
  const n = tentatives.get(k) || 0;
  const next = n + 1;
  tentatives.set(k, next);
  return next >= 2;
}

// Strip noise off a candidate entity surface:
//   - trailing punctuation (curly quotes, ellipses, commas)
//   - leading adverbial heads ("When Michael" → "Michael")
//   - reject if reduced to a stopword or empty
// Used both at admit time and at SIG-speaker mint time.

function cleanEntitySurface(surf) {
  if (!surf) return null;
  let s = String(surf).trim();
  // Strip trailing junk: whitespace, punctuation, curly quotes, ellipses,
  // footnote markers (*, †, ‡, §, ·, •). Matches runs so "Don. *" collapses
  // to "Don" in one pass.
  s = s.replace(/[\s.,;:!?*†‡§·•'"”’“‘`\u2026]+$/gu, '').trim();
  // Same on the leading edge
  s = s.replace(/^[\s.,;:!?*†‡§·•'"”’“‘`\u2026]+/gu, '').trim();
  // Split at internal sentence-boundary punctuation followed by whitespace
  // and a non-space character. "Princess! Go" → "Princess".
  const splitMatch = s.match(/^(.+?)[!?]\s+\S/);
  if (splitMatch) s = splitMatch[1].trim();
  // Split at period+closing-quote+space+capital, the end-of-quoted-sentence
  // pattern. "Minister." During" → "Minister". Doesn't trigger on bare "Mr.
  // Smith" (no closing quote) so abbreviations survive.
  const quoteSplit = s.match(/^(.+?)[.!?]["”'’]\s+\p{Lu}/u);
  if (quoteSplit) s = quoteSplit[1].trim();
  // Reject pronoun contractions like "I'm", "He's", "You're", "They've".
  // If the part before an apostrophe is itself a pronoun or stopword, the
  // whole token is a contraction, not a name. "O'Brien" / "Plátov's" keep
  // working — "o" and "plátov" aren't in either set.
  if (/['’]/.test(s)) {
    const beforeApos = s.split(/['’]/)[0].toLowerCase();
    if (beforeApos && (STOP.has(beforeApos) || PRONOUNS.has(beforeApos))) return null;
    // Also reject by clitic suffix: "Won't", "Don't", "Can't", "It'll",
    // "We've". The part after the apostrophe matches a contraction ending.
    // These slip past the pronoun-before-apos check because the prefix
    // ("Won", "Don", "Can") is a content word, not a stopword. Names with
    // genuine apostrophes ("O'Brien", "D'Arcy") don't end in clitics.
    const afterApos = s.split(/['’]/)[1] || '';
    if (afterApos && CLITIC_SUFFIXES.has(afterApos.toLowerCase())) return null;
  }
  // Strip leading adverbial heads
  const firstWord = s.split(/\s+/)[0] || '';
  if (ADVERB_HEADS.has(firstWord.toLowerCase())) {
    s = s.split(/\s+/).slice(1).join(' ').trim();
  }
  // Strip a leading participle: "Following Dunyásha" → "Dunyásha",
  // "Holding Alpátych" → "Alpátych". Requires the remainder to still
  // start uppercase, and at least two characters of lowercase stem
  // before -ing so "King Charles" survives.
  const firstGer = s.split(/\s+/)[0] || '';
  if (/^\p{Lu}\p{Ll}{2,}ing$/u.test(firstGer) && s.split(/\s+/).length > 1) {
    const rest = s.split(/\s+/).slice(1).join(' ').trim();
    if (/^\p{Lu}/u.test(rest)) s = rest;
  }
  // Strip leading articles (from active language module)
  const firstForArticle = (s.split(/\s+/)[0] || '').toLowerCase();
  if (ARTICLES.has(firstForArticle)) {
    s = s.split(/\s+/).slice(1).join(' ').trim();
  }
  // Reject prepositional leads — "In the vicinity of...", "After Prince Andrew..."
  // are descriptive phrases, not entity names.
  const firstAfterStrip = (s.split(/\s+/)[0] || '').toLowerCase();
  if (PREP_LEAD_DISQUALIFY.has(firstAfterStrip)) return null;
  // Multi-word surfaces: every non-connector word must start uppercase.
  // "Mary stop" → second word "stop" lowercase, not a connector → reject.
  // "Lives of the Saints" → "of"/"the" are connectors → keep.
  const words = s.split(/\s+/);
  if (words.length > 1) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/^[“"'`‘]+|[”"'`’,.;:!?]+$/g, '');
      if (!w) continue;
      if (/^\p{Lu}/u.test(w)) continue;
      if (NAME_CONNECTORS.has(w.toLowerCase())) continue;
      return null;
    }
  }
  // All-caps multi-word surfaces are headers / section labels ("SECOND WIFE",
  // "PART ONE"), not names; spaced one/two-letter tokens ("I N") are OCR noise.
  // A single all-caps token may be a real acronym, so only the multi-word case.
  const _letters = s.replace(/[^\p{L}]/gu, '');
  if (words.length > 1 && _letters.length > 1 && _letters === _letters.toUpperCase() && _letters !== _letters.toLowerCase()) return null;
  if (words.length > 1 && words.every(w => w.replace(/[^\p{L}]/gu, '').length <= 2)) return null;
  // Reject if reduced to nothing or a stopword
  if (!s) return null;
  if (STOP.has(s.toLowerCase())) return null;
  if (DISCOURSE_JUNK.has(s.toLowerCase())) return null;
  if (s.length < 2) return null;
  if (!/^\p{Lu}/u.test(s)) return null;
  return s;
}

// Trim a captured noun phrase to its head entity. compromise's #Noun+
// greedy match crosses commas, participials, and coordinations:
//   "Berg recognizing Prince Andrew I"  →  "Berg"
//   "the shed Alpátych and the coachman" →  "the shed Alpátych" (then admit
//                                            takes the proper-cap portion)
// Boundaries that clip the span:
//   - participials introduced by comma: ", recognizing | saying | said..."
//   - coordination: " and " / " or "
//   - any comma not followed by a continuation
function trimNounSpan(surf) {
  if (!surf) return null;
  let s = String(surf).trim();
  // First, strip outer punctuation and quotes
  s = s.replace(/^[«»"'`\u201C\u201D\u2018\u2019\s]+|[«»"'`\u201C\u201D\u2018\u2019\s]+$/g, '').trim();
  // Clip at any internal newline — entities don't span paragraph breaks
  const nlIdx = s.search(/[\n\r]/);
  if (nlIdx > 0) s = s.slice(0, nlIdx).trim();
  // Clip at an ellipsis — "Elder.... He" → "Elder", "Mutiny!... Brigands" → "Mutiny"
  const ellIdx = s.search(/\.{3}|\u2026/);
  if (ellIdx > 0) s = s.slice(0, ellIdx).trim();
  // Clip at a sentence boundary INSIDE the span — "Tomas Verne. He"
  // crossed a period into the next sentence. A word of 3+ letters,
  // a period, whitespace, then a capital is a boundary, unless the
  // word is a title abbreviation (Mr. Smith survives).
  const TITLE_ABBREV = /^(mr|mrs|ms|dr|st|prof|jr|sr|col|gen|lt|capt|rev|hon|messrs|mme|mlle)$/i;
  const bMatch = s.match(/^(.*?\b([\p{L}]{3,}))\.\s+\p{Lu}/u);
  if (bMatch && !TITLE_ABBREV.test(bMatch[2])) s = bMatch[1].trim();
  // Clip at any internal quote character — entities don't span into a quote
  const qIdx = s.search(/["'`«»\u201C\u201D\u2018\u2019]/);
  if (qIdx > 0) s = s.slice(0, qIdx).trim();
  // Clip at participial / attribution introducers
  const CLIP_RE = /\s+(?:recognizing|saying|said|asked|shouted|replied|cried|muttered|whispered|exclaimed|continued|added|remarked|announced|called)\b/i;
  const clipMatch = s.match(CLIP_RE);
  if (clipMatch) s = s.slice(0, clipMatch.index).trim();
  // Clip at coordination: " and ", " or " — keep the first conjunct
  const coordMatch = s.match(/\s+(?:and|or)\s+/i);
  if (coordMatch) s = s.slice(0, coordMatch.index).trim();
  // Clip at any internal comma — the head is before the comma
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0) s = s.slice(0, commaIdx).trim();
  // Drop trailing single-letter or apostrophe-only tokens ("Prince Andrew I" → "Prince Andrew")
  s = s.replace(/\s+\p{Lu}['’]?$/gu, '').trim();
  // Strip trailing punctuation (including em/en dashes: "Dron—" → "Dron")
  s = s.replace(/[.,;:!?'"”’“‘`\u2026\u2014\u2013-]+$/g, '').trim();
  if (!s) return null;
  return s;
}

// ── Physics constants ──────────────────────────────────────────────
// Reading the medium constants from READING_RULES so they're auditable
// in the Rules tab. Changing the value there would propagate everywhere.
// `let`, not `const`: applyRules() (the UI bridge) refreshes these when a
// medium constant is retuned in the Rules drawer, so the next parse reads
// the new physics. Replay-phase reads (QUOTE_W, ANAPHORA_W, decay_gamma in
// projectGraph) are already live thunks and need no re-parse.
let GAMMA = READING_RULES.decay_gamma.value;
let DELTA = READING_RULES.inertia_delta.value;
// Thunk, not a snapshot: read at every use so a REC retune applies to
// past and future alike under replay.
const QUOTE_W = () => READING_RULES.quote_interior_coupling.value;
const ANAPHORA_W = () => READING_RULES.anaphora_coupling.value;
const PRONOUN_FLOOR = () => READING_RULES.pronoun_resolution_floor.value;
const PRONOUN_LEAD_SET = new Set(READING_RULES.pronoun_lead_disqualify.value);
// First/second-person pronouns are deictic: they resolve by speech
// context (who is speaking to whom), not by narrative momentum. Binding
// "us" or "I" to whichever site is warmest is a category error — the
// activation resolver never sees them.
const DEICTIC_PRONOUNS = new Set(['i', 'we', 'you', 'us', 'me']);

// RULES_REV (declared with the ledger above) is the rule-state revision.
// Frame stamps cite it, so any recorded observation names the exact
// rule-state it was measured under.

// A frame stamp: the apparatus a measurement was taken with. Recording
// physics is legitimate exactly when the frame of reference is recorded
// with it — observation values without a stamp are category errors;
// with one, they are historical data a later frame can disagree with.
function frameStamp(atSentence, extra = {}) {
  return {
    at_sentence: atSentence == null ? null : atSentence,
    rules_rev: RULES_REV,
    gamma: READING_RULES.decay_gamma.value,
    delta: READING_RULES.inertia_delta.value,
    ...extra,
  };
}
function extractCsvGraph(text, t0) {
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const splitRow = (l) => {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const lineIdx = []; rawLines.forEach((l, i) => { if (l.trim()) lineIdx.push(i); });
  const headerLine = lineIdx[0];
  const cols = headerLine != null ? splitRow(rawLines[headerLine]).map(c => c || 'col') : [];
  const events = []; let seq = 0, ref = 0;
  // The header is the schema: each column is a declared property.
  cols.forEach((c) => events.push({
    id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
    target: '(schema)', path: 'column', value: c, targetHint: null,
    sentence_idx: headerLine, sentence: rawLines[headerLine], src: 'csv-schema',
  }));
  // Each row is an entity; each cell a property of it.
  for (let r = 1; r < lineIdx.length; r++) {
    const li = lineIdx[r];
    const cells = splitRow(rawLines[li]);
    const name = (cells[0] || ('row ' + r)).slice(0, 60);
    events.push({
      id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
      target: name, targetRaw: name, entityType: 'record', referent_id: 'r-' + (ref++),
      in_quote: false, sentence_idx: li, sentence: rawLines[li], src: 'csv-row',
    });
    cells.forEach((cell, ci) => {
      if (ci === 0 || cell === '') return;
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
        target: name, path: cols[ci] || ('col' + ci), value: cell,
        targetHint: null, sentence_idx: li, sentence: rawLines[li], src: 'csv-cell',
      });
    });
  }
  const { entities, edges } = projectGraph(events);
  const t1 = performance.now();
  const rulesJson = {}; for (const [id, rr] of Object.entries(READING_RULES)) rulesJson[id] = { value: rr.value, mass: rr.mass === Infinity ? 'Infinity' : rr.mass, layer: rr.layer, src: rr.src, module: rr.module || 'core', desc: rr.desc };
  const modulesJson = { active: Object.values(LANGUAGE_MODULES).filter(m => m.enabled).map(m => m.id), available: Object.keys(LANGUAGE_MODULES), details: { ...LANGUAGE_MODULES } };
  const readersJson = {}; for (const [id, rr] of Object.entries(READER_REGISTRY)) readersJson[id] = { kind: rr.kind, coupling: rr.coupling, adjustable: rr.adjustable };
  return {
    lang: 'csv', mode: 'structured',
    input_chars: text.length, sentences: rawLines.length, events, entities, edges,
    verb_slot_tally: {}, sections: [], sentence_texts: rawLines.map(l => l.replace(/\s+$/, '')),
    columns: cols, open_signals: [], signal_collapses: {}, rules: rulesJson, language_modules: modulesJson, readers: readersJson,
    counts: { INS: events.filter(e => e.op === 'INS').length, SYN: 0, DEF: events.filter(e => e.op === 'DEF').length, SIG: 0, NUL: 0, SEG: 0, EVA: 0, REC: 0, RULES: Object.keys(READING_RULES).length },
    ms: Math.round(t1 - t0),
  };
}

function extractCodeGraph(text, t0) {
  // Same grammar, syntactic surface. Declaration is INS, assignment is
  // DEF, a call is a clause edge from the enclosing scope, and a scope
  // is the stage: a binding is live from its line to its scope's close.
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const events = []; let seq = 0, ref = 0;
  const decls = [];   // { name, line, kind, scopeEnd }
  const scopes = [];  // function/class brace intervals { name, start, end }
  // Pass A: brace-match function/class scopes.
  let depth = 0; const open = [];
  lines.forEach((ln, i) => {
    const dm = ln.match(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)|\bdef\s+([A-Za-z_$][\w$]*)/);
    const opensHere = depth;
    if (dm) { const nm = dm[1] || dm[2] || dm[3]; open.push({ name: nm, start: i, depthAt: opensHere }); }
    for (const ch of ln) { if (ch === '{') depth++; else if (ch === '}') { depth--; while (open.length && open[open.length - 1].depthAt >= depth && open[open.length - 1].start < i) { const o = open.pop(); scopes.push({ name: o.name, start: o.start, end: i }); } } }
  });
  while (open.length) { const o = open.pop(); scopes.push({ name: o.name, start: o.start, end: lines.length - 1 }); }
  const enclosing = (i) => { let best = null; for (const s of scopes) if (s.start <= i && i <= s.end) if (!best || (s.start >= best.start && s.end <= best.end)) best = s; return best; };
  const scopeEndFor = (i) => { const e = enclosing(i); return e ? e.end : lines.length - 1; };
  // Forward-declaration scan: a call can precede the callee's
  // definition (hoisting), so the full name set is gathered first.
  const declared = new Set();
  lines.forEach((ln) => {
    let mm; const dre = /\b(?:function|class|def)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    while ((mm = dre.exec(ln)) !== null) declared.add(mm[1] || mm[2]);
  });
  // Pass B: emit events line by line.
  lines.forEach((ln, i) => {
    // Declarations
    let m;
    const fn = ln.match(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)|\bdef\s+([A-Za-z_$][\w$]*)/);
    if (fn) {
      const nm = fn[1] || fn[2] || fn[3];
      const own = scopes.find(s => s.start === i && s.name === nm);
      decls.push({ name: nm, line: i, scopeEnd: own ? own.end : scopeEndFor(i) });
      declared.add(nm);
      events.push({ id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating', target: nm, targetRaw: nm, entityType: 'thing', referent_id: 'r-' + (ref++), in_quote: false, sentence_idx: i, sentence: ln.trim(), scope_end: own ? own.end : scopeEndFor(i), src: 'code-decl' });
    } else if ((m = ln.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/))) {
      const nm = m[1]; declared.add(nm);
      events.push({ id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating', target: nm, targetRaw: nm, entityType: 'thing', referent_id: 'r-' + (ref++), in_quote: false, sentence_idx: i, sentence: ln.trim(), scope_end: scopeEndFor(i), src: 'code-decl' });
    }
    // Reassignment of a known binding → DEF (the value is replaced)
    const asg = ln.match(/^\s*([A-Za-z_$][\w$]*)\s*=(?!=)/);
    if (asg && declared.has(asg[1]) && !/\b(const|let|var)\b/.test(ln)) {
      events.push({ id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting', target: asg[1], path: 'value', value: ln.split('=').slice(1).join('=').trim().replace(/;\s*$/, '').slice(0, 60), targetHint: null, sentence_idx: i, sentence: ln.trim(), src: 'code-assign' });
    }
    // Calls → clause edge from the enclosing function to the callee
    const host = enclosing(i);
    let cm; const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    while ((cm = callRe.exec(ln)) !== null) {
      const callee = cm[1];
      if (!declared.has(callee)) continue;
      if (/\b(?:function|class|def|if|for|while|switch|catch|return)\b/.test(callee)) continue;
      if (host && host.name !== callee && declared.has(host.name)) {
        events.push({ id: 'ev-' + seq, seq: seq++, op: 'SYN', stance: 'Joining', s: host.name, v: 'calls', o: callee, sHint: null, oHint: null, sentence_idx: i, sentence: ln.trim(), src: 'svo' });
      }
    }
  });
  const sections = scopes.filter(s => { const e = enclosing(s.start - 1); return !e || e === s; }).map(s => ({ label: s.name + '()', start_sentence: s.start })).sort((a, b) => a.start_sentence - b.start_sentence);
  const uniqSec = []; const seen = new Set();
  for (const s of sections) { if (seen.has(s.start_sentence)) continue; seen.add(s.start_sentence); uniqSec.push(s); }
  const { entities, edges } = projectGraph(events);
  const t1 = performance.now();
  const rulesJson = {}; for (const [id, r] of Object.entries(READING_RULES)) rulesJson[id] = { value: r.value, mass: r.mass === Infinity ? 'Infinity' : r.mass, layer: r.layer, src: r.src, module: r.module || 'core', desc: r.desc };
  const modulesJson = { active: Object.values(LANGUAGE_MODULES).filter(m => m.enabled).map(m => m.id), available: Object.keys(LANGUAGE_MODULES), details: { ...LANGUAGE_MODULES } };
  const readersJson = {}; for (const [id, r] of Object.entries(READER_REGISTRY)) readersJson[id] = { kind: r.kind, coupling: r.coupling, adjustable: r.adjustable };
  return {
    lang: 'code', mode: 'structured',
    input_chars: text.length, sentences: lines.length, events, entities, edges,
    verb_slot_tally: {}, sections: uniqSec, sentence_texts: lines.map(l => l.replace(/\s+$/, '')),
    open_signals: [], signal_collapses: {}, rules: rulesJson, language_modules: modulesJson, readers: readersJson,
    counts: { INS: events.filter(e => e.op === 'INS').length, SYN: events.filter(e => e.op === 'SYN').length, DEF: events.filter(e => e.op === 'DEF').length, SIG: 0, NUL: 0, SEG: 0, EVA: 0, REC: 0, RULES: Object.keys(READING_RULES).length },
    ms: Math.round(t1 - t0),
  };
}
// Cooperative yield: hand the main thread back to the browser between chunks
// of a long ingest. Two things happen in that gap that keep a big document
// from crashing the tab: the page stays responsive (it can paint and accept
// input instead of going "page unresponsive"), and the garbage collector
// gets a chance to run, reclaiming the transient parse garbage we shed each
// chunk instead of letting the heap climb in one unbroken spike. Prefer the
// scheduler API where it exists; otherwise fall back to a macrotask.
function _yieldToBrowser() {
  if (typeof scheduler !== 'undefined' && scheduler.yield) { try { return scheduler.yield(); } catch (e) {} }
  return new Promise(r => setTimeout(r, 0));
}

// Staged, chunked prose extraction, walked in the medium's own order:
// EXISTENCE → STRUCTURE → SIGNIFICANCE. Nothing in a later phase may run
// before the one beneath it has settled — the same law the rule layers obey.
//   • existence    — the text is loaded, then segmented into sentences:
//                    the units come to *be* before anything is said of them.
//   • structure    — the reading pass: surfaces admitted, referents bound,
//                    attribution and relations laid down in the event log.
//   • significance — projection: mass, momentum and prominence measured over
//                    the settled structure (what, among what exists, matters).
// `onProgress({ phase, stage, done, total })` is called between chunks so the
// UI can name the phase and show how far along it is. The work is identical to
// one synchronous pass — it is only SLICED so the browser breathes between
// slices. Slower by design; "take longer" beats "crash the tab."
async function extractEoGraph(text, onProgress) {
  const t0 = performance.now();
  // The page declares its own language; the reader adapts its surface
  // detectors and leaves the grammar alone.
  const LANG = detectLanguage(text);
  applyLanguageModule(LANG);
  if (LANG === 'code') return extractCodeGraph(text, t0);
  if (LANG === 'csv') return extractCsvGraph(text, t0);
  // Unwrap hard line breaks (Gutenberg-style wrapped prose). A single
  // newline inside a paragraph is typography, not syntax — left in place
  // it splits sentences mid-clause, truncates names ("Prince\nNicholas
  // Bolkónski" → "Chief Prince"), and severs attributions from their
  // quotes. Blank lines (real paragraph breaks) survive as boundaries.
  text = String(text).replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
  // Segment by paragraph FIRST, then by sentence within each paragraph.
  // compromise merges sentences across blank lines when dialogue
  // punctuation confuses it, producing mega-"sentences" spanning three
  // paragraphs — which cascades continuation inheritance across speaker
  // changes and coarsens the momentum clock. A paragraph break is a hard
  // boundary; no sentence crosses it.
  const sentenceDocs = [];
  const sentParaSolo = [];
  // ── Stage: chunk the text into sentences ──
  // Paragraph-first, then sentence within each paragraph (unchanged). We just
  // walk the paragraphs on a clock and yield about every frame, so segmenting
  // a book-length paste can't lock up the tab.
  const _paras = text.split(/\n{2,}/);
  let _segClock = performance.now();
  for (let _pi = 0; _pi < _paras.length; _pi++) {
    const para = _paras[_pi];
    const p = para.trim();
    if (!p) continue;
    const paraDocs = [];
    if (LANG === 'zh') {
      // CJK sentence terminals; compromise neither splits nor needs to.
      // Each sentence becomes a whole-string doc so downstream .text()
      // keeps working; its English NER simply finds nothing, gated below.
      for (const piece of p.split(/(?<=[\u3002\uFF01\uFF1F\u2026])\s*/)) {
        const q = piece.trim();
        if (q) paraDocs.push(nlp(q));
      }
    } else {
      // English split, then rejoin a sentence the segmenter cut after an
      // abbreviation: a known title (lexicon in the ruliad, not hardcoded here)
      // or any "Abbr." immediately before a number ("No. 12", "Fig. 3"). Keeps a
      // citation from ever landing mid-name. No-op when nothing merges, so a
      // title-free document segments exactly as before.
      const subs = []; nlp(p).sentences().forEach(s => subs.push(s));
      for (let k = 0; k < subs.length; k++) {
        let txt = subs[k].text(), merged = false;
        while (k + 1 < subs.length) {
          const tail = txt.match(/(?:^|[\s(“"‘])(\p{L}+)\.\s*$/u);
          const nextIsNum = /^\s*\d/.test(subs[k + 1].text());
          if (tail && (ABBREVIATIONS.has(tail[1].toLowerCase()) || nextIsNum)) { txt += ' ' + subs[++k].text(); merged = true; }
          else break;
        }
        paraDocs.push(merged ? nlp(txt) : subs[k]);
      }
    }
    for (const s of paraDocs) { sentenceDocs.push(s); sentParaSolo.push(paraDocs.length === 1); }
    if (onProgress && performance.now() - _segClock > 24) {
      onProgress({ phase: 'existence', stage: 'segmenting', done: _pi + 1, total: _paras.length });
      await _yieldToBrowser(); _segClock = performance.now();
    }
  }
  const sentCount = sentenceDocs.length;

  // ── Section boundaries ──
  // Any standalone heading-like line is a fold boundary — there is no
  // privileged vocabulary. "CHAPTER TWO", "PART ONE — WINTER", "III",
  // "The Fountain": if it stood alone as a paragraph, is short, and
  // doesn't read as a sentence (no terminal punctuation, or set in
  // caps, or just a numeral), it's structure — and structure is what
  // folds leverage. The label is whatever the text said it was.
  const sections = [];
  sentenceDocs.forEach((s, idx) => {
    if (!sentParaSolo[idx]) return;
    const t = s.text().trim();
    if (!t || t.length > 60) return;
    if (/["\u201C\u2018']/.test(t)) return;  // dialogue isn't structure
    const words = t.split(/\s+/);
    if (words.length > 8) return;
    const letters = t.replace(/[^\p{L}]/gu, '');
    const allCaps = letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    const noTerminal = !/[.!?\u3002\uFF01\uFF1F\u2026]\s*$/.test(t);
    const numeralOnly = /^[IVXLCDM]+\.?$/.test(t) || /^\d+\.?$/.test(t);
    if (noTerminal || allCaps || numeralOnly) sections.push({ label: t, start_sentence: idx });
  });

  const events = [];
  // sites: key → { name, type, mass, momentum, tokens }
  // mass     accumulates 1 per touch, never decays
  // momentum accumulates as p = p·γ + 1 per touch, decays each sentence
  // tokens   cached substantive token set for gravity computation
  const sites = new Map();
  const tentatives = new Map();       // for two-sighting admission gate
  let seq = 0;
  let nextRefId = 0;
  // Mint a new referent ID. A referent is the reader's commitment that
  // "there's something out there my surfaces are pointing at" — the bridge
  // between the noumenal thing and the textual surface. Referent IDs let us
  // track that commitment across SYN merges (when two referents are
  // recognized as one) and SEG splits (when one referent is recognized as
  // two). Surfaces are appearances; referents are the committed pointing.
  const mintReferent = () => `r-${nextRefId++}`;

  // ── Pass 0: attribution-verb induction ──────────────────────────
  // There is no seed lexicon. The typography defines the slot: a
  // closing quote, then a lowercase word, then a subject ("...,” said
  // Alpátych / !” roared the tipsy peasant), or the mirror slot before
  // an opening quote (He said: “...). Whatever recurs in the slot IS
  // the attribution-verb class — induced, not told. Two sightings
  // admit a verb (the same gate entities pass); first admission opens
  // the event log with a REC, confirmations accumulate mass. Re-reading
  // the same conventions in new text keeps adding mass: the rule's
  // weight is its history of being right about how dialogue looks.
  {
    const tally = new Map();
    // Slot noise is its own closed class — NOT the identity stoplist.
    // "said" carries no identity (correctly stopworded for token
    // gravity) but it is the prime occupant of the attribution slot.
    // Filtering the slot tally through STOP conflated two different
    // claims and silently banned the most common speech verb in the
    // language. Here only grammar that can syntactically land in the
    // slot without being a verb is excluded: copulas, auxiliaries,
    // conjunctions, prepositions, determiners, interrogatives.
    const SLOT_NOISE = new Set([
      ...mod_values('articles'),
      ...mod_values('prep_lead_disqualify'),
      ...mod_values('adverb_heads'),
      'and','but','or','nor','so','yet','that','this','not','now','still','even','only','just','very','too','then','there','here',
      'who','what','where','why','how','which',
      'his','her','their','its','our','your','one','all','some','any',
      'was','were','is','are','be','been','being','am',
      'has','had','have','will','would','did','does','do','can','could','should','must','may','might',
    ]);
    const bump = (w) => {
      const v = String(w).toLowerCase();
      if (v.length < 3) return;
      if (SLOT_NOISE.has(v) || PRONOUNS.has(v)) return;
      tally.set(v, (tally.get(v) || 0) + 1);
    };
    // Post-quote slot: closing quote, lowercase word, optional adverb,
    // then a capital, a subject pronoun, or article + word.
    // A straight quote is opener and closer alike. The discriminator
    // is typography: a true closer sits flush against the punctuation
    // that ends the speech (," ." !" ?"). An opener follows a space.
    // Without this anchor, '"for the Board…' reads as quote→verb→subject
    // and 'for' gets inducted as a speech verb, poisoning attribution.
    const postSlot = /(?:[,.!?;:\u2026]["\u201D]|\u201D)\s*([\p{Ll}][\p{L}'\u2019-]{2,})\s+(?:[\p{Ll}][\p{L}'\u2019-]+\s+)?(?:(?:the|a|an)\s+[\p{Ll}]|[\p{Lu}]|he\b|she\b|they\b)/gu;
    // Post-quote inverted slot: closing quote, subject pronoun, verb
    // ("...,” he asked).
    const pronounSlot = /(?:[,.!?;:\u2026]["\u201D]|\u201D)\s*(?:he|she|they)\s+([\p{Ll}][\p{L}'\u2019-]{2,})/gu;
    // Pre-quote slot: name or subject pronoun, lowercase word, opening quote.
    // The bridge must NOT eat a comma: in '"He knew," said…' the comma
    // sits between 'knew' and the closing quote — consuming it made the
    // closer look like an opener and inducted 'knew'.
    const preSlot = /(?:^|[^\p{L}])(?:[\p{Lu}][\p{L}'\u2019-]+|[Hh]e|[Ss]he|[Tt]hey)\s+([\p{Ll}][\p{L}'\u2019-]{2,})[\s:]*[\u201C"](?=[\p{L}])/gu;
    let m;
    while ((m = postSlot.exec(text)) !== null) bump(m[1]);
    while ((m = pronounSlot.exec(text)) !== null) bump(m[1]);
    while ((m = preSlot.exec(text)) !== null) bump(m[1]);
    if (LANG === 'es') {
      // The raya slot: speech, dash, lowercase word, then a name —
      // "— … —respondió don Quijote—". Same law as the quote slot:
      // typography defines the class, two sightings admit.
      const dashSlot = /\u2014\s*([\p{Ll}][\p{L}\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc'-]{2,})\s+(?:don\s+|do\u00f1a\s+|fray\s+|sor\s+|el\s+|la\s+)?[\p{Lu}]/gu;
      while ((m = dashSlot.exec(text)) !== null) bump(m[1]);
    }
    const vBucket = PACK_FOR_LANG[LANG] || 'en-narrative-v1';
    const have = new Set(getAttribVerbs());
    for (const [verb, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      if (count < 2) continue;
      if (ORIGINAL_LANGS.has(LANG)) continue;   // Original mode: induce nothing, read shipped-only
      if (have.has(verb)) {
        // confirmation — mass accrues on the ledger, no doc event
        ledgerCommit({ target: 'rule:attribution_verbs', action: 'add-token', bucket: vBucket, value: verb, mass: count, basis: { slot_sightings: count }, src: 'verb-induction' });
        continue;
      }
      have.add(verb);
      const led = ledgerCommit({ target: 'rule:attribution_verbs', action: 'add-token', bucket: vBucket, value: verb, mass: count, basis: { slot_sightings: count }, src: 'verb-induction' });
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'REC', stance: 'Recursing',
        target: 'rule:attribution_verbs', action: 'add-token', value: verb,
        rules_rev: RULES_REV, ledger_lid: led.lid,
        old_value: null, new_value: verb,
        basis: { slot_sightings: count },
        reason: 'induced from the quote-attribution slot — typography, not lexicon',
        src: 'verb-induction',
      });
    }
    // derived ATTRIB_VERB_LIST and rule mass are rebuilt by ledgerCommit
    var verbSlotTally = Object.fromEntries([...tally.entries()].sort((a, b) => b[1] - a[1]));
  }

  // ── Language-pack reading passes ─────────────────────────────────
  // The grammar below is shared; these blocks are only the surface
  // detectors the active language needs. They emit the same events.
  let zhNamePositions = null;
  if (LANG === 'zh') {
    const pack = LANG_PACKS.zh;
    const FUNC = new Set([...pack.function_chars]);
    const PRON = new Set(pack.rules.pronouns);
    const sentStrs = sentenceDocs.map(d => d.text());
    // Mine names: repeated 2-4 char CJK grams — the two-sighting rule,
    // generalized to a language with no capitals and no spaces. Longest
    // grams claim their positions first; shorter grams only count free
    // occurrences, so \u590d\u751f never survives inside \u9648\u590d\u751f.
    const runsBySent = sentStrs.map(s => {
      const runs = []; let mm; const re = /[\u4e00-\u9fff]+/g;
      while ((mm = re.exec(s)) !== null) runs.push({ at: mm.index, text: mm[0] });
      return runs;
    });
    const occupied = sentStrs.map(() => new Set());
    const admitted = [];
    for (let n = 4; n >= 2; n--) {
      const occ = new Map();
      runsBySent.forEach((runs, si) => {
        for (const r of runs) for (let i = 0; i + n <= r.text.length; i++) {
          const g = r.text.slice(i, i + n);
          if ([...g].some(c => FUNC.has(c)) || PRON.has(g)) continue;
          let covered = false;
          for (let k = 0; k < n; k++) if (occupied[si].has(r.at + i + k)) { covered = true; break; }
          if (covered) continue;
          if (!occ.has(g)) occ.set(g, []);
          occ.get(g).push({ si, at: r.at + i });
        }
      });
      for (const [g, poss] of [...occ.entries()].sort((a, b) => b[1].length - a[1].length)) {
        if (poss.length < READING_RULES.two_sighting_admission.value) continue;
        const free = poss.filter(p => { for (let k = 0; k < n; k++) if (occupied[p.si].has(p.at + k)) return false; return true; });
        if (free.length < READING_RULES.two_sighting_admission.value) continue;
        admitted.push({ name: g, positions: free });
        for (const p of free) for (let k = 0; k < n; k++) occupied[p.si].add(p.at + k);
      }
    }
    zhNamePositions = new Map(admitted.map(a => [a.name, a.positions]));
    for (const a of admitted) {
      const first = a.positions.reduce((m, p) => Math.min(m, p.si), Infinity);
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
        target: a.name, targetRaw: a.name, entityType: 'thing',
        referent_id: mintReferent(), in_quote: false,
        sentence_idx: first, sentence: sentStrs[first],
        src: 'gram-mining',
      });
    }
    // Speech: the colon-quote slot. \u8bf4\uff1a\u201c\u2026\u201d attributes by typography.
    const zhVerbTally = new Map();
    const nameAt = (si) => admitted.flatMap(a => a.positions.filter(p => p.si === si).map(p => ({ name: a.name, at: p.at })));
    sentStrs.forEach((s, si) => {
      const qm = s.match(/^(.*?)[\uFF1A:]\s*[\u201C\u300C\u300E"\u2018\u300A]([^\u201D\u300D\u300F"\u2019\u300B]+)/u);
      if (!qm) return;
      const pre = qm[1], quote = qm[2];
      let speaker = null, attributed = 'none', verbChars = null;
      const inSent = nameAt(si).filter(p => p.at < pre.length).sort((a, b) => a.at - b.at);
      const adjacent = inSent.find(p => { const tail = pre.slice(p.at + p.name.length); return tail.length <= 3 && ![...tail].some(c => FUNC.has(c) && c !== '\u9053'); });
      const initialPron = PRON.has(pre.slice(0, 1)) || PRON.has(pre.slice(0, 2));
      if (adjacent) { speaker = adjacent.name; attributed = 'named'; verbChars = pre.slice(adjacent.at + adjacent.name.length).replace(/[\uFF0C,\s]/g, ''); }
      else if (!initialPron && inSent.length) { speaker = inSent[inSent.length - 1].name; attributed = 'named'; const last = inSent[inSent.length - 1]; verbChars = null; }
      else {
        // Pronoun subject: the floor belongs to the last prior
        // sentence-initial name — subject position, not object.
        for (let j = si - 1; j >= 0 && !speaker; j--) {
          const init = nameAt(j).find(p => p.at <= 1);
          if (init) { speaker = init.name; attributed = 'provisional'; }
        }
      }
      if (verbChars && verbChars.length >= 1 && verbChars.length <= 2) zhVerbTally.set(verbChars, (zhVerbTally.get(verbChars) || 0) + 1);
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'SIG', stance: 'Tending',
        speaker: speaker || '?', quote: quote.replace(/\s+/g, ' '),
        speakerHint: speaker ? { name: speaker } : null, speakerRaw: speaker,
        attributed: speaker ? attributed : 'none',
        in_quote: false, sentence_idx: si, sentence: s, src: 'colon-quote',
      });
      if (speaker) events.push({
        id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
        target: speaker, path: 'class', value: 'person',
        targetHint: null, sentence_idx: si, sentence: s, src: 'speech-implies-person',
      });
    });
    const haveZh = new Set(getAttribVerbs());
    const zhBucket = PACK_FOR_LANG[LANG] || 'zh-narrative-v1';
    for (const [v, c] of [...zhVerbTally.entries()].sort((a, b) => b[1] - a[1])) {
      if (c < 2) continue;
      if (ORIGINAL_LANGS.has(LANG)) continue;   // Original mode: induce nothing, read shipped-only
      if (haveZh.has(v)) {
        ledgerCommit({ target: 'rule:attribution_verbs', action: 'add-token', bucket: zhBucket, value: v, mass: c, basis: { slot_sightings: c }, src: 'verb-induction' });
        continue;
      }
      haveZh.add(v);
      const led = ledgerCommit({ target: 'rule:attribution_verbs', action: 'add-token', bucket: zhBucket, value: v, mass: c, basis: { slot_sightings: c }, src: 'verb-induction' });
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'REC', stance: 'Recursing',
        target: 'rule:attribution_verbs', action: 'add-token', value: v,
        rules_rev: RULES_REV, ledger_lid: led.lid, old_value: null, new_value: v,
        basis: { slot_sightings: c },
        reason: 'induced from the colon-quote slot — typography, not lexicon',
        src: 'verb-induction',
      });
    }
  }
  if (LANG === 'es') {
    // Raya dialogue: a sentence opening with — is speech; a mid-line
    // —verb Name— insert is its attribution.
    const A = '\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc';
    // A speaker in the raya slot is either a capitalized name (with an
    // optional don/doña head) or a definite description (el ventero):
    // common-noun speakers aren't capitalized in Spanish.
    const NAME = '(?:(?:don|do\u00f1a|fray|sor)\\s+)?[\\p{Lu}][\\p{L}' + A + ']+(?:\\s+(?:de|del|la|el)\\s+[\\p{Lu}][\\p{L}' + A + ']+)*|(?:el|la|los|las)\\s+[\\p{Ll}][\\p{L}' + A + ']+';
    const attrRe = new RegExp('\u2014\\s*([\\p{Ll}][\\p{L}' + A + ']{2,})\\s+(' + NAME + ')', 'u');
    const seenSpeakers = new Set();
    sentenceDocs.forEach((d, si) => {
      const s = d.text().trim();
      if (!/^[\u2014\u2013\u2015]/.test(s)) return;
      const am = s.match(attrRe);
      let speaker = null;
      if (am) speaker = am[2].trim();
      const quote = (am ? s.slice(1, s.indexOf(am[0])) : s.slice(1)).trim().replace(/\s+/g, ' ');
      if (speaker && !seenSpeakers.has(speaker.toLowerCase())) {
        seenSpeakers.add(speaker.toLowerCase());
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
          target: speaker, targetRaw: speaker, entityType: 'person',
          referent_id: mintReferent(), in_quote: false,
          sentence_idx: si, sentence: s, src: 'dash-attribution',
        });
      }
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'SIG', stance: 'Tending',
        speaker: speaker || '?', quote: quote.slice(0, 300),
        speakerHint: speaker ? { name: speaker } : null, speakerRaw: speaker,
        attributed: speaker ? 'named' : 'none',
        in_quote: false, sentence_idx: si, sentence: s, src: 'dash-dialogue',
      });
    });
  }

  // ── Signal substrate ────────────────────────────────────────────
  // Signals are pre-referent. They live in a separate ontological tier from
  // referents — a holding pattern for unbound expectations. When the reader
  // encounters "she" or "her" with no female referent to bind to, the
  // reader doesn't commit to a referent; it forms a signal: a not-yet-
  // committed expectation with the pronoun's constraints (gender, type).
  // Subsequent matching pronouns touch the same signal, accumulating mass
  // and momentum. The signal collapses into an INS — a real commitment —
  // when either (a) a named referent arrives whose constraints match, or
  // (b) the signal's mass crosses a threshold making the unnamed track
  // count as a committed referent on its own.
  //
  // Signals don't appear in the entities list. They're not things-out-there
  // yet — they're the reader's evidence trail of "I see something here
  // that fits these shapes." Once they collapse, the resulting INS records
  // the audit trail as `from_signal: sig-N`.
  const signals = new Map();
  let nextSignalId = 0;
  let currentSentIdx = 0;
  let currentSentText = '';
  const SIGNAL_MASS_THRESHOLD = 3;     // mass at which a signal auto-collapses
  const SIGNAL_MOMENTUM_FLOOR = 0.05;  // below this and dead, signal is GC'd

  const mintSignal = (gender, type) => {
    const id = `sig-${nextSignalId++}`;
    const signal = {
      id,
      constraints: { gender, type: type || 'person' },
      mass: 0.5,
      momentum: 0.5,
      touched_by_events: [],
      birth_sentence: null,  // set when birth event is emitted
    };
    signals.set(id, signal);
    return signal;
  };

  // Find a signal whose constraints match the requested ones. Signals
  // sharing constraints are the same expectation — multiple "she"s in a
  // scene bind to the same female-person signal.
  const findSignal = (gender, type) => {
    for (const s of signals.values()) {
      if (s.constraints.gender === gender && s.constraints.type === (type || 'person')) {
        return s;
      }
    }
    return null;
  };

  const touchSignal = (signal) => {
    signal.mass += 1;
    signal.momentum = signal.momentum * GAMMA + 1;
  };

  // Try to find a signal whose constraints match a named arrival. Used at
  // INS time to collapse held expectations into the new commitment.
  const findMatchingSignalForName = (name, type) => {
    const gender = genderFromName(name);
    if (!gender) return null;  // can't match without a gender constraint
    return findSignal(gender, type);
  };

  // Absorbed surfaces never enter `sites` — gravity merges them in
  // flight. But attribution, arriving later in the same sentence,
  // looks names up by surface key and must find the canonical body.
  // The alias map is that trail: every absorption records
  // surface-key → host-key, and resolveSiteKey() follows the chain.
  const surfaceAlias = new Map();
  const resolveSiteKey = (k) => {
    let cur = k, hops = 0;
    while (!sites.has(cur) && surfaceAlias.has(cur) && hops++ < 6) cur = surfaceAlias.get(cur);
    return sites.has(cur) ? cur : null;
  };

  function recordSiteSurface(key, surface, type, weight = 1) {
    let cur = sites.get(key);
    if (!cur) {
      cur = { name: surface, type, gender: genderFromName(surface), mass: 0, surfaceMass: 0, momentum: 0, tokens: tokenSetOf(surface), referent_id: mintReferent() };
    }
    // surfaceMass tracks weight earned from the NAME appearing on the page —
    // the honest evidence. Pronoun bindings add to mass but never here, so
    // resolution can score on surface alone and the rich-get-richer loop
    // loses its fuel.
    cur.mass += weight;
    cur.surfaceMass = (cur.surfaceMass || 0) + weight;
    cur.momentum = cur.momentum * GAMMA + weight;
    // Type is sticky after first assignment. Compromise NER produces
    // different types for the same surface in different sentences (Don as
    // 'thing' at first INS, then 'person' in the next sentence because the
    // local context parses differently). Letting that drift breaks pronoun
    // resolution and SIG attribution. First-sighting wins; subsequent
    // mentions only accumulate mass and momentum.
    if (!cur.type) cur.type = type;
    if (!cur.gender) cur.gender = genderFromName(surface);
    if (surface.length > cur.name.length) {
      cur.name = surface;
      cur.tokens = tokenSetOf(surface);
    }
    sites.set(key, cur);
    return cur;
  }

  // Resolve a pronoun. For gendered pronouns: if any matching-gender real
  // referent exists, bind normally. Otherwise look in the signal substrate
  // for a matching signal — bind to it if found, or mint a new one.
  // Returns a hint object with either referent_id (real binding) or
  // signal_id (provisional binding).
  const resolvePronoun = (pronoun) => {
    const lower = String(pronoun).toLowerCase();
    if (DEICTIC_PRONOUNS.has(lower)) return null;
    const needFemale = FEMALE_PRONOUNS.has(lower);
    const needMale = MALE_PRONOUNS.has(lower);
    if (needFemale || needMale) {
      const targetGender = needFemale ? 'f' : 'm';
      // Is there a real referent this pronoun could bind? Confirmed
      // matching gender binds; a person of UNKNOWN gender is also
      // bindable — and the binding itself becomes gender evidence
      // (a DEF below), correctable by SEG. Only a confirmed
      // contradicting gender excludes a site.
      let hasMatch = false;
      for (const v of sites.values()) {
        if (v.type === 'person' && (v.gender === targetGender || v.gender == null)) { hasMatch = true; break; }
      }
      if (!hasMatch) {
        // No matching real referent. Find or mint a signal.
        let sig = findSignal(targetGender, 'person');
        if (!sig) {
          sig = mintSignal(targetGender, 'person');
          // Emit a NUL event for signal birth — the reader saw the
          // configuration, declined to commit to a referent, held the
          // expectation. This is non-transformation with held constraints.
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'NUL', stance: 'Preserving',
            signal_id: sig.id,
            constraints: { ...sig.constraints },
            reason: 'signal-birth',
            sentence_idx: currentSentIdx,
            sentence: currentSentText,
            src: 'signal-birth',
          });
          sig.birth_sentence = currentSentIdx;
        }
        touchSignal(sig);
        return {
          signal_id: sig.id,
          name: `*unnamed:${targetGender}*`,
          provisional: true,
          momentum: +sig.momentum.toFixed(2),
        };
      }
    }
    // Fall through to standard activation-based resolution against real referents
    const result = resolveByActivation(pronoun, sites);
    // Fix 2 — the binder's right to say "I don't know". A contested or
    // below-floor pull resolves to the void, not the best wrong answer.
    // Logged as a NUL (open signal); it deposits nothing. Same δ dominance
    // law every other reader already obeys, applied to the one that was exempt.
    if (result && result.nul) {
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'NUL', stance: 'Preserving',
        surface: pronoun, reason: 'pronoun-stall:' + result.reason,
        competing: result.competing,
        observed: { frame: frameStamp(currentSentIdx), competing: result.competing },
        sentence_idx: currentSentIdx, sentence: currentSentText, src: 'pronoun-activation',
      });
      return null;
    }
    if (result && result.key) {
      // Touch the bound real site. A pronoun is a mention of the referent —
      // but an INFERRED one, so it warms the site at the anaphora coupling
      // (Fix 1), never at full strength. Momentum (recency / scene focus)
      // still updates; only the compounding mass is discounted, and it is
      // kept OUT of surfaceMass so it can never feed the resolution score.
      const site = sites.get(result.key);
      if (site) {
        site.mass += ANAPHORA_W();
        site.momentum = site.momentum * GAMMA + 1;
        result.momentum = +site.momentum.toFixed(2);
        // Binding a gendered pronoun to a person of unknown gender
        // TEACHES the gender. The observation is the bind itself,
        // recorded as a DEF so projection (learnedGender) inherits it
        // and SEG can overturn it if the bind was wrong.
        const tg = FEMALE_PRONOUNS.has(lower) ? 'f' : (MALE_PRONOUNS.has(lower) ? 'm' : null);
        if (tg && site.type === 'person' && site.gender == null) {
          site.gender = tg;
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
            target: site.name, path: 'gender', value: tg,
            targetHint: { key: result.key, name: site.name, referent_id: site.referent_id },
            basis: `bound "${pronoun}" under momentum dominance`,
            reason: 'pronoun binding is gender evidence',
            sentence_idx: currentSentIdx, sentence: currentSentText,
            src: 'pronoun-binding',
          });
        }
      }
    }
    return result;
  };

  // ── Structure: read each sentence, laying surfaces, bindings and relations
  // into the event log. The body is unchanged; it's just held in a function so
  // the driver below can walk it in time-sliced chunks. We record each
  // sentence's text up front (sentenceTexts[i]) so the heavy compromise doc can
  // be released the instant we're done with it. The per-event `sentence` field
  // is gone — nothing downstream ever read it; everyone resolves text through
  // sentence_idx → sentence_texts, so carrying a full copy on every event was
  // pure retained weight (the main lever on a long document's memory).
  const sentenceTexts = new Array(sentenceDocs.length);
  const processSentence = (sentDoc, i) => {
    const sentText = sentDoc.text();
    sentenceTexts[i] = sentText.trim();
    const sentMeta = { sentence_idx: i };
    currentSentIdx = i;
    currentSentText = sentText;

    // Decay all momentum at start of sentence (one tick of time)
    for (const [k, v] of sites) {
      v.momentum *= GAMMA;
    }
    // Signals decay on the same clock. A signal that stops getting touched
    // and drifts below the momentum floor with low accumulated mass gets
    // GC'd — the reader gave up tracking that expectation.
    for (const [sid, sig] of [...signals.entries()]) {
      sig.momentum *= GAMMA;
      if (sig.momentum < SIGNAL_MOMENTUM_FLOOR && sig.mass < 1.5) {
        signals.delete(sid);
      }
    }

    // ── Entity extraction via compromise POS tags ─────────────
    // Run on the full sentence so multi-word names like "Prince Andrew"
    // and "Anna Pávlovna" stay intact. The cleanup of greedy spans (where
    // compromise crosses commas into participials, or pulls in adjacent
    // proper nouns across quote breaks) happens AFTER capture, via
    // trimNounSpan applied to each matched surface.
    const peopleArr = LANG === 'en' ? sentDoc.people().out('array').map(trimNounSpan) : [];
    const placesArr = LANG === 'en' ? sentDoc.places().out('array').map(trimNounSpan) : [];
    const orgsArr = LANG === 'en' ? sentDoc.organizations().out('array').map(trimNounSpan) : [];
    const properArr = [];
    sentDoc.match('#ProperNoun+').forEach(m => {
      const trimmed = trimNounSpan(m.text());
      if (trimmed) properArr.push(trimmed);
    });

    const admitted = [];           // [{ surface, type, key }] for this sentence
    const seen = new Set();
    // Is this surface inside quoted speech? Words capitalized at quote
    // start ("Impossible!", "Father!") read as proper nouns to NER but
    // are usually exclamations or vocatives. Quote-interior SINGLE words
    // lose the proper-noun fast path and fall back to two-sighting
    // admission; multi-word names introduced in dialogue ("Yákov
    // Alpátych") still pass.
    const insideQuote = (surf) => {
      const idx = sentText.indexOf(surf);
      if (idx < 0) return false;
      const before = sentText.slice(0, idx);
      const curlyOpens = (before.match(/\u201C/g) || []).length;
      const curlyCloses = (before.match(/\u201D/g) || []).length;
      if (curlyOpens || curlyCloses) return curlyOpens > curlyCloses;
      const straight = (before.match(/"/g) || []).length;
      return straight % 2 === 1;
    };
    const addEnts = (arr, type) => {
      for (const surfRaw of arr) {
        const noPoss = surfRaw.replace(/['’]s$/, '').trim();
        const cleaned = cleanEntitySurface(noPoss);
        if (!cleaned) continue;
        const key = normSurface(cleaned);
        if (seen.has(key)) continue;
        if (DISCOURSE_JUNK.has(key)) continue;
        const inQuote = insideQuote(cleaned);
        const mentionW = inQuote ? QUOTE_W() : 1;
        // Re-mention of an ESTABLISHED site is checked BEFORE admission
        // gating. The two-sighting rule filters new single-word surfaces
        // (capitalization noise); it must not re-gate a site that already
        // exists, or a quote-interior re-mention of a known one-word name
        // ("Rostov" inside a line of dialogue) silently drops its touch.
        if (sites.has(key)) {
          seen.add(key);
          recordSiteSurface(key, cleaned, type, mentionW);
          continue;
        }
        const singleInQuote = !/\s/.test(cleaned) && inQuote;
        if (!tryAdmit(cleaned, !singleInQuote, tentatives)) continue;
        seen.add(key);
        admitted.push({ surface: cleaned, type, key });

        // ── Gravity resolution: INS, SYN-absorb, or NUL ──
        // Compute gravitational pull from every existing site whose name
        // shares at least one substantive token with this surface. Force =
        // (mass + momentum) × token-overlap. Mass is always-on rest gravity;
        // momentum is the kinetic boost from recent mentions.
        const candTokens = tokenSetOf(cleaned);
        const substCandTokens = [...candTokens].filter(t => t.length >= 3 && !STOP.has(t));
        const pulls = [];
        if (substCandTokens.length > 0) {
          for (const [siteKey, site] of sites) {
            const shared = [...candTokens].filter(t => site.tokens.has(t));
            const substShared = shared.filter(t => t.length >= 3 && !STOP.has(t));
            if (substShared.length === 0) continue;
            const overlap = shared.length / Math.sqrt(Math.max(1, candTokens.size) * Math.max(1, site.tokens.size));
            const force = (site.mass + site.momentum) * overlap;
            if (force > 0) pulls.push({
              siteKey, siteName: site.name, force,
              mass: site.mass, momentum: site.momentum, overlap,
            });
          }
          pulls.sort((a, b) => b.force - a.force);
        }

        if (pulls.length === 0) {
          // No body exerts gravity on this surface — new instantiation.
          // Before creating, check the signal substrate. If the reader has
          // been holding a signal whose constraints match this name (gender
          // and type), the signal collapses into this INS: the new referent
          // inherits the signal's accumulated mass and momentum, and the
          // INS event records `from_signal: sig-N` for audit. The signal
          // ceases to exist.
          //
          // This is the named-arrival collapse mode. The reader's held
          // expectation ("there's a female person being tracked") gets
          // fulfilled by the arrival ("she is Princess Mary"). It's not a
          // SYN — there was no prior referent, only a pre-referent signal.
          // It's an INS that consumes the signal.
          // Named-arrival requires NARRATION. A name spoken inside a
          // quote still instantiates (Yákov Alpátych survives), but it
          // cannot consume a signal born from narration pronouns — a
          // character mentioning a name is not the narrator revealing
          // who "she" was.
          const matchingSignal = inQuote ? null : findMatchingSignalForName(cleaned, type);
          recordSiteSurface(key, cleaned, type, mentionW);
          const site = sites.get(key);
          let fromSignal = null;
          if (matchingSignal) {
            // Transfer signal's accumulated state into the new referent
            site.mass += matchingSignal.mass;
            site.momentum += matchingSignal.momentum;
            fromSignal = {
              signal_id: matchingSignal.id,
              constraints: matchingSignal.constraints,
              accumulated_mass: matchingSignal.mass,
              collapse_reason: 'named_arrival',
            };
            signals.delete(matchingSignal.id);
          }
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
            target: cleaned, targetRaw: surfRaw,
            entityType: type,
            referent_id: site.referent_id,
            in_quote: inQuote,
            ...(fromSignal ? { from_signal: fromSignal } : {}),
            observed: {
              frame: frameStamp(i),
              mass: site.mass,
              momentum: +site.momentum.toFixed(3),
            },
            ...sentMeta, src: fromSignal ? 'signal-collapse' : 'first-sighting',
          });
        } else if (pulls.length === 1 || pulls[0].force >= DELTA * pulls[1].force) {
          // Single pull, or one dominant pull — absorption (site-layer SYN).
          // The absorbed surface gets its own referent ID minted even
          // though it's immediately merged. This preserves the audit trail:
          // "the reader could have committed to a new referent here but
          // judged it to be the same as r-A and SYN-merged them." If later
          // evidence forces a SEG, the originally-minted referent ID can
          // be re-extracted.
          const target = pulls[0];
          const targetSite = sites.get(target.siteKey);
          surfaceAlias.set(key, target.siteKey);
          const absorbedReferentId = mintReferent();
          const canonical = pickAbsorbCanonical(target.siteName, targetSite.mass, cleaned, 1);
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'SYN', stance: 'Joining',
            method: 'gravity',
            reader: 'gravity',
            sites: [target.siteKey, key],
            siteNames: [target.siteName, cleaned],
            canonical,
            referent_ids: [targetSite.referent_id, absorbedReferentId],
            canonical_referent_id: targetSite.referent_id,
            observed: {
              frame: frameStamp(i, { reader: 'gravity', coupling: READER_REGISTRY.gravity.coupling }),
              force: +target.force.toFixed(3),
              mass: target.mass,
              momentum: +target.momentum.toFixed(3),
              overlap: +target.overlap.toFixed(3),
              competing: pulls.slice(1, 3).map(p => ({ site: p.siteKey, force: +p.force.toFixed(3) })),
            },
            total_mentions: targetSite.mass + 1,
            ...sentMeta, src: 'inline-gravity',
          });
          // Strengthen the absorbing body (weighted: quote-interior
          // mentions couple at reduced strength). This is a NAME re-mention,
          // so it earns surface mass — honest evidence the binder can score on.
          targetSite.mass += mentionW;
          targetSite.surfaceMass = (targetSite.surfaceMass || 0) + mentionW;
          targetSite.momentum += mentionW;
          if (canonical === cleaned && cleaned.length > target.siteName.length) {
            targetSite.name = canonical;
            targetSite.tokens = tokenSetOf(canonical);
          }
        } else {
          // Comparable pulls — gravities stall. NUL fires: reader saw the
          // configuration, applied no transformation, prior partition stands.
          // The surface does NOT become a site. Each contender absorbs a
          // partial share of the unresolved force (momentum bump only).
          // The LLM reader will automatically revisit these stalls after
          // the cold pass, depositing EVA energy and re-running the
          // collision under the same δ.
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'NUL', stance: 'Preserving',
            surface: cleaned, surfaceRaw: surfRaw,
            // Identity only in `competing`. What each candidate weighed
            // AT THE STALL is recorded under `observed`, stamped with
            // the frame the deciding reader used; the live frame
            // re-measures independently in the measurements table.
            competing: pulls.slice(0, 4).map(p => ({
              site: p.siteKey, siteName: p.siteName,
            })),
            observed: {
              frame: frameStamp(i, { reader: 'gravity', coupling: READER_REGISTRY.gravity.coupling }),
              competing: pulls.slice(0, 4).map(p => ({
                site: p.siteKey, force: +p.force.toFixed(3),
                mass: p.mass, momentum: +p.momentum.toFixed(3),
              })),
            },
            reason: 'stall',
            ...sentMeta, src: 'inline-gravity',
          });
          for (const p of pulls) {
            const s = sites.get(p.siteKey);
            if (s) s.momentum += 0.3;
          }
        }
      }
    };
    addEnts(peopleArr, 'person');
    addEnts(placesArr, 'place');
    addEnts(orgsArr, 'org');
    addEnts(properArr, 'thing');

    // Helper: surface ∈ this sentence's admitted set?
    const isAdmittedSurface = (surf) => {
      const k = normSurface(surf);
      return admitted.some(a => {
        if (a.key === k) return true;
        const aLower = a.surface.toLowerCase();
        // Containment must be near-sized. "At the moment when Rostóv"
        // contains "rostóv" but is not a reference to Rostóv as a
        // subject — long spans that merely mention an entity don't
        // qualify. Allow at most one extra word on either side.
        const kWords = k.split(/\s+/).length;
        const aWords = aLower.split(/\s+/).length;
        if (aLower.includes(k) && aWords <= kWords + 1) return true;
        if (k.includes(aLower) && kWords <= aWords + 1) return true;
        return false;
      });
    };

    // ── DEF (Dissecting): copular "X is/was Y" ────────────────
    // Use clauses() + manual copula detection instead of named-capture
    // matching — same compatibility reason as CON.
    sentDoc.clauses().forEach(clause => {
      const text = clause.text();
      // Look for "<noun phrase> (is|was|are|were|am) (a|an|the)? <noun phrase>"
      const m = text.match(/^(.+?)\s+(is|was|are|were|am|been|becomes?|became|remains?|remained)\s+(?:(?:a|an|the)\s+)?(.+?)\.?$/i);
      if (!m) return;
      const targetRaw = m[1].trim();
      const value = m[3].trim().replace(/[.,;:!?]+$/, '');
      if (!targetRaw || !value) return;
      const target = trimNounSpan(targetRaw) || targetRaw;
      if (target === value) return;
      if (/^(there|here|it|this|that)$/i.test(target)) return;
      // Progressive aspect is action, not predication: "were galloping
      // along the road" is an SVO-shaped enactment, not a class DEF.
      if (/^\p{Ll}+ing\b/u.test(value)) return;
      // Interrogatives are questions, not predications: "Who is your
      // Elder?", "is she pretty?". And a quote-led target means the
      // copula sits inside speech — a character asking, not the
      // narrator dissecting.
      if (/\?/.test(value)) return;
      if (/^(who|what|where|when|why|how|which|well)$/i.test(target)) return;
      if (/^["\u201C']/.test(String(targetRaw).trim())) return;
      // Require target to be a real referent
      let hint = null;
      if (isPronoun(target)) {
        hint = resolvePronoun(target);
        if (!hint) return;
      } else if (!isAdmittedSurface(target) && !looksProper(target)) {
        return;
      }
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
        target, path: 'class', value,
        targetHint: hint,
        targetRaw,
        ...sentMeta, src: 'copular',
      });
    });

    // ── DEF (Dissecting): explicit relations ──────────────────
    // Two narrow, high-precision patterns. "NAME married NAME" runs on
    // NARRATION ONLY — characters saying someone "married the sea" is
    // speech, not record (and the object must be a capitalized name, a
    // second guard against the same). "a TRADE named NAME" is the
    // appositive introduction — the narrator classifying at the moment
    // of naming.
    {
      const narration = sentText
        .replace(/\u201C[^\u201D]*[\u201D]?/g, ' ')
        .replace(/"[^"]*"/g, ' ');
      const nameRe = "[\\p{Lu}][\\p{L}'\\u2019-]+(?:\\s+[\\p{Lu}][\\p{L}'\\u2019-]+)?";
      const marriedRe = new RegExp('(' + nameRe + ')\\s+(?:had\\s+|has\\s+|was\\s+)?married\\s+(' + nameRe + ')', 'gu');
      let mm;
      while ((mm = marriedRe.exec(narration)) !== null) {
        const a = trimNounSpan(mm[1]), b = trimNounSpan(mm[2]);
        if (!a || !b || a === b) continue;
        for (const [t, v] of [[a, b], [b, a]]) {
          const tKey = normSurface(t);
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
            target: t, path: 'spouse', value: v,
            targetHint: sites.has(tKey) ? { key: tKey, name: sites.get(tKey).name, referent_id: sites.get(tKey).referent_id } : null,
            ...sentMeta, src: 'relation-married',
          });
        }
      }
      // NAME died/perished/was killed — narration only. Death is a DEF
      // because it sets a term the rest of the field must satisfy:
      // nothing after it should show the referent acting. Whether the
      // field honors that term is the consistency pass's question.
      const diedRe = new RegExp('(' + nameRe + ')\\s+(?:had\\s+)?(?:died|perished|was\\s+killed|was\\s+slain|drowned)\\b', 'gu');
      while ((mm = diedRe.exec(narration)) !== null) {
        const name = trimNounSpan(mm[1]);
        if (!name) continue;
        const nKey = normSurface(name);
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
          target: name, path: 'died', value: 'dead',
          targetHint: sites.has(nKey) ? { key: nKey, name: sites.get(nKey).name, referent_id: sites.get(nKey).referent_id } : null,
          ...sentMeta, src: 'relation-died',
        });
      }
      const apposRe = new RegExp('\\ban?\\s+([a-z]+(?:\\s+[a-z]+)?)\\s+named\\s+(' + nameRe + ')', 'gu');
      while ((mm = apposRe.exec(sentText)) !== null) {
        const trade = mm[1].trim(), name = trimNounSpan(mm[2]);
        if (!name || STOP.has(trade)) continue;
        const nKey = normSurface(name);
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
          target: name, path: 'class', value: trade,
          targetHint: sites.has(nKey) ? { key: nKey, name: sites.get(nKey).name, referent_id: sites.get(nKey).referent_id } : null,
          ...sentMeta, src: 'appositive',
        });
      }
    }

    // ── DEF (Dissecting): parenthetical gloss "X (born 1933)" ─
    const PAREN = /\b(\p{Lu}[\p{L}\p{M}'’.-]+(?:\s+\p{Lu}[\p{L}\p{M}'’.-]+)*)\s*\(([^)]{2,80})\)/gu;
    let pm;
    while ((pm = PAREN.exec(sentText)) !== null) {
      const target = pm[1];
      const inside = pm[2].trim();
      if (looksProper(inside)) continue;  // it's an alias, not a gloss
      const vw = inside.match(/^(born|died|founded|elected|named|aged|est\.?|c\.|circa|known\s+as)\s+(.+)$/i);
      if (vw) {
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
          target, path: vw[1].toLowerCase().replace(/\s+/g, '-').replace(/\.$/, ''),
          value: vw[2].trim(),
          ...sentMeta, src: 'paren',
        });
      } else if (inside.length < 60) {
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
          target, path: 'gloss', value: inside,
          ...sentMeta, src: 'paren',
        });
      }
    }

    // ── SYN (Joining): subject-verb-object, enacted action ────
    // SVO triples report enacted events — Alpátych ENACTING a leaving of
    // the cellar, Prince Andrew ENACTING a riding-up to the house. These
    // are SYN events: the actual joining/binding happening in this moment.
    // CON (connectability) is type-level and is derived by clustering many
    // SYN events — it does not get extracted directly from prose.
    sentDoc.clauses().forEach(clause => {
      const nouns = clause.nouns().out('array');
      const verbs = clause.verbs().out('array');
      if (nouns.length < 2 || verbs.length < 1) return;
      // Heuristic: first noun = subject, last verb = main verb, last noun = object
      const sRaw = nouns[0];
      const v = verbs[verbs.length - 1].toLowerCase();
      const oRaw = nouns[nouns.length - 1];
      if (!sRaw || !v || !oRaw) return;
      // Trim greedy spans
      const s = trimNounSpan(sRaw) || sRaw;
      const o = trimNounSpan(oRaw) || oRaw;
      if (!s || !v || !o) return;
      if (normSurface(s) === normSurface(o)) return;
      const vFirst = v.split(/\s+/)[0];
      if (COPULAR.test(vFirst)) return;
      if (/^(have|has|had|do|does|did|got|get|be|been|being)$/i.test(vFirst)) return;
      // Expletive "it": "It appeared that...", "It seemed..." — the
      // pronoun is grammatical filler, not a reference to any site.
      if (/^it$/i.test(s) && /^(appear|seem|happen|turn|occur)/i.test(vFirst)) return;
      // Reject clitic contractions as subjects: "Won't", "Don't", "It'll"
      // pass looksProper but are auxiliaries, not referents. Possessive
      // 's stays allowed (Plátov's horse remains a valid subject span).
      const sFirst = (s.split(/\s+/)[0] || '');
      if (/['’](t|re|ll|ve|m|d)$/i.test(sFirst)) return;
      // Subject must be a real referent
      const sIsEnt = isAdmittedSurface(s) || isPronoun(s) || looksProper(s);
      if (!sIsEnt) return;
      // Object: any noun phrase OK
      const oTrim = o.replace(/^(a|an|the)\s+/i, '').trim();
      if (!oTrim || oTrim.length < 2) return;
      const sHint = isPronoun(s) ? resolvePronoun(s) : null;
      const oHint = isPronoun(o) ? resolvePronoun(o) : null;
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'SYN', stance: 'Joining',
        s, v, o: oTrim,
        sHint, oHint,
        // Raw tokens for downstream reconciliation (embedding lookup, etc.)
        // The trimmed surfaces above may lose information; preserve the
        // original spans so the reconciler can decide what matters.
        sRaw, oRaw,
        ...sentMeta, src: 'svo',
      });
    });

    // ── SIG (Tending): quoted speech with REAL attribution ────
    // compromise.quotations() returns ANY quote-delimited span — including
    // scare quotes around single words ("the favorite", "Remarks"). Those
    // aren't speech. Only mint SIG when an attribution verb appears in the
    // same sentence (said, asked, shouted, replied, cried, muttered,
    // whispered, thought, exclaimed, etc.). Also skip footnote sentences
    // (leading asterisk pattern: "* "Child of the Don."" is editorial
    // annotation, not dialogue).
    //
    // ATTRIB_VERB_LIST is now sourced from READING_RULES.attribution_verbs
    // via the en-narrative-v1 language module. When the module is disabled
    // the list is empty, the regex never matches, and parseAttribution
    // returns null on every call — the core continues to run but no
    // attribution is detected. The same module also supplies the
    // continuation_inheritance behavior gated below.
    const ATTRIB_VERB = ATTRIB_VERB_LIST
      ? new RegExp(`\\b(${ATTRIB_VERB_LIST})\\b`, 'i')
      : { test: () => false };

    // Parse the attribution clause that anchors a quote to a speaker.
    // Tries, in order of reliability:
    //   1. After-quote "said NAME" / "said pronoun" — the dominant English
    //      narrative pattern: `"hello," said Dron.`
    //   2. Before-quote "NAME said" / "pronoun said" — `Dron said: "hello"`
    //      and the embedded `He ... said: "..."` pattern where the subject
    //      of the speech verb sits at the start of the sentence.
    //
    // Returns { type: 'name', value } or { type: 'pronoun', value }, or null
    // if no attribution found in this sentence's text — including the case
    // where no language module is loaded and we have no verb list.
    const parseAttribution = (rawText, rawQuote) => {
      if (!ATTRIB_VERB_LIST) return null;
      // Normalize whitespace — source text has newlines inside sentences
      // that break indexOf matching against the compromise-cleaned quote.
      const text = rawText.replace(/\s+/g, ' ');
      const cleanQuote = rawQuote ? rawQuote.replace(/\s+/g, ' ') : '';
      const verbs = ATTRIB_VERB_LIST;
      const properNoun = `[A-Z\\u00C0-\\u024F][\\p{L}\\p{M}'’.\\-]+(?:\\s+[A-Z\\u00C0-\\u024F][\\p{L}\\p{M}'’.\\-]+){0,2}`;
      const idx = cleanQuote ? text.indexOf(cleanQuote) : -1;

      if (idx >= 0) {
        const after = text.slice(idx + cleanQuote.length);
        // After-quote: closing punct + verb + NAME ("said Dron")
        let m = after.match(new RegExp(`^[”"'’]?[\\s,;:\\-—]*(?:${verbs})\\s+(${properNoun})`, 'u'));
        if (m) return { type: 'name', value: m[1].replace(/[,.;:!?]+$/, '').trim() };
        // After-quote: closing punct + verb + pronoun ("said he")
        m = after.match(new RegExp(`^[”"'’]?[\\s,;:\\-—]*(?:${verbs})\\s+(he|she|him|her|they)\\b`, 'iu'));
        if (m) return { type: 'pronoun', value: m[1].toLowerCase() };
        // After-quote: closing punct + pronoun + verb ("she said")
        m = after.match(new RegExp(`^[”"'’]?[\\s,;:\\-—]*(he|she|they)\\s+(?:${verbs})\\b`, 'iu'));
        if (m) return { type: 'pronoun', value: m[1].toLowerCase() };
        // After-quote: closing punct + NAME + verb ("Dron said")
        m = after.match(new RegExp(`^[”"'’]?[\\s,;:\\-—]*(${properNoun})\\s+(?:${verbs})\\b`, 'u'));
        if (m) return { type: 'name', value: m[1].replace(/[,.;:!?]+$/, '').trim() };
        // After-quote: closer + ONE lowercase word + NAME ("wheezed
        // Aldermane"-shaped). The word sits in the attribution slot by
        // construction; trust the slot even when the verb hasn't earned
        // admission yet. Typography over lexicon.
        m = after.match(new RegExp(`^[”\"'’]?[\\s,;:\\-—]*([\\p{Ll}][\\p{L}'’-]{2,})(?:\\s+[\\p{Ll}][\\p{L}'’-]+)?\\s+(${properNoun})\\b`, 'u'));
        if (m && !STOP.has(m[1].toLowerCase()) && !PRONOUNS.has(m[1].toLowerCase()))
          return { type: 'name', value: m[2].replace(/[,.;:!?]+$/, '').trim(), slot_verb: m[1].toLowerCase() };
        // After-quote: closing punct + bare pronoun (no verb). compromise
        // often truncates mid-attribution so we get `"...," he` with the
        // "asked" or "said" landing in the next sentence. The bare pronoun
        // right after a closing quote is still strong evidence of the
        // attribution; lower priority than the strict patterns above.
        m = after.match(new RegExp(`^[”"'’]?[\\s,;:\\-—]*(he|she|they)\\b`, 'iu'));
        if (m) return { type: 'pronoun', value: m[1].toLowerCase() };
      }

      // Before-quote: subject of the speech verb is the pronoun or proper
      // noun closest to the start of the pre-verb fragment. Pronouns win.
      //
      // Critical guard: if a prior quote exists in the before-text, any
      // attribution verb there belongs to that earlier quote, not this
      // one. compromise often joins paragraphs into one "sentence", so
      // ` "Q1," said X. "Q2."` is one chunk. For Q2, before-text contains
      // "Q1" and "said X" — but "said X" is Q1's attribution. Falling
      // through to continuation inheritance is the correct move here; the
      // before-quote name path would mis-attribute Q2 to whatever name or
      // word appears in Q1.
      const before = idx >= 0 ? text.slice(0, idx) : text;
      const hadPriorQuote = /[“"][^“”"]*?[”"]/.test(before);
      if (!hadPriorQuote) {
        const verbMatch = before.match(new RegExp(`\\b(${verbs})\\b`, 'iu'));
        if (verbMatch) {
          const preVerb = before.slice(0, verbMatch.index);
          const pronMatch = preVerb.match(/\b(He|She|They)\b/);
          if (pronMatch) return { type: 'pronoun', value: pronMatch[1].toLowerCase() };
          const nameMatch = preVerb.match(new RegExp(`(${properNoun})`, 'u'));
          if (nameMatch) return { type: 'name', value: nameMatch[1].replace(/[,.;:!?]+$/, '').trim() };
        }
      }
      return null;
    };

    const isFootnote = /^\s*\*/.test(sentText);
    // Track the last successful speaker across quotes in the same sentence.
    // When a second or later quote has no attribution of its own, the
    // English convention is that it continues the prior speaker. This is
    // a minimal "vox stack" — same-sentence inheritance only — but it
    // catches consecutive-utterance patterns like:
    //   "X," replied Dron. "Y."     ← second quote is also Dron
    //   "X," said Princess Mary. "Y." ← second quote is also Mary
    let lastSpeaker = null;
    if (!isFootnote) sentDoc.quotations().forEach(q => {
      const rawQuote = q.text().replace(/^[“"'`‘]+|[”"'`’]+$/g, '').trim();
      if (rawQuote.length < 3) return;
      // Reject scare-quotes: short stand-alone phrases with no
      // attribution. But a short quote can BE the attribution carrier
      // ('"Mr. Sorrel," began Aldermane, "I will be plain"') — so ask
      // parseAttribution first; only reject short quotes that carry
      // nothing.
      const earlyAttribution = rawQuote.split(/\s+/).length < 4 ? parseAttribution(sentText, rawQuote) : undefined;
      const hasAttrib = ATTRIB_VERB.test(sentText) || !!earlyAttribution;
      if (!hasAttrib && rawQuote.split(/\s+/).length < 4) return;

      // First try real attribution parsing. This catches "said Dron",
      // "Dron said", "said he", and "He said" patterns directly from the
      // sentence text — the most reliable evidence for who's speaking.
      let speaker = null;
      // attributionConfident: true only when speaker came from a confident
      // attribution match (name resolves to a known site, or pronoun
      // resolves to a real referent). Continuation inheritance uses this
      // flag so the second quote only inherits when the first was actually
      // anchored — preventing mass-weighted fallback guesses from
      // propagating to subsequent quotes in the same sentence.
      let attributionConfident = false;
      let speakerFromContinuation = false;
      const attribution = earlyAttribution !== undefined ? earlyAttribution : parseAttribution(sentText, rawQuote);
      if (attribution) {
        if (attribution.type === 'name') {
          // Strip possessive 's so "Princess Mary's" finds "princess mary"
          const attrName = attribution.value.replace(/['’]s$/, '');
          const rawKey = normSurface(attrName);
          // The name in `said NAME` may be a surface gravity already
          // absorbed this very sentence — resolve through the alias
          // chain to the canonical site instead of rejecting it.
          const speakerKey = sites.has(rawKey) ? rawKey : (resolveSiteKey(rawKey) || rawKey);
          const isStopName = STOP.has(rawKey) || PRONOUNS.has(rawKey);
          const isKnownSite = sites.has(speakerKey);
          const isMultiword = /\s/.test(attrName);
          // Validation: regex-matched "names" like "But", "Order", "It",
          // "Fine", "Then", "And" are common words capitalized at sentence
          // or quote start. Reject if (a) the surface is a stopword or
          // pronoun, or (b) it isn't a known site AND it's a single word.
          // Multi-word capital phrases (e.g. "John Smith") may name a
          // first-time character and are accepted even if not yet a site.
          if (isStopName) {
            // reject
          } else if (!isKnownSite && !isMultiword) {
            // reject single-word unknown capital
          } else if (isKnownSite) {
            const v = sites.get(speakerKey);
            // Attribution evidence overrides NER. A name appearing as the
            // subject of "said" is a person, even if compromise tagged it
            // as a thing. Things that speak are persons — and since
            // projection only believes events, the promotion is emitted
            // as a DEF, not just mutated on the live site.
            if (v.type !== 'person') {
              v.type = 'person';
              events.push({
                id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
                target: v.name, path: 'type', value: 'person',
                targetHint: { key: speakerKey, name: v.name, referent_id: v.referent_id },
                basis: 'subject of an attribution verb',
                reason: 'speech is personhood evidence',
                sentence_idx: currentSentIdx, sentence: currentSentText,
                src: 'speech-induction',
              });
            }
            // Touch the bound site — attribution is a mention.
            v.mass += 1;
            v.momentum = v.momentum * GAMMA + 1;
            speaker = { surface: v.name, type: 'person', key: speakerKey, referent_id: v.referent_id };
            attributionConfident = true;
          } else {
            // Multi-word name not yet a site. Use it directly; subsequent
            // narrative is likely to instantiate the site.
            speaker = { surface: attrName, type: 'person', key: speakerKey };
            attributionConfident = true;
          }
        } else if (attribution.type === 'pronoun') {
          const hint = resolvePronoun(attribution.value);
          if (hint) {
            if (hint.signal_id) {
              speaker = {
                surface: hint.name,
                type: 'person',
                signal_id: hint.signal_id,
                provisional: true,
              };
            } else {
              speaker = {
                surface: hint.name,
                type: 'person',
                key: hint.key,
                referent_id: hint.referent_id,
              };
            }
            attributionConfident = true;
          }
        }
      }

      // Continuation: same-sentence later quote with no own attribution
      // inherits the prior quote's speaker. This handles patterns like
      //   "X," replied Dron. "Y."  — second quote is Dron's continuation.
      // Behavior controlled by the continuation_inheritance rule (language
      // module). Disable for languages where this convention doesn't hold.
      const contRule = READING_RULES.continuation_inheritance;
      const contEnabled = contRule && (contRule.module === 'core' || moduleEnabled(contRule.module)) && contRule.value && contRule.value.enabled;
      if (contEnabled && !speaker && lastSpeaker) {
        speaker = { ...lastSpeaker };
        speakerFromContinuation = true;
      }

      // Find speaker — clean leading/trailing junk from any admitted person
      if (!speaker) {
        for (const a of admitted) {
          if (a.type === 'person') { speaker = a; break; }
        }
      }
      // Fallback: highest mass-weighted person candidate. The candidate
      // pool includes both real referents AND signals (pre-referent
      // expectations). A heavy female signal in a Princess-Mary scene can
      // outscore Marshal as the more likely speaker even though no name has
      // been committed for her yet.
      if (!speaker) {
        let bestKey = null, bestScore = -Infinity, bestSignal = null;
        for (const [k, v] of sites) {
          if (v.type !== 'person') continue;
          const score = v.mass * MASS_WEIGHT + v.momentum;
          if (score > bestScore) { bestKey = k; bestScore = score; bestSignal = null; }
        }
        for (const sig of signals.values()) {
          if (sig.constraints.type !== 'person') continue;
          const score = sig.mass * MASS_WEIGHT + sig.momentum;
          if (score > bestScore) {
            bestSignal = sig;
            bestKey = null;
            bestScore = score;
          }
        }
        if (bestSignal && bestScore > 0) {
          touchSignal(bestSignal);
          speaker = {
            surface: `*unnamed:${bestSignal.constraints.gender || '?'}*`,
            type: 'person',
            signal_id: bestSignal.id,
            provisional: true,
          };
        } else if (bestKey && bestScore > 0) {
          const v = sites.get(bestKey);
          speaker = { surface: v.name, type: 'person', key: bestKey, referent_id: v.referent_id };
        }
      }
      // Final speaker-string scrub: strip trailing punctuation, leading
      // adverbial heads (When/As/While/After). Reject if reduced to nothing.
      // Provisional speakers (signal-bound) keep their `*unnamed:f*` form
      // since the cleaner would strip the asterisks; mark them differently.
      const isProvisional = !!(speaker && speaker.provisional);
      const cleanSpeaker = (speaker && !isProvisional) ? cleanEntitySurface(speaker.surface) : (speaker ? speaker.surface : null);
      if (speaker && !cleanSpeaker) speaker = null;
      // Look up the speaker's referent_id from the sites map. The admitted-
      // path speaker (taken straight from `admitted`) doesn't carry one
      // because admission happens before gravity resolution mints the site.
      // The fallback-path speaker already carries it (or carries signal_id
      // for provisional bindings).
      let speakerRefId = speaker?.referent_id || null;
      if (speaker && !speakerRefId && !speaker.signal_id && sites.has(speaker.key)) {
        speakerRefId = sites.get(speaker.key).referent_id;
      }
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'SIG', stance: 'Tending',
        speaker: cleanSpeaker || '?',
        quote: rawQuote.replace(/\s+/g, ' '),
        speakerHint: speaker
          ? (speaker.signal_id
            ? { signal_id: speaker.signal_id, name: speaker.surface, provisional: true }
            : { key: speaker.key, name: cleanSpeaker, referent_id: speakerRefId })
          : null,
        speakerRaw: speaker ? speaker.surface : null,
        // How the label was earned — the auditor and the tool layer
        // report confidence from this, never reconstruct it.
        attributed: !speaker ? 'none'
          : isProvisional ? 'provisional'
          : attributionConfident
            ? ((attribution && attribution.type === 'pronoun') ? 'pronoun' : 'named')
          : speakerFromContinuation ? 'continuation'
          : 'fallback',
        ...sentMeta, src: 'quote',
      });
      // Carry forward for any subsequent quotes in this sentence
      // Carry forward only when the binding came from confident attribution.
      // Mass-weighted fallbacks and admitted-person guesses don't propagate
      // — if the system isn't sure who the first quote belongs to, it
      // shouldn't pretend to know who the next one belongs to either.
      if (speaker && attributionConfident) lastSpeaker = speaker;
    });
  };
  // Drive the structure pass on a clock: read sentences until ~a frame has
  // elapsed, then hand control back. Each sentence's compromise doc is nulled
  // the instant it's processed, so the heap holds the entities-so-far plus a
  // shrinking tail of unread sentences — never the whole book at once.
  {
    let _readClock = performance.now();
    for (let i = 0; i < sentenceDocs.length; i++) {
      processSentence(sentenceDocs[i], i);
      sentenceDocs[i] = null;
      const last = i + 1 === sentenceDocs.length;
      if (onProgress && (last || performance.now() - _readClock > 24)) {
        onProgress({ phase: 'structure', stage: 'reading', done: i + 1, total: sentenceDocs.length });
        await _yieldToBrowser(); _readClock = performance.now();
      }
    }
  }

  // ── Significance: project mass, momentum and prominence over the settled
  // structure — only now, with existence and structure complete beneath it. ──
  if (onProgress) { onProgress({ phase: 'significance', stage: 'projecting' }); await _yieldToBrowser(); }
  // No batch reconciliation: gravity resolution happened inline per sentence.
  // The embedding reconciler and the LLM tiebreak run automatically after
  // this warm pass — cold pass first, then EVA deposits on whatever stalled.
  const { entities, edges } = projectGraph(events);

  const t1 = performance.now();
  // Serialize READING_RULES to plain JSON. Each entry carries its module
  // tag so downstream consumers can see which rules came from the core
  // and which from a language module — and partition them accordingly.
  // Infinity → "Infinity" for JSON safety.
  const rulesJson = {};
  for (const [id, r] of Object.entries(READING_RULES)) {
    rulesJson[id] = {
      value: r.value,
      mass: r.mass === Infinity ? 'Infinity' : r.mass,
      layer: r.layer,
      src: r.src,
      module: r.module || 'core',
      desc: r.desc,
    };
  }
  // Snapshot the language modules registry — id, name, version, enabled
  // state, and the rule names each module provides. Lets a reader of the
  // exported log audit which conventions were active during this run and
  // reproduce or disable them.
  const modulesJson = {
    active: Object.values(LANGUAGE_MODULES).filter(m => m.enabled).map(m => m.id),
    available: Object.keys(LANGUAGE_MODULES),
    details: { ...LANGUAGE_MODULES },
  };
  // Snapshot the reader registry too — couplings at time of read.
  const readersJson = {};
  for (const [id, r] of Object.entries(READER_REGISTRY)) {
    readersJson[id] = { kind: r.kind, coupling: r.coupling, adjustable: r.adjustable };
  }
  // Build the signal collapse map for the result — sig-N → r-M for any
  // signals that collapsed via named arrival. Helpful for downstream
  // consumers walking the event log.
  const signalCollapses = {};
  for (const ev of events) {
    if (ev.op === 'INS' && ev.from_signal && ev.from_signal.signal_id) {
      signalCollapses[ev.from_signal.signal_id] = {
        referent_id: ev.referent_id,
        referent_name: ev.target,
        collapsed_at_sentence: ev.sentence_idx,
        reason: ev.from_signal.collapse_reason,
      };
    }
  }
  // Open signals = signals still in the substrate at end of read. The
  // reader held these expectations but no named arrival came to fulfill
  // them. They're not entities — they're outstanding I.O.U.s for things
  // the text pointed at but never named.
  const openSignals = [...signals.values()].map(s => ({
    signal_id: s.id,
    constraints: s.constraints,
    mass: +s.mass.toFixed(2),
    momentum: +s.momentum.toFixed(2),
    birth_sentence: s.birth_sentence,
  }));

  return {
    lang: LANG, mode: modeForLang(LANG),
    input_chars: text.length,
    sentences: sentCount,
    events,
    entities,
    edges,
    verb_slot_tally: typeof verbSlotTally !== 'undefined' ? verbSlotTally : {},
    sections,
    sentence_texts: sentenceTexts,
    open_signals: openSignals,
    signal_collapses: signalCollapses,
    rules: rulesJson,
    language_modules: modulesJson,
    readers: readersJson,
    counts: {
      INS: events.filter(e => e.op === 'INS').length,
      SYN: events.filter(e => e.op === 'SYN').length,
      DEF: events.filter(e => e.op === 'DEF').length,
      SIG: events.filter(e => e.op === 'SIG').length,
      NUL: events.filter(e => e.op === 'NUL').length,
      SEG: events.filter(e => e.op === 'SEG').length,
      EVA: events.filter(e => e.op === 'EVA').length,
      REC: events.filter(e => e.op === 'REC').length,
      RULES: Object.keys(READING_RULES).length,
    },
    ms: Math.round(t1 - t0),
  };
}
function pickAbsorbCanonical(nameA, massA, nameB, massB) {
  // Pick the better canonical between two candidates being joined.
  // Prefer proper-noun-shaped, reasonable length, with more mass.
  // Allow lowercase function words in middle (so "Lives of the Saints"
  // counts as proper-noun-shaped).
  const looksProperish = (s) => {
    const words = String(s).trim().split(/\s+/);
    if (words.length === 0) return false;
    if (!/^\p{Lu}/u.test(words[0])) return false;
    // First and last word must start uppercase; middle words can be lowercase
    if (words.length > 1 && !/^\p{Lu}/u.test(words[words.length - 1])) return false;
    return true;
  };
  const score = (name, mass) => {
    let s = mass * 10;
    if (looksProperish(name)) s += 50;
    const len = name.length;
    if (len > 4 && len < 30) s += 20;
    if (len >= 30) s -= 40;
    const wc = name.split(/\s+/).length;
    if (wc > 6) s -= 40;
    return s;
  };
  return score(nameA, massA) >= score(nameB, massB) ? nameA : nameB;
}

// Pronoun resolution under physics: pronouns have no substantive token
// of their own, so they bind by type (person pronoun → person sites).
// The pull strength is the site's momentum (recent activity in working
// memory). Highest-momentum matching site absorbs the pronoun.
function resolveByActivation(pronoun, sites) {
  const lower = String(pronoun).toLowerCase();
  const needPerson = PERSON_PRONOUNS.has(lower);
  const preferNonPerson = NONPERSON_PRONOUNS.has(lower);
  const needFemale = FEMALE_PRONOUNS.has(lower);
  const needMale = MALE_PRONOUNS.has(lower);
  // Score = mass × mass_weight + momentum. Heavy characters stay sticky;
  // freshly-touched newcomers can still outpull them if their mass-bonus is
  // small. Princess Mary (mass 16) outscores Marshal (mass 5) even when
  // Marshal's momentum is higher.
  //
  // Gender is a hard EXCLUSION, not a tier. For "she", any site with
  // gender='m' is dropped; the remaining (f + neutral) compete by score.
  // For "him", any 'f' site is dropped; remaining ('m' + neutral) compete.
  // This avoids the over-correction where Prince Andrew (matching gender,
  // stale) beats Marshal (neutral, just touched) for "him".
  // Score on SURFACE mass only (Fix 1): mass earned from the name appearing,
  // not from prior pronoun bindings. Inferred mass never enters the score, so
  // a cluster cannot bootstrap itself into a black hole on its own guesses.
  // STRUCTURE LAYER, STEP 1 — SIGN (electromagnetism): a hard polar exclusion.
  // Same sign repels: a confirmed-opposite-gender site is dropped from the
  // field entirely before any magnitude is compared. This must run BEFORE
  // step 2 — proportion is built on the poles, not the other way round.
  const elig = [];
  for (const [k, v] of sites) {
    if (needPerson && v.type !== 'person') continue;      // type charge
    if (needFemale && v.gender === 'm') continue;         // sign exclusion
    if (needMale && v.gender === 'f') continue;           // sign exclusion
    const surfaceMass = v.surfaceMass != null ? v.surfaceMass : v.mass;
    let score = surfaceMass * MASS_WEIGHT + v.momentum;
    if (preferNonPerson && v.type === 'person') score -= 0.15;
    elig.push({ key: k, v, score });
  }
  if (!elig.length) return null;
  elig.sort((a, b) => b.score - a.score);
  const best = elig[0];
  const competing = () => elig.slice(0, 4).map(e => ({ site: e.key, siteName: e.v.name, score: +e.score.toFixed(3) }));
  // STRUCTURE LAYER, STEP 2 — PROPORTION (gravity / δ): among the survivors of
  // the sign exclusion, the winner must out-pull the runner-up by the δ ratio,
  // else the field stalls to the void. Proportion decides among what sign left
  // standing — it is built on the poles, never the other way round.
  // Fix 2 — absolute floor: nothing is warm enough to claim the pronoun.
  if (best.score <= 0 || best.score < PRONOUN_FLOOR()) {
    return { nul: true, reason: 'below-floor', competing: competing() };
  }
  // Fix 2 — δ dominance: the winner must out-pull the runner-up by the same
  // ratio the gravity reader uses for name collisions. A contested pull stalls
  // to the void rather than forcing the heaviest non-antecedent to win.
  const second = elig[1];
  if (second && second.score > 0 && best.score < DELTA * second.score) {
    return { nul: true, reason: 'contested', competing: competing() };
  }
  return { key: best.key, name: best.v.name, referent_id: best.v.referent_id, momentum: +best.v.momentum.toFixed(2) };
}

// ── Graph projector ────────────────────────────────────────────────
// Pure function: events → { entities, edges }.
// Replays the event log in seq order, maintaining a union-find partition.
// Observation events (INS/SYN/DEF/SIG) register surface occurrences.
// MERGE events union surfaces. SEG events with targets+partition payload
// re-partition prior MERGEs. EVA events deposit reader energy into the
// field during the physics replay. Re-running projectGraph after appending
// events gives the current graph state — the log is the source of truth.
function projectGraph(events, frame = {}) {
  // ── Frame of reference ──
  // Nothing in the field has absolute mass or momentum. These are
  // measurements relative to a frame: a cursor position in the reading
  // (the "now" attention sits at) plus the current rules and couplings.
  // Events record only observations and decisions — the invariants.
  // Move the cursor, demote a token, recalibrate a reader: the same
  // log measures differently. Default frame: end of text, current rules.
  const horizon = (frame.cursor == null || !isFinite(frame.cursor)) ? Infinity : frame.cursor;
  const posOf = (ev) => (ev.sentence_idx == null ? Infinity : ev.sentence_idx);
  events = events.filter(ev => posOf(ev) <= horizon);
  let maxSent = 0;
  for (const ev of events) { const p = posOf(ev); if (isFinite(p) && p > maxSent) maxSent = p; }
  const effectiveNow = isFinite(horizon) ? horizon : maxSent;
  // SYN has two shapes: text-layer (s, v, o from text extraction) and
  // site-layer (sites[], canonical from gravity resolution / reconciler).
  const isSiteSyn = (ev) => ev.op === 'SYN' && Array.isArray(ev.sites);
  const isTextSyn = (ev) => ev.op === 'SYN' && !Array.isArray(ev.sites);

  const slotsOf = (ev) => {
    if (isTextSyn(ev)) return [
      { surface: ev.s, hint: ev.sHint },
      { surface: ev.o, hint: ev.oHint },
    ];
    if (ev.op === 'DEF') return [{ surface: ev.target, hint: ev.targetHint }];
    if (ev.op === 'SIG') return [{ surface: ev.speaker, hint: ev.speakerHint }];
    if (ev.op === 'INS') return [{ surface: ev.target, hint: null }];
    return [];
  };

  // ── Pass 0: entity universe = keys of INS events ──
  // INS is the only event that explicitly creates a site. Surfaces that
  // appear only as SYN/DEF/SIG slots without ever being INS'd are
  // references, not entities.
  const entityKeys = new Set();
  for (const ev of events) {
    if (ev.op === 'INS') entityKeys.add(normSurface(ev.target));
  }
  // Also surface forms from prior site-layer SYN absorptions count as
  // recognized references to existing entities.
  for (const ev of events) {
    if (isSiteSyn(ev) && Array.isArray(ev.sites)) {
      for (const s of ev.sites) entityKeys.add(s);
    }
  }

  // A surface qualifies for promotion to entity if it's either INS-confirmed
  // OR has proper-noun shape (uppercase start, not pronoun-led, multi-word
  // with capital last word, or single uppercase word matching a known key).
  const isPromotable = (surf) => {
    const key = normSurface(surf);
    if (entityKeys.has(key)) return true;
    if (!/^\p{Lu}/u.test(surf)) return false;
    const words = surf.trim().split(/\s+/);
    const firstLower = words[0].toLowerCase();
    if (PRONOUN_LEAD_SET.has(firstLower)) return false;
    if (words.length < 2) return false;
    if (!/^\p{Lu}/u.test(words[words.length - 1])) return false;
    return true;
  };

  // Build the signal→referent collapse map. When an INS event records
  // from_signal, the signal_id retroactively becomes part of the new
  // referent's cluster. All prior pronoun events that bound to the signal
  // should roll into this cluster.
  const signalToReferent = new Map();
  const signalToInsTarget = new Map();
  for (const ev of events) {
    if (ev.op === 'INS' && ev.from_signal && ev.from_signal.signal_id) {
      signalToReferent.set(ev.from_signal.signal_id, ev.referent_id);
      signalToInsTarget.set(ev.from_signal.signal_id, normSurface(ev.target));
    }
    // Reader-deposit collapse: a SYN with signal_collapse binds the
    // signal to an EXISTING site. All prior signal-bound mentions roll
    // retroactively into that site's cluster, same as named arrival.
    if (ev.op === 'SYN' && ev.signal_collapse && ev.signal_collapse.signal_id && Array.isArray(ev.sites) && ev.sites[0]) {
      signalToInsTarget.set(ev.signal_collapse.signal_id, ev.sites[0]);
    }
  }

  // ── Pass 1: collect surface occurrences (filtered) ──
  const occ = new Map();
  for (const ev of events) {
    if (isSiteSyn(ev)) continue;
    if (!['SYN', 'DEF', 'SIG', 'INS'].includes(ev.op)) continue;
    for (const slot of slotsOf(ev)) {
      let surf = slot.surface;
      if (!surf) continue;
      if (isPronoun(surf)) {
        if (slot.hint && slot.hint.signal_id) {
          // Pronoun bound to a signal. If the signal later collapsed into a
          // real referent, this mention rolls into that referent's cluster.
          // If the signal never collapsed (held expectation that decayed or
          // is still open), the mention has no cluster home — skip it.
          const collapsedKey = signalToInsTarget.get(slot.hint.signal_id);
          if (!collapsedKey) continue;
          const cur = occ.get(collapsedKey) || { key: collapsedKey, name: collapsedKey, mentions: 0, eventSeqs: [], surfaceForms: new Set() };
          cur.mentions++;
          cur.eventSeqs.push(ev.seq);
          occ.set(collapsedKey, cur);
          continue;
        }
        if (slot.hint) { surf = slot.hint.name; }
        else continue;
      }
      if (!isPromotable(surf)) continue;
      const key = normSurface(surf);
      if (key.length < 2) continue;
      const cur = occ.get(key) || { key, name: surf, mentions: 0, eventSeqs: [], surfaceForms: new Set() };
      cur.mentions++;
      cur.eventSeqs.push(ev.seq);
      cur.surfaceForms.add(surf);
      if (surf.length > cur.name.length) cur.name = surf;
      occ.set(key, cur);
    }
  }

  // ── Pass 2: union-find replay of site-layer SYN and SEG events ──
  const parent = new Map();
  for (const k of occ.keys()) parent.set(k, k);

  function find(k) {
    if (!parent.has(k)) { parent.set(k, k); return k; }
    let p = parent.get(k);
    if (p === k) return k;
    const root = find(p);
    parent.set(k, root);
    return root;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Track surfaces each site-layer SYN unioned, so SEG can find them.
  // (Stores by seq for both site-SYN events and any legacy MERGE events.)
  const joinsBySeq = new Map();

  for (const ev of events) {
    if ((isSiteSyn(ev) || ev.op === 'MERGE') && Array.isArray(ev.sites)) {
      // Each site-layer SYN represents a fresh observation of the surfaces
      // it joins — record that as a mention contribution to each site, so
      // a cluster's `mentions` count reflects all the textual evidence, not
      // just the INS events. Without this, Cossack appearing 7 times via
      // inline gravity into Plátov's Cossacks would show 0 mentions for the
      // Cossack side.
      for (let i = 0; i < ev.sites.length; i++) {
        const siteKey = ev.sites[i];
        const siteName = (ev.siteNames && ev.siteNames[i]) || siteKey;
        if (!parent.has(siteKey)) parent.set(siteKey, siteKey);
        let cur = occ.get(siteKey);
        if (!cur) {
          cur = { key: siteKey, name: siteName, mentions: 0, eventSeqs: [], surfaceForms: new Set() };
          occ.set(siteKey, cur);
        }
        // Don't double-count the canonical for the join itself — site i=0
        // is the canonical/host; sites i>=1 are absorbed surfaces being
        // observed afresh. Count only the absorbed ones to avoid inflating
        // the canonical's count by the number of joins it received.
        if (i > 0) {
          cur.mentions++;
          cur.eventSeqs.push(ev.seq);
          cur.surfaceForms.add(siteName);
        }
      }
      joinsBySeq.set(ev.seq, ev.sites.slice());
      for (let i = 1; i < ev.sites.length; i++) union(ev.sites[0], ev.sites[i]);
    } else if (ev.op === 'SEG' && Array.isArray(ev.targets) && Array.isArray(ev.partition)) {
      const affected = new Set();
      for (const targetSeq of ev.targets) {
        const sites = joinsBySeq.get(targetSeq) || [];
        for (const s of sites) affected.add(s);
      }
      for (const s of affected) parent.set(s, s);
      for (const subCluster of ev.partition) {
        for (let i = 1; i < subCluster.length; i++) union(subCluster[0], subCluster[i]);
      }
    }
    // NUL events are no-op for the partition (non-transformation).
    // EVA events are no-op for the partition too — deposits change the
    // field's energy (pass 2.5), never the partition directly.
  }

  // After pass 2 has populated occ with site-SYN-only surfaces, re-init
  // their parent entries so pass 3 will include them in cluster building.
  for (const k of occ.keys()) {
    if (!parent.has(k)) parent.set(k, k);
  }

  // ── Pass 2.5: field measurement under the current frame ──
  // Mass, momentum, gravity, overlap are NOT stored on events — they
  // are not properties of events at all. They are measurements of the
  // field relative to this frame: this replay, run under the current
  // rules, couplings, and cursor, reported in a side table keyed by
  // seq. The decisions stay in the log (SYN vs NUL was the moment of
  // choice); what the field weighed at each moment is re-derived on
  // every projection. Change γ, demote a token, recalibrate a reader,
  // move the cursor: same events, different measurements.
  //
  // We maintain our own incremental union-find so each event sees the
  // canonical root state AT THAT MOMENT, not the final post-projection state.
  const frameMeasurements = {};
  {
    const γ = READING_RULES.decay_gamma.value;
    const replayParent = new Map();
    const rFind = (k) => {
      if (!replayParent.has(k)) { replayParent.set(k, k); return k; }
      let p = replayParent.get(k);
      if (p === k) return k;
      const r = rFind(p);
      replayParent.set(k, r);
      return r;
    };
    const rUnion = (a, b) => {
      const ra = rFind(a), rb = rFind(b);
      if (ra !== rb) replayParent.set(ra, rb);
    };
    // Per-root physics state
    const state = new Map();   // root → { mass, momentum, lastSentence }
    const ensureState = (root, sent) => {
      if (!state.has(root)) state.set(root, { mass: 0, momentum: 0, lastSentence: sent });
      return state.get(root);
    };
    const decayTo = (s, sent) => {
      const gap = Math.max(0, sent - s.lastSentence);
      if (gap > 0) s.momentum *= Math.pow(γ, gap);
      s.lastSentence = sent;
    };
    const touch = (key, sent, w = 1) => {
      if (!key) return null;
      const root = rFind(key);
      const s = ensureState(root, sent);
      decayTo(s, sent);
      s.momentum = s.momentum * γ + w;
      s.mass += w;
      return { root, state: s };
    };
    const overlapOf = (nameA, nameB) => {
      if (!nameA || !nameB) return 0;
      const sA = tokenSetOf(nameA), sB = tokenSetOf(nameB);
      const intersection = [...sA].filter(t => sB.has(t));
      const union = new Set([...sA, ...sB]);
      return union.size === 0 ? 0 : intersection.length / union.size;
    };

    // Build the signal collapse map locally for the replay too. When a
    // signal collapses into an INS, prior pronoun events that bound to it
    // need to be retroactively credited to the new referent's site.
    const sigCollapse = new Map();
    for (const ev of events) {
      if (ev.op === 'INS' && ev.from_signal && ev.from_signal.signal_id) {
        sigCollapse.set(ev.from_signal.signal_id, normSurface(ev.target));
      }
      if (ev.op === 'SYN' && ev.signal_collapse && ev.signal_collapse.signal_id && Array.isArray(ev.sites) && ev.sites[0]) {
        sigCollapse.set(ev.signal_collapse.signal_id, ev.sites[0]);
      }
    }

    // Resolve a hint to a real site key, handling signal redirects.
    // Returns null when the hint binds to an un-collapsed signal — those
    // mentions stay outside the cluster physics.
    const hintToKey = (hint) => {
      if (!hint) return null;
      if (hint.key) return hint.key;
      if (hint.signal_id) return sigCollapse.get(hint.signal_id) || null;
      return null;
    };

    // Sort events by seq to guarantee chronological replay
    const sortedEvents = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const ev of sortedEvents) {
      const sent = isFinite(posOf(ev)) ? posOf(ev) : maxSent;
      if (ev.op === 'INS') {
        // The event stores only the invariant flag; the WEIGHT comes
        // from the rule as it stands NOW. Retune quote_interior_coupling
        // and every historical quote-interior mention re-derives.
        const r = touch(normSurface(ev.target), sent, ev.in_quote ? QUOTE_W() : 1);
        if (r) {
          let inheritedMass = 0;
          if (ev.from_signal) {
            inheritedMass = ev.from_signal.accumulated_mass || 0;
            r.state.mass += inheritedMass;
          }
          frameMeasurements[ev.seq] = {
            mass: r.state.mass,
            momentum: +r.state.momentum.toFixed(3),
            ...(ev.from_signal ? { inherited_from_signal_mass: inheritedMass } : {}),
          };
        }
      } else if (isSiteSyn(ev) && Array.isArray(ev.sites)) {
        // Decay and sum across each site's current root state pre-merge
        const siteKeys = ev.sites.map(k => normSurface(k));
        const roots = siteKeys.map(k => rFind(k));
        const uniqueRoots = [...new Set(roots)];
        let totalMass = 0, totalMomentum = 0;
        for (const r of uniqueRoots) {
          const s = ensureState(r, sent);
          decayTo(s, sent);
          totalMass += s.mass;
          totalMomentum += s.momentum;
        }
        const overlap = ev.siteNames && ev.siteNames.length >= 2
          ? overlapOf(ev.siteNames[0], ev.siteNames[1]) : 0;
        const gravity = (totalMass + totalMomentum) * overlap;
        frameMeasurements[ev.seq] = {
          gravity: +gravity.toFixed(3),
          mass_at_contact: totalMass,
          momentum_at_contact: +totalMomentum.toFixed(3),
          overlap: +overlap.toFixed(3),
        };
        // Perform the merge in replay state
        for (let i = 1; i < siteKeys.length; i++) {
          rUnion(siteKeys[0], siteKeys[i]);
        }
        const newRoot = rFind(siteKeys[0]);
        const merged = {
          mass: totalMass + 1,                   // the join itself is an observation
          momentum: totalMomentum * γ + 1,       // momentum carries forward, decayed and bumped
          lastSentence: sent,
        };
        for (const r of uniqueRoots) if (r !== newRoot) state.delete(r);
        state.set(newRoot, merged);
      } else if (ev.op === 'SYN') {
        // Text-layer SYN — touch sHint and oHint sites (via hint when
        // present, else by normalized raw surface if it's a known site).
        // Pronouns resolve via hints; direct references like "Lavrúshka"
        // come in as raw surfaces with no hint. Signal hints redirect to
        // their collapsed referent if one exists; otherwise no-op (the
        // expectation was never fulfilled).
        const touchFromSurface = (rawSurf, hint) => {
          // A pronoun slot is an inferred reference — it deposits display mass
          // at the anaphora coupling, parallel to the extraction-time discount,
          // so the entity panel shows honest weight (a name mentioned 3 times
          // and referred to by 20 pronouns is not mass 23).
          const w = isPronoun(rawSurf) ? ANAPHORA_W() : 1;
          const redirected = hintToKey(hint);
          if (redirected) { touch(redirected, sent, w); return; }
          if (!rawSurf) return;
          const key = normSurface(rawSurf);
          if (occ.has(key)) touch(key, sent, w);
        };
        touchFromSurface(ev.s, ev.sHint);
        touchFromSurface(ev.o, ev.oHint);
      } else if (ev.op === 'DEF') {
        // A gender DEF born from a pronoun binding is inferred — discount it.
        const wDef = ev.src === 'pronoun-binding' ? ANAPHORA_W() : 1;
        const redirected = hintToKey(ev.targetHint);
        if (redirected) {
          touch(redirected, sent, wDef);
        } else if (ev.target) {
          const key = normSurface(ev.target);
          if (occ.has(key)) touch(key, sent, wDef);
        }
      } else if (ev.op === 'SIG') {
        // Speech attributed via a pronoun ("he said") is inferred presence;
        // attributed via a name ("Tomas said") is an observation.
        const wSig = isPronoun(ev.speaker) ? ANAPHORA_W() : 1;
        const redirected = hintToKey(ev.speakerHint);
        if (redirected) {
          touch(redirected, sent, wSig);
        } else if (ev.speaker) {
          const key = normSurface(ev.speaker);
          if (occ.has(key)) touch(key, sent, wSig);
        }
      } else if (ev.op === 'NUL' && ev.reason === 'stall' && Array.isArray(ev.competing)) {
        // Measure the stall configuration in this frame: each candidate's
        // decayed state and its overlap with the stalled surface. Readers
        // (the LLM re-collision) consume THIS, not numbers stored at
        // emission — re-colliding under whatever the medium is now.
        frameMeasurements[ev.seq] = {
          competing: ev.competing.map(c => {
            const key = normSurface(c.site || '');
            const root = key ? rFind(key) : null;
            let cm = 0, cp = 0;
            if (root != null && state.has(root)) {
              const s = state.get(root);
              decayTo(s, sent);
              cm = s.mass; cp = s.momentum;
            }
            const ovl = overlapOf(ev.surface, c.siteName || c.site);
            return {
              site: c.site, siteName: c.siteName,
              mass: cm, momentum: +cp.toFixed(3),
              overlap: +ovl.toFixed(3),
              force: +(((cm + cp) * ovl)).toFixed(3),
            };
          }),
        };
      } else if (ev.op === 'EVA' && Array.isArray(ev.deposits)) {
        // A reading act: exogenous energy entering the field. Deposits
        // land as MOMENTUM (attention warms; it doesn't add rest mass),
        // scaled by the reader's CURRENT coupling — so a later REC
        // coupling change re-derives all past deposits honestly on
        // replay. Conservation: shares sum to 1, total energy is the
        // eva_energy_budget constant × coupling. A flat distribution
        // warms every candidate equally and changes no relative pull —
        // abstention without a threshold. And no takebacks: deposits
        // from re-collisions that failed to clear δ stay in the field
        // and tilt subsequent collisions (hysteresis).
        const coupling = (READER_REGISTRY[ev.reader] && READER_REGISTRY[ev.reader].coupling) || 1;
        const E = READING_RULES.eva_energy_budget.value;
        const deps = [];
        for (const d of ev.deposits) {
          const dp = coupling * E * (d.share || 0);
          deps.push({ site: d.site, share: d.share, dp: +dp.toFixed(3) });
          const key = normSurface(d.site || '');
          if (!key || !occ.has(key)) continue;
          const root = rFind(key);
          const s = ensureState(root, sent);
          decayTo(s, sent);
          s.momentum += dp;
        }
        frameMeasurements[ev.seq] = { coupling, energy: E, deposits: deps };
      } else if (ev.op === 'SEG' && Array.isArray(ev.partition)) {
        // Re-split: reset each surface in the partition to its own root.
        // State accumulated up to here stays with whichever root each goes to.
        for (const group of ev.partition) {
          for (const surf of group) {
            replayParent.set(surf, surf);
          }
        }
      }
      // NUL: competing pulls were computed at decision time; leave as-is.
      // REC: operates on the registry, not the field — no-op in replay
      // (its effect is already realized through the coupling read above).
    }

    // Expose final replay state for attachment after pass 3 builds clusterMap.
    // (We can't iterate clusterMap here because it doesn't exist yet.)
    var replayFinalState = state;
    var replayFind = rFind;
  }

  // ── Pass 3: collect clusters by root ──
  const clusterMap = new Map();
  for (const [key, occInfo] of occ) {
    const root = find(key);
    if (!clusterMap.has(root)) {
      clusterMap.set(root, {
        key: root,
        name: occInfo.name,
        type: null,
        mentions: 0,
        eventSeqs: [],
        surfaceForms: new Set(),
        memberKeys: [],
      });
    }
    const cluster = clusterMap.get(root);
    cluster.mentions += occInfo.mentions;
    cluster.eventSeqs.push(...occInfo.eventSeqs);
    for (const sf of occInfo.surfaceForms) cluster.surfaceForms.add(sf);
    cluster.memberKeys.push(key);
    if (occInfo.name.length > cluster.name.length) cluster.name = occInfo.name;
  }

  // Carry type forward from INS events. If member keys in a cluster were
  // INS'd with different types, prefer the more specific (person > place >
  // org > thing).
  const typePriority = { person: 4, place: 3, org: 2, thing: 1 };
  const insTypes = new Map();  // key → type
  const considerType = (k, t) => {
    if (!k || !t) return;
    if ((typePriority[t] || 0) > (typePriority[insTypes.get(k)] || 0)) insTypes.set(k, t);
  };
  for (const ev of events) {
    if (ev.op === 'INS' && ev.entityType) {
      considerType(normSurface(ev.target), ev.entityType);
    }
    // Learned types: speech-induction DEFs and any future type evidence.
    if (ev.op === 'DEF' && ev.path === 'type' && ev.value) {
      considerType(normSurface(ev.target), ev.value);
      if (ev.targetHint && ev.targetHint.key) considerType(ev.targetHint.key, ev.value);
    }
  }
  for (const cluster of clusterMap.values()) {
    let bestType = null, bestScore = 0;
    for (const k of cluster.memberKeys) {
      const t = insTypes.get(k);
      if (t && (typePriority[t] || 0) > bestScore) {
        bestType = t;
        bestScore = typePriority[t] || 0;
      }
    }
    cluster.type = bestType;
  }

  // Apply canonical names from site-layer SYN events (most-recent wins for its cluster).
  for (const ev of events) {
    if ((isSiteSyn(ev) || ev.op === 'MERGE') && ev.canonical && Array.isArray(ev.sites) && ev.sites.length > 0) {
      const root = find(ev.sites[0]);
      const cluster = clusterMap.get(root);
      if (cluster) cluster.name = ev.canonical;
    }
  }

  // Build the key→referent_id map from INS events and gravity-SYN merges.
  // Every INS records the referent_id the reader minted at first commitment.
  // Every gravity-SYN records the referent_id of the absorbed surface and
  // the surviving canonical referent_id. The map preserves the full audit
  // trail: each member key has its own referent_id, and the cluster's
  // canonical_referent_id is the one that survived all the merges.
  const keyToReferent = new Map();
  for (const ev of events) {
    if (ev.op === 'INS' && ev.referent_id) {
      keyToReferent.set(normSurface(ev.target), ev.referent_id);
    }
    if (ev.op === 'SYN' && ev.method === 'gravity' && Array.isArray(ev.referent_ids) && Array.isArray(ev.sites)) {
      // sites[1] is the absorbed surface; referent_ids[1] is its minted id
      if (ev.sites[1] && ev.referent_ids[1]) {
        keyToReferent.set(ev.sites[1], ev.referent_ids[1]);
      }
    }
  }
  // Attach referent metadata to each cluster. canonical_referent_id is the
  // one belonging to the cluster's union-find root key (which is normally
  // the longest name and the original INS site). If the root key was never
  // INS'd directly — e.g., it came in as a DEF target span that was later
  // SYN-merged with a real referent — fall back to the first member that
  // does have a minted referent.
  for (const cluster of clusterMap.values()) {
    cluster.member_referent_ids = cluster.memberKeys
      .map(k => keyToReferent.get(k))
      .filter(Boolean);
    cluster.canonical_referent_id =
      keyToReferent.get(cluster.key) ||
      cluster.member_referent_ids[0] ||
      null;
  }
  // A cluster requires at least one minted referent to exist. If every
  // member surface only appeared as a DEF target span or SYN text-layer
  // slot — never INS'd, never resolved to via a hint — no commitment was
  // ever made to a thing-out-there. Drop these phantom clusters.
  // "In the vicinity of Boguchárovo" and bare possessives like
  // "Princess Mary's" are the typical cases: they pass the surface filters
  // (capital-first, multi-word) but the reader never crossed the threshold
  // of committing to a referent for them.
  for (const [root, cluster] of [...clusterMap.entries()]) {
    if (cluster.member_referent_ids.length === 0) {
      clusterMap.delete(root);
    }
  }

  // Attach derived physics from pass 2.5 replay state to each cluster.
  // Each cluster's mass and momentum reflect the final state after replaying
  // all events under current READING_RULES.
  if (typeof replayFinalState !== 'undefined') {
    for (const cluster of clusterMap.values()) {
      let final = null;
      for (const mk of cluster.memberKeys) {
        const r = replayFind(mk);
        if (replayFinalState.has(r)) { final = replayFinalState.get(r); break; }
      }
      if (final) {
        const γf = READING_RULES.decay_gamma.value;
        const gap = Math.max(0, effectiveNow - final.lastSentence);
        cluster.physics = {
          mass: final.mass,
          momentum: +(final.momentum * Math.pow(γf, gap)).toFixed(3),
          lastSentence: final.lastSentence,
          frame_now: effectiveNow,
        };
      }
    }
  }

  const clusters = [...clusterMap.values()];

  // Learned gender: DEF events with path 'gender' (emitted at reader-
  // deposit signal collapse). The title lexicon stays primary; learned
  // gender fills in where titles are silent. SEG on the collapse is the
  // correction path if the binding that taught it was wrong.
  const learnedGender = new Map();
  for (const ev of events) {
    if (ev.op === 'DEF' && ev.path === 'gender' && ev.target) {
      learnedGender.set(normSurface(ev.target), ev.value);
      if (ev.targetHint && ev.targetHint.key) learnedGender.set(ev.targetHint.key, ev.value);
    }
  }

  const findClusterKey = (surf) => {
    if (!surf) return null;
    const k = normSurface(surf);
    if (parent.has(k)) return find(k);
    for (const cl of clusters) {
      if (cl.surfaceForms.has(surf)) return cl.key;
    }
    return null;
  };

  // ── Pass 4: build edges from text-layer SYN events ──
  const edgeMap = new Map();
  for (const ev of events) {
    if (!isTextSyn(ev)) continue;
    const sSurf = isPronoun(ev.s) && ev.sHint ? ev.sHint.name : ev.s;
    const oSurf = isPronoun(ev.o) && ev.oHint ? ev.oHint.name : ev.o;
    const aKey = findClusterKey(sSurf);
    const bKey = findClusterKey(oSurf);
    if (!aKey || !bKey || aKey === bKey) continue;
    const edgeKey = aKey + '|' + (ev.v || '') + '|' + bKey;
    const cur = edgeMap.get(edgeKey) || { a: aKey, b: bKey, verb: ev.v || '', weight: 0, eventSeqs: [] };
    cur.weight++;
    cur.eventSeqs.push(ev.seq);
    edgeMap.set(edgeKey, cur);
  }

  return {
    entities: clusters.map(c => ({
      key: c.key,
      name: c.name,
      type: c.type,
      gender: genderFromName(c.name) || c.memberKeys.map(k => learnedGender.get(k)).find(Boolean) || null,
      referent_id: c.canonical_referent_id,
      member_referent_ids: c.member_referent_ids,
      physics: c.physics || null,
      mentions: c.mentions,
      surfaceForms: [...c.surfaceForms],
      memberKeys: c.memberKeys,
      eventSeqs: c.eventSeqs,
    })).sort((a, b) => b.mentions - a.mentions),
    edges: [...edgeMap.values()]
      .map(e => ({
        a: e.a,
        b: e.b,
        aName: clusters.find(c => c.key === e.a)?.name || e.a,
        bName: clusters.find(c => c.key === e.b)?.name || e.b,
        verb: e.verb,
        weight: e.weight,
        eventSeqs: e.eventSeqs,
      }))
      .sort((a, b) => b.weight - a.weight),
    measurements: frameMeasurements,
    frame: {
      cursor: isFinite(horizon) ? horizon : 'end-of-text',
      now_sentence: effectiveNow,
      rules_rev: RULES_REV,
      gamma: READING_RULES.decay_gamma.value,
      delta: READING_RULES.inertia_delta.value,
      eva_energy_budget: READING_RULES.eva_energy_budget.value,
      couplings: Object.fromEntries(Object.entries(READER_REGISTRY).map(([k, r]) => [k, r.coupling])),
      note: 'Mass, momentum, force, and overlap are measurements relative to this frame (cursor position + current rules + current couplings), not properties of events. Move the cursor or change a rule and the same log measures differently. Events record only observations and decisions.',
    },
  };
}

  /* ============================================================
     ====================  CLEON ADAPTER  =======================
     Maps the EO graph (events / projectGraph) onto the doc,
     entity, and QA shapes the React UI consumes, and keeps the
     mechanical retrieval / coverage / citation paths.
     ============================================================ */

  /* ---------- document kind ---------- */
  function detectKind(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
    if (lines.length >= 3) {
      const counts = lines.map(l => (l.match(/,/g) || []).length);
      const mode = counts.slice().sort((a, b) => counts.filter(x => x === b).length - counts.filter(x => x === a).length)[0];
      if (mode >= 1 && counts.filter(c => c === mode).length / counts.length >= 0.7) return 'table';
    }
    return 'prose';
  }

  /* ---------- CSV table (Cleon's pivot path, not the graph) ---------- */
  function splitRow(l) {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim()); return out;
  }
  const asNum = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const asDate = (v) => { const t = Date.parse(String(v == null ? '' : v)); return isNaN(t) ? null : t; };

  function parseTable(name, text, id) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
    const columns = splitRow(lines[0]).map((c, i) => c || ('col' + i));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitRow(lines[i]); const row = {};
      columns.forEach((c, ci) => row[c] = cells[ci] == null ? '' : cells[ci]);
      rows.push(row);
    }
    const numeric = [], date = [];
    for (const c of columns) {
      let nu = 0, dt = 0, tot = 0;
      for (const r of rows) { const v = r[c]; if (v === '' || v == null) continue; tot++; if (asNum(v) != null) nu++; if (asDate(v) != null && /[-/:]/.test(String(v))) dt++; }
      if (tot && dt / tot >= 0.6) date.push(c);
      else if (tot && nu / tot >= 0.8) numeric.push(c);
    }
    // Money is a SUBSET of numeric: a numeric column is currency only if its
    // header reads like money or its cells carry a currency symbol. Plain
    // counts ("Units", "Quantity") must not be rendered as dollars. (1c)
    const MONEY_HDR = /price|cost|revenue|amount|total|sales|value|spend|budget|salary|wage|\bfee\b|profit|margin|gross|\bnet\b|usd|eur|gbp|cad|aud|dollar|\$|€|£/i;
    const money = [];
    for (const c of numeric) {
      let sym = 0, tot = 0;
      for (const r of rows) { const v = r[c]; if (v === '' || v == null) continue; tot++; if (/[$€£]/.test(String(v))) sym++; }
      if (MONEY_HDR.test(c) || (tot && sym / tot >= 0.6)) money.push(c);
    }
    return { id, kind: 'table', name, meta: rows.length + ' rows · ' + columns.length + ' cols · table',
             columns, rows, numeric, date, money };
  }

  /* ---------- prose: run the real extractor, shape it for the UI ---------- */
  // Recover paragraph blocks by mirroring extractEoGraph's own
  // paragraph→sentence segmentation, so the global sentence indices line
  // up with result.sentence_texts. Headings come straight from the
  // graph's section decisions.
  function rebuildBlocks(text, sentenceTexts, sections) {
    const headingSet = new Set((sections || []).map(s => s.start_sentence));
    const norm = String(text).replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
    const paras = norm.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const blocks = []; let gi = 0; let titled = false;
    for (const p of paras) {
      let count;
      try { count = (nlp(p).sentences().out('array') || []).filter(s => s.trim()).length || 1; }
      catch (e) { count = 1; }
      const idxs = [];
      for (let k = 0; k < count && gi < sentenceTexts.length; k++) idxs.push(gi++);
      if (!idxs.length) continue;
      if (idxs.length === 1 && headingSet.has(idxs[0])) {
        blocks.push({ type: titled ? 'h2' : 'h1', text: sentenceTexts[idxs[0]] });
        titled = true;
      } else {
        blocks.push({ type: 'p', sentences: idxs.map(i => ({ i, t: sentenceTexts[i] })) });
      }
    }
    if (gi < sentenceTexts.length) {  // defensive: never drop a sentence
      const rest = [];
      for (; gi < sentenceTexts.length; gi++) rest.push({ i: gi, t: sentenceTexts[gi] });
      blocks.push({ type: 'p', sentences: rest });
    }
    return blocks;
  }

  async function parseProse(name, text, id, onProgress) {
    const result = await extractEoGraph(text, onProgress);
    const sentenceTexts = (result.sentence_texts || []).map(s => String(s));
    const sentences = sentenceTexts.map((t, i) => ({ i, t }));
    const blocks = rebuildBlocks(text, sentenceTexts, result.sections);
    // seq → sentence index, so projected entities can list their mentions
    const seqToSent = new Map();
    for (const ev of (result.events || [])) if (ev.sentence_idx != null) seqToSent.set(ev.seq, ev.sentence_idx);
    return {
      id, kind: 'prose', name,
      meta: sentences.length + ' sentences · prose (' + (result.lang || 'en') + ')',
      blocks, sentences, sentenceTexts,
      _events: result.events || [],
      _sections: result.sections || [],
      _lang: result.lang || 'en',
      _seqToSent: seqToSent,
    };
  }

  async function parseDocument(name, text, id, onProgress) {
    const doc = detectKind(text) === 'table'
      ? parseTable(name, text, id)
      : await parseProse(name, text, id, onProgress);
    // retain the source so the UI can re-parse when an extraction-phase rule
    // changes (those decisions are baked into the event log at parse time).
    doc._text = text; doc._name = name;
    return doc;
  }

  /* ---------- Rules drawer ↔ engine bridge ----------
     The UI rule ids differ from the engine's READING_RULES ids; this maps
     the tunable ones across. Replay-phase rules (quote / anaphora coupling,
     γ) re-derive on the next projectEntities via RULES_REV; extraction-phase
     rules (δ, two-sighting, mass_weight, the pronoun gate) are baked into the
     log, so the UI re-parses affected docs after calling this. */
  const UI_TO_RULE = {
    'quote-weight': 'quote_interior_coupling',
    'anaphora-weight': 'anaphora_coupling',
    'pronoun-floor': 'pronoun_resolution_floor',
    'cite-binding': 'audit_bind_floor',
    'paraphrase': 'audit_paraphrase_strong',
    'two-sighting': 'two_sighting_admission',
    'decay-gamma': 'decay_gamma',
    'inertia-delta': 'inertia_delta',
    'eva-energy': 'eva_energy_budget',
    'mass-weight': 'mass_weight',
  };
  function applyRules(uiRules) {
    if (!Array.isArray(uiRules)) return RULES_REV;
    for (const r of uiRules) {
      const id = UI_TO_RULE[r.id];
      if (!id || !READING_RULES[id]) continue;
      if (r.installed === false) continue;
      // a turned-off coupling means "no discount": full-strength mentions
      if (r.enabled === false) {
        if (id === 'quote_interior_coupling' || id === 'anaphora_coupling') READING_RULES[id].value = 1.0;
        else if (id === 'pronoun_resolution_floor') READING_RULES[id].value = 0;
        continue;
      }
      if (r.value != null) { const n = Number(r.value); if (!isNaN(n)) READING_RULES[id].value = n; }
    }
    // refresh the snapshot constants so the next parse reads new physics
    GAMMA = READING_RULES.decay_gamma.value;
    DELTA = READING_RULES.inertia_delta.value;
    MASS_WEIGHT = READING_RULES.mass_weight.value;
    RULES_REV = (RULES_REV + 1) >>> 0;   // invalidate the projection cache
    return RULES_REV;
  }

  // A transmuting DEF changes an ESTABLISHED type/flavor (the significance-layer
  // "weak" law) as opposed to attaching a property. Derived from event provenance,
  // so it never touches the event log. Conserving DEFs (copular class, appositive,
  // married, died, gloss, paren) are NOT transmutations.
  const _TRANSMUTE_SRC = new Set(['speech-induction', 'speech-implies-person', 'pronoun-binding']);
  function isTransmutingDef(ev) {
    if (!ev || ev.op !== 'DEF') return false;
    if (_TRANSMUTE_SRC.has(ev.src)) return true;
    if (ev.path === 'type') return true;                 // explicit type promotion
    return false;
  }

  // ── The layer ladder: the essay's force-count test, made live. ──
  // Counts the distinguishable binding-laws operative at each EO layer
  // (existence → structure → significance) by precondition, and checks the
  // predicted 1-2-1 differentiation rate and monotone cumulative count.
  // Read-only. Returns null for tables / empty prose (the ladder is a
  // narrative instrument). The panel MUST be able to show a mismatch.
  function layerLadder(doc) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return null;
    const ev = doc._events;
    const count = (p) => ev.filter(p).length;
    const { entities } = projectEntities(doc);
    let gentities = [];
    try { gentities = projectGraph(doc._events).entities || []; } catch (e) {}
    // EXISTENCE — confinement: no free unbound surface; a referent had to be
    // sighted to admission (two-sighting gate) to exist at all.
    const admitted = entities.length;
    const confinement = admitted >= 1;
    // STRUCTURE — gravity (proportion / δ): needs ≥2 bodies to relate.
    const absorptions = count(e => e.op === 'SYN' && e.method === 'gravity');
    const gravity = admitted >= 2;
    // STRUCTURE — charge (sign / EM exclusion): a referent carries a sign and a
    // binding was attempted. Same sign repels (gender exclusion in resolution).
    const charged = gentities.filter(e => e.gender).length;
    const genderDefs = count(e => e.op === 'DEF' && e.path === 'gender');
    const charge = charged >= 1;
    // SIGNIFICANCE — weak (flavor change): the lone law that changes an
    // established type. Use the shared transmuting-DEF classifier (WI-4).
    const transmutes = ev.filter(isTransmutingDef);
    const weak = transmutes.length >= 1;
    const laws = {
      existence:    [{ name: 'confinement',          present: confinement, fired: admitted,     note: admitted + ' referents admitted (no free unbound surface)' }],
      structure:    [{ name: 'gravity (δ proportion)', present: gravity,    fired: absorptions, note: absorptions + ' δ-gated absorptions over ' + admitted + ' referents' },
                     { name: 'charge (sign exclusion)', present: charge,    fired: genderDefs,  note: charged + ' referents carry a sign; ' + genderDefs + ' sign assignments' }],
      significance: [{ name: 'weak (flavor change)',  present: weak,        fired: transmutes.length, note: transmutes.length + ' type-changing DEFs' }],
    };
    const perLayerNew = [
      laws.existence.filter(l => l.present).length,
      laws.structure.filter(l => l.present).length,
      laws.significance.filter(l => l.present).length,
    ];
    let acc = 0; const cumulative = perLayerNew.map(n => (acc += n));
    const predicted = [1, 2, 1];
    const rateMatches = JSON.stringify(perLayerNew) === JSON.stringify(predicted);
    const monotone = cumulative.every((v, i) => i === 0 || v >= cumulative[i - 1]);
    return { laws, perLayerNew, cumulative, predicted, rateMatches, monotone };
  }

  /* ---------- projected entity view (events → weighted clusters) ---------- */
  let _projCache = new WeakMap();
  function projectEntities(doc) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return { entities: [], byType: {} };
    // cache per (doc, rules revision): re-project when the ledger moves
    const cached = _projCache.get(doc);
    if (cached && cached.rev === RULES_REV) return cached.view;

    const proj = projectGraph(doc._events);
    const seqToSent = doc._seqToSent || new Map();
    const entities = proj.entities.map(e => {
      const sents = [...new Set((e.eventSeqs || []).map(s => seqToSent.get(s)).filter(x => x != null))].sort((a, b) => a - b);
      const mass = e.physics && e.physics.mass != null ? Math.round(e.physics.mass * 10) / 10 : (e.mentions || sents.length || 1);
      return {
        name: e.name, key: e.key,
        type: (e.type === 'place' || e.type === 'org') ? e.type : 'person',
        raw: e.mentions || sents.length || 1,
        mass, sents,
      };
    }).filter(e => e.sents.length > 0);
    entities.sort((a, b) => b.mass - a.mass || b.raw - a.raw);
    const byType = { person: [], place: [], org: [] };
    for (const e of entities.slice(0, 28)) (byType[e.type] || byType.person).push(e.name);

    const view = { entities, byType };
    _projCache.set(doc, { rev: RULES_REV, view });
    return view;
  }

  function entityDetail(doc, name) {
    const { entities } = projectEntities(doc);
    const e = entities.find(x => x.name === name) || entities.find(x => x.key === String(name).toLowerCase());
    if (!e) return null;
    const co = new Map();
    for (const other of entities) {
      if (other.key === e.key) continue;
      const shared = other.sents.filter(s => e.sents.includes(s)).length;
      if (shared) co.set(other.name, shared);
    }
    const cooc = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { ...e, sentences: e.sents.map(i => ({ i, t: doc.sentenceTexts[i] })), cooc };
  }

  /* ============================================================ RETRIEVAL */
  /* The reading engine is the chat's "unconscious": it runs on every turn
     before the model speaks (route → retrieve → fold/answer → bind). Its
     dominant recurring cost is re-tokenising the whole document inside
     retrieve, which fires several times a turn (routing, context, and once
     per sentence of the model's reply in bindCitations). A sentence's tokens
     depend only on its text and the fixed QA_STOP, so they are invariant for
     the document's lifetime — tokenise once at first contact, reuse forever.
     Keyed by doc identity (WeakMap): a re-parse mints a new doc + fresh
     cache; replay-phase rule changes never touch sentence text. */
  const _sentTokCache = new WeakMap();
  function sentTokSets(doc) {
    let sets = _sentTokCache.get(doc);
    if (sets) return sets;
    sets = doc.sentences.map(s => new Set(tok(s.t)));
    _sentTokCache.set(doc, sets);
    return sets;
  }
  const _bodyLCCache = new WeakMap();
  function docBodyLC(doc) {
    let body = _bodyLCCache.get(doc);
    if (body === undefined) { body = (doc.sentenceTexts || []).join(' ').toLowerCase(); _bodyLCCache.set(doc, body); }
    return body;
  }
  function retrieve(doc, query, k = 6) {
    const qt = new Set(tok(query));
    if (!qt.size) return [];
    const sets = sentTokSets(doc);
    const scored = [];
    const sents = doc.sentences;
    for (let n = 0; n < sents.length; n++) {
      const st = sets[n];
      let overlap = 0; for (const t of qt) if (st.has(t)) overlap++;
      if (!overlap) continue;
      scored.push({ ...sents[n], score: overlap / Math.sqrt(st.size + 1), overlap });
    }
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.slice(0, k);
  }

  /* ============================================================ MECHANICAL QA */
  function coverage(query, supportText) {
    const qt = [...new Set(tok(query))]; if (!qt.length) return { n: 1, d: 1 };
    const st = new Set(tok(supportText));
    const hit = qt.filter(t => st.has(t)).length;
    return { n: hit, d: qt.length };
  }
  // ── Anti-matter referents ───────────────────────────────────────────────
  // A REFERENT is a name the query points at. It has MATTER when the page
  // carries it, and ANTI-MATTER when it doesn't: referenced, but with no
  // presence to bind to. Contact with an anti-matter referent annihilates
  // grounding — it is the ⊥ the void holds on. Consecutive capitals read as one
  // referent ("Amos Dresser"); interrogatives/stopwords (in QA_STOP) are not
  // names. Returns { matter, antimatter } so a hold can say what it CAN see.
  function referents(doc, query) {
    const body = docBodyLC(doc);
    const names = String(query).match(/\p{Lu}[\p{L}’'\-]+(?:\s+\p{Lu}[\p{L}’'\-]+)*/gu) || [];
    const matter = [], antimatter = [];
    for (const raw of names) {
      // a sentence-initial interrogative ("Did Caesar…") is capitalised but is
      // not part of the name — trim stopwords off both ends before deciding.
      const parts = raw.split(/\s+/);
      while (parts.length && QA_STOP.has(parts[0].toLowerCase())) parts.shift();
      while (parts.length && QA_STOP.has(parts[parts.length - 1].toLowerCase())) parts.pop();
      const sig = parts.filter(t => t.length > 2 && !QA_STOP.has(t.toLowerCase()));
      if (!sig.length) continue;
      (sig.some(t => body.includes(t.toLowerCase())) ? matter : antimatter).push(parts.join(' '));
    }
    return { matter, antimatter };
  }
  // the first anti-matter referent (or null) — what the void holds on
  function voidTerm(doc, query) { return referents(doc, query).antimatter[0] || null; }
  function inventedTerms(doc, text) {
    const body = docBodyLC(doc);
    const caps = String(text).match(/\b\p{Lu}[\p{L}’'-]+/gu) || [];
    const out = [];
    for (const c of caps) {
      // "I", "I'm", "I'd", "I'll", "I've" are the capitalized first-person
      // pronoun, never a document entity. The cap-harvest would otherwise flag
      // them as invented and strike them through ("it named I'm…"): QA_STOP holds
      // "i" but not the contracted forms, and the possessive strip only removes
      // 's, so guard the first-person forms explicitly.
      if (/^i(['’](m|d|ll|ve))?$/i.test(c)) continue;
      // Strip a trailing possessive ("Fyodor's" → "Fyodor") before the membership
      // check, so a real entity named in a possessive isn't flagged invented —
      // mirrors the same strip in namesEntity. (1a)
      const bare = c.replace(/['’]s\b/g, '');
      const lc = bare.toLowerCase();
      if (bare.length > 2 && !QA_STOP.has(lc) && !body.includes(lc) && !out.includes(bare)) out.push(bare);
    }
    return out;
  }

  // Mark each invented term as a {{void:term}} so a kept-but-caveated model
  // answer shows the unsupported names struck through rather than passing them
  // off as grounded. Word-boundary, case-insensitive; never re-wraps a term that
  // already sits inside a {{…}} marker. (softened veto)
  function voidInvented(text, terms) {
    let out = String(text == null ? '' : text);
    for (const t of (terms || [])) {
      const term = String(t || '').trim();
      if (term.length < 1) continue;
      // <prev char that isn't a letter / { / :> TERM <not a letter or }> — so we
      // match a standalone word, skip anything already inside a {{…}} marker, and
      // leave a trailing possessive ('s) outside the void.
      const re = new RegExp('(^|[^\\p{L}{:])(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=$|[^\\p{L}}])', 'gu');
      out = out.replace(re, (m, pre, hit) => pre + '{{void:' + hit + '}}');
    }
    return out;
  }

  /* ============================================================ INTENT */
  function classifyIntent(q) {
    const t = ' ' + String(q).toLowerCase().replace(/[’']/g, "'") + ' ';
    if (/\b(who(\s+all)?\s+(appears?|is in|are in|shows? up|features?)|who are the|characters?|the cast|people (in|who)|list (the )?(people|characters|names|figures)|main characters?|dramatis|everyone (in|who))\b/.test(t)) return 'who';
    if (/\b(summar|overview|tl;?dr|gist|recap|in short|main (idea|point|points|theme)|what'?s (it|this)( about)?|what is (this|it|the document|the text|the story|the file)|describe (this|the|it)|the document about|what kind of (document|text)|what am i (looking at|reading))/.test(t)) return 'summary';
    if (/\b(what happens|what'?s going on|the plot|the story|main events|what is happening|walk me through|what'?s in (this|it))/.test(t)) return 'summary';
    // Generative whole-document asks — "write a report about this", "write an
    // essay", "give me a rundown", "write it up". These name no specific passage,
    // so the factual path retrieves a single lexically-overlapping line and the
    // model just parrots it. Route them to the same salient-sample summary path
    // the interrogative overviews above use.
    if (/\b(write|draft|compose|put together|give me|make me|prepare|generate|create)\b[^?!.]*\b(report|essay|summary|overview|synopsis|recap|rundown|write[\s-]?up|breakdown)\b/.test(t)) return 'summary';
    if (/\b(write|report|essay|tell me|talk to me)\b[^?!.]*\babout\s+(this|the\s+(document|text|story|file|piece|passage|reading|script|screenplay|book))\b/.test(t)) return 'summary';
    return 'factual';
  }
  // A generative ask for an artistic form — "write a song/poem/story about
  // this". Distinct from "write a report/essay/summary" (those are overviews,
  // which classifyIntent routes to the summary path); a poem can't be produced
  // by the grounded summary/QA prompt — it just refuses and recycles the
  // summary — so the router sends these to the free-composition path instead.
  function isCreativeCompose(q) {
    const t = ' ' + String(q).toLowerCase().replace(/[’']/g, "'") + ' ';
    return /\b(write|compose|create|make|give|pen)\b[^?!.]*\b(song|songs|poem|poems|sonnet|haiku|limerick|ballad|rap|verse|verses|lyric|lyrics|rhyme|ode|story|tale|jingle|hymn|villanelle|monologue|dialogue)\b/.test(t);
  }
  // The small models loop, emitting the same sentence twice in a grounded
  // summary. Drop a later sentence that repeats one already kept (compared
  // case/space/punctuation-insensitively); distinct sentences and order survive.
  function dedupeSentences(text) {
    const s = String(text == null ? '' : text);
    const parts = s.match(/[^.!?]+[.!?]*\s*/g);
    if (!parts) return s;
    const seen = new Set(); const out = [];
    for (const p of parts) {
      const key = p.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(p);
    }
    return out.join('').trim();
  }
  function salientContext(doc) {
    const picks = new Set();
    for (const b of doc.blocks) if (b.type === 'p' && b.sentences.length) picks.add(b.sentences[0].i);
    [0, 1, 2].forEach(i => doc.sentences[i] && picks.add(doc.sentences[i].i));
    const n = doc.sentences.length; [n - 1, n - 2].forEach(i => i >= 0 && doc.sentences[i] && picks.add(doc.sentences[i].i));
    // Lead with the structural portrait in reader's voice, so the model
    // composes from what the reading noticed rather than echoing a span. The
    // raw spans follow as evidence, but the portrait sets the task.
    const p = graphPortrait(doc);
    const head = p && p.heavy.length
      ? 'What the reading came to rest on: ' + p.heavy.map(e => e.name).join(', ')
        + (p.assertions.length ? '. It took ' + p.assertions.map(a => `${a.name} to be ${a.is}`).join(', ') : '')
        + (p.spine.length > 1 ? '. It moved through: ' + p.spine.join(' → ') : '') + '.\n\n'
      : '';
    const spans = [...picks].sort((a, b) => a - b).slice(0, 16).map(i => `[s${i}] ${doc.sentenceTexts[i]}`).join('\n');
    return head + spans;
  }
  function entityContext(doc) {
    const { entities } = projectEntities(doc);
    return entities.slice(0, 10).map(e => `[s${e.sents[0]}] ${doc.sentenceTexts[e.sents[0]]}`).join('\n');
  }
  function hasGround(doc, q) {
    if (!doc || doc.kind !== 'prose') return true;
    if (classifyIntent(q) !== 'factual') return true;
    return retrieve(doc, q, 6).length > 0 || !!voidTerm(doc, q);
  }

  /* Does this turn seem to be ABOUT the loaded document? This is the only
     routing the chat needs: a "yes" feeds the model the relevant passages
     and binds citations; a "no" is just conversation, handled by the model
     with the running history and no forced grounding. Kept deliberately
     light — false positives drag chit-chat into the page, false negatives
     just mean the user re-asks more explicitly. */
  function namesEntity(doc, q) {
    if (!doc || doc.kind !== 'prose') return false;
    // Strip possessive 's first ("edith's" → "edith") so an entity named in a
    // possessive ("what colour is Edith's car?") still matches the bare name. (1a)
    const ql = ' ' + String(q).toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9'’\- ]+/g, ' ') + ' ';
    const { entities } = projectEntities(doc);
    for (const e of entities) {
      const n = String(e.name).toLowerCase();
      if (n.length >= 3 && ql.includes(' ' + n + ' ')) return true;
      const parts = n.split(/\s+/);
      if (parts.length > 1 && parts.some(p => p.length >= 4 && ql.includes(' ' + p + ' '))) return true;
    }
    return false;
  }
  // Conversation continuity (mechanical, ruliad-driven). A turn that resolves to
  // no subject of its own still belongs to the page when it CONTINUES the prior
  // grounded turn: it carries an anaphor — a pronoun drawn from the ruliad's
  // anaphor_pronouns class, not a hand-written list — and names no new, off-page
  // entity that would pull the topic elsewhere. "tell me more about it", "and
  // what about her?". Inert unless the caller supplies ctx.prevGrounded, so batch
  // callers (parity, bench) see exactly the prior routing.
  function continuesPrior(doc, q, ctx) {
    if (!ctx || !ctx.prevGrounded) return false;
    if (referents(doc, q).antimatter.length) return false;      // introduced a new, absent subject
    const toks = String(q).toLowerCase().replace(/[’']/g, "'").match(/[\p{L}]+/gu) || [];
    return toks.some(t => ANAPHOR_PRONOUNS.has(t));
  }
  function referencesDoc(doc, q, ctx) {
    if (!doc) return false;
    const intent = classifyIntent(q);
    if (intent === 'who' || intent === 'summary') return true;   // asking about the doc
    if (doc.kind === 'table') {
      try { if (!window.parsePivot(q, doc).empty) return true; } catch (e) {}
      const ql = ' ' + String(q).toLowerCase() + ' ';
      if ((doc.columns || []).some(c => ql.includes(' ' + String(c).toLowerCase() + ' '))) return true;
      return continuesPrior(doc, q, ctx);
    }
    if (namesEntity(doc, q)) return true;                        // mentions someone/somewhere in it
    const hits = retrieve(doc, q, 3);                            // or shares real content with the page
    if (hits.length) {
      const top = hits[0];
      if (top.score >= 0.5 || top.overlap >= 2) return true;
      // a real question ("what does the letter say?") that lands on even one word
      // from the page is almost certainly about the page, not chit-chat.
      const isQuestion = /\?\s*$/.test(q) ||
        /^\s*(what|which|whose|where|when|why|how|who|does|did|do|is|are|was|were|can|could|would|should|tell me|describe|explain|list|show|name)\b/i.test(q);
      if (isQuestion && top.overlap >= 1) return true;
    }
    return continuesPrior(doc, q, ctx);                          // a follow-up to a grounded turn
  }
  function answerWho(doc) {
    const { entities } = projectEntities(doc);
    const ppl = entities.filter(e => e.type === 'person');
    const list = (ppl.length ? ppl : entities).slice(0, 8);
    if (!list.length) return { text: 'I didn’t find any named people in this document.', audit: { status: 'notes', grounded: true, covers: '1/1', stable: true, note: 'No entities surfaced under the current rules.' } };
    const text = 'The figures who appear most often: ' + list.map(e => `${e.name} (${e.raw}) {{cite:${doc.id}:${e.sents[0]}:s${e.sents[0]}}}`).join(', ') + '.';
    return { text, cites: list.map(e => ({ docId: doc.id, idx: e.sents[0] })), audit: { status: 'clean', grounded: true, covers: '1/1', stable: true, note: 'Counted directly from the document’s mentions — no model involved.' } };
  }
  // ── The graph's portrait ──────────────────────────────────────────
  // A summary already exists in the graph, unstated: which sites carry the
  // weight, which edges run between them, what the text asserted about them,
  // and the section spine. This takes that photo at the end position and says
  // it in words — mechanically, no model. Ported from eo-extractor.html's
  // graphPortrait(); reads Cleon's projected entities + edges + sections.
  function graphPortrait(doc) {
    if (!doc || doc.kind !== 'prose') return null;
    const { entities } = projectEntities(doc);
    if (!entities.length) return null;
    const heavy = entities.slice(0, 6);
    const heavyKeys = new Set(heavy.map(e => e.key));
    // edges between the heavy sites, by projectGraph (text-layer SYN)
    let edges = [];
    try { edges = (projectGraph(doc._events).edges || []); } catch (e) {}
    const heavyEdges = edges
      .filter(ed => heavyKeys.has(ed.a) && heavyKeys.has(ed.b) && ed.verb)
      .slice(0, 6);
    // DEF assertions the text makes about the heaviest subjects: copular
    // "X is/was Y" and appositive "a TRADE named X" land as DEF path:'class'.
    const defByTarget = new Map();
    for (const ev of (doc._events || [])) {
      if (ev.op !== 'DEF' || ev.path !== 'class' || !ev.value) continue;
      const k = normSurface(ev.target);
      if (!defByTarget.has(k)) defByTarget.set(k, ev.value);
    }
    const assertions = heavy
      .map(e => ({ name: e.name, is: defByTarget.get(e.key) }))
      .filter(a => a.is);
    const spine = (doc._sections || []).map(s => s.label).filter(Boolean).slice(0, 8);
    return { heavy, heavyEdges, assertions, spine };
  }

  // ── The graph, made portable ──────────────────────────────────────
  // A self-contained, JSON-safe snapshot of everything the reading extracted
  // from one document: the entities (with mass + mention sites), the relations
  // between them, the copular assertions, the section spine, the physics frame,
  // and the full event log — "all the processing that took place". This is what
  // the Graph explorer reads and what the unified export writes as a
  // `cleon-graph/1` line. Read-only; never mutates the doc.
  function graphSnapshot(doc) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return null;
    const clone = (v) => { try { return v == null ? v : JSON.parse(JSON.stringify(v)); } catch (e) { return null; } };
    let edges = [], frame = null;
    try { const g = projectGraph(doc._events); edges = g.edges || []; frame = g.frame || null; } catch (e) {}
    const { entities } = projectEntities(doc);
    const p = graphPortrait(doc) || { assertions: [], spine: [] };
    return {
      schema: 'cleon-graph/1',
      at: new Date().toISOString(),
      doc: { id: doc.id, name: doc.name, kind: doc.kind, lang: doc._lang || 'en', sentences: (doc.sentenceTexts || []).length },
      entities: entities.map(e => ({ name: e.name, key: e.key, type: e.type, mentions: e.raw, mass: e.mass, sents: e.sents })),
      edges: edges.map(e => ({ a: e.a, b: e.b, aName: e.aName, bName: e.bName, verb: e.verb, weight: e.weight })),
      assertions: (p.assertions || []).map(a => ({ subject: a.name, is: a.is })),
      spine: p.spine || [],
      frame: clone(frame),
      events: clone(doc._events) || [],
    };
  }

  function answerSummary(doc) {
    const p = graphPortrait(doc);
    if (!p || !p.heavy.length) {
      // Fall back to the old lead-sentence précis only when the graph is too
      // thin to portray (very short or entity-less text).
      const leads = [];
      for (const b of doc.blocks) { if (b.type === 'p' && b.sentences.length) { leads.push(b.sentences[0]); if (leads.length >= 3) break; } }
      if (!leads.length) return { text: 'This document doesn’t have enough prose to summarize.', audit: { status: 'notes', grounded: true, covers: '1/1', stable: true, note: 'Too little text.' } };
      const text = leads.map(s => `${s.t} {{cite:${doc.id}:${s.i}:s${s.i}}}`).join(' ');
      return { text, cites: leads.map(s => ({ docId: doc.id, idx: s.i })), audit: { status: 'notes', grounded: true, covers: '1/1', stable: true, note: 'Too little structure to portray — a précis from the opening lines.' } };
    }
    // Read the portrait in words. Heaviest figures (with anchor citations),
    // what the text asserts about them, the relations between them, the spine.
    const cites = [];
    const figs = p.heavy.map(e => {
      cites.push({ docId: doc.id, idx: e.sents[0] });
      return `${e.name} {{cite:${doc.id}:${e.sents[0]}:s${e.sents[0]}}}`;
    });
    const parts = [];
    parts.push(`This ${doc._lang && doc._lang !== 'en' ? doc._lang + ' ' : ''}document turns most on ${figs.length > 1 ? figs.slice(0, -1).join(', ') + ' and ' + figs[figs.length - 1] : figs[0]}.`);
    if (p.assertions.length) {
      parts.push('It says ' + p.assertions.map(a => `${a.name} is ${a.is}`).join('; ') + '.');
    }
    if (p.heavyEdges.length) {
      parts.push('The relations it draws: ' + p.heavyEdges.map(ed => `${ed.aName} ${ed.verb} ${ed.bName}`).join('; ') + '.');
    }
    if (p.spine.length > 1) {
      parts.push('Its sections: ' + p.spine.join(' · ') + '.');
    }
    return {
      text: parts.join(' '),
      cites,
      audit: { status: 'clean', grounded: true, covers: '1/1', stable: true,
        note: 'Read mechanically from the shape of the whole document — the heaviest figures, what the text asserts about them, and the relations between them. No model involved.' },
    };
  }
  // Coverage ratio (covered query content-terms / total) at or above which an
  // answer is allowed to claim "grounded". Below it the answer is HELD, not
  // green: the closest lines are still shown and cited, but never pass as
  // grounded. Reserves the green chip for answers that actually cover the ask.
  const COVERAGE_FLOOR = 0.5;
  function answerProse(doc, query, opts = {}) {
    // AUDIT-FIRST. A proper noun the query names that is absent from the page is
    // a scoped void — checked BEFORE retrieval, so a stray hit on some unrelated
    // term ("what did Napoleon say to Elena?" landing on an Elena line) can no
    // longer stamp the answer grounded. The void fires even when other terms did
    // match; that is the whole point.
    let { matter, antimatter } = referents(doc, query);
    // Scope-aware voids: when answering inside a multi-source conversation, a
    // name absent from THIS doc but present in another source is not a void — the
    // caller passes the scope-wide anti-matter set as the only terms allowed to
    // void here. The rest move to matter (present somewhere in scope).
    if (opts.voidWhitelist) {
      const present = antimatter.filter(t => !opts.voidWhitelist.has(t));
      antimatter = antimatter.filter(t => opts.voidWhitelist.has(t));
      if (present.length) matter = matter.concat(present);
    }
    if (antimatter.length) {
      // Surface every anti-matter referent as a marked void, and name the
      // present (matter) referents so the hold says what it CAN bind to.
      const voids = antimatter.map(t => `{{void:${t}}}`);
      const list = voids.length > 1 ? voids.slice(0, -1).join(', ') + ' and ' + voids[voids.length - 1] : voids[0];
      const many = antimatter.length > 1;
      const ackn = matter.length ? `${matter.join(' and ')} ${matter.length > 1 ? 'are' : 'is'} on the page, but ` : '';
      return {
        text: `${ackn}${list} ${many ? 'appear' : 'appears'} nowhere in this document. I won’t invent ${many ? 'answers' : 'an answer'} for ${many ? 'terms' : 'a term'} the page doesn’t contain — load a source that mentions ${many ? 'them' : 'it'} and I’ll read ${many ? 'them' : 'it'}.`,
        audit: { status: 'warn', grounded: true, covers: `0/${antimatter.length}`, stable: true,
          note: `Anti-matter referent${many ? 's' : ''} — named in the question, absent from the page.` },
      };
    }
    const hits = retrieve(doc, query, 4);
    if (!hits.length) return {
      text: 'I read the document for that and didn’t find a passage that answers it cleanly, so I’d rather hold than guess. Try naming a person, place, or phrase from the text.',
      audit: { status: 'notes', grounded: true, covers: '0/1', stable: true, note: 'Held rather than invented — the page wouldn’t carry an answer.' },
    };
    const floor = 0.34;
    const used = hits.filter(h => h.score >= floor).slice(0, 3);
    const support = (used.length ? used : hits.slice(0, 1));
    const text = support.map(s => `${s.t} {{cite:${doc.id}:${s.i}:s${s.i}}}`).join(' ');
    const cov = coverage(query, support.map(s => s.t).join(' '));
    const full = cov.n >= cov.d;
    const cites = support.map(s => ({ docId: doc.id, idx: s.i }));
    // COVERAGE GATES THE BADGE. Thin coverage is HELD, not grounded: a "covers
    // 1/4" answer must not wear the same green chip as a "covers 3/3" one.
    if (cov.d && cov.n / cov.d < COVERAGE_FLOOR) return {
      text, cites,
      audit: { status: 'held', grounded: false, covers: `${cov.n}/${cov.d}`, stable: true,
        note: 'These are the closest lines I found, but they don’t cover your question — holding rather than calling this grounded.' },
    };
    return {
      text,
      cites,
      audit: {
        status: full ? 'clean' : 'notes', grounded: true,
        covers: `${cov.n}/${cov.d}`, stable: true,
        note: full ? 'Every claim is read straight from the page; the binding cleared the floor.'
                   : 'Grounded in the passages shown, but not every term in your question is covered.',
      },
    };
  }
  function answerTable(doc, query) {
    const { spec, unbound = [], notes = [] } = window.parsePivot(query, doc);
    // Surface what we couldn't bind instead of dropping it and stamping the
    // answer grounded (rec #3): typo corrections we applied, and column tokens
    // that matched nothing ("by quarter" / "reigon").
    const clarify = [
      ...notes.map(n => n.charAt(0).toUpperCase() + n.slice(1) + '.'),
      ...unbound.map(u => `I don’t see a column called “${u.token}”` + (u.suggestion ? ` — did you mean “${u.suggestion}”?` : ' in this table.')),
    ].join(' ');
    const fold = window.foldPivot(doc, spec);
    const filtNote = (spec.filters || []).length
      ? ' where ' + spec.filters.map(f => `${f.col} = ${f.val}`).join(', ') : '';
    const rowsN = doc.rows.length;
    let summary, produced = true;
    if (fold.kind === 'grouped') {
      const isMoney = fold.isMoneyCol(spec.aggregate && spec.aggregate.col);
      const val = (g) => g.agg.value == null ? g.count : (isMoney ? window.fmtMoney(g.agg.value) : window.fmtNum(g.agg.value));
      const lead = spec.sortBy ? `**${fold.groups[0] && fold.groups[0].key}** leads with ${val(fold.groups[0])}. ` : '';
      summary = lead + `Grouped by **${fold.groupBy}**${spec.aggregate ? `, ${spec.aggregate.op}${spec.aggregate.col ? ' of ' + spec.aggregate.col : ''}` : ''}${filtNote}: `
        + fold.groups.map(g => `${g.key} (${val(g)})`).join(', ') + '.';
    } else if (spec.aggregate) {
      // A measure with no grouping → state the scalar figure directly, rather
      // than reporting a bare row count that never answers the question. (1d)
      const agg = window.aggregate(fold.rows, spec.aggregate);
      const label = spec.aggregate.op + (spec.aggregate.col ? ' of ' + spec.aggregate.col : '');
      if (spec.aggregate.op !== 'count' && agg.value == null) {
        produced = false;
        summary = `I couldn’t compute the ${label}${filtNote} — no numeric values matched.`;
      } else {
        const isMoney = fold.isMoneyCol(spec.aggregate.col);
        const shown = spec.aggregate.op === 'count' ? agg.value
          : (isMoney ? window.fmtMoney(agg.value) : window.fmtNum(agg.value));
        summary = `**${shown}** — the ${label}${filtNote}, over ${fold.total} of ${rowsN} row${rowsN !== 1 ? 's' : ''}.`;
      }
    } else if ((spec.filters || []).length) {
      summary = `**${fold.total}** of ${rowsN} rows match${filtNote}. The matching rows are laid out alongside.`;
    } else {
      produced = false;
      summary = `${fold.total} of ${rowsN} rows. Ask me to group, total, average, or filter and I’ll fold it.`;
    }
    const baseNote = produced ? 'Computed mechanically from ' + doc.name + '.' : 'No measure to compute — showing the matching rows from ' + doc.name + '.';
    return {
      text: summary + (clarify ? '\n\n' + clarify : '') + '\n\nFolded straight from the table — no model touched the numbers. Adjust grouping or measure on the table and it recomputes live.',
      // Only claim full coverage when an actual figure was produced; a bare row
      // listing with no requested measure is not a computed answer (1d). An
      // unbound column token means part of the ask went unhonoured — never green.
      audit: unbound.length
        ? { status: 'notes', grounded: produced, covers: produced ? '1/1' : '0/1', stable: true, note: clarify }
        : produced
          ? { status: 'clean', grounded: true, covers: '1/1', stable: true, note: clarify || baseNote }
          : { status: 'notes', grounded: true, covers: '0/1', stable: true, note: clarify || baseNote },
      tableSpec: spec, openSelf: true,
    };
  }
  function answer(doc, query, opts) {
    if (!doc) return { text: 'Load a document or spreadsheet first — drop a file or paste text, and I’ll read it locally.', audit: null };
    if (doc.kind === 'table') return answerTable(doc, query);
    const intent = classifyIntent(query);
    if (intent === 'who') return answerWho(doc);
    if (intent === 'summary') return answerSummary(doc);
    return answerProse(doc, query, opts);
  }

  /* retrieval context for the optional LLM path — intent-aware */
  function context(doc, query, k = 6) {
    if (!doc || doc.kind === 'table') return '';
    const intent = classifyIntent(query);
    if (intent === 'summary') return salientContext(doc);
    if (intent === 'who') return entityContext(doc);
    return retrieve(doc, query, k).map(s => `[s${s.i}] ${s.t}`).join('\n');
  }
  // bind [sN] citations onto an LLM answer mechanically (model never writes them)
  function bindCitations(doc, answerText, query, intent) {
    const floor = 0.34;
    const clean = answerText.replace(/\[s?\d+\]/gi, '').replace(/\s+([.,;:])/g, '$1').trim();
    const parts = clean.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [clean];
    const cited = [];
    const out = parts.map(sent => {
      const cands = retrieve(doc, sent, 1);
      if (cands.length && cands[0].score >= floor) { cited.push({ docId: doc.id, idx: cands[0].i }); return `${sent.trim()} {{cite:${doc.id}:${cands[0].i}:s${cands[0].i}}}`; }
      return sent.trim();
    }).join(' ');
    const grounded = cited.length > 0 && cited.length >= parts.length * 0.5;
    const cov = (intent && intent !== 'factual') ? { n: 1, d: 1 } : coverage(query, parts.join(' '));
    return {
      text: out, cites: cited,
      audit: {
        status: grounded ? (cov.n >= cov.d ? 'clean' : 'notes') : 'warn',
        grounded, covers: `${cov.n}/${cov.d}`, stable: true,
        note: grounded ? 'Phrased by the local model; every citation bound mechanically to a re-read sentence.'
                       : 'Phrased by the model but support was thin — treat with care.',
      },
    };
  }

  /* ============================================================ MULTI-DOC SCOPE
     The conversation grounds against an EXPLICIT set of source documents (added
     as chips, or pulled in by a project), not whichever tab is focused. These
     fold the single-doc functions over the set, so every single-doc contract —
     citations carry their own docId, anti-matter, coverage gating — carries over.
     A scope of one is byte-identical to the single-doc path. */
  function scopeDocs(docs) { return (Array.isArray(docs) ? docs : [docs]).filter(Boolean); }

  // Does the turn reference ANY source in scope? Continuity ctx applies per-doc.
  function referencesScope(docs, q, ctx) {
    return scopeDocs(docs).some(d => referencesDoc(d, q, ctx));
  }

  // Retrieve across every prose source, tag each hit with its docId, rank
  // globally by the same score the single-doc retriever uses.
  function retrieveScope(docs, query, k = 6) {
    const all = [];
    for (const d of scopeDocs(docs)) {
      if (d.kind === 'table') continue;
      for (const h of retrieve(d, query, k)) all.push({ ...h, docId: d.id });
    }
    all.sort((a, b) => b.score - a.score || a.i - b.i);
    return all.slice(0, k);
  }

  // The single source a turn is most about — strongest retrieval wins, falling
  // back to the first that referencesDoc, then the first in scope. This is where
  // a mechanical (single-doc) answer is grounded.
  function routePrimary(docs, query, ctx) {
    const ds = scopeDocs(docs);
    if (!ds.length) return null;
    let best = null, bestScore = -1;
    for (const d of ds) {
      if (d.kind === 'table') continue;
      const h = retrieve(d, query, 1)[0];
      const s = h ? h.score : 0;
      if (s > bestScore) { bestScore = s; best = d; }
    }
    if (best && bestScore > 0) return best;
    return ds.find(d => referencesDoc(d, query, ctx)) || ds[0];
  }

  // Anti-matter across the whole scope: a named referent is matter if present in
  // ANY source, anti-matter only if absent from EVERY one. "What did Voss say?"
  // over two sources surfaces a void only when Voss is in neither.
  function referentsScope(docs, query) {
    const bodies = scopeDocs(docs).map(d => docBodyLC(d));
    const names = String(query).match(/\p{Lu}[\p{L}’'\-]+(?:\s+\p{Lu}[\p{L}’'\-]+)*/gu) || [];
    const matter = [], antimatter = [];
    for (const raw of names) {
      const parts = raw.split(/\s+/);
      while (parts.length && QA_STOP.has(parts[0].toLowerCase())) parts.shift();
      while (parts.length && QA_STOP.has(parts[parts.length - 1].toLowerCase())) parts.pop();
      const sig = parts.filter(t => t.length > 2 && !QA_STOP.has(t.toLowerCase()));
      if (!sig.length) continue;
      const present = bodies.some(b => sig.some(t => b.includes(t.toLowerCase())));
      (present ? matter : antimatter).push(parts.join(' '));
    }
    return { matter, antimatter };
  }

  // Mechanical answer over the scope. One source → the single-doc path verbatim.
  // Many → answer against the primary, but only flag voids that are absent from
  // EVERY source (a name living in another chip is not a void here). Cross-source
  // synthesis is the model's job (context across sources); this is the floor.
  function answerScope(docs, query) {
    const ds = scopeDocs(docs);
    if (!ds.length) return answer(null, query);
    if (ds.length === 1) return answer(ds[0], query);
    const primary = routePrimary(ds, query) || ds[0];
    if (primary.kind === 'table') return answer(primary, query);
    const voidWhitelist = new Set(referentsScope(ds, query).antimatter);
    return answer(primary, query, { voidWhitelist });
  }

  // LLM context across the scope: passages from each source, headed by its title
  // and tagged [docId:idx] so citations re-bind to the right source. A scope of
  // one defers to the single-doc context unchanged.
  function contextScope(docs, query, k = 6) {
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    if (!ds.length) return '';
    if (ds.length === 1) return context(ds[0], query, k);
    const intent = classifyIntent(query);
    if (intent === 'summary' || intent === 'who') {
      const per = Math.max(2, Math.ceil(k / ds.length));
      return ds.map(d => `## ${d.name}\n${context(d, query, per)}`).join('\n\n');
    }
    const byDoc = new Map();
    for (const h of retrieveScope(ds, query, k)) {
      if (!byDoc.has(h.docId)) byDoc.set(h.docId, []);
      byDoc.get(h.docId).push(h);
    }
    const nameOf = id => (ds.find(d => d.id === id) || {}).name || id;
    return [...byDoc.entries()]
      .map(([id, hs]) => `## ${nameOf(id)}\n` + hs.map(s => `[${id}:${s.i}] ${s.t}`).join('\n'))
      .join('\n\n');
  }

  // Bind {{cite}} markers onto a model answer across the scope: each answer
  // sentence is re-retrieved over every source and bound to the best-matching
  // line, so a multi-source answer carries citations into whichever doc each
  // claim came from. A scope of one defers to the single-doc binder.
  function bindCitationsScope(docs, answerText, query, intent) {
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    if (ds.length <= 1) return bindCitations(ds[0] || scopeDocs(docs)[0], answerText, query, intent);
    const floor = 0.34;
    const clean = answerText.replace(/\[s?\d+\]/gi, '').replace(/\s+([.,;:])/g, '$1').trim();
    const parts = clean.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [clean];
    const cited = [];
    const out = parts.map(sent => {
      const cand = retrieveScope(ds, sent, 1)[0];
      if (cand && cand.score >= floor) { cited.push({ docId: cand.docId, idx: cand.i }); return `${sent.trim()} {{cite:${cand.docId}:${cand.i}:s${cand.i}}}`; }
      return sent.trim();
    }).join(' ');
    const grounded = cited.length > 0 && cited.length >= parts.length * 0.5;
    const cov = (intent && intent !== 'factual') ? { n: 1, d: 1 } : coverage(query, parts.join(' '));
    return {
      text: out, cites: cited,
      audit: {
        status: grounded ? (cov.n >= cov.d ? 'clean' : 'notes') : 'warn',
        grounded, covers: `${cov.n}/${cov.d}`, stable: true,
        note: grounded ? 'Phrased by the local model; every citation bound mechanically to a re-read sentence across your sources.'
                       : 'Phrased by the model but support was thin — treat with care.',
      },
    };
  }

  /* What the engine has LEARNED so far: the speech-verb class it induced
     from the typography of the documents it has read, with each verb's
     accrued mass (its confidence — +1 per confirming sighting). The
     attribution_verbs rule starts empty; this grows as documents are read,
     so it is the legible record of the engine getting smarter over use.
     Read-only projection over the rules ledger — same fold deriveSets uses. */
  function learnedVerbs() {
    const r = projectRules(RULES_LEDGER, currentFrame()).rules.attribution_verbs;
    const mass = (r && r.tokenMass) || {};
    return Object.entries(mass)
      .filter(([, m]) => m > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([verb, m]) => ({ verb, mass: m }));
  }
  // Read-only: count of induced (net-positive) speech verbs per language, from
  // the live fold. A language in Original mode reads 0 (its delta is filtered).
  function learnedVerbsByLang() {
    const r = projectRules(RULES_LEDGER, currentFrame()).rules.attribution_verbs;
    const out = {};
    if (r && r.perBucket) {
      for (const [bucket, pb] of Object.entries(r.perBucket)) {
        const lang = PACK_LANG[bucket];
        if (!lang) continue;                       // skip the 'core' declare bucket
        let n = 0; for (const v of pb.tokens.values()) if (v > 0) n++;
        out[lang] = (out[lang] || 0) + n;
      }
    }
    return out;
  }

  /* ============================================================ COST-ORDERED ROUTING
     existence → structure → significance, cheapest sufficient reader first.
     Returns a DECISION BAND, not a yes/no the model makes:
       decision:'mechanical' — confident it's about the source(s); answer now
                               (mechanical fold/portrait/void, or LLM phrasing).
       decision:'escalate'   — looks doc-directed but lexical signal is weak or
                               absent; the caller may pay for embedding recall
                               (retrieveHybrid) before deciding mechanical vs chat.
       decision:'chat'       — no signal; ordinary conversation with the model.
     confidence: 'high' | 'low' | 'none'. reason: which reader fired.
     This is δ by another name: the cheap reader dominates when its pull is clear;
     the expensive reader only gets a turn on a stall. Pure-mechanical and sync,
     so it never blocks and is parity-safe (the legacy referencesDoc/Scope stay). */
  function routeTurn(docs, q, ctx) {
    const ds = scopeDocs(docs);
    if (!ds.length) return { decision: 'chat', confidence: 'none', reason: 'no-scope' };
    const intent = classifyIntent(q);
    // SIGNIFICANCE — who/summary always belong to the source: the graph portrait
    // is the free mechanical answer, the model (if any) only phrases it.
    if (intent === 'who' || intent === 'summary')
      return { decision: 'mechanical', confidence: 'high', reason: intent, primary: routePrimary(ds, q, ctx), intent };
    // STRUCTURE (table) — a parseable pivot or a named column is an exact lock.
    for (const d of ds) {
      if (d.kind !== 'table') continue;
      try { if (!window.parsePivot(q, d).empty) return { decision: 'mechanical', confidence: 'high', reason: 'pivot', primary: d, intent }; } catch (e) {}
      const ql = ' ' + String(q).toLowerCase() + ' ';
      if ((d.columns || []).some(c => ql.includes(' ' + String(c).toLowerCase() + ' ')))
        return { decision: 'mechanical', confidence: 'high', reason: 'table-column', primary: d, intent };
    }
    // STRUCTURE (entity) — the question names someone/somewhere in a source.
    if (ds.some(d => namesEntity(d, q)))
      return { decision: 'mechanical', confidence: 'high', reason: 'names-entity', primary: routePrimary(ds, q, ctx), intent };
    // STRUCTURE (lexical) — token overlap with the page. Strong overlap is a
    // confident hit (answer now). Weak-but-present is the escalate band.
    const hits = retrieveScope(ds, q, 6);
    if (hits.length) {
      const top = hits[0];
      const isQuestion = /\?\s*$/.test(q) ||
        /^\s*(what|which|whose|where|when|why|how|who|does|did|do|is|are|was|were|can|could|would|should|tell me|describe|explain|list|show|name)\b/i.test(q);
      if (top.score >= 0.5 || top.overlap >= 2 || (isQuestion && top.overlap >= 1))
        return { decision: 'mechanical', confidence: 'high', reason: 'strong-lexical', primary: routePrimary(ds, q, ctx), hits, intent };
      return { decision: 'escalate', confidence: 'low', reason: 'weak-lexical', primary: routePrimary(ds, q, ctx), hits, intent };
    }
    // EXISTENCE — a named referent absent from every source is still doc-directed:
    // answer mechanically so it resolves to the void rather than wandering to chat.
    if (referentsScope(ds, q).antimatter.length)
      return { decision: 'mechanical', confidence: 'high', reason: 'antimatter-void', primary: routePrimary(ds, q, ctx), intent };
    // continuity — an anaphoric follow-up to a prior grounded turn stays on the page.
    if (ds.some(d => continuesPrior(d, q, ctx)))
      return { decision: 'mechanical', confidence: 'high', reason: 'continuity', primary: routePrimary(ds, q, ctx), intent };
    // A doc-directed-looking question with NO lexical signal is the prime case for
    // embedding recall: the locus may be a paraphrase the tokens missed. Escalate.
    const looksQuestiony = /\?\s*$/.test(q) || /^\s*(what|which|whose|where|when|why|how|who)\b/i.test(q);
    if (looksQuestiony) return { decision: 'escalate', confidence: 'low', reason: 'question-no-lexical', intent };
    return { decision: 'chat', confidence: 'none', reason: 'no-signal', intent };
  }

  /* ---- structure-layer recall: lexical-first, embedding on a confident miss ----
     The hybrid retriever. Confident lexical overlap short-circuits with NO
     embedder cost. Only a weak/empty lexical result, AND an available embedder,
     pays for cosine recall — merged behind the lexical hits (lexical is the more
     reliable reader; embedding only ADDS what tokens missed). Async, used by the
     app's escalate path; the sync retrieve()/retrieveScope() are untouched, so
     all golden parity holds. Degrades to pure lexical whenever EOEmbed is absent
     or throws. Sentence vectors are cached per-document (WeakMap); a re-parse
     mints a fresh doc and a fresh cache. */
  const SEM_FLOOR = 0.45;   // cosine below this is not real recall (tunable rule candidate)
  const _docVecCache = new WeakMap();
  async function docSentVectors(doc) {
    if (_docVecCache.has(doc)) return _docVecCache.get(doc);
    if (typeof window === 'undefined' || !window.EOEmbed || !window.EOEmbed.ready()) return null;
    let v = null;
    try { v = await window.EOEmbed.embedSentences(doc.sentenceTexts || []); } catch (e) { v = null; }
    if (v) _docVecCache.set(doc, v);
    return v;
  }
  function _cosineNorm(a, b) { let d = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) d += a[i] * b[i]; return d; }
  async function retrieveHybrid(docs, q, k = 6) {
    const ds = scopeDocs(docs);
    const lex = retrieveScope(ds, q, k).map(h => ({ ...h }));
    // confident lexical → done, no embedder cost (cost-ordered short-circuit)
    if (lex.length && (lex[0].score >= 0.5 || lex[0].overlap >= 2)) return { hits: lex, reader: 'lexical' };
    if (typeof window === 'undefined' || !window.EOEmbed || !window.EOEmbed.ready()) return { hits: lex, reader: 'lexical' };
    try {
      const qv = await window.EOEmbed.embedQuery(q);
      if (!qv) return { hits: lex, reader: 'lexical' };
      const sem = [];
      for (const d of ds) {
        if (d.kind === 'table') continue;
        const vecs = await docSentVectors(d);
        if (!vecs) continue;
        for (let i = 0; i < vecs.length; i++) {
          const s = _cosineNorm(qv, vecs[i]);
          if (s >= SEM_FLOOR) sem.push({ i, t: (d.sentenceTexts || [])[i], score: s, overlap: 0, docId: d.id, semantic: true });
        }
      }
      sem.sort((a, b) => b.score - a.score);
      const seen = new Set(lex.map(h => h.docId + ':' + h.i));
      const merged = lex.slice();
      for (const h of sem) { const key = h.docId + ':' + h.i; if (!seen.has(key)) { seen.add(key); merged.push(h); } if (merged.length >= k) break; }
      return { hits: merged.slice(0, k), reader: sem.length ? 'lexical+embedding' : 'lexical' };
    } catch (e) { return { hits: lex, reader: 'lexical' }; }
  }
  // Build an LLM context string from an explicit hit list (used by the escalate
  // path so semantically-recovered spans actually reach the model). Mirrors the
  // [docId:idx] tagging contextScope uses across multiple sources.
  function contextFromHits(docs, hits) {
    const ds = scopeDocs(docs);
    if (!hits || !hits.length) return '';
    if (ds.length === 1) return hits.map(h => `[s${h.i}] ${h.t}`).join('\n');
    const nameOf = id => (ds.find(d => d.id === id) || {}).name || id;
    const byDoc = new Map();
    for (const h of hits) { if (!byDoc.has(h.docId)) byDoc.set(h.docId, []); byDoc.get(h.docId).push(h); }
    return [...byDoc.entries()].map(([id, hs]) => `## ${nameOf(id)}\n` + hs.map(h => `[${id}:${h.i}] ${h.t}`).join('\n')).join('\n\n');
  }

  /* ============================================================ EXPORT */
  window.EOEngine = {
    parseDocument, projectEntities, entityDetail, retrieve, answer,
    context, bindCitations, tok, classifyIntent, hasGround, referencesDoc, inventedTerms,
    applyRules, voidInvented, isCreativeCompose, dedupeSentences,
    // the extracted graph: a portrait, and a portable per-doc snapshot (explorer + export)
    graphPortrait, graphSnapshot,
    // multi-doc scope: ground a conversation against an explicit set of sources
    referencesScope, retrieveScope, routePrimary, referentsScope, answerScope,
    contextScope, bindCitationsScope,
    // cost-ordered routing (existence → structure → significance) + embedding recall
    routeTurn, retrieveHybrid, contextFromHits,
    // the layer ladder: the essay's 1-2-1 force-count test, made live + falsifiable,
    // and the transmuting-DEF classifier (the significance-layer "weak" law)
    layerLadder, isTransmutingDef,
    // expose the raw graph engine for future operator-void / shape work
    _extractEoGraph: extractEoGraph, _projectGraph: projectGraph,
    // per-language reading mode: Original (shipped-only, frozen) vs Self-learning
    setLanguageModes, languageModes,
    // read-only: the induced speech-verb class + accrued mass (learning record)
    _learnedVerbs: learnedVerbs, learnedVerbsByLang,
    // persistence: serialize/restore the learned ledger delta (host stores it)
    _serializeLedger, _restoreLedger,
  };
})();
