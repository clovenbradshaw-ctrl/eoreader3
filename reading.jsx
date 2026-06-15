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
};

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
  const figures = ranked.slice(0, 16).map(e => ({ name: e.name, type: e.type, raw: e.raw }));

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

  // The reveal: once the finished reading arrives, surface its figures one by
  // one, then settle. Reduced motion jumps straight to settled. While `result`
  // is null we are still reading, and these hold at zero.
  const [reveal, setReveal] = React.useState(0);
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    if (!result) { setReveal(0); setSettled(false); return; }
    if (reduce || !figures.length) { setReveal(figures.length); const t = setTimeout(() => setSettled(true), 350); return () => clearTimeout(t); }
    let n = 0; setReveal(0); setSettled(false);
    const id = setInterval(() => {
      n += 1; setReveal(n);
      if (n >= figures.length) { clearInterval(id); setTimeout(() => setSettled(true), 480); }
    }, 110);
    return () => clearInterval(id);
  }, [result]); // eslint-disable-line

  const reading = !result;
  const movementIdx = reading
    ? Math.max(0, READING_MOVEMENTS.findIndex(m => m.id === (session && session.phase)))
    : READING_MOVEMENTS.length;             // all movements done once result is in
  const frac = reading ? readingFraction(session) : 1;
  const indet = reading && (!session || session.pct == null || session.easing);
  const name = (result && result.name) || (session && session.name) || 'document';
  const stageLine = session ? (READING_STAGE[session.stage] || session.stage || '') : '';

  // What to show in the scanner: real read sentences once we have them, else a
  // few skeleton lines under a travelling sweep — the "being read" texture.
  const SKELETON = [82, 96, 71, 90, 64];

  return (
    <div className="overlay center reading-overlay" onClick={reading ? undefined : onClose}>
      <div className={'reading-modal' + (settled ? ' settled' : '') + (reading ? ' reading' : '')}
           role="dialog" aria-modal="true" aria-label={'Reading ' + name}
           aria-busy={reading} tabIndex={-1} ref={dialogRef}
           onClick={e => e.stopPropagation()}>

        <div className="rm-head">
          <span className={'rm-orb' + (settled ? ' done' : '')} aria-hidden="true">
            <Icon name={settled ? 'check' : 'book'} size={16} />
          </span>
          <div className="rm-head-text">
            <div className="rm-eyebrow">{settled ? 'Read' : reading ? 'Reading' : 'Read'}</div>
            <h2 className="rm-title" title={name}>{name}</h2>
          </div>
          <button className="rm-x" onClick={onClose} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </div>

        {/* The movements rail — Find · Read · Weigh, lit in order; the live one
            carries its gloss so the reader knows what the document is doing. */}
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

        {/* The scanner — skeleton lines under a sweep while reading; the real
            read sentences fade in once the reading has settled. */}
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

        {/* Figures surfacing — the people, places and organizations the reading
            found, revealed one by one as the weighing settles. */}
        {result && figures.length > 0 && (
          <div className="rm-figures">
            <div className="rm-figures-label">Figures it found</div>
            <div className="rm-figures-pills">
              {figures.slice(0, reveal).map(f => (
                <span key={f.name} className="rm-fig">
                  <span className="rm-fig-swatch" style={{ background: READ_ENT_COLOR[f.type] || READ_ENT_COLOR.thing }} />
                  {f.name}{f.raw > 1 && <span className="rm-fig-n">{f.raw}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Counts: what the reading measured. Prose and tables show their own. */}
        {result && (
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
              </React.Fragment>
            )}
          </div>
        )}

        {/* Foot: a live progress bar + status while reading; the summary and the
            choice (bring into chat · open to read) once it has settled. */}
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
          ) : (
            <React.Fragment>
              <div className="rm-summary">
                <span className="rm-summary-meta">{result.meta || 'Read and ready.'}</span>
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
