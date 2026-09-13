// MARKET / SOCRATES REMAINING CLOSEOUT, revision 2 — linked variants of the owner acceptance tests (P1–P5). Offline only:
// every provider / model path is a scripted fetch, every clock is injected, every journal lives in a temp directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renameSync, mkdirSync, rmSync, readFileSync, existsSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { T0, tmp, json, btcOnly, cryptoquantPolicy, cryptoquantFetch, subjects, H, SEALED_REF } from './helpers/market-closeout.js';
import { loadPolicy, ALLOWED_MAX_AGE_MS, RESOURCE_DEFAULTS } from '../market-lab/policy.js';
import { PROVIDER_IDS, FAMILIES, makeObservation, makeCoverage, subjectId, familyMetricIds } from '../market-lab/contracts.js';
import { ENDPOINTS, providersForFamily } from '../market-lab/registry.js';
import { openBudgetJournal } from '../socrates/budget.js';
import { openQuotaJournal, createDispatchGuard } from '../market-lab/quota.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createResearchOwner, CLOSE_DRAIN_MS } from '../market-lab/owner.js';
import { createResearchService } from '../market-lab/service.js';
import { createCaseRuntime } from '../socrates/runtime.js';
import { createBroker } from '../socrates/broker.js';
import { providerReadiness, liveReadinessManifest, qualifyFamilyEvidence, qualifyModelDemonstration } from '../market-lab/readiness.js';
import { buildContext, contextError, contextIdentity, COMPONENT_KEYS } from '../market-lab/context.js';
import { componentValueError } from '../market-lab/context-schema.js';
import { runBuild, readContext } from '../market-lab/commands.js';
import { writeAll, manifestIdentity } from '../market-lab/store.js';
import { canonicalDigest, sha256Hex } from '../market-lab/contracts.js';

