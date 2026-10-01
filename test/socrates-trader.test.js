// SOCRATES TRADER v2 (owner experiment 2026-09-30): its own paper ledger, model decisions only, stops, budget, the run clock,
// the cage (1-hour windows), the tripwire and the auto-trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocratesTrader, chartText, tripwireCheck, buildAlbum, tapeFacts, flowText, SYSTEM_PROMPT, DECISION_SCHEMA, TRADER_DEFAULTS } from '../experiment/socrates-trader.js';

const H = 3600_000;
function rig({ answers = [], bid = 1.0, ask = 1.01, key = 'k', config = {}, tapeSnap = null, lows = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'soc-trader-')); let now = Date.UTC(2026, 8, 30, 12, 0, 0);
  const extra = []; // candles appended after start (openSec, low) to test limit fills
  const mk = () => { const c = []; for (let i = 60; i > 0; i -= 1) { const t = Math.floor(now / 1000 / 60) * 60 - i * 60; const e = extra.find((x) => x[0] === t); c.push([t, 1, 1.02, e ? e[1] : 0.99, 1.0, 1000]); } return c; };
  const trades = Array(60).fill(6);
  const series = (coin) => (coin === 'ABC' ? { candles: mk(), trades } : null); series.coins = () => ['ABC'];
  const watch = { current: () => ({ picks: [{ coin: 'ABC', symbol: 'ABC/USD' }] }) };
  const book = { bid, ask };
  const tickers = () => new Map([['ABC', { bid: book.bid, ask: book.ask, bidQty: 100_000, askQty: 100_000, ts: now }]]);
  const calls = []; const queue = [...answers];
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); calls.push(b); const a = queue.shift() ?? { actions: [], note: 'wait' }; return { ok: true, status: 200, json: async () => ({ type: 'message', model: 'claude-sonnet-5', content: [{ type: 'text', text: JSON.stringify(a) }], usage: { input_tokens: 3000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) }; };
  const logs = [];
  const t = createSocratesTrader({ dataDir: dir, seriesSource: series, watch, config: { enabled: true, ...config }, env: key ? { ANTHROPIC_API_KEY: key } : {}, log: (l) => logs.push(l), fetchImpl, clock: () => now, readTickersImpl: tickers, tapeSnapshot: (coin) => (coin === 'ABC' && tapeSnap ? { ...tapeSnap, tsMs: now - 5000 } : null) });
  return { t, dir, calls, logs, book, extra, now: () => now, advance: (ms) => { now += ms; }, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const buy = (usd, stop, extra = {}) => ({ type: 'BUY', coin: 'ABC', usd, price: null, stop, roomPct: 8, strategy: 'ABSORPTION_RECLAIM', why: 'runner', ...extra });
const limit = (usd, price, stop, extra = {}) => ({ type: 'LIMIT_BUY', coin: 'ABC', usd, price, stop, roomPct: 8, strategy: 'ABSORPTION_RECLAIM', why: 'dip on a wild coin', ...extra });
const ans = (...actions) => ({ actions, note: 'x', lessons: [] });

test('ST-01. a model BUY fills at the ask with the fee, the stop sells at the bid when crossed, the ledger math is exact', async () => {
  const r = rig({ answers: [ans(buy(100, 0.95))] });
  try {
    await r.t.tick(); const s = r.t.state(); assert.ok(s.positions.ABC, 'bought');
    assert.equal(Math.round(s.cashUsd * 100) / 100, 500 - 100 - 0.8); assert.equal(s.positions.ABC.entryPx, 1.01);
    assert.equal(r.calls[0].output_config.format.type, 'json_schema'); assert.equal(r.calls[0].model, 'claude-sonnet-5');
    r.book.bid = 0.94; r.book.ask = 0.95; r.advance(15_000); await r.t.tick();
    const s2 = r.t.state(); assert.ok(!s2.positions.ABC, 'stopped out'); const c = s2.closed.at(-1); assert.equal(c.reason, 'STOP');
    const proceeds = (100 / 1.01) * 0.94; const expected = proceeds - proceeds * 0.008 - 100 - 0.8; assert.ok(Math.abs(c.pnlUsd - Math.round(expected * 100) / 100) < 0.011);
    assert.ok(existsSync(r.t.paths.journal)); assert.ok(readFileSync(r.t.paths.journal, 'utf8').includes('"kind":"BUY"'));
  } finally { r.done(); }
});

test('ST-02. refusals: a stop above the bid, an unshown coin, a size under the minimum, room under 4% and buys on a holding check are refused and logged, never filled', async () => {
  const r = rig({ answers: [ans(buy(100, 1.5), buy(100, 0.5, { coin: 'ZZZ' }), buy(5, 0.9), buy(100, 0.9, { roomPct: 2 }))] });
  try { await r.t.tick(); const s = r.t.state(); assert.deepEqual(s.positions, {}); assert.equal(s.cashUsd, 500); assert.equal(r.logs.filter((l) => l.startsWith('SOCRATES TRADER refused')).length, 4); assert.ok(r.logs.some((l) => l.includes('room 2% is under the 4% minimum'))); } finally { r.done(); }
});

test('ST-03. no key -> no model call; the daily cap blocks a call before dispatch', async () => {
  const a = rig({ key: null }); try { await a.t.tick(); assert.equal(a.calls.length, 0); assert.ok(a.logs.some((l) => l.includes('ANTHROPIC_API_KEY is not set'))); } finally { a.done(); }
  const b = rig({ config: { dailyUsd: 0.001 } }); try { await b.t.tick(); assert.equal(b.calls.length, 0); } finally { b.done(); }
});

test('ST-04. the run clock: flat or down at the end -> everything sold and the run ends; up >= 1% -> another day', async () => {
  const down = rig({ answers: [ans(buy(100, 0.9))] });
  try { await down.t.tick(); down.advance(48 * H); await down.t.tick(); const s = down.t.state(); assert.equal(s.ended, true); assert.deepEqual(s.positions, {}); assert.equal(s.closed.at(-1).reason, 'EXPERIMENT_END'); } finally { down.done(); }
  const up = rig({ answers: [ans(buy(250, 0.9))] });
  try { await up.t.tick(); up.book.bid = 1.2; up.book.ask = 1.21; up.advance(48 * H); const before = up.t.state().endsTs; await up.t.tick(); const s = up.t.state(); assert.equal(s.ended, false); assert.ok(s.endsTs > before); assert.equal(s.extensions, 1); } finally { up.done(); }
});

test('ST-05. the prompt carries the mission, the cage and the hunter; the position cap is 3 (5 while up)', async () => {
  const r = rig({ answers: [ans(buy(30, 0.9))] }); try { await r.t.tick(); assert.equal(Object.keys(r.t.state().positions).length, 1); assert.ok(r.calls[0].messages[0].content[0].text.includes('THE CAGE: window 1')); } finally { r.done(); }
  for (const s of ['LIMIT_BUY rests your bid', 'HALF OFF', 'THE ALBUM', 'THE NOTEBOOK', 'THE TAPE LINE', '15% to 20% in a day', 'hunter, not a gambler', 'THE CAGE (this is real code', 'Lose two windows in a row and the run ends', 'THE TRIPWIRE', 'THE AUTO-TRAIL', 'roomPct', 'THE HISTORY', '228,880', 'DASH on 09-23', 'YOUR OWN PLAYBOOK, TESTED', 'THE GAP IS YOUR JOB', 'you avoid a loss at all costs', 'dead even']) assert.ok(SYSTEM_PROMPT.includes(s), s);
  assert.equal(TRADER_DEFAULTS.maxPositions, 3); assert.equal(TRADER_DEFAULTS.maxPositionsWhenUp, 5);
});

test('ST-06. the chart text carries the bars and the hour summary; the schema forces stop and roomPct on every action', () => {
  const now = Date.UTC(2026, 8, 30, 12); const candles = []; for (let i = 60; i > 0; i -= 1) candles.push([Math.floor(now / 60000) * 60 - i * 60, 1, 1.1, 0.9, 1.05, 10]);
  const txt = chartText('ABC', { candles }, { nowTs: now }); assert.ok(txt.startsWith('ABC: last 1.05')); assert.equal(txt.split('\n').length, 62);
  assert.ok(DECISION_SCHEMA.properties.actions.items.required.includes('stop')); assert.ok(DECISION_SCHEMA.properties.actions.items.required.includes('roomPct'));
});

test('ST-07. the cage: a won window climbs the ladder (faster looks); a 1%+ loss cages him for an hour with no buys; dead even is neutral; two losses in a row end the run', async () => {
  // WON: buy, price rises, window ends above the line
  const w = rig({ answers: [ans(buy(200, 0.9))] });
  try {
    await w.t.tick(); w.book.bid = 1.1; w.book.ask = 1.11; w.advance(H + 1000); await w.t.tick();
    const s = w.t.state(); assert.equal(s.cage.won, 1); assert.equal(s.cage.level, 1); assert.equal(s.cage.window.n, 2); assert.equal(s.cage.lostInARow, 0);
    assert.ok(w.logs.some((l) => l.includes('window 1 WON')));
    assert.ok(w.t.status().cage.lookEveryMs === TRADER_DEFAULTS.lookLadderMs[1]);
  } finally { w.done(); }
  // NEUTRAL: bought, ends within 1% under the line -> not a loss
  const n = rig({ answers: [ans(buy(100, 0.9))] });
  try { await n.t.tick(); n.book.bid = 1.005; n.book.ask = 1.01; n.advance(H + 1000); await n.t.tick(); const s = n.t.state(); assert.equal(s.cage.lost, 0); assert.equal(s.cage.neutral, 1); assert.equal(s.cage.level, 0); assert.ok(n.logs.some((l) => l.includes('window 1 NEUTRAL'))); } finally { n.done(); }
  // LOST then LOST: cage, then the run ends
  const l = rig({ answers: [ans(buy(200, 0.5)), ans(buy(50, 0.5)), ans(buy(200, 0.5))] });
  try {
    await l.t.tick(); l.book.bid = 0.9; l.book.ask = 0.91; l.advance(H + 1000); await l.t.tick();
    let s = l.t.state(); assert.equal(s.cage.lost, 1); assert.equal(s.cage.lostInARow, 1); assert.ok(s.cage.pausedUntilTs > 0); assert.equal(s.cage.window, null); assert.ok(l.logs.some((l2) => l2.includes('window 1 LOST')));
    const callsBefore = l.calls.length; l.advance(5 * 60_000); await l.t.tick(); // in the cage: a hold check may run, no movers look, no buys
    assert.ok(l.calls.length <= callsBefore + 1); assert.equal(Object.keys(l.t.state().positions).length, 1);
    l.advance(H); await l.t.tick(); s = l.t.state(); assert.ok(s.cage.window, 'a new window opened after the pause'); assert.equal(s.cage.window.n, 2); assert.ok(l.logs.some((l2) => l2.includes('out of the cage: window 2')));
    l.book.bid = 0.8; l.book.ask = 0.81; l.advance(H + 1000); await l.t.tick();
    s = l.t.state(); assert.equal(s.ended, true); assert.equal(s.endReason, 'CAGED'); assert.deepEqual(s.positions, {}); assert.equal(s.closed.at(-1).reason, 'CAGED');
  } finally { l.done(); }
});

test('ST-08. the tripwire: a 2%+ jump over the last closed minute with a calm crowd wakes him at once with that chart; a frenzy or dust does not', async () => {
  const now = Date.UTC(2026, 8, 30, 12); const candles = []; for (let i = 30; i > 0; i -= 1) candles.push([Math.floor(now / 60000) * 60 - i * 60, 1, 1.01, 0.99, 1.0, 2000]);
  const src = (coin) => ({ candles, trades: Array(30).fill(coin === 'FRENZY' ? 40 : 5) });
  const tk = { ROCK: { bid: 1.03, ask: 1.035 }, FRENZY: { bid: 1.05, ask: 1.06 }, CALM: { bid: 1.005, ask: 1.01 } };
  const out = tripwireCheck({ coins: ['ROCK', 'FRENZY', 'CALM'], seriesSource: src, ticker: (c) => tk[c], nowTs: now, cfg: TRADER_DEFAULTS.tripwire });
  assert.deepEqual(out.map((x) => x.coin), ['ROCK']); assert.equal(out[0].jumpPct, 3); assert.equal(out[0].tradesLastMinute, 5);
  const dust = tripwireCheck({ coins: ['ROCK'], seriesSource: () => ({ candles: candles.map((c) => [...c.slice(0, 5), 1]), trades: Array(30).fill(5) }), ticker: (c) => tk[c], nowTs: now, cfg: TRADER_DEFAULTS.tripwire });
  assert.equal(dust.length, 0);
  // live: the bid jumps between looks -> the next tick wakes him (no waiting for the 3-minute look), the message says TRIPWIRE, a buy is taken
  const r = rig({ answers: [ans(), ans(buy(100, 0.97))] });
  try {
    await r.t.tick(); assert.equal(r.calls.length, 1); // the first movers look
    r.advance(60_000); r.book.bid = 1.03; r.book.ask = 1.035; await r.t.tick();
    assert.equal(r.calls.length, 2); assert.ok(r.calls[1].messages[0].content[0].text.includes('TRIPWIRE — a launch seconds old. ABC is up 3%'));
    assert.ok(r.t.state().positions.ABC); assert.ok(r.logs.some((l) => l.includes('TRIPWIRE: ABC +3%')));
    r.advance(60_000); r.book.bid = 1.08; await r.t.tick(); // held coins never trip again; cooldown holds
    assert.equal(r.calls.filter((c) => c.messages[0].content[0].text.includes('TRIPWIRE')).length, 1);
  } finally { r.done(); }
});

test('ST-09. the auto-trail: +3% locks break-even after fees, +6% trails 5% under the high; a stop is never lowered (MOVE_STOP down is refused)', async () => {
  const r = rig({ answers: [ans(buy(100, 0.9)), ans({ type: 'MOVE_STOP', coin: 'ABC', usd: null, stop: 0.95, roomPct: null, strategy: 'OTHER', why: 'lower it' })] });
  try {
    await r.t.tick(); const p = () => r.t.state().positions.ABC; assert.equal(p().stop, 0.9);
    r.book.bid = 1.02; r.advance(15_000); await r.t.tick(); assert.equal(p().stop, 0.9, 'under +3%: untouched');
    r.book.bid = 1.045; r.advance(15_000); await r.t.tick(); const be = 1.01 * (1 + 0.016 + 0.002); assert.ok(Math.abs(p().stop - be) < 1e-9, 'break-even after fees locked');
    r.book.bid = 1.10; r.advance(15_000); await r.t.tick(); assert.ok(Math.abs(p().stop - 1.10 * 0.95) < 1e-9, 'trails 5% under the high');
    r.book.bid = 1.07; r.advance(15_000); await r.t.tick(); assert.ok(Math.abs(p().stop - 1.10 * 0.95) < 1e-9, 'the high stands: the stop never drops');
    r.advance(60_000); await r.t.tick(); // the holding check answers MOVE_STOP 0.95 (below the current stop) -> refused
    assert.ok(Math.abs(p().stop - 1.10 * 0.95) < 1e-9); assert.ok(r.logs.some((l) => l.includes('a stop is never lowered')));
    r.book.bid = 1.04; r.advance(15_000); await r.t.tick(); assert.ok(!p(), 'trailed stop hit'); assert.equal(r.t.state().closed.at(-1).reason, 'STOP'); assert.ok(r.t.state().closed.at(-1).pnlUsd > 0);
  } finally { r.done(); }
});

test('ST-10. limit orders: rest under the bid, fill ONLY when the price trades through, at the limit with the maker fee; marketable / too deep refused; expiry; cancel', async () => {
  const r = rig({ answers: [ans(limit(100, 1.0, 0.95), limit(100, 0.5, 0.4, { coin: 'ABC' }))] });
  try {
    await r.t.tick(); // 1.0 is not under the bid 1.0 -> refused as marketable; the second is a duplicate coin? no: first refused, second 50% under -> refused too deep
    assert.equal(Object.keys(r.t.state().orders).length, 0); assert.ok(r.logs.some((l) => l.includes('would take the market: use BUY'))); assert.ok(r.logs.some((l) => l.includes('a wish, not an order')));
  } finally { r.done(); }
  const f = rig({ answers: [ans(limit(100, 0.98, 0.95))] });
  try {
    await f.t.tick(); const o = f.t.state().orders.ABC; assert.ok(o, 'the limit rests'); assert.equal(o.price, 0.98);
    assert.ok(f.t.state().cashUsd === 500, 'cash is not spent while it rests');
    f.book.bid = 0.985; f.book.ask = 0.99; f.advance(15_000); await f.t.tick(); assert.ok(f.t.state().orders.ABC, 'touching near it is not a fill');
    // a minute that opened after the order traded 0.975 -> through the limit -> filled at 0.98, maker fee
    f.advance(60_000); const openSec = Math.floor(f.now() / 60000) * 60 - 60; f.extra.push([openSec, 0.975]); f.advance(15_000); await f.t.tick();
    const s = f.t.state(); assert.ok(!s.orders.ABC); assert.ok(s.positions.ABC); assert.equal(s.positions.ABC.entryPx, 0.98); assert.equal(s.positions.ABC.entryKind, 'LIMIT');
    assert.equal(Math.round(s.cashUsd * 100) / 100, 500 - 100 - 0.4, 'maker fee 0.4%');
    assert.ok(f.logs.some((l) => l.includes('LIMIT FILLED ABC')));
  } finally { f.done(); }
  const e = rig({ answers: [ans(limit(100, 0.98, 0.95))] });
  try { await e.t.tick(); e.advance(31 * 60_000); await e.t.tick(); assert.ok(!e.t.state().orders.ABC); assert.ok(!e.t.state().positions.ABC); assert.ok(e.logs.some((l) => l.includes('expired unfilled'))); } finally { e.done(); }
  const c = rig({ answers: [ans(limit(100, 0.98, 0.95)), ans({ type: 'CANCEL', coin: 'ABC', usd: null, price: null, stop: null, roomPct: null, strategy: 'OTHER', why: 'the dip is not coming' })] });
  try { await c.t.tick(); c.advance(TRADER_DEFAULTS.lookLadderMs[0] + 1000); await c.t.tick(); assert.ok(!c.t.state().orders.ABC); assert.ok(c.logs.some((l) => l.includes('cancelled the limit on ABC'))); } finally { c.done(); }
});

test('ST-11. half off at +4% as a maker sell, the rest rides; one trade is counted once and one lesson is owed; the lesson lands in the notebook and is shown back', async () => {
  const r = rig({ answers: [ans(buy(200, 0.95)), { actions: [], note: 'x', lessons: [{ coin: 'ABC', lesson: 'Half off paid; the trail took the rest at break-even plus. Keep the stop under the swing low.' }] }] });
  try {
    await r.t.tick(); r.book.bid = 1.06; r.book.ask = 1.07; r.advance(15_000); await r.t.tick();
    let s = r.t.state(); const half = s.closed.at(-1); assert.equal(half.part, 'HALF'); assert.equal(half.reason, 'HALF_OFF'); assert.equal(half.exitPx, 1.01 * 1.04);
    assert.ok(s.positions.ABC.halfTaken); assert.ok(Math.abs(s.positions.ABC.costUsd - 100) < 1e-9); assert.equal(s.trades, 0, 'not a closed trade yet');
    const proceeds = (100 / 1.01) * 1.0504; assert.ok(Math.abs(half.pnlUsd - Math.round((proceeds * (1 - 0.004) - 100 - 0.8) * 100) / 100) < 0.011);
    r.book.bid = 1.0; r.book.ask = 1.01; r.advance(15_000); await r.t.tick(); // back under the break-even stop -> the rest is stopped
    s = r.t.state(); assert.ok(!s.positions.ABC); assert.equal(s.trades, 1); assert.equal(s.owed.length, 1); assert.equal(s.owed[0].coin, 'ABC');
    r.advance(60_000); await r.t.tick(); // a holding check runs for the owed lesson and takes it
    s = r.t.state(); assert.equal(s.owed.length, 0); assert.equal(s.notebook.length, 1); assert.ok(s.notebook[0].lesson.startsWith('Half off paid'));
    assert.ok(r.calls.at(-1).messages[0].content[0].text.includes('LESSONS OWED'));
    r.advance(TRADER_DEFAULTS.lookLadderMs[0]); await r.t.tick(); assert.ok(r.calls.at(-1).messages[0].content[0].text.includes('YOUR NOTEBOOK'));
  } finally { r.done(); }
});

test('ST-12. the album finds real rockets and duds in the candles, renders the before and the after, and rides in a cached system block', async () => {
  const now = Date.UTC(2026, 8, 30, 12); const n = 200; const t0 = Math.floor(now / 60000) * 60 - n * 60;
  const flat = (px) => Array.from({ length: n }, (_, i) => [t0 + i * 60, px, px * 1.002, px * 0.998, px, 20_000 / px]);
  const rocket = flat(1); rocket[100] = [t0 + 6000, 1, 1.031, 1, 1.03, 20_000]; for (let k = 101; k < 160; k += 1) { const px = 1.03 * (1 + (k - 100) * 0.003); rocket[k] = [t0 + k * 60, px, px * 1.002, px * 0.995, px, 20_000]; }
  const dud = flat(2); dud[100] = [t0 + 6000, 2, 2.05, 2, 2.05, 20_000]; for (let k = 101; k < n; k += 1) dud[k] = [t0 + k * 60, 2.04, 2.05, 2.0, 2.02, 10_000];
  const series = { RKT: { candles: rocket, trades: Array(n).fill(6) }, DUD: { candles: dud, trades: Array(n).fill(20) }, CALM: { candles: flat(3), trades: Array(n).fill(3) } };
  const a = buildAlbum({ coins: ['RKT', 'DUD', 'CALM'], seriesSource: (c) => series[c], nowTs: now, cfg: TRADER_DEFAULTS.album });
  assert.equal(a.rockets, 1); assert.equal(a.duds, 1); assert.deepEqual(a.shown.map((x) => `${x.coin}:${x.kind}`), ['RKT:ROCKET', 'DUD:DUD']);
  assert.ok(a.text.includes('ROCKET — RKT')); assert.ok(a.text.includes('DUD — DUD')); assert.ok(a.text.includes('the hour after, 5-minute blocks'));
  const r = rig({}); try { await r.t.tick(); const sys = r.calls[0].system; assert.equal(sys.length, 2); assert.ok(sys[1].text.startsWith('THE ALBUM')); assert.deepEqual(sys[1].cache_control, { type: 'ephemeral' }); } finally { r.done(); }
});

test('ST-13. the tape: buyer share and depth beside the chart; the tripwire passes on a jump that sellers are meeting', async () => {
  const snap = { tradeImbalance15s: 1, tradeImbalance1m: 0.8, tradeImbalance5m: 0.2, depthUsd: { '25bps': { bid: 1200, ask: 5400 } }, spreadBps: 42.5 };
  const f = tapeFacts({ ...snap, tsMs: 1000 }, 6000); assert.equal(f.buy15s, 1); assert.equal(f.buy1m, 0.9); assert.equal(f.buy5m, 0.6);
  assert.equal(flowText(f), 'tape (5s old): buyers 100% of the last 15 s, 90% of the last minute, 60% of 5 min; within 0.25% of the mid $1200 of bids vs $5400 of offers; spread 42.5 bps');
  assert.equal(tapeFacts({ ...snap, tsMs: 1000 }, 120_000), null, 'a stale tape is not shown');
  const r = rig({ tapeSnap: snap }); try { await r.t.tick(); assert.ok(r.calls[0].messages[0].content[0].text.includes('buyers 100% of the last 15 s')); } finally { r.done(); }
  const now = Date.UTC(2026, 8, 30, 12); const candles = []; for (let i = 30; i > 0; i -= 1) candles.push([Math.floor(now / 60000) * 60 - i * 60, 1, 1.01, 0.99, 1.0, 2000]);
  const args = { coins: ['ROCK'], seriesSource: () => ({ candles, trades: Array(30).fill(5) }), ticker: () => ({ bid: 1.03, ask: 1.035 }), nowTs: now, cfg: TRADER_DEFAULTS.tripwire };
  assert.equal(tripwireCheck({ ...args, tape: () => ({ buy1m: 0.4 }) }).length, 0, 'sellers meeting the jump');
  assert.equal(tripwireCheck({ ...args, tape: () => ({ buy1m: 0.95 }) })[0].buyShare, 0.95);
  assert.equal(tripwireCheck(args).length, 1, 'no tape -> the old rule stands');
});

test('ST-14. the hours: looks slow down 2x overnight (0-6 UTC)', async () => {
  const r = rig({}); try {
    await r.t.tick(); assert.equal(r.t.status().cage.lookEveryMs, TRADER_DEFAULTS.lookLadderMs[0]);
    r.advance(14 * H); await r.t.tick(); assert.equal(r.t.status().cage.lookEveryMs, TRADER_DEFAULTS.lookLadderMs[0] * 2, '02:00 UTC is overnight');
  } finally { r.done(); }
});
