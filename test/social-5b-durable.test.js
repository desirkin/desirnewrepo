// SOCIAL-5B §12 with REAL PostgreSQL through the ACTUAL seams: T01 (the repaired outcome seam through the live
// collector with fake transports + restart), T02 (server-enforced READ ONLY snapshot: mutation rejected inside the
// export transaction; no migration, lock or durable table change; every page on the same backend), T03 (concurrent
// append, more than one page, empty valid journal, sequence gap, malformed payload, failed read mid-page, unknown
// projection version, unsafe sequence), T15 (snapshot uses only the explicitly named credential; sanitized errors).
// The established isolated test database is REQUIRED for the full gate: a missing database is not a passing suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { RESEARCH_DOSSIER_EVENT_TYPE, SOCIAL_OBSERVATION_TYPES } from '../rumor2/social-settle.js';
import { canonicalJson } from '../rumor2/truth.js';
import { loadConfig } from '../lib/config.js';
import { readJournalPrefixReadOnly, READ_ONLY_FIRST_STATEMENT } from '../persistence/social-research-export.js';
import { runSnapshot, readSnapshotDir } from '../research/pipeline.js';
import { ResearchError, sha256Hex } from '../research/contracts.js';
import { runCli } from '../bin/social-research.js';
import { journalFixture, SENTINEL_TEXT } from './helpers/social-5b.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const C = T0 - 3_600_000;
const iso = (m) => new Date(m).toISOString();
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const pairs = (bases) => Object.fromEntries(bases.map((b) => [`${b}USD`, { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }]));
const catalogOf = (bases, observedTs) => { const n = normalizeKrakenAssetPairs(pairs(bases), { excludeBases: EXCLUDE, observedTs }); assert.equal(n.ok, true, n.reason); return n.catalog; };
const accepted = (catalog) => ({ status: 'ACCEPTED', catalog, lastError: null, lastSuccessTs: catalog.observedTs, lastAttemptTs: catalog.observedTs });
const commit = (seq, text, { rkey = `r${seq}`, did = 'did:plc:a' } = {}) => ({ $type: 'message', payload: { $type: 'x#commit', did, seq, time: iso(C), operation: 'create', collection: 'app.bsky.feed.post', rkey, cid: `cid${seq}`, record: { $type: 'app.bsky.feed.post', text, createdAt: iso(C) } } });
function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; }, closed: false }; }
const notice = (symbol, tsMs, over = {}) => ({ ts: iso(tsMs), tsMs, symbol, verdict: 'RIPPLE', zVol: 5.1, zRet: 2.2, extension: 3.9, liquidityNote: 'x', inDeepTape: false, usdVol24h: 3_000_000, ...over });
const dirs = []; const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
function seedDir() { const d = tmp('cobra-5bd-'); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e?.stack ?? e}`); return e.code; } };
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
assert.ok(TEST_URL, 'SOCIAL-5B durable tests REQUIRE PERSIST_TEST_DATABASE_URL (the established isolated test database); a missing database is not a passing suite');

const { startRumor2 } = await import('../rumor2/collector.js');
const { Db } = await import('../persistence/db.js');
const { Repository } = await import('../persistence/repository.js');
const { runMigrations } = await import('../persistence/migrate.js');
const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
const { getChildhoodManifest, queryObservations, getOutcomeForObservation } = await import('../memory/childhood.js');
const { childhoodOutcomeRecord, OUTCOME_HORIZONS_MIN } = await import('../rumor2/social-research-outcome.js');
const withDb = async (fn) => {
  const SCHEMA = `s5bd_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
  try {
    assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
    const repo = new Repository(db);
    const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
    await fn({ db, admin, repo, SCHEMA, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
  } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
};
const H = { get: () => null }; const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
const CONFIG = (over = {}) => ({ universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], socialResearch: { catalog: { source: 'WIDEEYE_ASSET_PAIRS', refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 }, localAdmission: { mode: 'CATALOG_BACKED', policyVersion: 1, staticTerms: [] }, xWatch: { mode: 'NOT_CONFIGURED', tickers: [], maxAssets: 25 }, watchPlan: { maxXAssets: 25 } }, ...over });
const historicalOutcomes = ({ symbol, fromTsMs, toTsMs }) => { const m = getChildhoodManifest(); if (!m) return null; return queryObservations({ symbol, fromTs: Math.floor(fromTsMs / 1000), toTs: Math.floor(toTsMs / 1000), limit: 4 }).map((o) => { const out = getOutcomeForObservation(o.id); return out ? childhoodOutcomeRecord(o, out, m) : null; }).filter(Boolean); };
const bootC = ({ checkpointStore, journal, clockMs = T0, config = CONFIG(), snapshot = undefined, notices = [], dataDir = null }) => {
  const dir = dataDir ?? seedDir(); process.env.COBRA_DATA_DIR = dir;
  const clock = { ms: clockMs }; const sockets = []; const snap = { value: snapshot }; const nl = { value: notices };
  const source = snapshot === undefined ? null : { snapshot: () => snap.value, notices: () => nl.value, deepObservation: () => null, population: () => null };
  const c = startRumor2({ log: () => {}, config, fetchImpl: async () => mkRes(304, ''), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000, researchCatalogSource: source, researchStrainer: { enabled: true, historicalOutcomes }, socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; } });
  return { c, clock, sockets, dir, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
};
const hist = async (journal) => (await journal.read()).events;
const Hz = (v) => Object.fromEntries(OUTCOME_HORIZONS_MIN.map((h) => [`${h}m`, typeof v === 'function' ? v(h) : v]));
// seed a lawful, ordered rumor2 journal into the ISOLATED test schema with the exact row shape the production journal
// store writes (stream, event_seq, event_type, event_id, event) — a test-only seam: the store itself rightly refuses to
// append without the writer fence, and this pipeline never takes that fence
const seedJournal = async (admin, events, { after = null } = {}) => { let seq = after ?? Number((await admin.query('SELECT COALESCE(MAX(event_seq), 0) AS n FROM serpent_rumor2_events')).rows[0].n); for (const ev of events) await admin.query(`INSERT INTO serpent_rumor2_events (stream, event_seq, event_type, event_id, event) VALUES ('rumor2', $1, $2, $3, $4)`, [++seq, ev.type, typeof ev.sourceEventId === 'string' ? ev.sourceEventId : null, JSON.stringify(ev)], { write: true }); return seq; };
const snapshotDb = (SCHEMA) => new Db({ url: TEST_URL, schema: SCHEMA }); // the schema option is the TEST seam that scopes 'serpent_' names; production passes none

