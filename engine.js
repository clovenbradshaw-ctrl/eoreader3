/* ============================================================
   Cleo reading engine — the real EO graph extractor.

   Ported from eo-extractor.html: the language packs, the rules
   ledger, extractEoGraph (the nine EO operators — NUL/SIG/INS/
   SEG/CON/SYN/DEF/EVA/REC), and projectGraph (events → entities).
   A thin adapter at the bottom maps the graph to the doc / entity /
   QA shapes the Cleo UI consumes, and keeps the mechanical
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
  // A hyphenated compound also yields its parts ("neuve-sainte-genevieve" →
  // + neuve, sainte, genevieve). The entity extractor admits surfaces from
  // inside compounds, so retrieval must reach inside them too — otherwise an
  // entity the graph ranks heavily ("Genevieve", from the street name) is
  // unreachable by every query that names it.
  const tok = (s) => {
    const raw = (String(s).toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || [])
      .map(t => t.replace(/['’]s$/, ''));
    const out = [];
    for (const t of raw) {
      out.push(t);
      if (t.includes('-')) for (const p of t.split('-')) out.push(p);
    }
    return out.filter(t => t.length > 2 && !QA_STOP.has(t));
  };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* ============================================================
     ===============  REAL ENGINE (ported verbatim)  ============
     ============================================================ */
// DISCOURSE_JUNK / ANSWER_DISCOURSE / STRUCTURE_LABELS are CONVENTIONS —
// they live in READING_RULES (discourse_junk / answer_discourse /
// structure_labels) and in memory/conventions.jsonl, and are rebuilt into the
// live Sets by rebuildLangSets. Assertions, contextual and revisable — not
// constants.


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
// el-classical-v1 organ tables, built from the Greek pack when it loads (see
// loadConventionPacks / buildGreekOrgans). Null ⇒ every Greek organ is a no-op,
// so nothing here touches a non-Greek reading.
let GREEK = null;
function detectLanguage(text) {
  const s = String(text);
  const sample = s.slice(0, 6000);
  let han = 0, grk = 0, total = 0;
  for (const ch of sample) { if (/\s/.test(ch)) continue; total++; if (/[\u4e00-\u9fff]/.test(ch)) han++; else if (/[\u0370-\u03ff\u1f00-\u1fff]/.test(ch)) grk++; }
  if (total > 0 && han / total > 0.05) return 'zh';
  // Greek script (Greek+Coptic and the polytonic Greek Extended block) selects
  // the el-classical-v1 pack. Disjoint from Latin/Han, so this never fires on
  // the en/es/zh/code corpora \u2014 the Greek organs stay inert for them.
  if (total > 0 && grk / total > 0.05) return 'grc';
  const lines = sample.split('\n');
  const codey = lines.filter(l => /[{};]\s*$|^\s*(function|const|let|var|class|def|import|return|if\s*\(|for\s*\()\b|=>/.test(l)).length;
  if (codey >= 3 && codey / Math.max(1, lines.filter(l => l.trim()).length) > 0.25) return 'code';
  // Spanish only on genuinely Spanish-exclusive signal: ñ or inverted
  // punctuation are near-unique; otherwise require several Spanish
  // function words that are NOT English homographs. "don" is excluded —
  // it matches inside "don't" — and é/ü alone are loanword noise.
  // CSV: several rows of consistent comma-delimited fields. Prose has
  // irregular comma counts; a table does not. Timecode cue lines
  // ("0:00:14.240,0:00:16.560") carry one comma each and would read as a
  // consistent table — a transcript's typography, not a schema.
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length >= 3 && countTimecodeLines(sample) < 3) {
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

/* ---------- transcript reading (a genre pack on English) ----------
   A transcript declares itself through its own typography: timecode lines
   ("0:00:14.240,0:00:16.560", "00:00:14,240 --> 00:00:16,560", "[00:14]"),
   SRT cue counters, and "Speaker N:" / "NAME:" turn labels. That typography
   is STRUCTURE, not prose — read as narrative it poisons the graph at birth:
   timecodes become sentence content, "Speaker" becomes a two-sighting entity,
   and the one structure a transcript has in abundance (who is speaking when)
   is thrown away. The reader here does what the other packs do for their
   languages: timecode lines are boundaries, never sentences; speaker labels
   are attribution — the same SIG events the quote machinery mints, arriving
   through a different typographic slot. The grammar (the nine operators)
   stays the shared core. */
const _TC = '\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,3})?';
const TC_LINE_RE = new RegExp('^\\s*(?:\\[' + _TC + '\\]|\\(' + _TC + '\\)|' + _TC + ')(?:\\s*(?:-->|–|—|,)\\s*(?:\\[?' + _TC + '\\]?))?\\s*$');
const TC_LEAD_RE = new RegExp('^\\s*(?:\\[' + _TC + '\\]|\\(' + _TC + '\\))\\s*');
const TRANSCRIPT_HEADER_LABELS = new Set(['webvtt', 'kind', 'language', 'style', 'region']);
// Active for the duration of one extraction (same lifecycle as ACTIVE_LANG):
// gates the transcript-only surface filters in entity admission.
let TRANSCRIPT_ACTIVE = false;
// Formulaic discourse a transcript is full of ("Thank you.", "Okay.") — these
// open sentences capitalized, recur past the two-sighting gate, and are never
// referents. Checked only in entity admission while a transcript is active.
// TRANSCRIPT_FORMULA is the transcript_formula convention (see rebuildLangSets).
// How many timecode-shaped lines the head of the text carries. Used to keep
// the comma-mode CSV/table detectors from reading "0:00:14.240,0:00:16.560"
// rows as a spreadsheet, and by the transcript decision itself.
function countTimecodeLines(text) {
  let n = 0;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n', 400);
  for (const l of lines) { const t = l.trim(); if (t && TC_LINE_RE.test(t)) n++; }
  return n;
}
// A "Name:"-slot turn label, or null. The slot is narrow on purpose: short,
// starts uppercase, plain name characters, not document apparatus ("Note:",
// "Summary:") and not a lone stopword ("So:", "He:").
function transcriptLabel(line) {
  const m = /^([^:]{1,40}):\s*(.*)$/.exec(String(line));
  if (!m) return null;
  const label = m[1].trim();
  if (!/^\p{Lu}/u.test(label)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’\-]*$/u.test(label)) return null;
  const words = label.split(/\s+/);
  if (words.length > 5) return null;
  const lc = label.toLowerCase();
  if (TRANSCRIPT_HEADER_LABELS.has(lc) || STRUCTURE_LABELS.has(lc)) return null;
  if (words.length === 1 && QA_STOP.has(lc)) return null;
  return { label, rest: m[2] };
}
// Decide whether the text reads as a transcript and, if so, normalize it:
// returns { text, turns, speakers, cues, labelled } where `text` carries one
// paragraph per turn (labels and timecodes removed — they became structure)
// and turns[i] aligns with the i-th non-empty paragraph. Null when the page
// does not declare the genre.
function readTranscript(raw) {
  const rawLines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  // ── the decision: enough cue typography, or enough recurring turn labels ──
  let cues = 0, labelled = 0, content = 0;
  const labelCounts = new Map();
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (!t) continue;
    if (/^WEBVTT\b/.test(t)) { cues++; continue; }
    if (TC_LINE_RE.test(t)) { cues++; continue; }
    if (/^\d{1,4}$/.test(t) && rawLines[i + 1] && TC_LINE_RE.test(rawLines[i + 1].trim())) continue; // SRT counter
    const lab = transcriptLabel(t.replace(TC_LEAD_RE, ''));
    if (lab) { labelled++; const k = lab.label.toLowerCase(); labelCounts.set(k, (labelCounts.get(k) || 0) + 1); }
    content++;
  }
  const recurring = [...labelCounts.values()].filter(n => n >= 2).length;
  const isTranscript = (cues >= 3 && content > 0)
    || (recurring >= 2 && labelled >= 4 && labelled / Math.max(1, content) >= 0.3);
  if (!isTranscript) return null;
  // ── normalization: cues out, labels into attribution, one paragraph per turn ──
  const turns = [];
  let cur = null, sawCueBreak = false;
  const open = (speaker) => { cur = { speaker: speaker || null, lines: [] }; turns.push(cur); };
  for (let i = 0; i < rawLines.length; i++) {
    let t = rawLines[i].trim();
    if (!t) { sawCueBreak = true; continue; }
    if (/^WEBVTT\b/.test(t)) continue;
    if (TC_LINE_RE.test(t)) { sawCueBreak = true; continue; }
    if (/^\d{1,4}$/.test(t) && rawLines[i + 1] && TC_LINE_RE.test(rawLines[i + 1].trim())) continue;
    t = t.replace(TC_LEAD_RE, '').trim();
    if (!t) { sawCueBreak = true; continue; }
    const lab = transcriptLabel(t);
    if (lab) {
      open(lab.label);
      if (lab.rest) cur.lines.push(lab.rest);
      sawCueBreak = false;
      continue;
    }
    // Unlabeled content stays with the voice that holds the floor. With no
    // voice on the floor (cue-only captions), a cue boundary after a closed
    // sentence starts a fresh paragraph, so a caption stream still segments.
    if (!cur) open(null);
    else if (cur.speaker == null && sawCueBreak && cur.lines.length
             && /[.!?…]["'”’)]?$/.test(cur.lines[cur.lines.length - 1])) open(null);
    cur.lines.push(t);
    sawCueBreak = false;
  }
  const cleanTurns = turns
    .map(t => ({ speaker: t.speaker, text: t.lines.join(' ').replace(/\s+/g, ' ').trim() }))
    .filter(t => t.text);
  if (!cleanTurns.length) return null;
  const speakers = [...new Set(cleanTurns.map(t => t.speaker).filter(Boolean))];
  return { text: cleanTurns.map(t => t.text).join('\n\n'), turns: cleanTurns, speakers, cues, labelled };
}

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
      'female_pronouns', 'male_pronouns', 'kin_terms',
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
  kin_terms: {
    value: ['son','daughter','father','mother','brother','sister','wife','husband','uncle','aunt','nephew','niece','cousin','grandfather','grandmother','grandson','granddaughter','parents','children','child','sons','daughters','brothers','sisters','widow','widower','stepson','stepdaughter','stepfather','stepmother'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Kinship nouns. A possessive pronoun + kin noun ("his son", "her mother") names a relation the page never states as a copula — the possessor is resolved by activation and the relation recorded as a kin DEF, so "whose son is mentioned?" is answerable from the graph instead of stranding on an unresolved pronoun.',
  },
  // ── Depicted acts — the story-world transformation a clause REPORTS, carried
  //    as content on the reader's CON bond. The bond's own op is always CON (the
  //    reading act of binding two referents); the verb may report a SEG (a cut),
  //    a SYN (a fusion: marry/merge), or no transformation at all (a stative
  //    relation is a pure Site-face fact). A verb in none of these classes stays
  //    unclassified — the reader hasn't committed to a depicted address.
  depict_seg_verbs: {
    value: ['cut','sever','break','split','divide','separate','tear','slice','snap','shatter','smash','cleave','rip','sunder','detach','dissect','fracture','dissolve','scatter','crack','chop','carve','breach','rupture','partition','kill','destroy'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Verbs whose depicted act is a SEG — differentiation applied to structure: a connection severed. The bond stays op:CON (the reader connects); depicts:{op:"SEG",obj:"figure"} is the content it carries.',
  },
  depict_syn_verbs: {
    value: ['marry','wed','merge','unite','fuse','weld','combine','blend','amalgamate','join','assemble','unify','incorporate','integrate','annex','absorb','knit','bind','bond','couple'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Verbs whose depicted act is a SYN — a fusion producing a new unit (marry, merge, unite). Distinct from the reader\'s own SYN (coreference); this is the story\'s. depicts:{op:"SYN",obj:"figure"}.',
  },
  depict_state_verbs: {
    value: ['own','possess','contain','hold','include','comprise','belong','resemble','equal','know','believe','love','hate','want','need','fear','understand','mean','represent','constitute','consist','involve','concern','regard'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Verbs reporting a STATE, not an event: a standing relation with no transformation. States get a terrain (Site) address and no operator — depicts:{state:true}. (Copulas and have/be are filtered before CON, so these are the non-copular statives that still reach a bond.)',
  },

  // ── Production guards — conventions of the reading's own hygiene ──
  // Assertions, contextual and revisable: each is what THIS reader currently
  // takes a class of surfaces to mean, not a fact about language.
  discourse_junk: {
    value: ['today','yesterday','tomorrow','now','then','here','there','meanwhile','however','moreover','furthermore','therefore','also','still','yet','according','reportedly','apparently','allegedly','monday','tuesday','wednesday','thursday','friday','saturday','sunday','january','february','march','april','may','june','july','august','september','october','november','december','not','almost','because','while','since','although','though'],
    mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Discourse and calendar words that capitalize at sentence start and read as proper nouns to NER. Never referents.',
  },
  answer_discourse: {
    value: ['yes','yeah','indeed','certainly','sure','absolutely','exactly','correct','agreed','unfortunately','additionally','finally','similarly','specifically','notably','importantly','overall','instead','otherwise','nevertheless','nonetheless','accordingly','consequently','thus','hence','besides','actually','generally','typically','usually','ultimately','alternatively','likewise','regardless'],
    mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Words an ANSWER opens with ("Yes, Amos Dresser is…"). Checked only in the draft-side veto, never in admission — a word about the answer, not a claim about the page.',
  },
  structure_labels: {
    value: ['figure','fig','plate','table','exhibit','diagram','chart','appendix','addendum','chapter','section','subsection','paragraph','page','note','notes','footnote','endnote','caption','sidebar','summary','abstract','overview','preface','foreword','afterword','prologue','epilogue','introduction','conclusion','contents','index','glossary','bibliography','references','errata','timeline','archival','digitization','digitisation','foundation','collection','collections'],
    mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Document apparatus / OCR section labels ("Figure 4", "Appendix B"). Chrome, not referents; a multi-word name like "Ford Foundation" still admits because only the bare label matches.',
  },
  transcript_formula: {
    value: ['thank','thanks','thank you','okay','ok','yes','yeah','no','well','good','right','hello','hi','sorry','please','amen','aye','nay','um','uh','huh','hmm','bye','goodbye','welcome','correct','exactly','absolutely','sure','alright'],
    mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Formulaic transcript discourse ("Thank you.", "Okay.") that opens sentences capitalized and recurs past the two-sighting gate — politeness, not a referent. Checked only while a transcript is active.',
  },
  generic_voice_heads: {
    value: ['speaker','voice','interviewer','interviewee','moderator','participant','panelist','operator','announcer','narrator','caller','host','guest','male','female','unknown','unidentified','audience','translator','interpreter'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Role-word heads of generic voice labels ("Speaker 2", "Female Voice"). The label is a real voice; its HEAD is a role word, not a name — part-matching skips these so "speaker" in a user message cannot hijack routing onto "Speaker 2".',
  },
  gutenberg_boilerplate: {
    value: ['project gutenberg','gutenberg','project gutenberg-tm','gutenberg-tm','ebook','ebooks','posting date','release date','start of','end of','public domain','foundation','project gutenberg literary archive foundation'],
    mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Gutenberg header/license apparatus that frequency-counting surfaces as "characters" ("Project Gutenberg", "Posting Date"). Applied only when the document detects as a Gutenberg text — on any other document, a company named Foundation stays a referent.',
  },
  gutenberg_start_markers: {
    value: ['/\\*{3}\\s*START OF TH(?:E|IS) PROJECT GUTENBERG[^*]*\\*{3}/i'],
    mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Regex sources (/pattern/flags form) for the Project Gutenberg START marker — the line that closes the header apparatus and opens the work. The wrapper gate matches one to switch from header to body; the match POSITION also strips the header-and-marker prefix when the marker is fused into the same sentence as the opening prose, so the body that follows is read, not swallowed. Sibling of chrome_patterns: line shapes the reading treats as apparatus, grown the same way. Empty inventory ⇒ no document is wrapper-gated (the parity floor).',
  },
  gutenberg_end_markers: {
    value: ['/\\*{3}\\s*END OF TH(?:E|IS) PROJECT GUTENBERG[^*]*\\*{3}/i'],
    mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Regex sources (/pattern/flags form) for the Project Gutenberg END marker — the line that closes the work and opens the license footer. The wrapper gate matches one to switch from body to footer; the match POSITION strips the marker-and-footer suffix when it is fused after trailing body prose. Sibling of gutenberg_start_markers. Empty inventory ⇒ the footer boundary is never gated.',
  },
  place_org_cues: {
    value: ['street','st','road','rd','avenue','ave','lane','river','sea','ocean','bay','gulf','point','cape','harbou?r','island','isle','mount','mountain','valley','county','shire','city','town','village','company','corporation','commission','board','department','office','firm','llc','inc','ltd','co','university','college','school','hospital','church','park','square','hall','palace','castle','bridge','station','hotel','club','society','association','league','union','party','court','bank','press','times','gazette','journal','ministry','bureau','agency','institute','foundation'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Surface cues that mark a proper name as NOT a person (regex alternates). Guards person-promotion so a river or a firm never becomes a character.',
  },
  eva_machinery_terms: {
    value: ['mass','momentum','gravity','coupling','frame','rules_rev','NUL','SIG','INS','SEG','CON','SYN','DEF','EVA','REC'],
    mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'The machinery vocabulary the talker must never speak. EVA rejects a draft that leaks any of these — the reading describes the page, never its own physics.',
  },
  eva_veto_lexicon: {
    value: [],
    mass: 0, layer: 'significance', src: 'learned', module: 'core',
    desc: 'Terms learned from repeated EVA failures — the model\'s recurring tics (names it keeps inventing, framings it keeps slipping into), admitted on the second sighting like any induced rule. Each admission is a contextual neuron: it feeds back into the veto and the retry prompt, and its REC (with register affinity) is the hydration record appended to memory/conventions.jsonl. Starts EMPTY: the lexicon is grown, never seeded.',
  },
  role_clause_verbs: {
    value: ['runs?','running','leads?','leading','heads?','heading','chairs?','chairing','manages?','managing','directs?','directing','oversees?','overseeing','owns?','owning','operates?','operating','founded','co-founded','controls?','controlling','commands?','commanding','supervises?','supervising'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Verb forms whose relative clause states a ROLE rather than an act ("who runs the DMC", "who heads the council"). The naming bridge distills these into role DEFs. Regex alternates, joined verbatim — holding a position, not one-off doing.',
  },
  role_title_heads: {
    value: ['president','vice[- ]president','ceo','cfo','coo','cto','chief\\s+\\p{L}+(?:\\s+officer)?','chair(?:man|woman|person)?','executive\\s+director','managing\\s+(?:director|partner)','general\\s+manager','director','head','founder','co-founder','owner','commissioner','superintendent'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Title-of heads: "<head> of X" names a role ("president of the partnership"). Regex alternates, joined verbatim.',
  },
  role_title_prefixes: {
    value: ['former','interim','acting','deputy'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Qualifiers that may lead a title-of head without breaking it ("former president of …").',
  },
  neutral_person_pronouns: {
    value: ['they','them','their','theirs'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Third-person pronouns that refer to a person WITHOUT marking gender. Animate like he/she (they can bind and promote a proper name to a person), but they teach no gender — a singular-they referent stays a genderless person. Whether they may be read as SINGULAR for a named individual is the register call below (singular_they).',
  },
  singular_they: {
    value: false, mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'May "they/them" be read as a SINGULAR reference to one named person (and so bind/promote that person)? This is a convention of register, not a universal: contemporary journalism and prose use singular they for a known individual; 19th-century narrative (the texts this module reads — Conrad, Balzac, Tolstoy) almost always means a plural by "they", so reading it as singular would wrongly fuse a group into one character. Default OFF here; a modern-register language module turns it ON. Gendered he/she promotion is unaffected — it is unambiguously singular in every register.',
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
  lowercase_evidence_disqualify: {
    value: true, mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'A single-token capitalized surface whose word also appears lowercase in the same document is a common noun the capital dressed up — "Darkness", "Nature", "But" — not a name: a genuine proper noun almost never occurs lowercased on the same page. The text grades itself; no lexicon. Costs the rare character actually named with a common word ("Grass") in a document that also uses the word; multi-word surfaces are untouched.',
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

  // ── English grammatical inventories — lifted out of inline engine code so
  //    the reading paths carry no hardcoded language. Each is a convention the
  //    en module supplies and empties for a non-English register (the way
  //    kin_terms / depict_* / role_* already do), so a pack can override it.
  //    See rebuildLangSets for where each becomes a live Set / RegExp.
  copular_verbs: {
    value: ['is','was','are','were','am','been','being','becomes?','became','remained?','remains'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Copular / linking verb forms (regex alternates, joined verbatim into a ^(…)$ test). A clause whose predicate is a copula states a definition ("Sam Gor IS a syndicate"), not an act with a depicted address — the SVO readers skip it so a copula never mints a bogus relation edge. English inventory; a non-English register supplies its own (ser/estar, 是).',
  },
  auxiliary_verbs: {
    value: ['have','has','had','do','does','did','got','get','be','been','being'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Auxiliary / light verb forms (regex alternates). A clause whose head verb is a bare auxiliary carries no act of its own, so the SVO readers and the relation gate skip it rather than read "has" / "did" as a predicate. English inventory.',
  },
  deictic_pronouns: {
    value: ['i','we','you','us','me'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'First- and second-person pronouns. Deictic: they resolve by speech context (who addresses whom), not by narrative momentum, so the activation resolver never binds them to the warmest site. English inventory; a pack supplies its own (yo/tú, 我/你).',
  },
  title_case_minor_words: {
    value: ['a','an','the','and','or','nor','of','to','in','on','at','by','for','with','from','as','vs','via','per'],
    mass: 1, layer: 'existence', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Minor words a Title Case heading leaves lowercase ("of", "the"). The paragraph unwrapper counts a line as a heading when nearly every word is capitalized OR one of these, so a hard-wrapped prose line is not mistaken for a title and split. English title-case convention.',
  },
  relation_gate_stopwords: {
    value: ['the','a','an','his','her','their','its','this','that','of','to','own','mr','mrs'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Function words and bare titles dropped when the relation gate tokenizes a subject / object for subset comparison, so "his family" and "the family" align on "family". English inventory; the gate is inert unless relation_gate is ON.',
  },
  relation_gate_pronouns: {
    value: ['he','she','it','they','him','her','them','his','hers','their','its','i','we','you','who','whom','that','this','those','these','me','us','one','nobody','everyone','someone'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Pronoun and indefinite surfaces (regex alternates) the relation gate treats as un-nameable subjects: a claim whose subject is one of these carries no relational verdict (nothing to align against an edge). English inventory.',
  },
  relation_gate_attribution_verbs: {
    value: ['said','says','say','answered','replied','wrote','called','told','asked','exclaimed','shouted','whispered','muttered','added','stated','noted','remarked','commented','argued'],
    mass: 1, layer: 'structure', src: 'language-module:en-narrative-v1', module: 'en-narrative-v1',
    desc: 'Speech verbs the relation gate recognizes when binding a quoted clause to its speaker — a fixed inventory (distinct from the induced attribution_verbs class) used only on the gated path. English inventory.',
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

  // ── Provenance-anchored conventions — the proposal channel's physics ──
  provenance_weighting: {
    value: false, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'When ON, a convention\'s projected mass is the sum over its provenance anchors — coupling × independence × decay × register fit — instead of flat seed authority. OFF ships today\'s behavior byte-identical (the parity floor); flip when the fixture battery and corpus quality scores hold under the anchor-sum projection. Admission gating of PROPOSED conventions is not behind this flag: an uncorroborated signal never applies at any setting.',
  },
  theta_admit: {
    value: 2.0, mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Admission threshold for a proposed convention: the sum of independent-anchor couplings (one per distinct span hash) must reach this, across ≥ 2 distinct spans, with at least one non-model witness. At 2.0: two document witnesses, or one document plus the model\'s evidence spans, or a user confirmation instantly. A tunable rule, like the two-sighting law it generalizes.',
  },
  // ── Relation gate — the relational cure (agency inversion) ──────
  relation_gate: {
    value: false, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'When ON, provenance binds at generation (the model tags each claim with the span id it used; bindClaimKeys consumes the tags and the old binder is fallback for unkeyed claims only) and every draft claim\'s subject–predicate–object is checked against the relations the graph deposited — a claim whose subject inverts against its edge, or names a figure the edge does not carry, is held and flagged relation-mismatch. OFF ships today\'s behavior byte-identical (the parity floor); flip after the parallel golden on the journalism + essay fixtures diffs clean.',
  },
  relation_align_floor: {
    value: 0.45, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Below this, a claim surface does not align to an edge slot at all. Alignment is lexical-first (token subset = 1; two distinct named figures never embed-align — measured: name↔name cosine ≈ 0.45 is noise); the embedder only bridges description↔name paraphrase, and goes vacuous when EOEmbed is cold.',
  },
  relation_rel_floor: {
    value: 0.55, mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Predicate compatibility floor for the relation gate: a claim verb and an edge verb are the same relation when their lemmas overlap or their embedding cosine clears this. Measured on the app\'s own MiniLM-q8: cos(afford, pay) = 0.62 clears; cos(argued, hear) = 0.50 does not. This is the one place the embedder helps the relational cure, and only as a similarity scorer feeding a mechanical decision.',
  },
  // ── Site face — the Entity cell named at its level ──────
  site_entity_cell: {
    value: false, mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'When ON, the Site face\'s (Existence, Figure) cell is named Entity — its proper name as one of the nine generated cells (the entity subtypes thing/person/place/org live BENEATH it on the entityType axis, never in a site slot) — and the SIG/NUL Object coordinate corrects: a NUL stall and an unattributed SIG read Object Ground (an ambient existence-mass with no anchor, generating Void), while an attributed SIG resolves on its speaker. The cell stays generated from (Domain, Object); only the coordinate moves. OFF ships today\'s grid (the cell misnamed \'Thing\', SIG/NUL defaulting to Figure) byte-identical — the parity floor; flip after the parallel golden on the journalism + essay fixtures diffs clean.',
  },
  speaker_label_patterns: {
    value: [], mass: 0, layer: 'structure', src: 'learned', module: 'core',
    desc: 'Grown, never seeded: line shapes (regex sources — capture 1 the label, capture 2 the statement) that bind a "LABEL: statement" line as that voice speaking — the org-acronym colon convention. Members arrive only through the proposal channel\'s admission physics: the model proposes from registered friction; documents or the user corroborate; admission writes the pattern here through the ledger. Starts EMPTY, so every shipped reading is byte-identical.',
  },
  separator_lines: {
    value: [], mass: 0, layer: 'structure', src: 'learned', module: 'core',
    desc: 'Grown, never seeded: line shapes (regex sources) that are section separators, not sentences (a *** line between dated entries). Admitted members are recorded as exceptions to the sentence-boundary mechanism in the conventions graph; live consumption by the segmenter is staged work — the inventory accumulates witnesses meanwhile.',
  },
  chrome_patterns: {
    value: [
      // navigation/menu: 3+ asterisk-delimited items ("* About us * Contact *")
      '/^\\s*(\\*\\s+[^*]+){3,}/',
      // copyright/trademark boilerplate
      '/\\b(©|copyright|all rights reserved|registered trademark)\\b/i',
      // standalone horizontal rules
      '/^_{6,}$/',
      '/^-{6,}$/',
      // byline: "By <Name> <Name> | <Month> <Day>, <Year>"
      '/\\bBy\\s+[A-Z][a-z]+\\s+[A-Z][a-z]+\\s*\\|\\s*\\w+\\s+\\d+,?\\s+\\d{4}\\b/',
      // byline: "By <Name> [and <Name>…]" alone on its line (no date needed)
      "/^[Bb]y(( and| &)? [A-Z][\\w.’'-]+){1,8}$/",
      // share/social chrome
      '/^(Share|Tweet|Facebook|Email|Print)(\\s+[•|]\\s+\\w+)*\\s*$/i',
      // subscription appeals
      '/\\bSubscribe\\b.*\\$\\d+/i',
      // web nav/footer link rows: an enumerated menu vocabulary, nothing else on the line
      '/^(about us|contact|submit|advertise|advertisement( this)?|renew|manage|terms|privacy|subscribe|sign in|log ?in|newsletter|latest issue)( (about us|contact|submit|advertise|advertisement|renew|manage|terms|privacy|subscribe|sign in|log ?in|newsletter|latest issue))*$/i',
      // web chrome the print rules miss (mined from boilerplate-removal heuristics):
      // a standalone © mark anywhere on a line — line-leading too, where the
      // print rule's \\b© boundary fails ("© 2024 The Daily Bugle.")
      '/(^|[^\\p{L}\\p{N}])(©|\\(c\\))(?=\\s|\\d|$)/u',
      // a space-separated share/social row ("Share Tweet Facebook Email")
      '/^(share|tweet|post|pin it|pinterest|whats?app|reddit|linkedin|flipboard)(\\s+(share|tweet|post|pinterest|email|print|facebook|twitter|whats?app|reddit|linkedin|flipboard|x))+\\s*$/i',
      // a home/menu nav row: a whole line of three+ menu-vocabulary tokens
      '/^((home|menu|sections?|topics?|search|more|about|us|contact|submit|advertise|advertisement|renew|manage|terms|privacy|subscribe|sign|in|log|newsletter|latest|issue)\\s+){2,}(home|menu|sections?|topics?|search|more|about|us|contact|submit|advertise|advertisement|renew|manage|terms|privacy|subscribe|sign|in|log|newsletter|latest|issue)\\s*$/i',
      // cookie/consent banners and newsletter sign-up appeals
      '/\\b(we use cookies|accept (all )?cookies|cookie (policy|settings|preferences|consent)|consent to (the use of )?cookies|by continuing to (use|browse))\\b/i',
      '/\\b(sign up for (our )?newsletter|subscribe to (our )?newsletter|get (our )?newsletter|enter your email( address)?)\\b/i',
      // article meta rows: "5 min read", "12 Comments"
      '/^\\d+\\s+min(ute)?s?\\s+read\\b/i',
      '/^\\d+\\s+comments?\\s*$/i',
      // MediaWiki section headings ("== Early life ==", "=== 2001–2006 ==="):
      // a plain-text Wikipedia extract carries its outline inline, and a
      // heading line is structure, not prose — left ungated it glues into the
      // next sentence and seeds phantom entity spans.
      '/^\\s*={2,6}\\s*[^=\\s].*?={2,6}\\s*$/',
      // book apparatus: front-matter heads, numbered chapter/section heads,
      // roman-numeral and bare-number lines, bracketed plates, transcriber
      // boilerplate, and the Gutenberg wrapper
      '/^(contents|index|preface|introduction|appendix|notes?|footnotes?|bibliography|glossary|errata|epilogue|prologue|dedication|illustrations?)\\b.{0,60}$/i',
      '/^(chapter|book|volume|part|section|canto|act|scene|letter|essay|no)\\.?\\s+[ivxlcdm0-9]+[.:)]?\\s*$/i',
      '/^[ivxlcdm]+[.)]?$/i',
      '/^\\d+[.)]?$/',
      '/^\\[(illustration|footnote|sidenote|frontispiece)/i',
      '/^(produced|prepared|transcribed|digitized|translated|edited|illustrated|compiled|adapted|annotated) by\\b/i',
      '/^transcriber/i',
      '/^\\*\\*\\*/',
      // an ALL-CAPS heading line (case-sensitive on purpose: no flags)
      "/^[A-Z0-9][A-Z0-9 ,;:.’'&()-]{5,}$/",
      // es apparatus: chapter heads and Golden-Age front matter
      '/^cap[ií]tulo\\b/i',
      '/^(índice|pr[óo]logo|prefacio|ap[ée]ndice|dedicatoria|tasa|privilegio|aprobaci[óo]n|advertencia|al lector|fe de erratas|tabla)\\b.{0,60}$/i',
      '/^(primera|segunda|tercera|cuarta|quinta) parte\\b/i',
      // zh apparatus: chapter/scroll heads and bracketed editorial notes
      '/^第[一二三四五六七八九十百千零〇0-9]+[回章卷折節节出]/',
      '/^卷之?[一二三四五六七八九十上中下]/',
      '/^【[^】]*】/',
      '/^〔[^〕]*〕$/',
      // Aozora bunko colophon and editorial marks
      '/^底本[：:]/',
      '/^(入力|校正|初出)[：:]/',
      '/^※/',
    ],
    mass: 1, layer: 'existence', src: 'hardcoded-seed', module: 'core',
    desc: 'Page chrome (regex sources, /pattern/flags form): navigation menus, footer link rows, copyright/trademark boilerplate, horizontal rules, bylines, share/social rows, subscription appeals, book front matter and chapter heads, roman-numeral/pagination lines, bracketed plates, transcriber boilerplate, zh chapter heads, Aozora colophons. A line matching one is structure, not prose — it stays in the spine for re-display but reaches no operator emitter, so it goes dark honestly instead of minting phantom entities. Document apparatus, like structure_labels and gutenberg_boilerplate; register-specific entries disable per register like any convention.',
  },
  metaphor_frames: {
    value: [
      // "the X of the Y" where Y is a domain noun, allowing a short modifier
      // run before the noun ("the Jeff Bezos of the international drug trade")
      '/\\bthe\\s+(\\w+(?:\\s+\\w+){0,2})\\s+of\\s+(?:the\\s+|his\\s+|her\\s+|its\\s+)?(?:\\w+\\s+){0,3}(?:trade|world|game|industry|business|market|scene|underworld)\\b/i',
      // simile vehicle ("like Bezos", "just like Capone")
      '/\\b(?:like|just\\s+like|sort\\s+of\\s+like)\\s+(\\w+(?:\\s+\\w+){0,2})\\b/i',
    ],
    mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Figurative-framing shapes (regex sources, /pattern/flags form): capture 1 is the metaphor VEHICLE — the named entity invoked by comparison, not by participation ("the Jeff Bezos of the international drug trade"). A name sighted only inside such a frame accrues no agency and must not be drafted as a speaker. Feeds the speaker-plausibility gate; English/contemporary-journalism register.',
  },
  type_keywords_org: {
    value: ['syndicate','organization','organisation','company','cartel','group','gang','agency',
      'bureau','department','team','union','firm','institution','corporation','collective','network','coalition'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Class nouns that, as the predicate of a copular definition ("Sam Gor is a drug syndicate"), retype a default thing-referent to an organization. English class-noun inventory; conservative by design — better to leave a referent untyped than to retype it wrongly.',
  },
  type_keywords_place: {
    value: ['city','country','town','state','province','region','neighbourhood','neighborhood',
      'district','island','sea','mountain','airport','village','county','harbour','harbor','port'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Class nouns that, as the predicate of a copular definition, retype a default thing-referent to a place. English class-noun inventory; conservative by design.',
  },
  type_keywords_person: {
    value: ['man','woman','detective','officer','lecturer','lawyer','chief',
      'leader','boss','dealer','smuggler','kingpin','trafficker','informant',
      'composer','conductor','musician','director','filmmaker','actor','actress',
      'author','writer','singer','producer','artist'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Class nouns that, as the predicate of a copular definition, retype a default thing-referent to a person. English class-noun inventory; conservative by design.',
  },
  np_generic_heads: {
    value: ['award','prize','medal','court','courthouse','festival','orchestra','band','ensemble','choir',
      'building','tower','center','centre','hall','school','university','college','academy','institute',
      'museum','library','theatre','theater','hospital','church','cathedral','foundation','society',
      'association','committee','commission','council','authority','administration','station','stadium',
      'arena','league','club','hotel'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Generic class nouns that close a proper name ("…Chancery COURT", "Golden Globe AWARDS"). A name may honestly shorten by dropping such a tail ("Davidson County Chancery", "Golden Globe"), so the SYN identity gate admits a prefix-containment merge only when every dropped token is in this inventory (or the type_keywords class nouns) — never when the tail carries a name\'s worth of content ("Max Steiner" vs "Max Steiner Film Music Achievement Award"). Singular stems; the gate compares stemmed tokens. English inventory.',
  },
  // ── Site face cues (EO Space × Time) ──
  // The 9 sites are the phenomenological addresses every referent/relation
  // occupies — Space (Existence/Structure/Interpretation) × Time (Ground/
  // Figure/Pattern). The GRID and the operator→Space(Domain) mapping are
  // universal (engine); the Time character of a target — whether a noun reads
  // as an ambient Ground, a specific Figure, or a recurring Pattern — turns on
  // language-specific lexical cues, which live here. Figure is the default
  // (a specific existent); these two inventories pull a target off it.
  site_ground_cues: {
    value: ['confidence','chemistry','tension','morale','momentum','fear','trust','sentiment',
      'mood','climate','consensus','atmosphere','silence','chaos','panic','uncertainty','optimism',
      'pessimism','market','scene','underworld','environment','ecosystem','landscape','terrain',
      'culture','energy','pressure','stability','instability','turmoil','unrest','calm','zeitgeist'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Ambient mass nouns that read as a GROUND target — a condition that multiplies when measured, not a thing that holds still. Crossed with the operator\'s Domain they name the Ground column: Existence→Void, Structure→Field, Interpretation→Atmosphere. English register cue.',
  },
  site_pattern_cues: {
    value: ['kind','type','category','class','species','genre','sort','variety',
      'network','system','web','grid','infrastructure','apparatus',
      'framework','doctrine','ideology','theory','paradigm','model','philosophy','worldview',
      'school','movement','tradition','pattern','archetype'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Category / architecture / framework nouns that read as a PATTERN target — a regularity across moments, not a single moment. Crossed with the operator\'s Domain they name the Pattern column: Existence→Kind, Structure→Network, Interpretation→Paradigm. English register cue.',
  },

  // ── Interaction-side English inventories — lifted out of inline code. These
  //    read the user's QUESTION or an English CLAIM (not the document's own
  //    register), so they stay register-agnostic core: an English question on a
  //    Spanish document still parses. A pack may override per-bucket. See
  //    rebuildLangSets.
  irregular_past_verbs: {
    value: ['wrote','made','built','led','ran','won','lost','sold','bought','gave','took','held','met','sent','drew','spoke','knew','grew','became','left','kept','told','brought','drove','chose','rose','broke','spent','paid','founded','signed'],
    mass: 1, layer: 'structure', src: 'hardcoded-seed', module: 'core',
    desc: 'Common irregular past-tense verbs. A finite past verb heads a verb-predicate proposition ("Mara FOUNDED Veldmar") the page can be checked against; with the regular -ed test, this closed set lets the claim reader tell an assertion from a bare-stem instruction ("tell", "list"). English morphology.',
  },
  question_frame_words: {
    value: ['who','what','which','whose','where','when','about','tell','give','show','their','his','her','its','the','that','this','does','did','was','were','are','is'],
    mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Question-frame and aspect words stripped when reading the ASPECT a definitional ask is about ("what are X\'s influences" → {influences}), so the readout is topic-specific instead of dumping every DEF that mentions the entity. English interrogative frame.',
  },
  followup_glue: {
    value: ['but','so','and','or','yet','though','although','still','anyway','ok','okay','oh','well','hmm','huh','no','not','yes','yeah','nope','do','don','does','is','are','was','be','being','mean','means','meant','come','go','on','again','really','actually','exactly','specifically','explain','elaborate','clarify','expand','justify','elucidate','rephrase','simplify'],
    mass: 1, layer: 'significance', src: 'hardcoded-seed', module: 'core',
    desc: 'Discourse glue: connectives, negation, acknowledgers, light auxiliaries and meta-discourse verbs that carry no topic of their own. An elliptical follow-up made entirely of these plus function words and a wh/meta token ("but why not?") continues the prior grounded turn. Routing-only, never identity-bearing; deliberately excludes gratitude. English inventory.',
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
    SEG_VERBS, SYN_VERBS, STATE_VERBS,
    MALE_PRONOUNS, NEUTRAL_PERSON_PRONOUNS, FEMALE_TITLES, MALE_TITLES, TITLE_TOKENS, CLITIC_SUFFIXES, ADVERB_HEADS,
    NAME_CONNECTORS, PREP_LEAD_DISQUALIFY, ARTICLES, ATTRIB_VERB_LIST, ABBREVIATIONS,
    ANAPHOR_PRONOUNS, ROLE_CLAUSE_VERB, TITLE_OF_RE,
    DISCOURSE_JUNK, ANSWER_DISCOURSE, STRUCTURE_LABELS, TRANSCRIPT_FORMULA,
    GENERIC_VOICE_HEADS, PLACE_ORG_CUE_RE, EVA_MACHINERY_RE, EVA_VETO_TERMS,
    KIN_TERMS, KIN_POSS_RE, SPEAKER_LABEL_RES, GUTENBERG_BOILERPLATE,
    GUTENBERG_START_RES, GUTENBERG_END_RES,
    CHROME_RES, METAPHOR_RES, TYPE_KW_ORG, TYPE_KW_PLACE, TYPE_KW_PERSON,
    NP_GENERIC_HEADS, SITE_GROUND_CUES, SITE_PATTERN_CUES,
    COPULAR, AUX_VERBS_RE, RG_PRONOUN_RE, DEICTIC_PRONOUNS, IRREG_PAST,
    TITLE_CASE_MINOR, FOLLOWUP_GLUE, ASK_FRAME, RG_STOP, RG_ATTRIB;
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
  NEUTRAL_PERSON_PRONOUNS = new Set(mod_values('neutral_person_pronouns'));
  KIN_TERMS = new Set(mod_values('kin_terms'));
  // depicted-act verb classes (the story-world transformation a clause reports)
  SEG_VERBS = new Set(mod_values('depict_seg_verbs'));
  SYN_VERBS = new Set(mod_values('depict_syn_verbs'));
  STATE_VERBS = new Set(mod_values('depict_state_verbs'));
  // "his/her (own|late|elder…) <kin-noun>" — the possessive-kin shape the
  // extractor reads. Empty inventory (a language without it yet) disables it.
  KIN_POSS_RE = KIN_TERMS.size
    ? new RegExp("\\b(his|her)\\s+(?:own\\s+|late\\s+|elder\\s+|eldest\\s+|younger\\s+|youngest\\s+|only\\s+)?(" + [...KIN_TERMS].join('|') + ")\\b", 'giu')
    : /$^/;
  FEMALE_TITLES = new Set(mod_values('female_titles'));
  MALE_TITLES = new Set(mod_values('male_titles'));
  // Every personal title (gendered + genderless: Mr, Mrs, Dr, Captain,
  // Senator, President, Chief, …) — a name leading with one is a person.
  TITLE_TOKENS = new Set([...mod_values('title_tokens'), ...mod_values('male_titles'), ...mod_values('female_titles')]);
  CLITIC_SUFFIXES = new Set(mod_values('clitic_suffixes'));
  ADVERB_HEADS = new Set(mod_values('adverb_heads'));
  NAME_CONNECTORS = new Set(mod_values('name_connectors'));
  PREP_LEAD_DISQUALIFY = new Set(mod_values('prep_lead_disqualify'));
  ARTICLES = new Set(mod_values('articles'));
  ATTRIB_VERB_LIST = getAttribVerbs().join('|');
  ABBREVIATIONS = new Set(mod_values('sentence_abbreviations'));
  // Role-shape regexes, built from their convention inventories. Empty
  // inventories (a language without these conventions yet) disable the shape.
  const rcv = mod_values('role_clause_verbs');
  ROLE_CLAUSE_VERB = rcv.length ? new RegExp('^(?:' + rcv.join('|') + ')\\b', 'i') : /$^/;
  const heads = mod_values('role_title_heads');
  const prefixes = mod_values('role_title_prefixes');
  TITLE_OF_RE = heads.length
    ? new RegExp('\\b((?:(?:' + (prefixes.length ? prefixes.join('|') : '$^') + ')\\s+)?(?:' + heads.join('|') + ')\\s+of\\s+[^,;.]+)', 'iu')
    : /$^/;
  // production-guard conventions (assertions, contextual and revisable)
  DISCOURSE_JUNK = new Set(mod_values('discourse_junk'));
  ANSWER_DISCOURSE = new Set(mod_values('answer_discourse'));
  STRUCTURE_LABELS = new Set(mod_values('structure_labels'));
  TRANSCRIPT_FORMULA = new Set(mod_values('transcript_formula'));
  GENERIC_VOICE_HEADS = new Set(mod_values('generic_voice_heads'));
  GUTENBERG_BOILERPLATE = new Set(mod_values('gutenberg_boilerplate'));
  // Wrapper-boundary markers (regex sources, like chrome_patterns). Empty
  // inventory ⇒ matchGutenberg* never fires and no doc is wrapper-gated.
  GUTENBERG_START_RES = compileConventionRegexes(mod_values('gutenberg_start_markers'));
  GUTENBERG_END_RES = compileConventionRegexes(mod_values('gutenberg_end_markers'));
  const poc = mod_values('place_org_cues');
  PLACE_ORG_CUE_RE = poc.length ? new RegExp('\\b(' + poc.join('|') + ')\\b', 'i') : /$^/;
  const evam = mod_values('eva_machinery_terms');
  EVA_MACHINERY_RE = evam.length ? new RegExp('\\b(' + evam.join('|') + ')\\b', 'i') : /$^/;
  EVA_VETO_TERMS = new Set(mod_values('eva_veto_lexicon'));
  // admitted speaker-label shapes (the proposal channel, live). Empty until a
  // proposed convention clears admission; a bad pattern never breaks the reading.
  SPEAKER_LABEL_RES = [];
  for (const src of mod_values('speaker_label_patterns')) {
    try { SPEAKER_LABEL_RES.push(new RegExp(src, 'u')); } catch (e) { /* skip */ }
  }
  // Production-guard pattern conventions (the language-specific DATA; the
  // mechanisms that consume them are universal). Empty inventory ⇒ the guard
  // is simply inert, never throws.
  CHROME_RES = compileConventionRegexes(mod_values('chrome_patterns'));
  METAPHOR_RES = compileConventionRegexes(mod_values('metaphor_frames'));
  TYPE_KW_ORG = new Set(mod_values('type_keywords_org'));
  TYPE_KW_PLACE = new Set(mod_values('type_keywords_place'));
  TYPE_KW_PERSON = new Set(mod_values('type_keywords_person'));
  NP_GENERIC_HEADS = new Set(mod_values('np_generic_heads'));
  SITE_GROUND_CUES = new Set(mod_values('site_ground_cues'));
  SITE_PATTERN_CUES = new Set(mod_values('site_pattern_cues'));
  // Grammatical inventories lifted out of inline code — built here so the
  // reading paths stay language-neutral (the data is a convention). An empty
  // inventory yields a never-match RegExp ((?!) — matches nothing, not even the
  // empty string, exactly like the populated ^(…)$ test on a non-member) or an
  // empty Set, never a throw.
  const _anchoredRe = (id) => { const v = mod_values(id); return v.length ? new RegExp('^(' + v.join('|') + ')$', 'i') : /(?!)/; };
  COPULAR = _anchoredRe('copular_verbs');
  AUX_VERBS_RE = _anchoredRe('auxiliary_verbs');
  RG_PRONOUN_RE = _anchoredRe('relation_gate_pronouns');
  DEICTIC_PRONOUNS = new Set(mod_values('deictic_pronouns'));
  IRREG_PAST = new Set(mod_values('irregular_past_verbs'));
  TITLE_CASE_MINOR = new Set(mod_values('title_case_minor_words'));
  FOLLOWUP_GLUE = new Set(mod_values('followup_glue'));
  ASK_FRAME = new Set(mod_values('question_frame_words'));
  RG_STOP = new Set(mod_values('relation_gate_stopwords'));
  RG_ATTRIB = new Set(mod_values('relation_gate_attribution_verbs'));
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
  // External-pack modules (loaded from memory/packs/, not LANG_PACKS — e.g.
  // el-classical-v1) toggle their enabled flag here so the UI's active-module
  // list is honest. Their reading organs read their own tables, not the rule sets.
  if (LANGUAGE_MODULES['el-classical-v1']) LANGUAGE_MODULES['el-classical-v1'].enabled = (pid === 'el-classical-v1');
  deriveSets(projectRules(RULES_LEDGER, currentFrame()));
}
function moduleEnabledForLang(modId) { return modId === 'core' || (LANGUAGE_MODULES[modId] && LANGUAGE_MODULES[modId].enabled); }

/* ============================================================
   THE CONVENTIONS GRAPH (memory/conventions.jsonl) — human language as conventions.

   The mechanics (gravity, momentum, two-sighting, δ-gates, the nine
   operators) are universal; everything HUMAN-LANGUAGE-specific — pronoun
   inventories, titles, attribution shapes, quote pairs, register calls
   like singular-they — is a CONVENTION, and no inventory is more "real"
   than another: you / y'all / ella / vous / 她 are equal citizens. Those
   conventions live in memory/conventions.jsonl: an append-only
   graph whose records ARE eo operations —

     INS  — instantiate a module (a register of conventions) or a
            convention (one inventory/setting), with an `affinity` text
            describing the kinds of content it belongs to (the hook an
            embedder scores against document content at runtime);
     SYN  — membership: { s: "he", v: "member-of", o: "<convention id>" }
            (seq order is list order);
     DEF  — a property of a surface ({target:"he", path:"gender",
            value:"m"}) or a structured value on a convention
            ({path:"value"} — quote pairs, patterns, register booleans);
     REC  — the register laws, recorded in the engine's own change
            vocabulary (why singular-they is off for 19th-c narrative).

   projectConventions REPLAYS that log into per-module convention values —
   the same move projectGraph makes over a document's events — and
   loadConventions writes them through (READING_RULES for the en module,
   LANG_PACKS for the others) and rebuilds the lexical sets. The shipped
   seeds in this file stay as the fallback: never loaded ⇒ byte-identical
   behavior; the drift test (tests/conventions.test.js) proves file and
   seeds agree. _conventionsExport is the read-only introspection the
   generator and the test share.
   ============================================================ */
function projectConventions(records) {
  const conventions = new Map();   // id -> { module, rule, value }
  const members = new Map();       // id -> [surfaces in seq order]
  const moduleProps = new Map();   // moduleId -> { path: value }
  const evaTally = new Map();      // lang|term -> sightings (hydration RECs)
  const evaInduced = new Set();    // terms past the two-sighting gate
  for (const ev of (records || [])) {
    if (!ev || !ev.op) continue;
    if (ev.op === 'INS' && ev.kind === 'convention' && ev.id) {
      conventions.set(ev.id, { module: ev.module, rule: ev.rule || null, value: undefined });
    } else if (ev.op === 'SYN' && ev.v === 'member-of' && ev.o != null && ev.s != null) {
      if (!members.has(ev.o)) members.set(ev.o, []);
      members.get(ev.o).push(ev.s);
    } else if (ev.op === 'DEF' && ev.path === 'value' && conventions.has(ev.target)) {
      conventions.get(ev.target).value = ev.value;
    } else if (ev.op === 'DEF' && ev.property != null && conventions.has(ev.target)) {
      // Structured pack data (paradigm tables, case→role maps, fold rules):
      // a DEF that names a `property` slot rather than path:'value'. Collected
      // under the convention's `data`, keyed by property, for the organs to read.
      const c = conventions.get(ev.target); if (!c.data) c.data = {}; c.data[ev.property] = ev.value;
    } else if (ev.op === 'DEF' && ev.path && ev.module && ev.kind === 'module-prop') {
      if (!moduleProps.has(ev.module)) moduleProps.set(ev.module, {});
      moduleProps.get(ev.module)[ev.path] = ev.value;
    }
    else if (ev.op === 'REC' && ev.action === 'eva-veto' && ev.value && ev.value.term) {
      // hydration records: tally failure terms; two sightings = a neuron
      const k = ((ev.affinity && ev.affinity.lang) || 'en') + '|term:' + String(ev.value.term).toLowerCase();
      evaTally.set(k, Math.max(evaTally.get(k) || 0, ev.value.sightings || ((evaTally.get(k) || 0) + 1)));
      if ((evaTally.get(k) || 0) >= 2) evaInduced.add(ev.value.term);
    }
    // other word-property DEFs (gender/person/animacy/…) and RECs enrich the
    // graph; projection v1 reads membership + values + hydration only.
  }
  for (const [id, c] of conventions) if (c.value === undefined && members.has(id)) c.value = members.get(id);
  return { conventions, moduleProps, evaInduced: [...evaInduced], evaTally };
}

function parseConventionsJSONL(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* a bad line never poisons the rest */ }
  }
  return out;
}

function loadConventions(input) {
  const records = typeof input === 'string' ? parseConventionsJSONL(input) : (input || []);
  const proj = projectConventions(records);
  // Provenance state rides the same log: anchors attached to records, SEGs
  // against anchor hashes, admission RECs. A record without prov is
  // legacy/seed — it carries the synthetic seed anchor and applies as before.
  const provState = gatherProvenance(records);
  for (const ev of records) if (ev && ev.op === 'INS' && ev.id) KNOWN_NODE_IDS.add(ev.id);
  // The RULES LEDGER is the durable store — every parse re-folds it into the
  // live rules, so a direct write would be clobbered on the next document.
  // Conventions therefore land as ledger DELTAS against the current fold (the
  // same append-only channel induction uses): remove-token / add-token for
  // inventories, set-value for register laws, bucketed by module. File ≡
  // seeds ⇒ zero deltas ⇒ byte-identical behavior.
  compileLiteralPacks();
  const tokenize = (id, v) => (id === 'quote_pairs') ? v.map(p => JSON.stringify(p)) : v.slice();
  const ALL_BUCKETS = new Set(['core', 'en-narrative-v1', ...Object.values(LANG_PACKS).map(p => p.id)]);
  const fold = projectRules(RULES_LEDGER, { packs: ALL_BUCKETS });
  let applied = 0, packApplied = 0, deltas = 0;
  const emit = (ev) => { ledgerAppend({ ...ev, basis: 'conventions', src: 'conventions.jsonl' }); deltas++; };
  for (const [cid, c] of proj.conventions) {
    if (c.value === undefined || !c.rule || !READING_RULES[c.rule] || c.rule === 'attribution_verbs') continue;
    // A prov-carrying convention that has not cleared admission is a SIGNAL —
    // registered, decaying, waiting — and never applies, at any flag setting.
    const ps = provState.get(cid);
    if (ps && ps.hasProv && !ps.admitted && !admitAnchors(ps.anchors, { segCounts: ps.segCounts }).ok) continue;
    // proposal-born conventions share a grown inventory with their siblings;
    // their membership is additive, never a wholesale replacement of it
    const addOnly = String(cid).indexOf('proposed:') === 0;
    const bucket = c.module || 'core';
    const r = fold.rules[c.rule];
    const pb = r && r.perBucket && r.perBucket[bucket];
    if (Array.isArray(c.value)) {
      const want = tokenize(c.rule, c.value);
      const have = [];
      if (pb) for (const k of (pb.order || [])) if ((pb.tokens.get(k) || 0) > 0) have.push(k);
      const haveSet = new Set(have), wantSet = new Set(want);
      if (!addOnly) for (const t of have) if (!wantSet.has(t)) emit({ target: 'rule:' + c.rule, action: 'remove-token', bucket, value: t, mass: 1 });
      for (const t of want) if (!haveSet.has(t)) emit({ target: 'rule:' + c.rule, action: 'add-token', bucket, value: t, mass: 1 });
    } else {
      // compare against the fold's resolved VALUE (pb.latest is the envelope
      // {value, mass, seq, src}); an identical value emits nothing, so
      // file ≡ seeds ⇒ zero deltas, literally
      const cur = pb && pb.latest ? pb.latest.value : undefined;
      if (JSON.stringify(cur) !== JSON.stringify(c.value)) emit({ target: 'rule:' + c.rule, action: 'set-value', bucket, value: c.value, mass: 1 });
    }
    if (bucket === 'en-narrative-v1' || bucket === 'core') applied++; else packApplied++;
  }
  // Pending signals in the log reconstitute (cross-session recurrence and the
  // drawer's Proposals channel survive a reload); admitted ones surface as
  // history. Anchors union under independence — same h, one sighting.
  for (const [cid, ps] of provState) {
    if (!ps.hasProv) continue;
    const existing = PROPOSER.signals.find(s => s.id === cid);
    if (existing) {
      const have = new Set(existing.anchors.map(a => a.h));
      for (const a of ps.anchors) if (!have.has(a.h)) { existing.anchors.push(a); have.add(a.h); }
      for (const [h, n] of ps.segCounts) existing.segCounts.set(h, Math.max(existing.segCounts.get(h) || 0, n));
      if (ps.admitted && existing.status === 'signal') existing.status = 'admitted';
      continue;
    }
    const ins = ps.ins || {};
    PROPOSER.signals.push({
      id: cid, status: ps.admitted ? 'admitted' : 'signal',
      sentence: ins.statement || null, register: ins.register || null,
      probe: ins.probe || null, rule: ins.rule || null,
      frictionKey: null, frictionType: ins.frictionType || null,
      records: [], anchors: ps.anchors.slice(), segCounts: ps.segCounts,
      sig: null, visibility: 1, restored: true,
    });
  }
  // hydration: terms the file's REC records have already taught (two
  // sightings) land as ledger add-tokens; tallies restore so counting
  // continues across sessions rather than restarting
  {
    const r = fold.rules['eva_veto_lexicon'];
    const pb = r && r.perBucket && r.perBucket['core'];
    const live = new Set();
    if (pb) for (const k of (pb.order || [])) if ((pb.tokens.get(k) || 0) > 0) live.add(k);
    for (const term of (proj.evaInduced || [])) {
      if (!live.has(term)) emit({ target: 'rule:eva_veto_lexicon', action: 'add-token', bucket: 'core', value: term, mass: 2 });
    }
    if (proj.evaTally) for (const [k, n] of proj.evaTally) EVA_TALLY.set(k, Math.max(EVA_TALLY.get(k) || 0, n));
  }
  // module-level props (dash dialogue, function chars, …) live on the packs
  for (const [modId, props] of proj.moduleProps) {
    for (const lang of Object.keys(LANG_PACKS)) {
      if (LANG_PACKS[lang].id !== modId) continue;
      for (const [p, v] of Object.entries(props)) if (p in LANG_PACKS[lang]) { LANG_PACKS[lang][p] = v; packApplied++; }
    }
  }
  _projMemo = null;
  deriveSets(projectRules(RULES_LEDGER, currentFrame()));
  return { records: records.length, applied, packApplied, deltas };
}

// loadConventionPacks: load one or more pack fragments from memory/packs/ as an
// ADDITIVE channel, kept separate from memory/conventions.jsonl so the file ≡
// seeds drift contract is untouched. Registers each pack's module and builds its
// reading organs from the projected conventions. Today only el-classical-v1
// carries organs (the Greek stem-fold / case→role / bound-pronoun tables, read
// by extractGreekGraph); any other pack registers its module and stays inert
// until an organ consumes it. Pure projection — never lands seed deltas.
function loadConventionPacks(input) {
  const records = typeof input === 'string' ? parseConventionsJSONL(input) : (input || []);
  if (!records.length) return { records: 0, modules: [] };
  const proj = projectConventions(records);
  const modules = [];
  for (const ev of records) {
    if (ev && ev.op === 'INS' && ev.kind === 'module' && ev.id) {
      modules.push(ev.id);
      if (!LANGUAGE_MODULES[ev.id]) LANGUAGE_MODULES[ev.id] = {
        id: ev.id, name: ev.id, version: '1.0',
        applies_to: { language: ev.language || '*', mode: 'narrative' },
        enabled: false, provides: [], desc: ev.affinity || '',
      };
    }
    if (ev && ev.op === 'INS' && ev.id) KNOWN_NODE_IDS.add(ev.id);
  }
  if (modules.includes('el-classical-v1')) buildGreekOrgans(proj.conventions);
  return { records: records.length, modules };
}

// Read-only introspection: every convention the semantics graph covers, with
// its current live value — consumed by tools/gen-conventions.js (to emit the
// file) and tests/conventions.test.js (to prove file ≡ seeds, no drift).
function _conventionsExport() {
  const enConventions = {};
  for (const [id, r] of Object.entries(READING_RULES)) {
    if (r.module === 'en-narrative-v1') enConventions[id] = r.value;
  }
  // core production-guard conventions — register-agnostic assertions
  const CORE_IDS = ['discourse_junk', 'answer_discourse', 'structure_labels', 'transcript_formula',
    'generic_voice_heads', 'place_org_cues', 'eva_machinery_terms', 'eva_veto_lexicon',
    'speaker_label_patterns', 'separator_lines',
    'chrome_patterns', 'metaphor_frames',
    'type_keywords_org', 'type_keywords_place', 'type_keywords_person',
    'np_generic_heads',
    'site_ground_cues', 'site_pattern_cues',
    'irregular_past_verbs', 'question_frame_words', 'followup_glue'];
  const coreConventions = {};
  for (const id of CORE_IDS) if (READING_RULES[id]) coreConventions[id] = READING_RULES[id].value;
  const modules = {
    core: { language: '*', conventions: coreConventions, props: {} },
    'en-narrative-v1': { language: 'en', conventions: enConventions, props: {} },
  };
  for (const [lang, pack] of Object.entries(LANG_PACKS)) {
    const props = {};
    for (const k of ['name_prefix_lower', 'dash_dialogue', 'function_chars', 'colon_attribution']) {
      if (k in pack) props[k] = pack[k];
    }
    modules[pack.id] = { language: pack.language, conventions: { ...pack.rules }, props };
  }
  return { modules };
}

/* ============================================================
   PROVENANCE ANCHORS + THE CONVENTION PROPOSER

   Conventions carry provenance back to their sources, pointed to by
   content hash + embedding signature — never by name or resolvable
   location. The anchor:

     { h:   sha256(normalized_span_text)[:16]   — content hash, truncated
       sig: int8[384]                            — quantized MiniLM embedding (null when no embedder)
       r:   reader_id                            — who registered this sighting
       c:   coupling at registration             — frozen (seed/doc 1.0, llm-proposer 0.6, user 5.0)
       t:   seq                                  — position in the conventions log }

   Locally resolvable (the parse-time span table maps h → doc/sentence),
   globally opaque (off-device, h is 16 bytes with no dictionary).
   Independence is set arithmetic on h; tamper-evidence is free (a changed
   document stops resolving). Absence of `prov` on a record = legacy/seed:
   it carries one synthetic anchor — finite mass, outvotable by real
   sources. Nothing in the graph is unfalsifiable, including its initial
   conditions.

   The local model (the same WebLLM instance that phrases answers) gains a
   second job here: PROPOSING conventions from the fold of the conventions
   graph plus its cross-document reading. It proposes; it never commits.
   The engine nominates friction mechanically (NUL stalls, repeated
   unconsumed typographic shapes); the model only ever reasons over
   friction the engine registered, citing span-ids the engine minted; the
   engine mints every hash, signature, record, and seq. A proposal enters
   the log as a SIGNAL — below θ_admit by construction, because admission
   requires a non-model witness — and admits only when an independent
   document sighting or a user confirmation lands on it. The model can
   never be its own witness.
   ============================================================ */

// ── sha-256, pure JS and synchronous — the VM test host and file:// pages
//    have no crypto.subtle guarantee, and hashing must be sync at parse time.
const _SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256Hex(str) {
  const s = String(str == null ? '' : str);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
             (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  const rr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16)
        | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + _SHA256_K[i] + w[i]) >>> 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(x => ('00000000' + x.toString(16)).slice(-8)).join('');
}
function normalizeSpan(s) {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFC'); } catch (e) { /* environments without normalize */ }
  return t.replace(/\s+/g, ' ').trim();
}
function spanHash(s) { return sha256Hex(normalizeSpan(s)).slice(0, 16); }

// ── readers, couplings, the synthetic seed anchor ──
// Couplings mirror READER_REGISTRY: how hard each reader presses, frozen
// onto the anchor at registration. The model readers can never be the
// admission witness (clause 3 below) at ANY coupling.
const ANCHOR_COUPLING = { seed: 1.0, doc: 1.0, gravity: 1.0, 'llm-proposer': 0.6, llm: 0.6, user: 5.0, human: 5.0 };
const MODEL_READERS = new Set(['llm-proposer', 'llm', 'embedder']);
const SEED_ANCHOR = Object.freeze({ h: 'seed', sig: null, r: 'seed', c: 1.0, t: 0 });

// position in the conventions log — anchors stamp t from here; loading a
// conventions file advances it past the file's max seq.
let CONV_HEAD = 1;
function convHead() { return CONV_HEAD; }
function _bumpConvHead(seq) { if (seq != null && isFinite(seq) && seq + 1 > CONV_HEAD) CONV_HEAD = seq + 1; }

// the local span table: h → (doc, sentence). Locally resolvable, globally
// opaque — built at parse time (we are already tokenizing), session-scoped.
const SPAN_TABLE = new Map();   // h → { docId, idx }
const DOC_SPANS = new Map();    // docId → Set(h)
function resolveAnchor(h) { const hit = SPAN_TABLE.get(h); return hit ? { docId: hit.docId, idx: hit.idx } : null; }
function registerDocSpans(doc) {
  if (!doc || doc.kind !== 'prose' || !Array.isArray(doc.sentenceTexts)) return 0;
  const set = new Set();
  doc.sentenceTexts.forEach((t, i) => {
    const h = spanHash(t);
    set.add(h);
    if (!SPAN_TABLE.has(h)) SPAN_TABLE.set(h, { docId: doc.id, idx: i });
  });
  DOC_SPANS.set(doc.id, set);
  if (!SESSION.docs.includes(doc.id)) SESSION.docs.push(doc.id);
  return set.size;
}

function mintAnchor(spanText, reader) {
  const r = reader || 'doc';
  return { h: spanHash(spanText), sig: null, r, c: ANCHOR_COUPLING[r] != null ? ANCHOR_COUPLING[r] : 1.0, t: CONV_HEAD++ };
}

// ── sig: the quantized embedding signature (optional — registerFit is
//    neutral without one, so every path degrades to coupling-only).
let ANCHOR_EMBED = null;       // host-injected: async (texts[]) => Float32Array[]
function setAnchorEmbedder(fn) { ANCHOR_EMBED = typeof fn === 'function' ? fn : null; }
let ANCHOR_PRIVACY = (typeof globalThis !== 'undefined' && globalThis.EO_ANCHOR_PRIVATE === 'strict') ? 'strict' : 'default';
function setAnchorPrivacy(mode) { ANCHOR_PRIVACY = mode === 'strict' ? 'strict' : 'default'; return ANCHOR_PRIVACY; }
function anchorPrivacy() { return ANCHOR_PRIVACY; }
function quantizeSig(vec) {
  if (!vec || !vec.length) return null;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let q = Math.round(vec[i] * 127);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}
function sigCos(a, b) {
  if (!a || !b || !a.length || !b.length) return null;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}
function registerFit(sig, docSig) {
  const c = sigCos(sig, docSig);
  return c == null ? 1 : Math.max(0, c);
}

// ── independence, mass, admission — the anchor physics ──
const PROV_HALF_LIFE = 2000;   // log positions for a sighting's weight to halve
const PROV_SEG_DECAY = 0.25;   // multiplier per SEG sighting against an anchor's h
const PROV_SOURCE_CAP = 0.25;  // per-source ceiling on register weight

// Two sightings are independent iff disjoint on h — same-h deposits
// collapse to the strongest one. Set arithmetic, not judgment.
function independentAnchors(anchors) {
  const byH = new Map();
  for (const a of (anchors || [])) {
    if (!a || !a.h) continue;
    const cur = byH.get(a.h);
    if (!cur || (a.c || 0) > (cur.c || 0)) byH.set(a.h, a);
  }
  return [...byH.values()];
}

// mass(convention, frame) = Σ over anchors: c × independence × decay × registerFit.
// The per-source cap (no single h contributing more than a quarter of the
// register weight) engages only once enough sources CONTRIBUTE for the
// constraint to be satisfiable at all — among k < ⌈1/cap⌉ non-zero sources,
// someone must exceed a quarter of their own sum, so the cap regulates
// crowds, never pairs. It then iterates to the fixed point where the
// heaviest source's share of the CAPPED total sits at the ceiling — one
// heavily-read document cannot become the universal register.
function anchorMass(anchors, opts = {}) {
  const ind = independentAnchors(anchors);
  if (!ind.length) return 0;
  const now = opts.now != null ? opts.now : CONV_HEAD;
  const segCounts = opts.segCounts || null;
  const frame = opts.frame || null;
  let contribs = ind.map(a => {
    const seg = segCounts ? Math.pow(PROV_SEG_DECAY, segCounts.get(a.h) || 0) : 1;
    const age = Math.max(0, now - (a.t || 0));
    const dec = Math.pow(0.5, age / PROV_HALF_LIFE);
    const fit = registerFit(a.sig, frame && frame.doc_sig);
    return (a.c || 0) * seg * dec * fit;
  });
  const nonzero = contribs.filter(x => x > 1e-9).length;
  if (nonzero >= Math.ceil(1 / PROV_SOURCE_CAP)) {
    for (let pass = 0; pass < 24; pass++) {
      const total = contribs.reduce((s, x) => s + x, 0);
      if (!(total > 0)) break;
      const cap = PROV_SOURCE_CAP * total;
      let clipped = false;
      contribs = contribs.map(x => { if (x > cap + 1e-9) { clipped = true; return cap; } return x; });
      if (!clipped) break;
    }
  }
  return contribs.reduce((s, x) => s + x, 0);
}

// admit ⇔ Σ independent-anchor coupling ≥ θ_admit ∧ ≥ 2 distinct h ∧ ≥ 1
// non-model witness. The model can never be its own witness; recurrence
// raises a signal's visibility, never its admissibility.
function admitAnchors(anchors, opts = {}) {
  const ind = independentAnchors(anchors);
  const theta = opts.theta != null ? opts.theta
    : (READING_RULES.theta_admit ? READING_RULES.theta_admit.value : 2.0);
  const segCounts = opts.segCounts || null;
  let sum = 0;
  for (const a of ind) sum += (a.c || 0) * (segCounts ? Math.pow(PROV_SEG_DECAY, segCounts.get(a.h) || 0) : 1);
  const distinct = ind.length;
  const nonModel = ind.some(a => !MODEL_READERS.has(a.r));
  return { ok: sum >= theta && distinct >= 2 && nonModel, sum: +sum.toFixed(4), distinct, nonModel, theta };
}

// Register variants: a SEG against part of a convention's anchors splits the
// projection — the contradicted cluster and the surviving cluster project
// separately, each with its own register centroid (the Shakespeare/NYT
// machinery applied to provenance). One cluster (nothing contradicted, or
// everything) projects as a single variant.
function conventionVariants(anchors, segCounts, frame) {
  const ind = independentAnchors(anchors);
  const seg = segCounts || new Map();
  const hit = ind.filter(a => (seg.get(a.h) || 0) > 0);
  const clean = ind.filter(a => !((seg.get(a.h) || 0) > 0));
  const centroid = (as) => {
    const sigs = as.map(a => a.sig).filter(Boolean);
    if (!sigs.length) return null;
    const n = sigs[0].length, c = new Array(n).fill(0);
    for (const sg of sigs) for (let i = 0; i < n; i++) c[i] += sg[i];
    for (let i = 0; i < n; i++) c[i] /= sigs.length;
    return c;
  };
  const mk = (as, kind) => ({ register: kind, anchors: as, sig: centroid(as), mass: anchorMass(as, { segCounts: seg, frame }) });
  if (!hit.length || !clean.length) return [mk(ind, 'all')];
  return [mk(clean, 'surviving'), mk(hit, 'contradicted')];
}

// Gather per-convention provenance state from a record log: anchors from
// INS/SYN-member/REC prov (a SEG's prov witnesses the rejection, never the
// convention), SEG against-counts, and admission RECs. Absence of prov =
// legacy/seed (one synthetic anchor, applied at the call sites).
function gatherProvenance(records) {
  const state = new Map();
  const get = (id) => {
    if (!state.has(id)) state.set(id, { anchors: [], segCounts: new Map(), admitted: false, hasProv: false, ins: null });
    return state.get(id);
  };
  for (const ev of (records || [])) {
    if (!ev || !ev.op) continue;
    if (ev.seq != null) _bumpConvHead(ev.seq);
    let attachId = null;
    if (ev.op === 'INS' && ev.id) { attachId = ev.id; if (Array.isArray(ev.prov) && ev.prov.length) get(ev.id).ins = ev; }
    else if (ev.op === 'SYN' && ev.v === 'member-of' && ev.o != null) attachId = ev.o;
    else if (ev.op === 'REC' && ev.target) attachId = ev.target;
    if (attachId && Array.isArray(ev.prov) && ev.prov.length) {
      const st = get(attachId);
      st.hasProv = true;
      for (const a of ev.prov) if (a && a.h) st.anchors.push(a);
    }
    if (ev.op === 'SEG' && ev.target && Array.isArray(ev.against)) {
      const st = get(ev.target);
      for (const h of ev.against) st.segCounts.set(h, (st.segCounts.get(h) || 0) + 1);
    }
    if (ev.op === 'REC' && ev.action === 'admit' && ev.target) get(ev.target).admitted = true;
  }
  return state;
}

// ── the session: friction registry + the proposer's working state ──
// The engine nominates friction MECHANICALLY: unconsumed label-colon lines,
// separator lines read as sentences, pronoun stalls sharing a competing
// pair. The model only ever reasons over friction registered here, through
// span-ids (†n) this engine minted against real text.
const SESSION = {
  docs: [],                     // prose doc ids parsed this session
  noted: new Set(),             // doc ids whose friction was already collected
  spanSeq: 0,                   // †n counter
  sids: new Map(),              // '†1' → { docId, idx, text }
  shapes: new Map(),            // shape key → { type, label, count, docs:Set, examples, sids }
  proposalsUsed: 0,
};
const PROPOSER = {
  signals: [],                  // pre-conventions: registered, decaying, waiting
  rejects: new Map(),           // shape → rejection count (a repeat feeds the negative lexicon)
  cfg: { enabled: true, budget: 3 },
};
const KNOWN_NODE_IDS = new Set(['mechanics:admission', 'mechanics:sentence-boundary',
  'mechanics:attribution', 'mechanics:pronoun-resolution', 'mechanics:person-promotion',
  'mechanics:naming-bridge', 'mechanics:eva-veto', 'mechanics:routing']);

const LABEL_COLON_RE = /^([A-Z][A-Z0-9&.\-]{1,11}):\s+(\S.*)$/;
const SEPARATOR_LINE_RE = /^[\s*\-–—=~_·•.]{3,}$/;

function noteDocFriction(doc) {
  if (!doc || doc.kind !== 'prose' || !Array.isArray(doc.sentenceTexts)) return;
  if (SESSION.noted.has(doc.id)) return;     // a re-read never double-counts
  SESSION.noted.add(doc.id);
  const sigAt = new Set();
  for (const ev of (doc._events || [])) if (ev.op === 'SIG' && ev.sentence_idx != null) sigAt.add(ev.sentence_idx);
  const note = (key, type, label, idx, text) => {
    if (!SESSION.shapes.has(key)) SESSION.shapes.set(key, { key, type, label, count: 0, docs: new Set(), examples: [], sids: null });
    const sh = SESSION.shapes.get(key);
    sh.count++;
    sh.docs.add(doc.id);
    if (sh.examples.length < 4) sh.examples.push({ docId: doc.id, idx, text });
  };
  doc.sentenceTexts.forEach((t, i) => {
    const s = String(t).trim();
    const m = LABEL_COLON_RE.exec(s);
    if (m && !sigAt.has(i) && !GENERIC_VOICE_HEADS.has(m[1].toLowerCase())) {
      note('speaker-label|' + m[1].toUpperCase(), 'speaker-label', m[1].toUpperCase(), i, s);
      return;
    }
    // a separator read as a sentence — standalone ("* * *" survived as its own
    // sentence), or merged (the line-break unwrap glued "* * *" onto the next
    // sentence's head). Both are the same unconsumed shape.
    if (SEPARATOR_LINE_RE.test(s) && /[*\-–—=~_·•]{2,}/.test(s.replace(/\s+/g, ''))) {
      note('separator|' + s.replace(/\s+/g, '').slice(0, 8), 'separator', s.replace(/\s+/g, '').slice(0, 8), i, s);
      return;
    }
    const lead = /^((?:[*\-–—=~_·•]\s*){3,})(?=\S)/.exec(s);
    if (lead && s.length > lead[1].length + 3) {
      const run = lead[1].replace(/\s+/g, '').slice(0, 8);
      note('separator|' + run, 'separator', run, i, s);
    }
  });
  for (const ev of (doc._events || [])) {
    if (ev.op !== 'NUL' || !ev.reason || ev.reason.indexOf('pronoun-stall') !== 0) continue;
    const comp = (ev.competing || []).map(c => (c && (c.siteName || c.name)) || '').filter(Boolean).slice(0, 2);
    if (comp.length < 2) continue;
    const key = 'stall|' + comp.map(x => x.toLowerCase()).sort().join('|');
    const idx = ev.sentence_idx != null ? ev.sentence_idx : 0;
    note(key, 'pronoun-stall', comp.join(' / '), idx, String(doc.sentenceTexts[idx] || ev.surface || '').trim());
  }
}

// The current friction list: shapes seen ≥ 3 times, or ≥ 2 times across ≥ 2
// documents. Span-ids are minted here (once per shape) — the only handles
// the model will ever hold.
function nominateFriction() {
  const out = [];
  for (const sh of SESSION.shapes.values()) {
    const cross = sh.docs.size >= 2 && sh.count >= 2;
    if (!(sh.count >= 3 || cross)) continue;
    if (!sh.sids) {
      sh.sids = sh.examples.map(e => {
        const sid = '†' + (++SESSION.spanSeq);
        SESSION.sids.set(sid, { docId: e.docId, idx: e.idx, text: e.text });
        return sid;
      });
    }
    out.push({
      n: out.length + 1, id: sh.key, type: sh.type, label: sh.label,
      count: sh.count, docs: [...sh.docs], sids: sh.sids,
      spans: sh.sids.map(sid => Object.assign({ sid }, SESSION.sids.get(sid))),
    });
  }
  return out;
}

// 4.1 — when the proposer may run. The host adds the model-idle and
// requestIdleCallback gating; the engine owns friction, budget, and the rule.
function proposerStatus() {
  const frictions = nominateFriction();
  const docs = SESSION.docs.length;
  const singleDocOK = frictions.some(f => f.count >= 3);
  const enabled = PROPOSER.cfg.enabled !== false;
  const budget = Number.isFinite(PROPOSER.cfg.budget) ? (PROPOSER.cfg.budget | 0) : 3;
  const budgetLeft = Math.max(0, budget - SESSION.proposalsUsed);
  const eligible = !!(enabled && budgetLeft > 0 && frictions.length && (docs >= 2 || singleDocOK));
  return {
    eligible, enabled, budgetLeft, docsParsed: docs, frictions: frictions.length,
    reason: !enabled ? 'proposals disabled'
      : !budgetLeft ? 'budget exhausted'
      : !frictions.length ? 'no registered friction'
      : (docs < 2 && !singleDocOK) ? 'one document and no repeated shape' : null,
  };
}

// 4.2 — the conventions projection rendered the way graphPortrait renders a
// document: prose, no operator names, no seq numbers, no anchors. The same
// surface/machinery separation the talker lives under.
function conventionsPortrait() {
  const parts = [];
  const cap1 = (w) => w ? w[0].toUpperCase() + w.slice(1) : w;
  if (TITLE_TOKENS && TITLE_TOKENS.size) {
    parts.push('titles like ' + [...TITLE_TOKENS].slice(0, 3).map(t => cap1(t) + '.').join('/') + ' as marking a person');
  }
  parts.push('a recorded speaker as a person');
  if (READING_RULES.singular_they) {
    parts.push('"they" as ' + (READING_RULES.singular_they.value ? 'singular or plural' : 'plural') + ' in this register');
  }
  const qp = mod_values('quote_pairs');
  if (qp.length) parts.push('speech as the text between ' + qp[0][0] + ' and ' + qp[0][1] + ' marks');
  if (ABBREVIATIONS && ABBREVIATIONS.size) {
    parts.push('a period after ' + [...ABBREVIATIONS].slice(0, 2).map(t => cap1(t) + '.').join(' or ') + ' as not ending its sentence');
  }
  parts.push(ACTIVE_LANG === 'es' ? 'a dash as opening dialogue' : 'dashes as not opening dialogue');
  const verbs = getAttribVerbs();
  if (verbs.length) parts.push('words like ' + verbs.slice(0, 2).join('/') + ' after a quote as naming the speaker');
  if (SPEAKER_LABEL_RES && SPEAKER_LABEL_RES.length) parts.push('a label and colon opening a line as that voice speaking');
  return 'The reader currently treats: ' + parts.join('; ') + '.';
}

function buildProposerPrompt() {
  const frictions = nominateFriction();
  const fLines = frictions.map(f => {
    const where = f.docs.length > 1 ? 'across ' + f.docs.length + ' documents' : 'in one document';
    let line;
    if (f.type === 'speaker-label') {
      line = 'Lines beginning "' + f.label + ':" were followed by a statement ' + f.count + ' times ' + where + '; the reader bound no speaker to them.';
    } else if (f.type === 'separator') {
      line = 'A line of punctuation ("' + f.label + '") separated sections ' + f.count + ' times ' + where + '; the reader treated it as a sentence.';
    } else {
      line = 'A pronoun could have been either ' + f.label + ' ' + f.count + ' times ' + where + '; the reader did not commit.';
    }
    const spans = f.spans.map(sp => sp.sid + ' "' + String(sp.text).split(/\s+/).slice(0, 12).join(' ') + '"').join(' / ');
    return f.n + '. ' + line + '\n   Example spans: ' + spans;
  });
  const user = 'CONVENTIONS IN FORCE (for this register)\n' + conventionsPortrait()
    + '\n\nFRICTION OBSERVED (this session, across the loaded documents)\n' + fLines.join('\n')
    + '\n\nTASK\nFor any friction item where you can state a reading convention that would resolve it, '
    + 'propose the convention. Reply with one block per proposal, exactly in this form:\n\n'
    + 'PROPOSAL\nconvention: <the convention in one plain sentence, at most 60 words>\n'
    + 'register: <which register of text it belongs to>\n'
    + 'evidence: <the numbered spans that evidence it, like †1 †2>\n'
    + 'resolves: friction <number>\n\n'
    + 'Propose nothing for friction you cannot resolve. Do not propose changes to conventions '
    + 'in force unless a friction item contradicts one.';
  const system = 'You are reading a portrait of how a reader currently reads, plus friction that reading hit. Answer only in the requested blocks, nothing else.';
  return { system, user, frictions };
}

// 4.3/4.4 — receive the model's reply: enforce the closed grammar, then the
// engine mints everything (anchors, records, seqs). Violations are discarded
// and REC'd — a model that babbles teaches the veto.
const _PROPOSAL_LEAD_OK = /^(The|A|An|It|This|That|These|Those|What|When|Where|Who|Why|How|And|But|Or|So|Yet|If|Because|While|Though|Although|Since|Lines|Line|Reply|Propose)$/;

function _recProposalFailure(reason, sentence) {
  const m = /^invented-name:(.+)$/.exec(reason);
  if (m) {
    // an invented name in a proposal is the same failure mode as an invented
    // name in a draft — it deposits toward the eva lexicon (two = a neuron)
    noteEvaFailure([reason], { lang: ACTIVE_LANG });
    return;
  }
  const rec = {
    op: 'REC', target: 'core:proposal_vetoes', action: 'proposal-veto',
    value: { reason, sentence: String(sentence || '').slice(0, 120) },
    seq: CONV_HEAD++, at: Date.now(),
  };
  CONVENTIONS_DELTA.push(rec);
}

async function receiveProposals(reply, opts = {}) {
  const frictions = nominateFriction();
  const text = String(reply == null ? '' : reply).replace(/```/g, '\n');
  const blocks = text.split(/(?:^|\n)\s*PROPOSAL\s*(?:\n|$)/i).slice(1);
  const out = { accepted: [], merged: [], rejected: [] };
  for (const block of blocks) {
    const field = (name) => {
      const m = new RegExp('(?:^|\\n)\\s*' + name + '\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:convention|register|evidence|resolves)\\s*:|$)', 'i').exec(block);
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };
    const sentence = field('convention'), register = field('register');
    const evidence = field('evidence'), resolves = field('resolves');
    const reject = (reason) => { out.rejected.push({ reason, sentence: sentence.slice(0, 80) }); _recProposalFailure(reason, sentence); };
    if (!sentence || !evidence || !resolves) { reject('malformed'); continue; }
    if (sentence.split(/\s+/).length > 60) { reject('too-long'); continue; }
    const sids = sentenceUniq(evidence.match(/†\d+/g) || []);
    if (!sids.length || sids.some(sid => !SESSION.sids.has(sid))) { reject('unknown-span'); continue; }
    const fm = /(\d+)/.exec(resolves);
    const friction = fm ? frictions.find(f => f.n === +fm[1]) : null;
    if (!friction) { reject('unsolicited'); continue; }
    const spanText = sids.map(sid => SESSION.sids.get(sid).text).join(' ').toLowerCase();
    const nouns = (sentence.match(/\b[A-Z][a-zA-Z]+\b/g) || []).filter(w => !_PROPOSAL_LEAD_OK.test(w));
    const invented = nouns.find(w => spanText.indexOf(w.toLowerCase()) === -1);
    if (invented) { reject('invented-name:' + invented); continue; }
    const res = await _convertProposal({ sentence, register, sids, friction }, opts);
    if (res.merged) out.merged.push(res.id);
    else if (res.id) out.accepted.push(res.id);
    else out.rejected.push({ reason: res.reason, sentence: sentence.slice(0, 80) });
  }
  return out;
}
function sentenceUniq(arr) { return [...new Set(arr)]; }

// the linkage contract, enforced on every candidate before it may enter the
// log: nine-operator vocabulary, edges connect declared nodes, conventions
// are assertions and revisable. Malformed candidates never land.
const _EO_OPS = new Set(['INS', 'SYN', 'DEF', 'SIG', 'NUL', 'SEG', 'CON', 'EVA', 'REC']);
function _validateCandidate(records) {
  const declared = new Set(KNOWN_NODE_IDS);
  for (const r of records) if (r.op === 'INS' && r.id) declared.add(r.id);
  for (const r of records) {
    if (!_EO_OPS.has(r.op)) return { ok: false, reason: 'bad-op:' + r.op };
    if (r.op === 'INS' && r.kind === 'convention') {
      if (!r.id || r.epistemic !== 'assertion' || r.revisable !== true) return { ok: false, reason: 'ins-not-assertion' };
    }
    if (r.op === 'SYN') {
      if (r.v === 'member-of') { if (!declared.has(r.o)) return { ok: false, reason: 'dangling-member:' + r.o }; }
      else if (!declared.has(r.s) || !declared.has(r.o)) return { ok: false, reason: 'dangling-link:' + r.s + '→' + r.o };
    }
  }
  return { ok: true };
}

// id-safe slug; an all-punctuation shape ("***") falls back to its hash so
// two different shapes can never collide on one proposal id
const _slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
  || ('x' + sha256Hex(String(s)).slice(0, 8));

// 4.4 — mechanical conversion: the engine resolves span-ids, mints anchors,
// distills records by friction type (the taxonomy is small and closed),
// validates, and appends the candidate as a SIGNAL — below θ_admit by
// construction, since every anchor is the model's.
async function _convertProposal(p, opts = {}) {
  const spans = p.sids.map(sid => SESSION.sids.get(sid));
  const sentenceNorm = normalizeSpan(p.sentence).toLowerCase();
  const anchors = [];
  const seen = new Set();
  for (const sp of spans) {
    const a = mintAnchor(sp.text, 'llm-proposer');
    if (!seen.has(a.h)) { seen.add(a.h); anchors.push(a); }
  }
  let propSig = null;
  const embed = opts.embed || ANCHOR_EMBED;
  if (embed) {
    try {
      const vecs = await embed(spans.map(s => s.text).concat([p.sentence]));
      if (vecs) {
        anchors.forEach((a, i) => { if (vecs[i]) a.sig = quantizeSig(vecs[i]); });
        if (vecs[spans.length]) propSig = quantizeSig(vecs[spans.length]);
      }
    } catch (e) { /* embedder failure never blocks a proposal */ }
  }
  // 4.5 cross-session recurrence: a cosine-close (or same-shape, or
  // h-overlapping) proposal MERGES — model anchors union under independence,
  // visibility rises, admissibility does not (clause 3 stands).
  const dup = PROPOSER.signals.find(s =>
    (s.frictionKey && s.frictionKey === p.friction.id)
    || (s.sentence && normalizeSpan(s.sentence).toLowerCase() === sentenceNorm)
    || (propSig && s.sig && sigCos(propSig, s.sig) >= 0.92)
    || anchors.some(a => (s.anchors || []).some(b => b.h === a.h)));
  if (dup) {
    const have = new Set((dup.anchors || []).map(a => a.h));
    for (const a of anchors) if (!have.has(a.h)) { dup.anchors.push(a); have.add(a.h); }
    dup.visibility = (dup.visibility || 1) + 1;
    _checkAdmission(dup);
    return { merged: true, id: dup.id };
  }
  let records = [], probe = null, rule = null, id = null;
  if (p.friction.type === 'speaker-label') {
    rule = 'speaker_label_patterns';
    probe = '^([A-Z][A-Z0-9&.\\-]{1,11}):\\s+(\\S.*)$';
    id = 'proposed:speaker_label_patterns:' + _slug(p.friction.label);
    records = [
      { op: 'INS', kind: 'convention', id, rule, module: 'core', epistemic: 'assertion', revisable: true,
        statement: p.sentence, register: p.register || null, probe, frictionType: p.friction.type,
        prov: anchors.map(a => ({ ...a })) },
      { op: 'SYN', s: probe, v: 'member-of', o: id, prov: [{ ...anchors[0] }] },
      { op: 'SYN', s: id, v: 'feeds', o: 'mechanics:attribution', kind: 'link' },
      { op: 'SYN', s: id, v: 'feeds', o: 'mechanics:person-promotion', kind: 'link' },
    ];
  } else if (p.friction.type === 'separator') {
    rule = 'separator_lines';
    probe = '^[\\s*\\-–—=~_·•.]{3,}$';
    id = 'proposed:separator_lines:' + _slug(p.friction.label || 'separator');
    records = [
      { op: 'INS', kind: 'convention', id, rule, module: 'core', epistemic: 'assertion', revisable: true,
        statement: p.sentence, register: p.register || null, probe, frictionType: p.friction.type,
        prov: anchors.map(a => ({ ...a })) },
      { op: 'SYN', s: probe, v: 'member-of', o: id, prov: [{ ...anchors[0] }] },
      { op: 'SYN', s: id, v: 'excepts', o: 'mechanics:sentence-boundary', kind: 'link' },
    ];
  } else {
    // the friction taxonomy is closed; anything outside it is REC'd as
    // unmappable and queued for the audit drawer, never guessed at
    const rec = {
      op: 'REC', target: 'core:proposal_vetoes', action: 'unmappable',
      value: { sentence: p.sentence, friction: p.friction.id },
      seq: CONV_HEAD++, at: Date.now(),
    };
    CONVENTIONS_DELTA.push(rec);
    PROPOSER.signals.push({
      id: 'unmappable:' + _slug(p.friction.id), status: 'unmappable',
      sentence: p.sentence, register: p.register || null, frictionKey: p.friction.id,
      frictionType: p.friction.type, probe: null, rule: null, records: [rec],
      anchors, sig: propSig, segCounts: new Map(), visibility: 1, at: Date.now(),
    });
    return { id: null, reason: 'unmappable' };
  }
  const v = _validateCandidate(records);
  if (!v.ok) { _recProposalFailure('malformed-records:' + v.reason, p.sentence); return { id: null, reason: v.reason }; }
  for (const r of records) { r.seq = CONV_HEAD++; r.at = r.at || Date.now(); }
  CONVENTIONS_DELTA.push(...records);
  KNOWN_NODE_IDS.add(id);
  const signal = {
    id, status: 'signal', sentence: p.sentence, register: p.register || null,
    frictionKey: p.friction.id, frictionType: p.friction.type, probe, rule,
    records, anchors, sig: propSig, segCounts: new Map(), visibility: 1, at: Date.now(),
  };
  PROPOSER.signals.push(signal);
  _checkAdmission(signal);    // cannot pass on model anchors alone — by construction
  return { id };
}

// 4.6 — admission: a REC in the conventions log, and the inventory member
// lands through the ledger (the same channel induction uses), so the next
// fold rebuilds the lexical sets and the reading changes.
function _checkAdmission(signal) {
  if (!signal || signal.status === 'admitted' || signal.status === 'rejected') return false;
  const verdict = admitAnchors(signal.anchors, { segCounts: signal.segCounts });
  if (!verdict.ok) return false;
  signal.status = 'admitted';
  signal.admittedAt = Date.now();
  signal.verdict = verdict;
  const admitRec = {
    op: 'REC', target: signal.id, action: 'admit',
    value: { sum: verdict.sum, distinct: verdict.distinct, theta: verdict.theta },
    prov: signal.anchors.map(a => ({ ...a })),
    seq: CONV_HEAD++, at: Date.now(),
  };
  CONVENTIONS_DELTA.push(admitRec);
  signal.records = (signal.records || []).concat([admitRec]);
  if (signal.rule && signal.probe) {
    ledgerCommit({
      target: 'rule:' + signal.rule, action: 'add-token', bucket: 'core',
      value: signal.probe, mass: verdict.sum,
      basis: { anchors: verdict.distinct }, src: 'proposal-admission',
    });
  }
  for (const r of signal.records) _shipConventionRecord(Object.assign({}, r, { admitted: true }));
  return true;
}

// 4.5 corroboration channel 1 — document co-witness, run on every parse: a
// pending signal's probe matching a document whose span-hashes are disjoint
// from the signal's anchors mints a c:1.0 anchor onto it. Automatic; no-op
// while no signals are pending (every shipped reading).
function coWitnessScan(doc) {
  if (!doc || doc.kind !== 'prose') return;
  const docHs = DOC_SPANS.get(doc.id);
  if (!docHs) return;
  for (const sig of PROPOSER.signals) {
    if (sig.status !== 'signal' || !sig.probe) continue;
    const anchorHs = new Set((sig.anchors || []).map(a => a.h));
    let disjoint = true;
    for (const h of anchorHs) if (docHs.has(h)) { disjoint = false; break; }
    if (!disjoint) continue;
    let re;
    try { re = sig._probeRe || (sig._probeRe = new RegExp(sig.probe, 'u')); } catch (e) { continue; }
    const hitIdx = (doc.sentenceTexts || []).findIndex(t => re.test(String(t).trim()));
    if (hitIdx < 0) continue;
    const a = mintAnchor(doc.sentenceTexts[hitIdx], 'doc');
    if (anchorHs.has(a.h)) continue;
    sig.anchors.push(a);
    const rec = {
      op: 'REC', target: sig.id, action: 'co-witness', value: { hits: 1 },
      prov: [{ ...a }], seq: CONV_HEAD++, at: Date.now(),
    };
    CONVENTIONS_DELTA.push(rec);
    sig.records = (sig.records || []).concat([rec]);
    _checkAdmission(sig);
  }
}

// 4.5 corroboration channels 2/3 — the drawer's one-tap user verdicts.
function confirmProposal(id) {
  const sig = PROPOSER.signals.find(s => s.id === id);
  if (!sig || sig.status === 'admitted' || sig.status === 'rejected') return { ok: false, status: sig && sig.status };
  const a = { h: spanHash('user-confirm|' + id), sig: null, r: 'user', c: ANCHOR_COUPLING.user, t: CONV_HEAD++ };
  sig.anchors.push(a);
  const rec = { op: 'REC', target: id, action: 'user-confirm', prov: [a], seq: CONV_HEAD++, at: Date.now() };
  CONVENTIONS_DELTA.push(rec);
  sig.records = (sig.records || []).concat([rec]);
  const admitted = _checkAdmission(sig);
  return { ok: admitted, status: sig.status };
}
function rejectProposal(id) {
  const sig = PROPOSER.signals.find(s => s.id === id);
  if (!sig || sig.status === 'rejected') return { ok: false, status: sig && sig.status };
  const against = (sig.anchors || []).map(a => a.h);
  const ua = { h: spanHash('user-reject|' + id), sig: null, r: 'user', c: ANCHOR_COUPLING.user, t: CONV_HEAD++ };
  const segRec = { op: 'SEG', target: id, against, prov: [ua], reason: 'user-reject', seq: CONV_HEAD++, at: Date.now() };
  CONVENTIONS_DELTA.push(segRec);
  sig.records = (sig.records || []).concat([segRec]);
  for (const h of against) sig.segCounts.set(h, (sig.segCounts.get(h) || 0) + 1);
  sig.status = 'rejected';
  sig.rejectedAt = Date.now();
  // the rejection is itself a sighting toward a negative convention: a model
  // that keeps proposing the same rejected shape feeds the veto lexicon
  const k = (sig.frictionType || 'shape') + '|' + (sig.probe || normalizeSpan(sig.sentence || '').toLowerCase());
  const n = (PROPOSER.rejects.get(k) || 0) + 1;
  PROPOSER.rejects.set(k, n);
  if (n >= 2) {
    CONVENTIONS_DELTA.push({
      op: 'REC', target: 'core:proposal_vetoes', action: 'rejected-shape',
      value: { shape: k, sightings: n }, seq: CONV_HEAD++, at: Date.now(),
    });
  }
  return { ok: true, status: 'rejected', mass: anchorMass(sig.anchors, { segCounts: sig.segCounts }) };
}

// The drawer's Proposals channel: the convention sentence, its evidence
// (locally resolvable — docId/sentence index; the host renders the text),
// current mass, distance to admission. Anchors are shown without sigs.
function pendingProposals() {
  const theta = READING_RULES.theta_admit ? READING_RULES.theta_admit.value : 2.0;
  return PROPOSER.signals.map(s => {
    const verdict = admitAnchors(s.anchors, { segCounts: s.segCounts });
    return {
      id: s.id, status: s.status, sentence: s.sentence, register: s.register,
      friction: s.frictionKey || null, frictionType: s.frictionType || null,
      visibility: s.visibility || 1, mass: verdict.sum, theta,
      distance: Math.max(0, +(theta - verdict.sum).toFixed(2)),
      witnesses: { distinct: verdict.distinct, nonModel: verdict.nonModel },
      evidence: (s.anchors || []).map(a => Object.assign({ h: a.h, reader: a.r, c: a.c }, resolveAnchor(a.h) || {})),
    };
  });
}

// The full opportunistic turn, host-callable at idle: status gate → prompt →
// one model call → grammar-enforced receipt. Never blocks the chat (the host
// schedules it); never runs without registered friction or past its budget.
async function runProposerTurn(opts = {}) {
  const st = proposerStatus();
  if (!st.eligible) return { ran: false, reason: st.reason };
  if (typeof opts.llm !== 'function') return { ran: false, reason: 'no model' };
  SESSION.proposalsUsed++;
  const prompt = buildProposerPrompt();
  let reply = '';
  try { reply = String((await opts.llm(prompt.system, prompt.user)) || ''); }
  catch (e) { return { ran: true, error: String((e && e.message) || e), accepted: [], merged: [], rejected: [] }; }
  const res = await receiveProposals(reply, opts);
  return Object.assign({ ran: true }, res);
}

// strict privacy: shipped records lose their sigs (embedding inversion leaks
// at most one sentence's gist per anchor; strict mode closes even that).
function _privacyStrip(rec) {
  if (ANCHOR_PRIVACY !== 'strict' || !Array.isArray(rec.prov)) return rec;
  return Object.assign({}, rec, { prov: rec.prov.map(a => Object.assign({}, a, { sig: null })) });
}
function _conventionsDedupKey(rec) {
  const hs = Array.isArray(rec.prov) ? rec.prov.map(a => a && a.h).filter(Boolean).sort().join(',') : '';
  let val = '';
  try { val = rec.value === undefined ? '' : JSON.stringify(rec.value); } catch (e) {}
  return [rec.op, rec.target || rec.o || rec.id || '', rec.action || rec.v || '', val, hs].join('|');
}
const _SHIPPED_KEYS = new Set();
function _shipConventionRecord(rec) {
  try {
    const k = _conventionsDedupKey(rec);
    if (_SHIPPED_KEYS.has(k)) return;
    _SHIPPED_KEYS.add(k);
    const hook = (typeof window !== 'undefined' && window.EOEngine && window.EOEngine.onConventionsRec);
    if (typeof hook === 'function') hook(_privacyStrip(rec));
  } catch (e) { /* a hook failure never blocks the reading */ }
}

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
const PACK_FOR_LANG = { en: 'en-narrative-v1', es: 'es-narrative-v1', zh: 'zh-narrative-v1', code: 'code-v1', grc: 'el-classical-v1' };
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
  'proposal_auto_accept_sim', 'sentinel_draft_overlap', 'sentinel_budget_ratio', 'sentinel_max_drafts',
  'relation_gate', 'relation_align_floor', 'relation_rel_floor']);
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

// Registered by applyRules once it exists (it may live in a narrower
// scope); lets deriveSets re-apply the host's standing rules after a
// re-derivation without assuming they share a scope.
let _reapplyHostRules = null;
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
  // The host's standing rule settings survive the re-derivation. A ledger
  // commit mid-session (verb induction during a parse) used to silently
  // revert every panel-tuned value — and any flipped flag like
  // relation_gate — to its seed until the next panel change. The app
  // maintains window.EO_RULES; re-applying it here keeps the settings
  // where the user put them. Unset (the Node harness, parity) ⇒ no-op;
  // untouched defaults re-apply seed-equal values ⇒ also a no-op.
  if (_reapplyHostRules && typeof window !== 'undefined' && Array.isArray(window.EO_RULES))
    _reapplyHostRules(window.EO_RULES);
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
// COPULAR is built in rebuildLangSets from the copular_verbs convention.

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
// Does a surface lead with a personal title ("Mr. Calloway", "Senator Alexander",
// "Chief Drake")? A title is unambiguous person evidence, gender aside. Requires
// a following capitalized token so a bare "Captain" / "President" (a role used as
// a common noun) doesn't type on its own.
function leadsWithTitle(surface) {
  if (!TITLE_TOKENS || !TITLE_TOKENS.size) return false;
  const words = String(surface == null ? '' : surface).trim().split(/\s+/);
  if (words.length < 2) return false;
  const first = words[0].toLowerCase().replace(/\.$/, '');
  return TITLE_TOKENS.has(first) && /^\p{Lu}/u.test(words[1]);
}
function looksProper(s) { return /^\p{Lu}[\p{L}\p{M}\p{N}'’.-]*(\s+\p{Lu}[\p{L}\p{M}\p{N}'’.-]*)*$/u.test(String(s).trim()); }
// Place/organization surface cues — words that mark a proper name as NOT a
// person, so the animate-pronoun promotion below never turns a river or a firm
// into a character.
// PLACE_ORG_CUE_RE is built from the place_org_cues convention (see rebuildLangSets).
// A proper-name surface that plausibly names a PERSON: capitalized, one to
// three tokens, no digits, no place/org cue, not document chrome. Used only to
// decide whether an animate pronoun may bind-and-promote a `thing` — never to
// type on its own.
function looksLikePerson(name) {
  const t = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!t || /\d/.test(t) || PLACE_ORG_CUE_RE.test(t)) return false;
  if (!looksProper(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 1 && words.length <= 3;
}
function normSurface(s) { return String(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// Conservative singular stem so plural/singular variants of one token bind:
//   Cossacks → cossack, Russians → russian, cities → city, churches → church.
// Returns null when no safe stem exists (short tokens, -ss/-us/-is endings).
function singularStem(t) {
  if (t.length <= 4) return null;
  let stem = null;
  if (t.endsWith('ies')) stem = t.slice(0, -3) + 'y';
  else if (t.endsWith('sses')) stem = t.slice(0, -2);                 // dresses → dress
  else if (t.endsWith('ches') || t.endsWith('shes') || t.endsWith('xes')) stem = t.slice(0, -2);
  else if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) stem = t.slice(0, -1);
  return (stem && stem.length >= 3 && !STOP.has(stem)) ? stem : null;
}

function tokenSetOf(name) {
  const raw = (String(name).toLowerCase().match(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) || [])
    .filter(t => t.length > 1 && !STOP.has(t));
  const expanded = new Set(raw);
  for (const t of raw) {
    const stem = singularStem(t);
    if (stem) expanded.add(stem);
  }
  // Diacritic-folded variant of each token, so accented and unaccented forms
  // of one name share a token under gravity ("Joaquín" ↔ "Joaquin", "Guzmán" ↔
  // "Guzman"). Additive only (the accented token stays), and scoped to the
  // entity-gravity token space — the retrieval index tokenizes separately.
  for (const t of [...expanded]) {
    const f = foldDiacritics(t);
    if (f !== t && f.length >= 2) expanded.add(f);
  }
  return expanded;
}

// ── Universal mechanisms that consume the production-guard pattern
//    conventions (chrome_patterns / metaphor_frames / type_keywords_*).
//    The DATA is a convention (language-specific, lives in the conventions
//    graph); the MACHINERY here is register-agnostic. ──

// Compile a convention member into a RegExp. Members may be bare sources
// (compiled with the unicode flag, like separator_lines/speaker_label_patterns)
// or self-describing /pattern/flags literals (so each pattern carries its own
// case-sensitivity). A malformed member is skipped, never thrown.
function compileConventionRegexes(sources) {
  const out = [];
  for (const src of (sources || [])) {
    const s = String(src);
    const lit = s.match(/^\/(.*)\/([a-z]*)$/is);   // /pattern/flags
    try { out.push(lit ? new RegExp(lit[1], lit[2]) : new RegExp(s, 'u')); }
    catch (e) { /* a bad pattern never breaks the reading */ }
  }
  return out;
}

// Diacritic fold: "Guzmán" → "guzman", "Joaquín" → "joaquin". Lets a
// merge/seek treat accented and unaccented forms of one name as equal.
function foldDiacritics(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ── Name-identity machinery (the SYN gate's evidence) ──
// The ORDERED sequence of a surface form's content tokens, folded and
// singular-stemmed: "Winnipeg Symphony Orchestra" → [winnipeg, symphony,
// orchestra], "Genie Awards" → [genie, award]. Unlike tokenSetOf (a recall
// bag for gravity force and retrieval), this preserves position — and for
// proper-noun phrases position IS identity: the left specifier
// distinguishes, the shared head merely classifies.
function contentSeqOf(name) {
  const words = String(name).toLowerCase().match(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) || [];
  const seq = [];
  for (const w of words) {
    if (w.length < 3 || STOP.has(w)) continue;
    const folded = foldDiacritics(w);
    seq.push(singularStem(folded) || folded);
  }
  return seq;
}

const seqEqual = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

// Offset of `short` as a CONTIGUOUS word-run inside `long`, or -1.
function seqIndexOf(short, long) {
  for (let o = 0; o + short.length <= long.length; o++) {
    let hit = true;
    for (let j = 0; j < short.length; j++) if (long[o + j] !== short[j]) { hit = false; break; }
    if (hit) return o;
  }
  return -1;
}

// Is `short` an ordered (possibly gapped) subsequence of `long`?
// "howard shore" ⊂ "howard leslie shore" — middle-name elision.
function isOrderedSubseq(short, long) {
  let i = 0;
  for (const t of long) { if (i < short.length && t === short[i]) i++; }
  return i === short.length;
}

// Can two surface forms name the SAME referent? Identity precedence over
// lexical overlap: shared-token COUNT is not identity evidence — "Winnipeg
// Symphony Orchestra" and "Toronto Symphony Orchestra" share two of three
// tokens and are different orchestras; "Golden Globe Awards" and "Genie
// Awards" share their head and are different awards. For a proper-noun
// phrase the identifying information lives in the LEFT specifier, so two
// forms co-refer only when one is the other's honest short form:
//   · equal content sequences (case/diacritic/plural variants) — always;
//   · equal-arity sequences that differ anywhere — NEVER (the specifier
//     disagreement veto: premodifiers disagreeing past a shared head);
//   · persons: the shorter is an ordered subsequence of the longer
//     ("Shore" ⊂ "Howard Shore", "Howard Shore" ⊂ "Howard Leslie Shore",
//     "Tse" ⊂ "Tse Chi Lop") — given name, surname, and middle-name
//     elision all preserve the sequence; "Mac Shore" vs "Howard Shore"
//     fails it and stays apart;
//   · non-persons keep the HEAD: a single token must equal the longer's
//     final token ("Partnership" ⊂ "Nashville Downtown Partnership", but
//     never "Nashville" ⊂ "Nashville Banner" — the city the org is named
//     after); a multi-token shorter must be a contiguous suffix
//     ("Symphony Orchestra" ⊂ "Winnipeg Symphony Orchestra"), a
//     contiguous prefix whose dropped tail is ALL generic class nouns
//     ("Golden Globe" ⊂ "Golden Globe Awards", "Davidson County Chancery"
//     ⊂ "Davidson County Chancery Court" — but never "Max Steiner" ⊂
//     "Max Steiner Film Music Achievement Award", whose tail is a name's
//     worth of content), or an EDGE-ANCHORED elision: same specifier,
//     same head, inner tokens elided ("Howard Shore" ⊂ "Howard Leslie
//     Shore"). The elision shape is person-typical, but compromise's NER
//     cannot be trusted to say so ("Howard" tags as Place), so the shape
//     itself is the evidence.
// Entity-type agreement is enforced where typing is STRONG — the gendered-
// title veto at the gate — and the person-vs-award shape the weak NER veto
// would have caught is already vetoed structurally here (a name's-worth
// tail blocks the prefix path). Raw NER types are surface noise of exactly
// the kind this gate exists to demote; a veto on them splits real subjects.
// Gravity force (mass × overlap) still RANKS the admitted candidates; it
// just no longer ADMITS them — overlap is a tie-breaker within identity,
// never an override of it.
function genericNameHead(t) {
  return (NP_GENERIC_HEADS && NP_GENERIC_HEADS.has(t))
    || (TYPE_KW_ORG && TYPE_KW_ORG.has(t))
    || (TYPE_KW_PLACE && TYPE_KW_PLACE.has(t));
}
function namesCoRefer(seqA, seqB, bothPersons) {
  if (!seqA.length || !seqB.length) return false;
  if (seqEqual(seqA, seqB)) return true;
  if (seqA.length === seqB.length) return false;
  const [short, long] = seqA.length < seqB.length ? [seqA, seqB] : [seqB, seqA];
  if (bothPersons) return isOrderedSubseq(short, long);
  if (short.length === 1) return short[0] === long[long.length - 1];
  const at = seqIndexOf(short, long);
  if (at !== -1) {
    if (at + short.length === long.length) return true;
    if (at === 0) {
      for (let j = short.length; j < long.length; j++) if (!genericNameHead(long[j])) return false;
      return true;
    }
    return false;
  }
  return short[0] === long[0] && short[short.length - 1] === long[long.length - 1]
    && isOrderedSubseq(short, long);
}

// Track the FULLEST form a site has been sighted as (longest content
// sequence, then longest string). The SYN gate tests arrivals against this
// — the site's most complete identity statement — never against the
// accumulated token bag, whose growth across merges is what let one false
// join snowball into a cluster that swallowed every name sharing a head.
function noteFullForm(site, surface) {
  const seq = contentSeqOf(surface);
  if (!site.fullSeq || seq.length > site.fullSeq.length ||
      (seq.length === site.fullSeq.length && String(surface).length > String(site.fullForm || '').length)) {
    site.fullSeq = seq;
    site.fullForm = String(surface);
  }
}

// Normalize a CON relation verb: drop auxiliaries/copulas and punctuation so
// "is running" and "runs," both read as "running"/"runs". The same auxiliary
// set the SVO extractor already rejects inline — relation extraction, not a
// new lexical convention.
function normalizeRelation(verb) {
  return String(verb).toLowerCase()
    .replace(/[,.;:]/g, '')
    .replace(/\b(is|are|was|were|be|been|being|has|have|had|do|does|did)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

// ── Depicted act of a relation verb ──────────────────────────────────────────
// The story-world transformation a clause REPORTS, returned as content for the
// reader's CON bond — never the bond's own op (that is always CON). Returns
// { op, obj } for an event-verb, { state:true } for a stative relation (a pure
// Site-face fact, no operator), or null when the verb is unclassified (the
// reader hasn't committed). The verb-class lexicon votes at full weight; an
// optional EVALUATOR — the autonomous local model — adds a soft weight CAPPED at
// its coupling, so it can tip an unclassified verb but never override a
// classified one. That is the whole of "a little evaluative consciousness, just
// a weighting": the model is the weakest reader in the room, never a gate.
let DEPICTS_EVALUATOR = null;
const DEPICTS_EVAL_COUPLING = 0.6;   // the local model's coupling — below the lexicon's 1.0
function setDepictsEvaluator(fn) { DEPICTS_EVALUATOR = typeof fn === 'function' ? fn : null; }
function verbLemmas(w) {
  const out = new Set([w]);
  if (w.endsWith('ies') || w.endsWith('ied')) out.add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
  if (w.endsWith('ed')) { out.add(w.slice(0, -2)); out.add(w.slice(0, -1)); if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) out.add(w.slice(0, -3)); }
  if (w.endsWith('ing')) { out.add(w.slice(0, -3)); out.add(w.slice(0, -3) + 'e'); if (w.length > 5 && w[w.length - 4] === w[w.length - 5]) out.add(w.slice(0, -4)); }
  return out;
}
function depictedAct(verb, ctx) {
  const head = (normalizeRelation(verb) || String(verb || '').toLowerCase()).split(/\s+/)[0];
  if (!head) return null;
  const lemmas = verbLemmas(head);
  const votes = new Map();
  const add = (op, w) => votes.set(op, (votes.get(op) || 0) + w);
  for (const l of lemmas) {
    if (SEG_VERBS && SEG_VERBS.has(l)) add('SEG', 1);
    if (SYN_VERBS && SYN_VERBS.has(l)) add('SYN', 1);
    if (STATE_VERBS && STATE_VERBS.has(l)) add('STATE', 1);
  }
  if (DEPICTS_EVALUATOR) {
    try {
      const e = DEPICTS_EVALUATOR(head, ctx);
      if (e && e.op) add(e.op, Math.min(Math.max(e.weight || 0, 0), DEPICTS_EVAL_COUPLING));
    } catch (err) { /* an evaluator error never breaks the reading */ }
  }
  if (!votes.size) return null;
  let best = null, bw = -Infinity;
  for (const [op, w] of votes) if (w > bw) { bw = w; best = op; }
  if (best === 'STATE') return { state: true, w: +bw.toFixed(3) };
  return { op: best, obj: 'figure', w: +bw.toFixed(3) };
}

// Page chrome: a line that is structure (nav, boilerplate, byline, rule),
// not prose. Stays in the spine; reaches no operator emitter.
function isChrome(text) {
  if (!CHROME_RES || !CHROME_RES.length) return false;
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  for (const rx of CHROME_RES) { rx.lastIndex = 0; if (rx.test(trimmed)) return true; }
  return false;
}
// The Project Gutenberg wrapper markers, read from their conventions
// (gutenberg_start_markers / gutenberg_end_markers) the way isChrome reads
// chrome_patterns. Each returns the first regex MATCH rather than a bare
// boolean, so the caller can both test for the marker and use the match
// position to strip the apparatus fused into the same sentence. Empty
// inventory ⇒ null (the convention is inert, never throws).
function matchGutenbergStart(text) {
  const s = String(text);
  for (const rx of (GUTENBERG_START_RES || [])) { rx.lastIndex = 0; const m = rx.exec(s); if (m) return m; }
  return null;
}
function matchGutenbergEnd(text) {
  const s = String(text);
  for (const rx of (GUTENBERG_END_RES || [])) { rx.lastIndex = 0; const m = rx.exec(s); if (m) return m; }
  return null;
}

// ── De-chroming: the document-level verdict over the chrome gate ──────────
// The chrome gate (isChrome / the Gutenberg wrapper) tags each apparatus line
// as it reads and collects its index into doc._chrome — the line stays verbatim
// in the spine but reaches no operator emitter. This pass reads that verdict at
// the scale of the whole document: it groups the gated lines into contiguous
// SEGMENTS, labels each by the kind of chrome it is (web share / subscribe /
// nav / copyright / byline vs. book apparatus), and records a SEG-shaped
// boundary decision per segment carrying the raw span's content hash as prov.
// Nothing is removed — the full page is still in sentenceTexts — so a strip is
// recoverable: the segments name exactly what the de-chromed view holds back,
// and a turn about the html / the de-chroming queries the full content against
// them. Pure addition: these SEG verdicts live on the doc (doc._dechrome), never
// in the append-only event log, so golden parity holds.
//
// The labels are for the report only — what counts as chrome is decided once, by
// the chrome_patterns convention, not here; a line matching no bucket is generic
// 'apparatus' (a Gutenberg wrapper line, an OCR heading).
const _DECHROME_LABELS = [
  // [reason, web?, /test/] — first match wins.
  ['share',       true,  /^(share|tweet|post|pin it|pinterest|email|print|copy link|save|whatsapp|reddit|linkedin|flipboard|facebook|twitter)(\s*[•|·/]?\s*(share|tweet|post|pin it|pinterest|email|print|copy link|save|whatsapp|reddit|linkedin|flipboard|facebook|twitter|x))*\s*$/i],
  ['subscribe',   true,  /\$\d|\b(subscribe (?:now|today|for|to)|sign\s?up|create an account|enter your email|newsletter)\b/i],
  ['meta',        true,  /^\d+\s+(min(?:ute)?s?\s+read|comments?)\b/i],
  ['nav',         true,  /^((?:home|menu|sections?|topics?|search|more|about|us|contact|submit|advertise|advertisement|renew|manage|terms|privacy|subscribe|sign|in|log|newsletter|latest|issue)\s*)+$/i],
  ['signin',      true,  /\b(?:sign\s?in|log\s?in)\b/i],
  ['copyright',   true,  /(©|\(c\)|copyright|all rights reserved|registered trademark)/i],
  ['byline',      true,  /^by\s+[a-z]/i],
  ['rule',        false, /^[\s_*=·•—–-]{3,}$|^\*\s*\*\s*\*/],
  ['section',     false, /^\s*={2,6}\s*[^=\s].*?={2,6}\s*$/],
  ['frontmatter', false, /^(contents|index|preface|introduction|appendix|notes?|footnotes?|bibliography|glossary|errata|epilogue|prologue|dedication|illustrations?|chapter|book|volume|part|section|canto|act|scene|cap[ií]tulo)\b/i],
  ['numbering',   false, /^([ivxlcdm]+|\d+)[.)]?$/i],
  ['transcriber', false, /^(produced|prepared|transcribed|digitized|translated|edited|illustrated|compiled|adapted|annotated)\s+by\b|^transcriber/i],
  ['heading',     false, /^[A-Z0-9][A-Z0-9 ,;:.’'&()-]{5,}$/],
];
function _dechromeLabel(text) {
  const t = String(text == null ? '' : text).trim();
  for (const [reason, web, rx] of _DECHROME_LABELS) { rx.lastIndex = 0; if (rx.test(t)) return { reason, web }; }
  return { reason: 'apparatus', web: false };
}
// Read the chrome gate's verdict at document scale (see above). Pure; safe on
// any doc — an empty _chrome yields { present:false } and changes nothing.
function computeDechrome(doc) {
  const sents = (doc && doc.sentenceTexts) || [];
  const chrome = (doc && doc._chrome) || [];
  const idxs = [...new Set(chrome)].filter(i => Number.isInteger(i) && i >= 0 && i < sents.length).sort((a, b) => a - b);
  const byReason = {};
  let removedChars = 0, web = false;
  const segments = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const sample = run.sentences.map(s => s.t).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    segments.push({
      op: 'SEG', stance: 'Dissecting', reason: 'chrome:' + run.reason,
      span: [run.idxs[0], run.idxs[run.idxs.length - 1]], idxs: run.idxs.slice(),
      prov: run.sentences.map(s => { try { return spanHash(s.t); } catch (e) { return null; } }).filter(Boolean),
      sample, sentences: run.sentences.slice(),
    });
    run = null;
  };
  for (const i of idxs) {
    const text = sents[i] || '';
    removedChars += text.length;
    const { reason, web: isWeb } = _dechromeLabel(text);
    byReason[reason] = (byReason[reason] || 0) + 1;
    if (isWeb) web = true;
    if (run && i === run.next && reason === run.reason) {
      run.idxs.push(i); run.next = i + 1; run.sentences.push({ i, t: text });
    } else {
      flush();
      run = { reason, idxs: [i], next: i + 1, sentences: [{ i, t: text }] };
    }
  }
  flush();
  return {
    present: idxs.length > 0,
    web,
    count: idxs.length,
    total_sentences: sents.length,
    removed_chars: removedChars,
    by_reason: byReason,
    spans: idxs,
    segments,
  };
}

// Is `name` the VEHICLE of a metaphor in this sentence ("the Jeff Bezos of
// the drug trade")? Capture 1 of a metaphor frame is the invoked name.
function isMetaphorMention(name, sentence) {
  if (!METAPHOR_RES || !METAPHOR_RES.length) return false;
  const n = String(name).toLowerCase();
  for (const rx of METAPHOR_RES) {
    rx.lastIndex = 0;
    const m = String(sentence).match(rx);
    if (m && m[1]) { const v = m[1].toLowerCase(); if (v.includes(n) || n.includes(v)) return true; }
  }
  return false;
}

// Infer an entity type from the predicate of a copular definition — the
// class noun in "X is a <syndicate|city|man>". Returns 'org'/'place'/'person'
// or null. Conservative: only a recognized class noun retypes.
function inferTypeFromGloss(gloss) {
  const toks = String(gloss).toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || [];
  for (const t of toks) {
    if (TYPE_KW_ORG && TYPE_KW_ORG.has(t)) return 'org';
    if (TYPE_KW_PLACE && TYPE_KW_PLACE.has(t)) return 'place';
    if (TYPE_KW_PERSON && TYPE_KW_PERSON.has(t)) return 'person';
  }
  return null;
}

/* ============================================================
   THE SITE FACE — the 9 phenomenological addresses (EO Space × Time).

   Every operator names an ACT (Identity × Space); the engine already carries
   those as `op` (the nine: NUL/SEG/DEF · SIG/CON/EVA · INS/SYN/REC). The SITE
   a referent or relation occupies is the OTHER projection of the same cube:
   Space (Domain) × Time (Object). The two faces share the Space axis, so an
   operator already fixes the Domain row; only the Time column (Ground/Figure/
   Pattern of the target) remains, and that is read from the language cues
   above (Figure is the default — a specific existent).

   The grid and the operator→Domain map are UNIVERSAL (here). The cues that
   move a target off the Figure default are CONVENTIONS (site_*_cues).
   ============================================================ */
const EO_SITE_GRID = {
  Existence:      { Ground: 'Void',       Figure: 'Entity', Pattern: 'Kind' },
  Structure:      { Ground: 'Field',      Figure: 'Link',   Pattern: 'Network' },
  Interpretation: { Ground: 'Atmosphere', Figure: 'Lens',   Pattern: 'Paradigm' },
};
// The legacy grid (the parity floor): identical except the (Existence, Figure)
// cell carries its old name 'Thing' — a level error the site_entity_cell rule
// corrects. "Thing" is an entity SUBTYPE, peer to person/place/org, living one
// rank below the cell on the entityType axis; it never names the cell itself.
const EO_SITE_GRID_LEGACY = {
  Existence:      { Ground: 'Void',       Figure: 'Thing', Pattern: 'Kind' },
  Structure:      { Ground: 'Field',      Figure: 'Link',  Pattern: 'Network' },
  Interpretation: { Ground: 'Atmosphere', Figure: 'Lens',  Pattern: 'Paradigm' },
};
// applyRules coerces card values through Number(), so an installed card
// arrives as 1; the seed is boolean false. Either truthy form means ON.
function siteEntityCellEnabled() { const v = READING_RULES.site_entity_cell.value; return v === true || v === 1; }
function eoSiteGrid() { return siteEntityCellEnabled() ? EO_SITE_GRID : EO_SITE_GRID_LEGACY; }
// The entity subtypes — the classification BENEATH the Entity cell, off the
// cube entirely. A 'thing' is a species of the genus Entity, as is a person.
// These are entityType values, valid one rank below the (Existence, Figure)
// cell; none of them is ever a site, and the ingestion audit treats one in a
// site slot as a level error.
const ENTITY_SUBTYPES = new Set(['thing', 'person', 'place', 'org', 'record']);
// Identity × Space for each operator → its Space (Domain) row. Mode (the
// Identity column: Differentiate/Relate/Generate) is the operator's other
// coordinate and does not bear on the Site face.
const EO_DOMAIN_OF_OP = {
  NUL: 'Existence', SIG: 'Existence', INS: 'Existence',
  SEG: 'Structure', CON: 'Structure', SYN: 'Structure',
  DEF: 'Interpretation', EVA: 'Interpretation', REC: 'Interpretation',
};
// All nine site names, in grid order — for tallies and introspection.
// A function, not a constant: the (Existence, Figure) cell's name follows
// the site_entity_cell rule ('Entity' on, legacy 'Thing' off).
function eoSites() { return Object.values(eoSiteGrid()).flatMap(row => Object.values(row)); }

// The Time character (Ground/Figure/Pattern) of a target surface. Figure is
// the default: a specific existent that holds still when named. A head noun in
// the ambient-cue inventory reads as Ground (multiplies when measured); one in
// the category/architecture inventory reads as Pattern (recurs across moments).
function objectOf(surface, type) {
  const toks = String(surface || '').toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || [];
  for (const t of toks) {
    if (SITE_GROUND_CUES && SITE_GROUND_CUES.has(t)) return 'Ground';
    if (SITE_PATTERN_CUES && SITE_PATTERN_CUES.has(t)) return 'Pattern';
  }
  return 'Figure';
}
// The Site (phenomenological address) for a (Domain, target) pair. The cell
// is always GENERATED — grid[Domain][Object] — never stamped by name.
function eoSite(domain, surface, type) {
  const grid = eoSiteGrid();
  const row = grid[domain] || grid.Existence;
  return row[objectOf(surface, type)];
}
// The Site an EVENT touches: its operator fixes the Domain; its target fixes
// the Time column. A CON to a specific referent is a Link; a DEF about a
// doctrine is a Paradigm; an INS of an ambient mass is a Void.
//
// Under site_entity_cell the Object coordinate corrects for the two operators
// whose target used to fall through to the Figure default: a NUL is a
// preserved non-resolution — an existence that has not yet become a figure —
// and an unattributed SIG (speaker '?') is an ephemeral registration with no
// anchor; both read Object Ground and generate Void. An attributed SIG sits
// on a who and resolves on its speaker, as before. Only the coordinate
// moves; the cell stays the (Domain, Object) product.
function eoSiteOfEvent(ev) {
  if (!ev || !ev.op) return null;
  const domain = EO_DOMAIN_OF_OP[ev.op];
  if (!domain) return null;
  const grid = eoSiteGrid();
  if (siteEntityCellEnabled()) {
    if (ev.op === 'NUL') return (grid[domain] || grid.Existence).Ground;
    if (ev.op === 'SIG' && (!ev.speaker || ev.speaker === '?')) return (grid[domain] || grid.Existence).Ground;
  }
  const target = ev.op === 'SIG' ? ev.speaker
    : (ev.op === 'CON' || ev.op === 'SYN') ? (ev.o != null ? ev.o : ev.targetName)
    : (ev.target != null ? ev.target : ev.targetName);
  return eoSite(domain, target, ev.entityType || null);
}
// The display address of a referent: the generated cell, with the entity
// subtype rendered as a refinement BENEATH the (Existence, Figure) cell
// ("Entity / person") — two questions at two levels, never a tenth cell.
function eoAddress(site, type) {
  if (!site) return null;
  return (site === eoSiteGrid().Existence.Figure && type) ? site + ' / ' + type : site;
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

function tryAdmit(surface, isPropNoun, tentatives, lowerVocab) {
  const trimmed = String(surface).trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (DISCOURSE_JUNK.has(lower)) return false;
  // In a transcript, formulaic discourse ("Thank you.", "Okay.") opens
  // sentences capitalized and recurs past the two-sighting gate — politeness,
  // not a referent.
  if (TRANSCRIPT_ACTIVE && TRANSCRIPT_FORMULA.has(lower)) return false;
  if (/^\d{4}$/.test(trimmed)) return false;
  if (/^[$€£¥]?[\d,.]+\s*(million|billion|trillion|thousand|m|b|k)?$/i.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const multi = tokens.length > 1;
  // Lowercase evidence (rule: lowercase_evidence_disqualify): the same word
  // standing lowercase elsewhere on the page outweighs a capital here — this
  // single-token surface is a common noun ("Darkness", "Nature", "But"), and
  // neither proper-noun shape nor recurrence can rehabilitate it.
  if (!multi && lowerVocab && lowerVocab.has(lower)) return false;
  const properLong = isPropNoun && trimmed.length >= 4;
  if (properLong || multi) return true;
  const k = normSurface(trimmed);
  const n = tentatives.get(k) || 0;
  const next = n + 1;
  tentatives.set(k, next);
  return next >= 2;
}

/* Role clauses inside a naming-bridge description. Two shapes:
   a title-of phrase ("president of the partnership"), and relative clauses
   headed by a role verb ("who runs the DMC", "who heads the council").
   Conservative verb list — actions that constitute holding a position, not
   one-off acts — so the role DEF says what the person IS, in the page's own
   words. Returns up to three distinct clauses, in page order. */
// ROLE_CLAUSE_VERB / TITLE_OF_RE are built from the role_clause_verbs /
// role_title_heads / role_title_prefixes rules in rebuildLangSets — the word
// inventories are conventions like any other and live in the semantics graph.
function rolesFromDescription(desc) {
  const t = String(desc || '');
  const out = [];
  const tm = t.match(TITLE_OF_RE);
  if (tm) out.push(tm[1].trim());
  // each relative clause: who/that/which [then|also|now|still] VERB …
  for (let c of t.split(/\s+(?:and\s+)?(?:who|whom|that|which)\s+/i).slice(1)) {
    c = c.replace(/^(?:then|also|now|still|first|later|currently)\s+/i, '').replace(/[\s,;:]+$/, '').trim();
    if (ROLE_CLAUSE_VERB.test(c)) out.push(c);
  }
  return [...new Set(out)].slice(0, 3);
}

/* A naming-bridge class gloss often opens with a comparative anaphor — "the
   same person who runs the DMC and who then hires his own firm" — whose
   anchor lives back in the source sentence, not in an answer. Rendered as a
   copula ("Tom Turner is the same person who runs the DMC…") it reads
   circular, and a small phrasing model truncates at the first clause,
   dropping the payload ("…and who then hires his own firm, NDP"). Strip the
   "same" at RENDER time only — the stored DEF keeps the page's own words,
   and provenance still points at the source sentence. */
function deAnaphorDef(s) {
  return String(s == null ? '' : s).replace(/^the\s+same\s+(\p{L})/iu, 'the $1');
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
  s = s.replace(/[\s.,;:!?*†‡§·•_'"”’“‘`\u2026]+$/gu, '').trim();
  // Same on the leading edge
  s = s.replace(/^[\s.,;:!?*†‡§·•_'"”’“‘`\u2026]+/gu, '').trim();
  // Unbalanced bracket on an edge: a capture that swallowed the close of a
  // parenthetical it never opened — "(the DMC)" captured as "DMC)" — or the
  // open of one it never closes. A balanced pair stays; it's content.
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (s.endsWith(close) && !s.includes(open)) s = s.slice(0, -1).trim();
    while (s.startsWith(open) && !s.includes(close)) s = s.slice(1).trim();
  }
  // An internal colon is structure (a headline lead-in: "Downtown Business
  // Owners:  You Cannot…"), never part of a name — keep the lead. Requires
  // whitespace after the colon so times and verse refs ("12:30") survive.
  const colonSplit = s.match(/^(.+?):\s/);
  if (colonSplit) s = colonSplit[1].trim();
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
  // Reject bare document-apparatus labels ("Figure", "Appendix", "Note") — a
  // multi-word name ("Ford Foundation") survives because only the lone label matches.
  if (STRUCTURE_LABELS.has(s.toLowerCase())) return null;
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
// activation resolver never sees them. DEICTIC_PRONOUNS is built in
// rebuildLangSets from the deictic_pronouns convention.

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

/* ============================================================
   el-classical-v1 ORGANS + the Greek reading pass.

   The mechanisms here are general — a stem fold, a case→role deed-finder, a
   bound-pronoun (pro-drop) resolver; every piece of Greek-specific knowledge is
   DATA read from the GREEK tables, which buildGreekOrgans fills from the pack.
   With no pack loaded GREEK is null and extractGreekGraph degrades to a bare
   tokenization, and nothing in this section runs for any other language (it is
   reached only when detectLanguage ⇒ 'grc'). So the 152 parity snapshots can't
   move: en/es/zh/code never enter here.
   ============================================================ */

// Fold for STEM KEYS and ENDING matching: strip the three accents (acute U+0301,
// grave U+0300, circumflex U+0342) but KEEP breathing and iota-subscript —
// rough/smooth and the subscript distinguish stems (ὅρος ≠ ὄρος). ς→σ; lower-
// cased (capitalization is editorial in this register). The admission gate's
// diacritic fold, one level down.
function gfold(s) {
  return String(s).normalize('NFD').replace(/[̀́͂]/g, '')
    .normalize('NFC').replace(/ς/g, 'σ').toLowerCase();
}
// Fold for FUNCTION WORDS (articles, particles, prepositions): acute ≡ grave
// (the grave is positional), keeping circumflex/breathing so the accent-minimal
// pairs survive (τίς ≠ τις). ς→σ.
function gword(s) {
  return String(s).normalize('NFD').replace(/̀/g, '́')
    .normalize('NFC').replace(/ς/g, 'σ');
}
function greekStemKey(s) { return gfold(s); }

// "(ν)" optional and "a / b" alternates → concrete ending strings.
function endVariants(raw) {
  const out = new Set();
  for (let p of String(raw).split('/').map(x => x.trim()).filter(Boolean)) {
    const m = p.match(/^(.*)\(ν\)$/);
    if (m) { out.add(m[1]); out.add(m[1] + 'ν'); } else out.add(p);
  }
  return [...out];
}
// Remove a leading syllabic augment ε(+breathing) from a secondary-tense stem.
function stripAugment(stem) {
  const d = stem.normalize('NFD');
  if (d.charCodeAt(0) === 0x03b5) {   // ε
    let i = 1; while (i < d.length && d.charCodeAt(i) >= 0x0300 && d.charCodeAt(i) <= 0x036f) i++;
    const rest = d.slice(i).normalize('NFC');
    if (rest.length >= 1) return rest;
  }
  return stem;
}
function genderOfDeclSub(cls, sub) {
  if (cls === 'first') return sub === 'masc' ? 'm' : 'f';
  if (sub === 'neut') return 'n';
  return 'm';   // 2nd/3rd masc_fem default masculine (revisable; the article settles it)
}
// Reverse the article paradigm into surface → [{case,number,gender}]. The
// article is the cheapest agreement evidence the matcher gets.
function greekArticleIndex(table) {
  const idx = new Map();
  if (!table) return idx;
  for (const g of ['m', 'f', 'n']) {
    const gt = table[g]; if (!gt) continue;
    for (const num of ['sg', 'pl']) {
      const nt = gt[num]; if (!nt) continue;
      for (const [cse, form] of Object.entries(nt)) {
        const k = gword(form); if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push({ case: cse, number: num, gender: g });
      }
    }
  }
  return idx;
}
// Build the GREEK organ tables from the projected pack conventions (keyed by id).
function buildGreekOrgans(conv) {
  if (!conv) { GREEK = null; return null; }
  const C = (id) => conv.get('el-classical-v1:' + id) || null;
  const data = (id) => { const c = C(id); return (c && c.data) || {}; };
  const list = (id) => { const c = C(id); return Array.isArray(c && c.value) ? c.value : []; };
  const ce = data('crasis_elision');
  GREEK = {
    articleIdx: greekArticleIndex(data('article_paradigm').table),
    decl: ['decl_1', 'decl_2', 'decl_3'].map(id => data(id).table).filter(Boolean),
    conj: ['verb_endings_primary_active', 'verb_endings_secondary_active', 'verb_endings_first_aorist',
      'verb_endings_primary_middle', 'verb_endings_secondary_middle', 'verb_endings_aorist_passive']
      .map(id => data(id).table).filter(Boolean),
    caseRoles: data('case_roles').map || null,
    augment: data('augment').rules || null,
    crasis: ce.crasis_pairs || {},
    elision: ce.elision_restorations || {},
    particles: new Set(list('postpositive_particles').map(gword)),
    stopwords: new Set(list('base_stopwords').map(gword)),
    pronouns: new Set(list('pronouns').map(gword)),
    attribVerbs: new Set(list('attribution_verbs').map(gword)),
  };
  return GREEK;
}

// A finite verb is a bound pronoun: strip movable-ν, the σ(α) aorist mark and a
// syllabic augment, then match the conjugation endings → {person,number,voice}.
function greekVerbAnalyses(tok) {
  if (!GREEK || !GREEK.conj.length) return [];
  const out = [];
  const base = gfold(tok);
  const bodies = base.endsWith('ν') ? [base, base.slice(0, -1)] : [base];
  for (const b of bodies) {
    for (const table of GREEK.conj) {
      const secondary = (table.tense_family === 'secondary');
      const sigma = table.stem_mark ? gfold(table.stem_mark)[0] : null;   // 'σ' of 'σα'
      for (const row of (table.rows || [])) {
        for (const e of endVariants(row.ending).map(gfold)) {
          if (!e || !b.endsWith(e) || b.length <= e.length) continue;
          let stem = b.slice(0, b.length - e.length);
          if (sigma) { if (!stem.endsWith(sigma)) continue; stem = stem.slice(0, -1); }   // a σ-marked aorist needs its σ
          if (secondary) stem = stripAugment(stem);
          if (stem.length < 1) continue;
          out.push({
            pos: 'verb', finite: true, stemKey: greekStemKey(stem),
            person: row.person, number: row.number, voice: table.voice,
            tenseFamily: table.tense_family, aorist: !!table.stem_mark,
            grainHint: table.grain_hint || null, surface: tok,
          });
        }
      }
    }
  }
  return out;
}
// A noun/adjective is stem + case-ending. Strip each declension ending; the
// over-generation is settled by article agreement and the two-sighting gate.
function greekNounAnalyses(tok) {
  if (!GREEK || !GREEK.decl.length) return [];
  const out = [];
  const base = gfold(tok);
  for (const table of GREEK.decl) {
    for (const [sub, paradigm] of Object.entries(table)) {
      if (sub === 'class' || sub === 'note' || !paradigm || typeof paradigm !== 'object') continue;
      const gender = genderOfDeclSub(table.class, sub);
      for (const num of ['sg', 'pl']) {
        const nt = paradigm[num]; if (!nt) continue;
        for (const [cse, end] of Object.entries(nt)) {
          for (let e0 of (Array.isArray(end) ? end : [end])) {
            if (e0 === '∅' || e0 === '') {   // ∅ ending (3rd-decl neuter nom/acc)
              out.push({ pos: 'noun', stemKey: greekStemKey(base), case: cse, number: num, gender, declClass: table.class, endLen: 0, surface: tok });
              continue;
            }
            const e = gfold(e0); if (!e || !base.endsWith(e) || base.length <= e.length) continue;
            out.push({ pos: 'noun', stemKey: greekStemKey(base.slice(0, base.length - e.length)), case: cse, number: num, gender, declClass: table.class, endLen: e.length, surface: tok });
          }
        }
      }
    }
  }
  return out;
}
function analyzeGreekToken(rawTok) {
  const out = { raw: rawTok, article: null, function: false, particle: false, pronoun: false, attrib: false, nouns: [], verbs: [] };
  if (!GREEK) return out;
  const w = gword(rawTok);
  const arts = GREEK.articleIdx.get(w);
  if (arts) out.article = arts;
  if (GREEK.particles.has(w)) out.particle = true;
  if (GREEK.stopwords.has(w)) out.function = true;
  if (GREEK.pronouns.has(w)) out.pronoun = true;
  if (GREEK.attribVerbs.has(w)) out.attrib = true;
  // An article / particle / preposition is grammar, never a referent — its fate
  // is 'grammar', so it is not also analyzed as a noun or verb.
  if (out.article || out.function || out.particle) return out;
  out.verbs = greekVerbAnalyses(rawTok);
  out.nouns = greekNounAnalyses(rawTok);
  return out;
}
// Crasis-expand / elision-restore one token BEFORE the sub-word split.
function greekExpand(tok) {
  if (!GREEK) return [tok];
  const w = gword(tok);
  for (const [k, v] of Object.entries(GREEK.crasis)) if (gword(k) === w) return v.split(/\s+/);
  if (/[’'ʼ]$/.test(tok)) {
    const stripped = tok.replace(/[’'ʼ]+$/, '');
    for (const [k, v] of Object.entries(GREEK.elision)) {
      if (gword(k.replace(/[’'ʼ]+$/, '')) === gword(stripped)) return [v];
    }
    return [stripped];
  }
  return [tok];
}
function tokenizeGreek(sentText) {
  const raw = sentText.match(/[\p{L}̀-ͯ][\p{L}̀-ͯ’'ʼ]*/gu) || [];
  const toks = [];
  for (const r of raw) for (const t of greekExpand(r)) toks.push(t);
  return toks;
}

// The Greek reading pass — a self-contained extractor (the extractCodeGraph
// pattern). Stem-fold admission, case→role deed-finding, pro-drop subjects;
// emits the same INS/CON events the rest of the pipeline projects.
function extractGreekGraph(text, t0) {
  const norm = String(text).replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
  const sentTexts = [];
  for (const para of norm.split(/\n{2,}/)) {
    const p = para.trim(); if (!p) continue;
    // Greek sentence punctuation: . ! · (ano teleia) and ; (erotimatiko U+037E / U+003B).
    for (const s of p.split(/(?<=[.!;;··])\s+/)) { const st = s.trim(); if (st) sentTexts.push(st); }
  }
  const events = []; let seq = 0, refn = 0;
  const mintRef = () => 'r-grc-' + (refn++);
  const perSent = sentTexts.map((s, i) => ({ idx: i, text: s, toks: tokenizeGreek(s).map(analyzeGreekToken) }));

  // ── article agreement + noun/verb resolution per token (the matcher) ──
  // The clause's finite verb is the rightmost token carrying a verb reading
  // (Greek tends verb-final, and an ambiguous earlier token like ἵππον — which
  // also matches a secondary ending — is then read as the noun it is). An
  // article governing a noun broadcasts {case,number,gender}; the noun keeps
  // only the agreeing reading. With no article the most specific (longest)
  // ending wins. Postpositive particles may sit between (ὁ δὲ Κῦρος). A σ-marked
  // aorist reading is preferred when present (ἔλυσε is aorist, not imperfect).
  for (const sent of perSent) {
    sent.nouns = []; sent.verb = null;
    let verbIdx = -1;
    for (let i = 0; i < sent.toks.length; i++) if (sent.toks[i].verbs && sent.toks[i].verbs.length) verbIdx = i;
    if (verbIdx >= 0) { const vs = sent.toks[verbIdx].verbs; sent.verb = vs.find(v => v.aorist) || vs[0]; }
    let pendingArt = null;
    for (let i = 0; i < sent.toks.length; i++) {
      const a = sent.toks[i];
      if (a.article) { pendingArt = a.article; continue; }
      if (a.particle || a.function) continue;           // grammar; keep pendingArt across postpositives
      if (i === verbIdx) { pendingArt = null; continue; }   // the finite verb is not a noun
      if (!a.nouns || !a.nouns.length) continue;
      let cands = a.nouns;
      if (pendingArt) {
        const byCN = cands.filter(n => pendingArt.some(f => f.case === n.case && f.number === n.number));
        const byCNG = byCN.filter(n => pendingArt.some(f => f.case === n.case && f.number === n.number && f.gender === n.gender));
        cands = byCNG.length ? byCNG : (byCN.length ? byCN : cands);
      }
      sent.nouns.push(cands.slice().sort((x, y) => (y.endLen || 0) - (x.endLen || 0))[0]);
      pendingArt = null;
    }
  }

  // ── stem-fold admission: a noun stem seen in ≥ two distinct sentences ──
  const TWO = (READING_RULES.two_sighting_admission && READING_RULES.two_sighting_admission.value) || 2;
  const stemSent = new Map(), stemSurf = new Map();
  for (const sent of perSent) for (const n of sent.nouns) {
    if (!stemSent.has(n.stemKey)) { stemSent.set(n.stemKey, new Set()); stemSurf.set(n.stemKey, new Map()); }
    stemSent.get(n.stemKey).add(sent.idx);
    const sm = stemSurf.get(n.stemKey); sm.set(n.surface, (sm.get(n.surface) || 0) + 1);
  }
  const sites = new Map(), firstSent = new Map();
  for (const [stem, sents] of stemSent) {
    if (sents.size < TWO) continue;
    const surf = stemSurf.get(stem);
    const name = [...surf.entries()].sort((a, b) => b[1] - a[1])[0][0];
    sites.set(stem, { key: stem, referent_id: mintRef(), name, count: [...surf.values()].reduce((x, y) => x + y, 0) });
  }
  for (const sent of perSent) for (const n of sent.nouns) {
    if (sites.has(n.stemKey) && !firstSent.has(n.stemKey)) firstSent.set(n.stemKey, sent.idx);
  }
  for (const [stem, site] of sites) {
    const si = firstSent.has(stem) ? firstSent.get(stem) : 0;
    events.push({
      id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
      target: site.name, targetRaw: site.name, entityType: 'thing', referent_id: site.referent_id,
      in_quote: false, sentence_idx: si, sentence: sentTexts[si],
      basis: { stem, sightings: stemSent.get(stem).size }, src: 'greek-stem-fold',
    });
  }

  // ── per-clause deed-finding: CASE IS THE HINT, NOT THE ORDER ──
  for (const sent of perSent) {
    const verb = sent.verb;
    if (!verb) continue;
    const nomN = sent.nouns.find(n => n.case === 'nom' && sites.has(n.stemKey));
    const accN = sent.nouns.find(n => n.case === 'acc' && sites.has(n.stemKey));
    const negated = sent.toks.some(a => { const w = gword(a.raw); return ['οὐ', 'οὐκ', 'οὐχ', 'μή'].map(gword).includes(w); });
    const obj = accN ? sites.get(accN.stemKey) : null;
    let source = nomN ? sites.get(nomN.stemKey) : null, bound = false;
    // BOUND PRONOUN: no overt nominative → the subject lives in the ending;
    // resolve it to the most active admitted site OTHER than the object
    // (momentum proxy = sightings).
    if (!source) {
      const cands = [...sites.values()].filter(s => !obj || s.referent_id !== obj.referent_id).sort((a, b) => b.count - a.count);
      source = cands[0] || null; bound = true;
    }
    if (!source || !obj || source.referent_id === obj.referent_id) continue;
    // The depicted act, carried as content on the bond. Its obj is the Time
    // column — the grain the aorist/imperfect contrast marks (Figure vs Pattern);
    // voice/mood/polarity complete the depicted address. The bond's own op stays
    // CON (the reader connects); depicts.op is the depicted operator when the verb
    // is classified (Greek stems aren't in the English lexicon yet, so usually none).
    const gdep = depictedAct(verb.stemKey) || {};
    const depicts = {
      ...(gdep.op ? { op: gdep.op } : {}),
      obj: verb.aorist ? 'figure' : (verb.tenseFamily === 'secondary' ? 'pattern' : 'figure'),
      voice: verb.voice === 'middle_passive' ? 'middle' : (verb.voice || 'active'),
      mood: 'indicative', polarity: negated ? 'negated' : 'asserted',
    };
    events.push({
      id: 'ev-' + seq, seq: seq++, op: 'CON', stance: 'Connecting',
      s: source.name, v: verb.stemKey, o: obj.name, relation: verb.stemKey,
      source_ref: source.referent_id, target_ref: obj.referent_id,
      sourceName: source.name, targetName: obj.name,
      depicts, bound_subject: bound,
      sentence_idx: sent.idx, sentence: sent.text, src: 'greek-case-role',
    });
  }

  const { entities, edges } = projectGraph(events);
  const t1 = performance.now();
  const rulesJson = {}; for (const [id, r] of Object.entries(READING_RULES)) rulesJson[id] = { value: r.value, mass: r.mass === Infinity ? 'Infinity' : r.mass, layer: r.layer, src: r.src, module: r.module || 'core', desc: r.desc };
  const modulesJson = { active: Object.values(LANGUAGE_MODULES).filter(m => m.enabled).map(m => m.id), available: Object.keys(LANGUAGE_MODULES), details: { ...LANGUAGE_MODULES } };
  const readersJson = {}; for (const [id, r] of Object.entries(READER_REGISTRY)) readersJson[id] = { kind: r.kind, coupling: r.coupling, adjustable: r.adjustable };
  return {
    lang: 'grc', mode: 'unstructured',
    input_chars: text.length, sentences: sentTexts.length, events, entities, edges,
    verb_slot_tally: {}, sections: [], sentence_texts: sentTexts,
    open_signals: [], signal_collapses: {}, rules: rulesJson, language_modules: modulesJson, readers: readersJson,
    counts: { INS: events.filter(e => e.op === 'INS').length, SYN: 0, DEF: 0, SIG: events.filter(e => e.op === 'SIG').length, NUL: 0, SEG: 0, CON: events.filter(e => e.op === 'CON').length, EVA: 0, REC: 0, RULES: Object.keys(READING_RULES).length },
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

// ── Ingest memory governor ──────────────────────────────────────────────────
// A ceiling on how much heap the staged parse is allowed to ride at before it
// stops pushing new work and waits for the collector to catch up. The browser
// gives no way to HARD-cap a heap, but we can cap the RATE: between chunks,
// while usage sits above the budget, the parse HOLDS — in growing beats — so the
// transient garbage each slice sheds is reclaimed before the next slice
// allocates more. The parse then plateaus near the budget and simply takes
// longer, instead of spiking in one blast and killing the tab. "A few moments"
// beats "page unresponsive."
//   performance.memory is Chromium-only; on Firefox/Safari/Node the readout is
//   null and the governor is entirely inert — parsing runs exactly as before,
//   so the golden-parity tests (no readout, no onProgress) never throttle.
const _MEM = {
  capBytes: 0,                        // 0 ⇒ auto (a fraction of the heap's own ceiling)
  autoFrac: 0.6,                      // auto cap = this × jsHeapSizeLimit
  fallbackBytes: 768 * 1024 * 1024,   // budget when the ceiling is unknown
  maxBeats: 24,                       // stop holding after this many beats — never hang a parse
};
// Set an explicit ceiling in megabytes (or 0/null to return to the auto cap).
function setIngestMemoryCap(mb) {
  _MEM.capBytes = (typeof mb === 'number' && mb > 0) ? Math.floor(mb * 1024 * 1024) : 0;
  return _MEM.capBytes;
}
function _memReadout() {
  try {
    const m = (typeof performance !== 'undefined') && performance.memory;
    if (!m || !m.usedJSHeapSize) return null;
    return { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit || 0 };
  } catch (e) { return null; }
}
function _memCap(readout) {
  if (_MEM.capBytes > 0) return _MEM.capBytes;
  const limit = readout && readout.limit;
  return limit ? Math.floor(limit * _MEM.autoFrac) : _MEM.fallbackBytes;
}
const _mb = b => Math.round(b / (1024 * 1024));
// Current memory posture, for the UI (an honest readout, never an estimate).
// supported:false off Chromium — callers should hide the meter rather than lie.
function ingestMemoryInfo() {
  const r = _memReadout();
  if (!r) return { supported: false };
  const cap = _memCap(r);
  return { supported: true, usedMB: _mb(r.used), capMB: _mb(cap), limitMB: _mb(r.limit), over: r.used > cap };
}
// Cooperative yield with the memory ceiling folded in. Always hands the thread
// back (a paint + a GC window); then, while over budget, holds in growing beats
// and reports `stage:'easing'` so the UI can show the plateau honestly. The
// phase/done/total ride through unchanged, so the progress bar holds its place
// while the parse eases rather than jumping back to zero.
async function _breathe(onProgress, phase, done, total) {
  await _yieldToBrowser();
  const r0 = _memReadout();
  if (!r0) return;                          // no readout (non-Chromium) ⇒ inert
  const cap = _memCap(r0);
  if (r0.used <= cap) return;               // under budget ⇒ nothing to ease
  for (let beat = 0; beat < _MEM.maxBeats; beat++) {
    const r = _memReadout() || r0;
    if (onProgress) onProgress({ phase, stage: 'easing', done, total, usedMB: _mb(r.used), capMB: _mb(cap) });
    if (r.used <= cap) break;
    await new Promise(res => setTimeout(res, Math.min(48 * (beat + 1), 280)));
  }
}

// Segment ONE paragraph into compromise sentence docs without ever handing a
// huge string to nlp() in a single synchronous gulp. A normal-length paragraph
// is parsed exactly as before — one nlp() call — so the reading stays
// byte-identical; only a pathologically long paragraph (a whole book pasted with
// no blank line between paragraphs) is pre-sliced at sentence/word boundaries
// into bounded chunks, segmented chunk by chunk, and breathed between, so it
// can't lock the tab. `rawCount` is the raw sentence tally the block rebuilder
// needs (the same number nlp would give), summed across chunks on the sliced
// path. Defined as a module function so extractEoGraph can await it per paragraph.
async function _segmentParagraph(p, onProgress, done, total) {
  const MAX = 20000;                                // chars handed to nlp at once
  if (p.length <= MAX) {
    const sents = nlp(p).sentences();
    const subs = []; sents.forEach(s => subs.push(s));
    const rawCount = (sents.out('array') || []).filter(s => s.trim()).length || 1;
    return { subs, rawCount };
  }
  const subs = []; let rawCount = 0;
  for (let i = 0; i < p.length;) {
    let end = Math.min(i + MAX, p.length);
    if (end < p.length) {
      // Back up to the last sentence terminal, else the last newline/space, so a
      // chunk boundary never lands mid-word (and rarely mid-sentence).
      const w = p.slice(i, end);
      let cut = Math.max(w.lastIndexOf('. '), w.lastIndexOf('! '), w.lastIndexOf('? '), w.lastIndexOf('… '), w.lastIndexOf('\n'));
      if (cut < (MAX >> 1)) { const sp = w.lastIndexOf(' '); if (sp > 0) cut = sp; }
      if (cut > 0) end = i + cut + 1;
    }
    const sents = nlp(p.slice(i, end)).sentences();
    sents.forEach(s => subs.push(s));
    rawCount += (sents.out('array') || []).filter(s => s.trim()).length;
    i = end;
    if (onProgress) { onProgress({ phase: 'existence', stage: 'segmenting', done, total }); await _breathe(onProgress, 'existence', done, total); }
  }
  return { subs, rawCount: rawCount || 1 };
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
  TRANSCRIPT_ACTIVE = false;
  if (LANG === 'code') return extractCodeGraph(text, t0);
  if (LANG === 'csv') return extractCsvGraph(text, t0);
  if (LANG === 'grc') return extractGreekGraph(text, t0);
  // A transcript is a GENRE the page declares through its own typography —
  // timecodes and turn labels. The genre pack normalizes that typography into
  // structure (cues → boundaries, labels → attribution) and the shared
  // English grammar reads the prose that remains.
  let TRANSCRIPT = null;
  if (LANG === 'en') {
    TRANSCRIPT = readTranscript(text);
    if (TRANSCRIPT) {
      text = TRANSCRIPT.text;
      LANGUAGE_MODULES['transcript-v1'] = {
        id: 'transcript-v1', name: 'Transcript Conventions', version: '1.0',
        applies_to: { language: 'en', mode: 'transcript' }, enabled: true,
        provides: ['timecode_boundaries', 'speaker_turn_attribution', 'discourse_formula_filter'],
        desc: 'Timecode lines and cue counters are structure, never sentence content; "Speaker N:" / "NAME:" labels are attribution, landing each turn on its voice through the same SIG slot quoted speech uses.',
      };
    } else if (LANGUAGE_MODULES['transcript-v1']) {
      LANGUAGE_MODULES['transcript-v1'].enabled = false;
    }
  }
  TRANSCRIPT_ACTIVE = !!TRANSCRIPT;
  // Unwrap hard line breaks (Gutenberg-style wrapped prose). A single
  // newline inside a paragraph is typography, not syntax — left in place
  // it splits sentences mid-clause, truncates names ("Prince\nNicholas
  // Bolkónski" → "Chief Prince"), and severs attributions from their
  // quotes. Blank lines (real paragraph breaks) survive as boundaries.
  text = String(text).replace(/\r\n?/g, '\n');
  // A MediaWiki heading line ("== Early life and career ==") carries no
  // terminal punctuation, so the single-newline unwrap below would glue it
  // into the next sentence — the heading then pollutes that sentence's
  // entity spans, and the chrome gate (which reads whole spine lines)
  // never sees it standing alone. Promote each one to its own paragraph
  // first; the chrome_patterns convention then gates it as structure.
  text = text.replace(/^[ \t]*(={2,6}\s*[^=\s][^\n]*?={2,6})[ \t]*$/gm, '\n$1\n');
  // BUT a title-shaped line is structure, not a wrapped clause: a headline
  // pasted with a single newline before the body ("Downtown Business Owners:
  // You Cannot Afford…\nIf you own a business downtown…") would be glued into
  // the first sentence by the unwrap, and Title Case read as one giant proper
  // noun mints phantom entities ("Mistakes If", "Keep Paying") that pollute
  // the cast. Promote such a line to its own paragraph BEFORE unwrapping:
  // nearly every word capitalized (lowercase only for title function words),
  // no terminal punctuation, 3–16 words, and a next line that starts a fresh
  // sentence. Hard-wrapped prose fails the Title Case ratio or the
  // capitalized-next-line check, so genuine wraps still unwrap.
  {
    const lines = text.split('\n');
    for (let li = 0; li < lines.length - 1; li++) {
      const L = lines[li].trim(), next = lines[li + 1].trim();
      if (!L || !next) continue;                                   // blank already separates
      if (/[.!?…;:,'"”’)\]]$/.test(L)) continue;                   // ends punctuated → wrapped prose
      if (!/^["“'‘(]?[\p{Lu}\d]/u.test(next)) continue;            // wrap continuations start lowercase
      const words = L.split(/\s+/);
      if (words.length < 3 || words.length > 16) continue;
      const titleish = words.filter(w => /^["“'‘(]?[\p{Lu}\d]/u.test(w)
        || TITLE_CASE_MINOR.has(w.toLowerCase().replace(/[^\p{L}]+/gu, ''))).length;
      if (titleish / words.length < 0.9) continue;
      lines[li] += '\n';                                           // promote to paragraph boundary
    }
    text = lines.join('\n');
  }
  text = text.replace(/([^\n])\n(?!\n)/g, '$1 ');
  // Segment by paragraph FIRST, then by sentence within each paragraph.
  // compromise merges sentences across blank lines when dialogue
  // punctuation confuses it, producing mega-"sentences" spanning three
  // paragraphs — which cascades continuation inheritance across speaker
  // changes and coarsens the momentum clock. A paragraph break is a hard
  // boundary; no sentence crosses it.
  const sentenceDocs = [];
  const sentParaSolo = [];
  // Per non-empty paragraph, the raw sentence count — what the host's block
  // rebuilder needs to group sentences back into paragraphs WITHOUT a second
  // full compromise pass over the whole document (see rebuildBlocks). Recorded
  // here, where the segmenter has already done the work, so a big file is read
  // once, not twice.
  const paraCounts = [];
  // sentence index → transcript turn index (the i-th non-empty paragraph IS
  // the i-th turn, by construction in readTranscript). Empty when not a
  // transcript; consumed by the voice-attribution pass below.
  const sentTurn = [];
  let _turnIdx = -1;
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
    _turnIdx++;
    const paraDocs = [];
    let _rawCount = 1;
    if (LANG === 'zh') {
      // CJK sentence terminals; compromise neither splits nor needs to.
      // Each sentence becomes a whole-string doc so downstream .text()
      // keeps working; its English NER simply finds nothing, gated below.
      for (const piece of p.split(/(?<=[\u3002\uFF01\uFF1F\u2026])\s*/)) {
        const q = piece.trim();
        if (q) paraDocs.push(nlp(q));
      }
      _rawCount = paraDocs.length || 1;
    } else {
      // English split, then rejoin a sentence the segmenter cut after an
      // abbreviation: a known title (lexicon in the ruliad, not hardcoded here)
      // or any "Abbr." immediately before a number ("No. 12", "Fig. 3"). Keeps a
      // citation from ever landing mid-name. No-op when nothing merges, so a
      // title-free document segments exactly as before. The segment step is
      // chunked for an over-long paragraph so one giant block can't freeze the
      // tab; a normal paragraph still goes through nlp() in a single pass.
      const { subs, rawCount: _rc } = await _segmentParagraph(p, onProgress, _pi + 1, _paras.length);
      _rawCount = _rc;
      for (let k = 0; k < subs.length; k++) {
        let txt = subs[k].text(), merged = false;
        while (k + 1 < subs.length) {
          const tail = txt.match(/(?:^|[\s(“"‘])(\p{L}+)\.\s*$/u);
          const nextIsNum = /^\s*\d/.test(subs[k + 1].text());
          if (tail && (ABBREVIATIONS.has(tail[1].toLowerCase()) || nextIsNum)) { txt += ' ' + subs[++k].text(); merged = true; }
          else break;
        }
        // compromise ends a sentence on `. ` + capital but not on `." ` +
        // capital — a sentence terminal sitting INSIDE a closing quote — so
        // consecutive quoted sentences ("…cares." David Corman … "…Zone." The
        // council …) collapse into one. That coarsens the momentum clock and,
        // worse, cascades quote attribution across a speaker change (the
        // second speaker's quote inherits the first). Split on that boundary:
        // a terminal+closing-quote, whitespace, then an optional opening quote
        // and a capital. Lowercase after (a trailing "…," he said.) is left
        // joined, so attributions stay with their quote. ONE exception: a bare
        // third-person pronoun after the boundary ("…besides." He watched her…)
        // is trailing narration whose subject ATTRIBUTES the preceding bare
        // quote — splitting it strands the quote, so keep those joined.
        const pieces = txt.split(/(?<=[.!?][”"’'])\s+(?=[“"‘']?(?!(?:He|She|They|It)\b)\p{Lu})/u);
        for (const piece of pieces) if (piece.trim()) paraDocs.push((merged || pieces.length > 1) ? nlp(piece) : subs[k]);
      }
    }
    for (const s of paraDocs) { sentenceDocs.push(s); sentParaSolo.push(paraDocs.length === 1); if (TRANSCRIPT) sentTurn.push(_turnIdx); }
    paraCounts.push(_rawCount);
    if (onProgress && performance.now() - _segClock > 24) {
      onProgress({ phase: 'existence', stage: 'segmenting', done: _pi + 1, total: _paras.length });
      await _breathe(onProgress, 'existence', _pi + 1, _paras.length); _segClock = performance.now();
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
    // A voice's turn is speech, not structure; and caption streams routinely
    // drop terminal punctuation, so for transcripts only emphatic typography
    // (caps, numerals) reads as a section \u2014 "PLEDGE OF ALLEGIANCE", "ITEM 4".
    if (TRANSCRIPT) {
      const turn = TRANSCRIPT.turns[sentTurn[idx]];
      if (turn && turn.speaker) return;
    }
    const t = s.text().trim();
    if (!t || t.length > 60) return;
    if (/["\u201C\u2018']/.test(t)) return;  // dialogue isn't structure
    const words = t.split(/\s+/);
    if (words.length > 8) return;
    const letters = t.replace(/[^\p{L}]/gu, '');
    const allCaps = letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    const noTerminal = !/[.!?\u3002\uFF01\uFF1F\u2026]\s*$/.test(t);
    const numeralOnly = /^[IVXLCDM]+\.?$/.test(t) || /^\d+\.?$/.test(t);
    if (TRANSCRIPT ? (allCaps || numeralOnly) : (noTerminal || allCaps || numeralOnly)) sections.push({ label: t, start_sentence: idx });
  });

  const events = [];
  // sites: key → { name, type, mass, momentum, tokens }
  // mass     accumulates 1 per touch, never decays
  // momentum accumulates as p = p·γ + 1 per touch, decays each sentence
  // tokens   cached substantive token set for gravity computation
  const sites = new Map();
  const tentatives = new Map();       // for two-sighting admission gate
  // Document-level lowercase evidence for admission (see
  // lowercase_evidence_disqualify): every word that stands lowercase somewhere
  // in the text. Built once per parse; consulted only for single-token
  // candidate surfaces.
  const lowerVocab = (READING_RULES.lowercase_evidence_disqualify && READING_RULES.lowercase_evidence_disqualify.value)
    ? new Set((String(text).split(/[^\p{L}'’-]+/u) || []).filter(w => w && /^\p{Ll}/u.test(w) && w === w.toLowerCase()))
    : null;
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
      // chrome (chapter heads, colophons) is structure: mine no names from it
      if (isChrome(s)) return [];
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
        // The gate counts distinct SENTENCES, not occurrences — a gram twice
        // in one line has not "returned"; the two-sighting law, generalized,
        // is two distinct sightings.
        if (new Set(poss.map(p => p.si)).size < READING_RULES.two_sighting_admission.value) continue;
        const free = poss.filter(p => { for (let k = 0; k < n; k++) if (occupied[p.si].has(p.at + k)) return false; return true; });
        if (new Set(free.map(p => p.si)).size < READING_RULES.two_sighting_admission.value) continue;
        admitted.push({ name: g, positions: free });
        for (const p of free) for (let k = 0; k < n; k++) occupied[p.si].add(p.at + k);
      }
    }
    zhNamePositions = new Map(admitted.map(a => [a.name, a.positions]));
    for (const a of admitted) {
      const sis = [...new Set(a.positions.map(p => p.si))].sort((x, y) => x - y);
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
        target: a.name, targetRaw: a.name, entityType: 'thing',
        referent_id: mintReferent(), in_quote: false,
        sentence_idx: sis[0], sentence: sentStrs[sis[0]],
        // the admission's evidence, written down: the distinct sentences
        // that cleared the gate (the same basis vocabulary REC uses) —
        // the projection unions these into the referent's sightings
        basis: { slot_sightings: sis.length, sightings: sis },
        src: 'gram-mining',
      });
    }
    // Speech: the colon-quote slot. \u8bf4\uff1a\u201c\u2026\u201d attributes by typography.
    const zhVerbTally = new Map();
    const nameAt = (si) => admitted.flatMap(a => a.positions.filter(p => p.si === si).map(p => ({ name: a.name, at: p.at })));
    sentStrs.forEach((s, si) => {
      if (isChrome(s)) return;
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
  if (TRANSCRIPT) {
    // ── Transcript voices ──
    // The "Name:" slot already attributed every sentence to its voice at
    // normalization; mint that as graph structure. Each new label is an INS
    // (the voice exists — admitted by the typography, not the cap-harvest);
    // each sentence of a labeled turn is a SIG on that voice — the same
    // attribution event quoted speech earns, so mass reflects how much each
    // voice speaks and entityDetail/co-occurrence see a voice's sentences.
    const seenVoices = new Set();
    sentenceDocs.forEach((d, si) => {
      const turn = TRANSCRIPT.turns[sentTurn[si]];
      const speaker = turn && turn.speaker;
      if (!speaker) return;
      const sTxt = d.text().trim();
      if (!seenVoices.has(speaker.toLowerCase())) {
        seenVoices.add(speaker.toLowerCase());
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
          target: speaker, targetRaw: speaker, entityType: 'person',
          referent_id: mintReferent(), in_quote: false,
          sentence_idx: si, sentence: sTxt, src: 'transcript-voice',
        });
      }
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'SIG', stance: 'Tending',
        speaker, quote: sTxt.replace(/\s+/g, ' ').slice(0, 300),
        speakerHint: { name: speaker }, speakerRaw: speaker,
        attributed: 'named', in_quote: false,
        sentence_idx: si, sentence: sTxt, src: 'transcript-turn',
      });
    });
  }
  // ── Admitted speaker-label conventions (the proposal channel, live) ──
  // A grown inventory, empty in every shipped reading — so this block is
  // inert until a proposed convention clears admission (parity holds by
  // construction). A line matching an admitted "LABEL: statement" shape
  // binds the label as a speaking voice through the same SIG slot quoted
  // speech uses, so "who said X" and the void receipts reach it.
  if (!TRANSCRIPT && SPEAKER_LABEL_RES && SPEAKER_LABEL_RES.length) {
    const seenLabels = new Set();
    sentenceDocs.forEach((d, si) => {
      const s = d.text().trim();
      for (const re of SPEAKER_LABEL_RES) {
        let m; try { m = re.exec(s); } catch (e) { m = null; }
        if (!m || !m[1]) continue;
        const label = m[1].trim();
        const rest = String(m[2] != null ? m[2] : s.slice(m[0].length)).trim()
          .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
        if (!rest || GENERIC_VOICE_HEADS.has(label.toLowerCase())) break;
        if (!seenLabels.has(label.toLowerCase())) {
          seenLabels.add(label.toLowerCase());
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'INS', stance: 'Instantiating',
            target: label, targetRaw: label, entityType: 'thing',
            referent_id: mintReferent(), in_quote: false,
            sentence_idx: si, sentence: s, src: 'speaker-label',
          });
        }
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'SIG', stance: 'Tending',
          speaker: label, quote: rest.replace(/\s+/g, ' ').slice(0, 300),
          speakerHint: { name: label }, speakerRaw: label,
          attributed: 'named', in_quote: false,
          sentence_idx: si, sentence: s, src: 'speaker-label',
        });
        break;
      }
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

  // Distinct prose sentences each site's NAME was sighted in (chrome never
  // reaches the emitters, so these are prose by construction; pronoun binds
  // are inferred mentions and never counted). The admission gate settles on
  // this at end of parse: only what returns keeps its name.
  const sightSents = new Map();
  function noteSight(key, si) {
    if (si == null) return;
    if (!sightSents.has(key)) sightSents.set(key, new Set());
    sightSents.get(key).add(si);
  }
  function recordSiteSurface(key, surface, type, weight = 1, si = null) {
    noteSight(key, si);
    let cur = sites.get(key);
    if (!cur) {
      cur = { name: surface, type, gender: genderFromName(surface), mass: 0, surfaceMass: 0, momentum: 0, tokens: tokenSetOf(surface), referent_id: mintReferent(), forms: new Map() };
    }
    // surfaceMass tracks weight earned from the NAME appearing on the page —
    // the honest evidence. Pronoun bindings add to mass but never here, so
    // resolution can score on surface alone and the rich-get-richer loop
    // loses its fuel.
    cur.mass += weight;
    cur.surfaceMass = (cur.surfaceMass || 0) + weight;
    cur.momentum = cur.momentum * GAMMA + weight;
    bumpForm(cur, surface);
    noteFullForm(cur, surface);
    // Type is sticky after first assignment. Compromise NER produces
    // different types for the same surface in different sentences (Don as
    // 'thing' at first INS, then 'person' in the next sentence because the
    // local context parses differently). Letting that drift breaks pronoun
    // resolution and SIG attribution. First-sighting wins; subsequent
    // mentions only accumulate mass and momentum.
    if (!cur.type) cur.type = type;
    if (!cur.gender) cur.gender = genderFromName(surface);
    noteMetaphorSighting(cur, surface);
    // Match tokens accumulate across every sighted form, so merge recall
    // never shrinks; the DISPLAY name is mentions-first (the form sighted
    // most), not the longest string — see pickCanonicalForm.
    for (const t of tokenSetOf(surface)) cur.tokens.add(t);
    cur.name = pickCanonicalForm(cur.forms, cur.name);
    sites.set(key, cur);
    return cur;
  }
  // A site that has only ever been named inside a metaphor frame ("the Jeff
  // Bezos of the drug trade") is metaphorOnly. The first metaphor sighting
  // sets it; any sighting OUTSIDE a frame clears it. Feeds the speaker gate.
  function noteMetaphorSighting(site, surface) {
    if (!METAPHOR_RES.length) return;
    if (isMetaphorMention(surface, currentSentText)) {
      if (site.metaphorOnly === undefined) site.metaphorOnly = true;
    } else {
      site.metaphorOnly = false;
    }
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
    // singular "they" as a person reference is a modern-register convention
    // (off for classic narrative); only then may it promote a proper name.
    const neutralPerson = NEUTRAL_PERSON_PRONOUNS.has(lower)
      && READING_RULES.singular_they && READING_RULES.singular_they.value;
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
        // Identity only here; what each candidate WEIGHED at the stall is a
        // measurement and lives under `observed`, stamped with its frame —
        // same discipline the gravity stall already keeps.
        competing: (result.competing || []).map(c => ({ site: c.site, siteName: c.siteName })),
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
        // Singular "they" (modern register only) that binds a proper-name
        // `thing` TEACHES personhood without gender — the reference is only
        // coherent if the surface names a person. Recorded as a DEF so
        // projection inherits the type and SEG can overturn a bad bind. Gendered
        // he/she do NOT promote here (a genderless thing must not compete for
        // "she"); a non-speaking person earns person-type from speaker/title
        // evidence in projection instead.
        if (neutralPerson && site.type === 'thing' && looksLikePerson(site.name)) {
          site.type = 'person';
          events.push({
            id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
            target: site.name, path: 'type', value: 'person',
            targetHint: { key: result.key, name: site.name, referent_id: site.referent_id },
            basis: `bound singular "${pronoun}"`,
            reason: 'a singular-they reference is personhood evidence',
            sentence_idx: currentSentIdx, sentence: currentSentText,
            src: 'pronoun-binding',
          });
        }
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
  // Indices the chrome gate dropped — spine sentences that deposited no
  // operator event by construction (page apparatus, not prose).
  const chromeIdx = [];
  // ── Gutenberg wrapper boundaries ──
  // A Project Gutenberg ebook wraps the work in apparatus: a header (the
  // title page, "Author:"/"Translator:" credits, the license preamble) before
  // the "*** START OF THE PROJECT GUTENBERG EBOOK … ***" line, and the full
  // license + donation boilerplate after the matching "*** END … ***". Left
  // ungated this apparatus mints phantom entities — the author's byline becomes
  // a high-salience site that captures pronoun coref (every body "he" pooling
  // onto "Franz Kafka"), and the license tail mints "Literary Archive
  // Foundation" / "Internal Revenue Service" / "General Terms". The markers
  // bound the actual work; only sentences between them reach an emitter. The
  // header/footer still record into sentenceTexts (indices preserved, header
  // metadata stays readable by docMetadata) but mint nothing — the same
  // transparency the chrome gate already gives a byline. The marker shapes
  // live in the gutenberg_start_markers / gutenberg_end_markers conventions
  // (read via matchGutenberg*), grown like any chrome_patterns entry.
  const _gutenbergWrapped = !!matchGutenbergStart(text);   // only gate a doc that carries the marker
  const _gutenbergHasEnd = _gutenbergWrapped && !!matchGutenbergEnd(text);
  // 'header' until START, 'body' through the work, 'footer' after END. A
  // non-Gutenberg paste starts in 'body' and is never gated (parity).
  let gutenbergPhase = _gutenbergWrapped ? 'header' : 'body';
  // The PERSONS the previous sentence named — the local field the possessive-
  // kin reader resolves against (a possessive determiner is a local anaphor).
  let prevSentencePersons = new Set();
  const processSentence = (sentDoc, i) => {
    let sentText = sentDoc.text();
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

    // ── Chrome gate (before any emitter) ──────────────────────
    // A line the chrome_patterns convention recognizes — a nav menu, a
    // copyright/byline line, a horizontal rule, a share row — is structure,
    // not prose. It stays in the spine (sentenceTexts[i], set above) so it
    // re-displays, but it reaches no operator emitter: no INS for its
    // capitalized nouns, no DEF, no SIG. The momentum clock has already
    // ticked; the local-anaphor field (prevSentencePersons) is left intact,
    // so chrome is transparent to narrative continuity. It deposits nothing,
    // so it goes dark honestly instead of minting phantom entities.
    // ── Gutenberg wrapper gate (before the chrome gate) ──────
    // Header and footer are apparatus, not the work: gate them like chrome so
    // they mint nothing. The START/END marker lines are apparatus too.
    if (gutenbergPhase === 'header') {
      const startM = matchGutenbergStart(sentText);
      if (startM) {
        gutenbergPhase = 'body';
        // The START marker can be fused into the same sentence as the opening of
        // the work when the source lacks a clean break after the marker line
        // (no blank line, the splitter merges marker + first prose). Chroming the
        // whole sentence then SWALLOWS the body that follows the marker — the
        // first lines of the actual work go dark and never reach retrieval
        // ("hits 0" on a doc whose body is plainly present). So: strip the
        // header-and-marker prefix (everything up to and including the matched
        // marker) and, if real prose remains after it, let the sentence fall
        // through to the emitters on that remainder. Only chrome it when nothing
        // but apparatus is left.
        const afterMarker = sentText.slice(startM.index + startM[0].length).trim();
        if (afterMarker && afterMarker.length >= 8 && !isChrome(afterMarker)) {
          // Re-point this sentence's text at the body remainder for extraction.
          // sentenceTexts[i] keeps the verbatim line (display/index unchanged);
          // the emitters below read `sentText`, so narrow that to the prose.
          sentText = afterMarker;
          currentSentText = afterMarker;
          // fall through to chrome gate + emitters
        } else {
          chromeIdx.push(i);
          return;
        }
      } else {
        chromeIdx.push(i);
        return;
      }
    }
    else if (gutenbergPhase === 'footer') { chromeIdx.push(i); return; }
    const endM = (gutenbergPhase === 'body' && _gutenbergHasEnd) ? matchGutenbergEnd(sentText) : null;
    if (endM) {
      // Mirror of the START fusion: body prose can be fused before a glued END
      // marker. Keep the prose that precedes the marker (everything up to the
      // match), drop the marker-and-footer apparatus that follows.
      const beforeMarker = sentText.slice(0, endM.index).trim();
      gutenbergPhase = 'footer';
      if (beforeMarker && beforeMarker.length >= 8 && !isChrome(beforeMarker)) {
        sentText = beforeMarker;
        currentSentText = beforeMarker;
        // fall through to read the trailing body prose
      } else {
        chromeIdx.push(i); return;
      }
    }

    if (isChrome(sentText)) { chromeIdx.push(i); return; }

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
      if (!trimmed) return;
      // A bare demonym ("Canadian", "French", "Russians") is a nationality
      // class word wearing a capital — compromise tags it ProperNoun, but
      // it names no referent. Admitted, it becomes a SYN anchor that pulls
      // the nationality's every span toward one node ("Canadian" fusing
      // into a biography's subject). Multi-word names that merely contain
      // one ("British Columbia") keep working.
      if (!/\s/.test(trimmed) && m.has('#Demonym')) return;
      properArr.push(trimmed);
    });

    const admitted = [];           // [{ surface, type, key }] for this sentence
    const seen = new Set();
    // Nested ink: the tagger emits both a compound and its inner span from the
    // same characters (places yields "Tennessee" AND "Tennessee Highway
    // Patrol" for one mention of the latter). One stretch of ink is ONE
    // mention — counted twice it hands the modifier's mass to a different
    // referent, and the state ends up outranking the agency named after it.
    // A SINGLE-TOKEN, non-person candidate whose every occurrence in this
    // sentence sits inside a longer candidate (itself a usable multi-word
    // name) is the longer name's ink, not its own. Multi-token sub-spans
    // ("District Management" ⊂ "District Management Corporation") keep the
    // old path — they fuse into the compound by gravity, so the mass stays
    // on the one referent — and persons keep it too: a clipped person span
    // fuses into the full name the same way.
    const _nestUnion = [...peopleArr, ...placesArr, ...orgsArr, ...properArr].map(s => String(s).trim()).filter(Boolean);
    const coveredByLongerInk = (surfRaw) => {
      const s = String(surfRaw).trim();
      if (!s || /\s/.test(s)) return false;             // single-token candidates only
      const longer = [];
      for (const o of _nestUnion) {
        if (o.length <= s.length || !o.includes(s)) continue;
        const oc = cleanEntitySurface(o.replace(/['’]s$/, ''));
        if (oc && /\s/.test(oc)) longer.push(o);
      }
      if (!longer.length) return false;
      let i = sentText.indexOf(s);
      if (i === -1) return false;                       // can't locate: never skip on a guess
      while (i !== -1) {
        let inside = false;
        for (const o of longer) {
          for (let j = sentText.indexOf(o); j !== -1 && !inside; j = sentText.indexOf(o, j + 1))
            if (i >= j && i + s.length <= j + o.length) inside = true;
          if (inside) break;
        }
        if (!inside) return false;                      // it stands on its own somewhere
        i = sentText.indexOf(s, i + 1);
      }
      return true;
    };
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
        if (type !== 'person' && coveredByLongerInk(surfRaw)) continue;
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
          recordSiteSurface(key, cleaned, type, mentionW, i);
          continue;
        }
        const singleInQuote = !/\s/.test(cleaned) && inQuote;
        if (!tryAdmit(cleaned, !singleInQuote, tentatives, lowerVocab)) continue;
        seen.add(key);
        admitted.push({ surface: cleaned, type, key });

        // ── Gravity resolution: INS, SYN-absorb, or NUL ──
        // Compute gravitational pull from every existing site whose name
        // shares at least one substantive token with this surface. Force =
        // (mass + momentum) × token-overlap. Mass is always-on rest gravity;
        // momentum is the kinetic boost from recent mentions.
        const candTokens = tokenSetOf(cleaned);
        const substCandTokens = [...candTokens].filter(t => t.length >= 3 && !STOP.has(t));
        // The arrival's ordered content sequence — the identity the gate
        // below tests, where the token SET above only measures recall.
        const candSeq = contentSeqOf(cleaned);
        // Gender of the arriving surface, read from a leading gendered title.
        // The title is a STOP token for the index, but it is identity evidence
        // here: "Mrs. Samsa" (f) and "Mr. Samsa" / "Gregor Samsa" (m) share only
        // the surname once the title is stripped — a known gender conflict means
        // they are different people, and must never fuse into one site.
        const candGender = genderFromName(cleaned);
        const pulls = [];
        if (substCandTokens.length > 0 && candSeq.length > 0) {
          for (const [siteKey, site] of sites) {
            const shared = [...candTokens].filter(t => site.tokens.has(t));
            const substShared = shared.filter(t => t.length >= 3 && !STOP.has(t));
            if (substShared.length === 0) continue;
            if (candGender && site.gender && candGender !== site.gender) continue;
            // ── Identity gate (INS outranks SIG) ──
            // Shared-token count used to be the merge evidence here, and it
            // fused every name pair sharing a head: "Winnipeg Symphony
            // Orchestra" + "Toronto Symphony Orchestra" (2 shared tokens),
            // the Academy/Golden Globe/Grammy/Genie awards (snowballing
            // through the accumulated token bag), "Max Steiner" + the award
            // named after him. Admission now requires the two names to
            // CO-REFER (namesCoRefer: equal sequences, person short forms,
            // or head-keeping containment — with the specifier-disagreement
            // veto), tested against the site's FULLEST sighted form rather
            // than its token bag, so one bad join can no longer widen the
            // net for the next. Force still RANKS the admitted pulls below —
            // overlap is a tie-breaker within identity, never an override.
            if (!site.fullSeq) noteFullForm(site, site.name);
            const bothPersons = type === 'person' && site.type === 'person';
            if (!namesCoRefer(candSeq, site.fullSeq, bothPersons)) continue;
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
          // ── Generic-phrase gate ──
          // A multi-token surface whose every content word also stands
          // lowercase on this page ("Music Festival", "Symphony Orchestra")
          // is a class phrase wearing capitals, not a name. Single tokens
          // already die at the lowercase-evidence gate in tryAdmit; this is
          // its multi-token completion, applied only where it matters — at
          // the brink of MINTING a referent. A generic head minted as a
          // node becomes a merge magnet for every later compound sharing
          // its tail. An honest short-form reuse ("Symphony Orchestra"
          // where "Winnipeg Symphony Orchestra" is established) never
          // reaches here: the established site pulls it in the branch
          // below. No event, like tryAdmit's silent rejections; withdrawn
          // from this sentence's admitted set so relation extraction can't
          // bind to a referent that was never minted.
          if (lowerVocab && /\s/.test(cleaned)) {
            const words = cleaned.toLowerCase().split(/\s+/)
              .map(w => w.replace(/[^\p{L}\p{M}\p{N}'’-]+/gu, ''))
              .filter(w => w.length >= 3 && !STOP.has(w));
            if (words.length && words.every(w => lowerVocab.has(w) || lowerVocab.has(singularStem(w) || w))) {
              admitted.pop();
              continue;
            }
          }
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
          recordSiteSurface(key, cleaned, type, mentionW, i);
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
          // Record the absorbed surface as a sighting of the target, then pick
          // the canonical mentions-first (the form named most), not the longer
          // string — see pickCanonicalForm.
          noteSight(target.siteKey, i);
          bumpForm(targetSite, cleaned);
          noteFullForm(targetSite, cleaned);
          const canonical = pickCanonicalForm(targetSite.forms, target.siteName);
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
          noteMetaphorSighting(targetSite, cleaned);
          // Absorb the surface's gender evidence too (sticky, first-known), so a
          // later gender-conflicting surface is kept apart: once this site has
          // absorbed "Mr. Samsa" it reads male, and "Mrs. Samsa" can no longer
          // fuse into it. Without this the gender guard above never has a gender.
          if (!targetSite.gender) targetSite.gender = genderFromName(cleaned);
          // Match tokens accumulate (recall never shrinks); display name is
          // the mentions-first canonical.
          for (const t of tokenSetOf(cleaned)) targetSite.tokens.add(t);
          targetSite.name = canonical;
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

    // Type inference from a copular gloss: a definition whose predicate names
    // a class ("Sam Gor is a drug syndicate") retypes a default thing-referent
    // to org/place/person via the type_keywords conventions. Conservative —
    // only a recognized class noun retypes, and only from the 'thing' default
    // — with ONE exception: a person-class gloss may override a PLACE guess.
    // Compromise reads a surname that doubles as a geography noun as a place
    // ("Howard SHORE"), and that first guess is sticky; the page's own copular
    // statement ("…is a Canadian composer") is strictly stronger evidence.
    // Org stays protected (an org described by its leader-noun must not turn
    // into a person). Emitted as a DEF path:'type' (the same channel
    // speech-induction uses), so projection believes it: the cluster's type
    // carries the retype forward.
    const maybeRetypeFromGloss = (targetSurface, hint, gloss) => {
      const inferred = inferTypeFromGloss(gloss);
      if (!inferred) return;
      // Resolve to the site the same way admission keyed it (article/adverb
      // heads stripped), so "The Black Hand" finds the "black hand" site.
      const cleanedKey = normSurface(cleanEntitySurface(targetSurface) || targetSurface);
      const k = (hint && hint.key)
        || resolveSiteKey(cleanedKey)
        || resolveSiteKey(normSurface(targetSurface));
      const site = k ? sites.get(k) : null;
      if (!site) return;
      if (site.type !== 'thing' && !(site.type === 'place' && inferred === 'person')) return;
      site.type = inferred;
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
        target: site.name, path: 'type', value: inferred,
        targetHint: { key: k, name: site.name, referent_id: site.referent_id },
        basis: 'class noun in a copular definition',
        reason: 'a named class retypes a default thing-referent',
        ...sentMeta, src: 'gloss-retype',
      });
    };

    // ── DEF (Dissecting): copular "X is/was Y" ────────────────
    // Use clauses() + manual copula detection instead of named-capture
    // matching — same compatibility reason as CON.
    // An inline parenthetical makes compromise clause the SUBJECT apart from
    // its copula ("Howard Leslie Shore OC | born … | is a Canadian
    // composer"), so the copula never meets its subject and the page's own
    // definition is lost. When the sentence carries one, re-clause a
    // paren-stripped copy; a sentence with no parenthetical uses sentDoc
    // unchanged, so every other reading is byte-identical (parity).
    const copularSource = /\([^()]*\)/.test(sentText)
      ? nlp(sentText.replace(/\s*\([^()]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim())
      : sentDoc;
    copularSource.clauses().forEach(clause => {
      const text = clause.text();
      // Look for "<noun phrase> (is|was|are|were|am) (a|an|the) <noun phrase>".
      // The determiner is REQUIRED and kept: a definition is a det-headed
      // predicate nominal ("a white minister", "the chief engineer"). A
      // det-less tail ("worth a fraction of that", "arrested in Amsterdam",
      // "his") is a clause fragment, not the company a thing keeps — it
      // deposits nothing here.
      const m = text.match(/^(.+?)\s+(is|was|are|were|am|been|becomes?|became|remains?|remained)\s+((?:(?:a|an|the)\s+)?)(.+?)\.?$/i);
      if (!m) return;
      let targetRaw = m[1].trim();
      // A postnominal parenthetical is apposition, not part of the name:
      // "Howard Leslie Shore OC (born October 18, 1946) is a Canadian
      // composer" must resolve its subject as the NAME, or the page's own
      // copular statement never reaches the site it defines.
      targetRaw = targetRaw.replace(/\s*\([^()]*\)\s*$/, '').trim() || targetRaw;
      // …and post-nominal honorifics ("OC", "OBE", "Jr.") are not part of the
      // name either — NER admits the site without them, so a subject that
      // keeps them resolves to no site. A closed list (never bare all-caps,
      // which would behead "The DMC is …" to "The").
      targetRaw = targetRaw.replace(/(?:\s+(?:OC|OBE|CBE|MBE|KBE|GBE|CC|CM|CVO|CH|PC|QC|KC|FRS|FRSC|FRSL|Jr\.?|Sr\.?|II|III|IV))+$/, '').trim() || targetRaw;
      // A subject led by a subordinating conjunction belongs to a
      // SUBORDINATE clause: "When Shore was 13" states his age at a past
      // moment, not the standing fact "Shore is 13" — the copula is the
      // temporal/conditional frame's, not a predication about the subject.
      // Promoting it is how a mechanical readout answered "what are his
      // influences?" with "Shore is 13". Rejected outright.
      if (/^(when|while|whenever|whilst|if|unless|though|although|because|whereas|once|after|before|until|till|as|since)\b/i.test(targetRaw)) return;
      const det = m[3] || '';
      const value = (det + m[4]).trim().replace(/[.,;:!?]+$/, '');
      if (!targetRaw || !value) return;
      // The copula carries TENSE, and tense is meaning: "Shore was a member
      // of Lighthouse" (1969–1972, finished) must not flatten to "Shore is a
      // member". Recorded on the event so the readout renders the page's own
      // tense instead of a default present.
      const copula = m[2].toLowerCase();
      const pastTense = /^(was|were|been|became|remained)$/.test(copula);
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
      // A det-headed predicate nominal is a definition (class); a det-less
      // tail ("worth a fraction of that", "seized by the committee") is a
      // recorded STATE — checkable predication, never what the thing IS.
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
        target, path: det ? 'class' : 'state', value,
        copula, tense: pastTense ? 'past' : 'present',
        targetHint: hint,
        targetRaw,
        ...sentMeta, src: 'copular',
      });
      if (det) maybeRetypeFromGloss(target, hint, value);
    });

    // ── DEF (Dissecting): deferred demonstrative naming ───────
    // Journalism often introduces a role-bearing actor by description
    // and names them a beat later: "…the same person who runs the DMC
    // and who then hires his own firm, NDP. That person is Tom Turner."
    // The copular reader above refuses "That person is …" — the subject
    // is a bare demonstrative, neither a site nor proper-noun shaped — so
    // the name lands with no role and the description, stranded on a noun
    // phrase that was never instantiated, is lost. This bridge reconnects
    // them: when "That/This/The <common-noun> is <ProperName>" follows a
    // recent "<det> <same-noun> who/that/which …", the proper name
    // inherits the whole description as its class. The assertion is cited
    // to the ANTECEDENT sentence, where the description actually appears,
    // so the mechanical re-read binds it cleanly.
    {
      const nm = sentText.match(/^\s*(?:that|this|the)\s+(\p{Ll}[\p{Ll}’'-]*)\s+(?:is|was)\s+(.+?)\.?\s*$/iu);
      if (nm) {
        const headNoun = nm[1].toLowerCase();
        const name = trimNounSpan(nm[2]) || nm[2].trim();
        const nameKey = normSurface(name);
        // The name must be a real, just-instantiated proper referent (it is
        // INS'd by addEnts above, which runs earlier in this sentence).
        if (looksProper(name) && !isPronoun(name) && sites.has(nameKey)) {
          // The antecedent: a recent definite/indefinite description headed
          // by the SAME noun and bearing a relative clause. Stop the span at
          // a trailing purpose/relative tail (", to …", ", which …") or
          // clause boundary so the role — not the surrounding sentence — is
          // what attaches.
          const antRe = new RegExp(
            '((?:the\\s+same|the|a|an|his|her|its|their|this|that)\\s+' +
            headNoun + '\\s+(?:who|whom|that|which)\\b.+?)' +
            '(?=,\\s*(?:to|so|which|where|while|in\\s+order)\\b|[.;:]|$)', 'iu');
          let desc = null, srcSent = -1;
          for (let back = 1; back <= 2 && i - back >= 0; back++) {
            const m = (sentenceTexts[i - back] || '').match(antRe);
            if (m) { desc = m[1].trim().replace(/[\s,;:]+$/, ''); srcSent = i - back; break; }
          }
          if (desc && desc.length <= 200 && normSurface(desc) !== nameKey) {
            const site = sites.get(nameKey);
            // The antecedent sentence is a real sighting of THIS referent —
            // the bridge just proved the description and the name are one
            // person. Credit it, so a figure the page describes at length and
            // names once ("That person is Tom Turner") clears the two-sighting
            // gate on salience rather than being retired as a lone appearance
            // (which would also strand these very DEFs in the settle pass). The
            // name's own sentence is recorded by addEnts; this adds the
            // description's.
            noteSight(nameKey, srcSent);
            events.push({
              id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
              target: name, path: 'class', value: desc,
              targetHint: { key: nameKey, name: site.name, referent_id: site.referent_id },
              // Provenance: the synthesis spans two sentences. The role text
              // lives at sentence_idx (the antecedent); the naming that bound
              // it to this referent happened at naming_sentence.
              naming_sentence: i,
              sentence_idx: srcSent,
              src: 'naming-bridge',
            });
            // The description often carries the person's ROLE relationally —
            // "the same person who runs the DMC and who then hires his own
            // firm" — rather than as a copular title ("Tom Turner is the
            // president of NDP"). A reader gets the job from that; a query
            // for it ("what is Tom Turner's job?") gets nothing, because no
            // role-shaped assertion exists to retrieve against. Distill the
            // role clauses into a second DEF alongside the class gloss.
            const roles = rolesFromDescription(desc);
            if (roles.length) {
              events.push({
                id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
                target: name, path: 'role', value: roles.join('; '),
                targetHint: { key: nameKey, name: site.name, referent_id: site.referent_id },
                naming_sentence: i,
                sentence_idx: srcSent,
                src: 'naming-bridge',
              });
            }
          }
        }
      }
    }

    // ── DEF (Dissecting): possessive kin — "his son", "her mother" ──
    // A possessive determiner + kin noun holds a relation the page never
    // states as a copula: "Until recently, his son served as Director…"
    // says WHOSE son only through the pronoun. Without this reader the
    // phrase deposits nothing — a question like "whose son is mentioned?"
    // strands on a pronoun no retrieval can resolve. The possessor is
    // resolved under the same activation law every pronoun obeys (surface
    // mass × weight + momentum, δ dominance, absolute floor, stall-to-NUL),
    // and the relation lands as a DEF the answer layer reads back.
    // Narration only — a character saying "my son…" is speech, not record.
    if (KIN_TERMS && KIN_TERMS.size) {
      const narration = sentText
        .replace(/“[^”]*[”]?/g, ' ')
        .replace(/"[^"]*"/g, ' ');
      KIN_POSS_RE.lastIndex = 0;
      let km; const kinSeen = new Set();
      // The local field: persons named in the previous or current sentence.
      // A possessive determiner is a LOCAL anaphor — "…is David Corman, a
      // former commander. Until recently, his son served…" reads as Corman's
      // son to any reader, even while a heavier name from earlier pages still
      // out-masses him globally. The narrowing is the linguistic convention;
      // within the narrowed field the SAME laws apply (sign exclusion, δ
      // dominance, absolute floor). A contested local field stalls honestly —
      // two fresh local persons IS ambiguity, and the global field must not
      // break that tie with stale mass. Only an EMPTY or sign-excluded local
      // field falls back to whole-page activation.
      const localPersons = new Map();
      for (const k of prevSentencePersons) { const v = sites.get(k); if (v) localPersons.set(k, v); }
      for (const a of admitted) {
        const rk = resolveSiteKey(a.key);
        const v = rk ? sites.get(rk) : null;
        if (v && v.type === 'person') localPersons.set(rk, v);
      }
      while ((km = KIN_POSS_RE.exec(narration)) !== null) {
        const poss = km[1].toLowerCase(), kin = km[2].toLowerCase();
        if (kinSeen.has(poss + ':' + kin)) continue;
        kinSeen.add(poss + ':' + kin);
        let hint = null, localStalled = false;
        if (localPersons.size) {
          const r = resolveByActivation(poss, localPersons);
          if (r && r.key) {
            hint = r;
            // a binding is an inferred mention: warm at the anaphora coupling,
            // exactly as resolvePronoun does for its own binds
            const site = sites.get(r.key);
            if (site) { site.mass += ANAPHORA_W(); site.momentum = site.momentum * GAMMA + 1; }
          } else if (r && r.nul) {
            localStalled = true;
            events.push({
              id: 'ev-' + seq, seq: seq++, op: 'NUL', stance: 'Preserving',
              surface: poss + ' ' + kin, reason: 'pronoun-stall:' + r.reason,
              // Identity only; measurements under `observed` (see the
              // pronoun-activation stall above).
              competing: (r.competing || []).map(c => ({ site: c.site, siteName: c.siteName })),
              observed: { frame: frameStamp(currentSentIdx), competing: r.competing },
              sentence_idx: currentSentIdx, sentence: currentSentText, src: 'possessive-kin',
            });
          }
        }
        if (!hint && !localStalled) {
          const r = resolvePronoun(poss);
          // A stall or a provisional (signal) binding deposits nothing here —
          // the NUL resolvePronoun just logged IS the honest record.
          if (r && !r.provisional && r.referent_id && r.key) hint = r;
        }
        if (!hint) continue;
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
          target: hint.name, path: 'kin', value: kin,
          targetHint: { key: hint.key, name: hint.name, referent_id: hint.referent_id },
          basis: `possessive "${poss} ${kin}"`,
          ...sentMeta, src: 'possessive-kin',
        });
      }
    }

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
      if (AUX_VERBS_RE.test(vFirst)) return;
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
      // Resolve each argument to a referent. A pronoun resolves through its
      // hint; a surface resolves through the site table.
      const resolveSvoRef = (surface, hint) => {
        if (hint && hint.referent_id) return { id: hint.referent_id, key: hint.key || null };
        const k = (hint && hint.key) || resolveSiteKey(normSurface(surface));
        const site = k ? sites.get(k) : null;
        return site ? { id: site.referent_id, key: k } : null;
      };
      const sRef = resolveSvoRef(s, sHint);
      const oRef = resolveSvoRef(oTrim, oHint) || resolveSvoRef(o, oHint);
      // The subject of an enacted action has agency evidence — it can later be
      // a fallback speaker (a metaphor-only name never reaches this path).
      if (sRef && sRef.key) { const sv = sites.get(sRef.key); if (sv) sv.hasAgencyEvidence = true; }
      const base = {
        s, v, o: oTrim, sHint, oHint,
        // Raw tokens for downstream reconciliation (embedding lookup, etc.)
        // The trimmed surfaces above may lose information; preserve the
        // original spans so the reconciler can decide what matters.
        sRaw, oRaw,
        ...sentMeta, src: 'svo',
      };
      // The depicted act the verb reports (SEG/SYN/state/…), content on the bond.
      const dep = depictedAct(v);
      if (sRef && oRef && sRef.id !== oRef.id) {
        // Subject and object resolve to DISTINCT referents: this is a relation
        // ASSERTED between two things — CON (Connecting), by the operator
        // algebra — not SYN. SYN is reserved for identity-bearing joins
        // (gravity merge, coreference, surface unification); a relation that
        // connects two referents without fusing them is CON. The graph's
        // edges become the projection of these (weight = co-occurrence count),
        // and the propositional veto finally has assertions to check against.
        const nameOfKey = (k) => (k && sites.get(k) ? sites.get(k).name : null);
        events.push({
          id: 'ev-' + seq, seq: seq++, op: 'CON', stance: 'Connecting',
          ...base,
          relation: normalizeRelation(v),
          source_ref: sRef.id, target_ref: oRef.id,
          sourceName: nameOfKey(sRef.key) || s, targetName: nameOfKey(oRef.key) || oTrim,
          ...(dep ? { depicts: dep } : {}),
        });
      } else {
        // One or both arguments unbound (a common-noun object, a pronoun still
        // stalling), or both the same referent (reflexive): not an identity
        // join and not yet a resolved connection. Kept as SYN, unchanged.
        events.push({ id: 'ev-' + seq, seq: seq++, op: 'SYN', stance: 'Joining', ...base });
      }
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
            // Touch the bound site — attribution is a mention. A site that
            // has spoken has agency evidence: it can be the fallback speaker
            // for a later unattributed quote (a metaphor-only name cannot).
            v.mass += 1;
            v.momentum = v.momentum * GAMMA + 1;
            v.hasAgencyEvidence = true;
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

      // Speaker plausibility gate: a quote with no explicit attribution may
      // only be guessed onto a person the page has shown to ACT or SPEAK — a
      // referent with agency evidence that is not a metaphor-only mention. The
      // fallback used to grab the nearest/heaviest named person regardless,
      // attributing speech to a name that only appears in a figure ("the Jeff
      // Bezos of the drug trade"). An ineligible candidate is declined, and the
      // quote goes out honestly unattributed rather than wrongly bound.
      const speakerEligible = (v) => !!v && v.type === 'person' && !v.metaphorOnly && v.hasAgencyEvidence === true;
      let gatedCandidate = false;
      // Find speaker — clean leading/trailing junk from any admitted person
      if (!speaker) {
        for (const a of admitted) {
          if (a.type !== 'person') continue;
          const rk = resolveSiteKey(a.key);
          const v = rk ? sites.get(rk) : null;
          // No site yet means no agency evidence either: a name admitted in
          // this very sentence (often the vocative — "Good morning, Mr.
          // Samsa" — the ADDRESSEE) may not be guessed onto the quote.
          if (!speakerEligible(v)) { gatedCandidate = true; continue; }
          // Record the BODY that cleared the gate (the canonical site), not
          // the raw surface — the eligibility judged and the speaker written
          // must be the same referent.
          speaker = { surface: v.name, type: 'person', key: rk, referent_id: v.referent_id };
          break;
        }
      }
      // Fallback: highest mass-weighted person candidate. The candidate
      // pool includes both real referents AND signals (pre-referent
      // expectations). A heavy female signal in a Princess-Mary scene can
      // outscore Marshal as the more likely speaker even though no name has
      // been committed for her yet. Named sites must clear the plausibility
      // gate; signals (an unnamed person tracked through narration pronouns)
      // are inherently agentive and stay eligible.
      // Both must also be WARM: momentum decays by γ per sentence, so a
      // candidate silent for ~8+ sentences scores on accumulated mass alone —
      // and binding a quote to whoever the document has mentioned MOST,
      // rather than anyone present in the scene, is how a fresh in-sentence
      // name (gated above for lacking agency evidence) loses its own quote
      // to a heavy character from pages back. Cold candidates are declined;
      // the quote goes out honestly unattributed.
      const FALLBACK_MOMENTUM_FLOOR = 0.05;
      if (!speaker) {
        let bestKey = null, bestScore = -Infinity, bestSignal = null;
        for (const [k, v] of sites) {
          if (v.type !== 'person') continue;
          if (!speakerEligible(v)) { gatedCandidate = true; continue; }
          if (v.momentum < FALLBACK_MOMENTUM_FLOOR) { gatedCandidate = true; continue; }
          const score = v.mass * MASS_WEIGHT + v.momentum;
          if (score > bestScore) { bestKey = k; bestScore = score; bestSignal = null; }
        }
        for (const sig of signals.values()) {
          if (sig.constraints.type !== 'person') continue;
          if (sig.momentum < FALLBACK_MOMENTUM_FLOOR) continue;
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
        // report confidence from this, never reconstruct it. 'unattributed'
        // means the plausibility gate declined the candidates it had (an
        // implausible speaker held back) rather than finding none at all.
        attributed: !speaker ? (gatedCandidate ? 'unattributed' : 'none')
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

    // Hand the next sentence its local anaphor field: the persons THIS
    // sentence named (see the possessive-kin reader above).
    prevSentencePersons = new Set();
    for (const a of admitted) {
      const rk = resolveSiteKey(a.key);
      const v = rk ? sites.get(rk) : null;
      if (v && v.type === 'person') prevSentencePersons.add(rk);
    }
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
        await _breathe(onProgress, 'structure', i + 1, sentenceDocs.length); _readClock = performance.now();
      }
    }
  }

  // ── Admission gate, settled ─────────────────────────────────
  // Only what returns keeps its name: the gate is two sightings, counted as
  // distinct prose sentences (a voice's attributed turns count — speaking is
  // being sighted). A site that never returned is retired by SEG — its INS
  // stays in the log, answered, and the projection drops the referent. The
  // log stays append-only: nothing is unwritten, the retirement is written.
  {
    const GATE = READING_RULES.two_sighting_admission.value;
    const chromeSet = new Set(chromeIdx);
    const sigSents = new Map();
    for (const ev of events) {
      if (ev.op !== 'SIG' || !ev.speaker || ev.speaker === '?' || ev.sentence_idx == null) continue;
      const k = normSurface(ev.speaker);
      if (!sigSents.has(k)) sigSents.set(k, new Set());
      sigSents.get(k).add(ev.sentence_idx);
    }
    const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const insByRef = new Map();
    for (const ev of events) if (ev.op === 'INS' && ev.referent_id) insByRef.set(ev.referent_id, ev);
    // Every live (non-absorbed) site's forms, for the nested-name redaction in
    // the scan below: "Nashville" must not collect sightings from sentences
    // whose only ink is "Nashville Downtown Partnership" — the substring scan
    // would hand the compound's sentences (and so its mass) to the shorter
    // name, and the projection then leads the portrait with the wrong
    // protagonist (the city outranking the org named after it).
    const liveForms = [];
    for (const [k2, s2] of sites) {
      if (surfaceAlias.has(k2)) continue;
      for (const f of new Set([s2.name, ...(s2.forms ? s2.forms.keys() : [])])) if (f) liveForms.push({ key: k2, form: String(f) });
    }
    for (const [key, site] of sites) {
      if (surfaceAlias.has(key)) continue;                    // absorbed into another body
      const sighted = new Set(sightSents.get(key) || []);
      for (const si of (sigSents.get(key) || [])) sighted.add(si);
      // Capture has recall holes (a tagger missing a bare surname is not the
      // name failing to return). The evidence of record is the page: scan the
      // prose spans for any sighted FORM of the name, whole-word — but ink
      // already belonging to a LONGER live name is redacted first, so a short
      // name only earns the sentences where it stands on its own.
      {
        const forms = [...new Set([site.name, ...(site.forms ? site.forms.keys() : [])])].filter(Boolean);
        const res = forms.map(f => new RegExp('(^|[^A-Za-z0-9_])' + escRe(f) + '($|[^A-Za-z0-9_])'));
        const redact = liveForms
          .filter(lf => lf.key !== key && forms.some(f =>
            lf.form.length > f.length && new RegExp('(^|[^A-Za-z0-9_])' + escRe(f) + '($|[^A-Za-z0-9_])').test(lf.form)))
          .map(lf => new RegExp(escRe(lf.form), 'g'));
        for (let si = 0; si < sentenceTexts.length; si++) {
          if (chromeSet.has(si) || sighted.has(si)) continue;
          let t = sentenceTexts[si];
          for (const re of redact) t = t.replace(re, ' ');
          if (res.some(re => re.test(t))) sighted.add(si);
        }
      }
      const sis = [...sighted].sort((a, b) => a - b);
      if (sighted.size >= GATE) {
        // Survivor: write the settled evidence onto its INS (the same basis
        // vocabulary the zh miner and REC use), so the projection and any
        // auditor read the admission's grounds, not capture luck.
        const ins = insByRef.get(site.referent_id);
        if (ins) ins.basis = Object.assign({}, ins.basis, { slot_sightings: sis.length, sightings: sis });
        continue;
      }
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'SEG', stance: 'Dissecting',
        target: site.name, referent_id: site.referent_id,
        reason: 'single-sighting', basis: { sightings: sis },
        sentence_idx: sis.length ? sis[0] : null,
        src: 'admission-gate',
      });
    }
  }

  // ── Binding, settled ────────────────────────────────────────
  // Two names joined by a deed is a bond. Resolution completes only when
  // admission settles, so the deed's operator settles here with it: an SVO
  // whose subject and object both resolve to DISTINCT surviving referents is
  // CON (the bond written between the names); a deed an endpoint of which
  // was retired, or never resolved, stays SYN. Same parse, same log — the
  // event's id, seq, and sentence keep their place; only the classification
  // the algebra demands is settled.
  {
    const retired = new Set(events.filter(e => e.op === 'SEG' && e.src === 'admission-gate').map(e => e.referent_id));
    const live = [];
    for (const [key, site] of sites) {
      if (surfaceAlias.has(key) || retired.has(site.referent_id)) continue;
      live.push({ key, site, content: [...site.tokens].filter(t => t.length >= 3 && !STOP.has(t)) });
    }
    const byRef = new Map(live.map(L => [L.site.referent_id, L]));
    const resolveSettled = (surface, hint) => {
      if (hint && hint.referent_id && byRef.has(hint.referent_id)) return byRef.get(hint.referent_id);
      if (surface == null || isPronoun(surface)) return null;
      const rk = resolveSiteKey(normSurface(surface));
      if (rk) { const s = sites.get(rk); if (s && byRef.has(s.referent_id)) return byRef.get(s.referent_id); }
      const candTok = [...tokenSetOf(surface)].filter(t => t.length >= 3 && !STOP.has(t));
      if (!candTok.length) return null;
      const candSet = new Set(candTok);
      let best = null, bestN = 0;
      for (const L of live) {
        if (!L.content.length) continue;
        const siteInCand = L.content.every(t => candSet.has(t));
        const candInSite = candTok.every(t => L.site.tokens.has(t));
        if ((siteInCand || candInSite) && L.content.length > bestN) { best = L; bestN = L.content.length; }
      }
      return best;
    };
    for (const ev of events) {
      if (ev.src !== 'svo' || ev.s == null || ev.o == null) continue;
      const S = resolveSettled(ev.s, ev.sHint);
      const O = resolveSettled(ev.o, ev.oHint);
      if (S && O && S.site.referent_id !== O.site.referent_id) {
        ev.op = 'CON'; ev.stance = 'Connecting';
        ev.relation = normalizeRelation(ev.v);
        ev.source_ref = S.site.referent_id; ev.target_ref = O.site.referent_id;
        ev.sourceName = S.site.name; ev.targetName = O.site.name;
      } else if (ev.op === 'CON') {
        // a bond needs two surviving referents — this one lost an endpoint
        ev.op = 'SYN'; ev.stance = 'Joining';
        delete ev.source_ref; delete ev.target_ref; delete ev.sourceName; delete ev.targetName;
      }
    }
    // DEFs settle the same way: a definition or state recorded against a
    // surface that never became (or did not remain) a referent defines
    // nothing — it leaves the log before commit. Admitted non-site referents
    // (zh grams, voices) still count as targets.
    const insAlive = new Set();
    for (const ev of events) {
      if (ev.op === 'INS' && !retired.has(ev.referent_id)) insAlive.add(normSurface(ev.target));
    }
    for (let k = events.length - 1; k >= 0; k--) {
      const ev = events[k];
      if (ev.op !== 'DEF' || ev.src === 'frame-mint' || ev.src === 'csv-schema' || ev.src === 'csv-cell') continue;
      const hintRef = ev.targetHint && ev.targetHint.referent_id;
      if (hintRef && byRef.has(hintRef)) continue;
      if (resolveSettled(ev.target, ev.targetHint)) continue;
      if (insAlive.has(normSurface(ev.target))) continue;
      events.splice(k, 1);
    }
  }

  // ── Site face: stamp every event with the phenomenological address it
  // touches (Space × Time). The operator already fixes the Domain; the target
  // noun fixes the Time column through the site cues. This is the Site
  // projection of the same log the operators are the Act projection of. ──
  for (const ev of events) { const s = eoSiteOfEvent(ev); if (s) ev.site = s; }

  // ── Significance: project mass, momentum and prominence over the settled
  // structure — only now, with existence and structure complete beneath it. ──
  if (onProgress) { onProgress({ phase: 'significance', stage: 'projecting' }); await _breathe(onProgress, 'significance'); }
  // No batch reconciliation: gravity resolution happened inline per sentence.
  // The embedding reconciler and the LLM tiebreak run automatically after
  // this warm pass — cold pass first, then EVA deposits on whatever stalled.
  const { entities: allEntities, edges: allEdges } = projectGraph(events);
  const retiredRefs = new Set(events.filter(e => e.op === 'SEG' && e.src === 'admission-gate').map(e => e.referent_id));
  const retiredNames = new Set(events.filter(e => e.op === 'SEG' && e.src === 'admission-gate').map(e => normSurface(e.target)));
  const entities = allEntities.filter(e => !retiredRefs.has(e.referent_id) && !retiredNames.has(normSurface(e.name)));
  const edges = allEdges.filter(e => !retiredNames.has(normSurface(e.s != null ? e.s : e.source || '')) && !retiredNames.has(normSurface(e.o != null ? e.o : e.target || '')));

  // ── Company, written ────────────────────────────────────────
  // The neighbors are the definition: every surviving referent carries a
  // frame — the hash of its CON neighborhood — stored as its DEF. An empty
  // neighborhood still frames (the proposition "keeps no company"), and a
  // second document's frame can now meet it (EVA, evaAcrossDocs).
  {
    // referents chain through gravity merges: a cluster's bonds belong to
    // its canonical body, whichever referent id an event recorded
    const canon = new Map();
    for (const ev of events) {
      if (ev.op !== 'SYN' || !Array.isArray(ev.referent_ids) || !ev.canonical_referent_id) continue;
      for (const r of ev.referent_ids) if (r !== ev.canonical_referent_id) canon.set(r, ev.canonical_referent_id);
    }
    const chase = (r) => { let cur = r, hops = 0; while (canon.has(cur) && hops++ < 6) cur = canon.get(cur); return cur; };
    const neigh = new Map();
    const add = (ref, edge) => { const k = chase(ref); if (!neigh.has(k)) neigh.set(k, []); neigh.get(k).push(edge); };
    for (const ev of events) {
      if (ev.op !== 'CON' || !ev.source_ref || !ev.target_ref) continue;
      const rel = String(ev.relation || ev.v || '').toLowerCase();
      add(ev.source_ref, '>' + rel + '>' + normSurface(ev.targetName || ev.o || ''));
      add(ev.target_ref, '<' + rel + '<' + normSurface(ev.sourceName || ev.s || ''));
    }
    for (const e of entities) {
      if (!e.referent_id) continue;
      const frameEdges = [...new Set(neigh.get(chase(e.referent_id)) || [])].sort();
      events.push({
        id: 'ev-' + seq, seq: seq++, op: 'DEF', stance: 'Dissecting',
        target: e.name, path: 'frame',
        value: 'frame:' + sha256Hex(JSON.stringify(frameEdges)).slice(0, 16),
        targetHint: { referent_id: e.referent_id },
        basis: { edges: frameEdges.length },
        sentence_idx: null, sentence: null, src: 'frame-mint',
      });
    }
  }

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
    genre: TRANSCRIPT ? 'transcript' : undefined,
    voices: TRANSCRIPT ? TRANSCRIPT.speakers : undefined,
    // the text the reading actually segmented (cues and labels normalized
    // away) — the host must rebuild blocks from THIS, not the raw paste,
    // or sentence indices drift and timecodes leak back into the view
    normalized_text: TRANSCRIPT ? text : undefined,
    input_chars: text.length,
    sentences: sentCount,
    events,
    entities,
    edges,
    verb_slot_tally: typeof verbSlotTally !== 'undefined' ? verbSlotTally : {},
    sections,
    sentence_texts: sentenceTexts,
    // raw per-paragraph sentence counts, in order — lets the host rebuild
    // display blocks without re-running the segmenter over the whole document.
    paragraph_counts: paraCounts,
    chrome: chromeIdx,
    open_signals: openSignals,
    signal_collapses: signalCollapses,
    rules: rulesJson,
    language_modules: modulesJson,
    readers: readersJson,
    counts: {
      INS: events.filter(e => e.op === 'INS').length,
      SYN: events.filter(e => e.op === 'SYN').length,
      CON: events.filter(e => e.op === 'CON').length,
      DEF: events.filter(e => e.op === 'DEF').length,
      SIG: events.filter(e => e.op === 'SIG').length,
      NUL: events.filter(e => e.op === 'NUL').length,
      SEG: events.filter(e => e.op === 'SEG').length,
      EVA: events.filter(e => e.op === 'EVA').length,
      REC: events.filter(e => e.op === 'REC').length,
      RULES: Object.keys(READING_RULES).length,
    },
    // The Site face as a tally — how many acts landed on each of the nine
    // phenomenological addresses. The Act counts above are Identity × Space;
    // this is the Space × Time projection of the same log.
    sites: (() => { const t = {}; for (const s of eoSites()) t[s] = 0; for (const e of events) if (e.site) t[e.site]++; return t; })(),
    ms: Math.round(t1 - t0),
  };
}

// Shape score for a surface form (no mass) — proper-noun-shaped and a
// reasonable length read as a better canonical. The tie-breaker under the
// mentions-first rule below.
function canonicalShapeScore(name) {
  const words = String(name).trim().split(/\s+/);
  let s = 0;
  if (/^\p{Lu}/u.test(words[0] || '') && (words.length === 1 || /^\p{Lu}/u.test(words[words.length - 1]))) s += 50;
  const len = String(name).length;
  if (len > 4 && len < 30) s += 20;
  if (len >= 30) s -= 40;
  if (words.length > 6) s -= 40;
  return s;
}

function bumpForm(site, surface) {
  if (!site.forms) site.forms = new Map();
  site.forms.set(surface, (site.forms.get(surface) || 0) + 1);
}
// Mentions-first canonical: the surface form a cluster was named by MOST
// often is its canonical key, not the longest string. "Toronto" (sighted 20
// times) wins over "Toronto International Film Festival" (sighted 3 times) —
// the overlap formula used to reward the longer string and pick the rarer
// one. Ties break on shape (proper-noun-shaped, reasonable length preferred —
// which already demotes a 34-char festival name even at equal counts), then
// on the FULLER name ("David Corman" over a bare "Corman"). `forms` is a
// Map(surface → sighting count).
function pickCanonicalForm(forms, fallback) {
  if (!forms || forms.size === 0) return fallback;
  // One tied form being a word-prefix of the other means the shorter is the
  // longer's clipped echo, not a competing name — "Davidson County Chancery"
  // next to "Davidson County Chancery Court" is the same name cut short, and
  // the shape score's length penalty must not behead it. Only at equal
  // counts: a genuinely more-mentioned short form ("Toronto") still wins.
  const wordPrefix = (shorter, longer) =>
    longer.length > shorter.length && longer.toLowerCase().startsWith(shorter.toLowerCase() + ' ');
  let best = null, bestN = -Infinity, bestShape = -Infinity;
  for (const [form, n] of forms) {
    if (n > bestN) { best = form; bestN = n; bestShape = canonicalShapeScore(form); continue; }
    if (n === bestN) {
      if (wordPrefix(best, form)) { best = form; bestShape = canonicalShapeScore(form); continue; }
      if (wordPrefix(form, best)) continue;
      const shape = canonicalShapeScore(form);
      if (shape > bestShape || (shape === bestShape && form.length > best.length)) {
        best = form; bestShape = shape;
      }
    }
  }
  return best != null ? best : fallback;
}

// Deterministic cluster canonical (projection-time identity): the LONGEST
// fully-specified mention is the cluster's identity statement — "David
// Cronenberg" over "Cronenberg", "Bridgehampton Chamber Music Festival"
// over a truncation — independent of which form happened to host each
// inline merge. Ties break on sighting count, then first-sighting order,
// then the string itself: a TOTAL order, so the same forms yield the same
// canonical on every firing, and the cluster key derives from the same
// string (key ⊂ name by construction). The inline site names
// (pickCanonicalForm above) remain live-pass display transients; this is
// the projected identity.
function pickCanonicalDeterministic(forms, firstSeq) {
  let best = null, bestSeq = -1, bestLen = -1, bestN = -1, bestFirst = Infinity;
  for (const [form, n] of forms) {
    const seqLen = contentSeqOf(form).length;
    const len = String(form).length;
    const first = (firstSeq && firstSeq.has(form)) ? firstSeq.get(form) : Infinity;
    const better =
      seqLen > bestSeq ||
      (seqLen === bestSeq && (len > bestLen ||
        (len === bestLen && (n > bestN ||
          (n === bestN && (first < bestFirst ||
            (first === bestFirst && best != null && String(form) < String(best))))))));
    if (better) { best = form; bestSeq = seqLen; bestLen = len; bestN = n; bestFirst = first; }
  }
  return best;
}

// Pronoun resolution under physics: pronouns have no substantive token
// of their own, so they bind by type (person pronoun → person sites).
// The pull strength is the site's momentum (recent activity in working
// memory). Highest-momentum matching site absorbs the pronoun.
function resolveByActivation(pronoun, sites) {
  const lower = String(pronoun).toLowerCase();
  const needFemale = FEMALE_PRONOUNS.has(lower);
  const needMale = MALE_PRONOUNS.has(lower);
  // "they/them" is animate-but-genderless — but reading it as a SINGULAR
  // reference to one named person is a register convention (singular_they),
  // off for classic narrative. When off, they/them is left to the old
  // type-agnostic path (it may still bind a plural-ish heavy site, unchanged).
  const neutralPerson = NEUTRAL_PERSON_PRONOUNS.has(lower)
    && READING_RULES.singular_they && READING_RULES.singular_they.value;
  const needPerson = PERSON_PRONOUNS.has(lower) || neutralPerson;
  const preferNonPerson = NONPERSON_PRONOUNS.has(lower);
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
    // type charge. A gendered/person pronoun binds only persons — UNCHANGED, so
    // classic-prose resolution is untouched. The one exception is singular
    // "they" under a modern-register module (neutralPerson): there it may also
    // admit a proper-name `thing` and promote it. Gendered he/she never hijack
    // eligibility (that would let a genderless thing compete for "she"); a
    // non-speaking person instead earns its type from the speaker/title signals
    // reconciled in projection.
    if (needPerson && v.type !== 'person' && !(neutralPerson && v.type === 'thing' && looksLikePerson(v.name))) continue;
    if (needFemale && v.gender === 'm') continue;         // sign exclusion
    if (needMale && v.gender === 'f') continue;           // sign exclusion
    const surfaceMass = v.surfaceMass != null ? v.surfaceMass : v.mass;
    let score = surfaceMass * MASS_WEIGHT + v.momentum;
    if (neutralPerson && v.type !== 'person') score -= 0.001;   // a real person wins ties
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
  // The site a pronoun resolved to has been referred to as an agent — agency
  // evidence the speaker-plausibility gate reads (a metaphor-only name never
  // earns this, so it can never be drafted as a fallback speaker).
  best.v.hasAgencyEvidence = true;
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
  // A CON event carries the same s/v/o/sHint/oHint shape as a text-layer SYN
  // and is registered the same way for occurrences, mass, and edges — it only
  // differs in the operator label (a relation between distinct referents, not
  // an identity join), so every projection slot below treats them together.
  const isRelationEdge = (ev) => isTextSyn(ev) || ev.op === 'CON';

  const slotsOf = (ev) => {
    if (isRelationEdge(ev)) return [
      { surface: ev.s, hint: ev.sHint },
      { surface: ev.o, hint: ev.oHint },
    ];
    // a frame DEF is settlement bookkeeping ABOUT a referent, not a
    // sighting OF it — it carries no mention weight
    if (ev.op === 'DEF') return ev.src === 'frame-mint' ? [] : [{ surface: ev.target, hint: ev.targetHint }];
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
    if (!['SYN', 'CON', 'DEF', 'SIG', 'INS'].includes(ev.op)) continue;
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
      const cur = occ.get(key) || { key, name: surf, mentions: 0, eventSeqs: [], surfaceForms: new Set(), formCounts: new Map(), formFirst: new Map() };
      cur.mentions++;
      cur.eventSeqs.push(ev.seq);
      cur.surfaceForms.add(surf);
      cur.formCounts.set(surf, (cur.formCounts.get(surf) || 0) + 1);
      if (!cur.formFirst.has(surf)) cur.formFirst.set(surf, ev.seq);
      // Display name is mentions-first (the form seen most), not the longest
      // string — consistent with the site-layer canonical. A site-SYN
      // `canonical` from a gravity merge still overrides this below.
      cur.name = pickCanonicalForm(cur.formCounts, cur.name);
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
          if (!cur.formCounts) cur.formCounts = new Map();
          if (!cur.formFirst) cur.formFirst = new Map();
          cur.formCounts.set(siteName, (cur.formCounts.get(siteName) || 0) + 1);
          if (!cur.formFirst.has(siteName)) cur.formFirst.set(siteName, ev.seq);
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
    const state = new Map();   // root → { mass, surfaceMass, momentum, lastSentence }
    const ensureState = (root, sent) => {
      if (!state.has(root)) state.set(root, { mass: 0, surfaceMass: 0, momentum: 0, lastSentence: sent });
      return state.get(root);
    };
    const decayTo = (s, sent) => {
      const gap = Math.max(0, sent - s.lastSentence);
      if (gap > 0) s.momentum *= Math.pow(γ, gap);
      s.lastSentence = sent;
    };
    // surfaceW is the share of the deposit earned from the NAME appearing on
    // the page; pronoun/inferred touches pass 0. It is a pure measurement
    // accumulator — nothing in the replay reads it for any decision — so it
    // never changes resolution dynamics.
    const touch = (key, sent, w = 1, surfaceW = w) => {
      if (!key) return null;
      const root = rFind(key);
      const s = ensureState(root, sent);
      decayTo(s, sent);
      s.momentum = s.momentum * γ + w;
      s.mass += w;
      s.surfaceMass = (s.surfaceMass || 0) + surfaceW;
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
        let totalMass = 0, totalMomentum = 0, totalSurfaceMass = 0;
        for (const r of uniqueRoots) {
          const s = ensureState(r, sent);
          decayTo(s, sent);
          totalMass += s.mass;
          totalMomentum += s.momentum;
          totalSurfaceMass += (s.surfaceMass || 0);
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
          surfaceMass: totalSurfaceMass + 1,     // the join is a name-level observation
          momentum: totalMomentum * γ + 1,       // momentum carries forward, decayed and bumped
          lastSentence: sent,
        };
        for (const r of uniqueRoots) if (r !== newRoot) state.delete(r);
        state.set(newRoot, merged);
      } else if (ev.op === 'SYN' || ev.op === 'CON') {
        // Text-layer SYN or CON — touch sHint and oHint sites (via hint when
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
          const surfaceW = isPronoun(rawSurf) ? 0 : w;   // pronouns earn no surface mass
          const redirected = hintToKey(hint);
          if (redirected) { touch(redirected, sent, w, surfaceW); return; }
          if (!rawSurf) return;
          const key = normSurface(rawSurf);
          if (occ.has(key)) touch(key, sent, w, surfaceW);
        };
        touchFromSurface(ev.s, ev.sHint);
        touchFromSurface(ev.o, ev.oHint);
      } else if (ev.op === 'DEF') {
        // A gender DEF born from a pronoun binding is inferred — discount it.
        const wDef = ev.src === 'pronoun-binding' ? ANAPHORA_W() : 1;
        const surfaceWDef = ev.src === 'pronoun-binding' ? 0 : wDef;
        const redirected = hintToKey(ev.targetHint);
        if (redirected) {
          touch(redirected, sent, wDef, surfaceWDef);
        } else if (ev.target) {
          const key = normSurface(ev.target);
          if (occ.has(key)) touch(key, sent, wDef, surfaceWDef);
        }
      } else if (ev.op === 'SIG') {
        // Speech attributed via a pronoun ("he said") is inferred presence;
        // attributed via a name ("Tomas said") is an observation.
        const wSig = isPronoun(ev.speaker) ? ANAPHORA_W() : 1;
        const surfaceWSig = isPronoun(ev.speaker) ? 0 : wSig;
        const redirected = hintToKey(ev.speakerHint);
        if (redirected) {
          touch(redirected, sent, wSig, surfaceWSig);
        } else if (ev.speaker) {
          const key = normSurface(ev.speaker);
          if (occ.has(key)) touch(key, sent, wSig, surfaceWSig);
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
    // A name leading with a personal title is a person — independent of NER,
    // speech, or pronouns ("Mr. Calloway" who never speaks; "Senator Alexander").
    if (ev.op === 'INS' && ev.target && leadsWithTitle(ev.target)) {
      considerType(normSurface(ev.target), 'person');
    }
    // Learned types: speech-induction DEFs and any future type evidence.
    if (ev.op === 'DEF' && ev.path === 'type' && ev.value) {
      considerType(normSurface(ev.target), ev.value);
      if (ev.targetHint && ev.targetHint.key) considerType(ev.targetHint.key, ev.value);
    }
    // A recorded SIG speaker is a person — whatever earned the attribution
    // (a named "X said", a pronoun, or the mass-weighted fallback). This is
    // what types Marlow, who speaks but whose quotes were attributed by
    // fallback rather than a clean "said Marlow", so speech-induction's
    // named-only DEF never fired. A place/org never holds a speaker slot, so
    // this promotes only real voices.
    if (ev.op === 'SIG' && ev.speaker && ev.speaker !== '?') {
      const sk = (ev.speakerHint && ev.speakerHint.key) || normSurface(ev.speaker);
      considerType(sk, 'person');
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

  // Canonical name and key, recomputed deterministically over the FULLY
  // MERGED cluster. The site-layer SYN events each recorded a canonical as
  // the merge fired, but those are order-sensitive — the same pair resolves
  // to different survivors depending on which form hosted the join, so a
  // cluster's name and key used to be chosen by divergent passes and could
  // disagree (a key that wasn't even a sub-phrase of the name). Here every
  // member's sighted forms are pooled and one total order picks the
  // canonical (pickCanonicalDeterministic); the key derives from that same
  // string, so name and key agree by construction. The SYN events keep
  // their recorded canonicals as the audit trail of the live pass.
  for (const cluster of clusterMap.values()) {
    const forms = new Map(), firsts = new Map();
    for (const k of cluster.memberKeys) {
      const o = occ.get(k);
      if (!o) continue;
      if (o.formCounts) for (const [f, n] of o.formCounts) forms.set(f, (forms.get(f) || 0) + n);
      if (o.formFirst) for (const [f, s] of o.formFirst) if (!firsts.has(f) || s < firsts.get(f)) firsts.set(f, s);
    }
    for (const sf of cluster.surfaceForms) if (!forms.has(sf)) forms.set(sf, 1);
    const canonical = pickCanonicalDeterministic(forms, firsts);
    if (canonical) {
      cluster.name = canonical;
      cluster.key = normSurface(canonical);
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
          surfaceMass: final.surfaceMass != null ? final.surfaceMass : null,
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
    // The union-find root is the internal handle; the cluster's PUBLIC key
    // derives from its canonical name, so resolve root → cluster → key.
    if (parent.has(k)) {
      const cl = clusterMap.get(find(k));
      return cl ? cl.key : find(k);
    }
    for (const cl of clusters) {
      if (cl.surfaceForms.has(surf)) return cl.key;
    }
    return null;
  };

  // ── Pass 4: build edges from text-layer SYN and CON events ──
  // CON events are the resolved relations (both endpoints bound to distinct
  // referents); text-layer SYN that resolved also contributes. An edge's
  // weight is the co-occurrence count — the natural projection of CON.
  const edgeMap = new Map();
  for (const ev of events) {
    if (!isRelationEdge(ev)) continue;
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
      // The EO Site (phenomenological address) of the referent. A referent is
      // an existent admitted into being, so it occupies the Existence row;
      // its Time column is read from its name (a specific Entity by default, a
      // Kind if its head is a category noun, a Void if an ambient mass noun).
      // `type` (person/place/org/thing) is the entity SUBTYPE — a rank below
      // the Entity cell, never a site.
      site: eoSite('Existence', c.name, c.type),
      // Gender evidence may live on a titled member form ("Mr. Samsa")
      // rather than on the canonical (the fuller, untitled "Gregor Samsa"),
      // so scan every sighted form before falling back to learned gender.
      // Conflicting-gender forms can't share a cluster (the SYN gender veto),
      // so the first hit is the cluster's.
      gender: genderFromName(c.name) || [...c.surfaceForms].map(f => genderFromName(f)).find(Boolean)
        || c.memberKeys.map(k => learnedGender.get(k)).find(Boolean) || null,
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
        // A drawn relation is a Link (Structure × Figure) — or a Network when
        // its endpoint reads as an architecture noun.
        site: eoSite('Structure', e.bName || e.b, null),
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
     ====================  CLEO ADAPTER  =======================
     Maps the EO graph (events / projectGraph) onto the doc,
     entity, and QA shapes the React UI consumes, and keeps the
     mechanical retrieval / coverage / citation paths.
     ============================================================ */

  /* ---------- document kind ---------- */
  function detectKind(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
    // Timecode cue lines carry a consistent comma each; that's a transcript's
    // typography declaring itself, not a table schema.
    if (lines.length >= 3 && countTimecodeLines(text) < 3) {
      // The most common comma-count across lines, found in ONE linear pass: a
      // CSV's rows share a column count, so a dominant non-zero mode reads as
      // tabular. (The old version found the mode with a sort whose comparator
      // rescanned the whole array on every compare — O(n²), which froze the tab
      // on a big paste. A ≥70% mode is unique, so the outcome is unchanged.)
      const freq = new Map(); let mode = 0, best = -1;
      for (const l of lines) {
        const c = (l.match(/,/g) || []).length;
        const n = (freq.get(c) || 0) + 1; freq.set(c, n);
        if (n > best) { best = n; mode = c; }
      }
      if (mode >= 1 && best / lines.length >= 0.7) return 'table';
    }
    return 'prose';
  }

  /* ---------- CSV table (Cleo's pivot path, not the graph) ---------- */
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
  // Group the flat sentence spine back into display paragraphs. The segmenter
  // already counted the sentences in each paragraph (result.paragraph_counts),
  // so we walk those counts directly — no second compromise pass over the whole
  // document, which on a big file was a synchronous re-parse that froze the tab
  // right after ingest "finished." When the counts are missing (an old result,
  // a non-prose caller) we fall back to re-deriving them with nlp, chunk-safe.
  function rebuildBlocks(text, sentenceTexts, sections, paraCounts) {
    const headingSet = new Set((sections || []).map(s => s.start_sentence));
    const blocks = []; let gi = 0; let titled = false;
    const emit = (count) => {
      const idxs = [];
      for (let k = 0; k < count && gi < sentenceTexts.length; k++) idxs.push(gi++);
      if (!idxs.length) return;
      if (idxs.length === 1 && headingSet.has(idxs[0])) {
        blocks.push({ type: titled ? 'h2' : 'h1', text: sentenceTexts[idxs[0]] });
        titled = true;
      } else {
        blocks.push({ type: 'p', sentences: idxs.map(i => ({ i, t: sentenceTexts[i] })) });
      }
    };
    if (Array.isArray(paraCounts) && paraCounts.length) {
      for (const c of paraCounts) { if (gi >= sentenceTexts.length) break; emit(Math.max(1, c | 0)); }
    } else {
      const norm = String(text).replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
      const paras = norm.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      for (const p of paras) {
        if (gi >= sentenceTexts.length) break;
        let count;
        try { count = (nlp(p).sentences().out('array') || []).filter(s => s.trim()).length || 1; }
        catch (e) { count = 1; }
        emit(count);
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
    // A transcript was normalized inside the extractor (cues and speaker
    // labels became structure); the blocks must mirror the text the reading
    // actually segmented, or sentence indices drift and timecodes leak back.
    const blocks = rebuildBlocks(result.normalized_text || text, sentenceTexts, result.sections, result.paragraph_counts);
    // seq → sentence index, so projected entities can list their mentions
    const seqToSent = new Map();
    for (const ev of (result.events || [])) if (ev.sentence_idx != null) seqToSent.set(ev.seq, ev.sentence_idx);
    const doc = {
      id, kind: 'prose', name,
      meta: sentences.length + ' sentences · ' + (result.genre === 'transcript' ? 'transcript' : 'prose') + ' (' + (result.lang || 'en') + ')',
      blocks, sentences, sentenceTexts,
      _events: result.events || [],
      _sections: result.sections || [],
      _lang: result.lang || 'en',
      _genre: result.genre || null,
      _voices: result.voices || null,
      _chrome: result.chrome || [],
      _seqToSent: seqToSent,
    };
    // Provenance substrate, pure addition (parity holds): hash every sentence
    // into the local span table (h → doc/sentence — anchors resolve on-device,
    // stay opaque off it), note this reading's friction mechanically, and run
    // any pending proposal probes against the fresh source (co-witness). The
    // last two are no-ops in every shipped reading: friction only feeds the
    // proposer, and no signals exist until a model proposes one.
    try {
      registerDocSpans(doc);
      noteDocFriction(doc);
      coWitnessScan(doc);
    } catch (e) { /* the provenance layer never blocks a parse */ }
    // The document-level de-chroming verdict over the chrome gate: a non-
    // destructive record of what was set aside (kept verbatim in the spine and
    // queryable on demand). Pure addition — never an event — so parity holds.
    try { doc._dechrome = computeDechrome(doc); }
    catch (e) { doc._dechrome = { present: false, web: false, count: 0, total_sentences: (doc.sentenceTexts || []).length, removed_chars: 0, by_reason: {}, spans: [], segments: [] }; }
    return doc;
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
    'singular-they': 'singular_they',
    'relation-gate': 'relation_gate',
    'site-entity-cell': 'site_entity_cell',
  };

  /* ---------- Thinking depth: the effort dial's tunable budget ----------
     Depth is not a new pipeline; it is a ceiling and a set of thresholds the
     existing δ/γ/EVA machinery already obeys. One user-facing dial sets a level
     (1 = today's reflex … DEPTH_LEVELS = deepest); thinkingBudget(level) resolves
     it into the concrete per-turn knobs every deeper-thinking path reads.

     Each knob is a RULE (data.jsx RULESETS, group "Thinking depth"), captured
     here from applyRules so it stays tunable/exportable — never a magic number.
     A rule's `value` is its CEILING (the value at the deepest stop); depth scales
     each knob from an inert FLOOR up to that ceiling. The floor is today: at
     level 1 every EFFORT knob resolves to its inert value, so the dial's floor
     is byte-identical to current Cleo and parity holds there. One deliberate
     exception: assertion-check is an HONESTY knob, not an effort knob, and runs
     at every depth (see its note below). */
  const DEPTH_LEVELS = 3;
  const DEPTH_DEFAULTS = {
    'max-seek-rounds':    { value: 4 },     // ceiling on iterative retrieval cycles
    'seek-novelty-floor': { value: 0.15 },  // min new-coverage fraction to justify another round
    'assoc-delta':        { value: 1.6 },   // dominance ratio an embedding link must clear to survive
    'assoc-coupling':     { value: 0.6 },   // how hard the wandering embedder-reader presses
    'wm-heat-floor':      { value: 0.25 },  // heat threshold for "hot" in working memory
    'infer-bind-floor':   { value: 0.62 },  // closeness needed to phrase an inference across spans
    'replan-enabled':     { value: 1 },     // may a turn reconsider its own plan (deepest only)
    'graph-walk-hops':    { value: 2 },     // ceiling on graph-traversal hops from the question's entry nodes
    'assertion-check':    { value: 1 },     // may a draft be audited against the page's DEF assertions (every depth — the floor of "grounded")
  };
  // Current tunable state, id → { value, enabled }. Filled by applyRules; defaults
  // to the ceilings + enabled so a host that never calls applyRules (the Node test
  // harness) still gets a coherent budget — and thinkingBudget(1) stays inert.
  const _depth = {};
  for (const k in DEPTH_DEFAULTS) _depth[k] = { value: DEPTH_DEFAULTS[k].value, enabled: true };

  // Resolve a depth level into the per-turn budget. At level 1 every field is the
  // inert/today value (1 seek round, no wander, no replan, nothing carried hot);
  // higher levels scale each enabled knob toward its rule ceiling.
  function thinkingBudget(level) {
    const max = DEPTH_LEVELS;
    let L = (level | 0) || 1; if (L < 1) L = 1; if (L > max) L = max;
    const frac = max > 1 ? (L - 1) / (max - 1) : 0;        // 0 at floor, 1 at deepest
    const st = (id) => _depth[id] || { value: (DEPTH_DEFAULTS[id] || {}).value, enabled: !!DEPTH_DEFAULTS[id] };
    const on = (id) => L > 1 && !!DEPTH_DEFAULTS[id] && st(id).enabled !== false;
    const ceil = (id) => { const v = st(id).value; return v != null ? Number(v) : DEPTH_DEFAULTS[id].value; };
    return {
      level: L, levels: max,
      // iterative seeking: 1 (today) → ceil rounds, scaled by depth
      maxSeekRounds: on('max-seek-rounds') ? Math.max(1, Math.round(1 + frac * (ceil('max-seek-rounds') - 1))) : 1,
      seekNoveltyFloor: on('seek-novelty-floor') ? ceil('seek-novelty-floor') : 1,
      // associative wander: no neighbor survives (δ=∞) and the reader doesn't press (coupling 0) at floor
      assocDelta: on('assoc-delta') ? ceil('assoc-delta') : Infinity,
      assocCoupling: on('assoc-coupling') ? +(frac * ceil('assoc-coupling')).toFixed(3) : 0,
      // working memory: nothing is hot at floor (∞ heat floor ⇒ empty hot/warm)
      wmHeatFloor: on('wm-heat-floor') ? ceil('wm-heat-floor') : Infinity,
      // inference void: never infer at floor
      inferBindFloor: on('infer-bind-floor') ? ceil('infer-bind-floor') : Infinity,
      // reconsideration: only at the deepest stop
      replan: !!(on('replan-enabled') && L >= max),
      // graph traversal: depth buys GRAPH work, not just more retrieval — no
      // walk at the floor, one hop mid-dial, the full ceiling at the deepest
      graphHops: on('graph-walk-hops') ? Math.max(0, Math.round(frac * ceil('graph-walk-hops'))) : 0,
      // the propositional veto (draft vs the page's own DEF assertions):
      // claim-against-claim audit. PROMOTED out from behind the dial — checking
      // a draft against the page's recorded assertions is not a luxury depth
      // buys, it is the floor of what "grounded" means. A session showed why:
      // the token-existence veto certifies a draft that recombines on-page
      // names into a false proposition, and only this check catches it. Still
      // a rule (disable 'assertion-check' to turn it off); depth no longer
      // gates it — the one deliberate exception to the inert-floor contract.
      assertionCheck: !!(st('assertion-check').enabled !== false && ceil('assertion-check') > 0),
    };
  }

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
    // Depth-governed knobs (the effort dial's thresholds) are rules too, but they
    // gate the chat-phase budget rather than the extractor's physics — capture
    // their tunable state for thinkingBudget() without touching READING_RULES.
    for (const r of uiRules) {
      if (!DEPTH_DEFAULTS[r.id]) continue;
      const off = r.installed === false || r.enabled === false;
      const v = (r.value != null && !isNaN(Number(r.value))) ? Number(r.value) : DEPTH_DEFAULTS[r.id].value;
      _depth[r.id] = { value: v, enabled: !off };
    }
    // Convention Proposals — a first-class toggle like the Propositional Veto;
    // its value is the per-session proposal budget (a rule, tunable).
    for (const r of uiRules) {
      if (r.id !== 'convention-proposals') continue;
      PROPOSER.cfg.enabled = !(r.installed === false || r.enabled === false);
      if (r.value != null && !isNaN(Number(r.value))) PROPOSER.cfg.budget = Math.max(0, Number(r.value) | 0);
    }
    // refresh the snapshot constants so the next parse reads new physics
    GAMMA = READING_RULES.decay_gamma.value;
    DELTA = READING_RULES.inertia_delta.value;
    MASS_WEIGHT = READING_RULES.mass_weight.value;
    RULES_REV = (RULES_REV + 1) >>> 0;   // invalidate the projection cache
    return RULES_REV;
  }
  _reapplyHostRules = applyRules;   // deriveSets re-applies window.EO_RULES through this

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
    // sightings written into an INS's admission basis (gram-mining) are part
    // of the referent's sentence record, not just the depositing sentence
    const basisByRef = new Map();
    for (const ev of doc._events) {
      if (ev.op === 'INS' && ev.referent_id && ev.basis && Array.isArray(ev.basis.sightings)) basisByRef.set(ev.referent_id, ev.basis.sightings);
    }
    // a referent the admission gate retired (SEG single-sighting) never
    // projects: its INS is in the log, answered, but it is not a name
    const retired = new Set(doc._events.filter(ev => ev.op === 'SEG' && ev.src === 'admission-gate').map(ev => ev.referent_id));
    const entities = proj.entities.filter(e => !retired.has(e.referent_id)).map(e => {
      const sents = [...new Set([
        ...(e.eventSeqs || []).map(s => seqToSent.get(s)).filter(x => x != null),
        ...(basisByRef.get(e.referent_id) || []),
      ])].sort((a, b) => a - b);
      const mass = e.physics && e.physics.mass != null ? Math.round(e.physics.mass * 10) / 10 : (e.mentions || sents.length || 1);
      return {
        name: e.name, key: e.key,
        // Carry the type the reader actually inferred. Only an unknown/missing
        // type falls back, and it falls back to 'thing' (a neutral proper noun),
        // never 'person' — coercing every residual capital to a person is what
        // turned places (Cádiz) and OCR section labels (Figure, Note) into people.
        type: (e.type === 'person' || e.type === 'place' || e.type === 'org') ? e.type : 'thing',
        // EO Site (Space × Time): the referent's phenomenological address —
        // the Entity cell by default, Kind/Void if its name reads as a
        // category/ambient noun. `type` above is the entity SUBTYPE, the
        // classification beneath the Entity cell ("Entity / person").
        site: e.site || eoSite('Existence', e.name, e.type),
        raw: e.mentions || sents.length || 1,
        mass, sents,
        // Additive surface for the talker-portrait composer (WI-5): these
        // measurements decide which sentence and which connection to render,
        // and are never shown to the talker.
        momentum:    e.physics && e.physics.momentum != null
                       ? Math.round(e.physics.momentum * 100) / 100 : null,
        surfaceMass: e.physics && e.physics.surfaceMass != null
                       ? Math.round(e.physics.surfaceMass * 10) / 10 : null,
        gender:      e.gender || null,
        referent_id: e.referent_id || null,
        // Every surface the cluster was sighted as — the audit trail for the
        // key ⊂ name contract (the key derives from the canonical, and the
        // canonical is one of these).
        surfaceForms: e.surfaceForms || [],
      };
    }).filter(e => e.sents.length > 0);
    entities.sort((a, b) => b.mass - a.mass || b.raw - a.raw);
    const byType = { person: [], place: [], org: [], thing: [] };
    for (const e of entities.slice(0, 28)) (byType[e.type] || byType.thing).push(e.name);

    const view = { entities, byType };
    _projCache.set(doc, { rev: RULES_REV, view });
    return view;
  }

  /* ---------- the text, whole, as a graph ----------
     Nothing summarized away: every span is a node — lit (it deposited
     marks), chrome (held back by an admitted custom, reason written), or
     dark (read as prose, deposited nothing, reason written) — and every
     span hangs on the referents sighted in it, the bonds and assertions
     it deposited, and the speech it carries. Words are accounted by the
     same lexicon retrieval indexes (indexed + stop + dropped = all).
     Pure projection over the dump; deterministic; no model. */
  function textGraph(doc) {
    const r = ingestionReport(doc);
    if (!r) return null;
    const bySent = (pred) => {
      const m = new Map();
      for (const ev of r.events) {
        if (ev.sentence_idx == null || !pred(ev)) continue;
        if (!m.has(ev.sentence_idx)) m.set(ev.sentence_idx, []);
        m.get(ev.sentence_idx).push(ev);
      }
      return m;
    };
    const bonds = bySent(ev => ev.op === 'CON');
    const asserts = bySent(ev => ev.op === 'DEF' && (ev.path === 'class' || ev.path === 'state' || ev.path === 'role' || ev.path === 'kin'));
    const speech = bySent(ev => ev.op === 'SIG');
    const sightings = new Map();
    for (const e of r.entities) for (const si of (e.sents || [])) {
      if (!sightings.has(si)) sightings.set(si, []);
      sightings.get(si).push(e.name);
    }
    const frames = new Map(r.events.filter(ev => ev.op === 'DEF' && ev.path === 'frame').map(ev => [ev.target, { frame: ev.value, edges: (ev.basis && ev.basis.edges) || 0 }]));
    let lit = 0, chrome = 0, dark = 0;
    const spans = r.spans.map((text, i) => {
      const ps = r.sentences[i] || {};
      const substantive = (ps.events || 0) - ((ps.ops && ps.ops.NUL) || 0);
      const kind = substantive > 0 ? 'lit' : (ps.reason === 'chrome' ? 'chrome' : 'dark');
      if (kind === 'lit') lit++; else if (kind === 'chrome') chrome++; else dark++;
      return {
        i, text, kind, reason: ps.reason || null,
        events: ps.events || 0, ops: ps.ops || {},
        referents: sightings.get(i) || [],
        bonds: (bonds.get(i) || []).map(ev => ({ source: ev.sourceName, relation: ev.relation || ev.v, target: ev.targetName })),
        assertions: (asserts.get(i) || []).map(ev => ({ path: ev.path, target: ev.target, value: ev.value })),
        speech: (speech.get(i) || []).map(ev => ({ speaker: ev.speaker, attributed: ev.attributed })),
        words: ps.words || 0, terms: ps.terms || 0,
      };
    });
    return {
      schema: 'cleo-textgraph/1',
      doc: r.doc, words: r.words,
      coverage: { spans: spans.length, lit, chrome, dark },
      spans,
      referents: r.entities.map(e => ({ name: e.name, type: e.type, mentions: e.mentions, sents: e.sents, frame: (frames.get(e.name) || {}).frame || null, frame_edges: (frames.get(e.name) || {}).edges || 0 })),
      bonds: r.events.filter(ev => ev.op === 'CON').map(ev => ({ source: ev.sourceName, relation: ev.relation || ev.v, target: ev.targetName, s: ev.sentence_idx })),
    };
  }

  /* ---------- EVA: frames meet across documents ----------
     Every admitted referent carries a frame DEF (the hash of its CON
     neighborhood). When a second document names the same referent (fold-
     matched), the frames are compared and the verdict lands as an EVA
     event in the newer document's log: satisfies (same company), extends
     (this reading adds neighbors), contracts (it holds fewer), conflicts
     (different company). Pure over the logs; deterministic; no model. */
  function _frameTable(doc) {
    const out = new Map();   // fold(name) -> { name, frame, edges:Set }
    const events = (doc && doc._events) || [];
    const conByRef = new Map();
    for (const ev of events) {
      if (ev.op !== 'CON' || !ev.source_ref || !ev.target_ref) continue;
      const rel = String(ev.relation || ev.v || '').toLowerCase();
      if (!conByRef.has(ev.source_ref)) conByRef.set(ev.source_ref, new Set());
      if (!conByRef.has(ev.target_ref)) conByRef.set(ev.target_ref, new Set());
      conByRef.get(ev.source_ref).add('>' + rel + '>' + normSurface(ev.targetName || ev.o || ''));
      conByRef.get(ev.target_ref).add('<' + rel + '<' + normSurface(ev.sourceName || ev.s || ''));
    }
    for (const ev of events) {
      if (ev.op !== 'DEF' || ev.path !== 'frame') continue;
      const ref = ev.targetHint && ev.targetHint.referent_id;
      out.set(normSurface(ev.target), { name: ev.target, frame: ev.value, edges: (ref && conByRef.get(ref)) || new Set() });
    }
    return out;
  }
  function evaAcrossDocs(doc, priorDocs) {
    if (!doc || !Array.isArray(doc._events)) return 0;
    const mine = _frameTable(doc);
    if (!mine.size) return 0;
    let seq = doc._events.length ? ((doc._events[doc._events.length - 1].seq || 0) + 1) : 0;
    let fired = 0;
    for (const prior of (priorDocs || [])) {
      if (!prior || prior === doc || !Array.isArray(prior._events)) continue;
      const theirs = _frameTable(prior);
      for (const [key, a] of mine) {
        const b = theirs.get(key);
        if (!b) continue;
        const aInB = [...a.edges].every(x => b.edges.has(x));
        const bInA = [...b.edges].every(x => a.edges.has(x));
        const verdict = (aInB && bInA) ? 'satisfies' : (bInA ? 'extends' : (aInB ? 'contracts' : 'conflicts'));
        doc._events.push({
          id: 'ev-' + seq, seq: seq++, op: 'EVA', stance: 'Tracing',
          target: a.name, path: 'frame',
          value: { mine: a.frame, theirs: b.frame, other_doc: (prior.id != null ? prior.id : null), verdict },
          basis: { shared_name: key, mine_edges: a.edges.size, their_edges: b.edges.size },
          sentence_idx: null, sentence: null, src: 'frame-meet',
        });
        fired++;
      }
    }
    if (fired) _projCache.delete(doc);
    return fired;
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
  function retrieve(doc, query, k = 6, opts = {}) {
    const qt = new Set(tok(query));
    if (!qt.size) return [];
    const sets = sentTokSets(doc);
    const scored = [];
    const sents = doc.sentences;
    // Adjacent content-token pairs from the query, checked verbatim (and
    // fused — "city cast" also matches "CityCast") against each sentence.
    // A name match is not two independent unigram hits: without the boost a
    // short line sharing one common word ("the city") outranks the long
    // sentence that carries the asked-about name whole, because the score
    // normalizes by candidate length only.
    const qWords = String(query).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
    const qBigrams = [];
    for (let w = 0; w + 1 < qWords.length; w++) {
      const a = qWords[w], b = qWords[w + 1];
      if (a.length >= 3 && b.length >= 3 && !QA_STOP.has(a) && !QA_STOP.has(b)) qBigrams.push([a, b]);
    }
    // The de-chromed view is the default: lines the chrome gate set aside
    // (doc._chrome) stay verbatim in the spine but read as page structure, not
    // prose, so ordinary retrieval scores past them — no more "retrieval grabs
    // page chrome". A turn about the html / the de-chroming itself opts back
    // into the full content with { includeChrome: true }; that flag is the only
    // place the stripped band is queried against. A doc with no chrome scores
    // exactly as before (chromeSet is null), so golden parity holds.
    const chromeSet = (!opts.includeChrome && doc && doc._chrome && doc._chrome.length) ? new Set(doc._chrome) : null;
    for (let n = 0; n < sents.length; n++) {
      if (chromeSet && chromeSet.has(sents[n].i)) continue;
      const st = sets[n];
      let overlap = 0; for (const t of qt) if (st.has(t)) overlap++;
      let phrase = 0;
      if (qBigrams.length) {
        const lc = sents[n].t.toLowerCase();
        for (const [a, b] of qBigrams) if (lc.includes(a + ' ' + b) || lc.includes(a + b)) phrase++;
      }
      if (!overlap && !phrase) continue;
      scored.push({ ...sents[n], score: (overlap + 2 * phrase) / Math.sqrt(st.size + 1), overlap });
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
  // coverage, but it also says WHICH query content-clusters the support leaves
  // uncovered — the gap an iterative-seeking round aims its next sub-query at.
  // Same tokenization as coverage(), so n/d agree; the split is the addition.
  function coverageGaps(query, supportText) {
    const qt = [...new Set(tok(query))];
    const st = new Set(tok(supportText));
    const covered = [], uncovered = [];
    for (const t of qt) (st.has(t) ? covered : uncovered).push(t);
    return { n: covered.length, d: qt.length || 1, covered, uncovered };
  }
  // ── The type gate (DEF): the fourth NUL state ────────────────────────────
  // Before the existence layer may ask whether a capitalized token is PRESENT
  // on the page, the significance layer asks what KIND of token it is. A
  // REFERENT is a nominal the page should carry — a name, a thing (Noun /
  // ProperNoun). A STRUCTURAL token (a connective, a discourse adverb) or a
  // PRAGMATIC one (an imperative verb, an interrogative, an interjection, a
  // contraction) is the user's own grammar or the draft's own connective
  // tissue. It is not truth-apt, so it can never be an absent referent — it was
  // never a referent at all. That is the fourth NUL state (present / absent /
  // never-set are the other three): not a missing name, but no name to miss.
  //
  // Returns the set of lowercased, letters-only tokens in `text` that are NOT
  // nominals, classified by SHAPE via compromise's POS in context — never by
  // membership in a word list. "Based" (a verb), "Give" (an imperative), "Sure"
  // (an interjection), "What's" (an interrogative contraction) are caught for
  // what they are DOING in the sentence, with no one having typed them anywhere;
  // enumerating the complement of an infinite set is the pattern this replaces.
  // Empty on any failure (the gate opens — the existence-layer floor holds).
  const NRM_CAP = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}]+/gu, '');
  function nonReferentialCaps(text) {
    const out = new Set();
    let sents;
    try { sents = nlp(String(text == null ? '' : text)).json(); } catch (e) { return out; }
    for (const s of (sents || [])) {
      for (const t of (s.terms || [])) {
        const tags = t.tags || [];
        // A nominal — Noun or ProperNoun, but NOT a Pronoun (pronouns tag
        // Noun,Pronoun) — is the only truth-apt shape, the one candidate
        // referent. Everything else is structure or pragmatics: it cannot be a
        // missing name because it is not a name.
        if ((tags.includes('Noun') || tags.includes('ProperNoun')) && !tags.includes('Pronoun')) continue;
        const w = NRM_CAP(t.text);
        if (w) out.add(w);
      }
    }
    return out;
  }

  // ── Anti-matter referents ───────────────────────────────────────────────
  // A REFERENT is a name the query points at. It has MATTER when the page
  // carries it, and ANTI-MATTER when it doesn't: referenced, but with no
  // presence to bind to. Contact with an anti-matter referent annihilates
  // grounding — it is the ⊥ the void holds on. Consecutive capitals read as one
  // referent ("Amos Dresser"); interrogatives/stopwords (in QA_STOP) are not
  // names; and the type gate (above) drops structural/pragmatic tokens ahead of
  // the presence test, so they never reach antimatter. Returns { matter,
  // antimatter } so a hold can say what it CAN see.
  function referents(doc, query) {
    const body = docBodyLC(doc);
    const names = String(query).match(/\p{Lu}[\p{L}’'\-]+(?:\s+\p{Lu}[\p{L}’'\-]+)*/gu) || [];
    const nonRef = nonReferentialCaps(query);     // DEF: classify before testing presence
    const matter = [], antimatter = [];
    for (const raw of names) {
      // a sentence-initial interrogative ("Did Caesar…") is capitalised but is
      // not part of the name — trim stopwords off both ends before deciding.
      const parts = raw.split(/\s+/);
      while (parts.length && QA_STOP.has(parts[0].toLowerCase())) parts.shift();
      while (parts.length && QA_STOP.has(parts[parts.length - 1].toLowerCase())) parts.pop();
      const sig = parts.filter(t => t.length > 2 && !QA_STOP.has(t.toLowerCase()));
      if (!sig.length) continue;
      // The fourth NUL state: keep only the truth-apt (referential) tokens. A
      // sentence-initial "Give" / "Based" / "Sure" / "What's" is dropped here,
      // so it can never become antimatter and annihilate the turn. By shape,
      // not by a stop-list — the gate generalizes where enumeration cannot.
      const refSig = sig.filter(t => !nonRef.has(NRM_CAP(t)));
      if (!refSig.length) continue;
      (refSig.some(t => body.includes(t.toLowerCase())) ? matter : antimatter).push(parts.join(' '));
    }
    return { matter, antimatter };
  }
  // the first anti-matter referent (or null) — what the void holds on
  function voidTerm(doc, query) { return referents(doc, query).antimatter[0] || null; }
  function inventedTerms(doc, text) {
    const body = docBodyLC(doc);
    const caps = String(text).match(/\b\p{Lu}[\p{L}’'-]+/gu) || [];
    const nonRef = nonReferentialCaps(text);      // DEF: the type gate (shape, not a list)
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
      // The fourth NUL state: a capitalized token the parser reads as a verb,
      // adverb, conjunction, interrogative or interjection (not a nominal) is the
      // draft's own connective tissue or the user's grammar — never a name the
      // page must contain, so never struck as invented. Caught by shape, so a
      // sentence-initial "Based" / "Therefore" / "Sure" needs no list entry.
      // (DISCOURSE_JUNK / ANSWER_DISCOURSE remain as a back-compat floor; the
      // gate subsumes them.)
      if (DISCOURSE_JUNK.has(lc) || ANSWER_DISCOURSE.has(lc) || nonRef.has(NRM_CAP(bare))) continue;
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

  /* Phase 4: the inference void — the {{void}} mechanism inverted. Where {{void}}
     marks what the page LACKED, {{infer}} marks what the READER ADDED: a claim the
     answer phrased by connecting two cited spans the page never connects (an
     associative link from Phase 3 that cleared infer_bind_floor). Given a bound
     answer (carrying {{cite:docId:idx:sN}} markers) and candidate pairs {docId,a,b},
     for each pair whose BOTH ends are cited it rewrites the citation to the
     inferred-to span `b` into {{infer:docId:a+b:sA+sB}} — the third epistemic
     status, between grounded and held. Returns the marked text and which pairs
     were actually marked. A pair with only one end cited is not an inference. */
  function markInferred(text, pairs) {
    let out = String(text == null ? '' : text);
    const marked = [];
    for (const p of (pairs || [])) {
      if (!p || p.a == null || p.b == null) continue;
      const docId = p.docId || '';
      if (!out.includes(`{{cite:${docId}:${p.a}:`) || !out.includes(`{{cite:${docId}:${p.b}:`)) continue;
      const reB = new RegExp('\\{\\{cite:' + escRe(docId) + ':' + p.b + ':[^}]*\\}\\}');
      const next = out.replace(reB, `{{infer:${docId}:${p.a}+${p.b}:s${p.a}+s${p.b}}}`);
      if (next !== out) { out = next; marked.push({ docId, a: p.a, b: p.b }); }
    }
    return { text: out, inferred: marked };
  }

  // Phase 5: does a draft read as a refusal / non-answer? Used by reconsideration
  // to SEG a turn's plan after drafting — a refused summary re-routes to creative
  // rather than recycling the refusal. Empty/near-empty counts as a refusal.
  function looksRefused(text) {
    const t = String(text == null ? '' : text).toLowerCase().trim();
    if (t.length < 3) return true;
    return /\b(i (cannot|can ?not|can'?t|am unable to|won'?t|am not able)|i'?m sorry,? but|i'?m unable|unable to (provide|summari|comply|help|do)|as an ai|i do(n'?t| not) have (enough|the|access)|cannot (provide|create|write|generate)|can'?t (provide|create|write|generate))\b/.test(t);
  }
  // Leaked chain-of-thought, hard-failed at the veto. The llm layer already
  // strips tagged `<think>` blocks from the stream and the returned text;
  // this catches what tagging can't — an answer that IS the reasoning
  // (truncated mid-think, or an untagged preamble like "Okay, the user
  // wants…"). Narrow on purpose: only the signatures reasoning models
  // actually emit, so a legitimate answer starting "Okay," never trips it.
  function looksLeakedReasoning(text) {
    const s = String(text == null ? '' : text);
    if (/<\/?think/i.test(s)) return true;
    const t = s.trim();
    return /^(?:okay|alright)[,.!]?\s+(?:so\s+)?the user\b/i.test(t)
      || /^let me think\b/i.test(t)
      || /^first,?\s+i need to\b/i.test(t)
      || /^the user (?:wants|is asking|asked)\b/i.test(t);
  }

  /* ============================================================ INTENT */
  function classifyIntent(q) {
    const t = ' ' + String(q).toLowerCase().replace(/[’']/g, "'") + ' ';
    // A turn that JUDGES or selects a single cast member — "who is the FUNNIEST
    // character", "which figure is the smartest", "the most interesting person"
    // — is not a request to enumerate the cast. answerWho only counts mentions;
    // it cannot weigh "funniest", so returning the ranked cast-list as if it had
    // is confidently off-topic (the worst kind of wrong answer). A superlative
    // resting on a cast noun routes the turn to the model (factual), never 'who'.
    if (!judgesCastMember(t) &&
        /\b(who(\s+all)?\s+(appears?|is in|are in|shows? up|features?)|who are the|characters?|the cast|people (in|who)|list (the )?(people|characters|names|figures)|main characters?|dramatis|everyone (in|who))\b/.test(t)) return 'who';
    // "what's the book about?" is a whole-document overview, but the older
    // "what's (it|this) about" branch only caught the pronoun forms — "the book"
    // fell through to factual and retrieved a single line that merely shared the
    // word "book" ("I slipped the book into my pocket"). Catch the noun forms too.
    if (/\b(summar|overview|tl;?dr|gist|recap|in short|main (idea|point|points|theme)|what'?s (it|this)( about)?|what is (this|it|the document|the text|the story|the file)|what(?:'?s| is) (?:the|this) (?:book|story|novel|novella|tale|memoir|document|text|file|piece|poem|play|essay|article|report|paper|thing|whole thing) about|describe (this|the|it)|the document about|what kind of (document|text)|what am i (looking at|reading))/.test(t)) return 'summary';
    // "what happens to NAME?" names a specific referent — a factual ask about
    // NAME, not a whole-document overview; without the guard the summary path
    // hands the model passages sampled with no knowledge of NAME. The guard
    // reads the ORIGINAL casing (t is lowered): a capitalized target after
    // happens-to/with is a name. "what happens?" / "what happens in the story"
    // still summarize.
    if (/\b(what happens|what'?s going on|the plot|the story|main events|what is happening|walk me through|what'?s in (this|it))/.test(t)
        && !/\bhappens?\s+(?:to|with)\s+["“]?\p{Lu}/u.test(String(q))) return 'summary';
    // Generative whole-document asks — "write a report about this", "write an
    // essay", "give me a rundown", "write it up". These name no specific passage,
    // so the factual path retrieves a single lexically-overlapping line and the
    // model just parrots it. Route them to the same salient-sample summary path
    // the interrogative overviews above use.
    if (/\b(write|draft|compose|put together|give me|make me|prepare|generate|create)\b[^?!.]*\b(report|essay|summary|overview|synopsis|recap|rundown|write[\s-]?up|breakdown)\b/.test(t)) return 'summary';
    if (/\b(write|report|essay|tell me|talk to me)\b[^?!.]*\babout\s+(this|the\s+(document|text|story|file|piece|passage|reading|script|screenplay|book))\b/.test(t)) return 'summary';
    // COMMAND — a verb-led imperative for the assistant to PERFORM an action
    // outside the page ("search for dogs", "google X", "websearch X", "look up
    // X"). These are not questions about the source; treating them as such
    // lets a content noun shared with an open document drag them onto the
    // page via lexical/entity coincidence (the trace's "search for dogs"
    // matched the "dogs" entity in a Cadaver-dogs article and was answered as
    // a grounded read). Conservative by design: anchored at the head of the
    // turn (with optional polite hedging), and the object must not point
    // INSIDE the document ("look up X in the text" stays factual so a real
    // doc-internal lookup can't be miscategorised). Independent of
    // EOExternal.acquireIntent, which is broader (definitional "tell me about
    // <ProperName>" frames also acquire); 'command' is the narrower set —
    // unambiguous, action-directed verbs only.
    if (/^\s*(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:search|google|web\s*-?\s*search|websearch|look\s*up|lookup)(?:\s+(?:for|up))?\s+\S/.test(t)
        && !/\bin\s+(?:the|this)\s+(?:doc(?:ument)?|text|passage|file|story|book|article|chapter|page|paragraph|line|sentence|reading|script|screenplay)\b/.test(t))
      return 'command';
    // CONFIRM/DENY — the turn proposes a proposition and asks the reading to
    // check it ("Is Amos Dresser the white minister…?", "he's not a speaker",
    // "you said he was a speaker"). The operator-void, made an intent: these
    // used to misfile as content questions, and the grounded-QA frame mangles
    // an assertion presented as a question — the model resolves the confusion
    // by quoting the user back as if THEY were the passage. Mechanically
    // answerable against the graph (DEF assertions, SIG attribution slots).
    if (/\byou\s+(said|told|claimed|mentioned|wrote|implied)\b/.test(t)) return 'confirm';
    if (/^\s*(so|but|and|no|yes)?,?\s*(it\s+)?(sounds?|seems?|looks?)\s+like\b/.test(t)) return 'confirm';
    if (/[,;—–-]\s*(right|correct|true|no|yes)\s*\?+\s*$/.test(t)) return 'confirm';
    if (/\b(is|was|are|were)\s+that\s+(who|what|right|correct|true)\b/.test(t)) return 'confirm';
    if (/^\s*(is|was|are|were|isn'?t|wasn'?t|aren'?t|weren'?t)\b[^?]*\?/.test(t)) return 'confirm';
    if (declarativeProposition(q)) return 'confirm';
    return 'factual';
  }
  // A superlative resting on a cast noun — "funniest character", "most
  // interesting figure", "which character is the smartest". The superlative
  // must sit ADJACENT to the noun (an article / "most" / "least" may come
  // between), so a plain enumeration that merely happens to contain an "-est"
  // word elsewhere ("list the characters in the forest") is left as a 'who'.
  // Keeps judgment questions off the mechanical, model-free cast-list path.
  function judgesCastMember(t) {
    const cast = '(?:characters?|figures?|persons?|people|protagonists?|antagonists?|villains?|heroe?s?|heroines?)';
    const sup  = '(?:[a-z]+est|most\\s+[a-z]+|least\\s+[a-z]+|best|worst|favou?rite)';
    // superlative directly before the noun: "the funniest character"
    if (new RegExp('\\b' + sup + '\\s+(?:the\\s+)?' + cast + '\\b').test(t)) return true;
    // noun, copula, superlative: "which character is the funniest"
    if (new RegExp('\\b' + cast + '\\b\\s+(?:is|are|was|were|seems?|feels?)\\s+(?:the\\s+|most\\s+|least\\s+)?' + sup + '\\b').test(t)) return true;
    return false;
  }
  // A bare copular declarative offered for checking ("He is dead. He was not a
  // speaker."): every sentence leads with a pronoun or a Name and a copula, and
  // none is a question or names a wh-word. The shape of a proposition, not of
  // a request — case matters ("The keeper was…" is prose, "Edith was…" is a
  // claim about Edith), so this reads the original, unlowered turn.
  function declarativeProposition(q) {
    const s = String(q == null ? '' : q).trim();
    if (!s || /\?/.test(s)) return false;
    const parts = splitDraft(s).map(p => p.trim()).filter(Boolean);
    if (!parts.length) return false;
    // EVERY clause must parse as a checkable proposition — copular ("Edith was
    // the keeper"), article-led ("The treaty was signed in 1776"), OR
    // verb-predicate ("Mara Velasquez founded Veldmar", "Shakespeare wrote
    // Hamlet"). Delegating to parseProposition keeps the router and the checker
    // in lockstep: anything classifyIntent sends to 'confirm' is something
    // answerConfirm can actually check, so a transitive-verb or article-led
    // assertion can never slip through to the grounded-QA path and be stamped
    // "grounded" on retrieval coverage rather than truth. A demonstrative or
    // wh-led clause ("That is wrong", "Which one…") is conversation, not a claim.
    return parts.every(p =>
      !/^(?:What|Which|Whose|Where|When|Why|How|Who|That|This|There)\b/.test(p)
      && parseProposition(p) != null);
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
  /* ---------- conversational repair ----------
     A turn about the EXCHANGE, not the page: the user pushing back on the
     previous reply. Three shapes:
       frustration   — pure meta-talk ("you're not listening", "that's not
                       what I asked"); carries no content of its own.
       contradiction — flatly disputing the previous reply ("yeah it does",
                       "no it doesn't", "it's right there").
       refinement    — a correction that carries content ("no, the son of
                       someone involved with NDP", "I mean the garage fire"),
                       or an insistence that the page contains something
                       ("someone's son is mentioned").
     The router consults this FIRST for factual turns (and only when the
     conversation context says something has been said): a repair turn fed to
     lexical retrieval re-serves the failure the user is objecting to — the
     observed trace answered "you're not listening to what i'm saying" with a
     parking-garage line and a citation chip. Mechanical and cheap; inert for
     batch callers that pass no conversation context. */
  function repairSignal(q) {
    const raw = String(q == null ? '' : q).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    const t = ' ' + raw + ' ';
    // FRUSTRATION — about the conversation itself.
    if (/\b(?:you'?re? (?:not|n'?t) (?:listening|hearing|getting|reading|understanding)|you are not (?:listening|hearing|getting|reading|understanding)|not what i asked|not what i'?m asking|not what i (?:said|meant|mean)|that'?s not what i|you'?re? missing (?:the|my) point|you keep (?:saying|repeating|giving|missing)|listen to (?:me|what i)|read (?:it|that|my (?:question|message)) again|are you (?:even )?(?:listening|reading)|i'?m getting (?:annoyed|frustrated|nowhere)|this is (?:useless|pointless|frustrating|annoying|not working)|wtf|ffs)\b/.test(t)
        || /^\s*(?:ugh|come on|seriously)\W*$/.test(raw))
      return { kind: 'frustration', content: false };
    // NON-UNDERSTANDING / NON-ANSWER — the previous REPLY didn't land: the user
    // can't parse it, or it dodged the ask. Still about the exchange, so it must
    // not be dragged onto the page by the shared word ("i don't understand your
    // answer" was answered with three unrelated lines that merely contained
    // "understand"). Anchored to the reply — bare, or "it/that/this/you/your
    // answer/what you said" — so a genuine content ask ("i don't understand the
    // ending") still routes to the text.
    if (/^(?:but |so |sorry,? |wait,? |um,? |uh,? )?i (?:do|did)?\s*n'?t (?:understand|get|follow|parse|see)(?: it| that| this| you| your (?:answer|reply|response|point)| what you (?:said|mean|meant|wrote)| the (?:answer|reply|response|point)| any of (?:it|that|this))?[.!? ]*$/.test(raw)
        || /^(?:but |so )?i'?m (?:confused|lost|not following)[.!? ]*$/.test(raw)
        || /\b(?:that|this|it|none of (?:this|that|it)|your (?:answer|reply|response))\s+(?:does|did)?\s*n'?t make (?:any )?sense\b/.test(t)
        || /\bmakes no sense\b/.test(t)
        || /^(?:but |so |wait,? )?what (?:do|did) you mean(?: by that)?[.!? ]*$/.test(raw)
        || /^(?:but |so )?what (?:are|were) you (?:talking|going on) about[.!? ]*$/.test(raw)
        || /\b(?:that'?s|this is) (?:not (?:an?|a real|really an) answer|no answer|not answering)\b/.test(t)
        || /\b(?:that|this|you)\s+(?:does|did)?\s*n'?t (?:actually |even )?answer (?:my|the|that|anything)\b/.test(t)
        || /\byou (?:do|did)?\s*n'?t (?:actually |even )?answer(?:ed)?(?: (?:my|the|that))?\b/.test(t)
        || /\byou'?re not (?:really )?answering\b/.test(t)
        || /\b(?:that'?s|this is|it'?s) (?:just )?(?:gibberish|nonsense|word salad|incoherent|confusing|meaningless|garbled|nonsensical)\b/.test(t)
        || /^(?:huh|wat|come again|i'?m sorry,? what)\s*\?*$/.test(raw))
      return { kind: 'frustration', content: false };
    // OUTPUT-FORM / META — the user is objecting to HOW the reply came out, not
    // asking about the page: the answer pass failed to bind, the turn fell to the
    // mechanical span-dump, and the user is now pushing back on THAT ("why did you
    // switch to direct quotes", "you're just quoting the book", "stop pasting
    // lines", "those are just random lines, not an answer"). Anchored to the
    // assistant ("you") doing the quoting/pasting, or to the reply's shape named
    // as not-an-answer — so a content ask that merely contains "quote/line" ("can
    // you quote the part about ivory", "what lines does Kurtz speak") still
    // reaches the text. Fed to lexical retrieval the complaint lands on whatever
    // shares "quote/line/answer" with it — the very failure being objected to,
    // re-served (the observed trace answered "why did you switch to direct
    // quotes…" with three more unrelated quotes).
    if (/\byou(?:'?re| are| keep| keeps| just| only| simply| merely| again| now)\b[^?]*\b(?:quot|past|copy|regurgitat|repeat|spit)/.test(t)
        || /\b(?:why|how come)\b[^?]*\byou\b[^?]*\b(?:switch|chang|revert|default|jump|resort|go(?:ing)? back|back to|just)\b[^?]*\b(?:quot|past|line|copy|verbatim|fragment|snippet)/.test(t)
        || /\bi (?:saw|see|noticed|can see|watched) you\b[^?]*\b(?:switch|try|trying|answer|quot|past|copy)/.test(t)
        || /\b(?:stop|quit|enough (?:of|with)|cut out)\b[^?]*\b(?:quot|past|copy|the lines?|giving me (?:quotes|lines)|the random)/.test(t)
        || /\b(?:those|these|that'?s|this is|it'?s|they'?re)\b[^?]*\b(?:just |only |random |disconnected )*(?:quotes?|lines?|fragments?|sentences?|snippets?)\b[^?]*\b(?:not (?:an?|a real|really an)? ?answer|aren'?t (?:an )?answer|isn'?t (?:an )?answer|don'?t (?:answer|help|make sense)|doesn'?t (?:answer|help|make sense))/.test(t))
      return { kind: 'frustration', content: false };
    // IMPATIENCE / PROMPTING — a contentless nudge to get on with it ("well?",
    // "so?", "go on", "just answer the question"). It carries nothing to retrieve,
    // but the filler word peppers any prose ("well" → "Very well." / "Well, I
    // do." / "‘Well, and you?’"), so lexical retrieval drags it onto the page and
    // the mechanical answer badges the filler quotes CLEAN (covers 1/1). Matched
    // only as the WHOLE utterance, so "well, who is Kurtz?" still reaches the text.
    if (/^(?:well|so|and|and then|and so|go on|go ahead|keep going|carry on|continue|proceed|answer me|just answer(?: me| it| this| that| the question)?|answer the question|out with it|spit it out|come on then|i'?m waiting)\s*[?!.…]*$/.test(raw))
      return { kind: 'frustration', content: false };
    // SUPPORT / EVIDENCE — the user takes the previous reply seriously enough to
    // ask what in the text BACKS it ("what parts gave you that impression", "what
    // makes you say that", "where does it say that", "how do you know"). The
    // phrasing is anaphoric to the prior claim ("that/this/so/you"), so it carries
    // no retrievable content of its own — fed to lexical retrieval it lands on
    // whatever shares a word with the complaint ("what parts gave you that
    // impression specifically?" was answered with three lines containing "gave").
    // Routed to repair so the re-read happens on the SUBSTANCE of the reply, not
    // on the question about it; content:false because the probe is rebuilt from
    // the reply. Anaphors that could open a content clause ("where does it say
    // that <X>") are kept terminal so a real lookup still reaches the page.
    if (/\bwhat (?:parts?|passages?|lines?|bits?|sections?|evidence|in the text)\b[^?]*\b(?:gave|made|make|makes|led|lead|leads) you\b/.test(t)
        || /\bwhat (?:makes?|made) you (?:say|think|believe|conclude|feel|so sure)\b/.test(t)
        || /\bwhere does it (?:actually |even )?say (?:that|this|so)\s*[.!?]*$/.test(raw)
        || /\bwhere(?:'?s| is) (?:that|this) (?:in the (?:text|book|document|story)|said|written|stated|mentioned|coming from)\b/.test(t)
        || /\bhow (?:do|did|would|can) you know (?:that|this)?\s*[.!?]*$/.test(raw)
        || /\b(?:what(?:'?s| is) (?:that|this|it|your) (?:based on|evidence|basis|source|reasoning)|based on what|on what basis)\b/.test(t)
        || /\b(?:why|how) (?:do|did) you (?:say|think|conclude|figure|reckon) (?:that|so|this)\b/.test(t)
        || /^says? who\s*\??$/.test(raw))
      return { kind: 'support', content: false };
    // CONTRADICTION — disputing the previous reply, with nothing new to add.
    if (/^(?:no|yes|yeah|yep|nope|nah|wrong|incorrect)[,!. ]*(?:(?:it|that|there|the (?:page|document|doc|text|article)) (?:does|did|do|is|was|are|were|can|could)(?:n'?t| not)?)?[.! ]*$/.test(raw)
        || /^(?:it|that|there)('s| is| does| did| was)? (?:right there|in there|literally (?:says|there)|mentioned)[.! ]*$/.test(raw))
      return { kind: 'contradiction', content: false };
    // REFINEMENT — a correction carrying its own content. A leading bare "no"
    // (not "no one/nobody/nothing") re-aims the previous question.
    if (/^no\b(?!\s*(?:one|body|thing|where)\b)[\s,—–-]/.test(raw) && tok(raw).length >= 1)
      return { kind: 'refinement', content: true };
    if (/^(?:not that\b|i mean[t]?\b|i'?m (?:saying|asking|talking about)\b|i (?:said|asked)\b|i was asking\b)/.test(raw))
      return { kind: 'refinement', content: true };
    // INSISTENCE — asserting the page contains something the replies deny.
    if (/\b(?:is|are|was|were)\s+(?:mentioned|in (?:there|the (?:text|document|doc|page|article)))\b/.test(t) && !/\?/.test(raw))
      return { kind: 'refinement', content: true };
    return null;
  }
  // The discriminating content terms of a prior REPLY, for a SUPPORT/EVIDENCE
  // repair ("what makes you say that?") — the probe that re-reads the page for
  // what BACKS the reply, since the question itself is anaphoric and carries
  // nothing to retrieve on. Markup and void terms are stripped; the document's
  // own bibliographic apparatus (its title/author/credits tokens) and generic
  // book-words are removed, because those match the title-page chrome and pull
  // retrieval onto the header instead of the substance — a reseed that kept
  // "book heart darkness joseph conrad" landed on the Gutenberg boilerplate, not
  // the passages about the ivory and the Company. Returns up to `max` terms.
  const BIBLIO_STOP = new Set(('book books novel novella story stories tale tales text texts '
    + 'document documents file page pages chapter chapters author authors title titled ebook '
    + 'gutenberg poem play essay article work works writer writing read reading prose '
    + 'protagonist character characters narrator theme themes plot setting').split(/\s+/));
  function supportProbeTerms(docs, replyText, max = 20) {
    const reply = String(replyText == null ? '' : replyText).replace(/\{\{[^}]*\}\}/g, ' ');
    const drop = new Set(BIBLIO_STOP);
    for (const d of scopeDocs(docs)) {
      if (!d || d.kind === 'table') continue;
      const meta = docMetadata(d);
      for (const v of Object.values(meta.fields || {})) for (const tk of tok(v)) drop.add(tk);
    }
    const out = [];
    for (const tk of tok(reply)) { if (drop.has(tk) || out.includes(tk)) continue; out.push(tk); if (out.length >= max) break; }
    return out;
  }
  /* Across-turn repetition guard: does a draft repeat a reply already sent?
     The within-answer twin of dedupeSentences. Normalizes away cite/void
     markup, case and punctuation; equality or ≥90% containment is an echo.
     A conversation partner who re-serves the same failed sentence after an
     objection isn't answering — the caller must vary or say it's stuck. */
  const _replyKey = (s) => String(s == null ? '' : s)
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function echoesPriorReply(draft, priorTexts) {
    const d = _replyKey(draft);
    if (!d || d.length < 12) return false;
    for (const p of (Array.isArray(priorTexts) ? priorTexts : [])) {
      const k = _replyKey(p);
      if (!k || k.length < 12) continue;
      if (k === d) return true;
      if ((k.includes(d) || d.includes(k))
          && Math.min(d.length, k.length) / Math.max(d.length, k.length) >= 0.9) return true;
    }
    return false;
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
  function salientContext(doc, query) {
    // Title-page chrome — "Heart of Darkness", "by Joseph Conrad", "Contents",
    // "I  II  III" — is short and carries no terminal punctuation. It costs
    // passage slots the model should spend on prose; skip it in the picks.
    // (Falls back to unfiltered picks if the filter would empty them.)
    const isChrome = (i) => {
      const s = String(doc.sentenceTexts[i] == null ? '' : doc.sentenceTexts[i]).trim();
      return s.length < 60 && !/[.!?…"”'’)]$/.test(s);
    };
    const picks = new Set();
    const add = (i) => { if (!isChrome(i)) picks.add(i); };
    for (const b of doc.blocks) if (b.type === 'p' && b.sentences.length) add(b.sentences[0].i);
    [0, 1, 2].forEach(i => doc.sentences[i] && add(doc.sentences[i].i));
    const n = doc.sentences.length; [n - 1, n - 2].forEach(i => i >= 0 && doc.sentences[i] && add(doc.sentences[i].i));
    if (!picks.size) {
      for (const b of doc.blocks) if (b.type === 'p' && b.sentences.length) picks.add(b.sentences[0].i);
      [0, 1, 2].forEach(i => doc.sentences[i] && picks.add(doc.sentences[i].i));
    }
    // Lead with the FOLD in the reader's voice — the integral fold of the whole
    // document, or, when the turn scoped to a chapter ("summarize chapter 1"),
    // the cumulative fold up to that chapter's end. The model composes from what
    // the reading accumulated rather than echoing a span; the raw spans follow
    // as evidence. Falls back to the structural portrait when no fold forms.
    const f = foldForQuery(doc, query);
    let head = '';
    if (f && f.text) {
      head = (f.scope === 'section'
        ? `The document up to ${f.label}: ${f.text}`
        : `What the whole document is about: ${f.text}`) + '\n\n';
    } else {
      const p = graphPortrait(doc);
      head = p && p.heavy.length
        ? 'What the reading came to rest on: ' + p.heavy.map(e => e.name).join(', ')
          + (p.assertions.length ? '. It took ' + p.assertions.map(a => `${a.name} to be ${a.is}`).join(', ') : '')
          + (p.spine.length > 1 ? '. It moved through: ' + p.spine.join(' → ') : '') + '.\n\n'
        : '';
    }
    const spans = [...picks].sort((a, b) => a - b).slice(0, 16).map(i => `[s${i}] ${doc.sentenceTexts[i]}`).join('\n');
    return head + spans;
  }
  // The cast, cleaned for presentation. On a Gutenberg text (and only
  // there): boilerplate names drop (the gutenberg_boilerplate convention —
  // "Project Gutenberg", "Posting Date"…, plus anything carrying
  // "gutenberg"), and a name living ONLY in the header (first 5%) or
  // license tail (last 10%) is apparatus, not a character. On any other
  // document this is projectEntities unchanged — a company named
  // Foundation stays a referent.
  function castEntities(doc) {
    const { entities } = projectEntities(doc);
    const meta = docMetadata(doc);
    if (!meta.isGutenberg) return entities;
    const nSents = (doc.sentenceTexts || []).length || 1;
    const lo = Math.ceil(nSents * 0.05), hi = Math.floor(nSents * 0.9);
    return entities.filter(e => {
      const nm = String(e.name).toLowerCase().trim();
      if (nm.includes('gutenberg') || (GUTENBERG_BOILERPLATE && GUTENBERG_BOILERPLATE.has(nm))) return false;
      const ss = e.sents || [];
      if (ss.length && ss.every(i => i < lo || i > hi)) return false;
      return true;
    });
  }
  function entityContext(doc) {
    const entities = castEntities(doc);
    return entities.slice(0, 10).map(e => `[s${e.sents[0]}] ${doc.sentenceTexts[e.sents[0]]}`).join('\n');
  }
  function hasGround(doc, q) {
    if (!doc || doc.kind !== 'prose') return true;
    if (classifyIntent(q) !== 'factual') return true;
    if (retrieve(doc, q, 6).length > 0 || !!voidTerm(doc, q)) return true;
    // The graph may hold evidence about a named referent that lexical
    // retrieval can't reach (assertions on sentences that never carry the
    // name) — that evidence IS ground.
    try { return entityEvidence(doc, q).length > 0; } catch (e) { return false; }
  }

  /* Does this turn seem to be ABOUT the loaded document? This is the only
     routing the chat needs: a "yes" feeds the model the relevant passages
     and binds citations; a "no" is just conversation, handled by the model
     with the running history and no forced grounding. Kept deliberately
     light — false positives drag chit-chat into the page, false negatives
     just mean the user re-asks more explicitly. */
  // Generic voice-label heads ("Speaker 2", "Interviewer", "Female Voice"). The
  // label is a real voice — it speaks, it holds SIG slots, it earns mass — but
  // its HEAD is a role word, not a name. Without this guard the word "speaker"
  // in a user's message ("but it sounds like he's not a speaker") part-matches
  // the entity "Speaker 2" and hijacks a meta-conversational turn onto the
  // page: one phantom referent corrupting the ROUTER, not just the answer.
  // Only the full label ("speaker 2") matches; part-matching skips these heads.
  // GENERIC_VOICE_HEADS is the generic_voice_heads convention (see rebuildLangSets).
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
      if (parts.length > 1 && parts.some(p => p.length >= 4 && !GENERIC_VOICE_HEADS.has(p) && ql.includes(' ' + p + ' '))) return true;
    }
    return false;
  }
  // Discourse glue for the ellipsis reader below (the followup_glue
  // convention, built in rebuildLangSets): connectives, negation, acknowledgers,
  // light auxiliaries and meta-discourse verbs that carry no topic of their own.
  // Routing-only (like QA_STOP), never identity-bearing. Deliberately EXCLUDES
  // gratitude words ("thanks") so "thanks, that helps" keeps reading as
  // chit-chat, and greetings never reach here (no wh-token).
  // Conversation continuity (mechanical, ruliad-driven). A turn that resolves to
  // no subject of its own still belongs to the page when it CONTINUES the prior
  // grounded turn, three ways:
  //   1. it carries an anaphor — a pronoun drawn from the ruliad's
  //      anaphor_pronouns class, not a hand-written list ("tell me more about
  //      it", "and what about her?");
  //   2. it points at the page as a PLACE through locative deixis ("the
  //      craziest stuff in there") — prepositional only, so a bare "hi there"
  //      never matches;
  //   3. it is ELLIPTICAL: a short turn made entirely of function words and
  //      discourse glue that still asks something ("but why not?", "explain
  //      why"). With no content tokens of its own it cannot introduce a new
  //      topic — the only thing it can be doing is continuing the one on the
  //      table. The wh/meta-token requirement keeps bare acknowledgments
  //      ("okay", "yes") in chat, where they belong.
  // In every case the turn must name no new, off-page entity that would pull
  // the topic elsewhere. Inert unless the caller supplies grounding context:
  // ctx.prevGrounded (last turn was on the page) or ctx.everGrounded (some
  // earlier turn was — so one mis-routed turn can't strand the rest of the
  // conversation off the page). Batch callers (parity, bench) pass no ctx and
  // see exactly the prior routing.
  function continuesPrior(doc, q, ctx) {
    if (!ctx || !(ctx.prevGrounded || ctx.everGrounded)) return false;
    if (referents(doc, q).antimatter.length) return false;      // introduced a new, absent subject
    const ql = String(q).toLowerCase().replace(/[’']/g, "'");
    const toks = ql.match(/[\p{L}]+/gu) || [];
    if (toks.some(t => ANAPHOR_PRONOUNS.has(t))) return true;
    if (/\b(?:in|inside|from|within)\s+(?:there|here)\b/.test(ql)) return true;
    return toks.length > 0 && toks.length <= 8
      && /(?:^|\s)(?:why|how|what|when|where|who|whom|whose|which|explain|elaborate|clarify|expand|justify|mean|meaning)\b/.test(ql)
      && toks.every(t => STOP.has(t) || PRONOUNS.has(t) || FOLLOWUP_GLUE.has(t));
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
    const entities = castEntities(doc);
    // The cast is people-or-named-things, ranked by prominence. NER typing is
    // unreliable for names that double as places (Marlow, Sefton come back as
    // 'thing'), so exclude only genuine places/orgs rather than keeping only
    // type:'person' — that test used to pass solely because the projection
    // coerced every residual entity to 'person'. On a Gutenberg text, where
    // compromise's typing has the full header/license noise to misread,
    // confirmed persons are preferred outright when enough of them exist.
    const meta = docMetadata(doc);
    const strictPpl = entities.filter(e => e.type === 'person');
    const ppl = (meta.isGutenberg && strictPpl.length >= 2)
      ? strictPpl
      : entities.filter(e => e.type !== 'place' && e.type !== 'org');
    const list = (ppl.length ? ppl : entities).slice(0, 8);
    if (!list.length) return { text: 'I didn’t find any named people in this document.', audit: { status: 'notes', grounded: true, covers: '1/1', stable: true, note: 'No entities surfaced under the current rules.' } };
    // The prose renders the names plainly; the mention counts are bookkeeping,
    // so they ride in the audit note (the receipt), never glued onto the names.
    const figs = list.map(e => `${e.name} {{cite:${doc.id}:${e.sents[0]}:s${e.sents[0]}}}`);
    const text = 'The figures who appear most often: ' + (figs.length > 1 ? figs.slice(0, -1).join(', ') + ' and ' + figs[figs.length - 1] : figs[0]) + '.';
    return { text, cites: list.map(e => ({ docId: doc.id, idx: e.sents[0] })), audit: { status: 'clean', grounded: true, covers: '1/1', stable: true, note: 'Counted directly from the document’s mentions (' + list.map(e => `${e.name} ×${e.raw}`).join(', ') + ') — no model involved.' } };
  }
  // ── The graph's portrait ──────────────────────────────────────────
  // A summary already exists in the graph, unstated: which sites carry the
  // weight, which edges run between them, what the text asserted about them,
  // and the section spine. This takes that photo at the end position and says
  // it in words — mechanically, no model. Ported from eo-extractor.html's
  // graphPortrait(); reads Cleo's projected entities + edges + sections.
  // ── Portrait substrate collectors (WI-2) ──────────────────────────
  // These surface the NUL log, the signal substrate, and the full DEF set
  // for the talker-portrait composer. They read only the event log; they
  // never feed the talker — the composer turns them into prose.
  function collectNullsForPortrait(doc) {
    const out = [];
    for (const ev of (doc._events || [])) {
      if (ev.op !== 'NUL') continue;
      out.push({
        seq: ev.seq, sentence_idx: ev.sentence_idx,
        reason: ev.reason || null, surface: ev.surface || null,
        signal_id: ev.signal_id || null, competing: ev.competing || null,
      });
    }
    return out;
  }

  function collectSignalsForPortrait(doc) {
    const signals = new Map();
    for (const ev of (doc._events || [])) {
      if (ev.op === 'NUL' && ev.reason === 'signal-birth' && ev.signal_id) {
        signals.set(ev.signal_id, {
          id: ev.signal_id, constraints: ev.constraints || {},
          birth_sentence: ev.sentence_idx, touched: 0,
        });
      }
    }
    for (const ev of (doc._events || [])) {
      if (ev.signal_id && signals.has(ev.signal_id) && ev.op !== 'NUL') {
        signals.get(ev.signal_id).touched++;
      }
    }
    return [...signals.values()];
  }

  function collectDefsForPortrait(doc) {
    const out = [];
    for (const ev of (doc._events || [])) {
      if (ev.op !== 'DEF') continue;
      out.push({
        seq: ev.seq, target: ev.target, path: ev.path, value: ev.value,
        basis: ev.basis || null,
        transmuting: typeof isTransmutingDef === 'function' ? !!isTransmutingDef(ev) : false,
      });
    }
    return out;
  }

  function graphPortrait(doc) {
    if (!doc || doc.kind !== 'prose') return null;
    const { entities } = projectEntities(doc);
    if (!entities.length) return null;
    const heavy = entities.slice(0, 6);
    const heavyKeys = new Set(heavy.map(e => e.key));
    // edges between the heavy sites, by projectGraph (text-layer SYN)
    let edges = [];
    try { edges = (projectGraph(doc._events).edges || []); } catch (e) {}
    // A relation is portrayed only when the document states it with BOTH
    // parties NAMED in at least one sentence. An edge reconstructed solely
    // through coreference — "she … it", resolved to Gregor — is too weak to
    // present as one of the relations the document draws, and that is exactly
    // where the noise lives: dialogue tags ("'Oh God', he thought"), mis-resolved
    // pronoun objects ("it"/"their" landing on the protagonist), and clauses the
    // sentence-splitter merged. The golden, named-on-both-ends relation
    // ("Edith thought Marlow") survives; the coref-only ones drop out.
    const evBySeq = new Map();
    for (const ev of (doc._events || [])) if (ev && ev.seq != null) evBySeq.set(ev.seq, ev);
    const namesBothEnds = (ed) => (ed.eventSeqs || []).some(sq => {
      const ev = evBySeq.get(sq);
      return ev && ev.s != null && ev.o != null && !isPronoun(ev.s) && !isPronoun(ev.o);
    });
    // A relation verb is a predicate, never a fragment: strip the clause/sentence
    // punctuation a greedy clause can trap inside it ("thought," , "checking.")
    // so no edge is ever rendered carrying a comma or a full stop.
    const cleanRelationVerb = (v) => String(v == null ? '' : v)
      .replace(/[^\p{L}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const heavyEdges = edges
      .filter(ed => heavyKeys.has(ed.a) && heavyKeys.has(ed.b) && ed.verb && namesBothEnds(ed))
      .map(ed => ({ ...ed, verb: cleanRelationVerb(ed.verb) }))
      .filter(ed => ed.verb)
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
    // The spine is the document's section headings — but a section labeller
    // also catches title-page chrome (the title itself, "By <author>",
    // "Translated by …", a Contents line, a bare roman-numeral run). Presented
    // as "the piece moves through N named sections", that chrome makes the
    // longform read the byline as structure. Drop it: the title (the doc's
    // first line, repeated), bylines, Contents, and multi-numeral TOC lines;
    // dedup the rest.
    const titleLC = String((doc.sentenceTexts || [])[0] || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isSectionChrome = (label) => {
      const t = String(label).replace(/\s+/g, ' ').trim();
      const lc = t.toLowerCase();
      if (titleLC && lc === titleLC) return true;
      if (/^(by|translated by|edited by|illustrated by|with an introduction|contents|title page|frontispiece)\b/i.test(t)) return true;
      if (/^[ivxlcdm]+(\s+[ivxlcdm]+)+\.?$/i.test(t)) return true;     // "I  II  III" — a contents listing, not one section
      return false;
    };
    const spine = [];
    const seenSpine = new Set();
    for (const s of (doc._sections || [])) {
      const label = s.label;
      if (!label || isSectionChrome(label)) continue;
      const k = String(label).replace(/\s+/g, ' ').trim().toLowerCase();
      if (seenSpine.has(k)) continue;
      seenSpine.add(k);
      spine.push(label);
      if (spine.length >= 8) break;
    }
    return {
      heavy, heavyEdges, assertions, spine,                        // existing
      tail:    entities.slice(6, 20).map(e => ({
                 name: e.name, mass: e.mass, momentum: e.momentum, type: e.type
               })),
      nulls:   collectNullsForPortrait(doc),
      signals: collectSignalsForPortrait(doc),
      frame:   (() => { try { return projectGraph(doc._events).frame; } catch (e) { return null; } })(),
      defs:    collectDefsForPortrait(doc),
    };
  }

  // ── The integral fold ─────────────────────────────────────────────
  // A FOLD is a mechanical condensation of the document read from its start up
  // to a sentence boundary — the reading "so far", the way an integral
  // accumulates as you move along it. The fold of the WHOLE document (boundary
  // = the sentence count) is what answers "what is this about", and it rides
  // into the prompt on every turn that touches the page so that question is
  // always answerable. The fold up to a chapter's END boundary is what a
  // question scoped to that chapter receives — "the fold up to the beginning of
  // Ch 2" for Ch 1. No model: the heaviest figures named within the window,
  // what the text asserts about them, and the section labels crossed — the
  // graph's own reading, scoped to a prefix and said in words.

  // The cleaned, ranked cast — the same figures answerSummary portrays
  // (Gutenberg apparatus and the header's author/translator/language names
  // dropped), so a fold never turns on the byline. Off the Gutenberg path this
  // is projectEntities ranked, byte-identical.
  function foldHeavy(doc) {
    const { entities } = projectEntities(doc);
    const meta = docMetadata(doc);
    if (!meta.isGutenberg) return entities;
    const identity = new Set();
    for (const k of ['author', 'editor', 'translator', 'illustrator', 'language']) {
      const v = meta.fields && meta.fields[k];
      if (v) identity.add(String(v).toLowerCase().trim());
    }
    const keep = new Set(castEntities(doc).map(e => String(e.name)));
    return entities.filter(e => keep.has(String(e.name)) && !identity.has(String(e.name).toLowerCase().trim()));
  }

  // The section spine as CUMULATIVE boundaries: each chapter-like heading with
  // the sentence it starts at and the sentence the NEXT heading starts at (or
  // the document's end). Chrome headings — the title repeated, a byline, a
  // Contents line, a bare roman-numeral run — drop through the same filter the
  // portrait's spine uses, so a fold's chapters are real chapters.
  function foldSections(doc) {
    const texts = doc.sentenceTexts || [];
    const n = texts.length;
    const titleLC = String(texts[0] || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isChrome = (label) => {
      const t = String(label).replace(/\s+/g, ' ').trim();
      const lc = t.toLowerCase();
      if (titleLC && lc === titleLC) return true;
      if (/^(by|translated by|edited by|illustrated by|with an introduction|contents|title page|frontispiece)\b/i.test(t)) return true;
      if (/^[ivxlcdm]+(\s+[ivxlcdm]+)+\.?$/i.test(t)) return true;     // "I  II  III" — a contents listing
      return false;
    };
    const raw = [];
    for (const s of (doc._sections || [])) {
      if (!s || s.label == null || s.start_sentence == null) continue;
      if (isChrome(s.label)) continue;
      const start = s.start_sentence;
      if (start < 0 || start >= n) continue;
      raw.push({ label: String(s.label), start });
    }
    raw.sort((a, b) => a.start - b.start);
    const out = [], seen = new Set();
    for (let i = 0; i < raw.length; i++) {
      const k = raw[i].label.replace(/\s+/g, ' ').trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const end = i + 1 < raw.length ? raw[i + 1].start : n;
      out.push({ label: raw[i].label, start: raw[i].start, end });
    }
    return out;
  }

  // The core fold: condense whatever sentences the predicate admits into the
  // reader's-voice prose — the figures that scope turns on, what the text takes
  // them to be, the chapters it touches, and the earliest line it opens on. The
  // scope can be a contiguous prefix (the integral / a chapter) OR a scattered
  // set (the region an impressionistic query surfaced) — the SAME synthesis runs
  // over either, so "the integral of the relevant things" is just this over a
  // set instead of a range.
  function _foldScope(doc, inScope) {
    if (!doc || doc.kind !== 'prose') return '';
    const texts = doc.sentenceTexts || [];
    const n = texts.length;
    if (!n) return '';

    // heaviest figures with a mention inside the scope
    const heavy = foldHeavy(doc).filter(e => (e.sents || []).some(inScope)).slice(0, 5);
    const figKeys = new Set(heavy.map(e => e.key));
    const nameByKey = new Map(heavy.map(e => [e.key, e.name]));

    // copular "X is Y" assertions about those figures, made inside the scope
    const asserts = [], seenA = new Set();
    for (const ev of (doc._events || [])) {
      if (ev.op !== 'DEF' || ev.path !== 'class' || !ev.value) continue;
      if (!inScope(ev.sentence_idx)) continue;
      const k = normSurface(ev.target);
      if (!figKeys.has(k) || seenA.has(k)) continue;
      seenA.add(k);
      asserts.push({ name: nameByKey.get(k), is: String(ev.value) });
      if (asserts.length >= 4) break;
    }

    // section labels whose span the scope touches
    const spine = foldSections(doc).filter(s => {
      for (let i = s.start; i < s.end; i++) if (inScope(i)) return true;
      return false;
    }).map(s => s.label).slice(0, 8);

    // the earliest in-scope line, so the gist has something concrete to hold
    let opener = '';
    for (let i = 0; i < n; i++) {
      if (!inScope(i)) continue;
      const t = String(texts[i] || '').trim();
      if (t.length >= 40 && /[.!?…"”'’)]$/.test(t)) { opener = t; break; }
    }

    return prosifyFold({ figures: heavy.map(e => e.name), asserts, spine, opener });
  }

  // The fold of the prefix [0, hi): the reading up to a boundary, in words.
  function documentFold(doc, hi) {
    if (!doc || doc.kind !== 'prose') return '';
    const n = (doc.sentenceTexts || []).length;
    if (!n) return '';
    const end = (hi == null || hi > n) ? n : (hi < 0 ? 0 : hi);
    if (end <= 0) return '';
    return _foldScope(doc, (i) => i != null && i >= 0 && i < end);
  }

  // The fold (integral) over an ARBITRARY set of sentences — the relevant region
  // an impressionistic query gathered, condensed into one picture rather than
  // handed back as raw lines.
  function foldOver(doc, idxs) {
    if (!doc || doc.kind !== 'prose') return '';
    const set = new Set((idxs || []).filter(i => i != null && i >= 0));
    if (!set.size) return '';
    return _foldScope(doc, (i) => set.has(i));
  }

  // The fold as PROSE, not a template. The structured pieces — the figures the
  // window turns on, what it takes them to be, the chapters it crosses, the line
  // it opens on — are joined into flowing sentences a reader's voice would use,
  // so the model composes over an overview rather than re-listing slots. Still
  // mechanical: no model writes this, the wording is deterministic.
  function _joinList(xs) {
    const a = xs.filter(Boolean);
    if (!a.length) return '';
    if (a.length === 1) return a[0];
    if (a.length === 2) return a[0] + ' and ' + a[1];
    return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
  }
  function prosifyFold({ figures, asserts, spine, opener }) {
    const sents = [];
    // who/what it centers on, with what the text takes them to be folded in.
    // The old verb was "turns mostly on" — literary in the legal-argument
    // sense ("the case turns on") but bizarre as everyday register: a user
    // reading "this document turns most on X" assumes a typo of "turns
    // most[ly] on". "Centers on" preserves the present-tense fold rhythm
    // ("It centers on… It runs from… It opens:…") without the awkwardness.
    if (figures && figures.length) {
      let lead = `It mostly centers on ${_joinList(figures)}`;
      if (asserts && asserts.length) {
        lead += ` — it takes ${_joinList(asserts.map(a => `${a.name} to be ${deAnaphorDef(a.is)}`))}`;
      }
      sents.push(lead + '.');
    } else if (asserts && asserts.length) {
      sents.push(`It takes ${_joinList(asserts.map(a => `${a.name} to be ${deAnaphorDef(a.is)}`))}.`);
    }
    // the arc across its chapters, read as movement rather than a list
    if (spine && spine.length > 1) {
      const middle = spine.length > 2 ? `, by way of ${_joinList(spine.slice(1, -1))},` : '';
      sents.push(`It runs from ${spine[0]}${middle} through to ${spine[spine.length - 1]}.`);
    } else if (spine && spine.length === 1) {
      sents.push(`It sits under ${spine[0]}.`);
    }
    // the concrete opening line, so the gist has something to hold
    if (opener) sents.push(`It opens: “${opener}”`);
    return sents.join(' ');
  }

  // Build (and cache, per rules revision) the integral fold of the whole
  // document plus the cumulative fold at every chapter boundary.
  function documentFolds(doc) {
    if (!doc || doc.kind !== 'prose') return null;
    if (doc._folds && doc._folds.rev === RULES_REV) return doc._folds.value;
    const n = (doc.sentenceTexts || []).length;
    const sections = foldSections(doc).map(s => ({ label: s.label, start: s.start, end: s.end, fold: documentFold(doc, s.end) }));
    const value = { integral: documentFold(doc, n), sections };
    doc._folds = { rev: RULES_REV, value };
    return value;
  }

  // The nine-cell terrain histogram for a scope. Walk the events the predicate
  // admits, address each to its Site (Domain × Time) via eoSiteOfEvent, bucket
  // into the grid. Each cell carries the events it received (sorted heaviest
  // first) and the summed mass — ev.mass when present, else a count of 1. Pure
  // read over doc._events: no operator written, no site deposited beyond the
  // existing extraction-time stamp. The whole-document call caches on the doc
  // per RULES_REV the way documentFolds does; a scoped walk (a chapter, an
  // impression region) recomputes. Returns a map keyed by the nine grid names
  // — Void/Entity/Kind, Field/Link/Network, Atmosphere/Lens/Paradigm — each
  // cell `{ events, mass, bookkeeping }`. The histogram is `cells[name].mass`;
  // `mass - bookkeeping` is the substantive view.
  //
  // `bookkeeping` is the share of `mass` deposited by the reader's own
  // machinery rather than observed in the text: admission-gate SEGs (the
  // single-sighting retirements) and minted DEFs (frame hashes, csv schema).
  // They are real events but they pool wherever the reader works, not where
  // the document does — on a short article half the Link cell can be
  // admission SEGs — so any ranking of cells should read them apart.
  function _terrainBookkeeping(ev) {
    return (ev.op === 'SEG' && ev.src === 'admission-gate')
        || (ev.op === 'DEF' && (ev.src === 'frame-mint' || ev.src === 'csv-schema' || ev.src === 'csv-cell'));
  }
  function _terrainsScope(doc, inScope) {
    const cells = {};
    for (const s of eoSites()) cells[s] = { events: [], mass: 0, bookkeeping: 0 };
    for (const ev of (doc._events || [])) {
      if (inScope && !inScope(ev.sentence_idx)) continue;
      const s = eoSiteOfEvent(ev);
      if (!s || !cells[s]) continue;
      const w = (ev.mass != null && Number.isFinite(ev.mass)) ? ev.mass : 1;
      cells[s].events.push(ev);
      cells[s].mass += w;
      if (_terrainBookkeeping(ev)) cells[s].bookkeeping += w;
    }
    for (const s of eoSites()) {
      cells[s].events.sort((a, b) => {
        const ma = (a.mass != null && Number.isFinite(a.mass)) ? a.mass : 1;
        const mb = (b.mass != null && Number.isFinite(b.mass)) ? b.mass : 1;
        return mb - ma;
      });
      cells[s].mass = +cells[s].mass.toFixed(2);
      cells[s].bookkeeping = +cells[s].bookkeeping.toFixed(2);
    }
    return cells;
  }
  function foldTerrains(doc, inScope) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return null;
    if (inScope == null) {
      if (doc._terrains && doc._terrains.rev === RULES_REV) return doc._terrains.value;
      const value = _terrainsScope(doc, null);
      doc._terrains = { rev: RULES_REV, value };
      return value;
    }
    return _terrainsScope(doc, inScope);
  }

  // number-words and roman numerals, so "chapter two" / "part IV" resolve to an
  // ordinal the same way "chapter 2" does
  const _FOLD_ORDINALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  function _romanToInt(s) {
    const m = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let total = 0, prev = 0;
    for (const ch of String(s).toLowerCase().split('').reverse()) {
      const v = m[ch]; if (!v) return 0;
      if (v < prev) total -= v; else { total += v; prev = v; }
    }
    return total;
  }

  // The fold the question wants. A reference to a chapter/section — by its own
  // label ("the Fountain"), or by ordinal ("chapter 2", "part three",
  // "section IV") — returns the cumulative fold up to where the NEXT section
  // begins. Everything else gets the integral fold of the whole document, so
  // "what is this about" is always covered.
  function foldForQuery(doc, query) {
    const folds = documentFolds(doc);
    if (!folds) return null;
    const q = String(query || '');
    const sections = folds.sections;
    if (sections.length) {
      const ql = ' ' + q.toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
      for (const s of sections) {
        const lab = String(s.label).toLowerCase().replace(/\s+/g, ' ').trim();
        if (lab.length >= 3 && ql.includes(' ' + lab + ' '))
          return { scope: 'section', label: s.label, hi: s.end, text: s.fold };
      }
      const m = /\b(?:chapters?|ch|parts?|sections?|sec|books?|acts?|scenes?|cantos?)\.?\s+([0-9]+|[ivxlcdm]+|[a-z]+)\b/i.exec(q);
      if (m) {
        const tok = m[1].toLowerCase();
        let idx = 0;
        if (/^[0-9]+$/.test(tok)) idx = parseInt(tok, 10);
        else if (_FOLD_ORDINALS[tok] != null) idx = _FOLD_ORDINALS[tok];
        else if (/^[ivxlcdm]+$/.test(tok)) idx = _romanToInt(tok);
        if (idx >= 1 && idx <= sections.length) {
          const s = sections[idx - 1];
          return { scope: 'section', label: s.label, hi: s.end, text: s.fold };
        }
      }
    }
    return { scope: 'integral', label: null, hi: (doc.sentenceTexts || []).length, text: folds.integral };
  }

  // The fold as a prompt note — the reader's standing overview of the document
  // (or the chapter the turn scoped to), in first person, "usually right".
  function foldNote(doc, query) {
    const f = foldForQuery(doc, query);
    if (!f || !f.text) return '';
    return f.scope === 'section'
      ? `What the document covers up to ${f.label} (your reading so far): ${f.text}`
      : `What the document is about (your reading of the whole): ${f.text}`;
  }

  // ── The graph, made portable ──────────────────────────────────────
  // A self-contained, JSON-safe snapshot of everything the reading extracted
  // from one document: the entities (with mass + mention sites), the relations
  // between them, the copular assertions, the section spine, the physics frame,
  // and the full event log — "all the processing that took place". This is what
  // the Graph explorer reads and what the unified export writes as a
  // `cleo-graph/1` line. Read-only; never mutates the doc.
  function graphSnapshot(doc) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return null;
    const clone = (v) => { try { return v == null ? v : JSON.parse(JSON.stringify(v)); } catch (e) { return null; } };
    let edges = [], frame = null;
    try { const g = projectGraph(doc._events); edges = g.edges || []; frame = g.frame || null; } catch (e) {}
    const { entities } = projectEntities(doc);
    const p = graphPortrait(doc) || { assertions: [], spine: [] };
    return {
      schema: 'cleo-graph/1',
      at: new Date().toISOString(),
      doc: { id: doc.id, name: doc.name, kind: doc.kind, lang: doc._lang || 'en', genre: doc._genre || null, sentences: (doc.sentenceTexts || []).length },
      // `site` is the generated cell; `address` shows the subtype as a
      // refinement beneath the Entity cell ("Entity / person"), never as a
      // sibling of the nine
      entities: entities.map(e => ({ name: e.name, key: e.key, type: e.type, site: e.site, address: eoAddress(e.site, e.type), mentions: e.raw, mass: e.mass, sents: e.sents })),
      edges: edges.map(e => ({ a: e.a, b: e.b, aName: e.aName, bName: e.bName, verb: e.verb, weight: e.weight })),
      assertions: (p.assertions || []).map(a => ({ subject: a.name, is: a.is })),
      spine: p.spine || [],
      frame: clone(frame),
      events: clone(doc._events) || [],
      tail:    p.tail || [],
      nulls:   p.nulls || [],
      signals: p.signals || [],
      defs:    p.defs || [],
    };
  }

  /* ============================================================ INGESTION AUDIT
     The graph snapshot above is the proper-noun reading: entities, relations,
     assertions. A skeptical auditor's first question is the one the entity view
     can't answer — "what happened to EVERY word, not just the names?" These two
     functions are the glass box over ingestion itself, word by word.

     classifyTokens(sentence) walks one span left-to-right and reports, for every
     word, exactly what the engine does with it. It is not a re-implementation of
     the tokenizer — it CALLS tok() per word, so the 'term' verdict it shows is
     bit-identical to what retrieval actually indexes. The audit cannot drift
     from the engine because it asks the engine. A word is:
       • 'term'  — survives tok(): indexed for retrieval (its index forms in .terms)
       • 'stop'  — a stopword (QA_STOP): carried in the prose, dropped from the index
       • 'drop'  — too short (≤2 chars) or outside the tokenizer's character class
                   (e.g. accents/CJK the ASCII index can't hold) — also unindexed. */
  function classifyTokens(s) {
    const text = String(s == null ? '' : s);
    // Unicode-aware word runs so the auditor sees the REAL word (accents, CJK),
    // even where the ASCII index below cannot hold it — the gap is the point.
    const surfaces = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || [];
    const out = [];
    for (const w of surfaces) {
      const terms = tok(w);                                  // the engine's own verdict
      const base = w.toLowerCase().replace(/['’]s$/, '');
      const kind = terms.length ? 'term' : (QA_STOP.has(base) ? 'stop' : 'drop');
      out.push({ w, base, kind, terms });
    }
    return out;
  }

  // The full ingestion audit for one prose document: every word's fate, the
  // inverted index actually built, per-sentence coverage (which spans yielded
  // graph events and which went dark), and the event/entity counts — compact
  // enough to hold for a whole book, complete enough that nothing is hidden.
  // Returns null for tables/empty texts (they carry no word graph), mirroring
  // graphSnapshot. The heavy per-word render is left to the UI (computed lazily,
  // span by span, via classifyTokens) so this stays O(n) and never spikes memory.
  const _SENTS_CAP = 4000;   // per-term span list cap (count stays exact); huge docs
  function ingestionReport(doc) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return null;
    const sents = doc.sentenceTexts || [];
    const events = doc._events || [];

    // events grouped by the span they were deposited on (the join key is sentence_idx)
    const chromeSet = new Set(doc._chrome || []);
    const evBySent = new Map();
    const opCounts = {};
    for (let k = 0; k < events.length; k++) {
      const ev = events[k];
      opCounts[ev.op] = (opCounts[ev.op] || 0) + 1;
      const si = ev.sentence_idx;
      if (si == null) continue;
      (evBySent.get(si) || evBySent.set(si, []).get(si)).push(k);
    }

    // entities + which span each touches, and the token forms that became a name
    const { entities } = projectEntities(doc);
    const entKeyTokens = new Set();
    const entsBySent = new Map();
    for (const e of entities) {
      for (const t of tok(e.name)) entKeyTokens.add(t);
      for (const si of (e.sents || [])) (entsBySent.get(si) || entsBySent.set(si, []).get(si)).push(e.key);
    }

    // the inverted index, built word by word, in reading order
    const terms = new Map();   // indexTerm -> { token, count, sents:[], entity }
    const dropped = new Map();  // base -> { token, count, kind }  (stop / drop)
    let occWords = 0, occTerm = 0, occStop = 0, occDrop = 0, occIndex = 0, dark = 0;
    const perSent = new Array(sents.length);
    for (let i = 0; i < sents.length; i++) {
      const toks = classifyTokens(sents[i]);
      let nTerm = 0;
      for (const t of toks) {
        occWords++;
        if (t.kind === 'term') {
          occTerm++; nTerm++;
          for (const form of t.terms) {            // a word may yield several index forms (hyphen splits)
            occIndex++;
            let rec = terms.get(form);
            if (!rec) terms.set(form, rec = { token: form, count: 0, sents: [], entity: entKeyTokens.has(form) });
            rec.count++;
            if (rec.sents.length < _SENTS_CAP && rec.sents[rec.sents.length - 1] !== i) rec.sents.push(i);
          }
        } else {
          if (t.kind === 'stop') occStop++; else occDrop++;
          let rec = dropped.get(t.base);
          if (!rec) dropped.set(t.base, rec = { token: t.base, count: 0, kind: t.kind });
          rec.count++;
        }
      }
      const evIdx = evBySent.get(i) || [];
      if (!evIdx.length) dark++;
      const ops = {};
      for (const k of evIdx) { const op = events[k].op; ops[op] = (ops[op] || 0) + 1; }
      perSent[i] = { i, chars: sents[i].length, words: toks.length, terms: nTerm,
                     events: evIdx.length, ops, ents: entsBySent.get(i) || [] };
      // A dark span carries its reason — written-down absence, never a guess:
      // 'chrome' when the chrome gate kept it from the emitters, 'no-event'
      // when it was read as prose and deposited nothing. (A span whose only
      // events are NULs keeps the NUL's own richer reason instead.)
      if (!evIdx.length) perSent[i].reason = chromeSet.has(i) ? 'chrome' : 'no-event';
    }

    const termList = [...terms.values()].sort((a, b) => b.count - a.count || (a.token < b.token ? -1 : 1));
    const dropList = [...dropped.values()].sort((a, b) => b.count - a.count || (a.token < b.token ? -1 : 1));
    const entTermCount = termList.filter(t => t.entity).length;

    // Site-face audit (the level guard): a `site` slot holds one of the nine
    // generated cell names and nothing else. An entityType subtype value
    // ('thing'/'person'/'place'/'org'/…) in a site slot is a LEVEL error —
    // the subtype lives one rank below the Entity cell, on its own axis —
    // and fails the audit rather than passing silently.
    const siteNames = new Set(eoSites());
    const siteTally = {}; for (const s of siteNames) siteTally[s] = 0;
    const siteInvalid = [];
    for (const ev of events) {
      if (ev.site == null) continue;
      if (siteNames.has(ev.site)) { siteTally[ev.site]++; continue; }
      siteInvalid.push({ seq: ev.seq, op: ev.op, site: ev.site,
        level_error: ENTITY_SUBTYPES.has(String(ev.site).toLowerCase()) });
    }
    return {
      schema: 'cleo-ingestion/1',
      at: new Date().toISOString(),
      doc: { id: doc.id, name: doc.name, kind: doc.kind, lang: doc._lang || 'en',
             genre: doc._genre || null, sentences: sents.length,
             blocks: (doc.blocks || []).length, chars: (doc._text || '').length },
      words: {
        occurrences: occWords,        // every word in the prose
        indexed: occTerm,             // words that became one or more index terms
        stop: occStop,                // words dropped as stopwords
        dropped: occDrop,             // words dropped (too short / unindexable)
        indexTerms: occIndex,         // total index-term postings (≥ indexed, hyphens split)
        uniqueTerms: termList.length, // distinct index terms (the searchable vocabulary)
        uniqueDropped: dropList.length,
        entityTerms: entTermCount,    // distinct index terms that are part of a name
      },
      coverage: { sentences: sents.length, withEvents: sents.length - dark, dark },
      // every stamped site, audited against the nine generated cell names;
      // `invalid` must be empty — a member with level_error means a subtype
      // crossed into the site slot
      sites: { cells: siteTally, invalid: siteInvalid },
      dechrome: doc._dechrome || computeDechrome(doc),
      counts: { events: events.length, ops: opCounts, entities: entities.length },
      spans: sents,                   // the verbatim span texts (so an export is self-contained)
      lexicon: termList,              // the inverted index actually built
      stopwords: dropList,            // the words carried but not indexed
      sentences: perSent,             // lightweight per-span summary (tokens computed lazily)
      // `site` is the generated cell; `address` shows the subtype as a
      // refinement beneath the Entity cell ("Entity / person"), never as a
      // sibling of the nine
      entities: entities.map(e => ({ name: e.name, key: e.key, type: e.type, site: e.site, address: eoAddress(e.site, e.type), mentions: e.raw, mass: e.mass, sents: e.sents })),
      events,                         // the full append-only log (ground truth)
    };
  }

  /* ============================================================ TALKER PORTRAIT
     The talker reads what a reader would read — words on a page, nothing else.
     This composes the three EO triads as three labeled prose blocks
     (EXISTENCE / STRUCTURE / SIGNIFICANCE), runs the single LLM step that
     writes SIGNIFICANCE, checks that draft mechanically (evaDraft), and binds
     citations back to source sentences mechanically (groundTalkerOutput).

     Machinery never reaches the talker: no mass/momentum/frame, no operator
     names, no sentence indices, no citation tokens. The ontological (what the
     page contains) and the epistemic (what the reading concluded) live in
     separate, differently-labeled blocks and never blend. */

  // The citation floor — the same threshold bindCitations grounds against.
  // Hoisted so the talker grounder reuses it rather than inventing a new one.
  const CITE_FLOOR = 0.34;

  // English ordinal words for the small counts the prose needs.
  const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  function ordinalWord(n) { return ORDINAL_WORDS[n - 1] || `${n}th`; }

  // Which paragraph (1-based, counting only p-blocks) a sentence falls in.
  // Used by STRUCTURE to say "since the third paragraph" mechanically.
  function paragraphOrdinalOf(doc, sentIdx) {
    if (sentIdx == null || !doc || !Array.isArray(doc.blocks)) return null;
    let pNum = 0;
    for (const b of doc.blocks) {
      if (b.type !== 'p' || !Array.isArray(b.sentences)) continue;
      pNum++;
      if (b.sentences.some(s => s.i === sentIdx)) return pNum;
    }
    return null;
  }

  function genderWord(raw) {
    const g = String(raw == null ? '' : raw).toLowerCase();
    if (g === 'f' || g === 'female' || g === 'woman') return 'female';
    if (g === 'm' || g === 'male' || g === 'man') return 'male';
    return null;
  }

  // The mechanical EVA. Accepts or rejects a SIGNIFICANCE draft with no LLM —
  // checks for machinery leaks, index/citation leaks, ontological framing,
  // invented names, and length. Returns { ok, reasons }.
  /* ---------- conventions hydration: EVA failures write memory ----------
     A vetoed draft is not just rejected — it is an OBSERVATION about how this
     model fails in this register. Every failure becomes a REC record (the
     hydration payload, one JSONL line shaped for memory/conventions.jsonl,
     carrying the register affinity it was observed in); a term that fails
     TWICE is admitted into eva_veto_lexicon through the ledger — a contextual
     neuron: it feeds the veto (check 1b) and the retry prompt from then on.
     The engine never touches the network; a host may set
     EOEngine.onConventionsRec = (rec) => … to ship records out (e.g. the
     append webhook that writes memory/conventions.jsonl). */
  const CONVENTIONS_DELTA = [];
  const EVA_TALLY = new Map();
  function noteEvaFailure(reasons, ctx = {}) {
    for (const r of (reasons || [])) {
      if (r.startsWith('learned-veto:')) continue;        // already a neuron — don't re-learn it
      const m = /^invented-name:(.+)$/.exec(r);
      const term = m ? m[1] : null;
      const key = (ctx.lang || 'en') + '|' + (term ? 'term:' + term.toLowerCase() : 'reason:' + r);
      const n = (EVA_TALLY.get(key) || 0) + 1;
      EVA_TALLY.set(key, n);
      const rec = {
        op: 'REC', target: 'core:eva_veto_lexicon', action: 'eva-veto',
        value: { reason: m ? 'invented-name' : r, term, sightings: n },
        affinity: { lang: ctx.lang || 'en', genre: ctx.genre || null },
        at: Date.now(),
      };
      if (term && n === 2) {
        // two sightings — the same admission law every induced rule obeys
        ledgerCommit({ target: 'rule:eva_veto_lexicon', action: 'add-token', bucket: 'core',
          value: term, mass: n, basis: { eva_failures: n }, src: 'eva-induction' });
        rec.admitted = true;
      }
      CONVENTIONS_DELTA.push(rec);
      try {
        const hook = (typeof window !== 'undefined' && window.EOEngine && window.EOEngine.onConventionsRec);
        if (typeof hook === 'function') hook(rec);
      } catch (e) { /* a hook failure never blocks the reading */ }
    }
  }
  function conventionsDelta() { return CONVENTIONS_DELTA.slice(); }
  // Serialization is where the writer-side promises hold: duplicate records
  // collapse on (op, target, action, value, h-set) — the same dedup the
  // append webhook applies — and strict privacy strips embedding signatures
  // from every shipped anchor (coupling-only off-device).
  function serializeConventionsDelta() {
    const seen = new Set();
    const lines = [];
    for (const r of CONVENTIONS_DELTA) {
      const k = _conventionsDedupKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(JSON.stringify(_privacyStrip(r)));
    }
    return lines.join('\n');
  }

  function evaDraft(draft, p, sentenceTexts) {
    const reasons = [];
    const text = String(draft == null ? '' : draft);

    // Check 1: no machinery vocabulary leaked in (the eva_machinery_terms
    // convention — revisable like any other).
    if (EVA_MACHINERY_RE.test(text)) reasons.push('machinery-leak');
    // Check 1b: the LEARNED veto — terms admitted from this model's own
    // repeated failures (contextual neurons). Empty until failures teach it.
    if (EVA_VETO_TERMS && EVA_VETO_TERMS.size) {
      const lowerText = text.toLowerCase();
      for (const t of EVA_VETO_TERMS) {
        if (t && lowerText.includes(String(t).toLowerCase())) reasons.push('learned-veto:' + t);
      }
    }

    // Check 2: no citation tokens or sentence indices.
    if (/\{\{|\[s\d+\]|\bs\d+\b/.test(text)) reasons.push('index-leak');

    // Check 3: ontological framing absent (epistemic framing required).
    const ontologicalFraming = /\b(the text says|the page asserts|according to the document|the document states)\b/i;
    if (ontologicalFraming.test(text)) reasons.push('ontological-slip');

    // Check 4: every capitalized proper noun must be known or on the page.
    const knownNames = new Set([
      ...p.heavy.map(e => e.name),
      ...(p.tail || []).map(e => e.name),
    ]);
    const properNouns = (text.match(/\b[A-Z][a-zA-Z]+\b/g) || [])
      .filter(w => !/^(The|A|An|It|This|That|These|Those|What|When|Where|Who|Why|How|And|But|Or|So|Yet|If|Because|While|Though|Although|Since)$/.test(w));
    for (const noun of properNouns) {
      if (!knownNames.has(noun) && !sentenceTexts.some(s => s.includes(noun))) {
        reasons.push('invented-name:' + noun);
      }
    }

    // Check 5: length — 3 to 8 sentences.
    const sentCount = (text.match(/[.!?]+\s/g) || []).length + 1;
    if (sentCount < 3 || sentCount > 8) reasons.push('length:' + sentCount);

    return { ok: reasons.length === 0, reasons };
  }

  // Build the deterministic NUL + signal closing sentences. These never go
  // through the LLM and are guaranteed clean of machinery and framing slips.
  // Also pushes the supporting sentence indices into `spans`.
  function closureSentences(doc, p, spans) {
    const out = [];
    const heavyKeys = new Set(p.heavy.map(e => e.key));
    const seqToSent = doc._seqToSent || new Map();
    const pushSpan = (idx) => {
      if (idx != null && doc.sentenceTexts[idx] != null)
        spans.push({ key: '_significance', sentenceIndex: idx, text: doc.sentenceTexts[idx] });
    };

    // NULs whose competing set touches a heavy figure → an undecided pronoun.
    // Dedup by the competing PAIR (many stalls share the same two candidates,
    // which would otherwise repeat one sentence verbatim a dozen times) and
    // cap it — a reader notes the indecision once or twice, doesn't log it.
    const seenPair = new Set();
    let stallNotes = 0;
    for (const nl of (p.nulls || [])) {
      if (stallNotes >= 2) break;
      const comp = Array.isArray(nl.competing) ? nl.competing : [];
      if (!comp.some(c => heavyKeys.has(c.site))) continue;
      const named = comp.map(c => c.siteName || c.name).filter(Boolean);
      if (named.length < 2) continue;
      const pair = [named[0], named[1]].sort().join('|').toLowerCase();
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
      stallNotes++;
      out.push(`The reading did not commit when a pronoun could have been either ${named[0]} or ${named[1]}.`);
      if (nl.sentence_idx != null) pushSpan(nl.sentence_idx);
    }

    // Signals carried far without ever being named.
    const total = (doc.sentenceTexts || []).length || 1;
    for (const sig of (p.signals || [])) {
      if (!(sig.touched >= 3 && sig.birth_sentence != null && sig.birth_sentence < total / 4)) continue;
      const g = genderWord(sig.constraints && sig.constraints.gender);
      out.push(g
        ? `An unnamed ${g} figure has carried part of the piece without ever being named.`
        : `An unnamed figure has carried part of the piece without ever being named.`);
      pushSpan(sig.birth_sentence);
    }
    return out;
  }

  // The deterministic SIGNIFICANCE body — dry but never wrong about the
  // ontological/epistemic boundary. Used when the LLM is unavailable or both
  // drafts fail EVA.
  function fallbackSignificance(p) {
    const parts = [];
    const a = p.heavy[0], b = p.heavy[1];
    if (a && b) parts.push(`The piece returns most often to ${a.name} and ${b.name}; their paths through the document carry most of the weight.`);
    else if (a) parts.push(`The piece returns most often to ${a.name}.`);
    for (const as of (p.assertions || []).slice(0, 2)) {
      if (as && as.name && as.is) parts.push(`The reading takes ${as.name} to be ${deAnaphorDef(as.is)}.`);
    }
    return parts.join(' ');
  }

  // talkerPortrait(doc, opts) — the three prose blocks + spans for the grounder.
  // opts.llm, when supplied, is the ONE LLM step: an (system, user) => string
  // (sync or async) that writes the SIGNIFICANCE paragraph. With no opts.llm
  // the composer is fully deterministic (zero LLM calls) via the fallback.
  async function talkerPortrait(doc, opts = {}) {
    const p = graphPortrait(doc);
    if (!p || !p.heavy.length) return null;
    const sentenceTexts = doc.sentenceTexts || [];
    const spans = [];

    // ── Block 1 — EXISTENCE (ontological): one sentence per heavy figure ──
    const seenExist = new Set();
    const existParts = [];
    for (const e of p.heavy.slice(0, 6)) {
      const idx = e.sents[0];
      const text = sentenceTexts[idx];
      if (text == null || seenExist.has(idx)) continue;
      seenExist.add(idx);
      existParts.push(String(text).trim());
      spans.push({ key: e.key, sentenceIndex: idx, text });
    }
    const existence = 'The page carries these passages. ' + existParts.join(' ');

    // ── Block 2 — STRUCTURE (ontological): a reader's notes ──
    const total = sentenceTexts.length || 1;
    const third = total / 3, lastThirdStart = (2 * total) / 3;
    const seqToSent = doc._seqToSent || new Map();
    const heavyByKey = new Map(p.heavy.map(e => [e.key, e]));
    const seqSents = (eventSeqs) => [...new Set((eventSeqs || [])
      .map(sq => seqToSent.get(sq)).filter(i => i != null))].sort((x, y) => x - y);
    const pushStructSpans = (idxs) => {
      for (const i of idxs) if (sentenceTexts[i] != null)
        spans.push({ key: '_structure', sentenceIndex: i, text: sentenceTexts[i] });
    };
    const notes = [];

    // Co-occurrence: one clause for the strongest early-sharing heavy pair.
    for (const ed of (p.heavyEdges || [])) {
      if ((ed.weight || 0) < 2) continue;
      const A = heavyByKey.get(ed.a), B = heavyByKey.get(ed.b);
      if (!A || !B) continue;
      if (!(A.sents[0] < third && B.sents[0] < third)) continue;
      notes.push(`${A.name} and ${B.name} share the early scenes.`);
      pushStructSpans(seqSents(ed.eventSeqs));
      break;
    }
    // Reappearance: one clause for the strongest edge spanning first→last third.
    for (const ed of (p.heavyEdges || [])) {
      if ((ed.weight || 0) < 3) continue;
      const idxs = seqSents(ed.eventSeqs);
      if (!idxs.length) continue;
      const A = heavyByKey.get(ed.a), B = heavyByKey.get(ed.b);
      if (!A || !B) continue;
      if (idxs[0] < third && idxs[idxs.length - 1] >= lastThirdStart) {
        notes.push(`${A.name} reappears whenever ${B.name} does.`);
        pushStructSpans(idxs);
        break;
      }
    }
    // Naming asymmetry from signals carried unnamed since early on.
    for (const sig of (p.signals || [])) {
      if (!(sig.touched >= 3 && sig.birth_sentence != null && sig.birth_sentence < total / 4)) continue;
      const para = paragraphOrdinalOf(doc, sig.birth_sentence);
      const where = para != null ? `the ${ordinalWord(para)} paragraph` : 'early on';
      notes.push(`Someone has been in the room without a name since ${where}.`);
      if (sentenceTexts[sig.birth_sentence] != null)
        spans.push({ key: '_structure', sentenceIndex: sig.birth_sentence, text: sentenceTexts[sig.birth_sentence] });
      break;
    }
    // Tail figures.
    if ((p.tail || []).length >= 3) notes.push('Several others pass through but never carry a scene.');
    // Section spine.
    if ((p.spine || []).length >= 2) {
      notes.push(`The piece moves through ${p.spine.length} named sections, ${p.spine.join(', ')}.`);
    }
    const structure = 'The notes the reader took.' + (notes.length ? ' ' + notes.join(' ') : '');

    // ── Block 3 — SIGNIFICANCE (epistemic): the one LLM call, then EVA ──
    const system = 'You are reading a portrait of a document. Write one paragraph '
      + 'in plain prose describing what the reading came to. Use phrasing like '
      + '"the reading", "the piece", "the document carries" — never "the text '
      + 'says" or "according to the document". Do not invent connections, names, '
      + 'or details that do not appear in the passages or the notes below. Four '
      + 'to six sentences. No headers, no bullets, no quotation marks around '
      + 'proper nouns.';
    const user = existence + '\n\n' + structure;

    let body = null;
    const llm = typeof opts.llm === 'function' ? opts.llm : null;
    if (llm) {
      // Learned veto terms (contextual neurons from past failures) steer the
      // FIRST draft, not just the retry — hydration pays forward.
      const learned = EVA_VETO_TERMS && EVA_VETO_TERMS.size
        ? ' Never write these words: ' + [...EVA_VETO_TERMS].slice(0, 8).join(', ') + '.' : '';
      let sys = system + learned;
      for (let attempt = 0; attempt < 2 && body == null; attempt++) {
        let draft = '';
        try { draft = String((await llm(sys, user)) || '').trim(); } catch (e) { draft = ''; }
        if (!draft) break;
        const eva = evaDraft(draft, p, sentenceTexts);
        if (eva.ok) { body = draft; break; }
        // a veto is an observation — it writes memory (REC + possible neuron)
        noteEvaFailure(eva.reasons, { lang: doc._lang, genre: doc._genre });
        // Sharpen the system prompt with the rejection reasons and retry once.
        sys = system + learned + ' Your previous draft was rejected (' + eva.reasons.join(', ')
          + '); this time use only epistemic framing, no machinery words, no '
          + 'sentence numbers, and only names that appear in the passages above.';
      }
    }
    if (body == null) body = fallbackSignificance(p);

    // Append NUL + signal closures (deterministic, never via the LLM).
    const closures = closureSentences(doc, p, spans);
    const sigParts = [body, ...closures].filter(s => s && s.trim());
    const significance = 'What the reading came to.' + (sigParts.length ? ' ' + sigParts.join(' ') : '');

    // ── Final guard — the last line of defense before the talker sees it ──
    const guardRE = /\{\{|\[s\d+\]|\bs\d+\b|\b(mass|momentum|gravity|coupling|frame|rules_rev|NUL|SIG|INS|SEG|CON|SYN|DEF|EVA|REC|cite|void|infer|absent)\b/i;
    for (const block of [existence, structure, significance]) {
      if (guardRE.test(block)) throw new Error('talker portrait composer leaked machinery');
    }

    return { existence, structure, significance, spans };
  }

  /* ===================================================== TALKER GROUNDER (WI-6)
     Fully mechanical citation binding for talker prose. No LLM: token overlap
     against the span candidate set with a doc-wide backstop, the same scoring
     bindCitations grounds against. LLM generates meaning; code generates form. */
  function groundTalkerOutput(doc, talkerProse, spans, opts = {}) {
    const sentenceTexts = doc.sentenceTexts || [];
    const spanIdx = new Set((spans || []).map(s => s.sentenceIndex).filter(i => i != null));
    const bodyJoined = sentenceTexts.join(' ');
    const parts = splitDraft(String(talkerProse == null ? '' : talkerProse)
      .replace(/\[s?\d+\]/gi, '').replace(/\s+([.,;:])/g, '$1').trim());

    const cites = [];
    const seenCite = new Set();
    let citedCount = 0, inferCount = 0, absentCount = 0, integrationCount = 0;

    const out = parts.map(sentRaw => {
      const sent = sentRaw.trim();
      if (!sent) return sent;
      // Rank every doc sentence by the same scoring bindCitations uses, then
      // prefer a hit inside the span set before the doc-wide backstop.
      const ranked = retrieve(doc, sent, sentenceTexts.length || 6);
      const spanHit = ranked.find(h => spanIdx.has(h.i)) || null;
      const backstop = ranked[0] || null;
      const best = (spanHit && supportsClaim(spanHit, sent, CITE_FLOOR)) ? spanHit
        : (backstop && supportsClaim(backstop, sent, CITE_FLOOR)) ? backstop
        : (spanHit || backstop);
      const bestScore = best ? best.score : 0;

      if (best && supportsClaim(best, sent, CITE_FLOOR)) {
        if (!seenCite.has(best.i)) { seenCite.add(best.i); cites.push({ docId: doc.id, idx: best.i }); }
        citedCount++;
        return `${sent} {{cite:${doc.id}:${best.i}:s${best.i}}}`;
      }

      // Mid-tier: a synthesis across spans — known names spread over several
      // source sentences, none of which carries them all. Bind an inference.
      if (bestScore >= CITE_FLOOR / 2) {
        const names = (sent.match(/\b[A-Z][a-zA-Z]+\b/g) || [])
          .filter(w => !/^(The|A|An|It|This|That|These|Those|What|When|Where|Who|Why|How|And|But|Or|So|Yet|If|Because|While|Though|Although|Since)$/.test(w))
          .filter(w => bodyJoined.includes(w));
        const supporters = ranked.filter(h => spanIdx.has(h.i)).slice(0, 2);
        const oneCovers = names.length && supporters.some(h => names.every(n => (sentenceTexts[h.i] || '').includes(n)));
        if (names.length && supporters.length >= 2 && !oneCovers) {
          const a = supporters[0].i, b = supporters[1].i;
          inferCount++;
          return `${sent} {{infer:${doc.id}:${a}+${b}:span}}`;
        }
      }

      // Low: an invented proper noun the grounder caught (rare post-EVA).
      if (bestScore < CITE_FLOOR / 2) {
        const ghost = (sent.match(/\b[A-Z][a-zA-Z]+\b/g) || [])
          .filter(w => !/^(The|A|An|It|This|That|These|Those|What|When|Where|Who|Why|How|And|But|Or|So|Yet|If|Because|While|Though|Although|Since)$/.test(w))
          .find(w => !bodyJoined.includes(w));
        if (ghost) { absentCount++; return `${sent} {{absent:${ghost}}}`; }
      }

      // Otherwise an unbound integration from the reading.
      integrationCount++;
      return sent;
    }).join(' ');

    const totalSentences = parts.filter(s => s.trim()).length;
    const bound = citedCount + inferCount;
    const status = absentCount ? 'warn' : (integrationCount ? 'notes' : 'clean');
    const grounded = absentCount === 0 && citedCount > 0;
    const note = `${bound}/${totalSentences} sentences cited`
      + (integrationCount ? `; ${integrationCount} are integrations from the reading.` : '.')
      + (absentCount ? ` ${absentCount} flagged absent (invented).` : '');

    return {
      text: out,
      cites,
      audit: { status, grounded, covers: `${bound}/${totalSentences}`, stable: true, note },
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
    // On a Gutenberg text the apparatus (the boilerplate, the author named in
    // the header, the language) is dropped from the figures via the same cast
    // the cast view uses, and the metadata header lines drop from the spine; the
    // keep-set then also filters the assertions and relations so a dropped name
    // can't return as "X is English". Off the Gutenberg path keep === null and
    // every branch reads p.* unchanged — byte-identical to before (parity floor).
    const meta = docMetadata(doc);
    let heavy = p.heavy, spine = p.spine, keep = null;
    if (meta.isGutenberg) {
      // The cast view's filter (boilerplate + header/licence-only names), plus a
      // figure whose name IS the declared author or language — "Joseph Conrad",
      // "English" recur in the body, so the cast keeps them, but as the figures a
      // book "turns most on" they are apparatus. Exact match only, so a character
      // who merely shares a word with the credits is never dropped.
      const identity = new Set();
      for (const k of ['author', 'editor', 'translator', 'illustrator', 'language']) {
        const v = meta.fields && meta.fields[k];
        if (v) identity.add(String(v).toLowerCase().trim());
      }
      keep = new Set(castEntities(doc).map(e => String(e.name)));
      for (const nm of [...keep]) if (identity.has(String(nm).toLowerCase().trim())) keep.delete(nm);
      const trimmed = p.heavy.filter(e => keep.has(String(e.name)));
      if (trimmed.length) heavy = trimmed;
      spine = p.spine.filter(s => !/^\s*(?:Title|Author|Editor|Translator|Illustrator|Release date|Posting date|Language|Credits|Other information|Updated|Most recently updated|Original publication)\b\s*:?/i.test(String(s)));
      if (!spine.length) spine = p.spine;
    }
    const cites = [];
    const figs = heavy.map(e => {
      cites.push({ docId: doc.id, idx: e.sents[0] });
      return `${e.name} {{cite:${doc.id}:${e.sents[0]}:s${e.sents[0]}}}`;
    });
    const parts = [];
    const kindWord = doc._genre === 'transcript' ? 'transcript' : 'document';
    parts.push(`This ${doc._lang && doc._lang !== 'en' ? doc._lang + ' ' : ''}${kindWord} centers on ${figs.length > 1 ? figs.slice(0, -1).join(', ') + ' and ' + figs[figs.length - 1] : figs[0]}.`);
    const assertions = keep ? p.assertions.filter(a => keep.has(String(a.name))) : p.assertions;
    const heavyEdges = keep ? p.heavyEdges.filter(ed => keep.has(String(ed.aName)) && keep.has(String(ed.bName))) : p.heavyEdges;
    if (assertions.length) {
      parts.push('It says ' + assertions.map(a => `${a.name} is ${a.is}`).join('; ') + '.');
    }
    if (heavyEdges.length) {
      parts.push('The relations it draws: ' + heavyEdges.map(ed => `${ed.aName} ${ed.verb} ${ed.bName}`).join('; ') + '.');
    }
    if (spine.length > 1) {
      parts.push('Its sections: ' + spine.join(' · ') + '.');
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
    const evidence = entityEvidence(doc, query);
    if (!hits.length && !evidence.length) return {
      text: 'I read the document for that and didn’t find a passage that answers it cleanly, so I’d rather hold than guess. Try naming a person, place, or phrase from the text.',
      audit: { status: 'notes', grounded: true, covers: '0/1', stable: true, note: 'Held rather than invented — the page wouldn’t carry an answer.' },
    };
    const floor = 0.34;
    const used = hits.filter(h => h.score >= floor).slice(0, 3);
    const support = (used.length ? used : hits.slice(0, 1));
    // The graph's evidence for named referents JOINS the support — it never
    // displaces a genuine lexical hit (a synthetic score must not outrank
    // the floor) — so the assertion sentence rides along even when it never
    // carries the name (the naming-bridge case), and the mechanical answer
    // stops parroting a contentless naming line.
    {
      const have = new Set(support.map(h => h.i));
      for (const s of evidence) {
        if (have.has(s.i) || support.length >= 4) continue;
        support.push({ i: s.i, t: s.t, score: 0, overlap: 1 });
        have.add(s.i);
      }
    }
    const text = support.map(s => `${s.t} {{cite:${doc.id}:${s.i}:s${s.i}}}`).join(' ');
    const cov = coverage(query, support.map(s => s.t).join(' '));
    const full = cov.n >= cov.d;
    const cites = support.map(s => ({ docId: doc.id, idx: s.i }));
    // COVERAGE GATES THE BADGE — but a STRONG lexical hit overrides a thin
    // ratio. A long, multi-clause question inflates the denominator (every
    // content term counts), so a single sentence that genuinely answers it can
    // land under the floor on raw token ratio while still being the right line.
    // When the best supporting line is a strong lexical match — the same ≥0.5
    // bar routeTurn/referencesDoc already call a confident, answer-now hit —
    // holding it as "ungrounded" would contradict the router that sent the turn
    // here. So HOLD only when coverage is thin AND no strong anchor carries it;
    // a "covers 1/4" answer on weak hits still must not wear the green chip.
    const topScore = support.reduce((m, s) => Math.max(m, s.score || 0), 0);
    if (cov.d && cov.n / cov.d < COVERAGE_FLOOR && topScore < 0.5) return {
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
  /* ---------- CONFIRM/DENY: a proposition checked against the graph ----------
     "Is X the Y?", "he's not a speaker", "you said he was a speaker" are not
     content questions — they propose a proposition and ask the reading to
     check it. The grounded-QA frame mangles these (an assertion presented as
     a question reads as text to report on), but the graph answers them
     mechanically: parse the proposition, check it against the page's DEF
     assertions and SIG attribution slots, and return confirmed-with-cite /
     contradicted-with-cite / absence-attested ⊥. No model required. This is
     the first real consumer of traversal-grade structure at answer time. */
  const _CONFIRM_META_RE = /^\s*(?:so|but|and|well|also|again|no|yes|ok(?:ay)?)[,—–\s]+/i;
  const _CONFIRM_FRAME_RE = /^\s*(?:you\s+(?:said|told\s+me|claimed|mentioned|wrote|implied)(?:\s+(?:that|earlier|before))*[,:\s]+|(?:it\s+)?(?:sounds?|seems?|looks?)\s+like\s+|i\s+thought\s+(?:that\s+)?)/i;
  // a Name run may carry digit words ("Speaker 4", "Apollo 11") — the digits
  // are part of the label, and a transcript's voices are named exactly this way
  const _CAP_RUN = '\\p{Lu}[\\p{L}’\'\\-]*(?:\\s+(?:\\p{Lu}[\\p{L}’\'\\-]*|\\d+))*';
  // A proposition can also lead with an article-led noun phrase ("The treaty
  // was signed…", "A delegate spoke…") — a real common-noun head after the
  // article, NOT a discourse filler ("the thing is…", "the point is…"). The
  // head stays lower-case, so a proper-name run ("The Hague") still parses as
  // a _CAP_RUN name rather than an article phrase.
  const _ART_SUBJ = '(?:[Tt]he|[Aa]n?)\\s+\\p{Ll}[\\p{Ll}’\'\\-]*(?:\\s+\\p{Ll}[\\p{Ll}’\'\\-]*)*';
  const _PROP_SUBJ = '(?:' + _CAP_RUN + '|' + _ART_SUBJ + '|[Hh]e|[Ss]he|[Ii]t|[Tt]hey)';
  const _PROP_FILLER = new Set('thing things point problem problems fact facts truth idea ideas question questions answer answers deal issue issues reason reasons way ways case cases matter matters trouble catch kicker difference rest'.split(' '));
  // The finite verb that heads a verb-predicate proposition ("Mara FOUNDED
  // Veldmar", "Shakespeare WROTE Hamlet"): a regular -ed past or a closed set
  // of common irregular pasts. Bare-stem imperatives ("tell", "list", "show")
  // and function words never match, so an INSTRUCTION is never read as a CLAIM
  // — only an assertion the page can actually be checked against.
  // IRREG_PAST is the irregular_past_verbs convention, built in rebuildLangSets.
  function _isPredVerb(w) {
    const x = String(w == null ? '' : w).toLowerCase().replace(/[^a-z]/g, '');
    return IRREG_PAST.has(x) || /^[a-z]{3,}ed$/.test(x);
  }
  // Does an ordered token phrase sit as a CONTIGUOUS run inside a token list?
  // The DEF check uses this instead of unordered set-membership: a predicate's
  // head words must appear TOGETHER and IN ORDER in the page's own assertion,
  // so a value that merely happens to contain both words apart ("the minister
  // kept a white dog") no longer false-confirms "the white minister".
  function _phraseRun(needle, hay) {
    if (!needle.length || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
  function parseProposition(sent) {
    let s = String(sent == null ? '' : sent).trim().replace(/[.?!]+\s*$/, '');
    let m = _CONFIRM_META_RE.exec(s); if (m) s = s.slice(m[0].length).trim();
    for (let i = 0; i < 3; i++) { m = _CONFIRM_FRAME_RE.exec(s); if (m && m[0].length) s = s.slice(m[0].length).trim(); else break; }
    s = s.replace(/[,;]?\s*(?:right|correct|true|no|yes)\s*$/i, '').trim();
    let subject = null, negated = false, predicate = null, verbal = false;
    // interrogative: "Is SUBJ (not) PRED" — the copula leads
    m = new RegExp('^(?:[Ii]s|[Ww]as|[Aa]re|[Ww]ere)\\s+(' + _PROP_SUBJ + ')\\s+(not\\s+)?(.+)$', 'u').exec(s);
    if (m) { subject = m[1]; negated = !!m[2]; predicate = m[3]; }
    if (!subject) {
      // declarative: "SUBJ is (not|never) PRED" / "SUBJ isn't PRED" / "he's (not) PRED"
      m = new RegExp('^(' + _PROP_SUBJ + ')\\s+(?:is|was|are|were)\\s+(not\\s+|never\\s+)?(.+)$', 'u').exec(s)
        || new RegExp('^(' + _PROP_SUBJ + ')\\s+(?:isn’?\'?t|wasn’?\'?t|aren’?\'?t|weren’?\'?t)\\s+()(.+)$', 'u').exec(s)
        || new RegExp('^([Hh]e|[Ss]he|[Ii]t|[Tt]hey)[’\']s\\s+(not\\s+)?(.+)$', 'u').exec(s);
      if (m) {
        subject = m[1];
        negated = m[2] === '' ? true : !!m[2];   // the n't branch captures '' and is always negated
        predicate = m[3];
      }
    }
    if (!subject) {
      // role-verb form: "SUBJ (never|did not) (speak|spoke)" → the speaker
      // role. A leading do-auxiliary ("Did MAYOR speak?") is dropped first.
      const s2 = s.replace(/^(?:[Dd]id|[Dd]oes|[Dd]o)\s+/, '');
      m = new RegExp('^((?:' + _CAP_RUN + ')|[Hh]e|[Ss]he|[Tt]hey)\\s+(never\\s+|did\\s+not\\s+|didn’?\'?t\\s+|not\\s+)?(?:spoke|speaks?)\\b', 'u').exec(s2);
      if (m) { subject = m[1]; negated = !!m[2]; predicate = 'a speaker'; }
    }
    if (!subject) {
      // verb-predicate form: "SUBJ <finite verb> <object>" ("Mara Velasquez
      // founded Veldmar", "Shakespeare wrote Hamlet"). A negating auxiliary
      // ("did not" / "never") flips it and frees the verb to be a base stem;
      // otherwise the verb must carry finite morphology (so a bare instruction
      // — "Tell me everything" — is never mistaken for a claim about "Tell").
      const mv = new RegExp('^(' + _PROP_SUBJ + ')\\s+(did\\s+not\\s+|didn’?\'?t\\s+|does\\s+not\\s+|doesn’?\'?t\\s+|never\\s+)?([a-z][a-z’\'\\-]*)\\s+(\\S.*)$', 'u').exec(s);
      if (mv && (!!mv[2] || _isPredVerb(mv[3]))) {
        subject = mv[1]; negated = !!mv[2]; predicate = (mv[3] + ' ' + mv[4]).trim(); verbal = true;
      }
    }
    if (!subject || !predicate) return null;
    // an article-led subject must have a real noun head, not a discourse filler
    // ("the thing is…", "the point is…") that only looks like a proposition.
    if (/^(?:the|an?)\s/i.test(subject) && _PROP_FILLER.has(subject.trim().split(/\s+/).pop().toLowerCase())) return null;
    if (!verbal) predicate = predicate.replace(/^(?:a|an|the)\s+/i, '').trim();
    if (!predicate) return null;
    return { subject: subject.trim(), negated, predicate, verbal };
  }
  function answerConfirm(doc, query, opts = {}) {
    if (!doc || doc.kind !== 'prose') return null;
    const props = [];
    for (const sent of splitDraft(query)) {
      const p = parseProposition(sent);
      if (p) props.push(p);
    }
    if (!props.length) return null;
    const { entities } = projectEntities(doc);
    const genre = doc._genre === 'transcript' ? 'transcript' : 'document';
    const body = docBodyLC(doc);
    const defs = assertionsOf(doc);
    const checks = [], lines = [], cites = [];
    let evidenced = 0, worst = 'clean';
    const rank = { clean: 0, notes: 1, warn: 2 };
    const bump = (st) => { if (rank[st] > rank[worst]) worst = st; };
    const cite = (i) => { if (i != null) { cites.push({ docId: doc.id, idx: i }); return ` {{cite:${doc.id}:${i}:s${i}}}`; } return ''; };
    for (const p of props) {
      // resolve the subject: an anaphor goes to the conversation's hottest
      // entity (the caller supplies it); a name resolves onto the projection
      let name = p.subject;
      if (/^(?:he|she|it|they)$/i.test(name)) {
        if (!opts.hotEntity) return null;
        name = String(opts.hotEntity);
      }
      const k = normSurface(name);
      const ent = entities.find(e => e.key === k)
        || (k.length >= 4 ? entities.find(e => _keyWithin(k, e.key) || _keyWithin(e.key, k)) : null);
      if (!ent && !body.includes(name.toLowerCase())) return null;   // absent subject → the anti-matter void answers instead
      const subject = ent ? ent.name : name;
      const subjKey = ent ? ent.key : k;
      // VERB-PREDICATE claim ("X founded Y", "The treaty established Z") — the
      // graph holds no copula DEF for a transitive verb, so it is checked
      // against the PROSE directly, never against lexical overlap. A single
      // sentence that mentions the subject, then the verb, then the object IN
      // ORDER and unnegated, asserts it (confirmed, cited). Anything less is
      // silence — attested as silence (⊥ with a receipt), so a false premise
      // comes back unattested instead of stamped "grounded" by retrieval.
      if (p.verbal) {
        const texts = doc.sentenceTexts || [];
        const vtok = tok(p.predicate);
        const verb = vtok[0], objToks = vtok.slice(1);
        const sents = ent ? ent.sents
          : texts.map((_, i) => i).filter(i => (texts[i] || '').toLowerCase().includes(subject.toLowerCase()));
        let hit = null;
        for (const i of sents) {
          const raw = texts[i] || '';
          const st = tok(raw);
          const vi = verb ? st.indexOf(verb) : -1;
          if (vi < 0) continue;
          let pos = vi + 1, ok = objToks.length > 0;
          for (const t of objToks) { const at = st.indexOf(t, pos); if (at < 0) { ok = false; break; } pos = at + 1; }
          if (!ok) continue;
          if (/\b(?:not|never|cannot|no longer)\b|n['’]t\b/i.test(raw)) continue;  // a denial isn't a confirmation
          hit = i; break;
        }
        if (hit != null && !p.negated) {
          lines.push(`Yes — the page states this: “${texts[hit]}”${cite(hit)}`);
          checks.push({ ...p, subject, verdict: 'confirmed' }); evidenced++;
        } else if (hit != null && p.negated) {
          lines.push(`No — the page does state that ${subject} ${p.predicate}.${cite(hit)} The denial contradicts the page.`);
          checks.push({ ...p, subject, verdict: 'contradicted' }); evidenced++;
        } else if (p.negated) {
          lines.push(`Nothing on the page asserts that ${subject} ${p.predicate}, so the denial stands unchallenged. {{absent:${doc.id}:no sentence asserts that ${subject} ${p.predicate}}}`);
          checks.push({ ...p, subject, verdict: 'confirmed-by-absence' }); evidenced++;
        } else {
          lines.push(`The page never asserts that ${subject} ${p.predicate}. I checked every line that mentions ${subject}, and none makes that claim. {{absent:${doc.id}:no sentence asserts that ${subject} ${p.predicate}}}`);
          checks.push({ ...p, subject, verdict: 'unattested' }); bump('warn');
        }
        continue;
      }
      const predHead = tok(p.predicate).slice(0, 2);
      // 1) the page's own DEF assertions — claim against claim. The predicate's
      // head words must sit TOGETHER and IN ORDER inside the page's assertion (a
      // contiguous phrase), not merely co-occur unordered — otherwise a value
      // that happens to contain both head words apart would false-confirm.
      const held = predHead.length ? defs.find(d =>
        (d.key === subjKey || (subjKey.length >= 4 && (_keyWithin(subjKey, d.key) || _keyWithin(d.key, subjKey))))
        && _phraseRun(predHead, tok(d.is))) : null;
      if (held) {
        if (!p.negated) lines.push(`Yes — the page itself asserts ${subject} is ${held.is}.${cite(held.sent)}`);
        else lines.push(`No — the page itself asserts ${subject} is ${held.is}${cite(held.sent)} — the denial contradicts the page.`);
        checks.push({ ...p, subject, verdict: p.negated ? 'contradicted' : 'confirmed' });
        evidenced++;
        continue;
      }
      // 2) a speaking-role claim is checkable against the SIG attribution slots
      if (SPEAKING_ROLE_RE.test(p.predicate)) {
        const r = holdsSpeakerSlot(doc, subject);
        if (r.holds) {
          if (!p.negated) lines.push(`Yes — this ${genre} attributes ${r.turns} turn${r.turns === 1 ? '' : 's'} to ${r.label || subject}.${cite(r.sent)}`);
          else lines.push(`No — this ${genre} does attribute speech to ${r.label || subject}.${cite(r.sent)}`);
          checks.push({ ...p, subject, verdict: p.negated ? 'contradicted' : 'confirmed' });
        } else {
          const receipt = `${subject} holds no speaker slot in ${r.events} attribution events`;
          if (p.negated) lines.push(`Confirmed — I scanned all ${r.events} attribution events in this ${genre}, and ${subject} never holds the speaker slot. {{absent:${doc.id}:${receipt}}}`);
          else lines.push(`The page doesn’t support that: across ${r.events} attribution events in this ${genre}, ${subject} never holds the speaker slot. {{absent:${doc.id}:${receipt}}}`);
          checks.push({ ...p, subject, verdict: p.negated ? 'confirmed-by-absence' : 'denied-by-absence' });
        }
        evidenced++;
        continue;
      }
      // 3) nothing on the page asserts it — attest the silence (⊥ with a scan
      // receipt), and show the closest line only as context, never as support
      const near = ent ? ent.sents.find(i => { const st = new Set(tok(doc.sentenceTexts[i])); return predHead.length && predHead.every(t => st.has(t)); }) : null;
      const nDefs = defs.filter(d => d.key === subjKey).length;
      const receipt = `no recorded assertion attaches “${p.predicate}” to ${subject} (${nDefs} assertion${nDefs === 1 ? '' : 's'}, ${speakersOf(doc).events} attributions scanned)`;
      if (near != null) {
        lines.push(`The page never asserts that ${subject} ${p.negated ? 'is not' : 'is'} ${p.predicate} — the closest it comes is this line, which links the terms without making the claim.${cite(near)}`);
        checks.push({ ...p, subject, verdict: 'unattested' });
        bump('notes');
      } else if (p.negated) {
        lines.push(`Nothing on the page contradicts that — it never calls ${subject} ${p.predicate} anywhere. {{absent:${doc.id}:${receipt}}}`);
        checks.push({ ...p, subject, verdict: 'confirmed-by-absence' });
        evidenced++;
      } else {
        lines.push(`The page never asserts that ${subject} is ${p.predicate}. I checked its recorded assertions and attributions for ${subject}, and nothing attaches it. {{absent:${doc.id}:${receipt}}}`);
        checks.push({ ...p, subject, verdict: 'unattested' });
        bump('warn');
      }
    }
    if (!lines.length) return null;
    return {
      text: lines.join(' '),
      cites, checks,
      audit: {
        status: worst, grounded: true, covers: `${evidenced}/${props.length}`, stable: true,
        note: 'A proposition checked mechanically against the graph — the page’s recorded assertions and attribution slots, with absence attested by a full scan (⊥ with a receipt). No model involved.',
      },
    };
  }
  // CONFIRM over the scope: the first source whose graph can check the
  // proposition answers it. Null when none can — the caller keeps its path.
  function answerConfirmScope(docs, query, opts) {
    for (const d of scopeDocs(docs)) {
      if (d.kind === 'table') continue;
      let r = null; try { r = answerConfirm(d, query, opts); } catch (e) {}
      if (r) return r;
    }
    return null;
  }

  // ── About the html / the de-chroming ────────────────────────────────────
  // The chrome vocabulary itself — stripped from a query before it drives the
  // full-content retrieval, so "what does the footer say about the Bugle" lands
  // on the masthead line, not on the words "footer"/"say" as content.
  const ABOUT_CHROME_STOP = new Set(['html','markup','tag','tags','chrome','dechrome','boilerplate','nav','navigation','navbar','menu','footer','header','headers','byline','bylines','copyright','masthead','furniture','apparatus','page','raw','strip','stripped','remove','removed','removing','cut','gate','gated','exclude','excluded','what','did','you','the','from','about','this','that','show','list','tell','was','were','are','set','aside','left','out']);
  const _DECHROME_REASON_LABEL = {
    'chrome:share': 'share / social row', 'chrome:subscribe': 'subscription appeal',
    'chrome:meta': 'article meta', 'chrome:nav': 'navigation / menu', 'chrome:signin': 'sign-in / account',
    'chrome:copyright': 'copyright line', 'chrome:byline': 'byline', 'chrome:rule': 'horizontal rule',
    'chrome:frontmatter': 'front-matter heading', 'chrome:numbering': 'page / section number',
    'chrome:transcriber': 'transcriber note', 'chrome:heading': 'heading', 'chrome:apparatus': 'apparatus',
  };
  // Is this turn about the page's html / chrome / the de-chroming itself? A
  // standalone predicate (NOT one of classifyIntent's four), so the intent enum
  // and its consumers are untouched. Conservative: it only ever fires a route
  // when a loaded source actually carries chrome (answerAboutChrome returns
  // null otherwise), so it can never hijack an ordinary turn.
  function aboutChrome(query) {
    const t = ' ' + String(query == null ? '' : query).toLowerCase().replace(/[’']/g, "'") + ' ';
    return /\b(de-?chrom\w*|boilerplate|page chrome|page furniture|raw (?:page|html|markup|source)|the html|html (?:tags?|markup|source)|nav(?:igation)?(?: bar)?|navbar|footer|header|masthead|byline|share (?:buttons?|row|links?)|cookie banner)\b/.test(t)
        || /\bwhat (?:did you|was|got|have you) (?:strip\w*|remov\w*|cut|set aside|gate\w*|exclud\w*|le[fd]t out)\b/.test(t)
        || /\b(?:show|list|what'?s in)\b[^?]*\b(chrome|boilerplate|footer|header|nav\w*|byline|apparatus|stripped)\b/.test(t);
  }
  // Answer a turn about the chrome mechanically, from the document's structure
  // band — never phrased by the model. Two moves: (1) query the FULL content
  // (the stripped band included) for any substantive term the question carries
  // beyond the chrome vocabulary — the "full content gets queried against" path,
  // landing cited on the actual chrome line; then (2) the de-chroming report —
  // what was set aside, block by block, each cited to its first line. Null on a
  // doc with no chrome, so it never claims an ordinary turn.
  function answerAboutChrome(doc, query, opts = {}) {
    if (!doc || doc.kind !== 'prose') return null;
    const dc = doc._dechrome || computeDechrome(doc);
    if (!dc || !dc.present) return null;
    const texts = doc.sentenceTexts || [];
    const cites = [];
    const cite = (i) => { if (i != null && texts[i] != null) { cites.push({ docId: doc.id, idx: i }); return ` {{cite:${doc.id}:${i}:s${i}}}`; } return ''; };
    const lines = [];
    const chromeSet = new Set(dc.spans);
    const qTerms = [...new Set(tok(query))].filter(t => t.length > 2 && !ABOUT_CHROME_STOP.has(t));
    let hits = [];
    if (qTerms.length) {
      try { hits = retrieve(doc, qTerms.join(' '), 4, { includeChrome: true }).filter(h => chromeSet.has(h.i)); } catch (e) {}
    }
    if (hits.length) {
      lines.push('From the page’s chrome (set aside as structure, kept verbatim and queried here against your question):');
      for (const h of hits) lines.push(`• “${texts[h.i]}”${cite(h.i)}`);
      lines.push('');
    }
    const nBlocks = dc.segments.length;
    lines.push(dc.web
      ? `This page came in wrapped in web chrome. I read past it — it stays in the page, but it minted no people, places, or claims. ${dc.count} line${dc.count === 1 ? '' : 's'} across ${nBlocks} block${nBlocks === 1 ? '' : 's'} were set aside:`
      : `I kept ${dc.count} line${dc.count === 1 ? '' : 's'} of apparatus in the page but read ${dc.count === 1 ? 'it' : 'them'} as structure, not prose:`);
    for (const seg of dc.segments) {
      const label = _DECHROME_REASON_LABEL[seg.reason] || seg.reason.replace(/^chrome:/, '');
      lines.push(`• ${label}: “${seg.sample}”${cite(seg.idxs[0])}`);
    }
    return {
      text: lines.join('\n'),
      cites,
      audit: {
        status: 'clean', grounded: true, covers: `${dc.count}/${dc.count}`, stable: true,
        note: 'A de-chroming report read mechanically from the document’s structure band — the lines the chrome gate set aside, kept verbatim in the page (non-destructive) and queried here against the full content. No model involved.',
      },
    };
  }
  // About-the-chrome over the scope: the first source that carries a de-chroming
  // verdict answers. Null when none does — the caller keeps its path.
  function answerDechromeScope(docs, query, opts) {
    for (const d of scopeDocs(docs)) {
      if (d.kind === 'table') continue;
      let r = null; try { r = answerAboutChrome(d, query, opts); } catch (e) {}
      if (r) return r;
    }
    return null;
  }

  function answer(doc, query, opts) {
    if (!doc) return { text: 'Load a document or spreadsheet first — drop a file or paste text, and I’ll read it locally.', audit: null };
    if (doc.kind === 'table') return answerTable(doc, query);
    // A turn about the page's html / chrome / the de-chroming itself is read
    // against the full content (the stripped band included) and answered
    // mechanically from the structure band, never phrased by the model. Inert on
    // a doc with no chrome (returns null → falls through), so parity holds.
    if (aboutChrome(query)) { const dc = answerAboutChrome(doc, query, opts); if (dc) return dc; }
    const intent = classifyIntent(query);
    if (intent === 'who') return answerWho(doc);
    if (intent === 'summary') return answerSummary(doc);
    if (intent === 'confirm') {
      // a proposition the graph can check is answered claim-against-claim;
      // one it can't parse falls through to the ordinary grounded path
      const checked = answerConfirm(doc, query, opts);
      if (checked) return checked;
    }
    // a definitional ask about a referent the graph holds assertions for is
    // answered from the assertions themselves — the page's own record of what
    // the name IS, not whichever sentence shares the most tokens
    const defined = answerDefine(doc, query, opts);
    if (defined) return defined;
    // a specific-aspect ask about a present subject reads only the sentences
    // that speak to that aspect, or says the page doesn't cover it — never the
    // subject's unrelated facts dragged in by name overlap (B5.1)
    const aspectAns = answerAspect(doc, query, opts);
    if (aspectAns) return aspectAns;
    // a kin-shaped ask ("whose son…?") is answered from the possessive-kin
    // record — the possessor named outright, which the raw sentence can't do
    const kin = answerKin(doc, query, opts);
    if (kin) return kin;
    return answerProse(doc, query, opts);
  }

  /* retrieval context for the optional LLM path — intent-aware. For a
     factual ask, the graph's own evidence for any NAMED referent joins the
     retrieved passages (deduped), so an assertion recorded about the name in
     a sentence that never carries the name still reaches the model. */
  function context(doc, query, k = 6) {
    if (!doc || doc.kind === 'table') return '';
    const intent = classifyIntent(query);
    if (intent === 'summary') return salientContext(doc, query);
    if (intent === 'who') return entityContext(doc);
    const hits = retrieve(doc, query, k);
    const have = new Set(hits.map(h => h.i));
    const lines = hits.map(s => `[s${s.i}] ${s.t}`);
    for (const s of entityEvidence(doc, query)) if (!have.has(s.i)) { lines.push(`[s${s.i}] ${s.t}`); have.add(s.i); }
    const heads = [];
    // A definitional ask opens with the page's assertions about the name —
    // the graph speaks first (same format the depth>1 walk uses, so citation
    // binding is untouched); the model only phrases over it, and its draft is
    // vetoed against these same assertions. A signal, never a tie-breaker.
    const da = defineAssertions(doc, query);
    if (da && da.picked.length) {
      heads.push('What the page asserts about ' + da.subject + ':');
      for (const d of da.picked)
        heads.push(`- ${d.subject} ${d.path === 'role' ? '' : 'is '}${deAnaphorDef(d.is)}` + (d.sent != null ? ` [s${d.sent}]` : '') + '.');
    }
    // A kin-shaped ask opens with the resolved possessive — the kin sentence
    // alone says WHOSE only through a pronoun a small model cannot read; the
    // record names the possessor and the anchor line rides along as evidence.
    const asked = kinAsked(query);
    if (asked.length) {
      const texts = doc.sentenceTexts || [];
      const recs = kinRecords(doc).filter(r => asked.includes(r.kin) || asked.includes(r.kin + 's'));
      for (const r of recs.slice(0, 2)) {
        heads.push(`${heads.length ? '' : 'What the page records:\n'}- the ${r.kin} mentioned${r.sent != null ? ' at [s' + r.sent + ']' : ''} is ${r.possessor}’s.`);
        for (const i of [r.sent, r.anchor]) {
          if (i != null && !have.has(i) && texts[i]) { lines.push(`[s${i}] ${texts[i]}`); have.add(i); }
        }
      }
    }
    if (heads.length) return heads.join('\n') + '\n\nPassages:\n' + lines.join('\n');
    return lines.join('\n');
  }
  /* ---------- splitting a draft into claim-sentences ----------
     The naive [.!?] split cuts "Mr. Steven Watts" after "Mr." — each fragment
     then retrieves independently, scattering cite chips mid-name and inflating
     the cited fraction that decides `grounded`. The DOCUMENT segmenter already
     rejoins after the ruliad's sentence_abbreviations; the draft splitter never
     did. Same set, same move: a part ending in a title abbreviation or a
     single-letter initial is rejoined onto the next. Shared by the binders and
     the propositional veto, so a claim is audited whole. */
  function splitDraft(text) {
    const s = String(text == null ? '' : text);
    const raw = s.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [s];
    const out = [];
    for (const part of raw) {
      const prev = out.length ? out[out.length - 1] : null;
      const tail = prev && /(?:^|[\s("'“‘\[])([\p{L}]{1,7})\.\s*$/u.exec(prev);
      if (tail && (/^\p{Lu}$/u.test(tail[1]) || (ABBREVIATIONS && ABBREVIATIONS.has(tail[1].toLowerCase()))))
        out[out.length - 1] = prev + part;
      else out.push(part);
    }
    return out.length ? out : [s];
  }

  /* ---------- does a retrieved line actually SUPPORT a claim? ----------
     The retrieval score normalizes by the CANDIDATE's substantive length only,
     so a two-token line ("Thank you.") scores 1/√2 ≈ 0.71 on a single shared
     token and outranks every real sentence — junk chrome becomes the highest-
     scoring match for ANY claim sharing one word, and a false claim wears a
     clean cite. Support needs more than token existence: a one-token overlap
     can only support a claim with nothing else to say, and a junk-short line
     must be wholly consumed by the claim to count at all. */
  function supportsClaim(cand, claim, floor) {
    if (!cand || cand.score < floor) return false;
    const claimSize = new Set(tok(claim)).size;
    const candSize = new Set(tok(cand.t)).size;
    if (cand.overlap < 2 && claimSize > 2) return false;
    if (candSize < 3 && cand.overlap < candSize) return false;
    return true;
  }

  /* ---------- absence attestation: citing ⊥ with a receipt ----------
     A negative existential ("the text does not mention him as a speaker") is a
     claim about the WHOLE document — no single line can support it, so the
     binder used to lash it to whatever short line shared a token: a nonsense
     cite stamped onto a true claim. Retrieval can never ground a negative;
     only a scan can. These verify absence mechanically — every attribution
     event checked, the body checked — and the claim cites ⊥ with the receipt:
     the same epistemic move the anti-matter void makes for absent terms,
     extended to absent roles and absent mentions. */
  function speakersOf(doc) {
    const speakers = new Map(); let events = 0;
    if (!doc || !doc._events) return { speakers, events };
    for (const ev of doc._events) {
      if (ev.op !== 'SIG') continue;
      events++;
      const name = (ev.speakerHint && ev.speakerHint.name) || ev.speaker;
      if (!name || name === '?') continue;
      const k = normSurface(String(name));
      if (!k) continue;
      if (!speakers.has(k)) speakers.set(k, { name: String(name), first: ev.sentence_idx != null ? ev.sentence_idx : null, turns: 0 });
      speakers.get(k).turns++;
    }
    return { speakers, events };
  }
  // Does NAME ever hold the speaker slot? Word-boundary containment both ways
  // ("dresser" ⊂ "amos dresser"). The counts are the receipt: what was scanned.
  function holdsSpeakerSlot(doc, name) {
    const { speakers, events } = speakersOf(doc);
    const k = normSurface(String(name == null ? '' : name));
    if (!k) return { holds: false, sent: null, turns: 0, events };
    for (const [sk, v] of speakers) {
      if (sk === k || (k.length >= 4 && (_keyWithin(k, sk) || _keyWithin(sk, k))))
        return { holds: true, sent: v.first, turns: v.turns, events, label: v.name };
    }
    return { holds: false, sent: null, turns: 0, events };
  }
  const ABSENCE_SHAPE_RE = /\b(?:do(?:es)?\s*not|do(?:es)?n'?t|did\s+not|didn'?t|never|no(?:where)?)\b[^.!?]*\b(?:mention(?:s|ed)?|name(?:s|d)?|identif(?:y|ies|ied)|specif(?:y|ies|ied)|state(?:s|d)?|say(?:s)?|said|describe(?:s|d)?|list(?:s|ed)?|provide(?:s|d)?|appear(?:s|ed)?|attribute(?:s|d)?|record(?:s|ed)?|credit(?:s|ed)?)\b/i;
  const ABSENCE_PASSIVE_RE = /\b(?:is|was|are|were)\s+(?:not|never)\s+(?:mentioned|named|identified|specified|stated|described|listed|provided|attributed|recorded|credited)\b|\bno\s+mention\s+of\b/i;
  const SPEAKING_ROLE_RE = /\b(?:speaker|speakers|spoke|speaks|speaking|speech)\b/i;
  // A claim-sentence asserting absence. Returns the receipt string when the
  // absence VERIFIES against the events/body — null when the sentence isn't
  // absence-shaped, can't be resolved to a subject, or the page in fact
  // carries what it denies (a false denial binds nothing and drags `grounded`
  // down, which is the honest outcome).
  function absenceClaim(doc, sent, hint) {
    const s = String(sent == null ? '' : sent);
    if (!(ABSENCE_SHAPE_RE.test(s) || ABSENCE_PASSIVE_RE.test(s))) return null;
    const roleClaim = SPEAKING_ROLE_RE.test(s);
    const { matter, antimatter } = referents(doc, s);
    let subjects = matter.concat(antimatter);
    // an anaphoric subject ("…does not mention HIM as a speaker") resolves to
    // the conversation's hottest entity, supplied by the caller
    if (!subjects.length && hint && /\b(?:he|she|him|her|they|them|his|hers|their)\b/i.test(s)) subjects = [String(hint)];
    if (!subjects.length) return null;
    const receipts = [];
    for (const name of subjects) {
      if (antimatter.includes(name)) {
        // absent from the BODY, but a transcript voice lives in the graph with
        // its label stripped from the prose ("Speaker 4") — structure-present,
        // and a denial about it must be checked, not waved through as absence
        if (holdsSpeakerSlot(doc, name).holds) return null;
        receipts.push(`“${name}” appears nowhere in this source`);
        continue;
      }
      if (roleClaim) {
        const r = holdsSpeakerSlot(doc, name);
        if (r.holds) return null;            // the page DOES attribute a line — the denial is false
        receipts.push(`${name} holds no speaker slot in ${r.events} attribution events`);
        continue;
      }
      return null;   // a present name and no checkable role — a scan can't verify this denial
    }
    return receipts.join('; ');
  }

  // bind [sN] citations onto an LLM answer mechanically (model never writes them)
  function bindCitations(doc, answerText, query, intent, opts) {
    const floor = CITE_FLOOR;
    const clean = answerText.replace(/\[s?\d+\]/gi, '').replace(/\s+([.,;:])/g, '$1').trim();
    const parts = splitDraft(clean);
    const cited = [];
    let attested = 0;
    const out = parts.map(sent => {
      // a negative existential can never be supported by one line — attest it
      // against the events instead of lashing it to whatever shared a token
      const receipt = absenceClaim(doc, sent, opts && opts.hotEntity);
      if (receipt) { attested++; return `${sent.trim()} {{absent:${doc.id}:${receipt}}}`; }
      const cands = retrieve(doc, sent, 1);
      if (cands.length && supportsClaim(cands[0], sent, floor)) { cited.push({ docId: doc.id, idx: cands[0].i }); return `${sent.trim()} {{cite:${doc.id}:${cands[0].i}:s${cands[0].i}}}`; }
      return sent.trim();
    }).join(' ');
    const supported = cited.length + attested;
    const grounded = supported > 0 && supported >= parts.length * 0.5;
    const cov = (intent && intent !== 'factual') ? { n: 1, d: 1 } : coverage(query, parts.join(' '));
    return {
      text: out, cites: cited,
      audit: {
        status: grounded ? (cov.n >= cov.d ? 'clean' : 'notes') : 'warn',
        grounded, covers: `${cov.n}/${cov.d}`, stable: true,
        note: grounded ? 'Phrased by the local model; every citation bound mechanically to a re-read sentence.'
                         + (attested ? ' Absence claims attested against the event log (⊥ with a scan receipt).' : '')
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

  // ── Discourse precedence (B1/B1′): identity outranks lexical surface in
  // document binding, exactly as the SYN gate makes it outrank overlap one
  // layer down. The active discourse subject — carried across turns by the
  // conversation field, handed in as ctx.hotEntity — HOLDS the bound
  // document. A bare-pronoun follow-up ("what are his inspirations?") and a
  // follow-up that names the active subject ("what are SHORE's
  // inspirations?") both stay on the subject's document, even when a content
  // word ("inspirations") has its strongest lexical home in another source.
  // Lexical scoring may rank spans WITHIN the held document; it may not move
  // the document. Switching requires the query to name a DIFFERENT subject —
  // a genuine new referent — not a content noun whose keyword home is
  // elsewhere. Inert without an active subject (batch/parity callers pass
  // none), so unthreaded routing is byte-identical to today.
  function entityCoRefersName(entity, name) {
    const b = contentSeqOf(name);
    if (!b.length) return false;
    if (namesCoRefer(contentSeqOf(entity.name || entity.key || ''), b, false)) return true;
    for (const f of (entity.surfaceForms || [])) if (namesCoRefer(contentSeqOf(f), b, false)) return true;
    return false;
  }
  // The scope doc the active subject is recorded in (its entities carry a
  // cluster co-referent with hotName). Null when no source holds it.
  function activeSubjectDoc(ds, hotName) {
    if (!hotName) return null;
    for (const d of ds) {
      if (d.kind !== 'prose') continue;
      let ents = []; try { ents = projectEntities(d).entities || []; } catch (e) { continue; }
      if (ents.some(e => entityCoRefersName(e, hotName))) return d;
    }
    return null;
  }
  // The query names a subject that is NOT the active one — a real entity in
  // some scope doc, not co-referent with hotName. Returns the switch-target
  // doc, or null (the query introduces no competing subject → the active
  // subject holds).
  function queryNamesOtherSubject(ds, q, hotName) {
    for (const d of ds) {
      if (d.kind !== 'prose') continue;
      let ents = []; try { ents = projectEntities(d).entities || []; } catch (e) { continue; }
      const ql = ' ' + String(q).toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9'’\- ]+/g, ' ') + ' ';
      for (const e of ents) {
        const n = String(e.name).toLowerCase();
        let named = n.length >= 3 && ql.includes(' ' + n + ' ');
        if (!named) {
          const parts = n.split(/\s+/);
          named = parts.length > 1 && parts.some(p => p.length >= 4 && !GENERIC_VOICE_HEADS.has(p) && ql.includes(' ' + p + ' '));
        }
        if (named && !entityCoRefersName(e, hotName)) return d;
      }
    }
    return null;
  }
  // Discourse binding for a turn: { doc, hold } when the active subject
  // holds, { doc, switch } when the query names a different subject, null
  // when there's no active subject in scope (lexical decides). Pure read.
  function discourseBinding(ds, q, ctx) {
    if (!ctx || !ctx.hotEntity) return null;
    const subjDoc = activeSubjectDoc(ds, ctx.hotEntity);
    if (!subjDoc) return null;
    const other = queryNamesOtherSubject(ds, q, ctx.hotEntity);
    if (other && other.id !== subjDoc.id) return { doc: other, switch: true, from: subjDoc };
    return { doc: subjDoc, hold: true };
  }

  // The single source a turn is most about. Discourse precedence first (an
  // active subject holds its document); only then does lexical surface
  // decide — strongest retrieval, falling back to the first that
  // referencesDoc, then the first in scope.
  function routePrimary(docs, query, ctx) {
    const ds = scopeDocs(docs);
    if (!ds.length) return null;
    const bind = discourseBinding(ds, query, ctx);
    if (bind) return bind.doc;
    let best = null, bestScore = -1;
    for (const d of ds) {
      if (d.kind === 'table') continue;
      const h = retrieve(d, query, 1)[0];
      const s = h ? h.score : 0;
      // FIX 3d: on a score tie, a user / non-provisional doc beats a provisional
      // enrichment doc — a backstop so already-committed enrichment junk never
      // steals primary when discourse precedence (above) hasn't bound a subject.
      if (s > bestScore || (s === bestScore && best && best.provisional && !d.provisional)) { bestScore = s; best = d; }
    }
    if (best && bestScore > 0) return best;
    return ds.find(d => referencesDoc(d, query, ctx)) || ds.find(d => !d.provisional) || ds[0];
  }

  // Anti-matter across the whole scope: a named referent is matter if present in
  // ANY source, anti-matter only if absent from EVERY one. "What did Voss say?"
  // over two sources surfaces a void only when Voss is in neither.
  function referentsScope(docs, query) {
    const bodies = scopeDocs(docs).map(d => docBodyLC(d));
    const names = String(query).match(/\p{Lu}[\p{L}’'\-]+(?:\s+\p{Lu}[\p{L}’'\-]+)*/gu) || [];
    const nonRef = nonReferentialCaps(query);     // DEF: the type gate, ahead of presence
    const matter = [], antimatter = [];
    for (const raw of names) {
      const parts = raw.split(/\s+/);
      while (parts.length && QA_STOP.has(parts[0].toLowerCase())) parts.shift();
      while (parts.length && QA_STOP.has(parts[parts.length - 1].toLowerCase())) parts.pop();
      const sig = parts.filter(t => t.length > 2 && !QA_STOP.has(t.toLowerCase()));
      if (!sig.length) continue;
      // The fourth NUL state (mirrors referents): drop structural/pragmatic
      // tokens — a sentence-initial "Give"/"Based"/"Sure"/"What's" — before the
      // presence test, so they can never reach antimatter across the scope.
      const refSig = sig.filter(t => !nonRef.has(NRM_CAP(t)));
      if (!refSig.length) continue;
      const present = bodies.some(b => refSig.some(t => b.includes(t.toLowerCase())));
      (present ? matter : antimatter).push(parts.join(' '));
    }
    return { matter, antimatter };
  }

  // Mechanical answer over the scope. One source → the single-doc path verbatim.
  // Many → answer against the primary, but only flag voids that are absent from
  // EVERY source (a name living in another chip is not a void here). Cross-source
  // synthesis is the model's job (context across sources); this is the floor.
  function answerScope(docs, query, opts) {
    const ds = scopeDocs(docs);
    if (!ds.length) return answer(null, query);
    if (ds.length === 1) return answer(ds[0], query, opts);
    // Discourse precedence holds the active subject's document (opts.hotEntity
    // is the conversation field's current subject); without it, lexical wins.
    const primary = routePrimary(ds, query, opts) || ds[0];
    if (primary.kind === 'table') return answer(primary, query);
    const voidWhitelist = new Set(referentsScope(ds, query).antimatter);
    return answer(primary, query, { ...(opts || {}), voidWhitelist });
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
    // each source's graph evidence for named referents joins its passages,
    // same as the single-doc path
    for (const d of ds) {
      const have = new Set((byDoc.get(d.id) || []).map(h => h.i));
      for (const s of entityEvidence(d, query)) {
        if (have.has(s.i)) continue;
        if (!byDoc.has(d.id)) byDoc.set(d.id, []);
        byDoc.get(d.id).push({ ...s, docId: d.id });
        have.add(s.i);
      }
    }
    const nameOf = id => (ds.find(d => d.id === id) || {}).name || id;
    return [...byDoc.entries()]
      .map(([id, hs]) => `## ${nameOf(id)}\n` + hs.map(s => `[${id}:${s.i}] ${s.t}`).join('\n'))
      .join('\n\n');
  }

  /* ---------- tiered context: spans + notes ----------
     The grounded prompt's two epistemic levels. SPANS are verbatim sentences
     (trusted, citable); NOTES are the graph's own reading — assertions,
     resolved kin records — "usually right, sometimes wrong" in the prompt's
     voice. Same enrichment as context()/contextScope, parts-shaped, so the
     llm layer can present them as separate tiers instead of one blob. The
     blob builders stay untouched for the mechanical paths, the summary
     sample, and golden parity. */
  function contextParts(doc, query, k = 6) {
    if (!doc || doc.kind === 'table') return { spans: [], notes: [] };
    const spans = [], notes = [], have = new Set();
    // The fold leads the notes — the reader's standing overview of the whole
    // document (or the chapter the turn scoped to), so "what is this about" is
    // always answerable even on a turn whose retrieved passages are narrow.
    const fold = foldNote(doc, query);
    if (fold) notes.push(fold);
    // the header rides along whenever it exists — bibliographic questions
    // ("who wrote it?") are answered from here, not passage retrieval
    const metaLine = metadataNote(doc);
    if (metaLine) notes.push(metaLine);
    const texts = doc.sentenceTexts || [];
    const push = (i, t) => {
      const tx = t != null ? t : texts[i];
      if (i == null || have.has(i) || tx == null) return;
      have.add(i); spans.push({ docId: doc.id, idx: i, tag: 's' + i, text: tx });
    };
    for (const h of retrieve(doc, query, k)) push(h.i, h.t);
    for (const s of entityEvidence(doc, query)) push(s.i, s.t);
    const da = defineAssertions(doc, query);
    if (da && da.picked.length)
      notes.push('About ' + da.subject + ': ' + da.picked
        .map(d => `${d.subject} ${d.path === 'role' ? '' : 'is '}${deAnaphorDef(d.is)}` + (d.sent != null ? ` [s${d.sent}]` : ''))
        .join('; ') + '.');
    const asked = kinAsked(query);
    if (asked.length) {
      const recs = kinRecords(doc).filter(r => asked.includes(r.kin) || asked.includes(r.kin + 's'));
      for (const r of recs.slice(0, 2)) {
        notes.push(`The ${r.kin} mentioned${r.sent != null ? ' at [s' + r.sent + ']' : ''} is ${r.possessor}’s.`);
        push(r.sent); push(r.anchor);
      }
    }
    // A kin sentence among the spans is a misattribution hazard even when
    // the question never asked about kin: its surface says only "his/her
    // <kin>", and a model reading it beside the possessor's name welds the
    // kin's role onto the possessor. Whenever such a span is in view, say
    // who the pronoun resolves to — and who the sentence is NOT about.
    for (const r of kinRecords(doc)) {
      if (r.sent == null || !have.has(r.sent)) continue;
      if (asked.includes(r.kin) || asked.includes(r.kin + 's')) continue;   // noted above
      const surfLC = String((doc.sentenceTexts || [])[r.sent] || '').toLowerCase();
      const subjToks = String(r.possessor).toLowerCase().split(/\s+/).filter(t => t.length >= 3 && !QA_STOP.has(t));
      if (!subjToks.length || subjToks.some(t => surfLC.includes(t))) continue;
      notes.push(`At [s${r.sent}], the ${r.kin} is ${r.possessor}’s ${r.kin} — that sentence is about the ${r.kin}, not about ${r.possessor}.`);
    }
    return { spans, notes };
  }
  function contextPartsScope(docs, query, k = 6) {
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    if (!ds.length) return { spans: [], notes: [] };
    if (ds.length === 1) return contextParts(ds[0], query, k);
    const spans = [], notes = [], have = new Set();
    const push = (docId, i, t) => {
      const key = docId + ':' + i;
      if (i == null || have.has(key) || t == null) return;
      have.add(key); spans.push({ docId, idx: i, tag: docId + ':' + i, text: t });
    };
    for (const h of retrieveScope(ds, query, k)) push(h.docId, h.i, h.t);
    for (const d of ds) {
      const texts = d.sentenceTexts || [];
      const fold = foldNote(d, query);
      if (fold) notes.push(`In ${d.name} — ` + fold.charAt(0).toLowerCase() + fold.slice(1));
      const metaLine = metadataNote(d);
      if (metaLine) notes.push(`In ${d.name} — ` + metaLine.charAt(0).toLowerCase() + metaLine.slice(1));
      for (const s of entityEvidence(d, query)) push(d.id, s.i, s.t);
      const da = defineAssertions(d, query);
      if (da && da.picked.length)
        notes.push(`In ${d.name} — about ${da.subject}: ` + da.picked
          .map(x => `${x.subject} ${x.path === 'role' ? '' : 'is '}${x.is}` + (x.sent != null ? ` [${d.id}:${x.sent}]` : ''))
          .join('; ') + '.');
      const asked = kinAsked(query);
      if (asked.length) {
        for (const r of kinRecords(d).filter(r => asked.includes(r.kin) || asked.includes(r.kin + 's')).slice(0, 2)) {
          notes.push(`In ${d.name}: the ${r.kin} mentioned is ${r.possessor}’s.`);
          push(d.id, r.sent, texts[r.sent]); push(d.id, r.anchor, texts[r.anchor]);
        }
      }
      // Same misattribution guard as contextParts: a kin sentence in view
      // gets its pronoun named even when the question never asked about kin.
      for (const r of kinRecords(d)) {
        if (r.sent == null || !have.has(d.id + ':' + r.sent)) continue;
        if (asked.includes(r.kin) || asked.includes(r.kin + 's')) continue;
        const surfLC = String(texts[r.sent] || '').toLowerCase();
        const subjToks = String(r.possessor).toLowerCase().split(/\s+/).filter(t => t.length >= 3 && !QA_STOP.has(t));
        if (!subjToks.length || subjToks.some(t => surfLC.includes(t))) continue;
        notes.push(`In ${d.name} at [${d.id}:${r.sent}], the ${r.kin} is ${r.possessor}’s ${r.kin} — that sentence is about the ${r.kin}, not about ${r.possessor}.`);
      }
    }
    return { spans, notes };
  }
  // Spans from an already-scored hit list (semantic recall, seek rounds).
  function partsFromHits(docs, hits) {
    const ds = scopeDocs(docs);
    const multi = ds.filter(d => d.kind !== 'table').length > 1;
    const spans = [], have = new Set();
    for (const h of (hits || [])) {
      const docId = h.docId || (ds[0] && ds[0].id);
      const key = docId + ':' + h.i;
      if (h.i == null || have.has(key) || h.t == null) continue;
      have.add(key);
      spans.push({ docId, idx: h.i, tag: multi ? (docId + ':' + h.i) : ('s' + h.i), text: h.t });
    }
    return { spans, notes: [] };
  }
  // The graph walk (depth > 1) as notes + the walk's evidence as spans —
  // readingContext's content, parts-shaped for the tiered prompt.
  function readingNotes(docs, trav) {
    const notes = [], spans = [];
    if (!trav || !trav.perDoc || !trav.perDoc.length) return { notes, spans };
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    const multi = ds.length > 1;
    for (const p of trav.perDoc) {
      const carried = (p.fieldEntries || []).map(f => f.name);
      const lines = [`This question turns on ${[...p.entries, ...carried].join(', ')}${carried.length ? ` (${carried.join(', ')} carried by the conversation, not named in this question)` : ''}.`];
      for (const a of p.assertions.slice(0, 4))
        lines.push(`The page asserts: ${a.subject} ${a.path === 'role' ? '' : 'is '}${a.is}` + (a.sent != null ? ` [${multi ? p.docId + ':' + a.sent : 's' + a.sent}]` : '') + '.');
      if (p.edges.length)
        lines.push('Relations the page draws: ' + p.edges.slice(0, 4).map(e => `${e.a} ${e.verb || '—'} ${e.b}`).join('; ') + '.');
      if (p.walked.length)
        lines.push('Nearby in the graph: ' + p.walked.slice(0, 4).map(w => `${w.name} (${w.via})`).join('; ') + '.');
      notes.push((multi ? `In ${p.name}: ` : '') + lines.join(' '));
      for (const s of p.sentences)
        spans.push({ docId: p.docId, idx: s.i, tag: multi ? (p.docId + ':' + s.i) : ('s' + s.i), text: s.t });
    }
    return { notes, spans };
  }

  // Bind {{cite}} markers onto a model answer across the scope: each answer
  // sentence is re-retrieved over every source and bound to the best-matching
  // line, so a multi-source answer carries citations into whichever doc each
  // claim came from. A scope of one defers to the single-doc binder.
  function bindCitationsScope(docs, answerText, query, intent, opts) {
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    if (ds.length <= 1) return bindCitations(ds[0] || scopeDocs(docs)[0], answerText, query, intent, opts);
    const floor = 0.34;
    const clean = answerText.replace(/\[s?\d+\]/gi, '').replace(/\s+([.,;:])/g, '$1').trim();
    const parts = splitDraft(clean);
    const cited = [];
    let attested = 0;
    const out = parts.map(sent => {
      // an absence claim over a scope must verify in EVERY source to attest
      const receipts = ds.map(d => absenceClaim(d, sent, opts && opts.hotEntity));
      if (receipts.length && receipts.every(r => r)) {
        attested++;
        return `${sent.trim()} {{absent:${ds[0].id}:${receipts[0]} — checked in all ${ds.length} sources}}`;
      }
      const cand = retrieveScope(ds, sent, 1)[0];
      if (cand && supportsClaim(cand, sent, floor)) { cited.push({ docId: cand.docId, idx: cand.i }); return `${sent.trim()} {{cite:${cand.docId}:${cand.i}:s${cand.i}}}`; }
      return sent.trim();
    }).join(' ');
    const supported = cited.length + attested;
    const grounded = supported > 0 && supported >= parts.length * 0.5;
    const cov = (intent && intent !== 'factual') ? { n: 1, d: 1 } : coverage(query, parts.join(' '));
    return {
      text: out, cites: cited,
      audit: {
        status: grounded ? (cov.n >= cov.d ? 'clean' : 'notes') : 'warn',
        grounded, covers: `${cov.n}/${cov.d}`, stable: true,
        note: grounded ? 'Phrased by the local model; every citation bound mechanically to a re-read sentence across your sources.'
                         + (attested ? ' Absence claims attested against the event logs (⊥ with a scan receipt).' : '')
                       : 'Phrased by the model but support was thin — treat with care.',
      },
    };
  }

  /* ============================================================ GRAPH TRAVERSAL
     The graph is built, displayed — and until now abandoned at answer time:
     the QA path retrieved by token overlap as if the graph never existed.
     Traversal makes the graph the answer mechanism. A question arrives; the
     referent machinery names the matter; those entities are the ENTRY NODES.
     From each entry the walk expands — out along page-drawn edges, across
     co-occurrence in shared sentences — and gathers the DEF assertions and
     the sentences structurally attached along the way. The walk itself is
     the trace: an answer with a skeleton, not a similarity score.
     Read-only over the projected entities + event log; gated by the thinking
     dial (budget.graphHops: 0 at the floor ⇒ never runs ⇒ parity). */

  // The assertions the page itself recorded: copular/appositive DEF events
  // (path 'class'), resolved onto the projected entity clusters. Type changes
  // the READER inferred (speech-implies-person, pronoun binding) are not the
  // page's own claims and are excluded — these are the propositions a draft
  // can be audited against, claim against claim.
  // word-boundary containment for entity keys: 'dresser' ⊂ 'amos dresser'
  // but never 'he' ⊂ 'the keeper'
  const _keyWithin = (a, b) => (' ' + b + ' ').includes(' ' + a + ' ');
  function assertionsOf(doc) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return [];
    const { entities } = projectEntities(doc);
    const out = [], seen = new Set();
    for (const ev of doc._events) {
      if (ev.op !== 'DEF' || (ev.path !== 'class' && ev.path !== 'role' && ev.path !== 'state') || !ev.value || !ev.target) continue;
      if (_TRANSMUTE_SRC.has(ev.src)) continue;
      // a pronoun subject only counts through its resolved binding — an
      // unbound "He is …" is not an assertion ABOUT anyone
      let targetName = String(ev.target).trim();
      if (isPronoun(targetName)) {
        if (ev.targetHint && ev.targetHint.name) targetName = String(ev.targetHint.name).trim();
        else continue;
      }
      const k = normSurface(targetName);
      const ent = entities.find(e => e.key === k)
        || (k.length >= 4 ? entities.find(e => _keyWithin(k, e.key) || _keyWithin(e.key, k)) : null);
      const subject = ent ? ent.name : targetName;
      const dedupe = (ent ? ent.key : k) + '|' + normSurface(String(ev.value));
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ subject, key: ent ? ent.key : k, is: String(ev.value).trim(), path: ev.path,
                 // tense rides through so the readout renders the page's own
                 // copula ("was a member", not a flattened "is a member")
                 tense: ev.tense || 'present', copula: ev.copula || null,
                 sent: ev.sentence_idx != null ? ev.sentence_idx : null });
    }
    return out;
  }

  // Walk the graph out from the entities the question names. Returns null when
  // the question names nothing the page carries (nothing to walk — the caller
  // keeps its retrieval-only path). hops: how far the dial lets the walk go.
  // Entities the question names (same matching namesEntity uses — full name,
  // or a ≥4-char non-generic part of a multi-word name, possessives stripped):
  // the matter referents resolved onto the graph. Shared by the graph walk
  // (entry nodes) and the depth-1 evidence join (entityEvidence).
  function namedEntitiesIn(doc, query) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return [];
    let entities = [];
    try { entities = projectEntities(doc).entities || []; } catch (e) { return []; }
    const ql = ' ' + String(query).toLowerCase().replace(/['’]s\b/g, '').replace(/[^\p{L}\p{N}'’\- ]+/gu, ' ').replace(/\s+/g, ' ') + ' ';
    const named = [];
    for (const e of entities) {
      const n = String(e.name).toLowerCase();
      let hit = n.length >= 3 && ql.includes(' ' + n + ' ');
      if (!hit) {
        const parts = n.split(/\s+/);
        hit = parts.length > 1 && parts.some(p => p.length >= 4 && !GENERIC_VOICE_HEADS.has(p) && ql.includes(' ' + p + ' '));
      }
      if (hit) named.push(e);
    }
    return named;
  }

  /* The graph's own evidence for the referents a question names: the
     sentences its DEF assertions sit on, plus each named entity's first
     anchor sentences. The depth-1 analogue of the graph walk's entry nodes —
     no traversal, just what the page is recorded as holding ABOUT the name.
     Exists because lexical retrieval can't reach an assertion whose sentence
     never carries the name (the naming-bridge case: "…created by the same
     person who runs the DMC. That person is Tom Turner." — a question about
     Tom Turner's job retrieves only the naming line). */
  function entityEvidence(doc, query, cap = 4) {
    const named = namedEntitiesIn(doc, query);
    if (!named.length) return [];
    const namedKeys = new Set(named.map(e => e.key));
    let defs = [];
    try { defs = assertionsOf(doc); } catch (e) {}
    const texts = doc.sentenceTexts || [];
    const picks = new Set();
    const take = (i) => { if (i != null && i >= 0 && i < texts.length) picks.add(i); };
    for (const d of defs) {
      if (namedKeys.has(d.key) || (d.key.length >= 4 && [...namedKeys].some(k => _keyWithin(k, d.key) || _keyWithin(d.key, k))))
        take(d.sent);
    }
    // kin records are evidence about the possessor too — the sentence carries
    // only a pronoun, so name-keyed retrieval can never reach it on its own
    for (const r of kinRecords(doc)) {
      if (namedKeys.has(r.key) || (r.key.length >= 4 && [...namedKeys].some(k => _keyWithin(k, r.key) || _keyWithin(r.key, k))))
        take(r.sent);
    }
    for (const e of named) for (const i of (e.sents || []).slice(0, 2)) take(i);
    return [...picks].sort((a, b) => a - b).slice(0, cap).map(i => ({ i, t: texts[i] }));
  }

  /* ---------- definitional asks answered from the graph ----------
     "who is X" / "what is X" / "what is X's job" / "what does X do" name a
     referent and ask what the page holds it to BE. The page's recorded
     assertions (DEF events — class glosses, naming-bridge descriptions, role
     clauses) are that answer, first-class and citable. Mechanics decide;
     when a local model is present it only PHRASES over these assertions —
     one reader's signal at its coupling, re-cited and vetoed against the
     same assertions, never a tie-breaker. */
  function isRoleAsk(q) {
    const s = String(q == null ? '' : q);
    return /\b(?:job|role|title|position|occupation|profession)\b/i.test(s)
      || /^\s*what\s+do(?:es)?\b[\s\S]*\bdo\??\s*$/i.test(s);
  }
  function isDefinitionalAsk(q) {
    const s = String(q == null ? '' : q).trim();
    return /^(?:who|what)\s+(?:is|was|are|were)\b/i.test(s) || isRoleAsk(s);
  }
  /* The assertions a definitional ask reads: role DEFs first for a role ask
     ("what is X's job"), class DEFs first for an identity ask ("who is X");
     the other kind follows only if it adds content tokens. Null when the ask
     isn't definitional, names nothing, or the graph holds nothing. */
  // The specific ASPECT a definitional ask is about, beyond the entity and
  // the wh-frame: "what are Howard Shore's influences" → {influences}; a bare
  // "who is Howard Shore" → {} (identity, no aspect). The mechanical readout
  // is topic-blind without this — it answered "what are his influences?" with
  // "Shore is a member of Lighthouse" because it dumped whatever DEF mentioned
  // the entity. Substantive tokens only (≥5 chars), minus the entity's own.
  // ASK_FRAME is the question_frame_words convention, built in rebuildLangSets.
  function askAspectTokens(query, named) {
    const entToks = new Set();
    for (const e of named) for (const t of (tok(e.name) || [])) entToks.add(t);
    const out = [];
    for (const t of (tok(query) || [])) {
      if (t.length < 5 || ASK_FRAME.has(t) || entToks.has(t)) continue;
      out.push(t);
    }
    return [...new Set(out)];
  }
  // Does a DEF value speak to the asked aspect? Stem-tolerant prefix match so
  // "influences" reaches "influenced"/"influential", "inspirations" reaches
  // "inspired".
  function _defMatchesAspect(def, aspect) {
    const vt = tok(def.is) || [];
    return aspect.some(a => {
      const pa = a.slice(0, 5);
      return vt.some(t => t.slice(0, 5) === pa);
    });
  }
  function defineAssertions(doc, query) {
    if (!doc || doc.kind !== 'prose' || !isDefinitionalAsk(query)) return null;
    const named = namedEntitiesIn(doc, query);
    if (!named.length) return null;
    let defs = [];
    try { defs = assertionsOf(doc); } catch (e) { return null; }
    const keys = new Set(named.map(e => e.key));
    let mine = defs.filter(d => keys.has(d.key)
      || (d.key.length >= 4 && [...keys].some(k => _keyWithin(k, d.key) || _keyWithin(d.key, k))));
    if (!mine.length) return null;
    // TOPIC-SCOPED (B5.1): a non-role aspect ask reads only the assertions
    // that speak to that aspect. None match ⇒ the page records the subject
    // but not this aspect — return null so the path falls through to lexical
    // retrieval (which may find it in prose) or to honest absence, rather
    // than dumping topically-unrelated DEFs as if they answered the question.
    const aspect = isRoleAsk(query) ? [] : askAspectTokens(query, named);
    if (aspect.length) {
      const onTopic = mine.filter(d => _defMatchesAspect(d, aspect));
      if (!onTopic.length) return null;
      mine = onTopic;
    }
    const roles = mine.filter(d => d.path === 'role');
    const classes = mine.filter(d => d.path !== 'role');
    const ordered = isRoleAsk(query) ? roles.concat(classes) : classes.concat(roles);
    const picked = [], seenTok = new Set();
    for (const d of ordered) {
      const toks = tok(d.is);
      if (picked.length && toks.length && toks.every(t => seenTok.has(t))) continue;  // adds nothing
      for (const t of toks) seenTok.add(t);
      picked.push(d);
      if (picked.length >= 2) break;
    }
    return picked.length ? { subject: named[0].name, picked } : null;
  }
  /* The mechanical definitional answer: the assertions themselves, cited to
     the sentences they sit on. Honors the audit-first contract — a named
     referent absent from the page falls through to answerProse's void. */
  function answerDefine(doc, query, opts = {}) {
    const da = defineAssertions(doc, query);
    if (!da) return null;
    try {
      let { antimatter } = referents(doc, query);
      if (opts.voidWhitelist) antimatter = antimatter.filter(t => opts.voidWhitelist.has(t));
      if (antimatter.length) return null;     // let the void speak first
    } catch (e) {}
    const cites = [], seenCite = new Set();
    const cite = (i) => {
      if (i == null) return '';
      if (!seenCite.has(i)) { seenCite.add(i); cites.push({ docId: doc.id, idx: i }); }
      return ` {{cite:${doc.id}:${i}:s${i}}}`;
    };
    // The copula is the page's, not a default present: a role reads bare
    // ("Shore the chairman"), a class/state keeps its tense ("Shore was a
    // member of Lighthouse").
    const text = da.picked
      .map(d => {
        const cop = d.path === 'role' ? '' : ((d.tense === 'past' ? 'was ' : 'is '));
        return `${d.subject} ${cop}${deAnaphorDef(d.is)}` + cite(d.sent) + '.';
      })
      .join(' ');
    return {
      text, cites,
      audit: { status: 'clean', grounded: true, covers: '1/1', stable: true,
        note: 'Read from the page’s recorded assertions (DEF events) about ' + da.subject + ' — no model involved.' },
    };
  }

  /* ---------- topic-scoped fallback / honest absence (B5.1) ----------
     A definitional ask about a SPECIFIC aspect of a present subject ("what
     are Howard Shore's influences?"). The page records the subject but maybe
     not this aspect. This reads only sentences carrying BOTH the subject and
     the aspect; finding none, it says so — it never falls through to the
     entity-overlap retrieval that would surface the subject's UNRELATED facts
     (a camp friendship, a band membership) as if they answered the question.
     The mechanical reader was topic-blind here: it answered "influences?"
     with "Shore was a member of Lighthouse". Null for a bare identity ask
     (no aspect) or a non-definitional turn, so every other path is
     byte-identical. */
  function answerAspect(doc, query, opts = {}) {
    if (!doc || doc.kind !== 'prose' || !isDefinitionalAsk(query) || isRoleAsk(query)) return null;
    const named = namedEntitiesIn(doc, query);
    if (!named.length) return null;
    const aspect = askAspectTokens(query, named);
    if (!aspect.length) return null;                 // bare identity ask → not ours
    // referential absence (the subject isn't on the page at all) is the
    // void's job, not this path's
    try {
      let { antimatter } = referents(doc, query);
      if (opts.voidWhitelist) antimatter = antimatter.filter(t => opts.voidWhitelist.has(t));
      if (antimatter.length) return null;
    } catch (e) {}
    const texts = doc.sentenceTexts || [];
    const chromeSet = (doc._chrome && doc._chrome.length) ? new Set(doc._chrome) : null;
    const onAspect = (i) => {
      const vt = tok(texts[i]) || [];
      return aspect.some(a => { const pa = a.slice(0, 5); return vt.some(t => t.slice(0, 5) === pa); });
    };
    const onSubject = (i) => {
      const lc = ' ' + String(texts[i]).toLowerCase().replace(/\s+/g, ' ') + ' ';
      return named.some(e => lc.includes(' ' + String(e.name).toLowerCase() + ' ')
        || (e.surfaceForms || []).some(f => String(f).length >= 3 && lc.includes(' ' + String(f).toLowerCase() + ' ')));
    };
    const hits = [];
    for (let i = 0; i < texts.length; i++) {
      if (chromeSet && chromeSet.has(i)) continue;
      if (onAspect(i) && onSubject(i)) hits.push(i);
    }
    if (hits.length) {
      const cites = hits.slice(0, 2).map(i => ({ docId: doc.id, idx: i }));
      const text = hits.slice(0, 2).map(i => `${String(texts[i]).trim()} {{cite:${doc.id}:${i}:s${i}}}`).join(' ');
      return { text, cites, audit: { status: 'clean', grounded: true, covers: '1/1', stable: true,
        note: 'Read from the sentences that speak to the asked aspect — no model involved.' } };
    }
    const subj = named[0].name, asp = aspect.join(' ');
    return { text: `The document covers ${subj}, but records nothing about ${subj}’s ${asp}.`,
      cites: [], audit: { status: 'notes', grounded: true, covers: '0/1', stable: true, absent: true,
        note: `Honest absence: ${subj} is on the page, but the asked aspect (${asp}) is not recorded.` } };
  }

  /* ---------- document metadata (Gutenberg-style headers) ----------
     Title: / Author: / Release date: / Language: lines in the pre-text
     header (before "*** START OF"). Bibliographic questions ("who wrote
     it?") need this block, not passage retrieval — content retrieval
     competes and loses, and the model answers "The author wrote it."
     Mechanical and cached on the doc; the routing determination itself
     belongs to the shape pass ("this is a lookup"), not a regex here.
     Header lines carry no terminal punctuation, so several often merge
     into ONE sentence — fields are split out by their markers rather
     than anchored per line. */
  function docMetadata(doc) {
    if (!doc || doc.kind !== 'prose' || !doc.sentenceTexts) return { isGutenberg: false, any: false, fields: {}, sents: {} };
    if (doc._meta) return doc._meta;
    const fields = {}, sents = {};
    let isGutenberg = false;
    const n = Math.min(doc.sentenceTexts.length, 40);
    for (let i = 0; i < n; i++) {
      const t = String(doc.sentenceTexts[i] || '');
      if (/project gutenberg/i.test(t)) isGutenberg = true;
      if (/\*{3}\s*START OF/i.test(t)) { isGutenberg = true; break; }
      const re = /\b(Title|Author|Editor|Translator|Release date|Posting date|Language|Credits)\s*:\s*/gi;
      let m; const marks = [];
      while ((m = re.exec(t)) !== null) marks.push({ key: m[1].toLowerCase(), start: m.index, end: re.lastIndex });
      for (let j = 0; j < marks.length; j++) {
        const val = t.slice(marks[j].end, j + 1 < marks.length ? marks[j + 1].start : undefined)
          .trim().replace(/[\s,;|]+$/, '');
        if (val && !(marks[j].key in fields)) { fields[marks[j].key] = val; sents[marks[j].key] = i; }
      }
    }
    doc._meta = { isGutenberg, any: Object.keys(fields).length > 0, fields, sents };
    return doc._meta;
  }
  // The header as a note line for the grounded prompt (and the shape pass's
  // lookup hint): "From the document's header — Title: …; Author: … [s2]."
  function metadataNote(doc) {
    const meta = docMetadata(doc);
    if (!meta.any) return '';
    const order = ['title', 'author', 'editor', 'translator', 'release date', 'posting date', 'language'];
    const parts = [];
    for (const k of order) {
      if (!(k in meta.fields)) continue;
      const label = k.charAt(0).toUpperCase() + k.slice(1);
      parts.push(`${label}: ${meta.fields[k]}` + (meta.sents[k] != null ? ` [s${meta.sents[k]}]` : ''));
    }
    return parts.length ? 'From the document’s header — ' + parts.join('; ') + '.' : '';
  }

  /* ---------- kin asks answered from the graph ----------
     "whose son is mentioned?" / "what about his son?" / "the son of someone
     involved with NDP" name a RELATION, not a referent — lexical retrieval
     lands on the kin sentence but the possessive pronoun in it is unreadable
     to a small model, and the question often ranks below noise. The parse
     already resolved the possessor (possessive-kin DEFs); these readers hand
     that resolution back: mechanically (answerKin) and as prompt context. */
  function kinRecords(doc) {
    if (!doc || doc.kind !== 'prose' || !doc._events) return [];
    let entities = [];
    try { entities = projectEntities(doc).entities || []; } catch (e) {}
    const out = [];
    for (const ev of doc._events) {
      if (ev.op !== 'DEF' || ev.path !== 'kin' || !ev.value || !ev.target) continue;
      const k = normSurface(String(ev.target));
      const ent = entities.find(e => e.key === k)
        || (k.length >= 4 ? entities.find(e => _keyWithin(k, e.key) || _keyWithin(e.key, k)) : null);
      out.push({
        possessor: ent ? ent.name : String(ev.target).trim(),
        key: ent ? ent.key : k,
        kin: String(ev.value).toLowerCase(),
        sent: ev.sentence_idx != null ? ev.sentence_idx : null,
        anchor: ent && ent.sents && ent.sents.length ? ent.sents[0] : null,
      });
    }
    return out;
  }
  // The kin nouns the question itself names (possessives stripped: "corman's son").
  function kinAsked(q) {
    if (!KIN_TERMS || !KIN_TERMS.size) return [];
    const out = [];
    const toks = String(q == null ? '' : q).toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || [];
    for (const t of toks) {
      const b = t.replace(/['’]s$/, '');
      if (KIN_TERMS.has(b) && !out.includes(b)) out.push(b);
    }
    return out;
  }
  /* The mechanical kin answer. Fires only when the question names a kin term
     AND the parse recorded a matching possessive-kin resolution. Names the
     possessor outright — the one thing the raw sentence cannot do — and cites
     both the kin sentence and the possessor's anchor line. When the question
     (or the conversation's hot entity) points at someone the page records NO
     kin for, it says that first instead of silently switching subjects: the
     misleading half-match is the failure this exists to prevent. */
  function answerKin(doc, query, opts = {}) {
    if (!doc || doc.kind !== 'prose') return null;
    const asked = kinAsked(query);
    if (!asked.length) return null;
    const recs = kinRecords(doc).filter(r => asked.includes(r.kin) || asked.includes(r.kin + 's') || asked.includes(r.kin.replace(/s$/, '')));
    if (!recs.length) return null;
    try {
      let { antimatter } = referents(doc, query);
      if (opts.voidWhitelist) antimatter = antimatter.filter(t => opts.voidWhitelist.has(t));
      if (antimatter.length) return null;     // let the void speak first
    } catch (e) {}
    const named = namedEntitiesIn(doc, query);
    let mine = recs, missing = null;
    if (named.length) {
      const keys = new Set(named.map(e => e.key));
      const filtered = recs.filter(r => keys.has(r.key) || [...keys].some(k => _keyWithin(k, r.key) || _keyWithin(r.key, k)));
      if (filtered.length) mine = filtered;
      else missing = named[0].name;           // asked about X's kin; the page ties it to someone else
    } else if (opts.hotEntity) {
      // No name in the question, but the conversation is ABOUT someone ("his
      // son" riding on the previous turn). If the hot entity holds no kin
      // record while another referent does, surface the correction.
      const hk = normSurface(String(opts.hotEntity));
      const hot = recs.filter(r => r.key === hk || (hk.length >= 4 && (_keyWithin(hk, r.key) || _keyWithin(r.key, hk))));
      if (hot.length) mine = hot;
      else if (hk && !recs.some(r => r.key === hk)) missing = String(opts.hotEntity);
    }
    const cites = [], seenCite = new Set();
    const cite = (i) => {
      if (i == null || seenCite.has(i)) return '';
      seenCite.add(i); cites.push({ docId: doc.id, idx: i });
      return ` {{cite:${doc.id}:${i}:s${i}}}`;
    };
    const texts = doc.sentenceTexts || [];
    const parts = [];
    if (missing) parts.push(`The page records no ${asked[0]} for ${missing}.`);
    for (const r of mine.slice(0, 2)) {
      const line = r.sent != null && texts[r.sent] ? `“${texts[r.sent]}”` : '';
      parts.push(`The ${r.kin} mentioned is ${r.possessor}’s${line ? ': ' + line : ''}${cite(r.sent)}${r.anchor != null && r.anchor !== r.sent ? cite(r.anchor) : ''}.`);
    }
    return {
      text: parts.join(' '), cites,
      audit: { status: 'clean', grounded: true, covers: '1/1', stable: true,
        note: 'Read from the page’s kin record — the possessive ("his/her ' + mine[0].kin + '") resolved by activation at parse time. No model involved.' },
    };
  }

  /* The conversation field as a prior on where the walk starts. An anaphoric
     follow-up ("what about his role") names almost nothing, so the walk used
     to read each question as if the conversation had not happened — and died
     at entry. But the field already holds the anchor hot: the read
     (tools/predictive/read-conv-entry.js) measured that on 81% of follow-ups
     whose question does not name the anchor, the anchor is hot at the dial's
     floor and top-1 by heat. So the hot entities become entry nodes too:
     the walk starts where the conversation has been, not only where the
     current sentence points. Top-2 by heat at/above heatFloor, resolved onto
     THIS doc's graph, never displacing a named entry. At the dial's floor
     wmHeatFloor is ∞ (and graphHops 0), so parity holds; callers that pass
     no field get exactly the old walk. */
  const FIELD_ENTRY_CAP = 2;
  function fieldEntriesIn(entities, namedKeys, field, heatFloor) {
    if (!field || !isFinite(heatFloor)) return [];
    let snap = null;
    try { snap = (typeof field.snapshot === 'function') ? field.snapshot() : field; } catch (e) { return []; }
    const out = [];
    const hot = ((snap && snap.entities) || []).slice().sort((a, b) => b.heat - a.heat);
    for (const he of hot) {
      if (out.length >= FIELD_ENTRY_CAP) break;
      if (!(he.heat >= heatFloor) || !he.key) continue;
      const ent = entities.find(e => e.key === he.key)
        || (he.key.length >= 4 ? entities.find(e => _keyWithin(he.key, e.key) || _keyWithin(e.key, he.key)) : null);
      if (!ent || namedKeys.has(ent.key) || out.some(f => f.entity.key === ent.key)) continue;
      out.push({ entity: ent, heat: he.heat });
    }
    return out;
  }

  function traverseGraph(doc, query, hops = 1, field = null, heatFloor = Infinity) {
    if (!doc || doc.kind !== 'prose' || !doc._events || !(hops > 0)) return null;
    const { entities } = projectEntities(doc);
    if (!entities.length) return null;
    const entries = namedEntitiesIn(doc, query);
    const carried = fieldEntriesIn(entities, new Set(entries.map(e => e.key)), field, heatFloor);
    if (!entries.length && !carried.length) return null;
    let edges = [];
    try { edges = projectGraph(doc._events).edges || []; } catch (e) {}
    const defs = assertionsOf(doc);
    const byKey = new Map(entities.map(e => [e.key, e]));
    const walked = new Map();   // key → { entity, hop, via }
    for (const e of entries) walked.set(e.key, { entity: e, hop: 0, via: 'named in the question' });
    for (const f of carried) walked.set(f.entity.key, { entity: f.entity, hop: 0, via: `hot in the conversation (heat ${f.heat.toFixed(2)})` });
    let frontier = [...walked.keys()];
    for (let h = 1; h <= hops && frontier.length; h++) {
      const next = [];
      for (const key of frontier) {
        const here = byKey.get(key); if (!here) continue;
        // page-drawn relations first — an edge is the page's own connection
        for (const ed of edges) {
          const otherKey = ed.a === key ? ed.b : ed.b === key ? ed.a : null;
          if (!otherKey || walked.has(otherKey) || !byKey.has(otherKey)) continue;
          // keep the page's own direction: the edge reads aName verb bName
          walked.set(otherKey, { entity: byKey.get(otherKey), hop: h, via: `${ed.aName} ${ed.verb || '—'} ${ed.bName}` });
          next.push(otherKey);
        }
        // then co-occurrence: who shares this node's sentences
        const co = [];
        for (const other of entities) {
          if (walked.has(other.key)) continue;
          const shared = other.sents.filter(s => here.sents.includes(s)).length;
          if (shared) co.push({ other, shared });
        }
        co.sort((a, b) => b.shared - a.shared);
        for (const { other, shared } of co.slice(0, 3)) {
          walked.set(other.key, { entity: other, hop: h, via: `appears with ${here.name} in ${shared} sentence${shared === 1 ? '' : 's'}` });
          next.push(other.key);
        }
      }
      frontier = next;
    }
    const walkedKeys = new Set(walked.keys());
    const heldDefs = defs.filter(d => walkedKeys.has(d.key)
      || (d.key.length >= 4 && [...walkedKeys].some(k => _keyWithin(k, d.key) || _keyWithin(d.key, k))));
    const heldEdges = edges
      .filter(ed => walkedKeys.has(ed.a) && walkedKeys.has(ed.b))
      .map(ed => ({ a: ed.aName, verb: ed.verb || '', b: ed.bName }));
    // Evidence: sentences structurally attached along the walk — assertion
    // sites first (the page's claims), then each node's anchor sentences
    // (entries carry more than hop nodes). Capped and index-ordered.
    const picks = new Map();
    const take = (i, via) => { if (i != null && i >= 0 && i < doc.sentenceTexts.length && !picks.has(i)) picks.set(i, via); };
    for (const d of heldDefs) take(d.sent, `asserted of ${d.subject}`);
    // A kin sentence reached through the possessor's node is evidence about
    // the KIN, not the possessor — label the hop so the trace (and anything
    // reading it) can't mistake whose predicate the sentence carries.
    for (const r of kinRecords(doc)) {
      if (walkedKeys.has(r.key) || (r.key.length >= 4 && [...walkedKeys].some(k => _keyWithin(k, r.key) || _keyWithin(r.key, k))))
        take(r.sent, `${r.possessor}’s ${r.kin} (kin record — about the ${r.kin}, not ${r.possessor})`);
    }
    for (const w of walked.values()) for (const i of w.entity.sents.slice(0, w.hop === 0 ? 3 : 1)) take(i, w.entity.name);
    const sentences = [...picks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12)
      .map(([i, via]) => ({ i, t: doc.sentenceTexts[i], via }));
    return {
      entries: entries.map(e => e.name),
      fieldEntries: carried.map(f => ({ name: f.entity.name, heat: +f.heat.toFixed(3) })),
      walked: [...walked.values()].filter(w => w.hop > 0).map(w => ({ name: w.entity.name, hop: w.hop, via: w.via })),
      assertions: heldDefs,
      edges: heldEdges,
      sentences,
    };
  }

  // Traversal folded over the scope, hits tagged per source. Null when no
  // source's graph carries an entry node for this question — named in the
  // question or carried hot by the conversation field.
  function traverseScope(docs, query, hops = 1, field = null, heatFloor = Infinity) {
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    const perDoc = [];
    for (const d of ds) {
      let t = null; try { t = traverseGraph(d, query, hops, field, heatFloor); } catch (e) {}
      if (t) perDoc.push({ docId: d.id, name: d.name, ...t });
    }
    if (!perDoc.length) return null;
    return {
      perDoc,
      entries: [...new Set(perDoc.flatMap(p => p.entries))],
      fieldEntries: [...new Set(perDoc.flatMap(p => (p.fieldEntries || []).map(f => f.name)))],
    };
  }

  // The prompt as the graph speaking. The reading presents itself — what the
  // question turns on, what the page asserts about it, the relations it
  // draws, what sits nearby — and only then the verbatim passages underneath.
  // Evidence the walk reached that retrieval missed is appended in the same
  // [sN]/[docId:N] format, so citation binding is untouched.
  function readingContext(docs, trav, baseCtx) {
    const ctx = String(baseCtx == null ? '' : baseCtx);
    if (!trav || !trav.perDoc || !trav.perDoc.length) return ctx;
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    const multi = ds.length > 1;
    const head = ['What the reading holds on this question (from the document\'s own graph):'];
    for (const p of trav.perDoc) {
      // a carried entry is the conversation's anchor, not the question's —
      // the prompt says so, so the model never mistakes whose focus it is
      const carried = (p.fieldEntries || []).map(f => f.name);
      const lines = [`- It turns on ${[...p.entries, ...carried].join(', ')}${carried.length ? ` (${carried.join(', ')} carried by the conversation, not named in this question)` : ''}.`];
      for (const a of p.assertions.slice(0, 4))
        // a role assertion is a verb phrase ("runs the DMC") — no copula
        lines.push(`- The page asserts: ${a.subject} ${a.path === 'role' ? '' : 'is '}${a.is}` + (a.sent != null ? ` [${multi ? p.docId + ':' + a.sent : 's' + a.sent}]` : '') + '.');
      if (p.edges.length)
        lines.push('- Relations the page draws: ' + p.edges.slice(0, 4).map(e => `${e.a} ${e.verb || '—'} ${e.b}`).join('; ') + '.');
      if (p.walked.length)
        lines.push('- Nearby in the graph: ' + p.walked.slice(0, 4).map(w => `${w.name} (${w.via})`).join('; ') + '.');
      head.push(multi ? `## ${p.name}\n` + lines.join('\n') : lines.join('\n'));
    }
    const extra = [];
    for (const p of trav.perDoc) {
      for (const s of p.sentences) {
        const tag = multi ? `[${p.docId}:${s.i}]` : `[s${s.i}]`;
        if (ctx.includes(tag)) continue;
        extra.push(`${tag} ${s.t}`);
      }
    }
    return head.join('\n') + '\n\nPassages:\n' + ctx + (extra.length ? '\n' + extra.join('\n') : '');
  }

  /* ---------- the propositional veto: claim against claim ----------
     The string-layer veto checks invented terms and citation binding; it
     waves through a draft that NEGATES what the page itself asserted —
     "X was not Y" binds cleanly while the graph holds DEF X is Y. This
     check compares the draft's negated claims against the page's recorded
     assertions: the deepest available form of grounding, mechanically
     checkable because the assertions are first-class events. Conservative
     by design — subject named, a real negation present, every content term
     of the asserted value present — and its failure mode is the honest
     mechanical answer plus a legible audit step. */
  function checkAssertions(doc, draftText) {
    const defs = assertionsOf(doc);
    if (!defs.length) return [];
    // abbreviation-aware split (splitDraft), so "Mr. Amos Dresser was not…"
    // is audited as one claim — a fragment cut after "Mr." separates the
    // subject from its negation and the contradiction slips past
    const parts = splitDraft(String(draftText == null ? '' : draftText).replace(/\{\{[^}]*\}\}/g, ' '));
    const out = [], seen = new Set();
    for (const sent of parts) {
      const raw = ' ' + sent.toLowerCase().replace(/[’]/g, "'") + ' ';
      if (!/\b(?:not|never|no longer)\b|n't\b/.test(raw)) continue;
      if (/\bnot only\b/.test(raw)) continue;                  // "not only X but Y" affirms
      const sToks = new Set(tok(sent));
      for (const d of defs) {
        const subjToks = String(d.subject).toLowerCase().split(/\s+/).filter(t => t.length >= 3 && !QA_STOP.has(t));
        if (!subjToks.length || !subjToks.some(t => sToks.has(t))) continue;
        // The negation targets the HEAD of the asserted value ("a white
        // minister who came south" → "white minister"); requiring the whole
        // relative clause would let "was not a white minister" slip past.
        const valHead = tok(d.is).slice(0, 2);
        if (!valHead.length || !valHead.every(t => sToks.has(t))) continue;
        const key = d.key + '|' + normSurface(d.is);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ subject: d.subject, is: d.is, sent: d.sent, claim: sent.trim() });
      }
    }
    return out.slice(0, 3);
  }
  function checkAssertionsScope(docs, draftText) {
    const out = [];
    for (const d of scopeDocs(docs)) {
      if (d.kind === 'table') continue;
      let cs = []; try { cs = checkAssertions(d, draftText); } catch (e) {}
      for (const c of cs) out.push({ ...c, docId: d.id });
    }
    return out;
  }

  /* ---------- the kin-subject veto: binding is not correctness ----------
     The citation binder checks that a claim's words live in a re-read
     sentence — a SITE check. It cannot see that the sentence's subject is
     someone else: "Until recently, his son served as Director…" supports a
     claim about THE SON, but a draft that hangs that role on the possessor
     ("David Corman served as Director…") binds to the same sentence with the
     same overlap and wears a clean cite while misattributing the role. The
     parse already recorded who "his" is (possessive-kin DEF) — so the
     mismatch is mechanically checkable: a claim that (1) names the possessor
     as its subject, (2) never names the kin relation, and (3) would bind to
     a kin sentence whose surface carries only the pronoun, not the
     possessor's name, is predicating of the wrong person. Conservative by
     design — a kin sentence that names the possessor outright ("Corman
     raised his son") can genuinely support a claim about him and is left
     alone. Failure mode: the honest mechanical answer + a legible trace. */
  function checkKinSubjects(doc, draftText) {
    if (!doc || doc.kind !== 'prose') return [];
    let recs = []; try { recs = kinRecords(doc).filter(r => r.sent != null); } catch (e) {}
    if (!recs.length) return [];
    const texts = doc.sentenceTexts || [];
    const parts = splitDraft(String(draftText == null ? '' : draftText).replace(/\{\{[^}]*\}\}/g, ' '));
    const out = [], seen = new Set();
    for (const sent of parts) {
      const sToks = new Set(tok(sent));
      if (!sToks.size) continue;
      let cand = null;
      for (const r of recs) {
        const kinSentText = texts[r.sent];
        if (!kinSentText) continue;
        // (1) the claim names the possessor
        const subjToks = String(r.possessor).toLowerCase().split(/\s+/).filter(t => t.length >= 3 && !QA_STOP.has(t));
        if (!subjToks.length || !subjToks.some(t => sToks.has(t))) continue;
        // (2) but never the kin relation — naming it means the claim is
        // already about the right person ("Corman's son served as…")
        const kinBase = r.kin.replace(/s$/, '');
        if (sToks.has(r.kin) || sToks.has(kinBase) || sToks.has(kinBase + 's')) continue;
        // (3) the kin sentence's surface never names the possessor — the
        // page tied it to him only through the pronoun the parse resolved
        const kinLC = kinSentText.toLowerCase();
        if (subjToks.some(t => kinLC.includes(t))) continue;
        // and the claim would BIND there: the kin sentence is what the
        // citation layer would stamp under this claim
        cand = cand || retrieve(doc, sent, 1)[0];
        if (!cand || cand.i !== r.sent || !supportsClaim(cand, sent, CITE_FLOOR)) continue;
        const key = r.key + '|' + r.kin;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ possessor: r.possessor, kin: r.kin, sent: r.sent, claim: sent.trim() });
      }
    }
    return out.slice(0, 3);
  }
  function checkKinSubjectsScope(docs, draftText) {
    const out = [];
    for (const d of scopeDocs(docs)) {
      if (d.kind === 'table') continue;
      let ks = []; try { ks = checkKinSubjects(d, draftText); } catch (e) {}
      for (const m of ks) out.push({ ...m, docId: d.id });
    }
    return out;
  }

  /* ============================================================ RELATION GATE
     The relational cure. The string-layer vetoes check that a claim's WORDS
     live on the page; the kin veto checks one specific subject swap; this
     checks the general case — a claim built from on-topic words whose
     subject–predicate–object inverts against the relation the graph
     deposited ("the Association cannot afford its bills" vs the edge where
     the OWNERS pay). Every word semantically correct, the aboutness intact,
     the agency flipped; not a semantic outlier, so no embedding-surprise
     mechanism can see it. Only relation-against-relation can.

     Validated against the NDP battery (tools/predictive/read3.js — the
     measurement this build is gated on): the inversion flags, every
     faithful paraphrase passes, zero false flags. Design facts from that
     read, kept here because they shaped the rules:
       • the graph is SPARSE on exactly the relations summaries invert (the
         owner-pays edge was never deposited — its subject isn't
         entity-shaped), so the gate also reads the span its claim resolves
         to, live, with the same clause heuristic the parse uses;
       • short-surface embedding alignment is NOISE at the resident model's
         scale (cos(association, partnership) = cos(association, owners) =
         0.26), so subject alignment is lexical-first, two distinct named
         figures never embed-align, and the absent-subject branch rides the
         existing void machinery (referents' antimatter);
       • the embedder's one real contribution is PREDICATE compatibility
         (cos(afford, pay) = 0.62) — quantities only, a mechanical gate
         decides, and it goes vacuous when EOEmbed is cold (the gate then
         degrades to lexical: the strict swap still flags, the paraphrased
         inversion is out of reach until the embedder is warm).

     Everything is behind the relation_gate rule (OFF by default): with the
     flag down, no shipped path calls any of this and parity holds. */
  // applyRules coerces card values through Number(), so an installed card
  // arrives as 1; the seed is boolean false. Either truthy form means ON.
  function relationGateEnabled() { const v = READING_RULES.relation_gate.value; return v === true || v === 1; }

  // RG_STOP / RG_PRONOUN_RE / RG_ATTRIB are the relation_gate_* conventions,
  // built in rebuildLangSets (auxiliary verbs reuse AUX_VERBS_RE).
  const _rgToks = (s) => String(s || '').toLowerCase().replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t && !RG_STOP.has(t));
  function _rgSubset(a, b) {
    const ta = _rgToks(a), tb = _rgToks(b);
    if (!ta.length || !tb.length) return false;
    const [small, big] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
    return small.every(w => big.has(w));
  }
  // The gate's predicate normalizer: normalizeRelation plus the modal/
  // negation shell ("cannot afford" → "afford"), so polarity stays with
  // checkAssertions and the gate compares the act itself.
  function _rgNormRel(v) {
    return normalizeRelation(String(v || '').replace(/[,"“”]/g, ''))
      .replace(/\b(will|would|can|cannot|could|shall|should|may|might|must|to|not|never|also|then|still|already)\b/g, '')
      .replace(/\s+/g, ' ').trim();
  }
  function _rgLemmaOverlap(a, b) {
    const la = new Set(), lb = new Set();
    for (const w of _rgNormRel(a).split(' ')) if (w) for (const l of verbLemmas(w)) la.add(l);
    for (const w of _rgNormRel(b).split(' ')) if (w) for (const l of verbLemmas(w)) lb.add(l);
    for (const l of la) if (l && lb.has(l)) return true;
    return false;
  }
  // Embedding similarity of two short surfaces — quantities only, cached,
  // null when the embedder is cold (callers treat null as "no signal").
  const _rgVecCache = new Map();
  async function _rgCos(a, b) {
    if (typeof window === 'undefined' || !window.EOEmbed || !window.EOEmbed.ready()) return null;
    const get = async (s) => {
      const k = String(s || '').toLowerCase().trim();
      if (!k) return null;
      if (_rgVecCache.has(k)) return _rgVecCache.get(k);
      let v = null; try { v = await window.EOEmbed.embedQuery(k); } catch (e) { v = null; }
      _rgVecCache.set(k, v);
      return v;
    };
    const va = await get(a), vb = await get(b);
    return (va && vb) ? _cosineNorm(va, vb) : null;
  }

  const _RG_QUOTEY = /["“”]/;

  /* Claim/span SVO candidates — the parse's own clause heuristic (first
     noun / last verb / last noun) plus the head-verb variant, because a
     claim's main predicate often leads where page prose trails. Reads only;
     never deposits an event. */
  function _rgSvo(text) {
    const cands = [];
    let doc; try { doc = nlp(String(text || '')); } catch (e) { return cands; }
    doc.clauses().forEach(clause => {
      const nouns = clause.nouns().out('array');
      const verbs = clause.verbs().out('array');
      if (nouns.length < 2 || verbs.length < 1) return;
      const variants = [
        { v: verbs[verbs.length - 1], o: nouns[nouns.length - 1] },
        { v: verbs[0], o: nouns[1] },
      ];
      for (const { v, o } of variants) {
        const s = nouns[0];
        if (!s || !v || !o || normSurface(s) === normSurface(o)) continue;
        const vFirst = String(v).toLowerCase().split(/\s+/)[0];
        if (AUX_VERBS_RE.test(vFirst)) continue;
        const copular = COPULAR.test(vFirst);
        if (cands.some(c => normSurface(c.s) === normSurface(s) && _rgNormRel(c.v) === _rgNormRel(v) && normSurface(c.o) === normSurface(o))) continue;
        cands.push({ s, v: String(v).toLowerCase(), o, copular });
      }
    });
    return cands;
  }

  /* Every relation the gate can check a claim against: deposited CON edges
     and text-layer SYN edges (subject hints resolved to their referent's
     name; an unhinted pronoun subject never carries a verdict), edges
     derived from DEF role/class assertions, the live SVO read of a span
     (minted on demand, quote fragments excluded — reported speech is SIG's
     business), and the SIG attribution slots. Cached per doc. */
  const _rgRelCache = new WeakMap();
  function _rgRelations(doc) {
    if (_rgRelCache.has(doc)) return _rgRelCache.get(doc);
    const edges = [];
    for (const ev of (doc._events || [])) {
      if (ev.op === 'CON') {
        edges.push({ s: ev.sourceName || ev.s, v: ev.v, o: ev.targetName || ev.o, sent: ev.sentence_idx, via: 'CON' });
      } else if (ev.op === 'SYN' && !Array.isArray(ev.sites) && ev.s && ev.v && ev.o) {
        edges.push({
          s: (ev.sHint && ev.sHint.name) || ev.s, v: ev.v, o: (ev.oHint && ev.oHint.name) || ev.o,
          sent: ev.sentence_idx, via: 'SYN', pronoun: !ev.sHint && RG_PRONOUN_RE.test(String(ev.s).trim()),
        });
      }
    }
    let defs = [];
    try { defs = assertionsOf(doc) || []; } catch (e) {}
    for (const d of defs) {
      if (d.path !== 'role' && d.path !== 'class') continue;
      for (const c of _rgSvo(d.subject + ' ' + d.is))
        edges.push({ s: c.s, v: c.v, o: c.o, sent: d.sent, via: 'DEF' });
    }
    const live = new Map();
    const liveAt = (idx) => {
      if (live.has(idx)) return live.get(idx);
      const t = (doc.sentenceTexts || [])[idx] || '';
      const out = _rgSvo(t)
        .filter(c => !c.copular && !_RG_QUOTEY.test(c.s) && !_RG_QUOTEY.test(c.o))
        .map(c => ({ s: c.s, v: c.v, o: c.o, sent: idx, via: 'span-svo', pronoun: RG_PRONOUN_RE.test(String(c.s).trim()) }));
      live.set(idx, out);
      return out;
    };
    // Only CONFIDENT attributions carry a verdict — a mass-weighted
    // fallback guess is the reader's own speculation, and holding a claim
    // against a speculation would be the gate inverting its own rule
    // (the same discipline continuation_inheritance applies).
    const sigs = (doc._events || []).filter(e => e.op === 'SIG' && e.attributed && e.attributed !== 'fallback' && e.attributed !== 'none')
      .map(e => ({ sent: e.sentence_idx, speaker: (e.speakerHint && e.speakerHint.name) || e.speaker }));
    const rel = { edges, defs, liveAt, sigs };
    _rgRelCache.set(doc, rel);
    return rel;
  }

  /* The gate. For each claim in the draft: resolve the span its footnote
     points at (the binder's own move), gather candidate relations, align
     the claim's subject and object to each edge's s and o, and hold the
     claim when the agency inverts, the speaker is wrong, or the subject is
     a named figure the edge does not carry. Conservative by design; its
     failure mode is the honest mechanical answer plus a legible audit
     step, exactly like the kin and assertion vetoes beside it. */
  async function checkRelations(doc, draftText, opts = {}) {
    if (!doc || doc.kind !== 'prose') return [];
    const ALIGN_FLOOR = READING_RULES.relation_align_floor.value;
    const REL_FLOOR = READING_RULES.relation_rel_floor.value;
    const rel = _rgRelations(doc);
    if (!rel.edges.length && !rel.defs.length && !rel.sigs.length && !(doc.sentenceTexts || []).length) return [];
    let entNames = [];
    try { entNames = (projectEntities(doc).entities || []).map(e => e.name); } catch (e) {}
    const entityOf = (surface) => entNames.find(n => _rgSubset(surface, n)) || null;
    // two distinct named figures of the page never embed-align (Ruiz ≠ Vance)
    const align = async (a, b) => {
      if (_rgSubset(a, b)) return 1;
      const ea = entityOf(a), eb = entityOf(b);
      if (ea && eb && ea !== eb) return 0;
      const c = await _rgCos(a, b);
      return c == null ? 0 : c;
    };
    const relComp = async (cv, ev) => {
      if (_rgLemmaOverlap(cv, ev)) return 1;
      const c = await _rgCos(_rgNormRel(cv) || String(cv), _rgNormRel(ev) || String(ev));
      return c == null ? 0 : c;
    };
    const parts = splitDraft(String(draftText == null ? '' : draftText).replace(/\{\{[^}]*\}\}/g, ' ').replace(/\[s?\d+\]/gi, ' '));
    const out = [], seen = new Set();
    for (const sent of parts) {
      if (out.length >= 3) break;
      // where would this claim's footnote point? (the binder's own move)
      let boundIdx = null;
      const cand = retrieve(doc, sent, 1)[0];
      if (cand && supportsClaim(cand, sent, CITE_FLOOR)) boundIdx = cand.i;
      // is the claim's subject a NAMED referent — present (matter) or
      // invented (antimatter, the void machinery's read)?
      let refs = { matter: [], antimatter: [] };
      try { refs = referents(doc, sent) || refs; } catch (e) {}
      const namedSubject = (surface) => {
        const all = [...(refs.matter || []), ...(refs.antimatter || [])];
        const hit = all.find(n => _rgSubset(n, surface) || _rgSubset(surface, n));
        if (hit) return { isNamed: true, absent: (refs.antimatter || []).some(n => _rgSubset(n, surface) || _rgSubset(surface, n)) };
        return { isNamed: !!entityOf(surface), absent: false };
      };
      for (const c of _rgSvo(sent)) {
        const vHead = _rgNormRel(c.v).split(' ')[0] || String(c.v).split(/\s+/).pop();
        // attribution claims check the SIG record first: who held the slot
        if (RG_ATTRIB.has(vHead) && boundIdx != null) {
          const sig = rel.sigs.find(g => g.sent === boundIdx && g.speaker && g.speaker !== '?');
          if (sig) {
            if ((await align(c.s, sig.speaker)) >= ALIGN_FLOOR) continue;   // the right voice
            if (entityOf(c.s) && entityOf(sig.speaker) && entityOf(c.s) !== entityOf(sig.speaker)) {
              const key = 'sig|' + boundIdx + '|' + normSurface(c.s);
              if (!seen.has(key)) {
                seen.add(key);
                out.push({ claim: sent.trim(), kind: 'wrong-speaker', edge: { s: sig.speaker, v: 'said', o: '“…”', sent: boundIdx, via: 'SIG' }, claimSVO: { s: c.s, v: c.v, o: c.o } });
              }
              continue;
            }
          }
        }
        if (c.copular) continue;        // a copular claim is DEF territory (checkAssertions), not an enacted relation
        const pool = [];
        if (boundIdx != null) {
          for (const e of rel.edges) if (e.sent === boundIdx) pool.push(e);
          for (const e of rel.liveAt(boundIdx)) pool.push(e);
        }
        for (const e of rel.edges) if (e.sent !== boundIdx) pool.push(e);
        // a claim that bound NOWHERE is resolved by relation: the live span
        // reads supply the edges the sparse graph never deposited (the
        // owner-pays sentence whose subject isn't entity-shaped)
        if (boundIdx == null) {
          const n = (doc.sentenceTexts || []).length;
          for (let i = 0; i < n; i++) for (const e of rel.liveAt(i)) pool.push(e);
        }
        for (const e of pool) {
          if (e.pronoun) continue;      // an unresolved pronoun subject carries no verdict
          const rc = await relComp(c.v, e.v);
          if (rc < REL_FLOOR) continue;
          const sS = await align(c.s, e.s), sO = await align(c.s, e.o);
          const oS = await align(c.o, e.s), oO = await align(c.o, e.o);
          const hit = (kind, extra) => {
            const key = kind + '|' + e.sent + '|' + normSurface(c.s);
            if (seen.has(key)) return;
            seen.add(key);
            out.push(Object.assign({
              claim: sent.trim(), kind,
              edge: { s: e.s, v: e.v, o: e.o, sent: e.sent, via: e.via },
              claimSVO: { s: c.s, v: c.v, o: c.o },
              scores: { rc: +rc.toFixed(2), sS: +sS.toFixed(2), sO: +sO.toFixed(2), oS: +oS.toFixed(2), oO: +oO.toFixed(2) },
            }, extra || {}));
          };
          // the clean swap: subject lexically on the object side and the
          // object on the subject side ("the Partnership pays owners")
          if (sO >= 0.9 && sS < ALIGN_FLOOR && (oS >= 0.9 || oO < ALIGN_FLOOR)) { hit('inverted'); break; }
          // subject aligned where the edge put it — the claim holds
          if (sS >= ALIGN_FLOOR && sS >= sO) continue;
          // a NAMED subject the edge doesn't carry, asserting this very
          // relation: the same act + object under a different actor flags;
          // without the object anchor only a subject absent from the whole
          // page can flag — a present figure may hold the relation elsewhere
          const nm = namedSubject(c.s);
          if (nm.isNamed && Math.max(sS, sO) < ALIGN_FLOOR &&
              (oO >= ALIGN_FLOOR || (nm.absent && rc >= REL_FLOOR))) {
            hit('foreign-subject', { subjectAbsentFromPage: nm.absent });
          }
        }
      }
    }
    return out.slice(0, 3);
  }
  async function checkRelationsScope(docs, draftText) {
    const out = [];
    for (const d of scopeDocs(docs)) {
      if (d.kind === 'table') continue;
      let ms = []; try { ms = await checkRelations(d, draftText); } catch (e) {}
      for (const m of ms) out.push({ ...m, docId: d.id });
    }
    return out;
  }

  /* ---------- provenance binds at generation ----------
     bindClaimKeys consumes the span tags the model wrote ([s12] — the same
     tags the spans wear in its prompt) as each claim's PROVENANCE KEY: the
     span the claim was built from, not a plausible span retrieved
     afterward. A keyed claim verifies against ITS OWN span only — a key is
     never overwritten with a better-agreeing span, because that better
     agreement is exactly how citation-as-costume happens. A key that does
     not resolve (bad index, or no token of the claim lives in the span)
     HOLDS the claim: it ships uncited and is named in the audit. Unkeyed
     claims fall back to the old binder, claim by claim — fallback only,
     never the primary path. Semantic drift of a keyed claim from its own
     span is the envelope's job (groundingEnvelope), kept separate so this
     stays sync and cheap. */
  function bindClaimKeys(doc, answerText, query, intent, opts) {
    const floor = CITE_FLOOR;
    // a tag the model wrote AFTER the period belongs to the sentence it
    // closes — pull it back inside before the draft is split into claims
    const raw = String(answerText == null ? '' : answerText)
      .replace(/([.!?]['"’”)\]]*)\s*((?:\[s(?:\d+|\?)\]\s*)+)/g, ' $2$1')
      .replace(/\s+([.,;:])/g, '$1').trim();
    const texts = doc.sentenceTexts || [];
    // Chrome is never citable: a reference/external-link line, a heading or a
    // nav row is page structure, not a source for a claim. A model tag that
    // points at one (the IMDb "Official website" line the trace cited as
    // s123) is dropped from the citable pool — the claim holds uncited rather
    // than laundering chrome into a citation.
    const chromeSet = (doc._chrome && doc._chrome.length) ? new Set(doc._chrome) : null;
    const parts = splitDraft(raw).filter(p => p.replace(/\[s(?:\d+|\?)\]/g, '').trim());
    const cited = [], held = [];
    let attested = 0, keyed = 0;
    const out = parts.map(sent => {
      const tags = [...String(sent).matchAll(/\[s(\d+|\?)\]/g)].map(m => m[1]);
      const clean = sent.replace(/\[s(?:\d+|\?)\]/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
      const keys = tags.filter(t => t !== '?').map(Number).filter(n => n >= 0 && n < texts.length && !(chromeSet && chromeSet.has(n)));
      if (keys.length) {
        keyed++;
        const idx = keys[0];                      // the first tag is the claim's provenance
        const span = texts[idx] || '';
        const cT = new Set(tok(clean)), sT = new Set(tok(span));
        let overlap = 0; for (const t of cT) if (sT.has(t)) overlap++;
        if (overlap >= 1) { cited.push({ docId: doc.id, idx }); return `${clean} {{cite:${doc.id}:${idx}:s${idx}}}`; }
        held.push({ claim: clean, key: idx, reason: 'key-unresolved' });
        return clean;
      }
      // unkeyed → the old binder path, claim by claim (fallback only)
      const receipt = absenceClaim(doc, clean, opts && opts.hotEntity);
      if (receipt) { attested++; return `${clean} {{absent:${doc.id}:${receipt}}}`; }
      const cands = retrieve(doc, clean, 1);
      if (cands.length && supportsClaim(cands[0], clean, floor)) { cited.push({ docId: doc.id, idx: cands[0].i }); return `${clean} {{cite:${doc.id}:${cands[0].i}:s${cands[0].i}}}`; }
      return clean;
    }).join(' ');
    const supported = cited.length + attested;
    const grounded = supported > 0 && supported >= parts.length * 0.5;
    const cov = (intent && intent !== 'factual') ? { n: 1, d: 1 } : coverage(query, parts.join(' '));
    return {
      text: out, cites: cited, held, keyed,
      audit: {
        status: held.length ? 'warn' : (grounded ? (cov.n >= cov.d ? 'clean' : 'notes') : 'warn'),
        grounded, covers: `${cov.n}/${cov.d}`, stable: true,
        note: (keyed ? `Provenance bound at generation: ${keyed} claim(s) carried their own span key; the old binder served only the unkeyed rest.`
                     : 'No model-supplied keys — every citation bound by the fallback binder.')
          + (held.length ? ` ${held.length} claim(s) HELD: their keys did not resolve (${held.map(h => 's' + h.key).join(', ')}) — shipped uncited rather than re-bound to a better-agreeing span.` : '')
          + (attested ? ' Absence claims attested against the event log (⊥ with a scan receipt).' : ''),
      },
    };
  }
  function bindClaimKeysScope(docs, answerText, query, intent, opts) {
    const ds = scopeDocs(docs).filter(d => d.kind !== 'table');
    // keyed binding is per-doc ([sN] names a span of the PRIMARY source);
    // a multi-prose scope keeps the old scope binder until [docId:N] keys land
    if (ds.length === 1) return bindClaimKeys(ds[0], answerText, query, intent, opts);
    return bindCitationsScope(docs, answerText, query, intent, opts);
  }

  /* ---------- the grounding-leak envelope (mechanism D) ----------
     For each cited claim in a BOUND answer, the embedding distance to the
     span its own footnote names — never to an exemplar library, so a
     sharp, unusual, true sentence is safe and only drift from the cited
     source flags. Bands are the existing audit rules: below
     audit_resemblance the claim is a leak (it left its span); between
     resemblance and audit_paraphrase_strong it is impressionistic; at or
     above, a close paraphrase. Vacuous without the embedder. */
  async function groundingEnvelope(doc, boundText) {
    const empty = { checked: 0, rows: [], leaks: 0, impressionistic: 0, strong: 0 };
    if (typeof window === 'undefined' || !window.EOEmbed || !window.EOEmbed.ready()) return empty;
    if (!doc || doc.kind !== 'prose') return empty;
    const texts = doc.sentenceTexts || [];
    const RES = READING_RULES.audit_resemblance.value;
    const STRONG = READING_RULES.audit_paraphrase_strong.value;
    const out = { checked: 0, rows: [], leaks: 0, impressionistic: 0, strong: 0 };
    const re = /\{\{cite:([^:}]+):(\d+):[^}]*\}\}/g;
    let m, cursor = 0;
    const text = String(boundText == null ? '' : boundText);
    while ((m = re.exec(text)) !== null) {
      const claim = text.slice(cursor, m.index).replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();
      cursor = re.lastIndex;
      const idx = +m[2];
      if (m[1] !== doc.id || !claim || !(idx >= 0 && idx < texts.length)) continue;
      let cv = null, sv = null;
      try { cv = await window.EOEmbed.embedQuery(claim); sv = await window.EOEmbed.embedQuery(texts[idx]); } catch (e) {}
      if (!cv || !sv) continue;
      const cos = _cosineNorm(cv, sv);
      const band = cos < RES ? 'leak' : cos < STRONG ? 'impressionistic' : 'strong';
      out.checked++;
      out[band === 'leak' ? 'leaks' : band === 'impressionistic' ? 'impressionistic' : 'strong']++;
      out.rows.push({ claim, idx, cos: +cos.toFixed(4), band });
    }
    return out;
  }

  // A coverage gap can only be SOUGHT if the term exists somewhere in the
  // sources. Sub-querying on a meta-word from the user's own phrasing
  // ("mistakes", "summary") seeks nothing and spends a round on the wrong
  // layer — the depth machinery aiming effort at words about the question
  // instead of words on the page.
  function seekableTerms(docs, terms) {
    const bodies = scopeDocs(docs).filter(d => d.kind !== 'table').map(d => docBodyLC(d));
    return (terms || []).filter(t => {
      const lc = String(t).toLowerCase();
      return lc && bodies.some(b => b.includes(lc));
    });
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
    // COMMAND — an imperative for the assistant to act outside the document
    // ("search for X", "google X", "look up X"). Exits to chat regardless of
    // lexical/entity overlap with the scope, so a content noun the page
    // happens to share cannot drag the turn into a grounded read of a
    // document the turn was never about. classifyIntent has already ruled
    // out doc-internal anchors ("look up X in the text" stays factual).
    if (intent === 'command')
      return { decision: 'chat', confidence: 'high', reason: 'command', intent };
    // CONVERSATIONAL REPAIR — the turn is about the EXCHANGE (pushing back on
    // the previous reply), not fresh content. Checked before every lexical
    // reader, because a repair turn dragged onto the page by token overlap
    // re-serves exactly the failure being objected to. Confirm-shaped turns
    // keep their graph-check path; repair claims only the factual band. Needs
    // a conversation to repair (ctx), so batch/parity callers never see it.
    if (ctx && (ctx.prevGrounded || ctx.hadReply) && intent === 'factual') {
      const rep = repairSignal(q);
      if (rep) return { decision: 'repair', confidence: 'high', reason: 'repair:' + rep.kind, repair: rep, primary: routePrimary(ds, q, ctx), intent };
    }
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
      // Schema-aware lock: the question names a VALUE this table holds ("clients
      // from Mexico" → a Country value) even when pivot.jsx's narrower cue set
      // missed it. Guarded so engine tests without tablequery.js are unaffected.
      try { if (window.EOTableQuery && window.EOTableQuery.looksLikeTableQuery(q, d)) return { decision: 'mechanical', confidence: 'high', reason: 'table-value', primary: d, intent }; } catch (e) {}
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
    // continuity — an anaphoric, deictic ("in there") or elliptical ("but why
    // not?") follow-up to a grounded conversation stays on the page.
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

  /* ---------- Phase 3: the embedder as a wandering reader ----------
     Given the spans the answer is being built on (NOT the query), return
     embedding-near sentences the page never lexically connects — the associative
     leaps rationality wouldn't draw. Each candidate is δ-gated against the doc's
     own centroid: a sentence near EVERYTHING (flat) has sim ≈ baseline and is
     inert; one specifically pulled toward the source spans clears assoc_delta.
     The mechanical decision (which links survive) stays here; the deposit is the
     app's. Guarded by EOEmbed.ready() — no embedder ⇒ [] (degrades to graph-hop).
     Reuses _docVecCache so the wander costs no extra embedding. */
  const ASSOC_SIM_FLOOR = 0.35;   // below this cosine, not a real associative pull
  const ASSOC_LEX_MAX = 0.25;     // above this lexical overlap, the link is one rationality already draws
  async function associativeNeighbors(doc, spans, budget, k = 5) {
    const out = [];
    if (typeof window === 'undefined' || !window.EOEmbed || !window.EOEmbed.ready()) return out;
    if (!doc || doc.kind === 'table' || !Array.isArray(spans) || !spans.length) return out;
    if (!budget || !(budget.assocCoupling > 0) || !isFinite(budget.assocDelta)) return out;
    let vecs; try { vecs = await docSentVectors(doc); } catch (e) { vecs = null; }
    if (!vecs || !vecs.length) return out;
    const texts = doc.sentenceTexts || [];
    const src = [...new Set(spans.filter(i => i >= 0 && i < vecs.length))];
    if (!src.length) return out;
    const dim = vecs[0].length;
    const centroid = (idxs) => {
      const v = new Float64Array(dim);
      for (const i of idxs) { const r = vecs[i]; for (let d = 0; d < dim; d++) v[d] += r[d]; }
      let n = 0; for (let d = 0; d < dim; d++) n += v[d] * v[d]; n = Math.sqrt(n) || 1;
      for (let d = 0; d < dim; d++) v[d] /= n;
      return v;
    };
    const all = []; for (let i = 0; i < vecs.length; i++) all.push(i);
    const srcC = centroid(src), globalC = centroid(all);
    const srcSet = new Set(src);
    const srcTokens = new Set(); for (const i of src) for (const t of tok(texts[i] || '')) srcTokens.add(t);
    for (let j = 0; j < vecs.length; j++) {
      if (srcSet.has(j)) continue;
      const sim = _cosineNorm(vecs[j], srcC);
      if (sim < ASSOC_SIM_FLOOR) continue;
      // low lexical overlap: a connection the page never spells out
      const jt = tok(texts[j] || ''); let shared = 0; for (const t of jt) if (srcTokens.has(t)) shared++;
      const lex = jt.length ? shared / jt.length : 0;
      if (lex > ASSOC_LEX_MAX) continue;
      // δ gate against the doc's own gravity: near everything (flat) is inert.
      const baseline = Math.max(1e-6, _cosineNorm(vecs[j], globalC));
      const clearedDelta = sim >= budget.assocDelta * baseline;
      out.push({ i: j, t: texts[j], sim: +sim.toFixed(4), baseline: +baseline.toFixed(4), lexOverlap: +lex.toFixed(3), clearedDelta });
    }
    out.sort((a, b) => b.sim - a.sim);
    return out.slice(0, k);
  }

  /* ---------- Impression query (embedding as a fuzzy graph query) ----------
     The embedder is not a tangent generator — it's another way to QUERY the
     graph: impressionistically, by meaning rather than by the words the question
     happened to use. Seeded from the question's embedding, impressionQuery
     gathers the sentences the page reads as related (cosine ≥ floor) — the
     "relevant region" — then does two things the lexical path can't:

       • hands back the top related sentences VERBATIM (citable spans), and
       • folds the WHOLE region into one note — the INTEGRAL of the relevant
         things, not the raw lines. The region first closes over the figures it
         touches (their other mentions join it), so the integral covers a figure's
         whole footprint, not just the sentences cosine happened to rank. That
         closure is the "self-re-prompting": an impression of a name pulls the
         rest of that name into the fold.

     No embedder ⇒ an empty result (the lexical spans/notes answer exactly as
     before — parity floor). Reuses _docVecCache, so it costs only the query
     embedding. */
  async function impressionQuery(doc, query, opts = {}) {
    const empty = { spans: [], idxs: [], fold: '' };
    if (typeof window === 'undefined' || !window.EOEmbed || !window.EOEmbed.ready()) return empty;
    if (!doc || doc.kind !== 'prose') return empty;
    let vecs; try { vecs = await docSentVectors(doc); } catch (e) { vecs = null; }
    if (!vecs || !vecs.length) return empty;
    let qv; try { qv = await window.EOEmbed.embedQuery(query); } catch (e) { qv = null; }
    if (!qv) return empty;
    const texts = doc.sentenceTexts || [];
    const chromeSet = (doc._chrome && doc._chrome.length) ? new Set(doc._chrome) : null;
    const floor = isFinite(opts.floor) ? opts.floor : SEM_FLOOR;
    const region = Math.max(1, Math.min(opts.region || 12, 24));   // how wide the relevant region may be
    const spanK = Math.max(1, Math.min(opts.spans || 4, 8));       // verbatim spans handed back
    // the impressionistic hits: every sentence the page reads as related
    const scored = [];
    for (let i = 0; i < vecs.length; i++) {
      if (chromeSet && chromeSet.has(i)) continue;
      const s = _cosineNorm(qv, vecs[i]);
      if (s >= floor) scored.push({ i, t: texts[i], sim: +s.toFixed(4) });
    }
    if (!scored.length) return empty;
    scored.sort((a, b) => b.sim - a.sim);
    const relevant = scored.slice(0, region);
    const relSet = new Set(relevant.map(r => r.i));
    // close the region over the figures it touches — the integral should cover a
    // name's whole footprint, not just the lines cosine ranked (self-re-prompting)
    if (opts.expand !== false) {
      const heavy = foldHeavy(doc).filter(e => (e.sents || []).some(i => relSet.has(i))).slice(0, 4);
      for (const e of heavy) for (const i of (e.sents || [])) if (i >= 0 && i < vecs.length) relSet.add(i);
    }
    return {
      spans: relevant.slice(0, spanK),
      idxs: [...relSet].sort((a, b) => a - b),
      fold: foldOver(doc, [...relSet]),
    };
  }

  // The impression as a prompt note — the integral of the related material in
  // the reader's voice, marked as a semantic read (impression, not the words of
  // the question), so the model weighs it as understanding, not quotation.
  function impressionNote(fold) {
    const f = String(fold || '').trim();
    if (!f) return '';
    return 'Related by impression (a semantic read of the page, not the words of the question — usually relevant, sometimes a tangent), gathered into one picture: ' + f;
  }

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
        // the de-chromed view holds on the semantic reader too: skip the lines
        // the chrome gate set aside, so embedding recall never resurfaces the
        // share bar or the byline that lexical retrieval just scored past. A
        // turn about the chrome takes the mechanical de-chrome route instead.
        const chromeSet = (d._chrome && d._chrome.length) ? new Set(d._chrome) : null;
        for (let i = 0; i < vecs.length; i++) {
          if (chromeSet && chromeSet.has(i)) continue;
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
  /* ============================================================
     Conversation field — working memory as a hot subgraph.

     A chat-scoped overlay on the document field. Where the document field's
     mass/momentum is PROJECTED from the event log, the conversation field is
     deposited by the turns themselves: each settled answer warms the entities
     it named and the sentences it cited. Heat decays once per turn by the SAME
     γ the medium uses between sentences — recent topics stay warm, dropped ones
     cool to a rewarmable pointer. Chat-scoped and serializable (it rides in the
     chat snapshot, never the cross-session learned ledger); reset on a new or
     switched chat, mirroring newChat.

     Legible-THAT, not legible-why: the field records THAT a topic was carried,
     and with how much heat — never a claim about why. buildWorkingMemory() reads
     it into hot / warm / cold. It holds POINTERS (docId/idx/label), never text. */
  const _convField = { turn: 0, ent: new Map(), sent: new Map(), edge: new Map() };
  const _cfKey = (s) => normSurface(String(s || ''));
  function _cfWarm(map, key, meta, w) {
    if (!key) return;
    const cur = map.get(key);
    if (cur) { cur.heat += w; if (meta) Object.assign(cur, meta); }
    else map.set(key, Object.assign({ heat: w }, meta || {}));
  }
  const conversationField = {
    // Deposit heat from a settled turn. payload: { entities:[name…],
    // sentences:[{docId,idx}…], edges:[[a,b]…] }. weight scales the deposit.
    deposit(payload, weight = 1) {
      if (!payload) return;
      const w = Number(weight) || 0; if (w <= 0) return;
      for (const name of (payload.entities || [])) {
        const k = _cfKey(name); if (k) _cfWarm(_convField.ent, k, { label: String(name) }, w);
      }
      for (const s of (payload.sentences || [])) {
        if (!s || s.idx == null) continue;
        const k = (s.docId || '') + ':' + (s.idx | 0);
        _cfWarm(_convField.sent, k, { docId: s.docId || null, idx: s.idx | 0 }, w);
      }
      for (const e of (payload.edges || [])) {
        if (!Array.isArray(e) || e.length < 2) continue;
        const a = _cfKey(e[0]), b = _cfKey(e[1]); if (!a || !b) continue;
        const k = a < b ? a + '|' + b : b + '|' + a;
        _cfWarm(_convField.edge, k, { a, b }, w);
      }
    },
    // One tick of conversational time: decay all heat by γ, GC the cold dust.
    decayTurn() {
      const g = (typeof GAMMA === 'number' && GAMMA > 0) ? GAMMA : 0.7;
      _convField.turn++;
      for (const map of [_convField.ent, _convField.sent, _convField.edge]) {
        for (const [k, v] of map) { v.heat *= g; if (v.heat < 1e-3) map.delete(k); }
      }
      return _convField.turn;
    },
    // Serializable read view (heaviest first) — for audit, working memory, and
    // the chat snapshot. POINTERS only (docId/idx/label), never document text.
    snapshot() {
      const rows = (map, extra) => [...map.entries()]
        .map(([key, v]) => Object.assign({ key, heat: +v.heat.toFixed(4) }, extra(v)))
        .sort((a, b) => b.heat - a.heat);
      return {
        turn: _convField.turn,
        entities: rows(_convField.ent, v => ({ label: v.label || v.key })),
        sentences: rows(_convField.sent, v => ({ docId: v.docId || null, idx: v.idx })),
        edges: rows(_convField.edge, v => ({ a: v.a, b: v.b })),
      };
    },
    // Rebuild from a snapshot (chat restore). Best-effort and defensive.
    restore(snap) {
      this.reset();
      if (!snap || typeof snap !== 'object') return;
      _convField.turn = snap.turn | 0;
      for (const e of (snap.entities || [])) if (e && e.key) _convField.ent.set(e.key, { heat: +e.heat || 0, label: e.label || e.key });
      for (const s of (snap.sentences || [])) if (s && s.key) _convField.sent.set(s.key, { heat: +s.heat || 0, docId: s.docId || null, idx: s.idx | 0 });
      for (const e of (snap.edges || [])) if (e && e.key) _convField.edge.set(e.key, { heat: +e.heat || 0, a: e.a, b: e.b });
    },
    reset() { _convField.turn = 0; _convField.ent.clear(); _convField.sent.clear(); _convField.edge.clear(); },
  };

  /* ---------- Working memory: the conversation field as a hot subgraph ----------
     buildWorkingMemory reads the conversation field through the turn's budget and
     resolves it into three bands the prompt assembler ranks by heat:
       • hot  — entities above the budget's heat floor, with their verbatim sentences
       • warm — one graph-hop from a hot entity (reuse projectGraph edges), a portrait line
       • cold — touched-but-cooled: a rewarmable POINTER (label + sentence range), no text
     The field holds pointers only; the docs resolve them to text HERE, so the field
     stays light and chat-scoped. At the dial's floor the budget's heat floor is ∞,
     so every band is empty and the assembler takes today's path — parity holds.
     Embedding-near warm spans are a later phase; this degrades to graph-hop only,
     which needs no embedder. */
  function buildWorkingMemory(scope, field, budget, query) {
    const empty = { hot: [], warm: [], cold: [], recalled: [] };
    if (!field || !budget || !isFinite(budget.wmHeatFloor)) return empty;
    const ds = scopeDocs(scope).filter(d => d && d.kind !== 'table');
    if (!ds.length) return empty;
    const snap = (typeof field.snapshot === 'function') ? field.snapshot() : field;
    const floor = budget.wmHeatFloor;
    // Index every scope entity once: key → { name, docId, sents:[{i,t}], mass }.
    const entIndex = new Map();
    for (const d of ds) {
      let proj; try { proj = projectEntities(d); } catch (e) { continue; }
      for (const e of (proj.entities || [])) {
        const key = normSurface(e.name);
        if (!entIndex.has(key)) entIndex.set(key, { name: e.name, docId: d.id, mass: e.mass, sents: (e.sents || []).map(i => ({ i, t: d.sentenceTexts[i] })) });
      }
    }
    // One-hop neighbors of an entity key, from the projected graph edges.
    const neighborsOf = (key) => {
      const out = [];
      for (const d of ds) {
        if (!d._events) continue;
        let g; try { g = projectGraph(d._events); } catch (e) { continue; }
        for (const ed of (g.edges || [])) {
          if (ed.a === key) out.push({ key: ed.b, name: ed.bName, verb: ed.verb });
          else if (ed.b === key) out.push({ key: ed.a, name: ed.aName, verb: ed.verb });
        }
      }
      return out;
    };
    const hot = [], cold = [], hotKeys = new Set();
    for (const e of (snap.entities || [])) {
      const idx = entIndex.get(e.key);
      if (e.heat >= floor) {
        hot.push({ entity: e.label || e.key, heat: e.heat, docId: idx ? idx.docId : null, mass: idx ? idx.mass : null, sents: idx ? idx.sents.slice(0, 3) : [] });
        hotKeys.add(e.key);
      } else {
        const sids = idx ? idx.sents.map(s => s.i) : [];
        cold.push({ label: e.label || e.key, heat: e.heat, docId: idx ? idx.docId : null, sentRange: sids.length ? [Math.min(...sids), Math.max(...sids)] : null });
      }
    }
    // warm: one graph-hop out from a hot entity (dedup, never re-list a hot one).
    const warm = [], warmKeys = new Set();
    for (const h of hot) {
      for (const nb of neighborsOf(normSurface(h.entity))) {
        if (!nb.key || hotKeys.has(nb.key) || warmKeys.has(nb.key)) continue;
        warmKeys.add(nb.key);
        const idx = entIndex.get(nb.key);
        const line = (idx && idx.sents.length) ? idx.sents[0].t : (nb.verb ? `${h.entity} ${nb.verb} ${nb.name}` : nb.name);
        warm.push({ entity: nb.name || nb.key, oneHopFrom: h.entity, portraitLine: line });
      }
    }
    // recall by heat: cold material that overlaps THIS query reconstructs to full
    // fidelity (old-but-relevant turns come back into the hot zone).
    const recalled = query ? recallByHeat(ds, field, query) : [];
    return { hot, warm: warm.slice(0, 6), cold, recalled };
  }

  // When cooled material overlaps the current retrieval, rewarm it to full text.
  // Operates on the field's carried SENTENCE pointers; recallSpan (in llm.js) stays
  // the by-index primitive for the chat history. Lexical overlap, so no embedder.
  function recallByHeat(scope, field, query) {
    if (!field || !query) return [];
    const ds = scopeDocs(scope).filter(d => d && d.kind !== 'table');
    const snap = (typeof field.snapshot === 'function') ? field.snapshot() : field;
    const qt = new Set(tok(query));
    if (!qt.size) return [];
    const byId = new Map(ds.map(d => [d.id, d]));
    const out = [];
    for (const s of (snap.sentences || [])) {
      const d = byId.get(s.docId); if (!d || !d.sentenceTexts) continue;
      const t = d.sentenceTexts[s.idx]; if (!t) continue;
      const st = new Set(tok(t));
      let overlap = 0; for (const x of qt) if (st.has(x)) overlap++;
      if (overlap >= 1) out.push({ docId: s.docId, i: s.idx, t, heat: s.heat, overlap });
    }
    out.sort((a, b) => b.overlap - a.overlap || b.heat - a.heat);
    return out.slice(0, 4);
  }

  window.EOEngine = {
    parseDocument, projectEntities, entityDetail, retrieve, answer,
    // the staged-ingest memory governor: an honest heap readout for the UI and
    // an explicit MB ceiling the parse will plateau under (auto when unset).
    ingestMemoryInfo, setIngestMemoryCap,
    context, bindCitations, tok, classifyIntent, hasGround, referencesDoc, inventedTerms,
    applyRules, voidInvented, isCreativeCompose, dedupeSentences,
    // DEF — the type gate (the fourth NUL state): which capitalized tokens are
    // truth-apt referents vs. structural/pragmatic grammar, by shape not by list.
    nonReferentialCaps, referents,
    // the extracted graph: a portrait, and a portable per-doc snapshot (explorer + export)
    // graphPortrait / graphSnapshot / projectEntities now surface NUL log,
    // signal substrate, frame, full DEF set, and long-tail entities.
    // Talker-facing prose composer: see talkerPortrait (WI-5) and
    // the mechanical grounder groundTalkerOutput (WI-6).
    graphPortrait, graphSnapshot, talkerPortrait, groundTalkerOutput, evaDraft,
    // the integral fold: a cumulative, mechanical condensation of the document
    // read up to a boundary — the whole-document fold answers "what is this
    // about" and rides every grounded turn; a chapter question gets the fold up
    // to where the next chapter begins.
    documentFold, documentFolds, foldForQuery, foldNote, foldOver,
    // the nine-cell terrain histogram (Site × Time) of a scope — the
    // read-only projection that decides which cells the fold should author.
    // No operator, no event-record write: pure read over doc._events.
    foldTerrains,
    // ingestion audit: every word's fate (indexed / stopword / dropped), the
    // inverted index actually built, and per-span coverage — the glass box over
    // ingestion itself, word by word. classifyTokens CALLS tok() so it can't drift.
    ingestionReport, classifyTokens, evaAcrossDocs, textGraph,
    // multi-doc scope: ground a conversation against an explicit set of sources
    referencesScope, retrieveScope, routePrimary, discourseBinding, referentsScope, answerScope,
    resolveSubjectDoc: activeSubjectDoc,
    contextScope, bindCitationsScope, supportProbeTerms,
    // tiered context for the notes-and-spans grounded prompt
    contextParts, contextPartsScope, partsFromHits, readingNotes,
    // document metadata (Gutenberg headers) + the presentation-cleaned cast
    docMetadata, metadataNote, castEntities,
    // cost-ordered routing (existence → structure → significance) + embedding recall
    routeTurn, retrieveHybrid, contextFromHits,
    // thinking depth: the effort dial's per-turn budget + the conversation field
    // (working memory) it spends across. Inert at depth 1 (parity floor).
    thinkingBudget, conversationField, buildWorkingMemory, recallByHeat,
    // iterative seeking: coverage + which query clusters a retrieval leaves uncovered
    coverage, coverageGaps, seekableTerms,
    // graph traversal: the graph as the answer mechanism (entries → walk →
    // assertions/edges/evidence), the prompt as the graph speaking, and the
    // propositional veto (draft claims audited against DEF assertions)
    traverseGraph, traverseScope, readingContext, assertionsOf,
    checkAssertions, checkAssertionsScope, entityEvidence,
    // the kin-subject veto: a claim that binds to a kin sentence but hangs
    // the kin's predicate on the possessor (grounded ≠ correct)
    checkKinSubjects, checkKinSubjectsScope,
    // the relation gate (relation_gate rule, OFF by default — parity floor):
    // claims checked relation-against-relation (agency inversion, wrong
    // speaker, foreign subject), provenance bound at generation with the
    // old binder as fallback, and the grounding-leak envelope (distance
    // from the claim's OWN cited span, never an exemplar library)
    relationGateEnabled, checkRelations, checkRelationsScope,
    bindClaimKeys, bindClaimKeysScope, groundingEnvelope,
    // definitional asks answered from the graph's own assertions
    answerDefine, defineAssertions, isDefinitionalAsk,
    // kin asks answered from possessive-kin resolutions ("whose son…?"), the
    // conversational-repair reader, and the across-turn repetition guard
    answerKin, kinRecords, kinAsked, repairSignal, echoesPriorReply,
    // CONFIRM/DENY: a proposition checked mechanically against the graph
    // (DEF assertions, SIG attribution slots, absence attested with ⊥ receipts),
    // and the abbreviation-aware draft splitter the binders/veto share
    answerConfirm, answerConfirmScope, splitDraft, holdsSpeakerSlot,
    // the embedder as a wandering reader: associative, δ-gated neighbors (no-op without an embedder)
    associativeNeighbors,
    // impression query: the embedder as a fuzzy graph query — the question
    // gathers a semantically-related region, handed back as verbatim spans plus
    // the INTEGRAL (fold) of that region as a note (no-op without an embedder)
    impressionQuery, impressionNote,
    // the inference void: mark what the reader ADDED across two cited spans
    markInferred,
    // reconsideration: does a draft read as a refusal / non-answer (plan SEG),
    // and the leaked-reasoning hard fail (the veto's belt-and-suspenders over
    // the llm layer's think-stripping)
    looksRefused, looksLeakedReasoning,
    // the layer ladder: the essay's 1-2-1 force-count test, made live + falsifiable,
    // and the transmuting-DEF classifier (the significance-layer "weak" law)
    layerLadder, isTransmutingDef,
    // de-chroming: the document-level verdict over the chrome gate (non-
    // destructive — the stripped band stays in the spine), the about-the-html /
    // about-the-de-chroming route, and the full-content query that backs it
    computeDechrome, aboutChrome, answerAboutChrome, answerDechromeScope,
    // expose the raw graph engine for future operator-void / shape work
    _extractEoGraph: extractEoGraph, _projectGraph: projectGraph,
    // per-language reading mode: Original (shipped-only, frozen) vs Self-learning
    setLanguageModes, languageModes,
    // the semantics graph (conventions.jsonl): human-language conventions as an
    // eo-operation log, projected like any other event log
    loadConventions, loadConventionPacks, projectConventions, _conventionsExport,
    // el-classical-v1 Greek organs — test/introspection handles
    _detectLanguage: detectLanguage, _analyzeGreekToken: analyzeGreekToken,
    _buildGreekOrgans: buildGreekOrgans, _extractGreekGraph: extractGreekGraph, _greekTables: () => GREEK,
    // depicted-act content on CON bonds, and the autonomous-evaluator seam (the
    // local model as a soft, capped weighting — never a gate)
    depictedAct, setDepictsEvaluator,
    // the Site face — the 9 phenomenological addresses (EO Space × Time): the
    // grid, the operator→Domain map, and the classifiers. The Act face is the
    // event `op`; the Site face is `event.site` / `entity.site`. The grid and
    // the cell list are getters: their (Existence, Figure) cell follows the
    // site_entity_cell rule ('Entity' on, legacy 'Thing' off).
    get EO_SITE_GRID() { return eoSiteGrid(); },
    get EO_SITES() { return eoSites(); },
    EO_DOMAIN_OF_OP, eoSite, eoSiteOfEvent, objectOf, eoAddress, siteEntityCellEnabled,
    // EVA failures hydrate the conventions: the session's REC records,
    // JSONL-shaped and append-ready for memory/conventions.jsonl. A host may
    // set EOEngine.onConventionsRec = (rec) => … to ship each one out.
    conventionsDelta, serializeConventionsDelta,
    // provenance-anchored conventions: anchors (content hash + embedding
    // signature, never a name or location), the span table they resolve
    // against on-device, and the anchor physics (independence / decay /
    // register fit / admission). _provenance is the pure layer the tests pin.
    _provenance: {
      sha256Hex, spanHash, normalizeSpan, mintAnchor, resolveAnchor, registerDocSpans,
      independentAnchors, anchorMass, admitAnchors, conventionVariants, gatherProvenance,
      quantizeSig, sigCos, registerFit, head: convHead,
      SEED_ANCHOR, ANCHOR_COUPLING, MODEL_READERS: [...MODEL_READERS],
    },
    setAnchorEmbedder, setAnchorPrivacy, anchorPrivacy,
    // the convention proposer: the same local model that phrases answers gains
    // a proposal slot — a closed grammar over engine-minted evidence handles.
    // It proposes; it never commits, cites, anchors, or self-witnesses.
    nominateFriction, proposerStatus, conventionsPortrait, buildProposerPrompt,
    receiveProposals, runProposerTurn, pendingProposals, confirmProposal, rejectProposal,
    // read-only: the induced speech-verb class + accrued mass (learning record)
    _learnedVerbs: learnedVerbs, learnedVerbsByLang,
    // persistence: serialize/restore the learned ledger delta (host stores it)
    _serializeLedger, _restoreLedger,
  };
})();
