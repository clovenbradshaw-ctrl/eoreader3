# memory/

The durable memory the reading system writes and reads — graphs, not code.

- **`conventions.jsonl`** — everything *human-language-specific*, as an
  append-only graph of eo operations. The engine's mechanics (gravity,
  momentum, two-sighting, δ-gates, the nine operators) are universal; what
  makes a reading *English narrative* or *contemporary journalism* or
  *Spanish dialogue* is a **convention**, and no inventory is more real than
  another — you, y'all, ella, vous, and 她 are equal citizens here.

  One JSON record per line:
  - `INS` instantiates a module (a register of conventions) or one
    convention, each with an `affinity` text — the kinds of *content* it
    belongs to, the hook an embedder scores against a document at runtime to
    pick the register (Shakespeare and the New York Times use different
    pronouns);
  - `SYN` `member-of` edges carry the inventories (seq order is list order);
  - `DEF` carries word properties (`he`: gender m, person 3; `they`: number
    plural-or-singular-by-register) and structured values;
  - `REC` records the register laws in the engine's own change vocabulary.

  The engine projects this file the way it projects any event log
  (`projectConventions`), and lands it as **ledger deltas** — the same
  append-only channel its own induction uses (`loadConventions`). Absent or
  garbled, the shipped seeds apply and behavior is identical;
  `tests/conventions.test.js` pins file ≡ seeds, so the two can never
  silently disagree. Regenerate from seeds with `npm run conventions:gen`.

The graph **hydrates from failure**: every model draft the EVA veto rejects
appends a `REC` (with its register affinity); a term that fails twice becomes
a **contextual neuron** — admitted into `eva_veto_lexicon` through the ledger,
feeding the veto and the retry prompt from then on. The running app ships each
*admitted* neuron's REC to the append webhook (one commit per neuron), so this
file accumulates what reading taught the system. Conventions are linked, not
flat (`qualifies` / `excepts` / `subset-of` / `feeds` edges — i before e,
except after c), and every one is an **assertion: contextual and revisable**.

**Provenance anchors.** Conventions carry provenance back to their sources —
pointed to by *content hash + embedding signature*, never by name or
resolvable location: `{ h: sha256(span)[:16], sig: int8[384]|null, r: reader,
c: coupling-at-registration, t: log position }`. On-device, a parse-time span
table resolves `h` back to (document, sentence); off-device `h` is 16 opaque
bytes. Records without `prov` are legacy/seed — they carry one synthetic
anchor (`h:"seed"`, finite coupling 1.0), so even the graph's initial
conditions are outvotable. Independence is set arithmetic on `h`; a SEG names
the hashes it contradicts; admission of a *proposed* convention requires
`Σ independent couplings ≥ θ_admit` across ≥ 2 distinct spans with ≥ 1
non-model witness. `EO_ANCHOR_PRIVATE=strict` strips `sig` from shipped
records (coupling-only weighting off-device).

**The proposer.** The same local model that phrases answers may *propose*
conventions — only from friction the engine registered mechanically
(unconsumed `LABEL:` lines, separators read as sentences, repeated pronoun
stalls), only citing span-ids the engine minted, only within a closed
grammar, and never as its own witness. A surviving proposal enters this log
as a **signal** (`prov` all model anchors, below θ by construction) and
admits when a disjoint document matches its probe or the user confirms
(c:5.0) in the Glass box → Proposals channel; rejection is a SEG against its
anchors. Admission is a REC; the inventory member lands through the ledger
(`speaker_label_patterns`, `separator_lines`) and the next parse reads
differently. `tests/conventions.test.js` carries the full battery: anchor
well-formedness, opacity, independence, seed falsifiability, register
weighting + per-source cap, SEG splitting, the proposal grammar, friction
nomination, all corroboration paths, and the live reading change.

Future residents: serialized learned-ledger deltas (the speech verbs a session
induces), per-register convention packs, and the embedding-affinity index that
connects conventions to content types.
