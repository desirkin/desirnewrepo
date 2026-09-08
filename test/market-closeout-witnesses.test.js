// MARKET / SOCRATES CLOSEOUT — the confirmed review witnesses R01-R07 (+ readiness) converted into REQUIRED-behaviour
// regressions (MC- ids are local to this closeout). Every fixture is offline: fake HTTP, fake clocks, temp directories.
// Each test states the law the production boundary must obey; the expectation comes from the ticket's stated law or an
// independent numeric oracle, never from the generator and validator agreeing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as H from './helpers/market-lab.js';
import { createResearchOwner } from '../market-lab/owner.js';
import { loadPolicy, loadSubjects, ALLOWED_MAX_AGE_MS } from '../market-lab/policy.js';
import { buildContext, contextError, contextIdentity, COMPONENT_KEYS } from '../market-lab/context.js';
import { observationError, canonicalDigest } from '../market-lab/contracts.js';
import { createBroker, METRIC_REGISTRY } from '../socrates/broker.js';
import { dataRequestError } from '../socrates/contract-v2.js';
import { buildResearchEvidenceV2 } from '../evidence/research-builder.js';
import { buildRequestBody } from '../socrates/prompt.js';
import { createCaseRuntime, verifyCase } from '../socrates/runtime.js';
import { corpusCases } from '../socrates/corpus.js';
import { liveReadinessManifest, providerReadiness } from '../market-lab/readiness.js';

