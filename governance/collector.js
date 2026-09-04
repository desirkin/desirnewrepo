// GOV-1 — the DARK GOVERNANCE SENSE. Observes verified governance spaces
// (Snapshot first; Tally only behind a key and a verified governor mapping)
// and appends bounded truthful observations to data/governance/events.jsonl.
// The Memory mirror tails that stream; this collector never touches the
// MemoryBus, Memory files, attention, stalking, posture, trading, or the
// UI. GOV-1 LISTENS AND REMEMBERS. It does not vote, nominate, or predict.
//
// Cadence philosophy: governance moves slowly. Discovery every ~3 minutes,
// active-proposal refresh every ~5 minutes, one bounded snapshot event per
// active proposal per ~6 minutes unless a meaningful transition happens
// first. Requests stay far under Snapshot's public ceiling.
import path from 'node:path';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { loadRegistry } from './registry.js';
import {
  Retry429,
  snapshotGql,
  fetchProposalsPage,
  fetchVotesPage,
  normalizeProposal,
  quorumTruth,
  voteTrajectory,
  voterConcentration,
} from './snapshot.js';
import { tallyStatus } from './tally.js';

export const GOVERNANCE_COLLECTOR_VERSION = 'GOV-1';

const eventsFile = () => path.join(dataDir(), 'governance', 'events.jsonl');
const statusFile = () => path.join(dataDir(), 'governance', 'status.json');

// Named, documented bounds. Conservative by default — Snapshot's public
// ceiling is far above this, deliberately.
export const GOV_DEFAULTS = Object.freeze({
  enabled: false, // dark unless cobra.config.json carries governance.enabled: true
  snapshotEnabled: true, // provider gate inside an enabled sensor
  discoverySec: 180, // new/active proposal discovery (~2-5 min band)
  refreshSec: 300, // active proposal tally refresh
  activeSnapshotSec: 360, // bounded unchanged-state snapshot cadence (5-10 min band)
  timeoutMs: 15_000,
  requestsPerHour: 60,
  minSpacingMs: 3_000,
  backoffBaseSec: 30,
  backoffMaxSec: 1_800,
  backoff429Sec: 900, // when the provider names no Retry-After
  proposalPageSize: 25,
  maxProposalPagesPerCycle: 2,
  votePageSize: 100,
  maxVotePagesPerProposal: 2,
  maxMappedSymbols: 64,
  maxActiveProposals: 24,
  maxEventsPerPoll: 40,
  maxProposalTextBytes: 2_048,
  maxTitleBytes: 256,
});

// Validate the governance config section against the documented bounds.
// Bad bounds FAIL CLOSED: the sensor disables itself and reports why —
// nothing else in Serpent is affected.
export function governanceConfig(config = loadConfig()) {
  const raw = config.governance ?? {};
  const cfg = { ...GOV_DEFAULTS, ...raw };
  const errors = [];
  const positiveInts = [
    'discoverySec', 'refreshSec', 'activeSnapshotSec', 'timeoutMs', 'requestsPerHour', 'minSpacingMs',
    'backoffBaseSec', 'backoffMaxSec', 'backoff429Sec', 'proposalPageSize', 'maxProposalPagesPerCycle',
    'votePageSize', 'maxVotePagesPerProposal', 'maxMappedSymbols', 'maxActiveProposals', 'maxEventsPerPoll',
    'maxProposalTextBytes', 'maxTitleBytes',
  ];
  for (const k of positiveInts) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) errors.push(`governance.${k} must be a positive number`);
  }
  if (Number.isFinite(cfg.requestsPerHour) && cfg.requestsPerHour > 600) errors.push('governance.requestsPerHour exceeds the documented posture ceiling (600)');
  if (Number.isFinite(cfg.discoverySec) && cfg.discoverySec < 60) errors.push('governance.discoverySec below 60s is not a governance cadence');
  const enabled = cfg.enabled === true && errors.length === 0;
  return { enabled, requested: cfg.enabled === true, cfg, errors };
}