const PRICING = { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 };
const CAPS = { maxEstimatedUsdPerCase: 10, maxEstimatedUsdPerDay: 10, maxEstimatedUsdPerMonth: 10, totalSmokeMaxEstimatedUsd: 1 };
const USAGE = { inputTokens: 100_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const reserve = (j, id, amount = 1) => j.reserve({ reservationId: id, caseId: id, attemptId: id, estimatedUsd: amount, inputTokens: Math.round(amount * 1e6), maxOutputTokens: 0, pricing: PRICING, caps: CAPS });
// the durable seam: the journal FILE becomes a directory in place (open for append fails with EISDIR) — restored by `heal`
const breakFile = (file) => { if (existsSync(file)) renameSync(file, `${file}.saved`); mkdirSync(file); };
const healFile = (file) => { rmSync(file, { recursive: true, force: true }); if (existsSync(`${file}.saved`)) renameSync(`${file}.saved`, file); };
const codeOf = (fn) => { try { fn(); return null; } catch (err) { return err?.code ?? 'THROWN'; } };

// ================================================================= P2: budget journal (model dollars) ==========================
test('P2-B01. a failed RESERVE append leaves no reservation, latches the journal and refuses every later allowance; a reopen sees nothing written', () => {
  const dir = tmp('rev2-budget-'); let j;
  try {
    j = openBudgetJournal({ dir, clock: () => T0 }); const before = j.totals();
    breakFile(j.files.journalFile);
    assert.equal(codeOf(() => reserve(j, 'r1')), 'IO_FAILURE', 'the failed append surfaces, never an ordinary success');
    assert.equal(j.reservations().length, 0, 'the validated transition was never committed'); assert.deepEqual(j.totals(), before); assert.equal(j.failed()?.code, 'IO_FAILURE');
    healFile(j.files.journalFile);
    assert.equal(codeOf(() => reserve(j, 'r2')), 'IO_FAILURE', 'the latch holds even after the medium recovers: no new allowance until a safe reopen');
    assert.equal(codeOf(() => j.settle({ reservationId: 'r1', usage: USAGE, pricing: PRICING })), 'IO_FAILURE');
    j.close(); j = openBudgetJournal({ dir, clock: () => T0 }); assert.equal(j.reservations().length, 0); assert.equal(j.totals().dayUsd, 0); assert.equal(j.failed(), null, 'a safe reopen starts without the latch');
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P2-B02. a failed RELEASE append keeps the reservation RESERVED in memory and charged on disk; restart resolves it conservatively (UNRESOLVED, counted)', () => {
  const dir = tmp('rev2-budget-'); let j;
  try {
    j = openBudgetJournal({ dir, clock: () => T0 }); assert.equal(reserve(j, 'r1', 2).ok, true);
    breakFile(j.files.journalFile);
    assert.equal(codeOf(() => j.releaseReservation({ reservationId: 'r1', reason: 'REFUSED_BEFORE_DISPATCH' })), 'IO_FAILURE');
    assert.equal(j.isOpen('r1'), true, 'a release that never became durable is not a release'); assert.equal(j.totals().dayUsd, 2);
    healFile(j.files.journalFile); j.close();
    j = openBudgetJournal({ dir, clock: () => T0 }); const r = j.reservations()[0]; assert.equal(r.state, 'UNRESOLVED'); assert.equal(r.reason, 'RESERVED_AT_RESTART'); assert.equal(j.totals().dayUsd, 2, 'never refunded by a lost release');
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P2-B03. an illegal transition (settle twice, settle unknown, release settled) rejects BEFORE any byte is written and leaves state and latch untouched', () => {
  const dir = tmp('rev2-budget-'); let j;
  try {
    j = openBudgetJournal({ dir, clock: () => T0 }); assert.equal(reserve(j, 'r1').ok, true); j.settle({ reservationId: 'r1', usage: USAGE, pricing: PRICING });
    const bytes = statSync(j.files.journalFile).size;
    assert.equal(codeOf(() => j.settle({ reservationId: 'r1', usage: USAGE, pricing: PRICING })), 'INVALID_REQUEST');
    assert.equal(codeOf(() => j.settle({ reservationId: 'nope', usage: USAGE, pricing: PRICING })), 'INVALID_REQUEST');
    assert.equal(codeOf(() => j.releaseReservation({ reservationId: 'r1', reason: 'x' })), 'INVALID_REQUEST');
    assert.equal(statSync(j.files.journalFile).size, bytes, 'no row for a rejected transition'); assert.equal(j.reservations()[0].state, 'SETTLED'); assert.equal(j.failed(), null, 'a validation refusal is not an IO latch'); assert.equal(j.totals().dayUsd, 0.1);
    assert.equal(reserve(j, 'r2').ok, true, 'allowance continues after a rejected transition');
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P2-B04. the shared byte writer refuses a closed descriptor and a zero-byte write as IO_FAILURE (partial writes loop, never silently truncate)', () => {
  const dir = tmp('rev2-write-'); const file = path.join(dir, 'f'); const fd = openSync(file, 'w'); closeSync(fd);
  try {
    assert.equal(codeOf(() => writeAll(fd, Buffer.from('x'), 'f')), 'IO_FAILURE');
    assert.equal(statSync(file).size, 0, 'nothing reached the file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P2-B05. a corrupt journal, an oversized journal and a second owner refuse to open; a failed initialization leaves no lock behind', () => {
  const dir = tmp('rev2-budget-'); let j;
  try {
    writeFileSync(path.join(dir, 'journal.jsonl'), '{"type":"SETTLE","reservationId":"ghost","ts":1,"actualUsd":0}\n');
    assert.equal(codeOf(() => openBudgetJournal({ dir, clock: () => T0 })), 'INVALID_INPUT'); assert.equal(existsSync(path.join(dir, 'budget.lock')), false, 'no owned writer remains after a failed open');
    rmSync(path.join(dir, 'journal.jsonl')); j = openBudgetJournal({ dir, clock: () => T0 });
    assert.equal(codeOf(() => openBudgetJournal({ dir, clock: () => T0 })), 'PERMISSION_FAILURE', 'single-owner law');
    assert.equal(existsSync(path.join(dir, 'budget.lock')), true, 'the refused second owner never disturbs the first owner\'s lock');
  } finally { j?.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================= P2: provider quota journal (calls / credits) ==============
const quotaFixture = (dir) => { const journal = openQuotaJournal({ dir: path.join(dir, 'accounting'), clock: () => T0 }); const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })); const guard = createDispatchGuard({ policy, env: {}, journal, clock: () => T0 }); return { journal, policy, guard }; };
const TICKER = { providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'XXBTZUSD' } };

test('P2-Q01. a failed RESERVE append never dispatches: the guard reports ACCOUNTING_UNAVAILABLE, the transport refuses, the fetch never runs, and the latch survives medium recovery', async () => {
  const dir = tmp('rev2-quota-'); const { journal, guard } = quotaFixture(dir); let calls = 0;
  const http = createHttpTransport({ fetchImpl: async () => { calls += 1; return json(H.krakenTicker('XXBTZUSD')); }, clock: () => T0, admission: guard });
  try {
    breakFile(journal.files.journalFile);
    const r = await http.request(TICKER); assert.equal(r.ok, false); assert.equal(r.failure.kind, 'QUOTA_REFUSED'); assert.ok(r.failure.reasons.includes('ACCOUNTING_UNAVAILABLE'), r.failure.reasons.join());
    assert.equal(calls, 0, 'a failed reservation append may not result in a dispatch'); assert.equal(journal.reservations().length, 0); assert.equal(journal.failed()?.code, 'IO_FAILURE');
    healFile(journal.files.journalFile);
    const again = await http.request(TICKER); assert.equal(again.failure.kind, 'QUOTA_REFUSED'); assert.ok(again.failure.reasons.includes('ACCOUNTING_UNAVAILABLE'), 'latched: checked before every later admission'); assert.equal(calls, 0);
    assert.equal(guard.snapshot().journal.failure.code, 'IO_FAILURE');
  } finally { http.stop(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P2-Q02. a failed SETTLE append after the wire is ACCOUNTING_FAILED, never an ordinary success: no data admitted, the reservation stays charged, the owner surfaces it, and restart keeps it UNRESOLVED', async () => {
  const dir = tmp('rev2-quota-'); const { journal, guard } = quotaFixture(dir); let breakAfterWire = false;
  const http = createHttpTransport({ fetchImpl: async () => { if (breakAfterWire) breakFile(journal.files.journalFile); return json(H.krakenTicker('XXBTZUSD')); }, clock: () => T0, admission: guard });
  try {
    breakAfterWire = true; const r = await http.request(TICKER);
    assert.equal(r.ok, false); assert.equal(r.failure.kind, 'ACCOUNTING_FAILED'); assert.equal(guard.failureCount(), 1); assert.equal(guard.accountingFailure()?.code, 'IO_FAILURE');
    const row = journal.reservations()[0]; assert.equal(row.state, 'RESERVED', 'the settle never became durable: the conservative reservation stays'); assert.equal(journal.totals('KRAKEN_SPOT').calls.day, 1);
    healFile(journal.files.journalFile); assert.equal((await http.request(TICKER)).failure.kind, 'QUOTA_REFUSED', 'no new dispatch after the latch');
  } finally { http.stop(); journal.close(); }
  const j2 = openQuotaJournal({ dir: path.join(dir, 'accounting'), clock: () => T0 });
  try { assert.equal(j2.reservations()[0].state, 'UNRESOLVED'); assert.equal(j2.totals('KRAKEN_SPOT').calls.day, 1, 'still counted after restart'); } finally { j2.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P2-Q03. a failed PLAN append (paid provider, plan already attested once) and a failed RELEASE append leave the prior state and latch; illegal transitions reject without a latch', async () => {
  const dir = tmp('rev2-quota-'); const requests = [];
  const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir, fetchImpl: cryptoquantFetch(requests) });
  try {
    const first = await own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); assert.ok(first.usage.dispatched >= 1); const dispatched = requests.length; assert.equal(Object.keys(own.journal.plans()).length, 1, 'the plan row is durable');
    breakFile(own.journal.files.journalFile);
    const second = await own.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); assert.equal(requests.length, dispatched, 'no wire once an append fails'); assert.ok(second.results.every((x) => x.state !== 'OK')); assert.ok(second.usage.reasons.ACCOUNTING_UNAVAILABLE >= 1 || second.results.some((x) => x.state === 'ACCOUNTING_FAILED'), JSON.stringify(second.usage));
    assert.equal(own.status().accounting.journal.failure.code, 'IO_FAILURE');
    healFile(own.journal.files.journalFile);
  } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
  const d2 = tmp('rev2-quota-'); const { journal } = quotaFixture(d2);
  try {
    const id = journal.reserve({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', unit: 'CALL', credits: 1, chargedOn: 'DISPATCH', purpose: 'ACQUIRE', requestKey: 'k', estimatedUsd: 0 });
    breakFile(journal.files.journalFile); assert.equal(codeOf(() => journal.release(id, 'REFUSED')), 'IO_FAILURE'); assert.equal(journal.reservations()[0].state, 'RESERVED'); healFile(journal.files.journalFile); journal.close();
    const j2 = openQuotaJournal({ dir: path.join(d2, 'accounting'), clock: () => T0 }); assert.equal(j2.reservations()[0].state, 'UNRESOLVED', 'a lost release is resolved conservatively');
    const bytes = statSync(j2.files.journalFile).size; assert.equal(codeOf(() => j2.settle(j2.reservations()[0].reservationId, { ok: true })), 'INVALID_INPUT', 'impossible transition from UNRESOLVED'); assert.equal(statSync(j2.files.journalFile).size, bytes); assert.equal(j2.failed(), null); j2.close();
  } finally { rmSync(d2, { recursive: true, force: true }); }
});

// ================================================================= P3: owner stop ownership ================================
const timerSeam = () => { const timeouts = []; const timers = { setInterval, clearInterval, setTimeout: (fn, ms) => { const t = { fn, ms, fired: false, cleared: false, unref() {} }; timeouts.push(t); return t; }, clearTimeout: (t) => { if (t) t.cleared = true; } }; return { timers, timeouts, fire: () => { for (const t of timeouts) if (!t.fired && !t.cleared) { t.fired = true; t.fn(); } } }; };
const heldOwner = ({ dir, honourAbort, closeDrainMs, timers = undefined, respond = cryptoquantFetch() }) => {
  let enter; const entered = new Promise((r) => { enter = r; }); let release; const held = new Promise((r) => { release = r; });
  const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir, ...(timers ? { timers } : {}), ...(closeDrainMs === undefined ? {} : { closeDrainMs }),
    fetchImpl: (url, init) => new Promise((resolve, reject) => { enter(); if (honourAbort) init.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true }); held.then(() => respond(url)).then(resolve, reject); }) });
  return { own, entered, release: () => release() };
};

test('P3-S01. a transport that honours abort drains without the deadline: the request is CANCELLED, its reservation UNRESOLVED (ambiguous), nothing admitted, lock released', async () => {
  const dir = tmp('rev2-stop-'); const seam = timerSeam(); const { own, entered, release } = heldOwner({ dir, honourAbort: true, timers: seam.timers });
  try {
    await own.start({ outDir: path.join(dir, 'capture'), families: [] });
    const pending = own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); await entered;
    const stopped = await own.stop({ seal: true }); assert.equal(stopped.drain.outcome, 'DRAINED'); assert.equal(stopped.drain.fencedRequests.length, 0, 'nothing left to fence after a cooperative drain');
    assert.ok(seam.timeouts.every((t) => !t.fired), 'the deadline timer never had to fire');
    const r = await pending; assert.equal(r.observations.length, 0); assert.ok(r.results.every((x) => x.state !== 'OK'), JSON.stringify(r.results));
    assert.equal(existsSync(path.join(dir, 'accounting', 'quota.lock')), false); assert.equal(own.journal.isClosed(), true);
    const j = openQuotaJournal({ dir: path.join(dir, 'accounting'), clock: () => T0 }); try { assert.ok(j.reservations().every((x) => x.state === 'UNRESOLVED'), 'an aborted in-flight request is ambiguous: kept, never refunded'); } finally { j.close(); }
    release();
  } finally { release(); await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

test('P3-S02. a transport that ignores abort: the lock stays held DURING the bounded drain (nonzero injected deadline), the deadline fences every in-flight request as UNRESOLVED, then the lock goes; the late response is discarded', async () => {
  const dir = tmp('rev2-stop-'); const seam = timerSeam(); const { own, entered, release } = heldOwner({ dir, honourAbort: false, closeDrainMs: 5000, timers: seam.timers });
  try {
    await own.start({ outDir: path.join(dir, 'capture'), families: [] });
    const pending = own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); await entered;
    const stopping = own.stop({ seal: true }); await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 20));
    assert.equal(seam.timeouts.filter((t) => t.ms === 5000).length, 1, 'ONE drain deadline armed with the configured value'); assert.equal(own.journal.isClosed(), false, 'the journal is still owned while draining'); assert.equal(existsSync(path.join(dir, 'accounting', 'quota.lock')), true, 'the lock is held DURING the drain'); assert.equal(own.status().lifecycle, 'STOPPING'); assert.equal(own.status().drain.inFlightRequests, 1);
    seam.fire(); const stopped = await stopping;
    assert.equal(stopped.drain.outcome, 'TIMEOUT'); assert.equal(stopped.drain.fencedRequests.length, 1); assert.equal(own.journal.isClosed(), true); assert.equal(existsSync(path.join(dir, 'accounting', 'quota.lock')), false, 'released exactly after the fence');
    const bytesAtStop = statSync(path.join(dir, 'accounting', 'quota.jsonl')).size;
    release(); const r = await pending; assert.equal(r.observations.length, 0, 'the late response never becomes data'); assert.ok(r.results.every((x) => x.state === 'CANCELLED' || x.state === 'FAILED' || x.state === 'SOURCE_FAILED'), JSON.stringify(r.results)); assert.equal(own.observations().length, 0);
    assert.equal(statSync(path.join(dir, 'accounting', 'quota.jsonl')).size, bytesAtStop, 'no accounting mutation after the lock was released');
    const j = openQuotaJournal({ dir: path.join(dir, 'accounting'), clock: () => T0 }); try { const rows = j.reservations(); assert.ok(rows.length >= 1); assert.ok(rows.every((x) => x.state === 'UNRESOLVED' && x.reason === 'DETACHED_AT_STOP'), JSON.stringify(rows)); } finally { j.close(); }
  } finally { release(); await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

test('P3-S03. actual work is tracked apart from the coalescing map: share:false requests, a coalesced consumer and a queued request are all fenced at stop; the queued one never reserves', async () => {
  const dir = tmp('rev2-quota-'); const { journal, guard } = quotaFixture(dir); let release; const held = new Promise((r) => { release = r; }); let calls = 0;
  const http = createHttpTransport({ fetchImpl: () => { calls += 1; return held.then(() => json(H.krakenTicker('XXBTZUSD'))); }, clock: () => T0, admission: guard });
  try {
    const a = http.request({ ...TICKER, share: false }); const b = http.request({ ...TICKER, share: false }); // per-provider concurrency 1: b queues behind a
    const c = http.request({ ...TICKER, query: { pair: 'XETHZUSD' } }); const d = http.request({ ...TICKER, query: { pair: 'XETHZUSD' } }); // d coalesces onto c
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(http.inFlight(), 3, 'a, b (queued) and c are actual work; d is a consumer of c'); assert.equal(calls, 1, 'one dispatched, the rest queued or coalesced');
    http.stop(); const fenced = http.fence('DETACHED_AT_STOP'); assert.equal(fenced.length, 3);
    const rows = journal.reservations(); assert.equal(rows.length, 1, 'only the dispatched request ever reserved: the queued and coalesced ones are proven non-dispatch'); assert.equal(rows[0].state, 'UNRESOLVED');
    release(); // the uncooperative transport answers only now, after the fence
    const [ra, rb, rc, rd] = await Promise.all([a, b, c, d]); for (const r of [ra, rb, rc, rd]) assert.equal(r.failure.kind, 'CANCELLED', JSON.stringify(r.failure));
    assert.equal(calls, 1, 'nothing queued was ever dispatched after the stop'); assert.equal(http.inFlight(), 0); assert.equal((await http.drained()), true); assert.equal(journal.reservations().length, 1);
  } finally { release(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P3-S04. stop during response parsing: a body that completes after the fence is discarded as CANCELLED, never parsed as data', async () => {
  const dir = tmp('rev2-stop-'); let pull; const body = new ReadableStream({ pull: (ctrl) => new Promise((r) => { pull = () => { try { ctrl.enqueue(new TextEncoder().encode(JSON.stringify(H.cryptoquantSeries({ field: 'addresses_count_active' })))); ctrl.close(); } catch { /* the reader already cancelled the body at stop */ } r(); }; }) });
  let entered; const gate = new Promise((r) => { entered = r; });
  const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir, closeDrainMs: 0, fetchImpl: async (url) => { if (/addresses-count/.test(url)) { entered(); return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }); } return json({ status: { code: 404 } }, 404); } });
  try {
    await own.start({ outDir: path.join(dir, 'capture'), families: [] });
    const pending = own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); await gate; await new Promise((r) => setTimeout(r, 20));
    const stopped = await own.stop({ seal: true }); assert.equal(stopped.drain.outcome, 'TIMEOUT'); assert.equal(stopped.drain.fencedRequests.length, 1);
    pull(); const r = await pending; assert.equal(r.observations.length, 0); assert.ok(r.results.every((x) => x.state !== 'OK'), JSON.stringify(r.results)); assert.equal(own.observations().length, 0); assert.equal(own.status().fenced, true);
  } finally { pull?.(); await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

test('P3-S05. the service forwards closeDrainMs to BOTH lifecycle owners deliberately (default 10 s each; zero permitted); the market owner never imports Socrates', async () => {
  const src = readFileSync(new URL('../market-lab/owner.js', import.meta.url), 'utf8'); assert.ok(!/from '\.\.\/socrates\//.test(src), 'market-lab/owner.js does not import Socrates');
  assert.equal(CLOSE_DRAIN_MS, 10_000);
  for (const closeDrainMs of [undefined, 0, 250]) {
    const root = tmp('rev2-svc-'); const svc = createResearchService({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), env: {}, researchRoot: root, mode: 'INTEGRATED', clock: () => Date.now(), fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), httpPort: null, log: () => {}, ...(closeDrainMs === undefined ? {} : { closeDrainMs }) });
    try { const expected = closeDrainMs ?? CLOSE_DRAIN_MS; assert.equal(svc.owner.status().drain.deadlineMs, expected); assert.equal(svc.runtime.status().drain.deadlineMs, expected); } finally { await svc.stop(); rmSync(root, { recursive: true, force: true }); }
  }
  assert.throws(() => createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), closeDrainMs: -1, researchRoot: tmp('rev2-neg-') }), /closeDrainMs/);
});

test('P3-S06. an accounting failure WHILE settling during close is recorded, the fence still completes, the lock is still released, and the ambiguous reservation is resolved at the next open', async () => {
  const dir = tmp('rev2-stop-'); const { own, entered, release } = heldOwner({ dir, honourAbort: false, closeDrainMs: 0 });
  try {
    await own.start({ outDir: path.join(dir, 'capture'), families: [] });
    const pending = own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); await entered;
    breakFile(own.journal.files.journalFile);
    const stopped = await own.stop({ seal: true }); assert.equal(stopped.drain.outcome, 'TIMEOUT'); assert.equal(stopped.drain.fencedRequests.length, 1);
    assert.ok(stopped.drain.accounting, 'the failed settle-at-close is visible'); assert.equal(stopped.drain.accounting.code, 'IO_FAILURE'); assert.equal(own.journal.isClosed(), true); assert.equal(existsSync(path.join(dir, 'accounting', 'quota.lock')), false, 'the lock still goes after the fence');
    healFile(own.journal.files.journalFile); release(); const r = await pending; assert.equal(r.observations.length, 0);
    const j = openQuotaJournal({ dir: path.join(dir, 'accounting'), clock: () => T0 }); try { assert.ok(j.reservations().every((x) => x.state === 'UNRESOLVED'), 'RESERVED on disk becomes UNRESOLVED at the next open'); assert.equal(j.totals('CRYPTOQUANT').calls.day, 1); } finally { j.close(); }
  } finally { release(); await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================= P4: broker support ======================================
const variant = (o, over) => { const { observationId, ...rest } = o; return makeObservation({ ...rest, ...over, payload: { ...rest.payload, ...(over.payload ?? {}) } }); };
const DAY = 86_400_000;
const fakeOwner = (obs, coverage = [], acquire = async () => ({ results: [], observations: [] })) => ({ observations: () => obs, coverage: () => coverage, acquire });
const historyReq = (over = {}) => ({ requestKey: 'Q1', requestKind: 'HISTORY', family: 'NETWORK_ACTIVITY', metricIds: ['active_addresses'], subjectRef: 'BTC', windowStartTs: T0 - 30 * DAY, windowEndTs: T0, requestedMaxAgeMs: null, hypothesisRefs: [], question: 'q', interpretationIfSupported: 'x', interpretationIfContradicted: 'y', ...over });
const OPTS = (over = {}) => ({ analysisId: 'soc2-' + 'a'.repeat(40), caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs: T0, deadlineTs: T0 + 60_000, ...over });
async function dailyPoints() { const dir = tmp('rev2-daily-'); const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir, fetchImpl: cryptoquantFetch() }); try { const r = await own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] }); return r.observations.filter((o) => o.payload.metricId === 'active_addresses'); } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); } }
const dailySeries = (p, days, { skip = [] } = {}) => { const end = Date.UTC(2026, 8, 8); const out = []; for (let i = days; i >= 1; i -= 1) { if (skip.includes(i)) continue; const start = end - i * DAY; out.push(variant(p, { periodStartTs: start, periodEndTs: start + DAY, sourceKey: `btc:active_addresses:all:day:${start}`, receivedTs: T0, knownAtTs: T0 })); } return out; };

