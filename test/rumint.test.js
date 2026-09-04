// S-2a drills, rebuilt for RUMINT-R1: fixture-driven baseline math over the
// pure truth core, and the dark-mode guarantee. Observed hours (poll
// successes) are what mature history — never mere message existence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-rumint-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
delete process.env.RUMINT_ENABLED;

const { rumintEnabled, fetchSymbolPage, computeSignal, CREDIBILITY } = await import('../rumint/stocktwits.js');
const { emptyBaseline, ingestPage, signalFromBaseline, hypedSnapshot } = await import('../rumint/truth.js');
const { etHour, sessionDate } = await import('../lib/time.js');

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

// Seed a baseline whose watermark is initialized (id 1), so subsequent pages
// count — mirroring a live symbol after its WATERMARK_INITIALIZED first poll.
function seededBaseline(sym, initMs) {
  const init = ingestPage(emptyBaseline(sym, sym.replace(/\.X$/, '')), [{ id: 1, created_at: new Date(initMs).toISOString() }], initMs);
  assert.equal(init.stats.watermarkInitialized, true);
  assert.equal(init.stats.accepted, 0); // the pre-existing page is never fresh chatter
  return init.baseline;
}

// Run an hour-by-hour poll simulation: for each [hourOffset, msgs] the
// provider succeeds at that hour, marking it OBSERVED (even at zero msgs).
function pollHours(baseline, now, entries) {
  let b = baseline;
  for (const [h, msgs] of entries) {
    const at = now.getTime() + h * 3_600_000 + 30 * 60_000; // poll mid-hour
    ({ baseline: b } = ingestPage(b, msgs, at));
  }
  return b;
}

test('rumint is dark by default and env force-disable wins over config', () => {
  assert.equal(rumintEnabled({ rumint: { enabled: false } }), false);
  assert.equal(rumintEnabled({}), false);
  assert.equal(rumintEnabled({ rumint: { enabled: true } }), true);
  process.env.RUMINT_ENABLED = 'false';
  assert.equal(rumintEnabled({ rumint: { enabled: true } }), false);
  delete process.env.RUMINT_ENABLED;
});

test('disabled fetchSymbolPage performs ZERO network calls', async () => {
  let called = 0;
  const fetchImpl = () => {
    called++;
    throw new Error('network touched while dark');
  };
  const out = await fetchSymbolPage('BTC.X', { config: { rumint: { enabled: false } }, fetchImpl });
  assert.equal(out, null);
  assert.equal(called, 0);
});

test('real S-1 fixture ingests into hourly buckets with sentiment tallies and dedupe', () => {
  const nowMs = Date.parse(btcFixture.capturedAt);
  let b = seededBaseline('FIX.BTC', nowMs - 6 * 3_600_000);
  const first = ingestPage(b, btcFixture.messages, nowMs);
  b = first.baseline;
  assert.equal(first.stats.accepted, btcFixture.messages.length);
  const total = Object.values(b.buckets).reduce((s, x) => s + x.count, 0);
  assert.equal(total, btcFixture.messages.length);
  const bulls = btcFixture.messages.filter((m) => m.sentiment === 'Bullish').length;
  const bears = btcFixture.messages.filter((m) => m.sentiment === 'Bearish').length;
  assert.equal(Object.values(b.buckets).reduce((s, x) => s + x.bull, 0), bulls);
  assert.equal(Object.values(b.buckets).reduce((s, x) => s + x.bear, 0), bears);
  // seen-cache dedupe: re-ingesting the same page adds nothing
  const again = ingestPage(b, btcFixture.messages, nowMs);
  assert.equal(again.stats.accepted, 0);
  assert.equal(again.stats.alreadySeen, btcFixture.messages.length);
  assert.equal(Object.values(again.baseline.buckets).reduce((s, x) => s + x.count, 0), total);
});

test('z-score, velocity and acceleration against a controlled observed baseline', () => {
  const now = new Date('2026-09-02T18:30:00Z');
  let id = 2;
  let b = seededBaseline('FIX.Z', now.getTime() - 49 * 3_600_000);
  const entries = [];
  for (let h = 48; h >= 3; h--) {
    entries.push([-h, msgsAt(now, -h, 10, { startId: id })]);
    id += 10;
  }
  entries.push([-2, msgsAt(now, -2, 10, { startId: id })]); id += 10;
  entries.push([-1, msgsAt(now, -1, 20, { startId: id })]); id += 20;
  entries.push([0, msgsAt(now, 0, 40, { startId: id })]);
  b = pollHours(b, now, entries);
  const s = signalFromBaseline(b, now.getTime(), { zThreshold: 3 });
  assert.equal(s.velocity, 40);
  assert.equal(s.acceleration, (40 - 20) - (20 - 10)); // +10
  assert.equal(s.accelerationReason, 'KNOWN');
  assert.ok(s.zVelocity > 3, `expected strong z, got ${s.zVelocity}`); // 40 vs ~10±2
  assert.equal(s.zReason, 'KNOWN');
  assert.equal(s.decision, 'NOMINATED');
});

