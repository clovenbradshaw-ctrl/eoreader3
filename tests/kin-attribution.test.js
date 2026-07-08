/* ============================================================
   tests/kin-attribution.test.js — kin-form speech attribution (D4).

   A line tagged through kinship — `"…," said his sister` / `"…!" called his
   mother` / `his sister whispered: "…"` — must land on the KIN RELATUM the
   possessive-kin reader resolved this sentence (kin:<role>:<possessor>), not on
   the mass/momentum leader. parseAttribution detects the kin slot positionally
   ("typography over lexicon", like the lowercase-slot name rule), so it fires
   even for a speech verb the typography never got to induce — which is the norm
   in a text that attributes almost entirely through kin (Metamorphosis).

   The relatum is typed `person` (speech is personhood evidence) and stays a
   low-mass placeholder the deep-read enrich pass later unifies with the named
   character (Grete). Here we pin the base-engine contract: the right referent,
   not the heaviest one.

   Run with `node tests/kin-attribution.test.js`.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('./harness');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) { pass++; } else { fail++; fails.push(m); console.error('  ✗ ' + m); } }

async function main() {
  const E = loadEngine().EOEngine;

  // Two "said Gregor" sightings induce a speech verb (attribution bootstraps from
  // typography and needs one verb in the class for parseAttribution to engage);
  // Gregor is then the heavy momentum leader. The kin-tagged lines must NOT land
  // on him — the sister's line is the sister's, the mother's is the mother's.
  const TXT = [
    'Gregor Samsa was a traveling salesman who lived with his family.',
    '"I must catch the early train," said Gregor.',
    '"The chief will be furious with me," said Gregor.',
    'Gregor heard slow footsteps approaching the locked bedroom door.',
    '"You really must get up now," said his sister.',
    '"Please do open the door, my boy," said his mother.',
  ].join(' ');
  const doc = await E.parseDocument('kin.txt', TXT, 'narrative');
  const sigs = (doc._events || []).filter(e => e.op === 'SIG');
  const keyOf = (s) => (s.speakerHint && s.speakerHint.key) || '';
  const sis = sigs.find(s => /get up now/.test(s.quote || ''));
  const mom = sigs.find(s => /open the door/.test(s.quote || ''));

  console.log('• kin-form attribution lands on the kin relatum, not the momentum leader');
  ok(sis && /^kin:sister:/.test(keyOf(sis)),
    'the sister\'s line resolves to a kin:sister relatum (got ' + (sis && JSON.stringify(sis.speaker)) + ')');
  ok(mom && /^kin:mother:/.test(keyOf(mom)),
    'the mother\'s line resolves to a kin:mother relatum (got ' + (mom && JSON.stringify(mom.speaker)) + ')');
  // The relatum key (kin:sister:gregor) names Gregor as the POSSESSOR, but the
  // speaker is the relatum, not Gregor's own site — the momentum leader's keys
  // are "gregor samsa" / "gregor".
  ok(sis && keyOf(sis) !== 'gregor samsa' && keyOf(sis) !== 'gregor',
    'the sister\'s line is NOT dumped on the momentum leader\'s own site (got ' + keyOf(sis) + ')');
  ok(sis && sis.attributed === 'kin', 'the resolution is labelled attributed:kin (auditable)');

  // The kin relatum is a person: speech is personhood evidence, and the
  // possessive-kin mint types it person up front.
  const sisRef = sis && sis.speakerHint && sis.speakerHint.referent_id;
  const minted = (doc._events || []).find(e => e.op === 'INS' && e.minted_kin
    && e.minted_kin.relation === 'sister' && e.entityType === 'person');
  ok(!!minted, 'the sister relatum was minted as a person');
  ok(!!sisRef, 'the SIG carries the relatum referent_id');

  // On Metamorphosis (kin-attributed throughout — "said his mother", "his sister
  // called"), real lines resolve to kin relata instead of the momentum leader.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'evo', 'corpus', 'pg5200.txt'), 'utf8');
  const body = (() => {
    const s = raw.indexOf('*** START'), e = raw.indexOf('*** END');
    let t = raw; if (s >= 0) t = t.slice(raw.indexOf('\n', s) + 1); if (e >= 0) t = t.slice(0, t.indexOf('*** END'));
    return t;
  })();
  const meta = await E.parseDocument('pg5200.txt', body.slice(0, 60000), 'narrative');
  const kinSigs = (meta._events || []).filter(e => e.op === 'SIG' && /^kin:/.test((e.speakerHint || {}).key || ''));
  console.log('• Metamorphosis: kin-tagged lines resolve to kin relata, not fallback');
  ok(kinSigs.length >= 3, 'at least three lines attribute to a kin relatum (got ' + kinSigs.length + ')');
  ok(kinSigs.every(s => s.attributed === 'kin'), 'every kin-relatum SIG is labelled attributed:kin');

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
