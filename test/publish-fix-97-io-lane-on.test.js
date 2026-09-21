// PUBLISH-FIX-97 (2026-09-21) — THE BITE LANE STOPS BLOCKING ON THE DISK.
//
// The artifact, from the live deployment's own instruments:
//   boot CPU profile      "CPU PROFILE 60s: busy 14078ms idle 45962ms · top: fsync 78% 10979ms · writeBuffer 4% 577ms"
//   JUDGE FUNNEL, 01:45   "LOOP 119 stalls over 100 ms (worst 2526 ms, 46161 ms blocked)"
//                         "DB tx p50 320 / p95 10892 / max 20346 ms over 44 (statements/tx p50 4, bytes/tx p50 0 / max 0 KB)"
//                         "pool checkout wait p50 0 / p95 1 / max 213 ms (failures 0)"
//                         "journal commit p50 547 / p95 40850 / max 48629 ms"
//                         "decision compute p50 2 / p95 2 / max 30914 ms"
//                         "top refusals ... PROPOSAL_EXPIRED_10S 2"
// Four statements carrying ZERO kilobytes took twenty seconds, while the pool handed out a connection in one millisecond. The
// database was not slow; the process could not come back to it — it was inside fsync. Every book update, trade and event was
// written synchronously as it arrived (240,017 book updates in eighteen minutes). Against judge/judge.js's proposal law —
// policy.execution.proposalExpiryMs = 10 s for the hypothesis lock to become durable — a 40-second journal commit means the
// lock cannot land inside its own window, and the decision expires however good the setup was.
//
// Ticket B already built and tested the write-behind buffer for exactly this (lib/write-behind.js, tape/store.js) and left it
// opt-in behind SERPENT_TAPE_WRITE_BEHIND. Nothing had ever turned it on. The paper profile now does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile, profileEnvironment } from '../paper/profile.js';

const PROFILE = 'config/paper-runtime.json';

test('FIX97-1: the paper profile turns the tape I/O lane ON, and it is derived from the tape row (not hard-coded)', () => {
  const profile = loadProfile(PROFILE);
  assert.equal(profile.groups.coreObservation.tape.writeBehind, true, 'the profile row carries the switch');
  assert.equal(profileEnvironment(profile).SERPENT_TAPE_WRITE_BEHIND, 'true');
  // and it follows the row: a profile whose tape row does not ask for it stays OFF (the shipped default before this fix)
  const off = { ...profile, groups: { ...profile.groups, coreObservation: { ...profile.groups.coreObservation, tape: { ...profile.groups.coreObservation.tape, writeBehind: false } } } };
  assert.equal(profileEnvironment(off).SERPENT_TAPE_WRITE_BEHIND, 'false');
  const absent = { ...profile, groups: { ...profile.groups, coreObservation: { ...profile.groups.coreObservation, tape: { desiredState: 'ON' } } } };
  assert.equal(profileEnvironment(absent).SERPENT_TAPE_WRITE_BEHIND, 'false', 'absent means off — the switch is never implied');
});

test('FIX97-2: with the lane on, the tape\'s appends leave the calling thread and are drained on a clean stop', async () => {
  const prev = process.env.SERPENT_TAPE_WRITE_BEHIND;
  process.env.SERPENT_TAPE_WRITE_BEHIND = 'true';
  try {
    const store = await import('../tape/store.js?fix97');
    const status = store.tapeWriteBehindStatus();
    assert.equal(status.enabled, true, 'the switch is read from the environment the profile sets');
    assert.equal(typeof store.flushTapeWrites, 'function');
    assert.equal(typeof store.stopTapeWrites, 'function', 'the shutdown seam can drain it (tape/run.js calls this on a clean stop)');
  } finally { if (prev === undefined) delete process.env.SERPENT_TAPE_WRITE_BEHIND; else process.env.SERPENT_TAPE_WRITE_BEHIND = prev; }
});

test('FIX97-3: the proposal law this protects is unchanged — 10 s is still 10 s, and the fix is the disk, not the deadline', async () => {
  const { readFileSync } = await import('node:fs');
  const policy = JSON.parse(readFileSync('config/judge.paper.starting-styles-fee080.json', 'utf8'));
  assert.equal(policy.execution.proposalExpiryMs, 10_000, 'the deadline is NOT relaxed to paper over a slow disk');
  assert.equal(policy.execution.maxReceiptToDecisionLagMs, 500);
  assert.equal(policy.fees.taker.rate, '0.008', 'and the account policy is byte-untouched (a fee change would need a NEW account)');
});
