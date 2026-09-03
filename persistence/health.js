// PERSIST-0 health. "Database absent" and "database empty" are different
// facts; a started process is not a healthy persistence layer; and while
// durable state is unknown, PERSISTENCE_PERMISSION_LOCK holds: permission
// may shrink during an outage — it may never grow.
export function persistenceHealth({ db, repo, migrationVersion = null, restored = false, pump = null }) {
  const configured = db?.configured() ?? false;
  const reachable = configured && (db?.reachable ?? false);
  let status;
  if (!configured) status = 'UNAVAILABLE'; // not configured: no durable authority exists
  else if (!reachable) status = 'UNAVAILABLE';
  else if ((repo?.memoryIdConflicts ?? 0) > 0 || (repo?.invalidDurableRecords ?? 0) > 0 || (pump?.pendingWrites ?? 0) > 0 || (db?.transactionErrors ?? 0) > 0) {
    status = 'DEGRADED';
  } else status = 'HEALTHY';
  return {
    status,
    databaseConfigured: configured,
    databaseReachable: reachable,
    // permission-increasing behavior locks whenever a CONFIGURED durable
    // authority is unreachable or its state was never restored this run
    permissionLock: configured && (!reachable || !restored),
    restored,
    migrationVersion,
    lastSuccessfulReadTs: db?.lastSuccessfulReadTs ?? null,
    lastSuccessfulWriteTs: db?.lastSuccessfulWriteTs ?? null,
    connectionErrors: db?.connectionErrors ?? 0,
    transactionErrors: db?.transactionErrors ?? 0,
    memoryIdConflicts: repo?.memoryIdConflicts ?? 0,
    invalidDurableRecords: repo?.invalidDurableRecords ?? 0,
    pendingDurableWrites: pump?.pendingWrites ?? 0,
    durableConfirmedWrites: pump?.confirmedWrites ?? 0,
  };
}
