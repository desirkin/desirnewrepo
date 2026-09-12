// EXECUTION — the point-in-time execution feed (ticket §4.2-4.3): ONE existing public-feed owner (tape/run.js) fans its
// raw accepted Kraken v2 messages into this bounded seam. Exact numeric lexemes are preserved through the runtime's JSON
// reviver source tokens (verified on the deployed Node), books are kept as exact decimals, the CRC over the top ten levels
// is verified at exact source precision, and every applied message yields a DETACHED immutable snapshot (feed epoch, local
// receipt sequence, nativeSequence null — the public book channel has no documented native sequence — source / receipt
// clocks, CRC facts, instrument identity, bounded exact levels, content digest). Trades keep the native per-book trade_id
// (dedup) and the taker side verbatim. Hot-set admission is bounded and prioritized: held / pending exposure first (pinned:
// never shed, never evicted), shortlisted candidates next, research last; no slot -> refuse, never evict held exposure.
// Heartbeats are liveness, not quotes. A reconnect is a new epoch and invalidates continuity until restored. The venue
// sends a book SNAPSHOT only in answer to a subscription, so a symbol admitted AFTER the tape's book subscription was
// already acknowledged has no synchronized book here and every later `update` is ignored: that symbol is asked for a
// REAL venue snapshot through the bound tape (bounded, rate-limited). Nothing here manufactures depth, reuses stale
// depth as current or relaxes the synchronization law to produce a book.
import { crc32 } from '../lib/crc32.js';
import * as M from './money.js';
import { digestOf, bookSnapshotError } from './contract.js';

export const FEED_DEFAULTS = Object.freeze({ maxLevels: 100, maxCandidates: 6, maxResearch: 2, maxHotSet: 12, tradeDedupRing: 4096, maxBookAgeMs: 1000, impairedAfterMs: 5000, criticalAfterMs: 10_000, maxReceiptLagMs: 500, bookSnapshotRetryMs: 15_000 });
export const PRIORITIES = Object.freeze(['HELD', 'PENDING', 'CANDIDATE', 'RESEARCH']);
const PIN_PRIORITIES = new Set(['HELD', 'PENDING']);
// lexeme-preserving parse: numbers come back as their exact source tokens (strings); everything else unchanged
export function parseLexemes(raw) { return JSON.parse(raw, function reviver(key, value, context) { return typeof value === 'number' && context && typeof context.source === 'string' ? context.source : value; }); }
const canon = (lex) => M.fromNumberLexeme(lex);
// Kraken v2 checksum digit string: value formatted to exactly `decimals` places, '.' removed, leading zeros stripped
function crcDigits(lexeme, decimals) { const [ip, fp = ''] = lexeme.split('.'); if (fp.length > decimals) return null; const s = (ip + fp.padEnd(decimals, '0')).replace(/^0+/, ''); return s; }
const coinOf = (symbol) => symbol.split('/')[0];

