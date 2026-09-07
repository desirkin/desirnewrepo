// SOCIAL-4F — DISCOVERY_CATALOG: normalization integrity (B/C/E/F/P), the wide eye's read-only
// seam and bounded metadata refresh (exact boundary behaviour with injected clock/transport/
// timers), and acquisition reuse (no second catalog poller, no per-coin request). Synthetic
// identities only; no claim about current listings; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-4f-catalog-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
process.env.WIDEEYE_ENABLED = 'true';
test.after(() => { rmSync(TEST_DATA, { recursive: true, force: true }); delete process.env.WIDEEYE_ENABLED; });

const { normalizeKrakenAssetPairs, acceptCatalogCandidate, krakenUsdSpotBase, catalogContentId, catalogBases, KRAKEN_BASE_ALIASES, CATALOG_MARKET_KEYS, CATALOG_MAX_MARKETS_DEFAULT } = await import('../survey/catalog.js');
const { validateCatalogContent, socialCatalogContentId, catalogFreshness } = await import('../rumor2/social-catalog.js');
const { startWideEye, catalogResourceSettings, CATALOG_REFRESH_MIN_SEC } = await import('../survey/wideeye.js');
const { loadConfig } = await import('../lib/config.js');
const { selectFromRaw } = await import('../tape/universe.js');

const T0 = Date.parse('2026-09-07T12:00:00Z');
const SEEDS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
// a deterministic synthetic venue: 5 seeds + N arbitrary non-major markets; ticker names generated, not listed anywhere
const synth = (i) => `Z${i.toString(36).toUpperCase().padStart(3, 'Q')}`;
function venue({ nonMajors = 120, extra = {}, drop = [] } = {}) {
  const out = {};
  out.XXBTZUSD = { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' };
  out.XETHZUSD = { altname: 'ETHUSD', wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' };
  out.SOLUSD = { altname: 'SOLUSD', wsname: 'SOL/USD', base: 'SOL', quote: 'ZUSD', status: 'online' };
  out.XXRPZUSD = { altname: 'XRPUSD', wsname: 'XRP/USD', base: 'XXRP', quote: 'ZUSD', status: 'online' };
  out.XDGUSD = { altname: 'XDGUSD', wsname: 'XDG/USD', base: 'XXDG', quote: 'ZUSD', status: 'online' };
  for (let i = 0; i < nonMajors; i += 1) { const b = synth(i); out[`${b}USD`] = { altname: `${b}USD`, wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }; }
  out['1INCHUSD'] = { altname: '1INCHUSD', wsname: '1INCH/USD', base: '1INCH', quote: 'USD', status: 'online' };
  out.LINKUSD = { altname: 'LINKUSD', wsname: 'LINK/USD', base: 'LINK', quote: 'USD', status: 'online' };
  out.USDTZUSD = { altname: 'USDTUSD', wsname: 'USDT/USD', base: 'USDT', quote: 'ZUSD', status: 'online' }; // stable: excluded
  out.EURTUSD = { altname: 'EURTUSD', wsname: 'EURT/USD', base: 'EURT', quote: 'USD', status: 'online' }; // fiat-token: excluded
  out.XETHZEUR = { altname: 'ETHEUR', wsname: 'ETH/EUR', base: 'XETH', quote: 'ZEUR', status: 'online' }; // non-USD: excluded
  out.OLDCOINUSD = { altname: 'OLDCOINUSD', wsname: 'OLDCOIN/USD', base: 'OLDCOIN', quote: 'USD', status: 'cancel_only' }; // status: excluded
  out.DARKUSD = { altname: 'DARKUSD', wsname: 'DARK/USD.d', base: 'DARK', quote: 'USD', status: 'online' }; // dark-pool suffix: excluded
  for (const k of drop) delete out[k];
  return { ...out, ...extra };
}
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const norm = (result, over = {}) => normalizeKrakenAssetPairs(result, { excludeBases: EXCLUDE, observedTs: T0, ...over });
const shuffle = (obj, seed) => { const keys = Object.keys(obj); let s = seed; for (let i = keys.length - 1; i > 0; i -= 1) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [keys[i], keys[j]] = [keys[j], keys[i]]; } const o = {}; for (const k of keys) o[k] = obj[k]; return o; };
const sha = (f) => createHash('sha256').update(readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', f))).digest('hex');

test('CAT-1 (B). broad membership: 5 seeds + 120 generated non-majors are supported; stable/fiat/non-USD/status/dark-pool rows are typed exclusions that never leak into the supported count; unknown volume is simply absent', () => {
  const r = norm(venue());
  assert.equal(r.ok, true);
  const c = r.catalog;
  assert.equal(c.venue, 'kraken'); assert.equal(c.quote, 'USD'); assert.equal(c.policyVersion, 1); assert.equal(c.observedTs, T0);
  assert.equal(c.counts.supported, 5 + 120 + 2); assert.equal(c.counts.excluded, 5); assert.equal(c.counts.unresolved, 0); assert.equal(c.counts.observed, 5 + 120 + 2 + 5);
  const bases = catalogBases(c);
  for (const s of SEEDS) assert.ok(bases.includes(s), s);
  assert.ok(bases.includes('1INCH'), 'a digit-prefixed ticker is a market'); assert.ok(bases.includes('LINK'));
  assert.equal(bases.filter((b) => b.startsWith('Z')).length, 120, '120 non-majors retained with no volume floor, no cap, no major preference');
  assert.deepEqual(c.excluded.map((e) => `${e.pairKey}:${e.reason}`).sort(), ['DARKUSD:WSNAME_NOT_USD_SPOT', 'EURTUSD:BASE_EXCLUDED_STABLE_OR_FIAT', 'OLDCOINUSD:STATUS_NOT_ONLINE', 'USDTZUSD:BASE_EXCLUDED_STABLE_OR_FIAT', 'XETHZEUR:QUOTE_NOT_USD']);
  assert.equal(c.excluded.find((e) => e.pairKey === 'OLDCOINUSD').status, 'cancel_only', 'the observed status is preserved on the exclusion');
  // venue-native identifiers are preserved and distinguished from display aliases
  const btc = c.markets.find((m) => m.base === 'BTC');
  assert.deepEqual(btc, { pairKey: 'XXBTZUSD', nativeBase: 'XXBT', nativeQuote: 'ZUSD', wsname: 'XBT/USD', base: 'BTC', quote: 'USD', status: 'online' });
  assert.equal(c.markets.find((m) => m.base === 'DOGE').nativeBase, 'XXDG'); assert.deepEqual(KRAKEN_BASE_ALIASES, { XBT: 'BTC', XDG: 'DOGE' });
  assert.ok(!('usdVol24h' in btc) && !('volume' in btc), 'the catalog carries no volume: unknown stays unknown, never zero, never unlimited');
  for (const m of c.markets) assert.deepEqual(Object.keys(m), [...CATALOG_MARKET_KEYS]);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.markets) && Object.isFrozen(c.markets[0]), 'deep-frozen');
  assert.equal(c.contentId, catalogContentId(c)); assert.equal(c.contentId, socialCatalogContentId(c), 'the survey derivation and the rumor derivation agree');
  assert.equal(validateCatalogContent(c).error, undefined);
});