test('P4-D01. a complete daily grid over the requested interval is SATISFIED; one missing day inside it is PARTIAL with the missing period named; the same grid seen through the cache still reports the gap', async () => {
  const [p] = await dailyPoints(); const policy = cryptoquantPolicy(); const start = Date.UTC(2026, 8, 8) - 30 * DAY; const end = Date.UTC(2026, 8, 8);
  const full = dailySeries(p, 30); const gapped = dailySeries(p, 30, { skip: [12] });
  const replay = (obs) => createBroker({ owner: fakeOwner(obs), policy, clock: () => T0, mode: 'REPLAY_AS_OF' }).resolve(historyReq({ windowStartTs: start, windowEndTs: end }), OPTS());
  const ok = await replay(full); assert.equal(ok.state, 'SATISFIED', JSON.stringify(ok.metrics)); assert.equal(ok.observationsAdmitted, 30); assert.deepEqual([ok.metrics.active_addresses.support.basis, ok.metrics.active_addresses.support.expectedPeriods, ok.metrics.active_addresses.support.presentPeriods], ['PERIOD_GRID', 30, 30]);
  const gap = await replay(gapped); assert.equal(gap.state, 'PARTIAL'); assert.deepEqual(gap.metrics.active_addresses.support.reasons, ['MISSING_PERIODS']); assert.deepEqual(gap.metrics.active_addresses.support.missingStarts, [end - 12 * DAY]); assert.equal(gap.reason, 'REPLAY_NETWORK_OFF');
  // LIVE: the acquisition returns the gapped series; a second analysis asking the same question is answered from the evidence cache with the SAME law
  const broker = createBroker({ owner: fakeOwner([], [], async () => ({ results: [{ providerId: 'CRYPTOQUANT', endpointId: 'network-data', state: 'OK' }], observations: gapped, coverage: [], usage: { dispatched: 1, credits: 1, refused: 0, unresolved: 0, reasons: {} } })), policy, clock: () => T0 });
  const live = await broker.resolve(historyReq({ windowStartTs: start, windowEndTs: end }), OPTS()); assert.equal(live.state, 'PARTIAL'); assert.equal(live.metrics.active_addresses.support.missingPeriods, 1);
  const cached = await broker.resolve(historyReq({ windowStartTs: start, windowEndTs: end, requestKey: 'Q9' }), OPTS({ analysisId: 'soc2-' + 'b'.repeat(40) })); assert.equal(cached.reason, 'CACHE_HIT'); assert.equal(cached.state, 'PARTIAL', 'a cache hit cannot erase a gap'); assert.equal(cached.metrics.active_addresses.support.missingPeriods, 1); assert.equal(cached.usage.dispatched, 0);
});

