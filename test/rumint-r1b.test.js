// RUMINT-R1B drills — nomination + pending semantic closeout:
//   the ONE nomination rule shared by producer and validator; false
//   nominations can never validate, append, or restore; poll<->nomination
//   cross-consistency; pending nomination carries its exact triggering-poll
//   cause; pending HYPED carries a recompute-provable semantic basis (and a
//   legitimate OLDER transition stays provable); a crash-recovered bound
//   nomination is durable debt, never best-effort — exactly once, same
//   identity, no stalking, truthful counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.setMaxListeners(120);
process.env.RUMINT_ENABLED = 'true'; // every network touch below is an injected fake

const { startRumint, shouldNominate } = await import('../rumint/poller.js');
const {
  nominationQualifies,
  validateSourceRecord,
  validatePendingEntry,
  validatePollTransaction,
  validateCheckpoint,
  nominationEventIdentity,
  pollEventIdentity,
  hypedSessionIdentity,
  hypedSnapshotFromBasis,
  hypedSnapshot,
  emptyBaseline,
  ingestPage,
  RUMINT_CHECKPOINT_VERSION,
} = await import('../rumint/truth.js');
const { readStalking } = await import('../state/stalking.js');

test.after(() => {
  delete process.env.RUMINT_ENABLED;
});

const CFG = (coins = ['BTC']) => ({
  universe: coins,
  rumint: { enabled: true, zThreshold: 3, stalkTtlMin: 60, pollHotSec: 300, pollWarmSec: 1200, hourlyBudget: 500, spacingMs: 1, backoffMin: 15 },
});

const dirs = [];
function freshDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r1b-'));
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
    async load() {
      return this.state === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(this.state) };
    },
    async save(s) {
      this.state = structuredClone(s);
      this.saves.push(structuredClone(s));
      return { durable: true };
    },
  };
}

const page = (messages) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages }) });
const msg = (id, atMs) => ({ id, created_at: new Date(atMs).toISOString(), entities: { sentiment: { basic: null } } });

function scriptedFetch(queue) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const next = queue.shift();
    if (!next) throw new Error('unscripted fetch: ' + url);
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

const T0 = Date.parse('2026-09-02T12:30:00Z'); // 08:30 ET

// ---- mandatory 1-4: the ONE nomination rule -------------------------------
const nomRec = (z, accel, zThreshold = 3) => ({
  ts: new Date(T0).toISOString(),
  type: 'RUMINT_NOMINATION',
  provider: 'STOCKTWITS',
  symbol: 'BTC',
  providerSymbol: 'BTC.X',
  pollSourceEventId: 'c'.repeat(40),
  z,
  zThreshold,
  acceleration: accel,
  sourceEventId: nominationEventIdentity({ pollSourceEventId: 'c'.repeat(40) }),
});

test('R1B 1-4: the shared nomination rule — producer and validator agree exactly, threshold unchanged', () => {
  // the predicate itself
  assert.equal(nominationQualifies(2.99, 5, 3), false);
  assert.equal(nominationQualifies(3, 0, 3), false);
  assert.equal(nominationQualifies(3, -1, 3), false);
  assert.equal(nominationQualifies(3, 0.1, 3), true);
  assert.equal(nominationQualifies(null, 5, 3), false);
  assert.equal(nominationQualifies(5, null, 3), false);
  // the producer wraps the SAME predicate
  assert.equal(shouldNominate({ zVelocity: 2.99, acceleration: 5 }, CFG()), false);
  assert.equal(shouldNominate({ zVelocity: 3, acceleration: 0 }, CFG()), false);
  assert.equal(shouldNominate({ zVelocity: 3, acceleration: 0.1 }, CFG()), true);
  // the validator enforces the SAME predicate: a record that never met the
  // rule is NOT a nomination, whatever its shape and identity claim
  assert.notEqual(validateSourceRecord(nomRec(2.99, 1)), null, 'z=2.99 rejected');
  assert.notEqual(validateSourceRecord(nomRec(3, 0)), null, 'acceleration=0 rejected');
  assert.notEqual(validateSourceRecord(nomRec(3, -2)), null, 'negative acceleration rejected');
  assert.equal(validateSourceRecord(nomRec(3, 0.1)), null, 'the real gate accepts');
  assert.notEqual(validateSourceRecord(nomRec(5, 2, 0)), null, 'non-positive threshold rejected');
});

