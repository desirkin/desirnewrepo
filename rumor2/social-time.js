// SOCIAL-4D — ONE pure temporal-input boundary for the Social layer.
//
// Every string-to-time entry point in the Social layer (operator access dates,
// provider record timestamps, provider transport-event timestamps) parses through
// this module under an EXPLICIT per-role policy. It replaces the generic
// `Date.parse` heuristic, which (per the ECMAScript specification) interprets an
// offset-less date-time in the HOST time zone, accepts a bare numeric string as
// a year, and rolls impossible calendar dates forward — so the same provider
// declaration produced a different instant, a different quarantine verdict, and a
// different content-version identity depending on the machine's TZ.
//
// Laws:
//   * validate BEFORE constructing a number: primitive string, bounded length,
//     complete grammar (no partial parse, no trailing text), calendar validity
//     (leap years, month lengths), time-of-day ranges, offset syntax and range;
//   * never infer the host time zone; never accept '0' or any bare number as a
//     date; never roll February 30 into March; never read a wall clock;
//   * the declaration text is preserved (bounded), never rewritten;
//   * UTC numeric construction happens only AFTER field validation, through
//     setUTCFullYear/setUTCHours so years 0001..0099 are NOT reinterpreted as
//     1901..1999 (the Date.UTC two-digit-year trap);
//   * sub-millisecond digits: JavaScript time is integer milliseconds. Under a
//     FLOOR policy the instant is the millisecond floor of the declaration and
//     `subMillisecondRemainder` says whether non-zero digits were dropped — the
//     caller never gets to call a floored value "exact". Under an UNSUPPORTED
//     policy finer digits are refused (UNSUPPORTED_PRECISION) rather than truncated;
//   * a usable instant proves syntax only. It never proves the source told the
//     truth about when something happened (the shared quarantine law still
//     decides past/known vs FUTURE_QUARANTINED at normalization).
//
// No imports. No network, filesystem, secrets, timers, or wall-clock reads.

export const SOCIAL_TIME_OUTCOMES = Object.freeze([
  'INSTANT', // calendar-valid, explicit offset, within the policy's range and precision
  'DATE_ONLY', // calendar-valid YYYY-MM-DD under a policy that admits day labels (access dates only)
  'ABSENT', // null / undefined / not a string — nothing was declared
  'OFFSET_MISSING', // a date-time with no Z / ±HH:MM — ambiguous, never resolved by the host zone
  'UNSUPPORTED_PRECISION', // more fraction digits than the policy supports (never silently truncated)
  'UNSUPPORTED_RANGE', // grammatically valid but outside the supported year range, or a leap second
  'MALFORMED', // everything else: bare numbers, impossible dates, prose, lowercase where forbidden, -00:00 where forbidden, partial syntax
]);

// Per-role, per-provider policies — justified by each producer's documented format,
// never by blind generic ISO acceptance.
export const SOCIAL_TIME_POLICIES = Object.freeze({
  // AT Protocol `datetime` (atproto.com/specs/lexicon#datetime, accessed 2026-09-06):
  // timezone required; uppercase T/Z only; -00:00 disallowed; four-digit year;
  // whole seconds required, arbitrary fraction digits allowed (spec warns of
  // precision loss on round trip — hence FLOOR with an explicit remainder flag).
  AT_DATETIME: Object.freeze({ id: 'AT_DATETIME', lowercase: false, negativeZero: false, dateOnly: false, minYear: 1, maxYear: 9999, maxFractionDigits: null, subMillisecond: 'FLOOR' }),
  // RFC 3339 `date-time` (Neynar OpenAPI `format: date-time`, v3.184.0, accessed
  // 2026-09-06): lowercase t/z permitted, -00:00 permitted (UTC with unknown local
  // offset — the instant is still exact), four-digit year, arbitrary fraction.
  RFC3339: Object.freeze({ id: 'RFC3339', lowercase: true, negativeZero: true, dateOnly: false, minYear: 1, maxYear: 9999, maxFractionDigits: null, subMillisecond: 'FLOOR' }),
  // ISO 8601 UTC profile (X Post `created_at`, documented example
  // 2019-12-31T19:26:16.000Z, accessed 2026-09-06): uppercase, explicit offset,
  // -00:00 not part of ISO 8601, arbitrary fraction tolerated with FLOOR.
  ISO8601_PROFILE: Object.freeze({ id: 'ISO8601_PROFILE', lowercase: false, negativeZero: false, dateOnly: false, minYear: 1, maxYear: 9999, maxFractionDigits: null, subMillisecond: 'FLOOR' }),
  // Operator access/review dates (the semantics sealed for StockTwits in 809a139,
  // carried to every Social access record): calendar-valid YYYY-MM-DD as a day
  // LABEL, or an explicit-offset instant with at most millisecond precision.
  ACCESS_DATE: Object.freeze({ id: 'ACCESS_DATE', lowercase: false, negativeZero: true, dateOnly: true, minYear: 1000, maxYear: 9999, maxFractionDigits: 3, subMillisecond: 'UNSUPPORTED' }),
});

