# Spec: the adapter is what models look like to the engine

A requirements document for the second seam of the architecture, the one the substrate spec implies but does not write down. The substrate spec is the seam between the engine and the surface, between the loop and the conventions of whatever is being read. This spec is the seam between the surface and the models, between the pack and the perceptual or parsing components that turn unstructured input into events. Together the two seams close the architecture's contract on both sides, and after both land, every new digestion path is a pack plus an adapter, both finite, both declarative, both reviewable, and the engine does not change.

## Why this document exists

Once the engine is decoupled the way the substrate spec describes, a substrate pack tells the engine how to read a stream and what counts as a token, a unit, a referent in that substrate. But a pack does not know how to get from a PDF page to text, from an audio file to a transcript, from a CSV to typed rows, from source code to an AST. That work belongs to a perceptual or parsing model, and the model belongs behind a uniform interface so the pack can ask for what it needs without knowing which model is on the other side. That interface is the adapter, and this is its spec.

An adapter is the model's costume. Behind the costume the model can be Tesseract or TrOCR for OCR, Whisper for speech, tree-sitter for code, papaparse for CSV, a layout model for documents. In front of the costume, the adapter exposes the same shape to the pack regardless of which model is doing the work. The pack stays general. The model stays swappable. The engine stays untouched.

## The single rule

An adapter does only one thing: it takes input of a declared kind and produces events of a declared shape, with confidence and provenance attached to each event. It does not interpret. It does not decide what counts as a referent. It does not segment beyond what its modality natively segments. Interpretation is the pack's job. Generation is downstream. The adapter's job is to be a reliable bridge from a raw modality into the Given-Log's event format, and nothing more.

State the rule positively. The adapter is a perceptual or parsing component that turns unstructured or differently-structured input into events. The pack is the interpreter that reads those events as substrate units. The engine is the loop that reads the substrate. Three roles, three seams, no role does another's work.

## What an adapter is

An adapter is a small piece of code that wraps a model or a parser and exposes a uniform interface. The interface is intentionally narrow. The narrowness is the discipline.

A perceptual adapter wraps a model that converts a non-textual modality into structured observations. OCR, ASR, document layout, object detection, audio classification, image segmentation, face detection, music structure analysis. Each takes a continuous or semi-structured input and returns a set of discrete observations the loop can treat as evidence.

A parsing adapter wraps a deterministic parser that converts a structured but non-readable format into the same kind of observations. Tree-sitter for code. A CSV parser for tabular data. A statute citation parser for legal text. A PDF text extractor for born-digital PDFs. A SQL parser for database schemas. These do not require ML, they require careful code, and they belong in the same interface because their role in the architecture is identical to the perceptual adapters'.

The distinction between perceptual and parsing is not enforced by the interface. They are the same shape because they do the same job. We name the two categories so the spec is clear about its scope. Anything that turns input into events qualifies, whether it does so with a model or with deterministic code.

## The adapter contract

An adapter declares itself in a manifest and implements a small set of methods. Both are minimal on purpose.

Identity. The adapter declares its name, version, the input modality it accepts, the output event shape it produces, and the model or parser it wraps with that component's own version. The version chain matters because the events the adapter writes carry the adapter's identity in their provenance, so the audit trail records not only what was observed but by which version of which model.

Input contract. The adapter declares the shape and type of input it accepts. A binary blob with a MIME type, a string with an encoding, a buffer with a sample rate, a stream with a chunk size. The pack does not adapt to the adapter's expectations. The adapter declares them and the pack provides input that conforms, or the pack rejects this adapter and tries another.

Output contract. The adapter declares the event shape it writes. Every event the adapter produces has a small set of required fields and a larger set of optional fields the adapter can populate based on what its model knows.

The required fields, the same for every adapter regardless of modality, are these. An event id unique within this digestion run. A reference to the adapter that produced it, by name and version. A reference to the input region or span the event observes, expressed in coordinates appropriate to the modality, bounding box for image, time range for audio, character offset for text, row index for tables. A confidence score bounded between zero and one, with the adapter's own semantics documented in its manifest, because a confidence of 0.7 means different things to different models. The event's primary content, which is the actual observation, typed according to the adapter's output declaration. A timestamp of when the observation was produced. A free-form metadata bag for adapter-specific fields that the pack may or may not consume.

