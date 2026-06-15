/* ============================================================
   tools/predictive/compose-veto-probe.js

   Measures what the two faithfulness vetoes the COMPOSE pipeline never calls
   would catch if it did. Both are real engine functions wired into the
   grounded chat path (app.jsx · runTurn) but absent from composition.js /
   compose.jsx:

     · `invented`  — engine.inventedTerms(doc, text): off-page capitalized
                     terms (fabricated citations / authorities / leaked
                     entities). Pure-lexical, needs no model.
     · `envelope`  — engine.groundingEnvelope(doc, boundText): cosine of each
                     {{cite:..}}-bound claim against its cited sentence, banded
                     leak / impressionistic / strong. Needs the resident MiniLM.

   Run:
     node tools/predictive/compose-veto-probe.js
   The `invented` half always runs (compromise is a devDependency). The
   `envelope` half runs only when the MiniLM is vendored locally — install
   @huggingface/transformers and run `node tools/predictive/fetch-model.js`
   once; otherwise it is reported as skipped (the same way the app degrades to
   pure lexical when EOEmbed is absent).

   The source is the shipped VOSS fixture standing in for "the document the
   essay was composed from"; the drafts reproduce the documented failure modes
   (fabricated citations, a leaked unrelated entity, a confident mis-citation).
   ============================================================ */
'use strict';
const { loadEngine, VOSS } = require('../../tests/harness');

const splitUnits = (E, t) =>
  (typeof E.splitSentences === 'function'
    ? E.splitSentences(String(t))
    : String(t).split(/(?<=[.!?])\s+/)).filter(s => s && s.trim());

function inventedReport(E, doc, title, draft) {
  console.log('\n── ' + title);
  const units = splitUnits(E, draft);
  let flagged = 0; const all = [];
  units.forEach((u, i) => {
    const terms = E.inventedTerms(doc, u);
    if (terms.length) {
      flagged++; all.push(...terms);
      console.log(`   unit ${i + 1}: FLAGGED ${JSON.stringify(terms)} — “${u.trim()}”`);
    }
  });
  const uniq = [...new Set(all)];
  console.log(`   → ${flagged}/${units.length} units flagged · invented terms: ${JSON.stringify(uniq)}`);
  return { units: units.length, flagged, terms: uniq };
}

async function inventedSection(E) {
  console.log('\n==================== `invented` veto (engine.inventedTerms) ====================');
  const doc = await E.parseDocument('Voss.txt', VOSS, 'voss');
  console.log(`source doc: ${doc.sentences.length} sentences, kind=${doc.kind}`);

  const faithful = [
    'Edith reached the head of the stairs as the storm broke.',
    'Sefton wanted to row to the mainland because Marlow was expecting him.',
    'The keeper warned that no one could cross to Harrow that night.',
    'By midnight the wind took the seaward shutter and the three sat by the lamp.',
  ].join(' ');

  const confabulated = [
    'According to the Hartwell Maritime Institute, storms like the one at Voss Point strand keepers every winter.',
    'Brennan (2019) found that 73 percent of lighthouse keepers refuse night crossings.',
    'The Coastal Survey of 1911 recorded similar conditions across the Harrow channel.',
    'Donna Summer later described the same restless waiting in her memoir.',
    'Edith and Sefton both understood the danger.',
  ].join(' ');

  inventedReport(E, doc, 'DRAFT A — faithful paraphrase (on-page entities only)', faithful);
  inventedReport(E, doc, 'DRAFT B — essay-style confabulation', confabulated);
  console.log('\n   `invented` catches off-page CAPITALIZED terms (fabricated citations /');
  console.log('   authorities / leaked entities), not a bare number like "73 percent" —');
  console.log('   that is the assertion/envelope veto\'s job.');
}

async function envelopeSection(E) {
  console.log('\n==================== `envelope` veto (engine.groundingEnvelope) ====================');
  const cite = (claim, idx) => `${claim} {{cite:voss:${idx}:s${idx}}}`;
  const findIdx = (texts, kw) => texts.findIndex(t => t.toLowerCase().includes(kw.toLowerCase()));

  const doc = await E.parseDocument('Voss.txt', VOSS, 'voss');
  const T = doc.sentenceTexts;
  const iStorm = findIdx(T, 'head of the stairs');
  const iMarlow = findIdx(T, 'Marlow is on the mainland');
  const iMid = findIdx(T, 'midnight');

  const boundText = [
    // meaning-preserving paraphrase, almost no shared content words → still high
    cite('Edith climbed to the top of the staircase just as the tempest finally arrived.', iStorm),
    // faithful close paraphrase, cited correctly → strong
    cite('Sefton insisted on rowing across to the mainland to meet Marlow.', iMarlow),
    // unrelated claim cited to a real sentence (mis-citation) → leak
    cite('The committee approved the quarterly budget for the new fiscal year.', iMid),
  ].join('\n\n');

  const env = await E.groundingEnvelope(doc, boundText);
  console.log(`checked=${env.checked}  strong=${env.strong}  impressionistic=${env.impressionistic}  leaks=${env.leaks}`);
  for (const r of env.rows) {
    console.log(`   cos=${r.cos.toFixed(4)}  ${r.band.toUpperCase().padEnd(15)} → “${r.claim}” [cited s${r.idx}]`);
  }
  console.log('\n   The first row scores high by MEANING despite near-zero word overlap —');
  console.log('   the signal the lexical witnessGrain cannot see. The last row is a');
  console.log('   confident mis-citation flagged as a leak.');
}

async function main() {
  const win = loadEngine();
  const E = win.EOEngine;

  await inventedSection(E);

  let embedNode = null;
  try {
    embedNode = require('./embed-node');
    await embedNode.init();
    win.EOEmbed = embedNode.asEOEmbed();
  } catch (e) {
    console.log('\n==================== `envelope` veto ====================');
    console.log('[skipped] ' + (e && e.message || e));
    console.log('  → install @huggingface/transformers and run');
    console.log('    `node tools/predictive/fetch-model.js` once to vendor the MiniLM,');
    console.log('    then re-run. (groundingEnvelope is vacuous without the embedder.)');
    return;
  }
  if (win.EOEmbed && win.EOEmbed.ready()) await envelopeSection(E);
}

main().catch(e => { console.error('PROBE FAILED:', e && e.stack || e); process.exit(1); });
