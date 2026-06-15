/* ============================================================
   EO-MRI — the cognition instrument, beside the Glass box.

   Where the Glass box (auditview.jsx) is the audit LOG — the steps a
   turn took, after the fact — EO-MRI is the SCAN: a live cross-section
   of a turn as it runs, drawn as the EO cube's three faces.

     • ACT face   — the operator helix NUL→SIG→INS→SEG→CON→SYN→DEF→EVA→REC,
                    with the order-check. This is **EO reader compliance**:
                    each operator lights only because an event with its
                    signature occurred, and the check flags any that fired
                    out of dependency order (the Act-face laws of
                    docs/reading-conformance.md).
     • SITE face  — WHERE the mark landed: Void/Thing/Kind · Field/Link/
                    Network · Atmosphere/Lens/Paradigm (Space ⤫ Time).
     • RESOLUTION — HOW it was held: Clearing/Dissecting/Unraveling ·
                    Tending/Binding/Tracing · Cultivating/Making/Composing.

   The address is **operator(Site, Resolution)** — the **3-fold address
   encoding**. The three faces and that address are rendered for every
   answer sentence as the turn streams.

   Ported from the standalone dc-runtime instrument to a native React
   drawer so it lives in the app like every other mode and reads the app's
   own data.

   REAL DATA — the rail is a fold over window.EOAudit: every settled chat
   turn is converted to a trace by window.EOMRI.traceFromTurn(turn) (below),
   and the instrument plays the most recent one, replays any from the rail,
   and refreshes live as new turns settle. The per-sentence 3-fold address
   is the engine's OWN encoder (window.EOEngine.eoAddressOfEvent / eoNotation
   — operator(Site, Resolution) of docs/reading-conformance.md), witness is
   the audit's WI-7 degree, and grounds are the turn's own citations resolved
   to their retrieved span text. The four scenario traces (grounded /
   fluent·thin / repair / cold-miss→fetch) remain as the demo / fallback,
   shown only when nothing is recorded yet (or via the ● live ⇄ illustrative
   toggle). Nothing is hardcoded in a way that blocks live data: the
   component renders whatever trace map it is handed.
   ============================================================ */

/* Inline CSS string → React style object. The ported instrument logic
   (renderVals below) emits CSS *strings*, the way the dc-runtime template
   bound them; React wants style OBJECTS. This converter lets every logic
   method stay verbatim. Splits declarations on `;` and each on its first
   `:`, camelCasing the property ("grid-template-columns" →
   gridTemplateColumns, "-webkit-font-smoothing" → WebkitFontSmoothing).
   Values are kept as strings (React accepts string style values). */
function eomriCss(str) {
  const out = {};
  if (!str) return out;
  for (const decl of String(str).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const rawKey = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!rawKey || !val) continue;
    const prop = rawKey.startsWith('--')
      ? rawKey
      : rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[prop] = val;
  }
  return out;
}

/* The instrument. A near-verbatim port of the dc-runtime `Component`:
   DCLogic's setState / forceUpdate / lifecycle map 1:1 onto React.Component,
   so the state machine (buildTraces / deriveOps / applyTo / play / tick /
   typeOut / renderVals …) is unchanged; only render() is rewritten from the
   declarative template into JSX, consuming renderVals()'s flat binding map. */
class EOMRIInstrument extends React.Component {
  constructor(props) {
    super(props);
    this.C = { green: '#3ddc84', amber: '#ffb800', red: '#ff3b52', cyan: '#00ccdd', orange: '#ff8a3d', NUL: '#9d6bff' };
    this.OPS = {
      NUL: { glyph: '∅', name: 'NUL' }, SIG: { glyph: '○', name: 'SIG' }, INS: { glyph: '●', name: 'INS' },
      SEG: { glyph: '｜', name: 'SEG' }, CON: { glyph: '⋈', name: 'CON' }, SYN: { glyph: '△', name: 'SYN' },
      DEF: { glyph: '⊢', name: 'DEF' }, EVA: { glyph: '⊨', name: 'EVA' }, REC: { glyph: '⊛', name: 'REC' }
    };
    this.OPCOL = { NUL: '#9d6bff', SIG: '#6e8bff', INS: '#3ddc84', SEG: '#2dd4bf', CON: '#22a7c2', SYN: '#4d9be0', DEF: '#00ccdd', EVA: '#ffb800', REC: '#ff3b52' };
    this.HELIX_CLIMB = ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'];
    this.typed = Infinity; this.typingKey = -1; this.replaying = false;
    this.timer = null; this.typeTimer = null; this._unsub = null; this._scen = null;
    // The four illustrative scenarios are the demo / fallback; REAL turns from
    // window.EOAudit (converted by window.EOMRI.traceFromTurn) are layered over
    // them and become the rail whenever any exist. The seeded history below only
    // ever shows in scenario mode (no live turns recorded yet).
    this.scenarioSeed = {
      turnNo: 3,
      history: [
        { key: 'clean', n: 1, scenario: 'clean', label: 'grounded turn', question: 'when was it published, and by whom?', witness: 0.92, form: 0.84, tone: '#3ddc84', asy: 0.66, verdict: 'grounded' },
        { key: 'repair', n: 2, scenario: 'repair', label: 'repair pair', question: 'what is it really about, underneath the plot?', witness: 0.70, form: 0.88, tone: '#00ccdd', asy: 0.71, verdict: 'repaired' }
      ],
      asympPoints: [0.66, 0.71]
    };
    const init = this.initData();
    this.TRACES = init.traces;
    this.hasReal = init.hasReal;
    this.state = Object.assign({ frameIdx: 0, playing: false, realCount: init.realCount }, init.state);
  }

  componentDidMount() {
    const A = (typeof window !== 'undefined') ? window.EOAudit : null;
    if (A && A.subscribe) { try { this._unsub = A.subscribe(() => this.onAuditChange()); } catch (e) {} }
    this.play();
  }
  componentWillUnmount() { clearTimeout(this.timer); clearInterval(this.typeTimer); if (this._unsub) { try { this._unsub(); } catch (e) {} } }
  componentDidUpdate() { ['cleo-answer', 'cleo-log'].forEach(id => { const e = document.getElementById(id); if (e) e.scrollTop = e.scrollHeight; }); }

  // The scenario trace map, built once and reused (so live refreshes never
  // rebuild the illustrative set).
  scenarioTraces() { if (!this._scen) this._scen = this.buildTraces(); return this._scen; }

  // The initial data: an explicit `traces` prop (tests) → scenario-shaped;
  // otherwise real turns from the audit log → live; otherwise the scenarios.
  initData() {
    const scen = this.scenarioTraces();
    if (this.props && this.props.traces) {
      const keys = Object.keys(this.props.traces);
      return { traces: Object.assign({}, scen, this.props.traces), hasReal: false, realCount: 0,
        state: { current: keys[0], scenarioMode: true, history: this.scenarioSeed.history.slice(),
          asympPoints: this.scenarioSeed.asympPoints.slice(), turnNo: this.scenarioSeed.turnNo } };
    }
    const real = this.buildFromAudit();
    if (real) {
      return { traces: Object.assign({}, scen, real.traces), hasReal: true, realCount: real.history.length,
        state: { current: real.current, scenarioMode: false, history: real.history,
          asympPoints: real.asympPoints, turnNo: real.turnNo } };
    }
    return { traces: scen, hasReal: false, realCount: 0,
      state: { current: 'clean', scenarioMode: true, history: this.scenarioSeed.history.slice(),
        asympPoints: this.scenarioSeed.asympPoints.slice(), turnNo: this.scenarioSeed.turnNo } };
  }

  // Read window.EOAudit, convert each settled turn to a trace, and summarize the
  // last few for the rail. Returns null when nothing is recorded (→ scenarios).
  buildFromAudit() {
    const A = (typeof window !== 'undefined') ? window.EOAudit : null;
    const TF = (typeof window !== 'undefined' && window.EOMRI) ? window.EOMRI.traceFromTurn : null;
    if (!A || !A.all || typeof TF !== 'function') return null;
    let turns;
    try { turns = A.all().filter(t => t && t.done && t.final && String(t.final.text || '').trim()); }
    catch (e) { return null; }
    if (!turns.length) return null;
    const traces = {}, history = [], asympPoints = [];
    turns.slice(-7).forEach((t, i) => {
      let tr = null; try { tr = TF(t); } catch (e) { tr = null; }
      if (!tr || !tr.frames || !tr.frames.length) return;
      const key = t.id || ('turn-' + i);
      traces[key] = tr;
      const af = tr.frames.find(f => f.op === 'asymptote');
      const sents = tr.frames.filter(f => f.op === 'sentence');
      const last = sents[sents.length - 1] || {};
      const m = /(\d+)\s*$/.exec(t.id || '');
      if (af && af.value != null) asympPoints.push(af.value);
      history.push({ key, n: m ? +m[1] : (i + 1), scenario: key, label: tr.label, question: t.input || '…',
        witness: last.witness != null ? last.witness : (af ? af.value : null),
        form: last.form != null ? last.form : null, tone: tr.tone, asy: af ? af.value : null, verdict: tr.verdictWord });
    });
    if (!history.length) return null;
    return { traces, history, asympPoints, current: history[history.length - 1].key, turnNo: history[history.length - 1].n };
  }

  // The audit log changed (a new turn settled, or a clear). Refresh the real
  // traces without yanking a turn the user is currently watching.
  onAuditChange() { try { this.refreshReal(false); } catch (e) {} }
  refreshReal(autoplay) {
    const real = this.buildFromAudit();
    this.hasReal = !!real;
    if (!real) { if (this.state.realCount) this.setState({ realCount: 0 }); return; }
    this.TRACES = Object.assign({}, this.scenarioTraces(), real.traces);
    if (this.state.scenarioMode) { this.setState({ realCount: real.history.length }); return; }
    const has = real.history.some(h => h.key === this.state.current);
    const patch = { history: real.history, asympPoints: real.asympPoints, realCount: real.history.length, turnNo: real.turnNo };
    if (!has) { patch.current = real.current; patch.frameIdx = 0; }
    this.setState(patch, () => { if (!has || autoplay) { this.replaying = false; this.play(); } });
  }

  // Return to the live rail from scenario (demo) mode.
  goLive() {
    const real = this.buildFromAudit();
    if (!real) return;
    this.TRACES = Object.assign({}, this.scenarioTraces(), real.traces);
    this.hasReal = true; this.replaying = false; this.typed = Infinity;
    clearTimeout(this.timer); clearInterval(this.typeTimer);
    this.setState({ scenarioMode: false, history: real.history, asympPoints: real.asympPoints,
      realCount: real.history.length, turnNo: real.turnNo, current: real.current, frameIdx: 0 }, () => this.play());
  }

