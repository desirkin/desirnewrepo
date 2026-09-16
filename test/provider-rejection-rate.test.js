// B-12 — a provider cannot flood the log with identical "record rejected" lines. The shared client base
// (market-lab/providers/base.js) rate-limits identical rejection LOG lines to at most 5 per rolling minute per message;
// the rest collapse to one bounded summary line when the window rolls. The DURABLE record is untouched: every rejection
// still increments counters.rejectedRecords. Pure: an injected clock + log sink, a transport stub that is never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientBase, REJECT_LOG_MAX_PER_WINDOW } from '../market-lab/providers/base.js';

const T0 = 1_800_000_000_000;
const stubTransport = { request: async () => ({ ok: false, failure: { kind: 'NETWORK', reason: 'unused' } }) };

function base(clockRef) {
  const logs = [];
  const b = createClientBase({ providerId: 'KRAKEN_DERIVATIVES', transport: stubTransport, clock: () => clockRef.t, log: (m) => logs.push(String(m)) });
  return { b, logs };
}

test('B-12. an identical rejection burst yields at most 5 log lines/minute; the durable count keeps every one', () => {
  const clockRef = { t: T0 };
  const { b, logs } = base(clockRef);
  for (let i = 0; i < 20; i += 1) assert.equal(b.tryEmit({}, 'record'), null, 'a malformed body is rejected (emit throws)');
  const rejectionLines = logs.filter((l) => /record rejected/.test(l) && !/suppressed/.test(l));
  assert.ok(rejectionLines.length <= REJECT_LOG_MAX_PER_WINDOW, `at most ${REJECT_LOG_MAX_PER_WINDOW} identical lines reached the log, got ${rejectionLines.length}`);
  assert.equal(rejectionLines.length, 5, 'exactly the five allowed identical lines');
  assert.equal(b.status().counters.rejectedRecords, 20, 'the durable rejected count records all twenty — nothing dropped');
  for (const l of rejectionLines) assert.match(l, /^KRAKEN_DERIVATIVES: record rejected \(/);
});

test('B-12. the suppressed flood collapses to one bounded summary line when the window rolls', () => {
  const clockRef = { t: T0 };
  const { b, logs } = base(clockRef);
  for (let i = 0; i < 20; i += 1) b.tryEmit({}, 'record'); // 5 logged, 15 suppressed in this minute
  clockRef.t += 61_000; // the window rolls
  b.tryEmit({}, 'record'); // the first rejection in the new window flushes the previous window's summary
  const summary = logs.filter((l) => /\+\d+ identical suppressed in the last minute/.test(l));
  assert.equal(summary.length, 1, 'exactly one collapsed summary line for the flood');
  assert.match(summary[0], /\+15 identical suppressed in the last minute/);
  assert.equal(b.status().counters.rejectedRecords, 21, 'the durable count still holds every rejection');
});

test('B-12. distinct rejection messages are bounded independently, not lumped together', () => {
  const clockRef = { t: T0 };
  const { b, logs } = base(clockRef);
  for (let i = 0; i < 8; i += 1) b.tryEmit({}, 'record');   // message A
  for (let i = 0; i < 8; i += 1) b.tryEmit({}, 'candle');   // message B (different `where`)
  const a = logs.filter((l) => /record rejected/.test(l) && !/suppressed/.test(l));
  const bb = logs.filter((l) => /candle rejected/.test(l) && !/suppressed/.test(l));
  assert.equal(a.length, 5, 'message A gets its own five');
  assert.equal(bb.length, 5, 'message B gets its own five, independently');
});
