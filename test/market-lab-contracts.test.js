// MARKET LAB — the shared contracts, resource policy, code identity, bounded state and the immutable store (A05, A06,
// A08, A10, A11, A12): strict JSON, closed vocabularies with positional diagnostics, canonical observation identity,
// clock law at the boundary, policy defaults that authorize nothing, source-closure identity, bounded hot state under a
// small injected cap, JSONL law (multibyte chunk split, exact / over limits, early exit, corruption), sealed bundles that
// refuse mutation, and import isolation (importing pure / provider modules performs no I/O).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, canonicalJson, canonicalDigest, subjectId, subjectError, makeObservation, observationError, observationIdentity, quality, emptyProvenance, makeCoverage, coverageRecordError, payloadError, exactKeys, FAMILIES, PAYLOAD_KINDS, PROVIDER_IDS, FAMILY_REGISTRY, familyMetricIds, MarketLabError, EXIT_CODES } from '../market-lab/contracts.js';
import { validatePolicy, loadPolicy, samplePolicy, sampleSubjects, subjectsError, credentialPresence, paidCallAuthorized, policyDigest, CASE_DEFAULTS, RESOURCE_DEFAULTS, ALLOWED_MAX_AGE_MS } from '../market-lab/policy.js';
import { codeIdentity, sourceClosure, identityLaw, codeIdentityError } from '../market-lab/identity.js';
import { createHotState, createIntakeQueue } from '../market-lab/hot-state.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile, writeTextFile, readJsonlStrict, consumeJsonl, publishManifest, openBundle, readMemberJsonl, manifestError, BUNDLE_LAYOUTS, quotaState, directoryBytes } from '../market-lab/store.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2026-09-08T12:00:00Z');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'mlab-'));
const marketSubject = { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: 'XXBT', venue: 'kraken', nativeSymbol: 'BTC/USD', base: 'BTC', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };
const tradeObs = (over = {}) => makeObservation({ provider: 'KRAKEN_SPOT', endpointId: 'rest-trades', subject: marketSubject, kind: 'TRADE', sequence: 1, epochId: null, sourceRevision: null, sourceKey: '1', sourceEventTs: T0 - 1000, publishedTs: null, periodStartTs: null, periodEndTs: null, receivedTs: T0, knownAtTs: over.receivedTs ?? T0, quality: quality('KNOWN', { methodologyId: 'kraken-trades-v1', originalUnit: 'USD' }), provenance: { ...emptyProvenance(), mappingId: 'm' }, payload: { price: 100, qty: 1, quoteNotional: 100, takerSide: 'BUY', sideConvention: 'TAKER_NATIVE', nativeTradeId: '1', orderType: null }, ...over });

test('A05/A06. strict JSON refuses duplicate keys, prototype hazards, unsafe integers, invalid UTF-8, depth and trailing garbage; canonical JSON is key-sorted and byte-stable; closed vocabularies are frozen and cross-referenced', () => {
  assert.equal(parseStrictJson('{"a":1,"a":2}').ok, false); assert.equal(parseStrictJson('{"__proto__":{"x":1}}').ok, false); assert.equal(parseStrictJson('{"constructor":1}').ok, false);
  assert.equal(parseStrictJson('12345678901234567890').ok, false, 'unsafe integers are refused, not rounded'); assert.equal(parseStrictJson('{"a":1} x').ok, false); assert.equal(parseStrictJson(Buffer.from([0xff, 0xfe, 0x7b])).ok, false);
  assert.equal(parseStrictJson('['.repeat(200) + ']'.repeat(200)).ok, false, 'depth bounded'); assert.deepEqual(parseStrictJson('{"b":[1,2],"a":"é"}').value, { b: [1, 2], a: 'é' });
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}'); assert.equal(canonicalDigest({ a: 1 }), canonicalDigest({ a: 1 })); assert.notEqual(canonicalDigest({ a: 1 }), canonicalDigest({ a: 2 }));
  assert.equal(FAMILIES.length, 17); assert.equal(PROVIDER_IDS.length, 16); assert.ok(PAYLOAD_KINDS.length >= 20); assert.ok(Object.isFrozen(FAMILY_REGISTRY));
  for (const f of FAMILIES) { assert.ok(FAMILY_REGISTRY[f], f); for (const k of FAMILY_REGISTRY[f].kinds) assert.ok(PAYLOAD_KINDS.includes(k), `${f}: ${k}`); for (const p of FAMILY_REGISTRY[f].providers) assert.ok(PROVIDER_IDS.includes(p), `${f}: ${p}`); assert.ok(familyMetricIds(f).length >= 1); assert.equal(ALLOWED_MAX_AGE_MS[f]?.length > 0, true, `${f} has max-age policy values`); }
  assert.match(exactKeys({ a: 1, zz: 2 }, ['a', 'b'], 'x') ?? '', /position 2 of 2/, 'positional diagnostics never echo the hostile key');
});

