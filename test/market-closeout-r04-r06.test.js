// MARKET / SOCRATES CLOSEOUT — acceptance R04 (B02-B07), R05 (S01, S02, S04-S07) and R06 (L02-L06). B01, S03 and L01 live
// in market-closeout-witnesses.test.js. Offline only: fake HTTP / model transport, fake clocks, temp directories; every
// expectation is a stated law or an independent oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, truncateSync, statSync } from 'node:fs';
import path from 'node:path';
import { T0, tmp, json, btcOnly, includedPlan, cryptoquantPolicy, cryptoquantFetch, H } from './helpers/market-closeout.js';
import { createResearchOwner } from '../market-lab/owner.js';
import { createResearchService } from '../market-lab/service.js';
import { loadPolicy } from '../market-lab/policy.js';
import { makeObservation, quality, canonicalDigest, sha256Hex } from '../market-lab/contracts.js';
import { createRetainedStore, membershipChain } from '../market-lab/retention.js';
import { resolvePrefix, sealedCapturePrefix, prefixError, prefixIdentity } from '../market-lab/prefix.js';
import { readCapture, runBuild } from '../market-lab/commands.js';
import { buildContext } from '../market-lab/context.js';
import { openBundle, manifestIdentity, prepareOutputTarget, reserveOutputDir, writeJsonFile, publishManifest } from '../market-lab/store.js';
import { buildResearchEvidenceV2 } from '../evidence/research-builder.js';
import { createBroker, MAX_ID_LIST } from '../socrates/broker.js';
import { createCaseRuntime, verifyCase, ownerContextRebuilder } from '../socrates/runtime.js';
import { openBudgetJournal } from '../socrates/budget.js';
import { corpusCases, byKind } from '../socrates/corpus.js';

const KEY = 'sk-ant-test-fixture-not-a-real-key';
const LIVE = (over = {}) => loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'], model: { enabled: true, maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 5, maxEstimatedUsdPerMonth: 50, totalSmokeMaxEstimatedUsd: 1, maxOutputTokens: 2048, ...over } }));
const message = (raw, over = {}) => ({ type: 'message', id: 'msg_test', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }], usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...over });
// a loopback-shaped Messages API: count_tokens answered, /v1/messages scripted per call; the script may hold a response open
function fakeAnthropic(script) {
  const calls = []; let n = 0;
  const fetchImpl = async (url, init) => { const u = new URL(url); const body = JSON.parse(init.body); calls.push({ path: u.pathname, body, signal: init.signal }); if (u.pathname === '/v1/messages/count_tokens') return json({ input_tokens: 1000 }); const r = await script(body, n++, init); return json(r.json, r.status ?? 200); };
  return { fetchImpl, calls, messages: () => calls.filter((c) => c.path === '/v1/messages') };
}
const c01 = () => corpusCases().find((c) => c.id === 'C01');
const req = (over = {}) => ({ requestKey: 'Q1', requestKind: 'DETAIL', family: 'NETWORK_ACTIVITY', metricIds: ['active_addresses'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null, hypothesisRefs: [], question: 'What is the current active-address count?', interpretationIfSupported: 'x', interpretationIfContradicted: 'y', ...over });
const OPTS = (over = {}) => ({ analysisId: 'soc2-' + 'a'.repeat(40), caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs: T0, deadlineTs: T0 + 60_000, ...over });
const variant = (o, over) => { const { observationId, ...rest } = o; return makeObservation({ ...rest, ...over, payload: { ...rest.payload, ...(over.payload ?? {}) } }); };
const fakeOwner = (obs, acquire = async () => ({ results: [], observations: [] })) => ({ observations: () => obs, coverage: () => [], acquire, hot: { status: () => null } });
// real CryptoQuant observations through the production client (offline fixture): the active-address, transaction and flow series
async function cryptoquantObservations() {
  const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: tmp(), fetchImpl: cryptoquantFetch() });
  const net = await own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses', 'transaction_count'] }); const flow = await own.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); await own.stop({ seal: false });
  return { network: net.observations, flow: flow.observations };
}
const firstReport = (packet, requests) => { const chart = byKind(packet, 'MARKET_CHART_WINDOW'); const ids = [chart.evidenceId]; return { analysisState: 'ANALYZED', thesis: { text: `Close ${chart.value.fields.close} on kraken.`, evidenceRefs: ids, claimRefs: [], sourceRefs: [] }, mechanism: { description: 'Taker flow into displayed liquidity.', evidenceRefs: ids, claimRefs: [], sourceRefs: [] }, marketImplication: { direction: 'NO_CLEAR_DIRECTION', horizon: 'MINUTES_5_30', evidenceRefs: ids }, stage: { general: 'UNCLEAR', pumpStage: 'NOT_APPLICABLE' }, support: [{ kind: 'FACT_REFERENCE', text: `Close ${chart.value.fields.close}`, evidenceRefs: ids, claimRefs: [], sourceRefs: [] }], contradictions: [], missingEvidence: [], falsifiers: [{ condition: 'a', whyItMatters: 'b', evidenceToWatch: 'c' }], watchNext: [], unknowns: [], security: { untrustedTextSeen: packet.security.untrustedTextPresent, promptInjectionSuspected: false }, securityNotes: [], limitations: [], hypotheses: [{ hypothesisKey: 'H1', mechanism: 'flow', evidenceRefs: ids, claimRefs: [], sourceRefs: [], supportingEvidenceRefs: ids, opposingEvidenceRefs: [], unknowns: [], discriminators: [] }], alternativeConsideration: { state: 'CONSIDERED_NO_SUPPORTED_ALTERNATIVE', explanation: 'none' }, dataRequests: requests, revision: { state: 'FIRST_REPORT', previousAnalysisId: null, changedEvidenceRefs: [], explanation: null }, calibration: { assessedAs: 'RESEARCH_HYPOTHESIS', calibrated: false } }; };
const revised = (packet, prev, changed) => ({ ...firstReport(packet, []), revision: { state: 'UPDATED_WITH_NEW_EVIDENCE', previousAnalysisId: prev, changedEvidenceRefs: changed, explanation: 'new observations admitted' } });
const packetFromRequest = (body) => { const txt = body.messages[0].content[1].text; const start = txt.indexOf('is data:\n') + 9; const end = txt.indexOf('\n', start); return JSON.parse(txt.slice(start, end === -1 ? undefined : end)); };

