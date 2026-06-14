/* ============================================================
   eoconfidence.js — confidence as a vector, not a number.

   The system's epistemic state for a claim is the resultant of a FIELD of
   pressures, each with its own units. Collapsing them to one scalar averages
   across incommensurable kinds and loses exactly what each downstream operator
   needs: a claim with witness 0.9, coherence 0.1 and one with 0.5, 0.5 get the
   same scalar and are radically different states. This module is the primitive
   that refuses the collapse. A Confidence is a record of named, dimensioned
   components, each a number in [0,1] OR null, and every gate is a predicate
   that NAMES the components it reads. No operator sums or averages across
   components. summarize() exists only for export to systems that demand a
   scalar, and it always names the projection it performed.

   null ≠ zero ≠ low. null = "not applicable / not computed / the substrate
   does not provide it." witness:null ("grounding was not asked here") is not
   witness:0 ("asked; answer none"). Confusing them is the SQL three-valued
   mistake at the confidence layer; the audit would lie.

   The [0,1] bound is a v3 convention for migration and readable audit; native
   units (compose by dimensional analysis) are a v4 commitment.

   Pure, no deps. UMD: window.EOConfidence + module.exports.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EOConfidence = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // The named, dimensioned components. Each carries its own unit; they are
  // never added together. `margin` rides only on classification events.
  const COMPONENTS = ['witness', 'form', 'coherence', 'margin', 'retrieval', 'temporal', 'frame'];
  const UNITS = {
    witness:   'evidence-coverage',
    form:      'distance-from-prototype',
    coherence: 'standing-deficit',
    margin:    'classifier-margin',
    retrieval: 'retrieval-confidence',
    temporal:  'temporal-currency',
    frame:     'frame-fit',
  };

  const isNum = (x) => typeof x === 'number' && isFinite(x);
  // valid iff null or a finite number in [0,1] — catches scalar-smuggling and
  // out-of-range values at construction.
  const validComponent = (v) => v === null || (isNum(v) && v >= 0 && v <= 1);

  // Build a Confidence. Missing components default to null (NOT 0): absent means
  // "not computed," which is information.
  function mk(partial) {
    const p = partial || {}, c = {};
    for (const k of COMPONENTS) {
      const v = (k in p) ? p[k] : null;
      if (!validComponent(v)) throw new Error('eoconfidence: ' + k + ' must be null or a number in [0,1], got ' + JSON.stringify(v));
      c[k] = v;
    }
    return c;
  }

  const isNull = (c, k) => c == null || c[k] == null;
  // null is NEVER a low number — the three-state discipline at the gate.
  const lowBelow = (x, t) => x != null && x < t;

  /* ── Predicates over the vector (never thresholds on a collapse) ──────────
     Each predicate NAMES the components it reads. */

  // Surface gate: is the claim surfaceable? Reads `witness`. The second clause
  // is the honest-absence case — a non-Figure claim with witness:null is
  // admitting absence on a question the document was not required to answer.
  function surfaceable(c, grain) {
    const w = c ? c.witness : null;
    return (w != null && w >= 0.4) || (w == null && grain !== 'Figure');
  }

  // Repair gate: does the unit hold its shape? Reads `form`. form:null ⇒ no
  // centroid applies ⇒ no form-triggered repair.
  function needsFormRepair(c) {
    const f = c ? c.form : null;
    return f != null && f < 0.5;
  }

  // Advance gate (composition scale): reads `coherence` + dependency `witness`.
  // A unit advances with imperfect coherence only if its evidence base is solid;
  // never if it rests on thin upstream evidence. coherence:null (the standing
  // operator has not shipped) ⇒ cannot affirm advance.
  function canAdvance(c, upstream) {
    const co = c ? c.coherence : null;
    if (!(co != null && co >= 0.6)) return false;
    return (Array.isArray(upstream) ? upstream : []).every(u => !lowBelow(u ? u.witness : null, 0.3));
  }

  // Route gate: reads `witness` + `retrieval` (+ `form`). Both low ⇒ genuinely
  // unwitnessed ⇒ fetch. Low witness with high retrieval ⇒ the talker found
  // things and didn't use them ⇒ repair, not fetch.
  function route(c) {
    const w = c ? c.witness : null, r = c ? c.retrieval : null, f = c ? c.form : null;
    if (lowBelow(w, 0.4) && lowBelow(r, 0.4)) return 'fetch';
    if (lowBelow(w, 0.4) && (r != null && r >= 0.4)) return 'repair';
    if (lowBelow(f, 0.5) && (w != null && w >= 0.4)) return 'repair';
    return 'pass';
  }

  /* ── Witness grading by Object grain (the conservation read) ──────────────
     Returns { witness, tag }. Honest absence (an inert read at a Ground grain)
     scores HIGH for its grain; a massless Figure claim is a confabulation;
     absence language at a non-Ground grain is a grain-mismatch (a finding,
     witness:null — not a low score). */
  function covTag(cov) {
    if (cov == null) return 'unscored';
    if (cov >= 0.4) return 'figure-grounded';
    if (cov > 0) return 'figure-thin';
    return 'confabulation';   // cov === 0, not flagged absence
  }
  function gradeWitness(o) {
    const grain = o && o.grain;
    const cov = (o && o.coverage != null) ? o.coverage : null;
    const isAbsence = !!(o && o.isAbsence);
    if (isAbsence && grain !== 'Ground') return { witness: null, tag: 'grain-mismatch' };
    if (grain === 'Ground') {
      if (isAbsence) return { witness: 1.0, tag: 'honest-absence' };
      return { witness: cov, tag: covTag(cov) };
    }
    if (grain === 'Pattern') {
      const ko = o && o.k_observed, kr = o && o.k_required;
      if (ko == null || kr == null || kr <= 0) return { witness: null, tag: 'pattern-unscored' };
      const w = Math.min(1, ko / kr);
      return { witness: Math.round(w * 1e4) / 1e4, tag: w >= 1 ? 'pattern-grounded' : 'pattern-partial' };
    }
    return { witness: cov, tag: covTag(cov) };   // Figure (default)
  }

  /* ── summarize: external interop ONLY ─────────────────────────────────────
     Returns a number, but NEVER without naming the projection. Pass a `sink`
     to log every projection (the audit requirement). Internal code must never
     treat 'overall' as truth — it is a derived summary, not the primitive. */
  function projection(c, purpose, weights) {
    c = c || {};
    if (purpose === 'grounding') return { projection: 'witness', value: c.witness, used: ['witness'] };
    if (purpose === 'shape')     return { projection: 'form', value: c.form, used: ['form'] };
    if (purpose === 'standing')  return { projection: 'coherence', value: c.coherence, used: ['coherence'] };
    if (purpose === 'overall') {
      const used = COMPONENTS.filter(k => c[k] != null);
      const w = weights || {};
      let lnsum = 0, wsum = 0, anyZero = false;
      for (const k of used) {
        const wi = (w[k] != null) ? w[k] : 1;
        if (c[k] === 0) anyZero = true;
        lnsum += wi * Math.log(c[k]); wsum += wi;
      }
      const value = used.length === 0 ? null : (anyZero ? 0 : Math.exp(lnsum / wsum));
      return { projection: 'overall:weighted-geomean', value: value == null ? null : Math.round(value * 1e4) / 1e4,
        used, weights: Object.fromEntries(used.map(k => [k, (w[k] != null ? w[k] : 1)])) };
    }
    throw new Error('eoconfidence.summarize: unknown purpose ' + JSON.stringify(purpose));
  }
  function summarize(c, purpose, sink, weights) {
    const rec = projection(c, purpose, weights);
    if (typeof sink === 'function') sink(rec);
    return rec.value;
  }

  return {
    COMPONENTS, UNITS, mk, isNull, validComponent,
    surfaceable, needsFormRepair, canAdvance, route,
    gradeWitness, covTag, projection, summarize,
  };
});
