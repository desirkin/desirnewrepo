// RUMINT-R1A drills — crash consistency and publication truth:
//   B1 the append-before-checkpoint crash window (prepared poll transaction)
//   B2 semantic checkpoint poison (fake HYPED, identity forgery, mapping
//      violations, malformed pending debt)
//   B3 the pending hard cap freezes advancement instead of evicting evidence
//   B4 independent HYPED publication ACK — header/room/Attention single truth
//   B5 explicit partial-continuation coverage with recorded health
//   plus the local-checkpoint ABSENT vs CORRUPT distinction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.setMaxListeners(120);
process.env.RUMINT_ENABLED = 'true'; // every network touch below is an injected fake

const { startRumint } = await import('../rumint/poller.js');
const {
  signalFromBaseline,
  hypedSnapshot,
  hypedSessionIdentity,
  pollEventIdentity,
  nominationEventIdentity,
  emptyBaseline,
  ingestPage,
  validateCheckpoint,
  RUMINT_CHECKPOINT_VERSION,
} = await import('../rumint/truth.js');
const { readStalking } = await import('../state/stalking.js');
const { attentionSnapshot, earsRoom, readHypedSnapshot } = await import('../ui/attention-view.js');

test.after(() => {
  delete process.env.RUMINT_ENABLED;
});

const CFG = (coins = ['BTC']) => ({
  universe: coins,
  rumint: { enabled: true, zThreshold: 3, stalkTtlMin: 60, pollHotSec: 300, pollWarmSec: 1200, hourlyBudget: 500, spacingMs: 1, backoffMin: 15 },
});

const dirs = [];
function freshDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r1a-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const statusOf = (d) => JSON.parse(readFileSync(path.join(d, 'rumint', 'status.json'), 'utf8'));
const eventLines = (d) => {
  const f = path.join(d, 'rumint', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const linesOf = (d, type) => eventLines(d).filter((e) => e.type === type);

function memStore() {
  return {
    state: null,
    saves: [],
    failLoad: false,
    failSave: false,
    async load() {
      if (this.failLoad) return { outcome: 'UNAVAILABLE', error: 'induced load failure' };
      return this.state === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(this.state) };
    },
    async save(s) {
      if (this.failSave) return { durable: false, reason: 'UNAVAILABLE' };
      this.state = structuredClone(s);
      this.saves.push(structuredClone(s));
      return { durable: true };
    },
  };
}

const page = (messages, cursor) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => (cursor ? { messages, cursor } : { messages }) });
const msg = (id, atMs, sentiment = null) => ({ id, created_at: new Date(atMs).toISOString(), entities: { sentiment: { basic: sentiment } } });

function scriptedFetch(queue) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const next = queue.shift();
    if (!next) throw new Error('unscripted fetch: ' + url);
    const out = typeof next === 'function' ? next() : next;
    if (out instanceof Error) throw out;
    return out;
  };
  impl.calls = calls;
  return impl;
}

const T0 = Date.parse('2026-09-02T12:30:00Z'); // 08:30 ET

function collector(overrides = {}) {
  return startRumint({ log: () => {}, config: CFG(), intervalMs: 3_600_000, ...overrides });
}

