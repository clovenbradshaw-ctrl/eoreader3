/* ============================================================ Settings drawer
   Device-local preferences, gathered in one place: appearance (theme +
   reduced motion) and a privacy/data panel that surfaces the local-only
   storage promise and the one destructive affordance — clearing it all.

   Everything here is persisted through the existing prefs channel
   (window.EOStore.savePrefs) by App; this component is pure presentation.
   ============================================================ */

// Resolve a theme preference ('system' | 'light' | 'dark') to a concrete
// palette and pin it on <html data-theme>. 'system' follows the OS via
// matchMedia; App re-runs this when the OS preference flips. Returns the
// resolved value ('light' | 'dark'). The same logic runs as an inline head
// script in index.html so the first paint already carries the right palette.
function applyTheme(theme) {
  const dark = theme === 'dark'
    || (theme !== 'light' && typeof matchMedia === 'function'
        && matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = dark ? 'dark' : 'light';
  try { document.documentElement.setAttribute('data-theme', resolved); } catch (e) {}
  return resolved;
}
window.EOTheme = { apply: applyTheme };

/* ============================================================ Models & adapters
   The user-facing model picker for the perceptual/parsing adapter library
   (window.EOAdapters). It mirrors the local-LLM picker's visual language and its
   disclosure-of-bytes pattern: each option shows its backend, the download it
   implies, and its rough latency, and an adapter that can't run on this device's
   backend (e.g. WebGPU required, none present) renders disabled with the reason.

   Capabilities are DISCOVERED from the registry, never enumerated here — add an
   adapter and its capability appears in this list on its own. Selecting an
   option writes localStorage (eo.adapters.preferred.<capability>) and fires the
   eo.adapters.changed event the registry's selected() reads.
   ============================================================ */
function fmtAdapterBytes(n) {
  if (!n || !isFinite(n)) return '';
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  return Math.round(n / (1024 * 1024)) + ' MB';
}
// "ocr" → "Ocr", "image-text-embed" → "Image Text Embed". Derived, not enumerated.
function humanizeCapability(cap) {
  return String(cap || '').split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}
// The disclosure line beside each adapter: backend · download/footprint · latency.
function adapterResourceLabel(m) {
  const r = (m && m.resources) || {};
  const bits = [];
  if (r.backend) bits.push(r.backend);
  const wb = m.modelRef && m.modelRef.weightsBytes;
  if (wb) bits.push('~' + fmtAdapterBytes(wb) + ' download');
  else if (r.memMB) bits.push('~' + r.memMB + ' MB');
  if (r.expectedLatencyMs) bits.push(r.expectedLatencyMs >= 1000 ? '~' + (r.expectedLatencyMs / 1000).toFixed(1) + 's' : '~' + r.expectedLatencyMs + 'ms');
  return bits.join(' · ');
}

function ModelsAdaptersSection() {
  const A = window.EOAdapters;
  // Re-render whenever a selection or the profile changes (the registry fires
  // this event from setPreferred/setProfile).
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!A) return undefined;
    const h = () => setTick(t => t + 1);
    window.addEventListener('eo.adapters.changed', h);
    return () => window.removeEventListener('eo.adapters.changed', h);
  }, []);
  if (!A || typeof A.capabilities !== 'function') return null;
  const caps = A.capabilities();
  if (!caps.length) return null;

  const PROFILES = [
    { id: 'browser', label: 'Browser', sub: 'minimum' },
    { id: 'desktop', label: 'Desktop', sub: 'recommended' },
    { id: 'maximum', label: 'Maximum', sub: 'quality' },
  ];
  const profile = A.profile();

  return (
    <section className="set-section">
      <h3 className="set-h">Models &amp; adapters</h3>

      <div className="set-row set-row-col">
        <div className="set-row-main">
          <div className="set-label">Performance profile</div>
          <div className="set-sub">A hint for which model to use per task when you haven’t picked one. <b>Browser</b> favors the smallest model everywhere, <b>Desktop</b> a balanced middle, <b>Maximum</b> the heaviest available.</div>
        </div>
        <div className="set-seg" role="group" aria-label="Performance profile">
          {PROFILES.map(p => (
            <button key={p.id} className={profile === p.id ? 'on' : ''}
                    aria-pressed={profile === p.id} title={p.sub}
                    onClick={() => A.setProfile(p.id)}>{p.label}</button>
          ))}
        </div>
      </div>

      {caps.map(cap => {
        const lst = A.byCapability(cap);
        const sel = A.selected(cap);
        const prefId = A.preferred(cap) || '';
        const modality = lst[0] && lst[0].manifest.modality;
        return (
          <div className="set-row set-row-col" key={cap}>
            <div className="set-row-main">
              <div className="set-label">{humanizeCapability(cap)}{modality ? <span className="set-cap-mod">{modality}</span> : null}</div>
              <div className="set-sub">{lst.length} adapter{lst.length === 1 ? '' : 's'} · using <b>{sel ? sel.manifest.name : 'none available on this device'}</b></div>
            </div>
            <select className="set-select" value={prefId} aria-label={humanizeCapability(cap) + ' adapter'}
                    onChange={e => A.setPreferred(cap, e.target.value || null)}>
              <option value="">Auto{sel ? ' — ' + sel.manifest.name : ''}</option>
              {lst.map(a => {
                const can = A.canRun(a);
                return (
                  <option key={a.manifest.id} value={a.manifest.id} disabled={!can.ok}>
                    {a.manifest.name} — {adapterResourceLabel(a.manifest)}{can.ok ? '' : ' · ' + can.reason}
                  </option>
                );
              })}
            </select>
          </div>
        );
      })}
    </section>
  );
}

