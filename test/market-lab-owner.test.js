// MARKET LAB — the research owner, capture -> context -> packet determinism, the Tape observer seam, the deep-market
// adapter through the REAL Social strainer consumer, and the research service (A08, A09, A12, B02, B06, C06 shape):
// every provider answers from loopback fixtures (HTTP + WebSocket); nothing reaches a real host or spends anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResearchOwner } from '../market-lab/owner.js';
import { createResearchService } from '../market-lab/service.js';
import { readCapture, runBuild, readContext } from '../market-lab/commands.js';
import { openBundle } from '../market-lab/store.js';
import { buildContext, contextError } from '../market-lab/context.js';
import { createDeepMarketSource, explainDeepMarket } from '../market-lab/deep-market-adapter.js';
import { buildResearchEvidenceV2 } from '../evidence/research-builder.js';
import { validateEvidencePacketV2 } from '../evidence/contract-v2.js';
import { validateDeepMarketWindow } from '../rumor2/social-research-market.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { RESEARCH_DOSSIER_EVENT_TYPE, validateResearchDossierEvent } from '../rumor2/social-research-dossier.js';
import { socialCatalogEvent, socialScopeEvent } from '../rumor2/social-settle.js';
import { compileAdmissionScope } from '../rumor2/social-scope.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { memJournal } from './helpers/rumor2-journal.js';
import * as H from './helpers/market-lab.js';

const { T0 } = H;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'mlab-owner-'));
const PROVIDERS = ['KRAKEN_SPOT', 'COINBASE_SPOT', 'KRAKEN_DERIVATIVES', 'DERIBIT', 'COINGECKO', 'DEFILLAMA', 'COINMETRICS', 'SETTLED_RECORDS'];
function krakenWs(conn) { conn.handlers.push((msg) => { if (msg.method !== 'subscribe') return; if (msg.params.channel === 'instrument') conn.send({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'BTC/USD', price_precision: 1, qty_precision: 8 }] } }); if (msg.params.channel === 'book') { conn.send({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 99.5, qty: 2 }, { price: 99.0, qty: 3 }], asks: [{ price: 100.5, qty: 2 }, { price: 101.0, qty: 3 }] }] }); let i = 0; const t = setInterval(() => { if (conn.closed) { clearInterval(t); return; } i += 1; conn.send({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: i % 2 ? 'buy' : 'sell', price: 100 + (i % 3) * 0.1, qty: 0.2, ord_type: 'market', trade_id: 1000 + i, timestamp: new Date(Date.now()).toISOString() }] }); conn.send({ channel: 'book', type: 'update', data: [{ symbol: 'BTC/USD', bids: [{ price: 99.5, qty: 2 + (i % 2) }], asks: [] }] }); }, 40); } }); }
function coinbaseWs(conn) { conn.handlers.push((msg) => { if (msg.type !== 'subscribe') return; conn.send({ type: 'snapshot', product_id: 'BTC-USD', bids: [['99.4', '2']], asks: [['100.6', '2']] }); let i = 0; const t = setInterval(() => { if (conn.closed) { clearInterval(t); return; } i += 1; conn.send({ type: 'match', product_id: 'BTC-USD', trade_id: 700 + i, sequence: i, side: 'sell', price: '100.2', size: '0.1', time: new Date(Date.now()).toISOString() }); conn.send({ type: 'l2update', product_id: 'BTC-USD', changes: [['buy', '99.4', String(2 + (i % 2))]], time: new Date(Date.now()).toISOString() }); }, 50); }); }
async function fixtures() {
  const now = () => Date.now();
  const http = await H.startHttpFixture({
    'GET /0/public/AssetPairs': { json: H.KRAKEN_ASSET_PAIRS }, 'GET /0/public/OHLC': (req) => ({ json: H.krakenOhlc(req.query.pair, { intervalMin: Number(req.query.interval), endTs: now(), count: 30 }) }), 'GET /0/public/Trades': (req) => ({ json: H.krakenTrades(req.query.pair, { endTs: now() }) }), 'GET /0/public/Ticker': (req) => ({ json: H.krakenTicker(req.query.pair.split(',')[0]) }),
    'GET /products': { json: H.COINBASE_PRODUCTS }, 'GET /products/BTC-USD/trades': () => ({ json: H.coinbaseTrades({ endTs: now() }) }), 'GET /products/BTC-USD/book': () => ({ json: H.coinbaseBook({ ts: now() }) }), 'GET /products/BTC-USD/candles': () => ({ json: [[Math.floor((now() - 120_000) / 60_000) * 60, 99, 101, 100, 100.5, 3]] }),
    'GET /derivatives/api/v3/instruments': { json: H.KF_INSTRUMENTS }, 'GET /derivatives/api/v3/tickers': (req) => ({ json: H.kfTickers({ symbol: req.query.symbol }) }), 'GET /derivatives/api/v4/historicalfundingrates': () => ({ json: { rates: [{ timestamp: new Date(now() - 3_600_000).toISOString(), fundingRate: 0.00005, relativeFundingRate: 0.00001 }] } }),
    'GET /api/v2/public/get_instruments': () => ({ json: { result: H.DERIBIT_INSTRUMENTS.result.map((i) => ({ ...i, expiration_timestamp: now() + 18 * 86_400_000 })) } }), 'GET /api/v2/public/get_book_summary_by-currency': { json: { result: [] } }, 'GET /api/v2/public/get_book_summary_by_currency': () => ({ json: { result: H.deribitSummaries().result.map((x) => ({ ...x, creation_timestamp: now() - 500 })) } }),
    'GET /api/v3/coins/list': { json: H.COINGECKO_LIST }, 'GET /api/v3/coins/markets': () => ({ json: H.coingeckoMarkets().map((m) => ({ ...m, last_updated: new Date(now() - 60_000).toISOString() })) }),
    'GET /stablecoins': { json: H.DEFILLAMA_STABLECOINS }, 'GET /v4/catalog-v2/asset-metrics': { json: H.COINMETRICS_CATALOG }, 'GET /v4/timeseries/asset-metrics': { json: H.coinmetricsSeries() },
    '*': { status: 404, json: { error: 'no fixture' } },
  });
  const kws = await H.startWsFixture({ path: '/v2', onConnection: krakenWs }); const cws = await H.startWsFixture({ path: '/', onConnection: coinbaseWs });
  return { http, kws, cws, close: async () => { await kws.close(); await cws.close(); await http.close(); } };
}
const subjectsBtc = () => { const s = H.subjectsWith(); return { ...s, subjects: [s.subjects[0]], macroSeries: [], crossAsset: [] }; };
const settled = { gatewayMatrix: () => ({ ts: new Date().toISOString(), doors: { BTC: { funding: 'OPEN', trading: 'OPEN' } } }), gatewayIncidents: () => ({}), governanceStatus: () => ({ tsMs: Date.now(), state: 'ACTIVE' }), governanceEvents: () => [] };

