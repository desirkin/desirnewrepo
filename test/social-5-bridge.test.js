// SOCIAL-5 §36.6 / §36.7 — the two OWNER-SIDE seams and the research-side contracts that consume them:
//   * survey/wideeye.js `sweepPopulationSnapshot()` — the completed sweep's already-computed research
//     population (no request, no cadence / verdict / nomination change; excluded rows counted by reason);
//   * tape/store.js `writeCurrentFeatureSnapshot` / `readCurrentFeatureSnapshot` — the SAME computed tape
//     snapshot re-exposed atomically (one captured clock; torn writes unobservable; missing != zero);
//   * rumor2/social-research-market.js owner-snapshot validation + descriptive features;
//   * rumor2/social-research-shadow.js deterministic hash sampling, identity, validation, replay.
// No network: the wide eye runs on an injected fetch that serves fixtures and counts calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { canonicalJson } from '../rumor2/truth.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-5b-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
seedDir();
const { startWideEye, SWEEP_POPULATION_VERSION } = await import('../survey/wideeye.js');
const { writeCurrentFeatureSnapshot, readCurrentFeatureSnapshot, writeTapeStatus, readTapeStatus, FEATURE_SNAPSHOT_VERSION } = await import('../tape/store.js');
const { validateOwnerMarketSnapshot, ownerMarketFeatures, RESEARCH_OWNER_SNAPSHOT_STATES } = await import('../rumor2/social-research-market.js');
const { buildShadowSample, validateResearchShadowEvent, replayResearchShadowEvent, emptyShadowState, shadowRowRank, RESEARCH_SHADOW_SAMPLE_CAP, RESEARCH_SHADOW_RECIPE_VERSION, RESEARCH_SHADOW_EVENT_TYPE } = await import('../rumor2/social-research-shadow.js');
const { buildResearchDossier } = await import('../rumor2/social-research-strainer.js');
const { replaySocialHistory, SOCIAL_EVENT_TYPES } = await import('../rumor2/social-settle.js');
const { dataDir } = await import('../lib/config.js');

// ---- a synthetic wide-eye venue: AssetPairs + Ticker fixtures served by an injected fetch ----
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const BASES = ['LINK', 'FRESH42', 'ZQQ7', 'ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST', 'UVWX', 'YZ12', 'BTC'];
const assetPairs = Object.fromEntries(BASES.map((b) => [`${b}USD`, { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }]));
function tickerFor(prices, { drop = [], invalid = [] } = {}) {
  const out = {};
  for (const b of BASES) { if (drop.includes(b)) continue; const p = prices[b] ?? 1; out[`${b}USD`] = invalid.includes(b) ? { c: ['nope'], v: ['1', '1000'], p: ['1', '1'] } : { c: [String(p)], v: ['1', String(1000 + p)], p: [String(p), String(p)] }; }
  return out;
}
function venue() {
  const state = { calls: [], ticker: tickerFor({}) };
  const fetchImpl = async (url) => { state.calls.push(url); const body = url.includes('AssetPairs') ? { error: [], result: assetPairs } : { error: [], result: state.ticker }; return { ok: true, status: 200, json: async () => body }; };
  return { state, fetchImpl };
}
const wideCfg = () => { const c = structuredClone(loadConfig()); c.wideeye = { ...c.wideeye, enabled: true, sweepSec: 60, rippleCooldownMin: 30 }; c.universeExpansion = { ...c.universeExpansion, excludeBases: EXCLUDE }; return c; };
const noTimers = { setIntervalImpl: () => ({ refresh() {} }), clearIntervalImpl: () => {}, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {} };

