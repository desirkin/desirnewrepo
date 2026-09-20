// PUBLISH-FIX-83 — review finding: the research shadow control sampled EVERY completed wide-eye sweep (one durable journal
// event a minute). Law now: a new sample at most every RESEARCH_SHADOW_MIN_INTERVAL_MS, measured from the latest durable
// sample's known-at clock; a denser history left by the old law still replays (replay by law, never re-judged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { RESEARCH_SHADOW_EVENT_TYPE, RESEARCH_SHADOW_MIN_INTERVAL_MS } from '../rumor2/social-research-shadow.js';
import { sessionDate } from '../lib/time.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { T0, observed, scopeHistory, catalogOf } from './helpers/social-7.js';

const X = 'X_OFFICIAL'; const B = 'BLUESKY_OFFICIAL';
const SWEEP = (n) => `ws-${n.toString(16).padStart(40, '0')}`;
const row = (coin) => ({ coin, evaluated: true, zVol: 0.4, zRet: -0.1, extension: 0.2, preCooldownVerdict: null, cooldownSuppressed: false, noticeEmitted: false, usdVol24h: null, inDeepTape: false });
const population = (sweepId, tsMs, rows, catalogContentId) => Object.freeze({ version: 'wideeye-sweep-population-1', sweepId, tsMs, ts: new Date(tsMs).toISOString(), sessionDate: sessionDate(new Date(tsMs)), catalogContentId, catalogStatus: 'ACCEPTED', scanned: rows.length + 2, tickerRows: rows.length + 1, evaluated: rows.length, excluded: { NO_TICKER_ROW: 1, PRICE_INVALID: 0, INSUFFICIENT_SERIES: 1 }, rows: Object.freeze(rows.map((r) => Object.freeze(r))) });

test('FIX83-SH1. one sweep a minute yields one shadow sample per 15 minutes, not sixty an hour; the latest durable sample sets the clock, so a restart keeps the cadence', async () => {
  const hist = scopeHistory(['LINK']); const cat = catalogOf(['LINK']); const arr = [...hist]; const journal = memJournal(arr);
  const clock = { ms: T0 + 5000 }; let sweep = 0; let pop = null;
  const rt = createResearchStrainer({ now: () => clock.ms, populationSource: () => pop }); assert.equal(rt.hydrate(arr).ok, true);
  const tick = () => rt.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms, [B, X]), fenceHeld: () => true, append: (e) => journal.append(e) });
  const samples = () => arr.filter((e) => e.type === RESEARCH_SHADOW_EVENT_TYPE);
  for (let minute = 0; minute < 60; minute += 1) { clock.ms += 60_000; sweep += 1; pop = population(SWEEP(sweep), clock.ms - 1000, [row('AAA1'), row('BBB2')], cat.contentId); const r = await tick(); assert.equal(r.ok, true, JSON.stringify(r)); }
  assert.equal(samples().length, 4, `an hour of minute sweeps: one sample per ${RESEARCH_SHADOW_MIN_INTERVAL_MS / 60_000} min`);
  assert.equal(rt.status().bounds.shadowMinIntervalMs, RESEARCH_SHADOW_MIN_INTERVAL_MS);
  // restart: the replayed latest sample carries the clock forward — a sweep 14.5 min after it is NOT sampled, one 15 min later is
  const rt2 = createResearchStrainer({ now: () => clock.ms, populationSource: () => pop }); assert.equal(rt2.hydrate(arr).ok, true); assert.equal(rt2.status().shadowControl.durableSamples, 4);
  const tick2 = () => rt2.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms, [B, X]), fenceHeld: () => true, append: (e) => journal.append(e) });
  clock.ms += 30_000; sweep += 1; pop = population(SWEEP(sweep), clock.ms - 1000, [row('AAA1')], cat.contentId); await tick2(); assert.equal(samples().length, 4, 'not due yet after the restart (14.5 min since the last durable sample)');
  clock.ms += RESEARCH_SHADOW_MIN_INTERVAL_MS; sweep += 1; pop = population(SWEEP(sweep), clock.ms - 1000, [row('AAA1')], cat.contentId); await tick2(); assert.equal(samples().length, 5, 'due again');
  // a history written under the old dense law (two samples a minute apart) replays without complaint
  const dense = createResearchStrainer({ now: () => clock.ms }); assert.equal(dense.hydrate(arr).ok, true);
});
