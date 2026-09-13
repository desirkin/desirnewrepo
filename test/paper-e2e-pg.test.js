// SERPENT PAPER RUNTIME — the end-to-end proof over the REAL composition under the PAPER PROFILE (config/paper-runtime.json) and the
// PostgreSQL journal authority (own schema on the established loopback cluster; skips honestly without a database).
//   PE2E-1 the positive vertical: profile environment applied -> the profile's Judge policy IS the reviewed reference -> a sealed
//          Socrates case verifies -> a real RANGE_IGNITION decision -> paper fill + child stop -> Watch -> deterministic
//          deterioration -> exit -> FLAT -> journal replay verifies, projection bound to PAPER; NO credential, NO private path.
//   PE2E-2 the negatives: a stale / silent market makes NO entry; KILL makes NO entry; an uncertain venue state latches
//          RECONCILIATION_REQUIRED (entry refused, owner CLEAR required, survives restart); a restart with an OPEN position resumes
//          Watch and still exits; a LIVE environment (mode / allow flags / key names present) under the PAPER profile is FORCED to
//          PAPER — no private call, no order path, a LIVE run over the paper policy refused.
// The trade geometry uses the SAME synthetic 0.1% fixture fee as judge-e2e-pg (the reviewed 0.8% reference refuses the fixture
// geometry by cost: that refusal is proven in judge-cost-capital). Nothing here lowers a threshold: the profile's policy file is
// asserted byte-identical to judge/samples/policy.paper-reference.json before the fixture copy is derived.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-paper-e2e-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL; const SCHEMA = `paper_e2e_${Date.now().toString(36)}`; const skip = !TEST_URL;
const { Db } = await import('../persistence/db.js'); const { runMigrations } = await import('../persistence/migrate.js'); const { createPgJournal } = await import('../execution/journal.js');
const { composeJudge, initAccount } = await import('../judge/composition.js'); const { loadJudgePolicy } = await import('../judge/policy.js');
const { fakeClock, SPEC } = await import('./helpers/judge.js'); const { crc32 } = await import('../lib/crc32.js');
const { readExecutionProjection } = await import('../state/execution-projection.js'); const { adapterEvent } = await import('../execution/adapter-contract.js'); const { entryPermission } = await import('../execution/authority.js');
const MC = await import('./helpers/market-closeout.js'); const MT0 = MC.T0; const { json, H } = MC; const { loadPolicy } = await import('../market-lab/policy.js'); const { createCaseRuntime } = await import('../socrates/runtime.js'); const { corpusCases } = await import('../socrates/corpus.js');
const { loadProfile, applyProfileEnvironment, profileFileOf, FORCED_ENV } = await import('../paper/profile.js');

