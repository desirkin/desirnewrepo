// PUBLISH-FIX-1 — data-dir generation + the one-shot legacy purge. A Replit republish does not wipe the VM disk, so the
// runtime writes under <COBRA_DATA_DIR>/<generation> for a clean crib, and an operator-gated purge clears the old flat data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dataDir, dataDirBase, dataGeneration, purgeLegacyData } from '../lib/config.js';

// each test owns the env it sets and restores it, since env is process-global
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'serpent-gen-'));

test('DG-1. an unset/empty generation keeps the flat legacy layout; a set generation nests the runtime under it; a malformed value fails closed', () => {
  const base = tmp();
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: undefined }, () => {
    assert.equal(dataGeneration(), '');
    assert.equal(dataDir(), path.resolve(base), 'no generation => flat base (every test\'s layout)');
    assert.equal(dataDirBase(), path.resolve(base));
  });
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: '' }, () => assert.equal(dataDir(), path.resolve(base), 'empty string is also flat'));
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: 'gen1' }, () => {
    assert.equal(dataGeneration(), 'gen1');
    assert.equal(dataDir(), path.join(path.resolve(base), 'gen1'));
    assert.equal(dataDirBase(), path.resolve(base), 'the base excludes the generation (the purge scans it)');
  });
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: 'gen2' }, () => assert.equal(dataDir(), path.join(path.resolve(base), 'gen2')));
  for (const bad of ['../evil', 'a/b', '.', '', ' ', 'x'.repeat(65)]) {
    if (bad === '' || bad === ' ') continue; // empty/blank are flat, not malformed
    withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: bad }, () => assert.throws(() => dataGeneration(), /safe directory name/, `malformed ${JSON.stringify(bad)} fails closed`));
  }
  rmSync(base, { recursive: true, force: true });
});

test('DG-2. the legacy purge (SERPENT_PURGE_LEGACY_DATA=1) deletes every non-generation top-level entry with byte counts, never touches the current generation, and is a no-op without the env or a generation', () => {
  const base = tmp();
  // plant the current generation (must survive) and legacy flat data (must be purged)
  mkdirSync(path.join(base, 'gen1', 'tape'), { recursive: true }); writeFileSync(path.join(base, 'gen1', 'tape', 'keep.jsonl'), 'keep');
  mkdirSync(path.join(base, 'serpent'), { recursive: true }); writeFileSync(path.join(base, 'serpent', 'runtime.lock'), '{"pid":1}');
  writeFileSync(path.join(base, 'stale.jsonl'), 'abcde');
  mkdirSync(path.join(base, 'broad-kraken'), { recursive: true }); writeFileSync(path.join(base, 'broad-kraken', 'writer.lock'), 'x');

  // no env -> no-op
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: 'gen1', SERPENT_PURGE_LEGACY_DATA: undefined }, () => {
    assert.deepEqual(purgeLegacyData(), { purged: false, removed: [], totalBytes: 0 });
    assert.ok(existsSync(path.join(base, 'serpent', 'runtime.lock')), 'nothing removed without the env');
  });
  // env set but NO generation -> refuses (a flat layout has nothing to protect)
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: undefined, SERPENT_PURGE_LEGACY_DATA: '1' }, () => {
    const logs = []; const r = purgeLegacyData({ log: (m) => logs.push(String(m)) });
    assert.equal(r.purged, false); assert.ok(logs.some((m) => /no SERPENT_DATA_GENERATION set/.test(m)));
    assert.ok(existsSync(path.join(base, 'serpent', 'runtime.lock')), 'without a generation nothing is purged');
  });
  // env + generation -> purge the flat data, keep gen1, logged with byte counts
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: 'gen1', SERPENT_PURGE_LEGACY_DATA: '1' }, () => {
    const logs = []; const r = purgeLegacyData({ log: (m) => logs.push(String(m)) });
    assert.equal(r.purged, true);
    assert.deepEqual(new Set(r.removed.map((e) => e.name)), new Set(['serpent', 'stale.jsonl', 'broad-kraken']));
    assert.equal(r.removed.find((e) => e.name === 'stale.jsonl').bytes, 5, 'byte counts are reported');
    assert.ok(r.totalBytes > 0);
    assert.ok(logs.some((m) => /legacy purge: removed stale\.jsonl \(5 bytes\)/.test(m)));
    assert.ok(logs.some((m) => /generation gen1 preserved/.test(m)));
    // the current generation survives; the legacy entries are gone
    assert.ok(existsSync(path.join(base, 'gen1', 'tape', 'keep.jsonl')), 'the current generation is never touched');
    assert.ok(!existsSync(path.join(base, 'serpent')));
    assert.ok(!existsSync(path.join(base, 'stale.jsonl')));
    assert.ok(!existsSync(path.join(base, 'broad-kraken')));
  });
  // a malformed generation refuses rather than purging against a bad name
  withEnv({ COBRA_DATA_DIR: base, SERPENT_DATA_GENERATION: '../evil', SERPENT_PURGE_LEGACY_DATA: '1' }, () => {
    const logs = []; assert.equal(purgeLegacyData({ log: (m) => logs.push(String(m)) }).purged, false);
    assert.ok(logs.some((m) => /legacy purge refused/.test(m)));
  });
  rmSync(base, { recursive: true, force: true });
});
