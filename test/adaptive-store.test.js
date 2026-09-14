import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { opportunityIdOf } from '../learning/contracts.js';
import { createAdaptiveCore } from '../learning/adaptive-core.js';
import { AdaptiveStoreError, createAdaptiveStore } from '../learning/adaptive-store.js';
import { ADAPTIVE_HORIZON_MS, sealAdaptiveProcedure } from '../learning/adaptive-registry.js';
import { adaptiveSettlementSubmission } from './helpers/adaptive-outcome-fixture.js';

const T0 = Date.UTC(2026, 8, 13, 15);
const hex = (char) => char.repeat(64);

function procedure(extra = {}) {
  return sealAdaptiveProcedure({
    parentPolicyDigest: hex('a'), consumerContractDigest: hex('b'), featureRecipeDigest: hex('c'),
    strategyIds: ['IGNITION', 'PULLBACK'], createdTs: T0, ...extra,
  });
}

function tempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'adaptive-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function input(p, n = 1) {
  const decisionTs = T0 + n * 10_000;
  const identity = { canonicalCoin: `S${n}S`, decisionTs, captureRecipeVersion: 'store-test-capture-1', datasetId: 'store-test' };
  return {
    opportunityId: opportunityIdOf(identity), identity, catalogContentId: 'catalog-store-test',
    predictionTs: decisionTs, horizonMs: ADAPTIVE_HORIZON_MS,
    featureRecipeDigest: p.parent.featureRecipeDigest, factsDigest: hex('e'),
    strategyAssessments: p.strategies.map((strategyId) => ({ strategyId, eligibility: 'ELIGIBLE', reasonCode: null })),
    selection: { strategyId: 'IGNITION', reasonCode: 'BASELINE_SELECTED' },
  };
}

function mature(prediction, returnPct = 1) {
  return {
    opportunityId: prediction.opportunityId, horizonMs: prediction.horizonMs,
    state: 'MATURED', logReturnPct: returnPct, sourceEventTs: prediction.targetEndTs,
    knownAtTs: prediction.targetEndTs + 1_000, sourceDigest: hex('f'), reasonCode: null,
  };
}

test('durable replay restores the exact state and dedup identities after a clean restart', (t) => {
  const rootDir = tempRoot(t); const p = procedure(); let now = T0 + 10_100;
  let store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  let core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const original = input(p);
  const prediction = core.recordPrediction(original).prediction;
  now = prediction.targetEndTs + 1_000;
  const submission = adaptiveSettlementSubmission(p, prediction, mature(prediction));
  const first = core.recordOutcome(submission);
  const before = store.state(); const updateDigest = first.update.updateDigest;
  const committed = store.settlement({ opportunityId: prediction.opportunityId, horizonMs: prediction.horizonMs });
  assert.equal(committed.provenanceReceipt.receiptDigest, submission.provenanceReceipt.receiptDigest);
  assert.equal(committed.outcome.sourceDigest, committed.provenanceReceipt.receiptDigest);
  assert.equal(committed.update.updateDigest, first.update.updateDigest);
  assert.equal(committed.custody.receiptContentBound, true);
  assert.equal(committed.custody.declaredArchiveIdentityBound, true);
  assert.equal(committed.custody.externalSourceAuthenticityVerified, false);
  assert.equal(committed.custody.firstWriteCustodyVerified, false);
  assert.equal(committed.custody.afterCostQualificationVerified, false);
  assert.equal(committed.custody.authority, 'NONE');
  store.close();

  now += 1_000;
  store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  assert.deepEqual(store.state(), before);
  assert.equal(core.recordPrediction(original).status, 'EXISTING');
  assert.equal(core.recordOutcome(submission).status, 'EXISTING');
  assert.equal(store.state().sequence, 1);
  assert.equal(store.status().updateCount, 1);
  assert.equal(store.status().provenanceReceiptCount, 1);
  assert.equal(store.status().unbackedOutcomeCount, 0);
  assert.equal(store.settlement({ opportunityId: prediction.opportunityId, horizonMs: prediction.horizonMs }).provenanceReceipt.receiptDigest, submission.provenanceReceipt.receiptDigest);
  assert.equal(first.update.updateDigest, updateDigest);
  assert.equal(store.status().durability.kind, 'LOCAL_FILESYSTEM_ONLY');
  assert.equal(store.status().durability.republishSafe, false);
  assert.equal(store.status().durability.wholeDirectoryRollbackProtected, false);
  assert.equal(store.status().acknowledgedHead.stateDigest, before.stateDigest);
  assert.equal(store.status().remaining.events, store.status().limits.maxEvents - store.status().eventCount);
  store.close();
});

