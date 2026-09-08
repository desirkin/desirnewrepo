// EXECUTION — the real Kraken SPOT adapter (ticket §7.2-7.4). Working implementation, never a stub: official nonce /
// signing with exact signed bytes (published test vector), one serialized durable nonce allocator per key identity
// shared by every private read AND order, a FIXED REST allowlist under https://api.kraken.com (no withdrawal / transfer /
// margin / leverage endpoints exist here; any other URL is refused before a socket opens), REST IOC limit entry with the
// documented conditional close (close[ordertype] / close[price], trigger=last, deadline inside the documented REST range),
// documented in-place AmendOrder trigger updates, CancelOrder, GetApiKeyInfo with the echoed key REDACTED (only
// allowlisted permission facts + a fingerprint persist), WebSocket v2 executions with sequence-gap detection, paginated
// REST reconciliation with overlap dedup and explicit incomplete-page outcomes. Credentials come ONLY from an injected
// secret source (environment / secret store), never from CLI positional arguments, artifacts, UI responses or logs.
// No private call runs unless the composition supplies credentials AND the mode / owner request permits it.
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteJson } from '../lib/jsonl.js';
import * as M from './money.js';
import { adapterEvent } from './adapter-contract.js';
import { keyFingerprint, instrumentSpec, parseStrictJson } from './contract.js';
import { parseLexemes } from './feed.js';

export const KRAKEN_REST_BASE = 'https://api.kraken.com';
export const KRAKEN_WS_AUTH_URL = 'wss://ws-auth.kraken.com/v2';
// the closed REST allowlist: public time / pairs; private balance, orders, trades, ledgers (read), order create / cancel /
// amend, websocket token and key info. Withdraw*, WalletTransfer, Deposit*, Staking, Earn, margin / leverage: ABSENT.
export const KRAKEN_ENDPOINTS = Object.freeze({
  Time: { path: '/0/public/Time', private: false, kind: 'READ' }, AssetPairs: { path: '/0/public/AssetPairs', private: false, kind: 'READ' },
  Balance: { path: '/0/private/Balance', private: true, kind: 'READ' }, OpenOrders: { path: '/0/private/OpenOrders', private: true, kind: 'READ' }, ClosedOrders: { path: '/0/private/ClosedOrders', private: true, kind: 'READ' }, QueryOrders: { path: '/0/private/QueryOrders', private: true, kind: 'READ' }, TradesHistory: { path: '/0/private/TradesHistory', private: true, kind: 'READ' }, QueryTrades: { path: '/0/private/QueryTrades', private: true, kind: 'READ' }, Ledgers: { path: '/0/private/Ledgers', private: true, kind: 'READ' },
  AddOrder: { path: '/0/private/AddOrder', private: true, kind: 'ORDER' }, CancelOrder: { path: '/0/private/CancelOrder', private: true, kind: 'ORDER' }, AmendOrder: { path: '/0/private/AmendOrder', private: true, kind: 'ORDER' },
  GetWebSocketsToken: { path: '/0/private/GetWebSocketsToken', private: true, kind: 'READ' }, GetApiKeyInfo: { path: '/0/private/GetApiKeyInfo', private: true, kind: 'READ' },
});
export const FORBIDDEN_ENDPOINT_RE = /withdraw|wallettransfer|transfer|deposit|stak|earn|margin|leverage|lend|borrow|settle/i;
for (const e of Object.values(KRAKEN_ENDPOINTS)) if (FORBIDDEN_ENDPOINT_RE.test(e.path)) throw new Error('allowlist carries a forbidden endpoint');
// closed permission vocabulary as documented in the Kraken key management UI; anything outside it is AMBIGUOUS (blocks arm)
export const KRAKEN_PERMISSIONS = Object.freeze({ REQUIRED: ['Query Funds', 'Query Open Orders & Trades', 'Query Closed Orders & Trades', 'Create & Modify Orders', 'Cancel & Close Orders'], FORBIDDEN: ['Withdraw Funds', 'Deposit Funds', 'Query Ledger Entries', 'Export Data', 'Access WebSockets API'].filter((p) => p !== 'Query Ledger Entries' && p !== 'Access WebSockets API') });
export const KRAKEN_KNOWN_PERMISSIONS = Object.freeze([...KRAKEN_PERMISSIONS.REQUIRED, 'Withdraw Funds', 'Deposit Funds', 'Query Ledger Entries', 'Export Data', 'Access WebSockets API', 'Create & Modify Orders (Margin)']);
export const REST_TIMEOUTS = Object.freeze({ readMs: 5000, entryMs: 5000, safetyMs: 5000 });
export const NO_ACCEPTANCE_ERRORS = /^(EOrder:Invalid|EOrder:Insufficient funds|EOrder:Unknown asset pair|EOrder:Cannot open|EGeneral:Invalid arguments|EOrder:Trading agreement|EOrder:Orders limit exceeded|EOrder:Rate limit|EService:Market in cancel_only|EService:Market in post_only|EService:Unavailable|EGeneral:Permission denied|EAPI:Invalid key|EAPI:Invalid signature|EAPI:Invalid nonce|EOrder:Reduce only)/;

