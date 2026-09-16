import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { catalogContentId } from '../survey/catalog.js';
import { BROAD_KRAKEN_DEFAULTS, readBroadKrakenLatest, startBroadKraken, validateBroadKrakenCatalog } from '../market-lab/broad-kraken.js';

const T = Date.UTC(2026, 8, 13, 12, 0, 20);
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = () => mkdtempSync(path.join(tmpdir(), 'cobra-broad-'));
const market = (base, nativeBase = base, wsBase = base) => ({ pairKey: `${nativeBase}ZUSD`, nativeBase, nativeQuote: 'ZUSD', wsname: `${wsBase}/USD`, base, quote: 'USD', status: 'online' });
const catalog = (rows, observedTs = T) => {
  const c = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs, counts: { observed: rows.length, supported: rows.length, excluded: 0, unresolved: 0 }, markets: rows, excluded: [], unresolved: [], duplicates: [], aliasesApplied: { XBT: 'BTC', XDG: 'DOGE' }, excludeBases: [], responseOrder: rows.map((m) => m.pairKey), source: 'test' };
  c.contentId = catalogContentId(c); return c;
};

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(text) { this.sent.push(JSON.parse(text)); }
  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.({}); }
}

const manualTimers = () => {
  const queue = []; const intervals = new Set();
  const later = (fn) => { const token = { fn, cleared: false }; queue.push(token); return token; };
  return {
    setTimeout: (fn) => later(fn), clearTimeout: (token) => { if (token) token.cleared = true; },
    setInterval: (fn) => { const token = { fn, cleared: false, unref() {} }; intervals.add(token); return token; },
    clearInterval: (token) => { if (token) token.cleared = true; intervals.delete(token); },
    tickIntervals() { for (const token of [...intervals]) if (!token.cleared) token.fn(); },
    runAll(limit = 20_000) { let count = 0; while (queue.length) { const token = queue.shift(); if (!token.cleared) token.fn(); if (++count > limit) throw new Error('manual timer runaway'); } },
  };
};

const ack = (socket, request, symbol = null, success = true) => socket.emit({ method: 'subscribe', req_id: request.req_id, success, ...(success ? {} : { error: 'unsupported' }), result: { channel: request.params.channel, ...(symbol ? { symbol } : {}) } });
const instrumentSnapshot = (socket, pairs) => socket.emit({ channel: 'instrument', type: 'snapshot', data: { assets: [], pairs } });
const ticker = (symbol, overrides = {}) => ({ symbol, ask: 101, ask_qty: null, bid: 99, bid_qty: 2, change: 1, change_pct: 1, high: 105, last: 100, low: 90, volume: 123.5, vwap: 98.2, timestamp: new Date(T).toISOString(), ...overrides });
const ohlc = (symbol, startTs, overrides = {}) => ({ symbol, open: 100, high: 102, low: 99, close: 101, vwap: 100.5, trades: 4, volume: 8.25, interval_begin: new Date(startTs).toISOString(), interval: 1, ...overrides });

test('catalog validation is atomic and never slices the accepted population', () => {
  const c = catalog([market('BTC', 'XXBT', 'XBT'), market('DOGE', 'XXDG', 'XDG'), market('ABC')]);
  assert.deepEqual(validateBroadKrakenCatalog(c), { ok: true, count: 3 });
  assert.equal(validateBroadKrakenCatalog({ ...c, markets: [...c.markets, c.markets[0]] }).ok, false);
  assert.equal(validateBroadKrakenCatalog(c, { maxMarkets: 2 }).reason, 'CATALOG_OVERFLOW');
});

