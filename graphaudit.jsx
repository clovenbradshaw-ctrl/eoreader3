/* ============================================================ Ingestion audit
   A glass box over INGESTION — the graph as it is built, word by word, robust
   enough to audit a whole book without trusting anyone's summary.

   The existing Graph tab (auditview.jsx) is a friendly portrait: the proper-noun
   cast, a few relations, capped lists. This is the opposite stance — completeness
   over friendliness. It answers the auditor's real questions:
     • "is EVERY word ingested, or only the names?" → the Reading + Lexicon tabs
       show every word and its exact fate (indexed term / stopword / dropped),
       sourced from the engine's own tokenizer so it cannot drift.
     • "where did this come from?" → every derived fact links to its source span,
       and every span shows what it produced (bidirectional provenance).
     • "does it choke on long text?" → nothing renders unbounded. The Reading tab
       walks a moving window (left-to-right, top-to-bottom, optionally auto-played
       like a human reader); the tables paginate. DOM stays bounded at any length.

   Reads window.EOEngine.ingestionReport / classifyTokens / entityDetail /
   assertionsOf / kinRecords / graphSnapshot / _provenance. Renders nothing the
   engine didn't derive. */

const GAX_OP = {
  INS: { label: 'instantiate', blurb: 'a referent was created (the only op that mints an entity)' },
  DEF: { label: 'assert',      blurb: 'the page states something about a referent (X is Y, kin, gender, role)' },
  SIG: { label: 'attribute',   blurb: 'a quote/turn was bound to a speaker' },
  SYN: { label: 'join',        blurb: 'a relation between referents, or a coreference merge' },
  NUL: { label: 'hold',        blurb: 'the reader saw a configuration and applied no transform (a stall / signal)' },
  SEG: { label: 'resplit',     blurb: 'a prior merge was reversed (a correction)' },
  EVA: { label: 'deposit',     blurb: 'exogenous reader attention was deposited' },
  REC: { label: 'learn',       blurb: 'a reading rule was changed (induced verb, veto lexicon)' },
};

// A compact, human one-line summary of any event — op-aware, never lossy about
// which referents it touched. Mirrors the engine's own event shapes.
function gaxEvSummary(ev) {
  if (ev.op === 'INS') return ev.target + (ev.entityType ? '  · ' + ev.entityType : '');
  if (ev.op === 'DEF') return (ev.target || '?') + (ev.path ? '  ·' + ev.path + ' ' : '  ') + (ev.value != null ? '= ' + ev.value : '');
  if (ev.op === 'SIG') return (ev.speaker || '?') + (ev.quote ? ' : “' + String(ev.quote).slice(0, 60) + (ev.quote.length > 60 ? '…' : '') + '”' : '');
  if (ev.op === 'SYN' && Array.isArray(ev.sites)) return (ev.siteNames || ev.sites).join(' = ') + (ev.method ? '  (' + ev.method + ')' : '');
  if (ev.op === 'SYN') return [ev.s, ev.v, ev.o].filter(Boolean).join(' ');
  if (ev.op === 'NUL') return (ev.reason || 'hold') + (ev.surface ? '  · ' + ev.surface : '');
  if (ev.op === 'SEG') return 'resplit ' + ((ev.targets || []).join(', '));
  if (ev.op === 'REC') return (ev.target || '') + (ev.value != null ? ' ← ' + JSON.stringify(ev.value) : '');
  if (ev.op === 'EVA') return (ev.deposits || []).map(d => d.site).join(', ');
  return ev.stance || ev.op;
}

function GaxOpChip({ op, n }) {
  const info = GAX_OP[op] || { label: op, blurb: '' };
  return <span className={'gax-op gax-op-' + op} title={op + ' — ' + info.blurb}>{op}{n != null ? <b>{n}</b> : null}</span>;
}

// One word, classified. The whole point of the audit: you SEE every word and
// what the engine did with it. Hover for the index forms it produced.
function GaxWord({ t }) {
  const cls = 'gax-w gax-w-' + t.kind + (t.entity ? ' gax-w-ent' : '');
  const title = t.kind === 'term'
    ? 'indexed → ' + t.terms.join(', ') + (t.entity ? '  · part of a name' : '')
    : t.kind === 'stop' ? 'stopword — carried in the prose, not indexed for retrieval'
    : 'dropped — too short or outside the index’s character class (not searchable)';
  return <span className={cls} title={title}>{t.w}</span>;
}

