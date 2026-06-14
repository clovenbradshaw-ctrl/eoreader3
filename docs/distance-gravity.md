# Distance-based gravity — retiring the geometric clock

*Design note / work-item spec.*

**Status (built, behind a rule).** WI-0…WI-3 are built: the kernel ships as
`EOEngine.gravityPull`, token offsets are carried at parse, and the binder
consumes the law when the **`distance_gravity`** rule is on (OFF by default —
the parity floor, byte-identical, 202/202 golden snapshots unchanged). WI-3, the
A/B harness, is `evo/experiments/distance-gravity-ab.js` (`npm run evo:distance`).
WI-4 (the default-flip + golden recapture) is **gated and NOT taken**: the read
returned **HOLD** — see *Measured*, below. So this is no longer parity-breaking;
it is an available, switchable law plus the instrument that judges it.

---

## The claim

Replace exponential momentum decay (`momentum = momentum·γ + w` per sentence,
`γ ≈ 0.7`) with a **distance law** over mention positions:

```
pull(site, cursor) = Σ_mentions   mass_per_mention / (d + k)^α
                     where d = cursor − mention_position, in TOKENS
```

This is the ACT-R activation equation (Anderson & Schooler, 1991): human
retrieval follows a **power law of recency**, not exponential decay. Each past
mention contributes activation ∝ t^−d with d ≈ 0.5; summed over mentions you get
the formula above. They fitted it to the statistics of how often referents recur
in real environments — newspaper text included. The environment is power-law, so
the memory that reads it evolved to match. Exponential decay dies too fast in the
tail.

The collision law does **not** change. `δ = 2.0` dominance, stall + NUL
otherwise, honest abstention. This proposal replaces *how pull is computed*, not
*how collisions resolve*.

---

## Why this is the stronger formulation (grounded in the current code)

### 1. It dissolves the `mass_weight` hack at its source

The pronoun-resolution score in `engine.js` is, today, literally:

```
score = surface_mass × pronoun_surface_mass_weight  +  momentum
```

