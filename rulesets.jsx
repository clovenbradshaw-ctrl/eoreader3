/* ============================================================ Model popover
   The model picker, anchored off the sidebar's model chip: GPU (WebLLM),
   on-device CPU (wllama), an upload-your-own GGUF slot, and the Anthropic
   (Claude) cloud tier with its API-key field. The reading rules are no longer
   user-toggleable — every rule is always on (see data.jsx / window.EO_RULES) —
   so the old Rules drawer is gone; only the model picker lives here now.
   ============================================================ */
function ModelPopover({ models, current, onPick, onClose, anchor, status, progress, loadText, onReset, onCancel, webgpu, autoModel, autoPick, onAuto, anthropicKeySet, onSetAnthropicKey, onUploadModel }) {
  const ref = window.useDialog(onClose);
  const uploadRef = React.useRef(null);
  React.useEffect(() => {
    // Close only on a genuine outside press. A containment check on mousedown
    // (instead of a bare window 'click' → onClose) means a press on a model
    // row can never be mistaken for an "outside" click — that race was why
    // picking a different model sometimes did nothing. The trigger chip is
    // exempt so it still toggles the popover shut.
    const h = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-model-trigger]')) return;
      onClose();
    };
    const id = setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', h); };
  }, []);
  const style = anchor ? { left: anchor.left, bottom: anchor.bottom } : { left: 16, bottom: 60 };
  const pct = Math.round((progress || 0) * 100);
  const [keyDraft, setKeyDraft] = React.useState('');
  // Per-row "cached on this device" flags — drives the badge that tells a
  // reader the row is a fast re-instantiate (no download) rather than a
  // multi-gig fetch. Queried on open (and after a load completes, since a
  // freshly-finished download flips a row from uncached to cached); cheap
  // best-effort lookup, no flicker if it never resolves.
  const [cached, setCached] = React.useState({});
  React.useEffect(() => {
    const L = window.EOLLM;
    if (!L || !L.cacheStatus) return;
    let alive = true;
    (async () => {
      const out = {};
      for (const m of models) {
        try { const s = await L.cacheStatus(m.mlc); if (s && s.cached) out[m.id] = true; } catch (_) {}
      }
      if (alive) setCached(out);
    })();
    return () => { alive = false; };
  }, [models, status]);
  const gpu = models.filter(m => !m.provider);
  const cpu = models.filter(m => m.provider === 'wllama' && !m.uploaded);
  const uploaded = models.filter(m => m.provider === 'wllama' && m.uploaded);
  const cloud = models.filter(m => m.provider === 'anthropic');
  const curIsCloud = current.provider === 'anthropic';
  const curIsCpu = current.provider === 'wllama';
  const curIsGpu = !current.provider;
  const saveKey = () => { const k = keyDraft.trim(); if (k) { onSetAnthropicKey(k); setKeyDraft(''); } };
  const row = (m) => {
    const isCur = m.id === current.id;
    const state = isCur ? status : 'idle';
    const isCached = !!cached[m.id];
    // A cached row is a fast re-instantiate (bytes on disk); the action label
    // shifts to "Use" so the reader knows there's no fresh download coming.
    const idle = m.provider === 'anthropic' ? 'Use' : (isCached ? 'Use' : 'Load');
    return (
      <div key={m.id} role="button" tabIndex={0} aria-pressed={isCur}
        className={'pop-item' + (isCur ? ' sel' : '')} onClick={() => onPick(m)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(m); } }}>
        <div className="pi-main">
          <div className="pi-n">
            {m.name}
            {isCached && state !== 'ready' && (
              <span className="pi-cached" title="Already cached on this device — no download needed">cached</span>
            )}
          </div>
          <div className="pi-d">{m.detail}</div>
        </div>
        {state === 'loading' ? <span className="pi-state load">{m.provider === 'anthropic' ? '…' : pct + '%'}</span>
          : state === 'ready' ? <span className="pi-state ok"><Icon name="check" size={13} /> {m.provider === 'anthropic' ? 'connected' : 'loaded'}</span>
          : <span className="pi-state">{idle}</span>}
      </div>
    );
  };
  // The download bar + live status line, shown under whichever section holds the
  // model that's currently loading (GPU vs on-device CPU).
  const loadBar = (
    <React.Fragment>
      <div className="pop-bar"><div className="pop-fill" style={{ width: pct + '%' }} /></div>
      {loadText && <div className="pop-status">{loadText}</div>}
    </React.Fragment>
  );
  const footStatus = status === 'loading'
    ? (curIsCloud ? 'Connecting to ' + current.name + '…'
        : 'Downloading ' + current.name + ' — ' + pct + '% · first time only' + (curIsCpu ? ' · runs on your CPU' : ''))
    : status === 'ready'
    ? (curIsCloud ? current.name + ' is connected via the Anthropic API.'
        : curIsCpu ? current.name + ' is loaded and running on your CPU.'
        : current.name + ' is loaded and running on your GPU.')
    : 'Pick a local model to download it (one-time, then cached) or connect Claude. Grounded answers work without any model.';
  return (
    <React.Fragment>
      {/* mobile-only: a scrim behind the bottom-sheet (inert/hidden on desktop) */}
      <div className="pop-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="popover" role="dialog" aria-modal="true" aria-label="Choose a model"
           tabIndex={-1} ref={ref} style={style}>
        <div className="pop-grab" aria-hidden="true" />
        {onAuto && (() => {
          // The "let Cleo decide" row. When auto is on it shows the resolved pick
          // and the one-line reason; either way, clicking it re-probes the device
          // and loads the best model for it. A specific pick below turns auto off.
          const picked = autoModel && autoPick ? models.find(m => m.id === autoPick.id) : null;
          return (
            <React.Fragment>
              <div className="ph">Automatic</div>
              <div role="button" tabIndex={0} aria-pressed={!!autoModel}
                className={'pop-item' + (autoModel ? ' sel' : '')} onClick={() => onAuto()}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAuto(); } }}>
                <div className="pi-main">
                  <div className="pi-n">
                    Auto — best for this device
                    {picked && <span className="pi-cached" title="The model Cleo picked for this device">{picked.name}</span>}
                  </div>
                  <div className="pi-d">
                    {autoModel && autoPick && autoPick.reason ? autoPick.reason
                      : 'Let Cleo probe your device and load the model that runs best here.'}
                  </div>
                </div>
                <span className="pi-state">{autoModel ? '' : 'Use'}</span>
              </div>
            </React.Fragment>
          );
        })()}
        <div className="ph">On your GPU · WebLLM</div>
        {!webgpu && <div className="pop-status wrap">WebGPU isn’t available in this browser, so the GPU models can’t load here. Use the on-device CPU models below (no GPU needed) — or Claude, or Chrome/Edge 113+.</div>}
        {gpu.map(row)}
        {status === 'loading' && curIsGpu && loadBar}

        {cpu.length > 0 && (
          <React.Fragment>
            <div className="ph" style={{ paddingTop: 8, borderTop: '1px solid var(--border)', marginTop: 4 }}>On your CPU · WebAssembly · no GPU needed</div>
            {cpu.map(row)}
            <div className="pop-status wrap">Runs the model on your CPU — works in any browser and stands in automatically when a GPU model stalls. Slower than the GPU tier; downloads once, then cached.</div>
            {status === 'loading' && curIsCpu && !current.uploaded && loadBar}
          </React.Fragment>
        )}

        {onUploadModel && (
          <React.Fragment>
            <div className="ph" style={{ paddingTop: 8, borderTop: '1px solid var(--border)', marginTop: 4 }}>Upload your own · GGUF</div>
            {uploaded.map(row)}
            <input ref={uploadRef} type="file" accept=".gguf,application/octet-stream"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files && e.target.files[0]; if (f) onUploadModel(f); e.target.value = ''; }} />
            <button type="button" className="pop-reset" onClick={() => uploadRef.current && uploadRef.current.click()}>
              Choose a .gguf file…
            </button>
            <div className="pop-status wrap">Loads a GGUF you already have on disk into the on-device CPU runtime — handy for a model that isn’t listed above. Kept for this session only; a refresh forgets it.</div>
            {status === 'loading' && curIsCpu && current.uploaded && loadBar}
          </React.Fragment>
        )}

        <div className="ph" style={{ paddingTop: 8, borderTop: '1px solid var(--border)', marginTop: 4 }}>Cloud · Anthropic (Claude API)</div>
        {cloud.map(row)}
        <div className="pop-status wrap">
          {anthropicKeySet
            ? 'Claude is connected. Your API key is stored only in this browser and sent only to Anthropic.'
            : 'Add an Anthropic API key to use Claude. It’s stored only in this browser and sent only to Anthropic.'}
        </div>
        <div className="pop-key">
          <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…"
            aria-label="Anthropic API key" value={keyDraft}
            onChange={e => setKeyDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } }} />
          <button type="button" onClick={saveKey} disabled={!keyDraft.trim()}>{anthropicKeySet ? 'Update' : 'Save'}</button>
        </div>
        {anthropicKeySet && (
          <button type="button" className="pop-reset" onClick={() => onSetAnthropicKey('')}>
            Disconnect Claude (clear key)
          </button>
        )}

        <div className="ph" style={{ paddingTop: 8, borderTop: '1px solid var(--border)', marginTop: 4 }}>{footStatus}</div>
        {onCancel && status === 'loading' && !curIsCloud && (
          <button type="button" className="pop-reset" onClick={() => onCancel()}>
            Cancel download
          </button>
        )}
        {onReset && status !== 'ready' && !curIsCloud && !curIsCpu && (
          <button type="button" className="pop-reset" onClick={() => onReset()}>
            Stuck downloading? Clear the cache &amp; retry
          </button>
        )}
      </div>
    </React.Fragment>
  );
}

Object.assign(window, { ModelPopover });
