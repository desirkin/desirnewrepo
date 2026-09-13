// LEARN-1 §17H — campaign acceptance: manifest-before-execution, restart mid-chunk equals an uninterrupted run,
// variants never inflate primary counts, missing history is censored (never fabricated), supported-history
// shortage is exact, modes/fidelities stay separated, and the runner touches no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLearningStore, learningDir } from '../learning/store.js';
import { declareCampaign, runCampaignChunk, campaignStatus, pauseCampaign, resumeCampaign, preflightCampaign } from '../learning/campaign.js';
import { makeSeries, makeArchive, START_SEC, rallyDrift, burstVolume } from './helpers/learning.js';

const DAY_BARS = 1440;
const archive = makeArchive([
  makeSeries('AAA', START_SEC, 3 * DAY_BARS, { drift: rallyDrift(700), volume: burstVolume(700) }),
  makeSeries('BBB', START_SEC, 3 * DAY_BARS, { drift: rallyDrift(1500), volume: burstVolume(1500) }),
  makeSeries('CCC', START_SEC, 2 * DAY_BARS, { gapAt: new Set([1000, 1001, 1002]) }),
]);
const NOW = archive.archiveCreatedTsMs + 86_400_000;

function declare(store, over = {}) {
  return declareCampaign({ store, createdTs: NOW, datasetId: 'fixture-camp', datasetIdentity: { kind: 'FIXTURE' }, mode: 'SYNTHETIC_STRESS', terminalTarget: over.terminalTarget ?? 60, seed: over.seed ?? 's1', gridMinutes: 30, ...over });
}

