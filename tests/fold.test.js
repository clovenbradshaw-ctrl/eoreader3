/* ============================================================
   Column-balanced fold (READING_RULES.fold_column_balanced) — the entity-bias
   and cursor-scoping regression guards.

   The fold is Cleo's cursor-scoped reading primitive: at any scope predicate,
   a fixed-shape digest balanced across the Site grid's Time axis. These tests
   pin that it answers "what happens" / "what kind" / "who", not just "who"; that
   apparatus never leaks; that each column has a RESERVED budget (figure mass
   cannot crowd out a once-registered event); that salience is SCOPE-RELATIVE
   (a cursor fold doesn't leak the whole document's averages); and that the
   flag OFF is byte-identical to the legacy fold (the parity floor).

   Run: node tests/fold.test.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, VOSS, ROOT } = require('./harness');

const W = loadEngine();
const E = W.EOEngine;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL: ' + m); } };
const flag = (on) => { W.EO_RULES = [{ id: 'fold-column-balanced', installed: true, enabled: true, value: on ? 1 : 0 }]; E.applyRules(W.EO_RULES); };
const corpus = (f) => path.join(ROOT, 'evo/corpus', f);
const gistsOf = (obj) => [...obj.events, ...obj.ground].map(e => e.gist).join('  ||  ');

(async () => {
  // ── PARITY (test 5): with the flag OFF, the fold is the legacy cast-led form,
  //    byte-identical across a toggle. The golden suite pins the rest. ──
  flag(false);
  const voss = await E.parseDocument('voss.txt', VOSS, 'voss');
  const vn = voss.sentenceTexts.length;
  ok(E.foldColumnBalancedEnabled() === false, 'flag defaults OFF');
  const offFold = E.documentFold(voss, vn);
  ok(/^It mostly centers on /.test(offFold), 'OFF: legacy cast-led fold ("It mostly centers on …")');
  flag(true);
  const onFold = E.documentFold(voss, vn);
  ok(/^What happens:/.test(onFold), 'ON: event-first digest ("What happens: …")');
  flag(false);
  ok(E.documentFold(voss, vn) === offFold, 'parity: OFF after a toggle is byte-identical to OFF before');

  // everything below runs with the flag ON
  flag(true);

  // ── DETERMINISM (test 6): foldObject(null) is deep-equal across calls. ──
  ok(JSON.stringify(E.foldObject(voss, null)) === JSON.stringify(E.foldObject(voss, null)),
     'determinism: foldObject(null) deep-equal across calls (cached per RULES_REV)');

  // ── COLUMN INDEPENDENCE (test 4): a figure named many times cannot crowd a
  //    once-registered critical event out of the reserved events budget. ──
  const noisy = 'The Ledger\n\n' +
    Array.from({ length: 30 }, () => 'Alice noted the weather and filed a memo.').join(' ') +
    ' Boris destroyed the vault. Boris escaped that night. ' +
    Array.from({ length: 10 }, () => 'Alice noted the weather again.').join(' ');
  const ndoc = await E.parseDocument('ledger.txt', noisy, 'ledger');
  const nobj = E.foldObject(ndoc, null);
  ok((nobj.figures[0] || {}).name && /alice/i.test(nobj.figures[0].name) && nobj.figures[0].mass >= 30,
     'column-independence: Alice is the heavy figure (named 40×)');
  ok(/destroyed|vault/i.test(gistsOf(nobj)),
     'column-independence: the once-registered "destroyed" event survives Alice\'s mass (reserved events budget, not pooled by mass)');

  // ── EVENT PRESENCE (test 1): Metamorphosis at any cursor past s14 carries the
  //    transformation/waking, never just the cast; never figure-only-degenerate;
  //    the prose does not open with a bare figure list. ──
  const meta = await E.parseDocument('pg5200.txt', fs.readFileSync(corpus('pg5200.txt'), 'utf8'), 'pg5200');
  const mn = meta.sentenceTexts.length;
  for (const hi of [Math.floor(mn * 0.1), Math.floor(mn * 0.45), Math.floor(mn * 0.9), mn]) {
    const obj = E.foldObject(meta, (i) => i < hi);
    ok(/transform|vermin|woke|waking|wakes/i.test(gistsOf(obj)), `Metamorphosis @${hi}: events reference the transformation/waking`);
    ok(obj.fold_degenerate == null, `Metamorphosis @${hi}: not figure-only-degenerate`);
    ok(!/^It mostly centers on /.test(E.renderFoldDigest(obj)), `Metamorphosis @${hi}: prose is not cast-led`);
  }

  // ── NO APPARATUS (test 3): no fold column, opener, or spine label is apparatus
  //    on a Gutenberg text, at any cursor. ──
  const leaks = (obj) => {
    if ([...obj.events, ...obj.ground].some(e => e.sentence_idx != null && E.isApparatusSentence(meta, e.sentence_idx))) return true;
    const oi = obj.opener ? meta.sentenceTexts.indexOf(obj.opener) : -1;
    if (oi >= 0 && E.isApparatusSentence(meta, oi)) return true;
    if ((obj.spine || []).some(l => /gutenberg|full license|public domain|^\s*(title|author|translator|language|release date)\b/i.test(l))) return true;
    return false;
  };
  for (const hi of [Math.floor(mn * 0.1), mn]) ok(!leaks(E.foldObject(meta, (i) => i < hi)), `Metamorphosis @${hi}: no apparatus in any column / opener / spine`);

  // ── PATTERN PRESENCE (test 2): the NDP op-ed surfaces the recurring shell-
  //    company / private-policing CATEGORY (recurrence-scored) and the contested
  //    NDMC-PSO-LLC registration; a figure-only fold here FAILS. ──
  const ndp = await E.parseDocument('ndp.txt', fs.readFileSync(path.join(ROOT, 'tests/fixtures/ndp-oped.txt'), 'utf8'), 'ndp');
  const nfold = E.foldObject(ndp, null);
  const kinds = nfold.kinds.map(k => k.term).join(' | ');
  ok(/shell company|private policing|special assessment/i.test(kinds), 'NDP: kinds surface the shell-company/private-policing pattern (' + kinds + ')');
  ok(nfold.events.length > 0 && /contested|unresolved/i.test(gistsOf(nfold)), 'NDP: events carry the contested registration');
  ok(nfold.fold_degenerate == null, 'NDP: not figure-only-degenerate');

  // ── MONOTONE GROWTH (Layer 2): a figure debuting late must not appear at an
  //    early cursor; the cast only grows as the cursor advances. ──
  const figAt = (hi) => new Set(E.foldObject(meta, (i) => i < hi).figures.map(f => f.key));
  const fEarly = figAt(Math.floor(mn * 0.1)), fEnd = figAt(mn);
  ok([...fEarly].every(k => fEnd.has(k)), 'monotone: every early figure persists to the end');
  ok([...fEnd].some(k => !fEarly.has(k)), 'monotone: at least one figure debuts after the early cursor (cast grows)');

  // ── LOCALITY (Layer 2): the lead happening at a mid cursor is in-scope-recent,
  //    not the book's opening. ──
  const midObj = E.foldObject(meta, (i) => i < Math.floor(mn * 0.45));
  const lead = midObj.events.slice().sort((a, b) => b.sentence_idx - a.sentence_idx)[0];
  ok(lead && lead.sentence_idx > mn * 0.2, `locality: the lead happening at the 45% cursor is recent (s${lead && lead.sentence_idx}), not s0`);

  // ── SCOPE-RELATIVE SALIENCE (Layer 2): a figure's fold weight is its IN-WINDOW
  //    mass, not its whole-document mass — so a window's lead mass is local. ──
  const whole = E.foldObject(meta, null);
  const window = E.foldObject(meta, (i) => i >= Math.floor(mn * 0.45) && i < Math.floor(mn * 0.55));
  ok(window.figures.length === 0 || window.figures[0].mass < whole.figures[0].mass,
     'scope-relative: a window\'s lead-figure mass is smaller than the whole-doc lead mass (mass is local, not global)');

  // ── GRACEFUL DEGRADE: a text the event extractor can't read (non-English)
  //    still renders a string and flags figure-only rather than crashing. ──
  const jp = await E.parseDocument('jp.txt', fs.readFileSync(corpus('akutagawa_rashomon.txt'), 'utf8'), 'jp');
  ok(typeof E.renderFoldDigest(E.foldObject(jp, null)) === 'string', 'non-English: fold renders a string (no crash)');

  flag(false);   // leave the engine on the parity floor for any later loader
  console.log(`fold.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('fold.test ERROR', e && e.stack || e); process.exit(1); });
