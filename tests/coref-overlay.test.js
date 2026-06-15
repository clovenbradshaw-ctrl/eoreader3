/* ============================================================
   tests/coref-overlay.test.js — coreference overlay (PR2).

   PR1 (role-referent recovery) mints role nodes ("his sister", "the chief
   clerk") and binds them by co-occurrence, but deliberately stops at
   ASSOCIATION: role nodes stay distinct, never merged onto a name. PR2 adds the
   identity layer as a NON-DESTRUCTIVE overlay: for each role node it proposes
   whether it corefers with a named entity — bind / ambiguous / standalone —
   emitted as flag-gated suggestion edges. It NEVER merges a node and never
   deletes the CON backbone.

   The contract:
     • Flag OFF (the parity floor): proposeCoreference appends nothing, no COREF
       event exists, no suggestion edge is drawn, and the graph is byte-identical
       to the role-on baseline. (The whole-engine byte parity is pinned by
       tests/parity.js; here we pin the role-on ⇄ coref-off equivalence.)
     • Flag ON: each role node gets exactly one COREF verdict; gender agreement
       (from the role HEAD, name-anchored) + the possessor/hub exclusion + the
       number veto decide bind/ambiguous/standalone; non-standalone verdicts
       become suggestion edges carrying verdict + confidence.
     • The canonical verdicts (a synthetic Metamorphosis with titled names so the
       referents type as persons): his sister → bind Grete; his mother → bind
       Mrs. Samsa; his father → standalone (Kafka never names him — the possessor
       exclusion leaves it the canonical referent); the lodgers → standalone (the
       plural number veto). On pg5200 itself: his father / his parents standalone,
       and the protagonist (the hub) is NOT captured by the nameless roles.
     • Overlay is purely ADDITIVE: with the flag ON the entity set and the CON
       edges are identical to role-on-only — PR2 introduces ZERO new merges.

   Both flags are flipped the way deriveSets re-applies them — via window.EO_RULES
   AND applyRules — so the flip survives the re-derivation parseDocument does (the
   pattern in tests/roles.test.js).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }

// Flip role recovery only (the PR2 baseline — role nodes, no coref overlay).
function enableRoles(W) {
  W.EO_RULES = [{ id: 'role-referent-recovery', installed: true, enabled: true, value: 1 }];
  W.EOEngine.applyRules(W.EO_RULES);
}
// Flip BOTH role recovery and the coref overlay (PR2 active).
function enableCoref(W) {
  W.EO_RULES = [
    { id: 'role-referent-recovery', installed: true, enabled: true, value: 1 },
    { id: 'coref-overlay', installed: true, enabled: true, value: 1 },
  ];
  W.EOEngine.applyRules(W.EO_RULES);
}

const corefOf = (doc) => (doc._events || []).filter(e => e.op === 'COREF');
const verdictFor = (doc, re) => { const c = corefOf(doc).find(e => re.test(e.role_surface || '')); return c || null; };

/* A synthetic Metamorphosis. The named characters carry TITLES ("Miss Grete",
   "Mrs. Samsa") so the entity reader types them as persons AND learns their
   gender from the title (name-anchored, not a ±-window) — and pronouns are kept
   away from the names so the protagonist hub never steals a "she". Each role is
   repeated past the mention floor and co-occurs with its true referent:
     • his sister  co-occurs with Miss Grete (both female) → bind Grete
     • his mother  co-occurs with Mrs. Samsa (both female) → bind Mrs. Samsa
     • his father  is male, possessor = Gregor (the protagonist) → standalone
     • the lodgers is PLURAL → standalone (the number veto) */
const SYN = [
  'Gregor woke and the chief clerk arrived at the door.',
  'The chief clerk spoke sharply to Gregor about the late hour.',
  'The chief clerk waited and the chief clerk grew impatient with Gregor.',
  'Gregor saw his sister in the next room with Miss Grete present.',
  'His sister brought milk for Gregor while Miss Grete watched.',
  'Gregor and his sister sat together as Miss Grete played the violin.',
  'His sister cleaned the room for Gregor and Miss Grete swept the floor.',
  'Gregor watched his sister and Miss Grete near the window.',
  'His mother prayed for Gregor while Mrs. Samsa wept by the bed.',
  'His mother sat with Gregor as Mrs. Samsa held a cloth.',
  'His mother called for Gregor and Mrs. Samsa answered from the hall.',
  'His mother worried over Gregor while Mrs. Samsa fetched the doctor.',
  'His father shouted at Gregor from the doorway.',
  'His father drove Gregor back and his father raised a stick.',
  'His father grew silent and his father turned away from Gregor.',
  'The lodgers ate at the table and the lodgers complained of the noise.',
  'The lodgers were three men and the lodgers demanded quiet from Gregor.',
  'The lodgers rose and the lodgers gave their notice to leave.',
].join(' ');

