// PUBLISH-FIX-24 (2026-09-17): quota totals are O(1) aggregates that answer EXACTLY what the row walk answered.
// Production boot 29e95c87: dayKey/monthKey alone took ~14% of the main thread because totals() walked every reservation
// (all providers, all days) on every dispatch admission and every status snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryQuotaJournal, replayQuotaRecords } from '../market-lab/quota.js';

const DAY = 86_400_000; const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10); const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);
const spentCredits = (x) => (x.state === 'RELEASED' ? 0 : x.state === 'SETTLED' ? x.settledCredits : x.credits);
const spentCalls = (x) => (x.state === 'RELEASED' ? 0 : 1);
const spentUsd = (x) => (x.state === 'RELEASED' ? 0 : x.state === 'SETTLED' ? (x.credits ? x.estimatedUsd * (x.settledCredits / x.credits) : 0) : x.estimatedUsd);
// the walk the journal used to run, verbatim in shape, as the oracle
function walk(reservations, providerId, nowTs) {
  const t = { calls: { day: 0, month: 0 }, credits: { day: 0, month: 0 }, usd: { day: 0, month: 0 }, reserved: 0, settled: 0, unresolved: 0, released: 0, smoke: { calls: 0, usd: 0 }, dispatched: 0 };
  for (const x of reservations) { if (x.providerId !== providerId) continue; if (x.state === 'RESERVED') t.reserved += 1; else if (x.state === 'SETTLED') t.settled += 1; else if (x.state === 'UNRESOLVED') t.unresolved += 1; else t.released += 1; if (x.state !== 'RELEASED') t.dispatched += 1; const c = spentCalls(x); const cr = spentCredits(x); const u = spentUsd(x); if (dayKey(x.ts) === dayKey(nowTs)) { t.calls.day += c; t.credits.day += cr; t.usd.day += u; } if (monthKey(x.ts) === monthKey(nowTs)) { t.calls.month += c; t.credits.month += cr; t.usd.month += u; } if (x.purpose === 'PROBE' || x.purpose === 'SMOKE') { t.smoke.calls += c; t.smoke.usd += u; } }
  t.usd.day = Number(t.usd.day.toFixed(6)); t.usd.month = Number(t.usd.month.toFixed(6)); t.smoke.usd = Number(t.smoke.usd.toFixed(6)); return t;
}
// a deterministic mixed history: three providers, four days across a month boundary, every state, both purposes, credits > 1
function history(n, seed = 7) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const providers = ['KRAKEN_SPOT', 'COINBASE_SPOT', 'COINGECKO']; const purposes = ['ACQUIRE', 'ACQUIRE', 'CATALOG', 'PROBE', 'SMOKE'];
  const clock = { t: T0 - 20 * DAY }; const records = []; const j = createMemoryQuotaJournal({ clock: () => clock.t, record: (r) => records.push(r) }); const ids = [];
  for (let i = 0; i < n; i += 1) {
    clock.t += Math.floor(rnd() * 1200) + 1;
    const providerId = providers[i % 3]; const credits = 1 + Math.floor(rnd() * 4);
    const id = j.reserve({ providerId, endpointId: 'rest-ohlc', unit: providerId === 'COINGECKO' ? 'CREDIT' : 'CALL', credits, chargedOn: providerId === 'COINGECKO' ? 'SUCCESS' : 'DISPATCH', purpose: purposes[i % purposes.length], requestKey: `k${i}`, estimatedUsd: Number((rnd() * 0.01).toFixed(6)) });
    ids.push(id); const r = rnd();
    if (r < 0.6) j.settle(id, { ok: r < 0.5, status: 200, credits: Math.floor(rnd() * (credits + 1)) }); else if (r < 0.8) j.unresolved(id, 'timeout'); else if (r < 0.9) j.release(id, 'cancelled');
  }
  return { j, clock, ids, records };
}

test('aggregated totals equal the row walk exactly for every provider, at several clocks (day / month boundaries), through every transition', () => {
  const { j, clock, records } = history(3000);
  const rows = j.reservations();
  for (const providerId of ['KRAKEN_SPOT', 'COINBASE_SPOT', 'COINGECKO', 'DEFILLAMA']) for (const nowTs of [clock.t, clock.t + DAY, clock.t - 3 * DAY, Date.UTC(2026, 8, 1, 0, 0, 0), Date.UTC(2026, 7, 31, 23, 59, 59)]) assert.deepEqual(j.totals(providerId, nowTs), walk(rows, providerId, nowTs), `${providerId} @ ${new Date(nowTs).toISOString()}`);
  assert.ok(rows.every((x) => !('dayKey' in x) && !('monthKey' in x)), 'the reservation view carries no cached keys');
  // a replay of the same records rebuilds the same aggregates
  const replayed = replayQuotaRecords(records.map((r) => ({ ...r })), { clock: () => clock.t });
  for (const providerId of ['KRAKEN_SPOT', 'COINBASE_SPOT', 'COINGECKO']) assert.deepEqual(replayed.totals(providerId, clock.t), j.totals(providerId, clock.t));
});

test('totals() no longer scales with the journal: 20,000 reservations, 20,000 reads, well under the walk cost', () => {
  const { j, clock } = history(20_000);
  const t0 = process.hrtime.bigint(); let acc = 0;
  for (let i = 0; i < 20_000; i += 1) acc += j.totals(['KRAKEN_SPOT', 'COINBASE_SPOT', 'COINGECKO'][i % 3], clock.t).calls.month;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(acc > 0); assert.ok(ms < 1500, `20k O(1) reads took ${ms.toFixed(0)} ms (the walk would be 400M row visits)`);
});
