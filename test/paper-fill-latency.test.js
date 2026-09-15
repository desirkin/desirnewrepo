// PAPER FILL LATENCY (Ticket P — paper realism, 2026-09-15). The pure delay model: the paper fill delay is the
// live-measured Kraken round-trip from the gateway collector, widened when Kraken reports a non-OPEN door, bounded to
// [floorMs, maxMs]. Plus readGatewayLatency: the read-only accessor over the matrix the collector writes. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveFillLatencyMs, PAPER_FILL_LATENCY } from '../lib/paper-fill-latency.js';
import { readGatewayLatency } from '../gateway/collector.js';

test('PFL-1. a live measured round-trip is the base delay when the door is OPEN', () => {
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 400, door: 'OPEN' }), 400);
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 1234, door: 'OPEN' }), 1234);
});

test('PFL-2. no measurement (null / NaN / non-positive) falls back to the conservative reference, never a fabricated fast fill', () => {
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: null, door: 'OPEN' }), PAPER_FILL_LATENCY.referenceMs);
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: NaN, door: 'OPEN' }), PAPER_FILL_LATENCY.referenceMs);
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 0, door: 'OPEN' }), PAPER_FILL_LATENCY.referenceMs);
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: -5, door: 'OPEN' }), PAPER_FILL_LATENCY.referenceMs);
  assert.equal(effectiveFillLatencyMs({}), PAPER_FILL_LATENCY.referenceMs, 'no args at all => reference');
  assert.equal(effectiveFillLatencyMs(), PAPER_FILL_LATENCY.referenceMs, 'undefined input => reference');
});

test('PFL-3. a non-OPEN door widens the base; an unknown door is treated as the worst, never as OPEN', () => {
  // 600ms base, DEGRADED (x2) => 1200; MAINTENANCE (x4) => 2400 (still under the 5s cap)
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 600, door: 'DEGRADED' }), 600 * PAPER_FILL_LATENCY.degradedMs);
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 600, door: 'MAINTENANCE' }), 600 * PAPER_FILL_LATENCY.maintenanceMs);
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 600, door: 'CLOSED' }), 600 * PAPER_FILL_LATENCY.maintenanceMs);
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 600, door: 'WHO_KNOWS' }), 600 * PAPER_FILL_LATENCY.maintenanceMs, 'unknown door widens most');
});

test('PFL-4. the delay is clamped to [floorMs, maxMs] whatever the measurement or widening', () => {
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 10, door: 'OPEN' }), PAPER_FILL_LATENCY.floorMs, 'a sub-floor measurement lifts to the floor');
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 9_000, door: 'OPEN' }), PAPER_FILL_LATENCY.maxMs, 'a huge measurement caps at max');
  assert.equal(effectiveFillLatencyMs({ measuredRttMs: 4_000, door: 'MAINTENANCE' }), PAPER_FILL_LATENCY.maxMs, 'widening never stalls the sim past max');
});

test('PFL-5. readGatewayLatency round-trips the collector matrix; absent / malformed reads as null', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-pfl-'));
  try {
    assert.equal(readGatewayLatency(root), null, 'no matrix file => null');
    const gw = path.join(root, 'gateway');
    mkdirSync(gw, { recursive: true });
    const write = (obj) => writeFileSync(path.join(gw, 'matrix.json'), JSON.stringify(obj));

    write({ ts: 't0', doors: {}, latency: { kraken: { rttMs: 512, door: 'OPEN', observedAt: 't0' } } });
    assert.deepEqual(readGatewayLatency(root), { measuredRttMs: 512, door: 'OPEN', observedAt: 't0' });

    // a failed fetch cycle writes rttMs null + DEGRADED — a legitimate "no measurement, widen" signal
    write({ ts: 't1', doors: {}, latency: { kraken: { rttMs: null, door: 'DEGRADED', observedAt: 't1' } } });
    assert.deepEqual(readGatewayLatency(root), { measuredRttMs: null, door: 'DEGRADED', observedAt: 't1' });

    write({ ts: 't2', doors: {} }); // a pre-Ticket-P matrix with no latency block
    assert.equal(readGatewayLatency(root), null, 'absent latency block => null');
    write({ ts: 't3', doors: {}, latency: { kraken: { rttMs: -1, door: 'OPEN' } } });
    assert.equal(readGatewayLatency(root), null, 'a negative round-trip is malformed => null');
    write({ ts: 't4', doors: {}, latency: { kraken: { rttMs: 100 } } });
    assert.equal(readGatewayLatency(root), null, 'a missing door is malformed => null');
    writeFileSync(path.join(gw, 'matrix.json'), '{ not json');
    assert.equal(readGatewayLatency(root), null, 'torn json => null, never a throw');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The paper adapter reads readGatewayLatency and feeds it to effectiveFillLatencyMs — this is that composition end-to-end.
test('PFL-6. the accessor and the model compose: a matrix DEGRADED signal produces a widened bounded delay', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-pfl-'));
  try {
    const gw = path.join(root, 'gateway');
    mkdirSync(gw, { recursive: true });
    writeFileSync(path.join(gw, 'matrix.json'), JSON.stringify({ ts: 't', doors: {}, latency: { kraken: { rttMs: 300, door: 'DEGRADED', observedAt: 't' } } }));
    const sig = readGatewayLatency(root);
    assert.equal(effectiveFillLatencyMs(sig), Math.min(PAPER_FILL_LATENCY.maxMs, 300 * PAPER_FILL_LATENCY.degradedMs));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