// ---- signing (published vector reproduces): API-Sign = HMAC-SHA512(path + SHA256(nonce + postdata), base64(secret)) --------------
export function encodeForm(params) { return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&'); }
export function signRequest({ path: urlPath, nonce, params, secret }) {
  const postData = encodeForm({ nonce: String(nonce), ...params }); const sha = createHash('sha256').update(`${nonce}${postData}`).digest();
  const signature = createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(urlPath, 'utf8'), sha])).digest('base64');
  return { postData, signature };
}
// ---- durable serialized nonce allocator per key identity (monotone across restarts and backward wall clocks) --------------------
export function createNonceStore({ dir, fingerprint, wall = Date.now }) {
  const file = path.join(dir, `kraken-nonce-${fingerprint}.json`); let last = 0n; let chain = Promise.resolve();
  if (existsSync(file)) { try { const j = parseStrictJson(readFileSync(file, 'utf8')); if (typeof j.last === 'string' && /^\d+$/.test(j.last)) last = BigInt(j.last); } catch { /* unreadable: start from the wall clock, still monotone from here */ } }
  const allocate = () => { const candidate = BigInt(wall()) * 1000n; const next = candidate > last ? candidate : last + 1n; last = next; atomicWriteJson(file, { fingerprint, last: next.toString(), ts: wall() }); return next.toString(); };
  // every caller (reads and orders) serializes through ONE chain: query traffic cannot race order nonces
  return { next: () => { const p = chain.then(allocate); chain = p.catch(() => {}); return p; }, peek: () => last.toString(), file };
}

const iso = (ms) => new Date(ms).toISOString();
const lex = (v) => { if (v === null || v === undefined) return null; try { return M.fromNumberLexeme(typeof v === 'string' ? v : String(v)); } catch { return null; } };
export function redactKeyInfo(info, fingerprint) {
  const perms = Array.isArray(info?.permissions) ? info.permissions.filter((p) => typeof p === 'string').slice(0, 32) : null;
  const known = perms ? perms.every((p) => KRAKEN_KNOWN_PERMISSIONS.includes(p)) : false; const required = perms ? KRAKEN_PERMISSIONS.REQUIRED.filter((p) => !perms.includes(p)) : KRAKEN_PERMISSIONS.REQUIRED; const forbidden = perms ? perms.filter((p) => ['Withdraw Funds', 'Deposit Funds', 'Create & Modify Orders (Margin)'].includes(p)) : [];
  const ok = Boolean(perms) && known && required.length === 0 && forbidden.length === 0;
  return { keyFingerprint: fingerprint, permissionsKnown: known, missingRequired: required, forbiddenPresent: forbidden, validUntil: Number.isFinite(Number(info?.validUntil)) ? Number(info.validUntil) : null, nonceWindow: Number.isFinite(Number(info?.nonceWindow)) ? Number(info.nonceWindow) : null, assessment: ok ? 'OK' : !perms || !known ? 'PERMISSION_PROOF_AMBIGUOUS' : forbidden.length ? 'FORBIDDEN_PERMISSION_PRESENT' : 'REQUIRED_PERMISSION_MISSING' }; // apiKey / apiKeyName / iban / raw response: never copied
}
export function specFromAssetPair(pairKey, p, { observedTs, canonicalCoin }) {
  const priceDecimals = Number(p.pair_decimals); const qtyDecimals = Number(p.lot_decimals); const tick = typeof p.tick_size === 'string' ? M.fromNumberLexeme(p.tick_size) : M.fromNumberLexeme(`1e-${priceDecimals}`);
  return instrumentSpec({ venue: 'kraken', pairKey, altname: p.altname, wsname: p.wsname, base: p.base, quote: p.quote, canonicalCoin, status: ['online', 'cancel_only', 'post_only', 'limit_only', 'reduce_only'].includes(p.status) ? p.status : 'unknown', priceIncrement: tick, qtyIncrement: M.fromNumberLexeme(`1e-${qtyDecimals}`), orderMin: M.fromNumberLexeme(String(p.ordermin)), costMin: p.costmin !== undefined ? M.fromNumberLexeme(String(p.costmin)) : null, priceDecimals, qtyDecimals, observedTs, source: 'REST_ASSET_PAIRS' });
}

