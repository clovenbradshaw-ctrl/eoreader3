/* ============================================================
   tests/roles.test.js — role-referent recovery + two-factor edge weight.

   Cleo's mechanical reader mints graph nodes only for NAMED entities. On a
   text that names characters by role — "the chief clerk", "the charwoman",
   "his sister" (Kafka's Metamorphosis is the motivating case) — those
   characters never become nodes and the relation graph is near-empty. This
   suite pins the recovery pass (promoteRoleReferents / attachEdgeAffinity,
   wired into parseProse) behind the role_referent_recovery rule.

   The contract:
     • Flag OFF (the parity floor): the pass appends nothing, the entity set
       is the named-only baseline (no eo_role nodes), and every edge carries
       weight_detail.affinity === null with weight === weight_detail.cooccur.
       (The byte-identical guarantee itself is pinned by tests/parity.js.)
     • Flag ON, cold embedder (the Node harness has no window.EOEmbed): role
       nodes are recovered from sentence text and bound by co-occurrence;
       role↔named and role↔role edges appear; no throw; affinity stays null
       and weight collapses to the co-occurrence count.
     • Flag ON, warm embedder (a canned stub): attachEdgeAffinity runs and
       weight_detail.affinity becomes a finite cosine; weight = cooccur ×
       affinity (a NUMBER — consumers reading e.weight numerically still work).
     • Association ≠ identity: a recovered role node stays first-class and
       distinct — never merged into a named entity.

   The flag is flipped the way deriveSets re-applies it — via window.EO_RULES
   AND applyRules — so the flip survives the re-derivation parseDocument does
   (the pattern in tests/distance-gravity.test.js / tests/site.test.js).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }

// Flip the master flag durably (survives parseDocument's rule re-derivation).
function enableRoles(W) {
  W.EO_RULES = [{ id: 'role-referent-recovery', installed: true, enabled: true, value: 1 }];
  W.EOEngine.applyRules(W.EO_RULES);
}

/* A small synthetic that names two characters by ROLE and repeats them past
   the mention floor, co-occurring with each other and with named persons. One
   role ("the maid") co-occurs with a NON-hub name ("Clara"), so a role↔named
   edge survives the hub discount; the other ("the chief clerk") co-occurs with
   the protagonist and with the sister-role. */
const SYN = [
  'Gregor woke early and the chief clerk arrived at the door.',
  'The chief clerk spoke sharply to Gregor about his lateness.',
  'Gregor heard his sister crying in the next room.',
  'His sister brought Gregor a bowl of milk and watched him.',
  'Gregor and his sister sat together while the chief clerk waited.',
  'The chief clerk grew angry and Gregor could not answer him.',
  'His sister cleaned the room for Gregor every morning.',
  'Gregor watched as his sister played the violin.',
  'Clara entered the kitchen where the maid was washing dishes.',
  'The maid handed Clara a cup and Clara thanked the maid.',
  'Clara and the maid spoke about the weather every morning.',
  'The maid followed Clara into the parlor with the tea.',
  'Clara asked the maid to draw the curtains.',
].join(' ');

/* A canned embedder: distinct surfaces get distinct one-hot vectors (cosine
   0); a sentence containing a designed token leans toward that token's axis,
   so two sentences that share a designed theme score a positive cosine. Enough
   to make attachEdgeAffinity produce a FINITE affinity (the warm path). */
function stubEmbed() {
  const DIM = 64;
  const vecOf = (s) => {
    const k = String(s == null ? '' : s).toLowerCase();
    const v = new Float32Array(DIM);
    // a shared "scene" axis so co-scene sentences correlate, plus a hash axis
    let h = 0; for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
    v[8 + (Math.abs(h) % (DIM - 8))] = 0.6;
    v[0] = 0.8;            // a common axis ⇒ every pair has some positive cosine
    // normalize
    let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1;
    for (let i = 0; i < DIM; i++) v[i] /= n;
    return v;
  };
  return {
    ready: () => true, warm: () => {},
    embedQuery: async (s) => vecOf(s),
    embedSentences: async (a) => (a || []).map(vecOf),
    MODEL: 'stub',
  };
}

