/* ============================================================
   evo/experiments/question-probe.js

   Two batteries, both deterministic (no model in Node):

   A. QUESTIONS — 25 hard questions across the corpus, by complexity tier
      (lookup → definitional → speech → relational → multi-hop → negation →
      synthesis → adversarial). Records the mechanical answer + audit.

   B. LONGFORM — the substrate the engine hands a model to write fluid,
      frontier-quality prose FROM THE READING: the talker portrait
      (existence/structure/significance) and a richness scorecard (heavy
      figures + their types, DEF assertions, drawn relations, real spine
      sections, signals). This is where "the intelligence of reading"
      either carries the longform or comes up thin — the scorecard makes
      thinness measurable.

   Usage:
     node evo/experiments/question-probe.js              # both batteries
     node evo/experiments/question-probe.js --longform    # just the substrate
     node evo/experiments/question-probe.js --questions    # just the 25
     node evo/experiments/question-probe.js --json out.json
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../engine-host');

const CORPUS = path.join(__dirname, '..', 'corpus');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const CAP = parseInt(arg('--cap', '20000'), 10);

function strip(t) {
  const a = t.indexOf('*** START');
  const s = a >= 0 ? t.indexOf('\n', a) + 1 : 0;
  const b = t.indexOf('*** END');
  return t.slice(s, b >= 0 ? b : t.length).trim();
}
function corpus(file) { return strip(fs.readFileSync(path.join(CORPUS, file), 'utf8')).slice(0, CAP); }

// A crafted relational article — the Tom Turner self-dealing structure — so
// the relational / multi-hop / speech tiers have real edges and roles.
const NDP = `Downtown Nashville Security: Who Pays, Who Profits

Downtown business owners pay an annual assessment to the Nashville Downtown Partnership. The Partnership is meant to fund cleaning, marketing, and security for the district.

The security contract is unusual. It is run through a recently created entity called NDMC PSO LLC — a shell company of the District Management Corporation (the DMC), created by the same person who runs the DMC and who then hires his own firm, NDP, to manage the downtown security operations through it. That person is Tom Turner.

Tom Turner is the president of the Nashville Downtown Partnership. He also chairs the board of the District Management Corporation. Christina Kane, a parking customer, said "it's like nobody cares." David Corman, who leads the rival firm Solaren Risk Management, called the arrangement "Operation Flood the Zone."

The Metro Council will vote on the contract next month. Council member Freddie O'Connell wrote on Twitter that the deal "deserves real scrutiny." Mayor Cooper has not commented.`;

// The 25, mapped to a doc id. [tier, docId, question, why-it's-hard]
const QUESTIONS = [
  [1, 'hod', 'who is the narrator', 'Marlow is typed thing; a who-answer must still surface him as a person'],
  [1, 'goriot', 'who is Eugène de Rastignac', 'accented multi-token name, gravity-merge risk'],
  [1, 'meta', 'what is Gregor Samsa', 'type changes through the text (man→insect); graph holds one'],
  [2, 'ndp', 'who runs the DMC', '3-hop relational from the contract'],
  [2, 'ndp', "what is David Corman's job", 'role stated as a relative clause, not a title'],
  [2, 'goriot', 'who is Madame Vauquer', 'definitional from descriptive framing'],
  [3, 'ndp', 'what did Christina Kane say', 'must isolate her quote via SIG, not retrieve the sentence'],
  [3, 'ndp', 'who called it Operation Flood the Zone', 'who-said resolves via SIG attribution'],
  [3, 'meta', 'what does the chief clerk say', 'attribution to a role-named speaker'],
  [4, 'ndp', 'what is the relationship between Tom Turner and the DMC', 'two assertions joined'],
  [4, 'ndp', 'who hires NDP', 'relational, the verb is the relation'],
  [4, 'hod', 'what is the relationship between Marlow and Kurtz', 'cross-text relation, Kurtz may be out of slice'],
  [5, 'ndp', 'who does the person who runs the DMC hire', 'multi-hop: resolve the description, then its object'],
  [5, 'ndp', 'what firm does the president of the Partnership control', 'title→person→firm chain'],
  [6, 'ndp', 'did Mayor Cooper comment', 'stated negative ("has not commented")'],
  [6, 'hod', 'is Kurtz mentioned in the opening', 'true negative early; void/attest, don\'t lash to a token'],
  [6, 'liberty', 'does Mill defend government censorship', 'the page argues the opposite; a yes must be vetoed'],
  [7, 'underground', "how does the narrator's view of suffering change", 'arc across the text, no single passage'],
  [7, 'liberty', 'what are the main arguments against censorship', 'list synthesis across paragraphs'],
  [7, 'wealth', 'what is the relationship between the division of labor and productivity', 'relational claim spanning sentences'],
  [8, 'ndp', "who does 'he' refer to when it says he hires his own firm", 'the contested pronoun-stall from the trace'],
  [8, 'ndp', 'why did Christina Kane praise the security contract', 'FALSE premise — she criticized it'],
  [8, 'ndp', 'who is Hercule Poirot', 'absent name — must void'],
  [8, 'rashomon', 'who is the servant', 'Japanese: no case, thin admission; hold honestly'],
  [8, 'quijote', 'who is Sancho Panza', 'Spanish names admit; English attribution conventions'],
];

// Complex-output TASKS — the longform the reading should be able to drive.
const TASKS = [
  ['ndp', 'write a profile of Tom Turner', 'profile'],
  ['ndp', 'list everyone who is quoted', 'enumeration'],
  ['hod', 'summarize this document', 'summary'],
  ['liberty', 'lay out the argument in three points', 'structured synthesis'],
  ['goriot', 'write a report about this', 'report'],
];

function outcome(a) {
  if (!a || !a.text) return 'empty';
  if (/\{\{void:/.test(a.text)) return 'void';
  if (/\{\{absent/.test(a.text)) return 'absence-attested';
  const au = a.audit || {};
  if (au.status === 'held' || /rather hold|didn.t find/i.test(a.text)) return 'held';
  if (au.grounded && au.status === 'clean') return 'grounded-clean';
  if (au.grounded) return 'grounded-notes';
  return 'other';
}
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

(async () => {
  const E = loadEngine().EOEngine;
  const jsonOut = arg('--json', null);
  const docs = {};
  const load = async (id, file) => { docs[id] = await E.parseDocument(id + '.txt', file ? corpus(file) : NDP, id); };
  await load('ndp', null);
  await load('hod', 'pg219.txt');
  await load('goriot', 'pg1237.txt');
  await load('meta', 'pg5200.txt');
  await load('underground', 'pg600.txt');
  await load('liberty', 'pg34901.txt');
  await load('wealth', 'pg3300.txt');
  await load('rashomon', 'akutagawa_rashomon.txt');
  await load('quijote', 'pg2000.txt');

  const tierName = { 1: 'lookup', 2: 'definitional', 3: 'speech', 4: 'relational', 5: 'multi-hop', 6: 'negation', 7: 'synthesis', 8: 'adversarial' };
  const qRows = [];

  if (!has('--longform')) {
    console.log('========== A. 25 HARD QUESTIONS ==========');
    for (const [tier, docId, q, why] of QUESTIONS) {
      const doc = docs[docId];
      let a = null, err = null;
      try { a = E.answer(doc, q); } catch (e) { err = String(e.message || e); }
      const intent = E.classifyIntent(q);
      const o = err ? 'ERROR' : outcome(a);
      qRows.push({ tier, docId, q, why, intent, outcome: o, text: a && a.text, cites: a ? (a.cites || []).length : 0, audit: a && a.audit });
      console.log(`\n[T${tier} ${tierName[tier]}] (${docId}) ${q}`);
      console.log(`  why hard: ${why}`);
      console.log(`  intent=${intent} · outcome=${o} · ${a ? (a.cites || []).length : 0} cite(s)`);
      console.log('  → ' + (err ? 'ERROR ' + err : oneLine(a.text).slice(0, 200)));
    }
    // summary
    console.log('\n--- outcome by tier ---');
    const byT = {};
    for (const r of qRows) { byT[r.tier] = byT[r.tier] || {}; byT[r.tier][r.outcome] = (byT[r.tier][r.outcome] || 0) + 1; }
    for (const t of Object.keys(byT).sort())
      console.log(`  T${t} ${tierName[t].padEnd(12)} ` + Object.entries(byT[t]).map(([k, v]) => `${k}:${v}`).join('  '));
  }

  if (!has('--questions')) {
    console.log('\n\n========== B. LONGFORM SUBSTRATE (what drives fluid output) ==========');
    console.log('The reading the model would write FROM. A thin/incorrect substrate caps');
    console.log('longform quality no matter how good the model is.\n');
    const cards = [];
    for (const id of ['hod', 'goriot', 'ndp', 'liberty']) {
      const doc = docs[id];
      const p = E.graphPortrait(doc) || {};
      const tp = await E.talkerPortrait(doc).catch(() => null);
      const heavy = (p.heavy || []).slice(0, 6);
      const card = {
        id,
        heavy: heavy.map(e => e.name + '/' + e.type),
        personRate: heavy.length ? heavy.filter(e => e.type === 'person').length / heavy.length : 0,
        assertions: (p.assertions || []).length,
        relations: (p.heavyEdges || p.edges || []).length,
        spine: (p.spine || []),
        signals: (p.signals || []).length,
        tail: (p.tail || []).length,
      };
      cards.push(card);
      console.log(`### ${id}`);
      console.log(`  heavy figures: ${card.heavy.join(', ')}`);
      console.log(`  person-typed: ${(card.personRate * 100).toFixed(0)}%   assertions: ${card.assertions}   relations: ${card.relations}   signals: ${card.signals}   tail: ${card.tail}`);
      console.log(`  spine (claimed sections): ${JSON.stringify(card.spine)}`);
      if (tp) {
        console.log('  — talker portrait (deterministic) —');
        console.log('  EXISTENCE:    ' + oneLine(tp.existence).slice(0, 180));
        console.log('  STRUCTURE:    ' + oneLine(tp.structure).slice(0, 180));
        console.log('  SIGNIFICANCE: ' + oneLine(tp.significance).slice(0, 220));
        // repetition check in significance (a frontier model would never repeat)
        const sents = oneLine(tp.significance).split(/(?<=[.!?])\s+/);
        const dupes = sents.length - new Set(sents.map(s => s.toLowerCase())).size;
        if (dupes > 0) console.log(`  ⚠ significance repeats ${dupes} sentence(s) verbatim`);
      }
      console.log('');
    }
    console.log('--- substrate scorecard ---');
    for (const c of cards)
      console.log(`  ${c.id.padEnd(8)} person-typed ${(c.personRate * 100).toFixed(0).padStart(3)}%  assertions ${String(c.assertions).padStart(2)}  relations ${String(c.relations).padStart(2)}  spine-chrome ${c.spine.filter(s => /^(contents|by |[ivxlcdm]+$|.{0,4}$)/i.test(s)).length}/${c.spine.length}`);
  }

  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ schema: 'cleo-question-probe/2', at: new Date().toISOString(), questions: qRows }, null, 1)); console.log('\nwrote ' + jsonOut); }
})().catch(e => { console.error(e); process.exit(1); });
