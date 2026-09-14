import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../bin/judge.js';
import { composeJudge, initAccount } from '../judge/composition.js';
import { createMemoryJournal } from '../execution/journal.js';
import { keyFingerprint } from '../execution/contract.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { startPersistence } from '../persistence/runtime.js';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import { eventsFor, fakeClock } from './helpers/judge.js';

const POLICY_FILE = path.resolve('judge/samples/policy.paper-reference.json');
const POLICY = loadJudgePolicy(POLICY_FILE);
const PW = 'persist-cli-lifecycle-test-password';
const T0 = Date.parse('2026-09-13T12:00:00Z');

function fakeExecutionDb() {
  const account = { row: null, events: [], epoch: 0 };
  let queries = 0;
  const response = async (sql, params = []) => {
    queries += 1; const text = String(sql);
    if (text.startsWith('SELECT 1 FROM serpent_execution_accounts')) return { rows: account.row && account.row.account_id === params[0] ? [{ '?column?': 1 }] : [], rowCount: account.row ? 1 : 0 };
    if (text.startsWith('SELECT account_id, revision, writer_epoch')) return { rows: account.row && account.row.account_id === params[0] ? [structuredClone(account.row)] : [], rowCount: account.row ? 1 : 0 };
    if (text.startsWith('SELECT seq, writer_epoch, event FROM serpent_execution_events')) { const rows = account.events.filter((row) => row.seq > Number(params[1])).map((row) => structuredClone(row)); return { rows, rowCount: rows.length }; }
    if (text.startsWith('SELECT account_id FROM serpent_execution_accounts')) return { rows: account.row ? [{ account_id: account.row.account_id }] : [], rowCount: account.row ? 1 : 0 };
    if (text.startsWith('INSERT INTO serpent_execution_accounts')) { account.row = { account_id: params[0], revision: 0, writer_epoch: 0, head_seq: 0, head_digest: null, state: JSON.parse(params[3]) }; return { rows: [], rowCount: 1 }; }
    if (text.startsWith('INSERT INTO serpent_execution_writer_epoch')) return { rows: [], rowCount: 1 };
    if (text.startsWith('UPDATE serpent_execution_accounts SET writer_epoch')) { account.row.writer_epoch = params[1]; return { rows: [], rowCount: 1 }; }
    if (text.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM serpent_execution_accounts') && text.endsWith('FOR UPDATE')) return { rows: account.row ? [structuredClone(account.row)] : [], rowCount: account.row ? 1 : 0 };
    if (text.startsWith('INSERT INTO serpent_execution_events')) { account.events.push({ seq: params[1], writer_epoch: params[6], event: JSON.parse(params[7]) }); return { rows: [], rowCount: 1 }; }
    if (text.startsWith('UPDATE serpent_execution_accounts SET revision')) { account.row.revision += 1; account.row.head_seq = params[1]; account.row.head_digest = params[2]; account.row.state = JSON.parse(params[3]); return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected fake DB SQL: ${text.slice(0, 100)}`);
  };
  return {
    configured: () => true, query: response, tx: async (fn) => fn(response),
    acquireSessionLock: async () => {
      let held = true;
      return { held: () => held, query: async (sql, params = []) => { queries += 1; const text = String(sql); if (text.startsWith('INSERT INTO serpent_execution_writer_epoch')) { account.epoch += 1; return { rows: [{ epoch: account.epoch }], rowCount: 1 }; } if (text.startsWith('UPDATE serpent_execution_accounts SET writer_epoch')) { account.row.writer_epoch = params[1]; return { rows: [], rowCount: 1 }; } throw new Error(`unexpected lock SQL: ${text.slice(0, 100)}`); }, release: async () => { held = false; } };
    },
    stats: () => ({ queries }), account,
  };
}

function executionPool() {
  const execution = fakeExecutionDb();
  const query = async (sql, params = []) => {
    const text = String(sql);
    if (text === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (text.includes('SELECT version FROM serpent_schema_migrations')) return { rows: Array.from({ length: SCHEMA_VERSION }, (_, i) => ({ version: i + 1 })), rowCount: SCHEMA_VERSION };
    if (text.includes('FROM serpent_store_anchors')) return { rows: [], rowCount: 0 };
    if (text.includes('serpent_execution_')) return execution.query(text, params);
    return { rows: [], rowCount: 0 };
  };
  const client = () => {
    let released = false;
    return {
      query: async (sql, params = []) => {
        const text = String(sql);
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [], rowCount: 0 };
        if (text.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ ok: true }], rowCount: 1 };
        if (text.startsWith('SELECT pg_advisory_unlock')) return { rows: [{ ok: true }], rowCount: 1 };
        if (text.startsWith('INSERT INTO serpent_execution_writer_epoch') && text.includes('RETURNING epoch')) { execution.account.epoch += 1; return { rows: [{ epoch: execution.account.epoch }], rowCount: 1 }; }
        return query(text, params);
      },
      on() {}, once() {}, removeListener() {}, release() { released = true; }, get released() { return released; },
    };
  };
  return { pool: { query, connect: async () => client(), on() {}, end: async () => {} }, execution };
}

function persistenceFixture(permissionLock) {
  const db = fakeExecutionDb(); let stops = 0; let locked = permissionLock;
  return { db, health: () => ({ permissionLock: locked }), setPermissionLock: (value) => { locked = value; }, stop: async () => { stops += 1; }, stops: () => stops };
}

async function cli(args, persistenceFactory) {
  let out = ''; let err = '';
  const code = await runCli(args, {
    env: { SERPENT_CONTROL_PASSWORD: PW }, stdin: Readable.from([`${PW}\n`]),
    stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, clock: () => T0,
    persistenceFactory, cwd: process.cwd(),
  });
  return { code, out, err, json: () => JSON.parse(out) };
}

for (const state of ['WIPED', 'BOOTING']) test(`runCli init-paper refuses ${state} before account storage and stops its owned lifecycle once`, { concurrency: false }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-cli-lifecycle-')); const before = process.env.COBRA_DATA_DIR; process.env.COBRA_DATA_DIR = dir;
  t.after(() => { if (before === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = before; rmSync(dir, { recursive: true, force: true }); });
  const p = persistenceFixture(true); let creates = 0;
  if (state === 'BOOTING') p.health = () => Promise.reject(new Error('synthetic async health is invalid'));
  const result = await cli(['init-paper', '--policy', POLICY_FILE, '--owner-stdin', 'true'], async () => { creates += 1; return p; });
  assert.equal(result.code, 6, result.err); assert.match(result.err, /PERSISTENCE_PERMISSION_LOCK/);
  assert.equal(creates, 1); assert.equal(p.stops(), 1); assert.equal(p.db.stats().queries, 0, 'locked init never touches account rows');
});

test('runCli init-paper uses one healthy persistence DB and stops command-owned lifecycle once; caller-owned lifecycle is not stopped', { concurrency: false }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-cli-lifecycle-')); const before = process.env.COBRA_DATA_DIR; process.env.COBRA_DATA_DIR = dir;
  t.after(() => { if (before === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = before; rmSync(dir, { recursive: true, force: true }); });
  const owned = persistenceFixture(false); const first = await cli(['init-paper', '--policy', POLICY_FILE, '--account', 'cli-owned', '--owner-stdin', 'true'], async () => owned);
  assert.equal(first.code, 0, first.err); assert.equal(first.json().revision, 1); assert.equal(owned.db.account.row.account_id, 'cli-owned'); assert.equal(owned.stops(), 1);
  const caller = persistenceFixture(false); let out = ''; let err = '';
  const code = await runCli(['init-paper', '--policy', POLICY_FILE, '--account', 'cli-caller', '--owner-stdin', 'true'], { env: { SERPENT_CONTROL_PASSWORD: PW }, stdin: Readable.from([`${PW}\n`]), stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, clock: () => T0, persistence: caller, cwd: process.cwd() });
  assert.equal(code, 0, err); assert.equal(caller.db.account.row.account_id, 'cli-caller'); assert.equal(caller.stops(), 0, 'the caller owns shutdown');
  caller.setPermissionLock(true);
  for (const args of [
    ['run-paper', '--policy', POLICY_FILE, '--account', 'cli-caller', '--owner-stdin', 'true'],
    ['reconcile', '--policy', POLICY_FILE, '--account', 'cli-caller', '--owner-stdin', 'true'],
  ]) {
    out = ''; err = '';
    const protective = await runCli(args, { env: { SERPENT_CONTROL_PASSWORD: PW }, stdin: Readable.from([`${PW}\n`]), stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, clock: () => T0, persistence: caller, tapeRunner: async () => {}, cwd: process.cwd() });
    assert.equal(protective, 0, `${args[0]} remains available under the entry lock: ${err}`);
  }
  assert.equal(caller.stops(), 0, 'protective/reconcile reuse does not stop caller-owned persistence');
});

test('help, invalid input and OBSERVE do not start the economic persistence lifecycle', { concurrency: false }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-cli-observe-')); const before = process.env.COBRA_DATA_DIR; process.env.COBRA_DATA_DIR = dir;
  t.after(() => { if (before === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = before; rmSync(dir, { recursive: true, force: true }); });
  let calls = 0; const persistenceFactory = async () => { calls += 1; return persistenceFixture(false); };
  const help = await runCli(['help'], { env: {}, stdout: () => {}, stderr: () => {}, persistenceFactory }); assert.equal(help, 0);
  const invalid = await runCli(['not-a-command'], { env: {}, stdout: () => {}, stderr: () => {}, persistenceFactory }); assert.equal(invalid, 2);
  let observeErr = '';
  const observe = await runCli(['run-observe', '--policy', POLICY_FILE], { env: {}, stdout: () => {}, stderr: (s) => { observeErr += s; }, clock: () => T0, persistenceFactory, tapeRunner: async () => {}, cwd: process.cwd() });
  assert.equal(observe, 0, observeErr);
  assert.equal(calls, 0);
});

test('default CLI reuses an already-started singleton without taking shutdown ownership or creating a second lifecycle', { concurrency: false }, async (t) => {
  const shared = await startPersistence({ registerSignals: false, log: () => {}, dbOverrides: { url: null } });
  t.after(() => shared.stop()); let err = '';
  const code = await runCli(['init-paper', '--policy', POLICY_FILE, '--account', 'shared-singleton', '--owner-stdin', 'true'], { env: { SERPENT_CONTROL_PASSWORD: PW }, stdin: Readable.from([`${PW}\n`]), stdout: () => {}, stderr: (s) => { err += s; }, clock: () => T0 });
  assert.equal(code, 4, err); assert.match(err, /DB_REQUIRED/); assert.equal(shared._internal.stopped, false, 'embedded singleton remains caller-owned');
});

test('command-owned lifecycle stops exactly once when DB validation throws', async () => {
  let stops = 0; const p = { db: { configured: () => { throw new Error('synthetic configured failure'); } }, health: () => ({ permissionLock: true }), stop: async () => { stops += 1; } };
  const result = await cli(['init-paper', '--policy', POLICY_FILE, '--account', 'configured-throws', '--owner-stdin', 'true'], async () => p);
  assert.equal(result.code, 5); assert.match(result.err, /synthetic configured failure/); assert.equal(stops, 1);
});

test('runCli positive control uses one actual started persistence runtime as both health and execution-journal DB', { concurrency: false }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-cli-real-runtime-')); const before = process.env.COBRA_DATA_DIR; process.env.COBRA_DATA_DIR = dir;
  const fake = executionPool(); const p = await startPersistence({ registerSignals: false, log: () => {}, dbOverrides: { url: 'postgresql://offline-fake/persist-cli', poolFactory: () => fake.pool, retries: 1 } });
  t.after(async () => { await p.stop(); if (before === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = before; rmSync(dir, { recursive: true, force: true }); });
  assert.equal(p.health().restored, true); assert.equal(p.health().permissionLock, false);
  let out = ''; let err = '';
  const code = await runCli(['init-paper', '--policy', POLICY_FILE, '--account', 'actual-runtime', '--owner-stdin', 'true'], { env: { SERPENT_CONTROL_PASSWORD: PW }, stdin: Readable.from([`${PW}\n`]), stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, clock: () => T0, persistence: p, cwd: process.cwd() });
  assert.equal(code, 0, err); assert.equal(JSON.parse(out).revision, 1); assert.equal(fake.execution.account.row.account_id, 'actual-runtime'); assert.equal(p._internal.stopped, false, 'the command did not stop caller-owned runtime');
  const unavailablePool = { query: async () => { throw Object.assign(new Error('synthetic unavailable'), { code: 'ECONNREFUSED' }); }, connect: async () => { throw Object.assign(new Error('synthetic unavailable'), { code: 'ECONNREFUSED' }); }, on() {}, end: async () => {} };
  const unrelatedGlobal = await startPersistence({ registerSignals: false, log: () => {}, dbOverrides: { url: 'postgresql://offline-fake/unrelated-locked', poolFactory: () => unavailablePool, retries: 1 } });
  t.after(() => unrelatedGlobal.stop()); assert.equal(unrelatedGlobal.health().permissionLock, true);
  out = ''; err = '';
  const paper = await runCli(['run-paper', '--policy', POLICY_FILE, '--account', 'actual-runtime', '--owner-stdin', 'true'], { env: { SERPENT_CONTROL_PASSWORD: PW }, stdin: Readable.from([`${PW}\n`]), stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, clock: () => T0, persistence: p, tapeRunner: async () => {}, cwd: process.cwd() });
  assert.equal(paper, 0, `the composition is bound to the supplied healthy runtime, not unrelated global BOOTING: ${err}`);
});

test('initAccount exact synchronous gate refuses malformed/async values and a gate flip before append without leaking its writer', async () => {
  for (const value of [false, 'true', undefined, Promise.reject(new Error('synthetic rejected gate'))]) {
    const journal = createMemoryJournal();
    await assert.rejects(initAccount({ journal, policy: POLICY.policy, policyDigest: POLICY.digest, mode: 'PAPER', ownerRef: 'test', nowTs: T0, accountId: `gate-${String(value)}`, permissionIncreaseAllowed: () => value }), { code: 'PERSISTENCE_PERMISSION_LOCK' });
  }
  const journal = createMemoryJournal(); let checks = 0;
  await assert.rejects(initAccount({ journal, policy: POLICY.policy, policyDigest: POLICY.digest, mode: 'PAPER', ownerRef: 'test', nowTs: T0, accountId: 'gate-flip', permissionIncreaseAllowed: () => { checks += 1; return checks < 5; } }), { code: 'PERSISTENCE_PERMISSION_LOCK' });
  const row = journal._row('gate-flip'); assert.ok(row); assert.equal(row.revision, 0); assert.equal(row.lockHeld, false, 'writer is released on refusal');
});

test('initAccount awaits the durable append before releasing its writer, on resolve and reject', async () => {
  for (const outcome of ['RESOLVE', 'REJECT']) {
    let held = false; let releases = 0; let settle;
    const journal = {
      exists: async () => true, load: async () => ({ revision: 0, state: { initialized: false } }),
      acquireWriter: async () => ({ epoch: 1, held: () => held, release: async () => { releases += 1; held = false; } }),
      append: async (_id, request) => { assert.equal(request.writer.held(), true); return new Promise((resolve, reject) => { settle = outcome === 'RESOLVE' ? () => resolve({ revision: 1 }) : () => reject(Object.assign(new Error('append failed'), { code: 'SYNTHETIC_APPEND_FAILURE' })); }); },
    };
    held = true; const pending = initAccount({ journal, policy: POLICY.policy, policyDigest: POLICY.digest, mode: 'PAPER', ownerRef: 'test', nowTs: T0, accountId: `await-${outcome}` });
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(held, true); assert.equal(releases, 0);
    settle(); if (outcome === 'RESOLVE') assert.equal((await pending).revision, 1); else await assert.rejects(pending, { code: 'SYNTHETIC_APPEND_FAILURE' });
    assert.equal(held, false); assert.equal(releases, 1);
  }
});

test('resumeLiveArmed rechecks the persistence lock in the serialized commit and changes no revision on a gate flip', { concurrency: false }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-cli-live-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.parse(readFileSync(POLICY_FILE, 'utf8')); const liveFile = path.join(dir, 'live.json');
  const KEY = 'SYNTHETIC-PERSIST-CLI-KEY'; const SECRET = 'SYNTHETIC-PERSIST-CLI-SECRET';
  writeFileSync(liveFile, JSON.stringify({ ...raw, policyName: 'persist-cli-live-test', mode: 'LIVE', account: { ...raw.account, accountId: 'persist-cli-live' }, execution: { ...raw.execution, adapter: 'KRAKEN' }, live: { allocationCeiling: '500', reinvestment: 'NONE', ownerLimits: null, armExpiryMs: 86_400_000, canaryMaxBuyConsiderationWithFees: '25', keyEnv: 'PERSIST_CLI_KEY', secretEnv: 'PERSIST_CLI_SECRET' }, authorityNote: 'Synthetic offline test.' }));
  const live = loadJudgePolicy(liveFile); const clock = fakeClock(); const journal = createMemoryJournal();
  await initAccount({ journal, policy: live.policy, policyDigest: live.digest, mode: 'LIVE_UNARMED', ownerRef: 'test', nowTs: clock.now(), accountId: 'persist-cli-live' });
  const seedWriter = await journal.acquireWriter('persist-cli-live'); const F = eventsFor('persist-cli-live', clock);
  await journal.append('persist-cli-live', { expectedRevision: 1, writerEpoch: seedWriter.epoch, writer: seedWriter, events: [F.authorized('auth-live', { kind: 'CANARY', policyDigest: live.digest, keyFingerprint: keyFingerprint(KEY), expiresTs: clock.now() + 60_000, allocationCeiling: '25', canary: { pair: 'XBT/USD', maxBuyConsiderationWithFees: '25', maxDurationMs: 60_000, lossAcknowledged: true } })] }); await seedWriter.release();
  let calls = 0; let stable = false; const boundPersistence = persistenceFixture(false);
  const run = await composeJudge({ policyFile: liveFile, mode: 'LIVE_ARMED', accountId: 'persist-cli-live', env: { PERSIST_CLI_KEY: KEY, PERSIST_CLI_SECRET: SECRET }, journal, clock: { now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true }), expired: (ts) => clock.now() > ts }, specs: [], nominations: () => [], writeProjection: false, codeDigest: 'c'.repeat(64), persistenceHealth: boundPersistence.health, permissionIncreaseAllowed: () => stable || (++calls === 1), log: () => {} });
  const before = run.dispatcher.revision();
  try {
    const blocked = await run.resumeLiveArmed({ authorizationId: 'auth-live', reason: 'restart test' });
    assert.deepEqual(blocked, { ok: false, reasons: ['PERSISTENCE_PERMISSION_LOCK'], state: 'BLOCKED' }); assert.equal(run.dispatcher.revision(), before); assert.equal(run.dispatcher.state().mode, 'LIVE_UNARMED');
    stable = true; const allowed = await run.resumeLiveArmed({ authorizationId: 'auth-live', reason: 'restart test' }); assert.equal(allowed.ok, true); assert.equal(run.dispatcher.state().mode, 'LIVE_ARMED');
    await run.disarm('REVOKED'); assert.equal(run.dispatcher.state().authorization.ended, true, 'protective/restrictive disarm is not gated');
  } finally { await run.writer.release(); }
});