test('A05/A06. observations: closed keys, subject law per kind, quality law (KNOWN needs a value, MISSING needs null, PROVISIONAL only for uncommitted candles, CLOCK_CONFLICT needs its reason), knownAt >= receipt, identity is semantic and recomputable; coverage records: OBSERVED needs a count', () => {
  const o = tradeObs(); assert.equal(observationError(o), null); assert.equal(o.observationId, observationIdentity(o)); assert.match(o.observationId, /^mo-[0-9a-f]{64}$/); assert.ok(Object.isFrozen(o));
  assert.notEqual(observationIdentity({ ...o, payload: { ...o.payload, price: 101 } }), o.observationId); assert.equal(observationIdentity({ ...o, observationId: 'mo-forged' }), o.observationId, 'the id is never part of its own basis');
  assert.match(observationError({ ...o, observationId: 'mo-' + '0'.repeat(64) }) ?? '', /identity|observationId/);
  assert.match(observationError({ ...o, extra: 1 }) ?? '', /undeclared|position/); assert.match(observationError({ ...o, knownAtTs: T0 - 1 }) ?? '', /knownAt|receipt/i);
  assert.throws(() => tradeObs({ quality: quality('MISSING', {}), payload: { ...tradeObs().payload } }), MarketLabError, 'MISSING with a value is refused');
  assert.throws(() => tradeObs({ quality: quality('PROVISIONAL', {}) }), MarketLabError, 'PROVISIONAL is only for uncommitted candles');
  assert.throws(() => tradeObs({ kind: 'CANDLE' }), MarketLabError, 'a kind with the wrong payload is refused');
  assert.throws(() => tradeObs({ subject: { subjectKind: 'ASSET', canonicalCoin: 'BTC', providerAssetId: 'x' } }), MarketLabError, 'a TRADE needs a MARKET subject');
  assert.match(subjectError({ subjectKind: 'MARKET', canonicalCoin: 'btc' }) ?? '', /./); assert.equal(subjectError(marketSubject), null); assert.match(subjectId(marketSubject), /^ms-[0-9a-f]{32}$/);
  assert.match(payloadError('TRADE', { price: 1 }) ?? '', /missing|position/);
  const cov = makeCoverage({ provider: 'KRAKEN_SPOT', endpointId: 'rest-trades', subjectId: subjectId(marketSubject), family: 'SPOT_FLOW', kind: 'TRADE', state: 'OBSERVED', reasonCodes: [], startTs: T0 - 1000, endTs: T0, observationCount: 3, droppedCount: 0, epochId: null, sequenceStart: null, sequenceEnd: null });
  assert.equal(coverageRecordError(cov), null); assert.throws(() => makeCoverage({ ...cov, observationCount: 0 }), MarketLabError, 'OBSERVED with zero observations is a contradiction'); assert.throws(() => makeCoverage({ ...cov, state: 'NOPE' }), MarketLabError);
});

