import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'daily-sharded-scale-'));
test.after(() => rmSync(stateRoot, { recursive: true, force: true }));

test('synthetic 612x1440 traversal completes under a bounded heap without retaining a second shard', { timeout: 180_000 }, (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/daily-sharded-study-scale-process.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [
    '--max-old-space-size=128', '--max-semi-space-size=4', fixture, stateRoot,
  ], { encoding: 'utf8', timeout: 170_000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const measured = JSON.parse(child.stdout.trim());
  assert.equal(measured.result.status, 'COMPLETE');
  assert.equal(measured.result.shardCount, 612);
  assert.equal(measured.result.acknowledgedShards, 612);
  assert.equal(measured.result.revision, 612);
  assert.equal(measured.generatedRows, 612 * 1_440);
  assert.equal(measured.releases, 612);
  assert.equal(measured.activeLoads, 0);
  assert.equal(measured.maxActiveLoads, 1);
  assert.ok(measured.eventLoopTicks > 0);
  assert.ok(measured.peakHeapUsed < measured.heapLimit);
  assert.ok(measured.heapLimit < 180 * 1024 * 1024, `unexpected heap limit ${measured.heapLimit}`);
  assert.equal(measured.result.simulationCredit, 0);
  assert.equal(measured.result.learningEligible, false);
  assert.equal(measured.result.durability.scope, 'LOCAL_FILESYSTEM_ONLY');
  assert.equal(measured.result.durability.republishSafe, false);
  assert.ok(statSync(path.join(stateRoot, 'state.json')).size < 8 * 1024 * 1024);
  t.diagnostic(JSON.stringify({
    rows: measured.generatedRows,
    peakHeapUsed: measured.peakHeapUsed,
    peakRss: measured.peakRss,
    heapLimit: measured.heapLimit,
    eventLoopTicks: measured.eventLoopTicks,
  }));
});
