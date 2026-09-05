// SOCRATES-CONTRACT-0 / 0A — the neutral evidence language (serpent-evidence-1).
//
// An evidence packet is ONLY what Serpent could legitimately know at one
// point in time (asOfTs). It carries facts, claims, and derived sensor
// metrics with full provenance — never interpretation. Socrates consumes
// packets; collectors produce them. Nothing in the live runtime imports
// this file yet: the language is defined, nothing is wired.
//
// Principles that rule this file:
//   1. POINT-IN-TIME TRUTH — no fact may be known after asOfTs, and clocks
//      must be causally coherent (published <= retrieved, observed <=
//      known). Violations are rejected, never clamped, never rewritten.
//   2. UNKNOWN REMAINS UNKNOWN — MISSING/UNAVAILABLE evidence carries a
//      null value, never zero; absence of provider coverage is not a
//      negative claim.
//   3. THE CONTRACT IS CLOSED — every object layer has an exact allowed-key
//      whitelist and undeclared fields FAIL. A hash does not make invalid
//      data true; member identities are RECOMPUTED, not trusted.
//   4. Hard bounds everywhere — every array, excerpt, structured value,
//      reference set, and the whole packet's canonical form have caps.
//      Over-bound input fails validation; nothing is silently truncated.
//
// Pure module: no network, no filesystem, no configuration, no model.
// The public validators never mutate their input, fail closed, and never
// throw on hostile input (cycles, BigInt, NaN, deep nesting, non-plain
// objects all come back as bounded reasons). Identity helpers assume
// already-structurally-valid input — that assumption is documented here
// and enforced because validators run the structural walk first.
import { createHash } from 'node:crypto';

export const EVIDENCE_SCHEMA_VERSION = 'serpent-evidence-1';

// ---- hard bounds (the future cost funnel) ---------------------------------
export const MAX_CLAIMS = 12;
export const MAX_SOURCES = 32;
export const MAX_EVIDENCE = 64;
export const MAX_CLAIM_LINKS = 96;
export const MAX_CONTRADICTIONS = 24;
export const MAX_MISSING_EVIDENCE = 24;
export const MAX_ANALOGS = 6;
export const MAX_EXCERPT_CHARS = 1_000; // per-source raw excerpt
export const MAX_PACKET_RAW_CHARS = 8_000; // total raw excerpt chars per packet
export const MAX_TEXT_CHARS = 500; // any other free-text field (claimText, descriptions)
export const MAX_ID_CHARS = 120; // any identifier/locator-ish string
export const MAX_PROVIDER_COVERAGE = 64; // one entry per provider, bounded
export const MAX_REASON_CHARS = 200; // validator reason strings
export const MAX_REASONS = 32; // reasons returned per validation
export const MAX_REFS_PER_ITEM = 16; // any nested reference set, packet or analysis
// 0A structural bounds — evidence.value must be JSON-safe and bounded
export const MAX_EVIDENCE_VALUE_CANONICAL_CHARS = 4_096;
export const MAX_EVIDENCE_VALUE_DEPTH = 6; // containers may nest at most this deep
export const MAX_EVIDENCE_VALUE_ARRAY_ITEMS = 64;
export const MAX_EVIDENCE_VALUE_OBJECT_KEYS = 32;
export const MAX_EVIDENCE_VALUE_STRING_CHARS = 1_000;
// 0A aggregate caps — the whole contract object, canonically serialized
export const MAX_PACKET_CANONICAL_CHARS = 131_072;
export const MAX_CONTRACT_DEPTH = 16; // structural nesting cap for any contract object

export const boundedReason = (msg) => String(msg ?? 'unknown').slice(0, MAX_REASON_CHARS);

// ---- vocabularies (closed for version 1) ----------------------------------
// Extensibility policy: these enums are CLOSED under serpent-evidence-1.
// A new trigger kind, source type, state, or link kind requires a new
// schemaVersion; unknown values fail validation TODAY rather than being
// quietly carried. That is deliberate: a consumer must never meet a value
// it was not built to interpret.
export const TRIGGER_KINDS = Object.freeze([
  'RUMINT_CLAIM',
  'RUMINT_NOMINATION',
  'WIDE_EYE_RIPPLE',
  'MICRO_SHIFT',
  'GHOST_CLUE',
  'FLOW_ANOMALY',
  'COMBINATION',
  'MANUAL_RESEARCH',
]);

export const CLAIM_STATUSES = Object.freeze([
  'UNVERIFIED',
  'CORROBORATED',
  'PRIMARY_CONFIRMED',
  'CONTRADICTED',
  'RETRACTED',
  'UNKNOWN',
]);

export const SOURCE_TYPES = Object.freeze([
  'PRIMARY_OFFICIAL',
  'REGULATOR',
  'EXCHANGE_OFFICIAL',
  'PROJECT_OFFICIAL',
  'ESTABLISHED_MEDIA',
  'SOCIAL_ACCOUNT',
  'FORUM',
  'MARKET_DATA',
  'ONCHAIN',
  'INFRASTRUCTURE',
  'OTHER',
]);

// Authority classes are LABELS, not numeric weights. There is deliberately
// no score table here: what OFFICIAL means depends on context Socrates will
// weigh later, and baking in "OFFICIAL = +10" would create truth this
// contract has no right to create.
export const AUTHORITY_CLASSES = Object.freeze([
  'OFFICIAL',
  'ESTABLISHED',
  'IDENTIFIED',
  'PSEUDONYMOUS_KNOWN',
  'ANONYMOUS',
  'UNKNOWN',
]);