// ---- the profile is the entry: its environment is applied to a FRESH env object (never the process env of this test) ----
const PROFILE = loadProfile(); const PENV = { DATABASE_URL: TEST_URL ?? '' }; const applied = applyProfileEnvironment(PROFILE, PENV);
assert.equal(PENV.JUDGE_MODE, 'PAPER'); assert.equal(PENV.JUDGE_ALLOW_PRIVATE, 'false'); assert.equal(PENV.JUDGE_ALLOW_ORDERS, 'false'); assert.ok(applied.applied.includes('JUDGE_POLICY'));
const PROFILE_POLICY_FILE = profileFileOf(PROFILE, 'judgePolicy'); assert.equal(path.resolve(PROFILE_POLICY_FILE), path.resolve(PENV.JUDGE_POLICY), 'the environment names the profile policy file');
const profileRaw = readFileSync(PROFILE_POLICY_FILE, 'utf8'); assert.equal(profileRaw, readFileSync(path.resolve('judge/samples/policy.paper-reference.json'), 'utf8'), 'the paper profile Judge policy IS the reviewed reference, byte for byte');
const paperRaw = JSON.parse(profileRaw); assert.equal(paperRaw.mode, 'PAPER'); assert.equal(paperRaw.execution.adapter, 'PAPER'); assert.equal(paperRaw.fees.taker.rate, '0.008', 'the reference fee stands in the profile (no retune)');
const feeOver = { taker: { ...paperRaw.fees.taker, rate: '0.001', scheduleId: 'synthetic-test-fee' } };
const policyFor = (acct) => { const f = path.join(TEST_DATA, `${acct}.json`); writeFileSync(f, JSON.stringify({ ...paperRaw, policyName: acct, account: { ...paperRaw.account, accountId: acct }, fees: feeOver })); return { file: f, ...loadJudgePolicy(f) }; };
const CODE = 'd'.repeat(64);
let db; let journal;
test.before(async () => { if (skip) return; db = new Db({ url: TEST_URL, schema: SCHEMA }); assert.equal(await db.connect(), true); await runMigrations(db); journal = createPgJournal({ db }); });
test.after(async () => { if (db) { try { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch { /* best effort */ } await db.end(); } rmSync(TEST_DATA, { recursive: true, force: true }); });

const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, ''); const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
function bars({ n = 61, endTs, close = 100000, range = 400, wickAt = 41, wickLow = 96000 } = {}) { const out = []; for (let i = 0; i < n; i += 1) out.push({ periodStartTs: endTs - (n - i) * 60_000, periodEndTs: endTs - (n - i - 1) * 60_000, open: close, high: close + range / 2, low: i === wickAt ? wickLow : close - range / 2, close, volumeQuote: 1000, volumeBase: 0.01, closed: true }); return out; }
const HISTORY = { bars: (symbol, nowTs) => bars({ endTs: Math.floor(nowTs / 60_000) * 60_000 }) };
const pclockOf = (clock) => ({ now: clock.now, monotonic: clock.monotonic, observeWall: () => null, status: () => ({ trusted: true, kind: 'TEST' }), expired: (t) => clock.now() > t });
// the driver over a composed run: exact wire messages into the execution feed, ticks through the composition, settle via the real queues
function driver(run, clock) {
  const feed = run.feed; feed.onConnect(clock.now()); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now()); feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tid = 0; const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tid, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const settle = async () => { await run.tick(); await run.judge.drain(); await run.dispatcher.idle(); await run.watch.onTick(clock.now()); await run.dispatcher.idle(); };
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now()); const adv = (ms) => { for (let t = 0; t < ms; t += 1000) { clock.advance(Math.min(1000, ms - t)); heartbeat(); } };
  const advance = async (ms, step = 250) => { for (let t = 0; t < ms; t += step) { clock.advance(Math.min(step, ms - t)); heartbeat(); await settle(); } };
  async function warm({ minutes = 22, price = 100000 } = {}) { book([[price + 10, 5]], [[price - 10, 5]], 'snapshot'); for (let m = 0; m < minutes; m += 1) { for (let k = 0; k < 4; k += 1) { adv(15_000); trade(price + 1, 'buy'); trade(price - 1, 'sell'); book([[price + 10, 5]], [[price - 10, 5]]); } } await settle(); }
  async function ignite({ price = 100000, level = 100400, books = 3, spanMs = 2100, askQty = 5 } = {}) { const start = Math.floor(clock.now() / 60_000) * 60_000 + 60_000; while (clock.now() < start) adv(1000); for (let k = 0; k < 20; k += 1) { adv(2000); trade(price + 50, 'buy', 0.2); } while (clock.now() % 60_000 !== 0) adv(1000); clock.advance(500); for (let i = 0; i < books; i += 1) { book([[level + 20, askQty], [level + 30, 5]], [[level, 5], [level - 10, 5]]); trade(level + 10, 'buy', 0.1); await settle(); if (i < books - 1) clock.advance(Math.ceil(spanMs / (books - 1))); } await settle(); }
  async function deteriorate() { const p = 100420; for (let i = 0; i < 80; i += 1) { clock.advance(1000); book([[p + 10, 5]], [[p, 1], [p - 10, 1]]); trade(p + 5, 'buy', 0.05); } await settle(); for (let i = 0; i < 4; i += 1) { clock.advance(1100); book([[p + 10, 5]], [[p, 0.1], [p - 10, 0.1]]); for (let k = 0; k < 6; k += 1) trade(p + 1, 'sell', 0.5); clock.advance(100); await settle(); } }
  // a silent socket: the clock moves, NO heartbeat / message arrives (a liveness gap breaks trade coverage, closeout R09)
  const silence = (ms) => { clock.advance(ms); };
  return { feed, book, trade, settle, advance, warm, ignite, deteriorate, silence, state: () => run.dispatcher.state() };
}
async function sealedCase(dir) { const c = corpusCases().find((x) => x.id === 'C01'); const cdir = path.join(dir, `case-${'a'.repeat(40)}-${String(MT0).padStart(13, '0')}`); const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'], model: { enabled: true, maxEstimatedUsdPerCase: 1, maxEstimatedUsdPerDay: 5, maxEstimatedUsdPerMonth: 50, totalSmokeMaxEstimatedUsd: 1, maxOutputTokens: 2048 } })); const message = { type: 'message', id: 'msg_test', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(c.scripted) }], usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }; const fetchImpl = async (url) => (new URL(url).pathname === '/v1/messages/count_tokens' ? json({ input_tokens: 1000 }) : json(message)); const rt = createCaseRuntime({ policy, env: { ANTHROPIC_API_KEY: 'sk-ant-test-fixture-not-a-real-key' }, fetchImpl, budgetDir: path.join(dir, 'budget'), clock: () => MT0 }); try { const r = await rt.runCase({ packet: c.packet, out: cdir }).done; assert.equal(r.status, 'COMPLETED'); return { cdir, packet: c.packet }; } finally { await rt.close(); } }
const compose = (P, clock, extra = {}) => composeJudge({ policyFile: P.file, mode: PENV.JUDGE_MODE, env: PENV, journal, clock: pclockOf(clock), specs: [SPEC], history: HISTORY, nominations: () => [{ symbol: 'XBT/USD', assetId: 'BTC' }], writeProjection: true, codeDigest: CODE, log: () => {}, allowPrivate: () => PENV.JUDGE_ALLOW_PRIVATE === 'true', allowOrders: () => PENV.JUDGE_ALLOW_ORDERS === 'true', ...extra });
async function openPosition(run, clock) { run.admitNominations(); const d = driver(run, clock); await d.warm(); await d.ignite(); const dec = run.judge.decisions().find((x) => x.status === 'ENTRY_RESERVED'); assert.ok(dec, `no ENTRY_RESERVED: ${JSON.stringify(run.judge.decisions().map((x) => [x.status, x.reasonCodes]))}`); clock.advance(300); d.book([[100420.0, 5]], [[100400.0, 5]]); await d.settle(); const pos = Object.values(d.state().positions)[0]; assert.equal(pos?.state, 'OPEN', JSON.stringify(Object.values(d.state().orders).map((o) => [o.orderId, o.state]))); return { d, dec, pos }; }

test('PE2E-1. PAPER PROFILE positive vertical over PostgreSQL: sealed case verified -> RANGE_IGNITION decision -> paper fill + protection -> Watch -> deterministic deterioration -> exit -> FLAT -> replay verifies; projection bound to PAPER; no credential, no private path, authority NONE', { skip }, async () => {
  const P = policyFor('paper-e2e-1'); const casesDir = path.join(TEST_DATA, 'cases'); mkdirSync(casesDir, { recursive: true }); await sealedCase(casesDir);
  const clock = fakeClock(MT0 + 60_000); await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now() });
  const run = await compose(P, clock, { casesDir }); assert.equal(run.kind, 'PAPER'); assert.equal(run.adapter.kind, 'PAPER'); assert.equal(run.credentialsPresent, false); assert.equal(run.keyFingerprint, null);
  const report = await run.start(); assert.deepEqual(report.uncertainOrders, []); assert.equal(report.liveOwner, null, 'a paper account never claims the venue owner slot'); assert.equal(report.executions, null, 'no private executions socket');
  await run.cases.refresh(); assert.equal(run.cases.status().verified, 1, 'the sealed case verifies by bytes');
  const { d, pos } = await openPosition(run, clock); assert.equal(pos.protection.state, 'ACTIVE');
  const proj = readExecutionProjection({ now: clock.now() }); assert.equal(proj.state, 'FRESH'); assert.equal(proj.accountKind, 'PAPER'); assert.equal(proj.runMode, 'PAPER'); assert.equal(proj.openPositions, 1); assert.equal(proj.adapter, 'PAPER'); const rawProj = JSON.parse(readFileSync(path.join(TEST_DATA, 'execution', 'projection.json'), 'utf8')); assert.equal(rawProj.credentialsPresent, false); assert.equal(rawProj.keyFingerprint, null); assert.equal(rawProj.runMode, 'PAPER');
  assert.equal(run.watch.positions().length, 1, 'Watch holds the paper position');
  await d.deteriorate(); assert.equal(run.watch.positions()[0].exit.reason, 'DETERIORATION'); clock.advance(300); d.book([[100430.0, 5]], [[100380.0, 5]]); await d.settle(); await d.advance(600);
  const flat = d.state().positions[pos.positionId]; assert.equal(flat.state, 'FLAT', JSON.stringify(run.watch.positions()[0]?.exit)); assert.ok(flat.realizedPnl !== null); assert.equal(run.feed.pinned().size, 0);
  const stopped = await run.stop(); assert.equal(stopped.writerLost, false); assert.equal(stopped.ownerRelease, null);
  const verified = await journal.replayVerify('paper-e2e-1'); assert.equal(verified.ok, true, verified.reason);
  const p2 = readExecutionProjection({ now: clock.now() }); assert.equal(p2.openPositions, 0); assert.equal(p2.accountKind, 'PAPER');
});

