// PERSIST-0 runtime — the one place that binds the durable core to the
// running ship. On startup it connects, migrates, RESTORES durable
// protective state (most restrictive wins) BEFORE anything else could ever
// grant permission, then runs the DURABILITY PUMP: a one-way tailer that
// carries locally spooled evidence (memory events, posture transitions,
// control/security audit, paper ledger rows) into PostgreSQL idempotently,
// plus a snapshot watcher that keeps the durable CURRENT posture/lock state
// true after startup.
//
// PERSIST-0A safety gate: getPersistence() is NEVER null. From module
// import onward a fail-closed BOOTING state exists, so no boot window can
// interpret "no persistence object" as permission; startPersistence() never
// throws past installing a fail-closed API; and the retry loop only stops
// once connect + migrations + restore ALL succeed.
//
// Durability states for a local record (doctrine/PERSISTENCE.md):
//   PENDING_DURABLE    — written locally, not yet confirmed by the database
//   DURABLE_CONFIRMED  — the durable insert succeeded (cursor advanced)
//   DURABILITY_FAILED  — the durable write failed; health degrades, the
//                        record stays in the spool and is retried; never
//                        silently dropped, never falsely claimed durable
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dataDir } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { Tail } from '../memory/mirror.js';
import * as controlStore from '../state/control-store.js';
import { Db } from './db.js';
import { Repository } from './repository.js';
import { runMigrations, FutureSchemaError } from './migrate.js';
import { persistenceHealth, durabilityRequired } from './health.js';
import { canonicalJson } from './schema.js';
import {
  validatePostureState,
  validateSimState,
  validateLedgerRow,
  lessPermissivePosture,
  lessPermissiveSim,
} from './validate-state.js';

const PUMP_MS = 5000;
const RETRY_MS = 30_000;
const CURSORS_FILE = () => path.join(dataDir(), 'persistence', 'cursors.json');
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export class InvalidDurableStateError extends Error {}

// ---- BOOTING gate (PERSIST-0A §2): exists from module import ------------
// Before startPersistence() has established truth, a durability-required or
// database-configured process refuses CLEAR — absence of a persistence
// object is NEVER permission. Explicitly local-only development (no
// DATABASE_URL, durability not required) keeps its legacy behavior.
function bootstrapApi() {
  const zeros = {
    status: 'UNAVAILABLE',
    databaseReachable: false,
    restored: false,
    migrationVersion: null,
    failureCategory: 'BOOTING',
    lastSuccessfulReadTs: null,
    lastSuccessfulWriteTs: null,
    connectionErrors: 0,
    transactionErrors: 0,
    memoryIdConflicts: 0,
    invalidDurableRecords: 0,
    ledgerIdConflicts: 0,
    auditIdConflicts: 0,
    runtimeStateConflicts: 0,
    pendingDurableWrites: 0,
    durableConfirmedWrites: 0,
    spoolParseErrors: 0,
    pumpReadErrors: 0,
    cursorRecoveries: 0,
    integrityLock: false,
    pendingControlSync: false,
  };
  return {
    booting: true,
    db: null,
    repo: null,
    health: () => ({
      ...zeros,
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      durabilityRequired: durabilityRequired(),
      permissionLock: durabilityRequired() || Boolean(process.env.DATABASE_URL),
    }),
    async durableClearOrRefuse() {
      if (durabilityRequired() || process.env.DATABASE_URL) return { allow: false, reason: 'PERSISTENCE_BOOTING' };
      return { allow: true, mode: 'LOCAL_ONLY_UNCONFIGURED' };
    },
    async persistControlSnapshot() {
      return { durable: false, reason: 'BOOTING' };
    },
    pumpOnce: async () => {},
    stop: async () => {},
  };
}

let singleton = bootstrapApi();
export const getPersistence = () => singleton;

