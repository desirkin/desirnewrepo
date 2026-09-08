// MARKET LAB — the independent numeric and temporal oracles G01-G14 (A07) and the three differentiators H01-H03 (§8):
// exact arithmetic with declared rounding, refusals where a recipe would otherwise invent a value (no sourced rate,
// insufficient peers, forecast learned after release, mismatched entity sets), and the point-in-time law.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeWindow, bookMetrics, walkBook, roundTrip, haircutScenarios, pressureResponse, pressureResponseChange, peerRelativeMove, venueDispersion, convertQuote, basisBps, oiChange, fundingNative, optionsSurface, admitOptions, supplyRatios, exchangeNetFlow, liquidationTotals, etfFlowSummary, macroSurprise, pearson, relativeActivity, indicators, breakoutDistance, orderedFirstChanges, RECIPES, RECIPE_SET_VERSION } from '../market-lab/recipes.js';
import { knowledgeFloor, admissibleAt, derivationClockError, inWindow, adjacentWindows, clockConflict } from '../market-lab/time.js';

const T0 = Date.parse('2026-09-08T12:00:00Z');
const trade = (price, qty, side, ts, seq = 1) => ({ kind: 'TRADE', sourceEventTs: ts, knownAtTs: ts + 5, sequence: seq, payload: { price, qty, quoteNotional: price * qty, takerSide: side } });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('G01. trades 2 units at 100 and 1 at 102: quantity 3, notional 302, vwap 100.666667; signed notional and known-side imbalance follow the taker side; a coverage gap inside the window nulls the counts instead of understating them', () => {
  const COMPLETE = { state: 'COMPLETE', reasons: [], basis: ['mc-cov'] }; // closeout R02: interval totals need a POSITIVE complete-coverage fact
  const w = tradeWindow([trade(100, 2, 'BUY', T0 - 30_000, 1), trade(102, 1, 'SELL', T0 - 10_000, 2)], { startTs: T0 - 60_000, endTs: T0, coverage: COMPLETE });
  assert.equal(w.volumeBase, 3); assert.equal(w.quoteNotional, 302); near(w.vwap, 302 / 3, 1e-6); assert.equal(w.open, 100); assert.equal(w.close, 102); assert.equal(w.high, 102); assert.equal(w.low, 100); assert.equal(w.count, 2);
  assert.equal(w.flow.buyNotional, 200); assert.equal(w.flow.sellNotional, 102); assert.equal(w.flow.signedNotional, 98); near(w.flow.knownSideImbalance, 98 / 302); assert.equal(w.flow.knownSideFraction, 1); assert.equal(w.support.state, 'COMPLETE');
  const gap = tradeWindow([trade(100, 2, 'BUY', T0 - 30_000)], { startTs: T0 - 60_000, endTs: T0, coverage: COMPLETE, coverageGap: true }); assert.equal(gap.count, null); assert.equal(gap.quoteNotional, null); assert.equal(gap.support.state, 'PARTIAL'); assert.deepEqual(gap.support.reasons, ['COVERAGE_GAP_INSIDE_WINDOW']);
  const evicted = tradeWindow([trade(100, 2, 'BUY', T0 - 30_000)], { startTs: T0 - 60_000, endTs: T0, coverage: COMPLETE, evictedUntilTs: T0 - 40_000 }); assert.equal(evicted.count, null); assert.equal(evicted.support.state, 'PARTIAL'); assert.deepEqual(evicted.support.reasons, ['RESOURCE_EVICTED']);
  const empty = tradeWindow([], { startTs: T0 - 60_000, endTs: T0, coverage: COMPLETE }); assert.equal(empty.count, 0); assert.equal(empty.vwap, null); assert.equal(empty.support.state, 'COMPLETE_NO_TRADES', 'no trades in a covered window is an observed zero, not a missing value');
  const unknown = tradeWindow([trade(100, 2, 'BUY', T0 - 30_000, 1)], { startTs: T0 - 60_000, endTs: T0 }); assert.equal(unknown.count, null); assert.equal(unknown.quoteNotional, null); assert.equal(unknown.observedCount, 1); assert.equal(unknown.observedNotional, 200); assert.equal(unknown.support.state, 'UNKNOWN_COVERAGE'); assert.deepEqual(unknown.support.reasons, ['NO_POSITIVE_INTERVAL_COVERAGE'], 'without a positive coverage fact observed trades are labelled observed, never an interval total');
  const partial = tradeWindow([], { startTs: T0 - 60_000, endTs: T0, coverage: { state: 'PARTIAL', reasons: ['COVERAGE_GAP_INSIDE_WINDOW'], basis: ['mc-a'] } }); assert.equal(partial.count, null); assert.equal(partial.support.state, 'PARTIAL', 'an empty window under partial coverage is not an observed zero');
  assert.equal(inWindow(T0 - 60_000, T0 - 60_000, T0), false); assert.equal(inWindow(T0, T0 - 60_000, T0), true, 'windows are (start, end]');
});

