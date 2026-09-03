// PERSIST-0 runtime — the one place that binds the durable core to the
// running ship. On startup it connects, migrates, RESTORES durable
// protective state (most restrictive wins) BEFORE anything else could ever
// grant permission, then runs the DURABILITY PUMP: a one-way tailer that
// carries locally spooled evidence (memory events, posture transitions,
// control/security audit, paper ledger rows) into PostgreSQL idempotently.
// Local files remain a mirror/spool; the database is durable authority.
//
// Durability states for a local record (doctrine/PERSISTENCE.md):
//   PENDING_DURABLE    — written locally, not yet confirmed by the database
//   DURABLE_CONFIRMED  — the durable insert succeeded (cursor advanced)
//   DURABILITY_FAILED  — the durable write failed; health degrades, the
//                        record stays in the spool and is retried; never
//                        silently dropped, never falsely claimed durable
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { dataDir } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { sessionDate, nowIso } from '../lib/time.js';
import { Tail } from '../memory/mirror.js';
import { Db } from './db.js';
import { Repository, mostRestrictiveControls } from './repository.js';
import { runMigrations, FutureSchemaError } from './migrate.js';
import { persistenceHealth } from './health.js';

const PUMP_MS = 5000;
const CURSORS_FILE = () => path.join(dataDir(), 'persistence', 'cursors.json');

let singleton = null;
export const getPersistence = () => singleton;

export async function startPersistence({ log = console.log, dbOverrides = {} } = {}) {
  const db = new Db({ log, ...dbOverrides });
  const repo = new Repository(db, { log });
  const state = {
    db,
    repo,
    migrationVersion: null,
    restored: false,
    controlRevision: null,
    pump: { pendingWrites: 0, confirmedWrites: 0 },
    timer: null,
  };

  if (!db.configured()) {
    // UNCONFIGURED preserves pre-PERSIST-0 local-only behavior (development
    // convenience) and says so honestly. A CONFIGURED-but-unreachable
    // database is different: it engages the permission lock (health.js).
    log('PERSISTENCE: DATABASE_URL not configured — durable core disabled; local files only (no durable authority exists)');
    singleton = api(state, log);
    return singleton;
  }

  const connected = await db.connect();
  if (!connected) {
    log('PERSISTENCE UNAVAILABLE: database configured but unreachable — PERSISTENCE_PERMISSION_LOCK engaged (CLEAR and future permission-increasing behavior fail closed; defensive controls still work locally)');
    singleton = api(state, log);
    scheduleRetry(state, log);
    return singleton;
  }

  try {
    const m = await runMigrations(db, { log });
    state.migrationVersion = m.schemaVersion;
  } catch (err) {
    if (err instanceof FutureSchemaError) {
      log(`PERSISTENCE REFUSED: ${err.message} — refusing to run against a future schema`);
      singleton = api(state, log);
      return singleton;
    }
    throw err;
  }

  // ---- STARTUP SAFETY: restore durable protective state FIRST -------------
  await restoreDurableCore(state, log);
  state.restored = true;

  // ---- durability pump: local spools -> durable authority ----------------
  startPump(state, log);

  singleton = api(state, log);
  log(`PERSISTENCE: durable core connected (schema ${state.migrationVersion}); pump running`);
  return singleton;
}

function scheduleRetry(state, log) {
  // bounded, slow retry: an outage is a state we report, not a storm we create
  state.timer = setInterval(async () => {
    if (await state.db.connect()) {
      clearInterval(state.timer);
      try {
        const m = await runMigrations(state.db, { log });
        state.migrationVersion = m.schemaVersion;
        await restoreDurableCore(state, log);
        state.restored = true;
        startPump(state, log);
        log('PERSISTENCE recovered: durable core reconnected and reconciled');
      } catch (err) {
        log(`PERSISTENCE recovery failed: ${err.message}`);
      }
    }
  }, 30_000);
  state.timer.unref?.();
}

