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

// The tessellation bounds. The document grows toward target_words by deepening
// sections into subsections; these keep "any length" from running away.
const CMP_WORDS_PER_UNIT = 150;   // a single drafted unit's rough contribution
const CMP_MAX_UNITS = 48;         // hard ceiling on total units
const CMP_MAX_DEPTH = 4;          // spirals within spirals, bounded

// Parse an outline reply into jobs — one per line, list markers stripped, blanks
// and stray labels dropped, capped so a runaway reply can't explode the tree.
function cmpParseJobs(text, cap) {
  return String(text || '').split(/\n+/)
    .map(s => s.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter(s => s.length > 2)
    .slice(0, cap || 8);
}

// Phrase one unit's job as a request the grounded/creative talker answers — the
// frame for orientation, the neighbour seam for continuity, never the spans
// (those ride in as evidence). Mirrors the closing of composition.js's
// buildTalkerPrompt, minus the inline material.
function cmpQuestion(spec) {
  const s = spec || {};
  const f = s.frame || {};
  const bits = [];
  if (f.thesis_or_question) bits.push('This is one passage of a document about: ' + f.thesis_or_question + '.');
  if (f.reader) bits.push('It is written for: ' + f.reader + '.');
  const seam = (s.neighbors || []).map(n => n && n.prose).filter(Boolean).map(p => '…' + String(p).slice(-200)).join(' ');
  if (seam) bits.push('For a smooth seam it sits beside: ' + seam);
  bits.push('Write this passage as flowing prose, no heading: ' + (s.job || ''));
  return bits.join(' ');
}

/* A single Confidence vector, as a row of labelled bars. A component that was
   not measured is shown as `null` — never a zero-height bar, which would read as
   "measured, and zero". The one place a scalar appears is the colour band; the
   predicate that produced it travels on the route (shown on hover). */
function ConfBars({ confidence, tag }) {
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
      {tag && <div className={'cmp-tag cmp-tag-' + tag}>{tag}</div>}
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
          {/* The two outset dials: how long, and how grounded. Set them, press Go. */}
          <div className="cmp-dials">
            <label className="cmp-dial">
              <span className="cmp-field-l">Length</span>
              <span className="cmp-dial-len">
                <input className="cmp-input cmp-len-input" type="number" min="100" step="100"
                  value={f.target_words != null ? f.target_words : 800}
                  onChange={e => onChange({ target_words: Math.max(0, parseInt(e.target.value, 10) || 0) })} />
                <span className="cmp-muted">≈ words</span>
              </span>
            </label>
            <div className="cmp-dial">
              <span className="cmp-field-l">Mode</span>
              <span className="cmp-seg" role="group" aria-label="grounded or creative">
                <button type="button" className={'cmp-seg-btn' + ((f.mode || 'grounded') !== 'creative' ? ' on' : '')}
                  title="cite the sources, the same way a chat answer is grounded" onClick={() => onChange({ mode: 'grounded' })}>Grounded</button>
                <button type="button" className={'cmp-seg-btn' + ((f.mode || 'grounded') === 'creative' ? ' on' : '')}
                  title="compose freely, using the sources as raw material" onClick={() => onChange({ mode: 'creative' })}>Creative</button>
              </span>
            </div>
          </div>
          {fld('thesis_or_question', 'Thesis / question', 'What is this document arguing or asking? (or just press Go)')}
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
   the predicate that produced it shows on the band's hover. Children nest under
   their parent — a section's subsections, to whatever depth the document needs. */
function PlanNode({ node, depth, selectedId, onSelect, onJob, onMove, onCut }) {
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
            <span className={'cmp-state cmp-state-' + node.state}>{node.state}</span>
            <ConfSpark confidence={node.confidence} />
          </span>
        </span>
        <span className="cmp-node-tools" onClick={e => e.stopPropagation()}>
          <button className="cmp-mini" title="move up" onClick={() => onMove(node.id, -1)}><Icon name="chevron-up" size={12} /></button>
          <button className="cmp-mini" title="move down" onClick={() => onMove(node.id, 1)}><Icon name="chevron-down" size={12} /></button>
          <button className="cmp-mini danger" title="cut this unit" onClick={() => onCut(node.id)}><Icon name="x" size={12} /></button>
        </span>
      </div>
      {(node.children || []).map(ch => (
        <PlanNode key={ch.id} node={ch} depth={depth + 1} selectedId={selectedId}
          onSelect={onSelect} onJob={onJob} onMove={onMove} onCut={onCut} />
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
      ) : (
        <div className="cmp-owe">Owed — not drafted yet. <span className="cmp-muted">{node.job}</span></div>
      )}
      {node.draft && !flight && selected && (
        <React.Fragment>
          <ConfBars confidence={node.confidence} tag={node.stamp && node.stamp.tag} />
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
    : progress && progress.phase === 'frame' ? 'Reading the sources…'
    : progress && progress.phase === 'outline' ? 'Outlining…'
    : progress && progress.phase === 'deepen' ? 'Deepening a section…'
    : progress && progress.phase === 'draft' ? 'Drafting ' + progress.i + '/' + progress.n + (progress.job ? ' — ' + (progress.job.length > 36 ? progress.job.slice(0, 36) + '…' : progress.job) : '')
    : 'working…';
  return (
    <div className="cmp-actions">
      <div className="cmp-actions-grp">
        <span className="cmp-actions-l">Doc</span>
        <Btn act="write" label={hasUnits ? '▶ Write the rest' : '▶ Go'} primary disabled={!modelReady}
          title={modelReady ? (hasUnits ? 'draft every remaining unit — watch it write' : 'one press: read the sources, frame the document, outline it, then draft every unit') : 'load a model first'} />
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
  // The injected talker. Three shapes share one entry point:
  //  • a GROUNDED draft (spec.grounded && spec.spans) goes through the SAME path a
  //    chat answer takes — the canonical grounded system prompt, the spans handed
  //    in as witnessed evidence, the grounded params (temp 0.12) — so a section is
  //    grounded exactly the way a chat reply is. The job + frame become the
  //    "question"; the spans carry their own [sN]/docId so cites resolve.
  //  • a CREATIVE draft (spec.grounded === false) composes freely over the spans
  //    as raw material (creative prompt, warmer temp).
  //  • a planning / framing call (just {system,user}) keeps the original behaviour.
  const phrase = React.useCallback(async (spec, onToken) => {
    if (!window.EOLLM || !model || !window.EOLLM.isLoaded(model.mlc)) return '';
    const { system, user, max_tokens } = spec || {};
    try {
      if (spec && spec.grounded && Array.isArray(spec.spans) && spec.spans.length) {
        const spans = spec.spans.map((s, i) => ({ tag: 's' + (i + 1), text: s.text, idx: s.idx, docId: s.docId }));
        return await window.EOLLM.phrase({
          mlcKey: model.mlc, question: cmpQuestion(spec), spans, history: [],
          mode: 'grounded', task: 'answer', grounded: true, provenanceKeys: true,
          docTitle: (spec.frame && spec.frame.thesis_or_question) || undefined,
          maxTokens: max_tokens || 320, onToken: onToken || undefined,
        });
      }
      if (spec && spec.grounded === false) {
        const material = (spec.spans || []).map((s, i) => '[' + (i + 1) + '] ' + s.text).join('\n');
        return await window.EOLLM.phrase({
          mlcKey: model.mlc, question: cmpQuestion(spec), contextText: material || undefined,
          history: [], mode: 'creative', grounded: false,
          maxTokens: max_tokens || 320, onToken: onToken || undefined,
        });
      }
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
      target_words: frame.target_words != null ? frame.target_words : 800,
      mode: frame.mode === 'creative' ? 'creative' : 'grounded',
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
    const fr = o.frame || frame;
    const grounded = o.grounded != null ? o.grounded : (fr.mode !== 'creative');
    setSelectedId(unit.id); setStreaming({ unitId: unit.id, text: '' });
    try {
      const streamPhrase = (p) => phrase(p, (delta) => setStreaming(s => s && s.unitId === unit.id ? { unitId: unit.id, text: (s.text || '') + delta } : s));
      const out = await C.generateUnit({
        unit, frame: fr, doc_id: doc.id, grounded,
        retrieve, phrase: streamPhrase, embed, formLib: formLibRef.current,
        neighbors: o.neighbors || [], maxTokens: o.maxTokens,
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
  // AUTOPILOT — the "Go" button: one move that writes the whole document,
  // visibly, from nothing, and keeps going until it reaches the length the dial
  // asks for. If the user never said what the document is, it READS the sources
  // and frames it first (so you don't have to prompt it). Then it outlines from
  // that frame — streamed, so you watch the sections arrive — drafts every unit
  // in order (grounded like a chat answer, or freely if the mode dial says
  // creative), and finally TESSELLATES: while still under the target word count
  // it deepens the most-developed section into subsections and drafts those —
  // spirals within spirals — bounded by depth and a hard unit ceiling so any
  // length still terminates. A running registry tracks every unit and its words
  // without waiting for a re-fold between appends.
  const write = async () => {
    if (busy || !modelReady) return;
    setBusy(true);
    try {
      let liveFrame = frame;
      if (!frame.thesis_or_question && corpusDocs.length) {
        setProgress({ phase: 'frame' });
        const derived = await deriveFrameFromCorpus();
        if (derived) liveFrame = derived;
      }
      const grounded = liveFrame.mode !== 'creative';
      const target = Math.max(0, (liveFrame.target_words | 0) || 0);

      const reg = new Map();
      for (const u of folded.units) reg.set(u.id, { unit: u, prose: (u.draft && u.draft.prose) || '', drafted: !!u.draft });
      const words = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
      const total = () => { let n = 0; for (const r of reg.values()) n += words(r.prose); return n; };
      const note = (u, prose) => { const r = reg.get(u.id) || { unit: u }; r.unit = u; r.prose = prose || ''; r.drafted = true; reg.set(u.id, r); };
      // a thin neighbour seam from the registry — the previous drafted sibling
      const regNeighbors = (u) => {
        const sibs = [...reg.values()].map(r => r.unit).filter(x => (x.parent_id || null) === (u.parent_id || null)).sort((a, b) => (a.order || 0) - (b.order || 0));
        const i = sibs.findIndex(x => x.id === u.id);
        if (i > 0) { const p = reg.get(sibs[i - 1].id); if (p && p.prose) return [{ job: sibs[i - 1].job, prose: p.prose }]; }
        return [];
      };

      // (1) top-level outline if there is none yet
      let units = [...reg.values()].map(r => r.unit);
      if (!units.length) {
        setProgress({ phase: 'outline' });
        const created = await planFromFrame({ keepBusy: true, frame: liveFrame });
        for (const u of created) reg.set(u.id, { unit: u, prose: '', drafted: false });
        units = created;
      }

      // per-unit word budget from the target so each section is ~the right size
      const seeds = units.length || 1;
      const planned = target ? Math.max(seeds, Math.ceil(target / CMP_WORDS_PER_UNIT)) : seeds;
      const perUnitWords = target ? Math.max(60, Math.round(target / planned)) : 0;
      const maxTokens = perUnitWords ? Math.min(700, Math.round(perUnitWords * 1.7)) : undefined;

      // (2) draft every undrafted unit we have, in reading order
      const pend = [...reg.values()].filter(r => !r.drafted).map(r => r.unit).sort((a, b) => (a.order || 0) - (b.order || 0));
      for (let i = 0; i < pend.length; i++) {
        setProgress({ phase: 'draft', i: i + 1, n: pend.length, job: pend[i].job });
        const out = await draftOne(pend[i], { frame: liveFrame, grounded, maxTokens, neighbors: regNeighbors(pend[i]) });
        note(pend[i], out && out.prose);
      }

      // (3) tessellate toward the target length
      const hasKids = (id) => [...reg.values()].some(r => (r.unit.parent_id || null) === id);
      const depthOf = (u) => { let d = 0, x = u, g = 0; while (x && x.parent_id && reg.has(x.parent_id) && g++ < 12) { d++; x = reg.get(x.parent_id).unit; } return d; };
      const noExpand = new Set();
      let guard = 0;
      while (target && total() < target && reg.size < CMP_MAX_UNITS && guard++ < CMP_MAX_UNITS) {
        const leaves = [...reg.values()]
          .filter(r => r.drafted && !noExpand.has(r.unit.id) && !hasKids(r.unit.id) && depthOf(r.unit) < CMP_MAX_DEPTH && words(r.prose) >= 40)
          .sort((a, b) => words(b.prose) - words(a.prose));
        if (!leaves.length) break;
        const parent = leaves[0].unit;
        setProgress({ phase: 'deepen', job: parent.job });
        const kids = await planFromUnit(parent, leaves[0].prose, liveFrame);
        if (!kids.length) { noExpand.add(parent.id); continue; }
        for (const k of kids) reg.set(k.id, { unit: k, prose: '', drafted: false });
        for (let i = 0; i < kids.length && total() < target && reg.size <= CMP_MAX_UNITS; i++) {
          setProgress({ phase: 'draft', i: i + 1, n: kids.length, job: kids[i].job });
          const out = await draftOne(kids[i], { frame: liveFrame, grounded, maxTokens, neighbors: regNeighbors(kids[i]) });
          note(kids[i], out && out.prose);
        }
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
    const st = C.stampDraft({
      prose, spans: spans.map(s => s.text), grain,
      draftVec, genre: frame.genre, formLib: formLibRef.current,
      retrieval: C.retrievalDegree(spans),
    });
    const r = C.decide(st.confidence, {});
    return [
      C.make.stamp({ doc_id: doc.id, unit_id: unit.id, draft_id: draftId, confidence: st.confidence, tag: st.tag }),
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
    const fr = o.frame || frame;
    if (!o.keepBusy) { if (busy || !modelReady) return []; setBusy(true); }
    setPlanning({ label: 'Outlining…', text: '' });
    try {
      const system = 'You are planning the STRUCTURE of a document, not writing it. Propose between four and seven sections. Each section is ONE line: a short job describing what that section must DO (its direction), never its content. No numbering, no prose, no blank lines — one job per line.';
      const u = [];
      if (fr.thesis_or_question) u.push('Document: ' + fr.thesis_or_question);
      if (fr.reader) u.push('For: ' + fr.reader);
      if (fr.goal) u.push('Goal: ' + fr.goal);
      if ((fr.constraints || []).length) u.push('Constraints: ' + fr.constraints.join('; '));
      u.push('Genre: ' + (fr.genre || 'plain-report'));
      u.push('');
      u.push('Propose the sections, one job per line:');
      const text = await phrase({ system, user: u.join('\n'), max_tokens: 260 }, (delta) => setPlanning(t => ({ label: 'Outlining…', text: ((t && t.text) || '') + delta })));
      const jobs = cmpParseJobs(text, 8);
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
  // Expand ONE section into subsections — the recursion that lets the document
  // tessellate to any length: a section's job + what it currently says go in, two
  // to four child jobs come out, parented under it. Streamed like the outline, and
  // appended with a plan-edit recording WHY the section deepened. Caller owns busy.
  const planFromUnit = async (parent, parentProse, fr0) => {
    const fr = fr0 || frame;
    const short = (parent.job || '').slice(0, 28) + ((parent.job || '').length > 28 ? '…' : '');
    const label = 'Deepening “' + short + '”…';
    setPlanning({ label, text: '' });
    try {
      const system = 'You are EXPANDING one section of a document into subsections — going deeper into it, not restating it. Propose between two and four subsections. Each is ONE line: a short job describing what that subsection must DO (its direction), never its content. No numbering, no prose — one job per line.';
      const u = [];
      if (fr.thesis_or_question) u.push('Document: ' + fr.thesis_or_question);
      u.push('Section to deepen: ' + (parent.job || ''));
      if (parentProse) u.push('What it says so far: ' + String(parentProse).slice(0, 400));
      u.push('');
      u.push('Propose its subsections, one job per line:');
      const text = await phrase({ system, user: u.join('\n'), max_tokens: 200 }, (delta) => setPlanning(t => ({ label, text: ((t && t.text) || '') + delta })));
      const jobs = cmpParseJobs(text, 4);
      let created = [];
      if (jobs.length) {
        let order = 0;
        created = jobs.map(j => C.make.unit({ doc_id: doc.id, job: j, order: order++, parent_id: parent.id }));
        const evts = created.slice();
        evts.push(C.make.planEdit({ doc_id: doc.id, edit_kind: 'add-unit', affected_unit_ids: created.map(e => e.id), reason: 'deepened “' + short + '” into subsections', confidence: C.confidence({ frame: 0.5 }) }));
        appendBatch(evts);
      }
      return created;
    } catch (e) { if (window.eoWarn) window.eoWarn('planFromUnit', e); return []; }
    finally { setPlanning(null); }
  };
  // Read a sample of the source corpus and PROPOSE a frame (thesis/reader/goal/
  // genre) — so "Go" needs no hand-written brief. Streamed into the plan pane
  // (you watch it read the sources), then appended as a frame event merged over
  // whatever the user already set — their fields win, we only fill the blanks.
  // Returns the merged frame so the in-flight autopilot uses it before the fold
  // re-derives; with no corpus it no-ops (the autopilot falls back to the frame).
  const deriveFrameFromCorpus = async () => {
    const sample = C.sampleCorpus(corpusDocs);
    if (!sample.length) return null;
    const READING = 'Reading the sources…';
    setPlanning({ label: READING, text: '' });
    try {
      const patch = await C.deriveFrame({
        sample, genres: CMP_GENRES, phrase,
        onToken: (delta) => setPlanning(t => ({ label: READING, text: ((t && t.text) || '') + delta })),
      });
      if (!patch) return null;
      // the user's own fields win; fill only what they left blank (genre counts as
      // unset while still at its plain-report default, so a derived genre can land)
      const merged = {
        doc_id: doc.id,
        thesis_or_question: frame.thesis_or_question || patch.thesis_or_question || '',
        reader: frame.reader || patch.reader || '',
        goal: frame.goal || patch.goal || '',
        constraints: frame.constraints || [],
        genre: (frame.genre && frame.genre !== 'plain-report') ? frame.genre : (patch.genre || 'plain-report'),
        // the user's outset dials ride through untouched — deriving the brief
        // never changes how long or how grounded they asked for
        target_words: frame.target_words != null ? frame.target_words : 800,
        mode: frame.mode === 'creative' ? 'creative' : 'grounded',
      };
      appendBatch([C.make.frame(merged)]);
      return merged;
    } catch (e) { if (window.eoWarn) window.eoWarn('deriveFrameFromCorpus', e); return null; }
    finally { setPlanning(null); }
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
                <div className="cmp-outlining-h"><span className="cmp-orb" /> {planning.label || 'Outlining…'}</div>
                <pre className="cmp-outlining-body">{planning.text || '…'}</pre>
              </div>
            ) : folded.tree.length ? folded.tree.map(n => (
              <PlanNode key={n.id} node={n} depth={0} selectedId={selectedId} onSelect={setSelectedId}
                onJob={editJob} onMove={moveUnit} onCut={cutUnit} />
            )) : <div className="cmp-empty">No plan yet. Just press <b>▶ Go</b> — it reads your sources, frames the document, outlines it, then drafts every unit, live. (Or set a thesis above and use <b>Outline only</b>, or add a unit by hand.)</div>}
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
            )) : <div className="cmp-empty">Press <b>▶ Go</b> and watch it draft, unit by unit — each claim bound to evidence, each unit stamped with its full confidence vector.</div>}
          </div>
        </div>
      </div>
      <ActionSurface folded={folded} selectedId={selectedId} busy={busy} modelReady={modelReady} onAct={onAct} progress={progress} />
    </div>
  );
}

Object.assign(window, { CompositionView, ConfBars, PlanNode, UnitCard });
