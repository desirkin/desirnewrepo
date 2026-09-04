// RUMINT-R1 lifecycle drills — the poller against injected provider, clock
// and durable store: the durable init gate, republish signal parity, the
// one-time Memory bootstrap, pending evidence debt, nomination-before-stalk,
// no stalking resurrection, CANCEL shutdown, bounded failure recovery, 429
// and budget persistence, the canonical HYPED session lifecycle, and the
// FAILED_DURABILITY boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, rmdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.setMaxListeners(80);
process.env.RUMINT_ENABLED = 'true'; // every network touch below is an injected fake

const { startRumint } = await import('../rumint/poller.js');
const { signalFromBaseline, COVERAGE_BOOTSTRAPPED } = await import('../rumint/truth.js');
const { readStalking } = await import('../state/stalking.js');
const { attentionSnapshot } = await import('../ui/attention-view.js');

test.after(() => {
  delete process.env.RUMINT_ENABLED;
});

const CFG = (coins = ['BTC']) => ({
  universe: coins,
  rumint: { enabled: true, zThreshold: 3, stalkTtlMin: 60, pollHotSec: 300, pollWarmSec: 1200, hourlyBudget: 500, spacingMs: 1, backoffMin: 15 },
});

const dirs = [];
function freshDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-rr-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const statusOf = (d) => JSON.parse(readFileSync(path.join(d, 'rumint', 'status.json'), 'utf8'));
const eventLines = (d) => {
  const f = path.join(d, 'rumint', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const linesOf = (d, type) => eventLines(d).filter((e) => e.type === type);

// tri-state in-memory durable store with induced failures
function memStore() {
  return {
    state: null,
    failLoad: false,
    failSave: false,
    async load() {
      if (this.failLoad) return { outcome: 'UNAVAILABLE', error: 'induced load failure' };
      return this.state === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(this.state) };
    },
    async save(s) {
      if (this.failSave) return { durable: false, reason: 'UNAVAILABLE' };
      this.state = structuredClone(s);
      return { durable: true };
    },
  };
}

const page = (messages, cursor) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => (cursor ? { messages, cursor } : { messages }) });
const msg = (id, atMs, sentiment = null) => ({ id, created_at: new Date(atMs).toISOString(), entities: { sentiment: { basic: sentiment } } });

// scripted fetch: shift the next response (a function of the current call) off a queue
function scriptedFetch(queue) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(url);
    const next = queue.shift();
    if (!next) throw new Error('unscripted fetch: ' + url);
    const out = typeof next === 'function' ? next() : next;
    if (out instanceof Error) throw out;
    return out;
  };
  impl.calls = calls;
  return impl;
}

// Build a mature observed baseline in collector r: one poll per hour with
// alternating 9/11 accepted messages (variance without nomination).
async function buildHistory(r, clockRef, queue, { hours = 27, startId = 1000 } = {}) {
  let id = startId;
  for (let h = 0; h < hours; h++) {
    clockRef.ms += 3_600_000;
    const n = queue.watermark === false && h === 0 ? 0 : h % 2 === 0 ? 9 : 11;
    const msgs = Array.from({ length: n }, () => msg(id++, clockRef.ms - 60_000));
    queue.push(page(msgs));
    await r.tickOnce();
  }
  return id;
}

const T0 = Date.parse('2026-09-02T12:30:00Z'); // 08:30 ET — daytime, HYPED finalizes as coverage allows

// ---------------------------------------------------------------------------
test('R-init §11/§70: configured-but-unreachable durable truth WITHHOLDS — never a silently empty baseline', async () => {
  const d = freshDir();
  const store = memStore();
  store.failLoad = true;
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, 0, 'no polling without initialized statistical authority');
  assert.equal(statusOf(d).status, 'WITHHELD_DURABLE_UNAVAILABLE');
  assert.equal(statusOf(d).initState, 'WITHHELD_DURABLE_UNAVAILABLE');
  assert.ok(!existsSync(path.join(d, 'rumint', 'checkpoint.json')), 'no checkpoint save while withheld');
  // the durable core recovers -> initialization retries and polling begins
  store.failLoad = false;
  clock.ms += 5000;
  queue.push(page([msg(50, clock.ms - 60_000)]));
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(statusOf(d).initState, 'FRESH_START');
  await r.stop();
});

