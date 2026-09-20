// PUBLISH-FIX-54 — the LEARNED RE-LOOK (learning/relook.js): the learned gate (movers whose hour after held), missed rises
// among the Judge's own graded decisions, held movers, the bounded selection, the file the tape's hot lane reads, the
// Judge nomination shape, and the fences in fly.js / tape/run.js. Watch only; authority NONE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLearningStore } from '../learning/store.js';
import { buildEpisode } from '../learning/capture.js';
import { BASELINE_RULE_VERSION } from '../learning/contracts.js';
import { lateEntryEvidence, missedRises, heldMovers, selectRelooks, createRelookSource, readLearnedRelooksToday, relookFile, RELOOK_DEFAULTS, RELOOK_SOURCE, RELOOK_VERSION } from '../learning/relook.js';

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0); const MIN = 60_000;
const mover = (coin, eventTs, held, { climbPct = 12, heldPct = 1.5, minutesToPeak = 40 } = {}) => ({ version: 'mover-study-1', kind: 'MOVER', coin, eventTs, climbPct, theMove: { minutesToPeak }, hourAfter: { heldAboveStart: held, heldPct: held ? heldPct : -Math.abs(heldPct) }, recordedTs: eventTs + 60 * MIN });
const judgeEpisode = (coin, decisionTs, decision = 'SKIPPED', setupType = 'RANGE_IGNITION') => buildEpisode({ canonicalCoin: coin, decisionTs, usableAtTs: decisionTs, datasetId: `live-judge-paper:${setupType}`, mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'PROSPECTIVE_SHADOW', featureSet: { features: {} }, gates: [], decision, rejection: decision === 'SKIPPED' ? { reasonCode: 'ENTRY_REFUSED', observedValue: null, threshold: null, class: 'HARD' } : null, setupType, baselineRuleVersion: BASELINE_RULE_VERSION });
const outcomeOf = (episode, logReturnPct, { attachedTs = episode.decisionTs + 61 * MIN, mfePct = null } = {}) => ({ opportunityId: episode.opportunityId, attachedTs, outcomeRow: { horizons: { '60m': { state: 'KNOWN', logReturnPct, mfePct: mfePct ?? Math.max(0, logReturnPct), outcomeKnownAtTs: episode.decisionTs + 60 * MIN } } } });

test('RL-01. the learned gate: armed only with enough movers whose hour after held; the reason names why not', () => {
  const few = lateEntryEvidence([mover('A', T0, true), mover('B', T0, true)]);
  assert.equal(few.armed, false); assert.ok(few.reason.startsWith('TOO_FEW_MOVERS (2 of 20)'));
  const faded = lateEntryEvidence(Array.from({ length: 30 }, (_, i) => mover(`C${i}`, T0 + i * MIN, i < 9)));
  assert.equal(faded.armed, false); assert.ok(faded.reason.startsWith('HOUR_AFTER_FADED (30% held'), faded.reason);
  const armed = lateEntryEvidence(Array.from({ length: 30 }, (_, i) => mover(`D${i}`, T0 + i * MIN, i < 18, { heldPct: 2, minutesToPeak: 35 })));
  assert.equal(armed.armed, true); assert.equal(armed.reason, 'HOUR_AFTER_HELD'); assert.equal(armed.heldShare, 0.6); assert.equal(armed.movers, 30); assert.equal(armed.medianMinutesToPeak, 35);
  assert.equal(lateEntryEvidence([{ kind: 'CONTROL', hourAfter: { heldAboveStart: true } }]).movers, 0, 'controls are not movers');
});

test('RL-01b (PUBLISH-FIX-58). the gate learns from the day TOP boards too: DAILY_TOP climbs count once each, a board entry that also crossed the threshold is the same event as its MOVER record, controls never count', () => {
  const top = (coin, eventTs, held, alsoMover = false) => ({ ...mover(coin, eventTs, held, { climbPct: 4 }), kind: 'DAILY_TOP', rank: 1, of: 30, alsoMover, recordedTs: eventTs + 6 * 60 * MIN });
  // 4 threshold movers + 20 board climbs (2 of which are the same events as movers) = 22 distinct pictured climbs
  const records = [
    ...Array.from({ length: 4 }, (_, i) => mover(`M${i}`, T0 + i * MIN, true)),
    ...Array.from({ length: 18 }, (_, i) => top(`B${i}`, T0 + (10 + i) * MIN, i < 10)),
    top('M0', T0, true, true), top('M1', T0 + MIN, true, true),
    { kind: 'DAILY_TOP_CONTROL', coin: 'X', eventTs: T0, hourAfter: { heldAboveStart: true } }, { kind: 'CONTROL', coin: 'Y', eventTs: T0, hourAfter: { heldAboveStart: true } },
  ];
  const ev = lateEntryEvidence(records);
  assert.equal(ev.movers, 22); assert.equal(ev.threshold, 4); assert.equal(ev.board, 18); assert.equal(ev.held, 14);
  assert.equal(ev.armed, true); assert.equal(ev.reason, 'HOUR_AFTER_HELD'); assert.equal(ev.heldShare, Math.round(14 / 22 * 1000) / 1000);
  // boards alone can arm it: 20 board climbs, 11 held
  const boards = lateEntryEvidence(Array.from({ length: 20 }, (_, i) => top(`C${i}`, T0 + i * MIN, i < 11)));
  assert.equal(boards.armed, true); assert.equal(boards.threshold, 0); assert.equal(boards.board, 20);
  // a board entry without its hour after (pictured too close to day close) does not count
  assert.equal(lateEntryEvidence([{ kind: 'DAILY_TOP', coin: 'Z', eventTs: T0, hourAfter: null }]).movers, 0);
});

