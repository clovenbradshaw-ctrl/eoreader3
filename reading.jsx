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

/* Per-span surprise intensity for the strip + gauge, in [0,1]. Prefers the
   fused z-scored surprise; falls back to the raw embedding miss when a span
   carries only the older delta fields. */
function spanLevel(s) {
  if (s.surprise != null) return Math.max(0, Math.min(1, s.surprise / 3));   // z≈3 ⇒ full
  if (s.coefficient != null) return Math.max(0, Math.min(1, (s.magnitude || 0) / 1.6));
  return 0;
}

/* The checkpoint strip — one bar per CHECKPOINT (not per span), its height the
   fused surprise, amber where the reading ruptured. The bar under the cursor is
   lit; the ones behind it dim as passed. Watching it step along is watching the
   reading move through the moments worth stopping at. */
function CheckpointStrip({ checkpoints, current }) {
  if (!checkpoints || !checkpoints.length) return null;
  return (
    <div className="rm-cpstrip" aria-hidden="true">
      {checkpoints.map((s, k) => {
        const lvl = spanLevel(s);
        const cls = 'rm-cpbar'
          + (s.sign === 'rupture' ? ' rupture' : '')
          + (k === current ? ' current' : k < current ? ' past' : '');
        return <span key={k} className={cls} style={{ height: Math.max(8, Math.round(lvl * 100)) + '%' }} />;
      })}
    </div>
  );
}

/* The reading thinks out loud. At each checkpoint it first WONDERS what's coming
   (a hedged, forward-looking line — it has an expectation, not a prediction),
   then the passage lands, then it REACTS: the thread held, or it didn't see that
   coming. The phrasing is felt, never a fabricated "what happens next" (the
   faithful generative guess is deferred in predict.js); it leans only on what the
   reading actually measured — the prior beat's outcome, the upcoming span's site,
   and the channel that flinched. Pools are picked deterministically by checkpoint
   index so a re-render never reshuffles the voice mid-beat. */
const ANTICIPATE = {
  opening: [
    'Just getting my bearings…',
    'I don’t know this one yet — let’s read…',
    'Settling in. Let’s see what this is…',
  ],
  steady: [
    'It seems like the thread holds — I expect more of the same…',
    'This feels steady. I’d guess it keeps on…',
    'I’m expecting it to stay its course…',
  ],
  afterRupture: [
    'After that turn, I wonder where it lands…',
    'That shifted things — I’m not sure what’s next…',
    'I’m watching more closely now…',
  ],
  reference: [
    'I’m not sure yet who this is about…',
    'There’s a name I can’t quite place — let’s see…',
  ],
  scene: [
    'It seems like the scene is about to move…',
    'Something tells me this turns here…',
  ],
  fallback: [
    'I wonder what comes next…',
    'It seems like something’s building…',
    'Let’s see where this goes…',
  ],
};
const REACT = {
  opening: [
    'Now I have a feel for it.',
    'Okay — I have my bearings.',
    'That’s where we begin.',
  ],
  coherence: [
    '…and it did. Just as I thought.',
    'Yes — the thread held.',
    'That followed, like I expected.',
    'No surprise there — it stayed on course.',
  ],
  rupture: [
    'I didn’t see that coming.',
    'Oh — that broke from what I expected.',
    'A turn I wasn’t expecting.',
    'That caught me off guard.',
  ],
};
// Which channel of the fusion flinched, appended to a surprise so the rupture is
// legible: structure (Tier 0), the meaning (semantic), or both at once.
const REACT_CHANNEL = {
  both: ' The structure and the meaning both moved.',
  semantic: ' The meaning turned with no warning in the structure.',
  struct: ' The structure jumped.',
};
const pickPhrase = (pool, seed) => pool[((seed % pool.length) + pool.length) % pool.length];