test('idempotent update retries validate every supplied body after durable replay', (t) => {
  const rootDir = tempRoot(t); const p = procedure(); let now = T0 + 10_100;
  let store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  const core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const prediction = core.recordPrediction(input(p)).prediction;
  now = prediction.targetEndTs + 1_000;
  const submission = adaptiveSettlementSubmission(p, prediction, mature(prediction));
  const first = core.recordOutcome(submission);
  const committedState = first.state;
  store.close();

  now += 1_000;
  store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  const settlement = store.settlement({
    opportunityId: prediction.opportunityId,
    horizonMs: prediction.horizonMs,
  });
  const exact = {
    outcome: settlement.outcome,
    provenanceReceipt: settlement.provenanceReceipt,
    scores: settlement.scores,
    update: settlement.update,
    nextState: committedState,
  };
  assert.equal(store.appendOutcomeUpdate(exact).status, 'EXISTING');
  const before = store.status(); const stateBefore = store.state();
  const badRetries = [
    {
      name: 'outcome body with its old digest',
      change(value) { value.outcome.logReturnPct += 1; },
      code: 'OUTCOME_INVALID',
    },
    {
      name: 'receipt body with its old digest',
      change(value) { value.provenanceReceipt.label.availability.reason = 'ALTERED'; },
      code: 'SETTLEMENT_INVALID',
    },
    {
      name: 'score body with its old digest',
      change(value) { value.scores[0].brierLoss += 0.01; },
      code: 'SCORE_INVALID',
    },
    {
      name: 'update body with its old digest',
      change(value) { value.update.episodeInfluenceAfter += 0.000001; },
      code: 'UPDATE_CONFLICT',
    },
    {
      name: 'next-state body with its old digest',
      change(value) { value.nextState.updatedTs += 1; },
      code: 'STATE_CONFLICT',
    },
  ];
  for (const scenario of badRetries) {
    const altered = JSON.parse(JSON.stringify(exact));
    scenario.change(altered);
    assert.throws(
      () => store.appendOutcomeUpdate(altered),
      (error) => error instanceof AdaptiveStoreError && error.code === scenario.code,
      scenario.name,
    );
    assert.equal(store.status().eventCount, before.eventCount, `${scenario.name}: no journal append`);
    assert.deepEqual(store.state(), stateBefore, `${scenario.name}: no state mutation`);
  }
  assert.equal(store.status().failed, null, 'rejected retry content does not latch or mutate the store');
  store.close();
});

test('a v1 directory is refused without migration, reset, or writer-lock mutation', (t) => {
  const rootDir = tempRoot(t); const p = procedure();
  const journalFile = path.join(rootDir, 'journal.jsonl');
  const headFile = path.join(rootDir, 'head.json');
  const journal = `${JSON.stringify({ storeVersion: 'adaptive-local-store-1', eventVersion: 'adaptive-journal-event-1' })}\n`;
  const head = JSON.stringify({ storeVersion: 'adaptive-local-store-1', headVersion: 'adaptive-acknowledged-head-1' });
  writeFileSync(journalFile, journal);
  writeFileSync(headFile, head);
  assert.throws(
    () => createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 1 }),
    (error) => error instanceof AdaptiveStoreError && error.code === 'STORE_VERSION_UNSUPPORTED',
  );
  assert.equal(readFileSync(journalFile, 'utf8'), journal);
  assert.equal(readFileSync(headFile, 'utf8'), head);
  assert.equal(existsSync(path.join(rootDir, 'writer.lock')), false);
});

test('single ownership is exclusive and never uses age or PID takeover', (t) => {
  const rootDir = tempRoot(t); const p = procedure();
  const first = createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 1 });
  assert.throws(
    () => createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 10 * 365 * 24 * 60 * 60_000 }),
    (error) => error instanceof AdaptiveStoreError && error.code === 'ADAPTIVE_STORE_LOCK_HELD',
  );
  first.close();
  const next = createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 2 });
  next.close();
});

