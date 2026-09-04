// MICRO-1 drills — pure deterministic metrics, bounded tracker behavior,
// L2 honesty, tracking bound, failure isolation. A sense, not a strategy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-micro-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const {
  MicrostructureTracker,
  flowWindow,
  priceResponse,
  spreadDynamics,
  depthDynamics,
  bandCoverage,
  recoveryAsymmetry,
  absorptionProxy,
  readStalkingCoins,
  MICRO_LIMITS,
  EPISODE_BAND,
  L2_ATTRIBUTION,
} = await import('../tape/microstructure.js');

const NOW = 1_800_000_000_000;
const T = (offMs, side, qty, price) => ({ ts: NOW - offMs, side, qty, price, notionalUsd: qty * price });

// a minimal fake OrderBook: enough surface for bookFeatures + the tracker
function fakeBook({ bids, asks, ts = NOW, synced = true, depth = 25 }) {
  const sb = [...bids].sort((a, b) => b.price - a.price);
  const sa = [...asks].sort((a, b) => a.price - b.price);
  return {
    synced, depth, lastUpdateTs: ts,
    sortedBids: () => sb, sortedAsks: () => sa,
    bestBid: () => sb[0] ?? null, bestAsk: () => sa[0] ?? null,
  };
}
const lvl = (price, qty) => ({ price, qty });

test('1-7. flow window: quantities, notionals, counts, signed, imbalances', () => {
  const trades = [T(1000, 'buy', 2, 100), T(2000, 'buy', 1, 101), T(3000, 'sell', 1, 99), T(400_000, 'buy', 50, 100)];
  const f = flowWindow(trades, 60_000, NOW);
  assert.equal(f.aggressiveBuyQty, 3); // 1
  assert.equal(f.aggressiveSellQty, 1); // 2
  assert.equal(f.aggressiveBuyNotionalUsd, 301); // 3
  assert.equal(f.aggressiveSellNotionalUsd, 99); // 4
  assert.equal(f.aggressiveBuyTradeCount, 2);
  assert.equal(f.aggressiveSellTradeCount, 1);
  assert.equal(f.signedQty, 2);
  assert.equal(f.signedNotionalUsd, 202); // 5
  assert.ok(Math.abs(f.quantityImbalance - 0.5) < 1e-12); // 6
  assert.ok(Math.abs(f.notionalImbalance - 202 / 400) < 1e-12); // 7
  // no flow => null imbalances, never zero-invented
  const empty = flowWindow([], 60_000, NOW);
  assert.equal(empty.quantityImbalance, null);
  assert.equal(empty.notionalImbalance, null);
});

test('8. rolling-window eviction + hard trade cap are enforced and counted', () => {
  const tr = new MicrostructureTracker();
  tr.setTrackingSet(new Set(['X/USD']), NOW);
  tr.onTrade('X/USD', { ts: NOW - MICRO_LIMITS.tradeHorizonMs - 5000, side: 'buy', qty: 1, price: 1 }, NOW);
  tr.onTrade('X/USD', { ts: NOW - 1000, side: 'buy', qty: 1, price: 1 }, NOW);
  assert.equal(tr.symbols.get('X/USD').trades.length, 1, 'stale trade pruned');
  for (let i = 0; i < MICRO_LIMITS.maxTradesPerSymbol + 50; i++) {
    tr.onTrade('X/USD', { ts: NOW - 100, side: 'buy', qty: 1, price: 1 }, NOW);
  }
  assert.equal(tr.symbols.get('X/USD').trades.length, MICRO_LIMITS.maxTradesPerSymbol, 'ring cap holds');
  assert.ok(tr.droppedTrades > 0, 'overflow is counted, not silent');
});

test('9. mid return over a completed window (start/end preserved)', () => {
  const samples = [
    { ts: NOW - 61_000, mid: 100 },
    { ts: NOW - 30_000, mid: 101 },
    { ts: NOW, mid: 102 },
  ];
  const r = priceResponse(samples, [T(1000, 'buy', 1, 102)], 60_000, NOW);
  assert.equal(r.startMid, 100);
  assert.equal(r.endMid, 102);
  assert.ok(Math.abs(r.midReturnPct - 2) < 1e-12);
  assert.equal(r.buyNotionalUsd, 102);
  assert.ok(Number.isFinite(r.priceResponsePerSignedNotional));
});

test('10. spread change: widening and compression magnitudes are one-sided', () => {
  const widen = spreadDynamics([{ ts: NOW - 61_000, spreadBps: 2 }, { ts: NOW, spreadBps: 5 }], 60_000, NOW);
  assert.equal(widen.spreadChangeBps, 3);
  assert.equal(widen.spreadWideningMagnitude, 3);
  assert.equal(widen.spreadCompressionMagnitude, 0);
  const comp = spreadDynamics([{ ts: NOW - 61_000, spreadBps: 5 }, { ts: NOW, spreadBps: 2 }], 60_000, NOW);
  assert.equal(comp.spreadCompressionMagnitude, 3);
});