test('the manifest is persisted BEFORE execution and running an undeclared campaign refuses', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-camp-a-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    assert.throws(() => runCampaignChunk({ store, campaignId: 'lcmp-nope', archive, nowTs: NOW }), /unknown campaign/);
    const m = declare(store);
    assert.ok(store.readCampaignManifest(m.campaignId), 'manifest on disk before any result');
    assert.equal(store.readCampaignResults(m.campaignId).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('H-restart. a campaign interrupted mid-chunk (stale checkpoint, replayed chunk) ends with EXACTLY the ids, counts and aggregates of an uninterrupted run', () => {
  const runAll = (interrupt) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cobra-camp-b-'));
    const store = createLearningStore({ dataDir: dir });
    const m = declare(store);
    runCampaignChunk({ store, campaignId: m.campaignId, archive, nowTs: NOW, maxOpportunities: 25 });
    if (interrupt) {
      // simulate a crash between result append and checkpoint write: restore the PREVIOUS checkpoint so the
      // whole second chunk replays
      const cpFile = path.join(learningDir(dir), 'campaigns', m.campaignId, 'checkpoint.json');
      const cpAfter1 = readFileSync(cpFile, 'utf8');
      runCampaignChunk({ store, campaignId: m.campaignId, archive, nowTs: NOW, maxOpportunities: 25 });
      unlinkSync(cpFile);
      writeFileSync(cpFile, cpAfter1); // the crash: checkpoint never advanced
    }
    let guard = 0;
    while (guard++ < 50) {
      const r = runCampaignChunk({ store, campaignId: m.campaignId, archive, nowTs: NOW, maxOpportunities: 25 });
      if (r.chunk.state !== 'RUNNING') break;
    }
    const st = campaignStatus({ store, campaignId: m.campaignId });
    const ids = store.readCampaignResults(m.campaignId).map((r) => `${r.kind}|${r.opportunityId}|${r.variantId ?? ''}`).sort();
    rmSync(dir, { recursive: true, force: true });
    return { st, ids };
  };
  const clean = runAll(false);
  const crashed = runAll(true);
  assert.deepEqual(crashed.ids, clean.ids, 'identical result identities');
  assert.equal(crashed.st.primaryUnique, clean.st.primaryUnique);
  assert.equal(crashed.st.variantEvaluations, clean.st.variantEvaluations);
  assert.deepEqual(crashed.st.outcomeClasses, clean.st.outcomeClasses, 'identical aggregates');
  assert.equal(crashed.st.state, 'COMPLETED');
});

test('H-counts. variants and extra evaluations never increase the primary count or the independent-group estimate beyond the primary stream', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-camp-c-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const m = declare(store, { terminalTarget: 40 });
    let guard = 0;
    while (guard++ < 50) { const r = runCampaignChunk({ store, campaignId: m.campaignId, archive, nowTs: NOW, maxOpportunities: 25 }); if (r.chunk.state !== 'RUNNING') break; }
    const st = campaignStatus({ store, campaignId: m.campaignId });
    assert.equal(st.primaryUnique, 40);
    assert.ok(st.variantEvaluations > 0, 'variants exist');
    assert.ok(st.variantEvaluations + st.primaryUnique > st.primaryUnique, 'variants counted separately');
    assert.ok(st.estimatedIndependentGroups <= st.primaryUnique, 'groups never exceed primary rows');
    assert.ok(st.estimatedIndependentGroups < st.primaryUnique, 'adjacent grid decisions of one asset share groups');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('H-shortage. supported history below the target ends EXHAUSTED_SUPPORTED_HISTORY with the exact shortage — never padded to the number', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-camp-d-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const pf = preflightCampaign({ archive, gridMinutes: 30 });
    const m = declare(store, { terminalTarget: pf.eligibleUniqueOpportunities + 500, seed: 's2' });
    let guard = 0;
    while (guard++ < 200) { const r = runCampaignChunk({ store, campaignId: m.campaignId, archive, nowTs: NOW, maxOpportunities: 100 }); if (r.chunk.state !== 'RUNNING') break; }
    const st = campaignStatus({ store, campaignId: m.campaignId });
    assert.equal(st.state, 'EXHAUSTED_SUPPORTED_HISTORY');
    assert.equal(st.primaryUnique, pf.eligibleUniqueOpportunities, 'exactly the supported count, nothing invented');
    assert.equal(st.shortageAgainstTarget, 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('H-censoring + modes: gaps yield CENSORED rows with reasons; synthetic mode is labelled SYNTHETIC end-to-end; pause retains results and resume continues without duplication', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-camp-e-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    // the FIRST enumerated asset carries an interior gap, so censored primaries appear inside the target
    const gapped = makeArchive([makeSeries('AAA', START_SEC, 2 * DAY_BARS, { gapAt: new Set([600, 601, 602]) })]);
    const gappedNow = gapped.archiveCreatedTsMs + 86_400_000;
    const m = declareCampaign({ store, createdTs: gappedNow, datasetId: 'fixture-gap', datasetIdentity: { kind: 'FIXTURE' }, mode: 'SYNTHETIC_STRESS', terminalTarget: 60, seed: 's3', gridMinutes: 30 });
    const archive0 = archive; void archive0;
    const archive2 = gapped; const NOW2 = gappedNow;
    runCampaignChunk({ store, campaignId: m.campaignId, archive: archive2, nowTs: NOW2, maxOpportunities: 60 });
    pauseCampaign({ store, campaignId: m.campaignId, nowTs: NOW2 });
    const before = store.readCampaignResults(m.campaignId).length;
    const paused = runCampaignChunk({ store, campaignId: m.campaignId, archive: archive2, nowTs: NOW2, maxOpportunities: 60 });
    assert.equal(paused.chunk.processed, 0, 'a paused campaign processes nothing');
    assert.equal(store.readCampaignResults(m.campaignId).length, before, 'pause retains completed results');
    resumeCampaign({ store, campaignId: m.campaignId, nowTs: NOW2 });
    let guard = 0;
    while (guard++ < 50) { const r = runCampaignChunk({ store, campaignId: m.campaignId, archive: archive2, nowTs: NOW2, maxOpportunities: 60 }); if (r.chunk.state !== 'RUNNING') break; }
    const st = campaignStatus({ store, campaignId: m.campaignId });
    assert.equal(st.evidenceBasis, 'SYNTHETIC');
    const rows = store.readCampaignResults(m.campaignId);
    for (const r of rows.filter((x) => x.outcome)) assert.equal(r.outcome.evidenceBasis, 'SYNTHETIC', 'synthetic results carry their basis on every row');
    const censored = rows.filter((r) => r.kind === 'PRIMARY' && r.censoredReason !== null);
    assert.ok(censored.length > 0, 'the gapped series produces censored primaries');
    for (const c of censored) assert.equal(c.outcome === null || c.outcome.logReturnPct60m === null, true, 'censored rows expose no return');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no network and no order path: the campaign/service modules import no transport, provider, execution, judge, watch or tape module', () => {
  for (const f of ['campaign.js', 'service.js', 'maturation.js', 'prospective.js', 'adapter.js', 'store.js', 'continuous.js', 'promotion.js']) {
    const src = readFileSync(path.join(process.cwd(), 'learning', f), 'utf8');
    for (const forbidden of ["from '../execution", "from '../judge", "from '../watch", "from '../tape", "from '../socrates", "from '../rumor2", "from '../market-lab", "from '../research/referee", 'node:http', 'node:https', 'node:net', 'WebSocket', 'fetch(']) {
      assert.ok(!src.includes(forbidden), `${f} must not contain ${forbidden}`);
    }
  }
});
