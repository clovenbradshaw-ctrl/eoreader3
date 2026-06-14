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
// citations collapse to their [sN] label, voids to ⟨term⟩, absence
// attestations to [⊥] (the receipt lives in the chat chip's tooltip).
function stripForView(s) {
  return String(s == null ? '' : s)
    .replace(/\{\{cite:([^}]*)\}\}/g, (m, b) => { const p = b.split(':'); return p[2] ? ' [' + p[2] + ']' : ''; })
    .replace(/\{\{infer:([^}]*)\}\}/g, (m, b) => { const p = b.split(':'); return p[2] ? ' ⟦' + p[2] + '⟧' : ''; })
    .replace(/\{\{void:([^}]*)\}\}/g, '⟨$1⟩')
    .replace(/\{\{absent:[^}]*\}\}/g, ' [⊥]')
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
  if (s.t === 'calculation') return (
    <Line label="calc" kind="answer">
      <code className="aud-calc">{s.shown} = {s.display}</code>
      {(s.operands && s.operands.length)
        ? <span className="aud-dim"> · {s.operands.map(op => op.raw + (op.cite ? ' (s' + op.cite.idx + ')' : '')).join(', ')}</span>
        : null}
    </Line>
  );
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
    <Line label={s.round ? 'seek ·' + s.round : 'retrieve'} kind="retrieve">
      <div className="aud-dim">k={s.k}{s.task ? ' · ' + s.task : ''} · {(s.hits || []).length} hits{s.engine ? ' · ' + s.engine : ''}{s.round ? ' · round ' + s.round : ''}{s.novelty != null ? ' · novelty ' + s.novelty : ''}{s.covered ? ' · covers ' + s.covered : ''}{s.skipped ? ' · stopped' : ''}</div>
      {s.subquery ? <div className="aud-dim">⟲ sought: {s.subquery}</div> : null}
      {(s.unseekable && s.unseekable.length) ? <div className="aud-dim">⊘ unseekable (nowhere in the sources): <span className="aud-void">{s.unseekable.join(', ')}</span></div> : null}
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
  if (s.t === 'shape') return (
    <Line label="shape" kind="intent">
      {s.skipped
        ? <span className="aud-dim">skipped{s.tier ? ' (' + s.tier + ' tier)' : ''} — {s.reason || 'no shape pass this turn'}</span>
        : s.note ? <span className="aud-dim">“{s.note}”</span> : <span className="aud-dim">no note (shape pass empty or dropped) — answer pass ran bare</span>}
    </Line>
  );
  if (s.t === 'repair') return (
    <Line label="repair" kind="route">
      <b>{s.kind}</b>
      {s.anchor ? <span className="aud-dim"> · repairing: “{s.anchor}”</span> : <span className="aud-dim"> · nothing to re-ask</span>}
      {(s.refinements || []).length ? <div className="aud-dim">refined by: {s.refinements.map(r => '“' + r + '”').join(' · ')}</div> : null}
      {s.probe && <div className="aud-dim">⟲ re-read as: {s.probe}</div>}
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
        {s.filtered != null && (
          <div className="aud-out"><span className="aud-role out">shown</span><pre>{s.filtered || '∅ (entirely think content — fell to the mechanical answer)'}</pre></div>
        )}
      </div>
      {s.ms != null && <span className="aud-dt">{s.ms}ms</span>}
    </div>
  );
  if (s.t === 'compute') return (
    <div className="aud-step">
      <span className="aud-st compute">compute</span>
      <div className="aud-sb">
        <div className="aud-dim">python · pandas{s.durationMs != null ? ' · ' + s.durationMs + 'ms' : ''}{s.ok ? '' : ' · ⚠ error'}{s.truncated ? ' · truncated' : ''}</div>
        <details className="aud-det" open>
          <summary>code run locally</summary>
          <div className="aud-msg"><span className="aud-role">python</span><pre>{s.code || '∅'}</pre></div>
        </details>
        {s.stdout ? <div className="aud-out"><span className="aud-role out">stdout</span><pre>{s.stdout}</pre></div> : null}
        <div className="aud-out"><span className="aud-role out">{s.ok ? 'result' : 'error'}</span><pre>{s.ok ? (s.result || s.stdout || '∅') : (s.stderr || '∅')}</pre></div>
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
      {(s.contradictions || []).map((c, i) => (
        <div key={i} className="aud-dim">⊨ the page asserts “{c.subject} is {c.is}”{c.sent != null ? <span> <span className="aud-cite">s{c.sent}</span></span> : null} · the draft said: <span className="aud-void">{c.claim}</span></div>
      ))}
    </Line>
  );
  if (s.t === 'traverse') return (
    <Line label="traverse" kind="retrieve">
      <span className="aud-dim">hops {s.hops} · from:</span> <b>{(s.entries || []).join(', ')}</b>
      {(s.perDoc || []).map((p, i) => (
        <div key={i}>
          {(p.assertions || []).length ? <div className="aud-dim">asserts: {p.assertions.map((a, j) => <span key={j}>{j ? '; ' : ''}{a.subject} is {a.is}{a.sent != null ? <span> <span className="aud-cite">s{a.sent}</span></span> : null}</span>)}</div> : null}
          {(p.edges || []).length ? <div className="aud-dim">relations: {p.edges.map(e => `${e.a} ${e.verb || '—'} ${e.b}`).join('; ')}</div> : null}
          {(p.walked || []).length ? <div className="aud-dim">walked: {p.walked.map((w, j) => <span key={j}>{j ? ' · ' : ''}{w.name} <span className="aud-score">hop {w.hop}</span> ({w.via})</span>)}</div> : null}
          {(p.evidence || []).map((h, j) => (
            <div key={'e' + j} className="aud-hit"><span className="aud-cite">s{h.idx}</span><span className="aud-hit-t">{h.text}</span><span className="aud-dim"> · via {h.via}</span></div>
          ))}
        </div>
      ))}
    </Line>
  );
  if (s.t === 'working-memory') {
    const hot = s.hot || [], warm = s.warm || [], cold = s.cold || [], recalled = s.recalled || [];
    const rng = (c) => c.range ? ' [s' + c.range[0] + (c.range[1] !== c.range[0] ? '–s' + c.range[1] : '') + ']' : '';
    return (
      <Line label="working memory" kind="ground">
        <span className="aud-dim">depth {s.depth}{s.heatFloor != null ? ' · hot ≥ ' + s.heatFloor : ''}</span>
        <span> · <b>{hot.length}</b> hot · <b>{warm.length}</b> warm · <b>{cold.length}</b> cooled{recalled.length ? <span> · <b>{recalled.length}</b> recalled</span> : null}</span>
        {hot.length ? <div className="aud-dim" style={{ marginTop: 2 }}>hot: {hot.map((h, i) => <span key={i}>{i ? ' · ' : ''}{h.label} <span className="aud-score">{h.heat}</span></span>)}</div> : null}
        {warm.length ? <div className="aud-dim">warm: {warm.map((w, i) => <span key={i}>{i ? ' · ' : ''}{w.label} <span className="aud-score">via {w.via}</span></span>)}</div> : null}
        {cold.length ? <div className="aud-dim">cooled: {cold.map((c, i) => <span key={i}>{i ? ', ' : ''}{c.label}{rng(c)}</span>)}</div> : null}
      </Line>
    );
  }
  if (s.t === 'associate') return (
    <Line label="associate" kind="retrieve">
      <span className="aud-dim">{(s.from || []).join('+')} ⇝ {s.to} · coupling {s.coupling}{s.sim != null ? ' · sim ' + s.sim : ''} · {s.clearedDelta ? <b>cleared δ</b> : 'inert'}</span>
    </Line>
  );
  if (s.t === 'infer') return (
    <Line label="infer" kind="referents">
      <span className="aud-dim">floor {s.floor} · reader-added connection:</span> {(s.pairs || []).map((p, i) => <span key={i}>{i ? ', ' : ' '}<span className="aud-cite">s{p.a}</span>+<span className="aud-cite">s{p.b}</span></span>)}
    </Line>
  );
  if (s.t === 'plan-seg') return (
    <Line label="reconsider" kind="veto">
      <b>{s.from}</b> <span className="aud-dim">→</span> <b>{s.to}</b>
      {s.reason && <span className="aud-dim"> · {s.reason}</span>}
    </Line>
  );
  if (s.t === 'opaque') return (
    <Line label="edge of trace">
      <span className="aud-dim">{s.note || 'phrasing crossed a gap the trace can’t show'}</span>
    </Line>
  );
  if (s.t === 'relation-gate') return (
    <Line label="relation gate" kind="veto">
      <span className="aud-dim">{s.keyed ? <span><b>{s.keyed}</b> claim{s.keyed !== 1 ? 's' : ''} keyed at generation</span> : 'no model-supplied keys'}</span>
      {(s.held || []).length ? <span> · <b>{s.held.length} held</b> <span className="aud-dim">(key unresolved: {s.held.map(h => 's' + h.key).join(', ')})</span></span> : null}
      {(s.mismatches || []).length
        ? (s.mismatches || []).map((m, i) => (
            <div key={i} className="aud-dim">⇋ <b className="aud-void">{m.kind}</b> · the draft said: <span className="aud-void">{m.claim}</span>{m.edge ? <span> · the page holds: {m.edge}{m.sent != null ? <span> <span className="aud-cite">s{m.sent}</span></span> : null}</span> : null}</div>
          ))
        : <span className="aud-dim"> · no relation contradicts its edge</span>}
    </Line>
  );
  if (s.t === 'envelope') return (
    <Line label="envelope" kind="ground">
      <span className="aud-dim">{s.checked} cited claim{s.checked !== 1 ? 's' : ''} measured against {s.checked !== 1 ? 'their' : 'its'} own span{s.checked !== 1 ? 's' : ''}</span>
      <span> · <b>{s.strong || 0}</b> close · <b>{s.impressionistic || 0}</b> impressionistic{s.leaks ? <span> · <b className="aud-void">{s.leaks} leak{s.leaks !== 1 ? 's' : ''}</b></span> : <span> · <b>0</b> leaks</span>}</span>
      {(s.rows || []).filter(r => r.band !== 'strong').map((r, i) => (
        <div key={i} className="aud-dim"><span className="aud-cite">s{r.idx}</span> <span className="aud-score">{r.cos}</span> {r.band === 'leak' ? <span className="aud-void">drifted from its own citation</span> : 'impressionistic, not verbatim'}</div>
      ))}
    </Line>
  );
  if (s.t === 'tier') return (
    <Line label="tier" kind="intent">
      model tier: <b>{s.tier}</b>
      {s.tier === 'small' ? <span className="aud-dim"> · join-only over the mechanical reading (no free composition)</span> : null}
    </Line>
  );
  if (s.t === 'converge') return (
    <Line label="converge" kind="retrieve">
      <span className="aud-dim">round {s.round} · re-retrieved {s.retrieved} on the uncovered gap: </span>
      <span className="aud-void">{(s.uncovered || []).join(', ')}</span>
    </Line>
  );
  if (s.t === 'converge-stop') return (
    <Line label="converged" kind="retrieve">
      stop: <b>{s.stop}</b>
      {(s.residual && s.residual.length) ? <span className="aud-dim"> · residual void: <span className="aud-void">{s.residual.join(', ')}</span></span> : null}
    </Line>
  );
  if (s.t === 'error') return <Line label="error" kind="error"><span className="aud-void">{s.where}: {s.message}</span></Line>;
  return <Line label={s.t}><span className="aud-dim">{JSON.stringify(s)}</span></Line>;
}

