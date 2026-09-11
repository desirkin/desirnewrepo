// SOCIAL-4D COMPLETION — history-safe provider clock integration. The six adapter clock
// paths run through bounded temporal witnesses; legacy history (produced by the UNTOUCHED
// d5db393 code, isolated, under UTC / America/New_York / Asia/Kolkata — test/fixtures/
// social-4d-legacy-d5db393-*.json) is never reminted: a redelivered legacy event resolves
// to its canonical observation, gains at most a dated interpretation annotation, or is
// retained as an explicit reconciliation-pending record. Every path here is the real
// adapter -> normalization -> intake -> settlement -> journal -> replay/view chain.
// Wholly synthetic values. No provider transport, no wall clock, no sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownAdvisoryHolders } from './helpers/pg-fence.js';
import { readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporalWitness, validateTemporalWitness, parseSocialTime, SOCIAL_TIME_POLICIES, TEMPORAL_WITNESS_KEYS, TEMPORAL_POLICY_VERSION, MAX_SOCIAL_TIME_CHARS, compareWitnessToReference } from '../rumor2/social-time.js';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { neynarEventToRaw, FARCASTER_OFFICIAL } from '../rumor2/providers/farcaster-official.js';
import { xPostToRaw, X_OFFICIAL } from '../rumor2/providers/x-official.js';
import { normalizeSocialObservation, buildSocialFilter, classifyWitnessedSourceClock, SOURCE_CLOCK_STATES, SOURCE_CLOCK_STATES_V2, socialWitnessHash } from '../rumor2/social.js';
import {
  socialObservationToEvent, validateSocialEvent, validateSocialEventV2, validateSocialClockInterpretation, validateSocialReconciliationPending, reconstructSocialWitness, replaySocialHistory,
  socialClockInterpretationEvent, socialReconciliationPendingEvent, socialNativeKey, socialImmutableDigest, isSocialEventType,
  SOCIAL_EVENT_TYPE, SOCIAL_EVENT_V2_TYPE, SOCIAL_EVENT_KEYS, SOCIAL_EVENT_V2_KEYS, SOCIAL_OBSERVATION_TYPES, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_CLOCK_POLICY_BY_PROVIDER,
  xRuleSetEvent, xMeterEvent, xProgressEvent, socialCursorEvent,
} from '../rumor2/social-settle.js';
import { createSocialReconciler } from '../rumor2/social-reconcile.js';
import { socialTemporalView, compareSocialInstants } from '../rumor2/social-view.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { canonicalJson, contentHash } from '../rumor2/truth.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-soc4d-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-06T14:00:00.000Z'); // the fixtures' acquisition clock
const LATER = NOW + 600_000; // a later acquisition for redeliveries
const iso = (ms) => new Date(ms).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };
const P = SOCIAL_TIME_POLICIES;
const ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata'];
const FIX = Object.fromEntries(ZONES.map((z) => [z, JSON.parse(readFileSync(path.join(REPO, `test/fixtures/social-4d-legacy-d5db393-${z.replace('/', '_')}.json`), 'utf8'))]));
const runIn = (TZ, script) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const FILTER = buildSocialFilter({ terms: ['BTC'], watchAuthorIds: ['did:plc:synthetic', 'fid:4242', 'fid:99', '42'] });
const T_Z = '2026-09-06T12:00:00Z'; const T_MS = Date.parse(T_Z);

// ---- synthetic provider messages (the same shapes the legacy generator used) ---------------
const bsky = (createdAt, o = {}) => ({ payload: { $type: 'x#commit', did: 'did:plc:synthetic', seq: o.seq ?? 41, time: 'time' in o ? o.time : '2026-09-06T13:59:00Z', operation: o.op ?? 'create', collection: o.repost ? 'app.bsky.feed.repost' : 'app.bsky.feed.post', rkey: o.rkey ?? 'k1', cid: o.op === 'delete' ? undefined : (o.cid ?? 'bafysynthetic1'), record: o.op === 'delete' ? undefined : (o.repost ? { $type: 'app.bsky.feed.repost', createdAt, subject: { uri: 'at://did:plc:o/app.bsky.feed.post/1', cid: 'c' } } : { $type: 'app.bsky.feed.post', text: o.text ?? 'synthetic $BTC fixture', createdAt }) } });
const fc = (timestamp, o = {}) => ({ type: 'cast.created', data: { object: 'cast', hash: o.hash ?? '0xsyntheticcast1', author: { fid: 4242, username: o.username ?? 'fx_synthetic', follower_count: o.followers ?? 3 }, text: o.text ?? 'synthetic $BTC fixture', timestamp, parent_hash: null, reactions: { likes_count: o.likes ?? 1 } } });
const rc = (timestamp) => ({ type: 'reaction.created', data: { reaction_type: 'recast', reactor: { fid: 99 }, cast: { hash: '0xsyntheticcast1' }, timestamp } });
const xp = (created_at, o = {}) => ({ data: { id: o.id ?? '100', text: o.text ?? 'synthetic $BTC fixture', author_id: '42', created_at, edit_history_tweet_ids: o.history ?? ['100'], public_metrics: { like_count: 1 } } });
const MAP = { bsky_post: [BLUESKY_OFFICIAL, jetstreamCommitToRaw, jetstreamCursorOf], bsky_repost: [BLUESKY_OFFICIAL, jetstreamCommitToRaw, jetstreamCursorOf], bsky_event_time: [BLUESKY_OFFICIAL, jetstreamCommitToRaw, jetstreamCursorOf], fc_cast: [FARCASTER_OFFICIAL, neynarEventToRaw, null], fc_recast: [FARCASTER_OFFICIAL, neynarEventToRaw, null], x_post: [X_OFFICIAL, xPostToRaw, null] };
const MSG = { bsky_post: (t, o) => bsky(t, o), bsky_repost: (t, o) => bsky(t, { repost: true, rkey: 'rp1', cid: 'bafyrepost1', ...o }), fc_cast: (t, o) => fc(t, o), fc_recast: (t) => rc(t), x_post: (t, o) => xp(t, o) };
const raw = (p, t, o) => MAP[p][1](MSG[p](t, o)).raw;
const obs = (p, t, o = {}, nowMs = NOW) => { const r = MAP[p][1](MSG[p](t, o)); assert.ok(r.raw, `${p} ${t}: ${r.reason}`); const n = normalizeSocialObservation(r.raw, { nowMs }); assert.ok(n.observation, `${p} ${t}: ${n.reason}`); return n.observation; };
const fixtureCase = (zone, p, label) => FIX[zone].cases.find((c) => c.path === p && c.label === label);
const src = (events) => events.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));
const ann = (events) => events.filter((e) => e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE);
const pend = (events) => events.filter((e) => e.type === SOCIAL_RECONCILIATION_PENDING_TYPE);

// The REAL pipeline over the in-memory journal: hydrate from history, feed provider messages
// through the adapter/intake in REPLAY mode, settle under a fenced append. Returns the journal.
async function pipeline({ path: p, history = [], deliveries, nowMs = LATER, lookup = 'none', seenCap = undefined, fenceHeld = () => true, appendImpl = null }) {
  const [provider, mapCommit, cursorOf] = MAP[p];
  const arr = history.map((e) => structuredClone(e)); const j = memJournal(arr);
  const rt = createSocialRuntime({ provider, mapCommit, cursorOf, filter: FILTER, now: () => nowMs, mode: 'REPLAY', fixtures: deliveries, log: () => {}, intakeOptions: seenCap ? { seenCap } : {} });
  const h = rt.hydrate(arr); assert.equal(h.ok, true, h.error);
  const before = arr.map((e) => canonicalJson(e));
  rt.start();
  const lk = lookup === 'none' ? null : lookup === 'fail' ? async () => ({ ok: false, reason: 'UNAVAILABLE' }) : async (type, ids) => ({ ok: true, existing: new Set(arr.filter((e) => e.type === type && ids.includes(e.sourceEventId)).map((e) => e.sourceEventId)) });
  const res = await rt.settle({ fenceHeld, append: appendImpl ?? ((evs) => j.append(evs)), lookup: lk });
  for (let i = 0; i < before.length; i++) assert.equal(canonicalJson(arr[i]), before[i], `history row ${i} stays byte-identical`);
  return { rt, arr, res, appended: arr.slice(history.length), stats: rt.status().stats, reconciliation: rt.status().reconciliation };
}

