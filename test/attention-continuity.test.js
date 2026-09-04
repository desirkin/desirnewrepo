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

const prov = (src, tsSec, retrievedIso = ISO) => ({ source: src, sourceTs: tsSec, availableTs: tsSec, retrievedTs: retrievedIso, kind: 'live', form: 'raw' });
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

// stores get the deterministic projection clock (defaults to the fixture NOW;
// pass a supplier to advance it mid-test)
const freshStore = (now = () => NOW) => new MemoryStore({ dir: mkdtempSync(path.join(tmpdir(), 'cobra-att1a-mem-')), now });
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
  const store = new MemoryStore({ dir, now: () => NOW });
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

// ---------------- ATTENTION-1B: exact qualifying winner closeout ----------------

test('1B-3. FUTURE SUPPRESSION: a future record cannot erase valid in-window history', async () => {
  const store = freshStore();
  const valid = ripple('KERNEL', NOW - 90 * 60_000); // A: valid, in-window
  // B: qualifying but future relative to the READER's clock (> now + 60s) —
  // written by a skewed clock whose own provenance is self-consistent, so it
  // passes the canonical validator and reaches the projection
  const future = ripple('KERNEL', NOW + 61_000, {
    provenance: prov('survey/events.jsonl (live wide eye)', sec(NOW + 61_000), new Date(NOW + 61_000).toISOString()),
  });
  assert.equal(store.append(valid).accepted, true);
  assert.equal(store.append(future).accepted, true);
  const got = store.getRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16 });
  assert.equal(got.length, 1, 'future record rejected from the current window');
  assert.equal(got[0].id, valid.id, 'the 90-minute record SURVIVES — true identity preserved');
  assert.equal(got[0].ts, valid.ts, 'true timestamp preserved');
  // and through the full display path KERNEL remains Tier 4
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: sourceFor(localView(store)) });
  const k = snap.orbit.find((e) => e.symbol === 'KERNEL');
  assert.equal(k?.tier, 4, 'KERNEL remains remembered attention');
  assert.equal(k?.ts, valid.ts * 1000);
  restoreDir(d);
  // move the supplied clock forward: the future record becomes the newest VALID
  const LATER = NOW + 5 * 60_000;
  const later = store.getRecentAttention({ sinceTs: sec(LATER - WINDOW_MS), untilTs: sec(LATER) + 60, limit: 16 });
  assert.equal(later.length, 1);
  assert.equal(later[0].id, future.id, 'once inside the window it may win — newest valid record');
});

test('1B-8. DETERMINISTIC TIE BREAK: equal timestamps resolve by greater canonical id, arrival-independent', async () => {
  const t = NOW - 30 * 60_000;
  const a = ripple('TIEBRK', t, { identity: 'tie-a' });
  const b = ripple('TIEBRK', t, { identity: 'tie-b' });
  assert.notEqual(a.id, b.id);
  const expected = a.id > b.id ? a : b;
  for (const order of [[a, b], [b, a]]) { // both arrival orders
    const store = freshStore();
    for (const e of order) assert.equal(store.append(e).accepted, true);
    const got = store.getRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16 });
    assert.equal(got.length, 1);
    assert.equal(got[0].id, expected.id, 'greater canonical id wins the tie, whatever the arrival order');
  }
});

test('1B-9. BOUNDS: per-symbol history is hard bounded and keeps the newest entries', () => {
  const store = freshStore();
  const ages = [110, 100, 90, 70, 50, 30]; // minutes
  const envs = ages.map((m) => ripple('KERNEL', NOW - m * 60_000));
  for (const e of envs) assert.equal(store.append(e).accepted, true);
  const { hist } = store.attentionProjection.get('KERNEL');
  assert.equal(hist.length, 4, 'history depth hard bounded');
  assert.deepEqual(hist.map((e) => e.id), envs.slice(2).reverse().map((e) => e.id), 'the 4 NEWEST kept, winner-ordered');
  // and the reproduction bound still holds: unrelated traffic adds nothing
  for (let i = 0; i < 200; i++) store.append(tapeSnap('BTC', NOW - 10 * 60_000 + i * 1000, i));
  assert.equal(store.attentionProjection.get('KERNEL').hist.length, 4);
  assert.ok(store.attentionProjection.size <= 64);
});

// ---------------- ATTENTION-1C: future-poisoning closeout ----------------

// a qualifying future ripple written by a skewed clock whose own provenance
// is self-consistent (passes the canonical validator; future only relative
// to the reader/projection clock)
const futureRipple = (symbol, tsMs, extra = {}) =>
  ripple(symbol, tsMs, {
    provenance: prov('survey/events.jsonl (live wide eye)', sec(tsMs), new Date(tsMs).toISOString()),
    ...extra,
  });
const winQ = (store, now = NOW) =>
  store.getRecentAttention({ sinceTs: sec(now - WINDOW_MS), untilTs: sec(now) + 60, limit: 16 });

