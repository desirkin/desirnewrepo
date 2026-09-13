import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { annotateAuditOpportunity, attachAuditOutcome, sealAuditFrame, sealAuditObservationEvidence } from '../learning/opportunity-audit.js';
import { openOpportunityAuditStore } from '../learning/opportunity-audit-store.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'cobra-opportunity-audit-'));

function catalog() {
  const result = normalizeKrakenAssetPairs({
    XXBTZUSD: { status: 'online', quote: 'ZUSD', wsname: 'XBT/USD', base: 'XXBT' },
    XETHZUSD: { status: 'online', quote: 'ZUSD', wsname: 'ETH/USD', base: 'XETH' },
    SOLUSD: { status: 'online', quote: 'USD', wsname: 'SOL/USD', base: 'SOL' },
  }, { observedTs: T0 - 1_000 });
  assert.equal(result.ok, true); return result.catalog;
}
function makeFrame(seedHex = '11'.repeat(32)) {
  return sealAuditFrame({ catalog: catalog(), frameTs: T0, knownAtTs: T0 - 500, sampleSize: 2, seedHex, horizonsMs: [HOUR, 2 * HOUR] });
}
function annotation(frame) {
  const opportunityId = frame.selectedOpportunityIds[0];
  const evidence = sealAuditObservationEvidence({
    sourceId: 'wideeye-sweep-1', sourceDigest: 'e'.repeat(64), featureRecipeVersion: 'wideeye-features-1',
    features: [{ name: 'zRet', value: 1.25, unit: 'ZSCORE', availability: 'KNOWN' }],
  });
  return annotateAuditOpportunity({
    frame, opportunityId, recordedTs: T0 + 2_000,
    observation: { state: 'EVALUATED', reasonCode: null, knownAtTs: T0 + 1_000, evidence },
    nomination: { state: 'REJECTED', reasonCode: 'NOT_EARLY' },
    decision: { state: 'NOT_REACHED', reasonCode: 'NOMINATION_REJECTED' },
    components: [],
  });
}

