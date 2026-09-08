// MARKET / SOCRATES CLOSEOUT — shared offline fixtures for the MC- acceptance suites (fake HTTP, fake clocks, temp dirs).
// Nothing here reaches a provider or a model; every fixture value is stated so tests can carry an independent oracle.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as H from './market-lab.js';
import { createResearchOwner } from '../../market-lab/owner.js';
import { loadPolicy, loadSubjects } from '../../market-lab/policy.js';

export const T0 = H.T0;
export const tmp = (prefix = 'mc-') => mkdtempSync(path.join(tmpdir(), prefix));
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
export const subjects = () => loadSubjects(H.subjectsWith());
export const btcOnly = () => { const s = H.subjectsWith(); return loadSubjects({ ...s, subjects: [s.subjects[0]], macroSeries: [], crossAsset: [], stablecoins: [] }); };

// an INCLUDED_QUOTA plan for a paid on-chain provider (offline attestation; nothing here authorizes real spend)
export const includedPlan = (raw, id, { remaining = 100, included = 100, day = 100, month = 100, verifiedDate = '2026-09-08' } = {}) => {
  Object.assign(raw.providers[id].plan, { name: 'closeout fixture', billing: 'INCLUDED_QUOTA', includedCallsPerMonth: included, remainingCalls: remaining, incrementalUsdPerCall: 0, attestation: 'offline fixture only', verifiedDate });
  Object.assign(raw.providers[id].limits, { maxCallsPerDay: day, maxCallsPerMonth: month });
  return raw;
};
export const cryptoquantPolicy = (over = {}) => loadPolicy(includedPlan(H.policyWith({ providers: ['CRYPTOQUANT'] }), 'CRYPTOQUANT', over));
export const cryptoquantFetch = (requests = []) => async (url) => { const u = new URL(url); requests.push(u.pathname + u.search); const last = u.pathname.split('/').at(-1); const field = { inflow: 'inflow_total', outflow: 'outflow_total', reserve: 'reserve', 'addresses-count': 'addresses_count_active', 'transactions-count': 'transactions_count_total', 'tokens-transferred': 'tokens_transferred_total', supply: 'supply_total', mvrv: 'mvrv', sopr: 'sopr', 'realized-price': 'realized_price' }[last]; return field ? json(H.cryptoquantSeries({ field })) : json({ status: { code: 404 } }, 404); };