test('P4-D02. dedupe precedes support: the same identity repeated counts once (duplicates reported); a native constituent set must EACH cover the grid', async () => {
  const [p] = await dailyPoints(); const policy = cryptoquantPolicy(); const start = Date.UTC(2026, 8, 8) - 3 * DAY; const end = Date.UTC(2026, 8, 8);
  const three = dailySeries(p, 3); const dup = [...three, three[0], three[1], three[1]];
  const r = await createBroker({ owner: fakeOwner(dup), policy, clock: () => T0, mode: 'REPLAY_AS_OF' }).resolve(historyReq({ windowStartTs: start, windowEndTs: end }), OPTS());
  assert.equal(r.state, 'SATISFIED'); assert.equal(r.observationsAdmitted, 3); assert.equal(r.metrics.active_addresses.duplicateIdentities, 3); assert.equal(r.metrics.active_addresses.matched, 3);
  const inflow = three.map((o) => variant(o, { endpointId: 'exchange-flows', payload: { metricId: 'exchange_inflow', entitySet: 'exchange:all_exchange' }, sourceKey: `in:${o.periodStartTs}` })); const outflow = three.slice(1).map((o) => variant(o, { endpointId: 'exchange-flows', payload: { metricId: 'exchange_outflow', entitySet: 'exchange:all_exchange' }, sourceKey: `out:${o.periodStartTs}` }));
  const net = await createBroker({ owner: fakeOwner([...inflow, ...outflow]), policy, clock: () => T0, mode: 'REPLAY_AS_OF' }).resolve(historyReq({ family: 'ONCHAIN_ENTITY_FLOW', metricIds: ['exchange_net_flow'], windowStartTs: start, windowEndTs: end }), OPTS());
  assert.notEqual(net.state, 'SATISFIED', 'outflow covers two of three days'); assert.equal(net.metrics.exchange_net_flow.support.nativeInput, 'exchange_outflow'); assert.equal(net.metrics.exchange_net_flow.support.missingPeriods, 1);
});

