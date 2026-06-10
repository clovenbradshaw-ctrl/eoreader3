/* ============================================================
   evo/patch.js — render a structured edit into new source + a unified
   diff, and re-validate the rendered diff against the constitution.

   The agent proposes STRUCTURED edits (not free-form patch text), which
   the runner renders here. This is far more reliable than asking a model
   to emit a valid unified diff, and it makes allowlist validation exact:
   we know precisely which lines changed. The rendered .diff is what the
   human reviews and what evo:accept applies to the real engine.js.

   Edit shapes:
     { kind:'rule-value',        rule, value }           // numeric/bool/string
     { kind:'rule-tokens-add',   rule, tokens:[...] }     // single-line array rule
     { kind:'rule-tokens-remove',rule, tokens:[...] }
     { kind:'prompt-edit',       slot:'system'|'retry', find, replace }

   Every edit preserves the file's line count (in-place line rewrites), so
   the diff generator is a simple synchronized line walk.
   ============================================================ */
'use strict';
const _AL = (typeof require !== 'undefined') ? require('./allowlist')
  : (typeof window !== 'undefined' ? window.EVO_ALLOWLIST : {});
const { buildRegionMap, validateStructuredEdit, validateDiff } = _AL;

// Escape a string for embedding inside a single-quoted JS literal — backslash
// first, then the quote. Without this, an apostrophe in a rule value, a token
// (O'Brien, clitics), or a prompt edit ("the document's") breaks the literal
// and the patched engine fails to parse ("Unexpected identifier").
function escSingle(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function fmtValue(v) {
  if (typeof v === 'string') return "'" + escSingle(v) + "'";
  return String(v);
}

/* Apply one structured edit to a source string. Returns the new source, or
   throws with a reason. Does NOT validate the constitution — the caller
   does that before and after. */
function applyEdit(src, edit, map) {
  const lines = src.split('\n');
  switch (edit.kind) {
    case 'rule-value': {
      const r = map.rules[edit.rule];
      if (!r) throw new Error('unknown rule ' + edit.rule);
      for (let i = r.startLine - 1; i < r.endLine; i++) {
        if (/value:\s*('[^']*'|true|false|-?[\d.]+)/.test(lines[i])) {
          lines[i] = lines[i].replace(/value:\s*('[^']*'|true|false|-?[\d.]+)/, 'value: ' + fmtValue(edit.value));
          return lines.join('\n');
        }
      }
      throw new Error('no scalar value: line found in rule ' + edit.rule);
    }
    case 'rule-tokens-add':
    case 'rule-tokens-remove': {
      const r = map.rules[edit.rule];
      if (!r) throw new Error('unknown rule ' + edit.rule);
      for (let i = r.startLine - 1; i < r.endLine; i++) {
        const m = lines[i].match(/^(\s*value:\s*\[)(.*)(\],?\s*)$/);
        if (!m) continue;
        const items = m[2].split(',').map(s => s.trim()).filter(Boolean);
        const have = new Set(items.map(s => s.replace(/^['"]|['"]$/g, '')));
        if (edit.kind === 'rule-tokens-add') {
          for (const t of edit.tokens) if (!have.has(t)) items.push("'" + escSingle(t) + "'");
        } else {
          const drop = new Set(edit.tokens);
          for (let k = items.length - 1; k >= 0; k--) if (drop.has(items[k].replace(/^['"]|['"]$/g, ''))) items.splice(k, 1);
        }
        lines[i] = m[1] + items.join(',') + m[3];
        return lines.join('\n');
      }
      throw new Error('no single-line `value: [...]` array found in rule ' + edit.rule + ' (multi-line arrays not supported)');
    }
    case 'prompt-edit': {
      const slot = edit.slot === 'retry' ? map.talker.retry : (edit.slot === 'system' ? map.talker.system : null);
      if (!slot) throw new Error('unknown prompt slot ' + edit.slot);
      if (/\n/.test(edit.replace || '')) throw new Error('prompt replace text may not introduce newlines');
      // The talker prompts are single-quoted literals, so the inserted text
      // must be escaped for that context (apostrophes are common in prose).
      const safeReplace = escSingle(edit.replace);
      let hit = false;
      for (let i = slot.startLine - 1; i < slot.endLine; i++) {
        if (lines[i].includes(edit.find)) { lines[i] = lines[i].split(edit.find).join(safeReplace); hit = true; }
      }
      if (!hit) throw new Error('find text not present in prompt slot ' + edit.slot + ': ' + JSON.stringify(edit.find));
      return lines.join('\n');
    }
    default:
      throw new Error('unknown edit kind ' + edit.kind);
  }
}

/* Unified diff for two equal-line-count texts. Groups changed lines into
   hunks with `ctx` lines of context. */
function makeUnifiedDiff(oldText, newText, relPath = 'engine.js', ctx = 3) {
  const a = oldText.split('\n'), b = newText.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push(i);
  if (!changed.length) return '';
  // group into runs separated by > 2*ctx unchanged lines
  const groups = [];
  let cur = [changed[0]];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - cur[cur.length - 1] <= 2 * ctx + 1) cur.push(changed[k]);
    else { groups.push(cur); cur = [changed[k]]; }
  }
  groups.push(cur);
  const out = ['--- a/' + relPath, '+++ b/' + relPath];
  for (const g of groups) {
    const start = Math.max(0, g[0] - ctx);
    const end = Math.min(a.length - 1, g[g.length - 1] + ctx);
    const hunk = [];
    let oldCount = 0, newCount = 0;
    for (let i = start; i <= end; i++) {
      const inA = i < a.length, inB = i < b.length;
      if (inA && inB && a[i] === b[i]) { hunk.push(' ' + a[i]); oldCount++; newCount++; }
      else { if (inA) { hunk.push('-' + a[i]); oldCount++; } if (inB) { hunk.push('+' + b[i]); newCount++; } }
    }
    out.push('@@ -' + (start + 1) + ',' + oldCount + ' +' + (start + 1) + ',' + newCount + ' @@');
    out.push(...hunk);
  }
  return out.join('\n') + '\n';
}

/* Render a list of structured edits against an engine source.
   Returns { ok, newSource, diff, accepted, rejected, touchedRegions }.
   Validates each edit's target (pre), applies, then re-validates the
   rendered diff against the constitution (post / defense-in-depth). */
function renderEdits(engineSource, edits, relPath = 'engine.js') {
  const map = buildRegionMap(engineSource);
  const accepted = [], rejected = [];
  let src = engineSource;
  for (const edit of edits) {
    const v = validateStructuredEdit(map, edit);
    if (!v.ok) { rejected.push({ edit, reason: v.reason }); continue; }
    try {
      const next = applyEdit(src, edit, buildRegionMap(src));
      if (next === src) { rejected.push({ edit, reason: 'edit produced no change (token already present / value unchanged)' }); continue; }
      src = next;
      accepted.push({ edit, region: v.region });
    } catch (e) { rejected.push({ edit, reason: String(e.message || e) }); }
  }
  const diff = makeUnifiedDiff(engineSource, src, relPath);
  // Post-validate: the rendered diff must touch only evolvable regions.
  const dv = diff ? validateDiff(engineSource, diff, relPath) : { ok: true, rejected: [], touchedRegions: [] };
  if (!dv.ok) {
    for (const r of dv.rejected) rejected.push({ edit: null, reason: 'rendered diff failed constitution: ' + r.reason });
  }
  // Defense: a rendered source that won't parse (e.g. an edit that broke a
  // string literal) must be rejected here, not blow up the candidate loader.
  // `new Function` COMPILES without executing — a pure syntax check.
  let compileErr = null;
  if (src !== engineSource) {
    try { new Function(src); } catch (e) { compileErr = String(e.message || e); rejected.push({ edit: null, reason: 'rendered source is not valid JavaScript: ' + compileErr }); }
  }
  return {
    ok: accepted.length > 0 && dv.ok && !compileErr,
    newSource: src, diff,
    accepted, rejected,
    touchedRegions: dv.touchedRegions || [],
  };
}

const _exports = { applyEdit, makeUnifiedDiff, renderEdits, fmtValue };
if (typeof module !== 'undefined' && module.exports) module.exports = _exports;
else if (typeof window !== 'undefined') window.EVO_PATCH = _exports;