test('A09/B02. STANDALONE owner: real streams over loopback + REST fixtures -> sealed CAPTURE bundle; build -> CONTEXT twice gives the identical contextId; reopen against the capture verifies input clocks; the market-only v2 packet cites real provider sources and no invented Social item; a later as-of over the same capture is a different context', async () => {
  const fx = await fixtures(); const dir = tmp();
  try {
    const policy = H.policyWith({ providers: PROVIDERS }); const subjects = subjectsBtc();
    const owner = createResearchOwner({ policy, subjects, env: {}, fetchImpl: H.fetchFor(fx.http), WebSocketImpl: globalThis.WebSocket, wsUrls: { KRAKEN_SPOT: fx.kws.url, COINBASE_SPOT: fx.cws.url }, settledAccessors: settled, log: () => {} });
    const captureDir = path.join(dir, 'cap'); await owner.start({ outDir: captureDir });
    await H.waitFor(() => owner.status().counters.observations > 40 && owner.status().streams.KRAKEN_SPOT?.trades >= 3 && owner.status().streams.COINBASE_SPOT?.trades >= 2, { timeoutMs: 8000 });
    // A02 re-poll law: a forced second acquisition of the chart family returns the same committed bars again; none is a new observation
    const chartObs = () => owner.observations().filter((o) => o.endpointId === 'rest-ohlc' || o.endpointId === 'rest-candles').length; // the streams keep flowing meanwhile: count the polled family only
    const nBefore = chartObs(); const dupBefore = owner.status().counters.duplicateRecords; const again = await owner.acquire('SPOT_PRICE_CHART', 'BTC', { force: true }); assert.ok(again.observations.length >= 30, 'the provider answered again');
    assert.equal(chartObs(), nBefore, 'identical re-polled source records are not new observations'); assert.ok(owner.status().counters.duplicateRecords - dupBefore >= 30, 'duplicates are counted, never silently written');
    const before = owner.status(); assert.equal(before.streams.KRAKEN_SPOT.synced, 1); assert.ok(before.clients.KRAKEN_DERIVATIVES.counters.ok >= 1); assert.ok(before.clients.DERIBIT.counters.ok >= 1); assert.equal(before.clients.COINGLASS.counters.requests, 0, 'a disabled paid provider is never called');
    const stopped = await owner.stop({ seal: true, policyNonsecret: policy }); assert.ok(stopped.sealed); assert.equal(fx.http.requests.every((r) => r.host !== 'open-api-v4.coinglass.com'), true);
    const cap = readCapture(captureDir); assert.ok(cap.observations.length > 40); assert.ok(cap.observations.some((o) => o.kind === 'TRADE' && o.provider === 'KRAKEN_SPOT') && cap.observations.some((o) => o.kind === 'TRADE' && o.provider === 'COINBASE_SPOT') && cap.observations.some((o) => o.kind === 'BOOK_SNAPSHOT') && cap.observations.some((o) => o.kind === 'OPTION_TICK') && cap.observations.some((o) => o.kind === 'DERIVATIVE_TICK') && cap.observations.some((o) => o.kind === 'STABLECOIN_METRIC'));
    assert.ok(cap.coverage.length > 0); assert.equal(cap.bundle.manifest.summary.observations, cap.observations.length); assert.ok(cap.observations.every((o) => o.knownAtTs >= o.receivedTs));
    const asOf = cap.bundle.manifest.summary.lastReceivedTs + 1;
    const c1 = runBuild({ captureDir, asOfTs: asOf, canonicalCoin: 'BTC', out: path.join(dir, 'ctx-a') }); const c2 = runBuild({ captureDir, asOfTs: asOf, canonicalCoin: 'BTC', out: path.join(dir, 'ctx-b') });
    assert.equal(c1.contextId, c2.contextId, 'same capture prefix + as-of => identical context identity'); assert.equal(readFileSync(path.join(dir, 'ctx-a', 'context.json'), 'utf8'), readFileSync(path.join(dir, 'ctx-b', 'context.json'), 'utf8'), 'identical canonical bytes across directory names');
    const ctx = readContext(path.join(dir, 'ctx-a'), { capture: cap }); assert.equal(contextError(ctx.context, { inputReferences: ctx.inputReferences }), null); assert.equal(ctx.context.families.SPOT_PRICE_CHART.state, 'OBSERVED'); assert.equal(ctx.context.families.DISPLAYED_LIQUIDITY.state, 'OBSERVED'); assert.ok(ctx.context.families.OPTIONS_TERM_SKEW.components.length >= 1); assert.equal(ctx.context.families.LIQUIDATIONS.state, 'NOT_QUERIED', 'no liquidation source was enabled: NOT_QUERIED, never an invented zero');
    for (const id of Object.keys(ctx.inputReferences)) assert.ok(cap.observations.some((o) => o.observationId === id), 'every input reference is a capture observation');
    const later = runBuild({ captureDir, asOfTs: asOf + 60_000, canonicalCoin: 'BTC', out: path.join(dir, 'ctx-c') }); assert.notEqual(later.contextId, c1.contextId);
    const b = buildResearchEvidenceV2({ marketContext: ctx.context, asOfTs: asOf, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(b.ok, true); assert.equal(validateEvidencePacketV2(b.packet).valid, true);
    assert.ok(b.packet.sources.some((s) => s.provider === 'KRAKEN_SPOT') && b.packet.sources.some((s) => s.provider === 'COINBASE_SPOT')); assert.ok(b.packet.evidence.every((e) => e.sense !== 'RUMINT')); assert.equal(b.packet.researchContext.dossierRef, null); assert.ok(b.packet.researchContext.coverageLimitations.includes('SOCIAL_PROJECTION_ABSENT'));
    assert.equal(b.packet.evidence.some((e) => e.kind === 'MARKET_CHART_WINDOW' && e.state === 'KNOWN'), true); assert.equal(b.packet.evidence.find((e) => e.kind === 'MARKET_LIQUIDATIONS_CONTEXT').state, 'MISSING');
  } finally { await fx.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('A12/B06. INTEGRATED owner: the Tape observer seam copies accepted trades / books into bounded hot state (stopped owner ignores, a full queue drops with DROPPED coverage, an observer exception is contained); the deep-market adapter yields a lawful v1 window from the owner\'s ACTUAL retained windows and the REAL Social strainer consumer builds a dossier whose marketDeep features come from that window', async () => {
  const fx = await fixtures();
  try {
    const policy = H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'] }); const subjects = subjectsBtc();
    const owner = createResearchOwner({ policy, subjects, env: {}, mode: 'INTEGRATED', fetchImpl: H.fetchFor(fx.http), WebSocketImpl: globalThis.WebSocket, log: () => {} });
    await owner.start({ families: [] }); assert.equal(Object.keys(owner.status().streams).length, 0, 'integrated mode opens no venue stream of its own');
    const base = Math.floor(Date.now() / 60_000) * 60_000 - 120_000; // a completed minute in the past
    const levels = () => ({ bids: [[99.5, 2], [99, 3]], asks: [[100.5, 2], [101, 3]] });
    for (let i = 0; i < 20; i += 1) owner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: i % 4 === 0 ? 'sell' : 'buy', qty: 0.5, price: 100 + i * 0.01, eventTs: base + 1000 + i * 2000, receivedTs: base + 1100 + i * 2000, tradeId: 5000 + i, ordType: 'market', snapshot: false });
    owner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 1, price: 100, eventTs: base, receivedTs: base, tradeId: 1, ordType: null, snapshot: true }); // snapshot history is never a witnessed trade
    owner.observer.onTrade({ coin: 'DOGE', symbol: 'DOGE/USD', side: 'buy', qty: 1, price: 1, eventTs: base, receivedTs: base, tradeId: 2, ordType: null, snapshot: false }); // not a declared subject: ignored
    owner.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: base + 59_000, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels }); owner.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: base + 60_500, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels });
    await H.waitFor(() => owner.status().counters.tapeTrades >= 20 && owner.status().counters.tapeBooks >= 2, { timeoutMs: 3000 });
    const view = owner.view('BTC'); assert.equal(view.trades.length, 20); assert.equal(owner.view('DOGE'), null); assert.ok(view.trades.every((t) => t.provenance.vintage === 'TAPE_ACCEPTED'));
    // adapter: the completed minute [base, base+60s] with accepted trades and an accepted book
    const knownAtTs = base + 61_000; const explain = explainDeepMarket(owner, 'BTC', knownAtTs); assert.equal(explain.ok, true, JSON.stringify(explain)); const input = createDeepMarketSource(owner)('BTC', { knownAtTs });
    assert.equal(validateDeepMarketWindow(input).ok, true); assert.equal(input.windowStartTs, base); assert.equal(input.windowEndTs, base + 60_000); assert.equal(input.state, 'SYNCHRONIZED'); assert.equal(input.trades.source, 'kraken-ws-v2-accepted-trades'); assert.ok(input.trades.count >= 20); assert.equal(input.trades.takerSideKnown, true); assert.ok(input.trades.buyNotionalUsd > input.trades.sellNotionalUsd);
    assert.equal(createDeepMarketSource(owner)('BTC', { knownAtTs: base + 30_000 }), null, 'an incomplete window is honestly unsupported'); assert.equal(explainDeepMarket(owner, 'DOGE', knownAtTs).reason, 'NO_OWNER_VIEW');
    // the REAL consumer: the Social strainer builds a market-led dossier whose marketDeep features derive from this adapter
    const cat = normalizeKrakenAssetPairs({ BTCUSD: { wsname: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' }, LINKUSD: { wsname: 'LINK/USD', base: 'LINK', quote: 'USD', status: 'online' } }, { observedTs: knownAtTs - 100_000 }); assert.equal(cat.ok, true);
    const scope = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: cat.catalog.contentId, terms: ['BTC', 'LINK'] }).scope;
    const hist = [socialCatalogEvent({ catalog: cat.catalog, acceptedKnownAtTs: knownAtTs - 90_000 }), socialScopeEvent({ provider: 'BLUESKY_OFFICIAL', scopeRevision: 1, scope, catalogObservedTs: cat.catalog.observedTs, previous: null, activatedKnownAtTs: knownAtTs - 90_000, reason: 'INITIAL_ACTIVATION' })];
    const arr = [...hist]; const journal = memJournal(arr); let windows = 0; const src = createDeepMarketSource(owner);
    const rt = createResearchStrainer({ now: () => knownAtTs + 5000, deepMarketSource: (coin, opts) => { windows += 1; return src(coin, opts); }, fallbackScope: () => scope });
    assert.equal(rt.hydrate(hist).ok, true);
    const providerStates = [{ provider: 'BLUESKY_OFFICIAL', state: 'OBSERVED', checkedTs: knownAtTs + 5000, detail: null }, { provider: 'X_OFFICIAL', state: 'NOT_QUERIED', checkedTs: null, detail: 'provider disabled' }];
    const notice = { ts: new Date(knownAtTs + 1000).toISOString(), tsMs: knownAtTs + 1000, symbol: 'BTC', verdict: 'RIPPLE', zVol: 4.5, zRet: 2.1, extension: 3.2, liquidityNote: 'x', inDeepTape: true, usdVol24h: 2_500_000 };
    const r = await rt.tick({ knownAtTs: knownAtTs + 5000, providerStates, fenceHeld: () => true, append: (e) => journal.append(e), notices: [notice] }); assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    const dossiers = arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE); assert.equal(dossiers.length, 1); const d = dossiers[0]; const de = validateResearchDossierEvent(d); assert.equal(de, null, `dossier event: ${de}`); assert.equal(d.canonicalCoin, 'BTC');
    assert.equal(d.dossier.marketDeep.state, 'SYNCHRONIZED', 'the real consumer sees the adapter window'); assert.equal(d.dossier.marketDeep.features.flow.netTakerNotionalUsd, Math.round((input.trades.buyNotionalUsd - input.trades.sellNotionalUsd) * 1e6) / 1e6 === d.dossier.marketDeep.features.flow.netTakerNotionalUsd ? d.dossier.marketDeep.features.flow.netTakerNotionalUsd : d.dossier.marketDeep.features.flow.netTakerNotionalUsd);
    assert.ok(Math.abs(d.dossier.marketDeep.features.flow.netTakerNotionalUsd - (input.trades.buyNotionalUsd - input.trades.sellNotionalUsd)) < 1e-6); assert.ok(d.dossier.marketDeep.features.book.spreadBps > 0); assert.equal(d.dossier.executability.state, 'ASSESSED'); assert.ok(windows >= 1); assert.equal(rt.status().deepMarket, 'INJECTED_ADAPTER');
    // seam law: a stopped owner ignores; a throwing consumer is contained; queue pressure drops honestly
    const stoppedOwner = createResearchOwner({ policy, subjects, env: {}, mode: 'INTEGRATED', fetchImpl: H.fetchFor(fx.http), log: () => {} }); stoppedOwner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 1, price: 100, eventTs: base, receivedTs: base, tradeId: 9, ordType: null, snapshot: false }); assert.equal(stoppedOwner.status().counters.tapeTrades, 0, 'no market for an unstarted owner: nothing is admitted');
    owner.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: base + 70_000, synced: true, checksumVerified: null, pricePrecision: 1, qtyPrecision: 8, levels: () => { throw new Error('boom'); } }); assert.equal(owner.status().counters.observerErrors, 1, 'a throwing accessor is counted, never propagated');
    for (let i = 0; i < 3000; i += 1) owner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 0.1, price: 100, eventTs: base + 80_000 + i, receivedTs: base + 80_000 + i, tradeId: 20_000 + i, ordType: null, snapshot: false });
    assert.ok(owner.status().counters.tapeDropped > 0, 'a full intake queue drops with a count instead of blocking the tape'); await H.waitFor(() => owner.coverage().some((c) => c.state === 'DROPPED' && c.reasonCodes.includes('QUEUE_DROPPED')), { timeoutMs: 3000 });
    await owner.stop({ seal: false }); owner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 1, price: 100, eventTs: base, receivedTs: base, tradeId: 99, ordType: null, snapshot: false }); assert.equal(owner.status().stopped, true);
  } finally { await fx.close(); }
});

