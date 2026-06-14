/* ============================================================
   Deterministic arithmetic — the calculator behind the chat.

   Cleo's contract is "the intelligence is mechanical; the model
   only phrases." Arithmetic is the most mechanical thing of all, so
   it must never touch the model: when a turn is essentially a math
   expression, math.js evaluates it deterministically and the model
   is bypassed entirely. The number the user sees is the engine's,
   never a model's mental arithmetic.

   What makes it auditable (the whole point): every figure the
   expression used is shown, and any figure that also appears in an
   open source is bound to the exact line it came from — so the
   reader can see the formula, see the inputs, and catch a wrong
   input. That last is the one class of "the math messed up" no
   evaluator can detect: right arithmetic over the wrong number.
   math.js guarantees the reproducibility; the worked-math panel
   makes the inputs checkable. We deliberately don't stamp a green
   "verified" badge — that would reassure about the inputs (which
   only a human can check) by pointing at the arithmetic (which can't
   be wrong by construction).

   detect(q, scope) returns a self-contained result, or null when the
   turn isn't arithmetic — the caller then falls through to ordinary
   routing (try/catch-as-"not a math question"). Money math runs in
   BigNumber precision so dollars don't drift. Published as
   window.EOCompute; also module.exports, for the Node test harness.
   ============================================================ */