export function createKrakenAdapter({ accountId, clock, credentials = null, nonceStore = null, transport = null, WebSocketImpl = null, allowPrivate = () => false, allowOrders = () => false, deadlineMs = 3000, log = () => {}, dataDir: dir = null, monotonic = () => Number(process.hrtime.bigint() / 1_000_000n) } = {}) {
  const listeners = new Set(); let seqCounter = 0; let admission = true; let backoffUntil = 0; const counters = { rest: 0, restFailures: 0, rateLimited: 0, orders: 0, cancels: 0, amends: 0, wsMessages: 0, wsGaps: 0, executions: 0, uncertain: 0, refusedUrls: 0 };
  const orderIds = new Map(); // cl_ord_id -> { orderId, positionId, kind }; native txid -> journal orderId
  const nativeToJournal = new Map(); const safetyQueue = []; const entryQueue = []; let running = false;
  const fp = credentials?.key ? keyFingerprint(credentials.key) : null;
  const nonces = nonceStore ?? (fp && dir ? createNonceStore({ dir, fingerprint: fp, wall: clock }) : null);
  const emit = (type, payload, receiptTs) => { const ev = adapterEvent('KRAKEN', type, payload, receiptTs); for (const fn of listeners) { try { fn(ev); } catch (err) { log(`kraken listener error: ${err?.message ?? err}`); } } return ev; };
  // the outbound deny seam: only the allowlist under the fixed host may be requested; everything else is refused here
  function guardUrl(name) { const e = KRAKEN_ENDPOINTS[name]; if (!e) { counters.refusedUrls += 1; throw Object.assign(new Error(`endpoint ${String(name).slice(0, 40)} is not allowlisted`), { code: 'ENDPOINT_DENIED' }); } const url = new URL(e.path, KRAKEN_REST_BASE); if (url.origin !== KRAKEN_REST_BASE || FORBIDDEN_ENDPOINT_RE.test(url.pathname)) { counters.refusedUrls += 1; throw Object.assign(new Error('url outside the allowlist'), { code: 'ENDPOINT_DENIED' }); } return { ...e, url: url.toString() }; }
  async function rest(name, params = {}, { timeoutMs = REST_TIMEOUTS.readMs } = {}) {
    const e = guardUrl(name); if (!transport) throw Object.assign(new Error('no transport injected: OBSERVE / REPLAY / PAPER never reach the venue'), { code: 'NO_TRANSPORT' });
    if (e.private) { if (!credentials?.key || !credentials?.secret) throw Object.assign(new Error('no credentials'), { code: 'CREDENTIALS_ABSENT' }); if (!allowPrivate()) throw Object.assign(new Error('private access not permitted in this mode'), { code: 'PRIVATE_NOT_PERMITTED' }); if (e.kind === 'ORDER' && !allowOrders()) throw Object.assign(new Error('order dispatch not permitted (not armed)'), { code: 'ORDERS_NOT_PERMITTED' }); }
    let body = null; const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (e.private) { const nonce = await nonces.next(); const s = signRequest({ path: e.path, nonce, params, secret: credentials.secret }); body = s.postData; headers['API-Key'] = credentials.key; headers['API-Sign'] = s.signature; } else if (Object.keys(params).length) body = encodeForm(params);
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs); counters.rest += 1; const sentMono = monotonic();
    try { const r = await transport(e.url, { method: e.private || body ? 'POST' : 'GET', headers, body, signal: ac.signal }); const text = await r.text(); const receivedMono = monotonic(); const receiptTs = clock(); let json = null; try { json = parseLexemes(text); } catch { json = null; }
      if (r.status === 429) { counters.rateLimited += 1; backoffUntil = clock() + 5000; return { ok: false, uncertain: false, status: 429, error: 'HTTP 429', receiptTs, sentMono, receivedMono }; }
      if (r.status >= 500) { counters.restFailures += 1; return { ok: false, uncertain: e.kind === 'ORDER', status: r.status, error: `HTTP ${r.status}`, receiptTs, sentMono, receivedMono }; }
      if (!json || !Array.isArray(json.error)) { counters.restFailures += 1; return { ok: false, uncertain: e.kind === 'ORDER', status: r.status, error: 'MALFORMED_RESPONSE', receiptTs, sentMono, receivedMono }; }
      if (json.error.length) { const msg = String(json.error[0]).slice(0, 120); if (/Rate limit/i.test(msg)) { counters.rateLimited += 1; backoffUntil = clock() + 5000; } return { ok: false, uncertain: false, status: r.status, error: msg, guaranteesNoAcceptance: NO_ACCEPTANCE_ERRORS.test(msg), receiptTs, sentMono, receivedMono }; }
      return { ok: true, result: json.result, receiptTs, sentMono, receivedMono }; }
    catch (err) { counters.restFailures += 1; return { ok: false, uncertain: e.kind === 'ORDER', status: null, error: err?.name === 'AbortError' ? 'TIMEOUT' : String(err?.message ?? err).slice(0, 120), receiptTs: clock(), sentMono, receivedMono: monotonic() }; }
    finally { clearTimeout(timer); }
  }
  // two bounded queues: safety / reconciliation outrank entries; entries wait for backoff and never consume all capacity
  function enqueue(queue, job) { return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); }); }
  async function pump() { if (running) return; running = true; try { for (;;) { const next = safetyQueue.shift() ?? (clock() >= backoffUntil ? entryQueue.shift() : null); if (!next) break; try { next.resolve(await next.job()); } catch (err) { next.reject(err); } } } finally { running = false; if (entryQueue.length && clock() < backoffUntil) setTimeout(pump, Math.max(1, backoffUntil - clock())).unref?.(); } }
  const safety = (job) => enqueue(safetyQueue, job); const entry = (job) => enqueue(entryQueue, job);
  const adapter = {
    kind: 'KRAKEN', accountId, keyFingerprint: fp, endpoints: KRAKEN_ENDPOINTS,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async serverTime() { const r = await rest('Time'); if (!r.ok) return { ok: false, reason: r.error }; const unix = Number(r.result?.unixtime); if (!Number.isFinite(unix)) return { ok: false, reason: 'MALFORMED_TIME' }; return { ok: true, serverUtcTs: unix * 1000, precisionMs: 1000, sentMono: r.sentMono, receivedMono: r.receivedMono, source: 'REST_TIME' }; },
    async instrument(pairName, canonicalCoin) { const r = await rest('AssetPairs', { pair: pairName }); if (!r.ok) return { ok: false, reason: r.error }; const entries = Object.entries(r.result ?? {}); if (entries.length !== 1) return { ok: false, reason: 'PAIR_AMBIGUOUS' }; const [pairKey, p] = entries[0]; try { return { ok: true, spec: specFromAssetPair(pairKey, p, { observedTs: r.receiptTs, canonicalCoin }) }; } catch (err) { return { ok: false, reason: `SPEC_INVALID: ${err.message}` }; } },
    // ---- preflight: read-only private checks, each with its own evidence; nothing here places an order ----
    async preflight({ requireKeyInfo = true } = {}) {
      const out = { ok: false, adapter: 'KRAKEN', keyFingerprint: fp, checks: {}, liveCapable: false };
      if (!credentials?.key) { out.checks.credentials = { state: 'ABSENT' }; out.reason = 'CREDENTIALS_ABSENT'; return out; }
      if (!allowPrivate()) { out.checks.credentials = { state: 'PRESENT' }; out.checks.privateAccess = { state: 'NOT_PERMITTED' }; out.reason = 'PREFLIGHT_NOT_AUTHORIZED'; return out; }
      const t = await adapter.serverTime(); out.checks.time = t;
      if (requireKeyInfo) { const k = await safety(() => rest('GetApiKeyInfo')); out.checks.keyInfo = k.ok ? redactKeyInfo(k.result, fp) : { assessment: 'UNAVAILABLE', reason: k.error }; }
      const b = await safety(() => rest('Balance')); out.checks.balance = b.ok ? { state: 'OK', assets: Object.keys(b.result ?? {}).length, quoteAvailable: lex(b.result?.ZUSD ?? b.result?.USD ?? null) } : { state: 'FAILED', reason: b.error };
      const o = await safety(() => rest('OpenOrders')); out.checks.openOrders = o.ok ? { state: 'OK', count: Object.keys(o.result?.open ?? {}).length } : { state: 'FAILED', reason: o.error };
      out.ok = Boolean(t.ok && out.checks.balance.state === 'OK' && out.checks.openOrders.state === 'OK' && (!requireKeyInfo || out.checks.keyInfo.assessment === 'OK')); out.reason = out.ok ? null : out.checks.keyInfo?.assessment && out.checks.keyInfo.assessment !== 'OK' ? out.checks.keyInfo.assessment : 'PREFLIGHT_CHECK_FAILED';
      return out;
    },
    // ---- entry: ONE private order-sending path; exact native field names; never a market fallback ----
    async submitEntryWithProtection({ intent, spec }) {
      if (!admission) return { outcome: 'REJECTED', nativeOrderId: null, reason: 'ADMISSION_STOPPED', guaranteesNoAcceptance: true };
      if (intent.clientOrderId.length > 18) return { outcome: 'REJECTED', nativeOrderId: null, reason: 'cl_ord_id exceeds 18 characters', guaranteesNoAcceptance: true };
      if (intent.orderType !== 'limit' || intent.timeInForce !== 'IOC' || !intent.protection || intent.protection.ordertype !== 'stop-loss') return { outcome: 'REJECTED', nativeOrderId: null, reason: 'unsupported order form (IOC limit + stop-loss close required)', guaranteesNoAcceptance: true };
      if (!M.isMultipleOf(intent.qty, spec.qtyIncrement) || !M.isMultipleOf(intent.limitPrice, spec.priceIncrement) || !M.isMultipleOf(intent.protection.price, spec.priceIncrement) || M.lt(intent.qty, spec.orderMin)) return { outcome: 'REJECTED', nativeOrderId: null, reason: 'increments / minimum violate the instrument spec', guaranteesNoAcceptance: true };
      const now = clock(); const deadline = iso(now + deadlineMs); if (deadlineMs < 2000 || deadlineMs > 60_000) return { outcome: 'REJECTED', nativeOrderId: null, reason: 'deadline outside the documented REST range', guaranteesNoAcceptance: true };
      const params = { ordertype: 'limit', type: 'buy', volume: intent.qty, pair: spec.altname, price: intent.limitPrice, timeinforce: 'IOC', cl_ord_id: intent.clientOrderId, deadline, oflags: 'fciq', trigger: 'last', 'close[ordertype]': 'stop-loss', 'close[price]': intent.protection.price };
      orderIds.set(intent.clientOrderId, { orderId: intent.orderId, positionId: intent.positionId, kind: intent.kind }); counters.orders += 1;
      const r = await entry(() => rest('AddOrder', params, { timeoutMs: REST_TIMEOUTS.entryMs }));
      adapter.lastRequest = { endpoint: 'AddOrder', params };
      if (r.ok) { const txid = Array.isArray(r.result?.txid) ? String(r.result.txid[0]) : null; if (!txid) { counters.uncertain += 1; return { outcome: 'UNCERTAIN', nativeOrderId: null, reason: 'acknowledgement without txid', guaranteesNoAcceptance: false }; } nativeToJournal.set(txid, intent.orderId); return { outcome: 'ACKNOWLEDGED', nativeOrderId: txid, reason: typeof r.result?.descr?.close === 'string' ? r.result.descr.close.slice(0, 120) : null, guaranteesNoAcceptance: false }; }
      if (r.uncertain) { counters.uncertain += 1; return { outcome: 'UNCERTAIN', nativeOrderId: null, reason: `${r.error}: a local timeout is not proof the matching engine rejected the order`, guaranteesNoAcceptance: false }; }
      return { outcome: 'REJECTED', nativeOrderId: null, reason: r.error, guaranteesNoAcceptance: Boolean(r.guaranteesNoAcceptance) };
    },
    async amendProtection({ nativeOrderId, requestedTrigger, amendId }) { counters.amends += 1; const r = await safety(() => rest('AmendOrder', { txid: nativeOrderId, trigger_price: requestedTrigger, deadline: iso(clock() + deadlineMs) }, { timeoutMs: REST_TIMEOUTS.safetyMs })); adapter.lastRequest = { endpoint: 'AmendOrder', params: { txid: nativeOrderId, trigger_price: requestedTrigger } }; if (r.ok) return { outcome: 'ACKNOWLEDGED', confirmedTrigger: requestedTrigger, reason: typeof r.result?.amend_id === 'string' ? r.result.amend_id : null, amendId }; if (r.uncertain) return { outcome: 'UNCERTAIN', confirmedTrigger: null, reason: r.error }; return { outcome: 'FAILED', confirmedTrigger: null, reason: r.error }; },
    async cancelOwnedOrder({ nativeOrderId }) { counters.cancels += 1; const r = await safety(() => rest('CancelOrder', { txid: nativeOrderId }, { timeoutMs: REST_TIMEOUTS.safetyMs })); if (r.ok) { const pending = r.result?.pending === true; return { outcome: pending ? 'UNCERTAIN' : 'CANCELLED', reason: pending ? 'cancel pending at venue' : null }; } if (r.uncertain) return { outcome: 'UNCERTAIN', reason: r.error }; if (/Unknown order/i.test(r.error)) return { outcome: 'ALREADY_TERMINAL', reason: r.error }; return { outcome: 'REJECTED', reason: r.error }; },
    // a protective market sell of a CONFIRMED residual (subject to venue constraints); planned exits are bounded IOC limits
    async closeResidual({ intent, spec }) { const market = intent.orderType === 'market'; if (!market && (intent.orderType !== 'limit' || intent.timeInForce !== 'IOC')) return { outcome: 'REJECTED', nativeOrderId: null, reason: 'exit form unsupported', guaranteesNoAcceptance: true }; if (!M.isMultipleOf(intent.qty, spec.qtyIncrement)) return { outcome: 'REJECTED', nativeOrderId: null, reason: 'qty increment', guaranteesNoAcceptance: true }; const params = { ordertype: market ? 'market' : 'limit', type: 'sell', volume: intent.qty, pair: spec.altname, cl_ord_id: intent.clientOrderId, deadline: iso(clock() + deadlineMs), oflags: 'fciq', ...(market ? {} : { price: intent.limitPrice, timeinforce: 'IOC' }) }; orderIds.set(intent.clientOrderId, { orderId: intent.orderId, positionId: intent.positionId, kind: intent.kind }); const r = await safety(() => rest('AddOrder', params, { timeoutMs: REST_TIMEOUTS.safetyMs })); adapter.lastRequest = { endpoint: 'AddOrder', params }; if (r.ok) { const txid = Array.isArray(r.result?.txid) ? String(r.result.txid[0]) : null; if (!txid) return { outcome: 'UNCERTAIN', nativeOrderId: null, reason: 'acknowledgement without txid', guaranteesNoAcceptance: false }; nativeToJournal.set(txid, intent.orderId); return { outcome: 'ACKNOWLEDGED', nativeOrderId: txid, reason: null, guaranteesNoAcceptance: false }; } if (r.uncertain) return { outcome: 'UNCERTAIN', nativeOrderId: null, reason: r.error, guaranteesNoAcceptance: false }; return { outcome: 'REJECTED', nativeOrderId: null, reason: r.error, guaranteesNoAcceptance: Boolean(r.guaranteesNoAcceptance) }; },
    // ---- reconciliation: bounded pages, overlap dedup, incomplete pages are NOT flat ----
    async reconcile({ scope = 'PERIODIC', sinceTs, untilTs = clock(), maxPages = 10, knownExecIds = new Set() } = {}) {
      const now = clock(); const rid = `krec-${accountId}-${++seqCounter}`; let pagesRead = 0; let incomplete = false; let executionsSeen = 0; let unmatched = 0; const seenTrades = new Set(); const fail = (reason) => emit('RECONCILIATION', { reconciliationId: rid, scope, outcome: 'FAILED', balances: null, openOrdersSeen: 0, executionsSeen, unmatched, pagesRead, pageIncomplete: true, cursorTs: sinceTs ?? null, reason, ts: clock() }, clock()).payload;
      const bal = await safety(() => rest('Balance')); if (!bal.ok) return fail(`Balance: ${bal.error}`);
      const balances = { quoteAvailable: null, quoteTotal: lex(bal.result?.ZUSD ?? bal.result?.USD ?? null), baseByAsset: Object.entries(bal.result ?? {}).filter(([k]) => k !== 'ZUSD' && k !== 'USD').slice(0, 64).map(([asset, total]) => ({ asset, total: lex(total) ?? '0', available: null })) };
      const open = await safety(() => rest('OpenOrders')); if (!open.ok) return fail(`OpenOrders: ${open.error}`); const openOrders = Object.entries(open.result?.open ?? {});
      for (const [txid, o] of openOrders) { const cl = typeof o?.cl_ord_id === 'string' ? o.cl_ord_id : null; const mine = (cl && orderIds.get(cl)) || (nativeToJournal.has(txid) ? { orderId: nativeToJournal.get(txid) } : null); if (!mine) { unmatched += 1; emit('EXTERNAL_ACTIVITY', { kind: 'ORDER', ref: txid, asset: null, amount: null, sourceTs: null, receiptTs: now, note: 'open order not placed by this account' }, now); } }
      let ofs = 0; for (let page = 0; page < maxPages; page += 1) { const r = await safety(() => rest('TradesHistory', { ofs, ...(sinceTs ? { start: Math.floor(sinceTs / 1000) } : {}), end: Math.ceil(untilTs / 1000) })); if (!r.ok) return fail(`TradesHistory: ${r.error}`); pagesRead += 1; const trades = Object.entries(r.result?.trades ?? {}); const count = Number(r.result?.count ?? trades.length);
        for (const [tid, t] of trades) { if (seenTrades.has(tid)) continue; seenTrades.add(tid); executionsSeen += 1; if (knownExecIds.has(tid)) continue; const txid = typeof t?.ordertxid === 'string' ? t.ordertxid : null; const journalOrderId = txid ? nativeToJournal.get(txid) ?? null : null; const sourceTs = Number.isFinite(Number(t?.time)) ? Math.round(Number(t.time) * 1000) : null; const vol = lex(t?.vol); const cost = lex(t?.cost); const price = lex(t?.price); const feeAmt = lex(t?.fee);
          if (!journalOrderId || !vol || !cost || !price) { unmatched += 1; emit('EXTERNAL_ACTIVITY', { kind: 'FILL', ref: tid, asset: typeof t?.pair === 'string' ? t.pair : null, amount: vol, sourceTs, receiptTs: now, note: journalOrderId ? 'unparseable native amounts' : 'trade not attributable to an order of this account' }, now); continue; }
          emit('EXECUTION_RECORDED', { orderId: journalOrderId, execId: tid, nativeOrderId: txid, side: t.type === 'sell' ? 'sell' : 'buy', base: vol, quote: cost, price, fee: feeAmt ? { asset: 'USD', amount: feeAmt } : null, sourceTs, receiptTs: now, origin: 'REST_RECONCILIATION', ordRefId: null, nativeCumQty: null, sequence: null }, now); }
        ofs += trades.length; if (ofs >= count || trades.length === 0) break; if (page === maxPages - 1) incomplete = true; }
      const ledger = await safety(() => rest('Ledgers', { type: 'all', ...(sinceTs ? { start: Math.floor(sinceTs / 1000) } : {}) })); if (ledger.ok) for (const [lid, l] of Object.entries(ledger.result?.ledger ?? {}).slice(0, 200)) { if (l?.type === 'withdrawal' || l?.type === 'deposit' || l?.type === 'transfer') { unmatched += 1; emit('EXTERNAL_ACTIVITY', { kind: l.type === 'deposit' ? 'DEPOSIT' : 'WITHDRAWAL', ref: lid, asset: typeof l.asset === 'string' ? l.asset : null, amount: lex(l.amount), sourceTs: Number.isFinite(Number(l.time)) ? Math.round(Number(l.time) * 1000) : null, receiptTs: now, note: `ledger ${l.type}` }, now); } } else incomplete = true;
      const outcome = incomplete ? 'INCOMPLETE' : 'COMPLETE';
      return emit('RECONCILIATION', { reconciliationId: rid, scope, outcome, balances, openOrdersSeen: openOrders.length, executionsSeen, unmatched, pagesRead, pageIncomplete: incomplete, cursorTs: untilTs, reason: incomplete ? 'page bound reached or ledger unavailable: not flat' : null, ts: clock() }, clock()).payload;
    },
    // ---- WebSocket v2 executions (low latency), REST reconciliation after any gap ----
    async connectExecutions({ url = KRAKEN_WS_AUTH_URL } = {}) {
      if (!WebSocketImpl) return { ok: false, reason: 'NO_WEBSOCKET' }; if (!allowPrivate()) return { ok: false, reason: 'PRIVATE_NOT_PERMITTED' };
      const tok = await safety(() => rest('GetWebSocketsToken')); if (!tok.ok) return { ok: false, reason: tok.error }; const token = tok.result?.token; if (typeof token !== 'string') return { ok: false, reason: 'TOKEN_MALFORMED' };
      const ws = new WebSocketImpl(url); let lastSeq = null; let pingId = 0; const pings = new Map(); const state = { connected: false, lastMessageTs: null, gaps: 0 };
      ws.onopen = () => { state.connected = true; ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'executions', token, snap_orders: true, snap_trades: true } })); };
      ws.onmessage = (e) => { const receiptTs = clock(); state.lastMessageTs = receiptTs; counters.wsMessages += 1; let msg; try { msg = parseLexemes(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
        if (msg.method === 'pong') { const p = pings.get(Number(msg.req_id)); if (p) { pings.delete(Number(msg.req_id)); p.resolve({ ok: true, serverUtcTs: Date.parse(msg.time_out), precisionMs: 1, sentMono: p.sentMono, receivedMono: monotonic(), source: 'WS_PING', requestIdMatched: true, responseConsistent: Date.parse(msg.time_in) <= Date.parse(msg.time_out) }); } return; }
        if (msg.channel !== 'executions') return; const seq = Number(msg.sequence); if (Number.isFinite(seq)) { if (lastSeq !== null && seq !== lastSeq + 1) { state.gaps += 1; counters.wsGaps += 1; emit('RECONCILIATION', { reconciliationId: `kgap-${accountId}-${++seqCounter}`, scope: 'AFTER_GAP', outcome: 'INCOMPLETE', balances: null, openOrdersSeen: 0, executionsSeen: 0, unmatched: 0, pagesRead: 0, pageIncomplete: true, cursorTs: receiptTs, reason: `executions sequence gap ${lastSeq} -> ${seq}: REST reconciliation required`, ts: receiptTs }, receiptTs); } lastSeq = seq; }
        for (const d of msg.data ?? []) adapter.onExecutionRecord(d, receiptTs, msg.type === 'snapshot'); };
      ws.onclose = () => { state.connected = false; };
      adapter.ping = () => new Promise((resolve) => { const id = ++pingId; pings.set(id, { resolve, sentMono: monotonic() }); ws.send(JSON.stringify({ method: 'ping', req_id: id })); setTimeout(() => { if (pings.delete(id)) resolve({ ok: false, reason: 'PONG_TIMEOUT' }); }, REST_TIMEOUTS.readMs).unref?.(); });
      adapter.executionsState = () => ({ ...state, lastSeq }); return { ok: true, close: () => ws.close?.() };
    },
    // one native execution record -> closed adapter events (allowlisted fields only; native lexemes kept exact)
    onExecutionRecord(d, receiptTs, fromSnapshot = false) {
      const txid = typeof d.order_id === 'string' ? d.order_id : null; const cl = typeof d.cl_ord_id === 'string' ? d.cl_ord_id : null; const mappedId = txid ? nativeToJournal.get(txid) ?? null : null; const mine = (cl && orderIds.get(cl)) || (mappedId && !String(mappedId).startsWith('child:') ? { orderId: mappedId } : null); const ordRef = typeof d.ord_ref_id === 'string' ? d.ord_ref_id : null; const parent = ordRef ? nativeToJournal.get(ordRef) ?? null : null; const sourceTs = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) || null : null;
      if (txid && mine && !nativeToJournal.has(txid)) nativeToJournal.set(txid, mine.orderId);
      // a contingent child (conditional close) of one of our parents: protection facts, never a fill of the parent
      if (!mine && parent && d.order_type === 'stop-loss') { const pos = [...orderIds.values()].find((x) => x.orderId === parent)?.positionId ?? null; if (pos) { const st = d.order_status; const trig = lex(d.triggers?.price ?? d.trigger_price ?? d.limit_price ?? null); const qty = lex(d.order_qty); const state = st === 'new' || st === 'pending_new' ? 'ACTIVE' : st === 'triggered' ? 'TRIGGERED' : st === 'canceled' || st === 'expired' ? 'CANCELLED' : st === 'filled' ? 'TRIGGERED' : 'PENDING'; nativeToJournal.set(txid, `child:${txid}`); emit('PROTECTION_STATE', { positionId: pos, orderId: null, state, nativeOrderId: txid, trigger: trig, qty, sourceTs, receiptTs, reason: `native contingent ${d.exec_type ?? st} (ord_ref_id ${ordRef})` }, receiptTs); if (d.exec_type === 'trade' && lex(d.last_qty) && lex(d.last_price)) emit('EXECUTION_RECORDED', { orderId: null, execId: String(d.exec_id), nativeOrderId: txid, side: d.side === 'sell' ? 'sell' : 'buy', base: lex(d.last_qty), quote: M.mul(lex(d.last_qty), lex(d.last_price)), price: lex(d.last_price), fee: Array.isArray(d.fees) && d.fees[0] ? { asset: String(d.fees[0].asset), amount: lex(d.fees[0].qty) } : null, sourceTs, receiptTs, origin: 'WS_EXECUTIONS', ordRefId: ordRef, nativeCumQty: lex(d.cum_qty), sequence: null }, receiptTs); } return; }
      if (!mine) { if (txid && String(nativeToJournal.get(txid) ?? '').startsWith('child:')) { /* child stop fill: attributed through its parent's position by the dispatcher */ if (d.exec_type === 'trade') { emit('EXECUTION_RECORDED', { orderId: null, execId: String(d.exec_id), nativeOrderId: txid, side: d.side === 'sell' ? 'sell' : 'buy', base: lex(d.last_qty), quote: M.mul(lex(d.last_qty), lex(d.last_price)), price: lex(d.last_price), fee: Array.isArray(d.fees) && d.fees[0] ? { asset: String(d.fees[0].asset), amount: lex(d.fees[0].qty) } : null, sourceTs, receiptTs, origin: 'WS_EXECUTIONS', ordRefId: ordRef, nativeCumQty: lex(d.cum_qty), sequence: null }, receiptTs); } return; } if (!fromSnapshot || d.exec_type === 'trade') emit('EXTERNAL_ACTIVITY', { kind: d.exec_type === 'trade' ? 'FILL' : 'ORDER', ref: String(d.exec_id ?? txid ?? 'unknown'), asset: typeof d.symbol === 'string' ? d.symbol : null, amount: lex(d.last_qty ?? d.order_qty ?? null), sourceTs, receiptTs, note: 'execution not attributable to this account' }, receiptTs); return; }
      counters.executions += 1;
      if (d.exec_type === 'trade') { const base = lex(d.last_qty); const price = lex(d.last_price); if (!base || !price) { emit('ORDER_STATE', { orderId: mine.orderId, state: 'RECONCILIATION_REQUIRED', nativeOrderId: txid, nativeCumQty: null, reason: 'native amounts unparseable at supported precision', sourceTs, receiptTs }, receiptTs); return; } emit('EXECUTION_RECORDED', { orderId: mine.orderId, execId: String(d.exec_id), nativeOrderId: txid, side: d.side === 'sell' ? 'sell' : 'buy', base, quote: M.mul(base, price), price, fee: Array.isArray(d.fees) && d.fees[0] ? { asset: String(d.fees[0].asset), amount: lex(d.fees[0].qty) } : null, sourceTs, receiptTs, origin: 'WS_EXECUTIONS', ordRefId: ordRef, nativeCumQty: lex(d.cum_qty), sequence: null }, receiptTs); return; }
      const st = d.order_status; const map = { pending_new: null, new: 'ACKNOWLEDGED', partially_filled: 'PARTIALLY_FILLED', filled: 'FILLED', canceled: 'CANCELLED', expired: 'EXPIRED', rejected: 'REJECTED' }; const mapped = map[st]; if (mapped === undefined) { emit('ORDER_STATE', { orderId: mine.orderId, state: 'RECONCILIATION_REQUIRED', nativeOrderId: txid, nativeCumQty: lex(d.cum_qty), reason: `unknown native order_status ${String(st).slice(0, 24)}`, sourceTs, receiptTs }, receiptTs); return; } if (mapped === null) return;
      emit('ORDER_STATE', { orderId: mine.orderId, state: mapped, nativeOrderId: txid, nativeCumQty: lex(d.cum_qty), reason: typeof d.reason === 'string' ? d.reason.slice(0, 120) : null, sourceTs, receiptTs }, receiptTs);
    },
    registerOrder(clientOrderId, { orderId, positionId, kind }, nativeOrderId = null) { orderIds.set(clientOrderId, { orderId, positionId, kind }); if (nativeOrderId) nativeToJournal.set(nativeOrderId, orderId); },
    stopAdmission() { admission = false; return { admission }; },
    async drain({ maxWaitMs = 10_000 } = {}) { admission = false; const t0 = clock(); while ((safetyQueue.length || running) && clock() - t0 < maxWaitMs) await new Promise((r) => setTimeout(r, 10)); return { safetyPending: safetyQueue.length, entryPending: entryQueue.length, uncertain: counters.uncertain }; },
    rest, redactKeyInfo: (info) => redactKeyInfo(info, fp),
    status: () => ({ adapter: 'KRAKEN', admission, keyFingerprint: fp, credentialsPresent: Boolean(credentials?.key), privateAllowed: allowPrivate(), ordersAllowed: allowOrders(), backoffUntil, queues: { safety: safetyQueue.length, entry: entryQueue.length }, counters: { ...counters }, nonce: nonces ? nonces.peek() : null }),
  };
  return adapter;
}
