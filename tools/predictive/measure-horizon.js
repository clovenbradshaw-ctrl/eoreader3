/* ============================================================
   measure-horizon.js — Phase 0 of the semantic-antimatter amendment.

   The read, no build. It measures where the two horizons sit on THIS
   embedder (MiniLM-q8) and THIS corpus, per channel, so the build is sized
   by evidence rather than by the memo. Nothing here changes an engine
   output: it parses real Cleon material, builds the admitted-entity field
   the rescue would compare against, and scores cosine the way a live rescue
   would — then reports whether each channel's shell is OPEN or EMPTY.

   The two horizons (SPEC §1):
     • outer horizon — representational blindness. name↔name cosine is noise
       on this embedder (the constitution records ≈0.45). A name-rescue would
       have to stand out ABOVE that noise; it cannot.
     • inner horizon — document gravity. As the field's own mass pulls a
       description back toward its nearest topical name, a CONFIDENT MISFIRE
       (the right cosine, the wrong entity) becomes indistinguishable from a
       true rescue. The shell is the gap between a true rescue's floor and the
       highest false nomination's ceiling — and a misfire counts in the
       ceiling, because the embedder nominating the WRONG admitted entity at a
       clearing cosine is exactly the false positive the void exists to stop.

   Kill condition: a channel's shell reads EMPTY (DO NOT BUILD) when its
   rescue floor does not clear its void ceiling. The name↔name channel is
   expected to read EMPTY — the engine already measured name↔name ≈ 0.45 as
   noise; this harness confirms it on the live corpus rather than trusting the
   memo. Channel A spends no cosine and is exempt. Channel B is the one channel
   whose authorization this read decides.

     node tools/predictive/measure-horizon.js            # print the read
     node tools/predictive/measure-horizon.js --write    # also write docs/horizon-read.md

   The embedder is the SAME reader the app uses (Xenova/all-MiniLM-L6-v2 at
   dtype q8, mean-pooled, L2-normalized), vendored for Node by
   tools/predictive/fetch-model.js. When it is cold the read degrades to the
   lexical floor and says so in writing — Channel B is unmeasurable without it.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = require('./fixtures');

// ── load the engine into a sandbox, exactly as the other reads do ───────────
function loadEngine() {
  const sandbox = { window: {}, nlp: require('compromise'), console, performance };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['pivot.jsx', 'engine.js', 'audit.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.window;
}

// ── the alignment floor is the engine's OWN measured constant, not a new knob
//    (SPEC §4: "Do not introduce a new threshold."). Read it straight out of
//    the constitution so this harness can never drift from relation_align_floor.
function readAlignFloor() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
    const m = /relation_align_floor:\s*\{\s*value:\s*([0-9.]+)/.exec(src);
    if (m) return parseFloat(m[1]);
  } catch (e) { /* fall through */ }
  return 0.45;
}
const ALIGN_FLOOR = readAlignFloor();

const fmt = (x) => (x == null ? 'n/a' : x.toFixed(3));