test('G02. bid 99 / ask 101 with depth: mid 100, spread 200 bps; bid qty 3 against ask qty 1 gives microprice 100.5; bands are notional with a lower-bound flag when the retained depth ends inside the band', () => {
  const m = bookMetrics({ bids: [[99, 3], [98, 5]], asks: [[101, 1], [102, 5]] });
  assert.equal(m.mid, 100); assert.equal(m.spreadBps, 200); assert.equal(m.microprice, 100.5); assert.equal(m.bands['25bps'].bid.notional, 0, 'a bid 100 bps away is outside every band');
  const tight = bookMetrics({ bids: [[99.9, 3], [99.5, 5]], asks: [[100.1, 1], [100.5, 2]] }); assert.equal(tight.bands['5bps'].bid.notional, 0); assert.equal(tight.bands['10bps'].bid.notional, 299.7); assert.equal(tight.bands['10bps'].bid.lowerBoundOnly, false); assert.equal(tight.bands['25bps'].ask.notional, 100.1); assert.ok(tight.bands['10bps'].imbalance > 0);
  const thin = bookMetrics({ bids: [[99.9, 3]], asks: [[100.1, 1]] }); assert.equal(thin.bands['25bps'].bid.lowerBoundOnly, true, 'depth exhausted inside the band: a lower bound, never the full band');
  assert.equal(bookMetrics({ bids: [], asks: [[101, 1]] }).support.state, 'NO_TWO_SIDED_BOOK'); assert.equal(m.support.attribution, 'AGGREGATE_L2_UNATTRIBUTED');
});

test('G03. target return 300 bps against five peers [100, 100, 200, 0, -100]: median 100, residual 200, MAD 100, three positive peers; fewer than five admissible peers refuses with the count disclosed', () => {
  const peers = [100, 100, 200, 0, -100].map((r, i) => ({ coin: `P${i}`, returnBps: r }));
  const r = peerRelativeMove({ targetReturnBps: 300, peers }); assert.equal(r.medianPeerReturnBps, 100); assert.equal(r.residualBps, 200); assert.equal(r.madBps, 100); assert.equal(r.positivePeers, 3); assert.equal(r.n, 5); assert.equal(r.support.state, 'COMPLETE');
  const few = peerRelativeMove({ targetReturnBps: 300, peers: [...peers.slice(0, 4), { coin: 'X', returnBps: null, reason: 'NO_TRADES' }] }); assert.equal(few.residualBps, null); assert.equal(few.support.state, 'INSUFFICIENT_PEERS'); assert.deepEqual(few.excluded, [{ coin: 'X', reason: 'NO_TRADES' }]);
});

