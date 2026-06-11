# Reading Conformance Spec

**Scope.** A reader that ingests text into an append-only log and answers
questions by walking the projected graph. This spec defines seven invariants.
Each invariant states the law in one sentence, the signature of a log that
follows it, the signature of a log that violates it, a mechanical check, and a
witness. Witnesses cite the Toronto Life ingestion of 2026-06-11
(`cleon-ingestion/1`, doc-2), which violates six of seven and serves as the
permanent failing corpus.

**The whole spec in one sentence.** The machine follows when every answer is a
walk over marks that were written, and it fails whenever an answer requires a
mark that was never written or a weight that was never earned.

## 1. ADMISSION

**Law.** Only what returns is given a name. The gate is two sightings.

**Followed.** Every entity in the graph projection recurs: sighted in at least
two distinct non-chrome sentences before an anchor is minted. First sightings
are ephemeral SIG, not permanent INS. The entity list is short and every name
on it would be recognized by a human reader as a thing the document is about.

**Violated.** Entities with one mention. Entities whose only sentence is page
furniture. INS events with `src: first-sighting` that never receive a
confirming sighting and are never retired.

**Check.**

```
∀ e ∈ entities: |distinct(e.sents) ∩ prose_sentences| ≥ 2
single_sighting_count == 0
```

**Witness.** `Contact`, `Submit`, `Advertise`, `Renew`, `Manage`, `Terms`,
`Advertisement This`, `Latest Issue`: one mention each, all from footer chrome,
all minted as permanent referents (ev-3 through ev-8, ev-15, ev-490).

## 2. BINDING

**Law.** Two names joined by a deed is a bond. Write the bond between the
names, not near them.

**Followed.** When subject and object both resolve to distinct anchored
referents, the event is CON: two referent ids and a normalized relation. CON
count is the same order as resolved-SVO count. The edge list is the projection
of CON and a question of the form "who did X to Y" is answered by edge lookup,
never by sentence retrieval.

**Violated.** CON is zero while SVO events number in the hundreds. Relations
stored as floating surface strings with null hints, attached to no referent.
Both-endpoints-resolved SVO filed under SYN. The graph holds bodies and mergers
but no bonds.

**Check.**

```
CON_count / |SVO where sRef ≠ null ∧ oRef ≠ null ∧ sRef ≠ oRef| ≈ 1
no SVO with both endpoints resolved carries op == SYN
```

**Witness.** 220 SYN, 0 CON. ev-25 joins Tse and Sam Gor through "syndicate
known" and is filed as SYN. Turn 7 of the session audit then answers "who is
the leader" with El Chapo because no edge exists to consult.

## 3. SPEECH

**Law.** Speech belongs only to one who has acted. Do not hand words to a
metaphor.

**Followed.** Every SIG speaker has agency evidence: subject of a deed, target
of a prior pronoun binding, or a prior named attribution. A referent sighted
only inside a figure of speech is marked metaphor-only and is never an eligible
speaker. A quote with no eligible speaker is written
`attributed: unattributed`, which is an honest mark, not a failure.

**Violated.** Fallback attribution to the nearest capitalized name. A metaphor
speaking. A place or an organization speaking dialogue without a transmuting
DEF first changing its type.

**Check.**

```
∀ sig ∈ SIG: sig.speaker == null ∨ agency(sig.speaker) == true
∀ sig ∈ SIG: metaphorOnly(sig.speaker) == false
```

**Witness.** ev-76 attributes "Terror in the Streets" to Jeff Bezos,
`attributed: fallback`. Bezos exists in the document only as a metaphor in the
title. ev-452 and ev-465 attribute Tse's own words to Sam Gor, a syndicate
mistyped as a person, which is invariant 3 failing on top of invariant 7.

## 4. COMPANY

**Law.** The answer to "what is this thing" is the company it keeps. The
neighbors are the definition. What cannot be tested cannot be known.

**Followed.** Every admitted entity carries a frame: the hash of its CON
neighborhood, stored as its DEF. The frame is a proposition. A second document
produces a second frame, and EVA compares them: satisfies, extends, contracts,
conflicts. EVA fires whenever frames meet. REC fires only when a hub frame
conflicts beyond repair.

