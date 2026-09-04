// MEMORY-0 — the canonical live memory contract (doctrine/MEMORY.md).
// One language for every sense: what was observed, when it was knowable,
// where it came from, what asset it concerns, what kind of evidence it is,
// and whether it is KNOWN, UNKNOWN, or UNAVAILABLE. The nervous system
// carries signals; it does not decide what they mean.
import { createHash } from 'node:crypto';

export const MEMORY_SCHEMA_VERSION = 'serpent-memory-1';
export const MEMORY_VERSION = 'MEMORY-0';

// Documented source-module enum — no arbitrary spellings. The future
// entries reserve names only; no future sensor is implemented in MEMORY-0.
export const SOURCE_MODULES = Object.freeze([
  'TAPE',
  'WIDEEYE',
  'RUMINT',
  'GATEWAY',
  'COST',
  'STATE',
  'CHILDHOOD',
  // reserved for future senses (names only):
  'MICROSTRUCTURE',
  'GOVERNANCE',
  'GHOST',
  'INFRASTRUCTURE',
  'FLOW',
  'PHILOSOPHER',
]);

// Controlled evidence-family taxonomy. Multiple fields from one source are
// ONE family — they must never later masquerade as independent
// confirmations merely because they are separate numbers.
export const EVIDENCE_FAMILIES = Object.freeze([
  'MARKET_PRICE',
  'MARKET_VOLUME',
  'ORDER_FLOW',
  'LIQUIDITY',
  'SOCIAL_ATTENTION',
  'RUMOR',
  'EXCHANGE_INFRASTRUCTURE',
  'EXECUTION_QUALITY',
  'STATE_CONTROL',
  'HISTORICAL_CONTEXT',
  // GOV-1: deliberate schema-contract promotion of the reserved GOVERNANCE
  // family — one governance observation carrying several correlated metrics
  // (quorum, margin, concentration, state) is still ONE family, never four
  // independent confirmations.
  'GOVERNANCE',
]);

// Reserved for future sensors — coherent names only, nothing implemented.
export const RESERVED_EVIDENCE_FAMILIES = Object.freeze([
  'DERIVATIVES',
  'ON_CHAIN',
  'CAPITAL_FLOW',
  'EXCHANGE_INTEGRATION',
  'NETWORK_INFRASTRUCTURE',
  'OFFICIAL_NEWS',
  'DEVELOPER_ACTIVITY',
  'BLOCKSPACE',
  'MACRO',
  'EXPERIMENTAL',
]);

// Availability states describe DATA QUALITY, never direction.
// UNKNOWN is not FALSE. MISSING is not NEGATIVE. NEUTRAL is not CONTRADICTORY.
export const AVAILABILITY_STATES = Object.freeze(['KNOWN', 'UNKNOWN', 'UNAVAILABLE', 'STALE', 'DEGRADED']);

// Evidence is data, never instructions: an envelope whose STRUCTURE carries
// trading verbs is refused at the door. (Raw social TEXT may say anything —
// as a string value it is data and is stored verbatim, never interpreted.)
export const FORBIDDEN_INSTRUCTION_KEYS = Object.freeze([
  'executeOrder',
  'placeOrder',
  'orderSide',
  'buy',
  'sell',
  'tradeSize',
  'positionSize',
  'strike',
  'command',
  'instruction',
]);

// Deterministic identity: the same source event survives restarts as ONE
// memory. Where a natural source event id exists it is incorporated;
// otherwise identity comes from a FINGERPRINT of the actual source record
// (MEMORY-0A §1) — never from the whole-second timestamp alone, so two
// different records inside the same second can never collide, while the
// byte-identical record replayed after a restart still deduplicates.
export function deterministicId({ sourceModule, symbol, eventType, ts, sourceEventId = null }) {
  const basis = `${sourceModule}|${symbol ?? 'NONE'}|${eventType}|${sourceEventId ?? ts}`;
  return `mem-${createHash('sha1').update(basis).digest('hex')}`;
}

// Canonical JSON: recursively key-sorted, so logically identical records
// fingerprint identically regardless of key order.
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(',')}}`;
};

// Source-record fingerprint: a stable hash of the ORIGINAL source record
// plus its stream identity. No randomness, no Date.now(), no observation
// time — the same record always fingerprints the same; different records
// never share one merely because they share a second.
export function sourceFingerprint(rec, streamId = '') {
  return createHash('sha1').update(`${streamId}:${canonicalJson(rec)}`).digest('hex');
}

// Envelope skeleton helper used by adapters: fills the invariant fields so
// every sense speaks the same dialect. `families` may be one family or a
// small coherent set (still ONE source observation, not N confirmations).
// `sourceEventId` is a NATURAL upstream id (kept in correlation);
// `identity` is a derived source-record fingerprint used for id derivation
// only — it is our computation, not the upstream's identity, so it never
// masquerades as a sourceEventId.
export function envelope({
  sourceModule,
  eventType,
  ts,
  symbol = null,
  families,
  observationState,
  payload,
  dataAvailability,
  provenance,
  correlation = {},
  lifecycle = {},
  sourceEventId = null,
  identity = null,
}) {
  const nowMs = Date.now();
  return {
    id: deterministicId({ sourceModule, symbol, eventType, ts, sourceEventId: sourceEventId ?? identity }),
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ts,
    symbol,
    sourceModule,
    eventType,
    evidenceFamily: Array.isArray(families) ? families : [families],
    observationState,
    payload,
    dataAvailability,
    provenance,
    correlation: {
      eventId: correlation.eventId ?? null,
      parentEventId: correlation.parentEventId ?? null,
      sourceEventId: correlation.sourceEventId ?? sourceEventId,
      clusterId: correlation.clusterId ?? null,
    },
    lifecycle: {
      createdTs: lifecycle.createdTs ?? nowMs,
      lastUpdatedTs: lifecycle.lastUpdatedTs ?? nowMs,
      expiresTs: lifecycle.expiresTs ?? null, // no invented TTLs — signal half-lives are a later ticket
      ttlSec: lifecycle.ttlSec ?? null,
      supersedesId: lifecycle.supersedesId ?? null,
    },
  };
}