const T0 = H.T0; const tmp = () => mkdtempSync(path.join(tmpdir(), 'mc-'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const subjects = () => loadSubjects(H.subjectsWith());

test('MC-Q01/MC-Q02 (R01). CryptoQuant with maxCallsPerDay=0 / maxCallsPerMonth=0 and ONE remaining included call must dispatch ZERO wire requests through owner.acquire (zero means zero); with day/month caps of 100 and one remaining included call, at most ONE of the three exchange-flow routes may dispatch', async () => {
  const mk = (limits, remaining) => { const raw = H.policyWith({ providers: ['CRYPTOQUANT'] }); Object.assign(raw.providers.CRYPTOQUANT.plan, { name: 'closeout fixture', billing: 'INCLUDED_QUOTA', includedCallsPerMonth: 100, remainingCalls: remaining, incrementalUsdPerCall: 0, attestation: 'offline fixture only', verifiedDate: '2026-09-08' }); Object.assign(raw.providers.CRYPTOQUANT.limits, limits); return loadPolicy(raw); };
  const fetchStub = (requests) => async (url) => { const u = new URL(url); requests.push(u.pathname); const metric = u.pathname.split('/').at(-1); const field = { inflow: 'inflow_total', outflow: 'outflow_total', reserve: 'reserve' }[metric]; return json(H.cryptoquantSeries({ field })); };
  const zero = []; const own = createResearchOwner({ policy: mk({ maxCallsPerDay: 0, maxCallsPerMonth: 0 }, 1), subjects: subjects(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, fetchImpl: fetchStub(zero), researchRoot: tmp() });
  const aq = await own.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); await own.stop({ seal: false });
  assert.equal(zero.length, 0, `zero day/month caps must dispatch nothing (dispatched ${zero.length})`); assert.equal(aq.observations.length, 0, 'no observation may be invented under a refused dispatch');
  assert.ok(aq.results.length >= 1 && aq.results.every((r) => r.state !== 'OK' && r.state !== 'CACHED'), 'every route reports its refusal');
  const one = []; const own2 = createResearchOwner({ policy: mk({ maxCallsPerDay: 100, maxCallsPerMonth: 100 }, 1), subjects: subjects(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, fetchImpl: fetchStub(one), researchRoot: tmp() });
  const aq2 = await own2.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); await own2.stop({ seal: false });
  assert.ok(one.length <= 1, `one remaining included call admits at most one dispatch (dispatched ${one.length})`);
  assert.equal(aq2.results.filter((r) => r.state === 'OK').length, one.length, 'OK results equal actual dispatches');
});

test('MC-Q07 (R01). the shipped-rate cache-price witness: 10000 input tokens + 256 output with prompt cache creation enabled must reserve USD 0.02756 (not 0.02256) and a case ceiling of USD 0.024 must refuse BEFORE any /v1/messages dispatch', async () => {
  const fx = corpusCases().find((c) => c.id === 'C01'); const dir = tmp(); const calls = [];
  const fetchStub = async (url, init) => { const u = new URL(url); calls.push(u.pathname); if (u.pathname.endsWith('count_tokens')) return json({ input_tokens: 10000 }); return json({ type: 'message', id: 'fixture', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fx.scripted) }], usage: { input_tokens: 0, output_tokens: 256, cache_creation_input_tokens: 10000, cache_read_input_tokens: 0 } }); };
  const policy = loadPolicy(H.policyWith({ model: { enabled: true, maxEstimatedUsdPerCase: 0.024, maxEstimatedUsdPerDay: 5, maxEstimatedUsdPerMonth: 50, maxOutputTokens: 256 } }));
  const rt = createCaseRuntime({ policy, env: { ANTHROPIC_API_KEY: 'offline-fixture' }, clock: () => T0, budgetDir: path.join(dir, 'budget'), fetchImpl: fetchStub });
  try {
    const r = await rt.runCase({ packet: fx.packet }).done;
    assert.equal(r.status, 'BUDGET_BLOCKED', `a 0.024 ceiling must refuse a 0.02756 cache-creation reservation (got ${r.status})`);
    assert.equal(calls.filter((p) => p === '/v1/messages').length, 0, 'no paid inference under a refused reservation');
    const est = r.attempts[0].budget?.estimatedUsd ?? r.attempts[0].reservation?.estimatedUsd ?? null; assert.equal(est, 0.02756, 'the reservation covers the worst enabled billed input class (cache write 2.5 > input 2)');
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-Q08 (R01). a failed provider token count cannot authorize a paid inference through the bytes/3 fallback: the attempt ends with an explicit counting diagnostic and ZERO /v1/messages dispatches', async () => {
  const fx = corpusCases().find((c) => c.id === 'C01'); const dir = tmp(); const calls = [];
  const fetchStub = async (url) => { const u = new URL(url); calls.push(u.pathname); if (u.pathname.endsWith('count_tokens')) return json({ type: 'error', error: { type: 'api_error' } }, 500); return json({ type: 'message', id: 'fixture', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fx.scripted) }], usage: { input_tokens: 1000, output_tokens: 256 } }); };
  const policy = loadPolicy(H.policyWith({ model: { enabled: true, maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 5, maxEstimatedUsdPerMonth: 50, maxOutputTokens: 256 } }));
  const rt = createCaseRuntime({ policy, env: { ANTHROPIC_API_KEY: 'offline-fixture' }, clock: () => T0, budgetDir: path.join(dir, 'budget'), fetchImpl: fetchStub });
  try { const r = await rt.runCase({ packet: fx.packet }).done; assert.equal(calls.filter((p) => p === '/v1/messages').length, 0, 'no inference without a valid exact token count'); assert.notEqual(r.status, 'COMPLETED'); assert.match(String(r.manifest.diagnostic?.kind), /TOKEN_COUNT|RESERVATION|COUNT/); }
  finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function krakenBookOnly() {
  const kp = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] }));
  const ko = createResearchOwner({ policy: kp, subjects: subjects(), clock: () => T0, fetchImpl: async (url) => json(new URL(url).pathname.endsWith('AssetPairs') ? H.KRAKEN_ASSET_PAIRS : H.krakenTicker('XXBTZUSD')), researchRoot: tmp() });
  await ko.clients.KRAKEN_SPOT.loadCatalog(); const market = ko.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market;
  return { ko, market };
}
test('MC-W01 (R02). one Kraken book and NO trade-feed coverage: the 1 h trade window must report UNKNOWN coverage (count / notional null), never an unqualified COMPLETE_NO_TRADES', async () => {
  const { ko, market } = await krakenBookOnly();
  try {
    const tick = await ko.clients.KRAKEN_SPOT.ticker({ markets: [market] }); assert.equal(tick.ok, true);
    const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: tick.observations, coverage: tick.coverage, captureRef: { bundleId: 'audit' } });
    assert.equal(contextError(ctx.context, { inputReferences: ctx.inputReferences }), null);
    const oneHour = ctx.context.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 3_600_000);
    assert.notEqual(oneHour.value.current.support.state, 'COMPLETE_NO_TRADES', 'no positive interval coverage => no valid zero');
    assert.equal(oneHour.value.current.support.state, 'UNKNOWN_COVERAGE'); assert.equal(oneHour.value.current.count, null); assert.equal(oneHour.value.current.quoteNotional, null);
  } finally { await ko.stop({ seal: false }); }
});

