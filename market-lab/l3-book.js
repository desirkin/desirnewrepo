// MARKET-EDGE-KRAKEN-1 (B) — the PURE Kraken Spot Level 3 book state machine (no network, no clock, no filesystem).
// Documented 2026-09-10 (docs.kraken.com websocket-v2/level3 + exchange/guides/websockets/l3-checksum-v2):
//  * a snapshot REPLACES the state for its symbol; updates carry per-order events add | modify | delete;
//  * after EVERY update the book is truncated to the subscribed depth (price levels per side) and the venue sends NO delete
//    for orders that fall out of scope — those orders are SCOPE_EVICTED here: they left our window, they were NOT cancelled;
//  * a delete event is a removal from the visible book (fill, cancel or expiry are indistinguishable): never "proven cancel";
//  * the checksum is CRC32 over the top 10 price levels per side iterating INDIVIDUAL orders in queue order (asks low->high,
//    then bids high->low), each order contributing limit_price then order_qty with the decimal point removed and leading
//    zeros stripped — order_id / timestamp are excluded. It verifies queue priority, unlike the L2 book checksum.
//  * an unknown order in a modify / delete, a duplicate add, a checksum mismatch or a resource overflow DESYNCHRONIZES the
//    book: the stream owner must resubscribe for a fresh snapshot. Nothing bridges ages across a snapshot or an epoch.
// Order identity persisted outside this process is sha256(symbol|order_id) (24 hex): stable, never the venue id itself.
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { deepFreeze, fail, L3_DEPTHS, MAX_L3_ORDERS_PER_SIDE } from './contracts.js';

export const L3_BOOK_VERSION = 'kraken-l3-book-1';
export const CHECKSUM_LEVELS = 10;
export const L3_DESYNC_REASONS = Object.freeze(['SCHEMA', 'UNKNOWN_ORDER', 'DUPLICATE_ADD', 'CHECKSUM_MISMATCH', 'OVERFLOW', 'NOT_SYNCHRONIZED', 'CROSSED']);
export const orderKeyOf = (symbol, orderId) => createHash('sha256').update(`${symbol}|${orderId}`).digest('hex').slice(0, 24);
// documented field formatting for the checksum: remove the decimal point, then strip leading zeros
export const checksumField = (s) => String(s).replace('.', '').replace(/^0+/, '');
const DEC_RE = /^\d+(\.\d+)?$/;
const numStr = (v) => (typeof v === 'string' && v.length <= 40 && DEC_RE.test(v) ? v : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : null);
const isoTs = (v) => { if (typeof v !== 'string' || v.length > 40) return null; const ms = Date.parse(v); return Number.isFinite(ms) && ms > 0 ? ms : null; };
const isTs = (v) => Number.isSafeInteger(v) && v > 0;

// one documented order record -> a parsed order or null (fails closed on any malformed field)
export function parseL3Order(raw, { symbol, receivedTs }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const orderId = typeof raw.order_id === 'string' && raw.order_id.length > 0 && raw.order_id.length <= 64 ? raw.order_id : null;
  const priceStr = numStr(raw.limit_price); const qtyStr = numStr(raw.order_qty);
  if (orderId === null || priceStr === null || qtyStr === null) return null;
  const price = Number(priceStr); const qty = Number(qtyStr);
  if (!(price > 0) || !(qty >= 0)) return null;
  const providerTs = raw.timestamp === undefined || raw.timestamp === null ? null : isoTs(raw.timestamp); if (raw.timestamp !== undefined && raw.timestamp !== null && providerTs === null) return null;
  return { orderId, orderKey: orderKeyOf(symbol, orderId), price, priceStr, qty, qtyStr, providerTs, receivedTs };
}
// the checksum digest over sorted top-10 levels of orders (each level: { orders: [{ priceStr, qtyStr }] } in queue order)
export function l3ChecksumDigest({ asks, bids }) {
  let s = '';
  for (const lvl of asks.slice(0, CHECKSUM_LEVELS)) for (const o of lvl.orders) s += checksumField(o.priceStr) + checksumField(o.qtyStr);
  for (const lvl of bids.slice(0, CHECKSUM_LEVELS)) for (const o of lvl.orders) s += checksumField(o.priceStr) + checksumField(o.qtyStr);
  return s;
}
export const l3Checksum = (digest) => crc32(digest) >>> 0;

