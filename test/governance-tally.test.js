import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  TALLY_API,
  TallyRetry429,
  fetchTallyProposalsPaged,
  normalizeTallyProposal,
  tallyStatus,
} from '../governance/tally.js';
import { startGovernance } from '../governance/collector.js';
import { VERIFIED_MAPPINGS } from '../governance/registry.js';

const secret = 'test-tally-key';
const governor = 'eip155:1:0xGovernor';
const mapping = {
  symbol: 'UNI',
  provider: 'TALLY',
  governorId: governor,
  scope: 'TOKEN_GOVERNANCE',
  verified: true,
  mappingVersion: 1,
};
const tallyProposal = (id) => ({
  id,
  status: 'QUEUED',
  createdAt: 1_900_000_000,
  start: { timestamp: 1_900_000_100 },
  end: { timestamp: 1_900_001_000 },
  governor: { id: governor, chainId: 1 },
  quorum: '100',
  voteStats: [{ type: 'FOR', votesCount: '80', percent: '80' }, { type: 'AGAINST', votesCount: '20', percent: '20' }],
  metadata: { title: 'Indexed proposal', description: 'bounded description' },
});
const ok = (data) => Response.json({ data });

test('Tally pagination is bounded, deduped, and reports a page ceiling', async () => {
  const calls = [];
  const result = await fetchTallyProposalsPaged(
    { governorId: governor, pageSize: 2, maxPages: 2 },
    {
      env: { TALLY_API_KEY: secret },
      fetchImpl: async (url, opts) => {
        assert.equal(url, TALLY_API);
        calls.push(JSON.parse(opts.body).query);
        const offset = Number(calls.at(-1).match(/offset: (\d+)/)[1]);
        return ok({ proposals: { nodes: [tallyProposal(`p-${offset}`), tallyProposal(`p-${offset + 1}`)] } });
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.proposals.length, 4);
  assert.equal(result.complete, false);
  assert.equal(result.ceilingHit, true);
});

test('Tally normalizer keeps provider status and supplies canonical governance state/timestamps', () => {
  const normalized = normalizeTallyProposal(tallyProposal('p-1'), governor);
  assert.equal(normalized.state, 'queued');
  assert.equal(normalized.governanceState, 'closed');
  assert.equal(normalized.providerState, 'QUEUED');
  assert.equal(normalized.startTs, 1_900_000_100);
  assert.equal(normalized.scoresTotal, 100);
  assert.equal(tallyStatus({ TALLY_API_KEY: secret }, { tallyGovernors: [governor] }), 'READY');
});

test('Tally collector is key- and exact-governor-gated and records indexed evidence', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-tally-'));
  process.env.COBRA_DATA_DIR = d;
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(url, TALLY_API);
    return ok({ proposals: { nodes: [tallyProposal('p-1')] } });
  };
  const now = () => 1_900_000_000_000;
  const gov = startGovernance({
    log: () => {},
    config: { governance: {
      enabled: true,
      snapshotEnabled: false,
      minSpacingMs: 1,
      requestsPerHour: 10,
      discoverySec: 60,
      refreshSec: 60,
      maxProposalPagesPerCycle: 2,
      proposalPageSize: 25,
      timeoutMs: 5_000,
    } },
    env: { TALLY_API_KEY: secret },
    registryEntries: [...VERIFIED_MAPPINGS, mapping],
    fetchImpl,
    now,
    intervalMs: 3_600_000,
  });
  await gov.pollOnce();
  const lines = readFileSync(path.join(d, 'governance', 'events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(calls >= 1);
  assert.equal(calls, 1, 'one mapped governor is requested only once');
  const status = JSON.parse(readFileSync(path.join(d, 'governance', 'status.json'), 'utf8'));
  assert.equal(status.providers.tally, 'OBSERVED', 'a duplicate governor must not leave the collector budget-blocked');
  assert.equal(lines[0].provider, 'TALLY');
  assert.equal(lines[0].governorId, governor);
  assert.equal(lines[0].providerKind, 'tally graphql (indexed on-chain governance)');
  assert.equal(lines[0].executionState, 'QUEUED');
  assert.equal(lines[0].symbol, 'UNI');
  gov.stop();
  rmSync(d, { recursive: true, force: true });
});

test('Tally 429 remains typed for bounded governance backoff', async () => {
  await assert.rejects(
    () => fetchTallyProposalsPaged(
      { governorId: governor, pageSize: 1, maxPages: 1 },
      { env: { TALLY_API_KEY: secret }, fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: { get: () => '7' },
        json: async () => ({}),
      }) },
    ),
    (err) => err instanceof TallyRetry429 && err.retryAfterSec === 7,
  );
});
