import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGovernance, validateGovernanceSourceRecord } from '../governance/collector.js';
import { tallyGql, normalizeTallyProposal, fetchTallyProposalsPage } from '../governance/tally.js';
import { fromGovernanceEvent } from '../memory/adapters.js';
const T = Date.parse('2026-09-12T10:00:00Z'), G = `eip155:1:0x${'1'.repeat(40)}`;
const raw = (state = 'active', id = '2207450143689540900') => ({ id, governor: { id: G }, chainId: 'eip155:1', status: state, quorum: '100000000000000000000000001', start: { timestamp: T / 1000 - 300 }, end: { timestamp: T / 1000 + 3600 }, events: [{ type: 'activated', createdAt: T / 1000 - 300, block: { timestamp: T / 1000 - 300 } }], metadata: { title: 'Fixture grants vote', timelockId: G, eta: null }, voteStats: [{ type: 'for', votesCount: '9999999999999999999999999', votersCount: 12, percent: 50 }] });
const config = { governance: { enabled: true, snapshotEnabled: false, maxProposalPagesPerCycle: 1, verifiedMappings: [{ symbol: 'UNI', provider: 'TALLY', governorId: G, scope: 'TOKEN_GOVERNANCE', verified: true, mappingVersion: 1 }] } };
const events = dir => { try { return readFileSync(path.join(dir, 'governance/events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
test('Tally startup config -> documented GraphQL -> durable governance event -> Memory adapter, with exact values and indexed provenance', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tally-')); process.env.COBRA_DATA_DIR = dir; t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = T, state = 'active', requests = 0;
  const opts = { config, env: { TALLY_API_KEY: 'fixture-key' }, now: () => clock, intervalMs: 3600000, log: () => {}, sleepImpl: async ms => { clock += ms; }, fetchImpl: async (url, init) => {
    requests++; assert.equal(url, 'https://api.tally.xyz/query'); assert.equal(init.headers['api-key'], 'fixture-key'); const body = JSON.parse(init.body); assert.equal(body.variables.input.filters.governorId, G); assert.equal(body.variables.input.page.limit, 20); return Response.json({ data: { proposals: { nodes: [raw(state)], pageInfo: { count: 1, lastCursor: null } } } });
  } };
  let g = startGovernance(opts); t.after(() => g.stop()); await g.pollOnce(); let out = events(dir); assert.equal(out.length, 1); const e = out[0]; assert.equal(validateGovernanceSourceRecord(e, { requireSeq: true }), null); assert.equal(e.provenance, 'INDEXED_BY_TALLY'); assert.equal(e.proposalId, '2207450143689540900'); assert.equal(e.quorumRaw, raw().quorum); assert.equal(e.indexedVoteStats[0].votesCount, raw().voteStats[0].votesCount); assert.equal(e.proposalStartTs, T / 1000 - 300); assert.equal(e.retrievedTs, new Date(T).toISOString()); assert.ok(!JSON.stringify(out).includes('fixture-key'));
  const memory = fromGovernanceEvent(e); assert.equal(memory.payload.provenance, 'INDEXED_BY_TALLY'); assert.equal(memory.dataAvailability.executionState, 'KNOWN');
  g.stop(); g = startGovernance(opts); clock += 300000; await g.pollOnce(); assert.equal(events(dir).length, 1, 'checkpoint restore suppresses an unchanged observation');
  state = 'queued'; clock += 300000; await g.pollOnce(); state = 'executed'; clock += 300000; await g.pollOnce(); out = events(dir); assert.deepEqual(out.map(e => e.proposalState), ['active','queued','executed']); assert.ok(out.every(e => e.lifecycleTransition !== 'FINAL_TALLY_OBSERVED'), 'Tally states never become Snapshot final-vote semantics');
  assert.equal(g._tracked.size, 0); assert.equal(g._finalIds.size, 1); assert.equal(requests, 4);
});
test('Tally does not finalize before durable append; owed indexed evidence settles after storage recovers', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tally-debt-')); process.env.COBRA_DATA_DIR = dir; t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'governance/events.jsonl'), { recursive: true }); let clock = T;
  const g = startGovernance({ config, env: { TALLY_API_KEY: 'fixture' }, now: () => clock, intervalMs: 3600000, log: () => {}, fetchImpl: async () => Response.json({ data: { proposals: { nodes: [raw('executed')], pageInfo: { count: 1, lastCursor: null } } } }) }); t.after(() => g.stop());
  await g.pollOnce(); assert.equal(g._pending.length, 1); assert.equal(g._finalIds.size, 0); rmSync(path.join(dir, 'governance/events.jsonl'), { recursive: true }); clock += 300000; await g.pollOnce(); assert.equal(g._pending.length, 0); assert.equal(g._finalIds.size, 1); assert.equal(events(dir).length, 1);
});
test('Tally preserves large JSON numeric tokens, null clocks, refusal status and malformed page boundaries', async () => {
  const data = await tallyGql('{fixture}', {}, { env: { TALLY_API_KEY: 'fixture' }, fetchImpl: async () => new Response('{"data":{"id":2207450143689540900,"votes":100000000000000000001}}', { headers: { 'content-type': 'application/json' } }) }); assert.equal(data.id, '2207450143689540900'); assert.equal(data.votes, '100000000000000000001');
  const n = normalizeTallyProposal({ ...raw(), start: null, end: { timestamp: true }, quorum: null }, G); assert.equal(n.startTs, null); assert.equal(n.endTs, null); assert.equal(n.quorumRaw, null);
  assert.equal(normalizeTallyProposal({ ...raw(), id: 2207450143689540900 }, G), null, 'already rounded identifiers are refused');
  await assert.rejects(() => fetchTallyProposalsPage({ governorId: G }, { env: { TALLY_API_KEY: 'fixture' }, fetchImpl: async () => Response.json({ data: { proposals: { nodes: [], pageInfo: { count: 99 } } } }) }), /page shape/);
  await assert.rejects(() => tallyGql('{fixture}', {}, { env: { TALLY_API_KEY: 'fixture' }, fetchImpl: async () => Response.json({ data: {} }, { status: 403 }) }), /403/);
});