test('POLICY. the sample policy authorizes NOTHING (every provider disabled, model disabled, every cap zero, env NAMES only); the validator refuses value-shaped credentials, unknown keys, over-ceiling case limits, a metered smoke without a dollar ceiling and an included-quota smoke without a plan record; paid authorization follows the three billing states', () => {
  const p = samplePolicy(); assert.equal(validatePolicy(p).ok, true); assert.ok(Object.values(p.providers).every((x) => x.enabled === false)); assert.equal(p.model.enabled, false); assert.equal(p.model.maxEstimatedUsdPerCase, 0); assert.equal(p.model.credentialEnv, 'ANTHROPIC_API_KEY');
  for (const [id, x] of Object.entries(p.providers)) assert.ok(x.credentialEnv === null || /^[A-Z_][A-Z0-9_]*$/.test(x.credentialEnv), `${id}: env NAME only`);
  const c = structuredClone(p); c.providers.COINGLASS.credentialEnv = 'cg_live_abc123'; assert.equal(validatePolicy(c).ok, false);
  const u = structuredClone(p); u.unknown = 1; assert.equal(validatePolicy(u).ok, false); const cc = structuredClone(p); cc.cases.maxModelAttempts = 3; assert.equal(validatePolicy(cc).ok, false, 'two attempts is a ceiling');
  const m = structuredClone(p); m.providers.COINGLASS.enabled = true; m.providers.COINGLASS.plan.billing = 'METERED'; m.providers.COINGLASS.smoke = { authorized: true, maxCalls: 1, maxEstimatedUsd: null }; assert.equal(validatePolicy(m).ok, false, 'a metered smoke needs an explicit dollar ceiling');
  const q = structuredClone(p); q.providers.COINGECKO.enabled = true; q.providers.COINGECKO.plan.billing = 'INCLUDED_QUOTA'; q.providers.COINGECKO.smoke = { authorized: true, maxCalls: 1, maxEstimatedUsd: 0 }; assert.equal(validatePolicy(q).ok, false, 'an included-quota smoke needs the plan record');
  q.providers.COINGECKO.plan = { ...q.providers.COINGECKO.plan, includedCallsPerMonth: 10_000, remainingCalls: 9_000, incrementalUsdPerCall: 0, attestation: 'owner plan page', verifiedDate: '2026-09-08' }; assert.equal(validatePolicy(q).ok, true); assert.equal(paidCallAuthorized(q, 'COINGECKO'), true);
  const z = structuredClone(q); z.providers.COINGECKO.plan.remainingCalls = 0; assert.equal(paidCallAuthorized(z, 'COINGECKO'), false, 'exhausted quota: no call');
  const mm = structuredClone(p); mm.providers.COINGLASS.enabled = true; mm.providers.COINGLASS.plan.billing = 'METERED'; assert.equal(paidCallAuthorized(mm, 'COINGLASS'), false, 'metered without an authorized smoke ceiling: no call'); mm.providers.COINGLASS.smoke = { authorized: true, maxCalls: 2, maxEstimatedUsd: 0.5 }; assert.equal(paidCallAuthorized(mm, 'COINGLASS'), true);
  const uk = structuredClone(p); uk.providers.CRYPTOQUANT.enabled = true; assert.equal(paidCallAuthorized(uk, 'CRYPTOQUANT'), false, 'UNKNOWN billing never authorizes'); assert.equal(paidCallAuthorized(structuredClone(p), 'KRAKEN_SPOT'), false, 'a disabled provider makes no call even when free');
  const pres = credentialPresence(p, { COINGLASS_API_KEY: 'x' }); assert.equal(pres.COINGLASS.access, 'CONFIGURED'); assert.equal(pres.CRYPTOQUANT.access, 'CREDENTIAL_MISSING'); assert.equal(pres.KRAKEN_SPOT.access, 'PUBLIC'); assert.equal(pres.COINGECKO.access, 'PUBLIC'); assert.ok(!JSON.stringify(pres).includes('"x"'), 'presence never carries the value');
  assert.equal(typeof policyDigest(p), 'string'); assert.notEqual(policyDigest(p), policyDigest(q)); assert.throws(() => loadPolicy({}), MarketLabError);
  const s = sampleSubjects(); assert.equal(subjectsError(s), null); const dup = structuredClone(s); dup.subjects.push(dup.subjects[0]); assert.match(subjectsError(dup) ?? '', /./); const amb = structuredClone(s); amb.subjects[0].krakenSpot = 'BTC USD'; assert.match(subjectsError(amb) ?? '', /./);
  assert.deepEqual(Object.keys(CASE_DEFAULTS).sort(), ['attemptTimeoutMs', 'caseTimeoutMs', 'maxConcurrentModelRequests', 'maxDataRequestsPerCase', 'maxFollowupRounds', 'maxModelAttempts', 'maxModelInputBytes', 'maxModelOutputBytes', 'maxOutputTokens', 'maxPendingCases', 'requestCacheSize']); assert.equal(CASE_DEFAULTS.maxModelInputBytes, 262_144); assert.equal(CASE_DEFAULTS.maxOutputTokens, 8_192);
});