async function main() {
  // ---- 0. the rule ships OFF (the parity floor) ----
  console.log('• role-referent recovery — ships OFF by default (the parity floor)');
  const Wd = loadEngine();
  ok(Wd.EOEngine.roleReferentRecoveryEnabled() === false,
    'role_referent_recovery defaults OFF');

  // ---- 1. flag OFF: named-only baseline, no role nodes, affinity null ----
  console.log('• flag OFF — named-only baseline, no eo_role nodes, affinity null');
  const W0 = loadEngine(); const E0 = W0.EOEngine;
  const d0 = await E0.parseDocument('syn.txt', SYN, 'syn0');
  const snap0 = E0.graphSnapshot(d0);
  const names0 = snap0.entities.map(e => e.name);
  ok(d0._events.every(ev => !ev.eo_role),
    'OFF: no eo_role events are appended');
  ok(!names0.some(n => /sister|clerk|maid/i.test(n)),
    'OFF: no role surfaces become nodes (entities: ' + JSON.stringify(names0) + ')');
  ok(snap0.edges.every(e => e.weight_detail && e.weight_detail.affinity === null),
    'OFF: every edge carries weight_detail.affinity === null (not computed)');
  ok(snap0.edges.every(e => e.weight === e.weight_detail.cooccur),
    'OFF: weight === weight_detail.cooccur (the co-occurrence count, unscaled)');

  // ---- 2. flag ON, cold embedder (Node has no window.EOEmbed) ----
  console.log('• flag ON, cold embedder — role nodes recovered, bound by co-occurrence, no throw');
  const W1 = loadEngine(); const E1 = W1.EOEngine;
  enableRoles(W1);
  ok(E1.roleReferentRecoveryEnabled() === true, 'applyRules + EO_RULES flips the flag ON');
  ok(typeof W1.EOEmbed === 'undefined', 'the Node harness has no embedder (the cold path)');
  let d1, snap1;
  let threw = false;
  try { d1 = await E1.parseDocument('syn.txt', SYN, 'syn1'); snap1 = E1.graphSnapshot(d1); }
  catch (e) { threw = true; console.error(e); }
  ok(!threw, 'parsing with the flag ON and a cold embedder does not throw');
  ok(E1.roleReferentRecoveryEnabled() === true, 'the flag survives parseDocument (EO_RULES re-applied)');

  const names1 = snap1.entities.map(e => e.name);
  ok(names1.some(n => /his sister/i.test(n)), '"his sister" is a node (entities: ' + JSON.stringify(names1) + ')');
  ok(names1.some(n => /the chief clerk/i.test(n)), '"the chief clerk" is a node');
  ok(names1.some(n => /the maid/i.test(n)), '"the maid" is a node');

  // role INS events minted in the rr- namespace, distinct + first-class
  const roleIns = d1._events.filter(ev => ev.op === 'INS' && ev.eo_role);
  ok(roleIns.length >= 3, 'a role INS is appended per recovered surface (' + roleIns.length + ')');
  ok(roleIns.every(ev => String(ev.referent_id || '').startsWith('rr-')),
    'role referent ids live in the rr- namespace (trivially filterable)');
  ok(roleIns.every(ev => ev.basis && Array.isArray(ev.basis.sightings) && ev.basis.sightings.length >= 3),
    'each role INS carries basis.sightings (≥ floor) — its .sents come straight from the basis');

  // association ≠ identity: role nodes stay DISTINCT from the named entities
  ok(d1._events.every(ev => !(ev.op === 'SYN' && ev.eo_role)) &&
     d1._events.filter(ev => ev.eo_role).every(ev => ev.op === 'INS' || ev.op === 'CON'),
    'role recovery only emits INS + CON (association), never a SYN/merge into a name (identity)');
  const grete = snap1.entities.find(e => /gregor/i.test(e.name));
  ok(grete && !/sister|clerk|maid/i.test(grete.name),
    'the named protagonist node is not collapsed into a role node');

  // edges: a role↔named edge (the maid↔Clara, the non-hub pair survives) and
  // a role↔role edge (the chief clerk↔his sister) both appear.
  const roleNamed = snap1.edges.find(e =>
    (/maid/i.test(e.aName) && /clara/i.test(e.bName)) || (/clara/i.test(e.aName) && /maid/i.test(e.bName)));
  ok(!!roleNamed, 'a role↔named edge exists (the maid — Clara): ' +
    JSON.stringify(snap1.edges.map(e => e.aName + '~' + e.bName)));
  const roleRole = snap1.edges.find(e =>
    (/clerk/i.test(e.aName) && /sister/i.test(e.bName)) || (/sister/i.test(e.aName) && /clerk/i.test(e.bName)));
  ok(!!roleRole, 'a role↔role edge exists (the chief clerk — his sister)');
  ok(snap1.edges.some(e => e.verb === 'co-occurs'), 'role edges carry the co-occurs verb');

  // cold path: affinity stays null, weight collapses to the co-occurrence count
  ok(snap1.edges.every(e => e.weight_detail && e.weight_detail.affinity === null),
    'cold embedder: every edge affinity is null');
  ok(snap1.edges.every(e => e.weight === e.weight_detail.cooccur && Number.isInteger(e.weight)),
    'cold embedder: weight === cooccur (an integer count), no embedding scaling');
  ok(snap1.edges.every(e => typeof e.weight === 'number'),
    'weight stays a NUMBER (numeric consumers — auditview/graphaudit/portrait — keep working)');

  // the hub is not bound to everything: Gregor is the protagonist (hub); his
  // sister co-occurs with him in every scene, but the hub discount keeps that
  // pair from dominating. (We assert the degenerate "everything→Gregor" star
  // did NOT form: not every role has an edge to Gregor.)
  const gregKey = grete && grete.key;
  const edgesToGregor = snap1.edges.filter(e => e.a === gregKey || e.b === gregKey);
  ok(edgesToGregor.length < roleIns.length,
    'the hub discount works: not every recovered role is bound to the protagonist (' +
    edgesToGregor.length + ' hub edges < ' + roleIns.length + ' roles)');

  // ---- 3. flag ON, WARM embedder (canned stub) — two-factor weight ----
  console.log('• flag ON, warm embedder — affinity is a finite cosine, weight = cooccur × affinity');
  const W2 = loadEngine(); const E2 = W2.EOEngine;
  W2.EOEmbed = stubEmbed();
  enableRoles(W2);
  const d2 = await E2.parseDocument('syn.txt', SYN, 'syn2');
  // duck-typed, not `instanceof Map`: the Map is minted in the engine's VM
  // realm, so a cross-realm instanceof against the test's own Map fails.
  ok(d2._edgeAffinity && typeof d2._edgeAffinity.get === 'function' && d2._edgeAffinity.size > 0,
    'attachEdgeAffinity populated doc._edgeAffinity from the warm embedder');
  const snap2 = E2.graphSnapshot(d2);
  const withAff = snap2.edges.filter(e => e.weight_detail && typeof e.weight_detail.affinity === 'number');
  ok(withAff.length > 0, 'at least one edge has a finite affinity when the embedder is warm');
  ok(withAff.every(e => isFinite(e.weight_detail.affinity)),
    'warm affinities are finite numbers (a cosine), never NaN/Infinity');
  ok(withAff.every(e => Math.abs(e.weight - e.weight_detail.cooccur * e.weight_detail.affinity) < 1e-9),
    'warm: weight === cooccur × affinity (the two-factor product)');
  ok(snap2.entities.some(e => /his sister|the chief clerk|the maid/i.test(e.name)),
    'warm path still recovers role nodes');

  // ---- 4. pg5200 (Metamorphosis) smoke — the motivating corpus ----
  console.log('• pg5200 (Metamorphosis) — node/edge lift with the flag, baseline without');
  const corpus = path.join(__dirname, '..', 'evo', 'corpus', 'pg5200.txt');
  if (fs.existsSync(corpus)) {
    const text = fs.readFileSync(corpus, 'utf8');
    const Wb = loadEngine(); const Eb = Wb.EOEngine;
    const db = await Eb.parseDocument('pg5200.txt', text, 'mb');
    const sb = Eb.graphSnapshot(db);
    const baseNodes = sb.entities.length, baseEdges = sb.edges.length;
    ok(db._events.every(ev => !ev.eo_role), 'pg5200 OFF: no role events (named-only baseline)');

    const Wr = loadEngine(); const Er = Wr.EOEngine;
    enableRoles(Wr);
    const dr = await Er.parseDocument('pg5200.txt', text, 'mr');
    const sr = Er.graphSnapshot(dr);
    ok(sr.entities.length > baseNodes,
      'pg5200 ON: node count rises (' + baseNodes + ' → ' + sr.entities.length + ')');
    ok(sr.edges.length > baseEdges,
      'pg5200 ON: edge count rises (' + baseEdges + ' → ' + sr.edges.length + ')');
    const roleNames = sr.entities.map(e => e.name);
    ok(roleNames.some(n => /his sister/i.test(n)) && roleNames.some(n => /the chief clerk/i.test(n)),
      'pg5200 ON: "his sister" and "the chief clerk" are recovered as nodes');
    ok(sr.edges.every(e => typeof e.weight === 'number' && e.weight_detail),
      'pg5200 ON: every edge has a numeric weight + weight_detail');
  } else {
    console.log('  (pg5200.txt absent — skipping the corpus smoke)');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