test('procedure identity cannot be reused with changed algorithm or parent', (t) => {
  const rootDir = tempRoot(t); const p = procedure();
  const store = createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 1 }); store.close();
  const changed = procedure({ learningRate: 0.2 });
  assert.throws(
    () => createAdaptiveStore({ rootDir, procedure: changed, clock: () => T0 + 2 }),
    (error) => error instanceof AdaptiveStoreError && error.code === 'PROCEDURE_CONFLICT',
  );
  assert.equal(existsSync(path.join(rootDir, 'writer.lock')), false, 'failed open releases only its own new lock');
});

test('partial/corrupt journal is never skipped or repaired into an older apparent state', (t) => {
  const rootDir = tempRoot(t); const p = procedure();
  const store = createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 1 }); store.close();
  appendFileSync(path.join(rootDir, 'journal.jsonl'), '{"partial":');
  assert.throws(
    () => createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 2 }),
    (error) => error instanceof AdaptiveStoreError && error.code === 'STORE_CORRUPT',
  );
});

test('a valid whole-event suffix truncation cannot roll state back behind the acknowledged head', (t) => {
  const rootDir = tempRoot(t); const p = procedure(); let now = T0 + 10_100;
  const store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  const core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const prediction = core.recordPrediction(input(p, 1)).prediction;
  now = prediction.targetEndTs + 1_000;
  core.recordOutcome(adaptiveSettlementSubmission(p, prediction, mature(prediction)));
  store.close();
  const journalFile = path.join(rootDir, 'journal.jsonl');
  const lines = readFileSync(journalFile, 'utf8').trimEnd().split('\n');
  lines.pop();
  writeFileSync(journalFile, `${lines.join('\n')}\n`);
  assert.throws(
    () => createAdaptiveStore({ rootDir, procedure: p, clock: () => now + 1 }),
    (error) => error instanceof AdaptiveStoreError && error.code === 'ACKNOWLEDGED_HEAD_MISMATCH',
  );
});

test('journal-ahead head-behind crash window refuses replay rather than guessing which write committed', (t) => {
  const rootDir = tempRoot(t); const p = procedure(); let now = T0 + 10_100;
  const store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  const oldHead = readFileSync(path.join(rootDir, 'head.json'));
  const core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  core.recordPrediction(input(p, 1));
  store.close();
  writeFileSync(path.join(rootDir, 'head.json'), oldHead);
  assert.throws(
    () => createAdaptiveStore({ rootDir, procedure: p, clock: () => now + 1 }),
    (error) => error instanceof AdaptiveStoreError && error.code === 'ACKNOWLEDGED_HEAD_MISMATCH',
  );
});

test('an externally altered committed journal latches before any overwrite', (t) => {
  const rootDir = tempRoot(t); const p = procedure(); let now = T0 + 10_100;
  const store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  const core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const journal = path.join(rootDir, 'journal.jsonl');
  appendFileSync(journal, ' ');
  const next = input(p, 2); now = next.predictionTs + 100;
  assert.throws(
    () => core.recordPrediction(next),
    (error) => error instanceof AdaptiveStoreError && error.code === 'DISK_CUSTODY_CONFLICT',
  );
  assert.equal(store.status().failed.code, 'DISK_CUSTODY_CONFLICT');
  assert.throws(() => core.recordPrediction(next), /STORE_LATCHED/);
  store.close();
});

test('empty pre-existing history is not commissioned as a completed or valid store', (t) => {
  const rootDir = tempRoot(t); const p = procedure();
  writeFileSync(path.join(rootDir, 'journal.jsonl'), '');
  assert.throws(
    () => createAdaptiveStore({ rootDir, procedure: p, clock: () => T0 + 1 }),
    (error) => error instanceof AdaptiveStoreError && error.code === 'STORE_CORRUPT',
  );
});

