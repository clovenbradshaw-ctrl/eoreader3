# Prompt-flow dashboard

A glass box over the **talker**: how a user turn becomes (or doesn't become) a
model call, and what prompt the model sees when it does. Open it from the
**Prompt flow** pill in the workspace toolbar.

Where `docs/prompt-flows.md` is a prose map maintained by hand, this dashboard
is **derived from the code**. Every prompt string it shows is read *live* from
`llm.js` at the moment you open it — so when a prompt is edited there, the
visualization changes with no edit anywhere else. That is the whole point: the
picture can't quietly drift from what the model actually receives.

## What's live vs. declared

| Part | Source | Live? |
|------|--------|-------|
| System prompts (grounded, plain, creative) | `EOLLM.systemFor(...)` | **live** — exact bytes the model gets |
| Conditional variants (summary line, relation-gate tagging) | `EOLLM.systemFor(..., opts)`, diffed | **live** |
| Shape/editor prompt | `EOLLM.SHAPE_SYSTEM` | **live** |
| Where the editor's note lands | `EOLLM.buildUserContent(...)` sample | **live** |
| Assembly parameters (`DEFAULT_BUDGET`, `RECENT_TURNS`) | `EOLLM.*` | **live** |
| Shape-pass verdict for the current model | `EOLLM.modelTier(mlcKey)` | **live** |
| Dispatcher cascade, routing reasons, veto lanes | declared (mirrors `prompt-flows.md`) | declared, test-pinned |
| Repair / degeneracy addenda | inline literals in `app.jsx` | declared, test-pinned |

Each prompt carries a **live** / **declared** badge so the distinction is never
hidden. The two addenda live as string literals inside `app.jsx` (not `llm.js`
exports), so they're declared here and pinned by the test rather than read live.

The data layer is `window.EOPromptFlow` (`promptflow.js`); the view is
`PromptFlowDrawer` (`promptflow.jsx`). `EOPromptFlow.snapshot({ mlcKey })`
returns one resolved tree the drawer renders.

## The four tabs

- **Flow** — the dispatcher cascade (first match wins) as a clickable ladder →
  the chosen flow → its **model-call pipeline** (the "how prompts are triggered"
  spine) → the veto/salvage lanes that can redirect it. Click any call to read
  its live prompt inline. The `routeTurn` verdict table (branch #6) is one
  disclosure down.
- **Prompts** — the full live system-prompt inventory, each with its conditional
  variants shown as the lines they *add*, plus the live assembly parameters.
- **Shape pass** — see below.
- **Activity** — what actually fired, read read-only from the glass box
  (`EOAudit`): the real path/reason and model calls of recent turns.

## The shape pass: is the editor's prompt fed to the model?

Before Cleo answers a grounded turn, an **editor** hands it a one-breath
director's note — what the user is after, what register fits, what a bad answer
looks like. The Shape-pass tab answers the question that matters: *for the model
selected right now, is that note actually fed to the model, or skipped?*

It is a **two-call** shape:

1. **Shape pass** — `system = SHAPE_SYSTEM`. Sees the question, recent turns, the
   doc title — never the spans or notes. Produces the note.
2. **Answer pass** — `system = grounded`. The note is injected into the **user
   message**, last, just before "Answer the user's question". The tab renders a
   live `buildUserContent` sample with that block highlighted — the proof it's
   fed in.

The verdict is read live from `EOLLM.modelTier(mlcKey)`:

- **`api` / `capable` tier → fed in.** The shape pass runs as a first call and
  its note rides into the answer pass.
- **`small` tier (sub-2B local) → NOT fed.** The shape pass is skipped entirely
  (`app.jsx`, the audit records `shape · skipped`). The small tier never
  free-composes; it runs `runGroundedSmall` — join-and-rephrase the
  already-bound mechanical reading over a cite set fixed before it speaks. A
  director's note is net-negative on a 0.5B and would cost a second serial call.

**What it means when the note is empty** (small tier, or the shape pass failed,
or no model is loaded): the grounded answer pass still runs — `buildUserContent`
simply omits the editor's-note block — so the model composes the answer directly
from the spans and notes, with no guidance about register or move. Nothing about
grounding or citation binding changes; only the director's note is absent.

## Staying honest

Two guards keep "tied to the actual structure" true rather than aspirational:

- **`drift()`** runs at render time and shows a banner if any live prompt fails
  to resolve, a conditional variant stops adding its line, or `modelTier` stops
  classifying the canonical keys the way the shape-pass verdict assumes.
- **`tests/promptflow.test.js`** loads the *real* `llm.js` and asserts the
  registry resolves the live prompts, the tier→verdict mapping holds, and the
  editor's note lands in the next prompt. If a prompt is renamed or a tier
  boundary moves, the test fails — the signal to update the dashboard instead of
  letting it go stale.
