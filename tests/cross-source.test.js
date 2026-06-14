/* ============================================================
   tests/cross-source.test.js — the cross-source veto (the conflation fix).

   The failure this guards is multi-document: a draft over two sources tagged
   together that ties a subject from one source to a fact that lives only in the
   other. The motivating case — an essay on "Oracle's ethics" written with the
   Larry Ellison article AND a Nashville police-surveillance article in scope —
   produced "Oracle's partnership with the Metro Nashville Police Department to
   deploy fifteen fixed cameras," cited to the surveillance document, in which
   Oracle is named nowhere. Each sentence bound cleanly (the camera words DO live
   on the page it cites); the bridge between the two documents was the model's,
   joined on no page. The within-source vetoes (assertion / kin / relation) each
   read one graph and structurally cannot see it.

   checkCrossSource reads the draft's own graph (each claim → the source it
   binds to) against the sources' entity membership. It needs no embedder; the
   topic is carried across sentences so an anaphor ("the firm") inherits it. The
   whole thing is behind the cross_source rule, OFF by default — the first
   assertion pins that floor.
   ============================================================ */
'use strict';
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }

// Source A — the Oracle / Ellison article. "Oracle" and "Larry Ellison" are its
// entities; "cameras", "Metro Nashville Police Department", "Skydio" never appear.
const ELLISON = `Larry Ellison and Oracle: A Database Empire

Larry Ellison co-founded Oracle in 1977. Oracle grew into one of the largest database companies in the world. Larry Ellison served as the chief executive of Oracle for decades.

Oracle competed fiercely with rivals like Sybase. Larry Ellison built a reputation as an aggressive businessman. Oracle expanded into cloud computing under Larry Ellison.`;

// Source B — the surveillance article. "Metro Nashville Police Department",
// "Skydio" and "cameras" are its matter; "Oracle", "Ellison", "company" and
// "firm" appear nowhere in it (so an "Oracle"/"the firm" subject is foreign).
const MNPD = `Nashville Police Camera Program Draws Scrutiny

The Metro Nashville Police Department deployed fifteen fixed cameras downtown in January. The Metro Nashville Police Department said the cameras improve public safety. Critics called the cameras a violation of the surveillance ordinance.

The cameras are equipped with automated technology. Skydio supplied drones to the Metro Nashville Police Department. The program expanded despite a decline in crime.`;

async function main() {
  const W = loadEngine();
  const E = W.EOEngine;

  // ---- 1. the floor: the rule ships OFF (parity) ----
  console.log('• cross-source — default-off floor');
  ok(E.crossSourceEnabled() === false, 'cross_source ships OFF — the parity floor');

  const ellison = await E.parseDocument('Wikipedia · Larry Ellison.txt', ELLISON, 'ellison');
  const mnpd = await E.parseDocument('Untitled document (1).txt', MNPD, 'mnpd');
  const scope = [ellison, mnpd];

  // the fixtures have to actually mint the entities the veto reasons over
  const ents = (E.projectEntities(ellison).entities || []).map(e => e.name.toLowerCase());
  ok(ents.some(n => n.includes('oracle')), 'fixture sanity: "Oracle" is an entity of source A: ' + JSON.stringify(ents));

  // ---- 2. the conflation flags (literal subject) ----
  console.log('• cross-source — the bridge no page joins');
  const conflate = "Oracle's partnership with the Metro Nashville Police Department to deploy fifteen fixed cameras has been widely criticized.";
  const c1 = E.checkCrossSource(scope, conflate);
  ok(c1.length === 1, 'the conflated claim flags once: ' + JSON.stringify(c1.map(c => c.subject + '→' + c.boundDoc)));
  ok(c1.length && /oracle/i.test(c1[0].subject), 'the flag names Oracle as the misattributed subject');
  ok(c1.length && c1[0].subjectDocId === 'ellison', 'the subject is traced to source A (the Ellison article)');
  ok(c1.length && c1[0].boundDocId === 'mnpd', 'the claim binds to source B (the surveillance doc) — where Oracle never appears');

  // ---- 3. the topic is carried across an anaphor ----
  console.log('• cross-source — "the firm" inherits the carried topic');
  const anaphor = 'Oracle is a major technology company. The firm partnered with the Metro Nashville Police Department to deploy fifteen fixed cameras.';
  const c2 = E.checkCrossSource(scope, anaphor);
  ok(c2.length === 1 && /oracle/i.test(c2[0].subject) && c2[0].boundDocId === 'mnpd',
    'the anaphoric subject "the firm" resolves to Oracle and flags: ' + JSON.stringify(c2.map(c => c.subject + '/' + (c.anaphor ? 'anaphor' : 'named'))));
  ok(c2.length && c2[0].anaphor === true, 'the flag records that the subject came in through the topic carry');

  // ---- 4. no false flags ----
  console.log('• cross-source — the conservative bar (zero false flags)');

  // a faithful two-source draft: each claim's subject lives in the doc it cites
  const faithful = 'The Metro Nashville Police Department deployed fifteen fixed cameras downtown. Oracle is a database company founded by Larry Ellison.';
  ok(E.checkCrossSource(scope, faithful).length === 0,
    'a faithful multi-source draft does NOT flag — each subject lives in the source it cites');

  // a definite reference LOCAL to the cited doc ("the cameras") is read as B's
  // own, not dragged onto the carried Oracle topic
  const local = 'Oracle has been widely criticized over the years. The cameras downtown record everyone who passes by.';
  ok(E.checkCrossSource(scope, local).length === 0,
    '"the cameras" (head noun lives in the cited doc) is local, not the topic — no false flag');

  // a single source can't be crossed — vacuous regardless of the draft
  ok(E.checkCrossSource([mnpd], conflate).length === 0, 'single-source scope is vacuous');
  ok(E.checkCrossSource([ellison], conflate).length === 0, 'single-source scope is vacuous (other doc too)');

  // an entity shared by both sources is not foreign to either
  const SHARED = `Nashville Tech Notes\n\nOracle opened an office in Nashville last year. Oracle hired engineers across Nashville. Oracle now employs hundreds in Nashville.`;
  const shared = await E.parseDocument('Nashville Tech.txt', SHARED, 'shared');
  const cShared = E.checkCrossSource([shared, mnpd], 'Oracle operates in Nashville near the police camera program.');
  ok(cShared.length === 0, 'a claim about an entity present in BOTH sources never flags (Nashville is shared)');

  // the topic seed is honored but only when it is an in-scope entity
  const seeded = E.checkCrossSource(scope, 'The firm partnered with the Metro Nashville Police Department to deploy cameras.', { topic: 'Oracle' });
  ok(seeded.length === 1 && /oracle/i.test(seeded[0].subject),
    'a caller-supplied topic seeds the carry so a lead anaphor flags from the first sentence');

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