// =========================================================================================
// A. ALL SIX ENTRY POINTS — witnesses, role policies, no heuristic parsing left
// =========================================================================================
test('A. every adapter clock path carries a bounded, re-derivable witness under its FIELD-ROLE policy; numbers equal projections; wrong types, overlong, offset-less, invalid, unsupported-range declarations keep the post with no instant', () => {
  for (const [f, policy] of [['rumor2/providers/bluesky-official.js', 'AT_DATETIME'], ['rumor2/providers/farcaster-official.js', 'RFC3339'], ['rumor2/providers/x-official.js', 'ISO8601_PROFILE']]) {
    const code = readFileSync(path.join(REPO, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!code.includes('Date.parse(') && !/new Date\((?!0\))/.test(code), `${f}: no heuristic parse`); assert.ok(code.includes(`SOCIAL_TIME_POLICIES.${policy}`), `${f} uses the ${policy} role policy`);
  }
  assert.ok(readFileSync(path.join(REPO, 'rumor2/providers/bluesky-official.js'), 'utf8').includes('SOCIAL_TIME_POLICIES.JETSTREAM_EVENT_TIME'), 'payload.time is pinned separately from record.createdAt');
  assert.deepEqual(SOCIAL_CLOCK_POLICY_BY_PROVIDER, { BLUESKY_OFFICIAL: { source: 'AT_DATETIME', event: 'JETSTREAM_EVENT_TIME' }, FARCASTER_OFFICIAL: { source: 'RFC3339', event: null }, X_OFFICIAL: { source: 'ISO8601_PROFILE', event: null } });
  for (const p of ['bsky_post', 'bsky_repost', 'fc_cast', 'fc_recast', 'x_post']) {
    const good = obs(p, T_Z); assert.equal(good.schemaVersion, 2); assert.equal(good.sourceClockWitness.policy, SOCIAL_CLOCK_POLICY_BY_PROVIDER[good.provider].source); assert.equal(good.sourceClockWitness.declared, T_Z); assert.equal(good.sourceDeclaredTs, T_MS); assert.equal(good.sourceClockStatus, 'TRUSTED');
    assert.equal(validateTemporalWitness(good.sourceClockWitness, { expectedPolicyId: good.sourceClockWitness.policy }), null);
    const ev = socialObservationToEvent(good).event; assert.equal(ev.type, SOCIAL_EVENT_V2_TYPE); assert.equal(ev.schemaVersion, 2); assert.equal(validateSocialEvent(ev, V), null); assert.deepEqual(Object.keys(ev).sort(), [...SOCIAL_EVENT_V2_KEYS].sort());
    for (const [t, outcome, status] of [['2026-09-06T12:00:00', 'OFFSET_MISSING', 'STRING'], ['2026-02-30T12:00:00Z', 'MALFORMED', 'STRING'], ['0', 'MALFORMED', 'STRING'], ['', 'MALFORMED', 'STRING'], ['0000-01-01T00:00:00Z', 'UNSUPPORTED_RANGE', 'STRING'], ['2026-09-06T23:59:60Z', 'UNSUPPORTED_RANGE', 'STRING'], [undefined, 'ABSENT', 'ABSENT'], [null, 'ABSENT', 'ABSENT'], [1788696000000, 'MALFORMED', 'NON_STRING'], [{ t: 1 }, 'MALFORMED', 'NON_STRING'], [['2026-09-06T12:00:00Z'], 'MALFORMED', 'NON_STRING'], ['2026-09-06T12:00:00.' + '0'.repeat(60) + 'Z', 'MALFORMED', 'OVERSIZED']]) {
      const o = obs(p, t); const w = o.sourceClockWitness;
      assert.equal(w.outcome, outcome, `${p} ${JSON.stringify(t)}`); assert.equal(w.declaredStatus, status); assert.equal(w.projectionMs, null); assert.equal(o.sourceDeclaredTs, null); assert.equal(o.sourceClockStatus, 'UNKNOWN'); assert.equal(o.sourceCreatedTs, null);
      if (status === 'OVERSIZED') { assert.equal(w.declaredComplete, false); assert.equal(w.declared.length, MAX_SOCIAL_TIME_CHARS); assert.equal(w.declaredLength, t.length, 'honest length, prefix never parsed'); }
      if (status === 'STRING' && t !== '') assert.equal(w.declared, t, 'the declaration is retained exactly');
      if (status === 'NON_STRING') assert.equal(w.declared, null, 'never stringified');
      const e = socialObservationToEvent(o).event; assert.equal(validateSocialEvent(e, V), null, 'the post survives as a valid v2 event');
      if (!p.endsWith('repost') && p !== 'fc_recast') assert.equal(e.text, 'synthetic $BTC fixture');
    }
    // capitalization / -00:00 by documented grammar: Neynar RFC 3339 accepts, AT and X ISO do not
    const lower = obs(p, '2026-09-06t12:00:00z'); const negz = obs(p, '2026-09-06T12:00:00-00:00');
    if (p.startsWith('fc')) { assert.equal(lower.sourceDeclaredTs, T_MS); assert.equal(negz.sourceDeclaredTs, T_MS); } else { assert.equal(lower.sourceDeclaredTs, null); assert.equal(negz.sourceDeclaredTs, null); assert.equal(lower.sourceClockWitness.outcome, 'MALFORMED'); }
    // supported fraction forms: padding keeps EXACT; non-zero sub-ms digits are floored AND flagged with their exact remainder
    const pad = obs(p, '2026-09-06T12:00:00.250000Z'); assert.equal(pad.sourceDeclaredTs, T_MS + 250); assert.equal(pad.sourceClockWitness.subMillisecondRemainder, null);
    const micro = obs(p, '2026-09-06T12:00:00.123456Z'); assert.equal(micro.sourceDeclaredTs, T_MS + 123); assert.equal(micro.sourceClockWitness.subMillisecondRemainder, '456'); assert.equal(micro.sourceClockWitness.fractionDigits, 6);
    // an adapter cannot smuggle a number past its own witness
    assert.equal(normalizeSocialObservation({ ...raw(p, T_Z), sourceDeclaredTs: T_MS + 1 }, { nowMs: NOW }).reject, true);
    assert.equal(normalizeSocialObservation({ ...raw(p, T_Z), sourceClockWitness: { ...raw(p, T_Z).sourceClockWitness, projectionMs: T_MS + 1 } }, { nowMs: NOW }).reject, true, 'a forged witness dies at normalization');
  }
  // Bluesky payload.time: its own role witness; invalid event time never poisons the source declaration or the sequence
  const ev = normalizeSocialObservation(jetstreamCommitToRaw(bsky(T_Z, { time: '2026-09-06T13:59:00.000000500Z' })).raw, { nowMs: NOW }).observation;
  assert.equal(ev.providerEventWitness.policy, 'JETSTREAM_EVENT_TIME'); assert.equal(ev.providerEventTs, Date.parse('2026-09-06T13:59:00.000Z')); assert.equal(ev.providerEventWitness.subMillisecondRemainder, '0005', 'the exact fraction of a millisecond, leading zeros kept');
  for (const t of ['2026-09-06T13:59:00', '0', 5, null, '2026-09-06t13:59:00z']) { const o = normalizeSocialObservation(jetstreamCommitToRaw(bsky(T_Z, { time: t })).raw, { nowMs: NOW }).observation; assert.equal(o.providerEventTs, null, JSON.stringify(t)); assert.equal(o.sourceDeclaredTs, T_MS); assert.equal(o.providerEventSeq, 41); assert.equal(o.sourceClockStatus, 'TRUSTED'); }
  const del = normalizeSocialObservation(jetstreamCommitToRaw(bsky(undefined, { op: 'delete', time: '2026-09-06T13:59:00Z' })).raw, { nowMs: NOW }).observation;
  assert.equal(del.sourceClockWitness.outcome, 'ABSENT'); assert.equal(del.sourceDeclaredTs, null); assert.equal(del.providerEventTs, Date.parse('2026-09-06T13:59:00Z')); assert.equal(del.lifecycle, 'TOMBSTONE');
});

// =========================================================================================
// B. SAME INPUT, THREE HOST ZONES
// =========================================================================================
test('B. full adapter -> normalization -> event outputs are byte-identical under UTC, America/New_York, and Asia/Kolkata; identities never depend on the host zone', () => {
  const inputs = [T_Z, '2026-09-06T08:00:00-04:00', '2026-09-06T12:00:00.123456Z', '2026-09-06T14:00:00.0005Z', '2026-09-06T12:00:00', '2026-02-30T12:00:00Z', '0', '2026-09-06t12:00:00z', '2026-09-06T12:00:00-00:00', '0050-01-01T00:00:00Z', iso(NOW + 87_000), '', undefined];
  const script = `import { jetstreamCommitToRaw } from ${JSON.stringify(path.join(REPO, 'rumor2/providers/bluesky-official.js'))}; import { neynarEventToRaw } from ${JSON.stringify(path.join(REPO, 'rumor2/providers/farcaster-official.js'))}; import { xPostToRaw } from ${JSON.stringify(path.join(REPO, 'rumor2/providers/x-official.js'))}; import { normalizeSocialObservation } from ${JSON.stringify(path.join(REPO, 'rumor2/social.js'))}; import { socialObservationToEvent } from ${JSON.stringify(path.join(REPO, 'rumor2/social-settle.js'))}; import { canonicalJson } from ${JSON.stringify(path.join(REPO, 'rumor2/truth.js'))};
    const NOW = ${NOW}; const bsky = (createdAt, repost, time) => ({ payload: { $type: 'x#commit', did: 'did:plc:synthetic', seq: 41, time: time === undefined ? '2026-09-06T13:59:00Z' : time, operation: 'create', collection: repost ? 'app.bsky.feed.repost' : 'app.bsky.feed.post', rkey: 'k1', cid: 'bafysynthetic1', record: repost ? { $type: 'app.bsky.feed.repost', createdAt, subject: { uri: 'at://did:plc:o/app.bsky.feed.post/1', cid: 'c' } } : { $type: 'app.bsky.feed.post', text: 'synthetic $BTC fixture', createdAt } } });
    const P = { fc_cast: (t) => neynarEventToRaw({ type: 'cast.created', data: { object: 'cast', hash: '0xsyntheticcast1', author: { fid: 4242, username: 'fx_synthetic', follower_count: 3 }, text: 'synthetic $BTC fixture', timestamp: t, parent_hash: null, reactions: { likes_count: 1 } } }), fc_recast: (t) => neynarEventToRaw({ type: 'reaction.created', data: { reaction_type: 'recast', reactor: { fid: 99 }, cast: { hash: '0xsyntheticcast1' }, timestamp: t } }), bsky_post: (t) => jetstreamCommitToRaw(bsky(t, false)), bsky_repost: (t) => jetstreamCommitToRaw(bsky(t, true)), bsky_event_time: (t) => jetstreamCommitToRaw(bsky('2026-09-06T12:00:00Z', false, t)), x_post: (t) => xPostToRaw({ data: { id: '100', text: 'synthetic $BTC fixture', author_id: '42', created_at: t, edit_history_tweet_ids: ['100'], public_metrics: { like_count: 1 } } }) };
    const out = []; for (const [name, fn] of Object.entries(P)) for (const t of ${JSON.stringify(inputs.map((x) => (x === undefined ? '__undef__' : x)))}) { const tt = t === '__undef__' ? undefined : t; const r = fn(tt); const o = normalizeSocialObservation(r.raw, { nowMs: NOW }).observation; out.push([name, t, canonicalJson(socialObservationToEvent(o).event)]); } process.stdout.write(JSON.stringify(out));`;
  const utc = runIn('UTC', script); for (const z of ZONES.slice(1)) assert.equal(runIn(z, script), utc, z);
  const rows = JSON.parse(utc); assert.equal(rows.length, 6 * inputs.length);
  for (const [name, t, canon] of rows) { const e = JSON.parse(canon); assert.equal(validateSocialEvent(e, V), null, `${name} ${t}`); assert.equal(e.type, SOCIAL_EVENT_V2_TYPE); }
});

// =========================================================================================
// C. EVIDENCE SURVIVES AN UNCLEAR SOURCE CLOCK (real pipeline, no legacy history)
// =========================================================================================
test('C. a relevant post with a bad, missing, future, or unsupported date settles as ONE new v2 source with an UNKNOWN / quarantined / ORDER_UNRESOLVED clock — never dropped', async () => {
  for (const p of ['bsky_post', 'fc_cast', 'x_post']) {
    for (const [t, status] of [['2026-09-06T12:00:00', 'UNKNOWN'], ['2026-02-30T12:00:00Z', 'UNKNOWN'], ['0', 'UNKNOWN'], [undefined, 'UNKNOWN'], ['0000-01-01T00:00:00Z', 'UNKNOWN'], [iso(LATER + 28), 'FUTURE_QUARANTINED'], [iso(LATER + 87_000), 'FUTURE_QUARANTINED'], [iso(LATER + 86_400_000), 'FUTURE_QUARANTINED'], [iso(LATER).replace('.000Z', '.0005Z'), 'ORDER_UNRESOLVED']]) {
      const r = await pipeline({ path: p, deliveries: [MSG[p](t)] });
      assert.equal(r.res.ok, true); assert.equal(src(r.appended).length, 1, `${p} ${t}: one source`); assert.equal(ann(r.appended).length, 0); assert.equal(pend(r.appended).length, 0);
      const e = src(r.appended)[0]; assert.equal(e.type, SOCIAL_EVENT_V2_TYPE); assert.equal(e.sourceClockStatus, status, `${p} ${t}`); assert.equal(e.sourceCreatedTs, null); assert.equal(e.knownAtTs, LATER); assert.equal(e.text, 'synthetic $BTC fixture');
      if (status === 'FUTURE_QUARANTINED') assert.ok(e.sourceClockSkewMs > 0);
      assert.equal(validateSocialEvent(e, V), null); assert.equal(replaySocialHistory(r.arr).ok, true);
    }
  }
});

// =========================================================================================
// D. SUB-MILLISECOND BOUNDARIES
// =========================================================================================
test('D. precision survives the adapter and the journal: before T, exactly T, T+0.5ms (ORDER_UNRESOLVED), the next millisecond, trailing zeros, long bounded fractions, day/year-crossing offsets, pre-epoch instants', () => {
  const at = (t) => obs('bsky_post', t, {}, NOW);
  assert.equal(at(iso(NOW - 1)).sourceClockStatus, 'TRUSTED'); assert.equal(at(iso(NOW)).sourceClockStatus, 'TRUSTED'); assert.equal(at(iso(NOW)).sourceCreatedTs, NOW);
  const half = at(iso(NOW).replace('.000Z', '.0005Z')); assert.equal(half.sourceDeclaredTs, NOW, 'the projection floors'); assert.equal(half.sourceClockStatus, 'ORDER_UNRESOLVED', 'the floor may NOT call it earlier'); assert.equal(half.sourceCreatedTs, null); assert.equal(half.sourceClockSkewMs, null); assert.equal(half.sourceClockWitness.subMillisecondRemainder, '5');
  assert.equal(at(iso(NOW + 1)).sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(at(iso(NOW + 1)).sourceClockSkewMs, 1);
  assert.equal(at(iso(NOW - 1).replace('.999Z', '.9999999Z')).sourceClockStatus, 'TRUSTED', 'inside the previous millisecond is strictly earlier');
  const zeros = at(iso(NOW).replace('.000Z', '.000000Z')); assert.equal(zeros.sourceClockStatus, 'TRUSTED'); assert.equal(zeros.sourceClockWitness.subMillisecondRemainder, null); assert.equal(zeros.sourceClockWitness.declared, iso(NOW).replace('.000Z', '.000000Z'));
  const long = at('2026-09-06T12:00:00.' + '1'.repeat(40) + 'Z'); assert.equal(long.sourceDeclaredTs, T_MS + 111); assert.equal(long.sourceClockWitness.subMillisecondRemainder, '1'.repeat(37));
  assert.equal(at('2026-12-31T23:30:00-01:00').sourceDeclaredTs, Date.UTC(2027, 0, 1, 0, 30)); assert.equal(at('2027-01-01T04:30:00+05:30').sourceDeclaredTs, Date.UTC(2026, 11, 31, 23));
  assert.equal(at('1969-12-31T23:59:59.999Z').sourceDeclaredTs, -1); assert.equal(at('0001-01-01T00:00:00Z').sourceDeclaredTs, -62135596800000);
  // exact witness-to-witness ordering; witness-to-integer reference is UNRESOLVED inside the reference millisecond
  const w = (t) => temporalWitness(t, P.AT_DATETIME);
  assert.equal(compareSocialInstants(w('2026-09-06T12:00:00.0005Z'), w('2026-09-06T12:00:00.0004Z')), 'AFTER'); assert.equal(compareSocialInstants(w('2026-09-06T12:00:00.0005Z'), w('2026-09-06T12:00:00.00050Z')), 'EQUAL'); assert.equal(compareSocialInstants(w('2026-09-06T12:00:00Z'), w('2026-09-06T12:00:00.0001Z')), 'BEFORE');
  assert.equal(compareSocialInstants(w('2026-09-06T12:00:00.0005Z'), T_MS), 'UNRESOLVED'); assert.equal(compareSocialInstants(T_MS, w('2026-09-06T12:00:00.0005Z')), 'UNRESOLVED'); assert.equal(compareSocialInstants(w('2026-09-06T12:00:00Z'), T_MS), 'EQUAL'); assert.equal(compareSocialInstants(w('bad'), T_MS), 'UNKNOWN');
  // raw precision survives the durable event and its reconstruction
  const e = socialObservationToEvent(half).event; const wit = reconstructSocialWitness(e);
  assert.equal(wit.sourceClockWitness.subMillisecondRemainder, '5'); assert.equal(wit.sourceClockWitness.declared, iso(NOW).replace('.000Z', '.0005Z')); assert.equal(wit.clockProvenance, 'WITNESSED_DECLARATION'); assert.equal(wit.schemaVersion, 2);
  assert.deepEqual([...SOURCE_CLOCK_STATES_V2], [...SOURCE_CLOCK_STATES, 'ORDER_UNRESOLVED']);
});

// =========================================================================================
// E. LEGACY MALFORMED REDELIVERY (three old host zones) + F. LEGACY EXACT VALID REDELIVERY
// =========================================================================================
const EXPECT = {
  valid_z: 'KNOWN', valid_offset: 'KNOWN', micro: 'KNOWN', padded: 'KNOWN', future_28ms: 'KNOWN', future_87s: 'KNOWN', future_1d: 'KNOWN', missing: 'KNOWN',
  edge_half_ms: 'ANNOTATE', offsetless: 'ANNOTATE', feb30: 'ANNOTATE', zero: 'ANNOTATE', lower: 'ANNOTATE', negzero: 'ANNOTATE',
};
test('E. a legacy event built under UTC / New York / Kolkata, redelivered through the strict adapter: the original row is byte-identical, no second logical source is minted, a supported interpretation is annotated or an unresolved recast is retained explicitly', async () => {
  for (const zone of ZONES) {
    for (const p of ['bsky_post', 'bsky_repost', 'fc_cast', 'x_post']) {
      for (const [label, expect0] of Object.entries(EXPECT)) {
        const c = fixtureCase(zone, p, label); assert.ok(c && c.event && c.valid, `${zone} ${p} ${label} exists in the legacy corpus`);
        const expect = (label === 'lower' || label === 'negzero') && p === 'fc_cast' ? 'KNOWN' : expect0; // Neynar RFC 3339 accepted those: same legacy identity
        const r = await pipeline({ path: p, history: [c.event], deliveries: [c.msg] });
        assert.equal(r.res.ok, true, `${zone} ${p} ${label}`); assert.equal(src(r.appended).length, 0, `${zone} ${p} ${label}: NO second logical source`); assert.equal(pend(r.appended).length, 0);
        const a = ann(r.appended);
        if (expect === 'KNOWN') { assert.equal(a.length, 0, `${zone} ${p} ${label}: known, no annotation`); assert.equal(r.stats.durableDuplicates, 1); continue; }
        assert.equal(a.length, 1, `${zone} ${p} ${label}: exactly one interpretation annotation`);
        const x = a[0]; assert.equal(x.targetEventId, c.event.sourceEventId); assert.equal(x.targetType, SOCIAL_EVENT_TYPE); assert.equal(x.clockRole, 'SOURCE_DECLARATION'); assert.equal(x.basis, 'NEW_DELIVERY_SAME_EVENT');
        assert.equal(x.priorInterpretation.provenance, 'LEGACY_NUMERIC_UNVERIFIED'); assert.equal(x.priorInterpretation.sourceDeclaredTs, c.event.sourceDeclaredTs); assert.equal(x.priorInterpretation.sourceClockStatus, c.event.sourceClockStatus);
        assert.equal(x.evidenceRetrievedTs, LATER); assert.equal(x.knownAtTs, LATER); assert.ok(x.knownAtTs > c.event.knownAtTs, 'the correction is LATER knowledge');
        if (label === 'edge_half_ms') { assert.equal(x.interpretation.established, true); assert.equal(x.interpretation.sourceClockStatus, 'ORDER_UNRESOLVED'); assert.equal(x.interpretation.projectionMs, c.event.sourceDeclaredTs); }
        else { assert.equal(x.interpretation.established, false); assert.equal(x.interpretation.projectionMs, null); assert.ok(['OFFSET_MISSING', 'MALFORMED'].includes(x.interpretation.reason)); assert.equal(x.witness.declared, c.input); }
        assert.equal(validateSocialClockInterpretation(x, { target: c.event }), null); assert.equal(replaySocialHistory(r.arr).ok, true);
        assert.equal(replaySocialHistory(r.arr).observed, 1, 'logical source count unchanged'); assert.equal(replaySocialHistory(r.arr).annotated, 1);
      }
      // the same legacy event redelivered with changed diagnostics and a later acquisition (F)
      const c = fixtureCase(zone, p, 'valid_z');
      const changed = p.startsWith('fc') ? fc(T_Z, { username: 'renamed', followers: 900, likes: 77 }) : c.msg;
      const r = await pipeline({ path: p, history: [c.event], deliveries: [changed], nowMs: LATER + 3_600_000 });
      assert.equal(src(r.appended).length + ann(r.appended).length + pend(r.appended).length, 0, `${zone} ${p}: keep-first, nothing but a cursor may follow`); assert.equal(r.stats.durableDuplicates, 1);
      const w = reconstructSocialWitness(r.arr[0]); assert.equal(w.knownAtTs, NOW, 'first-known knowledge time stands'); if (p.startsWith('fc')) assert.equal(w.handle, 'fx_synthetic');
    }
    // a recast edge with a changed clock has no occurrence identity beyond reactor+target: retained as UNRESOLVED, never merged
    for (const label of ['offsetless', 'feb30', 'zero']) {
      const c = fixtureCase(zone, 'fc_recast', label); const r = await pipeline({ path: 'fc_recast', history: [c.event], deliveries: [c.msg] });
      assert.equal(src(r.appended).length, 0); assert.equal(ann(r.appended).length, 0); assert.equal(pend(r.appended).length, 1, `${zone} recast ${label}`);
      assert.equal(pend(r.appended)[0].reason, 'OCCURRENCE_IDENTITY_INSUFFICIENT'); assert.deepEqual(pend(r.appended)[0].candidateIds, [c.event.sourceEventId]); assert.equal(pend(r.appended)[0].candidate.text, '');
      const rp = replaySocialHistory(r.arr); assert.equal(rp.ok, true); assert.equal(rp.observed, 1); assert.equal(rp.pending, 1); assert.ok(!rp.durableIds.has(pend(r.appended)[0].sourceEventId), 'a pending record is never a source id');
    }
    const cv = fixtureCase(zone, 'fc_recast', 'valid_z'); const rv = await pipeline({ path: 'fc_recast', history: [cv.event], deliveries: [cv.msg] }); assert.equal(rv.appended.length, 0, 'an exact recast redelivery is simply known');
    // the provider EVENT clock: a legacy providerEventTs parsed from an offset-less payload.time gains a PROVIDER_EVENT annotation; the source clock is untouched
    const ce = fixtureCase(zone, 'bsky_event_time', 'ev_offsetless'); const re = await pipeline({ path: 'bsky_event_time', history: [ce.event], deliveries: [ce.msg] });
    assert.equal(src(re.appended).length, 0); assert.equal(ann(re.appended).length, 1); assert.equal(ann(re.appended)[0].clockRole, 'PROVIDER_EVENT'); assert.equal(ann(re.appended)[0].interpretation.projectionMs, null); assert.equal(ann(re.appended)[0].priorInterpretation.sourceDeclaredTs, ce.event.providerEventTs);
  }
});

// =========================================================================================
// G. BLUESKY NATIVE SEQUENCE   H. X EDITS   I. FARCASTER CAST VS RECAST   J. IMMUTABLE CONFLICT
// =========================================================================================
test('G. Bluesky: same URI/CID/text with seq 10 vs 20 stay distinct; CREATE -> DELETE -> RECREATE -> DELETE keeps both tombstones; the exact same seq collapses; a missing seq with candidates cannot absorb', async () => {
  const c10 = fixtureCase('UTC', 'bsky_post', 'seq10'); const c20 = fixtureCase('UTC', 'bsky_post', 'seq20'); const d11 = fixtureCase('UTC', 'bsky_post', 'delete_seq11'); const d21 = fixtureCase('UTC', 'bsky_post', 'delete_seq21');
  assert.notEqual(c10.event.sourceEventId, c20.event.sourceEventId); assert.notEqual(d11.event.sourceEventId, d21.event.sourceEventId);
  const history = [c10.event, d11.event, c20.event, d21.event];
  const r = await pipeline({ path: 'bsky_post', history, deliveries: [c10.msg, c20.msg, bsky(T_Z, { seq: 30 }), bsky(undefined, { op: 'delete', seq: 11 }), bsky(undefined, { op: 'delete', seq: 21 })] });
  assert.equal(r.res.ok, true); assert.equal(src(r.appended).length, 1, 'only seq 30 is a new commit'); assert.equal(src(r.appended)[0].providerEventSeq, 30); assert.equal(ann(r.appended).length, 0); assert.equal(pend(r.appended).length, 0);
  const rp = replaySocialHistory(r.arr); assert.equal(rp.observed, 5); assert.equal([...rp.targets.values()].filter((e) => e.lifecycle === 'TOMBSTONE').length, 2, 'both tombstones retained');
  // an offset-less redelivery of seq 10 annotates seq 10 ONLY (never seq 20)
  const r2 = await pipeline({ path: 'bsky_post', history, deliveries: [bsky('2026-09-06T12:00:00', { seq: 10 })] });
  assert.equal(src(r2.appended).length, 0); assert.equal(ann(r2.appended).length, 1); assert.equal(ann(r2.appended)[0].targetEventId, c10.event.sourceEventId); assert.equal(ann(r2.appended)[0].nativeKey.providerEventSeq, 10);
  // a Bluesky candidate with NO sequence facing a known occurrence of the same post version: missing the
  // discriminator is not proof of a distinct occurrence — OCCURRENCE_IDENTITY_INSUFFICIENT, linked to
  // the known occurrence, never NEW and never absorbed (SOCIAL-4D CLOSEOUT semantic correction)
  const noSeq = { ...raw('bsky_post', '2026-09-06T12:00:00', { seq: 10 }), providerEventSeq: null };
  const rec = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); rec.hydrate(replaySocialHistory([c10.event]));
  const o = normalizeSocialObservation(noSeq, { nowMs: LATER }).observation; const scope = rec.batch({ knownAtTs: LATER });
  const out = rec.reconcile(o, scope); assert.equal(out.kind, 'PENDING', 'a seq-less delivery of a known post version is retained as uncertain, not minted as a second source'); assert.equal(out.reason, 'OCCURRENCE_IDENTITY_INSUFFICIENT'); assert.deepEqual(out.candidateIds, [c10.event.sourceEventId]);
  const rec2 = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); const nullSeqEvent = socialObservationToEvent(normalizeSocialObservation({ ...raw('bsky_post', T_Z), providerEventSeq: null }, { nowMs: NOW }).observation).event;
  rec2.hydrate(replaySocialHistory([nullSeqEvent])); const out2 = rec2.reconcile(o, rec2.batch({ knownAtTs: LATER })); assert.equal(out2.kind, 'PENDING'); assert.equal(out2.reason, 'OCCURRENCE_IDENTITY_INSUFFICIENT');
});