// MOST RESTRICTIVE STATE WINS: local file vs durable row are merged toward
// less permission, the merge becomes both the local truth and (if it adds
// restriction) the durable truth. KILL in either place is KILL everywhere.
async function restoreDurableCore(state, log) {
  const { db, repo } = state;
  const controlsFile = path.join(dataDir(), 'state', 'controls.json');
  const local = existsSync(controlsFile) ? JSON.parse(readFileSync(controlsFile, 'utf8')) : { kill: null, cage: null, vetoes: [] };
  const durable = await repo.loadControlState();
  const merged = mostRestrictiveControls(durable?.state ?? {}, local);
  atomicWriteJson(controlsFile, merged, { pretty: true }); // local mirror follows the merged truth
  const saved = await repo.saveControlState(merged, durable?.revision ?? null);
  state.controlRevision = saved.revision;
  if (durable && JSON.stringify(durable.state) !== JSON.stringify(merged)) {
    log('PERSISTENCE reconciliation: control state merged toward MOST RESTRICTIVE');
  }

  // posture + lock state: a fresh body (no local file) adopts durable truth;
  // an existing local file is newer runtime truth and is pushed durable
  const postureFile = path.join(dataDir(), 'state', 'posture.json');
  const durablePosture = await repo.loadRuntimeState('posture');
  if (!existsSync(postureFile) && durablePosture) {
    atomicWriteJson(postureFile, durablePosture.state, { pretty: true });
    log(`PERSISTENCE restored posture ${durablePosture.state?.posture ?? '?'} from durable core`);
  } else if (existsSync(postureFile)) {
    await repo.saveRuntimeState('posture', JSON.parse(readFileSync(postureFile, 'utf8')));
  }
  const simFile = path.join(dataDir(), 'state', 'sim_pnl.json');
  const durableLocks = await repo.loadRuntimeState('sim_pnl');
  if (!existsSync(simFile) && durableLocks) {
    atomicWriteJson(simFile, durableLocks.state, { pretty: true });
  } else if (existsSync(simFile)) {
    await repo.saveRuntimeState('sim_pnl', JSON.parse(readFileSync(simFile, 'utf8')));
  }

  // childhood manifest identity (metadata only; bulk stays on files)
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
  const cursors = existsSync(CURSORS_FILE()) ? JSON.parse(readFileSync(CURSORS_FILE(), 'utf8')) : {};
  const tails = new Map();
  const lineCounts = { ...(cursors.lineCounts ?? {}) };
  for (const s of pumpSources()) {
    const t = new Tail(s.file, { fromStart: true });
    t.offset = cursors.offsets?.[s.key] ?? 0; // resume exactly where durability left off
    tails.set(s.key, t);
  }

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
    if (key === 'predictions') return (await repo.upsertLedgerRow('prediction', rec)).accepted || true;
    if (key === 'fills') return (await repo.upsertLedgerRow('fill', rec)).accepted || true;
    if (key === 'exits') return (await repo.upsertLedgerRow('exit', rec)).accepted || true;
    return true;
  }

  async function pumpOnce() {
    if (!state.db.reachable) {
      if (!(await state.db.connect())) return; // spool holds; health shows pending
    }
    let pendingNow = 0;
    for (const s of pumpSources()) {
      const t = tails.get(s.key);
      const beforeOffset = t.offset;
      const beforeCount = lineCounts[s.key] ?? 0;
      let result;
      try {
        result = t.readNew();
      } catch {
        continue;
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
          state.log?.(`PERSISTENCE pump write failed for ${s.key}: ${err.code ?? err.message}`);
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
    pumpOnce().catch((err) => state.log?.(`PERSISTENCE pump error (contained): ${err.message}`));
  }, PUMP_MS);
  timer.unref?.();
  state.pumpTimer = timer;
  state.log = log;
  const stop = async () => {
    clearInterval(timer);
    try {
      await pumpOnce(); // final drain
    } catch {
      // shutdown drain best-effort
    }
    await state.db.end();
  };
  state.stopPump = stop;
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

function api(state, log) {
  return {
    db: state.db,
    repo: state.repo,
    health: () => persistenceHealth({ db: state.db, repo: state.repo, migrationVersion: state.migrationVersion, restored: state.restored, pump: state.pump }),
    // CLEAR gate for the server: permission-increasing writes need the
    // durable transaction to succeed FIRST. Unconfigured -> legacy local
    // behavior (documented); configured-but-locked -> refused.
    async durableClearOrRefuse() {
      if (!state.db.configured()) return { allow: true, mode: 'LOCAL_ONLY_UNCONFIGURED' };
      const h = persistenceHealth({ db: state.db, repo: state.repo, migrationVersion: state.migrationVersion, restored: state.restored, pump: state.pump });
      if (h.permissionLock) return { allow: false, reason: 'PERSISTENCE_PERMISSION_LOCK' };
      try {
        const r = await state.repo.durableClear();
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
        state.controlRevision = r.revision;
        return { durable: true, revision: r.revision };
      } catch (err) {
        state.pump.pendingWrites++;
        log(`PERSISTENCE: control snapshot not yet durable (${err.code ?? err.message}) — restriction stays active locally`);
        return { durable: false, reason: 'WRITE_FAILED' };
      }
    },
    pumpOnce: () => state.pumpOnce?.(),
    stop: () => state.stopPump?.() ?? state.db.end(),
  };
}