function SettingsDrawer({ onClose, theme, onTheme, reduceMotion, onReduceMotion,
                         pythonEnabled, onPythonEnabled, pythonAvailable,
                         groundingInfo, onGroundingInfo,
                         showModeToggle, onShowModeToggle, wikiMode, onWikiMode,
                         models, defaultModelId, onDefaultModel, autoModel,
                         fallbackModelIds, onFallbackModelIds,
                         onClearData, storageOK }) {
  const dialogRef = window.useDialog(onClose);
  const [confirmClear, setConfirmClear] = React.useState(false);
  // Local storage health: how much of the origin's quota the cached model
  // shards (and everything else Cleon keeps) are using, plus whether the
  // browser has promised not to evict them. Surfaces the "no hard
  // redownload" guarantee: a persisted origin's models stay cached across
  // sessions; a best-effort origin can be wiped under storage pressure.
  const [storage, setStorage] = React.useState(null);
  const [persisted, setPersisted] = React.useState(null);
  React.useEffect(() => {
    const L = window.EOLLM;
    let alive = true;
    (async () => {
      try {
        const est = L && L.storageEstimate ? await L.storageEstimate() : null;
        if (alive) setStorage(est);
      } catch (_) {}
      try {
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persisted === 'function') {
          const ok = await navigator.storage.persisted();
          if (alive) setPersisted(!!ok);
        }
      } catch (_) {}
    })();
    return () => { alive = false; };
  }, []);
  const fmtMB = (n) => {
    if (!n || !isFinite(n)) return '0 MB';
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    return Math.round(n / (1024 * 1024)) + ' MB';
  };
  const askPersist = async () => {
    try {
      const L = window.EOLLM;
      const ok = L && L.persistStorage ? await L.persistStorage() : false;
      setPersisted(!!ok);
    } catch (_) {}
  };

  const THEMES = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  // Reference desk (Wikipedia) — a tri-state mirroring the answer-mode control.
  const WIKI_MODES = [
    { id: 'off', label: 'Off', sub: 'Never contacts Wikipedia. Fully local.' },
    { id: 'auto', label: 'Auto', sub: 'When you ask to look something up (a “look up X” request) and it isn’t already in your documents, searches Wikipedia and offers matching articles — you pick which to pull in.' },
    { id: 'on', label: 'On', sub: 'Searches Wikipedia for every message and offers matching articles to research. Nothing is pulled in until you pick one.' },
  ];
  const wikiSub = (WIKI_MODES.find(w => w.id === wikiMode) || WIKI_MODES[1]).sub;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer settings-drawer" role="dialog" aria-modal="true" aria-label="Settings"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Settings</h2>
            <button className="x" onClick={onClose} aria-label="Close settings"><Icon name="x" size={18} /></button>
          </div>
          <p>Preferences for this device. Everything Cleo keeps — these settings, your documents and chats, and what the engine learns — stays in this browser.</p>
        </div>

        <div className="drawer-body set-body">
          <section className="set-section">
            <h3 className="set-h">Appearance</h3>

            <div className="set-row">
              <div className="set-row-main">
                <div className="set-label">Theme</div>
                <div className="set-sub">Match your system, or pin light or dark.</div>
              </div>
              <div className="set-seg" role="group" aria-label="Theme">
                {THEMES.map(t => (
                  <button key={t.id} className={theme === t.id ? 'on' : ''}
                          aria-pressed={theme === t.id} onClick={() => onTheme(t.id)}>{t.label}</button>
                ))}
              </div>
            </div>

            <div className="set-row">
              <div className="set-row-main">
                <div className="set-label">Reduce motion</div>
                <div className="set-sub">Minimize animations and transitions across the app.</div>
              </div>
              <button className={'switch' + (reduceMotion ? ' on' : '')} role="switch"
                      aria-checked={reduceMotion} aria-label="Reduce motion"
                      onClick={() => onReduceMotion(!reduceMotion)} />
            </div>
          </section>

          {Array.isArray(models) && models.length > 0 && onDefaultModel && (
            <section className="set-section">
              <h3 className="set-h">Model</h3>

              <div className="set-row set-row-col">
                <div className="set-row-main">
                  <div className="set-label">Default model</div>
                  <div className="set-sub">The model loaded at startup and used for every turn. Switching here loads it immediately and remembers it across refreshes. <b>Auto</b> probes your device and picks the model that runs best here.</div>
                </div>
                <select className="set-select" value={defaultModelId || (autoModel ? 'auto' : '')}
                        aria-label="Default model"
                        onChange={(e) => onDefaultModel(e.target.value)}>
                  <option value="auto">Auto — best for this device</option>
                  {models.map(m => (
                    <option key={m.id} value={m.id}>{m.name}{m.detail ? ' — ' + m.detail : ''}</option>
                  ))}
                </select>
              </div>

              <div className="set-row set-row-col">
                <div className="set-row-main">
                  <div className="set-label">Backups</div>
                  <div className="set-sub">If the default fails to load (no WebGPU, a stalled download, a missing API key), Cleo walks this list in order until one loads. Leave a slot on “None” to skip it.</div>
                </div>
                <div className="set-fallbacks">
                  {[0, 1, 2].map(i => (
                    <label key={i} className="set-fallback">
                      <span className="set-fallback-n">{i + 1}</span>
                      <select className="set-select" value={(fallbackModelIds && fallbackModelIds[i]) || ''}
                              aria-label={'Backup model ' + (i + 1)}
                              onChange={(e) => {
                                const next = (fallbackModelIds || [null, null, null]).slice();
                                next[i] = e.target.value || null;
                                onFallbackModelIds(next);
                              }}>
                        <option value="">None</option>
                        {models.map(m => (
                          <option key={m.id} value={m.id}>{m.name}{m.detail ? ' — ' + m.detail : ''}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </section>
          )}

          <ModelsAdaptersSection />

          {pythonAvailable && (
            <section className="set-section">
              <h3 className="set-h">Computation</h3>

              <div className="set-row">
                <div className="set-row-main">
                  <div className="set-label">Run Python over your documents</div>
                  <div className="set-sub">Lets Cleo run Python locally to answer computational questions a reader can't — sum a column, count rows, group a CSV. The code it runs and the output it gets are recorded in the glass box, and it all runs entirely on your device. On by default; the runtime downloads only on the first actual run.</div>
                </div>
                <button className={'switch' + (pythonEnabled ? ' on' : '')} role="switch"
                        aria-checked={!!pythonEnabled} aria-label="Run Python over your documents"
                        onClick={() => onPythonEnabled(!pythonEnabled)} />
              </div>
            </section>
          )}

          <section className="set-section">
            <h3 className="set-h">Answers</h3>

            <div className="set-row">
              <div className="set-row-main">
                <div className="set-label">Answer mode control</div>
                <div className="set-sub">Show the Auto · Verbatim · Grounded · Creative buttons in the message box. Off keeps every chat on Auto — it reads each question and grounds or composes on its own. On lets you pin <b>Verbatim</b> (quote passages straight from the document, word for word), <b>Grounded</b> (answer from the document, synthesized), or <b>Creative</b> (compose freely, not fact-checked) for a chat.</div>
              </div>
              <button className={'switch' + (showModeToggle ? ' on' : '')} role="switch"
                      aria-checked={!!showModeToggle} aria-label="Answer mode control"
                      onClick={() => onShowModeToggle(!showModeToggle)} />
            </div>

            <div className="set-row">
              <div className="set-row-main">
                <div className="set-label">Grounding details</div>
                <div className="set-sub">Show the “grounded · covers · stable” badge and its note beneath each answer. Turn off for a cleaner reply; citations and the glass-box trace are unaffected.</div>
              </div>
              <button className={'switch' + (groundingInfo !== false ? ' on' : '')} role="switch"
                      aria-checked={groundingInfo !== false} aria-label="Grounding details"
                      onClick={() => onGroundingInfo(groundingInfo === false)} />
            </div>
          </section>

          <section className="set-section">
            <h3 className="set-h">Reference desk</h3>

            <div className="set-row">
              <div className="set-row-main">
                <div className="set-label">Wikipedia reference desk</div>
                <div className="set-sub">{wikiSub}</div>
              </div>
              <div className="set-seg" role="group" aria-label="Wikipedia reference desk">
                {WIKI_MODES.map(w => (
                  <button key={w.id} className={wikiMode === w.id ? 'on' : ''}
                          aria-pressed={wikiMode === w.id} onClick={() => onWikiMode(w.id)}>{w.label}</button>
                ))}
              </div>
            </div>
          </section>

          <section className="set-section">
            <h3 className="set-h">Privacy &amp; data</h3>

            <div className={'set-note' + (storageOK ? '' : ' warn')}>
              <Icon name={storageOK ? 'check' : 'activity'} size={15} />
              <span>{storageOK
                ? 'Saved on this device only — nothing is uploaded. A refresh keeps your workspace.'
                : 'Local storage is unavailable here, so this session won’t persist after you close the tab.'}</span>
            </div>

            {storage && (
              <div className="set-row">
                <div className="set-row-main">
                  <div className="set-label">Storage on this device</div>
                  <div className="set-sub">
                    {fmtMB(storage.usage)}{storage.quota ? ' of ' + fmtMB(storage.quota) + ' available' : ''} —
                    {' '}covers everything Cleon keeps, including any model weights you’ve downloaded so they don’t fetch again.
                    {persisted === true && ' This origin is persistent, so the cache won’t be evicted under storage pressure.'}
                    {persisted === false && ' This origin is best-effort, so the browser may evict cached models. Mark persistent to keep them.'}
                  </div>
                </div>
                {persisted === false && (
                  <button className="mini-btn" onClick={askPersist}>Mark persistent</button>
                )}
              </div>
            )}

            <div className="set-row">
              <div className="set-row-main">
                <div className="set-label">Clear local data</div>
                <div className="set-sub">Permanently delete every document, chat, the glass-box trace, the engine’s learned rules, and these preferences from this browser. This can’t be undone.</div>
              </div>
              {confirmClear ? (
                <div className="set-confirm">
                  <button className="mini-btn" onClick={() => setConfirmClear(false)}>Cancel</button>
                  <button className="mini-btn danger" onClick={onClearData}>Delete everything</button>
                </div>
              ) : (
                <button className="mini-btn danger-outline" disabled={!storageOK}
                        onClick={() => setConfirmClear(true)}>Clear…</button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

window.SettingsDrawer = SettingsDrawer;
