# Physics and Triadic Dispatch: Implementation Spec (Phases 1 and 2)

**Target:** the single-file browser app `local-chat` (WebLLM + mechanical knowledge graph).
**Audience:** a developer who has the current source file in hand.
**Status:** Phases 1 and 2 are in scope here. Phases 3 (rules store, correction classifier) and 4 (UI surfaces) are out of scope and noted at the end.

The whole change is additive. No existing behavior is removed. Every new number is a count of events, so the system never gains a confidence score. The acceptance tests in Section 8 are the real contract: if tests 15 through 21 pass and tests 1 through 14 still pass, the implementation is correct, even if an internal detail below differs from the source.

---

## 1. Why this exists (one paragraph)

The graph is the truth-bearing layer; the model is a phrasing surface. We are replacing implicit, ungrounded ranking with an explicit mechanics. A site has **mass** (how many observations touch it), a **velocity** (how hard the current conversation is touching it), and a **momentum** (the product, which ranks everything). Contradictions are not resolved silently; they are kept on a **ledger** and reported as **strain**. The user is the highest-precision sensor, so user assertions carry more **force** than document observations. None of this is allowed to grow the model prompt: the prompt stays at the profile cap (about 800 chars for the small profile) forever, and the contents of the prompt get better as mass accumulates.

---

## 2. Glossary of quantities

| Quantity | Definition | Where it lives | Decays? |
|---|---|---|---|
| **force** `f` | per-event multiplier set at mint time | `ev.force` on each sig | no |
| **mass** `m` | Σ force of events touching a site | per cluster, per ledger row | no |
| **velocity** `v` | what the conversation is touching now: this query at full force plus recent user turns decayed per turn | computed at query time | yes (per turn) |
| **momentum** `p` | `m * v`; ranks retrieval and selects STRUCTURE | computed at query time | follows `v` |
| **inertia** | resistance to revision; behavioral, proportional to `m` | emergent (the flip rule) | n/a |
| **strain** | competing values on one `(site, path)` attribute, each with its own mass | ledger rows beyond `[0]` | no |

`mass` alone moves nothing. A heavy site nobody is talking about has `v = 0`, therefore `p = 0`, therefore it does not hijack retrieval or pronoun resolution. That is the central correctness property.

---

## 3. Constants of the medium

Declare these once, near the top of the projection section (right before the `// SITE PROJECTION` banner is a good spot).

```js
const GAMMA = 0.7;                 // decay per event/turn; the same 0.7 the activation sweeps use
const FORCE = { doc: 1, user: 5 }; // precision weighting at mint time
```

There are exactly three constants of the medium: `GAMMA`, the `FORCE` map, and the existing two-sighting admission gate inside `tryAdmit` (unchanged). Do not introduce any per-fact tunable. The flip rule below is strict mass comparison, with no threshold.

---

## 4. Existing contracts this spec depends on

Confirm these against the source before editing. Field names in the reader are the source of truth; the names used here match the current build.

**Event (sig) shape.** Every event carries at least:
```
{ id, seq, op, stance, gen, sectionIdx, spanFromIdx, spanToIdx, mintedAt, src }
```
- `op` is one of `'CON'`, `'DEF'`, `'SIG'`.
- `seq` equals the event's index in `att.sigs` (the log is append-only), so `att.sigs[seq]` is valid.
- `DEF` adds `{ target, path, value, targetHint? }`. `target` is a surface string; for a pronoun target, `targetHint` is a frozen `{ name, key }` used to resolve it.
- `CON` adds `{ s, v, o }` (subject surface, verb, object surface), with optional hints.
- `SIG` adds `{ speaker, quote, speakerHint? }`.

**`eventContributingSlots(ev)`** returns the surface slots that count toward entity mass: `s` and `o` for CON, `target` for DEF, `speaker` for SIG.

**`projectSites(att, cursor?)`** is a memoized pure fold over `att.sigs`. Today it returns:
```
{ entities, edges, bindings, unboundCount, sigCount }
```
- `entities[i]` = `{ key, name, type, mentions, surfaceForms, firstSectionIdx, lastSectionIdx, defs }`.
- `edges[i]` = `{ aKey, aName, bKey, bName, verb, weight }`.
- Internally it builds occurrence buckets in pass 1, alias-merges them into `clusters` (each cluster `key` is `normSurface` of its longest name), defines `findCluster(surface)`, then runs an is-a evidence pass and emits `entities`/`edges`.
- The memo key includes `att.id`, the sig count, and the cursor.

**Helpers available in scope:** `normSurface`, `tokenSetOf`, `aliasRelation`, `isPronoun`, `looksProper`, `tryAdmit`, `newId`, `splitSentences`, plus the `STOP` set used by `tokenSetOf`.

**`dispatch(thread, queryOverride?)`** assembles the model turn. Relevant internals:
- `PROMPT_PROFILE` (`profile`) has `sysCap` (small = 800) and span/section budgets.
- It computes `isChitchat`, honors a `retrievalOn` toggle and a `retrievalScope` (narrowed for pronoun-anchored queries), and drops history on `isFreshLookup`.
- It runs `pickRelevantSpans` (cosine) and `pickRelevantSpansByGraph` (graph) and merges results into `spanHits`; it also gathers `sectionHits` and `entityHits`.
- `buildSys` builds the system message; `assemble` runs a trim loop that pops `spanHits`/`sectionHits`/`convTurns` when over budget.
- `thread` has `attachments`, `history`, `pins`, `composeRefs`, `summaries`.

**`tryMechanicalDefLookup(text, thread)`** answers simple factual queries with no model and returns a markdown string or `null`.

**`runEventLayerTests()`** returns an array `[{ name, pass, detail }]`; the `/test` slash command renders it. Tests 1 through 14 exist today.

---

## 5. Phase 1: the physics core

Pure functions and field additions only. Nothing in this phase changes user-visible behavior; it makes the quantities available.

