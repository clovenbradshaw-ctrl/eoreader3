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

   Plus the PROVENANCE battery: anchors (content hash + embedding signature,
   never a name or location), the anchor physics (independence / decay /
   register fit / per-source cap / admission), and the convention PROPOSER —
   the local model's one creative slot: noticing that registered friction has
   a common shape and saying so in one sentence with citations. The model
   proposes; it never commits, cites, anchors, or self-witnesses.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
    const TXT = 'The Appointment\n\nThe contract was arranged by the same person who is the zonkmaster of the docks. That person is Tom Turner. Turner has held the docks for a decade.';
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

  /* ========================================================================
     PROVENANCE-ANCHORED CONVENTIONS + THE CONVENTION PROPOSER
     ======================================================================== */

  // Shared fixtures: a municipal doc with the MNPD-colon pattern ×3 (the
  // friction the engine must nominate), a disjoint second doc with the same
  // SHAPE under a different label (the co-witness), a third doc to prove the
  // admitted convention changes the reading, and the model reply the
  // proposal grammar accepts.
  const DOC_A = ['Council Session Notes', '',
    'The committee convened at nine in the morning to review the program.',
    'MNPD: We deployed the unit at the corner of Fifth and Main.',
    'Several residents spoke about parking enforcement on Hill Street.',
    'MNPD: The program complies with the state guidelines as written.',
    'The chair asked for a summary of the budget overruns from last quarter.',
    'MNPD: Our officers completed the required training in March.',
    'The meeting adjourned before noon without a final vote.'].join('\n');
  const DOC_B = ['Riverside Agenda', '',
    'The board heard public comment for an hour before the recess.',
    'FDOT: The detour will remain in place through the end of October.',
    'A motion to table the rezoning question carried without objection.',
    'FDOT: Crews will repave the northbound lanes next week.',
    'The clerk read the consent calendar into the record.'].join('\n');
  const DOC_C = ['Evening Report', '',
    'The neighbors gathered to hear the latest on the construction noise.',
    'MNPD: We responded to forty calls in the first week of the program.',
    'Everyone went home unhappy with the answer.'].join('\n');
  const GOOD_REPLY = ['PROPOSAL',
    'convention: A line beginning with an organization\'s acronym followed by a colon and a quoted or declarative statement attributes that statement to the organization as a speaking voice.',
    'register: municipal meeting transcripts and police communications',
    'evidence: †1 †2 †3',
    'resolves: friction 1', ''].join('\n');
  // an engine with DOC_A read and the good proposal landed as a signal
  const mnpdFlow = async () => {
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    await E.parseDocument('council-a.txt', DOC_A, 'docA');
    const res = await E.receiveProposals(GOOD_REPLY);
    return { E, id: res.accepted[0], res };
  };
  // a synthetic int8 sig pointing along one axis — orthogonal pairs make
  // register frames maximally distinguishable without an embedder
  const mkSig = (axis) => { const v = new Array(384).fill(0); v[axis] = 127; return v; };
  const mkAnchor = (h, r, c, t, sig) => ({ h, sig: sig || null, r, c, t: t || 0 });

  await group('anchor-wellformed — anchors parse; h is 16 hex; c matches a registered reader; no future t', async () => {
    const W = loadEngine();
    const E = W.EOEngine, P = E._provenance;
    E.loadConventions(text);
    // the content hash is real sha-256 (pinned against node crypto), truncated to 16 hex
    for (const s of ['', 'abc', 'MNPD: We deployed the unit at the corner of Fifth and Main.']) {
      eq(P.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), 'sha256 matches node crypto for ' + JSON.stringify(s.slice(0, 20)));
    }
    const a = P.mintAnchor('  The   quick brown fox. ', 'llm-proposer');
    ok(/^[0-9a-f]{16}$/.test(a.h), 'h is 16 hex chars (got ' + a.h + ')');
    eq(a.h, P.spanHash('The quick brown fox.'), 'whitespace-normalized before hashing');
    eq(a.c, 0.6, 'c is the llm-proposer registry coupling, frozen at registration');
    eq(P.mintAnchor('x', 'user').c, 5.0, 'user coupling 5.0');
    eq(P.mintAnchor('x', 'doc').c, 1.0, 'doc coupling 1.0');
    ok(a.t < P.head(), 'no future t — the anchor sits behind the log head');
    // local resolution: parse a doc, then anchors resolve to (doc, sentence)
    const doc = await E.parseDocument('a.txt', DOC_A, 'docA');
    const h = P.spanHash(doc.sentenceTexts[2]);
    eq(P.resolveAnchor(h), { docId: 'docA', idx: 2 }, 'on-device, h resolves to (doc, sentence)');
    eq(P.SEED_ANCHOR.h, 'seed', 'the synthetic seed anchor exists');
    eq(P.SEED_ANCHOR.c, 1.0, 'seed coupling is finite — outvotable by real sources');
  });

  await group('opacity — a fresh engine loads, projects, and weights without resolving an anchor', async () => {
    const E = loadEngine().EOEngine, P = E._provenance;
    // a prov-carrying signal line rides the file into an engine that never saw the source
    const anchors = [mkAnchor('a'.repeat(16), 'llm-proposer', 0.6, 5, mkSig(0)), mkAnchor('b'.repeat(16), 'llm-proposer', 0.6, 6, mkSig(0))];
    const signalLine = JSON.stringify({
      seq: 99950, op: 'INS', kind: 'convention', id: 'proposed:speaker_label_patterns:opaque',
      rule: 'speaker_label_patterns', module: 'core', epistemic: 'assertion', revisable: true,
      statement: 'A label and colon open a spoken line.', probe: '^([A-Z]{2,8}):\\s+(\\S.*)$',
      frictionType: 'speaker-label', prov: anchors,
    });
    const res = E.loadConventions(text + '\n' + signalLine);
    ok(res.records === lines.length + 1, 'the extra record was consumed');
    eq(P.resolveAnchor('a'.repeat(16)), null, 'off-device the hash resolves to nothing — 16 bytes, no dictionary');
    const m = P.anchorMass(anchors, { now: 10, frame: { doc_sig: mkSig(0) } });
    ok(m > 1.1 && m <= 1.2, 'similarity weighting works on a device that never saw the sources (' + m.toFixed(3) + ')');
    const pend = E.pendingProposals().find(p => p.id === 'proposed:speaker_label_patterns:opaque');
    ok(pend && pend.status === 'signal', 'the un-admitted record reconstitutes as a SIGNAL, not a rule');
    // and it did NOT apply: the doc-A colon lines still bind no speaker
    const doc = await E.parseDocument('a.txt', DOC_A, 'opq');
    ok(!(doc._events || []).some(ev => ev.op === 'SIG' && ev.src === 'speaker-label'),
      'a signal below admission never changes the reading');
  });

  await group('independence — same-h deposits are one sighting; model-only anchors never admit', () => {
    const E = loadEngine().EOEngine, P = E._provenance;
    const a = mkAnchor('c'.repeat(16), 'llm-proposer', 0.6, 0);
    const dupes = [a, { ...a }, { ...a, t: 3 }];
    eq(P.independentAnchors(dupes).length, 1, 'three same-h deposits collapse to one');
    eq(P.anchorMass(dupes, { now: 0 }), P.anchorMass([a], { now: 0 }), 'double deposit adds no mass');
    eq(P.admitAnchors(dupes).distinct, 1, 'admission counts distinct h, not deposits');
    // model-only never admits at ANY count — clause 3, not arithmetic luck
    for (const n of [2, 4, 8, 20]) {
      const onlyModel = Array.from({ length: n }, (_, i) => mkAnchor(String(i).padStart(16, '0'), 'llm-proposer', 0.6, i));
      const v = P.admitAnchors(onlyModel);
      ok(!v.ok && v.sum >= 1.2, n + ' model anchors (Σ=' + v.sum + ') stay a signal forever');
    }
    // one non-model witness flips it once θ clears
    const mixed = [mkAnchor('1'.repeat(16), 'llm-proposer', 0.6, 0), mkAnchor('2'.repeat(16), 'llm-proposer', 0.6, 0), mkAnchor('3'.repeat(16), 'doc', 1.0, 0)];
    ok(P.admitAnchors(mixed).ok, 'model + model + document witness admits (Σ=2.2 ≥ 2.0)');
  });

  await group('seed-falsifiability — seeds decay below admitted real-provenance competitors under contrary SEGs', () => {
    const E = loadEngine().EOEngine, P = E._provenance;
    const seed = [P.SEED_ANCHOR];
    const competitor = [mkAnchor('d'.repeat(16), 'doc', 1.0, 0), mkAnchor('e'.repeat(16), 'doc', 1.0, 0)];
    ok(P.admitAnchors(competitor).ok, 'the competitor is admitted real provenance (two document witnesses)');
    const m0 = P.anchorMass(seed, { now: 0 });
    eq(m0, 1, 'a seed convention has finite mass (1.0), not authority');
    const segs = new Map([['seed', 1]]);
    const m1 = P.anchorMass(seed, { now: 0, segCounts: segs });
    ok(m1 < m0, 'a contrary SEG decays the seed (' + m0 + ' → ' + m1 + ')');
    ok(m1 < P.anchorMass(competitor, { now: 0 }), 'the SEG\'d seed falls below the admitted competitor — nothing in the graph is unfalsifiable, including its initial conditions');
    const m2 = P.anchorMass(seed, { now: 0, segCounts: new Map([['seed', 2]]) });
    ok(m2 < m1, 'repeated SEGs keep decaying it (' + m1 + ' → ' + m2 + ')');
  });

  await group('register-weighting — anchors dominate under their own frame; the per-source cap holds', () => {
    const E = loadEngine().EOEngine, P = E._provenance;
    const conradSig = mkSig(0), journoSig = mkSig(1);
    // singular_they with three Conrad-register witnesses and one journalism
    // witness, attached through real records (gatherProvenance reads them)
    const records = [
      { seq: 1, op: 'INS', kind: 'convention', id: 'en-narrative-v1:singular_they', rule: 'singular_they', module: 'en-narrative-v1',
        prov: [mkAnchor('a1'.repeat(8), 'doc', 1.0, 0, conradSig), mkAnchor('a2'.repeat(8), 'doc', 1.0, 0, conradSig), mkAnchor('a3'.repeat(8), 'doc', 1.0, 0, conradSig)] },
      { seq: 2, op: 'REC', target: 'en-narrative-v1:singular_they', action: 'co-witness',
        prov: [mkAnchor('b1'.repeat(8), 'doc', 1.0, 0, journoSig)] },
    ];
    const st = P.gatherProvenance(records).get('en-narrative-v1:singular_they');
    eq(st.anchors.length, 4, 'anchors gathered from INS and REC prov');
    const mConrad = P.anchorMass(st.anchors, { now: 0, frame: { doc_sig: conradSig } });
    const mJourno = P.anchorMass(st.anchors, { now: 0, frame: { doc_sig: journoSig } });
    ok(Math.abs(mConrad - 3) < 0.01, 'under a Conrad frame the Conrad anchors carry the mass (' + mConrad.toFixed(2) + ')');
    ok(Math.abs(mJourno - 1) < 0.01, 'under a journalism frame the journalism anchor does (' + mJourno.toFixed(2) + ')');
    ok(mConrad !== mJourno, 'singular_they projects differently by register — no authored affinity strings doing load-bearing work');
    // per-source cap: one heavily-weighted source cannot exceed a quarter of
    // the register weight once enough independent sources contribute
    const crowd = [mkAnchor('f1'.repeat(8), 'user', 50, 0), mkAnchor('f2'.repeat(8), 'doc', 1, 0),
      mkAnchor('f3'.repeat(8), 'doc', 1, 0), mkAnchor('f4'.repeat(8), 'doc', 1, 0), mkAnchor('f5'.repeat(8), 'doc', 1, 0)];
    const capped = P.anchorMass(crowd, { now: 0 });
    // fixed point: T = others/(1−cap) = 4/0.75 ≈ 5.33 — the dominant source sits at the 25% ceiling
    ok(capped < 6 && capped > 5, 'the cap holds: 50-coupling source contributes ≤ 25% of register weight (mass ' + capped.toFixed(2) + ', uncapped 54)');
    const fair = P.anchorMass(crowd.slice(1), { now: 0 });
    eq(fair, 4, 'no cap among balanced sources');
  });

  await group('split-by-SEG — SEG against half the anchors yields two register variants', () => {
    const E = loadEngine().EOEngine, P = E._provenance;
    const sigA = mkSig(2), sigB = mkSig(3);
    const anchors = [
      mkAnchor('aa'.repeat(8), 'doc', 1.0, 0, sigA), mkAnchor('ab'.repeat(8), 'doc', 1.0, 0, sigA),
      mkAnchor('ba'.repeat(8), 'doc', 1.0, 0, sigB), mkAnchor('bb'.repeat(8), 'doc', 1.0, 0, sigB)];
    eq(P.conventionVariants(anchors, new Map()).length, 1, 'un-contradicted anchors project as one variant');
    const segs = new Map([['aa'.repeat(8), 1], ['ab'.repeat(8), 1]]);
    const variants = P.conventionVariants(anchors, segs, null);
    eq(variants.length, 2, 'SEG against half the anchors splits the projection');
    const surviving = variants.find(v => v.register === 'surviving');
    const contradicted = variants.find(v => v.register === 'contradicted');
    ok(surviving && contradicted, 'one surviving + one contradicted variant');
    ok(P.sigCos(surviving.sig, sigB) > 0.99, 'the surviving variant clusters in the un-contradicted register');
    ok(surviving.mass > contradicted.mass, 'the contradicted cluster decays under its SEGs (' + contradicted.mass.toFixed(2) + ' < ' + surviving.mass.toFixed(2) + ')');
  });

  await group('proposal-grammar — out-of-grammar replies are discarded and REC\'d; a well-formed one lands as a signal', async () => {
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    await E.parseDocument('council-a.txt', DOC_A, 'docA');
    const before = E.conventionsDelta().length;
    // bad span-id: the model cannot cite what it wasn't shown
    let r = await E.receiveProposals('PROPOSAL\nconvention: A colon line names its speaker.\nregister: transcripts\nevidence: †99\nresolves: friction 1\n');
    eq(r.rejected[0] && r.rejected[0].reason, 'unknown-span', 'an unrecognized †n kills the proposal');
    // no resolves: unsolicited proposals are dropped
    r = await E.receiveProposals('PROPOSAL\nconvention: A colon line names its speaker.\nregister: transcripts\nevidence: †1\n');
    eq(r.rejected[0] && r.rejected[0].reason, 'malformed', 'a proposal without resolves is dropped');
    // resolves names a friction that was never registered
    r = await E.receiveProposals('PROPOSAL\nconvention: A colon line names its speaker.\nregister: transcripts\nevidence: †1\nresolves: friction 7\n');
    eq(r.rejected[0] && r.rejected[0].reason, 'unsolicited', 'the model reacts to registered friction; it does not freelance');
    // invented proper noun (not in the referenced spans)
    r = await E.receiveProposals('PROPOSAL\nconvention: Blorvax statements after a colon belong to Blorvax.\nregister: transcripts\nevidence: †1 †2\nresolves: friction 1\n');
    ok(r.rejected[0] && r.rejected[0].reason === 'invented-name:Blorvax', 'an invented name kills the proposal');
    ok(E.conventionsDelta().length > before, 'each violation deposited a REC — a model that babbles teaches the veto');
    ok(E.conventionsDelta().some(rec => rec.op === 'REC' && rec.target === 'core:eva_veto_lexicon' && rec.value && rec.value.term === 'Blorvax'),
      'the invented name deposits toward the eva lexicon');
    eq(E.pendingProposals().length, 0, 'nothing landed from out-of-grammar replies');
    // the well-formed one lands as a SIGNAL carrying c:0.6 model anchors
    r = await E.receiveProposals(GOOD_REPLY);
    eq(r.accepted.length, 1, 'the well-formed proposal is accepted');
    const p = E.pendingProposals()[0];
    eq(p.status, 'signal', 'it is a SIGNAL — registered, decaying, waiting');
    ok(p.evidence.length === 3 && p.evidence.every(a => a.c === 0.6 && a.reader === 'llm-proposer'),
      'every anchor is the model\'s, at its registry coupling 0.6');
    ok(p.mass < p.theta, 'projected mass sits below θ_admit by construction (' + p.mass + ' < ' + p.theta + ')');
    ok(!p.witnesses.nonModel, 'the model is never its own witness');
    // the signal's serialized records hydrate a FRESH engine as a signal too
    const E2 = loadEngine().EOEngine;
    E2.loadConventions(text + '\n' + E.serializeConventionsDelta());
    const doc2 = await E2.parseDocument('again.txt', DOC_A, 'again');
    ok(!(doc2._events || []).some(ev => ev.op === 'SIG' && ev.src === 'speaker-label'),
      'hydrated elsewhere, the signal still does not read as a rule');
  });

  await group('friction-nomination — the engine nominates mechanically; no friction → the proposer does not fire', async () => {
    const E = loadEngine().EOEngine;
    E.loadConventions(text);
    await E.parseDocument('council-a.txt', DOC_A, 'docA');
    const fr = E.nominateFriction();
    const item = fr.find(f => f.type === 'speaker-label' && f.label === 'MNPD');
    ok(item, 'the MNPD-colon pattern ×3 generates the friction item mechanically');
    eq(item && item.count, 3, 'count is the registered sightings');
    ok(item && item.spans.length === 3 && item.spans.every(sp => /^†\d+$/.test(sp.sid) && /^MNPD:/.test(sp.text)),
      'span-ids are engine-minted handles pointing at real text');
    ok(E.proposerStatus().eligible, 'one document + a shape seen ≥3 times makes the proposer eligible');
    // a clean document registers nothing
    const E2 = loadEngine().EOEngine;
    E2.loadConventions(text);
    await E2.parseDocument('clean.txt', 'A Quiet Day\n\nMarianne walked to the harbor and watched the boats. The water was calm. She bought bread on the way home. The afternoon passed slowly.', 'clean');
    eq(E2.nominateFriction().length, 0, 'no unconsumed shapes → no friction');
    const st = E2.proposerStatus();
    ok(!st.eligible && st.reason === 'no registered friction', 'no friction → the proposer does not fire');
    // the budget is a rule: exhausting it stops the channel
    const E3 = loadEngine().EOEngine;
    E3.loadConventions(text);
    await E3.parseDocument('council-a.txt', DOC_A, 'docA');
    E3.applyRules([{ id: 'convention-proposals', installed: true, enabled: true, value: 0 }]);
    ok(!E3.proposerStatus().eligible && E3.proposerStatus().reason === 'budget exhausted', 'the per-session budget is tunable and enforced');
    E3.applyRules([{ id: 'convention-proposals', installed: true, enabled: false, value: 3 }]);
    eq(E3.proposerStatus().reason, 'proposals disabled', 'the side-panel toggle is honored');
  });

  await group('corroboration-paths — co-witness admits; Confirm admits instantly; Reject SEGs below floor; duplicates merge', async () => {
    // (a) document co-witness: a disjoint-h document matching the probe
    {
      const { E, id } = await mnpdFlow();
      eq(E.pendingProposals()[0].status, 'signal', 'starts as a signal (mass 1.8 < θ 2.0)');
      await E.parseDocument('riverside-b.txt', DOC_B, 'docB');
      const p = E.pendingProposals()[0];
      eq(p.status, 'admitted', 'a co-witness on a disjoint-h document admits (3×0.6 + 1.0 = 2.8 ≥ 2.0)');
      ok(p.witnesses.nonModel, 'the admitting witness is not the model');
      ok(E.conventionsDelta().some(r => r.op === 'REC' && r.action === 'admit' && r.target === id), 'admission is a REC in the conventions log');
      // re-parsing the same co-witness document cannot double-witness
      const n = p.evidence.length;
      await E.parseDocument('riverside-b.txt', DOC_B, 'docB');
      eq(E.pendingProposals()[0].evidence.length, n, 'a re-read of the same source is not a new sighting');
    }
    // (b) user confirmation: one tap, c:5.0, instant admission
    {
      const { E, id } = await mnpdFlow();
      const v = E.confirmProposal(id);
      ok(v.ok && v.status === 'admitted', 'Confirm mints a c:5.0 user anchor — instant admission');
    }
    // (c) rejection: a SEG against the model anchors decays the signal hard
    {
      const { E, id } = await mnpdFlow();
      const massBefore = E.pendingProposals()[0].mass;
      const v = E.rejectProposal(id);
      eq(v.status, 'rejected', 'Reject closes the signal');
      ok(v.mass < massBefore * 0.5, 'the SEG decays it below floor (' + massBefore + ' → ' + v.mass.toFixed(3) + ')');
      ok(E.conventionsDelta().some(r => r.op === 'SEG' && r.target === id && Array.isArray(r.against) && r.against.length === 3),
        'the rejection is a SEG against the model\'s anchor hashes');
      const docX = await E.parseDocument('evening-c.txt', DOC_C, 'docC');
      ok(!(docX._events || []).some(ev => ev.op === 'SIG' && ev.src === 'speaker-label'), 'a rejected signal never reads as a rule');
    }
    // (d) recurrence: the same proposal again merges — visibility, not authority
    {
      const { E, id } = await mnpdFlow();
      const r2 = await E.receiveProposals(GOOD_REPLY);
      eq(r2.merged[0], id, 'a duplicate proposal merges into the existing signal');
      const p = E.pendingProposals();
      eq(p.length, 1, 'no second signal');
      eq(p[0].visibility, 2, 'recurrence raises visibility');
      eq(p[0].status, 'signal', 'and never admits — model anchors cannot sum past the non-model requirement');
    }
  });

  await group('live-after-admission — the admitted convention changes the reading, end-to-end through the model channel', async () => {
    const { E } = await mnpdFlow();
    await E.parseDocument('riverside-b.txt', DOC_B, 'docB');     // co-witness → admitted
    const docC = await E.parseDocument('evening-c.txt', DOC_C, 'docC');
    const sig = (docC._events || []).find(ev => ev.op === 'SIG' && ev.src === 'speaker-label');
    ok(sig && sig.speaker === 'MNPD', 'the colon-line now binds a SIG with the org as the speaking voice');
    ok(E.holdsSpeakerSlot(docC, 'MNPD').holds, '"who said X" machinery reaches it (speaker slot held)');
    const ans = E.answer(docC, 'what did MNPD say');
    ok(/responded to forty calls/.test(ans.text || ''), 'the question answers from the bound line');
    ok((ans.cites || []).length >= 1, 'with a citation');
    ok(ans.audit && ans.audit.grounded, 'and the answer audits grounded');
  });

  await group('drift+writer — prov fields are projection-side; the writer dedups; strict mode strips sigs', async () => {
    // a prov field on an EXISTING convention's record changes no rule values
    const E = loadEngine().EOEngine;
    const res0 = E.loadConventions(text);
    eq(res0.deltas, 0, 'file ≡ seeds ⇒ zero ledger deltas (byte-identical behavior)');
    const E2 = loadEngine().EOEngine;
    const provLine = JSON.stringify({ seq: 99960, op: 'REC', target: 'en-narrative-v1:singular_they', action: 'sighting',
      prov: [{ h: 'ab'.repeat(8), sig: null, r: 'doc', c: 1.0, t: 99960 }] });
    const res1 = E2.loadConventions(text + '\n' + provLine);
    eq(res1.deltas, 0, 'a prov-carrying sighting on a seed convention still produces zero deltas — provenance is projection-side');
    const a = loadEngine().EOEngine._conventionsExport(), b = E2._conventionsExport();
    eq(b.modules['en-narrative-v1'].conventions.singular_they, a.modules['en-narrative-v1'].conventions.singular_they,
      'the convention value is untouched');
    // writer dedup: replaying the same session delta collapses duplicates
    const { E: E3, id } = await mnpdFlow();
    E3.confirmProposal(id);
    const once = E3.serializeConventionsDelta();
    const lines1 = once.split('\n').filter(Boolean);
    eq(new Set(lines1).size, lines1.length, 'serialized delta carries no duplicate lines (dedup on op/target/value/h-set)');
    // strict privacy: shipped records lose their sigs, h-only off-device
    const E4 = loadEngine().EOEngine;
    E4.loadConventions(text);
    await E4.parseDocument('council-a.txt', DOC_A, 'docA');
    E4.setAnchorEmbedder(async (texts) => texts.map((t, i) => { const v = new Float32Array(384); v[i % 384] = 1; return v; }));
    await E4.receiveProposals(GOOD_REPLY);
    const withSig = E4.conventionsDelta().find(r => Array.isArray(r.prov) && r.prov.some(x => x.sig));
    ok(withSig, 'with an embedder, anchors carry quantized sigs locally');
    E4.setAnchorPrivacy('strict');
    const shipped = E4.serializeConventionsDelta();
    ok(shipped.indexOf('"sig":[') === -1, 'EO_ANCHOR_PRIVATE=strict strips every sig from shipped records');
    ok(/"h":"[0-9a-f]{16}"/.test(shipped), 'hashes still ship — coupling-only weighting off-device');
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
