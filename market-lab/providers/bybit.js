// D05 — BYBIT v5 public: instruments (cursor pagination), tickers, and the public linear stream with the official
// allLiquidation topic (S = liquidated POSITION side: "Buy" means a long position was liquidated, so the forced order
// was a SELL) and tickers snapshot/delta (an omitted delta field means "unchanged" ONLY inside a valid same-epoch
// snapshot state; across a gap it is unknown). Geographic restrictions are obeyed: a CloudFront country block is
// reported ACCESS_BLOCKED / GEO_RESTRICTED and never evaded with proxies or alternate identities.
import { createClientBase, num, int, str, tsFromMs, arr, obj, derivativeSubject } from './base.js';
import { createWsClient } from '../transport.js';
import { quality, deepFreeze } from '../contracts.js';
import { MINUTE_MS } from '../time.js';

export const BYBIT_VENUE = 'bybit';
export const BYBIT_MAPPING_ID = 'bybit-v5-instruments-v1';
const okRet = (j) => int(obj(j)?.retCode) === 0;
export function createBybitClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'BYBIT', transport, clock, log });
  const specs = new Map();
  const subjectFor = (s) => derivativeSubject({ canonicalCoin: s.base, providerAssetId: s.base, venue: BYBIT_VENUE, instrumentId: s.symbol, specificationId: s.specificationId, marketType: s.perpetual ? 'PERPETUAL' : 'FUTURE' });
  async function loadInstruments({ category = 'linear', symbol = null, signal, maxPages = 10 }) {
    let cursor = null; let pages = 0; const observations = []; let lastR = null;
    while (pages < maxPages) {
      const r = await base.call({ endpointId: 'rest-instruments', query: { category, ...(symbol ? { symbol } : {}), limit: 1000, ...(cursor ? { cursor } : {}) }, signal });
      if (!r.ok) return { ok: false, failure: r.failure, coverage: [], meta: { pages } };
      if (!okRet(r.json)) return { ok: false, failure: { kind: 'SCHEMA', reason: `retCode ${int(obj(r.json)?.retCode) ?? 'unknown'}`, coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
      pages += 1; lastR = r; const res = obj(obj(r.json)?.result);
      for (const raw of arr(res?.list) ?? []) {
        const i = obj(raw); const sym = str(i?.symbol, 40); const b = str(i?.baseCoin, 20); const q = str(i?.quoteCoin, 20); const settle = str(i?.settleCoin, 20); const ct = str(i?.contractType, 32); if (!sym || !b || !q || !settle || !ct) continue;
        const perpetual = /Perpetual/.test(ct); const linearity = /Inverse/.test(ct) ? 'INVERSE' : 'LINEAR'; const fundingIntervalMin = int(i.fundingInterval);
        const s = { symbol: sym, base: b, quote: q, settle, perpetual, linearity, contractType: ct, fundingIntervalMs: fundingIntervalMin ? fundingIntervalMin * MINUTE_MS : null, specificationId: `${sym}:${ct}:${settle}`, expiry: tsFromMs(i.deliveryTime) || null, status: str(i.status, 20) };
        specs.set(sym, s);
        const ob = base.tryEmit({ endpointId: 'rest-instruments', subject: subjectFor(s), kind: 'INSTRUMENT', sourceKey: sym, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: BYBIT_MAPPING_ID }), provenance: base.provenance(r, { nativeLocator: sym, mappingId: BYBIT_MAPPING_ID, specificationId: s.specificationId }),
          payload: { status: s.status ?? 'unknown', base: b, quote: q, marketType: perpetual ? 'PERPETUAL' : 'FUTURE', pricePrecision: null, qtyPrecision: null, priceIncrement: num(obj(i.priceFilter)?.tickSize), qtyIncrement: num(obj(i.lotSizeFilter)?.qtyStep), contractSize: null, linearity, settlementCurrency: settle, underlying: `${b}${q}`, expiryTs: perpetual ? null : s.expiry, strike: null, optionType: null, quoteAliasGroup: null, tradeable: s.status === 'Trading', fundingIntervalMs: perpetual ? s.fundingIntervalMs : null, fundingUnit: perpetual ? 'FRACTION_PER_INTERVAL' : 'UNKNOWN' } });
        if (ob) observations.push(ob);
      }
      cursor = str(res?.nextPageCursor, 200); if (!cursor) break;
    }
    return { ok: true, observations, coverage: [], meta: { requestId: lastR?.requestId ?? null, receivedTs: lastR?.receivedTs ?? null, pages, exhausted: pages >= maxPages && cursor !== null } };
  }
  const resolveInstrument = (symbol) => (specs.has(symbol) ? { ok: true, spec: specs.get(symbol), subject: subjectFor(specs.get(symbol)) } : { ok: false, reason: specs.size ? 'NOT_IN_CATALOG' : 'CATALOG_NOT_LOADED' });
  const tickPayload = (s, t, epochOk) => ({ markPrice: num(t.markPrice), indexPrice: num(t.indexPrice), lastPrice: num(t.lastPrice), bid: num(t.bid1Price), ask: num(t.ask1Price), openInterest: num(t.openInterest), openInterestUnit: num(t.openInterest) === null ? 'UNKNOWN' : 'BASE', fundingRateNative: s.perpetual ? num(t.fundingRate) : null, fundingUnit: s.perpetual && num(t.fundingRate) !== null ? 'FRACTION_PER_INTERVAL' : 'UNKNOWN', fundingIntervalMs: s.perpetual && num(t.fundingRate) !== null ? s.fundingIntervalMs : null, fundingRelative: null, fundingPredictedNative: null, nextFundingTs: tsFromMs(t.nextFundingTime) || null, volume24hBase: num(t.volume24h), volume24hQuote: num(t.turnover24h), contractMultiplier: null, settlementCurrency: s.settle, linearity: s.linearity, ...(epochOk ? {} : {}) });
  async function tickers({ symbols, category = 'linear', signal }) {
    const out = []; const coverage = [];
    for (const symbol of symbols) {
      const res = resolveInstrument(symbol); if (!res.ok) continue;
      const r = await base.call({ endpointId: 'rest-tickers', query: { category, symbol }, signal });
      if (!r.ok) { coverage.push(base.failureCoverage(r.failure, { endpointId: 'rest-tickers', subject: res.subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK', startTs: base.clock() })); continue; }
      const t = (arr(obj(obj(r.json)?.result)?.list) ?? []).map(obj).find((x) => x && x.symbol === symbol); if (!okRet(r.json) || !t) { coverage.push(base.coverage({ endpointId: 'rest-tickers', subject: res.subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK', state: 'GAP', reasonCodes: ['FIELD_MISSING_AT_SOURCE'], startTs: r.receivedTs, endTs: r.receivedTs })); continue; }
      const ob = base.tryEmit({ endpointId: 'rest-tickers', subject: res.subject, kind: 'DERIVATIVE_TICK', sourceKey: symbol, sourceEventTs: tsFromMs(obj(r.json)?.time), receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: 'bybit-v5-tickers-v1', originalUnit: res.spec.quote }), provenance: base.provenance(r, { nativeLocator: symbol, mappingId: BYBIT_MAPPING_ID, specificationId: res.spec.specificationId }), payload: tickPayload(res.spec, t, true) });
      if (ob) out.push(ob);
    }
    return { ok: true, observations: out, coverage, meta: {} };
  }
  // stream: allLiquidation + tickers(snapshot/delta) with epoch-bound merge state
  function createStream({ symbols, onObservation = () => {}, onCoverage = () => {}, WebSocketImpl, url = null }) {
    const state = new Map(); // symbol -> { epochId, snapshot fields }
    const stats = { liquidations: 0, tickers: 0, deltasWithoutSnapshot: 0, acks: 0 }; let ws = null; let currentEpoch = null;
    function onMessage(msg, { receivedTs, epochId, bytesSha256 }) {
      if (str(msg.op, 16) === 'subscribe') { stats.acks += 1; if (msg.success !== true) for (const sym of symbols) { const res = resolveInstrument(sym); if (res.ok) onCoverage(base.coverage({ endpointId: 'ws-public-linear', subject: res.subject, family: 'LIQUIDATIONS', state: 'FAILED', reasonCodes: ['PROVIDER_ERROR'], startTs: receivedTs, endTs: receivedTs, epochId })); } return; }
      const topic = str(msg.topic, 60); if (!topic) return; const [channel, sym] = topic.split('.'); const res = resolveInstrument(sym ?? ''); if (!res.ok) return;
      if (channel === 'allLiquidation') {
        for (const raw of arr(msg.data) ?? []) {
          const d = obj(raw); const ts = tsFromMs(d?.T); const posSide = str(d?.S, 8); const qty = num(d?.v); const price = num(d?.p); if (ts === null || qty === null || price === null) continue;
          const liquidated = posSide === 'Buy' ? 'LONG' : posSide === 'Sell' ? 'SHORT' : 'UNKNOWN'; const forced = liquidated === 'LONG' ? 'SELL' : liquidated === 'SHORT' ? 'BUY' : 'UNKNOWN';
          const ob = base.tryEmit({ endpointId: 'ws-public-linear', subject: res.subject, kind: 'LIQUIDATION', sourceKey: `${sym}:${d.T}:${d.p}:${d.v}`, sourceEventTs: ts, receivedTs, knownAtTs: receivedTs, epochId, quality: quality('KNOWN', { methodologyId: 'bybit-v5-allLiquidation-v1', originalUnit: res.spec.quote }), provenance: { requestId: null, bytesSha256, nativeLocator: `${sym}:${d.T}`, mappingId: BYBIT_MAPPING_ID, specificationId: res.spec.specificationId, vintage: null },
            payload: { forcedOrderSide: forced, liquidatedPositionSide: liquidated, qtyBase: qty, price, notional: qty * price, notionalUnit: res.spec.quote === 'USDT' ? 'USDT' : res.spec.quote === 'USDC' ? 'USDC' : 'QUOTE', aggregated: false, aggregationIntervalMs: null, longNotional: null, shortNotional: null, venueScope: BYBIT_VENUE } });
          if (ob) { stats.liquidations += 1; onObservation(ob); }
        }
        return;
      }
      if (channel === 'tickers') {
        const d = obj(msg.data); if (!d) return; const type = str(msg.type, 12); const st = state.get(sym);
        let merged; let epochOk = true;
        if (type === 'snapshot') { merged = { ...d }; state.set(sym, { epochId, fields: merged }); }
        else { if (!st || st.epochId !== epochId) { stats.deltasWithoutSnapshot += 1; epochOk = false; merged = { ...d }; } else { merged = { ...st.fields, ...d }; st.fields = merged; } }
        const ob = base.tryEmit({ endpointId: 'ws-public-linear', subject: res.subject, kind: 'DERIVATIVE_TICK', sourceKey: sym, sourceEventTs: tsFromMs(msg.ts), receivedTs, knownAtTs: receivedTs, epochId, quality: quality(epochOk ? 'KNOWN' : 'PARTIAL', { reasonCodes: epochOk ? [] : ['EPOCH_GAP'], methodologyId: 'bybit-v5-ws-tickers-v1', originalUnit: res.spec.quote }), provenance: { requestId: null, bytesSha256, nativeLocator: sym, mappingId: BYBIT_MAPPING_ID, specificationId: res.spec.specificationId, vintage: null }, payload: tickPayload(res.spec, merged, epochOk) });
        if (ob) { stats.tickers += 1; onObservation(ob); }
      }
    }
    ws = createWsClient({ providerId: 'BYBIT', endpointId: 'ws-public-linear', WebSocketImpl, clock: base.clock, log: base.log, url, onMessage, onOpen: ({ epochId, send }) => { currentEpoch = epochId; state.clear(); base.setRuntime('ACTIVE'); send({ op: 'subscribe', args: symbols.flatMap((s) => [`allLiquidation.${s}`, `tickers.${s}`]) }); }, onClose: () => { state.clear(); if (base.status().runtime === 'ACTIVE') base.setRuntime('DEGRADED'); } });
    return { start: () => { base.start(); ws.start(); }, stop: async () => { await ws.stop(); base.stop(); }, status: () => ({ ...ws.status(), ...stats, epoch: currentEpoch }) };
  }
  return { ...base, loadInstruments, resolveInstrument, tickers, createStream, specs: () => deepFreeze(Object.fromEntries(specs)) };
}