test('11-13. depth pressure per labeled band: deltas, OBI change, visible depletion', () => {
  const samples = [
    { ts: NOW - 61_000, depth: { '10bps': { bid: 10_000, ask: 8_000 } }, obi: { '10bps': 0.2 } },
    { ts: NOW, depth: { '10bps': { bid: 6_000, ask: 8_800 } }, obi: { '10bps': -0.1 } },
  ];
  const d = depthDynamics(samples, 60_000, NOW, '10bps');
  assert.equal(d.band, '10bps'); // band always labeled
  assert.equal(d.bidDepthDeltaUsd, -4000);
  assert.equal(d.askDepthDeltaUsd, 800);
  assert.ok(Math.abs(d.bidDepthChangePct + 40) < 1e-9);
  assert.ok(Math.abs(d.visibleBidDepletionPct - 40) < 1e-9); // 12: bid depletion, proxy-named
  assert.equal(d.visibleAskDepletionPct, 0); // 13: growth is zero depletion, not negative
  assert.ok(Math.abs(d.obiDelta + 0.3) < 1e-12);
});

test('14-15. recovery episode: depletion opens, 50%/90% milestones timed, expiry honest', () => {
  const tr = new MicrostructureTracker();
  tr.setTrackingSet(new Set(['X/USD']), NOW);
  const mk = (bidQty) => fakeBook({ bids: [lvl(99.99, bidQty)], asks: [lvl(100.01, 100)] });
  tr.onBook('X/USD', mk(100), NOW); // baseline: ~$9,999 bid depth at 10bps
  tr.onBook('X/USD', mk(40), NOW + 1000); // -60% => episode opens
  const st = tr.symbols.get('X/USD');
  assert.ok(st.activeEpisodes.bid, 'bid depletion episode opened');
  assert.equal(st.activeEpisodes.bid.band, EPISODE_BAND);
  assert.equal(st.activeEpisodes.bid.attribution, L2_ATTRIBUTION);
  tr.onBook('X/USD', mk(75), NOW + 3000); // >=50% of depletion returned
  assert.equal(st.activeEpisodes.bid.depthRecovery50Ms, 3000 - 1000); // 14
  tr.onBook('X/USD', mk(97), NOW + 5000); // >=90% returned -> closed
  assert.equal(st.activeEpisodes.bid, null);
  const done = st.completedEpisodes.at(-1);
  assert.equal(done.outcome, 'RECOVERED_90');
  assert.equal(done.depthRecovery90Ms, 5000 - 1000); // 15
  // expiry: an unrecovered episode closes with milestones left null
  tr.onBook('X/USD', mk(30), NOW + 6000);
  assert.ok(st.activeEpisodes.bid);
  tr.onBook('X/USD', mk(30), NOW + 6000 + MICRO_LIMITS.episodeMaxAgeMs + 1000);
  const expired = st.completedEpisodes.at(-1);
  assert.equal(expired.outcome, 'EXPIRED');
  assert.equal(expired.depthRecovery90Ms, null, 'unreached milestone stays null — never zero');
});

test('16-17. recovery asymmetry needs BOTH sides; insufficient history is UNKNOWN', () => {
  const both = recoveryAsymmetry([
    { side: 'bid', depthRecovery50Ms: 1000 },
    { side: 'bid', depthRecovery50Ms: 3000 },
    { side: 'ask', depthRecovery50Ms: 6000 },
  ]);
  assert.equal(both.bidRecovery50MsMedian, 2000);
  assert.equal(both.askRecovery50MsMedian, 6000);
  assert.ok(Math.abs(both.value - 0.5) < 1e-12); // bid recovers faster => positive
  assert.equal(recoveryAsymmetry([{ side: 'bid', depthRecovery50Ms: 1000 }]), 'UNKNOWN'); // 16
  assert.equal(recoveryAsymmetry([]), 'UNKNOWN'); // 17: never invented zero
  // pure insufficient-history checks for the window metrics too
  assert.equal(priceResponse([{ ts: NOW - 1000, mid: 100 }], [], 60_000, NOW), null);
  assert.equal(spreadDynamics([], 60_000, NOW), null);
  assert.equal(depthDynamics([], 60_000, NOW, '10bps'), null);
});