test('G04/G05. round trip of 101 quote through ask 101 / bid 99: 1 unit bought, proceeds 99, loss 198.0198 bps pre-fee; haircuts are stress scenarios; efficiency: 1,000,000 quote moving mid 100 bps is 100 bps per million with the sign convention', () => {
  const book = { bids: [[99, 5]], asks: [[101, 5]] };
  const rt = roundTrip(book, 101); assert.equal(rt.buy.filledBase, 1); assert.equal(rt.saleProceeds, 99); near(rt.lossBps, 1e4 * 2 / 101, 1e-4); assert.equal(rt.coverage, 'FULL'); assert.equal(rt.preFee, true); assert.equal(rt.worstBuyPrice, 101); assert.equal(rt.worstSellPrice, 99);
  const partial = roundTrip({ bids: [[99, 0.5]], asks: [[101, 5]] }, 101); assert.equal(partial.coverage, 'PARTIAL_SELL'); assert.equal(partial.lossBps, null, 'insufficient bids: no invented exit');
  const hc = haircutScenarios(book, 101); assert.deepEqual(hc.map((h) => h.haircut), [1, 0.5, 0.25]); assert.ok(hc.every((h) => h.scenario === 'STRESS_NOT_PROBABILITY'));
  const walk = walkBook([[101, 0.5], [102, 1]], { quoteNotional: 101 }); assert.equal(walk.consumedLevels, 2); near(walk.filledQuote, 101); assert.equal(walk.worstPrice, 102);
  const e = pressureResponse({ signedNotional: 1_000_000, startMid: 100, endMid: 101 }); assert.equal(e.responseBps, 100); assert.equal(e.efficiencyBpsPerMillion, 100);
  const neg = pressureResponse({ signedNotional: -2_000_000, startMid: 100, endMid: 99 }); assert.equal(neg.efficiencyBpsPerMillion, 50, 'selling pressure moving price down is positive efficiency (sign-normalized)');
  assert.equal(pressureResponse({ signedNotional: 0, startMid: 100, endMid: 101 }).support.state, 'ZERO_SIGNED_PRESSURE'); assert.equal(pressureResponse({ signedNotional: 5, startMid: null, endMid: 101 }).support.state, 'NO_BOOK_ENDPOINTS');
});

test('H01. pressure/response change: rising signed pressure with falling efficiency is reported as a measured change with the alternative explanations attached, never as a verdict', () => {
  const prev = pressureResponse({ signedNotional: 120_000, startMid: 100, endMid: 100.12 }); const cur = pressureResponse({ signedNotional: 480_000, startMid: 100.12, endMid: 100.52 });
  const ch = pressureResponseChange(prev, cur); assert.equal(ch.pressureChange, 360_000); assert.ok(ch.efficiencyChange < 0); assert.ok(cur.alternatives.includes('ABSORPTION')); assert.equal(ch.support.state, 'COMPLETE');
  assert.equal(pressureResponseChange(prev, null).efficiencyChange, null);
});

test('G06/H02. index 100 / mark 101: basis 100 bps; open interest 1000 -> 1100: +100 and +10 percent under the same specification and unit, refused across specifications; OI delta is not a side; funding keeps its native unit', () => {
  assert.equal(basisBps(101, 100), 100); assert.equal(basisBps(101, 0), null);
  const tick = (oi, spec = 'S1', unit = 'CONTRACTS', ts = T0) => ({ subject: { specificationId: spec }, knownAtTs: ts, payload: { openInterest: oi, openInterestUnit: unit } });
  const d = oiChange(tick(1000, 'S1', 'CONTRACTS', T0 - 3_600_000), tick(1100)); assert.equal(d.absolute, 100); assert.equal(d.percent, 10); assert.equal(d.law, 'OI_DELTA_IS_NOT_A_SIDE');
  assert.equal(oiChange(tick(1000, 'S1'), tick(1100, 'S2')).support.state, 'SPECIFICATION_MISMATCH'); assert.equal(oiChange(tick(1000, 'S1', 'USD'), tick(1100, 'S1', 'CONTRACTS')).support.state, 'SPECIFICATION_MISMATCH');
  const f = fundingNative({ payload: { fundingRateNative: 0.0001, fundingUnit: 'FRACTION_PER_INTERVAL', fundingIntervalMs: 28_800_000, fundingRelative: null, settlementCurrency: 'USDT', linearity: 'LINEAR' } }); assert.equal(f.value, 0.0001); assert.equal(f.annualized, null); assert.equal(f.payerConvention, 'LONGS_PAY_SHORTS'); assert.equal(f.law, 'NO_SILENT_ANNUALIZATION');
  assert.equal(fundingNative({ payload: { fundingRateNative: 0.1, fundingUnit: 'PERCENT_PER_YEAR', fundingIntervalMs: 1 } }).support.state, 'UNIT_REJECTED');
  const ordered = orderedFirstChanges([{ venue: 'coinbase', receivedTs: T0 + 40 }, { venue: 'kraken', receivedTs: T0 + 10, clockUncertaintyMs: 20 }]); assert.deepEqual(ordered.sequence.map((s) => s.venue), ['kraken', 'coinbase']); assert.equal(ordered.law, 'OBSERVED_SEQUENCE_NOT_CAUSATION');
});

