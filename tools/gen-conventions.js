/* ============================================================
   tools/gen-conventions.js — emit conventions.jsonl from the engine's live
   convention inventories (READING_RULES en-narrative module + LANG_PACKS).

   The JSONL is the durable, append-friendly store of everything
   HUMAN-LANGUAGE-specific, as a graph of eo operations (see the
   SEMANTICS GRAPH note in engine.js). This generator exists so the file
   can be (re)derived from the seeds during the migration period;
   tests/conventions.test.js proves file ≡ seeds either way. Run:

     node tools/gen-conventions.js          # rewrites ./conventions.jsonl
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('../evo/engine-host');

const OUT = path.join(__dirname, '..', 'conventions.jsonl');

// Affinity text per module: what kinds of CONTENT these conventions belong
// to. The embedder hook — at runtime an embedding score between a document
// and this text can pick the register, the same way the engine already
// detects language by script.
const MODULE_AFFINITY = {
  'en-narrative-v1': '19th and early-20th century English narrative prose: novels, short fiction, literary translation. Gendered third-person pronouns; "they" is plural; titled forms of address (Mr., Princess); quoted dialogue with said-attribution.',
  'es-narrative-v1': 'Spanish narrative prose: raya (—) dialogue with mid-quote attribution, guillemets, gendered articles, don/doña as lowercase name heads.',
  'zh-narrative-v1': 'Chinese narrative prose: no case, no whitespace; names as repeated character sequences; colon-quote speech (说：「…」).',
  'code-v1': 'Source code as text: declaration is INS, assignment is DEF, a call is a clause edge, a scope is a scene.',
};
// Per-convention affinity, where a single convention is a REGISTER call that
// cuts across a module (the Shakespeare-vs-NYT axis).
const CONVENTION_AFFINITY = {
  singular_they: 'Contemporary journalism, social media, technical and modern literary prose, where "they" routinely refers to one named person. NOT 19th-century narrative, where "they" is a plural.',
  lowercase_evidence_disqualify: 'Case-distinguishing scripts (Latin, Cyrillic, Greek). Not applicable where capitalization does not mark names (Chinese, Japanese) or marks every noun (German).',
};
// Word-level property DEFs for the pronoun graph — the relations that make it
// a graph of meaning rather than flat lists. Properties are conventions too.
const EN_WORD_PROPS = {
  he: { gender: 'm', person: 3, number: 'singular', case: 'subject', animacy: 'person' },
  him: { gender: 'm', person: 3, number: 'singular', case: 'object', animacy: 'person' },
  his: { gender: 'm', person: 3, number: 'singular', case: 'possessive', animacy: 'person' },
  she: { gender: 'f', person: 3, number: 'singular', case: 'subject', animacy: 'person' },
  her: { gender: 'f', person: 3, number: 'singular', case: 'object', animacy: 'person' },
  hers: { gender: 'f', person: 3, number: 'singular', case: 'possessive', animacy: 'person' },
  they: { gender: null, person: 3, number: 'plural-or-singular-by-register', case: 'subject', animacy: 'person' },
  them: { gender: null, person: 3, number: 'plural-or-singular-by-register', case: 'object', animacy: 'person' },
  their: { gender: null, person: 3, number: 'plural-or-singular-by-register', case: 'possessive', animacy: 'person' },
  theirs: { gender: null, person: 3, number: 'plural-or-singular-by-register', case: 'possessive', animacy: 'person' },
  it: { gender: null, person: 3, number: 'singular', case: 'subject', animacy: 'nonperson' },
  its: { gender: null, person: 3, number: 'singular', case: 'possessive', animacy: 'nonperson' },
  i: { person: 1, number: 'singular', case: 'subject' },
  we: { person: 1, number: 'plural', case: 'subject' },
  you: { person: 2, number: 'singular-or-plural', case: 'subject-or-object' },
  who: { person: 3, case: 'subject', animacy: 'person', class: 'relative' },
  whom: { person: 3, case: 'object', animacy: 'person', class: 'relative' },
  this: { class: 'demonstrative' }, that: { class: 'demonstrative' },
  these: { class: 'demonstrative' }, those: { class: 'demonstrative' },
};

(async () => {
  const E = loadEngine().EOEngine;
  const exp = E._conventionsExport();
  const lines = [];
  let seq = 0;
  const emit = (obj) => lines.push(JSON.stringify({ seq: seq++, ...obj }));

  emit({
    op: 'REC', target: 'semantics', action: 'charter',
    value: 'The mechanics are universal; everything human-language-specific is a convention, and no inventory is more real than another — you, y\'all, ella, vous, 她 are equal citizens. This file is the append-only graph of those conventions, related through eo operations: INS instantiates a module or a convention, SYN member-of edges carry inventories (seq order is list order), DEF carries properties and structured values, REC records the register laws. The engine projects it like any other event log (projectSemantics) and falls back to its seeds when the file is absent.',
  });

  // structured values (everything that isn't a plain membership list)
  const STRUCTURED = new Set(['attribution_patterns', 'continuation_inheritance', 'quote_pairs',
    'promote_requires_uppercase_first', 'singular_they', 'lowercase_evidence_disqualify', 'attribution_verbs']);

  for (const [modId, mod] of Object.entries(exp.modules)) {
    emit({
      op: 'INS', kind: 'module', id: modId, target: modId, language: mod.language,
      affinity: MODULE_AFFINITY[modId] || null,
    });
    for (const [p, v] of Object.entries(mod.props || {})) {
      emit({ op: 'DEF', kind: 'module-prop', module: modId, target: modId, path: p, value: v });
    }
    for (const [rule, value] of Object.entries(mod.conventions)) {
      if (rule === 'attribution_verbs') {
        // induced, never seeded: the inventory is empty by design and grows by
        // REC at read time. Record the convention node and the law, no members.
        emit({ op: 'INS', kind: 'convention', id: modId + ':' + rule, rule, module: modId });
        emit({ op: 'REC', target: modId + ':' + rule, action: 'induced-not-seeded', value: 'Attribution verbs bootstrap from typography (the closing-quote slot) in any language; admission is two sightings; every confirmation adds mass.' });
        continue;
      }
      const id = modId + ':' + rule;
      emit({
        op: 'INS', kind: 'convention', id, rule, module: modId,
        affinity: CONVENTION_AFFINITY[rule] || null,
      });
      if (STRUCTURED.has(rule) || !Array.isArray(value) || value.length === 0) {
        // structured values, booleans, and EMPTY inventories (a convention this
        // module simply doesn't have — zh has no articles) carry an explicit
        // value, so projection knows "empty" from "unstated".
        emit({ op: 'DEF', target: id, path: 'value', value });
      } else {
        for (const w of value) emit({ op: 'SYN', s: w, v: 'member-of', o: id });
      }
    }
  }

  // the pronoun property graph (en): the relations between surfaces — gender,
  // person, number, case, animacy — each a DEF on the word within the module.
  for (const [w, props] of Object.entries(EN_WORD_PROPS)) {
    for (const [p, v] of Object.entries(props)) {
      emit({ op: 'DEF', kind: 'word-prop', module: 'en-narrative-v1', target: w, path: p, value: v });
    }
  }

  // the register laws, in the engine's own change vocabulary
  emit({
    op: 'REC', target: 'en-narrative-v1:singular_they', action: 'register-law',
    value: 'Whether "they" may be read as a singular reference to one named person is a property of the register, not of English: on for contemporary prose, off for 19th-century narrative where it would fuse a group into one character. When on, the binding teaches personhood but never gender.',
  });
  emit({
    op: 'REC', target: 'en-narrative-v1:role_clause_verbs', action: 'register-law',
    value: 'Journalism states roles relationally ("the same person who runs the DMC") where fiction uses appositives; the naming bridge distills these clauses into role DEFs so a role question can be answered from the graph.',
  });

  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log('wrote ' + OUT + ' — ' + lines.length + ' records (' + seq + ' ops)');
})().catch(e => { console.error(e); process.exit(1); });
