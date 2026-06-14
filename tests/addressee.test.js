/* ============================================================
   tests/addressee.test.js — the second person: the addressee field.

   The essay: "the reader already refuses to claim the world — it holds a span and
   measures its faithfulness to it; the addressee field is the same refusal turned
   toward the person." This pins the data structure that makes that possible — a
   common-ground overlay that is false-belief-separated, provenance-tracked, and
   uptake-traced for confidence — and the parity floor (every addressee_* rule
   ships OFF ⇒ nothing is consumed ⇒ the golden snapshots are byte-identical).

   The governing assumption under test: the document is UNREAD until proven
   otherwise. Uploading is not reading; display is an offer, only uptake grounds;
   every uncertain case resolves to 'new'. The single most important property is
   the false-belief separation — Sally's marble and the actual marble are
   different nodes — so a contradicted belief is held, separate, flagged, and
   never merges into the world-model.

   Pure and dependency-injected: the module is required directly (no engine, no
   embedder, no WebGPU) with FAKE γ and resolveBinding. A small engine-harness
   section pins that the addressee_* rules exist, ship off, and carry the seeds.

   Run with `node tests/addressee.test.js`.
   ============================================================ */
'use strict';
const A = require('../addressee');
const { loadEngine } = require('./harness');

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function near(a, b, msg, eps) { ok(Math.abs(a - b) <= (eps || 1e-4), `${msg} (got ${JSON.stringify(a)}, want ≈${b})`); }
function group(name) { console.log('• ' + name); }

// A field with the seed constants, fakes injected for the two dependencies.
const SEED = { gamma: 0.7, learn: 0.6, slip: 0.05, uptakeFloor: 0.55, uncertainMargin: 0.20 };
const mk = (over) => A.create(Object.assign({}, SEED, over));

/* ── the pure BKT helpers — uptake tracing, null ≠ 0 ≠ high ──────────────── */
group('bktLearn — one uptake raises, hedged (< 1), capped by the slip floor');
{
  near(A.bktLearn(0, 0.6, 0.05), 0.6, 'first uptake from 0 (offered) → learn step = 0.6');
  ok(A.bktLearn(0, 0.6, 0.05) >= SEED.uptakeFloor, 'a single uptake clears the floor — one uptake grounds (barely)');
  near(A.bktLearn(null, 0.6, 0.05), 0.6, 'null (never offered) is treated as 0 for the raise, not skipped');
  near(A.bktLearn(0.6, 0.6, 0.05), 0.84, 'a second uptake compounds (0.6 + 0.4·0.6)');
  ok(A.bktLearn(0.99, 0.6, 0.05) <= 0.95 + 1e-9, 'never certain — capped under 1.0 by the slip floor (1 − 0.05)');
}

group('bktDecay — toward OFFERED (0), never below; null stays null (not 0)');
{
  near(A.bktDecay(0.84, 0.7), 0.588, 'decays by γ once per turn');
  eq(A.bktDecay(null, 0.7), null, 'null ("never offered") stays null — NOT decayed to 0');
  eq(A.bktDecay(0, 0.7), 0, 'offered (0) stays at 0 — the resting floor');
  eq(A.bktDecay(1e-5, 0.7), 0, 'a cooled-to-dust value settles exactly to 0 (offered), never negative');
}

group('the three-state gate — null ≠ 0 ≠ high (the resolveBinding triple)');
{
  eq(A.stateOf(null, 0.55), 'absent', 'null → absent (never offered → introduce fresh)');
  eq(A.stateOf(0, 0.55), 'ambiguous', 'offered, no uptake (0) → ambiguous (re-state lightly) — NOT absent');
  eq(A.stateOf(0.3, 0.55), 'ambiguous', 'offered / cooled below the floor → ambiguous');
  eq(A.stateOf(0.6, 0.55), 'resolved', 'grounded & live (≥ floor) → resolved (reference as shared)');
}

/* ── the governing assumption: unread until proven otherwise ─────────────── */
group('everything starts NEW — the document is unread until the exchange grounds it');
{
  const f = mk();
  eq(f.addresseeOf('voss', 7), 'new', 'a span never shown is new (the resting default for the whole document)');
  eq(f.givenOf('voss:7'), null, 'no Given entry exists for an unshown span — the upload is irrelevant to the object');
}

