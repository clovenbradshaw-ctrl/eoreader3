/* ============================================================ Chat pane ==== */
const CITE_RE = /\{\{(cite|void):([^}]*)\}\}/g;

function renderAnswer(text, onCite) {
  return String(text).split('\n\n').map((block, bi) => {
    const parts = []; let last = 0, m; CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(block)) !== null) {
      if (m.index > last) parts.push(renderBold(block.slice(last, m.index), bi + '-' + last));
      if (m[1] === 'cite') {
        const [docId, idx, label] = m[2].split(':');
        parts.push(<span key={m.index} className="cite" onClick={() => onCite(docId, parseInt(idx, 10))}>{label}</span>);
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

function Message({ msg, onCite }) {
  if (msg.role === 'user') return <div className="msg-row user"><div className="bubble-user">{msg.text}</div></div>;
  return (
    <div className="msg-row asst">
      <div className="msg-asst">
        <div className="asst-head">
          <span className="asst-av">Cl</span><span className="asst-name">Cleon</span>
          {msg.mode && <span className="asst-mode-tag">{msg.mode}</span>}
        </div>
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
            <button title="Copy" onClick={() => { try { navigator.clipboard.writeText(String(msg.text).replace(/\{\{(cite|void):[^}]*\}\}/g, '')); } catch (e) {} }}><Icon name="copy" size={15} /></button>
            <button title="Good answer"><Icon name="thumbsup" size={15} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

const MODES = [{ id: 'auto', label: 'Auto' }, { id: 'grounded', label: 'Grounded' }, { id: 'creative', label: 'Creative' }];
function Composer({ value, onChange, onSend, mode, onMode, onAttach, busy, placeholder }) {
  const ref = React.useRef(null);
  React.useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }, [value]);
  const submit = () => { if (value.trim() && !busy) onSend(); };
  return (
    <div className="composer-box">
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
        <button className="send-btn" disabled={!value.trim() || busy} onClick={submit}><Icon name="send" size={16} /></button>
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

Object.assign(window, { ChatPane, Hero, Composer, Message, AuditBadge, renderAnswer });
