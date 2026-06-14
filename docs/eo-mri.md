# EO-MRI — the cognition instrument

EO-MRI sits beside the **Glass box** in the top bar. Where the Glass box
(`auditview.jsx`) is the audit **log** — the steps a turn took, after the fact —
EO-MRI (`eomri.jsx`) is the **scan**: a live cross-section of a turn *as it
runs*, drawn as the three faces of the **EO cube**.

It opens on demand (the `EO-MRI` pill → `window.EOMRIDrawer`), plays a turn
frame by frame, and lets you step, scrub, replay past turns from the rail, or
inject one of four illustrative scenarios. Nothing in it is scripted
frame-to-frame: the operators light because events with their signatures occur,
and the order-check reads the firings.

By default the rail is **real**: it is a fold over `window.EOAudit`, so every
settled chat turn shows up as a card, the most recent one auto-plays, and the
rail refreshes live as new turns settle. The four scenarios are the demo /
fallback — shown only when nothing has been recorded yet, or reached via the
`● live ⇄ illustrative` toggle in the controls.

## The three faces (Internals column)

The whole point of the instrument is the **3-fold address** every answer
sentence carries — `operator(Site, Resolution)` — read across the three faces of
the cube (see `docs/reading-conformance.md` → "The cube behind the log").

- **ACT face — operators + order-check.** The helix
  `NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC`, each lit only when an
  event with its signature actually fired, badged with its firing step. The
  **order check** below it is **EO reader compliance** made visible: it flags any
  operator that ran *before* a prerequisite (`late`, ↑) or with one *missing*
  (`skipped`, !) — the Act-face laws of the conformance spec, run live on the
  trace.
- **SITE face — where the mark landed.** The Space ⤫ Time grid
  `Void / Thing / Kind · Field / Link / Network · Atmosphere / Lens / Paradigm`.
  The router's **target** site is dashed; the **produced** site is solid, and
  green/red by honesty. A target ≠ produced mismatch is called out.
- **RESOLUTION face — how the target is held.** The Identity ⤫ Time grid
  `Clearing / Dissecting / Unraveling · Tending / Binding / Tracing ·
  Cultivating / Making / Composing`.

The **address** line under the faces reads `operator(Site, Resolution)` for the
current sentence — the 3-fold encoding, assembled from the three faces.

## The spine and the rails

- **The turn** (center) — the incoming ask, the router's read, then each answer
  sentence as a card: the spoken text (typed out live), its honesty tag
  (`GROUNDED` / `HONEST ABSENCE` / `CONFABULATION` / `REJECTED`), what it is
  grounded in, and the **witness** and **form** gauges. Below: the verdict and
  the **self-learning** trigger — the asymmetry that a grounded-and-accepted turn
  drifts the sense, while a fluent-but-thin one is *blocked* and routed to fetch.
- **Turns rail** (left) — every turn as a card (click to replay), and a
  **calibration** sparkline: confidence approaching 1.0, never reaching it.
- **Given-Log** (lower right) — the Site state as a fold over the event stream.

## How it is wired

`eomri.jsx` is a native React drawer, loaded like every other mode (a
`text/babel` script in `index.html`, bundled via `build/entry.js`, exposed as
`window.EOMRIDrawer`). It was ported from a standalone `dc-runtime` instrument;
the dc-runtime renders through `window.React`, and its `DCLogic` base maps 1:1
onto `React.Component`, so the state machine (`buildTraces` / `deriveOps` /
`applyTo` / `play` / `renderVals` …) is carried over unchanged. Only the
declarative template became JSX, with a small `eomriCss()` helper turning the
ported CSS **strings** into React style **objects**.

## How real turns are wired

`window.EOMRI.traceFromTurn(turn)` converts one recorded `window.EOAudit` turn
(the chat pipeline: route → ground → retrieve → phrase → veto → cite) into the
`{ label, genre, decision, reason, tone, verdictWord, targetSite, frames:[…] }`
trace the instrument renders. The instrument builds its rail by folding the last
few settled turns through it, subscribes to the recorder so the rail stays live,
and falls back to the illustrative scenarios only when `traceFromTurn` finds
nothing usable. (`tests/eomri.test.js` pins the conversion.)

Nothing in the trace is invented where the system already measures it:

- **the 3-fold address** per sentence is the engine's own encoder —
  `window.EOEngine.eoAddressOfEvent` / `eoNotation`, the `operator(Site,
  Resolution)` of `docs/reading-conformance.md` ("When logs carry site and
  stance addresses, the instrument gains those columns"). The operator is the
  Generate op of the question's Domain (INS · SYN · REC), or NUL for a
  registered absence; the Site, Object and Resolution come straight from the
  encoder.
- **witness** is the audit's WI-7 degree (the per-sentence marker degree,
  falling back to the turn's coverage for grounded mechanical readings) — the
  same number the calibration sparkline tracks toward the asymptote.
- **grounds** are the turn's own `{{cite}}`s, resolved to the retrieved span
  text the retriever actually returned.
- **the verdict / learn asymmetry** (grounded · repaired · fluent-on-thin-air ·
  absent · refused) is read off `final.audit` / `final.truth`, never scripted.

`window.EOMRI` also exposes the three face vocabularies (`OPERATORS`, `SITES`,
`RESOLUTIONS`) so the engine-side encoder and the instrument stay name-aligned.

Still forthcoming: **per-turn conformance scoring** (the seven Act-face
invariants `tools/conformance.js` already scores for ingestion *dumps*). Today
the order-check is derived live from the trace's own event firings; when a turn
carries its own compliance verdict, the check can render that instead.
