// LEARN-1 §17 — the resumable offline counterfactual campaign ("what if I had selected this?").
//
// Three modes stay separate (HISTORICAL_REPLAY / PROSPECTIVE_SHADOW / SYNTHETIC_STRESS; the continuous service owns
// prospective capture — this runner executes replay and synthetic stress only). The campaign manifest is persisted
// BEFORE execution and is immutable. Enumeration is deterministic and OUTCOME-INDEPENDENT: sorted assets x an
// aligned decision-time grid inside each asset's supported window — never a winner-selected sample. One primary
// opportunity = asset + decision time + capture recipe + dataset identity; variants (e.g. delayed entry) carry
// their own counters and NEVER increment the primary count. Missing history is CENSORED, never fabricated to reach
// a target; if the supported history holds fewer opportunities than the target, the campaign completes as
// EXHAUSTED_SUPPORTED_HISTORY with the exact shortage.
//
// Time truth: at historical T the runner sees only bars closing at or before T (buildFeatures enforces the wall);
// the later path is consumed only by the label recipe, whose knowledge floors carry the archive creation clock —
// replay evidence is HISTORICAL_RECONSTRUCTION, separately countable, never prospective confirmation. A delayed
// variant decides at ITS OWN later clock over ITS OWN feature window and pays the later supported price.
//
// Local simulations make no order calls and no per-trial network or LLM calls: this module imports no transport,
// no provider client and no execution path. Resume: results are appended with idempotent identities and the
// checkpoint is advisory — counts and aggregates are always derived from the deduplicated validated read, so a
// crash mid-chunk replays without double-counting and a restarted campaign equals an uninterrupted run.
import {
  CAMPAIGN_MANIFEST_VERSION, CAPTURE_RECIPE_VERSION, AUTHORITY, PURPOSE, LIMITS,
  campaignIdOf, campaignManifestError, opportunityIdOf, utcDateOf, isTs, deepFreeze,
} from './contracts.js';
import { buildFeatures, baselineDecision, WARMUP_BARS } from './features.js';
import { FEATURE_RECIPE_VERSION, BASELINE_RULE_VERSION } from './contracts.js';
import { labelOpportunity } from './labels.js';
import { classifyOutcome, simulateExecution } from './maturation.js';
import { EPISODE_WINDOW_MS } from './grouping.js';

export const MAX_HORIZON_MIN = 240;
export const DEFAULT_GRID_MINUTES = 30;
export const DELAYED_ENTRY_VARIANT = deepFreeze({ variantId: 'DELAYED_ENTRY_1BAR', extraDelayBars: 1, law: 'THE_VARIANT_DECIDES_AT_ITS_OWN_LATER_CLOCK_AND_PAYS_THE_LATER_PRICE' });