test('R-init §10: a malformed durable checkpoint is WITHHELD and named, then a repaired one adopts', async () => {
  const d = freshDir();
  const store = memStore();
  store.state = { version: 99, garbage: true };
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  await r.tickOnce();
  assert.equal(statusOf(d).status, 'WITHHELD_INVALID_CHECKPOINT');
  assert.equal(fetchImpl.calls.length, 0);
  store.state = null; // repaired to an honest NOT_FOUND
  clock.ms += 5000;
  queue.push(page([]));
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, 1);
  await r.stop();
});

// ---------------------------------------------------------------------------
test('R-parity §68: a republish restores the exact statistical state — same z, same acceleration, same nomination', async () => {
  const dA = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  queue.watermark = true;
  const fetchImpl = scriptedFetch(queue);
  const a = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(999, clock.ms - 60_000)])); // watermark init poll
  await a.tickOnce();
  const lastId = await buildHistory(a, clock, queue, { hours: 27 });
  const preStop = structuredClone(store.state);
  await a.stop();
  assert.ok(Object.keys(preStop.baselines['BTC.X'].buckets).length >= 25);

  // brand-new VM: EMPTY local disk, same durable core
  const dB = freshDir();
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl: scriptedFetch(queue), now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 3_600_000;
  const spike = Array.from({ length: 40 }, (_, i) => msg(lastId + i, clock.ms - 60_000));
  queue.push(page(spike));
  await b.tickOnce();
  assert.equal(statusOf(dB).initState, 'RESTORED_DURABLE');
  const polls = linesOf(dB, 'RUMINT_POLL');
  const p = polls.at(-1);
  // the restored history is the exact pre-stop history
  const expected = signalFromBaseline(store.state.baselines['BTC.X'], clock.ms, { zThreshold: 3 });
  assert.equal(p.historyBucketCount, expected.historyBucketCount);
  assert.equal(p.z, expected.zVelocity);
  assert.equal(p.acceleration, expected.acceleration);
  assert.ok(p.z >= 3, `restored maturity nominates: z=${p.z}`);
  assert.equal(p.decision, 'NOMINATED');
  assert.equal(linesOf(dB, 'RUMINT_NOMINATION').length, 1);
  const nom = linesOf(dB, 'RUMINT_NOMINATION')[0];
  assert.equal(nom.pollSourceEventId, p.sourceEventId);
  assert.notEqual(nom.sourceEventId, p.sourceEventId); // linked, never collapsed
  assert.ok(readStalking(clock.ms).BTC, 'nomination armed transient stalking');
  await b.stop();
});

// ---------------------------------------------------------------------------
test('R-bootstrap §13-15/§69/§95: NOT_FOUND + durable poll Memory -> proven facts only, watermark stays unknown', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  // durable RUMINT_POLL evidence: BTC 30 observed hours (ready), ETH 12 (warming)
  const facts = [];
  for (let h = 2; h < 32; h++) facts.push({ providerSymbol: 'BTC.X', hourTsSec: Math.floor((T0 - h * 3_600_000) / 3_600_000) * 3600, velocity: h % 2 === 0 ? 9 : 11 });
  for (let h = 2; h < 14; h++) facts.push({ providerSymbol: 'ETH.X', hourTsSec: Math.floor((T0 - h * 3_600_000) / 3_600_000) * 3600, velocity: 5 });
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({
    log: () => {},
    config: CFG(['BTC', 'ETH']),
    fetchImpl,
    now: () => clock.ms,
    intervalMs: 3_600_000,
    checkpointStore: store,
    memoryBootstrapSource: async () => facts,
  });
  clock.ms += 5000;
  // first live page: 30 already-existing messages — a watermark-only start
  queue.push(page(Array.from({ length: 30 }, (_, i) => msg(7000 + i, clock.ms - 120_000))));
  await r.tickOnce();
  const st = statusOf(d);
  assert.equal(st.initState, 'BOOTSTRAPPED_FROM_DURABLE_RUMINT_POLL');
  assert.equal(st.symbols.BTC, 'READY', 'durable history alone proves maturity'); // §95 classification
  assert.equal(st.symbols.ETH, 'WARMING_HISTORY');
  const p1 = linesOf(d, 'RUMINT_POLL')[0];
  assert.equal(p1.watermarkInitialized, true);
  assert.equal(p1.accepted, 0, 'the pre-existing page is never fresh chatter');
  assert.equal(linesOf(d, 'RUMINT_NOMINATION').length, 0, 'no retroactive nominations');
  const bB = r.internals.baselines['BTC.X'];
  const boot = Object.values(bB.buckets).filter((x) => x.coverage === COVERAGE_BOOTSTRAPPED);
  assert.ok(boot.length >= 30);
  assert.ok(boot.every((x) => x.bull === null && x.bear === null), 'bull/bear honestly unavailable for bootstrapped history');
  // ETH's watermark initializes on its own first page
  clock.ms += 5_000;
  queue.push(page([]));
  await r.tickOnce();
  // next BTC poll (after the hot cadence): exactly one genuinely new message counts
  clock.ms += 310_000;
  queue.push(page([msg(9001, clock.ms - 30_000)]));
  await r.tickOnce();
  const p2 = linesOf(d, 'RUMINT_POLL').filter((x) => x.providerSymbol === 'BTC.X').at(-1);
  assert.equal(p2.accepted, 1);
  assert.equal(p2.watermarkInitialized, false);
  await r.stop();
});