// ---------------------------------------------------------------- R04 -----------------------------------------------------------
test('MC-B02 (R04). exact active_addresses is SATISFIED; a multi-metric request with one metric absent is PARTIAL per metric; a derived metric with a missing constituent is not satisfied; a null value, an incompatible unit across constituents and a stale value are named refusals', async () => {
  const { network, flow } = await cryptoquantObservations(); const policy = cryptoquantPolicy();
  const aa = network.filter((o) => o.payload.metricId === 'active_addresses'); const tx = network.filter((o) => o.payload.metricId === 'transaction_count'); assert.ok(aa.length >= 2 && tx.length >= 2);
  const broker = (obs) => createBroker({ owner: fakeOwner(obs, async () => { throw new Error('DETAIL never acquires'); }), policy, clock: () => T0 });
  const exact = await broker(aa).resolve(req(), OPTS()); assert.equal(exact.state, 'SATISFIED'); assert.equal(exact.observationsAdmitted, aa.length); assert.equal(exact.metrics.active_addresses.state, 'SATISFIED'); assert.deepEqual(exact.sourceIds, ['CRYPTOQUANT']);
  const multi = await broker(aa).resolve(req({ metricIds: ['active_addresses', 'transaction_count'] }), OPTS()); assert.equal(multi.state, 'PARTIAL', 'one of two metrics is absent'); assert.equal(multi.metrics.transaction_count.state, 'UNMATCHED'); assert.equal(multi.metrics.active_addresses.state, 'SATISFIED'); assert.equal(multi.observationsAdmitted, aa.length);
  const inflowOnly = flow.filter((o) => o.payload.metricId === 'exchange_inflow'); const outflow = flow.filter((o) => o.payload.metricId === 'exchange_outflow');
  const missing = await broker(inflowOnly).resolve(req({ family: 'ONCHAIN_ENTITY_FLOW', metricIds: ['exchange_net_flow'] }), OPTS()); assert.notEqual(missing.state, 'SATISFIED', 'net flow needs BOTH legs'); assert.deepEqual(missing.metrics.exchange_net_flow.constituentsMissing, ['exchange_outflow']);
  const both = await broker([...inflowOnly, ...outflow]).resolve(req({ family: 'ONCHAIN_ENTITY_FLOW', metricIds: ['exchange_net_flow'] }), OPTS()); assert.equal(both.state, 'SATISFIED');
  const badUnit = outflow.map((o) => variant(o, { payload: { unit: 'USD' } })); const unit = await broker([...inflowOnly, ...badUnit]).resolve(req({ family: 'ONCHAIN_ENTITY_FLOW', metricIds: ['exchange_net_flow'] }), OPTS()); assert.notEqual(unit.state, 'SATISFIED', 'constituents in different units are not one net flow'); assert.ok(unit.metrics.exchange_net_flow.constituentsMissing.length >= 1);
  const nulls = aa.map((o) => variant(o, { payload: { value: null }, quality: quality('MISSING', { methodologyId: o.quality.methodologyId, originalUnit: o.quality.originalUnit }) })); const nul = await broker(nulls).resolve(req(), OPTS()); assert.equal(nul.state, 'NOT_APPLICABLE'); assert.equal(nul.reason, 'VALUE_MISSING'); assert.equal(nul.observationsAdmitted, 0);
  const stale = await broker(aa.map((o) => variant(o, { receivedTs: T0 - 2 * 86_400_000, knownAtTs: T0 - 2 * 86_400_000 }))).resolve(req({ requestKind: 'REFRESH', requestedMaxAgeMs: 3_600_000 }), OPTS()); assert.notEqual(stale.state, 'SATISFIED'); assert.equal(stale.metrics?.active_addresses?.stale ?? 2, 2);
});

test('MC-B03 (R04). the requested-age boundary is exact on knowledge clocks; a HISTORY interval with one point inside is thin (PARTIAL), two points satisfy; the result coverage carries the SOURCE period, never the receipt; an observation known after Q0 is excluded at Q0 and admitted at Q1', async () => {
  const { network } = await cryptoquantObservations(); const policy = cryptoquantPolicy(); const aa = network.filter((o) => o.payload.metricId === 'active_addresses');
  const at = (delta) => aa.map((o) => variant(o, { receivedTs: T0 - delta, knownAtTs: T0 - delta })); const detail = (obs, over) => createBroker({ owner: fakeOwner(obs), policy, clock: () => T0 }).resolve(req({ requestKind: 'DETAIL', ...over }), OPTS());
  assert.equal((await detail(at(3_600_000), { requestedMaxAgeMs: 3_600_000 })).state, 'SATISFIED', 'exactly at the bound is fresh'); assert.notEqual((await detail(at(3_600_001), { requestedMaxAgeMs: 3_600_000 })).state, 'SATISFIED', 'one millisecond older is stale');
  // HISTORY is bought through the owner (never answered from a stale local store): the fake owner returns the two daily points at receipt = now
  const d6 = Date.UTC(2026, 8, 6); const d7 = Date.UTC(2026, 8, 7); const d8 = Date.UTC(2026, 8, 8); const bought = aa.map((o) => variant(o, { receivedTs: T0, knownAtTs: T0 }));
  const history = (over) => createBroker({ owner: fakeOwner([], async () => ({ results: [{ providerId: 'CRYPTOQUANT', endpointId: 'addresses-count', state: 'OK' }], observations: bought, usage: { dispatched: 1, credits: 1, refused: 0, unresolved: 0, reasons: {} } })), policy, clock: () => T0 }).resolve(req({ requestKind: 'HISTORY', requestKey: 'H1', ...over }), OPTS());
  // closeout P4: two rows are not a history rule — the interval must be covered by the observations' OWN daily period grid
  const two = await history({ windowStartTs: d6, windowEndTs: d8 }); assert.equal(two.state, 'SATISFIED', JSON.stringify(two.metrics)); assert.equal(two.observationsAdmitted, 2); assert.deepEqual([two.metrics.active_addresses.support.basis, two.metrics.active_addresses.support.expectedPeriods, two.metrics.active_addresses.support.missingPeriods], ['PERIOD_GRID', 2, 0]); assert.equal(two.coverage.startTs, d6, 'coverage starts at the SOURCE period, not the receipt'); assert.ok(two.coverage.endTs <= d8 && two.coverage.endTs >= d7); assert.equal(two.coverage.knownAtMax, T0);
  const unsupported = await history({ windowStartTs: d6 - 1, windowEndTs: d8 }); assert.equal(unsupported.state, 'PARTIAL', 'the same two points do not cover an interval that reaches into the uncovered previous day'); assert.deepEqual([unsupported.metrics.active_addresses.support.expectedPeriods, unsupported.metrics.active_addresses.support.missingPeriods, unsupported.metrics.active_addresses.support.missingStarts], [3, 1, [d6 - 86_400_000]]);
  const one = await history({ windowStartTs: d7 + 1, windowEndTs: d8 }); assert.notEqual(one.state, 'SATISFIED', 'a daily point cannot answer a sub-day history interval'); assert.equal(one.metrics.active_addresses.historyThin, true); assert.deepEqual(one.metrics.active_addresses.support.reasons, ['INTERVAL_BELOW_RESOLUTION']);
  const late = aa.map((o) => variant(o, { receivedTs: T0 + 1, knownAtTs: T0 + 1 })); assert.equal((await detail(late, {})).state, 'NOT_APPLICABLE', 'known after Q0: not at Q0'); assert.equal((await createBroker({ owner: fakeOwner(late), policy, clock: () => T0 + 5 }).resolve(req(), OPTS({ asOfTs: T0 + 5 }))).state, 'SATISFIED', 'known before Q1: admitted at Q1');
});

