/* ============================================================ Reading modal
   A document used to slip silently into the chat's source set the instant it
   finished parsing — the reader never saw it happen. The reading modal makes
   that moment legible: when a document is added, the reader WATCHES it be read,
   then chooses where it goes.

   The reading is told in the medium's own three movements — the same ontology
   the engine parses by (existence → structure → significance), surfaced as a
   focal experience rather than a footnote banner:

       Find   — the text comes to be; it settles into sentences        (existence)
       Read   — the sentences are related: who, where, what holds      (structure)
       Weigh  — what matters is projected; the figures surface         (significance)

   This component is purely presentational. It is driven by two props:

     session — the LIVE reading, streamed from the parse:
               { name, phase, stage, pct, done, total, big } | null
     result  — the FINISHED reading, computed once the doc is parsed
               (window.makeReadingResult): the figures and glimpses to reveal +
               the one-line summary. null until the parse resolves.

   The actual reading PROCESS is still being defined; this is the surface it will
   drive. While `result` is null the modal shows the live movements; when it
   arrives the figures surface one by one, a few read sentences fade in, and the
   modal settles to a summary with the choice that used to be made silently:
   bring it into chat, or open it to read yourself.
   ============================================================ */

const READ_ENT_COLOR = { person: '#2a6fdb', place: '#1f8a5b', org: '#8a6a16', thing: '#6b7280' };

// The three movements, in the medium's own order, each with a one-line gloss of
// what is happening to the text inside it. A fourth, terminal step ("Ready")
// lights only once the reading has settled.
const READING_MOVEMENTS = [
  { id: 'existence',    label: 'Find',  gloss: 'taking in the text, settling it into sentences' },
  { id: 'structure',    label: 'Read',  gloss: 'relating the sentences — who, where, what holds' },
  { id: 'significance', label: 'Weigh', gloss: 'projecting what matters, surfacing the figures' },
];

// Sub-stage → human line. Mirrors the engine's own stages (existence splits
// loading→segmenting, etc.) plus the perceptual adapters that turn a non-text
// file into text before the engine ever sees it.
const READING_STAGE = {
  loading: 'Loading into memory',
  segmenting: 'Splitting into sentences',
  reading: 'Reading the structure',
  projecting: 'Weighing what matters',
  easing: 'Easing memory — almost there',
  transcribing: 'Transcribing audio',
  recognizing: 'Reading text from the image',
  extracting: 'Extracting text from the PDF',
  expecting: 'Forming expectations…',
};

// A signed-edge palette for the live delta: the reading either CONFIRMS what it
// expected (coherence) or is BROKEN from it (rupture). Amber for the break so a
// surprise reads at a glance against the calm accent.
const DELTA_COLOR = { coherence: 'var(--accent)', rupture: '#e0823c' };

// Sample a long span list down to ~`max` evenly-spaced bars for the settled
// surprise strip (the live strip shows a trailing window instead).
function sampleSpans(spans, max) {
  if (!spans || spans.length <= max) return spans || [];
  const step = spans.length / max, out = [];
  for (let k = 0; k < max; k++) out.push(spans[Math.floor(k * step)]);
  return out;
}

/* The surprise strip — one bar per span, its height the miss size (delta
   magnitude), amber where the reading ruptured. Watching it fill is watching
   where the document defied what the reading expected. */
function SurpriseStrip({ spans }) {
  if (!spans || !spans.length) return null;
  return (
    <div className="rm-strip" aria-hidden="true">
      {spans.map((s, k) => {
        const mag = s.coefficient == null ? 0 : (s.magnitude || 0);
        const h = Math.max(6, Math.min(100, Math.round((mag / 1.6) * 100)));
        const rupture = s.coefficient != null && s.sign === 'rupture';
        return <span key={k} className={'rm-bar' + (rupture ? ' rupture' : '') + (s.coefficient == null ? ' void' : '')}
          style={{ height: h + '%' }} />;
      })}
    </div>
  );
}

// Overall fraction across the three movements, so a single bar can read as
// continuous progress while the per-movement rail shows where we are. Each
// movement owns a third of the bar; the live `pct` fills within its third.
function readingFraction(session) {
  if (!session) return 0;
  const idx = Math.max(0, READING_MOVEMENTS.findIndex(m => m.id === session.phase));
  const within = (session.pct == null || session.easing) ? 0.5 : session.pct;
  return Math.min(1, (idx + within) / READING_MOVEMENTS.length);
}

