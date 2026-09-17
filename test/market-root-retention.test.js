// PUBLISH-FIX-22 (2026-09-17): the research root is bounded by ROTATION, not by refusing to research. Production boot
// aac10add: root at the 4 GiB quota, both research owners dark ("research root quota exhausted"). Under retention policy
// ROTATE_OLDEST_CAPTURES the oldest prior capture runs are removed until one run bound of headroom exists; sealed cases,
// accounting and the run about to open are never touched; restore-on-boot leaves prior capture runs in the bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rotateCaptureRuns, listCaptureRuns } from '../market-lab/root-retention.js';
import { QUOTA_EXHAUSTED_POLICIES, loadPolicy } from '../market-lab/policy.js';
import { restoreObjectStoreOnBoot, DEFAULT_RESTORE_SKIP_PREFIXES } from '../persistence/object-restore.js';
import { openObjectStore } from '../persistence/object-store.js';
import { createObjectUploader } from '../persistence/object-uploader.js';
import { readFileSync } from 'node:fs';

const KB = 1024;
function root() { return mkdtempSync(path.join(tmpdir(), 'serpent-root-retention-')); }
function run(r, name, bytes) { const d = path.join(r, 'captures', name); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'observations.jsonl'), Buffer.alloc(bytes, 0x41)); return d; }

test('rotation removes the OLDEST prior capture runs until one run bound of headroom exists; cases, accounting and the opening run survive', () => {
  const r = root();
  try {
    run(r, 'cap-1789500000000', 30 * KB); run(r, 'data-only-1789600000000-33-1', 30 * KB); run(r, 'cap-1789700000000', 30 * KB);
    mkdirSync(path.join(r, 'cases', 'case-a'), { recursive: true }); writeFileSync(path.join(r, 'cases', 'case-a', 'manifest.json'), Buffer.alloc(10 * KB, 0x7b));
    mkdirSync(path.join(r, 'accounting'), { recursive: true }); writeFileSync(path.join(r, 'accounting', 'quota.jsonl'), Buffer.alloc(5 * KB, 0x7b));
    const opening = path.join(r, 'captures', 'cap-1789800000000');
    assert.deepEqual(listCaptureRuns(r).map((x) => x.name), ['cap-1789500000000', 'data-only-1789600000000-33-1', 'cap-1789700000000'], 'oldest first by the timestamp in the name');
    const lines = []; const s = rotateCaptureRuns({ root: r, quotaBytes: 100 * KB, reserveBytes: 40 * KB, keep: [opening], log: (l) => lines.push(l) });
    assert.equal(s.state, 'ROTATED'); assert.deepEqual(s.removed.map((x) => x.name), ['cap-1789500000000', 'data-only-1789600000000-33-1'], 'two oldest runs make the room (105 KB -> 45 KB + 40 KB reserve <= 100 KB)');
    assert.ok(!existsSync(path.join(r, 'captures', 'cap-1789500000000'))); assert.ok(existsSync(path.join(r, 'captures', 'cap-1789700000000')));
    assert.ok(existsSync(path.join(r, 'cases', 'case-a', 'manifest.json')) && existsSync(path.join(r, 'accounting', 'quota.jsonl')), 'evidence and journals are never rotated');
    assert.ok(lines.some((l) => /MARKET RESEARCH retention ROTATED: 2 prior capture run\(s\) rotated/.test(l)), lines.join('\n'));
    const again = rotateCaptureRuns({ root: r, quotaBytes: 100 * KB, reserveBytes: 40 * KB, keep: [opening], log: () => {} }); assert.equal(again.state, 'WITHIN_QUOTA'); assert.equal(again.removed.length, 0);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('a root that stays exhausted after every prior run is gone reports STILL_EXHAUSTED (the quota law then refuses honestly); the opening run is kept', () => {
  const r = root();
  try {
    const opening = run(r, 'cap-1789900000000', 50 * KB); run(r, 'cap-1789800000000', 10 * KB);
    mkdirSync(path.join(r, 'cases', 'c'), { recursive: true }); writeFileSync(path.join(r, 'cases', 'c', 'report.md'), Buffer.alloc(80 * KB, 0x23));
    const s = rotateCaptureRuns({ root: r, quotaBytes: 100 * KB, reserveBytes: 10 * KB, keep: [opening], log: () => {} });
    assert.equal(s.state, 'STILL_EXHAUSTED'); assert.deepEqual(s.removed.map((x) => x.name), ['cap-1789800000000']); assert.ok(existsSync(opening));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test('the paper research policy declares ROTATE_OLDEST_CAPTURES with a 512 MiB run bound under the 4 GiB root quota', () => {
  assert.ok(QUOTA_EXHAUSTED_POLICIES.includes('ROTATE_OLDEST_CAPTURES'));
  const p = loadPolicy(JSON.parse(readFileSync(new URL('../config/market-research.paper.json', import.meta.url), 'utf8')));
  assert.equal(p.retention.onQuotaExhausted, 'ROTATE_OLDEST_CAPTURES'); assert.equal(p.resources.runBytes, 512 * 1024 * 1024); assert.equal(p.resources.researchRootQuotaBytes, 4 * 1024 * 1024 * 1024);
});

test('restore-on-boot leaves prior market-research capture runs in the bucket (durable, not on disk) and restores cases as before', async () => {
  const bucket = mkdtempSync(path.join(tmpdir(), 'serpent-bucket-')); const data = mkdtempSync(path.join(tmpdir(), 'serpent-data-')); const fresh = mkdtempSync(path.join(tmpdir(), 'serpent-fresh-'));
  try {
    mkdirSync(path.join(data, 'market-research', 'captures', 'cap-1789500000000'), { recursive: true }); writeFileSync(path.join(data, 'market-research', 'captures', 'cap-1789500000000', 'observations.jsonl'), 'a\n');
    mkdirSync(path.join(data, 'market-research', 'cases', 'case-1'), { recursive: true }); writeFileSync(path.join(data, 'market-research', 'cases', 'case-1', 'manifest.json'), '{}\n');
    const env = { SERPENT_OBJECT_STORE_PROVIDER: 'FILESYSTEM', SERPENT_OBJECT_STORE_DIR: bucket };
    const store = await openObjectStore({ env, log: () => {} }); assert.equal(store.state, 'ACTIVE');
    const up = createObjectUploader({ store, dataRoot: data, log: () => {} }); await up.syncOnce();
    const lines = []; const s = await restoreObjectStoreOnBoot({ store, dataRoot: fresh, log: (l) => lines.push(l) });
    assert.equal(s.state, 'OK'); assert.equal(s.skipped, 1); assert.equal(s.restored, 1); assert.deepEqual([...DEFAULT_RESTORE_SKIP_PREFIXES], ['market-research/captures/']);
    assert.ok(existsSync(path.join(fresh, 'market-research', 'cases', 'case-1', 'manifest.json')), 'cases restore');
    assert.ok(!existsSync(path.join(fresh, 'market-research', 'captures')), 'prior capture runs stay in the bucket');
    assert.ok(lines.some((l) => /1 prior capture files \(0 MB\) left in the bucket, not restored \(market-research\/captures\/\)/.test(l)), lines.join('\n'));
  } finally { for (const d of [bucket, data, fresh]) rmSync(d, { recursive: true, force: true }); }
});
