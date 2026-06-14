# Adapters

An **adapter** is the costume a model or parser wears so the engine — through a
pack — sees one shape no matter what is doing the work. Behind the costume it
can be Tesseract or TrOCR for OCR, Whisper for speech, tree-sitter for code,
pdf.js for born-digital PDFs, CLIP for cross-modal embeddings. In front of it,
every adapter exposes the **same** interface: it takes input of a declared kind
and produces **events** of a declared shape, with confidence and provenance on
each one.

The full rationale and rules are in **[`../adapter-interface-spec.md`](../adapter-interface-spec.md)**.
This README is the operational summary.

## The one rule

> An adapter takes input and returns events. It does **not** interpret, does
> **not** decide what counts as a referent, does **not** mutate the log, and
> does **not** call other adapters. Interpretation is the pack's job; the loop is
> the engine's.

Three roles, three seams: the **adapter** handles modality, the **pack** handles
substrate, the **engine** handles the loop.

## Layout

```
adapters/
  contract.js            window.EOAdapterContract — the shape in code (validators, event())
  registry.js            window.EOAdapters — register / discover / select / runFor
  manifest-schema.json   JSON Schema for manifests (mirrors EOAdapterContract.MANIFEST_SCHEMA)
  <modality>/
    manifest.<x>.json    the declaration (validated, reviewable)
    <x>.js               the implementation (registers the adapter)
```

Each modality is a folder; each adapter is a **manifest + an implementation**.

## The contract (see `contract.js`)

A **manifest** declares identity, the runtime it wraps, resources, and — load
bearing — what its `confidence` *means*:

```js
{ id, name, version, category, modality, capability,
  modelRef:  { runtime, model, version, weightsUrl?, weightsBytes? },
  resources: { backend, memMB, expectedLatencyMs },
  confidenceSemantics: "softmax" | "model-head" | "heuristic" | "deterministic",
  failureModes: string[] }
```

An **adapter** implements:

```js
{ manifest, load(): Promise<void>, ready(): boolean,
  run(input, opts?): Promise<AdapterEvent[]>, unload?(): Promise<void> }
```

Every **event** is the same shape regardless of modality (richness goes in `meta`):

```js
{ id, adapter: { id, version }, region, confidence /* [0,1] */, payload, t /* ISO */, meta }
```

`region.kind` is appropriate to the modality: `bbox` (image/pdf), `timerange`
(audio), `charoffset` (text), `row` (table), `node` (code).

## How packs find adapters

Packs ask by **capability**, never by adapter id — adapters are interchangeable
behind a capability:

```js
const events = await window.EOAdapters.runFor('ocr', someBlob);   // pick + warm + run
const a      = window.EOAdapters.selected('pdf-text');            // just resolve
```

`selected(capability)` resolves in order: the user's explicit choice
(`localStorage["eo.adapters.preferred.<capability>"]`), then the performance
profile (`eo.adapters.profile`: `browser` → lightest, `desktop` → middle,
`maximum` → heaviest), then the first runnable adapter. Adapters whose declared
backend can't run here (e.g. WebGPU with no GPU) are filtered out — and shown
disabled, with the reason, in **Settings → Models & adapters**.

## Adding an adapter

1. Write `adapters/<modality>/<x>.js` — an IIFE that builds the adapter and
   calls `window.EOAdapters.register({ manifest, load, ready, run, unload })`.
   Resolve the underlying library from a `window.EO_*` seam first (for
   self-hosting and tests), then the CDN. Build events with
   `window.EOAdapterContract.event(...)`.
2. Run `node tools/gen-adapter-manifests.js` to emit the matching
   `manifest.<x>.json` from your inline manifest (they are kept in sync; the
   test fails if they drift).
3. Add the script to `index.html` (and `build.mjs`), and map the id in
   `tests/adapters-harness.js`.
4. `node tests/adapters.test.js` — the smoke contract test runs against every
   registered adapter.

No engine change. No pack change for existing substrates. The interface does not
bend to fit an adapter; adapters bend to fit the interface (and where they
genuinely can't, the interface is extended in writing, in the spec).

## Shipped in this first wave

`ocr` (Tesseract, TrOCR printed + handwritten) · `asr` (Whisper tiny/base/small —
WebGPU/fp16 with a wasm/int8 fallback, 16 kHz mono resampling) · `pdf-text`
(pdf.js + a built-in fallback) · `csv-parse` (papaparse + built-in)
· `code-ast` (tree-sitter, JavaScript + Python) · `doc-layout` (docling-lite
heuristic) · `text-embed` (the resident MiniLM) · `image-text-embed` (CLIP).
