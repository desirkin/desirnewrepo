#!/usr/bin/env node
// Read-only Social/Farcaster durability diagnostic.
//
// This command deliberately does not start persistence, run migrations, acquire
// a writer fence, call a provider, or print an event body.  The only database
// statements are fixed SELECTs through the normal Db boundary.  Farcaster
// reservation records contain no post text; observation rows are reduced to
// provider/clock metadata by PostgreSQL before they enter this process.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJsonBounded } from '../lib/jsonl.js';
import { dataDir, loadConfig } from '../lib/config.js';
import { parseSocialResearchConfig, SOCIAL_X_WATCH_MAX_ASSETS } from '../rumor2/social-catalog.js';
import { FARCASTER_REQUEST_TYPE, farcasterRequestError } from '../rumor2/social-farcaster-meter.js';
import { SOCIAL_OBSERVATION_TYPES, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, validateSocialCatalogVerifiedEvent } from '../rumor2/social-settle.js';

const STREAM = 'rumor2';
const PROVIDER = 'FARCASTER_OFFICIAL';
const MAX_DIAGNOSTIC_ROWS = 20_000;

const int = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};
const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const bool = (value) => (typeof value === 'boolean' ? value : null);
const code = (value) => (typeof value === 'string' && value.length <= 160 ? value : null);
const dayOf = (value) => {
  const n = int(value);
  if (n === null || n < 0 || n > 8_640_000_000_000_000) return null;
  try { return new Date(n).toISOString().slice(0, 10); } catch { return null; }
};

function summarizeProvider(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  return {
    enabled: bool(status.enabled),
    state: code(status.state),
    hydrated: bool(status.hydrated),
    gateReason: code(status.gateReason),
    coverage: code(status.coverage),
    lastSuccessTs: int(status.lastSuccessTs),
    lastError: code(status.lastError),
    lastStopReason: code(status.lastStopReason),
    appendFailures: int(status.stats?.appendFailures),
    reservationAppendFailures: int(status.counters?.reservationAppendFailures),
    processRequests: int(status.counters?.requests),
    pages: int(status.counters?.pages),
    admitted: int(status.counters?.admitted),
    rejected: int(status.counters?.rejected),
    quota: {
      day: code(status.quota?.day),
      requests: int(status.quota?.requests),
      maxDailyRequests: int(status.quota?.maxDailyRequests),
    },
    queryPolicy: {
      mode: code(status.queryPolicy?.mode),
      totalRequestReservations: int(status.queryPolicy?.totalRequestReservations),
      lastRequestOrdinal: int(status.queryPolicy?.last?.requestOrdinal),
    },
  };
}

// Allowlist the runtime fields.  In particular, never echo query strings,
// post bodies, author ids, access records, environment values, or credentials.
export function summarizeRuntimeStatus(status) {
  const rumor = status?.collectors?.rumor2;
  const persistence = status?.collectors?.persistence;
  return {
    capturedTs: int(status?.tsMs ?? status?.ts),
    running: bool(status?.running),
    rumor2: rumor && typeof rumor === 'object' ? {
      state: code(rumor.state),
      lifecycle: code(rumor.lifecycle),
      withholdReason: code(rumor.withholdReason),
      lastSettledEventSeq: int(rumor.lastSettledEventSeq),
      writerEpoch: int(rumor.writerEpoch),
      checkpointRevision: int(rumor.checkpointRevision),
    } : null,
    farcaster: summarizeProvider(rumor?.socialFarcaster),
    x: summarizeProvider(rumor?.socialX),
    persistence: persistence && typeof persistence === 'object' ? {
      status: code(persistence.status),
      databaseConfigured: bool(persistence.databaseConfigured),
      databaseReachable: bool(persistence.databaseReachable),
      restored: bool(persistence.restored),
      migrationVersion: int(persistence.migrationVersion),
      failureCategory: code(persistence.failureCategory),
      integrityLock: bool(persistence.integrityLock),
      permissionLock: bool(persistence.permissionLock),
      transactionErrors: int(persistence.transactionErrors),
      connectionErrors: int(persistence.connectionErrors),
      durableConfirmedWrites: int(persistence.durableConfirmedWrites),
      pendingDurableWrites: int(persistence.pendingDurableWrites),
    } : null,
  };
}

function safeDbError(error) {
  // PostgreSQL codes identify the exact error class without exposing a URL,
  // SQL text, provider content, schema details, or a server-supplied message.
  return {
    code: typeof error?.code === 'string' && /^[A-Z0-9]{2,10}$/.test(error.code) ? error.code : null,
    name: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'Error',
  };
}