export async function startPersistence({ log = console.log, dbOverrides = {}, _test = {} } = {}) {
  const db = new Db({ log, ...dbOverrides });
  const repo = new Repository(db, { log });
  const state = {
    db,
    repo,
    log,
    migrationVersion: null,
    restored: false,
    failureCategory: null,
    integrityLock: false,
    pendingControlSync: false,
    controlRevision: null,
    runtime: { posture: { digest: null, revision: null }, sim_pnl: { digest: null, revision: null } },
    resetCursorKeys: new Set(),
    pump: { pendingWrites: 0, confirmedWrites: 0, spoolParseErrors: 0, pumpReadErrors: 0, cursorRecoveries: 0 },
    retryTimer: null,
    pumpTimer: null,
    attemptInFlight: false,
    stopped: false,
    _test,
  };

  // the fail-closed API is installed BEFORE anything can fail (§3)
  singleton = api(state, log);

  if (!db.configured()) {
    if (durabilityRequired()) {
      // PERSIST-0A §1: a published deployment without DATABASE_URL is
      // PERSISTENCE REQUIRED BUT UNCONFIGURED — permission locks; KILL/CAGE
      // still restrict locally; read-only research continues.
      state.failureCategory = 'PERSISTENCE_REQUIRED_UNCONFIGURED';
      log('PERSISTENCE REQUIRED BUT UNCONFIGURED: durability is required (published deployment) and DATABASE_URL is absent — PERMISSION LOCKED (CLEAR and permission-increasing behavior refuse; defensive controls still work locally)');
      return singleton;
    }
    log('PERSISTENCE: DATABASE_URL not configured — durable core disabled; local files only (explicit local development mode; no durable authority exists)');
    return singleton;
  }

  await attemptStartup(state, log);
  if (!state.restored) scheduleRetry(state, log);
  return singleton;
}

// One bounded startup/recovery attempt. NEVER throws; failure leaves the
// fail-closed state in place with a safe category and the lock engaged.
async function attemptStartup(state, log) {
  if (state.attemptInFlight || state.stopped) return false;
  state.attemptInFlight = true;
  try {
    if (!(await state.db.connect())) {
      state.failureCategory = 'UNREACHABLE';
      log('PERSISTENCE UNAVAILABLE: database configured but unreachable — PERSISTENCE_PERMISSION_LOCK engaged (CLEAR and future permission-increasing behavior fail closed; defensive controls still work locally)');
      return false;
    }
    const m = await runMigrations(state.db, { log });
    state.migrationVersion = m.schemaVersion;
    await restoreDurableCore(state, log);
    // PERSIST-0B §7: restored may become TRUE only after ALL startup steps
    // succeed, INCLUDING the durability pump / current-state sync machinery.
    // "Restore reported true but durability machinery never started" is
    // forbidden — a startPump failure leaves restored=false and retry armed.
    startPump(state, log);
    state.restored = true;
    state.failureCategory = null;
    log(`PERSISTENCE: durable core connected (schema ${state.migrationVersion}); restore complete; pump running`);
    return true;
  } catch (err) {
    state.failureCategory =
      err instanceof FutureSchemaError
        ? 'FUTURE_SCHEMA'
        : err instanceof InvalidDurableStateError
          ? 'INVALID_DURABLE_STATE'
          : 'RESTORE_FAILED';
    log(`PERSISTENCE startup failed (${state.failureCategory}): ${err.message} — permission remains locked; will retry`);
    return false;
  } finally {
    state.attemptInFlight = false;
  }
}

// Retry until connect + migrations + restore ALL succeed (§5). Bounded
// interval — an outage is a state we report, not a storm we create. The
// timer is cleared on success and on stop(), never merely on connect.
function scheduleRetry(state, log) {
  if (state.retryTimer || state.stopped) return;
  state.retryTimer = setInterval(async () => {
    if (state.stopped) return;
    if (await attemptStartup(state, log)) {
      clearInterval(state.retryTimer);
      state.retryTimer = null;
      log('PERSISTENCE recovered: durable core reconnected and reconciled');
    }
  }, RETRY_MS);
  state.retryTimer.unref?.();
}

// atomic same-directory text write (JSONL mirrors)
function atomicWriteText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function quarantineCopy(file, rawText, log) {
  const q = `${file}.quarantine-${Date.now()}`;
  writeFileSync(q, rawText);
  log(`PERSISTENCE: preserved pre-reconciliation local evidence at ${path.basename(q)} — nothing deleted`);
}

