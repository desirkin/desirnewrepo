// PUBLISH-FIX-13 (2026-09-17): the provider quota journal lock follows the dead-owner law (boot id first, then pid liveness,
// never age) so a crash or a republish never leaves market research dark for good.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openQuotaJournal, recoverStaleQuotaLock, currentBootId } from '../market-lab/quota.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'quota-lock-'));
const dead = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
const alive = () => true;

test('a lock from a previous boot is recovered and logged even when its pid is alive now', () => {
  const d = dir(); const lock = path.join(d, 'quota.lock'); const logs = [];
  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, bootId: 'some-other-boot', openedTs: 1, version: 1 })}\n`);
  const r = recoverStaleQuotaLock(lock, { log: (l) => logs.push(l), bootId: 'this-boot', isAlive: alive });
  assert.equal(r.recovered, true); assert.equal(r.reason, 'PREVIOUS_BOOT'); assert.equal(existsSync(lock), false); assert.match(logs[0], /previous boot/);
});

test('a lock from THIS boot: a dead pid is recovered, a live pid refuses, an unverifiable pid refuses', () => {
  const d = dir(); const lock = path.join(d, 'quota.lock');
  writeFileSync(lock, `${JSON.stringify({ pid: 4242, bootId: 'this-boot', openedTs: 1, version: 1 })}\n`);
  assert.equal(recoverStaleQuotaLock(lock, { bootId: 'this-boot', isAlive: alive }).reason, 'LIVE_OWNER'); assert.equal(existsSync(lock), true);
  assert.equal(recoverStaleQuotaLock(lock, { bootId: 'this-boot', isAlive: () => { const e = new Error('eperm'); e.code = 'EPERM'; throw e; } }).reason, 'UNVERIFIABLE'); assert.equal(existsSync(lock), true);
  assert.equal(recoverStaleQuotaLock(lock, { bootId: 'this-boot', isAlive: dead }).reason, 'DEAD_PID'); assert.equal(existsSync(lock), false);
});

test('an unreadable or invalid lock is never deleted; a legacy lock without a boot id is recovered', () => {
  const d = dir(); const lock = path.join(d, 'quota.lock');
  writeFileSync(lock, 'not json'); assert.equal(recoverStaleQuotaLock(lock, { bootId: 'b' }).reason, 'UNREADABLE'); assert.equal(existsSync(lock), true);
  writeFileSync(lock, `${JSON.stringify({ pid: -1 })}\n`); assert.equal(recoverStaleQuotaLock(lock, { bootId: 'b' }).reason, 'INVALID_PID'); assert.equal(existsSync(lock), true);
  // a legacy lock without a boot id: a live pid that started AFTER the lock was written is a reused pid (recovered); one
  // that started before stays (a live owner); no start time readable stays
  writeFileSync(lock, `${JSON.stringify({ pid: 99999, openedTs: 1_000_000, version: 1 })}\n`);
  assert.equal(recoverStaleQuotaLock(lock, { bootId: 'b', isAlive: alive, startedAtMs: () => 900_000 }).reason, 'LIVE_OWNER'); assert.equal(existsSync(lock), true);
  assert.equal(recoverStaleQuotaLock(lock, { bootId: 'b', isAlive: alive, startedAtMs: () => null }).reason, 'LIVE_OWNER'); assert.equal(existsSync(lock), true);
  assert.equal(recoverStaleQuotaLock(lock, { bootId: 'b', isAlive: alive, startedAtMs: () => 5_000_000 }).reason, 'REUSED_PID'); assert.equal(existsSync(lock), false);
  writeFileSync(lock, '{"pid":1}\n'); assert.equal(recoverStaleQuotaLock(lock, { bootId: 'b', isAlive: alive }).reason, 'LIVE_OWNER', 'a lock naming a live pid with no clock evidence is never deleted'); assert.equal(existsSync(lock), true);
});

test('openQuotaJournal records the boot id, recovers a previous boot\'s lock on open, and still refuses a live owner of this boot', () => {
  const d = dir(); const lock = path.join(d, 'quota.lock'); const logs = [];
  writeFileSync(lock, `${JSON.stringify({ pid: 1, bootId: 'previous-boot', openedTs: 1, version: 1 })}\n`);
  const j = openQuotaJournal({ dir: d, log: (l) => logs.push(l) });
  try {
    assert.match(logs[0], /recovered stale provider quota journal lock from a previous boot/);
    const written = JSON.parse(readFileSync(lock, 'utf8')); assert.equal(written.pid, process.pid); assert.equal(written.bootId, currentBootId());
    assert.throws(() => openQuotaJournal({ dir: d, log: () => {} }), /locked by another owner/);
  } finally { j.close(); }
  assert.equal(existsSync(lock), false);
});
