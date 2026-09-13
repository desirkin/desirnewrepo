// G-1 drills: parsers over real captured payloads, UNKNOWN handling,
// transition semantics, contagion window, dark-mode zero-network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-gateway-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
process.env.GATEWAY_ENABLED = 'false';

const FIX = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gateway_status.json'), 'utf8')
);
const {
  parseStatuspage,
  parseKrakenSystem,
  parseOkx,
  buildDoorMatrix,
  detectContagion,
  extractAssets,
  extractFunctions,
  surpriseScore,
  DOOR,
} = await import('../gateway/parse.js');
const { startGateway, gatewayEnabled } = await import('../gateway/collector.js');

test.after(() => {
  rmSync(TEST_DATA, { recursive: true, force: true });
  delete process.env.GATEWAY_ENABLED;
});

const NOW = '2026-09-03T03:30:00Z';

test('real Kraken payload parses into structured incidents', () => {
  const events = parseStatuspage('kraken', FIX.kraken_summary, NOW);
  const monad = events.find((e) => e.title.includes('Monad'));
  assert.equal(monad.category, 'INCIDENT');
  assert.deepEqual(monad.assets, ['MON']);
  assert.equal(monad.stage, 'investigating');
  assert.equal(monad.scheduled, false);
  assert.equal(monad.door, DOOR.DELAYED); // "Funding Delays"
  assert.ok(monad.functions.includes('deposit') && monad.functions.includes('withdrawal')); // funding = both
  assert.equal(monad.surpriseScore, 1); // sudden, minor impact
  assert.equal(monad.announcedAt, '2026-09-02T23:48:17.928Z');
  assert.equal(monad.observedAt, NOW);

  const maint = events.find((e) => e.scheduled);
  assert.equal(maint.door, DOOR.MAINTENANCE);
  assert.equal(maint.surpriseScore, 0);
});

test('real Coinbase payload: sends/receives map to both funding doors', () => {
  const events = parseStatuspage('coinbase', FIX.coinbase_summary, NOW);
  const core = events.find((e) => /Core DAO/.test(e.title));
  assert.ok(core);
  assert.ok(core.networks.includes('Core DAO'));
  assert.ok(core.functions.includes('deposit') && core.functions.includes('withdrawal'));
});

test('Kraken SystemStatus and OKX parse; OKX asset-less titles go UNPARSED', () => {
  const sys = parseKrakenSystem(FIX.kraken_system, NOW);
  assert.equal(sys.venueDoor, DOOR.OPEN);
  assert.equal(sys.events.length, 1);
  assert.equal(sys.events[0].scheduled, true);
  assert.equal(sys.events[0].stageTimestamps.scheduledFor, '2026-09-03T07:00:00Z');

  const okx = parseOkx(FIX.okx_status, NOW);
  assert.equal(okx.length, 1);
  assert.deepEqual(okx[0].assets, ['SOL']);
  assert.equal(okx[0].stage, 'scheduled');
  const unparsed = parseOkx({ data: [{ begin: '1788500000000', state: 'scheduled', title: 'System upgrade window' }] }, NOW);
  assert.equal(unparsed[0].category, 'UNPARSED');
  assert.ok(unparsed[0].raw); // raw text archived, never guessed
});

test('unconfident text goes UNPARSED with raw archived; UNKNOWN door', () => {
  const events = parseStatuspage(
    'kraken',
    { incidents: [{ id: 'x1', name: 'Elevated error rates', status: 'investigating', impact: 'minor', created_at: NOW, incident_updates: [] }] },
    NOW
  );
  assert.equal(events[0].category, 'UNPARSED');
  assert.equal(events[0].door, DOOR.UNKNOWN);
  assert.equal(events[0].raw.name, 'Elevated error rates');
});

test('door matrix: UNKNOWN never becomes OPEN without positive evidence', () => {
  const coins = ['BTC', 'SOL', 'ZZZ'];
  const components = FIX.kraken_summary.components; // has (BTC)/(SOL) entries, no ZZZ
  let m = buildDoorMatrix(coins, components, []);
  assert.equal(m.BTC.funding, DOOR.OPEN); // operational component = positive evidence
  assert.equal(m.ZZZ.funding, DOOR.UNKNOWN); // no evidence
  assert.equal(m.ZZZ.trading, DOOR.UNKNOWN);
  // rebuild after rebuild: still UNKNOWN, never drifts OPEN
  m = buildDoorMatrix(coins, [], [], m);
  m = buildDoorMatrix(coins, [], [], m);
  assert.equal(m.ZZZ.funding, DOOR.UNKNOWN);
  assert.equal(m.BTC.funding, DOOR.OPEN); // carried forward from prior positive evidence
  // an active incident closes a door; resolution is what reopens it
  const halt = parseStatuspage('kraken', { incidents: [{ id: 'h1', name: 'Solana (SOL) deposits paused', status: 'identified', impact: 'major', created_at: NOW, incident_updates: [] }] }, NOW);
  m = buildDoorMatrix(coins, [], halt, m);
  assert.equal(m.SOL.funding, DOOR.CLOSED);
  assert.equal(halt[0].surpriseScore, 2); // sudden + major
});

test('contagion: same asset on 2+ venues within 30 min, not beyond', () => {
  const mk = (venue, asset, atMin) => ({
    venue, sourceId: `${venue}-1`, category: 'INCIDENT', scheduled: false,
    assets: [asset], networks: [], announcedAt: new Date(Date.parse(NOW) + atMin * 60_000).toISOString(), observedAt: NOW,
  });
  let flagged = detectContagion([mk('kraken', 'SOL', 0), mk('coinbase', 'SOL', 29)]);
  assert.equal(flagged.size, 2);
  flagged = detectContagion([mk('kraken', 'SOL', 0), mk('coinbase', 'SOL', 31)]);
  assert.equal(flagged.size, 0);
  flagged = detectContagion([mk('kraken', 'SOL', 0), mk('kraken', 'SOL', 5)]); // same venue never contagion
  assert.equal(flagged.size, 0);
  flagged = detectContagion([mk('kraken', 'SOL', 0), mk('coinbase', 'ETH', 5)]); // different asset/network
  assert.equal(flagged.size, 0);
});

test('helpers: asset extraction and surprise scoring', () => {
  assert.deepEqual(extractAssets('0x (ZRX) - Ethereum and Bitcoin (BTC) - Rewards'), ['ZRX', 'BTC']);
  assert.deepEqual(extractFunctions('Paused Sends/Receives - Core DAO Network'), ['deposit', 'withdrawal']);
  assert.equal(surpriseScore({ scheduled: true, impact: 'critical' }), 0);
  assert.equal(surpriseScore({ scheduled: false, impact: 'critical' }), 3);
});

test('dark gateway performs ZERO network calls', () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; throw new Error('network while dark'); };
  try {
    assert.equal(gatewayEnabled({ gateway: { enabled: true } }), false); // env force-disable wins
    const out = startGateway({ log: () => {} });
    assert.equal(out, null);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