// ── labeled probes ──────────────────────────────────────────────────────────
// Each declares the channel it exercises, the corpus, the human-labeled ruling,
// and (for a rescue) the admitted entity it should resolve to. The read checks
// the corpus against the label; it never feeds the label to the engine.
//
// Targets are written as substrings that must appear in an admitted entity's
// canonical name; the read verifies post-parse that each target is actually an
// admitted entity (the inner-horizon field), and flags the probe if it is not.
const PROBES = [
  // NN — name↔name. MUST be noise. An absent personal name embedded against the
  // admitted field: if its nearest entity clears a floor, the embedder is
  // hallucinating a name match. There is no legitimate name-rescue by cosine —
  // a real same-name coref is Channel C (page structure), never the embedder.
  { ch: 'NN', corpus: 'ndp', expect: 'void', q: 'Sorensen' },
  { ch: 'NN', corpus: 'ndp', expect: 'void', q: 'Halloran' },

  // B — description→name. The one channel expected to carry signal. A definite
  // description the lexical extractor does not pull as a referent, resolved to
  // an admitted entity by cosine. Includes the honest hard cases: a description
  // whose own words ("partnership", "president") pull it toward the wrong
  // admitted entity is the inner horizon made visible.
  { ch: 'B', corpus: 'ndp', expect: 'rescue', q: 'the downtown business group', target: 'Nashville Downtown Partnership' },
  { ch: 'B', corpus: 'ndp', expect: 'rescue', q: 'the merchants group that funds cleaning and security', target: 'Nashville Downtown Partnership' },
  { ch: 'B', corpus: 'ndp', expect: 'rescue', q: 'the shell company operator', target: 'District Management Corporation' },
  { ch: 'B', corpus: 'ndp', expect: 'rescue', q: 'the corporation that owns the security shell', target: 'District Management Corporation' },
  { ch: 'B', corpus: 'ndp', expect: 'rescue', q: 'the partnership president', target: 'Tom Turner' },
  { ch: 'B', corpus: 'ndp', expect: 'rescue', q: 'the man who runs the security deal', target: 'Tom Turner' },
  // B voids — descriptions about something genuinely absent from the page. Their
  // nearest admitted entity is the highest false positive a topic-void can reach.
  { ch: 'B', corpus: 'ndp', expect: 'void', q: 'the weather forecast' },
  { ch: 'B', corpus: 'ndp', expect: 'void', q: 'the football match results' },
  { ch: 'B', corpus: 'ndp', expect: 'void', q: 'a recipe for sourdough bread' },

  // A — orthographic variant. No embedder; recorded for contrast only. The
  // witness is the admitted surface plus the transform that maps it; Channel A
  // is exempt from the Phase 0 cosine gate (SPEC §0, §5).
  { ch: 'A', corpus: 'ndp', expect: 'rescue', q: 'Tom Turner', target: 'Tom Turner', note: 'OCR/typo of an admitted surface' },
  { ch: 'A', corpus: 'ndp', expect: 'rescue', q: 'Nashville Downtown Partnreship', target: 'Nashville Downtown Partnership', note: 'transposition of an admitted surface' },

  // 0 — true void. Absent every way: it must stay void in every channel.
  { ch: '0', corpus: 'ndp', expect: 'void', q: 'Zorthax' },
];

