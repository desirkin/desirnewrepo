// RESEARCH REFEREE — STABILITY / FRAGILITY. Small, PREDECLARED perturbations of a surviving candidate: neighbouring
// parameter / horizon variants (declared in the sealed manifest, scored on the same out-of-sample rows), one calendar
// block out at a time, one symbol out at a time, early vs late, regime partitions and day-of-week partitions when the
// data supports them. None of this searches for a better number; it asks whether the effect collapses immediately.
// Reported: direction consistency, effect-size range, the worst valid perturbation, concentration (how much of the
// effect one block or one symbol carries) and regime dependency. A knife-edge parameter earns a fragility warning.
import { round6, LIMITS } from './contracts.js';
import { calendarBlocks } from './splits.js';
import { signedEffect } from './statistics.js';

const DAY_MS = 86_400_000;
export function runStability({ rows, oosIdx, primaryValue, direction, stability, criteria, neighbors, scoreSignal, scoreSubset, nullTest, nullSubset }) {
  const signedPrimary = signedEffect(primaryValue, direction); const perturbations = []; const flags = [];
  const add = (kind, label, value, extra = {}) => perturbations.push({ kind, label, value: value === null ? null : round6(value), signed: value === null ? null : round6(signedEffect(value, direction)), ...extra });
  // neighbours: the SAME rows, a declared neighbouring variant
  for (const nb of neighbors) { const p = nullTest(nb.signal); add('NEIGHBOR', nb.candidateId, scoreSignal(nb.signal), { axis: nb.axis, distance: nb.distance, nullP: p, rejectsNull: p !== null && p <= criteria.nullAlpha }); }
  if (neighbors.length === 0) flags.push('NEIGHBORS_NOT_DECLARED');
  // leave one calendar block out
  const oosRows = oosIdx.map((i) => rows[i]); const blocks = stability.leaveOneBlockOut ? calendarBlocks(oosRows, stability.blocks) : [];
  const blockDrops = [];
  for (const b of blocks) { const excluded = new Set(oosRows.slice(b.from, b.to + 1).map((r) => r.idx)); const v = scoreSubset((i) => !excluded.has(i)); add('LEAVE_ONE_BLOCK_OUT', `block-${b.group}`, v, { startTs: b.startTs, endTs: b.endTs, rowsExcluded: excluded.size }); if (v !== null && signedPrimary !== null) blockDrops.push({ label: `block-${b.group}`, drop: signedPrimary - signedEffect(v, direction) }); }
  // leave one symbol out (concentrated experiments)
  const symbolDrops = []; const symbols = [...new Set(oosRows.map((r) => r.symbol))].sort();
  if (stability.leaveOneSymbolOut && symbols.length >= 2) for (const s of symbols) { const n = oosRows.filter((r) => r.symbol === s).length; if (n < stability.minPartitionRows) { add('LEAVE_ONE_SYMBOL_OUT', s, null, { skipped: 'PARTITION_TOO_SMALL', rows: n }); continue; } const v = scoreSubset((i) => rows[i].symbol !== s); add('LEAVE_ONE_SYMBOL_OUT', s, v, { rowsExcluded: n }); if (v !== null && signedPrimary !== null) symbolDrops.push({ label: s, drop: signedPrimary - signedEffect(v, direction) }); }
  // early vs late
  if (stability.earlyLate && oosRows.length >= 2 * stability.minPartitionRows) { const mid = oosRows[Math.floor(oosRows.length / 2)].ts; add('EARLY_HALF', 'early', scoreSubset((i) => rows[i].ts < mid)); add('LATE_HALF', 'late', scoreSubset((i) => rows[i].ts >= mid)); }
  // regimes (point-in-time tags carried by the observations)
  const regimeValues = [];
  if (stability.regimeFeature !== null) { const regimes = [...new Set(oosRows.map((r) => r.regime).filter((r) => r !== null))].sort(); for (const g of regimes) { const n = oosRows.filter((r) => r.regime === g).length; if (n < stability.minPartitionRows) { add('REGIME', g, null, { skipped: 'PARTITION_TOO_SMALL', rows: n }); continue; } const v = scoreSubset((i) => rows[i].regime === g); const p = nullSubset((i) => rows[i].regime === g); add('REGIME', g, v, { rows: n, nullP: p, rejectsNull: p !== null && p <= criteria.nullAlpha }); if (v !== null) regimeValues.push({ regime: g, signed: signedEffect(v, direction), rejectsNull: p !== null && p <= criteria.nullAlpha }); } }
  // day of week
  if (stability.dayOfWeek) { const byDow = new Map(); for (const r of oosRows) { const d = Math.floor(r.ts / DAY_MS + 4) % 7; if (!byDow.has(d)) byDow.set(d, 0); byDow.set(d, byDow.get(d) + 1); } const eligible = [...byDow.entries()].filter(([, n]) => n >= stability.minPartitionRows).map(([d]) => d).sort(); if (eligible.length >= 2) for (const d of eligible) add('DAY_OF_WEEK', `dow-${d}`, scoreSubset((i) => Math.floor(rows[i].ts / DAY_MS + 4) % 7 === d), { rows: byDow.get(d) }); }
  if (perturbations.length > LIMITS.maxStabilityPerturbations) return { ok: false, reason: 'RESOURCE_LIMIT_EXCEEDED', perturbations: perturbations.length };
  // summary
  const valid = perturbations.filter((p) => p.signed !== null); const signedVals = valid.map((p) => p.signed);
  const directionConsistency = valid.length ? valid.filter((p) => p.signed > 0).length / valid.length : null;
  const structural = valid.filter((p) => p.kind !== 'NEIGHBOR' && p.kind !== 'REGIME' && p.kind !== 'DAY_OF_WEEK');
  const worst = structural.length ? structural.reduce((w, p) => (w === null || p.signed < w.signed ? p : w), null) : null;
  const share = (drops) => (signedPrimary && signedPrimary > 0 && drops.length ? Math.max(...drops.map((d) => d.drop)) / signedPrimary : null);
  const blockShare = share(blockDrops); const symbolShare = share(symbolDrops);
  const neighborVals = valid.filter((p) => p.kind === 'NEIGHBOR');
  const neighborsAll = perturbations.filter((p) => p.kind === 'NEIGHBOR'); const supportive = neighborsAll.filter((p) => p.rejectsNull && p.signed !== null && p.signed > 0).length;
  const knifeEdge = neighborsAll.length > 0 && signedPrimary !== null && signedPrimary > 0 && supportive === 0;
  const regimeSupport = regimeValues.filter((r) => r.signed > 0 && r.rejectsNull).length; const regimeDependent = regimeValues.length >= 2 && regimeSupport >= 1 && regimeSupport < regimeValues.length;
  if (directionConsistency !== null && directionConsistency < criteria.minDirectionConsistency) flags.push('DIRECTION_INCONSISTENT');
  if (worst && worst.signed < 0) flags.push('WORST_PERTURBATION_FLIPS_SIGN');
  if (blockShare !== null && blockShare > criteria.maxConcentrationShare) flags.push('CONCENTRATED_IN_ONE_BLOCK');
  if (symbolShare !== null && symbolShare > criteria.maxConcentrationShare) flags.push('CONCENTRATED_IN_ONE_SYMBOL');
  if (knifeEdge) flags.push('KNIFE_EDGE_PARAMETER'); if (regimeDependent) flags.push('REGIME_DEPENDENT');
  return { ok: true, primary: { value: primaryValue === null ? null : round6(primaryValue), signed: signedPrimary === null ? null : round6(signedPrimary) }, perturbations, count: perturbations.length, valid: valid.length, directionConsistency: directionConsistency === null ? null : round6(directionConsistency), effectRange: signedVals.length ? { min: round6(Math.min(...signedVals)), max: round6(Math.max(...signedVals)) } : null, worstValidPerturbation: worst ? { kind: worst.kind, label: worst.label, signed: worst.signed } : null, concentration: { maxBlockShare: blockShare === null ? null : round6(blockShare), maxSymbolShare: symbolShare === null ? null : round6(symbolShare), rule: 'share = (primary - value without the part) / primary, signed in the declared direction' }, regimeDependency: { evaluated: regimeValues.length >= 2, dependent: regimeDependent, regimes: regimeValues.map((r) => ({ regime: r.regime, signed: round6(r.signed), rejectsNull: r.rejectsNull })), rule: 'dependent when at least one point-in-time regime partition supports the effect (positive sign, own null rejected at alpha) and at least one does not' }, knifeEdge: { evaluated: neighborsAll.length > 0, flagged: knifeEdge, neighborsPositive: neighborVals.filter((p) => p.signed > 0).length, neighborsSupportive: supportive, neighbors: neighborsAll.length, rule: 'a neighbour supports the effect only if its own block-permutation null rejects at the declared alpha with the declared sign; no supportive neighbour = knife edge' }, flags, law: 'perturbations are predeclared and reported; none is searched for a better number' };
}
