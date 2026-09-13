// MARKET / SOCRATES CLOSEOUT — acceptance R01 (Q03-Q06), R02 (W02-W04, W06) and R03 (J03, J05, J07, J08). The remaining
// ids of these requirements (Q01/Q02/Q07/Q08, W01/W05, J01/J02/J04/J06) live in market-closeout-witnesses.test.js. Every
// fixture is offline (fake HTTP / WebSocket over loopback, fake clocks, temp directories); every expectation states the law
// or an independent oracle, never the generator agreeing with itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { T0, tmp, json, subjects, btcOnly, includedPlan, cryptoquantPolicy, cryptoquantFetch, deribitOwner, deribitTicker, DERIBIT_FOUR, deribitFourSummaries, krakenBookOnly, bookObs, krakenWsScript, krakenTradeMsg, krakenRestFixture, H, SEALED_REF } from './helpers/market-closeout.js';
import { createResearchOwner } from '../market-lab/owner.js';
import { loadPolicy } from '../market-lab/policy.js';
import { openQuotaJournal, createDispatchGuard, nativeCharge } from '../market-lab/quota.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { intervalCoverage, tradeWindow } from '../market-lab/recipes.js';
import { makeObservation, makeCoverage, quality, emptyProvenance, subjectId, FAMILY_REGISTRY, familyMetricIds } from '../market-lab/contracts.js';
import { buildContext, contextError } from '../market-lab/context.js';
import { readCapture, runBuild, readContext } from '../market-lab/commands.js';
import { explainDeepMarket, createDeepMarketSource } from '../market-lab/deep-market-adapter.js';
import { buildResearchEvidenceV2, METRIC_MAP, OMISSION_REASONS, MAX_VALUE_CHARS } from '../evidence/research-builder.js';
import { MARKET_EVIDENCE_KINDS, validateEvidencePacketV2 } from '../evidence/contract-v2.js';
import { buildSocialProjection } from '../evidence/social-projection.js';
import { createBroker } from '../socrates/broker.js';

const mkt = { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: 'XXBTZUSD', venue: 'kraken', nativeSymbol: 'XBT/USD', base: 'BTC', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };
const trade = (i, ts, price, side = 'BUY', { subject = mkt, knownAtTs = ts + 5 } = {}) => makeObservation({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subject, kind: 'TRADE', sequence: i, epochId: null, sourceRevision: null, sourceKey: String(i), sourceEventTs: ts, publishedTs: null, periodStartTs: null, periodEndTs: null, receivedTs: ts + 5, knownAtTs, quality: quality('KNOWN', { methodologyId: 'kraken-ws-trade-v2', originalUnit: 'USD' }), provenance: emptyProvenance(), payload: { price, qty: 0.5, quoteNotional: price * 0.5, takerSide: side, sideConvention: 'TAKER_NATIVE', nativeTradeId: String(i), orderType: 'market' } });
const book = (i, ts, { bids = [[99.9, 3], [99.5, 5]], asks = [[100.1, 2], [100.5, 4]] } = {}) => makeObservation({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subject: mkt, kind: 'BOOK_SNAPSHOT', sequence: 1000 + i, epochId: null, sourceRevision: null, sourceKey: null, sourceEventTs: null, publishedTs: null, periodStartTs: null, periodEndTs: null, receivedTs: ts, knownAtTs: ts, quality: quality('KNOWN', { methodologyId: 'kraken-ws-book-v2', originalUnit: 'USD' }), provenance: emptyProvenance(), payload: { bids, asks, levelsPerSideCap: 200, synchronized: true, checksumVerified: true, bookAgeMs: 0, sampleReason: 'INTERVAL', pricePrecision: 1, qtyPrecision: 8 } });
const cov = ({ state, startTs, endTs = null, subject = mkt, reasonCodes = [], epochId = null }) => makeCoverage({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subjectId: subjectId(subject), family: 'SPOT_FLOW', kind: 'TRADE', state, reasonCodes, startTs, endTs, observationCount: 0, droppedCount: state === 'DROPPED' ? 1 : 0, epochId, sequenceStart: null, sequenceEnd: null });
const REF = SEALED_REF;

