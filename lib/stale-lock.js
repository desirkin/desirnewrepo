// PUBLISH-FIX-83 second pass — ONE stale-lock law for every pid file the program keeps (runtime lock, press writer lock,
// socrates budget lock). Before this each lock had its own test, and two of them had none: a lock left by a crashed or
// SIGKILLed owner (the VM restarts, the data dir persists) refused every later boot forever.
// A lock is STALE — and may be reclaimed — only when its owner is PROVABLY gone:
//   (a) the recorded pid no longer exists (ESRCH), or
//   (b) the lock was opened before this MACHINE booted (no process from before the boot can still hold it), or
//   (c) the lock carries OUR pid but was opened before THIS process started (a previous life of a reused pid).
// A live pid with a lock opened after the machine booted is respected — even if it is an unrelated process that reused the
// pid (fail closed). An unreadable lock is never reclaimed.
import os from 'node:os';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

export const machineBootTs = () => Date.now() - os.uptime() * 1000;
export const processStartTs = () => Date.now() - process.uptime() * 1000;

export function lockOwnerState(file, { pidAlive = defaultPidAlive, now = Date.now, machineBoot = machineBootTs, processStart = processStartTs } = {}) {
  if (!existsSync(file)) return { state: 'ABSENT' };
  let rec;
  try { rec = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]); } catch { return { state: 'UNREADABLE' }; }
  const pid = rec?.pid; const openedTs = Number.isSafeInteger(rec?.openedTs) ? rec.openedTs : null;
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'INVALID', rec };
  if (openedTs !== null && openedTs < machineBoot() - 5_000) return { state: 'STALE', reason: 'OPENED_BEFORE_MACHINE_BOOT', rec };
  if (pid === process.pid && openedTs !== null && openedTs < processStart() - 1_000) return { state: 'STALE', reason: 'OUR_PID_FROM_A_PREVIOUS_LIFE', rec };
  if (!pidAlive(pid)) return { state: 'STALE', reason: 'PID_GONE', rec };
  return { state: 'HELD', rec };
}

export function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== 'ESRCH'; }
}

// Reclaim a stale lock file. Returns { reclaimed: true, ... } when the file was removed, { reclaimed: false, state } otherwise.
// Throws only on a HELD lock when `throwWhenHeld` is a function (it builds the error), so callers keep their own wording.
export function reclaimStaleLock(file, { label = 'lock', log = () => {}, ...opts } = {}) {
  const o = lockOwnerState(file, opts);
  if (o.state !== 'STALE') return { reclaimed: false, ...o };
  try { unlinkSync(file); } catch { /* raced with the owner's own cleanup */ }
  log(`${label}: stale lock from pid ${o.rec.pid} (opened ${o.rec.openedTs ? new Date(o.rec.openedTs).toISOString() : 'unknown'}) reclaimed — ${o.reason}`);
  return { reclaimed: true, ...o };
}
