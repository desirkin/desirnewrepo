import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest, opportunityIdOf } from '../learning/contracts.js';
import { createAdaptiveCore } from '../learning/adaptive-core.js';
import {
  ADAPTIVE_CANDLE_RECEIPT_DURABILITY, adaptiveCandleOutcomeReceiptError,
  adaptiveCandleOutcomeSubmissionError, adaptiveCandleSettlementError,
  prepareAdaptiveCandleOutcome,
} from '../learning/adaptive-candle-outcome.js';
import { sealAdaptiveProcedure } from '../learning/adaptive-registry.js';
import { createAdaptiveStore } from '../learning/adaptive-store.js';
import { readLearningArchive } from '../learning/labels.js';

const T0 = Date.UTC(2026, 8, 13, 17);
const hex = (char) => char.repeat(64);
const clone = (value) => JSON.parse(JSON.stringify(value));

function rehashReceipt(receipt) {
  receipt.labelDigest = canonicalDigest(receipt.label);
  receipt.receiptDigest = canonicalDigest(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => !['receiptId', 'receiptDigest'].includes(key)),
  ));
  receipt.receiptId = `aclr-${receipt.receiptDigest.slice(0, 40)}`;
  return receipt;
}

function procedure(extra = {}) {
  return sealAdaptiveProcedure({
    parentPolicyDigest: hex('a'), consumerContractDigest: hex('b'), featureRecipeDigest: hex('c'),
    strategyIds: ['IGNITION', 'MOMENTUM'], createdTs: T0,
    maxLabelDelayMs: 10_000, ...extra,
  });
}

function rig(t, extra = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adaptive-candle-core-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let now = T0 + 10_445; const p = procedure(extra);
  const store = createAdaptiveStore({ rootDir, procedure: p, clock: () => now });
  t.after(() => { try { store.close(); } catch {} });
  const core = createAdaptiveCore({ store, procedure: p, clock: () => now });
  const identity = {
    canonicalCoin: 'BTC', decisionTs: T0 + 10_345,
    captureRecipeVersion: 'adaptive-candle-test-1', datasetId: 'adaptive-candle-data',
  };
  const prediction = core.recordPrediction({
    opportunityId: opportunityIdOf(identity), identity,
    catalogContentId: 'catalog-candle-test', predictionTs: identity.decisionTs,
    horizonMs: p.target.horizonMs, featureRecipeDigest: p.parent.featureRecipeDigest,
    factsDigest: hex('d'),
    strategyAssessments: p.strategies.map((strategyId) => ({ strategyId, eligibility: 'ELIGIBLE', reasonCode: null })),
    selection: { strategyId: 'IGNITION', reasonCode: 'BASELINE_SELECTED' },
  }).prediction;
  return { rootDir, procedure: p, store, core, prediction, setNow: (value) => { now = value; } };
}