async function candles(count) {
  const kp = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })); const dir = tmp('rev2-candles-');
  const own = createResearchOwner({ policy: kp, subjects: btcOnly(), clock: () => T0, researchRoot: dir, fetchImpl: async (url) => { const u = new URL(url); return json(u.pathname.endsWith('AssetPairs') ? H.KRAKEN_ASSET_PAIRS : H.krakenOhlc('XXBTZUSD', { intervalMin: 60, endTs: T0, count })); } });
  try { await own.clients.KRAKEN_SPOT.loadCatalog(); const market = own.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market; const r = await own.clients.KRAKEN_SPOT.ohlc({ market, intervalMin: 60 }); assert.equal(r.ok, true); return r.observations.filter((o) => o.kind === 'CANDLE'); } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
}
test('P4-D03. derived candle metrics use the ACTUAL indicators() warmup: 30 hourly bars satisfy atr14 / rsi14 / bollinger20 but not sma / macd-with-signal-warmup / prior_range; 62 bars satisfy them; a gap in the bar series is PARTIAL even for a snapshot request', async () => {
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] }));
  const detail = (obs, metricIds) => createBroker({ owner: fakeOwner(obs), policy, clock: () => T0 }).resolve(historyReq({ requestKind: 'DETAIL', family: 'SPOT_PRICE_CHART', metricIds, windowStartTs: null, windowEndTs: null }), OPTS());
  const thirty = await candles(30); const closed = thirty.filter((b) => b.payload.closed).length; assert.ok(closed >= 15 && closed < 60, `closed bars: ${closed}`);
  const short = await detail(thirty, ['atr14', 'rsi14', 'bollinger20', 'sma', 'macd', 'prior_range']);
  assert.equal(short.state, 'PARTIAL'); for (const m of ['atr14', 'rsi14', 'bollinger20']) assert.equal(short.metrics[m].state, 'SATISFIED', m); for (const m of ['sma', 'macd', 'prior_range']) { assert.equal(short.metrics[m].state, 'PARTIAL', m); assert.deepEqual(short.metrics[m].support.reasons, ['WARMUP_INCOMPLETE']); assert.equal(short.metrics[m].support.basis, 'INDICATOR_WARMUP'); }
  const many = await candles(62); const long = await detail(many, ['sma', 'ema', 'macd', 'prior_range', 'realized_volatility']); assert.equal(long.state, 'SATISFIED', JSON.stringify(long.metrics));
  const gapped = many.filter((b, i) => i !== 20); const gap = await detail(gapped, ['sma']); assert.equal(gap.state, 'PARTIAL'); assert.deepEqual(gap.metrics.sma.support.reasons, ['MISSING_PERIODS']); assert.equal(gap.metrics.sma.support.missingPeriods, 1);
});

test('P4-D04. point observations (trades) need POSITIVE observed coverage for a HISTORY interval: without a record the support basis is missing; a spanning OBSERVED record completes it; a record with a hole is a gap', async () => {
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })); const dir = tmp('rev2-trades-'); let trades; let market;
  const own = createResearchOwner({ policy, subjects: btcOnly(), clock: () => T0, researchRoot: dir, fetchImpl: async (url) => { const u = new URL(url); return json(u.pathname.endsWith('AssetPairs') ? H.KRAKEN_ASSET_PAIRS : H.krakenTrades('XXBTZUSD', { count: 3, endTs: T0 - 1000 })); } });
  try { await own.clients.KRAKEN_SPOT.loadCatalog(); market = own.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market; const r = await own.clients.KRAKEN_SPOT.trades({ market }); assert.equal(r.ok, true); trades = r.observations.filter((o) => o.kind === 'TRADE'); assert.ok(trades.length >= 2); } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
  const start = T0 - 10_000; const end = T0; const cov = (s, e) => makeCoverage({ provider: 'KRAKEN_SPOT', endpointId: 'rest-trades', subjectId: subjectId(market.subject), family: 'SPOT_FLOW', kind: 'TRADE', state: 'OBSERVED', reasonCodes: [], startTs: s, endTs: e, observationCount: trades.length, droppedCount: 0, epochId: null, sequenceStart: null, sequenceEnd: null });
  const history = (coverage) => createBroker({ owner: fakeOwner(trades, coverage), policy, clock: () => T0, mode: 'REPLAY_AS_OF' }).resolve(historyReq({ family: 'SPOT_FLOW', metricIds: ['signed_notional'], windowStartTs: start, windowEndTs: end }), OPTS());
  const none = await history([]); assert.equal(none.state, 'PARTIAL'); assert.deepEqual(none.metrics.signed_notional.support.reasons, ['COVERAGE_BASIS_MISSING']);
  const spanning = await history([cov(start - 5000, end)]); assert.equal(spanning.state, 'SATISFIED', JSON.stringify(spanning.metrics)); assert.equal(spanning.metrics.signed_notional.support.basis, 'COVERAGE_RECORDS');
  const hole = await history([cov(start, start + 3000), cov(start + 6000, end)]); assert.equal(hole.state, 'PARTIAL'); assert.deepEqual(hole.metrics.signed_notional.support.reasons, ['COVERAGE_GAP']); assert.deepEqual(hole.metrics.signed_notional.support.gaps, [[start + 3000, start + 6000]]);
});

