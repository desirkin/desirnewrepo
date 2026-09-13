import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { prepareDailyBroadInput } from '../learning/daily-broad-input.js';
import {
  buildDailyMoveStudy, sealDailyMoveStudyManifest,
} from '../learning/daily-move-study.js';
import {
  openDailyStudyStore, sealDailyStudyInputDescriptor,
  sealDailyStudyJobDescriptor, sealDailyStudyResultReceipt,
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

function record({ sequence, eventTs, price, sourceCatalog }) {
  const market = rawMarket('BTC');
  const value = {
    recordVersion: 'broad-kraken-record-v1', recordId: null,
    sessionId: 'independent-review-session', sequence, recordType: 'TICKER',
    recordedTs: eventTs + 2, catalogContentId: sourceCatalog.contentId,
    epochId: 'independent-review-epoch',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey,
      nativeBase: market.nativeBase, catalogWsname: market.wsname,
      wsSymbol: market.wsname,
    },
    channel: 'ticker', quality: 'OBSERVED', sourceEventTs: eventTs,
    receivedTs: eventTs + 1, periodStartTs: null, periodEndTs: null,
    payload: {
      messageType: 'update', lastPrice: price, bid: price - 1, ask: price + 1,
      bidQty: 2, askQty: 3, change24h: 1, changePct24h: 1,
      high24h: price + 5, low24h: price - 5, volume24hBase: 1000,
      vwap24h: price, tickerTimestampTs: eventTs, missingFields: [], invalidFields: [],
    },
  };
  value.recordId = `bkr-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  return value;
}

function capture() {
  const sourceCatalog = catalog();
  return {
    catalog: sourceCatalog,
    records: [
      record({ sequence: 1, eventTs: START + HOUR, price: 100, sourceCatalog }),
      record({ sequence: 2, eventTs: START + 2 * HOUR, price: 109, sourceCatalog }),
    ],
    dayStartTs: START, dayEndTs: END, finalizedTs: FINAL,
    captureStartTs: START, captureEndTs: FINAL, truncated: false,
  };
}

const declaration = (extra = {}) => sealDailyStudyRunnerJob({
  jobId: 'independent-daily-2026-09-13', sourceId: 'independent-bounded-capture',
  declaredTs: FINAL, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
  ...extra,
});

const monotonicClock = () => {
  let now = FINAL + 1;
  return () => now++;
};

test('independent review: the real runner/store retain the denominator and bind terminal reuse to exact content', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'serpent-daily-independent-'));
  let store;
  try {
    store = await openDailyStudyStore({ rootDir, clock: monotonicClock() });
    const runner = createDailyStudyRunner({
      declaredJob: declaration(), outputStore: store,
      inputLoader: async () => capture(), yieldControl: async () => {},
    });
    const result = await runner.run();
    assert.equal(result.status, 'FINALIZED');
    assert.equal(result.study.counters.acceptedMarketDays, 2);
    assert.equal(result.study.counters.dispositions.SURGE_CASE, 1);
    assert.equal(result.study.counters.attemptedSimulations, 0);
    assert.equal(result.study.counters.completedSimulations, 0);
    assert.equal(result.study.counters.validSimulationOutcomes, 0);
    assert.equal(result.result.resultMode, 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY');
    assert.equal(result.detailedStudyPersistedByReceiptStore, false);
    assert.equal(result.durability.republishSafe, false);

    const durable = await store.loadJob(declaration().jobId);
    assert.equal(durable.job.inputDescriptor.fullDayCatalogEpochUnionVerified, false);
    assert.equal(durable.job.inputDescriptor.persistedRecordContinuityVerified, false);
    assert.equal(durable.result.externalArchive, 'UNKNOWN');

    const conflicting = createDailyStudyRunner({
      declaredJob: declaration({ rules: { controlsPerClass: 2 } }), outputStore: store,
      inputLoader: async () => capture(), yieldControl: async () => {},
    });
    await assert.rejects(conflicting.run(), (error) => error?.code === 'JOB_ID_CONFLICT');

    const malformedPort = {
      createJob: store.createJob,
      checkpoint: store.checkpoint,
      finalize: store.finalize,
      loadJob: async (jobId) => {
        const view = structuredClone(await store.loadJob(jobId));
        view.result = null;
        return view;
      },
    };
    const malformed = createDailyStudyRunner({
      declaredJob: declaration(), outputStore: malformedPort,
      inputLoader: async () => { throw new Error('must reject the stored view before loading input'); },
      yieldControl: async () => {},
    });
    await assert.rejects(malformed.run(), (error) => error?.code === 'STORE_VIEW_INVALID');
  } finally {
    if (store) await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('independent review: deletion of committed progress latches custody loss and cannot become a completion receipt', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'serpent-daily-custody-'));
  let store;
  try {
    store = await openDailyStudyStore({ rootDir, clock: monotonicClock() });
    const first = createDailyStudyRunner({
      declaredJob: declaration({ jobId: 'independent-custody-job' }), outputStore: store,
      inputLoader: async () => capture(), yieldControl: async () => {},
    });
    const checkpointed = await first.run({ maxSteps: 1 });
    assert.equal(checkpointed.progress.phase, 'INPUT_VALIDATED');

    const stateFile = path.join(rootDir, 'jobs', 'independent-custody-job.json');
    unlinkSync(stateFile);
    const resumed = createDailyStudyRunner({
      declaredJob: declaration({ jobId: 'independent-custody-job' }), outputStore: store,
      inputLoader: async () => capture(), yieldControl: async () => {},
    });
    await assert.rejects(resumed.run({ maxSteps: 1 }), (error) => error?.code === 'DISK_CUSTODY_CONFLICT');
    assert.equal(store.status().failed?.code, 'DISK_CUSTODY_CONFLICT');
    await assert.rejects(store.loadJob('independent-custody-job'), (error) => error?.code === 'STORE_LATCHED');
  } finally {
    if (store) await store.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('independent review: result sealing re-runs the planner and refuses a caller-mutated study', () => {
  const sourceCapture = capture();
  const preparedInput = prepareDailyBroadInput(sourceCapture);
  assert.equal(preparedInput.ok, true);
  const inputDescriptor = sealDailyStudyInputDescriptor({
    sourceId: 'independent-bounded-capture', capture: sourceCapture, preparedInput,
  });
  const manifest = sealDailyMoveStudyManifest({
    createdTs: FINAL, timeZone: 'America/New_York', localDay: '2026-09-13',
    dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: preparedInput.acceptedCatalogSnapshot,
  });
  const jobDescriptor = sealDailyStudyJobDescriptor({
    jobId: 'independent-semantic-job', manifest, inputDescriptor,
  });
  const study = buildDailyMoveStudy({
    manifest, acceptedCatalogSnapshot: preparedInput.acceptedCatalogSnapshot,
    marketDays: preparedInput.marketDays,
  });
  const receipt = sealDailyStudyResultReceipt({ jobDescriptor, study, preparedInput });
  assert.equal(receipt.caseCount, 2);

  const altered = structuredClone(study);
  altered.laws.moveDefinition = 'CALLER_MUTATED_LAW';
  assert.throws(
    () => sealDailyStudyResultReceipt({ jobDescriptor, study: altered, preparedInput }),
    (error) => error?.code === 'RESULT_INVALID' && /independent planner recomputation/.test(error.message),
  );
});
