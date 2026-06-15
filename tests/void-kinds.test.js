/* ============================================================
   tests/void-kinds.test.js — the seven types of void.

   One word, "void", was carrying many absences. The amendment splits them:
   VOID is a SITE of nothingness (four terrains + the one fabrication, carried on
   {{void:…}} / {{absent:…}} markers); NUL is an ACT (ambiguous / inference —
   the material is present, so they are NEVER voids).

     terrains   never-set · cleared · elsewhere · impossible   (facts about the site)
     fabrication invented                                       (a term with no site)
     acts        ambiguous · inference                          (NUL — held, not absent)

   The marker grammar is a strict superset: {{void:term}} / {{absent:doc:receipt}}
   still parse as kind 'unspecified' and render byte-identical (the parity floor),
   and {{void:kind:term}} / {{absent:kind:doc:receipt}} carry the typed kind.

   Run with `node tests/void-kinds.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEngine } = require('./harness');

const ROOT = path.resolve(__dirname, '..');
function loadAudit() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'audit.js'), 'utf8'), sandbox, { filename: 'audit.js' });
  return sandbox.window.EOAudit;
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name) { console.log('• ' + name); }

const NDP = require('../tools/predictive/fixtures').NDP;

async function main() {
  const E = loadEngine().EOEngine;
  const A = loadAudit();

  /* ---- Phase 1: the grammar is a strict superset ---- */
  group('grammar — bare markers parse as unspecified and round-trip byte-identical (the parity floor)');
  eq(E.parseVoidMarker('Zorthax').kind, 'unspecified', 'a bare void term is unspecified');
  eq(E.parseVoidMarker('Zorthax').term, 'Zorthax', 'a bare void term keeps its term');
  eq(E.formatVoidMarker('unspecified', 'Zorthax'), '{{void:Zorthax}}', 'an unspecified void formats to the bare legacy marker');
  eq(E.formatVoidMarker('elsewhere', 'Tom Turner'), '{{void:elsewhere:Tom Turner}}', 'a typed void formats with its kind');
  eq(E.parseVoidMarker('elsewhere:Tom Turner').kind, 'elsewhere', 'a typed void parses its kind');
  eq(E.parseVoidMarker('elsewhere:Tom Turner').term, 'Tom Turner', 'a typed void parses its (multi-word) term');
  // a bare term that happens to SPELL a kind word is still unspecified — only a
  // leading "kind:" makes a marker typed, so legacy terms never collide.
  eq(E.parseVoidMarker('cleared').kind, 'unspecified', 'a bare term spelling a kind word stays unspecified');
  eq(E.parseAbsentMarker('voss:no sentence asserts that x').kind, 'unspecified', 'a bare 2-seg absent is unspecified');
  eq(E.parseAbsentMarker('voss:no sentence asserts that x').doc, 'voss', 'a bare 2-seg absent keeps its doc');
  eq(E.parseAbsentMarker('never-set:voss:no line').kind, 'never-set', 'a typed absent parses its kind');
  eq(E.parseAbsentMarker('never-set:voss:no line').doc, 'voss', 'a typed absent parses its doc');
  eq(E.parseAbsentMarker('never-set:voss:no line').receipt, 'no line', 'a typed absent parses its receipt');
  eq(E.parseAbsentMarker('Zorthax').receipt, 'Zorthax', 'a 1-seg legacy absent keeps the whole payload as receipt');
  eq(E.formatAbsentMarker('never-set', 'd1', 'r'), '{{absent:never-set:d1:r}}', 'a typed absent round-trips (kind sits first)');
  eq(E.isVoidKind('elsewhere'), true, 'isVoidKind knows elsewhere');
  eq(E.isVoidKind('ambiguous'), false, 'isVoidKind rejects an ACT (ambiguous is NUL, not a void)');
  eq(E.voidKindIsTerrain('elsewhere'), true, 'elsewhere is a terrain');
  eq(E.voidKindIsTerrain('invented'), false, 'invented is a fabrication, not a terrain');

  /* ---- One fixture per kind ---- */

  // 1) NEVER-SET — prior absence (prāgabhāva): the page never established it. A
  // scanned silence keeps its receipt and is typed never-set.
  group('never-set — a scanned silence keeps its receipt (the document does not say)');
  // the subject (Steven Watts) IS on the page; the CLAIM about him is not — so it
  // is never-set silence (with a receipt), not an absent subject (that is elsewhere).
  const meet = await E.parseDocument('meet.txt', 'Steven Watts addressed the hall. The committee met on Tuesday and adjourned at noon.', 'meet');
  const ns = E.answerConfirm(meet, 'Steven Watts founded the committee.');
  ok(ns && /\{\{absent:never-set:meet:/.test(ns.text), 'a false verb-predicate is attested as never-set silence, with a receipt');
  ok(ns && /never asserts/.test(ns.text), 'never-set renders as "the page never asserts…", not a confabulation');

  // 2) CLEARED — destruction absence (pradhvaṃsābhāva): held, then superseded.
  // The marker carries the history of what was said. (The app wiring lives in
  // maybeRetract; here we pin the marker/parse/audit contract it emits.)
  group('cleared — said earlier, and since superseded (carries a history)');
  const clearedMark = E.formatAbsentMarker('cleared', 'meet', 'an earlier reply asserted X; the page does not support it');
  eq(E.parseAbsentMarker(clearedMark.slice(9, -2)).kind, 'cleared', 'a cleared marker parses its kind');
  ok(A.voidsByKind(clearedMark).cleared === 1, 'the audit tallies a cleared terrain');

  // 3) ELSEWHERE — mutual absence (anyonyābhāva): named here, not in this doc.
  group('elsewhere — a named referent absent from this document');
  const voss = await E.parseDocument('voss.txt', 'The lamp at Voss Point. Edith waited at the head of the stairs.', 'voss');
  const el = E.answer(voss, 'What did Zorthax say?');
  ok(/\{\{void:elsewhere:Zorthax\}\}/.test(el.text), 'an anti-matter referent is typed elsewhere (named, not in this document)');

  // 3b) the cross-source form of elsewhere — a pointer, not a dead end (Phase 4)
  group('elsewhere (cross-source) — not in this document, but source B mentions it');
  const a = await E.parseDocument('a.txt', 'Oracle is a major technology company. Larry Ellison founded it.', 'ellison');
  const b = await E.parseDocument('b.txt', 'The Metro Nashville Police Department deployed fifteen Skydio cameras.', 'mnpd');
  const ptr = E.crossSourceElsewhere([a, b], a, 'what did the Metro Nashville Police Department deploy?');
  ok(ptr && /\{\{void:elsewhere:/.test(ptr.text), 'the cross-source pointer marks the term elsewhere');
  ok(ptr && /not in this document/.test(ptr.text) && /mentions it/.test(ptr.text), 'the pointer names the other source ("…but B mentions it")');
  ok(E.crossSourceElsewhere([a, b], a, 'who founded Oracle') == null, 'no pointer when the question grounds in the primary');

  // 4) IMPOSSIBLE — absolute absence (atyantābhāva): a denied presupposition.
  group('impossible — the question assumes what the page denies');
  const frank = await E.parseDocument('frank.txt', 'Frank Mercer joined the firm in 2009. Frank was never charged with embezzlement; an audit cleared him.', 'frank');
  const imp = E.detectImpossible(frank, 'when did Frank stop embezzling?');
  ok(imp && imp.subject === 'Frank', 'a loaded question whose premise the page denies is detected');
  const impA = E.answer(frank, 'when did Frank stop embezzling?');
  ok(/\{\{absent:impossible:frank:/.test(impA.text), 'an impossible question emits the impossible terrain');
  ok(/denies that premise/.test(impA.text), 'impossible surfaces the failed presupposition');
  ok(E.detectImpossible(frank, 'when did Frank join the firm?') == null, 'an honest question is NOT impossible (the page does not deny it)');
  ok(E.detectImpossible(frank, 'when did Zorthax stop embezzling?') == null, 'an unknown subject is elsewhere, not impossible (the premise can only be DENIED by a page that knows the subject)');

  // 5) AMBIGUOUS — a NUL ACT, not a void: the material is present, the binding is
  // held between two candidates. Never reported as absent.
  group('ambiguous — a held contest (a NUL act), never a void');
  const ndp = await E.parseDocument('NDP.txt', NDP, 'ndp');
  const F = E.conversationField;
  F.reset(); F.decayTurn(); F.deposit({ entities: ['Tom Turner', 'District Management Corporation'] }, 1);
  const amb = E.resolveBinding([ndp], 'what does it do', F, { heatFloor: 0.25 });
  eq(amb.state, 'ambiguous', 'two tied figures → ambiguous (held, not a coin-flip)');
  ok(amb.runnerUp != null, 'an ambiguous hold names both candidates (could be A or B)');
  ok(!('text' in amb) || A.countVoids(amb.text || '') === 0, 'an ambiguous hold is NOT a void marker');
  ok(E.isVoidKind('ambiguous') === false, 'ambiguous is not a void kind — it is the act, not the site');

  // 6) INFERENCE — a NUL ACT, not a void: the endpoints are on the page, the link
  // is not. Marked {{infer}}, never counted as a void.
  group('inference — a withheld/flagged link (a NUL act), never counted as a void');
  const inferred = E.markInferred('A holds here {{cite:d:1:s1}} and B holds here {{cite:d:2:s2}}.', [{ docId: 'd', a: 1, b: 2 }]);
  ok(/\{\{infer:/.test(inferred.text), 'a reader-added link is marked {{infer}} (both endpoints shown)');
  eq(A.countVoids(inferred.text), 0, 'an inference link is an act — countVoids never counts {{infer}}');

  // 7) INVENTED — the fabrication: a term with no site, struck, charged to the
  // system (its own fault), distinct from elsewhere (the user naming an absent thing).
  group('invented — the struck term (a fabrication, system provenance)');
  eq(E.voidInvented('Zorthax met Edith', ['Zorthax']), '{{void:invented:Zorthax}} met Edith', 'voidInvented types the strike as invented');

  /* ---- The seam fix ---- */
  group('the seam — elsewhere and invented no longer share one marker');
  ok(E.parseVoidMarker('elsewhere:Zorthax').kind !== E.parseVoidMarker('invented:Zorthax').kind,
    'the user naming an absent thing (elsewhere) is told apart from the system inventing one (invented)');

  group('the seam — countVoids counts the terrains + the fabrication, unchanged; the acts are not voids');
  const mixed = 'See {{void:elsewhere:X}} and {{void:invented:Y}} and {{absent:never-set:d:r}} and {{infer:d:1+2:s}}.';
  eq(A.countVoids(mixed), 3, 'countVoids counts the two voids + the absent (terrains + fabrication), NOT the {{infer}} act');
  const byKind = A.voidsByKind(mixed);
  eq(byKind.elsewhere, 1, 'voidsByKind tallies elsewhere');
  eq(byKind.invented, 1, 'voidsByKind tallies invented');
  eq(byKind['never-set'], 1, 'voidsByKind tallies never-set');
  ok(byKind.ambiguous == null && byKind.inference == null, 'the acts never appear in the void tally');

  group('the seam — a bare marker still tallies as unspecified (legacy turns read as before)');
  eq(A.countVoids('a {{void:Zorthax}} and {{absent:d1:no line}} here'), 2, 'bare markers still count (parity)');
  eq(A.voidsByKind('a {{void:Zorthax}} here').unspecified, 1, 'a bare void tallies as unspecified');

  const okAll = fail === 0;
  console.log(`\n${okAll ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (!okAll) { console.error('\nFailures:\n' + fails.map(f => ' - ' + f).join('\n')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
