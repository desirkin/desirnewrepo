// RUMINT-R1 drills — the pure truth core: canonical message IDs, same-page
// duplicates, observed-zero vs unobserved hours, honest z/acceleration
// reasons, HYPED session semantics with coverage, DST-safe hour identity,
// strict checkpoint validation, and the Memory adapter preserving it all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-rumint-r1-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
delete process.env.RUMINT_ENABLED;

const {
  canonicalMessageId,
  idGreater,
  utcHourKey,
  emptyBaseline,
  ingestPage,
  signalFromBaseline,
  hypedSnapshot,
  validateCheckpoint,
  pollEventIdentity,
  nominationEventIdentity,
  rumintIdentity,
  bucketObserved,
  MAX_SEEN_IDS,
  RUMINT_CHECKPOINT_VERSION,
  COVERAGE_BOOTSTRAPPED,
  COVERAGE_SAMPLED,
} = await import('../rumint/truth.js');
const { shouldNominate } = await import('../rumint/poller.js');
const adapters = await import('../memory/adapters.js');
const { attentionContinuityMeaning } = await import('../memory/attention.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-02T18:30:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

// a baseline whose watermark is already initialized at id 100
function wm100(sym = 'T.X', seedMs = NOW - 90 * 60_000) {
  const b = emptyBaseline(sym, sym.replace(/\.X$/, ''));
  const { baseline } = ingestPage(b, [{ id: 100, created_at: new Date(seedMs - 30 * 60_000).toISOString() }], seedMs);
  assert.equal(baseline.lastMsgId, '100');
  return baseline;
}

// ---- §25/§73 message ID safety --------------------------------------------
test('R1 §25: canonical message IDs — exact decimal normalization, exact BigInt ordering', () => {
  assert.equal(canonicalMessageId(663502465), '663502465');
  assert.equal(canonicalMessageId('663502465'), '663502465');
  assert.equal(canonicalMessageId('000123'), '123'); // canonical form, no leading zeros
  assert.equal(canonicalMessageId('99999999999999999999'), '99999999999999999999'); // beyond float precision, exact
  assert.equal(canonicalMessageId(99999999999999999999), null); // unsafe numeric representation: unknowable, rejected
  assert.equal(canonicalMessageId(null), null);
  assert.equal(canonicalMessageId(undefined), null);
  assert.equal(canonicalMessageId('abc'), null);
  assert.equal(canonicalMessageId(-5), null);
  assert.equal(canonicalMessageId(3.7), null);
  assert.equal(canonicalMessageId('3.7'), null);
  assert.equal(canonicalMessageId(0), null);
  assert.equal(canonicalMessageId({}), null);
  // no lexicographic bug: '9' < '10' numerically even though '9' > '1...' as text
  assert.equal(idGreater('10', '9'), true);
  assert.equal(idGreater('99999999999999999998', '99999999999999999999'), false);
});

test('R1 §73: invalid IDs never increment chatter and are exactly counted', () => {
  const { baseline, stats } = ingestPage(
    wm100(),
    [
      { id: 101, created_at: at(5) },
      { id: 'zzz', created_at: at(5) },
      { id: -4, created_at: at(5) },
      { id: 7.5, created_at: at(5) },
      { id: null, created_at: at(5) },
      { created_at: at(5) },
    ],
    NOW
  );
  assert.equal(stats.accepted, 1);
  assert.equal(stats.invalidId, 5);
  const total = Object.values(baseline.buckets).reduce((s, b) => s + b.count, 0);
  assert.equal(total, 1);
});

// ---- §26/§27/§72 dedupe and order independence ----------------------------
test('R1 §26: same-page duplicate IDs count once (105,105,104 above watermark 100 -> 2)', () => {
  const { stats } = ingestPage(
    wm100(),
    [
      { id: 105, created_at: at(4) },
      { id: 105, created_at: at(4) },
      { id: 104, created_at: at(6) },
    ],
    NOW
  );
  assert.equal(stats.accepted, 2);
  assert.equal(stats.duplicateSamePage, 1);
});

test('R1 §27/§72: ingestion is order independent — newest-first and oldest-first agree exactly', () => {
  const page = (ids) => ids.map((id, i) => ({ id, created_at: at(10 + i) }));
  const a = ingestPage(wm100(), page([105, 104, 103]), NOW);
  const b = ingestPage(wm100(), page([103, 104, 105]), NOW);
  assert.equal(a.stats.accepted, 3);
  assert.equal(b.stats.accepted, 3);
  assert.equal(a.baseline.lastMsgId, '105');
  assert.equal(b.baseline.lastMsgId, '105');
  const counts = (x) => Object.fromEntries(Object.entries(x.baseline.buckets).map(([k, v]) => [k, v.count]));
  assert.deepEqual(counts(a), counts(b));
});

test('R1 §30: a later unseen valid ID below the max ID is NOT rejected by the high-water mark alone', () => {
  let b = wm100();
  ({ baseline: b } = ingestPage(b, [{ id: 105, created_at: at(8) }], NOW - 60_000));
  assert.equal(b.lastMsgId, '105');
  // 102 was never seen (single-page sampling missed it); it is a valid new message
  const { stats, baseline } = ingestPage(b, [{ id: 102, created_at: at(7) }], NOW);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.alreadySeen, 0);
  assert.equal(baseline.lastMsgId, '105'); // high-water mark stays diagnostic
});