### 5.1 Stamp `force` at every mint point

**(a) `sweepSectionSigs`** mints document events. Add `force: FORCE.doc` to the base event object (next to `gen`):
```js
const base = {
  id: newId('sig'),
  seq: baseSeq + out.length,
  op, stance: STANCE_OF_OP[op] || 'Binding',
  gen: att_gen,
  force: FORCE.doc,          // <-- add
  sectionIdx: sec.idx,
  spanFromIdx: sec.spanFromIdx,
  spanToIdx: sec.spanToIdx,
  mintedAt: Date.now(),
};
```

**(b) `mechanicalReadAttachment`** mints the deterministic document events. Add `force: FORCE.doc` to `baseMeta`:
```js
const baseMeta = {
  gen: att_gen,
  force: FORCE.doc,          // <-- add
  sectionIdx: span.sectionIdx ?? 0,
  spanFromIdx: spanIdx,
  spanToIdx: spanIdx,
  mintedAt: Date.now(),
  src: 'mechanical',
};
```

**(c) `mintConversationSigs`** mints events from chat. After the sweep, raise the force on direct user voice (SIG events whose speaker is the user). This is the only place user force is applied in Phases 1 and 2; correction-driven force-5 DEFs are Phase 3.
```js
const sigs = sweepSectionSigs(fakeAtt, fakeSec, parsedEvents, actState);
// User speech is the highest-precision sensor in the system.
for (const sg of sigs) {
  if (sg.op === 'SIG' && /^user$/i.test(sg.speaker || '')) sg.force = FORCE.user;
}
thread.convSigs.push(...sigs);
```

**(d) `migrateSession`** must default `force` on legacy events so old sessions get mass. In both the `s.convSigs` loop and the `a.sigs` loop, add:
```js
if (sg.force === undefined) sg.force = 1;
```

> Existing literal `0.7` decay values elsewhere may be left as is; they equal `GAMMA`. Only new code must reference `GAMMA`.

### 5.2 Cluster mass in `projectSites` (pass 1 and merge)

Occurrence buckets accumulate mass alongside the raw mention count. Keep `count` (it feeds the `xN` mention display); add `mass`.

Bucket init and increment:
```js
const cur = occ.get(key) || { key, name: surface, count: 0, mass: 0, sigSeqs: [], proper: isProp, surfaceForms: new Set() };
cur.count++;
cur.mass += (sg.force || 1);     // <-- add
cur.sigSeqs.push(sg.seq);
```

Alias merge:
```js
lead.count += other.count;
lead.mass = (lead.mass || 0) + (other.mass || 0);   // <-- add
lead.sigSeqs = lead.sigSeqs.concat(other.sigSeqs);
```

### 5.3 The attribute ledger and strain

Insert this block inside `projectSites` after `findCluster` is defined and after `clusters` exists, before the is-a evidence pass.

Every `(cluster, path)` pair keeps all observed values, each with accumulated mass. Nothing is overwritten. The canonical value is simply the heaviest row. Rows beyond `[0]` are strain: a live contradiction the projection carries instead of hiding. The flip rule is strict mass comparison, so one stray sentence flips a 2-mass fact and bounces off a 40-mass one. Inertia is derived, not configured.

```js
// key: clusterKey + '\u0001' + path  ->  rows[] (heaviest first)
const attrs = new Map();
const strains = [];
for (const sg of sigs) {
  if (sg.op !== 'DEF') continue;
  let cl = null;
  if (isPronoun(sg.target)) {
    if (sg.targetHint && sg.targetHint.name) cl = findCluster(sg.targetHint.name);
  } else {
    cl = findCluster(sg.target);
  }
  if (!cl) continue;
  const k = cl.key + '\u0001' + String(sg.path || '').toLowerCase();
  const ledger = attrs.get(k) || [];
  const f = sg.force || 1;
  const vNorm = String(sg.value).toLowerCase().trim();
  const hit = ledger.find(r => r.vNorm === vNorm);
  if (hit) { hit.mass += f; hit.count++; hit.lastSeq = sg.seq; }
  else ledger.push({ value: sg.value, vNorm, mass: f, count: 1, firstSeq: sg.seq, lastSeq: sg.seq });
  attrs.set(k, ledger);
}
for (const [k, ledger] of attrs) {
  ledger.sort((a, b) => b.mass - a.mass || b.lastSeq - a.lastSeq);
  if (ledger.length > 1) {
    const [key, path] = k.split('\u0001');
    const cl = clusters.find(c => c.key === key);
    strains.push({ key, name: cl ? cl.name : key, path, rows: ledger });
  }
}
```

### 5.4 Updated `projectSites` output

Export two new fields on each entity and two new fields on the result.

Entity (add `mass` and `sigSeqs`):
```js
{
  key: cl.key, name: cl.name, type: cl.terrain,
  mentions: cl.count,
  mass: cl.mass || cl.count,        // <-- add
  sigSeqs: cl.sigSeqs.slice(),      // <-- add (exact span lookup for retrieval)
  surfaceForms: [...cl.surfaceForms],
  /* ...existing fields... */
}
```

Result:
```js
const result = { entities, edges, bindings, unboundCount, sigCount: sigs.length, attrs, strains };
```

`sigSeqs` matters: today the graph retriever references `ent.sigSeqs` but the export omits it, so the precise span path is dead and the surface-scan fallback always runs. Exporting it makes span selection exact.

---

## 6. Phase 2: momentum retrieval and triadic dispatch

### 6.1 Rewrite `pickRelevantSpansByGraph` as momentum retrieval

Signature gains a fourth argument and the return gains `ranked`. Mass comes from the fold; velocity comes from what the conversation touches now (this query at force 1, prior user turns decayed by `GAMMA` per turn); momentum `p = m*v` ranks. Velocity conducts one hop along edges at 0.4, so asking about one party to a relation warms the other.