const deribitTicker = (name) => { const spec = { 'BTC-26SEP26-100000-C': { iv: 65, delta: 0.55 }, 'BTC-26SEP26-110000-C': { iv: 60, delta: 0.25 }, 'BTC-26SEP26-100000-P': { iv: 70, delta: -0.45 }, 'BTC-26SEP26-90000-P': { iv: 72, delta: -0.25 } }[name]; if (!spec) return null; return { result: { instrument_name: name, mark_iv: spec.iv, bid_iv: spec.iv - 1, ask_iv: spec.iv + 1, greeks: { delta: spec.delta, gamma: 0.00001, vega: 50, theta: -20 }, mark_price: 0.05, underlying_price: 100_500, underlying_index: 'SYN.BTC-26SEP26', open_interest: 100, stats: { volume: 10, volume_usd: 1000 }, best_bid_price: 0.049, best_ask_price: 0.051, timestamp: T0 - 400 } }; };
const DERIBIT_FOUR = { result: [...H.DERIBIT_INSTRUMENTS.result, { ...H.DERIBIT_INSTRUMENTS.result[0], instrument_name: 'BTC-26SEP26-110000-C', strike: 110000 }, { ...H.DERIBIT_INSTRUMENTS.result[1], instrument_name: 'BTC-26SEP26-90000-P', strike: 90000 }] };
const deribitFourSummaries = () => ({ result: DERIBIT_FOUR.result.map((i) => ({ instrument_name: i.instrument_name, mark_iv: { 'BTC-26SEP26-100000-C': 65, 'BTC-26SEP26-110000-C': 60, 'BTC-26SEP26-100000-P': 70, 'BTC-26SEP26-90000-P': 72 }[i.instrument_name], open_interest: 100, mark_price: 0.05, underlying_price: 100_500, underlying_index: 'SYN.BTC-26SEP26', volume: 10, bid_price: 0.049, ask_price: 0.051, creation_timestamp: T0 - 500 })) });
async function deribitOwner(paths) {
  const dp = loadPolicy(H.policyWith({ providers: ['DERIBIT'] }));
  return createResearchOwner({ policy: dp, subjects: subjects(), clock: () => T0, researchRoot: tmp(), fetchImpl: async (url) => { const u = new URL(url); paths.push(u.pathname + u.search); if (u.pathname.endsWith('get_instruments')) return json(DERIBIT_FOUR); if (u.pathname.endsWith('get_book_summary_by_currency')) return json(deribitFourSummaries()); if (u.pathname.endsWith('/ticker')) { const t = deribitTicker(u.searchParams.get('instrument_name')); return t ? json(t) : json({ error: { code: 1 } }, 400); } return json({}, 404); } });
}
test('MC-J04 (R03). the production owner enriches admitted Deribit options through the registered ticker path: Greeks reach the context surface and the 25-delta arithmetic reproduces the independent fixture oracle (RR = 0.60 - 0.72 = -0.12; butterfly = (0.60 + 0.72) / 2 - 0.65 = 0.01)', async () => {
  const paths = []; const dout = await deribitOwner(paths);
  try {
    const dq = await dout.acquire('OPTIONS_TERM_SKEW', 'BTC');
    assert.ok(paths.some((p) => /\/ticker\?/.test(p)), `the owner must call the registered ticker path (paths ${JSON.stringify(paths)})`);
    const ticks = dq.observations.filter((o) => o.kind === 'OPTION_TICK'); assert.ok(ticks.some((o) => o.payload.delta !== null), 'a parsed Greek reaches the observations');
    const dc = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: dq.observations, coverage: dq.coverage, captureRef: { bundleId: 'audit' } });
    const surf = dc.context.families.OPTIONS_TERM_SKEW.components.find((c) => c.metricId === 'atm_iv_term').value;
    assert.equal(surf.term.length, 1); assert.equal(surf.term[0].contracts, 4, 'summary + ticker of one instrument is ONE contract'); assert.ok(Math.abs(surf.term[0].riskReversal25d - (-0.12)) < 1e-9, `RR ${surf.term[0].riskReversal25d}`); assert.ok(Math.abs(surf.term[0].butterfly25d - 0.01) < 1e-9, `BF ${surf.term[0].butterfly25d}`);
  } finally { await dout.stop({ seal: false }); }
});