test('G07. ATM IV 0.65; call IV 0.70 at delta +0.24; put IV 0.80 at delta -0.26: risk reversal -0.10, butterfly +0.10; nearest strike / delta selection is deterministic; a mixed scope refuses; admission is nearest expiry then nearest strike, capped', () => {
  const tk = (id, type, strike, delta, iv, extra = {}) => ({ kind: 'OPTION_TICK', provider: 'DERIBIT', subject: { venue: 'deribit', instrumentId: id }, payload: { expiryTs: T0 + 7 * 86_400_000, markIv: iv, underlyingPrice: 100, strike, optionType: type, delta, bidIv: iv - 0.01, askIv: iv + 0.01, settlementCurrency: 'BTC', underlyingIndex: 'btc_usd', openInterest: 10, volume24h: 1, ...extra } });
  const ticks = [tk('ATM-C', 'CALL', 100, 0.5, 0.65), tk('C24', 'CALL', 110, 0.24, 0.70), tk('C40', 'CALL', 105, 0.40, 0.68), tk('P26', 'PUT', 90, -0.26, 0.80), tk('P10', 'PUT', 80, -0.10, 0.9)];
  const census = { basis: 'CENSUS_RECORD', total: 5, omitted: 0, rejected: 0, censusId: 'mc-census', knownAtTs: T0 - 1000 };
  const s = optionsSurface(ticks, { censusComplete: true, census }); const t = s.term[0];
  assert.equal(t.atm.markIv, 0.65); assert.equal(t.call25.instrumentId, 'C24'); assert.equal(t.put25.instrumentId, 'P26'); near(t.riskReversal25d, -0.10); near(t.butterfly25d, 0.10); assert.equal(s.law, 'NO_DEALER_GAMMA_INFERENCE_FROM_PUBLIC_OI'); assert.equal(s.support.state, 'COMPLETE'); assert.equal(t.ratioScope, 'WHOLE_CHAIN'); assert.equal(s.census.complete, true); assert.equal(s.census.censusId, 'mc-census');
  // closeout R02: completeness is an INPUT from a recorded census, never a default; without it the surface is PARTIAL_CENSUS and its ratios are labelled as the admitted subset
  const noCensus = optionsSurface(ticks); assert.equal(noCensus.support.state, 'PARTIAL_CENSUS'); assert.deepEqual(noCensus.support.reasons, ['CENSUS_INCOMPLETE']); assert.equal(noCensus.term[0].ratioScope, 'ADMITTED_SUBSET'); assert.equal(noCensus.census.basis, 'NONE');
  const dup = optionsSurface([...ticks, { ...ticks[0], knownAtTs: 5, sequence: 9 }], { censusComplete: true, census }); assert.equal(dup.admitted, 5, 'a summary tick and its enriched ticker for one instrument are ONE contract');
  const mixed = optionsSurface([...ticks, tk('X', 'CALL', 100, 0.5, 0.6, { settlementCurrency: 'USDC' })]); assert.equal(mixed.support.state, 'SCOPE_MISMATCH');
  const many = Array.from({ length: 700 }, (_, i) => tk(`O${i}`, i % 2 ? 'PUT' : 'CALL', 50 + i, 0.3, 0.6, { expiryTs: T0 + (1 + (i % 5)) * 86_400_000 }));
  const adm = admitOptions(many, { cap: 512, nowTs: T0 }); assert.equal(adm.admitted.length, 512); assert.equal(adm.omitted, 188); assert.equal(adm.census, 700); assert.ok(adm.admitted.every((x) => x.payload.expiryTs <= adm.admitted[511].payload.expiryTs));
});