test('H. X: the original and the edited current Post id are distinct versions of one stable post; a correction-only redelivery annotates, never re-sources; the wire meter precedes intake (COST-2/COST-9 prove duplicates are metered)', async () => {
  const c100 = fixtureCase('UTC', 'x_post', 'valid_z'); const c101 = fixtureCase('UTC', 'x_post', 'edit');
  assert.equal(c100.event.socialSourceId, c101.event.socialSourceId, 'one stable post identity'); assert.notEqual(c100.event.sourceEventId, c101.event.sourceEventId); assert.equal(c101.event.lifecycle, 'EDIT');
  const r = await pipeline({ path: 'x_post', history: [c100.event, c101.event], deliveries: [c100.msg, c101.msg, xp('2026-09-06T12:00:00'), xp('2026-09-06T12:00:00', { id: '101', history: ['100', '101'] }), xp(T_Z, { id: '102', history: ['100', '101', '102'] })] });
  assert.equal(src(r.appended).length, 1, 'only the genuine second edit (102) is a new version'); assert.equal(src(r.appended)[0].nativeVersionId, '102'); assert.equal(src(r.appended)[0].lifecycle, 'EDIT');
  assert.equal(ann(r.appended).length, 2); assert.deepEqual(ann(r.appended).map((a) => a.nativeKey.nativeVersionId).sort(), ['100', '101']); assert.equal(pend(r.appended).length, 0);
  const xr = readFileSync(path.join(REPO, 'rumor2/x-runtime.js'), 'utf8'); assert.ok(xr.indexOf('meterPost(receivedTs') < xr.indexOf('intake.offer(obj'), 'BILL AT THE WIRE precedes any Serpent dedupe/compatibility decision');
  assert.ok(xr.includes('cursorOf: null'), 'the X intake is built WITHOUT a provider cursor — no sequence is invented for X');
  assert.ok(readFileSync(path.join(REPO, 'rumor2/providers/x-official.js'), 'utf8').includes('providerEventSeq: null'), 'the X adapter emits no provider sequence');
  assert.equal(src(r.appended)[0].providerEventSeq, null, 'no numeric cursor is invented for X'); assert.equal(r.arr.some((e) => e.type === SOCIAL_CURSOR_EVENT_TYPE), false, 'no cursor event exists for X');
});