test('MC-W05 (R02). one OPTION_TICK without an instrument census cannot claim census completeness; a complete census (census record + all instruments) does', async () => {
  const paths = []; const dout = await deribitOwner(paths);
  try {
    const dq = await dout.acquire('OPTIONS_TERM_SKEW', 'BTC'); const ticks = dq.observations.filter((o) => o.kind === 'OPTION_TICK');
    const partial = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: ticks.slice(0, 1), coverage: [], captureRef: { bundleId: 'audit' } }).context.families.OPTIONS_TERM_SKEW.components[0].value;
    assert.equal(partial.censusComplete, false, 'no census evidence => not complete'); assert.notEqual(partial.support.state, 'COMPLETE');
    const full = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: dq.observations, coverage: dq.coverage, captureRef: { bundleId: 'audit' } }).context.families.OPTIONS_TERM_SKEW.components[0].value;
    assert.equal(full.censusComplete, true, 'the real census (instruments + census coverage) establishes completeness for its named scope');
  } finally { await dout.stop({ seal: false }); }
});

test('MC-J01 (R03). the exact exit-liquidity oracle (asks 101x1, bids 99x3, notional 101 => 198.01980198 bps) is numeric evidence in the default summary AND under an explicit DETAIL request, and is present in the serialized model request', async () => {
  const { ko, market } = await krakenBookOnly();
  try {
    const exitBook = ko.clients.KRAKEN_SPOT.bookSnapshotObservation({ market, levels: { bids: [[99, 3]], asks: [[101, 1]] }, receivedTs: T0, epochId: null, synced: true, checksumOk: true, sampleReason: 'INTERVAL', pricePrecision: 1, qtyPrecision: 8 }); assert.equal(observationError(exitBook), null);
    const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: [exitBook], coverage: [], captureRef: { bundleId: 'audit' }, referenceNotionals: [101] }).context;
    const rt = ctx.families.DISPLAYED_LIQUIDITY.components.find((c) => c.metricId === 'round_trip_loss').value.current; assert.equal(rt.coverage, 'FULL'); assert.ok(Math.abs(rt.lossBps - 1e4 * 2 / 101) < 1e-4);
    for (const detailRequests of [[], [{ family: 'DISPLAYED_LIQUIDITY', metricId: 'round_trip_loss' }]]) {
      const b = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: T0, trigger: { kind: 'MARKET_RESEARCH' }, detailRequests }); assert.equal(b.ok, true, JSON.stringify(b.detail ?? null));
      const items = b.packet.evidence.filter((e) => e.kind === 'MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE'); assert.equal(items.length, 1, `exactly one exit-liquidity item (detail ${detailRequests.length})`);
      const f = items[0].value.fields; assert.equal(f.quoteNotional, 101); assert.ok(Math.abs(f.currentLossBps - 198.01980198) < 1e-6, `lossBps ${f.currentLossBps}`); assert.equal(f.currentCoverage, 'FULL'); assert.equal(f.worstBuyPrice, 101); assert.equal(f.worstSellPrice, 99); assert.ok(items[0].value.sourceIds.length >= 1 && items[0].sourceRefs.length >= 1);
      assert.equal(b.contextMap.omitted.detail.some((d) => d.metricId === 'round_trip_loss' && d.reason === 'DETAIL_NOT_REQUESTED'), false, 'an admitted metric is not simultaneously reported as omitted');
      const body = buildRequestBody({ model: 'claude-sonnet-5', maxTokens: 256, packet: b.packet, subjectRefs: ['BTC'], metricRegistry: METRIC_REGISTRY, allowedMaxAgeMs: ALLOWED_MAX_AGE_MS });
      assert.ok(body.json.includes('MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE') && /198\.0198/.test(body.json), 'the serialized request carries the numeric exit loss');
    }
  } finally { await ko.stop({ seal: false }); }
});

