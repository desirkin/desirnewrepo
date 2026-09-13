import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXUsage, xUsageUrl } from '../rumor2/providers/x-official.js';
import { createXRuntime } from '../rumor2/x-runtime.js';
import { xMeterEvent } from '../rumor2/social-settle.js';

const T = Date.parse('2026-09-13T12:00:00.000Z');
const DAY = '2026-09-13';
const MONTH = '2026-09';
const cfg = (over = {}) => ({
  enabled: true, bearer: 'fixture', maxDailyPostReads: 100,
  maxMonthlyPostReads: 3000, maxEstimatedDailyUsd: 10,
  maxSessionPostReads: 100, liveSmokeTargetPostReads: null,
  liveSmokeMaxPostReads: null, liveSmokeRunId: null,
  priorityAccounts: [], propagationFocus: [], ...over,
});

function fakeX(serverDay) {
  const rules = []; let nextId = 1; let streamController = null;
  const res = (status, json = null, body = null) => ({ status, json: async () => json, body });
  return async (raw, init = {}) => {
    const url = new URL(raw);
    if (url.pathname === '/2/usage/tweets') return res(200, { data: { project_usage: String(serverDay), project_cap: '3000', cap_reset_day: 1, daily_project_usage: { project_id: 'fixture', usage: [{ date: `${DAY}T12:00:00.000Z`, usage: String(serverDay) }] } } });
    if (url.pathname === '/2/usage/credits') return res(200, { data: { free_balance: 0, prepaid_balance: 10, total_balance: 10 } });
    if (url.pathname.endsWith('/rules/counts')) return res(404);
    if (url.pathname.endsWith('/rules')) {
      if ((init.method ?? 'GET') === 'GET') return res(200, { data: rules.map((r) => ({ ...r })) });
      const body = JSON.parse(init.body);
      if (url.searchParams.get('dry_run') === 'true') return res(200, { meta: { summary: { valid: (body.add ?? []).length, invalid: 0 } } });
      if (body.add) { for (const rule of body.add) rules.push({ ...rule, id: String(nextId++) }); return res(201, {}); }
      if (body.delete) { for (const id of body.delete.ids) { const at = rules.findIndex((r) => r.id === id); if (at >= 0) rules.splice(at, 1); } return res(200, {}); }
    }
    if (url.pathname === '/2/tweets/search/stream') {
      const body = new ReadableStream({ start(controller) { streamController = controller; } });
      init.signal?.addEventListener('abort', () => { try { streamController?.error(new Error('stopped')); } catch {} });
      return res(200, null, body);
    }
    return res(404);
  };
}

function hydratedRuntime({ nowTs = T, localDay = 10, localMonth = 100, serverDay = 60, serverMonth = 200, observedTs = T, config = cfg() } = {}) {
  const rt = createXRuntime({ config, universe: ['BTC'], now: () => nowTs });
  const ev = xMeterEvent({
    provider: 'X_OFFICIAL', period: new Date(observedTs).toISOString().slice(0, 10),
    deliveredPostReads: localDay, monthPeriod: new Date(observedTs).toISOString().slice(0, 7),
    monthDeliveredPostReads: localMonth, unitPriceUsd: 0.005,
    serverUsage: { projectUsage: serverMonth, projectCap: 3_000_000, capResetDay: 1, dailyProjectUsage: serverDay, observedTs },
    knownAtTs: observedTs,
  });
  assert.equal(rt.hydrate([ev]).ok, true);
  return rt;
}
const hydratedAllowance = (options) => hydratedRuntime(options).allowance();

test('X usage request explicitly asks for the two-day UTC breakdown and required fields', () => {
  const url = new URL(xUsageUrl());
  assert.equal(url.searchParams.get('days'), '2');
  assert.deepEqual(url.searchParams.get('usage.fields').split(','), ['cap_reset_day', 'daily_project_usage', 'project_cap', 'project_usage']);
});

test('X usage parser accepts only documented daily-project variants and selects the observed UTC day', () => {
  const common = { project_usage: '200', project_cap: '3000', cap_reset_day: 1 };
  const objectShape = parseXUsage({ data: { ...common, daily_project_usage: { project_id: 1, usage: [
    { date: '2026-09-12T23:59:59.000Z', usage: '90' }, { date: '2026-09-13T12:00:00.000Z', usage: '60' },
  ] } } }, { observedTs: T });
  assert.equal(objectShape.dailyProjectUsage, 60);
  const arrayShape = parseXUsage({ data: { ...common, daily_project_usage: [
    { date: DAY, usage: [{ app_id: 'a', tweets_consumed: '20' }, { app_id: 'b', tweets_consumed: 40 }] },
  ] } }, { observedTs: T });
  assert.equal(arrayShape.dailyProjectUsage, 60);

  for (const daily_project_usage of [
    [],
    { project_id: 1, usage: [{ date: '2026-09-12T12:00:00.000Z', usage: 60 }] },
    { project_id: 1, usage: [{ date: '2026-02-30T12:00:00.000Z', usage: 60 }] },
    { project_id: 1, usage: [{ date: `${DAY}T01:00:00.000Z`, usage: 1 }, { date: `${DAY}T02:00:00.000Z`, usage: 2 }] },
    [{ date: DAY, usage: [] }],
    [{ date: DAY, usage: [{ app_id: 'a', tweets_consumed: 1 }, { app_id: 'a', tweets_consumed: 2 }] }],
  ]) assert.equal(parseXUsage({ data: { ...common, daily_project_usage } }, { observedTs: T }), null);
  assert.equal(parseXUsage({ data: { ...common, daily_project_usage: { project_id: 1, usage: [{ date: `${DAY}T12:00:00.000Z`, usage: 0 }] } } }, { observedTs: Number.MAX_SAFE_INTEGER }), null);
});

