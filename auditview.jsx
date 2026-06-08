/* ============================================================ Audit drawer
   The glass box. Every chat turn's pipeline — route, intent, ground,
   retrieve, the exact model prompt + raw output, the mechanical veto,
   citations, and the coverage/grounding it ended on — shown step by step
   and exportable as JSONL (one self-contained turn per line).

   Reads window.EOAudit (the recorder); never writes the trace itself.
   ============================================================ */

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch (e) { return iso || ''; }
}

// Make the engine's {{cite}}/{{void}} markup readable in the trace view:
// citations collapse to their [sN] label, voids to ⟨term⟩.
function stripForView(s) {
  return String(s == null ? '' : s)
    .replace(/\{\{cite:([^}]*)\}\}/g, (m, b) => { const p = b.split(':'); return p[2] ? ' [' + p[2] + ']' : ''; })
    .replace(/\{\{void:([^}]*)\}\}/g, '⟨$1⟩')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

// One pipeline step, rendered type-aware and compact.
function AuditStep({ s }) {
  const Line = ({ label, kind, children }) => (
    <div className="aud-step">
      <span className={'aud-st ' + (kind || s.t)}>{label || s.t}</span>
      <div className="aud-sb">{children}</div>
      {s.ms != null ? <span className="aud-dt">{s.ms}ms</span> : s.dt != null ? <span className="aud-dt">+{s.dt}ms</span> : null}
    </div>
  );

  if (s.t === 'route') return (
    <Line label="route" kind="route">
      <span>{s.path || s.detour || '—'}</span>
      {s.reason && <span className="aud-dim"> · {s.reason}</span>}
      {s.primary && <span className="aud-dim"> · primary: {s.primary.name}</span>}
      {s.blocked && <span className="aud-dim"> · blocked: {s.blocked}</span>}
    </Line>
  );
  if (s.t === 'intent') return <Line label="intent" kind="intent"><b>{s.intent}</b></Line>;
  if (s.t === 'model') return <Line label="model" kind="model">{s.action} {s.model} {s.ok ? '✓ loaded' : '✗ failed'}</Line>;
  if (s.t === 'ground') return (
    <Line label="ground" kind="ground">
      <b>{s.hasGround ? 'has ground' : 'no ground'}</b>
      {(s.perDoc && s.perDoc.length > 1) && <span className="aud-dim"> · {s.perDoc.map(d => d.name + (d.has ? ' ✓' : ' ✗')).join(', ')}</span>}
    </Line>
  );
  if (s.t === 'referents') return (
    <Line label="referents" kind="referents">
      <span className="aud-dim">matter:</span> {(s.matter && s.matter.length) ? s.matter.join(', ') : '—'}
      {' · '}<span className="aud-dim">void:</span> {(s.antimatter && s.antimatter.length) ? <span className="aud-void">{s.antimatter.join(', ')}</span> : '—'}
    </Line>
  );
  if (s.t === 'retrieve') return (
    <Line label="retrieve" kind="retrieve">
      <div className="aud-dim">k={s.k}{s.task ? ' · ' + s.task : ''} · {(s.hits || []).length} hits{s.engine ? ' · ' + s.engine : ''}</div>
      {(s.hits || []).map((h, i) => (
        <div key={i} className="aud-hit"><b className="aud-score">{h.score}</b><span className="aud-cite">s{h.idx}</span><span className="aud-hit-t">{h.text}</span></div>
      ))}
    </Line>
  );
  if (s.t === 'escalate') return (
    <Line label="escalate" kind="retrieve">
      <span className="aud-dim">{s.reason} · {s.reader} · {s.found} hit{s.found !== 1 ? 's' : ''}</span>
      {' '}{s.recovered ? <b>recovered</b> : <span className="aud-dim">→ chat</span>}
    </Line>
  );
  if (s.t === 'llm') return (
    <div className="aud-step">
      <span className="aud-st llm">llm</span>
      <div className="aud-sb">
        <div className="aud-dim">{s.mode}{s.task ? '/' + s.task : ''} · temp {s.params && s.params.temperature} · max {s.params && s.params.max_tokens}{s.error ? ' · ⚠ error' : ''}</div>
        <details className="aud-det">
          <summary>prompt — {(s.messages || []).length} message{(s.messages || []).length !== 1 ? 's' : ''}</summary>
          {(s.messages || []).map((m, i) => (
            <div key={i} className="aud-msg"><span className={'aud-role ' + m.role}>{m.role}</span><pre>{m.content}</pre></div>
          ))}
        </details>
        <div className="aud-out"><span className="aud-role out">output</span><pre>{s.error ? '⚠ ' + s.error : (s.output || '∅')}</pre></div>
      </div>
      {s.ms != null && <span className="aud-dt">{s.ms}ms</span>}
    </div>
  );
  if (s.t === 'veto') return (
    <Line label="veto" kind="veto">
      <b>{s.decision}</b>
      {(s.invented && s.invented.length) ? <span> · invented: <span className="aud-void">{s.invented.join(', ')}</span></span> : null}
      {s.boundCovers && <span className="aud-dim"> · bound covers {s.boundCovers}</span>}
      {s.reason && <span className="aud-dim"> · {s.reason}</span>}
    </Line>
  );
  if (s.t === 'error') return <Line label="error" kind="error"><span className="aud-void">{s.where}: {s.message}</span></Line>;
  return <Line label={s.t}><span className="aud-dim">{JSON.stringify(s)}</span></Line>;
}