test('R1 §30: seen-ID cache is hard-bounded and eviction is counted degradation', () => {
  let b = wm100();
  const msgs = Array.from({ length: MAX_SEEN_IDS + 40 }, (_, i) => ({ id: 200 + i, created_at: at(3) }));
  ({ baseline: b } = ingestPage(b, msgs, NOW));
  assert.ok(b.recentSeenMessageIds.length <= MAX_SEEN_IDS);
  assert.ok(b.seenIdEvictions > 0, 'evictions are exposed, never silent');
});

// ---- §31 message age ------------------------------------------------------
test('R1 §31: ancient replay is rejected and counted; late-but-legitimate updates its correct hour', () => {
  const { stats, baseline } = ingestPage(
    wm100(),
    [
      { id: 300, created_at: new Date(NOW - 30 * 3_600_000).toISOString() }, // 30h old: ancient
      { id: 301, created_at: at(150) }, // 2.5h old: late but within window
      { id: 302, created_at: new Date(NOW + 30 * 60_000).toISOString() }, // future beyond skew: invalid
    ],
    NOW
  );
  assert.equal(stats.ancientRejected, 1);
  assert.equal(stats.invalidTimestamp, 1);
  assert.equal(stats.accepted, 1);
  const lateKey = utcHourKey(NOW - 150 * 60_000);
  assert.equal(baseline.buckets[lateKey].count, 1); // landed in ITS hour, not the current one
  assert.equal(bucketObserved(baseline.buckets[lateKey]), false, 'a late message does not make its hour observed');
});

// ---- §16/§17/§18/§19/§66/§67 observed vs unobserved -----------------------
test('R1 §16/§66: observed zero hours are evidence and mature history to z evaluability', () => {
  let b = wm100('OZ.X');
  // 25 successful polls, one per past hour, alternating 0 and 2 accepted msgs
  let id = 500;
  for (let h = 25; h >= 1; h--) {
    const t = NOW - h * 3_600_000;
    const msgs = h % 2 === 0 ? [{ id: id++, created_at: new Date(t - 60_000).toISOString() }, { id: id++, created_at: new Date(t - 30_000).toISOString() }] : [];
    ({ baseline: b } = ingestPage(b, msgs, t));
  }
  ({ baseline: b } = ingestPage(b, [], NOW)); // current hour observed, zero msgs
  const s = signalFromBaseline(b, NOW, { zThreshold: 3 });
  assert.ok(s.historyBucketCount >= 24, `observed zero hours count: ${s.historyBucketCount}`);
  assert.equal(s.zReason, 'KNOWN'); // variance exists (0s and 2s)
  assert.notEqual(s.zVelocity, null);
});