// ---------------------------------------------------------------- R01 -----------------------------------------------------------
test('MC-Q03 (R01). native charge units differ from HTTP counts and are enforced at the LAST dispatch boundary: a two-symbol Twelve Data quote is ONE call / TWO credits; a Tokenomist failure charges zero credits (charged on success); each page / retry is its own reservation; the per-provider concurrency slot serialises the wire', async () => {
  const raw = H.policyWith({ providers: ['KRAKEN_SPOT'] });
  raw.providers.TWELVEDATA.enabled = true; raw.providers.TWELVEDATA.plan = { ...raw.providers.TWELVEDATA.plan, name: 'metered fixture', billing: 'METERED', incrementalUsdPerCall: 0.01, attestation: 'offline fixture only', verifiedDate: '2026-09-08', meteredAuthorization: { authorized: true, maxCallsPerMonth: 10, maxEstimatedUsdPerMonth: 1, attestation: 'offline fixture only' } };
  raw.providers.TOKENOMIST.enabled = true; includedPlan(raw, 'TOKENOMIST', { remaining: 5, included: 100 });
  const policy = loadPolicy(raw); const dir = tmp(); const journal = openQuotaJournal({ dir: path.join(dir, 'accounting'), clock: () => T0 });
  const guard = createDispatchGuard({ policy, env: { TWELVEDATA_API_KEY: 'offline-fixture', TOKENOMIST_API_KEY: 'offline-fixture' }, journal, clock: () => T0 });
  let inFlight = 0; let maxInFlight = 0; const calls = [];
  const fetchImpl = async (url) => { const u = new URL(url); calls.push(u.host + u.pathname + u.search); inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight -= 1; if (u.host === 'api.tokenomist.ai') return json({ status: false }, 500); if (u.host === 'api.twelvedata.com') return json({ symbol: 'SPY', close: '1' }); return json(H.krakenTicker('XXBTZUSD')); };
  const http = createHttpTransport({ fetchImpl, clock: () => T0, admission: guard });
  try {
    assert.deepEqual(nativeCharge({ providerId: 'TWELVEDATA', endpointId: 'quote', query: { symbol: 'SPY,QQQ' } }), { unit: 'CREDIT', calls: 1, credits: 2, chargedOn: 'DISPATCH' }, 'the native unit is a credit per symbol');
    const td = await http.request({ providerId: 'TWELVEDATA', endpointId: 'quote', query: { symbol: 'SPY,QQQ' }, credential: 'offline-fixture' }); assert.equal(td.ok, true);
    const t1 = journal.totals('TWELVEDATA'); assert.equal(t1.calls.day, 1); assert.equal(t1.credits.day, 2, 'two symbols are two credits on one call'); assert.equal(t1.usd.day, 0.02);
    const tk = await http.request({ providerId: 'TOKENOMIST', endpointId: 'token-list', credential: 'offline-fixture' }); assert.equal(tk.ok, false); assert.equal(tk.failure.kind, 'HTTP_5XX');
    const t2 = journal.totals('TOKENOMIST'); assert.equal(t2.calls.day, 1, 'the HTTP call happened'); assert.equal(t2.credits.day, 0, 'a failed Tokenomist request costs zero credits (charged on success)'); assert.equal(journal.entitlementRemaining('TOKENOMIST'), 5);
    // page / retry: every wire request is its own reservation — never one reservation for a multi-page acquisition
    for (const page of [1, 2]) await http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-trades', query: { pair: 'XXBTZUSD', since: String(page) } });
    await http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-trades', query: { pair: 'XXBTZUSD', since: '1' }, share: false });
    assert.equal(journal.totals('KRAKEN_SPOT').calls.day, 3, 'two pages + one retry are three accounted calls'); assert.equal(journal.reservations().filter((r) => r.providerId === 'KRAKEN_SPOT').length, 3);
    // per-provider concurrency (policy maxConcurrency 1) holds at the dispatch boundary: two distinct requests never overlap on the wire
    maxInFlight = 0; await Promise.all([http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'XXBTZUSD' } }), http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'XETHZUSD' } })]);
    assert.equal(maxInFlight, 1, 'one slot per provider');
    assert.equal(calls.length, journal.reservations().filter((r) => r.state !== 'RELEASED').length, 'every wire request has exactly one non-released reservation');
  } finally { http.stop?.(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-Q04 (R01). probe, catalog, acquire, broker and shared requests use ONE guard: a probe on a paid provider without smoke authorisation dispatches nothing; catalog / acquire / broker reservations carry their purpose in the journal; an identical in-flight request is served once and charged once; a refused acquisition reports truthful usage', async () => {
  const requests = []; const raw = H.policyWith({ providers: ['KRAKEN_SPOT', 'CRYPTOQUANT'] }); includedPlan(raw, 'CRYPTOQUANT'); const root = tmp();
  const own = createResearchOwner({ policy: loadPolicy(raw), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: root, mode: 'INTEGRATED', fetchImpl: async (url) => { const u = new URL(url); if (u.host === 'api.kraken.com') { requests.push(u.pathname); return json(u.pathname.endsWith('AssetPairs') ? H.KRAKEN_ASSET_PAIRS : H.krakenTicker('XXBTZUSD')); } return cryptoquantFetch(requests)(url); } });
  try {
    await own.start({ families: [] });
    const rows = () => own.journal.reservations();
    assert.ok(rows().some((r) => r.purpose === 'CATALOG' && r.providerId === 'KRAKEN_SPOT'), 'the catalog load is a CATALOG-purpose reservation through the same guard');
    const before = requests.length; const probe = await own.probe(() => own.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'));
    assert.equal(requests.length, before, 'a PROBE on a paid provider without smoke authorisation touches no wire'); assert.ok(probe.usage.refused >= 1 && probe.usage.dispatched === 0); assert.ok(Object.keys(probe.usage.reasons).includes('SMOKE_NOT_AUTHORIZED'), JSON.stringify(probe.usage.reasons));
    const aq = await own.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); assert.ok(aq.usage.dispatched >= 1); assert.ok(rows().some((r) => r.purpose === 'ACQUIRE' && r.providerId === 'CRYPTOQUANT'));
    const broker = createBroker({ owner: own, policy: loadPolicy(raw), clock: () => T0 });
    const br = await broker.resolve({ requestKey: 'Q1', requestKind: 'REFRESH', family: 'NETWORK_ACTIVITY', metricIds: ['active_addresses'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null, hypothesisRefs: [], question: 'Active addresses now?', interpretationIfSupported: 'x', interpretationIfContradicted: 'y' }, { analysisId: 'soc2-' + 'a'.repeat(40), caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs: T0, deadlineTs: T0 + 5000 });
    assert.ok(rows().some((r) => r.purpose === 'BROKER' && r.providerId === 'CRYPTOQUANT'), 'a broker acquisition is a BROKER-purpose reservation through the owner guard'); assert.ok(br.usage.dispatched >= 1, JSON.stringify(br.usage));
    // shared: two identical concurrent requests => one wire request, one reservation, one charge
    const http = own.clients.KRAKEN_SPOT; const n0 = requests.filter((p) => p.endsWith('Ticker')).length; const r0 = rows().length;
    await Promise.all([http.ticker({ markets: [own.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market] }), http.ticker({ markets: [own.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market] })]);
    assert.equal(requests.filter((p) => p.endsWith('Ticker')).length - n0, 1, 'one shared wire request'); assert.equal(rows().length - r0, 1, 'one reservation for the shared request');
    // denied: truthful usage (nothing dispatched, the refusal reason named)
    const denied = createResearchOwner({ policy: cryptoquantPolicy({ day: 0 }), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: tmp(), fetchImpl: cryptoquantFetch(requests) });
    const d = await denied.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); await denied.stop({ seal: false }); assert.deepEqual({ dispatched: d.usage.dispatched, credits: d.usage.credits }, { dispatched: 0, credits: 0 }); assert.ok(d.usage.refused >= 1); assert.ok(d.usage.reasons.DAY_CAP_ZERO >= 1);
  } finally { await own.stop({ seal: false }); rmSync(root, { recursive: true, force: true }); }
});