group('offer is an OFFER, not a grounding — display warms a pending offer, uptake settles it');
{
  const f = mk();
  f.offer([{ docId: 'voss', idx: 7 }], 'm1');
  const e = f.givenOf('voss:7');
  eq(e.status, 'offered', 'a cited span enters OFFERED — we do not know the person read it');
  eq(e.pUptake, 0, 'an offered span sits at pUptake 0 — shown, but no uptake yet (NOT shared)');
  eq(f.addresseeOf('voss', 7), 'offered', 'render reads it offered — re-state lightly, never "as you know"');
  ok(e.surfacedIn.includes('m1'), 'the entry records the rendered answer it actually appeared in');
  eq(e.timesShown, 1, 'timesShown counts the offer');
  // re-offering does not promote
  f.offer([{ docId: 'voss', idx: 7 }], 'm3');
  eq(f.givenOf('voss:7').status, 'offered', 're-offering a span the person ignored keeps it OFFERED, never shared');
  eq(f.givenOf('voss:7').timesShown, 2, 'the second offer is counted');
}

group('grounded is earned by UPTAKE, not by display (Clark) — and only what was offered can ground');
{
  const f = mk();
  eq(f.ground('voss:7'), null, 'a span never offered cannot be grounded — there is no display to take up');
  f.offer([{ docId: 'voss', idx: 7 }], 'm1');
  const e = f.ground('voss:7', { msgId: 'm2' });
  eq(e.status, 'grounded', 'an offered span the person took up is promoted to GROUNDED');
  ok(e.pUptake >= SEED.uptakeFloor, 'grounding clears the uptake floor — licenses "as we established at [s7]"');
  eq(f.addresseeOf('voss', 7), 'grounded', 'render reads it grounded — the only state that earns the reference');
}

group('user-typed grounds immediately — what the person produced, they produced');
{
  const f = mk();
  f.userTyped(['Marlow'], 'entity');
  const e = f.givenOf('Marlow');
  eq(e.status, 'user-typed', 'an entity the person typed enters user-typed (producing IS uptake)');
  near(e.pUptake, 1 - SEED.slip, 'the strongest given — but still under 1.0 (the slip hedge: a best guess, never a claim)');
  eq(f.addresseeOfKey('Marlow'), 'grounded', 'the person\'s own token reads grounded — one of the two cases that license "move on"');
}

/* ── the half that survives hardest: the Meant-Graph, false-belief separated ── */
group('the Meant-Graph — a belief the page does not support lives HERE, separate, flagged');
{
  const f = mk();
  // "Frank is a speaker" with the page holding no speaker slot for Frank.
  const n = f.believe({ proposition: 'Frank is a speaker', world: 'contradicted', provenance: 'from-user-assertion' });
  eq(n.world, 'contradicted', 'the contradicted verdict is recorded ON THE NODE (a NUL, not a merge into truth)');
  eq(n.provenance, 'from-user-assertion', 'a proposed proposition is from-user-assertion (proposing IS uptake)');
  ok(n.pUptake > 0, 'proposing raises pUptake — the belief is held');
  // THE false-belief separation: the belief is a node of its OWN, never the
  // world-model's. Sally's marble and the actual marble are different nodes.
  eq(f.meantOf('Frank is a speaker'), n, 'the belief is retrievable as the person\'s, distinct from any document node');
  ok(f.falseBeliefs().some(x => x.proposition === 'Frank is a speaker'), 'a contradicted belief is a FALSE belief — held, separate, flagged');
  // the world-flag never deletes the belief: a person believes a wrong thing
  // until corrected, not until the system notices.
  f.believe({ proposition: 'Frank is a speaker', world: 'contradicted', provenance: 'from-user-assertion' });
  ok(f.meantOf('Frank is a speaker') != null, 'noticing the contradiction does not delete the belief — it stands until correction');
  // there is NO from-document provenance — being in the upload is not reading.
  const r = f.believe({ proposition: 'X', world: 'supported', provenance: 'from-document' });
  ok(r.provenance !== 'from-document', 'from-document is rejected — there is no "in the PDF ⇒ the person believes it"');
}

