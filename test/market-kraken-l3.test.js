// MARKET-EDGE-KRAKEN-1 §11.2 — Kraken Spot Level 3 (dark sense B). Mock only: the documented checksum example
// (test/fixtures/kraken-l3-checksum-snapshot.json, docs checked 2026-09-10), a loopback fixture for the two private
// reads and a scripted venue socket. No network, no real credential, no order verb anywhere in the exercised code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as H from './helpers/market-lab.js';
import { createScriptedWebSocket } from './helpers/scripted-ws.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createL3Book, parseL3Order, orderKeyOf, checksumField, l3ChecksumDigest, l3Checksum, CHECKSUM_LEVELS } from '../market-lab/l3-book.js';
import { createL3AuthHelper, assessKeyPermissions, signNarrow, KRAKEN_KEY_PERMISSIONS, SIGNABLE_ENDPOINTS, keyFingerprintOf } from '../market-lab/providers/kraken-l3-auth.js';
import { createKrakenL3Stream, L3_SUBSCRIPTION_WEIGHTS, L3_RATE_BUDGETS } from '../market-lab/providers/kraken-l3.js';
import { observationError, coverageRecordError, L3_EVENTS } from '../market-lab/contracts.js';
import { L3_DEFAULTS, loadPolicy, l3Enabled } from '../market-lab/policy.js';
import { PROVIDERS, endpointOf } from '../market-lab/registry.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/kraken-l3-checksum-snapshot.json', import.meta.url), 'utf8')).data[0];
const T0 = Date.parse('2026-09-10T12:00:00Z');
const MARKET = (wsname = 'BTC/USD') => ({ wsname, subject: { subjectKind: 'MARKET', canonicalCoin: wsname.split('/')[0], providerAssetId: null, venue: 'kraken', nativeSymbol: wsname, base: wsname.split('/')[0], quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null }, pricePrecision: 1, qtyPrecision: 8 });
const ORDER = (o, event, over = {}) => ({ event, order_id: o.order_id, limit_price: o.limit_price, order_qty: o.order_qty, timestamp: o.timestamp, ...over });
const SAFE = ['query-funds', 'query-open-trades', 'create-ws-token'];
async function rig({ permissions = SAFE, tokenOk = true, env = null, ackSubscriptions = false } = {}) {
  let t = T0; const clock = () => t; const recorded = []; const logs = [];
  const fixture = await H.startHttpFixture({ 'POST /0/private/GetApiKeyInfo': (req) => ({ json: { error: [], result: { apiKey: 'ECHOED-KEY-VALUE', apiKeyName: 'l3-data', permissions, iban: 'IBAN', validUntil: '0', nonceWindow: 0, ipAllowlist: [] } } }), 'POST /0/private/GetWebSocketsToken': () => (tokenOk ? { json: { error: [], result: { token: 'SYNTHETIC-TOKEN-VALUE', expires: 900 } } } : { json: { error: ['EGeneral:Permission denied'], result: {} } }) });
  const transport = createHttpTransport({ fetchImpl: H.fetchFor(fixture), clock, recorder: (r) => recorded.push(r), log: (m) => logs.push(m) });
  const auth = createL3AuthHelper({ transport, clock, env: env ?? { L3K: 'the-key-value', L3S: Buffer.from('the-secret').toString('base64') }, keyEnv: 'L3K', secretEnv: 'L3S', log: (m) => logs.push(m) });
  const sw = createScriptedWebSocket({ ackSubscriptions });
  const out = { snaps: [], events: [], cov: [] };
  const make = (markets, l3 = L3_DEFAULTS) => createKrakenL3Stream({ transport, clock, auth, markets, l3, WebSocketImpl: sw.WebSocketImpl, onSnapshot: (o) => out.snaps.push(o), onEvents: (o) => out.events.push(o), onCoverage: (c) => out.cov.push(c), log: (m) => logs.push(m) });
  return { auth, sw, out, make, recorded, logs, fixture, advance: (ms) => { t += ms; }, close: () => fixture.close(), leak: () => { const s = JSON.stringify([out, recorded, logs]); return s.includes('SYNTHETIC-TOKEN-VALUE') || s.includes('the-key-value') || s.includes('the-secret') || s.includes('ECHOED-KEY-VALUE') || /nonce=\d+/.test(s); } };
}
const ack = (sock, symbols) => { for (const s of symbols) sock.deliver({ method: 'subscribe', success: true, result: { channel: 'level3', symbol: s, depth: 10 } }); };
const opened = async (sw) => { await H.waitFor(() => sw.latest()?.sent.some((s) => s.includes('"level3"')), { timeoutMs: 2000 }); return sw.latest(); };