```js
// Momentum retrieval. mass from the fold, velocity from what's touched now.
// p = m*v ranks. Velocity conducts one hop along edges at 0.4. A heavy cluster
// the conversation isn't touching has v=0, p=0, and stays out of the way.
function pickRelevantSpansByGraph(query, atts, charBudget = 600, recentTurns = []) {
  if (!query || !atts || !atts.length) return { spans: [], resolved: [], ranked: [] };
  const qLower = String(query).toLowerCase();
  const qTokens = tokenSetOf(query);
  const turns = (recentTurns || []).slice(0, 3).map(t => ({
    lower: String(t).toLowerCase(), tokens: tokenSetOf(t),
  }));

  // How hard does a text touch a cluster? Exact name-phrase (len>=4) = 1.0;
  // token overlap = up to 0.5. Pure surface mechanics, no model.
  const touchOf = (lower, tokens, ent) => {
    let best = 0;
    const names = [ent.name, ...(ent.surfaceForms || [])];
    for (const nm of names) {
      const nl = String(nm).toLowerCase();
      if (nl.length >= 4 && lower.includes(nl)) return 1;
      const eToks = tokenSetOf(nm);
      if (!eToks.size) continue;
      let shared = 0;
      for (const t of eToks) if (tokens.has(t)) shared++;
      if (shared) best = Math.max(best, 0.5 * (shared / eToks.size));
    }
    return best;
  };

  const hits = [];
  const resolved = [];
  const ranked = [];

  for (const att of atts) {
    let proj;
    try { proj = projectSites(att); } catch (e) { continue; }
    if (!proj || !proj.entities.length) continue;

    // velocity: query at force 1, prior turns decayed by GAMMA^(k+1)
    const vMap = new Map();
    for (const ent of proj.entities) {
      let v = touchOf(qLower, qTokens, ent);
      if (v >= 1) resolved.push({ attId: att.id, attTitle: att.title, name: ent.name, mentions: ent.mentions });
      turns.forEach((t, k) => { v += touchOf(t.lower, t.tokens, ent) * Math.pow(GAMMA, k + 1); });
      if (v > 0) vMap.set(ent.key, v);
    }

    // conduction: one hop along edges at 0.4
    for (const ed of (proj.edges || [])) {
      const va = vMap.get(ed.aKey) || 0, vb = vMap.get(ed.bKey) || 0;
      if (va > 0 && va * 0.4 > vb) vMap.set(ed.bKey, va * 0.4);
      else if (vb > 0 && vb * 0.4 > va) vMap.set(ed.aKey, vb * 0.4);
    }
    if (!vMap.size) continue;

    // momentum per cluster; spans scored by the momenta touching them
    const spanScores = new Map();
    for (const ent of proj.entities) {
      const v = vMap.get(ent.key) || 0;
      if (v <= 0) continue;
      const m = ent.mass || ent.mentions || 1;
      const p = m * v;
      ranked.push({ attId: att.id, attTitle: att.title, ent, m, v, p });
      const spanIdxs = new Set();
      const seqs = ent.sigSeqs || [];
      if (seqs.length) {
        for (const s of seqs) {
          const ev = att.sigs[s];
          if (ev && typeof ev.spanFromIdx === 'number') spanIdxs.add(ev.spanFromIdx);
        }
      } else {
        for (let i = 0; i < att.spans.length; i++) {
          const txt = att.spans[i].text || '';
          for (const sf of (ent.surfaceForms || [ent.name])) {
            if (txt.includes(sf)) { spanIdxs.add(i); break; }
          }
        }
      }
      for (const idx of spanIdxs) spanScores.set(idx, (spanScores.get(idx) || 0) + p);
    }

    for (const [idx, score] of spanScores) {
      const span = att.spans[idx];
      if (!span) continue;
      hits.push({ attId: att.id, attTitle: att.title, span, score, src: 'graph' });
    }
  }

  ranked.sort((a, b) => b.p - a.p || b.m - a.m);
  hits.sort((a, b) => b.score - a.score);
  const picked = [];
  const seen = new Set();
  let used = 0;
  for (const h of hits) {
    const k = h.attId + ':' + h.span.idx;
    if (seen.has(k)) continue;
    seen.add(k);
    if (used + (h.span.text || '').length > charBudget && picked.length > 0) break;
    picked.push(h);
    used += (h.span.text || '').length;
  }
  return { spans: picked, resolved, ranked };
}
```

Compatibility note: the old callers passed `(query, scope, budget)` and read `.spans` and `.resolved`. Those keys are preserved. `resolved` is computed against the query only (the check happens before turn contributions are added), so its meaning is unchanged.

### 6.2 Dispatch wiring

Declare the ranking and compute recent user turns. Velocity needs the prior turns, which is what keeps a follow-up like "tell me more about her career" anchored with no model memory.

Near the other retrieval state:
```js
let retrieved = { spans: [], sections: [] };
let graphResolved = [];
let graphRanked = [];                      // <-- add
// Recent user turns feed velocity (decayed GAMMA per turn).
const userMsgsAll = thread.history.filter(m => m.role === 'user').map(m => m.content);
const recentUserTurns = userMsgsAll.slice(0, -1).slice(-3).reverse(); // newest first, excludes current
```

Pass turns into the graph call and capture the ranking:
```js
const [emb, graphResult] = await Promise.all([
  pickRelevantSpans(currentUserText, retrievalScope, embBudget, profile.sectionBudget),
  Promise.resolve(pickRelevantSpansByGraph(currentUserText, retrievalScope, graphBudget, recentUserTurns)),
]);
graphResolved = graphResult.resolved || [];
graphRanked = graphResult.ranked || [];    // <-- add
```

Drive the retrieval card off the ranking, falling back to the old entity picker:
```js
let entityHits = graphRanked.slice(0, 5).map(r => ({ attId: r.attId, attTitle: r.attTitle, ent: r.ent, score: r.p }));
if (!entityHits.length && atts.length) entityHits = pickRelevantEntities(retrievalOn ? currentUserText : null, atts, 5);
```

