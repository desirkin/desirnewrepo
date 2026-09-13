// PERSIST-0 §21 — EXPLICIT one-time / re-run-safe migration of existing
// workspace-local data into the durable core. Never runs automatically.
// Validates before import, imports idempotently, deletes nothing, and
// reports exactly what it saw. Usage:  node persistence/migrate-local.js
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { dataDir } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { validateEnvelope } from '../memory/validate.js';
import { Db } from './db.js';
import { Repository, mostRestrictiveControls } from './repository.js';
import { runMigrations } from './migrate.js';
import { validatePostureState, validateSimState } from './validate-state.js';
import { readControls as readLocalControls } from '../state/controls.js';
import { canonicalJson } from './schema.js';

const canonicalMatch = (a, b) => canonicalJson(a) === canonicalJson(b);

export async function migrateLocalData({ db, log = console.log } = {}) {
  const repo = new Repository(db, { log });
  const report = { startedTs: nowIso(), filesInspected: [], missingFiles: [], subsystems: {} };
  const d = dataDir();
  const readJsonl = (file) => {
    if (!existsSync(file)) {
      report.missingFiles.push(path.relative(d, file));
      return null;
    }
    report.filesInspected.push(path.relative(d, file));
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l, i) => {
        try {
          return { rec: JSON.parse(l), line: i + 1, raw: l };
        } catch {
          return { invalid: true, line: i + 1 };
        }
      });
  };
  const tally = () => ({ accepted: 0, duplicates: 0, invalid: 0, conflicts: 0 });

  // ---- control state (merge toward restriction, never regress). The read
  // goes through THE local control store (PERSIST-0C §4): a corrupt local
  // mirror fail-closes into KILL there rather than being interpreted here.
  const controlsFile = path.join(d, 'state', 'controls.json');
  if (existsSync(controlsFile)) {
    report.filesInspected.push('state/controls.json');
    const local = readLocalControls(); // validated; corrupt -> fail-closed KILL
    const durable = await repo.loadControlState();
    if (durable?.invalid) {
      report.subsystems.controlState = { merged: false, refused: 'durable control state invalid — manual resolution required' };
    } else {
      const saved = await repo.saveControlState(mostRestrictiveControls(durable?.state ?? {}, local), durable?.revision ?? null);
      report.subsystems.controlState = saved.refused ? { merged: false, refused: saved.reason } : { merged: true };
    }
  } else report.missingFiles.push('state/controls.json');

  // ---- current posture + sim/lock state (validated; saveRuntimeState with
  // no proven revision reconciles toward LESS PERMISSION, never overwrites)
  for (const [id, file, validate] of [
    ['posture', path.join(d, 'state', 'posture.json'), validatePostureState],
    ['sim_pnl', path.join(d, 'state', 'sim_pnl.json'), validateSimState],
  ]) {
    if (existsSync(file)) {
      report.filesInspected.push(path.relative(d, file));
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        parsed = null;
      }
      if (parsed && validate(parsed).ok) {
        const r = await repo.saveRuntimeState(id, parsed, null);
        report.subsystems[id] = { imported: true, reconciled: canonicalMatch(r.state, parsed) ? false : true };
      } else {
        report.subsystems[id] = { imported: false, refused: 'malformed/invalid local state' };
      }
    } else report.missingFiles.push(path.relative(d, file));
  }

  // ---- history streams (idempotent by source line identity)
  for (const [key, file, save] of [
    ['postureTransitions', path.join(d, 'state', 'transitions.jsonl'), (r, n) => repo.appendPostureTransition('transitions.jsonl', n, r)],
    ['controlLog', path.join(d, 'state', 'controls_log.jsonl'), (r, n) => repo.appendControlAudit('controls_log', n, r)],
    ['authLog', path.join(d, 'state', 'control_auth_log.jsonl'), (r, n) => repo.appendControlAudit('auth_log', n, r)],
  ]) {
    const rows = readJsonl(file);
    if (!rows) continue;
    const t = tally();
    for (const row of rows) {
      if (row.invalid) {
        t.invalid++;
        continue;
      }
      const r = await save(row.rec, row.line);
      if (r.accepted) t.accepted++;
      else if (r.conflict) t.conflicts++;
      else t.duplicates++;
    }
    report.subsystems[key] = t;
  }

  // ---- paper ledger (deterministic prediction_id keys)
  for (const [kind, file] of [
    ['prediction', path.join(d, 'ledger', 'predictions.jsonl')],
    ['fill', path.join(d, 'ledger', 'fills.jsonl')],
    ['exit', path.join(d, 'ledger', 'exits.jsonl')],
  ]) {
    const rows = readJsonl(file);
    if (!rows) continue;
    const t = tally();
    for (const row of rows) {
      if (row.invalid || !row.rec.prediction_id) {
        t.invalid++;
        continue;
      }
      const r = await repo.upsertLedgerRow(kind, row.rec);
      if (r.accepted) t.accepted++;
      else if (r.conflict) t.conflicts++;
      else if (r.invalid) t.invalid++;
      else t.duplicates++;
    }
    report.subsystems[`ledger_${kind}`] = t;
  }

  // ---- canonical memory: every record re-earns its way through the
  // canonical validator before it may become durable
  const memRows = readJsonl(path.join(d, 'memory', 'events.jsonl'));
  if (memRows) {
    const t = tally();
    for (const row of memRows) {
      if (row.invalid || !validateEnvelope(row.rec).ok) {
        t.invalid++;
        continue;
      }
      const r = await repo.insertMemoryEvent(row.rec, row.raw.trim());
      if (r.outcome === 'INSERTED') t.accepted++;
      else if (r.outcome === 'DUPLICATE') t.duplicates++;
      else t.conflicts++;
    }
    report.subsystems.memory = t;
  }

  report.finishedTs = nowIso();
  return report;
}

// CLI entry — explicit, never automatic. Deliberately refuses without a
// configured database; prints and stores the report; deletes no source.
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const db = new Db({ log: console.log });
  if (!db.configured()) {
    console.error('MIGRATION REFUSED: DATABASE_URL is not configured. Nothing was touched.');
    process.exit(1);
  }
  if (!(await db.connect())) {
    console.error('MIGRATION REFUSED: database configured but unreachable. Nothing was touched.');
    process.exit(1);
  }
  await runMigrations(db, { log: console.log });
  const report = await migrateLocalData({ db });
  atomicWriteJson(path.join(dataDir(), 'persistence', 'migration-report.json'), report, { pretty: true });
  console.log(JSON.stringify(report, null, 2));
  console.log('MIGRATION COMPLETE — source files were NOT deleted; report saved to data/persistence/migration-report.json');
  await db.end();
}
