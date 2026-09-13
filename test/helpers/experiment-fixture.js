// The synthetic experiment fixture (focused completion §7): a FORWARD recording made by the real OBSERVE composition with the
// recorder on — exact wire messages into the execution feed (instrument, subscription, CRC-verified books, trades, heartbeats),
// a scripted public OHLC transport for the bar history, nominations, the fee contract and control changes — so the sealed
// bundle carries every input an offline experiment needs. The scenario: a 22-minute warm range, a RANGE_IGNITION crossing with
// confirming books and taker flow, a rally through the planned target, then a deterioration. No provider, model or exchange.
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { composeJudge, initAccount } from '../../judge/composition.js';
import { loadJudgePolicy } from '../../judge/policy.js';
import { createMemoryJournal } from '../../execution/journal.js';
import { KRAKEN_OHLC_URL } from '../../judge/history.js';
import { createFeedRecorder, readManifest, readRecording } from '../../judge/recorder.js';
import { crc32 } from '../../lib/crc32.js';
import { fakeClock, SPEC } from './judge.js';

export const PAPER_POLICY = path.resolve('judge/samples/policy.paper-reference.json');
export const pclockOf = (clock) => ({ now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true, kind: 'TEST' }), expired: (t) => clock.now() > t });
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, ''); const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
// a scripted public OHLC endpoint: closed one-minute bars ending before the receipt around a flat price; `last` = the latest committed bar
// the fixture policy: the paper reference with a SYNTHETIC 0.1% taker fee so the reference geometry passes the reward / stressed-risk screen (as judge-e2e-pg)
export function writeFixturePolicy(dir, { policyName = 'experiment-fixture', accountId = 'experiment-fixture' } = {}) { mkdirSync(dir, { recursive: true }); const raw = JSON.parse(readFileSync(PAPER_POLICY, 'utf8')); const file = path.join(dir, 'policy.fixture.json'); writeFileSync(file, JSON.stringify({ ...raw, policyName, account: { ...raw.account, accountId }, fees: { taker: { ...raw.fees.taker, rate: '0.001', scheduleId: 'synthetic-test-fee' } } })); return file; }
// the reference bar geometry (judge-e2e-pg): close 100000, range 400
// the provider answers ONCE with the bars before the first retrieval and repeats that answer (a frozen snapshot): later minutes are the live
// continuation from the recorded trades, never overwritten by a synthetic provider that did not see them
export function ohlcTransport(clock, { price = 100000, range = 400, bars = 70 } = {}) { const calls = []; let frozen = null; const fn = async (url) => { const u = new URL(url); calls.push(u.pathname); if (!url.startsWith(KRAKEN_OHLC_URL)) return { status: 404, ok: false, text: async () => 'not found' }; const end = frozen ?? Math.floor(clock.now() / 60_000) * 60_000; frozen = end; const rows = []; for (let k = bars; k >= 1; k -= 1) { const s = (end - k * 60_000) / 1000; rows.push([s, String(price), String(price + range / 2), String(price - range / 2), String(price), String(price), '0.01', 4]); } return { status: 200, ok: true, text: async () => JSON.stringify({ error: [], result: { [u.searchParams.get('pair')]: rows, last: rows[rows.length - 1][0] } }) }; }; fn.calls = calls; return fn; }
// the driver over a composed run: exact wire messages, ticks through the composition, settle through the real queues (the judge-e2e driver)
export function createDriver(run, clock, { symbol = 'XBT/USD' } = {}) {
  const feed = run.tapeFeed; feed.onConnect(clock.now()); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol, price_precision: 1, qty_precision: 8 }] } }), clock.now()); feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol, asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tid = 0; const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol, side, price, qty, ord_type: 'market', trade_id: ++tid, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const settle = async () => { await run.tick(); await run.judge.drain(); await run.dispatcher.idle(); await run.watch.onTick(clock.now()); await run.dispatcher.idle(); };
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now()); const adv = (ms) => { for (let t = 0; t < ms; t += 1000) { clock.advance(Math.min(1000, ms - t)); heartbeat(); } };
  const advance = async (ms, step = 250) => { for (let t = 0; t < ms; t += step) { clock.advance(Math.min(step, ms - t)); heartbeat(); await settle(); } };
  // the warm range: live bars with the reference geometry (range 400 around 100000) and ONE wick low (96000) 19 bars before ignition, so the
  // frozen l20 carries it and the scenario target (h20 + (h20 - l20)) lies well above the entry (judge-e2e-pg geometry, here on the wire)
  async function warm({ minutes = 22, price = 100000, range = 400, wickMinute = 8, wickLow = 96000 } = {}) { book([[price + 10, 5]], [[price - 10, 5]], 'snapshot'); for (let m = 0; m < minutes; m += 1) { for (let k = 0; k < 4; k += 1) { adv(15_000); trade(price + range / 2, 'buy'); trade(price - range / 2, 'sell'); if (m === wickMinute && k === 1) trade(wickLow, 'sell', 0.01); trade(price, 'buy', 0.01); book([[price + 10, 5]], [[price - 10, 5]]); } } await settle(); }
  async function ignite({ price = 100000, level = 100400, books = 3, spanMs = 2100, askQty = 5 } = {}) { /* the e2e ignition verbatim: taker flow through one minute, then confirming books above the trigger */ const start = Math.floor(clock.now() / 60_000) * 60_000 + 60_000; const quiet = (ms) => { for (let t = 0; t < ms; t += 1000) { adv(1000); if (clock.now() % 10_000 === 0) book([[price + 10, 5]], [[price - 10, 5]]); } }; while (clock.now() < start) quiet(1000); for (let k = 0; k < 20; k += 1) { quiet(2000); trade(price + 50, 'buy', 0.2); } while (clock.now() % 60_000 !== 0) quiet(1000); clock.advance(500); for (let i = 0; i < books; i += 1) { book([[level + 20, askQty], [level + 30, 5]], [[level, 5], [level - 10, 5]]); trade(level + 10, 'buy', 0.1); await settle(); if (i < books - 1) clock.advance(Math.ceil(spanMs / (books - 1))); } await settle(); }
  // a rally: the bid climbs steadily with taker buying, so a planned target below the path is reached while the trail follows
  // books keep arriving right after the decision (an IOC entry samples a book inside its bounded post-arrival window, never a stale one)
  async function hold({ level = 100400, ms = 2000, stepMs = 250, askQty = 5 } = {}) { for (let t = 0; t < ms; t += stepMs) { clock.advance(stepMs); book([[level + 20, askQty], [level + 30, 5]], [[level, 5], [level - 10, 5]]); if (t % 1000 === 0) trade(level + 10, 'buy', 0.05); heartbeat(); await settle(); } }
  async function rally({ from = 100420, to = 104800, steps = 44, stepMs = 1000 } = {}) { const inc = (to - from) / steps; for (let i = 1; i <= steps; i += 1) { clock.advance(stepMs); const p = Math.round((from + inc * i) * 10) / 10; book([[p + 10, 5]], [[p, 5], [p - 10, 5]]); trade(p + 5, 'buy', 0.1); heartbeat(); await settle(); } }
  async function deteriorate({ price = 100420 } = {}) { const p = price; for (let i = 0; i < 80; i += 1) { clock.advance(1000); book([[p + 10, 5]], [[p, 1], [p - 10, 1]]); trade(p + 5, 'buy', 0.05); } await settle(); for (let i = 0; i < 4; i += 1) { clock.advance(1100); book([[p + 10, 5]], [[p, 0.1], [p - 10, 0.1]]); for (let k = 0; k < 6; k += 1) trade(p + 1, 'sell', 0.5); clock.advance(100); await settle(); } }
  async function crash({ from = 104800, to = 99000, steps = 30, stepMs = 1000 } = {}) { const inc = (to - from) / steps; for (let i = 1; i <= steps; i += 1) { clock.advance(stepMs); const p = Math.round((from + inc * i) * 10) / 10; book([[p + 10, 5]], [[p, 5], [p - 10, 5]]); trade(p - 5, 'sell', 0.3); heartbeat(); await settle(); } }
  return { feed, book, trade, settle, advance, warm, ignite, hold, rally, deteriorate, crash, heartbeat, adv, state: () => run.dispatcher.state() };
}
// rewrite a sealed bundle with EXTRA typed records inserted at their receipt clocks (capture order renumbered, the seal re-made): the offline
// positive paths for D2 / D3 (a WHALE / PEER input the forward recorder did not have) are declared research inputs, never synthesized by replay
export function rewriteBundle(srcDir, dstDir, extra = [], { binding = null, validateTyped = null } = {}) {
  const m = readManifest(srcDir); const rec = createFeedRecorder({ dir: dstDir, clock: () => m.startedTs, binding: binding ?? m.binding ?? null, validateTyped }); const pending = [...extra].sort((a, b) => a.receiptTs - b.receiptTs); let n = 0;
  const flush = (upTo) => { while (pending.length && pending[0].receiptTs <= upTo) { const x = pending.shift(); const ok = x.connect ? rec.record(null, x.receiptTs, { connect: true }) : x.disconnect ? rec.record(null, x.receiptTs, { disconnect: true }) : x.raw !== undefined ? rec.record(x.raw, x.receiptTs) : rec.record(null, x.receiptTs, { kind: x.kind, payload: x.payload }); if (!ok) throw new Error(`rewrite refused ${x.kind ?? 'row'}: ${rec.status().reason}`); n += 1; } };
  for (const row of readRecording(srcDir)) { if (typeof row.receiptTs !== 'number') continue; flush(row.receiptTs - 1); if (row.kind) rec.record(null, row.receiptTs, { kind: row.kind, payload: row.payload }); else if (row.connect) rec.record(null, row.receiptTs, { connect: true }); else if (row.disconnect) rec.record(null, row.receiptTs, { disconnect: true }); else rec.record(row.raw, row.receiptTs); }
  flush(Infinity); const state = rec.stop(); return { dir: dstDir, state, inserted: n, status: rec.status() };
}
// record the fixture bundle through the real composition; returns the forward run's observable facts for comparison
export async function recordExperimentFixture(dir, { scenario = 'TARGET_THEN_CRASH', experimentId = null, accountId = 'fixture-observe', codeDigest = 'c'.repeat(64), policyFile = null, extraSpecs = [], extraNominations = [], controlsSource = null, log = () => {} } = {}) {
  const clock = fakeClock(); const transport = ohlcTransport(clock); const noms = [{ symbol: 'XBT/USD', assetId: 'BTC', nominationKnownAtTs: clock.now() - 1000 }, ...extraNominations]; const pf = policyFile ?? writeFixturePolicy(path.dirname(dir)); const P = loadJudgePolicy(pf); const journal = createMemoryJournal();
  await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'OBSERVE', ownerRef: 'fixture', nowTs: clock.now(), accountId });
  const run = await composeJudge({ policyFile: pf, mode: 'OBSERVE', accountId, journal, clock: pclockOf(clock), transport, specs: [SPEC, ...extraSpecs], controlsSource: controlsSource ?? (() => ({ kill: false, cage: false, vetoes: [] })), nominations: () => noms, recordDir: dir, writeProjection: false, codeDigest, log, experimentId });
  // the first tick retrieves the bar history BEFORE the warm range starts (the provider's bars end before the recording; live minutes follow)
  run.admitNominations(); await run.tick(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); const d = createDriver(run, clock); await d.warm(); await d.ignite(); await d.hold();
  if (scenario === 'TARGET_THEN_CRASH') { await d.rally(); await d.advance(3000); await d.crash(); await d.advance(3000); }
  else if (scenario === 'DETERIORATE') { await d.deteriorate(); await d.advance(3000); }
  else if (scenario === 'OPEN_AT_END') { await d.rally({ to: 100700, steps: 12 }); }
  const decisions = run.judge.decisions().map((x) => ({ status: x.status, setupId: x.setupId, reasonCodes: x.reasonCodes, decisionKnownAtTs: x.decisionKnownAtTs })); const state = run.dispatcher.state(); const stopped = await run.stop();
  return { dir, policyFile: pf, policyDigest: P.digest, clock, decisions, positions: Object.values(state.positions).map((p) => ({ positionId: p.positionId, state: p.state, realizedPnl: p.realizedPnl, exitReason: p.exit?.primaryReason ?? null })), cash: state.cash, recorder: stopped.recorder ?? null, transportCalls: transport.calls.length };
}