test('B07. code identity covers every effective local module reachable from the two research roots (market-lab, evidence, socrates, survey/catalog, tape/book) and states the git law; a changed byte changes the identity; a missing root is an honest NO_GIT_CHECKOUT', () => {
  const closure = sourceClosure(); for (const f of ['market-lab/owner.js', 'market-lab/service.js', 'market-lab/deep-market-adapter.js', 'socrates/runtime.js', 'evidence/contract-v2.js', 'evidence/social-projection.js', 'survey/catalog.js', 'tape/book.js', 'rumor2/social-research-market.js', 'rumor2/social-research-dossier.js']) assert.ok(closure.includes(f), `${f} is in the effective closure`);
  assert.ok(!closure.some((f) => f.startsWith('test/') || f.startsWith('research/') || f.startsWith('ledger/') || f.startsWith('cost/')), 'the closure never reaches the offline pipeline or trading modules');
  const SHA = 'a'.repeat(40); const id = codeIdentity({ git: { revParse: () => SHA, status: () => false } }); assert.equal(codeIdentityError(id), null); assert.equal(id.law, 'PRODUCED_BY_COMMITTED_SOURCE'); assert.equal(id.gitCommit, SHA); assert.match(id.sourceTreeSha256, /^[0-9a-f]{64}$/); assert.equal(id.sourceFiles, closure.length);
  assert.equal(identityLaw({ gitCommit: SHA, gitSourceDirty: true }), 'PRODUCED_BY_UNCOMMITTED_SOURCE'); assert.equal(identityLaw({ gitCommit: SHA, gitSourceDirty: null }), 'SOURCE_CLEANLINESS_UNKNOWN'); assert.equal(identityLaw({ gitCommit: null, gitSourceDirty: null }), 'NO_GIT_CHECKOUT');
  const root = tmp(); for (const f of closure) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), readFileSync(path.join(REPO, f))); } for (const r of ['bin/market-research.js', 'bin/socrates-research.js']) { mkdirSync(path.join(root, 'bin'), { recursive: true }); writeFileSync(path.join(root, r), readFileSync(path.join(REPO, r))); }
  const same = codeIdentity({ root, git: { revParse: () => SHA, status: () => false } }); assert.equal(same.sourceTreeSha256, id.sourceTreeSha256, 'identity depends on the bytes, not the checkout path');
  writeFileSync(path.join(root, 'market-lab/recipes.js'), readFileSync(path.join(REPO, 'market-lab/recipes.js'), 'utf8') + '\n// changed\n'); assert.notEqual(codeIdentity({ root, git: { revParse: () => SHA, status: () => false } }).sourceTreeSha256, id.sourceTreeSha256);
  rmSync(path.join(root, 'market-lab/recipes.js')); assert.equal(codeIdentity({ root, git: { revParse: () => null, status: () => null } }).law, 'NO_GIT_CHECKOUT'); rmSync(root, { recursive: true, force: true });
});

