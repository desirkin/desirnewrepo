import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sensorSnapshot, snapshotRow, FRESH_MS } from '../paper/readiness.js';
import { loadProfile, profileEnvironment } from '../paper/profile.js';

const now = Date.parse('2026-09-12T15:00:00Z');
test('social snapshot requires recent observations and collector publication, not a saved ACTIVE label or keepalive', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'social-status-'));
  const profile = loadProfile();
  const env = { ...profileEnvironment(profile), X_BEARER_TOKEN: 'fixture-token', RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '10', RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS: '100', RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD: '1' };
  const ids = ['BLUESKY_OFFICIAL', 'X_OFFICIAL'];
  mkdirSync(path.join(dir, 'rumor2'));
  const check = (statusTs, observationTs, expected, connected = true) => {
    writeFileSync(path.join(dir, 'rumor2/status.json'), JSON.stringify({ tsMs: statusTs,
      social: { state: 'ACTIVE', stream: { connected, lastEventTs: observationTs, lastMessageTs: now } },
      socialX: { state: 'ACTIVE', stream: { connected, lastPostTs: observationTs, lastKeepaliveTs: now }, lastReceiptTs: now },
    }));
    const snap = sensorSnapshot({ profile, env, dataDir: dir, now });
    for (const id of ids) {
      const row = snapshotRow(snap, id);
      assert.equal(row.state, expected, `${id}: status ${statusTs}, observation ${observationTs}`);
      assert.equal(row.lastSuccessTs, observationTs);
      assert.equal(row.authority, 'NONE');
      if (expected !== 'ACTIVE') assert.ok(row.blocker);
    }
  };
  try {
    check(now, now - 1000, 'ACTIVE');
    check(now, now - FRESH_MS.rumor2 - 1, 'ACTIVE_DEGRADED');
    check(now - FRESH_MS.rumor2 - 1, now, 'ACTIVE_DEGRADED');
    check(now, now, 'ACTIVE_DEGRADED', false);
    check(now, null, 'NOT_OBSERVED');
    check(null, now, 'NOT_OBSERVED');
    check(now, now + 1, 'NOT_OBSERVED');
    check(now + 1, now, 'NOT_OBSERVED');
    const blocked = sensorSnapshot({ profile, env: { ...env, X_BEARER_TOKEN: '' }, dataDir: dir, now });
    assert.equal(snapshotRow(blocked, 'X_OFFICIAL').state, 'BLOCKED_CREDENTIAL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