test('I. Farcaster: the same cast hash + FID is a supported match; a different hash is a new cast; a recast edge without occurrence identity stays unresolved; no transport is introduced', async () => {
  const c1 = fixtureCase('UTC', 'fc_cast', 'valid_z'); const c2 = fixtureCase('UTC', 'fc_cast', 'other_hash');
  const r = await pipeline({ path: 'fc_cast', history: [c1.event], deliveries: [fc('2026-09-06T12:00:00'), c2.msg, fc(T_Z, { hash: '0xsyntheticcast3' })] });
  assert.equal(src(r.appended).length, 2); assert.deepEqual(src(r.appended).map((e) => e.nativePostId).sort(), ['0xsyntheticcast2', '0xsyntheticcast3']); assert.equal(ann(r.appended).length, 1); assert.equal(ann(r.appended)[0].targetEventId, c1.event.sourceEventId);
  const cr = fixtureCase('UTC', 'fc_recast', 'valid_z');
  const r2 = await pipeline({ path: 'fc_recast', history: [cr.event], deliveries: [rc('2026-09-06T12:00:00'), rc('2026-09-06T12:00:00'), rc('2026-09-06T12:00:00.5Z')] });
  assert.equal(src(r2.appended).length, 0); assert.equal(ann(r2.appended).length, 0); assert.equal(pend(r2.appended).length, 2, 'two DISTINCT unresolved candidates (one per declaration), the duplicate in the same batch resolved once');
  for (const f of ['rumor2/collector.js', 'rumor2/social-runtime.js', 'rumor2/x-runtime.js', 'fly.js']) assert.ok(!readFileSync(path.join(REPO, f), 'utf8').includes('farcaster-official'), `${f}: no Farcaster transport`);
});