test('insufficient history yields null z with its stated reason, never a guess', () => {
  const now = new Date('2026-09-02T18:30:00Z');
  let b = seededBaseline('FIX.THIN', now.getTime() - 3_600_000);
  ({ baseline: b } = ingestPage(b, msgsAt(now, 0, 5, { startId: 5 }), now.getTime()));
  const s = signalFromBaseline(b, now.getTime(), { zThreshold: 3 });
  assert.equal(s.zVelocity, null);
  assert.equal(s.zReason, 'INSUFFICIENT_HISTORY');
  assert.equal(s.decision, 'INSUFFICIENT_HISTORY');
});

test('sentiment shift measures recent bull share vs baseline', () => {
  const now = new Date('2026-09-02T18:30:00Z');
  let id = 2;
  let b = seededBaseline('FIX.S', now.getTime() - 31 * 3_600_000);
  const entries = [];
  for (let h = 30; h >= 2; h--) {
    entries.push([-h, msgsAt(now, -h, 10, { bull: 5, bear: 5, startId: id })]);
    id += 10;
  }
  entries.push([-1, msgsAt(now, -1, 10, { bull: 9, bear: 1, startId: id })]); id += 10;
  entries.push([0, msgsAt(now, 0, 10, { bull: 9, bear: 1, startId: id })]);
  b = pollHours(b, now, entries);
  const s = signalFromBaseline(b, now.getTime(), { zThreshold: 3 });
  assert.ok(s.sentimentShift > 0.3 && s.sentimentShift < 0.45, `shift=${s.sentimentShift}`);
});

test('HYPED: top decile of fully-observed overnight ET chatter, canonical snapshot, stricter never looser', () => {
  // Session 2026-09-02 (EDT, UTC-4): overnight ET hours 00-05 are 04-09 UTC.
  const overnightStartUtc = Date.parse('2026-09-02T04:00:00Z');
  const evalAt = Date.parse('2026-09-02T12:00:00Z'); // 08:00 ET — after finalization time
  assert.equal(etHour(new Date(evalAt)), 8);
  const date = sessionDate(new Date(evalAt));
  const baselines = {};
  for (let i = 0; i < 10; i++) {
    const sym = `FIXH${i}.X`;
    let b = seededBaseline(sym, overnightStartUtc - 3_600_000);
    // observe ALL six overnight ET hours (poll success each hour); the
    // screamer coin gets 500 msgs in hour 03 ET, others 5 in hour 03 ET
    let id = 2;
    for (let h = 0; h < 6; h++) {
      const at = overnightStartUtc + h * 3_600_000 + 20 * 60_000;
      const msgs = h === 3 ? msgsAt(new Date(at), 0, i === 7 ? 500 : 5, { startId: id }) : [];
      ({ baseline: b } = ingestPage(b, msgs, at));
      id += 600;
    }
    baselines[sym] = b;
  }
  const snap = hypedSnapshot({ baselines, atMs: evalAt });
  assert.equal(snap.sessionDate, date);
  assert.equal(snap.state, 'READY');
  assert.deepEqual(snap.symbols, ['FIXH7']); // ceil(10/10)=1 -> only the screamer
  assert.equal(snap.coverage.eligibleSymbols, 10);
  assert.ok(/^[0-9a-f]{40}$/.test(snap.identity)); // deterministic session identity
  // BUILDING before 06:00 ET: the incomplete overnight ranking is never promoted
  const building = hypedSnapshot({ baselines, atMs: Date.parse('2026-09-02T08:00:00Z') }); // 04:00 ET
  assert.equal(building.state, 'BUILDING');
  assert.deepEqual(building.symbols, []);
});

test('signal contract keeps nulls with reasons and carries no invented score', () => {
  const sig = computeSignal('FIX.BTC', null, new Date());
  assert.equal(sig.symbol, 'FIX.BTC');
  assert.equal(sig.zVelocity, null);
  assert.equal(sig.zReason, 'INSUFFICIENT_HISTORY');
  assert.equal(sig.acceleration, null);
  assert.equal(sig.sentimentShift, null);
  assert.equal(CREDIBILITY, 'RUMINT');
  assert.ok(!/confidence|score|probability/i.test(JSON.stringify(sig)));
});
