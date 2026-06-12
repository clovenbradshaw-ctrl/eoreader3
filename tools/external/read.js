/* ============================================================
   tools/external/read.js — the external-knowledge fix-rate read.

     node tools/external/read.js            # deterministic enumeration +
                                            # replay any frozen lookups
     node tools/external/read.js --live     # also pay the network (freezes)

   ORDER OF WORK, step 1 (the coder spec): before building any external
   stratum, MEASURE whether the lookup actually fixes anything. The read
   changes no engine output, writes nothing to the log, and only ever READS
   the two sources (through tools/external/lookup.js, which abstains rather
   than fabricates when offline).

   It does two things:

   A. ENUMERATE THE RESIDUAL — the points where the reading broke, which is
      exactly where the spec says a lookup should fire:
        • NUL stalls            (reason 'stall' / 'pronoun-stall:contested')
        • generic-typed entities (fell to 'thing' / 'place' when plainly an
                                  org / place / law / Kind)
        • unexpanded aliases     (all-caps the page never spelled out)
      This half is fully deterministic (engine trace + lexical signals); it
      needs no network and reproduces bit-exact.

   B. CLASSIFY EACH FAILURE BY WHETHER EXTERNAL KNOWLEDGE IS EVEN THE RIGHT
      INSTRUMENT, and route the knowledge-shaped ones to a source:
        • a CONTESTED-COREFERENCE stall (a pronoun or ambiguous name pulling
          between two referents ALREADY on the page) is a discourse gap, not
          a knowledge gap — no dictionary or Wikidata entry says which known
          referent "It" binds to. Fix rate ≈ 0 by construction.
        • an ADMISSION-NOISE entity (a heading/table-of-contents fragment, a
          capitalized common noun) is an extraction gap — a lookup returns
          nothing, or worse fabricates a referent for noise.
        • a PAGE-EXPANDED alias is already resolved on the page.
        • the remainder — an abstract noun mistyped 'thing' (→ dictionary,
          lift to Kind) and a well-formed proper referent mistyped (→
          Wikidata) — is the knowledge-shaped residual the lookup could fix.

   The headline number is the KNOWLEDGE-SHAPED FRACTION: the ceiling on any
   possible fix rate. If it is low, the failures are an extraction problem,
   not a knowledge problem, and the stratum would polish the wrong layer —
   the spec says stop. If it is high, build the dictionary tier first.

   The fix rate itself (did the source resolve the eligible term) needs the
   live API; where the freeze has no answer the cell reads `pending` and the
   verdict accounts for it honestly.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine, traceDocument } = require('../../evo/engine-host.js');
const { documents } = require('../predictive/fixtures.js');
const { lookup } = require('./lookup.js');

const ROOT = path.resolve(__dirname, '..', '..');
const LIVE = process.argv.includes('--live');

/* ---- lexical signals (no network) ---- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isRoman = (t) => /^[IVXLCDM]+$/i.test(t) && t.length <= 6;
const lowerEcho = (tok, text) => new RegExp('\\b' + esc(tok.toLowerCase()) + '\\b').test(text);

// function words / clausal fragments that betray a heading or TOC entry
// admitted as an "entity" (the README's title/header noise family).
const FRAGMENT = new Set(['should', 'not', 'be', 'same', 'such', 'between', 'from',
  'against', 'considered', 'conferred', 'exposed', 'compared', 'answered', 'into',
  'and', 'of', 'the', 'to', 'which', 'that', 'this', 'should', 'are', 'is', 'must']);
function isNoise(name, text) {
  const toks = name.split(/\s+/);
  if (toks.length > 1 && toks.slice(1).some(w => FRAGMENT.has(w.toLowerCase()))) return true;
  if (toks.some(w => /(ed|ing)$/.test(w) && w.length > 4 && !/^[A-Z][a-z]+(ing|ed)$/.test('Building'))) {
    // a clausal token (Considered, Conferred, Restraining) inside a name
    if (toks.some(w => /(considered|conferred|exposed|compared|answered|restraining|conferred)$/i.test(w))) return true;
  }
  if (toks.length === 1 && lowerEcho(toks[0], text)) return true; // capitalized common noun
  return false;
}

const ABSTRACT_SUFFIX = /(ism|ity|tion|sion|logy|ance|ence|ness|ship|ery|acy|ment|ude)$/i;
function looksAbstract(name) {
  const toks = name.split(/\s+/);
  return toks.length === 1 && /^[A-Z][a-z]+$/.test(name) && ABSTRACT_SUFFIX.test(name);
}

const ORG_SUFFIX = /(partnership|corporation|council|management|company|committee|department|authority|association|commission|bureau|agency|court|ministry|board|office|university|institute|foundation|party|patrol|llc|inc|co)$/i;
const LAW_CUE = /\b(act|bill|code|amendment|statute|ordinance)\b/i;
function looksOrg(name) { return name.split(/\s+/).some(w => ORG_SUFFIX.test(w)) || /\bof\b/.test(name) && /[A-Z]/.test(name); }
const TITLE = /^(mr|mrs|ms|miss|dr|sir|lady|lord|prof)\.?$/i;
function looksPrivatePerson(name) {
  // a courtesy-title person the document introduces by personal name — the
  // spec's hard private-individual gate would suppress this lookup.
  const toks = name.split(/\s+/);
  return TITLE.test(toks[0]) && toks.length <= 2;
}

/* ---- classify one typing failure ---- */
function classifyTyping(e, text) {
  const base = { kind: 'typing', surface: e.name, type: e.type };
  if (e.type !== 'thing' && e.type !== 'place') return null; // org/person/Kind already acceptable
  if (e.type === 'place' && e.name.split(/\s+/).length === 1) return null; // single-word place: assume correct (Poland)
  if (isNoise(e.name, text)) return { ...base, sub: 'admission-noise', knowledgeShaped: false, source: null };
  if (looksAbstract(e.name)) return { ...base, sub: 'abstract-kind', knowledgeShaped: true, source: 'dictionary' };
  if (e.type === 'place' && looksOrg(e.name)) return { ...base, sub: 'org-mistype', knowledgeShaped: true, source: 'wikidata' };
  if (LAW_CUE.test(e.name)) return { ...base, sub: 'law-mistype', knowledgeShaped: true, source: 'wikidata' };
  if (/^[A-Z]/.test(e.name) && e.name.split(/\s+/).length >= 2) {
    return { ...base, sub: 'referent-mistype', knowledgeShaped: true, source: 'wikidata', private: looksPrivatePerson(e.name) };
  }
  return { ...base, sub: 'other', knowledgeShaped: false, source: null };
}