// MOST RESTRICTIVE STATE WINS: local file vs durable row are merged toward
// less permission; the merge becomes both the local truth and (if it adds
// restriction) the durable truth. KILL in either place is KILL everywhere.
// PERSIST-0A: every durable row is validated BEFORE it may be applied — an
// invalid durable safety row locks permission rather than being repaired,
// and a local file never automatically overrides newer durable truth.
async function restoreDurableCore(state, log) {
  const { repo } = state;

  // ---- controls (through THE local control store, PERSIST-0C §12) --------
  const durable = await repo.loadControlState();
  if (durable?.invalid) {
    // an invalid durable control row is NEVER interpreted as CLEAR: restore
    // fails, the permission lock holds, CLEAR refuses, retries continue
    throw new InvalidDurableStateError(`durable control state invalid: ${durable.errors.join('; ')}`);
  }
  // the store re-reads local truth under its own inter-process lock and
  // fail-closes a corrupt mirror into KILL + quarantine + integrity marker
  const { state: merged } = controlStore.mergeRestrictive(durable?.state ?? {}, 'persistence-restore');
  if (controlStore.integrityStatus().locked) {
    // corrupt local control truth resolved toward restriction — the body
    // must never emerge CLEAR/unlocked on top of quarantined uncertainty
    state.integrityLock = true;
    log('PERSISTENCE INTEGRITY LOCK: local control state was corrupt — fail-closed KILL stands; CLEAR refused until the integrity marker is resolved');
  }
  const saved = await repo.saveControlState(merged, durable?.revision ?? null);
  if (saved.refused) throw new InvalidDurableStateError(`control restore refused: ${saved.reason}`);
  state.controlRevision = saved.revision;
  if (durable && canonicalJson(durable.state) !== canonicalJson(merged)) {
    log('PERSISTENCE reconciliation: control state merged toward MOST RESTRICTIVE');
  }

  // ---- current posture + sim/lock state (validated, LESS PERMISSION WINS) -
  await reconcileRuntimeFile(state, log, {
    id: 'posture',
    file: path.join(dataDir(), 'state', 'posture.json'),
    validate: validatePostureState,
    lessPermissive: (a, b) => lessPermissivePosture(a, b),
    describe: (s) => s?.posture ?? '?',
  });
  await reconcileRuntimeFile(state, log, {
    id: 'sim_pnl',
    file: path.join(dataDir(), 'state', 'sim_pnl.json'),
    validate: validateSimState,
    lessPermissive: (a, b) => lessPermissiveSim(a, b),
    describe: (s) => (s?.simulated ? `sim ${s.date}` : 'cleared'),
  });

  // ---- operational paper ledger: the RUNNING APP reads local JSONL, so a
  // fresh body materializes its reconciled ledger BEFORE consumers run (§10)
  await reconcileLedgerFiles(state, log);

  // ---- childhood manifest identity (metadata only; bulk stays on files) --
  const manifestFile = path.join(dataDir(), 'childhood', 'manifest.json');
  if (existsSync(manifestFile)) {
    try {
      const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
      await repo.recordChildhoodManifest({
        schemaVersion: m.schemaVersion,
        childhoodVersion: m.childhoodVersion,
        codeCommit: m.codeCommit,
        archiveCreatedTs: m.archiveCreatedTs,
        sourceChecksumsSha256_16: m.sourceChecksumsSha256_16,
        fastMemoryParityStatus: m.fastMemoryParityStatus,
        counts: { observations: m.counts?.observations, outcomes: m.counts?.outcomes },
      });
    } catch {
      // a malformed local manifest is the childhood validator's concern
    }
  }
  // STALKING / HYPED are deliberately NOT restored: SAFE_TO_FORGET —
  // forgetting them reduces permission; live sensors re-nominate (doctrine).
}