The persisted `entityHits` mapping (in `send`) reads `h.ent.name` etc., which still works. `h.ent.def` may be undefined for momentum-ranked entities; the card already guards for that.

### 6.3 Replace `buildSys` with the triadic builder

This is the heart of Phase 2. The prompt is three blocks, always this order:

```
# GROUND      counts and presences only, never prose
# STRUCTURE   the model's entire working surface, selected by momentum
(question)    rides as the user turn; one boundary clause closes the system message
```

The format is the instruction. Build a `rankedByAtt` map just before `buildSys`, then replace the function. Selection priority for STRUCTURE, packed under budget: compose-refs, pins, ledger facts, edges, quotes, section summaries, verbatim spans.

```js
// Group the momentum ranking per attachment.
const rankedByAtt = new Map();
for (const r of graphRanked) {
  if (!rankedByAtt.has(r.attId)) rankedByAtt.set(r.attId, []);
  rankedByAtt.get(r.attId).push(r);
}

const buildSys = () => {
  const hasContext = atts.length > 0
    || (thread.pins && thread.pins.length > 0)
    || (thread.composeRefs && thread.composeRefs.length > 0);
  if (!hasContext) return customSys || '';

  // Chitchat with context attached: situational awareness only, no triad.
  if (isChitchat) {
    const names = atts.map((a, i) => `[doc${i + 1}] ${a.title}`).join('; ');
    const line = atts.length
      ? `The user has attached: ${names}. They haven't asked about the documents; just chat normally.`
      : `The user has pinned context for later reference.`;
    return line + (customSys ? '\n\n' + customSys : '');
  }

  const SYS_CAP = profile.sysCap;
  const tagOf = (att) => `[doc${atts.indexOf(att) + 1}]`;

  // # GROUND: what exists and how heavy it is. xN is mass, auditable to spans.
  let ground = '';
  if (atts.length) {
    const g = ['# GROUND'];
    for (const a of atts) {
      const marker = a === focusAtt && atts.length > 1 ? ' (focus)' : '';
      let top = (rankedByAtt.get(a.id) || []).slice(0, 4).map(r => r.ent);
      if (!top.length) { try { top = projectSites(a).entities.slice(0, 4); } catch { top = []; } }
      const names = top.map(e => `${e.name} x${e.mentions}`).join(', ');
      g.push(`${tagOf(a)} "${a.title}"${marker}${names ? ` — ${names}` : ''}`);
    }
    const touched = [...new Set(graphRanked.filter(r => r.v > 0).slice(0, 4).map(r => r.ent.name))];
    if (touched.length) g.push(`query touches: ${touched.join(', ')}`);
    ground = g.join('\n');
  }

  const instruction = atts.length
    ? `Answer the user from STRUCTURE only. If STRUCTURE doesn't contain it, say the document doesn't cover it.`
    : `Answer the user, drawing on STRUCTURE where relevant.`;

  // # STRUCTURE: candidate lines in priority order, packed to budget.
  const cands = [];
  const push = (pri, text, cap) => {
    if (!text) return;
    let t = String(text).replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (cap && t.length > cap) t = t.slice(0, cap) + '\u2026';
    cands.push({ pri, t });
  };

  // 0 — compose-refs (user points at this for THIS turn)
  for (const ref of (thread.composeRefs || [])) {
    const att = atts.find(a => a.id === ref.attId);
    push(0, `${att ? tagOf(att) : '[ref]'} (user points at this) ${ref.text || ref.label || ''}`, profile.refCap);
  }
  // 1 — pins (sticky user-flagged context)
  for (const pin of (thread.pins || [])) {
    const att = atts.find(a => a.id === pin.attId);
    push(1, `${att ? tagOf(att) : '[pin]'} (pinned) ${pin.text || pin.label || ''}`, Math.min(380, profile.pinCap));
  }
  // nothing touched at all -> the doc's own summary is the structure
  if (!graphRanked.length && focusAtt) {
    push(2, `${tagOf(focusAtt)} summary: ${focusAtt.summary || focusAtt.skim || ''}`, profile.docSumCap);
  }
  for (const a of atts) {
    const ranked = (rankedByAtt.get(a.id) || []).slice(0, 4);
    if (!ranked.length) continue;
    let proj = null;
    try { proj = projectSites(a); } catch { continue; }
    // 2 — ledger facts: canonical value per (site, path); strain shown
    for (const r of ranked) {
      const prefix = r.ent.key + '\u0001';
      const rows = [];
      for (const [k, ledger] of (proj.attrs || new Map())) {
        if (!k.startsWith(prefix)) continue;
        const path = k.slice(prefix.length);
        if (path === 'resolves-to') continue;
        rows.push({ path, ledger });
      }
      rows.sort((x, y) => y.ledger[0].mass - x.ledger[0].mass);
      for (const { path, ledger } of rows.slice(0, 2)) {
        const head = ledger[0];
        let line = `${tagOf(a)} ${r.ent.name} — ${path}: ${head.value}`;
        if (head.mass > 1) line += ` x${head.mass}`;
        if (ledger.length > 1) line += ` (also recorded: ${ledger[1].value} x${ledger[1].mass})`;
        push(2, line, 150);
      }
    }
    // 3 — edges touching the ranked clusters
    const touchedKeys = new Set(ranked.map(r => r.ent.key));
    let edgeN = 0;
    for (const ed of (proj.edges || [])) {
      if (edgeN >= 4) break;
      if (!touchedKeys.has(ed.aKey) && !touchedKeys.has(ed.bKey)) continue;
      push(3, `${tagOf(a)} ${ed.aName} ${ed.verb || '\u00b7'} ${ed.bName}${ed.weight > 1 ? ` x${ed.weight}` : ''}`, 120);
      edgeN++;
    }
    // 4 — a quote or two from touched speakers
    const surfSet = new Set();
    for (const r of ranked) for (const sf of (r.ent.surfaceForms || [r.ent.name])) surfSet.add(normSurface(sf));
    let quotes = 0;
    for (const ev of (a.sigs || [])) {
      if (quotes >= 2) break;
      if (ev.op !== 'SIG' || !ev.quote) continue;
      const sp = normSurface(ev.speaker || '');
      const hinted = ev.speakerHint ? normSurface(ev.speakerHint.name) : '';
      if (!surfSet.has(sp) && !surfSet.has(hinted)) continue;
      push(4, `${tagOf(a)} ${ev.speaker}: "${ev.quote}"`, 140);
      quotes++;
    }
  }
  // 5 — section summaries the retrieval surfaced
  for (const sh of sectionHits) {
    const att = atts.find(a => a.id === sh.attId);
    push(5, `${att ? tagOf(att) : '[doc?]'} summary (sec ${sh.section.idx + 1}): ${sh.section.summary || ''}`, 240);
  }
  // 6 — verbatim spans (cosine + graph union)
  for (const ex of spanHits) {
    const att = atts.find(a => a.id === ex.attId);
    push(6, `${att ? tagOf(att) : '[doc?]'} text: "${ex.span.text}"`, 300);
  }

  // # EARLIER: folded conversation, tiny, only when folds exist
  let earlier = '';
  if (thread.summaries.length) {
    const s = thread.summaries[thread.summaries.length - 1];
    earlier = '# EARLIER\n' + (s.text.length > 200 ? s.text.slice(0, 200) + '\u2026' : s.text);
  }
  if (convTurns.length) {
    const t0 = convTurns[0];
    const snip = (t0.snippet || t0.content || '').slice(0, 200);
    earlier += (earlier ? '\n' : '# EARLIER\n') + `[#${t0.idx} ${t0.role}]: ${snip}`;
  }

  // Pack STRUCTURE into what's left under the cap. The prompt does not grow.
  cands.sort((x, y) => x.pri - y.pri);
  const fixed = ground.length + instruction.length + earlier.length
    + (customSys ? customSys.length + 2 : 0) + 40;
  const structBudget = Math.max(220, SYS_CAP - fixed);
  const sLines = ['# STRUCTURE'];
  let used = 0;
  for (const c of cands) {
    if (used + c.t.length + 3 > structBudget) continue;   // skip, keep scanning (a shorter later line may fit)
    sLines.push('- ' + c.t);
    used += c.t.length + 3;
  }
  if (sLines.length === 1) sLines.push('- (nothing surfaced for this question)');

  const parts = [];
  if (ground) parts.push(ground);
  parts.push(sLines.join('\n'));
  if (earlier) parts.push(earlier);
  if (customSys) parts.push(customSys);
  parts.push(instruction);
  let sys = parts.join('\n\n');
  const hardCap = Math.round(SYS_CAP * 1.25);
  if (sys.length > hardCap) sys = sys.slice(0, hardCap) + '\n\u2026(trimmed)';
  return sys;
};
```

Notes on intent:
- The packing loop uses `continue`, not `break`, so when ledger facts are thin a verbatim span can still fit. On the small profile, facts often fill the budget and spans drop out, which is the philosophy: a pure structure prompt.
- `buildSys` is called fresh by `assemble` each trim iteration, so it always reads the current (popped) `spanHits`/`sectionHits`/`convTurns`. The trim loop continues to function unchanged.
- The "query touches" line in GROUND is velocity made visible.

### 6.4 Rewrite `tryMechanicalDefLookup` to read the ledger

Same query shapes as today (when/where/what/who/how old). Resolve the target to clusters, read `proj.attrs`, take the heaviest matched path, report strain when present. No model in this path means no drift.

```js
function tryMechanicalDefLookup(text, thread) {
  const atts = (thread.attachments || []).filter(a => (a.sigs || []).length);
  if (!atts.length) return null;
  const raw = String(text).trim();
  if (raw.length > 120) return null;            // long queries are usually composed asks
  const q = raw.toLowerCase().replace(/[?.!]+$/, '').trim();

  let path = null, target = null, m;
  if ((m = q.match(/^(?:when|what\s+year)\s+(?:was|did|is)\s+(.+?)\s+(born|die[d]?|founded|started?|created|made)$/))) {
    target = m[1]; path = (m[2] === 'born') ? 'born' : (m[2].startsWith('die') ? 'died' : m[2]);
  } else if ((m = q.match(/^where\s+(?:was|is|did)\s+(.+?)\s+(born|from|located|founded|live[d]?)$/))) {
    target = m[1]; path = (m[2] === 'from' || m[2] === 'born') ? 'birthplace' : 'location';
  } else if ((m = q.match(/^(?:what|who)\s+(?:is|was|are|were)\s+(.+)$/))) {
    target = m[1]; path = 'class';
  } else if ((m = q.match(/^how\s+old\s+is\s+(.+)$/))) {
    target = m[1]; path = 'born';
  }
  if (!target) return null;
  target = target.replace(/^(the|a|an)\s+/, '').trim();
  if (target.length < 2) return null;

  // resolve target -> clusters (case-insensitive substring over names + aliases)
  const tLow = target.toLowerCase();
  const hits = [];
  const seenHit = new Set();
  for (const att of atts) {
    let proj;
    try { proj = projectSites(att); } catch (e) { continue; }
    for (const ent of proj.entities) {
      const nLow = ent.name.toLowerCase();
      const sfMatch = (ent.surfaceForms || []).some(s => s.toLowerCase() === tLow || tLow.includes(s.toLowerCase()));
      if (nLow === tLow || nLow.includes(tLow) || tLow.includes(nLow) || sfMatch) {
        const k = att.id + '|' + ent.key;
        if (seenHit.has(k)) continue;
        seenHit.add(k);
        hits.push({ att, proj, ent });
      }
    }
  }
  if (!hits.length) return null;

  const pathSyns = {
    'born': ['born', 'birth', 'birthdate', 'birthday'],
    'died': ['died', 'death'],
    'birthplace': ['birthplace', 'born-in', 'birth-place'],
    'class': ['class', 'is', 'is-a', 'isa', 'type', 'role', 'gloss'],
    'location': ['location', 'based', 'headquarters', 'hq'],
    'founded': ['founded', 'started', 'created'],
  };
  const wantPaths = new Set(pathSyns[path] || [path]);

  const lines = [];
  for (const { att, proj, ent } of hits) {
    const prefix = ent.key + '\u0001';
    const matched = [];
    for (const [k, ledger] of (proj.attrs || new Map())) {
      if (!k.startsWith(prefix)) continue;
      const p = k.slice(prefix.length);
      if (p === 'resolves-to') continue;
      if (wantPaths.has(p)) matched.push({ path: p, ledger });
    }
    if (!matched.length) continue;
    matched.sort((a, b) => b.ledger[0].mass - a.ledger[0].mass);
    const { path: mp, ledger } = matched[0];
    const head = ledger[0];
    const docTag = atts.length > 1 ? ` *(from ${att.title})*` : '';
    const pathLabel = path === 'class' ? 'is' : mp;
    let line = `**${ent.name}** — ${pathLabel}: ${head.value}`;
    if (head.mass > 1) line += ` x${head.mass}`;
    if (ledger.length > 1) {
      const alts = ledger.slice(1, 3).map(r => `${r.value} x${r.mass}`).join(', ');
      line += ` *(also recorded: ${alts})*`;
    }
    lines.push(line + docTag);
  }
  return lines.length ? lines.join('\n\n') : null;
}
```

Example output with strain: `**Carol Burnett** — born: April 26, 1933 x6 *(also recorded: 1936 x1)*`. That sentence is more trustworthy than a confidence interval because each mass clicks down to its spans.

### 6.5 Add the `/physics` slash command

Register a read-only audit command in the slash table (before `/read` is fine). It shows mass and strain per document, and an optional momentum table when given a query argument.

```js
{ name: '/physics', desc: 'Mass / strain / momentum audit (optionally: /physics <query>)', run: (args) => {
    if (!activeSessionId) return;
    const t = getSession(activeSessionId);
    const atts = (t.attachments || []).filter(a => (a.sigs || []).length);
    const lines = [];
    if (!atts.length) lines.push('No event logs yet — attach a document (the mechanical read runs at index time).');
    for (const att of atts) {
      let proj;
      try { proj = projectSites(att); } catch (e) { continue; }
      lines.push(`**${att.title}** — ${proj.sigCount} events \u00b7 ${proj.entities.length} sites \u00b7 ${proj.strains.length} strained attribute${proj.strains.length === 1 ? '' : 's'}`);
      lines.push('*mass:*');
      for (const e of proj.entities.slice(0, 6)) lines.push(`- ${e.name} — m ${e.mass} (x${e.mentions})`);
      if (proj.strains.length) {
        lines.push('*strain (contested attributes — heaviest is canonical):*');
        for (const st of proj.strains.slice(0, 6)) {
          lines.push(`- ${st.name} \u00b7 ${st.path}: ` + st.rows.slice(0, 3).map(r => `${r.value} x${r.mass}`).join('  vs  '));
        }
      }
      if (args) {
        const r = pickRelevantSpansByGraph(args, [att], 400, []);
        if (r.ranked && r.ranked.length) {
          lines.push(`*momentum vs "${args}" (p = m\u00b7v):*`);
          for (const mr of r.ranked.slice(0, 6)) lines.push(`- ${mr.ent.name} — m ${mr.m} \u00b7 v ${mr.v.toFixed(2)} \u00b7 p ${mr.p.toFixed(1)}`);
        } else {
          lines.push(`*momentum vs "${args}": nothing touched, every site at rest*`);
        }
      }
      lines.push('');
    }
    messagesEl.querySelector('.empty')?.remove();
    const el = document.createElement('div'); el.className = 'msg assistant';
    el.innerHTML = marked.parse('### Physics audit (mechanical, no model)\n' + lines.join('\n'));
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
} },
```

---

## 7. Behavior changes a reviewer will notice

1. Factual lookups now report strain when sources disagree, instead of returning a single silent value.
2. Retrieval and the STRUCTURE block are ranked by momentum, so a light entity the query names beats a heavy entity it does not.
3. The system prompt is now explicitly three blocks (GROUND, STRUCTURE, boundary clause). Inspect it in the dispatch badge / prompt log. It must stay at or under `sysCap` for the active profile (hard ceiling `sysCap * 1.25`).
4. A pronoun follow-up stays anchored because the prior user turn still contributes decayed velocity.
5. Chitchat with an attachment yields one situational line, not the old full document preface.

---

## 8. Acceptance tests (the contract)

Append tests 15 through 21 to `runEventLayerTests()` (before its final `return out;`). Tests 1 through 14 must remain green; in particular, test 10 still passes because its target entity has at least one event-derived span, and test 12 still resolves via the parenthetical-gloss DEF.

Each test hand-mints sig objects (so it does not depend on the parser), with `seq` equal to the array index. The two-sighting gate admits multi-token names on first sighting and admits proper nouns of length 4+ on first sighting.

```js
// 15. Force is stamped on minted events (FORCE.doc === 1).
t('minted events carry force 1', () => {
  const fakeAtt = { sigs: [], tentatives: {}, gen: 0 };
  const fakeSec = { idx: 0, spanFromIdx: 0, spanToIdx: 0 };
  const minted = sweepSectionSigs(fakeAtt, fakeSec, [
    { op: 'CON', s: 'Alpha Corp', v: 'bought', o: 'Beta Labs' },
  ], new Map());
  if (minted[0].force !== 1) return `force=${minted[0].force}`;
  const att = {
    id: 'ftest', title: 'T', gen: 0, tentatives: {}, sigs: [],
    spans: [{ idx: 0, sectionIdx: 0, text: 'Alpha Corp bought Beta Labs.' }],
    sections: [{ idx: 0, spanFromIdx: 0, spanToIdx: 0 }],
  };
  const mech = mechanicalReadAttachment(att);
  for (const ev of mech) if (ev.force !== 1) return `mechanical force=${ev.force}`;
  return null;
});