test('RL-02. missed rises: only the Judge\'s own not-taken decisions with a FAVORABLE 60m outcome of at least 2%, inside the lookback; taken trades and small moves are not re-looks', () => {
  const e1 = judgeEpisode('XMR', T0 - 70 * MIN, 'SKIPPED'); const e2 = judgeEpisode('ETH', T0 - 65 * MIN, 'NO_SETUP'); const e3 = judgeEpisode('BTC', T0 - 62 * MIN, 'SELECTED_FOR_PAPER'); const e4 = judgeEpisode('SOL', T0 - 4 * 60 * MIN, 'SKIPPED');
  const sweep = buildEpisode({ canonicalCoin: 'ADA', decisionTs: T0 - 66 * MIN, usableAtTs: T0 - 66 * MIN, datasetId: 'live-sweep', mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'PROSPECTIVE_SHADOW', featureSet: { features: {} }, gates: [], decision: 'NO_SETUP', baselineRuleVersion: BASELINE_RULE_VERSION });
  const outcomes = new Map([[e1.opportunityId, outcomeOf(e1, 4.2)], [e2.opportunityId, outcomeOf(e2, 0.8)], [e3.opportunityId, outcomeOf(e3, 6)], [e4.opportunityId, outcomeOf(e4, 9)], [sweep.opportunityId, outcomeOf(sweep, 7)]]);
  const rises = missedRises({ episodes: [e1, e2, e3, e4, sweep], outcomes, nowTs: T0 });
  assert.deepEqual(rises.map((r) => [r.coin, r.kind, r.risePct, r.decision]), [['XMR', 'MISSED_RISE', 4.2, 'SKIPPED']], JSON.stringify(rises));
  assert.equal(rises[0].knownAtTs, e1.decisionTs + 60 * MIN); assert.ok(rises[0].reason.includes('rose 4.2% in the hour after the 10:50 skipped'), rises[0].reason);
  assert.equal(missedRises({ episodes: [e1], outcomes: new Map(), nowTs: T0 }).length, 0, 'no outcome yet: nothing');
});

test('RL-03. held movers and the bounded selection: one entry per coin (strongest), newest first, at most 3, alive for the window, dead after it', () => {
  const recs = [mover('AAA', T0 - 90 * MIN, true, { climbPct: 11 }), mover('AAA', T0 - 80 * MIN, true, { climbPct: 15 }), mover('BBB', T0 - 100 * MIN, false), mover('CCC', T0 - 70 * MIN, true, { climbPct: 12 }), mover('DDD', T0 - 65 * MIN, true, { climbPct: 13 }), mover('EEE', T0 - 61 * MIN, true, { climbPct: 10 }), mover('OLD', T0 - 6 * 60 * MIN, true)];
  const held = heldMovers({ records: recs, nowTs: T0 }); assert.deepEqual(held.map((h) => h.coin), ['AAA', 'AAA', 'CCC', 'DDD', 'EEE']);
  const sel = selectRelooks(held, { nowTs: T0 });
  assert.deepEqual(sel.map((s) => [s.coin, s.risePct]), [['EEE', 10], ['DDD', 13], ['CCC', 12]], 'newest known first, three at most');
  assert.equal(sel[0].source, RELOOK_SOURCE); assert.equal(sel[0].symbol, 'EEE/USD'); assert.equal(sel[0].untilTs - sel[0].sinceTs, RELOOK_DEFAULTS.windowMin * MIN);
  const later = selectRelooks(held, { nowTs: T0 + 3 * 60 * MIN }); assert.equal(later.length, 0, 'every re-look has expired');
  const onePerCoin = selectRelooks(held.filter((h) => h.coin === 'AAA'), { nowTs: T0 - 15 * MIN }); assert.equal(onePerCoin.length, 1); assert.equal(onePerCoin[0].risePct, 15, 'the strongest rise represents the coin');
});

