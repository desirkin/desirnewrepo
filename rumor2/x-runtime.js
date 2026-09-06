// SOCIAL-2B — the X operational runtime: the HARD fail-closed cost governor,
// usage/credit preflight, Serpent-owned rule reconciliation, and the durable
// evidence + meter + progress settlement law. It lives INSIDE the single-writer
// RUMOR collector's authority domain exactly like the Bluesky runtime: the
// collector hydrates it from the authoritative journal, starts it only under a
// held writer fence, drives one settle per tick, and stops it on any loss of
// authority. ONE writer, ONE epoch, ONE PostgreSQL event root — no X store,
// journal, lock, or trading channel.
//
// DEFAULT COST IS ZERO: X is OFF unless RUMOR2_SOCIAL_X_ENABLED=true AND a
// bearer AND an explicit hard daily/monthly read budget AND an estimated-dollar
// cap are configured; zero/invalid/absurd budgets fail closed. No default paid
// budget exists anywhere in this file.
//
// BILL AT THE WIRE: every delivered Post resource increments the local
// conservative meter BEFORE universe/duplicate/durable filtering; keepalives
// cost nothing; backfill/duplicate deliveries are counted every time because
// X's UTC-day billing dedupe is a SOFT guarantee that safety never relies on.
//
// HEADROOM: the stream stops BEFORE the remaining allowance reaches zero,
// reserving X_IN_FLIGHT_POST_HEADROOM Posts for what the server may already have
// buffered. The reserve is pinned in code and shown in status — never hidden.
//
// PAID-WIRE SAFETY SEAL:
//   * SMOKE TARGET vs MAX: RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS is the
//     delivered count at which a controlled smoke shutdown begins;
//     RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS is the operator's OUTER envelope
//     INCLUDING the in-flight reserve. TARGET + HEADROOM <= MAX is required; one
//     without the other is SMOKE_BUDGET_INCOMPLETE; too small is
//     SMOKE_BUDGET_TOO_SMALL. An entered value is never reinterpreted.
//   * CHUNK-ATOMIC STOP: a budget stop decided inside a received network chunk is
//     STOP_PENDING until that chunk's last complete line is processed — every
//     Post X already delivered is metered and offered to intake — then the gap
//     starts at the chunk's last receipt and the transport closes before any
//     further read. A reserve overrun in that final chunk is recorded exactly
//     (SMOKE_HEADROOM_OVERRUN), never clamped, and latches: no automatic paid
//     reconnect — a fresh operator-authorized runtime is required.
//   * UNOWNED RULES: a canonical {id,value,tag} snapshot of every non-Serpent
//     rule is taken before mutation and required deep-equal after; a change is
//     UNOWNED_RULESET_CHANGED_DURING_RECONCILE => no paid stream, never repaired.
//
// DURABLE PAID-SMOKE AUTHORIZATION SEAL: a paid smoke is a specific
// OPERATOR-AUTHORIZED RUN, never numbers sitting in the environment. It needs
// an explicit RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID (never generated here — a
// restart is not a new authorization). The run's ACTIVE state and its durable
// baseline (daily/monthly meter + fresh server project usage at activation) are
// appended to the journal under the writer fence BEFORE the paid stream opens
// (two-phase: start() => SMOKE_ACTIVATION_PENDING, settle() commits, the next
// start() connects). The per-run count is durable arithmetic —
// max(meter delta since baseline, server usage delta since baseline) — never the
// process-local session counter, so a crash resumes only the REMAINING envelope.
// COMPLETE / HEADROOM_OVERRUN / ABORTED settle durably with the final evidence,
// meter, progress, and gap; a terminal run never reconnects, and a new paid
// smoke requires a NEW explicit run ID. The same run ID with different
// TARGET/MAX/headroom, a changed rule-set hash, a changed pinned price, a UTC-day
// rollover, or a server usage reset all fail closed.
import { createHash } from 'node:crypto';
import { buildSocialFilter, canonicalIngressTags } from './social.js';
import { socialIntake } from './social-stream.js';
import {
  socialObservationToEvent, validateSocialEvent, replaySocialHistory, emptyXState,
  xRuleSetEvent, xMeterEvent, xProgressEvent, xGapEvent, xSmokeEvent, SOCIAL_EVENT_TYPE, X_SMOKE_RUN_ID_RE,
} from './social-settle.js';
import { startXStream } from './x-stream.js';
import {
  X_OFFICIAL, xPostToRaw, xStreamUrl, xRulesUrl, xRulesCountsUrl, xUsageUrl, xCreditsUrl,
  compileXRuleManifest, validateXRuleManifest, isSerpentTag, xLaneOfTag, parseXUsage, parseXCredits,
} from './providers/x-official.js';

export const X_IN_FLIGHT_POST_HEADROOM = 25; // Posts reserved for server-side buffered delivery
export const X_SAFE_GAP_MS = 4 * 60_000; // unexplained gap <= 4 min => backfill_minutes=5
export const X_BACKFILL_MINUTES = 5;
export const X_USAGE_MAX_AGE_MS = 6 * 3_600_000; // a server usage snapshot older than this is stale => no paid stream
export const X_RUNTIME_STATES = Object.freeze(['DARK', 'HYDRATED', 'PREFLIGHT', 'ACTIVE', 'STANDBY', 'BUDGET_STOPPED', 'SMOKE_ACTIVATING', 'SMOKE_COMPLETE', 'SMOKE_HEADROOM_OVERRUN', 'SMOKE_ABORTED', 'WITHHELD_GAP', 'WITHHELD']);
export const X_SMOKE_STOP_REASONS = Object.freeze(['SMOKE_TARGET_REACHED', 'SMOKE_HEADROOM_OVERRUN', 'BUDGET_SMOKE_MAX']);

// Canonical closed snapshot of the rules Serpent does NOT own: { id, value, tag }
// sorted by id, then value, then tag. Deep equality — never count equality —
// is what proves an external rule survived reconciliation unchanged.
export function canonicalUnownedRules(rules) {
  const str = (v) => (typeof v === 'string' ? v : null);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return (Array.isArray(rules) ? rules : [])
    .map((r) => ({ id: str(r?.id), value: str(r?.value), tag: str(r?.tag) }))
    .sort((a, b) => cmp(String(a.id), String(b.id)) || cmp(String(a.value), String(b.value)) || cmp(String(a.tag), String(b.tag)));
}
export const unownedSnapshotHash = (snapshot) => createHash('sha1').update(JSON.stringify(snapshot)).digest('hex');

// The smoke envelope arithmetic, closed: both or neither; TARGET + HEADROOM <= MAX.
// A paid smoke additionally needs an explicit operator RUN ID (authorization
// identity, not a secret): required whenever TARGET/MAX are configured, ignored
// otherwise, bounded to X_SMOKE_RUN_ID_RE, never generated by Serpent.
export function xSmokeLaw({ liveSmokeTargetPostReads: target, liveSmokeMaxPostReads: max, liveSmokeRunId: runId } = {}, headroom = X_IN_FLIGHT_POST_HEADROOM) {
  const has = (v) => v !== null && v !== undefined;
  if (!has(target) && !has(max)) return { ok: true, configured: false, target: null, max: null, headroom, minMaxForTarget: null, runId: null };
  if (!has(target) || !has(max)) return { ok: false, configured: true, reason: 'SMOKE_BUDGET_INCOMPLETE', detail: 'RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS and RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS are required together', target: has(target) ? target : null, max: has(max) ? max : null, headroom, runId: null };
  if (!posInt(target) || !posInt(max)) return { ok: false, configured: true, reason: 'BUDGET_INVALID', detail: 'smoke target/max must be positive integers', target, max, headroom, runId: null };
  if (target + headroom > max) return { ok: false, configured: true, reason: 'SMOKE_BUDGET_TOO_SMALL', detail: `smoke target ${target} + in-flight headroom ${headroom} = ${target + headroom} exceeds smoke max ${max}; raise MAX to at least ${target + headroom} or lower TARGET`, target, max, headroom, minMaxForTarget: target + headroom, runId: null };
  if (!has(runId) || runId === '') return { ok: false, configured: true, reason: 'SMOKE_RUN_ID_REQUIRED', detail: 'a paid smoke is an explicit operator-authorized run: RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID is required (never generated by Serpent)', target, max, headroom, minMaxForTarget: target + headroom, runId: null };
  if (typeof runId !== 'string' || !X_SMOKE_RUN_ID_RE.test(runId)) return { ok: false, configured: true, reason: 'SMOKE_RUN_ID_INVALID', detail: 'RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID must be 8-64 chars of [A-Za-z0-9._:-]', target, max, headroom, minMaxForTarget: target + headroom, runId: null };
  return { ok: true, configured: true, target, max, headroom, minMaxForTarget: target + headroom, runId };
}
export const smokeRunIdHash = (runId) => createHash('sha1').update(String(runId)).digest('hex');

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcMonth = (ms) => new Date(ms).toISOString().slice(0, 7);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const parseEnvInt = (v) => (v === undefined || v === null || v === '' ? null : (/^\d{1,12}$/.test(String(v)) ? Number(v) : NaN));
const parseEnvNum = (v) => (v === undefined || v === null || v === '' ? null : (/^\d{1,9}(\.\d{1,6})?$/.test(String(v)) ? Number(v) : NaN));
const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

