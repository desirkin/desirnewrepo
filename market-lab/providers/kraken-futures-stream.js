// D03 (B) — KRAKEN FUTURES public WebSocket stream (wss://futures.kraken.com/ws/v1) on the EXISTING KRAKEN_DERIVATIVES
// provider: the public book / trade / ticker feeds, read-only, no credentials. This is the live sense Strategy 7 (SDR)
// needs: matched trades TAGGED with the venue's own liquidation flag (feed `trade`, type `liquidation` vs `fill`), and
// NATIVE-UNIT open interest (the ticker `openInterest` is a CONTRACT count — its unit is CONTRACTS and its multiplier is
// the instrument's verified contractSize from the derivatives instrument spec; nothing here converts contracts to base or
// USD by guessing). The book feed is sequence-numbered (no checksum): a seq gap resubscribes for a fresh snapshot; qty 0
// removes a level; a crossed book is never admitted. Authority NONE — this module can only subscribe / unsubscribe public
// market-data feeds. Nothing reaches an order, the Judge, Watch or execution.
import { OrderBook } from '../../tape/book.js';
import { createClientBase, num, int, str, tsFromMs, tsFromIso, arr, obj } from './base.js';
import { createWsClient } from '../transport.js';
import { quality, deepFreeze, fail } from '../contracts.js';
import { HOUR_MS } from '../time.js';

export const KF_STREAM_ENDPOINT_ID = 'ws-public';
export const KF_STREAM_METHODOLOGY = 'kraken-futures-ws-v1';
export const KF_TRADE_TYPES = Object.freeze(['fill', 'liquidation', 'termination']);