**Violated.** DEF as copied clause fragments. DEF targets that are not
referents. EVA at zero across a session because there are no frames to test.
REC reduced to a single rule-token induction because frame failure can never be
detected.

**Check.**

```
∀ def ∈ DEF(class): def.target ∈ admitted_referents ∧ def.value is frame_ref
documents ≥ 2 ⟹ EVA_count > 0
```

**Witness.** ev-18 defines "And Toronto" (not a referent) as a byline fragment.
ev-41 defines Toronto as "his". ev-37 defines El Chapo as "worth". ev-370
defines "Often". EVA = 0. REC = 1.

## 5. DARK

**Law.** Absence that is written down is an answer. Absence that is not written
down becomes a guess.

**Followed.** Every dark sentence carries a reason: chrome, no-event,
unparseable. A query whose terms are absent from the fold returns an
attestation of absence with its own citation type: scanned N sentences, term
not present, here is the nearest neighborhood. Term matching folds diacritics
and case before declaring absence.

**Violated.** Retrieval below any relevance floor served as the answer. A weak
lexical hit standing in for "the document does not say." A term declared
unseekable because the matcher could not see past an accent.

**Check.**

```
∀ retrieval r: r.score < floor ⟹ answer == absence_attestation
fold(query_term) compared against fold(document_term)
dark_sentences.every(s => s.reason != null)
```

**Witness.** Session turn 3: "who was the head of it" answered with a sentence
about a gun in a mouth, overlap on the word "head", score 0.30, badged clean.
Turn 10: "guzman" marked unseekable while "Guzmán" sits at s14.

## 6. WEIGHT

**Law.** Write only what was observed and what was decided. Weight is given by
the one who asks, from where they stand.

**Followed.** Events carry no scores as properties. Mass, momentum, force, and
overlap appear only inside `observed.frame` blocks stamped with cursor
position, rules revision, and couplings. Replaying the same log under a
different frame yields different measurements and identical events. A badge on
an answer names the frame that produced it.

**Violated.** Confidence stored on entries. A clean badge derived from one
frame's lexical overlap presented as an absolute property of the answer.
Measurements surviving a rule change they should not survive.

**Check.**

```
no event field {confidence, score, weight} outside observed.frame
replay(log, frame_A).events == replay(log, frame_B).events
replay(log, frame_A).measures ≠ replay(log, frame_B).measures when frames differ
```

**Witness.** The graph export follows this one. Its frame note states it
plainly and its events carry measurements only inside frame blocks. The session
audit violates it: turn 2's "clean" badge certifies a claim ("metrics to
measure success") bound to an unrelated sentence, one frame's overlap
arithmetic presented as truth, then laundered through four subsequent turns.

## 7. CUSTOM

**Law.** The laws are few and do not change. Everything else is custom, and
customs live where they can be doubted. Customs are admitted the way things
are: seen twice, then kept.

**Followed.** Core holds the four laws and their parameters: confinement at
existence, gravity and charge at structure, the weak change at significance.
Every surface criterion, chrome patterns, quote pairs, titles, timecodes,
attribution verbs, resolves through the rules fold under the active frame.
Every active custom traces to a ledger event with provenance. New customs enter
as REC events with `slot_sightings ≥ 2`, induced from structure, not from a
lexicon. Any custom can be disabled per register without touching the engine.

**Violated.** Pattern literals compiled into the engine. A convention that
cannot name the ledger event that admitted it. A register the reader cannot
enter because its customs are someone else's code. Convention induction
delegated to a small model in freeform, producing one degenerate proposal that
claims to resolve everything.

**Check.**

```
grep(engine, surface_pattern_literals) == ∅ outside pack definitions
∀ active rule: rule.lid ∈ ledger
∀ induced rule: rule.basis.slot_sightings ≥ 2
```

