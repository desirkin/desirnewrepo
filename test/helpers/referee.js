// RESEARCH REFEREE test helpers: deterministic synthetic bundles (a seeded generator, never Math.random), a full
// manifest with every closed field, a registry with a fake code identity, and the bundle constructor. Every fixture
// is visibly FIXTURE provenance; nothing here reads a clock, a network or the paper runtime.
import { sha256Hex, createRng } from '../../research/referee/contracts.js';
import { createRegistry, registerExperiment, registrySnapshot } from '../../research/referee/registry.js';
import { buildBundle } from '../../research/referee/seal.js';
import { refereeEvaluate, resultSharpesOf } from '../../research/referee/evaluate.js';
import { recordResult } from '../../research/referee/registry.js';
import { openProspective } from '../../research/referee/prospective.js';

export const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // a Monday
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DIG = (s) => sha256Hex(String(s));
export const CODE_IDENTITY = Object.freeze({ gitCommit: 'a'.repeat(40), sourceTreeSha256: DIG('referee-fixture-source'), law: 'PRODUCED_BY_COMMITTED_SOURCE' });
export const SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL']);

export const feature = (name, over = {}) => ({ name, definitionDigest: DIG(`feature:${name}`), scope: 'SYMBOL', kind: 'NUMERIC', inputs: ['TAPE_RETURNS'], lookbackMs: 30 * MIN, normalization: 'NONE', vintage: 'POINT_IN_TIME', ...over });
export const condition = (op = 'GT', threshold = 0, quantile = null) => ({ op, threshold, quantile });
export function manifest(over = {}, dataset = null) {
  const base = {
    manifestVersion: 'serpent-referee-experiment-1', name: 'fixture-experiment', familyTag: 'FIXTURE_FAMILY', evaluationType: 'FORWARD_RETURN', hypothesisOrigin: 'BEFORE_INSPECTING_OUTCOMES', parentExperimentId: null, reason: 'synthetic acceptance fixture',
    dataset: dataset ? { datasetId: dataset.datasetId, manifestDigest: dataset.manifestDigest, startTs: dataset.startTs, endTs: dataset.endTs, asOfTs: dataset.asOfTs } : { datasetId: 'ds', manifestDigest: 'f'.repeat(64), startTs: T0, endTs: T0 + HOUR, asOfTs: T0 + 2 * HOUR },
    universe: { definition: 'DECLARED_STATIC_LIST', digest: DIG(`universe:${(dataset ? dataset.symbolScope : SYMBOLS).join(',')}`), symbolScope: dataset ? [...dataset.symbolScope] : [...SYMBOLS] }, sources: ['TAPE'],
    features: [feature('SIG')], signal: { feature: 'SIG', condition: condition('GT', 0) }, candidates: [], primaryCandidateId: null,
    label: { definition: 'FORWARD_LOG_RETURN_PCT', horizonMs: HOUR, knownAtRule: 'HORIZON_END', unit: 'LOG_RETURN_PCT' }, outcome: { kind: 'FORWARD_LOG_RETURN', definitionDigest: DIG('outcome:forward-log-return') },
    direction: 'POSITIVE', primaryMetric: 'SHARPE_PER_OBS', secondaryMetrics: ['MEAN_CONDITIONAL_RETURN', 'RANK_IC'],
    split: { method: 'PURGED_KFOLD', groups: 5, testGroups: 1, embargoMs: HOUR, purge: true, minTestObservations: 20, cscvGroups: 6, holdout: null }, baseline: { kind: 'UNCONDITIONAL_MEAN' },
    controls: { blockLengthRule: 'MAX_OVERLAP_PLUS_ONE', blockLengthRows: null, shiftCount: 30, permutationIterations: 200, bootstrapIterations: 200, nullFeatureTrials: 30, symbolPlacebo: false, horizonProfile: false },
    stability: { neighbors: [], leaveOneBlockOut: true, blocks: 5, leaveOneSymbolOut: true, earlyLate: true, regimeFeature: null, dayOfWeek: false, minPartitionRows: 20 },
    criteria: { nullAlpha: 0.05, minDsr: 0.95, maxPbo: 0.2, minDirectionConsistency: 0.8, maxConcentrationShare: 0.6, minOosPathsPositive: 0.75 },
    economics: null, prospective: null, parameters: {},
  };
  return { ...base, ...over };
}
// synthetic rows: per step t and symbol s an outcome y ~ N(0,1) (log-return pct) and features built by `features(rng, y, t, s)`
export function synth({ steps = 200, symbols = SYMBOLS, spacingMs = 5 * MIN, horizonMs = HOUR, seed = 'fixture', features, knownLagMs = 1000, horizonValues = false, regime = null, datasetId = 'ds-fixture' } = {}) {
  const rng = createRng(seed); const observations = []; const outcomes = [];
  for (let t = 0; t < steps; t += 1) for (const s of symbols) {
    const ts = T0 + t * spacingMs; const y = rng.normal(); const f = features(rng, y, t, s);
    observations.push({ id: `${s}-${t}`, symbol: s, ts, featureKnownAtTs: ts - knownLagMs, receivedAtTs: ts - knownLagMs, referencePriceTs: ts - knownLagMs, features: f, featureClocks: {}, context: { regime: regime ? regime(rng, t, s) : null } });
    const hv = horizonValues ? { [String(horizonMs / 2)]: 0.7 * y + 0.5 * rng.normal(), [String(horizonMs)]: y, [String(horizonMs * 2)]: 0.7 * y + 0.5 * rng.normal() } : null;
    outcomes.push({ observationId: `${s}-${t}`, labelStartTs: ts, labelEndTs: ts + horizonMs, outcomeKnownAtTs: ts + horizonMs, state: 'KNOWN', value: y, horizonValues: hv, eventTs: null, priorSenseTs: null });
  }
  const endTs = T0 + (steps - 1) * spacingMs;
  return { observations, outcomes, dataset: { datasetId, symbolScope: [...symbols], startTs: T0, endTs, asOfTs: endTs + horizonMs + HOUR, source: 'FIXTURE', archive: null } };
}
export const mix = (rng, y, rho) => rho * y + Math.sqrt(1 - rho * rho) * rng.normal();
export const PROVENANCE = Object.freeze({ origin: 'FIXTURE', producer: 'REFEREE_TEST_HELPER', producerVersion: 'referee-fixture-1' });