// A hundred copies of one rumor are NOT one hundred independent
// confirmations — ECHO is a first-class relation so RUMOR-2 can record
// that conclusion instead of losing it.
export const CLAIM_LINK_KINDS = Object.freeze([
  'ORIGIN',
  'INDEPENDENT_SUPPORT',
  'ECHO',
  'PRIMARY_CONFIRMATION',
  'CONTRADICTION',
  'RETRACTION',
]);

export const EVIDENCE_SENSES = Object.freeze([
  'RUMINT',
  'MICRO',
  'WIDE_EYE',
  'TAPE',
  'GOV',
  'GHOST',
  'FLOW',
  'INFRASTRUCTURE',
  'MEMORY',
  'MARKET',
  'OTHER',
]);

export const EVIDENCE_STATES = Object.freeze([
  'KNOWN',
  'MISSING',
  'UNAVAILABLE',
  'STALE',
  'CONTRADICTED',
]);

export const PROVIDER_COVERAGE_STATES = Object.freeze([
  'OBSERVED',
  'NOT_QUERIED',
  'UNAVAILABLE',
  'FAILED',
  'STALE',
  'NOT_SUPPORTED',
]);

// Strict symbol doctrine — identical shape to the RUMINT core: uppercase
// alphanumeric canonical coins, no fuzzy matching, ever.
export const COIN_RE = /^[A-Z0-9]{1,15}$/;

// ---- closed schema: exact allowed keys per object layer (0A) ---------------
// THE CONTRACT DEFINES WHAT MAY EXIST. Undeclared fields at ANY depth fail
// validation — a producer (or a future model) cannot extend its own schema
// by inventing keys, and raw content cannot bypass the excerpt bounds by
// hiding in a `body`/`fullText`/`instructions` field.
export const EVIDENCE_ALLOWED_KEYS = Object.freeze({
  packet: Object.freeze([
    'schemaVersion',
    'packetId',
    'asOfTs',
    'subject',
    'trigger',
    'claims',
    'sources',
    'evidence',
    'claimLinks',
    'providerCoverage',
    'contradictions',
    'missingEvidence',
    'analogs',
    'security',
  ]),
  subject: Object.freeze(['canonicalCoin', 'providerSymbols']),
  trigger: Object.freeze(['kind', 'sourceEventId', 'observedTs']),
  claim: Object.freeze(['claimId', 'claimType', 'normalizedSubject', 'claimText', 'firstObservedTs', 'status']),
  source: Object.freeze(['sourceId', 'provider', 'sourceType', 'authorityClass', 'publishedTs', 'retrievedTs', 'locator', 'excerpt']),
  excerpt: Object.freeze(['text', 'contentHash', 'untrusted']),
  evidence: Object.freeze(['evidenceId', 'sense', 'kind', 'state', 'knownAtTs', 'observedTs', 'value', 'sourceRefs', 'claimRefs', 'provenance']),
  claimLink: Object.freeze(['claimRef', 'sourceRef', 'kind', 'independenceGroup', 'observedTs']),
  providerCoverage: Object.freeze(['provider', 'state', 'checkedTs', 'detail']),
  contradiction: Object.freeze(['description', 'claimRefs', 'sourceRefs', 'evidenceRefs']),
  missingEvidence: Object.freeze(['kind', 'description']),
  analog: Object.freeze(['memoryId', 'setupFamily', 'similarityBasis', 'knownAtTs', 'outcome']),
  analogOutcome: Object.freeze(['reference', 'outcomeKnownAtTs']),
  security: Object.freeze(['untrustedTextPresent']),
});
const KEY_SETS = Object.fromEntries(Object.entries(EVIDENCE_ALLOWED_KEYS).map(([k, v]) => [k, new Set(v)]));

// ---- canonical identity ---------------------------------------------------
// Deterministic serialization: object keys sorted, undefined dropped, no
// whitespace. Two semantically identical objects serialize identically no
// matter what key order or pretty-printing they arrived with.
// ASSUMES structurally valid input (no cycles, no BigInt, bounded depth) —
// the public validators establish that before any identity work.
export const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`))
    .filter(Boolean)
    .join(',')}}`;
};

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export const contentHash = (text) => sha1(String(text));

// ARRAY ORDERING POLICY (documented per array, not casually global):
// every collection in an evidence packet is a SET — its members carry their
// own timestamps and identities, and no packet meaning lives in "which
// element came first in the JSON". So all packet arrays are UNORDERED and
// are normalized (sorted by canonical form) before hashing. If a future
// schema version introduces a semantically ordered array, it must be listed
// as ORDERED here and excluded from normalization.
export const ARRAY_ORDER_POLICY = Object.freeze({
  claims: 'UNORDERED',
  sources: 'UNORDERED',
  evidence: 'UNORDERED',
  claimLinks: 'UNORDERED',
  providerCoverage: 'UNORDERED',
  contradictions: 'UNORDERED',
  missingEvidence: 'UNORDERED',
  analogs: 'UNORDERED',
});

