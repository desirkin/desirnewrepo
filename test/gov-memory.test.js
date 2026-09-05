// GOV-1 memory drills — the promoted GOVERNANCE family, the pure adapter,
// deterministic identity, mirror containment, point-in-time truth, and the
// dark-sense guarantee: governance observations change NOTHING about
// trading state and no trading-side module can even reach them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-govmem-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { EVIDENCE_FAMILIES, RESERVED_EVIDENCE_FAMILIES, SOURCE_MODULES } = await import('../memory/schema.js');
const { fromGovernanceEvent } = await import('../memory/adapters.js');
const { validateEnvelope } = await import('../memory/validate.js');
const { MemoryStore } = await import('../memory/store.js');
const { MemoryBus } = await import('../memory/bus.js');
const { startMemoryMirror } = await import('../memory/mirror.js');
const { startGovernance } = await import('../governance/collector.js');

// the fixture epoch sits in the PAST relative to any real wall clock, so
// live-path validation (mirror, bus) never sees "evidence about the future"
const T0 = 1_750_000_000_000;
const T0s = Math.floor(T0 / 1000);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// a realistic collector-shaped source record
const govRec = (over = {}) => ({
  ts: new Date(T0).toISOString(),
  type: 'GOVERNANCE_OBSERVATION',
  provider: 'SNAPSHOT',
  providerKind: 'snapshot hub graphql (off-chain voting)',
  collectorVersion: 'GOV-1',
  lifecycleTransition: 'PROPOSAL_DISCOVERED',
  emitReason: 'LIFECYCLE_TRANSITION',
  spaceId: 'uniswapgovernance.eth',
  proposalId: '0xprop1',
  symbol: 'UNI',
  mappingVersion: 1,
  proposalState: 'active',
  offchainVoteNote: 'snapshot is off-chain voting evidence; PASSED_OFFCHAIN_VOTE is not EXECUTED',
  proposalStartTs: T0s - 3600,
  proposalEndTs: T0s + 86_400,
  snapshotBlock: '19999999',
  choices: ['For', 'Against'],
  voteTotals: { scores: [1e6, 2e5], scoresTotal: 1.2e6, voteCount: 42 },
  quorum: { quorumRequired: 4e7, quorumObserved: 1.2e6, quorumProgressRatio: 0.03, unit: 'space voting power (provider-defined strategies)' },
  trajectory: { totalObservedPower: 1.2e6, supportRatio: 0.833333, oppositionRatio: 0.166667, observedVoterCount: 42, timeRemainingSec: 86_400 },
  voterConcentration: { coverage: 'PARTIAL', coverageReason: 'PARTIAL_PAGE_LIMIT', observedVoterCount: 6, top1VotingPowerShare: 0.5, top5VotingPowerShare: 0.9 },
  timelock: 'UNKNOWN',
  executionState: 'UNKNOWN',
  coverage: { proposalPages: 'COMPLETE', votePages: 'PARTIAL' },
  title: 'Deploy v3',
  bodyExcerpt: 'bounded body',
  textHash: 'ab'.repeat(20),
  providerUrl: 'https://snapshot.org/#/uniswapgovernance.eth/proposal/0xprop1',
  retrievedTs: new Date(T0).toISOString(),
  ...over,
});

test('M1. GOVERNANCE family/module promotion: accepted now, junk still rejected, existing families intact', () => {
  assert.ok(EVIDENCE_FAMILIES.includes('GOVERNANCE'), 'family promoted');
  assert.ok(!RESERVED_EVIDENCE_FAMILIES.includes('GOVERNANCE'), 'no longer merely reserved');
  assert.ok(SOURCE_MODULES.includes('GOVERNANCE'), 'source module active');
  for (const f of ['MARKET_PRICE', 'ORDER_FLOW', 'RUMOR', 'STATE_CONTROL', 'HISTORICAL_CONTEXT']) {
    assert.ok(EVIDENCE_FAMILIES.includes(f), `existing family ${f} unchanged`);
  }
  const env = fromGovernanceEvent(govRec(), new Date(T0 + 5000).toISOString());
  assert.deepEqual(validateEnvelope(env).errors, []);
  // an unapproved family string still fails at the door
  const junk = { ...env, evidenceFamily: ['DAO_VIBES'] };
  assert.equal(validateEnvelope(junk).ok, false);
});