// ---------------------------------------------------------------------------
test('R-atrisk §12/§71: local success never hides a durable miss — AT_RISK degrades, recovery restores', async () => {
  const d = freshDir();
  const store = memStore();
  store.failSave = true;
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(11, clock.ms - 60_000)]));
  await r.tickOnce();
  let st = statusOf(d);
  assert.equal(st.localDurability, 'SAVED');
  assert.equal(st.deploymentDurability, 'AT_RISK');
  assert.notEqual(st.status, 'HEALTHY');
  store.failSave = false;
  clock.ms += 310_000;
  queue.push(page([]));
  await r.tickOnce();
  st = statusOf(d);
  assert.equal(st.deploymentDurability, 'DURABLE');
  assert.equal(st.status, 'HEALTHY');
  assert.ok(store.state.baselines['BTC.X'], 'latest checkpoint became durable');
  await r.stop();
});

// ---------------------------------------------------------------------------
test('R-debt §44/§83: owed evidence replays with its EXACT identity, once, and never re-advances the baseline', async () => {
  const dA = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const a = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(21, clock.ms - 60_000)]));
  await a.tickOnce(); // healthy poll creates the events file
  // break the source writer: events.jsonl becomes a directory
  const ev = path.join(dA, 'rumint', 'events.jsonl');
  renameSync(ev, ev + '.orig');
  mkdirSync(ev);
  clock.ms += 310_000;
  queue.push(page([msg(22, clock.ms - 30_000)]));
  await a.tickOnce();
  assert.equal(a.internals.pending.length, 1, 'the failed append became owed debt');
  const owed = structuredClone(a.internals.pending[0].record);
  assert.equal(store.state.pendingEvents.length, 1, 'debt is durably checkpointed');
  const revBefore = store.state.baselines['BTC.X'].baselineRevision;
  await a.stop();

  // restart on a fresh VM with a healthy writer
  const dB = freshDir();
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl: scriptedFetch([page([])]), now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 10_000;
  await b.tickOnce();
  const replayed = eventLines(dB).filter((e) => e.sourceEventId === owed.sourceEventId);
  assert.equal(replayed.length, 1, 'the exact owed event wrote exactly once');
  assert.deepEqual(replayed[0], owed, 'no regenerated timestamp, no altered content');
  assert.equal(b.internals.pending.length, 0);
  assert.equal(store.state.baselines['BTC.X'].baselineRevision, revBefore + 1, 'replay itself never re-advances the baseline (only the new live poll did)');
  await b.stop();
});

// ---------------------------------------------------------------------------
test('R-nom §47/§80: an unrecorded nomination NEVER arms stalking; it arms only after its evidence lands', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(999, clock.ms - 60_000)]));
  await r.tickOnce(); // watermark init
  const lastId = await buildHistory(r, clock, queue, { hours: 27, startId: 2000 });
  assert.deepEqual(readStalking(clock.ms), {}, 'no stalking during warm-up');
  // break the writer, then serve a nominating spike
  const ev = path.join(d, 'rumint', 'events.jsonl');
  renameSync(ev, ev + '.orig');
  mkdirSync(ev);
  clock.ms += 3_600_000;
  queue.push(page(Array.from({ length: 40 }, (_, i) => msg(lastId + i, clock.ms - 60_000))));
  await r.tickOnce();
  assert.deepEqual(readStalking(clock.ms), {}, 'nomination evidence unrecorded -> stalking NOT armed');
  const owedNom = r.internals.pending.find((p) => p.kind === 'NOMINATION');
  assert.ok(owedNom, 'the nomination is owed debt, not lost');
  // writer recovers in the SAME process: the owed nomination lands, THEN stalking arms
  rmdirSync(ev);
  renameSync(ev + '.orig', ev);
  clock.ms += 10_000;
  queue.push(page([]));
  await r.tickOnce();
  assert.equal(linesOf(d, 'RUMINT_NOMINATION').filter((e) => e.sourceEventId === owedNom.record.sourceEventId).length, 1);
  assert.ok(readStalking(clock.ms).BTC, 'stalking armed only after the evidence landed');
  await r.stop();
});