// =====================================================================
// B1 — the append-before-checkpoint crash window
// =====================================================================
test('R1A-B1a: source appended, checkpoint lost -> restart finishes the SAME advancement, counts nothing twice', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const a = collector({ fetchImpl, now: () => clock.ms, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(100, clock.ms - 120_000)])); // watermark init at 100
  await a.tickOnce();
  const savesBefore = store.saves.length;
  clock.ms += 310_000;
  queue.push(page([msg(101, clock.ms - 60_000), msg(102, clock.ms - 30_000)]));
  await a.tickOnce();
  const finalBaseline = structuredClone(store.state.baselines['BTC.X']); // the finished candidate truth
  // the write-ahead transaction save happened BEFORE the append: find it
  const txnSave = store.saves.slice(savesBefore).find((s) => s.pollTransaction);
  assert.ok(txnSave, 'a prepared transaction was persisted before the event could exist');
  assert.equal(txnSave.baselines['BTC.X'].baselineRevision, finalBaseline.baselineRevision - 1, 'transaction rides the PRE-poll baseline');
  assert.deepEqual(txnSave.pollTransaction.acceptedIds, ['101', '102']);
  assert.equal(validateCheckpoint(txnSave), null, 'the transaction-bearing checkpoint validates strictly');
  await a.stop();

  // CRASH SIMULATION: the durable row is rolled back to the transaction
  // save (revision N + prepared txn); the source stream keeps the appended
  // poll. Restart in the SAME data dir — a same-VM crash restart.
  store.state = structuredClone(txnSave);
  const pollsBefore = linesOf(d, 'RUMINT_POLL').length;
  const appendedPoll = linesOf(d, 'RUMINT_POLL').at(-1);
  const b = collector({ fetchImpl: scriptedFetch(queue), now: () => clock.ms, checkpointStore: store });
  clock.ms += 5000;
  await b.tickOnce();
  assert.equal(linesOf(d, 'RUMINT_POLL').length, pollsBefore, 'the durable event was recognized — no second contradictory RUMINT_POLL');
  assert.deepEqual(b.internals.baselines['BTC.X'], finalBaseline, 'candidate baseline N+1 finalized exactly once (watermark + seen-IDs match)');
  // the provider replays the same two messages: they are already truth
  clock.ms += 310_000;
  queue.push(page([msg(101, clock.ms - 400_000), msg(102, clock.ms - 380_000)]));
  await b.tickOnce();
  const replayPoll = linesOf(d, 'RUMINT_POLL').at(-1);
  assert.equal(replayPoll.accepted, 0, 'the same provider messages are NOT counted again');
  assert.equal(replayPoll.alreadySeen, 2);
  // z/acceleration math equals uninterrupted execution over the same truth
  const expected = signalFromBaseline(b.internals.baselines['BTC.X'], clock.ms, { zThreshold: 3 });
  assert.equal(replayPoll.z, expected.zVelocity);
  assert.equal(replayPoll.acceleration, expected.acceleration);
  assert.equal(replayPoll.historyBucketCount, expected.historyBucketCount);
  assert.ok(appendedPoll.sourceEventId !== replayPoll.sourceEventId, 'a genuinely new poll keeps a new identity');
  await b.stop();
});

test('R1A-B1b: crash BEFORE the append -> the exact prepared record replays with the SAME identity, nothing regenerated', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const a = collector({ fetchImpl: scriptedFetch(queue), now: () => clock.ms, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(100, clock.ms - 120_000)]));
  await a.tickOnce();
  const savesBefore = store.saves.length;
  clock.ms += 310_000;
  queue.push(page([msg(101, clock.ms - 60_000)]));
  await a.tickOnce();
  const txnSave = store.saves.slice(savesBefore).find((s) => s.pollTransaction);
  const prepared = structuredClone(txnSave.pollTransaction.record);
  await a.stop();
  // crash before append: durable row = txn save AND the source stream never
  // received the event (fresh republish disk)
  store.state = structuredClone(txnSave);
  const d2 = freshDir();
  const b = collector({ fetchImpl: scriptedFetch([]), now: () => clock.ms, checkpointStore: store });
  clock.ms += 5000;
  await b.tickOnce();
  const replayed = linesOf(d2, 'RUMINT_POLL');
  assert.equal(replayed.length, 1, 'the owed poll wrote exactly once');
  assert.deepEqual(replayed[0], prepared, 'the EXACT prepared record — no regenerated retrievedTs, identity, or counts');
  assert.equal(b.internals.baselines['BTC.X'].baselineRevision, txnSave.pollTransaction.candidateBaselineRevision);
  assert.deepEqual(b.internals.baselines['BTC.X'], txnSave.pollTransaction.candidateBaseline);
  assert.equal(b.internals.pollTransaction, null, 'the transaction settled');
  await b.stop();
});