// Exact reconciliation rules (doctrine/PERSISTENCE.md):
//   durable invalid            -> restore FAILS, permission locked (never repaired)
//   no local + durable valid   -> adopt durable into the local file
//   local valid + no durable   -> push local durable (insert)
//   both valid + equal         -> seed revision, nothing rewritten
//   both valid + different     -> LESS PERMISSION WINS; the winner becomes
//                                 both truths (revision-guarded write)
//   local malformed/invalid    -> quarantined + durable truth adopted
async function reconcileRuntimeFile(state, log, { id, file, validate, lessPermissive, describe }) {
  const { repo } = state;
  const durable = await repo.loadRuntimeState(id);
  if (durable?.invalid) {
    throw new InvalidDurableStateError(`durable ${id} state invalid: ${durable.errors.join('; ')}`);
  }
  let localRaw = null;
  let local = null;
  if (existsSync(file)) {
    localRaw = readFileSync(file, 'utf8');
    try {
      const parsed = JSON.parse(localRaw);
      if (validate(parsed).ok) local = parsed;
    } catch {
      local = null;
    }
  }
  const slot = state.runtime[id];
  if (localRaw !== null && local === null) {
    state.pump.spoolParseErrors++;
    quarantineCopy(file, localRaw, log);
    log(`PERSISTENCE DEGRADED: local ${path.basename(file)} malformed/invalid — quarantined; durable truth stands`);
  }
  if (!durable && !local) return; // nothing anywhere; watcher picks up first write
  if (durable && !local) {
    atomicWriteJson(file, durable.state, { pretty: true });
    slot.revision = durable.revision;
    slot.digest = sha1(readFileSync(file, 'utf8'));
    log(`PERSISTENCE restored ${id} (${describe(durable.state)}) from durable core`);
    return;
  }
  if (!durable && local) {
    const r = await repo.saveRuntimeState(id, local, null);
    slot.revision = r.revision;
    slot.digest = sha1(localRaw);
    return;
  }
  // both exist and are valid
  if (canonicalJson(durable.state) === canonicalJson(local)) {
    slot.revision = durable.revision;
    slot.digest = sha1(localRaw);
    return;
  }
  const winner = lessPermissive(durable.state, local);
  if (winner === durable.state) {
    // stale local permissive state may NOT overwrite newer durable restriction
    atomicWriteJson(file, durable.state, { pretty: true });
    slot.revision = durable.revision;
    slot.digest = sha1(readFileSync(file, 'utf8'));
    log(`PERSISTENCE reconciliation: ${id} adopted durable ${describe(durable.state)} over local ${describe(local)} (less permission wins)`);
  } else {
    const r = await repo.saveRuntimeState(id, local, durable.revision);
    slot.revision = r.revision;
    slot.digest = sha1(localRaw);
    log(`PERSISTENCE reconciliation: ${id} local ${describe(local)} pushed durable (less permission wins)`);
  }
}

const LEDGER_KINDS = [
  { kind: 'prediction', name: 'predictions.jsonl', pumpKey: 'predictions', tsOf: (r) => r.timestamp_prediction_persisted ?? '' },
  { kind: 'fill', name: 'fills.jsonl', pumpKey: 'fills', tsOf: (r) => r.ts ?? '' },
  { kind: 'exit', name: 'exits.jsonl', pumpKey: 'exits', tsOf: (r) => r.ts ?? '' },
];