  // operator firing is DERIVED from these events, never scripted.
  buildTraces() {
    return {
      clean: { label: 'grounded turn', genre: 'lookup', decision: 'mechanical', reason: 'who / when · strong lexical hits', tone: '#3ddc84', verdictWord: 'grounded', targetSite: 'Thing',
        frames: [
          { op: 'router' },
          { op: 'log', kind: 'question', prov: 'reader', text: 'who wrote it, and what was it about?' },
          { op: 'log', kind: 'retrieval', prov: 'retriever', mono: true, text: '[s12] written by H. G. Wells, 1895' },
          { op: 'log', kind: 'retrieval', prov: 'retriever', mono: true, text: '[s07] a traveller demonstrates a machine' },
          { op: 'log', kind: 'draft', prov: 'talker', text: 'talker drafts over the retrieved spans' },
          { op: 'sentence', text: 'It was written by H. G. Wells and first published in 1895.', witness: 0.96, form: 0.82, grounds: [{ id: 's12', text: 'written by H. G. Wells, 1895' }], site: 'Thing', object: 'Figure', notation: 'INS(Thing, Making)', resolution: 'Making' },
          { op: 'sentence', text: 'It follows a traveller who builds a machine and journeys far into the future.', witness: 0.88, form: 0.86, grounds: [{ id: 's07', text: 'a traveller demonstrates a machine' }], site: 'Thing', object: 'Figure', notation: 'INS(Thing, Making)', resolution: 'Making' },
          { op: 'log', kind: 'stamp', prov: 'monitor', text: 'witness 0.92 · form 0.84 · bound' },
          { op: 'verdict', text: 'grounded · spoken with high confidence' },
          { op: 'log', kind: 'accept', prov: 'reader', text: 'turn closed · accepted' },
          { op: 'learn', mode: 'lit', name: 'grounded-accept', trig: 'Accepted AND grounded. The witness is really there, so the sense drifts toward this answer. This is the only state the loop is allowed to learn from.' },
          { op: 'asymptote', value: 0.74 }
        ] },
      thin: { label: 'fluent on thin air', genre: 'lookup', decision: 'escalate', reason: 'wh-question · zero lexical hits', tone: '#ff8a3d', verdictWord: 'flagged', targetSite: 'Lens',
        frames: [
          { op: 'router' },
          { op: 'log', kind: 'question', prov: 'reader', text: 'what was the author’s political stance?' },
          { op: 'log', kind: 'retrieval', prov: 'retriever', mono: true, text: 'retriever: no span clears threshold' },
          { op: 'log', kind: 'draft', prov: 'talker', text: 'talker drafts from its prior, not the page' },
          { op: 'sentence', text: 'He was a committed Fabian socialist whose politics shaped the book’s vision of the future.', witness: 0.11, form: 0.83, alarm: true, groundNote: 'no retrieved span supports this — the talker drafted from its prior, not the page', site: 'Thing', object: 'Figure', notation: 'INS(Thing, Making)', resolution: 'Making' },
          { op: 'log', kind: 'stamp', prov: 'monitor', text: 'witness 0.11 · form 0.83 · FLUENT ON THIN AIR' },
          { op: 'verdict', text: 'flag raised · fluent, well-formed, ungrounded' },
          { op: 'log', kind: 'accept', prov: 'reader', text: 'turn closed · accepted by reader' },
          { op: 'learn', mode: 'blocked', name: 'witness-deficit', trig: 'Accepted, but thin. It sounded right on nothing — the dangerous state. Learning is REFUSED here, and the turn is routed to fetch instead.' },
          { op: 'log', kind: 'fetch', prov: 'system', text: 'witness-deficit → fetch a source on the subject' },
          { op: 'asymptote', value: 0.69 }
        ] },
      repair: { label: 'repair pair', genre: 'synthesis', decision: 'mechanical', reason: 'continuity · prior reply present', tone: '#00ccdd', verdictWord: 'repaired', targetSite: 'Paradigm',
        frames: [
          { op: 'router' },
          { op: 'log', kind: 'question', prov: 'reader', text: 'so what is it really about, underneath the plot?' },
          { op: 'log', kind: 'retrieval', prov: 'retriever', mono: true, text: '[s07] a traveller demonstrates a machine' },
          { op: 'log', kind: 'draft', prov: 'talker', text: 'talker drafts a first pass' },
          { op: 'sentence', text: 'The book is about a time machine and a journey to the year 802,701.', witness: 0.74, form: 0.31, rejected: true, grounds: [{ id: 's07', text: 'a traveller demonstrates a machine' }], site: 'Thing', object: 'Figure', notation: 'INS(Thing, Making)', resolution: 'Making' },
          { op: 'log', kind: 'stamp', prov: 'monitor', text: 'form 0.31 · below shape floor · reject' },
          { op: 'verdict', text: 'form low · restructure and retry' },
          { op: 'log', kind: 'draft', prov: 'talker', text: 'talker restructures · second pass' },
          { op: 'sentence', text: 'Underneath the adventure it is a fable about class and decline — the future read as the present’s shadow.', witness: 0.70, form: 0.88, grounds: [{ id: 's07', text: 'a traveller demonstrates a machine' }, { id: 'ctx', text: 'continuity with the prior reply in this turn' }], site: 'Paradigm', object: 'Pattern', notation: 'REC(Paradigm, Composing)', resolution: 'Composing' },
          { op: 'log', kind: 'stamp', prov: 'monitor', text: 'witness 0.70 · form 0.88 · bound' },
          { op: 'verdict', text: 'repaired · second draft accepted' },
          { op: 'log', kind: 'accept', prov: 'reader', text: 'turn closed · second draft accepted' },
          { op: 'learn', mode: 'lit', name: 'repair-pair', trig: 'Rejected then accepted is a direction. The sense drifts along that vector — away from the shape that failed, toward the one that held.' },
          { op: 'asymptote', value: 0.77 }
        ] },
      cold: { label: 'cold miss → ingestion', genre: 'lookup', decision: 'chat', reason: 'no signal · subject out of scope', tone: '#ffb800', verdictWord: 'fetched', targetSite: 'Network',
        frames: [
          { op: 'router' },
          { op: 'log', kind: 'question', prov: 'reader', text: 'how does this compare to Wells’ later novels?' },
          { op: 'log', kind: 'retrieval', prov: 'retriever', mono: true, text: 'no source in scope covers the subject' },
          { op: 'sentence', text: 'I don’t have anything on his later novels in what I’ve been handed.', witness: 0.20, form: 0.55, absence: true, groundNote: 'nothing in scope covers the subject — shown as absence, not asserted', site: 'Void', object: 'Ground', notation: 'report(Void, Tending)', resolution: 'Tending' },
          { op: 'log', kind: 'stamp', prov: 'monitor', text: 'witness 0.20 · cold miss' },
          { op: 'verdict', text: 'absence shown as a low-witness stamp, not asserted' },
          { op: 'log', kind: 'accept', prov: 'reader', text: 'reader asks again — repair signal' },
          { op: 'learn', mode: 'fetch', name: 'cold-repair', trig: 'A cold miss plus a repair signal. Nothing to learn yet — instead, broaden ingestion and pull a source into scope.' },
          { op: 'log', kind: 'fetch', prov: 'system', text: 'feed proxy → fetch a source · fold into Given-Log with provenance' },
          { op: 'log', kind: 'retrieval', prov: 'system', mono: true, text: '[src:wells-bib] ingested · marked system-fetched · auditable' },
          { op: 'log', kind: 'draft', prov: 'talker', text: 'talker drafts over the fetched source' },
          { op: 'sentence', text: 'With that source in hand: the later novels turn more polemical, where this one stays a parable.', witness: 0.81, form: 0.80, grounds: [{ id: 'src:wells-bib', text: 'system-fetched source · folded into the log · auditable' }], site: 'Paradigm', object: 'Pattern', notation: 'REC(Paradigm, Composing)', resolution: 'Composing' },
          { op: 'log', kind: 'stamp', prov: 'monitor', text: 'witness 0.81 · form 0.80 · bound after fetch' },
          { op: 'verdict', text: 'grounded after ingestion' },
          { op: 'asymptote', value: 0.79 }
        ] }
    };
  }

  siteDomain(site) { return ({ Void: 'Existence', Thing: 'Existence', Kind: 'Existence', Field: 'Structure', Link: 'Structure', Network: 'Structure', Atmosphere: 'Interpretation', Lens: 'Interpretation', Paradigm: 'Interpretation' })[site] || 'Existence'; }
  // grounded FOR ITS GRADE: a Figure/Pattern claim needs a span; a Ground claim (absence) is grounded by the condition itself.
  groundedForGrade(f) { const o = f.object || 'Figure'; if (o === 'Ground') return true; return !!(f.grounds && f.grounds.length); }

  // Derive operator firings from the real event stream (frames 0..i). Nothing is scripted:
  // an operator lights only because an event with its signature actually occurred.
  deriveOps(i) {
    const tr = this.TRACES[this.state.current];
    const fired = {}, seq = [], detail = {};
    let grounds = 0, sentenceCount = 0, rejectedSeen = false, lastFi = -1;
    const fire = (op, fi) => { if (!fired[op]) { fired[op] = { step: seq.length + 1, fi }; seq.push(op); } lastFi = Math.max(lastFi, fi); };
    for (let k = 0; k <= i && k < tr.frames.length; k++) {
      const f = tr.frames[k];
      if (k === 0) fire('NUL', k);                                  // turn opens from absence
      if (f.op === 'log') {
        if (f.kind === 'question') fire('SIG', k);                  // raw signal in
        if (f.kind === 'retrieval' && !/no span|no source/i.test(f.text)) {
          fire('INS', k); fire('SEG', k); grounds++;              // an instance cleared threshold
          if (grounds >= 2) fire('CON', k);                         // ≥2 grounds → connect
        }
        if (f.kind === 'stamp') fire('EVA', k);                     // monitor rendered a judgment
      }
      if (f.op === 'sentence') {
        sentenceCount++;
        const dom = this.siteDomain(f.site);
        fire({ Existence: 'INS', Structure: 'SYN', Interpretation: 'REC' }[dom] || 'INS', k); // produced-Domain Generate
        if (this.groundedForGrade(f)) { fire('DEF', k); }          // ground established ONLY if grounded for its grade
        if (f.grounds && f.grounds.length >= 2) fire('CON', k);
        if (f.rejected) rejectedSeen = true;
      }
    }
    // dependency prerequisites — what SHOULD have fired before each operator
    const PRE = { SIG: ['NUL'], INS: ['SIG'], SEG: ['INS'], CON: ['SEG'], SYN: ['CON'], EVA: ['DEF'], REC: ['EVA'] };
    const violations = {};
    for (const op of seq) {
      const missing = [], late = [];
      for (const p of (PRE[op] || [])) {
        if (!fired[p]) missing.push(p);
        else if (fired[p].step > fired[op].step) late.push(p);
      }
      detail[op] = { missing, late };
      violations[op] = missing.length ? 'skipped' : (late.length ? 'late' : null);
    }
    return { fired, seq, detail, violations, activeOp: (lastFi === i ? seq[seq.length - 1] : null), firedThisFrame: lastFi === i };
  }