// ---------------------------------------------------------------------------
test('R-restalk §46/§81: a republish never resurrects stalking from historical nomination evidence', async () => {
  const dA = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const a = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(999, clock.ms - 60_000)]));
  await a.tickOnce();
  const lastId = await buildHistory(a, clock, queue, { hours: 27, startId: 3000 });
  clock.ms += 3_600_000;
  queue.push(page(Array.from({ length: 40 }, (_, i) => msg(lastId + i, clock.ms - 60_000))));
  await a.tickOnce();
  assert.ok(readStalking(clock.ms).BTC, 'nomination stalked in the first life');
  await a.stop();

  const dB = freshDir(); // republish: stalking.json is gone with the old disk
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl: scriptedFetch([page([])]), now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 2 * 3_600_000; // a later, quiet hour — historical evidence alone must not re-arm
  await b.tickOnce();
  assert.equal(statusOf(dB).initState, 'RESTORED_DURABLE');
  assert.ok(Object.keys(b.internals.baselines['BTC.X'].buckets).length >= 25, 'historical baseline restored');
  assert.deepEqual(readStalking(clock.ms), {}, 'stalking did NOT resurrect');
  assert.equal(linesOf(dB, 'RUMINT_NOMINATION').length, 0, 'no re-emitted nomination');
  await b.stop();
});

// ---------------------------------------------------------------------------
test('R-stop §55/§56: CANCEL shutdown — a response landing after stop mutates nothing', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  let release;
  const gate = new Promise((res) => (release = res));
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    await gate;
    return page([msg(31, clock.ms - 60_000)]);
  };
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  const tickP = r.tickOnce(); // fetch hangs unresolved
  while (fetches === 0) await new Promise((res) => setImmediate(res));
  await r.stop(); // stopped set FIRST, in-flight work cancelled, final checkpoint saved
  const finalState = structuredClone(store.state);
  release(); // the provider answers AFTER shutdown completed
  await tickP;
  assert.equal(linesOf(d, 'RUMINT_POLL').length, 0, 'no source event after completed shutdown');
  assert.deepEqual(r.internals.baselines, {}, 'no baseline mutation after completed shutdown');
  assert.deepEqual(readStalking(clock.ms), {}, 'no stalking after completed shutdown');
  assert.deepEqual(store.state, finalState, 'no pending debt or state added after the final checkpoint');
});

// ---------------------------------------------------------------------------
test('R-recover §48/§49/§76: three failures mean a bounded cooldown and a probe — never permanent deafness', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  for (let i = 0; i < 3; i++) {
    clock.ms += 310_000;
    queue.push(new Error('ECONNRESET induced'));
    await r.tickOnce();
  }
  let st = statusOf(d);
  assert.equal(st.symbols.BTC, 'TEMPORARILY_UNAVAILABLE');
  const unav = linesOf(d, 'RUMINT_UNAVAILABLE')[0];
  assert.equal(unav.cooldownMin, 15);
  // inside the cooldown the symbol is not polled
  clock.ms += 60_000;
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, 3);
  // the cooldown state survives a republish — publishing never erases failure history
  await r.stop();
  const d2 = freshDir();
  const q2 = [];
  const f2 = scriptedFetch(q2);
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl: f2, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 60_000;
  await b.tickOnce();
  assert.equal(f2.calls.length, 0, 'cooldown persisted across republish');
  assert.equal(statusOf(d2).symbols.BTC, 'TEMPORARILY_UNAVAILABLE');
  // cooldown expires -> one probe; success clears the streak and records RECOVERED
  clock.ms += 15 * 60_000;
  q2.push(page([msg(41, clock.ms - 60_000)]));
  await b.tickOnce();
  assert.equal(f2.calls.length, 1);
  assert.equal(linesOf(d2, 'RUMINT_RECOVERED').length, 1);
  assert.notEqual(statusOf(d2).symbols.BTC, 'TEMPORARILY_UNAVAILABLE');
  await b.stop();
});

