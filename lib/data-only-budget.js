// DATA-ONLY request governor. Every permitted HTTP request is durably
// reserved before it reaches the wire, so a crash/restart can only consume
// budget conservatively; it can never erase a request. Provider-metered
// reads require their own durable unit/cost caps in addition to this governor.
import path from "node:path";
import { existsSync } from "node:fs";
import { appendJsonl, atomicWriteJson, readJsonBounded } from "./jsonl.js";

export const DATA_ONLY_BUDGET_VERSION = "serpent-data-only-budget-1";
export const DEFAULT_DATA_ONLY_LANES = Object.freeze({
  KRAKEN_PUBLIC_REST: Object.freeze({
    maxDailyRequests: 2_200,
    usdPerRequest: 0,
  }),
  KRAKEN_STATUS: Object.freeze({ maxDailyRequests: 300, usdPerRequest: 0 }),
  COINBASE_STATUS: Object.freeze({ maxDailyRequests: 300, usdPerRequest: 0 }),
  OKX_STATUS: Object.freeze({ maxDailyRequests: 300, usdPerRequest: 0 }),
  KRAKEN_OFFICIAL: Object.freeze({ maxDailyRequests: 1_500, usdPerRequest: 0 }),
  SEC_OFFICIAL: Object.freeze({ maxDailyRequests: 1_080, usdPerRequest: 0 }),
  CFTC_OFFICIAL: Object.freeze({ maxDailyRequests: 1_080, usdPerRequest: 0 }),
  OFAC_OFFICIAL: Object.freeze({ maxDailyRequests: 96, usdPerRequest: 0 }),
  COINDESK_NEWS: Object.freeze({ maxDailyRequests: 150, usdPerRequest: 0 }),
  THEBLOCK_NEWS: Object.freeze({ maxDailyRequests: 150, usdPerRequest: 0 }),
  COINTELEGRAPH_NEWS: Object.freeze({
    maxDailyRequests: 150,
    usdPerRequest: 0,
  }),
  DECRYPT_NEWS: Object.freeze({ maxDailyRequests: 150, usdPerRequest: 0 }),
});

const HOST_LANES = Object.freeze({
  "api.kraken.com": "KRAKEN_PUBLIC_REST",
  "status.kraken.com": "KRAKEN_STATUS",
  "status.coinbase.com": "COINBASE_STATUS",
  "www.okx.com": "OKX_STATUS",
  "blog.kraken.com": "KRAKEN_OFFICIAL",
  "www.sec.gov": "SEC_OFFICIAL",
  "www.cftc.gov": "CFTC_OFFICIAL",
  "sanctionslistservice.ofac.treas.gov": "OFAC_OFFICIAL",
  "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com":
    "OFAC_OFFICIAL",
  "www.coindesk.com": "COINDESK_NEWS",
  "www.theblock.co": "THEBLOCK_NEWS",
  "cointelegraph.com": "COINTELEGRAPH_NEWS",
  "decrypt.co": "DECRYPT_NEWS",
});

const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const utcMonth = (ts) => new Date(ts).toISOString().slice(0, 7);
const bounded = (value) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
const requestUrl = (input) =>
  typeof input === "string" || input instanceof URL
    ? new URL(input)
    : new URL(input.url);

export function dataOnlyLaneForRequest(input) {
  const url = requestUrl(input);
  if (url.protocol !== "https:") return null;
  return HOST_LANES[url.hostname] ?? null;
}

function blankState(ts, lanes, maxMonthlyUsd) {
  return {
    v: DATA_ONLY_BUDGET_VERSION,
    day: utcDay(ts),
    month: utcMonth(ts),
    maxMonthlyUsd,
    estimatedMonthUsd: 0,
    lanes: Object.fromEntries(
      Object.entries(lanes).map(([id, lane]) => [
        id,
        {
          maxDailyRequests: lane.maxDailyRequests,
          usdPerRequest: lane.usdPerRequest,
          reserved: 0,
          settled: 0,
          succeeded: 0,
          failed: 0,
          lastRequestTs: null,
          lastReceiptTs: null,
          lastHttpStatus: null,
          lastError: null,
        },
      ]),
    ),
  };
}

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const timestamp = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const validDay = (value) => { if (!/^\d{4}-\d\d-\d\d$/.test(value)) return false; const ts = Date.parse(`${value}T00:00:00.000Z`); return Number.isFinite(ts) && new Date(ts).toISOString().slice(0, 10) === value; };