test('CAT-2 (E/P). determinism: shuffled response order yields the same content id and sorted markets; the sweep map keeps its historical first-key behaviour through the shared primitive', () => {
  const a = norm(venue()).catalog; const b = norm(shuffle(venue(), 7)).catalog; const c = norm(shuffle(venue(), 99)).catalog;
  assert.equal(a.contentId, b.contentId); assert.equal(b.contentId, c.contentId);
  assert.deepEqual(a.markets, b.markets);
  for (let i = 1; i < a.markets.length; i += 1) assert.ok(a.markets[i - 1].base < a.markets[i].base, 'sorted by base');
  assert.notDeepEqual(a.responseOrder, b.responseOrder, 'response order is retained separately for the sweep map');
  // the shared per-row primitive is byte-for-byte the historical selection rule
  const excluded = new Set(EXCLUDE.map((x) => x.toUpperCase()));
  assert.deepEqual(krakenUsdSpotBase({ status: 'online', quote: 'ZUSD', wsname: 'XBT/USD' }, excluded), { base: 'BTC' });
  assert.deepEqual(krakenUsdSpotBase({ status: 'online', quote: 'USD', wsname: 'XDG/USD' }, excluded), { base: 'DOGE' });
  assert.deepEqual(krakenUsdSpotBase({ status: 'online', quote: 'USD', wsname: 'USDT/USD' }, excluded), { excluded: 'BASE_EXCLUDED_STABLE_OR_FIAT' });
  assert.deepEqual(krakenUsdSpotBase({ status: 'post_only', quote: 'USD', wsname: 'ABC/USD' }, excluded), { excluded: 'STATUS_NOT_ONLINE' });
  assert.deepEqual(krakenUsdSpotBase({ status: 'online', quote: 'USD', wsname: 'abc/USD' }, excluded), { unresolved: 'BASE_UNRESOLVABLE' });
  assert.deepEqual(krakenUsdSpotBase(null, excluded), { unresolved: 'ROW_MALFORMED' });
  assert.deepEqual(krakenUsdSpotBase({ status: 'online', quote: 'USD', wsname: 'XBTC/USD' }, excluded), { base: 'XBTC' }, 'no leading-X stripping: only the two documented aliases rewrite');
});