// PERSIST-0A §10 — merge the COMPLETE validated durable ledger with local
// pending rows and atomically materialize the reconciled canonical local
// mirror files, so the existing synchronous ledger consumers
// (allPredictions/openPositions/realizedPnlUsd/ledgerSummary) actually see
// durable history after a fresh filesystem. Conflicting local evidence is
// preserved in a quarantine copy — first durable truth is never silently
// overwritten, and the conflict locks permission until resolved.
async function reconcileLedgerFiles(state, log) {
  const { repo } = state;
  for (const { kind, name, pumpKey, tsOf } of LEDGER_KINDS) {
    const durable = await repo.loadLedgerAll(kind); // validated, chunked, complete-or-reported
    if (!durable.complete) {
      // PERSIST-0B §12: a withheld corrupt durable row could BE the open
      // position — the operational ledger is NOT safely restored; missing
      // history is never interpreted as "no position"
      state.integrityLock = true;
      log(`PERSISTENCE INTEGRITY LOCK: ${durable.invalid} corrupt durable ${kind} row(s) — operational ledger restore INCOMPLETE; permission locked pending manual resolution`);
    }
    const durableRows = durable.rows;
    const file = path.join(dataDir(), 'ledger', name);
    const rawText = existsSync(file) ? readFileSync(file, 'utf8') : '';
    let malformed = 0;
    let invalidLocal = 0;
    const localValid = [];
    for (const line of rawText.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (validateLedgerRow(kind, rec).ok) localValid.push(rec);
        else invalidLocal++;
      } catch {
        malformed++;
      }
    }
    const byId = new Map(durableRows.map((r) => [r.prediction_id, r]));
    let conflicts = 0;
    let localOnly = 0;
    for (const rec of localValid) {
      const d = byId.get(rec.prediction_id);
      if (!d) {
        byId.set(rec.prediction_id, rec); // valid local pending: preserved, pumped durable
        localOnly++;
      } else if (canonicalJson(d) !== canonicalJson(rec)) {
        // LEDGER_ID_CONTENT_CONFLICT: first durable truth stays in the
        // mirror; the local variant survives in the quarantine copy
        conflicts++;
      }
    }
    if (conflicts > 0) {
      state.integrityLock = true;
      repo.ledgerIdConflicts += conflicts;
      log(`PERSISTENCE INTEGRITY LOCK: ${conflicts} LEDGER_ID_CONTENT_CONFLICT in ${name} — first durable truth stands; permission locked pending manual resolution`);
    }
    if (malformed + invalidLocal > 0) {
      // PERSIST-0B §15: an unreadable local pending ledger row could be a
      // prediction/fill/exit that never reached durable storage — never
      // assumed to mean "no position"; evidence quarantined, permission locked
      state.integrityLock = true;
      state.pump.spoolParseErrors += malformed + invalidLocal;
      log(`PERSISTENCE INTEGRITY LOCK: ${name} carried ${malformed} malformed + ${invalidLocal} invalid local pending rows — quarantined, never invented, permission locked pending manual resolution`);
    }
    const mergedRows = [...byId.values()].sort((a, b) => String(tsOf(a)).localeCompare(String(tsOf(b))));
    const newText = mergedRows.map((r) => JSON.stringify(r)).join('\n') + (mergedRows.length ? '\n' : '');
    if (newText !== rawText) {
      if (rawText && (malformed > 0 || invalidLocal > 0 || conflicts > 0)) quarantineCopy(file, rawText, log);
      atomicWriteText(file, newText);
      state.resetCursorKeys.add(pumpKey); // replay is idempotent; conflicts stay counted, not re-fought
      log(`PERSISTENCE ledger restore: ${name} materialized (${durableRows.length} durable, ${localOnly} local-only pending)`);
    }
  }
}

// ---- the pump: tail local spools, write durably, advance cursors ---------
function pumpSources() {
  const d = dataDir();
  return [
    { key: 'memory', file: path.join(d, 'memory', 'events.jsonl') },
    { key: 'posture', file: path.join(d, 'state', 'transitions.jsonl') },
    { key: 'controls_log', file: path.join(d, 'state', 'controls_log.jsonl') },
    { key: 'auth_log', file: path.join(d, 'state', 'control_auth_log.jsonl') },
    { key: 'predictions', file: path.join(d, 'ledger', 'predictions.jsonl') },
    { key: 'fills', file: path.join(d, 'ledger', 'fills.jsonl') },
    { key: 'exits', file: path.join(d, 'ledger', 'exits.jsonl') },
  ];
}

