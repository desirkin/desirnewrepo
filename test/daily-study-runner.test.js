import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DAILY_STUDY_PROGRESS_VERSION, DailyStudyStoreError,
  dailyStudyJobDescriptorError, dailyStudyProgressUpdateError,
  dailyStudyResultReceiptError, openDailyStudyStore, sealDailyStudyResultReceipt,
} from '../learning/daily-study-store.js';
import {
  createDailyStudyRunner, sealDailyStudyRunnerJob,
} from '../learning/daily-study-runner.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 24 * HOUR;
const FINAL = END + HOUR;
const MARKET_KEYS = ['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status'];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const rawMarket = (base) => ({
  pairKey: `${base}USD`, nativeBase: `X${base}`, nativeQuote: 'ZUSD',
  wsname: `${base}/USD`, base, quote: 'USD', status: 'online',
});

function catalog() {
  const markets = [rawMarket('BTC'), rawMarket('ETH')];
  const value = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs: START + 1, contentId: '', markets };
  const selected = markets.map((market) => Object.fromEntries(MARKET_KEYS.map((key) => [key, market[key]])));
  value.contentId = createHash('sha1').update(canonicalJson({
    venue: value.venue, quote: value.quote, policyVersion: value.policyVersion, markets: selected,
  })).digest('hex');
  return value;
}

function tickerPayload(eventTs, price) {
  return {
    messageType: 'update', lastPrice: price, bid: price - 1, ask: price + 1,
    bidQty: 2, askQty: 3, change24h: 1, changePct24h: 1,
    high24h: price + 5, low24h: price - 5, volume24hBase: 1000,
    vwap24h: price, tickerTimestampTs: eventTs, missingFields: [], invalidFields: [],
  };
}

