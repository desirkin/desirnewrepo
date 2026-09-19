// PUBLISH-FIX-78: the mover backfill replays archived broad-Kraken segments through the mover study (same law, virtual clock),
// writes under its own root, the move-clock lesson reads live + backfill records (live wins on the same climb), and the child
// process returns the same result the in-process run does.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runMoverBackfill, selectSegments, backfillStudyDir, MOVER_BACKFILL_VERSION } from '../learning/mover-backfill.js';
import { spawnMoverBackfill } from '../tools/mover-backfill-process.js';
import { createMoveClockLesson } from '../learning/move-clock-lesson.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 16, 0, 0, 0);
const rec = (coin, openTs, px, v = 100) => JSON.stringify({ recordType: 'OHLC', quality: 'CONSERVATIVE_CLOSED', market: { canonicalCoin: coin }, periodStartTs: openTs, periodEndTs: openTs + MIN, receivedTs: openTs + MIN + 500, payload: { open: px, high: px * 1.001, low: px * 0.999, close: px, volumeBase: v } });
// one coin climbs 12% over an hour after 130 flat minutes, then fades; the others stay flat. Records are interleaved by minute
// across coins (the segment order of the live collector) and split across two segment files.
function writeArchive(dir, { mover = 'PEPE', flat = ['AAA', 'BBB', 'CCC'], minutes = 260 } = {}) {
  mkdirSync(path.join(dir, 'broad-kraken'), { recursive: true });
  const lines = [];
  for (let m = 0; m < minutes; m += 1) {
    const ts = T0 + m * MIN;
    let px = 100 + Math.sin(m) * 0.2; let v = 100;
    if (m >= 130 && m < 190) { px = 100 + 12 * ((m - 129) / 60); v = 300; } else if (m >= 190) { px = 112 - (m - 189) * 0.05; }
    lines.push(rec(mover, ts, px, v));
    for (const c of flat) lines.push(rec(c, ts, 50 + Math.cos(m + c.length) * 0.05));
    lines.push(JSON.stringify({ recordType: 'BOOK', market: { canonicalCoin: mover }, ts })); // a non-candle line is skipped without a parse
  }
  const half = Math.floor(lines.length / 2);
  writeFileSync(path.join(dir, 'broad-kraken', 'events-000001.jsonl'), `${lines.slice(0, half).join('\n')}\n`);
  writeFileSync(path.join(dir, 'broad-kraken', 'events-000002.jsonl'), `${lines.slice(half).join('\n')}\ntorn{`);
  writeFileSync(path.join(dir, 'broad-kraken', 'events-000003.jsonl'), '');
  writeFileSync(path.join(dir, 'broad-kraken', 'writer.lock'), 'x');
  return lines.length;
}