test('PE2E-2. PAPER PROFILE negatives: silent / stale market -> NO entry; KILL -> NO entry; uncertain venue state -> RECONCILIATION_REQUIRED (refused entry, owner CLEAR only, survives restart); restart with an OPEN position resumes Watch and exits; a LIVE environment under the profile is forced to PAPER (no private, no order path; LIVE run over the paper policy refused)', { skip }, async () => {
  // (a) silent market: the socket goes quiet across the ignition window -> coverage / freshness clauses fail -> no decision reserves
  { const P = policyFor('paper-e2e-2a'); const clock = fakeClock(MT0 + 60_000); await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now() });
    const run = await compose(P, clock); await run.start(); run.admitNominations(); const d = driver(run, clock); await d.warm(); d.silence(20_000); await d.ignite();
    assert.ok(!run.judge.decisions().some((x) => x.status === 'ENTRY_RESERVED'), `stale market must not enter: ${JSON.stringify(run.judge.decisions().map((x) => [x.status, x.reasonCodes]))}`); assert.deepEqual(Object.keys(d.state().orders), []); assert.deepEqual(Object.keys(d.state().positions), []);
    const rd = run.judge.candidates()[0]?.readiness?.RANGE_IGNITION ?? null; assert.ok(rd && rd.state !== 'READY', `a silent socket breaks coverage: readiness is not READY: ${JSON.stringify(rd).slice(0, 300)}`); assert.ok(/FLOW_21MIN|COVERAGE_60S|BOOK_FRESH/.test(JSON.stringify(rd.missing ?? rd)), 'the missing clause names the coverage / freshness law'); await run.stop(); }
  // (b) KILL: the authenticated control blocks every entry through the ONE shared permission law
  { const P = policyFor('paper-e2e-2b'); const clock = fakeClock(MT0 + 60_000); await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now() });
    const run = await compose(P, clock, { controlsSource: () => ({ kill: true, cage: false, vetoes: [] }) }); await run.start(); run.admitNominations(); const d = driver(run, clock); await d.warm(); await d.ignite();
    const refused = run.judge.decisions().find((x) => x.status === 'ENTRY_REFUSED'); assert.ok(refused, JSON.stringify(run.judge.decisions().map((x) => [x.status, x.reasonCodes]))); assert.ok(refused.reasonCodes.includes('KILL')); assert.ok(!run.judge.decisions().some((x) => x.status === 'ENTRY_RESERVED')); assert.deepEqual(Object.keys(d.state().orders), []);
    assert.deepEqual(entryPermission(d.state(), { controls: { kill: true, cage: false, vetoes: [] }, nowTs: clock.now(), runMode: 'PAPER' }).reasons, ['KILL']); await run.stop(); }
  // (c) uncertain venue state on the entry order -> RECONCILIATION_REQUIRED: entry refused, CLEAR needs the owner, restart keeps the latch
  { const P = policyFor('paper-e2e-2c'); const clock = fakeClock(MT0 + 60_000); await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now() });
    const run = await compose(P, clock); await run.start(); const { d, pos } = await openPosition(run, clock); const entry = Object.values(d.state().orders).find((o) => o.kind === 'ENTRY'); assert.ok(entry);
    await run.dispatcher.applyAdapterEvent(adapterEvent('PAPER', 'ORDER_STATE', { orderId: entry.orderId, state: 'RECONCILIATION_REQUIRED', nativeOrderId: entry.nativeOrderId ?? null, nativeCumQty: null, reason: 'venue status ambiguous after fill', sourceTs: null, receiptTs: clock.now() }, clock.now())); await run.dispatcher.idle();
    assert.ok(d.state().restrictions.RECONCILIATION_REQUIRED, JSON.stringify(d.state().restrictions)); assert.equal(d.state().orders[entry.orderId].state, 'RECONCILIATION_REQUIRED');
    const perm = entryPermission(d.state(), { controls: { kill: false, cage: false, vetoes: [] }, nowTs: clock.now(), runMode: 'PAPER' }); assert.ok(perm.reasons.includes('RECONCILIATION_REQUIRED'), JSON.stringify(perm));
    await assert.rejects(run.dispatcher.commit(run.dispatcher.ev('RESTRICTION', { code: 'RECONCILIATION_REQUIRED', action: 'CLEAR', scope: null, source: 'test', sessionDate: null, reason: 'no owner', ownerRef: null, ts: clock.now() })), (e) => e.code === 'REDUCER_REFUSED' && e.detail?.code === 'OWNER_CLEAR_REQUIRED', 'a reconciliation latch clears only with owner intent');
    await run.stop(); const run2 = await compose(P, clock, { nominations: () => [] }); const rep = await run2.start(); assert.ok(rep.uncertainOrders.includes(entry.orderId), JSON.stringify(rep)); assert.ok(run2.dispatcher.state().restrictions.RECONCILIATION_REQUIRED, 'the latch survives restart'); assert.equal(run2.dispatcher.state().positions[pos.positionId].state, 'OPEN'); await run2.stop(); }
  // (d) restart with an OPEN position: Watch resumes on the restored position (no fresh USD 500, no resend) and the deterioration exit still lands
  { const P = policyFor('paper-e2e-2d'); const clock = fakeClock(MT0 + 60_000); await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now() });
    const run = await compose(P, clock); await run.start(); const { pos } = await openPosition(run, clock); const stopped = await run.stop(); assert.equal(stopped.writerLost, false);
    const run2 = await compose(P, clock, { nominations: () => [] }); const rep = await run2.start(); assert.deepEqual(rep.uncertainOrders, []); assert.deepEqual(rep.exposedPositions, [pos.positionId]); await run2.watch.onTick(clock.now());
    assert.equal(run2.watch.positions().length, 1, 'Watch resumed the OPEN position'); assert.equal(run2.watch.positions()[0].restored, true, 'tracked as RESTORED, never as a fresh fill'); assert.equal(run2.watch.positions()[0].positionId, pos.positionId); assert.equal(run2.dispatcher.state().positions[pos.positionId].state, 'OPEN'); assert.ok(run2.feed.pinned().has('XBT/USD'), 'held exposure pins its symbol before the feed connects');
    const d2 = driver(run2, clock); d2.book([[100420.0, 5]], [[100400.0, 5]]); await d2.settle(); await d2.deteriorate(); assert.equal(run2.watch.positions()[0].exit.reason, 'DETERIORATION'); clock.advance(300); d2.book([[100430.0, 5]], [[100380.0, 5]]); await d2.settle(); await d2.advance(600);
    assert.equal(d2.state().positions[pos.positionId].state, 'FLAT', JSON.stringify(run2.watch.positions()[0]?.exit)); await run2.stop(); const v = await journal.replayVerify('paper-e2e-2d'); assert.equal(v.ok, true, v.reason); }
  // (e) a LIVE environment (mode, allow flags, key names) under the PAPER profile: FORCED to PAPER; no private call; the transport is never touched; a LIVE run over the paper policy is refused
  { const liveEnv = { JUDGE_MODE: 'LIVE_ARMED', JUDGE_ALLOW_PRIVATE: 'true', JUDGE_ALLOW_ORDERS: 'true', KRAKEN_API_KEY: 'live-key-FAKE-VALUE', KRAKEN_API_SECRET: 'bGl2ZS1zZWNyZXQtRkFLRQ==', DATABASE_URL: TEST_URL };
    const r = applyProfileEnvironment(PROFILE, liveEnv); assert.equal(liveEnv.JUDGE_MODE, 'PAPER'); assert.equal(liveEnv.JUDGE_ALLOW_PRIVATE, 'false'); assert.equal(liveEnv.JUDGE_ALLOW_ORDERS, 'false'); assert.deepEqual(r.overridden.map((o) => o.name).sort(), Object.keys(FORCED_ENV).filter((k) => k !== 'RUMOR2_SOCIAL_MODE').sort()); assert.ok(!r.overridden.some((o) => /FAKE/.test(JSON.stringify(o))), 'the override report never echoes a value');
    const P = policyFor('paper-e2e-2e'); const clock = fakeClock(MT0 + 60_000); await initAccount({ journal, policy: P.policy, policyDigest: P.digest, mode: 'PAPER', ownerRef: 'owner-test', nowTs: clock.now() });
    let transportCalls = 0; const transport = async () => { transportCalls += 1; throw new Error('the paper profile must never reach a venue transport'); };
    const run = await composeJudge({ policyFile: P.file, mode: liveEnv.JUDGE_MODE, env: liveEnv, journal, clock: pclockOf(clock), specs: [SPEC], history: HISTORY, nominations: () => [], writeProjection: true, codeDigest: CODE, log: () => {}, transport, allowPrivate: () => liveEnv.JUDGE_ALLOW_PRIVATE === 'true', allowOrders: () => liveEnv.JUDGE_ALLOW_ORDERS === 'true' });
    assert.equal(run.kind, 'PAPER'); assert.equal(run.adapter.kind, 'PAPER'); assert.equal(run.credentialsPresent, false, 'key names in the environment grant nothing to a PAPER run'); const rep = await run.start(); assert.equal(rep.executions, null); assert.equal(rep.liveOwner, null); await run.stop(); assert.equal(transportCalls, 0);
    await assert.rejects(composeJudge({ policyFile: P.file, mode: 'LIVE_ARMED', env: liveEnv, journal, clock: pclockOf(clock), specs: [SPEC], history: HISTORY, log: () => {}, codeDigest: CODE }), /a LIVE run needs a LIVE policy/, 'the paper policy cannot be promoted by a flag'); }
});
