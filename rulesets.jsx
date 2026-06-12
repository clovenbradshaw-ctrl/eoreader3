/* ============================================================ Reading Rules drawer
   Accessible · auditable · exportable. Per-rule JSON audit, whole-set
   JSON view, Export / Copy, Import a pack, and an LLM authoring guide.
   ============================================================ */

/* serialize one rule to its auditable JSON form */
function ruleJSON(r) {
  const o = { id: r.id, name: r.name, group: r.group, phase: r.phase, layer: r.layer };
  if (r.value != null) o.value = r.value;
  o.mass = r.mass != null ? r.mass : null;
  o.src = r.src; o.enabled = !!r.enabled; o.locked = !!r.locked;
  if (r.live) o.live = true;
  o.description = r.desc;
  return o;
}
function buildExport(rules) {
  const pick = (phase) => rules.filter(r => r.installed && r.phase === phase).map(ruleJSON);
  return {
    app: 'Cleon', schema: 'cleon-rules/1', exported_at: new Date().toISOString(),
    extraction_rules: pick('extraction'),
    chat_rules: pick('chat'),
    medium_constants: pick('medium'),
  };
}
function downloadJSON(filename, obj) {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
  } catch (e) { return false; }
}
function copyText(text) {
  try { navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {} ta.remove(); return true;
  }
}

function RuleCard({ rule, onToggle, onInstall }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className={'rule-card' + (rule.installed ? ' installed' : '') + (rule.enabled ? ' enabled' : '')}>
      <div className="ric">{rule.glyph}</div>
      <div className="rule-main">
        <div className="rn">
          {rule.name}
          <span className={'phase-tag ' + rule.phase}>{rule.phase}</span>
          {rule.live && <span className="layer-tag live" title="The engine reads this at runtime">live</span>}
          {rule.locked && <span className="layer-tag" title="A medium constant — always on">locked</span>}
        </div>
        <div className="rd">{rule.desc}</div>
        <div className="rmeta">
          <span>{rule.layer}</span>
          {rule.value != null && <span>value {String(rule.value)}</span>}
          {rule.mass != null && <span>mass {rule.mass}</span>}
          <span>{rule.src}</span>
          <button className="audit-link" onClick={() => setOpen(o => !o)}>{open ? 'hide JSON' : 'audit JSON'}</button>
        </div>
        {open && <pre className="rule-json">{JSON.stringify(ruleJSON(rule), null, 2)}</pre>}
      </div>
      <div className="rule-side">
        {rule.installed
          ? <button className={'switch' + (rule.enabled ? ' on' : '')} disabled={rule.locked} onClick={() => onToggle(rule.id)} aria-label="toggle" />
          : <button className="install-btn" onClick={() => onInstall(rule.id)}>Install</button>}
        {rule.installed && !rule.locked && (
          <button className="install-btn installed" onClick={() => onInstall(rule.id)} title="Remove">Remove</button>
        )}
      </div>
    </div>
  );
}

function AuthorPanel({ onImport, onToast }) {
  const [txt, setTxt] = React.useState('');
  const [err, setErr] = React.useState('');
  const fileRef = React.useRef(null);

  const doImport = (raw) => {
    setErr('');
    let pack;
    try { pack = JSON.parse(raw); } catch (e) { setErr('That isn’t valid JSON.'); return; }
    const list = Array.isArray(pack) ? pack : (pack.rules || (pack.id ? [pack] : null));
    if (!list || !list.length) { setErr('No rules found. Expected a "rules" array (see the schema above).'); return; }
    const packName = pack.name || pack.pack || 'imported pack';
    const newRules = [];
    for (const r of list) {
      if (!r.id || !r.name) { setErr('Each rule needs at least an "id" and a "name".'); return; }
      newRules.push({
        id: r.id, name: r.name, glyph: r.glyph || (r.name[0] || '•').toUpperCase(),
        group: r.group || pack.group || 'Parsing', phase: r.phase || pack.phase || 'extraction',
        layer: r.layer || 'structure', value: r.value ?? null, mass: r.mass ?? 1,
        src: 'imported · ' + packName, installed: true, enabled: true, locked: false, live: r.value != null,
        desc: r.desc || r.description || 'Imported rule.',
      });
    }
    onImport(newRules);
    onToast(newRules.length + ' rule' + (newRules.length > 1 ? 's' : '') + ' installed from “' + packName + '”');
    setTxt('');
  };

  return (
    <div className="author">
      <div className="author-sec">Author a pack with an LLM</div>
      <p className="author-p">Paste this prompt into any model. It returns a rule-pack JSON you can drop in below.</p>
      <div className="codewrap">
        <button className="code-copy" onClick={() => { copyText(window.AUTHOR_PROMPT); onToast('Authoring prompt copied'); }}>Copy prompt</button>
        <pre className="code">{window.AUTHOR_PROMPT}</pre>
      </div>

      <div className="author-sec">Schema</div>
      <div className="codewrap">
        <button className="code-copy" onClick={() => { copyText(JSON.stringify(window.RULE_PACK_SCHEMA, null, 2)); onToast('Schema copied'); }}>Copy</button>
        <pre className="code">{JSON.stringify(window.RULE_PACK_SCHEMA, null, 2)}</pre>
      </div>

      <div className="author-sec">Import a pack</div>
      <p className="author-p">Paste a pack’s JSON, or load a <code>.json</code> file. Imported rules install enabled.</p>
      <textarea className="import-box" value={txt} onChange={e => setTxt(e.target.value)}
        placeholder='{ "pack": "legal-en", "rules": [ … ] }' />
      {err && <div className="import-err">{err}</div>}
      <div className="author-actions">
        <button className="btn-primary" onClick={() => doImport(txt)} disabled={!txt.trim()}>Add pack</button>
        <button className="btn-ghost" onClick={() => fileRef.current.click()}>Load .json…</button>
        <button className="btn-ghost" onClick={() => setTxt(window.EXAMPLE_PACK)}>Paste example</button>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => doImport(rd.result); rd.readAsText(f); e.target.value = ''; }} />
      </div>
    </div>
  );
}

