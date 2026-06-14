/* ============================================================ Composition pane

   The long-form artifact: two panes over ONE Given-Log fold. The plan on the
   left, the assembled draft on the right, both projected from the same event
   log (doc._events) by window.EOComposition.fold — never stored, always
   derived. Every edit the user makes appends events; undo is supersession.

   This file is the SURFACE. The intelligence — the fold, the grain-relative
   witness, the form stamp, the monitor's predicates, the talker orchestration —
   lives in composition.js (window.EOComposition), pure and tested. Here we
   render the fold and wire the real engine (EOEngine.retrieveScope), the real
   talker (EOLLM.phrase), the real embedder (EOEmbed), and the form library
   (EOFormLibrary) into the injected deps that module expects.

   With no composition doc open this file renders nothing and touches nothing —
   the non-breaking floor holds.
   ============================================================ */

const CMP_GENRES = ['plain-report', 'news-article', 'encyclopedic-summary', 'obituary', 'letter', 'recipe'];
const CMP_GRAINS = ['Figure', 'Ground', 'Pattern'];
// Confidence components, in display order, with one-word glosses for the hover.
const CMP_COMPONENTS = [
  ['witness', 'how much of the prose a span backs'],
  ['form', 'how much it looks like its genre'],
  ['coherence', 'how it sits against the whole, under the frame'],
  ['retrieval', 'whether the retriever found material'],
  ['temporal', 'the freshness of the spans'],
  ['frame', "the job's alignment with the doc's goal"],
];
const BAND_LABEL = { owed: 'owed', advance: 'advance', revise: 'revise', fetch: 'fetch', contested: 'contested', held: 'held', drafted: 'drafted' };

/* A single Confidence vector, as a row of labelled bars. A component that was
   not measured is shown as `null` — never a zero-height bar, which would read as
   "measured, and zero". The one place a scalar appears is the colour band; the
   predicate that produced it travels on the route (shown on hover). */
function ConfBars({ confidence, tag, rescued }) {
  const c = confidence || {};
  return (
    <div className="cmp-conf">
      {CMP_COMPONENTS.map(([k, gloss]) => {
        const v = c[k];
        const measured = v != null;
        return (
          <div key={k} className="cmp-conf-row" title={k + ' — ' + gloss + (measured ? (' · ' + Math.round(v * 100) + '%') : ' · not measured')}>
            <span className="cmp-conf-k">{k}</span>
            <span className="cmp-conf-track">
              {measured
                ? <span className={'cmp-conf-fill ' + fillClass(k, v)} style={{ width: Math.round(v * 100) + '%' }} />
                : <span className="cmp-conf-null">null</span>}
            </span>
            <span className="cmp-conf-v">{measured ? Math.round(v * 100) : '·'}</span>
          </div>
        );
      })}
      {tag && <div className={'cmp-tag cmp-tag-' + tag}>{tag}{rescued && <span className="cmp-tag-rescued" title="Grounded by mechanical re-citation: the token-overlap witness read low, so each sentence was re-bound to a real source line after drafting (engine.groundTalkerOutput).">· re-cited</span>}</div>}
    </div>
  );
}
function fillClass(k, v) {
  // witness/coherence get the warn/bad treatment when low; the rest stay neutral
  if ((k === 'witness' || k === 'coherence')) return v >= 0.5 ? 'good' : v >= 0.3 ? 'warn' : 'bad';
  if (k === 'form') return v >= 0.5 ? 'good' : 'warn';
  return 'neutral';
}

/* A compact sparkline for the plan tree node: just witness + form + coherence,
   the three the monitor gates on, so the tree stays scannable. */
function ConfSpark({ confidence }) {
  const c = confidence || {};
  return (
    <span className="cmp-spark" aria-hidden="true">
      {['witness', 'form', 'coherence'].map(k => {
        const v = c[k];
        return <span key={k} className={'cmp-spark-bar ' + (v == null ? 'null' : fillClass(k, v))}
          style={{ height: v == null ? 3 : Math.max(3, Math.round(v * 14)) }} title={k + (v == null ? ': null' : ': ' + Math.round(v * 100) + '%')} />;
      })}
    </span>
  );
}

/* The frame — the rhetorical problem as an object, editable. Editing it is a new
   frame event (latest wins); the spec's invalidation of coherence on a frame
   move is handled by the standing operator (phase three) when it ships. */
