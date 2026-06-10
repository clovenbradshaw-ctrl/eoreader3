/* ============================================================
   sandbox.jsx — the evolution loop as an in-app drawer.

   Runs entirely client-side: it loads a CANDIDATE engine from patched
   engine.js source into an isolated in-browser VM (new Function), scores
   it against the labeled battery (quality) and the committed golden
   (parity), and shows the two-fitness verdict — with the constitution
   (evo/allowlist) enforced exactly as in the Node loop. The app's live
   engine is never touched. Persisting a winner is a human action
   (npm run evo:accept, or export the diff).

   Depends on plain scripts loaded before it: evo/allowlist.js,
   evo/patch.js, evo/sandbox.browser.js (→ window.EVO_SANDBOX) and the
   generated evo/sandbox-data.js (→ window.EVO_SANDBOX_DATA).
   ============================================================ */
function SandboxDrawer({ onClose, onToast }) {
  const { useState, useEffect, useRef, useCallback } = React;
  const [phase, setPhase] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [baseline, setBaseline] = useState(null); // {quality, parity}
  const [rules, setRules] = useState([]);         // evolvable + locked rule descriptors
  const [src, setSrc] = useState(null);           // {pivot, engine}
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);             // agent-run generations
  const [candidate, setCandidate] = useState(null); // current manual candidate result
  const [edited, setEdited] = useState({});       // ruleName -> new value (manual)
  const [apiKey, setApiKey] = useState('');       // kept only in this tab's memory
  const [live, setLive] = useState({ busy: false, log: [], tokens: 0, error: null, best: null, capped: false });
  const [liveCfg, setLiveCfg] = useState({ model: 'claude-opus-4-8', generations: 6, tokenMax: 150000, thinking: false });
  const dialogRef = useRef(null);

  const SB = window.EVO_SANDBOX, DATA = window.EVO_SANDBOX_DATA;
  const nlp = window.nlp;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const sgn = (x) => (x >= 0 ? '+' : '') + r3(x);

  // Escape-to-close + focus
  useEffect(() => { const f = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', f); if (dialogRef.current) dialogRef.current.focus(); return () => document.removeEventListener('keydown', f); }, [onClose]);

  // Load sources + baseline on open.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!SB || !DATA) throw new Error('sandbox scripts not loaded (evo/sandbox.browser.js, evo/sandbox-data.js)');
        if (!nlp) throw new Error('compromise (nlp) not available');
        const [pivot, engine] = await Promise.all([
          fetch('pivot.jsx').then(r => { if (!r.ok) throw 0; return r.text(); }),
          fetch('engine.js').then(r => { if (!r.ok) throw 0; return r.text(); }),
        ]).catch(() => { throw new Error('could not fetch engine source — serve the app over http (not file://)'); });
        if (!live) return;
        const E0 = SB.loadCandidate(pivot, engine, nlp);
        const quality = await SB.scoreQuality(E0, DATA);
        const parity = await SB.runParity(E0, DATA);
        const enum_ = SB.evolvableRules(engine);
        if (!live) return;
        setSrc({ pivot, engine });
        setBaseline({ quality, parity });
        setRules(enum_.rules);
        setPhase('ready');
      } catch (e) { if (live) { setError(String(e.message || e)); setPhase('error'); } }
    })();
    return () => { live = false; };
  }, []);

  const cfg = { qualityWinThreshold: 0.01, justifiedBreakThreshold: 0.03 };

  // Evaluate one candidate (a list of structured edits) against the baseline.
  const evalEdits = useCallback(async (edits) => {
    return await SB.evaluate({ pivotSrc: src.pivot, engineSrc: src.engine, edits, nlp, data: DATA, baseline: baseline.quality, cfg });
  }, [src, baseline]);

  // Run the offline agent's scripted sequence, streaming verdicts in.
  const runAgent = useCallback(async () => {
    setBusy(true); setLog([]);
    try {
      for (const h of SB.offlineHypotheses) {
        const r = await evalEdits(h.edits);
        setLog(prev => [...prev, { hyp: h, result: r }]);
        await new Promise(res => setTimeout(res, 0)); // yield to paint
      }
      onToast && onToast('Agent run complete');
    } finally { setBusy(false); }
  }, [evalEdits, onToast]);

  // Live: type a key, let the Anthropic agent run its own experiments —
  // observe the traces → propose a change → the sandbox runs + scores it →
  // iterate, bounded by a token budget.
  const runLive = useCallback(async () => {
    if (!apiKey) { onToast && onToast('Enter your Anthropic API key first'); return; }
    setLive({ busy: true, log: [], tokens: 0, error: null, best: null, capped: false });
    try {
      const E0 = SB.loadCandidate(src.pivot, src.engine, nlp);
      const battery = await SB.traceBattery(E0, DATA);
      const agent = SB.liveAgent({ key: apiKey, model: liveCfg.model, thinking: liveCfg.thinking, tokenMax: liveCfg.tokenMax });
      const history = []; let best = null, capped = false;
      for (let g = 0; g < liveCfg.generations; g++) {
        if (agent.exhausted()) { capped = true; break; }
        let hyp;
        try { hyp = await agent.hypothesize({ battery, baseline: baseline.quality, history }); }
        catch (e) { setLive(s => ({ ...s, error: String(e.message || e), busy: false })); return; }
        if (!hyp) break;
        const r = await evalEdits(hyp.edits);
        const entry = { hyp, result: r };
        history.push(entry);
        if (r.surface && (!best || r.qualityDelta > best.result.qualityDelta)) best = entry;
        setLive({ busy: true, log: [...history], tokens: agent.tokensUsed(), error: null, best, capped: false });
        await new Promise(res => setTimeout(res, 0));
      }
      setLive(s => ({ ...s, busy: false, capped }));
      onToast && onToast('Live run complete · ' + agent.tokensUsed() + ' tokens');
    } catch (e) { setLive(s => ({ ...s, busy: false, error: String(e.message || e) })); }
  }, [apiKey, src, baseline, liveCfg, evalEdits, onToast]);

  // Manual: test the currently-edited rule values as one candidate.
  const testManual = useCallback(async () => {
    const edits = Object.entries(edited).map(([rule, value]) => ({ kind: 'rule-value', rule, value }));
    if (!edits.length) { onToast && onToast('Edit a rule value first'); return; }
    setBusy(true);
    try { setCandidate(await evalEdits(edits)); } finally { setBusy(false); }
  }, [edited, evalEdits, onToast]);

  const exportDiff = (diff) => {
    const blob = new Blob([diff], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'evo-candidate.diff'; a.click();
    onToast && onToast('Exported evo-candidate.diff');
  };

  const STATE_TAG = { 'clean-win': ['✓ clean win', 'win'], 'justified-break': ['⚑ justified break', 'just'], 'regression': ['✗ regression', 'bad'], 'null': ['· null', 'null'], 'rejected-by-allowlist': ['⊘ rejected by constitution', 'bad'] };

  function Verdict({ r }) {
    if (!r) return null;
    const [label, cls] = STATE_TAG[r.state] || [r.state, ''];
    return (
      <div className={'sbx-verdict ' + cls}>
        <div className="sbx-verdict-head"><span className={'sbx-badge ' + cls}>{label}</span>
          {r.note && <span className="sbx-note">{r.note}</span>}</div>
        {r.state !== 'rejected-by-allowlist' && (
          <React.Fragment>
            <div className="sbx-deltas">
              <span>parity <b>{r.parity.clean ? 'clean' : r.parity.diffs + '/' + r.parity.total + ' diffs'}</b></span>
              <span>Δquality <b>{sgn(r.qualityDelta)}</b></span>
              <span>bind {sgn(r.componentDeltas.binding)}</span>
              <span>stall {sgn(r.componentDeltas.stall)}</span>
              <span>ground {sgn(r.componentDeltas.grounding)}</span>
            </div>
            {r.diff && <details className="sbx-diff"><summary>diff</summary><pre>{r.diff.trim()}</pre></details>}
            {(r.state === 'clean-win' || r.state === 'justified-break') && (
              <div className="sbx-actions">
                <button className="mini-btn primary" onClick={() => exportDiff(r.diff)}><Icon name="upload" size={13} /> Export diff</button>
                <span className="sbx-hint">to keep it: <code>npm run evo:accept</code> in the repo{r.state === 'justified-break' ? ' (recaptures goldens)' : ''}</span>
              </div>
            )}
          </React.Fragment>
        )}
      </div>
    );
  }

  const evolvable = rules.filter(r => r.evolvable && r.kind === 'scalar');
  const locked = rules.filter(r => !r.evolvable);
  const bq = baseline && baseline.quality;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Sandbox" tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Sandbox</h2>
            <button className="x" onClick={onClose} aria-label="Close sandbox"><Icon name="x" size={18} /></button>
          </div>
          <p>Evolve the reading <b>laws</b> — never the constitution. Each candidate is run in an isolated in-browser engine, scored against the battery (<b>quality</b>, the hill) and the committed golden (<b>parity</b>, the floor). The agent proposes; you select. The app’s live reading is untouched.</p>
        </div>

        <div className="drawer-body">
          {phase === 'loading' && <div className="sbx-loading">Loading the engine into a sandbox…</div>}
          {phase === 'error' && <div className="sbx-error"><b>Sandbox unavailable.</b> {error}</div>}

          {phase === 'ready' && (
            <React.Fragment>
              <div className="sbx-baseline">
                <div className="rule-group-label">Baseline — what “good reading” scores now</div>
                <div className="sbx-scores">
                  <div className="sbx-score big"><span>composite</span><b>{r3(bq.composite)}</b></div>
                  <div className="sbx-score"><span>2a binding</span><b>{r3(bq.components.binding)}</b></div>
                  <div className="sbx-score"><span>2b stall honesty</span><b>{r3(bq.components.stall)}</b></div>
                  <div className="sbx-score"><span>2d grounding</span><b>{r3(bq.components.grounding)}</b></div>
                  <div className="sbx-score"><span>2c integration</span><b>{r3(bq.components.integration)} <i>stub</i></b></div>
                  <div className="sbx-score"><span>parity</span><b>{baseline.parity.clean ? 'clean' : baseline.parity.diffs + ' diffs'} <i>{baseline.parity.total} snaps</i></b></div>
                </div>
              </div>

              <div className="tier">
                <div className="tier-head">
                  <div className="rule-group-label">Live agent · Anthropic</div>
                  <p className="tier-sub">Type your Anthropic API key and the agent runs its own experiments: it reads the traces, proposes a change, the sandbox runs and scores it in isolation, and it iterates — bounded by a token budget. Your key stays in this browser tab and is sent directly to Anthropic over HTTPS (it is never stored or committed).</p>
                </div>
                <div className="sbx-key"><input type="password" value={apiKey} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} onChange={e => setApiKey(e.target.value)} /></div>
                <div className="sbx-livecfg">
                  <label>model
                    <select value={liveCfg.model} onChange={e => setLiveCfg(c => ({ ...c, model: e.target.value }))}>
                      <option value="claude-opus-4-8">opus-4-8</option>
                      <option value="claude-sonnet-4-6">sonnet-4-6</option>
                      <option value="claude-haiku-4-5">haiku-4-5</option>
                    </select>
                  </label>
                  <label>generations<input type="number" min="1" max="12" value={liveCfg.generations} onChange={e => setLiveCfg(c => ({ ...c, generations: Number(e.target.value) || 6 }))} /></label>
                  <label>token budget<input type="number" step="10000" min="10000" value={liveCfg.tokenMax} onChange={e => setLiveCfg(c => ({ ...c, tokenMax: Number(e.target.value) || 150000 }))} /></label>
                  <label className="sbx-check"><input type="checkbox" checked={liveCfg.thinking} onChange={e => setLiveCfg(c => ({ ...c, thinking: e.target.checked }))} /> deep thinking</label>
                </div>
                <button className="btn-ghost" disabled={live.busy || !apiKey} onClick={runLive}>{live.busy ? 'Experimenting…' : 'Run live experiments'}</button>
                {live.tokens > 0 && <span className="sbx-hint" style={{ marginLeft: 10 }}>{live.tokens} tokens used</span>}
                {live.error && <div className="sbx-error" style={{ padding: '10px 2px' }}><b>Anthropic error.</b> {live.error}</div>}
                {live.capped && <div className="sbx-hint" style={{ display: 'block', marginTop: 8 }}>Token budget reached — raise it above and run again to continue.</div>}
                {live.log.map((g, i) => (
                  <div key={i} className="sbx-gen">
                    <div className="sbx-gen-head">{g.hyp.target}</div>
                    <div className="sbx-gen-note">{g.hyp.statement}{g.hyp.argument ? ' — ' + g.hyp.argument : ''}</div>
                    <Verdict r={g.result} />
                  </div>
                ))}
              </div>

              <div className="tier">
                <div className="tier-head">
                  <div className="rule-group-label">Run the agent · offline</div>
                  <p className="tier-sub">No key needed. The offline agent proposes a short, deterministic sequence: a clean-parity win, an over-correction that costs honesty, a constitution-blocked attempt to game the metric, and a regression. Each runs in its own sandbox.</p>
                </div>
                <button className="btn-ghost" disabled={busy} onClick={runAgent}>{busy ? 'Running…' : 'Run agent (offline · zero-token)'}</button>
                {log.map((g, i) => (
                  <div key={i} className="sbx-gen">
                    <div className="sbx-gen-head">{g.hyp.target}</div>
                    <div className="sbx-gen-note">{g.hyp.note}</div>
                    <Verdict r={g.result} />
                  </div>
                ))}
              </div>

              <div className="tier">
                <div className="tier-head">
                  <div className="rule-group-label">Tune a law by hand · {evolvable.length} evolvable</div>
                  <p className="tier-sub">Change any evolvable rule and test it as a candidate. Source-patched and run in isolation, so anything may be tuned — not just the live knobs.</p>
                </div>
                <div className="sbx-rules">
                  {evolvable.map(r => (
                    <label key={r.name} className="sbx-rule" title={r.reason}>
                      <span className="sbx-rule-name">{r.name}</span>
                      <input type="number" step="any" defaultValue={r.value}
                        onChange={e => setEdited(prev => ({ ...prev, [r.name]: e.target.value === '' ? r.value : Number(e.target.value) }))} />
                    </label>
                  ))}
                </div>
                <button className="btn-ghost" disabled={busy} onClick={testManual}>{busy ? 'Scoring…' : 'Test candidate'}</button>
                <Verdict r={candidate} />
              </div>

              <details className="tier">
                <summary className="rule-group-label">The constitution · {locked.length} locked rules</summary>
                <p className="tier-sub">Off limits to the agent — rejected mechanically before any rerun. Plus the EVA checks, the grounder, citation binding, the operators, parity, and the fixtures.</p>
                <div className="sbx-locked">
                  {locked.map(r => <div key={r.name} className="sbx-lock"><span>{r.name}</span><i>{r.reason}</i></div>)}
                </div>
              </details>
            </React.Fragment>
          )}
        </div>
      </div>
    </div>
  );
}