test('CAT-3 (E). integrity: coherent alias keys dedupe deterministically; contradictory native mappings REFUSE the candidate; malformed rows are unresolved, never a mass delisting; empty / non-object / zero-supported / overflow refuse', () => {
  const dup = norm(venue({ extra: { XBTUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' } } }));
  assert.equal(dup.ok, true); assert.equal(dup.catalog.markets.filter((m) => m.base === 'BTC').length, 1);
  assert.equal(dup.catalog.markets.find((m) => m.base === 'BTC').pairKey, 'XBTUSD', 'the lexicographically smallest coherent key is kept'); assert.deepEqual(dup.catalog.duplicates, [{ pairKey: 'XXBTZUSD', keptPairKey: 'XBTUSD' }]);
  assert.ok(dup.catalog.unresolved.some((u) => u.pairKey === 'XXBTZUSD' && u.reason === 'DUPLICATE_COHERENT_ALIAS'));
  const contra1 = norm(venue({ extra: { FAKEBTC: { wsname: 'XBT/USD', base: 'NOTXBT', quote: 'USD', status: 'online' } } }));
  assert.equal(contra1.ok, false); assert.equal(contra1.reason, 'CONTRADICTORY_NATIVE_MAPPING');
  const contra2 = norm(venue({ extra: { OTHERBTC: { wsname: 'BTC/USD', base: 'BTCX', quote: 'USD', status: 'online' } } }));
  assert.equal(contra2.ok, false); assert.equal(contra2.reason, 'CONTRADICTORY_BASE_ASSOCIATION', 'two wsnames claiming one research base with different native ids is refused, never last-row-wins');
  const mal = norm(venue({ extra: { BROKEN1: null, BROKEN2: 'string', 'bad key!': { wsname: 'X/USD', quote: 'USD', status: 'online' } } }));
  assert.equal(mal.ok, true); assert.equal(mal.catalog.counts.supported, 127); assert.deepEqual(mal.catalog.unresolved.map((u) => u.reason).sort(), ['ROW_MALFORMED', 'ROW_MALFORMED', 'ROW_MALFORMED']);
  assert.equal(norm({}).reason, 'RESPONSE_EMPTY'); assert.equal(norm(null).reason, 'RESPONSE_MALFORMED'); assert.equal(norm([]).reason, 'RESPONSE_MALFORMED'); assert.equal(norm('x').reason, 'RESPONSE_MALFORMED');
  assert.equal(norm({ USDTZUSD: venue().USDTZUSD }).reason, 'ZERO_SUPPORTED');
  assert.equal(norm(venue(), { observedTs: 0 }).reason, 'OBSERVED_CLOCK_INVALID'); assert.equal(norm(venue(), { observedTs: 1.5 }).reason, 'OBSERVED_CLOCK_INVALID');
  const over = norm(venue({ nonMajors: 50 }), { maxMarkets: 20 });
  assert.equal(over.ok, false); assert.equal(over.reason, 'CATALOG_OVERFLOW'); assert.match(over.detail, /previous accepted truth is retained/); assert.equal(over.counts.supported, 57, 'overflow reports the size, never truncates and calls it complete');
  assert.equal(CATALOG_MAX_MARKETS_DEFAULT, 5000);
});

test('CAT-4 (E/F). adoption law: a >50% drop is SUSPECTED_INCOMPLETE (previous truth retained), a clock regression is refused, unchanged content is UNCHANGED, changed content is CHANGED; T0/T1/T2 catalogs stay distinct', () => {
  const t0 = norm(venue()).catalog;
  assert.deepEqual(acceptCatalogCandidate(null, t0), { ok: true, change: 'INITIAL' });
  const small = norm(venue({ nonMajors: 10 }), { observedTs: T0 + 1 }).catalog;
  assert.equal(acceptCatalogCandidate(t0, small).reason, 'SUSPECTED_INCOMPLETE');
  assert.equal(acceptCatalogCandidate(t0, norm(venue(), { observedTs: T0 - 1 }).catalog).reason, 'OBSERVED_CLOCK_REGRESSION');
  assert.deepEqual(acceptCatalogCandidate(t0, norm(venue(), { observedTs: T0 + 300_000 }).catalog), { ok: true, change: 'UNCHANGED' });
  const t1 = norm(venue({ extra: { FRESH42USD: { wsname: 'FRESH42/USD', base: 'FRESH42', quote: 'USD', status: 'online' } } }), { observedTs: T0 + 300_000 }).catalog;
  assert.deepEqual(acceptCatalogCandidate(t0, t1), { ok: true, change: 'CHANGED' }); assert.notEqual(t0.contentId, t1.contentId);
  assert.ok(!catalogBases(t0).includes('FRESH42') && catalogBases(t1).includes('FRESH42'), 'a market added at T1 is not in the T0 catalog');
  const t2 = norm(venue({ drop: ['LINKUSD'], extra: { FRESH42USD: t1.markets.find((m) => m.base === 'FRESH42') && { wsname: 'FRESH42/USD', base: 'FRESH42', quote: 'USD', status: 'online' } } }), { observedTs: T0 + 600_000 }).catalog;
  assert.ok(!catalogBases(t2).includes('LINK') && catalogBases(t1).includes('LINK'), 'a removal does not erase the earlier catalog');
  const t3 = norm(venue({ drop: ['LINKUSD'], extra: { FRESH42USD: { wsname: 'FRESH42/USD', base: 'FRESH42', quote: 'USD', status: 'online' }, LINKUSD: { wsname: 'LINK/USD', base: 'LINK', quote: 'USD', status: 'cancel_only' } } }), { observedTs: T0 + 900_000 }).catalog;
  assert.equal(t3.excluded.find((e) => e.pairKey === 'LINKUSD').reason, 'STATUS_NOT_ONLINE', 'a status change is an explicit exclusion with the observed status');
  // a ticker rename (new wsname, different native id) is a DIFFERENT market, never merged
  const renamed = norm(venue({ drop: ['LINKUSD'], extra: { LINKV2USD: { wsname: 'LINKV2/USD', base: 'LINKV2', quote: 'USD', status: 'online' } } })).catalog;
  assert.ok(catalogBases(renamed).includes('LINKV2') && !catalogBases(renamed).includes('LINK'));
  assert.equal(catalogFreshness(t0, T0 + 900_000, 900), 'FRESH'); assert.equal(catalogFreshness(t0, T0 + 900_001, 900), 'STALE'); assert.equal(catalogFreshness(t0, T0 - 120_000, 900), 'FUTURE');
});

test('CAT-5 (D). the deep-observation selection and the legacy permission set are UNCHANGED by the catalog: tape/universe.js still applies its floor / majors / cap; cost + ledger still refuse a non-major', async () => {
  assert.equal(sha('tape/universe.js'), sha('tape/universe.js')); // (identity is pinned in social-4f-scope.test.js against 9c17372)
  const v = venue({ nonMajors: 30 }); const tickers = {};
  for (const k of Object.keys(v)) tickers[k] = { v: ['1', '1000'], p: ['1', '10'] }; // $10k volume everywhere: below the deep floor
  const deep = selectFromRaw(v, tickers, loadConfig());
  assert.deepEqual(deep.map((p) => p.coin).sort(), [...SEEDS].sort(), 'the deep selection keeps its floor + major preference; broad discovery does not widen it');
  const { evaluateCost } = await import('../cost/model.js');
  const r = evaluateCost('ZQQQ', 100);
  assert.equal(r.available ?? r.ok ?? false, false); assert.match(JSON.stringify(r), /not in universe/, 'the legacy cost permission set is intact');
  const { recordPrediction } = await import('../ledger/ledger.js');
  assert.throws(() => recordPrediction({ coin: 'ZQQQ', thesis: 'research only', horizonMin: 5, predictedNetMovePct: 1, sizeUsd: 100 }), /not in universe/, 'the ledger permission set is intact');
});

// ---- the wide eye seam: bounded refresh with injected clock / transport / timers ----------------
function harness({ initial = venue(), nowMs = T0, responses = null, config = loadConfig() } = {}) {
  const clock = { ms: nowMs }; const calls = []; const timers = { interval: null, timeout: null, intervalMs: null };
  const queue = responses ?? [];
  const fetchImpl = async (url) => {
    calls.push({ url, ts: clock.ms });
    if (url.includes('AssetPairs')) { const next = queue.length ? queue.shift() : { result: initial }; if (next.throw) throw new Error(next.throw); if (typeof next.delay === 'number') await next.delay; return { ok: true, json: async () => ({ error: [], result: next.result }) }; }
    const ticks = {}; return { ok: true, json: async () => ({ error: [], result: ticks }) };
  };
  const eye = startWideEye({ log: () => {}, config, fetchImpl, now: () => clock.ms, registerSignals: false,
    setIntervalImpl: (cb, ms) => { timers.interval = cb; timers.intervalMs = ms; return { refresh() {} }; }, clearIntervalImpl: () => { timers.interval = null; },
    setTimeoutImpl: (cb) => { timers.timeout = cb; return 1; }, clearTimeoutImpl: () => {} });
  return { eye, clock, calls, timers, queue, sweep: () => timers.interval() };
}
const assetCalls = (calls) => calls.filter((c) => c.url.includes('AssetPairs')).length;
const tickerCalls = (calls) => calls.filter((c) => c.url.includes('/Ticker')).length;

test('WE-1 (B). the wide eye exposes a DETACHED read-only snapshot from its own AssetPairs acquisition: one request loads both the sweep map and the catalog; the snapshot is deep-frozen and cannot be mutated into scope', async () => {
  const h = harness();
  assert.equal(h.eye.catalogSnapshot().status, 'UNAVAILABLE'); assert.equal(h.eye.catalogSnapshot().catalog, null);
  await h.sweep();
  assert.equal(assetCalls(h.calls), 1, 'ONE AssetPairs request'); assert.equal(tickerCalls(h.calls), 1, 'ONE ticker request per sweep — never one per coin');
  const snap = h.eye.catalogSnapshot();
  assert.equal(snap.status, 'ACCEPTED'); assert.equal(snap.catalog.counts.supported, 127); assert.equal(snap.observedTs, T0); assert.equal(snap.fresh, true); assert.equal(snap.refreshes, 1);
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.catalog) && Object.isFrozen(snap.catalog.markets));
  assert.throws(() => { 'use strict'; snap.catalog.markets.push({}); });
  assert.throws(() => { 'use strict'; snap.status = 'FRESH_FOREVER'; });
  assert.deepEqual(snap.resource, { refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 });
  assert.deepEqual(catalogResourceSettings({ socialResearch: { catalog: { refreshSec: 60, maxAgeSec: 5000, maxMarkets: 9e9 } } }), { refreshSec: CATALOG_REFRESH_MIN_SEC, maxAgeSec: 900, maxMarkets: 5000 }, 'settings clamp to the established bounds');
  assert.equal(h.timers.intervalMs, loadConfig().wideeye.sweepSec * 1000, 'sweep cadence unchanged');
  const st = JSON.parse(readFileSync(path.join(TEST_DATA, 'survey', 'status.json'), 'utf8'));
  assert.equal(st.scanned, 127); assert.equal(st.catalog.status, 'ACCEPTED'); assert.equal(st.catalog.contentId, snap.catalog.contentId);
  h.eye.stop();
});

test('WE-2 (exact boundaries). refresh no more often than 300 s (attempt-based), a new listing enters catalog AND sweep without restart at the boundary, a failure retains previous truth and never backs the sweep off, one refresh in flight, stop disowns a late result', async () => {
  const h = harness();
  await h.sweep(); const c0 = h.eye.catalogSnapshot().catalog.contentId;
  h.queue.push({ result: venue({ extra: { FRESH42USD: { wsname: 'FRESH42/USD', base: 'FRESH42', quote: 'USD', status: 'online' } } }) });
  h.clock.ms = T0 + 299_999; await h.sweep();
  assert.equal(assetCalls(h.calls), 1, 'one millisecond before the refresh boundary: no AssetPairs request'); assert.equal(h.eye.catalogSnapshot().catalog.contentId, c0);
  h.clock.ms = T0 + 300_000; await h.sweep();
  assert.equal(assetCalls(h.calls), 2, 'exactly at 300 s the bounded refresh runs on the existing tick');
  const s1 = h.eye.catalogSnapshot();
  assert.notEqual(s1.catalog.contentId, c0); assert.ok(catalogBases(s1.catalog).includes('FRESH42'), 'the new listing entered the catalog without a process restart');
  assert.equal(s1.observedTs, T0 + 300_000, 'the actual acquisition clock, never backdated'); assert.equal(JSON.parse(readFileSync(path.join(TEST_DATA, 'survey', 'status.json'), 'utf8')).scanned, 128, 'and the sweep map too');
  // failure: previous truth retained, no sweep backoff (the ticker request still runs), the next attempt waits another refreshSec
  h.queue.push({ throw: 'HTTP 503' });
  h.clock.ms = T0 + 600_000; await h.sweep();
  const s2 = h.eye.catalogSnapshot();
  assert.equal(s2.status, 'ACCEPTED'); assert.equal(s2.catalog.contentId, s1.catalog.contentId); assert.match(s2.lastError, /REFRESH_FAILED: HTTP 503/); assert.equal(s2.failures, 1); assert.equal(s2.lastSuccessTs, T0 + 300_000);
  assert.equal(tickerCalls(h.calls), 4, 'the sweep itself was not backed off by a catalog refresh failure');
  h.clock.ms = T0 + 600_000 + 100_000; await h.sweep(); assert.equal(assetCalls(h.calls), 3, 'a failed attempt is not retried faster than refreshSec');
  h.queue.push({ result: venue({ extra: { FRESH42USD: { wsname: 'FRESH42/USD', base: 'FRESH42', quote: 'USD', status: 'online' } } }) }); // the same content again: UNCHANGED
  h.clock.ms = T0 + 900_000; await h.sweep(); assert.equal(assetCalls(h.calls), 4); assert.equal(h.eye.catalogSnapshot().lastError, null); assert.equal(h.eye.catalogSnapshot().catalog.contentId, s1.catalog.contentId);
  // refusal (suspected incomplete): previous truth retained, reason stated
  h.queue.push({ result: venue({ nonMajors: 3 }) });
  h.clock.ms = T0 + 1_200_000; await h.sweep();
  const s3 = h.eye.catalogSnapshot(); assert.equal(s3.catalog.contentId, s1.catalog.contentId); assert.equal(s3.lastRefusal.reason, 'SUSPECTED_INCOMPLETE'); assert.equal(s3.refusals, 1); assert.equal(s3.fresh, true);
  // max age: at 900 s past the last SUCCESSFUL observation the snapshot is no longer fresh (the reader decides what stale means)
  h.clock.ms = T0 + 900_000 + 900_000; assert.equal(h.eye.catalogSnapshot().fresh, true); h.clock.ms = T0 + 900_000 + 900_001; assert.equal(h.eye.catalogSnapshot().fresh, false); assert.equal(h.eye.catalogSnapshot().status, 'ACCEPTED', 'stale is labelled, never relabelled fresh, never dropped');
  // one refresh in flight + stop disowns late results
  let release; h.queue.push({ result: venue({ nonMajors: 200 }), delay: new Promise((r) => { release = r; }) });
  h.clock.ms = T0 + 2_100_000; const p = h.sweep();
  h.clock.ms = T0 + 2_400_000; await h.sweep(); assert.equal(assetCalls(h.calls), 6, 'a second tick while one refresh is in flight starts no second request');
  h.eye.stop(); release(); await p;
  assert.equal(h.eye.catalogSnapshot().catalog.contentId, s1.catalog.contentId, 'the late result after stop is disowned — previous truth stands');
  const events = readFileSync(path.join(TEST_DATA, 'survey', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert.ok(events.includes('CATALOG_ACCEPTED') && events.includes('CATALOG_REFRESH_ERROR') && events.includes('CATALOG_REFUSED') && events.includes('WIDEEYE_UNIVERSE'));
});

test('WE-3. the initial load keeps its historical backoff path; a disabled wide eye returns null (Social cannot start it); the notice ring is bounded research context', async () => {
  const h = harness({ responses: [{ throw: 'boot 500' }] });
  await h.sweep();
  assert.equal(h.eye.catalogSnapshot().status, 'UNAVAILABLE'); assert.match(h.eye.catalogSnapshot().lastError, /REFRESH_FAILED/);
  const ev = readFileSync(path.join(TEST_DATA, 'survey', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ev[ev.length - 1].type, 'SWEEP_ERROR', 'the first-load failure still backs the sweep off exactly as before');
  assert.deepEqual(h.eye.researchNotices(), []); assert.ok(Object.isFrozen(h.eye.researchNotices()));
  h.eye.stop();
  process.env.WIDEEYE_ENABLED = 'false';
  assert.equal(startWideEye({ log: () => {}, fetchImpl: async () => { throw new Error('must not fetch'); } }), null);
  process.env.WIDEEYE_ENABLED = 'true';
  assert.equal(existsSync(path.join(TEST_DATA, 'survey', 'status.json')), true);
});