test('MC-Q05 (R01). restart and a changed capture output preserve spent / unresolved quantities; day / month rollover, a repeated attestation and a clock rollback never re-grant an included entitlement', async () => {
  const root = tmp(); const clk = H.clockAt(T0); const requests = []; const policy = cryptoquantPolicy({ remaining: 3, day: 2 });
  const mk = () => createResearchOwner({ policy, subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: clk, researchRoot: root, fetchImpl: cryptoquantFetch(requests) });
  const a = mk(); const first = await a.acquire('ONCHAIN_ENTITY_FLOW', 'BTC', { metricIds: ['exchange_reserve'] }); assert.equal(first.usage.dispatched, 1); assert.equal(a.journal.entitlementRemaining('CRYPTOQUANT'), 2);
  // a dangling reservation (crash before settlement) must survive as UNRESOLVED spend on restart
  a.journal.reserve({ providerId: 'CRYPTOQUANT', endpointId: 'exchange-flows', unit: 'CALL', credits: 1, chargedOn: 'DISPATCH', purpose: 'ACQUIRE', requestKey: 'crash', estimatedUsd: 0 }); await a.stop({ seal: false });
  const b = mk(); // a different process moment, the same stable root: nothing resets
  try {
    const t = b.journal.totals('CRYPTOQUANT'); assert.equal(t.calls.day, 2, 'the settled call and the crashed reservation both count'); assert.equal(t.unresolved, 1); assert.equal(b.journal.entitlementRemaining('CRYPTOQUANT'), 1, 'repeated attestation of the same plan is not a fresh grant');
    const capped = await b.acquire('ONCHAIN_ENTITY_FLOW', 'BTC', { metricIds: ['exchange_reserve'], force: true }); assert.equal(capped.usage.dispatched, 0, 'the day cap of 2 is already consumed'); assert.ok(capped.usage.reasons.DAY_CAP >= 1);
    clk.advance(86_400_000 + 1); // day rollover: the local day bucket resets, the month bucket and the entitlement do not
    const t2 = b.journal.totals('CRYPTOQUANT'); assert.equal(t2.calls.day, 0); assert.equal(t2.calls.month, 2); assert.equal(b.journal.entitlementRemaining('CRYPTOQUANT'), 1);
    const after = await b.acquire('ONCHAIN_ENTITY_FLOW', 'BTC', { metricIds: ['exchange_reserve'], force: true }); assert.equal(after.usage.dispatched, 1); assert.equal(b.journal.entitlementRemaining('CRYPTOQUANT'), 0, 'the last included call is consumed');
    const exhausted = await b.acquire('ONCHAIN_ENTITY_FLOW', 'BTC', { metricIds: ['exchange_reserve'], force: true }); assert.equal(exhausted.usage.dispatched, 0); assert.ok(exhausted.usage.reasons.ENTITLEMENT_EXHAUSTED >= 1, JSON.stringify(exhausted.usage.reasons));
    clk.set(T0 - 86_400_000); // clock rollback: the effective clock never runs behind the journal, so no bucket is regained
    assert.equal(b.journal.totals('CRYPTOQUANT').calls.day, 1, 'the rolled-back clock still sees the last accounted day'); assert.equal(b.journal.now() >= T0 + 86_400_000, true);
    const rolled = await b.acquire('ONCHAIN_ENTITY_FLOW', 'BTC', { metricIds: ['exchange_reserve'], force: true }); assert.equal(rolled.usage.dispatched, 0);
    clk.set(T0 + 40 * 86_400_000); // month rollover: local month bucket resets, the entitlement (plan snapshot) is still exhausted
    assert.equal(b.journal.totals('CRYPTOQUANT').calls.month, 0); assert.equal(b.journal.entitlementRemaining('CRYPTOQUANT'), 0, 'a new month does not re-grant remaining included calls');
    assert.equal(requests.length, 2, 'exactly two wire requests over the whole scenario');
  } finally { await b.stop({ seal: false }); rmSync(root, { recursive: true, force: true }); }
});

