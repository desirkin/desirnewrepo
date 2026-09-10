// MARKET LAB / SOCRATES — the two research CLIs (§12) through their real entry points (runCli) with loopback fixtures.
//   strict flags (unknown / duplicate / valueless / positional / missing / malformed) refuse with exit 2 and the usage;
//   --help does no I/O; inspect never reaches the network and never prints a secret value; coverage is offline unless
//   --probe true; capture -> build -> packet -> run (recorded response, labelled) -> verify -> evaluate (scripted) is
//   one real pipeline over source-shaped fixtures; run with the model disabled makes ZERO model / network calls and
//   seals BUDGET_BLOCKED; a tampered case fails verify with exit 3; serve is driven through the documented service
//   factory and stops on SIGTERM. Nothing here spends money or reaches a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runCli as market, parseArgs as parseMarket, USAGE as MARKET_USAGE, COMMANDS as MARKET_COMMANDS } from '../bin/market-research.js';
import { runCli as socrates, parseArgs as parseSocrates, USAGE as SOCRATES_USAGE, COMMANDS as SOCRATES_COMMANDS } from '../bin/socrates-research.js';
import { EXIT_CODES } from '../market-lab/contracts.js';
import { openBundle, readMemberJson } from '../market-lab/store.js';
import * as H from './helpers/market-lab.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'mrcli-'));
const SECRET = 'sk-ant-THIS-VALUE-MUST-NEVER-PRINT';
const noNet = async (url) => { throw new Error(`network reached: ${url}`); };
const NoWs = class { constructor(url) { throw new Error(`websocket reached: ${url}`); } };
function io() { const out = []; const err = []; return { stdout: (s) => out.push(s), stderr: (s) => err.push(s), out: () => out.join(''), err: () => err.join(''), last: () => JSON.parse(out[out.length - 1]) }; }
function writeJson(dir, name, obj) { const f = path.join(dir, name); writeFileSync(f, `${JSON.stringify(obj, null, 1)}\n`); return f; }
const subjectsBtc = () => { const s = H.subjectsWith(); return { ...s, subjects: [s.subjects[0]], macroSeries: [], crossAsset: [] }; };
const utcNoMillis = (ms) => new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

// ---- source-shaped loopback fixtures (Kraken spot + Coinbase spot only: the smallest real pipeline) ---------------------
function krakenWs(conn) { conn.handlers.push((msg) => { if (msg.method !== 'subscribe') return; if (msg.params.channel === 'instrument') conn.send({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'BTC/USD', price_precision: 1, qty_precision: 8 }] } }); if (msg.params.channel === 'book') { conn.send({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 99.5, qty: 2 }, { price: 99.0, qty: 3 }], asks: [{ price: 100.5, qty: 2 }, { price: 101.0, qty: 3 }] }] }); let i = 0; const t = setInterval(() => { if (conn.closed) { clearInterval(t); return; } i += 1; conn.send({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: i % 2 ? 'buy' : 'sell', price: 100 + (i % 3) * 0.1, qty: 0.2, ord_type: 'market', trade_id: 1000 + i, timestamp: new Date(Date.now()).toISOString() }] }); }, 50); } }); }
function coinbaseWs(conn) { conn.handlers.push((msg) => { if (msg.type !== 'subscribe') return; conn.send({ type: 'snapshot', product_id: 'BTC-USD', bids: [['99.4', '2']], asks: [['100.6', '2']] }); let i = 0; const t = setInterval(() => { if (conn.closed) { clearInterval(t); return; } i += 1; conn.send({ type: 'match', product_id: 'BTC-USD', trade_id: 700 + i, sequence: i, side: 'sell', price: '100.2', size: '0.1', time: new Date(Date.now()).toISOString() }); }, 50); }); }
async function fixtures() {
  const now = () => Date.now();
  const http = await H.startHttpFixture({
    'GET /0/public/AssetPairs': { json: H.KRAKEN_ASSET_PAIRS }, 'GET /0/public/OHLC': (req) => ({ json: H.krakenOhlc(req.query.pair, { intervalMin: Number(req.query.interval), endTs: now(), count: 30 }) }), 'GET /0/public/Trades': (req) => ({ json: H.krakenTrades(req.query.pair, { endTs: now() }) }), 'GET /0/public/Ticker': (req) => ({ json: H.krakenTicker(req.query.pair.split(',')[0]) }),
    'GET /products': { json: H.COINBASE_PRODUCTS }, 'GET /products/BTC-USD/trades': () => ({ json: H.coinbaseTrades({ endTs: now() }) }), 'GET /products/BTC-USD/book': () => ({ json: H.coinbaseBook({ ts: now() }) }), 'GET /products/BTC-USD/candles': () => ({ json: [[Math.floor((now() - 120_000) / 60_000) * 60, 99, 101, 100, 100.5, 3]] }),
    '*': { status: 404, json: { error: 'no fixture' } },
  });
  const kws = await H.startWsFixture({ path: '/v2', onConnection: krakenWs }); const cws = await H.startWsFixture({ path: '/', onConnection: coinbaseWs });
  // the CLI takes a WebSocket implementation, never a url map: a narrow injected transport that rewrites the REGISTRY
  // host to the loopback fixture is the documented test seam (the production client still builds the real wss url)
  const WebSocketImpl = class extends globalThis.WebSocket { constructor(url, protocols) { const u = new URL(String(url)); super(/kraken/.test(u.host) ? kws.url : /coinbase/.test(u.host) ? cws.url : String(url), protocols); } };
  return { http, kws, cws, WebSocketImpl, fetchImpl: H.fetchFor(http), close: async () => { await kws.close(); await cws.close(); await http.close(); } };
}

