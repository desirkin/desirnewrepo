// PUBLISH-FIX-83 — full review item 29: in PAPER the market catalogs' venue WebSocket streams are OFF unless set by hand; the REST
// catalog families and the broad Kraken writer are composed exactly as before. Every starter is a local double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPaperCollectorAdditions } from '../lib/collectors.js';

test('FIX83-29. startPaperCollectorAdditions starts the market catalogs with SERPENT_MARKET_STREAM_SUBJECTS=0 when the env does not set it, passes a hand-set value through untouched, and logs the choice once', async () => {
  const seen = []; const logs = [];
  const starters = { startDataOnlyMarket: async ({ env }) => { seen.push(env.SERPENT_MARKET_STREAM_SUBJECTS); return { stop: async () => {} }; }, startBroadKraken: async () => { throw new Error('BROAD_NOT_UNDER_TEST'); } };
  const run = (env) => startPaperCollectorAdditions({ root: '/tmp/fix83-collectors', env, governor: null, checkpoints: { market: {} }, blockers: {}, handles: [], log: (m) => logs.push(String(m)), phase: () => {}, catalogAccessor: null, starters });
  await run({}); await run({ SERPENT_MARKET_STREAM_SUBJECTS: '' }); await run({ SERPENT_MARKET_STREAM_SUBJECTS: '3' });
  assert.deepEqual(seen, ['0', '0', '3']);
  assert.equal(logs.filter((l) => l.includes('venue streams OFF in PAPER')).length, 2);
});

test('FIX83-ROT. appendJsonlRotating moves a full stream whole into archive/ (unique name, nothing deleted) and the mirror tail restarts cleanly', async () => {
  const { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const path = (await import('node:path')).default;
  const { appendJsonlRotating, rotateJsonlIfLarge } = await import('../lib/jsonl.js'); const { Tail } = await import('../memory/mirror.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-rot-')); const file = path.join(dir, 'events.jsonl');
  try {
    const rotated = []; const tail = new Tail(file, { fromStart: true }); let seen = 0;
    for (let i = 0; i < 50; i += 1) { appendJsonlRotating(file, { i, pad: 'x'.repeat(40) }, { maxBytes: 500, onRotate: (t) => rotated.push(t) }); if (i % 7 === 0) seen += tail.readNew().records.length; }
    seen += tail.readNew().records.length;
    assert.ok(rotated.length >= 4, `rotations happened: ${rotated.length}`); assert.equal(new Set(rotated).size, rotated.length, 'unique archive names');
    const archived = readdirSync(path.join(dir, 'archive')).reduce((n, f) => n + readFileSync(path.join(dir, 'archive', f), 'utf8').split('\n').filter(Boolean).length, 0);
    const live = readFileSync(file, 'utf8').split('\n').filter(Boolean).length; assert.equal(archived + live, 50, 'every line is on disk'); assert.ok(statSync(file).size < 500 + 80);
    assert.equal(seen, 50, 'the mirror tail saw every record across rotations, none glued or lost');
    assert.equal(rotateJsonlIfLarge(path.join(dir, 'missing.jsonl')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