export function createExecutionFeed({ clock = () => Date.now(), limits = FEED_DEFAULTS, log = () => {}, depthOf = () => 100 } = {}) {
  const L = { ...FEED_DEFAULTS, ...limits };
  const books = new Map(); // symbol -> { bids: Map, asks: Map, synced, lastReceiptTs, lastSourceTs, receiptSequence, priceDecimals, qtyDecimals, crcFailures, lastSnapshot }
  const admitted = new Map(); // symbol -> { priority, reason, admittedTs, coin }
  const tradeRings = new Map(); // symbol -> { set: Set, order: [] }
  const tradeCoverage = new Map(); // symbol -> { epoch, startTs, lastTs }
  const listeners = new Set(); const counters = { messages: 0, books: 0, trades: 0, tradesDeduped: 0, snapshotTrades: 0, crcFailures: 0, precisionUnsupported: 0, listenerErrors: 0, ignored: 0, parseErrors: 0, refusedAdmissions: 0, bookSnapshotsRequested: 0, bookSnapshotsRefused: 0, bookSnapshotSeamMissing: 0 };
  const bookRequests = new Map(); // symbol -> the clock of the last book-snapshot request to the tape (rate limit, per epoch)
  // public instrument PRECISION for every pair the venue announced, not only the admitted ones: the instrument channel is a
  // once-per-connection snapshot with no per-symbol subscription, so a symbol admitted later would otherwise never have the
  // decimals its CRC needs and crcVerified would stay null for the rest of the run (and BOOK_FRESH never passes). Two small
  // integers per pair, bounded, oldest dropped first — instrument metadata, never market data.
  const precisions = new Map(); const PRECISIONS_MAX = 4096; // comfortably above any venue's announced pair count
  let epoch = 0; let connected = false; let lastHeartbeatTs = null; let lastMessageTs = null; let tape = null; let receiptSequence = 0; counters.coverageGaps = 0; counters.futureTimestamps = 0; counters.laggedTrades = 0;
  // a liveness gap (no message / heartbeat within the impaired window) breaks every trade coverage: continuity restarts at the next message (closeout R09)
  function liveness(receiptTs) { const last = lastHeartbeatTs === null ? lastMessageTs : Math.max(lastHeartbeatTs, lastMessageTs ?? 0); if (last !== null && receiptTs - last > L.impairedAfterMs) { counters.coverageGaps += 1; for (const c of tradeCoverage.values()) { c.startTs = receiptTs; c.lastTs = receiptTs; c.gapTs = receiptTs; } } }
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch (err) { counters.listenerErrors += 1; if (counters.listenerErrors <= 3) log(`execution feed listener error (ignored): ${err?.message ?? err}`); } } };
  const bookOf = (symbol) => { if (!books.has(symbol)) { const p = precisions.get(symbol) ?? null; books.set(symbol, { bids: new Map(), asks: new Map(), synced: false, lastReceiptTs: null, lastSourceTs: null, receiptSequence: 0, priceDecimals: p ? p.priceDecimals : null, qtyDecimals: p ? p.qtyDecimals : null, crcFailures: 0, lastSnapshot: null, epoch }); } return books.get(symbol); };
  const sortedLevels = (map, side) => [...map.entries()].sort((a, b) => (side === 'bids' ? M.cmp(b[0], a[0]) : M.cmp(a[0], b[0])));
  // the exact subscribed depth: the bound tape's depthOf (the subscription it actually holds) wins, then the admission's depth, then the constructor's
  const depthFor = (symbol) => { const t = tape && typeof tape.depthOf === 'function' ? tape.depthOf(symbol) : null; const a = admitted.get(symbol)?.depth ?? null; const d = t ?? a ?? depthOf(symbol) ?? L.maxLevels; return Number.isSafeInteger(d) && d > 0 ? Math.min(d, L.maxLevels) : L.maxLevels; };
  function truncate(b, symbol) { const depth = depthFor(symbol); for (const side of ['bids', 'asks']) { const m = b[side]; if (m.size > depth) for (const [p] of sortedLevels(m, side).slice(depth)) m.delete(p); } }
  function checksum(b) { if (b.priceDecimals === null || b.qtyDecimals === null) return { computed: null, reason: 'PRECISION_UNKNOWN' }; let s = ''; for (const side of ['asks', 'bids']) for (const [p, q] of sortedLevels(b[side], side).slice(0, 10)) { const pd = crcDigits(p, b.priceDecimals); const qd = crcDigits(q, b.qtyDecimals); if (pd === null || qd === null) return { computed: null, reason: 'PRECISION_UNSUPPORTED' }; s += pd + qd; } return { computed: crc32(s), reason: null }; }
  function snapshotOf(symbol, b, { kind, sourceTs, receiptTs, crc, crcVerified, crcComputed }) {
    const bids = sortedLevels(b.bids, 'bids'); const asks = sortedLevels(b.asks, 'asks'); const cap = depthFor(symbol);
    const s = { snapshotVersion: 'execution-book-snapshot-1', symbol, canonicalCoin: coinOf(symbol), feedEpoch: epoch, receiptSequence: b.receiptSequence, nativeSequence: null, sourceTs, receiptTs, crc, crcVerified, crcComputed, synced: b.synced, instrumentDigest: admitted.get(symbol)?.specDigest ?? null, priceDecimals: b.priceDecimals, qtyDecimals: b.qtyDecimals, bids: bids.slice(0, cap).map(([p, q]) => Object.freeze([canon(p), canon(q)])), asks: asks.slice(0, cap).map(([p, q]) => Object.freeze([canon(p), canon(q)])), levelsCap: cap, truncated: bids.length > cap || asks.length > cap, kind, digest: 'x'.repeat(64) };
    s.digest = digestOf({ ...s, digest: null }); Object.freeze(s.bids); Object.freeze(s.asks); return Object.freeze(s); // deeply immutable: no subscriber can alter a level under the digest (closeout R09)
  }
  // ask the bound tape for a REAL venue book snapshot for an admitted symbol that has none. The tape owns the socket and
  // the subscription law (its own venue, its own depth): it may refuse. A refusal is counted and visible, never papered over
  // with invented depth. While disconnected nothing is asked — the next connect re-subscribes every carried symbol with
  // snapshot: true and the venue answers by itself.
  function requestBookSnapshot(symbol, reason, now = clock()) {
    if (!admitted.has(symbol)) return { ok: false, reason: 'NOT_ADMITTED' };
    if (books.get(symbol)?.synced) return { ok: false, reason: 'ALREADY_SYNCED' };
    if (!connected) return { ok: false, reason: 'NOT_CONNECTED' };
    if (!tape || typeof tape.requestBookSnapshot !== 'function') { counters.bookSnapshotSeamMissing += 1; return { ok: false, reason: 'NO_TAPE_SNAPSHOT_SEAM' }; }
    const last = bookRequests.get(symbol); if (last !== undefined && now - last < L.bookSnapshotRetryMs) return { ok: false, reason: 'RATE_LIMITED', retryAfterMs: L.bookSnapshotRetryMs - (now - last) };
    bookRequests.set(symbol, now);
    let r; try { r = tape.requestBookSnapshot(symbol, reason) ?? { ok: false, reason: 'NO_ANSWER' }; } catch (err) { r = { ok: false, reason: String(err?.message ?? err).slice(0, 80) }; }
    if (r.ok) counters.bookSnapshotsRequested += 1; else counters.bookSnapshotsRefused += 1;
    log(`book snapshot for ${symbol} (${reason}): ${r.ok ? 'REQUESTED' : `REFUSED ${r.reason}`}`);
    return r;
  }
  function applyBook(symbol, d, type, receiptTs) {
    const b = bookOf(symbol); b.receiptSequence = ++receiptSequence; const sourceTs = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) || null : null;
    let changes = null;
    if (type === 'snapshot') { b.bids.clear(); b.asks.clear(); b.epoch = epoch; for (const l of d.bids ?? []) b.bids.set(l.price, l.qty); for (const l of d.asks ?? []) b.asks.set(l.price, l.qty); b.synced = true; bookRequests.delete(symbol); truncate(b, symbol); }
    else { if (!b.synced) { counters.ignored += 1; requestBookSnapshot(symbol, 'UPDATE_WITHOUT_SNAPSHOT', receiptTs); return; } changes = []; for (const side of ['bids', 'asks']) for (const l of d[side] ?? []) { const q = canon(l.qty); changes.push([side, canon(l.price), q]); if (M.isZero(q)) b[side].delete(l.price); else b[side].set(l.price, l.qty); } truncate(b, symbol); }
    const crc = d.checksum === undefined ? null : Number(d.checksum); const { computed, reason } = checksum(b); if (reason === 'PRECISION_UNSUPPORTED') counters.precisionUnsupported += 1;
    let crcVerified = null; if (crc !== null && computed !== null) { crcVerified = computed === crc; if (!crcVerified) { b.crcFailures += 1; counters.crcFailures += 1; b.synced = false; b.bids.clear(); b.asks.clear(); emit({ kind: 'HEALTH', symbol, state: 'DESYNCHRONIZED', reason: 'CRC_MISMATCH', receiptTs, epoch }); return; } }
    b.lastReceiptTs = receiptTs; b.lastSourceTs = sourceTs; counters.books += 1;
    const snap = snapshotOf(symbol, b, { kind: type === 'snapshot' ? 'SNAPSHOT' : 'UPDATE', sourceTs, receiptTs, crc, crcVerified, crcComputed: computed }); b.lastSnapshot = snap; emit({ kind: 'BOOK', symbol, snapshot: snap, changes: changes ? Object.freeze(changes) : null });
  }
  function applyTrade(symbol, t, type, receiptTs) {
    const ring = tradeRings.get(symbol) ?? (tradeRings.set(symbol, { set: new Set(), order: [] }), tradeRings.get(symbol)); const id = t.trade_id === undefined || t.trade_id === null ? null : String(t.trade_id);
    if (id !== null) { if (ring.set.has(id)) { counters.tradesDeduped += 1; return; } ring.set.add(id); ring.order.push(id); if (ring.order.length > L.tradeDedupRing) ring.set.delete(ring.order.shift()); }
    const fromSnapshot = type === 'snapshot';
    const price = canon(t.price); const qty = canon(t.qty); const eventTs = Date.parse(t.timestamp); if (!Number.isFinite(eventTs)) { counters.ignored += 1; return; }
    // a trade stamped in the future cannot be point-in-time evidence: refused, and the symbol's coverage restarts (closeout R09)
    if (eventTs > receiptTs + L.maxReceiptLagMs) { counters.futureTimestamps += 1; counters.ignored += 1; const cov = tradeCoverage.get(symbol); if (cov) { cov.startTs = receiptTs; cov.lastTs = receiptTs; cov.gapTs = receiptTs; } return; }
    if (fromSnapshot) counters.snapshotTrades += 1; else counters.trades += 1;
    if (receiptTs - eventTs > L.maxReceiptLagMs) counters.laggedTrades += 1;
    if (!fromSnapshot) { const cov = tradeCoverage.get(symbol); if (cov && cov.epoch === epoch) cov.lastTs = receiptTs; }
    const trade = Object.freeze({ tradeVersion: 'execution-trade-1', symbol, canonicalCoin: coinOf(symbol), feedEpoch: epoch, receiptSequence: ++receiptSequence, nativeTradeId: id, side: t.side, price, qty, quoteNotional: M.mul(price, qty), eventTs, receiptTs, fromSubscriptionSnapshot: fromSnapshot, orderType: typeof t.ord_type === 'string' ? t.ord_type : null });
    emit({ kind: 'TRADE', symbol, trade });
  }
  function ingest(raw, receiptTs = clock()) {
    counters.messages += 1; liveness(receiptTs); lastMessageTs = receiptTs; let msg; try { msg = parseLexemes(raw); } catch { counters.parseErrors += 1; return; }
    if (msg.channel === 'heartbeat') { lastHeartbeatTs = receiptTs; return; }
    if (msg.method === 'subscribe' && msg.success === true && msg.result?.channel === 'trade' && admitted.has(msg.result.symbol)) { tradeCoverage.set(msg.result.symbol, { epoch, startTs: receiptTs, lastTs: receiptTs }); return; }
    if (msg.channel === 'instrument') { for (const p of msg.data?.pairs ?? []) { const pp = p.price_precision !== undefined ? Number(p.price_precision) : null; const qp = p.qty_precision !== undefined ? Number(p.qty_precision) : null; if (!Number.isInteger(pp) || !Number.isInteger(qp) || typeof p.symbol !== 'string') continue; if (!precisions.has(p.symbol) && precisions.size >= PRECISIONS_MAX) { for (const k of precisions.keys()) if (!admitted.has(k)) { precisions.delete(k); break; } } /* never evict a pair the hot set is holding */ precisions.set(p.symbol, { priceDecimals: pp, qtyDecimals: qp }); if (books.has(p.symbol)) { const b = books.get(p.symbol); b.priceDecimals = pp; b.qtyDecimals = qp; } } return; }
    if (msg.channel === 'book') { for (const d of msg.data ?? []) if (admitted.has(d.symbol)) applyBook(d.symbol, d, msg.type, receiptTs); return; }
    if (msg.channel === 'trade') { for (const t of msg.data ?? []) if (admitted.has(t.symbol)) applyTrade(t.symbol, t, msg.type, receiptTs); return; }
  }
  function onConnect(ts = clock()) { epoch += 1; connected = true; for (const b of books.values()) { b.synced = false; b.bids.clear(); b.asks.clear(); b.lastSnapshot = null; } tradeCoverage.clear(); bookRequests.clear(); emit({ kind: 'EPOCH', epoch, ts, reason: 'CONNECT' }); if (tape) for (const s of admitted.keys()) tape.ensureSubscribed(s, admitted.get(s)); }
  function onDisconnect(ts = clock()) { connected = false; for (const b of books.values()) { b.synced = false; b.bids.clear(); b.asks.clear(); } bookRequests.clear(); emit({ kind: 'EPOCH', epoch, ts, reason: 'DISCONNECT' }); }
  // ---- bounded prioritized admission -----------------------------------------------------------------------------------
  function admit(symbol, { coin = coinOf(symbol), priority, reason = null, specDigest = null, depth = null } = {}) {
    if (!PRIORITIES.includes(priority)) return { ok: false, reason: 'PRIORITY_UNKNOWN' };
    const cur = admitted.get(symbol); if (cur) { if (PRIORITIES.indexOf(priority) < PRIORITIES.indexOf(cur.priority)) cur.priority = priority; cur.reason = reason ?? cur.reason; if (specDigest) cur.specDigest = specDigest; return { ok: true, symbol, priority: cur.priority, existing: true }; }
    const counts = { CANDIDATE: 0, RESEARCH: 0 }; for (const a of admitted.values()) if (counts[a.priority] !== undefined) counts[a.priority] += 1;
    if (!PIN_PRIORITIES.has(priority)) { if (admitted.size >= L.maxHotSet) { counters.refusedAdmissions += 1; return { ok: false, reason: 'HOT_SET_FULL' }; } if (priority === 'CANDIDATE' && counts.CANDIDATE >= L.maxCandidates) { counters.refusedAdmissions += 1; return { ok: false, reason: 'CANDIDATE_SLOTS_FULL' }; } if (priority === 'RESEARCH' && counts.RESEARCH >= L.maxResearch) { counters.refusedAdmissions += 1; return { ok: false, reason: 'RESEARCH_SLOTS_FULL' }; } }
    const entry = { priority, reason, admittedTs: clock(), coin, specDigest, depth }; admitted.set(symbol, entry); bookOf(symbol);
    const sub = tape ? tape.ensureSubscribed(symbol, entry) : { ok: null, reason: 'NO_TAPE_BOUND' };
    // a CARRIED symbol was already subscribed before this admission: its one book snapshot is gone and its trade
    // acknowledgement was never ours. Ask for a real snapshot now, and start THIS symbol's trade coverage at THIS clock —
    // never backdated to a subscription we did not observe, and only while the connection is live (a liveness gap still breaks it).
    let bookSnapshot = null;
    if (sub?.ok === true && sub.carried === true) {
      bookSnapshot = requestBookSnapshot(symbol, 'ADMITTED_AFTER_SUBSCRIPTION', entry.admittedTs);
      const cov = tradeCoverage.get(symbol); if (connected && (!cov || cov.epoch !== epoch)) tradeCoverage.set(symbol, { epoch, startTs: entry.admittedTs, lastTs: entry.admittedTs });
    }
    return { ok: true, symbol, priority, subscription: sub, bookSnapshot };
  }
  function release(symbol, { force = false } = {}) { const cur = admitted.get(symbol); if (!cur) return { ok: true, absent: true }; if (PIN_PRIORITIES.has(cur.priority) && !force) return { ok: false, reason: 'PINNED' }; admitted.delete(symbol); books.delete(symbol); tradeRings.delete(symbol); tradeCoverage.delete(symbol); bookRequests.delete(symbol); return { ok: true }; }
  const pinned = () => new Set([...admitted.entries()].filter(([, a]) => PIN_PRIORITIES.has(a.priority)).map(([s]) => s));
  function health(symbol, now = clock()) { const b = books.get(symbol); const age = b?.lastReceiptTs === null || !b ? null : now - b.lastReceiptTs; const usable = connected && Boolean(b?.synced) && age !== null && age <= L.maxBookAgeMs; return { symbol, connected, epoch, synced: Boolean(b?.synced), bookAgeMs: age, usable, awaitingBookSnapshot: Boolean(b) && !b.synced && bookRequests.has(symbol), impaired: !connected || age === null || age > L.impairedAfterMs, critical: !connected || age === null || age > L.criticalAfterMs, heartbeatAgeMs: lastHeartbeatTs === null ? null : now - lastHeartbeatTs, crcFailures: b?.crcFailures ?? 0, tradeCoverage: coverage(symbol, now) }; }
  function coverage(symbol, now = clock()) { const c = tradeCoverage.get(symbol); if (!c || c.epoch !== epoch || !connected) return { continuous: false, epoch, startTs: null, endTs: null, reason: 'NOT_SUBSCRIBED' }; const last = lastHeartbeatTs === null ? lastMessageTs : Math.max(lastHeartbeatTs, lastMessageTs ?? 0); if (last === null || now - last > L.impairedAfterMs) return { continuous: false, epoch, startTs: null, endTs: null, reason: 'LIVENESS_GAP' }; return { continuous: true, epoch, startTs: c.startTs, endTs: now, gapTs: c.gapTs ?? null }; }
  return {
    ingest, onConnect, onDisconnect, admit, release, pinned, health, coverage, parseLexemes, requestBookSnapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    latest: (symbol) => books.get(symbol)?.lastSnapshot ?? null,
    admittedSymbols: () => [...admitted.entries()].map(([symbol, a]) => ({ symbol, ...a })),
    bindTape(t) { tape = t; for (const [s, a] of admitted) t.ensureSubscribed(s, a); },
    status: () => ({ epoch, connected, admitted: admitted.size, pinned: pinned().size, counters: { ...counters }, lastHeartbeatTs, lastMessageTs, receiptSequence, limits: L }),
    limits: L,
  };
}
export { bookSnapshotError };