// Read the X gates from an env-like object. NEVER reads a default budget.
export function xConfigFromEnv(env = process.env) {
  return {
    enabled: env.RUMOR2_SOCIAL_X_ENABLED === 'true',
    bearer: typeof env[X_OFFICIAL.credentialEnv] === 'string' && env[X_OFFICIAL.credentialEnv].length > 0 ? env[X_OFFICIAL.credentialEnv] : null,
    maxDailyPostReads: parseEnvInt(env.RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS),
    maxMonthlyPostReads: parseEnvInt(env.RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS),
    maxEstimatedDailyUsd: parseEnvNum(env.RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD),
    maxSessionPostReads: parseEnvInt(env.RUMOR2_SOCIAL_X_MAX_SESSION_POST_READS),
    liveSmokeTargetPostReads: parseEnvInt(env.RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS),
    liveSmokeMaxPostReads: parseEnvInt(env.RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS),
    liveSmokeRunId: typeof env.RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID === 'string' && env.RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID.length > 0 ? env.RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID : null,
    priorityAccounts: csv(env.RUMOR2_SOCIAL_X_PRIORITY_ACCOUNTS),
    propagationFocus: csv(env.RUMOR2_SOCIAL_X_PROPAGATION_FOCUS),
  };
}

// The closed gate decision: every element must hold; the reason names the
// first missing one. A bearer VALUE is never returned or logged.
export function xGate(config, { pricing = X_OFFICIAL.pricing, headroom = X_IN_FLIGHT_POST_HEADROOM } = {}) {
  if (!config?.enabled) return { ok: false, reason: 'DISABLED', detail: 'RUMOR2_SOCIAL_X_ENABLED is not true' };
  if (!config.bearer) return { ok: false, reason: 'CREDENTIAL_MISSING', detail: `${X_OFFICIAL.credentialEnv} not configured` };
  const { maxDailyPostReads: d, maxMonthlyPostReads: m, maxEstimatedDailyUsd: usd } = config;
  if (d === null || d === undefined || m === null || m === undefined || usd === null || usd === undefined) return { ok: false, reason: 'BUDGET_NOT_CONFIGURED', detail: 'daily + monthly Post-read caps and an estimated daily USD cap are all required' };
  if (!posInt(d) || !posInt(m) || !Number.isFinite(usd) || usd <= 0) return { ok: false, reason: 'BUDGET_INVALID', detail: 'budgets must be positive (zero/negative/non-numeric fail closed)' };
  if (m > pricing.monthlyPostReadCap) return { ok: false, reason: 'BUDGET_INVALID', detail: `monthly cap ${m} exceeds the X self-serve cap ${pricing.monthlyPostReadCap}` };
  if (d > m) return { ok: false, reason: 'BUDGET_INVALID', detail: 'daily cap exceeds monthly cap' };
  if (config.maxSessionPostReads !== null && config.maxSessionPostReads !== undefined && !posInt(config.maxSessionPostReads)) return { ok: false, reason: 'BUDGET_INVALID', detail: 'session cap invalid' };
  const smoke = xSmokeLaw(config, headroom);
  if (!smoke.ok) return { ok: false, reason: smoke.reason, detail: smoke.detail };
  return { ok: true, reason: null, detail: null };
}