test('R1 §17/§67: an unobserved hour is UNKNOWN — never synthesized as zero, and it breaks acceleration', () => {
  let b = wm100('UO.X', NOW - 30 * 3_600_000);
  let id = 700;
  for (let h = 26; h >= 1; h--) {
    if (h === 1) continue; // OUTAGE: the previous hour was never polled
    const t = NOW - h * 3_600_000;
    ({ baseline: b } = ingestPage(b, [{ id: id++, created_at: new Date(t - 60_000).toISOString() }], t));
  }
  ({ baseline: b } = ingestPage(b, [], NOW));
  const s = signalFromBaseline(b, NOW, { zThreshold: 3 });
  assert.equal(s.previousHourCount, null); // not zero — UNKNOWN
  assert.equal(s.acceleration, null);
  assert.equal(s.accelerationReason, 'INSUFFICIENT_CONTIGUOUS_OBSERVATION');
  assert.equal(b.buckets[utcHourKey(NOW - 3_600_000)], undefined, 'no bucket invented for the outage hour');
});

test('R1 §19: zero variance is explicit and distinct from insufficient history', () => {
  let b = wm100('ZV.X');
  let id = 900;
  for (let h = 26; h >= 1; h--) {
    const t = NOW - h * 3_600_000;
    ({ baseline: b } = ingestPage(b, [{ id: id++, created_at: new Date(t - 60_000).toISOString() }], t)); // exactly 1 msg every hour
  }
  ({ baseline: b } = ingestPage(b, [], NOW));
  const s = signalFromBaseline(b, NOW, { zThreshold: 3 });
  assert.ok(s.historyBucketCount >= 24);
  assert.equal(s.zVelocity, null);
  assert.equal(s.zReason, 'ZERO_VARIANCE');
  assert.equal(s.decision, 'ZERO_VARIANCE');
});

// ---- §21/§78/§79 gates ----------------------------------------------------
test('R1 §79: nomination thresholds are UNCHANGED — 2.999 no, 3.0+accel 0 no, 3.0+accel>0 yes', () => {
  const cfg = { rumint: { zThreshold: 3 } };
  assert.equal(shouldNominate({ zVelocity: 2.999, acceleration: 5 }, cfg), false);
  assert.equal(shouldNominate({ zVelocity: 3.0, acceleration: 0 }, cfg), false);
  assert.equal(shouldNominate({ zVelocity: 3.0, acceleration: 0.1 }, cfg), true);
  assert.equal(shouldNominate({ zVelocity: null, acceleration: 9 }, cfg), false);
  assert.equal(shouldNominate({ zVelocity: 9, acceleration: null }, cfg), false); // unknown acceleration never passes
});

