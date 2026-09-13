import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareDailyBroadInput } from '../learning/daily-broad-input.js';
import {
  buildDailyMoveStudy, sealDailyMoveStudyManifest,
} from '../learning/daily-move-study.js';
import {
  DAILY_STUDY_DURABILITY, DAILY_STUDY_STORE_LIMITS, DailyStudyStoreError,
  dailyStudyInputDescriptorError, dailyStudyJobDescriptorError,
  dailyStudyResultReceiptError, openDailyStudyStore,
  sealDailyStudyInputDescriptor, sealDailyStudyJobDescriptor,
  sealDailyStudyResultReceipt,
} from '../learning/daily-study-store.js';
import { canonicalDigest } from '../learning/shadow-contracts.js';

const HOUR = 60 * 60_000;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 24 * HOUR;
const FINAL = END + HOUR;
const MARKET_KEYS = ['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status'];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function catalog(base = 'BTC') {
  const markets = [{ pairKey: `${base}USD`, nativeBase: `X${base}`, nativeQuote: 'ZUSD', wsname: `${base}/USD`, base, quote: 'USD', status: 'online' }];
  const out = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs: START + 1, contentId: '', markets };
  const selected = markets.map((market) => Object.fromEntries(MARKET_KEYS.map((key) => [key, market[key]])));
  out.contentId = createHash('sha1').update(canonicalJson({ venue: out.venue, quote: out.quote, policyVersion: out.policyVersion, markets: selected })).digest('hex');
  return out;
}

function fixture({ jobId = 'daily-2026-09-13', sourceId = 'broad-capture-2026-09-13', base = 'BTC' } = {}) {
  const capture = {
    catalog: catalog(base), records: [], dayStartTs: START, dayEndTs: END,
    finalizedTs: FINAL, captureStartTs: START, captureEndTs: FINAL, truncated: false,
  };
  const preparedInput = prepareDailyBroadInput(capture);
  assert.equal(preparedInput.ok, true);
  const inputDescriptor = sealDailyStudyInputDescriptor({ sourceId, capture, preparedInput });
  const manifest = sealDailyMoveStudyManifest({
    createdTs: FINAL, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: preparedInput.acceptedCatalogSnapshot,
  });
  const jobDescriptor = sealDailyStudyJobDescriptor({ jobId, manifest, inputDescriptor });
  const study = buildDailyMoveStudy({
    manifest, acceptedCatalogSnapshot: preparedInput.acceptedCatalogSnapshot,
    marketDays: preparedInput.marketDays,
  });
  const resultReceipt = sealDailyStudyResultReceipt({ jobDescriptor, study, preparedInput });
  return { capture, preparedInput, inputDescriptor, manifest, jobDescriptor, study, resultReceipt };
}

const progress = (phase, completedSteps, totalSteps, study = null, note = null) => ({
  phase, completedSteps, totalSteps,
  plannedDecisionMoments: study?.counters.plannedDecisionMoments ?? 0,
  grossPlannedRecipeVariantSlots: study?.counters.grossPlannedRecipeVariantSlots ?? 0,
  attemptedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0,
  cancelled: phase === 'CANCELLED', note,
});

async function advanceToPlan(store, fx) {
  let view = await store.createJob({ jobDescriptor: fx.jobDescriptor });
  view = await store.checkpoint({
    jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest,
    expectedRevision: view.revision, progress: progress('INPUT_VALIDATED', 1, 3),
  });
  view = await store.checkpoint({
    jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest,
    expectedRevision: view.revision, progress: progress('STUDY_BUILT', 2, 3, fx.study),
  });
  return store.checkpoint({
    jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest,
    expectedRevision: view.revision, progress: progress('PLAN_COMPLETE', 3, 3, fx.study),
  });
}

