// GOV-1 / GOV-1A — the DARK GOVERNANCE SENSE. Observes verified governance
// spaces (Snapshot; Tally is scaffolding behind a key) and appends bounded
// truthful observations to data/governance/events.jsonl. The Memory mirror
// tails that stream; this collector never touches the MemoryBus, Memory
// files, attention, stalking, posture, trading, or the UI. GOV LISTENS AND
// REMEMBERS. It does not vote, nominate, or predict.
//
// GOV-1A truth hardening:
//  - DURABLE ACK: a governance event counts only after its source JSONL
//    append actually succeeded. The event cap and write failures POSTPONE
//    evidence into a bounded pending queue — they never erase it, and
//    proposal state/finality never advances past evidence that was neither
//    written nor safely queued.
//  - SPACING-AWARE PAGINATION: minimum request spacing decides WHEN a
//    permitted request happens (bounded waits), never masquerading as
//    budget exhaustion. Partial vote evidence already retrieved is KEPT and
//    labeled PARTIAL with its exact stop reason.
//  - RESTART CHECKPOINT: a small bounded atomic checkpoint preserves
//    per-proposal state, pending evidence, and a compact final-ID cache, so
//    a restart neither re-discovers old proposals nor mints new canonical
//    identities for old events. Source events carry deterministic
//    sourceEventId values.
//  - PENDING PROPOSALS are discovered before voting starts, so the ordinary
//    pending -> active chronology yields a REAL VOTING_STARTED.
//  - COVERAGE HONESTY: the active-proposal cap and page/budget bounds mark
//    the cycle PARTIAL with explicit reasons and counters. Governance may
//    miss something because a bound was reached; it may not pretend it saw
//    everything.
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
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

export const GOVERNANCE_COLLECTOR_VERSION = 'GOV-1A';
export const GOV_CHECKPOINT_VERSION = 1;
// pending-evidence bound: with maxActiveProposals <= 100 and <= 3 lifecycle
// records per transition (+1 snapshot), lifecycle evidence can never
// overflow this; snapshot-kind entries are evicted first if it ever fills.
export const MAX_PENDING_EVENTS = 512;
export const FINAL_ID_CACHE_MAX = 256; // compact restart/dedupe memory of finalized proposals

const eventsFile = () => path.join(dataDir(), 'governance', 'events.jsonl');
const statusFile = () => path.join(dataDir(), 'governance', 'status.json');
const checkpointFile = () => path.join(dataDir(), 'governance', 'checkpoint.json');

// Named, documented bounds. Conservative by default — Snapshot's public
// ceiling is far above this, deliberately.
export const GOV_DEFAULTS = Object.freeze({
  enabled: false, // dark unless cobra.config.json carries governance.enabled: true
  snapshotEnabled: true, // provider gate inside an enabled sensor
  discoverySec: 180, // new pending/active proposal discovery (~2-5 min band)
  refreshSec: 300, // tracked proposal tally refresh
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

// GOV-1A strict config validation: exact documented types (booleans are
// booleans, integer bounds are positive integers inside hard maxima). Bad
// bounds FAIL CLOSED: the sensor disables itself and reports why — nothing
// else in Serpent is affected.
const INT_BOUNDS = Object.freeze({
  discoverySec: [60, 86_400],
  refreshSec: [60, 86_400],
  activeSnapshotSec: [60, 86_400],
  timeoutMs: [1_000, 60_000],
  requestsPerHour: [1, 600],
  minSpacingMs: [1, 60_000],
  backoffBaseSec: [1, 3_600],
  backoffMaxSec: [1, 7_200],
  backoff429Sec: [1, 7_200],
  proposalPageSize: [1, 100],
  maxProposalPagesPerCycle: [1, 10],
  votePageSize: [1, 1_000],
  maxVotePagesPerProposal: [1, 10],
  maxMappedSymbols: [1, 64], // absolute system ceiling stays 64
  maxActiveProposals: [1, 100],
  maxEventsPerPoll: [1, 200],
  maxProposalTextBytes: [64, 16_384],
  maxTitleBytes: [16, 1_024],
});

export function governanceConfig(config = loadConfig()) {
  const raw = config.governance ?? {};
  const cfg = { ...GOV_DEFAULTS, ...raw };
  const errors = [];
  for (const k of ['enabled', 'snapshotEnabled']) {
    if (typeof cfg[k] !== 'boolean') errors.push(`governance.${k} must be a boolean, not ${JSON.stringify(cfg[k])}`);
  }
  for (const [k, [lo, hi]] of Object.entries(INT_BOUNDS)) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < lo || cfg[k] > hi) {
      errors.push(`governance.${k} must be an integer in [${lo}, ${hi}]`);
    }
  }
  const enabled = cfg.enabled === true && errors.length === 0;
  return { enabled, requested: cfg.enabled === true, cfg, errors };
}