// ---- fixtures for cross-consistency ---------------------------------------
// a coherent poll record + matching candidate baseline (revision 2)
function builtPoll({ nominated = true } = {}) {
  let b = emptyBaseline('BTC.X', 'BTC');
  ({ baseline: b } = ingestPage(b, [{ id: 100, created_at: new Date(T0 - 120_000).toISOString() }], T0 - 60_000)); // rev 1
  ({ baseline: b } = ingestPage(b, [{ id: 101, created_at: new Date(T0 - 30_000).toISOString() }], T0)); // rev 2
  const retrievedTs = new Date(T0).toISOString();
  const z = nominated ? 5 : 2;
  const rec = {
    ts: retrievedTs,
    type: 'RUMINT_POLL',
    provider: 'STOCKTWITS',
    canonicalCoin: 'BTC',
    providerSymbol: 'BTC.X',
    symbol: 'BTC.X',
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
    previousHourCount: 0,
    twoHoursPriorCount: null,
    historyBucketCount: 30,
    historyMean: 0.4,
    historyStd: 0.2,
    z,
    zReason: 'KNOWN',
    zThreshold: 3,
    acceleration: nominated ? 2 : null,
    accelerationReason: nominated ? 'KNOWN' : 'INSUFFICIENT_CONTIGUOUS_OBSERVATION',
    recentBull: 0,
    recentBear: 0,
    labeledTotal: 0,
    sentimentShift: null,
    gates: {
      zAvailable: true,
      zPass: nominated,
      accelerationAvailable: nominated,
      accelerationPass: nominated,
    },
    decision: nominated ? 'NOMINATED' : 'Z_BELOW_THRESHOLD',
    baselineRevision: 2,
  };
  rec.sourceEventId = pollEventIdentity({ providerSymbol: 'BTC.X', retrievedTs, baselineRevision: 2 });
  const nomination = nominated
    ? {
        ts: retrievedTs,
        type: 'RUMINT_NOMINATION',
        provider: 'STOCKTWITS',
        symbol: 'BTC',
        providerSymbol: 'BTC.X',
        pollSourceEventId: rec.sourceEventId,
        z: rec.z,
        zThreshold: rec.zThreshold,
        acceleration: rec.acceleration,
        sourceEventId: nominationEventIdentity({ pollSourceEventId: rec.sourceEventId }),
      }
    : null;
  return { record: rec, nomination, candidate: b };
}

function txnOf({ record, nomination, candidate }) {
  return {
    version: 1,
    state: 'PREPARED',
    provider: 'STOCKTWITS',
    canonicalCoin: 'BTC',
    providerSymbol: 'BTC.X',
    prePollBaselineRevision: 1,
    candidateBaselineRevision: 2,
    acceptedIds: ['101'],
    record,
    sourceEventId: record.sourceEventId,
    candidateBaseline: candidate,
    nominationRecord: nomination,
  };
}

test('R1B 6-8: poll<->nomination cross-consistency in the transaction is exact', () => {
  const good = builtPoll({ nominated: true });
  assert.equal(validatePollTransaction(txnOf(good)), null, 'an honest nominating transaction validates');
  // 6. a bound nomination on a poll that did NOT decide NOMINATED
  const not = builtPoll({ nominated: false });
  const forged = txnOf(not);
  forged.nominationRecord = builtPoll({ nominated: true }).nomination; // fabricate an attachment
  forged.nominationRecord = { ...forged.nominationRecord, pollSourceEventId: not.record.sourceEventId, sourceEventId: nominationEventIdentity({ pollSourceEventId: not.record.sourceEventId }) };
  assert.match(validatePollTransaction(forged) ?? '', /did not decide NOMINATED/);
  // a NOMINATED poll stripped of its bound nomination is equally refused
  const stripped = txnOf(good);
  stripped.nominationRecord = null;
  assert.match(validatePollTransaction(stripped) ?? '', /missing its bound nomination/);
  // 7. nomination z disagrees with its poll
  const zDiff = txnOf(builtPoll({ nominated: true }));
  zDiff.nominationRecord = { ...zDiff.nominationRecord, z: 4 };
  assert.match(validatePollTransaction(zDiff) ?? '', /disagree with cause/);
  // 8. nomination acceleration disagrees with its poll
  const aDiff = txnOf(builtPoll({ nominated: true }));
  aDiff.nominationRecord = { ...aDiff.nominationRecord, acceleration: 3 };
  assert.match(validatePollTransaction(aDiff) ?? '', /disagree with cause/);
  // and a poll whose own decision contradicts its numbers cannot validate at all
  const incoherent = builtPoll({ nominated: false }).record;
  incoherent.decision = 'NOMINATED';
  assert.match(validateSourceRecord(incoherent) ?? '', /decision contradicts|gates contradict/);
});