  applyTo(i) {
    const tr = this.TRACES[this.state.current];
    const s = { logs: [], sents: [], verdict: 'verdict pending', witness: null, form: null,
      learn: { mode: 'idle', name: 'no trigger yet', trig: 'A grounded answer drifts the sense. A fluent-but-thin one is blocked and routed to fetch. The asymmetry is the whole point.' },
      routerShown: false, asympThis: null };
    for (let k = 0; k <= i && k < tr.frames.length; k++) {
      const f = tr.frames[k];
      switch (f.op) {
        case 'router': s.routerShown = true; break;
        case 'log': s.logs.push(f); break;
        case 'sentence': s.sents.push(Object.assign({ _fi: k }, f)); s.witness = f.witness; s.form = f.form; break;
        case 'verdict': s.verdict = f.text; break;
        case 'learn': s.learn = { mode: f.mode, name: f.name, trig: f.trig }; break;
        case 'asymptote': s.asympThis = f.value; break;
      }
    }
    return s;
  }

  hotRegion() {
    const tr = this.TRACES[this.state.current];
    const f = tr.frames[Math.min(this.state.frameIdx, tr.frames.length - 1)];
    if (!f) return 'spine';
    if (f.op === 'log') return f.kind === 'question' ? 'spine' : 'log';
    if (f.op === 'learn') return 'learn';
    if (f.op === 'asymptote') return 'turns';
    return 'spine';
  }

  gaugeColor(w) { if (w >= 0.6) return this.C.green; if (w >= 0.35) return this.C.amber; return this.C.red; }
  kindColor(k) { return ({ question: '#7f9a96', retrieval: '#2dd4bf', draft: '#ffb800', stamp: '#00ccdd', accept: '#3ddc84', fetch: '#9d6bff' })[k] || '#7f9a96'; }

  delayFor(f) { if (f.op === 'helix') return 220; if (f.op === 'log') return 520; if (f.op === 'loop') return 360; if (f.op === 'verdict') return 720; if (f.op === 'learn') return 1200; if (f.op === 'asymptote') return 600; return 460; }

  play() { clearTimeout(this.timer); this.setState({ playing: true }, () => { this.timer = setTimeout(() => this.tick(), 320); }); }
  pause() { clearTimeout(this.timer); clearInterval(this.typeTimer); this.setState({ playing: false }); }

  tick() {
    if (!this.state.playing) return;
    const tr = this.TRACES[this.state.current];
    if (this.state.frameIdx >= tr.frames.length - 1) { this.finishTurn(); return; }
    const next = this.state.frameIdx + 1, f = tr.frames[next];
    this.typed = Infinity;
    this.setState({ frameIdx: next }, () => {
      if (f.op === 'sentence') { this.typeOut(next, f.text); }
      else { this.timer = setTimeout(() => this.tick(), this.delayFor(f)); }
    });
  }

  typeOut(frameIdx, text) {
    this.typingKey = frameIdx; this.typed = 0; clearInterval(this.typeTimer); this.forceUpdate();
    this.typeTimer = setInterval(() => {
      this.typed = Math.min(text.length, this.typed + 2);
      this.forceUpdate();
      if (this.typed >= text.length) { clearInterval(this.typeTimer); this.timer = setTimeout(() => this.tick(), 1000); }
    }, 16);
  }

  finishTurn() {
    clearTimeout(this.timer); clearInterval(this.typeTimer);
    // Real turns are a fold over window.EOAudit — the rail never grows from a
    // playthrough; only the illustrative scenarios "generate" a new turn card.
    if (this.replaying || !this.state.scenarioMode) { this.setState({ playing: false }); return; }
    const tr = this.TRACES[this.state.current], s = this.applyTo(tr.frames.length - 1);
    const af = tr.frames.find(f => f.op === 'asymptote');
    const q = (tr.frames.find(f => f.op === 'log' && f.kind === 'question') || {}).text || '';
    const entry = { key: this.state.current, n: this.state.turnNo, scenario: this.state.current, label: tr.label, question: q, witness: s.witness, form: s.form, tone: tr.tone, asy: af ? af.value : null, verdict: tr.verdictWord };
    this.setState(st => ({ playing: false, history: [...st.history, entry].slice(-7),
      asympPoints: (af ? [...st.asympPoints, af.value] : st.asympPoints).slice(-7), turnNo: st.turnNo + 1 }));
  }

  // Inject an illustrative scenario — switches into demo mode (rail = scenarios).
  inject(name) {
    if (!this.TRACES[name]) return;
    this.replaying = false; this.typed = Infinity; clearTimeout(this.timer); clearInterval(this.typeTimer);
    const patch = { current: name, frameIdx: 0, scenarioMode: true };
    if (!this.state.scenarioMode) {   // coming from live → restore the demo seed
      patch.history = this.scenarioSeed.history.slice();
      patch.asympPoints = this.scenarioSeed.asympPoints.slice();
      patch.turnNo = this.scenarioSeed.turnNo;
    }
    this.setState(patch, () => this.play());
  }
  // Replay any rail card (real turn or scenario) by its key.
  replayKey(key) {
    if (!this.TRACES[key]) return;
    const h = (this.state.history || []).find(x => x.key === key);
    this.replaying = true; this.typed = Infinity; clearTimeout(this.timer); clearInterval(this.typeTimer);
    this.setState({ current: key, frameIdx: 0, turnNo: h ? h.n : this.state.turnNo }, () => this.play());
  }
  step(d) { clearTimeout(this.timer); clearInterval(this.typeTimer); this.typed = Infinity; const tr = this.TRACES[this.state.current]; this.setState(st => ({ playing: false, frameIdx: Math.max(0, Math.min(tr.frames.length - 1, st.frameIdx + d)) })); }
  scrub(v) { clearTimeout(this.timer); clearInterval(this.typeTimer); this.typed = Infinity; this.setState({ playing: false, frameIdx: Math.max(0, +v) }); }
  togglePlay() { if (this.state.playing) { this.pause(); return; } const tr = this.TRACES[this.state.current]; if (this.state.frameIdx >= tr.frames.length - 1) { this.replaying = false; this.setState({ frameIdx: 0 }, () => this.play()); } else this.play(); }