function startPump(state, log) {
  if (state.pumpTimer) return; // recovery must never double the pump
  if (state._test?.failPumpStart) throw new Error('injected pump bootstrap failure (test seam)');
  // PERSIST-0B §8: the cursor file is ephemeral bookkeeping, NOT durable
  // truth. A malformed cursor file is quarantined for audit and the spools
  // replay from byte 0 — idempotent durable identities collapse the
  // duplicates; positions are never invented and records are never lost.
  let cursors = {};
  if (existsSync(CURSORS_FILE())) {
    const rawCursors = readFileSync(CURSORS_FILE(), 'utf8');
    try {
      const parsed = JSON.parse(rawCursors);
      const numMap = (o) => o === undefined || (o !== null && typeof o === 'object' && Object.values(o).every((v) => Number.isInteger(v) && v >= 0));
      if (parsed === null || typeof parsed !== 'object' || !numMap(parsed.offsets) || !numMap(parsed.lineCounts)) {
        throw new Error('invalid cursor shape');
      }
      cursors = parsed;
    } catch {
      quarantineCopy(CURSORS_FILE(), rawCursors, log);
      state.pump.cursorRecoveries++;
      log('PERSISTENCE: cursors.json malformed — quarantined; replaying spools from byte 0 (idempotent identities collapse duplicates; no permission change)');
      cursors = {};
    }
  }
  const tails = new Map();
  const lineCounts = { ...(cursors.lineCounts ?? {}) };
  for (const s of pumpSources()) {
    const t = new Tail(s.file, { fromStart: true });
    t.offset = cursors.offsets?.[s.key] ?? 0; // resume exactly where durability left off
    if (state.resetCursorKeys.has(s.key)) {
      t.offset = 0; // file was re-materialized during restore; replay is idempotent
      lineCounts[s.key] = 0;
    }
    tails.set(s.key, t);
  }
  state.resetCursorKeys.clear();

  async function persistRecord(key, rec, lineNo) {
    const { repo } = state;
    if (key === 'memory') {
      const r = await repo.insertMemoryEvent(rec, JSON.stringify(rec));
      if (r.outcome === 'ID_CONTENT_CONFLICT') return true; // refused, counted, never retried into overwrite
      return r.durable;
    }
    if (key === 'posture') {
      await repo.appendPostureTransition('transitions.jsonl', lineNo, rec);
      return true;
    }
    if (key === 'controls_log' || key === 'auth_log') {
      await repo.appendControlAudit(key, lineNo, rec);
      return true;
    }
    if (key === 'predictions' || key === 'fills' || key === 'exits') {
      const kind = { predictions: 'prediction', fills: 'fill', exits: 'exit' }[key];
      const r = await repo.upsertLedgerRow(kind, rec);
      if (r.invalid) {
        // PERSIST-0B §15: an unreadable possible position is never assumed
        // to mean "no position" — evidence stays in the spool, permission locks
        state.pump.spoolParseErrors++;
        state.integrityLock = true;
        log(`PERSISTENCE INTEGRITY LOCK: invalid ${kind} spool row refused (${r.reason})`);
      }
      if (r.conflict) {
        // PERSIST-0B §14: a runtime LEDGER_ID_CONTENT_CONFLICT means the
        // local synchronous ledger may disagree with durable first truth —
        // permission locks IMMEDIATELY; the corrupt row is not retried forever
        state.integrityLock = true;
        log(`PERSISTENCE INTEGRITY LOCK: runtime LEDGER_ID_CONTENT_CONFLICT (${kind} ${rec.prediction_id}) — first durable truth stands; permission locked`);
      }
      return true; // accepted, duplicate, conflict (locked+counted) and invalid (locked+counted) are all handled
    }
    return true;
  }

  // PERSIST-0B §2 — current-control reconciliation on every pump cycle:
  // a restrictive action whose immediate durable write failed becomes
  // durable automatically after DB recovery (no second action, no restart),
  // and a durable restriction discovered from another instance is adopted
  // locally. MOST RESTRICTIVE STATE WINS in both directions, always.
  async function syncCurrentControls() {
    try {
      // durable read FIRST, holding no filesystem lock (PERSIST-0C §12)
      const durable = await state.repo.loadControlState();
      if (durable?.invalid) {
        state.integrityLock = true;
        state.pendingControlSync = true;
        log('PERSISTENCE INTEGRITY LOCK: durable control row invalid during sync — never read as CLEAR; manual resolution required');
        return;
      }
      // the store acquires the local lock, RE-READS local truth under it,
      // merges MOST RESTRICTIVE, and writes only on change — a restriction
      // that landed while we read the database can never be overwritten
      const { state: merged, changed } = controlStore.mergeRestrictive(durable?.state ?? {}, 'persistence-sync');
      if (controlStore.integrityStatus().locked && !state.integrityLock) {
        state.integrityLock = true;
        log('PERSISTENCE INTEGRITY LOCK: local control state was corrupt during sync — fail-closed KILL stands');
      }
      if (changed) log('PERSISTENCE control sync: durable restriction adopted locally (most restrictive wins)');
      // local lock is released before this network write
      if (!durable || canonicalJson(merged) !== canonicalJson(durable.state)) {
        const r = await state.repo.saveControlState(merged, durable?.revision ?? null);
        if (r.refused) {
          state.integrityLock = true;
          state.pendingControlSync = true;
          return;
        }
        state.controlRevision = r.revision;
        log('PERSISTENCE control sync: local restriction persisted durably (revision advanced)');
      } else {
        state.controlRevision = durable.revision;
      }
      state.pendingControlSync = false;
    } catch (err) {
      state.pendingControlSync = true;
      log(`PERSISTENCE: control sync not yet durable (${err.code ?? err.message}) — retried next cycle`);
    }
  }

  // PERSIST-0A §7 — the durable CURRENT posture/lock snapshots must stay
  // true after startup. Content-digest change detection; a write is
  // DURABLE_CONFIRMED only after the database acks (digest advances then).
  async function snapshotCurrentState() {
    let pending = 0;
    for (const [id, file, validate] of [
      ['posture', path.join(dataDir(), 'state', 'posture.json'), validatePostureState],
      ['sim_pnl', path.join(dataDir(), 'state', 'sim_pnl.json'), validateSimState],
    ]) {
      if (!existsSync(file)) continue;
      let raw;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const digest = sha1(raw);
      const slot = state.runtime[id];
      if (digest === slot.digest) continue; // unchanged: no gratuitous write
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // PERSIST-0C §16: malformed CURRENT safety state locks permission
        state.pump.spoolParseErrors++;
        state.integrityLock = true;
        quarantineCopy(file, raw, log);
        log(`PERSISTENCE INTEGRITY LOCK: current ${path.basename(file)} unparseable mid-run — quarantined; permission locked`);
        slot.digest = digest; // counted once; a rewrite re-triggers
        continue;
      }
      if (!validate(parsed).ok) {
        // PERSIST-0C §16: CURRENT safety/permission state went invalid
        // mid-run — quarantine the evidence and LOCK permission; never
        // interpret it as COILED / no lock, never keep running permissively
        state.pump.spoolParseErrors++;
        state.integrityLock = true;
        quarantineCopy(file, raw, log);
        log(`PERSISTENCE INTEGRITY LOCK: current ${path.basename(file)} invalid mid-run — quarantined; permission locked`);
        slot.digest = digest;
        continue;
      }
      try {
        const r = await state.repo.saveRuntimeState(id, parsed, slot.revision);
        slot.revision = r.revision;
        slot.digest = digest; // DURABLE_CONFIRMED only after the database ack
        state.pump.confirmedWrites++;
      } catch (err) {
        pending++;
        log(`PERSISTENCE: current ${id} snapshot not yet durable (${err.code ?? err.message}) — retried next cycle`);
      }
    }
    return pending;
  }

  async function pumpOnce() {
    if (!state.db.reachable) {
      if (!(await state.db.connect())) return; // spool holds; health shows pending
    }
    await syncCurrentControls(); // protective state first, every cycle
    let pendingNow = 0;
    for (const s of pumpSources()) {
      const t = tails.get(s.key);
      const beforeOffset = t.offset;
      const beforeCount = lineCounts[s.key] ?? 0;
      let result;
      try {
        result = t.readNew();
      } catch (err) {
        state.pump.pumpReadErrors++;
        log(`PERSISTENCE DEGRADED: pump read failed for ${s.key} (${err.code ?? err.message})`);
        continue;
      }
      if (result.parseErrors > 0) {
        // a malformed complete spool line is LOST SOURCE EVIDENCE: counted
        // and logged loudly; the tail advances past it (documented policy —
        // never invented, never repaired, never claimed durable)
        state.pump.spoolParseErrors += result.parseErrors;
        log(`PERSISTENCE DEGRADED: ${result.parseErrors} malformed spool line(s) in ${s.key} — evidence not durable`);
      }
      let failed = false;
      for (let i = 0; i < result.records.length; i++) {
        try {
          await persistRecord(s.key, result.records[i], beforeCount + i + 1);
          state.pump.confirmedWrites++;
        } catch (err) {
          // DURABILITY_FAILED: roll the spool cursor back to this chunk and
          // retry next round — idempotent inserts make the replay safe;
          // nothing is dropped, nothing is claimed durable
          failed = true;
          pendingNow += result.records.length - i;
          log(`PERSISTENCE pump write failed for ${s.key}: ${err.code ?? err.message}`);
          break;
        }
      }
      if (failed) {
        t.offset = beforeOffset;
        t.partial = '';
        lineCounts[s.key] = beforeCount;
        break; // outage: stop pumping this round; health shows pending
      }
      lineCounts[s.key] = beforeCount + result.records.length;
    }
    pendingNow += await snapshotCurrentState();
    state.pump.pendingWrites = pendingNow;
    cursors.offsets = Object.fromEntries([...tails.entries()].map(([k, t]) => [k, t.offset]));
    cursors.lineCounts = lineCounts;
    try {
      atomicWriteJson(CURSORS_FILE(), cursors);
    } catch {
      // cursor persistence is best-effort; idempotent inserts make replay safe
    }
  }

  state.pumpOnce = pumpOnce;
  const timer = setInterval(() => {
    pumpOnce().catch((err) => log(`PERSISTENCE pump error (contained): ${err.message}`));
  }, PUMP_MS);
  timer.unref?.();
  state.pumpTimer = timer;
  process.once('SIGTERM', () => state.stop?.());
  process.once('SIGINT', () => state.stop?.());
}

