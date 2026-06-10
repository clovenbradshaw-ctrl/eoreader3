/* ============================================================
   evo/allowlist.js — THE CONSTITUTION, AS CODE.

   The agent amends the laws; it never amends the constitution. This file
   is the mechanical boundary. A proposed change is validated here BEFORE
   it is applied or scored — out-of-bounds changes are rejected with no
   rerun and no API cost.

   Safety principle — POSITIVE ALLOW-LISTING:
     A change is accepted only if every line it touches falls inside an
     EVOLVABLE region. The constitutional surfaces (evaDraft,
     groundTalkerOutput, bindCitations, projectGraph, the operator
     emission, the append-only log) are simply NOT evolvable regions, so
     edits to them are rejected by construction — not by a denylist that
     must enumerate every forbidden line. The denylist below is
     defense-in-depth and better error messages, not the gate.

   What the agent MAY evolve (engine.js only):
     • Physics constants: decay_gamma, inertia_delta, mass_weight
       (+ the distance-gravity rules gravity_alpha / gravity_offset when
        present), and any READING_RULES entry whose src is 'hardcoded-seed'
        or whose src is a 'language-module:*' (attribution patterns,
        pronoun inventories, title tokens, clitic suffixes, …).
     • The talker prompts composed in talkerPortrait: the `system`
       (draft instructions) and the retry-sharpening `sys` reassignment.

   Carve-out (constitutional, despite being hardcoded-seed):
     audit_bind_floor, audit_resemblance, audit_paraphrase_strong
     parameterize the mechanical grounder / auditor. The spec puts
     "citation binding" off limits as an integrity guarantee, so these
     thresholds are NOT evolvable even though their src is hardcoded-seed.
     Resolving the spec's two clauses in favor of the integrity clause.
   ============================================================ */
'use strict';

// READING_RULES that are evolvable by NAME even though their src is a
// medium-constant. The spec names exactly these three physics knobs.
const NAMED_PHYSICS = new Set(['decay_gamma', 'inertia_delta', 'mass_weight']);

// Distance-gravity ledger rules — evolvable when/if the distance law lands.
const GRAVITY_LAW = new Set(['gravity_alpha', 'gravity_offset']);

// hardcoded-seed rules that are nonetheless CONSTITUTIONAL because they
// parameterize the mechanical grounder/auditor (integrity guarantee).
const SEED_BUT_CONSTITUTIONAL = new Set(['audit_bind_floor', 'audit_resemblance', 'audit_paraphrase_strong']);

// Constitutional functions — never evolvable. Used for clearer rejection
// messages; the positive allow-list is the real gate.
const CONSTITUTIONAL_FNS = ['evaDraft', 'groundTalkerOutput', 'bindCitations', 'bindCitationsScope', 'projectGraph', 'extractEoGraph'];

/* Decide whether a READING_RULES entry is evolvable, from its parsed
   src/module and name. Returns { evolvable, reason }. */
function classifyRule(name, src, module) {
  if (SEED_BUT_CONSTITUTIONAL.has(name))
    return { evolvable: false, reason: 'constitutional: parameterizes the mechanical grounder/auditor (citation-binding integrity)' };
  if (NAMED_PHYSICS.has(name))
    return { evolvable: true, reason: 'named physics constant (decay_gamma/inertia_delta/mass_weight)' };
  if (GRAVITY_LAW.has(name))
    return { evolvable: true, reason: 'distance-gravity law rule' };
  if (src === 'hardcoded-seed')
    return { evolvable: true, reason: "src='hardcoded-seed'" };
  if (typeof src === 'string' && src.startsWith('language-module:'))
    return { evolvable: true, reason: 'language-module rule (' + src + ')' };
  return { evolvable: false, reason: src ? ("src='" + src + "' is not in the MAY-evolve set") : 'unknown rule' };
}

/* ---- source parsing: discover region line spans (1-based, inclusive) ---- */

// Match braces on a line, ignoring those inside single/double quotes and
// inside line comments. Good enough for engine.js's well-formed object
// literals (no template literals inside READING_RULES). Returns net depth
// delta for the line.
function braceDelta(line) {
  let depth = 0, inS = false, inD = false, esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) { if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '/' && line[i + 1] === '/') break; // line comment
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth;
}

