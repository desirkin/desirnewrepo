// RESEARCH REFEREE — SEALING, VERIFICATION AND CODE IDENTITY. A report is reproducible from its sealed inputs: the
// same bundle re-evaluated yields the same canonical body and the same digest. `verifyReport` proves that, and refuses
// a report whose identity no longer matches the bundle it claims (a changed dataset manifest, a changed registry head,
// a changed experiment). Code identity reuses the research tier's discovered-source-closure law over the referee's own
// roots; this is the ONLY module in the package that may touch git, and only to name the bytes that produced a report.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { canonicalDigest, deepFreeze, sha256Hex, finding, REFEREE_VERSION, REPORT_VERSION } from './contracts.js';
import { ROOT, pipelineSourceClosure, identityLaw } from '../identity.js';
import { refereeEvaluate } from './evaluate.js';
import { bundleChecksumsOf, datasetManifestDigestOf } from './pitAudit.js';

export const REFEREE_ROOTS = Object.freeze(['research/referee/evaluate.js', 'research/referee/seal.js', 'research/referee/prospective.js', 'research/referee/store.js']);
export const refereeSourceClosure = () => pipelineSourceClosure(REFEREE_ROOTS);
// the three fields a bundle / registry record carries: commit (or null), the closure digest, the cleanliness law
export function refereeCodeIdentity() {
  const files = refereeSourceClosure(); const parts = files.map((f) => `${f}\n${sha256Hex(readFileSync(path.join(ROOT, f)))}\n`);
  let gitCommit = null; let gitSourceDirty = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); if (!/^[0-9a-f]{40}$/.test(gitCommit)) gitCommit = null; } catch { gitCommit = null; }
  if (gitCommit) { try { gitSourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...files], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim().length > 0; } catch { gitSourceDirty = null; } }
  return deepFreeze({ gitCommit, sourceTreeSha256: sha256Hex(parts.join('')), law: identityLaw({ gitCommit, gitSourceDirty }), sourceFiles: files.length, refereeVersion: REFEREE_VERSION });
}
// the closed bundle constructor: computes the dataset manifest digest and every checksum from the parts (never trusts a caller's copy)
export function buildBundle({ experiment, dataset, observations, outcomes, provenance, codeIdentity, registrySnapshot, seed, requestedAtTs }) {
  const ds = { ...dataset, manifestVersion: 'serpent-referee-dataset-1', observationCount: observations.length, outcomeCount: outcomes.length, manifestDigest: null };
  ds.manifestDigest = datasetManifestDigestOf(ds);
  const partial = { bundleVersion: 'serpent-referee-bundle-1', experiment, dataset: ds, observations, outcomes, provenance, codeIdentity: { gitCommit: codeIdentity.gitCommit, sourceTreeSha256: codeIdentity.sourceTreeSha256, law: codeIdentity.law }, registrySnapshot, checksums: null, seed, evaluation: { requestedAtTs } };
  return deepFreeze({ ...partial, checksums: bundleChecksumsOf(partial) });
}
export const reportBodyOf = (report) => { const { reportDigest, ...body } = report; return body; };
export const reportDigestOf = (report) => canonicalDigest(reportBodyOf(report));
// VERIFY: the report's digest recomputes from its own body, its identity names this bundle, and a fresh evaluation of
// the bundle reproduces the same digest. Any mismatch is a finding, never a silent pass.
export function verifyReport(report, bundle) {
  if (!report || report.reportVersion !== REPORT_VERSION) return { ok: false, finding: finding('SCHEMA', 'report version') };
  if (reportDigestOf(report) !== report.reportDigest) return { ok: false, finding: finding('CHECKSUM_MISMATCH', 'report digest does not recompute from its body') };
  const id = report.identity;
  if (id.datasetDigest !== bundle.dataset?.manifestDigest) return { ok: false, finding: finding('DATASET_IDENTITY_MISMATCH', 'the report was sealed over a different dataset manifest') };
  if (id.manifestDigest !== bundle.checksums?.experiment) return { ok: false, finding: finding('CHECKSUM_MISMATCH', 'experiment') };
  if (id.registryHeadDigest !== bundle.registrySnapshot?.headDigest) return { ok: false, finding: finding('REGISTRY_SNAPSHOT_DIGEST_MISMATCH') };
  const again = refereeEvaluate(bundle);
  if (again.reportDigest !== report.reportDigest) return { ok: false, finding: finding('CHECKSUM_MISMATCH', 're-evaluation produced a different report'), reproducedDigest: again.reportDigest };
  return { ok: true, finding: null, reproducedDigest: again.reportDigest };
}
// a bounded plain-text rendering for humans (never the only record; the sealed JSON is)
export function renderReport(r) {
  const L = []; const v = r.verdict; const p = r.primaryResult; const o = r.overfitting;
  L.push(`RESEARCH REFEREE ${r.refereeVersion} — authority ${r.authority.authority} / ${r.authority.purpose} (no trading, eligibility, sizing or execution effect)`);
  L.push(`experiment ${r.identity.experimentId ?? '?'} family ${r.identity.experimentFamilyId ?? '?'} dataset ${(r.identity.datasetDigest ?? '').slice(0, 16)} commit ${r.identity.gitCommit ?? 'none'} (${r.identity.codeLaw ?? '?'})`);
  L.push(`VERDICT ${v.verdict} at stage ${v.stage}: ${v.reasons.join(', ')}${v.warnings.length ? ` | warnings: ${v.warnings.join(', ')}` : ''}`);
  L.push(`  ${v.meaning}`);
  if (r.pit) L.push(`PIT ${r.pit.pass ? 'pass' : `FAIL (${r.pit.violationCount} violations)`}${r.pit.counts ? ` ${Object.entries(r.pit.counts).map(([k, n]) => `${k}=${n}`).join(' ')}` : ''}`);
  if (r.leakage) L.push(`LEAKAGE ${r.leakage.pass ? 'pass' : `FAIL (${r.leakage.findings.map((f) => f.reason).join(', ')})`}`);
  if (r.trialHistory) L.push(`TRIALS raw ${r.trialHistory.rawTrialCount} over ${r.trialHistory.memberCount} family members; recorded sharpes ${r.trialHistory.recordedSharpeCount}; holdouts opened ${r.trialHistory.holdoutWindows.length}`);
  if (r.splits?.design && r.splits.design.method) L.push(`SPLITS ${r.splits.design.method} groups ${r.splits.design.groups} combos ${r.splits.design.combinations} valid folds ${r.splits.design.validFolds}/${r.splits.design.validFolds + r.splits.design.skippedFolds} paths ${r.splits.design.validPaths}/${r.splits.design.pathCount} purged ${r.splits.design.purgedRows} embargoed ${r.splits.design.embargoedRows}; effective n ${r.splits.effectiveObservations.effective} of ${r.splits.effectiveObservations.n}`);
  if (p) L.push(`PRIMARY ${p.metric} (${p.scale}) = ${p.value} signed ${p.signed}; paths positive ${p.pathAgreement.positive}; CI [${p.uncertainty.lower}, ${p.uncertainty.upper}]; baseline ${p.baseline.kind} ${p.baseline.value} uplift ${p.baseline.uplift}${p.economics ? `; net ${p.economics.netValue}` : ''}`);
  if (o) { L.push(`PSR ${o.psr.applicable ? `median ${o.psr.median} min ${o.psr.min}` : o.psr.reason}; DSR ${o.dsr.applicable ? `median ${o.dsr.median} (benchmark SR* ${o.dsr.benchmarkSharpe}, effective trials ${o.dsr.trials.effectiveTrialCount} of ${o.dsr.trials.rawTrialCount})` : o.dsr.reason}; PBO ${o.pbo.applicable ? `${o.pbo.pbo} over ${o.pbo.evaluatedCombinations} combinations of ${o.pbo.candidates} candidates` : o.pbo.reason}`); const c = o.negativeControls; L.push(`NULLS block ${c.blockLen} rows (${c.blockLengthRule}); permutation p ${c.permutation.p}; time-shift p ${c.timeShift.p}; null-feature p ${c.nullFeature.p}; symbol placebo ${c.symbolPlacebo.applicable ? `p ${c.symbolPlacebo.p}` : 'n/a'}; horizon profile ${c.horizonProfile.applicable ? (c.horizonProfile.coherent ? 'coherent' : 'INCOHERENT') : 'n/a'}`); }
  if (r.stability?.ok) L.push(`STABILITY ${r.stability.valid} valid perturbations; direction consistency ${r.stability.directionConsistency}; range [${r.stability.effectRange?.min}, ${r.stability.effectRange?.max}]; worst ${r.stability.worstValidPerturbation ? `${r.stability.worstValidPerturbation.label} ${r.stability.worstValidPerturbation.signed}` : 'n/a'}; block share ${r.stability.concentration.maxBlockShare}; symbol share ${r.stability.concentration.maxSymbolShare}; flags ${r.stability.flags.join(', ') || 'none'}`);
  if (r.prospective) L.push(`PROSPECTIVE ${r.prospective.status}; anytime-valid ${r.prospective.anytimeValid.status}`);
  L.push(`report digest ${r.reportDigest}`);
  return L.join('\n');
}
