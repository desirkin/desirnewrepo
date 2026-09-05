// SOCRATES-CONTRACT-0 — the neutral evidence language (serpent-evidence-1).
//
// An evidence packet is ONLY what Serpent could legitimately know at one
// point in time (asOfTs). It carries facts, claims, and derived sensor
// metrics with full provenance — never interpretation. Socrates consumes
// packets; collectors produce them. Nothing in the live runtime imports
// this file yet: this ticket defines the language, it wires nothing.
//
// Three principles rule this file:
//   1. POINT-IN-TIME TRUTH — no fact may be known after asOfTs. Violations
//      are rejected, never clamped, never rewritten.
//   2. UNKNOWN REMAINS UNKNOWN — MISSING/UNAVAILABLE evidence carries a
//      null value, never zero; absence of provider coverage is not a
//      negative claim.
//   3. Hard bounds everywhere — every array, every excerpt, every reason
//      string has a cap. Over-bound input fails validation; nothing is
//      silently truncated.
//
// Pure module: no network, no filesystem, no configuration, no model.
// Validators never mutate their input and fail closed.
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

// ---- canonical identity ---------------------------------------------------
// Deterministic serialization: object keys sorted, undefined dropped, no
// whitespace. Two semantically identical packets serialize identically no
// matter what key order or pretty-printing they arrived with.
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

const sortSet = (arr) => [...arr].map((e) => canonicalJson(e)).sort();

// Identity basis: the whole packet except packetId itself, with every
// unordered array replaced by its sorted canonical member list. Key order
// and whitespace never reach the hash; a material value change always does.
export function packetIdentityBasis(packet) {
  const basis = {};
  for (const k of Object.keys(packet)) {
    if (k === 'packetId') continue;
    basis[k] = ARRAY_ORDER_POLICY[k] === 'UNORDERED' && Array.isArray(packet[k]) ? sortSet(packet[k]) : packet[k];
  }
  return basis;
}

export const packetIdentity = (packet) => `sep-${sha1(canonicalJson(packetIdentityBasis(packet)))}`;

