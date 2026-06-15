/* ============================================================
   tools/predictive/read-voids.js — Phase 0 of the typed-void amendment.

   The read, no build. Model-free, deterministic, bar first. The amendment claims
   one word — "void" — was carrying many absences, and that the worst conflation
   is two DIFFERENT absences wearing the SAME marker. Before building, measure it:
   run the engine's mechanical absence paths over a battery of turns and count how
   often a single marker carried two different kinds, and how often a NUL ACT
   (ambiguous / inference — the material is present) would be miscounted as a void.

   The conflation counts size the build. If elsewhere and invented are both common
   under the one bare {{void:term}} marker, and if held contests would be reported
   as a lack, the split earns its place — those are the pairs an auditor and a
   reader most need separated.

   This reads the CURRENT engine (which already types its markers), then collapses
   the kinds back to the bare pre-amendment view to recover the conflation the
   amendment removes. Pure: no embedder, no model, no network.

     node tools/predictive/read-voids.js            # print the read
     node tools/predictive/read-voids.js --write     # also write docs/void-typology-read.md

   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
function load(file, sandbox) { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file }); }
function loadEngine() {
  const sandbox = { window: {}, nlp: require('compromise'), console, performance };
  sandbox.globalThis = sandbox; vm.createContext(sandbox);
  load('pivot.jsx', sandbox); load('engine.js', sandbox); load('audit.js', sandbox);
  return sandbox.window;
}

// ── the battery: turns built to exercise each absence, model-free ────────────
const DOCS = {
  voss: 'The Lamp at Voss Point. Edith waited at the head of the stairs while Sefton argued about the boat.',
  meet: 'Steven Watts addressed the hall. The committee met on Tuesday and adjourned at noon.',
  frank: 'Frank Mercer joined the firm in 2009. Frank was never charged with embezzlement; an internal audit cleared him.',
  oracle: 'Oracle is a major technology company. Larry Ellison founded it and led it for decades.',
  mnpd: 'The Metro Nashville Police Department deployed fifteen Skydio cameras across the city.',
};

// Each turn declares the kind the analyst expects, so the read can check the
// engine against the human label (and recover the bare-marker conflation).
const TURNS = [
  { doc: 'voss',  q: 'What did Zorthax say?',                 expect: 'elsewhere',  path: 'answer' },
  { doc: 'oracle',q: 'Where is Voss Point?',                  expect: 'elsewhere',  path: 'answer' },
  { doc: 'meet',  q: 'Steven Watts founded the committee.',   expect: 'never-set',  path: 'confirm' },
  { doc: 'frank', q: 'when did Frank stop embezzling?',       expect: 'impossible', path: 'answer' },
  // invented: a draft the talker produced naming a term not on the page
  { doc: 'voss',  draft: 'Edith met Zorthax on Jupiter.', invented: ['Zorthax', 'Jupiter'], expect: 'invented', path: 'invent' },
  // acts (NUL) — the material is present; these must NOT be voids
  { doc: 'ndp',   q: 'what does it do',                       expect: 'ambiguous',  path: 'bind' },
  { q: 'infer',                                               expect: 'inference',  path: 'infer' },
];

function run() {
  const W = loadEngine();
  const E = W.EOEngine, A = W.EOAudit;
  const NDP = require('./fixtures').NDP;

  const rows = [];
  // tallies
  const voidByKind = {}, absentByKind = {};
  let actsAsVoid = 0, actsTotal = 0;

  const docs = {};
  return (async () => {
    for (const [id, text] of Object.entries(DOCS)) docs[id] = await E.parseDocument(id + '.txt', text, id);
    docs.ndp = await E.parseDocument('ndp.txt', NDP, 'ndp');

    for (const t of TURNS) {
      let text = '', kindSeen = '—', isVoidMarker = false, markerName = '—';
      if (t.path === 'answer') { const r = E.answer(docs[t.doc], t.q); text = r.text || ''; }
      else if (t.path === 'confirm') { const r = E.answerConfirm(docs[t.doc], t.q); text = (r && r.text) || ''; }
      else if (t.path === 'invent') { text = E.voidInvented(t.draft, t.invented); }
      else if (t.path === 'bind') {
        const F = E.conversationField; F.reset(); F.decayTurn();
        F.deposit({ entities: ['Tom Turner', 'District Management Corporation'] }, 1);
        const bnd = E.resolveBinding([docs.ndp], t.q, F, { heatFloor: 0.25 });
        kindSeen = bnd.state; text = bnd.text || ''; markerName = 'binding-state';
        actsTotal++; if (A.countVoids(text)) actsAsVoid++;
        rows.push({ ...t, kindSeen, marker: 'NUL act (no marker)', voided: A.countVoids(text) > 0 });
        continue;
      } else if (t.path === 'infer') {
        text = E.markInferred('A holds {{cite:d:1:s1}} and B holds {{cite:d:2:s2}}.', [{ docId: 'd', a: 1, b: 2 }]).text;
        markerName = '{{infer}}'; kindSeen = 'inference';
        actsTotal++; if (A.countVoids(text)) actsAsVoid++;
        rows.push({ ...t, kindSeen, marker: '{{infer}} (act, not counted by countVoids)', voided: A.countVoids(text) > 0 });
        continue;
      }
      // classify the FIRST void/absent marker the turn produced
      const mv = /\{\{void:([^}]*)\}\}/.exec(text), ma = /\{\{absent:([^}]*)\}\}/.exec(text);
      if (mv) { const k = E.parseVoidMarker(mv[1]).kind; voidByKind[k] = (voidByKind[k] || 0) + 1; kindSeen = k; markerName = '{{void}}'; isVoidMarker = true; }
      else if (ma) { const k = E.parseAbsentMarker(ma[1]).kind; absentByKind[k] = (absentByKind[k] || 0) + 1; kindSeen = k; markerName = '{{absent}}'; isVoidMarker = true; }
      rows.push({ ...t, kindSeen, marker: markerName, voided: isVoidMarker });
    }

    // the conflation: under the PRE-amendment bare {{void:term}}, elsewhere and
    // invented were one indistinguishable marker. Recover both counts.
    const elsewhere = voidByKind.elsewhere || 0, invented = voidByKind.invented || 0;
    const voidConflation = (elsewhere > 0 && invented > 0) ? elsewhere + invented : 0;
    const neverSet = absentByKind['never-set'] || 0, cleared = absentByKind.cleared || 0;

    const lines = [];
    const P = (s) => { lines.push(s); console.log(s); };
    P('# The types of void — Phase 0 read (model-free, deterministic)');
    P('');
    P('Run of the engine\'s mechanical absence paths over a labelled battery. Each');
    P('marker is parsed to its kind, then collapsed to the bare pre-amendment view');
    P('to recover the conflation the amendment removes.');
    P('');
    P('| doc | turn | analyst expects | kind seen | marker | reported as a void? |');
    P('|---|---|---|---|---|---|');
    for (const r of rows) {
      const q = (r.q || r.draft || '').replace(/\|/g, '\\|');
      P(`| ${r.doc || '—'} | ${q} | ${r.expect} | ${r.kindSeen} | ${r.marker} | ${r.voided ? 'yes' : 'no'} |`);
    }
    P('');
    P('## The conflation counts (these size the build)');
    P('');
    P(`- \`{{void:term}}\` carried **elsewhere ×${elsewhere}** and **invented ×${invented}** — `
      + (voidConflation ? `**${voidConflation} markers conflated** under one bare marker (the worst conflation: the user naming an absent thing vs. the system inventing one).` : 'no live conflation in this battery.'));
    P(`- \`{{absent:…}}\` carried **never-set ×${neverSet}** and **cleared ×${cleared}** `
      + `(never-set is scanned silence + a receipt; cleared is the new destruction-absence terrain).`);
    P(`- NUL acts in the battery: **${actsTotal}**, of which reported as a void: **${actsAsVoid}** `
      + `(ambiguous holds and inference links — the material is present, so they must never be voids).`);
    P('');
    const earns = voidConflation > 0 && actsTotal > 0 && actsAsVoid === 0;
    P('## Verdict');
    P('');
    P(earns
      ? '**The split earns its place.** Two different absences shared the one '
        + '`{{void:term}}` marker (elsewhere vs invented), and the NUL acts are correctly '
        + 'NOT voids — exactly the pairs an auditor and a reader most need separated. '
        + 'Build the four terrains + the fabrication on the typed markers; keep the two acts as NUL.'
      : '**Inconclusive in this battery** — see the counts above.');
    P('');

    if (process.argv.includes('--write')) {
      const out = path.join(ROOT, 'docs', 'void-typology-read.md');
      fs.writeFileSync(out, lines.join('\n') + '\n');
      console.log('\n✓ wrote ' + path.relative(ROOT, out));
    }
    process.exit(0);   // a read never fails CI; it reports
  })();
}

run();