// NESTED REFERENCE ORDER POLICY (0A): every sourceRefs / claimRefs /
// evidenceRefs array anywhere in either contract is an UNORDERED SET.
// [A,B] and [B,A] are the same truth, so identity helpers sort a copy of
// these sets before hashing (never mutating caller input), and duplicate
// members inside one set are invalid — multiplicity is not meaning.
export const REF_SET_KEYS = Object.freeze(['sourceRefs', 'claimRefs', 'evidenceRefs']);
const REF_SET_KEY_SET = new Set(REF_SET_KEYS);

// Non-mutating deep copy with every ref set sorted. Assumes structurally
// valid input (validators run the structural walk first).
export function normalizeRefSets(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(normalizeRefSets);
  const out = {};
  for (const k of Object.keys(v)) {
    const val = v[k];
    out[k] =
      REF_SET_KEY_SET.has(k) && Array.isArray(val) && val.every((x) => typeof x === 'string')
        ? [...val].sort()
        : normalizeRefSets(val);
  }
  return out;
}

const sortSet = (arr) => [...arr].map((e) => canonicalJson(e)).sort();

// Identity basis: the whole packet except packetId itself, with nested ref
// sets sorted and every unordered top-level array replaced by its sorted
// canonical member list. Key order, whitespace, and set order never reach
// the hash; a material value change always does.
export function packetIdentityBasis(packet) {
  const basis = {};
  for (const k of Object.keys(packet)) {
    if (k === 'packetId') continue;
    const v = normalizeRefSets(packet[k]);
    basis[k] = ARRAY_ORDER_POLICY[k] === 'UNORDERED' && Array.isArray(v) ? sortSet(v) : v;
  }
  return basis;
}

export const packetIdentity = (packet) => `sep-${sha1(canonicalJson(packetIdentityBasis(packet)))}`;

// Member identities: semantic hash with a stable prefix, never random UUIDs.
// Each is the hash of the member's stable meaning (its content minus its
// own id, ref sets sorted), so the same fact always earns the same name —
// A SENSOR ID MUST PROVE ITS OWN CONTENT, and the validator recomputes it.
const memberIdentity = (prefix, obj, idKey) => {
  const basis = {};
  for (const k of Object.keys(obj)) if (k !== idKey) basis[k] = obj[k];
  return `${prefix}-${sha1(canonicalJson(normalizeRefSets(basis)))}`;
};

export const claimIdentity = (claim) => memberIdentity('clm', claim, 'claimId');
export const sourceIdentity = (source) => memberIdentity('src', source, 'sourceId');
export const evidenceIdentity = (item) => memberIdentity('evd', item, 'evidenceId');

const ID_RES = Object.freeze({
  packetId: /^sep-[0-9a-f]{40}$/,
  claimId: /^clm-[0-9a-f]{40}$/,
  sourceId: /^src-[0-9a-f]{40}$/,
  evidenceId: /^evd-[0-9a-f]{40}$/,
});

// ---- structural JSON-safety walk (0A) --------------------------------------
// The gate every contract object passes BEFORE any canonicalJson, hash, or
// semantic check: only null / boolean / finite number / string / array /
// plain object; no NaN or ±Infinity, no BigInt, no undefined values, no
// functions or symbols, no Date/Map/Set/class instances, no cycles, and
// nesting bounded by MAX_CONTRACT_DEPTH. Returns a bounded reason or null.
export function jsonShapeError(v, label = 'value', depth = 1, seen = new Set()) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'boolean' || t === 'string') return null;
  if (t === 'number') return Number.isFinite(v) ? null : boundedReason(`${label}: non-finite number is not JSON-safe`);
  if (t !== 'object') return boundedReason(`${label}: unsupported type ${t}`);
  if (depth > MAX_CONTRACT_DEPTH) return boundedReason(`${label}: nesting exceeds depth ${MAX_CONTRACT_DEPTH}`);
  if (seen.has(v)) return boundedReason(`${label}: cyclic structure`);
  seen.add(v);
  let err = null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length && err === null; i++) {
      if (v[i] === undefined) err = boundedReason(`${label}[${i}]: undefined is not JSON-safe`);
      else err = jsonShapeError(v[i], `${label}[${i}]`, depth + 1, seen);
    }
  } else {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) err = boundedReason(`${label}: non-plain object`);
    else
      for (const k of Object.keys(v)) {
        if (v[k] === undefined) {
          err = boundedReason(`${label}.${k}: undefined is not JSON-safe`);
          break;
        }
        err = jsonShapeError(v[k], `${label}.${k}`, depth + 1, seen);
        if (err !== null) break;
      }
  }
  seen.delete(v);
  return err;
}

