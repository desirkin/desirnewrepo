// MARKET-EDGE-KRAKEN-1 §11.4 — the DARK-FAMILY EXCLUSION fence and the static authority proof. The two new senses may
// live in market-lab's closed contracts / store / coverage / retention; they MUST be absent from Judge intake and
// features, Socrates broker requests, decision evidence, readiness, thresholds, execution, the Watch and the paper /
// live adapters. Positive tests prove the absence; static scans prove no order verb and no forbidden import exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { FAMILIES, DARK_FAMILIES, ALL_FAMILIES, FAMILY_REGISTRY, DARK_FAMILY_REGISTRY, PAYLOAD_KINDS, DARK_PAYLOAD_KINDS, KIND_SUBJECTS, DARK_FAMILY_LAW, makeCoverage, subjectId } from '../market-lab/contracts.js';
import { FAMILIES as SOCRATES_FAMILIES } from '../socrates/contract-v2.js';
import { METRIC_MAP, metricMapping, DARK_FAMILIES_EXCLUDED, buildResearchEvidenceV2 } from '../evidence/research-builder.js';
import { METRIC_REGISTRY, createBroker } from '../socrates/broker.js';
import { COMPONENT_FAMILY, contextError, buildContext } from '../market-lab/context.js';
import { buildCoverageMatrix, ROUTE_PLAN } from '../market-lab/coverage.js';
import { liveReadinessManifest, providerReadiness } from '../market-lab/readiness.js';
import { ALLOWED_MAX_AGE_MS, loadPolicy, samplePolicy } from '../market-lab/policy.js';
import { ENDPOINTS, endpointsOf, providersForFamily } from '../market-lab/registry.js';
import { familyOfKind } from '../market-lab/retention.js';
import { BUNDLE_LAYOUTS } from '../market-lab/store.js';
import { RECIPES } from '../market-lab/recipes.js';
import { EDGE_RECIPES } from '../market-lab/edge-recipes.js';
import { planRequest } from '../market-lab/transport.js';
import * as H from './helpers/market-lab.js';
import { SEALED_REF } from './helpers/market-closeout.js';
import { sampleSubjects } from '../market-lab/policy.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tracked = execSync("git ls-files '*.js' '*.mjs'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
const code = (f) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const imports = (f) => [...code(f).matchAll(/(?:^|\n)\s*(?:import\s[^;]*?from\s*|import\s*\(\s*|export\s[^;]*?from\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
const resolveRel = (f, spec) => (spec.startsWith('.') ? path.normalize(path.join(path.dirname(f), spec)).replace(/\\/g, '/') : spec);
export const NEW_MODULES = Object.freeze(['market-lab/providers/kraken-charts.js', 'market-lab/providers/kraken-l3-auth.js', 'market-lab/providers/kraken-l3.js', 'market-lab/l3-book.js', 'market-lab/edge-recipes.js', 'market-lab/edge-evaluation.js', 'market-lab/edge-eval-records.js', 'market-lab/edge-eval-store.js', 'market-lab/edge-capture.js']);
const ORDER_VERBS = /\b(add_order|amend_order|edit_order|cancel_order|cancel_all|batch_add|batch_cancel|AddOrder|CancelOrder|AmendOrder|EditOrder|Withdraw|WithdrawFunds|placeOrder|submitOrder|createOrder|cancelOrder|closePosition)\b/;

test('F-01. the dark families are OUTSIDE the decision vocabulary: not in FAMILIES, FAMILY_REGISTRY, METRIC_MAP, the broker metric registry, the Socrates v2 contract, the context component binding, ALLOWED_MAX_AGE_MS, the coverage route plan or any decision recipe; their kinds are closed dark kinds bound to dark families only; the law is declared', () => {
  assert.deepEqual([...DARK_FAMILIES], ['DERIVATIVES_PRESSURE', 'L3_MICROSTRUCTURE']); assert.deepEqual([...DARK_PAYLOAD_KINDS], ['DERIVATIVE_ANALYTIC_BUCKET', 'L3_BOOK_SNAPSHOT', 'L3_ORDER_EVENT', 'L3_BOOK_COVERAGE']);
  assert.equal(FAMILIES.length, 17); assert.equal(ALL_FAMILIES.length, 19); assert.deepEqual(DARK_FAMILIES_EXCLUDED, [...DARK_FAMILIES]);
  for (const f of DARK_FAMILIES) {
    assert.ok(!FAMILIES.includes(f), `${f} in FAMILIES`); assert.equal(FAMILY_REGISTRY[f], undefined, `${f} in FAMILY_REGISTRY`); assert.equal(METRIC_MAP[f], undefined, `${f} in METRIC_MAP`); assert.equal(METRIC_REGISTRY[f], undefined, `${f} in the broker registry`);
    assert.ok(!SOCRATES_FAMILIES.includes(f), `${f} in the Socrates v2 contract`); assert.ok(!Object.values(COMPONENT_FAMILY).includes(f), `${f} bound to a context component`); assert.equal(ALLOWED_MAX_AGE_MS[f], undefined); assert.equal(ROUTE_PLAN[f], undefined);
    assert.ok(!Object.values(RECIPES).some((r) => r.family === f), `${f} in a decision recipe`); assert.ok(DARK_FAMILY_REGISTRY[f]);
    for (const id of Object.keys(DARK_FAMILY_REGISTRY[f].metrics)) { assert.equal(metricMapping(f, id), null); assert.equal(EDGE_RECIPES[id].family, f); assert.equal(RECIPES[id], undefined, `${id} is not a decision recipe`); }
  }
  for (const k of DARK_PAYLOAD_KINDS) { assert.ok(PAYLOAD_KINDS.includes(k)); assert.ok(DARK_FAMILIES.includes(familyOfKind(k)), k); assert.ok(KIND_SUBJECTS[k]); for (const f of FAMILIES) assert.ok(!FAMILY_REGISTRY[f].kinds.includes(k), `${f} consumes ${k}`); for (const m of Object.values(METRIC_MAP).flatMap((x) => Object.values(x))) assert.ok(!(m.inputKinds ?? []).includes(k) && !(m.native ?? []).includes(k), `a decision metric consumes ${k}`); }
  for (const f of FAMILIES) assert.ok(!FAMILY_REGISTRY[f].kinds.some((k) => DARK_PAYLOAD_KINDS.includes(k)));
  assert.match(DARK_FAMILY_LAW, /no trading, Judge or Socrates authority/);
  // coverage records may name a dark family, but a dark kind never lands in a decision family (and the reverse)
  const subject = { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: null, venue: 'kraken', nativeSymbol: 'BTC/USD', base: 'BTC', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };
  const body = { provider: 'KRAKEN_SPOT', endpointId: 'ws-l3', subjectId: subjectId(subject), family: 'L3_MICROSTRUCTURE', kind: 'L3_BOOK_SNAPSHOT', state: 'OBSERVED', reasonCodes: [], startTs: H.T0, endTs: null, observationCount: 1, droppedCount: 0, epochId: null, sequenceStart: null, sequenceEnd: null };
  assert.ok(makeCoverage(body)); assert.throws(() => makeCoverage({ ...body, family: 'DISPLAYED_LIQUIDITY' }), /dark kind/); assert.throws(() => makeCoverage({ ...body, kind: 'BOOK_SNAPSHOT' }), /dark kind/); assert.throws(() => makeCoverage({ ...body, family: 'MARKET_EDGE' }), /identity/);
});

test('F-02. positive downstream absence: the Socrates broker refuses a dark-family request before any dispatch; the research builder refuses a dark detail request; a context naming a dark family fails validation and buildContext never emits one; the readiness manifest and the coverage matrix enumerate exactly the 17 decision families; the registry exposes the dark endpoints ONLY as dark', async () => {
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT', 'KRAKEN_DERIVATIVES'] })); const subjects = sampleSubjects();
  let dispatched = 0; const owner = { acquire: async () => { dispatched += 1; return { observations: [], coverage: [], results: [] }; }, markets: () => new Map(), subjectsOf: () => null, status: () => ({}), snapshotPrefix: () => null, clients: {} };
  const broker = createBroker({ owner, policy, clock: () => H.T0 });
  const caseSubject = { canonicalCoin: 'BTC', registeredRefs: [] };
  for (const family of DARK_FAMILIES) { const r = await broker.resolve({ requestKey: 'k1', requestKind: 'REFRESH', family, metricIds: ['oi_bucket_change'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null }, { analysisId: 'an-1', caseSubject, asOfTs: H.T0 }).catch((e) => ({ state: 'THROWN', message: String(e?.message) })); assert.ok(['POLICY_REJECTED', 'THROWN'].includes(r.state), family); assert.equal(dispatched, 0); assert.ok(/dark family/.test(String(r.reason ?? r.message ?? '')) || r.state === 'POLICY_REJECTED', `${family}: ${JSON.stringify(r).slice(0, 200)}`); }
  assert.equal(Object.keys(broker.metricRegistry).length, 17);
  const ctx = buildContext({ canonicalCoin: 'BTC', asOfTs: H.T0, observations: [], coverage: [], captureRef: SEALED_REF }).context;
  const refused = buildResearchEvidenceV2({ marketContext: ctx, socialProjection: null, asOfTs: H.T0, trigger: { kind: 'MARKET_RESEARCH', canonicalCoin: 'BTC' }, mode: 'LIVE_OBSERVATION', detailRequests: [{ family: 'DERIVATIVES_PRESSURE', metricId: 'oi_bucket_change' }] });
  assert.equal(refused.ok, false); assert.match(String(refused.detail), /unregistered family/);
  assert.deepEqual(Object.keys(ctx.families), [...FAMILIES]); assert.ok(!Object.keys(ctx.families).some((f) => DARK_FAMILIES.includes(f)));
  const hostile = structuredClone(ctx); hostile.families.L3_MICROSTRUCTURE = { state: 'OBSERVED', components: [], coverage: [] }; assert.match(contextError(hostile) ?? '', /undeclared family/);
  const rows = providerReadiness({ policy, env: {} }); const manifest = liveReadinessManifest({ rows, familyCoverage: {}, modelReadiness: null, generatedTs: H.T0 }); assert.deepEqual(Object.keys(manifest.families), [...FAMILIES]);
  const matrix = buildCoverageMatrix({ policy, subjects, env: {} }); assert.deepEqual(Object.keys(matrix.families), [...FAMILIES]); assert.equal(Object.keys(matrix.families).length, 17);
  const dark = ENDPOINTS.filter((e) => e.families.some((f) => DARK_FAMILIES.includes(f))); assert.deepEqual(dark.map((e) => `${e.providerId}/${e.endpointId}`).sort(), ['KRAKEN_DERIVATIVES/charts-analytics', 'KRAKEN_SPOT/rest-private-key-info', 'KRAKEN_SPOT/rest-private-ws-token', 'KRAKEN_SPOT/ws-l3']);
  for (const e of dark) { assert.equal(e.dark, true); assert.ok(e.families.every((f) => DARK_FAMILIES.includes(f)), 'a dark endpoint serves dark families only'); assert.equal(e.authEnv, null, 'no generic credential placement: the narrow helper signs'); }
  for (const e of ENDPOINTS.filter((e) => e.dark !== true)) assert.ok(!e.families.some((f) => DARK_FAMILIES.includes(f)));
  assert.deepEqual(providersForFamily('DERIVATIVES_PRESSURE'), ['KRAKEN_DERIVATIVES']); assert.deepEqual(providersForFamily('L3_MICROSTRUCTURE'), ['KRAKEN_SPOT']);
  // the public paths keep their identity: the same provider ids, one L2 stream endpoint, no replacement of ws-v2
  assert.ok(endpointsOf('KRAKEN_SPOT').some((e) => e.endpointId === 'ws-v2' && e.host === 'ws.kraken.com')); assert.equal(endpointsOf('KRAKEN_SPOT').filter((e) => e.method === 'WS').length, 2);
  // the sample policy ships every dark sense OFF and never carries a secret VALUE, only environment NAMES
  const sample = samplePolicy(); assert.equal(sample.providers.KRAKEN_DERIVATIVES.charts.enabled, false); assert.equal(sample.providers.KRAKEN_SPOT.l3.enabled, false); assert.match(sample.providers.KRAKEN_SPOT.l3.keyEnv, /^[A-Z][A-Z0-9_]*$/); assert.equal(sample.providers.KRAKEN_SPOT.plan.billing, 'FREE', 'a dark sense never changes the public billing class');
  const shipped = JSON.parse(read('market-lab/samples/policy.sample.json')); assert.deepEqual(shipped.providers.KRAKEN_SPOT.l3, sample.providers.KRAKEN_SPOT.l3); assert.deepEqual(shipped.providers.KRAKEN_DERIVATIVES.charts, sample.providers.KRAKEN_DERIVATIVES.charts);
  // the dark bundle layout is separate from every decision bundle
  assert.ok(BUNDLE_LAYOUTS.EDGE_CAPTURE); assert.ok(!('observations.jsonl' in BUNDLE_LAYOUTS.EDGE_CAPTURE)); assert.ok(!Object.keys(BUNDLE_LAYOUTS.CAPTURE).some((m) => /l3|analytics/.test(m)));
});

test('F-03. static authority proof: no new module names an order / amend / cancel / withdraw verb; new modules import only node: and market-lab; judge/, execution/, watch/, tape/, ledger/ and the paper / live adapters never import a new module or name a dark family / kind; the narrow signer is the only private signer in market-lab and it cannot reach an order path; sensitive private reads are redacted in the recorder and the docs check date is recorded', () => {
  for (const f of NEW_MODULES) { assert.ok(tracked.includes(f), `${f} tracked`); const c = code(f); assert.ok(!ORDER_VERBS.test(c), `${f} names an order verb`); assert.ok(!/execution\/|judge\/|watch\/|tape\/|ledger\/|cost\/|state\//.test(imports(f).join('\n')), `${f} imports an authority module`); for (const spec of imports(f)) { if (!spec.startsWith('.')) assert.match(spec, /^node:/, `${f} -> ${spec}`); else assert.match(resolveRel(f, spec), /^market-lab\//, `${f} -> ${spec} leaves market-lab`); } }
  const DARK_RE = /DERIVATIVES_PRESSURE|L3_MICROSTRUCTURE|DERIVATIVE_ANALYTIC_BUCKET|L3_BOOK_SNAPSHOT|L3_ORDER_EVENT|L3_BOOK_COVERAGE|kraken-l3|kraken-charts|edge-recipes|edge-evaluation|edge-capture|l3-book/;
  for (const f of tracked.filter((x) => /^(judge|execution|watch|tape|ledger|cost|state|gateway|governance|persistence|childhood|memory|rumint|rumor2|socrates|ui)\//.test(x) || x === 'fly.js' || x === 'index.js')) { assert.ok(!DARK_RE.test(code(f)), `${f} mentions a dark sense`); for (const spec of imports(f)) assert.ok(!NEW_MODULES.includes(resolveRel(f, spec)), `${f} imports ${spec}`); }
  for (const f of ['evidence/research-builder.js', 'evidence/contract-v2.js', 'socrates/broker.js', 'socrates/contract-v2.js', 'judge/intake.js', 'judge/features.js', 'judge/judge.js', 'judge/setups.js', 'judge/risk.js', 'execution/paper-adapter.js', 'execution/kraken-adapter.js', 'watch/watch.js']) { const c = code(f); assert.ok(!/DERIVATIVE_ANALYTIC_BUCKET|L3_BOOK_SNAPSHOT|L3_ORDER_EVENT|L3_BOOK_COVERAGE/.test(c), `${f} consumes a dark kind`); if (!/^(evidence\/research-builder|socrates\/broker)\.js$/.test(f)) assert.ok(!/DERIVATIVES_PRESSURE|L3_MICROSTRUCTURE|DARK_FAMILIES/.test(c), `${f} names a dark family`); }
  // the only two mentions downstream are the EXCLUSION fences themselves
  assert.ok(/DARK_FAMILIES\) if \(METRIC_MAP\[f\] !== undefined/.test(code('evidence/research-builder.js'))); assert.ok(/DARK_FAMILIES\.includes\(r\.family\)\) return 'dark family/.test(code('socrates/broker.js')));
  // one narrow signer: HMAC signing exists in market-lab ONLY inside the L3 auth helper, over exactly two documented read paths
  const signers = tracked.filter((f) => f.startsWith('market-lab/') && /createHmac/.test(code(f))); assert.deepEqual(signers, ['market-lab/providers/kraken-l3-auth.js']);
  const auth = code('market-lab/providers/kraken-l3-auth.js'); assert.ok(auth.includes("'/0/private/GetApiKeyInfo'") && auth.includes("'/0/private/GetWebSocketsToken'")); assert.equal((auth.match(/\/0\/private\//g) ?? []).length, 2, 'exactly two private paths'); assert.ok(!/execution\/kraken-adapter/.test(auth));
  for (const f of ['market-lab/providers/kraken-l3.js', 'market-lab/edge-capture.js', 'bin/market-research.js']) assert.ok(!/\/0\/private\//.test(code(f)), `${f} names a private path`);
  // sensitive endpoints: the plan marks them, the recorder never sees the body, API-Sign / API-Key / token headers are redacted
  const plan = planRequest({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-private-key-info', method: 'POST', body: 'nonce=1', headers: { 'API-Key': 'k', 'API-Sign': 's' } }); assert.equal(plan.sensitive, true); assert.equal(plan.body, 'nonce=1'); assert.equal(plan.headers['content-type'], 'application/x-www-form-urlencoded'); assert.ok(!plan.requestKey.includes('nonce'));
  assert.equal(planRequest({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', query: {} }).sensitive, false);
  for (const f of NEW_MODULES) assert.ok(/2026-09-10/.test(read(f)) || /edge-(recipes|evaluation|eval-records|eval-store)|l3-book/.test(f), `${f} records the docs check date`);
  assert.ok(read('doctrine/MARKET_EDGE_KRAKEN.md').includes('2026-09-10')); assert.ok(read('doctrine/MARKET_EDGE_KRAKEN.md').includes('IMPLEMENTED_DARK_NOT_EVALUATED')); for (const w of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12', 'W13']) assert.ok(new RegExp(`\\b${w}\\b`).test(read('doctrine/MARKET_EDGE_KRAKEN.md')), `doctrine names ${w}`);
  // no credential VALUE anywhere in the new files, fixtures or docs
  for (const f of [...NEW_MODULES, 'test/fixtures/kraken-l3-checksum-snapshot.json', 'doctrine/MARKET_EDGE_KRAKEN.md', 'market-lab/samples/policy.sample.json']) assert.ok(!/sk-ant|sk_live|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}|api[_-]?key['"]?\s*:\s*['"][A-Za-z0-9+/]{16,}/i.test(read(f)), `${f} carries a value-like secret`);
});