test('R-429 §50/§77: Retry-After honored within bounds and the global backoff survives republish', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const err429 = Object.assign(new Error('stocktwits BTC.X -> HTTP 429'), { status: 429, retryAfterMs: 300_000 });
  const queue = [err429];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  await r.tickOnce();
  assert.equal(r.budget.backoffUntil, clock.ms + 300_000, 'Retry-After honored (within hard bounds)');
  assert.equal(linesOf(d, 'RUMINT_BACKOFF')[0].retryAfterHonored, true);
  clock.ms += 60_000;
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, 1, 'no requests during backoff');
  const stampsBefore = r.budget.hourCount(clock.ms);
  await r.stop();
  // republish: the in-memory 429 timer must NOT vanish
  freshDir();
  const q2 = [];
  const f2 = scriptedFetch(q2);
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl: f2, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 60_000;
  await b.tickOnce();
  assert.equal(f2.calls.length, 0, 'restored backoff still blocks');
  assert.ok(b.budget.backoffUntil > clock.ms);
  assert.equal(b.budget.hourCount(clock.ms), stampsBefore, 'rolling request budget restored (§51)');
  clock.ms += 300_000;
  q2.push(page([]));
  await b.tickOnce();
  assert.equal(f2.calls.length, 1, 'normal polling resumes after the persisted backoff');
  await b.stop();
});

// ---------------------------------------------------------------------------
test('R-total §84: source + local + durable all failing is FAILED_DURABILITY with visible unpersisted evidence', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(51, clock.ms - 60_000)]));
  await r.tickOnce(); // one healthy tick so files exist
  // now break EVERYTHING
  const ev = path.join(d, 'rumint', 'events.jsonl');
  renameSync(ev, ev + '.orig');
  mkdirSync(ev);
  const cp = path.join(d, 'rumint', 'checkpoint.json');
  rmSync(cp);
  mkdirSync(cp);
  store.failSave = true;
  clock.ms += 310_000;
  queue.push(page([msg(52, clock.ms - 30_000)]));
  await r.tickOnce();
  const st = statusOf(d);
  assert.equal(st.status, 'FAILED_DURABILITY');
  assert.ok(st.unpersistedPendingEvidence > 0, 'RAM-only evidence is declared, never claimed durable');
  assert.equal(st.localDurability, 'FAILED');
  assert.equal(st.deploymentDurability, 'AT_RISK');
  await r.stop();
});