(`READING_RULES.pronoun_surface_mass_weight`, the rule whose own description says
its job is to keep "heavy characters sticky against fresh-but-light competitors
without letting them become black holes.") That is the *heavy-and-far vs
light-and-near* tradeoff being propped up by a hand-tuned constant, because
exponential decay makes a protagonist absent for three pages exactly as cold as a
walk-on absent for three pages.

`Σ mass / (d + k)^α` gives the tradeoff natively. A mass-40 protagonist at 800
tokens can still outpull a mass-2 walk-on at 50 tokens, and *whether it does*
falls out of the law rather than out of `mass_weight = 0.1`. Heavy-and-far vs
light-and-near becomes one computation.

### 2. The frame doctrine is already written for it

`projectGraph`'s frame note says, verbatim:

> *Mass, momentum, force, and overlap are measurements relative to this frame
> (cursor position + current rules + current couplings), not properties of
> events. Move the cursor or change a rule and the same log measures
> differently.*

Today that is aspirational for momentum: momentum is a **stateful sequential
accumulator** (pass 2.5 replays event-by-event, `s.momentum = s.momentum·γ + w`,
`decayTo` on sentence gaps). You can only know it by replaying in order.

Distance is **stateless**: at any cursor, pull is a pure function of the mention
positions in the log. Mass, mention positions, cursor — that's it. Move the
cursor, the same log measures differently, *and now that is literally true* with
no accumulator at all. This relocates the recency law from the significance layer
(the reader's internal time) to the structure layer (the medium's geometry) — the
same retagging the Cleo spec did for `δ`.

### 3. Tokens are the honest distance metric

The current clock is per-sentence (`decayTo` decays by `sent − lastSentence`). A
60-word sentence ages the field exactly as much as a 5-word one, so
dialogue-heavy passages decay slower per unit of actual text than dense
narration. Token distance is the text's own geometry, not an artifact of where
the segmenter put periods.

---

## Three corrections to the naive Newtonian form

1. **The exponent is not 2.** Inverse-square is flux through a sphere in three
   dimensions. Text is one-dimensional. The empirically fitted human value is
   ≈ 0.5; anything in `[0.5, 1]` is defensible. Make it a **ledger rule**
   (finite, tunable) and let the fixtures decide.

2. **Soften the denominator.** Raw `1/d` explodes as `d → 0`: an intra-sentence
   mention gets near-infinite pull. Use `1 / (d + k)^α` with `k` ≈ a typical
   sentence length in tokens. Both `k` and `α` live on the ledger.

3. **The collision law stays.** `δ = 2.0` dominance, stall/NUL otherwise. The
   honest stall survives intact. This is a pull-computation swap, nothing more.

---

## The surface/inferred split must survive the rewrite

The reason `mass_weight` reads **surface mass** (name-earned) and excludes
pronoun-bound mass is to stop the binder treating its own guesses as evidence for
its next guess — the rich-get-richer loop where inferred mass compounds into a
runaway cluster.

`Σ mass_per_mention / (d + k)^α` needs the same discipline: sum over **name**
mention positions, with inferred (pronoun-bound) mentions weighted down or out —
otherwise the loop returns in geometric clothing. The `surfaceMass` accumulator
added in the portrait expansion (WI-1) is exactly the quantity this split needs:
the per-site weight earned from the name actually appearing on the page.

So `mass_per_mention` is the **surface** deposit at each name position; inferred
mentions either contribute at the anaphora coupling or not at all (a ledger
choice).

---

## Work items

### WI-0 — Per-mention token offsets (prerequisite)

The law wants `d` in **tokens**, but the event log carries `sentence_idx`, not
token positions. Without this step "distance" silently degrades to a sentence
clock and you've changed the exponent without changing the geometry.

- Emit a `token_offset` (cumulative token index from document start) on every
  mention-bearing event (`INS`, name-surface `SYN`, `SIG`, `DEF`), or derive it
  from `sentence_idx` + a per-sentence token-length prefix sum built once at
  parse time.
- Carry a `cursor_tokens` alongside the existing sentence cursor in the frame.
- **Acceptance:** every mention resolves to a token offset; offsets are
  monotonic in seq; a prefix-sum derivation matches a direct count on Voss.

### WI-1 — The distance kernel

- Add ledger rules: `gravity_alpha` (α, default 0.5), `gravity_offset` (k,
  default ≈ mean sentence length in tokens), both finite and tunable.
- Implement `pull(siteRoot, cursorTokens) = Σ_namepos mass_per_mention /
  (cursorTokens − pos + k)^α` over the site's surface mention positions.
- Inferred mentions contribute at the anaphora coupling (a ledger weight),
  parallel to today's `ANAPHORA_W`.
- **Acceptance:** `pull` is a pure function of `(positions, cursor, rules)` —
  no sequential state; two calls at the same cursor are identical.

### WI-2 — Swap the pull source in resolution

- Replace `surface_mass × mass_weight + momentum` in the pronoun binder with
  `pull(candidate, cursor_tokens)`.
- Replace the gravity term in site-SYN contact measurement likewise.
- Leave the collision resolution (`δ` dominance, stall, NUL emission) byte-for-
  byte unchanged.
- Retire `decay_gamma` from the resolution path; retire
  `pronoun_surface_mass_weight`. Keep them on the ledger one release as
  no-ops with a deprecation note, or delete — fixtures decide.
- **Acceptance:** the binder consumes `pull`; no momentum accumulator is read
  during resolution.

### WI-3 — A/B harness on War and Peace

The clean test, per the proposal: run **both laws** over the War-and-Peace
fixtures and compare.

- Metrics: pronoun-binding accuracy against the annotated gold bindings, and
  **where the stalls land** (a stall in an honestly-ambiguous spot is a win; a
  stall in an unambiguous spot is a regression).
- Emit a side-by-side report: per-pronoun bound referent under each law, plus a
  stall-placement diff.
- **Acceptance:** the harness runs both laws from one fixture set and prints the
  accuracy + stall-placement comparison deterministically.

### WI-4 — Golden recapture (gated)

- **Gate:** proceed only if the distance law binds at least as accurately *and*
  stalls in more honest places than the geometric clock. If it does not, the
  geometric clock stays and this note is the record of why.
- If it wins: recapture `tests/golden.json` deliberately, hand-diff the changed
  answers, and land it as its own reviewed PR. The geometric clock retires.

---

## Out of scope

- The collision law (`δ`, stall, NUL). Untouched.
- The portrait / talker pipeline. Orthogonal.
- Schema-version bump beyond what WI-0's `token_offset` field requires.

## Build discipline

- WI-0 is additive and **parity-safe** (a new event field + frame value); it
  ships first, on its own, green against the current golden.
- WI-1..WI-2 change measured values and therefore **break parity by design** —
  they do not merge until WI-3 shows the win and WI-4 recaptures the golden.
- Run `npm test` and `node tests/parity.js` before every push. WI-0: both clean.
  WI-1..2: parity is *expected* to differ and is recaptured under WI-4, never
  silently.

  How it actually landed: WI-1..2 are gated behind the `distance_gravity` rule
  (OFF by default), so they did **not** break parity — `npm test` and
  `node tests/parity.js` are both clean (202/202). The rule, not a golden
  recapture, is what keeps the floor; WI-4 would flip the default only on a win.

---

## Measured — the read, and what it found (WI-3)

`npm run evo:distance` runs both laws over the annotated fixtures
(`evo/fixtures/binding`, `evo/fixtures/stalls`) and sweeps α ∈ {0.5, 0.7, 1, 1.5}
× k ∈ {5, 10, 20, 50}. The collision law (δ, floor, NUL) is identical under both;
only the pull magnitude differs.

```
baseline (geometric):       binding 69% (11/16)   stall 67% (4/6)   total 15/22
distance law (best, α=.5,k=5): binding 56% ( 9/16)   stall 100% (6/6)  total 15/22
```

**Total correctness is conserved at 15/22 across the entire (α,k) grid.** The
distance law is *not* inert — it repairs exactly the honest stalls the geometric
clock mishandles, including the steward over-stall this note never anticipated:
"she" before *"Then tell them the grain is theirs"* flips from a δ-gate stall to a
bind on Princess Mary. But every stall it wins, it pays for with a binding it
loses (e.g. the same scene's *"Then we shall have to find another way"* slips off
Calloway). The recency law **slides errors along a tradeoff curve; it does not
reduce them.**

So WI-4's gate ("binds at least as accurately *and* stalls in more honest places")
is **not met** — the geometric clock stays the default. This is the record of why,
exactly as WI-4 asks.

### Why — and where the real lever is

The residual errors are not recency errors, which is why no pull law moves them.
Trace the steward misses and they are **sign (gender) errors**: "Dron" is a
gender-ambiguous name, so the first momentum-dominant `"she"` bind captures it and
then *records the wrong gender* (`Dron → f`, basis "pronoun binding is gender
evidence"). That bootstrap leaves the sign exclusion inert for every later `"she"`,
and mass/recency — under either law — then decides what gender should have. The
text's own cure sits unread one sentence in: *"the old steward stood with **his**
cap in **his** hands"* is observed evidence that the steward is a he.

Reading that possessive determiner as gender evidence was prototyped and
**deliberately not shipped here**: in the greedy single-pass reader the possessor
is unreachable at that point — "Dron" is still typed a `thing` (it only earns
person-type later, by speaking), and the document title competes as a capitalized
candidate, so an honest reader *stalls*. The repair needs the whole-field view —
which entities turned out to be persons, which were headings — that the
**deep-read enrichment pass** (`enrich.js`, `docs/deep-read-enrichment.md`)
already has by construction. That is the next read-gated build:

> **Possessive-gender repair (enrichment).** In the second, whole-graph pass,
> read narration possessives (`his/her` + non-kin noun) as observed gender for
> their possessor, resolved against the *settled* person inventory, observed
> evidence outranking a prior pronoun-bind guess (the surface/inferred split the
> binder already keeps for mass). Gate it on this same battery: it must raise
> *total* correctness, not trade one error for another.