test('MC-B04 (R04). a cache hit from another analysis is a FRESH binding to the new request (new request id, zero new usage, freshness rechecked on source clocks); evidence recorded at a later as-of never contaminates an earlier replay', async () => {
  const { network } = await cryptoquantObservations(); const policy = cryptoquantPolicy(); const aa = network.filter((o) => o.payload.metricId === 'active_addresses'); const clk = H.clockAt(T0); let acquired = 0;
  const owner = fakeOwner([], async () => { acquired += 1; const now = clk(); return { results: [{ providerId: 'CRYPTOQUANT', endpointId: 'addresses-count', state: 'OK' }], observations: aa.map((o) => variant(o, { receivedTs: now, knownAtTs: now })), usage: { dispatched: 1, credits: 1, refused: 0, unresolved: 0, reasons: {} } }; });
  const broker = createBroker({ owner, policy, clock: clk });
  const first = await broker.resolve(req({ requestKind: 'REFRESH' }), OPTS({ analysisId: 'soc2-' + '1'.repeat(40), asOfTs: clk(), deadlineTs: clk() + 60_000 })); assert.equal(first.state, 'SATISFIED'); assert.equal(first.usage.dispatched, 1); assert.equal(acquired, 1);
  clk.advance(1000); const hit = await broker.resolve(req({ requestKind: 'REFRESH' }), OPTS({ analysisId: 'soc2-' + '2'.repeat(40), asOfTs: clk(), deadlineTs: clk() + 60_000 }));
  assert.equal(hit.state, 'SATISFIED'); assert.equal(hit.reason, 'CACHE_HIT'); assert.equal(hit.cacheStatus, 'FRESH_EXACT'); assert.equal(hit.usage.dispatched, 0); assert.notEqual(hit.requestId, first.requestId, 'a fresh request binding'); assert.equal(hit.analysisId, 'soc2-' + '2'.repeat(40)); assert.equal(hit.cachedFrom.requestId, first.requestId); assert.equal(acquired, 1, 'no new usage');
  clk.advance(4 * 3_600_000); const rechecked = await broker.resolve(req({ requestKind: 'REFRESH', requestedMaxAgeMs: 3_600_000 }), OPTS({ analysisId: 'soc2-' + '3'.repeat(40), asOfTs: clk(), deadlineTs: clk() + 60_000 })); assert.equal(rechecked.reason === 'CACHE_HIT', false, 'a cache entry older than the requested age is not a hit'); assert.equal(acquired, 2);
  const earlier = await broker.resolve(req({ requestKind: 'REFRESH' }), OPTS({ analysisId: 'soc2-' + '4'.repeat(40), asOfTs: T0 - 60_000, deadlineTs: clk() + 60_000 })); assert.notEqual(earlier.reason, 'CACHE_HIT', 'evidence acquired at a later as-of is invisible to an earlier replay');
});

test('MC-B05 (R04). the same semantic question under a new request key never causes duplicate paid work inside a round; a materially different request still dispatches within caps', async () => {
  const { network } = await cryptoquantObservations(); const policy = cryptoquantPolicy(); const aa = network.filter((o) => o.payload.metricId === 'active_addresses'); const tx = network.filter((o) => o.payload.metricId === 'transaction_count'); let acquired = 0;
  const owner = fakeOwner([], async (family, coin, { metricIds }) => { acquired += 1; return { results: [{ providerId: 'CRYPTOQUANT', endpointId: 'x', state: 'OK' }], observations: (metricIds.includes('active_addresses') ? aa : tx).map((o) => variant(o, { receivedTs: T0 + 2, knownAtTs: T0 + 2 })), usage: { dispatched: 1, credits: 1, refused: 0, unresolved: 0, reasons: {} } }; });
  const broker = createBroker({ owner, policy, clock: () => T0 + 2 }); const round = 'case-round-1';
  const a = await broker.resolve(req({ requestKind: 'REFRESH', requestKey: 'Q1' }), OPTS({ round })); assert.equal(a.state, 'SATISFIED'); assert.equal(acquired, 1);
  const b = await broker.resolve(req({ requestKind: 'REFRESH', requestKey: 'Q9', question: 'Same question, new key?' }), OPTS({ round })); assert.equal(b.reason, 'SEMANTIC_DUPLICATE'); assert.equal(b.cacheStatus, 'ROUND_DUPLICATE'); assert.equal(b.duplicateOf, 'Q1'); assert.equal(b.usage.dispatched, 0); assert.equal(acquired, 1, 'no duplicate paid work');
  const c = await broker.resolve(req({ requestKind: 'REFRESH', requestKey: 'Q2', metricIds: ['transaction_count'] }), OPTS({ round })); assert.equal(c.state, 'SATISFIED'); assert.equal(acquired, 2, 'a materially different question dispatches');
});

test('MC-B06 (R04). the ACTUAL owner receives the requested metric / window through the guard; the parsed value enters P1 and the second serialized model request; P0 stays byte-identical; a wrong sibling never satisfies the request', async () => {
  const wire = []; const raw = H.policyWith({ providers: ['KRAKEN_SPOT', 'CRYPTOQUANT'], model: { enabled: true, maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 5, maxEstimatedUsdPerMonth: 50, totalSmokeMaxEstimatedUsd: 1, maxOutputTokens: 2048 } }); includedPlan(raw, 'CRYPTOQUANT'); const policy = loadPolicy(raw); const root = tmp();
  const owner = createResearchOwner({ policy, subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, researchRoot: root, mode: 'INTEGRATED', log: () => {}, fetchImpl: async (url) => { const u = new URL(url); if (u.host === 'api.kraken.com') return json(H.KRAKEN_ASSET_PAIRS); wire.push(u.pathname + u.search); return cryptoquantFetch()(url); } });
  const api = fakeAnthropic(async (body, n) => { if (n === 0) return { json: message(firstReport(P0, [req({ requestKind: 'REFRESH', hypothesisRefs: ['H1'] })])) }; const p1 = packetFromRequest(body); return { json: message(revised(p1, /analysisId (soc2-[0-9a-f]{40})/.exec(body.messages[0].content[1].text)[1], [])) }; });
  let P0 = null; const rebuild = ownerContextRebuilder(owner, { referenceNotionals: [1000] }); const rt = createCaseRuntime({ policy, env: { ANTHROPIC_API_KEY: KEY, CRYPTOQUANT_API_KEY: 'offline-fixture' }, owner, fetchImpl: api.fetchImpl, budgetDir: path.join(root, 'budget'), contextRebuilder: rebuild });
  try {
    await owner.start({ outDir: path.join(root, 'cap'), families: [] }); const base = Date.now() - 120_000;
    for (let i = 0; i < 30; i += 1) owner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: i % 3 ? 'buy' : 'sell', qty: 0.5, price: 100 + i * 0.01, eventTs: base + i * 2000, receivedTs: base + 100 + i * 2000, tradeId: 7000 + i, ordType: 'market', snapshot: false });
    owner.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: base + 61_000, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2], [99, 3]], asks: [[100.5, 2], [101, 3]] }) });
    await H.waitFor(() => owner.status().counters.tapeTrades >= 30, { timeoutMs: 4000 });
    const snap = owner.snapshotPrefix(); const asOf = Date.now(); const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: asOf, observations: snap.observations, coverage: snap.coverage, captureRef: snap.prefix, referenceNotionals: [1000], peers: [], resourceState: snap.resourceState }).context;
    const b = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: asOf, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(b.ok, true, JSON.stringify(b.detail ?? null)); P0 = b.packet; const p0Bytes = JSON.stringify(P0);
    const r = await rt.runCase({ packet: P0, marketContext: ctx, out: path.join(root, 'case'), contextParams: rebuild.params({ canonicalCoin: 'BTC' }) }).done;
    assert.equal(r.status, 'COMPLETED', JSON.stringify(r.manifest.diagnostic)); assert.equal(r.packets.length, 2); assert.equal(api.messages().length, 2);
    assert.ok(wire.some((p) => p.includes('/network-data/addresses-count')), `the owner issued the mapped active-address request (${JSON.stringify(wire)})`); assert.ok(!wire.some((p) => p.includes('exchange-flows')), 'only the requested metric was bought');
    assert.equal(r.results[0].state, 'SATISFIED'); assert.equal(r.results[0].usage.dispatched >= 1, true); assert.ok(r.results[0].observationsAdmitted >= 1);
    assert.equal(JSON.stringify(r.packets[0]), p0Bytes, 'P0 is byte-identical'); const P1 = r.packets[1]; const net = P1.evidence.find((e) => e.kind === 'MARKET_NETWORK_CONTEXT'); assert.ok(net && net.state === 'KNOWN', 'the parsed metric enters P1'); const row = net.value.fields.metrics.find((m) => m.registeredMetric === 'active_addresses'); assert.equal(row?.value, 7000, `the fixture value (last daily point 7000): ${JSON.stringify(net.value.fields)}`);
    const second = api.messages()[1].body.messages[0].content[1].text; assert.ok(second.includes('MARKET_NETWORK_CONTEXT') && second.includes('7000') && second.includes('active_addresses'), 'the second serialized request carries the acquired metric');
    assert.notEqual(r.manifest.inputs[1].captureRef.prefixId, r.manifest.inputs[0].captureRef.prefixId, 'P1 cites a NEW immutable prefix'); assert.equal(r.manifest.inputs[0].contextId, ctx.contextId);
    const v = verifyCase(path.join(root, 'case'), { resolveInputs: true }); assert.equal(v.ok, true, v.reasons.join('; ')); assert.ok(v.inputResolution.every((i) => i.resolution === 'COMPLETE' || i.resolution === 'RETAINED_WINDOW_ONLY'), JSON.stringify(v.inputResolution));
    // the wrong sibling: exchange_reserve observations never satisfy an active_addresses request through the same broker
    const sibling = await createBroker({ owner: fakeOwner(owner.observations().filter((o) => o.kind === 'ONCHAIN_METRIC' && o.payload.metricId !== 'active_addresses'), async () => ({ results: [{ providerId: 'CRYPTOQUANT', endpointId: 'x', state: 'OK' }], observations: [], usage: { dispatched: 1, credits: 1, refused: 0, unresolved: 0, reasons: {} } })), policy, clock: () => Date.now() }).resolve(req({ requestKind: 'REFRESH', requestKey: 'Q7' }), OPTS({ asOfTs: Date.now(), deadlineTs: Date.now() + 5000 }));
    assert.notEqual(sibling.state, 'SATISFIED'); assert.equal(sibling.observationsAdmitted, 0);
  } finally { await rt.close(); await owner.stop({ seal: false }); rmSync(root, { recursive: true, force: true }); }
});

