// RESEARCH REFEREE — LEAKAGE-AWARE TIME-SERIES SPLITS. No random k-fold over overlapping financial labels, ever.
//   PURGED K-FOLD: time-contiguous groups; a training row whose label interval [ts, labelEnd] overlaps a test group's
//                  span is PURGED; a training row whose decision falls inside the declared embargo after a test span
//                  is EMBARGOED.
//   CPCV:          C(N, k) test combinations of k contiguous groups out of N, the same purge / embargo per test group,
//                  and phi = C(N-1, k-1) reconstructed out-of-sample PATHS: the j-th combination containing a group
//                  contributes that group's test rows to path j, so every path covers every group exactly once.
//   CSCV:          the combinatorially symmetric substrate for PBO: S even contiguous groups, every choice of S/2 as
//                  the in-sample half, the complement out of sample, purged at the seam.
// Every design is bounded by the named limits and reports its own purge / embargo / skipped-fold facts. A design that
// cannot be run within the limits says so (CPCV_NOT_PRACTICAL / RESOURCE_LIMIT_EXCEEDED); it is never silently reduced.
import { LIMITS, STRUCTURAL_MIN, binomial, combinations } from './contracts.js';

// contiguous groups over rows already sorted by (ts, symbol, id); rows sharing one ts are never split across groups
export function contiguousGroups(rows, groups) {
  const n = rows.length; const target = n / groups; const groupOf = new Array(n).fill(0); const bounds = [];
  let g = 0; let start = 0;
  for (let i = 0; i < n; i += 1) {
    const lastOfTs = i + 1 === n || rows[i + 1].ts !== rows[i].ts;
    groupOf[i] = g;
    if (g < groups - 1 && lastOfTs && i + 1 >= Math.round((g + 1) * target)) { bounds.push({ group: g, from: start, to: i }); g += 1; start = i + 1; }
  }
  bounds.push({ group: g, from: start, to: n - 1 });
  while (bounds.length < groups) bounds.push({ group: bounds.length, from: n, to: n - 1 }); // empty trailing groups when n < groups
  return { groupOf, bounds: bounds.map((b) => ({ ...b, count: Math.max(0, b.to - b.from + 1), startTs: b.count > 0 ? rows[b.from].ts : null, endTs: b.count > 0 ? rows[b.to].ts : null })) };
}
// the span a test group occupies on the label axis: from its first decision to its last label end
const spanOf = (rows, idxs) => { let lo = Infinity; let hi = -Infinity; for (const i of idxs) { if (rows[i].ts < lo) lo = rows[i].ts; if (rows[i].labelEndTs > hi) hi = rows[i].labelEndTs; } return { lo, hi }; };
// train = every row outside the test set that is neither purged (label interval overlaps a test span) nor embargoed
// (decision inside (span.hi, span.hi + embargoMs]) — evaluated against EACH test span separately
export function purgeAndEmbargo(rows, testIdx, spans, { purge, embargoMs }) {
  const inTest = new Set(testIdx); const train = []; let purged = 0; let embargoed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (inTest.has(i)) continue; const r = rows[i]; let drop = null;
    for (const s of spans) {
      if (purge && r.ts <= s.hi && r.labelEndTs >= s.lo) { drop = 'PURGED'; break; }
      if (embargoMs > 0 && r.ts > s.hi && r.ts <= s.hi + embargoMs) { drop = 'EMBARGOED'; break; }
    }
    if (drop === 'PURGED') purged += 1; else if (drop === 'EMBARGOED') embargoed += 1; else train.push(i);
  }
  return { train, purged, embargoed };
}

