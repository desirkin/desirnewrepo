// PUBLISH-FIX-114 (2026-09-21). The book was the main thread.
//
// Production 44e7e36b (PUBLISH-FIX-110..113 live), the sampled minute at 98% busy with twenty candidates on the stage:
//     CPU PROFILE 60s: busy 56678ms idle 3303ms · top: sortedLevels feed.js:60 19% · canonicalJson contract.js:79 10%
//                      · fromNumberLexeme 6% · (garbage collector) 5% · parseDecimalUncached 4% · parseDecimal 3% · parseLexemes 3%
// execution/feed.js sorted every book's levels with M.cmp per comparison FOUR to SIX times per applied message (truncate when
// over depth, the checksum, the snapshot — each side). One sort per side now, with the double of each price computed once per
// level as the sort key and the exact comparator for equal doubles — the law money.js cmp and features.js medianDecimal /
// minDecimal already use — and the one sorted, truncated array shared by truncation, checksum and snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createExecutionFeed } from '../execution/feed.js';
import { bookSnapshotError } from '../execution/contract.js';
import { crc32 } from '../lib/crc32.js';
import * as M from '../execution/money.js';
import { fakeClock } from './helpers/judge.js';

const SYM = 'BTC/USD';
const inst = () => JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: SYM, price_precision: 1, qty_precision: 8 }] } });
const digits = (lex, d) => { const [ip, fp = ''] = lex.split('.'); return (ip + fp.padEnd(d, '0')).replace(/^0+/, ''); };
const crcOf = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => digits(p, 1) + digits(q, 8)).join(''));
const msg = (type, asks, bids, checksum, ts) => JSON.stringify({ channel: 'book', type, data: [{ symbol: SYM, asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum, timestamp: new Date(ts).toISOString() }] });
const feedWith = (clock, depth = 100) => { const feed = createExecutionFeed({ clock: clock.now, depthOf: () => depth }); const events = []; feed.subscribe((e) => events.push(e)); feed.admit(SYM, { priority: 'CANDIDATE', reason: 'test' }); feed.onConnect(clock.now()); feed.ingest(inst(), clock.now()); return { feed, events }; };
// the reference order: the exact comparator alone, as the feed sorted before this fix
const refSort = (levels, side) => [...levels].sort((a, b) => (side === 'bids' ? M.cmp(b[0], a[0]) : M.cmp(a[0], b[0])));
let x = 17; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
const price = () => (99000 + Math.floor(rnd() * 20000) / 10).toFixed(1);
const qty = () => (rnd() * 5).toFixed(8);

