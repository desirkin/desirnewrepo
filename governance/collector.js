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
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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

export const GOVERNANCE_COLLECTOR_VERSION = 'GOV-1B';
export const GOV_CHECKPOINT_VERSION = 2;
// startup reconciliation reads at most this much of the source log tail —
// the checkpoint saves every poll, so a larger lag is not reachable in
// ordinary operation (documented limitation if it ever were)
export const RECONCILE_TAIL_BYTES = 1 << 20;
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

// GOV-1B §1-2 — COLLISION-SAFE SOURCE IDENTITY. A canonical key-sorted
// structured basis is hashed, so two different tuples can never collapse
// merely because a delimiter appears inside a provider id (spaceId "a" +
// proposalId "b:c" vs spaceId "a:b" + proposalId "c" hash differently).
// The same source record always reproduces the same identity; crash-window
// dedupe is owned by source-log reconciliation, not by identity reuse.
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(',')}}`;
};
export function governanceEventIdentity(basis) {
  return `govev-${createHash('sha1').update(canonicalJson(basis)).digest('hex')}`;
}

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
  // GOV-1B: durable checkpoint store injected from application composition
  // (persistence adapter) — the collector knows only load()/save(); STORAGE
  // ONLY, never a decision return path. null = local checkpoint only.
  checkpointStore = null,
  // bounded-state test seams (production uses the exported constants)
  maxPendingEvents = MAX_PENDING_EVENTS,
  finalIdCacheMax = FINAL_ID_CACHE_MAX,
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
  let checkpointInvalid = false; // any checkpoint (local or durable) withheld as malformed
  let stopped = false;
  let inFlight = false; // single-flight: no overlapping polls, ever
  let initialized = false; // checkpoint restore + source reconciliation ran
  let lastPollTs = null;
  let lastSuccessTs = null;
  let lastErrorTs = null;
  let nextDiscoveryMs = 0; // conservative start: first discovery waits one interval
  let nextRefreshMs = 0;
  let eventsThisPoll = 0;
  let seqCounter = 0; // monotonic source-log sequence (the checkpoint cursor)
  let reconciledEvents = 0;
  let localCheckpointFailures = 0;
  let durableCheckpointFailures = 0;
  let lastCheckpointPersisted = true; // at least one representation (local or durable) succeeded
  let lastDurableCheckpointTs = null;
  let lastEvidenceDrop = null; // { kind, reason, ts } — explicit, counted data loss

  // ---------- restart checkpoint (GOV-1A §7 / GOV-1B §7-9) ----------
  // STRICT validation before any checkpoint (local or durable) is trusted:
  // a malformed one is withheld, DEGRADED is reported, and truth is rebuilt
  // from the source log where available. Never guessed.
  const validEntry = (e) =>
    e && typeof e === 'object' && typeof e.state === 'string' && typeof e.fingerprint === 'string' &&
    Number.isFinite(e.lastSnapshotEmitMs) && (e.measured === null || typeof e.measured === 'object') &&
    typeof e.spaceId === 'string' && typeof (e.finalObserved ?? false) === 'boolean';
  function validateCheckpoint(cp) {
    if (!cp || typeof cp !== 'object') return 'checkpoint missing/not an object';
    if (cp.version !== GOV_CHECKPOINT_VERSION) return `checkpoint version ${cp.version} unsupported`;
    if (typeof cp.proposals !== 'object' || cp.proposals === null) return 'proposals invalid';
    if (!Array.isArray(cp.finalIds) || cp.finalIds.some((id) => typeof id !== 'string')) return 'finalIds invalid';
    if (!Array.isArray(cp.pending)) return 'pending invalid';
    if (!Number.isInteger(cp.lastSeq) || cp.lastSeq < 0) return 'lastSeq cursor invalid';
    if (typeof cp.savedTs !== 'string') return 'savedTs invalid';
    for (const [id, e] of Object.entries(cp.proposals)) {
      if (typeof id !== 'string' || !validEntry(e)) return `proposal entry ${id} invalid`;
    }
    for (const p of cp.pending) {
      if (!p || typeof p !== 'object' || !p.record || typeof p.record !== 'object' || !p.meta || typeof p.meta !== 'object') return 'pending entry invalid';
    }
    return null;
  }
  function adoptCheckpoint(cp) {
    tracked.clear();
    finalIds.clear();
    pendingEvents.length = 0;
    for (const [id, e] of Object.entries(cp.proposals).slice(0, cfg.maxActiveProposals)) tracked.set(id, { finalObserved: false, ...e });
    for (const id of cp.finalIds.slice(-finalIdCacheMax)) finalIds.set(id, true);
    for (const p of cp.pending.slice(0, maxPendingEvents)) pendingEvents.push(p);
    seqCounter = cp.lastSeq;
  }
  function buildCheckpointState() {
    return {
      version: GOV_CHECKPOINT_VERSION,
      savedTs: new Date(now()).toISOString(),
      lastSeq: seqCounter,
      proposals: Object.fromEntries(tracked),
      finalIds: [...finalIds.keys()],
      pending: pendingEvents.slice(0, maxPendingEvents),
    };
  }
  function saveCheckpointLocal(cp) {
    try {
      atomicWriteJson(checkpointFile(), cp);
      return true;
    } catch (err) {
      localCheckpointFailures++;
      log(`[${nowIso()}] GOVERNANCE local checkpoint write failed (degraded): ${err.message}`);
      return false;
    }
  }
  async function saveCheckpoint() {
    const cp = buildCheckpointState();
    const localOk = saveCheckpointLocal(cp);
    let durableOk = false;
    if (checkpointStore) {
      try {
        durableOk = (await checkpointStore.save(cp))?.durable === true;
      } catch {
        durableOk = false;
      }
      if (durableOk) lastDurableCheckpointTs = now();
      else durableCheckpointFailures++;
    }
    // HONEST DURABILITY LIMIT (GOV-1B §14): restart-safe pending debt is
    // guaranteed only once at least one durable representation succeeded.
    lastCheckpointPersisted = localOk || durableOk;
  }

  // ---------- source-log reconciliation (GOV-1B §5-6) ----------
  // The source stream is a WRITE-AHEAD TRUTH LOG: successfully appended
  // events are authoritative. A stale checkpoint is repaired FORWARD by
  // replaying validated source records with seq beyond the checkpoint
  // cursor — bounded to the log tail, torn lines counted, provider truth
  // never invented, source events never rewritten or deleted.
  function readSourceTail() {
    const file = eventsFile();
    try {
      if (!existsSync(file)) return [];
      const size = statSync(file).size;
      const start = Math.max(0, size - RECONCILE_TAIL_BYTES);
      const fd = openSync(file, 'r');
      let text;
      try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
      const lines = text.split('\n');
      const out = [];
      for (let i = start === 0 ? 0 : 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch {
          counters.sourceWriteFailures++; // torn/malformed source line: counted, fail dark
        }
      }
      return out;
    } catch (err) {
      log(`[${nowIso()}] GOVERNANCE source reconciliation read failed (contained): ${err.message}`);
      return [];
    }
  }
  function reconcileFromSource() {
    const replayedIds = new Set();
    const records = readSourceTail()
      .filter((r) => r && r.type === 'GOVERNANCE_OBSERVATION' && typeof r.proposalId === 'string' && Number.isInteger(r.seq) && r.seq > seqCounter)
      .sort((a, b) => a.seq - b.seq);
    for (const r of records) {
      seqCounter = Math.max(seqCounter, r.seq);
      reconciledEvents++;
      if (typeof r.sourceEventId === 'string') replayedIds.add(r.sourceEventId);
      const lc = r.lifecycleTransition;
      if (lc === 'FINAL_TALLY_OBSERVED' || lc === 'PROPOSAL_CANCELLED') {
        finalizeProposal(r.proposalId); // final truth already durably appended
        continue;
      }
      if (finalIds.has(r.proposalId)) continue;
      const prev = tracked.get(r.proposalId);
      tracked.set(r.proposalId, {
        state: typeof r.proposalState === 'string' ? r.proposalState : prev?.state ?? 'active',
        spaceId: typeof r.spaceId === 'string' ? r.spaceId : prev?.spaceId ?? '',
        fingerprint: typeof r.stateFingerprint === 'string' ? r.stateFingerprint : prev?.fingerprint ?? '',
        lastSnapshotEmitMs: Date.parse(r.ts) || prev?.lastSnapshotEmitMs || 0,
        measured: { scoresTotal: r.voteTotals?.scoresTotal ?? null, voteCount: r.voteTotals?.voteCount ?? null },
        finalObserved: false,
      });
    }
    // owed evidence the log already proves durable is no longer owed
    if (replayedIds.size) {
      const before = pendingEvents.length;
      const kept = pendingEvents.filter((p) => !replayedIds.has(p.record?.sourceEventId));
      pendingEvents.length = 0;
      pendingEvents.push(...kept);
      if (before !== pendingEvents.length) log(`[${nowIso()}] GOVERNANCE reconciliation settled ${before - pendingEvents.length} already-appended pending event(s)`);
    }
  }

  async function ensureInit() {
    if (initialized) return;
    initialized = true;
    // durable checkpoint is the restart/redeploy authority when configured
    // and valid; the local atomic file is the fast fallback copy
    let adopted = false;
    if (checkpointStore) {
      try {
        const cp = await checkpointStore.load();
        if (cp !== null) {
          const bad = validateCheckpoint(cp);
          if (bad) {
            checkpointInvalid = true;
            log(`[${nowIso()}] GOVERNANCE durable checkpoint withheld (DEGRADED): ${bad}`);
          } else {
            adoptCheckpoint(cp);
            adopted = true;
          }
        }
      } catch (err) {
        log(`[${nowIso()}] GOVERNANCE durable checkpoint load failed (falling back): ${err.message}`);
      }
    }
    if (!adopted && existsSync(checkpointFile())) {
      try {
        const cp = JSON.parse(readFileSync(checkpointFile(), 'utf8'));
        const bad = validateCheckpoint(cp);
        if (bad) throw new Error(bad);
        adoptCheckpoint(cp);
        adopted = true;
      } catch (err) {
        checkpointInvalid = true;
        log(`[${nowIso()}] GOVERNANCE local checkpoint invalid — reconciling from source truth (DEGRADED): ${err.message}`);
      }
    }
    // the checkpoint may LAG the source log; it may not rewrite what the
    // log already proved — reconcile forward before any provider polling
    reconcileFromSource();
  }

  // ---------- durable ACK + bounded pending debt (GOV-1A §1-3, §24) ----------
  // append succeeded => the event is acknowledged. Cap reached or write
  // failure => the evidence stays owed. Nothing is silently lost.
  function tryAppend(record) {
    if (stopped) return false; // a poll finishing during shutdown writes nothing further
    if (eventsThisPoll >= cfg.maxEventsPerPoll) return false;
    // the source-log sequence (checkpoint cursor) is assigned at the moment
    // of the SUCCESSFUL append attempt, so reconciliation can order and
    // bound its replay deterministically
    const line = { ...record, seq: seqCounter + 1 };
    try {
      appendJsonl(eventsFile(), line);
    } catch (err) {
      counters.sourceWriteFailures++;
      lastErrorTs = now();
      log(`[${nowIso()}] GOVERNANCE source append FAILED — evidence kept pending: ${err.message}`);
      return false;
    }
    seqCounter++;
    counters.eventsEmitted++;
    eventsThisPoll++;
    return true;
  }

  function ackMeta(meta) {
    if (meta.finalizes) finalizeProposal(meta.proposalId);
  }

  function finalizeProposal(proposalId) {
    // final truth safely appended: release the heavy tracked state, keep a
    // compact bounded final-ID record for restart/dedupe (GOV-1A §18).
    // The cache is BOUNDED, so its guarantee is bounded too: a proposal is
    // not re-discovered while its id is retained; discovery only asks for
    // pending/active states, so a closed proposal normally never resurfaces
    // anyway. If a provider resurfaces one after eviction, it is treated as
    // a new re-observed fact with its own honest identity — old canonical
    // history is never overwritten and no id/content conflict can result.
    if (tracked.delete(proposalId)) counters.finalizedReleased++;
    finalIds.set(proposalId, true);
    while (finalIds.size > finalIdCacheMax) finalIds.delete(finalIds.keys().next().value);
  }

  // GOV-1B §15: a pending-cap drop is DATA LOSS, even when explicit — it is
  // counted, identified by kind and reason, degrades health, and is never
  // called successfully remembered. Snapshot-kind entries are evicted before
  // lifecycle evidence; a dropped record's proposal state is reverted by the
  // caller so provider truth re-derives later under a fresh honest identity.
  function recordDrop(kind) {
    counters.eventsDroppedAtPendingCap++;
    lastEvidenceDrop = { kind, reason: 'PENDING_CAP', ts: new Date(now()).toISOString() };
  }
  // returns 'ACKED' | 'QUEUED' | 'DROPPED'
  function emitObservation(record, meta) {
    if (tryAppend(record)) {
      ackMeta(meta);
      return 'ACKED';
    }
    if (pendingEvents.length >= maxPendingEvents) {
      const idx = pendingEvents.findIndex((p) => p.meta.kind === 'SNAPSHOT');
      if (idx === -1 && meta.kind === 'SNAPSHOT') {
        recordDrop('SNAPSHOT');
        return 'DROPPED';
      }
      if (idx !== -1) {
        pendingEvents.splice(idx, 1);
        recordDrop('SNAPSHOT');
      } else {
        recordDrop(meta.kind);
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
    const stateFingerprint = changeFingerprint(norm);
    // deterministic COLLISION-SAFE source identity (GOV-1B §1-2): a hashed
    // canonical structured basis — no delimiter joining, so provider ids
    // containing separators can never collapse two different tuples into
    // one identity. The exact same source record reproduces the same id;
    // crash-window dedupe is owned by source-log reconciliation.
    const sourceEventId = governanceEventIdentity({
      provider: norm.provider,
      entityId: norm.spaceId,
      proposalId: norm.proposalId,
      kind: lifecycle ? 'LIFECYCLE' : 'SNAPSHOT',
      lifecycle: lifecycle ?? null,
      state: norm.state,
      stateFingerprint,
      providerUpdatedTs: norm.updatedTs ?? null,
      observedTs: retrievedIso,
    });
    return {
      stateFingerprint,
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
    // GOV-1B crash repair: a proposal reconciled as closed whose FINAL
    // evidence never reached the log (lost pre-append) still owes its final
    // tally — captured late, under a fresh honest identity
    if (
      !lifecycles.includes('FINAL_TALLY_OBSERVED') &&
      norm.state === 'closed' &&
      known?.state === 'closed' &&
      known.finalObserved !== true &&
      Number.isFinite(norm.scoresTotal)
    ) {
      lifecycles.push('FINAL_TALLY_OBSERVED');
    }
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
      finalObserved: known?.finalObserved === true || records.some((r) => r.record.lifecycleTransition === 'FINAL_TALLY_OBSERVED'),
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
    const degraded = counters.sourceWriteFailures > 0 || counters.eventsDroppedAtPendingCap > 0 || checkpointInvalid || !lastCheckpointPersisted;
    // HONEST DURABILITY LIMIT (§14): when every checkpoint representation
    // failed while evidence is owed, the debt exists only in RAM — say so.
    const failedDurability = !lastCheckpointPersisted && pendingEvents.length > 0;
    atomicWriteJson(statusFile(), {
      ts: nowIso(),
      tsMs: now(),
      enabled: true,
      status: failedDurability ? 'FAILED_DURABILITY' : degraded ? 'DEGRADED' : 'HEALTHY',
      unpersistedPendingEvidence: lastCheckpointPersisted ? 0 : pendingEvents.length,
      lastEvidenceDrop,
      lastSeq: seqCounter,
      reconciledEvents,
      localCheckpointFailures,
      durableCheckpointFailures,
      durableCheckpoint: checkpointStore ? (lastDurableCheckpointTs ? 'SAVED' : 'NOT_YET_SAVED') : 'NOT_CONFIGURED',
      lastDurableCheckpointTs,
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
      await ensureInit(); // checkpoint restore + source reconciliation FIRST
      drainPending(); // owed evidence next — debt drains before new work
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
      if (!stopped) await saveCheckpoint(); // durability truth first…
      publishStatus(); // …so status reports it honestly
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    tick().catch(() => {}); // belt and braces: a tick can never throw out
  }, intervalMs);
  timer.unref?.();

  const stop = () => {
    if (stopped) return; // idempotent
    if (initialized) {
      const cp = buildCheckpointState();
      saveCheckpointLocal(cp); // synchronous local save
      if (checkpointStore) Promise.resolve(checkpointStore.save(cp)).catch(() => {}); // best-effort durable
    }
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