function anticipationFor(cp, prevSign, span) {
  let pool;
  if (cp === 0) pool = ANTICIPATE.opening;
  else if (prevSign === 'rupture') pool = ANTICIPATE.afterRupture;
  else if (span && span.site === 'ReferenceBoundary') pool = ANTICIPATE.reference;
  else if (span && span.site === 'EventBoundary') pool = ANTICIPATE.scene;
  else pool = (cp % 2 === 0) ? ANTICIPATE.steady : ANTICIPATE.fallback;
  return pickPhrase(pool, cp);
}
function reactionFor(cp, span) {
  if (cp === 0) return pickPhrase(REACT.opening, cp);
  if (span && span.sign === 'rupture') {
    let note = '';
    if (span.semantic && span.struct) note = REACT_CHANNEL.both;
    else if (span.semantic) note = REACT_CHANNEL.semantic;
    else if (span.struct) note = REACT_CHANNEL.struct;
    return pickPhrase(REACT.rupture, cp) + note;
  }
  return pickPhrase(REACT.coherence, cp);
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

function ReadingModal({ session, result, onOpenChat, onOpenDoc, onClose, onSettled }) {
  const dialogRef = window.useDialog(onClose);
  const reduce = React.useMemo(prefersReducedMotion, []);

  const figures = (result && result.figures) || [];
  const glimpses = (result && result.glimpses) || [];
  const playback = result && result.playback;
  const spans = (playback && playback.spans) || null;
  // The reading pauses at CHECKPOINTS, not at every span — playing all of them
  // flew by too fast to follow. predict.js curates them (opening, surprises,
  // close, a few spread between); fall back to an even sample if an older payload
  // carries none.
  const checkpoints = React.useMemo(() => {
    if (!playback) return [];
    const cps = (playback.checkpoints && playback.checkpoints.length)
      ? playback.checkpoints : sampleSpans(spans || [], 5);
    return (cps || []).filter(s => s && typeof s.t === 'string');
  }, [playback]); // eslint-disable-line
  const CN = checkpoints.length;

  // The finished read either PLAYS THROUGH its checkpoints — at each one the
  // reading wonders aloud, the passage lands, then it reacts — or, when there's
  // no forward expectation, just surfaces its figures one by one. Reduced motion
  // jumps either straight to settled. The playback is a three-BEAT machine per
  // checkpoint: anticipate → passage → react.
  const [reveal, setReveal] = React.useState(0);     // figures shown (non-playback)
  const [cp, setCp] = React.useState(0);              // checkpoint index (playback)
  const [beat, setBeat] = React.useState('anticipate'); // anticipate | passage | react
  const [settled, setSettled] = React.useState(false);

  // Non-playback reveal (and the reset when a fresh reading replaces this one).
  React.useEffect(() => {
    if (!result) { setSettled(false); setReveal(0); setCp(0); setBeat('anticipate'); return; }
    if (playback) return;                            // the playback effects own this case
    if (reduce) { setReveal(figures.length); setSettled(true); return; }
    if (!figures.length) { setReveal(0); const t = setTimeout(() => setSettled(true), 350); return () => clearTimeout(t); }
    let n = 0; setReveal(0); setSettled(false);
    const id = setInterval(() => {
      n += 1; setReveal(n);
      if (n >= figures.length) { clearInterval(id); setTimeout(() => setSettled(true), 480); }
    }, 110);
    return () => clearInterval(id);
  }, [result]); // eslint-disable-line

  // Playback start: rewind to the first checkpoint, first beat.
  React.useEffect(() => {
    if (!playback) return;
    if (reduce || CN === 0) { setSettled(true); return; }
    setCp(0); setBeat('anticipate'); setSettled(false);
  }, [playback]); // eslint-disable-line

  // Playback advance: each beat holds long enough to read, then steps to the
  // next — passage after the wondering, reaction after the passage, then on to
  // the next checkpoint, and finally settling. Generous holds (Skip is always
  // there) so the moment can actually be followed.
  React.useEffect(() => {
    if (!playback || reduce || CN === 0 || settled) return;
    const HOLD = { anticipate: 1200, passage: 1700, react: 1600 };
    const id = setTimeout(() => {
      if (beat === 'anticipate') setBeat('passage');
      else if (beat === 'passage') setBeat('react');
      else if (cp + 1 < CN) { setCp(cp + 1); setBeat('anticipate'); }
      else setSettled(true);
    }, HOLD[beat] || 1300);
    return () => clearTimeout(id);
  }, [playback, cp, beat, settled, CN, reduce]); // eslint-disable-line

  // The reading is DONE the moment it settles (played through, or skipped to).
  // Only now is the content used — the parent attaches it to the chat here, never
  // before. Closing earlier leaves it in the library, unbrought-into-chat.
  React.useEffect(() => { if (settled && onSettled) onSettled(); }, [settled]); // eslint-disable-line

  const reading = !result;
  const inPlayback = !!playback && !settled;
  const name = (result && result.name) || (session && session.name) || 'document';
  const stageLine = session ? (READING_STAGE[session.stage] || session.stage || '') : '';

  // The checkpoint under the cursor, its forward-looking line and its reaction,
  // and the figures the reading has reached so far. While merely wondering (the
  // anticipate beat) we hold the figure reveal to the PREVIOUS checkpoint, so a
  // name about to be read doesn't leak before its passage lands.
  const cur = CN ? checkpoints[Math.min(cp, CN - 1)] : null;
  const curI = cur ? cur.i : -1;
  const prevSign = cp > 0 ? checkpoints[cp - 1].sign : null;
  const anticipation = cur ? anticipationFor(cp, prevSign, cur) : '';
  const reaction = cur ? reactionFor(cp, cur) : '';
  const revealI = (beat === 'anticipate' && cp > 0) ? checkpoints[cp - 1].i : curI;
  const shownFigures = settled ? figures
    : playback ? figures.filter(f => f.at != null && f.at <= revealI)
    : figures.slice(0, reveal);
  const passedCps = checkpoints.slice(0, cp + (beat === 'anticipate' ? 0 : 1));
  const rupturesSoFar = passedCps.filter(s => s.sign === 'rupture').length;
  const BEAT_FRAC = { anticipate: 0.15, passage: 0.55, react: 0.9 };
  const playFrac = CN ? (cp + (BEAT_FRAC[beat] || 0)) / CN : 0;

  const movementIdx = reading
    ? Math.max(0, READING_MOVEMENTS.findIndex(m => m.id === (session && session.phase)))
    : (settled ? READING_MOVEMENTS.length : READING_MOVEMENTS.length - 1);  // Weigh on while revealing
  const frac = reading ? readingFraction(session) : 1;
  const indet = reading && (!session || session.pct == null || session.easing);
  const SKELETON = [82, 96, 71, 90, 64];
  const skip = () => setSettled(true);

  return (
    // Closable at any point — mid-parse, mid-playback, settled. Clicking out (or
    // Escape, or the ✕) dismisses the surface; the reading itself keeps going and
    // the content isn't brought into the chat until it has settled (see onSettled).
    <div className="overlay center reading-overlay" onClick={onClose}>
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

        {/* Stage: skeleton while reading; the checkpoint unfold (wonder → passage
            → react) while playing forward; the read sentences once settled. */}
        {inPlayback ? (
          <div className="rm-playback">
            <div className="rm-now">
              {/* what it thinks will happen — a hedged, forward-looking line. Stays
                  visible (dimmed) once the passage lands, so the wondering and what
                  came of it can be read together. */}
              <p className={'rm-anticipate' + (beat !== 'anticipate' ? ' faded' : '')}>{anticipation}</p>

              {/* the passage itself — what actually came */}
              {beat !== 'anticipate' && cur && (
                <p key={'span-' + cp} className={'rm-span' + (cur.sign === 'rupture' ? ' rupture' : '')}>{cur.t}</p>
              )}

              {/* the reaction — held it, or didn't see it coming — with the gauge
                  and which channel of the fusion flinched. */}
              {beat === 'react' && cur && (
                <div className="rm-reaction">
                  <p className={'rm-react ' + (cp === 0 ? 'opening' : cur.sign)}>{reaction}</p>
                  {cp !== 0 && (cur.surprise != null || cur.coefficient != null) && (
                    <div className="rm-delta">
                      <span className={'rm-sign ' + cur.sign}>{cur.sign === 'rupture' ? 'surprise' : 'expected'}</span>
                      <div className="rm-gauge" title="surprise above the local baseline">
                        <div className="rm-gauge-fill" style={{ width: Math.round(spanLevel(cur) * 100) + '%', background: DELTA_COLOR[cur.sign] }} />
                      </div>
                      {cur.struct && <span className="rm-chan struct" title="the graph moved unexpectedly">structure</span>}
                      {cur.semantic && <span className="rm-chan semantic" title="the meaning turned with no structural change">semantic</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
            <CheckpointStrip checkpoints={checkpoints} current={cp} />
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
              <div className="rm-bar"><div className="rm-fill" style={{ width: Math.round(playFrac * 100) + '%' }} /></div>
              <div className="rm-status">
                <span className="rm-stage">Reading forward — stopping where it matters</span>
                <span className="rm-count">Checkpoint {Math.min(cp + 1, CN)} of {CN}{rupturesSoFar ? ' · ' + rupturesSoFar + ' surprised' : ''}</span>
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
          {!settled && (
            <p className="rm-dismiss-hint">Close anytime — it won’t be pulled into the chat while it’s still reading.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// The phrase pools are exported alongside the component so the smoke test can
// assert the voice the reader asked for ("I wonder…", "like I thought", "I didn't
// see that coming") without driving the beat timers.
Object.assign(window, { ReadingModal, makeReadingResult, _readingVoice: { ANTICIPATE, REACT, anticipationFor, reactionFor } });