// markets: [{ symbol, subject, spec }] — resolved by the caller from the KrakenDerivatives client's resolveInstrument.
// onTrade(observation TRADE), onLiquidation(observation LIQUIDATION), onTick(observation DERIVATIVE_TICK),
// onBook({ market, receivedTs, epochId, synced, levels() }), onCoverage(record).
export function createKrakenFuturesStream({ transport, clock = () => Date.now(), log = () => {}, markets, depth = 25, onTrade = () => {}, onLiquidation = () => {}, onTick = () => {}, onBook = () => {}, onCoverage = () => {}, WebSocketImpl, url = null } = {}) {
  const base = createClientBase({ providerId: 'KRAKEN_DERIVATIVES', transport, clock, log });
  if (!Array.isArray(markets) || !markets.length) fail('INVALID_REQUEST', 'at least one market'); // fail-closed: never open a socket with no subject
  const byId = new Map(markets.map((m) => [m.symbol, m]));
  const books = new Map(markets.map((m) => [m.symbol, new OrderBook(m.symbol, depth)]));
  const lastSeq = new Map(); // product_id -> last book seq (a gap resubscribes)
  const stats = { trades: 0, liquidations: 0, ticks: 0, bookUpdates: 0, resyncs: 0, unknownSymbols: 0, seqGaps: 0 };
  let ws = null; let currentEpoch = null; const subscribed = new Set();

  const resync = (pid, reason, receivedTs) => {
    const b = books.get(pid); b.desync(); lastSeq.delete(pid); stats.resyncs += 1;
    onCoverage(base.coverage({ endpointId: KF_STREAM_ENDPOINT_ID, subject: byId.get(pid).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: [reason], startTs: receivedTs, epochId: currentEpoch }));
    ws.send({ event: 'unsubscribe', feed: 'book', product_ids: [pid] }); ws.send({ event: 'subscribe', feed: 'book', product_ids: [pid] });
  };
  const tickPayload = (spec, t) => {
    const mark = num(t.markPrice); const index = num(t.index); const oi = num(t.openInterest); const fr = num(t.funding_rate); const rel = num(t.relative_funding_rate);
    return { markPrice: mark, indexPrice: index, lastPrice: num(t.last), bid: num(t.bid), ask: num(t.ask), openInterest: oi, openInterestUnit: oi === null ? 'UNKNOWN' : 'CONTRACTS', fundingRateNative: spec.perpetual ? fr : null, fundingUnit: spec.perpetual && fr !== null ? 'ABSOLUTE_QUOTE_PER_CONTRACT_PER_INTERVAL' : 'UNKNOWN', fundingIntervalMs: spec.perpetual && fr !== null ? HOUR_MS : null, fundingRelative: spec.perpetual ? rel : null, fundingPredictedNative: spec.perpetual ? num(t.funding_rate_prediction) : null, nextFundingTs: tsFromMs(t.next_funding_rate_time) || null, volume24hBase: num(t.volume), volume24hQuote: null, contractMultiplier: spec.contractSize, settlementCurrency: spec.linearity === 'INVERSE' ? spec.base : spec.quote, linearity: spec.linearity };
  };

  function onMessage(msg, { receivedTs, epochId, bytesSha256 }) {
    const feed = str(msg.feed, 32);
    // subscription lifecycle: an ack opens an observed interval; an error is FAILED, honestly
    if (str(msg.event, 24) === 'subscribed') { for (const p of arr(msg.product_ids) ?? []) { const id = str(p, 40); if (id && byId.has(id)) { subscribed.add(`${feed}:${id}`); onCoverage(base.coverage({ endpointId: KF_STREAM_ENDPOINT_ID, subject: byId.get(id).subject, family: feed === 'book' ? 'DISPLAYED_LIQUIDITY' : feed === 'ticker' ? 'DERIVATIVES_FUNDING_OI' : 'LIQUIDATIONS', state: 'SUBSCRIBED', startTs: receivedTs, epochId })); } } return; }
    if (str(msg.event, 24) === 'error' || str(msg.event, 24) === 'alert') { return; }
    const pid = str(msg.product_id, 40); const m = pid ? byId.get(pid) : null;
    if (!feed) return;
    if (feed === 'book_snapshot') {
      if (!m) { stats.unknownSymbols += 1; return; }
      const b = books.get(pid);
      const lv = (side) => (arr(msg[side]) ?? []).map((l) => ({ price: num(obj(l)?.price), qty: num(obj(l)?.qty) })).filter((x) => x.price !== null && x.qty !== null && x.price > 0 && x.qty >= 0);
      b.applySnapshot({ bids: lv('bids'), asks: lv('asks') }); lastSeq.set(pid, int(msg.seq));
      onCoverage(base.coverage({ endpointId: KF_STREAM_ENDPOINT_ID, subject: m.subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'OBSERVED', observationCount: 1, startTs: receivedTs, epochId }));
      stats.bookUpdates += 1; onBook({ market: m, receivedTs, epochId, synced: b.synced, levels: () => bookLevels(b, depth) });
      return;
    }
    if (feed === 'book') {
      if (!m) { stats.unknownSymbols += 1; return; }
      const b = books.get(pid); if (!b.synced) return;
      const seq = int(msg.seq); const prev = lastSeq.get(pid);
      if (seq !== null && prev !== null && seq !== prev + 1) { stats.seqGaps += 1; resync(pid, 'DESYNCHRONIZED', receivedTs); return; } // a seq gap: never patch over a hole
      const side = str(msg.side, 8); const price = num(msg.price); const qty = num(msg.qty);
      if (price === null || qty === null || (side !== 'buy' && side !== 'sell')) return;
      b.applyUpdate(side === 'buy' ? { bids: [{ price, qty }], asks: [] } : { bids: [], asks: [{ price, qty }] });
      lastSeq.set(pid, seq);
      const bb = b.bestBid(); const ba = b.bestAsk(); if (bb && ba && bb.price >= ba.price) { resync(pid, 'DESYNCHRONIZED', receivedTs); return; } // a crossed book is never admitted
      stats.bookUpdates += 1; onBook({ market: m, receivedTs, epochId, synced: b.synced, levels: () => bookLevels(b, depth) });
      return;
    }
    if (feed === 'trade' || feed === 'trade_snapshot') {
      if (feed === 'trade_snapshot') return; // the initial snapshot is history we did not witness live
      if (!m) { stats.unknownSymbols += 1; return; }
      const side = str(msg.side, 8); const type = str(msg.type, 16); const price = num(msg.price); const qty = num(msg.qty); const ts = tsFromMs(msg.time) ?? tsFromIso(msg.time); const tid = int(msg.trade_id) ?? int(msg.uid);
      if (price === null || qty === null || ts === null) return;
      const taker = side === 'buy' ? 'BUY' : side === 'sell' ? 'SELL' : 'UNKNOWN';
      if (type === 'liquidation' || type === 'termination') {
        // the venue's OWN liquidation tag: a forced order. forced SELL == a LONG liquidated; forced BUY == a SHORT liquidated.
        // qtyBase stays null (contracts are not asserted as base units). notional is the QUOTE value of the forced order,
        // computed from the VERIFIED product-spec contractSize on a linear contract; where the contract meaning is not
        // verifiable (inverse, or an absent contractSize) the record is PARTIAL with UNIT_UNVERIFIED rather than a guess.
        const forced = taker; const liquidated = forced === 'SELL' ? 'LONG' : forced === 'BUY' ? 'SHORT' : 'UNKNOWN';
        const cs = m.spec.contractSize; const linearVerified = m.spec.linearity === 'LINEAR' && typeof cs === 'number' && cs > 0;
        const notional = linearVerified ? price * qty * cs : null;
        const nu = notional === null ? 'UNKNOWN' : m.spec.quote === 'USD' ? 'USD' : m.spec.quote === 'USDT' ? 'USDT' : m.spec.quote === 'USDC' ? 'USDC' : 'QUOTE';
        const ob = base.tryEmit({ endpointId: KF_STREAM_ENDPOINT_ID, subject: m.subject, kind: 'LIQUIDATION', sourceKey: tid !== null ? String(tid) : `${pid}:${msg.time}:${msg.price}`, sourceEventTs: ts, receivedTs, knownAtTs: receivedTs, epochId, quality: quality(notional === null ? 'PARTIAL' : 'KNOWN', { reasonCodes: notional === null ? ['UNIT_UNVERIFIED'] : [], methodologyId: `${KF_STREAM_METHODOLOGY}-trade-${type}`, originalUnit: m.spec.quote }), provenance: { requestId: null, bytesSha256, nativeLocator: tid !== null ? String(tid) : null, mappingId: 'kraken-futures-symbol-v1', specificationId: m.spec.specificationId, vintage: null },
          payload: { forcedOrderSide: forced, liquidatedPositionSide: liquidated, qtyBase: null, price, notional, notionalUnit: nu, aggregated: false, aggregationIntervalMs: null, longNotional: null, shortNotional: null, venueScope: 'kraken-futures' } });
        if (ob) { stats.liquidations += 1; onLiquidation(ob); }
        return;
      }
      // a plain matched fill: a DERIVATIVE subject cannot carry a TRADE observation (the schema reserves TRADE for spot
      // MARKET subjects), so a fill is surfaced as a plain fact — never a fabricated observation. Liquidations (the tagged
      // trades SDR needs) are proper LIQUIDATION observations above; the ticker's mark/index/OI is the DERIVATIVE_TICK.
      stats.trades += 1; onTrade(deepFreeze({ venue: 'kraken-futures', symbol: pid, price, qty, takerSide: taker, sourceEventTs: ts, receivedTs, nativeTradeId: tid !== null ? String(tid) : null, tradeType: 'fill' }));
      return;
    }
    if (feed === 'ticker') {
      if (!m) { stats.unknownSymbols += 1; return; }
      const p = tickPayload(m.spec, msg); const known = p.markPrice !== null && p.indexPrice !== null;
      const ob = base.tryEmit({ endpointId: KF_STREAM_ENDPOINT_ID, subject: m.subject, kind: 'DERIVATIVE_TICK', sourceKey: pid, sourceEventTs: tsFromMs(msg.time) ?? null, receivedTs, knownAtTs: receivedTs, epochId, quality: quality(known ? 'KNOWN' : 'PARTIAL', { reasonCodes: known ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: `${KF_STREAM_METHODOLOGY}-ticker`, originalUnit: `absolute ${m.spec.quote} per contract per hour` }), provenance: { requestId: null, bytesSha256, nativeLocator: pid, mappingId: 'kraken-futures-symbol-v1', specificationId: m.spec.specificationId, vintage: null }, payload: p });
      if (ob) { stats.ticks += 1; onTick(ob); }
      return;
    }
  }

  ws = createWsClient({ providerId: 'KRAKEN_DERIVATIVES', endpointId: KF_STREAM_ENDPOINT_ID, WebSocketImpl, clock: base.clock, log: base.log, url, onMessage,
    onOpen: ({ epochId, send }) => { currentEpoch = epochId; for (const b of books.values()) b.desync(); lastSeq.clear(); subscribed.clear(); base.setRuntime('ACTIVE'); const ids = [...byId.keys()]; send({ event: 'subscribe', feed: 'book', product_ids: ids }); send({ event: 'subscribe', feed: 'trade', product_ids: ids }); send({ event: 'subscribe', feed: 'ticker', product_ids: ids }); },
    onClose: ({ epochId }) => { const ts = base.clock(); for (const [pid, b] of books) { if (b.synced) onCoverage(base.coverage({ endpointId: KF_STREAM_ENDPOINT_ID, subject: byId.get(pid).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: ['EPOCH_GAP', 'DESYNCHRONIZED'], startTs: ts, epochId })); b.desync(); } lastSeq.clear(); subscribed.clear(); if (base.status().runtime === 'ACTIVE') base.setRuntime('DEGRADED'); } });

  return { start: () => { base.start(); ws.start(); }, stop: async () => { await ws.stop(); base.stop(); }, books, status: () => deepFreeze({ ...ws.status(), ...stats, synced: [...books.values()].filter((b) => b.synced).length, subscribed: [...subscribed].sort(), members: [...byId.keys()] }) };
}

const bookLevels = (b, depth) => ({ bids: b.sortedBids().slice(0, depth).map((l) => [l.price, l.qty]), asks: b.sortedAsks().slice(0, depth).map((l) => [l.price, l.qty]) });
