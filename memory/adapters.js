// MEMORY-0 adapters. THIN, PURE, ONE-WAY: each takes a record an existing
// sensor ALREADY writes (its JSONL event stream) and returns a canonical
// envelope. No sensor is modified, imported, or called; inputs are never
// mutated; nothing flows back. Names carry no direction the source did not
// establish — an abnormal co-fire is an abnormal co-fire, never a prophecy.
import { nowIso } from '../lib/time.js';
import { envelope, sourceFingerprint } from './schema.js';

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
// canonicalize or refuse — a coin association is never invented (schema §symbol)
const strip = (rec, ...keys) => {
  const o = { ...rec };
  for (const k of keys) delete o[k];
  return o;
};
const canonSymbol = (s) => {
  if (typeof s !== 'string') return null;
  const c = s.toUpperCase().replace(/\.X$/, '');
  return SYMBOL_RE.test(c) ? c : null;
};

const liveProv = (source, recordTs, observedTs) => ({
  source,
  sourceTs: recordTs,
  availableTs: recordTs, // our own module wrote it: knowable at write time
  retrievedTs: observedTs,
  kind: 'live',
  form: 'raw',
});

// ---------------------------------------------------------------------
// A. WIDE EYE — survey/events.jsonl lines. One coherent observation per
// event: zVol and zRet are two fields of ONE market observation, spanning
// the MARKET_PRICE and MARKET_VOLUME families — never two confirmations.
// ---------------------------------------------------------------------
export function fromWideeyeEvent(rec, observedTs = nowIso()) {
  const signal = rec.type === 'RIPPLE' || rec.type === 'MISSED';
  const symbol = canonSymbol(rec.symbol);
  return envelope({
    sourceModule: 'WIDEEYE',
    eventType: signal ? `WIDEEYE_${rec.type}` : rec.type === 'SWEEP_ERROR' ? 'WIDEEYE_SWEEP_ERROR' : 'WIDEEYE_STATUS',
    ts: sec(rec.ts),
    symbol,
    families: signal ? ['MARKET_PRICE', 'MARKET_VOLUME'] : ['MARKET_PRICE'],
    observationState: rec.type === 'SWEEP_ERROR' ? 'DEGRADED' : 'KNOWN',
    payload: signal
      ? {
          verdict: rec.verdict,
          zVol: rec.zVol,
          zRet: rec.zRet,
          extensionPct: rec.extension,
          liquidityNote: rec.liquidityNote ?? null,
          inDeepTape: rec.inDeepTape ?? null,
        }
      : { type: rec.type, detail: strip(rec, 'ts') },
    dataAvailability: { zVol: rec.zVol !== undefined ? 'KNOWN' : 'UNAVAILABLE', zRet: rec.zRet !== undefined ? 'KNOWN' : 'UNAVAILABLE' },
    provenance: liveProv('survey/events.jsonl (live wide eye)', rec.ts, observedTs),
    identity: sourceFingerprint(rec, 'survey/events.jsonl'),
  });
}

// ---------------------------------------------------------------------
// B. RUMINT — rumint/events.jsonl lines. RUMOR/SOCIAL_ATTENTION evidence,
// truthfully: a failed poll is UNAVAILABLE data, not bearish=false. No
// rumor-propagation graph is inferred — the module does not know one.
// ---------------------------------------------------------------------
export function fromRumintEvent(rec, observedTs = nowIso()) {
  const failed = rec.type === 'RUMINT_POLL_FAILED' || rec.type === 'RUMINT_UNAVAILABLE';
  return envelope({
    sourceModule: 'RUMINT',
    eventType: 'RUMOR_OBSERVATION',
    ts: sec(rec.ts),
    symbol: canonSymbol(rec.symbol),
    families: ['RUMOR', 'SOCIAL_ATTENTION'],
    observationState: failed ? 'UNAVAILABLE' : 'KNOWN',
    payload: { type: rec.type, detail: strip(rec, 'ts') },
    dataAvailability: { chatterVelocity: failed ? 'UNAVAILABLE' : rec.velocity !== undefined || rec.z !== undefined ? 'KNOWN' : 'UNKNOWN' },
    provenance: liveProv('rumint/events.jsonl (stocktwits chatter poller)', rec.ts, observedTs),
    identity: sourceFingerprint(rec, 'rumint/events.jsonl'),
  });
}