export const MAX_SOCIAL_TIME_CHARS = 64;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})([Tt])(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;
const OFFSETLESS_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y, m) => [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const validCalendarDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
const result = (outcome, declared, extra = {}) => Object.freeze({ outcome, declared, instantMs: null, dayStartMs: null, fractionDigits: null, subMillisecondRemainder: false, precision: null, ...extra });

// Validated UTC construction. `new Date(0)` + setUTCFullYear/setUTCHours keeps
// years 1..99 literal (Date.UTC would map them to 1901..1999).
function utcMs(y, mo, d, h, mi, s, ms) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, ms);
  const t = dt.getTime();
  return Number.isSafeInteger(t) ? t : null;
}

// Parse ONE declared time under ONE policy. Total: never throws on any input.
export function parseSocialTime(v, policy) {
  if (policy === null || typeof policy !== 'object' || typeof policy.id !== 'string') throw new TypeError('parseSocialTime: a SOCIAL_TIME_POLICIES entry is required');
  if (typeof v !== 'string' || v.length === 0) return result('ABSENT', null);
  const declared = v.slice(0, MAX_SOCIAL_TIME_CHARS);
  if (v.length > MAX_SOCIAL_TIME_CHARS) return result('MALFORMED', declared);
  const dateOnly = v.match(DATE_ONLY_RE);
  if (dateOnly) {
    if (!policy.dateOnly) return result('MALFORMED', declared);
    const [y, m, d] = [+dateOnly[1], +dateOnly[2], +dateOnly[3]];
    if (!validCalendarDate(y, m, d)) return result('MALFORMED', declared);
    if (y < policy.minYear || y > policy.maxYear) return result('UNSUPPORTED_RANGE', declared);
    return result('DATE_ONLY', declared, { dayStartMs: utcMs(y, m, d, 0, 0, 0, 0), precision: 'DAY' });
  }
  const m = v.match(INSTANT_RE);
  if (!m) return result(OFFSETLESS_RE.test(v) ? 'OFFSET_MISSING' : 'MALFORMED', declared);
  const [y, mo, d, sep, h, mi, sec, frac, off] = [+m[1], +m[2], +m[3], m[4], +m[5], +m[6], +m[7], m[8], m[9]];
  if (!policy.lowercase && (sep !== 'T' || off === 'z')) return result('MALFORMED', declared);
  if (!policy.negativeZero && off === '-00:00') return result('MALFORMED', declared);
  if (!validCalendarDate(y, mo, d) || h > 23 || mi > 59) return result('MALFORMED', declared);
  if (sec > 60) return result('MALFORMED', declared);
  if (sec === 60) return result('UNSUPPORTED_RANGE', declared); // leap seconds are not representable in integer-ms time
  let offsetMs = 0;
  if (off !== 'Z' && off !== 'z') {
    const oh = +off.slice(1, 3); const om = +off.slice(4, 6);
    if (oh > 23 || om > 59) return result('MALFORMED', declared);
    offsetMs = (off[0] === '-' ? -1 : 1) * (oh * 3_600_000 + om * 60_000);
  }
  if (y < policy.minYear || y > policy.maxYear) return result('UNSUPPORTED_RANGE', declared);
  const fractionDigits = frac === undefined ? 0 : frac.length;
  if (policy.maxFractionDigits !== null && fractionDigits > policy.maxFractionDigits) return result('UNSUPPORTED_PRECISION', declared, { fractionDigits });
  const subMillisecondRemainder = fractionDigits > 3 && /[1-9]/.test(frac.slice(3));
  if (subMillisecondRemainder && policy.subMillisecond !== 'FLOOR') return result('UNSUPPORTED_PRECISION', declared, { fractionDigits, subMillisecondRemainder });
  const ms = frac === undefined ? 0 : +frac.slice(0, 3).padEnd(3, '0');
  const local = utcMs(y, mo, d, h, mi, sec, ms);
  if (local === null) return result('UNSUPPORTED_RANGE', declared, { fractionDigits });
  const instantMs = local - offsetMs;
  if (!Number.isSafeInteger(instantMs)) return result('UNSUPPORTED_RANGE', declared, { fractionDigits });
  return result('INSTANT', declared, { instantMs, fractionDigits, subMillisecondRemainder, precision: subMillisecondRemainder ? 'MILLISECOND_FLOOR' : 'EXACT' });
}

