// Owner acceptance tests, revision 2. No live provider/model/DB calls.
// External run: COBRA_REPAIR_SOURCE_ROOT=/absolute/repo node --test --test-concurrency=1 THIS_FILE
// Repository destination: test/market-socrates-remaining-owner.test.js (same bytes).
// These tests require repaired behavior; a RED baseline is expected and documented.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renameSync, mkdirSync, rmdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
const ROOT = process.env.COBRA_REPAIR_SOURCE_ROOT
  ? path.resolve(process.env.COBRA_REPAIR_SOURCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = p => import(pathToFileURL(path.join(ROOT, p)).href);
const { T0, tmp, H, cryptoquantPolicy, cryptoquantFetch, btcOnly, json } = await mod('test/helpers/market-closeout.js');
const { loadPolicy } = await mod('market-lab/policy.js');
const { PROVIDER_IDS, FAMILIES, canonicalDigest, sha256Hex } = await mod('market-lab/contracts.js');
const { providerReadiness, liveReadinessManifest } = await mod('market-lab/readiness.js');
const { openBudgetJournal } = await mod('socrates/budget.js');
const { createResearchOwner } = await mod('market-lab/owner.js');
const { createBroker } = await mod('socrates/broker.js');
const { runBuild, readContext, readCapture } = await mod('market-lab/commands.js');
const { contextError, contextIdentity, COMPONENT_KEYS } = await mod('market-lab/context.js');
const { manifestIdentity } = await mod('market-lab/store.js');
const PRICING = { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 };
const CAPS = { maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 1, maxEstimatedUsdPerMonth: 1, totalSmokeMaxEstimatedUsd: 1 };
const USAGE = { inputTokens: 100000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const reserve = (j, id, amount = 1) => j.reserve({ reservationId: id, caseId: id, attemptId: id,
  estimatedUsd: amount, inputTokens: Math.round(amount * 1e6), maxOutputTokens: 0, pricing: PRICING, caps: CAPS });
const noSmokeRows = () => providerReadiness({ policy: loadPolicy(H.policyWith({ providers: [] })),
  testReport: Object.fromEntries(PROVIDER_IDS.map(id => [id, 'PASSED'])) });

test('OA-C01 control: no family evidence is not readiness green', () => {
  const r = liveReadinessManifest({ rows: noSmokeRows(), familyCoverage: {}, generatedTs: T0,
    modelReadiness: { liveVerification: 'PASSED' } });
  assert.notEqual(r.overall, 'READINESS_GREEN');
});

test('OA-C02 control: successful lower-cost budget settlement survives restart', () => {
  const dir = tmp('oa-budget-good-'); let j;
  try {
    j = openBudgetJournal({ dir, clock: () => T0 }); assert.equal(reserve(j, 'first').ok, true);
    j.settle({ reservationId: 'first', usage: USAGE, pricing: PRICING });
    assert.equal(j.totals().dayUsd, 0.1); j.close(); j = openBudgetJournal({ dir, clock: () => T0 });
    assert.equal(j.totals().dayUsd, 0.1); assert.equal(reserve(j, 'second', 0.9).ok, true);
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('OA-P1: unbound obtained counts must not manufacture live readiness', () => {
  const r = liveReadinessManifest({ rows: noSmokeRows(), generatedTs: T0,
    familyCoverage: Object.fromEntries(FAMILIES.map(f => [f, { obtained: 1 }])),
    modelReadiness: { liveVerification: 'PASSED' } });
  assert.notEqual(r.overall, 'READINESS_GREEN', 'counts without provider/metric/asset/coverage proof cannot qualify');
});

test('OA-P2: failed settlement persistence cannot reopen spending allowance', () => {
  const dir = tmp('oa-budget-fail-'); let j; let after; let restartTotals;
  let furtherAccepted = false;
  try {
    j = openBudgetJournal({ dir, clock: () => T0 }); assert.equal(reserve(j, 'first').ok, true);
    assert.equal(reserve(j, 'before-failure').ok, false);
    const p = j.files.journalFile; renameSync(p, p + '.saved'); mkdirSync(p);
    try {
      assert.throws(() => j.settle({ reservationId: 'first', usage: USAGE, pricing: PRICING }),
        e => e.code === 'IO_FAILURE', 'must reach the intended real append-open failure');
    } finally { rmdirSync(p); renameSync(p + '.saved', p); }
    // A latched failed journal may reject reads as well as reservations. Never treat that as zero.
    try { after = j.totals().dayUsd; } catch(e) {
      assert.ok(['IO_FAILURE', 'PERMISSION_FAILURE', 'ACCOUNTING_UNAVAILABLE'].includes(e.code)); after = null;
    }
    try { furtherAccepted = reserve(j, 'second', 0.9).ok === true; } catch(e) {
      assert.ok(['IO_FAILURE', 'PERMISSION_FAILURE', 'ACCOUNTING_UNAVAILABLE'].includes(e.code));
    }
    j.close(); j = openBudgetJournal({ dir, clock: () => T0 }); restartTotals = j.totals();
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
  assert.equal(furtherAccepted, false, 'failed durability must block new allowance');
  assert.ok(after === null || after >= 1, 'uncommitted settlement must not lower the authoritative total');
  assert.equal(restartTotals.dayUsd, 1, 'the sole original reservation remains conservatively charged');
});

test('OA-P3: provider completion after bounded stop cannot enter an already sealed capture', { timeout: 5000 }, async () => {
  const dir = tmp('oa-owner-stop-'); const cap = path.join(dir, 'capture');
  let enteredResolve, releaseResolve; const entered = new Promise(r => { enteredResolve = r; });
  const held = new Promise(r => { releaseResolve = r; }); let own, pending;
  let atStop, after, durable, late;
  try {
    const response = cryptoquantFetch();
    own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(),
      env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir,
      // Add this bounded test seam to owner; default remains 10,000 ms. Zero means fence at deadline now.
      closeDrainMs: 0,
      fetchImpl: async (url) => { enteredResolve(); await held; return response(url); } });
    await own.start({ outDir: cap, families: [] });
    pending = own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] })
      .then(v => ({ observations: v.observations?.length ?? 0 }), e => ({ error: e.code ?? e.name, observations: 0 }));
    await entered; await own.stop({ seal: true }); atStop = own.observations().length;
    releaseResolve(); late = await pending;
    await new Promise(resolve => setImmediate(resolve));
    after = own.observations().length; durable = readCapture(cap).observations.length;
  } finally {
    releaseResolve?.(); if (pending) await pending;
    await own?.stop({ seal: false }); rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(after, atStop, 'retained observations must not grow after stop completes');
  assert.equal(after, durable, 'this untruncated fixture must agree with the sealed capture');
  assert.equal(late.observations, 0, 'late work must not claim admitted observations');
});

async function dailyFixture() {
  const dir = tmp('oa-daily-'); const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(),
    env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir,
    fetchImpl: cryptoquantFetch() });
  try {
    const r = await own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] });
    const points = r.observations.filter(o => o.payload.metricId === 'active_addresses');
    assert.equal(points.length, 2); return points;
  } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
}
const history = points => createBroker({ owner: { observations: () => points, coverage: () => [],
  acquire: async () => { throw Error('fixture replay must not acquire'); } }, policy: cryptoquantPolicy(),
  clock: () => T0, mode: 'REPLAY_AS_OF' }).resolve({ requestKey: 'Q1', requestKind: 'HISTORY', family: 'NETWORK_ACTIVITY',
  metricIds: ['active_addresses'], subjectRef: 'BTC', windowStartTs: T0 - 30 * 86400000, windowEndTs: T0,
  requestedMaxAgeMs: null, hypothesisRefs: [], question: 'Daily history?', interpretationIfSupported: 'x',
  interpretationIfContradicted: 'y' }, { analysisId: 'soc2-' + 'a'.repeat(40),
  caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs: T0, deadlineTs: T0 + 60000 });