test('R1B 9: a pending nomination without its exact triggering-poll proof is refused', () => {
  const { record, nomination } = builtPoll({ nominated: true });
  assert.equal(validatePendingEntry({ kind: 'NOMINATION', record: nomination, cause: record, basis: null }), null, 'proof present: valid');
  assert.match(validatePendingEntry({ kind: 'NOMINATION', record: nomination, cause: null, basis: null }) ?? '', /missing its triggering poll proof/);
  // a cause pointing at a DIFFERENT poll is not proof
  const other = builtPoll({ nominated: true }).record;
  other.retrievedTs = new Date(T0 + 60_000).toISOString();
  other.ts = other.retrievedTs;
  other.sourceEventId = pollEventIdentity({ providerSymbol: 'BTC.X', retrievedTs: other.retrievedTs, baselineRevision: 2 });
  assert.match(validatePendingEntry({ kind: 'NOMINATION', record: nomination, cause: other, basis: null }) ?? '', /does not point at its cause/);
});

// ---- 5: a false pending nomination can never restore ----------------------
test('R1B 5: a checkpoint carrying a false pending nomination is rejected and adopts/appends NOTHING', async () => {
  const d = freshDir();
  // an otherwise fully valid checkpoint
  let b = emptyBaseline('BTC.X', 'BTC');
  ({ baseline: b } = ingestPage(b, [{ id: 100, created_at: new Date(T0 - 120_000).toISOString() }], T0 - 60_000));
  const baselines = { 'BTC.X': b };
  const hy = hypedSnapshot({ baselines, atMs: T0 });
  const cp = {
    version: RUMINT_CHECKPOINT_VERSION,
    savedTs: new Date(T0).toISOString(),
    provider: 'STOCKTWITS',
    baselines,
    hyped: { ...hy, finalizedTs: new Date(T0).toISOString() },
    providerHealth: { globalBackoffUntil: 0, recentRequestTimestamps: [], symbols: {} },
    pendingEvents: [{ kind: 'NOMINATION', record: nomRec(2.99, 1), cause: null, basis: null }],
    pollTransaction: null,
    counters: {},
  };
  assert.notEqual(validateCheckpoint(cp), null, 'the false nomination poisons the checkpoint');
  const store = memStore();
  store.state = cp;
  const clock = { ms: T0 + 3_600_000 };
  const fetchImpl = scriptedFetch([]);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  await r.tickOnce();
  assert.equal(statusOf(d).status, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(linesOf(d, 'RUMINT_NOMINATION').length, 0, 'the false nomination never appends');
  assert.deepEqual(readStalking(clock.ms), {});
  await r.stop();
});

// ---- 10-11: pending HYPED semantic proof ----------------------------------
const basisFor = (entries) => ({ v: 1, sessionDate: '2026-09-01', entries });
const hypedRecFromBasis = (basis) => {
  const snap = hypedSnapshotFromBasis(basis);
  return {
    ts: new Date(T0 - 86_400_000).toISOString(),
    type: 'HYPED_SESSION',
    sourceEventId: snap.identity,
    provider: 'STOCKTWITS',
    sessionDate: snap.sessionDate,
    state: snap.state,
    symbols: snap.symbols,
    coverage: snap.coverage,
  };
};

test('R1B 10: a pending HYPED that contradicts its own semantic basis is refused', () => {
  const basis = basisFor([{ coin: 'AAA', observedLabels: [0, 1, 2, 3, 4, 5], overnight: 7 }]);
  const honest = hypedRecFromBasis(basis);
  assert.equal(validatePendingEntry({ kind: 'HYPED', record: honest, cause: null, basis }), null, 'the provable snapshot validates');
  // internally self-consistent fabrication: READY [DOGE] with a matching
  // identity — but the basis proves READY [AAA]
  const forged = {
    ...honest,
    state: 'READY',
    symbols: ['DOGE'],
    sourceEventId: hypedSessionIdentity({ sessionDate: honest.sessionDate, state: 'READY', symbols: ['DOGE'] }),
  };
  assert.match(validatePendingEntry({ kind: 'HYPED', record: forged, cause: null, basis }) ?? '', /contradicts its own semantic basis/);
  // no basis at all is not proof either
  assert.notEqual(validatePendingEntry({ kind: 'HYPED', record: honest, cause: null, basis: null }), null);
});

test('R1B 11: a legitimate OLDER pending HYPED stays provable after the canonical set changed, and appends once', async () => {
  const d = freshDir();
  // yesterday's owed transition: READY [AAA], proven by its immutable basis
  const oldBasis = basisFor([{ coin: 'AAA', observedLabels: [0, 1, 2, 3, 4, 5], overnight: 7 }]);
  const oldRec = hypedRecFromBasis(oldBasis);
  assert.equal(oldRec.state, 'READY');
  assert.deepEqual(oldRec.symbols, ['AAA']);
  // today's canonical truth is different (PARTIAL — no overnight coverage)
  let b = emptyBaseline('BTC.X', 'BTC');
  ({ baseline: b } = ingestPage(b, [{ id: 100, created_at: new Date(T0 - 120_000).toISOString() }], T0 - 60_000));
  const baselines = { 'BTC.X': b };
  const hy = hypedSnapshot({ baselines, atMs: T0 });
  assert.notEqual(hy.identity, oldRec.sourceEventId, 'the canonical set has genuinely moved on');
  const cp = {
    version: RUMINT_CHECKPOINT_VERSION,
    savedTs: new Date(T0).toISOString(),
    provider: 'STOCKTWITS',
    baselines,
    hyped: { ...hy, finalizedTs: new Date(T0).toISOString() },
    providerHealth: { globalBackoffUntil: 0, recentRequestTimestamps: [], symbols: {} },
    pendingEvents: [{ kind: 'HYPED', record: oldRec, cause: null, basis: oldBasis }],
    pollTransaction: null,
    counters: {},
  };
  assert.equal(validateCheckpoint(cp), null, 'history is not rejected by a naive current-state comparison');
  const store = memStore();
  store.state = cp;
  const clock = { ms: T0 + 3_600_000 };
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl: scriptedFetch([page([])]), now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  await r.tickOnce();
  const owed = linesOf(d, 'HYPED_SESSION').filter((e) => e.sourceEventId === oldRec.sourceEventId);
  assert.equal(owed.length, 1, 'the owed historical transition wrote exactly once');
  assert.deepEqual(owed[0], oldRec, 'exact content, exact identity — nothing regenerated');
  await r.stop();
});

// ---- 12-19: recovery nomination is durable debt ---------------------------
async function buildNominationCrash() {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const a = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(999, clock.ms - 60_000)])); // watermark init
  await a.tickOnce();
  let id = 1000;
  for (let h = 0; h < 27; h++) {
    clock.ms += 3_600_000;
    const n = h % 2 === 0 ? 9 : 11;
    queue.push(page(Array.from({ length: n }, () => msg(id++, clock.ms - 60_000))));
    await a.tickOnce();
  }
  const savesBefore = store.saves.length;
  clock.ms += 3_600_000;
  queue.push(page(Array.from({ length: 40 }, () => msg(id++, clock.ms - 60_000)))); // the nominating spike
  await a.tickOnce();
  assert.equal(linesOf(d, 'RUMINT_NOMINATION').length, 1, 'the live nomination fired');
  assert.equal(a.counters.nominations, 1);
  const txnSave = store.saves.slice(savesBefore).find((s) => s.pollTransaction);
  assert.ok(txnSave?.pollTransaction?.nominationRecord, 'the write-ahead bound the nomination');
  assert.equal(validateCheckpoint(txnSave), null, 'the nominating transaction checkpoint validates');
  await a.stop();
  // CRASH: durable row rolls back to the write-ahead; the source stream
  // kept the POLL but the NOMINATION never made it
  store.state = structuredClone(txnSave);
  const ev = path.join(d, 'rumint', 'events.jsonl');
  const kept = readFileSync(ev, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => JSON.parse(l).type !== 'RUMINT_NOMINATION');
  writeFileSync(ev, kept.join('\n') + '\n');
  rmSync(path.join(d, 'state', 'stalking.json'), { force: true }); // the crash took the VM's transient state
  return { d, store, clock, txn: structuredClone(txnSave.pollTransaction) };
}

