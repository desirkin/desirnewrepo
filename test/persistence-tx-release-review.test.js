import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../persistence/db.js';

const ok = () => ({ rows: [], rowCount: 0 });

function error(message, code = undefined) {
  const value = new Error(message);
  if (code !== undefined) value.code = code;
  return value;
}

async function harness(steps) {
  const pending = [...steps];
  const queries = [];
  const releases = [];
  const client = {
    async query(text) {
      queries.push(text);
      const step = pending.shift();
      if (step instanceof Error) throw step;
      if (typeof step === 'function') return step(text);
      return step ?? ok();
    },
    release(...args) { releases.push(args); },
  };
  const pool = {
    async query() { return ok(); },
    async connect() { return client; },
    on() {},
    async end() {},
  };
  const db = new Db({
    url: 'postgresql://offline/fixture',
    poolFactory: () => pool,
    retries: 1,
  });
  assert.equal(await db.connect(), true);
  return { db, queries, releases };
}

async function rejectsSame(operation, expected) {
  await assert.rejects(operation, (actual) => {
    assert.equal(actual, expected, 'the primary transaction error must be preserved');
    return true;
  });
}

test('connection-classified query timeout discards the client after a successful rollback', async () => {
  const primary = error('Query read timeout');
  const h = await harness([ok(), primary, ok()]);

  await rejectsSame(() => h.db.tx((q) => q('SELECT work')), primary);

  assert.deepEqual(h.queries, ['BEGIN', 'SELECT work', 'ROLLBACK']);
  assert.equal(h.releases.length, 1, 'the checked-out client is released exactly once');
  assert.deepEqual(h.releases[0], [primary], 'release(error) removes the timed-out client from pg-pool');
  assert.equal(h.db.reachable, false);
  assert.equal(h.db.connectionErrors, 1);
  assert.equal(h.db.transactionErrors, 1);
  await h.db.end();
});

test('rollback timeout discards the client but never replaces the primary constraint error', async () => {
  const primary = error('duplicate key', '23505');
  const rollback = error('Query read timeout');
  const h = await harness([ok(), rollback]);

  await rejectsSame(() => h.db.tx(async () => { throw primary; }), primary);

  assert.deepEqual(h.queries, ['BEGIN', 'ROLLBACK']);
  assert.equal(h.releases.length, 1);
  assert.deepEqual(h.releases[0], [rollback]);
  assert.equal(h.db.reachable, false, 'the rollback timeout applies the shared connection classifier');
  assert.equal(h.db.connectionErrors, 1);
  assert.equal(h.db.transactionErrors, 1);
  await h.db.end();
});

test('any rollback failure discards an uncertain client even when it is not a connection-classified error', async () => {
  const primary = error('callback refused input', '22000');
  const rollback = error('rollback protocol state unknown');
  const h = await harness([ok(), rollback]);

  await rejectsSame(() => h.db.tx(async () => { throw primary; }), primary);

  assert.deepEqual(h.queries, ['BEGIN', 'ROLLBACK']);
  assert.equal(h.releases.length, 1);
  assert.deepEqual(h.releases[0], [rollback]);
  assert.equal(h.db.connectionErrors, 0, 'non-connection errors do not inflate connection metrics');
  assert.equal(h.db.transactionErrors, 1);
  await h.db.end();
});

test('connection failure during BEGIN is rolled back best-effort and the client is discarded once', async () => {
  const primary = error('Connection terminated unexpectedly', 'ECONNRESET');
  const h = await harness([primary, ok()]);
  let callbackCalls = 0;

  await rejectsSame(() => h.db.tx(async () => { callbackCalls += 1; }), primary);

  assert.equal(callbackCalls, 0);
  assert.deepEqual(h.queries, ['BEGIN', 'ROLLBACK']);
  assert.equal(h.releases.length, 1);
  assert.deepEqual(h.releases[0], [primary]);
  assert.equal(h.db.reachable, false);
  assert.equal(h.db.connectionErrors, 1);
  assert.equal(h.db.transactionErrors, 1);
  await h.db.end();
});

test('ordinary callback constraint error with successful rollback returns a healthy client', async () => {
  const primary = error('duplicate key', '23505');
  const h = await harness([ok(), ok()]);

  await rejectsSame(() => h.db.tx(async () => { throw primary; }), primary);

  assert.deepEqual(h.queries, ['BEGIN', 'ROLLBACK']);
  assert.equal(h.releases.length, 1);
  assert.deepEqual(h.releases[0], [], 'healthy rollback uses release() without an eviction error');
  assert.equal(h.db.reachable, true);
  assert.equal(h.db.connectionErrors, 0);
  assert.equal(h.db.transactionErrors, 1);
  await h.db.end();
});
