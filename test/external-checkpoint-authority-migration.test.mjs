// PUBLISH-FIX-8 — a zero-budget checkpoint born under DATA_ONLY (or under older provider code) that no longer validates
// under the current runtime is RE-COMMISSIONED at zero under the current authority, migrated once, never blocking the
// PAPER boot. The refusal it fixes: SENSE-CULL-3 shrank PROVIDER_IDS, so a durable market-quota row for a retired
// provider fails validation. A paid namespace (no birth state) keeps the strict fail-closed law. In-memory repo only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openExternalCheckpointStore, EXTERNAL_CHECKPOINT_RECORD_VERSION, EXTERNAL_CHECKPOINT_IDS } from '../persistence/external-checkpoint-store.js';
import { openDataOnlyCheckpoints } from '../tools/data-only-checkpoints.mjs';
import { MARKET_QUOTA_CHECKPOINT_VERSION, validateMarketQuotaCheckpoint, emptyMarketQuotaCheckpoint } from '../market-lab/external-quota-journal.js';
import { QUOTA_JOURNAL_VERSION } from '../market-lab/quota.js';

class FakeDb { constructor() { this.alive = true; } async acquireSessionLock() { return { held: () => this.alive, release: async () => { this.alive = false; } }; } }
class FakeRepo {
  constructor(rows = new Map()) { this.rows = rows; }
  async loadRuntimeState(id) { const r = this.rows.get(id); return r ? structuredClone(r) : null; }
  async saveRuntimeState(id, state, expected = null) {
    const cur = this.rows.get(id); const rev = cur ? cur.revision : 0;
    if (expected !== null && rev !== expected) return { conflict: true };
    const row = { revision: rev + 1, state: structuredClone(state) }; this.rows.set(id, row);
    return { ...structuredClone(row), conflict: false };
  }
}
const persist = (repo) => ({ db: new FakeDb(), repo, health: () => ({ databaseConfigured: true, restored: true }) });

// a durable market-quota record born under DATA_ONLY carrying a PLAN row for a provider SENSE-CULL-3 retired (DERIBIT):
// valid when it was written (16 providers), invalid now (12).
const RETIRED_ROW = { type: 'PLAN', providerId: 'DERIBIT', planDigest: 'a'.repeat(64), billing: 'FREE', remainingCalls: null, includedCallsPerMonth: null, verifiedDate: null, ts: 1000 };
const dataOnlyBornMarketRow = () => ({
  revision: 1,
  state: {
    v: EXTERNAL_CHECKPOINT_RECORD_VERSION, id: EXTERNAL_CHECKPOINT_IDS.MARKET,
    checkpoint: { version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: [RETIRED_ROW] },
    commissioning: { mode: 'EXPLICIT_COMMISSION', reason: 'BIRTH_ZERO_BUDGET DATA_ONLY gen1', ts: 1000 },
  },
});

test('PF8-1. store: an invalid DATA_ONLY-born zero-budget row is re-commissioned at zero under the current authority and migrated once', async () => {
  const repo = new FakeRepo(new Map([[EXTERNAL_CHECKPOINT_IDS.MARKET, dataOnlyBornMarketRow()]]));
  const store = await openExternalCheckpointStore({ persistence: persist(repo), log: () => {} });
  const binding = await store.restore({
    id: EXTERNAL_CHECKPOINT_IDS.MARKET, validate: validateMarketQuotaCheckpoint, loadLocal: () => null,
    commission: { allowCreate: true, state: emptyMarketQuotaCheckpoint(), reason: 'BIRTH_ZERO_BUDGET PAPER gen1', ts: 2000 },
  });
  assert.equal(binding.migrated(), true, 'this boot performed the authority migration');
  assert.deepEqual(binding.snapshot().rows, [], 're-commissioned at zero — the retired-provider row is dropped');
  assert.match(binding.commissioning().reason, /^AUTHORITY_MIGRATION BIRTH_ZERO_BUDGET PAPER gen1/);
  assert.equal(repo.rows.get(EXTERNAL_CHECKPOINT_IDS.MARKET).revision, 2, 'the durable row advanced exactly once (CAS)');
  await store.close();

  // a SECOND boot finds the now-valid zero row: it restores normally and does NOT migrate again (log once)
  const store2 = await openExternalCheckpointStore({ persistence: persist(repo), log: () => {} });
  const b2 = await store2.restore({ id: EXTERNAL_CHECKPOINT_IDS.MARKET, validate: validateMarketQuotaCheckpoint, loadLocal: () => null,
    commission: { allowCreate: true, state: emptyMarketQuotaCheckpoint(), reason: 'BIRTH_ZERO_BUDGET PAPER gen1', ts: 3000 } });
  assert.equal(b2.migrated(), false, 'the valid zero row is not re-migrated');
  assert.deepEqual(b2.snapshot().rows, []);
  assert.equal(repo.rows.get(EXTERNAL_CHECKPOINT_IDS.MARKET).revision, 2, 'no further durable write');
  await store2.close();
});

test('PF8-2. store: a PAID namespace (no birth state) with an invalid durable row keeps the strict fail-closed CHECKPOINT_INVALID', async () => {
  const id = 'external_quota:paid-thing:v1';
  const repo = new FakeRepo(new Map([[id, {
    revision: 1,
    state: { v: EXTERNAL_CHECKPOINT_RECORD_VERSION, id, checkpoint: { version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: [RETIRED_ROW] }, commissioning: { mode: 'EXPLICIT_COMMISSION', reason: 'explicit paid commission', ts: 1000 } },
  }]]));
  const store = await openExternalCheckpointStore({ persistence: persist(repo), log: () => {} });
  await assert.rejects(
    store.restore({ id, validate: validateMarketQuotaCheckpoint, loadLocal: () => null, commission: null }),
    /CHECKPOINT_INVALID/,
    'a paid namespace never re-commissions an invalid row: it fails closed',
  );
  await store.close();
});

test('PF8-3. end to end: the PAPER boot accepts a DATA_ONLY-born invalid market checkpoint, logs the migration, and blocks nothing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pf8e2e-'));
  try {
    const repo = new FakeRepo(new Map([[EXTERNAL_CHECKPOINT_IDS.MARKET, dataOnlyBornMarketRow()]]));
    const logs = [];
    const checkpoints = await openDataOnlyCheckpoints({ persistence: persist(repo), dataDir: dir, env: { SERPENT_DATA_GENERATION: 'gen1' }, clock: () => 5000, log: (m) => logs.push(String(m)) });
    assert.deepEqual(checkpoints.blockers, {}, 'the PAPER boot is not blocked by the DATA_ONLY-born market checkpoint');
    assert.ok(checkpoints.market, 'the market quota journal is live');
    assert.equal(logs.filter((l) => /MARKET quota authority migrated to PAPER gen1 \(zero budget\)/.test(l)).length, 1, 'the authority migration is logged exactly once');
    await checkpoints.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