// A small paging hook: bounded reveal so a 200k-token lexicon never lands in the
// DOM at once. Returns the visible slice + a "show more" control.
function useGaxPaging(items, step) {
  step = step || 200;
  const [shown, setShown] = React.useState(step);
  React.useEffect(() => { setShown(step); }, [items, step]);
  const slice = items.slice(0, shown);
  return { slice, shown, total: items.length, more: items.length > shown, showMore: () => setShown(s => s + step), all: () => setShown(items.length) };
}

function GaxBar({ parts }) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div className="gax-bar" role="img" aria-label={parts.map(p => p.label + ' ' + p.n).join(', ')}>
      {parts.map((p, i) => p.n > 0 && (
        <span key={i} className={'gax-bar-seg ' + p.cls} style={{ width: (100 * p.n / total) + '%' }} title={p.label + ' — ' + p.n + ' (' + Math.round(100 * p.n / total) + '%)'} />
      ))}
    </div>
  );
}

/* ---------- Overview: the ingestion report card ---------- */
function GaxOverview({ report, onTab }) {
  const w = report.words, c = report.coverage, cnt = report.counts;
  const opList = Object.entries(cnt.ops || {}).sort((a, b) => b[1] - a[1]);
  const pct = (n, d) => d ? Math.round(100 * n / d) + '%' : '—';
  return (
    <div className="gax-pane">
      <div className="gax-cards">
        <div className="gax-card"><span className="gax-num">{report.doc.sentences.toLocaleString()}</span><span className="gax-lbl">sentences</span></div>
        <div className="gax-card"><span className="gax-num">{w.occurrences.toLocaleString()}</span><span className="gax-lbl">words read</span></div>
        <div className="gax-card"><span className="gax-num">{w.uniqueTerms.toLocaleString()}</span><span className="gax-lbl">index terms</span></div>
        <div className="gax-card"><span className="gax-num">{cnt.entities.toLocaleString()}</span><span className="gax-lbl">entities</span></div>
        <div className="gax-card"><span className="gax-num">{cnt.events.toLocaleString()}</span><span className="gax-lbl">graph events</span></div>
      </div>

      <div className="gax-sec">
        <h4>Every word's fate <span className="gax-dim">— is the whole text ingested, or only the names?</span></h4>
        <GaxBar parts={[
          { label: 'indexed', n: w.indexed, cls: 'seg-term' },
          { label: 'stopwords', n: w.stop, cls: 'seg-stop' },
          { label: 'dropped', n: w.dropped, cls: 'seg-drop' },
        ]} />
        <div className="gax-legend">
          <button className="gax-leg seg-term" onClick={() => onTab('lexicon')}><b>{w.indexed.toLocaleString()}</b> indexed <span className="gax-dim">{pct(w.indexed, w.occurrences)} · searchable content words</span></button>
          <button className="gax-leg seg-stop" onClick={() => onTab('lexicon')}><b>{w.stop.toLocaleString()}</b> stopwords <span className="gax-dim">{pct(w.stop, w.occurrences)} · carried, not indexed</span></button>
          <span className="gax-leg seg-drop"><b>{w.dropped.toLocaleString()}</b> dropped <span className="gax-dim">{pct(w.dropped, w.occurrences)} · too short / unindexable</span></span>
        </div>
        <p className="gax-note">
          {w.uniqueTerms.toLocaleString()} distinct index terms make up the retrieval index — the layer that reads <em>every</em> content word.
          Of those, <b>{w.entityTerms.toLocaleString()}</b> are part of a named entity: the proper-noun graph is the small, visible tip; the word index beneath it is the rest. Both are shown here, in full.
        </p>
      </div>

      <div className="gax-sec">
        <h4>Span coverage <span className="gax-dim">— which sentences deposited graph events, and which went dark</span></h4>
        <GaxBar parts={[
          { label: 'with events', n: c.withEvents, cls: 'seg-term' },
          { label: 'dark', n: c.dark, cls: 'seg-dark' },
        ]} />
        <div className="gax-legend">
          <button className="gax-leg seg-term" onClick={() => onTab('reading')}><b>{c.withEvents.toLocaleString()}</b> with events <span className="gax-dim">{pct(c.withEvents, c.sentences)}</span></button>
          <button className="gax-leg seg-dark" onClick={() => onTab('reading')}><b>{c.dark.toLocaleString()}</b> dark <span className="gax-dim">{pct(c.dark, c.sentences)} · read &amp; indexed, but produced no graph event</span></button>
        </div>
      </div>

      <div className="gax-sec">
        <h4>Events by kind <span className="gax-dim">— the {cnt.events.toLocaleString()} decisions the reader logged</span></h4>
        <div className="gax-oprow">
          {opList.length ? opList.map(([op, n]) => <button key={op} className="gax-opbtn" onClick={() => onTab('events')}><GaxOpChip op={op} /><span className="gax-opn">{n.toLocaleString()}</span><span className="gax-dim">{(GAX_OP[op] || {}).label}</span></button>)
            : <span className="gax-dim">none</span>}
        </div>
      </div>

      <div className="gax-sec gax-metarow">
        <span><span className="gax-dim">source</span> {report.doc.name}</span>
        <span><span className="gax-dim">language</span> {report.doc.lang}</span>
        {report.doc.genre && <span><span className="gax-dim">genre</span> {report.doc.genre}</span>}
        <span><span className="gax-dim">size</span> {report.doc.chars.toLocaleString()} chars</span>
        <span><span className="gax-dim">schema</span> {report.schema}</span>
      </div>
    </div>
  );
}

