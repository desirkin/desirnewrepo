// SOCIAL-4D — social temporal-input integrity. ONE repeated parsing flaw (generic
// Date.parse on external strings) reproduced at 809a139 across the Reddit access
// record and six provider clock paths. d5db393 shipped the pure boundary
// (rumor2/social-time.js) and the Reddit repair; the SOCIAL-4D COMPLETION wires the six
// adapter paths through bounded temporal witnesses with history-safe reconciliation
// (test/social-4d-completion.test.js). Wholly synthetic values.
// Cross-zone checks run fresh child processes under three TZ settings with the
// SAME explicit nowMs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSocialTime, providerRecordTimeMs, accessDate, utcDayStart, SOCIAL_TIME_POLICIES, SOCIAL_TIME_OUTCOMES, SOCIAL_ACCESS_DATE_KINDS, MAX_SOCIAL_TIME_CHARS } from '../rumor2/social-time.js';
import { evaluateRedditAccess, validateRedditApprovalRecord, redditApprovalRecordFromEnv, redditAccessDate, REDDIT_APPLICATION_ID, REDDIT_USE_CASE_VERSION, REDDIT_PERMITTED_USES } from '../rumor2/social-reddit.js';
import { farcasterConfigured } from '../rumor2/providers/farcaster-official.js';
import { normalizeSocialObservation } from '../rumor2/social.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-09-06T14:00:00.000Z');
const P = SOCIAL_TIME_POLICIES;
const runIn = (TZ, script) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata'];

const T_Z = '2026-09-06T12:00:00Z'; const T_MS = Date.parse(T_Z);

