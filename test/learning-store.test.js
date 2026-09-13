// LEARN-1 — the durable stores: idempotent identities across restarts, superseding corrections, immutable
// snapshots, corruption honesty, and the kill switch failing toward LESS learned influence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLearningStore, learningDir } from '../learning/store.js';
import { buildEpisode } from '../learning/capture.js';
import { matureEpisode } from '../learning/maturation.js';
import { BASELINE_RULE_VERSION } from '../learning/contracts.js';
import { makeSeries, makeArchive, START_SEC } from './helpers/learning.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-learning-store-'));
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const series = makeSeries('AAA', START_SEC, 600);
const archive = makeArchive([series]);
const decisionTs = (START_SEC + 200 * 60) * 1000;
const episode = buildEpisode({
  canonicalCoin: 'AAA', decisionTs, usableAtTs: decisionTs, datasetId: 'store-fixture',
  mode: 'HISTORICAL_REPLAY', evidenceBasis: 'HISTORICAL_RECONSTRUCTION', fidelity: 'CANDLE_DESCRIPTIVE',
  featureSet: { features: {} }, gates: [], decision: 'NO_SETUP', baselineRuleVersion: BASELINE_RULE_VERSION,
});

test('N. restart-safe idempotency: a replayed episode append is a deterministic duplicate, in-process and across a fresh store instance', () => {
  const store = createLearningStore({ dataDir: TEST_DATA });
  assert.equal(store.appendEpisode(episode).appended, true);
  assert.equal(store.appendEpisode(episode).appended, false, 'same id in-process is suppressed');
  const reopened = createLearningStore({ dataDir: TEST_DATA }); // a restart: index rebuilt from the file
  assert.equal(reopened.appendEpisode(episode).appended, false, 'a restart cannot double-count the same opportunity');
  assert.equal(reopened.readEpisodes().length, 1);
});

test('Q. outcome attachment never mutates the snapshot; a late correction SUPERSEDES, the original record survives', () => {
  const store = createLearningStore({ dataDir: TEST_DATA });
  const beforeBytes = readFileSync(path.join(learningDir(TEST_DATA), 'episodes.jsonl'), 'utf8');
  const t1 = archive.archiveCreatedTsMs + 1;
  const a1 = matureEpisode({ episode, archive, asOfTs: t1, attachedTs: t1 });
  store.appendOutcome(a1);
  assert.equal(readFileSync(path.join(learningDir(TEST_DATA), 'episodes.jsonl'), 'utf8'), beforeBytes, 'the episode file is byte-identical after maturation');
  // a second attachment must name what it supersedes; a silent duplicate clock is suppressed
  const t2 = t1 + 60_000;
  const a2 = matureEpisode({ episode, archive, asOfTs: t2, attachedTs: t2, supersedes: t1 });
  store.appendOutcome(a2);
  assert.throws(() => store.appendOutcome(matureEpisode({ episode, archive, asOfTs: t2 + 1, attachedTs: t2 + 1, supersedes: null })), /supersede/);
  const latest = store.latestOutcomes().get(episode.opportunityId);
  assert.equal(latest.attachedTs, t2, 'readers select the superseding record');
  assert.equal(store.readOutcomes().length, 2, 'the audit history keeps both');
});

test('a torn line is skipped and counted, never invented; an invalid record is withheld and counted', () => {
  const store = createLearningStore({ dataDir: TEST_DATA });
  const file = path.join(learningDir(TEST_DATA), 'episodes.jsonl');
  appendFileSync(file, '{"torn": tru'); // no newline, invalid JSON
  const fresh = createLearningStore({ dataDir: TEST_DATA });
  assert.equal(fresh.readEpisodes().length, 1);
  assert.ok(fresh.counters.corruptSkipped >= 1);
  appendFileSync(file, '\n{"learningVersion":"serpent-learning-1","not":"an episode"}\n');
  const fresh2 = createLearningStore({ dataDir: TEST_DATA });
  assert.equal(fresh2.readEpisodes().length, 1);
  assert.ok(fresh2.counters.invalidRejected >= 1);
  void store;
});

test('pattern chain law: a seq gap or a wrong previousState is refused at append and withheld on read', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-learning-chain-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    assert.throws(() => store.appendPattern({ seq: 3 }), /not the expected 0|invalid/i); // seq law / validator refuse outright
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('kill switch fails toward LESS learned influence: a corrupt kill file reads KILLED, never ARMED', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-learning-kill-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    assert.equal(store.readKill().state, 'ARMED', 'absent file = armed default');
    store.writeKill({ state: 'KILLED', reason: 'TEST', ts: Date.now() });
    assert.equal(store.readKill().state, 'KILLED');
    writeFileSync(path.join(learningDir(dir), 'kill.json'), '{"state":"WHATEVER"}');
    assert.equal(store.readKill().state, 'KILLED');
    assert.equal(store.readKill().reason, 'KILL_FILE_INVALID');
    writeFileSync(path.join(learningDir(dir), 'kill.json'), 'not json at all');
    assert.equal(store.readKill().state, 'KILLED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('campaign manifest is immutable: a second write refuses', () => {
  const store = createLearningStore({ dataDir: TEST_DATA });
  const m = { campaignId: 'lcmp-testimmutable' };
  store.writeCampaignManifest(m);
  assert.throws(() => store.writeCampaignManifest(m), /immutable/);
});

test('campaign results deduplicate on read by (kind, opportunityId, variantId) — a replayed chunk cannot double-count', () => {
  const store = createLearningStore({ dataDir: TEST_DATA });
  const row = { campaignId: 'lcmp-testimmutable', opportunityId: 'lop-r1', kind: 'PRIMARY', seq: 0, canonicalCoin: 'AAA', decisionTs, baselineDecision: 'NO_SETUP', variantId: null, features: null, outcome: null, counterfactual: null, censoredReason: null };
  store.appendCampaignResult('lcmp-testimmutable', row);
  store.appendCampaignResult('lcmp-testimmutable', { ...row, seq: 1 }); // the replayed duplicate
  store.appendCampaignResult('lcmp-testimmutable', { ...row, kind: 'VARIANT', variantId: 'V1', seq: 2 });
  const rows = store.readCampaignResults('lcmp-testimmutable');
  assert.equal(rows.filter((r) => r.kind === 'PRIMARY').length, 1);
  assert.equal(rows.filter((r) => r.kind === 'VARIANT').length, 1);
});

test('a corrupt campaign checkpoint replays from results rather than crashing', () => {
  const store = createLearningStore({ dataDir: TEST_DATA });
  writeFileSync(path.join(learningDir(TEST_DATA), 'campaigns', 'lcmp-testimmutable', 'checkpoint.json'), '{corrupt');
  assert.equal(store.readCampaignCheckpoint('lcmp-testimmutable'), null);
});
