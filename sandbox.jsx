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
function SandboxDrawer({ onClose, onToast, mlcKey, modelReady }) {
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
  const [live, setLive] = useState({ busy: false, log: [], tokens: 0, error: null, best: null, capped: false, sampled: [] });
  const [liveCfg, setLiveCfg] = useState({ model: 'claude-opus-4-8', generations: 6, tokenMax: 150000, thinking: false, rangeSize: 6 });
  const [baseEngine, setBaseEngine] = useState(null); // the loaded baseline EOEngine, for the inspector + chat
  const [inspectId, setInspectId] = useState(null);
  const [graph, setGraph] = useState(null);
  const [chatQ, setChatQ] = useState('');
  const [chatA, setChatA] = useState(null);
  const [promptText, setPromptText] = useState('');
  const [labQ, setLabQ] = useState('');
  const [lab, setLab] = useState({ busy: false, answer: null, score: null, critique: null, claudeWould: null, history: [], error: null });
  const dialogRef = useRef(null);

  const allFixtures = () => ['binding', 'stalls', 'integration'].flatMap(k => ((DATA && DATA.fixtures[k]) || []).map(f => ({ ...f, kind: k })));

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
        setBaseEngine(E0);
        setInspectId((((DATA.fixtures.binding || [])[0]) || ((DATA.fixtures.integration || [])[0]) || {}).id || null);
        setPhase('ready');
      } catch (e) { if (live) { setError(String(e.message || e)); setPhase('error'); } }
    })();
    return () => { live = false; };
  }, []);

  // DEF/REC inspector: read the selected text into a graph on the baseline engine.
  useEffect(() => {
    if (!baseEngine || !inspectId) return;
    let on = true; setGraph(null); setChatA(null);
    const fx = allFixtures().find(f => f.id === inspectId);
    if (!fx) return;
    (async () => {
      try { const g = await SB.graphOf(baseEngine, fx.doc, fx.id); if (on) { setGraph(g); const q = fx.question || 'who is in this and what happens'; setChatQ(q); setLabQ(q); } }
      catch (e) { if (on) setGraph({ error: String(e.message || e) }); }
    })();
    return () => { on = false; };
  }, [baseEngine, inspectId]);

  // Seed the editable talker prompt from the model's current grounded prompt.
  useEffect(() => {
    if (promptText) return;
    try { if (window.EOLLM && window.EOLLM.systemFor) setPromptText(window.EOLLM.systemFor('grounded', null, true, 1) || ''); } catch (e) {}
  }, [phase, modelReady]);

  const runQuery = useCallback(() => {
    if (!graph || !graph._doc || !baseEngine || !chatQ.trim()) return;
    setChatA(SB.queryGraph(baseEngine, graph._doc, chatQ.trim()));
  }, [graph, baseEngine, chatQ]);

  // Prompt lab: local model answers off the grounded context under the
  // candidate prompt, then Claude grades it.
  const runLab = useCallback(async () => {
    if (!apiKey) { onToast && onToast('Enter your Claude key (Live agent section)'); return; }
    if (!modelReady || !mlcKey) { onToast && onToast('Load a local model first — the model picker in the top bar'); return; }
    if (!graph || !graph._doc) { onToast && onToast('Pick a text above'); return; }
    const fx = allFixtures().find(f => f.id === inspectId);
    setLab(s => ({ ...s, busy: true, error: null }));
    try {
      const { answer } = await SB.localAnswer({ EOLLM: window.EOLLM, EOEngine: baseEngine, doc: graph._doc, question: labQ, mlcKey, sysOverride: promptText || undefined });
      const judged = await SB.judgeAnswer({ key: apiKey, model: liveCfg.model, source: fx.doc, question: labQ, answer });
      setLab(s => ({ ...s, busy: false, answer, score: judged.score, critique: judged.critique, claudeWould: judged.claudeWould, history: [{ score: judged.score, chars: (promptText || '').length }, ...s.history].slice(0, 8) }));
      onToast && onToast(judged.score != null ? 'Claude scored it ' + judged.score : 'judged');
    } catch (e) { setLab(s => ({ ...s, busy: false, error: String(e.message || e) })); }
  }, [apiKey, modelReady, mlcKey, graph, inspectId, labQ, promptText, baseEngine, liveCfg]);

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
    const excerpts = SB.sampleExcerpts(DATA, liveCfg.rangeSize || 6);
    setLive({ busy: true, log: [], tokens: 0, error: null, best: null, capped: false, sampled: excerpts.map(e => e.src) });
    try {
      const E0 = SB.loadCandidate(src.pivot, src.engine, nlp);
      const battery = await SB.traceBattery(E0, DATA);
      const baseRange = await SB.scoreRange(E0, excerpts);
      const agent = SB.liveAgent({ key: apiKey, model: liveCfg.model, thinking: liveCfg.thinking, tokenMax: liveCfg.tokenMax, rules });
      const history = []; let best = null, capped = false;
      for (let g = 0; g < liveCfg.generations; g++) {
        if (agent.exhausted()) { capped = true; break; }
        let hyp;
        try { hyp = await agent.hypothesize({ battery, baseline: baseline.quality, history }); }
        catch (e) { setLive(s => ({ ...s, error: String(e.message || e), busy: false })); return; }
        if (!hyp) break;
        const r = await SB.evaluateFast({ pivotSrc: src.pivot, engineSrc: src.engine, edits: hyp.edits, nlp, data: DATA, excerpts, baseline: baseline.quality, baseRange, cfg });
        const entry = { hyp, result: r };
        history.push(entry);
        if (r.surface && (!best || r.qualityDelta > best.result.qualityDelta)) best = entry;
        setLive(s => ({ ...s, busy: true, log: [...history], tokens: agent.tokensUsed(), error: null, best }));
        await new Promise(res => setTimeout(res, 0));
      }
      setLive(s => ({ ...s, busy: false, capped }));
      onToast && onToast('Live run complete · ' + agent.tokensUsed() + ' tokens');
    } catch (e) { setLive(s => ({ ...s, busy: false, error: String(e.message || e) })); }
  }, [apiKey, src, baseline, liveCfg, rules, onToast]);

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

  // The artifact you hand back to update the app: every proposal + verdict,
  // the wins, and the recommended edits to apply (best clean win).
  const buildRunJSON = (log, provider, tokens) => {
    const r3 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
    const wins = log.filter(g => g.result.surface).sort((a, b) => b.result.qualityDelta - a.result.qualityDelta);
    return {
      app: 'cleon-evo-sandbox', schema: 'evo-run/1', generatedAt: new Date().toISOString(),
      provider, model: provider === 'live' ? liveCfg.model : 'offline', tokensUsed: tokens || 0,
      baseline: { composite: r3(baseline.quality.composite), components: baseline.quality.components },
      results: log.map(g => ({
        target: g.hyp.target, statement: g.hyp.statement || null, rationale: g.hyp.rationale || null,
        edits: g.hyp.edits, state: g.result.state, qualityDelta: r3(g.result.qualityDelta),
        componentDeltas: g.result.componentDeltas || null,
        parity: g.result.parity ? { clean: g.result.parity.clean, diffs: g.result.parity.diffs } : null,
        range: g.result.range ? { grounding: r3(g.result.range.grounding), fabrications: g.result.range.fabrications, n: g.result.range.n } : null,
        note: g.result.note || null,
      })),
      wins: wins.map(g => ({ target: g.hyp.target, edits: g.hyp.edits, state: g.result.state, qualityDelta: r3(g.result.qualityDelta) })),
      recommendedEdits: wins.length ? wins[0].hyp.edits : [],
    };
  };
  const copyRun = (log, provider, tokens) => {
    const txt = JSON.stringify(buildRunJSON(log, provider, tokens), null, 2);
    try { navigator.clipboard.writeText(txt); onToast && onToast('Run JSON copied — paste it back to update the app'); }
    catch (e) { onToast && onToast('copy failed; use Download'); }
  };
  const downloadRun = (log, provider, tokens) => {
    const blob = new Blob([JSON.stringify(buildRunJSON(log, provider, tokens), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'evo-run-' + provider + '.json'; a.click();
    onToast && onToast('Downloaded evo-run-' + provider + '.json');
  };
  function RunSummary({ log, provider, tokens }) {
    if (!log.length) return null;
    const wins = log.filter(g => g.result.surface);
    const best = wins.length ? Math.max(...wins.map(g => g.result.qualityDelta)) : 0;
    return (
      <div className="sbx-runsummary">
        <span>{log.length} proposal{log.length === 1 ? '' : 's'} · {wins.length} win{wins.length === 1 ? '' : 's'}{wins.length ? ' · best Δ+' + (Math.round(best * 10000) / 10000) : ' · nothing to keep yet'}</span>
        <button className="mini-btn" onClick={() => copyRun(log, provider, tokens)}><Icon name="copy" size={12} /> Copy run JSON</button>
        <button className="mini-btn" onClick={() => downloadRun(log, provider, tokens)}><Icon name="upload" size={12} /> Download</button>
      </div>
    );
  }

  const STATE_TAG = {
    'clean-win': ['✓ clean win', 'win'], 'improves': ['✓ improves', 'win'],
    'justified-break': ['⚑ justified break', 'just'], 'range-flag': ['⚑ range flag', 'just'],
    'regression': ['✗ regression', 'bad'], 'broken': ['✗ broken', 'bad'],
    'null': ['· null', 'null'], 'rejected-by-allowlist': ['⊘ rejected by constitution', 'bad'],
  };

  function Verdict({ r }) {
    if (!r) return null;
    const [label, cls] = STATE_TAG[r.state] || [r.state, ''];
    const hasDeltas = r.componentDeltas && r.qualityDelta != null;
    return (
      <div className={'sbx-verdict ' + cls}>
        <div className="sbx-verdict-head"><span className={'sbx-badge ' + cls}>{label}</span>
          {r.note && <span className="sbx-note">{r.note}</span>}</div>
        {hasDeltas && (
          <React.Fragment>
            <div className="sbx-deltas">
              {r.parity && <span>parity <b>{r.parity.clean ? 'clean' : r.parity.diffs + '/' + r.parity.total + ' diffs'}</b></span>}
              {r.range && <span>range <b>{Math.round(r.range.grounding * r.range.n)}/{r.range.n} grounded{r.range.fabrications ? ', ' + r.range.fabrications + ' fab' : ''}</b></span>}
              <span>Δquality <b>{sgn(r.qualityDelta)}</b></span>
              <span>bind {sgn(r.componentDeltas.binding)}</span>
              <span>stall {sgn(r.componentDeltas.stall)}</span>
              <span>ground {sgn(r.componentDeltas.grounding)}</span>
            </div>
            {r.diff && <details className="sbx-diff"><summary>diff</summary><pre>{r.diff.trim()}</pre></details>}
            {r.surface && (
              <div className="sbx-actions">
                <button className="mini-btn primary" onClick={() => exportDiff(r.diff)}><Icon name="upload" size={13} /> Export diff</button>
                <span className="sbx-hint">to keep it: <code>npm run evo:accept</code> (re-checks golden parity)</span>
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
                  <div className="rule-group-label">Watch the operators · DEF · CHAT · REC</div>
                  <p className="tier-sub">What the engine does with a text, in its own vocabulary. <b>DEF</b>: the graph it defines — who/what, and how they relate. <b>CHAT</b>: query that graph; answers cite the source, no vector store. <b>REC</b>: what reading it taught the engine — vocabulary that accrues mass and persists (the plastic neurons). The loop's <b>EVA</b> step is the candidate scoring further down. The model only ever sees a compact summary — never this text.</p>
                </div>
                <select className="sbx-pick" value={inspectId || ''} onChange={e => setInspectId(e.target.value)}>
                  {allFixtures().map(f => <option key={f.id} value={f.id}>{f.kind} · {f.id}{f.genre ? ' — ' + f.genre.split('—')[0].trim() : ''}</option>)}
                </select>
                {!graph && <div className="sbx-loading">reading…</div>}
                {graph && graph.error && <div className="sbx-error">{graph.error}</div>}
                {graph && !graph.error && (
                  <React.Fragment>
                    <div className="op-block">
                      <div className="op-tag def">DEF — the graph it builds</div>
                      <div className="op-row"><span>nodes</span><div>{graph.entities.map((e, i) => <span key={i} className="op-node">{e.name}<i> {e.type}{e.gender ? '·' + e.gender : ''}</i></span>)}</div></div>
                      {graph.speech.length > 0 && <div className="op-row"><span>speech</span><div>{graph.speech.map((s, i) => <div key={i} className="op-edge">{s.speaker} <i>&lt;{s.how}&gt;</i> “{s.quote}”</div>)}</div></div>}
                      {graph.defs.length > 0 && <div className="op-row"><span>defined</span><div>{graph.defs.map((d, i) => <div key={i} className="op-edge">{d.target} → {d.path}: <b>{String(d.value)}</b> <i>{d.reason}</i></div>)}</div></div>}
                      {graph.stalls.length > 0 && <div className="op-row"><span>held (NUL)</span><div>{graph.stalls.map((n, i) => <div key={i} className="op-edge">“{n.surface}” <i>s{n.at} — honestly held: {n.competing.join(' · ')}</i></div>)}</div></div>}
                    </div>
                    <div className="op-block">
                      <div className="op-tag chat">CHAT — query the graph</div>
                      <div className="sbx-chat">
                        <input value={chatQ} onChange={e => setChatQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runQuery(); }} placeholder="ask the graph…" />
                        <button className="mini-btn" onClick={runQuery}>Ask</button>
                      </div>
                      {chatA && <div className="sbx-answer">{chatA.text || '(no answer)'}{chatA.audit && <div className="sbx-audit">grounded: {String(chatA.audit.grounded)}{chatA.audit.status ? ' · ' + chatA.audit.status : ''} · {chatA.cites} cite{chatA.cites === 1 ? '' : 's'}</div>}</div>}
                    </div>
                    <div className="op-block">
                      <div className="op-tag rec">REC — what reading it taught the engine</div>
                      <div className="op-row"><span>from this text</span><div>{graph.recs.length ? graph.recs.map((r, i) => <div key={i} className="op-edge">{r.target} <i>{r.action}</i> <b>{String(r.value)}</b> <i>{r.reason}</i></div>) : <i>nothing new induced</i>}</div></div>
                      {graph.learned.length > 0 && <div className="op-row"><span>vocabulary so far</span><div className="op-verbs">{graph.learned.map((v, i) => <span key={i} className="op-verb">{v.verb}<i>·{v.mass}</i></span>)}</div></div>}
                    </div>
                  </React.Fragment>
                )}
              </div>

              <div className="tier">
                <div className="tier-head">
                  <div className="rule-group-label">Prompt lab · local model, Claude-judged</div>
                  <p className="tier-sub">Tune how the on-device model answers — the second half of the goal. It reads off the engine's grounded context for the text selected above; you edit the talker prompt; <b>Claude grades the answer 0–1</b> for Claude-comparable quality. Needs a local model loaded (top-bar picker) and your key.</p>
                </div>
                {!modelReady && <div className="sbx-hint" style={{ display: 'block', marginBottom: 8 }}>No local model loaded — open the model picker in the top bar first.</div>}
                <label className="sbx-rule-name" style={{ display: 'block', marginBottom: 4 }}>question</label>
                <div className="sbx-chat"><input value={labQ} onChange={e => setLabQ(e.target.value)} placeholder="question for the local model…" /></div>
                <label className="sbx-rule-name" style={{ display: 'block', margin: '10px 0 4px' }}>talker prompt — the lever you tune</label>
                <textarea className="sbx-prompt" value={promptText} onChange={e => setPromptText(e.target.value)} rows={5} spellCheck={false} placeholder="(loads from the model's current grounded prompt)" />
                <button className="btn-ghost" disabled={lab.busy || !apiKey || !modelReady} onClick={runLab}>{lab.busy ? 'Answering + judging…' : 'Run local model + judge with Claude'}</button>
                {lab.error && <div className="sbx-error" style={{ padding: '10px 2px' }}>{lab.error}</div>}
                {lab.answer != null && (
                  <div className="op-block" style={{ marginTop: 10 }}>
                    <div className="op-tag chat">local model answer</div>
                    <div className="sbx-answer">{lab.answer || '(empty)'}</div>
                    {lab.score != null && (
                      <div className="sbx-verdict" style={{ marginTop: 8 }}>
                        <div className="sbx-verdict-head"><span className={'sbx-badge ' + (lab.score >= 0.7 ? 'win' : lab.score >= 0.4 ? 'just' : 'bad')}>Claude score {lab.score}</span><span className="sbx-note">{lab.critique}</span></div>
                        {lab.claudeWould && <div className="sbx-note" style={{ marginTop: 6 }}>a top answer would: {lab.claudeWould}</div>}
                      </div>
                    )}
                  </div>
                )}
                {lab.history.length > 1 && <div className="sbx-hint" style={{ display: 'block', marginTop: 8 }}>scores this session (newest first): {lab.history.map(h => h.score == null ? '?' : h.score).join(' · ')}</div>}
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
                  <label title="How many short, random corpus excerpts each candidate is also tried against (generalization check)">range texts<input type="number" min="0" max="12" value={liveCfg.rangeSize} onChange={e => setLiveCfg(c => ({ ...c, rangeSize: Number(e.target.value) }))} /></label>
                  <label>token budget<input type="number" step="10000" min="10000" value={liveCfg.tokenMax} onChange={e => setLiveCfg(c => ({ ...c, tokenMax: Number(e.target.value) || 150000 }))} /></label>
                  <label className="sbx-check" title="Adaptive extended thinking — better hypotheses, but roughly 5–10× the tokens. Off is the frugal default."><input type="checkbox" checked={liveCfg.thinking} onChange={e => setLiveCfg(c => ({ ...c, thinking: e.target.checked }))} /> deep thinking (≈5–10× tokens)</label>
                </div>
                <button className="btn-ghost" disabled={live.busy || !apiKey} onClick={runLive}>{live.busy ? 'Experimenting…' : 'Run live experiments'}</button>
                {live.tokens > 0 && <span className="sbx-hint" style={{ marginLeft: 10 }}>{live.tokens} tokens used</span>}
                {live.sampled && live.sampled.length > 0 && <div className="sbx-hint" style={{ display: 'block', marginTop: 8 }}>each change tried against {live.sampled.length} random texts: {live.sampled.join(', ')}</div>}
                {live.error && <div className="sbx-error" style={{ padding: '10px 2px' }}><b>Anthropic error.</b> {live.error}</div>}
                {live.capped && <div className="sbx-hint" style={{ display: 'block', marginTop: 8 }}>Token budget reached — raise it above and run again to continue.</div>}
                {live.log.map((g, i) => (
                  <div key={i} className="sbx-gen">
                    <div className="sbx-gen-head">{g.hyp.target}</div>
                    <div className="sbx-gen-note">{g.hyp.statement}{g.hyp.argument ? ' — ' + g.hyp.argument : ''}</div>
                    <Verdict r={g.result} />
                  </div>
                ))}
                <RunSummary log={live.log} provider="live" tokens={live.tokens} />
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
                <RunSummary log={log} provider="offline" tokens={0} />
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