// 16. Ledger accumulates mass; disagreement is strain, not overwrite.
t('attribute ledger accumulates mass and carries strain', () => {
  const sigs = [
    { id: 's0', seq: 0, op: 'DEF', target: 'Carol Burnett', path: 'born', value: '1933', force: 1, sectionIdx: 0 },
    { id: 's1', seq: 1, op: 'DEF', target: 'Carol Burnett', path: 'born', value: '1933', force: 1, sectionIdx: 0 },
    { id: 's2', seq: 2, op: 'DEF', target: 'Carol Burnett', path: 'born', value: '1936', force: 1, sectionIdx: 0 },
  ];
  const proj = projectSites({ id: 'ledg1', sigs });
  const ent = proj.entities.find(e => /burnett/i.test(e.name));
  if (!ent) return 'no Burnett cluster';
  const ledger = proj.attrs.get(ent.key + '\u0001born');
  if (!ledger) return 'no born ledger';
  if (ledger[0].value !== '1933' || ledger[0].mass !== 2) return `canonical ${ledger[0].value} x${ledger[0].mass}`;
  if (ledger.length !== 2 || ledger[1].mass !== 1) return 'strain row missing';
  if (!proj.strains.length) return 'strains list empty';
  return null;
});

// 17. Canonical flips only when out-massed; the old value stays on the ledger.
t('canonical flips only when out-massed', () => {
  const mk = (seq, value) => ({ id: 's' + seq, seq, op: 'DEF', target: 'Acme', path: 'hq', value, force: 1, sectionIdx: 0 });
  const sigs = [mk(0, 'Austin'), mk(1, 'Austin'), mk(2, 'Dallas'), mk(3, 'Dallas'), mk(4, 'Dallas')];
  const proj = projectSites({ id: 'ledg2', sigs });
  const ent = proj.entities.find(e => /acme/i.test(e.name));
  if (!ent) return 'no Acme cluster';
  const ledger = proj.attrs.get(ent.key + '\u0001hq');
  if (!ledger) return 'no hq ledger';
  if (ledger[0].value !== 'Dallas') return `canonical=${ledger[0].value} (should flip to Dallas x3)`;
  if (!ledger.find(r => r.value === 'Austin')) return 'Austin vanished; history must stay';
  return null;
});