test('L3-01. the checksum reproduces the documented example: top 10 price levels per side, individual orders in queue order, price then qty with the decimal point removed and leading zeros stripped, asks then bids, CRC32 unsigned; order_id / timestamp excluded; a snapshot deeper than 10 levels only feeds the top 10', () => {
  assert.equal(checksumField('44939.5'), '449395'); assert.equal(checksumField('4.52308393'), '452308393'); assert.equal(checksumField('0.00105240'), '105240'); assert.equal(checksumField('44928.0'), '449280');
  const b = createL3Book({ symbol: 'BTC/USD', depth: 10 }); const r = b.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 });
  assert.equal(r.ok, true); assert.equal(r.orders, FX.bids.length + FX.asks.length); assert.equal(r.checksum, FX.checksum); assert.equal(b.checksum(), 1063832831); assert.equal(CHECKSUM_LEVELS, 10);
  const digest = l3ChecksumDigest({ asks: [{ orders: [{ priceStr: '44939.5', qtyStr: '4.52308393' }] }], bids: [] }); assert.equal(digest, '449395452308393'); assert.equal(l3Checksum(digest), l3Checksum('449395452308393'));
  // an L2 aggregation of the same book (one entry per level) does NOT reproduce the L3 checksum: the algorithm is per order
  const agg = (list) => { const m = new Map(); for (const o of list) m.set(o.limit_price, (m.get(o.limit_price) ?? 0) + Number(o.order_qty)); return [...m.entries()].map(([p, q]) => ({ orders: [{ priceStr: p, qtyStr: q.toFixed(8) }] })); };
  assert.notEqual(l3Checksum(l3ChecksumDigest({ asks: agg(FX.asks), bids: agg(FX.bids) })), FX.checksum);
  // deeper than the checksum window: an 11th ask level does not change the checksum; depth 100 book keeps it
  const deep = createL3Book({ symbol: 'BTC/USD', depth: 100 }); deep.applySnapshot({ bids: FX.bids, asks: [...FX.asks, { order_id: 'DEEP-1', limit_price: '45100.0', order_qty: '1.00000000', timestamp: '2024-01-08T12:26:44.000000000Z' }] }, { receivedTs: T0 }); assert.equal(deep.checksum(), FX.checksum); assert.equal(deep.size, FX.bids.length + FX.asks.length + 1);
  // persisted identity is a hash of symbol + order id, never the venue id itself
  assert.equal(orderKeyOf('BTC/USD', FX.asks[0].order_id).length, 24); assert.notEqual(orderKeyOf('BTC/USD', 'A'), orderKeyOf('ETH/USD', 'A')); assert.ok(!JSON.stringify(b.view()).includes(FX.asks[0].order_id));
  assert.equal(parseL3Order({ order_id: 'X', limit_price: '1.0', order_qty: 'abc' }, { symbol: 'BTC/USD', receivedTs: T0 }), null); assert.equal(parseL3Order({ order_id: 'X', limit_price: '-1', order_qty: '1' }, { symbol: 'BTC/USD', receivedTs: T0 }), null); assert.equal(parseL3Order({ order_id: 'X', limit_price: '1.0', order_qty: '1', timestamp: 'not-a-time' }, { symbol: 'BTC/USD', receivedTs: T0 }), null);
});

