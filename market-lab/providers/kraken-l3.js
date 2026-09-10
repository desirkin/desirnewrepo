// MARKET-EDGE-KRAKEN-1 (B) — the Kraken Spot LEVEL 3 stream (wss://ws-l3.kraken.com/v2, channel level3) on the EXISTING
// KRAKEN_SPOT provider. It never replaces the public L2 path (providers/kraken-spot.js createStream) and never calls L2 "L3".
// Sequence: prove the DEDICATED data key (narrow helper; anything but SAFE_DATA_KEY blocks) -> fetch a token -> connect ->
// subscribe level3 ONLY (depth from policy, default 10, bounded symbols, bounded subscriptions/second). Every message drives
// the pure book (l3-book.js): snapshot replaces state; add / modify / delete per docs; truncation SCOPE_EVICTS; an unknown
// order, a checksum failure or a resource overflow DESYNCHRONIZES and resubscribes for a fresh snapshot; a disconnect opens
// a new epoch (no bridging of ages). Resource bounds are explicit coverage facts (QUEUE_DROPPED / OVERFLOW), never silent.
// Authority: NONE — this module can only subscribe / unsubscribe a market-data channel; it holds no order verb.
import { createClientBase, str, int, arr, obj } from './base.js';
import { createWsClient } from '../transport.js';
import { quality, deepFreeze, fail, L3_DEPTHS } from '../contracts.js';
import { createL3Book } from '../l3-book.js';
import { L3_DEFAULTS } from '../policy.js';

export const L3_ENDPOINT_ID = 'ws-l3';
export const KRAKEN_L3_METHODOLOGY = 'kraken-ws-level3-v2';
export const L3_DOCS_CHECKED = '2026-09-10';
const FAMILY = 'L3_MICROSTRUCTURE';