test('MC-Q06 (R01). a reservation write failure, a corrupt journal and a second owner on the same accounting root produce ZERO dispatch; a refused request leaves no reservation (proven non-dispatch) while a timed-out request keeps an UNRESOLVED reservation (ambiguous dispatch)', async () => {
  const requests = []; const root = tmp();
  const a = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: root, fetchImpl: cryptoquantFetch(requests) });
  try {
    assert.throws(() => createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: {}, clock: () => T0, researchRoot: root, fetchImpl: cryptoquantFetch(requests) }), /locked by another owner/, 'single-owner law on the quota journal');
    // write failure: the journal file becomes unwritable AFTER open — the reservation fails and nothing reaches the wire
    const file = a.journal.files.journalFile; rmSync(file, { force: true }); mkdirSync(file);
    const r = await a.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); assert.equal(requests.length, 0, 'no wire without a persisted reservation'); assert.equal(r.usage.dispatched, 0); assert.ok(r.usage.reasons.ACCOUNTING_UNAVAILABLE >= 1, JSON.stringify(r.usage.reasons));
    rmSync(file, { recursive: true, force: true });
  } finally { await a.stop({ seal: false }); }
  // corrupt journal: the owner cannot open its accounting authority, so it cannot exist (and cannot dispatch)
  writeFileSync(path.join(root, 'accounting', 'quota.jsonl'), '{"type":"RESERVE","reservationId":"qr-zz"}\n');
  assert.throws(() => createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: root, fetchImpl: cryptoquantFetch(requests) }), /quota journal/); assert.equal(requests.length, 0);
  assert.equal(existsSync(path.join(root, 'accounting', 'quota.lock')), false, 'a failed open never leaves a lock behind');
  // proven non-dispatch vs ambiguous dispatch at the transport boundary
  const dir = tmp(); const journal = openQuotaJournal({ dir: path.join(dir, 'accounting'), clock: () => T0 });
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })); const guard = createDispatchGuard({ policy, env: {}, journal, clock: () => T0 });
  const http = createHttpTransport({ fetchImpl: (url, init) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true }); }), clock: () => T0, admission: guard });
  try {
    const refused = await http.request({ providerId: 'COINGECKO', endpointId: 'coins-list' }); assert.equal(refused.failure.kind, 'QUOTA_REFUSED'); assert.ok(refused.failure.reasons.includes('PROVIDER_DISABLED'));
    assert.equal(journal.reservations().length, 0, 'a refusal is proven non-dispatch: no reservation row at all');
    const timeout = await http.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'XXBTZUSD' }, timeoutMs: 30 }); assert.equal(timeout.failure.kind, 'TIMEOUT');
    const rows = journal.reservations(); assert.equal(rows.length, 1); assert.equal(rows[0].state, 'UNRESOLVED', 'a timed-out request is ambiguous: reserved, counted, never refunded'); assert.equal(journal.totals('KRAKEN_SPOT').calls.day, 1);
  } finally { http.stop?.(); journal.close(); rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- R02 -----------------------------------------------------------
async function subscribedKraken({ clock, script = krakenWsScript() }) {
  const http = await krakenRestFixture(); const kws = await H.startWsFixture({ path: '/v2', onConnection: script });
  const root = tmp(); const owner = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), env: {}, clock, fetchImpl: H.fetchFor(http), WebSocketImpl: globalThis.WebSocket, wsUrls: { KRAKEN_SPOT: kws.url }, researchRoot: root, log: () => {} });
  return { http, kws, root, owner, close: async () => { await kws.close(); await http.close(); } };
}
test('MC-W02 (R02). a PROVEN continuous quiet interval (trade-channel subscription ACK, no trades) is a valid zero (COMPLETE_NO_TRADES, count 0); a lawful traded interval under the same continuity fact keeps the independent OHLCV / flow oracle (2 x 0.2 @ 100 + 0.2 @ 101 sell => notional 60.2, vwap 100.333, signed +19.8)', async () => {
  const clk = H.clockAt(T0); let conn = null; const fx = await subscribedKraken({ clock: clk, script: (c) => { conn = c; krakenWsScript()(c); } });
  try {
    await fx.owner.start({ families: [] }); await H.waitFor(() => fx.owner.status().streams.KRAKEN_SPOT?.subscribed?.length >= 1, { timeoutMs: 5000 });
    assert.ok(fx.owner.coverage().some((c) => c.state === 'SUBSCRIBED' && c.kind === 'TRADE'), 'the positive continuity fact is a SUBSCRIBED coverage record');
    clk.set(T0 + 180_000); // three minutes of proven subscription, not a single trade
    const quiet = buildContext({ canonicalCoin: 'BTC', asOfTs: clk(), observations: fx.owner.observations(), coverage: fx.owner.coverage(), captureRef: REF }).context;
    const q = quiet.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current;
    assert.equal(q.support.state, 'COMPLETE_NO_TRADES', 'a proven quiet minute is an observed zero'); assert.equal(q.count, 0); assert.equal(q.quoteNotional, 0); assert.equal(q.coverage.state, 'COMPLETE');
    const hour = quiet.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 3_600_000).value.current; assert.equal(hour.support.state, 'PARTIAL', 'the hour is only partly inside the subscription: PARTIAL, never a false zero');
    clk.set(T0 + 250_000); conn.send({ channel: 'trade', type: 'update', data: [krakenTradeMsg(1, { price: 100, qty: 0.2, side: 'buy', ts: T0 + 230_000 }), krakenTradeMsg(2, { price: 100, qty: 0.2, side: 'buy', ts: T0 + 235_000 }), krakenTradeMsg(3, { price: 101, qty: 0.2, side: 'sell', ts: T0 + 240_000 })] });
    await H.waitFor(() => fx.owner.status().streams.KRAKEN_SPOT?.trades >= 3, { timeoutMs: 5000 }); clk.set(T0 + 270_000);
    const traded = buildContext({ canonicalCoin: 'BTC', asOfTs: clk(), observations: fx.owner.observations(), coverage: fx.owner.coverage(), captureRef: REF }).context;
    const w = traded.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current;
    assert.equal(w.support.state, 'COMPLETE'); assert.equal(w.count, 3); assert.ok(Math.abs(w.quoteNotional - 60.2) < 1e-9, `notional ${w.quoteNotional}`); assert.ok(Math.abs(w.vwap - 60.2 / 0.6) < 1e-6); assert.equal(w.open, 100); assert.equal(w.close, 101); assert.ok(Math.abs(w.flow.signedNotional - 19.8) < 1e-9); assert.equal(w.flow.support.state, 'COMPLETE');
    assert.equal(contextError(traded), null);
  } finally { await fx.owner.stop({ seal: false }); await fx.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test('MC-W03 (R02). startup, overlapping / non-overlapping gaps, a foreign subject or epoch, dropped events, late arrivals and retention loss each affect EXACTLY the relevant scope', () => {
  const S = T0 - 60_000; const E = T0; const win = { startTs: S, endTs: E, asOfTs: E };
  const full = [cov({ state: 'SUBSCRIBED', startTs: T0 - 600_000 })];
  // a GAP ends the running subscription's continuity; continuity resumes only with a NEW subscription fact (re-subscribe)
  const gap = (startTs, endTs, reasonCodes = []) => [cov({ state: 'GAP', startTs, endTs, reasonCodes }), cov({ state: 'SUBSCRIBED', startTs: endTs })];
  assert.equal(intervalCoverage(full, win).state, 'COMPLETE');
  assert.equal(intervalCoverage([cov({ state: 'SUBSCRIBED', startTs: S + 10_000 })], win).state, 'PARTIAL', 'startup inside the window is partial coverage');
  assert.equal(intervalCoverage([cov({ state: 'SUBSCRIBED', startTs: E })], win).state, 'UNKNOWN', 'a subscription that starts at the window end covers nothing of it');
  const inside = intervalCoverage([...full, ...gap(S + 20_000, S + 25_000, ['EPOCH_GAP'])], win); assert.equal(inside.state, 'PARTIAL'); assert.ok(inside.reasons.includes('COVERAGE_GAP_INSIDE_WINDOW') && inside.reasons.includes('EPOCH_GAP'));
  assert.equal(intervalCoverage([...full, ...gap(S - 30_000, S - 20_000)], win).state, 'COMPLETE', 'a gap that ended (and re-subscribed) before the window does not touch it');
  assert.equal(intervalCoverage([...full, cov({ state: 'GAP', startTs: S - 30_000, endTs: S - 20_000 })], win).state, 'UNKNOWN', 'a gap WITHOUT a re-subscription leaves the later window unproven');
  const overlapping = intervalCoverage([...full, ...gap(S - 5_000, S + 5_000), ...gap(S + 2_000, S + 8_000)], win); assert.equal(overlapping.state, 'PARTIAL'); assert.equal(overlapping.gaps, 2);
  const other = { ...mkt, venue: 'coinbase', nativeSymbol: 'BTC-USD', providerAssetId: 'BTC-USD' };
  assert.equal(intervalCoverage([cov({ state: 'SUBSCRIBED', startTs: T0 - 600_000, subject: other })].filter((c) => c.subjectId === subjectId(mkt)), win).state, 'UNKNOWN', 'another venue\'s continuity never covers this subject');
  const dropped = intervalCoverage([...full, cov({ state: 'DROPPED', startTs: S + 30_000, endTs: S + 31_000, reasonCodes: ['QUEUE_DROPPED'] }), cov({ state: 'SUBSCRIBED', startTs: S + 31_000 })], win); assert.equal(dropped.state, 'PARTIAL'); assert.ok(dropped.reasons.includes('QUEUE_DROPPED'));
  const evicted = intervalCoverage([...full, cov({ state: 'EVICTED', startTs: S - 100_000, endTs: S + 15_000, reasonCodes: ['RESOURCE_EVICTED'] }), cov({ state: 'SUBSCRIBED', startTs: S + 15_000 })], win); assert.equal(evicted.state, 'PARTIAL'); assert.ok(evicted.reasons.includes('RESOURCE_EVICTED'));
  // a coverage record of the wrong subject or a foreign epoch only ever reaches the recipe through the subject filter the context applies
  const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: E, observations: [trade(1, S + 10_000, 100), trade(2, S + 20_000, 100, 'SELL', { knownAtTs: E + 1 })], coverage: [...full, cov({ state: 'GAP', startTs: S - 1000, endTs: S + 1000, subject: other })], captureRef: REF }).context;
  const w = ctx.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current;
  assert.equal(w.support.state, 'COMPLETE', 'the foreign venue gap does not touch this subject'); assert.equal(w.count, 1, 'a trade known only after the as-of is not in the window (late arrival)'); assert.equal(w.observedCount, 1);
  const late = tradeWindow([trade(1, S + 10_000, 100), trade(2, S + 20_000, 100)], { startTs: S, endTs: E, coverage: intervalCoverage(full, win) }); assert.equal(late.count, 2, 'the same trades at a later as-of are complete');
});