test('broad collector waits for a missing startup catalog then adopts a later accepted full population', async () => {
  FakeSocket.instances.length = 0;
  const dir = temp(); const timers = manualTimers(); let available = null;
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: available, fresh: available !== null }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => T, timers });
  try {
    assert.equal(FakeSocket.instances.length, 0, 'no guessed universe or socket before catalog');
    available = catalog([market('AAA'), market('BBB')]);
    timers.tickIntervals(); timers.runAll();
    assert.equal(FakeSocket.instances.length, 1);
    assert.equal(handle.status().catalog.markets, 2);
    timers.tickIntervals();
    assert.equal(FakeSocket.instances.length, 1, 'no duplicate socket from subsequent catalog polling');
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('full accepted population is classified without a named/top-N cap and every mapped symbol reaches both bounded channel requests', async () => {
  FakeSocket.instances.length = 0; const dir = temp(); const timers = manualTimers();
  const supported = Array.from({ length: 612 }, (_, i) => market(`C${String(i).padStart(3, '0')}`));
  const c = catalog([...supported, market('MISSING')]);
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => T, timers, limits: { subscribeChunkSize: 25, catalogPollMs: 60_000 } });
  try {
    const socket = FakeSocket.instances.at(-1); socket.open(); const instrumentRequest = socket.sent.find((r) => r.params.channel === 'instrument'); ack(socket, instrumentRequest);
    instrumentSnapshot(socket, [
      ...supported.map((m) => ({ symbol: `${m.base}/USD`, base: m.base, quote: 'USD', status: 'online' })),
      { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', status: 'online' },
    ]);
    timers.runAll();
    const requests = socket.sent.filter((r) => ['ticker', 'ohlc'].includes(r.params.channel));
    assert.ok(requests.every((r) => r.params.symbol.length > 0 && r.params.symbol.length <= 25));
    for (const channel of ['ticker', 'ohlc']) {
      const channelRequests = requests.filter((r) => r.params.channel === channel);
      assert.equal(channelRequests.length, Math.ceil(supported.length / 25));
      assert.deepEqual(new Set(channelRequests.flatMap((r) => r.params.symbol)), new Set(supported.map((m) => `${m.base}/USD`)));
      for (const request of channelRequests) for (const symbol of request.params.symbol) ack(socket, request, symbol);
    }
    socket.emit({ channel: 'ticker', type: 'snapshot', data: supported.map((m) => ticker(`${m.base}/USD`)) });
    socket.emit({ channel: 'ohlc', type: 'snapshot', data: supported.map((m) => ohlc(`${m.base}/USD`, T - 20_000)) });
    timers.runAll(); await handle.drain();
    let status = handle.status();
    assert.equal(status.freshness.freshTicker, 0); assert.equal(status.freshness.snapshotBaselineTicker, 612);
    let persisted = readBroadKrakenLatest({ dataDir: dir, now: T });
    assert.equal(persisted.markets.filter((m) => m.ticker.state === 'IDLE_SNAPSHOT_BASELINE_PERSISTED').length, 612);
    socket.emit({ channel: 'ticker', type: 'update', data: supported.map((m) => ticker(`${m.base}/USD`)) });
    timers.runAll(); await handle.drain(); status = handle.status();
    assert.equal(status.catalog.markets, 613); assert.equal(status.catalog.attempted, 613); assert.equal(status.perMarket.length, 613);
    assert.equal(status.instrument.mapped, 612); assert.equal(status.instrument.unsupported, 1);
    assert.equal(status.subscription.ackedTicker, 612); assert.equal(status.subscription.ackedOhlc, 612);
    assert.equal(status.freshness.freshTicker, 612); assert.equal(status.freshness.freshCandle, 612);
    assert.equal(status.perMarket.find((m) => m.canonicalCoin === 'MISSING').channels.ticker, 'UNSUPPORTED');
    const latestFile = path.join(dir, 'broad-kraken', 'latest.json');
    assert.ok(statSync(latestFile).size < BROAD_KRAKEN_DEFAULTS.maxLatestBytes);
    persisted = readBroadKrakenLatest({ dataDir: dir, now: T });
    assert.equal(persisted.markets.length, 613);
    assert.equal(persisted.markets.filter((m) => m.ticker.state === 'FRESH_PERSISTED').length, 612);
    assert.equal(persisted.markets.filter((m) => m.candle.state === 'PROVISIONAL_FRESH_PERSISTED').length, 612);
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('instrument mapping gates all subscriptions; unsupported stays in denominator; raw ticker and current/closed candle values land on disk without fake zeros', async () => {
  FakeSocket.instances.length = 0; const dir = temp(); let now = T;
  const c = catalog([market('BTC', 'XXBT', 'XBT'), market('DOGE', 'XXDG', 'XDG'), market('ABC')]);
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => now, limits: { subscribeChunkSize: 2, subscribePaceMs: 1, latestSnapshotMs: 1, catalogPollMs: 60_000 } });
  try {
    const socket = FakeSocket.instances[0]; assert.ok(socket); socket.open();
    const instrumentRequest = socket.sent.find((r) => r.params.channel === 'instrument'); assert.ok(instrumentRequest); ack(socket, instrumentRequest);
    instrumentSnapshot(socket, [
      { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' },
      { symbol: 'DOGE/USD', base: 'DOGE', quote: 'USD', status: 'online' },
      { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', status: 'online' },
    ]);
    await sleep(20);
    const subscriptions = socket.sent.filter((r) => r.method === 'subscribe' && ['ticker', 'ohlc'].includes(r.params.channel));
    assert.equal(subscriptions.length, 2, 'two mapped symbols fit one bounded chunk per channel');
    assert.deepEqual(new Set(subscriptions.flatMap((r) => r.params.symbol)), new Set(['BTC/USD', 'DOGE/USD']));
    for (const request of subscriptions) for (const symbol of request.params.symbol) ack(socket, request, symbol);
    socket.emit({ channel: 'ticker', type: 'snapshot', data: [ticker('BTC/USD')] });
    socket.emit({ channel: 'ohlc', type: 'snapshot', data: [ohlc('BTC/USD', T - 20_000)] });
    socket.emit({ channel: 'heartbeat' });
    await sleep(5); await handle.drain();
    let latest = handle.latest('BTC');
    assert.equal(latest.ticker.lastPrice, 100);
    assert.equal(latest.ticker.volume24hBase, 123.5);
    assert.equal(latest.ticker.state, 'IDLE_SNAPSHOT_BASELINE', 'a snapshot exposes price/volume but cannot prove a recent trade');
    assert.equal(latest.candle.provisional.volumeBase, 8.25);
    assert.equal(latest.candle.closed, null, 'heartbeat/wall clock/other-channel traffic cannot close a candle');
    socket.emit({ channel: 'ticker', type: 'update', data: [ticker('BTC/USD')] });
    await sleep(5); await handle.drain();
    assert.equal(handle.latest('BTC').ticker.state, 'FRESH', 'a trade-triggered update establishes freshness');
    now = T + 45_000;
    socket.emit({ channel: 'ohlc', type: 'update', data: [ohlc('BTC/USD', T + 40_000, { close: 103, high: 104, volume: 2 })] });
    await sleep(5); await handle.drain();
    latest = handle.latest('BTC');
    assert.equal(latest.candle.provisional.close, 103);
    assert.equal(latest.candle.closed.close, 101);
    assert.equal(latest.candle.closed.finality, 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL');
    assert.equal(latest.candle.learningEligible, false);
    const status = handle.status();
    assert.equal(status.catalog.markets, 3); assert.equal(status.catalog.attempted, 3); assert.equal(status.perMarket.length, 3);
    assert.equal(status.instrument.mapped, 2); assert.equal(status.instrument.unsupported, 1);
    assert.equal(status.perMarket.find((m) => m.canonicalCoin === 'ABC').channels.ticker, 'UNSUPPORTED');
    assert.equal(status.state, 'DEGRADED', 'unsupported catalog member prevents a false all-market ACTIVE claim');
    assert.equal(status.freshness.freshCandle, 1, 'the current real provisional candle is a fresh detector input');
    assert.equal(status.recording.error, null); assert.ok(status.recording.latestSnapshotWrites >= 1);
    const disk = readBroadKrakenLatest({ dataDir: dir, now });
    assert.equal(disk.historyIncluded, false, 'the live reader never scans the rolling journal by default');
    assert.equal(disk.epochId, 'KRAKEN_SPOT:ws-v2:1');
    assert.equal(disk.catalog.contentId, c.contentId);
    assert.equal(disk.markets.find((m) => m.canonicalCoin === 'BTC').ticker.record.payload.volume24hBase, 123.5);
    assert.equal(disk.markets.find((m) => m.canonicalCoin === 'BTC').candle.provisional.payload.volumeBase, 2);
    assert.equal(disk.source, 'LOCAL_FILESYSTEM_NOT_REPUBLISH_DURABLE');
    writeFileSync(path.join(dir, 'broad-kraken', 'events-999999.jsonl'), 'not-json\n');
    const bounded = readBroadKrakenLatest({ dataDir: dir, now });
    assert.equal(bounded.malformed, 0, 'journal corruption cannot block or contaminate the default bounded latest read');
    assert.equal(bounded.markets.find((m) => m.canonicalCoin === 'BTC').ticker.state, 'FRESH_PERSISTED');
    const historical = readBroadKrakenLatest({ dataDir: dir, now, includeJournal: true });
    assert.ok(historical.malformed >= 1, 'journal parsing is explicit opt-in');
    const latestFile = path.join(dir, 'broad-kraken', 'latest.json');
    const snapshot = JSON.parse(readFileSync(latestFile, 'utf8'));
    writeFileSync(latestFile, `${JSON.stringify({ ...snapshot, currentEpoch: 'KRAKEN_SPOT:ws-v2:999' })}\n`);
    const staleEpoch = readBroadKrakenLatest({ dataDir: dir, now });
    assert.equal(staleEpoch.markets.find((m) => m.canonicalCoin === 'BTC').ticker.state, 'EPOCH_STALE_PERSISTED');
    snapshot.records.BTC.market.canonicalCoin = 'DOGE';
    writeFileSync(latestFile, `${JSON.stringify(snapshot)}\n`);
    const identityMismatch = readBroadKrakenLatest({ dataDir: dir, now });
    assert.ok(identityMismatch.malformed >= 1);
    assert.equal(identityMismatch.markets.some((m) => m.canonicalCoin === 'BTC'), false, 'a mismatched snapshot key/market identity is rejected');
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('stale catalog never opens a socket; malformed instrument snapshot never maps or subscribes', async () => {
  FakeSocket.instances.length = 0; const dir = temp();
  const old = catalog([market('BTC', 'XXBT', 'XBT')], T - BROAD_KRAKEN_DEFAULTS.maxCatalogAgeMs - 1);
  const waiting = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: old, fresh: false }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => T, limits: { catalogPollMs: 60_000 } });
  assert.equal(FakeSocket.instances.length, 0); assert.equal(waiting.status().catalog.state, 'WAITING'); await waiting.stop();
  const c = catalog([market('BTC', 'XXBT', 'XBT')]);
  const bad = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => T, limits: { catalogPollMs: 60_000 } });
  try {
    const socket = FakeSocket.instances.at(-1); socket.open(); const request = socket.sent.find((r) => r.params.channel === 'instrument'); ack(socket, request); instrumentSnapshot(socket, []); await sleep();
    assert.equal(bad.status().instrument.state, 'FAILED');
    assert.equal(socket.sent.filter((r) => ['ticker', 'ohlc'].includes(r.params.channel)).length, 0);
  } finally { await bad.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a missing native interval remains a gap without revoking the current OHLC subscription', async () => {
  FakeSocket.instances.length = 0; const dir = temp(); const timers = manualTimers(); let now = T;
  const c = catalog([market('BTC', 'XXBT', 'XBT')]);
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => now, timers });
  try {
    const socket = FakeSocket.instances.at(-1); socket.open();
    ack(socket, socket.sent.find((r) => r.params.channel === 'instrument'));
    instrumentSnapshot(socket, [{ symbol: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' }]);
    timers.runAll();
    for (const request of socket.sent.filter((r) => ['ticker', 'ohlc'].includes(r.params.channel))) ack(socket, request, 'BTC/USD');
    socket.emit({ channel: 'ohlc', type: 'snapshot', data: [ohlc('BTC/USD', T - 200_000), ohlc('BTC/USD', T - 20_000)] });
    timers.runAll(); await handle.drain();
    const latest = readBroadKrakenLatest({ dataDir: dir, now }); const row = latest.markets[0];
    assert.equal(latest.malformed, 0);
    assert.equal(handle.status().subscription.ackedOhlc, 1);
    assert.equal(row.subscription.ohlc.recordType, 'SUBSCRIPTION');
    assert.equal(row.subscription.ohlc.payload.state, 'SUBSCRIBED');
    assert.equal(row.candle.state, 'PROVISIONAL_FRESH_PERSISTED');
    assert.equal(row.intervalGap.payload.reason, 'NO_NATIVE_INTERVAL');
    assert.equal(row.intervalGap.payload.sinceTs, T - 140_000);
    assert.equal(row.intervalGap.payload.untilTs, T - 20_000);
    assert.equal(row.candle.provisional.payload.learningEligible, false);
    const historical = readBroadKrakenLatest({ dataDir: dir, now, includeJournal: true });
    assert.equal(historical.markets[0].candle.state, 'PROVISIONAL_FRESH_PERSISTED');
    assert.equal(historical.markets[0].intervalGap.recordId, row.intervalGap.recordId);
    const journal = readdirSync(path.join(dir, 'broad-kraken')).filter((name) => /^events-\d+\.jsonl$/.test(name)).flatMap((name) => readFileSync(path.join(dir, 'broad-kraken', name), 'utf8').trim().split('\n').map(JSON.parse));
    assert.equal(journal.filter((r) => r.recordType === 'GAP' && r.payload.reason === 'NO_NATIVE_INTERVAL').length, 1);
    assert.equal(journal.filter((r) => r.recordType === 'OHLC').length, 1, 'only the observed prior close is journaled, never invented zero bars');
    now += 190_000;
    assert.equal(readBroadKrakenLatest({ dataDir: dir, now }).markets[0].candle.state, 'PROVISIONAL_STALE_PERSISTED');
    socket.close(); await handle.drain();
    const disconnected = readBroadKrakenLatest({ dataDir: dir, now }).markets[0];
    assert.equal(disconnected.candle.state, 'RETAINED_ONLY_PERSISTED', 'a real transport gap still revokes current-channel readiness');
    assert.equal(disconnected.subscription.ohlc.recordType, 'GAP');
    assert.equal(disconnected.intervalGap.recordId, row.intervalGap.recordId, 'historical gap evidence survives a later disconnect');
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a legitimate asset-only instrument delta does not fail a mapped collector', async () => {
  FakeSocket.instances.length = 0; const dir = temp();
  const c = catalog([market('BTC', 'XXBT', 'XBT')]);
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => T, limits: { subscribePaceMs: 1, latestSnapshotMs: 1, catalogPollMs: 60_000 } });
  try {
    const socket = FakeSocket.instances.at(-1); socket.open(); const request = socket.sent.find((r) => r.params.channel === 'instrument');
    instrumentSnapshot(socket, [
      { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' },
      { symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', status: 'online' },
      { symbol: 'USD/JPY', base: 'USD', quote: 'JPY', status: 'online' },
    ]);
    ack(socket, request, null);
    await sleep(10);
    socket.emit({ channel: 'instrument', type: 'update', data: { assets: [{ id: 'BTC', status: 'enabled' }] } });
    await sleep();
    assert.equal(handle.status().instrument.state, 'MAPPED', 'a late subscribe ack cannot downgrade a processed snapshot');
    assert.equal(handle.status().instrument.mapped, 1);
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a reconnect snapshot remains a visible baseline until the new epoch receives a trade-triggered update', async () => {
  FakeSocket.instances.length = 0; const dir = temp(); let now = T;
  const c = catalog([market('BTC', 'XXBT', 'XBT')]);
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => now, limits: { subscribePaceMs: 1, latestSnapshotMs: 1, catalogPollMs: 60_000 } });
  try {
    const first = FakeSocket.instances.at(-1); first.open(); let request = first.sent.find((r) => r.params.channel === 'instrument'); ack(first, request); instrumentSnapshot(first, [{ symbol: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' }]); await sleep(15);
    for (const sub of first.sent.filter((r) => ['ticker', 'ohlc'].includes(r.params.channel))) ack(first, sub, 'BTC/USD');
    first.emit({ channel: 'ticker', type: 'update', data: [ticker('BTC/USD')] }); await sleep(5); await handle.drain();
    assert.equal(handle.latest('BTC').ticker.state, 'FRESH');
    first.close(); now += 1_000; await sleep(1_020);
    const second = FakeSocket.instances.at(-1); assert.notEqual(second, first); second.open(); request = second.sent.find((r) => r.params.channel === 'instrument'); ack(second, request); instrumentSnapshot(second, [{ symbol: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' }]); await sleep(15);
    for (const sub of second.sent.filter((r) => ['ticker', 'ohlc'].includes(r.params.channel))) ack(second, sub, 'BTC/USD');
    second.emit({ channel: 'ticker', type: 'snapshot', data: [ticker('BTC/USD', { timestamp: new Date(now).toISOString() })] }); await sleep(5); await handle.drain();
    const latest = handle.latest('BTC'); assert.equal(latest.ticker.lastPrice, 100); assert.equal(latest.ticker.volume24hBase, 123.5); assert.equal(latest.ticker.state, 'IDLE_SNAPSHOT_BASELINE');
  } finally { await handle.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid price/volume and malformed/future OHLC are never fresh; stop drains and releases the exact writer lock', async () => {
  FakeSocket.instances.length = 0; const dir = temp(); let now = T;
  const c = catalog([market('BTC', 'XXBT', 'XBT')]);
  const open = () => startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => now, limits: { subscribePaceMs: 1, latestSnapshotMs: 1, catalogPollMs: 60_000 } });
  const handle = open();
  const socket = FakeSocket.instances.at(-1); socket.open(); const ir = socket.sent.find((r) => r.params.channel === 'instrument'); ack(socket, ir); instrumentSnapshot(socket, [{ symbol: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' }]); await sleep(15);
  for (const request of socket.sent.filter((r) => ['ticker', 'ohlc'].includes(r.params.channel))) ack(socket, request, 'BTC/USD');
  socket.emit({ channel: 'ticker', type: 'update', data: [ticker('BTC/USD', { timestamp: new Date(T + 10_000).toISOString() })] });
  await sleep(5); await handle.drain();
  const futureClock = readBroadKrakenLatest({ dataDir: dir, now });
  assert.ok(futureClock.malformed >= 1);
  assert.equal(futureClock.markets.find((m) => m.canonicalCoin === 'BTC').ticker.record, null, 'future source clocks are rejected by the disk reader');
  socket.emit({ channel: 'ticker', type: 'update', data: [ticker('BTC/USD', { last: -1, volume: -5 })] });
  socket.emit({ channel: 'ohlc', type: 'update', data: [ohlc('BTC/USD', T + 10_000, { high: 90 })] });
  socket.emit({ channel: 'ohlc', type: 'update', data: [ohlc('BTC/USD', T + 10_000, { interval_begin: new Date(T + 10_000).toISOString() })] });
  await sleep(5); await handle.drain();
  assert.equal(handle.latest('BTC').ticker.state, 'INVALID');
  assert.equal(handle.status().counters.rejectedRows, 2, 'bad-envelope and future-clock OHLC rows are rejected, never normalized into detector facts');
  await handle.stop();
  const stopped = readBroadKrakenLatest({ dataDir: dir, now });
  assert.equal(stopped.markets.find((m) => m.canonicalCoin === 'BTC').ticker.state, 'RETAINED_ONLY_PERSISTED');
  assert.ok(!readdirSync(path.join(dir, 'broad-kraken')).includes('writer.lock'));
  const reopened = open(); await reopened.stop();
  const source = readFileSync(new URL('../market-lab/broad-kraken.js', import.meta.url), 'utf8');
  for (const forbidden of ['addOrder', 'cancelOrder', "from '../judge", "from '../watch", "from '../tape", 'api_key', 'ws-auth']) assert.equal(source.includes(forbidden), false, forbidden);
  rmSync(dir, { recursive: true, force: true });
});

test('PUBLISH-FIX-1/3: the broad-Kraken writer lock recovers a DEAD owner and a PRIOR-BOOT owner whose pid was reused — logged, re-owned; a same-boot LIVE owner still refuses; an unreadable lock refuses for manual review', async () => {
  FakeSocket.instances.length = 0; const dir = temp(); const now = T;
  const c = catalog([market('BTC', 'XXBT', 'XBT')]);
  const lockDir = path.join(dir, 'broad-kraken'); mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'writer.lock'); const logs = [];
  const open = () => startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => now, log: (m) => logs.push(String(m)), limits: { catalogPollMs: 60_000 } });
  // a lock owned by a DEAD pid (spawnSync's child has exited) is recovered, logged, and re-owned — never "operator verification required"
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(lockFile, `${JSON.stringify({ version: 'x', pid: dead, token: 'zz', acquiredTs: now })}\n`);
  const handle = open();
  assert.ok(logs.some((m) => m.includes(`recovered stale broad Kraken writer lock from stopped pid ${dead}`)), 'the dead owner lock is recovered and logged');
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid, 'the lock is re-owned by this process');
  await handle.stop();
  // a lock owned by a LIVE pid (this process) FROM THIS BOOT is real contention — still refuses, never recovered
  writeFileSync(lockFile, `${JSON.stringify({ version: 'x', pid: process.pid, token: 'zz', acquiredTs: now })}\n`);
  assert.throws(open, (e) => e.code === 'BROAD_MARKET_LOCKED' && /live owner|already active/.test(e.message));
  // PUBLISH-FIX-3: a lock from a PREVIOUS boot is stale even when its pid is now a LIVE (reused) process — the Replit pid-34
  // false positive. Gated on the kernel boot id being readable (Linux); elsewhere the pid-only law above still holds.
  let bootId = null; try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { bootId = null; }
  if (bootId) {
    const priorLogs = logs.length;
    writeFileSync(lockFile, `${JSON.stringify({ version: 'x', pid: process.pid, bootId: 'prior-boot-0000', token: 'zz', acquiredTs: now })}\n`);
    const reowned = open();
    assert.ok(logs.slice(priorLogs).some((m) => /previous boot/.test(m) && m.includes(`pid ${process.pid}`)), 'a prior-boot lock with a reused live pid is recovered and logged');
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).bootId, bootId, 're-owned with this boot id');
    await reowned.stop();
  }
  // an unreadable lock is never silently unlinked — it refuses for manual review
  writeFileSync(lockFile, 'not json{');
  assert.throws(open, (e) => e.code === 'BROAD_MARKET_LOCKED' && /manual review/.test(e.message));
  rmSync(dir, { recursive: true, force: true });
});