test('J. a true immutable conflict (same native identity, changed text/relation/parent) is retained as IMMUTABLE_FACT_CONFLICT, never rescued as a clock repair; near-duplicate text never authorizes a match', async () => {
  const c = fixtureCase('UTC', 'bsky_post', 'valid_z');
  const r = await pipeline({ path: 'bsky_post', history: [c.event], deliveries: [bsky('2026-09-06T12:00:00', { text: 'synthetic $BTC fixture!' }), bsky('2026-09-06T12:00:00', { text: 'synthetic $BTC fixture' })] });
  assert.equal(src(r.appended).length, 0); assert.equal(pend(r.appended).length, 1); assert.equal(pend(r.appended)[0].reason, 'IMMUTABLE_FACT_CONFLICT'); assert.equal(pend(r.appended)[0].candidate.text, 'synthetic $BTC fixture!');
  assert.equal(ann(r.appended).length, 1, 'the exact-text redelivery still annotates the legacy row');
  // two WITNESSED records of the same native version with non-equivalent retained declarations: DECLARATION_CONFLICT
  const v2 = socialObservationToEvent(obs('bsky_post', '2026-09-06T12:00:00.100Z')).event;
  const r2 = await pipeline({ path: 'bsky_post', history: [v2], deliveries: [bsky('2026-09-06T12:00:00.200Z'), bsky('2026-09-06T12:00:00.100000Z'), bsky('2026-09-06T08:00:00.100-04:00')] });
  assert.equal(src(r2.appended).length, 0); assert.equal(pend(r2.appended).length, 1); assert.equal(pend(r2.appended)[0].reason, 'DECLARATION_CONFLICT'); assert.equal(r2.stats.durableDuplicates + r2.rt._intake().stats().deduped + r2.rt._intake().stats().durableDeduped, 2, 'zero padding and an equivalent offset are the SAME instant under the documented rule (whichever lawful duplicate route concludes it)');
  assert.equal(r2.arr[0].sourceClockWitness.declared, '2026-09-06T12:00:00.100Z', 'the first recorded string stays intact');
});

// =========================================================================================
// K. MISSING ORIGINAL RAW VALUE   L. CORRECTION BINDING
// =========================================================================================
test('K. a legacy number is never turned into a claimed original string; a newly received declaration is later evidence with its own knownAt and an explicitly different basis', async () => {
  const c = fixtureCase('America/New_York', 'bsky_post', 'offsetless');
  assert.equal(reconstructSocialWitness(c.event).clockProvenance, 'LEGACY_NUMERIC_UNVERIFIED'); assert.equal(reconstructSocialWitness(c.event).sourceClockWitness, null, 'no declaration is recoverable from a legacy row');
  const r = await pipeline({ path: 'bsky_post', history: [c.event], deliveries: [c.msg] });
  const a = ann(r.appended)[0]; assert.equal(a.basis, 'NEW_DELIVERY_SAME_EVENT'); assert.equal(a.witness.declared, '2026-09-06T12:00:00'); assert.ok(a.evidenceRetrievedTs > c.event.retrievedTs); assert.equal(a.priorInterpretation.sourceDeclaredTs, c.event.sourceDeclaredTs, 'the legacy number is reported as what was recorded, not as the declaration');
  const forged = { ...a, basis: 'RETAINED_ORIGINAL_DECLARATION' }; assert.match(validateSocialClockInterpretation(forged, { target: c.event }), /retained no declaration/);
  // a pure code upgrade cannot establish a corrected exact time without a basis
  assert.equal(a.interpretation.established, false); assert.equal(a.interpretation.projectionMs, null);
});