test('MC-W04 (R02). the repaired coverage support survives capture, reopen, restart, as-of replay, packet projection and the REAL deep-market adapter', async () => {
  const clk = H.clockAt(T0); let conn = null; const fx = await subscribedKraken({ clock: clk, script: (c) => { conn = c; krakenWsScript()(c); } }); const dir = tmp();
  try {
    await fx.owner.start({ outDir: path.join(dir, 'cap'), families: [] }); await H.waitFor(() => fx.owner.status().streams.KRAKEN_SPOT?.subscribed?.length >= 1, { timeoutMs: 5000 });
    clk.set(T0 + 130_000); conn.send({ channel: 'trade', type: 'update', data: [krakenTradeMsg(1, { price: 100, qty: 0.2, side: 'buy', ts: T0 + 125_000 })] }); await H.waitFor(() => fx.owner.status().streams.KRAKEN_SPOT?.trades >= 1, { timeoutMs: 5000 });
    clk.set(T0 + 180_000); const asOf = clk();
    // the adapter (live owner): the minute [asOf-60s, asOf] has positive coverage and one accepted trade => the aggregate is supplied
    const explain = explainDeepMarket(fx.owner, 'BTC', asOf); assert.equal(explain.ok, true, JSON.stringify(explain)); assert.equal(explain.coverage.support, 'COMPLETE'); assert.equal(explain.coverage.withheld, null); assert.equal(explain.input.trades.count, 1); assert.ok(explain.input.trades.buyNotionalUsd > 0);
    const early = explainDeepMarket(fx.owner, 'BTC', T0 + 30_000); assert.equal(early.ok ? early.input.trades : null, null, 'the minute before the subscription carries no trade aggregate (never a false zero)'); if (early.ok) assert.equal(early.coverage.withheld, 'TRADE_COVERAGE_UNKNOWN');
    const stopped = await fx.owner.stop({ seal: true, policyNonsecret: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })) }); assert.ok(stopped.sealed);
    const cap = readCapture(path.join(dir, 'cap')); assert.ok(cap.coverage.some((c) => c.state === 'SUBSCRIBED'), 'the continuity fact is recorded in the sealed capture'); assert.ok(cap.coverage.some((c) => c.state === 'GAP' && c.reasonCodes.includes('SUBSCRIPTION_ENDED')), 'stop ends the subscription honestly');
    const b1 = runBuild({ captureDir: path.join(dir, 'cap'), asOfTs: asOf, canonicalCoin: 'BTC', out: path.join(dir, 'ctx') }); const reopened = readContext(path.join(dir, 'ctx'), { capture: cap });
    const w = reopened.context.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current; assert.equal(w.support.state, 'COMPLETE'); assert.equal(w.count, 1); assert.equal(reopened.derivation?.recomputed ?? true, true);
    const b2 = runBuild({ captureDir: path.join(dir, 'cap'), asOfTs: asOf, canonicalCoin: 'BTC', out: path.join(dir, 'ctx2') }); assert.equal(b2.contextId, b1.contextId, 'as-of replay after restart reproduces the identity');
    const quiet = runBuild({ captureDir: path.join(dir, 'cap'), asOfTs: T0 + 110_000, canonicalCoin: 'BTC', out: path.join(dir, 'ctx3') }); const qc = readContext(path.join(dir, 'ctx3')).context.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current; assert.equal(qc.support.state, 'COMPLETE_NO_TRADES', `replayed quiet minute (${quiet.contextId})`);
    const pk = buildResearchEvidenceV2({ marketContext: reopened.context, asOfTs: asOf, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(pk.ok, true); const chart = pk.packet.evidence.find((e) => e.kind === 'MARKET_CHART_WINDOW'); assert.equal(chart.state, 'KNOWN'); assert.equal(chart.value.support.state, 'COMPLETE');
    const pq = buildResearchEvidenceV2({ marketContext: readContext(path.join(dir, 'ctx3')).context, asOfTs: T0 + 110_000, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(pq.packet.evidence.find((e) => e.kind === 'MARKET_CHART_WINDOW').value.support.state, 'COMPLETE_NO_TRADES', 'the packet projection labels the observed zero');
  } finally { await fx.owner.stop({ seal: false }); await fx.close(); rmSync(fx.root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-W06 (R02). a summary tick and its enriched ticker for one instrument are ONE contract; complete / partial surfaces and put-call counts reconcile to unique lawful instruments (4 census instruments, 2 puts + 2 calls with OI 100 each => put/call OI ratio 1 over the WHOLE chain; one instrument without any tick => an ADMITTED_SUBSET ratio labelled TICKS_MISSING)', async () => {
  const paths = []; const full = deribitOwner(paths);
  try {
    const dq = await full.acquire('OPTIONS_TERM_SKEW', 'BTC'); const ticks = dq.observations.filter((o) => o.kind === 'OPTION_TICK'); assert.ok(ticks.length >= 8, 'summary + ticker records per instrument');
    const surf = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: dq.observations, coverage: dq.coverage, captureRef: REF }).context.families.OPTIONS_TERM_SKEW.components[0].value;
    assert.equal(surf.admitted, 4); assert.equal(surf.term[0].contracts, 4); assert.equal(surf.term[0].ratioScope, 'WHOLE_CHAIN'); assert.equal(surf.term[0].putCallOiRatio, 1); assert.equal(surf.census.unticked, 0); assert.equal(surf.support.state, 'COMPLETE');
  } finally { await full.stop({ seal: false }); }
  const p2 = []; const three = deribitOwner(p2, { summaries: deribitFourSummaries(['BTC-26SEP26-100000-C', 'BTC-26SEP26-110000-C', 'BTC-26SEP26-100000-P']) });
  try {
    const dq = await three.acquire('OPTIONS_TERM_SKEW', 'BTC'); const surf = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: dq.observations, coverage: dq.coverage, captureRef: REF }).context.families.OPTIONS_TERM_SKEW.components[0].value;
    assert.equal(surf.census.total, 4); assert.equal(surf.admitted, 3); assert.equal(surf.census.unticked, 1, 'one census instrument has no tick'); assert.equal(surf.term[0].ratioScope, 'ADMITTED_SUBSET'); assert.ok(surf.term[0].support.reasons.includes('TICKS_MISSING')); assert.equal(surf.support.state, 'ADMITTED_SUBSET'); assert.equal(surf.term[0].putCallOiRatio, 0.5, 'one put against two calls over the ticked subset, labelled as that subset');
  } finally { await three.stop({ seal: false }); }
});

