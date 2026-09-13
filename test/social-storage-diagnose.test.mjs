import test from 'node:test';
import assert from 'node:assert/strict';
import { farcasterRequestEvent, FARCASTER_REQUEST_TYPE } from '../rumor2/social-farcaster-meter.js';
import { diagnoseSocialStorage, readSocialDbSnapshot, summarizeRuntimeStatus } from '../tools/social-storage-diagnose.mjs';

const NOW = Date.parse('2026-09-13T10:00:04Z');
const DAY = '2026-09-13';

function runtimeStatus(overrides = {}) {
  return {
    ts: NOW,
    running: true,
    collectors: {
      rumor2: {
        socialFarcaster: {
          enabled: true, state: 'ACTIVE', hydrated: true, gateReason: null, coverage: 'NOT_OBSERVED', lastSuccessTs: null, lastError: null,
          stats: { appendFailures: 1 }, counters: { requests: 1, pages: 0, admitted: 0, rejected: 0, reservationAppendFailures: 0 },
          quota: { day: DAY, requests: 4, maxDailyRequests: 20 },
          queryPolicy: { mode: 'CATALOG_ROTATION', totalRequestReservations: 6, last: { requestOrdinal: 5, query: 'must never escape' } },
          providerPayload: { text: 'raw social text must never escape' },
          ...overrides,
        },
        socialX: { enabled: true, hydrated: true, lastError: null, lastStopReason: 'WATCH_SCOPE_NOT_CONFIGURED', secret: 'x-bearer-secret' },
      },
      persistence: { status: 'DEGRADED', databaseConfigured: true, databaseReachable: true, restored: true, migrationVersion: 9, transactionErrors: 1, durableConfirmedWrites: 0 },
    },
    env: { DATABASE_URL: 'postgres://secret' },
  };
}

function snapshot(events) {
  return {
    ok: true,
    selectOnly: true,
    journal: { rowCount: events.length + 4, minSeq: 1, maxSeq: events.length + 4, farcasterReservations: events.length, primaryKeyPresent: true, identityUniqueIndexPresent: true },
    reservations: events.map((event, i) => ({ seq: i + 5, event })),
    observations: [],
    catalogVerifications: [],
    truncated: { reservations: false, observations: false, catalogVerifications: false, maxRows: 20_000 },
  };
}

test('six lifetime reservations, four today, and planner ordinal five are consistent rather than a duplicate quota bug', () => {
  const events = [
    farcasterRequestEvent('2026-09-12', 1, Date.parse('2026-09-12T01:00:00Z')),
    farcasterRequestEvent('2026-09-12', 2, Date.parse('2026-09-12T02:00:00Z')),
    ...[1, 2, 3, 4].map((ordinal) => farcasterRequestEvent(DAY, ordinal, NOW + ordinal)),
  ];
  const report = diagnoseSocialStorage({ runtimeStatus: runtimeStatus(), dbSnapshot: snapshot(events), parsedConfig: { ok: true, reason: null, research: { xWatch: { mode: 'NOT_CONFIGURED', tickers: [], maxAssets: 25 } } }, nowMs: NOW });
  assert.equal(report.verdict, 'DEGRADED_CAUSE_NARROWED_NOT_PROVEN');
  assert.equal(report.database.reservations.currentDayCount, 4);
  assert.equal(report.database.reservations.currentDayMaxOrdinal, 4);
  assert.equal(report.findings.some((f) => f.code === 'RUNTIME_JOURNAL_RESERVATION_COUNT_MISMATCH'), false);
  assert.equal(report.findings.some((f) => f.code === 'CURRENT_DAY_QUOTA_HIGH_WATER_MISMATCH'), false);
  assert.equal(report.findings.some((f) => f.code === 'PLANNER_ORDINAL_MISMATCH'), false);
  assert.equal(report.findings.some((f) => f.code === 'LIFETIME_AND_DAILY_COUNTERS_DIFFER'), true);
  assert.equal(report.findings.some((f) => f.code === 'BASE_SETTLEMENT_APPEND_FAILURE_OBSERVED'), true);
  assert.equal(report.errorRetention.historicalAppendExceptionRecoverable, false);
});

test('invalid identities, duplicate ordinals, and gaps fail the diagnostic closed', () => {
  const one = farcasterRequestEvent(DAY, 1, NOW + 1);
  const duplicate = { ...farcasterRequestEvent(DAY, 1, NOW + 2), ts: new Date(NOW + 2).toISOString() };
  // Restore a valid identity for ordinal 1 with a different clock: the event is
  // individually invalid because identity excludes the clock and ts must bind it.
  const three = farcasterRequestEvent(DAY, 3, NOW + 3);
  const invalid = { ...farcasterRequestEvent(DAY, 4, NOW + 4), provider: 'NOT_FARCASTER' };
  const report = diagnoseSocialStorage({ runtimeStatus: runtimeStatus({ quota: { day: DAY, requests: 4, maxDailyRequests: 20 }, queryPolicy: { mode: 'CATALOG_ROTATION', totalRequestReservations: 4, last: { requestOrdinal: 3 } } }), dbSnapshot: snapshot([one, duplicate, three, invalid]), nowMs: NOW });
  assert.equal(report.verdict, 'JOURNAL_INTEGRITY_FAILED');
  assert.equal(report.findings.some((f) => f.code === 'INVALID_FARCASTER_RESERVATION_RECORD'), true);
  assert.equal(report.findings.some((f) => f.code === 'DUPLICATE_CURRENT_DAY_ORDINAL'), true);
  assert.equal(report.findings.some((f) => f.code === 'CURRENT_DAY_ORDINAL_GAP'), true);
});