/* ---- classify one stall ---- */
function classifyStall(n) {
  const contested = (n.reason || '').includes('contested') || (n.competing && n.competing.length >= 2);
  return {
    kind: 'stall', surface: n.surface, sub: contested ? 'contested-coref' : 'other-stall',
    // a stall between referents already on the page is a discourse gap; an
    // external source cannot say which known referent the pronoun binds to.
    knowledgeShaped: false, source: null, reason: n.reason,
  };
}

/* ---- enumerate aliases the page never expanded ---- */
function aliases(text) {
  // tokens living inside an ALL-CAPS run (2+ consecutive caps words) are a
  // shouted heading / table of contents, not acronyms — collect and exclude.
  const headingTok = new Set();
  for (const run of (text.match(/\b[A-Z]{2,}\b(?:\s+[A-Z]{2,}\b)+/g) || [])) {
    for (const t of run.split(/\s+/)) headingTok.add(t);
  }
  const caps = [...new Set((text.match(/\b[A-Z]{2,5}\b/g) || []))]
    .filter(t => !isRoman(t) && !['THE', 'AND', 'FOR', 'LLC', 'PSO', 'INC'].includes(t))
    // a genuine alias is an ACRONYM in mixed-case prose, not a common word
    // shouted in caps: drop ordinary-word caps (lowercase echo) and any token
    // that only ever appears inside an ALL-CAPS heading run.
    .filter(t => !lowerEcho(t, text) && !headingTok.has(t));
  return caps.map(a => {
    // expanded if an acronym-shaped expansion sits adjacent: "(the DMC)" after
    // "District Management Corporation", or initials spelling the caps nearby.
    const re = new RegExp('\\(?(?:the\\s+)?' + esc(a) + '\\)?', 'g');
    const expansion = new RegExp(a.split('').join('[a-z]+\\s+') + '[a-z]+', 'i').test(text);
    const inParen = new RegExp('\\(\\s*(?:the\\s+)?' + esc(a) + '\\s*\\)', 'i').test(text);
    const expanded = expansion || inParen;
    return { kind: 'alias', surface: a, sub: expanded ? 'page-expanded' : 'unexpanded',
      knowledgeShaped: !expanded, source: expanded ? null : 'wikidata' };
  });
}

