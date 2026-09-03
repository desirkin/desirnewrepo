// PERSIST-0 health. "Database absent" and "database empty" are different
// facts; a started process is not a healthy persistence layer; and while
// durable state is unknown, PERSISTENCE_PERMISSION_LOCK holds: permission
// may shrink during an outage — it may never grow.

// PERSIST-0A §1 — the ONE authoritative durability requirement. A published
// Replit deployment (REPLIT_DEPLOYMENT=1) REQUIRES durable persistence, as
// does the explicit override SERPENT_DURABLE_REQUIRED=1. A published
// deployment can never override this to false — there is no disable knob.
export function durabilityRequired(env = process.env) {
  return env.REPLIT_DEPLOYMENT === '1' || env.SERPENT_DURABLE_REQUIRED === '1';
}

export function persistenceHealth({
  db,
  repo,
  migrationVersion = null,
  restored = false,
  pump = null,
  failureCategory = null,
  conflictLock = false,
}) {
  const configured = db?.configured() ?? false;
  const reachable = configured && (db?.reachable ?? false);
  const required = durabilityRequired();
  const degradedCounters =
    (repo?.memoryIdConflicts ?? 0) > 0 ||
    (repo?.invalidDurableRecords ?? 0) > 0 ||
    (repo?.ledgerIdConflicts ?? 0) > 0 ||
    (repo?.auditIdConflicts ?? 0) > 0 ||
    (pump?.pendingWrites ?? 0) > 0 ||
    (pump?.spoolParseErrors ?? 0) > 0 ||
    (pump?.pumpReadErrors ?? 0) > 0 ||
    (db?.transactionErrors ?? 0) > 0;
  let status;
  if (!configured) status = 'UNAVAILABLE'; // not configured: no durable authority exists
  else if (!reachable) status = 'UNAVAILABLE';
  else if (!restored || failureCategory || conflictLock || degradedCounters) status = 'DEGRADED';
  else status = 'HEALTHY';
  return {
    status,
    databaseConfigured: configured,
    databaseReachable: reachable,
    durabilityRequired: required,
    // permission-increasing behavior locks whenever (a) a CONFIGURED durable
    // authority is unreachable or its state was never restored this run,
    // (b) durability is REQUIRED but no authority is configured/restored, or
    // (c) an unresolved durable content conflict demands manual resolution
    permissionLock: (configured && (!reachable || !restored)) || (required && (!configured || !restored)) || conflictLock,
    restored,
    migrationVersion,
    failureCategory, // safe category only — never connection details
    lastSuccessfulReadTs: db?.lastSuccessfulReadTs ?? null,
    lastSuccessfulWriteTs: db?.lastSuccessfulWriteTs ?? null,
    connectionErrors: db?.connectionErrors ?? 0,
    transactionErrors: db?.transactionErrors ?? 0,
    memoryIdConflicts: repo?.memoryIdConflicts ?? 0,
    invalidDurableRecords: repo?.invalidDurableRecords ?? 0,
    ledgerIdConflicts: repo?.ledgerIdConflicts ?? 0,
    auditIdConflicts: repo?.auditIdConflicts ?? 0,
    runtimeStateConflicts: repo?.runtimeStateConflicts ?? 0,
    pendingDurableWrites: pump?.pendingWrites ?? 0,
    durableConfirmedWrites: pump?.confirmedWrites ?? 0,
    spoolParseErrors: pump?.spoolParseErrors ?? 0,
    pumpReadErrors: pump?.pumpReadErrors ?? 0,
  };
}
