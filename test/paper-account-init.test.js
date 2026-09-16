// PUBLISH-FIX-7 / PUBLISH-FIX-9 (2026-09-16): paper account init at boot under owner intent, and the boot self-check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initPaperAccountAtBoot, PAPER_INIT_ACCOUNT_ENV } from '../lib/paper-account-init.js';
import { bootSelfCheck, databaseHostOf, memoryLine, startMemoryReport, logBootSelfCheck } from '../lib/boot-self-check.js';

const POLICY = { account: { accountId: 'paper-reference-usd500', initialCapital: '500' }, mode: 'PAPER' };
const baseEnv = { JUDGE_MODE: 'PAPER', JUDGE_POLICY: 'config/judge.paper.json', SERPENT_CONTROL_PASSWORD: 'pw-secret-value', [PAPER_INIT_ACCOUNT_ENV]: 'paper-reference-usd500' };

function harness({ initResult = null, initError = null } = {}) {
  const logs = []; const calls = [];
  const loadCommands = async () => ({
    OWNER_PASSWORD_ENV: 'JUDGE_OWNER_PASSWORD',
    createCommands: ({ env }) => ({
      async 'init-paper'(flags) {
        calls.push({ flags, suppliedPassword: env.JUDGE_OWNER_PASSWORD });
        if (initError) throw initError;
        return initResult ?? { ok: true, command: 'init-paper', accountId: 'paper-reference-usd500', revision: 1, initialCapital: '500', mode: 'PAPER' };
      },
    }),
  });
  return { logs, calls, log: (l) => logs.push(l), loadCommands, readPolicy: () => POLICY };
}

test('init at boot: unset account name → SKIPPED, no command constructed', async () => {
  const h = harness();
  const r = await initPaperAccountAtBoot({ env: { JUDGE_MODE: 'PAPER', JUDGE_POLICY: 'p.json', SERPENT_CONTROL_PASSWORD: 'x' }, ...h });
  assert.equal(r.outcome, 'SKIPPED'); assert.equal(h.calls.length, 0); assert.deepEqual(h.logs, []);
});

test('init at boot: not PAPER → SKIPPED', async () => {
  const h = harness();
  const r = await initPaperAccountAtBoot({ env: { ...baseEnv, JUDGE_MODE: 'OBSERVE' }, ...h });
  assert.equal(r.outcome, 'SKIPPED'); assert.equal(h.calls.length, 0);
});

test('init at boot: control password absent → REFUSED, nothing runs', async () => {
  const h = harness();
  const r = await initPaperAccountAtBoot({ env: { ...baseEnv, SERPENT_CONTROL_PASSWORD: '' }, ...h });
  assert.equal(r.outcome, 'REFUSED'); assert.equal(h.calls.length, 0); assert.match(h.logs[0], /SERPENT_CONTROL_PASSWORD absent/);
});

test('init at boot: env names a different account than the policy → REFUSED', async () => {
  const h = harness();
  const r = await initPaperAccountAtBoot({ env: { ...baseEnv, [PAPER_INIT_ACCOUNT_ENV]: 'someone-else' }, ...h });
  assert.equal(r.outcome, 'REFUSED'); assert.equal(h.calls.length, 0); assert.match(h.logs[0], /does not match|names someone-else/);
});

test('init at boot: uninitialized + env → runs the exact init-paper path with the password in the command env only; logs no secret', async () => {
  const h = harness();
  const r = await initPaperAccountAtBoot({ env: baseEnv, ...h });
  assert.equal(r.outcome, 'INITIALIZED'); assert.equal(r.accountId, 'paper-reference-usd500'); assert.equal(r.revision, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].flags.policy, 'config/judge.paper.json'); assert.equal(h.calls[0].suppliedPassword, 'pw-secret-value');
  assert.equal(h.calls[0].flags['owner-stdin'], undefined);
  assert.match(h.logs[0], /PAPER ACCOUNT initialized at boot under owner intent \(env\): paper-reference-usd500 revision 1/);
  assert.ok(h.logs.every((l) => !l.includes('pw-secret-value')));
});

