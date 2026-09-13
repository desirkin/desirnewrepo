import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXUsage } from '../rumor2/providers/x-official.js';
import { xMeterEvent, validateXMeterEvent } from '../rumor2/social-settle.js';

const T = Date.parse('2026-09-13T12:00:00.000Z');
const PROJECT_ID = '2098817204913401858';

const zeroBody = (over = {}) => ({
  data: {
    cap_reset_day: 12,
    daily_project_usage: { project_id: PROJECT_ID },
    project_cap: '3000000',
    project_id: PROJECT_ID,
    project_usage: '0',
    ...over,
  },
});

test('explicit aggregate project zero with matching identities proves a closed daily zero upper bound', () => {
  const expected = {
    projectUsage: 0,
    projectCap: 3_000_000,
    capResetDay: 12,
    dailyProjectUsage: 0,
    observedTs: T,
    dailyUsageBasis: 'PROJECT_TOTAL_ZERO_UPPER_BOUND',
  };
  assert.deepEqual(parseXUsage(zeroBody(), { observedTs: T }), expected);
  assert.deepEqual(parseXUsage(zeroBody({ project_usage: 0, project_cap: 3_000_000 }), { observedTs: T }), expected);
});

test('aggregate-zero fallback refuses every ambiguous identity, total, cap, reset, error, or daily shape', () => {
  const cases = [
    zeroBody({ project_usage: '1' }),
    zeroBody({ project_usage: 1 }),
    zeroBody({ project_usage: undefined }),
    zeroBody({ project_usage: '00' }),
    zeroBody({ project_usage: -0 }),
    zeroBody({ project_cap: '0' }),
    zeroBody({ project_cap: 'not-a-count' }),
    zeroBody({ cap_reset_day: 0 }),
    zeroBody({ cap_reset_day: 32 }),
    zeroBody({ cap_reset_day: undefined }),
    zeroBody({ project_id: undefined }),
    zeroBody({ project_id: 'other' }),
    zeroBody({ project_id: '12345678901234567890', daily_project_usage: { project_id: '12345678901234567890' } }),
    zeroBody({ daily_project_usage: { project_id: '2098817204913401859' } }),
    zeroBody({ daily_project_usage: {} }),
    zeroBody({ daily_project_usage: [] }),
    zeroBody({ daily_project_usage: { project_id: PROJECT_ID, usage: [] } }),
    zeroBody({ daily_project_usage: { project_id: PROJECT_ID, usage: undefined } }),
    zeroBody({ daily_project_usage: { project_id: PROJECT_ID, unexpected: true } }),
    { errors: [], ...zeroBody() },
    zeroBody({ errors: [] }),
  ];
  for (const body of cases) assert.equal(parseXUsage(body, { observedTs: T }), null);
  assert.equal(parseXUsage(zeroBody(), { observedTs: 0 }), null);
  assert.equal(parseXUsage(zeroBody(), { observedTs: T + 0.5 }), null);
});

test('a documented current-day daily row remains the legacy five-field snapshot, including explicit zero', () => {
  const body = zeroBody({
    daily_project_usage: {
      project_id: PROJECT_ID,
      usage: [{ date: '2026-09-13T12:00:00.000Z', usage: '0' }],
    },
  });
  assert.deepEqual(parseXUsage(body, { observedTs: T }), {
    projectUsage: 0,
    projectCap: 3_000_000,
    capResetDay: 12,
    dailyProjectUsage: 0,
    observedTs: T,
  });
});

test('meter validation preserves legacy snapshots and closes the derived-zero provenance shape', () => {
  const legacy = { projectUsage: 2, projectCap: 3_000_000, capResetDay: 12, dailyProjectUsage: 1, observedTs: T };
  const derived = parseXUsage(zeroBody(), { observedTs: T });
  const event = (serverUsage) => xMeterEvent({
    provider: 'X_OFFICIAL', period: '2026-09-13', deliveredPostReads: 1,
    monthPeriod: '2026-09', monthDeliveredPostReads: 1,
    unitPriceUsd: 0.005, serverUsage, knownAtTs: T,
  });
  assert.equal(validateXMeterEvent(event(legacy)), null);
  assert.equal(validateXMeterEvent(event(derived)), null);
  for (const invalid of [
    { ...derived, dailyUsageBasis: 'INFERRED_ZERO' },
    { ...derived, projectUsage: 1 },
    { ...derived, projectCap: 0 },
    { ...derived, capResetDay: null },
    { ...derived, dailyProjectUsage: 1 },
    { ...derived, extra: true },
    { ...legacy, dailyUsageBasis: undefined },
  ]) assert.match(validateXMeterEvent(event(invalid)), /serverUsage invalid/);
});