async function main() {
  // ---- 0. the overlay ships OFF (the parity floor) ----
  console.log('• coreference overlay — ships OFF by default (the parity floor)');
  const Wd = loadEngine();
  ok(Wd.EOEngine.corefOverlayEnabled() === false, 'coref_overlay defaults OFF');

  // ---- 1. flag OFF (role recovery ON): no COREF events, no suggestion edges,
  //         graph identical to the role-on baseline ----
  console.log('• coref OFF (roles ON) — no COREF events, no suggestion edges, graph == role-on baseline');
  const W0 = loadEngine(); const E0 = W0.EOEngine; enableRoles(W0);
  const d0 = await E0.parseDocument('syn.txt', SYN, 'syn0');
  const snap0 = E0.graphSnapshot(d0);
  ok(corefOf(d0).length === 0, 'OFF: no COREF events are appended');
  ok(d0._events.every(ev => ev.op !== 'COREF' && ev.src !== 'coref-overlay'), 'OFF: nothing carries src:coref-overlay');
  ok(snap0.edges.every(e => !e.suggestion), 'OFF: no suggestion edge is drawn');

  // ---- 2. flag ON: each role gets exactly one COREF verdict ----
  console.log('• coref ON — one verdict per role node; no throw');
  const W1 = loadEngine(); const E1 = W1.EOEngine; enableCoref(W1);
  ok(E1.corefOverlayEnabled() === true, 'applyRules + EO_RULES flips coref_overlay ON');
  let d1, snap1, threw = false;
  try { d1 = await E1.parseDocument('syn.txt', SYN, 'syn1'); snap1 = E1.graphSnapshot(d1); }
  catch (e) { threw = true; console.error(e); }
  ok(!threw, 'parsing with the overlay ON does not throw');
  ok(E1.corefOverlayEnabled() === true, 'the flag survives parseDocument (EO_RULES re-applied)');

  const roleIns1 = d1._events.filter(ev => ev.op === 'INS' && ev.eo_role);
  const coref1 = corefOf(d1);
  ok(coref1.length === roleIns1.length && coref1.length > 0,
    'one COREF verdict per role node (' + coref1.length + ' verdicts / ' + roleIns1.length + ' roles)');
  ok(coref1.every(c => ['bind', 'ambiguous', 'standalone'].includes(c.verdict)),
    'every verdict is bind / ambiguous / standalone');
  ok(coref1.every(c => c.eo_role === true && c.src === 'coref-overlay' && String(c.role_ref || '').startsWith('rr-')),
    'COREF events are tagged eo_role + src:coref-overlay and reference a role (rr-) id');

  // ---- 3. the canonical verdicts ----
  console.log('• canonical verdicts — sister→bind Grete, mother→bind Mrs. Samsa, father→standalone, lodgers→standalone (plural)');
  const sister = verdictFor(d1, /his sister/i);
  ok(sister && sister.verdict === 'bind', 'his sister → bind (verdict: ' + (sister && sister.verdict) + ')');
  ok(sister && sister.basis && sister.basis.gender === 'f', 'his sister is gendered f from the head (name-anchored)');
  ok(sister && (sister.candidates || []).some(c => /grete/i.test(c.name)),
    'his sister binds to Grete (candidates: ' + JSON.stringify((sister && sister.candidates || []).map(c => c.name)) + ')');

  const mother = verdictFor(d1, /his mother/i);
  ok(mother && mother.verdict === 'bind', 'his mother → bind');
  ok(mother && (mother.candidates || []).some(c => /samsa/i.test(c.name)),
    'his mother binds to Mrs. Samsa (candidates: ' + JSON.stringify((mother && mother.candidates || []).map(c => c.name)) + ')');

  const father = verdictFor(d1, /his father/i);
  ok(father && father.verdict === 'standalone',
    'his father → standalone (the possessor exclusion: a role is not its own possessor — verdict: ' + (father && father.verdict) + ')');
  ok(father && father.basis && father.basis.gender === 'm', 'his father is gendered m from the head');

  const lodgers = verdictFor(d1, /the lodgers/i);
  ok(lodgers && lodgers.verdict === 'standalone', 'the lodgers → standalone');
  ok(lodgers && lodgers.basis && lodgers.basis.number === 'plural',
    'the lodgers is detected PLURAL (the number veto: a plural role cannot be a single named person)');
  ok(lodgers && (lodgers.candidates || []).length === 0, 'the lodgers has no candidate (number veto removed them)');

  // ---- 4. suggestion edges carry verdict + confidence; standalone draws none ----
  console.log('• suggestion edges — non-standalone verdicts only, carrying verdict + confidence');
  const sugg1 = snap1.edges.filter(e => e.suggestion);
  ok(sugg1.length > 0, 'suggestion edges are drawn when the overlay is on (' + sugg1.length + ')');
  ok(sugg1.every(e => typeof e.confidence === 'number' && ['bind', 'ambiguous'].includes(e.verdict)),
    'every suggestion edge carries a numeric confidence and a bind/ambiguous verdict');
  ok(sugg1.every(e => /^≈ /.test(e.verb || '')), 'suggestion edges use the "≈ <verdict>" verb');
  const sisterEdge = sugg1.find(e => /his sister/i.test(e.aName) && /grete/i.test(e.bName));
  ok(!!sisterEdge, 'a "his sister ≈ bind Grete" suggestion edge exists');
  ok(!sugg1.some(e => e.verdict === 'standalone'), 'no standalone verdict produces a suggestion edge');
  // the standalone roles (father, lodgers) draw NO suggestion edge
  ok(!sugg1.some(e => /his father|the lodgers/i.test(e.aName)),
    'his father / the lodgers (standalone) draw no suggestion edge');

  // ---- 5. PURELY ADDITIVE — zero new merges, CON edges unchanged ----
  console.log('• overlay is additive — entity set + CON edges identical to role-on, ZERO new merges');
  const Wr = loadEngine(); const Er = Wr.EOEngine; enableRoles(Wr);
  const dr = await Er.parseDocument('syn.txt', SYN, 'synR');
  const snapR = Er.graphSnapshot(dr);
  const keysR = snapR.entities.map(e => e.key).sort();
  const keysC = snap1.entities.map(e => e.key).sort();
  ok(JSON.stringify(keysR) === JSON.stringify(keysC),
    'entity set identical role-on vs coref-on (no node merged/added/dropped): ' + keysR.length + ' vs ' + keysC.length);
  // CON (relation) edges — the non-suggestion edges — are byte-equal
  const conR = JSON.stringify(snapR.edges.filter(e => !e.suggestion).map(e => [e.a, e.b, e.verb, e.weight]));
  const conC = JSON.stringify(snap1.edges.filter(e => !e.suggestion).map(e => [e.a, e.b, e.verb, e.weight]));
  ok(conR === conC, 'the CON/relation edges are identical (the overlay only ADDS suggestion edges)');
  ok(d1._events.every(ev => !(ev.op === 'SYN' && ev.src === 'coref-overlay')),
    'the overlay never emits a SYN/merge (association ≠ identity, preserved)');

  // ---- 6. pg5200 (Metamorphosis) — the motivating corpus ----
  console.log('• pg5200 (Metamorphosis) — robust verdicts + the hub is not captured');
  const corpus = path.join(__dirname, '..', 'evo', 'corpus', 'pg5200.txt');
  if (fs.existsSync(corpus)) {
    const text = fs.readFileSync(corpus, 'utf8');
    const Wp = loadEngine(); const Ep = Wp.EOEngine; enableCoref(Wp);
    const dp = await Ep.parseDocument('pg5200.txt', text, 'mp');
    const snapP = Ep.graphSnapshot(dp);

    const fatherP = verdictFor(dp, /his father/i);
    ok(fatherP && fatherP.verdict === 'standalone',
      'pg5200: his father → standalone (Kafka never names him — the faithful terminal verdict)');
    const parentsP = verdictFor(dp, /his parents/i);
    ok(parentsP && parentsP.verdict === 'standalone' && parentsP.basis.number === 'plural',
      'pg5200: his parents → standalone via the plural number veto');

    // The hub (Gregor Samsa, the protagonist) is the maximal-cooccurrence party;
    // the exclusion weight must keep the nameless roles from being captured by it.
    const entsP = Ep.projectEntities(dp).entities;
    const hub = entsP.filter(e => e.type === 'person' && !String(e.referent_id || '').startsWith('rr-'))
      .sort((a, b) => (b.raw || 0) - (a.raw || 0))[0];
    const boundToHub = corefOf(dp).filter(c => c.verdict !== 'standalone' &&
      (c.candidates || []).some(x => hub && x.referent_id === hub.referent_id));
    ok(boundToHub.length === 0,
      'pg5200: no role is bound to the protagonist hub (' + (hub && hub.name) + ') — the exclusion weight works');

    // additive on the real corpus too: entity set identical to role-on-only
    const Wrp = loadEngine(); const Erp = Wrp.EOEngine; enableRoles(Wrp);
    const drp = await Erp.parseDocument('pg5200.txt', text, 'mrp');
    const kR = Erp.projectEntities(drp).entities.map(e => e.key).sort();
    const kC = entsP.map(e => e.key).sort();
    ok(JSON.stringify(kR) === JSON.stringify(kC),
      'pg5200: entity set identical role-on vs coref-on (' + kR.length + ' vs ' + kC.length + ') — ZERO new merges');
    ok(snapP.edges.some(e => e.suggestion), 'pg5200: at least one suggestion edge is drawn with the overlay on');
  } else {
    console.log('  (pg5200.txt absent — skipping the corpus checks)');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