test('MB-01. selectSegments: numbered, non-empty, oldest first, newest kept within the byte budget', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mb-'));
  try {
    writeArchive(dir);
    const all = selectSegments(path.join(dir, 'broad-kraken'));
    assert.deepEqual(all.map((s) => s.name), ['events-000001.jsonl', 'events-000002.jsonl'], 'the empty third segment and the lock are not segments');
    const one = selectSegments(path.join(dir, 'broad-kraken'), { maxSegments: 1 }); assert.deepEqual(one.map((s) => s.name), ['events-000002.jsonl'], 'the newest wins a tight budget');
    assert.deepEqual(selectSegments(path.join(dir, 'nowhere')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MB-02. runMoverBackfill replays the archive through the mover study with a virtual clock: the climb is one MOVER record with a move clock under the backfill root, the live study files are untouched, and a re-run rebuilds from scratch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mb-'));
  try {
    const n = writeArchive(dir); const logs = [];
    const r = await runMoverBackfill({ dataDir: dir, log: (m) => logs.push(m), studyOptions: { controlsPerMover: 2 } });
    assert.equal(r.version, MOVER_BACKFILL_VERSION); assert.equal(r.segments, 2); assert.equal(r.lines, n + 1, 'every line read, the torn one included');
    assert.equal(r.candles, 260 * 4, 'only closed candles reach the study'); assert.equal(r.ticks, 260, 'one tick per minute of the stream');
    assert.equal(r.movers, 1, 'the 12% climb'); assert.equal(r.controls, 2); assert.deepEqual(r.days, ['2026-09-16']); assert.equal(r.coins, 4);
    assert.equal(r.firstTs, T0); assert.equal(r.lastTs, T0 + 259 * MIN);
    const f = path.join(backfillStudyDir(dir), '2026-09-16.jsonl'); assert.ok(existsSync(f), 'written under the backfill root');
    const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const mover = rows.find((x) => x.kind === 'MOVER'); assert.equal(mover.coin, 'PEPE'); assert.ok(mover.climbPct >= 10);
    assert.ok(mover.moveClock && mover.moveClock.minutesLowToPeak > 0, 'the move clock rides along (pictureAt)');
    assert.equal(rows.filter((x) => x.kind === 'CONTROL').length, 2);
    assert.ok(!existsSync(path.join(dir, 'learning', 'mover-study')), 'the live study directory is never written');
    assert.equal(r.pinned, 2, 'both segments were pinned with hard links'); assert.ok(!existsSync(path.join(dir, 'mover-backfill', 'segments')), 'the links are removed afterwards');
    assert.match(logs.at(-1), /MOVER BACKFILL: 1 climbs >=10%\/hour \(with 2 controls\) replayed from 2 archived segments/); assert.equal(logs.filter((l) => /replayed \(/.test(l)).length, 2, 'one progress line per segment');
    // a second run starts clean: the same single record, not two
    const r2 = await runMoverBackfill({ dataDir: dir, studyOptions: { controlsPerMover: 2 } }); assert.equal(r2.movers, 1);
    assert.equal(readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"MOVER"')).length, 1);
    // no archive at all: nothing found, nothing thrown
    const empty = mkdtempSync(path.join(tmpdir(), 'serpent-mb-empty-')); try { const e = await runMoverBackfill({ dataDir: empty }); assert.equal(e.segments, 0); assert.equal(e.movers, 0); } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MB-03. the move-clock lesson counts backfilled movers, a live record of the same climb wins the pair once, and the line says how many came from the archive', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mb-'));
  try {
    writeArchive(dir);
    await runMoverBackfill({ dataDir: dir, studyOptions: { controlsPerMover: 1 } });
    const now = T0 + 300 * MIN; const logs = [];
    const lesson = createMoveClockLesson({ dataDir: dir, clock: () => now, log: (m) => logs.push(m), options: { armAt: 1 } });
    let l = lesson.refresh();
    assert.equal(l.state, 'ARMED'); assert.equal(l.movers, 1); assert.deepEqual(lesson.status().sources, { live: 0, backfill: 1 });
    assert.match(lesson.line(), /ARMED from 1 movers \(1 of them replayed from the archive\)/);
    // the live study saw the same climb (same coin, same minute): counted once, as live
    const f = path.join(backfillStudyDir(dir), '2026-09-16.jsonl'); const mover = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).find((x) => x.kind === 'MOVER');
    mkdirSync(path.join(dir, 'learning', 'mover-study'), { recursive: true });
    writeFileSync(path.join(dir, 'learning', 'mover-study', '2026-09-16.jsonl'), `${JSON.stringify({ ...mover, recordedTs: 1 })}\n${JSON.stringify({ ...mover, coin: 'ZZZ', eventTs: mover.eventTs + MIN })}\n`);
    l = lesson.refresh(); assert.equal(l.movers, 2); assert.deepEqual(lesson.status().sources, { live: 2, backfill: 0 });
    assert.match(lesson.line(), /ARMED from 2 movers — /, 'no archive note when nothing came from it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MB-04. spawnMoverBackfill runs the replay in a child process and returns its result; a missing data dir fails plainly; a timeout is reported', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mb-'));
  try {
    writeArchive(dir); const logs = [];
    const r = await spawnMoverBackfill({ dataDir: dir, log: (m) => logs.push(m) });
    assert.equal(r.outcome, 'DONE'); assert.equal(r.movers, 1); assert.equal(r.segments, 2); assert.ok(existsSync(path.join(backfillStudyDir(dir), '2026-09-16.jsonl')));
    const bad = await spawnMoverBackfill({ dataDir: '', log: (m) => logs.push(m) }); assert.equal(bad.outcome, 'FAILED'); assert.match(logs.at(-1), /without a result/);
    const slow = await spawnMoverBackfill({ dataDir: dir, timeoutMs: 1, log: (m) => logs.push(m) }); assert.equal(slow.outcome, 'TIMEOUT'); assert.match(logs.at(-1), /timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MB-05. PUBLISH-FIX-80: a segment that vanishes after the replay pinned it (ENOENT on read — the production failure) is skipped and named; the replay finishes on the rest and the result counts it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mb-'));
  try {
    writeArchive(dir); const logs = [];
    // pinning is synchronous at the top of the run; the second segment's link (and its original) are removed before the loop
    // reaches it, so its read stream fails with ENOENT exactly as the collector's prune did in production
    const run = runMoverBackfill({ dataDir: dir, log: (m) => logs.push(m), studyOptions: { controlsPerMover: 2 } });
    rmSync(path.join(dir, 'mover-backfill', 'segments', 'events-000002.jsonl')); rmSync(path.join(dir, 'broad-kraken', 'events-000002.jsonl'));
    const r = await run;
    assert.equal(r.skipped, 1); assert.equal(r.segments, 2); assert.equal(r.movers, 0, 'the climb straddled the two segments; half of it is not a climb');
    assert.equal(r.candles, Math.floor(260 * 5 / 2) * 4 / 5, 'the first segment was read in full');
    assert.ok(logs.some((l) => /events-000002\.jsonl could not be read \(ENOENT\) — skipped/.test(l)), logs.join(' | '));
    assert.match(logs.at(-1), /replayed from 1 archived segments \(1 pruned under it, skipped\)/);
    assert.equal(logs.filter((l) => / replayed \(/.test(l)).length, 1, 'one progress line per readable segment');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MB-06. PUBLISH-FIX-80: a segment unlinked by the collector after the replay pinned it is still read in full (the hard link keeps the bytes)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-mb-'));
  try {
    writeArchive(dir); const logs = []; const first = path.join(dir, 'broad-kraken', 'events-000001.jsonl');
    // the study option hook is the only seam that runs after pinning and before reading: a tick callback is not available, so
    // unlink from a microtask queued right after the call starts (pinning is synchronous at the top of the run)
    const run = runMoverBackfill({ dataDir: dir, log: (m) => logs.push(m), studyOptions: { controlsPerMover: 2 } });
    rmSync(first); assert.ok(!existsSync(first));
    const r = await run;
    assert.equal(r.skipped, 0); assert.equal(r.segments, 2); assert.equal(r.movers, 1); assert.equal(r.candles, 260 * 4, 'every minute of the unlinked segment was read through its link');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