// =====================================================================
// B2 — checkpoint poison
// =====================================================================
function builtBaseline(sym = 'BTC.X', atMs = T0) {
  let b = emptyBaseline(sym, sym.replace(/\.X$/, ''));
  ({ baseline: b } = ingestPage(b, [{ id: 100, created_at: new Date(atMs - 120_000).toISOString() }], atMs - 60_000));
  ({ baseline: b } = ingestPage(b, [{ id: 101, created_at: new Date(atMs - 30_000).toISOString() }], atMs));
  return b;
}
function validCheckpoint(atMs = T0) {
  const baselines = { 'BTC.X': builtBaseline('BTC.X', atMs) };
  const hyped = hypedSnapshot({ baselines, atMs });
  return {
    version: RUMINT_CHECKPOINT_VERSION,
    savedTs: new Date(atMs).toISOString(),
    provider: 'STOCKTWITS',
    baselines,
    hyped: { ...hyped, finalizedTs: hyped.state === 'BUILDING' ? null : new Date(atMs).toISOString() },
    providerHealth: { globalBackoffUntil: 0, recentRequestTimestamps: [], symbols: {} },
    pendingEvents: [],
    pollTransaction: null,
    counters: { polls: 2 },
  };
}

test('R1A-B2: poisoned checkpoints are refused and adopt NOTHING — no hyped.json, no Tier-3, no events, no stalking', async () => {
  const base = validCheckpoint();
  assert.equal(validateCheckpoint(base), null, 'the honest fixture validates');
  const dateOf = base.hyped.sessionDate;
  const poisons = [
    ['fake HYPED set riding foreign evidence', (s) => {
      s.hyped = { sessionDate: dateOf, state: 'READY', symbols: ['DOGE'], finalizedTs: s.savedTs, identity: hypedSessionIdentity({ sessionDate: dateOf, state: 'READY', symbols: ['DOGE'] }), coverage: { eligibleSymbols: 1, insufficientSymbols: 0, nonzeroEligible: 1, reason: null } };
    }],
    ['HYPED identity forgery on otherwise matching values', (s) => (s.hyped.identity = 'a'.repeat(40))],
    ['provider/coin mapping violation (BTC.X wearing ETH)', (s) => (s.baselines['BTC.X'].canonicalCoin = 'ETH')],
    ['pending POLL missing its producer diagnostics', (s) => {
      s.pendingEvents = [{ kind: 'POLL', record: { ts: s.savedTs, type: 'RUMINT_POLL', sourceEventId: 'b'.repeat(40) } }];
    }],
    ['pending NOMINATION whose identity does not match its poll', (s) => {
      const pollId = 'c'.repeat(40);
      s.pendingEvents = [{ kind: 'NOMINATION', record: {
        ts: s.savedTs, type: 'RUMINT_NOMINATION', provider: 'STOCKTWITS', symbol: 'BTC', providerSymbol: 'BTC.X',
        pollSourceEventId: pollId, z: 3.4, acceleration: 2, zThreshold: 3,
        sourceEventId: nominationEventIdentity({ pollSourceEventId: 'd'.repeat(40) }), // forged link
      } }];
    }],
    ['pending kind/type mismatch', (s) => {
      const retrievedTs = s.savedTs;
      const rec = { ts: s.savedTs, type: 'RUMINT_NOMINATION', provider: 'STOCKTWITS', symbol: 'BTC', providerSymbol: 'BTC.X', pollSourceEventId: 'c'.repeat(40), z: 4, acceleration: 1, zThreshold: 3 };
      rec.sourceEventId = nominationEventIdentity({ pollSourceEventId: rec.pollSourceEventId });
      s.pendingEvents = [{ kind: 'POLL', record: rec }];
    }],
    ['transaction candidate under a different symbol', (s) => {
      const retrievedTs = s.savedTs;
      const rev = 3;
      const rec = { ts: s.savedTs, type: 'RUMINT_POLL', provider: 'STOCKTWITS', canonicalCoin: 'BTC', providerSymbol: 'BTC.X', symbol: 'BTC.X', retrievedTs, coverage: 'SAMPLED_SINGLE_PAGE', pagesFetched: 1, messagesReturned: 0, accepted: 0, duplicateSamePage: 0, alreadySeen: 0, invalidId: 0, invalidTimestamp: 0, ancientRejected: 0, bootstrappedHourRejected: 0, watermarkInitialized: false, velocity: 0, currentHourCount: 0, previousHourCount: null, twoHoursPriorCount: null, historyBucketCount: 1, historyMean: null, historyStd: null, z: null, zReason: 'INSUFFICIENT_HISTORY', zThreshold: 3, acceleration: null, accelerationReason: 'INSUFFICIENT_CONTIGUOUS_OBSERVATION', recentBull: 0, recentBear: 0, labeledTotal: 0, sentimentShift: null, gates: { zAvailable: false, zPass: false, accelerationAvailable: false, accelerationPass: false }, decision: 'INSUFFICIENT_HISTORY', baselineRevision: rev };
      rec.sourceEventId = pollEventIdentity({ providerSymbol: 'BTC.X', retrievedTs, baselineRevision: rev });
      s.pollTransaction = { version: 1, state: 'PREPARED', provider: 'STOCKTWITS', canonicalCoin: 'ETH', providerSymbol: 'ETH.X', prePollBaselineRevision: 2, candidateBaselineRevision: 3, acceptedIds: [], record: rec, sourceEventId: rec.sourceEventId, candidateBaseline: s.baselines['BTC.X'], nominationRecord: null };
    }],
  ];
  for (const [name, poison] of poisons) {
    const s = structuredClone(base);
    poison(s);
    assert.notEqual(validateCheckpoint(s), null, `poison must be refused: ${name}`);
  }
  // a refused checkpoint adopts NOTHING and publishes NOTHING
  const d = freshDir();
  const store = memStore();
  const s = structuredClone(base);
  s.hyped.identity = 'a'.repeat(40);
  store.state = s;
  const clock = { ms: T0 + 3_600_000 };
  const fetchImpl = scriptedFetch([]);
  const r = collector({ fetchImpl, now: () => clock.ms, checkpointStore: store });
  await r.tickOnce();
  assert.equal(statusOf(d).status, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(fetchImpl.calls.length, 0, 'no polling from poisoned authority');
  assert.ok(!existsSync(path.join(d, 'rumint', 'hyped.json')), 'no hyped.json written from a rejected checkpoint');
  assert.equal(linesOf(d, 'HYPED_SESSION').length, 0);
  assert.equal(linesOf(d, 'RUMINT_POLL').length, 0);
  assert.deepEqual(readStalking(clock.ms), {}, 'no stalking from a rejected checkpoint');
  const att = await attentionSnapshot({ now: clock.ms, config: CFG(), memorySource: async () => [] });
  assert.ok(!att.orbit.some((e) => e.kind === 'HYPED'), 'no Tier-3 HYPED from a rejected checkpoint');
  await r.stop();
});

// =====================================================================
// B3 — the pending hard cap freezes advancement, never evicts evidence
// =====================================================================
test('R1A-B3: at the debt cap the baseline STOPS advancing; owed evidence is untouchable; recovery converges exactly', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = collector({ fetchImpl, now: () => clock.ms, checkpointStore: store, maxPendingEvents: 2 });
  clock.ms += 5000;
  queue.push(page([msg(100, clock.ms - 120_000)])); // watermark init (writer healthy)
  await r.tickOnce();
  // the source writer dies
  const ev = path.join(d, 'rumint', 'events.jsonl');
  renameSync(ev, ev + '.orig');
  mkdirSync(ev);
  const pages = [[201], [202], [203]];
  for (const ids of pages.slice(0, 2)) {
    clock.ms += 310_000;
    queue.push(page(ids.map((id) => msg(id, clock.ms - 60_000))));
    await r.tickOnce();
  }
  assert.equal(r.internals.pending.length, 2, 'debt filled to its hard cap');
  const owedIds = r.internals.pending.map((p) => p.record.sourceEventId);
  const frozenRevision = r.internals.baselines['BTC.X'].baselineRevision;
  assert.equal(store.state.pendingEvents.length, 2, 'every adopted unacknowledged advancement has retained exact evidence debt');
  // next poll cannot advance while no debt capacity exists — it is not even requested
  clock.ms += 310_000;
  const callsBefore = fetchImpl.calls.length;
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, callsBefore, 'observation paused behind owed evidence');
  assert.equal(r.internals.baselines['BTC.X'].baselineRevision, frozenRevision, 'no baseline advancement at the cap');
  assert.deepEqual(r.internals.pending.map((p) => p.record.sourceEventId), owedIds, 'no owed evidence disappeared');
  assert.equal(statusOf(d).status, 'FAILED_EVIDENCE_BACKLOG', 'health is visibly degraded');
  // writer recovers: debt drains, polling resumes, truth converges
  rmdirSync(ev);
  renameSync(ev + '.orig', ev);
  clock.ms += 310_000;
  queue.push(page(pages[2].map((id) => msg(id, clock.ms - 60_000))));
  await r.tickOnce();
  assert.equal(r.internals.pending.length, 0, 'debt drained');
  for (const id of owedIds) {
    assert.equal(eventLines(d).filter((e) => e.sourceEventId === id).length, 1, 'each owed event wrote exactly once');
  }
  assert.equal(r.internals.baselines['BTC.X'].baselineRevision, frozenRevision + 1, 'polling resumed');
  // reference execution: an uninterrupted collector fed the identical pages
  const d2 = freshDir();
  const q2 = [];
  const ref = collector({ fetchImpl: scriptedFetch(q2), now: () => clock.ms, checkpointStore: memStore() });
  // replay the same observation times exactly
  const clockRef = { ms: T0 };
  const ref2 = startRumint({ log: () => {}, config: CFG(), intervalMs: 3_600_000, fetchImpl: scriptedFetch(q2), now: () => clockRef.ms, checkpointStore: memStore() });
  clockRef.ms += 5000;
  q2.push(page([msg(100, clockRef.ms - 120_000)]));
  await ref2.tickOnce();
  for (const ids of pages) {
    clockRef.ms += 310_000;
    if (ids[0] === 203) clockRef.ms += 310_000; // the frozen tick added one cadence step in the real run
    q2.push(page(ids.map((id) => msg(id, clockRef.ms - 60_000))));
    await ref2.tickOnce();
  }
  assert.deepEqual(
    Object.entries(ref2.internals.baselines['BTC.X'].buckets).map(([k, b]) => [k, b.count]),
    Object.entries(r.internals.baselines['BTC.X'].buckets).map(([k, b]) => [k, b.count]),
    'baseline equals uninterrupted reference execution'
  );
  assert.equal(ref2.internals.baselines['BTC.X'].lastMsgId, r.internals.baselines['BTC.X'].lastMsgId);
  await r.stop();
  await ref.stop();
  await ref2.stop();
});