test('store durably creates, CAS-appends, follows missing outcomes, paginates pending work and restarts', async () => {
  const root = tempDir(); let now = T0 + 10_000; const clock = () => now;
  try {
    const frame = makeFrame(); let store = openOpportunityAuditStore({ rootDir: root, clock });
    let view = await store.createFrame({ frame });
    assert.equal(view.status, 'CREATED'); assert.equal(view.revision, 0);
    assert.deepEqual(view.durability, { scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN' });
    assert.equal((await store.createFrame({ frame })).status, 'EXISTING');
    await assert.rejects(store.createFrame({ frame: makeFrame('22'.repeat(32)) }), { code: 'FRAME_SLOT_CONFLICT' });

    const note = annotation(frame); now = T0 + 20_000;
    view = await store.appendAnnotation({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 0, annotation: note });
    assert.equal(view.status, 'APPENDED'); assert.equal(view.revision, 1);
    assert.equal((await store.appendAnnotation({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 0, annotation: note })).status, 'EXISTING');

    const before = await store.pending({ asOfTs: T0 + HOUR - 1, limit: 20 });
    assert.equal(before.items.length, 0);
    const due = await store.pending({ asOfTs: T0 + 2 * HOUR, limit: 2 });
    assert.equal(due.items.length, 2); assert.equal(due.truncated, true); assert.ok(due.nextCursor);
    assert.equal(due.items.every((row) => row.actionPropensity.state === 'NOT_LOGGED'), true);
    const nextPage = await store.pending({ asOfTs: T0 + 2 * HOUR, limit: 20, cursor: due.nextCursor });
    assert.equal(nextPage.items.length, 2); assert.equal(nextPage.truncated, false);

    const target = due.items[0]; now = T0 + 2 * HOUR + 10_000;
    const pending = attachAuditOutcome({ frame, opportunityId: target.opportunityId, horizonMs: target.horizonMs, status: 'PENDING', recordedTs: now });
    view = await store.appendOutcome({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 1, outcome: pending });
    assert.equal(view.revision, 2);
    const afterPending = await store.pending({ asOfTs: now, limit: 20 });
    assert.equal(afterPending.items.find((row) => row.cursor === target.cursor).lastStatus, 'PENDING');

    now += 1_000;
    const missing = attachAuditOutcome({
      frame, opportunityId: target.opportunityId, horizonMs: target.horizonMs, status: 'MISSING',
      recordedTs: now, outcomeKnownAtTs: now, missingReason: 'CONTEMPORANEOUS_ARCHIVE_MISSING', supersedes: pending.outcomeId,
    });
    view = await store.appendOutcome({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 2, outcome: missing });
    assert.equal(view.revision, 3);
    await assert.rejects(store.appendOutcome({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 3,
      outcome: attachAuditOutcome({ frame, opportunityId: target.opportunityId, horizonMs: target.horizonMs, status: 'PENDING', recordedTs: now + 1 }) }), { code: 'OUTCOME_CONFLICT' });
    const afterMissing = await store.pending({ asOfTs: now, limit: 20 });
    assert.equal(afterMissing.items.some((row) => row.cursor === target.cursor), false, 'missing is retained as terminal, never backfilled as an unseen success');
    assert.equal(store.status().pendingTargets, 3);
    await store.close();

    store = openOpportunityAuditStore({ rootDir: root, clock });
    const restored = await store.loadFrame(frame.frameId);
    assert.equal(restored.revision, 3); assert.equal(restored.annotations.length, 1); assert.equal(restored.outcomes.length, 2);
    assert.equal(restored.outcomes.at(-1).status, 'MISSING');
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('revision/content conflicts cannot rewrite a frame or rejected annotation', async () => {
  const root = tempDir(); let now = T0 + 10_000;
  try {
    const frame = makeFrame(); const store = openOpportunityAuditStore({ rootDir: root, clock: () => now });
    await store.createFrame({ frame }); const original = annotation(frame); now += 1_000;
    await store.appendAnnotation({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 0, annotation: original });
    const conflicting = annotateAuditOpportunity({
      frame, opportunityId: original.opportunityId, recordedTs: T0 + 2_000,
      observation: original.observation, nomination: { state: 'NOMINATED', reasonCode: null },
      decision: { state: 'ACCEPTED', reasonCode: null }, components: [],
    });
    await assert.rejects(store.appendAnnotation({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 1, annotation: conflicting }), { code: 'ANNOTATION_CONFLICT' });
    const other = frame.selectedOpportunityIds[1];
    const second = annotateAuditOpportunity({
      frame, opportunityId: other, recordedTs: T0 + 2_000,
      observation: { state: 'MISSING_TICKER', reasonCode: 'NO_TICKER_ROW', knownAtTs: T0 + 1_000, evidence: null },
      nomination: { state: 'NOT_NOMINATED', reasonCode: 'NO_TICKER_ROW' }, decision: { state: 'NOT_REACHED', reasonCode: 'NO_TICKER_ROW' }, components: [],
    });
    await assert.rejects(store.appendAnnotation({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 0, annotation: second }), { code: 'REVISION_CONFLICT' });
    assert.equal((await store.loadFrame(frame.frameId)).annotations.length, 1);
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lock loss fences a partial mutation and on-disk tampering refuses restart', async () => {
  const root = tempDir(); let now = T0 + 10_000;
  try {
    const frame = makeFrame(); const store = openOpportunityAuditStore({ rootDir: root, clock: () => now });
    await store.createFrame({ frame });
    const stateFile = path.join(root, `${frame.frameId}.json`);
    const before = readFileSync(stateFile, 'utf8');
    writeFileSync(path.join(root, 'writer.lock'), JSON.stringify({ forged: true }));
    now += 1_000;
    await assert.rejects(store.appendAnnotation({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: 0, annotation: annotation(frame) }), { code: 'LOCK_LOST' });
    assert.equal(readFileSync(stateFile, 'utf8'), before, 'failed custody check leaves the last durable state untouched');
    assert.equal(store.status().failed.code, 'LOCK_LOST');
    await assert.rejects(store.loadFrame(frame.frameId), { code: 'STORE_LATCHED' });

    rmSync(path.join(root, 'writer.lock'), { force: true });
    const parsed = JSON.parse(before); parsed.revision = 9;
    writeFileSync(stateFile, JSON.stringify(parsed));
    assert.throws(() => openOpportunityAuditStore({ rootDir: root, clock: () => now }), (error) => error.code === 'STORE_CORRUPT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restart rejects a rehashed-looking but untrusted modified state', async () => {
  const root = tempDir();
  try {
    const frame = makeFrame(); const store = openOpportunityAuditStore({ rootDir: root, clock: () => T0 + 10_000 });
    await store.createFrame({ frame }); await store.close();
    const stateFile = path.join(root, `${frame.frameId}.json`);
    const value = JSON.parse(readFileSync(stateFile, 'utf8'));
    value.frame.trainingAuthority = 'PAPER';
    writeFileSync(stateFile, `${JSON.stringify(value)}\n`);
    assert.throws(() => openOpportunityAuditStore({ rootDir: root, clock: () => T0 + 20_000 }), /STORE_CORRUPT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