function FrameEditor({ frame, onChange, corpus, allProse, onCorpus, modelName }) {
  const [open, setOpen] = React.useState(true);
  const f = frame || {};
  const fld = (key, label, ph) => (
    <label className="cmp-field">
      <span className="cmp-field-l">{label}</span>
      <input className="cmp-input" value={f[key] || ''} placeholder={ph}
        onChange={e => onChange({ [key]: e.target.value })} />
    </label>
  );
  return (
    <div className="cmp-frame">
      <button className="cmp-frame-head" onClick={() => setOpen(o => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="cmp-frame-thesis">{f.thesis_or_question || 'Set the thesis or question…'}</span>
      </button>
      {open && (
        <div className="cmp-frame-body">
          {fld('thesis_or_question', 'Thesis / question', 'What is this document arguing or asking?')}
          {fld('reader', 'Implied reader', 'Who is this for?')}
          {fld('goal', 'Rhetorical goal', 'persuade · inform · narrate · …')}
          <label className="cmp-field">
            <span className="cmp-field-l">Genre</span>
            <select className="cmp-input" value={f.genre || 'plain-report'} onChange={e => onChange({ genre: e.target.value })}>
              {CMP_GENRES.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label className="cmp-field">
            <span className="cmp-field-l">Constraints</span>
            <input className="cmp-input" value={(f.constraints || []).join('; ')} placeholder="one; per; semicolon"
              onChange={e => onChange({ constraints: e.target.value.split(';').map(s => s.trim()).filter(Boolean) })} />
          </label>
          <div className="cmp-field">
            <span className="cmp-field-l">Source corpus</span>
            <div className="cmp-corpus">
              {allProse.length ? allProse.map(d => (
                <label key={d.id} className={'cmp-corpus-chip' + (corpus.includes(d.id) ? ' on' : '')}>
                  <input type="checkbox" checked={corpus.includes(d.id)} onChange={() => onCorpus(d.id)} />
                  {d.name}
                </label>
              )) : <span className="cmp-muted">no prose documents loaded — load one to ground against it</span>}
            </div>
          </div>
          <div className="cmp-field">
            <span className="cmp-field-l">Talker model</span>
            <span className="cmp-muted">{modelName || 'none loaded'} · phrases only; grounding is mechanical</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* One node in the plan tree. The colour band is the single scalar projection;
   the predicate that produced it shows on the band's hover. A hole is visibly
   distinct (a marked node with its owed-grain and no draft). */
function PlanNode({ node, depth, selectedId, onSelect, onJob, onMove, onCut, onGrain }) {
  const [editing, setEditing] = React.useState(false);
  const [job, setJob] = React.useState(node.job || '');
  React.useEffect(() => { setJob(node.job || ''); }, [node.job]);
  const route = node.route;
  const predicate = route ? (route.decision + ' — ' + route.predicate) : BAND_LABEL[node.band];
  return (
    <div className="cmp-node-wrap">
      <div className={'cmp-node band-' + node.band + (selectedId === node.id ? ' sel' : '')}
        style={{ marginLeft: depth * 14 }} onClick={() => onSelect(node.id)}>
        <span className="cmp-node-band" title={predicate} />
        <span className="cmp-node-main">
          {editing
            ? <input className="cmp-input cmp-job-input" autoFocus value={job}
                onChange={e => setJob(e.target.value)}
                onBlur={() => { setEditing(false); if (job !== node.job) onJob(node.id, job); }}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
            : <span className="cmp-job" onDoubleClick={() => setEditing(true)} title="double-click to rewrite the job">
                {node.job || <span className="cmp-muted">(empty job — double-click to write it)</span>}
              </span>}
          <span className="cmp-node-meta">
            <span className={'cmp-state cmp-state-' + node.state}>{node.hole ? 'hole' : node.state}</span>
            {node.hole && <span className="cmp-grain" title="the kind of evidence this hole awaits">⟨{node.hole.owed_grain}⟩</span>}
            <ConfSpark confidence={node.confidence} />
          </span>
        </span>
        <span className="cmp-node-tools" onClick={e => e.stopPropagation()}>
          <button className="cmp-mini" title="move up" onClick={() => onMove(node.id, -1)}><Icon name="chevron-up" size={12} /></button>
          <button className="cmp-mini" title="move down" onClick={() => onMove(node.id, 1)}><Icon name="chevron-down" size={12} /></button>
          <select className="cmp-mini-sel" title="owe a grain (make this a hole)" value={node.hole ? node.hole.owed_grain : ''}
            onChange={e => onGrain(node.id, e.target.value)}>
            <option value="">grain…</option>
            {CMP_GRAINS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <button className="cmp-mini danger" title="cut this unit" onClick={() => onCut(node.id)}><Icon name="x" size={12} /></button>
        </span>
      </div>
      {(node.children || []).map(ch => (
        <PlanNode key={ch.id} node={ch} depth={depth + 1} selectedId={selectedId}
          onSelect={onSelect} onJob={onJob} onMove={onMove} onCut={onCut} onGrain={onGrain} />
      ))}
    </div>
  );
}

/* The prose of one draft, rendered continuously and shaded by WHO wrote it.
   Consecutive sentences by the same author are grouped into a run, and each run
   carries an inline chip ([you] / talker) so authorship is legible right in the
   flow — derived from per-sentence provenance, the words themselves verbatim. */
function ProvenanceProse({ draft }) {
  const sents = window.EOComposition.splitSentences(draft.prose || '');
  const prov = (draft.provenance && draft.provenance.length === sents.length) ? draft.provenance : null;
  if (!sents.length) return draft.prose || '';
  const runs = [];
  sents.forEach((s, k) => {
    const a = prov ? prov[k].author : (draft.author || 'talker');
    const last = runs[runs.length - 1];
    if (last && last.author === a) last.text += ' ' + s; else runs.push({ author: a, text: s });
  });
  return runs.map((r, i) => (
    <span key={i} className={'cmp-run cmp-by-' + r.author}>{r.text}<sup
      className={'cmp-chip cmp-by-' + r.author}
      title={r.author === 'user' ? 'you wrote this' : 'the talker wrote this'}>{r.author === 'user' ? 'you' : 'talker'}</sup>{' '}</span>
  ));
}

/* A unit as a paragraph of the document canvas: provenance-shaded prose,
   directly editable (double-click). Unselected it reads as clean prose — the
   canvas feel; selected, it reveals the full audit (the Confidence vector, the
   tag, the spans it drew from, the monitor's route, and who last wrote it). A
   unit in flight streams; an owed unit shows its job as a bracketed placeholder. */
function UnitCard({ node, selected, onSelect, onProse, streaming, onCite }) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState((node.draft && node.draft.prose) || '');
  React.useEffect(() => { if (!editing) setText((node.draft && node.draft.prose) || ''); }, [node.draft, editing]);
  // on entering edit, focus the field and drop the cursor at the end — a
  // ref+effect, not autoFocus, so it behaves in jsdom and the browser alike
  const taRef = React.useRef(null);
  React.useEffect(() => {
    if (editing && taRef.current) { try { const el = taRef.current; el.focus(); el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} }
  }, [editing]);
  const flight = streaming && streaming.unitId === node.id;
  return (
    <div className={'cmp-card band-' + node.band + (selected ? ' sel' : '')} id={'cmp-card-' + node.id} onClick={() => onSelect(node.id)}>
      <div className="cmp-card-job"><span className="cmp-card-dot" /> {node.job || '(no job)'}{node.draft && <span className={'cmp-byline cmp-by-' + (node.draft.author || 'talker')}>{node.draft.author === 'user' ? 'edited by you' : 'talker'}</span>}</div>
      {flight ? (
        <div className="cmp-prose streaming">{streaming.text || '…'}<span className="cmp-caret" /></div>
      ) : node.draft ? (
        editing
          ? <textarea className="cmp-prose-edit" ref={taRef} value={text} onChange={e => setText(e.target.value)}
              onClick={e => e.stopPropagation()}
              onBlur={() => { setEditing(false); if (text !== node.draft.prose) onProse(node.id, text); }} />
          : <div className="cmp-prose" onClick={e => { e.stopPropagation(); onSelect(node.id); setEditing(true); }} title="click to edit — your changes are attributed to you"><ProvenanceProse draft={node.draft} /></div>
      ) : node.hole ? (
        <div className="cmp-owe">This unit is a <b>hole</b> — it owes a <b>{node.hole.owed_grain}</b>. {grainOwe(node.hole.owed_grain)}</div>
      ) : (
        <div className="cmp-owe">Owed — not drafted yet. <span className="cmp-muted">{node.job}</span></div>
      )}
      {node.draft && !flight && selected && (
        <React.Fragment>
          <ConfBars confidence={node.confidence} tag={node.stamp && node.stamp.tag} rescued={node.stamp && node.stamp.rescued} />
          {node.draft.source_events && node.draft.source_events.length > 0 && (
            <div className="cmp-sources">
              <span className="cmp-sources-l">drew from</span>
              {node.draft.source_events.slice(0, 8).map((s, i) => (
                <button key={i} className="cmp-src" title={'source span'} onClick={e => { e.stopPropagation(); onCite && onCite(s.docId, s.idx); }}>s{s.idx}</button>
              ))}
            </div>
          )}
          {node.route && <div className="cmp-route">monitor: <b>{node.route.decision}</b> · <code>{node.route.predicate}</code></div>}
        </React.Fragment>
      )}
    </div>
  );
}
function grainOwe(g) {
  return g === 'Figure' ? 'It expects a citation.' : g === 'Ground' ? 'It expects a context.' : 'It expects corroborating instances.';
}

/* The action surface — contextual to what is selected. Every action is an event,
   so every action is undoable. */
function ActionSurface({ folded, selectedId, busy, modelReady, onAct, progress }) {
  const u = selectedId ? folded.unitsById[selectedId] : null;
  const Btn = ({ act, label, primary, disabled, title }) => (
    <button className={'cmp-act' + (primary ? ' primary' : '')} disabled={busy || disabled} title={title}
      onClick={() => onAct(act)}>{label}</button>
  );
  const hasUnits = folded.counts.units > 0;
  const status = !busy ? null
    : progress && progress.phase === 'outline' ? 'Outlining…'
    : progress && progress.phase === 'draft' ? 'Drafting ' + progress.i + '/' + progress.n + (progress.job ? ' — ' + (progress.job.length > 36 ? progress.job.slice(0, 36) + '…' : progress.job) : '')
    : 'working…';
  return (
    <div className="cmp-actions">
      <div className="cmp-actions-grp">
        <span className="cmp-actions-l">Doc</span>
        <Btn act="write" label={hasUnits ? '✍ Write the rest' : '✍ Write it'} primary disabled={!modelReady}
          title={modelReady ? 'outline if needed, then draft every unit — watch it write' : 'load a model first'} />
        <Btn act="planFromFrame" label="Outline only" disabled={!modelReady} title={modelReady ? 'propose a tree of units from the frame, without drafting' : 'load a model first'} />
        <Btn act="addUnit" label="+ Unit" />
        <Btn act="restampAll" label="Restamp all" />
        <Btn act="undo" label="Undo" title="undo the last action (supersession by REC)" />
      </div>
      {u && (
        <div className="cmp-actions-grp">
          <span className="cmp-actions-l">{u.state === 'owed' ? 'Owed unit' : 'Unit'}</span>
          {!u.draft && <Btn act="draft" label="Draft" primary disabled={!modelReady} title={modelReady ? 'retrieve, phrase, stamp, route' : 'load a model first'} />}
          {u.draft && <Btn act="revise" label="Revise" disabled={!modelReady} />}
          {u.draft && <Btn act="restamp" label="Restamp" />}
          {u.draft && <Btn act="hold" label={u.state === 'held' ? 'Release' : 'Hold'} />}
          {u.draft && <Btn act="contest" label={u.contested ? 'Un-contest' : 'Mark contested'} />}
        </div>
      )}
      {busy && <span className="cmp-busy"><span className="cmp-orb" /> {status}</span>}
    </div>
  );
}

/* ---- the orchestrator ---------------------------------------------------- */
function CompositionView({ doc, onAppend, model, modelReady, allDocs, onCite }) {
  const events = doc._events || [];
  const folded = React.useMemo(() => window.EOComposition.fold(events), [events]);
  const frame = folded.frame || {};
  const [selectedId, setSelectedId] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [streaming, setStreaming] = React.useState(null);
  const [planning, setPlanning] = React.useState(null);   // partial outline text while it forms
  const [progress, setProgress] = React.useState(null);   // { phase:'outline'|'draft', i, n, job } during autopilot
  const [corpus, setCorpus] = React.useState(null);     // null = "all prose"; else an id list
  const formLibRef = React.useRef(null);

  // Re-seat the id counter past a restored log so a fresh event never collides
  // with one the log already holds.
  React.useEffect(() => { try { window.EOComposition.reseat(events); } catch (e) {} }, [doc.id]);
  // Warm the form library (twin of the shape library; empty until fetched, in
  // which case formDegree honestly returns null — the form component stays null).
  React.useEffect(() => {
    if (typeof window.EOFormLibrary === 'function')
      window.EOFormLibrary().then(l => { formLibRef.current = l; }).catch(() => {});
    if (window.EOEmbed && window.EOEmbed.warm) window.EOEmbed.warm();
  }, []);

  const allProse = (allDocs || []).filter(d => d.kind === 'prose');
  const corpusIds = corpus || allProse.map(d => d.id);
  const corpusDocs = allProse.filter(d => corpusIds.includes(d.id));

  // --- the injected deps the pure module expects -------------------------
  const C = window.EOComposition;
  const retrieve = React.useCallback(async (job) => {
    if (!window.EOEngine || !window.EOEngine.retrieveScope || !corpusDocs.length) return [];
    let hits = [];
    try { hits = window.EOEngine.retrieveScope(corpusDocs, job, 8) || []; } catch (e) { hits = []; }
    return hits.map(h => ({ text: h.t, score: h.score, docId: h.docId, idx: h.i }));
  }, [corpusDocs.map(d => d.id).join(',')]);
  const phrase = React.useCallback(async ({ system, user, max_tokens }, onToken) => {
    if (!window.EOLLM || !model || !window.EOLLM.isLoaded(model.mlc)) return '';
    try {
      return await window.EOLLM.phrase({
        mlcKey: model.mlc, question: user, sysOverride: system, history: [],
        mode: 'grounded', grounded: false, maxTokens: max_tokens || 320,
        onToken: onToken || undefined,
      });
    } catch (e) { return ''; }
  }, [model && model.mlc]);
  const embed = React.useCallback(async (t) => {
    if (!window.EOEmbed || !window.EOEmbed.embedQuery) return null;
    try { return await window.EOEmbed.embedQuery(t); } catch (e) { return null; }
  }, []);
  // The mechanical re-citation grounder — engine.groundTalkerOutput over the
  // active corpus. For a draft the token-overlap witness reads as confabulation,
  // this re-binds each sentence to a real source line (per-sentence retrieval
  // over the whole source) and returns the best-covered doc's binding, so
  // generateUnit / stampProse can credit an honest paraphrase the lexical
  // witness can't see. Pure mechanical retrieval — no model, no embedder.
  const ground = React.useCallback(async (prose) => {
    if (!window.EOEngine || !window.EOEngine.groundTalkerOutput || !corpusDocs.length || !prose) return null;
    let best = null;
    for (const d of corpusDocs) {
      if (!d.sentenceTexts || !d.sentenceTexts.length) continue;
      let g; try { g = window.EOEngine.groundTalkerOutput(d, prose, []); } catch (e) { continue; }
      const m = /^(\d+)\/(\d+)/.exec((g && g.audit && g.audit.covers) || '');
      const total = m ? +m[2] : 0, bound = m ? +m[1] : 0;
      const degree = total ? bound / total : 0;
      if (!best || degree > best.degree)
        best = { degree, grounded: !!(g.audit && g.audit.grounded), cites: g.cites || [] };
    }
    return best;
  }, [corpusDocs.map(d => d.id).join(',')]);

  // --- appending: every action stamps a shared batch id so undo reverts the
  //     whole action (a draft + its stamp + its route) in one move ----------
  const appendBatch = React.useCallback((evts) => {
    if (!evts || !evts.length) return;
    const batch = C.newId('batch');
    for (const e of evts) e.batch = batch;
    onAppend(doc.id, evts);
  }, [doc.id, onAppend]);

  // flatten the tree in reading order, for neighbor seams and navigation
  const flat = React.useMemo(() => {
    const out = []; const walk = ns => { for (const n of ns) { out.push(n); walk(n.children || []); } }; walk(folded.tree); return out;
  }, [folded]);
  const auth = React.useMemo(() => C.authorship(folded), [folded]);
  const neighborsOf = (unitId) => {
    const i = flat.findIndex(n => n.id === unitId);
    const out = [];
    if (i > 0 && flat[i - 1].draft) out.push({ job: flat[i - 1].job, prose: flat[i - 1].draft.prose });
    if (i >= 0 && i + 1 < flat.length && flat[i + 1].draft) out.push({ job: flat[i + 1].job, prose: flat[i + 1].draft.prose });
    return out;
  };

  // --- frame / plan edits ------------------------------------------------
  const setFrame = (patch) => {
    const next = C.make.frame(Object.assign({
      doc_id: doc.id,
      thesis_or_question: frame.thesis_or_question || '', reader: frame.reader || '',
      goal: frame.goal || '', constraints: frame.constraints || [], genre: frame.genre || 'plain-report',
    }, patch));
    appendBatch([next]);
  };
  const nextOrder = () => (folded.units.reduce((m, u) => Math.max(m, u.order || 0), 0) + 1);
  const addUnit = (job) => {
    const u = C.make.unit({ doc_id: doc.id, job: job || '', order: nextOrder() });
    appendBatch([u]);
    setSelectedId(u.id);
  };
  const editJob = (id, job) => appendBatch([C.make.unit({ doc_id: doc.id, id, job })]);
  const moveUnit = (id, dir) => {
    // swap order with the sibling in the given direction (within the same parent)
    const u = folded.unitsById[id]; if (!u) return;
    const sibs = folded.units.filter(x => (x.parent_id || null) === (u.parent_id || null)).sort((a, b) => a.order - b.order);
    const i = sibs.findIndex(x => x.id === id); const j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    const a = sibs[i], b = sibs[j];
    appendBatch([
      C.make.unit({ doc_id: doc.id, id: a.id, order: b.order }),
      C.make.unit({ doc_id: doc.id, id: b.id, order: a.order }),
    ]);
  };
  const cutUnit = (id) => {
    appendBatch([C.make.edit({ doc_id: doc.id, edit_kind: 'cut', affected_unit_ids: [id], reason: 'cut by hand' })]);
    if (selectedId === id) setSelectedId(null);
  };
  const setGrain = (id, grain) => {
    if (!grain) return;
    appendBatch([
      C.make.unit({ doc_id: doc.id, id, owed_grain: grain }),
      C.make.hole({ doc_id: doc.id, unit_id: id, owed_grain: grain }),
    ]);
  };
  const holdUnit = (id) => {
    const u = folded.unitsById[id];
    appendBatch([C.make.hold({ doc_id: doc.id, unit_id: id, held: u.state !== 'held' })]);
  };
  const contestUnit = (id) => {
    const u = folded.unitsById[id];
    appendBatch([C.make.unit({ doc_id: doc.id, id, contested: !u.contested })]);
  };

  // --- the loop: draft / revise / restamp --------------------------------
  // draft ONE unit (object, not id — so the autopilot can draft a unit the fold
  // hasn't re-derived yet). Streams tokens into the unit live; emits the draft +
  // stamp + route as one batch. The caller owns `busy`.
  const draftOne = async (unit, opts) => {
    const o = opts || {};
    setSelectedId(unit.id); setStreaming({ unitId: unit.id, text: '' });
    try {
      const streamPhrase = (p) => phrase(p, (delta) => setStreaming(s => s && s.unitId === unit.id ? { unitId: unit.id, text: (s.text || '') + delta } : s));
      const out = await C.generateUnit({
        unit, frame, doc_id: doc.id,
        retrieve, phrase: streamPhrase, embed, ground, formLib: formLibRef.current,
        neighbors: o.neighbors || [],
      });
      if (out && out.draft) appendBatch([out.draft, out.stamp, out.route]);
      return out;
    } finally { setStreaming(null); }
  };
  const draftUnit = async (id) => {
    const u = folded.unitsById[id]; if (!u || busy) return;
    setBusy(true);
    try { await draftOne(u, { neighbors: neighborsOf(id) }); }
    catch (e) { if (window.eoWarn) window.eoWarn('draftUnit', e); }
    finally { setBusy(false); }
  };
  // AUTOPILOT — one move that writes the whole document, visibly: outline first
  // (streamed, so you watch it form), then draft every undrafted unit in order,
  // each streaming its tokens, with live progress. This is "start writing."
  const write = async () => {
    if (busy || !modelReady) return;
    setBusy(true);
    try {
      let units = folded.units.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!units.length) { setProgress({ phase: 'outline' }); units = await planFromFrame({ keepBusy: true }); }
      const drafted = folded.unitsById;
      const todo = units.filter(u => !(drafted[u.id] && drafted[u.id].draft));
      for (let i = 0; i < todo.length; i++) {
        setProgress({ phase: 'draft', i: i + 1, n: todo.length, job: todo[i].job });
        await draftOne(todo[i], {});
      }
    } catch (e) { if (window.eoWarn) window.eoWarn('write', e); }
    finally { setBusy(false); setProgress(null); }
  };
  // stamp a GIVEN prose for a unit: retrieve fresh material against the job,
  // measure the grain-relative witness on THAT prose, decide a route. Returns
  // [stamp, route]. Stamping the prose passed in (not the fold's) keeps it
  // correct for a just-edited draft the fold hasn't re-derived yet.
  const stampProse = async (unit, prose, draftId) => {
    const spans = await retrieve(unit.job);
    const grain = (unit.hole && unit.hole.owed_grain) || unit.owed_grain || 'Figure';
    let draftVec = null; try { draftVec = await embed(prose); } catch (e) {}
    const spanTexts = spans.map(s => s.text);
    // Same mechanical re-citation rescue as the draft path: only when the lexical
    // witness reads low do we re-bind sentences to real source lines, so a
    // re-stamped paraphrase isn't condemned as confabulation.
    let grounded = null;
    if (prose) {
      const wLex = C.witnessGrain({ prose, spans: spanTexts, grain });
      if (wLex.degree == null || wLex.degree < C.FLOOR.witness) { try { grounded = await ground(prose); } catch (e) {} }
    }
    const st = C.stampDraft({
      prose, spans: spanTexts, grain,
      draftVec, genre: frame.genre, formLib: formLibRef.current,
      retrieval: C.retrievalDegree(spans), grounded,
    });
    const r = C.decide(st.confidence, {});
    return [
      C.make.stamp({ doc_id: doc.id, unit_id: unit.id, draft_id: draftId, confidence: st.confidence, tag: st.tag, rescued: st.rescued }),
      C.make.route({ doc_id: doc.id, unit_id: unit.id, decision: r.decision, predicate: r.predicate, triggered_by: r.triggered_by }),
    ];
  };
  // re-stamp the LIVE prose without re-phrasing — the "reread": Stamps update,
  // the Draft does not. A drifted unit (the frame moved, upstream changed) can
  // flip from advance to revise here.
  const restampUnit = async (id, opts) => {
    const u = folded.unitsById[id]; if (!u || !u.draft) return;
    const o = opts || {};
    if (!o.silent) setBusy(true);
    try { appendBatch(await stampProse(u, u.draft.prose, u.draft.id)); }
    catch (e) { if (window.eoWarn) window.eoWarn('restampUnit', e); }
    finally { if (!o.silent) setBusy(false); }
  };
  // a direct prose edit is a new Draft + a fresh Stamp of THAT prose, one
  // undoable batch (no stale re-fold in between). The diff attributes the
  // sentences the user actually changed to 'user' and carries the rest — the
  // provenance tracks the CHANGES, sentence by sentence, never per keystroke.
  const editProse = async (id, prose) => {
    const u = folded.unitsById[id]; if (!u) return;
    setBusy(true);
    try {
      const prevProse = (u.draft && u.draft.prose) || '';
      const prevProv = (u.draft && u.draft.provenance) || null;
      const provenance = C.diffProvenance(prevProse, prevProv, prose, 'user');
      const draft = C.make.draft({ doc_id: doc.id, unit_id: id, prose, author: 'user', provenance, revisable: true, source_events: (u.draft && u.draft.source_events) || [] });
      const sr = await stampProse(u, prose, draft.id);
      appendBatch([draft, ...sr]);
    } catch (e) { if (window.eoWarn) window.eoWarn('editProse', e); }
    finally { setBusy(false); }
  };
  const restampAll = async () => {
    setBusy(true);
    try { for (const n of flat) if (n.draft) await restampUnit(n.id, { silent: true }); }
    finally { setBusy(false); }
  };
  // Outline the document from the frame — STREAMED into the plan pane so the
  // user watches the sections arrive, not a dead "working…". Returns the units
  // it created so the autopilot can draft them without waiting for a re-fold.
  const planFromFrame = async (opts) => {
    const o = opts || {};
    if (!o.keepBusy) { if (busy || !modelReady) return []; setBusy(true); }
    setPlanning('');
    try {
      const system = 'You are planning the STRUCTURE of a document, not writing it. Propose between four and seven sections. Each section is ONE line: a short job describing what that section must DO (its direction), never its content. No numbering, no prose, no blank lines — one job per line.';
      const u = [];
      if (frame.thesis_or_question) u.push('Document: ' + frame.thesis_or_question);
      if (frame.reader) u.push('For: ' + frame.reader);
      if (frame.goal) u.push('Goal: ' + frame.goal);
      if ((frame.constraints || []).length) u.push('Constraints: ' + frame.constraints.join('; '));
      u.push('Genre: ' + (frame.genre || 'plain-report'));
      u.push('');
      u.push('Propose the sections, one job per line:');
      const text = await phrase({ system, user: u.join('\n'), max_tokens: 260 }, (delta) => setPlanning(t => (t || '') + delta));
      // Parse mechanically: drop a model lead-in ("Here are the sections:") and
      // strip list markers (1. / I. / (a) / •) so a preamble never drafts as a
      // unit and "I. Introduction" becomes the job "Introduction".
      const jobs = C.parseOutline(text, 8);
      let created = [];
      if (jobs.length) {
        let order = nextOrder();
        created = jobs.map(j => C.make.unit({ doc_id: doc.id, job: j, order: order++ }));
        const evts = created.slice();
        // record WHY the plan arrived, in the log (a plan hypothesis)
        evts.push(C.make.planEdit({ doc_id: doc.id, edit_kind: 'add-unit', affected_unit_ids: created.map(e => e.id), reason: 'planned from the frame', confidence: C.confidence({ frame: 0.5 }) }));
        appendBatch(evts);
      }
      return created;
    } catch (e) { if (window.eoWarn) window.eoWarn('planFromFrame', e); return []; }
    finally { setPlanning(null); if (!o.keepBusy) setBusy(false); }
  };

  // undo: supersede every live event of the most recent batch (REC supersession).
  // _live preserves append order, so the last batched event is the most recent
  // action; we drop its whole batch (a draft + its stamp + its route) at once.
  const undo = () => {
    const live = folded._live.filter(e => e.batch && e.kind !== 'doc');
    if (!live.length) return;
    const batch = live[live.length - 1].batch;
    const targets = live.filter(e => e.batch === batch).map(e => e.id);
    onAppend(doc.id, targets.map(t => C.make.supersede(t, 'undo')));
  };

  const onAct = (act) => {
    if (act === 'write') return write();
    if (act === 'planFromFrame') return planFromFrame();
    if (act === 'addUnit') return addUnit('');
    if (act === 'restampAll') return restampAll();
    if (act === 'undo') return undo();
    if (!selectedId) return;
    if (act === 'draft') return draftUnit(selectedId);
    if (act === 'revise') return draftUnit(selectedId);
    if (act === 'restamp') return restampUnit(selectedId);
    if (act === 'hold') return holdUnit(selectedId);
    if (act === 'contest') return contestUnit(selectedId);
  };

  const modelName = model ? model.name : null;
  return (
    <div className="cmp-root">
      <div className="cmp-split">
        <div className="cmp-plan">
          <div className="cmp-pane-h">Plan <span className="cmp-counts">{folded.counts.units} units · {folded.counts.owed} owed · {folded.counts.held} held</span></div>
          <FrameEditor frame={frame} onChange={setFrame}
            corpus={corpusIds} allProse={allProse} onCorpus={(id) => setCorpus(prev => {
              const base = prev || allProse.map(d => d.id);
              return base.includes(id) ? base.filter(x => x !== id) : [...base, id];
            })} modelName={modelName} />
          <div className="cmp-tree">
            {planning != null ? (
              <div className="cmp-outlining">
                <div className="cmp-outlining-h"><span className="cmp-orb" /> Outlining…</div>
                <pre className="cmp-outlining-body">{planning || '…'}</pre>
              </div>
            ) : folded.tree.length ? folded.tree.map(n => (
              <PlanNode key={n.id} node={n} depth={0} selectedId={selectedId} onSelect={setSelectedId}
                onJob={editJob} onMove={moveUnit} onCut={cutUnit} onGrain={setGrain} />
            )) : <div className="cmp-empty">No plan yet. Set a thesis above, then press <b>✍ Write it</b> — it outlines, then drafts every unit, live. (Or <b>Outline only</b>, or add a unit by hand.)</div>}
          </div>
          {folded.planEdits.length > 0 && (
            <div className="cmp-planlog">
              <div className="cmp-planlog-h">Why the plan moved</div>
              {folded.planEdits.slice(0, 6).map(e => (
                <div key={e.id} className="cmp-planlog-row"><b>{e.edit_kind}</b> · {e.reason}</div>
              ))}
            </div>
          )}
        </div>
        <div className="cmp-draftpane">
          <div className="cmp-pane-h">Document
            <span className="cmp-counts">{folded.counts.drafted} drafted · {folded.counts.holes} holes{auth.total ? ' · ' + auth.user + '/' + auth.total + ' sentences yours' : ''}</span>
            <span className="cmp-legend" title="every sentence is shaded by who wrote it">
              <span className="cmp-leg cmp-by-talker">talker</span><span className="cmp-leg cmp-by-user">you</span>
            </span>
          </div>
          <div className="cmp-draft-scroll cmp-doc">
            {flat.length ? flat.map(n => (
              <UnitCard key={n.id} node={n} selected={selectedId === n.id} onSelect={setSelectedId}
                onProse={editProse} streaming={streaming} onCite={onCite} />
            )) : <div className="cmp-empty">Press <b>✍ Write it</b> and watch it draft, unit by unit — each claim bound to evidence, each unit stamped with its full confidence vector.</div>}
          </div>
        </div>
      </div>
      <ActionSurface folded={folded} selectedId={selectedId} busy={busy} modelReady={modelReady} onAct={onAct} progress={progress} />
    </div>
  );
}

Object.assign(window, { CompositionView, ConfBars, PlanNode, UnitCard });
