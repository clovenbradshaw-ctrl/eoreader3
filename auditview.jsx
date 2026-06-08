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

function AuditDrawer({ onClose, enabled, onToggle, onToast }) {
  const [, force] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    if (!window.EOAudit) return;
    return window.EOAudit.subscribe(() => force());   // live-update while turns stream in
  }, []);
  const dialogRef = window.useDialog(onClose);

  const turns = window.EOAudit ? window.EOAudit.all() : [];
  const view = turns.slice().reverse();               // newest first

  const exportJSONL = () => {
    if (!window.EOAudit || !turns.length) { onToast && onToast('No turns to export yet.'); return; }
    const ok = window.EOAudit.download();
    onToast && onToast(ok ? 'Exported ' + turns.length + ' turn' + (turns.length !== 1 ? 's' : '') + ' as JSONL' : 'Export failed.');
  };
  const copyJSONL = () => {
    if (!window.EOAudit || !turns.length) { onToast && onToast('No turns to copy yet.'); return; }
    try { navigator.clipboard.writeText(window.EOAudit.toJSONL()); onToast && onToast('Copied ' + turns.length + ' turns as JSONL'); }
    catch (e) { onToast && onToast('Copy failed.'); }
  };
  const clearLog = () => { if (window.EOAudit) window.EOAudit.clear(); onToast && onToast('Audit log cleared.'); };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer audit-drawer" role="dialog" aria-modal="true" aria-label="Audit log"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Audit</h2>
            <button className="x" onClick={onClose} aria-label="Close audit"><Icon name="x" size={18} /></button>
          </div>
          <p>Every chat turn, step by step — how it routed, what it retrieved, the exact prompt the model saw and the raw text it wrote, what was vetoed, and the citations and coverage it ended on. The intelligence is mechanical; this is the glass box around it. Export the whole trace as JSONL.</p>
        </div>

        <div className="drawer-tabs">
          <button className={'aud-rec' + (enabled ? ' on' : '')} role="switch" aria-checked={enabled}
                  onClick={() => onToggle()} title="Record chat turns">
            <span className={'switch' + (enabled ? ' on' : '')} aria-hidden="true" />
            <span className="aud-rec-lbl">{enabled ? 'Recording' : 'Paused'}</span>
          </button>
          <span className="aud-count">{turns.length} turn{turns.length !== 1 ? 's' : ''}</span>
          <div style={{ flex: 1 }} />
          <div className="drawer-tools">
            <button className="mini-btn" onClick={copyJSONL} title="Copy JSONL to clipboard"><Icon name="copy" size={13} /></button>
            <button className="mini-btn" onClick={clearLog} title="Clear the audit log"><Icon name="x" size={13} /> Clear</button>
            <button className="mini-btn primary" onClick={exportJSONL} title="Download the trace as JSONL"><Icon name="upload" size={13} /> Export JSONL</button>
          </div>
        </div>

        <div className="drawer-body aud-body">
          {view.length
            ? view.map(t => <AuditTurn key={t.id} turn={t} />)
            : <div className="empty-doc" style={{ padding: 40 }}>{enabled
                ? 'No turns recorded yet — ask Cleon something and the full pipeline shows up here.'
                : 'Recording is paused. Turn it on to capture chat turns.'}</div>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AuditDrawer, AuditTurn, AuditStep, stripForView });