// =====================================================================
// B4 — HYPED publication ACK and the single-truth invariant
// =====================================================================
async function buildReadyHyped(r, clock, queue) {
  // overnight 2026-09-02 ET: 04:00Z-09:59Z; observe all six hours, chatter in hour 3
  queue.push(page([msg(60, clock.ms - 120_000)])); // watermark init in hour 0
  await r.tickOnce();
  for (let h = 1; h < 6; h++) {
    clock.ms = Date.parse('2026-09-02T04:10:00Z') + h * 3_600_000;
    queue.push(page(h === 3 ? [msg(61, clock.ms - 60_000)] : []));
    await r.tickOnce();
  }
  clock.ms = Date.parse('2026-09-02T10:10:00Z'); // 06:10 ET: finalize
  queue.push(page([]));
  await r.tickOnce();
}

test('R1A-B4: a HYPED mirror write failure cannot split the truth — one snapshot, explicit ACK, retry, convergence', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: Date.parse('2026-09-02T04:10:00Z') };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = collector({ fetchImpl, now: () => clock.ms, checkpointStore: store });
  // break the hyped.json mirror BEFORE the READY state exists
  mkdirSync(path.join(d, 'rumint', 'hyped.json'), { recursive: true });
  await buildReadyHyped(r, clock, queue);
  let st = statusOf(d);
  assert.equal(st.hyped.state, 'READY');
  assert.deepEqual(st.hyped.symbols, ['BTC']);
  assert.equal(st.hypedPublication, 'FAILED', 'publication failure is explicit');
  assert.notEqual(st.status, 'HEALTHY', 'top-level status is not HEALTHY while publication fails');
  // single-truth invariant: header source, Rumor Room and Attention consume
  // the SAME canonical status snapshot — no consumer is left blind
  const room = earsRoom({ now: clock.ms });
  assert.equal(room.status.hyped.state, 'READY');
  assert.deepEqual(room.status.hyped.symbols, ['BTC']);
  assert.equal(room.status.hyped.count, st.hyped.symbols.length, 'header H count == Rumor Room HYPED count');
  const att = await attentionSnapshot({ now: clock.ms, config: CFG(), memorySource: async () => [] });
  assert.ok(att.orbit.some((e) => e.symbol === 'BTC' && e.kind === 'HYPED'), '== Attention HYPED set');
  // the unchanged snapshot RETRIES the failed publication...
  clock.ms += 10_000;
  await r.tickOnce();
  assert.equal(statusOf(d).hypedPublication, 'FAILED', 'still failed while the writer is broken (and still retrying)');
  // ...and converges once the writer recovers, with no semantic change
  rmdirSync(path.join(d, 'rumint', 'hyped.json'));
  clock.ms += 10_000;
  await r.tickOnce();
  st = statusOf(d);
  assert.equal(st.hypedPublication, 'SAVED');
  assert.equal(st.status, 'HEALTHY', 'healthy only after the publication acknowledgement');
  const mirror = JSON.parse(readFileSync(path.join(d, 'rumint', 'hyped.json'), 'utf8'));
  assert.deepEqual(mirror.symbols, ['BTC']);
  assert.equal(mirror.identity, st.hyped.identity, 'mirror and canonical snapshot agree');
  await r.stop();

  // restore-time publication failure is visible AND retryable
  const d2 = freshDir();
  mkdirSync(path.join(d2, 'rumint', 'hyped.json'), { recursive: true });
  const b = collector({ fetchImpl: scriptedFetch([page([])]), now: () => clock.ms, checkpointStore: store });
  clock.ms += 10_000;
  await b.tickOnce();
  let st2 = statusOf(d2);
  assert.equal(st2.initState, 'RESTORED_DURABLE');
  assert.equal(st2.hypedPublication, 'FAILED', 'restore-time failure is visible');
  assert.notEqual(st2.status, 'HEALTHY');
  rmdirSync(path.join(d2, 'rumint', 'hyped.json'));
  clock.ms += 10_000;
  await b.tickOnce();
  st2 = statusOf(d2);
  assert.equal(st2.hypedPublication, 'SAVED');
  assert.deepEqual(readHypedSnapshot(clock.ms).symbols, ['BTC'], 'all consumers converge after recovery');
  await b.stop();
});