// ---- the evaluation design: k-fold or CPCV over the SCORABLE rows ---------------------------------------------------
export function buildDesign(rows, split) {
  const N = split.groups; const k = split.method === 'PURGED_KFOLD' ? 1 : split.testGroups;
  const combos = binomial(N, k);
  if (split.method === 'CPCV' && (N < STRUCTURAL_MIN.groupsForCpcv || combos > LIMITS.maxCpcvCombinations)) return { ok: false, reason: 'CPCV_NOT_PRACTICAL', combinations: combos, groups: N, testGroups: k, limit: LIMITS.maxCpcvCombinations };
  if (N > LIMITS.maxFolds) return { ok: false, reason: 'RESOURCE_LIMIT_EXCEEDED', combinations: combos, groups: N, testGroups: k, limit: LIMITS.maxFolds };
  const { groupOf, bounds } = contiguousGroups(rows, N);
  const members = bounds.map((b) => (b.count ? rows.slice(b.from, b.to + 1).map((r) => r.idx) : []));
  const minTest = Math.max(STRUCTURAL_MIN.rowsPerTest, split.minTestObservations);
  const folds = []; const pathCount = k === 1 && split.method === 'PURGED_KFOLD' ? 1 : binomial(N - 1, k - 1);
  const pathSlot = new Array(N).fill(0); // next path index for each group
  for (const combo of combinations(N, k)) {
    const testIdx = combo.flatMap((g) => members[g]); const spans = combo.map((g) => (members[g].length ? spanOf(rows, members[g]) : null)).filter(Boolean);
    const { train, purged, embargoed } = purgeAndEmbargo(rows, testIdx, spans, split);
    let skipped = null; if (testIdx.length < minTest) skipped = 'TOO_FEW_TEST_OBSERVATIONS'; else if (train.length < minTest) skipped = 'TOO_FEW_OBSERVATIONS';
    const paths = {}; for (const g of combo) { paths[g] = split.method === 'PURGED_KFOLD' ? 0 : pathSlot[g]; pathSlot[g] += 1; }
    folds.push({ fold: folds.length, testGroups: combo, test: testIdx, train, purged, embargoed, spans: spans.map((s) => ({ startTs: s.lo, endTs: s.hi })), trainRange: train.length ? { startTs: rows[train[0]].ts, endTs: rows[train[train.length - 1]].ts } : null, skipped, paths });
  }
  const valid = folds.filter((f) => !f.skipped);
  // path reconstruction: path j = union over groups g of the test rows of the j-th fold that tested g
  const pathRows = Array.from({ length: pathCount }, () => []); const pathComplete = new Array(pathCount).fill(true);
  for (let g = 0; g < N; g += 1) for (const f of folds) if (f.testGroups.includes(g)) { const j = f.paths[g]; if (f.skipped) pathComplete[j] = false; else pathRows[j].push(...members[g].map((i) => ({ idx: i, fold: f.fold }))); }
  const paths = pathRows.map((rs, j) => ({ path: j, complete: pathComplete[j], rows: rs.sort((a, b) => a.idx - b.idx) }));
  return { ok: true, method: split.method, groups: N, testGroups: k, combinations: combos, groupBounds: bounds, folds, validFolds: valid.length, skippedFolds: folds.length - valid.length, pathCount, paths, validPaths: paths.filter((p) => p.complete && p.rows.length >= minTest).length, purgedTotal: folds.reduce((s, f) => s + f.purged, 0), embargoedTotal: folds.reduce((s, f) => s + f.embargoed, 0), minTest };
}

// ---- CSCV substrate: S even groups, every S/2 in-sample choice, complement out of sample -----------------------------
export function buildCscv(rows, split) {
  const S = split.cscvGroups; const half = S / 2; const combos = binomial(S, half);
  if (combos > LIMITS.maxCscvCombinations || S > LIMITS.maxFolds) return { ok: false, reason: 'RESOURCE_LIMIT_EXCEEDED', combinations: combos, groups: S };
  const { bounds } = contiguousGroups(rows, S); const members = bounds.map((b) => (b.count ? rows.slice(b.from, b.to + 1).map((r) => r.idx) : []));
  const minTest = Math.max(STRUCTURAL_MIN.rowsPerTest, split.minTestObservations);
  const sets = [];
  for (const combo of combinations(S, half)) {
    const isIdx = combo.flatMap((g) => members[g]); const oosGroups = []; for (let g = 0; g < S; g += 1) if (!combo.includes(g)) oosGroups.push(g);
    const oosIdx = oosGroups.flatMap((g) => members[g]); const spans = oosGroups.map((g) => (members[g].length ? spanOf(rows, members[g]) : null)).filter(Boolean);
    // purge the in-sample half at the seams with the out-of-sample half (embargo applies as declared)
    const { train, purged, embargoed } = purgeAndEmbargo(rows, oosIdx, spans, split); const isSet = new Set(isIdx); const isKept = train.filter((i) => isSet.has(i));
    sets.push({ combination: sets.length, inSampleGroups: combo, outOfSampleGroups: oosGroups, inSample: isKept, outOfSample: oosIdx, purged, embargoed, skipped: isKept.length < minTest || oosIdx.length < minTest ? 'TOO_FEW_TEST_OBSERVATIONS' : null });
  }
  return { ok: true, groups: S, combinations: combos, sets, validSets: sets.filter((s) => !s.skipped).length };
}

// contiguous calendar blocks (for leave-one-block-out and block resampling) — boundaries never split one ts
export const calendarBlocks = (rows, blocks) => contiguousGroups(rows, blocks).bounds.filter((b) => b.count > 0);
// the block length rule for resampling: rows per block must exceed the maximum label overlap measured in rows
export function blockLengthRows(rows, controls) {
  if (controls.blockLengthRule === 'DECLARED') return { blockLen: controls.blockLengthRows, rule: 'DECLARED' };
  let maxOverlap = 0; let j = 0;
  for (let i = 0; i < rows.length; i += 1) { while (j < rows.length && rows[j].ts <= rows[i].labelEndTs) j += 1; maxOverlap = Math.max(maxOverlap, j - i - 1); }
  return { blockLen: Math.max(1, maxOverlap + 1), rule: 'MAX_OVERLAP_PLUS_ONE', maxOverlapRows: maxOverlap };
}
