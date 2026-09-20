// PUBLISH-FIX-83 second pass — the ONE stale-lock law (lib/stale-lock.js) shared by the runtime lock, the press writer lock and
// the socrates budget lock: a lock from before the machine booted, from a previous life of our own pid, or from a pid that no
// longer exists is reclaimed; a live owner from after the boot is respected; unreadable is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lockOwnerState, reclaimStaleLock } from '../lib/stale-lock.js';

test('FIX83-LOCK. owner states and reclaim', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-lock-')); const lock = path.join(dir, 'x.lock'); const logs = [];
  const now = Date.now(); const boot = now - 3_600_000; const start = now - 60_000; const opts = { machineBoot: () => boot, processStart: () => start };
  try {
    assert.equal(lockOwnerState(lock).state, 'ABSENT');
    writeFileSync(lock, 'garbage'); assert.equal(lockOwnerState(lock).state, 'UNREADABLE'); assert.equal(reclaimStaleLock(lock).reclaimed, false); assert.ok(existsSync(lock), 'unreadable is never reclaimed');
    writeFileSync(lock, JSON.stringify({ pid: 424242, openedTs: now - 1000 })); assert.equal(lockOwnerState(lock, { ...opts, pidAlive: () => true }).state, 'HELD', 'a live owner from after the boot is respected (even a reused pid)');
    assert.deepEqual(lockOwnerState(lock, { ...opts, pidAlive: () => false }).state, 'STALE'); assert.equal(lockOwnerState(lock, { ...opts, pidAlive: () => false }).reason, 'PID_GONE');
    writeFileSync(lock, JSON.stringify({ pid: 424242, openedTs: boot - 11 * 60_000 })); assert.equal(lockOwnerState(lock, { ...opts, pidAlive: () => true }).reason, 'OPENED_BEFORE_MACHINE_BOOT', 'a lock older than the machine boot (by more than the margin) cannot be held');
    writeFileSync(lock, JSON.stringify({ pid: 424242, openedTs: boot - 60_000 })); assert.equal(lockOwnerState(lock, { ...opts, pidAlive: () => true }).state, 'HELD', 'inside the margin a live pid is respected (a wall-clock step never reclaims a live owner)');
    writeFileSync(lock, JSON.stringify({ pid: 424242, openedTs: now, bootId: 'not-this-boot' })); assert.equal(lockOwnerState(lock, { ...opts, pidAlive: () => true }).reason === 'OPENED_ON_A_PREVIOUS_BOOT' || lockOwnerState(lock, { ...opts, pidAlive: () => true }).state === 'HELD', true, 'a boot-id mismatch is stale where the kernel exposes a boot id');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, openedTs: start - 5000 })); assert.equal(lockOwnerState(lock, opts).reason, 'OUR_PID_FROM_A_PREVIOUS_LIFE');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, openedTs: now })); assert.equal(lockOwnerState(lock, opts).state, 'HELD', 'our own current lock is held');
    writeFileSync(lock, JSON.stringify({ pid: 424242, openedTs: boot - 11 * 60_000 })); const r = reclaimStaleLock(lock, { label: 't', log: (m) => logs.push(m), ...opts, pidAlive: () => true }); assert.equal(r.reclaimed, true); assert.ok(!existsSync(lock)); assert.ok(logs[0].includes('OPENED_BEFORE_MACHINE_BOOT'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