test('RL-04. the source end to end: dormant until the mover evidence says late entries hold, then the Judge nomination shape, the current.json the tape reads, the log lines, and expiry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'relook-')); const logs = []; let now = T0;
  try {
    const real = createLearningStore({ dataDir: dir, log: () => {} });
    const e1 = judgeEpisode('XMR', T0 - 70 * MIN, 'SKIPPED'); real.appendEpisode(e1);
    const store = { ...real, latestOutcomes: () => new Map([[e1.opportunityId, outcomeOf(e1, 4.2)]]) }; // the matured 60m outcome as the store's latest-per-opportunity view presents it
    let dayRecords = [mover('AAA', T0 - 65 * MIN, true, { climbPct: 11 })];
    const moverStudy = { readDay: (date) => (date === new Date(T0).toISOString().slice(0, 10) ? dayRecords : []) };
    const src = createRelookSource({ store, moverStudy, dataDir: dir, clock: () => now, log: (m) => logs.push(m) });
    const dormant = src.refresh(); assert.equal(dormant.armed, false); assert.deepEqual(dormant.relooks, []); assert.deepEqual(src.nominations(), []);
    assert.ok(logs[0].startsWith('LEARNED RE-LOOK DORMANT: TOO_FEW_MOVERS'), logs[0]); assert.deepEqual(readLearnedRelooksToday({ dataDir: dir, nowTs: now }), [], 'dormant: the tape reads nothing');
    // enough movers, most held: armed; the missed rise and the held mover are both offered
    dayRecords = [...dayRecords, ...Array.from({ length: 24 }, (_, i) => mover(`M${i}`, T0 - 30 * 60 * MIN + i * MIN, i < 15))];
    const armed = src.refresh(); assert.equal(armed.armed, true);
    assert.deepEqual(armed.relooks.map((r) => [r.coin, r.kind]), [['AAA', 'HELD_MOVER'], ['XMR', 'MISSED_RISE']], 'newest known first: ' + JSON.stringify(armed.relooks));
    assert.deepEqual(src.nominations(), [{ symbol: 'AAA/USD', assetId: 'AAA', source: RELOOK_SOURCE, nominationKnownAtTs: T0 - 5 * MIN }, { symbol: 'XMR/USD', assetId: 'XMR', source: RELOOK_SOURCE, nominationKnownAtTs: T0 - 10 * MIN }]);
    assert.ok(logs.some((m) => m.startsWith('LEARNED RE-LOOK ARMED: HOUR_AFTER_HELD')), logs.join('\n'));
    assert.ok(logs.some((m) => m.includes("LEARNED RE-LOOK: XMR back in the Judge's watch until") && m.includes('rose 4.2% in the hour after the 10:50 skipped') && m.includes("the Judge's setups and gates decide the entry as always")), logs.join('\n'));
    assert.ok(existsSync(relookFile(dir))); const file = JSON.parse(readFileSync(relookFile(dir), 'utf8')); assert.equal(file.version, RELOOK_VERSION); assert.equal(file.relooks.length, 2);
    const tape = readLearnedRelooksToday({ dataDir: dir, nowTs: now }); assert.deepEqual(tape.map((n) => [n.coin, n.cause]), [['AAA', 'LEARNED_RELOOK HELD_MOVER +11%'], ['XMR', 'LEARNED_RELOOK MISSED_RISE +4.2%']]); assert.equal(typeof tape[0].ts, 'string');
    assert.ok(src.line().includes('ARMED') && src.line().includes('XMR until'), src.line());
    // PUBLISH-FIX-81 (review F4): the learned-influence kill file switches the learned NOMINATION off too — evidence still measured, nothing offered
    real.writeKill({ state: 'KILLED', reason: 'owner baseline', ts: now });
    const killed = src.refresh(); assert.equal(killed.armed, false); assert.deepEqual(killed.relooks, []); assert.deepEqual(src.nominations(), []); assert.match(killed.evidence.reason, /^learned influence KILLED \(data\/learning\/kill.json: owner baseline\); HOUR_AFTER_HELD/); assert.equal(killed.evidence.killed, true);
    real.writeKill({ state: 'ARMED', reason: null, ts: now }); assert.equal(src.refresh().armed, true);
    // the window closes: nothing nominated, nothing for the tape, the file says so
    now = T0 + 3 * 60 * MIN; const closed = src.refresh(); assert.deepEqual(closed.relooks, []); assert.deepEqual(src.nominations(), []); assert.deepEqual(readLearnedRelooksToday({ dataDir: dir, nowTs: now }), []);
    assert.equal(src.status().authority, 'NONE'); assert.equal(src.status().counters.nominated, 4, 'offered twice: before the kill and again after it was lifted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RL-05. fences: fly.js hands the Judge a nominations function that merges the universe with the re-looks and starts the source after learning; tape/run.js reads the re-looks into the hot lane beside the wide eye', () => {
  const fly = readFileSync('fly.js', 'utf8'); const run = readFileSync('tape/run.js', 'utf8');
  assert.ok(fly.includes('composeJudge({ nominations: judgeNominations,'), 'the Judge is composed with the merged nominations');
  assert.ok(fly.includes('relookSource = createRelookSource({ store: learningHandle.store, moverStudy, dataDir: dataDir(), log: console.log });'));
  assert.ok(fly.includes("LEARNED RE-LOOK active (authority NONE; watch only)"));
  assert.ok(run.includes("readLearnedRelooksToday({ dataDir: dataDir() })"), 'the hot lane merges the re-looks with the wide eye nominations');
  assert.ok(run.indexOf('readWideEyeNominationsToday(), ...readLearnedRelooksToday') > 0);
});