test('1C-1. FOUR FUTURE RECORDS cannot evict the valid 90-minute record; clock advance frees them', async () => {
  const store = freshStore();
  const valid = ripple('KERNEL', NOW - 90 * 60_000);
  assert.equal(store.append(valid).accepted, true);
  const futures = [61, 62, 63, 64].map((s) => futureRipple('KERNEL', NOW + s * 1000));
  for (const f of futures) assert.equal(store.append(f).accepted, true);
  // at the current supplied clock: all four futures unavailable, truth stands
  const got = winQ(store);
  assert.equal(got.length, 1, 'all future records unavailable to current attention');
  assert.equal(got[0].id, valid.id, 'the 90-minute record still exists — original identity');
  assert.equal(got[0].ts, valid.ts, 'original timestamp');
  const d = seedDir();
  const snap = await attentionSnapshot({ now: NOW, memorySource: sourceFor(localView(store)) });
  const k = snap.orbit.find((e) => e.symbol === 'KERNEL');
  assert.equal(k?.tier, 4, 'KERNEL remains Tier 4');
  assert.equal(k?.ts, valid.ts * 1000);
  restoreDir(d);
  // advance the supplied clock: the retained future records become eligible
  const later = winQ(store, NOW + 5 * 60_000);
  assert.equal(later.length, 1);
  assert.equal(later[0].id, futures[3].id, 'the newest eligible record wins after its time arrives');
});

test('1C-2. FUTURE-LANE OVERFLOW stays bounded and cannot touch present history', () => {
  const store = freshStore();
  const valid = ripple('KERNEL', NOW - 90 * 60_000);
  store.append(valid);
  // exceed the future retention bound for one symbol
  const futures = [61, 62, 63, 64, 65, 66].map((s) => futureRipple('KERNEL', NOW + s * 1000));
  for (const f of futures) assert.equal(store.append(f).accepted, true);
  const lanes = store.attentionProjection.get('KERNEL');
  assert.equal(lanes.fut.length, 4, 'future storage remains hard bounded');
  assert.deepEqual(lanes.fut.map((e) => e.id), [futures[5], futures[4], futures[3], futures[2]].map((e) => e.id),
    'the lane keeps its NEWEST future records');
  assert.deepEqual(lanes.hist.map((e) => e.id), [valid.id], 'overflow never evicted present history');
  assert.equal(winQ(store)[0].id, valid.id, 'current KERNEL memory remains available');
  // advance the clock past every future record
  const later = winQ(store, NOW + 10 * 60_000);
  assert.equal(later[0].id, futures[5].id, 'newest RETAINED future record wins');
  // the two discarded futures (+61s, +62s) do not magically reappear
  const all = new Set([...lanes.hist, ...lanes.fut].map((e) => e.id));
  assert.ok(!all.has(futures[0].id) && !all.has(futures[1].id));
});