test('M2. pure adapter: canonical envelope, ONE family, honest availability, provider-true provenance', () => {
  const env = fromGovernanceEvent(govRec(), new Date(T0 + 5000).toISOString());
  assert.equal(validateEnvelope(env).ok, true);
  assert.equal(env.sourceModule, 'GOVERNANCE');
  assert.equal(env.eventType, 'GOVERNANCE_OBSERVATION');
  assert.deepEqual(env.evidenceFamily, ['GOVERNANCE'], 'correlated governance metrics are ONE family, not four confirmations');
  assert.equal(env.symbol, 'UNI');
  assert.equal(env.observationState, 'KNOWN');
  assert.equal(env.dataAvailability.quorum, 'KNOWN');
  assert.equal(env.dataAvailability.voterConcentration, 'DEGRADED', 'partial coverage is not full knowledge');
  assert.equal(env.dataAvailability.timelock, 'UNKNOWN', 'no timelock evidence in GOV-1');
  assert.equal(env.dataAvailability.executionState, 'UNKNOWN');
  assert.ok(env.provenance.source.includes('OFF-CHAIN'), 'snapshot provenance says off-chain');
  assert.equal(env.provenance.mappingVersion, 1, 'mapping version travels into provenance');
  assert.equal(env.correlation.eventId, 'SNAPSHOT:uniswapgovernance.eth:0xprop1', 'observations of one proposal cluster');
  // symbol:null is allowed and honest
  const unmapped = fromGovernanceEvent(govRec({ symbol: null, spaceId: 'unmapped.eth' }));
  assert.equal(unmapped.symbol, null);
  assert.equal(validateEnvelope(unmapped).ok, true);
  // a TALLY record is provenance-distinct — providers are never blurred
  const tally = fromGovernanceEvent(govRec({ provider: 'TALLY', governorId: 'gov-7', spaceId: undefined }));
  assert.ok(tally.provenance.source.includes('INDEXED'), 'tally provenance says indexed, never chain-verified');
  assert.notEqual(tally.correlation.eventId, 'SNAPSHOT:uniswapgovernance.eth:0xprop1');
});

test('M3. deterministic identity: replay collapses; changed proposal state mints a NEW observation', () => {
  const a = fromGovernanceEvent(govRec());
  const b = fromGovernanceEvent(govRec()); // byte-identical source record replayed
  assert.equal(a.id, b.id, 'restart/replay deduplicates');
  const changed = fromGovernanceEvent(govRec({ proposalState: 'closed', lifecycleTransition: 'VOTING_ENDED' }));
  assert.notEqual(changed.id, a.id, 'meaningful later state is a new memory');
  // bus-level: duplicate suppressed, malformed rejected without a crash
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-govmem-bus-'));
  const store = new MemoryStore({ dir });
  const bus = new MemoryBus({ store });
  assert.equal(bus.publish(a).accepted, true);
  assert.equal(bus.publish(b).accepted, false, 'ONE memory');
  assert.equal(store.duplicateSuppressedCount, 1);
  const malformed = fromGovernanceEvent(govRec({ ts: 'not-a-time' }));
  assert.equal(validateEnvelope(malformed).ok, false, 'malformed source rejected at the door');
  assert.equal(bus.publish(malformed).accepted, false, 'contained — memory does not crash');
  rmSync(dir, { recursive: true, force: true });
});

test('M4. the dark mirror tails governance/events.jsonl; torn lines contained', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-govmem-mirror-'));
  process.env.COBRA_DATA_DIR = d;
  try {
    mkdirSync(path.join(d, 'governance'), { recursive: true });
    writeFileSync(path.join(d, 'governance', 'events.jsonl'), ''); // exists at open: anchored at EOF
    const mirror = startMemoryMirror({ log: () => {} });
    appendFileSync(path.join(d, 'governance', 'events.jsonl'), JSON.stringify(govRec()) + '\n{ torn line\n');
    mirror.poll();
    const got = mirror.store.getRecent({ sourceModule: 'GOVERNANCE', limit: 10 });
    assert.equal(got.length, 1, 'governance stream canonicalized through the mirror');
    assert.equal(got[0].eventType, 'GOVERNANCE_OBSERVATION');
    const h = mirror.health();
    assert.ok(h.sourceParseErrors >= 1, 'the torn line was counted, not pretended away');
    assert.notEqual(h.status, 'FAILED', 'containment: memory keeps running');
    mirror.stop();
  } finally {
    process.env.COBRA_DATA_DIR = TEST_DATA;
    rmSync(d, { recursive: true, force: true });
  }
});