test('G08. venue mids 99 / 100 / 101: median 100, dispersion 200 bps; a mixed quote refuses; EUR/USD conversion without a sourced matching rate refuses; with a sourced rate it converts and records the path', () => {
  const d = venueDispersion([{ venue: 'a', mid: 99, quote: 'USD' }, { venue: 'b', mid: 100, quote: 'USD' }, { venue: 'c', mid: 101, quote: 'USD' }]); assert.equal(d.medianMid, 100); assert.equal(d.dispersionBps, 200);
  assert.equal(venueDispersion([{ venue: 'a', mid: 99, quote: 'USD' }, { venue: 'b', mid: 100, quote: 'USDC' }]).support.state, 'QUOTE_MISMATCH');
  assert.equal(convertQuote(100, 'EUR', 'USD', null).support.state, 'NO_SOURCED_RATE'); assert.equal(convertQuote(100, 'EUR', 'USD', { rate: 1.1, base: 'USD', quote: 'EUR', sourceObservationId: 'mo-1' }).value, null, 'a rate for the wrong direction is not inverted silently');
  const c = convertQuote(100, 'EUR', 'USD', { rate: 1.1, base: 'EUR', quote: 'USD', sourceObservationId: 'mo-1', ageMs: 5 }); near(c.value, 110); assert.equal(c.rateSource, 'mo-1'); assert.deepEqual(c.conversionPath, ['EUR', 'USD']); assert.equal(convertQuote(5, 'USD', 'USD', null).value, 5);
});

test('G09/G10. supply ratios: circulating 80 / total 100 / max 120 / cap 160 / FDV 240 / volume 40 -> 0.8, 2/3, 1.5, 0.25; matching inflow 120 / outflow 70 -> net +50; a changed provider, entity set, unit or window refuses; exchange transfer is not a sale', () => {
  const s = supplyRatios({ payload: { circulatingSupply: 80, totalSupply: 100, maxSupply: 120, marketCapUsd: 160, fdvUsd: 240, volume24hUsd: 40, capMethodologyId: 'cg' } }); near(s.circulatingOverTotal, 0.8); near(s.circulatingOverMax, 2 / 3); near(s.fdvOverMarketCap, 1.5); near(s.volumeOverMarketCap, 0.25); assert.equal(s.maxSupplyKnown, true);
  assert.equal(supplyRatios({ payload: { circulatingSupply: 80, totalSupply: 100, maxSupply: null } }).circulatingOverMax, null);
  const leg = (metric, value, over = {}) => ({ provider: 'CRYPTOQUANT', periodStartTs: T0 - 86_400_000, periodEndTs: T0, subject: { canonicalCoin: 'BTC' }, payload: { value, entitySet: 'all_exchange', chain: 'bitcoin', unit: 'NATIVE', window: 'day', labelVintage: 'v1', methodologyId: `cryptoquant-${metric}-v1`, ...over } });
  const n = exchangeNetFlow(leg('inflow', 120), leg('outflow', 70)); assert.equal(n.net, 50); assert.equal(n.law, 'EXCHANGE_TRANSFER_IS_NOT_A_SALE');
  assert.equal(exchangeNetFlow(leg('inflow', 120), { ...leg('outflow', 70), provider: 'SANTIMENT' }).support.state, 'RECIPE_MISMATCH'); assert.equal(exchangeNetFlow(leg('inflow', 120), leg('outflow', 70, { entitySet: 'binance' })).support.state, 'RECIPE_MISMATCH'); assert.equal(exchangeNetFlow(leg('inflow', 120), leg('outflow', 70, { unit: 'USD' })).support.state, 'RECIPE_MISMATCH');
});