// Deribit: four instruments whose 25-delta oracle is RR = 0.60 - 0.72 = -0.12 and BF = (0.60 + 0.72) / 2 - 0.65 = 0.01
export const DERIBIT_SPEC = Object.freeze({ 'BTC-26SEP26-100000-C': { iv: 65, delta: 0.55 }, 'BTC-26SEP26-110000-C': { iv: 60, delta: 0.25 }, 'BTC-26SEP26-100000-P': { iv: 70, delta: -0.45 }, 'BTC-26SEP26-90000-P': { iv: 72, delta: -0.25 } });
export const deribitTicker = (name, { greeks = true } = {}) => { const spec = DERIBIT_SPEC[name]; if (!spec) return null; return { result: { instrument_name: name, mark_iv: spec.iv, bid_iv: spec.iv - 1, ask_iv: spec.iv + 1, ...(greeks ? { greeks: { delta: spec.delta, gamma: 0.00001, vega: 50, theta: -20 } } : {}), mark_price: 0.05, underlying_price: 100_500, underlying_index: 'SYN.BTC-26SEP26', open_interest: 100, stats: { volume: 10, volume_usd: 1000 }, best_bid_price: 0.049, best_ask_price: 0.051, timestamp: T0 - 400 } }; };
export const DERIBIT_FOUR = { result: [...H.DERIBIT_INSTRUMENTS.result, { ...H.DERIBIT_INSTRUMENTS.result[0], instrument_name: 'BTC-26SEP26-110000-C', strike: 110000 }, { ...H.DERIBIT_INSTRUMENTS.result[1], instrument_name: 'BTC-26SEP26-90000-P', strike: 90000 }] };
export const deribitFourSummaries = (names = Object.keys(DERIBIT_SPEC)) => ({ result: DERIBIT_FOUR.result.filter((i) => names.includes(i.instrument_name)).map((i) => ({ instrument_name: i.instrument_name, mark_iv: DERIBIT_SPEC[i.instrument_name].iv, open_interest: 100, mark_price: 0.05, underlying_price: 100_500, underlying_index: 'SYN.BTC-26SEP26', volume: 10, bid_price: 0.049, ask_price: 0.051, creation_timestamp: T0 - 500 })) });
export function deribitOwner(paths, { instruments = DERIBIT_FOUR, summaries = deribitFourSummaries(), ticker = deribitTicker, resources = null, clock = () => T0 } = {}) {
  const raw = H.policyWith({ providers: ['DERIBIT'] }); if (resources) Object.assign(raw.resources, resources);
  return createResearchOwner({ policy: loadPolicy(raw), subjects: subjects(), clock, researchRoot: tmp(), fetchImpl: async (url) => { const u = new URL(url); paths.push(u.pathname + u.search); if (u.pathname.endsWith('get_instruments')) return json(instruments); if (u.pathname.endsWith('get_book_summary_by_currency')) return json(summaries); if (u.pathname.endsWith('/ticker')) { const t = ticker(u.searchParams.get('instrument_name')); return t ? json(t) : json({ error: { code: 1, message: 'not found' } }, 400); } return json({}, 404); } });
}
export async function krakenBookOnly({ clock = () => T0, bid = 99, ask = 101 } = {}) {
  const kp = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] }));
  const ko = createResearchOwner({ policy: kp, subjects: subjects(), clock, fetchImpl: async (url) => json(new URL(url).pathname.endsWith('AssetPairs') ? H.KRAKEN_ASSET_PAIRS : H.krakenTicker('XXBTZUSD', { bid, ask })), researchRoot: tmp() });
  await ko.clients.KRAKEN_SPOT.loadCatalog(); const market = ko.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market;
  return { ko, market };
}
export const bookObs = (ko, market, { bids, asks, receivedTs = T0 }) => ko.clients.KRAKEN_SPOT.bookSnapshotObservation({ market, levels: { bids, asks }, receivedTs, epochId: null, synced: true, checksumOk: true, sampleReason: 'INTERVAL', pricePrecision: 1, qtyPrecision: 8 });

// the Kraken WS v2 fixture used by the positive-coverage suites: instrument + book snapshots, a trade-channel subscribe ACK
// (the positive continuity fact) and, optionally, scripted trades; nothing is sent that the fixture was not asked to send
export function krakenWsScript({ trades = () => [], ackTrade = true } = {}) {
  return (conn) => { conn.handlers.push((msg) => { if (msg.method !== 'subscribe') return; const ch = msg.params.channel;
    if (ch === 'instrument') conn.send({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'BTC/USD', price_precision: 1, qty_precision: 8 }] } });
    if (ch === 'trade' && ackTrade) { conn.send({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'BTC/USD', snapshot: false }, time_in: new Date().toISOString(), time_out: new Date().toISOString() }); const list = trades(); if (list.length) conn.send({ channel: 'trade', type: 'update', data: list }); }
    if (ch === 'book') conn.send({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 99.5, qty: 2 }, { price: 99.0, qty: 3 }], asks: [{ price: 100.5, qty: 2 }, { price: 101.0, qty: 3 }] }] });
  }); };
}
export const krakenTradeMsg = (i, { price = 100, qty = 0.2, side = 'buy', ts = Date.now() } = {}) => ({ symbol: 'BTC/USD', side, price, qty, ord_type: 'market', trade_id: 1000 + i, timestamp: new Date(ts).toISOString() });
export async function krakenRestFixture() {
  const now = () => Date.now();
  return H.startHttpFixture({ 'GET /0/public/AssetPairs': { json: H.KRAKEN_ASSET_PAIRS }, 'GET /0/public/OHLC': (req) => ({ json: H.krakenOhlc(req.query.pair, { intervalMin: Number(req.query.interval), endTs: now(), count: 30 }) }), 'GET /0/public/Trades': (req) => ({ json: H.krakenTrades(req.query.pair, { endTs: now() }) }), 'GET /0/public/Ticker': (req) => ({ json: H.krakenTicker(req.query.pair.split(',')[0]) }), '*': { status: 404, json: { error: 'no fixture' } } });
}
export { H };
