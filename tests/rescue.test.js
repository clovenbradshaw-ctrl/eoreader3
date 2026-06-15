/* ============================================================
   tests/rescue.test.js — the semantic-antimatter rescue + demotion stages.

   The lexical absent-referent gate stays and runs first. Between "lexically
   absent" and "void fired" sits a RESCUE stage that may move a candidate
   anti-matter referent to matter ONLY by producing a witness (a specific
   admitted entity + a typed relation). Between "lexically present" and "matter
   confirmed" sits a symmetric DEMOTION stage that may move a candidate matter
   referent to anti-matter ONLY by a discrete failed check. Neither stage lets a
   continuous score sign the ruling — no cosine is spent here at all.

   One case per built channel, each asserting BOTH the ruling and the presence
   of a witness; one ambiguity case asserting NUL (not a void); one witness-less
   case asserting the void still fires; the demotion (Amos Dresser) fix; and the
   non-negotiable parity invariant — with opts.rescue off, the lexical floor is
   untouched, and even on, the candidate set is only re-ruled, never changed.

   Channel B (description→name) is NOT built: the Phase 0 horizon read
   (docs/horizon-read.md) found its shell EMPTY on this embedder. The rescue path
   never consults an embedder, so a name absent every way stays a void.
   ============================================================ */
'use strict';
const { loadEngine } = require('../evo/engine-host');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }
const setEq = (a, b) => { const x = [...a].sort(), y = [...b].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };

const NDP = `Downtown Nashville Security: Who Pays, Who Profits

Downtown business owners pay an annual assessment to the Nashville Downtown Partnership. The Partnership is meant to fund cleaning, marketing, and security for the district.

The security contract is unusual. It is run through a recently created entity called NDMC PSO LLC — a shell company of the District Management Corporation (the DMC), created by the same person who runs the DMC and who then hires his own firm, NDP, to manage the downtown security operations through it. That person is Tom Turner.

Tom Turner is the president of the Nashville Downtown Partnership. He also chairs the board of the District Management Corporation. Christina Kane, a parking customer, said "it's like nobody cares." David Corman, who leads the rival firm Solaren Risk Management, called the arrangement "Operation Flood the Zone."

The Metro Council will vote on the contract next month. Council member Freddie O'Connell wrote on Twitter that the deal "deserves real scrutiny." Mayor Cooper has not commented.`;

