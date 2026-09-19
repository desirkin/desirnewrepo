// PUBLISH-FIX-75: the KILL / CAGE latches cleared at boot under owner intent (env name + the control password), through the
// exact cockpit CLEAR path; unset -> no-op; no password -> refused; nothing latched -> says so; a booting persistence is waited out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearLatchesAtBoot, CLEAR_LATCHES_ENV } from '../lib/latch-clear-at-boot.js';

const caged = () => ({ kill: null, cage: { active: true, ts: '2026-09-11T23:43:23.286Z' }, vetoes: [] });
const clean = () => ({ kill: null, cage: null, vetoes: [] });
const base = { JUDGE_MODE: 'PAPER', SERPENT_CONTROL_PASSWORD: 'x' };

test('LC-01. unset -> SKIPPED without touching anything; a value other than true is ignored; not PAPER or no control password -> REFUSED, and the latch stands', async () => {
  let calls = 0; const requestClear = async () => { calls += 1; return { ok: true }; }; const logs = [];
  assert.equal((await clearLatchesAtBoot({ env: {}, readControls: caged, requestClear })).outcome, 'SKIPPED');
  assert.equal((await clearLatchesAtBoot({ env: { ...base, [CLEAR_LATCHES_ENV]: 'yes' }, readControls: caged, requestClear, log: (l) => logs.push(l) })).outcome, 'SKIPPED'); assert.match(logs.at(-1), /must be exactly true/);
  assert.equal((await clearLatchesAtBoot({ env: { ...base, JUDGE_MODE: 'LIVE_ARMED', [CLEAR_LATCHES_ENV]: 'true' }, readControls: caged, requestClear, log: (l) => logs.push(l) })).outcome, 'REFUSED'); assert.match(logs.at(-1), /is not PAPER/);
  assert.equal((await clearLatchesAtBoot({ env: { JUDGE_MODE: 'PAPER', [CLEAR_LATCHES_ENV]: 'true' }, readControls: caged, requestClear, log: (l) => logs.push(l) })).outcome, 'REFUSED'); assert.match(logs.at(-1), /SERPENT_CONTROL_PASSWORD absent/);
  assert.equal(calls, 0, 'requestClear is never reached without owner intent');
  assert.ok(!logs.some((l) => /\bx\b/.test(l)), 'the password never appears in a log line');
});

test('LC-02. with intent and a CAGE latched, the cockpit CLEAR path runs once with source boot-owner-intent; the log names the latch, since when, and tells the owner to remove the variable', async () => {
  const seen = []; const requestClear = async (o) => { seen.push(o); return { ok: true, mode: 'DURABLE_FIRST', revision: 7 }; }; const logs = [];
  const r = await clearLatchesAtBoot({ env: { ...base, [CLEAR_LATCHES_ENV]: 'TRUE ' }, readControls: caged, requestClear, log: (l) => logs.push(l) });
  assert.equal(r.outcome, 'CLEARED'); assert.deepEqual(r.latched, ['CAGE']); assert.equal(r.attempts, 1); assert.deepEqual(seen, [{ source: 'boot-owner-intent' }]);
  assert.match(logs.at(-1), /CAGE cleared at boot under owner intent .*the latch had stood since 2026-09-11T23:43:23.286Z; mode DURABLE_FIRST — remove SERPENT_CLEAR_LATCHES_AT_BOOT once it has done its job/);
});

test('LC-03. nothing latched -> NOTHING_TO_CLEAR and no CLEAR call; PERSISTENCE_BOOTING is waited out (bounded) and then cleared; a real refusal (a restriction raced in, integrity lock) stands and is reported', async () => {
  let calls = 0; const logs = [];
  assert.equal((await clearLatchesAtBoot({ env: { ...base, [CLEAR_LATCHES_ENV]: 'true' }, readControls: clean, requestClear: async () => { calls += 1; return { ok: true }; }, log: (l) => logs.push(l) })).outcome, 'NOTHING_TO_CLEAR'); assert.equal(calls, 0); assert.match(logs.at(-1), /no latch to clear at boot/);
  let n = 0; const slept = []; const late = async () => { n += 1; return n < 3 ? { ok: false, reason: 'PERSISTENCE_BOOTING' } : { ok: true, mode: 'DURABLE_FIRST' }; };
  const r = await clearLatchesAtBoot({ env: { ...base, [CLEAR_LATCHES_ENV]: 'true' }, readControls: () => ({ kill: { active: true, ts: 't' }, cage: { active: true, ts: 'c' } }), requestClear: late, retries: 5, retryMs: 1, sleep: async (ms) => { slept.push(ms); }, log: (l) => logs.push(l) });
  assert.equal(r.outcome, 'CLEARED'); assert.equal(r.attempts, 3); assert.deepEqual(r.latched, ['KILL', 'CAGE']); assert.deepEqual(slept, [1, 1]);
  const refused = await clearLatchesAtBoot({ env: { ...base, [CLEAR_LATCHES_ENV]: 'true' }, readControls: caged, requestClear: async () => ({ ok: false, reason: 'CLEAR_RACED_WITH_RESTRICTION' }), log: (l) => logs.push(l) });
  assert.equal(refused.outcome, 'FAILED'); assert.equal(refused.reason, 'CLEAR_RACED_WITH_RESTRICTION'); assert.match(logs.at(-1), /FAILED: CLEAR_RACED_WITH_RESTRICTION — the CAGE latch stands/);
  const exhausted = await clearLatchesAtBoot({ env: { ...base, [CLEAR_LATCHES_ENV]: 'true' }, readControls: caged, requestClear: async () => ({ ok: false, reason: 'PERSISTENCE_PERMISSION_LOCK' }), retries: 2, retryMs: 1, sleep: async () => {}, log: (l) => logs.push(l) });
  assert.equal(exhausted.outcome, 'FAILED'); assert.equal(exhausted.attempts, 2);
  const threw = await clearLatchesAtBoot({ env: { ...base, [CLEAR_LATCHES_ENV]: 'true' }, readControls: caged, requestClear: async () => { throw new Error('db down'); }, log: (l) => logs.push(l) });
  assert.equal(threw.outcome, 'FAILED'); assert.match(threw.reason, /THREW:db down/);
});