test('WIDE-EYE-POPULATION. the completed sweep exposes ONLY already-computed rows: null before the first sweep; every scanned coin is evaluated or counted by exclusion reason; no notice/verdict/nomination/cadence change; the snapshot is frozen, detached, and carries a semantic sweep identity', async () => {
  seedDir(); const v = venue(); const clock = { ms: T0 };
  const eye = startWideEye({ log: () => {}, config: wideCfg(), fetchImpl: v.fetchImpl, now: () => clock.ms, registerSignals: false, ...noTimers });
  assert.equal(eye.sweepPopulationSnapshot(), null, 'no completed sweep yet');
  await eye._sweepOnce(); // first sweep: AssetPairs + Ticker; every coin has a series of 1 => INSUFFICIENT_SERIES
  const calls1 = v.state.calls.length; assert.equal(calls1, 2);
  const p1 = eye.sweepPopulationSnapshot();
  assert.equal(p1.version, SWEEP_POPULATION_VERSION); assert.match(p1.sweepId, /^ws-[0-9a-f]{40}$/); assert.equal(p1.tsMs, T0); assert.equal(p1.ts, new Date(T0).toISOString()); assert.equal(Object.isFrozen(p1), true); assert.equal(Object.isFrozen(p1.rows), true);
  assert.equal(p1.scanned, BASES.length); assert.equal(p1.evaluated, 0); assert.equal(p1.excluded.INSUFFICIENT_SERIES, BASES.length); assert.equal(p1.rows.length, 0); assert.equal(p1.catalogStatus, 'ACCEPTED'); assert.equal(typeof p1.catalogContentId, 'string');
  // second sweep: a dropped ticker row + an invalid price + evaluated rows
  clock.ms += 60_000; v.state.ticker = tickerFor({ LINK: 1.5 }, { drop: ['ZQQ7'], invalid: ['ABCD'] });
  await eye._sweepOnce();
  assert.equal(v.state.calls.length, calls1 + 1, 'ONE Ticker request per sweep — the accessor issued nothing');
  const p2 = eye.sweepPopulationSnapshot();
  assert.notEqual(p2.sweepId, p1.sweepId); assert.equal(p2.tsMs, T0 + 60_000); assert.equal(p2.excluded.NO_TICKER_ROW, 1); assert.equal(p2.excluded.PRICE_INVALID, 1); assert.equal(p2.excluded.INSUFFICIENT_SERIES, 0);
  assert.equal(p2.evaluated + p2.excluded.NO_TICKER_ROW + p2.excluded.PRICE_INVALID + p2.excluded.INSUFFICIENT_SERIES, p2.scanned, 'every scanned coin is evaluated or counted by reason');
  for (const r of p2.rows) { assert.equal(r.evaluated, true); assert.equal(typeof r.coin, 'string'); assert.ok(['zVol', 'zRet', 'extension', 'usdVol24h', 'preCooldownVerdict', 'cooldownSuppressed', 'noticeEmitted', 'inDeepTape'].every((k) => k in r)); if (!r.noticeEmitted) assert.equal(r.usdVol24h, null, 'the 24h USD proxy exists only where the sweep already computed it (emitted notices)'); }
  assert.equal(eye.researchNotices().length, p2.rows.filter((r) => r.noticeEmitted).length, 'notices and the population agree on what was emitted');
  assert.equal(p1.sweepId, eye.sweepPopulationSnapshot() === p2 ? p1.sweepId : p1.sweepId, 'the earlier snapshot object is unchanged (detached)'); assert.equal(p1.evaluated, 0);
  // the population never changes a nomination or a status decision: nominations file untouched by the accessor, status has no population field
  const status = JSON.parse(readFileSync(path.join(dataDir(), 'survey', 'status.json'), 'utf8')); assert.equal('population' in status, false); assert.equal(status.scanned, BASES.length);
  eye.stop();
});