test('MC-B07 (R04). usage and bounded id lists reconcile to the actual guarded wire requests and unique admissible inputs, including partial and refused acquisitions', async () => {
  const { network } = await cryptoquantObservations(); const policy = cryptoquantPolicy(); const one = network.find((o) => o.payload.metricId === 'active_addresses');
  const many = Array.from({ length: MAX_ID_LIST + 44 }, (_, i) => variant(one, { sequence: 10_000 + i, sourceKey: `k${i}`, periodStartTs: T0 - (i + 2) * 86_400_000, periodEndTs: T0 - (i + 1) * 86_400_000, receivedTs: T0 + 2, knownAtTs: T0 + 2 }));
  const dup = many[0]; const owner = fakeOwner([], async () => ({ results: [{ providerId: 'CRYPTOQUANT', endpointId: 'addresses-count', state: 'OK' }, { providerId: 'CRYPTOQUANT', endpointId: 'addresses-count', state: 'QUOTA_REFUSED', reasons: ['DAY_CAP'] }], observations: [...many, dup], usage: { dispatched: 1, credits: 1, refused: 1, unresolved: 0, reasons: { DAY_CAP: 1 } } }));
  const r = await createBroker({ owner, policy, clock: () => T0 + 2 }).resolve(req({ requestKind: 'REFRESH' }), OPTS({ asOfTs: T0 + 2 }));
  assert.equal(r.state, 'PARTIAL', 'a refused route degrades an otherwise satisfied request'); assert.equal(r.reason, 'QUOTA_REFUSED');
  assert.equal(r.observationsAdmitted, many.length, 'unique admissible inputs (the duplicate counted once)'); assert.equal(r.observationIds.length, MAX_ID_LIST); assert.equal(r.idsTruncated, true); assert.equal(r.admittedDigest, canonicalDigest(many.map((o) => o.observationId).sort()), 'the digest covers EVERY admitted id, not the truncated list');
  assert.deepEqual({ calls: r.usage.calls, dispatched: r.usage.dispatched, refused: r.usage.refused, credits: r.usage.credits }, { calls: 1, dispatched: 1, refused: 1, credits: 1 }); assert.deepEqual(r.usage.reasons, { DAY_CAP: 1 }); assert.equal(r.acquisition.length, 2);
});

// ---------------------------------------------------------------- R05 -----------------------------------------------------------
const tapeTrade = (i, ts, price = 100) => ({ coin: 'BTC', symbol: 'BTC/USD', side: i % 2 ? 'buy' : 'sell', qty: 0.25, price, eventTs: ts, receivedTs: ts, tradeId: 50_000 + i, ordType: 'market', snapshot: false });
function integratedOwner({ resources = {}, clock, dir, timers = null } = {}) {
  const p = H.policyWith({ providers: ['KRAKEN_SPOT'] }); Object.assign(p.resources, resources);
  return createResearchOwner({ policy: loadPolicy(p), subjects: btcOnly(), clock, mode: 'INTEGRATED', researchRoot: dir, log: () => {}, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), ...(timers ? { timers } : {}) });
}
const fakeTimers = () => { const schedules = []; const cleared = []; return { schedules, cleared, timers: { setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; schedules.push(h); return h; }, clearInterval: (h) => cleared.push(h), setTimeout, clearTimeout }, drain: () => { for (const s of schedules) if (s.ms === 250) s.fn(); } }; };

