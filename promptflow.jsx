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
     • Shape pass— the DISSOLVED shape pass: its three jobs and who now holds
                   each (move → router, form → a per-genre centroid measured on
                   the output, confidence → the witness stamp), and proof the
                   talker writes voice-only (no form in the prompt at all).
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

// The Shape pass tab — the headline is now that the shape pass is DISSOLVED.
// There is no blind per-turn model call deciding how to answer; its three jobs
// went to the three things that own them: move → router, form → a per-genre
// centroid measured on the OUTPUT (a stamp, never in the prompt), confidence →
// the witness stamp. This renders those holders and proves the form is NOT in
// the prompt (the answer-pass message is voice-only).
function PfShapeTab({ snap }) {
  const sh = snap.shape;
  return (
    <div className="pf-shape-tab">
      <div className="pf-verdict pf-verdict-off">
        <Icon name="x" size={20} />
        <div className="pf-verdict-txt">
          <div className="pf-verdict-head">Shape pass: dissolved</div>
          <div className="pf-verdict-sub">No blind per-turn model call decides how to answer. The three jobs the old editor welded together were split out to the three things that can actually do them.</div>
        </div>
      </div>

      <p className="pf-lead">The old shape pass was an editor model that — seeing the title but never the spans — emitted a note mixing three jobs, leaking world knowledge and confidence into a paragraph meant to be about layout. It is <b>dissolved</b>. The FORM is not handed to the talker either: it is a per-genre centroid the OUTPUT is measured against, after — a stamp, the same shape as the witness degree.</p>

      <div className="pf-twocall">
        {[['MOVE', sh.move], ['FORM', sh.form], ['CONFIDENCE', sh.confidence]].map(([k, h]) => (
          <div key={k} className="pf-tc">
            <div className="pf-tc-h">{k} → <b>{h.holder}</b></div>
            <div className="pf-tc-b"><code>{h.source}</code><br />{h.note}</div>
          </div>
        ))}
      </div>

      <div className="pf-k pf-section-k">the talker writes VOICE-ONLY <PfLiveTag live={sh.lands.live} /> <span className="pf-dim">(live sample from <code>buildUserContent</code>)</span></div>
      <p className="pf-dim pf-pad">A real answer-pass user message: there is no how-to-answer block in it. The form never enters the prompt — it is measured on the output afterward, and the centroid is never unfolded into words:</p>
      <pre className="pf-pre pf-pre-sample">{renderSample(sh.lands)}</pre>
    </div>
  );
}

// Highlight a marker block inside the sample user message, when there is one.
// Brief 2 patch: the answer-pass message is voice-only, so there is no marker —
// the sample renders plain, which is the proof.
function renderSample(lands) {
  const text = lands.sampleUserMessage || '';
  if (!lands.noteMarker) return text;
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
            {t.shape && <span className="pf-act-call pf-act-call-shape">form{t.shape.move ? ' · ' + t.shape.move : ''}{t.shape.generated === false ? ' · looked up' : ''}</span>}
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
    if (tab === 'shape') return <PfShapeTab snap={snap} />;
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
          <button className={'drawer-tab' + (tab === 'shape' ? ' on' : '')} onClick={() => setTab('shape')} title="The dissolved shape pass: move → router, form → library, confidence → stamp">Shape pass</button>
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