group('retraction re-flags the planted belief to root — and never deletes it');
{
  const f = mk();
  // a settled answer the person took up planted a belief.
  f.believe({ proposition: 'the keeper rowed the boat', world: 'supported', provenance: 'from-system-answer' });
  // … later a graph-check retracts that answer. The seed the repair chases.
  const hit = f.reflag('the keeper rowed the boat', 'from-retracted-answer');
  eq(hit.length, 1, 'the planted from-system-answer belief is found and re-flagged');
  eq(f.meantOf('the keeper rowed the boat').provenance, 'from-retracted-answer', 'provenance becomes from-retracted-answer — the dangerous one');
  ok(f.meantOf('the keeper rowed the boat') != null, 'the belief is NOT deleted — it stands, flagged, until the person is corrected');
  // a from-user-assertion belief is NOT touched by a system retraction.
  f.believe({ proposition: 'their own idea', world: 'unsupported', provenance: 'from-user-assertion' });
  eq(f.reflag('their own idea', 'from-retracted-answer').length, 0, 'a retraction only chases beliefs the SYSTEM planted, not the person\'s own');
}

/* ── decay: working memory cools toward a fresh offer ────────────────────── */
group('decayTurn — grounded this turn is live; grounded many turns ago cools to a fresh offer');
{
  const f = mk();
  f.offer([{ docId: 'voss', idx: 3 }], 'm1');
  f.ground('voss:3');                                  // pUptake = 0.6 (grounded & live)
  eq(f.addresseeOf('voss', 3), 'grounded', 'the turn it is grounded, it is live (referenceable)');
  f.decayTurn();                                       // 0.42 — within the hysteresis margin
  eq(f.addresseeOf('voss', 3), 'grounded', 'one turn later it holds the reference license across the margin');
  f.decayTurn();                                       // 0.294 — cooled past floor − margin
  eq(f.addresseeOf('voss', 3), 'offered', 'cooled far enough, it falls back to OFFERED (re-state lightly), never to new');
  ok(f.givenOf('voss:3') != null, 'the entry survives decay — it holds the surfacedIn record, not heat dust');
  // an offered (un-grounded) span just stays offered as it cools — never grounded.
  f.offer([{ docId: 'voss', idx: 9 }], 'm2');
  f.decayTurn(); f.decayTurn();
  eq(f.addresseeOf('voss', 9), 'offered', 'an offered span never drifts UP to grounded by mere time');
  eq(f.turn, 4, 'the field tracks conversational time (one tick per decayTurn)');
}

/* ── serialize: rides the chat snapshot, pointers only ──────────────────── */
group('snapshot / restore — chat-scoped, serializable, a faithful round-trip');
{
  const f = mk();
  f.offer([{ docId: 'voss', idx: 1 }], 'm1');
  f.ground('voss:1');
  f.userTyped(['Edith']);
  f.believe({ proposition: 'Edith is on the stairs', world: 'supported', provenance: 'from-read-span' });
  f.decayTurn();
  const snap = f.snapshot();
  ok(Array.isArray(snap.given) && Array.isArray(snap.meant), 'the snapshot is two logs + a turn (pointers only, no text)');
  const g = mk();
  g.restore(snap);
  eq(g.turn, f.turn, 'turn restored');
  eq(g.givenOf('voss:1').status, 'grounded', 'a grounded given survives the round-trip');
  eq(g.givenOf('Edith').status, 'user-typed', 'a user-typed given survives the round-trip');
  eq(g.meantOf('Edith is on the stairs').provenance, 'from-read-span', 'a Meant node survives the round-trip with provenance');
  // reset is a new/switched chat — the field is wiped.
  g.reset();
  eq(g.turn, 0, 'reset wipes the turn');
  eq(g.givenOf('voss:1'), null, 'reset wipes the Given-Log (new/switched chat)');
  eq(g.meantNodes().length, 0, 'reset wipes the Meant-Graph');
}