function record({ seq, eventTs, price, sourceCatalog }) {
  const market = rawMarket('BTC');
  const value = {
    recordVersion: 'broad-kraken-record-v1', recordId: null,
    sessionId: 'bks-session-1', sequence: seq, recordType: 'TICKER',
    recordedTs: eventTs + 2, catalogContentId: sourceCatalog.contentId,
    epochId: 'epoch-1',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey,
      nativeBase: market.nativeBase, catalogWsname: market.wsname,
      wsSymbol: market.wsname,
    },
    channel: 'ticker', quality: 'OBSERVED', sourceEventTs: eventTs,
    receivedTs: eventTs + 1, periodStartTs: null, periodEndTs: null,
    payload: tickerPayload(eventTs, price),
  };
  value.recordId = `bkr-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  return value;
}

function capture() {
  const sourceCatalog = catalog();
  return {
    catalog: sourceCatalog,
    records: [
      record({ seq: 1, eventTs: START + HOUR, price: 100, sourceCatalog }),
      record({ seq: 2, eventTs: START + 2 * HOUR, price: 109, sourceCatalog }),
    ],
    dayStartTs: START, dayEndTs: END, finalizedTs: FINAL,
    captureStartTs: START, captureEndTs: FINAL, truncated: false,
  };
}

const declaration = (extra = {}) => sealDailyStudyRunnerJob({
  jobId: 'daily-2026-09-13', sourceId: 'bounded-broad-fixture',
  declaredTs: FINAL, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
  ...extra,
});

function makeFakeStore() {
  let state = null; let now = FINAL + 1; const phases = [];
  const view = (status) => structuredClone({
    ...(status ? { status } : {}), jobDigest: state.job.jobDigest,
    revision: state.revision, job: state.job, progress: state.progress, result: state.result,
  });
  const storedProgress = (progress) => ({
    progressVersion: DAILY_STUDY_PROGRESS_VERSION, ...structuredClone(progress), updatedTs: now++,
  });
  return {
    phases,
    async loadJob(jobId) { return state?.job.jobId === jobId ? view() : null; },
    async createJob({ jobDescriptor }) {
      const error = dailyStudyJobDescriptorError(jobDescriptor);
      if (error) throw new DailyStudyStoreError('JOB_INVALID', error);
      if (state) {
        if (state.job.jobDigest !== jobDescriptor.jobDigest) throw new DailyStudyStoreError('JOB_ID_CONFLICT');
        return view('EXISTING');
      }
      state = {
        revision: 0, job: structuredClone(jobDescriptor), result: null,
        progress: storedProgress({
          phase: 'DECLARED', completedSteps: 0, totalSteps: 0,
          plannedDecisionMoments: 0, grossPlannedRecipeVariantSlots: 0,
          attemptedSimulations: 0, completedSimulations: 0,
          validSimulationOutcomes: 0, cancelled: false, note: null,
        }),
      };
      return view('CREATED');
    },
    async checkpoint({ jobId, jobDigest, expectedRevision, progress }) {
      const error = dailyStudyProgressUpdateError(progress);
      if (error) throw new DailyStudyStoreError('CHECKPOINT_INVALID', error);
      if (state.job.jobId !== jobId || state.job.jobDigest !== jobDigest) throw new DailyStudyStoreError('JOB_DIGEST_CONFLICT');
      if (state.revision !== expectedRevision) throw new DailyStudyStoreError('REVISION_CONFLICT');
      state.revision += 1; state.progress = storedProgress(progress); phases.push(progress.phase);
      return view('CHECKPOINTED');
    },
    async finalize({ jobId, jobDigest, expectedRevision, resultReceipt: proposedReceipt, study, preparedInput }) {
      assert.equal(proposedReceipt, undefined, 'runner delegates sealing to the authoritative store');
      const resultReceipt = sealDailyStudyResultReceipt({ jobDescriptor: state.job, study, preparedInput });
      const error = dailyStudyResultReceiptError(resultReceipt, state.job);
      if (error) throw new DailyStudyStoreError('RESULT_INVALID', error);
      if (state.job.jobId !== jobId || state.job.jobDigest !== jobDigest || state.revision !== expectedRevision) throw new DailyStudyStoreError('REVISION_CONFLICT');
      if (state.result) {
        if (state.result.resultDigest !== resultReceipt.resultDigest) throw new DailyStudyStoreError('RESULT_CONFLICT');
        return view('EXISTING');
      }
      state.revision += 1; state.result = structuredClone(resultReceipt);
      state.progress = storedProgress({ ...state.progress, phase: 'FINALIZED' });
      delete state.progress.progressVersion;
      delete state.progress.updatedTs;
      state.progress = storedProgress(state.progress);
      return view('FINALIZED');
    },
    corrupt(mutator) { mutator(state); },
  };
}

test('runs the real bounded adapter and retrospective planner, retains the denominator, and persists only zero-credit planning truth', async () => {
  const store = makeFakeStore(); let loads = 0;
  const runner = createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store,
    inputLoader: async () => { loads += 1; return capture(); },
    yieldControl: async () => {},
  });
  const result = await runner.run();
  assert.equal(result.status, 'FINALIZED');
  assert.equal(loads, 1);
  assert.deepEqual(store.phases, ['INPUT_VALIDATED', 'STUDY_BUILT', 'PLAN_COMPLETE']);
  assert.equal(result.study.cases.length, 2);
  assert.equal(result.study.counters.acceptedMarketDays, 2);
  assert.equal(result.study.counters.dispositions.SURGE_CASE, 1);
  assert.equal(result.study.counters.attemptedSimulations, 0);
  assert.equal(result.study.counters.completedSimulations, 0);
  assert.equal(result.result.resultMode, 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY');
  assert.equal(result.detailedStudyPersistedByReceiptStore, false);
  assert.equal(result.durability.republishSafe, false);
});

test('one-step runs restart by immutable content identity and a finalized retry remains idempotent', async () => {
  const store = makeFakeStore(); let loads = 0;
  const makeRunner = () => createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store,
    inputLoader: async () => { loads += 1; return capture(); }, yieldControl: async () => {},
  });
  const first = await makeRunner().run({ maxSteps: 1 });
  assert.equal(first.progress.phase, 'INPUT_VALIDATED');
  const second = await makeRunner().run({ maxSteps: 1 });
  assert.equal(second.progress.phase, 'STUDY_BUILT');
  const third = await makeRunner().run({ maxSteps: 1 });
  assert.equal(third.status, 'FINALIZED');
  assert.equal(loads, 3, 'bounded input is deliberately revalidated because prepared rows are not the receipt store');
  const fourth = await makeRunner().run({ maxSteps: 1 });
  assert.equal(fourth.status, 'EXISTING_FINALIZED');
  assert.equal(fourth.jobDigest, third.jobDigest);
  assert.equal(fourth.study, null, 'the local receipt does not pretend to archive detailed cases');
  assert.equal(loads, 4, 'even terminal jobIds are rebound to source/day/rules before early return');
});

test('concurrent run calls are one single flight and step boundaries yield', async () => {
  const store = makeFakeStore(); let release; let loads = 0; let yields = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const runner = createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store,
    inputLoader: async () => { loads += 1; await held; return capture(); },
    yieldControl: async () => { yields += 1; },
  });
  const a = runner.run({ maxSteps: 1 }); const b = runner.run({ maxSteps: 1 });
  assert.strictEqual(a, b);
  await Promise.resolve(); assert.equal(loads, 1);
  release(); const result = await a;
  assert.equal(result.progress.phase, 'INPUT_VALIDATED');
  assert.equal(yields, 1);
  assert.equal(runner.status().inFlight, false);
});

test('cancellation at a durable yield is terminal and cannot claim simulation work', async () => {
  const store = makeFakeStore(); let runner;
  runner = createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store, inputLoader: async () => capture(),
    yieldControl: async () => { runner.cancel('bounded test cancellation'); },
  });
  const result = await runner.run();
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.progress.phase, 'CANCELLED');
  assert.equal(result.progress.cancelled, true);
  assert.equal(result.progress.attemptedSimulations, 0);
  assert.equal(result.result, null);
  assert.match(result.progress.note, /bounded test cancellation/);
});

test('refused partial input and malformed terminal store views fail closed without a false result', async () => {
  const store = makeFakeStore();
  const badInput = createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store,
    inputLoader: async () => ({ ...capture(), truncated: true }), yieldControl: async () => {},
  });
  await assert.rejects(badInput.run(), (error) => error?.code === 'INPUT_REFUSED' && error?.inputReason === 'CAPTURE_TRUNCATED');
  assert.equal(await store.loadJob('daily-2026-09-13'), null);

  const good = createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store,
    inputLoader: async () => capture(), yieldControl: async () => {},
  });
  await good.run();
  store.corrupt((state) => { state.result = null; });
  const reader = createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store,
    inputLoader: async () => capture(), yieldControl: async () => {},
  });
  await assert.rejects(reader.run(), (error) => error?.code === 'STORE_VIEW_INVALID');
});

test('a reused terminal jobId with different declared rules is rejected after content recomputation', async () => {
  const store = makeFakeStore();
  const original = createDailyStudyRunner({
    declaredJob: declaration(), outputStore: store,
    inputLoader: async () => capture(), yieldControl: async () => {},
  });
  await original.run();
  const conflicting = createDailyStudyRunner({
    declaredJob: declaration({ rules: { controlsPerClass: 2 } }), outputStore: store,
    inputLoader: async () => capture(), yieldControl: async () => {},
  });
  await assert.rejects(conflicting.run(), (error) => error?.code === 'JOB_ID_CONFLICT');
});

test('the real local store independently revalidates and durably finalizes the runner result receipt', async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'serpent-daily-runner-'));
  let store;
  try {
    store = await openDailyStudyStore({ rootDir, clock: (() => { let now = FINAL + 1; return () => now++; })() });
    const runner = createDailyStudyRunner({
      declaredJob: declaration({ jobId: 'real-store-2026-09-13' }), outputStore: store,
      inputLoader: async () => capture(), yieldControl: async () => {},
    });
    const result = await runner.run();
    assert.equal(result.status, 'FINALIZED');
    const durable = await store.loadJob('real-store-2026-09-13');
    assert.equal(durable.progress.phase, 'FINALIZED');
    assert.equal(durable.result.resultDigest, result.result.resultDigest);
    assert.equal(durable.result.attemptedSimulations, 0);
    assert.equal(durable.result.externalArchive, 'UNKNOWN');
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') t.skip('Windows directory fsync is unavailable on this filesystem');
    else throw error;
  } finally {
    if (store) await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