test('L. correction binding: unknown provider, cross-provider target, missing/future target, wrong digest, extra fields, forged policy/outcome/precision, altered matching basis, and acquisition after knownAt all reject', async () => {
  const c = fixtureCase('UTC', 'bsky_post', 'offsetless'); const r = await pipeline({ path: 'bsky_post', history: [c.event], deliveries: [c.msg] }); const a = ann(r.appended)[0]; const t = c.event;
  const bad = (mut, re, target = t) => { const x = structuredClone(a); mut(x); assert.match(validateSocialClockInterpretation(x, { target }) ?? 'null', re); };
  assert.equal(validateSocialClockInterpretation(a, { target: t }), null);
  bad((x) => { x.provider = 'NOPE_OFFICIAL'; }, /registry/); bad((x) => { x.provider = 'FARCASTER_OFFICIAL'; }, /./); bad((x) => { x.provider = 'REDDIT_OFFICIAL'; }, /RETENTION_NOT_APPROVED/);
  assert.match(validateSocialClockInterpretation(a, { target: null }), /not durable/); assert.match(validateSocialClockInterpretation(a, { target: fixtureCase('UTC', 'fc_cast', 'valid_z').event }), /./);
  bad((x) => { x.targetDigest = 'a'.repeat(40); }, /digest/); bad((x) => { x.extra = 1; }, /undeclared/); bad((x) => { delete x.witness; }, /missing/);
  bad((x) => { x.witness = { ...x.witness, policyVersion: TEMPORAL_POLICY_VERSION + 1 }; }, /policy version/); bad((x) => { x.witness = { ...x.witness, outcome: 'INSTANT', projectionMs: T_MS }; }, /re-derived/); bad((x) => { x.witness = { ...x.witness, subMillisecondRemainder: '5' }; }, /re-derived/); bad((x) => { x.witness = { ...x.witness, policy: 'RFC3339' }; }, /role policy/);
  bad((x) => { x.nativeKey = { ...x.nativeKey, providerEventSeq: 42 }; }, /native key/); bad((x) => { x.immutableDigest = 'b'.repeat(40); }, /immutable/); bad((x) => { x.interpretation = { ...x.interpretation, established: true, projectionMs: T_MS }; }, /re-derived/); bad((x) => { x.priorInterpretation = { ...x.priorInterpretation, sourceClockStatus: 'UNKNOWN' }; }, /prior interpretation/);
  bad((x) => { x.evidenceRetrievedTs = x.knownAtTs + 1; }, /acquired after/); bad((x) => { x.knownAtTs = t.knownAtTs - 1; x.ts = iso(t.knownAtTs - 1); }, /known before its target|derived identity|acquired after/); bad((x) => { x.evidenceRetrievedTs = t.knownAtTs - 1; x.knownAtTs = t.knownAtTs - 1; x.ts = iso(t.knownAtTs - 1); }, /known before its target|derived identity/); bad((x) => { x.sourceEventId = 'r2si-' + 'c'.repeat(40); }, /derived identity/); bad((x) => { x.clockRole = 'PROVIDER_EVENT'; }, /./);
  // replay: an annotation before its target, or over a corrupt target, fails closed
  assert.match(replaySocialHistory([a, t]).error, /not durable/); assert.equal(replaySocialHistory([t, a]).ok, true); assert.match(replaySocialHistory([{ ...t, text: 'altered' }, a]).error, /SOCIAL_HISTORY_INVALID/);
  const forgedPending = { ...pend((await pipeline({ path: 'fc_recast', history: [fixtureCase('UTC', 'fc_recast', 'valid_z').event], deliveries: [rc('2026-09-06T12:00:00')] })).appended)[0] };
  assert.equal(validateSocialReconciliationPending(forgedPending), null); assert.match(validateSocialReconciliationPending({ ...forgedPending, provider: 'REDDIT_OFFICIAL' }), /RETENTION_NOT_APPROVED/); assert.match(validateSocialReconciliationPending({ ...forgedPending, candidate: { ...forgedPending.candidate, text: 'x' } }), /./); assert.match(validateSocialReconciliationPending({ ...forgedPending, reason: 'GUESSED' }), /reason/);
});

// =========================================================================================
// M. AS-OF ISOLATION
// =========================================================================================
test('M. as-of view: before T1 the correction is invisible; at/after T1 it applies; first-known stays T0; original and effective never mutate each other; a legacy clock is never precision-verified', async () => {
  const c = fixtureCase('Asia/Kolkata', 'bsky_post', 'offsetless'); const T0 = c.event.knownAtTs; const T1 = LATER;
  const r = await pipeline({ path: 'bsky_post', history: [c.event], deliveries: [c.msg], nowMs: T1 }); const a = ann(r.appended)[0]; assert.equal(a.knownAtTs, T1);
  const snapEvent = canonicalJson(c.event); const snapAnn = canonicalJson(a);
  const before = socialTemporalView({ event: c.event, annotations: [a], asOfTs: T1 - 1 }); assert.equal(before.ok, true);
  assert.equal(before.effective.sourceDeclaredTs, c.event.sourceDeclaredTs, 'no hindsight leakage'); assert.equal(before.effective.provenance, 'LEGACY_NUMERIC_UNVERIFIED'); assert.equal(before.effective.precisionVerified, false); assert.deepEqual(before.appliedAnnotations, []); assert.equal('withheldAnnotations' in before, false, 'no hindsight channel: withheld future records are not exposed'); assert.equal(before.conflict, null);
  assert.equal(socialTemporalView({ event: c.event, annotations: [a], asOfTs: T0 - 1 }).status, 'NOT_YET_KNOWN', 'before its first-known time the event is not admissible at all');
  const at = socialTemporalView({ event: c.event, annotations: [a], asOfTs: T1 }); assert.deepEqual(at.appliedAnnotations, [a.sourceEventId]); assert.equal(at.effective.sourceDeclaredTs, null); assert.equal(at.effective.sourceClockStatus, 'UNKNOWN'); assert.equal(at.effective.provenance, 'LATER_EVIDENCE_SAME_EVENT'); assert.equal(at.effective.interpretationKnownAtTs, T1);
  assert.equal(at.original.firstKnownAtTs, T0); assert.equal(at.effective.firstKnownAtTs, T0); assert.equal(at.original.sourceDeclaredTs, c.event.sourceDeclaredTs, 'ORIGINAL_RECORDED is untouched');
  const after = socialTemporalView({ event: c.event, annotations: [a], asOfTs: T1 + 86_400_000 }); assert.deepEqual(after.appliedAnnotations, [a.sourceEventId]);
  assert.equal(canonicalJson(c.event), snapEvent); assert.equal(canonicalJson(a), snapAnn); assert.throws(() => { at.effective.sourceDeclaredTs = 1; }, 'views are frozen');
  assert.equal(socialTemporalView({ event: c.event, annotations: [a], asOfTs: 'now' }).ok, false); assert.equal(socialTemporalView({ event: c.event, annotations: [{ ...a, targetDigest: 'a'.repeat(40) }], asOfTs: T1 }).ok, false);
  // a corrected time cannot improve a backtest before T1: the effective clock at asOf < T1 is exactly the recorded one
  assert.equal(before.effective.sourceCreatedTs, c.event.sourceCreatedTs);
  // an ORDER_UNRESOLVED correction on a same-id legacy row
  const ch = fixtureCase('UTC', 'bsky_post', 'edge_half_ms'); const rh = await pipeline({ path: 'bsky_post', history: [ch.event], deliveries: [ch.msg], nowMs: T1 }); const ah = ann(rh.appended)[0];
  const vh = socialTemporalView({ event: ch.event, annotations: [ah], asOfTs: T1 }); assert.equal(vh.original.sourceClockStatus, 'TRUSTED'); assert.equal(vh.effective.sourceClockStatus, 'ORDER_UNRESOLVED'); assert.equal(vh.effective.sourceCreatedTs, null); assert.equal(vh.effective.sourceClockWitness.subMillisecondRemainder, '5');
});