test('M5. POINT-IN-TIME: nothing visible before retrieval; final truth never before final availability', () => {
  // chronology: discovered at T0, tally moves at T0+10min, closes at T0+1h.
  const stream = [
    govRec(),
    govRec({ ts: new Date(T0 + 600_000).toISOString(), retrievedTs: new Date(T0 + 600_000).toISOString(), lifecycleTransition: null, emitReason: 'TALLY_CHANGED', voteTotals: { scores: [2e6, 2e5], scoresTotal: 2.2e6, voteCount: 60 } }),
    govRec({ ts: new Date(T0 + 3_600_000).toISOString(), retrievedTs: new Date(T0 + 3_600_000).toISOString(), proposalState: 'closed', lifecycleTransition: 'FINAL_TALLY_OBSERVED' }),
  ];
  const envs = stream.map((r) => fromGovernanceEvent(r, new Date(Date.parse(r.ts) + 2000).toISOString()));
  for (const [i, env] of envs.entries()) {
    assert.equal(validateEnvelope(env).ok, true);
    assert.equal(env.ts, Math.floor(Date.parse(stream[i].ts) / 1000), 'observation time = when Serpent could know');
    assert.equal(env.provenance.availableTs, stream[i].retrievedTs, 'available when retrieved, never earlier');
  }
  // a replay reader honoring ts can never see the final tally before T0+1h
  const finalEnv = envs[2];
  assert.ok(finalEnv.ts >= T0s + 3600);
  assert.ok(envs[0].ts < envs[1].ts && envs[1].ts < envs[2].ts, 'chronology preserved');
  // the T0 observation is immutable: later stream events change nothing about it
  const first = JSON.stringify(envs[0]);
  fromGovernanceEvent(stream[2]);
  assert.equal(JSON.stringify(envs[0]), first, 'a vote at T+10 cannot affect the observation at T');
  // no queued/executed claim exists anywhere in the GOV-1 stream
  for (const env of envs) {
    assert.equal(env.payload.executionState, 'UNKNOWN');
    assert.equal(env.payload.timelock, 'UNKNOWN');
  }
});

test('M6. ZERO TRADING WEIGHT: governance observation changes no trading state; no import path exists', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-govmem-dark-'));
  process.env.COBRA_DATA_DIR = d;
  try {
    for (const sub of ['state', 'ledger']) mkdirSync(path.join(d, sub), { recursive: true });
    const files = {
      stalking: path.join(d, 'state', 'stalking.json'),
      controls: path.join(d, 'state', 'controls.json'),
      posture: path.join(d, 'state', 'posture.json'),
      ledger: path.join(d, 'ledger', 'ledger.jsonl'),
    };
    writeFileSync(files.stalking, JSON.stringify({ SOL: { since: 'x', cause: 'test', expiresMs: Date.now() + 600000 } }));
    writeFileSync(files.controls, JSON.stringify({ kill: { active: false }, cage: { active: false } }));
    writeFileSync(files.posture, JSON.stringify({ state: 'COILED' }));
    writeFileSync(files.ledger, JSON.stringify({ kind: 'seed' }) + '\n');
    const before = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
    // run a REAL collector poll that emits observations
    const fetchImpl = async (url, opts) => {
      const q = JSON.parse(opts.body).query;
      const body = q.includes('{ votes(')
        ? { data: { votes: [{ voter: '0xa', created: T0s, choice: 1, vp: 10 }] } }
        : { data: { proposals: [{ id: 'zp1', space: { id: 'uniswapgovernance.eth' }, title: 't', body: 'b', state: 'active', created: T0s - 100, start: T0s - 50, end: T0s + 5000, quorum: 10, choices: ['For', 'Against'], scores: [5, 1], scores_total: 6, votes: 2, snapshot: '1', updated: T0s }] } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    };
    let clock = T0;
    const gov = startGovernance({
      log: () => {},
      config: { governance: { enabled: true, minSpacingMs: 1 } },
      fetchImpl,
      now: () => (clock += 25),
      intervalMs: 3_600_000,
    });
    await gov.pollOnce();
    gov.stop();
    assert.ok(existsSync(path.join(d, 'governance', 'events.jsonl')), 'observations were written');
    for (const [k, f] of Object.entries(files)) {
      assert.equal(readFileSync(f, 'utf8'), before[k], `${k} byte-identical — zero trading weight`);
    }
  } finally {
    process.env.COBRA_DATA_DIR = TEST_DATA;
    rmSync(d, { recursive: true, force: true });
  }
  // static import scan: no trading/control/UI module reaches governance...
  const out = execSync(
    `grep -rl "governance/" --include='*.js' state/ ledger/ cost/ persistence/ lib/ ui/ bin/ engine/ tape/ survey/ rumint/ 2>/dev/null || true`,
    { cwd: REPO, encoding: 'utf8' }
  ).trim();
  assert.equal(out, '', `no trading-side module may import GOVERNANCE output (found: ${out})`);
  // ...and governance imports no trading, state, memory, or UI machinery
  for (const f of ['collector.js', 'snapshot.js', 'tally.js', 'registry.js']) {
    const src = readFileSync(path.join(REPO, 'governance', f), 'utf8');
    for (const banned of [`from '../state`, `from '../ledger`, `from '../cost`, `from '../memory`, `from '../ui`, `from '../tape`, `from '../persistence`, `from '../rumint`, `from '../survey`]) {
      assert.ok(!src.includes(banned), `governance/${f} must not import ${banned}`);
    }
    for (const word of ['BUY_SIGNAL', 'SELL_SIGNAL', 'edgeScore', 'momentumSignal', 'bullishGovernance', 'bearishGovernance']) {
      assert.ok(!src.includes(word), `governance/${f} must not define ${word}`);
    }
  }
});