// ---------------------------------------------------------------------------
test('R-hyped §34-§43/§61-§65: ONE canonical HYPED snapshot — building, finalize, contradiction repair, restart dedupe, rollover', async () => {
  const d = freshDir();
  const store = memStore();
  // 2026-09-02 EDT: overnight ET hours 00-05 are 04:00Z-09:59Z
  const clock = { ms: Date.parse('2026-09-02T04:10:00Z') };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  // observe ALL six overnight ET hours with ZERO accepted messages
  queue.push(page([msg(60, clock.ms - 120_000)])); // watermark init during hour 0
  await r.tickOnce();
  for (let h = 1; h < 6; h++) {
    clock.ms = Date.parse('2026-09-02T04:10:00Z') + h * 3_600_000;
    queue.push(page([]));
    await r.tickOnce();
  }
  const hypedFile = () => JSON.parse(readFileSync(path.join(d, 'rumint', 'hyped.json'), 'utf8'));
  assert.equal(statusOf(d).hyped.state, 'BUILDING', 'overnight window open: BUILDING, never promoted');
  assert.equal(hypedFile().state, 'BUILDING');
  // 06:10 ET: finalize. Full coverage, zero chatter -> a REAL H0 (EMPTY).
  clock.ms = Date.parse('2026-09-02T10:10:00Z');
  queue.push(page([]));
  await r.tickOnce();
  let st = statusOf(d);
  assert.equal(st.hyped.state, 'EMPTY');
  assert.deepEqual(st.hyped.symbols, []);
  assert.deepEqual(hypedFile().symbols, []);
  assert.equal(hypedFile().identity, st.hyped.identity, 'status and file carry the SAME canonical snapshot');
  const emptyEvents = linesOf(d, 'HYPED_SESSION');
  assert.equal(emptyEvents.length, 1);
  assert.equal(emptyEvents[0].state, 'EMPTY');
  // §62 the Production contradiction, repaired: late overnight evidence
  // arrives AFTER the first (empty) computation — every consumer must move
  // to the same new truth together, and the stale empty file must not remain
  clock.ms = Date.parse('2026-09-02T11:10:00Z');
  queue.push(page([msg(61, Date.parse('2026-09-02T08:30:00Z'))])); // late msg inside an OBSERVED overnight hour
  await r.tickOnce();
  clock.ms += 5_000; // the canonical snapshot re-rolls on the next tick, everywhere at once
  await r.tickOnce();
  st = statusOf(d);
  assert.equal(st.hyped.state, 'READY');
  assert.deepEqual(st.hyped.symbols, ['BTC']); // header H1...
  assert.deepEqual(hypedFile().symbols, ['BTC']); // ...file agrees...
  assert.equal(hypedFile().identity, st.hyped.identity);
  const att = await attentionSnapshot({ now: clock.ms, config: CFG(), memorySource: async () => [] });
  assert.ok(att.orbit.some((e) => e.symbol === 'BTC' && e.tier === 3 && e.kind === 'HYPED'), '...and Attention Tier-3 agrees');
  const readyEvents = linesOf(d, 'HYPED_SESSION');
  assert.equal(readyEvents.length, 2);
  assert.notEqual(readyEvents[1].sourceEventId, readyEvents[0].sourceEventId, 'a different set is new evidence');
  const readyIdentity = readyEvents[1].sourceEventId;
  await r.stop();

  // §65 same-date restart: same set restored, NO duplicate HYPED event
  const d2 = freshDir();
  const q2 = [];
  const b = startRumint({ log: () => {}, config: CFG(), fetchImpl: scriptedFetch(q2), now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 10_000;
  q2.push(page([]));
  await b.tickOnce();
  const st2 = statusOf(d2);
  assert.equal(st2.hyped.state, 'READY');
  assert.deepEqual(st2.hyped.symbols, ['BTC']);
  assert.equal(st2.hyped.identity, readyIdentity, 'stable identity across restart');
  assert.equal(linesOf(d2, 'HYPED_SESSION').length, 0, 'no duplicate HYPED event on the same finalized session');
  // §64 rollover: the next ET date goes back to BUILDING — yesterday's HYPED is not today's
  clock.ms = Date.parse('2026-09-03T04:30:00Z'); // 00:30 ET on 09-03
  q2.push(page([]));
  await b.tickOnce();
  const st3 = statusOf(d2);
  assert.equal(st3.hyped.state, 'BUILDING');
  assert.equal(st3.hyped.sessionDate, '2026-09-03');
  assert.deepEqual(st3.hyped.symbols, []);
  const att2 = await attentionSnapshot({ now: clock.ms, config: CFG(), memorySource: async () => [] });
  assert.ok(!att2.orbit.some((e) => e.kind === 'HYPED'), 'no HYPED attention while BUILDING');
  await b.stop();
});

// ---------------------------------------------------------------------------
test('R-cursor §28-§30: bounded continuation pages to the previous boundary via the provider\'s OWN cursor', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const sleeps = [];
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, sleepImpl: async (ms) => { sleeps.push(ms); clock.ms += ms; }, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(100, clock.ms - 120_000)], { more: true, since: 100, max: 100 })); // watermark init: ONE page by design
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, 1, 'unknown watermark never paginates');
  // a burst: provider holds 101..165 (65 new messages, 3 pages deep)
  clock.ms += 310_000;
  const mk = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => msg(hi - i, clock.ms - 60_000)).map((m) => m);
  queue.push(page(mk(136, 165), { more: true, since: 165, max: 136 }));
  queue.push(page(mk(106, 135), { more: true, since: 135, max: 106 }));
  // the third page reaches ids <= 100: boundary proven (old ids are ancient replay here)
  queue.push(page([...mk(101, 105), ...Array.from({ length: 5 }, (_, i) => msg(96 + i, clock.ms - 30 * 3_600_000))], { more: true, since: 105, max: 76 }));
  await r.tickOnce();
  assert.equal(fetchImpl.calls.length, 4, 'continuation spent one budgeted request per page');
  assert.ok(fetchImpl.calls[2].includes('max=136') && fetchImpl.calls[3].includes('max=106'), 'the documented ?max cursor, never an invented parameter');
  assert.equal(sleeps.length, 2, 'the politeness floor holds between continuation pages');
  const p = linesOf(d, 'RUMINT_POLL').at(-1);
  assert.equal(p.coverage, 'COMPLETE_TO_WATERMARK');
  assert.equal(p.pagesFetched, 3);
  assert.equal(p.accepted, 65, 'the full burst was captured, no silent 101/102 gap');
  assert.equal(p.ancientRejected, 4); // ids 96-99 are ancient replay; id 100 was already seen at watermark init
  assert.equal(r.budget.hourCount(clock.ms), 4);
  // an endless provider tail hits the hard page cap and says so
  clock.ms += 310_000;
  for (let i = 0; i < 4; i++) queue.push(page(mk(900 + i * 30, 929 + i * 30), { more: true, since: 999, max: 900 + i * 30 }));
  await r.tickOnce();
  const p2 = linesOf(d, 'RUMINT_POLL').at(-1);
  assert.equal(p2.coverage, 'SAMPLED_PAGE_CAP');
  assert.equal(p2.pagesFetched, 4);
  await r.stop();
});

