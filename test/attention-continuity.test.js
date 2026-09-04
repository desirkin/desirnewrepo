// ATTENTION-1A drills — durable attention continuity. The cockpit must
// remember what Serpent actually noticed for the FULL declared window:
// high-rate unrelated Memory traffic must never crowd a valid attention
// event out of Tier-4 display continuity. Purpose-specific bounded reads
// replace the old "newest 120 records of everything" global tail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-att1a-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { attentionContinuityMeaning } = await import('../memory/attention.js');
const { MemoryStore } = await import('../memory/store.js');
const { MemoryView } = await import('../persistence/memory-view.js');
const { attentionSnapshot } = await import('../ui/attention-view.js');
const { envelope } = await import('../memory/schema.js');
const { Db } = await import('../persistence/db.js');
const { Repository } = await import('../persistence/repository.js');
const { runMigrations } = await import('../persistence/migrate.js');

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// deterministic clock: a fixed "now" on a whole second
const NOW = 1_900_000_000_000; // ms
const HOUR = 3_600_000;
const WINDOW_MS = 2 * HOUR;
const sec = (ms) => Math.floor(ms / 1000);
const ISO = new Date(NOW).toISOString();

const prov = (src, tsSec) => ({ source: src, sourceTs: tsSec, availableTs: tsSec, retrievedTs: ISO, kind: 'live', form: 'raw' });
const ripple = (symbol, tsMs, extra = {}) =>
  envelope({
    sourceModule: 'WIDEEYE', eventType: 'WIDEEYE_RIPPLE', ts: sec(tsMs), symbol,
    families: ['MARKET_PRICE', 'MARKET_VOLUME'], observationState: 'KNOWN',
    payload: { verdict: 'RIPPLE', zVol: 4.2, zRet: 1.1 },
    dataAvailability: { zVol: 'KNOWN', zRet: 'KNOWN' },
    provenance: prov('survey/events.jsonl (live wide eye)', sec(tsMs)),
    ...extra,
  });
const nomination = (symbol, tsMs) =>
  envelope({
    sourceModule: 'RUMINT', eventType: 'RUMOR_OBSERVATION', ts: sec(tsMs), symbol,
    families: ['RUMOR', 'SOCIAL_ATTENTION'], observationState: 'KNOWN',
    payload: { type: 'RUMINT_NOMINATION', detail: { z: 3.4 } },
    dataAvailability: { chatterVelocity: 'KNOWN' },
    provenance: prov('rumint/events.jsonl (stocktwits chatter poller)', sec(tsMs)),
  });
const rumintPoll = (symbol, tsMs) =>
  envelope({
    sourceModule: 'RUMINT', eventType: 'RUMOR_OBSERVATION', ts: sec(tsMs), symbol,
    families: ['RUMOR', 'SOCIAL_ATTENTION'], observationState: 'KNOWN',
    payload: { type: 'RUMINT_POLL', detail: { messages: 12 } },
    dataAvailability: { chatterVelocity: 'KNOWN' },
    provenance: prov('rumint/events.jsonl (stocktwits chatter poller)', sec(tsMs)),
  });
const tapeSnap = (symbol, tsMs, salt = 0) =>
  envelope({
    sourceModule: 'TAPE', eventType: 'MARKET_SNAPSHOT', ts: sec(tsMs), symbol,
    families: ['MARKET_PRICE'], observationState: 'KNOWN',
    payload: { mid: 100 + salt }, dataAvailability: { mid: 'KNOWN' },
    provenance: prov('tape snapshots.jsonl', sec(tsMs)), identity: `tape-${salt}`,
  });
const wideeyeStatus = (tsMs, type = 'WIDEEYE_STATUS', symbol = null) =>
  envelope({
    sourceModule: 'WIDEEYE', eventType: type, ts: sec(tsMs), symbol,
    families: ['MARKET_PRICE'], observationState: 'KNOWN',
    payload: { type, detail: { scanned: 500 } }, dataAvailability: { zVol: 'UNAVAILABLE' },
    provenance: prov('survey/events.jsonl (live wide eye)', sec(tsMs)),
  });