export function dataOnlyBudgetStateError(state, { lanes = null, maxMonthlyUsd = null } = {}) {
  if (!plainObject(state) || state.v !== DATA_ONLY_BUDGET_VERSION) return "budget checkpoint version/shape invalid";
  if (!validDay(state.day) || !/^\d{4}-\d\d$/.test(state.month) || state.day.slice(0, 7) !== state.month) return "budget checkpoint accounting period invalid";
  if (!Number.isFinite(state.maxMonthlyUsd) || state.maxMonthlyUsd < 0 || !Number.isFinite(state.estimatedMonthUsd) || state.estimatedMonthUsd < 0 || state.estimatedMonthUsd > state.maxMonthlyUsd) return "budget checkpoint monthly amount invalid";
  if (maxMonthlyUsd !== null && state.maxMonthlyUsd !== maxMonthlyUsd) return "budget checkpoint monthly cap differs from configured law";
  if (!plainObject(state.lanes) || Object.keys(state.lanes).length < 1 || Object.keys(state.lanes).length > 128) return "budget checkpoint lane inventory invalid";
  if (lanes && !exactKeys(state.lanes, Object.keys(lanes))) return "budget checkpoint lane inventory differs from configured law";
  for (const [id, lane] of Object.entries(state.lanes)) {
    if (!/^[A-Z0-9_]{1,64}$/.test(id) || !plainObject(lane)) return `${id}: budget lane invalid`;
    if (!Number.isSafeInteger(lane.maxDailyRequests) || lane.maxDailyRequests < 1 || !Number.isFinite(lane.usdPerRequest) || lane.usdPerRequest < 0) return `${id}: budget lane limits invalid`;
    if (lanes && (lane.maxDailyRequests !== lanes[id].maxDailyRequests || lane.usdPerRequest !== lanes[id].usdPerRequest)) return `${id}: budget lane law differs from configuration`;
    for (const field of ["reserved", "settled", "succeeded", "failed"]) if (!count(lane[field])) return `${id}: ${field} invalid`;
    if (lane.settled > lane.reserved || lane.succeeded + lane.failed !== lane.settled) return `${id}: budget settlement counters inconsistent`;
    for (const field of ["lastRequestTs", "lastReceiptTs"]) if (!timestamp(lane[field])) return `${id}: ${field} invalid`;
    if (!(lane.lastHttpStatus === null || (Number.isSafeInteger(lane.lastHttpStatus) && lane.lastHttpStatus >= 100 && lane.lastHttpStatus <= 999))) return `${id}: lastHttpStatus invalid`;
    if (!(lane.lastError === null || (typeof lane.lastError === "string" && lane.lastError.length <= 180))) return `${id}: lastError invalid`;
  }
  return null;
}

export const validateDataOnlyBudgetState = (state, options = {}) => {
  const error = dataOnlyBudgetStateError(state, options);
  return error ? { ok: false, errors: [error] } : { ok: true, errors: [] };
};

export const createEmptyDataOnlyBudgetState = ({ ts, lanes = DEFAULT_DATA_ONLY_LANES, maxMonthlyUsd = 0 } = {}) => {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new Error("empty budget checkpoint requires an explicit timestamp");
  const state = blankState(ts, lanes, maxMonthlyUsd);
  const error = dataOnlyBudgetStateError(state, { lanes, maxMonthlyUsd });
  if (error) throw new Error(error);
  return state;
};

