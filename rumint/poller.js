// RUMINT-R1 tiered poller — the armed, DURABLE ears. Polls StockTwits within
// the S-1 budget and does exactly two things with the results: nominate
// arming (COILED -> STALKING, per symbol) and publish the ONE canonical
// HYPED snapshot. It can never advance STALKING -> STRIKE; no strike path
// imports this module or anything it writes.
//
// R1 discipline, mirroring the accepted GOV collector architecture:
//   - durable init gate: statistical authority initializes from the durable
//     checkpoint (tri-state load) BEFORE any nomination/HYPED output; a
//     configured-but-unreachable durable core WITHHOLDS and retries — an
//     empty baseline is never silently invented ("no signal" must never
//     mean "I lost my baseline").
//   - evidence-first ACK: a poll's baseline advancement is adopted only
//     after its evidence is appended or held as bounded pending debt (§45);
//     nomination evidence lands BEFORE stalk() (§47).
//   - CANCEL shutdown: stopped is set FIRST, in-flight provider work is
//     aborted, and no response may mutate accepted state after stop (§55).
//   - failure is never permanent deafness: bounded 15/30/60m cooldowns with
//     probes and RECOVERED transitions, persisted across republish (§48-49).
import path from 'node:path';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { rumintEnabled, fetchSymbolPage, readLocalCheckpoint } from './stocktwits.js';
import {
  RUMINT_CHECKPOINT_VERSION,
  PROVIDER,
  MAX_PENDING_EVENTS,
  MAX_REQUEST_STAMPS,
  MAX_SYMBOLS,
  MAX_BUCKET_HOURS,
  COVERAGE_SAMPLED,
  COVERAGE_BOOTSTRAPPED,
  canonicalMessageId,
  idGreater,
  boundedError,
  emptyBaseline,
  ingestPage,
  signalFromBaseline,
  hypedSnapshot,
  pollEventIdentity,
  nominationEventIdentity,
  utcHourKey,
  validateCheckpoint,
  validateSourceRecord,
  validatePendingEntry,
  nominationQualifies,
  hypedBasisFromBaselines,
  providerSymbolFor,
  canonicalJson,
} from './truth.js';
import { stalk, readStalking, writeHyped } from '../state/stalking.js';

export const RUMINT_COLLECTOR_VERSION = 'RUMINT-R1A';
// The mapping now lives in the pure truth core (it is a checkpoint
// invariant, not a poller detail); re-exported here for existing consumers.
export { providerSymbolFor } from './truth.js';

const eventsFile = () => path.join(dataDir(), 'rumint', 'events.jsonl');
const statusFile = () => path.join(dataDir(), 'rumint', 'status.json');
const checkpointFile = () => path.join(dataDir(), 'rumint', 'checkpoint.json');

// Nomination rule — the one and only arming trigger, UNCHANGED semantics.
// R1B: the producer shares the SAME pure predicate the source validator
// enforces (rumint/truth.js nominationQualifies) — the rule cannot fork.
export function shouldNominate(signal, config = loadConfig()) {
  return nominationQualifies(signal.zVelocity, signal.acceleration, config.rumint?.zThreshold ?? 3);
}

// Bounded cooldown ladder after consecutive transient failures (§49).
const COOLDOWN_MINUTES = [15, 30, 60];
const FAILURE_STREAK_LIMIT = 3;
// Retry-After honor bounds (§50): never shorter than a minute, never a
// provider-dictated multi-hour silence.
const RETRY_AFTER_MIN_MS = 60_000;
const RETRY_AFTER_MAX_MS = 3_600_000;
// Bounded cursor continuation (§29): the live endpoint's own documented
// cursor ({more, max}; ?max=<id> pages older) lets one poll prove retrieval
// down to the previous watermark. Hard page cap; each page spends budget
// and respects the politeness spacing.
const MAX_POLL_PAGES = 4;

// Budget guard: hourly cap + request spacing + 429 full back-off. Pure state
// machine over timestamps, exported for tests. R1 adds snapshot/restore so
// the rolling budget and a live back-off survive a republish (§50-51).
export class Budget {
  constructor({ hourlyBudget = 120, spacingMs = 2100, backoffMin = 15 } = {}) {
    this.hourlyBudget = hourlyBudget;
    this.spacingMs = spacingMs;
    this.backoffMs = backoffMin * 60_000;
    this.stamps = [];
    this.backoffUntil = 0;
    this.lastReqMs = 0;
  }

  canRequest(now = Date.now()) {
    if (now < this.backoffUntil) return false;
    if (now - this.lastReqMs < this.spacingMs) return false;
    this.stamps = this.stamps.filter((t) => now - t < 3_600_000);
    return this.stamps.length < this.hourlyBudget;
  }

  recordRequest(now = Date.now()) {
    this.stamps.push(now);
    this.lastReqMs = now;
  }