const microObs = (symbol, tsMs) =>
  envelope({
    sourceModule: 'MICROSTRUCTURE', eventType: 'MICROSTRUCTURE_OBSERVATION', ts: sec(tsMs), symbol,
    families: ['ORDER_FLOW', 'LIQUIDITY'], observationState: 'KNOWN',
    payload: { emitReason: 'PERIODIC' }, dataAvailability: { flow: 'KNOWN' },
    provenance: prov('micro/observations.jsonl', sec(tsMs)),
  });

const freshStore = () => new MemoryStore({ dir: mkdtempSync(path.join(tmpdir(), 'cobra-att1a-mem-')) });
const localView = (store) => new MemoryView({ localStore: store, persistence: () => null });
// the same purpose-specific ask the production defaultMemorySource makes
const sourceFor = (view) => async (now) =>
  (await view.getRecentAttention({ sinceTs: sec(now - WINDOW_MS), untilTs: sec(now) + 60, limit: 16 })).records;
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-att1a-dir-'));
  for (const sub of ['state', 'survey', 'rumint']) mkdirSync(path.join(d, sub), { recursive: true });
  process.env.COBRA_DATA_DIR = d;
  return d;
}
const restoreDir = (d) => {
  rmSync(d, { recursive: true, force: true });
  process.env.COBRA_DATA_DIR = TEST_DATA;
};

test('0. the shared meaning gate admits ONLY genuine attention meanings', () => {
  assert.equal(attentionContinuityMeaning(ripple('KERNEL', NOW)), 'WIDEEYE_RIPPLE');
  assert.equal(attentionContinuityMeaning(nomination('TAO', NOW)), 'RUMINT_NOMINATION');
  assert.equal(attentionContinuityMeaning(rumintPoll('TAO', NOW)), null, 'an ordinary poll is not attention');
  assert.equal(attentionContinuityMeaning(tapeSnap('BTC', NOW)), null);
  assert.equal(attentionContinuityMeaning(wideeyeStatus(NOW)), null);
  assert.equal(attentionContinuityMeaning(wideeyeStatus(NOW, 'WIDEEYE_MISSED', 'SOL')), null, 'MISSED is not noticed prey');
  assert.equal(attentionContinuityMeaning(microObs('SOL', NOW)), null, 'MICRO existing does not make UI prey');
  assert.equal(attentionContinuityMeaning(ripple('KERNEL', NOW, { observationState: 'DEGRADED' })), null, 'non-KNOWN refused');
  assert.equal(attentionContinuityMeaning({ ...ripple('KERNEL', NOW), symbol: null }), null, 'no symbol, no attention');
  assert.equal(attentionContinuityMeaning(null), null);
});

test('14. REPRODUCTION: KERNEL ripple 90m old survives 600 unrelated newer records', async () => {
  const store = freshStore();
  const kernel = ripple('KERNEL', NOW - 90 * 60_000);
  assert.equal(store.append(kernel).accepted, true);
  // far more unrelated newer traffic than the old global-120 tail — and
  // more than the 500-record in-RAM cache, so nothing but the projection
  // can still be holding the qualifying event
  for (let i = 0; i < 600; i++) {
    const r = store.append(tapeSnap(['BTC', 'ETH', 'SOL'][i % 3], NOW - 80 * 60_000 + i * 1000, i));
    assert.equal(r.accepted, true);
  }
  const got = store.getRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16 });
  assert.equal(got.length, 1);
  assert.equal(got[0].symbol, 'KERNEL');
  assert.equal(got[0].id, kernel.id, 'the exact remembered event, not a reconstruction');
  // and the full display path still shows it as Tier-4 remembered attention
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: sourceFor(localView(store)) });
  const k = snap.orbit.find((e) => e.symbol === 'KERNEL');
  assert.ok(k, 'KERNEL still discoverable — unrelated record count does not matter');
  assert.equal(k.tier, 4);
  assert.equal(k.fallback, false);
  assert.equal(k.reason, 'remembered Wide Eye ripple');
  assert.equal(k.ts, kernel.ts * 1000, 'event age preserved, never relabeled as current');
  restoreDir(d);
});