/* ---------- Reading: the word-by-word walk, in reading order ----------
   Render only a moving window of spans → DOM stays bounded for any length. Play
   advances a cursor one span at a time (read slowly, like a human); the window
   follows it; manual scrub jumps anywhere. Each span shows every word classified
   inline and the events it deposited. */
function GaxReading({ doc, report, evBySent, anchorOf, initialAt }) {
  const N = report.sentences.length;
  const PAGE = 36;
  const at0 = Math.max(0, Math.min(N - 1, initialAt || 0));
  const [start, setStart] = React.useState(Math.min(Math.max(0, N - PAGE), Math.max(0, at0 - 2)));
  const [cursor, setCursor] = React.useState(at0);
  const [playing, setPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState(750);
  const [onlyDark, setOnlyDark] = React.useState(false);
  const liveRef = React.useRef(null);

  React.useEffect(() => {           // the heartbeat: advance one span per tick
    if (!playing) return undefined;
    if (cursor >= N - 1) { setPlaying(false); return undefined; }
    const id = setTimeout(() => setCursor(c => Math.min(N - 1, c + 1)), speed);
    return () => clearTimeout(id);
  }, [playing, cursor, speed, N]);

  React.useEffect(() => {           // window follows the cursor
    if (cursor < start) setStart(Math.max(0, cursor - 2));
    else if (cursor >= start + PAGE) setStart(Math.min(Math.max(0, N - PAGE), cursor - PAGE + 4));
  }, [cursor]); // eslint-disable-line
  React.useEffect(() => {           // keep the read line in view while playing
    if (playing && liveRef.current) liveRef.current.scrollIntoView({ block: 'nearest' });
  }, [cursor, playing]);

  const end = Math.min(N, start + PAGE);
  const rows = [];
  for (let i = start; i < end; i++) {
    const s = report.sentences[i];
    if (onlyDark && s.events) continue;
    rows.push(s);
  }
  const text = (i) => (doc.sentenceTexts && doc.sentenceTexts[i]) || '';

  return (
    <div className="gax-pane gax-reading">
      <div className="gax-readbar">
        <button className="mini-btn primary" onClick={() => { if (cursor >= N - 1) setCursor(0); setPlaying(p => !p); }}>
          {playing ? '❚❚ Pause' : '▶ Read'}
        </button>
        <button className="mini-btn" onClick={() => { setPlaying(false); setCursor(c => Math.max(0, c - 1)); }} title="Step back">◀</button>
        <button className="mini-btn" onClick={() => { setPlaying(false); setCursor(c => Math.min(N - 1, c + 1)); }} title="Step forward">▶</button>
        <input className="gax-scrub" type="range" min={0} max={Math.max(0, N - 1)} value={cursor}
               aria-label="Reading position"
               onChange={e => { setPlaying(false); setCursor(+e.target.value); setStart(Math.min(Math.max(0, N - PAGE), Math.max(0, +e.target.value - 2))); }} />
        <span className="gax-readpos">s{cursor} <span className="gax-dim">/ {N - 1}</span></span>
        <select className="graph-pick" value={speed} onChange={e => setSpeed(+e.target.value)} aria-label="Reading speed" title="Reading speed">
          <option value={1400}>slow</option><option value={750}>steady</option><option value={300}>fast</option>
        </select>
        <label className="gax-check"><input type="checkbox" checked={onlyDark} onChange={e => setOnlyDark(e.target.checked)} /> dark only</label>
      </div>

      <div className="gax-legendbar">
        <span className="gax-w gax-w-term">indexed</span>
        <span className="gax-w gax-w-term gax-w-ent">name</span>
        <span className="gax-w gax-w-stop">stopword</span>
        <span className="gax-w gax-w-drop">dropped</span>
        <span className="gax-dim">— every word, classified by the engine's own tokenizer</span>
      </div>

      <div className="gax-readbody">
        {rows.map(s => {
          const toks = window.EOEngine.classifyTokens(text(s.i));
          const evs = evBySent.get(s.i) || [];
          const live = s.i === cursor;
          return (
            <div key={s.i} ref={live ? liveRef : null} className={'gax-span' + (live ? ' live' : '') + (s.events ? '' : ' dark')}>
              <div className="gax-span-gut">
                <span className="gax-sid" title={anchorOf ? 'span anchor ' + anchorOf(s.i) : ''}>s{s.i}</span>
                <span className={'gax-dot ' + (s.events ? 'on' : 'off')} title={s.events ? s.events + ' event' + (s.events === 1 ? '' : 's') : 'no graph events from this span'} />
              </div>
              <div className="gax-span-main">
                <div className="gax-span-text">
                  {toks.length ? toks.map((t, k) => <GaxWord key={k} t={t} />) : <span className="gax-dim">(no words)</span>}
                </div>
                <div className="gax-span-meta">
                  <span className="gax-dim">{s.terms} indexed · {s.words} words</span>
                  {evs.map((ev, k) => (
                    <span key={k} className="gax-span-ev"><GaxOpChip op={ev.op} /> <span className="gax-evsum">{gaxEvSummary(ev)}</span></span>
                  ))}
                  {!evs.length && <span className="gax-dim gax-darklbl">no graph event — indexed only</span>}
                </div>
              </div>
            </div>
          );
        })}
        {!rows.length && <div className="gax-dim" style={{ padding: 30 }}>No spans in this window{onlyDark ? ' are dark' : ''}.</div>}
      </div>
      <div className="gax-readfoot gax-dim">showing s{start}–s{end - 1} of {N} · the window moves; the DOM stays small so long texts don't choke</div>
    </div>
  );
}

/* ---------- Lexicon: the inverted index, every word ---------- */
function GaxLexicon({ report, onPick }) {
  const [q, setQ] = React.useState('');
  const [show, setShow] = React.useState({ term: true, stop: true, drop: true });
  const [entOnly, setEntOnly] = React.useState(false);
  const [sort, setSort] = React.useState('count');

  const rows = React.useMemo(() => {
    const ql = q.trim().toLowerCase();
    let out = [];
    if (show.term) for (const t of report.lexicon) out.push({ ...t, _kind: 'term' });
    for (const t of report.stopwords) {
      if (t.kind === 'stop' && show.stop) out.push({ token: t.token, count: t.count, _kind: 'stop', sents: null });
      if (t.kind === 'drop' && show.drop) out.push({ token: t.token, count: t.count, _kind: 'drop', sents: null });
    }
    if (entOnly) out = out.filter(t => t.entity);
    if (ql) out = out.filter(t => t.token.includes(ql));
    out.sort(sort === 'alpha' ? (a, b) => (a.token < b.token ? -1 : 1) : (a, b) => b.count - a.count || (a.token < b.token ? -1 : 1));
    return out;
  }, [report, q, show, entOnly, sort]);

  const paged = useGaxPaging(rows, 250);
  return (
    <div className="gax-pane">
      <div className="gax-toolbar">
        <input className="gax-search" placeholder="filter words…" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter words" />
        <label className="gax-check"><input type="checkbox" checked={show.term} onChange={e => setShow(s => ({ ...s, term: e.target.checked }))} /> indexed</label>
        <label className="gax-check"><input type="checkbox" checked={show.stop} onChange={e => setShow(s => ({ ...s, stop: e.target.checked }))} /> stopwords</label>
        <label className="gax-check"><input type="checkbox" checked={show.drop} onChange={e => setShow(s => ({ ...s, drop: e.target.checked }))} /> dropped</label>
        <label className="gax-check"><input type="checkbox" checked={entOnly} onChange={e => setEntOnly(e.target.checked)} /> names only</label>
        <div style={{ flex: 1 }} />
        <select className="graph-pick" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort"><option value="count">by count</option><option value="alpha">A–Z</option></select>
      </div>
      <div className="gax-dim gax-count">{rows.length.toLocaleString()} of {(report.words.uniqueTerms + report.words.uniqueDropped).toLocaleString()} distinct words</div>
      <table className="gax-table">
        <thead><tr><th>word</th><th className="num">count</th><th>fate</th><th>spans</th></tr></thead>
        <tbody>
          {paged.slice.map((t, i) => (
            <tr key={i} className={t.entity ? 'gax-tr-ent' : ''}>
              <td className="gax-tok">{t.token}{t.entity && <span className="gax-entflag" title="part of a named entity">name</span>}</td>
              <td className="num">{t.count.toLocaleString()}</td>
              <td><span className={'gax-fate gax-fate-' + t._kind}>{t._kind === 'term' ? 'indexed' : t._kind === 'stop' ? 'stopword' : 'dropped'}</span></td>
              <td className="gax-spancell">
                {t.sents ? t.sents.slice(0, 14).map(si => <button key={si} className="gax-sref" onClick={() => onPick(si)} title="show this span in Reading">s{si}</button>) : <span className="gax-dim">—</span>}
                {t.sents && t.sents.length > 14 && <span className="gax-dim"> +{t.sents.length - 14}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {paged.more && <div className="gax-more"><button className="mini-btn" onClick={paged.showMore}>Show {Math.min(250, paged.total - paged.shown)} more</button><span className="gax-dim"> · {paged.shown.toLocaleString()} / {paged.total.toLocaleString()}</span><button className="mini-btn" onClick={paged.all}>all</button></div>}
    </div>
  );
}

/* ---------- Entities: the cast, with full provenance ---------- */
function GaxEntities({ doc, report, onPick }) {
  const [q, setQ] = React.useState('');
  const rows = React.useMemo(() => {
    const ql = q.trim().toLowerCase();
    return ql ? report.entities.filter(e => e.name.toLowerCase().includes(ql) || e.key.includes(ql)) : report.entities;
  }, [report, q]);
  const paged = useGaxPaging(rows, 60);
  return (
    <div className="gax-pane">
      <div className="gax-toolbar">
        <input className="gax-search" placeholder="filter entities…" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter entities" />
        <div style={{ flex: 1 }} />
        <span className="gax-dim gax-count">{rows.length.toLocaleString()} entities</span>
      </div>
      {paged.slice.map((e, i) => {
        const d = window.EOEngine.entityDetail(doc, e.name);
        return (
          <div key={i} className="gax-ent">
            <div className="gax-ent-head">
              <span className={'graph-tag ' + e.type}>{e.type}</span>
              <span className="gax-ent-name">{e.name}</span>
              <span className="gax-dim gax-mono">×{e.mentions} · mass {e.mass}{e.key ? ' · ' + e.key : ''}</span>
            </div>
            {d && d.cooc && d.cooc.length > 0 && (
              <div className="gax-ent-cooc">{d.cooc.map(([n, c]) => <span key={n} className="gax-pill">{n}<b>{c}</b></span>)}</div>
            )}
            <div className="gax-ent-sents">
              {(e.sents || []).slice(0, 40).map(si => (
                <button key={si} className="gax-evidence" onClick={() => onPick(si)} title="show this span in Reading">
                  <span className="gax-sid">s{si}</span> <span className="gax-evidence-t">{(doc.sentenceTexts && doc.sentenceTexts[si]) || ''}</span>
                </button>
              ))}
              {(e.sents || []).length > 40 && <span className="gax-dim">+{e.sents.length - 40} more spans</span>}
            </div>
          </div>
        );
      })}
      {!rows.length && <div className="gax-dim" style={{ padding: 30 }}>No entities match.</div>}
      {paged.more && <div className="gax-more"><button className="mini-btn" onClick={paged.showMore}>Show more</button><span className="gax-dim"> · {paged.shown} / {paged.total}</span></div>}
    </div>
  );
}

/* ---------- Graph: assertions, relations, kin — each cited to its span ----------
   Each list paginates: large prose can produce tens of thousands of relations
   (every SYN edge between referents), and rendering the whole set in one shot
   would freeze the tab. The lists stay searchable and the totals are honest,
   but the DOM only ever holds a bounded slice. */
function GaxGraphTab({ doc, onPick }) {
  const E = window.EOEngine;
  const asserts = React.useMemo(() => { try { return E.assertionsOf(doc) || []; } catch (e) { return []; } }, [doc]);
  const kin = React.useMemo(() => { try { return E.kinRecords(doc) || []; } catch (e) { return []; } }, [doc]);
  const edges = React.useMemo(() => { try { return (E.graphSnapshot(doc) || {}).edges || []; } catch (e) { return []; } }, [doc]);

  const [qA, setQA] = React.useState('');
  const [qE, setQE] = React.useState('');
  const [qK, setQK] = React.useState('');

  const fAsserts = React.useMemo(() => {
    const ql = qA.trim().toLowerCase();
    if (!ql) return asserts;
    return asserts.filter(a => (String(a.subject || '') + ' ' + String(a.is || '') + ' ' + String(a.path || '')).toLowerCase().includes(ql));
  }, [asserts, qA]);
  const fEdges = React.useMemo(() => {
    const ql = qE.trim().toLowerCase();
    if (!ql) return edges;
    return edges.filter(e => (String(e.aName || '') + ' ' + String(e.bName || '') + ' ' + String(e.verb || '')).toLowerCase().includes(ql));
  }, [edges, qE]);
  const fKin = React.useMemo(() => {
    const ql = qK.trim().toLowerCase();
    if (!ql) return kin;
    return kin.filter(k => (String(k.possessor || '') + ' ' + String(k.kin || '')).toLowerCase().includes(ql));
  }, [kin, qK]);

  const pA = useGaxPaging(fAsserts, 200);
  const pE = useGaxPaging(fEdges, 200);
  const pK = useGaxPaging(fKin, 200);

  const span = (i) => (i != null && doc.sentenceTexts ? doc.sentenceTexts[i] : null);
  const Cite = ({ i }) => i == null ? <span className="gax-dim">no span</span>
    : <button className="gax-evidence" onClick={() => onPick(i)} title="show this span in Reading"><span className="gax-sid">s{i}</span> <span className="gax-evidence-t">{span(i)}</span></button>;
  const More = ({ p }) => p.more
    ? <div className="gax-more"><button className="mini-btn" onClick={p.showMore}>Show {Math.min(200, p.total - p.shown).toLocaleString()} more</button><span className="gax-dim"> · {p.shown.toLocaleString()} / {p.total.toLocaleString()}</span><button className="mini-btn" onClick={p.all}>all</button></div>
    : null;

  return (
    <div className="gax-pane">
      <div className="gax-sec">
        <h4>Assertions <span className="gax-dim">— what the page states outright (DEF), each shown against its source span</span></h4>
        {asserts.length ? (
          <>
            <div className="gax-toolbar">
              <input className="gax-search" placeholder="filter assertions…" value={qA} onChange={e => setQA(e.target.value)} aria-label="Filter assertions" />
              <div style={{ flex: 1 }} />
              <span className="gax-dim gax-count">{fAsserts.length.toLocaleString()} of {asserts.length.toLocaleString()}</span>
            </div>
            {pA.slice.map((a, i) => (
              <div key={i} className="gax-claim">
                <div className="gax-claim-prop"><b>{a.subject}</b> is {a.is}{a.path ? <span className="gax-dim gax-mono"> · {a.path}</span> : null}</div>
                <Cite i={a.sent} />
              </div>
            ))}
            <More p={pA} />
          </>
        ) : <div className="gax-dim">none</div>}
      </div>

      <div className="gax-sec">
        <h4>Relations <span className="gax-dim">— edges drawn between referents (SYN)</span></h4>
        {edges.length ? (
          <>
            <div className="gax-toolbar">
              <input className="gax-search" placeholder="filter relations…" value={qE} onChange={e => setQE(e.target.value)} aria-label="Filter relations" />
              <div style={{ flex: 1 }} />
              <span className="gax-dim gax-count">{fEdges.length.toLocaleString()} of {edges.length.toLocaleString()}</span>
            </div>
            <div className="gax-rels">
              {pE.slice.map((e, i) => (
                <div key={i} className="gax-rel"><span className="gax-a">{e.aName}</span><span className="gax-verb">{e.verb || '—'}</span><span className="gax-b">{e.bName}</span>{e.weight > 1 && <span className="gax-dim gax-mono">×{e.weight}</span>}</div>
              ))}
            </div>
            <More p={pE} />
          </>
        ) : <div className="gax-dim">none</div>}
      </div>

      {kin.length > 0 && (
        <div className="gax-sec">
          <h4>Kin <span className="gax-dim">— possessive kin resolved into the graph (the riskiest inference: a pronoun's owner)</span></h4>
          <div className="gax-toolbar">
            <input className="gax-search" placeholder="filter kin…" value={qK} onChange={e => setQK(e.target.value)} aria-label="Filter kin" />
            <div style={{ flex: 1 }} />
            <span className="gax-dim gax-count">{fKin.length.toLocaleString()} of {kin.length.toLocaleString()}</span>
          </div>
          {pK.slice.map((k, i) => (
            <div key={i} className="gax-claim">
              <div className="gax-claim-prop"><b>{k.possessor}</b>'s {k.kin}{k.anchor ? <span className="gax-dim gax-mono"> · anchor {k.anchor}</span> : null}</div>
              <Cite i={k.sent} />
            </div>
          ))}
          <More p={pK} />
        </div>
      )}
    </div>
  );
}

/* ---------- Events: the raw append-only log ---------- */
function GaxEvents({ doc, report, onPick }) {
  const [q, setQ] = React.useState('');
  const [ops, setOps] = React.useState({});           // empty = all
  const [open, setOpen] = React.useState(null);
  const present = React.useMemo(() => Object.keys(report.counts.ops || {}), [report]);
  const anyFilter = Object.values(ops).some(Boolean);
  const rows = React.useMemo(() => {
    const ql = q.trim().toLowerCase();
    return report.events.filter(ev => {
      if (anyFilter && !ops[ev.op]) return false;
      if (!ql) return true;
      return (ev.op + ' ' + gaxEvSummary(ev) + ' ' + (ev.src || '') + ' ' + (ev.sentence || '')).toLowerCase().includes(ql);
    });
  }, [report, q, ops, anyFilter]);
  const paged = useGaxPaging(rows, 250);
  const span = (i) => (i != null && doc.sentenceTexts ? doc.sentenceTexts[i] : null);
  return (
    <div className="gax-pane">
      <div className="gax-toolbar">
        <input className="gax-search" placeholder="search events…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search events" />
        <div style={{ flex: 1 }} />
        <span className="gax-dim gax-count">{rows.length.toLocaleString()} of {report.events.length.toLocaleString()}</span>
      </div>
      <div className="gax-opfilter">
        {present.map(op => (
          <button key={op} className={'gax-opbtn' + (ops[op] ? ' on' : '')} onClick={() => setOps(o => ({ ...o, [op]: !o[op] }))}>
            <GaxOpChip op={op} /><span className="gax-opn">{report.counts.ops[op]}</span>
          </button>
        ))}
        {anyFilter && <button className="mini-btn" onClick={() => setOps({})}>clear</button>}
      </div>
      <div className="gax-evlog">
        {paged.slice.map((ev, i) => {
          const isOpen = open === ev.seq;
          return (
            <div key={ev.seq != null ? ev.seq : i} className="gax-evrow">
              <button className="gax-evline" onClick={() => setOpen(isOpen ? null : ev.seq)}>
                <span className="gax-evseq">{ev.seq != null ? ev.seq : '·'}</span>
                <GaxOpChip op={ev.op} />
                <button className="gax-sid gax-sid-btn" onClick={(e) => { e.stopPropagation(); if (ev.sentence_idx != null) onPick(ev.sentence_idx); }} title="show this span in Reading">s{ev.sentence_idx != null ? ev.sentence_idx : '·'}</button>
                <span className="gax-evsum">{gaxEvSummary(ev)}</span>
                {ev.src && <span className="gax-evsrc">{ev.src}</span>}
              </button>
              {isOpen && (
                <div className="gax-evdetail">
                  {span(ev.sentence_idx) != null && <div className="gax-evspan"><span className="gax-sid">s{ev.sentence_idx}</span> {span(ev.sentence_idx)}</div>}
                  <pre className="gax-evjson">{JSON.stringify(ev, (k, v) => k === 'sentence' ? undefined : v, 2)}</pre>
                </div>
              )}
            </div>
          );
        })}
        {!rows.length && <div className="gax-dim" style={{ padding: 30 }}>No events match.</div>}
      </div>
      {paged.more && <div className="gax-more"><button className="mini-btn" onClick={paged.showMore}>Show {Math.min(250, paged.total - paged.shown)} more</button><span className="gax-dim"> · {paged.shown.toLocaleString()} / {paged.total.toLocaleString()}</span><button className="mini-btn" onClick={paged.all}>all</button></div>}
    </div>
  );
}

/* ---------- The drawer ---------- */
function GraphAuditDrawer({ onClose, onToast, docs }) {
  const [tab, setTab] = React.useState('overview');
  const [docId, setDocId] = React.useState(null);
  const [jump, setJump] = React.useState(null);       // a span to reveal in Reading
  const dialogRef = window.useDialog(onClose);

  const proseDocs = (docs || []).filter(d => d && d.kind === 'prose');
  const doc = proseDocs.find(d => d.id === docId) || proseDocs[proseDocs.length - 1] || null;

  const report = React.useMemo(
    () => (doc && window.EOEngine && window.EOEngine.ingestionReport ? window.EOEngine.ingestionReport(doc) : null),
    [doc]);
  const evBySent = React.useMemo(() => {
    const m = new Map();
    if (doc && doc._events) for (const ev of doc._events) { if (ev.sentence_idx == null) continue; (m.get(ev.sentence_idx) || m.set(ev.sentence_idx, []).get(ev.sentence_idx)).push(ev); }
    return m;
  }, [doc]);
  const anchorOf = React.useCallback((i) => {
    try { const p = window.EOEngine && window.EOEngine._provenance; const t = doc && doc.sentenceTexts && doc.sentenceTexts[i]; return p && t != null ? p.spanHash(t) : ''; } catch (e) { return ''; }
  }, [doc]);

  const pick = (si) => { setJump({ at: si, n: (jump ? jump.n : 0) + 1 }); setTab('reading'); };

  const exportJSON = () => {
    if (!report) { onToast && onToast('No graph to export.'); return; }
    try {
      const text = JSON.stringify(report, (k, v) => k === 'sentence' ? undefined : v, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'cleo-ingestion-' + (report.doc.name || 'doc').replace(/[^\w.-]+/g, '_') + '.json';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast && onToast('Ingestion graph exported as JSON');
    } catch (e) { onToast && onToast('Export failed.'); }
  };
  const copyJSON = () => {
    if (!report) { onToast && onToast('No graph to copy.'); return; }
    try { navigator.clipboard.writeText(JSON.stringify(report, (k, v) => k === 'sentence' ? undefined : v, 2)); onToast && onToast('Copied ingestion graph'); }
    catch (e) { onToast && onToast('Copy failed.'); }
  };

  const TABS = [['overview', 'Overview'], ['reading', 'Reading'], ['lexicon', 'Lexicon'], ['entities', 'Entities'], ['graph', 'Graph'], ['events', 'Events']];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer gax-drawer" role="dialog" aria-modal="true" aria-label="Ingestion audit"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Ingestion audit</h2>
            <button className="x" onClick={onClose} aria-label="Close ingestion audit"><Icon name="x" size={18} /></button>
          </div>
          <p>The graph as it is built — word by word, in reading order. Every word's fate (indexed / stopword / dropped), the inverted index actually built, each entity and assertion traced to its source span, and the full append-only event log. Nothing is summarized away or capped; long texts walk a moving window so the browser never chokes.</p>
        </div>

        <div className="drawer-tabs">
          {TABS.map(([id, label]) => (
            <button key={id} className={'drawer-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>{label}</button>
          ))}
          <div style={{ flex: 1 }} />
          {proseDocs.length > 1 && (
            <select className="graph-pick" value={doc ? doc.id : ''} onChange={e => setDocId(e.target.value)} aria-label="Document to audit">
              {proseDocs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>

        <div className="drawer-body gax-body">
          {!doc ? <div className="empty-doc" style={{ padding: 40 }}>No prose document loaded — add a source and its ingestion graph shows up here. (Tables carry a pivot, not a word graph.)</div>
            : !report ? <div className="empty-doc" style={{ padding: 40 }}>This source carries no word graph (too short, or not prose).</div>
            : tab === 'overview' ? <GaxOverview report={report} onTab={setTab} />
            : tab === 'reading' ? <GaxReading key={jump ? jump.n : 0} doc={doc} report={report} evBySent={evBySent} anchorOf={anchorOf} initialAt={jump ? jump.at : 0} />
            : tab === 'lexicon' ? <GaxLexicon report={report} onPick={pick} />
            : tab === 'entities' ? <GaxEntities doc={doc} report={report} onPick={pick} />
            : tab === 'graph' ? <GaxGraphTab doc={doc} onPick={pick} />
            : <GaxEvents doc={doc} report={report} onPick={pick} />}
        </div>

        <div className="glass-foot">
          <div className="glass-toggles">
            <span className="glass-foot-lbl">{report ? report.doc.sentences.toLocaleString() + ' spans · ' + report.words.occurrences.toLocaleString() + ' words · ' + report.counts.events.toLocaleString() + ' events' : 'no graph'}</span>
          </div>
          <div className="drawer-tools">
            <button className="mini-btn" onClick={copyJSON} title="Copy the full ingestion graph as JSON"><Icon name="copy" size={13} /></button>
            <button className="mini-btn primary" onClick={exportJSON} title="Download the full ingestion graph as JSON"><Icon name="upload" size={13} /> Export JSON</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { GraphAuditDrawer, GaxOverview, GaxReading, GaxLexicon, GaxEntities, GaxGraphTab, GaxEvents, GaxWord, gaxEvSummary });
