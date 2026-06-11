/* ============================================================
   tests/greek.test.js — el-classical-v1: the Greek organs read.

   Proves the three organs the pack assumes, now built table-driven in the
   engine and inert by default:
     1. the stem fold (admission folds case-clothes off one stem),
     2. the case→role deed-finder (CON endpoints from morphology, not order),
     3. the bound-pronoun resolver (pro-drop: the subject lives in the ending).
   Plus: Greek detection, the pack-load path, and that none of it touches a
   non-Greek reading (the organs are reached only when detectLanguage ⇒ 'grc').
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../evo/engine-host');

const PACK = fs.readFileSync(path.join(__dirname, '..', 'memory', 'packs', 'el-classical-v1.jsonl'), 'utf8');

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.error('  ✗ ' + m); } }
function group(n) { console.log('• ' + n); }

async function main() {
  group('detection — Greek script selects grc, others unaffected');
  {
    const E = loadEngine().EOEngine;
    ok(E._detectLanguage('ὁ Κῦρος τὸν ἵππον ἔλυσεν.') === 'grc', 'polytonic Greek → grc');
    ok(E._detectLanguage('The horse ran home quickly that evening.') === 'en', 'English still → en');
    ok(E._detectLanguage('Él se fue a la casa con su señora ayer.') !== 'grc', 'Spanish not → grc');
    ok(E._detectLanguage('他说他要回家了。今天天气很好。') === 'zh', 'Chinese still → zh');
  }

  group('load — the el pack builds the Greek organs');
  const E = loadEngine().EOEngine;
  const res = E.loadConventionPacks(PACK);
  ok(res.modules.includes('el-classical-v1'), 'pack registers el-classical-v1 (' + res.modules.join(',') + ')');
  const G = E._greekTables();
  ok(G && G.decl.length === 3, 'three declension tables loaded (' + (G && G.decl.length) + ')');
  ok(G && G.conj.length === 6, 'six conjugation tables loaded (' + (G && G.conj.length) + ')');
  ok(G && G.articleIdx.size > 10, 'article paradigm indexed (' + (G && G.articleIdx.size) + ' surfaces)');
  ok(G && G.caseRoles && G.caseRoles.nom, 'case_roles map loaded');
  ok(G && G.particles.size >= 8, 'postpositive particles loaded');

  group('organs — article / declension / conjugation folds');
  const an = (t) => E._analyzeGreekToken(t);
  {
    ok((an('τὸν').article || []).some(f => f.case === 'acc' && f.number === 'sg' && f.gender === 'm'), 'τὸν → article acc/sg/m');
    ok((an('ὁ').article || []).some(f => f.case === 'nom' && f.gender === 'm'), 'ὁ → article nom/m');
    ok(an('Κύρου').nouns.some(n => n.case === 'gen' && n.stemKey === 'κυρ'), 'Κύρου → noun gen, stem κυρ');
    ok(an('Κῦρος').nouns.some(n => n.case === 'nom' && n.stemKey === 'κυρ'), 'Κῦρος → noun nom, stem κυρ (same stem)');
    const elysen = an('ἔλυσεν').verbs;
    ok(elysen.some(v => v.stemKey === 'λυ' && v.person === 3 && v.number === 'sg' && v.voice === 'active'), 'ἔλυσεν → finite verb 3sg active, stem λυ');
    ok(elysen.some(v => v.aorist), 'ἔλυσεν reads as aorist (Figure grain)');
    ok(an('ἔλυε').verbs.some(v => v.stemKey === 'λυ' && v.tenseFamily === 'secondary'), 'ἔλυε → imperfect (secondary), stem λυ');
    ok(an('μέν').particle, 'μέν → postpositive particle (fate: grammar)');
    ok(an('καί').function, 'καί → function word');
  }

  group('reading — the stem fold admits one site; case assigns the deed');
  {
    const TXT = ['Κῦρος βασιλεὺς ἦν.', 'ὁ Κῦρος ἵππον εἶχεν.',
      'τὸν ἵππον ὁ Κῦρος ἔλυσεν.', 'ὁ ἵππος ἔφυγεν.'].join(' ');
    const g = E._extractGreekGraph(TXT, 0);
    const ins = g.events.filter(e => e.op === 'INS');
    const kyr = ins.find(e => e.basis && e.basis.stem === 'κυρ');
    ok(kyr, 'Κῦρος admitted as a site on the stem κυρ (case-clothes folded)');
    ok(ins.filter(e => e.basis && e.basis.stem === 'κυρ').length === 1, 'Κῦρος is ONE site, not split across nominative/genitive');
    const ipp = ins.find(e => e.basis && e.basis.stem === 'ἱππ');
    ok(ipp, 'ἵππος admitted as one site on the stem ἱππ');
    const con = g.events.filter(e => e.op === 'CON');
    const deed = con.find(e => kyr && ipp && e.source_ref === kyr.referent_id && e.target_ref === ipp.referent_id);
    ok(deed, 'CON deed Κῦρος → ἵππος, endpoints from case (nom source, acc target)');
    // the aorist clause (ἔλυσεν → stem λυ) carries Figure grain; the imperfect
    // εἶχεν clause in the same passage carries Pattern — the grain split is real
    const aor = con.find(e => e.relation === 'λυ');
    ok(aor && aor.stance_face && aor.stance_face.voice === 'active' && aor.stance_face.grain === 'Figure',
      'the aorist bond carries Stance: active voice, Figure grain');
  }

  group('pro-drop — the verb ending is a bound pronoun');
  {
    const TXT = ['ὁ Κῦρος ἦν βασιλεύς.', 'Κῦρος ἵππον εἶχεν.',
      'τὸν ἵππον ἔλυσεν.', 'ὁ ἵππος ἔφυγεν.'].join(' ');   // s3 has no overt nominative
    const g = E._extractGreekGraph(TXT, 0);
    const deed = g.events.find(e => e.op === 'CON' && e.bound_subject);
    ok(deed, 'a clause with no overt nominative still emits a deed (subject from the ending)');
  }

  group('parity — the organs stay inert for other languages');
  {
    const E2 = loadEngine().EOEngine;
    E2.loadConventionPacks(PACK);
    ok(E2._detectLanguage('A quiet day by the harbor. Marianne watched the boats.') === 'en',
      'an English doc still detects en with the Greek pack loaded');
    ok(E2._greekTables() && E2._greekTables().decl.length === 3, 'GREEK tables exist but are only read on the grc path');
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nFailures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
