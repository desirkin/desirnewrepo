// MARKET-EDGE-KRAKEN-1 (B) — the Kraken Spot LEVEL 3 stream (wss://ws-l3.kraken.com/v2, channel level3) on the EXISTING
// KRAKEN_SPOT provider. It never replaces the public L2 path (providers/kraken-spot.js createStream) and never calls L2 "L3".
// Sequence: prove the DEDICATED data key (narrow helper; anything but SAFE_L3_DATA_KEY blocks — a NON_AUTHORITY_KEY without
// the token permission stays blocked with TOKEN_PERMISSION_MISSING) -> fetch a token -> connect -> subscribe level3 ONLY
// (depth from policy, default 10, bounded symbols). Every message drives the pure book (l3-book.js): snapshot replaces
// state; add / modify / delete per docs; truncation SCOPE_EVICTS; an unknown order, a checksum failure, a MISSING checksum
// (the protocol carries one on every snapshot and update — W11), a crossed book or a resource overflow DESYNCHRONIZES and
// resubscribes for a fresh snapshot; a disconnect opens a new epoch (no bridging of ages). Resource bounds are explicit
// coverage facts (QUEUE_DROPPED / OVERFLOW), never silent.
// W9 — ONE weighted subscription limiter (documented 2026-09-10, docs.kraken.com websocket-v2 level3 rate limits): the
// subscription counter grows by 5 / 25 / 100 points per symbol for depth 10 / 100 / 1000 with a budget of 200 points per
// second on the standard tier (500 on the pro tier ONLY when policy.rateTier is PRO, i.e. separately proven and configured).
// Initial subscribes, resubscribes after a desync AND unsubscribes all pass through the same pacer (unsubscribes are charged
// conservatively at the same weight); the operator bound maxSubscriptionsPerSecond (symbols per second) applies on top.
// W10 — the exchange (matching-engine) message timestamp is preserved as sourceEventTs on every snapshot / event record,
// beside receivedTs / knownAtTs (our clocks); a source clock ahead of receipt beyond the shared tolerance is CLOCK_CONFLICT
// (contracts.js), never normalized. Authority: NONE — this module can only subscribe / unsubscribe a market-data channel.
import { createClientBase, str, int, arr, obj, tsFromIso } from './base.js';
import { createWsClient } from '../transport.js';
import { quality, deepFreeze, fail, L3_DEPTHS } from '../contracts.js';
import { createL3Book } from '../l3-book.js';
import { L3_DEFAULTS } from '../policy.js';

export const L3_ENDPOINT_ID = 'ws-l3';
export const KRAKEN_L3_METHODOLOGY = 'kraken-ws-level3-v2';
export const L3_DOCS_CHECKED = '2026-09-10';
// the documented weighted subscription counter: points per symbol by depth; budget per second by account tier (fail-safe STANDARD)
export const L3_SUBSCRIPTION_WEIGHTS = deepFreeze({ 10: 5, 100: 25, 1000: 100 });
export const L3_RATE_BUDGETS = deepFreeze({ STANDARD: 200, PRO: 500 });
export const subscriptionBudgetOf = (rateTier) => L3_RATE_BUDGETS[rateTier] ?? L3_RATE_BUDGETS.STANDARD;
const FAMILY = 'L3_MICROSTRUCTURE';