test('OA-P4a: two daily points without interval coverage do not satisfy thirty days', async () => {
  const r = await history(await dailyFixture()); assert.notEqual(r.state, 'SATISFIED');
});
test('OA-P4b: repeating one observation cannot supply missing history support', async () => {
  const [p] = await dailyFixture(); assert.notEqual((await history([p])).state, 'SATISFIED');
  assert.notEqual((await history([p, p])).state, 'SATISFIED');
});

async function contextFixture() {
  const dir = tmp('oa-context-'); const cap = path.join(dir, 'capture'); const ctxDir = path.join(dir, 'context');
  const schedules = []; const timers = { setInterval: (fn, ms) => {
    const x = { fn, ms, unref() {} }; schedules.push(x); return x;
  }, clearInterval() {}, setTimeout, clearTimeout };
  const own = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })),
    subjects: btcOnly(), clock: () => T0, mode: 'INTEGRATED', researchRoot: dir, timers,
    fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS) });
  try {
    await own.start({ outDir: cap, families: [] });
    own.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: T0, synced: true, checksumVerified: true,
      pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2]], asks: [[100.5, 2]] }) });
    for (const s of schedules) if (s.ms === 250) s.fn(); await own.stop({ seal: true });
    runBuild({ captureDir: cap, asOfTs: T0, canonicalCoin: 'BTC', out: ctxDir });
    readContext(ctxDir);
    return { dir, ctxDir, base: JSON.parse(readFileSync(path.join(ctxDir, 'context.json'), 'utf8')) };
  } catch(e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  finally { await own.stop({ seal: false }); }
}
function reseal(fx, change) {
  const c = structuredClone(fx.base); change(c);
  for (const fam of Object.values(c.families)) for (const comp of fam.components) {
    const content = Object.fromEntries(COMPONENT_KEYS.filter(k => k !== 'componentId').map(k => [k, comp[k]]));
    comp.componentId = 'mcc-' + canonicalDigest(content).slice(0, 40);
  }
  c.contextId = contextIdentity(c); const text = JSON.stringify(c, null, 1) + '\n';
  const mfPath = path.join(fx.ctxDir, 'manifest.json'); const m = JSON.parse(readFileSync(mfPath, 'utf8'));
  const member = m.members.find(m => m.name === 'context.json'); member.bytes = Buffer.byteLength(text);
  member.sha256 = sha256Hex(Buffer.from(text)); m.summary.contextId = c.contextId; m.bundleId = manifestIdentity(m);
  writeFileSync(path.join(fx.ctxDir, 'context.json'), text); writeFileSync(mfPath, JSON.stringify(m, null, 1) + '\n');
  return c;
}
const spread = c => c.families.DISPLAYED_LIQUIDITY.components.find(c => c.metricId === 'spread_bps');
test('OA-C03 control: real capture builds and reopens a lawful context', async () => {
  const fx = await contextFixture(); try { assert.equal(contextError(fx.base), null); readContext(fx.ctxDir); }
  finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
for (const [name, change] of [
  ['OA-P5a: negative displayed quantity rejected by the actual saved reader', c => { spread(c).value.topBidQty = -1; }],
  ['OA-P5b: string input count rejected by the actual saved reader', c => { spread(c).inputObservationCount = String(spread(c).inputObservationCount); }],
  ['OA-P5c: undeclared family text rejected by the actual saved reader', c => { c.families.DISPLAYED_LIQUIDITY.text = 'AUDIT_RAW_CONTENT_SENTINEL'; }],
]) test(name, async () => {
  const fx = await contextFixture(); try {
    const c = reseal(fx, change);
    assert.throws(() => readContext(fx.ctxDir), e => ['INVALID_INPUT', 'VALIDATION_FAILURE', 'CORRUPT_INPUT'].includes(e.code)
      && !/checksum|sha256|digest|does not match content|bundleId|byte size/i.test(e.message),
    'rejection must be semantic, after correctly resealed hashes');
    assert.notEqual(contextError(c), null, 'shared pure validator must enforce the same law');
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
test('OA-P5d: pure schema cannot treat an inherited property name as declared', async () => {
  const fx = await contextFixture(); try {
    const c = reseal(fx, c => { spread(c).value.constructor = { text: 'AUDIT_RAW_CONTENT_SENTINEL' }; });
    assert.notEqual(contextError(c), null, 'saved JSON hazard rejection alone does not close the pure boundary');
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});
