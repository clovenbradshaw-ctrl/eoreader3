/* ============================================================
   tests/conventions.test.js — the conventions graph (memory/conventions.jsonl).

   Three contracts:
     1. WELL-FORMED — every line parses; ops are eo vocabulary; seq is
        strictly increasing; member-of edges point at declared conventions.
     2. NO DRIFT — projecting the file and loading it into a fresh engine
        reproduces the engine's shipped seeds EXACTLY, for every covered
        convention in every module. The file and the code cannot disagree.
     3. LIVE — loadConventions actually rebuilds the lexical sets (a changed
        inventory is visible in behavior), and a missing/garbled file is
        harmless (fallback to seeds).

   Plus the eleven contracts of PROVENANCE-ANCHORED CONVENTIONS (anchors,
   opacity, independence, seed falsifiability, register weighting, SEG
   splits, the proposal grammar, friction nomination, corroboration paths,
   live-after-admission, drift) and the strict privacy mode.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../evo/engine-host');

const FILE = path.join(__dirname, '..', 'memory', 'conventions.jsonl');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}`); }
function group(name, fn) { console.log('• ' + name); return fn(); }

async function main() {
  const text = fs.readFileSync(FILE, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());

  group('well-formed — an eo-operation log', () => {
    const OPS = new Set(['INS', 'SYN', 'DEF', 'SIG', 'NUL', 'SEG', 'CON', 'EVA', 'REC']);
    let lastSeq = -1, parsed = 0, badOp = 0, badSeq = 0;
    const conventionIds = new Set();
    const danglingEdges = [];
    const records = [];
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch (e) { continue; }
      parsed++;
      records.push(r);
      if (!OPS.has(r.op)) badOp++;
      if (!(r.seq > lastSeq)) badSeq++;
      lastSeq = r.seq;
      if (r.op === 'INS' && r.kind === 'convention') conventionIds.add(r.id);
    }
    for (const r of records) if (r.op === 'SYN' && r.v === 'member-of' && !conventionIds.has(r.o)) danglingEdges.push(r.o);
    eq(parsed, lines.length, 'every line parses as JSON (' + parsed + '/' + lines.length + ')');
    eq(badOp, 0, 'every op is in the nine-operator vocabulary');
    eq(badSeq, 0, 'seq strictly increases (append-only log)');
    eq(danglingEdges.length, 0, 'every member-of edge targets a declared convention' + (danglingEdges.length ? ' (dangling: ' + danglingEdges.slice(0, 3).join(', ') + ')' : ''));
    ok(conventionIds.size >= 60, 'covers a real inventory (' + conventionIds.size + ' conventions)');
  });

  await group('no drift — the file and the seeds agree exactly', async () => {
    const seedE = loadEngine().EOEngine;             // untouched seeds
    const fileE = loadEngine().EOEngine;             // fresh instance
    const res = fileE.loadConventions(text);
    ok(res.records === lines.length, 'loadConventions consumed every record');
    ok(res.applied >= 25, 'applied the en-narrative conventions (' + res.applied + ')');
    ok(res.packApplied >= 40, 'applied the es/zh/code conventions (' + res.packApplied + ')');
    const a = seedE._conventionsExport(), b = fileE._conventionsExport();
    for (const [modId, mod] of Object.entries(a.modules)) {
      for (const [rule, value] of Object.entries(mod.conventions)) {
        eq(b.modules[modId].conventions[rule], value, modId + ':' + rule + ' identical after load');
      }
      eq(b.modules[modId].props, mod.props, modId + ' module props identical');
    }
  });

  await group('live — the graph actually drives the reading', async () => {
    // Append one membership edge (make "Zonk" an article), load, and watch
    // the reading change — the file is load-bearing, not decorative. Then a
    // garbled file is harmless.
    const E = loadEngine().EOEngine;
    const records = text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    // Append ONE membership edge — "zonkmaster" joins the role-title heads —
    // and the naming bridge can suddenly distill a role DEF it could not
    // before. Pure convention→regex→reading; no NER anywhere in the path.
    records.push({ seq: 99990, op: 'SYN', s: 'zonkmaster', v: 'member-of', o: 'en-narrative-v1:role_title_heads' });
    const TXT = 'The Appointment\n\nThe contract was arranged by the same person who is the zonkmaster of the docks. That person is Tom Turner.';
    const roleOf = async (id) => {
      const d = await E.parseDocument(id + '.txt', TXT, id);
      return (E.assertionsOf(d) || []).some(a => a.path === 'role' && /zonkmaster/i.test(a.is));
    };
    const before = await roleOf('s1');
    E.loadConventions(records);
    const after = await roleOf('s2');
    ok(!before && after,
      'an appended member-of edge changes the reading (zonkmaster became a role-title head: role DEF ' + before + ' → ' + after + ')');
    const E2 = loadEngine().EOEngine;
    const junk = E2.loadConventions('not json\n{"op":"INS"\n42\n');
    ok(junk.applied === 0 && junk.packApplied === 0, 'a garbled file applies nothing and never throws (fallback to seeds)');
  });

  await group('hydration — eva failures write conventions (contextual neurons)', async () => {
    const E = loadEngine().EOEngine;
    const doc = await E.parseDocument('h.txt',
      'The Inheritance\n\n"Your uncle\'s estate is smaller," said Calloway. "There are debts," said Calloway. Harriet poured the tea and considered the lawn. Harriet had expected as much.', 'h');
    // a draft that fails ONLY on an invented name, twice (first + retry)
    const badDraft = 'The reading returns to Blorvax most often. The piece holds its weight there. The reading stays close to the page.';
    await E.talkerPortrait(doc, { llm: () => badDraft });
    const delta = E.conventionsDelta();
    ok(delta.length >= 2, 'each veto wrote a REC (' + delta.length + ' records)');
    ok(delta.some(r => r.admitted && r.value.term === 'Blorvax'), 'second sighting admitted the term (a neuron formed)');
    ok(delta.every(r => r.op === 'REC' && r.target === 'core:eva_veto_lexicon'), 'records are conventions-shaped RECs');
    // the neuron has MECHANICAL impact: the veto now catches the term cold
    const eva = E.evaDraft('A fine paragraph about Blorvax and the weather.', { heavy: [], tail: [] }, []);
    ok(eva.reasons.some(r => r === 'learned-veto:Blorvax'), 'evaDraft now vetoes the learned term');
    // and the hydration round-trips through the FILE: a fresh engine fed the
    // base graph + this session\'s delta lines learns the same neuron
    const E2 = loadEngine().EOEngine;
    E2.loadConventions(text + '\n' + E.serializeConventionsDelta());
    const eva2 = E2.evaDraft('More about Blorvax.', { heavy: [], tail: [] }, []);
    ok(eva2.reasons.some(r => r === 'learned-veto:Blorvax'), 'appended REC lines hydrate a fresh engine identically');
  });

  await group('linkage — conventions are linked assertions', async () => {
    const records = text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    const nodeIds = new Set(records.filter(r => r.op === 'INS' && r.id).map(r => r.id));
    const links = records.filter(r => r.op === 'SYN' && r.v !== 'member-of');
    ok(links.length >= 20, 'the linkage layer exists (' + links.length + ' edges)');
    const dangling = links.filter(l => !nodeIds.has(l.s) && !nodeIds.has(l.o) ? true : (!nodeIds.has(l.s) || !nodeIds.has(l.o)));
    eq(dangling.length, 0, 'every linkage edge connects declared nodes');
    ok(records.some(r => r.op === 'INS' && r.kind === 'mechanism'), 'universal mechanisms are nodes the conventions link to');
    ok(records.filter(r => r.op === 'INS' && r.kind === 'convention').every(r => r.epistemic === 'assertion' && r.revisable === true),
      'every convention is marked an assertion: contextual and revisable');
    // the hydration cycle is drawn in the graph itself
    ok(links.some(l => l.s === 'mechanics:eva-veto' && l.o === 'core:eva_veto_lexicon')
      && links.some(l => l.s === 'core:eva_veto_lexicon' && l.o === 'mechanics:eva-veto'),
      'the eva→lexicon→eva hydration cycle is in the graph');
  });

  /* ============================================================
     PROVENANCE-ANCHORED CONVENTIONS + THE CONVENTION PROPOSER
     (the eleven contracts of the provenance plan)
     ============================================================ */

  // Shared fixtures: a municipal document with the MNPD-colon shape (the
  // speaker-pattern friction), neutral prose, and two co-witness documents.
  const DOC_A = 'Council Notes\n\nThe council met on a cold morning to review the deployment program. MNPD: We deployed the unit at the corner of Fifth and Main. The councilwoman asked about the budget for the program. MNPD: The program complies with the consent decree as written. A resident spoke against the expansion of the program. MNPD: The unit will rotate to the river district next month.\n\nThe meeting adjourned without a vote.';
  const DOC_X = 'The Lighthouse\n\nEdith set the kettle down and listened to the wind. The keeper said no one could row to the mainland tonight. Edith poured the tea and waited for morning.';
  const DOC_C = 'Precinct Report\n\nThe precinct released its quarterly numbers on Tuesday. MNPD: Response times fell by nine percent across the river district. The reporter asked for the raw figures.';
  const DOC_D = 'Oversight Hearing\n\nThe board convened at noon for the oversight hearing. MNPD: The audit covers every deployment since January of last year. The chair thanked the auditors for their work.';
  // A well-formed proposal: cites the real engine-minted span ids it was shown.
  const goodProposer = (sys, user) => {
    const ids = (user.match(/†\d+/g) || []).slice(0, 3);
    return 'PROPOSAL\nconvention: A line beginning with an organization acronym followed by a colon and a statement attributes that statement to the organization as a speaking voice.\nregister: municipal meeting records and agency communications\nevidence: ' + ids.join(' ') + '\nresolves: friction 1\n';
  };
  const withFriction = async (E) => {
    await E.parseDocument('a.txt', DOC_A, 'docA');
    await E.parseDocument('x.txt', DOC_X, 'docX');
  };
  const sigOf = (hot) => { const s = new Array(8).fill(0); s[hot] = 127; return s; };

  group('1. anchor-wellformed — anchors parse, couplings registered, no future t', () => {
    const records = lines.map(l => JSON.parse(l));
    const COUPLINGS = new Set([0.6, 1.0, 5.0]);   // llm-proposer / seed+doc-witness / user
    let withProv = 0, badH = 0, badC = 0, futureT = 0;
    for (const r of records) {
      if (!Array.isArray(r.prov)) continue;
      withProv++;
      for (const a of r.prov) {
        if (!(a.h === 'seed' || /^[0-9a-f]{16}$/.test(a.h))) badH++;
        if (!COUPLINGS.has(a.c)) badC++;
        if (a.t != null && a.t > r.seq) futureT++;
      }
    }
    ok(withProv >= 60, 'the shipped conventions carry provenance (' + withProv + ' records with anchors)');
    eq(badH, 0, 'every anchor h is 16 hex or the synthetic seed');
    eq(badC, 0, 'every anchor coupling matches a registered reader');
    eq(futureT, 0, 'no anchor points at a future log position');
  });

  group('2. opacity — a fresh engine weights anchors it can never resolve', () => {
    const E = loadEngine().EOEngine;            // no documents parsed: no hash table
    E.loadConventions(text);
    const report = E.provenanceReport({ doc_sig: sigOf(0) });
    ok(report.length >= 60, 'the provenance store projects without resolving (' + report.length + ' conventions)');
    ok(E.conventionMass('en-narrative-v1:singular_they', { doc_sig: sigOf(0) }) > 0, 'mass computes under a signed frame with zero local resolution');
    eq(E.resolveAnchor('seed'), null, 'off-device an anchor is opaque — resolution returns nothing');
    const some = report.find(r => r.id === 'en-narrative-v1:pronouns');
    ok(some && some.mass > 0, 'a seed convention projects finite mass (' + (some && some.mass) + ')');
  });

  group('3. independence — set arithmetic on h; the model never witnesses itself', () => {
    const E = loadEngine().EOEngine;
    const one = E.anchorMass([{ h: 'aaaa111122223333', c: 1.0, r: 'doc-witness' }]).mass;
    const dup = E.anchorMass([{ h: 'aaaa111122223333', c: 1.0, r: 'doc-witness' }, { h: 'aaaa111122223333', c: 1.0, r: 'doc-witness' }]).mass;
    eq(dup, one, 'a same-h double deposit is one sighting');
    const model = (n) => Array.from({ length: n }, (_, i) => ({ h: ('m' + i).padEnd(16, '0'), c: 0.6, r: 'llm-proposer' }));
    ok(!E.anchorsAdmit(model(3)).admit && !E.anchorsAdmit(model(10)).admit, 'model-only anchors never admit at any count');
    ok(E.anchorsAdmit(model(10)).total <= 0.6 + 1e-9, 'the model is ONE reader: its anchors contribute one coupling to the tally (' + E.anchorsAdmit(model(10)).total + ')');
    const mixed = [...model(1), { h: 'd1'.padEnd(16, '0'), c: 1.0, r: 'doc-witness' }, { h: 'd2'.padEnd(16, '0'), c: 1.0, r: 'doc-witness' }];
    ok(E.anchorsAdmit(mixed).admit, 'model + two independent document witnesses clears θ (' + E.anchorsAdmit(mixed).total + ' ≥ 2.0)');
  });

  group('4. seed-falsifiability — seeds decay below real-provenance competitors', () => {
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    const id = 'en-narrative-v1:singular_they';
    const before = E.conventionMass(id);
    ok(before > 0.9, 'a seed convention starts at its synthetic anchor mass (' + before + ')');
    E.segConvention(id, { against: ['seed'], reason: 'contrary register sighting' });
    E.segConvention(id, { against: ['seed'], reason: 'contrary register sighting' });
    const after = E.conventionMass(id);
    const competitor = E.anchorMass([
      { h: 'doc1aaaa00000000', c: 1.0, r: 'doc-witness' },
      { h: 'user5bbbb0000000', c: 5.0, r: 'user' },
    ]).mass;
    ok(after < before / 10, 'two contrary SEGs decay the seed hard (' + before + ' → ' + after + ')');
    ok(after < competitor, 'an admitted real-provenance competitor outweighs the decayed seed (' + after + ' < ' + competitor + ')');
    E.segConvention(id, { against: ['seed'] });
    ok(E.conventionProvenance(id).dormant, 'a third SEG sends the seed dormant — nothing is unfalsifiable, including the initial conditions');
  });

  group('5. register-weighting — signatures pick the register; per-source cap holds', () => {
    const E = loadEngine().EOEngine;
    // a convention whose sightings cluster in the Conrad register
    const conrad = sigOf(0), nyt = sigOf(1);
    const recLine = JSON.stringify({ seq: 99980, op: 'REC', target: 'en-narrative-v1:singular_they', action: 'sighting', value: {},
      prov: [{ h: 'c1c1c1c1c1c1c1c1', c: 1.0, r: 'doc-witness', sig: conrad, t: 2000 },
             { h: 'c2c2c2c2c2c2c2c2', c: 1.0, r: 'doc-witness', sig: conrad, t: 2001 }] });
    E.loadConventions(text + '\n' + recLine);
    const id = 'en-narrative-v1:singular_they';
    const underConrad = E.conventionMass(id, { doc_sig: conrad, now: 2002 });
    const underNyt = E.conventionMass(id, { doc_sig: nyt, now: 2002 });
    ok(underConrad > underNyt, 'Conrad-signature anchors dominate under a Conrad frame (' + underConrad.toFixed(3) + ' > ' + underNyt.toFixed(3) + ')');
    // per-source cap: one heavy source among five never exceeds 25% of register weight
    const anchors = [
      { h: 'heavy00000000000', c: 10.0, r: 'doc-witness' },
      { h: 'a100000000000000', c: 1.0, r: 'doc-witness' },
      { h: 'a200000000000000', c: 1.0, r: 'doc-witness' },
      { h: 'a300000000000000', c: 1.0, r: 'doc-witness' },
      { h: 'a400000000000000', c: 1.0, r: 'doc-witness' },
    ];
    const am = E.anchorMass(anchors);
    ok(am.capped, 'the cap engaged on a dominating source');
    ok(Math.abs(am.mass - 4 / 0.75) < 1e-6, 'no single source contributes more than 25% of register weight (mass ' + am.mass.toFixed(3) + ' = others/0.75)');
  });

  group('6. split-by-SEG — contrary sightings split a convention into register variants', () => {
    const E = loadEngine().EOEngine;
    const mk = (h, sig) => ({ h: h.padEnd(16, '0'), c: 1.0, r: 'doc-witness', sig });
    const insLine = JSON.stringify({ seq: 99981, op: 'INS', kind: 'convention', id: 'test:halfsplit', rule: null, module: 'core',
      epistemic: 'assertion', revisable: true,
      prov: [mk('aa1', sigOf(0)), mk('aa2', sigOf(0)), mk('bb1', sigOf(1)), mk('bb2', sigOf(1))] });
    E.loadConventions(text + '\n' + insLine);
    eq(E.conventionVariants('test:halfsplit').length, 1, 'an uncontested convention projects one variant');
    E.segConvention('test:halfsplit', { against: ['bb1'.padEnd(16, '0'), 'bb2'.padEnd(16, '0')], reason: 'wrong in this register' });
    const variants = E.conventionVariants('test:halfsplit');
    eq(variants.length, 2, 'a SEG against half the anchors yields two register variants');
    ok(variants[0].mass > variants[1].mass, 'the surviving register outweighs the contested one (' + variants[0].mass + ' > ' + variants[1].mass + ')');
    ok(variants[0].centroid && variants[1].centroid && variants[0].centroid[0] > variants[1].centroid[0],
      'the variants separate by signature cluster');
  });

  await group('7. proposal-grammar — out-of-grammar replies die and deposit; well-formed lands as a signal', async () => {
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    await withFriction(E);
    const reply = (sys, user) => {
      const ids = (user.match(/†\d+/g) || []).slice(0, 3);
      return [
        'PROPOSAL\nconvention: A colon after a label opens speech.\nregister: transcripts\nevidence: †999\nresolves: friction 1',
        'PROPOSAL\nconvention: A colon after a label opens speech.\nregister: transcripts\nevidence: ' + ids[0],
        'PROPOSAL\nconvention: The agency Zorblatt speaks through colon lines in these documents.\nregister: transcripts\nevidence: ' + ids.join(' ') + '\nresolves: friction 1',
        'PROPOSAL\nconvention: A line beginning with an organization acronym followed by a colon and a statement attributes that statement to the organization as a speaking voice.\nregister: municipal records\nevidence: ' + ids.join(' ') + '\nresolves: friction 1',
      ].join('\n\n');
    };
    const turn = await E.proposerTurn({ llm: reply });
    ok(turn.fired, 'the proposer fired (2 docs + registered friction)');
    eq(turn.discarded.length, 3, 'three out-of-grammar blocks were discarded');
    const reasons = turn.discarded.flatMap(d => d.reasons).join(',');
    ok(/unknown-span/.test(reasons), 'an unrecognized span-id kills the proposal (the model cannot cite what it was not shown)');
    ok(/missing-resolves/.test(reasons), 'a proposal that names no friction item is dropped (no freelancing)');
    ok(/invented-name:Zorblatt/.test(reasons), 'a proper noun absent from the referenced spans kills the proposal');
    eq(turn.proposals.length, 1, 'the well-formed proposal landed');
    const p = E.pendingProposals().find(x => x.pid === turn.proposals[0].pid);
    eq(p.status, 'signal', 'it landed as a SIGNAL, not a rule');
    ok(p.evidence.every(ev => ev.reader === 'llm-proposer' && ev.c === 0.6), 'its anchors carry the model reader at coupling 0.6');
    ok(p.mass < p.theta, 'by construction it sits below θ_admit (' + p.mass + ' < ' + p.theta + ')');
    const delta = E.conventionsDelta();
    ok(delta.some(r => r.op === 'REC' && r.action === 'proposal-signal'), 'the signal is a REC in the conventions delta');
    ok(delta.filter(r => r.op === 'REC' && r.action === 'eva-veto').length >= 3, 'each grammar failure deposited toward the veto lexicon (a model that babbles teaches the veto)');
    eq(E.proposerStatus().used, 1, 'the turn consumed one unit of the session budget');
  });

  await group('8. friction-nomination — the engine nominates; no friction, no proposer', async () => {
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    const a = await E.parseDocument('a.txt', DOC_A, 'docA');
    ok(a._genre !== 'transcript', 'the fixture reads as prose, not a transcript (the colon lines are unconsumed)');
    const report = E.frictionReport();
    const item = report.find(it => it.type === 'speaker-pattern' && /mnpd/.test(it.key));
    ok(!!item, 'the MNPD-colon pattern ×3 generated a friction item mechanically');
    ok(item && item.count === 3 && item.spans.length === 3, 'it carries the count and the engine-minted spans (†ids)');
    ok(item && item.spans.every(sp => /^†\d+$/.test(sp.sid) && /^MNPD:/.test(sp.text)), 'every span handle points at real text');
    const st = E.proposerStatus();
    ok(!st.eligible && st.reason === 'needs-more-documents', 'one document with no recurring stall shape does not trigger the proposer');
    // a clean engine with no friction never fires
    const E2 = loadEngine().EOEngine;
    E2.loadConventions(text);
    await E2.parseDocument('x.txt', DOC_X, 'docX');
    await E2.parseDocument('x2.txt', DOC_X.replace(/Edith/g, 'Agnes'), 'docX2');
    const turn = await E2.proposerTurn({ llm: () => 'PROPOSAL\nconvention: anything\nregister: any\nevidence: †1\nresolves: friction 1' });
    ok(!turn.fired && turn.reason === 'no-friction', 'no registered friction → the proposer does not fire');
  });

  await group('9. corroboration-paths — co-witness, confirm, reject, recurrence', async () => {
    // (a) document co-witness admits after a SECOND independent document
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    await withFriction(E);
    const turn = await E.proposerTurn({ llm: goodProposer });
    const pid = turn.proposals[0].pid;
    eq(E.pendingProposals().find(p => p.pid === pid).mass, 0.6, 'the signal opens at the model\'s coupling');
    await E.parseDocument('c.txt', DOC_C, 'docC');
    let p = E.pendingProposals().find(x => x.pid === pid);
    ok(p.status === 'signal' && p.mass === 1.6, 'one disjoint-h co-witness raises mass to 1.6 — still a signal at θ 2.0');
    await E.parseDocument('a2.txt', DOC_A, 'docA-again');
    p = E.pendingProposals().find(x => x.pid === pid);
    eq(p.mass, 1.6, 'a re-parse of the EVIDENCING text cannot re-witness (hash disjointness)');
    await E.parseDocument('d.txt', DOC_D, 'docD');
    p = E.pendingProposals().find(x => x.pid === pid);
    eq(p.status, 'admitted', 'a second independent document witness clears θ_admit');
    // (b) user confirmation admits instantly
    const Eb = loadEngine().EOEngine;
    Eb.loadConventions(text);
    await withFriction(Eb);
    const tb = await Eb.proposerTurn({ llm: goodProposer });
    const rb = Eb.confirmProposal(tb.proposals[0].pid);
    ok(rb.admitted && rb.status === 'admitted', 'drawer Confirm mints a user anchor — instant admission (0.6 + 5.0 ≥ θ)');
    // (c) reject SEGs the signal below floor and feeds the veto
    const Ec = loadEngine().EOEngine;
    Ec.loadConventions(text);
    await withFriction(Ec);
    const tc = await Ec.proposerTurn({ llm: goodProposer });
    const rc = Ec.rejectProposal(tc.proposals[0].pid);
    eq(rc.status, 'rejected', 'reject lands');
    const pc = Ec.pendingProposals().find(x => x.pid === tc.proposals[0].pid);
    ok(pc.mass === 0, 'the rejected signal decays below floor — it projects nothing');
    ok(Ec.conventionsDelta().some(r => r.op === 'SEG' && r.reason === 'user-reject'), 'the rejection is a SEG against the model\'s anchors');
    ok(Ec.conventionsDelta().some(r => r.op === 'REC' && r.action === 'eva-veto' && /proposal-rejected/.test(r.value && r.value.reason || '')), 'the rejection deposits toward a negative convention');
    // (d) cross-session recurrence merges without admitting
    const Ed = loadEngine().EOEngine;
    Ed.loadConventions(text + '\n' + Ec.serializeConventionsDelta());
    ok(Ed.pendingProposals().some(x => x.pid === tc.proposals[0].pid), 'an earlier session\'s signal re-enters the registry through the file');
    const Ee = loadEngine().EOEngine;
    const tEc2 = await (async () => { const E1 = loadEngine().EOEngine; E1.loadConventions(text); await withFriction(E1); return E1; })();
    const t1 = await tEc2.proposerTurn({ llm: goodProposer });
    const E2 = loadEngine().EOEngine;
    E2.loadConventions(text + '\n' + tEc2.serializeConventionsDelta());
    await withFriction(E2);
    const before = E2.pendingProposals().length;
    const t2 = await E2.proposerTurn({ llm: goodProposer });
    eq(E2.pendingProposals().length, before, 'the recurring proposal MERGED into the existing signal');
    const pd = E2.pendingProposals().find(x => x.pid === t1.proposals[0].pid);
    ok(pd.recurrence >= 1, 'recurrence raises visibility (' + pd.recurrence + ')');
    eq(pd.status, 'signal', 'model + model never self-admits — persistence earns attention, not authority');
  });

  await group('10. live-after-admission — the admitted convention changes the reading', async () => {
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    await withFriction(E);
    const turn = await E.proposerTurn({ llm: goodProposer });
    E.confirmProposal(turn.proposals[0].pid);
    const doc = await E.parseDocument('e.txt', DOC_A, 'docE');
    const sigs = (doc._events || []).filter(ev => ev.op === 'SIG' && ev.src === 'colon-label');
    eq(sigs.length, 3, 'the MNPD-colon lines now bind SIGs');
    ok(sigs.every(s => s.speaker === 'MNPD' && s.attributed === 'named'), 'the org is the named speaking voice');
    ok((doc._events || []).some(ev => ev.op === 'INS' && ev.src === 'colon-label-voice' && ev.target === 'MNPD'), 'the voice was instantiated by the typography');
    const ans = E.answer(doc, 'what did MNPD say');
    ok(/\{\{cite:/.test(ans.text), '"what did MNPD say" answers with a cite');
    ok(ans.audit && ans.audit.grounded, 'the answer is grounded');
    // the full chain hydrates a FRESH engine through the file channel
    const E2 = loadEngine().EOEngine;
    E2.loadConventions(text + '\n' + E.serializeConventionsDelta());
    const doc2 = await E2.parseDocument('e2.txt', DOC_A, 'docE2');
    ok((doc2._events || []).some(ev => ev.op === 'SIG' && ev.src === 'colon-label'), 'appended admitted records hydrate a fresh engine identically');
    // and revision keeps it on the leash: SEG to dormancy removes the live
    // members. The user's 5.0-coupling confirmation rightly takes FOUR
    // contrary sightings to overturn (5.0 × 0.25⁴ < floor) — heavier
    // witnesses take more contrary evidence, not special pleading.
    const prov = E.conventionProvenance('core:proposal:' + turn.proposals[0].pid);
    ok(prov && prov.anchors.length >= 2, 'the admitted convention carries its full provenance chain');
    for (let i = 0; i < 3; i++) E.segConvention('core:proposal:' + turn.proposals[0].pid, { reason: 'wrong in this register' });
    ok(!E.conventionProvenance('core:proposal:' + turn.proposals[0].pid).dormant, 'three contrary SEGs do not yet overturn a user-confirmed convention');
    E.segConvention('core:proposal:' + turn.proposals[0].pid, { reason: 'wrong in this register' });
    ok(E.conventionProvenance('core:proposal:' + turn.proposals[0].pid).dormant, 'the fourth sends every anchor below floor');
    const doc3 = await E.parseDocument('e3.txt', DOC_A, 'docE3');
    ok(!(doc3._events || []).some(ev => ev.op === 'SIG' && ev.src === 'colon-label'), 'a convention SEGed to dormancy stops binding — still in the log, projecting nothing');
  });

  await group('privacy — default ships {h, sig}; strict mode strips sig', async () => {
    const win = loadEngine();
    const E = win.EOEngine;
    // a stub embedder so signatures exist in Node: every span signs as the
    // same 8-dim unit vector (the engine quantizes whatever rows it gets)
    win.EOEmbed = { ready: () => true, embedSentences: async (xs) => xs.map(() => { const v = new Array(8).fill(0); v[0] = 1; return v; }) };
    E.loadConventions(text);
    await E.parseDocument('a.txt', DOC_A, 'docA');
    await E.parseDocument('x.txt', DOC_X, 'docX');
    await E.proposerTurn({ llm: goodProposer });
    ok(/"sig":\[/.test(E.serializeConventionsDelta()), 'default ships {h, sig}');
    E.setAnchorPrivacy('strict');
    const ship = E.serializeConventionsDelta();
    ok(!/"sig":\[/.test(ship), 'strict mode strips sig from everything shipped');
    ok(/"h":"[0-9a-f]{16}"/.test(ship), 'content hashes still ship — coupling-only weighting off-device');
    E.setAnchorPrivacy(null);
    // the embedder also gives the frame its register signature
    const doc = await E.parseDocument('a2.txt', DOC_A, 'docA2');
    const sig = await E.docSignature(doc);
    ok(Array.isArray(sig) && sig[0] === 127, 'a document signs its register (quantized centroid)');
  });

  await group('11. drift — file ≡ seeds + synthetic anchors; the proposer adds nothing uninvited', async () => {
    const records = lines.map(l => JSON.parse(l));
    const convIns = records.filter(r => r.op === 'INS' && r.kind === 'convention' && r.rule !== 'attribution_verbs');
    ok(convIns.length >= 60 && convIns.every(r => Array.isArray(r.prov) && r.prov.length === 1 && r.prov[0].h === 'seed' && r.prov[0].c === 1.0),
      'every seeded convention carries exactly one synthetic seed anchor (' + convIns.length + ')');
    ok(records.some(r => r.op === 'INS' && r.id === 'core:colon_speaker_labels')
      && records.some(r => r.op === 'INS' && r.id === 'core:separator_glyph_lines'),
      'the proposer\'s induced inventories are declared in the graph');
    ok(!records.some(r => (r.op === 'SYN' && r.v === 'member-of' && (r.o === 'core:colon_speaker_labels' || r.o === 'core:separator_glyph_lines'))),
      'they ship EMPTY — grown by admitted proposals, never seeded');
    const E = loadEngine().EOEngine;
    const res = E.loadConventions(text);
    const exp = E._conventionsExport();
    eq(exp.modules.core.conventions.colon_speaker_labels, [], 'loading the file leaves colon_speaker_labels empty (no wipe, no invention)');
    eq(exp.modules.core.conventions.separator_glyph_lines, [], 'and separator_glyph_lines empty');
    eq(E.pendingProposals().length, 0, 'the shipped file carries no pending proposals');
    eq(E.proposerStatus().used, 0, 'and consumes no proposal budget');
    ok(res.records === lines.length, 'every record (including anchored ones) was consumed');
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
