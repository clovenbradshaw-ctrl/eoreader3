/* ============================================================
   Cleo Deep-Read Enrichment — the second, offline pass.

   The streaming reader (engine.js) is greedy: it commits structure as the
   text arrives, with only the entity field seen so far. This pass rewalks a
   FINISHED `cleo-graph/1` with the whole field present and repairs, mints,
   and composes what the greedy pass could not — then emits an enriched graph
   plus a per-operation ledger (`cleo-enrich/1`) that is the publishable
   receipt for every change.

   The governing rule: IF A RULE CAN DECIDE IT, THE MODEL NEVER SEES IT. The
   tiny CPU model here is not a reader and not an author. It is a discriminator
   — a binding oracle consulted only where a mechanical rule cannot decide, and
   only ever through a closed-choice, grammar-constrained, one-token answer with
   a first-class abstain. Mechanics enumerate candidates generously; the model
   prunes narrowly.

     [A] CandidateGenerator — mechanical: emits the enumerated options
     [B] ModelOracle        — closed-choice grammar-constrained discriminator
     [C] Binder / Veto      — re-reads the cited sentence, checks subject_match
     [D] Mutator            — applies surviving decisions to a working copy
     [E] FixedPointDriver   — re-runs A–D to a fixed point or budget

   Pure function of (graph, sentences, model, budget): re-running yields
   byte-identical output. Degraded (no model) mode still cleans the graph
   mechanically and marks every model-dependent decision `deferred`.

   Published as window.EOEnrich. No engine dependency — it operates on the
   portable `cleo-graph/1` snapshot alone, so it can be tested and run on any
   graph the engine emitted.
   ============================================================ */