  renderVals() {
    const st = this.state, tr = this.TRACES[st.current], s = this.applyTo(st.frameIdx), hot = this.hotRegion();

    // helix — operators DERIVED from the event stream, with order-check (top = REC)
    const ops = this.deriveOps(st.frameIdx);
    const order = ['REC', 'EVA', 'DEF', 'SYN', 'CON', 'SEG', 'INS', 'SIG', 'NUL'];
    const helix = order.map(id => {
      const col = this.OPCOL[id], fr = ops.fired[id], fired = !!fr, active = ops.activeOp === id, vio = ops.violations[id];
      const bcol = vio === 'skipped' ? '#ff3b52' : vio === 'late' ? '#ffb800' : (fired ? col : '#15211f');
      let style = `display:flex;align-items:center;gap:6px;padding:3px 6px;margin:1.5px 0;border-radius:4px;background:#070d0e;color:${col};transition:all .3s;border:1px solid ${bcol};opacity:${active ? 1 : (fired ? 0.92 : 0.24)};`;
      if (active) style += `box-shadow:0 0 14px -2px ${bcol};transform:translateX(3px);`;
      else if (fired) style += `box-shadow:0 0 7px -4px ${bcol};`;
      let badge, bg;
      if (vio === 'skipped') { badge = '!'; bg = `color:#ff3b52;border-color:#ff3b52;`; }
      else if (vio === 'late') { badge = '↑'; bg = `color:#ffb800;border-color:#ffb800;`; }
      else if (fired) { badge = String(fr.step); bg = `color:${col};border-color:${col};`; }
      else { badge = '·'; bg = `color:#3a4d4a;border-color:#15211f;`; }
      return { glyph: this.OPS[id].glyph, name: this.OPS[id].name, style, badge,
        badgeStyle: `font-size:8px;font-weight:700;width:13px;height:13px;border-radius:3px;border:1px solid;display:flex;align-items:center;justify-content:center;flex-shrink:0;${bg}` };
    });
    // order-check summary
    const vlines = [];
    for (const op of ops.seq) {
      const d = ops.detail[op];
      if (d.missing.length) vlines.push({ txt: `${op} ran with no ${d.missing.join(' · ')}`, style: 'font-size:8.5px;line-height:1.35;margin-bottom:4px;color:#ff5d70;' });
      else if (d.late.length) vlines.push({ txt: `${op} ran before ${d.late.join(' · ')}`, style: 'font-size:8.5px;line-height:1.35;margin-bottom:4px;color:#ffb800;' });
    }
    const helixOk = vlines.length === 0 && ops.seq.length > 0;
    const helixHot = ops.firedThisFrame;

    // logs
    const logs = s.logs.map(l => {
      const kc = this.kindColor(l.kind);
      let dot = `width:7px;height:7px;border-radius:50%;margin-top:4px;background:${kc};`;
      if (l.kind === 'accept' || l.kind === 'fetch') dot += `box-shadow:0 0 6px ${kc};`;
      return { kind: l.kind, prov: l.prov, text: l.text,
        dotStyle: dot, kindStyle: `text-transform:uppercase;letter-spacing:.06em;color:${kc};`,
        textStyle: `font-size:9.5px;line-height:1.5;color:${l.mono ? '#cfe6e2' : '#7f9a96'};` };
    });

    // sentences
    const sents = s.sents.map((se, idx, arr) => {
      const isLast = idx === arr.length - 1;
      let shown = se.text, caret = false;
      if (isLast && this.typingKey === se._fi && this.typed < se.text.length) { shown = se.text.slice(0, this.typed); caret = true; }
      const wv = se.witness == null ? null : se.witness, fv = se.form == null ? null : se.form;
      const wc = this.gaugeColor(wv == null ? 0 : wv);
      let textColor = '#e8f4f1', deco = '';
      if (se.rejected) { textColor = '#9fb4b0'; deco = 'text-decoration:line-through;'; }
      else if (se.alarm) { textColor = '#ffd9a0'; }
      else if (se.absence) { textColor = '#a9bdb9'; }
      const grounds = (se.grounds || []).map(g => ({ id: g.id, text: g.text }));
      const grade = se.object || 'Figure';
      const groundedG = grade === 'Ground' || grounds.length > 0;
      let honTag, honCol;
      if (se.rejected) { honTag = 'REJECTED · FORM LOW'; honCol = '#ff3b52'; }
      // the relation gate held this claim: a span was cited, but its agency/speaker
      // inverts against the page — a caught fabrication, never counted grounded.
      else if (se.gateHeld) { honTag = 'RELATION HELD'; honCol = '#ff3b52'; }
      else if (!groundedG && grade === 'Figure') { honTag = 'CONFABULATION'; honCol = '#ff3b52'; }
      else if (grade === 'Ground') { honTag = 'HONEST ABSENCE'; honCol = '#3ddc84'; }
      // the two honest tiers of a bound claim: the page's own words vs a faithful
      // reword — both green (the page carries it), never the overclaim "verified".
      else if (se.verbatim) { honTag = 'VERBATIM'; honCol = '#5ee0a0'; }
      else { honTag = 'GROUNDED'; honCol = '#3ddc84'; }
      const accent = honCol;   // accent by honesty, not by raw witness magnitude
      const gradeLabel = grade === 'Ground' ? 'condition — the retrieval-miss IS the ground'
                       : grade === 'Pattern' ? 'pattern — cross-instance regularity'
                       : 'figure — a specific retrieved instance';
      return {
        shown, alarm: !!se.alarm, rejected: !!se.rejected, absence: !!se.absence,
        grounds, ungrounded: grounds.length === 0,
        groundNote: se.groundNote || 'drafted from the model’s prior — no retrieved span supports it',
        groundNoteStyle: `font-size:10px;line-height:1.5;color:#ff8a3d;background:rgba(255,138,61,.06);border-left:2px solid #ff8a3d;padding:6px 10px;border-radius:0 3px 3px 0;`,
        honTag, honStyle: `font-size:9px;color:#05090a;background:${honCol};padding:3px 8px;border-radius:3px;font-weight:700;letter-spacing:.05em;`,
        notation: se.notation || '', gradeLabel,
        rowStyle: `border:1px solid #15211f;border-left:3px solid ${accent};border-radius:7px;background:#0a1314;padding:13px 15px;margin-bottom:13px;animation:cleoAppear .3s ease;${se.rejected ? 'opacity:.66;' : ''}`,
        textStyle: `font-size:15px;line-height:1.55;color:${textColor};${deco}`,
        caretStyle: caret ? 'color:#ffb800;animation:cleoBlink 1s steps(1) infinite;margin-left:1px;' : 'display:none;',
        wbar: `height:100%;width:${wv == null ? 0 : Math.round(wv * 100)}%;background:${wc};transition:width .5s ease;`,
        fbar: `height:100%;width:${fv == null ? 0 : Math.round(fv * 100)}%;background:#00ccdd;transition:width .5s ease;`,
        wnum: wv == null ? '—' : wv.toFixed(2), fnum: fv == null ? '—' : fv.toFixed(2),
        wnumStyle: `font-size:16px;font-weight:700;color:${wv == null ? '#48605c' : wc};min-width:34px;`
      };
    });

    // verdict
    const vTone = s.sents.length ? tr.tone : '#48605c';
    const verdictStyle = `margin-top:6px;align-self:flex-start;font-size:10.5px;letter-spacing:.05em;padding:7px 13px;border-radius:4px;border:1px solid ${vTone};color:${vTone};background:${s.sents.length ? 'rgba(255,255,255,0.02)' : '#070d0e'};opacity:${s.verdict === 'verdict pending' ? 0.5 : 1};transition:all .3s;`;

    // learn
    const lm = s.learn.mode, learnHot = hot === 'learn';
    const lc = lm === 'lit' ? this.C.green : (lm === 'blocked' || lm === 'fetch') ? this.C.red : '#1d2e2b';
    let learnStyle = `margin-top:11px;border:1px solid ${lm === 'idle' ? '#15211f' : lc};border-radius:7px;padding:13px 15px;background:${lm === 'idle' ? '#070d0e' : 'rgba(255,255,255,0.018)'};opacity:${lm === 'idle' ? 0.55 : 1};transition:all .35s;`;
    if (learnHot && lm !== 'idle') learnStyle += `box-shadow:0 0 0 1px ${lc} inset,0 0 30px -8px ${lc};`;
    const pillMap = { lit: { t: 'drift ✓', bg: this.C.green, fg: '#05090a' }, blocked: { t: 'blocked', bg: '#5a1620', fg: this.C.red, bd: this.C.red }, fetch: { t: '→ fetch', bg: '#5a1620', fg: this.C.orange, bd: this.C.orange }, idle: { t: 'idle', bg: '#0e1819', fg: '#48605c', bd: '#1d2e2b' } };
    const pm = pillMap[lm] || pillMap.idle;
    const learnPillStyle = `font-size:9.5px;font-weight:700;letter-spacing:.05em;padding:3px 9px;border-radius:3px;background:${pm.bg};color:${pm.fg};${pm.bd ? 'border:1px solid ' + pm.bd + ';' : ''}`;
    const learnNameStyle = `font-size:10px;color:${lm === 'lit' ? this.C.green : (lm === 'idle' ? '#7f9a96' : this.C.red)};letter-spacing:.03em;`;

    // turns rail. In scenario (demo) mode a synthetic "current" card sits atop
    // the seeded/generated history; in live mode the rail IS the real audit
    // turns (newest first), with the one being scanned highlighted.
    let turnsSource;
    if (st.scenarioMode) {
      const curQ = (tr.frames.find(f => f.op === 'log' && f.kind === 'question') || {}).text || '…';
      turnsSource = [{ key: st.current, n: st.turnNo, question: curQ, witness: s.witness, form: s.form, tone: tr.tone, verdict: s.verdict === 'verdict pending' ? 'live' : tr.verdictWord, current: true }, ...st.history.slice().reverse()];
    } else {
      turnsSource = st.history.slice().reverse().map(h => Object.assign({}, h, { current: h.key === st.current }));
    }
    const turns = turnsSource.map(t => {
      const w = t.witness == null ? 0 : t.witness, fo = t.form == null ? 0 : t.form, isCur = !!t.current;
      return {
        n: t.n, question: t.question || '…', verdict: t.verdict || '…',
        cardStyle: `cursor:pointer;border:1px solid ${isCur ? t.tone : '#15211f'};background:${isCur ? 'rgba(0,204,221,0.035)' : '#070d0e'};border-radius:6px;padding:9px 11px;transition:all .2s;${isCur ? 'box-shadow:0 0 0 1px ' + t.tone + ' inset;' : ''}`,
        tagStyle: `font-size:8px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${t.tone};`,
        wbar: `height:100%;width:${Math.round(w * 100)}%;background:${this.gaugeColor(w)};`,
        fbar: `height:100%;width:${Math.round(fo * 100)}%;background:#00ccdd;`,
        onClick: (st.scenarioMode && isCur) ? (() => this.inject(t.key)) : (() => this.replayKey(t.key))
      };
    });

    // asymptote sparkline
    const committed = st.asympPoints.slice();
    const pending = (!this.replaying && s.asympThis != null && committed[committed.length - 1] !== s.asympThis) ? s.asympThis : null;
    const allPts = pending != null ? committed.concat([pending]) : committed;
    const n = Math.max(allPts.length, 5);
    const dots = allPts.map((v, i) => {
      const last = i === allPts.length - 1, isPending = pending != null && last;
      return { cx: +(4 + i / (n - 1) * 92).toFixed(2), cy: +(36 - v * 30).toFixed(2),
        r: last ? 2.1 : 1.5, fill: isPending ? '#05090a' : (last ? '#ffffff' : '#ffb800'), stroke: isPending ? '#ffb800' : '#ffb800' };
    });
    const poly = dots.map(d => d.cx + ',' + d.cy).join(' ');
    const asyStat = allPts.length ? allPts[allPts.length - 1].toFixed(2) : '—';

    // SITE face (Domain × Object) — a STATE: where the target is, not what's happening to it
    const SITE = [['Void', 'Thing', 'Kind'], ['Field', 'Link', 'Network'], ['Atmosphere', 'Lens', 'Paradigm']];
    const SITE_ABBR = { Void: 'Void', Thing: 'Thing', Kind: 'Kind', Field: 'Field', Link: 'Link', Network: 'Netwk', Atmosphere: 'Atmos', Lens: 'Lens', Paradigm: 'Pdgm' };
    const lastSent = s.sents.length ? s.sents[s.sents.length - 1] : null;
    const targetSite = s.routerShown ? tr.targetSite : null;
    const producedSite = lastSent ? lastSent.site : null;
    const prodHon = lastSent ? ((lastSent.rejected || (!((lastSent.object || 'Figure') === 'Ground') && !(lastSent.grounds && lastSent.grounds.length))) ? '#ff3b52' : '#3ddc84') : '#3ddc84';
    const siteCells = [];
    for (const rowArr of SITE) { for (const name of rowArr) {
      const isT = name === targetSite, isP = name === producedSite;
      let stl = `border-radius:3px;padding:6px 2px;text-align:center;font-size:7.5px;letter-spacing:.01em;transition:all .35s;border:1px solid ${isP ? prodHon : (isT ? '#00ccdd' : '#15211f')};`;
      if (isP) { stl += `background:${prodHon}22;color:#e8f4f1;font-weight:700;box-shadow:0 0 10px -3px ${prodHon};`; }
      else if (isT) { stl += `background:rgba(0,204,221,.06);color:#9fe9f0;border-style:dashed;`; }
      else { stl += `background:#0a1213;color:#3a4d4a;`; }
      siteCells.push({ label: SITE_ABBR[name] || name, style: stl });
    } }
    // RESOLUTION face (Mode × Object) — how the target is held
    const RES = [['Clearing', 'Dissecting', 'Unraveling'], ['Tending', 'Binding', 'Tracing'], ['Cultivating', 'Making', 'Composing']];
    const RES_ABBR = { Clearing: 'Clear', Dissecting: 'Dissect', Unraveling: 'Unravel', Tending: 'Tend', Binding: 'Bind', Tracing: 'Trace', Cultivating: 'Cultv', Making: 'Make', Composing: 'Compose' };
    const activeRes = lastSent ? lastSent.resolution : null;
    const resCells = [];
    for (const rowArr of RES) { for (const name of rowArr) {
      const isA = name === activeRes;
      let stl = `border-radius:3px;padding:6px 2px;text-align:center;font-size:7.5px;letter-spacing:.01em;transition:all .35s;border:1px solid ${isA ? '#ffb800' : '#15211f'};`;
      if (isA) { stl += `background:rgba(255,184,0,.1);color:#ffd98a;font-weight:700;box-shadow:0 0 10px -3px #ffb800;`; }
      else { stl += `background:#0a1213;color:#3a4d4a;`; }
      resCells.push({ label: RES_ABBR[name] || name, style: stl });
    } }
    const notationNow = lastSent ? (lastSent.notation || '') : '';
    const siteMismatch = !!(targetSite && producedSite && targetSite !== producedSite);
    const siteCaption = siteMismatch ? `target ${targetSite} → produced ${producedSite}` : (producedSite ? `at ${producedSite}` : (targetSite ? `target ${targetSite}` : 'awaiting turn'));
    const siteCaptionStyle = `font-size:8px;line-height:1.4;margin-top:6px;color:${siteMismatch ? '#ffb800' : '#7f9a96'};`;

    // header
    const wmu = s.witness == null ? '—' : s.witness.toFixed(2);
    const wmuStyle = `font-size:14px;font-weight:700;line-height:1;color:${s.witness == null ? '#48605c' : this.gaugeColor(s.witness)};`;
    const atEnd = st.frameIdx >= tr.frames.length - 1;
    const modeLabel = st.playing ? '● LIVE' : (atEnd ? 'TURN END' : 'REPLAY');
    const modeColor = st.playing ? this.C.red : (atEnd ? '#48605c' : this.C.cyan);
    const modeStyle = `font-size:9px;font-weight:700;letter-spacing:.08em;padding:3px 9px;border-radius:3px;color:${modeColor};border:1px solid ${modeColor};${st.playing ? 'background:rgba(255,59,82,0.08);' : ''}`;

    // scenario buttons
    const sBase = (on, col) => `cursor:pointer;padding:4px 9px;font-size:9px;border-radius:3px;border:1px solid ${on ? col : '#1d2e2b'};color:${on ? '#05090a' : '#7f9a96'};background:${on ? col : '#0c1517'};font-weight:${on ? '700' : '400'};transition:all .15s;`;
    const live = !st.scenarioMode;
    const subtitle = (live && this.hasReal)
      ? `${st.realCount} real turn${st.realCount !== 1 ? 's' : ''} from the audit log · a fold over window.EOAudit`
      : (this.hasReal ? 'illustrative scenarios · ● live returns to the real turns'
                      : 'illustrative scenarios · run a chat turn to scan real cognition');

    return {
      turnNo: st.turnNo, wmu, wmuStyle, asyStat,
      hasReal: this.hasReal, live, realCount: st.realCount, subtitle,
      goLive: () => this.goLive(), liveStyle: sBase(live && this.hasReal, this.C.green),
      modeLabel, modeStyle,
      onPrev: () => this.step(-1), onNext: () => this.step(1), onPlay: () => this.togglePlay(),
      playLabel: st.playing ? '❚❚ pause' : '▶ play',
      playStyle: `cursor:pointer;padding:4px 11px;font-size:9px;letter-spacing:.06em;text-transform:uppercase;border-radius:3px;border:1px solid ${st.playing ? '#00ccdd' : '#1d2e2b'};color:${st.playing ? '#00ccdd' : '#7f9a96'};background:${st.playing ? 'rgba(0,204,221,0.06)' : '#0c1517'};`,
      injClean: () => this.inject('clean'), injThin: () => this.inject('thin'), injRepair: () => this.inject('repair'), injCold: () => this.inject('cold'),
      scenClean: sBase(st.current === 'clean', this.C.green), scenThin: sBase(st.current === 'thin', this.C.orange),
      scenRepair: sBase(st.current === 'repair', this.C.amber), scenCold: sBase(st.current === 'cold', this.C.NUL),
      scrubMax: tr.frames.length - 1, scrubVal: st.frameIdx, onScrub: (e) => this.scrub(e.target.value),
      frameInfo: `frame ${st.frameIdx + 1} / ${tr.frames.length} · ${tr.label}`,
      ask: (tr.frames.find(f => f.op === 'log' && f.kind === 'question') || {}).text || '…',
      routerGen: tr.genre, routerDec: tr.decision, routerReason: s.routerShown ? tr.reason : 'awaiting turn',
      routerStyle: `font-size:9.5px;color:#48605c;letter-spacing:.03em;margin-top:11px;opacity:${s.routerShown ? 1 : 0.3};transition:opacity .4s;`,
      sents, verdictText: s.verdict, verdictStyle,
      learnStyle, learnPill: pm.t, learnPillStyle, learnName: s.learn.name, learnNameStyle, learnTrig: s.learn.trig,
      helix, vlines, helixOk, logs, turns,
      siteCells, resCells, notationNow, siteCaption, siteCaptionStyle,
      asy: { poly, dots },
      logOpacity: hot === 'log' ? 1 : 0.38, helixOpacity: helixHot ? 1 : 0.55, turnsOpacity: hot === 'turns' ? 1 : 0.72
    };
  }

