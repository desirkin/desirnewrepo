// JUDGE — portfolio risk and capital admission (ticket §6.4): sample PAPER risk hypotheses live in the versioned policy,
// never here. Risk is modelled stressed LOSS, not notional; eligible capital is the allocated equity (fees and pending
// reservations inside the balance); clusters join known same-underlying assets or pairwise correlation >= 0.70 over 60
// COMPLETE synchronized 1m returns, insufficient history -> one shared UNKNOWN_CORRELATION group; existing concentration
// above a new estimate blocks additions (never a surprise liquidation). Competing candidates in one 25ms bucket rank by
// descending bufferedReward / stressedRisk, then lower modelled cost bps, then first-known time, then canonical asset id.
import * as M from '../execution/money.js';
import { availableCash, reservedRisk, slotsUsed, allocationRemaining } from '../execution/reducer.js';

export const RISK_VERSION = 'judge-risk-paper-reference-1';
export const CORRELATION_JOIN = 0.7; export const CORRELATION_BARS = 60;
export const WRAPPED_GROUPS = Object.freeze([['BTC', 'WBTC', 'TBTC', 'CBBTC'], ['ETH', 'WETH', 'STETH', 'WSTETH', 'CBETH', 'RETH'], ['SOL', 'JITOSOL', 'MSOL'], ['USD', 'USDT', 'USDC', 'DAI']]);
const frac = (x) => M.fromStatistic(x, 6);
export function pearson(a, b) { const n = Math.min(a.length, b.length); if (n < 2) return null; let ma = 0; let mb = 0; for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let sab = 0; let saa = 0; let sbb = 0; for (let i = 0; i < n; i += 1) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } if (saa === 0 || sbb === 0) return null; return sab / Math.sqrt(saa * sbb); }
// returnsByAsset: { asset: [{ periodStartTs, r }] } (complete 1m returns available at D); synchronized on shared periods
export function computeClusters(returnsByAsset, { asOfTs, bars = CORRELATION_BARS, join = CORRELATION_JOIN } = {}) {
  const assets = Object.keys(returnsByAsset).sort(); const parent = new Map(assets.map((a) => [a, a])); const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; }; const union = (a, b) => { parent.set(find(a), find(b)); };
  const support = {}; const unknown = new Set(); const edges = [];
  for (const g of WRAPPED_GROUPS) { const present = g.filter((a) => assets.includes(a)); for (let i = 1; i < present.length; i += 1) { union(present[0], present[i]); edges.push({ a: present[0], b: present[i], r: null, basis: 'SAME_UNDERLYING' }); } }
  // synchronized windows (closeout R06): every pair is measured over the SAME 60 most recent complete periods common to both series
  const complete = new Map(); for (const a of assets) { const rows = (returnsByAsset[a] ?? []).filter((x) => x.periodStartTs + 60_000 <= asOfTs && typeof x.r === 'number' && Number.isFinite(x.r)); complete.set(a, new Map(rows.map((x) => [x.periodStartTs, x.r]))); support[a] = rows.length; if (rows.length < bars) unknown.add(a); }
  const pairsChecked = [];
  for (let i = 0; i < assets.length; i += 1) for (let j = i + 1; j < assets.length; j += 1) { const a = assets[i]; const b = assets[j]; if (unknown.has(a) || unknown.has(b)) continue; const ma = complete.get(a); const mb = complete.get(b); const common = [...ma.keys()].filter((t) => mb.has(t)).sort((x, y) => x - y).slice(-bars); if (common.length < bars) { pairsChecked.push({ a, b, common: common.length, state: 'INSUFFICIENT_COMMON_PERIODS' }); unknown.add(a); unknown.add(b); continue; } const r = pearson(common.map((t) => ma.get(t)), common.map((t) => mb.get(t))); pairsChecked.push({ a, b, common: common.length, r, windowStartTs: common[0], windowEndTs: common[common.length - 1] + 60_000 }); if (r !== null && r >= join) { union(a, b); edges.push({ a, b, r, basis: 'CORRELATION_60', windowStartTs: common[0], windowEndTs: common[common.length - 1] + 60_000 }); } }
  const clusterOf = {}; for (const a of assets) clusterOf[a] = unknown.has(a) ? 'UNKNOWN_CORRELATION' : `cl-${find(a)}`;
  for (const a of assets) if (!unknown.has(a)) { const root = find(a); if (unknown.has(root)) clusterOf[a] = 'UNKNOWN_CORRELATION'; }
  return { riskVersion: RISK_VERSION, asOfTs, clusterOf, support, edges, pairs: pairsChecked, unknown: [...unknown].sort(), law: 'INSUFFICIENT_HISTORY_IS_ONE_SHARED_UNKNOWN_GROUP; PAIRS_MEASURED_OVER_THE_SAME_60_COMMON_COMPLETE_PERIODS' };
}
export const clusterIdOf = (clusters, asset) => clusters?.clusterOf?.[asset] ?? 'UNKNOWN_CORRELATION';
// gain-lock overlay: SELECTIVE halves the per-entry risk; PROTECT / HARD_LOCK block entries (exits continue)
export function admitCandidate({ state, candidate, limits, lockLevel = 'NONE', clusters = null }) {
  const binding = []; const reasons = []; const base = state.performance.riskPerformanceEquity; const eligible = state.valuation.unknown ? null : base;
  if (eligible === null || !M.isPositive(eligible ?? '0')) return { ok: false, reasons: ['EQUITY_UNKNOWN_OR_NONPOSITIVE'], binding: ['EQUITY'], caps: null };
  if (lockLevel === 'PROTECT' || lockLevel === 'HARD_LOCK') reasons.push(`GAIN_LOCK_${lockLevel}`);
  const perPosition = M.mul(eligible, frac(limits.maxModelledRiskPerPositionFraction * (lockLevel === 'SELECTIVE' ? 0.5 : 1))); const aggregate = M.mul(eligible, frac(limits.maxAggregateModelledRiskFraction)); const cluster = M.mul(eligible, frac(limits.maxCorrelatedClusterModelledRiskFraction)); const gross = M.mul(eligible, frac(limits.maxGrossExposureFraction)); const asset = M.mul(eligible, frac(limits.maxAssetExposureFraction));
  const allocation = allocationRemaining(state); const cash = allocation === null ? availableCash(state) : M.min(availableCash(state), allocation); const openRisk = M.add(reservedRisk(state), M.sum(Object.values(state.positions).filter((p) => p.state !== 'FLAT').map((p) => p.riskReserved ?? '0')));
  const clusterId = candidate.clusterId ?? clusterIdOf(clusters, candidate.assetId); const clusterRisk = M.add(M.sum(Object.values(state.reservations).filter((r) => r.state === 'OPEN' && r.clusterId === clusterId).map((r) => r.riskReserved)), M.sum(Object.values(state.positions).filter((p) => p.state !== 'FLAT' && p.clusterId === clusterId).map((p) => p.riskReserved ?? '0')));
  const grossNow = M.add(M.sum(Object.values(state.reservations).filter((r) => r.state === 'OPEN').map((r) => r.cashReserved)), M.sum(Object.values(state.positions).filter((p) => p.state !== 'FLAT').map((p) => p.lastMark?.liquidationValue ?? p.entryQuote ?? '0')));
  if (M.gt(candidate.entryCashOut, cash)) { binding.push(allocation !== null && M.lt(allocation, availableCash(state)) ? 'ALLOCATION' : 'CASH'); reasons.push(allocation !== null && M.gt(candidate.entryCashOut, allocation) ? 'ALLOCATION_EXCEEDED' : 'CASH_INSUFFICIENT'); }
  if (M.gt(candidate.riskUsd, perPosition)) { binding.push('RISK_PER_POSITION'); reasons.push('RISK_PER_POSITION'); }
  if (M.gt(M.add(openRisk, candidate.riskUsd), aggregate)) { binding.push('RISK_AGGREGATE'); reasons.push('RISK_AGGREGATE'); }
  if (M.gt(M.add(clusterRisk, candidate.riskUsd), cluster)) { binding.push('RISK_CLUSTER'); reasons.push(clusterId === 'UNKNOWN_CORRELATION' ? 'RISK_CLUSTER_UNKNOWN_CORRELATION' : 'RISK_CLUSTER'); }
  if (M.gt(M.add(grossNow, candidate.entryCashOut), gross)) { binding.push('GROSS_EXPOSURE'); reasons.push('GROSS_EXPOSURE'); }
  if (M.gt(candidate.entryCashOut, asset)) { binding.push('ASSET_EXPOSURE'); reasons.push('ASSET_EXPOSURE'); }
  if (slotsUsed(state) >= limits.maxSimultaneousAssetPositions) { binding.push('SLOTS'); reasons.push('SLOTS_EXHAUSTED'); }
  const held = new Set([...Object.values(state.positions).filter((p) => p.state !== 'FLAT' && p.state !== 'DUST_UNRESOLVED').map((p) => p.assetId), ...Object.values(state.reservations).filter((r) => r.state === 'OPEN').map((r) => r.assetId)]); const alias = WRAPPED_GROUPS.find((g) => g.includes(candidate.assetId)) ?? [candidate.assetId]; if (alias.some((a) => held.has(a))) { binding.push('UNDERLYING_HELD'); reasons.push('ONE_POSITION_PER_UNDERLYING'); }
  if (state.vetoes.includes(candidate.assetId) || (candidate.decisionId && state.vetoes.includes(candidate.decisionId))) reasons.push('VETOED');
  return { ok: reasons.length === 0, reasons, binding, clusterId, caps: { eligibleEquity: eligible, cashAvailable: cash, allocationRemaining: allocation, perPositionRisk: perPosition, aggregateRisk: aggregate, clusterRisk: cluster, grossExposure: gross, assetExposure: asset, openRisk, clusterRiskUsed: clusterRisk, lockLevel } };
}
// the risk budget available to the largest-size search for one candidate (min of per-position and remaining aggregate / cluster)
export function riskBudgetFor({ state, limits, lockLevel = 'NONE', clusterId }) { const a = admitCandidate({ state, candidate: { assetId: '__probe__', clusterId, entryCashOut: '0', riskUsd: '0' }, limits, lockLevel }); if (!a.caps) return null; const remAgg = M.max('0', M.sub(a.caps.aggregateRisk, a.caps.openRisk)); const remCluster = M.max('0', M.sub(a.caps.clusterRisk, a.caps.clusterRiskUsed)); return { budget: M.min(a.caps.perPositionRisk, M.min(remAgg, remCluster)), cash: a.caps.cashAvailable, caps: a.caps }; }
// deterministic ordering of the candidates of one admission bucket (each at its own admissible size and the same stress model)
export function rankCandidates(list) { const key = (c) => ({ ratio: c.rewardRiskRatio === null ? null : Number(c.rewardRiskRatio), bps: c.costBps === null ? Infinity : Number(c.costBps), first: c.firstKnownTs, asset: c.assetId }); return [...list].filter((c) => c.rewardRiskRatio !== null).sort((x, y) => { const a = key(x); const b = key(y); return b.ratio - a.ratio || a.bps - b.bps || a.first - b.first || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0); }); }