test('L3-02. state model: a snapshot REPLACES state; add appends to its level queue, modify keeps identity (a price move joins the back of the new level), delete removes; after every update the book is truncated to the subscribed depth and evicted orders are SCOPE_EVICTED — never a cancel; ages come from OUR firstSeenTs and reset with a snapshot / epoch; unknown order, duplicate add, checksum mismatch, crossed book and overflow DESYNCHRONIZE', () => {
  const b = createL3Book({ symbol: 'BTC/USD', depth: 10, maxOrders: 60 });
  assert.equal(b.applyUpdate({ bids: [], asks: [] }, { receivedTs: T0 }).reason, 'NOT_SYNCHRONIZED');
  assert.equal(b.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 }).ok, true);
  const a0 = FX.asks[0]; const bidLevels = [...new Set(FX.bids.map((o) => o.limit_price))]; assert.equal(bidLevels.length, 10, 'the fixture bids cover exactly ten levels');
  // add a NEW bid level below the tenth: it is evicted by truncation immediately (depth 10), with a SCOPE_EVICTED event, never DELETE
  const u1 = b.applyUpdate({ bids: [ORDER({ order_id: 'LOW-1', limit_price: '44800.0', order_qty: '1.00000000', timestamp: a0.timestamp }, 'add')], asks: [], checksum: null }, { receivedTs: T0 + 1000 });
  assert.equal(u1.ok, true); assert.deepEqual(u1.events.map((e) => e.event), ['ADD', 'SCOPE_EVICTED']); assert.equal(u1.evicted, 1); assert.equal(u1.events[1].previousQty, 1); assert.equal(u1.events[1].qty, 0); assert.equal(b.size, FX.bids.length + FX.asks.length);
  // a better bid pushes the tenth level out of scope: the whole evicted level leaves as SCOPE_EVICTED (the venue sends no delete for it)
  const u2 = b.applyUpdate({ bids: [ORDER({ order_id: 'TOP-1', limit_price: '44939.45', order_qty: '0.10000000', timestamp: a0.timestamp }, 'add')], asks: [], checksum: null }, { receivedTs: T0 + 2000 });
  assert.equal(u2.ok, true); const ev = u2.events.filter((e) => e.event === 'SCOPE_EVICTED'); assert.equal(ev.length, 1); assert.equal(ev[0].price, 44901.9); assert.ok(u2.events.every((e) => L3_EVENTS.includes(e.event)));
  // modify: quantity change keeps identity and reports previousQty; age is measured from OUR first sight
  const u3 = b.applyUpdate({ bids: [], asks: [ORDER(a0, 'modify', { order_qty: '4.00000000' })], checksum: null }, { receivedTs: T0 + 5000 });
  assert.equal(u3.ok, true); assert.equal(u3.events[0].event, 'MODIFY'); assert.equal(u3.events[0].previousQty, 4.52308393); assert.equal(u3.events[0].qty, 4); assert.equal(u3.events[0].ageMs, 5000); assert.equal(u3.events[0].orderKey, orderKeyOf('BTC/USD', a0.order_id));
  // delete: removal from the visible book (fill / cancel / expiry are indistinguishable) — the event is DELETE, the doctrine says never "proven cancel"
  const u4 = b.applyUpdate({ bids: [], asks: [ORDER(a0, 'delete', { order_qty: '0' })], checksum: null }, { receivedTs: T0 + 6000 }); assert.equal(u4.events[0].event, 'DELETE'); assert.equal(u4.events[0].previousQty, 4);
  // unknown order / duplicate add / checksum mismatch / crossed -> desynchronized until a fresh snapshot
  assert.equal(b.applyUpdate({ bids: [], asks: [ORDER(a0, 'modify')], checksum: null }, { receivedTs: T0 + 7000 }).reason, 'UNKNOWN_ORDER'); assert.equal(b.synchronized, false); assert.equal(b.status().lastReason, 'UNKNOWN_ORDER');
  b.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 + 8000 }); assert.equal(b.applyUpdate({ bids: [], asks: [ORDER(a0, 'add')], checksum: null }, { receivedTs: T0 + 9000 }).reason, 'DUPLICATE_ADD');
  b.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 + 10000 }); const cm = b.applyUpdate({ bids: [], asks: [ORDER(a0, 'delete', { order_qty: '0' })], checksum: 1 }, { receivedTs: T0 + 11000 }); assert.equal(cm.reason, 'CHECKSUM_MISMATCH'); assert.equal(cm.checksum.ok, false); assert.equal(b.synchronized, false); assert.equal(b.status().checksumFailures, 1);
  b.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 + 12000 }); const ok = b.applyUpdate({ bids: [], asks: [ORDER(a0, 'delete', { order_qty: '0' })], checksum: b.checksum() }, { receivedTs: T0 + 13000 }); assert.equal(ok.ok, false, 'the expected checksum is computed AFTER the update'); b.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 + 14000 });
  const cross = b.applyUpdate({ bids: [ORDER({ order_id: 'X-1', limit_price: '45000.0', order_qty: '1', timestamp: a0.timestamp }, 'add')], asks: [], checksum: null }, { receivedTs: T0 + 15000 }); assert.equal(cross.reason, 'CROSSED');
  // resource bound: the per-book order cap desynchronizes with OVERFLOW instead of growing
  const small = createL3Book({ symbol: 'BTC/USD', depth: 10, maxOrders: 5 }); assert.equal(small.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 }).reason, 'OVERFLOW'); assert.equal(small.synchronized, false);
  // ages never bridge a snapshot: after a fresh snapshot every firstSeenTs is the snapshot receipt
  const c = createL3Book({ symbol: 'BTC/USD', depth: 10 }); c.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 }); c.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 + 60_000 }); assert.ok(c.view().bids.every((o) => o.firstSeenTs === T0 + 60_000)); c.reset('EPOCH'); assert.equal(c.synchronized, false); assert.equal(c.size, 0);
});

