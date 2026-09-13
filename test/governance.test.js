// B-0B §19.13-16 — deep-memory honesty drills: pagination to exhaustion,
// no fake certainty, governance knowledge time, incident first-public
// ordering invariance. All against injected fixtures; zero network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-gov-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { fetchProposalsPaged, fetchVotesPaged, analyzeLock, quorumReachedTs, fetchGovernance, firstPublicTsOf } = await import(
  '../childhood/deepmemory.js'
);
const { knowableAt } = await import('../childhood/knowledge.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const gqlResponse = (data) => ({ ok: true, json: async () => ({ data }) });
const proposal = (n) => ({
  id: `prop-${n}`,
  title: `P${n}`,
  state: 'closed',
  created: 1_700_000_000 + n,
  start: 1_700_000_100 + n,
  end: 1_700_600_000 + n,
  quorum: 100,
  scores: [700, 300],
  scores_total: 1000,
  choices: ['For', 'Against'],
  votes: 3,
});

// §19.13 GOVERNANCE PAGINATION — more than one page is actually retrieved.
test('GOVERNANCE PAGINATION: skip-paginated to exhaustion, never silently stopped at page one', async () => {
  const calls = [];
  const fetchImpl = async (_url, opts) => {
    const q = JSON.parse(opts.body).query;
    const skip = Number(q.match(/skip: (\d+)/)[1]);
    calls.push(skip);
    const size = skip === 0 || skip === 100 ? 100 : 37; // two full pages, then a partial
    return gqlResponse({ proposals: Array.from({ length: size }, (_, i) => proposal(skip + i)) });
  };
  const r = await fetchProposalsPaged('space.eth', fetchImpl, 0);
  assert.deepEqual(calls, [0, 100, 200]); // MORE THAN ONE PAGE — the old first:100 truncation is dead
  assert.equal(r.proposals.length, 237);
  assert.equal(r.complete, true);
  assert.equal(r.ceilingHit, false);
  assert.equal(new Set(r.proposals.map((p) => p.id)).size, 237);
});

test('GOVERNANCE PAGINATION: the documented ceiling stops the walk and is REPORTED, never silent', async () => {
  const fetchImpl = async (_url, opts) => {
    const skip = Number(JSON.parse(opts.body).query.match(/skip: (\d+)/)[1]);
    return gqlResponse({ proposals: Array.from({ length: 100 }, (_, i) => proposal(skip + i)) });
  };
  const r = await fetchProposalsPaged('space.eth', fetchImpl, 0);
  assert.equal(r.proposals.length, 1000);
  assert.equal(r.complete, false);
  assert.equal(r.ceilingHit, true); // the caller manifests this as a gap
});

test('VOTE TIMELINES: paginated, ascending, complete flag honest', async () => {
  const fetchImpl = async (_url, opts) => {
    const skip = Number(JSON.parse(opts.body).query.match(/skip: (\d+)/)[1]);
    const size = skip === 0 ? 1000 : 300;
    return gqlResponse({ votes: Array.from({ length: size }, (_, i) => ({ voter: `v${skip + i}`, created: 1000 + skip + i, choice: 1, vp: 10 })) });
  };
  const r = await fetchVotesPaged('prop-1', fetchImpl, 0);
  assert.equal(r.votes.length, 1300);
  assert.equal(r.complete, true);
  for (let i = 1; i < r.votes.length; i++) assert.ok(r.votes[i].created >= r.votes[i - 1].created);
});

// §19.14 NO FAKE CERTAINTY — final margin alone can never produce a probability claim.
test('GOVERNANCE NO FAKE CERTAINTY: a decisive final margin yields INEVITABILITY_UNKNOWN, never STATISTICALLY_NEAR_CERTAIN', () => {
  const decisive = analyzeLock({ state: 'closed', scores: [900, 100], scores_total: 1000, quorum: 100, votes: 42 });
  assert.equal(decisive.status, 'INEVITABILITY_UNKNOWN');
  assert.equal(decisive.lockTime, 'UNKNOWN');
  // the uncalibrated label must not appear ANYWHERE in the analysis
  assert.equal(JSON.stringify(decisive).includes('STATISTICALLY_NEAR_CERTAIN'), false);
  // descriptive final facts are preserved AS FACTS
  assert.equal(decisive.descriptive.finalWinningMargin, 800);
  assert.equal(decisive.descriptive.finalWinningMarginPctOfCastPower, 80);
  assert.equal(decisive.descriptive.finalQuorumMet, true);
  assert.equal(decisive.descriptive.FINAL_MARGIN_DECISIVE_UNCALIBRATED, true); // descriptive, uncalibrated, named so
  // an open proposal claims nothing
  const open = analyzeLock({ state: 'active', scores: [900, 100], scores_total: 1000, quorum: 100, votes: 42 });
  assert.equal(open.status, 'INEVITABILITY_UNKNOWN');
  assert.equal(open.descriptive.FINAL_MARGIN_DECISIVE_UNCALIBRATED, null);
});

test('QUORUM RECONSTRUCTION: deterministic cumulative crossing; partial power data makes NO claim', () => {
  const votes = [
    { created: 10, vp: 40 },
    { created: 20, vp: 50 },
    { created: 30, vp: 20 },
  ];
  assert.equal(quorumReachedTs(votes, 100), 30); // crosses at the third vote
  assert.equal(quorumReachedTs(votes, 90), 20);
  assert.equal(quorumReachedTs(votes, 500), 'NOT_REACHED_IN_RETRIEVED_TIMELINE');
  assert.equal(quorumReachedTs([{ created: 10, vp: null }], 5), 'UNKNOWN'); // partial vp -> no claim
  assert.equal(quorumReachedTs(votes, 0), 'UNKNOWN'); // no quorum defined -> no claim
});

// §19.15 GOVERNANCE KNOWLEDGE TIME — a vote cast at 14:03 is invisible at 14:02;
// final scores are invisible before voting close.
test('GOVERNANCE KNOWLEDGE TIME: votes and final scores are invisible before their availableTs', async () => {
  const p = proposal(1);
  const voteCreated = p.start + 3 * 60; // cast 3 minutes after voting starts
  const fetchImpl = async (_url, opts) => {
    const q = JSON.parse(opts.body).query;
    if (q.includes('proposals(')) {
      const skip = Number(q.match(/skip: (\d+)/)[1]);
      return gqlResponse({ proposals: skip === 0 ? [p] : [] });
    }
    return gqlResponse({ votes: [{ voter: 'a', created: voteCreated, choice: 1, vp: 60 }, { voter: 'b', created: voteCreated + 600, choice: 1, vp: 50 }] });
  };
  const { records } = await fetchGovernance(['UNI'], { fetchImpl });
  assert.equal(records.length, 1);
  const rec = records[0];
  // each vote's availableTs is its own public timestamp
  assert.equal(rec.voteTimeline[0].created, voteCreated);
  assert.equal(knowableAt(rec.voteTimeline[0].created, voteCreated - 60), false); // 14:02: blind
  assert.equal(knowableAt(rec.voteTimeline[0].created, voteCreated), true); // 14:03: visible
  // final scores + lock analysis become knowable only at voting close
  assert.equal(rec.provenance.finalScores.availableTs, p.end);
  assert.equal(knowableAt(rec.provenance.finalScores.availableTs, p.end - 1), false);
  assert.equal(rec.provenance.proposalExistence.availableTs, p.created);
  // quorum-reached reconstructed deterministically from the timeline
  assert.equal(rec.quorumReachedTs, voteCreated + 600);
  // no proof basis exists for a mathematical lock from snapshot data
  assert.equal(rec.mathematicallyLockedTs, 'UNKNOWN');
  assert.equal(JSON.stringify(rec).includes('STATISTICALLY_NEAR_CERTAIN'), false);
});

// §19.16 INCIDENT FIRST-PUBLIC ORDERING — array position can never set the timestamp.
test('INCIDENT FIRST-PUBLIC: earliest public timestamp wins under ANY array ordering', () => {
  const updates = [
    { created_at: '2026-01-05T11:00:00Z' },
    { created_at: '2026-01-05T09:58:00Z' }, // the true first public word, mid-array
    { created_at: '2026-01-05T12:30:00Z' },
  ];
  const base = { created_at: '2026-01-05T10:00:00Z' };
  const expected = '2026-01-05T09:58:00.000Z';
  assert.equal(firstPublicTsOf({ ...base, incident_updates: updates }), expected);
  assert.equal(firstPublicTsOf({ ...base, incident_updates: [...updates].reverse() }), expected);
  assert.equal(firstPublicTsOf({ ...base, incident_updates: [updates[2], updates[0], updates[1]] }), expected);
  // no updates -> creation time; garbage timestamps are ignored, not guessed
  assert.equal(firstPublicTsOf({ ...base, incident_updates: [] }), '2026-01-05T10:00:00.000Z');
  assert.equal(firstPublicTsOf({ ...base, incident_updates: [{ created_at: 'not-a-time' }] }), '2026-01-05T10:00:00.000Z');
  assert.equal(firstPublicTsOf({}), null);
  assert.equal(firstPublicTsOf(null), null);
});