test('strict flags on both CLIs: unknown command / flag, duplicate, valueless, positional, missing required, malformed UTC / int / bool refuse with exit 2 + usage; --help prints usage with zero I/O; every command spec is reachable', async () => {
  const bad = [['nope'], ['inspect', '--policy'], ['inspect', '--policy', 'a', '--policy', 'b'], ['inspect', '--policy', 'a', 'extra'], ['inspect', '--nope', 'x'], ['coverage', '--policy', 'a'], ['coverage', '--policy', 'a', '--out', 'b', '--probe', 'yes'], ['capture', '--policy', 'a', '--subjects', 'b', '--duration-seconds', '-1', '--out', 'c'], ['build', '--capture', 'a', '--as-of', '2026-09-08 12:00', '--subject', 'BTC', '--out', 'b'], ['build', '--capture', 'a', '--as-of', '2026-02-30T00:00:00Z', '--subject', 'BTC', '--out', 'b'], ['serve', '--policy', 'a', '--subjects', 'b', '--research-root', 'c', '--port', '80x']];
  for (const argv of bad) { const o = io(); const code = await market(argv, { env: {}, ...o, fetchImpl: noNet, WebSocketImpl: NoWs }); assert.equal(code, EXIT_CODES.INVALID_REQUEST, argv.join(' ')); assert.equal(o.out(), ''); assert.match(o.err(), /"code":"INVALID_REQUEST"/); assert.ok(o.err().includes('usage: market-research')); }
  const badS = [['nope'], ['packet', '--context', 'a'], ['run', '--packet', 'a', '--policy', 'b'], ['run', '--packet', 'a', '--policy', 'b', '--out', 'c', '--reevaluation', '1'], ['verify'], ['verify', '--case', 'a', '--case', 'b'], ['evaluate', '--cases', 'builtin', '--policy', 'p', '--out', 'o', '--live-model', 'maybe'], ['packet', '--context', 'a', '--out', 'b', 'extra']];
  for (const argv of badS) { const o = io(); const code = await socrates(argv, { env: {}, ...o, fetchImpl: noNet }); assert.equal(code, EXIT_CODES.INVALID_REQUEST, argv.join(' ')); assert.equal(o.out(), ''); assert.ok(o.err().includes('usage: socrates-research')); }
  for (const argv of [[], ['--help'], ['-h'], ['help'], ['inspect', '--help'], ['capture', '--policy', 'x', '--help']]) { const o = io(); assert.equal(await market(argv, { env: { ANTHROPIC_API_KEY: SECRET }, ...o, fetchImpl: noNet, WebSocketImpl: NoWs }), 0); assert.equal(o.out(), MARKET_USAGE); assert.equal(o.err(), ''); }
  for (const argv of [[], ['--help'], ['run', '--help']]) { const o = io(); assert.equal(await socrates(argv, { env: { ANTHROPIC_API_KEY: SECRET }, ...o, fetchImpl: noNet }), 0); assert.equal(o.out(), SOCRATES_USAGE); }
  assert.deepEqual(Object.keys(MARKET_COMMANDS), ['inspect', 'coverage', 'capture', 'build', 'serve', 'edge-capture', 'edge-evaluate']); // edge-*: MARKET-EDGE-KRAKEN-1 dark senses (research only) assert.deepEqual(Object.keys(SOCRATES_COMMANDS), ['packet', 'run', 'verify', 'evaluate']);
  for (const c of Object.keys(MARKET_COMMANDS)) assert.ok(MARKET_USAGE.includes(`  ${c}`)); for (const c of Object.keys(SOCRATES_COMMANDS)) assert.ok(SOCRATES_USAGE.includes(`  ${c}`));
  assert.deepEqual(parseMarket(['build', '--capture', 'c', '--as-of', '2026-09-08T12:00:00Z', '--subject', 'BTC', '--out', 'o']), { command: 'build', flags: { capture: 'c', 'as-of': Date.UTC(2026, 8, 8, 12), subject: 'BTC', out: 'o' } });
  assert.deepEqual(parseSocrates(['evaluate', '--cases', 'builtin', '--policy', 'p', '--out', 'o', '--live-model', 'false']), { command: 'evaluate', flags: { cases: 'builtin', policy: 'p', out: 'o', 'live-model': false } });
  assert.ok(!MARKET_USAGE.includes(SECRET) && !SOCRATES_USAGE.includes(SECRET));
});