test('1C-3. LANE TRANSITION: matured future evidence graduates and the winner rule stays deterministic', () => {
  let clock = NOW;
  const store = freshStore(() => clock);
  store.append(ripple('KERNEL', NOW - 90 * 60_000));
  // two future records with EQUAL timestamps, different ids
  const t = NOW + 90_000;
  const fa = futureRipple('KERNEL', t, { identity: '1c-tie-a' });
  const fb = futureRipple('KERNEL', t, { identity: '1c-tie-b' });
  const expected = fa.id > fb.id ? fa : fb;
  store.append(fa);
  store.append(fb);
  assert.equal(store.attentionProjection.get('KERNEL').fut.length, 2);
  // their time arrives; the next indexed record graduates them into history
  clock = NOW + 10 * 60_000;
  store.append(nomination('OTHER', clock - 60_000)); // unrelated symbol still triggers no KERNEL touch
  assert.equal(winQ(store, clock)[0].id, expected.id, 'eligible tie resolves by greater canonical id');
  store.append(nomination('KERNEL', NOW - 30 * 60_000)); // touching KERNEL migrates matured futures
  const lanes = store.attentionProjection.get('KERNEL');
  assert.equal(lanes.fut.length, 0, 'matured evidence left the future lane');
  assert.ok(lanes.hist.some((e) => e.id === expected.id), 'and now competes as history');
  assert.equal(winQ(store, clock)[0].id, expected.id, 'same deterministic winner after the lane transition');
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

  // the 1B drills share one schema with the earlier inserts, so they query
  // with the production overfetch bound (16 distinct symbols) — still small
  const attnQ = (over = {}) =>
    repo.memoryRecentAttention({ sinceTs: sec(NOW - WINDOW_MS), untilTs: sec(NOW) + 60, limit: 16, ...over });

  test('1B-6. SQL FALSE POSITIVE: a prefilter-matching non-nomination can neither become prey nor suppress the real one', async () => {
    const genuine = nomination('FPOS', NOW - 60 * 60_000);
    // NEWER ordinary poll whose canonical text contains the literal
    // "type":"RUMINT_NOMINATION" in a nested object — passes the SQL LIKE
    // prefilter, fails the exact payload.type meaning
    const impostor = envelope({
      sourceModule: 'RUMINT', eventType: 'RUMOR_OBSERVATION', ts: sec(NOW - 30 * 60_000), symbol: 'FPOS',
      families: ['RUMOR', 'SOCIAL_ATTENTION'], observationState: 'KNOWN',
      payload: { type: 'RUMINT_POLL', detail: { quoted: { type: 'RUMINT_NOMINATION' } } },
      dataAvailability: { chatterVelocity: 'KNOWN' },
      provenance: prov('rumint/events.jsonl (stocktwits chatter poller)', sec(NOW - 30 * 60_000)),
    });
    assert.ok(JSON.stringify(impostor).includes('"type":"RUMINT_NOMINATION"'), 'fixture really trips the prefilter');
    assert.equal(attentionContinuityMeaning(impostor), null, 'and really is not a nomination');
    assert.equal((await repo.insertMemoryEvent(genuine)).durable, true);
    assert.equal((await repo.insertMemoryEvent(impostor)).durable, true);
    const got = await attnQ();
    const fpos = got.filter((e) => e.symbol === 'FPOS');
    assert.equal(fpos.length, 1);
    assert.equal(fpos[0].id, genuine.id, 'the OLDER genuine nomination is still returned');
    assert.ok(!got.some((e) => e.id === impostor.id), 'the impostor never becomes prey');
  });

  test('1B-7. INVALID NEWEST ROW: corrupt newest durable evidence cannot erase older valid truth', async () => {
    const older = nomination('CORRY', NOW - 70 * 60_000);
    const newest = ripple('CORRY', NOW - 20 * 60_000);
    assert.equal((await repo.insertMemoryEvent(older)).durable, true);
    assert.equal((await repo.insertMemoryEvent(newest)).durable, true);
    // corrupt the NEWEST row on disk (test-only, own schema): digest now fails
    await db.query(`UPDATE serpent_memory_events SET envelope = envelope || ' ' WHERE id = $1`, [newest.id], { write: true });
    const before = repo.invalidDurableRecords;
    const got = await attnQ();
    const corry = got.filter((e) => e.symbol === 'CORRY');
    assert.equal(corry.length, 1);
    assert.equal(corry[0].id, older.id, 'older valid qualifying record remains eligible');
    assert.ok(repo.invalidDurableRecords > before, 'the corrupt row was withheld, not silently skipped');
  });

  test('1B-8b. POSTGRES TIE BREAK: equal timestamps resolve by greater canonical id', async () => {
    const t = NOW - 40 * 60_000;
    const a = ripple('TIEDB', t, { identity: 'db-tie-a' });
    const b = ripple('TIEDB', t, { identity: 'db-tie-b' });
    assert.equal((await repo.insertMemoryEvent(a)).durable, true);
    assert.equal((await repo.insertMemoryEvent(b)).durable, true);
    const got = await attnQ();
    const tied = got.filter((e) => e.symbol === 'TIEDB');
    assert.equal(tied.length, 1);
    assert.equal(tied[0].id, a.id > b.id ? a.id : b.id, 'same rule as the local path');
  });

  test('1B-9b. POSTGRES BOUNDS: candidate depth and distinct-symbol limit stay enforced', async () => {
    // many qualifying rows for one symbol: result still ONE winner for it
    for (let i = 0; i < 10; i++) {
      assert.equal((await repo.insertMemoryEvent(ripple('DEEP', NOW - (24 - i) * 60_000))).durable, true);
    }
    // ATTENTION-1C: a NON-JSON corrupt row that matches the text prefilter
    // must fail dark inside the guarded exact-type inspection — excluded
    // from the nomination branch, never crashing the whole attention query
    const husk = nomination('HUSK', NOW - 12 * 60_000);
    assert.equal((await repo.insertMemoryEvent(husk)).durable, true);
    await db.query(`UPDATE serpent_memory_events SET envelope = '{"type":"RUMINT_NOMINATION" torn' WHERE id = $1`, [husk.id], { write: true });
    const got = await attnQ();
    assert.ok(!got.some((e) => e.symbol === 'HUSK'), 'the corrupt row is simply withheld');
    const deep = got.filter((e) => e.symbol === 'DEEP');
    assert.equal(deep.length, 1);
    assert.equal(deep[0].ts, sec(NOW - 15 * 60_000), 'newest DEEP row wins');
    assert.ok(got.length <= 16, 'distinct-symbol bound honored');
    // and a tight limit is still honored exactly
    assert.equal((await attnQ({ limit: 3 })).length, 3);
  });
}

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
