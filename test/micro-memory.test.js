// MICRO-1 memory drills — the canonical adapter, bus/store acceptance,
// deterministic identity, and the dark-sense guarantee: observations change
// NOTHING about trading state. MICRO listens and remembers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-micromem-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { fromMicrostructureObservation } = await import('../memory/adapters.js');
const { validateEnvelope } = await import('../memory/validate.js');
const { MemoryStore } = await import('../memory/store.js');
const { MemoryBus } = await import('../memory/bus.js');
const { MicrostructureTracker } = await import('../tape/microstructure.js');

const NOW = 1_800_000_000_000;
const lvl = (price, qty) => ({ price, qty });
function fakeBook({ bids, asks, ts = NOW }) {
  const sb = [...bids].sort((a, b) => b.price - a.price);
  const sa = [...asks].sort((a, b) => a.price - b.price);
  return { synced: true, depth: 25, lastUpdateTs: ts, sortedBids: () => sb, sortedAsks: () => sa, bestBid: () => sb[0], bestAsk: () => sa[0] };
}

// one REAL observation, built by the real tracker (fresh book + history)
function buildObservation() {
  const tr = new MicrostructureTracker({ bookStaleMs: 15_000 });
  tr.setTrackingSet(new Set(['SOL/USD']), NOW - 70_000);
  const book = fakeBook({ bids: [lvl(99.99, 50), lvl(99.5, 80)], asks: [lvl(100.01, 50), lvl(100.5, 80)], ts: NOW });
  tr.onBook('SOL/USD', book, NOW - 65_000);
  tr.onBook('SOL/USD', book, NOW - 30_000);
  tr.onBook('SOL/USD', book, NOW);
  tr.onTrade('SOL/USD', { ts: NOW - 5_000, side: 'buy', qty: 2, price: 100 }, NOW);
  tr.onTrade('SOL/USD', { ts: NOW - 3_000, side: 'sell', qty: 1, price: 99.99 }, NOW);
  const obs = tr.observe('SOL/USD', book, 'SOL', NOW);
  assert.ok(obs, 'tracker produced an observation');
  return obs;
}

test('33a. canonical adapter succeeds; families and provenance are correct', () => {
  const obs = buildObservation();
  const env = fromMicrostructureObservation(obs, new Date(NOW + 1000).toISOString());
  const v = validateEnvelope(env);
  assert.deepEqual(v.errors, []);
  assert.equal(env.sourceModule, 'MICROSTRUCTURE'); // accepted sourceModule
  assert.equal(env.eventType, 'MICROSTRUCTURE_OBSERVATION');
  assert.equal(env.symbol, 'SOL');
  assert.ok(env.evidenceFamily.includes('ORDER_FLOW'));
  assert.ok(env.evidenceFamily.includes('LIQUIDITY'));
  // real measured price response present => MARKET_PRICE joins
  assert.ok(env.evidenceFamily.includes('MARKET_PRICE'));
  assert.equal(env.observationState, 'KNOWN');
  // provenance complete enough to reconstruct meaning
  assert.ok(env.provenance.source.includes('micro/observations.jsonl'));
  const p = env.payload.provenance;
  assert.ok(p.tradeChannel.includes('kraken-ws-v2 trade'));
  assert.ok(p.bookChannel.includes('kraken-ws-v2 book'));
  assert.deepEqual(p.flowWindowsMs, [5000, 15000, 60000, 300000]);
  assert.ok(env.payload.limitations.includes('AGGREGATE_L2_UNATTRIBUTED'));
  assert.equal(env.payload.trackerVersion, 'MICRO-1C');
  // availability language preserved — insufficient history was never zeroed
  assert.ok(['KNOWN', 'UNKNOWN', 'UNAVAILABLE', 'STALE', 'DEGRADED'].includes(env.dataAvailability.recoveryAsymmetry));
});

test('33b. MARKET_PRICE only where price response is actually measured; STALE degrades', () => {
  const obs = buildObservation();
  const stale = { ...obs, bookState: 'STALE', priceResponse: { '5s': 'STALE', '15s': 'STALE', '60s': 'STALE' } };
  const env = fromMicrostructureObservation(stale, new Date(NOW + 1000).toISOString());
  assert.ok(!env.evidenceFamily.includes('MARKET_PRICE'), 'no invented price evidence');
  assert.equal(env.observationState, 'DEGRADED');
  assert.equal(env.dataAvailability.depthPressure, 'STALE');
  assert.equal(validateEnvelope(env).ok, true);
});

test('33c. duplicate identical observation collapses; different content = different id', () => {
  const dir = path.join(TEST_DATA, 'memory-a');
  const store = new MemoryStore({ dir });
  const bus = new MemoryBus({ store });
  const obs = buildObservation();
  const a = bus.publish(fromMicrostructureObservation(obs, new Date(NOW + 1000).toISOString()));
  assert.equal(a.accepted, true, 'durability pipeline input (memory/events.jsonl) accepts a valid MICRO event');
  const b = bus.publish(fromMicrostructureObservation(obs, new Date(NOW + 9000).toISOString()));
  assert.equal(b.accepted, false);
  assert.equal(store.duplicateSuppressedCount, 1, 'same source record => ONE memory');
  // content-addressed identity: a changed record cannot silently share an id
  const changed = { ...obs, flow: { ...obs.flow, changedField: 1 } };
  const envChanged = fromMicrostructureObservation(changed);
  const envOrig = fromMicrostructureObservation(obs);
  assert.notEqual(envChanged.id, envOrig.id, 'content conflict is impossible by construction at the adapter');
  store.flush();
});