test('FIX114-1: the snapshot order and the CRC are exactly what the exact comparator gives — a snapshot, then two hundred random updates with deletes and re-inserts', () => {
  const clock = fakeClock(); const { feed, events } = feedWith(clock);
  const asks = new Map(); const bids = new Map();
  for (let i = 0; i < 60; i += 1) { const p = (110000 + i / 10).toFixed(1); asks.set(p, qty()); const b = (109999.9 - i / 10).toFixed(1); bids.set(b, qty()); }
  const sortedA = () => refSort([...asks.entries()], 'asks'); const sortedB = () => refSort([...bids.entries()], 'bids');
  feed.ingest(msg('snapshot', sortedA(), sortedB(), crcOf(sortedA(), sortedB()), clock.now()), clock.now());
  let applied = 0;
  for (let k = 0; k < 200; k += 1) {
    clock.advance(50);
    const ua = []; const ub = [];
    for (let j = 0; j < 1 + Math.floor(rnd() * 4); j += 1) {
      if (rnd() < 0.5) { const keys = [...asks.keys()]; const p = keys[Math.floor(rnd() * keys.length)]; if (rnd() < 0.3) { asks.delete(p); ua.push([p, '0.00000000']); } else { const q = qty(); asks.set(p, q); ua.push([p, q]); } } else { const p = (110000 + Math.floor(rnd() * 800) / 10).toFixed(1); const q = qty(); asks.set(p, q); ua.push([p, q]); }
      if (rnd() < 0.5) { const keys = [...bids.keys()]; const p = keys[Math.floor(rnd() * keys.length)]; if (rnd() < 0.3) { bids.delete(p); ub.push([p, '0.00000000']); } else { const q = qty(); bids.set(p, q); ub.push([p, q]); } } else { const p = (109999.9 - Math.floor(rnd() * 800) / 10).toFixed(1); const q = qty(); bids.set(p, q); ub.push([p, q]); }
    }
    for (const [m, side] of [[asks, 'asks'], [bids, 'bids']]) for (const [p] of refSort([...m.entries()], side).slice(100)) m.delete(p); // the reference holds the subscribed depth, as the feed does
    feed.ingest(msg('update', ua, ub, crcOf(sortedA(), sortedB()), clock.now()), clock.now());
    const ev = events[events.length - 1]; assert.equal(ev.kind, 'BOOK', `update ${k} applied (a CRC mismatch would desynchronize)`); applied += 1;
    const snap = ev.snapshot; assert.equal(snap.crcVerified, true, `update ${k}: CRC verified against the venue's own order`);
    assert.deepEqual(snap.asks.map((l) => l[0]), sortedA().map((l) => M.fromNumberLexeme(l[0])), `update ${k}: asks in the exact order`);
    assert.deepEqual(snap.bids.map((l) => l[0]), sortedB().map((l) => M.fromNumberLexeme(l[0])), `update ${k}: bids in the exact order`);
    assert.equal(bookSnapshotError(snap), null, `update ${k}: the snapshot satisfies the contract`);
  }
  assert.equal(applied, 200); assert.equal(feed.status().counters.crcFailures, 0);
});

test('FIX114-2: truncation still holds the subscribed depth, and the sorted array handed on is the truncated one', () => {
  const clock = fakeClock(); const { feed, events } = feedWith(clock, 10);
  const asks = []; const bids = []; for (let i = 0; i < 25; i += 1) { asks.push([(110000 + i / 10).toFixed(1), '1.00000000']); bids.push([(109999.9 - i / 10).toFixed(1), '1.00000000']); }
  feed.ingest(msg('snapshot', asks, bids, crcOf(asks, bids), clock.now()), clock.now());
  const snap = events[events.length - 1].snapshot; assert.equal(snap.kind, 'SNAPSHOT'); assert.equal(snap.crcVerified, true);
  assert.equal(snap.asks.length, 10); assert.equal(snap.bids.length, 10); assert.equal(snap.levelsCap, 10);
  assert.deepEqual(snap.asks.map((l) => l[0]), asks.slice(0, 10).map((l) => M.fromNumberLexeme(l[0]))); assert.deepEqual(snap.bids.map((l) => l[0]), bids.slice(0, 10).map((l) => M.fromNumberLexeme(l[0])));
  // a level beyond the depth arrives on an update: it is dropped from the book, the top ten are unchanged, the CRC still verifies
  clock.advance(50); feed.ingest(msg('update', [[(110000 + 4).toFixed(1), '2.00000000']], [], crcOf(asks, bids), clock.now()), clock.now());
  const after = events[events.length - 1].snapshot; assert.equal(after.kind, 'UPDATE'); assert.equal(after.crcVerified, true); assert.equal(after.asks.length, 10);
  assert.deepEqual(after.asks.map((l) => l[0]), asks.slice(0, 10).map((l) => M.fromNumberLexeme(l[0])));
});

