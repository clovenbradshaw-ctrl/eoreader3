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

/* The "initial search → offer options" step: the candidate articles for the
   term, each a button that triggers the deeper research (full article +
   ingest). Only the cheap search has run; researching is the reader's explicit
   choice. Also renders the searching / no-matches states for that step. */
function OptionsCard({ status, term, options, onResearch, onDismiss }) {
  const head = (
    <div className="refcard-head">
      <Icon name="book" size={13} /> <span className="refcard-title">Wikipedia</span>
      {term ? <span className="refcard-term">{term}</span> : null}
      <span className="refcard-src">en.wikipedia.org</span>
    </div>
  );
  if (status === 'searching') return <div className="refcard refcard-options">{head}<p className="refdesk-loading">Searching Wikipedia for “{term}”…</p></div>;
  const opts = options || [];
  if (status === 'no-options' || !opts.length) return (
    <div className="refcard refcard-options">{head}
      <div className="refcard-options-body">
        <p className="refcard-options-ask">No Wikipedia matches for “{term}”.</p>
        <div className="refcard-options-actions"><button type="button" className="refcard-dismiss" onClick={() => onDismiss && onDismiss()}>Dismiss</button></div>
      </div>
    </div>
  );
  return (
    <div className="refcard refcard-options">{head}
      <div className="refcard-options-body">
        <p className="refcard-options-ask">Want me to research {opts.length === 1 ? 'this' : 'one of these'}?</p>
        <ul className="refcard-options-list">
          {opts.map((o, i) => (
            <li key={i}>
              <button type="button" className="refcard-option" onClick={() => onResearch && onResearch(o.title)}>
                <span className="refcard-option-title">{o.title}</span>
                {o.snippet ? <span className="refcard-option-snippet">{o.snippet}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="refcard-options-actions">
          <button type="button" className="refcard-dismiss" onClick={() => onDismiss && onDismiss()}>No thanks</button>
        </div>
      </div>
    </div>
  );
}

/* The card pinned at the TOP of a chat message's reply when Wikipedia
   enrichment is on. First it offers the search candidates (OptionsCard, "want
   me to research one of these?"); once the reader picks one it renders the
   article that was pulled in and signals that it was INGESTED into the graph as
   a citable source. Handles the loading / abstain / miss states inline.
   (ConfirmCard is the fallback for an older external.js with no options step.) */
function ReferenceCard({ data, onConfirm, onDismiss, onOpen }) {
  if (!data) return null;
  const term = data.term || data.query || '';
  // The initial search → offer options step: search, then choose what to research.
  if (data.status === 'searching' || data.status === 'options' || data.status === 'no-options')
    return <OptionsCard status={data.status} term={term} options={data.options} onResearch={onConfirm} onDismiss={onDismiss} />;
  // Fallback (older external.js with no options search): confirm a single term.
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
        {p.references && p.references.length ? <RefSources references={p.references} /> : null}
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

/* The article's own citations, surfaced as provenance: each numbered source
   Wikipedia cites, linked OUT to the original work. The same list renders under
   the chat card (after ingest) and could anywhere a doc carries `wiki.references` —
   the visible proof that a grounded claim can be sourced THROUGH Wikipedia, not
   merely to it. Collapsed by default; the count is the affordance. */
function RefSources({ references, open: openInit }) {
  const refs = (references || []).filter(r => r && r.text);
  const [open, setOpen] = React.useState(!!openInit);
  if (!refs.length) return null;
  const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return ''; } };
  return (
    <div className={'refsources' + (open ? ' open' : '')}>
      <button type="button" className="refsources-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <span><b>{refs.length}</b> source{refs.length === 1 ? '' : 's'} Wikipedia cites</span>
        <span className="refsources-hint">trace a claim to the original</span>
      </button>
      {open ? (
        <ol className="refsources-list">
          {refs.map(r => (
            <li key={r.n} id={'refsrc-' + r.n} className="refsources-item">
              <span className="refsources-n">{r.n}</span>
              <span className="refsources-text">
                {r.text}
                {r.url ? <a className="refsources-link" href={r.url} target="_blank" rel="noopener nofollow">{host(r.url) || 'source'} ↗</a> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/* The Wikipedia SEARCH MODAL — the explicit way in. The composer's Wikipedia
   button opens this instead of letting the chat guess a term: the reader types
   a query, sees the real candidate articles, and opens one rendered as close to
   Wikipedia as we can (its OWN parsed HTML — infobox, figures, working [1]…[n]
   footnotes that link to the cited sources). "Add to graph" ingests it as a
   citable document whose claims carry those sources through. Nothing leaves the
   device until the reader searches; nothing is ingested until they choose. */
function WikiSearchModal({ initialQuery, onClose, onIngest, onOpenDoc }) {
  const X = refX();
  const dialogRef = window.useDialog(onClose);
  const inputRef = React.useRef(null);
  const articleRef = React.useRef(null);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const [q, setQ] = React.useState(initialQuery || '');
  const [search, setSearch] = React.useState({ status: 'idle', options: [], error: null, term: '' });
  const [view, setView] = React.useState(null);          // 'article' once one is opened
  const [art, setArt] = React.useState({ status: 'idle', payload: null, error: null, term: '' });
  const [ingested, setIngested] = React.useState(null);  // { id, name } once added
  const [adding, setAdding] = React.useState(false);

  const runSearch = React.useCallback((term) => {
    term = String(term == null ? q : term).trim();
    if (!term || !X || typeof X.searchOptions !== 'function') return;
    try { X.grantConsent && X.grantConsent(); } catch (e) {}
    setView(null); setArt({ status: 'idle', payload: null, error: null, term: '' }); setIngested(null);
    setSearch({ status: 'searching', options: [], error: null, term });
    X.searchOptions(term).then((res) => {
      if (!mounted.current) return;
      const s = res && res.status;
      if (!res || s === 'disabled') setSearch({ status: 'disabled', options: [], error: null, term });
      else if (s === 'hit') setSearch({ status: 'hit', options: (res.options || []).slice(0, 12), error: null, term });
      else if (s === 'gated') setSearch({ status: 'gated', options: [], error: null, term });
      else if (s === 'error') setSearch({ status: 'error', options: [], error: res.error, term });
      else setSearch({ status: 'miss', options: [], error: null, term });
    }, (e) => { if (mounted.current) setSearch({ status: 'error', options: [], error: String((e && e.message) || e), term }); });
  }, [q, X]);

  const openArticle = (title) => {
    if (!X || typeof X.articlePage !== 'function') return;
    try { X.grantConsent && X.grantConsent(); } catch (e) {}
    setIngested(null); setView('article');
    setArt({ status: 'loading', payload: null, error: null, term: title });
    if (articleRef.current) articleRef.current.scrollTop = 0;
    X.articlePage(title, { resolved: true }).then((res) => {
      if (!mounted.current) return;
      if (res && res.status === 'hit' && res.payload) setArt({ status: 'hit', payload: res.payload, error: null, term: title });
      else setArt({ status: (res && res.status) || 'error', payload: null, error: res && res.error, term: title });
    }, (e) => { if (mounted.current) setArt({ status: 'error', payload: null, error: String((e && e.message) || e), term: title }); });
  };

  const addToGraph = () => {
    if (!art.payload || !onIngest || adding) return;
    setAdding(true);
    Promise.resolve(onIngest(art.payload)).then((info) => {
      if (!mounted.current) return; setAdding(false); if (info) setIngested(info);
    }, () => { if (mounted.current) setAdding(false); });
  };

  // Footnote anchors ([1] → #cite_note-…, and the ↑ back-refs) scroll WITHIN the
  // reader rather than navigating; every other link already opens in a new tab.
  const onArticleClick = (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const id = decodeURIComponent((a.getAttribute('href') || '').slice(1));
    if (!id) return;
    const pane = articleRef.current;
    // an attribute selector handles the dots/colons Wikipedia cite_note ids carry
    // without needing CSS.escape — robust across the footnote and back-ref anchors.
    let tgt = null;
    try { tgt = pane && pane.querySelector('[id="' + id.replace(/["\\]/g, '') + '"]'); } catch (err) {}
    if (tgt) { tgt.scrollIntoView({ behavior: 'smooth', block: 'center' }); tgt.classList.add('wiki-ref-flash'); setTimeout(() => { try { tgt.classList.remove('wiki-ref-flash'); } catch (e2) {} }, 1500); }
  };

  React.useEffect(() => {
    if (inputRef.current) { try { inputRef.current.focus(); } catch (e) {} }
    if (initialQuery && initialQuery.trim()) runSearch(initialQuery);
  }, []); // eslint-disable-line

  const host = (() => { try { const u = X && X.cfg && X.cfg().proxy; return u ? new URL(u).host : ''; } catch (e) { return ''; } })();
  const p = art.payload;

  const results = (
    <div className="wiki-results">
      {search.status === 'idle' ? <p className="wiki-hint">Search Wikipedia for an article to read and (optionally) add to the graph. Only your search term leaves the device, through your proxy{host ? <span> (<code>{host}</code>)</span> : null}.</p>
        : search.status === 'searching' ? <p className="refdesk-loading">Searching Wikipedia for “{search.term}”…</p>
        : search.status === 'disabled' ? <p className="refdesk-note">Wikipedia lookups are off (the proxy is cleared).</p>
        : search.status === 'gated' ? <p className="refdesk-note">“{search.term}” reads as a private individual; the desk does not resolve people against Wikipedia.</p>
        : search.status === 'error' ? <p className="refdesk-err">Couldn’t reach Wikipedia. <code>{search.error}</code></p>
        : search.status === 'miss' || !search.options.length ? <p className="refdesk-placeholder">No Wikipedia matches for “{search.term}”.</p>
        : (
          <ul className="wiki-options">
            {search.options.map((o, i) => (
              <li key={i}>
                <button type="button" className="wiki-option" onClick={() => openArticle(o.title)}>
                  <span className="wiki-option-title">{o.title}</span>
                  {o.snippet ? <span className="wiki-option-snippet">{o.snippet}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );

  const article = (
    <div className="wiki-reader" ref={articleRef} onClick={onArticleClick}>
      {art.status === 'loading' ? <p className="refdesk-loading">Reading “{art.term}” from Wikipedia…</p>
        : art.status === 'gated' ? <p className="refdesk-note">“{art.term}” reads as a private individual; the desk does not resolve people against Wikipedia.</p>
        : art.status === 'disabled' ? <p className="refdesk-note">Wikipedia lookups are off (the proxy is cleared).</p>
        : art.status === 'error' ? <p className="refdesk-err">Couldn’t reach Wikipedia. <code>{art.error}</code></p>
        : art.status !== 'hit' || !p ? <p className="refdesk-placeholder">Couldn’t load “{art.term}”.</p>
        : (
          <React.Fragment>
            <h1 className="wiki-title">{p.title}</h1>
            <div className="wiki-article" dangerouslySetInnerHTML={{ __html: p.html || '' }} />
            <div className="wiki-article-foot">From <a href={p.url} target="_blank" rel="noopener">en.wikipedia.org</a> · {(p.references || []).length} citations · CC BY-SA</div>
          </React.Fragment>
        )}
    </div>
  );

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="wiki-modal" role="dialog" aria-modal="true" aria-label="Search Wikipedia" tabIndex={-1} ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <div className="wiki-modal-head">
          <Icon name="book" size={15} />
          <span className="wiki-modal-title">Wikipedia</span>
          <span className="wiki-modal-src">en.wikipedia.org</span>
          <div style={{ flex: 1 }} />
          <button className="x" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>
        <div className="wiki-searchbar">
          {view === 'article' ? (
            <button type="button" className="wiki-back" onClick={() => { setView(null); }} title="Back to results"><Icon name="chevron-left" size={15} /></button>
          ) : null}
          <Icon name="search" size={15} />
          <input ref={inputRef} className="wiki-search-input" type="text" value={q} placeholder="Search Wikipedia…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }} />
          <button type="button" className="refdesk-go small" onClick={() => runSearch()} disabled={!q.trim()}>Search</button>
        </div>
        <div className="wiki-modal-body">
          {view === 'article' ? article : results}
        </div>
        {view === 'article' && art.status === 'hit' && p ? (
          <div className="wiki-modal-foot">
            <RefSources references={p.references} />
            <div className="wiki-foot-actions">
              {ingested ? (
                <span className="wiki-added"><Icon name="check" size={13} /> Added as <b>{ingested.name}</b>{onOpenDoc ? <button type="button" className="refcard-open" onClick={() => { onOpenDoc(ingested.id); onClose && onClose(); }}>open</button> : null}</span>
              ) : (
                <button type="button" className="refdesk-go" onClick={addToGraph} disabled={adding}>{adding ? 'Adding…' : 'Add to graph'}</button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

Object.assign(window, { ReferenceDesk, ReferenceDeskBar, ReferenceCard, RefSources, WikiSearchModal });
