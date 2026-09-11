// Required storage facts must be proven before a PAPER readiness verdict.
// Fault injection uses production runPreflight, never a copied verdict function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPreflight, renderPreflight } from '../paper/preflight.js';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import { resetConfigCache } from '../lib/config.js';

const fault = (code) => Object.assign(new Error('private database diagnostic MUST_NOT_LEAK'), { code });
const cases = [
  { name: 'healthy', ready: true },
  { name: 'account permission error', account: fault('42501'), ids: ['JUDGE_ACCOUNT_CHECK'], accountState: null, lockState: false },
  { name: 'account timeout', account: fault('57014'), ids: ['JUDGE_ACCOUNT_CHECK'], accountState: null, lockState: false },
  { name: 'lock timeout', lock: fault('57014'), ids: ['WRITER_LOCK_CHECK'], accountState: true, lockState: null },
  { name: 'lock generic failure', lock: fault('arbitrary diagnostic MUST_NOT_LEAK'), ids: ['WRITER_LOCK_CHECK'], accountState: true, lockState: null },
  { name: 'both checks fail', account: fault('42501'), lock: fault('57014'), ids: ['JUDGE_ACCOUNT_CHECK', 'WRITER_LOCK_CHECK'], accountState: null, lockState: null },
  { name: 'missing lock row', lock: { rows: [] }, ids: ['WRITER_LOCK_CHECK'], accountState: true, lockState: null },
  { name: 'nonboolean lock field', lock: { rows: [{ held: 'false' }] }, ids: ['WRITER_LOCK_CHECK'], accountState: true, lockState: null },
  { name: 'missing lock field', lock: { rows: [{}] }, ids: ['WRITER_LOCK_CHECK'], accountState: true, lockState: null },
  { name: 'malformed account rows', account: { rows: 'present' }, ids: ['JUDGE_ACCOUNT_CHECK'], accountState: null, lockState: false },
  { name: 'null account row', account: { rows: [null] }, ids: ['JUDGE_ACCOUNT_CHECK'], accountState: null, lockState: false },
  { name: 'account absent', account: { rows: [] }, ids: ['JUDGE_ACCOUNT'], accountState: false, lockState: false },
  { name: 'account table absent', account: fault('42P01'), ids: ['JUDGE_ACCOUNT'], accountState: false, lockState: false },
  { name: 'writer held', lock: { rows: [{ held: true }] }, ids: ['WRITER_HELD'], accountState: true, lockState: true },
];

test('required account and writer-lock checks never turn unknown into ready', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paper-storage-'));
  const saved = { COBRA_DATA_DIR: process.env.COBRA_DATA_DIR, COBRA_PROFILE: process.env.COBRA_PROFILE };
  process.env.COBRA_DATA_DIR = dir;
  process.env.COBRA_PROFILE = 'config/paper-runtime.json';
  resetConfigCache();
  const env = { DATABASE_URL: 'postgresql://127.0.0.1:1/synthetic', SERPENT_CONTROL_PASSWORD: 'synthetic-test-password', SERPENT_HTTP_CONTACT: 'test@example.invalid' };
  try {
    for (const c of cases) await t.test(c.name, async () => {
      let ended = 0;
      const queries = [];
      const db = {
        schema: null,
        async connect() { return true; },
        async end() { ended += 1; },
        async query(sql) {
          queries.push(sql);
          let result;
          if (sql.includes('serpent_schema_migrations')) result = { rows: [{ v: SCHEMA_VERSION }] };
          else if (sql.includes('serpent_execution_accounts')) result = c.account ?? { rows: [{ '?column?': 1 }] };
          else if (sql.includes('pg_locks')) result = c.lock ?? { rows: [{ held: false }] };
          else throw new Error('unexpected query');
          if (result instanceof Error) throw result;
          return result;
        },
      };
      const report = await runPreflight({ env, dbFactory: () => db });
      assert.equal(ended, 1, 'connection always released');
      assert.equal(queries.length, 3, 'all independent checks are attempted');
      assert.ok(queries.every((q) => /^SELECT\b/.test(q)), 'read-only DB access');
      const storage = report.sections.B_STORAGE.database;
      assert.equal(report.ready, c.ready === true);
      assert.equal(report.verdict, c.ready ? 'READY_FOR_PAPER' : 'NOT_READY_FOR_PAPER');
      assert.equal(report.sections.L_FINAL.READY_FOR_PAPER, c.ready === true);
      assert.equal(storage.accountInitialized, c.ready ? true : c.accountState);
      assert.equal(storage.writerLockHeld, c.ready ? false : c.lockState);
      assert.deepEqual(report.blockers.CORE_RUNTIME_BLOCKER.map((b) => b.id), c.ids ?? []);
      const rendered = renderPreflight(report);
      assert.ok(rendered.includes(`PAPER MODE: ${report.verdict}`));
      assert.equal(JSON.parse(JSON.stringify(report)).ready, c.ready === true);
      assert.ok(!JSON.stringify(report).includes('MUST_NOT_LEAK'));
      assert.ok(!rendered.includes('MUST_NOT_LEAK'));
      if (c.ids?.includes('JUDGE_ACCOUNT_CHECK') && c.account?.code === '42501') {
        assert.ok(report.blockers.CORE_RUNTIME_BLOCKER.some((b) => b.reason.includes('42501')));
      }
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