test('R1B 12-16/19: a bound nomination survives writer failure at recovery and lands exactly once, without stalking', async () => {
  const { d, store, clock, txn } = await buildNominationCrash();
  // PHASE 1 — the source writer is down at restart: the transaction is
  // retained (never "try once and forget"), nothing is lost, no polling
  const ev = path.join(d, 'rumint', 'events.jsonl');
  renameSync(ev, ev + '.orig');
  mkdirSync(ev);
  const q = [];
  const fetchImpl = scriptedFetch(q);
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 10_000;
  await b.tickOnce();
  assert.ok(b.internals.pollTransaction, '12. the transaction/debt survives the failed recovery');
  assert.ok(store.state.pollTransaction, 'and survives durably in the next checkpoint');
  assert.equal(fetchImpl.calls.length, 0, 'no new observation while an advancement is owed its finish');
  // PHASE 2 — the writer recovers: the poll is recognized, the EXACT bound
  // nomination settles once, and stalking is NOT restored
  rmdirSync(ev);
  renameSync(ev + '.orig', ev);
  clock.ms += 10_000;
  await b.tickOnce();
  assert.equal(b.internals.pollTransaction, null, 'the transaction settled');
  const noms = linesOf(d, 'RUMINT_NOMINATION');
  assert.equal(noms.length, 1, '13. the exact nomination wrote once');
  assert.deepEqual(noms[0], txn.nominationRecord, '14. identical record, identical sourceEventId');
  assert.equal(
    linesOf(d, 'RUMINT_POLL').filter((p) => p.sourceEventId === txn.sourceEventId).length,
    1,
    '15. no second poll emitted'
  );
  assert.deepEqual(readStalking(clock.ms), {}, '16. recovery never restores stalking');
  assert.equal(b.internals.baselines['BTC.X'].baselineRevision, txn.candidateBaselineRevision, 'candidate finalized');
  assert.equal(b.counters.nominations, 1, '19. counter reflects exactly one emitted nomination');
  // and a further restart changes nothing: the truth is settled
  await b.stop();
  const c = startRumint({ log: () => {}, config: CFG(), fetchImpl: scriptedFetch([page([])]), now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 2 * 3_600_000; // a later, quiet hour — a fresh empty poll must not (and does not) re-qualify
  await c.tickOnce();
  assert.equal(linesOf(d, 'RUMINT_NOMINATION').length, 1, 'still exactly once after another restart');
  assert.equal(c.counters.nominations, 1, 'restored counter does not double-count');
  await c.stop();
});

test('R1B 17-18: recovery under a full pending queue retains the transaction; the nomination lands after the queue drains', async () => {
  const { d, store, clock } = await buildNominationCrash();
  // pre-load the checkpoint's pending queue to the hard cap with valid owed
  // POLL debt, and run the collector at exactly that capacity
  const owedPoll = builtPoll({ nominated: false });
  store.state.pendingEvents = [{ kind: 'POLL', record: owedPoll.record, cause: null, basis: null }];
  assert.equal(validateCheckpoint(store.state), null);
  const ev = path.join(d, 'rumint', 'events.jsonl');
  renameSync(ev, ev + '.orig');
  mkdirSync(ev); // writer down: neither the owed debt nor the recovery can settle
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl: scriptedFetch([]), now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store, maxPendingEvents: 1 });
  clock.ms += 10_000;
  await b.tickOnce();
  assert.ok(b.internals.pollTransaction, '17. transaction retained while nothing can settle');
  assert.equal(b.internals.pending.length, 1, 'the owed queue is untouched at its cap');
  assert.equal(statusOf(d).status, 'FAILED_EVIDENCE_BACKLOG');
  // writer heals: the queue drains, then the recovery settles the nomination
  rmdirSync(ev);
  renameSync(ev + '.orig', ev);
  clock.ms += 10_000;
  await b.tickOnce();
  assert.equal(b.internals.pollTransaction, null);
  assert.equal(b.internals.pending.length, 0, '18. debt drained');
  assert.equal(linesOf(d, 'RUMINT_NOMINATION').length, 1, 'the nomination eventually wrote exactly once');
  assert.equal(eventLines(d).filter((e) => e.sourceEventId === owedPoll.record.sourceEventId).length, 1, 'the owed poll debt also wrote once');
  assert.equal(b.counters.nominations, 1, 'counter exactly one');
  assert.deepEqual(readStalking(clock.ms), {}, 'still no stalking from recovery');
  await b.stop();
});
