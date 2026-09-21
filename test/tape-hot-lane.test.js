// PUBLISH-FIX-28 (2026-09-17, owner directive): a hot coin rushes to the front of the line. A WIDE EYE nominee joins the
// deep tape NOW through the daily selection's own venue verification, in a bounded hot lane; the current-universe record
// stays a superset of what the tape carries; the Judge's nomination law then preempts the oldest tenant for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planHotAdoption, HOT_LANE_DEFAULTS } from '../tape/hot-lane.js';
import { selectPreparation } from '../judge/readiness.js';

const T = 1_789_000_000_000; const H = 60 * 60_000;
const pair = (coin, extra = {}) => ({ coin, symbol: `${coin}/USD`, major: false, depth: 25, usdVol24h: 10_000_000, ...extra });

test('a fresh nominee the venue selection verifies is adopted hot; an unverified one (below floor / offline / excluded / over cap) is not; a carried coin is ignored; seen coins are never re-planned', () => {
  const carried = [pair('BTC'), pair('ETH'), pair('SOL')];
  const verified = [pair('BTC'), pair('ETH'), pair('SOL'), pair('PUMP', { usdVol24h: 4_000_000 })];
  const plan = planHotAdoption({ nominations: [{ coin: 'PUMP', ts: '2026-09-17T08:00:00Z', cause: 'RIPPLE zVol=4.2' }, { coin: 'TINY', ts: 'x' }, { coin: 'BTC', ts: 'y' }], carried, verified, nowTs: T });
  assert.deepEqual(plan.adopt.map((p) => [p.coin, p.hot, p.hotSinceTs, p.cause]), [['PUMP', true, T, 'RIPPLE zVol=4.2']]);
  // PUBLISH-FIX-96: a venue refusal is retried, never remembered — a runner's 24 h volume builds WHILE it runs
  assert.deepEqual(plan.skipped, [{ coin: 'TINY', reason: 'NOT_VERIFIED_BY_VENUE_SELECTION', retry: true }, { coin: 'BTC', reason: 'ALREADY_CARRIED' }]);
  assert.deepEqual([...plan.seen].sort(), ['BTC', 'PUMP'], 'PUBLISH-FIX-96: TINY is NOT remembered as refused');
  const again = planHotAdoption({ nominations: [{ coin: 'PUMP' }, { coin: 'TINY' }], carried, verified, seen: plan.seen, nowTs: T + 1000 });
  assert.equal(again.adopt.length, 0); assert.deepEqual(again.skipped, [{ coin: 'TINY', reason: 'NOT_VERIFIED_BY_VENUE_SELECTION', retry: true }], 'the adopted nominee is not planned twice; the refused one is looked at again');
});

test('the hot lane is bounded: a fourth nominee waits while every hot pair is inside its thrash guard, then the oldest yields; a pinned (held) hot pair never yields', () => {
  const hot = [pair('A', { hot: true, hotSinceTs: T - 3 * H }), pair('B', { hot: true, hotSinceTs: T - 2.5 * H }), pair('C', { hot: true, hotSinceTs: T - 10 * 60_000 })];
  const carried = [pair('BTC'), ...hot]; const verified = [...carried, pair('D'), pair('E')];
  const alive = [{ coin: 'A' }, { coin: 'B' }, { coin: 'C' }]; // still nominated, so nothing is released
  const full = planHotAdoption({ nominations: [...alive, { coin: 'D' }], carried, verified, nowTs: T, slots: 3, minHoldMs: 4 * H });
  assert.deepEqual(full.adopt, []); assert.deepEqual(full.released, [], 'A, B and C are still nominated: nothing is released'); assert.deepEqual(full.skipped, [{ coin: 'D', reason: 'HOT_LANE_FULL', retry: true }]); assert.equal(full.seen.has('D'), false, 'PUBLISH-FIX-83 item 15: a nominee refused for a full lane is retried on the next pass, not remembered as seen');
  const yields = planHotAdoption({ nominations: [...alive, { coin: 'D' }, { coin: 'E' }], carried, verified, nowTs: T, slots: 3, minHoldMs: 2 * H });
  assert.deepEqual(yields.evict, ['A/USD', 'B/USD'], 'the two hot pairs past the thrash guard yield, oldest first'); assert.deepEqual(yields.adopt.map((p) => p.coin), ['D', 'E']); assert.deepEqual([...yields.seen].sort(), ['C', 'D', 'E'], 'PUBLISH-FIX-96: C is hot AND still nominated — affirmed, so it stays seen; A and B yielded and left seen so they can come back');
  const back = planHotAdoption({ nominations: [{ coin: 'A' }, { coin: 'C' }, { coin: 'D' }, { coin: 'E' }], carried: [pair('BTC'), pair('C', { hot: true, hotSinceTs: T }), pair('D', { hot: true, hotSinceTs: T }), pair('E', { hot: true, hotSinceTs: T })], verified: [...verified], seen: yields.seen, nowTs: T + 1000, slots: 4, minHoldMs: 2 * H }); assert.deepEqual(back.adopt.map((p) => p.coin), ['A'], 'an evicted coin can be nominated and adopted again later');
  const pinned = planHotAdoption({ nominations: [...alive, { coin: 'D' }], carried, verified, pinned: new Set(['A/USD', 'B/USD']), nowTs: T, slots: 3, minHoldMs: 2 * H });
  assert.deepEqual(pinned.evict, []); assert.deepEqual(pinned.skipped, [{ coin: 'D', reason: 'HOT_LANE_FULL', retry: true }], 'held exposure is never evicted for a nominee');
  assert.deepEqual(HOT_LANE_DEFAULTS, { slots: 3, minHoldMs: 10 * 60_000 });
});