export function createXRuntime({
  provider = X_OFFICIAL,
  config = xConfigFromEnv(),
  filter = null, // Serpent's deterministic universe filter (the SECOND boundary)
  universe = [], // configured coin tickers (rule manifest anchors)
  aliases = [], // approved aliases (event lane)
  now = () => Date.now(),
  log = () => {},
  fetchImpl = null, // injected for tests; null => the global fetch (api.x.com only)
  maxDrain = 200,
  headroom = X_IN_FLIGHT_POST_HEADROOM,
  safeGapMs = X_SAFE_GAP_MS,
  usageMaxAgeMs = X_USAGE_MAX_AGE_MS,
  intakeOptions = {},
  streamOptions = {},
} = {}) {
  const pricing = provider.pricing;
  const universeFilter = filter ?? buildSocialFilter({});
  const durableIds = new Set();
  let x = emptyXState(); // durable X state from the journal
  let state = 'DARK';
  let hydrated = false;
  let intake = null;
  let stream = null;
  let pendingBatch = null;
  let lastError = null;
  // local conservative meter (durable snapshot + in-flight)
  const meter = { period: null, delivered: 0, monthPeriod: null, monthDelivered: 0, durablePeriod: null, durableDelivered: 0, durableMonthPeriod: null, durableMonthDelivered: 0, session: 0, byLane: {} };
  let serverUsage = null; // latest CLOSED parsed snapshot
  let credits = { capability: 'NOT_PROBED', value: null, status: null };
  const rules = { owned: [], unownedCount: 0, unownedSnapshotHash: null, unownedChanged: false, lastFailure: null, desiredHash: null, desiredTags: [], reconciledAt: null, dryRunOk: null, capacity: null };
  let pendingActivation = null; // { ruleSetHash, ruleTags, coverageEpoch, activatedKnownAtTs, afterGap? }
  let pendingGap = null; // { gapStartTs, reason, coverageEpoch, ruleSetHash }
  let lastReceiptTs = null;
  let lastStopReason = null;
  let preflightOk = false;
  let backfillNext = 0; // the backfill window the NEXT (re)connect presents — set by the gap law
  let owedSince = null; // receipt time of the earliest queue-full DROPPED Post: progress may never pass it until a backfill covers it
  let stopPending = null; // { reason, detail, receivedTs } — a budget stop decided inside a chunk, finalized at chunk end
  // DURABLE smoke run truth (from the journal), never a process-local latch
  let smokeRun = null; // the durable run record for config.liveSmokeRunId, if any
  let pendingSmokeActivation = null; // ACTIVE event fields awaiting the fenced append (no stream before it commits)
  let pendingSmokeTerminal = null; // { smokeRunId, status, terminalReason, deliveredPostReadsForRun, overrunPosts, completedKnownAtTs } awaiting append
  let smokeResumedAfterRestart = false;
  const stats = { settles: 0, appended: 0, meterEvents: 0, progressEvents: 0, gapEvents: 0, rulesetEvents: 0, smokeEvents: 0, durableDuplicates: 0, invalid: 0, appendFailures: 0, deliveredPosts: 0, keepalives: 0 };

  const api = async (url, { method = 'GET', body = null } = {}) => {
    const f = fetchImpl ?? globalThis.fetch;
    const headers = { Authorization: `Bearer ${config.bearer}` };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const res = await f(url, { method, headers, ...(body !== null ? { body: JSON.stringify(body) } : {}) });
    let json = null;
    try { json = typeof res.json === 'function' ? await res.json() : null; } catch { json = null; }
    return { status: res.status, json };
  };

  // ---- meter -----------------------------------------------------------------
  const rollPeriods = (ts) => {
    const day = utcDay(ts); const month = utcMonth(ts);
    if (meter.period !== day) { meter.period = day; meter.delivered = 0; }
    if (meter.monthPeriod !== month) { meter.monthPeriod = month; meter.monthDelivered = 0; }
  };
  const meterPost = (ts, tags) => {
    rollPeriods(ts);
    meter.delivered += 1; meter.monthDelivered += 1; meter.session += 1; stats.deliveredPosts += 1;
    for (const t of tags) { const lane = xLaneOfTag(t) ?? 'unowned'; meter.byLane[lane] = (meter.byLane[lane] ?? 0) + 1; }
  };
  const estimatedUsd = (n) => Math.round(n * pricing.postReadUsd * 1e6) / 1e6;

  // ---- budget decision: the STRICTEST remaining allowance --------------------
  function allowance(ts = now()) {
    rollPeriods(ts);
    const g = xGate(config, { pricing, headroom });
    if (!g.ok) return { ok: false, reason: g.reason, detail: g.detail, remaining: 0 };
    const adm = smokeAdmission(ts);
    if (!adm.ok) return { ok: false, reason: adm.reason, detail: adm.detail, remaining: 0 };
    if (!serverUsage) return { ok: false, reason: 'USAGE_PREFLIGHT_FAILED', detail: 'no verified server usage snapshot', remaining: 0 };
    if (ts - serverUsage.observedTs > usageMaxAgeMs) return { ok: false, reason: 'USAGE_PREFLIGHT_FAILED', detail: 'server usage snapshot is stale', remaining: 0 };
    if (credits.value && credits.value.totalBalance <= 0) return { ok: false, reason: 'NO_CREDITS', detail: 'credit balance is zero or negative', remaining: 0 };
    // COST-4: the server's observed usage is at least as large as our local month
    const observedMonth = Math.max(meter.monthDelivered, serverUsage.projectUsage);
    const candidates = [
      ['BUDGET_DAILY', config.maxDailyPostReads - meter.delivered],
      ['BUDGET_MONTHLY', config.maxMonthlyPostReads - observedMonth],
      ['BUDGET_USD', Math.floor(config.maxEstimatedDailyUsd / pricing.postReadUsd) - meter.delivered],
      ['BUDGET_MONTHLY', serverUsage.projectCap - observedMonth], // COST-7: the platform cap itself
    ];
    if (posInt(config.maxSessionPostReads)) candidates.push(['BUDGET_SESSION', config.maxSessionPostReads - meter.session]);
    if (adm.run) {
      // the per-run count is DURABLE arithmetic (meter delta since the durable
      // baseline, or the server usage delta when higher) — never meter.session
      const c = runCount(adm.run);
      if (c.rollover) return { ok: false, reason: 'SMOKE_PERIOD_ROLLOVER', detail: `smoke run ${adm.run.smokeRunId} was activated in UTC day ${adm.run.baselinePeriod}; a paid smoke may not span a UTC day boundary — a new run ID is required`, remaining: 0 };
      if (c.usageReset) return { ok: false, reason: 'SMOKE_USAGE_RESET', detail: 'server project usage fell below the run baseline: the billing comparison is invalid — a new run ID is required', remaining: 0 };
      // TARGET is the controlled-shutdown trigger itself (not headroom-subtracted);
      // MAX is the outer envelope and joins the strictest-boundary law below
      if (c.delivered >= adm.run.targetPostReads) return { ok: false, reason: 'SMOKE_TARGET_REACHED', detail: `smoke target ${adm.run.targetPostReads} reached (${c.delivered} conservatively delivered for run ${adm.run.smokeRunId}; outer max ${adm.run.maxPostReads})`, remaining: adm.run.maxPostReads - c.delivered, limiting: 'SMOKE_TARGET_REACHED' };
      candidates.push(['BUDGET_SMOKE_MAX', adm.run.maxPostReads - c.delivered]);
    }
    let limiting = null; let remaining = Infinity;
    for (const [reason, left] of candidates) if (left < remaining) { remaining = left; limiting = reason; }
    const usable = remaining - headroom; // COST-6: the reserve is subtracted, never hidden
    if (usable <= 0) return { ok: false, reason: limiting, detail: `remaining ${remaining} <= headroom ${headroom}`, remaining, limiting };
    return { ok: true, reason: null, remaining, usable, limiting };
  }

  // ---- smoke run law ----------------------------------------------------------------
  // The conservative count attributed to a run: max(local durable-meter delta,
  // server project-usage delta) since the durable baseline. Other project
  // consumers can only make it LARGER (safe). Lost in-memory reads therefore
  // reappear through the fresh usage preflight after a crash.
  function runCount(run) {
    const local = meter.period === run.baselinePeriod ? Math.max(0, meter.delivered - run.baselineDailyDeliveredPostReads) : null;
    // after a UTC-day rollover the run's own period is frozen in the durable meter
    const frozen = local === null && x.meter && x.meter.period === run.baselinePeriod ? Math.max(0, x.meter.deliveredPostReads - run.baselineDailyDeliveredPostReads) : 0;
    const serverRaw = serverUsage ? serverUsage.projectUsage - run.baselineServerProjectUsage : 0;
    const server = Math.max(0, serverRaw);
    return { local, server, delivered: Math.max(local ?? frozen, server), rollover: local === null, usageReset: serverRaw < 0 };
  }
  // §19/§20: reads billed by X that never became durable locally (a crash mid
  // final chunk) reappear as a server usage delta above the local run delta —
  // they are adopted into the conservative meter, never treated as free
  function adoptServerDelta(run) {
    const c = runCount(run);
    if (c.local === null || c.server <= c.local) return 0;
    const lost = c.server - c.local;
    meter.delivered += lost; meter.monthDelivered += lost;
    log(`x-runtime: smoke run ${run.smokeRunId}: server usage delta ${c.server} exceeds the local durable delta ${c.local}; ${lost} read(s) adopted into the conservative meter`);
    return lost;
  }
  // Pre-network admission of the configured smoke against DURABLE run truth.
  function smokeAdmission(ts = now()) {
    const sl = xSmokeLaw(config, headroom);
    if (!sl.configured) return { ok: true, run: null, sl };
    if (!sl.ok) return { ok: false, reason: sl.reason, detail: sl.detail, sl };
    if (pendingSmokeTerminal) return { ok: false, reason: pendingSmokeTerminal.status === 'COMPLETE' ? 'SMOKE_RUN_ALREADY_COMPLETE' : 'SMOKE_RUN_ALREADY_TERMINAL', detail: `smoke run ${pendingSmokeTerminal.smokeRunId} is ${pendingSmokeTerminal.status} (${pendingSmokeTerminal.terminalReason}); terminal state settles durably next; no automatic paid reconnect — a new operator run ID is required`, sl };
    const run = x.smoke.runs[sl.runId] ?? null;
    if (run && run.status === 'COMPLETE') return { ok: false, reason: 'SMOKE_RUN_ALREADY_COMPLETE', detail: `smoke run ${run.smokeRunId} completed durably (${run.deliveredPostReadsForRun} Posts, ${run.terminalReason}); a restart is not a new authorization — a new operator run ID is required`, sl };
    if (run && run.status !== 'ACTIVE') return { ok: false, reason: 'SMOKE_RUN_ALREADY_TERMINAL', detail: `smoke run ${run.smokeRunId} is ${run.status} (${run.terminalReason}); a new operator run ID is required`, sl };
    if (run) {
      if (run.targetPostReads !== sl.target || run.maxPostReads !== sl.max || run.headroomPosts !== headroom) return { ok: false, reason: 'SMOKE_RUN_CONFIG_MISMATCH', detail: `smoke run ${run.smokeRunId} was authorized as target ${run.targetPostReads} / max ${run.maxPostReads} / headroom ${run.headroomPosts}, not ${sl.target}/${sl.max}/${headroom}; a historical run is never reinterpreted`, sl };
      if (run.unitPriceUsd !== pricing.postReadUsd) return { ok: false, reason: 'SMOKE_RUN_PRICING_CHANGED', detail: `smoke run ${run.smokeRunId} was authorized at ${run.unitPriceUsd} USD/read; the pinned census now says ${pricing.postReadUsd} — a new operator run ID is required`, sl, abort: true };
      if (utcDay(ts) !== run.baselinePeriod) return { ok: false, reason: 'SMOKE_PERIOD_ROLLOVER', detail: `smoke run ${run.smokeRunId} was activated in UTC day ${run.baselinePeriod}; a paid smoke may not span a UTC day boundary — a new run ID is required`, sl, abort: true };
    }
    return { ok: true, run: run ?? (pendingSmokeActivation ? { ...pendingSmokeActivation, status: 'ACTIVE' } : null), durableRun: run, sl };
  }
  // Any recordable non-target interruption of an ACTIVE run makes it terminal
  // (ABORTED); the target makes it COMPLETE; a reserve overrun makes it
  // HEADROOM_OVERRUN. Terminal truth settles durably with the next batch and is
  // a latch until then — never an in-memory-only state.
  function setSmokeTerminal(run, reason, atTs = now()) {
    if (!run || run.status !== 'ACTIVE' || pendingSmokeTerminal) return;
    const c = runCount(run);
    const overrun = Math.max(0, c.delivered - run.maxPostReads);
    const status = overrun > 0 ? 'HEADROOM_OVERRUN' : reason === 'SMOKE_TARGET_REACHED' ? 'COMPLETE' : 'ABORTED';
    const terminalReason = status === 'HEADROOM_OVERRUN' ? 'SMOKE_HEADROOM_OVERRUN' : reason;
    pendingSmokeTerminal = { smokeRunId: run.smokeRunId, status, terminalReason, deliveredPostReadsForRun: c.delivered, overrunPosts: overrun, completedKnownAtTs: Math.floor(atTs) };
    state = status === 'COMPLETE' ? 'SMOKE_COMPLETE' : status === 'HEADROOM_OVERRUN' ? 'SMOKE_HEADROOM_OVERRUN' : 'SMOKE_ABORTED';
    log(`x-runtime: smoke run ${run.smokeRunId} ${status} (${terminalReason}; ${c.delivered} delivered for run${overrun ? `, overrun ${overrun}` : ''}); terminal state settles next; no reconnect`);
  }
  const smokeStateName = (st) => (st === 'COMPLETE' ? 'SMOKE_COMPLETE' : st === 'HEADROOM_OVERRUN' ? 'SMOKE_HEADROOM_OVERRUN' : 'SMOKE_ABORTED');

  // ---- preflight: usage, credits, rule reconciliation -------------------------
  async function preflight() {
    preflightOk = false;
    state = 'PREFLIGHT';
    const g = xGate(config, { pricing, headroom });
    if (!g.ok) { state = 'DARK'; return { ok: false, reason: g.reason, detail: g.detail }; }
    // 1. server usage — mandatory, closed parse, fresh
    try {
      const u = await api(xUsageUrl());
      const parsed = u.status === 200 ? parseXUsage(u.json, { observedTs: now() }) : null;
      if (!parsed) { lastError = `usage endpoint http ${u.status} / unparseable`; state = 'WITHHELD'; return { ok: false, reason: 'USAGE_PREFLIGHT_FAILED', detail: lastError }; }
      serverUsage = parsed;
    } catch { lastError = 'usage endpoint unavailable'; state = 'WITHHELD'; return { ok: false, reason: 'USAGE_PREFLIGHT_FAILED', detail: lastError }; }
    // 2. credits — surfaced when the credential type supports it; never fabricated
    try {
      const c = await api(xCreditsUrl());
      const parsed = c.status === 200 ? parseXCredits(c.json) : null;
      credits = parsed ? { capability: 'AVAILABLE', value: parsed, status: c.status } : { capability: c.status === 200 ? 'MALFORMED' : 'UNAVAILABLE_FOR_CREDENTIAL', value: null, status: c.status };
    } catch { credits = { capability: 'UNAVAILABLE', value: null, status: null }; }
    if (credits.value && credits.value.totalBalance <= 0) { state = 'WITHHELD'; return { ok: false, reason: 'NO_CREDITS', detail: 'credit balance is zero or negative' }; }
    // 3. rules — reconcile ONLY Serpent-owned rules while the stream is disconnected
    const r = await reconcileRules();
    if (!r.ok) { state = 'WITHHELD'; return r; }
    preflightOk = true;
    state = hydrated ? 'HYDRATED' : 'PREFLIGHT';
    return { ok: true, usage: serverUsage, credits: { capability: credits.capability, value: credits.value }, rules: { hash: rules.desiredHash, owned: rules.owned.length, unowned: rules.unownedCount } };
  }

  async function reconcileRules() {
    if (stream && stream.isConnected()) return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: 'rules are only reconciled while the paid stream is disconnected' };
    const manifest = compileXRuleManifest({ universe, aliases, priorityAccounts: config.priorityAccounts ?? [], propagationFocus: config.propagationFocus ?? [] });
    const verr = validateXRuleManifest(manifest.rules);
    if (verr) { lastError = verr; return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: verr }; }
    const cur = await api(xRulesUrl());
    if (cur.status !== 200) { lastError = `rules GET http ${cur.status}`; return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: lastError }; }
    const rawCurrent = Array.isArray(cur.json?.data) ? cur.json.data.filter((r) => r && typeof r === 'object') : [];
    const current = rawCurrent.filter((r) => typeof r.id === 'string' && typeof r.value === 'string');
    const owned = current.filter((r) => isSerpentTag(r.tag));
    // EVERY non-Serpent rule (well-formed or not) belongs to someone else: snapshot it canonically
    const unowned = rawCurrent.filter((r) => !isSerpentTag(r.tag));
    const beforeUnownedSnapshot = canonicalUnownedRules(unowned);
    rules.unownedChanged = false; rules.lastFailure = null;
    // capacity: prefer the counts endpoint's cap when present, else the pinned platform limit
    let cap = provider.limits.rulesPerProject;
    try { const c = await api(xRulesCountsUrl()); const n = c.status === 200 ? Number(c.json?.data?.cap_per_project) : NaN; if (Number.isSafeInteger(n) && n > 0) cap = n; } catch { /* optional */ }
    rules.capacity = cap; rules.unownedCount = unowned.length;
    if (unowned.length + manifest.rules.length > cap) { lastError = `rule capacity ${cap} cannot hold ${unowned.length} unowned + ${manifest.rules.length} Serpent rules; unowned rules are never deleted`; return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: lastError }; }
    const key = (r) => `${r.tag} ${r.value}`;
    const have = new Map(owned.map((r) => [key(r), r]));
    const want = new Map(manifest.rules.map((r) => [key(r), r]));
    const toAdd = manifest.rules.filter((r) => !have.has(key(r)));
    const toDelete = owned.filter((r) => !want.has(key(r)));
    if (toAdd.length > 0) {
      // 4. dry-run BEFORE any mutation
      const dry = await api(xRulesUrl({ dryRun: true }), { method: 'POST', body: { add: toAdd.map((r) => ({ value: r.value, tag: r.tag })) } });
      const invalid = Number(dry.json?.meta?.summary?.invalid ?? 0);
      const errors = Array.isArray(dry.json?.errors) ? dry.json.errors.length : 0;
      rules.dryRunOk = (dry.status === 200 || dry.status === 201) ? invalid === 0 && errors === 0 : false;
      if (!rules.dryRunOk) { lastError = `dry-run rejected desired rules (http ${dry.status}, invalid ${invalid}, errors ${errors})`; return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: lastError }; }
      // 5. add
      const add = await api(xRulesUrl(), { method: 'POST', body: { add: toAdd.map((r) => ({ value: r.value, tag: r.tag })) } });
      if (add.status !== 200 && add.status !== 201) { lastError = `rules add http ${add.status}`; return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: lastError }; }
    }
    if (toDelete.length > 0) {
      // 7. delete ONLY stale Serpent-owned ids
      const del = await api(xRulesUrl(), { method: 'POST', body: { delete: { ids: toDelete.map((r) => r.id) } } });
      if (del.status !== 200) { lastError = `rules delete http ${del.status}`; return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: lastError }; }
    }
    // 8. verify the final Serpent set exactly (and that unowned rules survived)
    const after = await api(xRulesUrl());
    if (after.status !== 200) { lastError = `rules verify http ${after.status}`; return { ok: false, reason: 'RULE_RECONCILE_FAILED', detail: lastError }; }
    const finalRules = Array.isArray(after.json?.data) ? after.json.data.filter((r) => r && typeof r === 'object') : [];
    const finalOwned = finalRules.filter((r) => isSerpentTag(r?.tag) && typeof r.id === 'string' && typeof r.value === 'string');
    const finalUnowned = finalRules.filter((r) => !isSerpentTag(r?.tag));
    const finalKeys = new Set(finalOwned.map(key));
    if (finalKeys.size !== want.size || [...want.keys()].some((k) => !finalKeys.has(k))) { lastError = 'final Serpent rule set does not match the desired manifest'; rules.lastFailure = 'OWNED_RULESET_MISMATCH'; return { ok: false, reason: 'RULE_RECONCILE_FAILED', code: 'OWNED_RULESET_MISMATCH', detail: lastError }; }
    // UNOWNED-RULE IMMUTABILITY: canonical deep equality, never count equality. A
    // difference means someone else changed the project's rules while Serpent was
    // reconciling — not corruption, but not a verified surface either: no paid
    // stream, and the external rule is never deleted, restored, or "repaired".
    const afterUnownedSnapshot = canonicalUnownedRules(finalUnowned);
    if (JSON.stringify(afterUnownedSnapshot) !== JSON.stringify(beforeUnownedSnapshot)) {
      rules.unownedChanged = true; rules.lastFailure = 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE';
      lastError = `UNOWNED_RULESET_CHANGED_DURING_RECONCILE: ${beforeUnownedSnapshot.length} unowned rule(s) before, ${afterUnownedSnapshot.length} after, canonical snapshot differs (hash ${unownedSnapshotHash(beforeUnownedSnapshot).slice(0, 12)} -> ${unownedSnapshotHash(afterUnownedSnapshot).slice(0, 12)}); a later preflight retries from the actual project state`;
      return { ok: false, reason: 'RULE_RECONCILE_FAILED', code: 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE', detail: lastError };
    }
    rules.unownedSnapshotHash = unownedSnapshotHash(afterUnownedSnapshot);
    rules.owned = finalOwned.map((r) => ({ id: r.id, value: r.value, tag: r.tag }));
    rules.desiredHash = manifest.hash; rules.desiredTags = manifest.rules.map((r) => r.tag).sort(); rules.reconciledAt = now();
    // a NEW rule set starts a NEW coverage epoch, activated NOW (never backdated)
    if (x.ruleSetHash !== manifest.hash && !(pendingActivation && pendingActivation.ruleSetHash === manifest.hash)) {
      pendingActivation = { ruleSetHash: manifest.hash, ruleTags: rules.desiredTags, coverageEpoch: (pendingActivation?.coverageEpoch ?? x.coverageEpoch) + 1, activatedKnownAtTs: now() };
    }
    return { ok: true };
  }

  // ---- hydrate: durable X state from the SAME journal --------------------------
  function hydrate(events) {
    const r = replaySocialHistory(events);
    if (!r.ok) { state = 'WITHHELD'; lastError = r.error; hydrated = false; return { ok: false, error: r.error }; }
    durableIds.clear(); for (const id of r.durableIds) durableIds.add(id);
    x = r.x;
    if (x.meter) {
      meter.durablePeriod = x.meter.period; meter.durableDelivered = x.meter.deliveredPostReads;
      meter.durableMonthPeriod = x.meter.monthPeriod; meter.durableMonthDelivered = x.meter.monthDeliveredPostReads;
      // COST-3: restart restores the conservative local count for the current periods
      meter.period = x.meter.period; meter.delivered = x.meter.deliveredPostReads;
      meter.monthPeriod = x.meter.monthPeriod; meter.monthDelivered = x.meter.monthDeliveredPostReads;
      if (x.meter.serverUsage && (!serverUsage || x.meter.serverUsage.observedTs > serverUsage.observedTs)) serverUsage = x.meter.serverUsage;
    }
    rollPeriods(now());
    const sl = xSmokeLaw(config, headroom);
    smokeRun = sl.configured && sl.ok ? (x.smoke.runs[sl.runId] ?? null) : null;
    smokeResumedAfterRestart = !!smokeRun && smokeRun.status === 'ACTIVE';
    pendingSmokeActivation = null; pendingSmokeTerminal = null;
    hydrated = true; lastError = null;
    if (state !== 'ACTIVE') state = smokeRun && smokeRun.status !== 'ACTIVE' ? smokeStateName(smokeRun.status) : 'HYDRATED';
    return { ok: true, durableIds: durableIds.size, x: { ruleSetHash: x.ruleSetHash, coverageEpoch: x.coverageEpoch, progressThroughTs: x.progressThroughTs, meter: x.meter ? { period: x.meter.period, deliveredPostReads: x.meter.deliveredPostReads, monthDeliveredPostReads: x.meter.monthDeliveredPostReads } : null, lastGap: x.lastGap } };
  }

  function recordGap(reason, gapStartTs = null) {
    // the EFFECTIVE coverage epoch: a pending (not yet durable) activation counts,
    // because the batch that settles it settles this gap right after it
    const epoch = pendingActivation && !pendingActivation.afterGap ? pendingActivation.coverageEpoch : x.coverageEpoch;
    const hash = pendingActivation && !pendingActivation.afterGap ? pendingActivation.ruleSetHash : x.ruleSetHash;
    if (pendingGap || epoch < 1 || hash === null) return; // no coverage epoch => nothing to mark absent
    pendingGap = { gapStartTs: gapStartTs ?? x.progressThroughTs ?? x.activatedKnownAtTs ?? now(), reason, coverageEpoch: epoch, ruleSetHash: hash };
  }

  // ---- start: gate -> preflight -> allowance -> gap law -> stream ---------------
  // GAP LAW: elapsed is measured from DURABLE continuity (or the owed dropped
  // Post), never receive-side memory. Returns the backfill window, or null when
  // the gap is unexplained and must be recorded first.
  function gapLaw() {
    if (pendingActivation) return 0;
    const lastCoverage = owedSince !== null ? Math.min(owedSince, x.progressThroughTs ?? owedSince) : (x.progressThroughTs ?? x.activatedKnownAtTs);
    if (lastCoverage === null || x.coverageEpoch < 1) return 0;
    const elapsed = now() - lastCoverage;
    if (elapsed > safeGapMs) return null;
    // backfill only reaches back to DURABLE coverage (or an owed dropped Post);
    // an epoch that has no watermark yet starts as an explicit live tail
    return (x.progressThroughTs !== null || owedSince !== null) ? X_BACKFILL_MINUTES : 0;
  }

  // CHUNK END: finalize a pending budget stop. The gap begins at the last fully
  // processed line of the received chunk (never before evidence Serpent received);
  // a smoke reserve overrun is recorded exactly and latches this runtime.
  function finalizeBudgetStop(s, chunkEndTs) {
    let reason = stopPending.reason;
    const run = xSmokeLaw(config, headroom).configured ? smokeRun : null;
    if (run && run.status === 'ACTIVE') {
      if (runCount(run).delivered > run.maxPostReads) reason = 'SMOKE_HEADROOM_OVERRUN'; // never clamped, never discarded
      setSmokeTerminal(run, reason, chunkEndTs);
    }
    recordGap(reason, chunkEndTs);
    if (stream === s) stream = null;
    state = pendingSmokeTerminal ? smokeStateName(pendingSmokeTerminal.status) : 'BUDGET_STOPPED';
    lastStopReason = pendingSmokeTerminal?.terminalReason ?? reason;
    stopPending = null;
    log(`x-runtime: ${lastStopReason}; stream stopped at chunk end (headroom ${headroom})`);
  }

  async function start() {
    if (!hydrated) return { ok: false, reason: 'NOT_HYDRATED' };
    if (stream && !stream.status().paused) return { ok: true, already: true };
    if (pendingGap || (pendingActivation && pendingActivation.afterGap)) return { ok: false, reason: 'WITHHELD_GAP', detail: 'the coverage gap must settle durably before a new coverage epoch opens' };
    const g = xGate(config, { pricing, headroom });
    if (!g.ok) { state = 'DARK'; lastStopReason = g.reason; return { ok: false, reason: g.reason, detail: g.detail }; }
    // DURABLE smoke admission BEFORE any network: a completed/terminal run never
    // reconnects; a mismatched, repriced, or day-rolled run fails closed
    const adm0 = smokeAdmission();
    if (!adm0.ok) {
      if (adm0.abort && smokeRun && smokeRun.status === 'ACTIVE') setSmokeTerminal(smokeRun, adm0.reason);
      if (!pendingSmokeTerminal && smokeRun && smokeRun.status !== 'ACTIVE') state = smokeStateName(smokeRun.status);
      lastStopReason = adm0.reason; return { ok: false, reason: adm0.reason, detail: adm0.detail };
    }
    if (stream && stream.status().paused) {
      // resume after backpressure: the earlier queued work has settled; replay
      // the owed Post(s) through backfill or record the gap
      const bf = gapLaw();
      if (bf === null) { recordGap('UNEXPLAINED_GAP', owedSince ?? x.progressThroughTs); setSmokeTerminal(adm0.durableRun, 'UNEXPLAINED_GAP'); pendingActivation = { ruleSetHash: x.ruleSetHash, ruleTags: x.ruleTags, coverageEpoch: x.coverageEpoch + 1, activatedKnownAtTs: now(), afterGap: true }; state = 'WITHHELD_GAP'; stream.stop('unexplained gap'); stream = null; return { ok: false, reason: 'WITHHELD_GAP' }; }
      backfillNext = bf; stream.resume(); state = 'ACTIVE';
      return { ok: true, resumed: true, backfillMinutes: bf };
    }
    if (!preflightOk) { const p = await preflight(); if (!p.ok) { lastStopReason = p.reason; return p; } }
    if (adm0.sl.configured) {
      const run = adm0.durableRun;
      if (run) {
        // a resumed run is bound to the rule surface and usage baseline it was authorized against
        if (rules.desiredHash !== run.ruleSetHash) { setSmokeTerminal(run, 'SMOKE_RUN_RULESET_MISMATCH'); lastStopReason = 'SMOKE_RUN_RULESET_MISMATCH'; return { ok: false, reason: 'SMOKE_RUN_RULESET_MISMATCH', detail: `smoke run ${run.smokeRunId} was authorized against rule set ${run.ruleSetHash.slice(0, 12)}; the verified rule set is now ${String(rules.desiredHash).slice(0, 12)} — a new operator run ID is required after reconciliation` }; }
        const c = runCount(run);
        if (c.usageReset) { setSmokeTerminal(run, 'SMOKE_USAGE_RESET'); lastStopReason = 'SMOKE_USAGE_RESET'; return { ok: false, reason: 'SMOKE_USAGE_RESET', detail: 'server project usage fell below the run baseline — a new operator run ID is required' }; }
        adoptServerDelta(run);
      } else if (!pendingSmokeActivation) {
        // TWO-PHASE ACTIVATION: build the ACTIVE authorization with its durable
        // baseline now; settle() appends it under the writer fence; only a start()
        // that sees the DURABLE run may open the paid stream
        const a0 = allowance();
        if (!a0.ok) { state = 'BUDGET_STOPPED'; lastStopReason = a0.reason; return { ok: false, reason: a0.reason, detail: a0.detail }; }
        rollPeriods(now());
        pendingSmokeActivation = {
          smokeRunId: adm0.sl.runId, targetPostReads: adm0.sl.target, maxPostReads: adm0.sl.max, headroomPosts: headroom, unitPriceUsd: pricing.postReadUsd,
          ruleSetHash: pendingActivation?.ruleSetHash ?? x.ruleSetHash, coverageEpoch: pendingActivation?.coverageEpoch ?? x.coverageEpoch,
          baselinePeriod: meter.period, baselineDailyDeliveredPostReads: meter.delivered, baselineMonthlyDeliveredPostReads: meter.monthDelivered, baselineServerProjectUsage: serverUsage.projectUsage,
          activatedKnownAtTs: Math.floor(now()), supersedes: x.smoke.activeRunId && x.smoke.activeRunId !== adm0.sl.runId ? x.smoke.activeRunId : null,
        };
        if (pendingSmokeActivation.supersedes) setSmokeTerminal(x.smoke.runs[pendingSmokeActivation.supersedes], 'SMOKE_RUN_SUPERSEDED');
        state = 'SMOKE_ACTIVATING';
      }
      if (!run) { lastStopReason = 'SMOKE_ACTIVATION_PENDING'; return { ok: false, reason: 'SMOKE_ACTIVATION_PENDING', detail: `smoke run ${adm0.sl.runId}: the ACTIVE authorization and its baseline must be durable under the writer fence before the paid stream opens` }; }
    }
    const a = allowance();
    if (!a.ok) { state = 'BUDGET_STOPPED'; lastStopReason = a.reason; recordGap(a.reason); setSmokeTerminal(adm0.durableRun, a.reason); if (pendingSmokeTerminal) state = smokeStateName(pendingSmokeTerminal.status); return { ok: false, reason: a.reason, detail: a.detail }; }
    let backfill = 0;
    if (!pendingActivation) {
      const lastCoverage = x.progressThroughTs ?? x.activatedKnownAtTs;
      if (lastCoverage !== null && x.coverageEpoch >= 1) {
        const elapsed = now() - lastCoverage;
        // backfill reaches back to DURABLE coverage only: a freshly activated
        // epoch (no watermark yet) opens as an explicit live tail (backfill 0)
        if (elapsed <= safeGapMs) backfill = x.progressThroughTs !== null ? X_BACKFILL_MINUTES : 0;
        else {
          // UNEXPLAINED GAP: never silently resume as continuous. Record the gap
          // durably, then open a NEW coverage epoch (activated now).
          recordGap('UNEXPLAINED_GAP', lastCoverage);
          setSmokeTerminal(adm0.durableRun, 'UNEXPLAINED_GAP');
          pendingActivation = { ruleSetHash: x.ruleSetHash, ruleTags: x.ruleTags, coverageEpoch: x.coverageEpoch + 1, activatedKnownAtTs: now(), afterGap: true };
          state = 'WITHHELD_GAP';
          return { ok: false, reason: 'WITHHELD_GAP', detail: `unexplained gap of ${elapsed} ms exceeds the ${safeGapMs} ms recoverable window` };
        }
      }
    }
    backfillNext = backfill;
    intake = intake ?? socialIntake({ provider, mapCommit: xPostToRaw, filter: universeFilter, now, cursorOf: null, isDurable: (id) => durableIds.has(id), ...intakeOptions });
    const s = startXStream({
      provider, bearer: config.bearer, fetchImpl: fetchImpl ?? globalThis.fetch, now, log,
      buildUrl: ({ backfillMinutes }) => xStreamUrl({ backfillMinutes }),
      backfillMinutesFor: () => backfillNext,
      shouldConnect: () => { const al = allowance(); return al.ok ? { ok: true } : { ok: false, reason: al.reason }; },
      onOpen: ({ backfillMinutes }) => {
        state = 'ACTIVE';
        // a reconnect whose backfill window reaches back to the owed dropped Post covers it
        if (owedSince !== null && now() - backfillMinutes * 60_000 <= owedSince) owedSince = null;
      },
      onKeepalive: ({ receivedTs }) => { lastReceiptTs = receivedTs; stats.keepalives += 1; },
      onLine: (obj, { receivedTs }) => {
        lastReceiptTs = receivedTs;
        // BILL AT THE WIRE: a delivered Post is metered BEFORE any Serpent filter
        const isPost = obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object' && typeof obj.data.id === 'string';
        if (isPost) meterPost(receivedTs, canonicalIngressTags((obj.matching_rules ?? []).map((m) => m?.tag)));
        const r = intake.offer(obj, { receivedTs }); // evidence knownAt == transport receipt == watermark clock
        if (r.outcome === 'dropped') {
          if (owedSince === null || receivedTs < owedSince) owedSince = receivedTs; // progress may never pass the owed Post
          s.pause('backpressure'); state = 'STANDBY'; lastStopReason = 'BACKPRESSURE';
          log('x-runtime: queue full; paused; will resume through the governor with backfill');
          return;
        }
        const al = allowance(receivedTs);
        if (!al.ok && stopPending === null) {
          // STOP_PENDING (chunk-atomic law): the transport finishes the already-received
          // chunk — every later Post in it is still metered above — then onChunkEnd
          // finalizes the gap at the chunk's last receipt and closes before any next read
          stopPending = { reason: al.reason, detail: al.detail, receivedTs };
          s.stop(al.reason);
          log(`x-runtime: ${al.reason}; stop pending until the received chunk ends (headroom ${headroom}; ${al.detail})`);
        }
      },
      onChunkEnd: ({ receivedTs }) => {
        if (stopPending === null) return;
        finalizeBudgetStop(s, receivedTs ?? lastReceiptTs ?? now());
      },
      onClose: ({ reason }) => { if (reason === 'AUTH_REJECTED' || reason === 'CONNECTION_LIMIT') { recordGap(reason); setSmokeTerminal(smokeRun, reason); if (stream === s) stream = null; state = pendingSmokeTerminal ? smokeStateName(pendingSmokeTerminal.status) : 'WITHHELD'; lastStopReason = reason; } },
      ...streamOptions,
    });
    stream = s;
    s.start();
    state = 'ACTIVE';
    return { ok: true, backfillMinutes: backfill, coverageEpoch: pendingActivation?.coverageEpoch ?? x.coverageEpoch };
  }

  // Writer loss / shutdown: stop the transport IMMEDIATELY; nothing durable is
  // adopted; no meter/progress/evidence mutation. Frames are redelivered via backfill.
  function stop(reason = 'stopped') {
    if (stream) { stream.stop(reason); stream = null; }
    if (intake) { intake.clear(); intake = null; }
    pendingBatch = null;
    stopPending = null;
    owedSince = null; // durable progress already stops before the owed Post; a fresh start replays from it
    if (state === 'ACTIVE') state = 'STANDBY';
    lastStopReason = reason;
    preflightOk = false; // a fresh start re-verifies usage + rules
    log(`x-runtime: ${provider.id} stopped (${reason})`);
  }

  // ---- settle: [ruleset?] [evidence...] [meter?] [progress?] [gap?] [ruleset-after-gap?] atomically
  async function buildBatch(lookup) {
    if (pendingBatch) return pendingBatch;
    const knownAtTs = Math.floor(now());
    const events = [];
    const envelopes = intake ? intake.drain(maxDrain) : [];
    let epoch = x.coverageEpoch; let hash = x.ruleSetHash;
    if (pendingActivation && !pendingActivation.afterGap) { events.push(xRuleSetEvent({ provider: provider.id, ruleSetHash: pendingActivation.ruleSetHash, ruleTags: pendingActivation.ruleTags, coverageEpoch: pendingActivation.coverageEpoch, activatedKnownAtTs: pendingActivation.activatedKnownAtTs, knownAtTs })); epoch = pendingActivation.coverageEpoch; hash = pendingActivation.ruleSetHash; }
    const smokeTerminalEvent = (t) => { const r = x.smoke.runs[t.smokeRunId]; return xSmokeEvent({ provider: provider.id, smokeRunId: r.smokeRunId, status: t.status, targetPostReads: r.targetPostReads, maxPostReads: r.maxPostReads, headroomPosts: r.headroomPosts, unitPriceUsd: r.unitPriceUsd, ruleSetHash: r.ruleSetHash, coverageEpoch: r.coverageEpoch, baselinePeriod: r.baselinePeriod, baselineDailyDeliveredPostReads: r.baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads: r.baselineMonthlyDeliveredPostReads, baselineServerProjectUsage: r.baselineServerProjectUsage, activatedKnownAtTs: r.activatedKnownAtTs, deliveredPostReadsForRun: t.deliveredPostReadsForRun, overrunPosts: t.overrunPosts, terminalReason: t.terminalReason, completedKnownAtTs: Math.min(Math.max(t.completedKnownAtTs, r.activatedKnownAtTs), Math.max(knownAtTs, r.activatedKnownAtTs)), knownAtTs: Math.max(knownAtTs, r.activatedKnownAtTs) }); };
    // a superseded stale ACTIVE run terminates BEFORE the new authorization activates
    let smokeTerminal = null; let smokeActivation = null;
    if (pendingSmokeTerminal && pendingSmokeActivation && pendingSmokeTerminal.smokeRunId === pendingSmokeActivation.supersedes) { events.push(smokeTerminalEvent(pendingSmokeTerminal)); smokeTerminal = pendingSmokeTerminal; }
    if (pendingSmokeActivation) {
      const a = pendingSmokeActivation;
      events.push(xSmokeEvent({ provider: provider.id, smokeRunId: a.smokeRunId, status: 'ACTIVE', targetPostReads: a.targetPostReads, maxPostReads: a.maxPostReads, headroomPosts: a.headroomPosts, unitPriceUsd: a.unitPriceUsd, ruleSetHash: a.ruleSetHash, coverageEpoch: a.coverageEpoch, baselinePeriod: a.baselinePeriod, baselineDailyDeliveredPostReads: a.baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads: a.baselineMonthlyDeliveredPostReads, baselineServerProjectUsage: a.baselineServerProjectUsage, activatedKnownAtTs: a.activatedKnownAtTs, knownAtTs }));
      smokeActivation = { ...a };
    }
    const candidates = []; const inBatch = new Set();
    for (const env of envelopes) {
      const { event } = socialObservationToEvent(env.observation);
      const verr = validateSocialEvent(event);
      if (verr) { stats.invalid += 1; continue; }
      if (durableIds.has(event.sourceEventId) || inBatch.has(event.sourceEventId)) { stats.durableDuplicates += 1; continue; }
      inBatch.add(event.sourceEventId); candidates.push(event);
    }
    if (candidates.length > 0 && typeof lookup === 'function') {
      const r = await lookup(SOCIAL_EVENT_TYPE, candidates.map((e) => e.sourceEventId));
      if (!r?.ok) return { error: `durable lookup unavailable: ${r?.reason ?? 'unknown'}` };
      for (const e of candidates) { if (r.existing.has(e.sourceEventId)) { stats.durableDuplicates += 1; durableIds.add(e.sourceEventId); continue; } events.push(e); }
    } else events.push(...candidates);
    // meter: only when the conservative count (or the server snapshot) moved
    rollPeriods(knownAtTs);
    let meterEv = null;
    const meterMoved = meter.period !== meter.durablePeriod || meter.delivered !== meter.durableDelivered || meter.monthDelivered !== meter.durableMonthDelivered
      || (serverUsage && x.meter?.serverUsage?.observedTs !== serverUsage.observedTs);
    if (meterMoved && (meter.delivered > 0 || meter.monthDelivered > 0)) {
      meterEv = xMeterEvent({ provider: provider.id, period: meter.period, deliveredPostReads: meter.delivered, monthPeriod: meter.monthPeriod, monthDeliveredPostReads: meter.monthDelivered, unitPriceUsd: pricing.postReadUsd, serverUsage, knownAtTs });
      events.push(meterEv);
    }
    // progress: every line received through the watermark reached a terminal state
    let progressEv = null;
    if (epoch >= 1 && hash && intake) {
      const queued = intake._peekKnownAts();
      let through = queued.length === 0 ? lastReceiptTs : Math.min(...queued) - 1;
      if (through !== null && owedSince !== null) through = Math.min(through, owedSince - 1); // never past an owed dropped Post
      if (through !== null && through > knownAtTs) through = knownAtTs;
      // strictly after the last durable watermark of this epoch; the FIRST
      // watermark of a new epoch may equal its activation clock
      const prior = x.coverageEpoch === epoch ? x.progressThroughTs : null;
      const activation = x.coverageEpoch === epoch ? x.activatedKnownAtTs : (pendingActivation?.activatedKnownAtTs ?? null);
      const admissible = through !== null && (prior === null ? (activation === null || through >= activation) : through > prior);
      if (admissible && !(stream && stream.status().tainted)) { progressEv = xProgressEvent({ provider: provider.id, ruleSetHash: hash, coverageEpoch: epoch, throughKnownAtTs: through, knownAtTs }); events.push(progressEv); }
    }
    let gapEv = null;
    if (pendingGap) { gapEv = xGapEvent({ provider: provider.id, gapStartTs: pendingGap.gapStartTs, reason: pendingGap.reason, coverageEpoch: pendingGap.coverageEpoch, ruleSetHash: pendingGap.ruleSetHash, knownAtTs }); events.push(gapEv); }
    // terminal smoke truth settles WITH the final evidence, meter, progress, and gap
    if (pendingSmokeTerminal && smokeTerminal === null) { events.push(smokeTerminalEvent(pendingSmokeTerminal)); smokeTerminal = pendingSmokeTerminal; }
    if (pendingActivation?.afterGap) events.push(xRuleSetEvent({ provider: provider.id, ruleSetHash: pendingActivation.ruleSetHash, ruleTags: pendingActivation.ruleTags, coverageEpoch: pendingActivation.coverageEpoch, activatedKnownAtTs: pendingActivation.activatedKnownAtTs, knownAtTs }));
    pendingBatch = { envelopes, events, meter: meterEv ? { period: meter.period, delivered: meter.delivered, monthPeriod: meter.monthPeriod, monthDelivered: meter.monthDelivered } : null, progress: progressEv, gap: gapEv, activation: pendingActivation ? { ...pendingActivation } : null, smokeActivation, smokeTerminal: smokeTerminal ? { ...smokeTerminal } : null, knownAtTs };
    return pendingBatch;
  }

  async function settle({ fenceHeld = () => true, append, lookup = null } = {}) {
    if (!hydrated) return { ok: false, reason: 'NOT_HYDRATED' };
    if (!fenceHeld()) { stop('writer authority lost before settle'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const batch = await buildBatch(lookup);
    if (batch.error) { stats.appendFailures += 1; lastError = batch.error; return { ok: false, reason: 'UNAVAILABLE', detail: batch.error }; }
    stats.settles += 1;
    if (batch.events.length === 0) { intake?.settled(batch.envelopes); pendingBatch = null; return { ok: true, settled: batch.envelopes.length, appended: 0 }; }
    if (!fenceHeld()) { stop('writer authority lost before append'); return { ok: false, reason: 'WRITER_FENCE_LOST' }; }
    const r = await append(batch.events);
    if (!r?.ok) { stats.appendFailures += 1; lastError = r?.reason ?? 'append failed'; return { ok: false, reason: r?.reason ?? 'UNAVAILABLE' }; }
    // AFTER the durable commit: adopt exactly once, evidence + meter + progress together
    let appended = 0;
    for (const e of batch.events) if (e.type === SOCIAL_EVENT_TYPE) { durableIds.add(e.sourceEventId); appended += 1; }
    if (batch.activation) {
      x.ruleSetHash = batch.activation.ruleSetHash; x.coverageEpoch = batch.activation.coverageEpoch; x.activatedKnownAtTs = batch.activation.activatedKnownAtTs; x.ruleTags = batch.activation.ruleTags; x.progressThroughTs = null;
      pendingActivation = null; stats.rulesetEvents += 1;
    }
    if (batch.meter) {
      meter.durablePeriod = batch.meter.period; meter.durableDelivered = batch.meter.delivered; meter.durableMonthPeriod = batch.meter.monthPeriod; meter.durableMonthDelivered = batch.meter.monthDelivered;
      x.meter = { period: batch.meter.period, deliveredPostReads: batch.meter.delivered, monthPeriod: batch.meter.monthPeriod, monthDeliveredPostReads: batch.meter.monthDelivered, unitPriceUsd: pricing.postReadUsd, estimatedUsd: estimatedUsd(batch.meter.monthDelivered), serverUsage, knownAtTs: batch.knownAtTs };
      stats.meterEvents += 1;
    }
    if (batch.progress) { x.progressThroughTs = batch.progress.throughKnownAtTs; stats.progressEvents += 1; }
    if (batch.gap) { x.lastGap = { gapStartTs: batch.gap.gapStartTs, reason: batch.gap.reason, knownAtTs: batch.knownAtTs, coverageEpoch: batch.gap.coverageEpoch }; pendingGap = null; owedSince = null; stats.gapEvents += 1; }
    if (batch.smokeTerminal) {
      const t = batch.smokeTerminal; const r = x.smoke.runs[t.smokeRunId];
      x.smoke.runs[t.smokeRunId] = { ...r, status: t.status, deliveredPostReadsForRun: t.deliveredPostReadsForRun, overrunPosts: t.overrunPosts, terminalReason: t.terminalReason, completedKnownAtTs: Math.min(t.completedKnownAtTs, batch.knownAtTs) };
      if (x.smoke.activeRunId === t.smokeRunId) x.smoke.activeRunId = null;
      x.smoke.latestRunId = t.smokeRunId;
      if (smokeRun && smokeRun.smokeRunId === t.smokeRunId) smokeRun = x.smoke.runs[t.smokeRunId];
      pendingSmokeTerminal = null; stats.smokeEvents += 1;
    }
    if (batch.smokeActivation) {
      const a = batch.smokeActivation;
      x.smoke.runs[a.smokeRunId] = { smokeRunId: a.smokeRunId, status: 'ACTIVE', targetPostReads: a.targetPostReads, maxPostReads: a.maxPostReads, headroomPosts: a.headroomPosts, unitPriceUsd: a.unitPriceUsd, ruleSetHash: a.ruleSetHash, coverageEpoch: a.coverageEpoch, baselinePeriod: a.baselinePeriod, baselineDailyDeliveredPostReads: a.baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads: a.baselineMonthlyDeliveredPostReads, baselineServerProjectUsage: a.baselineServerProjectUsage, activatedKnownAtTs: a.activatedKnownAtTs, deliveredPostReadsForRun: 0, overrunPosts: 0, terminalReason: null, completedKnownAtTs: null };
      x.smoke.activeRunId = a.smokeRunId; x.smoke.latestRunId = a.smokeRunId;
      smokeRun = x.smoke.runs[a.smokeRunId]; smokeResumedAfterRestart = false;
      pendingSmokeActivation = null; stats.smokeEvents += 1;
      if (state === 'SMOKE_ACTIVATING') state = 'HYDRATED'; // the DURABLE authorization now exists; the next start() may connect
    }
    stats.appended += appended;
    intake?.settled(batch.envelopes);
    const events = batch.events;
    pendingBatch = null; lastError = null;
    if (state === 'WITHHELD_GAP' && !pendingGap && !pendingActivation) state = 'HYDRATED'; // the gap is durable; a new epoch may open on the next start
    return { ok: true, settled: batch.envelopes.length, appended, lastSeq: r.lastSeq, events, coverageEpoch: x.coverageEpoch, progressThroughTs: x.progressThroughTs, meter: x.meter ? { period: x.meter.period, deliveredPostReads: x.meter.deliveredPostReads } : null };
  }

  // test/diagnostic hook: deliver one stream line as if the transport received it
  function _feedLine(obj, receivedTs = now()) {
    if (!intake) return null;
    lastReceiptTs = receivedTs;
    if (obj && typeof obj === 'object' && obj.data && typeof obj.data.id === 'string') meterPost(receivedTs, canonicalIngressTags((obj.matching_rules ?? []).map((m) => m?.tag)));
    return intake.offer(obj, { receivedTs });
  }

  return {
    provider, hydrate, start, stop, settle, preflight, allowance,
    isActive: () => state === 'ACTIVE' && stream !== null,
    isDurable: (id) => durableIds.has(id),
    gate: () => xGate(config, { pricing, headroom }),
    smokeLaw: () => xSmokeLaw(config, headroom),
    _intake: () => intake, _stream: () => stream, _feedLine,
    status() {
      const g = xGate(config, { pricing, headroom });
      const al = hydrated && serverUsage ? allowance() : null;
      const sl = xSmokeLaw(config, headroom);
      return {
        provider: provider.id, accessState: 'AVAILABLE_REQUIRES_CREDENTIAL', enabled: !!config.enabled, credentialPresent: !!config.bearer,
        gate: g.ok ? 'OPEN' : g.reason, gateDetail: g.detail, state, hydrated, authority: 'NONE',
        ruleSetHash: x.ruleSetHash, coverageEpoch: x.coverageEpoch, ownedRuleCount: rules.owned.length, unownedRuleCount: rules.unownedCount, ruleCapacity: rules.capacity, dryRunOk: rules.dryRunOk,
        rules: { unownedSnapshotHash: rules.unownedSnapshotHash, unownedChanged: rules.unownedChanged, lastFailure: rules.lastFailure },
        smoke: (() => {
          const run = sl.configured && sl.ok ? (x.smoke.runs[sl.runId] ?? null) : null;
          const cnt = run && run.status === 'ACTIVE' && hydrated ? runCount(run) : null;
          const term = pendingSmokeTerminal;
          const durableStatus = run ? run.status : null;
          return {
            configured: sl.configured, ok: sl.ok, reason: sl.ok ? null : sl.reason, targetPostReads: sl.target ?? null, maxPostReads: sl.max ?? null, headroomPosts: headroom,
            minMaxForTarget: sl.minMaxForTarget ?? null, sessionPostReads: meter.session, // process diagnostic only — never the envelope
            smokeRunId: sl.runId ?? null, smokeRunIdHashPrefix: sl.runId ? smokeRunIdHash(sl.runId).slice(0, 12) : null,
            durableStatus, activationPending: !!pendingSmokeActivation, terminalPending: term ? { status: term.status, terminalReason: term.terminalReason, deliveredPostReadsForRun: term.deliveredPostReadsForRun, overrunPosts: term.overrunPosts } : null,
            status: term ? term.status : durableStatus, latched: !!term || (run ? run.status !== 'ACTIVE' : false),
            baselinePeriod: run?.baselinePeriod ?? null, baselineDailyDelivered: run?.baselineDailyDeliveredPostReads ?? null, baselineMonthlyDelivered: run?.baselineMonthlyDeliveredPostReads ?? null, baselineServerProjectUsage: run?.baselineServerProjectUsage ?? null,
            conservativeDeliveredForRun: cnt ? cnt.delivered : (run ? run.deliveredPostReadsForRun : null), localDeltaForRun: cnt ? cnt.local : null, serverDeltaForRun: cnt ? cnt.server : null,
            targetRemaining: cnt && run ? Math.max(0, run.targetPostReads - cnt.delivered) : null, maxRemaining: cnt && run ? Math.max(0, run.maxPostReads - cnt.delivered) : null,
            overrunPosts: term ? term.overrunPosts : (run?.overrunPosts ?? 0), activatedKnownAtTs: run?.activatedKnownAtTs ?? null, completedKnownAtTs: run?.completedKnownAtTs ?? null, terminalReason: term ? term.terminalReason : (run?.terminalReason ?? null),
            ruleSetHash: run?.ruleSetHash ?? null, unitPriceUsd: run?.unitPriceUsd ?? null, resumedAfterRestart: smokeResumedAfterRestart,
            activeRunId: x.smoke.activeRunId, latestRunId: x.smoke.latestRunId, stopPending: stopPending ? { reason: stopPending.reason } : null,
            nominalUsdAtMax: sl.max ? estimatedUsd(sl.max) : null, // pricing census value — the usage preflight, not this number, is authoritative
          };
        })(),
        pendingActivation: pendingActivation ? { ruleSetHash: pendingActivation.ruleSetHash, coverageEpoch: pendingActivation.coverageEpoch } : null,
        stream: stream ? stream.status() : null, lastReceiptTs,
        progressThroughTs: x.progressThroughTs, lastGap: x.lastGap, pendingGap: pendingGap ? { reason: pendingGap.reason, gapStartTs: pendingGap.gapStartTs } : null, lastStopReason,
        meter: { period: meter.period, deliveredPostReads: meter.delivered, monthPeriod: meter.monthPeriod, monthDeliveredPostReads: meter.monthDelivered, sessionPostReads: meter.session, durableDeliveredPostReads: meter.durableDelivered, durableMonthDeliveredPostReads: meter.durableMonthDelivered, byLane: { ...meter.byLane } },
        budget: {
          maxDailyPostReads: config.maxDailyPostReads ?? null, maxMonthlyPostReads: config.maxMonthlyPostReads ?? null, maxEstimatedDailyUsd: config.maxEstimatedDailyUsd ?? null, maxSessionPostReads: config.maxSessionPostReads ?? null,
          liveSmokeTargetPostReads: config.liveSmokeTargetPostReads ?? null, liveSmokeMaxPostReads: config.liveSmokeMaxPostReads ?? null, liveSmokeRunIdPresent: !!config.liveSmokeRunId,
          headroomPosts: headroom,
          dailyRemainingLocal: posInt(config.maxDailyPostReads) ? Math.max(0, config.maxDailyPostReads - meter.delivered) : null,
          monthlyRemainingLocal: posInt(config.maxMonthlyPostReads) ? Math.max(0, config.maxMonthlyPostReads - meter.monthDelivered) : null,
          estimatedUsdUsedMonth: estimatedUsd(meter.monthDelivered), estimatedUsdUsedDay: estimatedUsd(meter.delivered),
          estimatedUsdRemainingDay: Number.isFinite(config.maxEstimatedDailyUsd) ? Math.max(0, Math.round((config.maxEstimatedDailyUsd - estimatedUsd(meter.delivered)) * 1e6) / 1e6) : null,
          unitPriceUsd: pricing.postReadUsd, pricingObservedOn: pricing.observedOn,
          allowance: al ? { ok: al.ok, reason: al.reason, remaining: al.remaining === Infinity ? null : al.remaining, limiting: al.limiting ?? null } : null,
          platformSpendingLimitVerified: 'UNKNOWN', // not machine-verifiable; the Developer Console spending limit is the recommended independent backstop
        },
        serverUsage, credits: { capability: credits.capability, value: credits.value, status: credits.status },
        pendingBatch: pendingBatch ? { envelopes: pendingBatch.envelopes.length, events: pendingBatch.events.length } : null,
        intake: intake ? intake.stats() : null, stats: { ...stats }, lastError,
      };
    },
  };
}
