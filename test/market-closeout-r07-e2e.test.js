// MARKET / SOCRATES CLOSEOUT — acceptance R07 (V02-V07), readiness (RD03, RD04) and the joined end-to-end cases E01-E07.
// V01, RD01 and RD02 live in market-closeout-witnesses.test.js. Offline only: the production owner / client / builder /
// runtime over loopback HTTP + WebSocket fixtures and a scripted Messages transport; fake clocks; temp directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { T0, tmp, json, btcOnly, includedPlan, cryptoquantPolicy, cryptoquantFetch, deribitTicker, DERIBIT_FOUR, deribitFourSummaries, deribitOwner, krakenBookOnly, bookObs, krakenWsScript, krakenTradeMsg, krakenRestFixture, H } from './helpers/market-closeout.js';
import { createResearchOwner } from '../market-lab/owner.js';
import { createResearchService } from '../market-lab/service.js';
import { loadPolicy, RESOURCE_DEFAULTS } from '../market-lab/policy.js';
import { makeObservation, makeCoverage, quality, emptyProvenance, subjectId, canonicalDigest, sha256Hex, FAMILIES, PROVIDER_IDS } from '../market-lab/contracts.js';
import { buildContext, contextError, contextIdentity, COMPONENT_KEYS } from '../market-lab/context.js';
import { METRIC_SCHEMAS, SUPPORT_STATES, componentValueError, contextSupportError } from '../market-lab/context-schema.js';
import { readCapture, runBuild, readContext, contextBundleError } from '../market-lab/commands.js';
import { openBundle, manifestIdentity, prepareOutputTarget, reserveOutputDir, jsonlWriter, writeAll, writeJsonFile } from '../market-lab/store.js';
import { codeIdentity, sourceClosure, codeIdentityError, MARKET_RESEARCH_ROOTS } from '../market-lab/identity.js';
import { providerReadiness, liveReadinessManifest } from '../market-lab/readiness.js';
import { buildCoverageMatrix } from '../market-lab/coverage.js';
import { explainDeepMarket, createDeepMarketSource } from '../market-lab/deep-market-adapter.js';
import { buildResearchEvidenceV2 } from '../evidence/research-builder.js';
import { validateEvidencePacketV2 } from '../evidence/contract-v2.js';
import { buildSocialProjection } from '../evidence/social-projection.js';
import { createBroker } from '../socrates/broker.js';
import { createCaseRuntime, verifyCase, ownerContextRebuilder } from '../socrates/runtime.js';
import { openBudgetJournal } from '../socrates/budget.js';
import { corpusCases, byKind } from '../socrates/corpus.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-ant-test-fixture-not-a-real-key';
const MODEL = { enabled: true, maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 5, maxEstimatedUsdPerMonth: 50, totalSmokeMaxEstimatedUsd: 1, maxOutputTokens: 2048 };
const message = (raw) => ({ type: 'message', id: 'msg_test', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }], usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
function fakeAnthropic(script) { const calls = []; let n = 0; const fetchImpl = async (url, init) => { const u = new URL(url); const body = JSON.parse(init.body); calls.push({ path: u.pathname, body }); if (u.pathname === '/v1/messages/count_tokens') return json({ input_tokens: 1000 }); const r = await script(body, n++, init); return json(r.json, r.status ?? 200); }; return { fetchImpl, calls, messages: () => calls.filter((c) => c.path === '/v1/messages') }; }
const mkt = { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: 'XXBTZUSD', venue: 'kraken', nativeSymbol: 'XBT/USD', base: 'BTC', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };
const trade = (i, ts, price, side = 'BUY') => makeObservation({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subject: mkt, kind: 'TRADE', sequence: i, epochId: null, sourceRevision: null, sourceKey: String(i), sourceEventTs: ts, publishedTs: null, periodStartTs: null, periodEndTs: null, receivedTs: ts + 5, knownAtTs: ts + 5, quality: quality('KNOWN', { methodologyId: 'kraken-ws-trade-v2', originalUnit: 'USD' }), provenance: emptyProvenance(), payload: { price, qty: 0.5, quoteNotional: price * 0.5, takerSide: side, sideConvention: 'TAKER_NATIVE', nativeTradeId: String(i), orderType: 'market' } });
const book = (i, ts) => makeObservation({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subject: mkt, kind: 'BOOK_SNAPSHOT', sequence: 1000 + i, epochId: null, sourceRevision: null, sourceKey: null, sourceEventTs: null, publishedTs: null, periodStartTs: null, periodEndTs: null, receivedTs: ts, knownAtTs: ts, quality: quality('KNOWN', { methodologyId: 'kraken-ws-book-v2', originalUnit: 'USD' }), provenance: emptyProvenance(), payload: { bids: [[99.9, 3], [99.5, 5]], asks: [[100.1, 2], [100.5, 4]], levelsPerSideCap: 200, synchronized: true, checksumVerified: true, bookAgeMs: 0, sampleReason: 'INTERVAL', pricePrecision: 1, qtyPrecision: 8 } });
const subscribed = (startTs) => makeCoverage({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subjectId: subjectId(mkt), family: 'SPOT_FLOW', kind: 'TRADE', state: 'SUBSCRIBED', reasonCodes: [], startTs, endTs: null, observationCount: 0, droppedCount: 0, epochId: null, sequenceStart: null, sequenceEnd: null });
const REF = { bundleId: 'audit' };
const populated = () => { const obs = []; for (let i = 0; i < 40; i += 1) obs.push(trade(i, T0 - 600_000 + i * 15_000, 100 + i * 0.01, i % 3 ? 'BUY' : 'SELL')); for (let i = 0; i < 12; i += 1) obs.push(book(i, T0 - 600_000 + i * 50_000)); obs.push(book(12, T0 - 1000)); return { obs, cov: [subscribed(T0 - 900_000)] }; };
const rebind = (ctx) => { for (const f of Object.values(ctx.families)) for (const c of f.components) { const cb = Object.fromEntries(COMPONENT_KEYS.filter((k) => k !== 'componentId').map((k) => [k, c[k]])); c.componentId = `mcc-${canonicalDigest(cb).slice(0, 40)}`; } ctx.contextId = contextIdentity(ctx); return ctx; };
const firstReport = (packet, requests = []) => { const chart = byKind(packet, 'MARKET_CHART_WINDOW'); const ids = [chart.evidenceId]; return { analysisState: 'ANALYZED', thesis: { text: `Close ${chart.value.fields.close} on kraken.`, evidenceRefs: ids, claimRefs: [], sourceRefs: [] }, mechanism: { description: 'Taker flow into displayed liquidity.', evidenceRefs: ids, claimRefs: [], sourceRefs: [] }, marketImplication: { direction: 'NO_CLEAR_DIRECTION', horizon: 'MINUTES_5_30', evidenceRefs: ids }, stage: { general: 'UNCLEAR', pumpStage: 'NOT_APPLICABLE' }, support: [{ kind: 'FACT_REFERENCE', text: `Close ${chart.value.fields.close}`, evidenceRefs: ids, claimRefs: [], sourceRefs: [] }], contradictions: [], missingEvidence: [], falsifiers: [{ condition: 'a', whyItMatters: 'b', evidenceToWatch: 'c' }], watchNext: [], unknowns: [], security: { untrustedTextSeen: packet.security.untrustedTextPresent, promptInjectionSuspected: false }, securityNotes: [], limitations: [], hypotheses: [{ hypothesisKey: 'H1', mechanism: 'flow', evidenceRefs: ids, claimRefs: [], sourceRefs: [], supportingEvidenceRefs: ids, opposingEvidenceRefs: [], unknowns: [], discriminators: [] }], alternativeConsideration: { state: 'CONSIDERED_NO_SUPPORTED_ALTERNATIVE', explanation: 'none' }, dataRequests: requests, revision: { state: 'FIRST_REPORT', previousAnalysisId: null, changedEvidenceRefs: [], explanation: null }, calibration: { assessedAs: 'RESEARCH_HYPOTHESIS', calibrated: false } }; };
const revised = (packet, prev, changed) => ({ ...firstReport(packet, []), revision: { state: 'UPDATED_WITH_NEW_EVIDENCE', previousAnalysisId: prev, changedEvidenceRefs: changed, explanation: 'new observations admitted' } });
const packetFromRequest = (body) => { const txt = body.messages[0].content[1].text; const start = txt.indexOf('is data:\n') + 9; const end = txt.indexOf('\n', start); return JSON.parse(txt.slice(start, end === -1 ? undefined : end)); };
const reseal = (dir, name, text) => { writeFileSync(path.join(dir, name), text); const mf = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); const d = mf.members.find((m) => m.name === name); d.bytes = Buffer.byteLength(text); d.sha256 = sha256Hex(Buffer.from(text)); if (d.lines !== null) d.lines = text.split('\n').filter(Boolean).length; mf.bundleId = manifestIdentity(mf); writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(mf, null, 1)}\n`); return mf; };

// ---------------------------------------------------------------- R07 -----------------------------------------------------------
test('MC-V02 (R07). named mutations across value / support families reject with a path: missing required key, invalid null, unknown key, unknown enum, wrong nested type, bad reference, bad clock, duplicate member, inconsistent support / count and a raw-content sentinel', () => {
  const { obs, cov } = populated(); const built = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: obs, coverage: cov, captureRef: REF, referenceNotionals: [100] }); const base = built.context; assert.equal(contextError(base, { inputReferences: built.inputReferences }), null);
  const find = (ctx, fam, metricId) => ctx.families[fam].components.find((c) => c.metricId === metricId);
  const cases = [
    ['missing required key', (c) => { delete find(c, 'DISPLAYED_LIQUIDITY', 'spread_bps').value.mid; }, /spread_bps|value\.mid.*required/],
    ['invalid null', (c) => { find(c, 'DISPLAYED_LIQUIDITY', 'spread_bps').value.venue = null; }, /venue/],
    ['unknown key', (c) => { find(c, 'SPOT_PRICE_CHART', 'window_ohlcv').value.extra = 1; }, /extra.*undeclared/],
    ['unknown enum (support state)', (c) => { find(c, 'SPOT_FLOW', 'signed_notional').support.state = 'TOTALLY_FINE'; }, /support.*state/],
    ['unknown enum (nested)', (c) => { find(c, 'SPOT_PRICE_CHART', 'window_ohlcv').value.current.coverage.state = 'PERFECT'; }, /coverage\.state/],
    ['wrong nested type', (c) => { find(c, 'DISPLAYED_LIQUIDITY', 'spread_bps').value.bands['5bps'].bid.qty = '3'; }, /5bps.*bid.*qty/],
    ['wrong nested type (flow)', (c) => { find(c, 'SPOT_FLOW', 'signed_notional').value.current.buyNotional = null; }, /buyNotional/],
    ['bad reference', (c) => { find(c, 'SPOT_PRICE_CHART', 'window_ohlcv').inputObservationIds = ['mo-' + 'b'.repeat(64)]; }, /input id not in input references|input/],
    ['bad clock (window reversed)', (c) => { const x = find(c, 'SPOT_PRICE_CHART', 'window_ohlcv'); x.windowStartTs = x.windowEndTs + 1; }, /window reversed|clock/],
    ['bad clock (derivation after as-of)', (c) => { find(c, 'SPOT_PRICE_CHART', 'window_ohlcv').derivationTs = T0 + 1; }, /derived|derivation|clock/],
    ['duplicate member', (c) => { const f = c.families.SPOT_FLOW; f.components.push(structuredClone(f.components[0])); }, /duplicate component/],
    ['inconsistent support / count', (c) => { const x = find(c, 'SPOT_PRICE_CHART', 'window_ohlcv'); x.inputObservationCount = 0; }, /input count/],
    ['support state outside the metric list', (c) => { find(c, 'DISPLAYED_LIQUIDITY', 'round_trip_loss').support.state = 'NO_BOOK'; }, /round_trip_loss state|support\.state/],
    ['raw-content sentinel', (c) => { find(c, 'CROSS_VENUE', 'venue_mid_dispersion').value.raw = '<html>PROVIDER BODY</html>'; }, /raw.*undeclared/],
    ['support reasons not strings', (c) => { find(c, 'SPOT_PRICE_CHART', 'window_ohlcv').support.reasons = [42]; }, /reasons/],
  ];
  for (const [name, mutate, re] of cases) { const hostile = rebind((() => { const h = structuredClone(base); mutate(h); return h; })()); const e = contextError(hostile, { inputReferences: built.inputReferences }); assert.ok(e, `${name}: must reject`); assert.match(e, re, `${name}: ${e}`); }
  // the same closed schema is ONE source of truth: every metric with a schema lists its support states and refuses a foreign state
  for (const [metricId, states] of Object.entries(SUPPORT_STATES)) { assert.ok(states.length >= 1, metricId); assert.ok(METRIC_SCHEMAS[metricId].value); }
  assert.match(componentValueError({ metricId: 'spread_bps', support: { state: 'FRESH', reasons: [] }, value: 'nope' }, 'x.value'), /must be an object/); assert.match(contextSupportError({ state: 'ok', reasons: [] }), /upper-case token/); assert.match(componentValueError({ metricId: 'unknown_metric', support: { state: 'X', reasons: [] }, value: {} }, 'x.value'), /no closed schema/);
});

test('MC-V03 (R07). lawful populated and legitimately partial contexts pass all four boundaries (contextError, candidate publication, reopen with the capture, packet assembly): validation never solves corruption by rejecting every partial input', async () => {
  const dir = tmp(); let now = T0; const schedules = []; const timers = { setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; schedules.push(h); return h; }, clearInterval: () => {}, setTimeout, clearTimeout };
  const p = H.policyWith({ providers: ['KRAKEN_SPOT'] }); const o = createResearchOwner({ policy: loadPolicy(p), subjects: btcOnly(), clock: () => now, mode: 'INTEGRATED', researchRoot: dir, log: () => {}, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), timers });
  await o.start({ outDir: path.join(dir, 'cap'), families: [] });
  for (let i = 1; i <= 30; i += 1) { now += 2000; o.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: i % 3 ? 'buy' : 'sell', qty: 0.5, price: 100 + i * 0.01, eventTs: now, receivedTs: now, tradeId: 60_000 + i, ordType: 'market', snapshot: false }); }
  o.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: now, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2], [99, 3]], asks: [[100.5, 2], [101, 3]] }) });
  for (const s of schedules) if (s.ms === 250) s.fn(); now += 1000; const stopped = await o.stop({ seal: true }); assert.ok(stopped.sealed);
  const capDir = path.join(dir, 'cap'); const cap = readCapture(capDir);
  // populated (trades + book, no positive interval coverage: an honest UNKNOWN_COVERAGE window) and partial (book only) contexts
  const full = runBuild({ captureDir: capDir, asOfTs: now, canonicalCoin: 'BTC', out: path.join(dir, 'ctx-full') }); const reopenedFull = readContext(path.join(dir, 'ctx-full'), { capture: cap }); assert.equal(reopenedFull.derivation.verified, true, JSON.stringify(reopenedFull.derivation));
  assert.equal(contextError(reopenedFull.context, { inputReferences: reopenedFull.inputReferences }), null); assert.equal(reopenedFull.context.families.SPOT_PRICE_CHART.state, 'OBSERVED'); assert.equal(reopenedFull.context.families.DISPLAYED_LIQUIDITY.state, 'OBSERVED');
  const w = reopenedFull.context.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current; assert.equal(w.support.state, 'UNKNOWN_COVERAGE', 'the integrated seam has no continuity fact: honestly partial, still lawful'); assert.ok(w.observedCount >= 1);
  const pk = buildResearchEvidenceV2({ marketContext: reopenedFull.context, asOfTs: now, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(pk.ok, true, JSON.stringify(pk.detail ?? null)); assert.equal(validateEvidencePacketV2(pk.packet).valid, true, JSON.stringify(validateEvidencePacketV2(pk.packet).reasons));
  const early = runBuild({ captureDir: capDir, asOfTs: T0 + 1500, canonicalCoin: 'BTC', out: path.join(dir, 'ctx-early') }); const reopenedEarly = readContext(path.join(dir, 'ctx-early'), { capture: cap });
  assert.equal(reopenedEarly.context.families.DISPLAYED_LIQUIDITY.components[0].support.state, 'NO_BOOK', 'a legitimately partial context (no book yet) passes every boundary'); assert.equal(contextError(reopenedEarly.context, { inputReferences: reopenedEarly.inputReferences }), null);
  const pkEarly = buildResearchEvidenceV2({ marketContext: reopenedEarly.context, asOfTs: T0 + 1500, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(pkEarly.ok, true, JSON.stringify(pkEarly.detail ?? null)); assert.equal(pkEarly.packet.evidence.find((e) => e.kind === 'MARKET_BOOK_CONTEXT').state !== 'KNOWN', true);
  assert.equal(early.contextId !== full.contextId, true); rmSync(dir, { recursive: true, force: true });
});

test('MC-V04 (R07). resealed artifact mutations reach the semantic validators: an omitted required member, false coverage counts, a wrong prefix, a packet-map mismatch and an inconsistent case status / report each reject with consistent outer checksums', async () => {
  const dir = tmp(); const { obs, cov } = populated(); let now = T0; const schedules = []; const timers = { setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; schedules.push(h); return h; }, clearInterval: () => {}, setTimeout, clearTimeout };
  const o = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), clock: () => now, mode: 'INTEGRATED', researchRoot: dir, log: () => {}, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), timers });
  await o.start({ outDir: path.join(dir, 'cap'), families: [] }); for (let i = 1; i <= 10; i += 1) { now += 2000; o.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 0.5, price: 100, eventTs: now, receivedTs: now, tradeId: 70_000 + i, ordType: 'market', snapshot: false }); } for (const s of schedules) if (s.ms === 250) s.fn(); now += 1000; await o.stop({ seal: true });
  const capDir = path.join(dir, 'cap'); const cap = readCapture(capDir); const ctxDir = path.join(dir, 'ctx'); runBuild({ captureDir: capDir, asOfTs: now, canonicalCoin: 'BTC', out: ctxDir }); assert.equal(readContext(ctxDir, { capture: cap }).derivation.verified, true);
  // omitted required member
  const gone = path.join(dir, 'ctx-gone'); mkdirSync(gone); for (const f of readdirSync(ctxDir)) if (f !== 'coverage.json') writeFileSync(path.join(gone, f), readFileSync(path.join(ctxDir, f))); assert.throws(() => readContext(gone), /coverage\.json|member|layout/);
  // false coverage counts (resealed)
  const c2 = path.join(dir, 'ctx-cov'); mkdirSync(c2); for (const f of readdirSync(ctxDir)) writeFileSync(path.join(c2, f), readFileSync(path.join(ctxDir, f))); const covj = JSON.parse(readFileSync(path.join(c2, 'coverage.json'), 'utf8')); covj.families.SPOT_PRICE_CHART.components += 1; reseal(c2, 'coverage.json', `${JSON.stringify(covj, null, 1)}\n`); assert.equal(openBundle(c2, 'CONTEXT').manifest.bundleId !== null, true); assert.throws(() => readContext(c2), /counts disagree/);
  // wrong prefix (resealed with recomputed context identity)
  const c3 = path.join(dir, 'ctx-prefix'); mkdirSync(c3); for (const f of readdirSync(ctxDir)) writeFileSync(path.join(c3, f), readFileSync(path.join(ctxDir, f))); const cj = JSON.parse(readFileSync(path.join(c3, 'context.json'), 'utf8')); cj.captureRef.segments[0].observationsSha256 = 'e'.repeat(64); cj.contextId = contextIdentity(cj); const mf3 = reseal(c3, 'context.json', `${JSON.stringify(cj, null, 1)}\n`); mf3.summary.contextId = cj.contextId; mf3.bundleId = manifestIdentity(mf3); writeFileSync(path.join(c3, 'manifest.json'), `${JSON.stringify(mf3, null, 1)}\n`);
  assert.throws(() => readContext(c3), /prefixId does not match|prefix/);
  // packet-map mismatch and inconsistent status / report on a sealed case
  const c = corpusCases().find((x) => x.id === 'C01'); const api = fakeAnthropic(async () => ({ json: message(c.scripted) })); const cdir = path.join(dir, 'case');
  const rt = createCaseRuntime({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'], model: MODEL })), env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: api.fetchImpl, budgetDir: path.join(dir, 'budget') });
  try { const r = await rt.runCase({ packet: c.packet, out: cdir }).done; assert.equal(r.status, 'COMPLETED'); } finally { await rt.close(); }
  const copy = (name) => { const d = path.join(dir, name); mkdirSync(d); for (const f of readdirSync(cdir)) writeFileSync(path.join(d, f), readFileSync(path.join(cdir, f))); return d; };
  const pm = copy('case-map'); const cm = JSON.parse(readFileSync(path.join(pm, 'case.json'), 'utf8')); cm.inputs = [{ packetId: c.packet.packetId, contextId: 'mctx-' + 'c'.repeat(64), captureRef: null, asOfTs: c.packet.asOfTs, contextParams: null }]; reseal(pm, 'case.json', `${JSON.stringify(cm, null, 1)}\n`); const v1 = verifyCase(pm); assert.equal(v1.ok, false); assert.match(v1.reasons.join(' '), /inputs|prefix/);
  const st = copy('case-status'); const cs = JSON.parse(readFileSync(path.join(st, 'case.json'), 'utf8')); cs.status = 'BUDGET_BLOCKED'; const mfs = reseal(st, 'case.json', `${JSON.stringify(cs, null, 1)}\n`); mfs.summary.status = 'BUDGET_BLOCKED'; mfs.bundleId = manifestIdentity(mfs); writeFileSync(path.join(st, 'manifest.json'), `${JSON.stringify(mfs, null, 1)}\n`); const v2 = verifyCase(st); assert.equal(v2.ok, false); assert.match(v2.reasons.join(' '), /BUDGET_BLOCKED|status|selected/);
  const rp = copy('case-report'); reseal(rp, 'report.md', `${readFileSync(path.join(rp, 'report.md'), 'utf8')}\n\nAppended claim.\n`); const v3 = verifyCase(rp); assert.equal(v3.ok, false); assert.match(v3.reasons.join(' '), /report\.md/);
  assert.equal(verifyCase(cdir).ok, true, 'the untouched case still verifies'); rmSync(dir, { recursive: true, force: true });
});

test('MC-V05 (R07). a valid numeric mutation with identities and hashes resealed is rejected when the original capture is supplied; without the source the reader labels its more limited proof honestly', async () => {
  const dir = tmp(); let now = T0; const schedules = []; const timers = { setInterval: (fn, ms) => { const h = { fn, ms, unref() {} }; schedules.push(h); return h; }, clearInterval: () => {}, setTimeout, clearTimeout };
  const o = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), clock: () => now, mode: 'INTEGRATED', researchRoot: dir, log: () => {}, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), timers });
  await o.start({ outDir: path.join(dir, 'cap'), families: [] }); for (let i = 1; i <= 10; i += 1) { now += 2000; o.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 0.5, price: 100, eventTs: now, receivedTs: now, tradeId: 80_000 + i, ordType: 'market', snapshot: false }); }
  o.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: now, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2]], asks: [[100.5, 2]] }) }); for (const s of schedules) if (s.ms === 250) s.fn(); now += 1000; await o.stop({ seal: true });
  const capDir = path.join(dir, 'cap'); const cap = readCapture(capDir); const ctxDir = path.join(dir, 'ctx'); runBuild({ captureDir: capDir, asOfTs: now, canonicalCoin: 'BTC', out: ctxDir });
  const cj = JSON.parse(readFileSync(path.join(ctxDir, 'context.json'), 'utf8')); const sp = cj.families.DISPLAYED_LIQUIDITY.components.find((c) => c.metricId === 'spread_bps'); assert.equal(typeof sp.value.spreadBps, 'number'); sp.value.spreadBps = sp.value.spreadBps + 1; // still a valid number
  rebind(cj); const mf = reseal(ctxDir, 'context.json', `${JSON.stringify(cj, null, 1)}\n`); mf.summary.contextId = cj.contextId; mf.bundleId = manifestIdentity(mf); writeFileSync(path.join(ctxDir, 'manifest.json'), `${JSON.stringify(mf, null, 1)}\n`);
  const noSource = readContext(ctxDir); assert.equal(noSource.derivation.verified, false); assert.equal(noSource.derivation.reason, 'SOURCE_NOT_SUPPLIED'); assert.match(noSource.derivation.note, /no independent source attestation/);
  assert.throws(() => readContext(ctxDir, { capture: cap }), /does not recompute/, 'with the original capture the numeric mutation is exposed');
  rmSync(dir, { recursive: true, force: true });
});

test('MC-V06 (R07). an invalid candidate never acquires a completion manifest; exact-byte limits, multibyte rows, an occupied member path, a closed descriptor and a double close leave no false seal and no leaked descriptor', () => {
  const dir = tmp(); const { obs, cov } = populated();
  const real = prepareOutputTarget(path.join(dir, 'w')); const res = reserveOutputDir(real);
  const w = jsonlWriter(res, 'observations.jsonl', { lineBytes: 32, fileBytes: 70 });
  const row = { s: 'ééééé' }; const enc = w.encode(row); assert.equal(enc.length, Buffer.byteLength(`${JSON.stringify(row)}\n`)); assert.ok(enc.length > JSON.stringify(row).length, 'multibyte rows are measured in BYTES');
  const exact = { s: 'x'.repeat(32 - '{"s":""}\n'.length) }; assert.equal(w.encode(exact).length, 32); assert.equal(w.fits(w.encode(exact)).line, true); assert.equal(w.fits(w.encode({ s: 'x'.repeat(32 - '{"s":""}\n'.length + 1) })).line, false, 'one byte over the line bound');
  w.append(exact); w.append(exact); assert.throws(() => w.append(exact), /exceed/); const d = w.close(); assert.equal(d.lines, 2); assert.equal(d.bytes, 64); assert.throws(() => w.close(), /closed twice/); assert.throws(() => w.append(exact), /closed/);
  mkdirSync(path.join(real, 'coverage.json')); assert.throws(() => writeJsonFile(res, 'coverage.json', {}), /cannot write|IO_FAILURE|EEXIST|EISDIR/);
  const fd = openSync(path.join(real, 'tmpfile'), 'w'); closeSync(fd); assert.throws(() => writeAll(fd, Buffer.from('x'), 'tmpfile'), /write failed/); assert.equal(res.sealed, false); assert.equal(existsSync(path.join(real, 'manifest.json')), false); res.cleanup();
  // a context candidate above its byte bound never publishes: no manifest, no leftover directory
  const capture = { bundle: { manifest: { bundleId: 'mb-' + 'a'.repeat(64) }, manifestSha256: 'b'.repeat(64), members: { 'observations.jsonl': { sha256: 'c'.repeat(64) }, 'coverage.jsonl': { sha256: 'd'.repeat(64) } } } };
  const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: obs, coverage: cov, captureRef: { bundleId: capture.bundle.manifest.bundleId, manifestSha256: capture.bundle.manifestSha256 }, referenceNotionals: [100] });
  assert.ok(JSON.stringify(ctx.context).length > 2048); const out = path.join(dir, 'ctx-small');
  assert.throws(() => { const r2 = reserveOutputDir(prepareOutputTarget(out)); try { writeJsonFile(r2, 'context.json', ctx.context, { maxBytes: 2048 }); } catch (err) { r2.cleanup(); throw err; } }, /exceeds/); assert.equal(existsSync(out), false, 'a refused candidate leaves nothing behind');
  const hostile = rebind((() => { const h = structuredClone(ctx.context); h.families.DISPLAYED_LIQUIDITY.components[0].value.spreadBps = 'x'; return h; })()); const identity = codeIdentity();
  assert.match(contextBundleError({ context: hostile, inputReferences: ctx.inputReferences, coverage: { coverageVersion: 'market-context-coverage-2', asOfTs: T0, canonicalCoin: 'BTC', admissible: 99, late: 0, families: {}, params: { canonicalCoin: 'BTC', referenceNotionals: [100], peers: [] } }, identity }), /spreadBps/, 'the shared candidate validator refuses BEFORE any manifest');
  rmSync(dir, { recursive: true, force: true });
});

test('MC-V07 (R07). the code identity covers the new effective modules through the four roots; clean / dirty / no-git facts stay truthful without touching protected sources', () => {
  const closure = sourceClosure(); for (const f of ['market-lab/quota.js', 'market-lab/retention.js', 'market-lab/prefix.js', 'market-lab/context-schema.js', 'market-lab/context.js', 'market-lab/owner.js', 'socrates/runtime.js', 'socrates/broker.js', 'evidence/research-builder.js']) assert.ok(closure.includes(f), `${f} in the closure`);
  assert.deepEqual([...MARKET_RESEARCH_ROOTS], ['bin/market-research.js', 'bin/socrates-research.js', 'market-lab/deep-market-adapter.js', 'market-lab/service.js']);
  const real = codeIdentity(); assert.equal(codeIdentityError(real), null); assert.equal(real.sourceFiles, closure.length);
  const clean = codeIdentity({ git: { revParse: () => 'a'.repeat(40), status: () => false } }); assert.equal(clean.law, 'PRODUCED_BY_COMMITTED_SOURCE'); assert.equal(clean.sourceTreeSha256, real.sourceTreeSha256, 'the tree hash is the bytes, independent of git facts');
  const dirty = codeIdentity({ git: { revParse: () => 'a'.repeat(40), status: () => true } }); assert.equal(dirty.law, 'PRODUCED_BY_UNCOMMITTED_SOURCE'); assert.equal(dirty.gitSourceDirty, true);
  const unknown = codeIdentity({ git: { revParse: () => 'a'.repeat(40), status: () => null } }); assert.equal(unknown.law, 'SOURCE_CLEANLINESS_UNKNOWN');
  const nogit = codeIdentity({ git: { revParse: () => null, status: () => null } }); assert.equal(nogit.law, 'NO_GIT_CHECKOUT'); assert.equal(nogit.gitCommit, null); for (const v of [clean, dirty, unknown, nogit]) assert.equal(codeIdentityError(v), null);
  assert.match(codeIdentityError({ ...clean, law: 'NO_GIT_CHECKOUT' }), /law disagrees/);
  const missing = codeIdentity({ roots: ['market-lab/does-not-exist.js'] }); assert.equal(missing.law, 'NO_GIT_CHECKOUT'); assert.equal(missing.sourceTreeSha256, null); assert.match(codeIdentityError(missing), /missing source/);
});

// ---------------------------------------------------------------- readiness ------------------------------------------------------
test('MC-RD03 (readiness). an explicitly partial family keeps the overall state non-green; a fully supported synthetic all-required case passes READINESS_GREEN (the gate is not hardwired red)', () => {
  const policy = loadPolicy(H.policyWith({ providers: [...PROVIDER_IDS] })); const env = Object.fromEntries(PROVIDER_IDS.map((id) => [`${id}_API_KEY`, 'x']));
  const rows = providerReadiness({ policy, env, testReport: Object.fromEntries(PROVIDER_IDS.map((id) => [id, 'PASSED'])), liveReport: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { state: 'PASSED', ts: T0, endpointId: 'e', asset: 'BTC', evidence: 'synthetic' }])) });
  const full = Object.fromEntries(FAMILIES.map((f) => [f, { requested: 1, obtained: 1, assets: ['BTC'], nativeLatencyMs: 10, complete: true, providerId: null, smokeTs: T0, metrics: null }]));
  const green = liveReadinessManifest({ rows, familyCoverage: full, modelReadiness: { enabled: true, credentialPresent: true, liveVerification: 'PASSED' }, generatedTs: T0 }); assert.equal(green.overall, 'READINESS_GREEN', JSON.stringify(green.blockers)); assert.deepEqual(green.blockers, []); assert.ok(FAMILIES.every((f) => green.families[f].state === 'LIVE'));
  const partial = liveReadinessManifest({ rows, familyCoverage: { ...full, OPTIONS_TERM_SKEW: { ...full.OPTIONS_TERM_SKEW, complete: false } }, modelReadiness: { enabled: true, credentialPresent: true, liveVerification: 'PASSED' }, generatedTs: T0 });
  assert.equal(partial.families.OPTIONS_TERM_SKEW.state, 'PARTIAL_LIVE'); assert.notEqual(partial.overall, 'READINESS_GREEN'); assert.ok(partial.familiesNotLive.includes('OPTIONS_TERM_SKEW')); assert.ok(partial.blockers.some((b) => /OPTIONS_TERM_SKEW/.test(b)));
  const absent = liveReadinessManifest({ rows, familyCoverage: { ...full, ETF_FLOWS: null }, modelReadiness: { enabled: true, credentialPresent: true, liveVerification: 'PASSED' }, generatedTs: T0 }); assert.notEqual(absent.overall, 'READINESS_GREEN'); assert.equal(absent.families.ETF_FLOWS.state, 'NOT_VERIFIED');
});

test('MC-RD04 (readiness). declared-policy counts are computed from the 17-family artifact; a disabled or unauthorised alternative provider never overrides the qualified source', () => {
  const PUBLIC = ['KRAKEN_SPOT', 'COINBASE_SPOT', 'KRAKEN_DERIVATIVES', 'DERIBIT', 'BYBIT', 'COINGECKO', 'GECKOTERMINAL', 'DEFILLAMA', 'COINMETRICS', 'SETTLED_RECORDS']; const subjects = btcOnly();
  const count = (m) => { const c = {}; for (const v of Object.values(m.families)) c[v.state] = (c[v.state] ?? 0) + 1; return c; };
  const pub = buildCoverageMatrix({ policy: loadPolicy(H.policyWith({ providers: PUBLIC })), subjects, env: {} }); assert.equal(Object.keys(pub.families).length, 17); assert.deepEqual(Object.keys(pub.families), [...FAMILIES]);
  const pc = count(pub); assert.equal(pc.COVERED_BY_DECLARED_POLICY + (pc.ENABLED_BUT_BLOCKED ?? 0) + (pc.UNCOVERED ?? 0), 17, 'the counts partition the 17 families'); assert.equal(pub.families.ONCHAIN_ENTITY_FLOW.state, 'UNCOVERED', 'a paid-only family is UNCOVERED under a public policy');
  const raw = H.policyWith({ providers: [...PUBLIC, 'CRYPTOQUANT'] }); const unauthorised = buildCoverageMatrix({ policy: loadPolicy(raw), subjects, env: { CRYPTOQUANT_API_KEY: 'x' } }); assert.equal(unauthorised.families.ONCHAIN_ENTITY_FLOW.state, 'ENABLED_BUT_BLOCKED', 'an enabled paid provider without an attested plan is blocked, never covering');
  includedPlan(raw, 'CRYPTOQUANT'); const authorised = buildCoverageMatrix({ policy: loadPolicy(raw), subjects, env: { CRYPTOQUANT_API_KEY: 'x' } }); assert.equal(authorised.families.ONCHAIN_ENTITY_FLOW.state, 'COVERED_BY_DECLARED_POLICY'); assert.equal(authorised.families.ONCHAIN_ENTITY_FLOW.cheapestSupplied.providerId, 'CRYPTOQUANT');
  const withDisabledAlt = buildCoverageMatrix({ policy: loadPolicy(raw), subjects, env: { CRYPTOQUANT_API_KEY: 'x' } }); assert.equal(withDisabledAlt.families.ONCHAIN_ENTITY_FLOW.routes.find((r) => r.providerId === 'SANTIMENT').enabled, false); assert.equal(withDisabledAlt.families.ONCHAIN_ENTITY_FLOW.state, 'COVERED_BY_DECLARED_POLICY', 'a disabled alternative does not override the qualified source');
  assert.equal(count(authorised).COVERED_BY_DECLARED_POLICY, pc.COVERED_BY_DECLARED_POLICY + 1); assert.ok(pub.providerCalls.every((p) => typeof p.withinLocalCaps === 'boolean'));
});

// ---------------------------------------------------------------- E01-E07 --------------------------------------------------------
// the connected fixture world: Kraken REST + WS (positive trade coverage), Deribit census + tickers (Greeks), CryptoQuant network metric
async function connectedOwner({ clock, dir, extra = {} }) {
  const http = await krakenRestFixture(); let conn = null; const kws = await H.startWsFixture({ path: '/v2', onConnection: (c) => { conn = c; krakenWsScript()(c); } });
  const raw = H.policyWith({ providers: ['KRAKEN_SPOT', 'DERIBIT', 'CRYPTOQUANT'], model: MODEL }); includedPlan(raw, 'CRYPTOQUANT', extra.plan ?? {}); const policy = loadPolicy(raw); const wire = [];
  const fetchImpl = async (url, init) => { const u = new URL(url); wire.push(u.host + u.pathname); if (u.host === 'api.kraken.com') return H.fetchFor(http)(url, init); if (u.host === 'www.deribit.com') { if (u.pathname.endsWith('get_instruments')) return json(DERIBIT_FOUR); if (u.pathname.endsWith('get_book_summary_by_currency')) return json(deribitFourSummaries()); if (u.pathname.endsWith('/ticker')) { const t = deribitTicker(u.searchParams.get('instrument_name')); return t ? json(t) : json({ error: { code: 1 } }, 400); } } if (u.host === 'api.cryptoquant.com') return cryptoquantFetch()(url); return json({}, 404); };
  const owner = createResearchOwner({ policy, subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock, fetchImpl, WebSocketImpl: globalThis.WebSocket, wsUrls: { KRAKEN_SPOT: kws.url }, researchRoot: dir, log: () => {} });
  return { owner, policy, wire, conn: () => conn, close: async () => { await kws.close(); await http.close(); } };
}
async function populatedCase({ dir, clk, script, extra = {} }) {
  const fx = await connectedOwner({ clock: clk, dir, extra }); const { owner, policy } = fx;
  await owner.start({ outDir: path.join(dir, 'cap'), families: ['OPTIONS_TERM_SKEW', 'NETWORK_ACTIVITY'] }); await H.waitFor(() => owner.status().streams.KRAKEN_SPOT?.subscribed?.length >= 1, { timeoutMs: 5000 });
  clk.set(T0 + 130_000); fx.conn().send({ channel: 'trade', type: 'update', data: [krakenTradeMsg(1, { price: 100, qty: 0.2, side: 'buy', ts: T0 + 125_000 }), krakenTradeMsg(2, { price: 100.4, qty: 0.2, side: 'buy', ts: T0 + 126_000 }), krakenTradeMsg(3, { price: 100.2, qty: 0.2, side: 'sell', ts: T0 + 127_000 })] }); await H.waitFor(() => owner.status().streams.KRAKEN_SPOT?.trades >= 3, { timeoutMs: 5000 });
  clk.set(T0 + 180_000); const rebuild = ownerContextRebuilder(owner, { referenceNotionals: [100] }); const snap = owner.snapshotPrefix(); const asOf = clk();
  const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: asOf, observations: snap.observations, coverage: snap.coverage, captureRef: snap.prefix, referenceNotionals: [100], peers: [], resourceState: snap.resourceState }).context;
  const b = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: asOf, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(b.ok, true, JSON.stringify(b.detail ?? null));
  const api = fakeAnthropic(script(b.packet)); const rt = createCaseRuntime({ policy, env: { ANTHROPIC_API_KEY: KEY, CRYPTOQUANT_API_KEY: 'offline-fixture' }, owner, clock: clk, fetchImpl: api.fetchImpl, budgetDir: path.join(dir, 'budget'), contextRebuilder: rebuild, ...(extra.runtime ?? {}) });
  const r = await rt.runCase({ packet: b.packet, marketContext: ctx, out: path.join(dir, 'case'), contextParams: rebuild.params({ canonicalCoin: 'BTC' }) }).done;
  return { fx, owner, policy, ctx, packet: b.packet, api, rt, r, snap, asOf };
}
test('MC-E01 (joined). production owner + fake HTTP/WS -> guarded acquisition -> sealed capture / prefix -> context -> v2 packet -> ACTUAL Anthropic client over a scripted response -> validated report -> sealed case -> reopen; the serialized model request carries the expected numbers, support states and citations', async () => {
  const dir = tmp(); const clk = H.clockAt(T0); let world = null;
  try {
    world = await populatedCase({ dir, clk, script: (packet) => async () => ({ json: message(firstReport(packet, [])) }) }); const { owner, ctx, packet, api, rt, r, wire } = { ...world, wire: world.fx.wire };
    assert.equal(r.status, 'COMPLETED', JSON.stringify(r.manifest.diagnostic)); assert.equal(api.messages().length, 1); assert.equal(r.publication, 'SEALED');
    assert.ok(wire.some((w) => w.includes('/ticker')) && wire.some((w) => w.includes('addresses-count')) && wire.some((w) => w.includes('get_instruments')), `guarded acquisitions happened (${JSON.stringify([...new Set(wire)])})`);
    const surface = ctx.families.OPTIONS_TERM_SKEW.components[0].value; assert.ok(Math.abs(surface.term[0].riskReversal25d - (-0.12)) < 1e-9); assert.equal(surface.censusComplete, true);
    const w = ctx.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current; assert.equal(w.support.state, 'COMPLETE'); assert.equal(w.count, 3);
    const exit = ctx.families.DISPLAYED_LIQUIDITY.components.find((c) => c.metricId === 'round_trip_loss'); assert.equal(exit.value.current.coverage, 'FULL'); const net = ctx.families.NETWORK_ACTIVITY.components.find((c) => c.metricId === 'active_addresses'); assert.equal(net.value.value, 7000);
    const text = api.messages()[0].body.messages[0].content[1].text; assert.ok(text.includes(packet.packetId), 'the packet id is in the request');
    for (const needle of ['MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE', String(exit.value.current.lossBps), 'MARKET_OPTIONS_CONTEXT', '-0.12', 'MARKET_NETWORK_CONTEXT', '7000', 'MARKET_CHART_WINDOW', '"COMPLETE"', 'KRAKEN_SPOT', 'DERIBIT', 'CRYPTOQUANT']) assert.ok(text.includes(needle), `the serialized request carries ${needle}`);
    assert.equal(validateEvidencePacketV2(packet).valid, true); assert.ok(packet.evidence.every((e) => !e.value || e.sourceRefs.length >= 1), 'every value-bearing item cites its source');
    assert.equal(r.manifest.inputs[0].captureRef.durable, true); await rt.close(); await owner.stop({ seal: true });
    const v = verifyCase(path.join(dir, 'case'), { resolveInputs: true }); assert.equal(v.ok, true, v.reasons.join('; ')); assert.equal(v.status, 'COMPLETED'); assert.equal(v.inputResolution[0].recomputed, v.inputs[0].contextId);
    assert.match(readFileSync(path.join(dir, 'case', 'report.md'), 'utf8'), /Close 100\.2 on kraken/);
  } finally { if (world) { await world.rt.close(); await world.owner.stop({ seal: false }); await world.fx.close(); } rmSync(dir, { recursive: true, force: true }); }
});

test('MC-E02 (joined). a real follow-up: the initial scripted response asks one registered metric; the broker takes the guarded owner route, seals a new prefix and P1, the second Messages request carries the new evidence and the second report cites it; P0 stays byte-identical', async () => {
  const dir = tmp(); const clk = H.clockAt(T0); let world = null;
  try {
    let P0 = null; let netId = null;
    world = await populatedCase({ dir, clk, extra: { plan: { remaining: 100 } }, script: (packet) => async (body, n) => { clk.advance(1500); if (n === 0) { P0 = packet; return { json: message(firstReport(packet, [{ requestKey: 'Q1', requestKind: 'REFRESH', family: 'ONCHAIN_ENTITY_FLOW', metricIds: ['exchange_reserve'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null, hypothesisRefs: ['H1'], question: 'Exchange reserve now?', interpretationIfSupported: 'x', interpretationIfContradicted: 'y' }])) }; } const p1 = packetFromRequest(body); netId = p1.evidence.find((e) => e.kind === 'MARKET_ONCHAIN_CONTEXT')?.evidenceId ?? null; return { json: message(revised(p1, /analysisId (soc2-[0-9a-f]{40})/.exec(body.messages[0].content[1].text)[1], netId ? [netId] : [])) }; } });
    const { r, api, fx } = world; assert.equal(r.status, 'COMPLETED', JSON.stringify(r.manifest.diagnostic)); assert.equal(r.packets.length, 2); assert.equal(api.messages().length, 2);
    assert.ok(fx.wire.filter((w) => w.includes('exchange-flows')).length >= 1, 'the owner bought the requested reserve series through the guard'); assert.equal(r.results[0].state, 'SATISFIED'); assert.ok(r.results[0].usage.dispatched >= 1);
    assert.equal(JSON.stringify(r.packets[0]), JSON.stringify(P0), 'P0 byte-identical'); assert.ok(netId, 'the new evidence has an id'); assert.ok(r.analyses[1].revision.changedEvidenceRefs.includes(netId), 'the second report cites the actual new evidence');
    assert.ok(api.messages()[1].body.messages[0].content[1].text.includes('MARKET_ONCHAIN_CONTEXT'), 'the second request carries the acquired metric'); assert.notEqual(r.manifest.inputs[1].captureRef.prefixId, r.manifest.inputs[0].captureRef.prefixId, 'P1 cites a NEW immutable prefix');
    await world.rt.close(); await world.owner.stop({ seal: true }); const v = verifyCase(path.join(dir, 'case'), { resolveInputs: true }); assert.equal(v.ok, true, v.reasons.join('; ')); assert.equal(v.inputs.length, 2);
    // wrong-metric local data cannot satisfy the request: only the reserve series is retained, an active-address request stays unsatisfied without a wire
    const local = world.owner.observations().filter((o) => o.kind === 'ONCHAIN_METRIC'); assert.ok(local.length >= 1);
    const wrong = await createBroker({ owner: { observations: () => local, coverage: () => [], acquire: async () => { throw new Error('no wire in DETAIL'); } }, policy: world.policy, clock: clk }).resolve({ requestKey: 'Q2', requestKind: 'DETAIL', family: 'ONCHAIN_ENTITY_FLOW', metricIds: ['holder_cohorts'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null, hypothesisRefs: [], question: 'q', interpretationIfSupported: 'x', interpretationIfContradicted: 'y' }, { analysisId: 'soc2-' + 'e'.repeat(40), caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs: clk(), deadlineTs: clk() + 1000 });
    assert.notEqual(wrong.state, 'SATISFIED'); assert.equal(wrong.observationsAdmitted, 0);
  } finally { if (world) { await world.rt.close(); await world.owner.stop({ seal: false }); await world.fx.close(); } rmSync(dir, { recursive: true, force: true }); }
});

test('MC-E03 (joined). the same connected request under a depleted provider allowance and a depleted model allowance refuses BEFORE any wire dispatch: no synthetic evidence, no hidden fallback, no misleading completed interpretation', async () => {
  const dir = tmp(); const clk = H.clockAt(T0); let world = null;
  try {
    world = await populatedCase({ dir, clk, extra: { plan: { remaining: 0 } }, script: (packet) => async () => ({ json: message(firstReport(packet, [])) }) });
    const { r, fx, ctx, packet } = world; assert.ok(!fx.wire.some((w) => w.includes('api.cryptoquant.com')), 'a depleted included plan dispatches nothing to the paid provider'); assert.equal(ctx.families.NETWORK_ACTIVITY.components.length, 0); assert.equal(packet.evidence.find((e) => e.kind === 'MARKET_NETWORK_CONTEXT').state !== 'KNOWN', true, 'no synthetic network evidence');
    assert.equal(r.status, 'COMPLETED', `the model itself still ran here; the provider refusal is visible in the packet, not laundered into a failure (${JSON.stringify(r.manifest.diagnostic)})`); await world.rt.close();
    const depleted = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'], model: { ...MODEL, maxEstimatedUsdPerDay: 0.001 } })); const api = fakeAnthropic(async () => { throw new Error('must not be called'); });
    const rt2 = createCaseRuntime({ policy: depleted, env: { ANTHROPIC_API_KEY: KEY }, clock: clk, fetchImpl: api.fetchImpl, budgetDir: path.join(dir, 'budget2') });
    const r2 = await rt2.runCase({ packet, marketContext: ctx, out: path.join(dir, 'case2') }).done; await rt2.close();
    assert.equal(r2.status, 'BUDGET_BLOCKED'); assert.equal(r2.manifest.diagnostic.kind, 'BUDGET_BLOCKED'); assert.equal(api.messages().length, 0, 'no model dispatch under a depleted allowance'); assert.equal(r2.analyses.length, 0); assert.match(readFileSync(path.join(dir, 'case2', 'report.md'), 'utf8'), /No validated analysis/);
    const j = openBudgetJournal({ dir: path.join(dir, 'budget2') }); assert.equal(j.reservations().length, 0, 'a refused reservation is never written as spend'); j.close(); assert.equal(verifyCase(path.join(dir, 'case2')).ok, true);
  } finally { if (world) { await world.rt.close(); await world.owner.stop({ seal: false }); await world.fx.close(); } rmSync(dir, { recursive: true, force: true }); }
});

test('MC-E04 (joined). partial truth stays visible from context to packet to case: book-only startup, a capped options census, absent Greeks and a paid access refusal are the correct limitations; a demonstrated quiet interval is a valid zero; observations available never masquerade as a complete interval', async () => {
  const dir = tmp(); const paths = []; const raw = H.policyWith({ providers: ['DERIBIT', 'CRYPTOQUANT', 'KRAKEN_SPOT'] }); raw.resources.optionsAdmittedPerCase = 2;
  const owner = createResearchOwner({ policy: loadPolicy(raw), subjects: btcOnly(), env: {}, clock: () => T0, researchRoot: dir, log: () => {}, fetchImpl: async (url) => { const u = new URL(url); paths.push(u.host + u.pathname); if (u.host === 'api.kraken.com') return json(u.pathname.endsWith('AssetPairs') ? H.KRAKEN_ASSET_PAIRS : H.krakenTicker('XXBTZUSD')); if (u.pathname.endsWith('get_instruments')) return json(DERIBIT_FOUR); if (u.pathname.endsWith('get_book_summary_by_currency')) return json(deribitFourSummaries()); if (u.pathname.endsWith('/ticker')) return json(deribitTicker(u.searchParams.get('instrument_name'), { greeks: false })); return json({}, 404); } });
  try {
    await owner.clients.KRAKEN_SPOT.loadCatalog(); const market = owner.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market; const tick = await owner.clients.KRAKEN_SPOT.ticker({ markets: [market] });
    const opt = await owner.acquire('OPTIONS_TERM_SKEW', 'BTC'); const net = await owner.acquire('NETWORK_ACTIVITY', 'BTC'); assert.ok(!paths.some((p) => p.includes('cryptoquant')), 'no key => no paid dispatch'); assert.ok(net.usage.reasons.CREDENTIAL_MISSING >= 1);
    const quietCov = makeCoverage({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subjectId: subjectId(market.subject), family: 'SPOT_FLOW', kind: 'TRADE', state: 'SUBSCRIBED', reasonCodes: [], startTs: T0 - 600_000, endTs: null, observationCount: 0, droppedCount: 0, epochId: null, sequenceStart: null, sequenceEnd: null }); const observations = [...tick.observations, ...opt.observations]; const coverage = [...tick.coverage, ...opt.coverage, ...net.coverage, quietCov];
    const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations, coverage, captureRef: REF, referenceNotionals: [100], limits: { ...RESOURCE_DEFAULTS, optionsAdmittedPerCase: 2 } }).context; assert.equal(contextError(ctx), null);
    const w = ctx.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 60_000).value.current; assert.equal(w.support.state, 'COMPLETE_NO_TRADES', 'a demonstrated quiet minute is a valid zero'); assert.equal(w.count, 0);
    const hour = ctx.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'window_ohlcv' && c.value.current.windowMs === 3_600_000).value.current; assert.equal(hour.support.state, 'PARTIAL'); assert.equal(hour.count, null); assert.equal(hour.observedCount, 0, 'observed rows are always labelled observed, never an interval total');
    const surf = ctx.families.OPTIONS_TERM_SKEW.components[0].value; assert.equal(surf.admitted, 2); assert.equal(surf.support.state, 'ADMITTED_SUBSET'); assert.ok(surf.support.reasons.includes('ADMISSION_CAP')); assert.equal(surf.term[0].greeksMissing, 2); assert.ok(surf.term[0].support.reasons.includes('GREEKS_MISSING')); assert.equal(surf.term[0].ratioScope, 'ADMITTED_SUBSET');
    assert.equal(ctx.families.NETWORK_ACTIVITY.state, 'NOT_SUPPORTED', 'a paid access refusal is a NOT_SUPPORTED family with ACCESS_BLOCKED coverage'); assert.ok(ctx.families.NETWORK_ACTIVITY.coverage.some((c) => c.state === 'ACCESS_BLOCKED'));
    const b = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: T0, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(b.ok, true, JSON.stringify(b.detail ?? null)); const ev = (k) => b.packet.evidence.find((e) => e.kind === k);
    assert.equal(ev('MARKET_NETWORK_CONTEXT').state, 'UNAVAILABLE'); assert.equal(ev('MARKET_OPTIONS_CONTEXT').value.support.state, 'ADMITTED_SUBSET'); assert.equal(ev('MARKET_CHART_WINDOW').value.support.state, 'COMPLETE_NO_TRADES'); assert.equal(ev('MARKET_CHART_WINDOW').value.fields.count, 0);
    const rt = createCaseRuntime({ policy: loadPolicy(raw), env: {}, clock: () => T0, fetchImpl: async () => { throw new Error('never'); } }); const r = await rt.runCase({ packet: b.packet, marketContext: ctx, out: path.join(dir, 'case') }).done; await rt.close();
    assert.equal(r.status, 'BUDGET_BLOCKED'); const sealedPacket = JSON.parse(readFileSync(path.join(dir, 'case', 'packets.jsonl'), 'utf8').trim()); assert.equal(sealedPacket.evidence.find((e) => e.kind === 'MARKET_NETWORK_CONTEXT').state, 'UNAVAILABLE', 'the limitation survives into the sealed case'); assert.equal(sealedPacket.evidence.find((e) => e.kind === 'MARKET_OPTIONS_CONTEXT').value.support.state, 'ADMITTED_SUBSET');
  } finally { await owner.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

test('MC-E05 (joined). a recording failure while a model request is active: the service stops healthy admission, cancels and drains ownership, preserves the source prefix / error and accounts the in-flight charge conservatively; no late healthy case', async () => {
  const root = tmp(); const p = H.policyWith({ providers: ['KRAKEN_SPOT'], model: MODEL }); p.resources.segmentBytes = 4000; p.resources.runBytes = 50_000;
  let release = null; let dispatched; const gate = new Promise((r) => { dispatched = r; });
  const fetchImpl = async (url, init) => { const u = new URL(url); if (u.host === 'api.kraken.com') return json(H.KRAKEN_ASSET_PAIRS); if (u.pathname.endsWith('count_tokens')) return json({ input_tokens: 1000 }); dispatched(); return new Promise((res) => { release = () => res(json(message({}))); }); };
  const svc = createResearchService({ policy: loadPolicy(p), subjects: btcOnly(), env: { ANTHROPIC_API_KEY: KEY }, researchRoot: root, mode: 'INTEGRATED', clock: () => Date.now(), fetchImpl, httpPort: null, log: () => {} });
  try {
    await svc.start(); const base = Date.now() - 100_000; for (let i = 0; i < 4; i += 1) svc.owner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 0.5, price: 100, eventTs: base + i * 1000, receivedTs: base + i * 1000, tradeId: 90_000 + i, ordType: 'market', snapshot: false }); await H.waitFor(() => svc.owner.status().counters.tapeTrades >= 4, { timeoutMs: 4000 });
    assert.equal(svc.enqueueCase({ canonicalCoin: 'BTC' }).accepted, true); await gate; const entry = svc.status().cases.recent[0]; assert.equal(entry.status, 'RUNNING'); const prefixId = entry.prefixId;
    for (let i = 0; i < 40; i += 1) svc.owner.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 0.5, price: 100, eventTs: base + 10_000 + i * 1000, receivedTs: base + 10_000 + i * 1000, tradeId: 91_000 + i, ordType: 'market', snapshot: false });
    await H.waitFor(() => svc.status().state === 'RECORDING_FAILED', { timeoutMs: 6000 }); assert.deepEqual(svc.enqueueCase({ canonicalCoin: 'BTC' }), { accepted: false, reason: 'RECORDING_FAILED' });
    await H.waitFor(() => svc.runtime.status().closed === true, { timeoutMs: 15_000 }); release?.(); await H.waitFor(() => svc.status().cases.recent[0].status !== 'RUNNING', { timeoutMs: 6000 });
    const done = svc.status().cases.recent[0]; assert.notEqual(done.status, 'COMPLETED', `no healthy late case (${done.status})`); assert.equal(done.prefixId, prefixId, 'the case keeps the prefix it started from');
    const j = openBudgetJournal({ dir: svc.paths.budgetDir }); const rows = j.reservations(); j.close(); assert.equal(rows.length, 1); assert.equal(rows[0].state, 'UNRESOLVED', 'the in-flight model charge is kept as unresolved spend');
    const stopped = await svc.stop(); assert.equal(stopped.state, 'RECORDING_FAILED'); assert.equal(stopped.error.code, 'RESOURCE_LIMIT_EXCEEDED'); assert.equal(svc.status().recording.failure.error.code, 'RESOURCE_LIMIT_EXCEEDED');
  } finally { release?.(); await svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('MC-E06 (joined). restart / reopen: with every process cache gone the capture, context, packets and case reopen and verify (prefix, ids, values, coverage, report); a replay with the recorded model output makes zero network calls; reusing the account journal never resets accounting', async () => {
  const dir = tmp(); const clk = H.clockAt(T0); let world = null; let caseDir; let packet; let scripted;
  try {
    world = await populatedCase({ dir, clk, script: (pk) => async () => { scripted = firstReport(pk, []); return { json: message(scripted) }; } }); assert.equal(world.r.status, 'COMPLETED', JSON.stringify(world.r.manifest.diagnostic)); packet = world.packet; caseDir = path.join(dir, 'case');
    await world.rt.close(); await world.owner.stop({ seal: true }); await world.fx.close(); const totalsBefore = { cq: world.owner.journal.totals('CRYPTOQUANT').calls.month, kr: world.owner.journal.totals('KRAKEN_SPOT').calls.month }; assert.ok(totalsBefore.cq >= 1 && totalsBefore.kr >= 1); world = null;
  } catch (err) { if (world) { await world.rt.close(); await world.owner.stop({ seal: false }); await world.fx.close(); } throw err; }
  // fresh process state: only the files remain
  const v = verifyCase(caseDir, { resolveInputs: true }); assert.equal(v.ok, true, v.reasons.join('; ')); assert.equal(v.inputResolution[0].resolution === 'COMPLETE' || v.inputResolution[0].resolution === 'RETAINED_WINDOW_ONLY', true); assert.equal(v.inputResolution[0].recomputed, v.inputs[0].contextId);
  const cm = JSON.parse(readFileSync(path.join(caseDir, 'case.json'), 'utf8')); const seg = cm.inputs[0].captureRef.segments[0]; const cap = readCapture(seg.dir); assert.equal(cap.bundle.manifest.bundleId, seg.bundleId); assert.ok(cap.observations.some((o) => o.kind === 'OPTION_TICK') && cap.observations.some((o) => o.kind === 'TRADE') && cap.coverage.some((c) => c.state === 'SUBSCRIBED'));
  const sealedPacket = JSON.parse(readFileSync(path.join(caseDir, 'packets.jsonl'), 'utf8').trim()); assert.equal(sealedPacket.packetId, packet.packetId); assert.equal(validateEvidencePacketV2(sealedPacket).valid, true); assert.match(readFileSync(path.join(caseDir, 'report.md'), 'utf8'), /Close 100\.2 on kraken/);
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'], model: MODEL })); const rt = createCaseRuntime({ policy, env: { ANTHROPIC_API_KEY: KEY }, clock: clk, fetchImpl: async () => { throw new Error('network is off'); }, recordedResponse: { text: JSON.stringify(scripted), recordedTs: 1, actualModel: 'recorded-fixture' }, budgetDir: path.join(dir, 'budget-replay') });
  const replay = await rt.runCase({ packet: sealedPacket, out: path.join(dir, 'replay') }).done; await rt.close(); assert.equal(replay.status, 'COMPLETED', JSON.stringify(replay.manifest.diagnostic)); assert.deepEqual(replay.attempts.map((a) => a.path), ['RECORDED_RESPONSE']); assert.equal(replay.analyses[0].thesis.text, scripted.thesis.text); assert.equal(verifyCase(path.join(dir, 'replay')).ok, true);
  const again = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: clk, researchRoot: dir, fetchImpl: cryptoquantFetch() }); try { assert.equal(again.journal.totals('CRYPTOQUANT').calls.month, totalsBeforeOf(dir).cq, 'paid accounting survives the restart'); assert.equal(again.journal.totals('KRAKEN_SPOT').calls.month, totalsBeforeOf(dir).kr, 'public accounting survives the restart'); } finally { await again.stop({ seal: false }); }
  rmSync(dir, { recursive: true, force: true });
});
// the journal totals as recorded on disk (read back through the journal itself, no process state)
function totalsBeforeOf(dir) { const lines = readFileSync(path.join(dir, 'accounting', 'quota.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); const c = (id) => lines.filter((r) => r.type === 'RESERVE' && r.providerId === id).map((r) => r.reservationId).filter((rid) => !lines.some((r) => r.type === 'RELEASE' && r.reservationId === rid)).length; return { cq: c('CRYPTOQUANT'), kr: c('KRAKEN_SPOT') }; }

test('MC-E07 (joined). existing integrations are preserved: a populated Social-led packet from the detached projection, a market-led packet without Social, the real deep-market adapter (valid input, unsupported partial aggregates withheld), and byte-identical protected v1 contracts / config', async () => {
  const { obs, cov } = populated(); const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: obs, coverage: cov, captureRef: REF, referenceNotionals: [100] }).context;
  const market = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: T0, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(market.ok, true); assert.deepEqual(market.packet.researchContext.entrances, ['MARKET_LED']); assert.equal(market.packet.researchContext.dossierRef, null); assert.ok(market.packet.evidence.every((e) => e.sense !== 'RUMINT'));
  const composite = { compositeId: 'r2cv2-' + 'b'.repeat(40), version: 'social-research-composite-2', knownAtTs: T0 - 5000, sourceContext: { total: 1, selected: 1, truncated: false, profiles: [{ socialAuthorId: 'did:plc:known', provider: 'BLUESKY_OFFICIAL', representativeSourceEventId: 'r2so-1', history: 'AVAILABLE', profileId: 'r2sp-1', retentionState: 'DURABLE_PROFILE_ALLOWED', coverage: { resourceHistoryState: 'NO_PRIOR_PROFILE_EVICTION', firstObservedKnownAtTs: T0 - 40 * 86_400_000, observationCount: 12, observationCountIncludingDropped: 15, currentProfileFirstObservedKnownAtTs: T0 - 40 * 86_400_000, currentProfileObservationCountIncludingDropped: 15, distinctResearchEpisodeCount: 2, coverageLimitations: [] }, origin: { factualIndependenceStatus: 'SINGLE_ORIGIN' }, factualOutcome: { associatedClaimCount: 0, associationAvailable: false } }] } };
  const rec = { dossierId: 'r2rd-' + 'c'.repeat(40), derivedKnownAtTs: T0 - 4000, researchState: 'INVESTIGATE', entrances: ['PARTICIPATION_LED'], packetStatus: 'VALID', packetId: 'sep-abc', episodeId: 'ep-1', episodeIndex: 0, episodeState: 'ACTIVE_RESEARCH' };
  const social = buildResearchEvidenceV2({ marketContext: ctx, socialProjection: buildSocialProjection({ canonicalCoin: 'BTC', asOfTs: T0, composite, dossierRecord: rec }), asOfTs: T0, trigger: { kind: 'RESEARCH_DOSSIER', sourceEventId: rec.dossierId, observedTs: null } }); assert.equal(social.ok, true); assert.ok(social.packet.researchContext.dossierRef); assert.ok(social.packet.evidence.some((e) => e.kind === 'SOCIAL_SOURCE_HISTORY'));
  // the real deep-market adapter over a live integrated owner: a valid window with the book; the trade aggregate withheld without positive coverage
  const dir = tmp(); const o = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), mode: 'INTEGRATED', researchRoot: dir, log: () => {}, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS) });
  try {
    await o.start({ families: [] }); const base = Math.floor(Date.now() / 60_000) * 60_000 - 120_000; for (let i = 0; i < 5; i += 1) o.observer.onTrade({ coin: 'BTC', symbol: 'BTC/USD', side: 'buy', qty: 0.5, price: 100, eventTs: base + 1000 + i * 5000, receivedTs: base + 1100 + i * 5000, tradeId: 95_000 + i, ordType: 'market', snapshot: false });
    o.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: base + 59_000, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2]], asks: [[100.5, 2]] }) }); await H.waitFor(() => o.status().counters.tapeTrades >= 5 && o.status().counters.tapeBooks >= 1, { timeoutMs: 4000 });
    const ex = explainDeepMarket(o, 'BTC', base + 61_000); assert.equal(ex.ok, true, JSON.stringify(ex)); assert.equal(ex.input.book.source, 'kraken-ws-v2-accepted-book'); assert.equal(ex.input.trades, null); assert.equal(ex.coverage.withheld, 'TRADE_COVERAGE_UNKNOWN'); assert.ok(ex.coverage.observedCount >= 5, 'observations are available, the aggregate is not claimed');
    assert.equal(createDeepMarketSource(o)('DOGE', { knownAtTs: base + 61_000 }), null); assert.equal(explainDeepMarket(o, 'BTC', base + 30_000).reason, 'WINDOW_EMPTY', 'a minute with nothing accepted is honestly unsupported');
  } finally { await o.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
  // protected contracts and config: byte-identical to the committed baseline
  for (const f of ['evidence/contract.js', 'socrates/contract.js', 'cobra.config.json']) { const head = execFileSync('git', ['show', `HEAD:${f}`], { cwd: REPO }); assert.equal(sha256Hex(readFileSync(path.join(REPO, f))), sha256Hex(head), `${f} unchanged`); }
  assert.equal(sha256Hex(readFileSync(path.join(REPO, 'cobra.config.json'))), '68c16400fb0d776ce304cd97ae40ee742e32f2838d1b57f52bdefb0dd9c9c79a');
});
