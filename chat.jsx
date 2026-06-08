/* ============================================================ Chat pane ==== */
const CITE_RE = /\{\{(cite|void):([^}]*)\}\}/g;

function renderAnswer(text, onCite) {
  return String(text).split('\n\n').map((block, bi) => {
    const parts = []; let last = 0, m; CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(block)) !== null) {
      if (m.index > last) parts.push(renderBold(block.slice(last, m.index), bi + '-' + last));
      if (m[1] === 'cite') {
        const [docId, idx, label] = m[2].split(':');
        parts.push(<button key={m.index} type="button" className="cite" title={'Jump to ' + label + ' in the document'}
          onClick={() => onCite(docId, parseInt(idx, 10))}>{label}</button>);
      } else {
        parts.push(<span key={m.index} className="cite void" title="This term appears nowhere in the sources">{m[2]}</span>);
      }
      last = m.index + m[0].length;
    }
    if (last < block.length) parts.push(renderBold(block.slice(last), bi + '-end'));
    return <p key={bi}>{parts}</p>;
  });
}
/* lightweight **bold** */
function renderBold(s, key) {
  const out = []; let last = 0, m, k = 0; const re = /\*\*([^*]+)\*\*/g;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(<strong key={key + '-' + k++}>{m[1]}</strong>); last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return <React.Fragment key={key}>{out}</React.Fragment>;
}

function AuditBadge({ audit }) {
  if (!audit) return null;
  // An explicitly ungrounded answer (plain chat while a document is open): show
  // that it was NOT drawn from the page, so a model answer is never mistaken for
  // a grounded, cited one. These carry no coverage/stability figures. (1b)
  if (audit.grounded === false && audit.covers == null) {
    return (
      <div>
        <div className="audit">
          <span className="audit-chip plain">
            <span className="seg"><span className="no">–</span>not from the document</span>
          </span>
        </div>
        {audit.note && <div className="audit-note">{audit.note}</div>}
      </div>
    );
  }
  const Seg = ({ ok, children }) => <span className="seg"><span className={ok ? 'ok' : 'no'}>{ok ? '✓' : '–'}</span>{children}</span>;
  const full = audit.covers && audit.covers.split('/')[0] === audit.covers.split('/')[1];
  return (
    <div>
      <div className="audit">
        <span className={'audit-chip ' + audit.status}>
          <Seg ok={audit.grounded}>grounded</Seg><span className="sep">·</span>
          <Seg ok={full}>covers {audit.covers}</Seg><span className="sep">·</span>
          <Seg ok={audit.stable}>stable</Seg>
        </span>
      </div>
      {audit.note && <div className="audit-note">{audit.note}</div>}
    </div>
  );
}

/* ── Inline "thinking" disclosure ─────────────────────────────────────────
   A Claude-style collapsible panel under each Cleon answer that narrates the
   turn's pipeline from window.EOAudit — and, crucially, surfaces the model's
   raw draft even when the veto set it aside, with the reason. The glass box,
   inline: while the turn runs it reads "Thinking…"; once done it collapses to
   "Thought for Ns", expandable. */