// Request budget: hourly cap + spacing + backoff, a pure state machine over
// timestamps (own copy — governance imports nothing from other sensors).
export class GovBudget {
  constructor({ requestsPerHour, minSpacingMs, backoffBaseSec, backoffMaxSec, backoff429Sec }, now = Date.now) {
    this.requestsPerHour = requestsPerHour;
    this.minSpacingMs = minSpacingMs;
    this.backoffBaseSec = backoffBaseSec;
    this.backoffMaxSec = backoffMaxSec;
    this.backoff429Sec = backoff429Sec;
    this.now = now;
    this.stamps = [];
    this.lastReqMs = 0;
    this.backoffUntil = 0;
    this.failStreak = 0;
  }

  canRequest() {
    const t = this.now();
    if (t < this.backoffUntil) return false;
    if (t - this.lastReqMs < this.minSpacingMs) return false;
    this.stamps = this.stamps.filter((s) => t - s < 3_600_000);
    return this.stamps.length < this.requestsPerHour;
  }

  recordRequest() {
    const t = this.now();
    this.stamps.push(t);
    this.lastReqMs = t;
  }

  recordSuccess() {
    this.failStreak = 0;
  }

  recordFailure() {
    this.failStreak++;
    const backoffSec = Math.min(this.backoffBaseSec * 2 ** (this.failStreak - 1), this.backoffMaxSec);
    this.backoffUntil = this.now() + backoffSec * 1000;
    return backoffSec;
  }

  record429(retryAfterSec) {
    this.failStreak++;
    const sec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : this.backoff429Sec;
    this.backoffUntil = this.now() + sec * 1000;
    return sec;
  }

  hourCount() {
    const t = this.now();
    return this.stamps.filter((s) => t - s < 3_600_000).length;
  }
}

// meaningful-change fingerprint: identical polls of an unchanged proposal
// do not spam the source stream (suppressed and counted instead)
const changeFingerprint = (p) => `${p.state}|${p.scoresTotal ?? 'x'}|${p.voteCount ?? 'x'}|${p.updatedTs ?? 'x'}`;

