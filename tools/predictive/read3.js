/* ============================================================
   read 3 — relation-mismatch count per claim.
   Gates the relation gate (the inversion fix). This read IS the gate's
   prototype, run read-only over a final.text-shaped claims battery.

   For each claim, the steps the gate would take:
     1. extract the claim's asserted subject–predicate–object with the
        same clause heuristic the engine's SVO reader uses,
     2. bind the claim the way the CURRENT binder would (bindCitations —
        the after-the-fact stapler whose failure mode motivates all of
        this), giving the span its footnote would point at,
     3. collect the relations to check against: CON edges and text-layer
        SYN edges the graph deposited (subject hints resolved), edges
        derived from DEF role/class assertions, and — because the graph
        is sparse on exactly the relations summaries invert — the live
        SVO read of the bound span itself; a claim that bound nowhere is
        resolved by RELATION (spans whose predicate is compatible),
     4. align the claim's subject and object to each edge's s and o:
        lexically first (token subset; two DISTINCT named figures never
        embed-align), the embedder only as a similarity scorer for
        predicate compatibility and description↔name paraphrase,
     5. classify: edge-bound / span-bound / surface-only-no-relation /
        contradicts-graph (inverted, foreign-subject, or wrong-speaker).

   Measured findings this design rests on (MiniLM q8, the app's dtype):
     cos('afford','pay') = 0.62          — predicate signal is REAL
     cos('association','partnership') = 0.26
     cos('association','owners')      = 0.26 — subject-surface signal is
     NOISE: short-surface cosine cannot order the sides, so alignment is
     lexical-first and the absent-from-the-edge branch (antimatter, the
     void machinery the engine already has) carries the Association case.

   The bar (from the spec): "The Association cannot afford" must flag
   against the owner-pays edge AND a faithful paraphrase of owners-pay
   must pass. The battery carries both, plus controls.
   ============================================================ */
'use strict';
const path = require('path');
const nlp = require('compromise');
const { loadEngine } = require(path.join(__dirname, '..', '..', 'tests', 'harness.js'));
const emb = require('./embed-node');
const FIX = require('./fixtures');

// — thresholds the prototype runs at (reported with the table) —
const ALIGN_FLOOR = 0.45;   // below this, a surface doesn't align to an edge slot
const REL_FLOOR = 0.55;     // predicate compatibility floor (verb cosine; afford↔pay = 0.62 clears, argued↔hear = 0.50 does not)
const REL_STRONG = 0.55;    // a predicate match strong enough to anchor an ABSENT-subject flag without an object anchor