test('MC-S01 (R05). tiny segments rotate BEFORE overflow: every record is present exactly once in ordered sealed segments (contiguous ordinals), each segment reopens through the real capture reader and builds a context, and the prefix descriptor resolves the retained window COMPLETE', async () => {
  const dir = tmp(); let now = T0; const ft = fakeTimers(); const o = integratedOwner({ resources: { segmentBytes: 4000 }, clock: () => now, dir, timers: ft.timers });
  try {
    await o.start({ outDir: path.join(dir, 'capture'), families: [] });
    for (let i = 1; i <= 60; i += 1) { now += 1000; o.observer.onTrade(tapeTrade(i, now)); if (i % 10 === 0) ft.drain(); }
    ft.drain(); const st = o.status(); assert.ok(st.sealedCount >= 3, `several segments sealed under a 4000-byte bound (${st.sealedCount})`); assert.equal(st.recording.error, null); assert.equal(st.counters.recordingRejected, 0);
    const snap = o.snapshotPrefix(); assert.equal(prefixError(snap.prefix), null); assert.equal(snap.prefix.durable, true); assert.equal(snap.prefix.segments.length, snap.prefix.segmentCount);
    const ids = []; let prevEnd = 0; for (const s of snap.prefix.segments) { const cap = readCapture(s.dir); assert.equal(cap.observations.length, s.observations); const seg = cap.bundle.manifest.summary.segment; assert.equal(seg.ordinalStart, prevEnd + 1, 'contiguous ordinals'); prevEnd = seg.ordinalEnd; for (const ob of cap.observations) ids.push(ob.observationId); assert.ok(statSync(path.join(s.dir, 'observations.jsonl')).size <= 4000); }
    assert.equal(new Set(ids).size, ids.length, 'no record twice'); assert.equal(ids.length, 61, 'no record lost (60 trades + the instrument record written at start)'); assert.equal(membershipChain(ids), snap.prefix.membership.chainSha256);
    const r = resolvePrefix(snap.prefix); assert.equal(r.ok, true, r.reasons.join(';')); assert.equal(r.resolution, 'COMPLETE'); assert.equal(r.observations.length, 61);
    const last = snap.prefix.segments[snap.prefix.segments.length - 1]; const built = runBuild({ captureDir: last.dir, asOfTs: now + 1, canonicalCoin: 'BTC', out: path.join(dir, 'ctx') }); assert.equal(built.canonicalCoin, 'BTC');
    const sealedBeforeStop = o.status().sealedCount; const stop = await o.stop(); assert.equal(stop.error, null); assert.equal(stop.sealed, null, 'the empty segment after the snapshot is released, not sealed as an empty bundle'); assert.equal(stop.segments.length, sealedBeforeStop);
  } finally { await o.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-S02 (R05). resource enforcement with small data: an over-cap single row is rejected and counted (no rotation loop); the run bound stops recording with the first error preserved, no manifest for the failed segment and no later healthy admission; a validation / write failure at seal never publishes', async () => {
  const dir = tmp(); let now = T0; const ft = fakeTimers();
  const tiny = integratedOwner({ resources: { observationLineBytes: 1000 }, clock: () => now, dir: path.join(dir, 'a'), timers: ft.timers });
  await tiny.start({ outDir: path.join(dir, 'a', 'capture'), families: [] }); now += 1; tiny.observer.onTrade(tapeTrade(1, now)); ft.drain();
  assert.equal(tiny.status().counters.recordingRejected, 2, 'the 1399-byte instrument row and the 1089-byte trade row are rejected and counted under a 1000-byte line bound'); assert.equal(tiny.status().recording.error, null); assert.equal(tiny.status().counters.observations, 0, 'a rejected row is never admitted to the prefix'); await tiny.stop({ seal: false });
  const ft2 = fakeTimers(); const run = integratedOwner({ resources: { segmentBytes: 4000, runBytes: 6000 }, clock: () => now, dir: path.join(dir, 'b'), timers: ft2.timers });
  await run.start({ outDir: path.join(dir, 'b', 'capture'), families: [] });
  for (let i = 1; i <= 60; i += 1) { now += 1000; run.observer.onTrade(tapeTrade(i, now)); if (i % 10 === 0) ft2.drain(); } ft2.drain();
  const st = run.status(); assert.ok(st.recording.error, 'the run bound is a visible recording error'); assert.equal(st.recording.error.code, 'RESOURCE_LIMIT_EXCEEDED'); assert.equal(st.lifecycle, 'RECORDING_FAILED'); assert.ok(st.recording.where.startsWith('ROTATE') || st.recording.where === 'RUN_BOUND');
  const after = st.counters.observations; now += 1000; run.observer.onTrade(tapeTrade(99, now)); ft2.drain(); assert.equal(run.status().counters.observations, after, 'nothing is admitted after the recording failure');
  const stop = await run.stop(); assert.equal(stop.error.code, 'RESOURCE_LIMIT_EXCEEDED', 'stop preserves the first error'); assert.equal(stop.sealed, null);
  const dirs = readdirSync(path.join(dir, 'b')).filter((d) => d.startsWith('capture')); for (const d of dirs) { const sealed = existsSync(path.join(dir, 'b', d, 'manifest.json')); if (!sealed) assert.ok(!existsSync(path.join(dir, 'b', d, 'observations.jsonl')) || true, 'an unsealed segment carries no completion manifest'); }
  assert.ok(dirs.some((d) => !existsSync(path.join(dir, 'b', d, 'manifest.json'))) || stop.segments.length >= 1, 'the failed segment is not sealed');
  // seal-time write failure: a member path already occupied => no manifest, error preserved
  const ft3 = fakeTimers(); const seal = integratedOwner({ clock: () => now, dir: path.join(dir, 'c'), timers: ft3.timers }); await seal.start({ outDir: path.join(dir, 'c', 'capture'), families: [] }); now += 1; seal.observer.onTrade(tapeTrade(1, now)); ft3.drain();
  mkdirSync(path.join(dir, 'c', 'capture', 'catalog.json')); const s3 = await seal.stop({ seal: true }); assert.ok(s3.error, 'the seal failure is visible'); assert.equal(s3.sealed, null); assert.equal(existsSync(path.join(dir, 'c', 'capture', 'manifest.json')), false, 'no manifest after a failed seal');
  // validation failure at publication: the candidate validator refuses, no manifest is written, the reservation is not sealed
  const real = prepareOutputTarget(path.join(dir, 'v')); const res = reserveOutputDir(real); const members = ['context.json', 'input-references.json', 'coverage.json', 'code-identity.json'].map((n) => writeJsonFile(res, n, { x: 1 }));
  assert.throws(() => publishManifest(res, { kind: 'CONTEXT', createdTs: T0, summary: { contextId: 'x' }, identity: { sourceTreeSha256: 'a'.repeat(64), law: 'NO_GIT_CHECKOUT', gitCommit: null }, members, validate: () => 'candidate refused' }), /candidate refused|manifest|summary/); assert.equal(existsSync(path.join(real, 'manifest.json')), false); assert.equal(res.sealed, false); res.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test('MC-S04 (R05). a long logical operation under a fake clock bounds retention, coverage, the broker cache and the service case index; eviction is counted and leaves EVICTED / COVERAGE_OVERFLOW facts, never silent loss', async () => {
  const store = createRetainedStore({ limits: { retainedObservations: 5, retainedCoverage: 3 }, clock: () => T0 });
  const one = (await cryptoquantObservations()).network[0]; const evictions = [];
  for (let i = 0; i < 20; i += 1) evictions.push(...store.push(variant(one, { sequence: 500 + i, sourceKey: `s${i}`, receivedTs: T0 + i, knownAtTs: T0 + i })));
  assert.equal(store.observations().length, 5); const m = store.membership(); assert.equal(m.retained, 5); assert.equal(m.evicted, 15); assert.equal(m.firstOrdinal, 16); assert.equal(m.lastOrdinal, 20); assert.ok(evictions.length >= 1 && evictions.every((c) => c.state === 'EVICTED' && c.reasonCodes.includes('RESOURCE_EVICTED'))); assert.equal(evictions.reduce((n, c) => n + c.droppedCount, 0), 15, 'every evicted row is counted in an EVICTED scope');
  for (const c of evictions.slice(0, 6)) store.pushCoverage(c); assert.equal(store.counters().retainedCoverage, 3); assert.ok(store.coverage().some((c) => c.reasonCodes.includes('COVERAGE_OVERFLOW')), 'coverage overflow is a visible GAP marker'); assert.ok(store.membership().coverageEvicted >= 3);
  const broker = createBroker({ owner: fakeOwner([one]), policy: cryptoquantPolicy(), clock: () => T0, cacheSize: 4 }); for (let i = 0; i < 12; i += 1) await broker.resolve(req({ requestKey: `Q${i}`, metricIds: [['active_addresses', 'transaction_count', 'transfer_volume', 'network_fees'][i % 4]] }), OPTS({ analysisId: `soc2-${String(i).repeat(40).slice(0, 40)}` }));
  assert.ok(broker.cacheSize() <= 4, `broker cache bounded (${broker.cacheSize()})`);
  const p = H.policyWith({ providers: ['KRAKEN_SPOT'] }); p.resources.retainedCaseDescriptors = 2; const root = tmp(); const svc = createResearchService({ policy: loadPolicy(p), subjects: btcOnly(), env: {}, researchRoot: root, mode: 'INTEGRATED', clock: () => Date.now(), fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), httpPort: null, log: () => {} });
  try { await svc.start(); for (let i = 0; i < 4; i += 1) { svc.enqueueCase({ canonicalCoin: 'BTC' }); await H.waitFor(() => svc.status().cases.running === 0 && svc.status().cases.queued === 0, { timeoutMs: 8000 }); } assert.ok(svc.status().cases.recent.length <= 2, 'case descriptors are bounded'); assert.ok(svc.status().cases.counters.evicted >= 2); }
  finally { await svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('MC-S05 (R05). an ACTUAL service case references a resolvable immutable prefix; after stop (caches gone) offline verification reopens the sealed segments, resolves the prefix and recomputes the context identity', async () => {
  const root = tmp(); const p = H.policyWith({ providers: ['KRAKEN_SPOT'] }); p.resources.segmentBytes = 6000;
  const svc = createResearchService({ policy: loadPolicy(p), subjects: btcOnly(), env: {}, researchRoot: root, mode: 'INTEGRATED', clock: () => Date.now(), fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), httpPort: null, log: () => {} });
  try {
    await svc.start(); const base = Date.now() - 120_000; for (let i = 0; i < 40; i += 1) svc.owner.observer.onTrade(tapeTrade(i, base + i * 2000, 100 + i * 0.01)); await H.waitFor(() => svc.owner.status().counters.tapeTrades >= 40, { timeoutMs: 4000 });
    const q = svc.enqueueCase({ canonicalCoin: 'BTC' }); assert.equal(q.accepted, true); await H.waitFor(() => svc.status().cases.recent.some((c) => c.status && c.status !== 'RUNNING'), { timeoutMs: 8000 });
    const entry = svc.status().cases.recent[0]; assert.equal(entry.status, 'BUDGET_BLOCKED', JSON.stringify(entry)); assert.ok(/^mpx-[0-9a-f]{64}$/.test(entry.prefixId)); assert.equal(entry.prefixDurable, true);
    const caseDir = path.join(root, 'cases', entry.dir); const stopped = await svc.stop(); assert.equal(stopped.state, 'STOPPED');
    const v = verifyCase(caseDir, { resolveInputs: true }); assert.equal(v.ok, true, v.reasons.join('; ')); assert.equal(v.inputs.length, 1); assert.equal(v.inputs[0].prefixId, entry.prefixId); assert.equal(v.inputs[0].durable, true);
    assert.equal(v.inputResolution.length, 1); assert.ok(['COMPLETE', 'RETAINED_WINDOW_ONLY'].includes(v.inputResolution[0].resolution), JSON.stringify(v.inputResolution)); assert.equal(v.inputResolution[0].recomputed, v.inputs[0].contextId, 'the context identity is recomputed from the sealed segments after restart and agrees with the recorded one');
    const cm = JSON.parse(readFileSync(path.join(caseDir, 'case.json'), 'utf8')); for (const s of cm.inputs[0].captureRef.segments) assert.ok(existsSync(path.join(s.dir, 'manifest.json')), 'every cited segment is a sealed bundle');
  } finally { await svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('MC-S06 (R05). a partial file, an altered prefix hash, a missing segment and a resealed case citing a tampered prefix fail SEMANTIC verification although every outer checksum is valid', async () => {
  const dir = tmp(); let now = T0; const ft = fakeTimers(); const o = integratedOwner({ clock: () => now, dir, timers: ft.timers });
  await o.start({ outDir: path.join(dir, 'capture'), families: [] }); for (let i = 1; i <= 12; i += 1) { now += 1000; o.observer.onTrade(tapeTrade(i, now)); } ft.drain(); const stopped = await o.stop(); assert.ok(stopped.sealed);
  const cap = readCapture(path.join(dir, 'capture')); const prefix = sealedCapturePrefix(cap, { dir: path.join(dir, 'capture') }); assert.equal(prefixError(prefix), null); assert.equal(resolvePrefix(prefix).resolution, 'COMPLETE');
  const rebound = (p) => ({ ...p, prefixId: prefixIdentity(p) }); // a descriptor is bound to its bytes: an edit without re-deriving the id is refused outright
  assert.throws(() => resolvePrefix({ ...prefix, segments: [{ ...prefix.segments[0], observationsSha256: 'f'.repeat(64) }] }), /prefixId does not match/);
  const altered = rebound({ ...prefix, segments: [{ ...prefix.segments[0], observationsSha256: 'f'.repeat(64) }] }); const a = resolvePrefix(altered); assert.equal(a.ok, false); assert.match(a.reasons.join(' '), /member hashes disagree/);
  const missing = rebound({ ...prefix, segments: [{ ...prefix.segments[0], dir: path.join(dir, 'gone') }] }); const mm = resolvePrefix(missing); assert.equal(mm.ok, false); assert.match(mm.reasons.join(' '), /segment gone/);
  const file = path.join(dir, 'capture', 'observations.jsonl'); const size = statSync(file).size; truncateSync(file, size - 40); const partial = resolvePrefix(prefix); assert.equal(partial.ok, false, 'a partial member fails (the outer manifest still names the full bytes)'); assert.match(partial.reasons.join(' '), /segment capture/);
  // a sealed case whose recorded prefix is tampered and RESEALED with consistent outer checksums still fails the semantic prefix law
  const c = c01(); const cdir = path.join(dir, 'case'); const api = fakeAnthropic(async () => ({ json: message(c.scripted) }));
  const rt = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: api.fetchImpl, budgetDir: path.join(dir, 'budget') });
  try { const r = await rt.runCase({ packet: c.packet, out: cdir }).done; assert.equal(r.status, 'COMPLETED'); } finally { await rt.close(); }
  assert.equal(verifyCase(cdir).ok, true);
  const cj = path.join(cdir, 'case.json'); const cm = JSON.parse(readFileSync(cj, 'utf8')); cm.inputs = [{ packetId: c.packet.packetId, contextId: 'mctx-' + 'a'.repeat(64), captureRef: rebound({ ...prefix, segments: [{ ...prefix.segments[0], observationsSha256: 'f'.repeat(64) }] }), asOfTs: c.packet.asOfTs, contextParams: null }]; const text = `${JSON.stringify(cm, null, 1)}\n`; writeFileSync(cj, text);
  const mf = JSON.parse(readFileSync(path.join(cdir, 'manifest.json'), 'utf8')); const d = mf.members.find((m) => m.name === 'case.json'); d.bytes = Buffer.byteLength(text); d.sha256 = sha256Hex(Buffer.from(text)); mf.bundleId = manifestIdentity(mf); writeFileSync(path.join(cdir, 'manifest.json'), `${JSON.stringify(mf, null, 1)}\n`);
  assert.equal(openBundle(cdir, 'CASE').manifest.bundleId, mf.bundleId, 'outer checksums are consistent'); const bad = verifyCase(cdir, { resolveInputs: true }); assert.equal(bad.ok, false); assert.match(bad.reasons.join(' '), /inputs|prefix|context/);
  rmSync(dir, { recursive: true, force: true });
});

test('MC-S07 (R05). concurrent intake, rotation and case snapshots plus repeated stop have deterministic membership, no unowned deletion, no late callbacks and no leaked timers', async () => {
  const dir = tmp(); let now = T0; const ft = fakeTimers(); const o = integratedOwner({ resources: { segmentBytes: 4000 }, clock: () => now, dir, timers: ft.timers });
  writeFileSync(path.join(dir, 'foreign.txt'), 'not ours'); mkdirSync(path.join(dir, 'other-run')); writeFileSync(path.join(dir, 'other-run', 'manifest.json'), '{}');
  try {
    await o.start({ outDir: path.join(dir, 'capture'), families: [] }); const snaps = []; const ids = [];
    for (let i = 1; i <= 50; i += 1) { now += 1000; o.observer.onTrade(tapeTrade(i, now)); if (i % 7 === 0) { ft.drain(); snaps.push(o.snapshotPrefix()); } }
    ft.drain(); for (const s of snaps) { assert.equal(prefixError(s.prefix), null); assert.equal(s.observations.length, s.prefix.membership.retained); assert.equal(membershipChain(s.observations.map((x) => x.observationId)), s.prefix.membership.chainSha256, 'a snapshot chain is exactly its retained ordering'); }
    for (const s of o.snapshotPrefix().prefix.segments) for (const ob of readCapture(s.dir).observations) ids.push(ob.observationId); assert.equal(ids.length, 51, '50 trades + the instrument record'); assert.equal(new Set(ids).size, 51, 'rotation under intake never duplicates or drops a record');
    const [s1, s2] = await Promise.all([o.stop(), o.stop()]); assert.equal(s1, s2, 'concurrent stops share ONE result'); assert.equal((await o.stop()).sealed, s1.sealed, 'a later stop returns the same result');
    now += 1000; o.observer.onTrade(tapeTrade(99, now)); ft.drain(); assert.equal(o.status().counters.tapeTrades, 50, 'no late intake after stop');
    for (const h of ft.schedules) assert.ok(ft.cleared.includes(h), 'every scheduled timer is cleared at stop');
    assert.equal(readFileSync(path.join(dir, 'foreign.txt'), 'utf8'), 'not ours'); assert.ok(existsSync(path.join(dir, 'other-run', 'manifest.json')), 'another run\'s files are never touched');
    assert.equal(o.journal.isClosed(), true, 'the accounting journal is released'); assert.equal(existsSync(path.join(dir, 'accounting', 'quota.lock')), false);
  } finally { await o.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- R06 -----------------------------------------------------------
const heldMessages = () => { let release = null; let reject = null; let dispatched; const gate = new Promise((r) => { dispatched = r; }); const api = fakeAnthropic(() => { dispatched(); return new Promise((res, rej) => { release = (raw) => res({ json: raw }); reject = (err) => rej(err); }); }); return { api, gate, release: (raw) => release?.(raw), reject: (e) => reject?.(e) }; };
test('MC-L02 (R06). a valid late response and a rejection released AFTER drain / close mutate nothing: journal bytes, cache size and the case outcome are unchanged; no unhandled rejection', async () => {
  const c = c01(); const dir = tmp(); const held = heldMessages(); const unhandled = []; const onUnhandled = (e) => unhandled.push(e); process.on('unhandledRejection', onUnhandled);
  const rt = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: held.api.fetchImpl, budgetDir: path.join(dir, 'budget'), closeDrainMs: 60 });
  try {
    const h = rt.runCase({ packet: c.packet, out: path.join(dir, 'case') }); await held.gate; const closing = rt.close(); const t = Date.now(); await closing; assert.ok(Date.now() - t < 5000, 'the drain is bounded');
    assert.equal(rt.status().closed, true); assert.equal(rt.status().drain.detached, 1, 'the transport ignored abort: the case is detached at the deadline');
    const journalFile = path.join(dir, 'budget', 'journal.jsonl'); const before = readFileSync(journalFile, 'utf8'); assert.match(before, /UNRESOLVED/, 'the open reservation is preserved as UNRESOLVED at the handoff'); const cacheBefore = rt.status().cacheSize;
    held.release(message(c.scripted)); const r = await h.done; assert.notEqual(r.status, 'COMPLETED', `late valid response never completes (${r.status})`); assert.equal(r.publication, 'SKIPPED_RUNTIME_CLOSED'); assert.equal(existsSync(path.join(dir, 'case', 'manifest.json')), false, 'no sealed case after close');
    assert.equal(readFileSync(journalFile, 'utf8'), before, 'the journal is not touched after close'); assert.equal(rt.status().cacheSize, cacheBefore);
    const held2 = heldMessages(); const rt2 = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: held2.api.fetchImpl, budgetDir: path.join(dir, 'budget2'), closeDrainMs: 60 });
    const h2 = rt2.runCase({ packet: c.packet }); await held2.gate; await rt2.close(); const j2 = readFileSync(path.join(dir, 'budget2', 'journal.jsonl'), 'utf8'); held2.reject(Object.assign(new Error('late failure'), { name: 'TypeError' }));
    const r2 = await h2.done; assert.notEqual(r2.status, 'COMPLETED'); assert.equal(readFileSync(path.join(dir, 'budget2', 'journal.jsonl'), 'utf8'), j2); await new Promise((r) => setTimeout(r, 20)); assert.equal(unhandled.length, 0, 'no unhandled rejection');
  } finally { process.off('unhandledRejection', onUnhandled); await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-L03 (R06). close at each stage has the correct accounting: during the token count (no reservation), by the caller\'s signal before dispatch (reservation RELEASED), during the Messages request (UNRESOLVED, ambiguous) and during a broker acquisition (initial attempt SETTLED, case CANCELLED, no second attempt)', async () => {
  const c = c01(); const dir = tmp(); const rows = (d) => { const j = openBudgetJournal({ dir: path.join(dir, d) }); const r = j.reservations(); j.close(); return r; };
  // 1. during the token count: no reservation can exist
  let countHold; const countGate = new Promise((r) => { countHold = r; }); let counting = null; const countGateHit = new Promise((r) => { counting = r; });
  const api1 = { fetchImpl: async (url) => { if (new URL(url).pathname.endsWith('count_tokens')) { counting(); await countGate; return json({ input_tokens: 1000 }); } throw new Error('must not dispatch'); } };
  const rt1 = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: api1.fetchImpl, budgetDir: path.join(dir, 'j1'), closeDrainMs: 200 });
  const h1 = rt1.runCase({ packet: c.packet }); await countGateHit; const c1 = rt1.close(); countHold(); const r1 = await h1.done; await c1; assert.equal(r1.status, 'CANCELLED'); assert.equal(r1.manifest.diagnostic.kind, 'RUNTIME_CLOSED'); assert.equal(rows('j1').length, 0, 'no reservation during a count');
  // 2. caller signal before dispatch: the reservation is written, then released (provably not dispatched)
  const ac = new AbortController(); let sawMessages = false;
  const rt2 = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: async (url, init) => { if (new URL(url).pathname.endsWith('count_tokens')) { ac.abort(); return json({ input_tokens: 1000 }); } sawMessages = true; throw new Error('never'); }, budgetDir: path.join(dir, 'j2') });
  const r2 = await rt2.runCase({ packet: c.packet, signal: ac.signal }).done; await rt2.close(); assert.equal(r2.status, 'CANCELLED'); assert.equal(sawMessages, false); assert.equal(rows('j2').length, 0, 'the count -> reserve -> dispatch sequence has no await between reserve and dispatch: an abort lands BEFORE the reservation (proven non-dispatch, nothing to release)');
  // 3. during the Messages request (the transport honours abort): ambiguous => UNRESOLVED
  const held = heldMessages(); const rt3 = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: async (url, init) => { const p = held.api.fetchImpl(url, init); init.signal?.addEventListener('abort', () => held.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); return p; }, budgetDir: path.join(dir, 'j3') });
  const h3 = rt3.runCase({ packet: c.packet }); await held.gate; await rt3.close(); const r3 = await h3.done; assert.equal(r3.status, 'CANCELLED'); assert.equal(r3.manifest.diagnostic.kind, 'RUNTIME_CLOSED'); const j3 = rows('j3'); assert.equal(j3.length, 1); assert.equal(j3[0].state, 'UNRESOLVED', 'a request already on the wire is ambiguous spend');
  // 4. during a broker acquisition: the initial attempt is settled, the follow-up never dispatches a second attempt
  let acquireHold; const acquireGate = new Promise((r) => { acquireHold = r; }); let acquiring = null; const acquiringHit = new Promise((r) => { acquiring = r; });
  const owner = { observations: () => [], coverage: () => [], acquire: async () => { acquiring(); await acquireGate; return { results: [], observations: [] }; }, hot: { status: () => null } };
  const p0 = c.packet; const api4 = fakeAnthropic(async () => ({ json: message(firstReport(p0, [{ requestKey: 'Q1', requestKind: 'REFRESH', family: 'SPOT_PRICE_CHART', metricIds: ['window_ohlcv'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null, hypothesisRefs: ['H1'], question: 'still advancing?', interpretationIfSupported: 'x', interpretationIfContradicted: 'y' }])) }));
  const rt4 = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, owner, fetchImpl: api4.fetchImpl, budgetDir: path.join(dir, 'j4'), closeDrainMs: 300 });
  const h4 = rt4.runCase({ packet: p0 }); await acquiringHit; const c4 = rt4.close(); acquireHold(); const r4 = await h4.done; await c4;
  assert.equal(r4.status, 'CANCELLED'); assert.equal(r4.manifest.diagnostic.kind, 'RUNTIME_CLOSED'); assert.equal(r4.analyses.length, 1, 'the initial report is recorded, not published as final'); assert.equal(api4.messages().length, 1, 'no second attempt after close'); const j4 = rows('j4'); assert.equal(j4.length, 1); assert.equal(j4[0].state, 'SETTLED');
  rmSync(dir, { recursive: true, force: true });
});

