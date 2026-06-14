/* ============================================================
   Tests for the deterministic calculator (compute.js → window.EOCompute).

   compute.js is a browser script: an IIFE that resolves math.js from
   window.math and publishes window.EOCompute. Like the audit harness, we
   run it in a vm context with a fake `window` — here seeded with the real
   math.js (the same library the page loads from a CDN) — then exercise the
   detector and assert the contract:
     · a math turn is evaluated deterministically (never the model),
     · figures that appear in an open source bind to their line,
     · a non-math turn returns null so the caller falls through to routing,
     · and it never throws on junk.

   Run with `node tests/compute.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const math = require('mathjs');

const ROOT = path.resolve(__dirname, '..');

function loadCompute() {
  const sandbox = { window: { math }, math, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'compute.js'), 'utf8'), sandbox, { filename: 'compute.js' });
  if (!sandbox.window.EOCompute) throw new Error('compute.js did not publish window.EOCompute');
  return sandbox.window.EOCompute;
}

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name, fn) { console.log('• ' + name); fn(); }

const C = loadCompute();

// A small prose source: the operands a calc might use, on known lines.
const DOC = {
  id: 'd1', kind: 'prose',
  sentenceTexts: [
    'The agreement sets a contract value of $240,000 for the work.',  // s0
    'Counsel is entitled to a contingency fee of 15% of any recovery.', // s1
    'The project has 3 milestones.',                                    // s2
  ],
};

group('evaluates pure expressions deterministically (no model)', () => {
  eq(C.detect('2 * (3 + 4)').display, '14', 'arithmetic with precedence');
  eq(C.detect('what is 100/4?').display, '25', 'natural-language wrapper + division');
  eq(C.detect('sqrt(144) + 3^2').display, '21', 'functions and powers');
  eq(C.detect('5!').display, '120', 'factorial — a trailing ! is the operator, not punctuation');
});

group('informal operators — "x"/"×"/"÷" are arithmetic, never the model', () => {
  // The regression: "what is 123009 x 39?" used to drop to the model (the prose
  // gate rejected the stray "x"), which then did the arithmetic and got it wrong.
  const r = C.detect('what is 123009 x 39?');
  ok(r != null, '"123009 x 39" is a calculation, not a prose turn');
  eq(r && r.display, '4,797,351', 'x between numbers is multiplication, computed exactly');
  eq(r && r.eval, '123009*39', 'the "x" is normalized to * in the worked expression');
  eq(C.detect('12 × 39').display, '468', 'the × sign multiplies');
  eq(C.detect('100 ÷ 4').display, '25', 'the ÷ sign divides');
  eq(C.detect('2 x 2 x 2').display, '8', 'chained "x" all multiply');
  eq(C.detect('what is 5x5?').display, '25', '"5x5" with no spaces still multiplies');
  // but a stray "x" in prose is still not a calculation (the gate holds)
  eq(C.detect('the 3 x 4 grid layout'), null, 'a measured "3 x 4 grid" in prose is not hijacked as a calc');
});

group('word operators — natural-language math computes, never the model', () => {
  // The regression from the screenshot: "17 multiplied by 24" used to drop to
  // the model (the prose gate rejected "multiplied"/"by"), which then did the
  // arithmetic in its head. Now the words normalize to operators and math.js owns it.
  const r = C.detect('What is 17 multiplied by 24?');
  ok(r != null, '"17 multiplied by 24" is a calculation, not a prose turn');
  eq(r && r.display, '408', 'multiplied-by is computed exactly');
  eq(r && r.eval, '17 * 24', '"multiplied by" normalizes to * in the worked expression');
  eq(C.detect('17 times 24').display, '408', '"times" multiplies');
  eq(C.detect('100 minus 7').display, '93', '"minus" subtracts');
  eq(C.detect('100 plus 250').display, '350', '"plus" adds');
  eq(C.detect('200 divided by 4').display, '50', '"divided by" divides');
  eq(C.detect('2 to the power of 10').display, '1,024', '"to the power of" exponentiates');
  eq(C.detect('2 to the 10th power').display, '1,024', '"to the Nth power" exponentiates');
  eq(C.detect('9 squared').display, '81', '"squared" is ^2');
  eq(C.detect('3 cubed').display, '27', '"cubed" is ^3');
  eq(C.detect('15 percent of 240').display, '36', '"percent of" is a fraction of');
  // imperative phrasings (verb first); subtract/divide are order-sensitive
  eq(C.detect('multiply 17 by 24').display, '408', '"multiply X by Y"');
  eq(C.detect('divide 100 by 4').display, '25', '"divide X by Y"');
  eq(C.detect('add 5 and 3').display, '8', '"add X and Y"');
  eq(C.detect('subtract 3 from 10').display, '7', '"subtract X from Y" keeps operand order (10-3)');
  // but a stray operator word in prose is still not a calculation (gate holds)
  eq(C.detect('I told you 5 times already'), null, 'a counted "5 times" in prose is not hijacked');
  eq(C.detect('we cut costs by 5 percent last year'), null, 'a "5 percent" aside in prose is not hijacked');
  eq(C.detect('2 squared meters of floor space'), null, 'a measured "2 squared meters" is not hijacked');
});

group('a trailing instruction does not knock the turn off the calculator', () => {
  // The exact screenshot turn: a sum followed by "Show your reasoning step by
  // step." The "?" ends the sum; the worked-math panel is the shown reasoning.
  const r = C.detect('What is 17 multiplied by 24? Show your reasoning step by step.');
  ok(r != null, 'a math question with a trailing instruction still computes');
  eq(r && r.display, '408', 'the answer is the deterministic 408');
  eq(C.detect('17 times 24, show your work').display, '408', 'trailing "show your work" (no "?") is stripped');
  eq(C.detect('what is 100/4 please').display, '25', 'a trailing "please" is stripped');
  eq(C.detect('5 + 5 =').display, '10', 'a trailing "=" is the prompt for the answer, not part of the sum');
  eq(C.detect('5 + 5 = ?').display, '10', 'a trailing "= ?" computes');
  eq(C.detect('17 multiplied by 24 equals what?').display, '408', '"equals what?" is stripped');
  eq(C.detect('show your reasoning'), null, 'a bare instruction with no math is still not a calculation');
});

group('explicit triggers match as whole words (calc ≠ prefix of calculate)', () => {
  // "calculate ..." used to strip only "calc", leaving "ulate ..." which failed
  // to evaluate and dropped the turn to the model.
  eq(C.detect('calculate 5 times 5').display, '25', '"calculate" is a whole-word trigger');
  eq(C.detect('compute 7 + 8').display, '15', '"compute" triggers');
  eq(C.detect('evaluate 3^3').display, '27', '"evaluate" triggers');
});

group('money runs in BigNumber precision', () => {
  eq(C.detect('0.1 + 0.2').exact, '0.3', '0.1 + 0.2 is exactly 0.3 — no float drift');
  const r = C.detect('15% of $240,000');
  eq(r.display, '$36,000.00', 'percentage of a currency amount formats as money');
  eq(r.isMoney, true, 'a currency symbol marks the result as money');
  eq(r.eval, '(15/100)*240000', 'the percentage is normalized to explicit division');
});

group('binds figures to the line they came from', () => {
  const r = C.detect('15% of $240,000', [DOC]);
  const byVal = Object.fromEntries(r.operands.map(o => [o.value, o.cite]));
  ok(byVal[240000] && byVal[240000].idx === 0, '$240,000 binds to the contract-value line (s0)');
  ok(byVal[15] && byVal[15].idx === 1, '15% binds to the contingency-fee line (s1)');
  ok(byVal[240000] && /contract value/.test(byVal[240000].text), 'the bound operand carries its source text');
  eq(r.cites.length, 2, 'both grounded figures surface as citations');
  eq(r.audit.grounded, true, 'a grounded calc reports grounded');
});

group('small bare integers are not falsely grounded', () => {
  const r = C.detect('2 + 2', [DOC]);
  ok(r.operands.every(o => o.cite == null), 'the 2s in "2+2" are not tied to an unrelated number on the page');
  eq(r.cites.length, 0, 'no spurious citations');
  eq(r.audit.grounded, false, 'an ungrounded calc does not claim grounding');
});

group('degrades to null on non-math turns (falls through to routing)', () => {
  ['what does this clause mean', 'summarize section 2', 'total revenue by region',
   'who is in the document', '2024 revenue', '3-4 business days'].forEach(q => {
    eq(C.detect(q, [DOC]), null, JSON.stringify(q) + ' is not a calculation');
  });
});

group('the structure gate keeps bare numbers from being hijacked', () => {
  eq(C.detect('42'), null, 'a bare number is not a calculation');
  eq(C.detect('= 42').display, '42', 'but an explicit "=" evaluates it');
});

group('never throws — junk returns null', () => {
  ['', '   ', '((', '1 +', 'sqrt(', '/ 3', '%%%'].forEach(q => {
    let r; try { r = C.detect(q); } catch (e) { r = 'THREW: ' + e.message; }
    eq(r, null, JSON.stringify(q) + ' returns null, not an exception');
  });
});

group('the answer text is the result, in bold (the model never re-words it)', () => {
  eq(C.detect('2 + 2').text, '**4**', 'text is the bold result');
});

console.log(`\n${fail ? '✗ FAIL' : '✓ PASS'} — ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nfailures:'); for (const f of fails) console.error('   - ' + f); process.exit(1); }
