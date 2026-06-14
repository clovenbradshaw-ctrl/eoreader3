/* ============================================================
   Prompt-flow dashboard (PromptFlowDrawer).

   A glass box over the TALKER: how a user turn becomes (or doesn't become) a
   model call, and what prompt the model sees when it does. Everything it draws
   comes from window.EOPromptFlow.snapshot() — whose prompt strings are read
   LIVE from llm.js — so editing a prompt in the code changes this view with no
   edit here. The companion prose map is docs/prompt-flows.md.

   Four tabs:
     • Flow      — the dispatcher cascade → the chosen flow → its call pipeline
                   (the "how prompts are triggered" spine), with the live prompt
                   inspector inline.
     • Prompts   — the live system-prompt inventory + conditional variants + the
                   live assembly parameters.
     • Shape pass— the editor's director's-note: its live prompt, where its note
                   lands in the NEXT prompt, and — for the CURRENT model — whether
                   that note is actually fed to the model or skipped, and why.
     • Activity  — what actually fired, read from the glass box (read-only).

   Reads window.EOPromptFlow (+ window.EOAudit through it). Renders nothing the
   registry didn't derive. */

// One pill that says whether a prompt/value is read live from the code or is a
// declared (hand-maintained, test-pinned) fact. The whole dashboard's honesty
// hinges on this distinction, so it is always visible.
function PfLiveTag({ live }) {
  return live === false
    ? <span className="pf-tag pf-tag-declared" title="Declared here and pinned by tests/promptflow.test.js — not read live (it lives as an inline literal in app.jsx).">declared</span>
    : <span className="pf-tag pf-tag-live" title="Read live from llm.js at render time — edit the prompt and this updates automatically.">live</span>;
}

