/* ============================================================
   addressee.js — the second person: the addressee field.

   eoreader3 already runs a strong FIRST person (the witness: the system's
   faithfulness to the document) and a strong THIRD person (the graph: the
   ontology of what the text is about). The position underbuilt is the SECOND:
   the addressee, the one mind in the room the reader has been treating as a
   copy of itself. This module is that second person — a chat-scoped OVERLAY
   over the reader's own reading that marks, per span / entity / claim, what the
   exchange has established the person has of it. It is the twin of
   conversationField (engine.js), sibling to the page field and the chat field.

   The governing assumption: the document is UNREAD until proven otherwise.
   Uploading is not reading. A person who drops a 40-page PDF has, by default,
   read NONE of it, and the field must never attribute to them a single thing the
   CONVERSATION did not establish. Three consequences the whole module obeys:

     1. The Given-Log is COMMON GROUND in Stalnaker's strict sense — the
        propositions mutually accepted FOR THE PURPOSES OF THIS EXCHANGE — never
        the sum of what the person privately knows. The upload builds nothing;
        only the exchange does.
     2. Display is an OFFER, not a grounding. Only UPTAKE grounds (Clark). A span
        the system cited enters 'offered'; it is promoted to 'grounded' only when
        the person's next turn takes it up.
     3. The failure direction is always RE-INTRODUCE, never skip. Every uncertain
        case resolves to 'new'. Re-introducing is cheap; wrongly skipping what the
        person needed lands as "you should have known this."

   This is BOOKKEEPING, not mind-reading. The field never speculates about the
   person's psyche; a deterministic update sets pUptake from whether a thing was
   offered, taken up, how long ago, and whether it was objected to. The person's
   actual belief is no more accessible than the actual referent of a word, so the
   field holds the OBSERVABLE PROXY — the common ground, the record of what was
   said and shown — and refuses to claim more. Legible-THAT, never legible-why.

   Pure and DEPENDENCY-INJECTED: the decay γ and resolveBinding are passed into
   create(), never imported, so the whole thing runs in Node with fakes. Holds
   POINTERS only (docId:idx / entity key / proposition string), never document
   text. Chat-scoped and serializable: it rides the chat snapshot beside
   conversationField.snapshot(), reset on a new or switched chat.

   UMD: window.EOAddressee + module.exports.
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.EOAddressee = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // The seed constants. Mirror the addressee_* reading rules (engine.js); the
  // host passes the live rule values into create(), these are the fallbacks.
  const DEFAULTS = {
    gamma: 0.7,            // decay_gamma — the medium's γ, the chat field's own
    learn: 0.6,           // addressee_learn_rate — one uptake ≠ standing knowledge (< 1)
    slip: 0.05,           // addressee_slip — the floor keeping a grounded span under 1.0
    uptakeFloor: 0.55,    // addressee_uptake_floor — at/above ⇒ grounded, may be referenced
    uncertainMargin: 0.20, // addressee_uncertain_margin — the hysteresis band below the floor
  };

  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  /* ── The uptake tracer — BKT in shape, but tracking UPTAKE, not knowledge ──
     The whole correction over tutoring's BKT (Corbett & Anderson): BKT tracks
     "has the student mastered the skill," which the tutor can TEST. The reader
     cannot test what the person knows and must not pretend to. So pUptake tracks
     the one thing the exchange exposes — IS THIS STILL LIVE AND SHARED BETWEEN US
     — and nothing more. */

  // Rises when an offered span is TAKEN UP (not merely displayed). Hedged
  // (learn < 1): uptake on one turn is not standing knowledge. Capped under 1.0
  // by the slip floor — never certain.
  function bktLearn(p, learn, slip) {
    const p0 = (p == null) ? 0 : clamp01(p);
    const l = isNum(learn) ? clamp01(learn) : DEFAULTS.learn;
    const s = isNum(slip) ? clamp01(slip) : DEFAULTS.slip;
    const raised = p0 + (1 - p0) * l;
    return Math.min(raised, 1 - s);
  }

  // Decays by the medium's γ once per turn, toward OFFERED (0), never below it.
  // null ("never offered, not applicable") stays null — it is NOT 0 ("offered,
  // no uptake yet"); the three-state gate, not the SQL three-valued mistake.
  function bktDecay(p, gamma) {
    if (p == null) return null;
    const g = (isNum(gamma) && gamma > 0) ? gamma : DEFAULTS.gamma;
    const v = clamp01(p) * g;
    return v < 1e-4 ? 0 : Math.round(v * 1e6) / 1e6;
  }

  /* ── The three-state gate (the resolveBinding triple) ─────────────────────
     pUptake: null ("never offered") is NOT pUptake: 0 ("offered, no uptake yet")
     is NOT a high value ("grounded and live"). The three map onto the binding's
     resolved | ambiguous | absent — so a pronoun resolved once and a fact
     known-or-not are read off one calibrated scale. */
  function stateOf(pUptake, floor) {
    if (pUptake == null) return 'absent';            // never offered → introduce fresh
    const f = isNum(floor) ? floor : DEFAULTS.uptakeFloor;
    if (pUptake >= f) return 'resolved';             // grounded & live → reference as shared
    return 'ambiguous';                              // offered / cooled → re-state lightly
  }

  /* The render band for the given-new contract. 'new' is the resting default for
     the ENTIRE document (unread until grounded). A grounded entry keeps its
     reference license through a hysteresis band (floor − margin) so a value
     flickering at the floor does not oscillate; an 'offered' entry never earns
     the license at all (it took no learn step). */
  function band(entry, floor, margin) {
    if (!entry) return 'new';
    const p = entry.pUptake;
    if (p == null) return entry.status === 'offered' ? 'offered' : 'new';
    const f = isNum(floor) ? floor : DEFAULTS.uptakeFloor;
    const m = isNum(margin) ? margin : DEFAULTS.uncertainMargin;
    // grounded / user-typed earned the license once; hold it across the margin.
    const ref = (entry.status === 'grounded' || entry.status === 'user-typed') ? (f - m) : f;
    return p >= ref ? 'grounded' : 'offered';
  }

  const spanKey = (docId, idx) => (docId || '') + ':' + (idx | 0);

  /* ──────────────────────────────────────────────────────────────────────────
     The field instance. Two logs and one confidence, exactly as the system has:
       • the Given-Log    — the conversational common ground (offered/grounded)
       • the Meant-Graph   — what the person believes, false-belief separated
       • pUptake on each   — the uptake tracer, the hidden state on evidence
     ────────────────────────────────────────────────────────────────────────── */
  function create(config) {
    const cfg = config || {};
    // DI: γ and resolveBinding are PASSED IN, never imported. A function may be
    // passed for gamma so the host can track a live rule without rebuilding.
    const gammaOf = () => {
      const g = (typeof cfg.gamma === 'function') ? cfg.gamma() : cfg.gamma;
      return (isNum(g) && g > 0) ? g : DEFAULTS.gamma;
    };
    const ruleOf = (k) => {
      const v = (typeof cfg[k] === 'function') ? cfg[k]() : cfg[k];
      return isNum(v) ? v : DEFAULTS[k];
    };
    const resolveBinding = (typeof cfg.resolveBinding === 'function') ? cfg.resolveBinding : null;

    // docId:idx | entity-key  →  GivenEntry. One map, kind-tagged.
    const given = new Map();
    // proposition-string  →  MeantNode. Its OWN nodes, distinct from the document
    // graph's — Sally's marble and the actual marble are different nodes.
    const meant = new Map();
    const state = { turn: 0 };

    // ── 1. The Given-Log — the conversational common ground ──────────────────

    // offered — a citation surfaced a verbatim span in a rendered answer. THE
    // OFFER, NOT THE GROUNDING: it enters 'offered', never as shared, because we
    // do not know the person read it. An INS of a PENDING node into common ground.
    function offer(spans, msgId, kind) {
      const k = kind || 'span';
      for (const s of (spans || [])) {
        if (!s) continue;
        const key = (typeof s === 'string') ? s : spanKey(s.docId, s.idx);
        if (!key || key === ':0' && s && s.idx == null) continue;
        let e = given.get(key);
        if (!e) {
          e = { key, kind: k, docId: (typeof s === 'object' ? (s.docId || null) : null),
                idx: (typeof s === 'object' && s.idx != null ? (s.idx | 0) : null),
                firstSeenTurn: state.turn, lastSeenTurn: state.turn, timesShown: 0,
                surfacedIn: [], status: 'offered', pUptake: 0 };
          given.set(key, e);
        }
        e.lastSeenTurn = state.turn;
        e.timesShown += 1;
        if (msgId != null && !e.surfacedIn.includes(msgId)) e.surfacedIn.push(msgId);
        // re-offering never demotes a grounded/user-typed entry, and never lifts
        // an offered one off the floor — only uptake does that.
      }
      return this;
    }

    // grounded — an offered span is promoted ONLY when the person's next turn
    // shows uptake (references its content, builds on it, asks a follow-up
    // premised on it, confirms it). Clark's grounding made mechanical, and the
    // only thing that licenses "as we established at [s12]". A span the system
    // cited that the person then ignored stays 'offered' and is re-introduced.
    function ground(key, opts) {
      const e = given.get(key);
      if (!e) return null;                            // can only ground what was offered
      if (e.status === 'offered') e.status = 'grounded';
      e.pUptake = bktLearn(e.pUptake, ruleOf('learn'), ruleOf('slip'));
      e.lastSeenTurn = state.turn;
      if (opts && opts.msgId != null && !e.surfacedIn.includes(opts.msgId)) e.surfacedIn.push(opts.msgId);
      return e;
    }

    // user-typed — the entities and spans the person's OWN turn produced. What
    // they typed, they produced; the one source that grounds immediately (no
    // separate uptake test — producing IS uptake). The strongest given.
    function userTyped(keys, kind) {
      const k = kind || 'entity';
      for (const raw of (keys || [])) {
        const key = String(raw || '').trim();
        if (!key) continue;
        let e = given.get(key);
        if (!e) {
          e = { key, kind: k, docId: null, idx: null, firstSeenTurn: state.turn,
                lastSeenTurn: state.turn, timesShown: 0, surfacedIn: [], status: 'user-typed', pUptake: 0 };
          given.set(key, e);
        }
        e.status = 'user-typed';
        e.lastSeenTurn = state.turn;
        // produced ⇒ strongest given, but still under 1.0 (the slip hedge).
        e.pUptake = 1 - ruleOf('slip');
      }
      return this;
    }

    const givenOf = (key) => given.get(key) || null;
    const addresseeOf = (docId, idx) => band(given.get(spanKey(docId, idx)), ruleOf('uptakeFloor'), ruleOf('uncertainMargin'));
    const addresseeOfKey = (key) => band(given.get(key), ruleOf('uptakeFloor'), ruleOf('uncertainMargin'));

    // ── 2. The Meant-Graph — what the person believes (SEPARATELY) ───────────
    // A belief is attributed ONLY on evidence the person holds it — never because
    // the proposition is in the document. There is no 'from-document' provenance:
    // being in the upload is not reading. The world-flag never deletes the belief
    // (a person believes a wrong thing until corrected, not until the system
    // notices); noticing is a NUL recorded on the node, never a merge into truth.
    const PROVENANCE = new Set(['from-read-span', 'from-system-answer', 'from-retracted-answer', 'from-user-assertion']);
    const WORLD = new Set(['supported', 'unsupported', 'contradicted']);

    function believe(rec) {
      rec = rec || {};
      const proposition = String(rec.proposition || '').trim();
      if (!proposition) return null;
      const provenance = PROVENANCE.has(rec.provenance) ? rec.provenance : 'from-user-assertion';
      const world = WORLD.has(rec.world) ? rec.world : 'unsupported';
      let n = meant.get(proposition);
      if (!n) {
        n = { proposition, world, provenance, bornTurn: state.turn, lastTurn: state.turn, pUptake: 0 };
        meant.set(proposition, n);
      } else {
        n.world = world;                               // the latest graph-check verdict
        n.provenance = provenance;
        n.lastTurn = state.turn;
      }
      // proposing / taking-up IS uptake. from-user-assertion and a taken-up
      // system answer both raise pUptake; the caller only calls believe() on
      // evidence of uptake, so the raise is always licensed.
      n.pUptake = bktLearn(n.pUptake, ruleOf('learn'), ruleOf('slip'));
      return n;
    }

    // retraction — when the system retracts an answer, any belief it PLANTED (a
    // from-system-answer node) is re-flagged from-retracted-answer: the seed the
    // repair chases to root. It exists only for beliefs the person actually took
    // up, so the chase is never spent on a correction the person never absorbed.
    // The belief is NOT deleted — it stands, flagged, until the person is
    // corrected. Returns the re-flagged nodes.
    function reflag(match, newProvenance) {
      const prov = PROVENANCE.has(newProvenance) ? newProvenance : 'from-retracted-answer';
      const test = (typeof match === 'function')
        ? match
        : (n) => n.proposition === String(match || '').trim();
      const hit = [];
      for (const n of meant.values()) {
        if (n.provenance === 'from-system-answer' && test(n)) {
          n.provenance = prov;
          n.lastTurn = state.turn;
          hit.push(n);
        }
      }
      return hit;
    }

    const meantOf = (proposition) => meant.get(String(proposition || '').trim()) || null;
    const meantNodes = () => [...meant.values()];
    // the false beliefs: held, separate, flagged. The half of this spec that
    // survives hardest is the half the unread case makes most necessary.
    const falseBeliefs = () => [...meant.values()].filter(n => n.world === 'contradicted');

    // ── 3. Time — one tick of conversational time ────────────────────────────
    // Decay every pUptake by the medium's γ, once per turn, toward 'offered'
    // (never below). A thing grounded this turn is live; a thing grounded twelve
    // turns ago has cooled back toward a fresh offer. Entries are KEPT (they hold
    // the surfacedIn record — a fact about the rendered answers, not heat dust).
    function decayTurn() {
      const g = gammaOf();
      state.turn += 1;
      for (const e of given.values()) e.pUptake = bktDecay(e.pUptake, g);
      for (const n of meant.values()) n.pUptake = bktDecay(n.pUptake, g);
      return state.turn;
    }

    // ── DI passthrough — one resolution, read off one scale ──────────────────
    // resolveBinding is a CONSUMER of the same chat field, not a competitor; the
    // field delegates so the binding's state and the addressee pUptake agree by
    // construction (both the resolved | ambiguous | absent triple).
    function bindingFor(scope, q, field, opts) {
      if (!resolveBinding) return null;
      try { return resolveBinding(scope, q, field, opts); } catch (e) { return null; }
    }
    const stateFor = (pUptake) => stateOf(pUptake, ruleOf('uptakeFloor'));

    // ── Serialize — rides the chat snapshot, POINTERS only ───────────────────
    function snapshot() {
      const g = [...given.values()].slice().sort((a, b) => (b.pUptake || 0) - (a.pUptake || 0))
        .map(e => ({ key: e.key, kind: e.kind, docId: e.docId, idx: e.idx,
          firstSeenTurn: e.firstSeenTurn, lastSeenTurn: e.lastSeenTurn, timesShown: e.timesShown,
          surfacedIn: e.surfacedIn.slice(), status: e.status,
          pUptake: e.pUptake == null ? null : Math.round(e.pUptake * 1e4) / 1e4 }));
      const m = [...meant.values()].map(n => ({ proposition: n.proposition, world: n.world,
        provenance: n.provenance, bornTurn: n.bornTurn, lastTurn: n.lastTurn,
        pUptake: n.pUptake == null ? null : Math.round(n.pUptake * 1e4) / 1e4 }));
      return { turn: state.turn, given: g, meant: m };
    }
    function restore(snap) {
      reset();
      if (!snap || typeof snap !== 'object') return;
      state.turn = snap.turn | 0;
      for (const e of (snap.given || [])) {
        if (!e || !e.key) continue;
        given.set(e.key, { key: e.key, kind: e.kind || 'span', docId: e.docId || null,
          idx: e.idx == null ? null : (e.idx | 0), firstSeenTurn: e.firstSeenTurn | 0,
          lastSeenTurn: e.lastSeenTurn | 0, timesShown: e.timesShown | 0,
          surfacedIn: Array.isArray(e.surfacedIn) ? e.surfacedIn.slice() : [],
          status: e.status || 'offered', pUptake: e.pUptake == null ? 0 : +e.pUptake });
      }
      for (const n of (snap.meant || [])) {
        if (!n || !n.proposition) continue;
        meant.set(n.proposition, { proposition: n.proposition, world: WORLD.has(n.world) ? n.world : 'unsupported',
          provenance: PROVENANCE.has(n.provenance) ? n.provenance : 'from-user-assertion',
          bornTurn: n.bornTurn | 0, lastTurn: n.lastTurn | 0, pUptake: n.pUptake == null ? 0 : +n.pUptake });
      }
    }
    function reset() { state.turn = 0; given.clear(); meant.clear(); }

    // ── The audit read — THAT, never why ─────────────────────────────────────
    // The shape the host writes as AUD('step','addressee',…): which spans the
    // turn marked given vs. new, which Meant nodes it touched and their
    // world-flag, the pUptake it read. The calibration instrument reads these
    // against outcomes. Glass-box like everything else.
    function auditStep() {
      const floor = ruleOf('uptakeFloor'), margin = ruleOf('uncertainMargin');
      const g = [...given.values()].map(e => ({ key: e.key, kind: e.kind, status: e.status,
        band: band(e, floor, margin), pUptake: e.pUptake == null ? null : Math.round(e.pUptake * 1e4) / 1e4,
        timesShown: e.timesShown }));
      const m = [...meant.values()].map(n => ({ proposition: n.proposition, world: n.world,
        provenance: n.provenance, pUptake: n.pUptake == null ? null : Math.round(n.pUptake * 1e4) / 1e4 }));
      return {
        turn: state.turn,
        given: g.filter(e => e.band === 'grounded'),
        offered: g.filter(e => e.band === 'offered'),
        meant: m,
        falseBeliefs: m.filter(n => n.world === 'contradicted').length,
      };
    }

    return {
      // identity
      get turn() { return state.turn; },
      // Given-Log
      offer, ground, userTyped, givenOf, addresseeOf, addresseeOfKey, spanKey,
      // Meant-Graph (false-belief separated)
      believe, reflag, meantOf, meantNodes, falseBeliefs,
      // time
      decayTurn,
      // DI passthrough + the shared three-state gate
      bindingFor, stateFor,
      // serialize + audit
      snapshot, restore, reset, auditStep,
    };
  }

  return { create, bktLearn, bktDecay, stateOf, band, spanKey, DEFAULTS };
});