function api(state, log) {
  const health = () =>
    persistenceHealth({
      db: state.db,
      repo: state.repo,
      migrationVersion: state.migrationVersion,
      restored: state.restored,
      pump: state.pump,
      failureCategory: state.failureCategory,
      integrityLock: state.integrityLock,
      pendingControlSync: state.pendingControlSync,
    });

  // stop() tears down EVERYTHING: retry loop first (no background retry
  // callbacks after stop), then the pump with a final drain, then the pool.
  state.stop = async () => {
    if (state.stopped) return;
    state.stopped = true;
    if (state.retryTimer) {
      clearInterval(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.pumpTimer) {
      clearInterval(state.pumpTimer);
      state.pumpTimer = null;
      try {
        await state.pumpOnce?.(); // final drain
      } catch {
        // shutdown drain best-effort
      }
    }
    await state.db.end();
  };

  return {
    db: state.db,
    repo: state.repo,
    _internal: state, // deterministic inspection for tests (timers, flags) — not an API
    health,
    // CLEAR gate for the server: permission-increasing writes need the
    // durable transaction to succeed FIRST. Unconfigured splits honestly:
    // durability REQUIRED -> refuse (PERSISTENCE_REQUIRED_UNCONFIGURED);
    // explicit local development -> legacy local behavior (documented).
    async durableClearOrRefuse() {
      if (!state.db.configured()) {
        if (durabilityRequired()) return { allow: false, reason: 'PERSISTENCE_REQUIRED_UNCONFIGURED' };
        return { allow: true, mode: 'LOCAL_ONLY_UNCONFIGURED' };
      }
      const h = health();
      if (h.permissionLock) return { allow: false, reason: 'PERSISTENCE_PERMISSION_LOCK' };
      try {
        const r = await state.repo.durableClear();
        if (r.refused) {
          // PERSIST-0B §10: the row-locked revalidation found corrupt durable
          // truth — CLEAR refused, row untouched, integrity lock engaged
          state.integrityLock = true;
          return { allow: false, reason: r.reason };
        }
        state.controlRevision = r.revision;
        return { allow: true, mode: 'DURABLE_FIRST', revision: r.revision };
      } catch (err) {
        log(`PERSISTENCE: durable CLEAR failed (${err.code ?? err.message}) — CLEAR refused, latches stand`);
        return { allow: false, reason: 'PERSISTENCE_WRITE_FAILED' };
      }
    },
    // permission-REDUCING actions apply locally FIRST (caller already did),
    // then persist; failure leaves the restriction active and health honest
    async persistControlSnapshot(controls) {
      if (!state.db.configured()) return { durable: false, reason: 'UNCONFIGURED' };
      try {
        const r = await state.repo.saveControlState(controls, state.controlRevision);
        if (r.refused) {
          // corrupt durable control truth (PERSIST-0B §11): never repaired,
          // never overwritten; local restriction stands; integrity lock holds
          state.integrityLock = true;
          state.pendingControlSync = true;
          return { durable: false, reason: r.reason };
        }
        state.controlRevision = r.revision;
        return { durable: true, revision: r.revision };
      } catch (err) {
        // PERSIST-0B §2: the failed restrictive snapshot enters the pending
        // control-sync state — the pump's syncCurrentControls() persists it
        // automatically after DB recovery (no second action, no restart)
        state.pendingControlSync = true;
        state.pump.pendingWrites++;
        log(`PERSISTENCE: control snapshot not yet durable (${err.code ?? err.message}) — restriction stays active locally; pending control sync armed`);
        return { durable: false, reason: 'WRITE_FAILED' };
      }
    },
    pumpOnce: () => state.pumpOnce?.(),
    stop: () => state.stop(),
  };
}
