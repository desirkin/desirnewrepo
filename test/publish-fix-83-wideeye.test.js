// PUBLISH-FIX-83 — review findings in the wide eye (survey/): a trailing return's sample must sit in a bounded band around the
// wanted age (a sweep gap no longer relabels a 3-minute move as a 1-minute return); baselines drop coins whose every bucket aged
// out and are written off the main thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { trailingSample, AT_SLACK_EARLY_MS, AT_SLACK_LATE_MS } from '../survey/eyecore.js';

const root = mkdtempSync(path.join(tmpdir(), 'serpent-fix83-wideeye-')); process.env.COBRA_DATA_DIR = root; process.env.WIDEEYE_ENABLED = 'true';
const { startWideEye } = await import('../survey/wideeye.js'); const { loadConfig } = await import('../lib/config.js');
test.after(() => { delete process.env.WIDEEYE_ENABLED; rmSync(root, { recursive: true, force: true }); });

test('FIX83-W8. trailingSample: the sample 1 minute ago is the one inside [-35 s, +5 s] of that age; after a gap the older sample is NOT relabelled', () => {
  const T = Date.UTC(2026, 8, 13, 12); const s = [{ t: T - 180_000, price: 1 }, { t: T - 120_000, price: 2 }, { t: T - 60_000, price: 3 }, { t: T, price: 4 }];
  assert.equal(trailingSample(s, T, 1).price, 3); assert.equal(trailingSample(s, T, 2).price, 2); assert.equal(trailingSample(s, T, 3).price, 1);
  assert.equal(trailingSample(s, T + 25_000, 1).price, 3, 'up to half a sweep of jitter is fine');
  const gapped = [{ t: T - 180_000, price: 1 }, { t: T, price: 4 }]; // the sweeps at -2 min and -1 min were missed
  assert.equal(trailingSample(gapped, T, 1), undefined, 'no 1-minute sample: the 3-minute-old one is not it'); assert.equal(trailingSample(gapped, T, 2), undefined); assert.equal(trailingSample(gapped, T, 3).price, 1);
  assert.equal(trailingSample(s, T, 5), undefined, 'older than the series');
  assert.equal(AT_SLACK_EARLY_MS, 35_000); assert.equal(AT_SLACK_LATE_MS, 30_000);
});

test('FIX83-W7. baselines persist: a coin with no surveyed hour in 7 days is dropped, the write is asynchronous and lands', async () => {
  const pairs = Object.fromEntries(['AAA'].map((coin) => [`${coin}USD`, { base: coin, quote: 'USD', wsname: `${coin}/USD`, altname: `${coin}USD`, status: 'online' }]));
  let now = Date.UTC(2026, 8, 13, 12); const logs = [];
  const baselinesFile = path.join(root, 'survey', 'baselines.json');
  const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(path.dirname(baselinesFile), { recursive: true });
  const stale = new Date(now - 9 * 86_400_000).toISOString().slice(0, 13); // an hour key 9 days old: outside the 7-day window
  writeFileSync(baselinesFile, JSON.stringify({ GONE: { ret1: { [stale]: { n: 3, sum: 0, sumSq: 0 } }, ret5: {}, volRate: {} }, EMPTY: { ret1: {}, ret5: {}, volRate: {} } }));
  const eye = startWideEye({ config: loadConfig(), log: (m) => logs.push(String(m)), now: () => now, registerSignals: false, nominationEnabled: false, deepCoinsSource: () => new Set(),
    setIntervalImpl: () => ({ refresh() {} }), clearIntervalImpl() {}, setTimeoutImpl: () => 1, clearTimeoutImpl() {},
    fetchImpl: async (url) => ({ ok: true, json: async () => ({ error: [], result: url.includes('AssetPairs') ? pairs : { AAAUSD: { c: ['10'], v: ['1', '1'], p: ['10', '10'] } } }) }) });
  try {
    await eye._sweepOnce(); now += 60_000; await eye._sweepOnce(); // the second sweep evaluates AAA and (lastPersist 0) persists
    await new Promise((r) => setTimeout(r, 200)); // the async write lands
    assert.ok(existsSync(baselinesFile)); const saved = JSON.parse(readFileSync(baselinesFile, 'utf8'));
    assert.ok(saved.AAA, 'the surveyed coin is kept'); assert.equal(saved.GONE, undefined, 'the coin whose only bucket aged out is dropped'); assert.equal(saved.EMPTY, undefined, 'an empty entry is dropped');
    assert.ok(logs.some((l) => /WIDE EYE baselines: 2 coin\(s\)/.test(l)), logs.join(' | '));
  } finally { eye.stop(); }
});