export function createKrakenL3Stream({ transport, clock = () => Date.now(), log = () => {}, auth, markets, l3 = L3_DEFAULTS, depth = l3.depth, WebSocketImpl, url = null, onSnapshot = () => {}, onEvents = () => {}, onCoverage = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  if (!auth || typeof auth.proveDataKey !== 'function' || typeof auth.fetchToken !== 'function') fail('INVALID_REQUEST', 'the L3 stream needs the narrow auth helper');
  if (!Array.isArray(markets) || !markets.length) fail('INVALID_REQUEST', 'at least one market');
  if (markets.length > l3.maxSymbols) fail('RESOURCE_LIMIT_EXCEEDED', `at most ${l3.maxSymbols} L3 symbols under the policy`);
  if (!L3_DEPTHS.includes(depth)) fail('INVALID_REQUEST', 'depth must be 10, 100 or 1000');
  const base = createClientBase({ providerId: 'KRAKEN_SPOT', transport, clock, log });
  const byWs = new Map(markets.map((m) => [m.wsname, m]));
  const perBook = Math.max(1, Math.floor(l3.maxInMemoryOrders / markets.length));
  const books = new Map(markets.map((m) => [m.wsname, createL3Book({ symbol: m.wsname, depth, maxOrders: perBook })]));
  const stats = { snapshots: 0, updates: 0, eventsEmitted: 0, resyncs: 0, unknownSymbols: 0, checksumFailures: 0, queueDropped: 0, overflows: 0, tokens: 0, reconnects: 0, blocked: false, proof: null };
  const subscribed = new Set(); const dropped = new Set(); let currentEpoch = null; let ws = null; let stopping = false; let rate = { second: 0, count: 0 }; let pendingTimers = new Set();
  const coverageRecord = (wsname, state, reasonCodes, ts, extra = {}) => { const m = byWs.get(wsname); if (!m) return; try { onCoverage(base.coverage({ endpointId: L3_ENDPOINT_ID, subject: m.subject, family: FAMILY, kind: 'L3_BOOK_COVERAGE', state, reasonCodes, startTs: ts, endTs: extra.endTs ?? null, observationCount: extra.observationCount ?? 0, droppedCount: extra.droppedCount ?? 0, epochId: currentEpoch })); } catch (err) { log(`L3 coverage rejected: ${String(err?.message ?? err).slice(0, 120)}`); } };
  const coverageObservation = (wsname, state, reason, receivedTs, { droppedUpdates = 0, bytesSha256 = null } = {}) => { const m = byWs.get(wsname); const b = books.get(wsname); if (!m || !b) return null; const ob = base.tryEmit({ endpointId: L3_ENDPOINT_ID, subject: m.subject, kind: 'L3_BOOK_COVERAGE', receivedTs, knownAtTs: receivedTs, epochId: currentEpoch, quality: quality('KNOWN', { methodologyId: KRAKEN_L3_METHODOLOGY }), provenance: { requestId: null, bytesSha256, nativeLocator: wsname, mappingId: KRAKEN_L3_METHODOLOGY, specificationId: null, vintage: 'LIVE_FORWARD_CAPTURE' }, payload: { state, reason, sinceTs: receivedTs, untilTs: null, droppedUpdates, depth, ordersTracked: b.size } }, 'L3 coverage'); if (ob) onSnapshot(ob); return ob; };
  const snapshotObservation = (wsname, receivedTs, { sampleReason, checksumOk, bytesSha256 = null }) => {
    const m = byWs.get(wsname); const b = books.get(wsname); if (!m || !b) return null; const v = b.view();
    const ob = base.tryEmit({ endpointId: L3_ENDPOINT_ID, subject: m.subject, kind: 'L3_BOOK_SNAPSHOT', receivedTs, knownAtTs: receivedTs, epochId: currentEpoch, quality: quality(b.synchronized ? 'KNOWN' : 'PARTIAL', { reasonCodes: b.synchronized ? (checksumOk === null ? ['CHECKSUM_UNVERIFIED'] : []) : ['DESYNCHRONIZED'], methodologyId: KRAKEN_L3_METHODOLOGY }), provenance: { requestId: null, bytesSha256, nativeLocator: wsname, mappingId: KRAKEN_L3_METHODOLOGY, specificationId: null, vintage: 'LIVE_FORWARD_CAPTURE' },
      payload: { depth, bids: v.bids, asks: v.asks, checksumVerified: checksumOk, synchronized: b.synchronized, sampleReason, truncated: v.truncated, pricePrecision: m.pricePrecision ?? null, qtyPrecision: m.qtyPrecision ?? null } }, 'L3 snapshot');
    if (ob) { stats.snapshots += 1; onSnapshot(ob); } return ob;
  };
  const send = (msg) => (ws ? ws.send(msg) : false);
  // subscriptions are rate-bounded: at most maxSubscriptionsPerSecond symbols per wall second, the rest deferred
  function subscribeSymbols(symbols, token) {
    const now = Math.floor(clock() / 1000); if (rate.second !== now) rate = { second: now, count: 0 };
    const room = Math.max(0, l3.maxSubscriptionsPerSecond - rate.count); const nowBatch = symbols.slice(0, room); const later = symbols.slice(room);
    if (nowBatch.length) { rate.count += nowBatch.length; send({ method: 'subscribe', params: { channel: 'level3', symbol: nowBatch, depth, snapshot: true, token } }); }
    // the deferred remainder waited a real second: the wall wait IS the pacing, so the window resets before it is sent (a frozen
    // injected clock can never stall a subscription forever)
    if (later.length) { const t = timers.setTimeout(() => { pendingTimers.delete(t); if (!stopping && ws) { rate = { second: -1, count: 0 }; subscribeSymbols(later, token); } }, 1000); pendingTimers.add(t); }
  }
  const resubscribe = (wsname, reason, receivedTs, token) => { const b = books.get(wsname); b.reset(reason); stats.resyncs += 1; coverageRecord(wsname, 'GAP', [reason === 'CHECKSUM_MISMATCH' ? 'DESYNCHRONIZED' : reason === 'OVERFLOW' ? 'COVERAGE_OVERFLOW' : 'DESYNCHRONIZED'], receivedTs); coverageObservation(wsname, reason === 'OVERFLOW' ? 'OVERFLOW' : reason === 'CHECKSUM_MISMATCH' ? 'DESYNCHRONIZED' : 'DEGRADED', reason === 'OVERFLOW' ? 'COVERAGE_OVERFLOW' : 'DESYNCHRONIZED', receivedTs); if (reason === 'OVERFLOW') { dropped.add(wsname); send({ method: 'unsubscribe', params: { channel: 'level3', symbol: [wsname], depth } }); return; } send({ method: 'unsubscribe', params: { channel: 'level3', symbol: [wsname], depth } }); send({ method: 'subscribe', params: { channel: 'level3', symbol: [wsname], depth, snapshot: true, token } }); };
  let epochToken = null; let epochMessages = { second: 0, count: 0 };
  function onMessage(msg, { receivedTs, epochId, bytesSha256 }) {
    // the message-rate bound: beyond maxQueueMessages per second the update stream is DROPPED (counted) and every book resyncs
    const sec = Math.floor(receivedTs / 1000); if (epochMessages.second !== sec) epochMessages = { second: sec, count: 0 }; epochMessages.count += 1;
    if (epochMessages.count > l3.maxQueueMessages) { stats.queueDropped += 1; if (epochMessages.count === l3.maxQueueMessages + 1) for (const wsname of books.keys()) { if (books.get(wsname).synchronized) { coverageRecord(wsname, 'DROPPED', ['QUEUE_DROPPED'], receivedTs, { droppedCount: 1 }); resubscribe(wsname, 'QUEUE_DROPPED', receivedTs, epochToken); } } return; }
    if (msg.method === 'subscribe') { const res = obj(msg.result); const sym = str(res?.symbol, 40); if (!sym || !byWs.has(sym) || res?.channel !== 'level3') return; if (msg.success === true) { subscribed.add(sym); coverageRecord(sym, 'SUBSCRIBED', [], receivedTs); coverageObservation(sym, 'SUBSCRIBED', 'NONE', receivedTs, { bytesSha256 }); } else { coverageRecord(sym, 'FAILED', ['PROVIDER_ERROR'], receivedTs, { endTs: receivedTs }); coverageObservation(sym, 'UNSUBSCRIBED', 'PROVIDER_ERROR', receivedTs, { bytesSha256 }); } return; }
    if (msg.channel !== 'level3') return;
    for (const d of arr(msg.data) ?? []) {
      const sym = str(obj(d)?.symbol, 40); const b = sym ? books.get(sym) : null; if (!b || dropped.has(sym)) { stats.unknownSymbols += 1; continue; }
      if (msg.type === 'snapshot') {
        const r = b.applySnapshot({ bids: arr(d.bids) ?? [], asks: arr(d.asks) ?? [] }, { receivedTs });
        if (!r.ok) { resubscribe(sym, r.reason, receivedTs, epochToken); continue; }
        const expected = int(d.checksum); const checksumOk = expected === null ? null : r.checksum === expected;
        if (checksumOk === false) { stats.checksumFailures += 1; resubscribe(sym, 'CHECKSUM_MISMATCH', receivedTs, epochToken); continue; }
        coverageRecord(sym, 'OBSERVED', [], receivedTs, { observationCount: 1 }); coverageObservation(sym, 'SYNCHRONIZED', 'NONE', receivedTs, { bytesSha256 });
        snapshotObservation(sym, receivedTs, { sampleReason: 'SNAPSHOT', checksumOk, bytesSha256 });
      } else {
        if (!b.synchronized) continue;
        const r = b.applyUpdate({ bids: arr(d.bids) ?? [], asks: arr(d.asks) ?? [], checksum: int(d.checksum) }, { receivedTs });
        if (!r.ok) { if (r.reason === 'CHECKSUM_MISMATCH') stats.checksumFailures += 1; if (r.reason === 'OVERFLOW') stats.overflows += 1; resubscribe(sym, r.reason, receivedTs, epochToken); continue; }
        stats.updates += 1;
        if (r.events.length) { const m = byWs.get(sym); const ob = base.tryEmit({ endpointId: L3_ENDPOINT_ID, subject: m.subject, kind: 'L3_ORDER_EVENT', receivedTs, knownAtTs: receivedTs, epochId, quality: quality('KNOWN', { reasonCodes: r.checksum.ok === null ? ['CHECKSUM_UNVERIFIED'] : [], methodologyId: KRAKEN_L3_METHODOLOGY }), provenance: { requestId: null, bytesSha256, nativeLocator: sym, mappingId: KRAKEN_L3_METHODOLOGY, specificationId: null, vintage: 'LIVE_FORWARD_CAPTURE' }, payload: { depth, events: r.events, checksumVerified: r.checksum.ok } }, 'L3 events'); if (ob) { stats.eventsEmitted += r.events.length; onEvents(ob); } }
      }
    }
  }
  function onOpen({ epochId, send: wsSend }) {
    currentEpoch = epochId; for (const b of books.values()) b.reset('EPOCH'); subscribed.clear(); epochToken = null;
    base.setRuntime('ACTIVE');
    // the token is fetched per epoch (documented validity 15 minutes before first use); a failure blocks this epoch honestly
    auth.fetchToken().then((t) => { if (stopping || currentEpoch !== epochId) return; if (!t.ok) { stats.blocked = true; base.setRuntime('BLOCKED'); const ts = clock(); for (const w of byWs.keys()) { coverageRecord(w, 'ACCESS_BLOCKED', ['CREDENTIAL_MISSING'], ts, { endTs: ts }); coverageObservation(w, 'ACCESS_BLOCKED', 'CREDENTIAL_MISSING', ts); } void ws.stop(); return; } stats.tokens += 1; epochToken = t.token; subscribeSymbols([...byWs.keys()].filter((w) => !dropped.has(w)), t.token); }, (err) => { log(`L3 token failed (contained): ${String(err?.message ?? err).slice(0, 120)}`); });
    void wsSend;
  }
  function onClose() {
    const ts = clock(); for (const [wsname, b] of books) { if (b.synchronized) { coverageRecord(wsname, 'GAP', ['EPOCH_GAP', 'DESYNCHRONIZED'], ts); coverageObservation(wsname, 'GAP', 'EPOCH_GAP', ts); } b.reset('EPOCH'); }
    subscribed.clear(); epochToken = null; stats.reconnects += 1;
    if (!stopping && stats.reconnects > l3.maxReconnectAttempts) { base.setRuntime('DEGRADED'); for (const w of byWs.keys()) coverageRecord(w, 'GAP', ['SUBSCRIPTION_ENDED'], ts, { endTs: ts }); void ws.stop(); }
  }
  ws = createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: L3_ENDPOINT_ID, WebSocketImpl, clock, log, url, onMessage, onOpen, onClose, reconnectMaxMs: l3.reconnectBackoffMaxMs });
  // start: the permission fence FIRST; a key that is not a proven DATA key never opens a socket
  async function start() {
    base.start(); const proof = await auth.proveDataKey(); stats.proof = { verdict: proof.verdict, keyFingerprint: proof.keyFingerprint ?? null, provenTs: proof.provenTs ?? null };
    if (!proof.ok) { stats.blocked = true; base.setRuntime('BLOCKED'); const ts = clock(); for (const w of byWs.keys()) { coverageRecord(w, 'ACCESS_BLOCKED', [proof.verdict === 'CREDENTIAL_MISSING' ? 'CREDENTIAL_MISSING' : 'ENTITLEMENT_DENIED'], ts, { endTs: ts }); coverageObservation(w, 'ACCESS_BLOCKED', proof.verdict === 'CREDENTIAL_MISSING' ? 'CREDENTIAL_MISSING' : 'ENTITLEMENT_DENIED', ts); } return { ok: false, verdict: proof.verdict, keyFingerprint: proof.keyFingerprint ?? null }; }
    ws.start(); return { ok: true, verdict: proof.verdict, keyFingerprint: proof.keyFingerprint };
  }
  async function stop() { stopping = true; for (const t of pendingTimers) timers.clearTimeout(t); pendingTimers.clear(); await ws.stop(); base.stop(); }
  // an operator / runner sample of the current state (INTERVAL cadence); null when the book is not synchronized
  const sample = (wsname, reason = 'INTERVAL') => { const b = books.get(wsname); if (!b || !b.synchronized) return null; return snapshotObservation(wsname, clock(), { sampleReason: reason, checksumOk: b.status().lastChecksum?.ok ?? null }); };
  return { start, stop, sample, books, status: () => deepFreeze({ ...ws.status(), ...stats, depth, runtime: base.status().runtime, synced: [...books.values()].filter((b) => b.synchronized).length, subscribed: [...subscribed].sort(), dropped: [...dropped].sort(), members: [...byWs.keys()], perBookOrderCap: perBook, auth: auth.status() }), docsChecked: L3_DOCS_CHECKED };
}
