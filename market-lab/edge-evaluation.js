// MARKET-EDGE closeout — the DARK prospective evaluation harness (research only). It measures, it never promotes: no
// threshold, no promotion criterion, no Judge / Socrates / execution hook. Arms are FEATURE SETS evaluated as rank
// correlations with forward spot returns at declared horizons over chronological, embargoed, dependency-safe splits.
// Truth laws closed here:
//  W1 the label endpoint is EXACTLY t + H on the closed 1-minute candle grid: a missing exact endpoint is CENSORED (null),
//     never a nearer candle; the label is known only at the later candle's own knownAtTs;
//  W2 a declaration is created by the RUNTIME clock (createdTs from `clock()`), never typed by a caller; it is prospective
//     only when it actually existed before its start; the durable chain (edge-eval-store.js) is the only home of one;
//  W4 production scoring builds its rows INTERNALLY from sealed bundles (edge-capture.js) and seals a dataset manifest whose
//     availability counts are the only n a report may claim — the pure scorer below is a primitive, not evidence;
//  W6 every current-state feature carries a max age (book 15 s from the shared context law, candle one interval, L3
//     snapshot inside its window); stale inputs are STALE, never "current";
//  W7 a feature value is scoreable only with support COMPLETE (and, for L3, a verified checksum); PARTIAL / MISSING /
//     STALE / UNVERIFIED rows are null for the primary statistic with the reason retained in the manifest's support counts;
//  W13 a derivatives feature whose lookback touches an INCOMPLETE charts acquisition (page cap, non-advancing cursor, a later
//     page failure, misaligned buckets — explicit coverage records) is PARTIAL with COVERAGE_INCOMPLETE, never COMPLETE.
import { deepFreeze, fail, isTs, isFiniteNum, round, canonicalDigest, isId, isCoin, SHA256_RE, exactKeys, isPlainObject, subjectId } from './contracts.js';
import { derivativesPressure, l3Microstructure, EDGE_RECIPES, EDGE_RECIPE_SET_VERSION } from './edge-recipes.js';
import { BOOK_ENDPOINT_MAX_AGE_MS } from './context.js';
import { MINUTE_MS } from './time.js';
import { EDGE_EVAL_VERSION, EDGE_ARMS, EDGE_STAGES, DECISION_STATES, FEATURE_STATES, SCORING_LAW, SPLIT_LAW, declarationError, declarationDigestOf, manifestDigestOf, manifestError, reportDigestOf, reportError, lockDigestOf, openingDigestOf } from './edge-eval-records.js';

export { EDGE_EVAL_VERSION, EDGE_ARMS, EDGE_STAGES, DECISION_STATES, FEATURE_STATES, SCORING_LAW, SPLIT_LAW, declarationError, declarationDigestOf, manifestError, reportError };
export const EDGE_HORIZONS_MS = Object.freeze([1, 5, 15, 30, 60].map((m) => m * MINUTE_MS));
export const MIN_SCORED_N = 30;
export const CANDLE_MAX_LAG_MS = MINUTE_MS; // the latest closed 1m candle must end within one interval of t
export const BOOK_MAX_AGE_MS = BOOK_ENDPOINT_MAX_AGE_MS; // the shared displayed-book freshness law (15 s)
export const BASELINE_FEATURES = Object.freeze(['log_return_5m', 'log_return_15m', 'realized_volatility_20', 'signed_notional_imbalance_5m', 'spread_bps']);
export const DERIVATIVES_FEATURES = Object.freeze(['oi_bucket_change', 'oi_bucket_acceleration', 'aggressor_bucket_level', 'aggressor_bucket_slope', 'cvd_bucket_change', 'cvd_bucket_slope', 'liquidation_bucket_burst', 'basis_bucket_change', 'funding_bucket_change']);
export const L3_FEATURES = Object.freeze(['visible_order_age_imbalance', 'queue_turnover_imbalance', 'depth_persistence_bid', 'depth_persistence_ask', 'new_order_impulse_net', 'liquidity_disappearance_net', 'replenishment_ratio', 'queue_concentration_touch_bid', 'queue_concentration_touch_ask', 'order_age_p50_bid_ms', 'order_age_p50_ask_ms', 'top_level_churn_net', 'microstructure_pressure_change']);
export const ARM_FEATURES = deepFreeze({ EXISTING_MARKET_BASELINE: [...BASELINE_FEATURES], BASELINE_PLUS_DERIVATIVES_PRESSURE: [...BASELINE_FEATURES, ...DERIVATIVES_FEATURES], BASELINE_PLUS_L3_MICROSTRUCTURE: [...BASELINE_FEATURES, ...L3_FEATURES], BASELINE_PLUS_BOTH: [...BASELINE_FEATURES, ...DERIVATIVES_FEATURES, ...L3_FEATURES] });
export const ALL_FEATURES = ARM_FEATURES.BASELINE_PLUS_BOTH;
export const RECIPE_DIGEST = canonicalDigest({ recipeSetVersion: EDGE_RECIPE_SET_VERSION, recipes: EDGE_RECIPES, features: ARM_FEATURES });

