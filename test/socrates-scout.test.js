// PUBLISH-FIX-74: the Socrates scout — a fresh sealed upward case calls a capped, time-boxed AUDIBLE into the Judge's watch.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { selectAudibles, createScoutSource, SCOUT_SOURCE, SCOUT_VERSION } from '../market-lab/scout.js';

const T = Date.UTC(2026, 8, 19, 3, 0, 0); const MIN = 60_000;
const f = (dir, coin, minsAgo, extra = {}) => ({ dir, coin, ok: true, direction: 'UPWARD_PRESSURE', provenance: 'LIVE_MODEL', completionTs: T - minsAgo * MIN, note: `${coin} thesis`, ...extra });

test('SC-01. selectAudibles: only fresh, verified, LIVE_MODEL, UPWARD cases are called; newest case per coin; a coin under an audible is not re-called; 2 at once and 4 per hour are hard caps; an audible expires with its window', () => {
  const findings = [
    f('c1', 'PEPE', 5), f('c0', 'PEPE', 40), // same coin: the newest case only
    f('c2', 'WIF', 10), f('c3', 'ARB', 12),
    f('c4', 'DOGE', 3, { direction: 'NO_CLEAR_DIRECTION' }), f('c5', 'SOL', 2, { provenance: 'RECORDED_RESPONSE' }), f('c6', 'BTC', 120), f('c7', 'ETH', -3), f('c8', 'XRP', 1, { ok: false }),
  ];
  const s = selectAudibles(findings, [], { nowTs: T });
  assert.deepEqual(s.calls.map((a) => [a.dir, a.coin]), [['c1', 'PEPE'], ['c2', 'WIF']], 'two at once, newest first; DOGE (no direction), SOL (synthetic), BTC (stale), ETH (future), XRP (unverified) never');
  assert.equal(s.capped.atOnce, true); assert.equal(s.calls[0].untilTs, T + 60 * MIN);
  // ten minutes later with room for four: ETH's case is no longer from the future and is the newest, ARB's is still fresh; PEPE's older case c0 is not re-called while PEPE is active
  const called = s.calls; const later = selectAudibles(findings, called, { nowTs: T + 10 * MIN, maxAudibles: 4 });
  assert.deepEqual(later.calls.map((a) => a.coin), ['ETH', 'ARB']); assert.equal(later.active.length, 4);
  // per-hour cap: four already called this hour -> nothing more, however fresh
  const four = ['A', 'B', 'C', 'D'].map((c, i) => ({ dir: `d${i}`, coin: c, calledTs: T - 20 * MIN, untilTs: T + 40 * MIN }));
  const capped = selectAudibles([f('c9', 'NEAR', 1)], four, { nowTs: T, maxAudibles: 10 }); assert.equal(capped.calls.length, 0); assert.equal(capped.capped.perHour, true);
  // windows expire: an audible called 61 minutes ago is gone, and its coin may be called again on a NEW case
  const gone = selectAudibles([f('c10', 'PEPE', 2)], [{ dir: 'c1', coin: 'PEPE', calledTs: T - 61 * MIN, untilTs: T - MIN }], { nowTs: T });
  assert.equal(gone.active.length, 1); assert.equal(gone.calls[0].dir, 'c10');
  const same = selectAudibles([f('c1', 'PEPE', 62)], [{ dir: 'c1', coin: 'PEPE', calledTs: T - 61 * MIN, untilTs: T - MIN }], { nowTs: T }); assert.equal(same.calls.length, 0, 'one call per case, ever');
});

test('SC-02. createScoutSource reads the sealed-case directories through the injected verifier and consumer, calls audibles with the nomination shape the Judge door expects, logs each call once, re-reads only changed manifests, counts a throwing verifier, and says it is dormant with no case', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-scout-'));
  try {
    const cases = path.join(dir, 'cases'); mkdirSync(cases, { recursive: true });
    const mk = (id, coin, ts) => { mkdirSync(path.join(cases, id)); writeFileSync(path.join(cases, id, 'manifest.json'), JSON.stringify({ caseId: id, subject: { canonicalCoin: coin }, timing: { finishedTs: ts } })); };
    const verified = new Map(); let verifies = 0;
    const verify = async (d) => { verifies += 1; const id = path.basename(d); if (id === 'bad') throw new Error('torn'); return verified.get(id) ?? { ok: false, reasons: ['NOT_SEALED'] }; };
    const consume = (v, { canonicalCoin, decisionTs }) => (v.finishedTs > decisionTs ? { ok: false, reasons: ['CASE_FROM_THE_FUTURE'] } : { ok: true, direction: v.direction, provenance: 'LIVE_MODEL', completionTs: v.finishedTs, analysis: { thesis: { text: v.thesis }, marketImplication: { horizon: 'MINUTES_5_30' } } });
    let now = T; const logs = [];
    const scout = createScoutSource({ casesDir: cases, verify, consume, clock: () => now, log: (l) => logs.push(l) });
    assert.equal(scout.version, SCOUT_VERSION);
    await scout.refresh(); assert.match(scout.line(), /no sealed case to read yet \(dormant until Socrates is funded\)/); assert.deepEqual(scout.nominations(), []);
    mk('case-pepe', 'PEPE', T - 4 * MIN); verified.set('case-pepe', { ok: true, manifest: { subject: { canonicalCoin: 'PEPE' } }, finishedTs: T - 4 * MIN, direction: 'UPWARD_PRESSURE', thesis: 'exchange listing rumor confirmed by two sources' });
    mk('case-btc', 'BTC', T - 2 * MIN); verified.set('case-btc', { ok: true, manifest: { subject: { canonicalCoin: 'BTC' } }, finishedTs: T - 2 * MIN, direction: 'NO_CLEAR_DIRECTION', thesis: 'nothing' });
    mk('bad', 'WIF', T - MIN);
    await scout.refresh();
    const n = scout.nominations(); assert.equal(n.length, 1); assert.deepEqual(n[0], { symbol: 'PEPE/USD', assetId: 'PEPE', source: SCOUT_SOURCE, nominationKnownAtTs: T });
    assert.equal(logs.length, 1); assert.match(logs[0], /SOCRATES SCOUT: audible — PEPE into the Judge's watch until 04:00 UTC: Socrates' 02:56 case reads UPWARD_PRESSURE — "exchange listing rumor confirmed by two sources" \(case case-pepe\); the Judge's setups and gates decide the entry as always/);
    assert.match(scout.line(), /PEPE until 04:00 \(exchange listing rumor/); assert.match(scout.line(), /3 cases seen, 1 audibles called \(caps 2 at once \/ 4 per hour\)/);
    const st = scout.status(); assert.equal(st.counters.verifyFailures, 1); assert.equal(st.counters.casesSeen, 3); assert.equal(st.authority, 'NONE');
    const v1 = verifies; now = T + 30 * MIN; await scout.refresh(); assert.equal(verifies, v1, 'unchanged manifests are not re-verified'); assert.equal(logs.length, 1, 'an audible is logged once'); assert.equal(scout.nominations().length, 1);
    // the manifest changes (a revision): re-read; the same case dir is never called twice
    utimesSync(path.join(cases, 'case-pepe', 'manifest.json'), new Date(now), new Date(now)); await scout.refresh(); assert.equal(verifies, v1 + 1); assert.equal(logs.length, 1);
    now = T + 61 * MIN; await scout.refresh(); assert.deepEqual(scout.nominations(), [], 'the audible expired with its hour'); assert.match(scout.line(), /no fresh upward case; no audible/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
