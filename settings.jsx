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

function SettingsDrawer({ onClose, theme, onTheme, reduceMotion, onReduceMotion,
                         pythonEnabled, onPythonEnabled, pythonAvailable,
                         groundingInfo, onGroundingInfo, wikiMode, onWikiMode,
                         onClearData, storageOK }) {
  const dialogRef = window.useDialog(onClose);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const THEMES = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  // Reference desk (Wikipedia) — a tri-state mirroring the answer-mode control.
  const WIKI_MODES = [
    { id: 'off', label: 'Off', sub: 'Never contacts Wikipedia. Fully local.' },
    { id: 'auto', label: 'Auto', sub: 'Looks something up only when you ask to (a “look up X” style request) and it isn’t already in your documents.' },
    { id: 'on', label: 'On', sub: 'Attaches a Wikipedia + Wiktionary card to every message.' },
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
          <p>Preferences for this device. Everything Cleon keeps — these settings, your documents and chats, and what the engine learns — stays in this browser.</p>
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

          {pythonAvailable && (
            <section className="set-section">
              <h3 className="set-h">Computation</h3>

              <div className="set-row">
                <div className="set-row-main">
                  <div className="set-label">Run Python over your documents</div>
                  <div className="set-sub">Lets Cleon run Python locally to answer computational questions a reader can't — sum a column, count rows, group a CSV. The code it runs and the output it gets are recorded in the glass box, and it all runs entirely on your device. Off by default.</div>
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