// ---- declaration (the caller never supplies createdTs: the runtime clock does) --------------------------------------------------
export function buildDeclaration({ evaluationId, createdTs, startTs, durationMs, fractions = { development: 0.5, validation: 0.25, holdout: 0.25 }, embargoMs, decisionCadenceMs = 5 * MINUTE_MS, horizonsMs = EDGE_HORIZONS_MS, analyticsIntervalMs = 5 * MINUTE_MS, l3WindowMs = 5 * MINUTE_MS, seed, policyDigest, codeDigest = null, subject, sourceRoots = [] }) {
  if (!isId(evaluationId) || !isTs(createdTs) || !isTs(startTs) || !isTs(durationMs) || !isId(seed)) fail('INVALID_REQUEST', 'declaration identity/clocks malformed');
  if (!policyDigest || !SHA256_RE.test(String(policyDigest)) || !(codeDigest === null || SHA256_RE.test(String(codeDigest)))) fail('INVALID_REQUEST', 'policy/code digest malformed');
  if (!isPlainObject(subject) || !isCoin(subject.canonicalCoin) || !isId(subject.spotSymbol) || !isId(subject.futuresSymbol)) fail('INVALID_REQUEST', 'subject malformed');
  const hs = [...(Array.isArray(horizonsMs) ? horizonsMs : [])].sort((a, b) => a - b);
  const b1 = startTs + Math.floor(durationMs * (fractions?.development ?? 0)); const b2 = b1 + Math.floor(durationMs * (fractions?.validation ?? 0));
  const body = { evaluationVersion: EDGE_EVAL_VERSION, evaluationId, createdTs, knownAtTs: createdTs, prospective: createdTs <= startTs, startTs, endTs: startTs + durationMs, durationMs, fractions: { development: fractions?.development, validation: fractions?.validation, holdout: fractions?.holdout }, embargoMs, decisionCadenceMs, horizonsMs: hs, analyticsIntervalMs, l3WindowMs, seed, policyDigest, codeDigest, recipeSetVersion: EDGE_RECIPE_SET_VERSION, recipeDigest: RECIPE_DIGEST, subject: { canonicalCoin: subject.canonicalCoin, spotSymbol: subject.spotSymbol, futuresSymbol: subject.futuresSymbol }, arms: [...EDGE_ARMS], features: Object.fromEntries(EDGE_ARMS.map((a) => [a, [...ARM_FEATURES[a]]])), scoringLaw: SCORING_LAW, splitLaw: SPLIT_LAW, selectionDeadlineTs: b2, holdout: { startTs: b2, endTs: startTs + durationMs, fraction: fractions?.holdout, oneShot: true }, sourceRoots: (Array.isArray(sourceRoots) ? sourceRoots : []).map((s) => ({ bundleKind: s.bundleKind, bundleId: s.bundleId, manifestSha256: s.manifestSha256 })), authority: 'NONE' };
  const d = { ...body, declarationId: `ee-${canonicalDigest(body)}` };
  const e = declarationError(d); if (e) fail('INVALID_REQUEST', e);
  return deepFreeze(d);
}
// the production declaration: durable, runtime-clocked, one per evaluation id (a second declaration is refused by the chain)
export async function declareEdgeEvaluation({ store, clock = () => Date.now(), ...params }) {
  if (!store || typeof store.append !== 'function') fail('INVALID_REQUEST', 'a durable edge-eval store is required');
  const declaration = buildDeclaration({ ...params, createdTs: clock() });
  const row = await store.append(declaration.evaluationId, 'DECLARED', declaration, { expectSeq: 0 });
  return { declaration, seq: row.seq, digest: row.digest };
}
export const splitBoundaries = (d) => ({ development: [d.startTs, d.startTs + Math.floor(d.durationMs * d.fractions.development)], validation: [d.startTs + Math.floor(d.durationMs * d.fractions.development), d.selectionDeadlineTs], holdout: [d.holdout.startTs, d.holdout.endTs] });
// dependency-safe assignment: the outcome window [t, t + embargo] must stay inside its own block
export function assignDecision(d, t) {
  if (!isTs(t) || t < d.startTs || t >= d.endTs) return 'OUT_OF_WINDOW';
  for (const [split, [s, e]] of Object.entries(splitBoundaries(d))) { if (t >= s && t < e) return t + d.embargoMs > e ? 'PURGED' : split.toUpperCase(); }
  return 'OUT_OF_WINDOW';
}
export const decisionPoints = (d) => { const out = []; for (let t = d.startTs; t < d.endTs; t += d.decisionCadenceMs) out.push(t); return out; };