test('33d. non-finite payload and malformed envelopes are rejected at the door', () => {
  const obs = buildObservation();
  obs.flow['5s'].aggressiveBuyQty = NaN;
  const env = fromMicrostructureObservation(obs);
  const v = validateEnvelope(env);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('non-finite')));
  const dir = path.join(TEST_DATA, 'memory-b');
  const bus = new MemoryBus({ store: new MemoryStore({ dir }) });
  assert.equal(bus.publish(env).accepted, false);
  assert.equal(bus.publish({ garbage: true }).accepted, false);
  assert.equal(bus.health().status, 'DEGRADED', 'rejected evidence is lost evidence — never silently healthy');
});

test('34. DARK SENSE: publishing MICRO observations changes no trading state', async () => {
  // stage real control/posture/stalking/ledger state files
  for (const sub of ['state', 'ledger']) mkdirSync(path.join(TEST_DATA, sub), { recursive: true });
  const stalkFile = path.join(TEST_DATA, 'state', 'stalking.json');
  const controlsFile = path.join(TEST_DATA, 'state', 'controls.json');
  const postureFile = path.join(TEST_DATA, 'state', 'posture.json');
  writeFileSync(stalkFile, JSON.stringify({ SOL: { since: 'x', cause: 'test', expiresMs: Date.now() + 600000 } }));
  writeFileSync(controlsFile, JSON.stringify({ kill: { active: false }, cage: { active: false } }));
  writeFileSync(postureFile, JSON.stringify({ state: 'COILED' }));
  const before = {
    stalking: readFileSync(stalkFile, 'utf8'),
    controls: readFileSync(controlsFile, 'utf8'),
    posture: readFileSync(postureFile, 'utf8'),
    ledger: existsSync(path.join(TEST_DATA, 'ledger', 'ledger.jsonl')) ? readFileSync(path.join(TEST_DATA, 'ledger', 'ledger.jsonl'), 'utf8') : null,
  };
  const dir = path.join(TEST_DATA, 'memory-c');
  const bus = new MemoryBus({ store: new MemoryStore({ dir }) });
  for (let i = 0; i < 5; i++) {
    const obs = buildObservation();
    obs.ts = new Date(NOW + i * 5000).toISOString(); // distinct observations
    assert.equal(bus.publish(fromMicrostructureObservation(obs, new Date(NOW + i * 5000 + 500).toISOString())).accepted, true);
  }
  assert.equal(readFileSync(stalkFile, 'utf8'), before.stalking, 'stalking unchanged');
  assert.equal(readFileSync(controlsFile, 'utf8'), before.controls, 'controls unchanged');
  assert.equal(readFileSync(postureFile, 'utf8'), before.posture, 'posture unchanged');
  assert.equal(existsSync(path.join(TEST_DATA, 'ledger', 'ledger.jsonl')) ? readFileSync(path.join(TEST_DATA, 'ledger', 'ledger.jsonl'), 'utf8') : null, before.ledger, 'ledger unchanged');
});

test('27. zero trading weight: no trading/control module imports microstructure', () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  // every module that can touch posture, controls, ledger, cost, execution
  const out = execSync(
    `grep -ril "microstructure" --include='*.js' state/ ledger/ cost/ persistence/ lib/ ui/ bin/ engine/ 2>/dev/null || true`,
    { cwd: repo, encoding: 'utf8' }
  ).trim();
  assert.equal(out, '', `no trading-side module may import MICRO output (found: ${out})`);
  // and within tape/, only the runner (transport feeding) touches it
  const tapeUsers = execSync(`grep -ril "microstructure" --include='*.js' tape/ | sort`, { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(tapeUsers, ['tape/microstructure.js', 'tape/run.js']);
  // the module has no arrow INTO any trading/control/persistence module
  const src = readFileSync(path.join(repo, 'tape', 'microstructure.js'), 'utf8');
  for (const imp of [`from '../state`, `from '../ledger`, `from '../cost`, `from '../persistence`, `from '../memory`, `from './run`, `from './health`]) {
    assert.ok(!src.includes(imp), `microstructure.js must not import ${imp}`);
  }
  // and no scoring/permission vocabulary in its OUTPUT surface
  for (const word of ['BUY_SIGNAL', 'SELL_SIGNAL', 'edgeScore', 'confidence', 'conviction', 'ENTRY', 'EXIT', 'positionSize']) {
    assert.ok(!src.includes(word), `microstructure.js must not define ${word}`);
  }
});

test('26. the dark mirror tails micro/observations.jsonl through the pure adapter', () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const mirror = readFileSync(path.join(repo, 'memory', 'mirror.js'), 'utf8');
  assert.ok(mirror.includes(`'micro', 'observations.jsonl'`));
  assert.ok(mirror.includes('fromMicrostructureObservation'));
  // the sensor stays dark: microstructure.js imports nothing from memory/
  const src = readFileSync(path.join(repo, 'tape', 'microstructure.js'), 'utf8');
  assert.ok(!src.includes(`from '../memory`), 'no direct sensor->memory arrow; the mirror tails the stream');
});

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
