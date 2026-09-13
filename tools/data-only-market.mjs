// DATA-ONLY market composition. This module owns market observation only: no
// Paper, Watch, Tape, Judge, Socrates, model, execution, or order runtime.
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, PROVIDER_IDS } from '../market-lab/contracts.js';
import { loadPolicy, loadSubjects } from '../market-lab/policy.js';
import { createResearchOwner, spotRestCallPlan } from '../market-lab/owner.js';
import { marketResearchRootFromEnv } from '../market-lab/paths.js';

export const DATA_ONLY_MARKET_VERSION = 'serpent-data-only-market-1';
export const DATA_ONLY_MARKET_SWEEP_MS = 300_000;
export const DATA_ONLY_MARKET_FAMILIES = Object.freeze([
  'SPOT_PRICE_CHART',
  'SPOT_FLOW',
  'SUPPLY_UNLOCKS',
  'DEX_DEFI',
  'NETWORK_ACTIVITY',
  'STABLECOIN_LIQUIDITY',
  'MACRO_RELEASES',
  'CROSS_ASSET',
]);

// This is a closed allowlist. Key-gated providers are enabled only when their
// named credential is present. Unknown/metered sources and the restricted
// derivative venues remain off regardless of environment contents.
export const DATA_ONLY_MARKET_PROVIDERS = Object.freeze({
  KRAKEN_SPOT: 'PUBLIC_FREE',
  COINBASE_SPOT: 'PUBLIC_FREE',
  COINGECKO: 'KEY_GATED_INCLUDED_QUOTA',
  GECKOTERMINAL: 'PUBLIC_FREE',
  DEFILLAMA: 'PUBLIC_FREE',
  COINMETRICS: 'PUBLIC_FREE',
  FRED: 'KEY_GATED_FREE',
  TWELVEDATA: 'KEY_GATED_FREE',
});
export const DATA_ONLY_MARKET_RESTRICTED = Object.freeze(['KRAKEN_DERIVATIVES', 'DERIBIT', 'BYBIT']);
const ZERO_BUDGET = new Set(['COINGLASS', 'CRYPTOQUANT', 'SANTIMENT', 'TOKENOMIST']);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_POLICY_FILE = path.join(REPO_ROOT, 'config', 'market-research.paper.json');
const DEFAULT_SUBJECTS_FILE = path.join(REPO_ROOT, 'config', 'market-subjects.paper.json');
let captureSequence = 0;

function readStrict(file, label) {
  const parsed = parseStrictJson(readFileSync(file));
  if (!parsed.ok) throw new Error(`${label} is not strict JSON: ${parsed.error}`);
  return parsed.value;
}

const credentialPresent = (provider, env) => {
  const name = provider.credentialEnv;
  return name === null || (typeof name === 'string' && typeof env[name] === 'string' && env[name].length > 0);
};

export function buildDataOnlyMarketPolicy({ env = process.env, policyRaw = null } = {}) {
  const raw = structuredClone(policyRaw ?? readStrict(DEFAULT_POLICY_FILE, 'market policy'));
  for (const id of PROVIDER_IDS) {
    const provider = raw.providers[id];
    if (!provider) continue;
    const approved = Object.hasOwn(DATA_ONLY_MARKET_PROVIDERS, id);
    const zeroCost = provider.plan.billing === 'FREE'
      || (provider.plan.billing === 'INCLUDED_QUOTA' && provider.plan.incrementalUsdPerCall === 0);
    provider.enabled = provider.enabled === true && approved && zeroCost && credentialPresent(provider, env);
    provider.smoke = { authorized: false, maxCalls: 0, maxEstimatedUsd: null };
  }
  // Dark/private market senses remain explicitly unavailable in this process.
  if (raw.providers.KRAKEN_SPOT?.l3) raw.providers.KRAKEN_SPOT.l3.enabled = false;
  if (raw.providers.KRAKEN_DERIVATIVES?.charts) raw.providers.KRAKEN_DERIVATIVES.charts.enabled = false;
  raw.model.enabled = false;
  raw.model.maxEstimatedUsdPerCase = 0;
  raw.model.maxEstimatedUsdPerDay = 0;
  raw.model.maxEstimatedUsdPerMonth = 0;
  raw.model.totalSmokeMaxEstimatedUsd = 0;
  return loadPolicy(raw);
}