The shape is the same for all adapters because the engine has to treat them identically. A confidence stamp from an OCR adapter and a confidence stamp from an ASR adapter and a confidence stamp from a CSV parser have to be readable by the same standing operator without special cases, which means the fields have to align, which means the contract has to be uniform. Adapters that need richer outputs put the richness in the metadata bag, where it is opaque to the engine and available to a pack that knows to look.

Behavior contract. An adapter is a function. It takes input, returns events, and is otherwise pure in the sense that matters for an event-sourced system. It does not mutate the log. It does not call other adapters. It does not invoke the engine. It returns its events and the pack writes them into the log. This is the same separation as the engine-pack seam, applied one altitude down. The adapter never reaches around the pack. The pack never reaches around the engine.

Failure modes. An adapter can fail. It declares which failures are recoverable and which are not, and it returns failures as events with a specific kind, not by throwing. A partial OCR result with low confidence is an event the pack can decide what to do with. A model load failure is an event the pack and the engine can show to the user. The adapter has no opinion about what should happen on failure, only about how to report it.

Resource declarations. The adapter declares what it needs to run. CPU only, GPU, WebGPU, model weights to download, memory footprint, expected latency for a typical input. This lets the pack decide whether to call this adapter in the browser, on a desktop, or not at all. An adapter that wants two gigabytes of GPU memory is not a candidate when the user is on a phone, and the pack needs to know that before it tries.

## The adapter manifest

The adapter declares itself with a manifest written alongside its code. The manifest is JSON or JSONL and carries the identity, input contract, output contract, failure modes, and resource declarations. The library that ships with Cleo is the collection of these manifests, and adding a new adapter is adding a new manifest plus its implementation. Cleo at startup reads the manifests, registers the adapters, and exposes them to packs by capability rather than by name. A pack asks for an OCR adapter and Cleo offers the registered OCR adapters in an order the pack can rank. The pack picks one based on what is available, what the resource situation allows, and what the user has chosen.

The manifest is what makes the library a library and not a pile of code. A new contributor adds an adapter by writing one manifest and one implementation file. No engine change. No pack change for existing substrates. The substrate that wants the new adapter declares it as an alternative or replacement for an existing one, and the pack picks at runtime.

## The library

A library entry is one adapter plus, where appropriate, one pack that demonstrates it being used. The library starts with the substrates Cleo most needs and grows as new substrates are added.

The first entries are the ones the current accountability work points at directly. An OCR adapter that wraps Tesseract for the browser and a heavier transformer OCR for the desktop, with the manifest declaring the resource profile of each. A document layout adapter for scanned documents that returns regions for title, body, signature, table, header. An ASR adapter wrapping Whisper at multiple sizes. A CSV parser, a JSON parser, a PDF text extractor for born-digital files. A tree-sitter adapter for code, with a per-language manifest because tree-sitter has separate grammars. A citation parser for legal documents. An EXIF adapter for image metadata. A geocoder for addresses. Each is a small, contained piece of work, and each opens a new substrate when paired with the right pack.

The second wave is where the architecture starts to be different from anything in the field. A CLIP adapter that embeds images and text into a shared space, so a pack can compute cross-modal standing. An audio-text embedding adapter for the same purpose, where they exist locally. A diarization adapter for who-spoke-when. An object detection adapter that returns classes and locations. These are the adapters that make cross-substrate standing real, where a claim made in one modality can be checked against evidence in another, with the cosine in a shared embedding space carrying the standing measurement.

The third wave, which is where this gets interesting for outputs, is the generative side. The talker slot in the engine is currently an LLM. The adapter interface lets that slot be anything. An image generation adapter that takes a structured prompt from the loop and produces an image, with the prompt carrying the witness-degree-aware claims the loop has assembled. A diagram renderer adapter that takes a graph structure and produces SVG. A TTS adapter for spoken output. A structured data adapter that produces JSON or CSV against a schema. Each of these is the same shape, an adapter that turns the loop's output into a modality, with the events of generation logged the same way the events of perception are. The architecture does not distinguish between perception and generation at this seam. Both are modality changes, and both go through the same kind of adapter.

## The relationship to the standing operator

The standing operator, the piece the architecture still owes itself, depends on the adapter contract being honest. Standing is computed across events in the log, regardless of which adapter produced them, by reading each event against the rest under the live frame. For that to work, the events have to be comparable, which means the confidence semantics have to be honest, which means every adapter's manifest has to be precise about what its confidence means and how it was calibrated. An adapter that returns confidence values it cannot defend is a hazard, because the standing operator will use those values to weight evidence and a misweight propagates.

