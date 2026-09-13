import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createYouTubeQuotaLedger,
  youtubeQuotaReservationError,
  youtubeQuotaReservationEvent,
  YOUTUBE_QUOTA_RESERVATION_TYPE,
} from '../rumor2/providers/youtube-quota.js';
import { createYouTubeClient } from '../rumor2/providers/youtube-client.js';

const T = Date.parse('2026-09-13T12:00:00.000Z');
const SCOPE = { ok: true, scopeId: 'a'.repeat(40), tickers: ['BTC'] };
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  async text() { return JSON.stringify(body); },
});

test('YouTube quota ledger requires hydration and preserves reservations across replay', () => {
  const ledger = createYouTubeQuotaLedger({ now: () => T, dailyBudgetUnits: 200, monthlyBudgetUnits: 300 });
  assert.equal(ledger.reserve({ knownAtTs: T }).reason, 'QUOTA_LEDGER_NOT_HYDRATED');
  assert.equal(ledger.hydrate([]).ok, true);
  const reservation = ledger.reserve({ knownAtTs: T });
  assert.equal(reservation.ok, true);
  assert.equal(reservation.event.type, YOUTUBE_QUOTA_RESERVATION_TYPE);
  assert.equal(youtubeQuotaReservationError(reservation.event), null);
  assert.equal(ledger.commit(reservation.event).ok, true);
  const second = ledger.reserve({ knownAtTs: T });
  assert.equal(second.ok, true);
  assert.equal(ledger.commit(second.event).ok, true);
  const third = ledger.reserve({ knownAtTs: T });
  assert.equal(third.reason, 'DAILY_QUOTA_EXHAUSTED');

  const replayed = createYouTubeQuotaLedger({ now: () => T, dailyBudgetUnits: 200, monthlyBudgetUnits: 300 });
  assert.equal(replayed.hydrate([reservation.event]).ok, true);
  assert.equal(replayed.status().dailyUsedUnits, 100);
  assert.equal(replayed.status().monthlyUsedUnits, 100);
  const malformed = youtubeQuotaReservationEvent({ day: '2026-09-13', ordinal: 1, knownAtTs: T, units: 99 });
  assert.equal(malformed, null);
});

test('YouTube client appends and commits durable quota before each provider request', async () => {
  const ledger = createYouTubeQuotaLedger({ now: () => T, dailyBudgetUnits: 200, monthlyBudgetUnits: 300 });
  ledger.hydrate([]);
  const persisted = [];
  const client = createYouTubeClient({
    fetch: async () => response({ kind: 'youtube#searchListResponse', items: [] }),
    apiKey: 'fixture-key',
    enabled: true,
    accessApproved: true,
    dailyRemainingUnits: 200,
    monthlyRemainingUnits: 300,
    now: () => T,
    quotaAdmission: {
      reserve: ledger.reserve,
      append: async (event) => { persisted.push(event); return { ok: true }; },
      commit: ledger.commit,
    },
  });
  const out = await client.poll({ watchlist: SCOPE, nowMs: T });
  assert.equal(out.status, 'EMPTY');
  assert.equal(out.durableQuota.reservations, 1);
  assert.equal(persisted.length, 1);
  assert.equal(ledger.status().dailyUsedUnits, 100);

  const rejected = createYouTubeClient({
    fetch: async () => response({ kind: 'youtube#searchListResponse', items: [] }),
    apiKey: 'fixture-key',
    enabled: true,
    accessApproved: true,
    dailyRemainingUnits: 200,
    monthlyRemainingUnits: 300,
    now: () => T,
    quotaAdmission: { reserve: ledger.reserve, commit: ledger.commit },
  });
  assert.equal((await rejected.poll({ watchlist: SCOPE, nowMs: T })).error, 'DURABLE_QUOTA_ADMISSION_INVALID');
});