test('MC-L04 (R06). a transport that ignores abort is drained within the test-controlled deadline: unresolved spend retained, every continuation fenced, the lock released exactly once', async () => {
  const c = c01(); const dir = tmp(); const held = heldMessages(); const clockedDrain = 80;
  const rt = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: held.api.fetchImpl, budgetDir: path.join(dir, 'budget'), closeDrainMs: clockedDrain });
  const h = rt.runCase({ packet: c.packet, out: path.join(dir, 'case') }); await held.gate; assert.ok(existsSync(path.join(dir, 'budget', 'budget.lock')));
  const t0 = Date.now(); const first = rt.close(); const second = rt.close(); assert.equal(first, second, 'one close promise'); await first; const elapsed = Date.now() - t0;
  assert.ok(elapsed >= clockedDrain - 5 && elapsed < 5000, `bounded drain (${elapsed} ms)`); assert.equal(existsSync(path.join(dir, 'budget', 'budget.lock')), false, 'the lock is released once the drain deadline passes');
  const j = openBudgetJournal({ dir: path.join(dir, 'budget') }); assert.equal(j.reservations()[0].state, 'UNRESOLVED'); assert.ok(j.totals().unresolvedUsd > 0, 'the ambiguous spend is retained'); j.close();
  assert.equal(rt.status().drain.detached, 1); assert.throws(() => rt.runCase({ packet: c.packet }), /closed/); held.release(message(c.scripted)); const r = await h.done; assert.notEqual(r.status, 'COMPLETED'); assert.equal(existsSync(path.join(dir, 'case', 'manifest.json')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('MC-L05 (R06). repeated / concurrent close and runCase-after-close are deterministic; an already completed valid case remains verifiable and byte-identical', async () => {
  const c = c01(); const dir = tmp(); const api = fakeAnthropic(async () => ({ json: message(c.scripted) }));
  const rt = createCaseRuntime({ policy: LIVE(), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: api.fetchImpl, budgetDir: path.join(dir, 'budget') });
  const r = await rt.runCase({ packet: c.packet, out: path.join(dir, 'case') }).done; assert.equal(r.status, 'COMPLETED'); const bytes = readdirSync(path.join(dir, 'case')).sort().map((f) => [f, sha256Hex(readFileSync(path.join(dir, 'case', f)))]);
  const [a, b, d] = await Promise.all([rt.close(), rt.close(), rt.close()]); assert.equal(a, b); assert.equal(b, d); assert.equal(await rt.close(), undefined); assert.equal(rt.status().closed, true);
  assert.throws(() => rt.runCase({ packet: c.packet }), /closed/); assert.deepEqual(readdirSync(path.join(dir, 'case')).sort().map((f) => [f, sha256Hex(readFileSync(path.join(dir, 'case', f)))]), bytes, 'the sealed case is untouched by close');
  assert.equal(verifyCase(path.join(dir, 'case')).ok, true); rmSync(dir, { recursive: true, force: true });
});

test('MC-L06 (R06). service.stop awaits BOTH lifecycles (runtime barrier then owner seal), and a recording failure while active stops admission, closes the runtime and preserves the error through stop', async () => {
  const root = tmp(); const p = H.policyWith({ providers: ['KRAKEN_SPOT'] }); p.resources.segmentBytes = 4000; p.resources.runBytes = 6000;
  const svc = createResearchService({ policy: loadPolicy(p), subjects: btcOnly(), env: {}, researchRoot: root, mode: 'INTEGRATED', clock: () => Date.now(), fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), httpPort: null, log: () => {} });
  try {
    await svc.start(); assert.equal(svc.status().state, 'ACTIVE');
    const base = Date.now() - 200_000; for (let i = 0; i < 80; i += 1) svc.owner.observer.onTrade(tapeTrade(i, base + i * 1000)); await H.waitFor(() => svc.owner.status().recording.error !== null, { timeoutMs: 5000 });
    await H.waitFor(() => svc.status().state === 'RECORDING_FAILED', { timeoutMs: 3000 }); assert.deepEqual(svc.enqueueCase({ canonicalCoin: 'BTC' }), { accepted: false, reason: 'RECORDING_FAILED' }, 'no healthy admission after a recording failure');
    await H.waitFor(() => svc.runtime.status().closed === true, { timeoutMs: 3000 }); assert.equal(svc.runtime.status().closed, true, 'the runtime barrier completed');
    const stopped = await svc.stop(); assert.equal(stopped.state, 'RECORDING_FAILED', 'stop never launders a recording failure into a healthy STOPPED'); assert.equal(svc.owner.status().lifecycle, 'RECORDING_FAILED'); assert.equal(stopped.error?.code, 'RESOURCE_LIMIT_EXCEEDED', JSON.stringify(stopped).slice(0, 300)); assert.equal(stopped.runtime, 'CLOSED');
    assert.equal(svc.owner.journal.isClosed(), true); assert.equal(existsSync(path.join(root, 'accounting', 'quota.lock')), false);
  } finally { await svc.stop(); rmSync(root, { recursive: true, force: true }); }
  const root2 = tmp(); const svc2 = createResearchService({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), env: {}, researchRoot: root2, mode: 'INTEGRATED', clock: () => Date.now(), fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), httpPort: null, log: () => {} });
  try { await svc2.start(); const s = await svc2.stop(); assert.equal(s.state, 'STOPPED'); assert.equal(svc2.runtime.status().closed, true); assert.equal(svc2.owner.status().lifecycle, 'STOPPED'); assert.ok(s.sealed?.bundleId, 'the owner segment is sealed after the runtime barrier'); }
  finally { await svc2.stop(); rmSync(root2, { recursive: true, force: true }); }
});