(function () {
  'use strict';

  // math.js comes from the page (window.math, the UMD bundle) in the browser,
  // or from the dependency in Node (tests). Resolved and configured once,
  // lazily, so script/CDN load order never matters.
  let M = null, mathDown = false;
  function math() {
    if (M || mathDown) return M;
    let base = null;
    if (typeof window !== 'undefined' && window.math) base = window.math;
    else if (typeof globalThis !== 'undefined' && globalThis.math) base = globalThis.math;
    else if (typeof require !== 'undefined') { try { base = require('mathjs'); } catch (e) {} }
    if (!base || !base.create) { mathDown = true; return null; }
    // Money precision: evaluate in BigNumber so 0.1 + 0.2 is 0.3, not
    // 0.30000000000000004, and chained currency math doesn't drift.
    M = base.create(base.all, { number: 'BigNumber', precision: 64 });
    // Close the two real escape hatches on the scoped evaluator. Input is the
    // user's own expression in their own browser (no server, no other users),
    // but there's no reason to leave import/createUnit reachable from a string.
    // (evaluate/parse stay enabled — they're what we use.)
    try {
      M.import({
        import: function () { throw new Error('disabled'); },
        createUnit: function () { throw new Error('disabled'); },
      }, { override: true });
    } catch (e) {}
    return M;
  }

  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const group = (intStr) => String(intStr).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Alpha tokens tolerated inside an expression: math.js functions, constants,
  // a few connectors, and common units. The real gate against prose is the
  // operator requirement in detect(); this just keeps an expression that names
  // a function or a unit from being rejected out of hand.
  const ALLOWED = new Set(('abs ceil floor round fix sign sqrt cbrt nthroot exp expm1 log log2 log10 log1p pow square ' +
    'gcd lcm mod hypot factorial gamma combinations permutations ' +
    'sin cos tan sec csc cot asin acos atan atan2 sinh cosh tanh ' +
    'min max sum mean median mode prod std variance range det inv ' +
    'pi e tau phi inf infinity ' +
    'of to in as per and ' +
    'mm cm dm m km inch inches ft foot feet yd yard yards mi mile miles ' +
    'mg g kg lb lbs oz ton tonne ml cl dl l litre liter gal ' +
    's sec secs second seconds min mins minute minutes h hr hrs hour hours day days week weeks ' +
    'mph kmh deg rad grad celsius fahrenheit kelvin ' +
    'usd eur gbp byte bytes kb mb gb tb').split(/\s+/));

  // Detect a currency symbol before we strip it, so the result can be
  // formatted as money.
  function moneySymbol(s) { const m = /[$£€]/.exec(s); return m ? m[0] : null; }

  // Normalize the human form into something math.js evaluates cleanly: drop
  // currency symbols and digit-grouping commas, and turn percentages ("15% of
  // 240", "15%") into explicit division so we never lean on math.js's own
  // (version-dependent) percent handling — and so the worked math is explicit.
  function normalize(s) {
    let t = String(s).replace(/[$£€]/g, '');
    let prev;
    do { prev = t; t = t.replace(/(\d),(\d{3})(?!\d)/g, '$1$2'); } while (t !== prev);
    // Informal operators. The multiplication/division SIGNS (×, ÷, ·) and "x"
    // used as "times" between two numbers ("123009 x 39") are how people actually
    // write arithmetic in chat. Without this the prose gate sees a stray "x" alpha
    // token, abstains, and the turn drops to the model — which then does the
    // arithmetic itself and gets it wrong. Normalize them so math.js owns the sum.
    // (The prose gate and evaluator still reject anything that isn't real math, so
    // converting a stray "x" never turns prose into a bogus calculation.)
    t = t.replace(/[×✕✖]/g, '*').replace(/÷/g, '/').replace(/·/g, '*');
    t = t.replace(/(\d)\s*[xX]\s*(?=\d)/g, '$1*');
    // The same in words. "17 multiplied by 24", "5 times 6", "100 minus 7",
    // "200 divided by 4", "2 to the power of 10", "9 squared" — natural language
    // is how most people ask for a sum in chat, and without this every one of
    // them drops to the model, which then does the arithmetic itself (and can
    // get it wrong). We rewrite the operator words; the prose gate and evaluator
    // downstream still reject anything that isn't real math, so a stray word
    // ("I said it 5 times") never turns into a bogus calculation.
    //   · powers first, before "to"/"the" can be read as connectors
    t = t.replace(/\bto\s+the\s+(\d+)(?:st|nd|rd|th)\s+power\b/gi, '^$1');     // "2 to the 10th power"
    t = t.replace(/\b(?:raised\s+)?to\s+the\s+power(?:\s+of)?\b/gi, '^');      // "2 (raised) to the power (of) 10"
    t = t.replace(/\b(\d+(?:\.\d+)?)\s+squared\b/gi, '($1)^2');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s+cubed\b/gi, '($1)^3');
    //   · imperative phrasings put the verb first; subtract/divide are order-
    //     sensitive, so the operand swap matters ("subtract 3 from 10" → 10-3)
    t = t.replace(/\bmultiply\s+(\d[\d,.]*)\s+by\s+/gi, '$1 * ');
    t = t.replace(/\bdivide\s+(\d[\d,.]*)\s+by\s+/gi, '$1 / ');
    t = t.replace(/\badd\s+(\d[\d,.]*)\s+(?:and|to|plus)\s+/gi, '$1 + ');
    t = t.replace(/\bsubtract\s+(\d[\d,.]*)\s+from\s+(\d[\d,.]*)/gi, '$2 - $1');
    //   · infix operator words
    t = t.replace(/\bmultiplied\s+by\b/gi, '*');
    t = t.replace(/\bdivided\s+by\b/gi, '/');
    t = t.replace(/\btimes\b/gi, '*');
    t = t.replace(/\bplus\b/gi, '+');
    t = t.replace(/\bminus\b/gi, '-');
    t = t.replace(/\bpercent\b/gi, '%');
    t = t.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s+/gi, '($1/100)*');
    t = t.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');
    return t.trim();
  }

  // Strip an explicit calc trigger ("=", "calc:", "compute") or a natural
  // question wrapper ("what is", "how much is") so the rest reads as an
  // expression. Returns { expr, explicit } — explicit relaxes the prose gate.
  function unwrap(q) {
    let s = String(q || '').trim();
    let explicit = false;
    // The word triggers carry a (?![a-z]) guard so a short alternative can't
    // win as a prefix of a longer one ("calc" inside "calculate", leaving a
    // stray "ulate ..." that fails to evaluate) — the trigger must be a whole word.
    const trig = /^(?:=|(?:calculate|calc|compute|evaluate|eval)(?![a-z]))\s*[:=]?\s*/i.exec(s);
    if (trig) { explicit = true; s = s.slice(trig[0].length); }
    // A math turn often carries a trailing instruction ("What is 17 × 24? Show
    // your reasoning step by step."). The "?" ends the sum — keep only what
    // precedes it, so the request to "show your work" doesn't drag the whole
    // turn off the calculator and onto the model. (The worked-math panel IS the
    // shown reasoning, deterministically.)
    const qm = s.indexOf('?');
    if (qm >= 0) s = s.slice(0, qm);
    s = s.replace(/^(what(?:'s| is| are)?|whats|how much is|how many is)\s+/i, '');
    // Same idea when there was no "?" to cut at ("17 times 24, show your work",
    // "5 * 5 please"): drop a trailing instruction clause. None of these words
    // are math.js functions, so removing the tail can't truncate a real sum.
    s = s.replace(/[\s,.;:-]+\b(?:please|thx|thanks?(?:\s+you)?|show(?:\s+me)?(?:\s+(?:your|the))?\s+(?:work|working|reasoning|steps?|math)|step[\s-]?by[\s-]?step|explain|in\s+detail)\b.*$/i, '');
    // "5 + 5 =", "5 + 5 = ?", "5 plus 5 equals (what)" — the trailing "= ?"/
    // "equals" is the prompt for the answer, not part of the sum. Drop it.
    s = s.replace(/[\s,.;:]*(?:=+|equals?(?:\s+to)?)(?:\s+what)?\s*$/i, '');
    s = s.replace(/\s*\?+\s*$/, '');             // trailing question marks
    s = s.replace(/(\D)\s*[.!]+\s*$/, '$1');     // trailing . or ! — but not "5!" (factorial)
    return { expr: s.trim(), explicit };
  }

  // Only real scalars: numbers, BigNumbers, fractions, units. Booleans,
  // strings, complex, matrices and functions fall through to normal handling.
  function acceptable(r) {
    if (r == null) return false;
    const t = typeof r;
    if (t === 'number') return isFinite(r);
    if (t === 'boolean' || t === 'string' || t === 'function') return false;
    if (Array.isArray(r) || r.isMatrix || r.isComplex) return false;
    return !!(r.isBigNumber || r.isFraction || r.isUnit);
  }

  function formatNumber(exact, isMoney, symbol, m, result) {
    if (isMoney) {
      let fixed;
      try { fixed = m.format(result, { notation: 'fixed', precision: 2 }); }
      catch (e) { fixed = (Math.round((num(exact) || 0) * 100) / 100).toFixed(2); }
      const neg = fixed.trim().charAt(0) === '-';
      const [ip, fp] = fixed.replace(/^-/, '').split('.');
      return (neg ? '-' : '') + (symbol || '$') + group(ip) + '.' + ((fp || '00') + '00').slice(0, 2);
    }
    if (exact.indexOf('.') < 0) return group(exact);                 // integer
    let [ip, fp] = exact.split('.');
    const neg = ip.charAt(0) === '-'; if (neg) ip = ip.slice(1);
    fp = fp.slice(0, 6).replace(/0+$/, '');
    return (neg ? '-' : '') + group(ip) + (fp ? '.' + fp : '');
  }

  // Bind an operand value to the line it appears on, in any prose source in
  // scope. The match is mechanical: a sentence whose own numeric tokens include
  // this value (digit-grouping ignored). Percent operands additionally require
  // a '%' on that figure. First sighting wins.
  function ground(value, isPercent, scope) {
    for (const doc of (scope || [])) {
      if (!doc || doc.kind !== 'prose') continue;
      const sents = doc.sentenceTexts || (doc.sentences ? doc.sentences.map(x => x && x.t) : null);
      if (!sents) continue;
      for (let i = 0; i < sents.length; i++) {
        const sent = sents[i]; if (!sent) continue;
        const toks = String(sent).match(/\d[\d,]*(?:\.\d+)?/g);
        if (!toks) continue;
        for (const tk of toks) {
          if (num(tk) !== value) continue;
          if (isPercent && !new RegExp(escRe(tk) + '\\s*%').test(sent)) continue;
          return { docId: doc.id, idx: i, text: clip(sent, 140) };
        }
      }
    }
    return null;
  }

  // Pull the figures out of the human expression (keeping their readable form:
  // "$240,000", "15%") and bind the distinctive ones to the document. A bare
  // small integer like the 2 in "2+2" is never grounded — that would tie it to
  // some unrelated "2" on the page.
  function operandsOf(expr, scope) {
    const out = [];
    const re = /[$£€]?\s?(\d[\d,]*(?:\.\d+)?)(\s*%)?/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(expr)) !== null) {
      const raw = m[0].trim(); if (!raw) continue;
      const value = num(m[1]); if (value == null) continue;
      const isPercent = !!m[2];
      const isMoney = /[$£€]/.test(m[0]);
      const distinctive = /[,.]/.test(m[1]) || isMoney || isPercent || Math.abs(value) >= 100;
      const op = { raw, value, cite: null };
      if (distinctive && scope && scope.length && !seen.has(value)) {
        op.cite = ground(value, isPercent, scope);
        if (op.cite) seen.add(value);
      }
      out.push(op);
    }
    return out;
  }

  function detect(q, scope) {
    const m = math(); if (!m) return null;
    const { expr, explicit } = unwrap(q);
    if (!expr || expr.length > 200) return null;             // not a calculator essay
    const symbol = moneySymbol(expr);
    const norm = normalize(expr);
    if (!norm || !/\d/.test(norm)) return null;

    // prose gate: every alphabetic token must be a known function/unit/const.
    const alpha = norm.match(/[a-zA-Z]+/g) || [];
    if (!explicit && alpha.some(w => !ALLOWED.has(w.toLowerCase()))) return null;
    // structure gate: it must actually compute something (an operator or a
    // call), so a bare number or a stray figure is never hijacked as a calc.
    const hasStructure = /[-+*/^!]/.test(norm) || /\b[a-z]+\s*\(/i.test(norm);
    if (!explicit && !hasStructure) return null;

    let result;
    try { result = m.evaluate(norm); } catch (e) { return null; }
    if (!acceptable(result)) return null;

    const exact = (result && result.toString) ? result.toString() : String(result);
    const isUnit = !!(result && result.isUnit);
    const isMoney = !!symbol && !isUnit;
    const display = isUnit ? exact : formatNumber(exact, isMoney, symbol, m, result);

    const operands = operandsOf(expr, scope);
    const cites = [];
    const seenC = new Set();
    for (const op of operands) if (op.cite) {
      const k = op.cite.docId + ':' + op.cite.idx;
      if (!seenC.has(k)) { seenC.add(k); cites.push({ docId: op.cite.docId, idx: op.cite.idx }); }
    }

    const linked = cites.length;
    const audit = {
      status: 'computed', stable: true, grounded: linked > 0,
      note: linked
        ? `Computed mechanically with math.js; ${linked} of ${operands.length} figures bound to the open document. The model did not do this arithmetic.`
        : 'Computed mechanically with math.js — the model did not do this arithmetic.',
    };

    return {
      kind: 'calc', shown: expr, eval: norm,
      result: exact, exact, display, isMoney, isUnit,
      operands, cites, audit,
      text: '**' + display + '**',
    };
  }

  const api = { detect, normalize, version: '1' };
  if (typeof window !== 'undefined') window.EOCompute = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