(function () {
  'use strict';

  const SCHEMA = 'cleo-enrich/1';

  /* ---- small mechanical helpers (self-contained; no engine import) ---- */

  const clone = (v) => { try { return v == null ? v : JSON.parse(JSON.stringify(v)); } catch (e) { return v; } };

  // A lowercase, accent-light, punctuation-stripped surface for comparison.
  const normName = (s) => String(s == null ? '' : s)
    .replace(/[’]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const STOP = new Set(('a an the and or of to in on at by with from for is are was were be the their his her its'
    + ' that this these those who whom which').split(/\s+/));

  // Content tokens of a name (drops stopwords + possessive 's), for blocking.
  const contentTokens = (s) => normName(s).split(' ')
    .map(t => t.replace(/'s$/, ''))
    .filter(t => t.length > 2 && !STOP.has(t));

  // Normalized Levenshtein-similarity in [0,1] (1 = identical).
  function editSim(a, b) {
    a = normName(a); b = normName(b);
    if (a === b) return 1;
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    const d = new Array(n + 1);
    for (let j = 0; j <= n; j++) d[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = d[0]; d[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return 1 - d[n] / Math.max(m, n);
  }

  // The kinship nouns a possessive can name (mirrors the engine's seed set).
  const KIN = new Set(('son daughter child children father mother parent brother sister sibling'
    + ' husband wife spouse uncle aunt nephew niece cousin grandson granddaughter grandfather'
    + ' grandmother grandchild stepson stepdaughter').split(/\s+/));

  // Gendered possessive pronouns → the gender they imply (for possessor resolution).
  const POSS_GENDER = { his: 'male', her: 'female', their: null, its: null };

  // Org-ish head tokens that license an `org` retype suspicion.
  const ORG_HEADS = /\b(corporation|partnership|council|department|llc|inc|incorporated|authority|company|firm|agency|association|commission|bureau|board|trust|group|institute|university|college|police|patrol)\b/i;

  // Role/title nouns that, standing alone, are not entities but attributes.
  const ROLE_HEADS = /^(director|manager|commander|officer|chief|head|president|chair|chairman|secretary|treasurer|commissioner|marshal|lead|administrator|coordinator|supervisor)\b/i;

  /* ---- structured error for the alignment precondition (§1.1) ---- */
  function alignmentError(code, detail) {
    const e = new Error('cleo-enrich alignment: ' + code);
    e.code = code; e.detail = detail; e.schema = SCHEMA; e.fatal = true;
    return e;
  }

  /* ============================================================
     §1.1  The alignment precondition (do not skip)

     The graph addresses sentences by index only and carries no raw text.
     `sentences[]` MUST be the identical segmentation that produced the graph.
     A misaligned array silently produces correct-looking, wrong enrichments —
     the most dangerous failure in the system. Validate, or abort.
     ============================================================ */
  function validateAlignment(graph, sentences) {
    if (!graph || typeof graph !== 'object') throw alignmentError('no-graph', 'graph is required');
    if (!Array.isArray(sentences)) throw alignmentError('no-sentences', 'sentences[] is required');

    const declared = graph.doc && typeof graph.doc.sentences === 'number' ? graph.doc.sentences : null;
    // 1. count agreement
    if (declared != null && declared !== sentences.length) {
      throw alignmentError('count-mismatch',
        `graph.doc.sentences=${declared} but sentences.length=${sentences.length}`);
    }

    // 2. every referenced index is in range
    const bad = [];
    const seeIdx = (idx, where) => {
      if (idx == null) return;
      if (!Number.isInteger(idx) || idx < 0 || idx >= sentences.length) bad.push({ idx, where });
    };
    for (const e of (graph.entities || [])) for (const s of (e.sents || [])) seeIdx(s, 'entity.sents:' + e.key);
    for (const n of (graph.nulls || [])) seeIdx(n.sentence_idx, 'null:' + (n.seq != null ? n.seq : '?'));
    for (const ev of (graph.events || [])) seeIdx(ev.sentence_idx, 'event:' + (ev.seq != null ? ev.seq : '?'));
    if (bad.length) {
      throw alignmentError('index-out-of-range',
        `${bad.length} index reference(s) fall outside [0,${sentences.length}); first: ${JSON.stringify(bad[0])}`);
    }

    // 3. spot-check: a sample of entities' surfaces appear in one of their sents
    const ents = (graph.entities || []).filter(e => (e.sents || []).length);
    const sample = ents.slice(0, Math.min(8, ents.length));
    let checked = 0, hit = 0;
    for (const e of sample) {
      const surfaces = [e.name].concat(e.mentions || []).filter(Boolean).map(normName);
      let found = false;
      for (const si of e.sents) {
        const sent = normName(sentences[si] || '');
        if (surfaces.some(sf => sf && sent.includes(sf))) { found = true; break; }
        // a content token of the name is enough for the spot-check (aliases drift)
        if (contentTokens(e.name).some(t => sent.includes(t))) { found = true; break; }
      }
      checked++; if (found) hit++;
    }
    // Allow a couple of misses (aliases/pronouns) but a wholesale miss means the
    // arrays are not the same segmentation.
    if (checked >= 3 && hit / checked < 0.5) {
      throw alignmentError('surface-miss',
        `only ${hit}/${checked} sampled entities' surfaces were found in their cited sentences — `
        + 'sentences[] is probably not the segmentation that produced this graph');
    }
    return { ok: true, checked, hit, sentences: sentences.length };
  }

  /* ============================================================
     §4  The ModelOracle contract + permute-and-agree (§4.4)

     interface ModelOracle { choose(prefixKey, prefix, suffix, grammar) }
       → returns the chosen option label, decoded under `grammar`, temp 0.

     Position bias is severe in sub-1B models. Never trust a single call on a
     multi-choice decision: run with options in order C and reverse(C); accept
     only if the SAME candidate wins both. Disagreement ⇒ abstain.
     ============================================================ */

  const GRAMMARS = {
    anaphora: 'root ::= "1" | "2" | "3" | "4" | "N"',
    merge:    'root ::= "Y" | "N" | "?"',
    type:     'root ::= "P" | "O" | "H" | "T"',
    support:  'root ::= "F" | "P" | "N"',
  };

  // Static prefixes are byte-identical per decision type so their KV cache is
  // computed once and reused (`prefixKey` selects it).
  const PREFIX = {
    anaphora: 'Resolve the reference. Answer with one option number, or N if none/unclear.\n',
    merge:    'Decide whether A and B name the same entity. Y=yes N=no ?=unclear.\n',
    type:     'Classify the entity. P=place O=org H=person T=thing.\n',
    support:  'Judge whether the sentence supports the claim. F=fully P=partly N=no.\n',
  };

  // Build the variable suffix for each decision type from candidate-generator
  // data. `frame` permutes presentation to expose position bias.
  function buildSuffix(type, data, frame) {
    if (type === 'anaphora') {
      const lines = (data.window || []).map(w => `<s${w.idx}> ${w.text}`).join('\n');
      const opts = frame.options.map((o, i) => `${i + 1} ${o.name}`).join('\n');
      return `${lines}\n\nIn <s${data.atIdx}>, "${data.surface}" = which?\n${opts}\nN none / unclear\n=`;
    }
    if (type === 'merge') {
      return `A: ${frame.a}\nB: ${frame.b}\nSame entity?\n=`;
    }
    if (type === 'type') {
      const legend = frame.legend; // permuted P/O/H/T legend text
      return `"${data.name}" in:\n<s${data.idx}> ${data.sentence}\nType? ${legend}\n=`;
    }
    if (type === 'support') {
      return `Claim: ${data.claim}\n<s${data.idx}> ${data.sentence}\nSupported by <s${data.idx}>? F=fully P=partly N=no\n=`;
    }
    return '=';
  }

  // The permute-and-agree harness. `frames` is an array of {suffix, map}, where
  // map(rawAnswer) → canonical choice id (or null for abstain). Returns
  // { choice, abstained, frames_agreed, calls }.
  async function permuteAndAgree(oracle, account, type, frames) {
    const grammar = GRAMMARS[type];
    const prefixKey = type;
    const prefix = PREFIX[type];
    const answers = [];
    for (const f of frames) {
      if (account.spent >= account.max) { account.deferred = true; return { choice: null, abstained: true, frames_agreed: null, calls: 0, deferred: true }; }
      const raw = await oracle.choose(prefixKey, prefix, f.suffix, grammar);
      account.spent++;
      answers.push(f.map(String(raw == null ? '' : raw).trim()));
    }
    const calls = frames.length;
    const allSame = answers.every(a => a !== undefined && a === answers[0]);
    if (!allSame || answers[0] == null) {
      // disagreement OR an explicit abstain in any frame ⇒ contested ⇒ abstain
      return { choice: null, abstained: true, frames_agreed: `1/${calls}`, calls };
    }
    return { choice: answers[0], abstained: false, frames_agreed: `${calls}/${calls}`, calls };
  }

  /* ============================================================
     §5  The binder / role-consistency veto

     The fix for the headline bug: a grounding that cites a real sentence but
     assigns its predicate to the WRONG subject. The old veto checked the site
     (does the sentence exist). This one also checks the argument slot: the
     grammatical subject of the cited sentence must be the claimed subject (or
     coref-linked to it this run).
     ============================================================ */

  // Mechanically guess the grammatical subject NP of a sentence: the earliest
  // entity surface that appears before the main verb region. Cheap, but enough
  // to catch a possessive-kin clause whose subject is "his son", not the
  // possessor's proper name. Returns the matched entity key, or null.
  function mechanicalSubjectKey(citedIdx, sentences, entIndex, kinSurfaces) {
    const raw = String(sentences[citedIdx] || '');
    const sent = normName(raw);
    if (!sent) return null;
    // A leading possessive-kin phrase ("Until recently, his son served …")
    // makes the KIN site the subject, not the possessor. Detect it first.
    for (const ks of kinSurfaces) {
      // ks = { surface: "his son", key: "kin:son:corman" }
      const pos = sent.indexOf(normName(ks.surface));
      if (pos !== -1 && pos < sent.length / 2) return ks.key;
    }
    // Otherwise: the earliest entity surface in the sentence's first half.
    let best = null, bestPos = Infinity;
    for (const e of entIndex.list) {
      const surfaces = [e.name].concat(e.mentions || []).filter(Boolean).map(normName);
      for (const sf of surfaces) {
        if (!sf) continue;
        const pos = sent.indexOf(sf);
        if (pos !== -1 && pos < bestPos) { bestPos = pos; best = e.key; }
      }
    }
    // only trust a subject that sits in the first half of the clause
    return bestPos < sent.length * 0.6 ? best : best;
  }

  // The veto itself. Returns true when the cited sentence's subject canonicalizes
  // to claimSubjectKey (or is coref-linked to it this run).
  function subjectMatch(claimSubjectKey, citedIdx, sentences, entIndex, corefThisRun, kinSurfaces) {
    if (citedIdx == null) return null; // N/A — no site to check
    const subjKey = mechanicalSubjectKey(citedIdx, sentences, entIndex, kinSurfaces || []);
    if (subjKey == null) return false;
    if (subjKey === claimSubjectKey) return true;
    // explicit coref edge minted THIS run links them
    const links = corefThisRun.get(subjKey);
    if (links && links.has(claimSubjectKey)) return true;
    const back = corefThisRun.get(claimSubjectKey);
    if (back && back.has(subjKey)) return true;
    return false;
  }

  /* ============================================================
     The working session: holds the mutable graph copy, the entity index,
     the ledger, the model-call account, and the coref/kin bookkeeping.
     ============================================================ */
  function makeSession(input) {
    const graph = clone(input.graph);
    graph.entities = graph.entities || [];
    graph.edges = graph.edges || [];
    graph.assertions = graph.assertions || [];
    graph.spine = graph.spine || [];
    graph.nulls = graph.nulls || [];
    graph.defs = graph.defs || [];

    const budget = Object.assign(
      { maxPasses: 5, maxModelCalls: 2000, maxTokensPerCall: 256, perPassCallCap: Infinity },
      input.budget || {});

    const account = { spent: 0, max: input.model ? budget.maxModelCalls : 0, deferred: false };

    const s = {
      graph,
      sentences: input.sentences,
      model: input.model || null,
      budget,
      account,
      ledger: [],
      corefThisRun: new Map(),   // entityKey → Set(linked keys)
      kinSurfaces: [],           // [{ surface, key }] for the subject veto
      entIndex: null,
    };
    s.entIndex = buildIndex(graph);
    return s;
  }

  function buildIndex(graph) {
    const byKey = new Map();
    const byNorm = new Map();
    for (const e of graph.entities) {
      byKey.set(e.key, e);
      byNorm.set(normName(e.name), e);
      for (const a of (e.aliases || [])) byNorm.set(normName(a), e);
    }
    return { list: graph.entities, byKey, byNorm };
  }

  // Append a ledger op, filling defaults. Returns the op (so callers can read it).
  function logOp(s, o) {
    const op = Object.assign({
      schema: SCHEMA,
      pass: o.pass, op: o.op, target: o.target,
      before: o.before === undefined ? null : o.before,
      after: o.after === undefined ? null : o.after,
      basis_sentence_idx: o.basis_sentence_idx || [],
      subject_match: o.subject_match === undefined ? null : o.subject_match,
      model_calls: o.model_calls || 0,
      frames_agreed: o.frames_agreed || null,
      confidence: o.confidence || 'settled',
      abstained: !!o.abstained,
      deferred: !!o.deferred,
      at: new Date().toISOString(),
    });
    s.ledger.push(op);
    return op;
  }

  function addCoref(s, a, b) {
    if (!s.corefThisRun.has(a)) s.corefThisRun.set(a, new Set());
    if (!s.corefThisRun.has(b)) s.corefThisRun.set(b, new Set());
    s.corefThisRun.get(a).add(b);
    s.corefThisRun.get(b).add(a);
  }

  /* ============================================================
     §6.0  Boundary repair — pure mechanical, no model.
     Strip orphan punctuation, extend strict-prefix truncations, demote
     standalone role nouns. Runs first; removes a large fraction of noise.
     ============================================================ */
  function passBoundary(s) {
    let mutated = 0;
    for (const e of s.graph.entities) {
      const before = e.name;
      // strip leading/trailing orphan punctuation: "DMC)" → "DMC", "(NDP" → "NDP"
      let nm = e.name.replace(/^[\s([{)\]\}.,;:'"]+/, '').replace(/[\s([{.,;:'"]*[)\]\}]+$/, '').trim();
      // a stray opening paren with no close, or trailing comma
      nm = nm.replace(/\($/, '').replace(/[,;:]\s*$/, '').trim();
      // an unbalanced trailing close-paren with no opener in the surface
      if (/\)$/.test(nm) && !nm.includes('(')) nm = nm.replace(/\)+$/, '').trim();
      if (nm && nm !== before) {
        e.name = nm;
        logOp(s, { pass: 'silence' /* boundary */, op: 'reattach', target: e.key,
          before: { name: before }, after: { name: nm }, basis_sentence_idx: (e.sents || []).slice(0, 1) });
        // overwrite pass label: boundary repair files under its own pass
        s.ledger[s.ledger.length - 1].pass = 'canonicalize';
        s.ledger[s.ledger.length - 1].op = 'boundary';
        mutated++;
      }
    }

    // truncation extension: entity surface is a strict prefix of a longer
    // capitalized run in one of its sentences ("Davidson County Chancery" →
    // "… Court"). Mechanical when exactly one extension; model only if two compete.
    for (const e of s.graph.entities) {
      const ext = findExtension(e, s.sentences);
      if (ext && ext.candidates.length === 1) {
        const before = e.name;
        e.name = ext.candidates[0];
        logOp(s, { pass: 'canonicalize', op: 'extend', target: e.key,
          before: { name: before }, after: { name: e.name }, basis_sentence_idx: [ext.idx] });
        mutated++;
      }
    }

    // demote standalone role nouns typed as a thing/org but matching a role head
    for (const e of s.graph.entities) {
      if (ROLE_HEADS.test(e.name) && contentTokens(e.name).length <= 1) {
        if (!e.demoted) {
          e.demoted = true;
          e.attribute = true; // mark as attribute, not a free-standing entity
          logOp(s, { pass: 'type', op: 'flag', target: e.key,
            before: { type: e.type, demoted: false }, after: { type: 'attribute', demoted: true },
            basis_sentence_idx: (e.sents || []).slice(0, 1), confidence: 'settled' });
          mutated++;
        }
      }
    }
    if (mutated) { syncEdgeNames(s); s.entIndex = buildIndex(s.graph); }
    return mutated;
  }

  // Keep edge endpoint names in step with their entities after a rename, so the
  // spine and edge list never show a stale surface (e.g. a pre-extension name).
  function syncEdgeNames(s) {
    const byKey = new Map(s.graph.entities.map(e => [e.key, e]));
    for (const ed of s.graph.edges) {
      const a = byKey.get(ed.a), b = byKey.get(ed.b);
      if (a) ed.aName = a.name;
      if (b) ed.bName = b.name;
    }
  }

  // If the entity name is a strict prefix of a longer capitalized run in its
  // sentences, return the candidate extensions.
  function findExtension(e, sentences) {
    const name = e.name.trim();
    if (!/[A-Z]/.test(name) || name.length < 4) return null;
    const candidates = new Set();
    let foundIdx = null;
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '(\\s+[A-Z][A-Za-z\'’\\-]+)+', 'g');
    for (const si of (e.sents || [])) {
      const sent = String(sentences[si] || '');
      let m;
      while ((m = re.exec(sent)) !== null) {
        const full = m[0].trim();
        if (full !== name && full.length > name.length) { candidates.add(full); if (foundIdx == null) foundIdx = si; }
      }
    }
    if (!candidates.size) return null;
    return { candidates: [...candidates], idx: foundIdx };
  }

  /* ============================================================
     §6.1  Entity canonicalization (merge)
     Mechanical blocking generates candidate pairs (shared content token, or
     substring/alias, or edit-sim ≥ θ). Exact-alias/substring merge mechanically;
     ambiguous pairs go to the merge oracle with permute-and-agree.
     ============================================================ */
  const MERGE_SIM_THETA = 0.86;

  async function passCanonicalize(s) {
    let mutated = 0;
    const ents = s.graph.entities.filter(e => !e.merged);
    const pairs = [];
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const a = ents[i], b = ents[j];
        if (a.merged || b.merged) continue;
        const block = blockReason(a, b);
        if (block) pairs.push({ a, b, block });
      }
    }
    for (const p of pairs) {
      if (p.a.merged || p.b.merged) continue;
      const { a, b, block } = p;
      // mechanical-decidable merges: exact alias / exact substring containment
      if (block.kind === 'exact-alias' || block.kind === 'contained') {
        doMerge(s, a, b, block.kind, []);
        mutated++; continue;
      }
      // ambiguous: ask the oracle (permute A/B), else keep separate (deferred)
      if (!s.model) {
        logOp(s, { pass: 'canonicalize', op: 'merge', target: a.key,
          before: { a: a.name, b: b.name }, after: { merged: false },
          basis_sentence_idx: sharedSents(a, b), confidence: 'open', abstained: true, deferred: true });
        continue;
      }
      const frames = [
        { suffix: buildSuffix('merge', null, { a: a.name, b: b.name }), map: mapMerge },
        { suffix: buildSuffix('merge', null, { a: b.name, b: a.name }), map: mapMerge },
      ];
      const r = await permuteAndAgree(s.model, s.account, 'merge', frames);
      if (r.deferred) {
        logOp(s, { pass: 'canonicalize', op: 'merge', target: a.key,
          before: { a: a.name, b: b.name }, after: { merged: false },
          basis_sentence_idx: sharedSents(a, b), confidence: 'open', abstained: true, deferred: true, model_calls: r.calls });
        continue;
      }
      if (r.choice === 'Y' && !r.abstained) {
        doMerge(s, a, b, 'model', sharedSents(a, b), r);
        mutated++;
      } else {
        logOp(s, { pass: 'canonicalize', op: 'merge', target: a.key,
          before: { a: a.name, b: b.name }, after: { merged: false },
          basis_sentence_idx: sharedSents(a, b),
          confidence: r.abstained ? 'open' : 'settled', abstained: r.abstained,
          model_calls: r.calls, frames_agreed: r.frames_agreed });
      }
    }
    if (mutated) s.entIndex = buildIndex(s.graph);
    return mutated;
  }

  const mapMerge = (raw) => (raw === 'Y' || raw === 'N' ? raw : null); // '?' or other → abstain

  function sharedSents(a, b) {
    const sb = new Set(b.sents || []);
    return (a.sents || []).filter(x => sb.has(x));
  }

  // Why might a and b be the same entity? Returns null (no candidate) or a reason.
  function blockReason(a, b) {
    const na = normName(a.name), nb = normName(b.name);
    if (na === nb) return { kind: 'exact-alias' };
    // alias list hit
    const aliasesA = new Set((a.aliases || []).map(normName));
    const aliasesB = new Set((b.aliases || []).map(normName));
    if (aliasesA.has(nb) || aliasesB.has(na)) return { kind: 'exact-alias' };
    // strict containment of one full name inside the other, as whole words
    if (wordContains(na, nb) || wordContains(nb, na)) {
      // BUT: a shorter name that is a meaningful sub-place ("South Nashville" vs
      // "Nashville") must NOT be auto-merged — containment alone is suspect when
      // the longer adds a discriminating modifier. Only auto-merge on acronym /
      // exact head match; otherwise route to the model.
      if (isAcronymOf(a.name, b.name) || isAcronymOf(b.name, a.name)) return { kind: 'contained' };
      return { kind: 'overlap' };
    }
    // shared content token OR high edit similarity → a candidate pair (model)
    const ta = new Set(contentTokens(a.name)), tb = contentTokens(b.name);
    if (tb.some(t => ta.has(t))) return { kind: 'shared-token' };
    if (editSim(a.name, b.name) >= MERGE_SIM_THETA) return { kind: 'edit-sim' };
    return null;
  }

  // whole-word containment of `needle` inside `hay` (both normalized)
  function wordContains(hay, needle) {
    if (!needle || hay === needle) return false;
    return new RegExp('(^|\\s)' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(hay);
  }

  // is `acr` the initialism of `full`? ("NDP" of "Nashville Downtown Partnership")
  function isAcronymOf(acr, full) {
    const a = String(acr).replace(/[^A-Za-z]/g, '');
    if (a.length < 2 || a.length > 6 || a !== a.toUpperCase()) return false;
    const heads = contentTokens(full).map(t => t[0]).join('');
    return heads.toLowerCase() === a.toLowerCase();
  }

  function doMerge(s, a, b, how, basis, r) {
    // keep the longer / heavier name as canonical
    const keep = (a.mass || 0) >= (b.mass || 0) ? a : b;
    const drop = keep === a ? b : a;
    const before = { keep: keep.name, drop: drop.name };
    keep.aliases = keep.aliases || [];
    if (!keep.aliases.map(normName).includes(normName(drop.name))) keep.aliases.push(drop.name);
    for (const al of (drop.aliases || [])) if (!keep.aliases.map(normName).includes(normName(al))) keep.aliases.push(al);
    keep.sents = unionSorted(keep.sents, drop.sents);
    keep.mentions = unionArr(keep.mentions, drop.mentions);
    keep.mass = (keep.mass || 0) + (drop.mass || 0);
    drop.merged = keep.key;
    // redirect edges referencing the dropped key
    for (const ed of s.graph.edges) {
      if (ed.a === drop.key) { ed.a = keep.key; ed.aName = keep.name; }
      if (ed.b === drop.key) { ed.b = keep.key; ed.bName = keep.name; }
    }
    addCoref(s, keep.key, drop.key);
    logOp(s, { pass: 'canonicalize', op: 'merge', target: keep.key,
      before, after: { canonical: keep.name, alias: drop.name },
      basis_sentence_idx: basis || [], confidence: how === 'model' ? 'supported' : 'settled',
      model_calls: r ? r.calls : 0, frames_agreed: r ? r.frames_agreed : null });
  }

  const unionArr = (a, b) => { const o = (a || []).slice(); for (const x of (b || [])) if (!o.includes(x)) o.push(x); return o; };
  const unionSorted = (a, b) => [...new Set([...(a || []), ...(b || [])])].sort((x, y) => x - y);

  /* ============================================================
     §6.2  Type repair
     Flag suspects mechanically (org heads, role nouns, mistyped things), then
     ask the type oracle (permute the legend) only on the suspects.
     ============================================================ */
  async function passType(s) {
    let mutated = 0;
    for (const e of s.graph.entities) {
      if (e.merged || e.demoted) continue;
      const suspectOrg = ORG_HEADS.test(e.name) && e.type !== 'org';
      if (!suspectOrg) continue;
      // strong lexical signal: an org head present and currently mistyped.
      if (!s.model) {
        if (e.type !== 'org') {
          const before = e.type; e.type = 'org';
          logOp(s, { pass: 'type', op: 'retype', target: e.key,
            before: { type: before }, after: { type: 'org' },
            basis_sentence_idx: (e.sents || []).slice(0, 1), confidence: 'settled' });
          mutated++;
        }
        continue;
      }
      const idx = (e.sents || [])[0];
      const data = { name: e.name, idx, sentence: String(s.sentences[idx] || '') };
      const frames = [
        { suffix: buildSuffix('type', data, { legend: 'P=place O=org H=person T=thing' }), map: mapType },
        { suffix: buildSuffix('type', data, { legend: 'T=thing H=person O=org P=place' }), map: mapType },
      ];
      const r = await permuteAndAgree(s.model, s.account, 'type', frames);
      const want = r.choice ? TYPE_OF[r.choice] : null;
      if (!r.abstained && want && want !== e.type) {
        const before = e.type; e.type = want;
        logOp(s, { pass: 'type', op: 'retype', target: e.key,
          before: { type: before }, after: { type: want },
          basis_sentence_idx: [idx], confidence: 'supported',
          model_calls: r.calls, frames_agreed: r.frames_agreed });
        mutated++;
      } else if (r.abstained || r.deferred) {
        logOp(s, { pass: 'type', op: 'retype', target: e.key,
          before: { type: e.type }, after: { type: e.type },
          basis_sentence_idx: [idx], confidence: 'open', abstained: true,
          deferred: !!r.deferred, model_calls: r.calls, frames_agreed: r.frames_agreed });
      }
    }
    if (mutated) s.entIndex = buildIndex(s.graph);
    return mutated;
  }

  const TYPE_OF = { P: 'place', O: 'org', H: 'person', T: 'thing' };
  const mapType = (raw) => (TYPE_OF[raw] ? raw : null);

  /* ============================================================
     §6.3  Kin / possessive site-minting — the Corman fix
     A kin DEF (possessive + kin noun) mints a distinct person site keyed
     `kin:<rel>:<possessor>`, then re-attaches the kin clause's predicate off
     the possessor and onto the new site, vetoed by §5.
     ============================================================ */
  async function passKin(s) {
    let mutated = 0;
    const triggers = collectKinTriggers(s);
    for (const t of triggers) {
      // 1. resolve possessor P
      const P = await resolvePossessor(s, t);
      if (!P) {
        logOp(s, { pass: 'kin-mint', op: 'resolve', target: t.surface,
          before: null, after: { resolved: false },
          basis_sentence_idx: [t.idx], confidence: 'open', abstained: true });
        continue;
      }
      // 2. mint site K (idempotence guard on stable key)
      const rel = t.relation;
      const key = 'kin:' + rel + ':' + bareKey(P.key);
      let K = s.entIndex.byKey.get(key);
      if (!K) {
        K = { name: P.name + "'s " + rel, key, type: 'person', mentions: [t.surface],
              mass: 1, sents: [t.idx], minted: true, kin: { relation: rel, of: P.key } };
        s.graph.entities.push(K);
        s.entIndex = buildIndex(s.graph);
        logOp(s, { pass: 'kin-mint', op: 'mint', target: key,
          before: null, after: { name: K.name, type: 'person', of: P.key, relation: rel },
          basis_sentence_idx: [t.idx], confidence: 'settled' });
        mutated++;
      }
      // register the kin surface so the subject veto knows this clause's subject
      const surfaceText = t.possessive + ' ' + rel;
      if (!s.kinSurfaces.some(x => x.key === key && x.surface === surfaceText)) {
        s.kinSurfaces.push({ surface: surfaceText, key });
      }
      addCoref(s, key, P.key); // K is P's kin — a real, explicit link (not identity)

      // 3. re-attach predicates whose carrying clause holds the kin term and
      //    that the greedy pass attached to P — move them P → K.
      mutated += reattachKinPredicates(s, P, K, t);
    }
    return mutated;
  }

  const bareKey = (k) => String(k).split(':').pop().replace(/[^a-z0-9]/gi, '').toLowerCase();

  // Find kin triggers: kin DEFs in graph.defs, plus possessive+kin-noun shapes
  // in the sentences (so it works even on graphs without a kin DEF).
  function collectKinTriggers(s) {
    const out = [];
    const seen = new Set();
    for (const d of (s.graph.defs || [])) {
      if (d.path !== 'kin' || !d.value) continue;
      const rel = String(d.value).toLowerCase();
      if (!KIN.has(rel)) continue;
      const idx = sentenceForDef(s, d, rel);
      const poss = possessiveAt(s.sentences[idx], rel) || 'their';
      const k = rel + '@' + idx;
      if (seen.has(k)) continue; seen.add(k);
      out.push({ relation: rel, idx, surface: d.target || rel, possessive: poss, def: d });
    }
    // scan sentences for "his/her/their <kin>" not already captured
    const re = /\b(his|her|their|its)\s+(?:(?:own|late|elder|younger|eldest|youngest)\s+)?([a-z]+)\b/gi;
    for (let i = 0; i < s.sentences.length; i++) {
      const sent = String(s.sentences[i] || '');
      let m;
      while ((m = re.exec(sent)) !== null) {
        const rel = m[2].toLowerCase();
        if (!KIN.has(rel)) continue;
        const k = rel + '@' + i;
        if (seen.has(k)) continue; seen.add(k);
        out.push({ relation: rel, idx: i, surface: m[0], possessive: m[1].toLowerCase() });
      }
    }
    return out;
  }

  function sentenceForDef(s, d, rel) {
    if (d.basis && typeof d.basis === 'object' && d.basis.sentence_idx != null) return d.basis.sentence_idx;
    // fall back: the first sentence containing a possessive+rel
    for (let i = 0; i < s.sentences.length; i++) {
      if (possessiveAt(s.sentences[i], rel)) return i;
    }
    return 0;
  }

  function possessiveAt(sent, rel) {
    const m = new RegExp('\\b(his|her|their|its)\\s+(?:(?:own|late|elder|younger|eldest|youngest)\\s+)?'
      + rel + '\\b', 'i').exec(String(sent || ''));
    return m ? m[1].toLowerCase() : null;
  }

  // Resolve the possessor: the gender-agreeing active entity nearest before the
  // possessive. One entity → mechanical; >1 → anaphora oracle; abstain → skip.
  async function resolvePossessor(s, t) {
    const gender = POSS_GENDER[t.possessive];
    // candidate possessors: person entities mentioned in this or a prior sentence
    const persons = s.graph.entities.filter(e => !e.merged && !e.minted && e.type === 'person');
    // restrict to those appearing in sentences ≤ t.idx, prefer the nearest
    const scored = [];
    for (const e of persons) {
      const near = (e.sents || []).filter(si => si <= t.idx);
      if (!near.length) continue;
      const dist = t.idx - Math.max(...near);
      scored.push({ e, dist });
    }
    scored.sort((x, y) => x.dist - y.dist);
    if (!scored.length) return null;
    // gender-filter if the possessive marks gender and entities carry it
    let active = scored.map(x => x.e);
    if (gender) {
      const g = active.filter(e => !e.gender || e.gender === gender);
      if (g.length) active = g;
    }
    // exactly one near, active, agreeing entity → mechanical
    const nearWindow = scored.filter(x => x.dist <= 1).map(x => x.e).filter(e => active.includes(e));
    if (nearWindow.length === 1) return nearWindow[0];
    if (active.length === 1) return active[0];
    // >1 → one anaphora call with permute-and-agree
    if (!s.model) return nearWindow[0] || active[0] || null; // degraded: nearest agreeing
    const options = active.slice(0, 4);
    const window = buildWindow(s, t.idx);
    const data = { window, atIdx: t.idx, surface: t.possessive };
    const fwd = options, rev = options.slice().reverse();
    const frames = [
      { suffix: buildSuffix('anaphora', data, { options: fwd }), map: mapAnaphora(fwd) },
      { suffix: buildSuffix('anaphora', data, { options: rev }), map: mapAnaphora(rev) },
    ];
    const r = await permuteAndAgree(s.model, s.account, 'anaphora', frames);
    if (r.abstained || !r.choice) return null;
    return r.choice; // an entity object (mapAnaphora returns it)
  }

  // map a "1".."4"/"N" answer to the entity at that position in the frame's list
  const mapAnaphora = (opts) => (raw) => {
    if (raw === 'N' || raw == null) return null;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > opts.length) return null;
    return opts[n - 1];
  };

  function buildWindow(s, idx) {
    const lo = Math.max(0, idx - 1), hi = Math.min(s.sentences.length - 1, idx);
    const w = [];
    for (let i = lo; i <= hi; i++) w.push({ idx: i, text: String(s.sentences[i] || '').trim() });
    return w;
  }

  // Move role/class/edge predicates carried by the kin clause from P onto K,
  // vetoed by §5 (the cited sentence's subject must be the kin term, not P).
  function reattachKinPredicates(s, P, K, t) {
    let moved = 0;
    const idx = t.idx;
    // (a) edges deposited on sentence `idx` that currently touch P → re-point to K
    for (const ed of s.graph.edges) {
      const onSent = ed.sent === idx || (ed.sents && ed.sents.includes(idx));
      const touchesP = ed.a === P.key || ed.b === P.key;
      if (!touchesP) continue;
      // only move edges whose evidence is the kin clause
      if (ed.sent != null && ed.sent !== idx) continue;
      if (ed.sent == null && !onSent) {
        // no sentence anchor on the edge: only move if the kin clause's verb is the edge verb
        if (!clauseHasVerb(s.sentences[idx], ed.verb)) continue;
      }
      const ok = subjectMatch(K.key, idx, s.sentences, s.entIndex, s.corefThisRun, s.kinSurfaces);
      const before = { a: ed.a, b: ed.b, aName: ed.aName, bName: ed.bName };
      if (ok) {
        if (ed.a === P.key) { ed.a = K.key; ed.aName = K.name; }
        if (ed.b === P.key) { ed.b = K.key; ed.bName = K.name; }
        logOp(s, { pass: 'kin-mint', op: 'reattach', target: K.key,
          before, after: { a: ed.a, b: ed.b, aName: ed.aName, bName: ed.bName },
          basis_sentence_idx: [idx], subject_match: true, confidence: 'settled' });
        moved++;
      } else {
        logOp(s, { pass: 'kin-mint', op: 'reattach', target: K.key,
          before, after: before, basis_sentence_idx: [idx], subject_match: false,
          confidence: 'open', abstained: true });
      }
    }
    // (b) class assertions on the kin clause attached to P → move to K
    for (const a of s.graph.assertions) {
      const subjKey = (s.entIndex.byNorm.get(normName(a.subject)) || {}).key;
      if (subjKey !== P.key) continue;
      // is the assertion's predicate carried in the kin clause sentence?
      if (!assertionOnSentence(a, idx, s.sentences)) continue;
      const ok = subjectMatch(K.key, idx, s.sentences, s.entIndex, s.corefThisRun, s.kinSurfaces);
      const before = { subject: a.subject, is: a.is };
      if (ok) {
        a.subject = K.name;
        logOp(s, { pass: 'kin-mint', op: 'reattach', target: K.key,
          before, after: { subject: K.name, is: a.is },
          basis_sentence_idx: [idx], subject_match: true, confidence: 'settled' });
        moved++;
      } else {
        logOp(s, { pass: 'kin-mint', op: 'reattach', target: K.key,
          before, after: before, basis_sentence_idx: [idx], subject_match: false,
          confidence: 'open', abstained: true });
      }
    }
    return moved;
  }

  function clauseHasVerb(sent, verb) {
    if (!verb) return false;
    return new RegExp('\\b' + String(verb).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(String(sent || ''));
  }

  function assertionOnSentence(a, idx, sentences) {
    const sent = normName(sentences[idx] || '');
    const isToks = contentTokens(a.is);
    return isToks.length ? isToks.some(t => sent.includes(t)) : false;
  }

  /* ============================================================
     §6.4  Anaphora resolution + null triage
     Re-walk graph.nulls against the clean inventory; sort each into
     resolved / artifact / open and rewrite null.reason. The integrity of the
     `open` bin is the value of the whole pass.
     ============================================================ */
  async function passAnaphora(s) {
    let mutated = 0;
    const nulls = s.graph.nulls || [];
    for (const n of nulls) {
      if (n._triaged) continue;
      const competing = (n.competing || []).map(c => resolveCompetitor(s, c)).filter(Boolean);
      // artifact: the stall dissolved from canonicalization/boundary repair —
      // its competitors collapsed to a single canonical entity (or vanished).
      const distinct = new Set(competing.map(e => e.key));
      if (n.competing && n.competing.length >= 2 && distinct.size <= 1) {
        n.reason = 'artifact:canonicalized'; n._triaged = true;
        logOp(s, { pass: 'anaphora', op: 'flag', target: 'null:' + (n.seq != null ? n.seq : n.sentence_idx),
          before: { reason: n._origReason || null, competing: (n.competing || []).length },
          after: { reason: n.reason }, basis_sentence_idx: [n.sentence_idx], confidence: 'settled' });
        mutated++; continue;
      }
      if (!competing.length) {
        // nothing to bind against in the text → genuinely open
        n._origReason = n._origReason || n.reason;
        n.reason = 'open:textual'; n._triaged = true;
        logOp(s, { pass: 'anaphora', op: 'flag', target: 'null:' + (n.seq != null ? n.seq : n.sentence_idx),
          before: { reason: n._origReason }, after: { reason: n.reason },
          basis_sentence_idx: [n.sentence_idx], confidence: 'settled' });
        mutated++; continue;
      }
      // model decision over the competitors
      if (!s.model) {
        n._origReason = n._origReason || n.reason;
        n.reason = 'open:deferred'; n._triaged = true;
        logOp(s, { pass: 'anaphora', op: 'resolve', target: 'null:' + (n.seq != null ? n.seq : n.sentence_idx),
          before: { reason: n._origReason }, after: { reason: n.reason },
          basis_sentence_idx: [n.sentence_idx], confidence: 'open', abstained: true, deferred: true });
        continue;
      }
      const options = competing.slice(0, 4);
      const window = buildWindow(s, n.sentence_idx);
      const data = { window, atIdx: n.sentence_idx, surface: n.surface || 'it' };
      const fwd = options, rev = options.slice().reverse();
      const frames = [
        { suffix: buildSuffix('anaphora', data, { options: fwd }), map: mapAnaphora(fwd) },
        { suffix: buildSuffix('anaphora', data, { options: rev }), map: mapAnaphora(rev) },
      ];
      const r = await permuteAndAgree(s.model, s.account, 'anaphora', frames);
      n._origReason = n._origReason || n.reason;
      if (r.abstained || !r.choice) {
        n.reason = 'open:textual'; n._triaged = true;
        logOp(s, { pass: 'anaphora', op: 'resolve', target: 'null:' + (n.seq != null ? n.seq : n.sentence_idx),
          before: { reason: n._origReason }, after: { reason: n.reason },
          basis_sentence_idx: [n.sentence_idx], confidence: 'open', abstained: true,
          model_calls: r.calls, frames_agreed: r.frames_agreed });
        mutated++; continue;
      }
      const target = r.choice; // entity
      const sm = subjectMatch(target.key, n.sentence_idx, s.sentences, s.entIndex, s.corefThisRun, s.kinSurfaces);
      if (sm === false) {
        n.reason = 'open:textual'; n._triaged = true;
        logOp(s, { pass: 'anaphora', op: 'resolve', target: 'null:' + (n.seq != null ? n.seq : n.sentence_idx),
          before: { reason: n._origReason }, after: { reason: n.reason },
          basis_sentence_idx: [n.sentence_idx], subject_match: false, confidence: 'open', abstained: true,
          model_calls: r.calls, frames_agreed: r.frames_agreed });
        mutated++; continue;
      }
      // resolved: mint a coref edge, drop from open nulls
      n.reason = 'resolved'; n.resolved_to = target.key; n._triaged = true;
      s.graph.edges.push({ a: target.key, b: target.key, aName: target.name, bName: target.name,
        verb: 'coref', weight: 1, sent: n.sentence_idx, minted: true });
      addCoref(s, target.key, target.key);
      logOp(s, { pass: 'anaphora', op: 'resolve', target: 'null:' + (n.seq != null ? n.seq : n.sentence_idx),
        before: { reason: n._origReason }, after: { reason: 'resolved', to: target.key },
        basis_sentence_idx: [n.sentence_idx], subject_match: sm, confidence: 'supported',
        model_calls: r.calls, frames_agreed: r.frames_agreed });
      mutated++;
    }
    return mutated;
  }

  function resolveCompetitor(s, c) {
    // c may be a key, a name, or an object {key|name}
    const key = c && typeof c === 'object' ? (c.key || c.name) : c;
    let e = s.entIndex.byKey.get(key) || s.entIndex.byNorm.get(normName(key));
    while (e && e.merged) e = s.entIndex.byKey.get(e.merged);
    return e || null;
  }

  /* ============================================================
     §6.5  Relation composition + spine
     Compose transitive edges across sentences (Turner→DMC, DMC→NDP ⇒
     Turner→NDP), validate each with a support call, order the keystone +
     support links into graph.spine.
     ============================================================ */
  async function passCompose(s) {
    let mutated = 0;
    const ents = s.graph.entities.filter(e => !e.merged && !e.demoted);
    // adjacency from existing edges
    const adj = new Map();
    for (const ed of s.graph.edges) {
      if (ed.verb === 'coref') continue;
      if (!adj.has(ed.a)) adj.set(ed.a, []);
      adj.get(ed.a).push(ed);
    }
    const have = new Set(s.graph.edges.map(e => e.a + ' ' + e.b + ' ' + (e.verb || '')));
    // per high-mass node, compose two-hops
    const heavy = ents.slice().sort((a, b) => (b.mass || 0) - (a.mass || 0)).slice(0, 12);
    for (const node of heavy) {
      const e1s = adj.get(node.key) || [];
      for (const e1 of e1s) {
        const e2s = adj.get(e1.b) || [];
        for (const e2 of e2s) {
          if (e2.b === node.key) continue;
          const verb = composeVerb(e1.verb, e2.verb);
          const k = node.key + ' ' + e2.b + ' ' + verb;
          if (have.has(k)) continue;
          const basis = [e1.sent, e2.sent].filter(x => x != null);
          const bName = (s.entIndex.byKey.get(e2.b) || {}).name || e2.bName;
          const composed = { a: node.key, b: e2.b, aName: node.name, bName, verb,
            weight: 1, composed: true, via: e1.b, basis_sentence_idx: basis };
          // validate with a support call before adding
          const claim = `${node.name} ${verb} ${bName}`;
          const okSupport = await validateClaim(s, claim, basis);
          if (okSupport.ok) {
            s.graph.edges.push(composed);
            have.add(k);
            logOp(s, { pass: 'compose', op: 'edge', target: node.key,
              before: null, after: { a: node.key, b: e2.b, verb, via: e1.b },
              basis_sentence_idx: basis, subject_match: okSupport.subject_match,
              confidence: okSupport.confidence, abstained: okSupport.abstained,
              model_calls: okSupport.calls, frames_agreed: okSupport.frames_agreed });
            mutated++;
          } else {
            logOp(s, { pass: 'compose', op: 'edge', target: node.key,
              before: null, after: { a: node.key, b: e2.b, verb, applied: false },
              basis_sentence_idx: basis, subject_match: okSupport.subject_match,
              confidence: okSupport.abstained ? 'open' : 'supported', abstained: okSupport.abstained,
              model_calls: okSupport.calls, frames_agreed: okSupport.frames_agreed });
          }
        }
      }
    }
    // Spine: order validated keystone assertions + composed/support links.
    mutated += buildSpine(s);
    return mutated;
  }

  function composeVerb(v1, v2) {
    // a minimal transitive verb composition; defaults to a generic link
    if (!v1 && !v2) return 'connected-to';
    return v1 || v2 || 'connected-to';
  }

  // Validate a claim against its cited sentences (support oracle). Mechanical
  // fallback when no model: accept iff the claim's content tokens appear.
  async function validateClaim(s, claim, basis) {
    const idx = basis.length ? basis[0] : null;
    if (!s.model) {
      const sent = normName((idx != null && s.sentences[idx]) || '');
      const toks = contentTokens(claim);
      const hit = toks.filter(t => sent.includes(t)).length;
      const ok = toks.length ? hit / toks.length >= 0.4 : false;
      return { ok, confidence: 'settled', abstained: false, calls: 0, frames_agreed: null,
        subject_match: idx != null ? true : null, deferred: true };
    }
    const sentence = String((idx != null && s.sentences[idx]) || '');
    const data = { claim, idx, sentence };
    const frames = [
      { suffix: buildSuffix('support', data, {}), map: mapSupport },
      { suffix: buildSuffix('support', data, {}), map: mapSupport },
    ];
    const r = await permuteAndAgree(s.model, s.account, 'support', frames);
    const sm = idx != null
      ? subjectMatch(claimSubjectKeyFrom(s, claim), idx, s.sentences, s.entIndex, s.corefThisRun, s.kinSurfaces)
      : null;
    const ok = !r.abstained && r.choice === 'F' && sm !== false;
    return { ok, confidence: r.choice === 'F' ? 'supported' : 'open', abstained: r.abstained,
      calls: r.calls, frames_agreed: r.frames_agreed, subject_match: sm };
  }

  const mapSupport = (raw) => (raw === 'F' || raw === 'P' || raw === 'N' ? raw : null);

  function claimSubjectKeyFrom(s, claim) {
    // the leading entity surface in the claim string
    const cl = normName(claim);
    let best = null, pos = Infinity;
    for (const e of s.graph.entities) {
      if (e.merged) continue;
      const p = cl.indexOf(normName(e.name));
      if (p !== -1 && p < pos) { pos = p; best = e.key; }
    }
    return best;
  }

  function buildSpine(s) {
    // keystone = the heaviest assertion / composed chain; build spine links from
    // composed edges and supported assertions, each carrying basis_sentence_idx.
    const links = [];
    const seen = new Set();
    for (const ed of s.graph.edges) {
      if (!ed.composed) continue;
      const k = ed.a + '>' + ed.b;
      if (seen.has(k)) continue; seen.add(k);
      links.push({ from: ed.a, to: ed.b, fromName: ed.aName, toName: ed.bName,
        verb: ed.verb, via: ed.via || null, basis_sentence_idx: ed.basis_sentence_idx || [] });
    }
    // Also surface single-hop heavy edges that form the keystone chain (so the
    // spine is non-empty even before composition validates).
    if (!links.length) {
      const heavyEdges = s.graph.edges.filter(e => e.verb && e.verb !== 'coref')
        .sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 4);
      for (const ed of heavyEdges) {
        const k = ed.a + '>' + ed.b;
        if (seen.has(k)) continue; seen.add(k);
        links.push({ from: ed.a, to: ed.b, fromName: ed.aName, toName: ed.bName,
          verb: ed.verb, basis_sentence_idx: ed.sent != null ? [ed.sent] : [] });
      }
    }
    if (!links.length) return 0;
    // only (re)write if the spine changed (idempotence)
    const next = links;
    const prev = Array.isArray(s.graph.spine) ? s.graph.spine : [];
    const same = JSON.stringify(prev) === JSON.stringify(next);
    if (same) return 0;
    const before = prev.slice();
    s.graph.spine = next;
    logOp(s, { pass: 'compose', op: 'spine-link', target: 'spine',
      before: { links: before.length }, after: { links: next.length },
      basis_sentence_idx: [...new Set(next.flatMap(l => l.basis_sentence_idx))].sort((a, b) => a - b),
      confidence: 'settled' });
    return 1;
  }

  /* ============================================================
     §6.6  Adversarial support + silence detection
     Support: re-judge each assertion/spine link against its sentence; flag
     over-reach. Silence: detect unfilled claim slots, emit nulls of omission
     (an auto-generated records-request list).
     ============================================================ */
  async function passSupport(s) {
    let mutated = 0;
    // adversarial support over assertions (only those with a locatable sentence)
    for (const a of s.graph.assertions) {
      if (a._supportChecked) continue;
      const subjKey = (s.entIndex.byNorm.get(normName(a.subject)) || {}).key;
      const idx = findAssertionSentence(s, a, subjKey);
      if (idx == null) { a._supportChecked = true; continue; }
      const claim = `${a.subject} is ${a.is}`;
      const r = await validateClaim(s, claim, [idx]);
      a._supportChecked = true;
      if (!r.ok && !r.deferred && !r.abstained) {
        a.overreach = true;
        logOp(s, { pass: 'support', op: 'flag', target: a.subject,
          before: { is: a.is }, after: { flag: 'over-reach: claim stronger than sourcing' },
          basis_sentence_idx: [idx], subject_match: r.subject_match,
          confidence: 'supported', model_calls: r.calls, frames_agreed: r.frames_agreed });
        mutated++;
      }
    }
    // silence detection (schema-driven, mechanical) — emit nulls of omission
    mutated += detectSilence(s);
    return mutated;
  }

  function findAssertionSentence(s, a, subjKey) {
    const e = subjKey ? s.entIndex.byKey.get(subjKey) : null;
    const sents = e ? (e.sents || []) : [];
    const isToks = contentTokens(a.is);
    for (const si of sents) {
      const sent = normName(s.sentences[si] || '');
      if (isToks.some(t => sent.includes(t))) return si;
    }
    return sents.length ? sents[0] : null;
  }

  // Claim slot schemas: a conflict-of-interest / self-dealing claim expects
  // {beneficiary, mechanism, dollar, dates}. Mechanically detect unfilled slots.
  const CLAIM_SLOTS = {
    'self-dealing': {
      detect: (s) => s.graph.assertions.some(a => /hires? his own|same person who runs|same man who runs|conflict|self-deal/i.test(JSON.stringify(a)))
        || s.graph.edges.some(e => e.composed),
      slots: [
        { name: 'dollar-figure', test: (s) => s.sentences.some(x => /\$[\d,]+|\d+\s*(dollars|usd)/i.test(x)) },
        { name: 'dates', test: (s) => s.sentences.some(x => /\b(19|20)\d{2}\b|\b\d{4}-\d{2}-\d{2}\b/.test(x)) },
        { name: 'contract-shown', test: (s) => s.sentences.some(x => /contract (was|is)? ?(shown|disclosed|published)/i.test(x)) },
      ],
    },
  };

  function detectSilence(s) {
    let made = 0;
    s.graph.nulls = s.graph.nulls || [];
    const existing = new Set(s.graph.nulls.filter(n => n.reason && n.reason.startsWith('omission:')).map(n => n.reason));
    for (const [claimType, schema] of Object.entries(CLAIM_SLOTS)) {
      if (!schema.detect(s)) continue;
      for (const slot of schema.slots) {
        const filled = slot.test(s);
        if (filled) continue;
        const reason = 'omission:' + claimType + ':' + slot.name;
        if (existing.has(reason)) continue;
        const n = { seq: null, sentence_idx: null, reason, surface: null,
          omission: { claim: claimType, slot: slot.name }, _triaged: true };
        s.graph.nulls.push(n);
        existing.add(reason);
        logOp(s, { pass: 'silence', op: 'flag', target: reason,
          before: null, after: { claim: claimType, slot: slot.name, status: 'not stated in scope' },
          basis_sentence_idx: [], confidence: 'settled' });
        made++;
      }
    }
    return made;
  }

  /* ============================================================
     §8  Fixed-point driver
     A pass sweep = §6.0–6.6 once. Iterate sweeps (each sees the prior sweep's
     mutations as input) until M=∅, passes===maxPasses, or budget exhausted.
     Idempotence: stable keys + existence guards ⇒ re-running an enriched graph
     yields M=∅ on the first sweep.
     ============================================================ */
  async function runFixedPoint(s, onProgress) {
    const trace = [];
    let pass = 0;
    for (; pass < s.budget.maxPasses; pass++) {
      let M = 0;
      const sweepStart = s.ledger.length;
      M += passBoundary(s);
      M += await passCanonicalize(s);
      M += await passType(s);
      M += await passKin(s);
      M += await passAnaphora(s);
      M += await passCompose(s);
      M += await passSupport(s);
      const ops = s.ledger.length - sweepStart;
      trace.push({ pass: pass + 1, mutations: M, ops });
      if (onProgress) { try { onProgress({ pass: pass + 1, total: s.budget.maxPasses, mutations: M, ops }); } catch (e) {} }
      if (M === 0) { pass++; break; }
      if (s.account.deferred && s.account.spent >= s.account.max) {
        // budget exhausted: finish current op, continue mechanical-only next sweep
      }
    }
    const stillFlickering = trace.length && trace[trace.length - 1].mutations > 0;
    return {
      passes: pass,
      mutations_per_pass: trace,
      model_calls: s.account.spent,
      budget_exhausted: s.account.deferred,
      converged: !stillFlickering,
    };
  }

  /* ============================================================
     The public entry point.
     enrich(input) → Promise<{ graph, ledger, convergence, alignment }>.
     Synchronous-safe: works with or without a model. Errors on misalignment.
     ============================================================ */
  async function enrich(input, onProgress) {
    if (!input || typeof input !== 'object') throw alignmentError('no-input', 'EnrichInput required');
    const alignment = validateAlignment(input.graph, input.sentences);
    const s = makeSession(input);

    const convergence = await runFixedPoint(s, onProgress);

    // strip internal bookkeeping fields from the emitted graph copy, but keep
    // the enrichment-visible additions (aliases, minted/kin, demoted, merged).
    cleanGraph(s.graph);

    // header line for the ledger (a convergence trace receipt)
    const header = {
      schema: SCHEMA, kind: 'header', at: new Date().toISOString(),
      doc: s.graph.doc ? { id: s.graph.doc.id, sentences: s.graph.doc.sentences } : null,
      passes: convergence.passes,
      mutations_per_pass: convergence.mutations_per_pass,
      model_calls: convergence.model_calls,
      model: input.model ? 'present' : 'absent (degraded)',
      budget_exhausted: convergence.budget_exhausted,
      converged: convergence.converged,
      alignment,
    };

    return { graph: s.graph, ledger: s.ledger, header, convergence, alignment };
  }

  function cleanGraph(graph) {
    for (const e of graph.entities) {
      delete e._origReason;
    }
    for (const n of (graph.nulls || [])) delete n._triaged;
    for (const a of (graph.assertions || [])) delete a._supportChecked;
  }

  /* ---- JSONL serialization for the ledger (mirrors cleo-audit/1 style) ---- */
  function toJSONL(result) {
    const lines = [];
    if (result.header) lines.push(JSON.stringify(result.header));
    for (const op of (result.ledger || [])) lines.push(JSON.stringify(op));
    return lines.join('\n');
  }

  const api = {
    SCHEMA, enrich, validateAlignment, toJSONL,
    // exposed for tests / introspection
    _internals: {
      normName, contentTokens, editSim, blockReason, isAcronymOf, subjectMatch,
      mechanicalSubjectKey, permuteAndAgree, GRAMMARS, PREFIX, buildSuffix,
      collectKinTriggers, findExtension,
    },
  };

  if (typeof window !== 'undefined') window.EOEnrich = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
