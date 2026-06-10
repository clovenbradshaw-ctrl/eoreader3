/* ============================================================
   evo/experiments/question-probe.js

   Ask the engine increasingly complex questions and watch where it
   holds, grounds, voids, or breaks. Deterministic (no model in Node):
   for each question this records the mechanical answer the engine
   produces AND the context a local model would be handed, so a failure
   is legible either way.

   Complexity tiers (escalating):
     1 lookup       — "who is X", presence
     2 definitional — "what is X", "what is X's job"
     3 speech       — "what did X say", "who said …"
     4 relational   — "who runs X", "what is X's relationship to Y"
     5 multi-hop    — "who does the person who runs X hire"
     6 negation     — "did X speak", "is X never mentioned"
     7 synthesis    — "how do X and Y differ", "what connects X and Y"
     8 adversarial  — absent names, false premises, propositions to check

   Usage:
     node evo/experiments/question-probe.js                 # full transcript + summary
     node evo/experiments/question-probe.js --fails         # only the failures
     node evo/experiments/question-probe.js --json out.json
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../engine-host');

const CORPUS = path.join(__dirname, '..', 'corpus');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

function strip(t) {
  const a = t.indexOf('*** START');
  const s = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(s, b >= 0 ? b : t.length).trim();
}

// A crafted relational doc (the Tom Turner self-dealing structure, expanded)
// so tiers 4–7 have something with real edges, roles, and a checkable premise.
const NDP = `Downtown Nashville Security: Who Pays, Who Profits

Downtown business owners pay an annual assessment to the Nashville Downtown Partnership. The Partnership is meant to fund cleaning, marketing, and security for the district.

The security contract is unusual. It is run through a recently created entity called NDMC PSO LLC — a shell company of the District Management Corporation (the DMC), created by the same person who runs the DMC and who then hires his own firm, NDP, to manage the downtown security operations through it. That person is Tom Turner.

Tom Turner is the president of the Nashville Downtown Partnership. He also chairs the board of the District Management Corporation. Christina Kane, a parking customer, said "it's like nobody cares." David Corman, who leads the rival firm Solaren Risk Management, called the arrangement "Operation Flood the Zone."

The Metro Council will vote on the contract next month. Council member Freddie O'Connell wrote on Twitter that the deal "deserves real scrutiny." Mayor Cooper has not commented.`;

function buildBattery(ents) {
  // ents: {hod:[names], goriot:[...]} heaviest entities, for generic probes.
  return {
    ndp: [
      [1, 'who is in this document'],
      [1, 'is Tom Turner in this document'],
      [2, "what is Tom Turner's job"],
      [2, 'who is Tom Turner'],
      [2, 'who is David Corman'],
      [3, 'what did Christina Kane say'],
      [3, 'who called it Operation Flood the Zone'],
      [4, 'who runs the DMC'],
      [4, 'what is the relationship between Tom Turner and the DMC'],
      [4, 'who hires NDP'],
      [5, 'who does the person who runs the DMC hire'],
      [5, 'what firm does the president of the Partnership control'],
      [6, 'did Mayor Cooper comment'],
      [6, 'is Solaren mentioned'],
      [7, 'how are Tom Turner and David Corman related'],
      [7, 'what connects the Partnership and NDMC PSO LLC'],
      [8, 'who is Hercule Poirot'],
      [8, 'what did Tom Turner say'],
      [8, 'is Tom Turner a parking customer'],
      [8, 'Tom Turner runs Solaren Risk Management'],
    ],
  };
}

// Classify an answer into a coarse outcome bucket for the summary.
function outcome(a) {
  if (!a || !a.text) return 'empty';
  if (/\{\{void:/.test(a.text)) return 'void';
  const au = a.audit || {};
  if (au.grounded && (au.status === 'clean')) return 'grounded-clean';
  if (au.grounded) return 'grounded-notes';
  if (au.status === 'held' || /rather hold|don.t find/i.test(a.text)) return 'held';
  return 'other';
}

(async () => {
  const E = loadEngine().EOEngine;
  const jsonOut = arg('--json', null);
  const failsOnly = has('--fails');

  const docs = { ndp: await E.parseDocument('ndp.txt', NDP, 'ndp') };
  const battery = buildBattery({});

  const rows = [];
  for (const [docId, doc] of Object.entries(docs)) {
    for (const [tier, q] of battery[docId]) {
      let a, err = null;
      try { a = E.answer(doc, q); } catch (e) { err = String(e.message || e); a = null; }
      const intent = E.classifyIntent(q);
      let ctx = '';
      try { ctx = E.context(doc, q, 6); } catch (e) {}
      const o = err ? 'ERROR' : outcome(a);
      rows.push({
        docId, tier, q, intent, outcome: o, err,
        text: a ? a.text : null,
        audit: a ? a.audit : null,
        cites: a ? (a.cites || []).length : 0,
        ctxHead: ctx.split('\n').slice(0, 1)[0] || '',
        assertionLed: /^What the page asserts/.test(ctx),
      });
    }
  }

  // ---- transcript ----
  const tierName = { 1: 'lookup', 2: 'definitional', 3: 'speech', 4: 'relational', 5: 'multi-hop', 6: 'negation', 7: 'synthesis', 8: 'adversarial' };
  const flag = (r) => {
    // heuristic "looks wrong" flags for triage
    const f = [];
    if (r.outcome === 'ERROR') f.push('THREW');
    if (r.tier === 8 && r.q.startsWith('who is Hercule') && r.outcome !== 'void') f.push('absent-not-voided');
    if (r.tier === 8 && /a parking customer$/.test(r.q) && r.outcome.startsWith('grounded-clean')) f.push('false-premise-confirmed?');
    if (r.tier <= 5 && (r.outcome === 'held' || r.outcome === 'void')) f.push('answerable-but-held');
    if (/^who /.test(r.q) && r.intent === 'summary') f.push('who→summary?');
    return f;
  };

  let shown = 0;
  for (const r of rows) {
    const flags = flag(r);
    if (failsOnly && !flags.length) continue;
    shown++;
    console.log(`\n[T${r.tier} ${tierName[r.tier]}] ${r.q}`);
    console.log(`  intent=${r.intent} · outcome=${r.outcome}${r.assertionLed ? ' · assertion-led ctx' : ''}${flags.length ? '  ⚠ ' + flags.join(', ') : ''}`);
    if (r.err) console.log('  ERROR: ' + r.err);
    else console.log('  → ' + String(r.text).replace(/\s+/g, ' ').slice(0, 220));
    if (r.audit) console.log(`  audit: ${r.audit.status} grounded=${r.audit.grounded} covers=${r.audit.covers} · ${r.cites} cite(s)`);
  }

  // ---- summary ----
  console.log('\n\n=== OUTCOME SUMMARY ===');
  const byTier = {};
  for (const r of rows) {
    byTier[r.tier] = byTier[r.tier] || {};
    byTier[r.tier][r.outcome] = (byTier[r.tier][r.outcome] || 0) + 1;
  }
  for (const t of Object.keys(byTier).sort()) {
    console.log(`  T${t} ${tierName[t].padEnd(12)} ` + Object.entries(byTier[t]).map(([k, v]) => `${k}:${v}`).join('  '));
  }
  const allFlags = rows.flatMap(r => flag(r).map(f => ({ q: r.q, f })));
  console.log('\n=== FLAGGED FOR TRIAGE (' + allFlags.length + ') ===');
  for (const { q, f } of allFlags) console.log(`  ⚠ ${f}  —  "${q}"`);
  if (failsOnly) console.log('\n(' + shown + ' shown; run without --fails for the full transcript)');

  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ schema: 'cleon-question-probe/1', at: new Date().toISOString(), rows }, null, 1)); console.log('\nwrote ' + jsonOut); }
})().catch(e => { console.error(e); process.exit(1); });