test('runtime summary and full report never echo arbitrary payloads, queries, environment values, or credentials', () => {
  const status = runtimeStatus();
  const summary = summarizeRuntimeStatus(status);
  const report = diagnoseSocialStorage({ runtimeStatus: status, dbSnapshot: snapshot([]), nowMs: NOW });
  const serialized = JSON.stringify({ summary, report });
  for (const secret of ['raw social text must never escape', 'must never escape', 'x-bearer-secret', 'postgres://secret']) assert.equal(serialized.includes(secret), false);
});

test('exact retained parent withhold reason identifies the catalog verification producer collision', () => {
  const status = runtimeStatus();
  status.collectors.rumor2.state = 'DARK';
  status.collectors.rumor2.withholdReason = 'EVENT_HISTORY_INVALID: CORRUPTION: duplicate event identity with an altered payload (RUMOR2_SOCIAL_CATALOG_VERIFIED)';
  status.collectors.rumor2.lastSettledEventSeq = 21427;
  status.collectors.rumor2.writerEpoch = 19;
  status.collectors.rumor2.checkpointRevision = 201;
  const report = diagnoseSocialStorage({ runtimeStatus: status, dbSnapshot: snapshot([]), nowMs: NOW });
  assert.equal(report.verdict, 'JOURNAL_INTEGRITY_FAILED');
  assert.equal(report.findings.some((f) => f.code === 'CATALOG_VERIFICATION_IDENTITY_COLLISION_CONFIRMED'), true);
  assert.equal(report.runtime.rumor2.lastSettledEventSeq, 21427);
});

test('database collector executes only fixed SELECTs and returns metadata rather than observation content', async () => {
  const queries = [];
  let ended = false;
  const reservation = farcasterRequestEvent(DAY, 1, NOW);
  const db = {
    configured: () => true,
    connect: async () => true,
    query: async (sql, params = []) => {
      queries.push(sql);
      if (sql.includes('COUNT(*)::text')) return { rows: [{ row_count: '2', min_seq: '1', max_seq: '2', farcaster_reservations: '1' }] };
      if (sql.includes('FROM pg_indexes')) return { rows: [
        { indexname: 'serpent_rumor2_events_pkey', indexdef: 'CREATE UNIQUE INDEX serpent_rumor2_events_pkey ON public.serpent_rumor2_events USING btree (stream, event_seq)' },
        { indexname: 'uq_rumor2_event_identity', indexdef: 'CREATE UNIQUE INDEX uq_rumor2_event_identity ON public.serpent_rumor2_events USING btree (stream, event_type, event_id)' },
      ] };
      if (sql.includes('diagnostic_event') && params[1] === FARCASTER_REQUEST_TYPE) return { rows: [{ event_seq: '1', diagnostic_event: reservation }] };
      if (sql.includes('diagnostic_event')) return { rows: [] };
      return { rows: [{ event_seq: '2', event_type: 'RUMOR2_SOCIAL_OBSERVED_V2', provider: 'FARCASTER_OFFICIAL', known_at_ts: String(NOW) }] };
    },
    end: async () => { ended = true; },
  };
  const result = await readSocialDbSnapshot({ db });
  assert.equal(result.ok, true);
  assert.equal(result.observations[0].provider, 'FARCASTER_OFFICIAL');
  assert.equal(Object.hasOwn(result.observations[0], 'text'), false);
  assert.equal(ended, true);
  assert.equal(queries.length, 5);
  for (const sql of queries) assert.match(sql.trim(), /^SELECT\b/i);
});

test('database errors expose only the PostgreSQL class code and never the server message', async () => {
  const db = {
    configured: () => true,
    connect: async () => true,
    query: async () => { throw Object.assign(new Error('postgres://user:password@host raw secret'), { code: '22P02' }); },
    end: async () => {},
  };
  const result = await readSocialDbSnapshot({ db });
  assert.deepEqual(result, { ok: false, category: 'DATABASE_READ_FAILED', error: { code: '22P02', name: 'Error' } });
  assert.equal(JSON.stringify(result).includes('password'), false);
});

test('Farcaster reservation constant remains the expected journal discriminator', () => {
  assert.equal(FARCASTER_REQUEST_TYPE, 'RUMOR2_FARCASTER_SEARCH_RESERVED');
});