// 18. One user assertion (force 5) out-masses four doc observations.
t('one user assertion out-masses four doc observations', () => {
  const sigs = [];
  for (let i = 0; i < 4; i++) sigs.push({ id: 's' + i, seq: i, op: 'DEF', target: 'Rue McClanahan', path: 'role', value: 'Vivian', force: 1, sectionIdx: 0 });
  sigs.push({ id: 's4', seq: 4, op: 'DEF', target: 'Rue McClanahan', path: 'role', value: 'Blanche', force: 5, sectionIdx: 0 });
  const proj = projectSites({ id: 'ledg3', sigs });
  const ent = proj.entities.find(e => /mcclanahan/i.test(e.name));
  if (!ent) return 'no cluster';
  const ledger = proj.attrs.get(ent.key + '\u0001role');
  if (!ledger) return 'no role ledger';
  if (ledger[0].value !== 'Blanche' || ledger[0].mass !== 5) return `canonical ${ledger[0].value} x${ledger[0].mass}`;
  return null;
});

// 19. Mechanical lookup reports strain instead of hiding it.
t('tryMechanicalDefLookup surfaces strain', () => {
  const sigs = [
    { id: 's0', seq: 0, op: 'DEF', target: 'Carol Burnett', path: 'born', value: 'April 26, 1933', force: 1, sectionIdx: 0 },
    { id: 's1', seq: 1, op: 'DEF', target: 'Carol Burnett', path: 'born', value: 'April 26, 1933', force: 1, sectionIdx: 0 },
    { id: 's2', seq: 2, op: 'DEF', target: 'Carol Burnett', path: 'born', value: '1936', force: 1, sectionIdx: 0 },
  ];
  const att = { id: 'ledg4', title: 'Bio', sigs, spans: [], sections: [] };
  const thread = { id: 't', attachments: [att] };
  const ans = tryMechanicalDefLookup('when was Carol Burnett born?', thread);
  if (!ans) return 'returned null';
  if (!/1933/.test(ans)) return 'canonical missing';
  if (!/1936/.test(ans)) return `strain not reported: ${ans.slice(0, 120)}`;
  return null;
});

