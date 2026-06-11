/* ============================================================
   Reading conformance — the seven invariants, made mechanical.

   Scores a `cleon-ingestion/1` dump (the Ingestion drawer's Export
   JSON) as a 7-bit vector in invariant order:

     ADMISSION BINDING SPEECH COMPANY DARK WEIGHT CUSTOM

   The law each bit enforces is docs/reading-conformance.md. This
   tool is the spec's Check blocks and nothing else: every verdict
   cites the events or entities that earned it, and a bit is 1 only
   when the dump's own marks prove the law was followed. Deterministic;
   no model; no dependencies.

   Operator semantics the checker assumes (per the spec):
     CON — a bond: two resolved referents joined by a deed. The
           common case; the edge list is the projection of CON.
     SYN — synthesis: something greater than the sum of its parts
           (a merger/coalescence minting a canonical whole). Rare.
           A resolved deed filed as SYN is invariant 2 failing.

   Usage:
     node tools/conformance.js dump.json [more-dumps.json …]
            [--session audit.jsonl]   session-side advisory checks
            [--pack pack.json]        override the surface-criteria pack
            [--floor 0.34]            retrieval relevance floor (session)
            [--json out.json]         machine-readable report
            [--quiet]                 vector + verdict only
     node tools/conformance.js --parse article.txt
            parse a text with the live engine first (dev: needs
            tests/harness + compromise), then score its dump.

   Exit codes: 0 every dump conforms · 1 any bit is 0 · 2 usage/load.

   Two of the spec's checks cannot be made from a dump and are NOT
   scored here (they are engine/source-level): WEIGHT's replay
   equality, and CUSTOM's `grep(engine, surface_pattern_literals)`.
   Session-side findings (audit JSONL) are advisory and never move
   a bit — the vector scores the dump, as the spec scores it.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const INVARIANTS = ['ADMISSION', 'BINDING', 'SPEECH', 'COMPANY', 'DARK', 'WEIGHT', 'CUSTOM'];

/* ---------- the pack: every surface criterion lives here, not in the
   checks (invariant 7 applies to the instrument too — the engine/
   conventions distinction is sacrosanct, so the check logic below knows
   only the four laws and the operator schema, and every pattern, lexicon,
   reason word, and threshold resolves through this pack). Override any
   of it with --pack file.json; no check needs editing to enter a new
   register. ---------- */
const DEFAULT_PACK = {
  // page furniture: used only when a dump carries no chrome marks of its
  // own (a conforming dump marks chrome dark with reason 'chrome').
  chrome_patterns: [
    '^by\\s+\\S',                                  // byline
    '^https?://',                                  // bare link
    '^(\\u00a9|\\(c\\)|copyright)\\b',             // copyright line
    '^page\\s+\\d+$', '^\\d+$',                    // pagination
    '^advertisement\\b',                           // ad slug
  ],
  // a run of capitalized link-words with no sentence-final punctuation
  chrome_link_run_max_words: 8,
  chrome_function_words: ['the', 'a', 'an', 'of', 'in', 'on', 'to', 'and', 'or', 'for', 'with', 'at', 'by', 'from', 'as', 'is', 'was', 'are', 'were'],
  // surfaces that never resolve to a referent on their own (hints only)
  pronouns: ['he', 'she', 'it', 'they', 'him', 'her', 'them', 'his', 'hers', 'its', 'their', 'theirs', 'i', 'we', 'you', 'me', 'us', 'this', 'that', 'these', 'those', 'who', 'whom'],
  // SIG.attributed values that are earned bindings vs honest absences
  attributed_earned: ['named', 'pronoun', 'provisional', 'continuation'],
  attributed_honest: ['none', 'unattributed'],
  // speaker types that may not hold the floor without a transmuting DEF
  speechless_types: ['place', 'org', 'organization'],
  // DEF(class) values that are legitimate type transmutations, not fragments
  type_lexicon: ['person', 'place', 'org', 'organization', 'thing', 'voice', 'record'],
  // what a frame reference looks like when stored as a DEF value
  frame_ref: '^frame:[0-9a-f]{8,}$',
  // DEF targets that are document structure, not referents
  structural_def_targets: ['(schema)', '(header)', '(doc)'],
  // REC actions that admit a rule (and so need a ledger lid + 2 sightings)
  rule_admitting_actions: ['add-token', 'admit'],
  // event fields that are weights and may live only inside observed.*
  weight_fields: ['confidence', 'score', 'weight'],
  // the reason word a dump uses to mark a chrome span dark, and the key
  // that identifies an admitted chrome custom in the log
  chrome_reason: 'chrome',
  // session: retrieval relevance floor (the engine's own citation floor)
  floor: 0.34,
  // session: one proposal citing at least this many friction spans is degenerate
  degenerate_proposal_spans: 10,
};

