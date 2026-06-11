/* ============================================================ Prompt book drawer
   The prompts, and the IF→THEN routing that triggers each one.

   Cleon answers most turns with one soft prompt — "respond to the user
   appropriately; here's context that may or may not be relevant" — and only
   routes to a particular response when a turn carries a clearer signal (a
   who-question, a summary, a pushback, a creative ask). This view shows each
   prompt VERBATIM (pulled live from window.EOLLM, so it never drifts from what
   the model actually sees) alongside the conditions that select it.

   Read-only. The prompt text is the live EOLLM source of truth; the routing
   conditions mirror routeTurn (engine.js) and the turn dispatch (app.jsx).
   ============================================================ */

// An example grounded turn, so the assembled user message can be shown the way
// the model receives it: the instruction · the user's message · the ambient
// "things on my mind that may or may not be relevant" block.
const PROMPT_EXAMPLE = {
  question: 'what is the name of the company he works for?',
  docTitle: 'pg219.txt',
  spans: [
    { idx: 139, text: 'The Company did not pay for it.' },
    { idx: 185, text: 'I gave my name, and looked about.' },
  ],
  notesProse: 'The trading concern is only ever called “the Company”; no proper name is given.',
  shapeNote: 'They want the company name — a lookup. One line; if the page only calls it “the Company,” say exactly that.',
};

function pvSafe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

// The prompt book. `system`/`user` are thunks that read window.EOLLM live, so the
// rendered text is exactly what ships. `triggers` are the IF→THEN routing
// conditions that select this prompt (mirrors routeTurn + the app dispatch).
function promptBook() {
  const L = window.EOLLM;
  const sys = (mode, task, grounded) => pvSafe(() => L.systemFor(mode, task, grounded, 1), '(EOLLM not loaded)');
  const groundedUser = (over) => pvSafe(
    () => L.buildUserContent(Object.assign({ grounded: true }, PROMPT_EXAMPLE, over)),
    '(EOLLM not loaded)');
  return [
    {
      key: 'grounded-answer', title: 'Grounded answer', tag: 'most turns',
      blurb: 'The default for a question about an open document. The engine retrieves spans + notes; the model phrases an answer in its own words; citations are bound mechanically afterward, never written by the model.',
      triggers: [
        ['the turn references a source and names someone/somewhere in it', 'route: names-entity'],
        ['…or overlaps the page strongly on content words', 'route: strong-lexical'],
        ['…or follows on from a prior grounded turn', 'route: continuity'],
        ['…or recovers a locus through embedding recall', 'route: escalate → recovered'],
        ['needs the local model + a prose source — tables & no-model fall to the mechanical answer', ''],
      ],
      system: () => sys('grounded', 'answer', true),
      user: () => groundedUser(),
      params: 'temperature 0.12 · max_tokens 180→420 by depth',
    },
    {
      key: 'grounded-summary', title: 'Grounded summary', tag: 'overview asks',
      blurb: 'The same notes-and-spans frame, with one extra line — the degeneracy guard: synthesize across the spans, never hand back a single span as the whole summary.',
      triggers: [['the turn asks for an overview / summary', 'route: summary']],
      system: () => sys('grounded', 'summary', true),
      user: () => groundedUser({ question: 'what is this document about?', shapeNote: 'They want the through-line in your own words — synthesis, not a quote.' }),
      params: 'temperature 0.12 · max_tokens 260→520 by depth',
    },
    {
      key: 'shape', title: 'Shape pass — the director’s note', tag: 'runs first',
      blurb: 'A small first call that characterizes the turn — what the user is after, what register fits, what a bad answer would look like — without seeing the spans. Its note rides the next prompt as “what they seem to be after”: one of the things on mind, not an instruction to fulfil (the old “What this turn wants:” header got parroted back as the answer).',
      triggers: [['before every grounded answer/summary, when the model is loaded', 'two-stage answering']],
      system: () => pvSafe(() => L.SHAPE_SYSTEM, '(EOLLM not loaded)'),
      user: null,
      params: 'temperature 0.3 · max_tokens 90',
    },
    {
      key: 'repair', title: 'Conversational repair', tag: 'pushback',
      blurb: 'The turn is about the EXCHANGE, not the page — a complaint, a non-answer, an evidence request, an impatient nudge. It re-reads the question actually under repair instead of retrieving on the complaint, and opens with an acknowledgment. No dedicated system prompt: it reuses the grounded frame with a repair instruction layered on.',
      triggers: [
        ['frustration / non-answer — "you’re not listening", "that’s not an answer"', 'repair: frustration'],
        ['output-form / impatience — "why did you switch to direct quotes", "well?"', 'repair: frustration'],
        ['evidence request — "what makes you say that", "where does it say that"', 'repair: support'],
        ['flat dispute / correction — "no it doesn’t", "no, the son of…"', 'repair: contradiction / refinement'],
        ['only mid-conversation, after a reply has already been given', ''],
      ],
      system: () => sys('grounded', 'answer', true),
      systemNote: '+ a repair instruction on top: answer afresh from the spans and notes; do not repeat or defend the rejected reply.',
      user: null,
      params: 'temperature 0.12',
    },
    {
      key: 'creative', title: 'Creative composition', tag: 'make something',
      blurb: 'Free composition over any open passages, never cited. The grounded QA prompt can only refuse a poem/song/story and recycle a summary, so these route here instead.',
      triggers: [
        ['the Creative toggle is on', 'mode: creative'],
        ['…or an auto turn asks to write a song / poem / story', 'isCreativeCompose(q)'],
      ],
      system: () => sys('creative', null, false),
      user: null,
      params: 'temperature 0.8 · max_tokens 320',
    },
    {
      key: 'chat', title: 'Plain chat', tag: 'no source signal',
      blurb: 'Ordinary conversation with the local model — no document forced in. Used when nothing is open, or a doc is open but the turn shows no signal toward it.',
      triggers: [
        ['no document is in scope', 'route: no-scope'],
        ['…or a doc is open but the turn shows no signal and embedding recall missed', 'route: no-signal / escalate → chat'],
      ],
      system: () => sys('chat', null, false),
      user: null,
      params: 'temperature 0.4 · max_tokens 360',
    },
    {
      key: 'mechanical', title: 'Mechanical answer — no model', tag: 'deterministic',
      blurb: 'No prompt at all — the engine answers from its own graph: a who-portrait, a confirm/deny graph-check, a pivot/table lookup, a marked void for an absent referent, or the veto fallback when a model draft won’t bind to the page. This is the floor the model only ever phrases over.',
      triggers: [
        ['"who is in this" / who-question', 'route: who → portrait'],
        ['a proposition offered for checking', 'route: confirm → graph-check'],
        ['a table column / parseable pivot', 'route: pivot / table-column'],
        ['a named referent absent from every source', 'route: antimatter-void'],
        ['a model draft that binds to nothing, or no model available', 'veto → mechanical'],
      ],
      system: null, user: null,
      params: 'deterministic — no model call',
    },
  ];
}