// A system prompt, rendered. Source + live/declared badge, the verbatim text,
// any conditional variants shown as the lines they ADD over the base, and copy.
function PfPrompt({ p, onToast, defaultOpen }) {
  const [open, setOpen] = React.useState(defaultOpen !== false);
  if (!p) return null;
  const copy = (text, label) => {
    try { navigator.clipboard && navigator.clipboard.writeText(text); onToast && onToast((label || 'Prompt') + ' copied'); }
    catch (e) { onToast && onToast('Copy unavailable'); }
  };
  const bad = p.live !== false && (!p.ok || !p.text);
  return (
    <div className={'pf-prompt' + (bad ? ' pf-prompt-bad' : '')}>
      <div className="pf-prompt-head" onClick={() => setOpen(o => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="pf-prompt-role" title={'role: ' + p.role}>{p.role === 'system-append' ? 'append' : p.role}</span>
        <b className="pf-prompt-label">{p.label}</b>
        <PfLiveTag live={p.live} />
        <span className="pf-prompt-src">{p.source}</span>
        <span className="pf-spacer" />
        {p.text ? <button className="pf-mini" onClick={e => { e.stopPropagation(); copy(p.text, p.label); }} title="Copy prompt text"><Icon name="copy" size={13} /></button> : null}
      </div>
      {p.blurb && <div className="pf-prompt-blurb">{p.blurb}</div>}
      {open && (
        bad
          ? <div className="pf-warn">Could not read this prompt live{p.why ? ' — ' + p.why : ''}.</div>
          : <pre className="pf-pre">{p.text}</pre>
      )}
      {open && (p.variants || []).map(v => (
        <div className="pf-variant" key={v.id}>
          <div className="pf-variant-head">
            <span className="pf-plus">+</span><b>{v.label}</b>
            <span className="pf-when">when {v.when}</span>
          </div>
          {v.blurb && <div className="pf-prompt-blurb pf-variant-blurb">{v.blurb}</div>}
          {v.ok && Array.isArray(v.added) && v.added.length
            ? <pre className="pf-pre pf-pre-add">{v.added.join('\n')}</pre>
            : <div className="pf-warn">{v.ok ? 'Adds nothing over the base — the conditional may have moved (drift).' : 'Did not resolve' + (v.why ? ' — ' + v.why : '') + '.'}</div>}
        </div>
      ))}
    </div>
  );
}

// One call in a flow's pipeline — a model call (or, for the shape pass, a
// conditional one) shown as a node. `shape` carries the live fed/skipped verdict.
function PfCallNode({ call, shape, promptsById, onPick }) {
  const isShape = call.id === 'shape';
  const active = isShape && shape ? shape.gating.active : null;
  const cls = 'pf-call' + (isShape ? ' pf-call-shape' : '') + (active === false ? ' pf-call-off' : '');
  return (
    <div className={cls}>
      <div className="pf-call-top">
        <b>{call.label}</b>
        {isShape && active === false && <span className="pf-badge pf-badge-off">skipped now</span>}
        {isShape && active === true && <span className="pf-badge pf-badge-on">fed in</span>}
        {isShape && active == null && <span className="pf-badge">conditional</span>}
      </div>
      {call.prompt
        ? <button className="pf-call-prompt" onClick={() => onPick && onPick(call.prompt)} title="Show this prompt">{(promptsById[call.prompt] || {}).label || call.prompt}</button>
        : <span className="pf-call-prompt pf-call-prompt-none">{call.note || 'assembled inline'}</span>}
      {call.conditional && <div className="pf-call-cond">only: {call.conditional}</div>}
      {call.prompt && call.note && <div className="pf-call-note">{call.note}</div>}
    </div>
  );
}

// The selected flow: how it is reached, its model-call pipeline, the live
// prompt, and the veto lanes that can redirect it.
function PfFlowDetail({ flow, snap, onToast }) {
  const [pick, setPick] = React.useState(null);
  const promptsById = {}; for (const p of snap.prompts) promptsById[p.id] = p;
  const vetoById = {}; for (const v of snap.vetoes) vetoById[v.id] = v;
  React.useEffect(() => { setPick(null); }, [flow && flow.id]);
  if (!flow) return null;
  const shown = pick ? promptsById[pick] : null;
  return (
    <div className="pf-flowdetail">
      <div className="pf-flowdetail-head">
        <span className={'pf-kind pf-kind-' + flow.kind}>{flow.kind === 'no-llm' ? 'no model' : flow.kind}</span>
        <h3>{flow.label}</h3>
        <code className="pf-runner">{flow.runner}</code>
      </div>
      <div className="pf-reached"><span className="pf-k">reached when</span> {flow.reachedWhen}</div>
      {flow.blurb && <p className="pf-flow-blurb">{flow.blurb}</p>}

      <div className="pf-k pf-section-k">model-call pipeline</div>
      {flow.calls.length === 0
        ? <div className="pf-nocall"><Icon name="check" size={14} /> Zero model calls — the answer is produced mechanically. The model only ever phrases; here it doesn't even do that.</div>
        : (
          <div className="pf-pipeline">
            <div className="pf-pipe-node pf-pipe-in">user turn</div>
            {flow.calls.map((c, i) => (
              <React.Fragment key={c.id}>
                <span className="pf-arrow">→</span>
                <PfCallNode call={c} shape={c.id === 'shape' ? snap.shape : null} promptsById={promptsById} onPick={setPick} />
              </React.Fragment>
            ))}
            <span className="pf-arrow">→</span>
            <div className="pf-pipe-node pf-pipe-out">settle / veto</div>
          </div>
        )}

      {shown && <div className="pf-picked"><PfPrompt p={shown} onToast={onToast} /></div>}

      <div className="pf-k pf-section-k">veto / salvage lanes <span className="pf-dim">(first match settles the turn)</span></div>
      {flow.vetoes.length === 0
        ? <div className="pf-dim pf-pad">None — this flow streams straight through.</div>
        : (
          <ul className="pf-vetoes">
            {flow.vetoes.map(id => {
              const v = vetoById[id];
              return <li key={id} className={v && v.dominant ? 'pf-veto-dom' : ''}>
                <b>{v ? v.label : id}</b>{v && <span className="pf-veto-on"> → {v.onMatch}</span>}
              </li>;
            })}
          </ul>
        )}
    </div>
  );
}

// The dispatcher cascade — an ordered ladder, first match wins. Clicking a row
// selects the flow it routes to.
function PfCascade({ snap, sel, onSel }) {
  return (
    <div className="pf-cascade">
      <div className="pf-cascade-lead"><span className="pf-pipe-node pf-pipe-in">user turn</span><span className="pf-dim"> enters the dispatcher — first match wins, all later checks skipped</span></div>
      {snap.dispatcher.map(b => {
        const on = b.flow === sel;
        const real = b.flow && b.flow[0] !== '(';
        return (
          <button key={b.n} className={'pf-rung' + (on ? ' on' : '') + (real ? '' : ' pf-rung-router')} onClick={() => real && onSel(b.flow)} disabled={!real}>
            <span className="pf-rung-n">{b.n}</span>
            <span className="pf-rung-main">
              <b>{b.label}</b>
              <span className="pf-rung-pred">{b.predicate}</span>
            </span>
            <span className="pf-rung-arrow">→</span>
            <span className={'pf-flowchip pf-flowchip-' + (real ? 'real' : 'router')}>{b.flow}</span>
          </button>
        );
      })}
    </div>
  );
}

// The Flow tab: the cascade + the selected flow's detail, plus the routeTurn
// reason table (the verdict the cost-ordered router returns for an open doc).
function PfFlowTab({ snap, sel, onSel, onToast }) {
  const flow = snap.flows.find(f => f.id === sel) || snap.flows[0];
  const [showRouter, setShowRouter] = React.useState(false);
  return (
    <div className="pf-cols">
      <div className="pf-col-left">
        <PfCascade snap={snap} sel={sel} onSel={onSel} />
        <button className="pf-disclose" onClick={() => setShowRouter(s => !s)}>
          <Icon name={showRouter ? 'chevron-down' : 'chevron-right'} size={13} /> routeTurn verdicts (branch #6, open doc)
        </button>
        {showRouter && (
          <table className="pf-routetable">
            <thead><tr><th>reason</th><th>decision</th></tr></thead>
            <tbody>{snap.routing.map(r => (
              <tr key={r.reason}><td><code>{r.reason}</code><div className="pf-route-pred">{r.predicate}</div></td><td><span className={'pf-dec pf-dec-' + r.decision}>{r.decision}</span></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="pf-col-right">
        <PfFlowDetail flow={flow} snap={snap} onToast={onToast} />
      </div>
    </div>
  );
}

// The Prompts tab: the full live inventory + assembly parameters.
function PfPromptsTab({ snap, onToast }) {
  return (
    <div className="pf-prompts-tab">
      <p className="pf-lead">Every system prompt the talker can send. Text is read live from <code>llm.js</code> — edit a prompt there and it changes here. Two addenda live as literals in <code>app.jsx</code> and are marked <em>declared</em>.</p>
      {snap.prompts.map(p => <PfPrompt key={p.id} p={p} onToast={onToast} defaultOpen={p.role === 'system'} />)}
      <div className="pf-k pf-section-k">assembly parameters</div>
      <div className="pf-params">
        {snap.params.map(par => (
          <div className="pf-param" key={par.id}>
            <div className="pf-param-v">{par.value == null ? '—' : par.value}{par.unit ? <span className="pf-param-u"> {par.unit}</span> : null}</div>
            <div className="pf-param-l">{par.label} <PfLiveTag live={par.live} /></div>
            {par.note && <div className="pf-param-n">{par.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// The Shape pass tab — the user's headline question: is the director's note
// actually fed to the model, for the model selected right now?
function PfShapeTab({ snap, mlcKey, modelReady, onToast }) {
  const sh = snap.shape;
  const g = sh.gating;
  // active (tier-based) AND a model is loaded ⇒ the note is genuinely sent.
  const verdict = g.active == null ? 'unknown' : (g.active ? (modelReady ? 'fed' : 'fed-when-loaded') : 'skipped');
  const V = {
    fed: { cls: 'on', icon: 'check', head: 'Fed to the model', sub: 'On this model the shape pass runs as a first call, and its note is injected into the answer pass’s user message.' },
    'fed-when-loaded': { cls: 'wait', icon: 'activity', head: 'Will be fed — once a model is loaded', sub: 'This model’s tier keeps the shape pass; no call fires at all until the model finishes loading.' },
    skipped: { cls: 'off', icon: 'x', head: 'NOT fed — skipped on this model', sub: 'The small tier skips the shape pass entirely and takes the join-only path instead.' },
    unknown: { cls: 'unk', icon: 'info', head: 'Indeterminate', sub: 'No model is selected, so the tier — and therefore the verdict — can’t be read.' },
  }[verdict];
  return (
    <div className="pf-shape-tab">
      <div className={'pf-verdict pf-verdict-' + V.cls}>
        <Icon name={V.icon} size={20} />
        <div className="pf-verdict-txt">
          <div className="pf-verdict-head">Shape pass: {V.head}</div>
          <div className="pf-verdict-sub">{V.sub}</div>
          <div className="pf-verdict-meta">
            model <code>{g.model || '(none selected)'}</code> · tier <b className={'pf-tier pf-tier-' + (g.tier || 'unknown')}>{g.tier || 'unknown'}</b>
            {g.tier != null && <span className="pf-dim"> · verdict from <code>EOLLM.modelTier()</code>, live</span>}
          </div>
        </div>
      </div>

      <p className="pf-lead">Before Cleo answers a grounded turn, an <b>editor</b> hands it a one-breath director’s note — what the user is after, what register fits, what a bad answer looks like. It is a <b>separate model call</b>; its note then rides into the <b>next</b> prompt. It never answers and never states document facts.</p>

      <div className="pf-twocall">
        <div className={'pf-tc pf-tc-shape' + (g.active === false ? ' pf-tc-off' : '')}>
          <div className="pf-tc-h"><span className="pf-tc-n">1</span> Shape pass {g.active === false ? <span className="pf-badge pf-badge-off">skipped</span> : <span className="pf-badge pf-badge-on">runs</span>}</div>
          <div className="pf-tc-b">system = <b>SHAPE_SYSTEM</b><br />sees the question, recent turns, doc title — <i>never</i> the spans/notes<br />→ produces an editor’s note</div>
        </div>
        <span className="pf-tc-arrow" title="the note becomes input to the answer pass">note ↓</span>
        <div className="pf-tc pf-tc-answer">
          <div className="pf-tc-h"><span className="pf-tc-n">2</span> Answer pass</div>
          <div className="pf-tc-b">system = <b>grounded</b><br />user message = spans + notes + <b>the editor’s note (last)</b><br />→ the grounded answer</div>
        </div>
      </div>

      <div className="pf-k pf-section-k">the editor’s prompt <PfLiveTag live={sh.system.live} /></div>
      <pre className="pf-pre">{sh.system.text}</pre>

      <div className="pf-k pf-section-k">where the note lands in the NEXT prompt <span className="pf-dim">(live sample from <code>buildUserContent</code>)</span></div>
      <p className="pf-dim pf-pad">This is a real answer-pass user message built with a sample note. When the shape pass is active, this is the proof it is fed in — the note sits last, just before the question:</p>
      <pre className="pf-pre pf-pre-sample">{renderSample(sh.lands)}</pre>

      <div className="pf-k pf-section-k">when the note is NOT fed in</div>
      <div className="pf-meaning">{g.whenInactive}</div>
      <ul className="pf-skips">
        {g.skipReasons.map(r => (
          <li key={r.id} className={g.tier === 'small' && r.id === 'small-tier' ? 'pf-skip-now' : ''}>
            <b>{r.when}</b> <span className="pf-skip-src">{r.source}</span>
            <div className="pf-skip-mean">{r.meaning}</div>
          </li>
        ))}
      </ul>

      <div className="pf-shape-usage">
        <div><span className="pf-k">used by</span> {g.usedBy.join('; ')}</div>
        <div><span className="pf-k">never used by</span> {g.skippedBy.join('')}</div>
      </div>
    </div>
  );
}

// Highlight the editor's-note block inside the sample user message so the eye
// lands on exactly the part the shape pass injects.
function renderSample(lands) {
  const text = lands.sampleUserMessage || '';
  const i = text.indexOf(lands.noteMarker);
  if (i < 0) return text;
  // mark from the note marker to the trailing "Answer the user's question"
  const end = text.indexOf('Answer the user', i);
  const cut = end > i ? end : text.length;
  return [
    text.slice(0, i),
    React.createElement('mark', { key: 'm', className: 'pf-mark' }, text.slice(i, cut)),
    text.slice(cut),
  ];
}

// The Activity tab — what actually fired, from the glass box (read-only).
function PfActivityTab({ snap }) {
  const a = snap.activity;
  if (!a.available || !a.turns.length) {
    return <div className="pf-empty">
      <Icon name="activity" size={22} />
      <p>No recorded turns yet. The dashboard above shows what <i>can</i> fire; this tab shows what <i>did</i>.</p>
      <p className="pf-dim">Chat with a document (with the glass box recording) and each turn’s real path, prompts, and shape-pass status appear here.</p>
    </div>;
  }
  return (
    <div className="pf-activity">
      <p className="pf-lead">The last {a.turns.length} turns, read from the glass box — the flow each actually took and the model calls it actually made.</p>
      {a.turns.map(t => (
        <div className="pf-act" key={t.id}>
          <div className="pf-act-head">
            <span className={'pf-flowchip pf-flowchip-real'}>{t.path || '—'}</span>
            {t.reason && <code className="pf-act-reason">{t.reason}</code>}
            <span className="pf-spacer" />
            <span className="pf-dim">{t.id}</span>
          </div>
          <div className="pf-act-calls">
            {t.shape && (t.shape.skipped
              ? <span className="pf-act-call pf-act-call-off">shape · skipped{t.shape.tier ? ' (' + t.shape.tier + ')' : ''}</span>
              : <span className="pf-act-call pf-act-call-shape">shape{t.shape.hasNote ? ' · note' : ' · empty'}</span>)}
            {t.llmCalls.length
              ? t.llmCalls.map((c, i) => <span key={i} className="pf-act-call">{c.skipped ? 'skipped' : c.mode}{c.systemChars != null ? ' · sys ' + c.systemChars + 'c' : ''}</span>)
              : <span className="pf-act-call pf-act-call-mech">no model call (mechanical)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Drift banner — the runtime guard that "tied to the actual structure" still
// holds. Silent when clean.
function PfDrift({ drift }) {
  if (!drift || (drift.ok && !drift.issues.length)) return null;
  const errs = drift.issues.filter(i => i.level === 'error');
  const warns = drift.issues.filter(i => i.level !== 'error');
  return (
    <div className={'pf-driftbar' + (errs.length ? ' pf-driftbar-err' : '')}>
      <Icon name={errs.length ? 'alert' : 'info'} size={15} />
      <div>
        <b>{errs.length ? 'Prompt structure drift' : 'Heads up'}:</b>{' '}
        {[...errs, ...warns].slice(0, 4).map((i, n) => <span key={n} className="pf-drift-i">{i.msg}</span>)}
        {drift.issues.length > 4 && <span className="pf-dim"> +{drift.issues.length - 4} more</span>}
      </div>
    </div>
  );
}

function PromptFlowDrawer({ onClose, onToast, mlcKey, modelReady }) {
  const dialogRef = window.useDialog(onClose);
  const [tab, setTab] = React.useState('flow');
  const [sel, setSel] = React.useState('grounded-llm');
  const [nonce, setNonce] = React.useState(0);
  // Re-snapshot on open, on model change, on tab change (Activity needs fresh
  // audit reads), and on manual refresh. The snapshot is pure string work —
  // cheap enough to rebuild freely, which is what keeps it live.
  const snap = React.useMemo(
    () => (window.EOPromptFlow ? window.EOPromptFlow.snapshot({ mlcKey }) : null),
    [mlcKey, tab, nonce]
  );

  const body = () => {
    if (!snap) return <div className="pf-empty"><Icon name="alert" size={22} /><p>The prompt registry (window.EOPromptFlow) isn’t loaded.</p></div>;
    if (tab === 'flow') return <PfFlowTab snap={snap} sel={sel} onSel={setSel} onToast={onToast} />;
    if (tab === 'prompts') return <PfPromptsTab snap={snap} onToast={onToast} />;
    if (tab === 'shape') return <PfShapeTab snap={snap} mlcKey={mlcKey} modelReady={modelReady} onToast={onToast} />;
    if (tab === 'activity') return <PfActivityTab snap={snap} />;
    return null;
  };
  const actCount = snap && snap.activity.available ? snap.activity.turns.length : 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer pf-drawer" role="dialog" aria-modal="true" aria-label="Prompt flow"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Prompt flow</h2>
            <button className="pf-mini" onClick={() => setNonce(n => n + 1)} title="Re-read the prompts live"><Icon name="refresh" size={14} /></button>
            <button className="x" onClick={onClose} aria-label="Close prompt flow"><Icon name="x" size={18} /></button>
          </div>
          <p>How a turn becomes a model call, and the prompt it sees — read live from the code. The map updates itself when the prompts change.</p>
        </div>
        <div className="drawer-tabs">
          <button className={'drawer-tab' + (tab === 'flow' ? ' on' : '')} onClick={() => setTab('flow')}>Flow</button>
          <button className={'drawer-tab' + (tab === 'prompts' ? ' on' : '')} onClick={() => setTab('prompts')}>Prompts{snap ? ' · ' + snap.prompts.length : ''}</button>
          <button className={'drawer-tab' + (tab === 'shape' ? ' on' : '')} onClick={() => setTab('shape')} title="Is the shape/editor prompt actually fed to the model?">Shape pass</button>
          <button className={'drawer-tab' + (tab === 'activity' ? ' on' : '')} onClick={() => setTab('activity')}>Activity{actCount ? ' · ' + actCount : ''}</button>
        </div>
        <div className="drawer-body pf-body">
          {snap && <PfDrift drift={snap.drift} />}
          {body()}
        </div>
      </div>
    </div>
  );
}

window.PromptFlowDrawer = PromptFlowDrawer;