const norm = (s) => String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const STOPTOK = new Set(['the', 'a', 'an', 'his', 'her', 'their', 'its', 'this', 'that', 'of', 'to', 'own', 'mr', 'mrs']);
const toks = (s) => norm(s).split(' ').filter(t => t && !STOPTOK.has(t));
function lexSubset(a, b) {
  const ta = toks(a), tb = toks(b);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return small.every(w => big.has(w));
}
function normRel(verb) {
  return String(verb).toLowerCase().replace(/[,.;:"“”]/g, '')
    .replace(/\b(is|are|was|were|be|been|being|has|have|had|do|does|did|will|would|can|cannot|could|to|not|never|also|then|still|already)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}
function lemmas(w) {
  const out = new Set([w]);
  if (w.endsWith('ies') || w.endsWith('ied')) out.add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) out.add(w.slice(0, -1));
  if (w.endsWith('ed')) { out.add(w.slice(0, -2)); out.add(w.slice(0, -1)); }
  if (w.endsWith('ing')) { out.add(w.slice(0, -3)); out.add(w.slice(0, -3) + 'e'); }
  return out;
}
function lemmaOverlap(a, b) {
  const la = new Set(), lb = new Set();
  for (const w of normRel(a).split(' ')) for (const l of lemmas(w)) la.add(l);
  for (const w of normRel(b).split(' ')) for (const l of lemmas(w)) lb.add(l);
  for (const l of la) if (l && lb.has(l)) return true;
  return false;
}

const COPULAR = /^(is|are|was|were|be|been|being|seems?|appears?|remains?|becomes?|became)$/i;
const AUX = /^(have|has|had|do|does|did|got|get|be|been|being)$/i;
const PRONOUN = /^(he|she|it|they|him|her|them|his|hers|their|its|i|we|you|who|whom|that|this|those|these|me|us|one|nobody|everyone|someone)$/i;
const ATTRIB = new Set(['said', 'says', 'say', 'answered', 'replied', 'wrote', 'called', 'told', 'asked',
  'exclaimed', 'shouted', 'whispered', 'muttered', 'added', 'stated', 'noted', 'remarked', 'commented', 'argued']);

/* Claim SVO candidates — the engine's clause heuristic (first noun /
   last verb / last noun) plus the head-verb variant (first noun / first
   main verb / following noun), because a claim's main predicate often
   leads while the engine's page heuristic trails. */
function svoOf(text) {
  const cands = [];
  const negated = /\b(not|never|cannot|no longer)\b|n['’]t\b/i.test(text);
  nlp(text).clauses().forEach(clause => {
    const nouns = clause.nouns().out('array');
    const verbs = clause.verbs().out('array');
    if (nouns.length < 2 || verbs.length < 1) return;
    const variants = [
      { v: verbs[verbs.length - 1], o: nouns[nouns.length - 1] },
      { v: verbs[0], o: nouns[1] },
    ];
    for (const { v, o } of variants) {
      const s = nouns[0];
      if (!s || !v || !o || norm(s) === norm(o)) continue;
      const vFirst = String(v).toLowerCase().split(/\s+/)[0];
      const copular = COPULAR.test(vFirst);
      if (AUX.test(vFirst)) continue;
      if (cands.some(c => norm(c.s) === norm(s) && normRel(c.v) === normRel(v) && norm(c.o) === norm(o))) continue;
      cands.push({ s, v: String(v).toLowerCase(), o, copular, negated });
    }
  });
  return cands;
}

/* Every relation the gate can check a claim against. Deposited edges
   first (subject hints resolved to their referent's name; an unhinted
   pronoun subject is unreliable and never carries a verdict), then
   edges derived from DEF role/class assertions, then the live SVO read
   of each sentence (minted on demand). */
function buildRelations(E, doc) {
  const edges = [];
  for (const ev of (doc._events || [])) {
    if (ev.op === 'CON') {
      edges.push({ s: ev.sourceName || ev.s, v: ev.v, o: ev.targetName || ev.o, sent: ev.sentence_idx, via: 'CON' });
    } else if (ev.op === 'SYN' && !Array.isArray(ev.sites) && ev.s && ev.v && ev.o) {
      const sName = (ev.sHint && ev.sHint.name) || ev.s;
      const oName = (ev.oHint && ev.oHint.name) || ev.o;
      edges.push({ s: sName, v: ev.v, o: oName, sent: ev.sentence_idx, via: 'SYN', pronoun: !ev.sHint && PRONOUN.test(String(ev.s).trim()) });
    }
  }
  let defs = [];
  try { defs = E.assertionsOf(doc) || []; } catch (e) {}
  for (const d of defs) {
    if (d.path !== 'role' && d.path !== 'class') continue;
    for (const c of svoOf(d.subject + ' ' + d.is))
      edges.push({ s: c.s, v: c.v, o: c.o, sent: d.sent, via: 'DEF' });
  }
  const liveCache = new Map();
  const QUOTEY = /["“”]/;     // a quote fragment in an argument slot is reported speech, not a relation
  const liveAt = (idx) => {
    if (liveCache.has(idx)) return liveCache.get(idx);
    const t = (doc.sentenceTexts || [])[idx] || '';
    const out = svoOf(t)
      .filter(c => !QUOTEY.test(c.s) && !QUOTEY.test(c.o))
      .map(c => ({ s: c.s, v: c.v, o: c.o, sent: idx, via: 'span-svo', pronoun: PRONOUN.test(String(c.s).trim()) }));
    liveCache.set(idx, out);
    return out;
  };
  const sigs = (doc._events || []).filter(e => e.op === 'SIG')
    .map(e => ({ sent: e.sentence_idx, speaker: (e.speakerHint && e.speakerHint.name) || e.speaker }));
  return { edges, defs, liveAt, sigs };
}

async function main() {
  await emb.init();
  const E = loadEngine().EOEngine;
  const vec = emb.makeCache();
  const cosOf = async (a, b) => {
    const va = await vec(a), vb = await vec(b);
    return (va && vb) ? emb.cos(va, vb) : 0;
  };

  const docs = new Map();
  const need = new Set(FIX.claims().map(c => c.docId));
  for (const spec of FIX.documents()) {
    if (!need.has(spec.id)) continue;
    const doc = await E.parseDocument(spec.name, spec.text, spec.id);
    const ents = (() => { try { return (E.projectEntities(doc).entities || []).map(e => e.name); } catch (e) { return []; } })();
    docs.set(spec.id, { doc, rel: buildRelations(E, doc), ents });
  }

  const rows = [];
  for (const item of FIX.claims()) {
    const { doc, rel, ents } = docs.get(item.docId);

    // two distinct named figures of the page never embed-align (Ruiz≠Vance)
    const entityOf = (surface) => ents.find(n => lexSubset(surface, n)) || null;
    const align = async (a, b) => {
      if (lexSubset(a, b)) return 1;
      const ea = entityOf(a), ebt = entityOf(b);
      if (ea && ebt && ea !== ebt) return 0;
      return cosOf(a, b);
    };
    const relComp = async (cv, ev) => {
      if (lemmaOverlap(cv, ev)) return 1;
      const a = normRel(cv) || String(cv), b = normRel(ev) || String(ev);
      return cosOf(a, b);
    };

    // is the claim's subject a NAMED referent (present or absent)?
    const named = (surface) => {
      let r = { matter: [], antimatter: [] };
      try { r = E.referentsScope([doc], item.claim) || r; } catch (e) {}
      const all = [...(r.matter || []), ...(r.antimatter || [])];
      return all.some(n => lexSubset(n, surface) || lexSubset(surface, n))
        ? { isNamed: true, absent: (r.antimatter || []).some(n => lexSubset(n, surface) || lexSubset(surface, n)) }
        : { isNamed: !!entityOf(surface), absent: false };
    };

    // the CURRENT binder's footnote — where citation-as-costume points
    let boundIdx = null, absent = false;
    try {
      const bc = E.bindCitations(doc, item.claim, item.claim, 'factual');
      const m = /\{\{cite:[^:}]+:(\d+):/.exec(bc.text);
      if (m) boundIdx = +m[1];
      absent = /\{\{absent:/.test(bc.text);
    } catch (e) {}

    const cands = svoOf(item.claim);
    let verdict = null, detail = null;
    const flag = (v, d) => { if (!verdict || /^contradicts/.test(v) && !/^contradicts/.test(verdict)) { verdict = v; detail = d; } };

    for (const c of cands) {
      const vHead = normRel(c.v).split(' ')[0] || String(c.v).split(/\s+/).pop();

      // — attribution claims check the SIG record first: who held the slot —
      if (ATTRIB.has(vHead) && boundIdx != null) {
        const sig = rel.sigs.find(g => g.sent === boundIdx && g.speaker && g.speaker !== '?');
        if (sig) {
          const a = await align(c.s, sig.speaker);
          if (a >= ALIGN_FLOOR) { flag('edge-bound', { edge: `${sig.speaker} —said→ “…”`, at: boundIdx, via: 'SIG', claimSVO: `${c.s} —${c.v}→ ${c.o}` }); continue; }
          if (entityOf(c.s) && entityOf(sig.speaker) && entityOf(c.s) !== entityOf(sig.speaker)) {
            flag('contradicts-graph (wrong-speaker)', { edge: `${sig.speaker} —said→ “…”`, at: boundIdx, via: 'SIG', claimSVO: `${c.s} —${c.v}→ ${c.o}` });
            continue;
          }
        }
      }

      // — candidate relations: bound span first, then graph-wide, then
      //   relation-resolved live reads for the unbound claim —
      const pool = [];
      if (boundIdx != null) {
        for (const e of rel.edges) if (e.sent === boundIdx) pool.push(e);
        for (const e of rel.liveAt(boundIdx)) pool.push(e);
      }
      for (const e of rel.edges) if (e.sent !== boundIdx) pool.push(e);
      if (boundIdx == null) {
        const n = (doc.sentenceTexts || []).length;
        for (let i = 0; i < n; i++) for (const e of rel.liveAt(i)) pool.push(e);
      }

      for (const e of pool) {
        if (c.copular) break;                             // a copular claim is DEF territory, not an enacted relation
        if (e.pronoun) continue;                          // an unresolved pronoun subject carries no verdict
        const rc = await relComp(c.v, e.v);
        if (rc < REL_FLOOR) continue;
        const sS = await align(c.s, e.s), sO = await align(c.s, e.o);
        const oS = await align(c.o, e.s), oO = await align(c.o, e.o);
        const d = { edge: `${e.s} —${normRel(e.v) || e.v}→ ${e.o}`, at: e.sent, via: e.via, claimSVO: `${c.s} —${c.v}→ ${c.o}`, rc: +rc.toFixed(2), sS: +sS.toFixed(2), sO: +sO.toFixed(2), oS: +oS.toFixed(2), oO: +oO.toFixed(2) };
        // the clean swap: subject sits lexically on the object side and
        // the object on the subject side (the Partnership-pays-owners case)
        if (sO >= 0.9 && sS < ALIGN_FLOOR && (oS >= 0.9 || oO < ALIGN_FLOOR)) { flag('contradicts-graph (inverted)', d); break; }
        // subject aligned where the edge put it → the claim holds the relation
        if (sS >= ALIGN_FLOOR && sS >= sO) { flag('edge-bound', d); continue; }
        // a NAMED subject the edge doesn't carry, asserting this very
        // relation. The same act with the same object and a different
        // actor is the wrong-actor case (object anchored); without the
        // object anchor only a subject ABSENT from the whole page can
        // flag — a present figure may hold the same relation elsewhere.
        const nm = named(c.s);
        if (nm.isNamed && Math.max(sS, sO) < ALIGN_FLOOR &&
            (oO >= ALIGN_FLOOR || (nm.absent && rc >= REL_STRONG))) {
          flag('contradicts-graph (foreign-subject)', { ...d, subjectAbsentFromPage: nm.absent });
        }
      }
      if (verdict && /inverted/.test(verdict)) break;

      // copular claims check the DEF assertions (the graph's "X is Y")
      if (!verdict && c.copular) {
        for (const dd of rel.defs) {
          const sA = await align(c.s, dd.subject);
          const head = toks(dd.is).slice(0, 2);
          const claimToks = new Set(toks(item.claim));
          if (sA >= ALIGN_FLOOR && head.length && head.every(t => claimToks.has(t))) {
            flag('edge-bound', { edge: `${dd.subject} is ${dd.is.slice(0, 60)}`, at: dd.sent, via: 'DEF', claimSVO: `${c.s} —${c.v}→ ${c.o}` });
            break;
          }
        }
      }
    }
    if (!verdict) verdict = (boundIdx != null || absent) ? 'span-bound' : 'surface-only-no-relation-match';

    const flagged = /^contradicts/.test(verdict);
    const ok = item.expect === 'flag' ? flagged
      : item.expect === 'surface' ? verdict === 'surface-only-no-relation-match'
      : !flagged;
    rows.push({ docId: item.docId, claim: item.claim, expect: item.expect, verdict, ok, bound: absent ? '⊥' : boundIdx, detail });
  }

  // ---- the count table ----
  const counts = new Map();
  for (const r of rows) {
    const k = r.docId;
    if (!counts.has(k)) counts.set(k, { 'span-bound': 0, 'edge-bound': 0, 'surface-only': 0, 'contradicts-graph': 0 });
    const c = counts.get(k);
    if (/^contradicts/.test(r.verdict)) c['contradicts-graph']++;
    else if (r.verdict === 'edge-bound') c['edge-bound']++;
    else if (r.verdict === 'span-bound') c['span-bound']++;
    else c['surface-only']++;
  }
  const table = [...counts.entries()].map(([docId, c]) => ({ doc: docId, ...c }));
  const agreed = rows.filter(r => r.ok).length;
  const bar = {
    'inversion flagged': rows.find(r => /Association cannot afford/.test(r.claim)).ok,
    'faithful paraphrase passed': rows.filter(r => /owners pay|Business owners pay/i.test(r.claim)).every(r => r.ok),
    'battery agreement': `${agreed}/${rows.length}`,
  };
  return { rows, table, bar, thresholds: { ALIGN_FLOOR, REL_FLOOR, REL_STRONG } };
}

module.exports = { run: main };
if (require.main === module) main().then(r => {
  console.table(r.table);
  console.log('bar:', r.bar, 'thresholds:', r.thresholds);
  for (const row of r.rows) console.log((row.ok ? ' ✓ ' : ' ✗ ') + `[${row.docId}] "${row.claim}" → ${row.verdict}` + (row.detail ? `\n      vs ${row.detail.edge} (s${row.detail.at}, ${row.detail.via})` + (row.detail.sS != null ? ` sS=${row.detail.sS} sO=${row.detail.sO} oS=${row.detail.oS} oO=${row.detail.oO} rc=${row.detail.rc}` : '') : ''));
}).catch(e => { console.error(e); process.exit(1); });
