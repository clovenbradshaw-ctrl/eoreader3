/* ============================================================
   evo/engine-host.js — load a CANDIDATE engine into a VM.

   The evolution loop scores candidate engines that live OUTSIDE the
   repo working tree (in evo/work/<run-id>/sandbox/). This module is the
   single place that knows HOW to load one: it mirrors tests/harness.js
   exactly — pivot.jsx then engine.js into one shared `vm` context whose
   global object carries `window`, `nlp`, `console`, `performance` — but
   takes the engine/pivot paths as arguments so a candidate can be loaded
   without disturbing the real engine.js.

   It also produces the OBSERVE-step trace battery: for a fixture
   document, the full event log, the NUL/stall cluster, the projected
   entities, the SIG (speech-attribution) bindings, and a grounded answer
   + audit. Same surface a read-only observer would consume.

   Nothing here writes to disk or calls the network. Pure load + read.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');

// Resolve compromise from the repo's node_modules regardless of cwd.
function loadNlp() {
  try { return require('compromise'); }
  catch (e) {
    return require(path.join(REPO_ROOT, 'node_modules', 'compromise'));
  }
}

/* Load an engine (+ its pivot) into a fresh VM context and return the
   published `window` (window.EOEngine, window.EOLLM, …). Paths default to
   the repo's own files, so loadEngine() with no args === the baseline. */
function loadEngine(opts = {}) {
  const enginePath = opts.enginePath || path.join(REPO_ROOT, 'engine.js');
  const pivotPath = opts.pivotPath || path.join(REPO_ROOT, 'pivot.jsx');
  const nlp = opts.nlp || loadNlp();

  const sandbox = { window: {}, nlp, console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of [pivotPath, enginePath]) {
    const code = fs.readFileSync(file, 'utf8');
    vm.runInContext(code, sandbox, { filename: path.basename(file) });
  }
  if (!sandbox.window.EOEngine) {
    throw new Error('engine did not publish window.EOEngine (path: ' + enginePath + ')');
  }
  return sandbox.window;
}

/* Normalize a name for comparison: lowercase, strip a leading title and a
   leading article, collapse whitespace, drop possessive. Mirrors the kind
   of normalization the engine does on surfaces, so a label of "Mary" can
   match a SIG speaker of "Princess Mary". */
const TITLES = new Set(['prince', 'princess', 'count', 'countess', 'king', 'queen',
  'lord', 'lady', 'mr', 'mrs', 'miss', 'ms', 'sir', 'dame', 'lieutenant', 'captain',
  'colonel', 'major', 'general', 'admiral', 'emperor', 'empress', 'tsar', 'czar',
  'duke', 'duchess', 'earl', 'baron', 'baroness', 'dr', 'prof', 'professor']);

function normName(s) {
  let t = String(s || '').toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9'’\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(Boolean);
  while (words.length > 1 && (TITLES.has(words[0]) || words[0] === 'the' || words[0] === 'a')) words.shift();
  return words.join(' ');
}

/* Two names refer to the same person if, after normalization, one is a
   token-subset of the other (so "Mary" ↔ "Princess Mary" ↔ "Mary
   Bolkónskaya"). Empty never matches. */
function sameName(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = new Set(na.split(' ')), sb = new Set(nb.split(' '));
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const w of small) if (!big.has(w)) return false;
  return small.size > 0;
}

/* The OBSERVE trace for one document: everything the agent and the
   deterministic scorers read. Async because parseDocument is async. */
async function traceDocument(EOEngine, { name, text, id }) {
  const doc = await EOEngine.parseDocument(name || (id + '.txt'), text, id);
  const events = doc._events || [];

  const proj = (() => { try { return EOEngine.projectEntities(doc); } catch (e) { return { entities: [], nulls: [] }; } })();

  // NUL / stall cluster — pronoun stalls and signal births, with sentence.
  const nulls = events
    .filter(e => e.op === 'NUL')
    .map(e => ({
      seq: e.seq, sentence_idx: e.sentence_idx,
      surface: e.surface || null,
      reason: e.reason || null,
      competing: e.competing || (e.observed && e.observed.competing) || null,
    }));

  // SIG bindings — speech attribution. The `attributed` mode tells us HOW
  // the speaker was earned ('pronoun' = a pronoun resolved to a referent,
  // 'named' = the name was on the page, etc.). This is the observable
  // pronoun→referent binding for dialogue.
  const sigs = events
    .filter(e => e.op === 'SIG')
    .map(e => ({
      seq: e.seq, sentence_idx: e.sentence_idx,
      speaker: e.speaker || null,
      referent_id: (e.speakerHint && e.speakerHint.referent_id) || null,
      attributed: e.attributed || 'none',
      quote: (e.quote || '').slice(0, 80),
    }));

  // DEF gender bindings — a gendered pronoun bound to a person of unknown
  // gender records the gender it taught; another pronoun→referent signal.
  const defs = events
    .filter(e => e.op === 'DEF')
    .map(e => ({ seq: e.seq, sentence_idx: e.sentence_idx, target: e.target, path: e.path, value: e.value, src: e.src }));

  return {
    id, name, text,
    sentenceTexts: doc.sentenceTexts || [],
    events,
    nulls, sigs, defs,
    entities: (proj.entities || []).map(e => ({
      name: e.name, type: e.type, referent_id: e.referent_id,
      mass: e.mass, momentum: e.momentum, surfaceMass: e.surfaceMass, gender: e.gender,
    })),
    counts: events.reduce((m, e) => (m[e.op] = (m[e.op] || 0) + 1, m), {}),
    _doc: doc, // raw doc kept for callers that need answer()/talkerPortrait()
  };
}

/* Probe: ingest a document and ask the engine a question — the agent's
   "inject a sample input and see how it reads" capability. Read-only (runs
   answer() + a short trace); never mutates anything. `text` is capped by the
   caller for token frugality. */
async function probeDocument(EOEngine, { text, query, id = 'probe' }) {
  const doc = await EOEngine.parseDocument(id + '.txt', text, id);
  let answer = null;
  try { const a = EOEngine.answer(doc, query || 'what is this about'); answer = { text: a.text, audit: a.audit, cites: (a.cites || []).length }; }
  catch (e) { answer = { text: null, error: String(e.message || e) }; }
  const events = doc._events || [];
  return {
    answer,
    entities: (() => { try { return (EOEngine.projectEntities(doc).entities || []).slice(0, 8).map(e => e.name + ':' + e.type); } catch (e) { return []; } })(),
    stalls: events.filter(e => e.op === 'NUL' && e.reason && e.reason.startsWith('pronoun-stall'))
      .map(e => 's' + e.sentence_idx + ' "' + (e.surface || '') + '"'),
    counts: events.reduce((m, e) => (m[e.op] = (m[e.op] || 0) + 1, m), {}),
  };
}

module.exports = { loadEngine, traceDocument, probeDocument, normName, sameName, REPO_ROOT };
