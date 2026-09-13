import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createMemoryQuotaJournal, createDispatchGuard } from '../market-lab/quota.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createResearchOwner } from '../market-lab/owner.js';
import { loadPolicy } from '../market-lab/policy.js';
import { startDataOnlyMarket } from '../tools/data-only-market.mjs';
import { T0, tmp, json, btcOnly, cryptoquantPolicy, H } from './helpers/market-closeout.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(fn, timeoutMs = 2000) { const end = Date.now() + timeoutMs; while (!fn()) { if (Date.now() >= end) throw new Error('condition timed out'); await new Promise((r) => setTimeout(r, 2)); } }

// External checkpoint adapters keep a synchronous validated mirror for quota reads and make only mutations asynchronous.
// This fake has that exact contract and lets each test stop at the durable boundary without any provider I/O.
function asyncJournal({ before = {}, clock = () => T0 } = {}) {
  const base = createMemoryQuotaJournal({ clock }); const pending = new Set(); const events = []; let closed = false;
  const wrap = (name, fn) => (...args) => {
    const p = (async () => { events.push(`${name}:start`); await before[name]?.(...args); const value = fn(...args); events.push(`${name}:durable`); return value; })();
    pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p;
  };
  const drained = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  return {
    ...base,
    durable: true,
    files: null,
    loadPlan: wrap('loadPlan', base.loadPlan),
    reserve: wrap('reserve', base.reserve),
    settle: wrap('settle', base.settle),
    unresolved: wrap('unresolved', base.unresolved),
    release: wrap('release', base.release),
    drained,
    close: async () => { await drained(); closed = true; },
    isClosed: () => closed,
    events,
  };
}

const krakenPolicy = () => loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] }));

test('async durable reservation resolves before the first fetch and normal settlement is awaited', async () => {
  const gate = deferred(); const journal = asyncJournal({ before: { reserve: () => gate.promise } }); const order = [];
  const originalReserve = journal.reserve; journal.reserve = async (...args) => { order.push('reserve:start'); const id = await originalReserve(...args); order.push('reserve:durable'); return id; };
  const guard = createDispatchGuard({ policy: krakenPolicy(), journal, clock: () => T0, log: () => {} });
  const http = createHttpTransport({ admission: guard, clock: () => T0, fetchImpl: async () => { order.push('fetch'); return json(H.krakenTicker('XXBTZUSD')); } });
  const pending = http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'XXBTZUSD' } });
  await until(() => order.includes('reserve:start'));
  assert.deepEqual(order, ['reserve:start'], 'wire remains untouched while the durable reservation is pending');
  gate.resolve(); const result = await pending;
  assert.equal(result.ok, true); assert.deepEqual(order, ['reserve:start', 'reserve:durable', 'fetch']);
  assert.equal(journal.reservations()[0].state, 'SETTLED'); assert.equal(guard.snapshot().journal.pendingMutations, 0);
});

test('async included-plan snapshot is durable before reservation and fetch', async () => {
  const gate = deferred(); const journal = asyncJournal({ before: { loadPlan: () => gate.promise } }); let fetches = 0;
  const guard = createDispatchGuard({ policy: cryptoquantPolicy(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, journal, clock: () => T0, log: () => {} });
  const http = createHttpTransport({ admission: guard, clock: () => T0, fetchImpl: async () => { fetches += 1; return json({ status: { code: 0 }, result: { data: [] } }); } });
  const pending = http.request({ providerId: 'CRYPTOQUANT', endpointId: 'exchange-flows', pathParams: { asset: 'btc', metric: 'reserve' }, query: { window: 'day', exchange: 'all_exchange', from: 1, to: 2, limit: 10 }, credential: 'offline-fixture' });
  await until(() => journal.events.includes('loadPlan:start')); assert.equal(fetches, 0);
  gate.resolve(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(fetches, 1);
  assert.deepEqual(journal.events.slice(0, 6), ['loadPlan:start', 'loadPlan:durable', 'reserve:start', 'reserve:durable', 'settle:start', 'settle:durable']);
});

test('an async settlement rejection returns ACCOUNTING_FAILED, keeps conservative spend, and latches later admission closed', async () => {
  let fetches = 0; const journal = asyncJournal({ before: { settle: () => { throw Object.assign(new Error('checkpoint CAS failed'), { code: 'CAS_CONFLICT' }); } } });
  const guard = createDispatchGuard({ policy: krakenPolicy(), journal, clock: () => T0, log: () => {} });
  const http = createHttpTransport({ admission: guard, clock: () => T0, fetchImpl: async () => { fetches += 1; return json(H.krakenTicker('XXBTZUSD')); } });
  const first = await http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'XXBTZUSD' } });
  assert.equal(first.failure.kind, 'ACCOUNTING_FAILED'); assert.equal(fetches, 1);
  assert.equal(journal.reservations()[0].state, 'RESERVED', 'an uncertain terminal mutation never refunds the reservation');
  assert.equal(guard.accountingFailure().code, 'CAS_CONFLICT');
  const second = await http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'XETHZUSD' } });
  assert.equal(second.failure.kind, 'QUOTA_REFUSED'); assert.ok(second.failure.reasons.includes('ACCOUNTING_UNAVAILABLE')); assert.equal(fetches, 1, 'the latch prevents a second wire call');
});