async function main() {
  const E = loadEngine().EOEngine;
  const J = (x) => JSON.stringify(x);
  const ndp = await E.parseDocument('NDP.txt', NDP, 'ndp');

  // There is no embedder in this host — the rescue path must work without one,
  // because it spends no cosine. (If a rescue ever needed the embedder, this
  // whole suite would be impossible to run, which is the structural point.)
  ok(!(loadEngine().EOEmbed), 'the test host attaches no embedder — rescue is cosine-free by construction');

  // ── Channel A — orthographic variant ──────────────────────────────────────
  console.log('• Channel A — an OCR/typo of an admitted surface is rescued with a transform witness');
  const a = E.referents(ndp, 'what did Turnor say', { rescue: true });
  ok(a.matter.includes('Turnor'), 'A: "Turnor" is rescued to matter (≈ "Turner")');
  ok(!a.antimatter.includes('Turnor'), 'A: "Turnor" no longer fires a void');
  const aw = (a.witnesses || []).find(w => w.term === 'Turnor');
  ok(aw && aw.via === 'A', 'A: the rescue is carried on Channel A');
  ok(aw && aw.witness && /Tom Turner/.test(aw.witness.entity), 'A: the witness names the admitted entity (Tom Turner)');
  ok(aw && aw.witness && aw.witness.relation === 'orthographic-variant', 'A: the witness carries a typed relation');
  ok(aw && aw.witness && (aw.witness.transforms || []).some(t => t.from === 'turnor' && t.to === 'turner'), 'A: the witness records the surface transform that maps it');

  // ── Channel C — coref / alias (initialism) ────────────────────────────────
  console.log('• Channel C — an initialism of an admitted multi-word entity is rescued by structure, not cosine');
  const rhaDoc = await E.parseDocument('rha.txt',
    'The Riverside Housing Authority approved the plan. The Riverside Housing Authority will meet next week to confirm it.', 'rha');
  const c = E.referents(rhaDoc, 'what did RHA decide', { rescue: true });
  ok(c.matter.includes('RHA'), 'C: "RHA" is rescued to matter (initials of Riverside Housing Authority)');
  const cw = (c.witnesses || []).find(w => w.term === 'RHA');
  ok(cw && cw.via === 'C', 'C: the rescue is carried on Channel C');
  ok(cw && cw.witness && /Riverside Housing Authority/.test(cw.witness.entity), 'C: the witness names the admitted entity');
  ok(cw && cw.witness && cw.witness.relation === 'initialism', 'C: the witness carries a typed relation (initialism)');

  // ── The witness requirement (Phase 2) ─────────────────────────────────────
  console.log('• every rescue carries a witness, and a witness-less candidate still voids');
  const allRescues = [...(a.witnesses || []), ...(c.witnesses || [])];
  ok(allRescues.length && allRescues.every(w => w.witness && w.witness.entity && w.witness.relation), 'no rescue reaches matter without a witness (entity + relation)');
  const z = E.referents(ndp, 'what did Zorthax say', { rescue: true });
  ok(z.antimatter.includes('Zorthax') && !z.matter.includes('Zorthax'), 'witness-less: "Zorthax" finds no admitted entity, so the void fires');
  ok(!(z.witnesses && z.witnesses.length), 'witness-less: no witness is fabricated for a true void');
  // a name semantically adjacent to the page but orthographically/structurally
  // unrelated to any admitted entity is NOT rescued — the embedder can never
  // sneak a name↔name match (it is never consulted).
  const s = E.referents(ndp, 'what did Sorensen say', { rescue: true });
  ok(s.antimatter.includes('Sorensen'), 'name↔name forbidden: "Sorensen" is not rescued to any admitted name');

  // ── Ambiguity is a NUL act, not a rescue and not a void confusion ──────────
  console.log('• two clearers is ambiguity — a NUL act: the referent stays anti-matter and the ambiguity is logged');
  const ambDoc = await E.parseDocument('amb.txt',
    'The Riverside Housing Authority met on Monday. The Riverside Housing Authority approved funds. The Regional Health Agency objected at once. The Regional Health Agency filed a complaint.', 'amb');
  const amb = E.referents(ambDoc, 'what did RHA decide', { rescue: true });
  ok(amb.antimatter.includes('RHA'), 'ambiguity: "RHA" stays anti-matter (two entities share the initials)');
  ok(!(amb.witnesses || []).some(w => w.term === 'RHA'), 'ambiguity: no witness — the embedder/structure did not adjudicate');
  ok((amb.rescueNotes || []).some(n => n.term === 'RHA' && n.kind === 'ambiguous'), 'ambiguity: the NUL act is logged as ambiguity, not a rescue');

  // ── Demotion (Phase 3) — the Amos Dresser fix ─────────────────────────────
  console.log('• Demotion — a single-cap common-noun substring is demoted; a present proper noun is kept');
  const drDoc = await E.parseDocument('dr.txt',
    'The room held an old dresser by the window. The dresser was oak, and the dresser had a cracked mirror.', 'dr');
  const dOff = E.referents(drDoc, 'what did Amos Dresser say');
  const dOn = E.referents(drDoc, 'what did Amos Dresser say', { rescue: true });
  ok(dOff.matter.includes('Amos Dresser'), 'demotion: lexically, "Amos Dresser" is false matter (rides the furniture word "dresser")');
  ok(dOn.antimatter.includes('Amos Dresser') && !dOn.matter.includes('Amos Dresser'), 'demotion: it is demoted to anti-matter — the void fires correctly');
  ok((dOn.rescueNotes || []).some(n => n.term === 'Amos Dresser' && n.kind === 'demoted'), 'demotion: the demotion is logged');
  // a genuinely present proper noun (capitalized, even single-sighting/unadmitted)
  // must NOT be demoted — false matter drops without raising the false-void rate.
  const corman = E.referents(ndp, 'what did David Corman say', { rescue: true });
  ok(corman.matter.includes('David Corman'), 'demotion safety: "David Corman" (present proper noun) is NOT demoted — no false void');
  // a multi-word capital-bookended admitted name still admits
  const part = E.referents(ndp, 'what did the Nashville Downtown Partnership decide', { rescue: true });
  ok(part.matter.includes('Nashville Downtown Partnership'), 'demotion safety: a multi-word capital-bookended admitted name still admits');

  // ── Parity invariant — the regression floor (non-negotiable) ──────────────
  console.log('• parity — opts.rescue off is the untouched lexical floor; on, the candidate set is only re-ruled');
  const BATTERY = ['what did Tom Turner say', 'what did Zorthax say', 'who is Christina Kane',
    'what did the Nashville Downtown Partnership decide', 'has the mayor commented', 'what did Turnor say'];
  let parityHeld = true, conserved = true;
  for (const q of BATTERY) {
    const off1 = E.referents(ndp, q);
    const off2 = E.referents(ndp, q, { rescue: false });
    if (J(off1) !== J(off2)) parityHeld = false;
    const on = E.referents(ndp, q, { rescue: true });
    // the candidate set (matter ∪ antimatter) is invariant — rescue/demotion
    // only MOVE names across the line, never add or drop a candidate.
    if (!setEq([...off1.matter, ...off1.antimatter], [...on.matter, ...on.antimatter])) conserved = false;
  }
  ok(parityHeld, 'parity: referents(doc,q) === referents(doc,q,{rescue:false}) across the battery');
  ok(conserved, 'parity: the candidate set (matter ∪ antimatter) is conserved when rescue is on — only re-ruled');

  // ── The receipt the audit drawer renders ──────────────────────────────────
  console.log('• the rescue receipt is a rejectable audit line, never silent');
  const r = E.rescueReferent(ndp, 'Turnor', ['Turnor'], { rescue: true });
  const receipt = E.formatRescueReceipt('Turnor', r);
  ok(/treated/.test(receipt) && /resolves to/.test(receipt) && /Tom Turner/.test(receipt), 'receipt: "treated NAME as present; resolves to ENTITY via RELATION"');
  ok(E.formatRescueReceipt('Zorthax', E.rescueReferent(ndp, 'Zorthax', ['Zorthax'], { rescue: true })) === '', 'receipt: a non-rescue produces no receipt (nothing to reject)');

  // ── The master switch — off is the floor; on activates the answer path ─────
  console.log('• the rescue master ships OFF (the parity floor); flipping it on suppresses a rescued referent’s void');
  ok(E.rescueEnabled() === false, 'master: rescue_referent ships OFF — the parity floor');
  const voidOff = E.answer(ndp, 'what did Turnor say');
  ok(/\{\{void/.test(voidOff.text), 'master OFF: the answer fires a void for the absent "Turnor"');
  const prev = E.setRescueEnabled(true);
  ok(prev === false, 'master: the setter reports the previous (off) state');
  try {
    const refsOn = E.referents(ndp, 'what did Turnor say');
    ok(refsOn.matter.includes('Turnor'), 'master ON: referents activates the rescue with no per-call opts (the global default)');
    const voidOn = E.answer(ndp, 'what did Turnor say');
    ok(!/\{\{void:[^}]*[Tt]urnor/.test(voidOn.text), 'master ON: a rescued referent produces no void (SPEC §7)');
  } finally {
    E.setRescueEnabled(false);
  }
  ok(E.rescueEnabled() === false, 'master: restored to OFF after the test — no leak across the suite');
  ok(JSON.stringify(E.referents(ndp, 'what did Turnor say')) === JSON.stringify({ matter: [], antimatter: ['Turnor'] }), 'master: with the master back off, the lexical floor is exactly restored');

  // ── The convention / universal split (what belongs where) ─────────────────
  // Channel A's matcher constants are UNIVERSAL mechanics and live in the
  // constitution (READING_RULES, hardcoded-seed/core). The case→proper signal
  // demotion leans on is a Latin-script CONVENTION sourced to the language
  // module — it must degrade safely where the convention does not hold.
  console.log('• the universal matcher constants live in the constitution and are wired');
  const R = E.rescueRules();
  ok(R.minToken === 4 && R.editMax === 2 && R.initialismMax === 6, 'universal: the three matcher thresholds are the constitutional values (4 / 2 / 6)');
  ok(R.caseConvention && R.caseConvention.rule === 'promote_requires_uppercase_first', 'convention: the case→proper signal is named to its language-module rule, not re-hardcoded');
  // the over-merge guard (rescue_min_token): a 3-char token one edit from an
  // admitted surface token must NOT fuzzy-merge ("Tam" ↛ "Tom"), §9.
  ok(E.referents(ndp, 'what did Tam say', { rescue: true }).antimatter.includes('Tam'), 'universal: the over-merge guard blocks a short (<4) near-miss — "Tam" does not merge to "Tom"');
  // the edit bound (rescue_edit_max): a long token within 2 edits rescues; 3 edits does not.
  const gDoc = await E.parseDocument('g.txt', 'Galadriel Nightingale spoke at dawn. Galadriel Nightingale left at dusk. Everyone admired Galadriel Nightingale.', 'g');
  ok(E.referents(gDoc, 'what did Galadrielx Nightingalx say', { rescue: true }).matter.includes('Galadrielx Nightingalx'), 'universal: a long surface within the edit bound (≤2) is rescued');
  ok(E.referents(gDoc, 'what did Galadrxxxx Nightxxxale say', { rescue: true }).antimatter.includes('Galadrxxxx Nightxxxale'), 'universal: a long surface past the edit bound (>2) is NOT rescued — a different name is not a typo');

  console.log('• the case convention degrades safely — caseless scripts inert, all-caps-noun scripts conservative');
  // a caseless script (Chinese): the referent gate extracts no capitalized span,
  // so rescue AND demotion are wholly inert — no false rescue, no false void.
  const zh = await E.parseDocument('zh.txt', '物理学是研究物质的科学。物理学家做实验。这本书讲物理学的历史。物理学很有趣。', 'zh');
  const zhR = E.referents(zh, '物理学是什么', { rescue: true });
  ok(zhR.matter.length === 0 && zhR.antimatter.length === 0 && !zhR.witnesses, 'convention (caseless): rescue/demotion are inert on a no-case script — no false rescue or void');
  // German-style (every noun capitalized): "Tisch" is a capitalized COMMON noun,
  // so the case signal cannot prove common-vs-proper — demotion conservatively
  // declines (keeps it as matter), never inventing a false void.
  const de = await E.parseDocument('de.txt', 'Der Tisch steht im Zimmer. Der Tisch ist alt. Auf dem Tisch liegt ein Buch.', 'de');
  const deR = E.referents(de, 'was sagte Herr Tisch', { rescue: true });
  ok(deR.matter.includes('Herr Tisch') && !(deR.rescueNotes || []).some(n => n.kind === 'demoted'), 'convention (all-caps noun): a capitalized common noun is NOT demoted — no false void in German');

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