test('R1 §21/§78: every gate outcome carries its exact controlled reason', () => {
  // Z_BELOW_THRESHOLD: mature varied history, quiet current hour
  let b = wm100('GA.X', NOW - 30 * 3_600_000);
  let id = 1200;
  for (let h = 26; h >= 1; h--) {
    const t = NOW - h * 3_600_000;
    const n = h % 2 === 0 ? 2 : 0;
    const msgs = Array.from({ length: n }, () => ({ id: id++, created_at: new Date(t - 60_000).toISOString() }));
    ({ baseline: b } = ingestPage(b, msgs, t));
  }
  ({ baseline: b } = ingestPage(b, [], NOW));
  const s1 = signalFromBaseline(b, NOW, { zThreshold: 3 });
  assert.equal(s1.decision, 'Z_BELOW_THRESHOLD');
  assert.equal(s1.gates.zAvailable, true);
  assert.equal(s1.gates.zPass, false);
  // ACCELERATION_UNAVAILABLE: huge spike but the prior hour was unobserved
  let c = wm100('GB.X', NOW - 30 * 3_600_000);
  id = 2200;
  for (let h = 27; h >= 2; h--) {
    if (h === 1) continue;
    const t = NOW - h * 3_600_000;
    const n = h % 2 === 0 ? 2 : 0;
    const msgs = Array.from({ length: n }, () => ({ id: id++, created_at: new Date(t - 60_000).toISOString() }));
    ({ baseline: c } = ingestPage(c, msgs, t));
  }
  const spike = Array.from({ length: 40 }, () => ({ id: id++, created_at: new Date(NOW - 60_000).toISOString() }));
  ({ baseline: c } = ingestPage(c, spike, NOW));
  const s2 = signalFromBaseline(c, NOW, { zThreshold: 3 });
  assert.ok(s2.zVelocity > 3, `z=${s2.zVelocity}`);
  assert.equal(s2.decision, 'ACCELERATION_UNAVAILABLE');
  assert.equal(s2.acceleration, null); // an outage never manufactures positive acceleration
});

// ---- §35-§37/§42/§64 HYPED semantics --------------------------------------
function overnightBaselines({ counts, missingHourFor = null }) {
  // Session 2026-09-02 (EDT): overnight ET hours 00-05 = 04:00-09:59Z.
  const start = Date.parse('2026-09-02T04:00:00Z');
  const out = {};
  let id = 10_000;
  for (const [coin, n] of Object.entries(counts)) {
    const sym = `${coin}.X`;
    let b = emptyBaseline(sym, coin);
    ({ baseline: b } = ingestPage(b, [{ id: id++, created_at: new Date(start - 3_600_000).toISOString() }], start - 3_600_000));
    for (let h = 0; h < 6; h++) {
      if (coin === missingHourFor && h === 2) continue; // one unobserved overnight hour
      const t = start + h * 3_600_000 + 20 * 60_000;
      const msgs = h === 3 ? Array.from({ length: n }, () => ({ id: id++, created_at: new Date(t - 60_000).toISOString() })) : [];
      ({ baseline: b } = ingestPage(b, msgs, t));
    }
    out[sym] = b;
  }
  return out;
}
const AFTER_SIX_ET = Date.parse('2026-09-02T12:00:00Z'); // 08:00 ET

test('R1 §36: partial overnight coverage never ranks and missing hours are never zeros', () => {
  const baselines = overnightBaselines({ counts: { AAA: 50, BBB: 5 }, missingHourFor: 'AAA' });
  const snap = hypedSnapshot({ baselines, atMs: AFTER_SIX_ET });
  assert.equal(snap.coverage.insufficientSymbols, 1); // AAA missed an hour: ineligible, not zero-filled
  assert.equal(snap.coverage.eligibleSymbols, 1);
  assert.equal(snap.state, 'READY');
  assert.deepEqual(snap.symbols, ['BBB']); // only the fully observed symbol ranks
});

test('R1 §36: no eligible symbols -> PARTIAL with reason, never a fake H0', () => {
  const baselines = overnightBaselines({ counts: { AAA: 50 }, missingHourFor: 'AAA' });
  const snap = hypedSnapshot({ baselines, atMs: AFTER_SIX_ET });
  assert.equal(snap.state, 'PARTIAL');
  assert.deepEqual(snap.symbols, []);
  assert.equal(snap.coverage.reason, 'INSUFFICIENT_OVERNIGHT_COVERAGE');
});

test('R1 §37: eligible symbols with zero chatter -> truthful EMPTY (a REAL H0)', () => {
  const baselines = overnightBaselines({ counts: { AAA: 0, BBB: 0 } });
  const snap = hypedSnapshot({ baselines, atMs: AFTER_SIX_ET });
  assert.equal(snap.state, 'EMPTY');
  assert.deepEqual(snap.symbols, []);
  assert.equal(snap.coverage.eligibleSymbols, 2);
});