test('owner shutdown awaits async UNRESOLVED fencing after its bounded wire drain, without closing an injected journal', async () => {
  const unresolvedGate = deferred(); let blockUnresolved = false; const journal = asyncJournal({ before: { unresolved: () => blockUnresolved ? unresolvedGate.promise : undefined } });
  const tickerStarted = deferred(); const tickerResponse = deferred();
  const owner = createResearchOwner({
    policy: krakenPolicy(), subjects: btcOnly(), quotaJournal: journal, mode: 'INTEGRATED', closeDrainMs: 1, clock: () => T0, log: () => {},
    fetchImpl: async (input) => { const u = new URL(input); if (u.pathname.endsWith('/AssetPairs')) return json(H.KRAKEN_ASSET_PAIRS); tickerStarted.resolve(); return tickerResponse.promise; },
  });
  await owner.start({ families: [] }); const market = owner.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market;
  blockUnresolved = true; const request = owner.clients.KRAKEN_SPOT.ticker({ markets: [market] }); await tickerStarted.promise;
  let stopped = false; const stopping = owner.stop({ seal: false }).then((value) => { stopped = true; return value; });
  await until(() => journal.events.filter((x) => x === 'unresolved:start').length > 0);
  assert.equal(stopped, false, 'shutdown cannot release accounting ownership while the fence transition is pending');
  unresolvedGate.resolve(); const result = await stopping;
  assert.equal(result.drain.outcome, 'TIMEOUT'); assert.equal(result.drain.fencedRequests.length, 1);
  assert.equal(journal.reservations().at(-1).state, 'UNRESOLVED'); assert.equal(journal.isClosed(), false, 'the caller retains ownership of an injected journal');
  tickerResponse.resolve(json(H.krakenTicker('XXBTZUSD'))); const late = await request; assert.equal(late.ok, false, 'late bytes have no mutation authority after the fence');
});

test('data-only market accepts the injected durable journal and exposes honest stream/accounting status', async () => {
  const root = tmp('data-only-async-quota-'); const journal = asyncJournal(); let handle = null;
  const rawSubjects = H.subjectsWith(); rawSubjects.subjects = [rawSubjects.subjects[0]]; rawSubjects.macroSeries = []; rawSubjects.crossAsset = []; rawSubjects.stablecoins = [];
  try {
    handle = await startDataOnlyMarket({ researchRoot: root, env: {}, quotaJournal: journal, ownerMode: 'INTEGRATED', families: [], clock: () => T0, policyRaw: H.policyWith({ providers: ['KRAKEN_SPOT'] }), subjectsRaw: rawSubjects, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), log: () => {} });
    const status = handle.status(); assert.equal(status.persistence.quotaJournal, 'INJECTED_DURABLE'); assert.equal(status.persistence.replitRepublish, 'JOURNAL_ADAPTER_DEFINED'); assert.deepEqual(status.streams, {});
    await handle.stop({ seal: false }); assert.equal(journal.isClosed(), false);
  } finally { if (handle?.status().running) await handle.stop({ seal: false }); rmSync(root, { recursive: true, force: true }); }
});