// 20. Momentum ranks a touched-light cluster above an untouched-heavy one.
t('momentum ranks touched-light above untouched-heavy', () => {
  const sigs = [];
  let seq = 0;
  for (let i = 0; i < 8; i++) sigs.push({ id: 's' + seq, seq: seq++, op: 'CON', s: 'Zeus Holdings', v: 'acquired', o: 'Atlas Group', force: 1, sectionIdx: 0, spanFromIdx: 0, spanToIdx: 0 });
  sigs.push({ id: 's' + seq, seq: seq++, op: 'DEF', target: 'Hera Partners', path: 'class', value: 'a small fund', force: 1, sectionIdx: 0, spanFromIdx: 1, spanToIdx: 1 });
  const att = {
    id: 'mom1', title: 'T', sigs,
    spans: [
      { idx: 0, sectionIdx: 0, text: 'Zeus Holdings acquired Atlas Group.', startChar: 0, endChar: 35 },
      { idx: 1, sectionIdx: 0, text: 'Hera Partners is a small fund.', startChar: 36, endChar: 66 },
    ],
    sections: [{ idx: 0, spanFromIdx: 0, spanToIdx: 1 }],
  };
  const r = pickRelevantSpansByGraph('what is Hera Partners?', [att], 1000, []);
  if (!r.ranked || !r.ranked.length) return 'no ranked output';
  if (!/hera/i.test(r.ranked[0].ent.name)) return `top by momentum: ${r.ranked[0].ent.name}`;
  const zeus = r.ranked.find(x => /zeus/i.test(x.ent.name));
  if (zeus && zeus.p >= r.ranked[0].p) return 'untouched Zeus outranked touched Hera';
  if (!r.spans.length || r.spans[0].span.idx !== 1) return 'span selection did not follow momentum';
  return null;
});