// ---- preflight: inspect the ACTUAL retained history; a working key is not proof data exists ----------------------
export function preflightCampaign({ archive, gridMinutes = DEFAULT_GRID_MINUTES, perAssetCap = null }) {
  const assets = [];
  let eligibleUnique = 0;
  for (const [symbol, series] of [...archive.oneMinute.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const windows = enumerationWindow(series, gridMinutes);
    const count = windows === null ? 0 : Math.min(windows.count, perAssetCap ?? Infinity);
    eligibleUnique += count;
    assets.push({ symbol, bars: series.count, fromSec: series.firstOpenSec, toSec: series.lastOpenSec, coverageEndSec: series.coverageEndSec, eligibleDecisions: count });
  }
  return deepFreeze({
    datasetKind: 'CHILDHOOD_ARCHIVE', archiveCreatedTsMs: archive.archiveCreatedTsMs, limitations: archive.limitations,
    assets, assetCount: assets.length, eligibleUniqueOpportunities: eligibleUnique,
    gridMinutes, warmupBars: WARMUP_BARS, maxHorizonMin: MAX_HORIZON_MIN,
    law: 'ELIGIBLE_COUNT_FROM_ACTUAL_RETAINED_BARS_NOT_A_PROMISE',
  });
}

function enumerationWindow(series, gridMinutes) {
  if (!series || series.count === 0) return null;
  const step = gridMinutes * 60;
  const firstDecision = Math.ceil((series.firstOpenSec + WARMUP_BARS * 60) / step) * step;
  const lastDecision = Math.floor((series.coverageEndSec - MAX_HORIZON_MIN * 60) / step) * step;
  if (lastDecision < firstDecision) return null;
  return { firstDecision, lastDecision, step, count: Math.floor((lastDecision - firstDecision) / step) + 1 };
}

// ---- declaration ----------------------------------------------------------------------------------------------------
export function declareCampaign({
  store, createdTs, mode = 'HISTORICAL_REPLAY', fidelity = 'CANDLE_SIMULATED_EXECUTION', datasetId, datasetIdentity,
  universeRule = 'ALL_ARCHIVE_1M_SERIES', gridMinutes = DEFAULT_GRID_MINUTES, perAssetCap = null,
  discoveryValidationBoundaryTs = null, terminalTarget = 100_000, seed,
  feePctPerSide = 0.8, slippageBps = 10, entryDelayBars = 1,
  maxOpportunitiesPerRun = LIMITS.maxCampaignChunk, maxWallMsPerRun = 300_000, maxResultBytes = 512 * 1024 * 1024,
}) {
  const manifest = {
    campaignVersion: CAMPAIGN_MANIFEST_VERSION,
    campaignId: campaignIdOf({ createdTs, datasetId, mode, seed }),
    createdTs, mode, fidelity, datasetId, datasetIdentity, universeRule,
    samplingSchedule: { kind: 'OUTCOME_INDEPENDENT_GRID', gridMinutes, perAssetCap },
    captureRecipeVersion: CAPTURE_RECIPE_VERSION, featureRecipeVersion: FEATURE_RECIPE_VERSION, baselineRuleVersion: BASELINE_RULE_VERSION,
    candidateVersions: [DELAYED_ENTRY_VARIANT.variantId],
    discoveryValidationBoundaryTs,
    horizonsMin: [1, 3, 5, 15, 30, 60, 240],
    costAssumptions: { feePctPerSide, slippageBps, entryDelayBars, intrabarRule: 'UNRESOLVED' },
    resourceBudget: { maxOpportunitiesPerRun, maxWallMsPerRun, maxResultBytes },
    terminalTarget, seed, authority: AUTHORITY, purpose: PURPOSE,
  };
  const err = campaignManifestError(manifest); if (err) throw new Error(`declareCampaign: ${err}`);
  store.writeCampaignManifest(manifest); // BEFORE any execution; immutable (a second write refuses)
  store.writeCampaignCheckpoint(manifest.campaignId, { state: 'DECLARED', cursor: { assetIndex: 0, gridIndex: 0 }, updatedTs: createdTs });
  return deepFreeze(manifest);
}

// ---- one bounded resumable chunk -------------------------------------------------------------------------------------
export function runCampaignChunk({ store, campaignId, archive, nowTs, maxOpportunities = null, maxWallMs = null, wallClock = () => Date.now() }) {
  const manifest = store.readCampaignManifest(campaignId);
  if (!manifest) throw new Error('runCampaignChunk: unknown campaign');
  const mErr = campaignManifestError(manifest); if (mErr) throw new Error(`runCampaignChunk: stored manifest invalid: ${mErr}`);
  if (manifest.mode === 'PROSPECTIVE_SHADOW') throw new Error('runCampaignChunk: prospective capture belongs to the continuous service, not the replay runner');
  const budget = manifest.resourceBudget;
  const capOps = Math.min(maxOpportunities ?? budget.maxOpportunitiesPerRun, budget.maxOpportunitiesPerRun, LIMITS.maxCampaignChunk);
  const capWallMs = Math.min(maxWallMs ?? budget.maxWallMsPerRun, budget.maxWallMsPerRun);
  const startedWall = wallClock();
  const cp = store.readCampaignCheckpoint(campaignId) ?? { state: 'DECLARED', cursor: { assetIndex: 0, gridIndex: 0 }, updatedTs: nowTs };
  if (cp.state === 'COMPLETED' || cp.state === 'EXHAUSTED_SUPPORTED_HISTORY' || cp.state === 'PAUSED') return { manifest, chunk: { processed: 0, state: cp.state }, checkpoint: cp };
  const symbols = [...archive.oneMinute.keys()].sort();
  const grid = manifest.samplingSchedule.gridMinutes;
  const perAssetCap = manifest.samplingSchedule.perAssetCap;
  const evidenceBasis = manifest.mode === 'SYNTHETIC_STRESS' ? 'SYNTHETIC' : 'HISTORICAL_RECONSTRUCTION';
  let { assetIndex, gridIndex } = cp.cursor;
  let processed = 0; let seq = Number.isSafeInteger(cp.seq) ? cp.seq : 0;
  // resume truth: the deduplicated results file decides what already exists — a stale checkpoint replays a chunk,
  // and every already-recorded opportunity is skipped, so a crash can neither double-count nor stop early
  const existingPrimary = new Set(store.readCampaignResults(campaignId).filter((r) => r.kind === 'PRIMARY').map((r) => r.opportunityId));
  let primaryCount = existingPrimary.size;
  let state = 'RUNNING';
  while (assetIndex < symbols.length) {
    if (primaryCount >= manifest.terminalTarget) { state = 'COMPLETED'; break; }
    if (processed >= capOps) break;
    if (wallClock() - startedWall > capWallMs) break;
    const symbol = symbols[assetIndex];
    const series = archive.oneMinute.get(symbol);
    const win = enumerationWindow(series, grid);
    const assetTotal = win === null ? 0 : (perAssetCap === null ? win.count : Math.min(win.count, perAssetCap));
    if (win === null || gridIndex >= assetTotal) { assetIndex += 1; gridIndex = 0; continue; }
    const decisionSec = win.firstDecision + gridIndex * win.step;
    gridIndex += 1;
    const decisionTs = decisionSec * 1000;
    const opportunityId = opportunityIdOf({ canonicalCoin: symbol, decisionTs, captureRecipeVersion: manifest.captureRecipeVersion, datasetId: manifest.datasetId });
    if (existingPrimary.has(opportunityId)) continue; // a replayed chunk's already-recorded opportunity: skipped, never re-counted
    const rows = evaluateOpportunity({ manifest, archive, series, symbol, decisionSec, opportunityId, nowTs, seq, evidenceBasis });
    for (const row of rows) store.appendCampaignResult(campaignId, row);
    seq += rows.length;
    processed += 1;
    if (rows.some((r) => r.kind === 'PRIMARY')) { existingPrimary.add(opportunityId); primaryCount += 1; } // censored primaries still consume their unique slot (honest denominator)
  }
  if (assetIndex >= symbols.length && state === 'RUNNING') state = primaryCount >= manifest.terminalTarget ? 'COMPLETED' : 'EXHAUSTED_SUPPORTED_HISTORY';
  if (primaryCount >= manifest.terminalTarget) state = 'COMPLETED';
  const checkpoint = { state: state === 'RUNNING' ? 'RUNNING' : state, cursor: { assetIndex, gridIndex }, seq, updatedTs: nowTs };
  store.writeCampaignCheckpoint(campaignId, checkpoint);
  return { manifest, chunk: { processed, state: checkpoint.state, wallMs: wallClock() - startedWall }, checkpoint };
}

function compactFeatures(featureSet) {
  const out = {};
  for (const [k, f] of Object.entries(featureSet.features)) out[k] = f.availability === 'KNOWN' ? f.value : null;
  return out;
}

function evaluateOpportunity({ manifest, archive, series, symbol, decisionSec, opportunityId, nowTs, seq, evidenceBasis }) {
  const rows = [];
  const baseRow = (kind, variantId, body) => ({ campaignId: manifest.campaignId, opportunityId, kind, seq: seq + rows.length, canonicalCoin: symbol, decisionTs: decisionSec * 1000, variantId, ...body });
  const decide = (decisionAtSec) => {
    const lastClosedIdx = series.index.get(decisionAtSec - 60);
    if (lastClosedIdx === undefined) return null;
    const from = Math.max(0, lastClosedIdx - (WARMUP_BARS - 1));
    const bars = series.candles.slice(from, lastClosedIdx + 1);
    const featureSet = buildFeatures({ bars, decisionTsMs: decisionAtSec * 1000 });
    return { featureSet, decision: baselineDecision(featureSet) };
  };
  const outcomeOf = (decisionAtSec) => {
    const row = labelOpportunity(
      { rowId: opportunityId, canonicalCoin: symbol, decisionKnownAtTs: decisionAtSec * 1000 },
      { archive, asOfTs: nowTs },
    );
    const h60 = row.horizons['60m'];
    return { row, h60, class: classifyOutcome(h60) };
  };
  const base = decide(decisionSec);
  if (base === null) {
    rows.push(baseRow('PRIMARY', null, { baselineDecision: 'UNEVALUABLE', features: null, outcome: null, counterfactual: null, censoredReason: 'DECISION_BAR_MISSING' }));
    return rows;
  }
  const out = outcomeOf(decisionSec);
  const censoredReason = out.class === 'CENSORED' || out.class === 'UNAVAILABLE' ? (out.h60?.reason ?? 'OUTCOME_UNAVAILABLE') : null;
  let counterfactual = null;
  if (manifest.fidelity === 'CANDLE_SIMULATED_EXECUTION' && out.class !== 'UNAVAILABLE') {
    const sim = simulateExecution({ series, anchorTsMs: out.row.anchorTsMs, horizonMin: 60, feePctPerSide: manifest.costAssumptions.feePctPerSide, slippageBps: manifest.costAssumptions.slippageBps, entryDelayBars: manifest.costAssumptions.entryDelayBars });
    counterfactual = { state: sim.state, netPct: sim.state === 'ESTABLISHED' ? sim.netPct : null, grossPct: sim.state === 'ESTABLISHED' ? sim.grossPct : null, reasons: sim.reasons };
  }
  rows.push(baseRow('PRIMARY', null, {
    baselineDecision: base.decision.decision, features: compactFeatures(base.featureSet),
    outcome: { class: out.class, mfePct60m: out.h60?.mfePct ?? null, maePct60m: out.h60?.maePct ?? null, logReturnPct60m: out.h60?.logReturnPct ?? null, evidenceBasis },
    counterfactual, censoredReason,
  }));
  // the delayed-entry variant: a NEW decision at its own later clock, its own features, the later supported price.
  // It cannot keep the earlier price while using later confirming evidence, and it does not increment primary counts.
  const delaySec = DELAYED_ENTRY_VARIANT.extraDelayBars * 60;
  const late = decide(decisionSec + delaySec);
  if (late !== null) {
    const lateOut = labelOpportunity(
      { rowId: `${opportunityId}#late`, canonicalCoin: symbol, decisionKnownAtTs: (decisionSec + delaySec) * 1000 },
      { archive, asOfTs: nowTs },
    );
    const lh60 = lateOut.horizons['60m'];
    let lateCf = null;
    if (manifest.fidelity === 'CANDLE_SIMULATED_EXECUTION' && lh60.state === 'KNOWN') {
      const sim = simulateExecution({ series, anchorTsMs: lateOut.anchorTsMs, horizonMin: 60, feePctPerSide: manifest.costAssumptions.feePctPerSide, slippageBps: manifest.costAssumptions.slippageBps, entryDelayBars: manifest.costAssumptions.entryDelayBars });
      lateCf = { state: sim.state, netPct: sim.state === 'ESTABLISHED' ? sim.netPct : null, grossPct: sim.state === 'ESTABLISHED' ? sim.grossPct : null, reasons: sim.reasons };
    }
    rows.push(baseRow('VARIANT', DELAYED_ENTRY_VARIANT.variantId, {
      baselineDecision: late.decision.decision, features: compactFeatures(late.featureSet),
      outcome: { class: classifyOutcome(lh60), mfePct60m: lh60?.mfePct ?? null, maePct60m: lh60?.maePct ?? null, logReturnPct60m: lh60?.logReturnPct ?? null, evidenceBasis },
      counterfactual: lateCf, censoredReason: classifyOutcome(lh60) === 'CENSORED' ? lh60.reason : null,
    }));
  }
  return rows;
}

// ---- honest status: every count derived from the deduplicated validated read --------------------------------------
export function campaignStatus({ store, campaignId }) {
  const manifest = store.readCampaignManifest(campaignId);
  if (!manifest) return null;
  const cp = store.readCampaignCheckpoint(campaignId);
  const rows = store.readCampaignResults(campaignId);
  const primary = rows.filter((r) => r.kind === 'PRIMARY');
  const variants = rows.filter((r) => r.kind === 'VARIANT');
  const completed = primary.filter((r) => r.censoredReason === null);
  const censored = primary.filter((r) => r.censoredReason !== null);
  const classes = { FAVORABLE: 0, ADVERSE: 0, NEUTRAL: 0, CENSORED: 0, NOT_YET_KNOWN: 0, UNAVAILABLE: 0 };
  const groupKeys = new Set(); const assets = new Set(); const dates = new Set();
  for (const r of primary) {
    if (r.outcome) classes[r.outcome.class] += 1;
    groupKeys.add(`${r.canonicalCoin}:${Math.floor(r.decisionTs / EPISODE_WINDOW_MS)}`);
    assets.add(r.canonicalCoin); dates.add(utcDateOf(r.decisionTs));
  }
  const shortage = manifest.terminalTarget - primary.length;
  return deepFreeze({
    campaignId, mode: manifest.mode, fidelity: manifest.fidelity, state: cp?.state ?? 'DECLARED',
    terminalTarget: manifest.terminalTarget,
    primaryUnique: primary.length, completed: completed.length, censored: censored.length,
    variantEvaluations: variants.length, duplicateSkippedOnRead: store.counters.duplicateSuppressed,
    outcomeClasses: classes,
    estimatedIndependentGroups: groupKeys.size, groupLaw: 'EPISODE_WINDOW_APPROXIMATION_NOT_EXACT_INDEPENDENCE',
    distinctAssets: assets.size, distinctUtcDates: dates.size,
    shortageAgainstTarget: shortage > 0 ? shortage : 0,
    evidenceBasis: manifest.mode === 'SYNTHETIC_STRESS' ? 'SYNTHETIC' : 'HISTORICAL_RECONSTRUCTION',
    authority: AUTHORITY, purpose: PURPOSE,
  });
}

// ---- pause: an explicit checkpointed stop that retains every completed result -------------------------------------
export function pauseCampaign({ store, campaignId, nowTs }) {
  const cp = store.readCampaignCheckpoint(campaignId);
  if (!cp) throw new Error('pauseCampaign: unknown campaign');
  if (cp.state === 'RUNNING' || cp.state === 'DECLARED') {
    const next = { ...cp, state: 'PAUSED', updatedTs: nowTs };
    store.writeCampaignCheckpoint(campaignId, next);
    return next;
  }
  return cp;
}
export function resumeCampaign({ store, campaignId, nowTs }) {
  const cp = store.readCampaignCheckpoint(campaignId);
  if (!cp) throw new Error('resumeCampaign: unknown campaign');
  if (cp.state === 'PAUSED') { const next = { ...cp, state: 'RUNNING', updatedTs: nowTs }; store.writeCampaignCheckpoint(campaignId, next); return next; }
  return cp;
}