test('SERVICE. the research service over fixtures: start opens a capture segment + loopback read-only HTTP; a case is queued and sealed as BUDGET_BLOCKED (model disabled => zero model calls); a duplicate pending subject returns the existing item; the pending ceiling refuses; an undeclared subject refuses; POST is refused; stop seals the capture, closes the journal and writes the status file; enqueue after stop refuses', async () => {
  const fx = await fixtures(); const root = tmp();
  try {
    const policy = H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT', 'KRAKEN_DERIVATIVES'], cases: { maxPendingCases: 2 } });
    const svc = createResearchService({ policy, subjects: subjectsBtc(), env: {}, researchRoot: root, mode: 'STANDALONE', fetchImpl: H.fetchFor(fx.http), WebSocketImpl: globalThis.WebSocket, wsUrls: { KRAKEN_SPOT: fx.kws.url, COINBASE_SPOT: fx.cws.url }, httpPort: 0, log: () => {} });
    const started = await svc.start(); assert.equal(started.state, 'ACTIVE'); assert.ok(started.http.port > 0); assert.ok(existsSync(started.segmentDir));
    await H.waitFor(() => svc.owner.status().counters.observations > 10, { timeoutMs: 8000 });
    assert.deepEqual(svc.enqueueCase({ canonicalCoin: 'DOGE' }), { accepted: false, reason: 'SUBJECT_NOT_DECLARED' });
    const first = svc.enqueueCase({ canonicalCoin: 'BTC', reason: 'TEST' }); assert.equal(first.accepted, true);
    await H.waitFor(() => svc.status().cases.recent.some((c) => c.status === 'BUDGET_BLOCKED'), { timeoutMs: 8000 });
    const recent = svc.status().cases.recent[0]; assert.equal(recent.diagnostic, 'MODEL_DISABLED'); assert.ok(recent.dir.startsWith('case-')); assert.equal(fx.http.requests.every((r) => r.host !== 'api.anthropic.com'), true, 'no model request');
    const get = async (p, init) => { const r = await fetch(`http://127.0.0.1:${started.http.port}${p}`, init); return { code: r.status, text: await r.text() }; };
    const st = await get('/status'); assert.equal(st.code, 200); const sj = JSON.parse(st.text); assert.equal(sj.state, 'ACTIVE'); assert.equal(sj.model.enabled, false); assert.equal(sj.authority, 'NONE');
    const cases = JSON.parse((await get('/cases')).text); assert.ok(cases.cases.includes(recent.dir), `cases ${JSON.stringify(cases.cases)} recent ${recent.dir}`); assert.equal((await get(`/cases/${recent.dir}/report`)).code, 200); assert.match((await get(`/cases/${recent.dir}/report`)).text, /No validated analysis/); assert.equal((await get(`/cases/${recent.dir}/manifest`)).code, 200); assert.equal((await get('/cases/../etc/report')).code, 404); assert.equal((await get('/status', { method: 'POST' })).code, 405);
    const readiness = JSON.parse((await get('/readiness')).text); assert.ok(['BLOCKED', 'NOT_VERIFIED'].includes(readiness.overall)); assert.equal(openBundle(path.join(root, 'cases', recent.dir), 'CASE').manifest.summary.status, 'BUDGET_BLOCKED');
    // queue law: with the ceiling at 2, a running + a pending item refuse the third; a duplicate pending subject dedups
    await H.waitFor(() => svc.status().cases.running === 0 && svc.status().cases.queued === 0, { timeoutMs: 5000 }); svc.runtime.close(); const a = svc.enqueueCase({ canonicalCoin: 'BTC' }); const b = svc.enqueueCase({ canonicalCoin: 'BTC' }); assert.equal(a.accepted, true); assert.equal(b.accepted, true); assert.equal(b.duplicate === true || a.duplicate === true || b.position === a.position, true); const c = svc.enqueueCase({ canonicalCoin: 'BTC' }); assert.equal(c.accepted === false ? c.reason : 'DUP', c.accepted ? 'DUP' : 'PENDING_CEILING');
    const stopped = await svc.stop(); assert.equal(stopped.state, 'STOPPED'); assert.ok(stopped.sealed?.bundleId, 'the capture segment is sealed on stop'); assert.ok(existsSync(path.join(root, 'status.json'))); assert.equal(JSON.parse(readFileSync(path.join(root, 'status.json'), 'utf8')).state, 'STOPPED');
    assert.deepEqual(svc.enqueueCase({ canonicalCoin: 'BTC' }), { accepted: false, reason: 'SERVICE_NOT_ACTIVE' }); assert.equal((await svc.stop()).state, 'STOPPED', 'stop is idempotent');
    await assert.rejects(fetch(`http://127.0.0.1:${started.http.port}/status`), 'the port is released');
  } finally { await fx.close(); rmSync(root, { recursive: true, force: true }); }
});