test('MC-J02 (R03). venue mid dispersion reaches a packet as MARKET_MULTI_VENUE_CONTEXT independently of the peer component (no peer cohort exists here)', async () => {
  const { ko, market } = await krakenBookOnly();
  try {
    const kb = ko.clients.KRAKEN_SPOT.bookSnapshotObservation({ market, levels: { bids: [[99, 3]], asks: [[101, 1]] }, receivedTs: T0, epochId: null, synced: true, checksumOk: true, sampleReason: 'INTERVAL', pricePrecision: 1, qtyPrecision: 8 });
    const cbMarket = { subject: { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: 'BTC-USD', venue: 'coinbase', nativeSymbol: 'BTC-USD', base: 'BTC', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: 'COINBASE_USD_USDC' } };
    const cb = { ...kb, provider: 'COINBASE_SPOT', endpointId: 'ws-feed', subject: cbMarket.subject, payload: { ...kb.payload, bids: [[100, 3]], asks: [[102, 1]] } };
    const { makeObservation } = await import('../market-lab/contracts.js'); const { observationId, ...rest } = cb; const cbo = makeObservation(rest);
    const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: [kb, cbo], coverage: [], captureRef: { bundleId: 'audit' }, referenceNotionals: [101] }).context;
    const vd = ctx.families.CROSS_VENUE.components.find((c) => c.metricId === 'venue_mid_dispersion'); assert.equal(vd.value.dispersion.n, 2); assert.ok(Math.abs(vd.value.dispersion.dispersionBps - 1e4 * (101 - 100) / 100.5) < 1e-6);
    const b = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: T0, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(b.ok, true);
    const item = b.packet.evidence.find((e) => e.kind === 'MARKET_MULTI_VENUE_CONTEXT'); assert.ok(item, 'the dispersion reaches the packet'); assert.equal(item.value.fields.n, 2); assert.ok(Math.abs(item.value.fields.dispersionBps - vd.value.dispersion.dispersionBps) < 1e-9);
    assert.ok(b.packet.evidence.some((e) => e.kind === 'MARKET_PEER_RELATIVE_MOVE'), 'the peer summary is still present (insufficient cohort, honestly)');
  } finally { await ko.stop({ seal: false }); }
});