test('18. non-finite input refusal: bad trades never enter the buffers', () => {
  const tr = new MicrostructureTracker();
  tr.setTrackingSet(new Set(['X/USD']), NOW);
  tr.onTrade('X/USD', { ts: NOW, side: 'buy', qty: NaN, price: 100 }, NOW);
  tr.onTrade('X/USD', { ts: NOW, side: 'buy', qty: 1, price: Infinity }, NOW);
  tr.onTrade('X/USD', { ts: NOW, side: 'hold', qty: 1, price: 100 }, NOW);
  tr.onTrade('X/USD', { ts: NOW, side: 'sell', qty: -2, price: 100 }, NOW);
  assert.equal(tr.symbols.get('X/USD').trades.length, 0);
  assert.equal(tr.health().status, 'HEALTHY', 'refusal is not a failure');
});

test('19. partial band coverage: a book ending inside the band is a lower bound', () => {
  // bids down to 99.97 — the 10bps boundary at mid 100 is 99.90: PARTIAL
  assert.equal(bandCoverage([lvl(99.99, 1), lvl(99.97, 1)], 100, 10, 'bid'), 'PARTIAL');
  // bids extending past 99.90: COMPLETE
  assert.equal(bandCoverage([lvl(99.99, 1), lvl(99.85, 1)], 100, 10, 'bid'), 'COMPLETE');
  assert.equal(bandCoverage([lvl(100.01, 1), lvl(100.30, 1)], 100, 25, 'ask'), 'COMPLETE');
  assert.equal(bandCoverage([], 100, 10, 'ask'), null);
});

test('20. book-age staleness: an old book marks book-derived metrics STALE', () => {
  const tr = new MicrostructureTracker({ bookStaleMs: 10_000 });
  tr.setTrackingSet(new Set(['X/USD']), NOW);
  const book = fakeBook({ bids: [lvl(99.99, 10)], asks: [lvl(100.01, 10)], ts: NOW - 60_000 });
  tr.onBook('X/USD', book, NOW - 60_000);
  const obs = tr.observe('X/USD', book, 'X', NOW);
  assert.equal(obs.bookState, 'STALE');
  assert.equal(obs.priceResponse['60s'], 'STALE');
  assert.equal(obs.depth['10bps'], 'STALE');
  assert.equal(obs.absorptionProxy.state, 'DEGRADED'); // scenario C (stale book)
  assert.ok(obs.flow['60s'], 'trade-derived flow still reports (kraken-clocked)');
});

test('31. absorption proxy scenarios A (present), B (price responded), C (coverage)', () => {
  const strongBuy = { notionalImbalance: 0.9, aggressiveBuyNotionalUsd: 50_000, aggressiveSellNotionalUsd: 2_000, signedNotionalUsd: 48_000 };
  const base = {
    flow60: strongBuy,
    response60: { midReturnPct: 0.01 },
    depth60: { askDepthChangePct: -2, bidDepthChangePct: 1 },
    bookFresh: true,
    opposingCoverage: { bid: 'COMPLETE', ask: 'COMPLETE' },
  };
  const a = absorptionProxy(base);
  assert.equal(a.state, 'PRESENT'); // A
  assert.equal(a.side, 'aggressive-buying-absorbed-like');
  assert.equal(a.attribution, L2_ATTRIBUTION);
  // the facts stand beside the proxy so a future Brain can disagree
  for (const k of ['notionalImbalance60s', 'signedNotionalUsd60s', 'midReturnPct60s', 'opposingDepthChangePct60s']) {
    assert.ok(k in a, `${k} preserved`);
  }
  const b = absorptionProxy({ ...base, response60: { midReturnPct: 0.8 } });
  assert.equal(b.state, 'NOT_PRESENT'); // B: price gave way
  const c = absorptionProxy({ ...base, opposingCoverage: { bid: 'COMPLETE', ask: 'PARTIAL' } });
  assert.equal(c.state, 'UNAVAILABLE'); // C: partial coverage is not enough evidence
  const d = absorptionProxy({ ...base, flow60: null });
  assert.equal(d.state, 'UNAVAILABLE'); // insufficient history never fabricates
});

test('32. L2 honesty: no field ever claims attribution the book cannot give', () => {
  const tr = new MicrostructureTracker();
  tr.setTrackingSet(new Set(['X/USD']), NOW);
  const book = fakeBook({ bids: [lvl(99.99, 10)], asks: [lvl(100.01, 10)], ts: NOW });
  tr.onBook('X/USD', book, NOW - 61_000);
  tr.onBook('X/USD', book, NOW);
  tr.onTrade('X/USD', { ts: NOW - 500, side: 'buy', qty: 1, price: 100 }, NOW);
  const obs = tr.observe('X/USD', book, 'X', NOW);
  const s = JSON.stringify(obs);
  for (const forbidden of ['exactCancelVolume', 'exactAddVolume', 'confirmedAbsorption', 'makerIdentity', 'liquidityProviderIdentity', 'queuePosition', 'ABSORPTION_CONFIRMED']) {
    assert.ok(!s.includes(forbidden), `${forbidden} must not exist`);
  }
  const src = readFileSync(new URL('../tape/microstructure.js', import.meta.url), 'utf8');
  for (const forbidden of ['exactCancelVolume', 'exactAddVolume', 'confirmedAbsorption', 'makerIdentity', 'queuePosition']) {
    assert.ok(!src.includes(forbidden), `source never defines ${forbidden}`);
  }
  assert.ok(s.includes('AGGREGATE_L2_UNATTRIBUTED'), 'attribution limitation carried');
  assert.ok(s.includes('visibleBidDepletionPct') || s.includes('UNKNOWN_INSUFFICIENT_HISTORY'), 'proxy naming');
  assert.ok(s.includes('LOCAL_BOOK_APPLICATION_CLOCK'), 'timing limitation carried');
});

