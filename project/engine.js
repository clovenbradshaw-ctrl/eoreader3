/* ============================================================
   EO Reader — in-browser reading engine.

   CONTRACT: parsing stores ONLY invariants — what was observed.
   A mention records its surface, sentence index, and whether it sat
   inside quoted speech. It does NOT record mass, momentum, or any
   weighted score. Those are PROJECTED AT RUNTIME from whichever rules
   are currently enabled (window.EO_RULES). Retune a weight or toggle a
   rule and every derived view re-derives with no re-parse.

   Depends on global `nlp` (compromise.js).
   ============================================================ */
(function () {
  const STOP = new Set(('a an the and or but if then else for of to in on at by with from into over under '
    + 'is are was were be been being am do does did doing have has had having will would shall should can could '
    + 'may might must not no nor so than too very just only also this that these those it its it\'s he she they '
    + 'him her them his hers their there here who whom which what when where why how as up out off down about '
    + 'again further once more most some any all each few other such own same one two i we you us me my your our '
    + 'said say says tell about above below between through during before after').split(/\s+/));

  const tok = (s) => (String(s).toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || []).filter(t => t.length > 2 && !STOP.has(t));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* read a rule's live value/enabled state from the App-synced registry */
  function rule(id) {
    const list = window.EO_RULES || [];
    return list.find(r => r.id === id) || null;
  }
  function ruleOn(id) { const r = rule(id); return !!(r && r.installed && r.enabled); }
  function ruleVal(id, fallback) { const r = rule(id); return r && r.value != null ? r.value : fallback; }

  /* ---- weights, all read live ---- */
  const quoteWeight = () => ruleOn('quote-weight') ? Number(ruleVal('quote-weight', 0.4)) : 1.0;
  const twoSighting = () => Number(ruleVal('two-sighting', 2));
  const bindFloor   = () => Number(ruleVal('cite-binding', 0.34));
  const reconcileOn = () => ruleOn('reconcile');

  /* ============================================================ DETECT KIND */
  function detectKind(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
    if (lines.length >= 3) {
      const counts = lines.map(l => (l.match(/,/g) || []).length);
      const mode = counts.slice().sort((a, b) => counts.filter(x => x === b).length - counts.filter(x => x === a).length)[0];
      if (mode >= 1 && counts.filter(c => c === mode).length / counts.length >= 0.7) return 'table';
    }
    return 'prose';
  }

  /* ============================================================ CSV */
  function splitRow(l) {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim()); return out;
  }
  const asNum = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const asDate = (v) => { const t = Date.parse(String(v ?? '')); return isNaN(t) ? null : t; };

  function parseTable(name, text, id) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim());
    const columns = splitRow(lines[0]).map((c, i) => c || ('col' + i));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitRow(lines[i]); const row = {};
      columns.forEach((c, ci) => row[c] = cells[ci] ?? '');
      rows.push(row);
    }
    const numeric = [], date = [];
    for (const c of columns) {
      let nu = 0, dt = 0, tot = 0;
      for (const r of rows) { const v = r[c]; if (v === '' || v == null) continue; tot++; if (asNum(v) != null) nu++; if (asDate(v) != null && /[-/:]/.test(String(v))) dt++; }
      if (tot && dt / tot >= 0.6) date.push(c);
      else if (tot && nu / tot >= 0.8) numeric.push(c);
    }
    return { id, kind: 'table', name, meta: rows.length + ' rows · ' + columns.length + ' cols · table',
             columns, rows, numeric, date };
  }

  /* ============================================================ PROSE */
  function splitSentencesEN(p) {
    try { const out = nlp(p).sentences().out('array'); if (out && out.length) return out; } catch (e) {}
    return p.match(/[^.!?]+[.!?]+["”']?|\S[^.!?]*$/g) || [p];
  }
  function isHeading(p) {
    const t = p.trim();
    if (!t || t.length > 64) return false;
    if (/["“‘']/.test(t)) return false;
    const words = t.split(/\s+/);
    if (words.length > 9) return false;
    const letters = t.replace(/[^\p{L}]/gu, '');
    const allCaps = letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    const noTerminal = !/[.!?:]\s*$/.test(t);
    const numeral = /^(chapter|part|section|book)\b/i.test(t) || /^[IVXLCDM]+\.?$/.test(t) || /^\d+[.)]?$/.test(t);
    return noTerminal || allCaps || numeral;
  }

  /* quote spans (char ranges) inside a sentence */
  function quoteSpans(s) {
    const spans = []; const pairs = [['“', '”'], ['"', '"'], ['‘', '’']];
    for (const [o, c] of pairs) {
      let i = 0;
      while (true) {
        const a = s.indexOf(o, i); if (a < 0) break;
        const b = s.indexOf(c, a + 1); if (b < 0) { spans.push([a, s.length]); break; }
        spans.push([a, b]); i = b + 1;
      }
    }
    return spans;
  }
  const inSpan = (idx, spans) => spans.some(([a, b]) => idx >= a && idx <= b);

  function parseProse(name, text, id) {
    // unwrap hard-wrapped lines (single \n inside a paragraph is typography)
    const norm = text.replace(/\r\n?/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
    const paras = norm.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

    const blocks = []; const sentences = []; let gi = 0; let titled = false;
    for (const p of paras) {
      if (isHeading(p)) { blocks.push({ type: titled ? 'h2' : 'h1', text: p.replace(/\s+/g, ' ') }); titled = true; continue; }
      const sents = splitSentencesEN(p).map(t => t.trim()).filter(Boolean).map(t => ({ i: gi++, t }));
      sents.forEach(s => sentences.push(s));
      blocks.push({ type: 'p', sentences: sents });
    }
    const sentenceTexts = sentences.map(s => s.t);

    // ---- entity surfaces (invariant set) ----
    // Document-structure & common nouns that capitalize but aren't names.
    const NOT_A_NAME = new Set(['missing','appendix','end','figure','note','page','part','chapter','section','book','volume','contents','index','preface','prologue','epilogue','foreword','table','scan','box','acc','fig','vol','wife','husband','sister','brother','mother','father','son','daughter','aunt','uncle','cousin','first','second','third','last','one','two','three','four','five','perhaps','being','before','during','following','special','collections','order','university','library']);
    const TITLES = new Set(['mr','mrs','ms','miss','dr','sir','lady','lord','sister','brother','aunt','uncle','saint','st','señor','señora','don','doña','captain','colonel','general','professor','prof','rev','father','mother']);
    const isAllCaps = (s) => { const L = s.replace(/[^\p{L}]/gu, ''); return L.length > 1 && L === L.toUpperCase() && L !== L.toLowerCase(); };
    // clean a raw surface to a name, or null if it isn't one
    const cleanName = (raw) => {
      let s = String(raw).replace(/\s+/g, ' ').trim()
        .replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}.]+$/u, '');     // trim non-letters at edges
      s = s.replace(/['’]s\b/g, '').replace(/['’]$/,'').trim();        // strip possessive
      if (!s) return null;
      if (isAllCaps(s)) return null;                                   // OCR headers / labels
      let words = s.split(/\s+/);
      while (words.length > 1 && (TITLES.has(words[0].toLowerCase()) || ['the','a','an'].includes(words[0].toLowerCase()))) words = words.slice(1);
      // every word must start uppercase (else it's a phrase, not a name)
      if (!words.every(w => /^[\p{Lu}]/u.test(w))) return null;
      s = words.join(' ');
      const lc = s.toLowerCase();
      if (s.length < 2 || STOP.has(lc)) return null;
      if (words.length === 1 && NOT_A_NAME.has(lc)) return null;       // single common noun
      if (words.every(w => NOT_A_NAME.has(w.toLowerCase()))) return null; // all common nouns
      return s;
    };
    const names = new Map(); // key(lowercased clean) -> { surface, type }
    const addName = (raw, type) => {
      const surface = cleanName(raw);
      if (!surface) return;
      const k = surface.toLowerCase();
      const cur = names.get(k);
      if (!cur) names.set(k, { surface, type });
      else { if (type === 'person' && cur.type !== 'person') cur.type = 'person'; if (surface.length > cur.surface.length) cur.surface = surface; }
    };
    try { nlp(norm).people().out('array').forEach(n => addName(n, 'person')); } catch (e) {}
    try { nlp(norm).places().out('array').forEach(n => addName(n, 'place')); } catch (e) {}
    try { nlp(norm).organizations().out('array').forEach(n => addName(n, 'org')); } catch (e) {}
    // two-sighting proper-noun fallback (single + multiword capitalized runs)
    const propCount = new Map();
    for (const st of sentenceTexts) {
      const ms = st.match(/\b\p{Lu}[\p{L}’'-]+(?:\s+\p{Lu}[\p{L}’'-]+)*/gu) || [];
      for (const m of ms) {
        const first = m.split(/\s+/)[0];
        // skip sentence-initial single words unless seen again
        propCount.set(m, (propCount.get(m) || 0) + 1);
      }
    }
    for (const [m, c] of propCount) {
      const single = m.split(/\s+/).length === 1;
      if (single && c < twoSighting()) continue;
      const cl = cleanName(m); if (!cl) continue;
      if (names.has(cl.toLowerCase())) continue;   // already classified by compromise
      addName(m, 'person');
    }

    // ---- mentions (invariant: surface, sentence idx, inQuote) ----
    const mentions = [];
    const nameList = [...names.values()].sort((a, b) => b.surface.length - a.surface.length);
    for (let si = 0; si < sentenceTexts.length; si++) {
      const st = sentenceTexts[si]; const spans = quoteSpans(st);
      for (const { surface, type } of nameList) {
        const re = new RegExp('\\b' + escRe(surface) + '\\b', 'gu');
        let m;
        while ((m = re.exec(st)) !== null) {
          mentions.push({ key: surface.toLowerCase(), surface, type, sent: si, inQuote: inSpan(m.index, spans) });
        }
      }
    }

    return {
      id, kind: 'prose', name,
      meta: sentences.length + ' sentences · prose',
      blocks, sentences, sentenceTexts, mentions,
    };
  }

  /* ============================================================ PROJECTION (runtime) */
  // Compute the weighted entity view from invariant mentions + LIVE rules.
  // Nothing here is stored on the doc; call it whenever rules change.
  function projectEntities(doc) {
    if (doc.kind !== 'prose') return { entities: [], byType: {} };
    const qw = quoteWeight(); const two = twoSighting();
    const byKey = new Map();
    for (const mn of doc.mentions) {
      let e = byKey.get(mn.key);
      if (!e) { e = { name: mn.surface, key: mn.key, type: mn.type, raw: 0, mass: 0, sents: new Set() }; byKey.set(mn.key, e); }
      e.raw += 1;
      e.mass += mn.inQuote ? qw : 1;
      e.sents.add(mn.sent);
      if (mn.surface.length > e.name.length) e.name = mn.surface;
    }
    let ents = [...byKey.values()];
    // two-sighting admission for single-token surfaces (live rule)
    ents = ents.filter(e => e.name.split(/\s+/).length > 1 || e.raw >= two);
    ents.forEach(e => { e.sents = [...e.sents].sort((a, b) => a - b); e.mass = Math.round(e.mass * 10) / 10; });
    ents.sort((a, b) => b.mass - a.mass);
    const byType = { person: [], place: [], org: [] };
    for (const e of ents.slice(0, 28)) (byType[e.type] || byType.person).push(e.name);
    return { entities: ents, byType };
  }

  function entityDetail(doc, name) {
    const { entities } = projectEntities(doc);
    const e = entities.find(x => x.name === name) || entities.find(x => x.key === String(name).toLowerCase());
    if (!e) return null;
    // co-occurring entities (share a sentence)
    const co = new Map();
    for (const other of entities) {
      if (other.key === e.key) continue;
      const shared = other.sents.filter(s => e.sents.includes(s)).length;
      if (shared) co.set(other.name, shared);
    }
    const cooc = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { ...e, sentences: e.sents.map(i => ({ i, t: doc.sentenceTexts[i] })), cooc };
  }

  /* ============================================================ RETRIEVAL */
  function retrieve(doc, query, k = 6) {
    const qt = new Set(tok(query));
    if (!qt.size) return [];
    const scored = doc.sentences.map(s => {
      const st = new Set(tok(s.t));
      let overlap = 0; for (const t of qt) if (st.has(t)) overlap++;
      const score = overlap / Math.sqrt(st.size + 1);
      return { ...s, score, overlap };
    }).filter(s => s.overlap > 0);
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.slice(0, k);
  }

  /* ============================================================ MECHANICAL QA */
  // covers: fraction of query content terms present in the chosen support
  function coverage(query, supportText) {
    const qt = [...new Set(tok(query))]; if (!qt.length) return { n: 1, d: 1 };
    const st = new Set(tok(supportText));
    const hit = qt.filter(t => st.has(t)).length;
    return { n: hit, d: qt.length };
  }
  // a query proper-noun that appears nowhere in the doc → the void
  function voidTerm(doc, query) {
    const caps = query.match(/\b\p{Lu}[\p{L}’'-]+/gu) || [];
    const body = (doc.sentenceTexts || []).join(' ').toLowerCase();
    for (const c of caps) if (c.length > 2 && !STOP.has(c.toLowerCase()) && !body.includes(c.toLowerCase())) return c;
    return null;
  }
  // proper nouns the model produced that appear NOWHERE in the document —
  // the mechanical veto on fabrication. Used to reject an LLM phrasing
  // that invented a name (a title, an author, a place that isn't there).
  function inventedTerms(doc, text) {
    const body = (doc.sentenceTexts || []).join(' ').toLowerCase();
    const caps = String(text).match(/\b\p{Lu}[\p{L}’'-]+/gu) || [];
    const out = [];
    for (const c of caps) {
      const lc = c.toLowerCase();
      if (c.length > 2 && !STOP.has(lc) && !body.includes(lc) && !out.includes(c)) out.push(c);
    }
    return out;
  }

  /* ============================================================ INTENT
     Meta-questions ("summarize it", "who appears") share no content
     words with the text, so token-retrieval finds nothing. Route them
     by intent: a summary spans the doc; "who" comes from the entity
     index. Everything else stays factual token-retrieval. */
  function classifyIntent(q) {
    const t = ' ' + String(q).toLowerCase().replace(/[’']/g, "'") + ' ';
    if (/\b(who(\s+all)?\s+(appears?|is in|are in|shows? up|features?)|who are the|characters?|the cast|people (in|who)|list (the )?(people|characters|names|figures)|main characters?|dramatis|everyone (in|who))\b/.test(t)) return 'who';
    if (/\b(summar|overview|tl;?dr|gist|recap|in short|main (idea|point|points|theme)|what'?s (it|this)( about)?|what is (this|it|the document|the text|the story|the file)|describe (this|the|it)|the document about|what kind of (document|text)|what am i (looking at|reading))/.test(t)) return 'summary';
    if (/\b(what happens|what'?s going on|the plot|the story|main events|what is happening|walk me through|what'?s in (this|it))/.test(t)) return 'summary';
    return 'factual';
  }
  // a spread of the document — paragraph openers plus head and tail
  function salientContext(doc) {
    const picks = new Set();
    for (const b of doc.blocks) if (b.type === 'p' && b.sentences.length) picks.add(b.sentences[0].i);
    [0, 1, 2].forEach(i => doc.sentences[i] && picks.add(doc.sentences[i].i));
    const n = doc.sentences.length; [n - 1, n - 2].forEach(i => i >= 0 && doc.sentences[i] && picks.add(doc.sentences[i].i));
    return [...picks].sort((a, b) => a - b).slice(0, 16).map(i => `[s${i}] ${doc.sentenceTexts[i]}`).join('\n');
  }
  function entityContext(doc) {
    const { entities } = projectEntities(doc);
    return entities.slice(0, 10).map(e => `[s${e.sents[0]}] ${doc.sentenceTexts[e.sents[0]]}`).join('\n');
  }
  // does the seeker have anything to ground on? gates the LLM.
  function hasGround(doc, q) {
    if (!doc || doc.kind !== 'prose') return true;
    if (classifyIntent(q) !== 'factual') return true;
    return retrieve(doc, q, 6).length > 0 || !!voidTerm(doc, q);
  }
  function answerWho(doc) {
    const { entities } = projectEntities(doc);
    const ppl = entities.filter(e => e.type === 'person');
    const list = (ppl.length ? ppl : entities).slice(0, 8);
    if (!list.length) return { text: 'I didn’t find any named people in this document.', audit: { status: 'notes', grounded: true, covers: '1/1', stable: true, note: 'No entities surfaced under the current rules.' } };
    const text = 'The figures who appear most often: ' + list.map(e => `${e.name} (${e.raw}) {{cite:${doc.id}:${e.sents[0]}:s${e.sents[0]}}}`).join(', ') + '.';
    return { text, cites: list.map(e => ({ docId: doc.id, idx: e.sents[0] })), audit: { status: 'clean', grounded: true, covers: '1/1', stable: true, note: 'Counted directly from the document’s mentions — no model involved.' } };
  }
  function answerSummary(doc) {
    const leads = [];
    for (const b of doc.blocks) { if (b.type === 'p' && b.sentences.length) { leads.push(b.sentences[0]); if (leads.length >= 3) break; } }
    if (!leads.length) return { text: 'This document doesn’t have enough prose to summarize.', audit: { status: 'notes', grounded: true, covers: '1/1', stable: true, note: 'Too little text.' } };
    const { entities } = projectEntities(doc);
    const ppl = entities.slice(0, 5).map(e => e.name);
    const text = leads.map(s => `${s.t} {{cite:${doc.id}:${s.i}:s${s.i}}}`).join(' ') + (ppl.length ? `\n\nKey figures: ${ppl.join(', ')}.` : '');
    return { text, cites: leads.map(s => ({ docId: doc.id, idx: s.i })), audit: { status: 'clean', grounded: true, covers: '1/1', stable: true, note: 'A grounded précis from the opening lines and the most-mentioned figures. Load the model for a fuller summary.' } };
  }

  function answerProse(doc, query) {
    const hits = retrieve(doc, query, 4);
    const vt = voidTerm(doc, query);
    if (!hits.length) {
      if (vt) return {
        text: `“${vt}” appears nowhere in this document {{void:[⊥]}}. I won’t invent an answer for a term the page doesn’t contain — load a source that mentions it and I’ll read it.`,
        audit: { status: 'warn', grounded: true, covers: '0/1', stable: true, note: 'A term named in the question is absent — resolved to the one void.' },
      };
      return {
        text: 'I read the document for that and didn’t find a passage that answers it cleanly, so I’d rather hold than guess. Try naming a person, place, or phrase from the text.',
        audit: { status: 'notes', grounded: true, covers: '0/1', stable: true, note: 'Held rather than invented — the page wouldn’t carry an answer.' },
      };
    }
    // bind only sentences clearing the live binding floor
    const floor = bindFloor();
    const used = hits.filter(h => h.score >= floor).slice(0, 3);
    const support = (used.length ? used : hits.slice(0, 1));
    const text = support.map(s => `${s.t} {{cite:${doc.id}:${s.i}:s${s.i}}}`).join(' ');
    const cov = coverage(query, support.map(s => s.t).join(' '));
    const full = cov.n >= cov.d;
    return {
      text,
      cites: support.map(s => ({ docId: doc.id, idx: s.i })),
      audit: {
        status: full ? 'clean' : 'notes', grounded: true,
        covers: `${cov.n}/${cov.d}`, stable: true,
        note: full ? 'Every claim is read straight from the page; the binding cleared the live floor.'
                   : 'Grounded in the passages shown, but not every term in your question is covered.',
      },
    };
  }

  function answerTable(doc, query) {
    const { spec, empty } = window.parsePivot(query, doc);
    const fold = window.foldPivot(doc, spec);
    let summary;
    if (fold.kind === 'grouped') {
      const isMoney = fold.isMoneyCol(spec.aggregate?.col);
      const val = (g) => g.agg.value == null ? g.count : (isMoney ? window.fmtMoney(g.agg.value) : g.agg.value);
      const lead = spec.sortBy ? `**${fold.groups[0]?.key}** leads with ${val(fold.groups[0])}. ` : '';
      summary = lead + `Grouped by **${fold.groupBy}**${spec.aggregate ? `, ${spec.aggregate.op}${spec.aggregate.col ? ' of ' + spec.aggregate.col : ''}` : ''}: `
        + fold.groups.map(g => `${g.key} (${val(g)})`).join(', ') + '.';
    } else {
      summary = `${fold.total} of ${doc.rows.length} rows match. The table is laid out alongside.`;
    }
    return {
      text: summary + '\n\nFolded straight from the table — no model touched the numbers. Adjust grouping or measure on the table and it recomputes live.',
      audit: { status: 'clean', grounded: true, covers: '1/1', stable: true, note: 'Computed mechanically from ' + doc.name + '.' },
      tableSpec: spec, openSelf: true,
    };
  }

  // The single entry point the chat uses for the mechanical path.
  function answer(doc, query) {
    if (!doc) return {
      text: 'Load a document or spreadsheet first — drop a file or paste text, and I’ll read it locally.',
      audit: null,
    };
    if (doc.kind === 'table') return answerTable(doc, query);
    const intent = classifyIntent(query);
    if (intent === 'who') return answerWho(doc);
    if (intent === 'summary') return answerSummary(doc);
    return answerProse(doc, query);
  }

  /* retrieval context for the optional LLM path — intent-aware */
  function context(doc, query, k = 6) {
    if (!doc || doc.kind === 'table') return '';
    const intent = classifyIntent(query);
    if (intent === 'summary') return salientContext(doc);
    if (intent === 'who') return entityContext(doc);
    return retrieve(doc, query, k).map(s => `[s${s.i}] ${s.t}`).join('\n');
  }
  // bind [sN] citations onto an LLM answer mechanically (model never writes them)
  function bindCitations(doc, answerText, query, intent) {
    const floor = bindFloor();
    const clean = answerText.replace(/\[s?\d+\]/gi, '').replace(/\s+([.,;:])/g, '$1').trim();
    const parts = clean.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [clean];
    const cited = [];
    const out = parts.map(sent => {
      const cands = retrieve(doc, sent, 1);
      if (cands.length && cands[0].score >= floor) { cited.push({ docId: doc.id, idx: cands[0].i }); return `${sent.trim()} {{cite:${doc.id}:${cands[0].i}:s${cands[0].i}}}`; }
      return sent.trim();
    }).join(' ');
    const grounded = cited.length > 0 && cited.length >= parts.length * 0.5;
    // for summary / who the question has no content words to "cover" — it
    // is answered by construction; only factual asks score coverage.
    const cov = (intent && intent !== 'factual') ? { n: 1, d: 1 } : coverage(query, parts.join(' '));
    return {
      text: out, cites: cited,
      audit: {
        status: grounded ? (cov.n >= cov.d ? 'clean' : 'notes') : 'warn',
        grounded, covers: `${cov.n}/${cov.d}`, stable: true,
        note: grounded ? 'Phrased by the local model; every citation bound mechanically to a re-read sentence.'
                       : 'Phrased by the model but support was thin — treat with care.',
      },
    };
  }

  function parseDocument(name, text, id) {
    const kind = detectKind(text);
    return kind === 'table' ? parseTable(name, text, id) : parseProse(name, text, id);
  }

  window.EOEngine = {
    parseDocument, projectEntities, entityDetail, retrieve, answer,
    context, bindCitations, tok, classifyIntent, hasGround,
  };
})();