// Find the line index (0-based) of the first line matching `re` at/after `from`.
function findLine(lines, re, from = 0) {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

// From a line known to open a brace block, return the 0-based line index
// where its depth returns to 0.
function matchBlockEnd(lines, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    depth += braceDelta(lines[i]);
    if (i > startIdx && depth <= 0) return i;
    if (i === startIdx && depth === 0) return i; // single-line block
  }
  return lines.length - 1;
}

/* Parse the READING_RULES object into per-rule spans + classification. */
function readingRulesRegions(lines) {
  const out = {};
  const blockStart = findLine(lines, /const\s+READING_RULES\s*=\s*\{/);
  if (blockStart < 0) return out;
  const blockEnd = matchBlockEnd(lines, blockStart);
  let i = blockStart + 1;
  while (i < blockEnd) {
    const m = lines[i].match(/^\s{2}([A-Za-z_]\w*)\s*:\s*\{/);
    if (!m) { i++; continue; }
    const name = m[1];
    const end = matchBlockEnd(lines, i);
    const text = lines.slice(i, end + 1).join('\n');
    const srcM = text.match(/src:\s*'([^']*)'/);
    const modM = text.match(/module:\s*'([^']*)'/);
    const cls = classifyRule(name, srcM ? srcM[1] : null, modM ? modM[1] : null);
    out[name] = { name, startLine: i + 1, endLine: end + 1, src: srcM ? srcM[1] : null, module: modM ? modM[1] : null, ...cls };
    i = end + 1;
  }
  return out;
}

/* Locate the talker-prompt editable spans inside talkerPortrait: the
   `const system = …;` (draft instructions) and the `sys = system + …;`
   (retry-sharpening hint). Returns { system, retry } spans or nulls. */
function talkerPromptRegions(lines) {
  const fn = findLine(lines, /(async\s+)?function\s+talkerPortrait\s*\(/);
  if (fn < 0) return { system: null, retry: null };
  const fnEnd = matchBlockEnd(lines, fn);
  const stmtSpan = (anchorRe) => {
    const s = findLine(lines, anchorRe, fn);
    if (s < 0 || s > fnEnd) return null;
    // Statement ends at the first line (>= s) ending in ';'
    let e = s;
    while (e < fnEnd && !/;\s*$/.test(lines[e])) e++;
    return { startLine: s + 1, endLine: e + 1 };
  };
  return {
    system: stmtSpan(/^\s*const\s+system\s*=/),
    retry: stmtSpan(/^\s*sys\s*=\s*system\s*\+/),
  };
}

/* Constitutional function spans (for messages / defense-in-depth). */
function constitutionalRegions(lines) {
  const out = {};
  for (const name of CONSTITUTIONAL_FNS) {
    const sig = findLine(lines, new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
    if (sig < 0) continue;
    const open = findLine(lines, /\{/, sig);
    if (open < 0) continue;
    out[name] = { name, startLine: sig + 1, endLine: matchBlockEnd(lines, open) + 1 };
  }
  return out;
}

/* Build the full region map for an engine source string. */
function buildRegionMap(engineSource) {
  const lines = engineSource.split('\n');
  return {
    lines,
    rules: readingRulesRegions(lines),
    talker: talkerPromptRegions(lines),
    constitutional: constitutionalRegions(lines),
  };
}

/* Is a 1-based line inside any EVOLVABLE region? Returns the region descriptor. */
function evolvableAt(map, line) {
  for (const r of Object.values(map.rules)) {
    if (r.evolvable && line >= r.startLine && line <= r.endLine) return { kind: 'rule', name: r.name, reason: r.reason };
  }
  if (map.talker.system && line >= map.talker.system.startLine && line <= map.talker.system.endLine)
    return { kind: 'talker-prompt', name: 'system', reason: 'talker draft instructions' };
  if (map.talker.retry && line >= map.talker.retry.startLine && line <= map.talker.retry.endLine)
    return { kind: 'talker-prompt', name: 'retry', reason: 'talker retry-sharpening hint' };
  return null;
}

/* Which constitutional region (if any) contains a line — for messages. */
function constitutionalAt(map, line) {
  for (const r of Object.values(map.constitutional)) {
    if (line >= r.startLine && line <= r.endLine) return r.name;
  }
  return null;
}

/* ---- diff parsing: which engine.js line numbers does a hunk touch? ----
   We validate against the OLD-file line numbers (the lines being removed /
   the anchor of an insertion), which is what the region map describes. */
function parseUnifiedDiff(diffText) {
  const files = [];
  let cur = null;
  const lines = String(diffText).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\+\+\+\s+(?:b\/)?(\S+)/))) {
      cur = { path: m[1], touched: new Set() };
      files.push(cur);
      continue;
    }
    if ((m = l.match(/^---\s+(?:a\/)?(\S+)/))) {
      // path captured on +++; ignore
      continue;
    }
    if ((m = l.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/))) {
      if (!cur) continue;
      let oldLine = parseInt(m[1], 10);
      // walk the hunk body
      let j = i + 1;
      for (; j < lines.length; j++) {
        const bl = lines[j];
        if (/^@@/.test(bl) || /^(---|\+\+\+|diff )/.test(bl)) break;
        if (bl.startsWith('-')) { cur.touched.add(oldLine); oldLine++; }
        else if (bl.startsWith('+')) { cur.touched.add(oldLine); /* insertion anchored at oldLine */ }
        else if (bl.startsWith(' ')) { oldLine++; }
        else if (bl === '\\ No newline at end of file') { /* ignore */ }
        else if (bl === '') { oldLine++; }
        else break;
      }
      i = j - 1;
    }
  }
  return files;
}