// WI-7 — the per-turn truthfulness chip: bound / void / unbound and the witness
// DEGREE. Unbound must be 0 (WI-2/WI-3/WI-4); a non-zero value is the dominant
// term and is shown in alarm. The degree is the fraction of the talker's own
// content that a span witnesses — the graded stamp, not a binary verdict —
// approaching 1 from below, never reaching it while a void stands. Reads
// turn.final.truth (attached by EOAudit.end).
function TruthChip({ truth }) {
  if (!truth) return null;
  // The witness degree is the headline measure; coverage (a count ratio) is the
  // fallback for an older turn recorded before the degree existed.
  const deg = truth.degree != null ? Math.round(truth.degree * 100) + '%'
    : (truth.coverage != null ? Math.round(truth.coverage * 100) + '%' : (truth.covers || '—'));
  return (
    <span className="aud-truth" title={'truthfulness: bound claims / explicit voids / unbound assertions (unbound must be 0); witness degree = '
      + (truth.degree != null ? Math.round(truth.degree * 100) + '% of the answer’s content is witnessed by a span' : 'n/a')}>
      <span className="aud-truth-b">{truth.bound}✓</span>
      {truth.voids ? <span className="aud-truth-v"> {truth.voids}⟨⟩</span> : null}
      <span className={truth.unbound ? 'aud-truth-u bad' : 'aud-truth-u'}> {truth.unbound}⊥</span>
      <span className="aud-truth-c"> · {deg} witnessed</span>
    </span>
  );
}