test('MC-J06 (R03). Coin Metrics disabled + CryptoQuant explicitly entitled: NETWORK_ACTIVITY acquisition issues the mapped network-data / market-indicator requests and the parsed active-address value reaches the context', async () => {
  const raw = H.policyWith({ providers: ['CRYPTOQUANT'] }); Object.assign(raw.providers.CRYPTOQUANT.plan, { name: 'closeout fixture', billing: 'INCLUDED_QUOTA', includedCallsPerMonth: 100, remainingCalls: 100, incrementalUsdPerCall: 0, attestation: 'offline fixture only', verifiedDate: '2026-09-08' }); Object.assign(raw.providers.CRYPTOQUANT.limits, { maxCallsPerDay: 100, maxCallsPerMonth: 100 });
  const requests = []; const nr = createResearchOwner({ policy: loadPolicy(raw), subjects: subjects(), clock: () => T0, env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, researchRoot: tmp(), fetchImpl: async (url) => { const u = new URL(url); requests.push(u.pathname); const field = { 'addresses-count': 'addresses_count_active', 'transactions-count': 'transactions_count_total', 'tokens-transferred': 'tokens_transferred_total', supply: 'supply_total', mvrv: 'mvrv', sopr: 'sopr', 'realized-price': 'realized_price' }[u.pathname.split('/').at(-1)]; return field ? json(H.cryptoquantSeries({ field })) : json({}, 404); } });
  try {
    const na = await nr.acquire('NETWORK_ACTIVITY', 'BTC');
    assert.ok(requests.some((p) => p.includes('/network-data/')), `network-data requested (${JSON.stringify(requests)})`); assert.ok(requests.some((p) => p.includes('/market-indicator/')), 'market-indicator requested');
    const aa = na.observations.filter((o) => o.payload.metricId === 'active_addresses'); assert.ok(aa.length >= 1, 'active_addresses observed');
    const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: na.observations, coverage: na.coverage, captureRef: { bundleId: 'audit' } }).context;
    const comp = ctx.families.NETWORK_ACTIVITY.components.find((c) => c.metricId === 'active_addresses' && c.value.nativeMetric === 'active_addresses'); assert.ok(comp, 'active_addresses component'); assert.equal(comp.value.provider, 'CRYPTOQUANT'); assert.equal(typeof comp.value.value, 'number');
  } finally { await nr.stop({ seal: false }); }
});

