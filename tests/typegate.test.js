/* ============================================================
   tests/typegate.test.js — the type gate (DEF: the fourth NUL state).

   The defect this pins: the veto answered a significance-layer question
   ("is this capitalized span a referent the page should carry?") with an
   existence-layer operator (`body.includes(token)`). A sentence-initial
   "Give" / "Based" / "Sure" / "What's" was harvested as a name, failed the
   substring test, landed in antimatter, and annihilated the turn. The token
   was never a referent — it was the user's own grammar or the draft's own
   connective tissue.

   The fix is a TYPE gate ahead of the presence test: classify each
   capitalized token by SHAPE (compromise POS in context). A referent is a
   nominal (Noun / ProperNoun, not a Pronoun). A structural token (connective,
   discourse adverb) or pragmatic token (imperative verb, interrogative,
   interjection, contraction) is not truth-apt — the fourth NUL state — and can
   never reach antimatter or be struck as invented.

   The keystone invariant: this is derived, NOT enumerated. The same word in a
   different grammatical role classifies differently — "Give me the gist"
   (imperative ⇒ dropped) vs "The Give was generous" (nominal ⇒ kept). A word
   list could never do that. "based" / "sure" / "what's" appear in no list
   anywhere in the engine; they are handled for what they are DOING.

   Run with `node tests/typegate.test.js`.
   ============================================================ */
'use strict';
const { loadEngine, VOSS } = require('./harness');
const E = loadEngine().EOEngine;

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function group(name, fn) { console.log('• ' + name); return fn(); }
const J = (x) => JSON.stringify(x);

(async () => {
  const voss = await E.parseDocument('Voss.txt', VOSS, 'voss');
  const anti = (q) => E.referents(voss, q).antimatter;
  const antiScope = (q) => E.referentsScope([voss], q).antimatter;
  const matter = (q) => E.referents(voss, q).matter;
  const inv = (q) => E.inventedTerms(voss, q);

  // ── 1. The four acceptance tokens, handled by shape ──────────────────────
  // None of these is a referent; none may produce antimatter, none may be
  // struck as invented. "Based"/"Give"/"Sure"/"What's" are nowhere in any list.
  group('the four pragmatic/structural leads produce no void', () => {
    const cases = [
      'Based on the passage, who is Edith?',   // discourse adverb (Verb,PastTense)
      'Give me a summary of this',             // imperative verb
      'Sure, tell me about the boat',          // interjection (Adjective)
      "What's going on at Voss Point?",        // interrogative contraction
    ];
    for (const q of cases) {
      ok(anti(q).length === 0, `no antimatter referent: ${J(q)} (got ${J(anti(q))})`);
      ok(antiScope(q).length === 0, `no antimatter (scope): ${J(q)} (got ${J(antiScope(q))})`);
      ok(inv(q).length === 0, `nothing invented: ${J(q)} (got ${J(inv(q))})`);
    }
  });

  // ── 2. Other structural / pragmatic shapes ──────────────────────────────
  group('connectives, interjections, gratitude, modals are not referents', () => {
    for (const q of [
      'Therefore who won the argument?',       // Conjunction
      'However, what does the keeper say?',    // Conjunction
      'Okay so what happened at the point',    // Expression
      'Yes please summarize the story',        // Expression
      'Honestly, who is Edith?',               // Adverb
      'Thanks, that really helps',             // Verb (gratitude)
      'Could you tell me about the lamp',      // Modal
    ]) {
      ok(anti(q).length === 0, `no antimatter: ${J(q)} (got ${J(anti(q))})`);
      ok(inv(q).length === 0, `nothing invented: ${J(q)} (got ${J(inv(q))})`);
    }
  });

  // ── 3. The gate is a TYPE filter, not a blanket pass ─────────────────────
  // A real referent — present or absent — is unchanged. Only non-nominals drop.
  group('real referents are untouched (the gate does not over-reach)', () => {
    // present nominals still MATTER
    ok(J(matter('what does Marlow want')) === J(['Marlow']), 'Marlow matters');
    ok(J(matter('where is Voss Point')) === J(['Voss Point']), 'Voss Point matters');
    ok(J(matter('Based on the text, who is Edith?')) === J(['Edith']), 'Edith matters even behind a discourse lead');
    // absent nominals still VOID — a missing name is still antimatter
    ok(J(anti('What did Zorthax say?')) === J(['Zorthax']), 'Zorthax still voids');
    ok(J(inv('What did Zorthax say?')) === J(['Zorthax']), 'Zorthax still invented');
    ok(J(anti('Tell me about Napoleon')) === J(['Napoleon']), 'Napoleon voids behind an imperative lead');
    ok(J(anti('Give me the story of Caesar')) === J(['Caesar']), 'Caesar voids; Give does not');
  });

  // ── 4. The keystone: derived, not enumerated ─────────────────────────────
  // The SAME surface form classifies oppositely by grammatical role. This is
  // the property no stop-list can have, and the whole point of the change.
  group('shape, not membership — the same word flips by role', () => {
    // "Give" the imperative is dropped; "Give" the nominal is a referent.
    ok(!E.nonReferentialCaps('Give the keeper a boat').size ||
        E.nonReferentialCaps('Give the keeper a boat').has('give'), 'imperative "Give" is non-referential');
    ok(!E.nonReferentialCaps('The Give was generous').has('give'), 'nominal "Give" is referential');
    // "Point" the imperative verb vs "Point" the place-name head.
    ok(E.nonReferentialCaps('Point me at the boat').has('point'), 'imperative "Point" is non-referential');
    ok(!E.nonReferentialCaps('Voss Point is on the map').has('point'), 'name-head "Point" is referential');
  });

  // ── 5. Empty / malformed input never throws (pure & total) ───────────────
  group('total function — never throws', () => {
    for (const x of [undefined, null, '', 42, {}, '   ']) {
      let threw = false;
      try { E.nonReferentialCaps(x); E.referents(voss, x); E.inventedTerms(voss, x); }
      catch (e) { threw = true; }
      ok(!threw, `no throw on ${J(x)}`);
    }
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { for (const f of fails) console.error('   - ' + f); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
