import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpportunityAuditWideEyePort } from '../learning/opportunity-audit-wideeye-port.js';
import { openOpportunityAuditStore } from '../learning/opportunity-audit-store.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'cobra-audit-wideeye-port-'));
const component = Object.freeze({ componentId: 'wideeye', version: 'wideeye-sweep-population-1', configDigest: 'a'.repeat(64) });

function acceptedCatalog() {
  const result = normalizeKrakenAssetPairs({
    XXBTZUSD: { status: 'online', quote: 'ZUSD', wsname: 'XBT/USD', base: 'XXBT' },
    XETHZUSD: { status: 'online', quote: 'ZUSD', wsname: 'ETH/USD', base: 'XETH' },
    SOLUSD: { status: 'online', quote: 'USD', wsname: 'SOL/USD', base: 'SOL' },
  }, { observedTs: T0 - 1_000 });
  assert.equal(result.ok, true); return result.catalog;
}
function catalogSnapshot(catalog = acceptedCatalog()) {
  return { status: 'ACCEPTED', contentId: catalog.contentId, observedTs: catalog.observedTs, fresh: true, catalog };
}
function evaluated(coin, overrides = {}) {
  return {
    coin, evaluated: true, zVol: 2.1, zRet: 1.3, extension: 0.8,
    preCooldownVerdict: 'RIPPLE', cooldownSuppressed: false, noticeEmitted: true,
    usdVol24h: 1_000_000, inDeepTape: false, ...overrides,
  };
}
function sweep(catalog, rows) {
  return { sweepId: 'ws-test-1', catalogContentId: catalog.contentId, observedTs: T0 + 2_000, rows };
}

