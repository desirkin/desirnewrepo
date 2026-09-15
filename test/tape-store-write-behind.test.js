// I/O LANE (Ticket B) — the tape store's opt-in write-behind. Default OFF is today's synchronous write; ON enqueues and a
// flush / stop persists. No network. Each test isolates its own data dir + env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('TWB-1. default OFF: writeTrade writes synchronously (unchanged behavior)', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'twb-off-')); process.env.COBRA_DATA_DIR = d; delete process.env.SERPENT_TAPE_WRITE_BEHIND;
  const { writeTrade } = await import('../tape/store.js');
  const { sessionDate } = await import('../lib/time.js');
  try {
    writeTrade({ p: 100, q: 1 });
    const f = path.join(d, 'tape', sessionDate(), 'trades.jsonl');
    assert.ok(existsSync(f), 'synchronous write lands immediately when write-behind is off');
    assert.match(readFileSync(f, 'utf8'), /"p":100/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('TWB-2. ON: writeTrade/writeSnapshot enqueue (nothing on disk yet); flushTapeWrites persists; stopTapeWrites drains and falls back after', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'twb-on-')); process.env.COBRA_DATA_DIR = d; process.env.SERPENT_TAPE_WRITE_BEHIND = 'true';
  const store = await import('../tape/store.js');
  const { sessionDate } = await import('../lib/time.js');
  try {
    const trades = path.join(d, 'tape', sessionDate(), 'trades.jsonl');
    store.writeTrade({ p: 1 }); store.writeTrade({ p: 2 });
    assert.ok(!existsSync(trades), 'the bite lane enqueued; nothing hit the disk yet');
    assert.ok(store.tapeWriteBehindStatus().queuedAppendLines >= 2);
    store.flushTapeWrites();
    assert.equal(readFileSync(trades, 'utf8'), '{"p":1}\n{"p":2}\n');
    store.writeTrade({ p: 3 }); store.stopTapeWrites();
    assert.match(readFileSync(trades, 'utf8'), /"p":3/, 'stop drained the buffer');
    store.writeTrade({ p: 4 }); // after stop -> direct fallback (no lost data)
    assert.match(readFileSync(trades, 'utf8'), /"p":4/);
  } finally { rmSync(d, { recursive: true, force: true }); delete process.env.SERPENT_TAPE_WRITE_BEHIND; }
});