// W9: the single pacer. Requests are queued in order; every wall second admits at most `symbolsPerSecond` symbols and at most
// `budget` weighted points; the remainder waits a real second (the wall wait IS the pacing; an injected frozen clock never
// stalls a request forever because the deferred window resets before the retry).
export function createSubscriptionPacer({ depth, rateTier = 'STANDARD', symbolsPerSecond, clock, timers, send, log = () => {} }) {
  const weight = L3_SUBSCRIPTION_WEIGHTS[depth]; if (!weight) fail('INVALID_REQUEST', 'depth must be 10, 100 or 1000');
  const budget = subscriptionBudgetOf(rateTier);
  if (!Number.isSafeInteger(symbolsPerSecond) || symbolsPerSecond < 1) fail('INVALID_REQUEST', 'symbolsPerSecond');
  const queue = []; let window = { second: -1, symbols: 0, points: 0 }; let timer = null; let stopped = false; const stats = { sent: 0, points: 0, deferred: 0, windows: 0 };
  const flush = (fresh) => {
    if (stopped) return;
    const now = Math.floor(clock() / 1000); if (fresh || window.second !== now) { window = { second: now, symbols: 0, points: 0 }; stats.windows += 1; }
    while (queue.length) {
      const head = queue[0]; if (window.symbols + 1 > symbolsPerSecond || window.points + weight > budget) break;
      // batch consecutive requests of the same method / token into one message (symbol arrays are documented)
      const batch = []; while (queue.length && batch.length < symbolsPerSecond - window.symbols && (window.points + (batch.length + 1) * weight) <= budget && queue[0].method === head.method && queue[0].token === head.token) batch.push(queue.shift());
      window.symbols += batch.length; window.points += batch.length * weight; stats.sent += batch.length; stats.points += batch.length * weight;
      const params = { channel: 'level3', symbol: batch.map((b) => b.symbol), depth, ...(head.method === 'subscribe' ? { snapshot: true, token: head.token } : {}) };
      send({ method: head.method, params });
    }
    if (queue.length && timer === null) { stats.deferred += queue.length; timer = timers.setTimeout(() => { timer = null; flush(true); }, 1000); }
  };
  return {
    weight, budget, rateTier: L3_RATE_BUDGETS[rateTier] ? rateTier : 'STANDARD',
    request(method, symbols, token = null) { if (method !== 'subscribe' && method !== 'unsubscribe') fail('INVALID_REQUEST', 'the pacer knows subscribe and unsubscribe only'); for (const symbol of symbols) queue.push({ method, symbol, token }); flush(false); },
    stop() { stopped = true; if (timer !== null) { timers.clearTimeout(timer); timer = null; } queue.length = 0; },
    status: () => ({ weight, budget, rateTier: L3_RATE_BUDGETS[rateTier] ? rateTier : 'STANDARD', symbolsPerSecond, queued: queue.length, ...stats }),
  };
}