// 21. Velocity conducts one hop along edges (touching one end warms the other).
t('velocity conducts one hop along edges', () => {
  const sigs = [];
  let seq = 0;
  for (let i = 0; i < 3; i++) sigs.push({ id: 's' + seq, seq: seq++, op: 'CON', s: 'Zeus Holdings', v: 'acquired', o: 'Atlas Group', force: 1, sectionIdx: 0, spanFromIdx: 0, spanToIdx: 0 });
  const att = {
    id: 'mom2', title: 'T', sigs,
    spans: [{ idx: 0, sectionIdx: 0, text: 'Zeus Holdings acquired Atlas Group.', startChar: 0, endChar: 35 }],
    sections: [{ idx: 0, spanFromIdx: 0, spanToIdx: 0 }],
  };
  const r = pickRelevantSpansByGraph('tell me about Zeus Holdings', [att], 1000, []);
  const atlas = (r.ranked || []).find(x => /atlas/i.test(x.ent.name));
  if (!atlas) return 'Atlas got no conducted velocity';
  if (!(atlas.v > 0 && atlas.v < 1)) return `Atlas v=${atlas && atlas.v} (expected 0 < v < 1)`;
  return null;
});
```

---

## 9. Verification procedure (before shipping)

The app cannot load its CDN dependencies offline, so run two checks instead of a browser:

1. **Syntax.** Extract the contents of the single `<script type="module">` block to `check.mjs` and run `node --check check.mjs`. `node --check` parses without resolving imports, so URL imports are fine.

2. **Headless logic.** Slice the pure-function regions into a `harness.mjs` and run all 21 tests there. The regions to include (function declarations hoist, so order does not matter):
   - `newId` through `getSession` (gives `migrateSession`)
   - `STOP`/`tokenize`/`parseQuery`/`scoreChunkAgainstQuery`
   - `ENTITY_GRAINS` through the integral-summary comment (gives `tokenSetOf`, `aliasRelation`)
   - `PRONOUNS` through the model-call comment (gives `STANCE_OF_OP`, `DISCOURSE_JUNK`, `tryAdmit`, `parseEventLines`, `eventContributingSlots`)
   - `sweepSectionSigs` through the deep-read comment (gives `activationAt`)
   - `splitSentences` through `readAttachment` (gives `mechanicalReadAttachment` and friends)
   - the `GAMMA`/`FORCE` line through the entity-picker comment (gives `classifyTerrain`, `projectSites`, `projectEntities`, `projectEdges`)
   - the momentum `pickRelevantSpansByGraph`
   - the meta-matcher comment through `async function send()` (gives `tryMechanicalDefLookup`, `looksLikeFollowUp`)
   - `runEventLayerTests`

   Append a runner:
   ```js
   const out = runEventLayerTests();
   let bad = 0;
   for (const r of out) { console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.pass ? '' : '  ->  ' + r.detail)); if (!r.pass) bad++; }
   console.log(bad ? `\n${bad} FAILING` : `\nall ${out.length} passing`);
   process.exit(bad ? 1 : 0);
   ```

3. **In-app.** Open the file, run `/test` (expect 21 green), then `/physics` and `/physics <query>` to inspect mass, strain, and momentum. Attach a document, ask a question, and confirm the dispatch badge shows the GROUND / STRUCTURE prompt and that its length is at or under the profile cap.

---

## 10. Invariants and edge cases checklist

- The event log is append-only. `seq` always equals the index in `att.sigs`. Do not reorder or delete.
- `mentions` (raw count) and `mass` (Σ force) diverge only once user force lands; keep both.
- `resolves-to` DEFs are ledger data but are skipped by both the lookup and the STRUCTURE builder (they are bookkeeping, not facts).
- A pronoun-target DEF resolves through `targetHint.name`; if there is no hint, the row is skipped (no cluster).
- "What is this about" style queries touch no named entity, so `graphRanked` is empty; GROUND falls back to top-mass entities and STRUCTURE falls back to the focus document's summary at priority 2.
- The STRUCTURE packing loop must `continue` (not `break`) on an over-budget line.
- The hard ceiling on the assembled system message is `sysCap * 1.25`.
- Memoization: `projectSites` keys on `att.id` + sig count + cursor; the new `attrs`/`strains` ride inside the memoized value, so no cache change is needed (events are append-only).
- Entities are derived, not persisted, so exporting `sigSeqs` does not change stored session size; `ev.force` adds one small field per event.

---

## 11. Out of scope (Phases 3 and 4)

Do not build these now. They are recorded so the Phase 1 and 2 work leaves the right seams.

- **Phase 3, the loop.** A rules store in `localStorage` (global, with mass), an error classifier in `send()` that detects corrections (`/^(no|nope|wrong|not quite)/` or a near-repeat of the prior query at token overlap above ~0.7), correction-driven DEFs minted at `FORCE.user`, synonym minting on miss-then-hit adjacency (gated by the same two-sighting rule), and `/rules`. Rules never serialize into the prompt; they only reweight routing and selection. `FORCE.user` is already wired in Phase 1, ready for this.
- **Phase 4, surfaces.** Strain and surprise in the library cards, node radius = mass and glow = velocity in the preview graph render, and a collision audit so two heavy clusters never silently alias-merge (light pairs merge freely; heavy pairs wait for user force).