// Member identities: semantic hash with a stable prefix, never random UUIDs.
// Each is the hash of the member's stable meaning (its content minus its
// own id), so the same fact always earns the same name.
const memberIdentity = (prefix, obj, idKey) => {
  const basis = {};
  for (const k of Object.keys(obj)) if (k !== idKey) basis[k] = obj[k];
  return `${prefix}-${sha1(canonicalJson(basis))}`;
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

// ---- validation helpers ---------------------------------------------------
const isTs = (v) => Number.isSafeInteger(v) && v > 0; // epoch milliseconds
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBoundedString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// ---- packet validator -----------------------------------------------------
// Pure, fail-closed, non-mutating. Returns { valid, reasons } where reasons
// is a bounded list of bounded strings. It never normalizes invalid truth
// into validity: a bad timestamp is rejected, not clamped; an over-bound
// array is rejected, not trimmed.
export function validateEvidencePacket(packet) {
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

  // claims — assertions by sources, never facts
  const claimIds = new Set();
  for (const c of arr('claims')) {
    if (!isPlainObject(c)) {
      fail('claim: not an object');
      continue;
    }
    const tag = `claim ${String(c.claimId).slice(0, 24)}`;
    if (typeof c.claimId !== 'string' || !ID_RES.claimId.test(c.claimId)) fail(`${tag}: invalid claimId`);
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
    if (typeof s.sourceId !== 'string' || !ID_RES.sourceId.test(s.sourceId)) fail(`${tag}: invalid sourceId`);
    else if (sourceIds.has(s.sourceId)) fail(`${tag}: duplicate sourceId`);
    else sourceIds.add(s.sourceId);
    if (!isBoundedString(s.provider, MAX_ID_CHARS)) fail(`${tag}: provider required`);
    if (!SOURCE_TYPES.includes(s.sourceType)) fail(`${tag}: unknown sourceType ${JSON.stringify(s.sourceType)}`);
    if (!AUTHORITY_CLASSES.includes(s.authorityClass)) fail(`${tag}: unknown authorityClass`);
    if (s.publishedTs !== null) inTime(s.publishedTs, `${tag}: publishedTs`); // null = publication clock genuinely unknown
    inTime(s.retrievedTs, `${tag}: retrievedTs`);
    if (s.locator !== null && !isBoundedString(s.locator, MAX_ID_CHARS)) fail(`${tag}: locator must be null or bounded string`);
    if (s.excerpt === undefined) fail(`${tag}: excerpt must be explicitly null when absent`);
    else if (s.excerpt !== null) {
      // Raw external text is hostile DATA, never instruction. It must be
      // explicitly flagged untrusted, tightly bounded, and content-hashed.
      const e = s.excerpt;
      if (!isPlainObject(e)) fail(`${tag}: excerpt must be null or an object`);
      else {
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
    if (typeof ev.evidenceId !== 'string' || !ID_RES.evidenceId.test(ev.evidenceId)) fail(`${tag}: invalid evidenceId`);
    else if (evidenceIds.has(ev.evidenceId)) fail(`${tag}: duplicate evidenceId`);
    else evidenceIds.add(ev.evidenceId);
    if (!EVIDENCE_SENSES.includes(ev.sense)) fail(`${tag}: unknown sense ${JSON.stringify(ev.sense)}`);
    if (!isBoundedString(ev.kind, MAX_ID_CHARS)) fail(`${tag}: kind required`);
    if (!EVIDENCE_STATES.includes(ev.state)) fail(`${tag}: unknown state ${JSON.stringify(ev.state)}`);
    inTime(ev.knownAtTs, `${tag}: knownAtTs`);
    if (ev.observedTs !== null) inTime(ev.observedTs, `${tag}: observedTs`);
    if (ev.state === 'MISSING' || ev.state === 'UNAVAILABLE') {
      // UNKNOWN REMAINS UNKNOWN: an unheard value has no number, not zero.
      if (ev.value !== null) fail(`${tag}: state ${ev.state} requires value null — never a coerced number`);
    } else if (ev.value === undefined) fail(`${tag}: value must be present (null only for MISSING/UNAVAILABLE)`);
    if (ev.state === 'STALE' && ev.observedTs === null) fail(`${tag}: STALE evidence must say when it was actually observed`);
    if (!isBoundedString(ev.provenance, MAX_ID_CHARS)) fail(`${tag}: provenance identity required`);
    for (const ref of Array.isArray(ev.sourceRefs) ? ev.sourceRefs : (fail(`${tag}: sourceRefs must be an array`), []))
      if (!sourceIds.has(ref)) fail(`${tag}: dangling sourceRef ${String(ref).slice(0, 48)}`);
    for (const ref of Array.isArray(ev.claimRefs) ? ev.claimRefs : (fail(`${tag}: claimRefs must be an array`), []))
      if (!claimIds.has(ref)) fail(`${tag}: dangling claimRef ${String(ref).slice(0, 48)}`);
  }

  // claim links — explicit claim/source relations; echoes stay echoes
  const supportByClaim = new Map(); // claimId -> Set of independence groups with non-echo support
  const primaryByClaim = new Map(); // claimId -> has OFFICIAL primary confirmation
  for (const l of arr('claimLinks')) {
    if (!isPlainObject(l)) {
      fail('claimLink: not an object');
      continue;
    }
    const tag = `claimLink ${String(l.claimRef).slice(0, 24)}/${String(l.sourceRef).slice(0, 24)}`;
    if (!claimIds.has(l.claimRef)) fail(`${tag}: relation names a nonexistent claim`);
    if (!sourceIds.has(l.sourceRef)) fail(`${tag}: relation names a nonexistent source`);
    if (!CLAIM_LINK_KINDS.includes(l.kind)) fail(`${tag}: unknown kind ${JSON.stringify(l.kind)}`);
    if (l.independenceGroup !== null && !isBoundedString(l.independenceGroup, MAX_ID_CHARS))
      fail(`${tag}: independenceGroup must be null or a bounded string`);
    if (l.observedTs !== null) inTime(l.observedTs, `${tag}: observedTs`);
    if (claimIds.has(l.claimRef) && sourceIds.has(l.sourceRef)) {
      if ((l.kind === 'ORIGIN' || l.kind === 'INDEPENDENT_SUPPORT') && typeof l.independenceGroup === 'string') {
        if (!supportByClaim.has(l.claimRef)) supportByClaim.set(l.claimRef, new Set());
        supportByClaim.get(l.claimRef).add(l.independenceGroup);
      }
      if (l.kind === 'PRIMARY_CONFIRMATION') {
        const src = arr('sources').find((s) => s.sourceId === l.sourceRef);
        if (src && src.authorityClass === 'OFFICIAL') primaryByClaim.set(l.claimRef, true);
      }
    }
  }
  // Corroboration is an INDEPENDENCE conclusion, never a source count: a
  // claim may say CORROBORATED only when its links prove support from at
  // least two distinct independence groups (echoes never count), and
  // PRIMARY_CONFIRMED only with an OFFICIAL primary confirmation link.
  for (const c of arr('claims')) {
    if (!isPlainObject(c) || !claimIds.has(c.claimId)) continue;
    const tag = `claim ${String(c.claimId).slice(0, 24)}`;
    if (c.status === 'CORROBORATED' && (supportByClaim.get(c.claimId)?.size ?? 0) < 2)
      fail(`${tag}: CORROBORATED requires non-ECHO support from >=2 distinct independenceGroups`);
    if (c.status === 'PRIMARY_CONFIRMED' && !primaryByClaim.get(c.claimId))
      fail(`${tag}: PRIMARY_CONFIRMED requires a PRIMARY_CONFIRMATION link from an OFFICIAL source`);
  }

  // provider coverage — what Serpent did NOT hear, said honestly
  const coveredProviders = new Set();
  for (const pc of arr('providerCoverage')) {
    if (!isPlainObject(pc)) {
      fail('providerCoverage: not an object');
      continue;
    }
    const tag = `coverage ${String(pc.provider).slice(0, 24)}`;
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
  for (const cd of arr('contradictions')) {
    if (!isPlainObject(cd)) {
      fail('contradiction: not an object');
      continue;
    }
    const tag = 'contradiction';
    if (!isBoundedString(cd.description, MAX_TEXT_CHARS)) fail(`${tag}: description required`);
    const refs = [];
    for (const ref of Array.isArray(cd.claimRefs) ? cd.claimRefs : (fail(`${tag}: claimRefs must be an array`), [])) {
      if (!claimIds.has(ref)) fail(`${tag}: dangling claimRef ${String(ref).slice(0, 48)}`);
      refs.push(ref);
    }
    for (const ref of Array.isArray(cd.sourceRefs) ? cd.sourceRefs : (fail(`${tag}: sourceRefs must be an array`), [])) {
      if (!sourceIds.has(ref)) fail(`${tag}: dangling sourceRef ${String(ref).slice(0, 48)}`);
      refs.push(ref);
    }
    for (const ref of Array.isArray(cd.evidenceRefs) ? cd.evidenceRefs : (fail(`${tag}: evidenceRefs must be an array`), [])) {
      if (!evidenceIds.has(ref)) fail(`${tag}: dangling evidenceRef ${String(ref).slice(0, 48)}`);
      refs.push(ref);
    }
    if (refs.length < 2) fail(`${tag}: must point at >=2 exact references — free text alone creates no contradiction`);
  }

  // missing evidence — known unknowns as input facts, not guesses
  for (const m of arr('missingEvidence')) {
    if (!isPlainObject(m)) {
      fail('missingEvidence: not an object');
      continue;
    }
    if (!isBoundedString(m.kind, MAX_ID_CHARS)) fail('missingEvidence: kind required');
    if (!isBoundedString(m.description, MAX_TEXT_CHARS)) fail('missingEvidence: description required');
  }

  // analogs — historical rhymes with NO future leakage
  for (const a of arr('analogs')) {
    if (!isPlainObject(a)) {
      fail('analog: not an object');
      continue;
    }
    const tag = `analog ${String(a.memoryId).slice(0, 24)}`;
    if (!isBoundedString(a.memoryId, MAX_ID_CHARS)) fail(`${tag}: memoryId required`);
    if (!isBoundedString(a.setupFamily, MAX_ID_CHARS)) fail(`${tag}: setupFamily required`);
    if (!isBoundedString(a.similarityBasis, MAX_TEXT_CHARS)) fail(`${tag}: similarityBasis required`);
    inTime(a.knownAtTs, `${tag}: knownAtTs`);
    if (a.outcome !== null) {
      if (!isPlainObject(a.outcome)) fail(`${tag}: outcome must be null or an object`);
      else {
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
    const hasExcerpt = arr('sources').some((s) => isPlainObject(s) && isPlainObject(s.excerpt));
    if (typeof packet.security.untrustedTextPresent !== 'boolean') fail('security: untrustedTextPresent must be boolean');
    else if (packet.security.untrustedTextPresent !== hasExcerpt)
      fail(`security: untrustedTextPresent=${packet.security.untrustedTextPresent} disagrees with actual excerpts`);
  }

  // packetId — semantic identity over everything above
  if (reasons.length === 0) {
    if (typeof packet.packetId !== 'string' || !ID_RES.packetId.test(packet.packetId)) fail('packet: invalid packetId');
    else if (packet.packetId !== packetIdentity(packet)) fail('packet: packetId does not match semantic content');
  }

  return done();
}