/* Validate a unified diff against the constitution.
   engineRelPath: the path the diff is expected to target (e.g. 'engine.js'). */
function validateDiff(engineSource, diffText, engineRelPath = 'engine.js') {
  const map = buildRegionMap(engineSource);
  const files = parseUnifiedDiff(diffText);
  const rejected = [];
  const touchedRegions = new Set();

  if (!files.length) rejected.push({ reason: 'no file headers found in diff' });

  for (const f of files) {
    const base = f.path.split('/').pop();
    if (base !== engineRelPath.split('/').pop()) {
      rejected.push({ path: f.path, reason: 'path outside the allowlist — only ' + engineRelPath + ' may be patched' });
      continue;
    }
    for (const line of f.touched) {
      const ev = evolvableAt(map, line);
      if (!ev) {
        const con = constitutionalAt(map, line);
        rejected.push({ path: f.path, line, reason: con
          ? ('touches constitutional function `' + con + '` — off limits')
          : 'line is outside every MAY-evolve region' });
      } else {
        touchedRegions.add(ev.kind + ':' + ev.name);
      }
    }
  }
  return { ok: rejected.length === 0, rejected, touchedRegions: [...touchedRegions], map };
}

/* Validate a STRUCTURED edit by its declared target (cheap, pre-render).
   See renderEdits for the edit shapes. */
function validateStructuredEdit(map, edit) {
  if (!edit || typeof edit !== 'object') return { ok: false, reason: 'edit is not an object' };
  switch (edit.kind) {
    case 'rule-value':
    case 'rule-tokens-add':
    case 'rule-tokens-remove': {
      const r = map.rules[edit.rule];
      if (!r) return { ok: false, reason: 'unknown rule `' + edit.rule + '`' };
      if (!r.evolvable) return { ok: false, reason: 'rule `' + edit.rule + '` is not evolvable — ' + r.reason };
      return { ok: true, region: { kind: 'rule', name: edit.rule, reason: r.reason } };
    }
    case 'prompt-edit': {
      const slot = edit.slot === 'retry' ? map.talker.retry : (edit.slot === 'system' ? map.talker.system : null);
      if (!slot) return { ok: false, reason: 'prompt slot must be "system" or "retry"' };
      return { ok: true, region: { kind: 'talker-prompt', name: edit.slot, reason: 'talker prompt' } };
    }
    default:
      return { ok: false, reason: 'unknown edit kind `' + edit.kind + '`' };
  }
}

module.exports = {
  buildRegionMap, evolvableAt, constitutionalAt,
  validateDiff, validateStructuredEdit, classifyRule,
  parseUnifiedDiff,
  NAMED_PHYSICS, GRAVITY_LAW, SEED_BUT_CONSTITUTIONAL, CONSTITUTIONAL_FNS,
};
