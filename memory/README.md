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
*admitted* record to the append webhook (one commit per admission, deduped on
op + target + anchor-hash set), so this file accumulates what reading taught
the system. Conventions are linked, not flat (`qualifies` / `excepts` /
`subset-of` / `feeds` edges — i before e, except after c), and every one is an
**assertion: contextual and revisable**.

Conventions also carry **provenance**: a `prov` array of anchors
`{h, sig, r, c, t}` — a truncated content hash of the evidencing span, a
quantized embedding signature, the reader who registered the sighting, its
coupling frozen at registration, and the log position. Anchors are **locally
resolvable, globally opaque**: on-device a parse-time hash table maps `h`
back to a sentence; off-device `h` is 16 hex with no dictionary, and
`EO_ANCHOR_PRIVATE = 'strict'` strips `sig` from everything shipped. Mass is
a sum over anchors (coupling × independence × decay × register-fit, with a
per-source cap); records without `prov` are legacy/seed, and seeds carry one
synthetic `{h:"seed", c:1.0}` anchor — finite mass, outvotable, so nothing in
the graph is unfalsifiable, including its initial conditions.

The **local model proposes conventions** through this channel — and only
proposes. The engine nominates friction at parse time (colon-label lines no
convention consumes, separator runs read as sentences, recurring pronoun
stalls); an idle, budgeted proposal turn shows the model a prose portrait of
the conventions in force plus the friction's engine-minted span handles; a
well-formed reply lands as a **signal** carrying model anchors (`r:
"llm-proposer"`, `c: 0.6`). Admission is mechanical and the model can never
be its own witness: θ_admit of independent anchor coupling, ≥ 2 distinct
hashes, ≥ 1 non-model anchor — two document co-witnesses, or one plus a
one-tap confirm in the glass box's Proposals tab. Admitted members land
through the ledger (`colon_speaker_labels`, `separator_glyph_lines` — both
shipped empty, grown only this way), the reading changes on the next parse,
and a user SEG can decay any of it back to dormancy.

Future residents: serialized learned-ledger deltas (the speech verbs a session
induces), per-register convention packs, and the embedding-affinity index that
connects conventions to content types.