// ---------------------------------------------------------------------
// C. GATEWAY — gateway/transitions.jsonl lines. The incident key is a
// natural episode id: every transition of one incident shares eventId.
// ---------------------------------------------------------------------
export function fromGatewayTransition(rec, observedTs = nowIso()) {
  return envelope({
    sourceModule: 'GATEWAY',
    eventType: 'GATEWAY_STATUS',
    ts: sec(rec.observedAt),
    symbol: null, // exchange infrastructure is not asset-specific; no coin is invented
    families: ['EXCHANGE_INFRASTRUCTURE'],
    observationState: 'KNOWN',
    payload: strip(rec, 'observedAt'),
    dataAvailability: { incidentStage: 'KNOWN' },
    provenance: {
      source: 'gateway/transitions.jsonl (statuspage collector)',
      sourceTs: rec.announcedAt ?? 'UNKNOWN',
      availableTs: rec.announcedAt ?? rec.observedAt,
      retrievedTs: observedTs,
      kind: 'live',
      form: 'raw',
    },
    correlation: { eventId: rec.key ?? null, sourceEventId: rec.key ?? null },
    sourceEventId: rec.key ? `${rec.key}:${rec.to ?? ''}:${rec.observedAt}` : null,
    identity: sourceFingerprint(rec, 'gateway/transitions.jsonl'),
  });
}

// ---------------------------------------------------------------------
// D. TAPE — tape session snapshots.jsonl lines (already curated, bounded
// summaries — never the raw order book firehose).
// ---------------------------------------------------------------------
export function fromTapeSnapshot(rec, observedTs = nowIso()) {
  return envelope({
    sourceModule: 'TAPE',
    eventType: 'MARKET_SNAPSHOT',
    ts: sec(rec.ts),
    symbol: canonSymbol(rec.coin),
    families: ['MARKET_PRICE', 'LIQUIDITY', 'ORDER_FLOW'],
    // FAIL CLOSED (MEMORY-0A §7): LIVE (and legacy CLEAN) -> KNOWN; an
    // explicit non-healthy state -> DEGRADED; ABSENT health is UNKNOWN —
    // memory never infers health from the absence of health data.
    observationState: rec.tapeState === 'LIVE' || rec.tapeState === 'CLEAN' ? 'KNOWN' : rec.tapeState === undefined ? 'UNKNOWN' : 'DEGRADED',
    payload: strip(rec, 'ts', 'coin'),
    dataAvailability: { book: rec.tapeState === 'LIVE' || rec.tapeState === 'CLEAN' ? 'KNOWN' : rec.tapeState === undefined ? 'UNKNOWN' : 'DEGRADED' },
    provenance: liveProv('tape session snapshots.jsonl (kraken WS L2 features)', rec.ts, observedTs),
    identity: sourceFingerprint(rec, 'tape/snapshots.jsonl'),
  });
}

// ---------------------------------------------------------------------
// E. COST — cost/evaluations.jsonl lines. Execution-quality CONTEXT only;
// this grants nothing and prices nothing into action.
// ---------------------------------------------------------------------
export function fromCostEvaluation(rec, observedTs = nowIso()) {
  return envelope({
    sourceModule: 'COST',
    eventType: 'EXECUTION_CONTEXT',
    ts: sec(rec.ts),
    symbol: canonSymbol(rec.coin),
    families: ['EXECUTION_QUALITY'],
    observationState: 'KNOWN',
    payload: strip(rec, 'ts', 'coin'),
    dataAvailability: { roundTripCost: Array.isArray(rec.rungs) && rec.rungs.length ? 'KNOWN' : 'UNKNOWN' },
    provenance: liveProv('cost/evaluations.jsonl (execution cost model)', rec.ts, observedTs),
    identity: sourceFingerprint(rec, 'cost/evaluations.jsonl'),
  });
}

// ---------------------------------------------------------------------
// F. STATE — state/transitions.jsonl (posture) and controls_log.jsonl.
// Memory OBSERVES state; it can never cause a transition (no path exists).
// ---------------------------------------------------------------------
export function fromStateTransition(rec, observedTs = nowIso()) {
  return envelope({
    sourceModule: 'STATE',
    eventType: 'STATE_CHANGE',
    ts: sec(rec.ts),
    symbol: null,
    families: ['STATE_CONTROL'],
    observationState: 'KNOWN',
    payload: strip(rec, 'ts'),
    dataAvailability: { posture: rec.to ? 'KNOWN' : 'UNKNOWN' },
    provenance: liveProv('state/transitions.jsonl (posture machine)', rec.ts, observedTs),
    identity: sourceFingerprint(rec, 'state/transitions.jsonl'),
  });
}

export function fromControlAction(rec, observedTs = nowIso()) {
  return envelope({
    sourceModule: 'STATE',
    eventType: 'CONTROL_ACTION',
    ts: sec(rec.ts),
    symbol: null,
    families: ['STATE_CONTROL'],
    observationState: 'KNOWN',
    payload: strip(rec, 'ts'),
    dataAvailability: { control: 'KNOWN' },
    provenance: liveProv('state/controls_log.jsonl (human controls)', rec.ts, observedTs),
    identity: sourceFingerprint(rec, 'state/controls_log.jsonl'),
  });
}