// ---- evidence.value contract (0A) ------------------------------------------
// Structured values stay GENERIC for future senses but must be JSON-safe,
// acyclic, deterministic, and bounded. Fail closed — never truncate.
export function evidenceValueError(value) {
  const walk = (v, depth, seen) => {
    if (v === null || typeof v === 'boolean') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? null : 'non-finite number (NaN/Infinity) is not evidence';
    if (typeof v === 'string')
      return v.length <= MAX_EVIDENCE_VALUE_STRING_CHARS ? null : `string exceeds ${MAX_EVIDENCE_VALUE_STRING_CHARS} chars`;
    if (typeof v !== 'object') return `unsupported type ${typeof v}`;
    if (depth > MAX_EVIDENCE_VALUE_DEPTH) return `nesting exceeds depth ${MAX_EVIDENCE_VALUE_DEPTH}`;
    if (seen.has(v)) return 'cyclic structure';
    seen.add(v);
    let err = null;
    if (Array.isArray(v)) {
      if (v.length > MAX_EVIDENCE_VALUE_ARRAY_ITEMS) err = `array exceeds ${MAX_EVIDENCE_VALUE_ARRAY_ITEMS} items`;
      for (let i = 0; i < v.length && err === null; i++)
        err = v[i] === undefined ? 'undefined is not evidence' : walk(v[i], depth + 1, seen);
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) err = 'non-plain object';
      else {
        const keys = Object.keys(v);
        if (keys.length > MAX_EVIDENCE_VALUE_OBJECT_KEYS) err = `object exceeds ${MAX_EVIDENCE_VALUE_OBJECT_KEYS} keys`;
        for (let i = 0; i < keys.length && err === null; i++)
          err = v[keys[i]] === undefined ? 'undefined is not evidence' : walk(v[keys[i]], depth + 1, seen);
      }
    }
    seen.delete(v);
    return err;
  };
  const err = walk(value, 1, new Set());
  if (err !== null) return err;
  const chars = canonicalJson(value).length;
  return chars > MAX_EVIDENCE_VALUE_CANONICAL_CHARS
    ? `canonical form ${chars} chars exceeds ${MAX_EVIDENCE_VALUE_CANONICAL_CHARS}`
    : null;
}

// ---- validation helpers ---------------------------------------------------
const isTs = (v) => Number.isSafeInteger(v) && v > 0; // epoch milliseconds
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBoundedString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// ---- packet validator -----------------------------------------------------
// Pure, fail-closed, non-mutating, and NEVER throwing on hostile input.
// Returns { valid, reasons } — reasons is a bounded list of bounded
// strings. Order of operations: schema version → structural JSON safety →
// aggregate canonical size → closed keys → bounds → clocks/semantics →
// refs → member semantic identities → packet semantic identity. A
// recomputed packetId never legitimizes malformed nested truth, because it
// is only checked once everything beneath it is valid.
export function validateEvidencePacket(packet) {
  try {
    return validatePacketInner(packet);
  } catch (err) {
    return { valid: false, reasons: [boundedReason(`packet: rejected hostile input (${err?.name ?? 'error'})`)] };
  }
}