test('MC-B01 (R04). a DETAIL request for active_addresses with only exchange_reserve observations retained is NOT satisfied and admits nothing', async () => {
  const raw = H.policyWith({ providers: ['CRYPTOQUANT'] }); Object.assign(raw.providers.CRYPTOQUANT.plan, { name: 'closeout fixture', billing: 'INCLUDED_QUOTA', includedCallsPerMonth: 100, remainingCalls: 100, incrementalUsdPerCall: 0, attestation: 'offline fixture only', verifiedDate: '2026-09-08' }); Object.assign(raw.providers.CRYPTOQUANT.limits, { maxCallsPerDay: 100, maxCallsPerMonth: 100 }); const policy = loadPolicy(raw);
  const own = createResearchOwner({ policy, subjects: subjects(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: tmp(), fetchImpl: async (url) => { const metric = new URL(url).pathname.split('/').at(-1); return json(H.cryptoquantSeries({ field: { inflow: 'inflow_total', outflow: 'outflow_total', reserve: 'reserve' }[metric] })); } });
  const aq = await own.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); await own.stop({ seal: false });
  const reserveObs = aq.observations.filter((o) => o.payload.metricId === 'exchange_reserve'); assert.ok(reserveObs.length >= 1);
  const req = { requestKey: 'Q1', requestKind: 'DETAIL', family: 'NETWORK_ACTIVITY', metricIds: ['active_addresses'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: 3_600_000, hypothesisRefs: [], question: 'What is the current active-address count?', interpretationIfSupported: 'Assess valuation context.', interpretationIfContradicted: 'Withhold that explanation.' };
  assert.equal(dataRequestError(req, { allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, metricRegistry: METRIC_REGISTRY, packetAsOfTs: T0, subjectRefs: ['BTC'] }), null);
  const broker = createBroker({ owner: { observations: () => reserveObs, coverage: () => [], acquire: async () => { throw new Error('DETAIL must be local'); } }, policy, clock: () => T0 });
  const br = await broker.resolve(req, { analysisId: 'audit-analysis', caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs: T0, deadlineTs: T0 + 1000 });
  assert.notEqual(br.state, 'SATISFIED', 'exchange_reserve is not an active-address observation'); assert.equal(br.observationsAdmitted, 0); assert.deepEqual(br.observationIds, []);
});

test('MC-S03 (R05). the 4000-byte segment / two-trade hot-cap witness: collection must either rotate into sealed segments before overflow or stop at the resource boundary with the first error preserved; it can never keep an unbounded side array while hot state suggests two', async () => {
  const p = H.policyWith({ providers: ['KRAKEN_SPOT'] }); p.resources.segmentBytes = 4000; p.resources.tradesPerHotSymbol = 2;
  const s = H.subjectsWith(); s.subjects = s.subjects.slice(0, 1); s.macroSeries = []; s.crossAsset = []; s.stablecoins = [];
  const schedules = []; const timers = { setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; schedules.push(h); return h; }, clearInterval: () => {}, setTimeout, clearTimeout };
  let now = T0; const dir = tmp();
  const o = createResearchOwner({ policy: loadPolicy(p), subjects: loadSubjects(s), clock: () => now, mode: 'INTEGRATED', timers, researchRoot: dir, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS) });
  try {
    await o.start({ outDir: path.join(dir, 'capture'), families: [] });
    for (let i = 1; i <= 40; i += 1) { now += 1; o.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 1, price: 100, eventTs: now, receivedTs: now, tradeId: i, ordType: null, snapshot: false }); }
    schedules.find((x) => x.ms === 250).fn();
    const before = o.status(); const stop = await o.stop();
    const rotated = before.sealed.length >= 1 && before.segment !== null; const stoppedWithError = before.stopped === true && before.recording?.error;
    assert.ok(rotated || stoppedWithError, `either lawful rotation or an explicit resource stop (sealed ${before.sealed.length}, segment ${before.segment ? 'open' : 'null'}, stopped ${before.stopped})`);
    if (rotated) { assert.ok(stop.sealed || stop.sealed === null, 'stop returns'); const dirs = readdirSync(dir).filter((d) => d.startsWith('capture')); assert.ok(dirs.length >= 2 || before.sealed.length >= 2, 'more than one sealed segment for 41 records under a 4000-byte bound'); }
    else { assert.ok(stop.error, 'the first recording error is preserved in the stop result'); assert.ok(!existsSync(path.join(dir, 'capture', 'manifest.json')), 'no completion manifest for a failed segment'); }
    assert.ok(before.retained.observations <= before.limits.retainedObservations, 'the retained observation list is bounded by a declared limit');
  } finally { await o.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-L01 (R06). runtime.close() is an ownership barrier: with a Messages response held open, close aborts the owned request, keeps the budget lock until the drain completes, and a late valid response never becomes COMPLETED', async () => {
  const fx = corpusCases().find((c) => c.id === 'C01'); const dir = tmp(); let send; let responseSignal; let waitDispatch; const dispatched = new Promise((r) => { waitDispatch = r; });
  const fetchStub = async (url, init) => { if (new URL(url).pathname.endsWith('count_tokens')) return json({ input_tokens: 1000 }); responseSignal = init.signal; waitDispatch(); return new Promise((resolve, reject) => { send = resolve; init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true }); }); };
  const policy = loadPolicy(H.policyWith({ model: { enabled: true, maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 5, maxEstimatedUsdPerMonth: 50, maxOutputTokens: 2048 } }));
  const rt = createCaseRuntime({ policy, env: { ANTHROPIC_API_KEY: 'offline-fixture' }, clock: () => T0, budgetDir: path.join(dir, 'budget'), fetchImpl: fetchStub });
  try {
    const h = rt.runCase({ packet: fx.packet, out: path.join(dir, 'case') }); await dispatched; assert.ok(existsSync(path.join(dir, 'budget', 'budget.lock')));
    const closing = rt.close(); assert.ok(closing && typeof closing.then === 'function', 'close returns a promise (async barrier)');
    await new Promise((r) => setTimeout(r, 20)); assert.equal(responseSignal.aborted, true, 'the owned Messages request is aborted at close');
    await closing; assert.equal(existsSync(path.join(dir, 'budget', 'budget.lock')), false, 'the lock is released only after the drain');
    if (send) send(json({ type: 'message', id: 'late', model: policy.model.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fx.scripted) }], usage: { input_tokens: 1000, output_tokens: 300 } }));
    const result = await h.done; assert.notEqual(result.status, 'COMPLETED', 'a late response cannot become the active final report'); assert.ok(['CANCELLED', 'DEADLINE_EXCEEDED', 'MODEL_FAILED'].includes(result.status), result.status);
    assert.ok(rt.status().closed === true);
  } finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-V01 (R07). a string spreadBps with correctly recomputed component / context identities is rejected by contextError (schema truth is shared, not just checksums)', async () => {
  const { ko, market } = await krakenBookOnly();
  try {
    const book = ko.clients.KRAKEN_SPOT.bookSnapshotObservation({ market, levels: { bids: [[99, 3]], asks: [[101, 1]] }, receivedTs: T0, epochId: null, synced: true, checksumOk: true, sampleReason: 'INTERVAL', pricePrecision: 1, qtyPrecision: 8 });
    const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: [book], coverage: [], captureRef: { bundleId: 'audit' }, referenceNotionals: [101] }).context;
    assert.equal(contextError(ctx), null, 'the lawful context passes');
    const hostile = structuredClone(ctx); const c = hostile.families.DISPLAYED_LIQUIDITY.components.find((x) => x.metricId === 'spread_bps'); c.value.spreadBps = 'AUDIT_INVALID_NUMERIC_VALUE';
    const cb = Object.fromEntries(COMPONENT_KEYS.filter((k) => k !== 'componentId').map((k) => [k, c[k]])); c.componentId = `mcc-${canonicalDigest(cb).slice(0, 40)}`; hostile.contextId = contextIdentity(hostile);
    const e = contextError(hostile); assert.ok(e, 'a string in a numeric slot must reject'); assert.match(e, /spread_bps|spreadBps/);
  } finally { await ko.stop({ seal: false }); }
});