function PromptCard({ p }) {
  const sys = p.system ? p.system() : null;
  const user = p.user ? p.user() : null;
  return (
    <div className="graph-sec prompt-card">
      <h4>
        {p.title}
        {p.tag ? <span className="prompt-tag">{p.tag}</span> : null}
        <span className="prompt-params">{p.params}</span>
      </h4>
      <p className="prompt-blurb">{p.blurb}</p>
      <div className="prompt-iftt">
        {p.triggers.map(([iff, then], i) => (
          <div key={i} className="prompt-trigger">
            <span className="prompt-if">{i === 0 ? 'IF' : '·'}</span>
            <span className="prompt-if-text">{iff}</span>
            {then ? <span className="prompt-then">{then}</span> : null}
          </div>
        ))}
      </div>
      {sys && (
        <details className="prompt-det">
          <summary>System prompt{p.systemNote ? ' (+ overlay)' : ''}</summary>
          <pre className="prompt-pre">{sys}</pre>
          {p.systemNote ? <div className="prompt-note">{p.systemNote}</div> : null}
        </details>
      )}
      {user && (
        <details className="prompt-det">
          <summary>Example user message — as assembled</summary>
          <pre className="prompt-pre">{user}</pre>
        </details>
      )}
    </div>
  );
}

function PromptsDrawer({ onClose }) {
  const dialogRef = window.useDialog(onClose);
  const book = React.useMemo(() => promptBook(), []);
  const ready = !!window.EOLLM;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer audit-drawer" role="dialog" aria-modal="true" aria-label="Prompt book"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row1">
            <h2>Prompt book</h2>
            <button className="x" onClick={onClose} aria-label="Close prompt book"><Icon name="x" size={18} /></button>
          </div>
          <p>Every prompt the model can be handed, verbatim — and the IF→THEN routing that picks one. Most turns get the soft “respond to the user appropriately; here’s context that may or may not be relevant” frame; a turn with a clearer signal routes to a particular response instead. The prompt text is pulled live from the running build, so it always matches what ships.</p>
        </div>
        <div className="drawer-body aud-body">
          {ready
            ? <div className="graph-view">{book.map(p => <PromptCard key={p.key} p={p} />)}</div>
            : <div className="empty-doc" style={{ padding: 40 }}>The prompt layer (window.EOLLM) isn’t loaded.</div>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PromptsDrawer, PromptCard });