// One collapsible turn: header summary + (on expand) timeline or raw JSON.
function AuditTurn({ turn }) {
  const [open, setOpen] = React.useState(false);
  const [json, setJson] = React.useState(false);
  const a = turn.final && turn.final.audit;
  const route = (turn.steps || []).filter(s => s.t === 'route' && s.path).slice(-1)[0];
  const badge = !turn.done
    ? <span className="aud-badge run">running…</span>
    : a == null
      ? <span className="aud-badge plain">{(turn.final && turn.final.engine) || 'none'}</span>
      : (a.grounded === false && a.covers == null)
        ? <span className="aud-badge plain">not grounded</span>
        : <span className={'aud-badge ' + (a.status || '')}>{a.grounded ? 'grounded' : 'held'}{a.covers ? ' · ' + a.covers : ''}</span>;

  return (
    <div className={'aud-turn' + (open ? ' open' : '')}>
      <button className="aud-turn-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Icon name="chevron" size={13} className={'aud-chev' + (open ? ' open' : '')} />
        <span className="aud-time">{fmtTime(turn.at)}</span>
        {turn.mode && <span className={'aud-mode ' + turn.mode}>{turn.mode}</span>}
        {route && <span className="aud-path">{route.path}</span>}
        {turn.final && turn.final.engine && <span className="aud-engine">{turn.final.engine}</span>}
        <span className="aud-q">{turn.input}</span>
        <span className="aud-grow" />
        {badge}
        {turn.ms != null && <span className="aud-ms">{turn.ms}ms</span>}
      </button>
      {open && (
        <div className="aud-turn-body">
          <div className="aud-meta">
            <span>scope: {(turn.scope && turn.scope.length) ? turn.scope.map(s => s.name).join(', ') : '—'}</span>
            <span>model: {(turn.model && turn.model.name) || '—'}{turn.modelReady === false ? ' (not ready)' : ''}</span>
            {turn.prevGrounded != null && <span>prevGrounded: {String(turn.prevGrounded)}</span>}
            <button className="audit-link" onClick={() => setJson(v => !v)}>{json ? 'timeline' : 'raw JSON'}</button>
          </div>
          {json
            ? <pre className="rule-json">{JSON.stringify(window.EOAudit ? window.EOAudit.publicTurn(turn) : turn, null, 2)}</pre>
            : (
              <div className="aud-steps">
                {(turn.steps || []).map((s, i) => <AuditStep key={i} s={s} />)}
                {turn.final && (
                  <div className="aud-step">
                    <span className="aud-st answer">answer</span>
                    <div className="aud-sb">
                      <pre className="aud-answer">{stripForView(turn.final.text) || '∅'}</pre>
                      {turn.final.audit && turn.final.audit.note && <div className="aud-dim aud-note">{turn.final.audit.note}</div>}
                    </div>
                  </div>
                )}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// One extracted document's graph, made explorable: the entities (heaviest
// first), the relations between them, the copular assertions, the section
// spine, and the full processing log. Reads window.EOEngine.graphSnapshot.
function GraphView({ doc }) {
  const snap = React.useMemo(
    () => (doc && window.EOEngine && window.EOEngine.graphSnapshot ? window.EOEngine.graphSnapshot(doc) : null),
    [doc]);
  if (!doc) return <div className="empty-doc" style={{ padding: 40 }}>No document loaded to graph yet — add a source and its extracted graph shows up here.</div>;
  if (!snap) return <div className="empty-doc" style={{ padding: 40 }}>This source has no extracted graph (tables and very short texts don’t carry one).</div>;
  const events = snap.events || [];
  const ops = {};
  for (const ev of events) ops[ev.op] = (ops[ev.op] || 0) + 1;
  const opList = Object.entries(ops).sort((a, b) => b[1] - a[1]);
  const evText = (ev) => [ev.target || ev.s || ev.canonical || (ev.sites ? ev.sites.join('+') : '') || ev.speaker || '',
    ev.v ? ' ' + ev.v : '', ev.o ? ' ' + ev.o : '', ev.value != null ? ' = ' + ev.value : ''].join('').trim();
  return (
    <div className="graph-view">
      <div className="graph-meta">
        <span><b>{snap.entities.length}</b> entit{snap.entities.length === 1 ? 'y' : 'ies'}</span>
        <span><b>{snap.edges.length}</b> relation{snap.edges.length === 1 ? '' : 's'}</span>
        <span><b>{events.length}</b> event{events.length === 1 ? '' : 's'}</span>
        <span><b>{snap.doc.sentences}</b> sentence{snap.doc.sentences === 1 ? '' : 's'}</span>
      </div>

      <div className="graph-sec">
        <h4>Entities <span className="graph-dim">— who/what the reading found, heaviest first</span></h4>
        <div className="graph-ents">
          {snap.entities.slice(0, 60).map((e, i) => (
            <div key={i} className="graph-ent">
              <span className={'graph-tag ' + e.type}>{e.type}</span>
              <span className="graph-ent-name">{e.name}</span>
              <span className="graph-ent-n">×{e.mentions}</span>
            </div>
          ))}
          {!snap.entities.length && <div className="graph-dim">none</div>}
        </div>
      </div>

      <div className="graph-sec">
        <h4>Relations <span className="graph-dim">— edges between entities</span></h4>
        <div className="graph-edges">
          {snap.edges.slice(0, 60).map((e, i) => (
            <div key={i} className="graph-edge">
              <span className="graph-a">{e.aName}</span>
              <span className="graph-verb">{e.verb || '—'}</span>
              <span className="graph-b">{e.bName}</span>
              {e.weight > 1 && <span className="graph-ent-n">×{e.weight}</span>}
            </div>
          ))}
          {!snap.edges.length && <div className="graph-dim">none</div>}
        </div>
      </div>

      {snap.assertions.length > 0 && (
        <div className="graph-sec">
          <h4>Asserts <span className="graph-dim">— what the text states outright</span></h4>
          <div className="graph-asserts">
            {snap.assertions.map((a, i) => <div key={i} className="graph-assert"><b>{a.subject}</b> is {a.is}</div>)}
          </div>
        </div>
      )}

      {snap.spine.length > 0 && (
        <div className="graph-sec">
          <h4>Spine <span className="graph-dim">— section order</span></h4>
          <div className="graph-spine">{snap.spine.join('  ·  ')}</div>
        </div>
      )}

      <details className="graph-proc">
        <summary>Processing — {events.length} events{opList.length ? ' (' + opList.map(([op, n]) => op + ' ' + n).join(', ') + ')' : ''}</summary>
        <div className="graph-events">
          {events.slice(0, 400).map((ev, i) => (
            <div key={i} className="graph-ev">
              <span className="graph-ev-op">{ev.op}</span>
              <span className="graph-ev-s">s{ev.sentence_idx != null ? ev.sentence_idx : '·'}</span>
              <span className="graph-ev-t">{evText(ev)}</span>
            </div>
          ))}
          {events.length > 400 && <div className="graph-dim">…{events.length - 400} more (the full set is in the export)</div>}
        </div>
      </details>
    </div>
  );
}

// Assemble the unified export: graph snapshot line(s) (schema cleon-graph/1)
// when ingestion is on, plus the audit turn lines (schema cleon-audit/1) when
// output is on. Every line is a self-contained, independently-parseable record.
function buildUnifiedJSONL({ docs, includeIngestion, includeOutput }) {
  const lines = [];
  if (includeIngestion && window.EOEngine && window.EOEngine.graphSnapshot) {
    for (const d of (docs || [])) {
      if (d && d.kind === 'prose') { try { const g = window.EOEngine.graphSnapshot(d); if (g) lines.push(JSON.stringify(g)); } catch (e) {} }
    }
  }
  if (includeOutput && window.EOAudit) { const jl = window.EOAudit.toJSONL(); if (jl) lines.push(jl); }
  return lines.join('\n');
}
function downloadText(text, name) {
  try {
    const blob = new Blob([text], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) { return false; }
}

function AuditDrawer({ onClose, enabled, onToggle, onToast, docs, exportIngestion, exportOutput, onExportIngestion, onExportOutput }) {
  const [, force] = React.useReducer(x => x + 1, 0);
  const [tab, setTab] = React.useState('trace');
  const [graphDocId, setGraphDocId] = React.useState(null);
  React.useEffect(() => {
    if (!window.EOAudit) return;
    return window.EOAudit.subscribe(() => force());   // live-update while turns stream in
  }, []);
  const dialogRef = window.useDialog(onClose);

  const turns = window.EOAudit ? window.EOAudit.all() : [];
  const view = turns.slice().reverse();               // newest first
  const proseDocs = (docs || []).filter(d => d && d.kind === 'prose');
  const graphDoc = proseDocs.find(d => d.id === graphDocId) || proseDocs[proseDocs.length - 1] || null;

  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
  const build = () => buildUnifiedJSONL({ docs, includeIngestion: exportIngestion, includeOutput: exportOutput });
  const exportJSONL = () => {
    if (!exportIngestion && !exportOutput) { onToast && onToast('Turn on extraction or chat to export.'); return; }
    const text = build();
    if (!text) { onToast && onToast('Nothing to export yet.'); return; }
    const ok = downloadText(text, 'cleon-glassbox-' + ts() + '.jsonl');
    onToast && onToast(ok ? 'Exported as JSONL' : 'Export failed.');
  };
  const copyJSONL = () => {
    if (!exportIngestion && !exportOutput) { onToast && onToast('Turn on extraction or chat to export.'); return; }
    const text = build();
    if (!text) { onToast && onToast('Nothing to copy yet.'); return; }
    try { navigator.clipboard.writeText(text); onToast && onToast('Copied as JSONL'); }
    catch (e) { onToast && onToast('Copy failed.'); }
  };
  const clearLog = () => { if (window.EOAudit) window.EOAudit.clear(); onToast && onToast('Trace cleared.'); };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer audit-drawer" role="dialog" aria-modal="true" aria-label="Glass box"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Glass box</h2>
            <button className="x" onClick={onClose} aria-label="Close glass box"><Icon name="x" size={18} /></button>
          </div>
          <p>The extracted graph and every chat turn, step by step — how it read the document, how it routed, what it retrieved, the exact prompt the model saw and the raw text it wrote, what was vetoed, and the citations it ended on. The intelligence is mechanical; this is the glass box around it. Export the whole thing as JSONL.</p>
        </div>

        <div className="drawer-tabs">
          <button className={'drawer-tab' + (tab === 'trace' ? ' on' : '')} onClick={() => setTab('trace')}>Trace{turns.length ? ' · ' + turns.length : ''}</button>
          <button className={'drawer-tab' + (tab === 'graph' ? ' on' : '')} onClick={() => setTab('graph')}>Graph{proseDocs.length ? ' · ' + proseDocs.length : ''}</button>
          <div style={{ flex: 1 }} />
          {tab === 'trace' && (
            <button className={'aud-rec' + (enabled ? ' on' : '')} role="switch" aria-checked={enabled}
                    onClick={() => onToggle()} title="Record chat turns">
              <span className={'switch' + (enabled ? ' on' : '')} aria-hidden="true" />
              <span className="aud-rec-lbl">{enabled ? 'Recording' : 'Paused'}</span>
            </button>
          )}
          {tab === 'graph' && proseDocs.length > 1 && (
            <select className="graph-pick" value={graphDoc ? graphDoc.id : ''} onChange={e => setGraphDocId(e.target.value)}>
              {proseDocs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>

        <div className="drawer-body aud-body">
          {tab === 'trace'
            ? (view.length
                ? view.map(t => <AuditTurn key={t.id} turn={t} />)
                : <div className="empty-doc" style={{ padding: 40 }}>{enabled
                    ? 'No turns recorded yet — ask Cleon something and the full pipeline shows up here.'
                    : 'Recording is paused. Turn it on to capture chat turns.'}</div>)
            : <GraphView doc={graphDoc} />}
        </div>

        <div className="glass-foot">
          <div className="glass-toggles">
            <span className="glass-foot-lbl">Export</span>
            <label className="glass-tog"><input type="checkbox" checked={!!exportIngestion} onChange={e => onExportIngestion && onExportIngestion(e.target.checked)} /> Ingestion <span className="glass-dim">extraction graph</span></label>
            <label className="glass-tog"><input type="checkbox" checked={!!exportOutput} onChange={e => onExportOutput && onExportOutput(e.target.checked)} /> Output <span className="glass-dim">chat trace</span></label>
          </div>
          <div className="drawer-tools">
            <button className="mini-btn" onClick={copyJSONL} title="Copy the selected JSONL to clipboard"><Icon name="copy" size={13} /></button>
            <button className="mini-btn" onClick={clearLog} title="Clear the recorded trace"><Icon name="x" size={13} /> Clear</button>
            <button className="mini-btn primary" onClick={exportJSONL} title="Download the selected JSONL"><Icon name="upload" size={13} /> Export JSONL</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AuditDrawer, AuditTurn, AuditStep, GraphView, stripForView });
