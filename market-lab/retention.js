// MARKET LAB — bounded retention of the owner's in-memory observation / coverage prefix (closeout R05). Every retained
// collection has a declared bound; eviction is deterministic (oldest first, by recording ordinal), counted, and carries an
// EVICTED coverage record for the evicted scope so an interval never looks complete again. A running membership chain
// (sha256 over the ordered observation ids) lets an offline reopen prove that a case's prefix is exactly the recorded
// ordering, without hashing a mutable array at case time. Small aggregate counters live apart from the retained rows.
import { createHash } from 'node:crypto';
import { deepFreeze, makeCoverage, subjectId } from './contracts.js';

export const RETENTION_VERSION = 'market-retention-1';
export function createRetainedStore({ limits, clock = () => Date.now() }) {
  const obsCap = limits.retainedObservations; const covCap = limits.retainedCoverage;
  const observations = []; const coverage = []; let ordinal = 0; let firstOrdinal = 1; let chain = createHash('sha256').update('market-retention-1').digest('hex');
  const counters = { observations: 0, coverage: 0, evictedObservations: 0, evictedCoverage: 0, evictionBatches: 0 };
  const evictedIds = new Map(); // observationId -> ordinal of evicted rows (bounded: cleared per batch summary)
  // eviction of the oldest observations: one EVICTED coverage record per (provider, endpoint, subject, kind) scope of the batch
  function evictObservations(n) {
    const batch = observations.splice(0, n); counters.evictedObservations += batch.length; counters.evictionBatches += 1; firstOrdinal += batch.length;
    const scopes = new Map();
    for (const o of batch) { const sid = subjectId(o.subject); const key = `${o.provider}|${o.endpointId}|${sid}|${o.kind}`; const s = scopes.get(key) ?? { provider: o.provider, endpointId: o.endpointId, subjectId: sid, kind: o.kind, family: null, startTs: o.receivedTs, endTs: o.receivedTs, count: 0 }; s.startTs = Math.min(s.startTs, o.receivedTs); s.endTs = Math.max(s.endTs, o.receivedTs); s.count += 1; scopes.set(key, s); }
    const out = [];
    for (const s of scopes.values()) { const family = familyOfKind(s.kind); if (!family) continue; try { out.push(makeCoverage({ provider: s.provider, endpointId: s.endpointId, subjectId: s.subjectId, family, kind: s.kind, state: 'EVICTED', reasonCodes: ['RESOURCE_EVICTED'], startTs: s.startTs, endTs: s.endTs, observationCount: 0, droppedCount: s.count, epochId: null, sequenceStart: null, sequenceEnd: null })); } catch { /* an unrepresentable scope still counts */ } }
    return out;
  }
  // coverage overflow: the oldest record is replaced by one merged COVERAGE_OVERFLOW marker per scope (bounded by scopes)
  const overflow = new Map();
  function evictCoverage(n) {
    const batch = coverage.splice(0, n); counters.evictedCoverage += batch.length;
    for (const c of batch) { const key = `${c.provider}|${c.subjectId}|${c.kind}|${c.family}`; const m = overflow.get(key); if (m) { m.startTs = Math.min(m.startTs, c.startTs); m.endTs = Math.max(m.endTs ?? c.startTs, c.endTs ?? c.startTs); m.count += 1; } else overflow.set(key, { provider: c.provider, endpointId: c.endpointId, subjectId: c.subjectId, kind: c.kind, family: c.family, startTs: c.startTs, endTs: c.endTs ?? c.startTs, count: 1 }); }
    if (overflow.size > 4096) { const oldest = overflow.keys().next().value; overflow.delete(oldest); }
  }
  return {
    // push one observation: returns the coverage records produced by an eviction (caller records them)
    push(o) { ordinal += 1; observations.push(o); counters.observations += 1; chain = createHash('sha256').update(chain).update(o.observationId).digest('hex'); return observations.length > obsCap ? evictObservations(observations.length - obsCap) : []; },
    pushCoverage(c) { coverage.push(c); counters.coverage += 1; if (coverage.length > covCap) evictCoverage(coverage.length - covCap); },
    observations: () => observations.slice(),
    coverage: () => [...coverage, ...[...overflow.values()].map((m) => { try { return makeCoverage({ provider: m.provider, endpointId: m.endpointId, subjectId: m.subjectId, family: m.family, kind: m.kind, state: 'GAP', reasonCodes: ['COVERAGE_OVERFLOW'], startTs: m.startTs, endTs: m.endTs, observationCount: 0, droppedCount: m.count, epochId: null, sequenceStart: null, sequenceEnd: null }); } catch { return null; } }).filter(Boolean)],
    has: (o) => observations.includes(o),
    membership: () => deepFreeze({ retentionVersion: RETENTION_VERSION, chainSha256: chain, firstOrdinal, lastOrdinal: ordinal, retained: observations.length, evicted: counters.evictedObservations, coverageRetained: coverage.length, coverageEvicted: counters.evictedCoverage, overflowScopes: overflow.size }),
    counters: () => ({ ...counters, retainedObservations: observations.length, retainedCoverage: coverage.length }),
    ordinal: () => ordinal,
  };
}
// recompute the membership chain from an ordered replay of observation ids (offline verification of a prefix)
export function membershipChain(ids) { let chain = createHash('sha256').update('market-retention-1').digest('hex'); for (const id of ids) chain = createHash('sha256').update(chain).update(id).digest('hex'); return chain; }
const KIND_FAMILY = { TRADE: 'SPOT_FLOW', BOOK_SNAPSHOT: 'DISPLAYED_LIQUIDITY', BOOK_COVERAGE: 'DISPLAYED_LIQUIDITY', CANDLE: 'SPOT_PRICE_CHART', INSTRUMENT: 'DERIVATIVES_FUNDING_OI', DERIVATIVE_TICK: 'DERIVATIVES_FUNDING_OI', LIQUIDATION: 'LIQUIDATIONS', OPTION_TICK: 'OPTIONS_TERM_SKEW', ASSET_REFERENCE: 'SUPPLY_UNLOCKS', UNLOCK_EVENT: 'SUPPLY_UNLOCKS', DEX_POOL: 'DEX_DEFI', DEFI_METRIC: 'DEX_DEFI', ONCHAIN_METRIC: 'ONCHAIN_ENTITY_FLOW', STABLECOIN_METRIC: 'STABLECOIN_LIQUIDITY', ETF_FLOW: 'ETF_FLOWS', MACRO_OBSERVATION: 'MACRO_RELEASES', ECONOMIC_EVENT: 'MACRO_RELEASES', CROSS_ASSET_BAR: 'CROSS_ASSET', EVENT_REFERENCE: 'OFFICIAL_SOCIAL_EVENTS', PROVIDER_STATUS: 'INFRASTRUCTURE_STATUS' };
export const familyOfKind = (kind) => KIND_FAMILY[kind] ?? null;