test('35. tracking bound: eligibility, grace, discard, cap; ineligible symbols ignored', () => {
  const tr = new MicrostructureTracker();
  tr.setTrackingSet(new Set(['A/USD', 'B/USD']), NOW);
  assert.deepEqual(tr.tracked().sort(), ['A/USD', 'B/USD']);
  // untracked symbols are ignored entirely (non-stalked / unsubscribed / unsynced
  // symbols simply never reach the eligible set — and feeding one is a no-op)
  tr.onTrade('C/USD', { ts: NOW, side: 'buy', qty: 1, price: 1 }, NOW);
  assert.ok(!tr.symbols.has('C/USD'));
  // leaves the set: grace first, then discarded
  tr.setTrackingSet(new Set(['A/USD']), NOW + 1000);
  assert.ok(tr.symbols.has('B/USD'), 'grace: state kept briefly');
  assert.ok(!tr.tracked().includes('B/USD'), 'but no longer tracked');
  tr.setTrackingSet(new Set(['A/USD']), NOW + 1000 + MICRO_LIMITS.graceMs + 1000);
  assert.ok(!tr.symbols.has('B/USD'), 'discarded after documented grace');
  // hard cap on tracked symbols
  const many = new Set(Array.from({ length: 40 }, (_, i) => `S${String(i).padStart(2, '0')}/USD`));
  const tr2 = new MicrostructureTracker();
  tr2.setTrackingSet(many, NOW);
  assert.ok(tr2.symbols.size <= MICRO_LIMITS.maxTrackedSymbols);
  // sample buffer bounded
  const tr3 = new MicrostructureTracker();
  tr3.setTrackingSet(new Set(['X/USD']), NOW);
  for (let i = 0; i < MICRO_LIMITS.maxBookSamplesPerSymbol + 60; i++) {
    tr3.onBook('X/USD', fakeBook({ bids: [lvl(99.99, 10)], asks: [lvl(100.01, 10)], ts: NOW + i * 600 }), NOW + i * 600);
  }
  assert.ok(tr3.symbols.get('X/USD').samples.length <= MICRO_LIMITS.maxBookSamplesPerSymbol);
});

test('29. failure isolation: one broken symbol degrades MICRO, never the rest', () => {
  const tr = new MicrostructureTracker();
  tr.setTrackingSet(new Set(['BAD/USD', 'OK/USD']), NOW);
  const bomb = { synced: true, depth: 25, lastUpdateTs: NOW, sortedBids: () => { throw new Error('boom'); }, sortedAsks: () => [], bestBid: () => lvl(1, 1), bestAsk: () => lvl(1.01, 1) };
  tr.onBook('BAD/USD', bomb, NOW);
  assert.equal(tr.health().status, 'DEGRADED');
  assert.deepEqual(tr.health().failedSymbols, ['BAD/USD']);
  assert.ok(!tr.tracked().includes('BAD/USD'), 'failed symbol isolated');
  tr.onBook('OK/USD', fakeBook({ bids: [lvl(99.99, 10)], asks: [lvl(100.01, 10)], ts: NOW }), NOW);
  assert.equal(tr.symbols.get('OK/USD').samples.length, 1, 'healthy symbol unaffected');
  assert.equal(tr.observe('BAD/USD', bomb, 'BAD', NOW), null, 'no fabricated observation');
});

test('stalking read is guarded: corrupt state file yields the empty set, never a throw', () => {
  const dir = path.join(TEST_DATA, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'stalking.json'), '{corrupt');
  assert.deepEqual([...readStalkingCoins()], []);
  writeFileSync(path.join(dir, 'stalking.json'), JSON.stringify({
    SOL: { expiresMs: Date.now() + 60_000 },
    OLD: { expiresMs: Date.now() - 60_000 },
  }));
  assert.deepEqual([...readStalkingCoins()], ['SOL'], 'expired entries excluded');
});

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