export function createKrakenL3Stream({ transport, clock = () => Date.now(), log = () => {}, auth, markets, l3 = L3_DEFAULTS, depth = l3.depth, WebSocketImpl, url = null, onSnapshot = () => {}, onEvents = () => {}, onCoverage = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  if (!auth || typeof auth.proveDataKey !== 'function' || typeof auth.fetchToken !== 'function') fail('INVALID_REQUEST', 'the L3 stream needs the narrow auth helper');
  if (!Array.isArray(markets) || !markets.length) fail('INVALID_REQUEST', 'at least one market');
  if (markets.length > l3.maxSymbols) fail('RESOURCE_LIMIT_EXCEEDED', `at most ${l3.maxSymbols} L3 symbols under the policy`);
  if (!L3_DEPTHS.includes(depth)) fail('INVALID_REQUEST', 'depth must be 10, 100 or 1000');
  const base = createClientBase({ providerId: 'KRAKEN_SPOT', transport, clock, log });
  const byWs = new Map(markets.map((m) => [m.wsname, m]));
  const perBook = Math.max(1, Math.floor(l3.maxInMemoryOrders / markets.length));
  const books = new Map(markets.map((m) => [m.wsname, createL3Book({ symbol: m.wsname, depth, maxOrders: perBook })]));
  const exchangeTs = new Map(); // wsname -> { ts, checksumOk }: the exchange clock and checksum truth of the message that produced the current state (W10 / W11)
  const stats = { snapshots: 0, updates: 0, eventsEmitted: 0, resyncs: 0, unknownSymbols: 0, checksumFailures: 0, checksumMissing: 0, clockConflicts: 0, queueDropped: 0, overflows: 0, tokens: 0, reconnects: 0, blocked: false, proof: null };
  const subscribed = new Set(); const dropped = new Set(); let currentEpoch = null; let ws = null; let stopping = false;
  const send = (msg) => (ws ? ws.send(msg) : false);
  const pacer = createSubscriptionPacer({ depth, rateTier: l3.rateTier ?? 'STANDARD', symbolsPerSecond: l3.maxSubscriptionsPerSecond, clock, timers, send: (msg) => { if (!stopping && ws) send(msg); }, log });
  const coverageRecord = (wsname, state, reasonCodes, ts, extra = {}) => { const m = byWs.get(wsname); if (!m) return; try { onCoverage(base.coverage({ endpointId: L3_ENDPOINT_ID, subject: m.subject, family: FAMILY, kind: 'L3_BOOK_COVERAGE', state, reasonCodes, startTs: ts, endTs: extra.endTs ?? null, observationCount: extra.observationCount ?? 0, droppedCount: extra.droppedCount ?? 0, epochId: currentEpoch })); } catch (err) { log(`L3 coverage rejected: ${String(err?.message ?? err).slice(0, 120)}`); } };
  const coverageObservation = (wsname, state, reason, receivedTs, { droppedUpdates = 0, bytesSha256 = null } = {}) => { const m = byWs.get(wsname); const b = books.get(wsname); if (!m || !b) return null; const ob = base.tryEmit({ endpointId: L3_ENDPOINT_ID, subject: m.subject, kind: 'L3_BOOK_COVERAGE', receivedTs, knownAtTs: receivedTs, epochId: currentEpoch, quality: quality('KNOWN', { methodologyId: KRAKEN_L3_METHODOLOGY }), provenance: { requestId: null, bytesSha256, nativeLocator: wsname, mappingId: KRAKEN_L3_METHODOLOGY, specificationId: null, vintage: 'LIVE_FORWARD_CAPTURE' }, payload: { state, reason, sinceTs: receivedTs, untilTs: null, droppedUpdates, depth, ordersTracked: b.size } }, 'L3 coverage'); if (ob) onSnapshot(ob); return ob; };
  // a snapshot record: the state view + the exchange clock of the message that produced it (W10) + the checksum truth (W11:
  // only a VERIFIED checksum makes the snapshot KNOWN; unverified is PARTIAL with CHECKSUM_UNVERIFIED)
  const snapshotObservation = (wsname, receivedTs, { sampleReason, checksumOk, bytesSha256 = null, sourceEventTs = null }) => {
    const m = byWs.get(wsname); const b = books.get(wsname); if (!m || !b) return null; const v = b.view();
    const known = b.synchronized && checksumOk === true;
    const ob = base.tryEmit({ endpointId: L3_ENDPOINT_ID, subject: m.subject, kind: 'L3_BOOK_SNAPSHOT', sourceEventTs, receivedTs, knownAtTs: receivedTs, epochId: currentEpoch, quality: quality(known ? 'KNOWN' : 'PARTIAL', { reasonCodes: b.synchronized ? (checksumOk === true ? [] : ['CHECKSUM_UNVERIFIED']) : ['DESYNCHRONIZED'], methodologyId: KRAKEN_L3_METHODOLOGY }), provenance: { requestId: null, bytesSha256, nativeLocator: wsname, mappingId: KRAKEN_L3_METHODOLOGY, specificationId: null, vintage: 'LIVE_FORWARD_CAPTURE' },
      payload: { depth, bids: v.bids, asks: v.asks, checksumVerified: checksumOk, synchronized: b.synchronized, sampleReason, truncated: v.truncated, pricePrecision: m.pricePrecision ?? null, qtyPrecision: m.qtyPrecision ?? null } }, 'L3 snapshot');
    if (ob) { stats.snapshots += 1; if (ob.quality.state === 'CLOCK_CONFLICT') stats.clockConflicts += 1; onSnapshot(ob); } return ob;
  };
  const resubscribe = (wsname, reason, receivedTs, token) => {
    const b = books.get(wsname); b.reset(reason); stats.resyncs += 1; exchangeTs.delete(wsname);
    coverageRecord(wsname, 'GAP', [reason === 'CHECKSUM_MISMATCH' ? 'DESYNCHRONIZED' : reason === 'OVERFLOW' ? 'COVERAGE_OVERFLOW' : reason === 'CHECKSUM_MISSING' ? 'CHECKSUM_UNVERIFIED' : 'DESYNCHRONIZED'], receivedTs);
    coverageObservation(wsname, reason === 'OVERFLOW' ? 'OVERFLOW' : reason === 'CHECKSUM_MISMATCH' ? 'DESYNCHRONIZED' : 'DEGRADED', reason === 'OVERFLOW' ? 'COVERAGE_OVERFLOW' : reason === 'CHECKSUM_MISSING' ? 'CHECKSUM_UNVERIFIED' : 'DESYNCHRONIZED', receivedTs);
    if (reason === 'OVERFLOW') { dropped.add(wsname); pacer.request('unsubscribe', [wsname]); return; }
    // the SAME limiter as the initial subscribe: a resubscribe never bypasses the weighted counter
    pacer.request('unsubscribe', [wsname]); pacer.request('subscribe', [wsname], token);
  };
  let epochToken = null; let epochMessages = { second: 0, count: 0 };
  function onMessage(msg, { receivedTs, epochId, bytesSha256 }) {
    // the message-rate bound: beyond maxQueueMessages per second the update stream is DROPPED (counted) and every book resyncs
    const sec = Math.floor(receivedTs / 1000); if (epochMessages.second !== sec) epochMessages = { second: sec, count: 0 }; epochMessages.count += 1;
    if (epochMessages.count > l3.maxQueueMessages) { stats.queueDropped += 1; if (epochMessages.count === l3.maxQueueMessages + 1) for (const wsname of books.keys()) { if (books.get(wsname).synchronized) { coverageRecord(wsname, 'DROPPED', ['QUEUE_DROPPED'], receivedTs, { droppedCount: 1 }); resubscribe(wsname, 'QUEUE_DROPPED', receivedTs, epochToken); } } return; }
    if (msg.method === 'subscribe') { const res = obj(msg.result); const sym = str(res?.symbol, 40); if (!sym || !byWs.has(sym) || res?.channel !== 'level3') return; if (msg.success === true) { subscribed.add(sym); coverageRecord(sym, 'SUBSCRIBED', [], receivedTs); coverageObservation(sym, 'SUBSCRIBED', 'NONE', receivedTs, { bytesSha256 }); } else { coverageRecord(sym, 'FAILED', ['PROVIDER_ERROR'], receivedTs, { endTs: receivedTs }); coverageObservation(sym, 'UNSUBSCRIBED', 'PROVIDER_ERROR', receivedTs, { bytesSha256 }); } return; }
    if (msg.channel !== 'level3') return;
    for (const d of arr(msg.data) ?? []) {
      const sym = str(obj(d)?.symbol, 40); const b = sym ? books.get(sym) : null; if (!b || dropped.has(sym)) { stats.unknownSymbols += 1; continue; }
      const sourceEventTs = tsFromIso(d.timestamp); // W10: the exchange clock of THIS message (null when the venue sends none)
      const expected = int(d.checksum);
      if (msg.type === 'snapshot') {
        const r = b.applySnapshot({ bids: arr(d.bids) ?? [], asks: arr(d.asks) ?? [] }, { receivedTs });
        if (!r.ok) { resubscribe(sym, r.reason, receivedTs, epochToken); continue; }
        // W11: the documented snapshot carries a checksum; a missing one is not "synchronized enough" — resync, never assume
        if (expected === null) { stats.checksumMissing += 1; resubscribe(sym, 'CHECKSUM_MISSING', receivedTs, epochToken); continue; }
        const checksumOk = r.checksum === expected;
        if (!checksumOk) { stats.checksumFailures += 1; resubscribe(sym, 'CHECKSUM_MISMATCH', receivedTs, epochToken); continue; }
        exchangeTs.set(sym, { ts: sourceEventTs, checksumOk: true });
        coverageRecord(sym, 'OBSERVED', [], receivedTs, { observationCount: 1 }); coverageObservation(sym, 'SYNCHRONIZED', 'NONE', receivedTs, { bytesSha256 });
        snapshotObservation(sym, receivedTs, { sampleReason: 'SNAPSHOT', checksumOk, bytesSha256, sourceEventTs });
      } else {
        if (!b.synchronized) continue;
        const r = b.applyUpdate({ bids: arr(d.bids) ?? [], asks: arr(d.asks) ?? [], checksum: expected }, { receivedTs });
        if (!r.ok) { if (r.reason === 'CHECKSUM_MISMATCH') stats.checksumFailures += 1; if (r.reason === 'OVERFLOW') stats.overflows += 1; resubscribe(sym, r.reason, receivedTs, epochToken); continue; }
        if (expected === null) { stats.checksumMissing += 1; resubscribe(sym, 'CHECKSUM_MISSING', receivedTs, epochToken); continue; }
        stats.updates += 1; exchangeTs.set(sym, { ts: sourceEventTs, checksumOk: r.checksum.ok === true });
        if (r.events.length) { const m = byWs.get(sym); const ob = base.tryEmit({ endpointId: L3_ENDPOINT_ID, subject: m.subject, kind: 'L3_ORDER_EVENT', sourceEventTs, receivedTs, knownAtTs: receivedTs, epochId, quality: quality(r.checksum.ok === true ? 'KNOWN' : 'PARTIAL', { reasonCodes: r.checksum.ok === true ? [] : ['CHECKSUM_UNVERIFIED'], methodologyId: KRAKEN_L3_METHODOLOGY }), provenance: { requestId: null, bytesSha256, nativeLocator: sym, mappingId: KRAKEN_L3_METHODOLOGY, specificationId: null, vintage: 'LIVE_FORWARD_CAPTURE' }, payload: { depth, events: r.events, checksumVerified: r.checksum.ok } }, 'L3 events'); if (ob) { stats.eventsEmitted += r.events.length; if (ob.quality.state === 'CLOCK_CONFLICT') stats.clockConflicts += 1; onEvents(ob); } }
      }
    }
  }
  function onOpen({ epochId, send: wsSend }) {
    currentEpoch = epochId; for (const b of books.values()) b.reset('EPOCH'); subscribed.clear(); epochToken = null; exchangeTs.clear();
    base.setRuntime('ACTIVE');
    // the token is fetched per epoch (documented validity 15 minutes before first use); a failure blocks this epoch honestly
    auth.fetchToken().then((t) => { if (stopping || currentEpoch !== epochId) return; if (!t.ok) { stats.blocked = true; base.setRuntime('BLOCKED'); const ts = clock(); for (const w of byWs.keys()) { coverageRecord(w, 'ACCESS_BLOCKED', ['CREDENTIAL_MISSING'], ts, { endTs: ts }); coverageObservation(w, 'ACCESS_BLOCKED', 'CREDENTIAL_MISSING', ts); } void ws.stop(); return; } stats.tokens += 1; epochToken = t.token; pacer.request('subscribe', [...byWs.keys()].filter((w) => !dropped.has(w)), t.token); }, (err) => { log(`L3 token failed (contained): ${String(err?.message ?? err).slice(0, 120)}`); });
    void wsSend;
  }
  function onClose() {
    const ts = clock(); for (const [wsname, b] of books) { if (b.synchronized) { coverageRecord(wsname, 'GAP', ['EPOCH_GAP', 'DESYNCHRONIZED'], ts); coverageObservation(wsname, 'GAP', 'EPOCH_GAP', ts); } b.reset('EPOCH'); }
    subscribed.clear(); epochToken = null; exchangeTs.clear(); stats.reconnects += 1;
    if (!stopping && stats.reconnects > l3.maxReconnectAttempts) { base.setRuntime('DEGRADED'); for (const w of byWs.keys()) coverageRecord(w, 'GAP', ['SUBSCRIPTION_ENDED'], ts, { endTs: ts }); void ws.stop(); }
  }
  ws = createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: L3_ENDPOINT_ID, WebSocketImpl, clock, log, url, onMessage, onOpen, onClose, reconnectMaxMs: l3.reconnectBackoffMaxMs });
  // start: the permission fence FIRST; a key that is not a proven SAFE_L3_DATA_KEY never opens a socket (the blocker is named)
  async function start() {
    base.start(); const proof = await auth.proveDataKey(); stats.proof = { verdict: proof.verdict, blocker: proof.blocker ?? null, keyFingerprint: proof.keyFingerprint ?? null, provenTs: proof.provenTs ?? null };
    if (!proof.ok) { stats.blocked = true; base.setRuntime('BLOCKED'); const ts = clock(); for (const w of byWs.keys()) { coverageRecord(w, 'ACCESS_BLOCKED', [proof.verdict === 'CREDENTIAL_MISSING' ? 'CREDENTIAL_MISSING' : 'ENTITLEMENT_DENIED'], ts, { endTs: ts }); coverageObservation(w, 'ACCESS_BLOCKED', proof.verdict === 'CREDENTIAL_MISSING' ? 'CREDENTIAL_MISSING' : 'ENTITLEMENT_DENIED', ts); } return { ok: false, verdict: proof.verdict, blocker: proof.blocker ?? null, keyFingerprint: proof.keyFingerprint ?? null }; }
    ws.start(); return { ok: true, verdict: proof.verdict, blocker: null, keyFingerprint: proof.keyFingerprint };
  }
  async function stop() { stopping = true; pacer.stop(); await ws.stop(); base.stop(); }
  // an operator / runner sample of the current state (INTERVAL cadence); null when the book is not synchronized. The sample
  // carries the exchange clock of the last message that shaped the state and the checksum truth of that message.
  const sample = (wsname, reason = 'INTERVAL') => { const b = books.get(wsname); if (!b || !b.synchronized) return null; const last = exchangeTs.get(wsname) ?? null; return snapshotObservation(wsname, clock(), { sampleReason: reason, checksumOk: last ? last.checksumOk : null, sourceEventTs: last ? last.ts : null }); };
  return { start, stop, sample, books, pacer, status: () => deepFreeze({ ...ws.status(), ...stats, depth, runtime: base.status().runtime, synced: [...books.values()].filter((b) => b.synchronized).length, subscribed: [...subscribed].sort(), dropped: [...dropped].sort(), members: [...byWs.keys()], perBookOrderCap: perBook, pacing: pacer.status(), auth: auth.status() }), docsChecked: L3_DOCS_CHECKED };
}