test('server and local usage are unioned for both Post and USD allowance because overlap is unproven', () => {
  const daily = hydratedAllowance();
  assert.deepEqual({ ok: daily.ok, remaining: daily.remaining, usable: daily.usable, limiting: daily.limiting },
    { ok: true, remaining: 30, usable: 5, limiting: 'BUDGET_DAILY' });
  const usd = hydratedAllowance({ config: cfg({ maxDailyPostReads: 1000, maxEstimatedDailyUsd: 0.50 }) });
  assert.deepEqual({ ok: usd.ok, remaining: usd.remaining, usable: usd.usable, limiting: usd.limiting },
    { ok: true, remaining: 30, usable: 5, limiting: 'BUDGET_USD' });
});

test('local usage greater than server usage is still unioned rather than assuming either side overlaps', () => {
  const result = hydratedAllowance({ localDay: 70, localMonth: 100, serverDay: 20, serverMonth: 100 });
  assert.deepEqual({ ok: result.ok, reason: result.reason, remaining: result.remaining, limiting: result.limiting },
    { ok: false, reason: 'BUDGET_DAILY', remaining: 10, limiting: 'BUDGET_DAILY' });
});

test('snapshot 60 then ten local reads stays 70 across hydration; refresh and later reads remain additive', () => {
  const afterTen = hydratedAllowance({ localDay: 10, localMonth: 10, serverDay: 60, serverMonth: 60 });
  assert.equal(afterTen.remaining, 30, '60 server + 10 local, including after restart/hydration');
  const refreshed = hydratedAllowance({ localDay: 10, localMonth: 10, serverDay: 70, serverMonth: 70 });
  assert.equal(refreshed.remaining, 20, 'a refreshed 70 remains unioned with the durable local 10');
  const fiveLater = hydratedAllowance({ localDay: 15, localMonth: 15, serverDay: 70, serverMonth: 70, config: cfg({ maxDailyPostReads: 120 }) });
  assert.equal(fiveLater.remaining, 35, 'each later local read consumes allowance even while the snapshot is unchanged');
  const monthly = hydratedAllowance({ localDay: 10, localMonth: 25, serverDay: 0, serverMonth: 900, config: cfg({ maxDailyPostReads: 1000, maxMonthlyPostReads: 1000, maxEstimatedDailyUsd: 10 }) });
  assert.equal(monthly.remaining, 75); assert.equal(monthly.limiting, 'BUDGET_MONTHLY');
  assert.deepEqual(hydratedRuntime({ localDay: 10, localMonth: 10, serverDay: 60, serverMonth: 60 }).status().budget.conservativeEstimate,
    { basis: 'SERVER_PLUS_LOCAL_NO_OVERLAP_ASSUMED', dayPostReads: 70, monthPostReads: 70, dayUsd: 0.35, providerInvoice: false });
});

test('a live fake snapshot is consumed by each later local read, survives settlement/restart, and unions a refresh', async () => {
  const config = cfg({ maxDailyPostReads: 120 }); const journal = [];
  const rt = createXRuntime({ config, universe: ['BTC'], now: () => T, fetchImpl: fakeX(60) });
  assert.equal(rt.hydrate([]).ok, true); assert.equal((await rt.start()).ok, true);
  assert.equal(rt.allowance().remaining, 60);
  for (let i = 1; i <= 10; i++) rt._feedLine({ data: { id: String(i), text: 'irrelevant', author_id: '1', created_at: `${DAY}T11:59:00.000Z`, edit_history_tweet_ids: [String(i)], conversation_id: String(i) }, matching_rules: [] }, T + i);
  assert.equal(rt.allowance().remaining, 50, 'server 60 + ten local reads');
  const settled = await rt.settle({ append: async (events) => { journal.push(...events); return { ok: true, lastSeq: journal.length }; } });
  assert.equal(settled.ok, true); rt.stop('fixture stop');

  const restored = createXRuntime({ config, universe: ['BTC'], now: () => T + 100, fetchImpl: fakeX(70) });
  assert.equal(restored.hydrate(journal).ok, true);
  assert.equal(restored.allowance().remaining, 50, 'the 60+10 conservative estimate survives hydration');
  assert.equal((await restored.preflight()).ok, true);
  assert.equal(restored.allowance().remaining, 40, 'the refreshed 70 is still unioned with durable local 10');
});

test('a fresh-by-age server snapshot from the prior UTC day cannot authorize today', () => {
  const observedTs = Date.parse('2026-09-13T23:59:00.000Z');
  const nowTs = Date.parse('2026-09-14T00:01:00.000Z');
  const result = hydratedAllowance({ nowTs, observedTs, localDay: 5, localMonth: 100, serverDay: 20, serverMonth: 100 });
  assert.deepEqual(result, { ok: false, reason: 'USAGE_PREFLIGHT_FAILED', detail: 'server daily usage snapshot is from a different UTC day', remaining: 0 });
});

test('a server plus local estimate that exceeds safe-integer arithmetic fails closed', () => {
  const result = hydratedAllowance({ localDay: 1, localMonth: 1, serverDay: Number.MAX_SAFE_INTEGER, serverMonth: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(result, { ok: false, reason: 'USAGE_PREFLIGHT_FAILED', detail: 'conservative server + local usage estimate overflowed', remaining: 0 });
});
