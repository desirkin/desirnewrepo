import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createShadowLane } from '../learning/shadow-lane.js';
import { canonicalDigest } from '../learning/shadow-contracts.js';
import { createShadowStore } from '../learning/shadow-store.js';

const MIN = 60_000;
const T = Date.UTC(2026, 8, 13, 12, 0, 0);
const DATE = '2026-09-13';

const recipe = {
  recipeVersion: 'utf8-byte-accounting-1', styleId: 'MOMENTUM_CONTINUATION',
  requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: [],
  candleWindowMin: 2, candlePeriodMs: MIN, maxInputAgeMs: 2 * MIN, horizonMin: 2,
  costPolicy: { costPolicyVersion: 'utf8-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 },
  variants: [
    { variantId: 'take', decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 100 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 1, targetPct: 2 },
    { variantId: 'abstain', decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null },
  ],
};

const candles = [0, 1].map((i) => ({
  periodStartTs: T - (2 - i) * MIN, periodEndTs: T - (1 - i) * MIN,
  open: 100, high: 101, low: 99, close: 100, volumeBase: 10, volumeQuote: 1_000,
  closed: true, knownAtTs: T - (1 - i) * MIN,
}));

const seedUnicodeJournal = (dataDir) => {
  const dir = path.join(dataDir, 'learning-shadow');
  mkdirSync(dir, { recursive: true });
  const row = {
    seq: 1, prevDigest: 'GENESIS', ingestedTs: T, kind: 'CONTROL',
    body: { control: 'UTF8_BYTE_ACCOUNTING_SEED', note: 'café 🚀 市場' },
  };
  row.digest = canonicalDigest({ seq: row.seq, prevDigest: row.prevDigest, ingestedTs: row.ingestedTs, kind: row.kind, body: row.body });
  const line = `${JSON.stringify(row)}\n`;
  const journalFile = path.join(dir, 'journal.jsonl');
  writeFileSync(journalFile, line, 'utf8');
  return { journalFile, utf16Units: line.length, utf8Bytes: Buffer.byteLength(line, 'utf8') };
};

test('hydration charges exact physical UTF-8 JSONL bytes, including LF, and the lane blocks at the true byte boundary', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'shadow-utf8-bytes-'));
  try {
    const seeded = seedUnicodeJournal(dataDir);
    assert.ok(seeded.utf8Bytes > seeded.utf16Units, 'the fixture must distinguish UTF-8 bytes from UTF-16 code units');
    assert.equal(statSync(seeded.journalFile).size, seeded.utf8Bytes);

    const store = createShadowStore({ dataDir, clock: () => T + 1_000 });
    assert.equal(store.verify().ok, true);
    assert.equal(store.durableBytes(DATE), seeded.utf8Bytes);
    assert.equal(store.status().durableBytesToday, seeded.utf8Bytes);
    assert.equal(store.journalBytes(), seeded.utf8Bytes);

    const lane = createShadowLane({
      store, recipe, clock: () => T + 1_000, monotonic: () => 0,
      quotas: { maxDurableBytesPerDay: seeded.utf16Units },
    });
    const result = lane.runBatch({
      nowTs: T + 1_000,
      opportunities: [{ venue: 'kraken', assetId: 'BTC', decisionTs: T, inputs: { candles } }],
    });
    assert.equal(result.captured, 0);
    assert.equal(result.quota, 'BACKPRESSURE_DURABLE_QUOTA');
    assert.equal(result.shed, 2, 'both recipe variants are refused before any append');
    assert.equal(statSync(seeded.journalFile).size, seeded.utf8Bytes, 'quota refusal leaves the journal untouched');
    store.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