function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
}
function quoteList(arr) {
  const q = (arr || []).map(x => '“' + x + '”');
  return q.length <= 1 ? (q[0] || '') : q.slice(0, -1).join(', ') + ' and ' + q[q.length - 1];
}
function narrateTurn(turn) {
  const S = window.stripForView || (x => String(x == null ? '' : x));
  const out = [];
  const push = (text, draft) => { if (text) out.push(draft != null ? { text, draft } : { text }); };
  for (const s of (turn.steps || [])) {
    switch (s.t) {
      case 'route':
        if (s.detour) push('Read it as a question about the document (' + s.detour + ').');
        else if (s.path === 'creative') push('Answering in creative mode' + (s.referencing ? ', drawing on the open document.' : ', writing freely.'));
        else if (s.path && s.referencing === false) push('This read as ordinary conversation, not a question about the document.');
        else if (s.primary) push('Focused on “' + s.primary.name + '” as the source to read.');
        break;
      case 'intent':
        push(s.intent === 'who' ? 'Took it as a “who appears” question — answered by exact count, no model.'
          : s.intent === 'summary' ? 'Took it as a request to summarize.'
          : 'Took it as a factual question.');
        break;
      case 'ground': {
        const named = (s.perDoc || []).filter(d => d.has).map(d => d.name);
        push(s.hasGround
          ? 'Found supporting passages' + (named.length ? ' in ' + named.join(', ') : '') + (s.viaSemantic ? ' (by meaning).' : '.')
          : 'Found nothing in the document that answers this — fell back to the mechanical reading.');
        break;
      }
      case 'referents':
        if (s.antimatter && s.antimatter.length)
          push('Noticed ' + quoteList(s.antimatter) + ' — named in the question but nowhere in the document.');
        break;
      case 'retrieve': {
        const n = s.hits ? s.hits.length : s.k;
        push('Pulled the ' + n + ' most relevant passage' + (n === 1 ? '' : 's') + '.');
        break;
      }
      case 'escalate':
        push(s.recovered ? 'The wording was vague, so I searched by meaning and found the passage.'
          : 'Searched by meaning too, but nothing relevant turned up — treated it as conversation.');
        break;
      case 'model':
        push(s.ok ? 'Loaded the local model (' + s.model + ').' : 'The local model failed to load (' + s.model + ').');
        break;
      case 'llm': {
        const draft = S(s.output);
        if (s.error) push('Tried to draft an answer, but the model errored: ' + s.error + '.');
        else if (draft) push('Drafted an answer in its own words:', draft);
        break;
      }
      case 'veto':
        if (s.decision === 'model')
          push('Checked the draft against the document — every name and claim binds to a passage — so I kept it' + (s.boundCovers ? ' (covers ' + s.boundCovers + ').' : '.'));
        else if (s.decision === 'model-caveat')
          push('Kept the draft, but it named ' + quoteList(s.invented || []) + ' — not in the document — so I struck those as unverified and flagged the answer.');
        else if (s.decision === 'reject')
          push('The draft just echoed a single passage instead of answering, so I sent it back under a stricter rule.');
        else if (s.decision === 'mechanical') {
          if (s.invented && s.invented.length)
            push('Set the draft aside — it named ' + quoteList(s.invented) + ', not in the document — and used the exact mechanical reading instead.');
          else if (s.reason && /unbound/.test(s.reason))
            push('The draft didn’t match any passage in the document, so I used the exact mechanical reading instead.');
          else if (s.reason && /declin|empty/i.test(s.reason))
            push('The model declined or returned nothing, so I used the exact mechanical reading instead.');
          else if (s.reason && /echo/i.test(s.reason))
            push('The draft still only echoed the source after a retry, so I used the exact mechanical reading instead.');
          else push('Set the draft aside and used the exact mechanical reading instead.');
        }
        break;
      case 'error':
        push('Hit a problem' + (s.where ? ' (' + s.where + ')' : '') + ': ' + (s.message || 'unknown') + '.');
        break;
    }
  }
  const f = turn.final;
  if (f && f.engine) {
    const modelName = (turn.model && turn.model.name) || 'the local model';
    push(/mechanical/.test(f.engine) ? 'Final answer: the document’s exact mechanical reading.'
      : /caveat/.test(f.engine) ? 'Final answer: the model’s phrasing, kept with unverified terms struck and citations bound.'
      : /model/.test(f.engine) ? 'Final answer: phrased by ' + modelName + ', with citations bound to the document.'
      : 'Final answer: ' + f.engine + '.');
  }
  return out;
}
function ThinkingBlock({ auditId }) {
  const [, force] = React.useReducer(x => x + 1, 0);
  const [open, setOpen] = React.useState(null);   // null = auto (open live, closed once done); sticky once clicked
  const A = (typeof window !== 'undefined') ? window.EOAudit : null;
  const turn = (A && auditId) ? A.all().find(t => t.id === auditId) : null;
  const live = !!(turn && !turn.done);
  React.useEffect(() => {
    if (!A || !live) return;                        // only subscribe while the turn streams
    return A.subscribe(() => force());
  }, [A, auditId, live]);
  if (!A || !auditId || !turn || !turn.steps || !turn.steps.length) return null;
  const lines = narrateTurn(turn);
  if (!lines.length) return null;
  const expanded = open == null ? live : open;
  const ms = turn.ms != null ? turn.ms : (turn.steps.length ? turn.steps[turn.steps.length - 1].dt : 0);
  return (
    <div className={'think' + (live ? ' live' : '') + (expanded ? ' open' : '')}>
      <button type="button" className="think-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? false : true)}>
        <Icon name={live ? 'activity' : 'sparkle'} size={13} className="think-ico" />
        <span className="think-label">{live ? 'Thinking…' : 'Thought for ' + fmtMs(ms)}</span>
        <Icon name="chevron" size={13} className={'think-chev' + (expanded ? ' open' : '')} />
      </button>
      {expanded && (
        <div className="think-body">
          {lines.map((ln, i) => (
            <div key={i} className={'think-line' + (ln.draft != null ? ' draft' : '')}>
              {ln.draft != null
                ? <React.Fragment><span className="think-lead">{ln.text}</span><pre className="think-quote">{ln.draft || '∅'}</pre></React.Fragment>
                : ln.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ msg, onCite }) {
  if (msg.role === 'user') return <div className="msg-row user"><div className="bubble-user">{msg.text}</div></div>;
  return (
    <div className="msg-row asst">
      <div className="msg-asst">
        <div className="asst-head">
          <span className="asst-av">Cl</span><span className="asst-name">Cleon</span>
          {msg.mode && <span className="asst-mode-tag">{msg.mode}</span>}
        </div>
        {msg.auditId && <ThinkingBlock auditId={msg.auditId} />}
        {msg.loading
          ? <div className="model-loading">
              <div className="ml-row"><span className="ml-spin" /> Loading {msg.loadName || 'local model'}… <b>{Math.round((msg.loadPct || 0) * 100)}%</b></div>
              <div className="ml-bar"><div className="ml-fill" style={{ width: Math.round((msg.loadPct || 0) * 100) + '%' }} /></div>
              <div className="ml-note">First time only — the model downloads once, then runs on your GPU and is cached.</div>
            </div>
          : msg.typing ? <div className="typing"><span /><span /><span /></div>
          : <React.Fragment>{renderAnswer(msg.text, onCite)}<AuditBadge audit={msg.audit} /></React.Fragment>}
        {!msg.typing && !msg.loading && (
          <div className="msg-actions">
            <button title="Copy" onClick={() => { try { navigator.clipboard.writeText(String(msg.text).replace(/\{\{(cite|void):[^}]*\}\}/g, '')); } catch (e) { window.eoWarn && window.eoWarn('copy failed', e); } }}><Icon name="copy" size={15} /></button>
            <button title="Good answer"><Icon name="thumbsup" size={15} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

const MODES = [{ id: 'auto', label: 'Auto' }, { id: 'grounded', label: 'Grounded' }, { id: 'creative', label: 'Creative' }];
function SourceChips({ sources, addable, onAddSource, onRemoveSource }) {
  const [open, setOpen] = React.useState(false);
  const has = (sources && sources.length) || (addable && addable.length);
  if (!has) return null;
  return (
    <div className="source-chips">
      <span className="src-label">Sources</span>
      {(sources || []).map(s => (
        <span key={s.id} className={'src-chip' + (s.kind === 'table' ? ' table' : '')} title={s.name}>
          <span className="src-dot" />
          <span className="src-name">{s.name}</span>
          <button className="src-x" onClick={() => onRemoveSource(s.id)} aria-label={'Remove ' + s.name + ' from sources'}>×</button>
        </span>
      ))}
      {(addable && addable.length > 0) && (
        <span className="src-add">
          <button className="src-chip add" onClick={() => setOpen(o => !o)} aria-expanded={open}>+ Source</button>
          {open && (
            <div className="src-menu" onMouseLeave={() => setOpen(false)}>
              {addable.map(d => (
                <button key={d.id} onClick={() => { onAddSource(d.id); setOpen(false); }}>
                  <span className={'src-dot' + (d.kind === 'table' ? ' table' : '')} /> {d.name}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

function Composer({ value, onChange, onSend, mode, onMode, onAttach, busy, placeholder, sources, addable, onAddSource, onRemoveSource }) {
  const ref = React.useRef(null);
  React.useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }, [value]);
  const submit = () => { if (value.trim() && !busy) onSend(); };
  return (
    <div className="composer-box">
      <SourceChips sources={sources} addable={addable} onAddSource={onAddSource} onRemoveSource={onRemoveSource} />
      <textarea ref={ref} value={value} rows={1} placeholder={placeholder || 'Message Cleon…'}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
      <div className="composer-bar">
        <button className="comp-btn icon" title="Attach a file" onClick={onAttach}><Icon name="paperclip" size={16} /></button>
        <div className="mode-seg">
          {MODES.map(md => (
            <button key={md.id} className={(mode === md.id ? 'on ' + md.id : '')} onClick={() => onMode(md.id)}>
              {md.id === 'grounded' && <Icon name="check" size={13} />}
              {md.id === 'creative' && <Icon name="sparkle" size={13} />}{md.label}
            </button>
          ))}
        </div>
        <div className="comp-spacer" />
        <button className="send-btn" aria-label="Send message" disabled={!value.trim() || busy} onClick={submit}><Icon name="send" size={16} /></button>
      </div>
    </div>
  );
}

/* hero / empty state — upload-centric */
function Hero({ composerProps, onAttach, onExample, onPaste, dragOver }) {
  return (
    <div className="hero">
      <div className="hero-inner">
        <div className="hero-eyebrow">Private · on your device</div>
        <h1>Ask Cleon anything.</h1>
        <p className="lede">A private assistant that runs entirely in your browser. Add a document or spreadsheet and it’ll answer straight from it — citing whatever it used.</p>
        <div className={'composer dropzone-ring' + (dragOver ? ' over' : '')}>
          <Composer {...composerProps} placeholder="Message Cleon — or drop in a file…" />
        </div>
        <div className="hero-actions">
          <button className="hero-action primary" onClick={onAttach}><Icon name="upload" size={16} /> Upload a file</button>
          <span className="hero-or">or load an example</span>
          {window.EXAMPLES.map(ex => (
            <button key={ex.id} className="hero-action" onClick={() => onExample(ex)}><Icon name={ex.icon} size={15} /> {ex.label}</button>
          ))}
        </div>
        <div className="hero-foot">Runs locally · nothing leaves your browser</div>
      </div>
    </div>
  );
}

function ChatPane({ messages, onCite, composerProps, narrow, wide }) {
  const streamRef = React.useRef(null);
  React.useEffect(() => { const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  return (
    <div className={'pane-chat' + (narrow ? ' narrow' : '') + (wide ? ' wide' : '')} style={{ flex: 1, minHeight: 0 }}>
      <div className="chat-stream" ref={streamRef}>
        <div className="chat-inner">{messages.map((m, i) => <Message key={i} msg={m} onCite={onCite} />)}</div>
      </div>
      <div className="composer-wrap">
        <div className="composer"><Composer {...composerProps} placeholder={narrow ? 'Ask about this document…' : 'Message Cleon…'} /></div>
        <div className="composer-hint">Runs locally · <b>{composerProps.mode}</b> mode</div>
      </div>
    </div>
  );
}

Object.assign(window, { ChatPane, Hero, Composer, Message, AuditBadge, renderAnswer, ThinkingBlock, narrateTurn });