test('the current-universe record becomes a superset of the carried hot pairs; only this session\'s nominations are read', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-hot-lane-')); const prev = process.env.COBRA_DATA_DIR; process.env.COBRA_DATA_DIR = dir;
  // PUBLISH-FIX-103: pin the data GENERATION off too — dataDir() is COBRA_DATA_DIR + SERPENT_DATA_GENERATION, and the Replit
  // shell exports gen1, which sent the write to <tmp>/gen1 while the read looked in <tmp>. A drill owns its own data root.
  const prevGen = process.env.SERPENT_DATA_GENERATION; process.env.SERPENT_DATA_GENERATION = '';
  try {
    const { mergeCarriedIntoCurrentUniverse, readWideEyeNominationsToday, readCurrentUniverse, DEEP_UNIVERSE_SELECTION_VERSION } = await import('../tape/universe.js?hot-lane');
    const { sessionDate } = await import('../lib/time.js');
    const uDir = path.join(dir, 'tape', 'universe'); mkdirSync(uDir, { recursive: true }); mkdirSync(path.join(dir, 'survey'), { recursive: true });
    const record = { date: sessionDate(), selectedAt: 'x', source: 'kraken REST AssetPairs+Ticker', selectionVersion: DEEP_UNIVERSE_SELECTION_VERSION, count: 1, pairs: [pair('BTC')] };
    writeFileSync(path.join(uDir, 'current.json'), JSON.stringify(record));
    const before = readCurrentUniverse(); assert.ok(before, 'the fixture record is readable as the current universe');
    const m = mergeCarriedIntoCurrentUniverse([pair('PUMP', { hot: true, hotSinceTs: T })]); assert.deepEqual(m, { ok: true, added: ['PUMP/USD'], removed: [] });
    const after = readCurrentUniverse(); assert.deepEqual(after.pairs.map((p) => p.symbol), ['BTC/USD', 'PUMP/USD']); assert.equal(after.count, 2); assert.equal(after.pairs[1].hot, true);
    assert.deepEqual(mergeCarriedIntoCurrentUniverse([pair('PUMP')]), { ok: true, added: [], removed: [] }, 'idempotent');
    // PUBLISH-FIX-83 item 15: a yielded hot pair leaves the record (the Judge stops nominating a pair the tape no longer carries); a non-hot pair is never removed
    assert.deepEqual(mergeCarriedIntoCurrentUniverse([], { yielded: ['PUMP/USD', 'BTC/USD'] }), { ok: true, added: [], removed: ['PUMP/USD'] }); assert.deepEqual(readCurrentUniverse().pairs.map((p) => p.symbol), ['BTC/USD']); assert.equal(readCurrentUniverse().count, 1);
    writeFileSync(path.join(dir, 'survey', 'nominations-current.json'), JSON.stringify({ date: '2020-01-01', nominations: [{ coin: 'OLD' }] }));
    assert.deepEqual(readWideEyeNominationsToday(), [], 'a previous session\'s proposals are not hot today');
    writeFileSync(path.join(dir, 'survey', 'nominations-current.json'), JSON.stringify({ date: sessionDate(), nominations: [{ coin: 'PUMP', ts: 'now' }] }));
    assert.deepEqual(readWideEyeNominationsToday(), [{ coin: 'PUMP', ts: 'now' }]);
  } finally { if (prev === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = prev; if (prevGen === undefined) delete process.env.SERPENT_DATA_GENERATION; else process.env.SERPENT_DATA_GENERATION = prevGen; rmSync(dir, { recursive: true, force: true }); }
});

test('the Judge law already puts a newcomer first: a pair first seen now outranks every standing tenant and takes a slot at once (the oldest tenant is preempted)', () => {
  const standing = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE'].map((a, i) => ({ assetId: a, symbol: `${a}/USD`, source: 'UNIVERSE', nominationKnownAtTs: T - 5 * H + i * 60_000, nominationLastSeenTs: T }));
  const previous = new Map(standing.map((n) => [n.assetId, { ...n, preparedSinceTs: T - 4 * H, rankTs: n.nominationKnownAtTs }]));
  const hot = { assetId: 'PUMP', symbol: 'PUMP/USD', source: 'UNIVERSE', nominationKnownAtTs: T, nominationLastSeenTs: T };
  const sel = selectPreparation({ nominations: [...standing, hot], remainingSlots: 6, previous, nowTs: T + 1000, rotation: { ended: new Map(), lastRotationTs: T } });
  assert.ok(sel.selected.some((n) => n.assetId === 'PUMP'), 'the hot newcomer holds a preparation slot immediately');
  assert.deepEqual(sel.lost.map((l) => [l.assetId, l.reason]), [['BTC', 'PREEMPTED_BY_NEWER_NOMINATION']], 'the oldest standing tenant yields');
});