**Witness.** Followed once: ev-0 admits "says" to attribution_verbs, basis
`slot_sightings: 2`, reason "typography, not lexicon", ledger lid attached. The
same gate that admits entities admitting a rule. Violated everywhere else:
chrome handling absent because web-article furniture was never a pack, and the
audit's own convention-proposal turn returned one proposal citing all 32
friction spans, custom induction attempted through the wrong organ.

## Conformance

A dump conforms when all seven checks pass. Score a dump as a 7-bit vector in
invariant order.

```
Toronto Life corpus, 2026-06-11:   0 0 0 0 0 1 0
Target after rebuild:              1 1 1 1 1 1 1
```

The order of the bits is the dependency order. A failure at ADMISSION poisons
every bit after it: an unadmitted entity cannot bind, cannot speak, has no
company, and corrupts the dark. Fix left to right. Test after each bit.

The elegance criterion, stated once: one gate, one ledger, one frame. The gate
admits entities and customs alike. The ledger holds deeds and rules alike. The
frame weighs everything and owns nothing. Anything in the machine that cannot
be located in gate, ledger, or frame is either one of the four laws or it does
not belong.

---

## Mechanization in this repo

The spec above is the law; `tools/conformance.js` is the instrument. It scores
a `cleon-ingestion/1` dump (the Ingestion drawer's **Export JSON**) as the
7-bit vector, and every verdict cites the events or entities that earned it.
`tests/conformance.test.js` pins the instrument with two frozen fixtures — a
conforming log that scores `1 1 1 1 1 1 1` and a Toronto-shaped log that scores
`0 0 0 0 0 1 0` — plus a live-engine run whose pinned bits are the rebuild's
scoreboard ("fix left to right, test after each bit": flip an expectation when
its bit lands).

```sh
node tools/conformance.js dump.json [more.json …]   # score exported dumps
node tools/conformance.js --parse article.txt        # parse live, then score
node tools/conformance.js dump.json --session audit.jsonl   # + session advisory
npm run conformance -- dump.json --json report.json
```

Exit codes: `0` every dump conforms, `1` any bit is 0, `2` usage/load error.

### Operator semantics the checker assumes

**CON is the common op; SYN is the rare one.** CON is a bond — two resolved
referents joined by a deed, the edge a "who did X to Y" question walks. SYN is
synthesis — the creation of something greater than the sum of its parts (a
gravity merger minting a canonical referent out of its shards is the shipped
example, and it stays SYN). The BINDING check is exactly this distinction made
mechanical: an event carrying `s`/`v`/`o` whose endpoints both resolve to
distinct referents must be CON; an event carrying `sites`/`canonical` is
synthesis and is exempt.

### Propositions, not word order

BINDING's law is about propositions — two referents joined by a deed — and
never about position. "SVO" in the checks is shorthand for whatever shape a
register's conventions use to *find* deeds. The shipped en-narrative reader
finds them positionally (first noun as subject, last verb as deed), and that
is an English convention, not core: Ancient Greek and Latin mark roles by
case morphology under free word order, Japanese by particles, Chinese by
topic chains — each register's deed-finder must enter through the same
pack/ledger channel as every other custom, never as engine literals. The
instrument is already order-blind: it reads emitted deeds (surfaces, hints,
referent ids) however the register produced them, and the engine's positional
finder runs only under the en frame. A register with no deed-finding
convention yet deposits no deeds, and BINDING passes vacuously — honest, and
visible in the sweep (es and zh today). The same lesson governs the word
layer: tokenization and the index character class are conventions too, and a
register they do not cover (zh terms today) shows up honestly in the
every-word accounting rather than pretending coverage.

### The cube behind the log: sites and stances

The seven invariants are laws over the **Act face** of the EO cube — the
operator vocabulary, Identity ⤫ Space: NUL / SEG / DEF (Differentiate),
SIG / CON / EVA (Relate), INS / SYN / REC (Generate), across Existence /
Structure / Interpretation. The cube has two more faces the instrument does
not yet score from a dump, and their vocabularies are pinned here so log
shapes can grow into them:

- **The Site face** (Space ⤫ Time) — *where* a mark lands: **Void, Thing,
  Kind / Field, Link, Network / Atmosphere, Lens, Paradigm**. A CON bond
  lives at a Link (Structure ⤫ Figure); a frame DEF reads a Network through
  a Lens; chrome is Field-level furniture mistaken for Things.
- **The Stance face** (Identity ⤫ Time) — *how* the engagement holds its
  target: **Clearing, Dissecting, Unraveling / Tending, Binding, Tracing /
  Cultivating, Making, Composing**. The stance of an operator varies with
  the temporal grain of its target — a DEF on a Figure is Dissecting, on a
  Pattern it is Unraveling — so the engine's current per-event `stance`
  strings (one fixed label per op) are a flattening this spec does not yet
  police.

Full specification is `operator(Site, Resolution)`. When logs carry site and
stance addresses, the instrument gains those columns; until then it scores
the Act face only, and the seven bits are exactly the Act-face laws.

### The engine/conventions distinction is sacrosanct

Invariant 7 binds the instrument as much as the engine. The check logic in
`tools/conformance.js` knows only the four laws and the operator schema
(`INS SYN DEF SIG NUL SEG CON EVA REC` and their fields); **every** surface
criterion — chrome patterns, the pronoun list, the attribution-value sets, the
type lexicon, the frame-ref shape, the dark-reason word, the retrieval floor,
the degeneracy threshold — lives in `DEFAULT_PACK` and resolves through it.
`--pack file.json` replaces any of it per register without touching a check,
the same way a reading convention is disabled without touching the engine. A
dump's own marks always outrank the pack's heuristics: a conforming log marks
its chrome dark with `reason: chrome`, and the pack's furniture patterns exist
only so an unmarked (nonconforming) dump can still be read.

Register packs live in `tools/packs/` (gutenberg, es, zh, ja — see its
README), merged key-wise over the default. `evo/experiments/conformance-sweep.js`
(`npm run evo:conformance`) runs the corpus through the instrument under its
per-register packs and reports vectors, the violated-law histogram behind
each 0, and sample witnesses; `--bare` scores everything under the default
web-shaped pack to show what the register conventions buy.

### What each bit reads, and what is not scored from a dump

| bit | scored from the dump | advisory (with `--session audit.jsonl`) | not mechanizable from a dump |
|---|---|---|---|
| 1 ADMISSION | every projected entity has ≥ 2 distinct non-chrome sighting sentences; no unconfirmed, unretired `first-sighting` INS | — | — |
| 2 BINDING | every both-ends-resolved deed is CON; every CON names two distinct referents; mergers stay SYN | — | — |
| 3 SPEECH | no `attributed: fallback`; no marked metaphor-only speaker; no place/org speaker without a prior transmuting DEF; continuations need a prior confident attribution; `unattributed` is honest and passes | — | metaphor *detection* (the conforming log carries the mark; the checker reads it) |
| 4 COMPANY | every DEF target resolves to an admitted referent (structural targets pack-listed); class/frame DEF values are frame refs or closed-vocabulary type transmutations, never copied fragments; every entity carries a frame DEF; ≥ 2 documents ⟹ EVA > 0 | — | — |
| 5 DARK | every span that deposited nothing substantive carries a reason (its NUL's `reason`, or a per-span/dark-list mark) | below-floor retrieval served without an attestation of absence; a term declared unseekable while its folded form sits in the lexicon | — |
| 6 WEIGHT | no `confidence` / `score` / `weight` field on any event outside `observed.*` | a grounded/clean badge that names no frame | replay equality across frames (engine-level) |
| 7 CUSTOM | every rule-admitting REC carries a ledger lid and `slot_sightings ≥ 2`; chrome spans deposit no graph events unless a chrome custom is admitted in the log | one proposal citing ≥ N friction spans (induction through the wrong organ) | `grep(engine, surface_pattern_literals)` — an architectural review of the engine source |

Session findings never move a bit: the vector scores the dump, exactly as the
spec scores the Toronto Life corpus `0 0 0 0 0 1 0` while its session audit
also violated DARK and WEIGHT.
