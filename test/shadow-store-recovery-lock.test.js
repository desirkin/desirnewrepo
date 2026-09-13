import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createShadowStore } from '../learning/shadow-store.js';

const tdir = () => mkdtempSync(path.join(tmpdir(), 'shadow-recovery-lock-'));

test('writer recovery is serialized by one mutex: missing writer locks, stale expectations, and competing recoverers all fail closed', () => {
  const dir = tdir();
  try {
    const laneDir = path.join(dir, 'learning-shadow');
    const lockFile = path.join(laneDir, 'writer.lock');
    const mutexFile = path.join(laneDir, 'writer-recovery.lock');
    const first = createShadowStore({ dataDir: dir, clock: () => 1_000 });
    const held = JSON.parse(readFileSync(lockFile, 'utf8'));

    // A crashed/in-progress recovery mutex blocks ordinary acquisition even
    // when writer.lock is absent; absence cannot be mistaken for authority.
    writeFileSync(mutexFile, JSON.stringify({ mutexToken: 'other-recoverer', pid: 999, acquiredTs: 900 }), { flag: 'wx' });
    unlinkSync(lockFile);
    const missingLock = createShadowStore({ dataDir: dir, clock: () => 1_100 });
    assert.equal(missingLock.writeAuthority(), false);
    assert.equal(missingLock.appendControl({ control: 'must-not-write' }).refused, 'WRITER_LOCK_HELD');
    assert.equal(JSON.parse(readFileSync(mutexFile, 'utf8')).mutexToken, 'other-recoverer', 'a process never removes another recovery mutex');

    // Restore the exact old identity as an external operator would after
    // resolving the deliberately simulated crash; the store itself never
    // ages out or guesses about either file.
    unlinkSync(mutexFile);
    writeFileSync(lockFile, JSON.stringify(held), { flag: 'wx' });
    const staleExpectation = createShadowStore({ dataDir: dir, clock: () => 1_200, recoverStaleLock: { confirmedBy: 'operator verified old owner dead', expectedToken: 'stale-token' } });
    assert.equal(staleExpectation.writeAuthority(), false);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).writerToken, held.writerToken);

    // The production target is Linux, where the disclosed epoch is fsynced.
    // This Windows-only corrupt-head fixture prevents the unrelated existing
    // directory-fsync limitation from hiding the lock arbitration assertions.
    if (process.platform === 'win32') {
      writeFileSync(path.join(laneDir, 'journal.jsonl'), '');
      writeFileSync(path.join(laneDir, 'head.json'), JSON.stringify({ seq: 1, digest: 'unavailable-on-this-fixture' }));
    }
    const winner = createShadowStore({ dataDir: dir, clock: () => 1_300, recoverStaleLock: { confirmedBy: 'operator verified old owner dead', expectedToken: held.writerToken } });
    assert.equal(winner.writeAuthority(), true);
    const replacement = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.notEqual(replacement.writerToken, held.writerToken);
    if (process.platform !== 'win32') assert.equal(winner.lastControl('WRITER_EPOCH')?.takeover, true);

    // A second recovery holding the same old expectation cannot also win.
    const loser = createShadowStore({ dataDir: dir, clock: () => 1_400, recoverStaleLock: { confirmedBy: 'second operator', expectedToken: held.writerToken } });
    assert.equal(loser.writeAuthority(), false);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).writerToken, replacement.writerToken);
    assert.equal(loser.appendControl({ control: 'loser-must-not-write' }).refused, process.platform === 'win32' ? 'CHAIN_CORRUPT' : 'WRITER_LOCK_HELD');
    assert.equal(first.appendControl({ control: 'displaced-must-not-write' }).refused, 'WRITER_LOCK_LOST');

    missingLock.close(); staleExpectation.close(); loser.close(); first.close(); winner.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