test('bounded journal refusal is visible and latched, never an implicit reset', (t) => {
  const rootDir = tempRoot(t); const p = procedure(); let now = T0 + 10_100;
  const store = createAdaptiveStore({
    rootDir, procedure: p, clock: () => now,
    limits: { maxJournalBytes: 16 * 1024, maxEventBytes: 8 * 1024, maxEvents: 2 },
  });
  const core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const first = input(p, 1); core.recordPrediction(first);
  const second = input(p, 2); now = second.predictionTs + 100;
  assert.throws(() => core.recordPrediction(second), (error) => error instanceof AdaptiveStoreError && error.code === 'EVENT_LIMIT');
  assert.equal(store.status().failed.code, 'EVENT_LIMIT');
  assert.equal(store.status().stateSequence, 0);
  store.close();
});

test('the event byte ceiling covers the receipt and refuses the whole settlement before any split write', (t) => {
  const rootDir = tempRoot(t); const p = procedure(); let now = T0 + 10_100;
  let store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  let core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const prediction = core.recordPrediction(input(p, 1)).prediction;
  store.close();
  const journalFile = path.join(rootDir, 'journal.jsonl');
  const initialLines = readFileSync(journalFile, 'utf8').trim().split('\n');
  const preSettlementBytes = Math.max(...initialLines.map((line) => Buffer.byteLength(line, 'utf8') + 1));
  store = createAdaptiveStore({
    rootDir, procedure: p, clock: () => now,
    limits: { maxEventBytes: preSettlementBytes + 64 },
  });
  core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  now = prediction.targetEndTs + 1_000;
  const submission = adaptiveSettlementSubmission(p, prediction, mature(prediction));
  assert.throws(
    () => core.recordOutcome(submission),
    (error) => error instanceof AdaptiveStoreError && error.code === 'JOURNAL_LIMIT',
  );
  assert.equal(readFileSync(journalFile, 'utf8').trim().split('\n').length, 2);
  assert.equal(store.status().outcomeCount, 0);
  assert.equal(store.status().provenanceReceiptCount, 0);
  store.close();
});

test('one thousand updates retain bounded state and linear journal bytes rather than repeated history snapshots', (t) => {
  const rootDir = tempRoot(t); const p = procedure({ maxCumulativeRankMovementRrPoints: 100 });
  let now = T0 + 100;
  const store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  const core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const marks = new Map([[100, null], [900, null], [1_000, null]]);
  for (let n = 1; n <= 1_000; n += 1) {
    const row = input(p, n);
    row.identity.decisionTs = T0 + n * 3_700_000;
    row.predictionTs = row.identity.decisionTs;
    row.opportunityId = opportunityIdOf(row.identity);
    now = row.predictionTs + 100;
    const prediction = core.recordPrediction(row).prediction;
    now = prediction.targetEndTs + 1_000;
    core.recordOutcome(adaptiveSettlementSubmission(p, prediction, mature(prediction, n % 2 === 0 ? -1 : 1)));
    if (marks.has(n)) marks.set(n, store.status().journalBytes);
  }
  const firstHundredAverage = marks.get(100) / 100;
  const lastHundredAverage = (marks.get(1_000) - marks.get(900)) / 100;
  const stateBytes = Buffer.byteLength(JSON.stringify(store.state()), 'utf8');
  assert.equal(store.status().updateCount, 1_000);
  assert.equal(store.status().eventCount, 2_001);
  assert.ok(lastHundredAverage < firstHundredAverage * 2, 'tail event bytes do not grow with all prior episodes');
  assert.ok(marks.get(1_000) < 20 * 1024 * 1_000, '1,000 episodes stay below a conservative linear byte ceiling');
  assert.ok(stateBytes < 8 * 1024, 'current state is fixed-size for a fixed strategy registry');
  const events = readFileSync(path.join(rootDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const updated = events.filter((event) => event.eventType === 'OUTCOME_UPDATED');
  assert.equal(updated.length, 1_000);
  assert.equal(updated.every((event) => !Object.hasOwn(event.body, 'nextState') && typeof event.body.nextStateDigest === 'string'), true);
  t.diagnostic(`adaptive journal bytes/update: first100=${firstHundredAverage.toFixed(1)}, last100=${lastHundredAverage.toFixed(1)}, total1000=${marks.get(1_000)}, state=${stateBytes}`);
  store.close();
});