export function loadDataOnlyMarketSubjects({ subjectsRaw = null } = {}) {
  return loadSubjects(subjectsRaw ?? readStrict(DEFAULT_SUBJECTS_FILE, 'market subjects'));
}

function quotaAudit(policy, subjects, families) {
  const spot = spotRestCallPlan({ subjectCount: subjects.subjects.length, includeCharts: families.includes('SPOT_PRICE_CHART'), includeFlow: families.includes('SPOT_FLOW') });
  // Each venue has one baseline startup catalog call. Public WebSocket traffic
  // is not counted here. The estimate assumes one start/day; every additional
  // process restart repeats catalogs and one uncached initial family sweep.
  const planned = {
    KRAKEN_SPOT: spot.KRAKEN_SPOT,
    COINBASE_SPOT: spot.COINBASE_SPOT,
    TWELVEDATA: families.includes('CROSS_ASSET') ? subjects.crossAsset.length + 96 * subjects.crossAsset.length : 0,
  };
  const rows = Object.fromEntries(Object.entries(planned).map(([id, estimate]) => {
    const callsPerDay = typeof estimate === 'number' ? estimate : estimate.callsPerDay;
    const callsPerMonth = typeof estimate === 'number' ? estimate * 31 : estimate.callsPerMonth;
    const p = policy.providers[id]; const dailyCap = p?.limits.maxCallsPerDay ?? 0; const monthlyCap = p?.limits.maxCallsPerMonth ?? 0;
    return [id, { callsPerDay, callsPerMonth, configuredDailyCap: dailyCap, configuredMonthlyCap: monthlyCap, state: p?.enabled !== true ? 'SOURCE_DISABLED' : callsPerDay > dailyCap || callsPerMonth > monthlyCap ? 'CAP_WILL_BIND' : 'WITHIN_CAP' }];
  }));
  return Object.freeze({
    state: Object.values(rows).some((r) => r.state === 'CAP_WILL_BIND') ? 'REVIEW_REQUIRED' : 'WITHIN_DECLARED_CAPS',
    sweepIntervalMs: DATA_ONLY_MARKET_SWEEP_MS,
    rows,
    safeCurrentBehavior: 'The durable provider guard refuses REST dispatch after the declared cap; it never silently raises a quota.',
    requestedReview: 'Replace arbitrary venue-wide caps with evidence-backed endpoint cadences/quotas before claiming uninterrupted REST candle coverage.',
  });
}

function configuredState(id, policy, env) {
  const provider = policy.providers[id];
  if (DATA_ONLY_MARKET_RESTRICTED.includes(id)) return { desired: 'OFF', state: 'RESTRICTED_OFF', reason: 'restricted derivative provider disabled in data-only market composition' };
  if (ZERO_BUDGET.has(id)) return { desired: 'OFF', state: 'DISABLED_ZERO_BUDGET', reason: 'paid or unverified entitlement has no data-only budget' };
  if (!Object.hasOwn(DATA_ONLY_MARKET_PROVIDERS, id)) return { desired: 'OFF', state: 'OUT_OF_SCOPE', reason: 'not in the closed data-only market provider allowlist' };
  if (provider?.credentialEnv && !(typeof env[provider.credentialEnv] === 'string' && env[provider.credentialEnv].length > 0)) return { desired: 'ON', state: 'BLOCKED_CREDENTIAL', reason: `missing ${provider.credentialEnv}` };
  if (provider?.enabled !== true) return { desired: 'ON', state: 'DISABLED_BY_POLICY', reason: 'source disabled or not proven zero-cost by the shipped policy' };
  return { desired: 'ON', state: 'STARTING', reason: null };
}

const sanitizedRefusals = (value) => {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.count) || value.count < 1) return null;
  const safeReason = (reason) => typeof reason === 'string' && /^[A-Z0-9_]{1,64}$/.test(reason);
  const reasons = Object.fromEntries(Object.entries(value.reasons ?? {}).filter(([reason, count]) => safeReason(reason) && Number.isSafeInteger(count) && count > 0).sort(([a], [b]) => a.localeCompare(b)));
  return {
    count: value.count,
    reasons,
    lastReasons: Array.isArray(value.lastReasons) ? value.lastReasons.filter(safeReason).slice(0, 16) : [],
    lastTs: Number.isSafeInteger(value.lastTs) && value.lastTs > 0 ? value.lastTs : null,
  };
};