test('A08. bounded hot state under a small injected cap: per-symbol trade cap with eviction metadata, hot-set cap evicts the least recently touched subject deterministically, byte pressure sheds oldest trades, book sampling is rate-limited with minute endpoints, closed bars are immutable, a burst of many symbols stays within the cap; the intake queue drops honestly', () => {
  const limits = { ...RESOURCE_DEFAULTS, hotSubjects: 3, tradesPerHotSymbol: 5, hotStateBytes: 1 << 20, bookSampleMinIntervalMs: 500, bookSamplesTwoMinutes: 4, bookMinuteEndpoints: 3, barsPerInterval: 3 };
  const hot = createHotState({ limits }); const subj = (coin) => ({ ...marketSubject, canonicalCoin: coin, base: coin, nativeSymbol: `${coin}/USD` });
  const sid = (coin) => subjectId(subj(coin));
  for (let i = 0; i < 8; i += 1) hot.addTrade(sid('BTC'), subj('BTC'), tradeObs({ sourceKey: String(i), sequence: i + 1, sourceEventTs: T0 - 8000 + i * 1000, receivedTs: T0 + i }));
  const v = hot.view(sid('BTC')); assert.equal(v.trades.length, 5); assert.equal(v.evictedTradesUntilTs, T0 - 8000 + 2 * 1000, 'the eviction watermark names the last evicted event clock'); assert.equal(v.dropped.trades, 3);
  assert.deepEqual(hot.addTrade(sid('BTC'), subj('BTC'), tradeObs({ sourceKey: '7', sequence: 99, receivedTs: T0 + 50 })), { admitted: false, reason: 'DUPLICATE' });
  for (const coin of ['ETH', 'SOL']) hot.addTrade(sid(coin), subj(coin), tradeObs({ subject: subj(coin), receivedTs: T0 + 100 }));
  hot.addTrade(sid('XRP'), subj('XRP'), tradeObs({ subject: subj('XRP'), receivedTs: T0 + 200 })); assert.equal(hot.has(sid('BTC')), false, 'the least recently touched subject (BTC) leaves the hot set'); assert.equal(hot.status().subjects, 3); assert.equal(hot.status().evictions.subjects, 1);
  const log = hot.status().admissionLog ?? hot.admissionLog?.() ?? []; assert.ok(Array.isArray(log));
  // byte pressure: many trades across subjects exceed the 4 KiB ceiling -> oldest trades shed, never a crash
  const tiny = createHotState({ limits: { ...limits, tradesPerHotSymbol: 1000, hotStateBytes: 4096 } }); for (let i = 0; i < 40; i += 1) tiny.addTrade(sid('ETH'), subj('ETH'), tradeObs({ subject: subj('ETH'), sourceKey: `e${i}`, sequence: i, receivedTs: T0 + 300 + i })); assert.ok(tiny.status().totalBytes <= 4096 + 2048, 'byte pressure sheds instead of growing'); assert.ok(tiny.view(sid('ETH')).trades.length < 40); assert.ok(tiny.view(sid('ETH')).dropped.trades > 0);
  // book samples: rate limit + rolling cap + minute endpoints
  const sample = (ts) => ({ receivedTs: ts, bids: [[99, 1]], asks: [[101, 1]], synced: true, checksumOk: true, epochId: 'e', observationId: `mo-${ts}` });
  assert.equal(hot.addBookSample(sid('ETH'), subj('ETH'), sample(T0 + 1000)).admitted, true); assert.equal(hot.addBookSample(sid('ETH'), subj('ETH'), sample(T0 + 1200)).admitted, false); assert.equal(hot.shouldSampleBook(sid('ETH'), T0 + 1499), false); assert.equal(hot.shouldSampleBook(sid('ETH'), T0 + 1500), true);
  for (let m = 1; m <= 5; m += 1) { hot.addBookSample(sid('ETH'), subj('ETH'), sample(T0 + m * 60_000 - 100)); hot.addBookSample(sid('ETH'), subj('ETH'), sample(T0 + m * 60_000 + 100)); }
  const ve = hot.view(sid('ETH')); assert.ok(ve.bookSamples.length <= limits.bookSamplesTwoMinutes); assert.ok(ve.minuteEndpoints.length <= limits.bookMinuteEndpoints); assert.ok(ve.minuteEndpoints.every((e) => e.sample.receivedTs <= e.minuteTs), 'an endpoint is the latest sample at or before the minute boundary');
  // bars: closed bars immutable, provisional replaced, per-interval cap
  const bar = (start, closed) => makeObservation({ provider: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', subject: subj('ETH'), kind: 'CANDLE', sequence: 1, epochId: null, sourceRevision: null, sourceKey: `b${start}`, sourceEventTs: closed ? start + 60_000 : null, publishedTs: null, periodStartTs: start, periodEndTs: start + 60_000, receivedTs: closed ? start + 60_000 : start + 100, knownAtTs: closed ? start + 60_000 : start + 100, quality: quality(closed ? 'KNOWN' : 'PROVISIONAL', { reasonCodes: closed ? [] : ['UNCOMMITTED_BAR'], coverageStartTs: start, coverageEndTs: closed ? start + 60_000 : start + 100, completeness: closed ? 1 : null }), provenance: emptyProvenance(), payload: { intervalMs: 60_000, open: 1, high: 2, low: 1, close: 1.5, volumeBase: 1, volumeQuote: 1, tradeCount: 1, vwap: 1.5, closed, provisional: !closed } });
  assert.equal(hot.addBar(sid('ETH'), subj('ETH'), bar(T0, true)).admitted, true); assert.deepEqual(hot.addBar(sid('ETH'), subj('ETH'), bar(T0, true)), { admitted: false, reason: 'CLOSED_BAR_IMMUTABLE' });
  assert.equal(hot.addBar(sid('ETH'), subj('ETH'), bar(T0 + 60_000, false)).admitted, true); assert.equal(hot.addBar(sid('ETH'), subj('ETH'), bar(T0 + 60_000, true)).replacedProvisional, true);
  for (let k = 2; k < 6; k += 1) hot.addBar(sid('ETH'), subj('ETH'), bar(T0 + k * 60_000, true)); assert.equal(hot.view(sid('ETH')).bars[60_000].length, 3); assert.equal(hot.view(sid('ETH')).evictedBarsUntilTs, T0 + 3 * 60_000);
  // broad burst: 200 symbols never exceed the hot-set cap
  for (let i = 0; i < 200; i += 1) hot.addTrade(sid(`C${i}`), subj(`C${i}`), tradeObs({ subject: subj(`C${i}`), receivedTs: T0 + 10_000 + i })); assert.equal(hot.status().subjects, 3);
  const q = createIntakeQueue({ limits: { ...RESOURCE_DEFAULTS, intakeQueueItems: 3, intakeQueueBytes: 1 << 20 } }); assert.equal(q.push({ a: 1 }), true); assert.equal(q.push({ a: 2 }), true); assert.equal(q.push({ a: 3 }), true); assert.equal(q.push({ a: 4 }), false); assert.equal(q.takeDropped(), 1); assert.equal(q.drain(10).length, 3); assert.equal(q.takeDropped(), 0);
});

test('A10. JSONL law: a multibyte character split across the 1 MiB chunk boundary decodes correctly; a line exactly at the byte bound (including LF) passes and one byte over fails; an empty line, an unterminated final line, invalid UTF-8 and a duplicate-key line are fatal; early iterator exit releases the descriptor; the writer refuses over-bound lines and files', () => {
  const dir = tmp(); const file = path.join(dir, 'x.jsonl');
  const filler = 'a'.repeat((1 << 20) - 12); writeFileSync(file, `{"k":"${filler}é"}\n{"z":"€"}\n`); // the two-byte é straddles the first 1 MiB read
  const rows = [...readJsonlStrict(file, { lineBytes: 2 << 20 })].map((r) => r.record); assert.equal(rows[0].k.endsWith('é'), true); assert.equal(rows[1].z, '€');
  const exact = '{"k":"' + 'b'.repeat(20) + '"}'; writeFileSync(file, `${exact}\n`); const bound = Buffer.byteLength(exact) + 1;
  assert.equal([...readJsonlStrict(file, { lineBytes: bound })].length, 1); assert.throws(() => [...readJsonlStrict(file, { lineBytes: bound - 1 })], /exceeds/);
  writeFileSync(file, '{"a":1}\n\n{"b":2}\n'); assert.throws(() => [...readJsonlStrict(file, { lineBytes: 1024 })], /empty line 2/);
  writeFileSync(file, '{"a":1}\n{"b":2}'); assert.throws(() => [...readJsonlStrict(file, { lineBytes: 1024 })], /unterminated/);
  writeFileSync(file, Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc3]), Buffer.from('"}\n')])); assert.throws(() => [...readJsonlStrict(file, { lineBytes: 1024 })], /UTF-8/);
  writeFileSync(file, '{"a":1,"a":2}\n'); assert.throws(() => [...readJsonlStrict(file, { lineBytes: 1024 })], /line 1/);
  writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n'); const it = readJsonlStrict(file, { lineBytes: 1024 }); assert.equal(it.next().value.record.a, 1); it.return(); assert.equal(it.next().done, true, 'early exit is final and closes the descriptor');
  assert.throws(() => consumeJsonl(file, { lineBytes: 1024, integrity: { bytes: 1, sha256: '0'.repeat(64), lines: 3 } }), /disagrees/);
  const res = reserveOutputDir(prepareOutputTarget(path.join(dir, 'out'))); const w = jsonlWriter(res, 'observations.jsonl', { lineBytes: 32, fileBytes: 30 });
  w.append({ a: 1 }); assert.throws(() => w.append({ big: 'x'.repeat(40) }), /exceeds 32/); w.append({ b: 2 }); w.append({ c: 3 }); assert.throws(() => w.append({ d: 4 }), /exceed 30/, 'the file bound counts every accepted byte');
  const d = w.close(); assert.equal(d.lines, 3); assert.equal(d.name, 'observations.jsonl'); assert.throws(() => w.close(), /twice/);
  rmSync(dir, { recursive: true, force: true });
});

