/* ============================================================
   tests/router.test.js — discourse precedence over lexical surface (B1/B1′).

   Pins the router half of the identity-precedence spec with the regression
   from a real session: with Howard Shore (doc-2) the active subject, the
   follow-up "what are his inspirations?" rebound to a Noah Kahan article
   (doc-3) — "inspirations" found its strongest lexical home in the wrong
   subject's document — and answered with Kahan's inspirations under a green
   grounded badge. The same disease as the ingestion SYN over-merge, one
   layer up: surface overlap beating referential identity.

   The contract (B1/B1′): the active discourse subject HOLDS the bound
   document. A bare-pronoun follow-up and a follow-up that NAMES the active
   subject both stay on the subject's document, even when a content word's
   keyword home is elsewhere. Lexical scoring ranks spans WITHIN the held
   document; it never moves the document. A switch requires the query to
   name a DIFFERENT subject (a genuine new referent), not a content noun.

   Inert without an active subject: routePrimary(scope, q) with no ctx is
   byte-identical to today (the parity floor), so this only exercises the
   threaded ctx.hotEntity path.

   Run with `node tests/router.test.js`.
   ============================================================ */
'use strict';
const { loadEngine } = require('./harness');
const E = loadEngine().EOEngine;

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function group(name, fn) { console.log('• ' + name); return fn(); }

// doc-2: Howard Shore. Note it carries NO "inspiration"/"influence" content
// — the point of the regression is that the held document cannot answer the
// follow-up, and the correct behavior is to stay put (and report absence),
// never to switch to the document that can.
const SHORE = [
  'Howard Shore is a Canadian composer of film scores.',
  'The press praised Howard Shore for his orchestral work.',
  'Howard Shore conducted the orchestra on the recordings.',
  'Critics agree Howard Shore reshaped the modern film score.',
].join(' ');

// doc-3: Noah Kahan — the keyword home of "inspirations" / "influences".
const KAHAN = [
  'Noah Kahan is an American singer-songwriter from Vermont.',
  'Noah Kahan cites his inspirations as the folk artists he grew up on.',
  'Those influences shaped the sound of Noah Kahan and his albums.',
  'Noah Kahan released Stick Season to wide acclaim.',
].join(' ');

async function main() {
  const shore = await E.parseDocument('doc-2', SHORE, 'doc-2');
  const kahan = await E.parseDocument('doc-3', KAHAN, 'doc-3');
  const scope = [shore, kahan];
  const hot = { hotEntity: 'Howard Shore' };

  group('B1 — a pronoun follow-up holds the active subject', () => {
    // "inspirations" lexically lives in doc-3; without precedence routePrimary
    // would switch. With the active subject it must hold doc-2.
    const p = E.routePrimary(scope, 'what are his inspirations?', hot);
    ok(p && p.id === 'doc-2', 'pronoun follow-up binds doc-2 (Shore), not doc-3 (Kahan) — got ' + (p && p.id));
    const bind = E.discourseBinding(scope, 'what are his inspirations?', hot);
    ok(bind && bind.hold && bind.doc.id === 'doc-2', 'the binding is a HOLD on the active subject');
  });

  group('B1′ — a named-subject follow-up hardens the hold', () => {
    // "shore's inspirations" names the active subject explicitly; the named
    // match must outrank the content-word pull to doc-3.
    const p = E.routePrimary(scope, "what are shore's inspirations?", hot);
    ok(p && p.id === 'doc-2', "naming the active subject holds doc-2 even though 'inspirations' lives in doc-3 — got " + (p && p.id));
  });

  group('switch — naming a different subject moves the document', () => {
    // The user genuinely changes subject: a name matching a DIFFERENT
    // referent is allowed to switch.
    const p = E.routePrimary(scope, 'tell me about Noah Kahan', hot);
    ok(p && p.id === 'doc-3', 'naming Noah Kahan switches to doc-3 — got ' + (p && p.id));
    const bind = E.discourseBinding(scope, 'tell me about Noah Kahan', hot);
    ok(bind && bind.switch && bind.doc.id === 'doc-3', 'the binding is a SWITCH to the newly-named subject');
  });

  group('parity — no active subject ⇒ lexical decides (today)', () => {
    // Without ctx, routePrimary is the old lexical chooser: "inspirations"
    // pulls doc-3. This is the byte-identical floor the change must preserve.
    const p = E.routePrimary(scope, 'what are the inspirations here?');
    ok(p && p.id === 'doc-3', 'no ctx ⇒ lexical home (doc-3) wins, exactly as before — got ' + (p && p.id));
  });

  group('absence — the held document cannot fabricate from the other', () => {
    // Bound to doc-2, the mechanical reading must not surface Kahan's
    // inspiration sentence. answerScope routes to the held subject.
    const plan = E.answerScope(scope, 'what are his inspirations?', hot);
    ok(plan && !/Paul Simon|Cat Stevens|folk-pop/i.test(plan.text || ''),
      "the answer does not leak Kahan's inspirations — got: " + (plan && plan.text || '').slice(0, 80));
  });

  group('B5.1 — topic-scoped fallback / honest absence within the subject', () => {
    // doc-2 (Shore) records his profession and an award, not his influences.
    // "what are Howard Shore's influences?" must NOT dump those unrelated
    // facts as the answer — it reports the aspect is not covered.
    const a = E.answer(shore, "what are Howard Shore's influences?");
    ok(a && !/composer|orchestra|academy|award/i.test(a.text),
      'a topic the page lacks does not surface the subject’s unrelated facts — got: ' + (a && a.text || '').slice(0, 90));
    ok(a && a.audit && a.audit.absent, 'the readout reports honest absence for the missing aspect');
    // a bare identity ask is unchanged — it still reads the class assertion
    const who = E.answer(shore, 'who is Howard Shore?');
    ok(who && /composer/i.test(who.text), 'a bare identity ask still answers from the class assertion');
    ok(who && !(who.audit && who.audit.absent), 'a bare identity ask is never an absence');
  });

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