function prefersReducedMotion() {
  try {
    return document.documentElement.classList.contains('reduce-motion')
      || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { return false; }
}

/* Build the finished-reading payload from a parsed doc: the counts, the figures
   to surface, and a few representative sentences the reader can see were read.
   Prose and tables read differently, so each contributes the measures that make
   sense for it. Defensive throughout — a missing projection just yields fewer
   figures, never a throw across the ingest path. */
function makeReadingResult(doc) {
  if (!doc) return null;
  const base = { kind: doc.kind, name: doc.name, meta: doc.meta || '' };
  if (doc.kind === 'table') {
    return Object.assign(base, {
      rows: (doc.rows || []).length,
      columns: (doc.columns || []).length,
      figures: [], glimpses: [],
    });
  }
  // prose: flatten blocks for counts + a sentence-index → text map for glimpses
  let sentences = 0, paragraphs = 0;
  const sentText = new Map();
  for (const b of (doc.blocks || [])) {
    if (!b.sentences) continue;
    if (b.type === 'p') paragraphs++;
    for (const s of b.sentences) { sentences++; if (s.t) sentText.set(s.i, s.t); }
  }
  const words = doc._text ? (doc._text.trim().match(/\S+/g) || []).length : 0;

  let entities = [];
  try {
    const E = window.EOEngine;
    if (E && E.projectEntities) entities = E.projectEntities(doc).entities || [];
  } catch (e) { entities = []; }
  const ranked = entities.slice().sort((a, b) => (b.raw || 0) - (a.raw || 0));
  // `at` = the span where the figure is first read, so the live unfold can light
  // it the moment the playback cursor reaches it (null ⇒ reveal at the end).
  const figures = ranked.slice(0, 16).map(e => ({ name: e.name, type: e.type, raw: e.raw, at: (e.sents || [])[0] != null ? e.sents[0] : null }));

  // Glimpses: the sentence where each principal figure first appears — concrete
  // proof the text was read, not just measured. Fall back to the opening
  // sentences when a doc has no projected figures (e.g. a list, a short note).
  const glimpses = [], seen = new Set();
  for (const e of ranked) {
    const i = (e.sents || [])[0];
    if (i != null && sentText.has(i) && !seen.has(i)) { seen.add(i); glimpses.push(sentText.get(i)); }
    if (glimpses.length >= 5) break;
  }
  if (glimpses.length < 3) {
    for (const [i, t] of sentText) { if (!seen.has(i)) { seen.add(i); glimpses.push(t); } if (glimpses.length >= 4) break; }
  }
  return Object.assign(base, { sentences, paragraphs, words, figures, glimpses });
}

/* One stat cell ("128 sentences"). Value animates in via CSS when it mounts. */
function ReadStat({ value, label }) {
  if (value == null) return null;
  return (
    <div className="rm-stat">
      <span className="rm-stat-n">{Number(value).toLocaleString()}</span>
      <span className="rm-stat-l">{label}</span>
    </div>
  );
}

function ReadingModal({ session, result, onOpenChat, onOpenDoc, onClose }) {
  const dialogRef = window.useDialog(onClose);
  const reduce = React.useMemo(prefersReducedMotion, []);

  const figures = (result && result.figures) || [];
  const glimpses = (result && result.glimpses) || [];
  const playback = result && result.playback;
  const spans = (playback && playback.spans) || null;
  const N = spans ? spans.length : 0;

  // Two reveals share one settle. PLAYBACK (when the reading carries a forward
  // expectation) plays span-by-span: a cursor walks the timeline and each delta
  // lands live. Otherwise the finished read just surfaces its figures one by
  // one. Reduced motion jumps either straight to settled.
  const [reveal, setReveal] = React.useState(0);   // figures shown (non-playback)
  const [cursor, setCursor] = React.useState(0);    // spans played (playback)
  const [settled, setSettled] = React.useState(false);

  React.useEffect(() => {
    if (!result) { setSettled(false); setReveal(0); setCursor(0); return; }
    if (playback) return;                            // playback effect owns this case
    if (reduce) { setReveal(figures.length); setSettled(true); return; }
    if (!figures.length) { setReveal(0); const t = setTimeout(() => setSettled(true), 350); return () => clearTimeout(t); }
    let n = 0; setReveal(0); setSettled(false);
    const id = setInterval(() => {
      n += 1; setReveal(n);
      if (n >= figures.length) { clearInterval(id); setTimeout(() => setSettled(true), 480); }
    }, 110);
    return () => clearInterval(id);
  }, [result]); // eslint-disable-line

  React.useEffect(() => {
    if (!playback) return;
    if (reduce || N <= 1) { setCursor(N); setSettled(true); return; }
    setCursor(0); setSettled(false);
    // Bound the whole unfold to a readable spell — give the document space to
    // breathe without making a long one a chore (≈8s, clamped per span; Skip is
    // always there).
    const interval = Math.max(22, Math.min(280, Math.round(8000 / N)));
    let k = 0;
    const id = setInterval(() => {
      k += 1; setCursor(k);
      if (k >= N) { clearInterval(id); setTimeout(() => setSettled(true), 550); }
    }, interval);
    return () => clearInterval(id);
  }, [playback]); // eslint-disable-line

  const reading = !result;
  const inPlayback = !!playback && !settled;
  const name = (result && result.name) || (session && session.name) || 'document';
  const stageLine = session ? (READING_STAGE[session.stage] || session.stage || '') : '';

  // The span under the cursor, and the figures the reading has reached so far.
  const playIdx = N ? Math.min(Math.max(cursor - 1, 0), N - 1) : -1;
  const cur = spans ? spans[playIdx] : null;
  const curI = cur ? cur.i : -1;
  const shownFigures = settled ? figures
    : playback ? figures.filter(f => f.at != null && f.at <= curI)
    : figures.slice(0, reveal);
  const rupturesSoFar = spans ? spans.slice(0, cursor).filter(s => s.coefficient != null && s.sign === 'rupture').length : 0;

  const movementIdx = reading
    ? Math.max(0, READING_MOVEMENTS.findIndex(m => m.id === (session && session.phase)))
    : (settled ? READING_MOVEMENTS.length : READING_MOVEMENTS.length - 1);  // Weigh on while revealing
  const frac = reading ? readingFraction(session) : 1;
  const indet = reading && (!session || session.pct == null || session.easing);
  const SKELETON = [82, 96, 71, 90, 64];
  const closable = settled || reading === false && !inPlayback;
  const skip = () => { setCursor(N); setSettled(true); };

  return (
    <div className="overlay center reading-overlay" onClick={closable ? onClose : undefined}>
      <div className={'reading-modal' + (settled ? ' settled' : '') + (reading ? ' reading' : '') + (inPlayback ? ' playing' : '')}
           role="dialog" aria-modal="true" aria-label={'Reading ' + name}
           aria-busy={reading || inPlayback} tabIndex={-1} ref={dialogRef}
           onClick={e => e.stopPropagation()}>

        <div className="rm-head">
          <span className={'rm-orb' + (settled ? ' done' : '')} aria-hidden="true">
            <Icon name={settled ? 'check' : 'book'} size={16} />
          </span>
          <div className="rm-head-text">
            <div className="rm-eyebrow">{settled ? 'Read' : inPlayback ? 'Reading forward' : reading ? 'Reading' : 'Read'}</div>
            <h2 className="rm-title" title={name}>{name}</h2>
          </div>
          <button className="rm-x" onClick={onClose} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </div>

        {/* The movements rail — Find · Read · Weigh · Ready, lit in order. */}
        <div className="rm-rail" aria-hidden="true">
          {READING_MOVEMENTS.map((m, i) => (
            <div key={m.id} className={'rm-mv' + (movementIdx > i ? ' done' : movementIdx === i ? ' on' : '')}>
              <span className="rm-mv-dot" />
              <span className="rm-mv-label">{m.label}</span>
            </div>
          ))}
          <div className={'rm-mv rm-mv-end' + (settled ? ' done' : !reading ? ' on' : '')}>
            <span className="rm-mv-dot" />
            <span className="rm-mv-label">Ready</span>
          </div>
        </div>
        {reading && movementIdx >= 0 && READING_MOVEMENTS[movementIdx] && (
          <div className="rm-gloss">{READING_MOVEMENTS[movementIdx].gloss}</div>
        )}

        {/* Stage: skeleton while reading; the live predict→delta while playing
            forward; the representative read sentences once settled. */}
        {inPlayback ? (
          <div className="rm-playback">
            <div className="rm-now">
              {cur && cur.coefficient != null && (
                <div className="rm-delta">
                  <span className={'rm-sign ' + cur.sign}>{cur.sign === 'rupture' ? 'rupture' : 'coherence'}</span>
                  <div className="rm-gauge" title="how true the expectation seemed (cosine)">
                    <div className="rm-gauge-fill" style={{ width: Math.round(Math.max(0, Math.min(1, cur.coefficient)) * 100) + '%', background: DELTA_COLOR[cur.sign] }} />
                  </div>
                  <span className="rm-coeff" style={{ color: DELTA_COLOR[cur.sign] }}>{cur.coefficient.toFixed(2)}</span>
                </div>
              )}
              <p className={'rm-span' + (cur && cur.sign === 'rupture' ? ' rupture' : '')}>{cur ? cur.t : ''}</p>
            </div>
            <SurpriseStrip spans={spans.slice(Math.max(0, cursor - 110), Math.max(cursor, 1))} />
          </div>
        ) : (
          <div className={'rm-scanner' + (reading && !reduce ? ' sweeping' : '')}>
            {reading
              ? SKELETON.map((w, i) => <span key={i} className="rm-skel" style={{ width: w + '%' }} />)
              : (glimpses.length
                  ? glimpses.map((g, i) => (
                      <span key={i} className="rm-glimpse" style={{ animationDelay: reduce ? '0s' : (i * 0.14 + 0.1) + 's' }}>{g}</span>
                    ))
                  : <span className="rm-glimpse rm-glimpse-empty">No prose to glimpse — read the document to see it in full.</span>)}
            {reading && !reduce && <span className="rm-sweep" aria-hidden="true" />}
          </div>
        )}

        {/* Figures surfacing — as the playback cursor reaches each one, or one by
            one as the finished read settles. */}
        {result && figures.length > 0 && (
          <div className="rm-figures">
            <div className="rm-figures-label">{inPlayback ? 'Figures so far' : 'Figures it found'}</div>
            <div className="rm-figures-pills">
              {shownFigures.map(f => (
                <span key={f.name} className="rm-fig">
                  <span className="rm-fig-swatch" style={{ background: READ_ENT_COLOR[f.type] || READ_ENT_COLOR.thing }} />
                  {f.name}{f.raw > 1 && <span className="rm-fig-n">{f.raw}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Counts the reading measured — held back until it has settled. */}
        {settled && result && (
          <div className="rm-stats">
            {result.kind === 'table' ? (
              <React.Fragment>
                <ReadStat value={result.rows} label={result.rows === 1 ? 'row' : 'rows'} />
                <ReadStat value={result.columns} label={result.columns === 1 ? 'column' : 'columns'} />
              </React.Fragment>
            ) : (
              <React.Fragment>
                <ReadStat value={result.sentences} label={result.sentences === 1 ? 'sentence' : 'sentences'} />
                <ReadStat value={result.paragraphs} label={result.paragraphs === 1 ? 'paragraph' : 'paragraphs'} />
                {figures.length > 0 && <ReadStat value={figures.length} label={figures.length === 1 ? 'figure' : 'figures'} />}
                {playback && playback.summary && playback.summary.ruptures != null && (
                  <ReadStat value={playback.summary.ruptures} label={playback.summary.ruptures === 1 ? 'rupture' : 'ruptures'} />
                )}
              </React.Fragment>
            )}
          </div>
        )}

        {/* Foot: live progress + stage while reading; span counter + skip while
            playing; the summary and the choice once it has settled. */}
        <div className="rm-foot">
          {reading ? (
            <React.Fragment>
              <div className="rm-bar"><div className={'rm-fill' + (indet ? ' indet' : '')}
                   style={!indet ? { width: Math.round(frac * 100) + '%' } : undefined} /></div>
              <div className="rm-status">
                <span className="rm-stage">{stageLine}</span>
                {session && session.total ? (
                  <span className="rm-count">{Number(session.done || 0).toLocaleString()} / {Number(session.total).toLocaleString()}</span>
                ) : !indet ? (
                  <span className="rm-count">{Math.round(frac * 100)}%</span>
                ) : null}
              </div>
              {session && session.big && (
                <div className="rm-note">A long document — read a piece at a time so the tab stays responsive. This can take a moment.</div>
              )}
            </React.Fragment>
          ) : inPlayback ? (
            <React.Fragment>
              <div className="rm-bar"><div className="rm-fill" style={{ width: Math.round((cursor / Math.max(N, 1)) * 100) + '%' }} /></div>
              <div className="rm-status">
                <span className="rm-stage">Reading forward — expecting what comes next</span>
                <span className="rm-count">{Math.min(cursor, N)} / {playback.total || N}{rupturesSoFar ? ' · ' + rupturesSoFar + ' surprised' : ''}</span>
              </div>
              <button className="rm-skip" onClick={skip}>Skip to the read</button>
            </React.Fragment>
          ) : (
            <React.Fragment>
              <div className="rm-summary">
                <span className="rm-summary-meta">{result.meta || 'Read and ready.'}</span>
                {playback && playback.summary && playback.summary.measured > 0 && (
                  <span className="rm-summary-note"> · expected forward across {playback.summary.measured} spans, ruptured at {playback.summary.ruptures}{playback.capped ? ' (first ' + playback.capped + ')' : ''}</span>
                )}
              </div>
              <div className="rm-actions">
                <button className="rm-btn rm-btn-primary" onClick={onOpenChat}>
                  <Icon name="send" size={15} /> Bring into chat
                </button>
                <button className="rm-btn" onClick={onOpenDoc}>
                  <Icon name="doc" size={15} /> Open document
                </button>
              </div>
            </React.Fragment>
          )}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ReadingModal, makeReadingResult });