test('15. EXPIRY: inside included, exact 2h cutoff INCLUDED (documented), outside excluded', async () => {
  for (const [ageMs, expected, label] of [
    [WINDOW_MS - 1000, true, 'just inside'],
    [WINDOW_MS, true, 'exact cutoff (inclusive rule)'],
    [WINDOW_MS + 1000, false, 'just outside'],
  ]) {
    const store = freshStore();
    store.append(ripple('KERNEL', NOW - ageMs));
    const d = seedDir();
    const snap = await attentionSnapshot({ now: NOW, memorySource: sourceFor(localView(store)) });
    assert.equal(snap.orbit.some((e) => e.symbol === 'KERNEL'), expected, label);
    restoreDir(d);
  }
});

test('16. FILTERING: only legitimate attention meanings enter Tier 4', async () => {
  const store = freshStore();
  const t = NOW - 30 * 60_000;
  store.append(ripple('KERNEL', t));
  store.append(wideeyeStatus(t + 1000));
  store.append(wideeyeStatus(t + 2000, 'WIDEEYE_MISSED', 'MISSY'));
  store.append(rumintPoll('POLLY', t + 3000));
  store.append(nomination('TAO', t + 4000));
  store.append(tapeSnap('SNAPY', t + 5000, 1));
  store.append(microObs('MICRO', t + 6000));
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: sourceFor(localView(store)) });
  const tier4 = snap.orbit.filter((e) => e.tier === 4).map((e) => e.symbol).sort();
  assert.deepEqual(tier4, ['KERNEL', 'TAO']);
  for (const bad of ['MISSY', 'POLLY', 'SNAPY', 'MICRO']) {
    assert.ok(!snap.orbit.some((e) => e.symbol === bad && !e.fallback), `${bad} never becomes prey`);
  }
  restoreDir(d);
});

test('17. NEWEST-PER-SYMBOL: three SUI ripples yield ONE orbit entry with the newest ts', async () => {
  const store = freshStore();
  const t1 = ripple('SUI', NOW - 100 * 60_000);
  const t2 = ripple('SUI', NOW - 80 * 60_000);
  const t3 = ripple('SUI', NOW - 55 * 60_000);
  for (const e of [t1, t3, t2]) assert.equal(store.append(e).accepted, true); // out of order on purpose
  const got = store.getRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16 });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, t3.id, 'newest qualifying record wins');
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: sourceFor(localView(store)) });
  assert.equal(snap.orbit.filter((e) => e.symbol === 'SUI').length, 1, 'no duplicate orbit coin');
  assert.equal(snap.orbit.find((e) => e.symbol === 'SUI').ts, t3.ts * 1000);
  restoreDir(d);
});