// =========================================================================================
// N. RESTART / CACHE EVICTION / DUPLICATE IN SAME BATCH   O. LOOKUP UNAVAILABLE
// =========================================================================================
test('N. after the first reconciliation, redelivery in a fresh process, past a tiny local cache, or twice in one batch adds no source and no repeat annotation', async () => {
  const c = fixtureCase('UTC', 'bsky_post', 'offsetless');
  const first = await pipeline({ path: 'bsky_post', history: [c.event], deliveries: [c.msg, c.msg, structuredClone(c.msg)], seenCap: 1 });
  assert.equal(ann(first.appended).length, 1, 'three equivalent candidates in one batch resolve once'); assert.equal(src(first.appended).length, 0);
  const fresh = await pipeline({ path: 'bsky_post', history: first.arr, deliveries: [c.msg, c.msg], seenCap: 1 });
  assert.equal(src(fresh.appended).length + ann(fresh.appended).length + pend(fresh.appended).length, 0, 'a fresh process hydrated from the journal repeats nothing'); assert.equal(fresh.stats.durableDuplicates + fresh.rt._intake().stats().deduped, 2);
  // the cheap intake path: a witnessed candidate facing a LEGACY durable id is NOT short-circuited until reconciled
  const rec = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); rec.hydrate(replaySocialHistory([fixtureCase('UTC', 'bsky_post', 'edge_half_ms').event]));
  const o = obs('bsky_post', fixtureCase('UTC', 'bsky_post', 'edge_half_ms').input, {}, LATER); assert.equal(rec.isFastDurable(o.socialVersionId, o), false, 'same id, legacy format: settle must decide');
  const out = rec.reconcile(o, rec.batch({ knownAtTs: LATER })); assert.equal(out.kind, 'ANNOTATE'); rec.adopt(out.events); assert.equal(rec.isFastDurable(o.socialVersionId, o), true, 'reconciled: the cheap path may now absorb the exact redelivery');
  const different = obs('bsky_post', '2026-09-06T14:00:00.0006Z', {}, LATER); assert.equal(rec.isFastDurable(different.socialVersionId, different), false, 'a different declaration under the same id is not silently absorbed');
});

test('O. an unavailable lookup never means "not found": nothing is appended, no cursor advances, the envelopes stay owed, and the same batch settles once the lookup returns', async () => {
  const c = fixtureCase('UTC', 'bsky_post', 'offsetless');
  const [provider, mapCommit, cursorOf] = MAP.bsky_post; const arr = [c.event]; const j = memJournal(arr);
  const rt = createSocialRuntime({ provider, mapCommit, cursorOf, filter: FILTER, now: () => LATER, mode: 'REPLAY', fixtures: [c.msg, bsky(T_Z, { seq: 50, rkey: 'k50', cid: 'c50' })], log: () => {} });
  assert.equal(rt.hydrate(arr).ok, true); rt.start();
  const failed = await rt.settle({ append: (e) => j.append(e), lookup: async () => ({ ok: false, reason: 'UNAVAILABLE' }) });
  assert.equal(failed.ok, false); assert.equal(failed.reason, 'UNAVAILABLE'); assert.equal(arr.length, 1); assert.equal(rt.durableCursor(), null); assert.equal(rt._intake().pendingCount(), 2, 'both frames still owed');
  const ok = await rt.settle({ append: (e) => j.append(e), lookup: async (type, ids) => ({ ok: true, existing: new Set(arr.filter((e) => e.type === type && ids.includes(e.sourceEventId)).map((e) => e.sourceEventId)) }) });
  assert.equal(ok.ok, true); assert.equal(src(arr).length, 2); assert.equal(ann(arr).length, 1); assert.equal(rt.durableCursor(), 50); assert.equal(rt._intake().pendingCount(), 0);
});

// =========================================================================================
// Q (pure part). MIXED HISTORY REPLAY   R. AUTHORITY AND RETENTION
// =========================================================================================
test('Q. mixed legacy/v2/interpretation/pending/cursor/X-operational history replays as one validated whole; every new type is admitted AND validated; the frozen core excludes them; corrupt rows still fail', async () => {
  const c = fixtureCase('UTC', 'bsky_post', 'offsetless'); const r = await pipeline({ path: 'bsky_post', history: [c.event], deliveries: [c.msg, bsky(T_Z, { seq: 60, rkey: 'k60', cid: 'c60' })] });
  const rp = await pipeline({ path: 'fc_recast', history: [fixtureCase('UTC', 'fc_recast', 'valid_z').event], deliveries: [rc('2026-09-06T12:00:00')] });
  const xr = xRuleSetEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), ruleTags: ['serpent:origin:v1'], coverageEpoch: 1, activatedKnownAtTs: NOW, knownAtTs: NOW });
  const mixed = [...r.arr, ...rp.arr, xr, xProgressEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), coverageEpoch: 1, throughKnownAtTs: NOW + 1, knownAtTs: NOW + 2 })];
  const types = new Set(mixed.map((e) => e.type)); for (const t of [SOCIAL_EVENT_TYPE, SOCIAL_EVENT_V2_TYPE, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE]) assert.ok(types.has(t), `history carries ${t}`);
  const rep = replaySocialHistory(mixed); assert.equal(rep.ok, true, rep.error); assert.equal(rep.observed, 3); assert.equal(rep.annotated, 1); assert.equal(rep.pending, 1); assert.equal(rep.cursors.BLUESKY_OFFICIAL, 60); assert.equal(rep.x.coverageEpoch, 1);
  for (const e of mixed) assert.equal(isSocialEventType(e.type), true, `${e.type} is excluded from the frozen core AND validated here`);
  // corruption: an altered v2 payload under the same id, a forged pending record, an annotation whose target was altered
  const v2 = mixed.find((e) => e.type === SOCIAL_EVENT_V2_TYPE); assert.match(replaySocialHistory([...mixed, { ...v2, text: 'altered' }]).error, /altered payload|derived/);
  const pd = mixed.find((e) => e.type === SOCIAL_RECONCILIATION_PENDING_TYPE); assert.match(replaySocialHistory([...mixed, { ...pd, reason: 'MULTIPLE_CANDIDATES' }]).error, /derived identity|names at least two targets/);
  assert.match(replaySocialHistory([{ type: 'RUMOR2_SOCIAL_OBSERVED_V3', sourceEventId: 'x' }]).ok ? 'ok' : 'unknown-type-ignored', /ok|unknown/); // an unknown type is the frozen core's to refuse (unchanged law)
});