// =====================================================================
// B5 — explicit partial-continuation coverage
// =====================================================================
async function continuationHarness() {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({
    log: () => {},
    config: CFG(),
    intervalMs: 3_600_000,
    fetchImpl,
    now: () => clock.ms,
    sleepImpl: async (ms) => {
      clock.ms += ms;
    },
    checkpointStore: store,
  });
  clock.ms += 5000;
  queue.push(page([msg(100, clock.ms - 120_000)], { more: true, since: 100, max: 100 })); // watermark init
  await r.tickOnce();
  return { d, r, clock, queue, fetchImpl };
}
const firstPage = (clock) => page([msg(140, clock.ms - 60_000), msg(139, clock.ms - 90_000)], { more: true, since: 140, max: 139 });

test('R1A-B5a: continuation schema failure -> explicit PARTIAL coverage, counted, health-noted, first page preserved', async () => {
  const { d, r, clock, queue } = await continuationHarness();
  clock.ms += 310_000;
  queue.push(firstPage(clock));
  queue.push({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ nonsense: true }) });
  await r.tickOnce();
  const p = linesOf(d, 'RUMINT_POLL').at(-1);
  assert.equal(p.coverage, 'PARTIAL_CONTINUATION_SCHEMA_FAILURE', 'not disguised as a page cap');
  assert.equal(p.accepted, 2, 'the valid first page is preserved');
  const st = statusOf(d);
  assert.equal(st.providerSchemaFailures, 1, 'schema counter increments');
  assert.equal(st.continuationFailures, 1);
  assert.equal(st.status, 'DEGRADED', 'not HEALTHY as if nothing happened');
  assert.equal(r.internals.symbolHealth['BTC.X'].lastContinuationFailure.kind, 'PARTIAL_CONTINUATION_SCHEMA_FAILURE');
  assert.equal(linesOf(d, 'RUMINT_CONTINUATION_FAILED').length, 1, 'bounded failure evidence recorded');
  await r.stop();
});

