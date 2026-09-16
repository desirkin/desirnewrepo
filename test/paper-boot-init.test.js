// PUBLISH-FIX-7 — the PAPER boot initializes its own account under owner intent (env) ONLY when it is uninitialized and
// the owner asked through the environment. Pure: compose / initPaper / log are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { composePaperJudgeWithBootInit, paperBootInitWanted, PAPER_BOOT_INIT_LOG } from '../lib/paper-boot-init.js';

const uninit = () => Object.assign(new Error('ACCOUNT_UNINITIALIZED: account paper-reference-usd500 is not initialized'), { code: 'ACCOUNT_UNINITIALIZED' });
const ENV_ON = { JUDGE_MODE: 'PAPER', SERPENT_PAPER_INIT_ACCOUNT: 'paper-reference-usd500', SERPENT_CONTROL_PASSWORD: 'owner-pw' };

test('PF7-1. uninitialized + env: the boot runs init-paper once under owner intent, logs, and the Judge composes', async () => {
  let composeCalls = 0; let initCalls = 0; const logs = [];
  const RUN = { kind: 'PAPER', accountId: 'paper-reference-usd500' };
  const run = await composePaperJudgeWithBootInit({
    env: ENV_ON,
    compose: async () => { composeCalls += 1; if (composeCalls === 1) throw uninit(); return RUN; },
    initPaper: async () => { initCalls += 1; },
    log: (m) => logs.push(m),
  });
  assert.equal(run, RUN, 'the Judge composes after the account is initialized');
  assert.equal(initCalls, 1, 'init-paper ran exactly once');
  assert.equal(composeCalls, 2, 'composed, hit ACCOUNT_UNINITIALIZED, initialized, re-composed');
  assert.deepEqual(logs, [PAPER_BOOT_INIT_LOG]);
  assert.equal(logs.some((l) => l.includes('owner-pw')), false, 'the password never reaches the log');
});

test('PF7-2. initialized + env: the account already exists, so nothing is initialized and the Judge composes (no reset)', async () => {
  let composeCalls = 0; let initCalls = 0; const logs = [];
  const RUN = { kind: 'PAPER' };
  const run = await composePaperJudgeWithBootInit({
    env: ENV_ON,
    compose: async () => { composeCalls += 1; return RUN; }, // never throws: the account is already initialized
    initPaper: async () => { initCalls += 1; },
    log: (m) => logs.push(m),
  });
  assert.equal(run, RUN);
  assert.equal(initCalls, 0, 'no init: an initialized account is never reset');
  assert.equal(composeCalls, 1);
  assert.deepEqual(logs, [], 'no boot-init line when nothing was initialized');
});

test('PF7-3. uninitialized WITHOUT the env name: today\'s dark refusal — the error propagates, nothing is initialized', async () => {
  let initCalls = 0;
  const env = { JUDGE_MODE: 'PAPER', SERPENT_CONTROL_PASSWORD: 'owner-pw' }; // no SERPENT_PAPER_INIT_ACCOUNT
  await assert.rejects(
    composePaperJudgeWithBootInit({ env, compose: async () => { throw uninit(); }, initPaper: async () => { initCalls += 1; } }),
    /ACCOUNT_UNINITIALIZED/,
  );
  assert.equal(initCalls, 0, 'without the env name, the boot never initializes — dark refusal is unchanged');
});

test('PF7-4. the env name set but no password: owner intent is absent, so no init — the error propagates', async () => {
  let initCalls = 0;
  const env = { JUDGE_MODE: 'PAPER', SERPENT_PAPER_INIT_ACCOUNT: 'paper-reference-usd500' }; // no password
  await assert.rejects(
    composePaperJudgeWithBootInit({ env, compose: async () => { throw uninit(); }, initPaper: async () => { initCalls += 1; } }),
    /ACCOUNT_UNINITIALIZED/,
  );
  assert.equal(initCalls, 0);
});

test('PF7-5. a non-ACCOUNT_UNINITIALIZED failure is never treated as an init trigger, even with the env set', async () => {
  let initCalls = 0;
  await assert.rejects(
    composePaperJudgeWithBootInit({ env: ENV_ON, compose: async () => { throw Object.assign(new Error('DB_UNAVAILABLE: database unreachable'), { code: 'DB_UNAVAILABLE' }); }, initPaper: async () => { initCalls += 1; } }),
    /DB_UNAVAILABLE/,
  );
  assert.equal(initCalls, 0, 'only ACCOUNT_UNINITIALIZED gates the boot init; other failures fail closed');
});

test('PF7-6. paperBootInitWanted requires PAPER mode + the account name + the control password, all present', () => {
  assert.equal(paperBootInitWanted(ENV_ON), true);
  assert.equal(paperBootInitWanted({ ...ENV_ON, JUDGE_MODE: 'OBSERVE' }), false, 'only PAPER');
  assert.equal(paperBootInitWanted({ ...ENV_ON, SERPENT_PAPER_INIT_ACCOUNT: '' }), false, 'the account name is required');
  assert.equal(paperBootInitWanted({ ...ENV_ON, SERPENT_CONTROL_PASSWORD: undefined }), false, 'the control password is required');
});
