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
   drawer so it lives in the app like every other mode and can read the
   app's own data. The four scenario traces (grounded / fluent·thin /
   repair / cold-miss→fetch) are illustrative.

   FORTHCOMING — when the engine emits per-event operator(Site, Resolution)
   addresses and per-turn conformance bits onto the audit log
   (docs/reading-conformance.md: "When logs carry site and stance
   addresses, the instrument gains those columns"), real turns from
   window.EOAudit replace the canned traces. The seam is
   window.EOMRI.traceFromTurn(turn) (a documented stub today) plus the
   `traces` prop on EOMRIInstrument. Nothing here hardcodes the canned
   data in a way that blocks that: the component renders whatever trace
   map it is handed.
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
    // The trace map is injected (forthcoming: real turns) or built from the
    // illustrative scenarios.
    this.TRACES = (props && props.traces) || this.buildTraces();
    this.typed = Infinity; this.typingKey = -1; this.replaying = false;
    this.timer = null; this.typeTimer = null;
    this.state = {
      current: 'clean', frameIdx: 0, playing: false, turnNo: 3,
      history: [
        { n: 1, scenario: 'clean', label: 'grounded turn', question: 'when was it published, and by whom?', witness: 0.92, form: 0.84, tone: '#3ddc84', asy: 0.66, verdict: 'grounded' },
        { n: 2, scenario: 'repair', label: 'repair pair', question: 'what is it really about, underneath the plot?', witness: 0.70, form: 0.88, tone: '#00ccdd', asy: 0.71, verdict: 'repaired' }
      ],
      asympPoints: [0.66, 0.71]
    };
  }

  componentDidMount() { this.play(); }
  componentWillUnmount() { clearTimeout(this.timer); clearInterval(this.typeTimer); }
  componentDidUpdate() { ['cleo-answer', 'cleo-log'].forEach(id => { const e = document.getElementById(id); if (e) e.scrollTop = e.scrollHeight; }); }

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
    if (this.replaying) { this.setState({ playing: false }); return; }
    const tr = this.TRACES[this.state.current], s = this.applyTo(tr.frames.length - 1);
    const af = tr.frames.find(f => f.op === 'asymptote');
    const q = (tr.frames.find(f => f.op === 'log' && f.kind === 'question') || {}).text || '';
    const entry = { n: this.state.turnNo, scenario: this.state.current, label: tr.label, question: q, witness: s.witness, form: s.form, tone: tr.tone, asy: af ? af.value : null, verdict: tr.verdictWord };
    this.setState(st => ({ playing: false, history: [...st.history, entry].slice(-7),
      asympPoints: (af ? [...st.asympPoints, af.value] : st.asympPoints).slice(-7), turnNo: st.turnNo + 1 }));
  }

  inject(name) { if (!this.TRACES[name]) return; this.replaying = false; this.typed = Infinity; clearTimeout(this.timer); clearInterval(this.typeTimer); this.setState({ current: name, frameIdx: 0 }, () => this.play()); }
  replayPast(t) { if (!t || !this.TRACES[t.scenario]) return; this.replaying = true; this.typed = Infinity; clearTimeout(this.timer); clearInterval(this.typeTimer); this.setState({ current: t.scenario, frameIdx: 0 }, () => this.play()); }
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
      const wc = this.gaugeColor(se.witness);
      let textColor = '#e8f4f1', deco = '';
      if (se.rejected) { textColor = '#9fb4b0'; deco = 'text-decoration:line-through;'; }
      else if (se.alarm) { textColor = '#ffd9a0'; }
      else if (se.absence) { textColor = '#a9bdb9'; }
      const grounds = (se.grounds || []).map(g => ({ id: g.id, text: g.text }));
      const grade = se.object || 'Figure';
      const groundedG = grade === 'Ground' || grounds.length > 0;
      let honTag, honCol;
      if (se.rejected) { honTag = 'REJECTED · FORM LOW'; honCol = '#ff3b52'; }
      else if (!groundedG && grade === 'Figure') { honTag = 'CONFABULATION'; honCol = '#ff3b52'; }
      else if (grade === 'Ground') { honTag = 'HONEST ABSENCE'; honCol = '#3ddc84'; }
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
        wbar: `height:100%;width:${Math.round(se.witness * 100)}%;background:${wc};transition:width .5s ease;`,
        fbar: `height:100%;width:${Math.round(se.form * 100)}%;background:#00ccdd;transition:width .5s ease;`,
        wnum: se.witness.toFixed(2), fnum: se.form.toFixed(2),
        wnumStyle: `font-size:16px;font-weight:700;color:${wc};min-width:34px;`
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

    // turns rail
    const curQ = (tr.frames.find(f => f.op === 'log' && f.kind === 'question') || {}).text || '…';
    const current = { n: st.turnNo, question: curQ, witness: s.witness, form: s.form, tone: tr.tone, verdict: s.verdict === 'verdict pending' ? 'live' : tr.verdictWord, current: true, scenario: st.current };
    const turns = [current, ...st.history.slice().reverse()].map(t => {
      const w = t.witness == null ? 0 : t.witness, fo = t.form == null ? 0 : t.form, isCur = !!t.current;
      return {
        n: t.n, question: t.question || '…', verdict: t.verdict || '…',
        cardStyle: `cursor:pointer;border:1px solid ${isCur ? t.tone : '#15211f'};background:${isCur ? 'rgba(0,204,221,0.035)' : '#070d0e'};border-radius:6px;padding:9px 11px;transition:all .2s;${isCur ? 'box-shadow:0 0 0 1px ' + t.tone + ' inset;' : ''}`,
        tagStyle: `font-size:8px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${t.tone};`,
        wbar: `height:100%;width:${Math.round(w * 100)}%;background:${this.gaugeColor(w)};`,
        fbar: `height:100%;width:${Math.round(fo * 100)}%;background:#00ccdd;`,
        onClick: isCur ? (() => this.inject(t.scenario)) : (() => this.replayPast(t))
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

    return {
      turnNo: st.turnNo, wmu, wmuStyle, asyStat,
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
          <div style={S("font-size:9px;color:#48605c;letter-spacing:.05em;")}>eoreader3 · the EO cube, scanned live · state is a fold over the turn log</div>
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
          <span style={S("font-size:8px;color:#48605c;letter-spacing:.1em;text-transform:uppercase;")}>inject turn</span>
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

/* The seam for the forthcoming real-data wiring. The vocabularies are the EO
   cube's three faces, exposed so the engine's coming 3-fold address encoder and
   conformance scorer can align names with what the instrument draws. */
window.EOMRI = Object.assign(window.EOMRI || {}, {
  // ACT face — the operator algebra, in dependency (climb) order.
  OPERATORS: ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'],
  // SITE face (Space ⤫ Time) — where a mark lands.
  SITES: [['Void', 'Thing', 'Kind'], ['Field', 'Link', 'Network'], ['Atmosphere', 'Lens', 'Paradigm']],
  // RESOLUTION / Stance face (Identity ⤫ Time) — how the target is held.
  RESOLUTIONS: [['Clearing', 'Dissecting', 'Unraveling'], ['Tending', 'Binding', 'Tracing'], ['Cultivating', 'Making', 'Composing']],
  /* FORTHCOMING (/EO reader compliance + 3-fold address encoding): turn a real
     window.EOAudit turn into an instrument trace (a { label, genre, decision,
     reason, tone, verdictWord, targetSite, frames:[…] } object, the same shape
     buildTraces() emits). Today audit turns do not yet carry per-event
     operator(Site, Resolution) addresses or per-turn conformance bits, so this
     returns null and the instrument runs its illustrative scenarios. When the
     engine emits them (docs/reading-conformance.md), fill this in and pass the
     result through the `traces` prop. */
  traceFromTurn(turn) { return null; },
});

Object.assign(window, { EOMRIDrawer, EOMRIInstrument });