test('T01 (collector seam, real DB). the repaired outcome seam resolves through the LIVE collector: a durable Bluesky observation opens a research episode, a populated on-disk Childhood archive (the fly.js accessor shape) yields a KNOWN outcome through sourceProfile, an early as-of hides it, and a restart from the same journal reproduces the byte-identical profile', async () => {
  await withDb(async ({ mkStores }) => {
    const stores = mkStores(); const cat = catalogOf(['LINK', 'FRESH42', 'ZQQ7'], T0 - 1000);
    const b = bootC({ ...stores, snapshot: accepted(cat), notices: [notice('ZQQ7', T0 + 20_000)] });
    await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(21, `$ZQQ7 ${SENTINEL_TEXT}`)));
    await b.tick(); const ev = await hist(stores.journal); assert.ok(ev.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE).length >= 1, 'a durable dossier exists');
    const src = ev.find((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type)); const me = src.socialAuthorId;
    const research = b.c.internals.research;
    // no archive yet: unavailable, never invented
    const p0 = research.sourceProfile(me, { asOfTs: T0 + 86_400_000 }); assert.equal(p0.marketLead.episodes.length, 1); assert.equal(p0.marketLead.episodes[0].outcome.state, 'OUTCOME_UNAVAILABLE');
    // a populated archive on disk in the data dir the collector reads through the injected accessor
    const cd = path.join(b.dir, 'childhood'); mkdirSync(cd, { recursive: true }); const obsTs = Math.floor((src.knownAtTs + 90_000) / 1000); const created = T0 + 86_400_000;
    writeFileSync(path.join(cd, 'manifest.json'), JSON.stringify({ schemaVersion: 'childhood-observation-3-b0b', childhoodVersion: 'B0B.2A', archiveCreatedTs: iso(created) }));
    writeFileSync(path.join(cd, 'observations.jsonl'), JSON.stringify({ id: 'obs-z', eventId: 'ev-z', symbol: 'ZQQ7', ts: obsTs, track: '1m', trackRole: 'PARITY_SCOUT', population: 'BASELINE' }) + '\n');
    writeFileSync(path.join(cd, 'outcomes.jsonl'), JSON.stringify({ id: 'obs-z', eventId: 'ev-z', mfe: Hz((h) => h * 0.1), mae: Hz((h) => -h * 0.05), ret1hPct: 1.5, ret4hPct: 2.5, moveAlreadySpentPct: null, moveRemainingPct: 6, abnormalReturn: { vsBtc: null, vsEth: null, vsUniverseMedian: null }, outcomeTags: ['RUN'] }) + '\n');
    const late = research.sourceProfile(me, { asOfTs: created + 1 }); assert.equal(late.marketLead.episodes[0].outcome.state, 'KNOWN', 'the populated archive is KNOWN through the live collector seam'); assert.equal(late.marketLead.episodes[0].outcome.horizons['60m'].mfePct, 6); assert.equal(late.marketLead.marketOutcomeAvailableCount, 1);
    const early = research.sourceProfile(me, { asOfTs: obsTs * 1000 + 300_000 }); assert.equal(early.marketLead.episodes[0].outcome.state, 'NOT_YET_KNOWN', 'hidden before the archive existed');
    assert.equal(b.c.status().research.sourceBehavior.outcomeSeam, 'CHILDHOOD_ARCHIVE_ACCESSOR');
    // restart from the same durable journal (same data dir) => byte-identical profile
    b.c.stop(); const b2 = bootC({ ...mkStores(), snapshot: accepted(cat), dataDir: b.dir }); await b2.tick();
    const again = b2.c.internals.research.sourceProfile(me, { asOfTs: created + 1 }); assert.equal(canonicalJson(again), canonicalJson(late), 'restart agrees byte for byte'); b2.c.stop();
  });
});