// ---- features with SUPPORT (COMPLETE-only values) ---------------------------------------------------------------------------------
const asOf = (obs, t) => obs.filter((o) => o.knownAtTs <= t);
const closedCandles = (obs, symbol, intervalMs) => obs.filter((o) => o.kind === 'CANDLE' && o.payload.closed && o.payload.intervalMs === intervalMs && o.subject.nativeSymbol === symbol && isFiniteNum(o.payload.close)).sort((a, b) => a.periodEndTs - b.periodEndTs || a.knownAtTs - b.knownAtTs);
const closeAt = (candles, ts) => { let best = null; for (const c of candles) { if (c.periodEndTs <= ts) best = c; else break; } return best; };
const exactEnd = (candles, ts) => candles.find((c) => c.periodEndTs === ts) ?? null;
const F = (value, state, reasons = []) => ({ value: state === 'COMPLETE' ? value : null, state, reasons });
function logReturn(candles, t, backMs) {
  const now = closeAt(candles, t); if (!now) return F(null, 'MISSING', ['NO_CLOSED_CANDLE']);
  if (now.periodEndTs < t - CANDLE_MAX_LAG_MS) return F(null, 'STALE', ['CANDLE_OLDER_THAN_ONE_INTERVAL']);
  const then = exactEnd(candles, now.periodEndTs - backMs); if (!then) return F(null, 'MISSING', ['GAP']);
  return F(round(Math.log(now.payload.close / then.payload.close)), 'COMPLETE');
}
function realizedVol(candles, t, n) {
  const upTo = candles.filter((c) => c.periodEndTs <= t); const last = upTo.slice(-(n + 1));
  if (!last.length) return F(null, 'MISSING', ['NO_CLOSED_CANDLE']); if (last.at(-1).periodEndTs < t - CANDLE_MAX_LAG_MS) return F(null, 'STALE', ['CANDLE_OLDER_THAN_ONE_INTERVAL']);
  if (last.length < n + 1) return F(null, 'MISSING', ['INSUFFICIENT_BARS']);
  for (let i = 1; i < last.length; i += 1) if (last[i].periodEndTs - last[i - 1].periodEndTs !== last[i].payload.intervalMs) return F(null, 'MISSING', ['GAP']);
  const r = []; for (let i = 1; i < last.length; i += 1) r.push(Math.log(last[i].payload.close / last[i - 1].payload.close)); const m = r.reduce((a, b) => a + b, 0) / r.length;
  return F(round(Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / r.length)), 'COMPLETE');
}
function signedImbalance(obs, symbol, t, windowMs) {
  let b = 0; let s = 0; let n = 0; let unknown = 0;
  for (const o of obs) { if (o.kind !== 'TRADE' || o.subject.nativeSymbol !== symbol) continue; const ts = o.sourceEventTs ?? o.receivedTs; if (ts <= t - windowMs || ts > t) continue; n += 1; if (o.payload.takerSide === 'BUY') b += o.payload.quoteNotional; else if (o.payload.takerSide === 'SELL') s += o.payload.quoteNotional; else unknown += 1; }
  if (!n) return F(null, 'MISSING', ['NO_TRADES_IN_WINDOW']); if (!(b + s > 0)) return F(null, 'MISSING', ['NO_KNOWN_SIDE']); if (unknown > 0) return F(null, 'PARTIAL', ['UNKNOWN_SIDE_TRADES']);
  return F(round((b - s) / (b + s)), 'COMPLETE');
}
function spreadBps(obs, symbol, t) {
  const books = obs.filter((o) => o.kind === 'BOOK_SNAPSHOT' && o.subject.nativeSymbol === symbol && o.receivedTs <= t).sort((a, b) => a.receivedTs - b.receivedTs); const b = books.at(-1);
  if (!b) return F(null, 'MISSING', ['NO_BOOK']); if (t - b.receivedTs > BOOK_MAX_AGE_MS) return F(null, 'STALE', ['BOOK_OLDER_THAN_MAX_AGE']);
  if (!b.payload.synchronized) return F(null, 'PARTIAL', ['BOOK_DESYNCHRONIZED']); if (b.payload.checksumVerified === false) return F(null, 'UNVERIFIED', ['CHECKSUM_FAILED']);
  if (!b.payload.bids.length || !b.payload.asks.length) return F(null, 'MISSING', ['ONE_SIDED_BOOK']);
  const bid = b.payload.bids[0][0]; const ask = b.payload.asks[0][0]; const mid = (bid + ask) / 2; return mid > 0 ? F(round(1e4 * (ask - bid) / mid), 'COMPLETE') : F(null, 'MISSING', ['DEGENERATE_MID']);
}
export function baselineFeatures(observations, { spotSymbol, t }) {
  const obs = asOf(observations, t); const candles = closedCandles(obs, spotSymbol, MINUTE_MS);
  return { log_return_5m: logReturn(candles, t, 5 * MINUTE_MS), log_return_15m: logReturn(candles, t, 15 * MINUTE_MS), realized_volatility_20: realizedVol(candles, t, 20), signed_notional_imbalance_5m: signedImbalance(obs, spotSymbol, t, 5 * MINUTE_MS), spread_bps: spreadBps(obs, spotSymbol, t) };
}
const supportOf = (c) => (c.support.state === 'COMPLETE' ? 'COMPLETE' : c.support.state === 'MISSING' ? 'MISSING' : 'PARTIAL');
// W13: the charts coverage records that make an interval INCOMPLETE (explicit acquisition truth from providers/kraken-charts.js)
export const CHARTS_INCOMPLETE_CODES = Object.freeze(['PAGINATION_INCOMPLETE', 'ACQUISITION_INCOMPLETE', 'MISALIGNED_BUCKET', 'PROVIDER_ERROR', 'RECORD_REJECTED']);
const incompleteAcquisition = (c) => c.family === 'DERIVATIVES_PRESSURE' && (c.state === 'FAILED' || c.state === 'DROPPED' || c.reasonCodes.some((r) => CHARTS_INCOMPLETE_CODES.includes(r)));
export function derivativesFeatures(observations, { futuresSymbol, t, intervalMs, coverage = [] }) {
  const obs = asOf(observations, t).filter((o) => o.kind === 'DERIVATIVE_ANALYTIC_BUCKET' && o.subject.instrumentId === futuresSymbol);
  const sid = obs.length ? subjectId(obs[0].subject) : null;
  // an incomplete acquisition known by t whose retained interval ends at or after the feature lookback: the lookback is not COMPLETE
  const incomplete = sid === null ? [] : coverage.filter((c) => c.subjectId === sid && c.startTs <= t && incompleteAcquisition(c));
  const touches = (x) => x.windowStartTs !== null && incomplete.some((c) => (c.endTs ?? c.startTs) > x.windowStartTs - intervalMs);
  const c = derivativesPressure(obs, { intervalMs, asOfTs: t }).components; const out = {};
  for (const id of DERIVATIVES_FEATURES) { const x = c[id]; const stale = x.windowEndTs !== null && x.windowEndTs < t - 2 * intervalMs; let state = stale && x.support.state === 'COMPLETE' ? 'STALE' : supportOf(x); const reasons = stale ? ['BUCKET_OLDER_THAN_TWO_INTERVALS', ...x.support.reasons] : [...x.support.reasons]; if (state === 'COMPLETE' && touches(x)) { state = 'PARTIAL'; reasons.push('COVERAGE_INCOMPLETE'); } out[id] = F(isFiniteNum(x.value) ? x.value : null, isFiniteNum(x.value) || state !== 'COMPLETE' ? state : 'MISSING', reasons); }
  return out;
}
export function l3Features(observations, { spotSymbol, t, windowMs }) {
  const obs = asOf(observations, t).filter((o) => ['L3_BOOK_SNAPSHOT', 'L3_ORDER_EVENT', 'L3_BOOK_COVERAGE'].includes(o.kind) && o.subject.nativeSymbol === spotSymbol);
  const c = l3Microstructure(obs, { asOfTs: t, startTs: t - windowMs, endTs: t }).components;
  const stateOf = (comp, present) => { const r = comp.support.reasons; if (comp.support.state === 'MISSING' || !present) return ['MISSING', r]; if (r.includes('CHECKSUM_UNVERIFIED')) return ['UNVERIFIED', r]; if (r.includes('SNAPSHOT_STALE')) return ['STALE', r]; if (comp.support.state !== 'COMPLETE') return ['PARTIAL', r]; return ['COMPLETE', r]; };
  const pick = (id, comp, value) => { const [state, reasons] = stateOf(comp, isFiniteNum(value)); return F(value, state, reasons); };
  const v = (id) => c[id].value; const dis = v('visible_liquidity_disappearance'); const qc = v('queue_concentration'); const oa = v('order_age_quantiles'); const tc = v('top_level_churn'); const dp = v('depth_persistence'); const ni = v('new_order_impulse'); const rp = v('replenishment_after_pressure');
  return {
    visible_order_age_imbalance: pick('visible_order_age_imbalance', c.visible_order_age_imbalance, v('visible_order_age_imbalance')), queue_turnover_imbalance: pick('queue_turnover_imbalance', c.queue_turnover_imbalance, v('queue_turnover_imbalance')),
    depth_persistence_bid: pick('depth_persistence_bid', c.depth_persistence, dp?.bid), depth_persistence_ask: pick('depth_persistence_ask', c.depth_persistence, dp?.ask), new_order_impulse_net: pick('new_order_impulse_net', c.new_order_impulse, ni?.net),
    liquidity_disappearance_net: pick('liquidity_disappearance_net', c.visible_liquidity_disappearance, dis && !dis.gap ? round(dis.bid.deleted - dis.ask.deleted) : null), replenishment_ratio: pick('replenishment_ratio', c.replenishment_after_pressure, rp?.ratio),
    queue_concentration_touch_bid: pick('queue_concentration_touch_bid', c.queue_concentration, qc?.bid?.touchShare), queue_concentration_touch_ask: pick('queue_concentration_touch_ask', c.queue_concentration, qc?.ask?.touchShare),
    order_age_p50_bid_ms: pick('order_age_p50_bid_ms', c.order_age_quantiles, oa?.bid?.p50Ms), order_age_p50_ask_ms: pick('order_age_p50_ask_ms', c.order_age_quantiles, oa?.ask?.p50Ms),
    top_level_churn_net: pick('top_level_churn_net', c.top_level_churn, tc && isFiniteNum(tc.bid) && isFiniteNum(tc.ask) ? tc.bid - tc.ask : null), microstructure_pressure_change: pick('microstructure_pressure_change', c.microstructure_pressure_change, v('microstructure_pressure_change')),
  };
}
export function featureRow(observations, declaration, t, coverage = []) {
  const all = { ...baselineFeatures(observations, { spotSymbol: declaration.subject.spotSymbol, t }), ...derivativesFeatures(observations, { futuresSymbol: declaration.subject.futuresSymbol, t, intervalMs: declaration.analyticsIntervalMs, coverage }), ...l3Features(observations, { spotSymbol: declaration.subject.spotSymbol, t, windowMs: declaration.l3WindowMs }) };
  const features = {}; const support = {}; for (const id of ALL_FEATURES) { features[id] = all[id].value; support[id] = { state: all[id].state, reasons: all[id].reasons }; }
  return { features, support };
}
// W1: the EXACT forward label. Both endpoints are candles ending exactly at t and t + H; a missing endpoint is censored.
export function exactForwardLabel(candles, t, horizonMs) {
  const now = exactEnd(candles, t); const later = exactEnd(candles, t + horizonMs);
  if (!now || !later) return null;
  return { value: round(Math.log(later.payload.close / now.payload.close)), knownAtTs: Math.max(now.knownAtTs, later.knownAtTs) };
}
// rows of a dataset (internal; production callers reach it through sealDataset -> the manifest)
export function buildDatasetRows({ declaration, observations, coverage = [], asOfTs }) {
  const e = declarationError(declaration); if (e) fail('INVALID_INPUT', e); if (!isTs(asOfTs)) fail('INVALID_REQUEST', 'asOfTs required');
  const labelCandles = closedCandles(asOf(observations, asOfTs), declaration.subject.spotSymbol, MINUTE_MS); const rows = [];
  for (const t of decisionPoints(declaration)) {
    if (t > asOfTs) break;
    const split = assignDecision(declaration, t); const { features, support } = featureRow(observations, declaration, t, coverage);
    const labels = Object.fromEntries(declaration.horizonsMs.map((h) => { const l = exactForwardLabel(labelCandles, t, h); return [String(h), l && l.knownAtTs <= asOfTs ? l : null]; }));
    rows.push(deepFreeze({ decisionTs: t, split, features, support, labels }));
  }
  return deepFreeze(rows);
}
export const rowIdentityDigest = (rows) => canonicalDigest(rows.map((r) => [r.decisionTs, r.split, canonicalDigest(r.features), canonicalDigest(r.labels)]));
// the sealed dataset manifest: availability counts are the ONLY n a report may claim (W4 / W5)
export function sealDataset({ declaration, rows, stage, runId = null, asOfTs, sealedTs, sources, coverageSummary }) {
  if (!EDGE_STAGES.includes(stage)) fail('INVALID_REQUEST', 'stage');
  const availability = {}; for (const s of EDGE_STAGES) { availability[s] = {}; const rs = rows.filter((r) => r.split === s); for (const f of ALL_FEATURES) { availability[s][f] = {}; for (const h of declaration.horizonsMs) availability[s][f][String(h)] = rs.filter((r) => r.support[f].state === 'COMPLETE' && isFiniteNum(r.features[f]) && r.labels[String(h)] !== null).length; } }
  const supportCounts = {}; for (const f of ALL_FEATURES) { supportCounts[f] = {}; for (const st of FEATURE_STATES) supportCounts[f][st] = rows.filter((r) => r.support[f].state === st).length; }
  const censored = Object.fromEntries(declaration.horizonsMs.map((h) => [String(h), rows.filter((r) => r.labels[String(h)] === null).length]));
  const body = { manifestVersion: EDGE_EVAL_VERSION, evaluationId: declaration.evaluationId, declarationId: declaration.declarationId, declarationDigest: declarationDigestOf(declaration), stage, runId, asOfTs, sealedTs, sources: sources.map((s) => ({ bundleKind: s.bundleKind, bundleId: s.bundleId, manifestSha256: s.manifestSha256 })), codeDigest: declaration.codeDigest, policyDigest: declaration.policyDigest, recipeSetVersion: declaration.recipeSetVersion, recipeDigest: declaration.recipeDigest, timeRange: { startTs: rows.length ? rows[0].decisionTs : declaration.startTs, endTs: rows.length ? rows[rows.length - 1].decisionTs : declaration.startTs }, rowCount: rows.length, rowIdentityDigest: rowIdentityDigest(rows), splitCounts: Object.fromEntries(DECISION_STATES.map((s) => [s, rows.filter((r) => r.split === s).length])), featureIds: [...ALL_FEATURES], horizonsMs: [...declaration.horizonsMs], availability, supportCounts, censored, coverageSummary: { publicObservations: coverageSummary?.publicObservations ?? 0, darkObservations: coverageSummary?.darkObservations ?? 0, darkCoverageRecords: coverageSummary?.darkCoverageRecords ?? 0, darkGapRecords: coverageSummary?.darkGapRecords ?? 0 } };
  const m = { ...body, manifestDigest: manifestDigestOf(body) }; const e = manifestError(m, declaration); if (e) fail('INVALID_INPUT', e);
  return deepFreeze(m);
}
// ---- the pure scoring primitive (rank correlation over COMPLETE rows; n reconciled with the manifest) ---------------------------
const ranks = (xs) => { const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k += 1) r[idx[k][1]] = avg; i = j + 1; } return r; };
export function spearman(xs, ys) { const n = xs.length; if (n < 3) return null; const rx = ranks(xs); const ry = ranks(ys); const mx = rx.reduce((a, b) => a + b, 0) / n; const my = ry.reduce((a, b) => a + b, 0) / n; let num = 0; let dx = 0; let dy = 0; for (let i = 0; i < n; i += 1) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return dx > 0 && dy > 0 ? round(num / Math.sqrt(dx * dy)) : null; }
// PRIMITIVE: pure statistics over rows. It returns bare arm tables — never a report, never evidence. Production reports come only
// from scoreSealedDataset, which binds the rows to the sealed manifest whose availability counts these n must equal.
export function scoreRowsPrimitive(rows, { split, arms, features, horizonsMs, minN = MIN_SCORED_N }) {
  const rs = rows.filter((r) => r.split === split); const out = {};
  for (const arm of arms) { const horizons = {}; for (const h of horizonsMs) { const fs = {}; const ics = []; for (const f of features[arm]) { const pairs = rs.filter((r) => r.support[f].state === 'COMPLETE' && isFiniteNum(r.features[f]) && r.labels[String(h)] !== null); const ic = pairs.length >= minN ? spearman(pairs.map((r) => r.features[f]), pairs.map((r) => r.labels[String(h)].value)) : null; fs[f] = { n: pairs.length, spearmanIc: ic, state: pairs.length >= minN ? (ic === null ? 'DEGENERATE' : 'SCORED') : 'INSUFFICIENT_N' }; if (ic !== null) ics.push(Math.abs(ic)); } horizons[String(h)] = { features: fs, scoredFeatures: ics.length, meanAbsIc: ics.length ? round(ics.reduce((a, b) => a + b, 0) / ics.length) : null, maxAbsIc: ics.length ? round(Math.max(...ics)) : null }; } out[arm] = { featureCount: features[arm].length, horizons }; }
  return out;
}
// the production report: rows + their sealed manifest + the declaration (+ the lock for the holdout); n must equal the manifest
export function scoreSealedDataset({ declaration, manifest, rows, stage, generatedTs, lock = null, minN = MIN_SCORED_N }) {
  const de = declarationError(declaration); if (de) fail('INVALID_INPUT', de); const me = manifestError(manifest, declaration); if (me) fail('INVALID_INPUT', me);
  if (manifest.stage !== stage) fail('INVALID_INPUT', 'the manifest was sealed for another stage'); if (rowIdentityDigest(rows) !== manifest.rowIdentityDigest || rows.length !== manifest.rowCount) fail('INVALID_INPUT', 'rows are not the sealed rows of this manifest');
  const arms = stage === 'HOLDOUT' ? [lock?.arm].filter(Boolean) : [...EDGE_ARMS]; if (stage === 'HOLDOUT' && !lock) fail('INVALID_REQUEST', 'a holdout report needs the selection lock');
  const scored = scoreRowsPrimitive(rows, { split: stage, arms, features: declaration.features, horizonsMs: declaration.horizonsMs, minN });
  const body = { reportVersion: EDGE_EVAL_VERSION, evaluationId: declaration.evaluationId, declarationId: declaration.declarationId, declarationDigest: declarationDigestOf(declaration), mode: declaration.prospective ? 'PROSPECTIVE' : 'RETROSPECTIVE', stage, runId: manifest.runId, asOfTs: manifest.asOfTs, generatedTs, datasetDigest: manifest.manifestDigest, codeDigest: declaration.codeDigest, policyDigest: declaration.policyDigest, recipeSetVersion: declaration.recipeSetVersion, recipeDigest: declaration.recipeDigest, scoringLaw: SCORING_LAW, splitLaw: SPLIT_LAW, decisionPoints: manifest.rowCount, splitCounts: { ...manifest.splitCounts }, scoredSplit: stage, scoredRows: manifest.splitCounts[stage], minN, arms: scored, holdout: { state: stage === 'HOLDOUT' ? 'OPENED' : 'SEALED', rows: manifest.splitCounts.HOLDOUT }, edgeClaim: 'NOT_MADE', promotionCriteria: 'NONE', releaseEvidence: declaration.prospective ? 'NONE' : 'NEVER', authority: 'NONE', tradingAuthority: 'NONE', judgeAuthority: 'NONE', socratesConsumption: 'NONE' };
  const r = { ...body, reportDigest: reportDigestOf(body) }; const e = reportError(r, { declaration, manifest, lock }); if (e) fail('INTERNAL_FAILURE', e);
  return deepFreeze(r);
}
// ---- lock / open / qualification helpers ---------------------------------------------------------------------------------------
export function buildSelectionLock({ declaration, arm, lockedTs, lookReportDigests }) { const body = { evaluationId: declaration.evaluationId, declarationDigest: declarationDigestOf(declaration), arm, lockedTs, selectionDeadlineTs: declaration.selectionDeadlineTs, codeDigest: declaration.codeDigest, policyDigest: declaration.policyDigest, recipeDigest: declaration.recipeDigest, lookReportDigests: [...lookReportDigests] }; return deepFreeze({ ...body, lockDigest: lockDigestOf(body) }); }
export function buildHoldoutOpening({ declaration, lock, openedTs }) { const body = { evaluationId: declaration.evaluationId, runId: `run-${canonicalDigest({ lock: lock.lockDigest, openedTs }).slice(0, 32)}`, openedTs, lockDigest: lock.lockDigest, arm: lock.arm, declarationDigest: declarationDigestOf(declaration), codeDigest: declaration.codeDigest, policyDigest: declaration.policyDigest, recipeDigest: declaration.recipeDigest, sourceRoots: declaration.sourceRoots.map((s) => ({ ...s })) }; return deepFreeze({ ...body, openingDigest: openingDigestOf(body) }); }
export function qualificationOf({ declaration, manifest, report, lock, minN = MIN_SCORED_N }) {
  const blockers = []; if (!declaration.prospective) blockers.push('DECLARATION_RETROSPECTIVE');
  if (manifest.splitCounts.HOLDOUT === 0) blockers.push('HOLDOUT_EMPTY');
  const arm = report.arms[lock.arm]; const anyScored = arm && Object.values(arm.horizons).some((h) => h.scoredFeatures > 0); const anyN = arm && Object.values(arm.horizons).some((h) => Object.values(h.features).some((f) => f.n >= minN));
  if (manifest.splitCounts.HOLDOUT > 0 && !anyN) blockers.push('HOLDOUT_INSUFFICIENT_N'); if (anyN && !anyScored) blockers.push('HOLDOUT_UNSCORABLE');
  if (manifest.splitCounts.HOLDOUT > 0 && declaration.horizonsMs.every((h) => manifest.censored[String(h)] >= manifest.rowCount)) blockers.push('HOLDOUT_CENSORED');
  return { status: blockers.length ? 'CONSUMED_BUT_UNQUALIFIED' : 'QUALIFIED', blockers: [...new Set(blockers)] };
}
