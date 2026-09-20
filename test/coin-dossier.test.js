// PUBLISH-FIX-72: the coin dossier — "why didn't you buy PEPE today?" answered from the engine's own records, in plain words.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildCoinDossier, loadCoinDossier, gateMeaning, GATE_MEANINGS } from '../paper/coin-dossier.js';

const T0 = Date.UTC(2026, 8, 18, 14, 0, 0); const NOW = T0 + 6 * 3600_000;
const dec = (id, minsAgo, state, reasonCodes, pair = 'PEPE/USD', setupId = 'RANGE_IGNITION') => ({ seq: 1, event: { type: 'DECISION_RECORDED', payload: { decisionId: id, pair, assetId: pair.split('/')[0], state, setupId, reasonCodes, decisionKnownAtTs: NOW - minsAgo * 60_000 } } });
const out = (id, minsAgo, state, ret15, mfe15, assetId = 'PEPE') => ({ decisionId: id, assetId, decisionKnownAtTs: NOW - minsAgo * 60_000, decisionState: state, yardstick: { continuation: { state: 'KNOWN', logReturnPct: ret15, mfePct: mfe15 }, researchHorizons: { '1h': { state: 'NOT_YET_KNOWN' } } } });

test('DOS-01. the dossier counts the looks, names the gates in plain words, sums what the coin did after the passes, and reads the watch and the board', () => {
  const events = [
    dec('d1', 300, 'NO_TRADE', ['FI15', 'RV60']), dec('d2', 240, 'NO_TRADE', ['FI15']), dec('d3', 200, 'EXPIRED', ['PROPOSAL_EXPIRED_10S', 'HYPOTHESIS_NOT_DURABLE']),
    dec('d4', 90, 'NO_TRADE', ['PRIOR_MID_RESPONSE_SMALL'], 'PEPE/USD', 'MOMENTUM_CONTINUATION'), dec('d5', 30, 'NO_TRADE', ['FI15']),
    dec('x1', 60, 'NO_TRADE', ['RV60'], 'BTC/USD'), // another coin: never counted
    dec('old', 30 * 60, 'NO_TRADE', ['FI15']), // outside the 24 h window
    { seq: 9, event: { type: 'HYPOTHESIS_LOCKED', payload: { pair: 'PEPE/USD' } } },
  ];
  const outcomes = [out('d1', 300, 'NO_TRADE', 1.9, 2.4), out('d2', 240, 'NO_TRADE', 0.3, 1.0), out('d4', 90, 'NO_TRADE', -0.5, 0.2), out('d5', 30, 'NO_TRADE', 0.9, 0.95), out('x1', 60, 'NO_TRADE', 5, 5, 'BTC')];
  const researchHeads = new Map([['d1', { decisionId: 'd1', attachedTs: NOW, researchHorizons: { '1h': { state: 'KNOWN', logReturnPct: 3.1 } } }], ['d2', { decisionId: 'd2', attachedTs: NOW, researchHorizons: { '1h': { state: 'KNOWN', logReturnPct: -0.2 } } }]]);
  const watch = { version: 'learning-volatility-watch-1', ts: NOW, picks: [{ coin: 'PEPE', sinceTs: NOW - 45 * 60_000, range1hPct: 4.2, usdVol1h: 310_000 }] };
  const board = { entries: [['PEPE', { climb: 12.3, picture: { eventTs: NOW - 4 * 3600_000, hourBefore: { retPct: 3.2, volumeVsPriorHour: 2.7, rangePct: 5.1 }, hourAfter: { retPct: 4.4, mfePct: 6.0, minutesToPeak: 31, heldPct: 2.2 } } }], ['ARB', { climb: 10.9, picture: { eventTs: NOW } }]] };
  const d = buildCoinDossier({ coin: 'pepe', events, outcomes, researchHeads, watch, board, nowTs: NOW });
  assert.equal(d.coin, 'PEPE'); assert.equal(d.looks, 5); assert.deepEqual(d.byStatus, { NO_TRADE: 4, EXPIRED: 1 }); assert.deepEqual(d.bySetup, { RANGE_IGNITION: 4, MOMENTUM_CONTINUATION: 1 });
  assert.equal(d.topGates[0].code, 'FI15'); assert.equal(d.topGates[0].count, 3); assert.match(d.topGates[0].meaning, /buying pressure in the last 15 seconds/);
  assert.equal(d.lastLook.status, 'NO_TRADE'); assert.equal(d.lastLook.ts, NOW - 30 * 60_000); assert.match(d.lastLook.meanings[0], /15 seconds/);
  assert.deepEqual(d.after, { known15: 4, up08: 2, up16: 1, best15: 2.4, known1h: 2, up1h08: 1, best1h: 3.1, entries: 0 }, 'BTC and the old look never counted; 1.9 and 0.9 clear 0.8; only 1.9 clears 1.6; best point 2.4; the hour came from the research attachment');
  assert.equal(d.onWatch.range1hPct, 4.2); assert.equal(d.onBoard.climbPct, 12.3); assert.equal(d.onBoard.hourAfter.minutesToPeak, 31);
  const text = d.lines.join('\n');
  assert.match(text, /PEPE: 5 recorded looks between/); assert.match(text, /4 NO_TRADE, 1 EXPIRED; no entry/); assert.match(text, /FI15 ×3 — the buying pressure/); assert.match(text, /Last look .*NO_TRADE via RANGE_IGNITION because the buying pressure/);
  assert.match(text, /of 4 with a known 15-minute result, 2 rose more than the 0\.8% round trip and 1 rose more than twice it; best point \+2\.40%/); assert.match(text, /Over the hour after: 1 of 2 cleared the round trip; best \+3\.10%/);
  assert.match(text, /On the volatility watch since .* \(4\.2% range this hour, \$310k traded\)/); assert.match(text, /climbed \+12\.30%.*hour before it was \+3\.20% with 2\.7× the prior hour's volume.*hour after it held \+4\.40% \(best \+6\.00%, peak at minute 31\)/);
  assert.equal(gateMeaning('SOME_NEW_GATE'), "a rule named SOME_NEW_GATE in the Judge's law"); assert.ok(Object.keys(GATE_MEANINGS).length >= 30);
});

test('DOS-02. no look yet reads as such (and says so when the coin is on the watch); a coin nobody looked at and nobody watched is plain', () => {
  const d = buildCoinDossier({ coin: 'WIF', events: [], outcomes: [], watch: { picks: [{ coin: 'WIF', sinceTs: NOW - 60_000, range1hPct: 3 }] }, nowTs: NOW });
  assert.equal(d.looks, 0); assert.match(d.lines[0], /WIF: no recorded look .* on the volatility watch now, so looks should follow/);
  const e = buildCoinDossier({ coin: 'DOGE', nowTs: NOW }); assert.equal(e.lines.length, 1); assert.match(e.lines[0], /DOGE: no recorded look/); assert.equal(e.onWatch, null); assert.equal(e.onBoard, null);
});

test('DOS-03. loadCoinDossier reads the engine files under the data dir (bounded, best-effort) and the journal page through the injected reader; missing files read as absent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-dossier-'));
  try {
    mkdirSync(path.join(dir, 'learning', 'decision-outcomes'), { recursive: true }); mkdirSync(path.join(dir, 'learning', 'research-outcomes'), { recursive: true }); mkdirSync(path.join(dir, 'learning', 'volatility'), { recursive: true }); mkdirSync(path.join(dir, 'learning', 'mover-study'), { recursive: true });
    writeFileSync(path.join(dir, 'learning', 'decision-outcomes', 'decision-outcomes.jsonl'), [JSON.stringify(out('d1', 100, 'NO_TRADE', 2.0, 2.5)), 'not json', JSON.stringify(out('d2', 50, 'NO_TRADE', 0.1, 0.4))].join('\n') + '\n');
    writeFileSync(path.join(dir, 'learning', 'research-outcomes', 'research-outcomes.jsonl'), [JSON.stringify({ decisionId: 'd1', attachedTs: NOW - 1000, researchHorizons: { '1h': { state: 'KNOWN', logReturnPct: 0.5 } } }), JSON.stringify({ decisionId: 'd1', attachedTs: NOW, researchHorizons: { '1h': { state: 'KNOWN', logReturnPct: 1.5 } } })].join('\n') + '\n');
    writeFileSync(path.join(dir, 'learning', 'volatility', 'current.json'), JSON.stringify({ version: 'learning-volatility-watch-1', ts: NOW, picks: [{ coin: 'PEPE', sinceTs: NOW - 120_000, range1hPct: 2.2, usdVol1h: 150_000 }] }));
    writeFileSync(path.join(dir, 'learning', 'mover-study', `board-${new Date(NOW).toISOString().slice(0, 10)}.json`), JSON.stringify({ entries: [['PEPE', { climb: 11, picture: { eventTs: NOW - 3600_000 } }]] }));
    const journalPage = async ({ limit }) => { assert.equal(limit, 500); return [dec('d1', 100, 'NO_TRADE', ['RV60']), dec('d2', 50, 'NO_TRADE', ['FI15'])]; };
    const d = await loadCoinDossier({ dataDir: dir, coin: 'PEPE/USD', journalPage, nowTs: NOW });
    assert.equal(d.looks, 2); assert.equal(d.after.known15, 2); assert.equal(d.after.up08, 1); assert.equal(d.after.known1h, 1); assert.equal(d.after.best1h, 1.5, 'the newest attachment is the head'); assert.equal(d.onWatch.range1hPct, 2.2); assert.equal(d.onBoard.climbPct, 11);
    // PUBLISH-FIX-84: looks older than the 500-event journal page come from the 24-hour ledger (same shape, de-duplicated with the page);
    // a ledger look carries its failed gate ids and the '+'-joined refusal reasons; a NO_SETUP row reads NO_TRADE
    const ep = (ts, decision, gates, reasonCode = null) => JSON.stringify({ datasetId: 'live-judge-paper:RANGE_IGNITION', canonicalCoin: 'PEPE', decisionTs: ts, setupType: 'RANGE_IGNITION', decision, gates, rejection: reasonCode ? { reasonCode, observedValue: null, threshold: null, class: 'HARD' } : null, opportunityId: `lop-${ts}` });
    writeFileSync(path.join(dir, 'learning', 'episodes.jsonl'), [
      ep(NOW - 20 * 3600_000, 'NO_SETUP', [{ id: 'FI15', ok: false }, { id: 'RV60', ok: true }, { id: 'MOVE_CLOCK', ok: false }]),
      ep(NOW - 10 * 3600_000, 'SKIPPED', [{ id: 'FI15', ok: true }, { id: 'SIZE_CANDIDATE', ok: false, note: 'REWARD_RISK_BELOW_1_5' }], 'NO_TRADE_SIZE+NO_BOUNDED_FEASIBLE_LOT+REWARD_RISK_BELOW_1_5'),
      ep(NOW - 100 * 60_000, 'NO_SETUP', [{ id: 'RV60', ok: false }]), // the same look the page carries (d1, 100 min ago, same setup): de-duplicated
      ep(NOW - 30 * 3600_000, 'NO_SETUP', [{ id: 'FI15', ok: false }]), // outside 24 h
      JSON.stringify({ datasetId: 'wideeye', canonicalCoin: 'PEPE', decisionTs: NOW - 3600_000, gates: [] }), // not a judge row
    ].join('\n') + '\n');
    const withLedger = await loadCoinDossier({ dataDir: dir, coin: 'PEPE/USD', journalPage, nowTs: NOW });
    assert.equal(withLedger.looks, 4, 'page 2 + ledger 2 new (one duplicate, one too old, one not a judge row)');
    assert.equal(withLedger.byStatus.NO_TRADE, 3); assert.equal(withLedger.byStatus.ENTRY_REFUSED, 1);
    assert.ok(withLedger.topGates.some((g) => g.code === 'NO_TRADE_SIZE') && withLedger.topGates.some((g) => g.code === 'REWARD_RISK_BELOW_1_5'), JSON.stringify(withLedger.topGates));
    assert.ok(!withLedger.topGates.some((g) => g.code === 'MOVE_CLOCK'), 'a measurement row is not a gate');
    const bare = await loadCoinDossier({ dataDir: path.join(dir, 'nowhere'), coin: 'PEPE', journalPage: null, nowTs: NOW }); assert.equal(bare.looks, 0); assert.equal(bare.onWatch, null);
    assert.equal(await loadCoinDossier({ dataDir: dir, coin: '', nowTs: NOW }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
