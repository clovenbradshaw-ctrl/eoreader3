/* ============================================================
   websearch.jsx — the deep-read "add a web source" panel (window.WebSearchPanel).

   The visible front-end for the web-source function (websource.js / spec §11).
   It is an EXPLICIT action — a button in the composer opens this panel; nothing
   is searched or fetched as a side effect of sending a chat message. The flow is
   the spec's discovery → commitment split:

     query → EOWebSource.search  (cheap; lists candidates, no page bodies)
           → pick a result
           → cost confirmation    (states the query reaches public engines)
           → EOWebSource.fetchPage({ confirmed:true })  (the committing act)
           → onIngest(payload)    (admit as a first-class, citable source)

   The local model never reaches the network here: the human types the query and
   confirms each fetch. With no proxy configured the panel is self-documenting
   (how to turn it on) rather than hidden, so the capability is discoverable.

   Published as window.WebSearchPanel. Pure React over window.EOWebSource; all
   network/admission lives in that module, so this file holds only UI state.
   ============================================================ */
function WebSearchPanel({ onClose, onIngest, onToast }) {
  const WS = (typeof window !== 'undefined') ? window.EOWebSource : null;
  const ready = !!(WS && WS.enabled && WS.enabled());
  const [q, setQ] = React.useState('');
  const [phase, setPhase] = React.useState('idle');     // idle | searching | done | error
  const [results, setResults] = React.useState([]);
  const [err, setErr] = React.useState('');
  const [confirmUrl, setConfirmUrl] = React.useState(null);   // the result awaiting cost confirmation
  const [status, setStatus] = React.useState({});       // url → 'fetching' | 'added' | 'error'
  const inputRef = React.useRef(null);

  React.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  // Escape closes the panel (matches the app's other overlays).
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return u || ''; } };
  const notice = (WS && WS.costNotice) ? WS.costNotice(q) : 'Searches go through your proxy to public engines, which see the query text.';

  const doSearch = async () => {
    const query = q.trim();
    if (!query || !WS || phase === 'searching') return;
    setPhase('searching'); setErr(''); setResults([]); setConfirmUrl(null); setStatus({});
    try {
      const r = await WS.search(query);
      setResults((r && r.results) || []);
      setPhase('done');
    } catch (e) {
      setErr((e && e.message) || 'search failed');
      setPhase('error');
    }
  };

  // The explicit cost gate (spec §13.4): a fetch only fires after the user
  // confirms, having seen that the query reaches public engines.
  const confirmAdd = async (res) => {
    setConfirmUrl(null);
    setStatus(s => Object.assign({}, s, { [res.url]: 'fetching' }));
    try {
      const payload = await WS.fetchPage(res.url, { confirmed: true, retrieval_query: q.trim(), engine: res.engine });
      await onIngest(payload);
      setStatus(s => Object.assign({}, s, { [res.url]: 'added' }));
      if (onToast) onToast('Added web source: ' + (payload.title || res.title || hostOf(res.url)));
    } catch (e) {
      setStatus(s => Object.assign({}, s, { [res.url]: 'error' }));
      setErr((e && e.message) || 'fetch failed');
    }
  };

  const onBackdrop = (e) => { if (e.target === e.currentTarget) onClose(); };

  return (
    React.createElement('div', { className: 'overlay center', onMouseDown: onBackdrop },
      React.createElement('div', { className: 'websearch', role: 'dialog', 'aria-label': 'Add a web source' },
        React.createElement('div', { className: 'ws-head' },
          React.createElement(Icon, { name: 'globe', size: 18 }),
          React.createElement('div', { className: 'ws-title' }, 'Add a web source'),
          React.createElement('button', { className: 'ws-x', onClick: onClose, 'aria-label': 'Close' },
            React.createElement(Icon, { name: 'x', size: 16 }))
        ),
        // The cost notice is shown up front: even discovery forwards the query
        // to the upstream engines (the proxy hides the IP, not the query text).
        React.createElement('div', { className: 'ws-note' },
          React.createElement(Icon, { name: 'info', size: 13 }),
          React.createElement('span', null, notice)
        ),

        ready
          ? React.createElement(React.Fragment, null,
              React.createElement('form', { className: 'ws-search', onSubmit: (e) => { e.preventDefault(); doSearch(); } },
                React.createElement('input', {
                  ref: inputRef, type: 'text', value: q, placeholder: 'Search the web…',
                  onChange: (e) => setQ(e.target.value), 'aria-label': 'Web search query',
                }),
                React.createElement('button', { type: 'submit', className: 'ws-go', disabled: !q.trim() || phase === 'searching' },
                  React.createElement(Icon, { name: 'search', size: 15 }),
                  phase === 'searching' ? 'Searching…' : 'Search')
              ),
              err ? React.createElement('div', { className: 'ws-error' }, err) : null,
              React.createElement('div', { className: 'ws-results' },
                (phase === 'done' && !results.length)
                  ? React.createElement('div', { className: 'ws-empty' }, 'No results.')
                  : results.map((r, i) => {
                      const st = status[r.url];
                      const confirming = confirmUrl === r.url;
                      return React.createElement('div', { key: r.url + i, className: 'ws-result' },
                        React.createElement('div', { className: 'ws-r-title' }, r.title || hostOf(r.url)),
                        React.createElement('div', { className: 'ws-r-url' }, hostOf(r.url)),
                        r.snippet ? React.createElement('div', { className: 'ws-r-snip' }, r.snippet) : null,
                        confirming
                          ? React.createElement('div', { className: 'ws-confirm' },
                              React.createElement('div', { className: 'ws-confirm-note' }, notice + ' Fetch this page now?'),
                              React.createElement('div', { className: 'ws-confirm-row' },
                                React.createElement('button', { className: 'ws-go', onClick: () => confirmAdd(r) }, 'Confirm & fetch'),
                                React.createElement('button', { className: 'ws-cancel', onClick: () => setConfirmUrl(null) }, 'Cancel'))
                            )
                          : React.createElement('div', { className: 'ws-r-action' },
                              st === 'added'
                                ? React.createElement('span', { className: 'ws-added' }, React.createElement(Icon, { name: 'check', size: 13 }), 'Added as source')
                                : st === 'fetching'
                                  ? React.createElement('span', { className: 'ws-fetching' }, 'Fetching…')
                                  : React.createElement('button', { className: 'ws-add', onClick: () => setConfirmUrl(r.url) },
                                      React.createElement(Icon, { name: 'plus', size: 13 }), 'Add as source'))
                      );
                    })
              )
            )
          : React.createElement('div', { className: 'ws-off' },
              React.createElement('p', null, 'Web search is off. It needs a self-hosted SearXNG search backend behind the stateless cleon-search-proxy — the proxy hides your IP and holds any credential; nothing is baked into the app.'),
              React.createElement('p', null, 'To enable it, stand up ', React.createElement('code', null, 'searxng/'), ' + ', React.createElement('code', null, 'proxy/'), ', then set ', React.createElement('code', null, "window.EO_SEARCH_PROXY = 'https://your-proxy'"), ' in the console.'),
              React.createElement('p', { className: 'ws-off-doc' }, 'See docs/web-source-admission.md.')
            )
      )
    )
  );
}
if (typeof window !== 'undefined') window.WebSearchPanel = WebSearchPanel;