test('T02 (real DB). the snapshot export runs inside ONE server-enforced REPEATABLE READ, READ ONLY transaction: a mutation attempted on the export connection is rejected (25006), every page uses the same backend, and no migration, advisory lock, schema object or durable row changes', async () => {
  await withDb(async ({ db, admin, SCHEMA }) => {
    const fx = await journalFixture({ coins: ['ZQQ7', 'FRESH42'], continued: true }); await seedJournal(admin, fx.events);
    const before = async () => ({ rows: Number((await admin.query('SELECT count(*) AS n FROM serpent_rumor2_events')).rows[0].n), tables: Number((await admin.query('SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1', [SCHEMA])).rows[0].n), locks: Number((await admin.query("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n), digest: sha256Hex((await admin.query('SELECT event_seq, event FROM serpent_rumor2_events ORDER BY event_seq')).rows.map((r) => `${r.event_seq}:${r.event}`).join('\n')) });
    const b0 = await before(); const pids = new Set(); const probes = [];
    const sdb = snapshotDb(SCHEMA); assert.equal(await sdb.connect(), true);
    const out = tmp('cobra-5b-out-');
    const r = await runSnapshot({ db: sdb, out: path.join(out, 'snap'), probe: async (q, phase, page) => {
      pids.add((await q('SELECT pg_backend_pid() AS pid')).rows[0].pid); probes.push(`${phase}:${page}`);
      assert.equal((await q('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on'); assert.equal((await q('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
      if (phase === 'AFTER_BEGIN') { await q('SAVEPOINT probe'); let code = null; try { await q(`INSERT INTO serpent_rumor2_events (stream, event_seq, event_type, event_id, event) VALUES ('rumor2', 999999, 'X', 'x', '{}')`); } catch (e) { code = e.code; } assert.equal(code, '25006', 'a write inside the export transaction is refused by the SERVER (read_only_sql_transaction)'); await q('ROLLBACK TO SAVEPOINT probe'); assert.equal((await q("SELECT count(*) AS n FROM serpent_rumor2_events WHERE event_seq = 999999")).rows[0].n, '0'); }
      assert.equal((await q("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n, String(b0.locks), 'no advisory lock is taken');
    } });
    await sdb.end();
    assert.equal(pids.size, 1, 'every page ran on the same backend / transaction'); assert.ok(probes.includes('AFTER_BEGIN:0') && probes.some((p) => p.startsWith('AFTER_PAGE')));
    assert.deepEqual(r.manifest.readOnlyProof, { firstStatement: READ_ONLY_FIRST_STATEMENT, transactionReadOnly: 'on', transactionIsolation: 'repeatable read' });
    assert.equal(r.manifest.origin, 'LIVE_JOURNAL'); assert.equal(r.manifest.stream, 'rumor2'); assert.equal(r.manifest.prefix.upperSeq, fx.events.length); assert.equal(r.manifest.counts.selectedRecords, 5);
    const b1 = await before(); assert.deepEqual(b1, b0, 'no durable row, table or lock changed');
    const back = readSnapshotDir(r.dir); assert.equal(back.records.length, 5); assert.ok(!readFileSync(path.join(r.dir, 'snapshots.jsonl'), 'utf8').includes(SENTINEL_TEXT));
  });
});

test('T03 (real DB). a concurrent append during the export does not change it; more than one page; an empty valid journal exports upper 0; a sequence gap, a malformed payload, a failed read mid-page, an unknown projection version and an unsafe sequence all fail closed with no artifact', async () => {
  await withDb(async ({ admin, SCHEMA }) => {
    const fx = await journalFixture({ coins: ['ZQQ7', 'FRESH42', 'AAA1'] }); await seedJournal(admin, fx.events);
    const out = tmp('cobra-5b-out-');
    // concurrent append between pages (page size 3 => several pages) — the snapshot is bounded by the captured upper sequence and its own MVCC snapshot
    let appended = false; const sdb = snapshotDb(SCHEMA); assert.equal(await sdb.connect(), true);
    const evts = []; const r = await readJournalPrefixReadOnly({ db: sdb, pageSize: 3, onEvent: (seq, e) => evts.push(seq), probe: async (q, phase, page) => { if (phase === 'AFTER_PAGE' && page === 1 && !appended) { appended = true; const later = await journalFixture({ coins: ['ZZZ9'], baseMs: T0 + 3_600_000, shadow: false }); const add = later.events.filter((e) => !fx.events.some((x) => x.sourceEventId === e.sourceEventId)); await seedJournal(admin, add); } } });
    assert.equal(r.upperSeq, fx.events.length); assert.ok(r.pages > 1); assert.deepEqual(evts, fx.events.map((_, i) => i + 1));
    const total = Number((await admin.query('SELECT count(*) AS n FROM serpent_rumor2_events')).rows[0].n); assert.ok(total > fx.events.length, 'the concurrent append landed durably, after the snapshot');
    const r2 = await runSnapshot({ db: sdb, out: path.join(out, 'later') }); assert.equal(r2.manifest.prefix.upperSeq, total, 'a later export sees the appended prefix');
    await sdb.end();
    // corruption injected directly into the isolated schema (never through the journal store)
    const corrupt = async (sql, expectCode, label) => { await admin.query(sql, [], { write: true }); const d = snapshotDb(SCHEMA); assert.equal(await d.connect(), true); const dir = path.join(out, `c-${label}`); assert.equal(await codeOf(async () => runSnapshot({ db: d, out: dir })), expectCode, label); assert.ok(!existsSync(dir), `${label}: no artifact`); await d.end(); };
    await corrupt(`UPDATE serpent_rumor2_events SET event = '{not json' WHERE event_seq = 2`, 'CORRUPT_JOURNAL', 'malformed');
    await corrupt(`DELETE FROM serpent_rumor2_events WHERE event_seq = 2`, 'CORRUPT_JOURNAL', 'gap');
    await admin.query(`DELETE FROM serpent_rumor2_events`, [], { write: true });
    const empty = snapshotDb(SCHEMA); assert.equal(await empty.connect(), true); const e = await runSnapshot({ db: empty, out: path.join(out, 'empty') }); assert.equal(e.manifest.prefix.upperSeq, 0); assert.equal(e.manifest.counts.selectedRecords, 0); assert.equal(e.manifest.prefix.digest.sha256, sha256Hex('')); await empty.end();
    // unknown projection version and an unsafe sequence
    const fx2 = await journalFixture({ coins: ['ZQQ7'], shadow: false }); const d = fx2.dossiers[0];
    const bogus = fx2.events.map((ev) => (ev.type === RESEARCH_DOSSIER_EVENT_TYPE ? { ...ev, dossier: { ...ev.dossier, schemaVersion: 'serpent-research-dossier-3' } } : ev));
    const seq = await seedJournal(admin, bogus, { after: 0 });
    const u = snapshotDb(SCHEMA); assert.equal(await u.connect(), true); assert.equal(await codeOf(async () => runSnapshot({ db: u, out: path.join(out, 'unknown') })), 'UNSUPPORTED_INPUT_VERSION'); await u.end(); void d;
    await admin.query(`UPDATE serpent_rumor2_events SET event_seq = 9007199254740993 WHERE event_seq = $1`, [seq], { write: true });
    const s = snapshotDb(SCHEMA); assert.equal(await s.connect(), true); assert.equal(await codeOf(async () => runSnapshot({ db: s, out: path.join(out, 'unsafe') })), 'CORRUPT_JOURNAL'); await s.end();
    // a failed read mid-page is an EXECUTION failure with no artifact
    await admin.query(`DELETE FROM serpent_rumor2_events`, [], { write: true }); await seedJournal(admin, fx.events, { after: 0 });
    const f = snapshotDb(SCHEMA); assert.equal(await f.connect(), true);
    assert.equal(await codeOf(async () => runSnapshot({ db: f, out: path.join(out, 'mid'), probe: async (q, phase, page) => { if (phase === 'AFTER_PAGE' && page === 1) throw Object.assign(new Error('injected read failure'), { code: '08006' }); } })), 'CONNECTION_FAILURE'); assert.ok(!existsSync(path.join(out, 'mid'))); await f.end();
  });
});

test('T15 (real DB). the CLI snapshot command opens the database ONLY through the explicitly named environment variable, never logs the URL, sanitizes connection / permission failures, and its artifact carries no credential or raw content', async () => {
  await withDb(async ({ admin, SCHEMA }) => {
    const fx = await journalFixture({ coins: ['ZQQ7'] }); await seedJournal(admin, fx.events);
    const out = tmp('cobra-5b-out-'); const seen = []; const logs = [];
    const dbFactory = ({ url }) => { seen.push(url); return new Db({ url, schema: SCHEMA }); };
    const code = await runCli(['snapshot', '--database-url-env', 'SOCIAL_RESEARCH_DATABASE_URL', '--out', path.join(out, 'cli')], { env: { SOCIAL_RESEARCH_DATABASE_URL: TEST_URL, DATABASE_URL: 'postgres://decoy:decoy@decoy/decoy' }, stdout: (s) => logs.push(s), stderr: (s) => logs.push(s), dbFactory });
    assert.equal(code, 0); assert.deepEqual(seen, [TEST_URL], 'exactly the named variable, never DATABASE_URL');
    const text = logs.join(''); assert.ok(!text.includes(TEST_URL) && !text.includes('decoy') && !text.includes('postgres://'), 'the URL is never printed');
    const m = JSON.parse(readFileSync(path.join(out, 'cli', 'snapshot.manifest.json'), 'utf8')); assert.equal(m.origin, 'LIVE_JOURNAL'); const all = readFileSync(path.join(out, 'cli', 'snapshot.manifest.json'), 'utf8') + readFileSync(path.join(out, 'cli', 'snapshots.jsonl'), 'utf8'); assert.ok(!all.includes('postgres://') && !all.includes(SENTINEL_TEXT) && !all.includes(SCHEMA));
    // sanitized failures: an unreachable database and a refused credential never leak host / user / SQL
    const e1 = []; const c1 = await runCli(['snapshot', '--database-url-env', 'X_URL', '--out', path.join(out, 'fail1')], { env: { X_URL: 'postgres://user:secret@127.0.0.1:1/nodb' }, stdout: () => {}, stderr: (s) => e1.push(s), dbFactory: ({ url }) => new Db({ url, retries: 1 }) });
    assert.equal(c1, 5); assert.match(e1.join(''), /CONNECTION_FAILURE/); assert.ok(!e1.join('').includes('secret') && !e1.join('').includes('127.0.0.1')); assert.ok(!existsSync(path.join(out, 'fail1')));
    const e2 = []; const c2 = await runCli(['snapshot', '--database-url-env', 'X_URL', '--out', path.join(out, 'fail2')], { env: { X_URL: TEST_URL }, stdout: () => {}, stderr: (s) => e2.push(s), dbFactory: ({ url }) => { const d = new Db({ url, schema: SCHEMA }); const orig = d.tx.bind(d); d.tx = (fn) => orig(async (q, h) => { await q('SELECT 1'); throw Object.assign(new Error('permission denied for table serpent_rumor2_events'), { code: '42501' }); }); return d; } });
    assert.equal(c2, 5); assert.match(e2.join(''), /PERMISSION_FAILURE/); assert.ok(!e2.join('').includes('permission denied for table'), 'the raw server message is not surfaced');
  });
});