test('inspect is offline and prints environment variable NAMES only; a malformed / missing policy file is exit 3 / 2, never a crash; coverage without --probe makes zero requests and seals a matrix file', async () => {
  const dir = tmp();
  try {
    const policyFile = writeJson(dir, 'policy.json', H.policyWith({ providers: ['KRAKEN_SPOT'] }));
    const env = { ANTHROPIC_API_KEY: SECRET, COINGLASS_API_KEY: SECRET, FRED_API_KEY: SECRET };
    const o = io(); assert.equal(await market(['inspect', '--policy', policyFile], { env, ...o, fetchImpl: noNet, WebSocketImpl: NoWs }), 0);
    const r = o.last(); assert.equal(r.ok, true); assert.equal(r.command, 'inspect'); assert.ok(r.providers?.KRAKEN_SPOT || r.matrix || r.readiness, 'per-provider state is printed'); assert.ok(!o.out().includes(SECRET) && !o.err().includes(SECRET), 'a secret VALUE never prints'); assert.ok(o.out().includes('ANTHROPIC_API_KEY'), 'the credential env NAME is printed');
    writeFileSync(path.join(dir, 'broken.json'), '{"policyVersion": ,}'); const b = io(); assert.equal(await market(['inspect', '--policy', path.join(dir, 'broken.json')], { env, ...b, fetchImpl: noNet, WebSocketImpl: NoWs }), EXIT_CODES.INVALID_INPUT); assert.equal(b.out(), ''); assert.match(b.err(), /"ok":false/);
    const m = io(); const code = await market(['inspect', '--policy', path.join(dir, 'missing.json')], { env, ...m, fetchImpl: noNet, WebSocketImpl: NoWs }); assert.ok(code === EXIT_CODES.INVALID_INPUT || code === EXIT_CODES.INVALID_REQUEST || code === EXIT_CODES.EXECUTION_FAILURE); assert.match(m.err(), /"ok":false/);
    const c = io(); const out = path.join(dir, 'cov'); assert.equal(await market(['coverage', '--policy', policyFile, '--out', out], { env, ...c, fetchImpl: noNet, WebSocketImpl: NoWs }), 0); const cr = c.last(); assert.equal(cr.ok, true); assert.equal(cr.probe, false); assert.ok(existsSync(path.join(out, cr.file))); assert.ok(cr.families.SPOT_PRICE_CHART);
    const again = io(); assert.notEqual(await market(['coverage', '--policy', policyFile, '--out', out], { env, ...again, fetchImpl: noNet, WebSocketImpl: NoWs }), 0, 'an existing output directory is refused, never overwritten');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real pipeline through the CLIs over loopback fixtures: capture (2 s) -> build -> packet -> run with a RECORDED response (labelled, zero model calls) -> verify; run with the model disabled seals BUDGET_BLOCKED with zero calls; a tampered case fails verify with exit 3; evaluate builtin is scripted (12 cases, zero live usage) and --live-model true without --budget-dir is exit 2', async () => {
  const fx = await fixtures(); const dir = tmp();
  try {
    const policyFile = writeJson(dir, 'policy.json', H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'] })); const subjectsFile = writeJson(dir, 'subjects.json', subjectsBtc());
    const env = { ANTHROPIC_API_KEY: SECRET }; const opts = { env, fetchImpl: fx.fetchImpl, WebSocketImpl: fx.WebSocketImpl };
    // capture: real client stack against loopback (the CLI never receives a url map; the WebSocket implementation is the seam)
    const cap = path.join(dir, 'cap'); const c = io(); const t0 = Date.now(); assert.equal(await market(['capture', '--policy', policyFile, '--subjects', subjectsFile, '--duration-seconds', '2', '--out', cap, '--research-root', path.join(dir, 'root')], { ...opts, ...c }), 0, c.err());
    const cr = c.last(); assert.equal(cr.ok, true); assert.equal(cr.command, 'capture'); assert.ok(cr.observations > 10, `observations ${cr.observations}`); assert.ok(existsSync(path.join(cap, 'manifest.json'))); assert.ok(fx.http.requests.length > 0); assert.ok(!c.out().includes(SECRET) && !c.err().includes(SECRET));
    assert.equal(openBundle(cap, 'CAPTURE').manifest.bundleId, cr.bundleId);
    assert.ok(existsSync(path.join(dir, 'root', 'accounting', 'quota.jsonl')), 'every dispatch is accounted in the STABLE research root, never the per-run --out'); assert.ok(cr.accounting && typeof cr.accounting.counters.dispatched === 'number' && cr.accounting.journal.durable === true, 'the capture reports its accounting authority');
    const noRoot = io(); assert.equal(await market(['capture', '--policy', policyFile, '--subjects', subjectsFile, '--duration-seconds', '1', '--out', path.join(dir, 'cap-noroot')], { ...opts, ...noRoot }), 2, 'capture without a research root cannot account and is refused');
    // build (offline: the network stubs would throw)
    const asOf = utcNoMillis(Date.now() + 1000); const ctx = path.join(dir, 'ctx'); const b = io(); assert.equal(await market(['build', '--capture', cap, '--as-of', asOf, '--subject', 'BTC', '--out', ctx], { env, ...b, fetchImpl: noNet, WebSocketImpl: NoWs }), 0, b.err());
    const br = b.last(); assert.equal(br.ok, true); assert.equal(br.canonicalCoin, 'BTC'); assert.equal(br.families.SPOT_PRICE_CHART.state, 'OBSERVED'); assert.ok(br.asOfTs > t0);
    const ctx2 = path.join(dir, 'ctx2'); const b2 = io(); assert.equal(await market(['build', '--capture', cap, '--as-of', asOf, '--subject', 'BTC', '--out', ctx2], { env, ...b2, fetchImpl: noNet, WebSocketImpl: NoWs }), 0); assert.equal(b2.last().contextId, br.contextId, 'same capture + as-of => identical context identity across directories');
    const unknown = io(); assert.notEqual(await market(['build', '--capture', cap, '--as-of', asOf, '--subject', 'DOGE', '--out', path.join(dir, 'ctx-doge')], { env, ...unknown, fetchImpl: noNet, WebSocketImpl: NoWs }), 0, 'a subject absent from the capture is refused');
    // packet (pure assembly)
    const pk = path.join(dir, 'pk'); const p = io(); assert.equal(await socrates(['packet', '--context', ctx, '--out', pk], { env, ...p, fetchImpl: noNet }), 0, p.err()); const pr = p.last(); assert.equal(pr.ok, true); assert.ok(/^sep2-[0-9a-f]{40}$/.test(pr.packetId)); assert.equal(pr.social, false); assert.ok(pr.evidence > 0);
    // run: model disabled (sample default) => BUDGET_BLOCKED / MODEL_DISABLED, zero calls, still a sealed, verifiable case
    const blockedDir = path.join(dir, 'case-blocked'); const rb = io(); assert.equal(await socrates(['run', '--packet', pk, '--policy', policyFile, '--out', blockedDir, '--context', ctx, '--capture', cap], { env, ...rb, fetchImpl: noNet }), 0, rb.err());
    const rbr = rb.last(); assert.equal(rbr.status, 'BUDGET_BLOCKED'); assert.equal(rbr.diagnostic.kind, 'MODEL_DISABLED'); assert.equal(rbr.liveModel, false); assert.equal(rbr.recordedResponseUsed, false); assert.equal(openBundle(blockedDir, 'CASE').manifest.summary.status, 'BUDGET_BLOCKED');
    // run with a recorded response: an explicit replay / test path, labelled as such, zero model calls even with the model enabled + a key present
    const insufficient = { analysisState: 'INSUFFICIENT_EVIDENCE', thesis: null, mechanism: null, marketImplication: null, stage: null, support: [], contradictions: [], missingEvidence: [{ text: 'recorded fixture: no judgement is made over this packet' }], falsifiers: [], watchNext: [], unknowns: ['everything'], security: { untrustedTextSeen: false, promptInjectionSuspected: false }, securityNotes: [], limitations: ['recorded response fixture'], hypotheses: [], alternativeConsideration: { state: 'INSUFFICIENT_FOR_COMPARISON', explanation: 'nothing to compare' }, dataRequests: [], revision: { state: 'FIRST_REPORT', previousAnalysisId: null, changedEvidenceRefs: [], explanation: null }, calibration: { assessedAs: 'RESEARCH_HYPOTHESIS', calibrated: false } };
    const rrFile = writeJson(dir, 'recorded.json', { responses: [{ revision: 'FIRST_REPORT', text: JSON.stringify(insufficient), recordedTs: 1, actualModel: 'recorded-fixture' }] });
    const livePolicy = writeJson(dir, 'policy-live.json', H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'], model: { enabled: true, maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 1, maxEstimatedUsdPerMonth: 1 } }));
    const caseDir = path.join(dir, 'case-recorded'); const budgetDir = path.join(dir, 'budget'); const rr = io(); assert.equal(await socrates(['run', '--packet', pk, '--policy', livePolicy, '--out', caseDir, '--context', ctx, '--recorded-response', rrFile, '--budget-dir', budgetDir], { env, ...rr, fetchImpl: noNet }), 0, rr.err());
    const rrr = rr.last(); assert.equal(rrr.status, 'COMPLETED'); assert.equal(rrr.recordedResponseUsed, true); assert.equal(rrr.liveModel, false); assert.deepEqual(rrr.path, ['RECORDED_RESPONSE']); assert.equal(rrr.analysisState, 'INSUFFICIENT_EVIDENCE'); assert.ok(!rr.out().includes(SECRET));
    const report = readFileSync(path.join(caseDir, 'report.md'), 'utf8'); assert.ok(report.includes('RECORDED_RESPONSE'), 'the readable report says a recorded response was used'); assert.ok(!report.includes(SECRET));
    const v = io(); assert.equal(await socrates(['verify', '--case', caseDir], { env, ...v, fetchImpl: noNet }), 0, v.err() + v.out()); assert.equal(v.last().ok, true); assert.equal(v.last().status, 'COMPLETED');
    const vb = io(); assert.equal(await socrates(['verify', '--case', blockedDir], { env, ...vb, fetchImpl: noNet }), 0); assert.equal(vb.last().ok, true);
    // tamper: the report bytes change => hashes disagree => exit 3, ok:false with reasons
    writeFileSync(path.join(caseDir, 'report.md'), `${report}\nBTC will certainly rise.\n`); const vt = io(); assert.equal(await socrates(['verify', '--case', caseDir], { env, ...vt, fetchImpl: noNet }), EXIT_CODES.INVALID_INPUT); assert.equal(vt.last().ok, false); assert.ok(vt.last().reasons.length > 0);
    // evaluate: scripted corpus, no model, no network; live without a budget dir is an invalid request
    const ev = path.join(dir, 'eval'); const e = io(); assert.equal(await socrates(['evaluate', '--cases', 'builtin', '--policy', policyFile, '--out', ev], { env, ...e, fetchImpl: noNet }), 0, e.err()); const er = e.last(); assert.equal(er.ok, true); assert.equal(er.cases, 12); assert.equal(er.path, 'SCRIPTED_RESPONSES'); assert.equal(er.usage.live, 0); assert.equal(er.assessment, 'IMPLEMENTATION_ASSESSMENT'); assert.equal(openBundle(ev, 'EVALUATION').manifest.summary.cases, 12);
    const el = io(); assert.equal(await socrates(['evaluate', '--cases', 'builtin', '--policy', livePolicy, '--out', path.join(dir, 'eval-live'), '--live-model', 'true'], { env, ...el, fetchImpl: noNet }), EXIT_CODES.INVALID_REQUEST); assert.ok(!existsSync(path.join(dir, 'eval-live', 'manifest.json')));
  } finally { await fx.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('serve goes through the documented service factory with the policy, subjects, research root, STANDALONE mode and loopback port; it prints the read-only endpoints, stops on SIGTERM and never starts an execution loop', async () => {
  const dir = tmp();
  try {
    const policyFile = writeJson(dir, 'policy.json', H.policyWith({ providers: ['KRAKEN_SPOT'] })); const subjectsFile = writeJson(dir, 'subjects.json', subjectsBtc()); const root = path.join(dir, 'root');
    const seen = []; let stops = 0;
    const serviceFactory = (args) => { seen.push(args); return { start: async () => ({ state: 'ACTIVE', http: { host: '127.0.0.1', port: 4242 }, segmentDir: path.join(root, 'captures', 'seg') }), stop: async () => { stops += 1; return { state: 'STOPPED', sealed: { bundleId: 'mb-x' } }; }, paths: { statusFile: path.join(root, 'status.json'), casesDir: path.join(root, 'cases') } }; };
    const signals = new EventEmitter(); const o = io();
    const pending = market(['serve', '--policy', policyFile, '--subjects', subjectsFile, '--research-root', root, '--port', '4242', '--case-every-seconds', '30'], { env: {}, ...o, fetchImpl: noNet, WebSocketImpl: NoWs, signals, serviceFactory });
    await new Promise((r) => setTimeout(r, 30)); assert.equal(seen.length, 1); assert.equal(seen[0].mode, 'STANDALONE'); assert.equal(seen[0].httpPort, 4242); assert.equal(seen[0].caseEverySeconds, 30); assert.equal(path.resolve(seen[0].researchRoot), path.resolve(root)); assert.equal(seen[0].policy.providers.KRAKEN_SPOT.enabled, true); assert.equal(seen[0].subjects.subjects[0].canonicalCoin, 'BTC');
    assert.ok(o.out().includes('"command":"serve"') && o.out().includes('/status') && o.out().includes('/readiness'), 'the endpoints are announced'); assert.equal(stops, 0);
    signals.emit('SIGTERM'); assert.equal(await pending, 0); assert.equal(stops, 1); assert.ok(o.err().includes('SIGTERM')); assert.equal(o.last().state, 'STOPPED');
    for (const k of ['runTape', 'startRumor2', 'ledger', 'order', 'strike']) assert.ok(!JSON.stringify(seen[0]).includes(k));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