test('R1A-B5b: continuation network failure -> explicit PARTIAL coverage with visible health', async () => {
  const { d, r, clock, queue } = await continuationHarness();
  clock.ms += 310_000;
  queue.push(firstPage(clock));
  queue.push(new Error('ECONNRESET induced'));
  await r.tickOnce();
  const p = linesOf(d, 'RUMINT_POLL').at(-1);
  assert.equal(p.coverage, 'PARTIAL_CONTINUATION_NETWORK_FAILURE');
  assert.equal(p.accepted, 2);
  assert.equal(statusOf(d).continuationFailures, 1);
  assert.equal(statusOf(d).status, 'DEGRADED');
  await r.stop();
});

test('R1A-B5c: continuation 429 -> PARTIAL_CONTINUATION_RATE_LIMIT, backoff engaged, Retry-After honored, first page kept', async () => {
  const { d, r, clock, queue } = await continuationHarness();
  clock.ms += 310_000;
  queue.push(firstPage(clock));
  queue.push(Object.assign(new Error('stocktwits BTC.X -> HTTP 429'), { status: 429, retryAfterMs: 300_000 }));
  await r.tickOnce();
  const p = linesOf(d, 'RUMINT_POLL').at(-1);
  assert.equal(p.coverage, 'PARTIAL_CONTINUATION_RATE_LIMIT');
  assert.equal(p.accepted, 2, 'first-page evidence preserved');
  assert.equal(r.budget.backoffUntil, clock.ms + 300_000, 'global backoff engaged with Retry-After honored');
  assert.equal(linesOf(d, 'RUMINT_BACKOFF').length, 1);
  await r.stop();
});

