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
]);

// Reserved for future sensors — coherent names only, nothing implemented.
export const RESERVED_EVIDENCE_FAMILIES = Object.freeze([
  'DERIVATIVES',
  'ON_CHAIN',
  'CAPITAL_FLOW',
  'GOVERNANCE',
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
// periodic observations derive identity from module+symbol+type+time.
export function deterministicId({ sourceModule, symbol, eventType, ts, sourceEventId = null }) {
  const basis = `${sourceModule}|${symbol ?? 'NONE'}|${eventType}|${sourceEventId ?? ts}`;
  return `mem-${createHash('sha1').update(basis).digest('hex')}`;
}

// Envelope skeleton helper used by adapters: fills the invariant fields so
// every sense speaks the same dialect. `families` may be one family or a
// small coherent set (still ONE source observation, not N confirmations).
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
}) {
  const nowMs = Date.now();
  return {
    id: deterministicId({ sourceModule, symbol, eventType, ts, sourceEventId }),
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
