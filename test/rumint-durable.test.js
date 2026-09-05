// RUMINT-R1 durable-layer drills (real PostgreSQL): migration 4, the
// tri-state rumint checkpoint store contract, and the bounded bootstrap
// facts query over canonical durable Memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-rdur-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const { fromRumintEvent } = await import('../memory/adapters.js');

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('RUMINT-R1 durable checkpoint integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  test('D1. schema 4 applies; rumint checkpoint round-trips tri-state with revision counting', async () => {
    const { Db } = await import('../persistence/db.js');
    const { Repository } = await import('../persistence/repository.js');
    const { runMigrations } = await import('../persistence/migrate.js');
    const { rumintCheckpointStore, rumintBootstrapSource } = await import('../persistence/rumint-checkpoint.js');
    const SCHEMA = `rum1_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      const m = await runMigrations(db);
      assert.equal(m.schemaVersion, 5, 'RUMINT-R1 schema (and later) landed');
      const repo = new Repository(db);
      const alive = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      const store = rumintCheckpointStore({ persistence: alive });
      // tri-state: absence is an ANSWERED NOT_FOUND, never invented
      assert.deepEqual(await store.load(), { outcome: 'NOT_FOUND' });
      const cp = { version: 1, savedTs: new Date().toISOString(), provider: 'STOCKTWITS', baselines: {}, hyped: null, providerHealth: {}, pendingEvents: [], counters: {} };
      assert.equal((await store.save(cp)).durable, true);
      assert.deepEqual(await store.load(), { outcome: 'LOADED', state: cp });
      await store.save({ ...cp, counters: { polls: 2 } });
      assert.equal((await store.load()).state.counters.polls, 2, 'latest revision wins');
      const { rows } = await db.query(`SELECT revision FROM serpent_rumint_checkpoint WHERE id = 'current'`);
      assert.equal(Number(rows[0].revision), 2, 'revision counted');
      // NOT_CONFIGURED vs UNAVAILABLE never blur
      const dead = rumintCheckpointStore({ persistence: () => null });
      assert.deepEqual(await dead.load(), { outcome: 'NOT_CONFIGURED' });
      assert.deepEqual(await dead.save(cp), { durable: false, reason: 'NOT_CONFIGURED' });
      const broken = rumintCheckpointStore({
        persistence: () => ({
          repo: { loadRumintCheckpoint: async () => { throw new Error('db down'); }, saveRumintCheckpoint: async () => { throw new Error('db down'); } },
          health: () => ({ databaseConfigured: true, restored: true }),
        }),
      });
      assert.equal((await broken.load()).outcome, 'UNAVAILABLE', 'a read failure is NEVER "no checkpoint"');
      assert.deepEqual(await broken.save(cp), { durable: false, reason: 'UNAVAILABLE' });
      // the bootstrap read interface: NOT_CONFIGURED yields null (nothing to
      // read), an unrestored-but-configured core THROWS so the collector
      // withholds instead of treating unreadable as empty
      assert.equal(await rumintBootstrapSource({ persistence: () => null })({}), null);
      await assert.rejects(
        rumintBootstrapSource({ persistence: () => ({ repo, health: () => ({ databaseConfigured: true, restored: false }) }) })({})
      );

      // D2. bounded bootstrap facts: max observed hourly velocity per
      // provider symbol per absolute hour, proven RUMINT_POLL records only
      const T = 1_750_000_000_000; // past epoch, hour-aligned below
      const hour = Math.floor(T / 3_600_000) * 3_600_000;
      const rec = (tsMs, velocity, sym = 'BTC.X') =>
        fromRumintEvent({ ts: new Date(tsMs).toISOString(), type: 'RUMINT_POLL', symbol: sym, velocity, z: null }, new Date(tsMs).toISOString());
      await repo.insertMemoryEvent(rec(hour + 5 * 60_000, 3));
      await repo.insertMemoryEvent(rec(hour + 25 * 60_000, 9)); // same hour, later cumulative count
      await repo.insertMemoryEvent(rec(hour + 65 * 60_000, 4)); // next hour
      await repo.insertMemoryEvent(rec(hour + 6 * 60_000, 7, 'ETH.X'));
      // a failed poll and a nomination must contribute NOTHING
      await repo.insertMemoryEvent(fromRumintEvent({ ts: new Date(hour + 7 * 60_000).toISOString(), type: 'RUMINT_POLL_FAILED', symbol: 'BTC.X', error: 'x', velocity: 999 }));
      await repo.insertMemoryEvent(fromRumintEvent({ ts: new Date(hour + 8 * 60_000).toISOString(), type: 'RUMINT_NOMINATION', symbol: 'BTC', z: 4, velocity: 888 }));
      // a poll with a non-numeric velocity is excluded, never guessed
      await repo.insertMemoryEvent(rec(hour + 9 * 60_000, 'lots', 'DOGE.X'));
      const facts = await repo.rumintPollHourFacts({ sinceTs: Math.floor(hour / 1000) - 10 });
      const key = (f) => `${f.providerSymbol}@${f.hourTsSec}`;
      const map = new Map(facts.map((f) => [key(f), f.velocity]));
      assert.equal(map.get(`BTC.X@${hour / 1000}`), 9, 'max cumulative velocity for the observed hour');
      assert.equal(map.get(`BTC.X@${hour / 1000 + 3600}`), 4);
      assert.equal(map.get(`ETH.X@${hour / 1000}`), 7);
      assert.ok(![...map.keys()].some((k) => k.startsWith('DOGE.X')), 'non-numeric velocity contributes nothing');
      assert.ok(![...map.values()].includes(999) && ![...map.values()].includes(888), 'failures and nominations contribute nothing');

      // D3 (R1A): a REAL collector checkpoint — hyped snapshot, transaction
      // and all — must still validate after the jsonb round-trip, whose key
      // reordering is not a semantic change. (Regression: the semantic
      // HYPED recompute once compared key-order-sensitively and withheld
      // every restart from PostgreSQL.)
      const { validateCheckpoint, hypedSnapshot, RUMINT_CHECKPOINT_VERSION, emptyBaseline, ingestPage } = await import('../rumint/truth.js');
      const atMs = 1_750_000_000_000;
      let b = emptyBaseline('BTC.X', 'BTC');
      ({ baseline: b } = ingestPage(b, [{ id: 100, created_at: new Date(atMs - 120_000).toISOString() }], atMs - 60_000));
      const baselines = { 'BTC.X': b };
      const hy = hypedSnapshot({ baselines, atMs });
      const full = {
        version: RUMINT_CHECKPOINT_VERSION,
        savedTs: new Date(atMs).toISOString(),
        provider: 'STOCKTWITS',
        baselines,
        hyped: { ...hy, finalizedTs: hy.state === 'BUILDING' ? null : new Date(atMs).toISOString() },
        providerHealth: { globalBackoffUntil: 0, recentRequestTimestamps: [atMs - 5000], symbols: {} },
        pendingEvents: [],
        pollTransaction: null,
        counters: { polls: 1 },
      };
      assert.equal(validateCheckpoint(full), null, 'validates in memory');
      await store.save(full);
      const roundTripped = (await store.load()).state;
      assert.equal(validateCheckpoint(roundTripped), null, 'STILL validates after the jsonb round-trip reorders keys');
    } finally {
      try {
        await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
      } catch {
        // schema may already be gone
      }
      await db.end();
    }
  });
}