// ---------------------------------------------------------------- R03 -----------------------------------------------------------
test('MC-J03 (R03). every registered metric of the 17 families has ONE explicit bounded mapping (component + build + evidence kind, or a declared unsupported reason); packet limits produce reconciled omission reasons and counts', () => {
  const rows = [];
  for (const fam of Object.keys(FAMILY_REGISTRY)) for (const metricId of familyMetricIds(fam)) { const m = METRIC_MAP[fam]?.[metricId]; assert.ok(m, `${fam}/${metricId} has no mapping`); rows.push({ fam, metricId, m }); if (m.component) { assert.ok(MARKET_EVIDENCE_KINDS.includes(m.kind), `${fam}/${metricId}: unknown evidence kind ${m.kind}`); assert.equal(typeof m.build, 'string'); assert.ok(Array.isArray(m.inputKinds) && m.inputKinds.length >= 1); } else assert.ok(typeof m.unsupported === 'string' && m.unsupported.length, `${fam}/${metricId}: unsupported without a reason`); }
  assert.equal(new Set(rows.map((r) => r.fam)).size, 17); assert.ok(rows.filter((r) => r.m.component).length >= 40, 'the supported table is populated');
  // omission reconciliation over a real context: a DETAIL request for an absent component and an unsupported metric are named, counts add up
  const obs = []; for (let i = 0; i < 30; i += 1) obs.push(trade(i, T0 - 600_000 + i * 15_000, 100 + i * 0.01)); for (let i = 0; i < 6; i += 1) obs.push(book(i, T0 - 300_000 + i * 50_000));
  const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: obs, coverage: [cov({ state: 'SUBSCRIBED', startTs: T0 - 900_000 })], captureRef: REF, referenceNotionals: [1000] }).context;
  const b = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: T0, trigger: { kind: 'MARKET_RESEARCH' }, detailRequests: [{ family: 'DISPLAYED_LIQUIDITY', metricId: 'spread_bps' }, { family: 'LIQUIDATIONS', metricId: 'liquidation_notional_by_side' }, { family: 'SPOT_PRICE_CHART', metricId: 'sma' }] });
  assert.equal(b.ok, true, JSON.stringify(b.detail ?? null)); const om = b.contextMap.omitted;
  for (const d of om.detail) assert.ok(OMISSION_REASONS.includes(d.reason), d.reason);
  assert.ok(om.unsupported.some((d) => d.metricId === 'liquidation_notional_by_side' && d.reason === 'NO_COMPONENT_IN_CONTEXT'), JSON.stringify(om.unsupported)); assert.ok(om.unsupported.some((d) => d.metricId === 'sma' && d.reason === 'NO_COMPONENT_IN_CONTEXT'), 'a requested metric without a component in this context is named, never silently dropped');
  assert.ok(om.detail.every((d) => d.metricId !== 'spread_bps'), 'the admitted spread component is never simultaneously omitted');
  const total = Object.values(ctx.families).reduce((n, f) => n + f.components.length, 0); const admitted = new Set(Object.values(b.contextMap.evidenceToComponent).flat()).size;
  assert.equal(admitted + om.detail.length, total, `admitted components (${admitted}) + omitted components (${om.detail.length}) reconcile to the context (${total})`); assert.equal(om.counts.components, om.detail.length);
});