test('FIX114-3: ties and long lexemes take the exact path — the fast key is a key, never a value', () => {
  // two lexemes with the SAME double but different exact values (0.30000000000000004 vs 0.300000000000000044) — the guard is ≤ 20 chars and
  // equal doubles fall to M.cmp, so the exact order is kept; a 21-char lexeme fails the guard and sends the whole side down the exact comparator
  const clock = fakeClock(); const feed = createExecutionFeed({ clock: clock.now, depthOf: () => 100 }); const events = []; feed.subscribe((e) => events.push(e));
  feed.admit(SYM, { priority: 'CANDIDATE', reason: 'test' }); feed.onConnect(clock.now()); // no instrument: precision unknown, no CRC — order only
  const asks = [['0.300000000000000044', '1'], ['0.30000000000000004', '1'], ['10.300000000000000001', '1'], ['0.3', '1'], ['10.3', '1']];
  const bids = [['0.299999999999999999', '1'], ['0.29999999999999999', '1'], ['0.29', '1']];
  assert.equal(Number('0.300000000000000044'), Number('0.30000000000000004'), 'the fixture is a real tie of doubles'); assert.equal(Number('0.299999999999999999'), Number('0.29999999999999999'));
  feed.ingest(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: SYM, asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const snap = events[events.length - 1].snapshot; assert.equal(snap.kind, 'SNAPSHOT');
  assert.deepEqual(snap.asks.map((l) => l[0]), refSort(asks, 'asks').map((l) => M.fromNumberLexeme(l[0])), 'asks ascending by exact value');
  assert.deepEqual(snap.bids.map((l) => l[0]), refSort(bids, 'bids').map((l) => M.fromNumberLexeme(l[0])), 'bids descending by exact value');
  assert.equal(bookSnapshotError(snap), null);
});

test('FIX114-4: one sort per side per applied message — the checksum and the snapshot no longer sort for themselves', () => {
  const src = readFileSync('execution/feed.js', 'utf8');
  assert.equal((src.match(/sortedLevels\(/g) ?? []).length, 1, 'ONE call site: sortAndTruncate'); assert.match(src, /const sortedLevels = \(map, side\) => \{/);
  assert.match(src, /function checksum\(b, sorted\)/); assert.match(src, /for \(const \[p, q\] of sorted\[side\]\.slice\(0, 10\)\)/);
  assert.match(src, /function snapshotOf\(symbol, b, \{ kind, sourceTs, receiptTs, crc, crcVerified, crcComputed \}, sorted\)/);
  assert.match(src, /const sorted = sortAndTruncate\(b, symbol\);/);
  assert.equal(src.includes('function truncate('), false, 'the separate truncation pass is gone with its sort');
  // the fast key follows the same guard as the exact-median law: a plain decimal of at most twenty characters
  assert.match(src, /const LEVEL_FAST_RE = \/\^\(0\|\[1-9\]\\d\*\)\(\\\.\\d\+\)\?\$\/; const LEVEL_FAST_MAX_LEN = 20;/);
});

test('FIX114-5: it is actually faster — a hundred-level book, a thousand updates', () => {
  const run = (sorter) => { const asks = new Map(); for (let i = 0; i < 100; i += 1) asks.set((110000 + i / 10).toFixed(1), '1'); const t = process.hrtime.bigint(); for (let k = 0; k < 1000; k += 1) { asks.set((110000 + Math.floor(rnd() * 1000) / 10).toFixed(1), '2'); sorter(asks); sorter(asks); sorter(asks); } return Number(process.hrtime.bigint() - t) / 1e6; };
  const exact = run((m) => [...m.entries()].sort((a, b) => M.cmp(a[0], b[0])));
  const keyed = run((m) => { const e = [...m.entries()]; const keys = new Float64Array(e.length); for (let i = 0; i < e.length; i += 1) keys[i] = Number(e[i][0]); const idx = e.map((_, i) => i); idx.sort((i, j) => (keys[i] !== keys[j] ? (keys[i] < keys[j] ? -1 : 1) : M.cmp(e[i][0], e[j][0]))); return idx.map((i) => e[i]); });
  assert.ok(keyed * 2 < exact, `keyed ${keyed.toFixed(1)}ms vs exact ${exact.toFixed(1)}ms — expected at least 2x on the comparator alone (the fix also does one sort instead of three)`);
});