export function createL3Book({ symbol, depth = 10, maxOrders = 50_000 } = {}) {
  if (typeof symbol !== 'string' || !symbol.length) fail('INVALID_REQUEST', 'an L3 book needs its symbol');
  if (!L3_DEPTHS.includes(depth)) fail('INVALID_REQUEST', 'depth must be 10, 100 or 1000');
  if (!Number.isSafeInteger(maxOrders) || maxOrders < 1) fail('INVALID_REQUEST', 'maxOrders must be a positive integer');
  const orders = new Map(); // orderId -> order (with side, firstSeenTs, modifiedTs)
  const levels = { BID: new Map(), ASK: new Map() }; // priceStr -> { price, priceStr, ids: [] } (queue order)
  let synchronized = false; let lastReason = null; let snapshots = 0; let updates = 0; let evictions = 0; let checksumFailures = 0; let lastChecksum = null; let lastSnapshotTs = null;
  const sorted = (side) => [...levels[side].values()].sort((a, b) => (side === 'BID' ? b.price - a.price : a.price - b.price));
  const levelView = (side) => sorted(side).map((l) => ({ price: l.price, priceStr: l.priceStr, orders: l.ids.map((id) => orders.get(id)) }));
  const removeFromLevel = (o) => { const l = levels[o.side].get(o.priceStr); if (!l) return; const i = l.ids.indexOf(o.orderId); if (i >= 0) l.ids.splice(i, 1); if (!l.ids.length) levels[o.side].delete(o.priceStr); };
  const addToLevel = (o) => { let l = levels[o.side].get(o.priceStr); if (!l) { l = { price: o.price, priceStr: o.priceStr, ids: [] }; levels[o.side].set(o.priceStr, l); } l.ids.push(o.orderId); };
  const desync = (reason) => { synchronized = false; lastReason = reason; return { ok: false, reason }; };
  const clear = () => { orders.clear(); levels.BID.clear(); levels.ASK.clear(); };
  const event = (kind, o, { receivedTs, previousQty = null, qty = o.qty }) => ({ event: kind, orderKey: o.orderKey, side: o.side, price: o.price, qty, previousQty, providerTs: o.providerTs, firstSeenTs: o.firstSeenTs, ageMs: Math.max(0, receivedTs - o.firstSeenTs) });
  // truncate each side to the subscribed depth (price levels); evicted orders leave the window — never a cancel
  function truncate(receivedTs) {
    const out = [];
    for (const side of ['BID', 'ASK']) { const s = sorted(side); for (const l of s.slice(depth)) { for (const id of l.ids) { const o = orders.get(id); orders.delete(id); evictions += 1; out.push(event('SCOPE_EVICTED', o, { receivedTs, previousQty: o.qty, qty: 0 })); } levels[side].delete(l.priceStr); } }
    return out;
  }
  const crossed = () => { const b = sorted('BID')[0]; const a = sorted('ASK')[0]; return Boolean(b && a && b.price >= a.price); };
  function applySnapshot({ bids, asks }, { receivedTs }) {
    if (!isTs(receivedTs) || !Array.isArray(bids) || !Array.isArray(asks)) return desync('SCHEMA');
    clear(); const seen = new Set();
    for (const [side, list] of [['BID', bids], ['ASK', asks]]) {
      for (const raw of list) {
        const p = parseL3Order(raw, { symbol, receivedTs }); if (!p) { clear(); return desync('SCHEMA'); }
        if (seen.has(p.orderId)) { clear(); return desync('DUPLICATE_ADD'); } seen.add(p.orderId);
        if (orders.size >= maxOrders) { clear(); return desync('OVERFLOW'); }
        const o = { ...p, side, firstSeenTs: receivedTs, modifiedTs: null }; orders.set(o.orderId, o); addToLevel(o);
      }
    }
    if (crossed()) { clear(); return desync('CROSSED'); }
    const evicted = truncate(receivedTs); // a snapshot deeper than the subscription is trimmed the same way
    synchronized = true; lastReason = null; snapshots += 1; lastSnapshotTs = receivedTs;
    return { ok: true, orders: orders.size, evicted: evicted.length, checksum: checksum() };
  }
  function applyUpdate({ bids, asks, checksum: expected = null }, { receivedTs }) {
    if (!synchronized) return desync('NOT_SYNCHRONIZED');
    if (!isTs(receivedTs) || !Array.isArray(bids) || !Array.isArray(asks)) return desync('SCHEMA');
    const events = [];
    for (const [side, list] of [['BID', bids], ['ASK', asks]]) {
      for (const raw of list) {
        const kind = raw && typeof raw.event === 'string' ? raw.event : null;
        const p = parseL3Order(raw, { symbol, receivedTs }); if (!p || !['add', 'modify', 'delete'].includes(kind)) return desync('SCHEMA');
        const existing = orders.get(p.orderId);
        if (kind === 'add') {
          if (existing) return desync('DUPLICATE_ADD');
          if (orders.size >= maxOrders) return desync('OVERFLOW');
          const o = { ...p, side, firstSeenTs: receivedTs, modifiedTs: null }; orders.set(o.orderId, o); addToLevel(o); events.push(event('ADD', o, { receivedTs }));
        } else if (kind === 'modify') {
          if (!existing || existing.side !== side) return desync('UNKNOWN_ORDER');
          const previousQty = existing.qty;
          if (existing.priceStr !== p.priceStr) { removeFromLevel(existing); existing.price = p.price; existing.priceStr = p.priceStr; addToLevel(existing); } // a price move joins the back of the new level
          existing.qty = p.qty; existing.qtyStr = p.qtyStr; existing.providerTs = p.providerTs ?? existing.providerTs; existing.modifiedTs = receivedTs;
          events.push(event('MODIFY', existing, { receivedTs, previousQty }));
        } else {
          if (!existing || existing.side !== side) return desync('UNKNOWN_ORDER');
          removeFromLevel(existing); orders.delete(existing.orderId); events.push(event('DELETE', existing, { receivedTs, previousQty: existing.qty, qty: 0 }));
        }
      }
    }
    if (crossed()) return desync('CROSSED');
    const evicted = truncate(receivedTs); events.push(...evicted);
    updates += 1;
    const c = checksum(); const verified = expected === null || expected === undefined ? null : c === expected;
    lastChecksum = { computed: c, expected: expected ?? null, ok: verified };
    if (verified === false) { checksumFailures += 1; desync('CHECKSUM_MISMATCH'); return { ok: false, reason: 'CHECKSUM_MISMATCH', events, evicted: evicted.length, checksum: lastChecksum }; }
    return { ok: true, events, evicted: evicted.length, checksum: lastChecksum };
  }
  function checksum() { return l3Checksum(l3ChecksumDigest({ asks: levelView('ASK'), bids: levelView('BID') })); }
  // the persisted view: orders from the touch in queue order, bounded per side (never the venue order id)
  function view() {
    const side = (s) => { const out = []; let truncated = false; for (const l of levelView(s)) for (const o of l.orders) { if (out.length >= MAX_L3_ORDERS_PER_SIDE) { truncated = true; break; } out.push({ orderKey: o.orderKey, price: o.price, qty: o.qty, providerTs: o.providerTs, firstSeenTs: o.firstSeenTs, modifiedTs: o.modifiedTs }); } return { orders: out, truncated }; };
    const b = side('BID'); const a = side('ASK');
    return { bids: b.orders, asks: a.orders, truncated: b.truncated || a.truncated, orderCount: orders.size, levels: { bids: levels.BID.size, asks: levels.ASK.size } };
  }
  const reset = (reason = 'EPOCH') => { clear(); synchronized = false; lastReason = reason; };
  return {
    symbol, depth, version: L3_BOOK_VERSION, applySnapshot, applyUpdate, checksum, view, reset,
    get synchronized() { return synchronized; }, get size() { return orders.size; },
    status: () => deepFreeze({ symbol, depth, synchronized, lastReason, orders: orders.size, levels: { bids: levels.BID.size, asks: levels.ASK.size }, snapshots, updates, evictions, checksumFailures, lastChecksum, lastSnapshotTs, maxOrders }),
  };
}