function archiveFixture(t, prediction, { retrievedTs = prediction.targetEndTs, omitOpenSec = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'adaptive-candle-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const anchorSec = (prediction.targetEndTs - prediction.horizonMs) / 1_000;
  const candles = [];
  for (let k = -1; k < 60; k += 1) {
    const open = anchorSec + k * 60;
    if (open === omitOpenSec) continue;
    if (k === -1) candles.push([open, 100, 100, 100, 100, 10]);
    else {
      const start = 100 + k / 60; const close = 100 + (k + 1) / 60;
      candles.push([open, start, close, start, close, 10 + k]);
    }
  }
  const retrievedSec = retrievedTs / 1_000;
  const row = {
    symbol: 'BTC', intervalMin: 1, retrievedSec,
    retrievedTs: new Date(retrievedTs).toISOString(), candles,
  };
  const candleBody = `${JSON.stringify(row)}\n`;
  writeFileSync(path.join(dir, 'candles-1m.jsonl'), candleBody);
  const manifest = {
    schemaVersion: 'childhood-observation-3-b0b', childhoodVersion: 'B0B.2A',
    archiveCreatedTs: new Date(retrievedTs).toISOString(),
    sourceChecksumsSha256_16: {
      'candles-1m.jsonl': createHash('sha256').update(candleBody).digest('hex').slice(0, 16),
    },
    universeCoverageStatus: 'FIXTURE_SINGLE_ASSET',
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, archive: readLearningArchive(dir) };
}

test('actual existing 60m candle label becomes the exact price-return outcome with a manifest-bound receipt', (t) => {
  const h = rig(t); const source = archiveFixture(t, h.prediction);
  const prepared = prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: h.prediction.targetEndTs,
  });
  assert.equal(prepared.status, 'MATURED');
  assert.equal(prepared.outcomeInput.sourceEventTs, h.prediction.targetEndTs);
  assert.equal(prepared.outcomeInput.knownAtTs, h.prediction.targetEndTs);
  assert.ok(prepared.outcomeInput.logReturnPct > 0);
  assert.equal(Object.hasOwn(prepared.outcomeInput, 'fees'), false, 'price target is not re-netted or presented as executable profit');
  assert.equal(prepared.provenanceReceipt.sourceIdentity.manifestSha256, createHash('sha256').update(readFileSync(path.join(source.dir, 'manifest.json'))).digest('hex'));
  assert.equal(prepared.provenanceReceipt.label.horizon60m.logReturnPct, prepared.outcomeInput.logReturnPct);
  assert.equal(prepared.provenanceReceipt.durability, ADAPTIVE_CANDLE_RECEIPT_DURABILITY);
  assert.equal(adaptiveCandleOutcomeReceiptError(prepared.provenanceReceipt, h.procedure, h.prediction, { archive: source.archive }), null);
  const submission = { outcomeInput: prepared.outcomeInput, provenanceReceipt: prepared.provenanceReceipt };
  assert.equal(adaptiveCandleOutcomeSubmissionError(submission, h.procedure, h.prediction, { archive: source.archive }), null);
  h.setNow(h.prediction.targetEndTs);
  const beforeRefusal = h.store.status().acknowledgedHead.headDigest;
  assert.throws(() => h.core.recordOutcome({ outcomeInput: prepared.outcomeInput, provenanceReceipt: null }), /OUTCOME_PROVENANCE_INVALID/);
  assert.equal(h.store.status().acknowledgedHead.headDigest, beforeRefusal, 'invalid provenance causes no journal/head mutation');
  const result = h.core.recordOutcome(submission);
  assert.equal(result.status, 'UPDATED');
  const settlement = h.store.settlement({ opportunityId: h.prediction.opportunityId, horizonMs: h.prediction.horizonMs });
  assert.equal(adaptiveCandleSettlementError({ outcome: settlement.outcome, provenanceReceipt: settlement.provenanceReceipt }, h.procedure, h.prediction, { archive: source.archive }), null);
  assert.equal(settlement.eventDigest, settlement.custody.acknowledgedHead.lastEventDigest);
  assert.equal(settlement.custody.authority, 'NONE');
  const events = readFileSync(path.join(h.rootDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const terminal = events.at(-1);
  assert.equal(terminal.eventType, 'OUTCOME_UPDATED');
  assert.equal(terminal.body.outcome.sourceDigest, terminal.body.provenanceReceipt.receiptDigest);
  assert.equal(events.some((event) => /RECEIPT/.test(event.eventType)), false, 'receipt is not a separate crash-window write');
});

test('one unavailable poll remains pending until the presealed missingness deadline', (t) => {
  const h = rig(t);
  const asOfTs = h.prediction.targetEndTs + 5_000;
  const prepared = prepareAdaptiveCandleOutcome({ procedure: h.procedure, prediction: h.prediction, archive: null, asOfTs });
  assert.equal(prepared.status, 'PENDING');
  assert.deepEqual(prepared.outcomeInput, {
    opportunityId: h.prediction.opportunityId, horizonMs: h.prediction.horizonMs,
    state: 'PENDING', logReturnPct: null, sourceEventTs: null, knownAtTs: null,
    sourceDigest: null, reasonCode: 'LABEL_PENDING:ARCHIVE_ABSENT',
  });
  h.setNow(asOfTs);
  assert.equal(h.core.recordOutcome({ outcomeInput: prepared.outcomeInput, provenanceReceipt: prepared.provenanceReceipt }).status, 'PENDING_NO_DURABLE_OUTCOME');
  assert.equal(h.store.status().outcomeCount, 0);
  assert.equal(h.store.state().sequence, 0);
});

test('a future-acquired source is refused at an earlier as-of and is usable only at its real known-at clock', (t) => {
  const h = rig(t);
  const retrievedTs = h.prediction.targetEndTs + 7_000;
  const source = archiveFixture(t, h.prediction, { retrievedTs });
  assert.throws(() => prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: h.prediction.targetEndTs + 5_000,
  }), /archive source was unavailable when the receipt was prepared/);
  const known = prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: retrievedTs,
  });
  assert.equal(known.status, 'MATURED');
  assert.equal(known.outcomeInput.knownAtTs, retrievedTs);
});

