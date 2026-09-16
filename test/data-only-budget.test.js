import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createDataOnlyFetch,
  readDataOnlyBudgetStatus,
  dataOnlyLaneForRequest,
  DEFAULT_DATA_ONLY_LANES,
  createEmptyDataOnlyBudgetState,
  loadDataOnlyBudgetCheckpoint,
} from "../lib/data-only-budget.js";

test("separately journaled discovery is not duplicated in the generic governor", () => {
  assert.equal(dataOnlyLaneForRequest("https://api.gdeltproject.org/api/v2/doc/doc?query=crypto"), null);
  assert.equal(DEFAULT_DATA_ONLY_LANES.GDELT_NEWS_DISCOVERY, undefined);
  assert.equal(dataOnlyLaneForRequest("https://evil.example/gdelt"), null);
});

test("data-only request reservations survive restart and stop at the exact daily cap", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "serpent-data-budget-"));
  const lanes = { TEST: { maxDailyRequests: 2, usdPerRequest: 0 } };
  const laneForRequest = () => "TEST";
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const first = createDataOnlyFetch({
      dataDir: dir,
      lanes,
      laneForRequest,
      fetchImpl: transport,
      clock: () => Date.UTC(2026, 8, 12),
    });
    await first.fetch("https://example.com/a");
    const restarted = createDataOnlyFetch({
      dataDir: dir,
      lanes,
      laneForRequest,
      fetchImpl: transport,
      clock: () => Date.UTC(2026, 8, 12, 1),
    });
    await restarted.fetch("https://example.com/b");
    await assert.rejects(
      () => restarted.fetch("https://example.com/c"),
      /DAILY_CAP_REACHED/,
    );
    assert.equal(calls, 2);
    const state = readDataOnlyBudgetStatus(dir);
    assert.equal(state.lanes.TEST.reserved, 2);
    assert.equal(state.lanes.TEST.succeeded, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero-spend runtime refuses any paid lane before startup", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "serpent-data-budget-"));
  try {
    assert.throws(
      () =>
        createDataOnlyFetch({
          dataDir: dir,
          lanes: { PAID: { maxDailyRequests: 1, usdPerRequest: 0.01 } },
          maxMonthlyUsd: 0,
        }),
      /paid request lane refused/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("separately journaled social hosts are not duplicated while unknown hosts fail closed", () => {
  assert.equal(
    dataOnlyLaneForRequest("https://api.x.com/2/tweets/search/stream"),
    null,
  );
  assert.equal(
    dataOnlyLaneForRequest("https://api.neynar.com/v2/farcaster/cast/search"),
    null,
  );
  assert.equal(
    dataOnlyLaneForRequest("https://example.com/not-approved"),
    null,
  );
  assert.equal(dataOnlyLaneForRequest("http://api.x.com/2/tweets"), null);
  assert.equal(DEFAULT_DATA_ONLY_LANES.X_OFFICIAL, undefined);
  assert.equal(DEFAULT_DATA_ONLY_LANES.FARCASTER_OFFICIAL, undefined);
});

test("deployed twelve-lane checkpoint imports without resetting any counters", () => {
  // LEAN PASS 4a retired the NOAA_SWPC / CLOUDFLARE_RADAR infra lanes.
  const expected = [
    "KRAKEN_PUBLIC_REST", "KRAKEN_STATUS", "COINBASE_STATUS", "OKX_STATUS",
    "KRAKEN_OFFICIAL", "SEC_OFFICIAL", "CFTC_OFFICIAL", "OFAC_OFFICIAL",
    "COINDESK_NEWS", "THEBLOCK_NEWS",
    "COINTELEGRAPH_NEWS", "DECRYPT_NEWS",
  ];
  assert.deepEqual(Object.keys(DEFAULT_DATA_ONLY_LANES), expected);
  const dir = mkdtempSync(path.join(os.tmpdir(), "serpent-data-budget-legacy-"));
  try {
    const state = createEmptyDataOnlyBudgetState({ ts: Date.UTC(2026, 8, 13) });
    state.lanes.KRAKEN_PUBLIC_REST.reserved = 17;
    state.lanes.KRAKEN_PUBLIC_REST.settled = 16;
    state.lanes.KRAKEN_PUBLIC_REST.succeeded = 15;
    state.lanes.KRAKEN_PUBLIC_REST.failed = 1;
    mkdirSync(path.join(dir, "data-only"), { recursive: true });
    writeFileSync(path.join(dir, "data-only", "budget-current.json"), JSON.stringify(state));
    const restored = loadDataOnlyBudgetCheckpoint(dir, { lanes: DEFAULT_DATA_ONLY_LANES, maxMonthlyUsd: 0 });
    assert.deepEqual(restored, state);
    assert.deepEqual(restored.lanes.KRAKEN_PUBLIC_REST, state.lanes.KRAKEN_PUBLIC_REST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable reservation is awaited before wire and a failed settlement latches further dispatch", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "serpent-data-budget-durable-"));
  const lanes = { TEST: { maxDailyRequests: 3, usdPerRequest: 0 } }; let calls = 0; const phases = []; let failSettle = true;
  const restored = createEmptyDataOnlyBudgetState({ ts: Date.UTC(2026, 8, 12), lanes });
  const durableCheckpoint = {
    restored,
    reserve: async (state, meta) => { phases.push([meta.phase, state.lanes.TEST.reserved, calls]); },
    settle: async (state, meta) => { phases.push([meta.phase, state.lanes.TEST.settled, calls]); if (failSettle) throw new Error("db unavailable"); },
  };
  try {
    const governor = createDataOnlyFetch({ dataDir: dir, lanes, laneForRequest: () => "TEST", durableCheckpoint, fetchImpl: async () => { calls += 1; return Response.json({}); }, clock: () => Date.UTC(2026, 8, 12) });
    await assert.rejects(() => governor.fetch("https://example.com/a"), /DATA_ONLY_DURABILITY_FAILED/);
    assert.equal(calls, 1); assert.deepEqual(phases, [["RESERVE", 1, 0], ["SETTLE", 1, 1]]); assert.equal(governor.durability().blocked, true);
    failSettle = false;
    await assert.rejects(() => governor.fetch("https://example.com/b"), /DATA_ONLY_DURABILITY_BLOCKED/);
    assert.equal(calls, 1, "a latched checkpoint sends no later request");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent receipts retain their own ordinals and daily rollover retains monthly spend", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "serpent-data-budget-concurrent-"));
  const lanes = { PAID: { maxDailyRequests: 3, usdPerRequest: 0.01 } }; let now = Date.UTC(2026, 8, 12); let seq = 0; const releases = [];
  const fetchImpl = () => { seq += 1; return new Promise((resolve) => releases.push(() => resolve(Response.json({ seq })))); };
  try {
    const governor = createDataOnlyFetch({ dataDir: dir, lanes, laneForRequest: () => "PAID", maxMonthlyUsd: 0.03, fetchImpl, clock: () => now });
    const a = governor.fetch("https://example.com/a"); const b = governor.fetch("https://example.com/b");
    while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
    releases[1](); releases[0](); await Promise.all([a, b]);
    const receipts = readFileSync(path.join(dir, "data-only", "receipts", "2026-09-12.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(receipts.filter((r) => r.phase === "SETTLED").map((r) => r.ordinal).sort(), [1, 2]);
    now = Date.UTC(2026, 8, 13); const c = governor.fetch("https://example.com/c"); while (releases.length < 3) await new Promise((resolve) => setImmediate(resolve)); releases[2](); await c;
    assert.equal(governor.status().estimatedMonthUsd, 0.03, "a new day in the same month does not refund monthly spend");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("strict commissioning loader distinguishes missing from malformed quota state", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "serpent-data-budget-invalid-"));
  try {
    assert.equal(loadDataOnlyBudgetCheckpoint(dir), null);
    mkdirSync(path.join(dir, "data-only"), { recursive: true }); writeFileSync(path.join(dir, "data-only", "budget-current.json"), JSON.stringify({ v: "serpent-data-only-budget-1", lanes: {} }));
    assert.throws(() => loadDataOnlyBudgetCheckpoint(dir), /checkpoint invalid/);
    assert.throws(() => createDataOnlyFetch({ dataDir: dir }), /checkpoint invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
