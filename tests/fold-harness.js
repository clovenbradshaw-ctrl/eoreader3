/* ============================================================
   Column-balanced fold — cross-source / cross-length / cross-cursor harness.

   Exercises foldObject + renderFoldDigest against a SPREAD of real documents
   (tiny prose, journalism, a Gutenberg novella, a large novel, a non-English
   text, a multi-megabyte book) at SEVERAL cursor positions, prints the digest,
   and asserts the Layer-1 (entity-bias) + Layer-2 (cursor-scoping) guards.

   Run: node tests/fold-harness.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, VOSS, ROOT } = require('./harness');

const W = loadEngine();
const E = W.EOEngine;
W.EO_RULES = [{ id: 'fold-column-balanced', installed: true, enabled: true, value: 1 }];
E.applyRules(W.EO_RULES);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('   ✗ FAIL: ' + m); } };
const tokens = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const corpus = (f) => path.join(ROOT, 'evo/corpus', f);

function showFold(label, doc, hi, n) {
  const obj = E.foldObject(doc, (i) => i < hi);
  const prose = E.renderFoldDigest(obj);
  console.log(`\n  ── ${label} @ cursor ${hi}/${n} ──`);
  console.log('  FIG :', obj.figures.map(f => `${f.name}(${f.mass})`).join(', ') || '—');
  console.log('  EVT :', obj.events.map(e => `[${e.sentence_idx}·${e.site}] ${e.gist}`).join(' | ') || '—');
  console.log('  KIND:', obj.kinds.map(k => `${k.term}×${k.count}`).join(', ') || '—');
  console.log('  GRND:', obj.ground.map(g => `[${g.sentence_idx}] ${g.gist}`).join(' | ') || '—');
  console.log('  degen:', obj.fold_degenerate, '| digest tokens:', tokens(prose));
  console.log('  PROSE:', prose);
  return obj;
}

(async () => {
  // ---- 1. tiny non-Gutenberg prose (VOSS) ----
  console.log('\n══════ VOSS (tiny prose, 8 sentences) ══════');
  const voss = await E.parseDocument('voss.txt', VOSS, 'voss');
  const vn = voss.sentenceTexts.length;
  showFold('VOSS', voss, vn, vn);

  // ---- 2. journalism: the NDP op-ed (the Pattern + contested-registration case) ----
  console.log('\n══════ NDP OP-ED (journalism) ══════');
  const ndp = await E.parseDocument('ndp-oped.txt', fs.readFileSync(path.join(ROOT, 'tests/fixtures/ndp-oped.txt'), 'utf8'), 'ndp');
  const nn = ndp.sentenceTexts.length;
  const ndpObj = showFold('NDP', ndp, nn, nn);
  // kinds must carry the shell-company / private-policing CATEGORY (recurrence)
  const kindTerms = ndpObj.kinds.map(k => k.term).join(' | ');
  ok(/shell company|private policing|special assessment/i.test(kindTerms), 'NDP kinds surface the shell-company/private-policing/assessment pattern (got: ' + kindTerms + ')');
  // events must carry the contested NDMC PSO LLC registration (a NUL stall)
  const ndpEv = ndpObj.events.concat(ndpObj.ground).map(e => e.gist).join(' | ');
  ok(/contested|unresolved|NDMC|shell company/i.test(ndpEv) && ndpObj.events.length > 0, 'NDP events/ground carry the contested registration (got: ' + ndpEv + ')');
  ok(ndpObj.fold_degenerate == null, 'NDP fold is not figure-only-degenerate');

  // ---- 3. Gutenberg novella (Metamorphosis) at several cursors ----
  console.log('\n══════ pg5200 METAMORPHOSIS (novella) ══════');
  const meta = await E.parseDocument('pg5200.txt', fs.readFileSync(corpus('pg5200.txt'), 'utf8'), 'pg5200');
  const mn = meta.sentenceTexts.length;
  const cuts = [Math.floor(mn * 0.1), Math.floor(mn * 0.45), Math.floor(mn * 0.9), mn];
  const objs = cuts.map(hi => showFold('Metamorphosis', meta, hi, mn));
  // Layer 1: transformation present at every cursor past s14; never degenerate
  for (let k = 0; k < cuts.length; k++) {
    const all = objs[k].events.concat(objs[k].ground).map(e => e.gist).join(' ');
    ok(/transform|vermin|woke|waking|wakes/i.test(all), `Metamorphosis @${cuts[k]}: events reference the transformation/waking (not just the cast)`);
    ok(objs[k].fold_degenerate == null, `Metamorphosis @${cuts[k]}: not figure-only-degenerate`);
  }
  // Layer 1: no apparatus leaks into any column or the opener, at any cursor
  const apparatusLeak = (obj) => {
    const idxs = [...obj.events, ...obj.ground].map(e => e.sentence_idx).filter(i => i != null);
    if (idxs.some(i => E.isApparatusSentence(meta, i))) return true;
    if (obj.opener && meta.sentenceTexts.indexOf(obj.opener) >= 0 && E.isApparatusSentence(meta, meta.sentenceTexts.indexOf(obj.opener))) return true;
    if ((obj.spine || []).some(l => /gutenberg|^\s*(title|author|translator|language|release date)\b/i.test(l))) return true;
    return false;
  };
  for (let k = 0; k < cuts.length; k++) ok(!apparatusLeak(objs[k]), `Metamorphosis @${cuts[k]}: no apparatus in any column / opener / spine`);

  // Layer 2: MONOTONE GROWTH — a figure debuting late must not appear at an early cursor.
  const figAt = (hi) => new Set(E.foldObject(meta, (i) => i < hi).figures.map(f => f.key));
  const f10 = figAt(Math.floor(mn * 0.1)), fEnd = figAt(mn);
  ok([...f10].every(k => fEnd.has(k)), 'monotone: every early figure is still present at end (no vanishing)');
  // find a figure that is in the end fold but NOT in the s100 window — it must have debuted later
  const lateOnly = [...fEnd].filter(k => !f10.has(k));
  ok(lateOnly.length > 0, 'monotone: at least one figure debuts after the 10% cursor (the cast grows)');

  // Layer 2: LOCALITY — the prose lead (first "What happens" clause) at a mid cursor is in-scope-recent, not s0.
  const localityLead = (hi) => {
    const obj = E.foldObject(meta, (i) => i < hi);
    const lead = obj.events.slice().sort((a, b) => b.sentence_idx - a.sentence_idx)[0];
    return lead ? lead.sentence_idx : -1;
  };
  const lead45 = localityLead(Math.floor(mn * 0.45));
  ok(lead45 > mn * 0.2, `locality: the lead happening at the 45% cursor is recent (s${lead45}), not the book's opening`);

  // Layer 2: SCOPE-RELATIVE SALIENCE — a globally-heavy figure absent from a mid window must not be in that window's fold.
  const windowObj = E.foldObject(meta, (i) => i >= Math.floor(mn * 0.45) && i < Math.floor(mn * 0.55));
  const protagKey = E.foldObject(meta, (i) => i < mn).figures[0].key;   // Gregor — globally heaviest
  // Grete is dense later; assert the WINDOW fold's figures are scored by in-window mass (mass = in-window mentions)
  ok(windowObj.figures.every(f => f.mass >= 1), 'scope-relative: window figures carry in-window mass, not whole-doc mass');
  ok(windowObj.figures.length === 0 || windowObj.figures[0].mass < E.foldObject(meta, (i) => i < mn).figures[0].mass,
     'scope-relative: the window\'s lead-figure mass is smaller than the whole-doc lead mass (mass is local)');

  // ---- 4. a LARGE English novel (pg219 — Heart of Darkness era / long) ----
  console.log('\n══════ pg219 (large novel) ══════');
  const big = await E.parseDocument('pg219.txt', fs.readFileSync(corpus('pg219.txt'), 'utf8'), 'pg219');
  const bn = big.sentenceTexts.length;
  const bObj = showFold('pg219', big, bn, bn);
  ok(!(bObj.events.length === 0 && bObj.ground.length === 0), 'pg219: events+ground non-empty (something happens)');
  ok(!bObj.spine.some(l => /gutenberg|full license/i.test(l)), 'pg219: no license labels in spine');

  // ---- 5. NON-ENGLISH (Japanese — Rashomon): must not crash; degrades gracefully ----
  console.log('\n══════ rashomon (non-English) ══════');
  const jp = await E.parseDocument('rashomon.txt', fs.readFileSync(corpus('akutagawa_rashomon.txt'), 'utf8'), 'jp');
  const jn = jp.sentenceTexts.length;
  showFold('rashomon', jp, jn, jn);
  ok(typeof E.renderFoldDigest(E.foldObject(jp, (i) => i < jn)) === 'string', 'rashomon: fold renders a string (no crash on non-English)');

  // ---- 6. large file (pg34901, ~331KB) — cursor-scrubbing timing ----
  console.log('\n══════ pg34901 (~331KB) — scrub timing ══════');
  const t0 = Date.now();
  const huge = await E.parseDocument('pg34901.txt', fs.readFileSync(corpus('pg34901.txt'), 'utf8'), 'pg34901');
  const hn = huge.sentenceTexts.length;
  const tParse = Date.now() - t0;
  const t1 = Date.now();
  let scrub = 0;
  for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9, 1.0]) { const o = E.foldObject(huge, (i) => i < Math.floor(hn * frac)); scrub += o.events.length; }
  const tScrub = Date.now() - t1;
  console.log(`  parsed ${hn} sentences in ${tParse}ms; 6 cursor folds in ${tScrub}ms (${(tScrub / 6).toFixed(1)}ms/fold)`);
  showFold('pg34901', huge, hn, hn);
  ok(tScrub / 6 < 1500, `huge-doc fold is cheap to scrub (${(tScrub / 6).toFixed(0)}ms/fold < 1500ms)`);

  // ---- 7. DETERMINISM — same doc + same rules ⇒ deep-equal ----
  const d1 = E.foldObject(meta, null), d2 = E.foldObject(meta, null);
  ok(JSON.stringify(d1) === JSON.stringify(d2), 'determinism: foldObject(null) is deep-equal across calls (cached per RULES_REV)');

  console.log(`\n══════ ${pass} passed, ${fail} failed ══════`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(1); });