test('L3-03. the narrow auth helper: the documented permission vocabulary; any authority-capable permission (modify-trades, close-trades, add-funds, withdraw-funds, earn-funds, add-withdraw-address, update-withdraw-address) or any undocumented value FAILS CLOSED; the signer signs ONLY GetApiKeyInfo and GetWebSocketsToken with the form body `nonce=`; a token is issued only after a SAFE_L3_DATA_KEY proof (W8: a key without create-ws-token is NON_AUTHORITY_KEY with blocker TOKEN_PERMISSION_MISSING and never usable for L3); the key, secret, token, signed payload and nonce never reach status, recorder, logs or the observations', async () => {
  assert.deepEqual(KRAKEN_KEY_PERMISSIONS.AUTHORITY_CAPABLE, ['modify-trades', 'close-trades', 'add-funds', 'withdraw-funds', 'earn-funds', 'add-withdraw-address', 'update-withdraw-address']);
  assert.equal(assessKeyPermissions(SAFE).verdict, 'SAFE_L3_DATA_KEY'); assert.equal(assessKeyPermissions(SAFE).blocker, null); assert.equal(assessKeyPermissions(SAFE).l3Usable, true);
  const noToken = assessKeyPermissions(['query-funds', 'query-ledger']); assert.equal(noToken.verdict, 'NON_AUTHORITY_KEY'); assert.equal(noToken.blocker, 'TOKEN_PERMISSION_MISSING'); assert.equal(noToken.l3Usable, false); assert.equal(noToken.tokenPermission, false);
  for (const p of KRAKEN_KEY_PERMISSIONS.AUTHORITY_CAPABLE) assert.equal(assessKeyPermissions([...SAFE, p]).verdict, 'AUTHORITY_CAPABLE', p);
  const unk = assessKeyPermissions([...SAFE, 'super-powers']); assert.equal(unk.verdict, 'UNKNOWN_PERMISSION'); assert.ok(!JSON.stringify(unk).includes('super-powers'), 'an undocumented value is counted, never echoed');
  assert.equal(assessKeyPermissions('query-funds').verdict, 'MALFORMED'); assert.equal(assessKeyPermissions([1]).verdict, 'MALFORMED'); assert.equal(assessKeyPermissions([]).verdict, 'NON_AUTHORITY_KEY', 'no permission at all: safe from authority, unusable for L3'); assert.equal(assessKeyPermissions([...SAFE.filter((p) => p !== 'create-ws-token'), 'modify-trades']).verdict, 'AUTHORITY_CAPABLE', 'authority outranks the missing token permission');
  assert.deepEqual(Object.keys(SIGNABLE_ENDPOINTS), ['rest-private-key-info', 'rest-private-ws-token']);
  const s = signNarrow({ endpointId: 'rest-private-ws-token', nonce: '1616492376594', secret: Buffer.from('k').toString('base64') }); assert.equal(s.body, 'nonce=1616492376594'); assert.equal(s.path, '/0/private/GetWebSocketsToken'); assert.match(s.signature, /^[A-Za-z0-9+/=]+$/);
  for (const id of ['rest-ohlc', 'rest-asset-pairs', 'AddOrder', '/0/private/AddOrder', 'rest-private-add-order', 'ws-l3']) assert.throws(() => signNarrow({ endpointId: id, nonce: '1', secret: 'aGk=' }), /signs only/);
  // proof gates the token: an authority-capable key never gets a token; a safe key does; the fingerprint is the only key fact retained
  const bad = await rig({ permissions: [...SAFE, 'modify-trades'] });
  try { const p = await bad.auth.proveDataKey(); assert.equal(p.ok, false); assert.equal(p.verdict, 'AUTHORITY_CAPABLE'); assert.deepEqual(p.forbidden, ['modify-trades']); assert.equal(p.keyFingerprint, keyFingerprintOf('the-key-value')); const tk = await bad.auth.fetchToken(); assert.equal(tk.ok, false); assert.equal(tk.reason, 'KEY_NOT_PROVEN'); assert.equal(bad.recorded.length, 1, 'no token request after a refused proof'); assert.equal(bad.leak(), false); assert.ok(bad.logs.some((m) => /refused \(AUTHORITY_CAPABLE/.test(m))); } finally { await bad.close(); }
  const good = await rig();
  try {
    const p = await good.auth.proveDataKey(); assert.equal(p.ok, true); assert.equal(p.verdict, 'SAFE_L3_DATA_KEY'); assert.equal(p.blocker, null); assert.equal(p.l3Usable, true); assert.equal(p.tokenPermission, true); assert.deepEqual(p.dataOnly, SAFE);
    const tk = await good.auth.fetchToken(); assert.equal(tk.ok, true); assert.equal(tk.token, 'SYNTHETIC-TOKEN-VALUE'); assert.equal(tk.expiresTs, tk.issuedTs + 900_000);
    const st = good.auth.status(); assert.equal(st.proven, true); assert.equal(st.tokensIssued, 1); assert.equal(st.keyEnv, 'L3K'); assert.ok(!JSON.stringify(st).includes('SYNTHETIC') && !JSON.stringify(st).includes('the-key'));
    assert.equal(good.recorded.length, 2); for (const r of good.recorded) { assert.equal(r.body, '<redacted>'); assert.equal(r.headers['API-Key'], '<redacted>'); assert.equal(r.headers['API-Sign'], '<redacted>'); assert.equal(r.method, 'POST'); assert.match(r.redactedUrl, /^https:\/\/api\.kraken\.com\/0\/private\/(GetApiKeyInfo|GetWebSocketsToken)$/); }
    assert.equal(good.leak(), false);
    // the actual wire: the form body and the signed headers reached the fixture; nonces strictly increase
    const reqs = good.fixture.requests; assert.equal(reqs.length, 2); assert.match(reqs[0].body, /^nonce=\d+$/); assert.equal(reqs[0].headers['content-type'], 'application/x-www-form-urlencoded'); assert.equal(reqs[0].headers['api-key'], 'the-key-value'); assert.ok(reqs[0].headers['api-sign'].length > 40); assert.ok(BigInt(reqs[1].body.slice(6)) > BigInt(reqs[0].body.slice(6)));
  } finally { await good.close(); }
  const missing = await rig({ env: {} }); try { const p = await missing.auth.proveDataKey(); assert.equal(p.verdict, 'CREDENTIAL_MISSING'); assert.equal(missing.recorded.length, 0); } finally { await missing.close(); }
  // W8: a non-authority key WITHOUT the token permission is proven as NON_AUTHORITY_KEY: no token is fetched, the blocker is named in the proof, the status and the log
  const noTok = await rig({ permissions: ['query-funds', 'query-ledger'] });
  try { const p = await noTok.auth.proveDataKey(); assert.equal(p.ok, false); assert.equal(p.verdict, 'NON_AUTHORITY_KEY'); assert.equal(p.blocker, 'TOKEN_PERMISSION_MISSING'); assert.deepEqual(p.forbidden, []); const tk = await noTok.auth.fetchToken(); assert.equal(tk.ok, false); assert.equal(tk.reason, 'KEY_NOT_PROVEN'); assert.equal(tk.blocker, 'TOKEN_PERMISSION_MISSING'); assert.equal(noTok.recorded.length, 1, 'no token request'); assert.equal(noTok.auth.status().blocker, 'TOKEN_PERMISSION_MISSING'); assert.equal(noTok.auth.status().l3Usable, false); assert.ok(noTok.logs.some((m) => /NON_AUTHORITY_KEY: TOKEN_PERMISSION_MISSING/.test(m))); assert.equal(noTok.leak(), false); } finally { await noTok.close(); }
  const denied = await rig({ tokenOk: false }); try { await denied.auth.proveDataKey(); const tk = await denied.auth.fetchToken(); assert.equal(tk.ok, false); assert.equal(tk.reason, 'PROVIDER_REJECTED'); } finally { await denied.close(); }
  assert.throws(() => createL3AuthHelper({ transport: { request: async () => ({}) }, keyEnv: 'SAME', secretEnv: 'SAME' }), /dedicated/);
});

test('L3-04. the stream: registry host ws-l3.kraken.com under KRAKEN_SPOT (the public L2 ws-v2 path is untouched); proof -> token -> ONE subscribe to channel level3 with the policy depth and the token; snapshot -> L3_BOOK_SNAPSHOT + SYNCHRONIZED coverage; update -> L3_ORDER_EVENT batch with SCOPE_EVICTED; a checksum failure DESYNCHRONIZES, records a GAP and resubscribes; a venue drop opens a new epoch with EPOCH_GAP; sample() emits INTERVAL snapshots; every record validates and names its epoch; nothing leaks', async () => {
  assert.ok(PROVIDERS.KRAKEN_SPOT.hosts.includes('ws-l3.kraken.com')); const e = endpointOf('KRAKEN_SPOT', 'ws-l3'); assert.equal(e.method, 'WS'); assert.equal(e.dark, true); assert.deepEqual(e.families, ['L3_MICROSTRUCTURE']); const l2 = endpointOf('KRAKEN_SPOT', 'ws-v2'); assert.equal(l2.host, 'ws.kraken.com'); assert.ok(!l2.families.includes('L3_MICROSTRUCTURE'));
  const r = await rig();
  try {
    const stream = r.make([MARKET('BTC/USD')]);
    const started = await stream.start(); assert.equal(started.ok, true); assert.equal(started.verdict, 'SAFE_L3_DATA_KEY'); assert.equal(started.blocker, null);
    const sock = await opened(r.sw); const subs = sock.sent.map((s) => JSON.parse(s)); assert.equal(subs.length, 1); assert.deepEqual(subs[0].params, { channel: 'level3', symbol: ['BTC/USD'], depth: 10, snapshot: true, token: 'SYNTHETIC-TOKEN-VALUE' }); assert.match(sock.url, /^wss:\/\/ws-l3\.kraken\.com\/v2$/);
    ack(sock, ['BTC/USD']); assert.equal(r.out.cov.at(-1).state, 'SUBSCRIBED'); assert.equal(r.out.cov.at(-1).family, 'L3_MICROSTRUCTURE');
    r.advance(1000); sock.deliver({ channel: 'level3', type: 'snapshot', data: [FX] });
    const snap = r.out.snaps.find((o) => o.kind === 'L3_BOOK_SNAPSHOT'); assert.ok(snap); assert.equal(observationError(snap), null); assert.equal(snap.payload.sampleReason, 'SNAPSHOT'); assert.equal(snap.payload.checksumVerified, true); assert.equal(snap.payload.synchronized, true); assert.equal(snap.payload.depth, 10); assert.equal(snap.payload.bids.length, FX.bids.length); assert.equal(snap.epochId, 'KRAKEN_SPOT:ws-l3:1'); assert.equal(snap.provenance.vintage, 'LIVE_FORWARD_CAPTURE'); assert.equal(snap.payload.pricePrecision, 1);
    assert.equal(r.out.snaps.find((o) => o.kind === 'L3_BOOK_COVERAGE' && o.payload.state === 'SYNCHRONIZED').payload.ordersTracked, FX.bids.length + FX.asks.length);
    // an update with the right checksum: ADD + the SCOPE_EVICTED level in ONE batch observation
    const book = stream.books.get('BTC/USD'); const probe = createL3Book({ symbol: 'BTC/USD', depth: 10 }); probe.applySnapshot({ bids: FX.bids, asks: FX.asks }, { receivedTs: T0 }); const add = ORDER({ order_id: 'TOP-1', limit_price: '44939.45', order_qty: '0.10000000', timestamp: FX.asks[0].timestamp }, 'add'); probe.applyUpdate({ bids: [add], asks: [], checksum: null }, { receivedTs: T0 });
    r.advance(1000); sock.deliver({ channel: 'level3', type: 'update', data: [{ symbol: 'BTC/USD', checksum: probe.checksum(), bids: [add], asks: [] }] });
    assert.equal(r.out.events.length, 1); const batch = r.out.events[0]; assert.equal(observationError(batch), null); assert.deepEqual(batch.payload.events.map((x) => x.event), ['ADD', 'SCOPE_EVICTED']); assert.equal(batch.payload.checksumVerified, true); assert.equal(book.synchronized, true); assert.equal(batch.quality.state, 'KNOWN');
    // a wrong checksum: desynchronized, GAP coverage, unsubscribe + subscribe again (a fresh snapshot is the only repair)
    r.advance(1000); sock.deliver({ channel: 'level3', type: 'update', data: [{ symbol: 'BTC/USD', checksum: 12345, bids: [], asks: [ORDER(FX.asks[1], 'delete', { order_qty: '0' })] }] });
    assert.equal(book.synchronized, false); assert.equal(r.out.cov.at(-1).state, 'GAP'); assert.deepEqual(r.out.cov.at(-1).reasonCodes, ['DESYNCHRONIZED']); assert.equal(r.out.snaps.at(-1).payload.state, 'DESYNCHRONIZED'); const tail = sock.sent.slice(-2).map((s) => JSON.parse(s)); assert.equal(tail[0].method, 'unsubscribe'); assert.equal(tail[1].method, 'subscribe'); assert.equal(tail[1].params.channel, 'level3'); assert.equal(stream.status().resyncs, 1); assert.equal(stream.status().checksumFailures, 1);
    assert.equal(stream.sample('BTC/USD'), null, 'no sample from a desynchronized book');
    r.advance(1000); sock.deliver({ channel: 'level3', type: 'snapshot', data: [FX] }); assert.equal(book.synchronized, true); const s2 = stream.sample('BTC/USD'); assert.ok(s2); assert.equal(s2.payload.sampleReason, 'INTERVAL'); assert.equal(observationError(s2), null);
    // an update naming an order the book does not know: DEGRADED + resubscribe (no guess)
    r.advance(1000); sock.deliver({ channel: 'level3', type: 'update', data: [{ symbol: 'BTC/USD', checksum: null, bids: [ORDER({ order_id: 'GHOST', limit_price: '44939.4', order_qty: '1', timestamp: FX.asks[0].timestamp }, 'modify')], asks: [] }] }); assert.equal(book.synchronized, false); assert.equal(r.out.snaps.at(-1).payload.state, 'DEGRADED');
    r.advance(1000); sock.deliver({ channel: 'level3', type: 'snapshot', data: [FX] }); assert.equal(book.synchronized, true);
    // the venue drops the socket: a new epoch, EPOCH_GAP coverage, no bridging of ages, a NEW token for the new epoch
    const tokensBefore = r.auth.status().tokensIssued; r.advance(1000); sock.drop('venue closed'); assert.equal(book.synchronized, false); assert.deepEqual(r.out.cov.at(-1).reasonCodes, ['EPOCH_GAP', 'DESYNCHRONIZED']); assert.equal(r.out.snaps.at(-1).payload.state, 'GAP');
    await H.waitFor(() => r.sw.sockets.length === 2 && r.sw.latest().sent.length >= 1, { timeoutMs: 4000 }); assert.equal(r.auth.status().tokensIssued, tokensBefore + 1); assert.equal(r.sw.latest().sent.length, 1);
    for (const o of [...r.out.snaps, ...r.out.events]) { assert.equal(observationError(o), null); assert.ok(o.epochId); assert.equal(o.provider, 'KRAKEN_SPOT'); assert.equal(o.endpointId, 'ws-l3'); }
    for (const c of r.out.cov) assert.equal(coverageRecordError(c), null);
    assert.equal(r.leak(), false);
    await stream.stop(); assert.equal(stream.status().state, 'STOPPED');
  } finally { await r.close(); }
});

test('L3-05. fences and bounds: an authority-capable or missing key never opens a socket (ACCESS_BLOCKED coverage, runtime BLOCKED); more symbols than the policy allows are refused; subscriptions are rate-bounded per second; the message-rate bound drops with QUEUE_DROPPED and resyncs; the per-book order cap yields OVERFLOW and drops the symbol; policy l3 ships DISABLED with DEDICATED credential names', async () => {
  const bad = await rig({ permissions: [...SAFE, 'withdraw-funds'] });
  try { const s = bad.make([MARKET()]); const st = await s.start(); assert.equal(st.ok, false); assert.equal(st.verdict, 'AUTHORITY_CAPABLE'); assert.equal(bad.sw.sockets.length, 0, 'no socket'); assert.equal(bad.out.cov.at(-1).state, 'ACCESS_BLOCKED'); assert.deepEqual(bad.out.cov.at(-1).reasonCodes, ['ENTITLEMENT_DENIED']); assert.equal(s.status().runtime, 'BLOCKED'); assert.equal(s.status().blocked, true); assert.equal(bad.leak(), false); await s.stop(); } finally { await bad.close(); }
  const missing = await rig({ env: {} });
  try { const s = missing.make([MARKET()]); const st = await s.start(); assert.equal(st.verdict, 'CREDENTIAL_MISSING'); assert.equal(missing.sw.sockets.length, 0); assert.deepEqual(missing.out.cov.at(-1).reasonCodes, ['CREDENTIAL_MISSING']); await s.stop(); } finally { await missing.close(); }
  const noTok = await rig({ permissions: ['query-funds'] });
  try { const s = noTok.make([MARKET()]); const st = await s.start(); assert.equal(st.ok, false); assert.equal(st.verdict, 'NON_AUTHORITY_KEY'); assert.equal(st.blocker, 'TOKEN_PERMISSION_MISSING'); assert.equal(noTok.sw.sockets.length, 0, 'a non-authority key without the token permission never opens a socket'); assert.deepEqual(noTok.out.cov.at(-1).reasonCodes, ['ENTITLEMENT_DENIED']); assert.equal(s.status().proof.blocker, 'TOKEN_PERMISSION_MISSING'); await s.stop(); } finally { await noTok.close(); }
  const tokenDenied = await rig({ tokenOk: false });
  try { const s = tokenDenied.make([MARKET()]); const st = await s.start(); assert.equal(st.ok, true); await H.waitFor(() => tokenDenied.out.cov.some((c) => c.state === 'ACCESS_BLOCKED'), { timeoutMs: 2000 }); assert.equal(tokenDenied.sw.latest().sent.length, 0, 'no subscribe without a token'); await H.waitFor(() => s.status().state === 'STOPPED', { timeoutMs: 3000 }); assert.equal(s.status().runtime, 'BLOCKED'); } finally { await tokenDenied.close(); }
  const many = await rig();
  try {
    assert.throws(() => many.make([MARKET('A/USD'), MARKET('B/USD'), MARKET('C/USD')], { ...L3_DEFAULTS, maxSymbols: 2 }), /at most 2/);
    let s = null; try {
    s = many.make([MARKET('A/USD'), MARKET('B/USD'), MARKET('C/USD')], { ...L3_DEFAULTS, maxSymbols: 3, maxSubscriptionsPerSecond: 2, maxQueueMessages: 3, maxInMemoryOrders: 3 * 12 });
    await s.start(); const sock = await opened(many.sw); assert.deepEqual(JSON.parse(sock.sent[0]).params.symbol, ['A/USD', 'B/USD']); await H.waitFor(() => sock.sent.length === 2, { timeoutMs: 3000 }); assert.deepEqual(JSON.parse(sock.sent[1]).params.symbol, ['C/USD']);
    assert.equal(s.status().perBookOrderCap, 12);
    ack(sock, ['A/USD']); many.advance(1000); sock.deliver({ channel: 'level3', type: 'snapshot', data: [{ ...FX, symbol: 'A/USD' }] }); assert.equal(many.out.snaps.at(-1).payload.state, 'OVERFLOW'); assert.ok(s.status().dropped.includes('A/USD')); assert.equal(s.status().overflows, 0, 'a snapshot overflow is refused before it grows'); assert.deepEqual(many.out.cov.at(-1).reasonCodes, ['COVERAGE_OVERFLOW']);
    // the message-rate bound: the 4th message inside one wall second is dropped and counted
    ack(sock, ['B/USD']); const pb = createL3Book({ symbol: 'B/USD', depth: 10 }); pb.applySnapshot({ bids: FX.bids.slice(0, 3), asks: FX.asks.slice(0, 3) }, { receivedTs: T0 }); const small = { symbol: 'B/USD', checksum: pb.checksum(), bids: FX.bids.slice(0, 3), asks: FX.asks.slice(0, 3) }; many.advance(1000); sock.deliver({ channel: 'level3', type: 'snapshot', data: [small] }); assert.equal(s.books.get('B/USD').synchronized, true);
    for (let i = 0; i < 4; i += 1) sock.deliver({ channel: 'level3', type: 'update', data: [{ symbol: 'B/USD', checksum: pb.checksum(), bids: [], asks: [] }] });
    assert.ok(s.status().queueDropped >= 1); assert.ok(many.out.cov.some((c) => c.state === 'DROPPED' && c.reasonCodes.includes('QUEUE_DROPPED'))); assert.equal(s.books.get('B/USD').synchronized, false);
    } finally { if (s) await s.stop(); }
  } finally { await many.close(); }
  const p = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })); assert.equal(l3Enabled(p), false); assert.deepEqual(p.providers.KRAKEN_SPOT.l3, L3_DEFAULTS); assert.notEqual(L3_DEFAULTS.keyEnv, L3_DEFAULTS.secretEnv); assert.match(L3_DEFAULTS.keyEnv, /L3/);
  assert.equal(L3_DEFAULTS.rateTier, 'STANDARD', 'the shipped tier is the standard published limit'); assert.deepEqual(L3_SUBSCRIPTION_WEIGHTS, { 10: 5, 100: 25, 1000: 100 }); assert.deepEqual(L3_RATE_BUDGETS, { STANDARD: 200, PRO: 500 });
  const legacy = H.policyWith({ providers: ['KRAKEN_SPOT'] }); delete legacy.providers.KRAKEN_SPOT.l3.rateTier; assert.equal(loadPolicy(legacy).providers.KRAKEN_SPOT.l3.rateTier, 'STANDARD', 'an older l3 block fails safe to STANDARD');
  const shared = H.policyWith({ providers: ['KRAKEN_SPOT'] }); shared.providers.COINGLASS.credentialEnv = 'KRAKEN_L3_DATA_API_KEY'; assert.throws(() => loadPolicy(shared), /DEDICATED/);
  const bad2 = (mut) => { const q = H.policyWith({ providers: ['KRAKEN_SPOT'] }); mut(q.providers.KRAKEN_SPOT.l3); assert.throws(() => loadPolicy(q), /l3/); };
  bad2((l) => { l.depth = 50; }); bad2((l) => { l.rateTier = 'ULTRA'; }); bad2((l) => { l.rateTier = 'pro'; }); bad2((l) => { l.maxSymbols = 201; }); bad2((l) => { l.keyEnv = 'lower'; }); bad2((l) => { l.secretEnv = l.keyEnv; }); bad2((l) => { l.maxSegmentBytes = l.maxRunBytes + 1; }); bad2((l) => { l.extra = true; });
});
