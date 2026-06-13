/* ============================================================
   reference.jsx — the Reference Desk, in the document pane.

   The shipped face of the external-knowledge stratum (external.js). Two
   registers for one term: the encyclopaedia article (Wikipedia) and the
   lexicon entry (Wiktionary), fetched through the app's proxy, rate-limited
   and abstaining by the rules in external.js.

   Two components, both attached to window for docview.jsx:

     • ReferenceDesk     — the two columns for a single term (an entity view).
     • ReferenceDeskBar  — the prioritised batch: rank the reader's residual by
                           how serious the gap is and spend a budget of live
                           lookups on the worst holes first.

   Privacy is explicit, not ambient: nothing is queried until the user grants a
   remembered consent, and the desk is inert when window.EO_REFERENCE_PROXY is
   cleared. Every result shows its basis (source host + fetch time).
   ============================================================ */

const REF_HOST = { wikipedia: 'en.wikipedia.org', wiktionary: 'en.wiktionary.org' };

function refX() { return (typeof window !== 'undefined' && window.EOExternal) || null; }
function refEnabled() { const X = refX(); return !!(X && X.enabled && X.enabled()); }
function proxyHost() {
  try { const X = refX(); const u = X && X.cfg && X.cfg().proxy; return u ? new URL(u).host : ''; }
  catch (e) { return ''; }
}
function fmtWhen(iso) {
  if (!iso) return '';
  try { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return iso; }
}

/* A one-time, remembered grant before the first off-device query. */
function RefConsent({ term, label, onGrant }) {
  const host = proxyHost();
  return (
    <div className="refdesk-consent">
      <div className="refdesk-consent-body">
        <Icon name="search" size={14} />
        <span>{label || <span>Look up <b>{term}</b> outside the document?</span>} This sends the term to
          Wikipedia &amp; Wiktionary {host ? <span>through your proxy (<code>{host}</code>)</span> : 'through your proxy'}.
          Nothing else from the page leaves the device.</span>
      </div>
      <button className="refdesk-go" onClick={onGrant}>Look it up</button>
    </div>
  );
}

/* The provenance footer a result carries — the basis stamp, made visible. */
function RefBasis({ basis, cached }) {
  if (!basis) return null;
  const host = (basis.src && REF_HOST[basis.src]) || basis.src;
  return (
    <div className="refdesk-basis">
      via <code>{host}</code> · {cached ? 'cached' : 'fetched'} {fmtWhen(basis.fetched_at)}
      {basis.url ? <span> · <a href={basis.url} target="_blank" rel="noopener">source</a></span> : null}
    </div>
  );
}

/* ---- the encyclopaedia column (Wikipedia) ---- */
function EncColumn({ result, type }) {
  if (!result) return <p className="refdesk-placeholder">—</p>;
  if (result.status === 'gated') return <p className="refdesk-note">Suppressed — this reads as a private individual the document names. The desk does not resolve people against the world.</p>;
  if (result.status === 'disabled') return <p className="refdesk-note">Lookups are off (the proxy is cleared).</p>;
  if (result.status === 'error') return <p className="refdesk-err">Couldn’t reach Wikipedia. <code>{result.error}</code></p>;
  if (result.status === 'miss' || !result.payload) return (
    <React.Fragment><p className="refdesk-placeholder">No article found.</p><RefBasis basis={result.basis} cached={result.cached} /></React.Fragment>
  );
  const p = result.payload;
  const suggest = p.typeGuess && p.typeGuess !== type ? p.typeGuess : null;
  return (
    <div className="refdesk-enc">
      {p.thumbnail ? <img className="refdesk-thumb" alt="" src={p.thumbnail} /> : null}
      <h4 className="refdesk-headword">
        {p.page ? <a href={p.page} target="_blank" rel="noopener">{p.title}</a> : p.title}
      </h4>
      {p.description ? <p className="refdesk-desc">{p.description}</p> : null}
      {suggest ? (
        <p className="refdesk-suggest">Wikipedia reads this as a <b>{suggest}</b> — the document’s reading has it as <b>{type}</b>. A proposal, not a change.</p>
      ) : null}
      <p className="refdesk-summary">{p.extract || 'No summary available.'}</p>
      {p.others && p.others.length ? (
        <div className="refdesk-seealso">
          <div className="refdesk-lbl">Other matches</div>
          {p.others.map((h, i) => (
            <div key={i} className="refdesk-hit"><b>{h.title}</b>{h.snippet ? <span className="refdesk-snip"> — {h.snippet}…</span> : null}</div>
          ))}
        </div>
      ) : null}
      <RefBasis basis={result.basis} cached={result.cached} />
    </div>
  );
}