function accountingBlockReasons(provider, accounting) {
  if (!provider || !accounting) return [];
  const out = [];
  const totals = accounting.totals;
  if (totals?.calls?.day >= provider.limits.maxCallsPerDay) out.push(provider.limits.maxCallsPerDay === 0 ? 'DAY_CAP_ZERO' : 'DAY_CAP');
  if (totals?.calls?.month >= provider.limits.maxCallsPerMonth) out.push(provider.limits.maxCallsPerMonth === 0 ? 'MONTH_CAP_ZERO' : 'MONTH_CAP');
  if (provider.plan.billing === 'INCLUDED_QUOTA' && accounting.entitlementRemaining === 0) out.push('ENTITLEMENT_EXHAUSTED');
  return [...new Set(out)];
}

export async function startDataOnlyMarket({
  env = process.env,
  dataDir = null,
  researchRoot = null,
  policyRaw = null,
  subjectsRaw = null,
  families = DATA_ONLY_MARKET_FAMILIES,
  clock = () => Date.now(),
  log = () => {},
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  wsUrls = {},
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  ownerMode = 'STANDALONE',
  quotaJournal = null,
  closeDrainMs = undefined,
} = {}) {
  if (researchRoot === null && !(typeof dataDir === 'string' && dataDir.length)) throw new Error('data-only market requires dataDir or researchRoot');
  if (!Array.isArray(families) || families.some((f) => !DATA_ONLY_MARKET_FAMILIES.includes(f))) throw new Error('data-only market families must be a subset of the closed acquisition list');
  const policy = buildDataOnlyMarketPolicy({ env, policyRaw });
  const subjects = loadDataOnlyMarketSubjects({ subjectsRaw });
  const root = path.resolve(researchRoot ?? marketResearchRootFromEnv(env, dataDir));
  const capturesDir = path.join(root, 'captures');
  mkdirSync(capturesDir, { recursive: true });
  captureSequence += 1;
  const segmentDir = path.join(capturesDir, `data-only-${String(clock()).padStart(13, '0')}-${process.pid}-${captureSequence}`);
  const owner = createResearchOwner({
    policy, subjects,
    // Disabled/provider-unapproved credentials do not even enter a client
    // closure. Only credentials for an enabled allowlisted source are copied.
    env: Object.fromEntries(Object.values(policy.providers).filter((p) => p.enabled && p.credentialEnv && credentialPresent(p, env)).map((p) => [p.credentialEnv, env[p.credentialEnv]])),
    researchRoot: root, mode: ownerMode, clock, log,
    fetchImpl, WebSocketImpl, wsUrls, timers, quotaJournal,
    ...(closeDrainMs === undefined ? {} : { closeDrainMs }),
  });
  let state = 'STARTING'; let stopping = null; let stopResult = null; let started = null;
  const planAudit = quotaAudit(policy, subjects, families);

  function status() {
    const current = owner.status();
    const sources = {};
    for (const id of PROVIDER_IDS) {
      const configured = configuredState(id, policy, env);
      const client = current.clients[id]; const accounting = current.accounting.providers?.[id] ?? null;
      const ok = client?.counters?.ok ?? 0; const failed = client?.counters?.failed ?? 0;
      const refusal = sanitizedRefusals(accounting?.refusals);
      const catalog = current.resolution?.catalogs?.[id] ?? started?.resolution?.catalogs?.[id] ?? null;
      // Refusal totals are historical diagnostics. A later successful receipt
      // clears the refusal as a CURRENT blocker, but never erases its audit row.
      const refusalIsCurrent = refusal !== null && !(Number.isSafeInteger(client?.lastOkTs) && client.lastOkTs > refusal.lastTs);
      const blockReasons = [...new Set([...(refusalIsCurrent ? refusal.lastReasons : []), ...accountingBlockReasons(policy.providers[id], accounting)])];
      // Catalog state describes startup resolution and may be stale after a
      // quota window changes. Current accounting/refusal evidence owns state.
      const policyBlocked = configured.state === 'STARTING' && blockReasons.length > 0;
      sources[id] = {
        ...configured,
        state: configured.state === 'STARTING' ? (policyBlocked ? 'POLICY_BLOCKED' : ok > 0 ? 'OBSERVED' : failed > 0 ? 'DEGRADED' : current.bootstrap.running ? 'STARTING' : 'NOT_OBSERVED') : configured.state,
        credentialEnv: policy.providers[id]?.credentialEnv ?? null,
        credentialPresent: policy.providers[id]?.credentialEnv ? credentialPresent(policy.providers[id], env) : null,
        requests: client?.counters?.requests ?? 0,
        succeeded: ok,
        failed,
        callsToday: accounting?.totals?.calls?.day ?? 0,
        callsMonth: accounting?.totals?.calls?.month ?? 0,
        dailyCap: policy.providers[id]?.limits.maxCallsPerDay ?? 0,
        monthlyCap: policy.providers[id]?.limits.maxCallsPerMonth ?? 0,
        entitlementRemaining: accounting?.entitlementRemaining ?? null,
        policyRefusals: refusal,
        policyBlockReasons: blockReasons,
        catalogResolution: catalog ? {
          state: typeof catalog.state === 'string' ? catalog.state : 'UNKNOWN',
          count: Number.isSafeInteger(catalog.count) && catalog.count >= 0 ? catalog.count : null,
          knownAtTs: Number.isSafeInteger(catalog.knownAtTs) && catalog.knownAtTs > 0 ? catalog.knownAtTs : null,
        } : null,
      };
    }
    return {
      version: DATA_ONLY_MARKET_VERSION,
      state,
      running: state === 'ACTIVE',
      authority: 'NONE',
      purpose: 'OBSERVATION_ONLY',
      safety: { orders: false, paperTrading: false, realTrading: false, modelEnabled: false, paidBudgetUsd: 0, krakenL3: false, derivatives: false },
      persistence: { captures: 'FILE_BACKED_SAME_FILESYSTEM', quotaJournal: quotaJournal ? (current.accounting.journal.durable ? 'INJECTED_DURABLE' : 'INJECTED_PROCESS_LOCAL') : 'FILE_BACKED_SAME_FILESYSTEM', cadenceCache: 'MEMORY_ONLY', processRestartSameFilesystem: { captures: true, quotaJournal: quotaJournal ? null : true, cadenceCache: false }, replitRepublish: quotaJournal && current.accounting.journal.durable ? 'JOURNAL_ADAPTER_DEFINED' : 'NOT_GUARANTEED', note: quotaJournal ? 'Quota durability and republish continuity are defined by the injected journal adapter; captures remain filesystem-only unless separately checkpointed.' : 'File-backed continuity applies only when the same deployment filesystem remains attached; no database or object-store replication is configured here.' },
      scope: { subjectCount: subjects.subjects.length, subjects: subjects.subjects.map((s) => s.canonicalCoin), allAssetCoverageClaim: false, note: 'Only explicitly declared market subjects are captured; the wider discovery catalog is not claimed as covered.' },
      families: [...families],
      root,
      segmentDir,
      bootstrap: current.bootstrap,
      cadence: current.cadence,
      streams: current.streams,
      recording: current.recording,
      counters: current.counters,
      sources,
      quotaAudit: planAudit,
      stopped: stopResult,
    };
  }

  async function stop({ seal = true } = {}) {
    if (!stopping) {
      state = 'STOPPING';
      stopping = owner.stop({ seal, policyNonsecret: policy }).then((result) => {
        stopResult = result;
        state = result.error ? 'RECORDING_FAILED' : 'STOPPED';
        return result;
      });
    }
    return stopping;
  }

  try {
    // Catalog identity is awaited. The potentially long provider sweep runs in
    // the background so it cannot jam the perpetual data-only launcher.
    started = await owner.start({ outDir: segmentDir, families, awaitInitialSweep: false });
    state = owner.status().recording.error ? 'RECORDING_FAILED' : 'ACTIVE';
  } catch (error) {
    state = 'FAILED';
    try { await owner.stop({ seal: false, policyNonsecret: policy }); } catch { /* preserve startup error */ }
    throw error;
  }

  return Object.freeze({
    version: DATA_ONLY_MARKET_VERSION,
    status,
    stop,
    readiness: () => owner.status().readiness,
    paths: Object.freeze({ root, segmentDir, accountingDir: path.join(root, 'accounting') }),
    started: Object.freeze({ ...started }),
  });
}