  render() {
    const v = this.renderVals();
    const S = eomriCss;
    const onClose = () => { this.pause(); if (this.props.onClose) this.props.onClose(); };
    return (
      <div className="eomri-canvas" style={S("flex:1;min-height:0;background:#05090a;color:#cfe6e2;font:11px/1.5 ui-monospace,'SF Mono',Menlo,Consolas,monospace;display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased;")}>

        {/* TOP BAR */}
        <div style={S("flex-shrink:0;background:#000;border-bottom:1px solid #1d2e2b;display:flex;align-items:center;gap:16px;padding:9px 14px;")}>
          <div style={S("font-weight:700;letter-spacing:.14em;font-size:12px;color:#00ccdd;")}>EO-MRI<span style={S("color:#48605c;font-weight:400;")}> · cognition instrument</span></div>
          <div style={S("font-size:9px;color:#48605c;letter-spacing:.05em;")}>eoreader3 · {v.subtitle}</div>
          <div style={S("flex:1;")}></div>
          <div style={S("display:flex;flex-direction:column;align-items:flex-end;gap:1px;")}><span style={S("font-size:8px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;")}>turn</span><span style={S("font-size:14px;font-weight:700;color:#00ccdd;line-height:1;")}>{v.turnNo}</span></div>
          <div style={S("display:flex;flex-direction:column;align-items:flex-end;gap:1px;")}><span style={S("font-size:8px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;")}>witness</span><span style={S(v.wmuStyle)}>{v.wmu}</span></div>
          <div style={S("display:flex;flex-direction:column;align-items:flex-end;gap:1px;")}><span style={S("font-size:8px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;")}>asymptote</span><span style={S("font-size:14px;font-weight:700;color:#ffb800;line-height:1;")}>{v.asyStat}</span></div>
          <div style={S("width:1px;height:22px;background:#1d2e2b;")}></div>
          <div style={S(v.modeStyle)}>{v.modeLabel}</div>
          <div onClick={onClose} style={S("cursor:pointer;font-size:13px;color:#48605c;padding:2px 6px;")} title="close">✕</div>
        </div>

        {/* CONTROLS */}
        <div style={S("flex-shrink:0;background:#0a1012;border-bottom:1px solid #15211f;display:flex;align-items:center;gap:9px;padding:7px 14px;")}>
          <div onClick={v.onPrev} style={S("cursor:pointer;background:#0c1517;color:#7f9a96;border:1px solid #1d2e2b;padding:4px 9px;font-size:9px;letter-spacing:.06em;text-transform:uppercase;border-radius:3px;")}>◀ step</div>
          <div onClick={v.onPlay} style={S(v.playStyle)}>{v.playLabel}</div>
          <div onClick={v.onNext} style={S("cursor:pointer;background:#0c1517;color:#7f9a96;border:1px solid #1d2e2b;padding:4px 9px;font-size:9px;letter-spacing:.06em;text-transform:uppercase;border-radius:3px;")}>step ▶</div>
          <div style={S("width:1px;height:18px;background:#1d2e2b;margin:0 3px;")}></div>
          {v.hasReal && <div onClick={v.goLive} style={S(v.liveStyle)} title="play the most recent real turn from the audit log">● live{v.realCount ? ' · ' + v.realCount : ''}</div>}
          <span style={S("font-size:8px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;")}>{v.hasReal ? 'illustrative' : 'inject turn'}</span>
          <div onClick={v.injClean} style={S(v.scenClean)}>grounded</div>
          <div onClick={v.injThin} style={S(v.scenThin)}>fluent · thin</div>
          <div onClick={v.injRepair} style={S(v.scenRepair)}>repair</div>
          <div onClick={v.injCold} style={S(v.scenCold)}>cold miss → fetch</div>
          <input type="range" min="0" max={v.scrubMax} value={v.scrubVal} onChange={v.onScrub} style={S("flex:1;accent-color:#00ccdd;height:3px;margin:0 4px;")} />
          <div style={S("font-size:9px;color:#48605c;min-width:160px;text-align:right;")}>{v.frameInfo}</div>
        </div>

        {/* MAIN */}
        <div style={S("flex:1;min-height:0;display:grid;grid-template-columns:248px 1fr 360px;")}>

          {/* COL 1 · TURNS RAIL */}
          <div style={S("border-right:1px solid #15211f;display:flex;flex-direction:column;min-height:0;background:#060c0d;opacity:" + v.turnsOpacity + ";transition:opacity .4s;")}>
            <div style={S("background:#000;border-bottom:1px solid #1d2e2b;padding:6px 11px;display:flex;align-items:center;gap:7px;flex-shrink:0;")}><span style={S("font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7f9a96;")}>Turns</span><span style={S("margin-left:auto;font-size:8px;color:#48605c;")}>click to replay</span></div>
            <div style={S("flex:1;min-height:0;overflow-y:auto;padding:9px;display:flex;flex-direction:column;gap:7px;")}>
              {v.turns.map((t, i) => (
                <div key={i} onClick={t.onClick} style={S(t.cardStyle)}>
                  <div style={S("display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;")}>
                    <span style={S("font-size:9px;color:#7f9a96;letter-spacing:.04em;")}>turn {t.n}</span>
                    <span style={S(t.tagStyle)}>{t.verdict}</span>
                  </div>
                  <div style={S("font-size:10.5px;color:#cfe6e2;line-height:1.45;margin-bottom:9px;")}>{t.question}</div>
                  <div style={S("display:flex;align-items:center;gap:7px;margin-bottom:3px;")}><span style={S("font-size:7.5px;color:#48605c;width:9px;")}>W</span><div style={S("flex:1;height:5px;background:#0e1819;border-radius:3px;overflow:hidden;")}><div style={S(t.wbar)}></div></div></div>
                  <div style={S("display:flex;align-items:center;gap:7px;")}><span style={S("font-size:7.5px;color:#48605c;width:9px;")}>F</span><div style={S("flex:1;height:5px;background:#0e1819;border-radius:3px;overflow:hidden;")}><div style={S(t.fbar)}></div></div></div>
                </div>
              ))}
            </div>
            <div style={S("border-top:1px solid #15211f;padding:10px 11px;background:#000;flex-shrink:0;")}>
              <div style={S("font-size:8px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;margin-bottom:7px;")}>calibration · confidence over turns</div>
              <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={S("width:100%;height:48px;display:block;")}>
                <line x1="0" y1="6" x2="100" y2="6" stroke="#1d2e2b" strokeWidth="0.6" strokeDasharray="2 2"></line>
                <polyline points={v.asy.poly} fill="none" stroke="#ffb800" strokeWidth="1.4" vectorEffect="non-scaling-stroke"></polyline>
                {v.asy.dots.map((d, i) => (
                  <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={d.fill} stroke={d.stroke} strokeWidth="0.6"></circle>
                ))}
              </svg>
              <div style={S("font-size:8px;color:#7f9a96;margin-top:5px;")}>approaches 1.0 · <span style={S("color:#48605c;")}>never reaches it</span></div>
            </div>
          </div>

          {/* COL 2 · SPINE */}
          <div style={S("border-right:1px solid #15211f;display:flex;flex-direction:column;min-height:0;background:#070d0e;")}>
            <div style={S("background:#000;border-bottom:1px solid #1d2e2b;padding:6px 13px;display:flex;align-items:center;gap:7px;flex-shrink:0;")}><span style={S("font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#ffb800;")}>The turn</span><span style={S("margin-left:auto;font-size:8px;color:#48605c;")}>one sentence · two stamps · what the loop does about it</span></div>
            {/* ask · pinned top */}
            <div style={S("flex-shrink:0;padding:15px 30px 13px;border-bottom:1px solid #0e1819;")}>
              <div style={S("max-width:640px;margin:0 auto;")}>
                <div style={S("font-size:9px;color:#48605c;letter-spacing:.16em;text-transform:uppercase;margin-bottom:7px;")}>incoming turn · ask</div>
                <div style={S("font-size:16px;line-height:1.45;color:#cfe6e2;font-weight:500;border-left:2px solid #1d2e2b;padding:1px 0 1px 14px;")}>{v.ask}</div>
                <div style={S(v.routerStyle)}>router  ·  {v.routerGen}  ·  {v.routerDec}  —  {v.routerReason}</div>
              </div>
            </div>
            {/* answer · scrolls */}
            <div id="cleo-answer" style={S("flex:1;min-height:0;overflow-y:auto;padding:15px 30px;")}>
              <div style={S("max-width:640px;margin:0 auto;display:flex;flex-direction:column;")}>
                <div style={S("font-size:9px;color:#48605c;letter-spacing:.16em;text-transform:uppercase;margin-bottom:11px;")}>answer</div>
                {v.sents.map((se, i) => (
                  <div key={i} style={S(se.rowStyle)}>
                    <div style={S("display:flex;align-items:center;gap:8px;margin-bottom:10px;")}>
                      <span style={S("width:14px;height:14px;border-radius:50%;background:#0e1819;border:1px solid #1d2e2b;display:flex;align-items:center;justify-content:center;font-size:9px;color:#ffb800;flex-shrink:0;")}>⊨</span>
                      <span style={S("font-size:8.5px;color:#cfe6e2;letter-spacing:.13em;text-transform:uppercase;font-weight:700;")}>Cleo</span>
                      <span style={S("font-size:8.5px;color:#48605c;letter-spacing:.13em;text-transform:uppercase;")}>says · spoken output</span>
                      <span style={S("flex:1;")}></span>
                      <span style={S(se.honStyle)}>{se.honTag}</span>
                    </div>

                    <div style={S("font-size:9px;color:#7f9a96;font-variant-ligatures:none;margin-bottom:10px;letter-spacing:.02em;")}><span style={S("color:#48605c;")}>address</span>{'  '}{se.notation}</div>

                    <div style={S(se.textStyle)}>“{se.shown}<span style={S(se.caretStyle)}>▋</span>”</div>

                    <div style={S("margin-top:13px;padding-top:11px;border-top:1px solid #11201e;")}>
                      <div style={S("display:flex;align-items:baseline;gap:8px;margin-bottom:7px;flex-wrap:wrap;")}><span style={S("font-size:8px;color:#48605c;letter-spacing:.13em;text-transform:uppercase;")}>grounded in</span><span style={S("font-size:8px;color:#6f8a86;")}>{se.gradeLabel}</span></div>
                      {se.ungrounded && (<div style={S(se.groundNoteStyle)}>{se.groundNote}</div>)}
                      {se.grounds.map((g, j) => (
                        <div key={j} style={S("display:flex;align-items:baseline;gap:9px;margin-bottom:5px;")}>
                          <span style={S("font-size:9px;color:#2dd4bf;border:1px solid #1d3b38;background:rgba(45,212,191,.08);padding:2px 6px;border-radius:3px;font-weight:700;flex-shrink:0;font-variant-ligatures:none;")}>{g.id}</span>
                          <span style={S("font-size:10px;color:#8aa6a1;line-height:1.45;")}>{g.text}</span>
                        </div>
                      ))}
                    </div>

                    <div style={S("display:flex;gap:22px;align-items:center;margin-top:12px;padding-top:11px;border-top:1px solid #11201e;flex-wrap:wrap;")}>
                      <div style={S("display:flex;align-items:center;gap:10px;")}>
                        <span style={S("font-size:9px;color:#48605c;letter-spacing:.12em;text-transform:uppercase;width:48px;")}>witness</span>
                        <div style={S("width:108px;height:9px;background:#0e1819;border:1px solid #15211f;border-radius:5px;overflow:hidden;")}><div style={S(se.wbar)}></div></div>
                        <span style={S(se.wnumStyle)}>{se.wnum}</span>
                      </div>
                      <div style={S("display:flex;align-items:center;gap:10px;")}>
                        <span style={S("font-size:9px;color:#48605c;letter-spacing:.12em;text-transform:uppercase;width:34px;")}>form</span>
                        <div style={S("width:108px;height:9px;background:#0e1819;border:1px solid #15211f;border-radius:5px;overflow:hidden;")}><div style={S(se.fbar)}></div></div>
                        <span style={S("font-size:16px;font-weight:700;color:#00ccdd;min-width:34px;")}>{se.fnum}</span>
                      </div>
                    </div>
                  </div>
                ))}

                <div style={S(v.verdictStyle)}>{v.verdictText}</div>
                <div style={S(v.learnStyle)}>
                  <div style={S("display:flex;align-items:center;gap:11px;margin-bottom:8px;flex-wrap:wrap;")}>
                    <span style={S("font-size:9px;color:#48605c;letter-spacing:.16em;text-transform:uppercase;")}>self-learning</span>
                    <span style={S(v.learnPillStyle)}>{v.learnPill}</span>
                    <span style={S(v.learnNameStyle)}>{v.learnName}</span>
                  </div>
                  <div style={S("font-size:11.5px;line-height:1.55;color:#cfe6e2;")}>{v.learnTrig}</div>
                </div>
              </div>
            </div>
          </div>

          {/* COL 3 · HELIX + LOG */}
          <div style={S("display:flex;flex-direction:column;min-height:0;background:#060c0d;")}>
            <div style={S("background:#000;border-bottom:1px solid #1d2e2b;padding:6px 11px;display:flex;align-items:center;gap:7px;flex-shrink:0;")}><span style={S("font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7f9a96;")}>Internals</span><span style={S("margin-left:auto;font-size:8px;color:#48605c;")}>three faces · site → act → resolution</span></div>
            <div style={S("flex:1;min-height:0;display:flex;flex-direction:column;")}>
              <div style={S("flex:1;min-height:0;display:flex;")}>
                {/* ACT face */}
                <div style={S("width:108px;border-right:1px solid #15211f;padding:9px 7px;display:flex;flex-direction:column;opacity:" + v.helixOpacity + ";transition:opacity .4s;background:#070d0e;")}>
                  <div style={S("font-size:7px;color:#48605c;letter-spacing:.08em;text-transform:uppercase;text-align:center;margin-bottom:7px;")}>act · operators</div>
                  <div style={S("flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden;")}>
                    {v.helix.map((hh, i) => (
                      <div key={i} style={S(hh.style)}><span style={S("font-size:12px;width:13px;text-align:center;flex-shrink:0;")}>{hh.glyph}</span><span style={S("font-size:8.5px;font-weight:700;letter-spacing:.03em;flex:1;")}>{hh.name}</span><span style={S(hh.badgeStyle)}>{hh.badge}</span></div>
                    ))}
                  </div>
                  <div style={S("margin-top:8px;padding-top:8px;border-top:1px solid #15211f;")}>
                    <div style={S("font-size:7px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px;")}>order check</div>
                    {v.helixOk && (<div style={S("font-size:8px;color:#3ddc84;line-height:1.4;")}>✓ in order</div>)}
                    {v.vlines.map((vl, i) => (<div key={i} style={S(vl.style)}>⚠ {vl.txt}</div>))}
                  </div>
                </div>
                {/* SITE + RESOLUTION faces */}
                <div style={S("flex:1;min-height:0;display:flex;flex-direction:column;padding:9px;overflow-y:auto;")}>
                  <div style={S("font-size:7.5px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px;")}>site · where <span style={S("color:#3a4d4a;")}>(state)</span></div>
                  <div style={S("display:grid;grid-template-columns:repeat(3,1fr);gap:3px;")}>
                    {v.siteCells.map((c, i) => (<div key={i} style={S(c.style)}>{c.label}</div>))}
                  </div>
                  <div style={S(v.siteCaptionStyle)}>{v.siteCaption}</div>
                  <div style={S("font-size:7.5px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;margin:12px 0 6px;")}>resolution · how held</div>
                  <div style={S("display:grid;grid-template-columns:repeat(3,1fr);gap:3px;")}>
                    {v.resCells.map((c, i) => (<div key={i} style={S(c.style)}>{c.label}</div>))}
                  </div>
                  <div style={S("margin-top:12px;padding-top:9px;border-top:1px solid #15211f;")}>
                    <div style={S("font-size:7px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;margin-bottom:5px;")}>address · operator(site, resolution)</div>
                    <div style={S("font-size:10.5px;color:#cfe6e2;font-variant-ligatures:none;")}>{v.notationNow}</div>
                  </div>
                </div>
              </div>
              {/* Given-Log */}
              <div style={S("height:128px;flex-shrink:0;border-top:1px solid #15211f;display:flex;flex-direction:column;opacity:" + v.logOpacity + ";transition:opacity .4s;")}>
                <div style={S("padding:6px 10px;border-bottom:1px solid #15211f;flex-shrink:0;")}><span style={S("font-size:8px;color:#48605c;letter-spacing:.08em;text-transform:uppercase;")}>Given-Log · the Site state, as a fold</span></div>
                <div id="cleo-log" style={S("flex:1;min-height:0;overflow-y:auto;padding:6px 9px;")}>
                  {v.logs.map((l, i) => (
                    <div key={i} style={S("display:grid;grid-template-columns:11px 1fr;gap:8px;padding:4px 1px;border-bottom:1px dotted #15211f;animation:cleoAppear .28s ease;")}>
                      <div style={S(l.dotStyle)}></div>
                      <div>
                        <div style={S("display:flex;gap:7px;font-size:8px;margin-bottom:2px;")}><span style={S(l.kindStyle)}>{l.kind}</span><span style={S("color:#48605c;")}>{l.prov}</span></div>
                        <div style={S(l.textStyle)}>{l.text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    );
  }
}

/* The drawer chrome: a centered, near-fullscreen overlay hosting the
   instrument, which carries its own top bar + close ✕. Esc / click-outside
   close it via the shared dialog hook, like every other mode. */
function EOMRIDrawer({ onClose }) {
  const dialogRef = window.useDialog(onClose);
  return (
    <div className="overlay center eomri-overlay" onClick={onClose}>
      <div className="drawer eomri-drawer" role="dialog" aria-modal="true" aria-label="EO-MRI — cognition instrument"
           tabIndex={-1} ref={dialogRef} onClick={e => e.stopPropagation()}>
        <EOMRIInstrument onClose={onClose} />
      </div>
    </div>
  );
}

/* ============================================================
   The real-data seam — a window.EOAudit turn → an instrument trace.

   The instrument renders whatever trace map it is handed; this adapter turns a
   recorded turn (audit.js: route → ground → retrieve → phrase → veto → cite)
   into the { label, genre, decision, reason, tone, verdictWord, targetSite,
   frames:[…] } shape buildTraces() emits, so the three faces, the helix
   order-check, the witness/form gauges and the asymptote all read the REAL turn.

   Nothing here is invented where the engine already measures it:
     • the per-sentence 3-fold address is the engine's own encoder
       (window.EOEngine.eoAddressOfEvent / eoNotation — the operator(Site,
       Resolution) of docs/reading-conformance.md), not a hand-rolled guess;
     • witness is the audit's WI-7 degree (the marker-degree per sentence,
       falling back to the turn's coverage), the same number the asymptote tracks;
     • grounds are the turn's own {{cite}}s resolved to their retrieved span text;
     • the verdict / learn asymmetry is read off the audit (grounded · unbound ·
       absent · refused), never scripted.
   Pure and defensive: a malformed turn yields null and the instrument falls back
   to the illustrative scenarios.
   ============================================================ */
const EOMRI_STOP = new Set(('a an the and or but if then else of to in on at by with from into over under is are was were '
  + 'be been being am do does did have has had will would can could may might must not no so than too very just only also '
  + 'this that these those it its he she they them his her their there here who what when where why how as up out off down about').split(/\s+/));

function eomriTrunc(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function eomriFrac(s) { const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(s == null ? '' : s)); if (!m) return null; const d = +m[2]; return d ? +m[1] / d : null; }
function eomriClamp(x) { return x == null ? null : Math.max(0, Math.min(1, x)); }

// idx → retrieved span text, gathered from every retrieve step's hits — what a
// {{cite:doc:idx:label}} actually stood on.
function eomriHitsIndex(turn) {
  const m = {};
  for (const s of (turn.steps || [])) {
    if (s && s.t === 'retrieve' && Array.isArray(s.hits)) {
      for (const h of s.hits) { if (h && h.idx != null && m[h.idx] == null) m[h.idx] = eomriTrunc(h.text, 80); }
    }
  }
  return m;
}

// The retrieval frames (the Given-Log spans): the top deduped hits, or an honest
// "no span cleared threshold" line (which deriveOps reads as a cold retrieval, so
// INS/SEG never light for it).
function eomriRetrievalFrames(turn) {
  const seen = new Set(), hits = [];
  for (const s of (turn.steps || [])) {
    if (s && s.t === 'retrieve' && Array.isArray(s.hits)) {
      for (const h of s.hits) { const k = 's' + (h && h.idx); if (h && h.idx != null && !seen.has(k)) { seen.add(k); hits.push(h); } }
    }
  }
  if (!hits.length) {
    const tried = (turn.steps || []).some(s => s && s.t === 'retrieve');
    return [{ op: 'log', kind: 'retrieval', prov: 'retriever', mono: true,
      text: tried ? 'retriever: no span cleared threshold' : 'no source in scope covers the subject' }];
  }
  return hits.slice(0, 4).map(h => ({ op: 'log', kind: 'retrieval', prov: 'retriever', mono: true,
    text: '[s' + h.idx + '] ' + eomriTrunc(h.text, 76) }));
}

// The Generate Domain the question points at — Existence lookups · Structure
// relations · Interpretation sense — which fixes the produced operator (INS/SYN/
// REC) and the dashed target Site.
function eomriDomain(q) {
  const s = String(q || '').toLowerCase();
  if (/\bwhy\b|about|mean|theme|underneath|really about|significan|interpret|implic|symbol|point of|message/.test(s)) return 'Interpretation';
  if (/relationship|between|compare|compared|connect|relate|related|versus|\bvs\b|linked|\btie/.test(s)) return 'Structure';
  return 'Existence';
}
function eomriTargetSite(domain) { return ({ Existence: 'Thing', Structure: 'Network', Interpretation: 'Paradigm' })[domain] || 'Thing'; }

// The 3-fold address of one answer sentence, from the engine's own encoder. The
// operator is the Generate op of the question's Domain (or NUL for a cold/absent
// claim); the Site, Object and Resolution come from window.EOEngine, with a
// name-aligned fallback when the engine isn't present.
function eomriAddress(sentence, domain) {
  // A registered ABSENCE is the preserved non-resolution: NUL reads Object Ground
  // and generates Void (Differentiate × Ground = Clearing). It is fixed here, not
  // routed through the engine, because an empty NUL target falls back to the
  // legacy Figure cell unless site_entity_cell is on (off by default for golden
  // parity) — and we never want the instrument to mutate engine rules.
  if (sentence.absent) return { op: 'NUL', site: 'Void', object: 'Ground', resolution: 'Clearing', notation: 'NUL(Void, Clearing)' };
  // An assertion (grounded or confabulated) is a Generate of the question's
  // Domain; the Site, Object and Resolution come from the engine's own encoder.
  const E = (typeof window !== 'undefined') ? window.EOEngine : null;
  const op = ({ Existence: 'INS', Structure: 'SYN', Interpretation: 'REC' })[domain] || 'INS';
  const target = (sentence.grounds && sentence.grounds[0] && sentence.grounds[0].text) || sentence.text || '';
  if (E && typeof E.eoAddressOfEvent === 'function') {
    try {
      const a = E.eoAddressOfEvent({ op: op, target: target });
      if (a && a.site && a.resolution) {
        const site = a.site === 'Entity' ? 'Thing' : a.site;   // the instrument's grid spells the (Existence,Figure) cell 'Thing'
        return { op: op, site: site, object: a.object || 'Figure', resolution: a.resolution, notation: op + '(' + site + ', ' + a.resolution + ')' };
      }
    } catch (e) {}
  }
  const site = ({ Existence: 'Thing', Structure: 'Link', Interpretation: 'Lens' })[domain] || 'Thing';
  const resolution = ({ Existence: 'Making', Structure: 'Binding', Interpretation: 'Composing' })[domain] || 'Making';
  return { op: op, site: site, object: 'Figure', resolution: resolution, notation: op + '(' + site + ', ' + resolution + ')' };
}

// Split the settled answer into sentences, recovering per-sentence witness (the
// WI-7 marker degree, falling back to the turn's coverage for grounded readings
// that cite via cites[] rather than inline markers), grounds (cites resolved to
// span text), and registered absence. Mirrors audit.js's marker-neutralized
// split so the numbers line up with the turn's recorded truthfulness.
function eomriSentences(turn, hitsByIdx) {
  const final = turn.final || {};
  const T = String(final.text || '');
  if (!T.trim()) return [];
  const OPEN = '', CLOSE = '', markers = [];
  const neutral = T.replace(/\{\{(cite|infer|void|absent):([^}]*)\}\}/g, (m, kind, payload) => {
    const i = markers.length; markers.push({ kind: kind, payload: payload }); return ' ' + OPEN + i + CLOSE + ' ';
  });
  const hasMarkers = markers.some(k => k.kind === 'cite' || k.kind === 'infer');
  const grounded = !!(final.audit && final.audit.grounded);
  const cover = eomriFrac(final.audit && final.audit.covers);
  const unit = new RegExp(OPEN + '(\\d+)' + CLOSE, 'g');
  const groundOf = (k) => { const p = String(k.payload).split(':'); const idx = p[1], label = p[2] || '';
    return { id: (idx != null && idx !== '') ? ('s' + idx) : (label || 'span'), text: (idx != null && hitsByIdx[idx]) ? hitsByIdx[idx] : (label || '') }; };
  // Protect the periods that don't end a sentence — initials ("H. G. Wells"),
  // common abbreviations, lettered abbreviations ("e.g.") — behind a one-dot
  // leader so the split doesn't orphan a citation onto a fragment of its own.
  const DOT = '․';
  const protectedText = neutral
    .replace(/\b([A-Z])\.(?=[\s ])/g, '$1' + DOT)
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Rev|Gen|Sen|Rep|vs|etc|No|Inc|Ltd|Co|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\./g, '$1' + DOT)
    .replace(/\b([a-z])\.([a-z])\.(?=\s|$)/gi, '$1' + DOT + '$2' + DOT);
  const out = [];
  for (let frag of protectedText.split(/(?<=[.!?])\s+|\n+/)) {
    frag = frag.trim(); if (!frag) continue;
    const ids = []; let mm; unit.lastIndex = 0; while ((mm = unit.exec(frag))) ids.push(+mm[1]);
    const mks = ids.map(i => markers[i]).filter(Boolean);
    const cites = mks.filter(k => k.kind === 'cite' || k.kind === 'infer');
    const voids = mks.filter(k => k.kind === 'void' || k.kind === 'absent');
    const display = frag.replace(unit, (m, i) => { const k = markers[+i]; return (k && (k.kind === 'void' || k.kind === 'absent')) ? k.payload : ''; })
      .replace(/․/g, '.').replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    const content = (display.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || []).map(w => w.replace(/['’]s$/, '')).filter(w => w.length > 2 && !EOMRI_STOP.has(w));
    if (!content.length) {   // a marker-only fragment trails the previous sentence — attach backward
      if (out.length) { const pr = out[out.length - 1]; if (cites.length) { pr.bound = true; cites.forEach(c => pr.grounds.push(groundOf(c))); } pr.voidc += voids.length; }
      continue;
    }
    const boundInline = cites.length > 0;
    const absent = voids.some(k => k.kind === 'absent') && !boundInline;
    let bound = boundInline, witness;
    if (boundInline) { const denom = content.length + voids.length; witness = denom ? content.length / denom : 1; }
    else if (absent) { witness = 0.2; }
    else if (grounded) { bound = true; witness = cover != null ? cover : 0.8; }
    else { witness = 0.12; }
    const groundsResolved = cites.map(groundOf);
    // VERBATIM vs GROUNDED — two honest tiers, never "verified". Verbatim is the
    // page's OWN words: the claim lifts a contiguous run from its cited span. A
    // faithful reword that still binds is grounded. Both say "the page carries
    // this," neither says "this is true." Strict on purpose — a compression that
    // merely reuses the span's vocabulary is a reword, not a quote, so it reads
    // grounded; only a literal substring (either direction) reads verbatim.
    let verbatim = false;
    if (bound && groundsResolved.length) {
      const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/[^a-z0-9'’ ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const claimN = norm(display);
      if (claimN.length >= 8) verbatim = groundsResolved.some(g => { const sp = norm(g && g.text); return !!sp && (sp.includes(claimN) || claimN.includes(sp)); });
    }
    out.push({ text: display, witness: eomriClamp(witness), bound: bound, grounds: groundsResolved, voidc: voids.length, absent: absent, verbatim: verbatim });
  }
  // grounded mechanical readings cite via the cites[] array, not inline markers —
  // show what the last sentence stood on so the grounds panel isn't bare.
  if (grounded && !hasMarkers && Array.isArray(final.cites) && final.cites.length && out.length && !out.some(s => s.grounds.length)) {
    out[out.length - 1].grounds = final.cites.slice(0, 4).map(c => ({ id: 's' + c.idx, text: hitsByIdx[c.idx] || '' }));
    out[out.length - 1].bound = true;
  }
  return out.slice(0, 12);
}

// Normalize a claim sentence for cross-layer comparison — the relation gate's
// recorded claim text vs a rendered answer sentence: drop markers and [sN] tags,
// lowercase, strip punctuation, collapse whitespace.
function eomriNormClaim(x) {
  return String(x == null ? '' : x).replace(/\{\{[^}]*\}\}/g, ' ').replace(/\[s?\d+\]/gi, ' ')
    .toLowerCase().replace(/[^a-z0-9'’ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Why the gate held a claim, in the badge's voice.
function eomriGateReason(kind) {
  return kind === 'inverted' ? 'the page’s edge runs the other way'
    : kind === 'wrong-speaker' ? 'the page attributes the line to another voice'
    : kind === 'foreign-subject' ? 'the page’s edge names a different figure'
    : 'its subject–predicate–object does not match the page';
}

function eomriTraceFromTurn(turn) {
  if (!turn || !turn.final || !String(turn.final.text || '').trim()) return null;
  try {
    const final = turn.final, audit = final.audit || null, truth = final.truth || {}, steps = turn.steps || [];
    const engine = String(final.engine || ''), q = turn.input || '';
    const domain = eomriDomain(q);
    const hitsByIdx = eomriHitsIndex(turn);
    const sents = eomriSentences(turn, hitsByIdx);
    if (!sents.length) return null;

    // The relation gate's verdict, folded into the per-claim read. A claim it held
    // — inverted agency, the wrong speaker, a foreign subject — bound a span yet
    // did NOT survive the support check; it reads as a caught fabrication here, not
    // as grounded, so the ledger and badge inherit the gate's floor and a fabrication
    // that merely cleared overlap can never be counted "grounded." (steps carry the
    // recorded relation-gate mismatches; auditview reads the same s.mismatches field.)
    const rgStep = steps.find(s => s && s.t === 'relation-gate');
    const flagged = ((rgStep && rgStep.mismatches) || [])
      .map(m => ({ n: eomriNormClaim(m && m.claim), kind: (m && m.kind) || 'relation-mismatch' })).filter(f => f.n);
    if (flagged.length) sents.forEach(se => {
      if (!se.bound || se.absent) return;
      const sn = eomriNormClaim(se.text);
      const hit = sn && flagged.find(f => f.n === sn || sn.includes(f.n) || f.n.includes(sn));
      if (hit) { se.bound = false; se.verbatim = false; se.gateHeld = hit.kind; se.witness = Math.min(se.witness, 0.15); }
    });

    // The turn's shape, read off the recorded audit — never scripted. The engine
    // and reason fields are a controlled vocabulary, so matching them is safe;
    // the answer text is never pattern-matched.
    const reasonTxt = String(final.reason || '');
    const refused = !String(final.text || '').trim()
      || /refus|stuck|repair-stuck|stopped|^none$|compute-(none|error)/.test(engine)
      || /not-ready|unavailable|no-webgpu|needs|-error|error|failed|interrupt|no-article|no-scope/.test(reasonTxt);
    const unbound = (truth.unbound || 0) > 0 || !!(audit && audit.grounded === false && audit.covers != null);
    const absent = !refused && (!!(audit && audit.absent) || (!!audit && audit.grounded === true && eomriFrac(audit.covers) === 0) || (sents.length === 1 && sents[0].absent));
    const grounded = !refused && !!(audit && audit.grounded === true) && !unbound && !absent;
    const repaired = !!(final.form && final.form.revised) || steps.some(s => s.t === 'repair') || steps.some(s => s.t === 'converge')
      || steps.some(s => s.t === 'veto' && /reject|residual|restructure|retry/i.test((s.decision || '') + ' ' + (s.reason || '')));

    // If the turn is an absence, every uncited sentence is the honest "the page
    // does not establish X" move, not a bound figure.
    if (absent) sents.forEach(se => { if (!se.grounds.length) { se.absent = true; se.bound = false; se.witness = 0.2; } });

    const formDeg = (final.form && final.form.degree != null) ? eomriClamp(final.form.degree) : null;
    const hasMarkers = /\{\{(cite|infer):/.test(String(final.text || ''));
    const asymptote = eomriClamp(
      (truth.degree != null && hasMarkers) ? truth.degree
      : (eomriFrac(audit && audit.covers) != null ? eomriFrac(audit && audit.covers)
      : (truth.degree != null ? truth.degree : (grounded ? 0.8 : 0.12))));

    let label, tone, verdictWord, learnMode, learnName, learnTrig, verdictText, stampTail;
    if (refused) {
      label = 'honest refusal'; tone = '#ff3b52'; verdictWord = 'refused'; learnMode = 'blocked'; learnName = 'refusal';
      learnTrig = 'Nothing on the page would carry the answer, so the turn refuses rather than invent. Refusing is honest — there is nothing to learn from it.';
      verdictText = 'refused honestly · the page would not carry it'; stampTail = 'refused';
    } else if (absent) {
      label = 'cold miss → ingestion'; tone = '#ffb800'; verdictWord = 'held'; learnMode = 'fetch'; learnName = 'cold-repair';
      learnTrig = 'A cold miss: nothing in scope covers the subject. Nothing to learn yet — broaden ingestion and pull a source into scope.';
      verdictText = 'absence shown as a low-witness stamp, not asserted'; stampTail = 'cold miss';
    } else if (repaired && grounded) {
      label = 'repair pair'; tone = '#00ccdd'; verdictWord = 'repaired'; learnMode = 'lit'; learnName = 'repair-pair';
      learnTrig = 'Rejected then accepted is a direction. The sense drifts along that vector — away from the shape that failed, toward the one that held.';
      verdictText = 'repaired · revised draft accepted'; stampTail = 'bound after repair';
    } else if (grounded) {
      label = 'grounded turn'; tone = '#3ddc84'; verdictWord = 'grounded'; learnMode = 'lit'; learnName = 'grounded-accept';
      learnTrig = 'Accepted AND grounded. The witness is really there, so the sense drifts toward this answer — the only state the loop is allowed to learn from.';
      verdictText = 'grounded · spoken with confidence'; stampTail = 'bound';
    } else {
      // Not grounded, not an honest absence: an assertion (or plain chat) drafted
      // from the model's prior with no retrieved span — the state the instrument
      // exists to make visible.
      label = 'fluent on thin air'; tone = '#ff8a3d'; verdictWord = 'flagged'; learnMode = 'blocked'; learnName = 'witness-deficit';
      learnTrig = 'Fluent and well-formed on no retrieved span — drafted from the prior, not the page. Learning is REFUSED here, and the turn is routed to fetch instead.';
      verdictText = 'flag raised · fluent, well-formed, ungrounded'; stampTail = 'FLUENT ON THIN AIR';
    }

    const genre = ({ Existence: 'lookup', Structure: 'relation', Interpretation: 'synthesis' })[domain] || 'lookup';
    const decision = /^refused/.test(engine) ? 'refuse'
      : /compute/.test(engine) ? 'compute'
      : (engine === 'mechanical' || engine === 'verbatim') ? 'mechanical'
      : /repair/.test(engine) ? 'repair'
      : /reference/.test(engine) ? 'fetch'
      : engine === 'none' ? 'chat' : 'model';
    const route = steps.filter(s => s.t === 'route').slice(-1)[0];
    const reason = (route && route.reason) || (audit && audit.note ? eomriTrunc(audit.note, 60) : '') || (grounded ? 'grounded on the page' : 'no ground');
    const usedModel = /model|grounded|creative|compute|repair|verbatim/.test(engine) || steps.some(s => s.t === 'llm');

    const frames = [{ op: 'router' }, { op: 'log', kind: 'question', prov: 'reader', text: q || '…' }];
    eomriRetrievalFrames(turn).forEach(f => frames.push(f));
    if (usedModel) frames.push({ op: 'log', kind: 'draft', prov: 'talker', text: 'talker drafts over the retrieved spans' });
    sents.forEach(se => {
      const addr = eomriAddress(se, domain);
      frames.push({ op: 'sentence', text: se.text, witness: se.witness, form: formDeg, grounds: se.grounds,
        site: addr.site, object: se.absent ? 'Ground' : addr.object, notation: addr.notation, resolution: addr.resolution,
        alarm: !se.bound && !se.absent, absence: !!se.absent, verbatim: !se.absent && !!se.bound && !!se.verbatim,
        gateHeld: se.gateHeld || null,
        groundNote: se.gateHeld
          ? ('a span was cited, but the relation gate held it — ' + eomriGateReason(se.gateHeld))
          : se.absent
          ? ((audit && audit.note) ? eomriTrunc(audit.note, 120) : 'nothing in scope covers the subject — shown as absence, not asserted')
          : 'no retrieved span supports this — the talker drafted from its prior, not the page' });
    });
    const wpct = asymptote == null ? '—' : Math.round(asymptote * 100) + '%';
    frames.push({ op: 'log', kind: 'stamp', prov: 'monitor', text: 'witness ' + wpct + (formDeg != null ? ' · form ' + Math.round(formDeg * 100) + '%' : '') + ' · ' + stampTail });
    frames.push({ op: 'verdict', text: verdictText });
    frames.push({ op: 'log', kind: 'accept', prov: 'reader', text: 'turn closed · recorded to the audit log' });
    frames.push({ op: 'learn', mode: learnMode, name: learnName, trig: learnTrig });
    if (learnMode === 'fetch' || learnMode === 'blocked') frames.push({ op: 'log', kind: 'fetch', prov: 'system',
      text: learnMode === 'fetch' ? 'cold miss → fetch a source · fold into the Given-Log' : 'witness-deficit → fetch a source on the subject' });
    frames.push({ op: 'asymptote', value: asymptote == null ? 0 : asymptote });

    // Per-claim ledger — the honest tally the badge reads: verbatim (the page's
    // own words), grounded (a faithful cited reword), absence (a held ⊥), and
    // confabulation (unbound, fluent on no span). A count of CLAIMS, not query
    // tokens, so a thin answer can no longer hide behind a green passage fraction.
    const ledger = sents.reduce((a, se) => {
      a.claims++;
      if (se.gateHeld) a.flagged++;
      else if (se.absent) a.absence++;
      else if (!se.bound) a.confabulation++;
      else if (se.verbatim) a.verbatim++;
      else a.grounded++;
      return a;
    }, { claims: 0, verbatim: 0, grounded: 0, absence: 0, confabulation: 0, flagged: 0 });

    return { label: label, genre: genre, decision: decision, reason: reason, tone: tone, verdictWord: verdictWord, targetSite: eomriTargetSite(domain), ledger: ledger, frames: frames };
  } catch (e) { return null; }
}

/* window.EOMRI — the three face vocabularies (kept name-aligned with the engine's
   encoder and the conformance scorer) plus the real-data seam, now live. */
window.EOMRI = Object.assign(window.EOMRI || {}, {
  // ACT face — the operator algebra, in dependency (climb) order.
  OPERATORS: ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'],
  // SITE face (Space ⤫ Time) — where a mark lands.
  SITES: [['Void', 'Thing', 'Kind'], ['Field', 'Link', 'Network'], ['Atmosphere', 'Lens', 'Paradigm']],
  // RESOLUTION / Stance face (Identity ⤫ Time) — how the target is held.
  RESOLUTIONS: [['Clearing', 'Dissecting', 'Unraveling'], ['Tending', 'Binding', 'Tracing'], ['Cultivating', 'Making', 'Composing']],
  /* Turn a real window.EOAudit turn into an instrument trace ({ label, genre,
     decision, reason, tone, verdictWord, targetSite, frames:[…] } — the shape
     buildTraces() emits). The instrument calls this for every settled turn and
     renders the result; it falls back to the illustrative scenarios only when
     nothing is recorded. Returns null for a turn it can't read. */
  traceFromTurn: eomriTraceFromTurn,
});

Object.assign(window, { EOMRIDrawer, EOMRIInstrument });
