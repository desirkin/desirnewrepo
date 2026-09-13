// YouTube Data API quota admission.
//
// YouTube search.list quota is charged when the request reaches the provider,
// including an empty response.  A process-local counter is therefore not an
// admission control.  This small ledger is intentionally provider-specific:
// callers hydrate it from the authoritative journal, append the reservation
// under the writer fence, and only then dispatch the request.
import { createHash } from 'node:crypto';
import { YOUTUBE_QUOTA_UNIT_COST } from './youtube-official.js';

export const YOUTUBE_QUOTA_RESERVATION_TYPE = 'RUMOR2_YOUTUBE_QUOTA_RESERVED';
export const YOUTUBE_QUOTA_LEDGER_VERSION = 'youtube-quota-ledger-1';

const MAX_QUOTA_UNITS = 10_000_000;
const isInt = (v) => Number.isSafeInteger(v);
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const monthOf = (ts) => new Date(ts).toISOString().slice(0, 7);
const freeze = (v) => Object.freeze(v);

function validPeriod(v, re) {
  return typeof v === 'string' && re.test(v);
}

function reservationId(day, ordinal) {
  return `r2yq-${createHash('sha256').update(JSON.stringify([day, ordinal])).digest('hex')}`;
}

export function youtubeQuotaReservationEvent({ day, ordinal, units = YOUTUBE_QUOTA_UNIT_COST, knownAtTs } = {}) {
  if (!validPeriod(day, /^\d{4}-\d{2}-\d{2}$/) || !isInt(ordinal) || ordinal < 1 ||
      !isInt(units) || units !== YOUTUBE_QUOTA_UNIT_COST ||
      !isInt(knownAtTs) || knownAtTs < 0) return null;
  return {
    type: YOUTUBE_QUOTA_RESERVATION_TYPE,
    v: YOUTUBE_QUOTA_LEDGER_VERSION,
    provider: 'YOUTUBE_OFFICIAL',
    day,
    month: day.slice(0, 7),
    ordinal,
    units,
    knownAtTs,
    ts: new Date(knownAtTs).toISOString(),
    sourceEventId: reservationId(day, ordinal),
    authority: 'NONE',
  };
}

export function youtubeQuotaReservationError(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'reservation shape';
  const expected = youtubeQuotaReservationEvent(event);
  if (!expected) return 'reservation values';
  const keys = Object.keys(event).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) return 'reservation keys';
  for (const key of expectedKeys) if (event[key] !== expected[key]) return 'reservation identity';
  return null;
}

export function createYouTubeQuotaLedger({
  now = Date.now,
  dailyBudgetUnits = null,
  monthlyBudgetUnits = null,
} = {}) {
  let hydrated = false;
  let periodDay = null;
  let periodMonth = null;
  let dailyUsed = 0;
  let monthlyUsed = 0;
  let ordinal = 0;

  const budgetsValid = () => isInt(dailyBudgetUnits) && dailyBudgetUnits >= YOUTUBE_QUOTA_UNIT_COST &&
    dailyBudgetUnits <= MAX_QUOTA_UNITS && isInt(monthlyBudgetUnits) &&
    monthlyBudgetUnits >= YOUTUBE_QUOTA_UNIT_COST && monthlyBudgetUnits <= MAX_QUOTA_UNITS;

  function hydrate(events = []) {
    if (!Array.isArray(events)) return { ok: false, error: 'QUOTA_HISTORY_NOT_ARRAY' };
    const at = now();
    if (!isInt(at) || at < 0) return { ok: false, error: 'ACQUISITION_CLOCK_REQUIRED' };
    const today = dayOf(at);
    const month = monthOf(at);
    let d = 0; let m = 0; let maxOrdinal = 0;
    for (const event of events) {
      if (event?.type !== YOUTUBE_QUOTA_RESERVATION_TYPE) continue;
      const error = youtubeQuotaReservationError(event);
      if (error) return { ok: false, error };
      d += event.day === today ? event.units : 0;
      m += event.month === month ? event.units : 0;
      if (event.day === today) maxOrdinal = Math.max(maxOrdinal, event.ordinal);
    }
    periodDay = today; periodMonth = month; dailyUsed = d; monthlyUsed = m; ordinal = maxOrdinal; hydrated = true;
    return { ok: true, status: status() };
  }

  function rollover(at) {
    const day = dayOf(at); const month = monthOf(at);
    if (day !== periodDay) { periodDay = day; dailyUsed = 0; ordinal = 0; }
    if (month !== periodMonth) { periodMonth = month; monthlyUsed = 0; }
  }

  function status() {
    return freeze({
      provider: 'YOUTUBE_OFFICIAL',
      version: YOUTUBE_QUOTA_LEDGER_VERSION,
      hydrated,
      day: periodDay,
      month: periodMonth,
      dailyUsedUnits: dailyUsed,
      monthlyUsedUnits: monthlyUsed,
      dailyBudgetUnits,
      monthlyBudgetUnits,
      dailyRemainingUnits: isInt(dailyBudgetUnits) ? Math.max(0, dailyBudgetUnits - dailyUsed) : null,
      monthlyRemainingUnits: isInt(monthlyBudgetUnits) ? Math.max(0, monthlyBudgetUnits - monthlyUsed) : null,
      authority: 'NONE',
    });
  }

  function reserve({ knownAtTs = now(), units = YOUTUBE_QUOTA_UNIT_COST } = {}) {
    if (!hydrated) return { ok: false, reason: 'QUOTA_LEDGER_NOT_HYDRATED', status: status() };
    if (!budgetsValid()) return { ok: false, reason: 'EXPLICIT_QUOTA_BUDGET_REQUIRED', status: status() };
    if (!isInt(knownAtTs) || knownAtTs < 0) return { ok: false, reason: 'ACQUISITION_CLOCK_REQUIRED', status: status() };
    if (units !== YOUTUBE_QUOTA_UNIT_COST) return { ok: false, reason: 'UNAPPROVED_QUOTA_UNIT_COST', status: status() };
    rollover(knownAtTs);
    if (dailyUsed + units > dailyBudgetUnits) return { ok: false, reason: 'DAILY_QUOTA_EXHAUSTED', status: status() };
    if (monthlyUsed + units > monthlyBudgetUnits) return { ok: false, reason: 'MONTHLY_QUOTA_EXHAUSTED', status: status() };
    const event = youtubeQuotaReservationEvent({ day: periodDay, ordinal: ordinal + 1, units, knownAtTs });
    return { ok: true, event: freeze(event), status: status() };
  }

  // Commit only after the reservation has been durably appended.  If the
  // process dies before commit, the caller must hydrate the appended event and
  // the quota remains conservatively spent.
  function commit(event) {
    const error = youtubeQuotaReservationError(event);
    if (error) return { ok: false, error };
    if (!hydrated) return { ok: false, error: 'QUOTA_LEDGER_NOT_HYDRATED' };
    if (event.day !== periodDay) return { ok: false, error: 'QUOTA_PERIOD_MISMATCH' };
    if (event.ordinal !== ordinal + 1) return { ok: false, error: 'QUOTA_ORDINAL_MISMATCH' };
    ordinal = event.ordinal; dailyUsed += event.units; monthlyUsed += event.units;
    return { ok: true, status: status() };
  }

  return freeze({ hydrate, reserve, commit, status });
}