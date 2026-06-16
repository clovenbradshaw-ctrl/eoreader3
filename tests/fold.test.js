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

  // ── APPARATUS LEAK (legacy fold, flag OFF — the default the user sees): the
  //    integral fold a summary leans on must NOT open with the Gutenberg license
  //    or read the metadata header back as the document's "chapters", and the
  //    summary sample must not anchor on the front matter. The column-balanced
  //    builder already filtered these; the legacy builder had drifted, so a fold
  //    meant to be a succinct summary was neither succinct nor about the book. ──
  const hod = await E.parseDocument('pg219.txt', fs.readFileSync(corpus('pg219.txt'), 'utf8'), 'pg219');
  const hodN = hod.sentenceTexts.length;
  const hodFold = E.documentFold(hod, hodN);
  ok(!/Project Gutenberg|This eBook is for the use|www\.gutenberg/i.test(hodFold), 'legacy fold: the opener is the story, not the Gutenberg license');
  ok(!/\b(?:Title|Author|Language|Credits|Release date):/i.test(hodFold), 'legacy fold: no metadata-header line is read back as a chapter');
  ok(/It opens: “The Nellie/.test(hodFold), 'legacy fold: opens on the real first line of Heart of Darkness');
  ok(/Kurtz|Marlow/.test(hodFold), 'legacy fold: still names the book\'s figures');
  // The summary sample (salientPicks via blobHits): capped small, apparatus-free,
  // and spread across the WHOLE document — it used to be the first 16 leads (all
  // from the opening, the first three of them the license header on a Gutenberg).
  const hodPicks = E.blobHits([hod], 'summarize this');
  ok(hodPicks.length > 0 && hodPicks.length <= 8, 'summary sample: capped small (≤ 8), not 16');
  ok(hodPicks.every(h => !E.isApparatusSentence(hod, h.i)), 'summary sample: no apparatus among the picks');
  ok(Math.max(...hodPicks.map(h => h.i)) > hodN * 0.4, 'summary sample: spans the whole document, not just the opening');

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

  // ── THE HOLONIC FOLD: the integral fold "at a given cursor, to a given degree
  //    of holonic depth" — the nest of containing holons (document ⊃ chapter ⊃
  //    paragraph ⊃ sentence), each folded CUMULATIVELY up to the cursor. Pins
  //    the ladder shape, the nesting, and the exact tie back to the existing
  //    documentFold / foldOver primitives. The invariants hold under either
  //    flag; run on the shipped default (OFF). ──
  flag(false);
  {
    const hodC = Math.floor(hodN * 0.6);
    const hf = E.holonicFold(hod, hodC);
    ok(hf && Array.isArray(hf.rungs) && hf.rungs.length >= 2, 'holonic: returns a ladder of ≥2 rungs');
    ok(hf.rungs[0].level === 'document' && hf.rungs[hf.rungs.length - 1].level === 'sentence',
       'holonic: outermost rung is the document, innermost is the sentence');
    // rung 0 IS the integral fold up to the cursor — the existing primitive, exactly
    ok(hf.rungs[0].fold === E.documentFold(hod, hodC + 1),
       'holonic: rung 0 === documentFold(doc, cursor+1) (the integral fold itself)');
    // every rung folds up to the cursor; the scopes nest (starts non-decreasing)
    ok(hf.rungs.every(r => r.end === hodC + 1), 'holonic: every rung folds up to the cursor');
    let nested = true;
    for (let i = 1; i < hf.rungs.length; i++) if (hf.rungs[i].start < hf.rungs[i - 1].start) nested = false;
    ok(nested, 'holonic: each deeper rung is contained by the one above it (start non-decreasing)');
    // a chapter rung, when present, is the SAME fold operator over its own range
    const sec = hf.rungs.find(r => r.level === 'section');
    if (sec) {
      const range = []; for (let i = sec.start; i <= hodC; i++) range.push(i);
      ok(sec.fold === E.foldOver(hod, range), 'holonic: the chapter rung === foldOver(its range) (same operator, tighter scope)');
    }
    // the sentence floor is the verbatim line, not a synthesized fold
    ok(hf.rungs[hf.rungs.length - 1].fold === hf.cursorText && hf.cursorText === String(hod.sentenceTexts[hodC]).trim(),
       'holonic: the sentence rung is the verbatim line');
    // depth cap, cursor clamp, and the off-prose / empty guards
    ok(E.holonicFold(hod, hodC, 0).rungs.length === 1, 'holonic: maxDepth=0 yields just the document rung');
    ok(E.holonicFold(hod, 1e9).cursor === hodN - 1, 'holonic: an out-of-range cursor clamps to the last sentence');
    ok(E.holonicFold({ kind: 'table' }, 0) === null && E.holonicFold(null, 0) === null, 'holonic: null off-prose / on a non-doc');
  }

  flag(false);   // leave the engine on the parity floor for any later loader
  console.log(`fold.test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('fold.test ERROR', e && e.stack || e); process.exit(1); });