test('G11. twenty closed bars all at 100: SMA 100, population stdev 0, Bollinger bands 100/100/100, RSI FLAT (null); breakout distances against prior ranges; fewer bars than a window yield null, never a partial average', () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ periodStartTs: T0 + i * 60_000, periodEndTs: T0 + (i + 1) * 60_000, payload: { closed: true, close: 100, high: 100, low: 100, intervalMs: 60_000 } }));
  const ind = indicators(bars); assert.equal(ind.sma[20], 100); assert.equal(ind.sma[60], null); assert.equal(ind.bollinger20.stdev, 0); assert.deepEqual([ind.bollinger20.lower, ind.bollinger20.middle, ind.bollinger20.upper], [100, 100, 100]); assert.equal(ind.rsi14.state, 'FLAT'); assert.equal(ind.rsi14.value, null); assert.equal(ind.macd, null); assert.equal(ind.closedBars, 20);
  const open = indicators([...bars, { periodStartTs: T0 + 20 * 60_000, periodEndTs: T0 + 21 * 60_000, payload: { closed: false, close: 500, high: 500, low: 500, intervalMs: 60_000 } }]); assert.equal(open.closedBars, 20, 'an uncommitted bar never enters an indicator');
  const rising = indicators(Array.from({ length: 30 }, (_, i) => ({ periodStartTs: T0 + i * 60_000, periodEndTs: T0 + (i + 1) * 60_000, payload: { closed: true, close: 100 + i, high: 101 + i, low: 99 + i, intervalMs: 60_000 } }))); assert.equal(rising.rsi14.value, 100); assert.equal(rising.prior20.high, 129); assert.equal(rising.atr14, 2);
  const bd = breakoutDistance(129, rising, 120); assert.equal(bd.toPrior20High, 0); near(bd.toVwap, 750);
});

test('G12/G14. macro: forecast 2.0 known before release, actual 2.3 -> surprise +0.3 percentage points; a forecast learned after the release refuses; a date-only release fetched at 18:00 is not admissible at 09:00 (knowledge floor = receipt)', () => {
  const release = T0 - 3_600_000;
  const ev = (forecastKnownAtTs) => ({ payload: { actualValue: 2.3, forecastValue: 2.0, unit: 'PERCENT', previousValue: 1.9, scheduledTs: release, forecastKnownAtTs } });
  const s = macroSurprise(ev(release - 86_400_000)); near(s.surprise, 0.3); assert.equal(s.unit, 'PERCENTAGE_POINTS'); assert.equal(s.revisedPrevious, null); assert.equal(s.law, 'REVISED_PREVIOUS_IS_NOT_THE_FIRST_RELEASE_PRIOR');
  assert.equal(macroSurprise(ev(release + 1000)).support.state, 'FORECAST_NOT_KNOWN_BEFORE_RELEASE'); assert.equal(macroSurprise({ payload: { actualValue: null, forecastValue: 2 } }).support.state, 'VALUE_MISSING');
  const fetchedAt = Date.parse('2026-09-08T18:00:00Z'); const kf = knowledgeFloor({ receivedTs: fetchedAt }); assert.equal(kf.basis, 'RECEIPT'); const o = { knownAtTs: kf.floorTs };
  assert.equal(admissibleAt(o, Date.parse('2026-09-08T09:00:00Z')), false, 'a date-only release fetched at 18:00 is unknown at 09:00 the same day'); assert.equal(admissibleAt(o, fetchedAt), true);
  assert.deepEqual(knowledgeFloor({ receivedTs: fetchedAt, providerLagMs: 60_000 }), { floorTs: fetchedAt + 60_000, basis: 'RECEIPT_PLUS_PROVIDER_LAG' }, 'a documented provider lag only RAISES the floor');
  assert.deepEqual(knowledgeFloor({ receivedTs: fetchedAt, provenEarlierBasisTs: fetchedAt - 5000 }), { floorTs: fetchedAt - 5000, basis: 'PROVEN_EARLIER_BASIS' }, 'only a PROVEN earlier basis moves the floor back');
  assert.equal(knowledgeFloor({ receivedTs: null }).floorTs, null);
});