// register manifests in order and return the registry + ids
export function registryWith(manifests, { startTs = T0 - 7 * 24 * HOUR } = {}) {
  let reg = createRegistry(); const ids = [];
  manifests.forEach((m, i) => { const r = registerExperiment(reg, m, { registeredAtTs: startTs + i * MIN, codeIdentity: CODE_IDENTITY }); if (r.error) throw new Error(`fixture registration failed: ${r.error.reason} ${r.error.detail ?? ''}`); reg = r.registry; ids.push(r.experimentId); });
  return { registry: reg, ids };
}
// a complete bundle for a manifest over synthetic data (the manifest's dataset section is filled from the data)
export function bundleFor({ manifestOver = {}, data, registry = null, seed = 'seed-1', requestedAtTs = T0 + 30 * 24 * HOUR, extraManifests = [] }) {
  const ds = { ...data.dataset, manifestVersion: 'serpent-referee-dataset-1', observationCount: data.observations.length, outcomeCount: data.outcomes.length, manifestDigest: null };
  const probe = buildBundle({ experiment: manifest({}, { ...ds, manifestDigest: 'f'.repeat(64) }), dataset: ds, observations: data.observations, outcomes: data.outcomes, provenance: PROVENANCE, codeIdentity: CODE_IDENTITY, registrySnapshot: registrySnapshot(createRegistry()), seed, requestedAtTs });
  const m = manifest({ ...manifestOver }, probe.dataset);
  let reg = registry; if (!reg) { try { reg = registryWith([...extraManifests, m]).registry; } catch { reg = createRegistry(); } }
  const bundle = buildBundle({ experiment: m, dataset: ds, observations: data.observations, outcomes: data.outcomes, provenance: PROVENANCE, codeIdentity: CODE_IDENTITY, registrySnapshot: registrySnapshot(reg), seed, requestedAtTs });
  return { bundle, manifest: m, registry: reg };
}
// FIXTURE 1 — a real effect: SIG carries rho = 0.3 of the forward return
export const realEffectData = (seed = 'real-effect') => synth({ seed, steps: 400, features: (rng, y) => ({ SIG: mix(rng, y, 0.4) }) });
// FIXTURE 2 — pure noise, K candidate features
export const noiseData = (k = 40, seed = 'noise') => synth({ seed, features: (rng) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`F${i + 1}`, rng.normal()])) });
// FIXTURE 3 — a hidden future-derived predictor with honest-looking clocks
export const leakData = (seed = 'leak') => synth({ seed, steps: 400, features: (rng, y) => ({ SIG: mix(rng, y, 0.4), LEAK: y + 0.001 * rng.normal() }) });
// FIXTURE 4 — an effect at exactly one parameter cell: P5 carries rho = 0.3, P4 / P6 are independent noise
export const knifeEdgeData = (seed = 'knife') => synth({ seed, steps: 400, features: (rng, y) => ({ SIG_P4: rng.normal(), SIG_P5: mix(rng, y, 0.4), SIG_P6: rng.normal() }) });

// A prospective shadow opened lawfully: evaluate a real-effect bundle, record its result, open the shadow. Returns the
// registry at the moment of opening plus the sealed design, so a test can reason about clocks relative to `openedAtTs`.
export function prospectiveSetup({ terminalObservations = 5, bundle = null, registry = null, report = null, data = null } = {}) {
  let b = bundle; let reg = registry; let rep = report;
  if (!b) { const built = bundleFor({ data: data ?? realEffectData('prospective-setup'), manifestOver: { prospective: { terminalObservations, horizonMs: HOUR, universeRule: 'DECLARED_STATIC_LIST', sequentialMethod: null } } }); b = built.bundle; reg = built.registry; }
  if (!rep) rep = refereeEvaluate(b);
  if (rep.verdict.verdict !== 'HISTORICALLY_INTERESTING') throw new Error(`fixture verdict ${rep.verdict.verdict}`);
  const experimentId = rep.identity.experimentId; const t1 = b.evaluation.requestedAtTs + MIN;
  const recorded = recordResult(reg, { experimentId, reportDigest: rep.reportDigest, verdict: rep.verdict.verdict, primaryMetric: { name: rep.primaryResult.metric, value: rep.primaryResult.value }, sharpes: resultSharpesOf(rep), datasetDigest: b.dataset.manifestDigest, recordedAtTs: t1 });
  if (recorded.error) throw new Error(`fixture result: ${recorded.error.reason}`);
  const opened = openProspective(recorded.registry, { experimentId, historicalReport: rep, ts: t1 + MIN });
  if (opened.error) throw new Error(`fixture open: ${opened.error.reason} ${opened.error.detail ?? ''}`);
  return { registry: opened.registry, experimentId, report: rep, bundle: b, design: opened.design, designDigest: opened.designDigest, openedAtTs: t1 + MIN };
}