test('18. PRECEDENCE: stalk > fresh Wide Eye > fresh RUMINT > remembered > majors; remembered never overrides fresher', async () => {
  const store = freshStore();
  store.append(ripple('KERNEL', NOW - 60 * 60_000)); // remembered only
  store.append(nomination('SUI', NOW - 5 * 60_000)); // remembered — but SUI is LIVE-stalked
  store.append(ripple('PEPE', NOW - 40 * 60_000)); // remembered — but PEPE has a FRESH live ripple
  const d = seedDir();
  const iso = (ms) => new Date(ms).toISOString();
  writeFileSync(path.join(d, 'state', 'stalking.json'), JSON.stringify({
    SUI: { since: iso(NOW - 60_000), refreshed: iso(NOW - 60_000), cause: 'RUMINT NOMINATION z=3.5', expiresMs: NOW + 600_000 },
  }));
  writeFileSync(path.join(d, 'survey', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 2 * 60_000), type: 'RIPPLE', symbol: 'PEPE', zVol: 4 }) + '\n');
  writeFileSync(path.join(d, 'rumint', 'events.jsonl'),
    JSON.stringify({ ts: iso(NOW - 60_000), type: 'RUMINT_NOMINATION', symbol: 'TAO', z: 3.2 }) + '\n');
  const snap = await attentionSnapshot({ now: NOW, memorySource: sourceFor(localView(store)) });
  const tierOf = (s) => snap.orbit.find((e) => e.symbol === s)?.tier;
  assert.equal(tierOf('SUI'), 1, 'live stalk outranks its own remembered nomination');
  assert.equal(tierOf('PEPE'), 2, 'fresh live ripple outranks its own remembered ripple');
  assert.equal(tierOf('TAO'), 3);
  assert.equal(tierOf('KERNEL'), 4, 'remembered only where nothing fresher exists');
  assert.equal(snap.focus.symbol, 'SUI');
  const order = snap.orbit.map((e) => e.tier);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'orbit is tier-ordered');
  assert.ok(snap.orbit.filter((e) => e.fallback).every((e) => e.tier === 5), 'majors last, marked fallback');
  restoreDir(d);
});

test('19. HIGH TRAFFIC: result and projection stay bounded under heavy unrelated + wide attention load', () => {
  const store = freshStore();
  // 80 distinct qualifying symbols (beyond the 64-symbol projection bound)
  for (let i = 0; i < 80; i++) store.append(ripple(`C${i}`, NOW - 100 * 60_000 + i * 60_000));
  // plus heavy unrelated traffic
  for (let i = 0; i < 400; i++) store.append(tapeSnap('BTC', NOW - 50 * 60_000 + i * 1000, i));
  assert.ok(store.attentionProjection.size <= 64, `projection bounded (${store.attentionProjection.size})`);
  const got = store.getRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16 });
  assert.equal(got.length, 16, 'bounded result, newest distinct symbols');
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].ts >= got[i].ts, 'newest first');
  // eviction dropped the STALEST symbols, not the newest
  assert.equal(got[0].symbol, 'C79');
});

test('21. LOCAL PROJECTION: populates on recovery, updates on newer arrival, refuses corrupt, read-time freshness', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-att1a-rec-'));
  const oldRipple = ripple('KERNEL', NOW - 90 * 60_000);
  const lines = [
    JSON.stringify(oldRipple),
    JSON.stringify(tapeSnap('BTC', NOW - 60 * 60_000, 7)),
    '{ torn json', // JSON_PARSE_CORRUPT — quarantined, never admitted
    JSON.stringify({ id: 'mem-0000000000000000000000000000000000000000', eventType: 'WIDEEYE_RIPPLE', symbol: 'FAKE', observationState: 'KNOWN', ts: sec(NOW) }), // SCHEMA_INVALID
  ];
  writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  const store = new MemoryStore({ dir });
  const q = () => store.getRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16 });
  assert.deepEqual(q().map((e) => e.symbol), ['KERNEL'], 'recovery populated the projection; corrupt/invalid never admitted');
  assert.ok(!store.attentionProjection.has('FAKE'));
  // a newer qualifying memory for the same symbol replaces the older one
  const newer = nomination('KERNEL', NOW - 20 * 60_000);
  assert.equal(store.append(newer).accepted, true);
  assert.equal(q()[0].id, newer.id, 'projection tracks the newest qualifying record');
  // freshness is applied at READ time with the supplied clock
  const later = store.getRecentAttention({ sinceTs: sec(NOW + 4 * HOUR - WINDOW_MS), untilTs: sec(NOW + 4 * HOUR), limit: 16 });
  assert.deepEqual(later, [], 'the same projection answers honestly for a later clock');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------- durable PostgreSQL integration (own schema) ----------------
