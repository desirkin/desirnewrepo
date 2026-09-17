// PUBLISH-FIX-35 (2026-09-17): the daily coverage counts are streamed, not readFileSync'd — same law as the synchronous read
// (invalid rows withheld and counted, torn lines skipped), and buildDailySummary accepts the pre-counted coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLearningStore } from '../learning/store.js';
import { buildCoverageRow, reconcileCoverage } from '../learning/capture.js';
import { buildDailySummary } from '../learning/summary.js';
import { utcDateOf } from '../learning/contracts.js';

const T = Date.UTC(2026, 8, 17, 11, 0, 0);

test('streamed counts equal the synchronous reconciliation; torn and invalid lines are withheld, never counted', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'serpent-cov-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const date = utcDateOf(T);
    const attn = ['EVALUATED', 'EVALUATED', 'MISSED_EVALUATION', 'UNAVAILABLE', 'EVALUATED'];
    attn.forEach((attention, i) => store.appendCoverage(buildCoverageRow({ sweepId: 'sweep-1', sweepTs: T, canonicalCoin: `C${i}`, attention, reasonCode: attention === 'UNAVAILABLE' ? 'INSUFFICIENT_SERIES' : null })));
    const file = path.join(store.dir, 'coverage', `${date}.jsonl`);
    appendFileSync(file, '{"torn": tru\n'); // a torn line
    appendFileSync(file, JSON.stringify({ ledgerVersion: 'nope', attention: 'EVALUATED' }) + '\n'); // an invalid row
    const sync = reconcileCoverage(store.readCoverage(date));
    const streamed = await store.coverageCountsStreamed(date);
    assert.deepEqual(streamed.counts, sync.counts);
    assert.equal(streamed.denominator, 5); assert.equal(sync.denominator, 5);
    assert.equal(streamed.reconciles, true); assert.equal(streamed.rows, 5); assert.equal(streamed.invalid, 1); assert.equal(streamed.torn, 1);
    const summary = buildDailySummary({ store, utcDate: date, nowTs: T + 1, coverage: streamed });
    assert.equal(summary.coverage.denominator, 5); assert.deepEqual(summary.coverage.counts, sync.counts); assert.equal(summary.coverage.reconciles, true);
    const absent = await store.coverageCountsStreamed('2026-01-01');
    assert.equal(absent.denominator, 0); assert.equal(absent.reconciles, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