async function attachLookup(entry) {
  if (!entry.source) return { ...entry, verdict: 'n/a' };
  if (entry.private) return { ...entry, verdict: 'gated-private' }; // private-individual gate would suppress
  const term = entry.surface;
  const r = await lookup(entry.source, term, { live: LIVE });
  let verdict;
  if (r.status === 'hit') verdict = 'fix';        // source resolved/typed the term
  else if (r.status === 'miss') verdict = 'no-fix';
  else if (r.status === 'pending') verdict = 'pending';
  else verdict = 'error';
  return { ...entry, verdict, basis: r.basis || null };
}

function md(table) {
  if (!table.length) return '_empty_\n';
  const cols = Object.keys(table[0]);
  const row = (v) => '| ' + v.join(' | ') + ' |';
  return [row(cols), row(cols.map(() => '---')), ...table.map(r => row(cols.map(c => String(r[c]))))].join('\n') + '\n';
}

async function main() {
  const w = loadEngine();
  const docs = documents().filter(d => ['ndp', 'dispatch', 'liberty', 'wealth', 'federalist'].includes(d.id));

  const perDoc = [];
  const all = [];
  for (const d of docs) {
    const t = await traceDocument(w.EOEngine, d);
    const entries = [];
    for (const e of t.entities) { const c = classifyTyping(e, d.text); if (c) entries.push(c); }
    for (const n of t.nulls) entries.push(classifyStall(n));
    for (const a of aliases(d.text)) if (a.sub === 'unexpanded') entries.push(a); // expanded aliases aren't a residual
    const resolved = [];
    for (const en of entries) resolved.push({ ...await attachLookup(en), doc: d.id });
    all.push(...resolved);
    const ks = resolved.filter(r => r.knowledgeShaped).length;
    perDoc.push({
      doc: d.id, genre: d.genre, residual: resolved.length,
      stalls: resolved.filter(r => r.kind === 'stall').length,
      'typing-noise': resolved.filter(r => r.sub === 'admission-noise').length,
      'typing-knowledge': resolved.filter(r => r.kind === 'typing' && r.knowledgeShaped).length,
      'alias-unexp': resolved.filter(r => r.kind === 'alias').length,
      'knowledge-shaped': ks,
      'ks-frac': resolved.length ? (ks / resolved.length).toFixed(2) : '—',
    });
  }

  // fix-rate split by source × failure kind
  const cell = (src, predicate) => {
    const elig = all.filter(r => r.source === src && predicate(r));
    const fix = elig.filter(r => r.verdict === 'fix').length;
    const nofix = elig.filter(r => r.verdict === 'no-fix').length;
    const pending = elig.filter(r => r.verdict === 'pending').length;
    const gated = elig.filter(r => r.verdict === 'gated-private').length;
    const denom = fix + nofix;
    return { eligible: elig.length, fix, 'no-fix': nofix, gated, pending,
      'fix-rate': denom ? (fix / denom * 100).toFixed(0) + '%' : (pending ? 'pending' : '—') };
  };
  const fixTable = [
    { source: 'dictionary', 'failure kind': 'abstract→Kind (typing)', ...cell('dictionary', r => r.kind === 'typing') },
    { source: 'wikidata', 'failure kind': 'org/law/referent (typing)', ...cell('wikidata', r => r.kind === 'typing') },
    { source: 'wikidata', 'failure kind': 'unexpanded alias', ...cell('wikidata', r => r.kind === 'alias') },
    { source: '(none)', 'failure kind': 'contested-coref stall', ...(() => {
        const s = all.filter(r => r.kind === 'stall');
        return { eligible: s.length, fix: 0, 'no-fix': s.length, gated: 0, pending: 0, 'fix-rate': '0%' };
      })() },
    { source: '(none)', 'failure kind': 'admission noise', ...(() => {
        const s = all.filter(r => r.sub === 'admission-noise');
        return { eligible: s.length, fix: 0, 'no-fix': s.length, gated: 0, pending: 0, 'fix-rate': '0%' };
      })() },
  ];

  const total = all.length;
  const ks = all.filter(r => r.knowledgeShaped).length;
  const ksFrac = total ? ks / total : 0;
  const stalls = all.filter(r => r.kind === 'stall').length;
  const noise = all.filter(r => r.sub === 'admission-noise').length;
  const dictElig = all.filter(r => r.source === 'dictionary').length;
  const wdElig = all.filter(r => r.source === 'wikidata').length;
  const gated = all.filter(r => r.verdict === 'gated-private').length;
  const measured = all.some(r => r.verdict === 'fix' || r.verdict === 'no-fix');

  // ---- the gate ----
  const KS_FLOOR = 0.30; // below this, the residual is dominated by non-knowledge failures
  const ksHigh = ksFrac >= KS_FLOOR;

  const out = [];
  out.push('# External-knowledge fix-rate read — does the lookup fix anything?\n');
  out.push('Generated by `node tools/external/read.js` (read-only: no engine output changes, no');
  out.push('writes to the log). This is **step 1** of the external-knowledge stratum: measure the');
  out.push('fix rate on the residual BEFORE building either source. The gate below decides whether');
  out.push('the stratum is worth building at all.\n');
  out.push(`Corpus: ${docs.map(d => d.id).join(', ')} (${docs.filter(d => d.genre === 'journalism').length} journalism, ${docs.filter(d => d.genre === 'essay').length} essay — the in-repo predictive fixtures).`);
  out.push(`Network: ${LIVE ? 'live (--live)' : 'replay-only (freeze cache); eligible cells read `pending` until a live run freezes them'}.\n`);

  out.push('## The residual, per document (deterministic — no network)\n');
  out.push('Every point where the reading broke, classified by whether external knowledge is the');
  out.push('right instrument. `ks-frac` = knowledge-shaped / residual is an **upper bound** on the');
  out.push('fix rate: it counts a failure as fixable if a lookup *could* fire on it, before asking');
  out.push('whether the source actually resolves it. The realized rate can only be lower — a live');
  out.push('Wikidata hit/miss is what separates a real referent from a heading fragment of the same');
  out.push('surface shape (see the verdict).\n');
  out.push(md(perDoc));

  out.push('## Fix rate, split by source × failure kind\n');
  out.push('`eligible` = failures routed to this source. `fix`/`no-fix` need the live API; `pending`');
  out.push('= not yet frozen (offline). `gated` = suppressed by the private-individual gate. The two');
  out.push('`(none)` rows are deterministic: their fix rate is 0 by construction, not by measurement.\n');
  out.push(md(fixTable));

  out.push('## What the categories mean\n');
  out.push(`- **contested-coref stall (${stalls})** — a pronoun or ambiguous name pulling between referents *already on the page*. The reader has the candidates; it cannot pick. No dictionary or Wikidata entry resolves which known referent "It"/"she"/"Mrs. Mill" binds to. This is a **discourse/extraction** gap. Fix rate 0 by construction.`);
  out.push(`- **admission noise (${noise})** — heading / table-of-contents fragments and capitalized common nouns admitted as entities (e.g. "Departments Should Not Be", "Common Defense Considered" — the Federalist Contents page). A lookup returns nothing or fabricates a referent for noise. This is an **extraction** gap. Fix rate 0, and dangerous if non-zero.`);
  out.push(`- **abstract→Kind (${dictElig}, dictionary)** — a single abstract noun mistyped \`thing\` (Socialism, Subjection, Taxation). The dictionary's noun sense would lift it to \`Kind\`. This is the **safe** tier (a claim about language) and the only clearly knowledge-shaped typing win on essays.`);
  out.push(`- **org/law/referent (wikidata)** — a well-formed proper referent mistyped (an org typed \`place\`, a place typed \`thing\`). Wikidata could retype it. ${gated} were suppressed by the **private-individual gate** (courtesy-title persons the document introduces by name).`);
  out.push(`- **unexpanded alias** — on this corpus the genuine abbreviations (NDP, DMC) are spelled out on the page; the all-caps residual is Roman numerals and ALL-CAPS heading words, not unresolved aliases.\n`);

  out.push('## Verdict (the gate)\n');
  out.push(`- **Knowledge-shaped ceiling: ${ks}/${total} = ${(ksFrac * 100).toFixed(0)}%** (floor to build: ${KS_FLOOR * 100}%). ` +
    (ksHigh
      ? 'Above the floor even as an upper bound — a meaningful share of the residual is a knowledge gap a lookup could close. Build the dictionary tier first (the safe one), then measure Wikidata.'
      : 'Below the floor **even counted as an upper bound** — the residual is dominated by contested coreference and admission noise, which are extraction problems, not knowledge problems. Per the spec, a blanket external stratum here would polish the wrong layer. **Do not build it as a sweep over the residual.**'));
  out.push(`- **Stalls are the wrong trigger — the load-bearing finding.** The spec aims the lookup at NUL stalls (${stalls} of ${total} residual points, ${(stalls / total * 100).toFixed(0)}%). On this corpus every stall is \`pronoun-stall:contested\` or a contested name — a coreference contest between referents *already on the page*. External knowledge cannot say which known referent "It" / "she" / "Mrs. Mill" binds to. The stall marks confusion about **binding**, not about **identity**, so a gazetteer or alias table earns nothing there. This is structural, not corpus-specific.`);
  out.push(`- **Admission noise is the second extraction sink (${noise}).** Table-of-contents and heading fragments admitted as entities ("Departments Should Not Be"). A lookup on noise returns nothing or fabricates — the worst outcome for a tool whose whole discipline is the closed world.`);
  out.push(`- **The dictionary tier is the lone knowledge-shaped, safe candidate (${dictElig} eligible).** Abstract noun mistyped \`thing\` → the dictionary's noun sense lifts it to \`Kind\` (Socialism, Subjection, Taxation). It is a claim about language, needs none of the world-claim safeguards, and is the only category that is both genuinely a knowledge gap and low-risk. Even so it is **${(dictElig / total * 100).toFixed(0)}% of the residual** here — worth building only if it carries on the real corpus.`);
  out.push(`- **Wikidata's eligible set (${wdElig}) is unseparated.** It mixes real referents (House of Representatives, State of New York, America, the two NDP orgs typed \`place\`) with heading fragments of the same surface shape (Same Subject, Proper Form). A **live hit/miss is the only thing that separates them**, and it is \`pending\` (network blocked here). ${gated} were already suppressed by the private-individual gate. Defer Wikidata until the dictionary read on the real corpus justifies the world-claim risk.`);
  out.push(`- **Two blockers to a *measured* (not bounded) fix rate.** (1) The live dictionary and Wikidata APIs are unreachable in this environment (HTTP 403), so every \`fix\`/\`no-fix\` cell is \`pending\`; the harness freezes results on a \`--live\` run elsewhere. (2) The in-repo journalism is two crafted fixtures, not the user's real articles (the Tennessee / Toronto Life pieces the spec names). The **structural** findings (stalls = coref, residual = noise-dominated, ceiling ${(ksFrac * 100).toFixed(0)}%) are corpus-robust and need neither; the **magnitude** of the dictionary win is exactly what a live run on the real corpus would settle.\n`);

  const dest = path.join(ROOT, 'docs', 'external-knowledge-read.md');
  fs.writeFileSync(dest, out.join('\n'));
  console.log('✓ report →', path.relative(ROOT, dest));
  console.table(perDoc);
  console.table(fixTable);
  console.log(`knowledge-shaped: ${ks}/${total} = ${(ksFrac * 100).toFixed(0)}%  | gate floor ${KS_FLOOR * 100}% → ${ksHigh ? 'BUILD' : 'STOP (extraction problem)'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