test('init at boot: already initialized → EXISTS, no reset, boot continues', async () => {
  const h = harness({ initError: Object.assign(new Error('ACCOUNT_EXISTS: refusing to reset'), { code: 'ACCOUNT_EXISTS' }) });
  const r = await initPaperAccountAtBoot({ env: baseEnv, ...h });
  assert.equal(r.outcome, 'EXISTS'); assert.match(h.logs[0], /already initialized .* no reset/);
});

test('init at boot: any other failure → FAILED with the code, never throws into the boot', async () => {
  const h = harness({ initError: Object.assign(new Error('boom'), { code: 'OWNER_INTENT_REFUSED' }) });
  const r = await initPaperAccountAtBoot({ env: baseEnv, ...h });
  assert.equal(r.outcome, 'FAILED'); assert.equal(r.reason, 'OWNER_INTENT_REFUSED'); assert.match(h.logs[0], /init at boot failed: OWNER_INTENT_REFUSED/);
});

test('boot self-check: names only — database host without credentials, secret NAMES present/absent, heap ceiling', () => {
  const env = { DATABASE_URL: 'postgres://user:hunter2@db.internal:5432/serpent?sslmode=require', SERPENT_CONTROL_PASSWORD: 'x', COINGLASS_API_KEY: '', SERPENT_DATA_GENERATION: 'gen1', COBRA_PROFILE: 'config/paper-runtime.json', JUDGE_MODE: 'PAPER' };
  const c = bootSelfCheck({ env, memory: { heapUsed: 100 * 1048576, rss: 200 * 1048576, external: 0 }, heapLimitBytes: 1400 * 1048576, nodeVersion: 'v22.0.0', execArgv: ['--max-old-space-size=1400'] });
  assert.equal(c.databaseHost, 'db.internal:5432/serpent');
  assert.equal(c.heapLimitMb, 1400); assert.equal(c.heapFlag, '--max-old-space-size=1400');
  assert.ok(c.secretsPresent.includes('DATABASE_URL') && c.secretsPresent.includes('SERPENT_CONTROL_PASSWORD'));
  assert.ok(c.secretsAbsent.includes('COINGLASS_API_KEY'), 'an empty value counts as absent');
  const text = JSON.stringify(c); assert.ok(!text.includes('hunter2') && !text.includes('user:'), 'never a credential');
  assert.equal(databaseHostOf(''), 'unset'); assert.equal(databaseHostOf('not a url'), 'unparseable');
});

test('boot self-check log: warns below a 1024MB heap ceiling and never prints a value', () => {
  const logs = [];
  const c = logBootSelfCheck({ env: { DATABASE_URL: 'postgres://u:p@h/d', SERPENT_CONTROL_PASSWORD: 'value-that-must-not-appear' }, log: (l) => logs.push(l) });
  assert.ok(c.heapLimitMb > 0);
  assert.ok(logs.every((l) => !l.includes('value-that-must-not-appear') && !l.includes('u:p@')));
  assert.match(logs[0], /BOOT SELF-CHECK: node v\d+/); assert.match(logs[1], /secrets present \[.*SERPENT_CONTROL_PASSWORD/);
});

test('memory report: one bounded line, unref timer, stop clears it', () => {
  assert.match(memoryLine({ memory: { heapUsed: 515 * 1048576, rss: 700 * 1048576, external: 10 * 1048576 }, heapLimitBytes: 528 * 1048576 }), /^MEM heap 515\/528MB \(98%\) rss 700MB external 10MB$/);
  const logs = []; let cleared = null; let fn = null;
  const timers = { setInterval: (f, ms) => { fn = f; assert.equal(ms, 60_000); return { unref() { this.unrefd = true; } }; }, clearInterval: (t) => { cleared = t; } };
  const h = startMemoryReport({ log: (l) => logs.push(l), timers });
  fn(); assert.equal(logs.length, 1); assert.match(logs[0], /^MEM heap \d+\/\d+MB/);
  h.stop(); assert.ok(cleared && cleared.unrefd);
});