// ---------------- GOV-1B durable checkpoint (real PostgreSQL) ----------------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('M7. GOV-1B durable checkpoint integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  test('M7. durable governance checkpoint: schema 3 applies; round-trip + revision bump; storage only', async () => {
    const { Db } = await import('../persistence/db.js');
    const { Repository } = await import('../persistence/repository.js');
    const { runMigrations } = await import('../persistence/migrate.js');
    const { govCheckpointStore } = await import('../persistence/gov-checkpoint.js');
    const SCHEMA = `gov1b_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      const m = await runMigrations(db);
      assert.equal(m.schemaVersion, 5, 'GOV-1B schema (and later) landed');
      const repo = new Repository(db);
      const store = govCheckpointStore({ persistence: () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) }) });
      // GOV-1C tri-state contract: absence is NOT_FOUND, an answered read
      assert.deepEqual(await store.load(), { outcome: 'NOT_FOUND' }, 'an empty store answers NOT_FOUND, never invented');
      const cp = { version: 3, savedTs: new Date(T0).toISOString(), lastSeq: 7, proposals: {}, finalIds: [], pending: [] };
      assert.equal((await store.save(cp)).durable, true);
      assert.deepEqual(await store.load(), { outcome: 'LOADED', state: cp }, 'round-trip exact');
      const cp2 = { ...cp, lastSeq: 9 };
      await store.save(cp2);
      assert.equal((await store.load()).state.lastSeq, 9, 'latest revision wins');
      const { rows } = await db.query(`SELECT revision FROM serpent_governance_checkpoint WHERE id = 'current'`);
      assert.equal(Number(rows[0].revision), 2, 'revision counted');
      // no durable core at all is NOT_CONFIGURED — never confused with a read failure
      const dead = govCheckpointStore({ persistence: () => null });
      assert.deepEqual(await dead.load(), { outcome: 'NOT_CONFIGURED' });
      assert.deepEqual(await dead.save(cp), { durable: false, reason: 'NOT_CONFIGURED' });
      // a configured core whose read THROWS answers UNAVAILABLE — a read
      // failure is never "no checkpoint"
      const broken = govCheckpointStore({
        persistence: () => ({
          repo: { loadGovernanceCheckpoint: async () => { throw new Error('db down'); }, saveGovernanceCheckpoint: async () => { throw new Error('db down'); } },
          health: () => ({ databaseConfigured: true, restored: true }),
        }),
      });
      assert.equal((await broken.load()).outcome, 'UNAVAILABLE');
      assert.deepEqual(await broken.save(cp), { durable: false, reason: 'UNAVAILABLE' });
    } finally {
      try {
        await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
      } catch {
        // schema may already be gone
      }
      await db.end();
    }
  });
}

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));