function validatePacketInner(packet) {
  const reasons = [];
  const fail = (msg) => {
    if (reasons.length < MAX_REASONS) reasons.push(boundedReason(msg));
  };
  const done = () => ({ valid: reasons.length === 0, reasons });

  if (!isPlainObject(packet)) {
    fail('packet: not an object');
    return done();
  }
  if (packet.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    // Unknown or incompatible schema versions fail closed — a consumer must
    // never guess at semantics it was not built for.
    fail(`packet: unsupported schemaVersion ${JSON.stringify(packet.schemaVersion)}`);
    return done();
  }
  // structural JSON safety before ANY hashing or deep semantics
  const shapeErr = jsonShapeError(packet, 'packet');
  if (shapeErr !== null) {
    fail(shapeErr);
    return done();
  }
  // aggregate canonical size cap — before accepting semantic identity
  const canonicalChars = canonicalJson(packet).length;
  if (canonicalChars > MAX_PACKET_CANONICAL_CHARS) {
    fail(`packet: canonical form ${canonicalChars} chars exceeds ${MAX_PACKET_CANONICAL_CHARS}`);
    return done();
  }

  // closed schema — undeclared keys at any layer fail
  const checkKeys = (obj, layer, tag) => {
    for (const k of Object.keys(obj)) if (!KEY_SETS[layer].has(k)) fail(`${tag}: undeclared field '${k}' — the contract is closed`);
  };
  checkKeys(packet, 'packet', 'packet');

  if (!isTs(packet.asOfTs)) fail('packet: asOfTs must be a positive epoch-ms integer');
  const asOf = packet.asOfTs;
  // knownAtTs <= asOfTs is THE point-in-time law; every clock below is held
  // to it. Reject, never clamp.
  const inTime = (ts, label) => {
    if (!isTs(ts)) return fail(`${label}: must be a positive epoch-ms integer`);
    if (isTs(asOf) && ts > asOf) fail(`${label}: ${ts} is after packet asOfTs ${asOf} — future knowledge rejected`);
  };

  // subject — canonical identity anchored, provider-independent
  if (!isPlainObject(packet.subject)) fail('subject: missing');
  else {
    checkKeys(packet.subject, 'subject', 'subject');
    if (typeof packet.subject.canonicalCoin !== 'string' || !COIN_RE.test(packet.subject.canonicalCoin))
      fail(`subject: invalid canonicalCoin ${JSON.stringify(packet.subject.canonicalCoin)}`);
    if (packet.subject.providerSymbols !== undefined && packet.subject.providerSymbols !== null) {
      if (!isPlainObject(packet.subject.providerSymbols)) fail('subject: providerSymbols must be an object');
      else
        for (const [prov, sym] of Object.entries(packet.subject.providerSymbols))
          if (!isBoundedString(prov, MAX_ID_CHARS) || !isBoundedString(sym, MAX_ID_CHARS))
            fail(`subject: invalid provider mapping ${prov}`);
    }
  }

  // trigger — why the packet was assembled
  if (!isPlainObject(packet.trigger)) fail('trigger: missing');
  else {
    checkKeys(packet.trigger, 'trigger', 'trigger');
    if (!TRIGGER_KINDS.includes(packet.trigger.kind)) fail(`trigger: unknown kind ${JSON.stringify(packet.trigger.kind)}`);
    if (packet.trigger.sourceEventId !== null && !isBoundedString(packet.trigger.sourceEventId, MAX_ID_CHARS))
      fail('trigger: sourceEventId must be null or a bounded string');
    if (packet.trigger.observedTs !== null) inTime(packet.trigger.observedTs, 'trigger.observedTs');
  }

  // arrays present and bounded
  const arrays = [
    ['claims', MAX_CLAIMS],
    ['sources', MAX_SOURCES],
    ['evidence', MAX_EVIDENCE],
    ['claimLinks', MAX_CLAIM_LINKS],
    ['providerCoverage', MAX_PROVIDER_COVERAGE],
    ['contradictions', MAX_CONTRADICTIONS],
    ['missingEvidence', MAX_MISSING_EVIDENCE],
    ['analogs', MAX_ANALOGS],
  ];
  for (const [key, max] of arrays) {
    if (!Array.isArray(packet[key])) fail(`${key}: must be an array`);
    else if (packet[key].length > max) fail(`${key}: ${packet[key].length} exceeds bound ${max}`);
  }
  const arr = (key) => (Array.isArray(packet[key]) ? packet[key] : []);

  // nested reference sets: bounded, and duplicates are invalid multiplicity
  const refSetCheck = (refs, label) => {
    if (!Array.isArray(refs)) return fail(`${label}: must be an array`);
    if (refs.length > MAX_REFS_PER_ITEM) fail(`${label}: ${refs.length} refs exceeds bound ${MAX_REFS_PER_ITEM}`);
    if (new Set(refs).size !== refs.length) fail(`${label}: duplicate refs in an unordered set`);
  };
  // set collections: identical canonical members are invalid, never deduped
  const dupSetCheck = (key) => {
    const seenMembers = new Set();
    for (const m of arr(key)) {
      if (!isPlainObject(m)) continue;
      const canon = canonicalJson(normalizeRefSets(m));
      if (seenMembers.has(canon)) fail(`${key}: duplicate set member — multiplicity is not meaning`);
      else seenMembers.add(canon);
    }
  };

  // claims — assertions by sources, never facts.
  // MEMBER IDENTITIES ARE RECOMPUTED, NOT TRUSTED: a correctly shaped but
  // forged id fails, and references may only resolve against members whose
  // identity proved its own content.
  const claimIds = new Set();
  for (const c of arr('claims')) {
    if (!isPlainObject(c)) {
      fail('claim: not an object');
      continue;
    }
    const tag = `claim ${String(c.claimId).slice(0, 24)}`;
    checkKeys(c, 'claim', tag);
    if (typeof c.claimId !== 'string' || !ID_RES.claimId.test(c.claimId)) fail(`${tag}: invalid claimId`);
    else if (claimIdentity(c) !== c.claimId) fail(`${tag}: claimId is not the semantic hash of this claim — forged identity`);
    else if (claimIds.has(c.claimId)) fail(`${tag}: duplicate claimId`);
    else claimIds.add(c.claimId);
    if (!isBoundedString(c.claimType, MAX_ID_CHARS)) fail(`${tag}: claimType required`);
    if (!isBoundedString(c.normalizedSubject, MAX_ID_CHARS)) fail(`${tag}: normalizedSubject required`);
    if (!isBoundedString(c.claimText, MAX_TEXT_CHARS)) fail(`${tag}: claimText must be a bounded non-empty string`);
    inTime(c.firstObservedTs, `${tag}: firstObservedTs`);
    if (!CLAIM_STATUSES.includes(c.status)) fail(`${tag}: unknown status ${JSON.stringify(c.status)}`);
  }

  // sources — provenance for everything heard
  const sourceIds = new Set();
  let rawChars = 0;
  for (const s of arr('sources')) {
    if (!isPlainObject(s)) {
      fail('source: not an object');
      continue;
    }
    const tag = `source ${String(s.sourceId).slice(0, 24)}`;
    checkKeys(s, 'source', tag);
    if (typeof s.sourceId !== 'string' || !ID_RES.sourceId.test(s.sourceId)) fail(`${tag}: invalid sourceId`);
    else if (sourceIdentity(s) !== s.sourceId) fail(`${tag}: sourceId is not the semantic hash of this source — forged identity`);
    else if (sourceIds.has(s.sourceId)) fail(`${tag}: duplicate sourceId`);
    else sourceIds.add(s.sourceId);
    if (!isBoundedString(s.provider, MAX_ID_CHARS)) fail(`${tag}: provider required`);
    if (!SOURCE_TYPES.includes(s.sourceType)) fail(`${tag}: unknown sourceType ${JSON.stringify(s.sourceType)}`);
    if (!AUTHORITY_CLASSES.includes(s.authorityClass)) fail(`${tag}: unknown authorityClass`);
    if (s.publishedTs !== null) inTime(s.publishedTs, `${tag}: publishedTs`); // null = publication clock genuinely unknown
    inTime(s.retrievedTs, `${tag}: retrievedTs`);
    // causal clock coherence: a source cannot be retrieved before it was
    // published — when the publication clock is known at all
    if (isTs(s.publishedTs) && isTs(s.retrievedTs) && s.publishedTs > s.retrievedTs)
      fail(`${tag}: publishedTs ${s.publishedTs} after retrievedTs ${s.retrievedTs} — causally impossible`);
    if (s.locator !== null && !isBoundedString(s.locator, MAX_ID_CHARS)) fail(`${tag}: locator must be null or bounded string`);
    if (s.excerpt === undefined) fail(`${tag}: excerpt must be explicitly null when absent`);
    else if (s.excerpt !== null) {
      // Raw external text is hostile DATA, never instruction. It must be
      // explicitly flagged untrusted, tightly bounded, and content-hashed.
      const e = s.excerpt;
      if (!isPlainObject(e)) fail(`${tag}: excerpt must be null or an object`);
      else {
        checkKeys(e, 'excerpt', `${tag}: excerpt`);
        if (typeof e.text !== 'string' || e.text.length === 0) fail(`${tag}: excerpt.text must be a non-empty string`);
        else if (e.text.length > MAX_EXCERPT_CHARS) fail(`${tag}: excerpt ${e.text.length} chars exceeds ${MAX_EXCERPT_CHARS}`);
        else rawChars += e.text.length;
        if (e.untrusted !== true) fail(`${tag}: excerpt.untrusted must be literally true`);
        if (typeof e.text === 'string' && e.contentHash !== contentHash(e.text)) fail(`${tag}: excerpt.contentHash mismatch`);
      }
    }
  }
  if (rawChars > MAX_PACKET_RAW_CHARS) fail(`sources: total raw excerpt ${rawChars} chars exceeds ${MAX_PACKET_RAW_CHARS}`);

  // evidence — facts and derived sensor metrics with provenance
  const evidenceIds = new Set();
  for (const ev of arr('evidence')) {
    if (!isPlainObject(ev)) {
      fail('evidence: not an object');
      continue;
    }
    const tag = `evidence ${String(ev.evidenceId).slice(0, 24)}`;
    checkKeys(ev, 'evidence', tag);
    if (typeof ev.evidenceId !== 'string' || !ID_RES.evidenceId.test(ev.evidenceId)) fail(`${tag}: invalid evidenceId`);
    else if (evidenceIdentity(ev) !== ev.evidenceId)
      fail(`${tag}: evidenceId is not the semantic hash of this evidence — forged identity`);
    else if (evidenceIds.has(ev.evidenceId)) fail(`${tag}: duplicate evidenceId`);
    else evidenceIds.add(ev.evidenceId);
    if (!EVIDENCE_SENSES.includes(ev.sense)) fail(`${tag}: unknown sense ${JSON.stringify(ev.sense)}`);
    if (!isBoundedString(ev.kind, MAX_ID_CHARS)) fail(`${tag}: kind required`);
    if (!EVIDENCE_STATES.includes(ev.state)) fail(`${tag}: unknown state ${JSON.stringify(ev.state)}`);
    inTime(ev.knownAtTs, `${tag}: knownAtTs`);
    if (ev.observedTs !== null) inTime(ev.observedTs, `${tag}: observedTs`);
    // causal clock coherence: an observation cannot become known before it
    // was observed
    if (isTs(ev.observedTs) && isTs(ev.knownAtTs) && ev.observedTs > ev.knownAtTs)
      fail(`${tag}: observedTs ${ev.observedTs} after knownAtTs ${ev.knownAtTs} — causally impossible`);
    if (ev.state === 'MISSING' || ev.state === 'UNAVAILABLE') {
      // UNKNOWN REMAINS UNKNOWN: an unheard value has no number, not zero.
      if (ev.value !== null) fail(`${tag}: state ${ev.state} requires value null — never a coerced number`);
    } else if (ev.value === undefined) fail(`${tag}: value must be present (null only for MISSING/UNAVAILABLE)`);
    else if (ev.value !== null) {
      const valueErr = evidenceValueError(ev.value);
      if (valueErr !== null) fail(`${tag}: value ${valueErr}`);
    }
    if (ev.state === 'STALE' && ev.observedTs === null) fail(`${tag}: STALE evidence must say when it was actually observed`);
    if (!isBoundedString(ev.provenance, MAX_ID_CHARS)) fail(`${tag}: provenance identity required`);
    refSetCheck(ev.sourceRefs, `${tag}: sourceRefs`);
    refSetCheck(ev.claimRefs, `${tag}: claimRefs`);
    for (const ref of Array.isArray(ev.sourceRefs) ? ev.sourceRefs : [])
      if (!sourceIds.has(ref)) fail(`${tag}: dangling sourceRef ${String(ref).slice(0, 48)}`);
    for (const ref of Array.isArray(ev.claimRefs) ? ev.claimRefs : [])
      if (!claimIds.has(ref)) fail(`${tag}: dangling claimRef ${String(ref).slice(0, 48)}`);
  }

  // claim links — explicit claim/source relations; echoes stay echoes.
  // 0B corroboration law: ONE SOURCE CANNOT CORROBORATE ITSELF. An
  // independenceGroup is a provenance label, never a multiplier — so a
  // given claim+source pair may carry AT MOST ONE non-ECHO support
  // relation (ORIGIN or INDEPENDENT_SUPPORT), and a second one rejects
  // the packet outright, never a silent collapse. Other relation kinds
  // (ECHO, PRIMARY_CONFIRMATION, CONTRADICTION, RETRACTION) keep their
  // own independent semantics on the same pair.
  dupSetCheck('claimLinks');
  const supportGroupsByClaim = new Map(); // claimId -> distinct independence groups of qualifying support
  const supportSourcesByClaim = new Map(); // claimId -> distinct source identities of qualifying support
  const supportPairs = new Set(); // claimRef|sourceRef pairs already carrying non-ECHO support
  const primaryByClaim = new Map(); // claimId -> has OFFICIAL primary confirmation
  const kindsByClaim = new Map(); // claimId -> Set of link kinds bound to it
  for (const l of arr('claimLinks')) {
    if (!isPlainObject(l)) {
      fail('claimLink: not an object');
      continue;
    }
    const tag = `claimLink ${String(l.claimRef).slice(0, 24)}/${String(l.sourceRef).slice(0, 24)}`;
    checkKeys(l, 'claimLink', tag);
    if (!claimIds.has(l.claimRef)) fail(`${tag}: relation names a nonexistent claim`);
    if (!sourceIds.has(l.sourceRef)) fail(`${tag}: relation names a nonexistent source`);
    if (!CLAIM_LINK_KINDS.includes(l.kind)) fail(`${tag}: unknown kind ${JSON.stringify(l.kind)}`);
    if (l.independenceGroup !== null && !isBoundedString(l.independenceGroup, MAX_ID_CHARS))
      fail(`${tag}: independenceGroup must be null or a bounded string`);
    if (l.observedTs !== null) inTime(l.observedTs, `${tag}: observedTs`);
    if (claimIds.has(l.claimRef) && sourceIds.has(l.sourceRef)) {
      if (!kindsByClaim.has(l.claimRef)) kindsByClaim.set(l.claimRef, new Set());
      kindsByClaim.get(l.claimRef).add(l.kind);
      if (l.kind === 'ORIGIN' || l.kind === 'INDEPENDENT_SUPPORT') {
        const pair = `${l.claimRef}|${l.sourceRef}`;
        if (supportPairs.has(pair))
          fail(`${tag}: at most one non-ECHO support relation per claim+source — one source is one source`);
        else supportPairs.add(pair);
        // qualifying support = non-ECHO support with a known provenance
        // group; it contributes ONE source identity and ONE group
        if (typeof l.independenceGroup === 'string') {
          if (!supportGroupsByClaim.has(l.claimRef)) supportGroupsByClaim.set(l.claimRef, new Set());
          supportGroupsByClaim.get(l.claimRef).add(l.independenceGroup);
          if (!supportSourcesByClaim.has(l.claimRef)) supportSourcesByClaim.set(l.claimRef, new Set());
          supportSourcesByClaim.get(l.claimRef).add(l.sourceRef);
        }
      }
      if (l.kind === 'PRIMARY_CONFIRMATION') {
        // separate semantics — a primary confirmation never counts as
        // ordinary independent corroboration
        const src = arr('sources').find((s) => isPlainObject(s) && s.sourceId === l.sourceRef);
        if (src && src.authorityClass === 'OFFICIAL') primaryByClaim.set(l.claimRef, true);
      }
    }
  }
  // Status is a conclusion that needs structure, never the other way
  // around: CORROBORATED needs genuinely independent support — at least
  // TWO distinct source identities AND two distinct provenance groups
  // (0B) — PRIMARY_CONFIRMED needs an official confirmation, and RETRACTED
  // and CONTRADICTED need the relation that proves them. A producer may
  // stay conservative, but may not assert the stronger status without
  // proof.
  for (const c of arr('claims')) {
    if (!isPlainObject(c) || !claimIds.has(c.claimId)) continue;
    const tag = `claim ${String(c.claimId).slice(0, 24)}`;
    const kinds = kindsByClaim.get(c.claimId) ?? new Set();
    if (
      c.status === 'CORROBORATED' &&
      ((supportSourcesByClaim.get(c.claimId)?.size ?? 0) < 2 || (supportGroupsByClaim.get(c.claimId)?.size ?? 0) < 2)
    )
      fail(`${tag}: CORROBORATED requires non-ECHO support from >=2 distinct sources AND >=2 distinct independenceGroups`);
    if (c.status === 'PRIMARY_CONFIRMED' && !primaryByClaim.get(c.claimId))
      fail(`${tag}: PRIMARY_CONFIRMED requires a PRIMARY_CONFIRMATION link from an OFFICIAL source`);
    if (c.status === 'RETRACTED' && !kinds.has('RETRACTION'))
      fail(`${tag}: RETRACTED requires at least one RETRACTION relation for this claim`);
    if (c.status === 'CONTRADICTED' && !kinds.has('CONTRADICTION'))
      fail(`${tag}: CONTRADICTED requires at least one CONTRADICTION relation for this claim`);
  }

  // provider coverage — what Serpent did NOT hear, said honestly
  const coveredProviders = new Set();
  for (const pc of arr('providerCoverage')) {
    if (!isPlainObject(pc)) {
      fail('providerCoverage: not an object');
      continue;
    }
    const tag = `coverage ${String(pc.provider).slice(0, 24)}`;
    checkKeys(pc, 'providerCoverage', tag);
    if (!isBoundedString(pc.provider, MAX_ID_CHARS)) fail(`${tag}: provider required`);
    else if (coveredProviders.has(pc.provider)) fail(`${tag}: duplicate provider coverage entry`);
    else coveredProviders.add(pc.provider);
    if (!PROVIDER_COVERAGE_STATES.includes(pc.state)) fail(`${tag}: unknown state ${JSON.stringify(pc.state)}`);
    // NOT_QUERIED means no query happened, so it cannot carry a check clock;
    // every other state describes an actual attempt and must say when.
    if (pc.state === 'NOT_QUERIED') {
      if (pc.checkedTs !== null) fail(`${tag}: NOT_QUERIED must carry checkedTs null — no query happened`);
    } else inTime(pc.checkedTs, `${tag}: checkedTs`);
    if (pc.detail !== null && !isBoundedString(pc.detail, MAX_TEXT_CHARS)) fail(`${tag}: detail must be null or bounded`);
  }

  // contradictions — deterministic, and pinned to exact references
  dupSetCheck('contradictions');
  for (const cd of arr('contradictions')) {
    if (!isPlainObject(cd)) {
      fail('contradiction: not an object');
      continue;
    }
    const tag = 'contradiction';
    checkKeys(cd, 'contradiction', tag);
    if (!isBoundedString(cd.description, MAX_TEXT_CHARS)) fail(`${tag}: description required`);
    refSetCheck(cd.claimRefs, `${tag}: claimRefs`);
    refSetCheck(cd.sourceRefs, `${tag}: sourceRefs`);
    refSetCheck(cd.evidenceRefs, `${tag}: evidenceRefs`);
    const refs = [];
    for (const ref of Array.isArray(cd.claimRefs) ? cd.claimRefs : []) {
      if (!claimIds.has(ref)) fail(`${tag}: dangling claimRef ${String(ref).slice(0, 48)}`);
      refs.push(ref);
    }
    for (const ref of Array.isArray(cd.sourceRefs) ? cd.sourceRefs : []) {
      if (!sourceIds.has(ref)) fail(`${tag}: dangling sourceRef ${String(ref).slice(0, 48)}`);
      refs.push(ref);
    }
    for (const ref of Array.isArray(cd.evidenceRefs) ? cd.evidenceRefs : []) {
      if (!evidenceIds.has(ref)) fail(`${tag}: dangling evidenceRef ${String(ref).slice(0, 48)}`);
      refs.push(ref);
    }
    if (refs.length < 2) fail(`${tag}: must point at >=2 exact references — free text alone creates no contradiction`);
  }

  // missing evidence — known unknowns as input facts, not guesses
  dupSetCheck('missingEvidence');
  for (const m of arr('missingEvidence')) {
    if (!isPlainObject(m)) {
      fail('missingEvidence: not an object');
      continue;
    }
    checkKeys(m, 'missingEvidence', 'missingEvidence');
    if (!isBoundedString(m.kind, MAX_ID_CHARS)) fail('missingEvidence: kind required');
    if (!isBoundedString(m.description, MAX_TEXT_CHARS)) fail('missingEvidence: description required');
  }

  // analogs — historical rhymes with NO future leakage
  dupSetCheck('analogs');
  for (const a of arr('analogs')) {
    if (!isPlainObject(a)) {
      fail('analog: not an object');
      continue;
    }
    const tag = `analog ${String(a.memoryId).slice(0, 24)}`;
    checkKeys(a, 'analog', tag);
    if (!isBoundedString(a.memoryId, MAX_ID_CHARS)) fail(`${tag}: memoryId required`);
    if (!isBoundedString(a.setupFamily, MAX_ID_CHARS)) fail(`${tag}: setupFamily required`);
    if (!isBoundedString(a.similarityBasis, MAX_TEXT_CHARS)) fail(`${tag}: similarityBasis required`);
    inTime(a.knownAtTs, `${tag}: knownAtTs`);
    if (a.outcome !== null) {
      if (!isPlainObject(a.outcome)) fail(`${tag}: outcome must be null or an object`);
      else {
        checkKeys(a.outcome, 'analogOutcome', `${tag}: outcome`);
        if (!isBoundedString(a.outcome.reference, MAX_ID_CHARS)) fail(`${tag}: outcome.reference required`);
        // The historical outcome itself must have been fully known before
        // asOfTs — an analog whose ending resolved later is future leakage.
        inTime(a.outcome.outcomeKnownAtTs, `${tag}: outcome.outcomeKnownAtTs`);
      }
    }
  }

  // security — the packet says plainly whether hostile text rides inside
  if (!isPlainObject(packet.security)) fail('security: missing');
  else {
    checkKeys(packet.security, 'security', 'security');
    const hasExcerpt = arr('sources').some((s) => isPlainObject(s) && isPlainObject(s.excerpt));
    if (typeof packet.security.untrustedTextPresent !== 'boolean') fail('security: untrustedTextPresent must be boolean');
    else if (packet.security.untrustedTextPresent !== hasExcerpt)
      fail(`security: untrustedTextPresent=${packet.security.untrustedTextPresent} disagrees with actual excerpts`);
  }

  // packetId — semantic identity over everything above, checked LAST so a
  // recomputed hash can never legitimize malformed nested truth
  if (reasons.length === 0) {
    if (typeof packet.packetId !== 'string' || !ID_RES.packetId.test(packet.packetId)) fail('packet: invalid packetId');
    else if (packet.packetId !== packetIdentity(packet)) fail('packet: packetId does not match semantic content');
  }

  return done();
}
