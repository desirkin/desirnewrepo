// MARKET LAB test helpers: a real loopback HTTP fixture server (documented provider responses, exact request capture), a
// dependency-free loopback WebSocket server (RFC 6455 text frames: handshake, masked client frames, unmasked server
// frames, close), a fetch implementation that routes the clients' registry URLs to the fixture (host recorded, never
// reached), and small policy / subjects builders. Nothing here touches a provider, a credential value or the network.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { samplePolicy, sampleSubjects } from '../../market-lab/policy.js';

export const T0 = Date.parse('2026-09-08T12:00:00Z');

// ---- HTTP fixture: routes = { 'GET /0/public/AssetPairs': (req) => ({ status, json | body, headers }) } ---------------------
export async function startHttpFixture(routes) {
  const requests = []; const handlers = { ...routes };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1'); const key = `${req.method} ${url.pathname}`;
      const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), headers: req.headers, host: req.headers['x-fixture-host'] ?? null, body: raw, url: url.pathname + url.search };
      requests.push(rec);
      const h = handlers[key] ?? handlers['*'];
      if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no fixture route"}'); return; }
      let out; try { out = typeof h === 'function' ? h(rec) : h; } catch (err) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(err?.message ?? err)); return; }
      const status = out.status ?? 200; const headers = { 'content-type': out.contentType ?? (out.json !== undefined ? 'application/json' : 'text/plain'), ...(out.headers ?? {}) };
      const body = out.json !== undefined ? (typeof out.json === 'string' ? out.json : JSON.stringify(out.json)) : (out.body ?? '');
      if (out.delayMs) { setTimeout(() => { res.writeHead(status, headers); res.end(body); }, out.delayMs); return; }
      res.writeHead(status, headers); res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, requests, routes: handlers, set: (k, v) => { handlers[k] = v; }, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }), url: `http://127.0.0.1:${port}` };
}
// route the registry's https://<host>/path to the fixture; the intended host travels as a header so tests can assert it
export const fetchFor = (fixture, { hostRewrite = null } = {}) => async (url, init = {}) => {
  const u = new URL(url); const target = `${fixture.url}${u.pathname}${u.search}`;
  const headers = { ...(init.headers ?? {}), 'x-fixture-host': hostRewrite ? hostRewrite(u.host) : u.host };
  return fetch(target, { ...init, headers });
};

// ---- WebSocket fixture (loopback, no dependency) ------------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function encodeFrame(payload, opcode = 0x1) {
  const buf = Buffer.from(payload); const len = buf.length; let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65_536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, buf]);
}
function decodeFrames(buffer, onFrame) {
  let off = 0;
  while (buffer.length - off >= 2) {
    const b0 = buffer[off]; const b1 = buffer[off + 1]; const opcode = b0 & 0x0f; const masked = (b1 & 0x80) !== 0; let len = b1 & 0x7f; let p = off + 2;
    if (len === 126) { if (buffer.length < p + 2) break; len = buffer.readUInt16BE(p); p += 2; } else if (len === 127) { if (buffer.length < p + 8) break; len = Number(buffer.readBigUInt64BE(p)); p += 8; }
    let mask = null; if (masked) { if (buffer.length < p + 4) break; mask = buffer.subarray(p, p + 4); p += 4; }
    if (buffer.length < p + len) break;
    const data = Buffer.from(buffer.subarray(p, p + len)); if (mask) for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
    onFrame({ opcode, data }); off = p + len;
  }
  return buffer.subarray(off);
}
export async function startWsFixture({ onConnection = () => {}, path = '/' } = {}) {
  const connections = []; const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']; if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { socket, received: [], closed: false, path: req.url, send: (obj) => { if (!conn.closed) socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); }, sendRaw: (text) => { if (!conn.closed) socket.write(encodeFrame(text)); }, close: () => { if (conn.closed) return; conn.closed = true; try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch { /* ignore */ } socket.end(); }, destroy: () => { conn.closed = true; socket.destroy(); }, handlers: [] };
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => { pending = decodeFrames(Buffer.concat([pending, chunk]), ({ opcode, data }) => { if (opcode === 0x8) { if (!conn.closed) { conn.closed = true; try { socket.write(encodeFrame(data, 0x8)); } catch { /* ignore */ } } try { socket.end(); } catch { /* ignore */ } setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } }, 50); return; } if (opcode === 0x9) { socket.write(encodeFrame(data, 0xa)); return; } if (opcode === 0x1) { let msg = null; try { msg = JSON.parse(data.toString('utf8')); } catch { msg = data.toString('utf8'); } conn.received.push(msg); for (const h of conn.handlers) h(msg); } }); });
    socket.on('close', () => { conn.closed = true; }); socket.on('error', () => { conn.closed = true; });
    connections.push(conn); onConnection(conn);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, url: `ws://127.0.0.1:${port}${path}`, connections, close: () => new Promise((resolve) => { for (const c of connections) c.destroy(); server.close(() => resolve()); server.closeAllConnections?.(); }) };
}
export const waitFor = async (pred, { timeoutMs = 4000, stepMs = 10 } = {}) => { const t0 = Date.now(); for (;;) { const v = pred(); if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, stepMs)); } };

