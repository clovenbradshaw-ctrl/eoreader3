/* ============================================================
   eoscore.js — layered position scorer (Object, Domain) → a classification
   Confidence.

   Mode is a lookup (the Site face collapses it), never scored. Object is always
   scored; Domain is scored for a target (where no operator exists yet). Layers,
   each emitting a contribution + an evidence tag:
     - cue:          lexical cue lists (objectOf / domainOf)
     - ablation:     δ = embed(S) − embed(S without e)        (needs an embedder)
     - substitution: δ = embed(S) − embed(S, e→generic)       (needs an embedder)
   Centroids are themselves exemplar ABLATION/substitution deltas, so the query's
   δ is compared δ-vs-δ (type-matched). The classifier's output is a Confidence
   carrying `margin` (the discrimination separation, top1−top2); the
   evidence-bearing components are left null — a classification is about position
   in the embedding space, not evidence in the log.

   Dependency-injected and graceful: with no embedder it degrades to the cue
   layer alone (and reports it via layers()). The no-cue default is NOT a
   confident call — its margin is null (not 0), honoring null ≠ zero ≠ low.

   UMD: window.EOScore + module.exports.
   ============================================================ */
(function (root, factory) {
  const dep = (typeof require !== 'undefined') ? require('./eoconfidence') : (root && root.EOConfidence);
  const api = factory(dep);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EOScore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (EOConfidence) {
  'use strict';

  const OBJECT_VALUES = ['Ground', 'Figure', 'Pattern'];
  const DOMAIN_VALUES = ['Existence', 'Structure', 'Interpretation'];

  // Seed Domain cues — a coarse prior (the embedding layer is the contextual
  // engine). Mirrors the site_*_cues seed style. Existence = whether/who/what a
  // thing is; Structure = how things relate; Interpretation = what they mean.
  const DOMAIN_CUES = {
    Existence: new Set(['is', 'was', 'are', 'were', 'exists', 'exist', 'there', 'who', 'what', 'when', 'where', 'named', 'called', 'born', 'died', 'lives', 'located', 'happened', 'occurred']),
    Structure: new Set(['between', 'connects', 'connected', 'depends', 'dependency', 'part', 'linked', 'link', 'relation', 'related', 'causes', 'caused', 'member', 'belongs', 'among', 'versus', 'compared', 'contains', 'includes']),
    Interpretation: new Set(['mean', 'means', 'meant', 'meaning', 'why', 'implies', 'matters', 'significance', 'interpret', 'interpreted', 'symbolizes', 'represents', 'good', 'bad', 'should', 'better', 'worse', 'important', 'moral', 'purpose']),
  };
  const tokens = (s) => String(s || '').toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || [];
  function defaultDomainOf(surface) {
    const toks = tokens(surface), score = { Existence: 0, Structure: 0, Interpretation: 0 };
    for (const t of toks) for (const d of DOMAIN_VALUES) if (DOMAIN_CUES[d].has(t)) score[d]++;
    let best = null, bestN = 0, ties = 0;
    for (const d of DOMAIN_VALUES) { if (score[d] > bestN) { best = d; bestN = score[d]; ties = 1; } else if (score[d] === bestN && bestN > 0) ties++; }
    return (bestN > 0 && ties === 1) ? best : null;   // null = no confident cue (not a default guess)
  }

  // Local vector helpers (used only if EOShape isn't injected).
  function localCosine(a, b) { if (!a || !b) return 0; let d = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } const den = Math.sqrt(na) * Math.sqrt(nb); return den ? d / den : 0; }
  function sub(a, b) { const n = Math.min(a.length, b.length), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] - b[i]; return o; }
  function mean(vs) { if (!vs.length) return null; const n = vs[0].length, o = new Float32Array(n); for (const v of vs) for (let i = 0; i < n; i++) o[i] += v[i]; for (let i = 0; i < n; i++) o[i] /= vs.length; return o; }

  function createScorer(deps) {
    deps = deps || {};
    const objectOf = deps.objectOf || (() => 'Figure');
    const domainOf = deps.domainOf || defaultDomainOf;
    const embed = (typeof deps.embed === 'function') ? deps.embed : null;
    const cosine = (deps.shape && deps.shape.cosine) ? deps.shape.cosine : localCosine;
    const exemplars = Array.isArray(deps.exemplars) ? deps.exemplars : [];
    const generic = deps.generic || 'it';
    const centroids = { object: null, domain: null };   // { value: deltaCentroid }
    let embeddingsActive = false;

    const elide = (S, e) => { const i = String(S).indexOf(e); return i < 0 ? String(S) : (S.slice(0, i) + ' ' + S.slice(i + e.length)).replace(/\s+/g, ' ').trim(); };
    const swap = (S, e) => { const i = String(S).indexOf(e); return i < 0 ? String(S) : (S.slice(0, i) + generic + S.slice(i + e.length)).replace(/\s+/g, ' ').trim(); };

    // Build per-value DELTA centroids from labeled exemplars (substitution
    // deltas), so the query's δ is compared δ-vs-δ. No-op without an embedder.
    async function ready() {
      if (!embed || !exemplars.length) { embeddingsActive = false; return false; }
      try {
        const byAxis = { object: {}, domain: {} }, texts = [], jobs = [];
        for (const ex of exemplars) {
          if (!ex || !ex.axis || !ex.value || !ex.text || !ex.element) continue;
          jobs.push({ axis: ex.axis, value: ex.value, fi: texts.length, si: texts.length + 1 });
          texts.push(ex.text, swap(ex.text, ex.element));
        }
        if (!jobs.length) { embeddingsActive = false; return false; }
        const vecs = await embed(texts);
        if (!vecs || vecs.length !== texts.length) { embeddingsActive = false; return false; }
        for (const j of jobs) { const d = sub(vecs[j.fi], vecs[j.si]); (byAxis[j.axis][j.value] = byAxis[j.axis][j.value] || []).push(d); }
        centroids.object = {}; centroids.domain = {};
        for (const ax of ['object', 'domain']) for (const val of Object.keys(byAxis[ax])) centroids[ax][val] = mean(byAxis[ax][val]);
        embeddingsActive = Object.keys(centroids.object).length > 1 || Object.keys(centroids.domain).length > 1;
        return embeddingsActive;
      } catch (e) { embeddingsActive = false; return false; }
    }

    async function scoreEmbedding(axis, S, e) {
      const cs = centroids[axis]; if (!embed || !cs) return null;
      const values = Object.keys(cs); if (values.length < 2) return null;
      let vecs; try { vecs = await embed([S, elide(S, e), swap(S, e)]); } catch (_) { return null; }
      if (!vecs || vecs.length < 3) return null;
      const dA = sub(vecs[0], vecs[1]), dS = sub(vecs[0], vecs[2]);
      const scores = values.map(v => ({ v, s: (cosine(dA, cs[v]) + cosine(dS, cs[v])) / 2 })).sort((a, b) => b.s - a.s);
      const margin = Math.max(0, Math.min(1, scores[0].s - scores[1].s));
      return { value: scores[0].v, margin };
    }

    const cueObject = (e) => { const ov = objectOf(e); return ov !== 'Figure' ? { value: ov, hit: true } : { value: 'Figure', hit: false }; };
    const cueDomain = (e) => { const dv = domainOf(e); return dv ? { value: dv, hit: true } : { value: 'Existence', hit: false }; };

    async function classify(axis, sentence, element) {
      const S = String(sentence == null ? '' : sentence), e = String(element == null ? '' : element);
      const evidence = []; let value, margin = null;
      const cue = axis === 'object' ? cueObject(e) : cueDomain(e);
      if (cue.hit) { evidence.push('cue'); value = cue.value; margin = 0.5; }
      else { value = cue.value; }   // the no-cue default; margin stays null (not a confident call)
      if (embeddingsActive) {
        const emb = await scoreEmbedding(axis, S, e);
        if (emb) { evidence.push('ablation', 'substitution'); value = emb.value; margin = emb.margin; }
      }
      return { axis, value, element: e, confidence: EOConfidence.mk({ margin }), evidence };
    }

    return {
      ready,
      classifyObject: (s, e) => classify('object', s, e),
      classifyDomain: (s, e) => classify('domain', s, e),
      layers: () => embeddingsActive ? ['cue', 'ablation', 'substitution'] : ['cue'],
      embeddingsActive: () => embeddingsActive,
    };
  }

  return { createScorer, defaultDomainOf, OBJECT_VALUES, DOMAIN_VALUES };
});