// WI-7 — the per-session truthfulness instrument. The system approaches
// complete truthfulness from below and must never regress: this is that claim,
// measured. It surfaces three things the rest of the spec keeps invariant:
//   • unbound total — the dominant term; must be 0 (WI-2/WI-3/WI-4).
//   • L1 carry-forward — turns whose model history carried a prior turn's
//     unverified tokens; must be 0 (WI-1).
//   • the witness-degree trace — the approximation, rising toward 1 (the
//     asymptote), shown per turn so you can watch it climb and never silently
//     drop. The session degree is content-weighted: how much of everything the
//     talker has said this session is witnessed by a span.
function TruthSummary({ turns }) {
  const done = (turns || []).filter(t => t.done && t.final && t.final.truth);
  if (!done.length) return null;
  let unbound = 0, voids = 0, bound = 0, wit = 0, contentTot = 0;
  for (const t of done) {
    const tr = t.final.truth;
    unbound += tr.unbound || 0; voids += tr.voids || 0; bound += tr.bound || 0;
    wit += tr.witnessed || 0; contentTot += tr.witnessContent || 0;
  }
  const l1 = (turns || []).reduce((n, t) => n + ((t.l1Violations && t.l1Violations.length) || 0), 0);
  // The per-turn witness degree (the graded stamp), falling back to coverage for
  // turns recorded before the degree existed.
  const degOf = (tr) => (tr.degree != null ? tr.degree : tr.coverage);
  // The session degree is content-weighted (not a mean of means): the share of
  // ALL the talker's content this session that a span witnesses. This is the
  // value that climbs toward the asymptote and must never silently regress.
  const sessionDeg = contentTot ? wit / contentTot : null;
  const honest = unbound === 0 && l1 === 0;
  return (
    <div className={'aud-truth-sum' + (honest ? '' : ' bad')}>
      <div className="aud-truth-sum-head">
        <b>Truthfulness</b>
        <span className="aud-dim"> — witness approaching from below, never regressing</span>
        <span className="aud-grow" />
        <span className={honest ? 'aud-truth-verdict ok' : 'aud-truth-verdict bad'}>{honest ? 'truthful so far ✓' : 'regression ⚠'}</span>
      </div>
      <div className="aud-truth-sum-row">
        <span><b className={unbound ? 'aud-void' : ''}>{unbound}</b> unbound <span className="aud-dim">(must be 0)</span></span>
        <span><b className={l1 ? 'aud-void' : ''}>{l1}</b> L1 carry-forward <span className="aud-dim">(must be 0)</span></span>
        <span><b>{bound}</b> bound · <b>{voids}</b> voids</span>
        {sessionDeg != null && <span>witness <b>{Math.round(sessionDeg * 100)}%</b> <span className="aud-dim">of content this session</span></span>}
      </div>
      {done.length > 1 && (
        <div className="aud-truth-trace" title="per-turn witness degree — the approximation rising toward the asymptote, never reaching 1">
          {done.map((t, i) => {
            const c = degOf(t.final.truth);
            const h = c == null ? 2 : Math.max(2, Math.round(c * 22));
            const u = (t.final.truth.unbound || 0) > 0 || (t.l1Violations && t.l1Violations.length);
            return <span key={i} className={'aud-truth-bar' + (u ? ' bad' : '')} style={{ height: h + 'px' }} title={'turn ' + (i + 1) + (c == null ? '' : ' · ' + Math.round(c * 100) + '% witnessed') + (u ? ' · violation' : '')} />;
          })}
        </div>
      )}
    </div>
  );
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
        {(turn.l1Violations && turn.l1Violations.length)
          ? <span className="aud-badge error" title="a prior non-clean turn carried its unverified tokens into this turn's model history (L1 violation)">⚠ L1</span>
          : null}
        {turn.final && turn.final.truth && <TruthChip truth={turn.final.truth} />}
        {badge}
        {turn.ms != null && <span className="aud-ms">{turn.ms}ms</span>}
      </button>
      {open && (
        <div className="aud-turn-body">
          <div className="aud-meta">
            <span>scope: {(turn.scope && turn.scope.length) ? turn.scope.map(s => s.name).join(', ') : '—'}</span>
            <span>model: {(turn.model && turn.model.name) || '—'}{turn.modelReady === false ? ' (not ready)' : ''}</span>
            {turn.depth != null && <span>depth: {turn.depth}{turn.budget && turn.budget.maxSeekRounds > 1 ? ' · ≤' + turn.budget.maxSeekRounds + ' seek' : ''}{turn.budget && turn.budget.replan ? ' · replan' : ''}</span>}
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
            {snap.assertions.slice(0, 60).map((a, i) => <div key={i} className="graph-assert"><b>{a.subject}</b> is {a.is}</div>)}
            {snap.assertions.length > 60 && <div className="graph-dim">…{snap.assertions.length - 60} more (the full set is in the export)</div>}
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
              {window.EOEngine && window.EOEngine.isTransmutingDef && window.EOEngine.isTransmutingDef(ev) &&
                <span className="graph-tag place" style={{ fontSize: '8px', padding: '0 5px' }}
                      title="transmuting DEF — the significance-layer ‘weak’ law: it changes an established type, not just attach a property">flavor</span>}
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

// The layer ladder: the essay's own falsifiable test, made live. For one prose
// doc it counts the distinguishable binding-laws operative at each EO layer
// (existence → structure → significance) by precondition, and checks the
// predicted 1-2-1 differentiation rate + monotone cumulative count. An
// instrument, not an advertisement: it reports a MISMATCH plainly and never
// shows a hard-wired ✓. Reads window.EOEngine.layerLadder; renders nothing of
// its own physics. Reuses the .graph-* styles.
function LayerLadder({ doc }) {
  const ladder = React.useMemo(
    () => (doc && window.EOEngine && window.EOEngine.layerLadder ? window.EOEngine.layerLadder(doc) : null),
    [doc]);
  if (!doc) return <div className="empty-doc" style={{ padding: 40 }}>No document loaded to graph yet — add a source and its layer ladder shows up here.</div>;
  if (!ladder) return <div className="empty-doc" style={{ padding: 40 }}>This source has no layer ladder (tables and very short texts don’t carry one).</div>;
  const layers = [
    ['existence',    'Existence',    'one law freezes out — confinement, the admission threshold.'],
    ['structure',    'Structure',    'two freeze out, ordered — sign (charge) first, proportion (gravity / δ) built on it.'],
    ['significance', 'Significance', 'one law freezes out — weak, the only law that changes an established type.'],
  ];
  const flag = (ok) => <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: ok ? 'var(--good-fg)' : 'var(--bad-fg)' }}>{ok ? '✓' : '✗'}</span>;
  const total = ladder.cumulative[ladder.cumulative.length - 1];
  return (
    <div className="graph-view">
      <div className="graph-meta">
        <span><b>{total}</b> distinguishable binding-law{total === 1 ? '' : 's'}</span>
        <span>differentiation <b>{ladder.perLayerNew.join(', ')}</b></span>
        <span>predicted <b>{ladder.predicted.join(', ')}</b></span>
      </div>

      {layers.map(([key, label, blurb]) => (
        <div key={key} className="graph-sec">
          <h4>{label} <span className="graph-dim">— {blurb}</span></h4>
          <div className="graph-ents">
            {ladder.laws[key].map((law, i) => (
              <div key={i} className="graph-ent">
                <span className={'graph-tag ' + (law.present ? 'place' : '')} style={law.present ? null : { opacity: 0.55 }}>{law.present ? 'present' : 'absent'}</span>
                <span className="graph-ent-name">{law.name}</span>
                <span className="graph-dim" style={{ marginLeft: 'auto', fontSize: 11, textAlign: 'right' }}>{law.note}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="graph-sec">
        <h4>The essay's test <span className="graph-dim">— is differentiation 1-2-1, and the cumulative count monotone?</span></h4>
        <div className="graph-ents" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
          <div className="graph-ent">
            <span>new laws per layer: <b>{ladder.perLayerNew.join(', ')}</b> (predicted {ladder.predicted.join(', ')})</span>
            <span style={{ marginLeft: 'auto' }}>{flag(ladder.rateMatches)}</span>
          </div>
          <div className="graph-ent">
            <span>cumulative: <b>{ladder.cumulative.join(', ')}</b></span>
            <span style={{ marginLeft: 'auto' }}>{flag(ladder.monotone)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// The Proposals channel — pending convention signals from the proposer.
// Each card: the convention sentence, its evidence spans (resolved LOCALLY —
// anchors carry only hashes; this device's span table maps them back to the
// open documents), current mass, distance to admission, and the one-tap
// verdicts. Confirm mints a 5.0-coupling user anchor (instant admission);
// Reject SEGs the model's anchors (the signal decays below floor).
function ProposalsView({ docs, onToast, onChanged }) {
  const E = window.EOEngine;
  const items = (E && E.pendingProposals) ? E.pendingProposals() : [];
  const byId = new Map((docs || []).map(d => [d.id, d]));
  const spanText = (ev) => {
    const d = ev.docId != null ? byId.get(ev.docId) : null;
    return d && d.sentenceTexts && ev.idx != null ? d.sentenceTexts[ev.idx] : null;
  };
  const verdict = (fn, id, okMsg) => {
    try {
      const r = fn(id);
      onToast && onToast(r && r.status === 'admitted' ? okMsg : (r && r.status === 'rejected' ? 'Proposal rejected — the signal decays.' : 'Recorded.'));
    } catch (e) { onToast && onToast('That verdict failed.'); }
    onChanged && onChanged();
  };
  if (!items.length) return (
    <div className="empty-doc" style={{ padding: 40 }}>
      No convention proposals yet. When the local model is loaded and the reading hits repeated friction
      (a “LABEL:” line bound to no speaker, a separator read as a sentence), it may propose a reading
      convention here — which waits, as a signal, for an independent document or your Confirm.
    </div>
  );
  const statusTag = { signal: 'signal · waiting', admitted: 'admitted', rejected: 'rejected', unmappable: 'unmappable' };
  return (
    <div className="graph-view">
      <div className="graph-meta">
        <span><b>{items.filter(p => p.status === 'signal').length}</b> pending</span>
        <span><b>{items.filter(p => p.status === 'admitted').length}</b> admitted</span>
        <span className="graph-dim">a proposal admits at mass ≥ θ with a non-model witness — the model can never be its own witness</span>
      </div>
      {items.map(p => (
        <div key={p.id} className="graph-sec">
          <h4>
            {p.sentence || p.id}
            <span className="graph-dim"> — {p.register || 'register unstated'}</span>
          </h4>
          <div className="graph-ents">
            <div className="graph-ent">
              <span className={'graph-tag' + (p.status === 'admitted' ? ' place' : '')}>{statusTag[p.status] || p.status}</span>
              <span className="graph-dim" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                mass {p.mass} / θ {p.theta}{p.status === 'signal' ? ' · ' + p.distance + ' to admission' : ''}
                {' · '}{p.witnesses.distinct} witness{p.witnesses.distinct !== 1 ? 'es' : ''}
                {p.witnesses.nonModel ? ' (one independent)' : ' (model only)'}
                {p.visibility > 1 ? ' · proposed ' + p.visibility + '×' : ''}
              </span>
              {p.status === 'signal' && (
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button className="mini-btn primary" onClick={() => verdict(E.confirmProposal, p.id, 'Confirmed — the convention is admitted and now shapes the reading.')}>Confirm</button>
                  <button className="mini-btn" onClick={() => verdict(E.rejectProposal, p.id, '')}>Reject</button>
                </span>
              )}
            </div>
            {(p.evidence || []).map((ev, i) => {
              const t = spanText(ev);
              return (
                <div key={i} className="graph-ent">
                  <span className="aud-cite">{ev.reader === 'llm-proposer' ? 'model' : ev.reader} · {ev.c}</span>
                  {t
                    ? <span className="aud-hit-t">{t}</span>
                    : <span className="graph-dim" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{ev.h}{ev.h === 'seed' ? '' : ' — span not on this device (opaque off-device, by design)'}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Assemble the unified export: graph snapshot line(s) (schema cleo-graph/1)
// when ingestion is on, plus the audit turn lines (schema cleo-audit/1) when
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
  const pendingCount = (() => {
    try { return (window.EOEngine && window.EOEngine.pendingProposals) ? window.EOEngine.pendingProposals().filter(p => p.status === 'signal').length : 0; }
    catch (e) { return 0; }
  })();

  const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
  const build = () => buildUnifiedJSONL({ docs, includeIngestion: exportIngestion, includeOutput: exportOutput });
  const exportJSONL = () => {
    if (!exportIngestion && !exportOutput) { onToast && onToast('Turn on extraction or chat to export.'); return; }
    const text = build();
    if (!text) { onToast && onToast('Nothing to export yet.'); return; }
    const ok = downloadText(text, 'cleo-glassbox-' + ts() + '.jsonl');
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
          <button className={'drawer-tab' + (tab === 'ladder' ? ' on' : '')} onClick={() => setTab('ladder')} title="The EO layer ladder — the essay's 1-2-1 force-count test, run live on this document">Ladder</button>
          <button className={'drawer-tab' + (tab === 'proposals' ? ' on' : '')} onClick={() => setTab('proposals')}
                  title="Convention proposals from the local model — signals waiting for an independent witness or your one-tap verdict">
            Proposals{pendingCount ? ' · ' + pendingCount : ''}
          </button>
          <div style={{ flex: 1 }} />
          {tab === 'trace' && (
            <button className={'aud-rec' + (enabled ? ' on' : '')} role="switch" aria-checked={enabled}
                    onClick={() => onToggle()} title="Record chat turns">
              <span className={'switch' + (enabled ? ' on' : '')} aria-hidden="true" />
              <span className="aud-rec-lbl">{enabled ? 'Recording' : 'Paused'}</span>
            </button>
          )}
          {(tab === 'graph' || tab === 'ladder') && proseDocs.length > 1 && (
            <select className="graph-pick" value={graphDoc ? graphDoc.id : ''} onChange={e => setGraphDocId(e.target.value)}>
              {proseDocs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>

        <div className="drawer-body aud-body">
          {tab === 'trace'
            ? (view.length
                ? <React.Fragment><TruthSummary turns={view} />{view.map(t => <AuditTurn key={t.id} turn={t} />)}</React.Fragment>
                : <div className="empty-doc" style={{ padding: 40 }}>{enabled
                    ? 'No turns recorded yet — ask Cleo something and the full pipeline shows up here.'
                    : 'Recording is paused. Turn it on to capture chat turns.'}</div>)
            : tab === 'ladder'
              ? <LayerLadder doc={graphDoc} />
              : tab === 'proposals'
                ? <ProposalsView docs={docs} onToast={onToast} onChanged={() => force()} />
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

Object.assign(window, { AuditDrawer, AuditTurn, AuditStep, GraphView, LayerLadder, stripForView });