// ---- policy / subjects builders ------------------------------------------------------------------------------------------
export function policyWith({ providers = [], model = {}, cases = {}, mode = 'LIVE_OBSERVATION', paid = {} } = {}) {
  const p = structuredClone(samplePolicy()); p.mode = mode;
  for (const id of providers) p.providers[id].enabled = true;
  for (const [id, plan] of Object.entries(paid)) { p.providers[id].enabled = true; p.providers[id].plan = { ...p.providers[id].plan, ...plan }; if (plan.smoke) p.providers[id].smoke = plan.smoke; }
  Object.assign(p.model, model); Object.assign(p.cases, cases);
  return p;
}
export function subjectsWith(over = {}) { const s = structuredClone(sampleSubjects()); return { ...s, ...over }; }
export const clockAt = (start) => { let t = start; const c = () => t; c.advance = (ms) => { t += ms; return t; }; c.set = (v) => { t = v; }; return c; };

// ---- documented provider fixtures (shapes follow the public API docs each client parses) -------------------------------------
export const KRAKEN_ASSET_PAIRS = { error: [], result: { XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 8, tick_size: '0.1', ordermin: '0.00005', status: 'online' }, XETHZUSD: { altname: 'ETHUSD', wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', pair_decimals: 2, lot_decimals: 8, tick_size: '0.01', ordermin: '0.002', status: 'online' }, SOLUSD: { altname: 'SOLUSD', wsname: 'SOL/USD', base: 'SOL', quote: 'ZUSD', pair_decimals: 2, lot_decimals: 8, tick_size: '0.01', ordermin: '0.02', status: 'online' }, XETHXXBT: { altname: 'ETHXBT', wsname: 'ETH/XBT', base: 'XETH', quote: 'XXBT', pair_decimals: 5, lot_decimals: 8, tick_size: '0.00001', ordermin: '0.002', status: 'online' } } };
// documented OHLC: [time, open, high, low, close, vwap, volume, count]; the LAST row is the current (uncommitted) bar and `last` names the last committed bar
export const krakenOhlc = (pairKey, { count = 5, intervalMin = 1, endTs = T0, closePrice = 100 } = {}) => { const iv = intervalMin * 60_000; const currentOpen = Math.floor(endTs / iv) * iv; const rows = []; for (let i = count - 1; i >= 0; i -= 1) { const open = currentOpen - i * iv; rows.push([open / 1000, String(closePrice - 1), String(closePrice + 1), String(closePrice - 2), String(closePrice), String(closePrice), '12.5', 40]); } return { error: [], result: { [pairKey]: rows, last: rows[rows.length - 2][0] } }; };
export const krakenTrades = (pairKey, { count = 3, endTs = T0, price = 100 } = {}) => ({ error: [], result: { [pairKey]: Array.from({ length: count }, (_, i) => [String(price + i * 0.1), '0.5', (endTs - (count - i) * 1000) / 1000, i % 2 ? 's' : 'b', 'm', '', 1000 + i]), last: String((endTs - 1000) * 1_000_000) } });
export const krakenTicker = (pairKey, { bid = 99, ask = 101 } = {}) => ({ error: [], result: { [pairKey]: { a: [String(ask), '1', '1.000'], b: [String(bid), '1', '1.000'], c: ['100', '0.1'] } } });
export const COINBASE_PRODUCTS = [{ id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', status: 'online', trading_disabled: false, fx_stablecoin: false, quote_increment: '0.01', base_increment: '0.00000001' }, { id: 'BTC-USDC', base_currency: 'BTC', quote_currency: 'USDC', status: 'online', trading_disabled: false, fx_stablecoin: true, quote_increment: '0.01', base_increment: '0.00000001' }, { id: 'ETH-USD', base_currency: 'ETH', quote_currency: 'USD', status: 'online', trading_disabled: false, quote_increment: '0.01', base_increment: '0.00000001' }];
export const coinbaseTrades = ({ count = 3, endTs = T0, price = 100 } = {}) => Array.from({ length: count }, (_, i) => ({ trade_id: 500 + i, price: String(price + i * 0.1), size: '0.25', time: new Date(endTs - (count - i) * 1000).toISOString(), side: i % 2 ? 'buy' : 'sell' }));
export const coinbaseBook = ({ bid = 99, ask = 101, ts = T0 } = {}) => ({ sequence: 1, bids: [[String(bid), '2', 1], [String(bid - 1), '3', 1]], asks: [[String(ask), '2', 1], [String(ask + 1), '3', 1]], time: new Date(ts).toISOString() });
export const KF_INSTRUMENTS = { result: 'success', instruments: [{ symbol: 'PF_XBTUSD', type: 'flexible_futures', tradeable: true, contractSize: 1, tickSize: 0.5, lastTradingTime: null }, { symbol: 'PF_ETHUSD', type: 'flexible_futures', tradeable: true, contractSize: 1, tickSize: 0.05 }] };
export const kfTickers = ({ symbol = 'PF_XBTUSD', mark = 101, index = 100, funding = 0.0001, oi = 1000 } = {}) => ({ result: 'success', tickers: [{ symbol, markPrice: mark, indexPrice: index, last: mark, bid: mark - 0.5, ask: mark + 0.5, openInterest: oi, fundingRate: funding, fundingRatePrediction: funding, lastTime: new Date(T0 - 1000).toISOString(), vol24h: 1234, volumeQuote: 123456 }] });
export const DERIBIT_INSTRUMENTS = { result: [{ instrument_name: 'BTC-26SEP26-100000-C', kind: 'option', base_currency: 'BTC', quote_currency: 'USD', settlement_currency: 'BTC', option_type: 'call', strike: 100000, expiration_timestamp: T0 + 18 * 86_400_000, contract_size: 1, is_active: true, instrument_type: 'reversed', price_index: 'btc_usd', tick_size: 0.0005, min_trade_amount: 0.1 }, { instrument_name: 'BTC-26SEP26-100000-P', kind: 'option', base_currency: 'BTC', quote_currency: 'USD', settlement_currency: 'BTC', option_type: 'put', strike: 100000, expiration_timestamp: T0 + 18 * 86_400_000, contract_size: 1, is_active: true, instrument_type: 'reversed', price_index: 'btc_usd', tick_size: 0.0005, min_trade_amount: 0.1 }] };
export const deribitSummaries = () => ({ result: [{ instrument_name: 'BTC-26SEP26-100000-C', mark_iv: 65, open_interest: 120, mark_price: 0.05, underlying_price: 100_500, underlying_index: 'SYN.BTC-26SEP26', volume: 10, bid_price: 0.049, ask_price: 0.051, creation_timestamp: T0 - 500 }, { instrument_name: 'BTC-26SEP26-100000-P', mark_iv: 70, open_interest: 90, mark_price: 0.04, underlying_price: 100_500, underlying_index: 'SYN.BTC-26SEP26', volume: 5, bid_price: 0.039, ask_price: 0.041, creation_timestamp: T0 - 500 }] });
export const BYBIT_INSTRUMENTS = (cursor = null) => ({ retCode: 0, retMsg: 'OK', result: { category: 'linear', list: [{ symbol: cursor ? 'ETHUSDT' : 'BTCUSDT', baseCoin: cursor ? 'ETH' : 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', fundingInterval: 480, status: 'Trading', deliveryTime: '0', priceFilter: { tickSize: '0.10' }, lotSizeFilter: { qtyStep: '0.001' } }], nextPageCursor: cursor ? '' : 'page2' }, time: T0 });
export const bybitTickers = (symbol = 'BTCUSDT') => ({ retCode: 0, retMsg: 'OK', result: { category: 'linear', list: [{ symbol, markPrice: '101', indexPrice: '100', lastPrice: '101', bid1Price: '100.9', ask1Price: '101.1', openInterest: '1500', fundingRate: '0.0001', nextFundingTime: String(T0 + 3600_000), turnover24h: '1000000', volume24h: '9000' }] }, time: T0 });
export const COINGECKO_LIST = [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} }, { id: 'ethereum', symbol: 'eth', name: 'Ethereum', platforms: { ethereum: '' } }, { id: 'solana', symbol: 'sol', name: 'Solana', platforms: {} }];
export const coingeckoMarkets = () => [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100_000, market_cap: 2e12, fully_diluted_valuation: 2.1e12, total_volume: 3e10, circulating_supply: 19_900_000, total_supply: 21_000_000, max_supply: 21_000_000, last_updated: new Date(T0 - 60_000).toISOString() }];
export const DEFILLAMA_STABLECOINS = { peggedAssets: [{ id: '1', name: 'Tether', symbol: 'USDT', pegType: 'peggedUSD', price: 1.0004, circulating: { peggedUSD: 1.5e11 }, chainCirculating: { Ethereum: { current: { peggedUSD: 6e10 } }, 'Tron Chain': { current: { peggedUSD: 7e10 } } } }, { id: '2', name: 'USD Coin', symbol: 'USDC', pegType: 'peggedUSD', price: 0.9998, circulating: { peggedUSD: 6e10 }, chainCirculating: { Ethereum: { current: { peggedUSD: 4e10 } } } }] };
export const COINMETRICS_CATALOG = { data: [{ asset: 'btc', metrics: [{ metric: 'AdrActCnt', frequencies: [{ frequency: '1d', min_time: '2010-01-01T00:00:00.000000000Z', max_time: '2026-09-07T00:00:00.000000000Z', community: true }] }, { metric: 'TxCnt', frequencies: [{ frequency: '1d', min_time: '2010-01-01T00:00:00.000000000Z', max_time: '2026-09-07T00:00:00.000000000Z', community: true }] }, { metric: 'CapMVRVCur', frequencies: [{ frequency: '1d', community: false }] }] }] };
export const coinmetricsSeries = (token = null) => ({ data: [{ asset: 'btc', time: '2026-09-06T00:00:00.000000000Z', AdrActCnt: '812345', TxCnt: '401234' }, { asset: 'btc', time: '2026-09-07T00:00:00.000000000Z', AdrActCnt: '820000', TxCnt: '405000' }], ...(token ? { next_page_token: token } : {}) });
export const FRED_SERIES = { seriess: [{ id: 'CPIAUCSL', title: 'Consumer Price Index for All Urban Consumers', units: 'Index 1982-1984=100', units_short: 'Index', frequency_short: 'M', last_updated: '2026-09-05 07:31:02-05', observation_start: '1947-01-01', observation_end: '2026-08-01' }] };
export const FRED_OBSERVATIONS = { observations: [{ realtime_start: '2026-09-05', realtime_end: '9999-12-31', date: '2026-08-01', value: '321.5' }, { realtime_start: '2026-08-08', realtime_end: '9999-12-31', date: '2026-07-01', value: '320.9' }, { realtime_start: '2026-07-11', realtime_end: '9999-12-31', date: '2026-06-01', value: '.' }] };
export const TWELVEDATA_SEARCH = { data: [{ symbol: 'SPY', instrument_name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE', mic_code: 'ARCX', instrument_type: 'ETF', currency: 'USD' }], status: 'ok' };
export const twelvedataQuote = () => ({ symbol: 'SPY', name: 'SPDR S&P 500', exchange: 'NYSE', currency: 'USD', datetime: '2026-09-08', timestamp: Math.floor((T0 - 60_000) / 1000), open: '640.1', high: '642.0', low: '638.5', close: '641.2', volume: '1200000', previous_close: '639.0', is_market_open: true });
export const twelvedataSeries = () => ({ meta: { symbol: 'SPY', interval: '1h', currency: 'USD', exchange: 'NYSE', type: 'ETF' }, values: [{ datetime: '2026-09-08 10:00:00', open: '640', high: '641', low: '639', close: '640.5', volume: '100' }, { datetime: '2026-09-08 09:00:00', open: '639', high: '640', low: '638', close: '640', volume: '120' }], status: 'ok' });
export const TOKENOMIST_LIST = { metadata: { credit: { used: 3, limit: 1000, resetAt: '2026-10-01T00:00:00Z' } }, status: true, data: [{ tokenId: 'solana', symbol: 'SOL', name: 'Solana' }] };
export const tokenomistEvents = () => ({ metadata: { credit: { used: 4, limit: 1000, resetAt: '2026-10-01T00:00:00Z' } }, status: true, data: { events: [{ timestamp: Date.UTC(2026, 8, 11), cliffAmount: 25_000_000, cliffValue: 5_000_000_000, allocations: [{ standardAllocation: 'team', allocationName: 'Team' }] }], totalPages: 1 } });
export const COINGLASS_VESTING = { code: '0', msg: 'success', data: { total_locked: 1e9, total_unlocked: 4e8, total_untracked: 5e7, circulating_supply: 4.2e8, allocations: [{ name: 'Team', is_untracked: false, unlock_type: 'nonlinear', next_unlock: { date: T0 + 3 * 86_400_000, next_unlock_token_amount: 25_000_000 } }, { name: 'Ecosystem', is_untracked: true }] } };
export const coinglassLiquidations = () => ({ code: '0', msg: 'success', data: [{ time: T0 - 7_200_000, aggregated_long_liquidation_usd: 4_200_000, aggregated_short_liquidation_usd: 300_000 }, { time: T0 - 3_600_000, aggregated_long_liquidation_usd: 1_000_000, aggregated_short_liquidation_usd: 200_000 }] });
export const coinglassEconomic = () => ({ code: '0', msg: 'success', data: [{ calendar_name: 'CPI m/m', country_code: 'US', publish_timestamp: T0 - 5_400_000, has_exact_publish_time: 1, forecast_value: '0.2%', published_value: '0.3%', previous_value: '0.1%', revised_previous_value: null }] });
export const cryptoquantSeries = ({ field = 'inflow_total' } = {}) => ({ status: { code: 200, message: 'success' }, result: { window: 'day', data: [{ date: '2026-09-06', [field]: 12000 }, { date: '2026-09-07', [field]: 7000 }] } });
export const santimentSeries = () => ({ data: { getMetric: { timeseriesData: [{ datetime: '2026-09-06T00:00:00Z', value: 12000 }, { datetime: '2026-09-07T00:00:00Z', value: 7000 }] } } });
export const geckoPool = () => ({ data: { id: 'solana_pool1', type: 'pool', attributes: { address: 'pool1', name: 'SOL / USDC', base_token_price_usd: '200.5', base_token_price_quote_token: '200.4', reserve_in_usd: '5000000', volume_usd: { h1: '100000', h24: '2000000' }, transactions: { h24: { buys: 500, sells: 480 } } }, relationships: { base_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } }, quote_token: { data: { id: 'solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } }, dex: { data: { id: 'raydium' } } } } });
