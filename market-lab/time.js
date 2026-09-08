// MARKET LAB — point-in-time and window law (§6). Pure: no wall clock, no I/O.
//
//  * knownAtTs is the OWNER's knowledge clock: never before receipt, never before an applicable source floor.
//  * For an as-of Q only observations with knownAtTs <= Q are admissible. A window end, a period label, a schedule
//    or a date-only vintage is NEVER a knowledge clock by itself (G14): without a separately proven earlier basis,
//    the knowledge floor of a downloaded record is its receipt.
//  * Trade / bar windows are (start, end] in EVENT time; book endpoints are the latest accepted sample AT OR BEFORE
//    the boundary in local application time. Equal clocks tie-break on (sequence, epochId) — recorded, never guessed.
//  * A source event materially ahead of trusted receipt is CLOCK_CONFLICT (contracts.js), never clamped backward.
import { isTs, isCount, CLOCK_CONFLICT_TOLERANCE_MS } from './contracts.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WINDOWS_MS = Object.freeze([15_000, 60_000, 300_000, 900_000, 3_600_000]); // §7.1 trade windows
export const BAR_INTERVALS_MIN = Object.freeze([1, 5, 15, 60, 240, 1440]); // Kraken OHLC intervals used here
export const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;

export function parseUtcInstant(text) {
  if (typeof text !== 'string' || !ISO_RE.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== text.slice(0, 19)) return null;
  return ms;
}
export const isoOf = (ms) => new Date(ms).toISOString();
export const dateOnlyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayStartTs = (dateOnly) => Date.parse(`${dateOnly}T00:00:00Z`);
export const dayEndTs = (dateOnly) => dayStartTs(dateOnly) + DAY_MS; // the first instant AFTER the day
export const intervalFloor = (ts, intervalMs) => Math.floor(ts / intervalMs) * intervalMs;
export const minuteFloor = (ts) => intervalFloor(ts, MINUTE_MS);

// (start, end] membership in event time
export const inWindow = (ts, startTs, endTs) => isTs(ts) && ts > startTs && ts <= endTs;
export const windowEndingAt = (endTs, windowMs) => ({ startTs: endTs - windowMs, endTs, windowMs });
export const adjacentWindows = (endTs, windowMs) => ({ previous: windowEndingAt(endTs - windowMs, windowMs), current: windowEndingAt(endTs, windowMs) });

export const admissibleAt = (o, asOfTs) => isTs(asOfTs) && isTs(o?.knownAtTs) && o.knownAtTs <= asOfTs;
export const clockConflict = (sourceEventTs, receivedTs) => isTs(sourceEventTs) && isTs(receivedTs) && sourceEventTs > receivedTs + CLOCK_CONFLICT_TOLERANCE_MS;
export const ageMs = (asOfTs, ts) => (isTs(asOfTs) && isTs(ts) ? Math.max(0, asOfTs - ts) : null);

// Knowledge floor of a downloaded record: receipt, raised by any PROVEN earlier basis that is still >= receipt-floor law.
// `provenEarlierBasisTs` is a caller-supplied, separately recorded basis (e.g. a live subscription receipt) — never a
// provider date label. Returns the floor and the reason it was chosen.
export function knowledgeFloor({ receivedTs, providerLagMs = 0, provenEarlierBasisTs = null }) {
  if (!isTs(receivedTs)) return { floorTs: null, basis: 'RECEIPT_MISSING' };
  const lag = isCount(providerLagMs) ? providerLagMs : 0;
  // a documented provider processing lag can only RAISE a floor above receipt (we cannot know it earlier than the provider did)
  const floor = receivedTs + lag;
  if (isTs(provenEarlierBasisTs) && provenEarlierBasisTs < floor) return { floorTs: provenEarlierBasisTs, basis: 'PROVEN_EARLIER_BASIS' };
  return { floorTs: floor, basis: lag > 0 ? 'RECEIPT_PLUS_PROVIDER_LAG' : 'RECEIPT' };
}

// Derivation law: completed measurement window end <= derivation time <= as-of; every input knowledge floor <= derivation.
export function derivationClockError({ windowEndTs = null, derivationTs, asOfTs, inputKnownAtTs = [] }, where = 'derivation') {
  if (!isTs(derivationTs) || !isTs(asOfTs)) return `${where}: derivation/as-of clocks required`;
  if (derivationTs > asOfTs) return `${where}: derived after the as-of`;
  if (windowEndTs !== null && (!isTs(windowEndTs) || windowEndTs > derivationTs)) return `${where}: window not complete at derivation`;
  if (!Array.isArray(inputKnownAtTs)) return `${where}: input clocks malformed`;
  for (let i = 0; i < inputKnownAtTs.length; i += 1) { const t = inputKnownAtTs[i]; if (!isTs(t)) return `${where}: input ${i} has no knowledge clock`; if (t > derivationTs) return `${where}: input ${i} known after derivation`; }
  return null;
}

// deterministic ordering of observations that share a clock: sequence then epoch then id — recorded facts only
export const observationOrder = (a, b) => (a.knownAtTs - b.knownAtTs) || (a.sequence - b.sequence) || (a.epochId === b.epochId ? 0 : a.epochId === null ? -1 : b.epochId === null ? 1 : a.epochId < b.epochId ? -1 : 1) || (a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1 : 0);
export const eventOrder = (a, b) => ((a.sourceEventTs ?? a.receivedTs) - (b.sourceEventTs ?? b.receivedTs)) || observationOrder(a, b);

// Whether a scheduled (future) time may be USED as a fact at as-of: schedule facts are payload; the fact that a schedule
// exists is known at its receipt. The scheduled instant itself never becomes knowledge of the outcome.
export const scheduleKnownAt = (o) => o.knownAtTs;

// Late arrival law: a record received after a view was sealed can enter only a NEW view at or after its receipt.
export const enteredBeforeSeal = (o, sealedAtTs) => isTs(sealedAtTs) && o.knownAtTs <= sealedAtTs;