test('R1A-B5d: a GENUINE four-page cap still reads SAMPLED_PAGE_CAP; a proven boundary reads COMPLETE_TO_WATERMARK', async () => {
  const { d, r, clock, queue } = await continuationHarness();
  clock.ms += 310_000;
  const mk = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => msg(hi - i, clock.ms - 60_000));
  for (let i = 0; i < 4; i++) queue.push(page(mk(900 + i * 30, 929 + i * 30), { more: true, since: 999, max: 900 + i * 30 }));
  await r.tickOnce();
  assert.equal(linesOf(d, 'RUMINT_POLL').at(-1).coverage, 'SAMPLED_PAGE_CAP');
  assert.equal(statusOf(d).continuationFailures, 0, 'a real cap is not a failure');
  clock.ms += 310_000;
  queue.push(page(mk(1010, 1039), { more: true, since: 1039, max: 1010 }));
  queue.push(page([...mk(1000, 1009), msg(929, clock.ms - 90_000)], { more: true, since: 1009, max: 929 })); // reaches known id 929
  await r.tickOnce();
  assert.equal(linesOf(d, 'RUMINT_POLL').at(-1).coverage, 'COMPLETE_TO_WATERMARK');
  await r.stop();
});

// =====================================================================
// Local checkpoint: ABSENT vs CORRUPT
// =====================================================================
test('R1A-local: a corrupt local checkpoint is NOT a fresh start — the truth is reported and withheld', async () => {
  const d = freshDir();
  mkdirSync(path.join(d, 'rumint'), { recursive: true });
  writeFileSync(path.join(d, 'rumint', 'checkpoint.json'), '{{{ definitely not json');
  const clock = { ms: T0 };
  const fetchImpl = scriptedFetch([]);
  const r = collector({ fetchImpl, now: () => clock.ms, checkpointStore: null }); // no durable authority at all
  clock.ms += 5000;
  await r.tickOnce();
  assert.equal(statusOf(d).initState, 'WITHHELD_INVALID_LOCAL_CHECKPOINT');
  assert.equal(fetchImpl.calls.length, 0, 'no polling on a corrupt cache');
  // the corrupt file is removed by an operator: absence is an honest fresh start
  rmSync(path.join(d, 'rumint', 'checkpoint.json'));
  clock.ms += 5000;
  const q = [page([msg(9, clock.ms - 60_000)])];
  const r2 = collector({ fetchImpl: scriptedFetch(q), now: () => clock.ms, checkpointStore: null });
  await r2.tickOnce();
  assert.equal(statusOf(d).initState, 'FRESH_START');
  await r.stop();
  await r2.stop();
});
