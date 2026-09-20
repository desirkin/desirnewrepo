// PUBLISH-FIX-83 — the gate study's ledger byte cap is a TAIL: a ledger past the cap yields its newest rows, not its oldest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJsonlStream } from '../learning/gate-lesson.js';

test('FIX83-GL. readJsonlStream with a cap smaller than the file returns the newest rows and drops the cut line', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-gate-tail-'));
  try {
    const file = path.join(dir, 'l.jsonl'); const rows = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(50) }));
    writeFileSync(file, rows.join('\n') + '\n');
    const all = await readJsonlStream(file, () => true); assert.equal(all.length, 100);
    const tail = await readJsonlStream(file, () => true, { maxBytes: 700 });
    assert.ok(tail.length >= 9 && tail.length <= 11, `about the last 10 rows: ${tail.length}`); assert.equal(tail.at(-1).i, 99, 'the newest row is present'); assert.ok(tail[0].i >= 89, 'the oldest rows are the ones left out');
    assert.ok(tail.every((r, k) => k === 0 || r.i === tail[k - 1].i + 1), 'contiguous, no torn row');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