This is the discipline the spec asks of every adapter contributor. The confidence field is load-bearing. If your model returns a softmax probability, say so in the manifest. If it returns a learned confidence from a separate head, say so. If it returns a heuristic, say so. The standing operator can do its work over events of varying confidence semantics as long as the semantics are declared, because the operator can normalize. It cannot do its work over events of unknown confidence semantics, because the field would be uniform across adapters and mean different things. So a contributor's job is not only to add the model but to be honest about what its outputs mean.

## What the engine sees

After both seams are in place, this is what the engine sees, end to end.

A stream of input arrives. The user drops a file, types a question, pastes a URL, points at a folder. The engine examines the stream and asks Cleo's substrate-detection layer which substrate this is, which is a pack-level question answered by the registered packs' detection probes. The detected substrate identifies its pack.

The pack examines the stream and asks Cleo's adapter library which adapter or adapters it needs to convert this stream into events. The adapters run, write events into the log with full provenance and confidence, and return.

The pack now sees a stream of events instead of a raw input. It segments the events into units, identifies candidate referents, and exposes those to the engine.

The engine, which has been the same engine the whole time, reads the units and referents the pack surfaced, runs its operators, computes witness and form and standing, and the loop runs.

The output, if the work calls for one, is generated by an adapter in the talker slot, with the slot's adapter chosen by the requested output modality. Text from an LLM. An image from a generation model. A diagram from a renderer. Audio from a TTS. The output goes through the same standing computation as everything else, because it is just another event in the log, and the user sees it with the same kinds of stamps the inputs carried.

Nothing about the engine cares which modalities are running. The pack handles substrate. The adapter handles modality. The engine handles the loop. Three roles, three seams, one architecture.

## What this unlocks, said plainly

Once both seams are real and the library starts to fill, several things become available that the current AI landscape does not have.

A reader that reads images and audio and tables and code with the same loop as the one that reads prose, producing outputs whose path is auditable in exactly the same way regardless of modality.

A system that can swap a model out, retire it, replace it with a better one, without changing the rest. The log of work the old model contributed to remains intact because the events are owned by the architecture, not by the model.

A system that can compose models that were never trained to work together, because they are not working together. Each writes its own events. The loop is what reads across them.

A system whose outputs include not only text but images, diagrams, structured data, audio, and code, with every output stamped against the evidence that grounds it.

A system that grows by accretion, one adapter and one pack at a time, where each contribution is finite and reviewable and the architecture does not change under it.

That last point is the one this spec exists to make true. The architecture stops being a thing that grows by editing the engine and becomes a thing that grows by adding library entries. The work changes from architectural to integrative. The system can outpace any single contributor because the contributions compose without conflict. Which is what an open architecture is, finally, and what the spec is for.

## Acceptance

An adapter interface defined in code, with the methods, the manifest format, the event shape, and the resource declarations all written down and used by every adapter in the library.

A library directory in the repo where adapters live, each with its manifest and implementation, registered at startup, available to packs by capability.

A first adapter, picked deliberately, implemented to the spec end-to-end, with its events flowing into the Given-Log and being read by a pack and contributing to the engine's standing computation. This is the proof. Until one adapter has been built to this spec and is working, the spec is a proposal. After one has, the rest are integration, sized by the model, not by the architecture.

A standing rule for review. Every contribution to the library is reviewed against the spec. The interface does not bend to accommodate adapters. Adapters bend to fit the interface, and where they cannot, the interface is extended, in writing, with the reason. The same rule as the engine spec, applied to the other seam.

That is the contract. The architecture is the loop and the two seams. Everything else is a library entry.

---

## Implementation notes (this repo)

The contract lives in code at [`adapters/contract.js`](adapters/contract.js)
(`window.EOAdapterContract`) and the registry at
[`adapters/registry.js`](adapters/registry.js) (`window.EOAdapters`). See
[`adapters/README.md`](adapters/README.md) for the operational summary and how to
add an adapter. Where the build prompt and this spec differed, the conservative
choice was taken and noted in the pull request that introduced the library
(notably: a single tree-sitter manifest carrying multiple grammars rather than a
per-language manifest, to match the prompt's explicit file layout).