test('R1 §42/§64: HYPED identity is deterministic per session; a new ET date rolls back to BUILDING', () => {
  const baselines = overnightBaselines({ counts: { AAA: 50, BBB: 5 } });
  const a = hypedSnapshot({ baselines, atMs: AFTER_SIX_ET });
  const b = hypedSnapshot({ baselines, atMs: AFTER_SIX_ET + 3_600_000 });
  assert.equal(a.identity, b.identity); // same session, same set -> same identity (restart dedupes)
  assert.equal(a.state, 'READY');
  // next ET date, 00:30 ET = 04:30Z on 2026-09-03
  const next = hypedSnapshot({ baselines, atMs: Date.parse('2026-09-03T04:30:00Z') });
  assert.equal(next.state, 'BUILDING');
  assert.equal(next.sessionDate, '2026-09-03');
  assert.deepEqual(next.symbols, []); // yesterday's HYPED is never worn as today's
});

// ---- §92 DST correctness --------------------------------------------------
test('R1 §92: the two 01:00 ET hours of a fall-back night stay distinct buckets', () => {
  // US DST fall-back 2025-11-02: 01:30 EDT = 05:30Z, 01:30 EST = 06:30Z
  let b = emptyBaseline('DST.X', 'DST');
  const t0 = Date.parse('2025-11-02T04:00:00Z');
  ({ baseline: b } = ingestPage(b, [{ id: 1, created_at: new Date(t0).toISOString() }], t0));
  const first = Date.parse('2025-11-02T05:30:00Z');
  const second = Date.parse('2025-11-02T06:30:00Z');
  ({ baseline: b } = ingestPage(b, [{ id: 2, created_at: new Date(first).toISOString() }], first));
  ({ baseline: b } = ingestPage(b, [{ id: 3, created_at: new Date(second).toISOString() }], second));
  const k1 = utcHourKey(first);
  const k2 = utcHourKey(second);
  assert.notEqual(k1, k2); // absolute identity: no collapse
  assert.equal(b.buckets[k1].count, 1);
  assert.equal(b.buckets[k2].count, 1);
});

// ---- §10 strict checkpoint validation (deepened by R1A) -------------------
// A pending record must be a COMPLETE producer-shaped truth-bearing event
// with a recomputable identity — the exact shape pollOne emits.
function validPendingPoll(providerSymbol = 'CK.X', baselineRevision = 2) {
  const retrievedTs = new Date(NOW).toISOString();
  return {
    ts: retrievedTs,
    type: 'RUMINT_POLL',
    sourceEventId: pollEventIdentity({ providerSymbol, retrievedTs, baselineRevision }),
    provider: 'STOCKTWITS',
    canonicalCoin: providerSymbol.replace(/\.X$/, ''),
    providerSymbol,
    symbol: providerSymbol,
    retrievedTs,
    coverage: 'SAMPLED_SINGLE_PAGE',
    pagesFetched: 1,
    messagesReturned: 1,
    accepted: 1,
    duplicateSamePage: 0,
    alreadySeen: 0,
    invalidId: 0,
    invalidTimestamp: 0,
    ancientRejected: 0,
    bootstrappedHourRejected: 0,
    watermarkInitialized: false,
    velocity: 1,
    currentHourCount: 1,
    previousHourCount: null,
    twoHoursPriorCount: null,
    historyBucketCount: 1,
    historyMean: null,
    historyStd: null,
    z: null,
    zReason: 'INSUFFICIENT_HISTORY',
    zThreshold: 3,
    acceleration: null,
    accelerationReason: 'INSUFFICIENT_CONTIGUOUS_OBSERVATION',
    recentBull: 0,
    recentBear: 0,
    labeledTotal: 0,
    sentimentShift: null,
    gates: { zAvailable: false, zPass: false, accelerationAvailable: false, accelerationPass: false },
    decision: 'INSUFFICIENT_HISTORY',
    baselineRevision,
  };
}
function validState() {
  const b = wm100('CK.X');
  const savedTs = new Date(NOW).toISOString();
  // R1A: the stored HYPED snapshot must agree with a semantic recompute
  // from its own baselines at its own saved instant — so the fixture
  // carries exactly that truth, never an asserted one.
  const hyped = { ...hypedSnapshot({ baselines: { 'CK.X': b }, atMs: NOW }), finalizedTs: savedTs };
  return {
    version: RUMINT_CHECKPOINT_VERSION,
    savedTs,
    provider: 'STOCKTWITS',
    baselines: { 'CK.X': b },
    hyped,
    providerHealth: { globalBackoffUntil: 0, recentRequestTimestamps: [NOW - 1000], symbols: { 'CK.X': { failureStreak: 0, unavailableUntil: 0, cooldownLevel: 0, lastError: null, lastErrorTs: null, lastFailureKind: null } } },
    pendingEvents: [{ kind: 'POLL', record: validPendingPoll() }],
    pollTransaction: null,
    counters: { polls: 1 },
  };
}