test('two-phase real-store composition seals a census before ticker facts and annotates evaluated, warmup and missing rows without inventing nomination', async () => {
  const dir = tempDir(); let now = T0 + 2_000;
  try {
    const catalog = acceptedCatalog(); const store = openOpportunityAuditStore({ rootDir: dir, clock: () => now });
    const port = createOpportunityAuditWideEyePort({
      store, sampleSize: 3, horizonsMs: [HOUR], minFrameIntervalMs: 15 * 60_000,
      wideEyeComponent: component, clock: () => now,
    });
    const token = await port.beforeSweep({ catalogSnapshot: catalogSnapshot(catalog), frameTs: T0 });
    const durableBeforeTicker = await store.loadFrame(token.frameId);
    assert.equal(durableBeforeTicker.frame.sampling.sampleSize, 3);
    assert.equal(durableBeforeTicker.frame.sampling.designInferenceEligible, true);
    assert.equal(durableBeforeTicker.annotations.length, 0);
    assert.equal((await port.beforeSweep({ catalogSnapshot: catalogSnapshot(catalog), frameTs: T0 })).tokenDigest, token.tokenDigest, 'same live slot reuses the durable token and never redraws');

    now = T0 + 61_000;
    const observation = sweep(catalog, [
      evaluated('BTC'),
      { coin: 'ETH', evaluated: false, reason: 'INSUFFICIENT_SERIES' },
      // SOL is deliberately absent: selected missing rows must remain visible.
    ]);
    const receipt = await port.afterSweep({ auditToken: token, observation, recordedTs: T0 + 3_000 });
    assert.equal(receipt.status, 'ANNOTATED'); assert.equal(receipt.annotationsPresent, 3);
    assert.equal(receipt.missingSelectedRows, 1); assert.equal(receipt.unevaluatedSelectedRows, 1);
    assert.equal(receipt.actionPropensity.state, 'NOT_LOGGED'); assert.equal(receipt.trainingAuthority, 'NONE');
    const durable = await store.loadFrame(token.frameId);
    const btc = durable.annotations.find((row) => row.observation.state === 'EVALUATED');
    assert.ok(btc.observation.evidence.evidenceDigest);
    assert.equal(btc.observation.evidence.features.find((f) => f.name === 'noticeEmitted').value, true);
    assert.equal(btc.nomination.state, 'UNAVAILABLE', 'notice/RIPPLE is not nomination');
    assert.equal(btc.decision.state, 'UNAVAILABLE');
    assert.equal(durable.annotations.some((row) => row.observation.state === 'INSUFFICIENT_SERIES'), true);
    assert.equal(durable.annotations.some((row) => row.observation.reasonCode === 'SWEEP_ROW_MISSING'), true);
    assert.equal(durable.annotations.every((row) => row.actionPropensity.state === 'NOT_LOGGED'), true);

    now = T0 + 61_000;
    assert.equal(await port.beforeSweep({ catalogSnapshot: catalogSnapshot(catalog), frameTs: T0 + 60_000 }), null, 'cadence skip is not an error that disables the collector');
    assert.equal(port.status().cadenceSkips, 1);
    await store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart restores durable cadence without redraw and the durable token resumes an incomplete prior frame idempotently', async () => {
  const dir = tempDir(); let now = T0 + 2_000;
  try {
    const catalog = acceptedCatalog(); let store = openOpportunityAuditStore({ rootDir: dir, clock: () => now });
    let port = createOpportunityAuditWideEyePort({ store, sampleSize: 2, horizonsMs: [HOUR], wideEyeComponent: component, clock: () => now });
    const token = await port.beforeSweep({ catalogSnapshot: catalogSnapshot(catalog), frameTs: T0 });
    await store.close();

    now = T0 + 61_000;
    store = openOpportunityAuditStore({ rootDir: dir, clock: () => now });
    port = createOpportunityAuditWideEyePort({ store, sampleSize: 2, horizonsMs: [HOUR], wideEyeComponent: component, clock: () => now });
    assert.equal(port.status().lastFrameTs, T0);
    assert.equal(await port.beforeSweep({ catalogSnapshot: catalogSnapshot(catalog), frameTs: T0 + 60_000 }), null, 'restart inside the durable cadence window skips without a new seed/frame');
    assert.equal(store.status().frameCount, 1);
    await assert.rejects(port.beforeSweep({ catalogSnapshot: catalogSnapshot(catalog), frameTs: T0 - 1 }), { code: 'FRAME_CLOCK_REGRESSION' });
    const rows = catalog.markets.map((market) => evaluated(market.base, { preCooldownVerdict: null, noticeEmitted: false, zVol: null }));
    const receipt = await port.afterSweep({ auditToken: token, observation: sweep(catalog, rows), recordedTs: T0 + 3_000 });
    assert.equal(receipt.annotationsPresent, 2, 'an externally retained exact token can finish the durable prior frame after restart');
    assert.equal(receipt.status, 'ANNOTATED');
    await store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('whole sweep validates before writes and a bounded mid-write failure leaves honest partial state that exact retry completes', async () => {
  const dir = tempDir(); let now = T0 + 2_000;
  try {
    const catalog = acceptedCatalog(); const real = openOpportunityAuditStore({ rootDir: dir, clock: () => now });
    let calls = 0; let failSecond = true;
    const store = {
      createFrame: (...args) => real.createFrame(...args), loadFrame: (...args) => real.loadFrame(...args),
      status: () => real.status(),
      appendAnnotation: (...args) => {
        calls += 1;
        if (failSecond && calls === 2) { failSecond = false; return Promise.reject(Object.assign(new Error('INJECTED_BOUNDED_WRITE_FAILURE'), { code: 'STORE_IO' })); }
        return real.appendAnnotation(...args);
      },
    };
    const port = createOpportunityAuditWideEyePort({ store, sampleSize: 3, horizonsMs: [HOUR], wideEyeComponent: component, clock: () => now });
    const token = await port.beforeSweep({ catalogSnapshot: catalogSnapshot(catalog), frameTs: T0 });
    now = T0 + 10_000;
    const invalid = sweep(catalog, [evaluated('BTC'), evaluated('BTC')]);
    await assert.rejects(port.afterSweep({ auditToken: token, observation: invalid, recordedTs: T0 + 3_000 }), { code: 'SWEEP_OBSERVATION_INVALID' });
    assert.equal((await real.loadFrame(token.frameId)).annotations.length, 0, 'invalid whole input cannot leave a partial annotation prefix');

    const valid = sweep(catalog, catalog.markets.map((market) => evaluated(market.base, { preCooldownVerdict: null, noticeEmitted: false })));
    await assert.rejects(port.afterSweep({ auditToken: token, observation: valid, recordedTs: T0 + 3_000 }), /INJECTED_BOUNDED_WRITE_FAILURE/);
    assert.equal((await real.loadFrame(token.frameId)).annotations.length, 1, 'write failure is visible as an incomplete durable frame');
    const repaired = await port.afterSweep({ auditToken: token, observation: valid, recordedTs: T0 + 3_000 });
    assert.equal(repaired.annotationsPresent, 3); assert.equal((await real.loadFrame(token.frameId)).annotations.length, 3);
    assert.equal((await port.afterSweep({ auditToken: token, observation: valid, recordedTs: T0 + 3_000 })).status, 'EXISTING_COMPLETE');
    await real.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