// Request budget: hourly cap + spacing + backoff, a pure state machine over
// timestamps (own copy — governance imports nothing from other sensors).
// GOV-1A: blockReason() distinguishes SPACING (wait, then proceed) from
// genuine denial (hourly budget, backoff) so spacing can never masquerade
// as budget exhaustion.
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

  blockReason() {
    const t = this.now();
    if (t < this.backoffUntil) return 'BACKOFF';
    if (t - this.lastReqMs < this.minSpacingMs) return 'SPACING';
    this.stamps = this.stamps.filter((s) => t - s < 3_600_000);
    return this.stamps.length < this.requestsPerHour ? null : 'REQUEST_BUDGET';
  }

  canRequest() {
    return this.blockReason() === null;
  }

  spacingRemainingMs() {
    return Math.max(0, this.minSpacingMs - (this.now() - this.lastReqMs));
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

// meaningful-change fingerprint over PROVIDER fields only — deterministic
// across restarts; identical polls of an unchanged proposal do not spam the
// source stream (suppressed and counted instead)
const changeFingerprint = (p) => `${p.state}|${p.scoresTotal ?? 'x'}|${p.voteCount ?? 'x'}|${p.updatedTs ?? 'x'}`;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startGovernance({
  log = console.log,
  config = loadConfig(),
  fetchImpl = fetch,
  now = Date.now,
  sleepImpl = defaultSleep,
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
  // GOV-1A: cfg.maxMappedSymbols is ENFORCED on the loaded registry (the
  // absolute ceiling 64 still stands inside loadRegistry)
  const registry = loadRegistry(registryEntries, { cap: cfg.maxMappedSymbols });
  for (const r of registry.rejected) log(`[${nowIso()}] GOVERNANCE registry entry rejected: ${r.errors.join('; ')}`);
  const budget = new GovBudget(cfg, now);
  const gqlOpts = { fetchImpl, timeoutMs: cfg.timeoutMs };
  const textOpts = { maxTitleBytes: cfg.maxTitleBytes, maxBodyBytes: cfg.maxProposalTextBytes };

  // proposalId -> { state, fingerprint, lastSnapshotEmitMs, measured, spaceId }
  // (compact — proposal bodies and vote arrays are never retained here)
  const tracked = new Map();
  const finalIds = new Map(); // proposalId -> final fingerprint (compact, bounded restart/dedupe cache)
  const pendingEvents = []; // owed evidence: { record, meta } — bounded, drained first every poll
  const counters = {
    eventsEmitted: 0,
    eventsSuppressedAsDuplicate: 0,
    eventsPendingHighWater: 0,
    eventsDroppedAtPendingCap: 0,
    sourceWriteFailures: 0,
    requests: 0,
    requestFailures: 0,
    partialCoverageCount: 0,
    proposalsObserved: 0,
    proposalsSkippedAtActiveCap: 0,
    finalizedReleased: 0,
  };
  let checkpointInvalid = false;
  let stopped = false;
  let inFlight = false; // single-flight: no overlapping polls, ever
  let lastPollTs = null;
  let lastSuccessTs = null;
  let lastErrorTs = null;
  let nextDiscoveryMs = 0; // conservative start: first discovery waits one interval
  let nextRefreshMs = 0;
  let eventsThisPoll = 0;

  // ---------- restart checkpoint (GOV-1A §7): small, bounded, atomic ----------
  const validEntry = (e) =>
    e && typeof e === 'object' && typeof e.state === 'string' && typeof e.fingerprint === 'string' &&
    Number.isFinite(e.lastSnapshotEmitMs) && (e.measured === null || typeof e.measured === 'object') &&
    typeof e.spaceId === 'string';
  function loadCheckpoint() {
    try {
      if (!existsSync(checkpointFile())) return;
      const cp = JSON.parse(readFileSync(checkpointFile(), 'utf8'));
      if (cp.version !== GOV_CHECKPOINT_VERSION || typeof cp.proposals !== 'object' || !Array.isArray(cp.finalIds) || !Array.isArray(cp.pending)) {
        throw new Error('checkpoint shape invalid');
      }
      for (const [id, e] of Object.entries(cp.proposals)) {
        if (!validEntry(e)) throw new Error(`checkpoint proposal ${id} invalid`);
      }
      for (const [id, e] of Object.entries(cp.proposals).slice(0, cfg.maxActiveProposals)) tracked.set(id, e);
      for (const id of cp.finalIds.slice(-FINAL_ID_CACHE_MAX)) {
        if (typeof id === 'string') finalIds.set(id, true);
      }
      for (const p of cp.pending.slice(0, MAX_PENDING_EVENTS)) {
        if (p && typeof p === 'object' && p.record && p.meta) pendingEvents.push(p);
      }
    } catch (err) {
      // malformed checkpoint: fail dark/degraded, start empty — never guess,
      // never stop the rest of Serpent
      checkpointInvalid = true;
      tracked.clear();
      finalIds.clear();
      pendingEvents.length = 0;
      log(`[${nowIso()}] GOVERNANCE checkpoint invalid — starting empty, DEGRADED: ${err.message}`);
    }
  }
  function saveCheckpoint() {
    try {
      atomicWriteJson(checkpointFile(), {
        version: GOV_CHECKPOINT_VERSION,
        savedTs: new Date(now()).toISOString(),
        proposals: Object.fromEntries(tracked),
        finalIds: [...finalIds.keys()],
        pending: pendingEvents.slice(0, MAX_PENDING_EVENTS),
      });
    } catch (err) {
      counters.sourceWriteFailures++;
      log(`[${nowIso()}] GOVERNANCE checkpoint write failed (degraded): ${err.message}`);
    }
  }

  // ---------- durable ACK + bounded pending debt (GOV-1A §1-3, §24) ----------
  // append succeeded => the event is acknowledged. Cap reached or write
  // failure => the evidence stays owed. Nothing is silently lost.
  function tryAppend(record) {
    if (stopped) return false; // a poll finishing during shutdown writes nothing further
    if (eventsThisPoll >= cfg.maxEventsPerPoll) return false;
    try {
      appendJsonl(eventsFile(), record);
    } catch (err) {
      counters.sourceWriteFailures++;
      lastErrorTs = now();
      log(`[${nowIso()}] GOVERNANCE source append FAILED — evidence kept pending: ${err.message}`);
      return false;
    }
    counters.eventsEmitted++;
    eventsThisPoll++;
    return true;
  }

  function ackMeta(meta) {
    if (meta.finalizes) finalizeProposal(meta.proposalId);
  }

  function finalizeProposal(proposalId) {
    // final truth safely appended: release the heavy tracked state, keep a
    // compact bounded final-ID record for restart/dedupe (GOV-1A §18)
    if (tracked.delete(proposalId)) counters.finalizedReleased++;
    finalIds.set(proposalId, true);
    while (finalIds.size > FINAL_ID_CACHE_MAX) finalIds.delete(finalIds.keys().next().value);
  }

  // returns 'ACKED' | 'QUEUED' | 'DROPPED'
  function emitObservation(record, meta) {
    if (tryAppend(record)) {
      ackMeta(meta);
      return 'ACKED';
    }
    if (pendingEvents.length >= MAX_PENDING_EVENTS) {
      // evict a snapshot-kind entry first — periodic snapshots are
      // re-derivable at cadence; lifecycle evidence is not
      const idx = pendingEvents.findIndex((p) => p.meta.kind === 'SNAPSHOT');
      if (idx === -1 && meta.kind === 'SNAPSHOT') {
        counters.eventsDroppedAtPendingCap++;
        return 'DROPPED';
      }
      if (idx !== -1) {
        pendingEvents.splice(idx, 1);
        counters.eventsDroppedAtPendingCap++;
      } else {
        counters.eventsDroppedAtPendingCap++;
        return 'DROPPED';
      }
    }
    pendingEvents.push({ record, meta });
    counters.eventsPendingHighWater = Math.max(counters.eventsPendingHighWater, pendingEvents.length);
    return 'QUEUED';
  }

  function drainPending() {
    while (pendingEvents.length) {
      const { record, meta } = pendingEvents[0];
      if (!tryAppend(record)) break; // cap/write failure: still owed, retried next poll
      pendingEvents.shift();
      ackMeta(meta);
    }
  }

  // ---------- spacing-aware request slot (GOV-1A §4) ----------
  // SPACING waits (bounded); BACKOFF and the hourly budget deny truthfully.
  async function acquireSlot() {
    for (let i = 0; i < 12; i++) {
      const r = budget.blockReason();
      if (r === null) return { ok: true };
      if (r !== 'SPACING') return { ok: false, reason: r === 'BACKOFF' ? 'BACKOFF_ACTIVE' : 'REQUEST_BUDGET' };
      await sleepImpl(budget.spacingRemainingMs() + 1);
    }
    return { ok: false, reason: 'SPACING_DEFERRED' }; // bounded paranoia: a clock that never advances
  }

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

  // ---------- observation building ----------
  function buildObservation(norm, { lifecycle, emitReason, concentration, votesCoverage, proposalPagesCoverage }, prevMeasured = null) {
    const entry = registry.entryForSpace(norm.spaceId);
    const nowSec = Math.floor(now() / 1000);
    const retrievedIso = new Date(now()).toISOString();
    // deterministic source identity (GOV-1A §8): a restart re-retrieving the
    // same provider event never mints a new canonical identity; a genuinely
    // changed state (new fingerprint / new retrieval of a periodic snapshot)
    // remains a genuinely new observation
    const sourceEventId = lifecycle
      ? `${norm.provider}:${norm.spaceId}:${norm.proposalId}:${lifecycle}${lifecycle === 'STATE_CHANGED' ? `:${norm.state}` : ''}`
      : `${norm.provider}:${norm.spaceId}:${norm.proposalId}:SNAPSHOT:${changeFingerprint(norm)}:${retrievedIso}`;
    return {
      ts: retrievedIso,
      type: 'GOVERNANCE_OBSERVATION',
      provider: norm.provider,
      providerKind: 'snapshot hub graphql (off-chain voting)',
      collectorVersion: GOVERNANCE_COLLECTOR_VERSION,
      lifecycleTransition: lifecycle ?? null,
      emitReason,
      sourceEventId,
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
      trajectory: voteTrajectory(norm, nowSec, prevMeasured),
      voterConcentration: concentration ?? { coverage: 'UNAVAILABLE', coverageReason: 'NOT_REQUESTED_THIS_CYCLE' },
      timelock: 'UNKNOWN', // no timelock evidence exists in snapshot data
      executionState: 'UNKNOWN', // idem — an on-chain provider may know later
      coverage: { proposalPages: proposalPagesCoverage, votePages: votesCoverage ?? 'UNAVAILABLE' },
      title: norm.title,
      bodyExcerpt: norm.bodyExcerpt,
      textHash: norm.textHash,
      providerUrl: norm.providerUrl,
      retrievedTs: retrievedIso,
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

  // bounded vote retrieval for concentration. GOV-1A §5: evidence already
  // retrieved is NEVER discarded — an interrupted continuation yields a
  // PARTIAL concentration over the fetched votes with its exact stop reason;
  // UNAVAILABLE only when nothing usable was retrieved.
  async function fetchConcentration(norm) {
    const votes = [];
    let pagesComplete = false;
    let stopReason = null;
    for (let page = 0; page < cfg.maxVotePagesPerProposal; page++) {
      const slot = await acquireSlot();
      if (!slot.ok) {
        stopReason = slot.reason;
        break;
      }
      let batch;
      try {
        batch = await request(() => fetchVotesPage({ proposalId: norm.proposalId, first: cfg.votePageSize, skip: page * cfg.votePageSize }, gqlOpts));
      } catch {
        stopReason = 'PROVIDER_ERROR';
        break;
      }
      votes.push(...batch);
      if (batch.length < cfg.votePageSize) {
        pagesComplete = true;
        break;
      }
      if (page === cfg.maxVotePagesPerProposal - 1) stopReason = 'PAGE_LIMIT';
    }
    if (!votes.length) {
      return { concentration: { coverage: 'UNAVAILABLE', coverageReason: stopReason ?? 'NO_VOTES_RETRIEVED', observedVoterCount: 0 }, votesCoverage: 'UNAVAILABLE' };
    }
    const concentration = voterConcentration(votes, { pagesComplete, totalVoteCount: norm.voteCount });
    if (concentration.coverage === 'PARTIAL') {
      if (stopReason) concentration.coverageReason = stopReason; // the exact truth beats the generic label
      counters.partialCoverageCount++;
    }
    return { concentration, votesCoverage: concentration.coverage === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL' };
  }

  // ---------- proposal ingestion (ACK-aware) ----------
  function ingestProposal(norm, proposalPagesCoverage, { withConcentration = null } = {}) {
    if (finalIds.has(norm.proposalId)) return; // final truth already captured and acknowledged
    const known = tracked.get(norm.proposalId);
    const isNew = !known;
    const prevMeasured = known?.measured ?? null;
    const lifecycles = lifecyclesFor(known?.state, norm, isNew);
    const fp = changeFingerprint(norm);
    const snapshotDue = !known || now() - (known.lastSnapshotEmitMs ?? 0) >= cfg.activeSnapshotSec * 1000;
    const changed = !known || known.fingerprint !== fp;
    const conc = { concentration: withConcentration?.concentration, votesCoverage: withConcentration?.votesCoverage, proposalPagesCoverage };
    const finalizing = norm.state === 'closed' || norm.state === 'cancelled';
    const records = [];
    if (lifecycles.length) {
      for (const lc of lifecycles) {
        records.push({
          record: buildObservation(norm, { lifecycle: lc, emitReason: 'LIFECYCLE_TRANSITION', ...conc }, prevMeasured),
          meta: { proposalId: norm.proposalId, kind: 'LIFECYCLE', finalizes: finalizing && lc === lifecycles.at(-1) },
        });
      }
    } else if ((norm.state === 'active' || norm.state === 'pending') && (changed || snapshotDue)) {
      records.push({
        record: buildObservation(norm, { lifecycle: null, emitReason: changed ? 'TALLY_CHANGED' : 'ACTIVE_SNAPSHOT', ...conc }, prevMeasured),
        meta: { proposalId: norm.proposalId, kind: 'SNAPSHOT', finalizes: false },
      });
    } else {
      counters.eventsSuppressedAsDuplicate++;
    }
    // advance tracked state BEFORE emission so a synchronous final ACK can
    // release it; revert if any evidence could be neither written nor queued
    const prevEntry = known ? { ...known } : null;
    tracked.set(norm.proposalId, {
      state: norm.state,
      spaceId: norm.spaceId,
      fingerprint: fp,
      lastSnapshotEmitMs: records.length ? now() : known?.lastSnapshotEmitMs ?? 0,
      measured: { scoresTotal: norm.scoresTotal ?? null, voteCount: norm.voteCount ?? null },
    });
    let placedAll = true;
    for (const r of records) {
      const st = emitObservation(r.record, r.meta);
      if (st === 'DROPPED') placedAll = false;
    }
    if (!placedAll) {
      // evidence lost even to the queue (bounded-overflow extreme): do NOT
      // advance past it — restore the prior view so the next poll re-derives
      if (prevEntry) tracked.set(norm.proposalId, prevEntry);
      else tracked.delete(norm.proposalId);
      return;
    }
    counters.proposalsObserved++;
  }

  const activeCount = () => [...tracked.values()].filter((t) => t.state === 'active' || t.state === 'pending').length;

  // ---------- discovery: PENDING and ACTIVE proposals (GOV-1A §10) ----------
  async function discover() {
    if (!cfg.snapshotEnabled || registry.snapshotSpaces.length === 0) return;
    const rows = [];
    let pagesCoverage = 'COMPLETE';
    for (const state of ['pending', 'active']) {
      for (let page = 0; page < cfg.maxProposalPagesPerCycle; page++) {
        const slot = await acquireSlot();
        if (!slot.ok) {
          pagesCoverage = `PARTIAL_${slot.reason}`;
          counters.partialCoverageCount++;
          break;
        }
        const raw = await request(() =>
          fetchProposalsPage({ spaceIds: registry.snapshotSpaces, state, first: cfg.proposalPageSize, skip: page * cfg.proposalPageSize }, gqlOpts)
        );
        rows.push(...raw);
        if (raw.length < cfg.proposalPageSize) break;
        if (page === cfg.maxProposalPagesPerCycle - 1) {
          pagesCoverage = 'PARTIAL_PAGE_LIMIT';
          counters.partialCoverageCount++;
        }
      }
    }
    // normalize first, THEN decide admission, so the active-proposal cap is
    // reflected in the coverage label of everything written this cycle
    const seen = new Set();
    const norms = [];
    for (const r of rows) {
      const norm = normalizeProposal(r, textOpts);
      if (!norm || seen.has(norm.proposalId)) continue; // malformed refused; duplicates collapsed
      seen.add(norm.proposalId);
      norms.push(norm);
    }
    let admitted = [];
    let skipped = 0;
    let headroom = cfg.maxActiveProposals - activeCount();
    for (const norm of norms) {
      if (tracked.has(norm.proposalId) || finalIds.has(norm.proposalId)) {
        admitted.push(norm);
      } else if (headroom > 0) {
        headroom--;
        admitted.push(norm);
      } else {
        skipped++;
      }
    }
    if (skipped > 0) {
      pagesCoverage = 'PARTIAL_ACTIVE_PROPOSAL_CAP'; // the provider page may be complete; OUR processing was not
      counters.proposalsSkippedAtActiveCap += skipped;
      counters.partialCoverageCount++;
    }
    for (const norm of admitted) ingestProposal(norm, pagesCoverage);
  }

  async function refresh() {
    const ids = [...tracked.entries()]
      .filter(([, t]) => t.state === 'active' || t.state === 'pending')
      .map(([id]) => id)
      .slice(0, cfg.maxActiveProposals);
    if (!ids.length) return;
    const slot = await acquireSlot();
    if (!slot.ok) return;
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
      if (norm.state === 'active') {
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
    const degraded = counters.sourceWriteFailures > 0 || counters.eventsDroppedAtPendingCap > 0 || checkpointInvalid;
    atomicWriteJson(statusFile(), {
      ts: nowIso(),
      tsMs: now(),
      enabled: true,
      status: degraded ? 'DEGRADED' : 'HEALTHY',
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
      finalIdCacheSize: finalIds.size,
      pendingEvents: pendingEvents.length,
      checkpointInvalid,
      partialCoverageCount: counters.partialCoverageCount,
      eventsEmitted: counters.eventsEmitted,
      eventsSuppressedAsDuplicate: counters.eventsSuppressedAsDuplicate,
      eventsDroppedAtPendingCap: counters.eventsDroppedAtPendingCap,
      sourceWriteFailures: counters.sourceWriteFailures,
      proposalsObserved: counters.proposalsObserved,
      proposalsSkippedAtActiveCap: counters.proposalsSkippedAtActiveCap,
      finalizedReleased: counters.finalizedReleased,
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
      drainPending(); // owed evidence first — debt drains before new work
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
      if (!stopped) saveCheckpoint();
      inFlight = false;
    }
  }

  loadCheckpoint();

  const timer = setInterval(() => {
    tick().catch(() => {}); // belt and braces: a tick can never throw out
  }, intervalMs);
  timer.unref?.();

  const stop = () => {
    if (stopped) return; // idempotent
    saveCheckpoint(); // owed evidence and proposal state survive the restart
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
  return { stop, pollOnce: () => tick(true), budget, registry, counters, _tracked: tracked, _pending: pendingEvents, _finalIds: finalIds };
}