export function startGovernance({
  log = console.log,
  config = loadConfig(),
  fetchImpl = fetch,
  now = Date.now,
  registryEntries = undefined,
  intervalMs = 15_000,
  env = process.env,
} = {}) {
  const { enabled, requested, cfg, errors } = governanceConfig(config);
  if (!enabled) {
    if (requested && errors.length) log(`[${nowIso()}] GOVERNANCE FAIL-CLOSED — bad config bounds, sensor disabled: ${errors.join('; ')}`);
    else log(`[${nowIso()}] GOVERNANCE dark — sense off, zero network`);
    return null;
  }
  const registry = loadRegistry(registryEntries);
  for (const r of registry.rejected) log(`[${nowIso()}] GOVERNANCE registry entry rejected: ${r.errors.join('; ')}`);
  const budget = new GovBudget(cfg, now);
  const gqlOpts = { fetchImpl, timeoutMs: cfg.timeoutMs };
  const textOpts = { maxTitleBytes: cfg.maxTitleBytes, maxBodyBytes: cfg.maxProposalTextBytes };

  // proposalId -> { norm, prevNorm, fingerprint, lastSnapshotEmitMs, final }
  const tracked = new Map();
  const counters = {
    eventsEmitted: 0,
    eventsSuppressedAsDuplicate: 0,
    eventsSuppressedAtPollCap: 0,
    requests: 0,
    requestFailures: 0,
    partialCoverageCount: 0,
  };
  let stopped = false;
  let inFlight = false; // single-flight: no overlapping polls, ever
  let lastPollTs = null;
  let lastSuccessTs = null;
  let lastErrorTs = null;
  let nextDiscoveryMs = 0; // conservative start: first discovery waits one interval
  let nextRefreshMs = 0;
  let eventsThisPoll = 0;

  function emit(record) {
    if (stopped) return; // a poll finishing during shutdown writes nothing further
    if (eventsThisPoll >= cfg.maxEventsPerPoll) {
      counters.eventsSuppressedAtPollCap++;
      return;
    }
    appendJsonl(eventsFile(), record);
    counters.eventsEmitted++;
    eventsThisPoll++;
  }

  // one bounded request through the budget; classifies failures
  async function request(fn) {
    budget.recordRequest();
    counters.requests++;
    try {
      const out = await fn();
      budget.recordSuccess();
      lastSuccessTs = now();
      return out;
    } catch (err) {
      counters.requestFailures++;
      lastErrorTs = now();
      if (err instanceof Retry429) {
        const sec = budget.record429(err.retryAfterSec);
        log(`[${nowIso()}] GOVERNANCE 429 — backing off ${sec}s (provider retry-after ${err.retryAfterSec ?? 'unspecified'})`);
      } else {
        const sec = budget.recordFailure();
        log(`[${nowIso()}] GOVERNANCE provider error (fail dark, backoff ${sec}s): ${err.message}`);
      }
      throw err;
    }
  }

  function buildObservation(norm, { lifecycle, emitReason, concentration, votesCoverage, proposalPagesCoverage }, prev = null) {
    const entry = registry.entryForSpace(norm.spaceId);
    const nowSec = Math.floor(now() / 1000);
    return {
      ts: new Date(now()).toISOString(),
      type: 'GOVERNANCE_OBSERVATION',
      provider: norm.provider,
      providerKind: 'snapshot hub graphql (off-chain voting)',
      collectorVersion: GOVERNANCE_COLLECTOR_VERSION,
      lifecycleTransition: lifecycle ?? null,
      emitReason,
      spaceId: norm.spaceId,
      proposalId: norm.proposalId,
      // symbol ONLY through the verified registry; unmapped stays null
      symbol: entry?.symbol ?? null,
      mappingVersion: entry?.mappingVersion ?? null,
      proposalState: norm.state,
      // a Snapshot "closed" with a leading tally is an OFF-CHAIN vote result,
      // never execution truth
      offchainVoteNote: 'snapshot is off-chain voting evidence; PASSED_OFFCHAIN_VOTE is not EXECUTED',
      proposalStartTs: norm.startTs,
      proposalEndTs: norm.endTs,
      snapshotBlock: norm.snapshotBlock,
      choices: norm.choices,
      voteTotals: { scores: norm.scores, scoresTotal: norm.scoresTotal, voteCount: norm.voteCount },
      quorum: quorumTruth(norm),
      trajectory: voteTrajectory(norm, nowSec, prev),
      voterConcentration: concentration ?? { coverage: 'UNAVAILABLE', coverageReason: 'NOT_REQUESTED_THIS_CYCLE' },
      timelock: 'UNKNOWN', // no timelock evidence exists in snapshot data
      executionState: 'UNKNOWN', // idem — an on-chain provider may know later
      coverage: { proposalPages: proposalPagesCoverage, votePages: votesCoverage ?? 'UNAVAILABLE' },
      title: norm.title,
      bodyExcerpt: norm.bodyExcerpt,
      textHash: norm.textHash,
      providerUrl: norm.providerUrl,
      retrievedTs: new Date(now()).toISOString(),
    };
  }

  // lifecycle transitions derived ONLY from observed provider state
  function lifecyclesFor(prevState, norm, isNew) {
    const out = [];
    if (isNew) out.push('PROPOSAL_DISCOVERED');
    if (!isNew && prevState !== norm.state) {
      if (norm.state === 'active') out.push('VOTING_STARTED');
      else if (norm.state === 'closed') out.push('VOTING_ENDED');
      else if (norm.state === 'cancelled') out.push('PROPOSAL_CANCELLED');
      else out.push('STATE_CHANGED');
    }
    if (norm.state === 'closed' && prevState !== 'closed' && Number.isFinite(norm.scoresTotal)) out.push('FINAL_TALLY_OBSERVED');
    return out;
  }

  // bounded vote retrieval for concentration; budget-gated
  async function fetchConcentration(norm) {
    const votes = [];
    let pagesComplete = false;
    for (let page = 0; page < cfg.maxVotePagesPerProposal; page++) {
      if (!budget.canRequest()) return { concentration: { coverage: 'UNAVAILABLE', coverageReason: 'REQUEST_BUDGET' }, votesCoverage: 'UNAVAILABLE' };
      const batch = await request(() => fetchVotesPage({ proposalId: norm.proposalId, first: cfg.votePageSize, skip: page * cfg.votePageSize }, gqlOpts));
      votes.push(...batch);
      if (batch.length < cfg.votePageSize) {
        pagesComplete = true;
        break;
      }
    }
    const concentration = voterConcentration(votes, { pagesComplete, totalVoteCount: norm.voteCount });
    if (concentration.coverage === 'PARTIAL') counters.partialCoverageCount++;
    return { concentration, votesCoverage: pagesComplete ? 'COMPLETE' : 'PARTIAL' };
  }

  function ingestProposal(norm, proposalPagesCoverage, { withConcentration = null } = {}) {
    const known = tracked.get(norm.proposalId);
    const isNew = !known;
    const prev = known?.norm ?? null; // the immediately-previous observation, for descriptive deltas
    const lifecycles = lifecyclesFor(prev?.state, norm, isNew);
    const fp = changeFingerprint(norm);
    const snapshotDue = !known || now() - known.lastSnapshotEmitMs >= cfg.activeSnapshotSec * 1000;
    const changed = !known || known.fingerprint !== fp;
    const conc = { concentration: withConcentration?.concentration, votesCoverage: withConcentration?.votesCoverage, proposalPagesCoverage };
    let emitted = false;
    if (lifecycles.length) {
      for (const lc of lifecycles) emit(buildObservation(norm, { lifecycle: lc, emitReason: 'LIFECYCLE_TRANSITION', ...conc }, prev));
      emitted = true;
    } else if (norm.state === 'active' && (changed || snapshotDue)) {
      emit(buildObservation(norm, { lifecycle: null, emitReason: changed ? 'TALLY_CHANGED' : 'ACTIVE_SNAPSHOT', ...conc }, prev));
      emitted = true;
    } else {
      counters.eventsSuppressedAsDuplicate++;
    }
    tracked.set(norm.proposalId, {
      norm,
      fingerprint: fp,
      lastSnapshotEmitMs: emitted ? now() : known?.lastSnapshotEmitMs ?? 0,
      final: norm.state === 'closed' || norm.state === 'cancelled', // final truth captured; no further polling
    });
  }

  async function discover() {
    if (!cfg.snapshotEnabled || registry.snapshotSpaces.length === 0) return;
    // fetch the bounded pages FIRST, so coverage truth is known before any
    // observation is written — a capped retrieval is never labeled COMPLETE
    const rows = [];
    let pagesCoverage = 'COMPLETE';
    for (let page = 0; page < cfg.maxProposalPagesPerCycle; page++) {
      if (!budget.canRequest()) {
        pagesCoverage = 'PARTIAL_REQUEST_BUDGET';
        counters.partialCoverageCount++;
        break;
      }
      const raw = await request(() =>
        fetchProposalsPage({ spaceIds: registry.snapshotSpaces, state: 'active', first: cfg.proposalPageSize, skip: page * cfg.proposalPageSize }, gqlOpts)
      );
      rows.push(...raw);
      if (raw.length < cfg.proposalPageSize) break;
      if (page === cfg.maxProposalPagesPerCycle - 1) {
        pagesCoverage = 'PARTIAL_PAGE_LIMIT';
        counters.partialCoverageCount++;
      }
    }
    for (const r of rows) {
      const norm = normalizeProposal(r, textOpts);
      if (!norm) continue; // malformed provider row: refused, never repaired
      if (!tracked.has(norm.proposalId) && activeCount() >= cfg.maxActiveProposals) continue; // hard bound on inspected proposals
      ingestProposal(norm, pagesCoverage);
    }
  }

  const activeCount = () => [...tracked.values()].filter((t) => !t.final).length;

  async function refresh() {
    const ids = [...tracked.entries()].filter(([, t]) => !t.final).map(([id]) => id).slice(0, cfg.maxActiveProposals);
    if (!ids.length || !budget.canRequest()) return;
    // one batched id_in query keeps refresh at a single request
    const raw = await request(async () => {
      const idList = ids.map((i) => `"${String(i).replace(/[\\"]/g, '')}"`).join(', ');
      const q = `{ proposals(first: ${ids.length}, where: { id_in: [${idList}] }) {
        id space { id } author title body state created start end quorum choices scores scores_total votes snapshot updated } }`;
      const data = await snapshotGql(q, gqlOpts);
      return data?.proposals ?? [];
    });
    for (const r of raw) {
      const norm = normalizeProposal(r, textOpts);
      if (!norm) continue;
      let withConcentration = null;
      if (norm.state === 'active' && budget.canRequest()) {
        try {
          withConcentration = await fetchConcentration(norm);
        } catch {
          withConcentration = { concentration: { coverage: 'UNAVAILABLE', coverageReason: 'PROVIDER_ERROR' }, votesCoverage: 'UNAVAILABLE' };
        }
      }
      ingestProposal(norm, 'COMPLETE', { withConcentration });
    }
  }

  function publishStatus() {
    if (stopped) return;
    atomicWriteJson(statusFile(), {
      ts: nowIso(),
      tsMs: now(),
      enabled: true,
      collectorVersion: GOVERNANCE_COLLECTOR_VERSION,
      providers: {
        snapshot: cfg.snapshotEnabled ? 'ENABLED' : 'DISABLED',
        tally: tallyStatus(env, registry), // never the key itself
      },
      lastPollTs,
      lastSuccessTs,
      lastErrorTs,
      errorStreak: budget.failStreak,
      backoffUntil: budget.backoffUntil || null,
      requestsThisHour: budget.hourCount(),
      requestBudget: cfg.requestsPerHour,
      mappedEntities: registry.entries.length,
      registryRejected: registry.rejected.length,
      activeProposals: activeCount(),
      trackedProposals: tracked.size,
      partialCoverageCount: counters.partialCoverageCount,
      eventsEmitted: counters.eventsEmitted,
      eventsSuppressedAsDuplicate: counters.eventsSuppressedAsDuplicate,
      eventsSuppressedAtPollCap: counters.eventsSuppressedAtPollCap,
      requests: counters.requests,
      requestFailures: counters.requestFailures,
    });
  }

  async function tick(force = false) {
    if (stopped || inFlight) return; // single-flight, shutdown-safe
    inFlight = true;
    eventsThisPoll = 0;
    lastPollTs = now();
    try {
      const t = now();
      if (force || t >= nextDiscoveryMs) {
        nextDiscoveryMs = t + cfg.discoverySec * 1000;
        await discover();
      }
      if (force || t >= nextRefreshMs) {
        nextRefreshMs = t + cfg.refreshSec * 1000;
        await refresh();
      }
    } catch {
      // request() already logged, counted, and armed backoff — the sensor
      // fails dark; nothing above it is affected
    } finally {
      publishStatus();
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    tick().catch(() => {}); // belt and braces: a tick can never throw out
  }, intervalMs);
  timer.unref?.();

  const stop = () => {
    if (stopped) return; // idempotent
    stopped = true;
    clearInterval(timer);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  publishStatus();
  log(
    `[${nowIso()}] GOVERNANCE SENSE ON — ${registry.snapshotSpaces.length} verified snapshot space(s), ` +
      `tally ${tallyStatus(env, registry)}, budget ${cfg.requestsPerHour}/hr (dark: observes only, zero trading weight)`
  );
  return { stop, pollOnce: () => tick(true), budget, registry, counters, _tracked: tracked };
}