/* ---------- small shared mechanics ---------- */

// fold: case + diacritics + whitespace, so 'Guzmán' meets 'guzman'.
function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
const foldTokens = (s) => fold(s).split(' ').filter(Boolean);

function isChromeSpan(text, pack) {
  const t = String(text == null ? '' : text).trim();
  if (!t || /^["'“‘«—]/.test(t)) return false;   // speech is never furniture
  for (const p of pack.chrome_patterns) if (new RegExp(p, 'i').test(t)) return true;
  if (/[.!?…]["')”’]*$/.test(t)) return false;        // a finished sentence
  const words = t.split(/\s+/);
  if (!words.length || words.length > pack.chrome_link_run_max_words) return false;
  const fn = new Set(pack.chrome_function_words);
  return words.every(w => /^[A-Z0-9]/.test(w) && !fn.has(w.toLowerCase()));
}

/* ---------- the dump, read once into a context every check shares ---------- */
function buildContext(report, pack) {
  const events = Array.isArray(report.events) ? report.events : [];
  const spans = Array.isArray(report.spans) ? report.spans : [];
  const entities = Array.isArray(report.entities) ? report.entities : [];

  // events by span — derived from the log itself, never trusted from a summary
  const evBySent = new Map();
  for (const ev of events) {
    if (ev.sentence_idx == null) continue;
    if (!evBySent.has(ev.sentence_idx)) evBySent.set(ev.sentence_idx, []);
    evBySent.get(ev.sentence_idx).push(ev);
  }

  // chrome: the dump's own marks first, the pack heuristic as fallback
  const chromeSents = new Set();
  const perSent = Array.isArray(report.sentences) ? report.sentences : [];
  for (const s of perSent) if (s && s.reason === pack.chrome_reason) chromeSents.add(s.i);
  if (Array.isArray(report.dark)) for (const d of report.dark) if (d && d.reason === pack.chrome_reason) chromeSents.add(d.i);
  for (const ev of events) if (ev.op === 'NUL' && ev.reason === pack.chrome_reason && ev.sentence_idx != null) chromeSents.add(ev.sentence_idx);
  spans.forEach((t, i) => { if (isChromeSpan(t, pack)) chromeSents.add(i); });

  // referent table: INS mints names for referent ids; mergers chain them
  const refName = new Map();
  for (const ev of events) if (ev.op === 'INS' && ev.referent_id) refName.set(ev.referent_id, ev.target);
  for (const ev of events) {
    if (ev.op !== 'SYN' || !Array.isArray(ev.referent_ids) || !ev.canonical_referent_id) continue;
    const canonical = ev.canonical || refName.get(ev.canonical_referent_id);
    for (const r of ev.referent_ids) if (canonical) refName.set(r, canonical);
  }

  // entity lookup by folded surface: exact name/key, then token containment
  const byFold = new Map();
  for (const e of entities) {
    byFold.set(fold(e.name), e);
    if (e.key) byFold.set(fold(e.key), e);
  }
  const pronouns = new Set(pack.pronouns);
  function resolveSurface(surface) {
    const f = fold(surface);
    if (!f || pronouns.has(f)) return null;
    if (byFold.has(f)) return byFold.get(f);
    const sTok = new Set(foldTokens(surface));
    let best = null, bestN = 0;
    for (const e of entities) {
      const eTok = foldTokens(e.name);
      if (!eTok.length) continue;
      const contained = eTok.every(t => sTok.has(t)) || [...sTok].every(t => new Set(eTok).has(t));
      if (contained && (eTok.length > bestN || (eTok.length === bestN && best && (e.mass || 0) > (best.mass || 0)))) { best = e; bestN = eTok.length; }
    }
    return best;
  }
  // an SVO endpoint resolves through an explicit ref, a hint, or its surface
  function resolveEnd(ev, refField, hintField, surfField) {
    const ref = ev[refField];
    if (ref != null) {
      const nm = refName.get(ref);
      return { entity: nm ? resolveSurface(nm) || { name: nm } : { name: String(ref) }, via: refField };
    }
    const hint = ev[hintField];
    if (hint && (hint.referent_id || hint.name || hint.key)) {
      const nm = hint.name || refName.get(hint.referent_id) || hint.key;
      const e = nm ? resolveSurface(nm) : null;
      if (e || nm) return { entity: e || { name: nm }, via: hintField };
    }
    const e = resolveSurface(ev[surfField]);
    return e ? { entity: e, via: 'surface' } : null;
  }

  return { report, pack, events, spans, entities, evBySent, chromeSents, refName, resolveSurface, resolveEnd };
}

const substantiveOps = (evs) => (evs || []).filter(e => e.op !== 'NUL');
const cite = (ev) => ev.id || ('seq:' + ev.seq);
const finding = (law, detail, evs) => ({ law, detail, events: (evs || []).map(cite) });

/* ============================== the seven checks ============================== */

/* 1 — ADMISSION: only what returns is given a name; the gate is two sightings. */
function checkAdmission(ctx) {
  const findings = [];
  let singles = 0;
  for (const e of ctx.entities) {
    const sights = [...new Set(e.sents || [])];
    const prose = sights.filter(i => !ctx.chromeSents.has(i));
    if (prose.length >= 2) continue;
    singles++;
    const ins = ctx.events.filter(ev => ev.op === 'INS' && fold(ev.target) === fold(e.name));
    const where = sights.length
      ? sights.map(i => 's' + i + (ctx.chromeSents.has(i) ? ' (chrome)' : '')).join(', ')
      : 'no sighting recorded';
    findings.push(finding('two-sightings', `"${e.name}" admitted on ${prose.length} prose sighting${prose.length === 1 ? '' : 's'} (${where})`, ins));
  }
  for (const ev of ctx.events) {
    if (ev.op !== 'INS' || ev.src !== 'first-sighting') continue;
    const e = ctx.resolveSurface(ev.target);
    if (!e) findings.push(finding('first-sighting-unretired', `INS "${ev.target}" (src first-sighting) has no surviving referent and no retirement`, [ev]));
  }
  return { bit: findings.length === 0 ? 1 : 0, findings, stats: { entities: ctx.entities.length, single_sighting_count: singles } };
}

/* 2 — BINDING: two names joined by a deed is a bond, written between the
   names as CON. SYN is reserved for synthesis (mergers). */
function checkBinding(ctx) {
  const findings = [];
  const svos = ctx.events.filter(ev => ev.s != null && ev.v != null && ev.o != null);
  const mergers = ctx.events.filter(ev => ev.op === 'SYN' && Array.isArray(ev.sites));
  let resolvedPairs = 0, conBonds = 0;
  for (const ev of svos) {
    const s = ctx.resolveEnd(ev, 'sRef', 'sHint', 's');
    const o = ctx.resolveEnd(ev, 'oRef', 'oHint', 'o');
    const resolved = s && o && fold(s.entity.name) !== fold(o.entity.name);
    if (!resolved) {
      if (ev.op === 'CON') findings.push(finding('bond-without-referents', `CON "${ev.s}" —${ev.v}→ "${ev.o}" does not carry two resolved referents — the bond was written near the names, not between them`, [ev]));
      continue;
    }
    resolvedPairs++;
    if (ev.op === 'CON') { conBonds++; continue; }
    findings.push(finding('deed-misfiled', `"${s.entity.name}" —${ev.v}→ "${o.entity.name}" resolves at both ends but is filed as ${ev.op}, not CON`, [ev]));
  }
  const ratio = resolvedPairs ? conBonds / resolvedPairs : (conBonds ? 0 : 1);
  return {
    bit: findings.length === 0 ? 1 : 0, findings,
    stats: { svo: svos.length, resolved_pairs: resolvedPairs, con: conBonds, syn_synthesis: mergers.length, con_over_resolved: Math.round(ratio * 100) / 100 },
  };
}

/* 3 — SPEECH: speech belongs only to one who has acted; never a metaphor,
   never a fallback to the nearest capitalized name. */
function checkSpeech(ctx) {
  const findings = [];
  const sigs = ctx.events.filter(ev => ev.op === 'SIG' && ('speaker' in ev || 'quote' in ev));
  const earned = new Set(ctx.pack.attributed_earned);
  const honest = new Set(ctx.pack.attributed_honest);
  const speechless = new Set(ctx.pack.speechless_types);
  const priorConfident = new Map();   // folded speaker -> first confident SIG seq
  for (const ev of sigs) {
    const att = ev.attributed || (ev.speaker && ev.speaker !== '?' ? 'named' : 'none');
    const sf = fold(ev.speaker);
    if (att === 'fallback') {
      findings.push(finding('fallback-attribution', `"${(ev.quote || '').slice(0, 60)}" handed to "${ev.speaker}" by fallback — proximity is not agency`, [ev]));
      continue;
    }
    if (honest.has(att) || !ev.speaker || ev.speaker === '?') continue;
    if (!earned.has(att)) {
      findings.push(finding('unknown-attribution', `SIG carries attributed:"${att}" — not an earned binding or an honest absence`, [ev]));
      continue;
    }
    const ent = ctx.resolveSurface(ev.speaker) || (ev.speakerHint && ev.speakerHint.referent_id ? ctx.resolveSurface(ctx.refName.get(ev.speakerHint.referent_id)) : null);
    if (ent && (ent.metaphor_only || ent.metaphorOnly)) {
      findings.push(finding('metaphor-speaking', `"${ev.speaker}" is marked metaphor-only and cannot hold the floor`, [ev]));
    }
    if (ent && speechless.has(String(ent.type || '').toLowerCase())) {
      const transmuted = ctx.events.some(d => d.op === 'DEF' && (d.seq == null || ev.seq == null || d.seq < ev.seq)
        && fold(d.target) === fold(ent.name) && d.path === 'class' && fold(d.value) === 'person');
      if (!transmuted) findings.push(finding('speechless-type', `a ${ent.type} ("${ev.speaker}") speaks dialogue with no transmuting DEF before it`, [ev]));
    }
    if (att === 'continuation' && !priorConfident.has(sf)) {
      findings.push(finding('continuation-without-prior', `"${ev.speaker}" inherits the floor with no prior confident attribution`, [ev]));
    }
    if (att === 'named' || att === 'pronoun') priorConfident.set(sf, ev.seq == null ? true : ev.seq);
  }
  return { bit: findings.length === 0 ? 1 : 0, findings, stats: { sig: sigs.length } };
}

/* 4 — COMPANY: the neighbors are the definition. DEF targets are referents;
   definitional values are frames (or closed-vocabulary type transmutations);
   when frames meet across documents, EVA fires. */
function checkCompany(ctx, allReports) {
  const findings = [];
  const frameRef = new RegExp(ctx.pack.frame_ref, 'i');
  const isFrameVal = (v) => (typeof v === 'string' && frameRef.test(v)) || (v && typeof v === 'object' && (v.frame || v.frame_ref));
  const typeLex = new Set(ctx.pack.type_lexicon.map(fold));
  const structural = new Set(ctx.pack.structural_def_targets.map(fold));
  const defs = ctx.events.filter(ev => ev.op === 'DEF');
  for (const ev of defs) {
    if (structural.has(fold(ev.target))) continue;
    const ent = ctx.resolveSurface(ev.target) || (ev.targetHint && ev.targetHint.referent_id ? ctx.resolveSurface(ctx.refName.get(ev.targetHint.referent_id)) : null);
    if (!ent) {
      findings.push(finding('def-target-not-referent', `DEF defines "${ev.target}" (${ev.path || 'class'}) — not an admitted referent`, [ev]));
      continue;
    }
    if ((ev.path === 'class' || ev.path === 'frame') && !isFrameVal(ev.value) && !typeLex.has(fold(ev.value))) {
      findings.push(finding('def-value-fragment', `"${ent.name}" defined as "${String(ev.value).slice(0, 50)}" — a copied fragment, not a frame`, [ev]));
    }
  }
  const framed = new Set(defs.filter(ev => ev.path === 'frame' && isFrameVal(ev.value)).map(ev => fold(ev.target)));
  for (const e of ctx.entities) {
    if (!framed.has(fold(e.name)) && !(e.key && framed.has(fold(e.key)))) {
      findings.push(finding('entity-without-frame', `"${e.name}" carries no frame DEF — its company is unrecorded, so it cannot be tested`, []));
    }
  }
  let evaTotal = 0;
  for (const r of allReports) evaTotal += ((r.counts && r.counts.ops && r.counts.ops.EVA) || 0);
  if (allReports.length >= 2 && evaTotal === 0) {
    findings.push(finding('frames-never-met', `${allReports.length} documents and EVA fired 0 times — frames exist to be tested when they meet`, []));
  }
  return { bit: findings.length === 0 ? 1 : 0, findings, stats: { def: defs.length, eva: evaTotal, documents: allReports.length } };
}

/* 5 — DARK: absence that is written down is an answer; a span that deposited
   nothing must say why (chrome, no-event, unparseable). */
function checkDark(ctx) {
  const findings = [];
  const perSentReason = new Map();
  if (Array.isArray(ctx.report.sentences)) for (const s of ctx.report.sentences) if (s && s.reason) perSentReason.set(s.i, s.reason);
  if (Array.isArray(ctx.report.dark)) for (const d of ctx.report.dark) if (d && d.reason) perSentReason.set(d.i, d.reason);
  let dark = 0, unmarked = 0;
  ctx.spans.forEach((text, i) => {
    const evs = ctx.evBySent.get(i) || [];
    if (substantiveOps(evs).length) return;
    dark++;
    const reason = perSentReason.get(i) || (evs.find(e => e.op === 'NUL' && e.reason) || {}).reason;
    if (!reason) {
      unmarked++;
      findings.push(finding('dark-unmarked', `s${i} "${String(text).slice(0, 50)}" deposited nothing and carries no reason`, evs));
    }
  });
  return { bit: findings.length === 0 ? 1 : 0, findings, stats: { dark, unmarked } };
}

/* 6 — WEIGHT: write only what was observed and what was decided; weights live
   inside observed.frame blocks, never as event properties. (Replay equality
   is an engine-level check and is not scored from a dump.) */
function checkWeight(ctx) {
  const findings = [];
  const forbidden = new Set(ctx.pack.weight_fields);
  function scan(node, ev, trail) {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'observed') continue;                    // the one legitimate home
      if (forbidden.has(k) && typeof v === 'number') {
        findings.push(finding('weight-on-event', `${cite(ev)} carries ${trail}${k}=${v} outside observed.frame — a weight stored as a property`, [ev]));
      }
      if (v && typeof v === 'object') scan(v, ev, trail + k + '.');
    }
  }
  for (const ev of ctx.events) scan(ev, ev, '');
  return { bit: findings.length === 0 ? 1 : 0, findings, stats: { events: ctx.events.length } };
}

/* 7 — CUSTOM: customs are admitted the way things are — seen twice, through
   the ledger — and a register's surface criteria must exist as customs before
   its text is read as prose. (The source-level grep for compiled-in pattern
   literals is not scored from a dump.) */
function checkCustom(ctx) {
  const findings = [];
  const admitting = new Set(ctx.pack.rule_admitting_actions);
  let inductions = 0;
  for (const ev of ctx.events) {
    if (ev.op !== 'REC' || !admitting.has(ev.action)) continue;
    inductions++;
    const lid = ev.ledger_lid || ev.lid || (ev.ledger && ev.ledger.lid);
    const sightings = ev.basis && ev.basis.slot_sightings;
    if (!lid) findings.push(finding('rule-without-ledger', `REC admits "${String(ev.value != null ? ev.value : ev.target)}" with no ledger lid — a custom that cannot name what admitted it`, [ev]));
    if (!(sightings >= 2)) findings.push(finding('rule-single-sighting', `REC admits "${String(ev.value != null ? ev.value : ev.target)}" on ${sightings == null ? 'no' : sightings} slot sighting${sightings === 1 ? '' : 's'} — the gate is two`, [ev]));
  }
  const chromeCustom = ctx.events.some(ev =>
    (ev.op === 'REC' || (ev.op === 'INS' && ev.kind === 'convention'))
    && fold(JSON.stringify([ev.target, ev.id, ev.value, ev.rule && ev.rule.kind])).includes(fold(ctx.pack.chrome_reason)));
  if (!chromeCustom) {
    for (const i of [...ctx.chromeSents].sort((a, b) => a - b)) {
      const evs = substantiveOps(ctx.evBySent.get(i));
      if (!evs.length) continue;
      findings.push(finding('register-without-customs', `chrome span s${i} "${String(ctx.spans[i]).slice(0, 50)}" deposited ${evs.length} graph event${evs.length === 1 ? '' : 's'} with no chrome custom admitted — furniture read as prose`, evs));
    }
  }
  return { bit: findings.length === 0 ? 1 : 0, findings, stats: { rule_inductions: inductions, chrome_spans: ctx.chromeSents.size } };
}

/* ============================== scoring ============================== */

function checkDump(report, opts = {}) {
  const pack = Object.assign({}, DEFAULT_PACK, opts.pack || {});
  const allReports = opts.reports || [report];
  const ctx = buildContext(report, pack);
  const bits = {
    ADMISSION: checkAdmission(ctx),
    BINDING: checkBinding(ctx),
    SPEECH: checkSpeech(ctx),
    COMPANY: checkCompany(ctx, allReports),
    DARK: checkDark(ctx),
    WEIGHT: checkWeight(ctx),
    CUSTOM: checkCustom(ctx),
  };
  const vector = INVARIANTS.map(k => bits[k].bit);
  return {
    doc: (report.doc && (report.doc.name || report.doc.id)) || 'dump',
    schema: report.schema || null,
    vector,
    vectorString: vector.join(' '),
    conformant: vector.every(b => b === 1),
    bits,
  };
}

/* ---------- session-side advisory checks (cleon-audit/1 JSONL) ----------
   Never move a bit: the vector scores the dump. These surface the spec's
   session witnesses — a below-floor hit served as the answer, a clean badge
   that names no frame, a term unseekable only because of an accent, one
   proposal claiming every friction span. */
function checkSession(turns, reports, opts = {}) {
  const pack = Object.assign({}, DEFAULT_PACK, opts.pack || {});
  const floor = opts.floor != null ? opts.floor : pack.floor;
  const findings = [];
  const lexicon = new Map();
  for (const r of reports || []) for (const t of (r.lexicon || [])) lexicon.set(fold(t.token), t);
  (turns || []).forEach((turn, ti) => {
    const id = turn.id || ('turn-' + (ti + 1));
    const steps = Array.isArray(turn.steps) ? turn.steps : [];
    const final = turn.final || {};
    const text = String(final.text || '');
    const attestsAbsence = /⊥/.test(text) || /\b(not (?:present|mentioned)|document does not|no mention|nothing on the page)\b/i.test(text) || final.absence === true;
    let bestScore = null, sawRetrieve = false;
    for (const st of steps) {
      if (st.t !== 'retrieve') continue;
      sawRetrieve = true;
      for (const h of (st.hits || [])) if (typeof h.score === 'number') bestScore = bestScore == null ? h.score : Math.max(bestScore, h.score);
      for (const term of (st.unseekable || [])) {
        const hit = lexicon.get(fold(term));
        if (hit) findings.push({ invariant: 'DARK', law: 'fold-before-absence', turn: id, detail: `"${term}" declared unseekable while "${hit.token}" sits at s${(hit.sents || [])[0]}` });
      }
    }
    if (sawRetrieve && bestScore != null && bestScore < floor && text && !attestsAbsence) {
      findings.push({ invariant: 'DARK', law: 'below-floor-served', turn: id, detail: `best retrieval ${bestScore} < floor ${floor} yet the answer is not an attestation of absence` });
    }
    const grounded = final.audit && final.audit.grounded === true;
    const framed = !!(final.frame || (final.audit && final.audit.frame) || final.observed);
    if (grounded && !framed) {
      findings.push({ invariant: 'WEIGHT', law: 'badge-without-frame', turn: id, detail: `a grounded/clean badge that names no frame — one frame's arithmetic presented as a property of the answer` });
    }
    for (const st of steps) {
      const proposals = st.proposals || (st.t === 'proposals' ? st.items : null);
      for (const p of (proposals || [])) {
        const spans = (p.sids || p.spans || []).length;
        if (spans >= pack.degenerate_proposal_spans) {
          findings.push({ invariant: 'CUSTOM', law: 'degenerate-proposal', turn: id, detail: `one proposal cites ${spans} friction spans — induction through the wrong organ` });
        }
      }
    }
  });
  return findings;
}

/* ============================== reporting ============================== */

function formatText(results, sessionFindings, opts = {}) {
  const lines = [];
  for (const res of results) {
    lines.push(`${res.doc}  (${res.schema || 'no schema'})`);
    if (!opts.quiet) {
      for (const k of INVARIANTS) {
        const b = res.bits[k];
        const stats = Object.entries(b.stats || {}).map(([s, v]) => `${s}=${v}`).join(' ');
        lines.push(`  ${b.bit ? '1' : '0'}  ${k.padEnd(9)} ${stats}`);
        for (const f of b.findings.slice(0, opts.maxWitnesses == null ? 8 : opts.maxWitnesses)) {
          lines.push(`       ✗ [${f.law}] ${f.detail}${f.events.length ? '  (' + f.events.join(', ') + ')' : ''}`);
        }
        if (b.findings.length > 8 && (opts.maxWitnesses == null || opts.maxWitnesses === 8)) lines.push(`       … ${b.findings.length - 8} more`);
      }
    }
    lines.push(`  vector: ${res.vectorString}   ${res.conformant ? 'CONFORMS' : 'does not conform'}`);
    lines.push('');
  }
  if (sessionFindings && sessionFindings.length) {
    lines.push('session (advisory — never moves a bit):');
    for (const f of sessionFindings) lines.push(`  ⚠ ${f.invariant} [${f.law}] ${f.turn}: ${f.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}

/* ============================== CLI ============================== */

function loadJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function loadJSONL(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };

  const sessionFile = opt('--session');
  const packFile = opt('--pack');
  const floorArg = opt('--floor');
  const jsonOut = opt('--json');
  const quiet = flag('--quiet');
  const parseFile = opt('--parse');

  const pack = packFile ? Object.assign({}, DEFAULT_PACK, loadJSON(packFile)) : DEFAULT_PACK;
  const floor = floorArg != null ? parseFloat(floorArg) : undefined;

  const reports = [];
  try {
    if (parseFile) {
      const { loadEngine } = require(path.join(__dirname, '..', 'tests', 'harness'));
      const E = loadEngine().EOEngine;
      const doc = await E.parseDocument(path.basename(parseFile), fs.readFileSync(parseFile, 'utf8'), 'conformance-doc');
      const r = E.ingestionReport(doc);
      if (!r) throw new Error('the engine produced no ingestion report (not prose?)');
      reports.push(r);
    }
    for (const f of args) {
      if (f.startsWith('--')) throw new Error('unknown option ' + f);
      reports.push(loadJSON(f));
    }
  } catch (e) {
    console.error('conformance: ' + e.message);
    process.exit(2);
  }
  if (!reports.length) {
    console.error('usage: node tools/conformance.js <dump.json …> [--session audit.jsonl] [--pack pack.json] [--floor n] [--json out.json] [--quiet] [--parse text.txt]');
    process.exit(2);
  }
  for (const r of reports) {
    if (r.schema && r.schema !== 'cleon-ingestion/1') console.error(`conformance: warning — ${r.schema} is not cleon-ingestion/1; reading it anyway`);
  }

  const results = reports.map(r => checkDump(r, { pack, reports }));
  const sessionFindings = sessionFile ? checkSession(loadJSONL(sessionFile), reports, { pack, floor }) : [];

  console.log(formatText(results, sessionFindings, { quiet }));
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      schema: 'cleon-conformance/1', at: new Date().toISOString(),
      pack: packFile || 'default', invariants: INVARIANTS,
      dumps: results, session: sessionFindings,
      conformant: results.every(r => r.conformant),
    }, null, 1));
    console.log('wrote ' + jsonOut);
  }
  process.exit(results.every(r => r.conformant) ? 0 : 1);
}

module.exports = { INVARIANTS, DEFAULT_PACK, fold, isChromeSpan, checkDump, checkSession, formatText };

if (require.main === module) main(process.argv).catch(e => { console.error(e); process.exit(2); });