  hit429(now = Date.now(), retryAfterMs = null) {
    const wait =
      Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(Math.max(retryAfterMs, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS)
        : this.backoffMs;
    this.backoffUntil = now + wait;
  }

  hourCount(now = Date.now()) {
    return this.stamps.filter((t) => now - t < 3_600_000).length;
  }

  snapshot(now = Date.now()) {
    return {
      globalBackoffUntil: this.backoffUntil > now ? this.backoffUntil : 0,
      recentRequestTimestamps: this.stamps.filter((t) => now - t < 3_600_000).slice(-MAX_REQUEST_STAMPS),
    };
  }

  restore({ globalBackoffUntil, recentRequestTimestamps } = {}, now = Date.now()) {
    if (Number.isInteger(globalBackoffUntil) && globalBackoffUntil > now) this.backoffUntil = globalBackoffUntil;
    if (Array.isArray(recentRequestTimestamps)) {
      this.stamps = recentRequestTimestamps.filter((t) => Number.isInteger(t) && now - t < 3_600_000).slice(-MAX_REQUEST_STAMPS);
      this.lastReqMs = Math.max(0, ...this.stamps);
    }
  }
}

// R1A: a recent partial-continuation failure keeps the cycle honestly
// DEGRADED for this long — bounded, so one blip never degrades forever.
const CONTINUATION_DEGRADE_MS = 15 * 60_000;

export function startRumint({
  log = console.log,
  config = loadConfig(),
  fetchImpl = fetch,
  now = Date.now,
  sleepImpl = (ms) => new Promise((res) => setTimeout(res, ms)),
  intervalMs = 1000,
  checkpointStore = null,
  memoryBootstrapSource = null,
  maxPendingEvents = MAX_PENDING_EVENTS,
} = {}) {
  if (!rumintEnabled(config)) {
    log(`[${nowIso()}] RUMINT dark — ears off, zero network`);
    return null;
  }
  const cfg = config.rumint ?? {};
  const zThreshold = cfg.zThreshold ?? 3;
  const budget = new Budget(cfg);
  const hotSec = cfg.pollHotSec ?? 300;
  const warmSec = cfg.pollWarmSec ?? 1200;
  const majors = new Set(config.universe ?? []);
  const nextDue = new Map(); // coin -> ms when next poll is due
  const abort = new AbortController();

  const S = {
    stopped: false,
    initialized: false,
    initState: 'INITIALIZING',
    initDetail: null,
    baselines: {}, // providerSymbol -> baseline
    hyped: null, // the ONE canonical HYPED snapshot (§38)
    symbolHealth: {}, // providerSymbol -> {failureStreak, unavailableUntil, cooldownLevel, lastError, lastErrorTs, lastFailureKind}
    pending: [], // owed source-event debt: {kind, record, armStalkCoin?}
    pollTransaction: null, // R1A write-ahead: one in-flight recoverable poll advancement
    hypedPublication: 'NOT_ATTEMPTED', // R1A: hyped.json mirror ACK — NOT_ATTEMPTED | SAVED | FAILED
    counters: {
      polls: 0,
      nominations: 0,
      sourceWriteFailures: 0,
      durableCheckpointFailures: 0,
      providerSchemaFailures: 0,
      providerIntegrityFailures: 0,
      internalIntegrityFailures: 0, // R1A: malformed INTERNAL evidence withheld, never appended
      continuationFailures: 0, // R1A: continuation pages that failed after a valid first page
      backlogRefusals: 0, // R1A: advancements refused because pending debt was at its hard cap
      evidenceDrops: 0,
    },
    lastEvidenceDrop: null,
    lastIntegrityFailure: null,
    lastPollTs: null,
    lastSuccessTs: null,
    localSave: 'NOT_YET_SAVED', // NOT_YET_SAVED | SAVED | FAILED
    durableSave: checkpointStore ? 'NOT_YET_SAVED' : 'NOT_CONFIGURED', // + DURABLE | AT_RISK
  };

  const iso = () => new Date(now()).toISOString();

  function tryAppend(record) {
    try {
      appendJsonl(eventsFile(), record);
      return true;
    } catch {
      S.counters.sourceWriteFailures += 1;
      return false;
    }
  }

  function recordIntegrityFailure(record, err) {
    S.counters.internalIntegrityFailures += 1;
    S.lastIntegrityFailure = { ts: iso(), type: record?.type ?? null, error: boundedError(err) };
  }

  // R1A crash reconciliation: does the local source stream already carry a
  // record with this exact identity? Bounded 1MB tail scan — cheap string
  // check first, JSON confirmation second. An unreadable stream reads as
  // absent (a same-identity re-append is deduplicated downstream by Memory).
  const SOURCE_TAIL_BYTES = 1 << 20;
  function sourceHasEvent(sourceEventId) {
    try {
      const f = eventsFile();
      if (!existsSync(f)) return false;
      const size = statSync(f).size;
      const start = Math.max(0, size - SOURCE_TAIL_BYTES);
      const fd = openSync(f, 'r');
      let text;
      try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
      if (!text.includes(sourceEventId)) return false;
      for (const line of text.split('\n')) {
        if (!line.includes(sourceEventId)) continue;
        try {
          if (JSON.parse(line).sourceEventId === sourceEventId) return true;
        } catch {
          // torn tail line — never confirmation
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // Durable ACK for truth-bearing evidence (POLL / NOMINATION / HYPED):
  // validated by the ONE strict source contract, then appended now or held
  // as bounded pending debt replaying the EXACT identity (§44). R1A: the
  // queue NEVER evicts — owed evidence whose baseline effect was adopted is
  // untouchable; at the hard cap new advancement is REFUSED instead (§B3).
  // R1B: pending debt carries its PROOF — a nomination's exact triggering
  // poll (cause), a HYPED session's immutable semantic basis — so restored
  // debt is semantically provable, never merely well-shaped.
  function emitEvidence(kind, record, { armStalkCoin = null, cause = null, basis = null } = {}) {
    if (S.stopped) return 'CANCELLED_STOPPED';
    const invalid = validateSourceRecord(record);
    if (invalid) {
      recordIntegrityFailure(record, invalid); // malformed internal evidence: WITHHELD, never appended
      return 'WITHHELD_INVALID';
    }
    if (tryAppend(record)) return 'ACKED';
    if (S.pending.length >= maxPendingEvents) {
      S.counters.backlogRefusals += 1;
      return 'BACKLOG_FULL'; // the caller must NOT advance truth past this
    }
    S.pending.push({ kind, record, cause, basis, armStalkCoin });
    return 'QUEUED';
  }

  function doStalk(coin, nom) {
    stalk(coin, { cause: `RUMINT NOMINATION z=${Number(nom.z).toFixed(2)}`, z: nom.z }, now());
    log(`[${iso()}] RUMINT NOMINATION ${coin} z=${Number(nom.z).toFixed(2)}`);
  }

  async function drainPending() {
    while (S.pending.length > 0 && !S.stopped) {
      const head = S.pending[0];
      // R1A/R1B: owed debt settles ONLY through the strict contract WITH its
      // proof (nomination cause, HYPED basis) — a malformed or unproven
      // entry (however it got here) is dropped as an integrity failure,
      // never appended, never used to settle anything.
      const invalid = validatePendingEntry({ kind: head.kind, record: head.record, cause: head.cause ?? null, basis: head.basis ?? null });
      if (invalid) {
        recordIntegrityFailure(head.record, invalid);
        S.pending.shift();
        continue;
      }
      // exactly-once: debt that already reached the source stream (a crash
      // between append and checkpoint save) settles without a second line
      if (!sourceHasEvent(head.record.sourceEventId)) {
        if (!tryAppend(head.record)) return;
        // one successfully emitted nomination event = one counter increment
        // (queued nominations were deliberately not counted at queue time)
        if (head.kind === 'NOMINATION') S.counters.nominations += 1;
      }
      S.pending.shift();
      // Only a SAME-PROCESS owed nomination may arm stalking once its
      // evidence lands (§80). Replayed-after-restart debt writes evidence
      // but never resurrects stalking (§46/§81) — armStalkCoin is process-
      // local and deliberately stripped from the persisted checkpoint.
      if (head.armStalkCoin && !S.stopped) doStalk(head.armStalkCoin, head.record);
    }
  }

  // ---- R1A prepared-poll transaction recovery (§blocker-1) ----------------
  // The invariant: a successfully emitted poll must never exist without a
  // recoverable way to finish its baseline advancement. The transaction was
  // persisted (write-ahead) BEFORE its event could exist; on restart we
  // reconcile against the local source stream by exact identity and FINISH
  // the advancement deterministically — never re-fetching, never re-counting,
  // never regenerating retrievedTs/sourceEventId/accepted-ID set.
  function recoverTransaction() {
    const t = S.pollTransaction;
    if (!t) return true;
    const invalid = validateSourceRecord(t.record);
    if (invalid) {
      // malformed transactions settle NOTHING (validateCheckpoint should
      // have refused the whole checkpoint; this is defense in depth)
      recordIntegrityFailure(t.record, invalid);
      S.pollTransaction = null;
      return true;
    }
    if (!sourceHasEvent(t.sourceEventId)) {
      // the event never made it (crash between transaction persist and
      // append): replay the EXACT prepared record with the SAME identity
      if (!tryAppend(t.record)) return false; // writer down: keep the transaction, retry, no polling meanwhile
    }
    // finalize the bound candidate — idempotent across retries and across a
    // restart from a checkpoint saved after settlement: adopt and count the
    // poll only when the baseline has not already reached the candidate
    if (S.baselines[t.providerSymbol]?.baselineRevision !== t.candidateBaselineRevision) {
      S.baselines[t.providerSymbol] = t.candidateBaseline;
      S.counters.polls += 1;
    }
    // R1B blocker-2: a bound nomination is NOT best-effort evidence. It
    // settles through the SAME durable debt mechanism as the live path —
    // and the transaction is cleared ONLY once the nomination exists in
    // source truth, was ACKED, or is durably represented as pending debt.
    // Recovery NEVER arms stalking (§46/§81).
    if (t.nominationRecord) {
      const nomId = t.nominationRecord.sourceEventId;
      const alreadyOwed = S.pending.some((p) => p.record?.sourceEventId === nomId);
      if (!alreadyOwed && !sourceHasEvent(nomId)) {
        const nd = emitEvidence('NOMINATION', t.nominationRecord, { armStalkCoin: null, cause: t.record });
        if (nd === 'ACKED') {
          S.counters.nominations += 1; // the one emission of this nomination
        } else if (nd === 'QUEUED') {
          // safe: the exact debt (with its cause) rides the next checkpoint
        } else {
          // BACKLOG_FULL / WITHHELD_INVALID / CANCELLED_STOPPED: the bound
          // nomination is not yet durably represented — RETAIN the
          // transaction and retry; never "try once and forget"
          return false;
        }
      } else if (!alreadyOwed) {
        // the nomination already reached source truth before the crash; the
        // persisted counter (from the write-ahead save) never captured it
        S.counters.nominations += 1;
      }
    }
    S.pollTransaction = null;
    log(`[${iso()}] RUMINT recovered an interrupted poll transaction for ${t.providerSymbol} (rev ${t.candidateBaselineRevision}) — no re-count`);
    return true;
  }

  // ---- checkpoint build / adopt -------------------------------------------
  function buildCheckpointState() {
    return {
      version: RUMINT_CHECKPOINT_VERSION,
      savedTs: iso(),
      provider: PROVIDER,
      collectorVersion: RUMINT_COLLECTOR_VERSION,
      baselines: S.baselines,
      hyped: S.hyped ?? { sessionDate: null, state: 'BUILDING', symbols: [], finalizedTs: null, identity: null, coverage: null },
      providerHealth: { ...budget.snapshot(now()), symbols: S.symbolHealth },
      // armStalk stripped: restart never re-arms. R1B: each entry's PROOF
      // (nomination cause poll / HYPED semantic basis) persists with it.
      pendingEvents: S.pending.map(({ kind, record, cause, basis }) => ({ kind, record, cause: cause ?? null, basis: basis ?? null })),
      pollTransaction: S.pollTransaction, // R1A: the one in-flight recoverable advancement, if any
      counters: S.counters,
    };
  }

  // R1A publication ACK (§blocker-4): hyped.json is the display MIRROR of
  // the canonical snapshot; its write success is tracked on its OWN state,
  // never conflated with checkpoint durability — an unrelated checkpoint
  // success can no longer overwrite a HYPED publication failure.
  function writeHypedSafe(snap) {
    try {
      writeHyped(snap);
      S.hypedPublication = 'SAVED';
    } catch {
      S.hypedPublication = 'FAILED'; // visible, retried even while the snapshot itself is unchanged
    }
  }

  function adoptCheckpoint(state) {
    S.baselines = state.baselines;
    S.hyped = state.hyped?.state ? state.hyped : null;
    S.symbolHealth = state.providerHealth.symbols ?? {};
    budget.restore(state.providerHealth, now());
    S.pending = (state.pendingEvents ?? []).map(({ kind, record, cause, basis }) => ({ kind, record, cause: cause ?? null, basis: basis ?? null, armStalkCoin: null }));
    S.pollTransaction = state.pollTransaction ?? null;
    for (const [k, v] of Object.entries(state.counters ?? {})) if (k in S.counters) S.counters[k] = v;
    if (S.hyped) writeHypedSafe(S.hyped); // restore-time publication failure is visible AND retryable
  }

  // ---- one-time bootstrap from durable RUMINT_POLL Memory (§13-14) --------
  async function bootstrapFromMemory() {
    const facts = await memoryBootstrapSource({ sinceTs: Math.floor((now() - 7 * 86_400_000) / 1000) });
    if (!Array.isArray(facts)) return 0;
    let applied = 0;
    for (const f of facts) {
      if (!f || typeof f.providerSymbol !== 'string' || !/^[A-Z0-9]{1,15}\.X$/.test(f.providerSymbol)) continue;
      if (!Number.isInteger(f.hourTsSec) || f.hourTsSec <= 0) continue;
      if (!Number.isInteger(f.velocity) || f.velocity < 0) continue;
      const coin = f.providerSymbol.replace(/\.X$/, '');
      const base = (S.baselines[f.providerSymbol] ??= emptyBaseline(f.providerSymbol, coin));
      if (Object.keys(S.baselines).length > MAX_SYMBOLS) {
        delete S.baselines[f.providerSymbol];
        continue;
      }
      if (Object.keys(base.buckets).length >= MAX_BUCKET_HOURS) continue;
      const key = utcHourKey(f.hourTsSec * 1000);
      const hourIso = new Date(f.hourTsSec * 1000).toISOString();
      // only PROVEN facts: the max cumulative hourly velocity actually
      // observed for that hour; bull/bear detail is honestly unavailable
      base.buckets[key] = {
        count: f.velocity,
        bull: null,
        bear: null,
        successfulPolls: 0,
        firstPollTs: hourIso,
        lastPollTs: hourIso,
        coverage: COVERAGE_BOOTSTRAPPED,
      };
      applied += 1;
      // lastMsgId stays null: the watermark is UNKNOWN until the first live
      // provider response initializes it (§15) — no retroactive nominations,
      // no retroactive HYPED, no first-page double counting.
    }
    return applied;
  }

  // ---- durable initialization gate (§11) ----------------------------------
  async function ensureInit() {
    if (S.initialized) return true;
    let outcome;
    if (!checkpointStore) outcome = { outcome: 'NOT_CONFIGURED' };
    else {
      try {
        outcome = await checkpointStore.load();
      } catch (err) {
        outcome = { outcome: 'UNAVAILABLE', error: boundedError(err.message) };
      }
    }
    if (outcome.outcome === 'LOADED') {
      const err = validateCheckpoint(outcome.state);
      if (err) {
        // a parseable object is not trusted state: WITHHOLD, degrade, retry —
        // never guess, never overwrite the durable row with invented truth
        S.initState = 'WITHHELD_INVALID_CHECKPOINT';
        S.initDetail = boundedError(err);
        return false;
      }
      adoptCheckpoint(outcome.state);
      S.initState = 'RESTORED_DURABLE';
      S.initialized = true;
      return true;
    }
    // No durable row (or no durable core): a VALID local checkpoint from a
    // same-VM restart is real validated authority. R1A: ABSENT and
    // UNREADABLE/CORRUPT local caches are DIFFERENT truths — a corrupt local
    // cache with no durable authority is never silently called fresh.
    const local = readLocalCheckpoint();
    const localErr = local.outcome === 'LOADED' ? validateCheckpoint(local.state) : local.outcome === 'INVALID' ? local.error : null;
    const localCorrupt = local.outcome === 'INVALID' || (local.outcome === 'LOADED' && localErr !== null);
    if (local.outcome === 'LOADED' && !localErr) {
      adoptCheckpoint(local.state);
      S.initState = outcome.outcome === 'UNAVAILABLE' ? 'RESTORED_LOCAL_DURABLE_UNAVAILABLE' : 'RESTORED_LOCAL';
      S.initialized = true;
      return true;
    }
    if (outcome.outcome === 'UNAVAILABLE') {
      // configured durable truth exists but cannot be read: "I could not
      // read RUMINT history" is NEVER "RUMINT has no history" — withhold
      S.initState = 'WITHHELD_DURABLE_UNAVAILABLE';
      S.initDetail = boundedError(localCorrupt ? `durable unavailable AND local checkpoint corrupt: ${localErr}` : outcome.error ?? 'durable checkpoint unavailable');
      return false;
    }
    if (localCorrupt) {
      // durable authority is honestly absent and the local cache is corrupt:
      // report the truth and withhold rather than inventing a fresh start
      S.initState = 'WITHHELD_INVALID_LOCAL_CHECKPOINT';
      S.initDetail = boundedError(localErr);
      return false;
    }
    if (outcome.outcome === 'NOT_FOUND' && memoryBootstrapSource) {
      try {
        const applied = await bootstrapFromMemory();
        S.initState = applied > 0 ? 'BOOTSTRAPPED_FROM_DURABLE_RUMINT_POLL' : 'FRESH_START';
        if (applied > 0) log(`[${iso()}] RUMINT bootstrap — ${applied} observed hours reconstructed from durable poll evidence`);
      } catch (err) {
        S.initState = 'WITHHELD_DURABLE_UNAVAILABLE';
        S.initDetail = boundedError(`bootstrap read failed: ${err.message}`);
        return false;
      }
      S.initialized = true;
      return true;
    }
    S.initState = 'FRESH_START';
    S.initialized = true;
    return true;
  }

  // ---- checkpoint save: local + durable, both truthfully reported ---------
  async function saveCheckpoint() {
    const state = buildCheckpointState();
    let localOk = false;
    try {
      atomicWriteJson(checkpointFile(), state, { pretty: false });
      localOk = true;
      S.localSave = 'SAVED';
    } catch {
      S.localSave = 'FAILED';
    }
    let durable = { durable: false, reason: 'NOT_CONFIGURED' };
    if (checkpointStore) {
      try {
        durable = await checkpointStore.save(state);
      } catch (err) {
        durable = { durable: false, reason: 'UNAVAILABLE', error: boundedError(err.message) };
      }
    }
    if (durable.durable) S.durableSave = 'DURABLE';
    else if (durable.reason === 'NOT_CONFIGURED') S.durableSave = 'NOT_CONFIGURED';
    else {
      // local success does NOT prove republish survival — deployment
      // durability degrades to AT_RISK the moment the durable core misses
      S.durableSave = 'AT_RISK';
      S.counters.durableCheckpointFailures += 1;
    }
    return { localOk, durableOk: durable.durable };
  }

  // ---- the ONE canonical HYPED snapshot (§34-§43, §61) --------------------
  function rollHyped() {
    const atMs = now();
    let snap;
    try {
      snap = hypedSnapshot({ baselines: S.baselines, atMs });
    } catch (err) {
      // §93: a HYPED failure is UNAVAILABLE — never a fake valid H0
      snap = {
        sessionDate: null,
        state: 'UNAVAILABLE',
        symbols: [],
        finalizedTs: null,
        identity: null,
        coverage: null,
        error: boundedError(err.message),
      };
    }
    const cur = S.hyped;
    // R1A: identity participates in the change comparison — a stored
    // identity disagreeing with the recomputed one can never survive as-is.
    // Comparisons are canonical (key-sorted): a jsonb-restored snapshot with
    // reordered keys is the same truth, not a change.
    const changed =
      !cur ||
      cur.sessionDate !== snap.sessionDate ||
      cur.state !== snap.state ||
      cur.identity !== snap.identity ||
      canonicalJson(cur.symbols) !== canonicalJson(snap.symbols) ||
      canonicalJson(cur.coverage ?? null) !== canonicalJson(snap.coverage ?? null);
    if (!changed) {
      // §B4: an unchanged snapshot still RETRIES a failed publication —
      // the mirror converges without requiring a semantic HYPED change
      if (S.hypedPublication === 'FAILED' && cur) writeHypedSafe(cur);
      return;
    }
    // §B3: while owed evidence sits at its hard cap, canonical HYPED does
    // not mutate (baselines are frozen too); publication retries continue
    if (S.pending.length >= maxPendingEvents) {
      if (S.hypedPublication === 'FAILED' && cur) writeHypedSafe(cur);
      return;
    }
    const finalized = snap.state === 'READY' || snap.state === 'EMPTY' || snap.state === 'PARTIAL';
    // finalizedTs marks when THIS identity finalized; a coverage-detail
    // refresh under the same identity keeps the original finalization time
    snap.finalizedTs = finalized ? (cur && cur.identity === snap.identity && cur.finalizedTs ? cur.finalizedTs : iso()) : null;
    S.hyped = snap;
    writeHypedSafe(snap); // hyped.json mirrors the same canonical object as status.json — one truth
    if (finalized && snap.identity && snap.identity !== cur?.identity) {
      // deterministic session identity (§42): same finalized date+state+set
      // replays to the same id (restart dedupes); a different set is new.
      // R1B: the exact semantic basis (same baselines, same instant the
      // snapshot was derived from) rides along as the debt's proof.
      let basis = null;
      try {
        basis = hypedBasisFromBaselines({ baselines: S.baselines, atMs });
      } catch {
        basis = null; // a basis failure only affects queued-debt provability
      }
      emitEvidence(
        'HYPED',
        {
          ts: iso(),
          type: 'HYPED_SESSION',
          sourceEventId: snap.identity,
          provider: PROVIDER,
          sessionDate: snap.sessionDate,
          state: snap.state,
          symbols: snap.symbols,
          coverage: snap.coverage,
        },
        { basis }
      );
      if (snap.symbols.length) log(`[${iso()}] HYPED ${snap.symbols.join(' ')} (${snap.sessionDate})`);
    }
  }

  // ---- polling ------------------------------------------------------------
  function trackedCoins() {
    const uni = readCurrentUniverse();
    const coins = uni ? uni.pairs.map((p) => p.coin) : [...majors];
    return coins.slice(0, MAX_SYMBOLS);
  }

  function pollableCoins(nowMs) {
    return trackedCoins().filter((c) => {
      const sym = providerSymbolFor(c);
      if (!sym) return false; // UNMAPPED_PROVIDER_SYMBOL: explicit status, never a lookalike stream
      const h = S.symbolHealth[sym];
      return !(h && h.unavailableUntil > nowMs); // cooldown expiry re-admits the symbol (the next poll is its probe)
    });
  }

  function cadenceSec(coin, stalking) {
    return majors.has(coin) || coin in stalking ? hotSec : warmSec;
  }

  function handleFailure(coin, providerSymbol, err) {
    if (err.status === 429 || /HTTP 429/.test(err.message ?? '')) {
      budget.hit429(now(), err.retryAfterMs ?? null);
      tryAppend({
        ts: iso(),
        type: 'RUMINT_BACKOFF',
        trigger: providerSymbol,
        until: budget.backoffUntil,
        retryAfterHonored: Number.isFinite(err.retryAfterMs),
      });
      log(`[${iso()}] RUMINT 429 — global back-off until ${new Date(budget.backoffUntil).toISOString()}`);
      return;
    }
    const h = (S.symbolHealth[providerSymbol] ??= {
      failureStreak: 0,
      unavailableUntil: 0,
      cooldownLevel: 0,
      lastError: null,
      lastErrorTs: null,
      lastFailureKind: null,
    });
    h.failureStreak += 1;
    h.lastError = boundedError(err.message);
    h.lastErrorTs = iso();
    h.lastFailureKind = err.classification ?? 'REQUEST_FAILED';
    tryAppend({
      ts: iso(),
      type: 'RUMINT_POLL_FAILED',
      symbol: providerSymbol,
      coin,
      classification: h.lastFailureKind,
      error: h.lastError,
      streak: h.failureStreak,
    });
    // a probe failure while already in the cooldown ladder extends the
    // bounded cooldown immediately; fresh symbols need the full streak
    if (h.cooldownLevel > 0 || h.failureStreak >= FAILURE_STREAK_LIMIT) {
      const mins = COOLDOWN_MINUTES[Math.min(h.cooldownLevel, COOLDOWN_MINUTES.length - 1)];
      h.cooldownLevel = Math.min(h.cooldownLevel + 1, COOLDOWN_MINUTES.length - 1);
      h.unavailableUntil = now() + mins * 60_000;
      h.failureStreak = 0;
      tryAppend({ ts: iso(), type: 'RUMINT_UNAVAILABLE', symbol: coin, providerSymbol, cooldownMin: mins, until: h.unavailableUntil });
      log(`[${iso()}] RUMINT ${coin} TEMPORARILY_UNAVAILABLE — ${mins}m bounded cooldown, will probe (no invented data)`);
    }
  }

  async function pollOne(coin) {
    const providerSymbol = providerSymbolFor(coin);
    if (!providerSymbol) return;
    const prev = S.baselines[providerSymbol] ?? emptyBaseline(providerSymbol, coin);
    budget.recordRequest(now());
    S.lastPollTs = iso();
    let page;
    try {
      page = await fetchSymbolPage(providerSymbol, { config, fetchImpl, signal: abort.signal });
    } catch (err) {
      if (S.stopped) return; // CANCELLED: an aborted/late failure mutates nothing
      handleFailure(coin, providerSymbol, err);
      return;
    }
    if (S.stopped) return; // CANCEL contract: a response landing after stop is discarded (§55)
    if (!page) return; // dark (config raced) — nothing observed, nothing invented
    if (!page.ok) {
      // HTTP succeeded, body unusable: PROVIDER_SCHEMA_ERROR — never a
      // successful zero-message poll, never an observed-zero hour (§33)
      S.counters.providerSchemaFailures += 1;
      handleFailure(coin, providerSymbol, { message: page.detail, classification: 'PROVIDER_SCHEMA_ERROR' });
      return;
    }
    // ---- bounded cursor continuation (§28-§30, R1A §B5) -------------------
    // With a KNOWN watermark, keep paging older (?max=<oldest id>) until the
    // page provably reaches the previous boundary (an id <= watermark, or
    // the provider says nothing older exists) or the hard page cap/budget
    // stops us. R1A: the coverage label names EXACTLY why retrieval stopped
    // — a failed continuation page is a recorded partial-coverage failure
    // (counted, health-noted), never disguised as a page cap; the valid
    // first page's evidence is always preserved. An unknown watermark takes
    // only the first page (watermark-only initialization).
    const allMessages = [...page.messages];
    const validIds = (msgs) => msgs.map((m) => canonicalMessageId(m?.id)).filter(Boolean);
    const reachedBoundary = (msgs, cursor) => {
      if (prev.lastMsgId !== null && validIds(msgs).some((id) => !idGreater(id, prev.lastMsgId))) return true;
      return cursor ? cursor.more === false : false;
    };
    const continuationFailure = (kind, error) => {
      S.counters.continuationFailures += 1;
      const h = (S.symbolHealth[providerSymbol] ??= {
        failureStreak: 0,
        unavailableUntil: 0,
        cooldownLevel: 0,
        lastError: null,
        lastErrorTs: null,
        lastFailureKind: null,
      });
      h.lastContinuationFailure = { kind, tsMs: now(), error: boundedError(error) };
      tryAppend({ ts: iso(), type: 'RUMINT_CONTINUATION_FAILED', symbol: providerSymbol, coin, classification: kind, error: boundedError(error) });
    };
    let pagesFetched = 1;
    let coverage;
    if (prev.lastMsgId === null) {
      coverage = COVERAGE_SAMPLED; // watermark init: one page, by design
    } else if (reachedBoundary(page.messages, page.cursor)) {
      coverage = 'COMPLETE_TO_WATERMARK';
    } else if (!page.cursor) {
      coverage = COVERAGE_SAMPLED; // provider offered no cursor: intentionally one page
    } else if (page.cursor.more === true && !canonicalMessageId(page.cursor.max)) {
      coverage = 'PARTIAL_CONTINUATION_SCHEMA_FAILURE'; // cursor promises more but is unusable
      continuationFailure('PARTIAL_CONTINUATION_SCHEMA_FAILURE', 'cursor.max is not a canonical message id');
    } else if (page.cursor.more !== true) {
      coverage = COVERAGE_SAMPLED; // no more pages claimed and boundary unproven: an honest single-page sample
    } else {
      coverage = 'SAMPLED_PAGE_CAP'; // provisional: proven below, or reclassified by the exact stop cause
      let cursor = page.cursor;
      while (cursor?.more === true && canonicalMessageId(cursor.max) && !S.stopped) {
        if (pagesFetched >= MAX_POLL_PAGES) break; // genuine page cap: SAMPLED_PAGE_CAP stands
        await sleepImpl(budget.spacingMs); // politeness floor holds inside one poll too
        if (S.stopped) break;
        if (!budget.canRequest(now())) {
          coverage = 'PARTIAL_CONTINUATION_BUDGET_EXHAUSTED';
          break;
        }
        budget.recordRequest(now());
        let more;
        try {
          more = await fetchSymbolPage(providerSymbol, { config, fetchImpl, signal: abort.signal, maxId: canonicalMessageId(cursor.max) });
        } catch (err) {
          if (S.stopped) return;
          if (err.status === 429) {
            coverage = 'PARTIAL_CONTINUATION_RATE_LIMIT';
            handleFailure(coin, providerSymbol, err); // global backoff + Retry-After behavior preserved
            continuationFailure('PARTIAL_CONTINUATION_RATE_LIMIT', err.message);
          } else {
            coverage = 'PARTIAL_CONTINUATION_NETWORK_FAILURE';
            continuationFailure('PARTIAL_CONTINUATION_NETWORK_FAILURE', err.message);
          }
          break; // the valid first-page evidence stands
        }
        if (S.stopped) return;
        if (!more?.ok) {
          coverage = 'PARTIAL_CONTINUATION_SCHEMA_FAILURE';
          S.counters.providerSchemaFailures += 1;
          continuationFailure('PARTIAL_CONTINUATION_SCHEMA_FAILURE', more?.detail ?? 'unusable continuation page');
          break; // never an observed-zero failure; the first page's evidence stands
        }
        pagesFetched += 1;
        allMessages.push(...more.messages);
        if (reachedBoundary(more.messages, more.cursor)) {
          coverage = 'COMPLETE_TO_WATERMARK';
          break;
        }
        cursor = more.cursor;
        if (cursor?.more === true && !canonicalMessageId(cursor.max)) {
          coverage = 'PARTIAL_CONTINUATION_SCHEMA_FAILURE';
          continuationFailure('PARTIAL_CONTINUATION_SCHEMA_FAILURE', 'continuation cursor.max is not a canonical message id');
          break;
        }
      }
    }
    if (S.stopped) return;
    const nowMs = now();
    const { baseline: candidate, stats } = ingestPage(prev, allMessages, nowMs);
    S.counters.providerIntegrityFailures += stats.invalidId + stats.invalidTimestamp;
    const sig = signalFromBaseline(candidate, nowMs, { zThreshold });
    const pollRecord = {
      ts: iso(),
      type: 'RUMINT_POLL',
      sourceEventId: pollEventIdentity({ providerSymbol, retrievedTs: page.retrievedTs, baselineRevision: candidate.baselineRevision }),
      provider: PROVIDER,
      canonicalCoin: coin,
      providerSymbol,
      symbol: providerSymbol,
      retrievedTs: page.retrievedTs,
      coverage,
      pagesFetched,
      messagesReturned: stats.returned,
      accepted: stats.accepted,
      duplicateSamePage: stats.duplicateSamePage,
      alreadySeen: stats.alreadySeen,
      invalidId: stats.invalidId,
      invalidTimestamp: stats.invalidTimestamp,
      ancientRejected: stats.ancientRejected,
      bootstrappedHourRejected: stats.bootstrappedHourRejected,
      watermarkInitialized: stats.watermarkInitialized,
      velocity: sig.velocity,
      currentHourCount: sig.currentHourCount,
      previousHourCount: sig.previousHourCount,
      twoHoursPriorCount: sig.twoHoursPriorCount,
      historyBucketCount: sig.historyBucketCount,
      historyMean: sig.historyMean,
      historyStd: sig.historyStd,
      z: sig.zVelocity,
      zReason: sig.zReason,
      zThreshold: sig.zThreshold,
      acceleration: sig.acceleration,
      accelerationReason: sig.accelerationReason,
      recentBull: sig.recentBull,
      recentBear: sig.recentBear,
      labeledTotal: sig.labeledTotal,
      sentimentShift: sig.sentimentShift,
      gates: sig.gates,
      decision: sig.decision,
      baselineRevision: candidate.baselineRevision,
    };
    const nomRecord =
      sig.decision === 'NOMINATED' && shouldNominate({ zVelocity: sig.zVelocity, acceleration: sig.acceleration }, config)
        ? {
            ts: iso(),
            type: 'RUMINT_NOMINATION',
            sourceEventId: nominationEventIdentity({ pollSourceEventId: pollRecord.sourceEventId }),
            pollSourceEventId: pollRecord.sourceEventId,
            provider: PROVIDER,
            symbol: coin,
            providerSymbol,
            z: sig.zVelocity,
            acceleration: sig.acceleration,
            zThreshold: sig.zThreshold,
          }
        : null;
    // ---- R1A prepared-poll transaction (§blocker-1) -----------------------
    // WRITE-AHEAD: before the truth-bearing event may exist independently,
    // persist a bounded transaction binding the exact record, identity,
    // accepted ids and candidate baseline — so a crash between source
    // append and checkpoint save can always be finished deterministically,
    // and the same provider messages can never be counted twice.
    S.pollTransaction = {
      version: 1,
      state: 'PREPARED',
      provider: PROVIDER,
      canonicalCoin: coin,
      providerSymbol,
      prePollBaselineRevision: prev.baselineRevision ?? 0,
      candidateBaselineRevision: candidate.baselineRevision,
      acceptedIds: stats.acceptedIds,
      record: pollRecord,
      sourceEventId: pollRecord.sourceEventId,
      candidateBaseline: candidate,
      nominationRecord: nomRecord,
    };
    const persisted = await saveCheckpoint();
    if (S.stopped) return; // the persisted transaction recovers on the next start — nothing mutates now
    if (!persisted.localOk && !persisted.durableOk) {
      // the write-ahead could not be recorded ANYWHERE: an emitted poll
      // would be unrecoverable after a crash, so nothing is appended. The
      // evidence is held as pending debt (RAM until a save lands) and the
      // advancement stays honest under FAILED_DURABILITY semantics (§84).
      S.pollTransaction = null;
      if (S.pending.length >= maxPendingEvents) {
        S.counters.backlogRefusals += 1;
        return; // no capacity for the debt either: no advancement at all
      }
      if (validateSourceRecord(pollRecord)) {
        recordIntegrityFailure(pollRecord, 'self-built poll record failed the source contract');
        return;
      }
      S.pending.push({ kind: 'POLL', record: pollRecord, cause: null, basis: null, armStalkCoin: null });
      if (nomRecord && S.pending.length < maxPendingEvents && validateSourceRecord(nomRecord) === null) {
        S.pending.push({ kind: 'NOMINATION', record: nomRecord, cause: pollRecord, basis: null, armStalkCoin: coin });
      }
      S.baselines[providerSymbol] = candidate;
      S.lastSuccessTs = iso();
      S.counters.polls += 1;
      return;
    }
    const disposition = emitEvidence('POLL', pollRecord);
    if (disposition !== 'ACKED' && disposition !== 'QUEUED') {
      // WITHHELD_INVALID / BACKLOG_FULL / CANCELLED_STOPPED: no durable
      // representation of the evidence -> the advancement is NOT adopted
      // (§45), and the persisted write-ahead is retracted so a restart
      // cannot recover an advancement the live process refused.
      S.pollTransaction = null;
      if (disposition !== 'CANCELLED_STOPPED') await saveCheckpoint();
      return;
    }
    S.baselines[providerSymbol] = candidate;
    S.pollTransaction = null; // completed in-process; the tick-end save persists the finished truth
    S.lastSuccessTs = iso();
    S.counters.polls += 1;
    const h = S.symbolHealth[providerSymbol];
    if (h && (h.failureStreak > 0 || h.cooldownLevel > 0 || h.unavailableUntil > 0)) {
      S.symbolHealth[providerSymbol] = { ...h, failureStreak: 0, cooldownLevel: 0, unavailableUntil: 0 };
      if (h.cooldownLevel > 0 || h.unavailableUntil > 0) {
        tryAppend({ ts: iso(), type: 'RUMINT_RECOVERED', symbol: coin, providerSymbol });
        log(`[${iso()}] RUMINT ${coin} RECOVERED — normal polling restored`);
      }
    }
    if (nomRecord) {
      // §47: evidence lands (or is durably owed) BEFORE any stalking exists;
      // R1B: the exact triggering poll rides along as the debt's proof
      const nd = emitEvidence('NOMINATION', nomRecord, { armStalkCoin: coin, cause: pollRecord });
      if (nd === 'ACKED') {
        S.counters.nominations += 1;
        doStalk(coin, nomRecord);
      }
      // QUEUED: stalking waits until drainPending appends the owed record;
      // BACKLOG_FULL/WITHHELD/CANCELLED: an unrecorded claim never arms stalking
    }
  }

  // ---- status (§57-§58) ---------------------------------------------------
  function symbolReadiness(coin, nowMs) {
    const sym = providerSymbolFor(coin);
    if (!sym) return 'UNMAPPED_PROVIDER_SYMBOL';
    const h = S.symbolHealth[sym];
    if (h && h.unavailableUntil > nowMs) return 'TEMPORARILY_UNAVAILABLE';
    if (h && h.failureStreak > 0 && h.lastFailureKind === 'PROVIDER_SCHEMA_ERROR') return 'PROVIDER_SCHEMA_ERROR';
    if (!S.initialized) return 'BASELINE_UNAVAILABLE';
    const baseline = S.baselines[sym];
    if (!baseline) return 'WARMING_HISTORY';
    const sig = signalFromBaseline(baseline, nowMs, { zThreshold });
    if (sig.historyBucketCount < 24) return 'WARMING_HISTORY';
    return sig.zReason === 'ZERO_VARIANCE' ? 'ZERO_VARIANCE' : 'READY';
  }

  function publishStatus() {
    try {
      const nowMs = now();
      const coins = trackedCoins();
      const readiness = {};
      for (const c of coins) readiness[c] = symbolReadiness(c, nowMs);
      const counts = { READY: 0, WARMING: 0, UNAVAILABLE: 0 };
      for (const r of Object.values(readiness)) {
        if (r === 'READY' || r === 'ZERO_VARIANCE') counts.READY += 1;
        else if (r === 'WARMING_HISTORY') counts.WARMING += 1;
        else counts.UNAVAILABLE += 1;
      }
      const failedDurability = S.pending.length > 0 && S.localSave === 'FAILED' && S.durableSave !== 'DURABLE' && S.durableSave !== 'NOT_CONFIGURED';
      const backlogFull = S.pending.length >= maxPendingEvents;
      const recentContinuationFailure = Object.values(S.symbolHealth).some(
        (h) => h?.lastContinuationFailure && nowMs - h.lastContinuationFailure.tsMs < CONTINUATION_DEGRADE_MS
      );
      let status;
      if (!S.initialized) status = S.initState; // INITIALIZING / WITHHELD_*
      else if (failedDurability) status = 'FAILED_DURABILITY';
      else if (backlogFull) status = 'FAILED_EVIDENCE_BACKLOG'; // §B3: observation paused behind owed evidence
      else if (
        S.durableSave === 'AT_RISK' ||
        S.localSave === 'FAILED' ||
        S.hyped?.state === 'UNAVAILABLE' ||
        S.hypedPublication === 'FAILED' || // §B4: canonical HYPED not successfully published to its mirror
        S.counters.evidenceDrops > 0 ||
        S.counters.internalIntegrityFailures > 0 ||
        recentContinuationFailure // §B5: a recent partial-coverage failure is not "nothing happened"
      )
        status = 'DEGRADED';
      else status = 'HEALTHY';
      const hyped = S.hyped ?? { sessionDate: null, state: S.initialized ? 'BUILDING' : 'UNAVAILABLE', symbols: [], finalizedTs: null, identity: null, coverage: null };
      atomicWriteJson(statusFile(), {
        ts: nowIso(),
        tsMs: Date.now(),
        enabled: true,
        provider: PROVIDER,
        collectorVersion: RUMINT_COLLECTOR_VERSION,
        status,
        initState: S.initState,
        initDetail: S.initDetail,
        symbolsTracked: coins.length,
        symbolsReady: counts.READY,
        symbolsWarming: counts.WARMING,
        symbolsUnavailable: counts.UNAVAILABLE,
        symbols: readiness,
        lastPollTs: S.lastPollTs,
        lastSuccessTs: S.lastSuccessTs,
        recentRequestCount: budget.hourCount(nowMs),
        hourlyBudget: budget.hourlyBudget,
        globalBackoffUntil: budget.backoffUntil > nowMs ? budget.backoffUntil : null,
        localDurability: S.localSave,
        deploymentDurability: S.durableSave,
        hypedPublication: S.hypedPublication, // §B4: independent mirror ACK, never checkpoint durability
        pendingEvidence: S.pending.length,
        pendingCapacity: maxPendingEvents,
        pollTransactionOutstanding: Boolean(S.pollTransaction),
        unpersistedPendingEvidence: failedDurability ? S.pending.length : 0,
        evidenceDrops: S.counters.evidenceDrops,
        lastEvidenceDrop: S.lastEvidenceDrop,
        backlogRefusals: S.counters.backlogRefusals,
        sourceWriteFailures: S.counters.sourceWriteFailures,
        durableCheckpointFailures: S.counters.durableCheckpointFailures,
        providerSchemaFailures: S.counters.providerSchemaFailures,
        providerIntegrityFailures: S.counters.providerIntegrityFailures,
        internalIntegrityFailures: S.counters.internalIntegrityFailures,
        lastIntegrityFailure: S.lastIntegrityFailure,
        continuationFailures: S.counters.continuationFailures,
        hyped, // the same canonical snapshot hyped.json carries — ONE truth (§38/§61)
        stalking: Object.keys(readStalking(nowMs)),
        // legacy display compatibility
        symbolsPolled: coins.length,
        hourCount: budget.hourCount(nowMs),
        backoffUntil: budget.backoffUntil > nowMs ? budget.backoffUntil : null,
      });
    } catch (err) {
      log(`[${iso()}] RUMINT status write failed: ${err.message}`);
    }
  }

  // ---- tick / lifecycle ---------------------------------------------------
  let running = false;
  async function tickOnce() {
    if (running || S.stopped) return;
    running = true;
    try {
      if (!(await ensureInit())) return;
      // R1A §B1: an interrupted poll transaction is finished FIRST — no new
      // observation while an accepted advancement is still owed its finish
      if (!recoverTransaction()) return;
      await drainPending();
      rollHyped();
      if (S.stopped) return;
      // R1A §B3: at the pending hard cap, observation pauses — no new
      // baseline/HYPED advancement may outrun its owed evidence; draining
      // continues above and polling resumes only when capacity exists
      if (S.pending.length >= maxPendingEvents) return;
      if (!budget.canRequest(now())) return;
      const nowMs = now();
      const stalking = readStalking(nowMs);
      let pick = null;
      let worst = 0;
      for (const coin of pollableCoins(nowMs)) {
        if (!nextDue.has(coin)) nextDue.set(coin, nowMs + nextDue.size * (cfg.spacingMs ?? 2100));
        const overdue = nowMs - nextDue.get(coin);
        if (overdue >= 0 && overdue >= worst) {
          worst = overdue;
          pick = coin;
        }
      }
      if (pick) {
        nextDue.set(pick, nowMs + cadenceSec(pick, stalking) * 1000);
        await pollOne(pick);
      }
      // R1A: re-roll AFTER the poll so the checkpoint saved below always
      // carries a HYPED snapshot consistent with its own baselines — the
      // semantic recompute validation depends on exactly this invariant
      rollHyped();
    } finally {
      // save-then-publish: durability failures must be visible in the same
      // status the failure happened in; no checkpoint save while withheld
      if (!S.stopped && S.initialized) await saveCheckpoint();
      publishStatus();
      running = false;
    }
  }

  const timer = setInterval(() => {
    tickOnce().catch((err) => log(`[${iso()}] RUMINT tick failed: ${err.message}`));
  }, intervalMs);

  tryAppend({ ts: iso(), type: 'RUMINT_STARTED', collectorVersion: RUMINT_COLLECTOR_VERSION, budget: budget.hourlyBudget, hotSec, warmSec });
  log(`[${nowIso()}] EARS ON — rumint ${RUMINT_COLLECTOR_VERSION}, ${trackedCoins().length} symbols (budget ${budget.hourlyBudget}/hr)`);

  let stopping = null;
  function stop() {
    stopping ??= (async () => {
      S.stopped = true; // FIRST: every mutation path guards on this
      clearInterval(timer);
      abort.abort(); // CANCEL in-flight provider work (§55)
      if (S.initialized) await saveCheckpoint(); // final truth snapshot
      publishStatus();
    })();
    return stopping;
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { stop, tickOnce, budget, counters: S.counters, internals: S };
}