test('R1 §10: a well-formed checkpoint validates; every corruption is named and refused', () => {
  assert.equal(validateCheckpoint(validState()), null);
  const cases = [
    (s) => (s.version = 99),
    (s) => (s.provider = 'REDDIT'),
    (s) => (s.savedTs = 'yesterday'),
    (s) => (s.baselines['CK.X'].lastMsgId = 'abc'),
    (s) => (s.baselines['CK.X'].recentSeenMessageIds = ['-3']),
    (s) => (s.baselines['CK.X'].buckets['not-an-hour'] = { count: 0, bull: 0, bear: 0, successfulPolls: 1, firstPollTs: null, lastPollTs: null, coverage: COVERAGE_SAMPLED }),
    (s) => (Object.values(s.baselines['CK.X'].buckets)[0].bull = 99), // bull+bear > count
    (s) => (Object.values(s.baselines['CK.X'].buckets)[0].count = -1),
    (s) => (Object.values(s.baselines['CK.X'].buckets)[0].coverage = 'COMPLETE'),
    (s) => (s.hyped.state = 'GREAT'),
    (s) => (s.hyped.symbols = ['not a coin!']),
    (s) => (s.providerHealth.recentRequestTimestamps = ['soon']),
    (s) => (s.providerHealth.symbols['CK.X'].cooldownLevel = 7),
    (s) => (s.pendingEvents[0].record.sourceEventId = 'nope'),
    (s) => (s.pendingEvents = Array.from({ length: 400 }, () => s.pendingEvents[0])),
    (s) => (s.counters.polls = -1),
  ];
  for (const [i, mutate] of cases.entries()) {
    const s = validState();
    mutate(s);
    assert.notEqual(validateCheckpoint(s), null, `corruption case ${i} must be refused`);
  }
});

// ---- §43/§82 event identities ---------------------------------------------
test('R1 §43/§82: poll and nomination identities are semantic, linked, and never collapse', () => {
  const p1 = pollEventIdentity({ providerSymbol: 'BTC.X', retrievedTs: '2026-09-02T18:00:00.000Z', baselineRevision: 7 });
  const p1again = pollEventIdentity({ providerSymbol: 'BTC.X', retrievedTs: '2026-09-02T18:00:00.000Z', baselineRevision: 7 });
  const p2 = pollEventIdentity({ providerSymbol: 'BTC.X', retrievedTs: '2026-09-02T18:05:00.000Z', baselineRevision: 8 });
  assert.equal(p1, p1again); // exact replay -> exact identity
  assert.notEqual(p1, p2); // a different provider observation is new evidence
  const n1 = nominationEventIdentity({ pollSourceEventId: p1 });
  assert.notEqual(n1, p1); // nomination never collapses onto its poll
  assert.equal(n1, nominationEventIdentity({ pollSourceEventId: p1 }));
  assert.notEqual(n1, nominationEventIdentity({ pollSourceEventId: p2 }));
  assert.notEqual(rumintIdentity({ a: 1 }), rumintIdentity({ a: 2 }));
});