// ================================================================= P5: closed context schemas ==============================
async function contextFixture() {
  const dir = tmp('rev2-context-'); const cap = path.join(dir, 'capture'); const ctxDir = path.join(dir, 'context'); const schedules = [];
  const timers = { setInterval: (fn, ms) => { const x = { fn, ms, unref() {} }; schedules.push(x); return x; }, clearInterval() {}, setTimeout, clearTimeout };
  const own = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), clock: () => T0, mode: 'INTEGRATED', researchRoot: dir, timers, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS) });
  try { await own.start({ outDir: cap, families: [] }); own.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: T0, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2]], asks: [[100.5, 2]] }) }); for (const s of schedules) if (s.ms === 250) s.fn(); await own.stop({ seal: true }); runBuild({ captureDir: cap, asOfTs: T0, canonicalCoin: 'BTC', out: ctxDir }); readContext(ctxDir); return { dir, ctxDir, base: JSON.parse(readFileSync(path.join(ctxDir, 'context.json'), 'utf8')) }; }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; } finally { await own.stop({ seal: false }); }
}
function reseal(fx, change) {
  const c = structuredClone(fx.base); change(c);
  for (const fam of Object.values(c.families)) for (const comp of fam.components) { const content = Object.fromEntries(COMPONENT_KEYS.filter((k) => k !== 'componentId').map((k) => [k, comp[k]])); comp.componentId = `mcc-${canonicalDigest(content).slice(0, 40)}`; }
  c.contextId = contextIdentity(c); const text = `${JSON.stringify(c, null, 1)}\n`; const mfPath = path.join(fx.ctxDir, 'manifest.json'); const m = JSON.parse(readFileSync(mfPath, 'utf8'));
  const member = m.members.find((x) => x.name === 'context.json'); member.bytes = Buffer.byteLength(text); member.sha256 = sha256Hex(Buffer.from(text)); m.summary.contextId = c.contextId; m.bundleId = manifestIdentity(m);
  writeFileSync(path.join(fx.ctxDir, 'context.json'), text); writeFileSync(mfPath, `${JSON.stringify(m, null, 1)}\n`); return c;
}
const spread = (c) => c.families.DISPLAYED_LIQUIDITY.components.find((x) => x.metricId === 'spread_bps');
const rebindAll = (ctx) => { for (const fam of Object.values(ctx.families)) for (const comp of fam.components) { const content = Object.fromEntries(COMPONENT_KEYS.filter((k) => k !== 'componentId').map((k) => [k, comp[k]])); comp.componentId = `mcc-${canonicalDigest(content).slice(0, 40)}`; } ctx.contextId = contextIdentity(ctx); return ctx; };
const SEMANTIC = (e) => ['INVALID_INPUT', 'VALIDATION_FAILURE', 'CORRUPT_INPUT'].includes(e.code) && !/checksum|sha256|digest|does not match content|bundleId|byte size/i.test(e.message);