// Provider record / transport-event clocks: the usable instant or null. A null
// means "no usable declared clock" — the established UNKNOWN path at normalization,
// which keeps the evidence and quarantines nothing but the clock.
export const providerRecordTimeMs = (v, policy) => parseSocialTime(v, policy).instantMs;

// Operator access/review dates — ONE deterministic interpretation shared by record
// validation and readiness evaluation (parsed once per evaluation by the caller):
//   ABSENT    = null/undefined (not supplied — NOT a fabricated value)
//   INSTANT   = calendar-valid explicit-offset instant (≤ 3 fraction digits)
//   DATE_ONLY = calendar-valid YYYY-MM-DD, a UTC calendar-day LABEL (dayStartMs), no instant claimed
//   INVALID   = anything else SUPPLIED (offset-less date-time, impossible date, bare
//               number, prose, sub-millisecond fraction, wrong type, empty/oversized)
//               — never treated as absent, never repaired
export const SOCIAL_ACCESS_DATE_KINDS = Object.freeze(['ABSENT', 'INSTANT', 'DATE_ONLY', 'INVALID']);
const ACCESS_DATE_ERRORS = Object.freeze({
  OFFSET_MISSING: 'a date-time without an explicit Z or numeric offset is ambiguous',
  UNSUPPORTED_PRECISION: 'fractions finer than milliseconds are unsupported',
  UNSUPPORTED_RANGE: 'outside the supported calendar range',
  MALFORMED: 'not a calendar-valid YYYY-MM-DD or explicit-offset date-time',
});
export function accessDate(v) {
  if (v === null || v === undefined) return Object.freeze({ kind: 'ABSENT', declared: null, instantMs: null, dayStartMs: null, error: null });
  if (typeof v !== 'string') return Object.freeze({ kind: 'INVALID', declared: null, instantMs: null, dayStartMs: null, error: 'must be a string' });
  const p = parseSocialTime(v, SOCIAL_TIME_POLICIES.ACCESS_DATE);
  if (p.outcome === 'INSTANT') return Object.freeze({ kind: 'INSTANT', declared: p.declared, instantMs: p.instantMs, dayStartMs: null, error: null });
  if (p.outcome === 'DATE_ONLY') return Object.freeze({ kind: 'DATE_ONLY', declared: p.declared, instantMs: null, dayStartMs: p.dayStartMs, error: null });
  // an empty string is SUPPLIED and invalid (the env readers already map an empty
  // variable to "not supplied" before this point)
  return Object.freeze({ kind: 'INVALID', declared: p.declared ?? '', instantMs: null, dayStartMs: null, error: ACCESS_DATE_ERRORS[p.outcome] ?? ACCESS_DATE_ERRORS.MALFORMED });
}
const DAY_MS = 86_400_000;
export const utcDayStart = (ms) => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
