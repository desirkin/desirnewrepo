// PUBLISH-FIX-83 — review finding: memory/events.jsonl and its id index grew without bound and every boot re-validated the whole
// file synchronously. Law now: the live segment rotates WHOLE into memory/archive/ at MEMORY_ROTATE_BYTES (never deleted), the id
// index restarts with the segment, boot recovery scans the live segment only, lifetime counters stay cumulative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-memory-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const { envelope } = await import('../memory/schema.js');
const { MemoryStore, MEMORY_ROTATE_BYTES } = await import('../memory/store.js');
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 8, 19, 12); const NOW_SEC = Math.floor(NOW / 1000); const ISO = new Date(NOW).toISOString();
const mkEnv = (i) => envelope({ sourceModule: 'WIDEEYE', eventType: 'WIDEEYE_RIPPLE', ts: NOW_SEC - 600 + i, symbol: 'BTC', families: ['MARKET_PRICE', 'MARKET_VOLUME'], observationState: 'KNOWN', payload: { zVol: 4.2, zRet: 2.5, extensionPct: 1.1, i }, dataAvailability: { zVol: 'KNOWN', zRet: 'KNOWN' }, provenance: { source: 'fixture', sourceTs: NOW_SEC - 600 + i, availableTs: NOW_SEC - 600 + i, retrievedTs: ISO, kind: 'live', form: 'raw' } });

test('FIX83-M6. the live segment rotates whole into archive/ at the bound; the index restarts; a restart recovers only the live segment; nothing is deleted', () => {
  const dir = path.join(TEST_DATA, 'rot'); const logs = [];
  const store = new MemoryStore({ dir, log: (m) => logs.push(String(m)), now: () => NOW }); store.rotateBytes = 2_000; // the law under test, at a test-sized bound
  assert.equal(MEMORY_ROTATE_BYTES, 128 * 1024 * 1024);
  let accepted = 0; for (let i = 0; i < 40; i += 1) if (store.append(mkEnv(i)).accepted) accepted += 1;
  assert.equal(accepted, 40);
  const archive = readdirSync(path.join(dir, 'archive')); assert.ok(archive.length >= 1, 'at least one rotation'); assert.ok(archive.every((f) => /^events\.2026-09-19T12-00-00-000Z\.jsonl$/.test(f) || /^events\..*\.jsonl$/.test(f)));
  const archivedLines = archive.reduce((n, f) => n + readFileSync(path.join(dir, 'archive', f), 'utf8').split('\n').filter(Boolean).length, 0);
  const liveLines = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(archivedLines + liveLines, 40, 'every accepted record is on disk: archived + live');
  assert.ok(statSync(path.join(dir, 'events.jsonl')).size < 2_000 + 600, 'the live segment is bounded');
  assert.equal(store.manifest().rotations, archive.length); assert.equal(store.manifest().recordCount, 40, 'lifetime count');
  assert.ok(store.ids.size < 40, 'the index covers the live segment only'); assert.ok(logs.some((l) => /MEMORY rotated/.test(l)));
  assert.equal(store.append(mkEnv(39)).accepted, false, 'a live-segment duplicate is still refused');
  store.flush();
  const again = new MemoryStore({ dir, log: () => {}, now: () => NOW });
  assert.equal(again.ids.size, liveLines, 'boot recovery indexes the live segment only'); assert.equal(again.manifest().rotations, archive.length, 'lifetime rotations preserved');
  assert.equal(again.liveBytes, statSync(path.join(dir, 'events.jsonl')).size);
  again.flush();
});