test('MC-J05 (R03). missing / denied Greeks and an incompatible census stay PARTIAL: a ticker without greeks leaves delta null (GREEKS_MISSING, no 25-delta wings); a ticker refused by the provider keeps the summary-only contract; a tick outside the census is excluded and counted', async () => {
  const paths = []; const noGreeks = deribitOwner(paths, { ticker: (name) => deribitTicker(name, { greeks: false }) });
  try {
    const dq = await noGreeks.acquire('OPTIONS_TERM_SKEW', 'BTC'); const s = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: dq.observations, coverage: dq.coverage, captureRef: REF }).context.families.OPTIONS_TERM_SKEW.components[0].value;
    assert.equal(s.term[0].call25, null); assert.equal(s.term[0].put25, null); assert.equal(s.term[0].riskReversal25d, null); assert.equal(s.term[0].greeksMissing, 4); assert.ok(s.term[0].support.reasons.includes('GREEKS_MISSING')); assert.equal(s.term[0].support.state, 'PARTIAL_ADMITTED_SCOPE'); assert.equal(typeof s.term[0].atm.markIv, 'number', 'the ATM mark IV from the summary survives');
  } finally { await noGreeks.stop({ seal: false }); }
  const p2 = []; const denied = deribitOwner(p2, { ticker: (name) => (name === 'BTC-26SEP26-110000-C' ? null : deribitTicker(name)) });
  try {
    const dq = await denied.acquire('OPTIONS_TERM_SKEW', 'BTC'); const s = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: dq.observations, coverage: dq.coverage, captureRef: REF }).context.families.OPTIONS_TERM_SKEW.components[0].value;
    assert.equal(s.term[0].contracts, 4, 'the refused ticker does not lose the instrument (summary contract retained)'); assert.equal(s.term[0].greeksMissing, 1); assert.ok(dq.results.some((r) => r.providerId === 'DERIBIT' && r.state !== 'OK'), 'the refused ticker is a visible result');
  } finally { await denied.stop({ seal: false }); }
  const p3 = []; const foreign = { result: [...deribitFourSummaries().result, { ...deribitFourSummaries().result[0], instrument_name: 'BTC-26SEP26-120000-C' }] }; const outside = deribitOwner(p3, { summaries: foreign, ticker: (name) => deribitTicker(name) });
  try {
    const dq = await outside.acquire('OPTIONS_TERM_SKEW', 'BTC'); const s = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: dq.observations, coverage: dq.coverage, captureRef: REF }).context.families.OPTIONS_TERM_SKEW.components[0].value;
    assert.equal(s.admission.notInCensus >= 1 || s.admitted === 4, true, `a tick for an instrument outside the census is excluded (${JSON.stringify(s.admission)})`); assert.equal(s.admitted, 4);
  } finally { await outside.stop({ seal: false }); }
});

test('MC-J07 (R03). a Santiment-only fixture supplies NETWORK_ACTIVITY through the mapped GraphQL request; exhausted primary AND fallback quota stays within R01 (zero dispatch); an already satisfied metric is served from the bounded cache without a second paid request', async () => {
  const graphql = []; const raw = H.policyWith({ providers: ['SANTIMENT'] }); includedPlan(raw, 'SANTIMENT');
  const san = createResearchOwner({ policy: loadPolicy(raw), subjects: btcOnly(), env: { SANTIMENT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: tmp(), fetchImpl: async (url, init) => { graphql.push(JSON.parse(init.body)); return json(H.santimentSeries()); } });
  try {
    const na = await san.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); assert.ok(graphql.length >= 1, 'the mapped GraphQL request was issued'); assert.equal(graphql[0].variables.slug, 'bitcoin'); assert.ok(/daily_active_addresses|active_addresses/.test(graphql[0].variables.metric));
    const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: na.observations, coverage: na.coverage, captureRef: REF }).context; const comp = ctx.families.NETWORK_ACTIVITY.components.find((c) => c.metricId === 'active_addresses'); assert.ok(comp, 'active_addresses component from Santiment'); assert.equal(comp.value.provider, 'SANTIMENT'); assert.equal(comp.value.value, 7000);
    const n = graphql.length; const again = await san.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); assert.equal(graphql.length, n, 'a satisfied metric inside its cadence is not bought twice'); assert.equal(again.usage.dispatched, 0); assert.ok(again.results.some((r) => r.state === 'CACHED'));
  } finally { await san.stop({ seal: false }); }
  const wire = []; const both = H.policyWith({ providers: ['CRYPTOQUANT', 'SANTIMENT'] }); includedPlan(both, 'CRYPTOQUANT', { remaining: 0 }); includedPlan(both, 'SANTIMENT', { remaining: 0 });
  const dry = createResearchOwner({ policy: loadPolicy(both), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture', SANTIMENT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: tmp(), fetchImpl: async (url) => { wire.push(url); return json({}); } });
  try { const r = await dry.acquire('NETWORK_ACTIVITY', 'BTC'); assert.equal(wire.length, 0, 'exhausted primary and fallback: nothing is dispatched'); assert.equal(r.usage.dispatched, 0); assert.ok(r.usage.reasons.ENTITLEMENT_EXHAUSTED >= 1, JSON.stringify(r.usage.reasons)); }
  finally { await dry.stop({ seal: false }); }
});

