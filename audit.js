/* ============================================================
   Audit log — the glass box behind the chat.

   Every chat turn runs the same deterministic pipeline:
     route → (intent) → ground → retrieve → phrase → veto → cite → audit
   This module records that pipeline, step by step, so "auditing mode"
   can show exactly what the chat did and why — and export the whole
   trace as JSONL (one self-contained turn per line) for offline analysis.

   The intelligence is mechanical; the model only phrases. This is the
   instrument that makes that legible: the routing decision, the passages
   actually retrieved, the exact prompt the model saw, its raw output, the
   mechanical veto, and the coverage/grounding it ended on.

   Published as window.EOAudit. Recording is in-memory (a capped ring
   buffer); the durable artifact is the JSONL export. Every call is
   defensive — a recorder failure must never break a chat turn.
   ============================================================ */
(function () {
  'use strict';
  const SCHEMA = 'cleo-audit/1';
  const MAX_TURNS = 300;          // ring buffer; oldest turns drop first

  let turns = [];
  let current = null;             // the in-flight turn (single-threaded: one at a time)
  let enabled = true;
  let seq = 0;
  const listeners = new Set();

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  // Snapshot inputs so the log holds a stable copy, never a live reference that
  // could mutate after the fact. Strings/plain objects only flow through here.
  const clone = (v) => { try { return v == null ? v : JSON.parse(JSON.stringify(v)); } catch (e) { return v; } };

  function notify() { for (const fn of listeners) { try { fn(turns); } catch (e) {} } }

  /* ---- WI-7: the truthfulness instrument (EVA pointed at our own output) ----
     The system approaches complete truthfulness from below. You cannot claim
     approach to a limit you do not measure, so every settled turn carries its
     truthfulness components, computed here from the answer it produced:

       bound    — claims that match a witness span/source (the citations).
       voids    — registered absences ({{void:…}} / {{absent:…}}): the honest
                  "the page does not establish X" move.
       unbound  — assertions kept without a witness (the one dishonest move).
                  Must be 0 (WI-2/WI-3/WI-4); a non-zero value is the dominant
                  truthfulness term and should never appear.
       coverage — bound / (bound + relevant voids), rising toward 1; falls back
                  to the existing `covers` query-coverage fraction when present.

     Pure and total: any malformed input yields zeros, never a throw. */
  function _parseFrac(s) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(s == null ? '' : s));
    if (!m) return null;
    const d = +m[2];
    return d ? +m[1] / d : null;
  }
  function countVoids(text) {
    const t = String(text == null ? '' : text);
    return (t.match(/\{\{(?:void|absent):/g) || []).length;
  }

  /* ---- WI-7 (extended): the witness DEGREE, per sentence ----
     A stamp that says verified / not-verified is still arithmetic, just
     relocated; to leave the floor the stamp has to carry DEGREE. This measures,
     on the talker's OWN settled prose, the fraction of each sentence's content
     tokens that are witnessed — not a literal-presence count, but how much of
     what the talker said is backed by a span.

     It reads only the marked text (so the instrument stays pure and engine-free):
       • a sentence that bound to a span (carries a {{cite}}/{{infer}} marker)
         witnesses its bare content tokens;
       • a {{void:…}} strikes one content token the page could not carry, and an
         {{absent:…}} is one thing the page could not establish — both count
         against the sentence but for it (the void is honest, not witnessed);
       • a sentence that bound to NOTHING witnesses none of its content.
     degree = witnessed / (witnessed + unwitnessed) ∈ [0,1]; the turn degree is
     the content-weighted mean over sentences. Any standing void or unbound
     sentence holds it strictly below 1 — the asymptote is approached, never
     reached, never silently dropped. Pure and total: malformed input ⇒ null. */
  const WITNESS_STOP = new Set(('a an the and or but if then else for of to in on at by with from into over under is are '
    + 'was were be been being am do does did doing have has had having will would shall should can could may might must '
    + 'not no nor so than too very just only also this that these those it its he she they them his her their there here '
    + 'who whom which what when where why how as up out off down about above below i we you us me my your our said say says '
    + 'he\'s she\'s it\'s they\'re we\'re you\'re what\'s here\'s there\'s').split(/\s+/));
  function witnessOnProse(text) {
    const T = String(text == null ? '' : text);
    // Sentinels for the three marker kinds — punctuation-free, content-free
    // control codes (built here so no literal control char sits in the source),
    // substituted BEFORE the sentence split so neither a marker's payload nor an
    // absent-message's own periods can break the split.
    const V = String.fromCharCode(1);   // a struck {{void:…}} token
    const C = String.fromCharCode(2);   // a {{cite}}/{{infer}} binding
    const A = String.fromCharCode(3);   // a {{absent:…}} registered absence
    const neutral = T.replace(/\{\{(cite|infer|void|absent):[^}]*\}\}/g, (m, k) =>
      ' ' + (k === 'void' ? V : k === 'absent' ? A : C) + ' ');
    const frags = neutral.split(/(?<=[.!?])\s+|\n+/);
    const per = [];
    const citesIn = (s) => s.indexOf(C) !== -1;
    const voidsIn = (s) => (s.split(V).length - 1) + (s.split(A).length - 1);
    const attachPrev = (cite, voids) => { if (per.length && (cite || voids)) { const pr = per[per.length - 1]; pr.bound = pr.bound || cite; pr.voids += voids; } };
    for (let f of frags) {
      f = f.trim(); if (!f) continue;
      // A marker that trailed the PREVIOUS sentence past its period lands at the
      // head of this fragment after the split — attach those leading markers
      // backwards, then read this fragment as its own sentence.
      const lead = f.match(/^[\s\u0001\u0002\u0003]+/);
      if (lead) { attachPrev(citesIn(lead[0]), voidsIn(lead[0])); f = f.slice(lead[0].length); }
      const cite = citesIn(f), voids = voidsIn(f);
      const content = (f.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || [])
        .map(w => w.replace(/['’]s$/, ''))
        .filter(w => w.length > 2 && !WITNESS_STOP.has(w));
      if (!content.length) { attachPrev(cite, voids); continue; }   // marker-only / punctuation
      per.push({ bound: cite, content: content.length, voids });
    }
    let wTot = 0, dTot = 0;
    for (const r of per) {
      const denom = r.content + r.voids;
      const wit = r.bound ? r.content : 0;                 // an unbound sentence witnesses none of its content
      r.degree = denom ? Math.round((wit / denom) * 1e4) / 1e4 : null;
      wTot += wit; dTot += denom;
    }
    return { degree: dTot ? Math.round((wTot / dTot) * 1e4) / 1e4 : null, witnessed: wTot, content: dTot, sentences: per };
  }
  function truthfulness(final) {
    final = final || {};
    const audit = final.audit || null;
    const text = final.text || '';
    const cites = Array.isArray(final.cites) ? final.cites : [];
    const voids = countVoids(text);
    const bound = cites.length;
    // An UNBOUND assertion is a document-grounded answer that asserts a binding
    // it did not achieve: grounded === false, a coverage figure present, kept as
    // a 'warn'. Plain chat (status 'plain', no coverage) and honest refusals
    // (status 'error') claim no binding, so they are not unbound.
    const unbound = (audit && audit.grounded === false && audit.status === 'warn' && audit.covers != null) ? 1 : 0;
    // coverage = bound / (bound + relevant voids), rising toward 1 as retrieval
    // fills the gaps the question opened. Falls back to the existing query-
    // coverage `covers` fraction when the turn bound and voided nothing.
    const denom = bound + voids;
    const coverage = denom ? bound / denom
      : (audit && audit.covers ? _parseFrac(audit.covers) : null);
    // The DEGREE (WI-7 extended): witness measured on the talker's own prose,
    // per sentence. This is the quantity the asymptote is actually attached to —
    // degree of witness on what was said, not a literal string match.
    const w = witnessOnProse(text);
    return { covers: (audit && audit.covers) || null, coverage, bound, voids, unbound,
      degree: w.degree, witnessed: w.witnessed, witnessContent: w.content, witness: w.sentences };
  }

  function isEnabled() { return enabled; }
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) current = null;     // stop attaching steps to an in-flight turn
    notify();
    return enabled;
  }

  /* Start a turn. `meta` is the turn header (input, mode, scope, model, …).
     Returns the turn id, or null when recording is paused. */
  function begin(meta) {
    if (!enabled) { current = null; return null; }
    const t = Object.assign(
      { schema: SCHEMA, id: 'turn-' + (++seq), at: new Date().toISOString(), steps: [], done: false },
      clone(meta || {})
    );
    Object.defineProperty(t, '_t0', { value: now(), enumerable: false, writable: true });
    current = t;
    turns.push(t);
    if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
    notify();
    return t.id;
  }

  /* Record one pipeline step on the current turn. `dt` is ms since the turn began. */
  function step(type, data) {
    if (!enabled || !current) return;
    current.steps.push(Object.assign({ t: type, dt: Math.round(now() - current._t0) }, clone(data || {})));
    notify();
  }

  /* Merge late-known fields into the current turn header (e.g. modelReady). */
  function set(patch) {
    if (!enabled || !current) return;
    Object.assign(current, clone(patch || {}));
    notify();
  }

  /* Finalize the current turn with the answer it produced. Every settle path
     funnels through here, so this is where the per-turn truthfulness components
     (WI-7) are attached — uniformly, for grounded, chat, mechanical, residual,
     repair and compute turns alike. */
  function end(final) {
    if (!enabled || !current) return;
    current.final = clone(final || {});
    try { current.final.truth = truthfulness(current.final); } catch (e) {}
    current.ms = Math.round(now() - current._t0);
    current.done = true;
    current = null;
    notify();
  }

  function all() { return turns; }
  function count() { return turns.length; }
  function clear() { turns = []; current = null; notify(); }

  /* Seed the ring buffer from a persisted snapshot (host storage restores it on
     load). Dedupes by id, caps to MAX_TURNS keeping the newest, and bumps the
     sequence past the highest restored id so freshly-begun turns never collide
     with a restored 'turn-N'. Safe to call once on startup. */
  function restore(saved) {
    if (!Array.isArray(saved) || !saved.length) return turns.length;
    const have = new Set(turns.map(t => t && t.id));
    const add = saved.filter(t => t && t.id && !have.has(t.id));
    turns = [...add, ...turns].slice(-MAX_TURNS);
    let max = seq;
    for (const t of turns) { const m = /(\d+)\s*$/.exec(t.id || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
    seq = max;
    notify();
    return turns.length;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* The serializable view of a turn (drops the non-enumerable timing anchor). */
  function publicTurn(t) {
    const o = {};
    for (const k in t) if (Object.prototype.hasOwnProperty.call(t, k)) o[k] = t[k];
    return o;
  }

  /* One JSON object per line — standard JSONL/NDJSON. Each line is a complete,
     independently-parseable turn record. */
  function toJSONL(list) {
    return (list || turns).map(t => JSON.stringify(publicTurn(t))).join('\n');
  }

  function download(filename) {
    const name = filename || ('cleo-audit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
    try {
      const blob = new Blob([toJSONL()], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) { return false; }
  }

  /* One pretty-printed JSON document holding every recorded turn in full —
     routing, retrieval, and (the point of this export) the exact prompt the
     model saw and its raw output on each call. `list` defaults to all turns. */
  function toJSON(list) {
    return JSON.stringify({
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      turns: (list || turns).map(publicTurn),
    }, null, 2);
  }

  function downloadJSON(filename, list) {
    const name = filename || ('cleo-prompts-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    try {
      const blob = new Blob([toJSON(list)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) { return false; }
  }

  window.EOAudit = {
    SCHEMA, isEnabled, setEnabled, begin, step, set, end,
    all, count, clear, restore, subscribe, toJSONL, toJSON, download, downloadJSON, publicTurn,
    truthfulness, countVoids,
    // convenience for llm.js — records the model call as an 'llm' step
    llm: (data) => step('llm', data),
  };
})();