/* Tier 1 — the medium: the four binding-laws (the layer ladder) and their
   read-only constants. Physics you read, not rules you toggle. */
function MediumLaws({ rules }) {
  const byId = Object.fromEntries(rules.map(r => [r.id, r]));
  const params = (window.MEDIUM_PARAM_IDS || []).map(id => byId[id]).filter(Boolean);
  return (
    <div className="tier">
      <div className="tier-head">
        <div className="rule-group-label">The medium · laws</div>
        <p className="tier-sub">The physics of reading — four binding-laws, language-independent and always on. The same for English, Mandarin, and JavaScript. You read them; you don’t toggle them.</p>
      </div>
      <div className="laws">
        {(window.MEDIUM_LAWS || []).map((law, i) => (
          <div key={i} className="law">
            <div className="law-glyph">{law.glyph}</div>
            <div className="law-body">
              <div className="law-name">{law.name}<span className={'phase-tag ' + (law.layer === 'existence' ? 'place' : law.layer === 'structure' ? 'person' : 'org')}>{law.layer}</span></div>
              <div className="law-desc">{law.desc}</div>
            </div>
          </div>
        ))}
      </div>
      {params.length > 0 && (
        <details className="medium-params">
          <summary>Constants — read live at projection, never editable as a document’s data</summary>
          <div className="params">
            {params.map(p => (
              <div key={p.id} className="param">
                <span className="param-glyph">{p.glyph}</span>
                <span className="param-name">{p.name}</span>
                <span className="param-val">{p.value != null ? String(p.value) : '—'}</span>
                <span className="param-desc">{p.desc}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/* The two-state reading mode for a language: Original (frozen, shipped-only)
   vs Self-learning (adaptive — the shipped behavior). */
function ModeToggle({ mode, disabled, onSet }) {
  const opt = (val, label, title) => (
    <button type="button" className={'mode-opt' + ((mode === 'original' ? 'original' : 'learning') === val ? ' on' : '')}
      disabled={disabled} title={title} aria-pressed={(mode === 'original' ? 'original' : 'learning') === val}
      onClick={() => !disabled && onSet(val)}>{label}</button>
  );
  return (
    <div className={'mode-toggle' + (disabled ? ' disabled' : '')} role="group" aria-label="Reading mode">
      {opt('original', 'Original', 'Frozen: only shipped tokens, no induction. The same reading every session.')}
      {opt('learning', 'Self-learning', 'Adaptive: induces conventions from each document and accrues confidence. The shipped behavior.')}
    </div>
  );
}

/* Tier 2 — one card per language ruleset: enable toggle, Original/Self-learning
   mode, and an advanced view folding in the shared narrative parsing rules. */
function LanguageCard({ entry, rules, mode, learnedCount, onToggle, onInstall, onSetMode }) {
  const [open, setOpen] = React.useState(false);
  const rule = rules.find(r => r.id === entry.ruleId);
  if (!rule) return null;
  const enabled = rule.installed && rule.enabled;
  const shared = (entry.induces ? (window.LANG_SHARED_PARSING || []) : []).map(id => rules.find(r => r.id === id)).filter(Boolean);
  return (
    <div className={'lang-card' + (enabled ? ' on' : '') + (rule.installed ? '' : ' avail')}>
      <div className="lang-row">
        <div className="ric lang-glyph">{entry.glyph}</div>
        <div className="lang-main">
          <div className="lang-name">{entry.name}
            {!rule.installed && <span className="layer-tag" title="Not installed yet">available</span>}
            {entry.induces && enabled && mode === 'original' && <span className="layer-tag" title="Frozen to its shipped baseline">original</span>}
          </div>
          <div className="lang-conv">{entry.conventions}</div>
        </div>
        <div className="rule-side">
          {rule.installed
            ? <button className={'switch' + (rule.enabled ? ' on' : '')} disabled={rule.locked} onClick={() => onToggle(rule.id)} aria-label={'Enable ' + entry.name} />
            : <button className="install-btn" onClick={() => onInstall(rule.id)}>Install</button>}
        </div>
      </div>
      <div className="lang-mode-row">
        {entry.induces
          ? <ModeToggle mode={mode} disabled={!enabled} onSet={(m) => onSetMode(entry.lang, m)} />
          : <span className="lang-det" title="No speech-verb induction on this reader — it reads the same either way">deterministic · nothing to learn</span>}
        {entry.induces && enabled && mode !== 'original' && learnedCount > 0 &&
          <span className="lang-learned">learned {learnedCount} verb{learnedCount === 1 ? '' : 's'} so far</span>}
        <button className="adv-link" onClick={() => setOpen(o => !o)}>{open ? 'hide advanced' : 'advanced'}</button>
      </div>
      {open && (
        <div className="lang-adv">
          <div className="lang-adv-conv">The per-rule granularity lives in the ledger; the card is the bundle. This ruleset governs: {entry.conventions}.</div>
          {shared.length > 0 && (
            <div className="lang-adv-rules">
              <div className="rule-group-label">Shared narrative parsing</div>
              {shared.map(r => <RuleCard key={r.id} rule={r} onToggle={onToggle} onInstall={onInstall} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RulesDrawer({ rules, langModes, learnedByLang, onToggle, onInstall, onSetLangMode, onImport, onClose, onToast }) {
  const [tab, setTab] = React.useState('rules');
  const [jsonView, setJsonView] = React.useState(false);
  const byId = Object.fromEntries(rules.map(r => [r.id, r]));
  const grounding = (window.GROUNDING_IDS || []).map(id => byId[id]).filter(Boolean);
  const depth = (window.DEPTH_IDS || []).map(id => byId[id]).filter(Boolean);
  const enabledCount = rules.filter(r => r.installed && r.enabled).length;
  const exportObj = buildExport(rules);
  const dialogRef = window.useDialog(onClose);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Reading rules"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Rules</h2>
            <button className="x" onClick={onClose} aria-label="Close rules"><Icon name="x" size={18} /></button>
          </div>
          <p>Three layers. The <b>medium</b> is the physics — laws you read but can’t break. The <b>language rulesets</b> plug in and out: pick a language and a mode, Original or Self-learning. <b>Grounding</b> is how answers are cited and audited. The model only phrases what these decide; all of it is auditable and exportable as JSON.</p>
        </div>

        <div className="drawer-tabs">
          <button className={'drawer-tab' + (tab === 'rules' ? ' on' : '')} onClick={() => setTab('rules')}>Rules · {enabledCount} on</button>
          <button className={'drawer-tab' + (tab === 'author' ? ' on' : '')} onClick={() => setTab('author')}>Author / Import</button>
          <div style={{ flex: 1 }} />
          {tab === 'rules' && (
            <div className="drawer-tools">
              <button className={'mini-btn' + (jsonView ? ' on' : '')} onClick={() => setJsonView(v => !v)} title="View as JSON"><Icon name="grid" size={13} /> JSON</button>
              <button className="mini-btn" onClick={() => { copyText(JSON.stringify(exportObj, null, 2)); onToast('Ruleset JSON copied'); }} title="Copy JSON"><Icon name="copy" size={13} /></button>
              <button className="mini-btn primary" onClick={() => { downloadJSON('eo-reading-rules.json', exportObj); onToast('Exported eo-reading-rules.json'); }} title="Export JSON"><Icon name="upload" size={13} /> Export</button>
            </div>
          )}
        </div>

        <div className="drawer-body">
          {tab === 'author'
            ? <AuthorPanel onImport={onImport} onToast={onToast} />
            : jsonView
              ? <pre className="ruleset-json">{JSON.stringify(exportObj, null, 2)}</pre>
              : (
                <React.Fragment>
                  <MediumLaws rules={rules} />

                  <div className="tier">
                    <div className="tier-head">
                      <div className="rule-group-label">Language rulesets · the ruliad</div>
                      <p className="tier-sub">Surface conventions that plug in and out. Each law above reads its labels from the active language — “same sign repels” is a law; which token is “she” is a ruleset. Pick a language and a mode.</p>
                    </div>
                    {(window.LANGUAGES || []).map(entry => (
                      <LanguageCard key={entry.lang} entry={entry} rules={rules}
                        mode={(langModes && langModes[entry.lang]) || 'learning'}
                        learnedCount={(learnedByLang && learnedByLang[entry.lang]) || 0}
                        onToggle={onToggle} onInstall={onInstall} onSetMode={onSetLangMode} />
                    ))}
                  </div>

                  <div className="tier">
                    <div className="tier-head">
                      <div className="rule-group-label">Grounding · how answers are checked</div>
                      <p className="tier-sub">Cross-cutting, language-independent QA: how a claim is cited, paraphrase-checked, and audited. Not a language convention — its own layer.</p>
                    </div>
                    {grounding.length
                      ? grounding.map(r => <RuleCard key={r.id} rule={r} onToggle={onToggle} onInstall={onInstall} />)
                      : <div className="empty-doc" style={{ padding: 20 }}>No grounding rules.</div>}
                  </div>

                  {depth.length > 0 && (
                    <div className="tier">
                      <div className="tier-head">
                        <div className="rule-group-label">Thinking depth · how hard a turn thinks</div>
                        <p className="tier-sub">What every turn spends. Each knob’s value is the ceiling, and the turn runs at it — iterative seek rounds, associative wander, working-memory carry-forward, the inference void, and reconsideration are all live. Turn one off to cap that kind of effort.</p>
                      </div>
                      {depth.map(r => <RuleCard key={r.id} rule={r} onToggle={onToggle} onInstall={onInstall} />)}
                    </div>
                  )}
                </React.Fragment>
              )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ Model popover */
function ModelPopover({ models, current, onPick, onClose, anchor, status, progress, loadText, onReset, onCancel }) {
  const ref = window.useDialog(onClose);
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
  const local = models.filter(m => m.provider !== 'anthropic');
  const cloud = models.filter(m => m.provider === 'anthropic');
  const curIsCloud = current.provider === 'anthropic';
  const saveKey = () => { const k = keyDraft.trim(); if (k) { onSetAnthropicKey(k); setKeyDraft(''); } };
  const row = (m) => {
    const isCur = m.id === current.id;
    const state = isCur ? status : 'idle';
    const idle = m.provider === 'anthropic' ? 'Use' : 'Load';
    return (
      <div key={m.id} role="button" tabIndex={0} aria-pressed={isCur}
        className={'pop-item' + (isCur ? ' sel' : '')} onClick={() => onPick(m)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(m); } }}>
        <div className="pi-main">
          <div className="pi-n">{m.name}</div>
          <div className="pi-d">{m.detail}</div>
        </div>
        {state === 'loading' ? <span className="pi-state load">{m.provider === 'anthropic' ? '…' : pct + '%'}</span>
          : state === 'ready' ? <span className="pi-state ok"><Icon name="check" size={13} /> {m.provider === 'anthropic' ? 'connected' : 'loaded'}</span>
          : <span className="pi-state">{idle}</span>}
      </div>
    );
  };
  return (
    <div className="popover" role="dialog" aria-modal="true" aria-label="Choose a model"
         tabIndex={-1} ref={ref} style={style}>
      <div className="ph">Local model · runs on your GPU</div>
      {!webgpu && <div className="pop-status wrap">WebGPU isn’t available in this browser, so local models can’t load here. Use Claude below, or try Chrome/Edge 113+.</div>}
      {local.map(row)}
      {status === 'loading' && !curIsCloud && (
        <div className="pop-bar"><div className="pop-fill" style={{ width: pct + '%' }} /></div>
      )}
      {status === 'loading' && !curIsCloud && loadText && <div className="pop-status">{loadText}</div>}

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

      <div className="ph" style={{ paddingTop: 8, borderTop: '1px solid var(--border)', marginTop: 4 }}>
        {status === 'loading' ? (curIsCloud ? 'Connecting to ' + current.name + '…' : 'Downloading ' + current.name + ' — ' + pct + '% · first time only')
          : status === 'ready' ? (curIsCloud ? current.name + ' is connected via the Anthropic API.' : current.name + ' is loaded and running on your GPU.')
          : 'Pick a local model to download it (one-time, then cached) or connect Claude above. Grounded answers work without either.'}
      </div>
      {onCancel && status === 'loading' && !curIsCloud && (
        <button type="button" className="pop-reset" onClick={() => onCancel()}>
          Cancel download
        </button>
      )}
      {onReset && status !== 'ready' && !curIsCloud && (
        <button type="button" className="pop-reset" onClick={() => onReset()}>
          Stuck downloading? Clear the cache &amp; retry
        </button>
      )}
    </div>
  );
}

Object.assign(window, { RulesDrawer, ModelPopover, buildExport, ruleJSON, MediumLaws, LanguageCard, ModeToggle });
