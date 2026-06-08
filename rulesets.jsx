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

function RulesDrawer({ rules, onToggle, onInstall, onImport, onClose, onToast }) {
  const [tab, setTab] = React.useState('installed');
  const [jsonView, setJsonView] = React.useState(false);
  const groups = window.RULE_GROUPS;
  const visible = rules.filter(r => tab === 'installed' ? r.installed : !r.installed);
  const enabledCount = rules.filter(r => r.installed && r.enabled).length;
  const availCount = rules.filter(r => !r.installed).length;
  const exportObj = buildExport(rules);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Rules</h2>
            <button className="x" onClick={onClose}><Icon name="x" size={18} /></button>
          </div>
          <p>Every rule Cleon applies — how it finds names, attributes speech, retrieves, and checks its own answers. The model only phrases what these rules decide. Install, remove, or switch any off; the locked ones are constants of the medium. All of it is auditable and exportable as JSON.</p>
        </div>

        <div className="drawer-tabs">
          <button className={'drawer-tab' + (tab === 'installed' ? ' on' : '')} onClick={() => setTab('installed')}>Installed · {enabledCount} on</button>
          <button className={'drawer-tab' + (tab === 'available' ? ' on' : '')} onClick={() => setTab('available')}>Available{availCount ? ' · ' + availCount : ''}</button>
          <button className={'drawer-tab' + (tab === 'author' ? ' on' : '')} onClick={() => setTab('author')}>Author / Import</button>
          <div style={{ flex: 1 }} />
          {tab !== 'author' && (
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
              : groups.map(g => {
                  const items = visible.filter(r => r.group === g);
                  if (!items.length) return null;
                  return (
                    <div key={g}>
                      <div className="rule-group-label">{g}</div>
                      {items.map(r => <RuleCard key={r.id} rule={r} onToggle={onToggle} onInstall={onInstall} />)}
                    </div>
                  );
                })}
          {tab !== 'author' && !jsonView && !visible.length && <div className="empty-doc" style={{ padding: 40 }}>Nothing here yet.</div>}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ Model popover */
function ModelPopover({ models, current, onPick, onClose, anchor, status, progress }) {
  const ref = React.useRef(null);
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
  return (
    <div className="popover" ref={ref} style={style}>
      <div className="ph">Local model · runs on your GPU</div>
      {models.map(m => {
        const isCur = m.id === current.id;
        const state = isCur ? status : 'idle';
        return (
          <div key={m.id} className={'pop-item' + (isCur ? ' sel' : '')} onClick={() => onPick(m)}>
            <div className="pi-main">
              <div className="pi-n">{m.name}</div>
              <div className="pi-d">{m.detail}</div>
            </div>
            {state === 'loading' ? <span className="pi-state load">{pct}%</span>
              : state === 'ready' ? <span className="pi-state ok"><Icon name="check" size={13} /> loaded</span>
              : <span className="pi-state">Load</span>}
          </div>
        );
      })}
      {status === 'loading' && (
        <div className="pop-bar"><div className="pop-fill" style={{ width: pct + '%' }} /></div>
      )}
      <div className="ph" style={{ paddingTop: 8, borderTop: '1px solid var(--border)', marginTop: 4 }}>
        {status === 'loading' ? 'Downloading ' + current.name + ' — ' + pct + '% · first time only'
          : status === 'ready' ? current.name + ' is loaded and running on your GPU.'
          : 'Pick a model to download it (one-time, then cached). Grounded answers work without one.'}
      </div>
    </div>
  );
}

Object.assign(window, { RulesDrawer, ModelPopover, buildExport, ruleJSON });
