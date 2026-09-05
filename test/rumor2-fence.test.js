// RUMOR-2 LIVE WRITER-FENCE closeout — NO RUMOR DURABLE MUTATION MAY BEGIN
// OR COMPLETE UNLESS THIS COLLECTOR CURRENTLY HOLDS THE WRITER FENCE.
// Writer authority is re-consulted live at every truth-changing boundary,
// never trusted from a boolean captured when the tick began. At baseline
// daa2731 a fence lost mid-fetch let the old collector keep writing truth;
// these drills pin the repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { canonicalJson } from '../rumor2/truth.js';
import { PROVIDER_IDS } from '../rumor2/registry.js';
import { memJournal } from './helpers/rumor2-journal.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-r2fence-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = { universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] };
const T1 = Date.parse('2026-09-05T12:00:00Z');
const H = { get: () => null };
const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
const rssItem = (i) =>
  `<item><title>${i.title}</title><link>https://blog.kraken.com/p/${i.guid}</link><guid>${i.guid}</guid>` +
  `<pubDate>${new Date(i.pubMs ?? T1 - 3_600_000).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`;
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>f</title>${items.map(rssItem).join('')}</channel></rss>`;
const LISTING = { title: 'BTC trading starts on Kraken', guid: 'listing-1', desc: 'Bitcoin (BTC) is now available for trading.' };

function memStore(saved = null) {
  const s = { saved, saves: 0 };
  return {
    state: s,
    async load() {
      return s.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(s.saved) };
    },
    async save(state) {
      s.saves += 1;
      s.saved = structuredClone(state);
      return { durable: true };
    },
  };
}

// A deterministic FENCED mem journal: same closed contract as the durable
// store (dedupe, corruption, defense-in-depth append refusal) plus a
// controllable live-fence flag the tests flip to simulate advisory-session
// death. `dieAfterAppend` flips the fence to lost right after a successful
// commit — the post-journal-commit window.
function fenceJournal(arr, ctrl) {
  ctrl.held = true;
  ctrl.appends = 0;
  return {
    async acquireWriter() {
      if (ctrl.blockAcquire) return { ok: false, reason: 'HELD' };
      ctrl.held = true;
      return { ok: true };
    },
    writerHeld() {
      return ctrl.held;
    },
    async releaseWriter() {
      ctrl.held = false;
    },
    async read() {
      if (ctrl.readUnavailable) return { unavailable: 'injected read failure' };
      return { events: structuredClone(arr), lastSeq: arr.length };
    },
    async append(records) {
      // DEFENSE IN DEPTH: the durable journal itself refuses a fence-less write
      if (ctrl.held !== true) return { ok: false, reason: 'WRITER_FENCE_LOST' };
      const add = [];
      for (const rec of records) {
        if (typeof rec.sourceEventId === 'string') {
          const ex = [...arr, ...add].find((e) => e.type === rec.type && e.sourceEventId === rec.sourceEventId);
          if (ex) {
            if (canonicalJson(ex) !== canonicalJson(rec)) return { ok: false, reason: 'CORRUPTION: altered payload' };
            continue;
          }
        }
        add.push(structuredClone(rec));
      }
      arr.push(...add);
      ctrl.appends += 1;
      // post-commit fence loss, but only on a truth-bearing bundle (not the
      // STARTED/health lifecycle appends)
      if (ctrl.dieAfterAppend && add.some((e) => e.type === 'RUMOR2_SOURCE_OBSERVED')) ctrl.held = false;
      return { ok: true, lastSeq: arr.length };
    },
  };
}

// a fetch whose kraken hop can be gated: it resolves only when the test
// releases the barrier, so a fence can die mid-flight
function gatedFetch(items, gate) {
  return async (u) => {
    const host = new URL(u).hostname;
    if (host === 'blog.kraken.com') {
      if (gate) await gate.promise;
      return mkRes(200, rss(items));
    }
    return mkRes(304, '');
  };
}
const makeGate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};

function boot({ store, journal, fetchImpl, clockMs = T1, feedItems = [LISTING] }) {
  seedDir();
  const clock = { ms: clockMs };
  const fetchCalls = [];
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl:
      fetchImpl ??
      (async (u) => {
        fetchCalls.push(u);
        return new URL(u).hostname === 'blog.kraken.com' ? mkRes(200, rss(feedItems)) : mkRes(304, '');
      }),
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    journal,
    contact: 'ops@example.com',
    enabled: true,
    timeoutMs: 100,
  });
  return { c, clock, fetchCalls, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
}

// truth-bearing events only — STARTED/PROVIDER_FAILURE are lifecycle records
const truthEvents = (arr) => arr.filter((e) => e.type !== 'RUMOR2_STARTED' && e.type !== 'RUMOR2_PROVIDER_FAILURE');
const truthWritten = (store, arr) => truthEvents(arr).length > 0 || (store.state.saved?.counters?.sourcesObserved ?? 0) > 0;

// sanity: a fenced collector that KEEPS its fence settles truth normally
test('FENCE-0. control: a held fence settles truth as before (happy path intact)', async () => {
  const ctrl = {};
  const arr = [];
  const store = memStore();
  const b = boot({ store, journal: fenceJournal(arr, ctrl), clockMs: T1 - 4_000_000 });
  await b.tick();
  assert.equal(b.c.status().writerAuthority, 'ACTIVE');
  assert.equal(store.state.saved.counters.sourcesObserved, 1, 'the happy path still settles');
  assert.ok(arr.some((e) => e.type === 'RUMOR2_SOURCE_OBSERVED'));
  await b.c.stop();
});

// ---- mid-fetch loss (FENCE-1..6) ------------------------------------------
test('FENCE-1..4+6. fence lost during the provider fetch => the resumed tick writes ZERO truth and halts', async () => {
  const ctrl = {};
  const arr = [];
  const store = memStore();
  const gate = makeGate();
  const b = boot({ store, journal: fenceJournal(arr, ctrl), fetchImpl: gatedFetch([LISTING], gate), clockMs: T1 - 4_000_000 });
  // start the tick; it acquires the fence and blocks inside the kraken fetch
  b.clock.ms += 4_000_000;
  const tickP = b.c.tickOnce();
  await new Promise((r) => setTimeout(r, 20)); // let the tick reach the awaited fetch
  ctrl.held = false; // the advisory-lock session dies mid-fetch
  gate.release(); // the fetch now returns a valid listing item
  await tickP;
  assert.equal(truthWritten(store, arr), false, 'a fence-less resumed tick produced no journal event and no counter advance');
  assert.equal(arr.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 0, 'no source observed by the old writer');
  assert.notEqual(b.c.status().writerAuthority, 'ACTIVE', 'status no longer claims ACTIVE');
  await b.c.stop();
});

// ---- mid-write-ahead loss (FENCE-7) ---------------------------------------
test('FENCE-7. fence lost before the write-ahead checkpoint save => no pending checkpoint is written', async () => {
  const ctrl = {};
  const arr = [];
  const store = memStore();
  const gate = makeGate();
  const b = boot({ store, journal: fenceJournal(arr, ctrl), fetchImpl: gatedFetch([LISTING], gate), clockMs: T1 - 4_000_000 });
  b.clock.ms += 4_000_000;
  const tickP = b.c.tickOnce();
  await new Promise((r) => setTimeout(r, 20));
  ctrl.held = false;
  gate.release();
  await tickP;
  assert.equal(store.state.saved?.txn ?? null, null, 'no owed pending transaction was persisted unfenced');
  assert.equal(truthEvents(arr).length, 0, 'nothing truth-bearing appended');
  await b.c.stop();
});

// ---- journal defense-in-depth (FENCE-9/10, §22) ---------------------------
test('FENCE-9+10 §22. the journal append API itself refuses a batch when the fence is not held', async () => {
  const ctrl = {};
  const arr = [];
  const j = fenceJournal(arr, ctrl);
  assert.deepEqual(await j.append([{ type: 'RUMOR2_PROVIDER_FAILURE', ts: 'x', provider: 'SEC_OFFICIAL', reason: 'r', httpStatus: 500, consecutiveFailures: 1 }]), {
    ok: true,
    lastSeq: 1,
  });
  ctrl.held = false; // fence lost
  const r = await j.append([{ type: 'RUMOR2_PROVIDER_FAILURE', ts: 'y', provider: 'SEC_OFFICIAL', reason: 'r', httpStatus: 500, consecutiveFailures: 2 }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'WRITER_FENCE_LOST');
  assert.equal(arr.length, 1, 'no fence-less row allocated');
});

// ---- post-journal-commit loss (FENCE-11, §7) ------------------------------
test('FENCE-11 §7. fence dies after journal commit but before adoption => journal advanced, checkpoint NOT adopted', async () => {
  const ctrl = { dieAfterAppend: true };
  const arr = [];
  const store = memStore();
  const b = boot({ store, journal: fenceJournal(arr, ctrl), clockMs: T1 - 4_000_000 });
  await b.tick();
  // the journal received the bundle (durable), but the fence died the instant
  // after commit, so the old writer must NOT have adopted candidate state
  assert.ok(arr.some((e) => e.type === 'RUMOR2_SOURCE_OBSERVED'), 'the bundle is durably in the journal');
  assert.equal(store.state.saved.counters.sourcesObserved, 0, 'counters were NOT adopted unfenced');
  assert.equal(store.state.saved.lastSettledEventSeq, 0, 'the watermark was NOT advanced unfenced');
  assert.ok(store.state.saved.txn, 'the transaction remains owed for the next legitimate writer');
  assert.notEqual(b.c.status().writerAuthority, 'ACTIVE');
  await b.c.stop();
  // a fresh legitimate writer reconciles the journal-ahead tail EXACTLY ONCE
  ctrl.held = true; // (same durable core; the new session owns the fence)
  ctrl.dieAfterAppend = false;
  const store2 = memStore(structuredClone(store.state.saved));
  const b2 = boot({ store: store2, journal: fenceJournal(arr, ctrl), clockMs: T1 + 8_000_000 });
  await b2.tick();
  assert.equal(b2.c.status().lifecycle, 'RESTORED');
  assert.equal(store2.state.saved.counters.sourcesObserved, 1, 'reconciled exactly once — no double-apply, no loss');
  assert.equal(store2.state.saved.txn, null, 'the owed transaction settled');
  assert.equal(arr.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 1, 'no duplicate source minted');
  await b2.c.stop();
});

// ---- status truth (FENCE-15..18) ------------------------------------------
test('FENCE-15..17. status never keeps claiming ACTIVE once a live fence check sees the loss', async () => {
  const ctrl = {};
  const arr = [];
  const store = memStore();
  const b = boot({ store, journal: fenceJournal(arr, ctrl), clockMs: T1 - 4_000_000 });
  await b.tick();
  assert.equal(b.c.status().writerAuthority, 'ACTIVE');
  ctrl.held = false; // session dies between ticks
  const st = b.c.status(); // a live status read must not preserve ACTIVE
  assert.notEqual(st.writerAuthority, 'ACTIVE');
  assert.equal(st.writerAuthority, 'STANDBY');
  await b.c.stop();
});

// ---- DB uncertainty fails closed (§20) ------------------------------------
test('FENCE-DB §20. when the fence cannot be confirmed (read unavailable) the collector does not write truth', async () => {
  const ctrl = { held: false, readUnavailable: true, blockAcquire: false };
  const arr = [];
  const store = memStore();
  // fence lost AND the durable core cannot confirm state — a re-init attempt
  // must fail closed, never assume ownership
  ctrl.held = false;
  const j = fenceJournal(arr, ctrl);
  const orig = j.acquireWriter;
  j.acquireWriter = async () => ({ ok: false, reason: 'UNAVAILABLE' });
  const b = boot({ store, journal: j, clockMs: T1 - 4_000_000 });
  await b.tick();
  assert.equal(truthWritten(store, arr), false, 'uncertain ownership writes nothing');
  assert.notEqual(b.c.status().writerAuthority, 'ACTIVE');
  await b.c.stop();
});

// ---- normal failover unaffected -------------------------------------------
test('FENCE-14. a fence held throughout still settles, and normal release works', async () => {
  const ctrl = {};
  const arr = [];
  const store = memStore();
  const b = boot({ store, journal: fenceJournal(arr, ctrl), clockMs: T1 - 4_000_000 });
  await b.tick();
  assert.equal(store.state.saved.counters.sourcesObserved, 1);
  await b.c.stop();
  assert.equal(ctrl.held, false, 'normal stop released the fence');
});

// ---- fixed-seed interleaving fuzz (§33) -----------------------------------
test('FENCE-FUZZ §33. fence loss at any point never lets the old writer advance truth past the loss', async () => {
  let seed = 0xfe0ce5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x80000000);
  for (let i = 0; i < 40; i++) {
    const ctrl = {};
    const arr = [];
    const store = memStore();
    const gate = makeGate();
    // choose when the fence dies: before fetch resolves, or after commit
    const mode = Math.floor(rnd() * 2);
    if (mode === 1) ctrl.dieAfterAppend = true;
    const b = boot({ store, journal: fenceJournal(arr, ctrl), fetchImpl: gatedFetch([LISTING], gate), clockMs: T1 - 4_000_000 });
    b.clock.ms += 4_000_000;
    const tickP = b.c.tickOnce();
    await new Promise((r) => setTimeout(r, 10));
    if (mode === 0) ctrl.held = false; // mid-fetch death
    gate.release();
    await tickP;
    if (mode === 0) {
      assert.equal(truthWritten(store, arr), false, `iter ${i}: mid-fetch loss produced truth`);
    } else {
      // post-commit: journal may hold the bundle, but counters/watermark must not adopt
      assert.equal(store.state.saved?.counters?.sourcesObserved ?? 0, 0, `iter ${i}: adopted counters after post-commit loss`);
      assert.equal(store.state.saved?.lastSettledEventSeq ?? 0, 0, `iter ${i}: advanced watermark after post-commit loss`);
    }
    assert.notEqual(b.c.status().writerAuthority, 'ACTIVE', `iter ${i}: stale ACTIVE`);
    await b.c.stop();
  }
});

// ---------------------------------------------------------------------------
// REAL PostgreSQL — advisory-session death, mid-fetch takeover, direct-append
// refusal, and Db.end cleanup (§21/§22/§23/§25/§29).
// ---------------------------------------------------------------------------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('FENCE-PG. real-PostgreSQL writer-fence integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');

  const withDb = async (fn) => {
    const SCHEMA = `r2fp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      assert.equal(await admin.connect(), true);
      await runMigrations(db);
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, repo, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end(); await admin.end();
    }
  };
  const killAdvisoryBackends = async (admin) => {
    const { rows } = await admin.query(
      `SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted
         AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`
    );
    for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
    return rows.length;
  };
  const pgBoot = ({ checkpointStore, journal, fetchImpl, feedItems = [LISTING], clockMs = T1 }) => {
    seedDir();
    const clock = { ms: clockMs };
    const c = startRumor2({
      log: () => {}, config: CONFIG,
      fetchImpl: fetchImpl ?? (async (u) => (new URL(u).hostname === 'blog.kraken.com' ? mkRes(200, rss(feedItems)) : mkRes(304, ''))),
      now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
    });
    return { c, clock, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const waitFor = async (pred, ms = 5000) => { let w = 0; while (!pred() && w < ms) { await new Promise((r) => setTimeout(r, 50)); w += 50; } return pred(); };

  test('FENCE-PG-22+23. the durable journal append refuses without a held fence; a killed session makes writerHeld() false', async () => {
    await withDb(async ({ admin, mkStores }) => {
      const { journal } = mkStores();
      // §22: direct append without acquiring writer authority is REFUSED
      const ev = { type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T1).toISOString(), provider: 'SEC_OFFICIAL', reason: 'r', httpStatus: 500, consecutiveFailures: 1 };
      const noFence = await journal.append([ev]);
      assert.equal(noFence.ok, false);
      assert.equal(noFence.reason, 'WRITER_FENCE_LOST', 'no fence held => append refused');
      // acquire, then §23: killing the exact session flips writerHeld() false
      assert.deepEqual(await journal.acquireWriter(), { ok: true });
      assert.equal(journal.writerHeld(), true);
      assert.ok((await killAdvisoryBackends(admin)) >= 1, 'the advisory fence is visible and killed');
      assert.equal(await waitFor(() => journal.writerHeld() === false), true, 'writerHeld() detects the dead session');
      // and the append now refuses through defense-in-depth
      const afterDeath = await journal.append([ev]);
      assert.equal(afterDeath.ok, false);
      assert.equal(afterDeath.reason, 'WRITER_FENCE_LOST');
      await journal.releaseWriter().catch(() => {});
    });
  });

  test('FENCE-PG-21. mid-fetch takeover: B acquires while A is fetching; A writes ZERO truth after fence loss', async () => {
    await withDb(async ({ admin, mkStores }) => {
      const A = mkStores();
      const gate = makeGate();
      const a = pgBoot({ ...A, fetchImpl: gatedFetch([LISTING], gate), clockMs: T1 - 4_000_000 });
      a.clock.ms += 4_000_000;
      const tickP = a.c.tickOnce();
      assert.equal(await waitFor(() => a.c.status().writerAuthority === 'ACTIVE'), true, 'A became the active writer');
      // A is now blocked in the kraken fetch; kill its advisory-lock session
      assert.ok((await killAdvisoryBackends(admin)) >= 1);
      // B legitimately acquires the freed writer authority (the terminated
      // backend releases the advisory lock asynchronously — poll, bounded)
      const B = mkStores();
      let bAcquired = false;
      for (let i = 0; i < 100 && !bAcquired; i++) {
        bAcquired = (await B.journal.acquireWriter()).ok;
        if (!bAcquired) await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(bAcquired, true, 'B took over writer authority after A lost its session');
      // A's fetch now resolves — the resumed tick must write nothing
      gate.release();
      await tickP;
      const jrA = await A.journal.read();
      assert.equal(jrA.events.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 0, 'A minted no source after losing the fence');
      const cpA = a.c.internals.checkpoint;
      assert.equal(cpA.counters.sourcesObserved, 0, 'A adopted no counters');
      assert.notEqual(a.c.status().writerAuthority, 'ACTIVE', 'A no longer claims ACTIVE');
      await a.c.stop();
      await B.journal.releaseWriter().catch(() => {});
    });
  });

  test('FENCE-PG-25. Db.end() with a held writer fence completes without hanging (no checked-out-client deadlock)', async () => {
    const SCHEMA = `r2fe_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    assert.equal(await db.connect(), true);
    await runMigrations(db);
    const repo = new Repository(db);
    const journal = rumor2JournalStore({ persistence: () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) }) });
    assert.deepEqual(await journal.acquireWriter(), { ok: true });
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    // the freeze-seal Db.end lock-release must still hold: this returns, never hangs
    await db.end();
    assert.ok(true, 'Db.end() released the held lock client and completed');
  });
}