test('G13. point-in-time derivation: a component derived at as-of may only cite inputs known at or before it; window end after the as-of and inputs known later are clock errors; source clocks ahead of receipt conflict', () => {
  assert.equal(derivationClockError({ windowEndTs: T0, derivationTs: T0, asOfTs: T0, inputKnownAtTs: [T0 - 5, T0] }), null);
  assert.match(derivationClockError({ windowEndTs: T0 + 1, derivationTs: T0, asOfTs: T0, inputKnownAtTs: [] }) ?? '', /window/);
  assert.match(derivationClockError({ windowEndTs: T0, derivationTs: T0, asOfTs: T0, inputKnownAtTs: [T0 + 5000] }) ?? '', /known/);
  assert.equal(clockConflict(T0 + 120_000, T0), true); assert.equal(clockConflict(T0 - 1, T0), false);
  const w = adjacentWindows(T0, 60_000); assert.deepEqual([w.previous.startTs, w.previous.endTs, w.current.startTs, w.current.endTs], [T0 - 120_000, T0 - 60_000, T0 - 60_000, T0]);
});

test('H03 / misc. liquidation totals by side keep the unit and refuse mixed units; a covered window with no events is an observed zero; ETF trailing sums; Pearson needs 30 pairs and positive variances; relative activity needs three trailing windows; the recipe registry is versioned', () => {
  const liq = (side, notional, ts, unit = 'USDT') => ({ kind: 'LIQUIDATION', sourceEventTs: ts, periodEndTs: null, payload: { aggregated: false, liquidatedPositionSide: side, notional, notionalUnit: unit } });
  const t = liquidationTotals([liq('LONG', 4_200_000, T0 - 100), liq('SHORT', 300_000, T0 - 50), liq('UNKNOWN', 10, T0 - 10)], { startTs: T0 - 3_600_000, endTs: T0 }); assert.equal(t.longNotional, 4_200_000); assert.equal(t.shortNotional, 300_000); assert.equal(t.unknownSideNotional, 10); assert.equal(t.events, 3); assert.equal(t.law, 'CAUSE_OF_A_LIQUIDATION_IS_NOT_OBSERVED');
  assert.equal(liquidationTotals([liq('LONG', 1, T0 - 1), liq('LONG', 1, T0 - 2, 'USDC')], { startTs: T0 - 60_000, endTs: T0 }).support.state, 'UNIT_MISMATCH');
  const zero = liquidationTotals([], { startTs: T0 - 60_000, endTs: T0, coverageKnown: true }); assert.equal(zero.longNotional, null); assert.equal(zero.zeroMeaningful, true); assert.equal(zero.support.state, 'COMPLETE_NO_EVENTS'); assert.equal(liquidationTotals([], { startTs: 1, endTs: 2, coverageKnown: false }).support.state, 'UNKNOWN_COVERAGE');
  const flows = Array.from({ length: 25 }, (_, i) => ({ kind: 'ETF_FLOW', periodStartTs: T0 - (25 - i) * 86_400_000, periodEndTs: T0 - (24 - i) * 86_400_000, receivedTs: T0, payload: { fund: null, flowUsd: 10, asset: 'BTC', estimate: false } }));
  const e = etfFlowSummary(flows); assert.equal(e.trailing5, 50); assert.equal(e.trailing20, 200); assert.equal(e.days, 25); assert.equal(e.law, 'DAILY_FLOW_IS_SLOW_CONTEXT');
  assert.equal(pearson(Array.from({ length: 29 }, (_, i) => [i, i])).support.state, 'INSUFFICIENT_PAIRS'); near(pearson(Array.from({ length: 30 }, (_, i) => [i, 2 * i + 1])).r, 1); assert.equal(pearson(Array.from({ length: 30 }, () => [1, 2])).support.state, 'ZERO_VARIANCE');
  assert.equal(relativeActivity({ quoteNotional: 200 }, [{ quoteNotional: 100 }, { quoteNotional: 100 }], 'quoteNotional').support.state, 'INSUFFICIENT_TRAILING'); assert.equal(relativeActivity({ quoteNotional: 200 }, [{ quoteNotional: 100 }, { quoteNotional: 100 }, { quoteNotional: 50 }], 'quoteNotional').ratio, 2);
  assert.equal(RECIPE_SET_VERSION, 'market-lab-recipes-1'); assert.ok(Object.keys(RECIPES).length >= 20); assert.ok(Object.isFrozen(RECIPES));
});
