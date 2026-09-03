// S-2a drills: fixture-driven baseline math and the dark-mode guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-rumint-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
delete process.env.RUMINT_ENABLED;

const {
  rumintEnabled,
  ingestMessages,
  readBaseline,
  computeSignal,
  overnightChatter,
  computeHypedSet,
  getSignal,
  pollSymbol,
  CREDIBILITY,
} = await import('../rumint/stocktwits.js');
const { etHourKey, sessionDate } = await import('../lib/time.js');

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const btcFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'stocktwits_btc.json'), 'utf8'));

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

// Synthetic hour-stamped messages for controlled math drills.
function msgsAt(baseTime, hourOffset, count, { bull = 0, bear = 0, startId = 1 } = {}) {
  const at = new Date(baseTime.getTime() + hourOffset * 3_600_000 + 60_000);
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    created_at: at.toISOString(),
    sentiment: i < bull ? 'Bullish' : i < bull + bear ? 'Bearish' : null,
  }));
}

test('rumint is dark by default and env force-disable wins over config', () => {
  assert.equal(rumintEnabled({ rumint: { enabled: false } }), false);
  assert.equal(rumintEnabled({}), false);
  assert.equal(rumintEnabled({ rumint: { enabled: true } }), true);
  process.env.RUMINT_ENABLED = 'false';
  assert.equal(rumintEnabled({ rumint: { enabled: true } }), false);
  delete process.env.RUMINT_ENABLED;
});

test('disabled pollSymbol performs ZERO network calls', async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => {
    called++;
    throw new Error('network touched while dark');
  };
  try {
    const out = await pollSymbol('BTC.X', { rumint: { enabled: false } });
    assert.equal(out, null);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('real S-1 fixture ingests into ET hourly buckets with sentiment tallies', () => {
  const base = ingestMessages('FIX.BTC', btcFixture.messages);
  const total = Object.values(base.buckets).reduce((s, b) => s + b.count, 0);
  assert.equal(total, btcFixture.messages.length);
  const bulls = btcFixture.messages.filter((m) => m.sentiment === 'Bullish').length;
  const bears = btcFixture.messages.filter((m) => m.sentiment === 'Bearish').length;
  assert.equal(Object.values(base.buckets).reduce((s, b) => s + b.bull, 0), bulls);
  assert.equal(Object.values(base.buckets).reduce((s, b) => s + b.bear, 0), bears);
  // watermark dedupe: re-ingesting the same page adds nothing
  const again = ingestMessages('FIX.BTC', btcFixture.messages);
  assert.equal(Object.values(again.buckets).reduce((s, b) => s + b.count, 0), total);
  // persisted atomically
  assert.ok(existsSync(path.join(TEST_DATA, 'rumint', 'FIX.BTC.json')));
  assert.ok(!existsSync(path.join(TEST_DATA, 'rumint', 'FIX.BTC.json.tmp')));
});

test('z-score, velocity and acceleration against a controlled baseline', () => {
  const now = new Date('2026-09-02T18:30:00Z');
  // 48 hours of steady chatter: 10 msgs/hour...
  let id = 1;
  for (let h = 48; h >= 3; h--) {
    ingestMessages('FIX.Z', msgsAt(now, -h, 10, { startId: id }), now);
    id += 10;
  }
  // ...then a ramp: 10 -> 20 -> 40 (current hour)
  ingestMessages('FIX.Z', msgsAt(now, -2, 10, { startId: id }), now); id += 10;
  ingestMessages('FIX.Z', msgsAt(now, -1, 20, { startId: id }), now); id += 20;
  ingestMessages('FIX.Z', msgsAt(now, 0, 40, { startId: id }), now);
  const s = computeSignal('FIX.Z', readBaseline('FIX.Z'), now);
  assert.equal(s.velocity, 40);
  assert.equal(s.acceleration, (40 - 20) - (20 - 10)); // +10
  assert.ok(s.zVelocity > 3, `expected strong z, got ${s.zVelocity}`); // 40 vs ~10±2
});

test('insufficient history yields null z, never a guess', () => {
  const now = new Date('2026-09-02T18:30:00Z');
  ingestMessages('FIX.THIN', msgsAt(now, 0, 5), now);
  const s = computeSignal('FIX.THIN', readBaseline('FIX.THIN'), now);
  assert.equal(s.zVelocity, null);
});

test('sentiment shift measures recent bull share vs baseline', () => {
  const now = new Date('2026-09-02T18:30:00Z');
  let id = 1;
  // baseline: 30 hours, 10 labeled/hour, 50% bullish
  for (let h = 30; h >= 2; h--) {
    ingestMessages('FIX.S', msgsAt(now, -h, 10, { bull: 5, bear: 5, startId: id }), now);
    id += 10;
  }
  // recent 2 hours: 90% bullish
  ingestMessages('FIX.S', msgsAt(now, -1, 10, { bull: 9, bear: 1, startId: id }), now); id += 10;
  ingestMessages('FIX.S', msgsAt(now, 0, 10, { bull: 9, bear: 1, startId: id }), now);
  const s = computeSignal('FIX.S', readBaseline('FIX.S'), now);
  assert.ok(s.sentimentShift > 0.3 && s.sentimentShift < 0.45, `shift=${s.sentimentShift}`);
});

test('HYPED: top decile of overnight ET chatter, following-session flag, stricter never looser', () => {
  // 03:00 ET on the session date = 07:00Z (EDT) for 2026-09-02
  const overnightUtc = new Date('2026-09-02T07:00:00Z');
  const date = sessionDate(overnightUtc);
  assert.equal(etHourKey(overnightUtc).slice(11), '03'); // sanity: inside 00-06 ET window
  const baselines = [];
  for (let i = 0; i < 10; i++) {
    const sym = `FIX.H${i}`;
    ingestMessages(sym, msgsAt(overnightUtc, 0, i === 7 ? 500 : 5, { startId: 1 }), overnightUtc);
    baselines.push(readBaseline(sym));
  }
  const hyped = computeHypedSet(baselines, date);
  assert.deepEqual([...hyped], ['FIX.H7']); // ceil(10/10)=1 -> only the screamer
  assert.equal(overnightChatter(readBaseline('FIX.H7'), date), 500);
  const sig = getSignal('FIX.H7', { now: overnightUtc, hypedSet: hyped });
  assert.equal(sig.hyped, true);
  assert.equal(sig.credibility, CREDIBILITY);
  assert.equal(getSignal('FIX.H1', { now: overnightUtc, hypedSet: hyped }).hyped, false);
});

test('signal contract shape is exactly as documented', () => {
  const sig = getSignal('FIX.BTC', {});
  assert.deepEqual(Object.keys(sig).sort(), ['acceleration', 'credibility', 'hyped', 'sentimentShift', 'symbol', 'zVelocity']);
  assert.equal(sig.credibility, 'RUMINT');
});