test('MC-RD01/MC-RD02 (readiness). a PASSED smoke on an unrelated endpoint does not make a family LIVE without obtained family evidence; null model readiness never yields READINESS_GREEN', () => {
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] }));
  const rows = providerReadiness({ policy, env: {}, testReport: Object.fromEntries(Object.keys(policy.providers).map((id) => [id, 'PASSED'])), liveReport: { KRAKEN_SPOT: { state: 'PASSED', ts: T0, endpointId: 'rest-asset-pairs', asset: 'BTC', evidence: 'catalog of 640 pairs' } } });
  const m = liveReadinessManifest({ rows, familyCoverage: null, modelReadiness: null, generatedTs: T0 });
  assert.notEqual(m.families.SPOT_FLOW.state, 'LIVE', 'a catalog smoke is not obtained SPOT_FLOW coverage'); assert.notEqual(m.families.DISPLAYED_LIQUIDITY.state, 'LIVE');
  const all = providerReadiness({ policy, env: {}, testReport: Object.fromEntries(Object.keys(policy.providers).map((id) => [id, 'PASSED'])), liveReport: Object.fromEntries(Object.keys(policy.providers).map((id) => [id, { state: 'PASSED', ts: T0, endpointId: 'x', asset: 'BTC', evidence: 'synthetic' }])) });
  const m2 = liveReadinessManifest({ rows: all, familyCoverage: null, modelReadiness: null, generatedTs: T0 });
  assert.notEqual(m2.overall, 'READINESS_GREEN', 'null model readiness cannot be green');
});
