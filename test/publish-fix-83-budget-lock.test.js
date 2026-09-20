// PUBLISH-FIX-83 — review finding: a socrates budget lock left by a dead owner (VM restart, kill -9) locked the journal forever.
// Law: a lock whose recorded pid provably no longer runs is reclaimed and logged; a live owner, an unreadable lock, or any
// non-EEXIST error still fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBudgetJournal, staleLockOwner } from '../socrates/budget.js';

test('FIX83-K11. a stale lock (dead pid) is reclaimed; a live owner\'s lock is not; garbage is not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-budget-')); const lock = path.join(dir, 'budget.lock'); const logs = [];
  try {
    writeFileSync(lock, `${JSON.stringify({ pid: 424242, openedTs: Date.now() - 3_600_000, version: 'x' })}\n`);
    assert.throws(() => openBudgetJournal({ dir, pidAlive: () => true }), /locked/, 'the owner is alive (by the injected liveness): fail closed');
    const j = openBudgetJournal({ dir, log: (m) => logs.push(String(m)), pidAlive: () => false });
    assert.ok(logs.some((l) => /stale lock reclaimed/.test(l)), logs.join(' | ')); assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid, 'the lock is ours now');
    assert.throws(() => openBudgetJournal({ dir }), /locked/, 'a second owner in this process: our pid is alive by the real check, fail closed');
    j.close();
    writeFileSync(lock, 'not json\n'); assert.equal(staleLockOwner(lock), null); assert.throws(() => openBudgetJournal({ dir }), /locked/, 'an unreadable lock is never reclaimed');
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, openedTs: Date.now() })}\n`); assert.equal(staleLockOwner(lock), null, 'a live pid (ours) is not stale'); assert.throws(() => openBudgetJournal({ dir }), /locked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