// ---------------------------------------------------------------------------
test('R-raw §32/§33/§75/§78: the RAW StockTwits shape drives the real poll path; schema failure is never observed-zero', async () => {
  const d = freshDir();
  const store = memStore();
  const clock = { ms: T0 };
  const queue = [];
  const fetchImpl = scriptedFetch(queue);
  const r = startRumint({ log: () => {}, config: CFG(), fetchImpl, now: () => clock.ms, intervalMs: 3_600_000, checkpointStore: store });
  clock.ms += 5000;
  queue.push(page([msg(100, clock.ms - 3_600_000)])); // watermark init at id 100
  await r.tickOnce();
  clock.ms += 310_000;
  // raw provider page: Bullish, Bearish, unlabeled, duplicate, old/seen, malformed, ancient
  queue.push(page([
    { id: 105, created_at: new Date(clock.ms - 60_000).toISOString(), entities: { sentiment: { basic: 'Bullish' } } },
    { id: 104, created_at: new Date(clock.ms - 90_000).toISOString(), entities: { sentiment: { basic: 'Bearish' } } },
    { id: 103, created_at: new Date(clock.ms - 120_000).toISOString(), entities: { sentiment: null } },
    { id: 105, created_at: new Date(clock.ms - 60_000).toISOString(), entities: { sentiment: { basic: 'Bullish' } } }, // same-page dup
    { id: 100, created_at: new Date(clock.ms - 3_600_000).toISOString() }, // already seen at watermark init
    { id: 'not-an-id', created_at: new Date(clock.ms - 60_000).toISOString() },
    { id: 106, created_at: new Date(clock.ms - 30 * 3_600_000).toISOString() }, // ancient replay
  ]));
  await r.tickOnce();
  const p = linesOf(d, 'RUMINT_POLL').at(-1);
  assert.equal(p.messagesReturned, 7);
  assert.equal(p.accepted, 3);
  assert.equal(p.duplicateSamePage, 1);
  assert.equal(p.alreadySeen, 1);
  assert.equal(p.invalidId, 1);
  assert.equal(p.ancientRejected, 1);
  assert.equal(p.decision, 'INSUFFICIENT_HISTORY'); // pinned reason, not silence
  const bucket = Object.values(r.internals.baselines['BTC.X'].buckets).find((x) => x.count === 3);
  assert.equal(bucket.bull, 1);
  assert.equal(bucket.bear, 1);
  // HTTP 200 with an unusable body: PROVIDER_SCHEMA_ERROR, never a quiet hour
  clock.ms += 3 * 3_600_000; // a fresh, never-observed hour
  queue.push({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ nonsense: true }) });
  await r.tickOnce();
  const fail = linesOf(d, 'RUMINT_POLL_FAILED').at(-1);
  assert.equal(fail.classification, 'PROVIDER_SCHEMA_ERROR');
  assert.equal(statusOf(d).providerSchemaFailures, 1);
  const hourKey = new Date(clock.ms).toISOString().slice(0, 13);
  assert.equal(r.internals.baselines['BTC.X'].buckets[hourKey], undefined, 'no observed-zero hour from malformed data');
  await r.stop();
});
