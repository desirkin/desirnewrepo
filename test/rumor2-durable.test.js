// RUMOR-2A durable-layer drills (real PostgreSQL): migration 5, the
// four-outcome rumor2 checkpoint store contract, monotonic revisions,
// withheld corrupt checkpoints, persisted seen identities and backoff, and
// restart honesty — a republish never replays history as new evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { memJournal } from './helpers/rumor2-journal.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-r2dur-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('RUMOR-2A durable checkpoint integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { startRumor2 } = await import('../rumor2/collector.js');
  const { emptyCheckpoint } = await import('../rumor2/truth.js');
  const { PROVIDER_IDS } = await import('../rumor2/registry.js');

  const T0 = Date.parse('2026-09-05T12:00:00Z');
  const mkRes = (status, body = '', headers = {}) => {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, headers: { get: (n) => h[n.toLowerCase()] ?? null }, text: async () => body };
  };
  const rss = (items) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>f</title>` +
    items
      .map(
        (i) =>
          `<item><title>${i.title}</title><link>https://blog.kraken.com/p/${i.guid}</link><guid>${i.guid}</guid>` +
          `<pubDate>${new Date(T0 - 3_600_000).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`
      )
      .join('') +
    `</channel></rss>`;

  test('D61-63. migrations apply (schema 6 with the event journal); rumor2 checkpoint round-trips with monotonic revisions', async () => {
    const SCHEMA = `r2a_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      const m = await runMigrations(db);
      assert.equal(m.schemaVersion, 7, 'RUMOR-2 event-root schema (and later) landed in Development PostgreSQL');
      const repo = new Repository(db);
      const alive = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      const store = rumor2CheckpointStore({ persistence: alive });
      // four-outcome contract: absence is NOT_FOUND, never invented state
      assert.deepEqual(await store.load(), { outcome: 'NOT_FOUND' });
      const cp = emptyCheckpoint([...PROVIDER_IDS], T0);
      cp.providers.KRAKEN_OFFICIAL.seenIds = [`r2s-${'a'.repeat(40)}`];
      cp.providers.KRAKEN_OFFICIAL.backoffUntil = T0 + 900_000;
      cp.providers.KRAKEN_OFFICIAL.etag = '"e-77"';
      assert.deepEqual(await store.save(cp), { durable: true });
      const r1 = await store.load();
      assert.equal(r1.outcome, 'LOADED');
      assert.deepEqual(r1.state.providers.KRAKEN_OFFICIAL.seenIds, [`r2s-${'a'.repeat(40)}`], 'seen IDs persist (D66)');
      assert.equal(r1.state.providers.KRAKEN_OFFICIAL.backoffUntil, T0 + 900_000, 'backoff persists (D67)');
      assert.equal(r1.state.providers.KRAKEN_OFFICIAL.etag, '"e-77"');
      // DB-side revision counter is monotonic across saves
      await store.save({ ...cp, revision: cp.revision + 1 });
      await store.save({ ...cp, revision: cp.revision + 2 });
      const rev = await db.query(`SELECT revision FROM serpent_rumor2_checkpoint WHERE id = 'current'`);
      assert.equal(Number(rev.rows[0].revision), 3, 'revision strictly increases; nothing rewinds');
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  });

  test('D64-65. malformed durable checkpoint is WITHHELD — no silent fresh start over corrupt truth', async () => {
    const SCHEMA = `r2b_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      await runMigrations(db);
      const repo = new Repository(db);
      const alive = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      const store = rumor2CheckpointStore({ persistence: alive });
      await store.save({ checkpointVersion: 99, corrupt: true });
      const clock = { ms: T0 };
      const fetchCalls = [];
      const c = startRumor2({
        log: () => {},
        config: { universe: ['BTC'] },
        fetchImpl: async (u) => (fetchCalls.push(u), mkRes(404, '')),
        now: () => clock.ms,
        intervalMs: 2_147_000_000,
        checkpointStore: store,
        journal: memJournal([]),
        contact: null,
        enabled: true,
        timeoutMs: 50,
      });
      clock.ms += 121_000;
      await c.tickOnce();
      assert.equal(c.internals.lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
      assert.equal(fetchCalls.length, 0, 'a withheld ear consumes nothing');
      // the corrupt durable row is untouched — nothing fresh-started over it
      const row = await repo.loadRumor2Checkpoint();
      assert.equal(row.checkpointVersion, 99, 'corrupt truth preserved for forensics, not overwritten');
      await c.stop();
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  });

  test('D68-69. restart over the durable checkpoint does not duplicate historical source observations', async () => {
    const SCHEMA = `r2c_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      await runMigrations(db);
      const repo = new Repository(db);
      const alive = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      const store = rumor2CheckpointStore({ persistence: alive });
      const feed = () => mkRes(200, rss([{ title: 'historic post', guid: 'h1', desc: 'nothing coin-specific' }]));
      // ONE durable append-only event log across restarts — it is the
      // restore witness the checkpoint's derived state is proven against
      const log = [];
      const run = async () => {
        const before = log.length;
        const clock = { ms: T0 };
        const c = startRumor2({
          log: () => {},
          config: { universe: ['BTC'] },
          fetchImpl: async (u) => (new URL(u).hostname === 'blog.kraken.com' ? feed() : mkRes(304, '')),
          now: () => clock.ms,
          intervalMs: 2_147_000_000,
          checkpointStore: store,
          journal: memJournal(log),
          contact: null,
          enabled: true,
          timeoutMs: 50,
        });
        clock.ms += 121_000;
        await c.tickOnce();
        const dup = c.internals.runtime.KRAKEN_OFFICIAL.duplicates;
        await c.stop();
        return { dup, appended: log.slice(before) };
      };
      const run1 = await run();
      assert.equal(run1.appended.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 1);
      assert.equal(run1.dup, 0);
      const run2 = await run(); // full restart over the durable checkpoint + durable log
      assert.equal(run2.appended.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 0, 'history is remembered, not replayed');
      assert.equal(run2.dup, 1, 'the replayed feed item is a counted duplicate');
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  });
}