test('a permanently incomplete series is pending before the deadline and terminal missing only after it', (t) => {
  const h = rig(t);
  const anchorSec = (h.prediction.targetEndTs - h.prediction.horizonMs) / 1_000;
  const source = archiveFixture(t, h.prediction, { omitOpenSec: anchorSec + 20 * 60 });
  const pending = prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: h.prediction.targetEndTs + 9_000,
  });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.provenanceReceipt.label.horizon60m.state, 'CENSORED');
  const missing = prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: h.prediction.targetEndTs + 10_001,
  });
  assert.equal(missing.status, 'MISSING');
  assert.equal(missing.outcomeInput.knownAtTs, h.prediction.targetEndTs + 10_001);
  assert.match(missing.outcomeInput.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(missing.outcomeInput.reasonCode, /^LABEL_DEADLINE_EXPIRED:/);
});

test('after a deadline-missing settlement, a later correction cannot rewrite evidence or model state', (t) => {
  const h = rig(t);
  const missingTs = h.prediction.targetEndTs + 10_001;
  const missing = prepareAdaptiveCandleOutcome({ procedure: h.procedure, prediction: h.prediction, archive: null, asOfTs: missingTs });
  h.setNow(missingTs);
  assert.equal(h.core.recordOutcome({ outcomeInput: missing.outcomeInput, provenanceReceipt: missing.provenanceReceipt }).status, 'APPENDED_NO_UPDATE');
  const source = archiveFixture(t, h.prediction, { retrievedTs: h.prediction.targetEndTs + 20_000 });
  const correction = prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: h.prediction.targetEndTs + 20_000,
  });
  assert.equal(correction.status, 'MATURED');
  h.setNow(h.prediction.targetEndTs + 20_000);
  assert.throws(() => h.core.recordOutcome({ outcomeInput: correction.outcomeInput, provenanceReceipt: correction.provenanceReceipt }), /OUTCOME_CONFLICT/);
  assert.equal(h.store.state().sequence, 0);
  assert.equal(h.store.status().outcomeCount, 1);
});

test('tampered predictions and rehashed receipt content fail closed', (t) => {
  const h = rig(t); const source = archiveFixture(t, h.prediction);
  const tamperedPrediction = { ...h.prediction, targetEndTs: h.prediction.targetEndTs + 60_000 };
  assert.throws(() => prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: tamperedPrediction, archive: source.archive,
    asOfTs: h.prediction.targetEndTs,
  }), /prediction .*mismatch/);
  const prepared = prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: h.prediction.targetEndTs,
  });
  const changed = JSON.parse(JSON.stringify(prepared.provenanceReceipt));
  changed.label.horizon60m.logReturnPct *= -1;
  changed.labelDigest = canonicalDigest(changed.label);
  changed.receiptDigest = canonicalDigest(Object.fromEntries(Object.entries(changed).filter(([key]) => !['receiptId', 'receiptDigest'].includes(key))));
  changed.receiptId = `aclr-${changed.receiptDigest.slice(0, 40)}`;
  assert.equal(adaptiveCandleOutcomeReceiptError(changed, h.procedure, h.prediction), null, 'a detached self-consistent receipt is identity, not source authentication');
  assert.match(adaptiveCandleOutcomeReceiptError(changed, h.procedure, h.prediction, { archive: source.archive }), /does not match supplied archive/);
  assert.match(adaptiveCandleOutcomeSubmissionError({ outcomeInput: prepared.outcomeInput, provenanceReceipt: changed }, h.procedure, h.prediction), /does not exactly project/);
  assert.throws(() => prepareAdaptiveCandleOutcome({
    procedure: h.procedure, prediction: h.prediction, archive: source.archive,
    asOfTs: h.prediction.recordedTs - 1,
  }), /asOfTs precedes/);
});