/* ---- the lexicon column (Wiktionary) ---- */
function LexColumn({ result }) {
  if (!result) return <p className="refdesk-placeholder">—</p>;
  if (result.status === 'disabled') return <p className="refdesk-note">Lookups are off (the proxy is cleared).</p>;
  if (result.status === 'error') return <p className="refdesk-err">Couldn’t reach Wiktionary. <code>{result.error}</code></p>;
  if (result.status === 'miss' || !result.payload || !result.payload.entries.length) return (
    <React.Fragment><p className="refdesk-placeholder">No dictionary entry.</p><RefBasis basis={result.basis} cached={result.cached} /></React.Fragment>
  );
  return (
    <div className="refdesk-lex">
      {result.payload.entries.map((g, gi) => (
        <div key={gi} className="refdesk-pos">
          <span className="refdesk-pos-label">{String(g.partOfSpeech || '—').toLowerCase()}</span>
          <ol className="refdesk-defs">
            {g.definitions.slice(0, 6).map((d, di) => (
              <li key={di}>{d.definition}{d.example ? <span className="refdesk-ex">{d.example}</span> : null}</li>
            ))}
          </ol>
        </div>
      ))}
      <RefBasis basis={result.basis} cached={result.cached} />
    </div>
  );
}

/* The desk for ONE term: two columns, with a consent gate and lazy fetch.
   `autostart` skips the per-term button (used inside the batch results). */
function ReferenceDesk({ term, type, autostart }) {
  const X = refX();
  const [consented, setConsented] = React.useState(() => !!(X && X.hasConsent && X.hasConsent()));
  const [state, setState] = React.useState({ loading: false, data: null });
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const fetchNow = React.useCallback(() => {
    if (!X) return;
    setState({ loading: true, data: null });
    X.refdesk(term, { type }).then((res) => {
      if (mounted.current) setState({ loading: false, data: res });
    }, (e) => {
      if (mounted.current) setState({ loading: false, data: { encyclopaedia: { status: 'error', error: String(e && e.message || e) }, lexicon: { status: 'error', error: String(e && e.message || e) } } });
    });
  }, [term, type, X]);

  React.useEffect(() => {
    if (consented && autostart && !state.data && !state.loading) fetchNow();
  }, [consented, autostart]); // eslint-disable-line

  // Off (proxy cleared) → render nothing; the reader stays strictly local and
  // the entity views are uncluttered for anyone not using the desk.
  if (!refEnabled()) return null;

  const grant = () => { if (X && X.grantConsent) X.grantConsent(); setConsented(true); if (autostart) fetchNow(); };

  return (
    <div className="refdesk">
      <div className="refdesk-head">
        <Icon name="book" size={14} /> <span className="refdesk-title">Reference desk</span>
        <span className="refdesk-sub">{term}</span>
        <div style={{ flex: 1 }} />
        {consented && !autostart ? (
          <button className="refdesk-go small" onClick={fetchNow} disabled={state.loading}>
            {state.loading ? 'looking…' : state.data ? 'refresh' : 'look up'}
          </button>
        ) : null}
      </div>
      {!consented ? <RefConsent term={term} onGrant={grant} />
        : state.loading && !state.data ? <p className="refdesk-loading">querying Wikipedia &amp; Wiktionary…</p>
        : !state.data ? <p className="refdesk-placeholder">Press “look up” to pull the article and the word.</p>
        : (
          <div className="refdesk-columns">
            <section className="refdesk-col enc">
              <div className="refdesk-col-head"><span className="mark enc">Encyclopædia</span><span className="src">en.wikipedia.org</span></div>
              <EncColumn result={state.data.encyclopaedia} type={type} />
            </section>
            <section className="refdesk-col lex">
              <div className="refdesk-col-head"><span className="mark lex">Lexicon</span><span className="src">en.wiktionary.org</span></div>
              <LexColumn result={state.data.lexicon} />
            </section>
          </div>
        )}
    </div>
  );
}