test('A11/A09. sealed bundles: outputs are never overwritten and never overlap an input; the manifest is written last; reopening recomputes every member (bytes / sha / lines) and refuses a missing member, an extra file, a mutated byte with a correct-looking manifest, a manifest whose id disagrees with its content, and a clock-only mutation; identical inputs give identical bytes across directory names', () => {
  const dir = tmp(); const input = path.join(dir, 'in'); mkdirSync(input);
  assert.throws(() => prepareOutputTarget(path.join(input, 'sub'), { inputPaths: [input] }), /overlap/, 'an output inside an input is refused'); assert.throws(() => prepareOutputTarget(dir, { inputPaths: [input] }), /exists|overlap/, 'an output that contains an input is refused'); assert.throws(() => prepareOutputTarget(input), /exists/); assert.throws(() => prepareOutputTarget(path.join(dir, 'nope', 'deeper')), /parent/);
  const build = (name) => { const res = reserveOutputDir(prepareOutputTarget(path.join(dir, name), { inputPaths: [input] })); const w = jsonlWriter(res, 'packets.jsonl', { lineBytes: 4096 }); w.append({ p: 1 }); const pD = w.close(); const mk = (n) => { const x = jsonlWriter(res, n, { lineBytes: 4096 }); return x.close(); }; const members = [writeJsonFile(res, 'case.json', { caseId: 'c', status: 'COMPLETED' }), pD, mk('analyses.jsonl'), mk('requests.jsonl'), mk('results.jsonl'), mk('usage.jsonl'), writeTextFile(res, 'report.md', '# r\n'), writeJsonFile(res, 'code-identity.json', { sourceTreeSha256: 'x' })]; return { res, pub: publishManifest(res, { kind: 'CASE', createdTs: T0, summary: { caseId: 'c' }, identity: { sourceTreeSha256: 'x', law: 'L', gitCommit: null }, members }) }; };
  const a = build('a'); const b = build('b'); assert.equal(a.pub.manifestSha256, b.pub.manifestSha256, 'the same inputs seal to the same bytes whatever the directory name'); assert.equal(readFileSync(path.join(dir, 'a', 'manifest.json'), 'utf8'), readFileSync(path.join(dir, 'b', 'manifest.json'), 'utf8'));
  assert.ok(readdirSync(path.join(dir, 'a')).includes('manifest.json')); assert.equal(openBundle(path.join(dir, 'a'), 'CASE').manifest.bundleId, a.pub.manifest.bundleId);
  assert.throws(() => reserveOutputDir(prepareOutputTarget(path.join(dir, 'a'))), /exists/, 'outputs are never overwritten');
  const m = JSON.parse(readFileSync(path.join(dir, 'b', 'manifest.json'), 'utf8'));
  // 1. mutate a member byte, keep the manifest => refused; 2. mutate the member AND its descriptor but not bundleId => refused; 3. clock-only mutation => refused (id disagrees); 4. extra file => refused; 5. missing member => refused
  writeFileSync(path.join(dir, 'b', 'report.md'), '# R\n'); assert.throws(() => openBundle(path.join(dir, 'b'), 'CASE'), /disagree/);
  const m2 = structuredClone(m); m2.members.find((x) => x.name === 'report.md').sha256 = a.pub.manifest.members.find((x) => x.name === 'report.md').sha256.replace(/^./, (c) => (c === '0' ? '1' : '0')); writeFileSync(path.join(dir, 'b', 'manifest.json'), JSON.stringify(m2)); assert.throws(() => openBundle(path.join(dir, 'b'), 'CASE'), /bundleId|disagree/);
  writeFileSync(path.join(dir, 'b', 'report.md'), '# r\n'); const m3 = structuredClone(m); m3.createdTs = T0 + 1; writeFileSync(path.join(dir, 'b', 'manifest.json'), JSON.stringify(m3)); assert.throws(() => openBundle(path.join(dir, 'b'), 'CASE'), /bundleId/, 'a wrong-clock mutation with valid member hashes still rejects');
  writeFileSync(path.join(dir, 'b', 'manifest.json'), JSON.stringify(m)); assert.equal(openBundle(path.join(dir, 'b'), 'CASE').manifest.createdTs, T0);
  writeFileSync(path.join(dir, 'b', 'extra.txt'), 'x'); assert.throws(() => openBundle(path.join(dir, 'b'), 'CASE'), /exactly/); rmSync(path.join(dir, 'b', 'extra.txt')); rmSync(path.join(dir, 'b', 'usage.jsonl')); assert.throws(() => openBundle(path.join(dir, 'b'), 'CASE'), /exactly/);
  assert.match(manifestError({ ...m, bundleKind: 'CAPTURE' }, 'CASE') ?? '', /kind/); assert.deepEqual(Object.keys(BUNDLE_LAYOUTS).sort(), ['CAPTURE', 'CASE', 'CONTEXT', 'EVALUATION', 'PACKET']);
  const q = quotaState(directoryBytes(dir), 1 << 30); assert.equal(q.exhausted, false); assert.ok(q.usedBytes > 0); assert.equal(quotaState(10, 10).exhausted, true);
  // the incomplete reservation (no manifest) is not a bundle; cleanup removes ONLY this run's directory
  const res = reserveOutputDir(prepareOutputTarget(path.join(dir, 'c'))); writeJsonFile(res, 'case.json', { a: 1 }); assert.throws(() => openBundle(path.join(dir, 'c'), 'CASE'), /seal|exactly/); res.cleanup(); assert.equal(existsSync(path.join(dir, 'c')), false); assert.equal(existsSync(path.join(dir, 'a')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('A12. importing the pure, provider, evidence and Socrates modules performs no write, network or timer side effect (checked in a child process with the primitives disarmed; module loading itself reads source files); the exit-code vocabulary is closed', () => {
  const modules = ['market-lab/contracts.js', 'market-lab/time.js', 'market-lab/policy.js', 'market-lab/registry.js', 'market-lab/transport.js', 'market-lab/store.js', 'market-lab/hot-state.js', 'market-lab/recipes.js', 'market-lab/context.js', 'market-lab/coverage.js', 'market-lab/readiness.js', 'market-lab/owner.js', 'market-lab/service.js', 'market-lab/subject-catalog.js', 'market-lab/deep-market-adapter.js', 'market-lab/commands.js', ...readdirSync(path.join(REPO, 'market-lab/providers')).map((f) => `market-lab/providers/${f}`), 'evidence/contract-v2.js', 'evidence/research-builder.js', 'evidence/social-projection.js', 'socrates/contract-v2.js', 'socrates/prompt.js', 'socrates/client.js', 'socrates/broker.js', 'socrates/budget.js', 'socrates/runtime.js', 'socrates/report.js', 'socrates/corpus.js', 'socrates/evaluate.js', 'socrates/commands.js', 'bin/market-research.js', 'bin/socrates-research.js'];
  const script = `
    const fs = require('node:fs'); const net = require('node:net'); const http = require('node:http'); const https = require('node:https');
    const trip = (name) => () => { throw new Error('SIDE_EFFECT ' + name); };
    for (const k of ['writeFileSync', 'mkdirSync', 'appendFileSync', 'createWriteStream', 'writeSync', 'renameSync', 'unlinkSync']) fs[k] = trip('fs.' + k);
    net.connect = trip('net.connect'); net.createConnection = trip('net.createConnection'); http.request = trip('http.request'); https.request = trip('https.request'); http.createServer = trip('http.createServer');
    globalThis.fetch = trip('fetch'); globalThis.WebSocket = trip('WebSocket'); globalThis.setInterval = trip('setInterval');
    const mods = JSON.parse(process.argv[1]);
    (async () => { for (const m of mods) { try { await import(${JSON.stringify(`file://${REPO}/`)} + m); } catch (err) { console.log('FAIL ' + m + ' ' + err.message); process.exit(1); } } console.log('OK ' + mods.length); })();`;
  const out = execFileSync(process.execPath, ['-e', script, JSON.stringify(modules)], { cwd: REPO, encoding: 'utf8' });
  assert.equal(out.trim(), `OK ${modules.length}`);
  assert.deepEqual(EXIT_CODES, { OK: 0, INVALID_REQUEST: 2, INVALID_INPUT: 3, RESOURCE_LIMIT_EXCEEDED: 4, EXECUTION_FAILURE: 5 });
});