test('self-consistent receipt hashes cannot legitimize contradictory source, availability, reference, or known-at claims', (t) => {
  const cases = [
    {
      name: 'an absent source with a known label',
      mutate(receipt) {
        receipt.sourceIdentity = {
          state: 'ABSENT_AT_POLL', manifestSha256: null, schemaVersion: null,
          childhoodVersion: null, archiveCreatedTsMs: null,
          limitations: ['ARCHIVE_ABSENT'],
        };
      },
      error: /known label requires a present archive source/,
    },
    {
      name: 'an unavailable availability state with a known label',
      mutate(receipt) {
        receipt.label.availability = { state: 'UNAVAILABLE', reason: 'ARCHIVE_ABSENT' };
      },
      error: /unavailable label states\/reasons disagree/,
    },
    {
      name: 'a different reference candle',
      mutate(receipt) { receipt.label.reference.barOpenSec += 60; },
      error: /known reference bar does not match the sealed anchor/,
    },
    {
      name: 'a reference first known after preparation',
      mutate(receipt) {
        receipt.label.reference.knownAtTs = receipt.preparedTs + 1;
        receipt.label.horizon60m.outcomeKnownAtTs = receipt.preparedTs + 1;
      },
      error: /known reference was unavailable when the receipt was prepared/,
    },
    {
      name: 'a present source without its archive creation clock',
      mutate(receipt) { receipt.sourceIdentity.archiveCreatedTsMs = null; },
      error: /present source identity or archive creation clock malformed/,
    },
    {
      name: 'a source created after receipt preparation',
      mutate(receipt) { receipt.sourceIdentity.archiveCreatedTsMs = receipt.preparedTs + 1; },
      error: /archive source was unavailable when the receipt was prepared/,
    },
    {
      name: 'a source created after the claimed reference knowledge time',
      mutate(receipt) { receipt.label.reference.knownAtTs = receipt.label.anchorTsMs; },
      error: /archive creation clock follows a claimed label knowledge clock/,
    },
    {
      name: 'a reference claimed known before its close anchor',
      mutate(receipt) { receipt.label.reference.knownAtTs = receipt.label.anchorTsMs - 1; },
      error: /known reference clock precedes its sealed close anchor/,
    },
    {
      name: 'an unknown availability state',
      mutate(receipt) { receipt.label.availability.state = 'AVAILABLEISH'; },
      error: /label identity, target, state, or reason malformed/,
    },
    {
      name: 'a known horizon carrying a missing-data reason',
      mutate(receipt) { receipt.label.horizon60m.reason = 'INTERIOR_BAR_MISSING'; },
      error: /known 60m label malformed/,
    },
  ];

  for (const scenario of cases) {
    const h = rig(t); const source = archiveFixture(t, h.prediction);
    const prepared = prepareAdaptiveCandleOutcome({
      procedure: h.procedure, prediction: h.prediction, archive: source.archive,
      asOfTs: h.prediction.targetEndTs,
    });
    const receipt = clone(prepared.provenanceReceipt);
    scenario.mutate(receipt);
    rehashReceipt(receipt);
    const submission = {
      outcomeInput: { ...prepared.outcomeInput, sourceDigest: receipt.receiptDigest },
      provenanceReceipt: receipt,
    };
    const error = adaptiveCandleOutcomeReceiptError(receipt, h.procedure, h.prediction);
    assert.match(error, scenario.error, scenario.name);
    const before = h.store.status();
    h.setNow(h.prediction.targetEndTs);
    assert.throws(
      () => h.core.recordOutcome(submission),
      (caught) => caught?.code === 'OUTCOME_PROVENANCE_INVALID',
      scenario.name,
    );
    const after = h.store.status();
    assert.equal(after.eventCount, before.eventCount, `${scenario.name}: no event appended`);
    assert.equal(after.outcomeCount, 0, `${scenario.name}: no outcome admitted`);
    assert.equal(after.stateSequence, 0, `${scenario.name}: no model update credited`);
  }
});