test('R. new records are Social evidence/diagnostics only: no authority fields, retention firewalls hold for annotations and pending records, legacy RUMINT and MISSION are untouched, logical source counts never grow from annotations', async () => {
  const c = fixtureCase('UTC', 'x_post', 'zero'); const r = await pipeline({ path: 'x_post', history: [c.event], deliveries: [c.msg] });
  for (const e of r.appended) { const blob = JSON.stringify(e).toLowerCase(); for (const k of ['claim', 'proposition', 'attention', 'hyped', 'eligib', 'order', 'size', 'strike', 'model']) assert.ok(!blob.includes(`"${k}`), `${e.type} carries no ${k} field`); }
  const rp = replaySocialHistory(r.arr); assert.equal(rp.observed, 1); assert.equal(rp.durableIds.size, 1, 'one logical source before and after the annotation'); assert.equal(r.arr.length, 2, 'physical growth is legitimate');
  const target = c.event; const bogus = socialClockInterpretationEvent({ target: { ...target, provider: 'REDDIT_OFFICIAL' }, clockRole: 'SOURCE_DECLARATION', basis: 'NEW_DELIVERY_SAME_EVENT', witness: temporalWitness('0', P.ISO8601_PROFILE), evidenceRetrievedTs: LATER, knownAtTs: LATER });
  assert.match(validateSocialClockInterpretation(bogus, { target: { ...target, provider: 'REDDIT_OFFICIAL' } }), /RETENTION_NOT_APPROVED/);
  for (const f of execSync("git ls-files 'rumint/*.js' 'doctrine/MISSION.md' 'rumor2/truth.js' 'persistence/*.js'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n')) assert.ok(!readFileSync(path.join(REPO, f), 'utf8').includes('social-time') && !readFileSync(path.join(REPO, f), 'utf8').includes('social-reconcile'), `${f} untouched by the temporal integration`);
  const mission = readFileSync(path.join(REPO, 'doctrine/MISSION.md'), 'utf8'); assert.ok(mission.includes('We do not reject pumps')); assert.ok(mission.includes('price extension is context'));
});

// =========================================================================================
// P + Q (durable). REAL POSTGRESQL: append failure, crash before adoption, writer takeover,
// restart idempotency, legacy journal restore, collector validation with the gate OFF
// =========================================================================================
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-4D COMPLETION durable integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { startRumor2 } = await import('../rumor2/collector.js');
  const withDb = async (fn) => {
    const SCHEMA = `soc4d_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, mkJournal: () => rumor2JournalStore({ persistence }), mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => { const { rows } = await ownAdvisoryHolders(admin); for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {}); return rows.length; };
  const events = async (j) => (await j.read()).events;
  const acquire = async (j) => { const w = await j.acquireWriter(); assert.equal(w.ok, true); return w; };
  const bootRt = ({ fixtures, nowMs = LATER, seenCap }) => createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => nowMs, mode: 'REPLAY', fixtures, log: () => {}, intakeOptions: seenCap ? { seenCap } : {} });
  const settleWith = (rt, j, fenceHeld = () => true, append = (e) => j.append(e)) => rt.settle({ fenceHeld, append, lookup: (t, ids) => j.hasEventIds(t, ids) });

  test('P1 (PG). a journal written by the legacy d5db393 code restores under the candidate; every row, id, sequence, and diagnostic stays unchanged; a strict redelivery resolves to the canonical row and its annotation survives a fresh-process replay exactly once', async () => {
    await withDb(async ({ mkJournal }) => {
      // distinct native keys only (the corpus reuses seq 41 across clock variants; a real feed has one declaration per commit)
      const legacy = ['offsetless', 'seq10', 'seq20', 'delete_seq11', 'reply'].map((l) => fixtureCase('America/New_York', 'bsky_post', l).event);
      const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append(legacy)).ok, true); await jA.releaseWriter();
      const before = (await events(mkJournal())).map((e) => canonicalJson(e));
      const jB = mkJournal(); await acquire(jB);
      const B = bootRt({ fixtures: ['offsetless', 'seq10', 'seq20'].map((l) => fixtureCase('America/New_York', 'bsky_post', l).msg) });
      const h = B.hydrate(await events(jB)); assert.equal(h.ok, true); assert.equal(h.durableIds, legacy.length); B.start();
      const r = await settleWith(B, jB); assert.equal(r.ok, true); assert.equal(r.appended, 0, 'no source appended'); assert.equal(B.status().stats.annotations, 1, 'offsetless annotated; seq10/seq20 known');
      B.stop(); await jB.releaseWriter();
      const all = await events(mkJournal()); assert.deepEqual(all.slice(0, legacy.length).map((e) => canonicalJson(e)), before, 'legacy rows byte-identical'); assert.equal(ann(all).length, 1); assert.equal(src(all).length, legacy.length);
      // fresh process: replay validates the annotations; the same redelivery repeats nothing
      const jC = mkJournal(); await acquire(jC); const C = bootRt({ fixtures: ['offsetless', 'offsetless'].map((l) => fixtureCase('America/New_York', 'bsky_post', l).msg), seenCap: 1 });
      const hc = C.hydrate(await events(jC)); assert.equal(hc.ok, true); C.start(); const rc2 = await settleWith(C, jC); assert.equal(rc2.ok, true); assert.equal((await events(jC)).length, all.length, 'idempotent after restart'); C.stop(); await jC.releaseWriter();
      const rep = replaySocialHistory(await events(mkJournal())); assert.equal(rep.ok, true); assert.equal(rep.observed, legacy.length); assert.equal(rep.annotated, 1);
      const view = socialTemporalView({ event: legacy[0], annotations: rep.annotations.get(legacy[0].sourceEventId), asOfTs: LATER }); assert.equal(view.ok, true); assert.equal(view.effective.sourceDeclaredTs, null); assert.equal(view.original.sourceDeclaredTs, legacy[0].sourceDeclaredTs);
    });
  });

  test('P2 (PG). append failure keeps the prepared batch byte-identical for retry; crash after append before adoption replays safely; a stale writer epoch mutates nothing; no cursor moves ahead of its durable disposition', async () => {
    await withDb(async ({ mkJournal, admin }) => {
      const legacy = [fixtureCase('UTC', 'bsky_post', 'offsetless').event]; const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append(legacy)).ok, true); await jA.releaseWriter();
      const j = mkJournal(); await acquire(j);
      const rt = bootRt({ fixtures: [fixtureCase('UTC', 'bsky_post', 'offsetless').msg, bsky(T_Z, { seq: 70, rkey: 'k70', cid: 'c70' })] }); assert.equal(rt.hydrate(await events(j)).ok, true); rt.start();
      let attempts = 0; const captured = [];
      const failing = async (evs) => { attempts += 1; captured.push(canonicalJson(evs)); if (attempts === 1) return { ok: false, reason: 'UNAVAILABLE' }; return j.append(evs); };
      const f1 = await settleWith(rt, j, () => true, failing); assert.equal(f1.ok, false); assert.equal(rt.durableCursor(), null); assert.equal((await events(j)).length, 1);
      const f2 = await settleWith(rt, j, () => true, failing); assert.equal(f2.ok, true); assert.equal(captured[0], captured[1], 'the retried batch is byte-identical'); assert.equal(rt.durableCursor(), 70);
      const all = await events(j); assert.equal(src(all).length, 2); assert.equal(ann(all).length, 1); assert.equal(all.filter((e) => e.type === SOCIAL_CURSOR_EVENT_TYPE).length, 1);
      // crash after append, before adoption: a NEW process resumes from the durable cursor; redelivery repeats nothing
      const j2 = mkJournal(); rt.stop(); await j.releaseWriter(); await acquire(j2);
      const rt2 = bootRt({ fixtures: [fixtureCase('UTC', 'bsky_post', 'offsetless').msg, bsky(T_Z, { seq: 70, rkey: 'k70', cid: 'c70' })] }); const h2 = rt2.hydrate(await events(j2)); assert.equal(h2.ok, true); assert.equal(h2.durableCursor, 70); rt2.start();
      const r2 = await settleWith(rt2, j2); assert.equal(r2.ok, true); assert.equal((await events(j2)).length, all.length, 'nothing repeated');
      // stale writer epoch (takeover): no mutation, the ear stops
      const killed = await killAdvisoryBackends(admin); assert.ok(killed >= 1);
      rt2._feed(JSON.stringify(bsky(T_Z, { seq: 80, rkey: 'k80', cid: 'c80' })));
      const r3 = await settleWith(rt2, j2, () => false); assert.equal(r3.ok, false); assert.equal(r3.reason, 'WRITER_FENCE_LOST'); assert.equal((await events(mkJournal())).length, all.length, 'no mutation after fence loss'); assert.equal(rt2.isActive(), false);
    });
  });

  test('Q (PG). the collector validates Social history on restore with the provider gate OFF; corrupt Social history withholds fail-closed before any provider is enabled; a clean mixed history restores and, once enabled, hydrates the same history', async () => {
    await withDb(async ({ mkStores }) => {
      const seed = (msgs, history = []) => { const d = mkdtempSync(path.join(tmpdir(), 'cobra-soc4dq-')); process.env.COBRA_DATA_DIR = d; return d; };
      const H = { get: () => null }; const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
      const boot = ({ checkpointStore, journal, social = {} }) => { seed(); const clock = { ms: NOW }; const c = startRumor2({ log: () => {}, config: { universe: ['BTC', 'ETH', 'SOL'], socialResearch: { localAdmission: { mode: 'EXPLICIT_STATIC', policyVersion: 1, staticTerms: ['BTC', 'ETH', 'SOL'] } } }, fetchImpl: async () => mkRes(304, ''), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000, ...social }); return { c, tick: async () => ((clock.ms += 4_000_000), await c.tickOnce()) }; };
      // 1. write a clean mixed Social history through the Bluesky ear (gate ON)
      const a = boot({ ...mkStores(), social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [bsky(T_Z, { seq: 100, rkey: 'k100', cid: 'c100' }), bsky('2026-09-06T12:00:00', { seq: 101, rkey: 'k101', cid: 'c101' })] } });
      await a.tick(); assert.ok(['FRESH_START', 'RESTORED'].includes(a.c.status().lifecycle), a.c.status().lifecycle); await a.c.stop();
      const j = mkStores().journal; const hist = (await j.read()).events; assert.equal(src(hist).length, 2); assert.ok(hist.some((e) => e.type === SOCIAL_EVENT_V2_TYPE));
      // 2. gate OFF: the collector still validates that history (clean => RESTORED)
      const off = boot({ ...mkStores() }); await off.tick(); assert.equal(off.c.status().lifecycle, 'RESTORED'); assert.equal(off.c.status().social.state, 'DARK'); await off.c.stop();
      // 3. gate OFF with CORRUPT Social history: withheld fail-closed — a later enablement can never reveal unchecked history
      assert.equal((await j.acquireWriter()).ok, true); const forged = { ...src(hist)[0], sourceEventId: 'r2sv-' + 'c'.repeat(40), nativePostId: 'at://did:plc:a/app.bsky.feed.post/forged' }; assert.equal((await j.append([forged])).ok, true); await j.releaseWriter();
      const offCorrupt = boot({ ...mkStores() }); await offCorrupt.tick(); assert.equal(offCorrupt.c.status().lifecycle, 'WITHHELD_INVALID_CHECKPOINT'); assert.match(offCorrupt.c.status().withholdReason, /SOCIAL_HISTORY_INVALID/); await offCorrupt.c.stop();
      const on = boot({ ...mkStores(), social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [] } }); await on.tick(); assert.equal(on.c.status().lifecycle, 'WITHHELD_INVALID_CHECKPOINT'); await on.c.stop();
    });
  });
}