test('input, job, and result identities are deterministic, exact, bounded, and never claim execution or republish durability', () => {
  const one = fixture(); const two = fixture();
  assert.deepEqual(one.inputDescriptor, two.inputDescriptor);
  assert.deepEqual(one.jobDescriptor, two.jobDescriptor);
  assert.deepEqual(one.resultReceipt, two.resultReceipt);
  assert.equal(dailyStudyInputDescriptorError(one.inputDescriptor), null);
  assert.equal(dailyStudyJobDescriptorError(one.jobDescriptor), null);
  assert.equal(dailyStudyResultReceiptError(one.resultReceipt, one.jobDescriptor), null);
  assert.deepEqual(one.jobDescriptor.durability, DAILY_STUDY_DURABILITY);
  assert.equal(one.inputDescriptor.fullDayCatalogEpochUnionVerified, false);
  assert.equal(one.inputDescriptor.persistedRecordContinuityVerified, false);
  assert.equal(one.resultReceipt.resultMode, 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY');
  assert.equal(one.resultReceipt.attemptedSimulations, 0);
  assert.equal(one.resultReceipt.completedSimulations, 0);
  assert.equal(one.resultReceipt.validSimulationOutcomes, 0);

  const poisoned = structuredClone(one.preparedInput);
  poisoned.marketDays[0].support.PRICE.reason = 'POST_PREPARE_MUTATION';
  assert.throws(() => sealDailyStudyInputDescriptor({ sourceId: 'poison', capture: one.capture, preparedInput: poisoned }), /supplied prepared/);
  assert.throws(() => sealDailyStudyJobDescriptor({ jobId: '../escape', manifest: one.manifest, inputDescriptor: one.inputDescriptor }), /path-free/);
});

test('create/checkpoint/finalize is CAS-serialized, first-write-wins, and exactly idempotent after restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-store-'));
  let now = FINAL + 10;
  const fx = fixture();
  try {
    let store = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    let view = await store.createJob({ jobDescriptor: fx.jobDescriptor });
    assert.equal(view.status, 'CREATED'); assert.equal(view.revision, 0);
    const same = await store.createJob({ jobDescriptor: fx.jobDescriptor });
    assert.equal(same.status, 'EXISTING'); assert.equal(same.revision, 0);

    const update = progress('INPUT_VALIDATED', 1, 3);
    const raced = await Promise.allSettled([
      store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: 0, progress: update }),
      store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: 0, progress: update }),
    ]);
    assert.equal(raced.filter((row) => row.status === 'fulfilled').length, 1);
    assert.equal(raced.filter((row) => row.status === 'rejected' && row.reason.code === 'REVISION_CONFLICT').length, 1);
    view = await store.loadJob(fx.jobDescriptor.jobId);
    view = await store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: view.revision, progress: progress('STUDY_BUILT', 2, 3, fx.study) });
    view = await store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: view.revision, progress: progress('PLAN_COMPLETE', 3, 3, fx.study) });
    await assert.rejects(store.finalize({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: view.revision, resultReceipt: fx.resultReceipt }), (error) => error.code === 'RESULT_INVALID');
    view = await store.finalize({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: view.revision, resultReceipt: fx.resultReceipt, study: fx.study, preparedInput: fx.preparedInput });
    assert.equal(view.status, 'FINALIZED'); assert.equal(view.progress.phase, 'FINALIZED');
    const finalRevision = view.revision;
    await store.close();

    store = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    view = await store.loadJob(fx.jobDescriptor.jobId);
    assert.equal(view.revision, finalRevision);
    assert.equal(view.result.resultDigest, fx.resultReceipt.resultDigest);
    const repeated = await store.finalize({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: 0, resultReceipt: fx.resultReceipt });
    assert.equal(repeated.status, 'EXISTING', 'exact retry is idempotent even with its old CAS revision');
    assert.equal(repeated.revision, finalRevision, 'exact retry never appends a second completion');
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same jobId cannot be rebound, and a completed job cannot accept a different result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-conflict-'));
  let now = FINAL + 10;
  const first = fixture(); const changed = fixture({ jobId: first.jobDescriptor.jobId, sourceId: 'different-source' });
  try {
    const store = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    const planned = await advanceToPlan(store, first);
    await assert.rejects(store.createJob({ jobDescriptor: changed.jobDescriptor }), (error) => error.code === 'JOB_ID_CONFLICT');
    const finalized = await store.finalize({ jobId: first.jobDescriptor.jobId, jobDigest: first.jobDescriptor.jobDigest, expectedRevision: planned.revision, resultReceipt: first.resultReceipt, study: first.study, preparedInput: first.preparedInput });
    const alteredStudy = structuredClone(first.study);
    alteredStudy.laws = { ...alteredStudy.laws, localReceiptTest: 'DIFFERENT_BUT_STILL_NON_EXECUTING' };
    assert.throws(() => sealDailyStudyResultReceipt({ jobDescriptor: first.jobDescriptor, study: alteredStudy, preparedInput: first.preparedInput }), /independent planner recomputation/);
    const alteredReceipt = structuredClone(first.resultReceipt);
    alteredReceipt.studyDigest = 'f'.repeat(64);
    alteredReceipt.resultId = '';
    alteredReceipt.resultDigest = '';
    alteredReceipt.resultDigest = canonicalDigest(Object.fromEntries(Object.entries(alteredReceipt).filter(([key]) => !['resultId', 'resultDigest'].includes(key))));
    alteredReceipt.resultId = `dailyresult-${alteredReceipt.resultDigest.slice(0, 32)}`;
    await assert.rejects(store.finalize({ jobId: first.jobDescriptor.jobId, jobDigest: first.jobDescriptor.jobDigest, expectedRevision: finalized.revision, resultReceipt: alteredReceipt }), (error) => error.code === 'RESULT_CONFLICT');
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second owner never takes a live lock by age; close drains, fences, and permits a later owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-owner-'));
  let now = FINAL + 10;
  const fx = fixture();
  try {
    const first = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    await assert.rejects(openDailyStudyStore({ rootDir: root, clock: () => now + 10_000_000 }), (error) => error.code === 'DAILY_STUDY_LOCK_HELD');
    const pending = first.createJob({ jobDescriptor: fx.jobDescriptor });
    const closing = first.close();
    assert.equal((await pending).status, 'CREATED');
    await closing;
    await assert.rejects(first.loadJob(fx.jobDescriptor.jobId), (error) => error.code === 'STORE_CLOSED');
    const later = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    assert.equal((await later.loadJob(fx.jobDescriptor.jobId)).revision, 0);
    await later.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted owner restarts only through exact operator-verified token recovery, never age inference', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-recovery-'));
  let now = FINAL + 10;
  const fx = fixture();
  let interrupted; let recovered;
  try {
    interrupted = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    await interrupted.createJob({ jobDescriptor: fx.jobDescriptor });
    const held = JSON.parse(readFileSync(path.join(root, 'writer.lock'), 'utf8'));
    writeFileSync(path.join(root, 'jobs', `.${fx.jobDescriptor.jobId}.json.${'b'.repeat(24)}.tmp`), '{"interrupted":');
    await assert.rejects(openDailyStudyStore({
      rootDir: root, clock: () => now + 1_000_000,
      recoverStaleLock: { expectedToken: 'f'.repeat(24), confirmedBy: 'operator-test' },
    }), (error) => error.code === 'LOCK_RECOVERY_REFUSED');
    recovered = await openDailyStudyStore({
      rootDir: root, clock: () => now++,
      recoverStaleLock: { expectedToken: held.writerToken, confirmedBy: 'operator-verified-old-process-dead' },
    });
    assert.equal((await recovered.loadJob(fx.jobDescriptor.jobId)).revision, 0);
    assert.deepEqual(recovered.status().writerRecovery, { previousToken: held.writerToken, confirmedBy: 'operator-verified-old-process-dead' });
    await assert.rejects(interrupted.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: 0, progress: progress('INPUT_VALIDATED', 1, 1) }), (error) => error.code === 'LOCK_LOST');
  } finally {
    if (interrupted) {
      if (recovered) await assert.rejects(interrupted.close(), (error) => error.code === 'LOCK_LOST');
      else await interrupted.close();
    }
    if (recovered) await recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CAS never overwrites a committed job file altered or deleted after open', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-custody-'));
  let now = FINAL + 10;
  const fx = fixture();
  try {
    let store = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    await store.createJob({ jobDescriptor: fx.jobDescriptor });
    const committed = path.join(root, 'jobs', `${fx.jobDescriptor.jobId}.json`);
    const altered = JSON.parse(readFileSync(committed, 'utf8'));
    altered.progress.note = 'external-rewrite';
    altered.stateDigest = '';
    altered.stateDigest = canonicalDigest(Object.fromEntries(Object.entries(altered).filter(([key]) => key !== 'stateDigest')));
    writeFileSync(committed, JSON.stringify(altered));
    await assert.rejects(store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: 0, progress: progress('INPUT_VALIDATED', 1, 1) }), (error) => error.code === 'DISK_CUSTODY_CONFLICT');
    assert.equal(store.status().failed.code, 'DISK_CUSTODY_CONFLICT');
    await store.close();

    const secondRoot = mkdtempSync(path.join(tmpdir(), 'daily-study-custody-delete-'));
    try {
      store = await openDailyStudyStore({ rootDir: secondRoot, clock: () => now++ });
      await store.createJob({ jobDescriptor: fx.jobDescriptor });
      unlinkSync(path.join(secondRoot, 'jobs', `${fx.jobDescriptor.jobId}.json`));
      await assert.rejects(store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: 0, progress: progress('INPUT_VALIDATED', 1, 1) }), (error) => error.code === 'DISK_CUSTODY_CONFLICT');
      await store.close();
    } finally { rmSync(secondRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an orphan partial temp is uncommitted and ignored, while malformed committed state fails the whole store closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-crash-'));
  let now = FINAL + 10;
  const fx = fixture();
  try {
    let store = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    await store.createJob({ jobDescriptor: fx.jobDescriptor });
    await store.close();
    const jobs = path.join(root, 'jobs');
    writeFileSync(path.join(jobs, `.${fx.jobDescriptor.jobId}.json.${'a'.repeat(24)}.tmp`), '{"torn":');
    store = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    assert.equal((await store.loadJob(fx.jobDescriptor.jobId)).revision, 0, 'only the atomically renamed state is committed');
    await store.close();

    const committed = path.join(jobs, `${fx.jobDescriptor.jobId}.json`);
    const state = JSON.parse(readFileSync(committed, 'utf8'));
    state.revision += 1;
    writeFileSync(committed, JSON.stringify(state));
    await assert.rejects(openDailyStudyStore({ rootDir: root, clock: () => now++ }), (error) => error.code === 'STORE_CORRUPT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('limits, empty-history meaning, and symlink roots remain fail-closed', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-limits-'));
  let now = FINAL + 10;
  const one = fixture(); const two = fixture({ jobId: 'daily-2026-09-14', sourceId: 'other-capture', base: 'ETH' });
  try {
    const store = await openDailyStudyStore({ rootDir: root, clock: () => now++, limits: { maxJobs: 1 } });
    assert.equal(store.status().jobCount, 0);
    assert.equal(store.status().emptyStoreMeaning, 'NO_JOBS_IS_NOT_A_COMPLETION_RECEIPT');
    assert.equal(await store.loadJob('missing-job'), null);
    await store.createJob({ jobDescriptor: one.jobDescriptor });
    await assert.rejects(store.createJob({ jobDescriptor: two.jobDescriptor }), (error) => error.code === 'JOB_LIMIT');
    const oversized = progress('INPUT_VALIDATED', 1, 1, null, 'x'.repeat(501));
    await assert.rejects(store.checkpoint({ jobId: one.jobDescriptor.jobId, jobDigest: one.jobDescriptor.jobDigest, expectedRevision: 0, progress: oversized }), (error) => error.code === 'CHECKPOINT_INVALID');
    await store.close();

    const actual = mkdtempSync(path.join(tmpdir(), 'daily-study-real-'));
    const link = path.join(tmpdir(), `daily-study-link-${process.pid}-${Date.now()}`);
    try {
      try { symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { t.diagnostic(`symlink unavailable: ${error.code}`); return; }
      await assert.rejects(openDailyStudyStore({ rootDir: link, clock: () => now++ }), (error) => error instanceof DailyStudyStoreError && error.code === 'PATH_ESCAPE');
    } finally {
      rmSync(link, { recursive: true, force: true }); rmSync(actual, { recursive: true, force: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a configured revision ceiling cannot be crossed by a final checkpoint', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-revisions-'));
  let now = FINAL + 10;
  const fx = fixture();
  try {
    const store = await openDailyStudyStore({ rootDir: root, clock: () => now++, limits: { maxRevisionsPerJob: 1 } });
    const created = await store.createJob({ jobDescriptor: fx.jobDescriptor });
    const once = await store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: created.revision, progress: progress('INPUT_VALIDATED', 1, 2) });
    await assert.rejects(store.checkpoint({ jobId: fx.jobDescriptor.jobId, jobDigest: fx.jobDescriptor.jobDigest, expectedRevision: once.revision, progress: progress('STUDY_BUILT', 2, 2, fx.study) }), (error) => error.code === 'REVISION_LIMIT');
    assert.equal(store.status().failed, null, 'a clean configured refusal does not corrupt or latch the store');
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('oversized committed state is rejected by stat before parsing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daily-study-read-limit-'));
  let now = FINAL + 10;
  const fx = fixture();
  try {
    let store = await openDailyStudyStore({ rootDir: root, clock: () => now++ });
    await store.createJob({ jobDescriptor: fx.jobDescriptor }); await store.close();
    writeFileSync(path.join(root, 'jobs', `${fx.jobDescriptor.jobId}.json`), 'x'.repeat(DAILY_STUDY_STORE_LIMITS.maxStateBytes + 1));
    await assert.rejects(openDailyStudyStore({ rootDir: root, clock: () => now++ }), (error) => error.code === 'STORE_CORRUPT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
