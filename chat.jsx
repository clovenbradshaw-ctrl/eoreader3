/* ============================================================ Chat pane ==== */
const CITE_RE = /\{\{(cite|void|infer|absent):([^}]*)\}\}/g;

function renderAnswer(text, onCite) {
  return String(text).split('\n\n').map((block, bi) => {
    const parts = []; let last = 0, m; CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(block)) !== null) {
      if (m.index > last) parts.push(renderBold(block.slice(last, m.index), bi + '-' + last));
      if (m[1] === 'cite') {
        const [docId, idx, label] = m[2].split(':');
        parts.push(<button key={m.index} type="button" className="cite" title={'Jump to ' + label + ' in the document'}
          onClick={() => onCite(docId, parseInt(idx, 10))}>{label}</button>);
      } else if (m[1] === 'infer') {
        // The inference void: a claim the reader phrased across two cited spans the
        // page never connects. A third chip, between grounded and held.
        const [docId, pair, label] = m[2].split(':');
        const b = parseInt(String(pair || '').split('+')[1], 10);
        parts.push(<button key={m.index} type="button" className="cite infer"
          title="Inferred — the field linked these spans; the page never states the connection outright"
          onClick={() => onCite(docId, b)}>{label}</button>);
      } else if (m[1] === 'absent') {
        // Absence attestation: a negative claim ("never mentioned as a
        // speaker") cites ⊥ with the receipt of what was scanned — no single
        // line can support a claim about the whole document, but a full scan
        // of the event log can. The receipt rides in the tooltip.
        const i = m[2].indexOf(':');
        const receipt = i >= 0 ? m[2].slice(i + 1) : m[2];
        parts.push(<span key={m.index} className="cite absent"
          title={'Absence attested mechanically — ' + receipt}>⊥</span>);
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
  const inferred = audit.status === 'inferred' || (audit.inferred && audit.inferred.length);
  return (
    <div>
      <div className="audit">
        <span className={'audit-chip ' + audit.status}>
          {inferred && <React.Fragment><span className="seg"><span className="infer-mark">∴</span>inferred</span><span className="sep">·</span></React.Fragment>}
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
        push(s.intent === 'who' ? 'Took it as a “who appears” question — phrased by the model over the cast, with the exact mention-counts kept in the mechanical reading.'
          : s.intent === 'summary' ? 'Took it as a request to summarize.'
          : 'Took it as a factual question.');
        break;
      case 'ground': {
        const named = (s.perDoc || []).filter(d => d.has).map(d => d.name);
        push(s.hasGround
          ? 'Found supporting passages' + (named.length ? ' in ' + named.join(', ') : '') + (s.viaSemantic ? ' (by meaning).' : '.')
          : 'Found nothing in the document that answers this — answered it as conversation, keeping the page’s own mechanical reading to view.');
        break;
      }
      case 'referents':
        if (s.antimatter && s.antimatter.length)
          push('Noticed ' + quoteList(s.antimatter) + ' — named in the question but nowhere in the document.');
        break;
      case 'retrieve': {
        const n = s.hits ? s.hits.length : s.k;
        if (s.skipped) {
          push('The uncovered part of the question (' + quoteList(s.unseekable || []) + ') names nothing the sources contain, so I stopped seeking rather than chase it.');
        } else if (s.round && s.round > 1) {
          const sub = (s.subquery || '').trim();
          push('Still hadn’t covered ' + (sub ? '“' + sub + '”' : 'part of the question') + ', so I sought again' + (s.newHits ? ' and found ' + s.newHits + ' more passage' + (s.newHits === 1 ? '' : 's') : '') + '.');
        } else {
          push('Pulled the ' + n + ' most relevant passage' + (n === 1 ? '' : 's') + '.');
        }
        break;
      }
      case 'traverse': {
        const defs = (s.perDoc || []).reduce((a, p) => a + ((p.assertions || []).length), 0);
        const walkedN = (s.perDoc || []).reduce((a, p) => a + ((p.walked || []).length), 0);
        const ev = (s.perDoc || []).reduce((a, p) => a + ((p.evidence || []).length), 0);
        let line = 'Walked the graph out from ' + quoteList(s.entries || []) + (s.hops > 1 ? ' (' + s.hops + ' hops)' : '');
        const found = [];
        if (defs) found.push(defs + ' assertion' + (defs === 1 ? '' : 's') + ' the page makes');
        if (walkedN) found.push(walkedN + ' connected referent' + (walkedN === 1 ? '' : 's'));
        if (ev) found.push(ev + ' attached passage' + (ev === 1 ? '' : 's'));
        push(line + (found.length ? ' — gathered ' + found.join(', ') + '.' : ' — found nothing attached.'));
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
        else if (s.decision === 'model-flagged') {
          if (s.reason === 'contradicts-assertion' && s.contradictions && s.contradictions.length) {
            const c = s.contradictions[0];
            push('The draft conflicts with what the page asserts — the page holds “' + c.subject + ' is ' + c.is + '”' + (c.sent != null ? ' [s' + c.sent + ']' : '') + ', the draft said “' + c.claim + '” — but I kept the model’s answer and flagged it; the exact mechanical reading is one click away.');
          }
          else if (s.reason === 'relation-mismatch')
            push('A claim’s relation doesn’t match the page’s recorded edge — kept the model’s answer and flagged it; the exact mechanical reading is one click away.');
          else if (s.reason === 'kin-subject-mismatch')
            push('The draft may hang a role on the wrong person — kept the model’s answer and flagged it; the exact mechanical reading is one click away.');
          else if (s.reason && /unbound/.test(s.reason))
            push('The draft didn’t bind to any passage in the document — kept the model’s answer and flagged it; the exact mechanical reading is one click away.');
          else
            push('The draft tripped a check — kept the model’s answer and flagged it; the exact mechanical reading is one click away.');
        }
        else if (s.decision === 'mechanical') {
          if (s.reason === 'contradicts-assertion' && s.contradictions && s.contradictions.length) {
            const c = s.contradictions[0];
            push('Checked the draft against the graph: it denies what the page itself asserts — the page holds “' + c.subject + ' is ' + c.is + '”' + (c.sent != null ? ' [s' + c.sent + ']' : '') + ', the draft said otherwise (“' + c.claim + '”) — so I used the exact mechanical reading instead.');
          }
          else if (s.invented && s.invented.length)
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
      case 'working-memory': {
        // Legible-that: name what the turn carried forward, hottest first. This
        // step is only recorded above the dial's floor, so it stays silent at
        // reflex depth (parity).
        const parts = (s.hot || []).map(h => h.label + ' (hot)')
          .concat((s.warm || []).map(w => w.label + ' (warm, 1 hop)'))
          .concat((s.cold || []).slice(0, 2).map(c => c.label + ' (cooled)'));
        if (parts.length) push('Carried forward: ' + (parts.length <= 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]) + '.');
        if (s.recalled && s.recalled.length) push('Recalled ' + s.recalled.length + ' earlier passage' + (s.recalled.length === 1 ? '' : 's') + ' that became relevant again.');
        break;
      }
      case 'associate':
        // Legible-that: the field linked these spans; the page never did.
        push('Followed an association to ' + s.to + ' — near in meaning, but a connection the page never spells out.');
        break;
      case 'infer':
        if (s.pairs && s.pairs.length)
          push('Marked an inference: I connected ' + s.pairs.map(p => '[s' + p.a + '] and [s' + p.b + ']').join(', ') + ' — a link the field drew that the page never states. Badged inferred, not grounded.');
        break;
      case 'plan-seg':
        // Reconsideration: the turn reconsidered its own plan after drafting.
        push(s.to === 'creative' ? 'Reconsidered: the draft refused the summary, so I re-routed to compose it freely instead.'
          : s.to === 'gap-retrieve' ? 'Reconsidered: rather than just retrying harder, I went back for what the question still hadn’t covered' + (s.reason ? ' (' + s.reason.replace(/^uncovered:\s*/, '') + ')' : '') + '.'
          : s.to === 'question-about-silence' ? 'Reconsidered: the draft answered nothing on the page, so I read it as a question the document doesn’t address.'
          : 'Reconsidered the plan: ' + s.from + ' → ' + s.to + '.');
        break;
      case 'confirm':
        // CONFIRM/DENY: each proposition and the graph's verdict on it.
        for (const c of (s.checks || [])) {
          const prop = c.subject + (c.negated ? ' is not ' : ' is ') + c.predicate;
          push(c.verdict === 'confirmed' ? 'Checked “' + prop + '” against the graph: the page itself asserts it.'
            : c.verdict === 'contradicted' ? 'Checked “' + prop + '” against the graph: the page asserts the opposite.'
            : c.verdict === 'confirmed-by-absence' ? 'Checked “' + prop + '” against the graph: a full scan of the events found nothing to the contrary — absence attested with a receipt.'
            : c.verdict === 'denied-by-absence' ? 'Checked “' + prop + '” against the graph: a full scan of the events found no support for it.'
            : 'Checked “' + prop + '” against the graph: the page never asserts it either way.');
        }
        break;
      case 'retract':
        // A SEG against the system's own utterance: an earlier reply asserted
        // what the graph-check now fails to support.
        push('Retracted an earlier claim of mine — I had said “' + (s.claim || '') + '”, and the graph-check doesn’t support it. The old reply re-enters history flagged as retracted.');
        break;
      case 'opaque':
        // The void applied to the system itself: an honest edge-of-trace line.
        push(s.note || 'Part of this answer leaned on the model’s own reasoning, across a gap the trace can’t fully show.');
        break;
      case 'error':
        push('Hit a problem' + (s.where ? ' (' + s.where + ')' : '') + ': ' + (s.message || 'unknown') + '.');
        break;
    }
  }
  const f = turn.final;
  if (f && f.engine) {
    const modelName = (turn.model && turn.model.name) || 'the local model';
    push(/stopped/.test(f.engine) ? 'Stopped — you interrupted the reply before it finished.'
      : /mechanical/.test(f.engine) ? 'Final answer: the document’s exact mechanical reading.'
      : /flag/.test(f.engine) ? 'Final answer: phrased by ' + modelName + ', kept but flagged — the page’s exact mechanical reading is one click away.'
      : /caveat/.test(f.engine) ? 'Final answer: the model’s phrasing, kept with unverified terms struck and citations bound.'
      : /model/.test(f.engine) ? 'Final answer: phrased by ' + modelName + ', with citations bound to the document.'
      : 'Final answer: ' + f.engine + '.');
  }
  return out;
}
function ThinkingBlock({ auditId }) {
  const [, force] = React.useReducer(x => x + 1, 0);
  const [open, setOpen] = React.useState(null);   // null = auto (open live, closed once done); sticky once clicked
  const [rawOpen, setRawOpen] = React.useState(false);   // the verbatim prompt/response disclosure
  const A = (typeof window !== 'undefined') ? window.EOAudit : null;
  const turn = (A && auditId) ? A.all().find(t => t.id === auditId) : null;
  const live = !!(turn && !turn.done);
  React.useEffect(() => {
    if (!A || !live) return;                        // only subscribe while the turn streams
    return A.subscribe(() => force());
  }, [A, auditId, live]);
  if (!A || !auditId || !turn || !turn.steps || !turn.steps.length) return null;
  const lines = narrateTurn(turn);
  // Every model call recorded on this turn (shape pass, answer pass, any retry),
  // kept verbatim by the audit recorder — system + user prompt and raw output.
  const llmCalls = (turn.steps || []).filter(s => s.t === 'llm' && ((s.messages && s.messages.length) || s.system || s.output));
  if (!lines.length && !llmCalls.length) return null;
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
          {llmCalls.length > 0 && (
            <div className="think-raw">
              <button type="button" className="raw-toggle" aria-expanded={rawOpen} onClick={() => setRawOpen(o => !o)}>
                <Icon name="expand" size={12} className="raw-ico" />
                {rawOpen ? 'Hide the full prompt & response' : 'Show the full prompt & response'}
              </button>
              {rawOpen && llmCalls.map((s, i) => (
                <div key={i} className="raw-call">
                  <div className="raw-h">
                    {(s.mode || 'call') + (s.task ? ' · ' + s.task : '')}
                    {s.params && s.params.max_tokens != null ? ' · max ' + s.params.max_tokens + ' tok' : ''}
                    {s.params && s.params.temperature != null ? ' · temp ' + s.params.temperature : ''}
                  </div>
                  {(s.messages && s.messages.length
                    ? s.messages
                    : (s.system ? [{ role: 'system', content: s.system }] : [])
                  ).map((m, j) => (
                    <React.Fragment key={j}>
                      <div className="raw-role">{m.role}</div>
                      <pre className="raw-pre">{m.content}</pre>
                    </React.Fragment>
                  ))}
                  <div className="raw-role out">response{s.error ? ' (error)' : ''}</div>
                  <pre className="raw-pre">{s.error ? s.error : (s.output || '∅')}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── "Exact mechanical reading" disclosure ────────────────────────────────
   The deterministic reading (the cast-list count, the best mechanical answer)
   no longer fronts a document answer — the model phrases it with citations —
   but it stays one click away here, so the grounded count is never lost, just
   demoted. Same collapsible shape as the thinking block. */
function MechanicalReading({ data, onCite }) {
  const [open, setOpen] = React.useState(false);
  if (!data || !data.text) return null;
  return (
    <div className={'mech' + (open ? ' open' : '')}>
      <button type="button" className="mech-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name="table" size={13} className="mech-ico" />
        <span className="mech-label">Exact mechanical reading</span>
        <Icon name="chevron" size={13} className={'mech-chev' + (open ? ' open' : '')} />
      </button>
      {open && (
        <div className="mech-body">
          {renderAnswer(data.text, onCite)}
          <AuditBadge audit={data.audit} />
        </div>
      )}
    </div>
  );
}

/* ── Per-message render guard ──────────────────────────────────────────────
   A render error inside ONE message (an unexpected audit/marker shape from a
   model draft, a malformed citation, a content edge case) used to throw all
   the way to the app-level ErrorBoundary, which unmounts the whole app — the
   conversation, the open document, everything — and demands a reload. That is
   the "it crashes when I chat" failure: a single bad message takes down the
   page. This boundary contains the blast radius to the one message: the rest
   of the chat and the app keep running, the raw text is still shown (and
   copyable) so the answer isn't lost, and the real error is logged so the
   underlying cause stays diagnosable. `resetKey` (the message's changing
   content) clears the error state so a transient failure mid-stream recovers
   on the next token instead of staying stuck. */
class MessageBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  static getDerivedStateFromProps(props, state) {
    // a new resetKey (content changed) → drop the prior error and try again
    if (state.err && props.resetKey !== state.key) return { err: null, key: props.resetKey };
    if (state.key === undefined) return { key: props.resetKey };
    return null;
  }
  componentDidCatch(err, info) {
    if (window.eoWarn) window.eoWarn('message render', err);
    else if (typeof console !== 'undefined') console.error('[Cleon] message render error', err, info);
  }
  render() {
    if (this.state.err) {
      const raw = this.props.raw;
      return (
        <div className="msg-row asst">
          <div className="msg-asst">
            <div className="asst-head"><span className="asst-av">Cl</span><span className="asst-name">Cleon</span></div>
            {raw
              ? <p style={{ whiteSpace: 'pre-wrap' }}>{String(raw).replace(/\{\{(?:cite|void|infer|absent):[^}]*\}\}/g, '')}</p>
              : <p style={{ opacity: .75 }}>This message couldn’t be displayed.</p>}
            <div className="audit"><span className="audit-chip plain"><span className="seg"><span className="no">–</span>display error — the rest of the chat is unaffected</span></span></div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Message({ msg, onCite, showGrounding }) {
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
              {msg.loadCloud
                // Claude runs over the Anthropic API: nothing downloads, there's no
                // GPU cache, and the load resolves instantly with no progress — so
                // a percentage bar and "downloads once… on your GPU" note would be
                // flatly wrong (and read as "it's downloading the model"). Show a
                // plain connecting state instead, mirroring the model popover.
                ? <React.Fragment>
                    <div className="ml-row"><span className="ml-spin" /> Connecting to {msg.loadName || 'Claude'}…</div>
                    <div className="ml-note">Over the Anthropic API — nothing downloads to your device; your key stays in this browser.</div>
                  </React.Fragment>
                // The on-device CPU model (wllama): it DOES download once and cache,
                // but it runs on the CPU via WebAssembly, not the GPU — so the note
                // says so. The progress bar is the same download progress.
                : msg.loadCpu
                ? <React.Fragment>
                    <div className="ml-row"><span className="ml-spin" /> Loading {msg.loadName || 'on-device model'} on the CPU… <b>{Math.round((msg.loadPct || 0) * 100)}%</b></div>
                    <div className="ml-bar"><div className="ml-fill" style={{ width: Math.round((msg.loadPct || 0) * 100) + '%' }} /></div>
                    {msg.loadText && <div className="ml-status">{msg.loadText}</div>}
                    <div className="ml-note">First time only — runs entirely on your CPU (no GPU needed), downloads once, then cached on your device.</div>
                  </React.Fragment>
                : <React.Fragment>
                    <div className="ml-row"><span className="ml-spin" /> Loading {msg.loadName || 'local model'}… <b>{Math.round((msg.loadPct || 0) * 100)}%</b></div>
                    <div className="ml-bar"><div className="ml-fill" style={{ width: Math.round((msg.loadPct || 0) * 100) + '%' }} /></div>
                    {msg.loadText && <div className="ml-status">{msg.loadText}</div>}
                    <div className="ml-note">First time only — the model downloads once, then runs on your GPU and is cached.</div>
                  </React.Fragment>}
            </div>
          : msg.typing ? <div className="typing"><span /><span /><span /></div>
          : <React.Fragment>
              {msg.interrupted && !(msg.text && String(msg.text).trim())
                ? <p className="stopped-empty">Stopped before any reply.</p>
                : renderAnswer(msg.text, onCite)}
              {/* a user interrupt: the partial above is what streamed before Stop */}
              {msg.interrupted && <div className="stopped-note">⏹ Stopped — you interrupted this reply{(msg.text && String(msg.text).trim()) ? '; the text above is as far as it got' : ''}.</div>}
              {/* a retraction outranks the badge the answer originally earned */}
              {msg.retracted && <div className="retract-note">⊘ Retracted — a later check against the page found a claim here unsupported.</div>}
              {!msg.interrupted && showGrounding !== false && <AuditBadge audit={msg.audit} />}
              {msg.mechanical && <MechanicalReading data={msg.mechanical} onCite={onCite} />}
            </React.Fragment>}
        {msg.enrichment && window.ReferenceCard && <window.ReferenceCard data={msg.enrichment} />}
        {!msg.typing && !msg.loading && (
          <div className="msg-actions">
            <button title="Copy" onClick={() => { try { navigator.clipboard.writeText(String(msg.text).replace(/\{\{(cite|void|infer|absent):[^}]*\}\}/g, '')); } catch (e) { window.eoWarn && window.eoWarn('copy failed', e); } }}><Icon name="copy" size={15} /></button>
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

function Composer({ value, onChange, onSend, onStop, generating, mode, onMode, onAttach, busy, placeholder, sources, addable, onAddSource, onRemoveSource, enrich, onToggleEnrich }) {
  const ref = React.useRef(null);
  React.useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }, [value]);
  const submit = () => { if (value.trim() && !busy) onSend(); };
  // The reference desk is off (proxy cleared) ⇒ no toggle, the chat stays local.
  const canEnrich = !!(window.EOExternal && window.EOExternal.enabled && window.EOExternal.enabled());
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
        {canEnrich && onToggleEnrich && (
          <button type="button" className={'comp-btn enrich' + (enrich ? ' on' : '')} aria-pressed={!!enrich}
            title="Wikipedia enrichment — attach an encyclopaedia + dictionary card to your message. Sends the looked-up term (not the document) to Wikipedia & Wiktionary through the proxy."
            onClick={onToggleEnrich}>
            <Icon name="book" size={15} /> Wikipedia
          </button>
        )}
        <div className="comp-spacer" />
        {generating
          ? <button className="send-btn stop" aria-label="Stop generating" title="Stop generating" onClick={onStop}><Icon name="stop" size={15} /></button>
          : <button className="send-btn" aria-label="Send message" disabled={!value.trim() || busy} onClick={submit}><Icon name="send" size={16} /></button>}
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

function ChatPane({ messages, onCite, composerProps, narrow, wide, onExportPrompts, showGrounding }) {
  const streamRef = React.useRef(null);
  React.useEffect(() => { const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  // Only offer the export once a turn has actually been recorded.
  const hasTurns = !!(window.EOAudit && window.EOAudit.count && window.EOAudit.count() > 0);
  return (
    <div className={'pane-chat' + (narrow ? ' narrow' : '') + (wide ? ' wide' : '')} style={{ flex: 1, minHeight: 0 }}>
      <div className="chat-stream" ref={streamRef}>
        <div className="chat-inner">{messages.map((m, i) => (
          <MessageBoundary key={i}
            resetKey={(m.text ? m.text.length : 0) + ':' + (m.streaming ? 1 : 0) + ':' + (m.typing ? 1 : 0) + ':' + (m.loading ? 1 : 0) + ':' + (m.audit ? 1 : 0)}
            raw={m.role === 'assistant' ? m.text : null}>
            <Message msg={m} onCite={onCite} showGrounding={showGrounding} />
          </MessageBoundary>
        ))}</div>
      </div>
      <div className="composer-wrap">
        <div className="composer"><Composer {...composerProps} placeholder={narrow ? 'Ask about this document…' : 'Message Cleon…'} /></div>
        <div className="composer-hint">
          <span>Runs locally · <b>{composerProps.mode}</b> mode{composerProps.enrich ? <span> · chatting with <b>Wikipedia</b></span> : null}</span>
          {onExportPrompts && hasTurns && (
            <button type="button" className="export-prompts" onClick={onExportPrompts}>
              <Icon name="expand" size={12} /> Export prompts (JSON)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ChatPane, Hero, Composer, Message, MessageBoundary, AuditBadge, MechanicalReading, renderAnswer, ThinkingBlock, narrateTurn });