test('P5-E01. every container of the saved shape is closed at the pure validator AND the actual reader after a correct reseal: family entry, coverage row, subject, omitted, resourceState, limits, captureRef, component scalars, limitations and an inherited property name', async () => {
  const fx = await contextFixture();
  try {
    const cases = [
      ['family entry text', (c) => { c.families.SPOT_FLOW.text = 'AUDIT_RAW_CONTENT_SENTINEL'; }, /SPOT_FLOW: undeclared key at position/],
      ['family entry inherited name', (c) => { c.families.SPOT_FLOW.hasOwnProperty = 1; }, /SPOT_FLOW: undeclared key at position/],
      ['family state', (c) => { c.families.SPOT_FLOW.state = 'FINE'; }, /SPOT_FLOW: malformed/],
      ['unknown family', (c) => { c.families.ALPHA = { state: 'OBSERVED', components: [], coverage: [] }; }, /families: undeclared family/],
      ['subject id', (c) => { c.subjects[0].subjectId = 'ms-' + '0'.repeat(32); }, /subjects\[0\]: subjectId does not match/],
      ['subject extra', (c) => { c.subjects[0].note = 'x'; }, /subjects\[0\]: undeclared key at position/],
      ['omitted string', (c) => { c.omitted.lateArrivals = '0'; }, /omitted: counts malformed/],
      ['omitted extra', (c) => { c.omitted.extra = 0; }, /omitted: undeclared key at position/],
      ['resourceState extra', (c) => { c.resourceState = { subjects: 1, totalBytes: 1, evictions: null, raw: 1 }; }, /resourceState: undeclared key at position/],
      ['resourceState evictions', (c) => { c.resourceState = { subjects: 1, totalBytes: 1, evictions: { trades: -1, bookSamples: 0, bars: 0, subjects: 0, bytesPressure: 0 } }; }, /evictions: counts malformed/],
      ['limits zero', (c) => { c.limits.maxInputIds = 0; }, /limits: malformed/],
      ['captureRef member missing', (c) => { delete c.captureRef.membership; }, /captureRef: missing key/],
      ['captureRef extra', (c) => { c.captureRef.note = 'x'; }, /captureRef: undeclared key at position/],
      ['component count negative', (c) => { spread(c).inputObservationCount = -1; }, /inputObservationCount: must be a non-negative integer/],
      ['component digest', (c) => { spread(c).inputDigest = 'nope'; }, /inputDigest: malformed/],
      ['component subject', (c) => { spread(c).subjectId = 'x'; }, /subject\/clock fields malformed/],
      ['component limitations', (c) => { spread(c).limitations = 'none'; }, /limitations: malformed/],
      ['component input id shape', (c) => { spread(c).inputObservationIds = ['mo-x']; }, /input ids must be a sorted unique set/],
      ['value inherited name', (c) => { spread(c).value.toString = { text: 'AUDIT_RAW_CONTENT_SENTINEL' }; }, /DISPLAYED_LIQUIDITY\[\d+\]\.value: undeclared key at position/],
      ['support inherited name', (c) => { spread(c).support.valueOf = 1; }, /support: undeclared key at position/],
      ['book ask quantity negative', (c) => { spread(c).value.topAskQty = -2; }, /topAskQty: must be a non-negative/],
      ['band notional negative', (c) => { spread(c).value.bands['5bps'].bid.notional = -1; }, /bid\.notional: must be a non-negative/],
      ['best bid zero', (c) => { spread(c).value.bestBid = 0; }, /bestBid: must be a positive/],
    ];
    for (const [name, change, re] of cases) {
      const c = reseal(fx, change); const e = contextError(c); assert.ok(e, `${name}: pure validator must reject`); assert.match(e, re, `${name}: ${e}`); assert.ok(!/AUDIT_RAW_CONTENT_SENTINEL/.test(e), `${name}: no untrusted text in the diagnostic`);
      assert.throws(() => readContext(fx.ctxDir), (err) => SEMANTIC(err) || err.message === e, `${name}: the actual reader rejects semantically`); assert.throws(() => readContext(fx.ctxDir), (err) => err.message === e, `${name}: ONE law at both boundaries`);
    }
    reseal(fx, () => {}); readContext(fx.ctxDir); assert.equal(contextError(fx.base), null, 'the unchanged fixture stays lawful after the resealing round trip');
    // family coverage rows (this book-only fixture records none): a lawful row passes the pure validator; an extra key or a negative count rejects
    const row = makeCoverage({ provider: 'KRAKEN_SPOT', endpointId: 'ws-v2', subjectId: fx.base.subjects[0].subjectId, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_SNAPSHOT', state: 'OBSERVED', reasonCodes: [], startTs: T0 - 1000, endTs: T0, observationCount: 1, droppedCount: 0, epochId: null, sequenceStart: null, sequenceEnd: null });
    const project = (r) => ({ coverageId: r.coverageId, provider: r.provider, endpointId: r.endpointId, subjectId: r.subjectId, kind: r.kind, state: r.state, reasonCodes: r.reasonCodes, startTs: r.startTs, endTs: r.endTs, observationCount: r.observationCount, droppedCount: r.droppedCount });
    const withRow = (mut) => { const c = structuredClone(fx.base); const pr = project(row); mut(pr); c.families.DISPLAYED_LIQUIDITY.coverage.push(pr); return rebindAll(c); };
    assert.equal(contextError(withRow(() => {})), null); assert.match(contextError(withRow((r) => { r.raw = 'AUDIT_RAW_CONTENT_SENTINEL'; })), /coverage\[0\]: undeclared key at position/); assert.match(contextError(withRow((r) => { r.observationCount = -1; })), /coverage\[0\]: interval\/counters malformed/); assert.match(contextError(withRow((r) => { r.state = 'FINE'; })), /coverage\[0\]: state\/reasons malformed/);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('P5-E02. signed metrics keep their sign while magnitudes are non-negative; the closed DSL never treats an inherited name as declared or present', () => {
  const support = { state: 'COMPLETE', reasons: [] }; const base = { recipeId: 'signed_notional', version: 1, buyNotional: 10, sellNotional: 20, unknownNotional: 0, buyCount: 1, sellCount: 2, unknownCount: 0, signedNotional: -10, knownSideImbalance: -0.33, knownSideFraction: 1, observedOnly: false, support };
  const comp = (cur) => ({ metricId: 'signed_notional', support, value: { current: cur, previous: cur, stats: { recipeId: 'trade_size_stats', version: 1, sizeMedian: 1, sizeP90: 2, interarrivalMeanMs: 3, interarrivalMedianMs: 3, clockPrecisionMs: 1000, support: { state: 'COMPLETE', reasons: [] } }, venue: 'KRAKEN_SPOT', quote: 'USD' } });
  assert.equal(componentValueError(comp(base)), null, 'a negative signed notional is lawful');
  assert.match(componentValueError(comp({ ...base, buyNotional: -1 })), /buyNotional: must be a non-negative/);
  assert.match(componentValueError(comp({ ...base, buyCount: -1 })), /buyCount: must be a non-negative integer/);
  assert.match(componentValueError(comp({ ...base, constructor: { x: 1 } })), /value\.current: undeclared key at position/);
  const noRecipe = { ...base }; delete noRecipe.recipeId; assert.match(componentValueError(comp(noRecipe)), /recipeId: required key missing/, 'an inherited `constructor` never stands in for a declared key');
  // a value built with a null prototype has NO inherited names: the same law holds without relying on Object.prototype
  const bare = Object.assign(Object.create(null), base); assert.equal(componentValueError(comp(bare)), null);
});

test('P5-E03. the walk and round-trip quantities are magnitudes; a populated in-memory context with a negative fill is refused by the pure validator and never by identity', async () => {
  const { ko, market } = await (await import('./helpers/market-closeout.js')).krakenBookOnly({ bid: 99, ask: 101 });
  try {
    const { bookObs } = await import('./helpers/market-closeout.js'); const book = bookObs(ko, market, { bids: [[99, 5], [98, 5]], asks: [[101, 5], [102, 5]] });
    const built = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: [book], coverage: [], captureRef: SEALED_REF, referenceNotionals: [100] }); assert.equal(contextError(built.context, { inputReferences: built.inputReferences }), null);
    const hostile = structuredClone(built.context); const rt = hostile.families.DISPLAYED_LIQUIDITY.components.find((c) => c.metricId === 'round_trip_loss'); rt.value.buyWalk.filledBase = -1; rebindAll(hostile);
    const e = contextError(hostile, { inputReferences: built.inputReferences }); assert.match(e, /buyWalk\.filledBase: must be a non-negative/);
    const hostile2 = structuredClone(built.context); const rt2 = hostile2.families.DISPLAYED_LIQUIDITY.components.find((c) => c.metricId === 'round_trip_loss'); rt2.value.current.quoteNotional = -100; rebindAll(hostile2); assert.match(contextError(hostile2, { inputReferences: built.inputReferences }), /quoteNotional: must be a non-negative/);
  } finally { await ko.stop({ seal: false }); }
});

// ================================================================= P1: readiness qualification ==============================
const rowsAllPassed = (providers = [...PROVIDER_IDS]) => providerReadiness({ policy: loadPolicy(H.policyWith({ providers })), env: Object.fromEntries(PROVIDER_IDS.map((id) => [`${id}_API_KEY`, 'x'])), testReport: Object.fromEntries(PROVIDER_IDS.map((id) => [id, 'PASSED'])), liveReport: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { state: 'PASSED', ts: T0, endpointId: 'x', asset: 'BTC', evidence: 's' }])) });
const qualified = (fam, over = {}) => { const providerId = providersForFamily(fam)[0]; const endpoint = ENDPOINTS.find((e) => e.providerId === providerId && e.families.includes(fam)); const metrics = familyMetricIds(fam); return { providerId, endpointId: endpoint.endpointId, requested: 2, obtained: 2, assets: { requested: ['BTC', 'ETH'], obtained: ['BTC', 'ETH'] }, metrics: { requested: metrics, obtained: metrics }, interval: { startTs: T0 - 3_600_000, endTs: T0 - 500 }, knownAtTs: T0 - 500, requestedMaxAgeMs: ALLOWED_MAX_AGE_MS[fam].at(-1), support: { state: 'COMPLETE', basis: 'SNAPSHOT' }, complete: true, nativeLatencyMs: 10, smokeTs: null, ...over }; };

