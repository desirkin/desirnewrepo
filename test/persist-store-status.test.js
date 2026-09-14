import test from 'node:test';
import assert from 'node:assert/strict';
import { dataOnlyPublicStatus, dataOnlySensorSnapshot } from '../lib/data-only-status.js';

function evaluated(persistence) {
  return { effectiveRunning: true, healthState: 'ACTIVE', statusReason: null, lifecycle: 'ACTIVE',
    status: { collectors: { persistence } } };
}
test('restored core with a WIPED store is visibly DEGRADED, never an ACTIVE durable sensor', () => {
  const snapshot = dataOnlySensorSnapshot(evaluated({ status: 'DEGRADED', restored: true, databaseConfigured: true,
    permissionLock: true, storeIntegrityLock: true, failureCategory: 'STORE_ANCHOR_WIPED',
    storeGuard: { status: 'DEGRADED', coverage: 'COMMISSIONED_SNAPSHOTS_ONLY', checked: 1, failed: 1, permissionLock: true,
      stores: [{ storeId: 'study:test', status: 'WIPED', reason: 'ANCHORED_CACHE_MISSING' }] } }));
  const row = snapshot.rows.find((r) => r.id === 'PERSISTENCE');
  assert.equal(row.state, 'DEGRADED'); assert.equal(row.blocker, 'STORE_ANCHOR_WIPED');
  assert.equal(snapshot.persistence.permissionLock, true);
  assert.equal(snapshot.persistence.storeGuard.stores[0].storeId, 'study:test');
  assert.equal(snapshot.dataOnly.running, true, 'collection liveness is not rewritten as stopped');
});

test('uncommissioned coverage remains explicit and status projection never includes archived payloads or paths', () => {
  const status = dataOnlyPublicStatus(evaluated({ status: 'HEALTHY', restored: true, databaseConfigured: true, permissionLock: false,
    storeGuard: { status: 'UNCOMMISSIONED', coverage: 'COMMISSIONED_SNAPSHOTS_ONLY', checked: 0, failed: 0, permissionLock: false,
      payload: 'PRIVATE_ARCHIVED_BYTES', path: '/secret/path', stores: [] } }));
  assert.equal(status.persistence.storeGuard.status, 'UNCOMMISSIONED');
  assert.equal(status.persistence.storeGuard.checked, 0);
  assert.equal(JSON.stringify(status).includes('PRIVATE_ARCHIVED_BYTES'), false);
  assert.equal(JSON.stringify(status).includes('/secret/path'), false);
});

test('unknown/degraded database state never becomes ACTIVE solely from restored=true', () => {
  for (const status of [undefined, 'DEGRADED', 'UNAVAILABLE']) {
    const snapshot = dataOnlySensorSnapshot(evaluated({ status, restored: true, databaseConfigured: true }));
    assert.equal(snapshot.rows.find((r) => r.id === 'PERSISTENCE').state, 'DEGRADED');
  }
});