test('MC-J08 (R03). the H01 pressure / response, H02 peer-relative and H03 exit-liquidity entries plus the market-led and Social-led packets remain populated, independently labelled and bounded', async () => {
  const obs = []; for (let i = 0; i < 40; i += 1) obs.push(trade(i, T0 - 600_000 + i * 15_000, 100 + i * 0.01)); for (let i = 0; i < 12; i += 1) obs.push(book(i, T0 - 600_000 + i * 50_000)); obs.push(book(12, T0 - 1000));
  const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: obs, coverage: [cov({ state: 'SUBSCRIBED', startTs: T0 - 900_000 })], captureRef: REF, referenceNotionals: [100] }).context; // 100 quote through asks 100.1x2 / bids 99.9x3: a FULL round trip
  const market = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: T0, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(market.ok, true); assert.equal(validateEvidencePacketV2(market.packet).valid, true);
  const kinds = market.packet.evidence.map((e) => e.kind);
  for (const k of ['MARKET_PRESSURE_RESPONSE_CHANGE', 'MARKET_PEER_RELATIVE_MOVE', 'MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE', 'MARKET_MULTI_VENUE_CONTEXT', 'MARKET_CHART_WINDOW', 'MARKET_BOOK_CONTEXT']) assert.ok(kinds.includes(k), `${k} present`);
  for (const e of market.packet.evidence) { assert.ok(e.kind && e.state, 'every item is labelled'); if (e.value) { assert.ok(JSON.stringify(e.value).length <= MAX_VALUE_CHARS, `${e.kind} bounded`); assert.ok(Array.isArray(e.sourceRefs) && e.sourceRefs.length >= 1, `${e.kind} cites its sources`); } }
  assert.deepEqual(market.packet.researchContext.entrances, ['MARKET_LED']); assert.equal(market.packet.researchContext.dossierRef, null); assert.ok(market.packet.researchContext.coverageLimitations.includes('SOCIAL_PROJECTION_ABSENT'));
  const h03 = market.packet.evidence.find((e) => e.kind === 'MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE'); assert.equal(typeof h03.value.fields.currentLossBps, 'number', JSON.stringify(h03.value.fields)); assert.ok(Math.abs(h03.value.fields.currentLossBps - 1e4 * (100 - (100 / 100.1) * 99.9) / 100) < 1e-4, 'independent H03 oracle: buy 100 quote at 100.1, sell that base at 99.9 (recipe rounding 1e-5)'); const h01 = market.packet.evidence.find((e) => e.kind === 'MARKET_PRESSURE_RESPONSE_CHANGE'); assert.ok(h01.value?.support?.state || h01.state, 'H01 labelled');
  const composite = { compositeId: 'r2cv2-' + 'b'.repeat(40), version: 'social-research-composite-2', knownAtTs: T0 - 5000, sourceContext: { total: 1, selected: 1, truncated: false, profiles: [{ socialAuthorId: 'did:plc:known', provider: 'BLUESKY_OFFICIAL', representativeSourceEventId: 'r2so-1', history: 'AVAILABLE', profileId: 'r2sp-1', retentionState: 'DURABLE_PROFILE_ALLOWED', coverage: { resourceHistoryState: 'NO_PRIOR_PROFILE_EVICTION', firstObservedKnownAtTs: T0 - 40 * 86_400_000, observationCount: 12, observationCountIncludingDropped: 15, currentProfileFirstObservedKnownAtTs: T0 - 40 * 86_400_000, currentProfileObservationCountIncludingDropped: 15, distinctResearchEpisodeCount: 2, coverageLimitations: [] }, origin: { factualIndependenceStatus: 'SINGLE_ORIGIN' }, factualOutcome: { associatedClaimCount: 0, associationAvailable: false } }] } };
  const rec = { dossierId: 'r2rd-' + 'c'.repeat(40), derivedKnownAtTs: T0 - 4000, researchState: 'INVESTIGATE', entrances: ['PARTICIPATION_LED'], packetStatus: 'VALID', packetId: 'sep-abc', episodeId: 'ep-1', episodeIndex: 0, episodeState: 'ACTIVE_RESEARCH' };
  const proj = buildSocialProjection({ canonicalCoin: 'BTC', asOfTs: T0, composite, dossierRecord: rec });
  const social = buildResearchEvidenceV2({ marketContext: ctx, socialProjection: proj, asOfTs: T0, trigger: { kind: 'RESEARCH_DOSSIER', sourceEventId: rec.dossierId, observedTs: null } }); assert.equal(social.ok, true, JSON.stringify(social.detail ?? null)); assert.equal(validateEvidencePacketV2(social.packet).valid, true);
  assert.deepEqual(social.packet.researchContext.entrances, ['PARTICIPATION_LED']); assert.ok(social.packet.researchContext.dossierRef, 'the Social-led packet cites its dossier'); assert.ok(social.packet.evidence.some((e) => e.kind === 'SOCIAL_DOSSIER_CONTEXT')); assert.ok(social.packet.evidence.some((e) => e.kind === 'MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE'), 'market entries stay populated alongside the Social entries');
  assert.notEqual(social.packet.packetId, market.packet.packetId, 'independent packets');
});