/* ── dependency injection: γ and resolveBinding passed in, never imported ── */
group('dependency-injected — the decay γ and resolveBinding are passed into create()');
{
  let bindCalls = 0;
  const fakeBinding = (scope, q) => { bindCalls++; return { name: 'Frank', state: 'resolved', confidence: 0.75 }; };
  const f = A.create({ gamma: 0.5, learn: 0.6, slip: 0.05, uptakeFloor: 0.55, uncertainMargin: 0.20, resolveBinding: fakeBinding });
  f.offer([{ docId: 'd', idx: 0 }]); f.ground('d:0');   // 0.6
  f.decayTurn();
  near(f.givenOf('d:0').pUptake, 0.3, 'decay uses the INJECTED γ (0.5), not a hardcoded one');
  const b = f.bindingFor([], 'who is he');
  eq(b && b.name, 'Frank', 'the injected resolveBinding is delegated to — one resolution, read off one scale');
  eq(bindCalls, 1, 'resolveBinding was actually called (it is a consumer of the same chat field, not a competitor)');
  // a γ getter is honored too (a live rule the host can change without rebuilding)
  let gv = 0.9;
  const live = A.create({ gamma: () => gv, learn: 0.6, slip: 0.05, uptakeFloor: 0.55, uncertainMargin: 0.20 });
  live.offer([{ docId: 'd', idx: 0 }]); live.ground('d:0');
  gv = 0.1; live.decayTurn();
  near(live.givenOf('d:0').pUptake, 0.06, 'a γ FUNCTION is re-read each tick — the field tracks a live rule');
}

/* ── the audit read — THAT, never why ───────────────────────────────────── */
group('auditStep — glass-box: which spans are given vs offered, which beliefs and their world-flag');
{
  const f = mk();
  f.offer([{ docId: 'voss', idx: 1 }], 'm1'); f.ground('voss:1');
  f.offer([{ docId: 'voss', idx: 2 }], 'm1');
  f.believe({ proposition: 'p', world: 'contradicted', provenance: 'from-user-assertion' });
  const a = f.auditStep();
  ok(a.given.some(x => x.key === 'voss:1'), 'a grounded span is reported under given');
  ok(a.offered.some(x => x.key === 'voss:2'), 'an offered-only span is reported under offered (not given)');
  eq(a.falseBeliefs, 1, 'the count of contradicted beliefs is surfaced for the calibration instrument');
  ok(a.meant.every(m => !('why' in m)), 'the audit records THAT and the world-flag — never a claim about WHY (the person\'s interior)');
}

/* ── the parity floor — every addressee_* rule ships OFF ─────────────────── */
group('parity floor — the addressee_* rules exist, ship OFF, and carry the seeds');
{
  const E = loadEngine().EOEngine;
  // the masters ship OFF — nothing is consumed, the chat field behaves as today.
  eq(E.addresseeFieldEnabled(), false, 'addressee_field ships OFF (the master parity floor)');
  eq(E.addresseeMeantGraphEnabled(), false, 'addressee_meant_graph ships OFF');
  eq(E.addresseeGivenNewEnabled(), false, 'addressee_given_new ships OFF (waits on calibration)');
  eq(E.addresseeRepairRootEnabled(), false, 'addressee_repair_root ships OFF');
  eq(E.addresseeCalibrationEnabled(), false, 'addressee_calibration ships OFF');
  // the seeds are bundled for EOAddressee.create() — one source of truth.
  const r = E.addresseeRules();
  eq(r.gamma, 0.7, 'γ is the medium\'s decay_gamma (the chat field\'s own)');
  eq(r.learn, 0.6, 'addressee_learn_rate seed');
  eq(r.slip, 0.05, 'addressee_slip seed');
  eq(r.uptakeFloor, 0.55, 'addressee_uptake_floor seed');
  eq(r.uncertainMargin, 0.20, 'addressee_uncertain_margin seed');
  // flipping the master is observable through the helper (the host\'s gate).
  E.applyRules([{ id: 'addressee-field', enabled: true, value: 1 }]);
  eq(E.addresseeFieldEnabled(), true, 'applyRules flips addressee_field ON (the host\'s wiring gate)');
  E.applyRules([{ id: 'addressee-field', enabled: true, value: 0 }]);
  eq(E.addresseeFieldEnabled(), false, 'and back OFF — the field is opt-in');
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} addressee — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