// =========================================================================================
// A. THE PURE BOUNDARY — policy tables
// =========================================================================================
test('TIME-1. the boundary is pure and closed: no imports, no capability, closed outcome/kind sets, never throws', () => {
  const src = readFileSync(path.join(REPO, 'rumor2/social-time.js'), 'utf8');
  assert.equal([...src.matchAll(/from '([^']+)'/g)].length, 0);
  const code = src.replace(/\/\/.*$/gm, '');
  for (const cap of ['fetch(', 'WebSocket', 'setTimeout', 'setInterval', 'node:', 'process.', 'Date.now', 'Date.parse', 'Date.UTC', 'require(', 'import(']) assert.ok(!code.includes(cap), `no ${cap}`);
  assert.deepEqual([...SOCIAL_TIME_OUTCOMES], ['INSTANT', 'DATE_ONLY', 'ABSENT', 'OFFSET_MISSING', 'UNSUPPORTED_PRECISION', 'UNSUPPORTED_RANGE', 'MALFORMED']);
  assert.deepEqual([...SOCIAL_ACCESS_DATE_KINDS], ['ABSENT', 'INSTANT', 'DATE_ONLY', 'INVALID']);
  assert.deepEqual(Object.keys(P), ['AT_DATETIME', 'RFC3339', 'ISO8601_PROFILE', 'JETSTREAM_EVENT_TIME', 'ACCESS_DATE']);
  for (const v of [undefined, null, '', 0, 1, -1, 1.5, NaN, true, false, [], {}, ['2026-09-06T12:00:00Z'], { toString: () => '2026-09-06T12:00:00Z' }, 20260906n, Symbol.iterator, () => '2026-09-06T12:00:00Z']) for (const pol of Object.values(P)) { const r = parseSocialTime(v, pol); assert.ok(SOCIAL_TIME_OUTCOMES.includes(r.outcome)); assert.equal(r.instantMs, null, `${String(v)} under ${pol.id}`); assert.ok(r.outcome === 'ABSENT' || r.outcome === 'MALFORMED'); }
  assert.throws(() => parseSocialTime('2026-09-06T12:00:00Z'), TypeError, 'a policy is mandatory — no default guessing');
  assert.equal(parseSocialTime('x'.repeat(MAX_SOCIAL_TIME_CHARS + 1), P.RFC3339).outcome, 'MALFORMED'); assert.equal(parseSocialTime('x'.repeat(MAX_SOCIAL_TIME_CHARS + 1), P.RFC3339).declared.length, MAX_SOCIAL_TIME_CHARS, 'bounded, not rewritten');
});

test('TIME-2. grammar + calendar validity before any number: bare numbers, prose, partial syntax, trailing text, impossible dates, bad time/offset fields are never instants under ANY policy', () => {
  const junk = ['0', '1', '1700000000000', '1e12', '2026', '2026-09', '2026-09-06T', '2026-09-06T12', '2026-09-06T12:00:00Zx', 'x2026-09-06T12:00:00Z', ' 2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z ', '2026-9-6T12:00:00Z', '20260906T120000Z', '2026/09/06T12:00:00Z', 'Sept 6, 2026', '09/06/2026', 'yesterday', 'now', '2026-02-30T12:00:00Z', '2023-02-29T12:00:00Z', '2026-00-06T12:00:00Z', '2026-13-06T12:00:00Z', '2026-09-00T12:00:00Z', '2026-09-31T12:00:00Z', '2026-09-06T24:00:00Z', '2026-09-06T12:60:00Z', '2026-09-06T12:00:61Z', '2026-09-06T12:00:00+24:00', '2026-09-06T12:00:00+05:60', '2026-09-06T12:00:00+0530', '2026-09-06T12:00:00+05', '2026-09-06T12:00:00.Z', '2026-09-06T12:00Z', '+002026-09-06T12:00:00Z', '+275760-09-13T00:00:00.000Z', '-000001-01-01T00:00:00Z', '2026-09-06T12:00:00 UTC', 'Sun, 06 Sep 2026 12:00:00 GMT'];
  for (const v of junk) for (const pol of Object.values(P)) { const r = parseSocialTime(v, pol); assert.equal(r.instantMs, null, `${v} under ${pol.id}`); assert.notEqual(r.outcome, 'INSTANT'); assert.notEqual(r.outcome, 'DATE_ONLY'); assert.equal(r.declared, v.slice(0, MAX_SOCIAL_TIME_CHARS)); }
  assert.equal(parseSocialTime('2026-02-30T12:00:00Z', P.AT_DATETIME).outcome, 'MALFORMED', 'February 30 never rolls into March');
  assert.equal(parseSocialTime('0', P.AT_DATETIME).outcome, 'MALFORMED', 'a bare number is not the year 2000');
  for (const v of ['2026-09-06T12:00:00', '2026-09-06T12:00', '2026-09-06T12:00:00.123', '2026-09-06 12:00:00']) for (const pol of Object.values(P)) assert.equal(parseSocialTime(v, pol).outcome, 'OFFSET_MISSING', `${v} under ${pol.id}: the host zone is never inferred`);
  assert.equal(parseSocialTime('2026-09-06T23:59:60Z', P.RFC3339).outcome, 'UNSUPPORTED_RANGE', 'a leap second is not representable — explicitly unsupported, not rolled');
  assert.equal(parseSocialTime('0000-01-01T00:00:00Z', P.AT_DATETIME).outcome, 'UNSUPPORTED_RANGE');
});

test('TIME-3. provider policies follow each producer\'s documented grammar: AT datetime (uppercase, no -00:00, 4-digit year ≥ 0001, arbitrary fraction), RFC 3339 (lowercase and -00:00 allowed), ISO 8601 profile for X', () => {
  const ok = (v, pol) => parseSocialTime(v, pol);
  assert.equal(ok(T_Z, P.AT_DATETIME).instantMs, T_MS); assert.equal(ok(T_Z, P.RFC3339).instantMs, T_MS); assert.equal(ok(T_Z, P.ISO8601_PROFILE).instantMs, T_MS);
  // equivalent explicit offsets denote one instant
  for (const v of ['2026-09-06T08:00:00-04:00', '2026-09-06T17:30:00+05:30', '2026-09-06T12:00:00+00:00', '2026-09-06T12:00:00.000Z']) for (const pol of [P.AT_DATETIME, P.RFC3339, P.ISO8601_PROFILE]) assert.equal(ok(v, pol).instantMs, T_MS, `${v} ${pol.id}`);
  // capitalization: AT and ISO profile reject lowercase; RFC 3339 accepts
  assert.equal(ok('2026-09-06t12:00:00z', P.AT_DATETIME).outcome, 'MALFORMED'); assert.equal(ok('2026-09-06T12:00:00z', P.AT_DATETIME).outcome, 'MALFORMED'); assert.equal(ok('2026-09-06t12:00:00Z', P.ISO8601_PROFILE).outcome, 'MALFORMED');
  assert.equal(ok('2026-09-06t12:00:00z', P.RFC3339).instantMs, T_MS); assert.equal(ok('2026-09-06T12:00:00z', P.RFC3339).instantMs, T_MS);
  // negative zero: AT and ISO reject; RFC 3339 = UTC with unknown local offset (an exact instant)
  assert.equal(ok('2026-09-06T12:00:00-00:00', P.AT_DATETIME).outcome, 'MALFORMED'); assert.equal(ok('2026-09-06T12:00:00-00:00', P.ISO8601_PROFILE).outcome, 'MALFORMED'); assert.equal(ok('2026-09-06T12:00:00-00:00', P.RFC3339).instantMs, T_MS);
  // years: 0001..9999 literal — never the Date.UTC 1901..1999 remap
  assert.equal(ok('0050-01-01T00:00:00Z', P.AT_DATETIME).instantMs, -60589296000000, 'year 50 stays year 50');
  assert.equal(ok('0001-01-01T00:00:00.000Z', P.AT_DATETIME).instantMs, -62135596800000, 'the AT spec example year 0001');
  assert.equal(ok('9999-12-31T23:59:59.999Z', P.AT_DATETIME).instantMs, 253402300799999); assert.ok(Number.isSafeInteger(ok('9999-12-31T23:59:59.999Z', P.AT_DATETIME).instantMs));
  // month/leap/year transitions
  assert.equal(ok('2024-02-29T23:59:59.999Z', P.AT_DATETIME).instantMs, Date.UTC(2024, 1, 29, 23, 59, 59, 999)); assert.equal(ok('2100-02-29T00:00:00Z', P.AT_DATETIME).outcome, 'MALFORMED', '2100 is not a leap year'); assert.equal(ok('2000-02-29T00:00:00Z', P.AT_DATETIME).instantMs, Date.UTC(2000, 1, 29));
  assert.equal(ok('2026-12-31T23:59:59.999Z', P.AT_DATETIME).instantMs, Date.UTC(2026, 11, 31, 23, 59, 59, 999)); assert.equal(ok('2027-01-01T00:00:00Z', P.AT_DATETIME).instantMs, Date.UTC(2027, 0, 1));
  assert.equal(ok('2026-12-31T23:30:00-01:00', P.AT_DATETIME).instantMs, Date.UTC(2027, 0, 1, 0, 30), 'an offset crossing a year boundary is exact');
  // fractions: ms exact; zero padding beyond ms does not change the instant; non-zero sub-ms digits are FLOORED and FLAGGED, never called exact
  assert.deepEqual([ok('2026-09-06T12:00:00.5Z', P.AT_DATETIME).instantMs, ok('2026-09-06T12:00:00.05Z', P.AT_DATETIME).instantMs, ok('2026-09-06T12:00:00.123Z', P.AT_DATETIME).instantMs], [T_MS + 500, T_MS + 50, T_MS + 123]);
  const padded = ok('2026-09-06T12:00:00.250000Z', P.AT_DATETIME); assert.equal(padded.instantMs, T_MS + 250); assert.equal(padded.subMillisecondRemainder, false); assert.equal(padded.precision, 'EXACT'); assert.equal(padded.fractionDigits, 6);
  const micro = ok('2026-09-06T12:00:00.123456Z', P.AT_DATETIME); assert.equal(micro.instantMs, T_MS + 123); assert.equal(micro.subMillisecondRemainder, true); assert.equal(micro.precision, 'MILLISECOND_FLOOR'); assert.equal(micro.outcome, 'INSTANT', 'the AT spec permits arbitrary precision — a microsecond timestamp is NOT malformed');
  assert.equal(ok('2026-09-06T12:00:00.9999999Z', P.RFC3339).instantMs, T_MS + 999, 'floored, never rounded up into the next millisecond');
  // the boundary claims syntax only — it never says the source was truthful
  assert.ok(!('trusted' in micro) && !('verified' in micro));
});

test('TIME-4. the access-date policy (carried from the StockTwits seal): day labels, ≤ 3 fraction digits, uppercase, explicit offset; INVALID never masquerades as absent', () => {
  assert.deepEqual(accessDate(null), { kind: 'ABSENT', declared: null, instantMs: null, dayStartMs: null, error: null }); assert.equal(accessDate(undefined).kind, 'ABSENT');
  assert.deepEqual(accessDate('2026-09-05'), { kind: 'DATE_ONLY', declared: '2026-09-05', instantMs: null, dayStartMs: Date.UTC(2026, 8, 5), error: null });
  assert.equal(accessDate('2024-02-29').kind, 'DATE_ONLY'); assert.equal(accessDate('2026-02-30').kind, 'INVALID'); assert.equal(accessDate('2023-02-29').kind, 'INVALID');
  assert.equal(accessDate('2026-09-06T10:00:00-04:00').instantMs, NOW); assert.equal(accessDate('2026-09-06T19:30:00+05:30').instantMs, NOW); assert.equal(accessDate('2026-09-06T14:00:00.250Z').instantMs, NOW + 250);
  assert.equal(accessDate('2026-09-06T14:00:00.1234Z').kind, 'INVALID'); assert.match(accessDate('2026-09-06T14:00:00.1234Z').error, /finer than milliseconds/);
  assert.equal(accessDate('2026-09-06T14:00:00').kind, 'INVALID'); assert.match(accessDate('2026-09-06T14:00:00').error, /without an explicit Z or numeric offset/);
  assert.equal(accessDate('2026-09-06t14:00:00z').kind, 'INVALID'); assert.equal(accessDate('0999-01-01').kind, 'INVALID');
  for (const v of ['', ' ', '0', 'yesterday', true, 0, 1, [], {}, 20260906n]) { const a = accessDate(v); assert.equal(a.kind, 'INVALID', String(v)); assert.equal(a.instantMs, null); assert.equal(a.dayStartMs, null); }
  assert.equal(accessDate('').declared, '', 'an empty string is supplied and invalid — distinguishable from absent');
  assert.equal(redditAccessDate, accessDate, 'Reddit uses the shared interpretation');
  assert.equal(utcDayStart(NOW), Date.UTC(2026, 8, 6)); assert.equal(utcDayStart(Date.UTC(2026, 8, 6)), Date.UTC(2026, 8, 6)); assert.equal(utcDayStart(Date.UTC(2026, 8, 6) - 1), Date.UTC(2026, 8, 5));
});

// =========================================================================================
// B. REDDIT ACCESS RECORDS (RED A at 809a139)
// =========================================================================================
const CREDS = { REDDIT_CLIENT_ID: 'fixture-not-real', REDDIT_CLIENT_SECRET: 'fixture-not-real' };
const REC = (o = {}) => ({ approvalRef: 'audit-synthetic', status: 'APPROVED', application: REDDIT_APPLICATION_ID, useCaseVersion: REDDIT_USE_CASE_VERSION, classification: 'NON_COMMERCIAL_PERSONAL', permittedUses: ['RETRIEVAL', 'PERSONAL_RESEARCH'], additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionCompatibility: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-05', ...o });
const ev = (o, nowMs = NOW, e = CREDS) => evaluateRedditAccess({ record: REC(o), env: e, nowMs });
const envRec = (over) => redditApprovalRecordFromEnv({ RUMOR2_SOCIAL_REDDIT_APPROVAL_REF: 'audit-synthetic', RUMOR2_SOCIAL_REDDIT_APPROVAL_STATUS: 'APPROVED', RUMOR2_SOCIAL_REDDIT_APPROVAL_APPLICATION: REDDIT_APPLICATION_ID, RUMOR2_SOCIAL_REDDIT_APPROVAL_USE_CASE_VERSION: REDDIT_USE_CASE_VERSION, RUMOR2_SOCIAL_REDDIT_APPROVAL_CLASSIFICATION: 'NON_COMMERCIAL_PERSONAL', RUMOR2_SOCIAL_REDDIT_APPROVAL_PERMITTED_USES: 'RETRIEVAL,PERSONAL_RESEARCH', RUMOR2_SOCIAL_REDDIT_APPROVAL_ADDITIONAL_AGREEMENT: 'NOT_REQUIRED', RUMOR2_SOCIAL_REDDIT_APPROVAL_RETENTION_COMPATIBILITY: 'COMPATIBLE_REVIEWED', RUMOR2_SOCIAL_REDDIT_APPROVAL_REVIEWED_ON: '2026-09-05', ...over });
const noLive = (a) => { assert.equal(a.liveAllowed, false); assert.equal(a.liveStatus, 'DISABLED'); assert.equal(a.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH'); assert.equal(a.durableContentAllowed, false); assert.equal(a.durableAuthorIdentityAllowed, false); assert.equal(a.activationPrerequisitesMet, a.blockers.length === 0 && Object.values(a.prerequisites).every(Boolean)); };
const invalid = (a, field) => { assert.equal(a.activationPrerequisitesMet, false); assert.equal(a.approvalStatus, 'NOT_VERIFIED'); assert.equal(a.blockers.length, 1, JSON.stringify(a.blockers)); assert.match(a.blockers[0], new RegExp(`^APPROVAL_RECORD_INVALID: approval record: ${field} `)); assert.equal(a.prerequisites.review, false); assert.equal(a.prerequisites.approval, false); assert.deepEqual([...a.permittedUses], []); noLive(a); };

test('RD-TIME-1 (RED A at 809a139). offset-less, impossible, and bare-numeric review/expiry dates invalidate the record instead of flipping readiness with the host zone', () => {
  // RED: reviewedOn '2026-09-06T12:00:00' was ready under UTC/Asia-Kolkata and REVIEW_DATE_IN_FUTURE under America/New_York
  invalid(ev({ reviewedOn: '2026-09-06T12:00:00' }), 'reviewedOn'); assert.match(ev({ reviewedOn: '2026-09-06T12:00:00' }).blockers[0], /without an explicit Z or numeric offset/);
  // RED: validUntil '2026-09-06T12:00:00' was EXPIRED under UTC/Asia-Kolkata and ready under America/New_York
  invalid(ev({ validUntil: '2026-09-06T12:00:00' }), 'validUntil');
  // RED: '2026-02-30' and '0' were ready / OPERATOR_ATTESTED
  invalid(ev({ reviewedOn: '2026-02-30' }), 'reviewedOn'); invalid(ev({ reviewedOn: '0' }), 'reviewedOn'); invalid(ev({ validUntil: '0' }), 'validUntil'); invalid(ev({ reviewedOn: '2026-02-27', validUntil: '2026-02-30T12:00:00Z' }, Date.parse('2026-02-28T12:00:00Z')), 'validUntil');
  const junk = ['', ' ', '0', '1', 'yesterday', 'Sept 5, 2026', '09/05/2026', '2026-09-05T12', '2026-09-05T12:00:00Zx', 'x'.repeat(65), '2026-02-30', '2023-02-29', '2026-00-10', '2026-09-00', '2026-13-01', '2026-02-30T12:00:00Z', '2026-09-05T24:00:00Z', '2026-09-05T12:60:00Z', '2026-09-05T12:00:60Z', '2026-09-05T12:00:00+24:00', '2026-09-05T12:00:00-05:60', '2026-09-05T12:00:00.1234Z', '2026-09-05T12:00', '2026-09-05 12:00:00Z', '2026-09-05t12:00:00z'];
  for (const v of junk) { invalid(ev({ reviewedOn: v }), 'reviewedOn'); invalid(ev({ validUntil: v }), 'validUntil'); }
  for (const v of [true, false, 0, 1, 1788696000000, 1.5, [], ['2026-09-05'], {}, { date: '2026-09-05' }, 20260905n]) { invalid(ev({ reviewedOn: v }), 'reviewedOn'); invalid(ev({ validUntil: v }), 'validUntil'); }
  // the env path goes through the SAME validation; an empty env variable is "not supplied" (pre-existing env law)
  invalid(evaluateRedditAccess({ record: envRec({ RUMOR2_SOCIAL_REDDIT_APPROVAL_REVIEWED_ON: '2026-09-06T12:00:00' }), env: CREDS, nowMs: NOW }), 'reviewedOn');
  invalid(evaluateRedditAccess({ record: envRec({ RUMOR2_SOCIAL_REDDIT_APPROVAL_VALID_UNTIL: '2026-02-30' }), env: CREDS, nowMs: NOW }), 'validUntil');
  invalid(evaluateRedditAccess({ record: envRec({ RUMOR2_SOCIAL_REDDIT_APPROVAL_VALID_UNTIL: '0' }), env: CREDS, nowMs: NOW }), 'validUntil');
  assert.equal(envRec({ RUMOR2_SOCIAL_REDDIT_APPROVAL_VALID_UNTIL: '' }).validUntil, null); assert.equal(evaluateRedditAccess({ record: envRec({ RUMOR2_SOCIAL_REDDIT_APPROVAL_VALID_UNTIL: '2026-09-07T00:00:00Z' }), env: CREDS, nowMs: NOW }).activationPrerequisitesMet, true);
  assert.equal(validateRedditApprovalRecord(REC({ reviewedOn: '' })), 'approval record: reviewedOn not a calendar-valid YYYY-MM-DD or explicit-offset date-time', 'a supplied empty string in a direct record is invalid, not absent');
});

test('RD-TIME-2. review-day and expiry-instant rules; date-only expiry stays precision-unresolved; exact ±1 ms boundary; absent versus invalid; no mutation; no wall clock; zero live/durable permission', () => {
  // reviewedOn: a UTC day label — tomorrow blocks, today/yesterday pass this prerequisite
  assert.deepEqual([...ev({ reviewedOn: '2026-09-07' }).blockers], ['REVIEW_DATE_IN_FUTURE']); assert.equal(ev({ reviewedOn: '2026-09-06' }).activationPrerequisitesMet, true); assert.equal(ev({ reviewedOn: '2026-09-05' }).activationPrerequisitesMet, true);
  assert.equal(ev({ reviewedOn: '2026-09-06' }, Date.UTC(2026, 8, 6)).activationPrerequisitesMet, true, 'same UTC day at 00:00Z'); assert.deepEqual([...ev({ reviewedOn: '2026-09-06' }, Date.UTC(2026, 8, 6) - 1).blockers], ['REVIEW_DATE_IN_FUTURE'], 'one millisecond before the day starts it is a future day');
  assert.equal(ev({ reviewedOn: '2024-02-29' }).activationPrerequisitesMet, true, 'valid leap day');
  // reviewedOn: instants compare exactly, in any equivalent offset
  for (const v of ['2026-09-06T14:00:00Z', '2026-09-06T10:00:00-04:00', '2026-09-06T19:30:00+05:30', '2026-09-06T13:59:59.999Z']) assert.equal(ev({ reviewedOn: v }).activationPrerequisitesMet, true, v);
  for (const v of ['2026-09-06T14:00:00.001Z', '2026-09-06T10:00:00.001-04:00', '2026-09-06T19:30:01+05:30']) { const a = ev({ reviewedOn: v }); assert.deepEqual([...a.blockers], ['REVIEW_DATE_IN_FUTURE'], v); assert.equal(a.approvalStatus, 'NOT_VERIFIED'); }
  // validUntil: valid strictly before the expiry; at now and after it is EXPIRED
  for (const v of ['2026-09-06T14:00:00.001Z', '2026-09-06T10:00:00.001-04:00', '2026-09-06T19:30:00.001+05:30']) { const a = ev({ validUntil: v }); assert.equal(a.activationPrerequisitesMet, true, v); assert.equal(a.approvalStatus, 'OPERATOR_ATTESTED'); }
  for (const v of ['2026-09-06T14:00:00.000Z', '2026-09-06T14:00:00Z', '2026-09-06T10:00:00-04:00', '2026-09-06T19:30:00+05:30', '2026-09-06T13:59:59.999Z']) { const a = ev({ validUntil: v }); assert.equal(a.approvalStatus, 'EXPIRED', v); assert.deepEqual([...a.blockers], ['APPROVAL_EXPIRED']); }
  // validUntil: a day label names no expiry instant or zone — declaration kept, valid record, readiness blocked, nothing assumed
  for (const v of ['2026-09-06', '2026-09-07', '2027-01-01', '2024-02-29']) { const a = ev({ validUntil: v }); assert.equal(validateRedditApprovalRecord(REC({ validUntil: v })), null); assert.deepEqual([...a.blockers], ['VALID_UNTIL_PRECISION_UNRESOLVED'], v); assert.equal(a.approvalStatus, 'NOT_VERIFIED'); assert.equal(a.prerequisites.approval, false); }
  // absent expiry = no expiry supplied; absent review keeps its optionality with a separate advisory
  const noExp = ev({ validUntil: null }); assert.equal(noExp.activationPrerequisitesMet, true); assert.equal(ev({ validUntil: undefined }).activationPrerequisitesMet, true);
  const noRev = ev({ reviewedOn: null }); assert.equal(noRev.activationPrerequisitesMet, true); assert.deepEqual([...noRev.advisories], ['REVIEW_DATE_NOT_SUPPLIED']); assert.ok(!noExp.advisories.includes('REVIEW_DATE_NOT_SUPPLIED'));
  // the caller's record is never mutated or rewritten
  const frozenIn = REC({ reviewedOn: '2026-02-30', validUntil: '2026-09-06T12:00:00' }); const snap = JSON.stringify(frozenIn); evaluateRedditAccess({ record: frozenIn, env: CREDS, nowMs: NOW }); validateRedditApprovalRecord(frozenIn); assert.equal(JSON.stringify(frozenIn), snap);
  // missing/invalid nowMs: readiness false without any wall clock, even with valid dates
  for (const bad of [undefined, null, NaN, '1788696000000', 0, 1.5, -1]) { const a = evaluateRedditAccess({ record: REC({ reviewedOn: '2026-09-05', validUntil: '2026-09-07T00:00:00Z' }), env: CREDS, nowMs: bad }); assert.equal(a.activationPrerequisitesMet, false); assert.ok(a.blockers[0] === 'CLOCK_UNAVAILABLE' || a.blockers[0] === 'CLOCK_INVALID'); noLive(a); }
  // an invalid date plus permissive flags/credentials still grants nothing; classification is never promoted
  const perm = evaluateRedditAccess({ record: REC({ reviewedOn: '0', permittedUses: [...REDDIT_PERMITTED_USES] }), env: { ...CREDS, REDDIT_LIVE: 'true', RUMOR2_SOCIAL_REDDIT_ENABLED: 'true' }, nowMs: NOW }); invalid(perm, 'reviewedOn'); assert.equal(perm.useCaseClassification, 'UNRESOLVED'); assert.equal(perm.evidence, 'OPERATOR_ATTESTATION_NOT_PLATFORM_PROOF');
  for (const a of [noExp, noRev, ev({ validUntil: '2026-09-07' }), ev({ reviewedOn: '2026-09-07' }), ev({ reviewedOn: '2026-09-05', validUntil: '2026-09-06T14:00:00.001Z' })]) noLive(a);
  const src = readFileSync(path.join(REPO, 'rumor2/social-reddit.js'), 'utf8').replace(/\/\/.*$/gm, ''); const access = src.slice(src.indexOf('function inspectApprovalRecord'), src.indexOf('// ---- fixture-only preview adapter'));
  assert.ok(!access.includes('Date.parse(r') && !access.includes('Date.parse(record') && !access.includes('new Date('), 'operator dates never reach Date.parse');
});

test('RD-TIME-3. byte-identical Reddit readiness under UTC, America/New_York, and Asia/Kolkata for the same records and nowMs', () => {
  const script = `import { evaluateRedditAccess, REDDIT_APPLICATION_ID as A, REDDIT_USE_CASE_VERSION as U } from ${JSON.stringify(path.join(REPO, 'rumor2/social-reddit.js'))}; const rec = (o) => ({ approvalRef: 'audit-synthetic', status: 'APPROVED', application: A, useCaseVersion: U, classification: 'NON_COMMERCIAL_PERSONAL', permittedUses: ['RETRIEVAL', 'PERSONAL_RESEARCH'], additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionCompatibility: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-05', ...o }); const env = { REDDIT_CLIENT_ID: 'fixture-not-real', REDDIT_CLIENT_SECRET: 'fixture-not-real' }; const out = []; for (const o of [{ reviewedOn: '2026-09-06T12:00:00' }, { validUntil: '2026-09-06T12:00:00' }, { reviewedOn: '2026-02-30' }, { reviewedOn: '0' }, { reviewedOn: '2026-09-06' }, { reviewedOn: '2026-09-07' }, { validUntil: '2026-09-06' }, { reviewedOn: '2026-09-06T14:00:00Z' }, { reviewedOn: '2026-09-06T10:00:00-04:00' }, { reviewedOn: '2026-09-06T19:30:00+05:30' }, { validUntil: '2026-09-06T14:00:00.001Z' }, { validUntil: '2026-09-06T10:00:00-04:00' }, { validUntil: '2026-09-06T19:30:00.001+05:30' }]) out.push(evaluateRedditAccess({ record: rec(o), env, nowMs: ${NOW} })); process.stdout.write(JSON.stringify(out));`;
  const utc = runIn('UTC', script); for (const z of ZONES.slice(1)) assert.equal(runIn(z, script), utc, z);
  const rows = JSON.parse(utc); assert.equal(rows.length, 13);
  assert.deepEqual(rows.map((r) => [r.activationPrerequisitesMet, r.approvalStatus]), [[false, 'NOT_VERIFIED'], [false, 'NOT_VERIFIED'], [false, 'NOT_VERIFIED'], [false, 'NOT_VERIFIED'], [true, 'OPERATOR_ATTESTED'], [false, 'NOT_VERIFIED'], [false, 'NOT_VERIFIED'], [true, 'OPERATOR_ATTESTED'], [true, 'OPERATOR_ATTESTED'], [true, 'OPERATOR_ATTESTED'], [true, 'OPERATOR_ATTESTED'], [false, 'EXPIRED'], [true, 'OPERATOR_ATTESTED']]);
  assert.ok(rows.every((r) => r.liveAllowed === false && r.durableContentAllowed === false && r.durableAuthorIdentityAllowed === false));
});

// =========================================================================================
// C. PROVIDER CLOCK POLICIES — the per-role policies the six adapter paths consume
// (Farcaster cast/recast, Bluesky post/repost/event time, X Post).
// =========================================================================================
test('PV-POLICY-1. the provider policies already answer the RED B inputs deterministically: no instant for offset-less, impossible, bare-numeric, or extended-year declarations; exact instants for documented forms; sub-millisecond digits floored and flagged', () => {
  for (const pol of [P.AT_DATETIME, P.RFC3339, P.ISO8601_PROFILE]) {
    for (const v of ['2026-09-06T12:00:00', '2026-02-30T12:00:00Z', '2023-02-29T12:00:00Z', '0', '1700000000000', '', '2026-09-06', '+275760-09-13T00:00:00.000Z']) assert.equal(providerRecordTimeMs(v, pol), null, `${v} ${pol.id}`);
    for (const v of [undefined, null, 1788696000000, true, {}, ['2026-09-06T12:00:00Z']]) assert.equal(providerRecordTimeMs(v, pol), null);
    for (const v of ['2026-09-06T12:00:00Z', '2026-09-06T12:00:00.000Z', '2026-09-06T08:00:00-04:00', '2026-09-06T17:30:00+05:30']) assert.equal(providerRecordTimeMs(v, pol), T_MS, `${v} ${pol.id}`);
    assert.equal(providerRecordTimeMs('2024-02-29T23:59:59.999Z', pol), Date.UTC(2024, 1, 29, 23, 59, 59, 999)); assert.equal(providerRecordTimeMs('2026-12-31T23:30:00-01:00', pol), Date.UTC(2027, 0, 1, 0, 30)); assert.equal(providerRecordTimeMs('0050-01-01T00:00:00Z', pol), -60589296000000);
    assert.equal(providerRecordTimeMs('2026-09-06T12:00:00.250000Z', pol), T_MS + 250); assert.equal(providerRecordTimeMs('2026-09-06T12:00:00.123456Z', pol), T_MS + 123); assert.equal(parseSocialTime('2026-09-06T12:00:00.123456Z', pol).precision, 'MILLISECOND_FLOOR');
    for (const d of [28, 87_000, 86_400_000]) assert.equal(providerRecordTimeMs(new Date(NOW + d).toISOString(), pol), NOW + d, 'future declarations parse; the quarantine law (unchanged) decides their status at normalization');
    assert.equal(providerRecordTimeMs('9999-12-31T23:59:59.999Z', pol), 253402300799999);
  }
  // provider-specific grammar: Neynar RFC 3339 admits lowercase and -00:00; AT datetime (Bluesky) and X's ISO profile do not
  assert.equal(providerRecordTimeMs('2026-09-06t12:00:00z', P.RFC3339), T_MS); assert.equal(providerRecordTimeMs('2026-09-06T12:00:00-00:00', P.RFC3339), T_MS);
  for (const pol of [P.AT_DATETIME, P.ISO8601_PROFILE, P.JETSTREAM_EVENT_TIME]) { assert.equal(providerRecordTimeMs('2026-09-06t12:00:00z', pol), null, pol.id); assert.equal(providerRecordTimeMs('2026-09-06T12:00:00-00:00', pol), null, pol.id); }
  // identical results under three host zones for the same inputs
  const inputs = ['2026-09-06T12:00:00Z', '2026-09-06T08:00:00-04:00', '2026-09-06T12:00:00.123456Z', '2026-09-06T12:00:00', '2026-02-30T12:00:00Z', '0', '2026-09-06t12:00:00z', '2026-09-06T12:00:00-00:00', '0050-01-01T00:00:00Z', ''];
  const script = `import { parseSocialTime, SOCIAL_TIME_POLICIES as P } from ${JSON.stringify(path.join(REPO, 'rumor2/social-time.js'))}; const out = []; for (const pol of Object.values(P)) for (const v of ${JSON.stringify(inputs)}) out.push([pol.id, v, parseSocialTime(v, pol)]); process.stdout.write(JSON.stringify(out));`;
  const utc = runIn('UTC', script); for (const z of ZONES.slice(1)) assert.equal(runIn(z, script), utc, z);
  assert.equal(JSON.parse(utc).length, 5 * inputs.length);
});

// =========================================================================================
// D. NO ACTIVATION / NO AUTHORITY CHANGE
// =========================================================================================
test('NO-ACT-TIME. the repair changes no capability: Farcaster still has no transport or collector path; key presence is configuration only; retention firewalls hold; the six adapter clock paths are wired to the boundary with no Date.parse left', () => {
  assert.equal(farcasterConfigured({}), false); assert.equal(farcasterConfigured({ NEYNAR_API_KEY: 'fixture-not-real' }), true, 'configuration only');
  for (const f of ['rumor2/collector.js', 'rumor2/social-runtime.js', 'rumor2/social-stream.js', 'rumor2/x-runtime.js', 'fly.js']) { const src = readFileSync(path.join(REPO, f), 'utf8'); assert.ok(!src.includes('farcaster-official') && !src.includes('neynar'), `${f} never wires Farcaster`); }
  const reddit = readFileSync(path.join(REPO, 'rumor2/social-reddit.js'), 'utf8'); assert.ok(!/Date\.parse\((?!')/.test(reddit.replace(/\/\/.*$/gm, '')), 'social-reddit.js: no Date.parse on external input (fixed UTC literals excepted)');
  assert.deepEqual([...reddit.matchAll(/from '([^']+)'/g)].map((m) => m[1]), ['./social.js', './social-time.js']);
  for (const f of ['rumor2/providers/bluesky-official.js', 'rumor2/providers/farcaster-official.js', 'rumor2/providers/x-official.js']) { const src = readFileSync(path.join(REPO, f), 'utf8').replace(/\/\/.*$/gm, ''); assert.ok(!src.includes('Date.parse(') && !/new Date\((?!0\))/.test(src), `${f}: no heuristic Date.parse / new Date(string)`); assert.ok(src.includes("from '../social-time.js'"), `${f} is wired to the boundary`); }
  for (const provider of ['REDDIT_OFFICIAL', 'STOCKTWITS_OFFICIAL']) { const n = normalizeSocialObservation({ provider, providerKind: 'SOCIAL_FORUM', nativePostId: 't3_x', nativeAuthorId: 't2_y', text: 'x', relation: 'ORIGINAL', parentNativePostId: null, editState: 'ORIGINAL', canonicalUrl: null, threadId: null, handle: null, sourceDeclaredTs: T_MS, providerEventTs: null, engagement: null, authorMeta: null }, { nowMs: NOW }); assert.equal(n.reject, true); assert.match(n.reason, /^RETENTION_NOT_APPROVED/); }
  const mission = readFileSync(path.join(REPO, 'doctrine/MISSION.md'), 'utf8'); assert.ok(mission.includes('We do not reject pumps')); assert.ok(mission.includes('price extension is context'));
});
