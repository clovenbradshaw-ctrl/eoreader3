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
  const SCHEMA = 'cleon-audit/1';
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

  /* Finalize the current turn with the answer it produced. */
  function end(final) {
    if (!enabled || !current) return;
    current.final = clone(final || {});
    current.ms = Math.round(now() - current._t0);
    current.done = true;
    current = null;
    notify();
  }

  function all() { return turns; }
  function count() { return turns.length; }
  function clear() { turns = []; current = null; notify(); }

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
    const name = filename || ('cleon-audit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
    try {
      const blob = new Blob([toJSONL()], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) { return false; }
  }

  window.EOAudit = {
    SCHEMA, isEnabled, setEnabled, begin, step, set, end,
    all, count, clear, subscribe, toJSONL, download, publicTurn,
    // convenience for llm.js — records the model call as an 'llm' step
    llm: (data) => step('llm', data),
  };
})();