export async function readSocialDbSnapshot({ db, maxRows = MAX_DIAGNOSTIC_ROWS } = {}) {
  if (!db?.configured?.()) return { ok: false, category: 'DATABASE_URL_NOT_CONFIGURED', error: null };
  if (!(await db.connect())) {
    await db.end().catch(() => {});
    return { ok: false, category: 'DATABASE_UNREACHABLE', error: null };
  }
  try {
    const summary = await db.query(
      `SELECT COUNT(*)::text AS row_count,
              COALESCE(MIN(event_seq), 0)::text AS min_seq,
              COALESCE(MAX(event_seq), 0)::text AS max_seq,
              COUNT(*) FILTER (WHERE event_type = $2)::text AS farcaster_reservations
         FROM serpent_rumor2_events
        WHERE stream = $1`,
      [STREAM, FARCASTER_REQUEST_TYPE]
    );
    const indexes = await db.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'serpent_rumor2_events'
        ORDER BY indexname`
    );
    const reservations = await db.query(
      `SELECT event_seq::text AS event_seq, event::jsonb AS diagnostic_event
         FROM serpent_rumor2_events
        WHERE stream = $1 AND event_type = $2
        ORDER BY event_seq DESC
        LIMIT $3`,
      [STREAM, FARCASTER_REQUEST_TYPE, maxRows + 1]
    );
    const observations = await db.query(
      `SELECT event_seq::text AS event_seq,
              event_type,
              event::jsonb ->> 'provider' AS provider,
              event::jsonb ->> 'knownAtTs' AS known_at_ts
         FROM serpent_rumor2_events
        WHERE stream = $1
          AND event_type = ANY($2::text[])
          AND event::jsonb ->> 'provider' = $3
        ORDER BY event_seq DESC
        LIMIT $4`,
      [STREAM, [...SOCIAL_OBSERVATION_TYPES], PROVIDER, maxRows + 1]
    );
    const catalogVerifications = await db.query(
      `SELECT event_seq::text AS event_seq, event::jsonb AS diagnostic_event
         FROM serpent_rumor2_events
        WHERE stream = $1 AND event_type = $2
        ORDER BY event_seq DESC
        LIMIT $3`,
      [STREAM, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, maxRows + 1]
    );
    const row = summary.rows[0] ?? {};
    const reservationTruncated = reservations.rows.length > maxRows;
    const observationTruncated = observations.rows.length > maxRows;
    const catalogVerificationTruncated = catalogVerifications.rows.length > maxRows;
    const reservationRows = reservations.rows.slice(0, maxRows).reverse().map((r) => ({ seq: int(r.event_seq), event: r.diagnostic_event }));
    const observationRows = observations.rows.slice(0, maxRows).reverse().map((r) => ({ seq: int(r.event_seq), type: code(r.event_type), provider: code(r.provider), knownAtTs: int(r.known_at_ts) }));
    // Catalog verification events are operational metadata only: their closed
    // contract contains no post body, author/query, provider payload, or key.
    const catalogVerificationRows = catalogVerifications.rows.slice(0, maxRows).reverse().map((r) => ({ seq: int(r.event_seq), event: r.diagnostic_event }));
    const definitions = indexes.rows.map((r) => ({ name: r.indexname, definition: String(r.indexdef ?? '') }));
    return {
      ok: true,
      selectOnly: true,
      journal: {
        rowCount: int(row.row_count),
        minSeq: int(row.min_seq),
        maxSeq: int(row.max_seq),
        farcasterReservations: int(row.farcaster_reservations),
        primaryKeyPresent: definitions.some((r) => r.name === 'serpent_rumor2_events_pkey' && /UNIQUE INDEX/i.test(r.definition)),
        identityUniqueIndexPresent: definitions.some((r) => r.name === 'uq_rumor2_event_identity' && /UNIQUE INDEX/i.test(r.definition)),
      },
      reservations: reservationRows,
      observations: observationRows,
      catalogVerifications: catalogVerificationRows,
      truncated: { reservations: reservationTruncated, observations: observationTruncated, catalogVerifications: catalogVerificationTruncated, maxRows },
    };
  } catch (error) {
    return { ok: false, category: 'DATABASE_READ_FAILED', error: safeDbError(error) };
  } finally {
    await db.end().catch(() => {});
  }
}

function reservationAnalysis(snapshot, currentDay) {
  const rows = Array.isArray(snapshot?.reservations) ? snapshot.reservations : [];
  const invalid = [];
  const valid = [];
  for (const row of rows) {
    const error = farcasterRequestError(row?.event);
    if (row?.seq === null || error) invalid.push({ seq: row?.seq ?? null, error: code(error) ?? 'INVALID_SEQUENCE' });
    else valid.push({ seq: row.seq, day: row.event.day, ordinal: row.event.ordinal, knownAtTs: row.event.knownAtTs });
  }
  const today = valid.filter((r) => r.day === currentDay).sort((a, b) => a.ordinal - b.ordinal || a.seq - b.seq);
  const duplicateOrdinals = [...new Set(today.filter((r, i) => i > 0 && r.ordinal === today[i - 1].ordinal).map((r) => r.ordinal))];
  const ordinalGaps = [];
  let expected = 1;
  for (const row of today) {
    while (expected < row.ordinal) ordinalGaps.push(expected++);
    if (row.ordinal >= expected) expected = row.ordinal + 1;
  }
  const observations = (Array.isArray(snapshot?.observations) ? snapshot.observations : []).filter((r) => r?.provider === PROVIDER && Number.isSafeInteger(r.seq));
  const evidenceByReservation = valid.map((request, index) => {
    const nextSeq = valid[index + 1]?.seq ?? Number.POSITIVE_INFINITY;
    return { seq: request.seq, day: request.day, ordinal: request.ordinal, durableObservationsBeforeNextReservation: observations.filter((o) => o.seq > request.seq && o.seq < nextSeq).length };
  });
  return {
    retrieved: rows.length,
    invalid,
    currentDay,
    currentDayCount: today.length,
    currentDayMaxOrdinal: today.length ? Math.max(...today.map((r) => r.ordinal)) : 0,
    duplicateOrdinals,
    ordinalGaps,
    evidenceByReservation,
  };
}

function xWatchSummary(parsedConfig) {
  const x = parsedConfig?.research?.xWatch;
  return {
    configValid: parsedConfig?.ok === true,
    configReason: code(parsedConfig?.reason),
    currentMode: code(x?.mode) ?? 'NOT_CONFIGURED',
    configuredTickerCount: Array.isArray(x?.tickers) ? x.tickers.length : 0,
    maxAssets: int(x?.maxAssets),
    activationLaw: {
      mode: 'EXPLICIT_STATIC',
      tickerRule: '1..maxAssets unique uppercase canonical bases, each present in the current fresh accepted Kraken USD catalog',
      capRule: `maxAssets must be an integer from 1 through ${SOCIAL_X_WATCH_MAX_ASSETS}; verified tickers are never silently truncated`,
      freshnessRule: 'a stale, unavailable, future-dated, or unaccepted catalog authorizes no new X scope',
      fallbackRule: 'the broad catalog and PROPOSED watch plan never become a paid X rule set automatically',
    },
  };
}

function catalogVerificationAnalysis(snapshot) {
  const rows = Array.isArray(snapshot?.catalogVerifications) ? snapshot.catalogVerifications : [];
  const invalid = [];
  for (const row of rows) {
    const error = validateSocialCatalogVerifiedEvent(row?.event);
    if (row?.seq === null || error) invalid.push({ seq: row?.seq ?? null, error: code(error) ?? 'INVALID_SEQUENCE' });
  }
  return { retrieved: rows.length, validSharedIdentities: rows.length - invalid.length, invalid };
}

export function diagnoseSocialStorage({ runtimeStatus = null, dbSnapshot = null, parsedConfig = null, nowMs = Date.now() } = {}) {
  const runtime = summarizeRuntimeStatus(runtimeStatus);
  const currentDay = runtime.farcaster?.quota?.day ?? dayOf(nowMs);
  const reservations = dbSnapshot?.ok ? reservationAnalysis(dbSnapshot, currentDay) : null;
  const catalogVerifications = dbSnapshot?.ok ? catalogVerificationAnalysis(dbSnapshot) : null;
  const findings = [];
  const add = (severity, findingCode, detail) => findings.push({ severity, code: findingCode, detail });

  if (!dbSnapshot?.ok) {
    add('ERROR', dbSnapshot?.category ?? 'DATABASE_SNAPSHOT_UNAVAILABLE', 'No journal conclusion is possible until the SELECT-only database snapshot succeeds.');
  } else {
    const j = dbSnapshot.journal;
    const contiguous = j.rowCount === 0 ? j.minSeq === 0 && j.maxSeq === 0 : j.minSeq === 1 && j.rowCount === j.maxSeq;
    if (!contiguous) add('CRITICAL', 'JOURNAL_SEQUENCE_NOT_CONTIGUOUS', `rowCount=${j.rowCount}, minSeq=${j.minSeq}, maxSeq=${j.maxSeq}`);
    if (!j.primaryKeyPresent) add('CRITICAL', 'JOURNAL_PRIMARY_KEY_MISSING', 'The expected (stream,event_seq) primary-key index was not found.');
    if (!j.identityUniqueIndexPresent) add('CRITICAL', 'JOURNAL_IDENTITY_INDEX_MISSING', 'The expected unique event-identity index was not found.');
    if (dbSnapshot.truncated?.reservations) add('WARN', 'RESERVATION_DIAGNOSTIC_TRUNCATED', `Only the newest ${dbSnapshot.truncated.maxRows} reservation rows were inspected.`);
    if (dbSnapshot.truncated?.catalogVerifications) add('WARN', 'CATALOG_VERIFICATION_DIAGNOSTIC_TRUNCATED', `Only the newest ${dbSnapshot.truncated.maxRows} catalog-verification rows were inspected.`);
    if (reservations.invalid.length) add('CRITICAL', 'INVALID_FARCASTER_RESERVATION_RECORD', `${reservations.invalid.length} retained request reservation record(s) failed the closed meter contract.`);
    if (reservations.duplicateOrdinals.length) add('CRITICAL', 'DUPLICATE_CURRENT_DAY_ORDINAL', `Duplicate ordinals: ${reservations.duplicateOrdinals.join(',')}`);
    if (reservations.ordinalGaps.length) add('ERROR', 'CURRENT_DAY_ORDINAL_GAP', `Missing current-day ordinals: ${reservations.ordinalGaps.slice(0, 25).join(',')}`);
    if (catalogVerifications.invalid.length) add('CRITICAL', 'INVALID_CATALOG_VERIFICATION_RECORD', `${catalogVerifications.invalid.length} retained catalog-verification record(s) failed their closed legacy/provider-scoped contracts.`);
    const journalTotal = j.farcasterReservations;
    const runtimeTotal = runtime.farcaster?.queryPolicy?.totalRequestReservations;
    if (runtimeTotal !== null && journalTotal !== null && runtimeTotal !== journalTotal) add('WARN', 'RUNTIME_JOURNAL_RESERVATION_COUNT_MISMATCH', `runtime=${runtimeTotal}, journal=${journalTotal}; rule out status-file/SELECT timing skew before treating this as corruption.`);
    const quotaUsed = runtime.farcaster?.quota?.requests;
    if (quotaUsed !== null && reservations.currentDayMaxOrdinal !== quotaUsed) add('ERROR', 'CURRENT_DAY_QUOTA_HIGH_WATER_MISMATCH', `runtime=${quotaUsed}, journalHighWater=${reservations.currentDayMaxOrdinal}`);
    const lastOrdinal = runtime.farcaster?.queryPolicy?.lastRequestOrdinal;
    if (lastOrdinal !== null && runtimeTotal !== null && runtimeTotal > 0 && lastOrdinal !== runtimeTotal - 1) add('WARN', 'PLANNER_ORDINAL_MISMATCH', `lastRequestOrdinal=${lastOrdinal}, expected=${runtimeTotal - 1}`);
    if (journalTotal !== null && quotaUsed !== null && journalTotal !== quotaUsed) add('INFO', 'LIFETIME_AND_DAILY_COUNTERS_DIFFER', `${journalTotal} is the lifetime durable reservation count; ${quotaUsed} is the current UTC-day ordinal high-water. These are intentionally different units.`);
  }

  const appendFailures = runtime.farcaster?.appendFailures;
  const reservationFailures = runtime.farcaster?.reservationAppendFailures;
  if (appendFailures !== null && appendFailures > 0) {
    if (reservationFailures !== null && reservationFailures > 0) add('ERROR', 'RESERVATION_APPEND_RETRY_ACTIVE_OR_OBSERVED', `${reservationFailures} request-reservation append failure(s) occurred; the runtime retains and retries the same reservation identity before any provider call.`);
    if (reservationFailures === 0 || reservationFailures === null) add('ERROR', 'BASE_SETTLEMENT_APPEND_FAILURE_OBSERVED', 'The append failure is not proven to be a reservation failure; a Social scope/evidence batch failure is the leading code-path explanation.');
  }
  if ((runtime.persistence?.transactionErrors ?? 0) > 0) add('ERROR', 'DATABASE_TRANSACTION_ERROR_OBSERVED', `${runtime.persistence.transactionErrors} database transaction error(s) occurred in this process; the health counter is global and does not identify the caller.`);
  if (runtime.farcaster?.lastError === null && (appendFailures ?? 0) > 0) add('WARN', 'FARCASTER_LAST_ERROR_MASKED_OR_CLEARED', 'A null wrapper lastError does not clear the base Social append failure; the wrapper status currently overwrites the base field.');
  if (/duplicate event identity with an altered payload \(RUMOR2_SOCIAL_CATALOG_VERIFIED\)/.test(runtime.rumor2?.withholdReason ?? '')) add('CRITICAL', 'CATALOG_VERIFICATION_IDENTITY_COLLISION_CONFIRMED', 'Two provider-scoped ears prepared one shared venue/content/observedTs identity with different truthful settle clocks. First durable truth remains valid; producers must durable-lookup and canonically adopt the shared identity before append and retry.');
  if (runtime.x?.lastStopReason === 'WATCH_SCOPE_NOT_CONFIGURED' || runtime.x?.gateReason === 'WATCH_SCOPE_NOT_CONFIGURED') add('INFO', 'X_EXPLICIT_SCOPE_REQUIRED', 'X correctly makes zero requests until an explicit static ticker list is verified against a fresh accepted catalog.');

  return {
    version: 'social-storage-diagnostic-1',
    generatedTs: int(nowMs),
    safety: { databaseStatements: 'SELECT_ONLY', providerCalls: false, filesystemWrites: false, rawSocialContentPrinted: false, credentialsPrinted: false },
    runtime,
    xWatch: xWatchSummary(parsedConfig),
    database: dbSnapshot?.ok ? { ok: true, selectOnly: dbSnapshot.selectOnly === true, journal: dbSnapshot.journal, truncated: dbSnapshot.truncated, reservations, catalogVerifications } : { ok: false, category: dbSnapshot?.category ?? 'UNAVAILABLE', error: dbSnapshot?.error ?? null },
    errorRetention: {
      historicalAppendExceptionRecoverable: false,
      reason: 'rumor2JournalStore maps ordinary repository exceptions to UNAVAILABLE, persistence health retains only a counter, and Farcaster status can overwrite the base lastError. PostgreSQL does not retain the application exception after rollback.',
      requiredFutureFix: 'retain a sanitized error code/category at the journal boundary and preserve base.lastError separately from transport.lastError',
    },
    verdict: findings.some((f) => f.severity === 'CRITICAL') ? 'JOURNAL_INTEGRITY_FAILED' : findings.some((f) => f.severity === 'ERROR') ? 'DEGRADED_CAUSE_NARROWED_NOT_PROVEN' : 'NO_STRUCTURAL_RESERVATION_BUG_PROVEN',
    findings,
  };
}

async function defaultDbFactory(url) {
  // Keep the pg driver out of pure/unit-test imports.  Production invocation
  // loads the existing database boundary only when it is about to run SELECTs.
  const { Db } = await import('../persistence/db.js');
  return new Db({ url, log: () => {} });
}

export async function runSocialStorageDiagnostic({ env = process.env, nowMs = Date.now(), dbFactory = defaultDbFactory, readStatus = null, config = null } = {}) {
  const root = dataDir(config ?? loadConfig());
  let runtimeStatus = null;
  try {
    // runtime unification step 5: canonical serpent/ path first, the one-release data-only/ mirror as fallback
    const canonical = path.join(root, 'serpent', 'runtime-status.json');
    runtimeStatus = readStatus ? await readStatus() : readJsonBounded(existsSync(canonical) ? canonical : path.join(root, 'data-only', 'runtime-status.json'), 16 * 1024 * 1024);
  } catch {
    // The database diagnostic remains useful without the ephemeral status mirror.
  }
  const effectiveConfig = config ?? loadConfig();
  const parsedConfig = parseSocialResearchConfig(effectiveConfig);
  const db = await dbFactory(env.DATABASE_URL);
  const dbSnapshot = await readSocialDbSnapshot({ db });
  return diagnoseSocialStorage({ runtimeStatus, dbSnapshot, parsedConfig, nowMs });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const report = await runSocialStorageDiagnostic();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.database.ok || report.verdict === 'JOURNAL_INTEGRITY_FAILED') process.exitCode = 1;
}
