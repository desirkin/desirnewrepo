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
export const btcOnly = () => { const s = H.subjectsWith(); return loadSubjects({ ...s, subjects: [s.subjects[0]], stablecoins: [] }); };

// an INCLUDED_QUOTA plan for a paid on-chain provider (offline attestation; nothing here authorizes real spend)
export const includedPlan = (raw, id, { remaining = 100, included = 100, day = 100, month = 100, verifiedDate = '2026-09-08' } = {}) => {
  Object.assign(raw.providers[id].plan, { name: 'closeout fixture', billing: 'INCLUDED_QUOTA', includedCallsPerMonth: included, remainingCalls: remaining, incrementalUsdPerCall: 0, attestation: 'offline fixture only', verifiedDate });
  Object.assign(raw.providers[id].limits, { maxCallsPerDay: day, maxCallsPerMonth: month });
  return raw;
};
export const cryptoquantPolicy = (over = {}) => loadPolicy(includedPlan(H.policyWith({ providers: ['CRYPTOQUANT'] }), 'CRYPTOQUANT', over));
export const cryptoquantFetch = (requests = []) => async (url) => { const u = new URL(url); requests.push(u.pathname + u.search); const last = u.pathname.split('/').at(-1); const field = { inflow: 'inflow_total', outflow: 'outflow_total', reserve: 'reserve', 'addresses-count': 'addresses_count_active', 'transactions-count': 'transactions_count_total', 'tokens-transferred': 'tokens_transferred_total', supply: 'supply_total', mvrv: 'mvrv', sopr: 'sopr', 'realized-price': 'realized_price' }[last]; return field ? json(H.cryptoquantSeries({ field })) : json({ status: { code: 404 } }, 404); };

// Deribit / Bybit / Santiment fixtures were retired with their providers (SENSE-CULL-3).
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
// closeout P5: the pure validator closes the capture reference, so an in-memory context fixture carries a LAWFUL sealed reference
// (shape only — it names no real bundle; every suite that reopens a bundle uses the reader's own reference)
export const SEALED_REF = Object.freeze({ bundleId: `mb-${'0'.repeat(64)}`, manifestSha256: '1'.repeat(64), observationsSha256: '2'.repeat(64), coverageSha256: '3'.repeat(64) });
