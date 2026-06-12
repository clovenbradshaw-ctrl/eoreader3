/* ============================================================
   tools/predictive/parallel-golden.js — the flag-on golden, diffed.

   The relation_gate constraint: any output change ships behind the flag,
   off by default, with a parallel golden generated and DIFFED on the
   journalism + essay fixtures before the flag flips. This produces that
   artifact: the same battery of model-shaped drafts run through the
   flag-OFF path (bindCitationsScope — today's behavior) and the flag-ON
   path (bindClaimKeysScope + checkRelationsScope + groundingEnvelope),
   side by side, written to tests/golden-relation-gate.json.

     node tools/predictive/parallel-golden.js          # generate + diff
     node tools/predictive/parallel-golden.js --check  # re-generate, diff vs committed

   With the vendored embedder present the envelope and the paraphrase
   margins run; without it the gate runs lexical-only and the artifact
   says so (both are legitimate states of the shipped system).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require(path.join(__dirname, '..', '..', 'tests', 'harness.js'));
const FIX = require('./fixtures');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT = path.join(ROOT, 'tests', 'golden-relation-gate.json');

/* The battery: journalism + essay fixtures, drafts a grounded model could
   ship. `tagged` is the provenance-keyed form the flag-on prompt elicits;
   the flag-off path sees the untagged draft (off, the model never tags). */
const BATTERY = [
  { docId: 'ndp', drafts: [
    { draft: 'The Association cannot afford its bills.' },
    { draft: 'Downtown owners pay an annual assessment to the Partnership.' },
    { draft: 'The Partnership pays downtown business owners an annual assessment.' },
    { draft: 'Tom Turner hires his own firm to manage downtown security.' },
    { draft: 'NDP hired Tom Turner to run the District Management Corporation.' },
    { draft: 'Tom Turner is the president of the Nashville Downtown Partnership. The Metro Council will vote on the contract next month.',
      tagged: 'Tom Turner is the president of the Nashville Downtown Partnership [s6]. The Metro Council will vote on the contract next month [s10].' },
    { draft: 'The Metro Council will vote on the contract next month.',
      tagged: 'The Metro Council will vote on the contract next month [s2].' },   // a key that does not resolve → held
  ] },
  { docId: 'dispatch', drafts: [
    { draft: 'Ruiz argued that the timbers were unsafe.' },
    { draft: 'Vance argued that the timbers were unsafe and the cost of repair unbearable.' },
    { draft: 'Alderman Vance opened for the motion to demolish.',
      tagged: 'Alderman Vance opened for the motion to demolish [s2].' },
  ] },
  { docId: 'liberty', drafts: [
    { draft: 'The essay concerns the nature and limits of the power which can be legitimately exercised by society over the individual.' },
    { draft: 'Society protects the majority against the tyranny of the individual.' },
  ] },
  { docId: 'treatise', drafts: [
    { draft: 'A thermometer must absorb a little heat before it can report any.' },
    { draft: 'The reading is a negotiation between the instrument and the world.' },
  ] },
];

const r2 = (x) => Math.round(x * 100) / 100;

async function buildSide(flagOn, embed) {
  const W = loadEngine();
  const E = W.EOEngine;
  if (embed) W.EOEmbed = embed;
  if (flagOn) {
    // standing host rules, exactly as the app maintains them — they
    // survive the ledger commits a parse triggers (verb induction)
    W.EO_RULES = [{ id: 'relation-gate', installed: true, enabled: true, value: 1 }];
    E.applyRules(W.EO_RULES);
  }
  const docs = new Map();
  for (const spec of FIX.documents()) {
    if (!BATTERY.some(b => b.docId === spec.id)) continue;
    docs.set(spec.id, await E.parseDocument(spec.name, spec.text, spec.id));
  }
  return { E, docs, gateOn: E.relationGateEnabled() };
}

async function main() {
  let embed = null, embedder = 'absent (lexical-only gate)';
  try { const en = require('./embed-node'); await en.init(); embed = en.asEOEmbed(); embedder = en.MODEL + ' (q8, vendored)'; }
  catch (e) { /* the gate degrades exactly as the shipped app does */ }

  const off = await buildSide(false, embed);
  const on = await buildSide(true, embed);
  if (off.gateOn !== false || on.gateOn !== true) throw new Error('flag plumbing broken: off=' + off.gateOn + ' on=' + on.gateOn);

  const perDoc = [];
  let changed = 0, flagged = 0, held = 0;
  for (const b of BATTERY) {
    const dOff = off.docs.get(b.docId), dOn = on.docs.get(b.docId);
    const items = [];
    for (const item of b.drafts) {
      const offBound = off.E.bindCitationsScope([dOff], item.draft, item.draft, 'factual');
      const onBound = on.E.bindClaimKeysScope([dOn], item.tagged || item.draft, item.draft, 'factual');
      const mismatches = await on.E.checkRelationsScope([dOn], item.draft);
      let envelope = null;
      if (embed) {
        const env = await on.E.groundingEnvelope(dOn, onBound.text);
        if (env.checked) envelope = { checked: env.checked, leaks: env.leaks, rows: env.rows.map(r => ({ idx: r.idx, cos: r2(r.cos), band: r.band })) };
      }
      const row = {
        draft: item.draft, tagged: item.tagged || null,
        off: { text: offBound.text, grounded: offBound.audit.grounded, status: offBound.audit.status },
        on: {
          text: onBound.text, grounded: onBound.audit.grounded, status: onBound.audit.status,
          keyed: onBound.keyed || 0, held: (onBound.held || []).map(h => ({ key: h.key, claim: h.claim })),
          mismatches: mismatches.map(m => ({ kind: m.kind, claim: m.claim, edge: m.edge ? `${m.edge.s} —${m.edge.v}→ ${m.edge.o}` : null, sent: m.edge ? m.edge.sent : null })),
          envelope,
        },
      };
      if (row.off.text !== row.on.text || row.on.mismatches.length || row.on.held.length) changed++;
      flagged += row.on.mismatches.length;
      held += row.on.held.length;
      items.push(row);
    }
    perDoc.push({ docId: b.docId, items });
  }

  const artifact = { schema: 'relation-gate-parallel-golden/1', embedder, generated: 'tools/predictive/parallel-golden.js', perDoc };
  const json = JSON.stringify(artifact, null, 1);

  if (process.argv.includes('--check')) {
    const prev = fs.readFileSync(ARTIFACT, 'utf8');
    if (prev === json) { console.log('✓ parallel golden matches committed artifact'); return; }
    console.error('✗ parallel golden DRIFTED from committed artifact');
    process.exit(1);
  }
  fs.writeFileSync(ARTIFACT, json);
  console.log('✓ parallel golden →', path.relative(ROOT, ARTIFACT), `(embedder: ${embedder})`);
  console.log(`  ${BATTERY.reduce((n, b) => n + b.drafts.length, 0)} drafts: ${changed} differ flag-on, ${flagged} relation flag(s), ${held} held key(s)`);
  for (const d of perDoc) for (const it of d.items) {
    const marks = [
      ...it.on.mismatches.map(m => `FLAG ${m.kind}`),
      ...(it.on.held.length ? [`HELD s${it.on.held.map(h => h.key).join(',s')}`] : []),
      ...(it.on.envelope && it.on.envelope.leaks ? [`LEAK ×${it.on.envelope.leaks}`] : []),
    ];
    if (marks.length || it.off.text !== it.on.text)
      console.log(`  [${d.docId}] ${marks.join(' + ') || 'cites moved'} — "${it.draft.slice(0, 60)}"`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