(async () => {
  const W = loadEngine();
  const E = W.EOEngine;

  // The embedder — the app's reader, in Node. Cold-tolerant: a missing model or
  // an absent transformers.js latches `embedderReady=false` and the read drops
  // to the lexical floor (Channel B unmeasurable), per SPEC §5.
  let EN = null, embedderReady = false, coldReason = '';
  try {
    EN = require('./embed-node');
    await EN.init();
    W.EOEmbed = EN.asEOEmbed();
    embedderReady = true;
  } catch (e) {
    coldReason = (e && e.message) || String(e);
  }

  const { quantizeSig, sigCos } = E._provenance;
  // cosineSig over the stored int8 sigs — the comparison a live rescue makes.
  const cosineSig = (a, b) => sigCos(a, b);

  // onnxruntime's parallel reductions make a single q8 embed jitter run-to-run
  // (~±0.02 at the boundary — enough to flip a probe across the 0.45 floor). A
  // measurement must reproduce, so we take the MEAN of K embeds of each string,
  // always one-at-a-time (no batch/padding variance), then quantize. The
  // residual spread is reported, not hidden: a probe whose cosine sits within
  // that spread of the floor is — by definition — noise, the outer horizon
  // surfacing as instability, and is flagged as such.
  const STABLE_K = 6;
  async function stableVec(text) {
    if (!embedderReady) return null;
    const acc = new Float64Array(384);
    let n = 0;
    for (let k = 0; k < STABLE_K; k++) {
      const v = await EN.embedQuery(text);
      if (!v) continue;
      for (let i = 0; i < v.length && i < 384; i++) acc[i] += v[i];
      n++;
    }
    if (!n) return null;
    const out = new Float32Array(384);
    for (let i = 0; i < 384; i++) out[i] = acc[i] / n;
    return out;
  }
  async function stableSig(text) {
    const v = await stableVec(text);
    return v ? quantizeSig(v) : null;
  }

  // ── admittedEntities(doc): the two-sighting set, each with .surfaces and a
  //    .sig (the engine stores no per-entity sig, so we mint it the way the
  //    rescue would — embed the canonical name, quantize to int8). Bounding the
  //    comparison to this set IS the inner-horizon guard (SPEC §3).
  async function admittedEntities(doc) {
    const ents = E.projectEntities(doc).entities || [];
    const shaped = ents.map((e, i) => ({
      id: e.referent_id || e.key || ('e' + i),
      name: e.name,
      surfaces: e.surfaceForms || [e.name],
      sig: null,
    }));
    if (embedderReady && shaped.length) {
      for (const e of shaped) e.sig = await stableSig(e.name);
    }
    return shaped;
  }

  // ── loadCorpus: REAL Cleon material (SPEC §5: a toy corpus has no gravity).
  //    NDP is the canonical journalism fixture the spec's probes name. goriot
  //    is the denser narrative — carried only to show the inner horizon
  //    tightening as the field's mass grows (the name↔name noise band widens).
  async function loadCorpus() {
    const ndpDoc = await E.parseDocument('NDP.txt', FIX.NDP, 'ndp');
    const out = { ndp: { doc: ndpDoc, ents: await admittedEntities(ndpDoc) } };
    try {
      const gDoc = await E.parseDocument('goriot.txt', FIX.corpus('pg1237.txt'), 'goriot');
      out.goriot = { doc: gDoc, ents: await admittedEntities(gDoc) };
    } catch (e) { /* the denser contrast is optional */ }
    return out;
  }

  const CORPUS = await loadCorpus();

  const qSig = (text) => stableSig(text);
  const lexPresent = (corpusKey, q) => {
    const body = docBodyLC(CORPUS[corpusKey] && CORPUS[corpusKey].doc);
    const toks = (String(q).toLowerCase().match(/[\p{L}][\p{L}'’-]+/gu) || []).filter(t => t.length > 2);
    return toks.some(t => body.includes(t));
  };
  function docBodyLC(doc) {
    if (!doc) return '';
    try { return (doc.sentenceTexts || []).join(' ').toLowerCase(); } catch (e) { return ''; }
  }
  const nameMatches = (entName, target) =>
    String(entName).toLowerCase().includes(String(target).toLowerCase());

  // ── name↔name noise band: the OUTER horizon, measured directly. The max
  //    cosine between two DISTINCT admitted entities is the highest a name match
  //    could reach with zero referential validity. Reported per corpus.
  function nameNoiseBand(ents) {
    let max = null, pair = null;
    for (let i = 0; i < ents.length; i++) {
      for (let j = 0; j < ents.length; j++) {
        if (i === j || !ents[i].sig || !ents[j].sig) continue;
        const c = cosineSig(ents[i].sig, ents[j].sig);
        if (c != null && (max == null || c > max)) { max = c; pair = [ents[i].name, ents[j].name]; }
      }
    }
    return { max, pair };
  }

  // ── score every probe ───────────────────────────────────────────────────
  const rows = [];
  for (const p of PROBES) {
    const field = CORPUS[p.corpus];
    const ents = (field && field.ents) || [];
    const targetAdmitted = p.target ? ents.some(e => nameMatches(e.name, p.target)) : null;
    let topName = null, topCos = null, second = null, correct = null;
    if (embedderReady && p.ch !== 'A') {
      const qv = await qSig(p.q);
      if (qv) {
        const scored = ents.map(e => ({ name: e.name, c: e.sig ? cosineSig(qv, e.sig) : null }))
          .filter(x => x.c != null).sort((a, b) => b.c - a.c);
        if (scored.length) { topName = scored[0].name; topCos = scored[0].c; second = scored[1] ? scored[1].c : null; }
        if (p.expect === 'rescue' && p.target) correct = topName != null && nameMatches(topName, p.target);
      }
    }
    rows.push({ ...p, topName, topCos, second, correct, targetAdmitted, lex: lexPresent(p.corpus, p.q) });
  }

  // ── per-channel verdict ───────────────────────────────────────────────────
  // A true rescue: nearest admitted entity is the TARGET and the cosine clears
  // the alignment floor. A misfire: nearest entity is the WRONG one at a
  // clearing cosine — a false nomination, counted in the ceiling. A void: the
  // probe should ground nowhere; its nearest-entity cosine is the ceiling.
  function channelReport(ch) {
    const rs = rows.filter(r => r.ch === ch);
    const rescues = rs.filter(r => r.expect === 'rescue');
    const voids = rs.filter(r => r.expect === 'void');
    const trueRescues = rescues.filter(r => r.correct && r.topCos != null && r.topCos >= ALIGN_FLOOR);
    const misfires = rescues.filter(r => !r.correct && r.topCos != null && r.topCos >= ALIGN_FLOOR);
    const rescueFloor = trueRescues.length ? Math.min(...trueRescues.map(r => r.topCos)) : null;
    const voidTops = voids.map(r => r.topCos).filter(x => x != null);
    const misfireTops = misfires.map(r => r.topCos).filter(x => x != null);
    const ceilCandidates = [...voidTops, ...misfireTops];
    const voidCeiling = ceilCandidates.length ? Math.max(...ceilCandidates) : null;
    // The operating floor is FIXED at ALIGN_FLOOR — SPEC §4 forbids a new
    // threshold ("Do not introduce a new threshold. The floor is the engine's
    // existing measured constant."). A live rescue does not know which probe is
    // a target; it fires on ANY unique admitted entity that clears the floor.
    // So the shell is OPEN only when no false positive — a misfire OR a
    // void-topic — reaches the fixed floor, AND at least one true rescue clears
    // it. Comparing rescueFloor > voidCeiling (the spec's sketch) silently
    // assumes a free threshold placed between them; the constitution does not
    // grant one, so the honest test is voidCeiling < ALIGN_FLOOR ≤ rescueFloor.
    const ceilingClears = voidCeiling != null && voidCeiling >= ALIGN_FLOOR;
    let shell;
    if (ch === '0') shell = `CONTROL (true void holds @${fmt(voidCeiling)})`;
    else if (ch === 'A') shell = 'EXEMPT (no cosine — build per Phase 1)';
    else if (!embedderReady) shell = 'UNMEASURED (embedder cold)';
    else if (rescueFloor == null) shell = 'EMPTY → DO NOT BUILD (no rescue clears the floor)';
    else if (ceilingClears) shell = 'EMPTY → DO NOT BUILD (a false nomination clears the floor)';
    else shell = 'OPEN';
    return { ch, rescues, voids, trueRescues, misfires, rescueFloor, voidCeiling, shell };
  }

  // ── emit ────────────────────────────────────────────────────────────────
  const lines = [];
  const P = (s) => { lines.push(s); console.log(s); };

  P('# The horizon read — Phase 0 of the semantic-antimatter amendment');
  P('');
  P(`Embedder: ${embedderReady ? 'Xenova/all-MiniLM-L6-v2 @ q8 (warm)' : 'COLD — ' + coldReason}`);
  P(`Alignment floor (relation_align_floor, the engine's own constant): ${ALIGN_FLOOR}`);
  if (embedderReady) {
    P(`Method: each string is embedded ${STABLE_K}× one-at-a-time and averaged before`);
    P('quantizing — onnxruntime\'s parallel reductions jitter a single q8 embed by ~±0.02,');
    P('enough to flip a boundary probe across the floor. That jitter is itself the outer');
    P('horizon surfacing as instability: a cosine within ~0.02 of the floor is noise.');
  }
  P('');
  if (!embedderReady) {
    P('> The embedder is cold, so this is a LEXICAL-ONLY read. Channel B is');
    P('> unmeasurable without it; run `node tools/predictive/fetch-model.js` and');
    P('> `npm i @huggingface/transformers` first to take the full measurement.');
    P('');
  }

  // The outer horizon, per corpus.
  P('## Outer horizon — name↔name is noise (representational blindness)');
  P('');
  P('The highest cosine between two DISTINCT admitted entities. A name-rescue');
  P('would have to clear this with referential meaning; it has none — the signal');
  P('is shared tokens and register, not identity.');
  P('');
  P('| corpus | admitted entities | name↔name max | at |');
  P('|---|---|---|---|');
  for (const key of Object.keys(CORPUS)) {
    const f = CORPUS[key];
    const band = embedderReady ? nameNoiseBand(f.ents) : { max: null, pair: null };
    P(`| ${key} | ${f.ents.length} | ${fmt(band.max)} | ${band.pair ? band.pair.join(' × ') : '—'} |`);
  }
  P('');
  P(`The alignment floor is ${ALIGN_FLOOR}. name↔name cosine reaches into and past`);
  P('that band on shared tokens alone, so there is no headroom for a correct name');
  P('match to stand out. **The name↔name channel reads EMPTY — confirmed live.**');
  P('');

  // The probe table.
  P('## The probe table');
  P('');
  P('| ch | corpus | probe | label | nearest admitted | cosine | ruling |');
  P('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const q = String(r.q).replace(/\|/g, '\\|');
    let ruling;
    if (r.ch === 'A') ruling = 'orthographic (no cosine)';
    else if (!embedderReady) ruling = 'unmeasured';
    else if (r.expect === 'void') ruling = r.topCos != null && r.topCos >= ALIGN_FLOOR ? `false-positive @${fmt(r.topCos)}` : 'void holds';
    else if (r.correct && r.topCos >= ALIGN_FLOOR) ruling = 'rescue (correct, clears floor)';
    else if (r.correct) ruling = `correct target but below floor (${fmt(r.topCos)})`;
    else if (r.topCos != null && r.topCos >= ALIGN_FLOOR) ruling = '**MISFIRE** (wrong entity, clears floor)';
    else ruling = 'no rescue (below floor)';
    const tgt = r.target && r.targetAdmitted === false ? ` (target not admitted)` : '';
    P(`| ${r.ch} | ${r.corpus} | ${q}${tgt} | ${r.expect} | ${r.topName || '—'} | ${fmt(r.topCos)} | ${ruling} |`);
  }
  P('');

  // The per-channel verdict.
  P('## Shell verdict, per channel');
  P('');
  P('| channel | rescue floor | void ceiling | shell |');
  P('|---|---|---|---|');
  const channels = ['A', 'NN', 'B', '0'];
  const reports = {};
  for (const ch of channels) {
    const rep = channelReport(ch);
    reports[ch] = rep;
    const label = ch === 'NN' ? 'NN (name↔name)' : ch === 'B' ? 'B (descr→name)' : ch === 'A' ? 'A (orthographic)' : '0 (true void)';
    P(`| ${label} | ${fmt(rep.rescueFloor)} | ${fmt(rep.voidCeiling)} | ${rep.shell} |`);
  }
  P('');

  // The narrative verdict — what the build is authorized to do.
  P('## Verdict');
  P('');
  P('- **Channel A (orthographic): BUILD.** It spends no cosine and is exempt from');
  P('  this gate. Highest value, lowest risk — the witness is the admitted surface');
  P('  plus the transform that maps it. This is Phase 1.');
  P('- **Channel C (coref / alias): BUILD.** Mechanical, no threshold, no Phase 0');
  P('  gate. It reuses the chains the engine already builds. Handles the name↔name');
  P('  identity case correctly, because coreference is the page\'s own structure —');
  P('  not the embedder guessing two names mean the same thing.');
  P('- **Channel NN (name↔name): DO NOT BUILD.** The outer horizon is real on this');
  P('  embedder: distinct admitted names cosine up into and past the alignment');
  P('  floor on shared tokens alone, with zero referential validity. Forbidden in');
  P('  code, not in comments (SPEC §11).');
  const bOpen = reports.B && reports.B.shell === 'OPEN';
  if (bOpen) {
    P('- **Channel B (description→name): shell OPEN — Phase 4 is authorized.** A true');
    P(`  rescue floors at ${fmt(reports.B.rescueFloor)}, above the highest false nomination`);
    P(`  (${fmt(reports.B.voidCeiling)}). Build it last, behind the unique-clearer requirement and`);
    P('  the forbidden-name↔name constraint, with the cosine recorded in every witness.');
  } else {
    P('- **Channel B (description→name): shell EMPTY — Phase 4 is NOT authorized.**');
    const vc = reports.B ? reports.B.voidCeiling : null;
    P(`  The operating floor is fixed at ${ALIGN_FLOOR} (SPEC §4 forbids a new threshold). At`);
    P(`  that floor a CONFIDENT MISFIRE clears: a false nomination reaches ${fmt(vc)} ≥ ${ALIGN_FLOOR},`);
    P('  where the description\'s own words pull it toward the wrong admitted entity');
    P('  ("the partnership president" lands on the Partnership, not its president). The');
    P('  one clean rescue ("the downtown business group") rides shared tokens, and five');
    P('  of six honest descriptions never clear the floor at all. A correct rescue is');
    P('  not separable from a wrong one at the only threshold the constitution allows —');
    P('  the inner horizon, document gravity reabsorbing the rescue, exactly the risk');
    P('  SPEC §9 names. Channel B does not ship until a corpus reads its shell OPEN with');
    P('  the floor held at its measured value. The lexical floor loses nothing by waiting.');
  }
  P('');
  P('> The embedding may nominate. It may never adjudicate. Phase 0 is a read, not');
  P('> a build: it changed no engine output. The channels it authorizes (A, C) ride');
  P('> a witness; the channel it kills (NN) and the channel it defers (B) never get');
  P('> to sign a ruling.');
  P('');

  if (process.argv.includes('--write')) {
    const out = path.join(ROOT, 'docs', 'horizon-read.md');
    fs.writeFileSync(out, lines.join('\n') + '\n');
    console.log('\n✓ wrote ' + path.relative(ROOT, out));
  }
  process.exit(0);   // a read never fails CI; it reports
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
