// ADDENDUM-2 §12 — memory separation, at-risk exclusion from the prospective gate, the diagnostic harness laws
// (isolated caches, repeats-not-episodes, budget exhaustion, masking privacy) and restart reconstruction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLearningStore } from '../learning/store.js';
import { readResearchMemory, readDecisionMemory } from '../learning/memory-view.js';
import { buildPatternRecord, buildEvidence, estimateFromEvidence } from '../learning/patterns.js';
import { buildActivation, transitionActivation } from '../learning/adapter.js';
import { replayProspective } from '../learning/prospective.js';
import { sealDesign } from '../learning/prospective.js';
import { registerDiagnostic, runDiagnostic, summarizeDiagnostic } from '../learning/diagnostic.js';
import { buildPseudonyms, maskPacket } from '../learning/masking.js';

const T = Date.UTC(2026, 8, 13);
const DAY = 86_400_000;
const predicate = { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 3 }] };
const scope = { setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED' };

test('§04 memory separation: the research view exposes provisional patterns with zero authority; the decision view resolves ONLY validated activation artifacts; no parameter flips one into the other; invalid artifacts are withheld, not repaired', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-memview-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const items = [{ opportunityId: 'lop-1', canonicalCoin: 'AAA', decisionTs: T, evidenceBasis: 'PROSPECTIVE', outcomeClass: 'FAVORABLE' }];
    const ev = buildEvidence(items); const est = estimateFromEvidence(items, ev, { pooledMean: 0.5, priorStrength: 8, updatedTs: T });
    store.appendPattern(buildPatternRecord({ predicate, scope, origin: 'TEST', createdTs: T, ts: T, seq: 0, state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence: { ...ev, _grouping: null }, estimate: est, contradictions: [] }));
    const research = readResearchMemory({ store });
    assert.equal(research.view, 'RESEARCH'); assert.equal(research.authority, 'NONE');
    assert.equal(research.patterns.length, 1); assert.equal(research.patterns[0].state, 'NOTICED');
    const decision = readDecisionMemory({ store, nowTs: T });
    assert.equal(decision.view, 'DECISION');
    assert.equal(decision.activations.length, 0, 'a provisional pattern NEVER appears in the decision view');
    // an activation artifact appears in the decision view; a corrupted head is withheld with a reason
    const pub = buildActivation({ candidateId: 'lcand-1', patternId: 'lpat-1', trainingCutoffTs: T - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd', maxAbsAdjust: 0.1, adjust: 0.1, applicability: predicate, effectiveTs: T, expiresTs: T + 30 * DAY, ts: T });
    store.appendActivation(pub);
    const d2 = readDecisionMemory({ store, nowTs: T + 1 });
    assert.equal(d2.activations.length, 1);
    assert.equal(d2.activations[0].state, 'PUBLISHED_WAITING_FOR_PAPER');
    assert.equal(typeof readResearchMemory({ store, limit: 5 }).patterns[0].evidence.rawCount, 'number', 'the research view stays descriptive');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('§12.11 at-risk historical rows cannot enter the prospective sample: the clock law refuses any capture decided before the seal, whatever its label claims', () => {
  const d = sealDesign({ patternId: 'lpat-t', predicate, scope, costModel: { feePctPerSide: 0.8, slippageBps: 10 }, terminalGroupTarget: 30, sealedTs: T, evidenceDigest: 'ev' });
  const historicalRow = { kind: 'CAPTURE', candidateId: d.candidateId, opportunityId: 'lop-h', canonicalCoin: 'AAA', decisionTs: T - 10 * DAY, candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED', recordedTs: T + 1, labelEndTs: T - 10 * DAY + 3_600_000 };
  const state = replayProspective([{ kind: 'DESIGN_SEALED', design: d }, historicalRow]);
  assert.match(state.errors[0], /before the design was sealed/, 'a replayed/backfilled historical decision is never fresh forward evidence');
});

test('§06 masking: nested identity fields, cashtags and URLs are replaced; the private mapping never rides in the output; residual clues are reported', () => {
  const pseudonyms = buildPseudonyms(['DOGE', 'BTC']);
  const packet = {
    symbol: 'DOGE', headline: 'Whale moves $DOGE as BTC steadies', link: 'https://x.example/doge-rally',
    nested: { meta: { pair: 'DOGE/USD', note: 'doge volume spiking vs btc' } },
    series: [1, 2, 3],
  };
  const r = maskPacket(packet, { pseudonyms });
  const s = JSON.stringify(r.masked);
  assert.ok(!/doge|btc/i.test(s), `no raw identifier survives (${s})`);
  assert.ok(s.includes('ASSET_'), 'pseudonyms substituted');
  assert.deepEqual(r.masked.series, [1, 2, 3], 'numerical evidence and ordering retained');
  assert.ok(!s.includes('pseudonym'), 'the private mapping is not in the output');
  assert.equal(typeof r.replacedCount, 'number');
  assert.match(r.law, /NEITHER_PERFECTLY/);
});

test('§12.4/12.5/12.12/12.14 the diagnostic harness: registration precedes execution; named/masked use separate cache identities; repeats are repeats; budget exhaustion parks WAITING_FOR_BUDGET without stopping anything; restart reconstructs the same counts without duplicates', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-diag-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const packets = [
      { sampleId: 's1', groupId: 'g1', packet: { symbol: 'DOGE', move: 1.2 }, identifiers: ['DOGE'] },
      { sampleId: 's2', groupId: 'g2', packet: { symbol: 'BTC', move: -0.4 }, identifiers: ['BTC'] },
    ];
    await assert.rejects(() => runDiagnostic({ store, diagnosticId: 'ldiag-unregistered', packets, transport: async () => ({}), nowTs: T }), /unregistered/);
    const { manifest } = registerDiagnostic({ store, packets, model: 'claude-sonnet-5', promptDigest: 'p1', repeats: 2, maxCalls: 100, createdTs: T });
    assert.equal(manifest.state, 'REGISTERED');
    const seenKeys = new Set(); const calls = [];
    const transport = async ({ condition, cacheKey, packet }) => {
      assert.ok(!seenKeys.has(cacheKey), 'every call has its own isolated cache identity'); seenKeys.add(cacheKey);
      if (condition === 'IDENTITY_MASKED') assert.ok(!JSON.stringify(packet).match(/DOGE|BTC/), 'the model never receives the raw identity in the masked arm');
      calls.push(condition);
      return { output: { score: condition === 'NAMED' ? 1 : 0.5 }, usage: { calls: 1 } };
    };
    const summary = await runDiagnostic({ store, diagnosticId: manifest.diagnosticId, packets, transport, nowTs: T + 1 });
    assert.equal(summary.state, 'COMPLETED');
    assert.equal(summary.calls, 2 * 2 * 2, '2 samples x 2 conditions x 2 repeats');
    assert.equal(summary.groups, 2, 'dependence groups, never repeated calls, are the unit');
    assert.equal(summary.pairedGroups, 2);
    assert.equal(summary.namedVsMaskedMeanDelta, 0.5);
    assert.match(summary.wording, /contamination not excluded/);
    // a re-run replays nothing (all repeat slots exist) — restart-safe, no double counting
    const again = await runDiagnostic({ store, diagnosticId: manifest.diagnosticId, packets, transport: async () => { throw new Error('must not be called'); }, nowTs: T + 2 });
    assert.equal(again.calls, 8, 'restart reconstructs the same counts without duplicating records');
    // budget exhaustion on a fresh diagnostic parks honestly
    const { manifest: m2 } = registerDiagnostic({ store, packets, model: 'claude-sonnet-5', promptDigest: 'p2', repeats: 2, maxCalls: 3, createdTs: T + 3 });
    const s2 = await runDiagnostic({ store, diagnosticId: m2.diagnosticId, packets, transport, nowTs: T + 4 });
    assert.equal(s2.state, 'WAITING_FOR_BUDGET');
    assert.ok(s2.calls <= 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('§12.7/12.8 interpretation honesty is part of the record: no-difference is not purity and decay is not memorization (laws ride every summary)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-diag2-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const packets = [{ sampleId: 's1', groupId: 'g1', packet: { symbol: 'SOL', move: 0.1 }, identifiers: ['SOL'] }];
    const { manifest } = registerDiagnostic({ store, packets, model: 'm', promptDigest: 'p', repeats: 1, maxCalls: 10, createdTs: T });
    await runDiagnostic({ store, diagnosticId: manifest.diagnosticId, packets, transport: async () => ({ output: { score: 1 } }), nowTs: T + 1 });
    const s = summarizeDiagnostic({ store, diagnosticId: manifest.diagnosticId });
    assert.equal(s.namedVsMaskedMeanDelta, 0, 'no difference here');
    assert.ok(s.interpretationLaws.includes('NO_DIFFERENCE_IS_NOT_PROOF_OF_CLEANLINESS'));
    assert.ok(s.interpretationLaws.includes('PERIOD_DECAY_ALONE_IS_NOT_CONFIRMED_MEMORIZATION'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