export function loadDataOnlyBudgetCheckpoint(dataDir, { lanes = null, maxMonthlyUsd = null } = {}) {
  const file = path.join(dataDir, "data-only", "budget-current.json");
  if (!existsSync(file)) return null;
  const state = readJsonBounded(file, 2 * 1024 * 1024);
  const error = dataOnlyBudgetStateError(state, { lanes, maxMonthlyUsd });
  if (error) throw new Error(`data-only budget checkpoint invalid: ${error}`);
  return state;
}

export function readDataOnlyBudgetStatus(dataDir) {
  try {
    return loadDataOnlyBudgetCheckpoint(dataDir);
  } catch {
    return null;
  }
}

export function createDataOnlyFetch({
  dataDir,
  fetchImpl = fetch,
  lanes = DEFAULT_DATA_ONLY_LANES,
  laneForRequest = dataOnlyLaneForRequest,
  clock = () => Date.now(),
  maxMonthlyUsd = 0,
  durableCheckpoint = null,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.length)
    throw new Error("data-only budget requires dataDir");
  if (!Number.isFinite(maxMonthlyUsd) || maxMonthlyUsd < 0)
    throw new Error("invalid data-only monthly USD cap");
  for (const [id, lane] of Object.entries(lanes)) {
    if (
      !Number.isSafeInteger(lane.maxDailyRequests) ||
      lane.maxDailyRequests < 1
    )
      throw new Error(`${id}: invalid daily request cap`);
    if (!Number.isFinite(lane.usdPerRequest) || lane.usdPerRequest < 0)
      throw new Error(`${id}: invalid request price`);
    if (lane.usdPerRequest > 0 && maxMonthlyUsd === 0)
      throw new Error(
        `${id}: paid request lane refused by zero-spend data-only policy`,
      );
  }
  const root = path.join(dataDir, "data-only");
  const stateFile = path.join(root, "budget-current.json");
  const durable = durableCheckpoint !== null;
  if (durable && (!plainObject(durableCheckpoint) || durableCheckpoint.restored === undefined || typeof durableCheckpoint.reserve !== "function" || typeof durableCheckpoint.settle !== "function")) throw new Error("data-only durable checkpoint requires restored state plus reserve and settle callbacks");
  let state = durable
    ? structuredClone(durableCheckpoint.restored)
    : (loadDataOnlyBudgetCheckpoint(dataDir, { lanes, maxMonthlyUsd }) ?? blankState(clock(), lanes, maxMonthlyUsd));
  const initialError = dataOnlyBudgetStateError(state, { lanes, maxMonthlyUsd });
  if (initialError) throw new Error(`data-only budget checkpoint invalid: ${initialError}`);
  let mutationTail = Promise.resolve();
  let durabilityFailure = null;

  const roll = (prior, ts) => {
    const day = utcDay(ts); const month = utcMonth(ts);
    if (day <= prior.day) return prior; // clock rollback never regains allowance
    const next = blankState(ts, lanes, maxMonthlyUsd);
    if (month === prior.month) next.estimatedMonthUsd = prior.estimatedMonthUsd;
    return next;
  };
  const persist = (next) =>
    atomicWriteJson(stateFile, next, {
      pretty: true,
      sync: process.platform !== "win32",
    });
  persist(state);

  const enqueueMutation = (phase, meta, mutate) => {
    const operation = mutationTail.then(async () => {
      if (durabilityFailure) throw new Error(`DATA_ONLY_DURABILITY_BLOCKED: ${durabilityFailure}`);
      let next = phase === "reserve" ? roll(structuredClone(state), meta.ts) : structuredClone(state);
      const result = mutate(next);
      const checkpointError = dataOnlyBudgetStateError(next, { lanes, maxMonthlyUsd });
      if (checkpointError) throw new Error(`DATA_ONLY_CHECKPOINT_INVALID: ${checkpointError}`);
      if (durable) {
        try { await durableCheckpoint[phase](structuredClone(next), Object.freeze({ ...meta, phase: phase.toUpperCase() })); }
        catch (cause) {
          // PUBLISH-FIX-1: carry the checkpoint error's MESSAGE (it now names the underlying code + attempt count, e.g.
          // "CHECKPOINT_WRITE_FAILED: ETIMEDOUT after 3 attempt(s)") so the sweep-failed log shows what actually failed,
          // not just the generic category.
          durabilityFailure = bounded(cause?.message ?? cause?.code ?? cause) || "checkpoint write failed";
          throw new Error(`DATA_ONLY_DURABILITY_FAILED: ${durabilityFailure}`);
        }
      }
      try { persist(next); }
      catch (cause) {
        durabilityFailure = bounded(cause?.code ?? cause?.message ?? cause) || "checkpoint mirror failed";
        throw new Error(`DATA_ONLY_DURABILITY_FAILED: ${durabilityFailure}`);
      }
      state = next;
      return result;
    });
    mutationTail = operation.catch(() => {});
    return operation;
  };

  async function budgetedFetch(input, init) {
    const laneId = laneForRequest(input, init);
    const laneCfg = laneId ? lanes[laneId] : null;
    if (!laneCfg)
      throw new Error(
        `DATA_ONLY_UNBUDGETED_REQUEST_BLOCKED: ${bounded(requestUrl(input).hostname)}`,
      );
    const requestedTs = clock();
    const reservation = await enqueueMutation("reserve", { lane: laneId, ts: requestedTs }, (draft) => {
      const lane = draft.lanes[laneId];
      if (!lane) throw new Error(`DATA_ONLY_UNKNOWN_BUDGET_LANE: ${laneId}`);
      if (lane.reserved >= lane.maxDailyRequests) throw new Error(`DATA_ONLY_DAILY_CAP_REACHED: ${laneId} ${lane.reserved}/${lane.maxDailyRequests}`);
      const projectedUsd = draft.estimatedMonthUsd + lane.usdPerRequest;
      if (projectedUsd > draft.maxMonthlyUsd) throw new Error(`DATA_ONLY_MONTHLY_USD_CAP_REACHED: ${projectedUsd}/${draft.maxMonthlyUsd}`);
      lane.reserved += 1; lane.lastRequestTs = requestedTs; draft.estimatedMonthUsd = projectedUsd;
      return { day: draft.day, ordinal: lane.reserved };
    });
    const receiptFile = path.join(root, "receipts", `${reservation.day}.jsonl`);
    appendJsonl(receiptFile, { v: DATA_ONLY_BUDGET_VERSION, phase: "RESERVED", lane: laneId, ordinal: reservation.ordinal, requestedTs }, { sync: true });

    const settle = async (response, transportError = null) => {
      const receiptTs = clock(); const status = Number.isSafeInteger(response?.status) ? response.status : null;
      const ok = status !== null && status >= 200 && status < 400;
      await enqueueMutation("settle", { lane: laneId, ordinal: reservation.ordinal, ts: receiptTs }, (draft) => {
        // A request may finish after a later request has durably opened a new
        // UTC bucket. The old reservation stays conservatively charged in its
        // old bucket; never attribute its settlement to the new day's totals.
        if (draft.day !== reservation.day) return;
        const lane = draft.lanes[laneId]; lane.settled += 1; lane.lastReceiptTs = receiptTs; lane.lastHttpStatus = status;
        if (ok) { lane.succeeded += 1; lane.lastError = null; }
        else { lane.failed += 1; lane.lastError = transportError ? bounded(transportError?.message ?? transportError) : `HTTP ${response?.status ?? "UNKNOWN"}`; }
      });
      appendJsonl(receiptFile, { v: DATA_ONLY_BUDGET_VERSION, phase: "SETTLED", lane: laneId, ordinal: reservation.ordinal, requestedTs, receiptTs, httpStatus: status, ok, ...(transportError ? { error: bounded(transportError?.message ?? transportError) } : {}) }, { sync: true });
    };

    let response;
    try { response = await fetchImpl(input, init); }
    catch (error) { await settle(null, error); throw error; }
    await settle(response);
    return response;
  }

  return Object.freeze({
    fetch: budgetedFetch,
    status: () => JSON.parse(JSON.stringify(state)),
    durability: () => Object.freeze({ configured: durable, blocked: durabilityFailure !== null, failure: durabilityFailure }),
    file: stateFile,
  });
}
