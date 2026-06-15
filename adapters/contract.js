/* ============================================================
   Cleo — the adapter contract, written as code (not prose).

   An adapter is the costume a model or parser wears so the engine (through a
   pack) sees one shape regardless of what is doing the work. This file is the
   single source of truth for that shape: the manifest schema, the event shape,
   and the validators every adapter and every consumer agree on. The full
   rationale lives in ../adapter-interface-spec.md.

   The discipline (from the spec): an adapter takes input of a declared kind and
   produces events of a declared shape, with confidence and provenance on each
   event. It does not interpret, does not decide what counts as a referent, does
   not mutate the log, and does not call other adapters. Three roles, three
   seams: the adapter handles modality, the pack handles substrate, the engine
   handles the loop.

   Published as window.EOAdapterContract. No model-specific logic ever lives
   here — the contract is the only thing the registry knows; the model lives
   behind its implementation file.
   ============================================================ */
(function () {
  'use strict';

  // The four kinds a manifest may declare itself. "perceptual" and "parsing"
  // are the same SHAPE because they do the same job (input → events); the names
  // only scope the spec. "embedding" and "generation" are the two other seats
  // the architecture reserves at this seam.
  const CATEGORIES = ['perceptual', 'parsing', 'embedding', 'generation'];

  // The modalities an adapter may accept/emit. The "+text" forms are the
  // cross-modal embedders (CLIP, audio-text) the standing operator will read.
  const MODALITIES = ['image', 'audio', 'text', 'code', 'table', 'pdf', 'image+text', 'audio+text'];

  // How an event points back at the input region it observed, in coordinates
  // appropriate to the modality. bbox for image/pdf, timerange for audio,
  // charoffset for text, row for tables, node for code.
  const REGION_KINDS = ['bbox', 'timerange', 'charoffset', 'row', 'node'];

  // What a confidence number MEANS. The standing operator can normalize across
  // adapters only if each declares its semantics — an undeclared 0.7 is a
  // hazard. Honesty here is load-bearing (see the spec).
  const CONFIDENCE_SEMANTICS = ['softmax', 'model-head', 'heuristic', 'deterministic'];

  // The runtime that actually executes the wrapped model/parser.
  const RUNTIMES = ['transformersjs', 'tesseract', 'deterministic', 'webllm', 'external'];

  // Where it runs / what it costs, so a pack (or the picker) can decide whether
  // to offer it on this device.
  const BACKENDS = ['cpu', 'webgpu', 'wasm'];

  /* ---------------- the manifest schema, as a draft-07-style object ----------
     Mirrored byte-for-byte into manifest-schema.json (a test pins them equal),
     so there is exactly one schema: this object is the runtime validator's
     source and the JSON file is the published, reviewable artifact. */
  const MANIFEST_SCHEMA = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'AdapterManifest',
    type: 'object',
    required: ['id', 'name', 'version', 'category', 'modality', 'capability',
      'modelRef', 'resources', 'confidenceSemantics', 'failureModes'],
    additionalProperties: true,
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      name: { type: 'string', minLength: 1 },
      version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+' },
      category: { type: 'string', enum: CATEGORIES },
      modality: { type: 'string', enum: MODALITIES },
      capability: { type: 'string', minLength: 1 },
      modelRef: {
        type: 'object',
        required: ['runtime', 'model', 'version'],
        additionalProperties: true,
        properties: {
          runtime: { type: 'string', enum: RUNTIMES },
          model: { type: 'string', minLength: 1 },
          version: { type: 'string', minLength: 1 },
          weightsUrl: { type: 'string' },
          weightsBytes: { type: 'number', minimum: 0 },
        },
      },
      resources: {
        type: 'object',
        required: ['backend', 'memMB', 'expectedLatencyMs'],
        additionalProperties: true,
        properties: {
          backend: { type: 'string', enum: BACKENDS },
          memMB: { type: 'number', minimum: 0 },
          expectedLatencyMs: { type: 'number', minimum: 0 },
        },
      },
      confidenceSemantics: { type: 'string', enum: CONFIDENCE_SEMANTICS },
      failureModes: { type: 'array', minItems: 1, items: { type: 'string' } },
      // Optional, free-form declarations a pack MAY consume.
      input: { type: 'object' },
      output: { type: 'object' },
      meta: { type: 'object' },
      // Optional: this adapter is the general-purpose default for its capability
      // (chosen over the profile pick when the user has expressed no preference).
      defaultForCapability: { type: 'boolean' },
    },
  };

  /* ---------------- a minimal JSON-Schema validator -------------------------
     Supports exactly the subset the manifest schema uses (type, required,
     properties, enum, pattern, items, additionalProperties, minimum/maximum,
     minItems, minLength). Self-contained so the contract carries no dependency
     and runs identically in the browser and in Node. */
  function jsonSchemaValidate(schema, value, where) {
    const errors = [];
    (function check(sch, val, p) {
      if (!sch || typeof sch !== 'object') return;
      if (sch.type) {
        const t = Array.isArray(val) ? 'array' : (val === null ? 'null' : typeof val);
        const ok = sch.type === 'integer'
          ? (t === 'number' && Number.isInteger(val))
          : t === sch.type;
        if (!ok) { errors.push(p + ': expected ' + sch.type + ', got ' + t); return; }
      }
      if (sch.enum && sch.enum.indexOf(val) < 0) errors.push(p + ': ' + JSON.stringify(val) + ' is not one of ' + JSON.stringify(sch.enum));
      if (typeof val === 'string') {
        if (sch.pattern && !(new RegExp(sch.pattern)).test(val)) errors.push(p + ': ' + JSON.stringify(val) + ' does not match /' + sch.pattern + '/');
        if (sch.minLength != null && val.length < sch.minLength) errors.push(p + ': shorter than minLength ' + sch.minLength);
      }
      if (typeof val === 'number') {
        if (sch.minimum != null && val < sch.minimum) errors.push(p + ': ' + val + ' < minimum ' + sch.minimum);
        if (sch.maximum != null && val > sch.maximum) errors.push(p + ': ' + val + ' > maximum ' + sch.maximum);
      }
      if (sch.type === 'array' && Array.isArray(val)) {
        if (sch.minItems != null && val.length < sch.minItems) errors.push(p + ': fewer than minItems ' + sch.minItems);
        if (sch.items) val.forEach((v, i) => check(sch.items, v, p + '[' + i + ']'));
      }
      if (sch.type === 'object' && val && typeof val === 'object' && !Array.isArray(val)) {
        const props = sch.properties || {};
        (sch.required || []).forEach(k => { if (!(k in val)) errors.push(p + ': missing required "' + k + '"'); });
        for (const k of Object.keys(val)) {
          if (props[k]) check(props[k], val[k], p + '.' + k);
          else if (sch.additionalProperties === false) errors.push(p + ': unexpected property "' + k + '"');
        }
      }
    })(schema, value, where || '(root)');
    return { ok: errors.length === 0, errors };
  }

  // Validate a manifest against the one schema. The registry calls this before
  // accepting any adapter; the contract test calls jsonSchemaValidate against
  // the mirrored JSON file (same logic, same result).
  function validateManifest(m) { return jsonSchemaValidate(MANIFEST_SCHEMA, m, 'manifest'); }

  /* ---------------- the event shape ----------------------------------------
     Every adapter emits events of EXACTLY this shape, regardless of modality,
     so the engine can treat them identically. Richness goes in `meta`, opaque
     to the engine and available to a pack that knows to look. */
  const REQUIRED_EVENT_FIELDS = ['id', 'adapter', 'region', 'confidence', 'payload', 't', 'meta'];

  // Which region.kind is appropriate for a given modality — the "region shape
  // matches the modality" rule the contract test asserts. Embedders (the
  // "+text" modalities) may anchor to either side of their input.
  const MODALITY_REGION = {
    image: ['bbox'],
    pdf: ['bbox'],
    audio: ['timerange'],
    text: ['charoffset', 'row'],
    code: ['node'],
    table: ['row'],
    'image+text': ['bbox', 'charoffset'],
    'audio+text': ['timerange', 'charoffset'],
  };
  function regionMatchesModality(region, modality) {
    if (!region || REGION_KINDS.indexOf(region.kind) < 0) return false;
    const allowed = MODALITY_REGION[modality];
    return !allowed || allowed.indexOf(region.kind) >= 0;
  }

  // Validate one event against the contract. Used by the smoke tests and
  // available to any consumer that wants to assert provenance honesty.
  function validateEvent(e) {
    const errors = [];
    if (!e || typeof e !== 'object') return { ok: false, errors: ['event is not an object'] };
    for (const f of REQUIRED_EVENT_FIELDS) if (!(f in e)) errors.push('missing required field "' + f + '"');
    if (typeof e.id !== 'string' || !e.id) errors.push('id must be a non-empty string');
    if (!e.adapter || typeof e.adapter.id !== 'string' || typeof e.adapter.version !== 'string') errors.push('adapter must be { id, version } strings');
    if (!e.region || REGION_KINDS.indexOf(e.region.kind) < 0) errors.push('region.kind must be one of ' + JSON.stringify(REGION_KINDS));
    if (typeof e.confidence !== 'number' || !(e.confidence >= 0 && e.confidence <= 1)) errors.push('confidence must be a number in [0,1]');
    if (!('payload' in e) || e.payload === undefined) errors.push('payload is required');
    if (typeof e.t !== 'string' || isNaN(Date.parse(e.t))) errors.push('t must be an ISO timestamp string');
    if (!e.meta || typeof e.meta !== 'object') errors.push('meta must be an object');
    return { ok: errors.length === 0, errors };
  }

  // Build a contract-conformant event. Adapters call this so the required
  // fields (id, provenance, timestamp, meta bag) are stamped uniformly and the
  // implementation only has to supply region/confidence/payload.
  let _seq = 0;
  function event(spec) {
    const a = (spec && spec.adapter) || {};
    return {
      id: (a.id || 'evt') + '-' + Date.now().toString(36) + '-' + (_seq++).toString(36),
      adapter: { id: a.id, version: a.version },
      region: spec.region,
      confidence: spec.confidence,
      payload: spec.payload,
      t: new Date().toISOString(),
      meta: spec.meta || {},
    };
  }

  // A failure is reported AS an event (the spec: adapters return failures, they
  // do not throw across the seam). kind lives in meta; the pack decides what to
  // do. confidence 0, deterministic — a non-observation is certain.
  function failureEvent(adapter, message, opts) {
    return event({
      adapter,
      region: { kind: 'charoffset', start: 0, end: 0 },
      confidence: 0,
      payload: { error: String(message || 'adapter failure') },
      meta: Object.assign({ kind: 'failure', recoverable: !!(opts && opts.recoverable) }, (opts && opts.meta) || {}),
    });
  }

  window.EOAdapterContract = {
    CATEGORIES, MODALITIES, REGION_KINDS, CONFIDENCE_SEMANTICS, RUNTIMES, BACKENDS,
    MANIFEST_SCHEMA, MODALITY_REGION, REQUIRED_EVENT_FIELDS,
    jsonSchemaValidate, validateManifest, validateEvent, regionMatchesModality,
    event, failureEvent,
  };
})();