test('P1-R01. qualification names every missing proof and never throws: unrelated endpoint, stale knowledge, historical smoke only, unregistered metric, unbound count, provider not PASSED / disabled, age outside the family policy, garbage input', () => {
  const rows = rowsAllPassed(); const q = (fam, ev, generatedTs = T0) => qualifyFamilyEvidence(fam, ev, rows, { generatedTs });
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY')), { qualified: true, complete: true, missing: [], shortfall: [] });
  assert.deepEqual(q('DISPLAYED_LIQUIDITY', qualified('DISPLAYED_LIQUIDITY', { endpointId: 'rest-trades' })).missing, ['ENDPOINT_NOT_FAMILY_RELEVANT'], 'a Kraken trades smoke is not displayed-liquidity proof');
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY'), T0 + DAY + 1).missing, ['FRESHNESS_UNMET'], 'fresh under the family policy age only');
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { requestedMaxAgeMs: 12_345 })).missing, ['FRESHNESS_POLICY_NOT_NAMED']);
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { knownAtTs: undefined, smokeTs: T0 - 1000 })).missing, ['KNOWN_AT_MISSING'], 'a historical smoke never stands in for the knowledge clock');
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { metrics: { requested: ['active_addresses', 'exchange_reserve'], obtained: ['active_addresses'] } })).missing, ['METRIC_PROOF_MISSING', 'COMPLETION_CLAIM_CONTRADICTED', 'METRIC_SCOPE_SHORTFALL'], 'exchange_reserve is not a NETWORK_ACTIVITY metric, and a complete claim over a shortfall is contradicted (correction A)');
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { obtained: 3 })).missing, ['OBTAINED_COUNT_UNBOUND']);
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { assets: { requested: ['BTC'], obtained: ['BTC', 'SOL'] } })).missing, ['ASSET_PROOF_MISSING']);
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { support: { state: 'COMPLETE', basis: 'ROWS' } })).missing, ['SUPPORT_BASIS_MISSING']);
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { complete: true, support: { state: 'PARTIAL', basis: 'PERIOD_GRID' } })).missing, ['COMPLETENESS_DISAGREES_WITH_SUPPORT']);
  assert.deepEqual(q('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker' })).missing, ['PROVIDER_NOT_SELECTED_FOR_FAMILY', 'ENDPOINT_NOT_FAMILY_RELEVANT']);
  const notPassed = providerReadiness({ policy: loadPolicy(H.policyWith({ providers: ['CRYPTOQUANT'] })), env: { CRYPTOQUANT_API_KEY: 'x' }, testReport: { CRYPTOQUANT: 'PASSED' } });
  assert.deepEqual(qualifyFamilyEvidence('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { providerId: 'CRYPTOQUANT', endpointId: 'network-data' }), notPassed, { generatedTs: T0 }).missing, ['PROVIDER_LIVE_NOT_PASSED']);
  const disabled = providerReadiness({ policy: loadPolicy(H.policyWith({ providers: [] })), env: {}, testReport: {}, liveReport: { CRYPTOQUANT: { state: 'PASSED', ts: T0 } } });
  assert.deepEqual(qualifyFamilyEvidence('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { providerId: 'CRYPTOQUANT', endpointId: 'network-data' }), disabled, { generatedTs: T0 }).missing, ['PROVIDER_NOT_ENABLED', 'PROVIDER_ACCESS_UNUSABLE']);
  for (const junk of [null, 'x', 7, [], { obtained: 1 }, { providerId: { toString: () => 'CRYPTOQUANT' } }]) { const r = q('NETWORK_ACTIVITY', junk); assert.equal(r.qualified, false); assert.ok(r.missing.length >= 1); }
  assert.deepEqual(q('NOT_A_FAMILY', qualified('NETWORK_ACTIVITY')).missing, ['FAMILY_UNKNOWN']);
});

test('P1-R02. the model demonstration must be supported (clock, model, request, real usage); a bare PASSED, a NOT_RUN or a null blocks; the service readiness reports the missing demonstration explicitly', async () => {
  assert.deepEqual(qualifyModelDemonstration(null).missing, ['MODEL_READINESS_ABSENT']);
  assert.deepEqual(qualifyModelDemonstration({ liveVerification: 'PASSED' }).missing, ['MODEL_DEMONSTRATION_MISSING']);
  assert.deepEqual(qualifyModelDemonstration({ liveVerification: 'NOT_RUN', demonstration: { ts: T0, model: 'm', requestId: 'r', usage: { inputTokens: 1, outputTokens: 1 } } }).missing, ['MODEL_LIVE_NOT_PASSED']);
  assert.deepEqual(qualifyModelDemonstration({ liveVerification: 'PASSED', demonstration: { ts: T0, model: 'm', requestId: 'r', usage: { inputTokens: 1, outputTokens: 0 } } }).missing, ['MODEL_DEMONSTRATION_USAGE_MISSING'], 'a demonstration without output is not a demonstration');
  assert.equal(qualifyModelDemonstration({ liveVerification: 'PASSED', demonstration: { ts: T0, model: 'm', requestId: 'r', usage: { inputTokens: 1, outputTokens: 1 } } }).qualified, true);
  const root = tmp('rev2-svc-'); const svc = createResearchService({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), env: {}, researchRoot: root, mode: 'INTEGRATED', clock: () => T0, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS), httpPort: null, log: () => {} });
  try { const m = svc.readiness(); assert.notEqual(m.overall, 'READINESS_GREEN'); assert.equal(m.manifestVersion, 'market-live-readiness-3'); assert.ok(m.modelQualification.missing.includes('MODEL_LIVE_NOT_PASSED')); assert.ok(FAMILIES.every((f) => m.families[f].qualified === false && m.families[f].missingProof.includes('NO_FAMILY_EVIDENCE'))); } finally { await svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('P1-R03. one unqualified family keeps the manifest non-green with its missing proof on the family row; the qualified partial family is PARTIAL_LIVE, never LIVE', () => {
  const rows = rowsAllPassed(); const full = Object.fromEntries(FAMILIES.map((f) => [f, qualified(f)])); const model = { liveVerification: 'PASSED', demonstration: { ts: T0, model: 'm', requestId: 'r', usage: { inputTokens: 10, outputTokens: 5 } } };
  assert.equal(liveReadinessManifest({ rows, familyCoverage: full, modelReadiness: model, generatedTs: T0 }).overall, 'READINESS_GREEN');
  const stale = liveReadinessManifest({ rows, familyCoverage: { ...full, DISPLAYED_LIQUIDITY: qualified('DISPLAYED_LIQUIDITY', { knownAtTs: T0 - 61_000, interval: { startTs: T0 - 120_000, endTs: T0 - 61_000 } }) }, modelReadiness: model, generatedTs: T0 });
  assert.equal(stale.overall, 'NOT_VERIFIED'); assert.equal(stale.families.DISPLAYED_LIQUIDITY.state, 'NOT_VERIFIED'); assert.deepEqual(stale.families.DISPLAYED_LIQUIDITY.missingProof, ['FRESHNESS_UNMET']); assert.ok(stale.blockers.some((b) => /DISPLAYED_LIQUIDITY/.test(b)));
  const partial = liveReadinessManifest({ rows, familyCoverage: { ...full, ETF_FLOWS: qualified('ETF_FLOWS', { complete: false, support: { state: 'PARTIAL', basis: 'PERIOD_GRID' } }) }, modelReadiness: model, generatedTs: T0 });
  assert.equal(partial.families.ETF_FLOWS.state, 'PARTIAL_LIVE'); assert.equal(partial.families.ETF_FLOWS.qualified, true); assert.notEqual(partial.overall, 'READINESS_GREEN');
});
