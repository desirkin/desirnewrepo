// PUBLISH-FIX-108 (2026-09-21). A five-second stall on the lane that carries the bite, with its own stack trace.
//
// Production, deployment eb532bba, 03:41:
//     MAIN THREAD STALLED 5s: running JavaScript (CPU-bound on the main thread)
//     MAIN THREAD STACK (paused): canonicalDigest learning/contracts.js:53:39 <- patternRecordError learning/contracts.js:2…
//     CPU LOAD 60s: busy 58784ms idle 1845ms (event-loop utilization 97%)
//
// The learning store caches each journal keyed on the file's SIZE. Any growth the cache did not itself make — the bucket
// restore, the gate study's child process, a sweep that appended more than the cache saw — dropped the whole cache and
// re-read and re-VALIDATED every record from byte zero. `patternRecordError` alone recomputes two SHA-256 canonical digests
// per record, and these journals hold tens of thousands of records. Against a 500 ms receipt-to-decision limit and a
// ten-second proposal law, that stall can eat a bite outright.
//
// These journals are append-only, so growth means new lines at the end. The cache now reads and validates only the TAIL.
// Every new record is validated exactly as before; only the re-validation of records already read is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLearningStore, learningDir } from '../learning/store.js';

const withStore = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-fix108-'));
  try { return fn({ dir, store: createLearningStore({ dataDir: dir, log: () => {} }), file: path.join(learningDir(dir), 'episodes.jsonl') }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

const { buildEpisode } = await import('../learning/capture.js');
const { BASELINE_RULE_VERSION } = await import('../learning/contracts.js');
const T0 = 1_789_000_000_000;
const EP = (i) => buildEpisode({
  canonicalCoin: 'AAA', decisionTs: T0 + i * 60_000, usableAtTs: T0 + i * 60_000, datasetId: 'fix108',
  mode: 'HISTORICAL_REPLAY', evidenceBasis: 'HISTORICAL_RECONSTRUCTION', fidelity: 'CANDLE_DESCRIPTIVE',
  featureSet: { features: {} }, gates: [], decision: 'NO_SETUP', baselineRuleVersion: BASELINE_RULE_VERSION,
});

// the fixture MUST be accepted — a drill that quietly skips its own mechanism is worse than no drill
function seed(store, n) {
  let appended = 0;
  for (let i = 0; i < n; i += 1) if (store.appendEpisode(EP(i)).appended === true) appended += 1;
  assert.equal(appended, n, 'every fixture episode was appended');
  return appended;
}

test('FIX108-1: growth this store did NOT make is picked up, and the rows are exactly what a full re-read would give', () => {
  withStore(({ dir, store, file }) => {
    seed(store, 12);
    const before = store.readEpisodes().length;
    // ANOTHER writer appends — exactly what the gate study's child process or the bucket restore does
    appendFileSync(file, `${JSON.stringify(EP(999))}\n`); // a VALID record this store instance never saw
    const after = store.readEpisodes();
    assert.equal(after.length, before + 1, 'the externally appended record is there');
    // and a brand-new store reading the same file from scratch agrees, row for row
    const fresh = createLearningStore({ dataDir: dir, log: () => {} }).readEpisodes();
    assert.deepEqual(after.map((r) => r.opportunityId), fresh.map((r) => r.opportunityId), 'tail-extended cache == full re-read');
  });
});

test('FIX108-2: a TORN final line is not parsed — the pass falls back and the record appears once it is whole', () => {
  withStore(({ dir, store, file }) => {
    seed(store, 6);
    const before = store.readEpisodes().length;
    const line = JSON.stringify(EP(777));
    appendFileSync(file, line.slice(0, Math.floor(line.length / 2))); // half a record, no newline
    assert.equal(store.readEpisodes().length, before, 'half a record is never a record');
    appendFileSync(file, `${line.slice(Math.floor(line.length / 2))}\n`); // completed
    assert.equal(store.readEpisodes().length, before + 1, 'and it appears once it is whole');
    const fresh = createLearningStore({ dataDir: dir, log: () => {} }).readEpisodes();
    assert.equal(fresh.length, before + 1, 'a cold read agrees');
  });
});

test('FIX108-3: a file that SHRINKS or is rewritten falls back to the full read it always did', () => {
  withStore(({ dir, store, file }) => {
    seed(store, 8);
    const all = readFileSync(file, 'utf8').trim().split('\n');
    assert.ok(store.readEpisodes().length >= 1);
    writeFileSync(file, `${all.slice(0, 2).join('\n')}\n`); // rewritten shorter
    const after = store.readEpisodes();
    assert.equal(after.length, 2, 'the cache did not keep rows the file no longer has');
    const fresh = createLearningStore({ dataDir: dir, log: () => {} }).readEpisodes();
    assert.deepEqual(after.map((r) => r.opportunityId), fresh.map((r) => r.opportunityId));
  });
});

test('FIX108-4: the mechanism is a TAIL read, not a re-read — the source says so and counts it', () => {
  const src = readFileSync('learning/store.js', 'utf8');
  assert.match(src, /function readValidatedTail\(stream, fromByte\)/, 'the tail reader exists');
  assert.match(src, /prev\[0\] !== 0x0a\) return null;/, 'it refuses an offset that is not a line boundary');
  assert.match(src, /if \(!text\.endsWith\('\\n'\)\) return null;/, 'and a torn final line');
  assert.match(src, /counters\.tailReads/, 'tail reads are counted');
  assert.match(src, /counters\.fullReads/, 'and so are the full re-reads it avoids');
  // every appended record is still validated — the saving is only on records already read
  const tail = src.slice(src.indexOf('function readValidatedTail'));
  assert.match(tail.slice(0, 1600), /if \(validator\) \{ const err = validator\(rec\); if \(err\)/, 'the tail is validated exactly like a full read');
});

test('FIX108-5: nothing about the journals themselves changed — still append-only, still validated on read', () => {
  const src = readFileSync('learning/store.js', 'utf8');
  assert.match(src, /Append-only JSONL journals with revalidation on read/);
  assert.equal(src.includes('unlinkSync'), false, 'the store still deletes nothing');
  assert.match(src, /counters\.corruptSkipped \+= 1/, 'a torn line is still skipped and counted');
  assert.match(src, /counters\.invalidRejected \+= 1/, 'an invalid record is still withheld and counted');
});