if (!TEST_URL) {
  test('20. ATTENTION-1A postgres integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const SCHEMA = `attn1a_${Date.now().toString(36)}`;
  const db = new Db({ url: TEST_URL, schema: SCHEMA });
  const repo = new Repository(db);

  test.after(async () => {
    try {
      await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    } catch {
      // schema may already be gone
    }
    await db.end();
  });

  test('20. POSTGRES: time-bounded, meaning-filtered, newest-per-symbol, bounded, adjacency-independent', async () => {
    assert.equal(await db.connect(), true);
    await runMigrations(db);
    const put = async (env) => assert.equal((await repo.insertMemoryEvent(env)).durable, true);
    // qualifying events, deliberately interleaved with the flood (no
    // insertion adjacency): KERNEL 90m old, SUI older+newer, one nomination
    await put(ripple('SUI', NOW - 100 * 60_000));
    for (let i = 0; i < 70; i++) await put(tapeSnap('BTC', NOW - 85 * 60_000 + i * 1000, i));
    await put(ripple('KERNEL', NOW - 90 * 60_000));
    for (let i = 0; i < 40; i++) await put(rumintPoll('DOGE', NOW - 70 * 60_000 + i * 1000));
    await put(ripple('SUI', NOW - 45 * 60_000)); // the newest SUI truth
    for (let i = 0; i < 20; i++) await put(wideeyeStatus(NOW - 30 * 60_000 + i * 1000));
    await put(nomination('TAO', NOW - 25 * 60_000));
    await put(ripple('OLDY', NOW - 3 * HOUR)); // outside the window
    await put(ripple('DEGY', NOW - 20 * 60_000, { observationState: 'DEGRADED' })); // non-KNOWN
    const got = await repo.memoryRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 8 });
    const syms = got.map((e) => e.symbol);
    assert.deepEqual([...syms].sort(), ['KERNEL', 'SUI', 'TAO'], `exactly the qualifying symbols (got ${syms})`);
    assert.equal(got.find((e) => e.symbol === 'SUI').ts, sec(NOW - 45 * 60_000), 'newest SUI record, not the first inserted');
    for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].ts >= got[i].ts, 'newest first');
    // >120 unrelated rows arrived after KERNEL — and it is still discoverable
    assert.ok(syms.includes('KERNEL'), 'unrelated volume does not matter');
    // bound honored even when qualifying symbols exceed it
    for (let i = 0; i < 12; i++) await put(ripple(`Q${i}`, NOW - 10 * 60_000 + i * 1000));
    const bounded = await repo.memoryRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 8 });
    assert.equal(bounded.length, 8, 'bounded number of distinct symbols');
  });

  test('20b. MEMORYVIEW over both stores: one copy per id, durable authority, fresher pending-local wins per symbol', async () => {
    const store = freshStore();
    const shared = ripple('KERNEL', NOW - 90 * 60_000);
    await repo.insertMemoryEvent(shared); // durable copy
    store.append(shared); // AND the same id locally
    const pendingLocal = nomination('KERNEL', NOW - 15 * 60_000); // newer, not yet durable
    store.append(pendingLocal);
    const view = new MemoryView({
      localStore: store,
      persistence: () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) }),
    });
    const got = await view.getRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16 });
    assert.equal(got.meta.mode, 'DURABLE');
    assert.equal(got.records.filter((e) => e.id === shared.id).length, 0, 'superseded per symbol'); // KERNEL served once, by its newest record
    const kernel = got.records.filter((e) => e.symbol === 'KERNEL');
    assert.equal(kernel.length, 1, 'no double copy for a symbol present in both stores');
    assert.equal(kernel[0].id, pendingLocal.id, 'a fresher pending-local nomination outranks the older durable ripple');
    assert.ok(got.meta.pendingLocal >= 1);
  });
}

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