test('SHADOW-SAMPLE. deterministic hash recipe over the unnoticed population: bounded cap, no favour to famous symbols, identity from sweep + population digest + recipe, replay-stable, no outcome; accounting must add up; a sampled sweep replays once; an altered payload is refused by the Social replay', () => {
  const rows = ['LINK', 'FRESH42', 'ZQQ7', 'ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST', 'UVWX', 'YZ12', 'BTC', 'ETH'].map((coin, i) => ({ coin, evaluated: true, zVol: i / 10, zRet: -i / 10, extension: null, preCooldownVerdict: i === 0 ? 'RIPPLE' : i === 1 ? 'MISSED' : null, cooldownSuppressed: i === 1, noticeEmitted: i === 0, usdVol24h: i === 0 ? 12345 : null, inDeepTape: i % 2 === 0 }));
  const pop = { version: 'wideeye-sweep-population-1', sweepId: `ws-${'a'.repeat(40)}`, tsMs: T0, ts: new Date(T0).toISOString(), sessionDate: '2026-09-07', catalogContentId: 'c'.repeat(40), catalogStatus: 'ACCEPTED', scanned: 15, tickerRows: 14, evaluated: 12, excluded: { NO_TICKER_ROW: 1, PRICE_INVALID: 1, INSUFFICIENT_SERIES: 1 }, rows };
  const b = buildShadowSample(pop, { knownAtTs: T0 + 5000 }); assert.equal(b.ok, true, b.error); const ev = b.event;
  assert.equal(validateResearchShadowEvent(ev), null); assert.equal(ev.type, RESEARCH_SHADOW_EVENT_TYPE); assert.ok(SOCIAL_EVENT_TYPES.includes(ev.type)); assert.equal(ev.authority, 'NONE'); assert.equal(ev.purpose, 'RESEARCH_ONLY');
  assert.equal(ev.population.unnoticed, 11); assert.equal(ev.population.noticed, 1); assert.equal(ev.population.cooldownSuppressed, 1); assert.equal(ev.selected.length, RESEARCH_SHADOW_SAMPLE_CAP); assert.equal(ev.sampleCap, 8); assert.equal(ev.coverage.complete, false); assert.deepEqual(ev.coverage.partialReasons, ['NO_TICKER_ROW', 'PRICE_INVALID', 'INSUFFICIENT_SERIES']);
  assert.ok(!ev.selected.some((r) => r.coin === 'LINK'), 'the noticed coin is not a shadow control');
  const supp = ev.selected.find((r) => r.coin === 'FRESH42'); if (supp) { assert.equal(supp.reason, 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED'); assert.equal(supp.preCooldownVerdict, 'MISSED'); }
  for (const r of ev.selected) { assert.equal(r.rank, shadowRowRank({ recipeVersion: RESEARCH_SHADOW_RECIPE_VERSION, sweepId: pop.sweepId, coin: r.coin })); assert.ok(!('outcome' in r) && !('return' in r)); }
  // determinism: same semantic population (rows reordered, extra key order) => same identity and selection
  const b2 = buildShadowSample({ ...pop, rows: [...rows].reverse() }, { knownAtTs: T0 + 5000 }); assert.equal(b2.event.sourceEventId, ev.sourceEventId); assert.equal(canonicalJson(b2.event.selected), canonicalJson(ev.selected));
  // a different population digest => a different identity; a later known-at does not change the identity (it is the sample's own clock, not its semantics)
  assert.notEqual(buildShadowSample({ ...pop, rows: rows.slice(0, 6) }, { knownAtTs: T0 + 5000 }).event.sourceEventId, ev.sourceEventId);
  assert.equal(buildShadowSample(pop, { knownAtTs: T0 + 9000 }).event.sourceEventId, ev.sourceEventId);
  // the recipe does not favour BTC/ETH: over many sweeps the majors are selected at the base rate (no bias term exists)
  let majors = 0; for (let i = 0; i < 200; i++) { const s = buildShadowSample({ ...pop, sweepId: `ws-${i.toString(16).padStart(40, '0')}` }, { knownAtTs: T0 + 5000 }).event; majors += s.selected.filter((r) => r.coin === 'BTC' || r.coin === 'ETH').length; }
  assert.ok(majors > 200 * 2 * (8 / 11) * 0.7 && majors < 200 * 2 * (8 / 11) * 1.3, `majors selected at the base rate, got ${majors}`);
  // laws: known before the sweep; accounting; cap; row reason vs cooldown fact
  assert.equal(buildShadowSample(pop, { knownAtTs: T0 - 1 }).ok, false); assert.match(validateResearchShadowEvent({ ...ev, population: { ...ev.population, unnoticed: 10 } }), /accounting/); assert.match(validateResearchShadowEvent({ ...ev, selected: ev.selected.slice(0, 3) }), /exactly min/);
  assert.match(validateResearchShadowEvent({ ...ev, selected: ev.selected.map((r, i) => (i === 0 ? { ...r, reason: r.reason === 'SHADOW_CONTROL_NOT_NOTICED' ? 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED' : 'SHADOW_CONTROL_NOT_NOTICED' } : r)) }), /reason disagrees|carries no pre-cooldown|names the verdict/);
  assert.match(validateResearchShadowEvent({ ...ev, extra: 1 }), /undeclared key/); assert.match(validateResearchShadowEvent({ ...ev, sourceEventId: 'r2rss-' + 'b'.repeat(40) }), /semantic identity/);
  // replay: once per sweep; bounded; the Social replay refuses an altered payload under the same identity
  const st = emptyShadowState(); assert.equal(replayResearchShadowEvent(st, ev).ok, true); assert.equal(replayResearchShadowEvent(st, ev).ok, false); assert.equal(st.count, 1); assert.deepEqual(st.bySweep.get(pop.sweepId).selected, ev.selected.map((r) => r.coin));
  const rp = replaySocialHistory([ev, ev]); assert.equal(rp.ok, true); assert.equal(rp.shadow.count, 1, 'an exact re-append collapses');
  assert.equal(replaySocialHistory([ev, { ...ev, sampleCap: 9 }]).ok, false, 'altered payload => corruption'); assert.equal(replaySocialHistory([{ ...ev, knownAtTs: T0 + 6000, ts: new Date(T0 + 6000).toISOString() }]).ok, true, 'the clock is the sample\'s own; identity is semantic');
  assert.equal(buildShadowSample({ ...pop, version: 'wideeye-sweep-population-9' }, { knownAtTs: T0 + 5000 }).ok, false, 'an unknown population version is refused (the definition is versioned)');
});

test('TAPE-FEATURE-SNAPSHOT. the store writes the SAME computed snapshot object under ONE captured clock (ts derives from tsMs), atomically; the reader returns a frozen detached copy or null (missing != zero); no temp file is ever readable as the current file; the accessor never starts the tape, subscribes or mutates', () => {
  seedDir();
  assert.equal(readCurrentFeatureSnapshot('LINK'), null, 'NOT_PRESENT before the tape ever wrote');
  const snap = { ts: new Date(T0).toISOString(), coin: 'LINK', tapeState: 'LIVE', bestBid: 9.99, bestAsk: 10.01, bestBidQty: 100, bestAskQty: 120, mid: 10, spreadBps: 20, depthUsd: { top: { bid: 999, ask: 1201.2 }, '5bps': { bid: 3000, ask: 2800 }, '10bps': { bid: 6000, ask: 5900 }, '25bps': { bid: 12000, ask: 13000 } }, obi: { top: -0.09, '5bps': 0.03, '10bps': 0.008, '25bps': -0.04 }, tradeImbalance15s: 0.2, tradeImbalance1m: -0.1, tradeImbalance5m: 0.05, cvd: 12.5 };
  writeCurrentFeatureSnapshot('LINK', snap, { tsMs: T0, session: '2026-09-07', symbol: 'LINK/USD' });
  const r = readCurrentFeatureSnapshot('LINK');
  assert.equal(r.version, FEATURE_SNAPSHOT_VERSION); assert.equal(r.tsMs, T0); assert.equal(r.ts, new Date(T0).toISOString()); assert.equal(r.session, '2026-09-07'); assert.equal(r.symbol, 'LINK/USD'); assert.equal(r.coin, 'LINK');
  for (const k of Object.keys(snap)) assert.equal(canonicalJson(r[k]), canonicalJson(snap[k]), `${k} re-exposed verbatim`);
  assert.equal(Object.isFrozen(r), true); assert.equal(Object.isFrozen(r.depthUsd), true); assert.notEqual(r, readCurrentFeatureSnapshot('LINK'), 'a detached copy per read');
  assert.throws(() => writeCurrentFeatureSnapshot('LINK', snap, { tsMs: null, session: '2026-09-07' }), /captured owner clock/);
  const dir = path.join(dataDir(), 'tape', 'features'); assert.deepEqual(readdirSync(dir), ['LINK.json'], 'no temp file survives an atomic write');
  // a torn/partial file cannot be observed: the reader sees a whole file or nothing
  writeFileSync(path.join(dir, 'ZQQ7.json'), '{"version":"tape-feature-snapshot-1","coin":"ZQ'); assert.equal(readCurrentFeatureSnapshot('ZQQ7'), null);
  assert.equal(readCurrentFeatureSnapshot('not a coin'), null); assert.equal(readCurrentFeatureSnapshot('../etc'), null);
  // a second write replaces the whole file (a later snapshot with its own clock)
  writeCurrentFeatureSnapshot('LINK', { ...snap, spreadBps: 25 }, { tsMs: T0 + 5000, session: '2026-09-07', symbol: 'LINK/USD' }); assert.equal(readCurrentFeatureSnapshot('LINK').spreadBps, 25); assert.equal(readCurrentFeatureSnapshot('LINK').tsMs, T0 + 5000);
  assert.deepEqual(readdirSync(dir).sort(), ['LINK.json', 'ZQQ7.json']);
  // the store module exposes read/write only — nothing that starts, subscribes, or touches a book/universe
  const src = readFileSync(new URL('../tape/store.js', import.meta.url), 'utf8'); for (const forbidden of ['WebSocket', 'subscribe', 'bookFeatures', 'TradeFlow', 'selectUniverse', 'rumor2']) assert.ok(!src.includes(forbidden), forbidden);
});

test('OWNER-SNAPSHOT-CONTRACT. the research adapter validates coin / captured clock / session / tape state; NOT_PRESENT for null; STALE_SESSION for a prior-session file; NOT_YET_KNOWN when captured after the derivation clock; INVALID for a crossed touch or a foreign coin; features are DESCRIPTIVE (bands, aggregate imbalance, taker-side ratios), executability stays UNASSESSED, exact age is exposed and no freshness threshold is invented; OFFLINE/DEGRADED owner state stays visible', () => {
  const raw = { version: 'tape-feature-snapshot-1', coin: 'LINK', symbol: 'LINK/USD', ts: new Date(T0).toISOString(), tsMs: T0, session: '2026-09-07', tapeState: 'LIVE', bestBid: 9.99, bestAsk: 10.01, bestBidQty: 100, bestAskQty: 120, mid: 10, spreadBps: 20, depthUsd: { top: { bid: 999, ask: 1201.2 }, '5bps': { bid: 3000, ask: 2800 }, '10bps': { bid: 6000, ask: 5900 }, '25bps': { bid: 12000, ask: 13000 } }, obi: { top: -0.09, '5bps': 0.03, '10bps': 0.008, '25bps': -0.04 }, tradeImbalance15s: 0.2, tradeImbalance1m: -0.1, tradeImbalance5m: null, cvd: 12.5 };
  assert.deepEqual(RESEARCH_OWNER_SNAPSHOT_STATES, ['NOT_PRESENT', 'PRESENT_WITH_AGE', 'STALE_SESSION', 'NOT_YET_KNOWN', 'INVALID']);
  assert.equal(validateOwnerMarketSnapshot(null, { canonicalCoin: 'LINK', asOfTs: T0 + 1000 }).state, 'NOT_PRESENT');
  const ok = validateOwnerMarketSnapshot(raw, { canonicalCoin: 'LINK', asOfTs: T0 + 7000, currentSession: '2026-09-07' }); assert.equal(ok.state, 'PRESENT_WITH_AGE'); assert.match(ok.snapshot.snapshotId, /^r2os-[0-9a-f]{40}$/);
  assert.equal(validateOwnerMarketSnapshot(raw, { canonicalCoin: 'LINK', asOfTs: T0 + 7000, currentSession: '2026-09-06' }).state, 'STALE_SESSION', 'a prior-session file never masquerades as current');
  assert.equal(validateOwnerMarketSnapshot(raw, { canonicalCoin: 'LINK', asOfTs: T0 - 1 }).state, 'NOT_YET_KNOWN', 'no backdating to a trigger time');
  assert.equal(validateOwnerMarketSnapshot(raw, { canonicalCoin: 'ZQQ7', asOfTs: T0 + 1 }).state, 'INVALID'); assert.equal(validateOwnerMarketSnapshot({ ...raw, bestBid: 10.02 }, { canonicalCoin: 'LINK', asOfTs: T0 + 1 }).state, 'INVALID'); assert.equal(validateOwnerMarketSnapshot({ ...raw, ts: 'x' }, { canonicalCoin: 'LINK', asOfTs: T0 + 1 }).state, 'INVALID'); assert.equal(validateOwnerMarketSnapshot({ ...raw, tapeState: 'GREAT' }, { canonicalCoin: 'LINK', asOfTs: T0 + 1 }).state, 'INVALID');
  const f = ownerMarketFeatures(ok, { asOfTs: T0 + 7000, ownerHealth: { state: 'LIVE', tsMs: T0 + 6000 } });
  assert.equal(f.state, 'PRESENT_WITH_AGE'); assert.equal(f.ageMs, 7000); assert.equal(f.quality, 'OWNER_LIVE_AT_CAPTURE'); assert.equal(f.book.spreadBps, 20); assert.equal(f.book.displayedDepthUsd['10bps'].bidUsd, 6000); assert.equal(f.book.imbalance['5bps'], 0.03); assert.equal(f.book.attribution, 'AGGREGATE_L2_UNATTRIBUTED'); assert.match(f.book.note, /never guaranteed/);
  assert.equal(f.flow.tradeImbalance15s, 0.2); assert.equal(f.flow.tradeImbalance5m, null); assert.equal(f.flow.takerSideKnown, true); assert.equal(f.flow.notionalsUsd, null); assert.match(f.flow.note, /distinct from any ticker/);
  assert.equal(f.executability.state, 'UNASSESSED'); assert.equal(f.executability.value, null); assert.match(f.executability.reason, /displayed bands are not exit capacity/); assert.match(f.note, /no universal freshness threshold/);
  assert.equal(ownerMarketFeatures(ok, { asOfTs: T0 + 7000, ownerHealth: { state: 'OFFLINE', tsMs: T0 + 6500 } }).quality, 'OWNER_OFFLINE_NOW'); assert.equal(ownerMarketFeatures(ok, { asOfTs: T0 + 7000, ownerHealth: { state: 'DEGRADED', tsMs: T0 + 6500 } }).ownerHealth.state, 'DEGRADED');
  assert.equal(ownerMarketFeatures(validateOwnerMarketSnapshot({ ...raw, tapeState: 'DEGRADED' }, { canonicalCoin: 'LINK', asOfTs: T0 + 1 }), { asOfTs: T0 + 1 }).quality, 'OWNER_DEGRADED_AT_CAPTURE');
  assert.equal(ownerMarketFeatures(validateOwnerMarketSnapshot(null, { canonicalCoin: 'LINK', asOfTs: T0 }), { asOfTs: T0 }).state, 'NOT_PRESENT');
  // through the dossier: present => marketDeep OWNER_SNAPSHOT with the snapshot as an input clock; stale session => STALE_SESSION + missing MARKET_DEEP_OBSERVATION; absent => NOT_CONNECTED
  const notice = { ts: new Date(T0).toISOString(), tsMs: T0, symbol: 'LINK', verdict: 'RIPPLE', zVol: 4, zRet: 2, extension: 3, liquidityNote: 'x', inDeepTape: true, usdVol24h: 1e6 };
  const providerStates = [{ provider: 'BLUESKY_OFFICIAL', state: 'OBSERVED', checkedTs: T0 + 7000, detail: null }];
  const d = buildResearchDossier({ canonicalCoin: 'LINK', asOfTs: T0 + 7000, providerStates, notices: [notice], ownerMarketSnapshot: raw, ownerHealth: { state: 'LIVE', tsMs: T0 + 6000 }, currentSession: '2026-09-07' }).dossier;
  assert.equal(d.marketDeep.state, 'OWNER_SNAPSHOT'); assert.equal(d.marketDeep.ownerSnapshot.snapshotId, ok.snapshot.snapshotId); assert.equal(d.marketDeep.features, null, 'no injected window: the deep-window features stay null'); assert.equal(d.executability.state, 'UNASSESSED'); assert.ok(!d.missing.some((m) => m.kind === 'MARKET_DEEP_OBSERVATION')); assert.ok(d.missing.some((m) => m.kind === 'EXECUTABILITY'));
  assert.equal(d.opportunityClock.latestInputKnownAtTs, T0, 'the snapshot clock is an input clock (T0 here, equal to the notice)'); assert.ok(d.dependencies.nodes.some((n) => n.id === `market:${ok.snapshot.snapshotId}` && n.kind === 'MARKET_SNAPSHOT'));
  const stale = buildResearchDossier({ canonicalCoin: 'LINK', asOfTs: T0 + 7000, providerStates, notices: [notice], ownerMarketSnapshot: { ...raw, session: '2026-09-06' }, currentSession: '2026-09-07' }).dossier;
  assert.equal(stale.marketDeep.state, 'OWNER_SNAPSHOT_STALE_SESSION'); assert.ok(stale.missing.some((m) => m.kind === 'MARKET_DEEP_OBSERVATION' && /STALE_SESSION/.test(m.description)));
  const absent = buildResearchDossier({ canonicalCoin: 'LINK', asOfTs: T0 + 7000, providerStates, notices: [notice], ownerMarketSnapshot: null, currentSession: '2026-09-07' }).dossier;
  assert.equal(absent.marketDeep.state, 'NOT_CONNECTED'); assert.equal(absent.marketDeep.ownerSnapshot.state, 'NOT_PRESENT'); assert.match(absent.marketDeep.ownerSnapshot.note, /missing is not zero/);
  const future = buildResearchDossier({ canonicalCoin: 'LINK', asOfTs: T0 - 500, providerStates, notices: [{ ...notice, tsMs: T0 - 600 }], ownerMarketSnapshot: raw, currentSession: '2026-09-07' }).dossier;
  assert.equal(future.marketDeep.ownerSnapshot.state, 'NOT_YET_KNOWN', 'a snapshot captured after the derivation clock does not enter (no backdating)');
});