// ---- §23/§85 Memory preserves the diagnostics -----------------------------
test('R1 §85: expanded poll diagnostics canonicalize; only exact nominations are attention', () => {
  const ISO = new Date(NOW).toISOString();
  const poll = {
    ts: ISO,
    type: 'RUMINT_POLL',
    sourceEventId: 'c'.repeat(40),
    provider: 'STOCKTWITS',
    canonicalCoin: 'BTC',
    providerSymbol: 'BTC.X',
    symbol: 'BTC.X',
    velocity: 12,
    z: null,
    zReason: 'INSUFFICIENT_HISTORY',
    acceleration: null,
    accelerationReason: 'INSUFFICIENT_CONTIGUOUS_OBSERVATION',
    historyBucketCount: 9,
    gates: { zAvailable: false, zPass: false, accelerationAvailable: false, accelerationPass: false },
    decision: 'INSUFFICIENT_HISTORY',
    note: 'contains the words RUMINT_NOMINATION only as text',
  };
  const env = adapters.fromRumintEvent(poll, ISO);
  assert.equal(env.sourceModule, 'RUMINT');
  assert.equal(env.eventType, 'RUMOR_OBSERVATION');
  assert.deepEqual(env.evidenceFamily, ['RUMOR', 'SOCIAL_ATTENTION']);
  assert.equal(env.payload.detail.zReason, 'INSUFFICIENT_HISTORY'); // forensics survive into durable Memory
  assert.equal(env.payload.detail.decision, 'INSUFFICIENT_HISTORY');
  assert.equal(env.correlation.sourceEventId, 'c'.repeat(40));
  assert.equal(env.dataAvailability.zVelocity, 'UNAVAILABLE'); // null with reason is UNAVAILABLE, never silent
  assert.equal(attentionContinuityMeaning(env), null, 'a poll is never attention, whatever text it carries');
  const nom = adapters.fromRumintEvent(
    { ts: ISO, type: 'RUMINT_NOMINATION', sourceEventId: 'd'.repeat(40), pollSourceEventId: 'c'.repeat(40), symbol: 'BTC', providerSymbol: 'BTC.X', z: 3.4, acceleration: 2, zThreshold: 3 },
    ISO
  );
  assert.equal(attentionContinuityMeaning(nom), 'RUMINT_NOMINATION');
  assert.notEqual(nom.id, env.id);
});

// ---- §14 bootstrapped hours -----------------------------------------------
test('R1 §14: bootstrapped hours count as observed history but refuse live double-counting', () => {
  const b = emptyBaseline('BS.X', 'BS');
  const key = utcHourKey(NOW - 5 * 3_600_000);
  b.buckets[key] = { count: 9, bull: null, bear: null, successfulPolls: 0, firstPollTs: null, lastPollTs: null, coverage: COVERAGE_BOOTSTRAPPED };
  assert.equal(bucketObserved(b.buckets[key]), true);
  // watermark still unknown -> first live page initializes only
  const first = ingestPage(b, [{ id: 50, created_at: at(3) }], NOW);
  assert.equal(first.stats.watermarkInitialized, true);
  assert.equal(first.stats.accepted, 0);
  // a late live message pointing INTO the bootstrapped hour is refused
  const second = ingestPage(first.baseline, [{ id: 51, created_at: new Date(NOW - 5 * 3_600_000).toISOString() }], NOW);
  assert.equal(second.stats.bootstrappedHourRejected, 1);
  assert.equal(second.baseline.buckets[key].count, 9); // the proven fact is untouched
});
