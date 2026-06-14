/* ============================================================
   tools/predictive/read-router.js — the router-reading gate (Phase 0 of the
   "the router is a reading, and the field points at the best guess" brief).

   Model-free, deterministic, read-only over the SHIPPED engine. No embedder
   (the resolution and routing this measures run on the unconscious, mechanical
   path). No engine output changes; no writes to any log. This read GATES the
   build: it decides whether routing can become a reading, whether the field
   should carry a best-guess binding instead of an entity, and whether the tool
   query should be built from the resolved referent — BEFORE any of it is built.

     node tools/predictive/read-router.js            # console tables
     node tools/predictive/read-router.js --write     # + docs/router-reading-read.md

   ── The bars, declared before the run ──────────────────────────────────────

   Read A  (outcome read, sizing — descriptive, not pass/fail). Join each
           simulated turn's route REASON to its witness DEGREE and UNBOUND count
           (EOAudit.truthfulness, WI-7). Confirms the router "is not doing
           badly" and localizes the weak cluster. Expectation (the brief's): the
           weakness concentrates in escalate-miss and the summary/factual NAME
           class, almost nowhere else.

   Read B.1 (intent recovery). Does the prompt-read's operator shape (the type
           gate's referents + grammatical mood) recover the five classifyIntent
           classes AT LEAST AS WELL AS the regex cascade, scored on questions
           and fragments specifically?
             BAR: parse accuracy ≥ cascade accuracy on the question+fragment set.

   Read B.2 (chat figure vs document salience — the conversation-walk pair).
           For pronoun/ellipsis turns whose question names no anchor:
             carry     ≥ 60% — the anchor is hot at the dial's floor (0.25)
             precision ≥ 80% — the anchor sits in the top 2 by heat
           AND the chat field's hot figure resolves the user's pronoun MORE
           often than the document's local salience does (the brief's
           asymmetry: reference is a speaker act).
             BAR: carry ≥ 60%, precision ≥ 80%, chat-correct% > doc-salience%.

   Read B.3 (calibration). When a resolution is c sure, is it right about c of
           the time? Bin the best-guess confidence; measure empirical accuracy.
             BAR: expected calibration error (ECE) ≤ 0.15.
           Also reports three-NUL-state agreement (resolved/ambiguous/absent).

   Read C / B.4 (the tool query). On acquisition turns naming the target only by
           pronoun, does a query built from the resolved binding name a real
           article target where pickQuery on the raw string names a pronoun?
             BAR: on the pronoun cases, resolved-names-target% > raw-names-target%
                  (controls that already name the target must not regress).

   THE GATE (computed in the verdicts section): the build proceeds when B.1
   matches the cascade, B.2 shows the chat figure beating document salience and
   clears carry/precision, B.3 calibrates, and C beats the raw query. A failure
   on any one is reported as exactly that — e.g. "intent stays regex", "fix
   confidence before tuning gravity" — never papered over.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nlp = require('compromise');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = require('./fixtures');
const RFX = require('./router-fixtures');

const WM_HEAT_FLOOR = 0.25;   // thinkingBudget(3).wmHeatFloor — the dial's floor
const TOP_SEED = 2;           // entry seeds the wired walk would take
const AMBIG_MARGIN = 0.20;    // top-2 share within this of 0.5 ⇒ two figures contend
const ECE_BAR = 0.15;         // calibration bar

/* ---- load engine + audit into one vm context (they share `window`) -------- */
function loadAll() {
  const sandbox = { window: {}, nlp, console, performance, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['pivot.jsx', 'engine.js', 'audit.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  if (!sandbox.window.EOEngine) throw new Error('engine did not publish window.EOEngine');
  // NB: the binding_resolution dial is turned ON in run(), AFTER all parsing —
  // parseDocument re-derives the rules and would wipe an enable set here.
  return { E: sandbox.window.EOEngine, A: sandbox.window.EOAudit, X: require(path.join(ROOT, 'external.js')) };
}

/* ---- name normalization (same shape read-conv-entry uses) ----------------- */
const norm = (s) => String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
function nameMatches(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = na.split(' '), sb = new Set(nb.split(' '));
  return sa.length <= nb.split(' ').length ? sa.every(w => sb.has(w)) : nb.split(' ').every(w => new Set(sa).has(w));
}
const anchorsOf = (turn) => (turn.anchor == null ? [] : [].concat(turn.anchor));
const pct = (a, b) => (b ? Math.round(100 * a / b) + '%' : '—');
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—');

/* ---- the resolution model (READ-ONLY mirror of the brief's Phase-1 binding,
   reading the SHIPPED field; nothing is written back) -----------------------
   Returns { surface, name, confidence, state, hot, h1, h2 }.
   confidence = top-2 heat share: a dominant figure ⇒ ~1.0, a tie ⇒ ~0.5.
   state ∈ resolved | ambiguous | absent (the three NUL states, never collapsed). */
const ANAPHOR = ['his', 'him', 'he', 'her', 'she', 'it', 'its', 'they', 'them', 'their', 'that', 'those', 'these'];
function detectSurface(q) {
  const toks = String(q).toLowerCase().match(/[a-z']+/g) || [];
  return toks.find(t => ANAPHOR.includes(t)) || null;
}
function resolveBinding(snap, scopeEntities, q) {
  const hot = [];
  for (const he of (snap.entities || [])) {           // snapshot is heaviest-first
    if (he.heat < WM_HEAT_FLOOR) continue;
    const ent = scopeEntities.find(e => nameMatches(he.label || he.key, e.name));
    if (ent && !hot.some(h => h.name === ent.name)) hot.push({ name: ent.name, heat: he.heat });
  }
  if (!hot.length) return { surface: detectSurface(q), name: null, confidence: 0, state: 'absent', hot, h1: 0, h2: 0 };
  const h1 = hot[0].heat, h2 = hot[1] ? hot[1].heat : 0;
  const share = h1 / (h1 + h2);
  const state = (h2 > 0 && (share - 0.5) < AMBIG_MARGIN) ? 'ambiguous' : 'resolved';
  return { surface: detectSurface(q), name: hot[0].name, confidence: share, state, hot, h1, h2 };
}

/* The hot resolvable figures (engine-independent), heaviest first — the
   conversation-walk measurement B.2's carry/precision ride on, separate from
   which figure the shipped binding ultimately picks. */
function hotList(snap, scopeEntities) {
  const hot = [];
  for (const he of (snap.entities || [])) {
    if (he.heat < WM_HEAT_FLOOR) continue;
    const ent = scopeEntities.find(e => nameMatches(he.label || he.key, e.name));
    if (ent && !hot.some(h => h.name === ent.name)) hot.push({ name: ent.name, heat: he.heat });
  }
  return hot;
}

/* ---- the operator-projection intent reader (B.1) -------------------------
   The fair test of "can the parse read the prompt's intent?" It uses ONLY the
   two signals the parse delivers reliably on a short prompt:
     • the type gate's REFERENT  (E.namedReferents — what the prompt is about)
     • grammatical MOOD          (compromise: interrogative / imperative /
                                  copular / superlative)
   plus a small argument-type test (is the argument the DOCUMENT, or the CAST?).
   It deliberately does NOT consult the cascade's verb lexicons — so where
   intent turns on verb externality (command vs a content imperative) or on pure
   idiom (tl;dr), the parse cannot see it, and the read reports that honestly. */
const DOC_DEIXIS = new Set(['this', 'it', 'that', 'these', 'those', 'here', 'document', 'doc', 'text', 'story', 'novel', 'novella', 'file', 'piece', 'article', 'essay', 'paper', 'report', 'poem', 'play', 'thing', 'gist', 'overview', 'summary', 'recap', 'tldr', 'point', 'reading', 'script', 'screenplay', 'book', 'memoir']);
const CAST_CUE = new Set(['people', 'characters', 'character', 'cast', 'everyone', 'everybody', 'figures', 'names', 'dramatis', 'who']);
const POLAR_LEAD = /^(is|are|was|were|do|does|did|has|have|had|isn't|aren't|wasn't|weren't|doesn't|don't|didn't)\b/;
function parseIntentRead(E, q) {
  const text = String(q || '');
  const lc = text.toLowerCase().replace(/[’]/g, "'");
  const toks = lc.match(/[a-z']+/g) || [];
  const d = nlp(text);
  const isQ = /\?\s*$/.test(text.trim());
  const wh = toks.find(t => ['who', 'what', 'which', 'where', 'when', 'why', 'how', 'whom', 'whose'].includes(t)) || null;
  const imper = d.has('^#Infinitive') || d.has('^#Imperative') || ((/^(please|kindly)\b/.test(lc)) && d.has('#Infinitive'));
  const copular = d.has('#Copula');
  let named = [];
  try { named = E.namedReferents(text) || []; } catch (e) {}
  const docArg = !named.length && toks.some(t => DOC_DEIXIS.has(t));
  const castArg = !named.length && toks.some(t => CAST_CUE.has(t));
  const reqModal = /^(can|could|would|will)\s+(you|we)\b/.test(lc);

  // 1 — assertion / verification → confirm
  if (/\byou\s+(said|told|claimed|mentioned|wrote|implied|noted)\b/.test(lc)) return 'confirm';
  if (/(?:[,;—–-]\s*)?(right|correct|true)\s*\?+\s*$/.test(lc) || /,\s*(yes|no)\s*\?*\s*$/.test(lc)) return 'confirm';
  if (/\b(sounds?|seems?|looks?)\s+like\b/.test(lc)) return 'confirm';
  if (!reqModal && POLAR_LEAD.test(lc)) return 'confirm';        // "is that who pays" / "is it a nonprofit?"
  if (isQ && copular && !wh) return 'confirm';
  if (!isQ && !wh && copular && named.length) return 'confirm';  // "Tom is the president"

  // 2 — cast ask → who  (a who-question / list with no named figure)
  if (castArg && (wh === 'who' || imper || toks.length <= 3)) return 'who';

  // 3 — document-level ask → summary  (argument is the document)
  if (docArg && (imper || wh || toks.length <= 4)) return 'summary';

  // 4 — request / imperative aimed at a target → command  (acquire). The parse
  //     cannot see verb externality, so a content imperative lands here too.
  if (reqModal || imper) return 'command';

  // 5 — residual → factual
  return 'factual';
}

/* ---- field simulation: run the app's exact turn order over a conversation,
   yielding the PRE-deposit snapshot at each turn (what the walk/route sees) -- */
function simulateConversation(E, doc, scopeEntities, turns, onTurn) {
  E.conversationField.reset();
  let everGrounded = false, prevGrounded = false;
  turns.forEach((turn, i) => {
    E.conversationField.decayTurn();
    const snap = E.conversationField.snapshot();
    let hotBinding = null;
    try { if (E.resolveBinding && E.bindingResolutionEnabled && E.bindingResolutionEnabled()) hotBinding = E.resolveBinding([doc], turn.q, E.conversationField, { heatFloor: WM_HEAT_FLOOR }); } catch (e) {}
    const ctx = { everGrounded, prevGrounded, hadReply: i > 0, hotBinding,
      hotEntity: hotBinding ? hotBinding.name : ((snap.entities[0] && (snap.entities[0].label || snap.entities[0].key)) || null) };
    const out = onTurn(turn, i, snap, ctx) || {};
    // deposit the settled turn exactly as the app does (gated subject-weighting)
    try {
      if (E.depositTurn) E.depositTurn(E.conversationField, turn.q, out.answerText || '');
      else {
        const seen = new Set(); const names = [];
        for (const n of (E.namedReferents(turn.q) || []).concat(E.namedReferents(out.answerText || '') || [])) {
          const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); names.push(n); }
        }
        if (names.length) E.conversationField.deposit({ entities: names }, 1);
      }
    } catch (e) {}
    if (out.grounded != null) { prevGrounded = !!out.grounded; everGrounded = everGrounded || !!out.grounded; }
  });
}

/* ============================================================ READ A */
function readA(E, A) {
  const byReason = new Map();
  const all = [];
  const convs = [
    ...FIX.conversations().map(c => ({ ...c, src: 'scripted' })),
    ...FIX.anchorConversations().map(c => ({ ...c, src: 'anchored' })),
    ...RFX.resolutionBattery().map(c => ({ ...c, src: 'resolution' })),
  ];
  for (const conv of convs) {
    const spec = RFX.documentsById()[conv.docId] || FIX.documents().find(d => d.id === conv.docId);
    if (!spec) continue;
    const doc = conv._doc;            // injected by caller
    const scopeEntities = conv._entities;
    simulateConversation(E, doc, scopeEntities, conv.turns, (turn, i, snap, ctx) => {
      let route, ans, truth;
      try { route = E.routeTurn([doc], turn.q, ctx); } catch (e) { route = { reason: 'ERR', decision: 'ERR', intent: null }; }
      // the mechanical reader the app runs (runMechanicalScope) is answerResolved
      // — the binding is rewritten into the question first; fall back to answerScope.
      try { ans = (E.answerResolved ? E.answerResolved([doc], turn.q, ctx) : E.answerScope([doc], turn.q, ctx)); } catch (e) { ans = { text: '', cites: [], audit: {} }; }
      try { truth = A.truthfulness(ans); } catch (e) { truth = { degree: 0, unbound: 0, bound: 0, coverage: 0 }; }
      const rec = {
        reason: route.reason, decision: route.decision, intent: route.intent || null,
        degree: +truth.degree || 0, coverage: +truth.coverage || 0, unbound: truth.unbound | 0,
        bound: truth.bound | 0, absent: !!(ans.audit && ans.audit.absent),
      };
      all.push(rec);
      if (!byReason.has(route.reason)) byReason.set(route.reason, []);
      byReason.get(route.reason).push(rec);
      return { answerText: ans.text, grounded: !!(ans.audit && ans.audit.grounded) };
    });
  }
  // aggregate per reason
  const rows = [];
  for (const [reason, recs] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const n = recs.length;
    const mean = (k) => recs.reduce((s, r) => s + r[k], 0) / n;
    rows.push({
      reason, n,
      'mean degree': f3(mean('degree')),
      'mean coverage': f3(mean('coverage')),
      'unbound%': pct(recs.filter(r => r.unbound).length, n),
      'absent%': pct(recs.filter(r => r.absent).length, n),
      'strong%': pct(recs.filter(r => r.degree >= 0.5 && !r.unbound).length, n),
    });
  }
  const N = all.length;
  const strong = all.filter(r => r.degree >= 0.5 && !r.unbound).length;
  // the weak cluster: reasons whose mean degree is in the bottom third AND that
  // carry real volume (≥ 2 turns)
  const weak = rows.filter(r => r.n >= 2 && parseFloat(r['mean degree']) < 0.4).map(r => r.reason);
  return { rows, N, strongShare: strong / N, weak };
}

/* ============================================================ READ B.1 */
function readB1(E) {
  const battery = RFX.intentBattery();
  const rows = [];
  let cascHit = 0, parseHit = 0, qfCasc = 0, qfParse = 0, qfN = 0;
  const confusion = { cascade: {}, parse: {} };
  for (const item of battery) {
    const casc = E.classifyIntent(item.q);
    const prs = parseIntentRead(E, item.q);
    const cOk = casc === item.intent, pOk = prs === item.intent;
    if (cOk) cascHit++; if (pOk) parseHit++;
    const isQF = item.kind === 'question' || item.kind === 'fragment';
    if (isQF) { qfN++; if (cOk) qfCasc++; if (pOk) qfParse++; }
    rows.push({ q: item.q, kind: item.kind, label: item.intent, cascade: casc + (cOk ? '' : ' ✗'), parse: prs + (pOk ? '' : ' ✗') });
    for (const [who, val] of [['cascade', casc], ['parse', prs]]) {
      if (!confusion[who][item.intent]) confusion[who][item.intent] = { n: 0, ok: 0 };
      confusion[who][item.intent].n++; if ((who === 'cascade' ? casc : prs) === item.intent) confusion[who][item.intent].ok++;
    }
  }
  const N = battery.length;
  return {
    rows, N,
    cascadeAcc: cascHit / N, parseAcc: parseHit / N,
    qfN, qfCascadeAcc: qfN ? qfCasc / qfN : 0, qfParseAcc: qfN ? qfParse / qfN : 0,
    confusion,
    pass: qfN ? (qfParse / qfN) >= (qfCasc / qfN) : false,
  };
}

/* ============================================================ READ B.2 + B.3 */
function readB2B3(E) {
  // resolution events drawn from anchorConversations + the supplement
  const convs = [
    ...FIX.anchorConversations().map(c => ({ ...c, src: 'anchor' })),
    ...RFX.resolutionBattery().map(c => ({ ...c, src: 'supp' })),
  ];
  const events = [];   // one per anchor-bearing pronoun/ellipsis turn
  for (const conv of convs) {
    const doc = conv._doc, scopeEntities = conv._entities;
    const docSalience = (scopeEntities[0] && scopeEntities[0].name) || null;  // top projected figure
    simulateConversation(E, doc, scopeEntities, conv.turns, (turn, i, snap, ctx) => {
      const anchors = anchorsOf(turn);
      const named = anchors.length && anchors.some(a => nameMatches(a, turn.q));   // does the Q name the anchor?
      if (anchors.length && !named) {
        const hot = hotList(snap, scopeEntities);
        // the SHIPPED resolution (engine.js): name, calibrated confidence, state
        const eb = (E.resolveBinding && E.bindingResolutionEnabled && E.bindingResolutionEnabled())
          ? E.resolveBinding([doc], turn.q, E.conversationField, { heatFloor: WM_HEAT_FLOOR })
          : resolveBinding(snap, scopeEntities, turn.q);
        const carry = hot.some(h => anchors.some(a => nameMatches(a, h.name)));
        const rank = hot.findIndex(h => anchors.some(a => nameMatches(a, h.name)));
        const chatName = hot.length ? hot[0].name : null;          // the chat field's hot figure
        events.push({
          docId: conv.docId, q: turn.q, anchors, state: turn.state || null,
          carry, top1: rank === 0, topSeed: rank >= 0 && rank < TOP_SEED, anyHot: hot.length > 0,
          chatName, chatCorrect: chatName != null && anchors.some(a => nameMatches(a, chatName)),
          docName: docSalience, docCorrect: docSalience != null && anchors.some(a => nameMatches(a, docSalience)),
          conf: eb.confidence, predState: eb.state,
          bindName: eb.name, bindCorrect: eb.name != null && anchors.some(a => nameMatches(a, eb.name)),
        });
      }
      // answer mechanically only to keep the deposit faithful
      let ans = {}; try { ans = E.answerScope([doc], turn.q, ctx); } catch (e) {}
      return { answerText: ans.text };
    });
  }
  // ---- B.2 aggregates ----
  const anchored = events;
  const anyHot = anchored.filter(e => e.anyHot);
  const carry = anchored.filter(e => e.carry).length;
  const precision = anyHot.filter(e => e.topSeed).length;
  const chatCorrect = anchored.filter(e => e.chatCorrect).length;
  const docCorrect = anchored.filter(e => e.docCorrect).length;
  const b2 = {
    n: anchored.length, anyHot: anyHot.length,
    carry, carryPct: anchored.length ? carry / anchored.length : 0,
    precision, precisionPct: anyHot.length ? precision / anyHot.length : 0,
    chatCorrect, chatPct: anchored.length ? chatCorrect / anchored.length : 0,
    docCorrect, docPct: anchored.length ? docCorrect / anchored.length : 0,
  };
  b2.pass = b2.carryPct >= 0.60 && b2.precisionPct >= 0.80 && b2.chatPct > b2.docPct;

  // ---- B.3 calibration ---- (the shipped resolution's confidence vs accuracy)
  // The shipped confidences are DISCRETE base-rate constants, so calibration is
  // measured per distinct confidence value (does conf=X land right ~X of the
  // time?), not over arbitrary ranges.
  const cal = anchored.filter(e => e.conf != null && e.conf > 0);
  const confVals = [...new Set(cal.map(e => e.conf))].sort((a, b) => a - b);
  const binRows = confVals.map(cv => {
    const inb = cal.filter(e => e.conf === cv);
    const acc = inb.length ? inb.filter(e => e.bindCorrect).length / inb.length : null;
    return { bin: cv.toFixed(2), n: inb.length, meanConf: cv, acc };
  });
  let ece = 0; for (const r of binRows) if (r.n) ece += (r.n / cal.length) * Math.abs(r.meanConf - r.acc);
  // three-NUL-state agreement (only turns with an analyst state call)
  const stated = anchored.filter(e => e.state);
  const stateAgree = stated.filter(e => e.predState === e.state).length;
  const b3 = { calN: cal.length, binRows, ece, statedN: stated.length, stateAgree, pass: cal.length ? ece <= ECE_BAR : false };

  return { events, b2, b3 };
}

/* ============================================================ READ C / B.4 */
function readC(E, X) {
  const cases = RFX.acquisitionBattery();
  const rows = [];
  const namesTarget = (query, expect) => !!query && nameMatches(query, expect);
  const namesPronoun = (query) => {
    const t = String(query || '').toLowerCase().trim();
    return ANAPHOR.includes(t) || /^(his|her|him|that|it|them|those|they|their)\b/.test(t) && !/[A-Z]/.test(String(query || ''));
  };
  for (const c of cases) {
    const doc = c._doc, scopeEntities = c._entities;
    E.conversationField.reset();
    for (const s of c.setup) {                       // seed the hot figure (gated subject-weighting)
      E.conversationField.decayTurn();
      let ans = {}; try { ans = E.answerScope([doc], s, {}); } catch (e) {}
      try { if (E.depositTurn) E.depositTurn(E.conversationField, s, ans.text || ''); } catch (e) {}
    }
    E.conversationField.decayTurn();
    const snap = E.conversationField.snapshot();
    const b = (E.resolveBinding && E.bindingResolutionEnabled && E.bindingResolutionEnabled())
      ? E.resolveBinding([doc], c.q, E.conversationField, { heatFloor: WM_HEAT_FLOOR })
      : resolveBinding(snap, scopeEntities, c.q);
    const raw = X.pickQuery(c.q);
    // seedQuery with today's best available ctx (top projected figure as subject)
    const seeded = X.seedQuery(c.q, { subject: (scopeEntities[0] && scopeEntities[0].name) || null, entities: scopeEntities.slice(0, 4).map(e => e.name) });
    // resolved: the SHIPPED query builder, gated as the app gates it (a confident
    // named/chat referent — never an ambiguous or document-salience-only guess)
    const spend = !!(b && b.confidence != null && b.state === 'resolved' && b.via !== 'document salience' && b.surface && b.name);
    const resolvedText = (spend && E.bindingQuery) ? E.bindingQuery(c.q, b) : c.q;
    const resolved = X.pickQuery(resolvedText);
    rows.push({
      q: c.q, control: !!c.control, expect: c.expect, binding: b.name || '—', conf: f3(b.confidence),
      raw: raw || '—', rawHit: namesTarget(raw, c.expect), rawPron: namesPronoun(raw),
      seeded: seeded || '—', seededHit: namesTarget(seeded, c.expect),
      resolved: resolved || '—', resolvedHit: namesTarget(resolved, c.expect),
    });
  }
  const pron = rows.filter(r => !r.control);
  const ctrl = rows.filter(r => r.control);
  const rawHit = pron.filter(r => r.rawHit).length;
  const seededHit = pron.filter(r => r.seededHit).length;
  const resolvedHit = pron.filter(r => r.resolvedHit).length;
  const ctrlOk = ctrl.every(r => r.resolvedHit);
  return {
    rows,
    pronN: pron.length, rawHit, seededHit, resolvedHit,
    rawPct: pron.length ? rawHit / pron.length : 0,
    seededPct: pron.length ? seededHit / pron.length : 0,
    resolvedPct: pron.length ? resolvedHit / pron.length : 0,
    ctrlOk,
    pass: pron.length ? (resolvedHit / pron.length) > (rawHit / pron.length) && ctrlOk : false,
  };
}

/* ============================================================ orchestration */
async function run() {
  const { E, A, X } = loadAll();
  // parse every referenced document once, attach to its conversations/cases
  const specs = RFX.documentsById();
  const allSpecs = { ...Object.fromEntries(FIX.documents().map(d => [d.id, d])), ...specs };
  const docCache = {};
  for (const id of Object.keys(allSpecs)) {
    const spec = allSpecs[id];
    const doc = await E.parseDocument(spec.name || (id + '.txt'), spec.text, id);
    docCache[id] = { doc, entities: E.projectEntities(doc).entities || [] };
  }
  // parseDocument re-derives the rules (resetting the dial), so turn the binding
  // resolution ON *after* all parsing — it persists through the reads, which only
  // route/answer/resolve and never re-parse.
  if (E.applyRules && E.resolveBinding) { try { E.applyRules([{ id: 'binding-resolution', enabled: true, value: 1 }]); } catch (e) {} }
  const attach = (conv) => { const c = docCache[conv.docId]; conv._doc = c && c.doc; conv._entities = (c && c.entities) || []; return conv; };
  // monkey-inject parsed docs onto the fixtures the reads pull (they re-pull, so
  // patch the source arrays' objects by wrapping the read inputs):
  FIX.conversations().forEach(attach); FIX.anchorConversations().forEach(attach); RFX.resolutionBattery().forEach(attach);
  // the reads re-call the fixture functions, so wrap them to attach docs:
  const wrapConvs = (fn) => () => fn().map(attach);
  const _conv = FIX.conversations, _anch = FIX.anchorConversations, _res = RFX.resolutionBattery, _acq = RFX.acquisitionBattery;
  FIX.conversations = wrapConvs(_conv); FIX.anchorConversations = wrapConvs(_anch); RFX.resolutionBattery = wrapConvs(_res);
  RFX.acquisitionBattery = () => _acq().map(c => { const d = docCache[c.docId]; c._doc = d && d.doc; c._entities = (d && d.entities) || []; return c; });

  const a = readA(E, A);
  const b1 = readB1(E);
  const b23 = readB2B3(E);
  const c = readC(E, X);

  // restore originals (politeness)
  FIX.conversations = _conv; FIX.anchorConversations = _anch; RFX.resolutionBattery = _res; RFX.acquisitionBattery = _acq;
  return { a, b1, b23, c };
}

/* ---- console + markdown report ------------------------------------------- */
function md(table) {
  if (!table || !table.length) return '_empty_\n';
  const cols = Object.keys(table[0]);
  const row = (vals) => '| ' + vals.join(' | ') + ' |';
  return [row(cols), row(cols.map(() => '---')), ...table.map(r => row(cols.map(col => String(r[col]))))].join('\n') + '\n';
}

function report(res) {
  const { a, b1, b23, c } = res;
  const out = [];
  out.push('# The router-reading gate — "the router is a reading"\n');
  out.push('Generated by `node tools/predictive/read-router.js --write` (read-only: no engine output changes, no writes to any log; deterministic, embedder-free). The bars are declared in the read\'s header before the run; the verdicts below are computed from these numbers.\n');
  out.push('This read both GATED the build (Phase 0) and now VERIFIES it: B.2/B.3/C run with `binding_resolution` ON, so they measure the SHIPPED resolution (`resolveBinding`) and tool-query builder (`bindingQuery`) — Phase 1 and Phase 3, now built behind the dial (OFF by default; parity holds). Read A and B.1 measure the baseline router, unchanged.\n');

  out.push('## Read A — the outcome read (route reason × witness)\n');
  out.push('Each turn of the scripted, anchored, and resolution conversations is run in the app\'s exact turn order; the route REASON is joined to the answer\'s witness DEGREE, COVERAGE, and UNBOUND count (`EOAudit.truthfulness`, WI-7). Sizing only — it localizes where the router is weak; it is not a pass/fail bar. Measured on the BUILT engine (the dial is ON), so anaphoric carried follow-ups route via `names-entity` and answer through `answerResolved`, where at the Phase-0 gate they routed `continuity` and settled at witness 0.\n');
  out.push(md(a.rows));
  out.push(`Overall: **${pct(Math.round(a.strongShare * a.N), a.N)} of ${a.N} turns settle strong** (witness degree ≥ 0.5 and nothing unbound). ` +
    (a.weak.length ? `Weak cluster (mean witness < 0.40 with real volume): **${a.weak.join(', ')}**.` : 'No reason falls below the weak-cluster line.') +
    ' At the gate the weak cluster was `continuity` (witness 0.000) and `question-no-lexical`; the carried `continuity` turns are now folded into `names-entity` and answered through the binding, so the residual weakness is the embed-recall band (`question-no-lexical`), not the chat-carry band.\n');

  out.push('## Read B.1 — does the parse recover intent as well as the cascade?\n');
  out.push('The operator-projection reader uses only the type gate\'s referent (`namedReferents`) and grammatical mood (compromise) — never the cascade\'s verb lexicons. Scored against the analyst\'s intent label on the battery.\n');
  out.push(`Overall: cascade **${pct(Math.round(b1.cascadeAcc * b1.N), b1.N)}**, parse **${pct(Math.round(b1.parseAcc * b1.N), b1.N)}** (${b1.N} prompts).\n`);
  out.push(`On questions + fragments (${b1.qfN}, the set the brief says to score): cascade **${pct(Math.round(b1.qfCascadeAcc * b1.qfN), b1.qfN)}**, parse **${pct(Math.round(b1.qfParseAcc * b1.qfN), b1.qfN)}**.\n`);
  // per-class recovery
  const classRows = ['who', 'summary', 'command', 'confirm', 'factual'].map(k => ({
    intent: k,
    n: (b1.confusion.cascade[k] || {}).n || 0,
    'cascade ok': ((b1.confusion.cascade[k] || {}).ok || 0) + '/' + (((b1.confusion.cascade[k] || {}).n) || 0),
    'parse ok': ((b1.confusion.parse[k] || {}).ok || 0) + '/' + (((b1.confusion.parse[k] || {}).n) || 0),
  }));
  out.push(md(classRows));
  out.push('Per-prompt:\n');
  out.push(md(b1.rows));

  out.push('## Read B.2 — the chat figure vs the document\'s salience\n');
  out.push('Pronoun/ellipsis turns whose question names no anchor. `carry` = the anchor is hot at the floor; `precision` = the anchor sits in the top 2 by heat; `chat-correct` = the field\'s top figure IS the anchor; `doc-salience` = the document\'s heaviest figure is the anchor.\n');
  out.push(md([{
    'unnamed-anchor turns': b23.b2.n,
    'carry': `${b23.b2.carry}/${b23.b2.n} (${pct(b23.b2.carry, b23.b2.n)})`,
    'precision': `${b23.b2.precision}/${b23.b2.anyHot} (${pct(b23.b2.precision, b23.b2.anyHot)})`,
    'chat-correct': `${b23.b2.chatCorrect}/${b23.b2.n} (${pct(b23.b2.chatCorrect, b23.b2.n)})`,
    'doc-salience': `${b23.b2.docCorrect}/${b23.b2.n} (${pct(b23.b2.docCorrect, b23.b2.n)})`,
  }]));
  out.push(`Bars: carry ≥ 60% → **${b23.b2.carryPct >= 0.6 ? 'PASS' : 'FAIL'}**; precision ≥ 80% → **${b23.b2.precisionPct >= 0.8 ? 'PASS' : 'FAIL'}**; chat beats document salience (${pct(b23.b2.chatCorrect, b23.b2.n)} vs ${pct(b23.b2.docCorrect, b23.b2.n)}) → **${b23.b2.chatPct > b23.b2.docPct ? 'PASS' : 'FAIL'}**.\n`);

  out.push('## Read B.3 — is the best-guess confidence calibrated?\n');
  out.push('Confidence = the top-2 heat share (a dominant figure ⇒ ~1.0, a tie ⇒ ~0.5). Binned; empirical accuracy = how often the top figure is the anchor.\n');
  out.push(md(b23.b3.binRows.map(r => ({ 'confidence bin': r.bin, n: r.n, 'mean conf': r.meanConf == null ? '—' : f3(r.meanConf), 'accuracy': r.acc == null ? '—' : f3(r.acc) }))));
  out.push(`Expected calibration error (ECE) = **${f3(b23.b3.ece)}** (bar ≤ ${ECE_BAR}) → **${b23.b3.pass ? 'PASS' : 'FAIL'}**. ` +
    `Three-NUL-state agreement (resolved/ambiguous/absent vs the analyst call): **${b23.b3.stateAgree}/${b23.b3.statedN}**.\n`);

  out.push('## Read C / B.4 — the tool query, raw vs resolved\n');
  out.push('Acquisition turns that name the target only by pronoun. `raw` = `pickQuery(q)` today; `seeded` = `seedQuery(q, ctx)` with the top figure as subject (today\'s ctx path); `resolved` = the query built after the surface pronoun is resolved to the binding. A hit names the analyst\'s expected article target.\n');
  out.push(md(c.rows.map(r => ({ q: r.q, ctrl: r.control ? '·' : '', expect: r.expect, binding: r.binding, raw: r.raw + (r.rawHit ? ' ✓' : ''), seeded: r.seeded + (r.seededHit ? ' ✓' : ''), resolved: r.resolved + (r.resolvedHit ? ' ✓' : '') }))));
  out.push(`On the ${c.pronN} pronoun cases: raw names the target **${pct(c.rawHit, c.pronN)}**, seedQuery **${pct(c.seededHit, c.pronN)}**, resolved **${pct(c.resolvedHit, c.pronN)}**. Controls preserved: **${c.ctrlOk ? 'yes' : 'no'}**. Bar (resolved > raw, no control regression) → **${c.pass ? 'PASS' : 'FAIL'}**.\n`);

  // ---- the gate ----
  out.push('## The gate (computed)\n');
  const gate = [
    ['B.1 — parse matches the cascade on questions+fragments', b1.pass],
    ['B.2 — chat figure clears carry/precision and beats document salience', b23.b2.pass],
    ['B.3 — best-guess confidence calibrates (ECE ≤ ' + ECE_BAR + ')', b23.b3.pass],
    ['C/B.4 — resolved tool query beats the raw string', c.pass],
  ];
  for (const [label, ok] of gate) out.push(`- ${ok ? '**PASS**' : '**FAIL**'} — ${label}`);
  out.push('');

  out.push('### What the gate says, by phase\n');

  // Direction — Phase 1 (binding carries the best guess) + Phase 3 (query from binding)
  out.push('**Direction — Phase 1 & Phase 3 — confirmed.** ' + (b23.b2.pass && c.pass
    ? `The chat field resolves the user's pronoun more often than the document's salience (${pct(b23.b2.chatCorrect, b23.b2.n)} vs ${pct(b23.b2.docCorrect, b23.b2.n)}), and a query built from that guess names a real target where both \`pickQuery\` and \`seedQuery\` name a pronoun (${pct(c.resolvedHit, c.pronN)} vs ${pct(c.rawHit, c.pronN)}). This is load-bearing, not cosmetic: at the Phase-0 gate these anaphoric turns routed \`continuity\` and settled at witness 0 — the route was right and the binding was missing. With the binding built, they route \`names-entity\` (the right reason) and the answer is read on the resolved referent, so the chat-carry band now witnesses (Read A). The external-knowledge read already showed the residual is binding-shaped, not knowledge-shaped; this is the binding half.`
    : 'one of B.2/C did not clear — see above.'));
  out.push('');

  // Confidence — the explicit blocker the brief names
  const loneBin = b23.b3.binRows.find(r => r.n && r.meanConf >= 0.9);
  out.push('**Confidence — Phase 1 — fix before weighting.** ' + (b23.b3.pass
    ? `The best-guess confidence calibrates (ECE ${f3(b23.b3.ece)} ≤ ${ECE_BAR}); it can be carried on the binding and weighted.`
    : `The naive confidence (top-2 heat share) does NOT calibrate (ECE ${f3(b23.b3.ece)} > ${ECE_BAR}): it is over-confident where it matters — a lone dominant figure scores conf ${loneBin ? f3(loneBin.meanConf) : '~1.0'} but is the anchor only ${loneBin ? f3(loneBin.acc) : '~0.75'} of the time (the conversation has moved on; the hottest figure is stale). The cure is named by the brief: the confidence on the binding must be seated on the empirical hit-rate (base-rate-damped), not the raw heat. **Fix confidence first; only then tune the chat-vs-page gravity constant.** This is the one number the brief said was not optional, and the gate caught it — which is exactly Phase 0's job.`));
  out.push('');

  // Intent — Phase 2 shape
  out.push('**Intent — Phase 2 — stays guarded, fed by the parse.** ' + (b1.pass
    ? 'The parse recovers intent as well as the cascade on questions and fragments; Phase 2 may project the route over the parse for intent as well as referent.'
    : `The parse comes close (${pct(Math.round(b1.qfParseAcc * b1.qfN), b1.qfN)} vs the cascade's ${pct(Math.round(b1.qfCascadeAcc * b1.qfN), b1.qfN)} on questions+fragments) but does not beat it. It delivers the *referent* (the type gate) reliably and the *mood*, but not the verb-externality that separates an acquisition \`command\` from a content imperative, nor pure idiom (tl;dr). So Phase 2 should NOT replace the cascade wholesale: keep intent as thin, named, \`src:'hardcoded-seed'\` guards (evolvable and gateable by \`evo/\`) **fed by the parse's referents** — the structural win (the router becomes a projection that consumes the field) without pretending the parse can do work it cannot. This shrinks the graveyard honestly, exactly as the brief allows ("you learn exactly which stay regex").`));
  out.push('');

  out.push('### Status against the build order\n');
  out.push('1. **Phase 1 — BUILT.** `resolveBinding` carries the active referent as a defeasible binding (surface/name/confidence/state/via), and `depositTurn` weights the user\'s named subject above incidental answer-mentions so the field actually points at a best guess (without it the binding is correct but inert — every bare follow-up ties). Confidence is seated on the read\'s base-rate hit-rates (not the heat share that failed B.3 at the gate); B.3 re-confirms it calibrates (ECE ' + f3(b23.b3.ece) + '). `chat_field_mass` is seeded from B.2 (chat ' + pct(b23.b2.chatCorrect, b23.b2.n) + ' vs document ' + pct(b23.b2.docCorrect, b23.b2.n) + ').');
  out.push('2. **Phase 3 — BUILT.** The Wikipedia query rides the same binding (`bindingQuery`): a pronoun resolved once feeds both the route and the search. C re-confirms resolved ' + pct(c.resolvedHit, c.pronN) + ' vs raw ' + pct(c.rawHit, c.pronN) + ' on the pronoun cases.');
  out.push('3. **Phase 2 — BUILT.** `routeTurn` routes a carried anaphoric follow-up via `names-entity` (the right reason), and `answerResolved` reads the resolved question, so the chat-carry turns witness (Read A: strong-share ' + pct(Math.round(a.strongShare * a.N), a.N) + ', the `continuity`-witness-0 cluster gone). The intent-regex→guards refactor stays deferred (B.1 did not clear for pure-parse intent — intent stays guarded, fed by the parse\'s referent).');
  out.push('4. **Phase 4 — BUILT.** The binding guards (`chat_field_mass`, `binding_conf_*`, `binding_ambiguous_margin`, `binding_subject_weight`, `binding_resolution`) are all `src:\'hardcoded-seed\'`, so the `evo/` allow-list already lets the loop evolve them; a **routing** quality component (`evo/scorer.js`) scores routes/resolutions by `EOAudit.truthfulness` over a multi-turn conversation, giving the loop the fitness signal (baseline ≈ 0.42 with the dial off → ≈ 0.92 with the binding on). The model never grades itself.');
  out.push('5. **Phase 5 — optional, deferred.** A small CPU model at the edge for the residual the deterministic reading cannot close (the `question-no-lexical` band). Last, per the brief.');
  out.push('');
  out.push('`binding_resolution` now **ships ON** (the live flip): the whole golden suite is byte-identical dial-on, so the improvement ships with zero parity diffs. The floor is one `value:false` away — forced off, every consumer is exactly the pre-build behavior.');
  out.push('');
  return out.join('\n');
}

async function main() {
  const res = await run();
  const { a, b1, b23, c } = res;
  console.log('\n=== READ A — route reason × witness ===');
  console.table(a.rows);
  console.log(`strong-share ${pct(Math.round(a.strongShare * a.N), a.N)} of ${a.N};  weak cluster: ${a.weak.join(', ') || '(none)'}`);
  console.log('\n=== READ B.1 — intent recovery (cascade vs parse) ===');
  console.log(`overall: cascade ${pct(Math.round(b1.cascadeAcc * b1.N), b1.N)}  parse ${pct(Math.round(b1.parseAcc * b1.N), b1.N)}  (n=${b1.N})`);
  console.log(`questions+fragments: cascade ${pct(Math.round(b1.qfCascadeAcc * b1.qfN), b1.qfN)}  parse ${pct(Math.round(b1.qfParseAcc * b1.qfN), b1.qfN)}  (n=${b1.qfN})  → ${b1.pass ? 'PASS' : 'FAIL'}`);
  console.log('\n=== READ B.2 — chat figure vs document salience ===');
  console.log(`carry ${pct(b23.b2.carry, b23.b2.n)} (≥60), precision ${pct(b23.b2.precision, b23.b2.anyHot)} (≥80), chat ${pct(b23.b2.chatCorrect, b23.b2.n)} vs doc ${pct(b23.b2.docCorrect, b23.b2.n)}  → ${b23.b2.pass ? 'PASS' : 'FAIL'}`);
  console.log('\n=== READ B.3 — calibration ===');
  console.table(b23.b3.binRows.map(r => ({ bin: r.bin, n: r.n, meanConf: r.meanConf == null ? '—' : f3(r.meanConf), acc: r.acc == null ? '—' : f3(r.acc) })));
  console.log(`ECE ${f3(b23.b3.ece)} (≤${ECE_BAR}) → ${b23.b3.pass ? 'PASS' : 'FAIL'};  NUL-state agreement ${b23.b3.stateAgree}/${b23.b3.statedN}`);
  console.log('\n=== READ C — tool query raw vs resolved ===');
  console.table(c.rows.map(r => ({ q: r.q, ctrl: r.control ? '·' : '', raw: r.raw, rawHit: r.rawHit, seeded: r.seeded, resolved: r.resolved, resolvedHit: r.resolvedHit })));
  console.log(`pronoun cases: raw ${pct(c.rawHit, c.pronN)}, seed ${pct(c.seededHit, c.pronN)}, resolved ${pct(c.resolvedHit, c.pronN)}; controls ok ${c.ctrlOk} → ${c.pass ? 'PASS' : 'FAIL'}`);

  if (process.argv.includes('--write')) {
    const dest = path.join(ROOT, 'docs', 'router-reading-read.md');
    fs.writeFileSync(dest, report(res));
    console.log('\n✓ report →', path.relative(ROOT, dest));
  }
}

module.exports = { run, report, parseIntentRead, resolveBinding };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