/* The prioritised batch over a document's residual. Ranks the entities the
   reader left generically-typed (classifyNeeds), then spends a budget of live
   lookups on the most serious first — the visible expression of the rate
   limiter and the priority queue. */
function ReferenceDeskBar({ entities, budget }) {
  const X = refX();
  const needs = React.useMemo(() => (X && X.classifyNeeds ? X.classifyNeeds(entities || []) : []), [entities, X]);
  const cap = Math.min(needs.length, budget || (X && X.cfg && X.cfg().budget) || 12);
  const [consented, setConsented] = React.useState(() => !!(X && X.hasConsent && X.hasConsent()));
  const [run, setRun] = React.useState({ active: false, done: 0, results: [] });
  const [open, setOpen] = React.useState(null);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  if (!refEnabled() || !needs.length) return null;

  const go = () => {
    if (X && X.grantConsent && !consented) { X.grantConsent(); setConsented(true); }
    setRun({ active: true, done: 0, results: [] });
    const collected = [];
    X.resolveNeeds(needs, {
      budget: cap,
      onResult: (need, result) => {
        collected.push({ need, result });
        if (mounted.current) setRun(r => ({ active: true, done: collected.length, results: collected.slice() }));
      },
    }).then(() => { if (mounted.current) setRun(r => ({ ...r, active: false })); });
  };

  const liveCount = run.results.filter(r => r.result.status === 'hit').length;
  return (
    <div className="refbar">
      <div className="refbar-head">
        <Icon name="search" size={13} />
        <span className="refbar-text">
          <b>{needs.length}</b> unknown{needs.length === 1 ? '' : 's'} the reader left open
          {needs.length > cap ? <span className="refbar-faint"> · top {cap} by seriousness</span> : null}
        </span>
        <div style={{ flex: 1 }} />
        {!consented ? <span className="refbar-faint">queries Wikipedia/Wiktionary via proxy</span> : null}
        <button className="refdesk-go small" onClick={go} disabled={run.active}>
          {run.active ? `looking… ${run.done}/${cap}` : `look up the most serious ${cap}`}
        </button>
      </div>
      {run.results.length ? (
        <div className="refbar-results">
          {run.results
            .slice()
            .sort((a, b) => b.need.severity - a.need.severity)
            .map(({ need, result }) => {
              const ok = result.status === 'hit';
              const desc = ok && result.payload
                ? (need.source === 'wikipedia' ? (result.payload.description || (result.payload.extract || '').slice(0, 90)) : (result.payload.entries[0] && result.payload.entries[0].partOfSpeech))
                : null;
              return (
                <div key={need.key} className="refbar-row">
                  <button className={'refbar-term' + (open === need.key ? ' open' : '')} onClick={() => setOpen(open === need.key ? null : need.key)}>
                    <span className={'refbar-dot ' + result.status} />
                    <b>{need.term}</b>
                    <span className="refbar-status">{ok ? (desc || 'found') : result.status === 'gated' ? 'suppressed (private)' : result.status === 'skipped' ? 'over budget' : result.status}</span>
                  </button>
                  {open === need.key && ok ? <ReferenceDesk term={need.term} type={need.type} autostart={true} /> : null}
                </div>
              );
            })}
          {!run.active ? <div className="refbar-foot">{liveCount} resolved · rate-limited through the proxy · results frozen locally</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* The confirmation step before any off-device search: the proposed term, shown
   editable, with nothing leaving the device until the reader presses Search.
   The auto-picked subject is often not what they meant, so the term is a plain
   input they can correct. Search (or Enter) hands the final term up to the app,
   which performs the fetch + ingest; Dismiss clears the card and fetches nothing. */
function ConfirmCard({ term, onConfirm, onDismiss }) {
  const [q, setQ] = React.useState(term || '');
  const go = () => { const t = (q || '').trim(); if (t && onConfirm) onConfirm(t); };
  return (
    <div className="refcard refcard-confirm">
      <div className="refcard-head">
        <Icon name="book" size={13} /> <span className="refcard-title">Wikipedia</span>
        <span className="refcard-src">en.wikipedia.org</span>
      </div>
      <div className="refcard-confirm-body">
        <p className="refcard-confirm-ask">Search Wikipedia and add the article to the graph? Nothing leaves your device until you press Search.</p>
        <div className="refcard-confirm-field">
          <Icon name="search" size={13} />
          <input className="refcard-confirm-input" type="text" value={q} placeholder="search term"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
        </div>
        <div className="refcard-confirm-actions">
          <button type="button" className="refdesk-go small" onClick={go} disabled={!(q && q.trim())}>Search Wikipedia</button>
          <button type="button" className="refcard-dismiss" onClick={() => onDismiss && onDismiss()}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}

/* The card pinned at the TOP of a chat message's reply when Wikipedia
   enrichment is on. Before a fetch it shows the proposed search for
   confirmation (ConfirmCard); once the reader confirms it renders the article
   that was pulled in and signals that it was INGESTED into the graph as a
   citable source. Handles the loading / abstain / miss states inline. */
function ReferenceCard({ data, onConfirm, onDismiss, onOpen }) {
  if (!data) return null;
  const term = data.term || data.query || '';
  // Before the fetch: the proposed search, awaiting the reader's confirmation.
  if (data.status === 'confirm') return <ConfirmCard term={term} onConfirm={onConfirm} onDismiss={onDismiss} />;
  const head = (
    <div className="refcard-head">
      <Icon name="book" size={13} /> <span className="refcard-title">Wikipedia</span>
      {term ? <span className="refcard-term">{term}</span> : null}
      <span className="refcard-src">en.wikipedia.org</span>
    </div>
  );
  if (data.loading) return <div className="refcard">{head}<p className="refdesk-loading">reading Wikipedia for “{term}”…</p></div>;
  if (data.status === 'disabled') return null;
  if (data.status === 'gated') return <div className="refcard">{head}<p className="refdesk-note">Suppressed — “{term}” reads as a private individual; the desk does not resolve people against the world.</p></div>;
  if (data.status === 'error') return <div className="refcard">{head}<p className="refdesk-err">Couldn’t reach Wikipedia. <code>{data.error}</code></p></div>;
  if (data.status === 'pending') return <div className="refcard">{head}<p className="refdesk-note">No frozen article, and the desk is offline.</p></div>;
  if (data.status !== 'hit' || !data.payload) return <div className="refcard">{head}<p className="refdesk-placeholder">No Wikipedia article found for “{term}”.</p></div>;

  const p = data.payload;
  const ing = data.ingested;
  return (
    <div className="refcard">
      {head}
      <div className="refcard-body">
        {p.thumbnail ? <img className="refdesk-thumb" alt="" src={p.thumbnail} /> : null}
        <h4 className="refdesk-headword">{p.url ? <a href={p.url} target="_blank" rel="noopener">{p.title}</a> : p.title}</h4>
        {p.description ? <p className="refdesk-desc">{p.description}</p> : null}
        {p.intro ? <p className="refdesk-summary">{p.intro}</p> : null}
        {p.also_see && p.also_see.length ? (
          <div className="refdesk-seealso">
            <div className="refdesk-lbl">Related</div>
            {p.also_see.slice(0, 4).map((t, i) => <span key={i} className="refcard-rel">{t}</span>)}
          </div>
        ) : null}
      </div>
      {ing ? (
        <div className="refcard-ingested">
          <Icon name="check" size={12} /> Added to the graph as <b>{ing.name}</b> — {ing.deferred ? 'ask a follow-up to ground on it.' : 'the answer below is grounded in this article.'}
          {onOpen ? <button type="button" className="refcard-open" onClick={() => onOpen(ing.id)}>open</button> : null}
        </div>
      ) : (
        <div className="refdesk-basis">via <code>en.wikipedia.org</code>{data.cached ? ' · cached' : ''}{data.basis && data.basis.fetched_at ? ' · ' + fmtWhen(data.basis.fetched_at) : ''}</div>
      )}
    </div>
  );
}

Object.assign(window, { ReferenceDesk, ReferenceDeskBar, ReferenceCard });
