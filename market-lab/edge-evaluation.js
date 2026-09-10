// MARKET-EDGE-KRAKEN-1 §9 — the DARK prospective evaluation harness. It measures, it never promotes: no threshold, no
// promotion criterion, no Judge / Socrates / execution hook. Arms are FEATURE SETS (baseline vs baseline + each dark sense
// vs both) evaluated as rank correlations with forward spot returns at declared horizons over chronological, embargoed,
// dependency-safe splits. The split law mirrors judge/experiment.js (declare -> chronological blocks -> purge across
// boundaries -> holdout sealed until explicitly opened) WITHOUT importing it (market-lab never imports judge/).
// Time truth: a decision point at t sees only observations with knownAtTs <= t; labels come from closed spot candles known
// at the evaluation's own as-of; nothing here reinterprets a historical fetch as real-time knowledge.
import { deepFreeze, fail, isTs, isFiniteNum, isUnitFraction, round, canonicalDigest, exactKeys, isId, isCoin, SHA256_RE } from './contracts.js';
import { derivativesPressure, l3Microstructure, EDGE_RECIPE_SET_VERSION } from './edge-recipes.js';
import { MINUTE_MS } from './time.js';

export const EDGE_EVALUATION_VERSION = 'market-edge-evaluation-1';
export const EDGE_ARMS = Object.freeze(['EXISTING_MARKET_BASELINE', 'BASELINE_PLUS_DERIVATIVES_PRESSURE', 'BASELINE_PLUS_L3_MICROSTRUCTURE', 'BASELINE_PLUS_BOTH']);
export const EDGE_HORIZONS_MS = Object.freeze([1, 5, 15, 30, 60].map((m) => m * MINUTE_MS));
export const EDGE_SPLITS = Object.freeze(['DEVELOPMENT', 'VALIDATION', 'HOLDOUT']);
export const DECISION_STATES = Object.freeze(['DEVELOPMENT', 'VALIDATION', 'HOLDOUT', 'PURGED', 'OUT_OF_WINDOW']);
export const SPLIT_LAW = 'chronological blocks in the declared fractions; a decision point whose outcome window (embargo >= max horizon) crosses its block boundary is PURGED; the holdout stays sealed until opened explicitly; mirrors the Judge experiment law without importing judge/';
export const MIN_SCORED_N = 30;
export const BASELINE_FEATURES = Object.freeze(['log_return_5m', 'log_return_15m', 'realized_volatility_20', 'signed_notional_imbalance_5m', 'spread_bps']);
export const DERIVATIVES_FEATURES = Object.freeze(['oi_bucket_change', 'oi_bucket_acceleration', 'aggressor_bucket_level', 'aggressor_bucket_slope', 'cvd_bucket_change', 'cvd_bucket_slope', 'liquidation_bucket_burst', 'basis_bucket_change', 'funding_bucket_change']);
export const L3_FEATURES = Object.freeze(['visible_order_age_imbalance', 'queue_turnover_imbalance', 'depth_persistence_bid', 'depth_persistence_ask', 'new_order_impulse_net', 'liquidity_disappearance_net', 'replenishment_ratio', 'queue_concentration_touch_bid', 'queue_concentration_touch_ask', 'order_age_p50_bid_ms', 'order_age_p50_ask_ms', 'top_level_churn_net', 'microstructure_pressure_change']);
export const ARM_FEATURES = deepFreeze({ EXISTING_MARKET_BASELINE: [...BASELINE_FEATURES], BASELINE_PLUS_DERIVATIVES_PRESSURE: [...BASELINE_FEATURES, ...DERIVATIVES_FEATURES], BASELINE_PLUS_L3_MICROSTRUCTURE: [...BASELINE_FEATURES, ...L3_FEATURES], BASELINE_PLUS_BOTH: [...BASELINE_FEATURES, ...DERIVATIVES_FEATURES, ...L3_FEATURES] });
export const DECLARATION_KEYS = Object.freeze(['evaluationVersion', 'declarationId', 'evaluationId', 'declaredTs', 'prospective', 'startTs', 'durationMs', 'fractions', 'embargoMs', 'decisionCadenceMs', 'horizonsMs', 'analyticsIntervalMs', 'l3WindowMs', 'seed', 'policyDigest', 'codeDigest', 'subject', 'arms', 'splitLaw', 'authority']);
export const SUBJECT_KEYS = Object.freeze(['canonicalCoin', 'spotSymbol', 'futuresSymbol']);
export const REPORT_KEYS = Object.freeze(['evaluationVersion', 'recipeSetVersion', 'declarationId', 'evaluationId', 'asOfTs', 'decisionPoints', 'splitCounts', 'splits', 'holdout', 'edgeClaim', 'promotionCriteria', 'authority', 'tradingAuthority', 'judgeAuthority', 'socratesConsumption', 'law']);

export function declareEdgeEvaluation({ evaluationId, declaredTs, startTs, durationMs, fractions = { development: 0.5, validation: 0.25, holdout: 0.25 }, embargoMs, decisionCadenceMs = 5 * MINUTE_MS, horizonsMs = EDGE_HORIZONS_MS, analyticsIntervalMs = 5 * MINUTE_MS, l3WindowMs = 5 * MINUTE_MS, seed, policyDigest, codeDigest = null, subject }) {
  if (!isId(evaluationId) || !isTs(declaredTs) || !isTs(startTs) || !isTs(durationMs) || !isId(seed)) fail('INVALID_REQUEST', 'declaration identity/clocks malformed');
  if (!policyDigest || !SHA256_RE.test(String(policyDigest)) || !(codeDigest === null || SHA256_RE.test(String(codeDigest)))) fail('INVALID_REQUEST', 'policy/code digest malformed');
  const fk = exactKeys(fractions, ['development', 'validation', 'holdout'], 'fractions'); if (fk) fail('INVALID_REQUEST', fk);
  const fs = [fractions.development, fractions.validation, fractions.holdout]; if (!fs.every(isUnitFraction) || Math.abs(fs[0] + fs[1] + fs[2] - 1) > 1e-9 || fs[0] <= 0 || fs[1] <= 0) fail('INVALID_REQUEST', 'fractions must be unit fractions summing to 1 with positive development and validation');
  if (!Array.isArray(horizonsMs) || !horizonsMs.length || horizonsMs.some((h) => !isTs(h)) || new Set(horizonsMs).size !== horizonsMs.length) fail('INVALID_REQUEST', 'horizons malformed');
  const maxH = Math.max(...horizonsMs);
  if (!isTs(embargoMs) || embargoMs < maxH) fail('INVALID_REQUEST', 'embargoMs must cover the longest horizon');
  if (!isTs(decisionCadenceMs) || decisionCadenceMs < MINUTE_MS || !isTs(analyticsIntervalMs) || !isTs(l3WindowMs)) fail('INVALID_REQUEST', 'cadence/interval/window malformed');
  const sk = exactKeys(subject, SUBJECT_KEYS, 'subject'); if (sk) fail('INVALID_REQUEST', sk); if (!isCoin(subject.canonicalCoin) || !isId(subject.spotSymbol) || !isId(subject.futuresSymbol)) fail('INVALID_REQUEST', 'subject malformed');
  const body = { evaluationVersion: EDGE_EVALUATION_VERSION, evaluationId, declaredTs, prospective: declaredTs <= startTs, startTs, durationMs, fractions: { ...fractions }, embargoMs, decisionCadenceMs, horizonsMs: [...horizonsMs].sort((a, b) => a - b), analyticsIntervalMs, l3WindowMs, seed, policyDigest, codeDigest, subject: { ...subject }, arms: [...EDGE_ARMS], splitLaw: SPLIT_LAW, authority: 'NONE' };
  return deepFreeze({ ...body, declarationId: `ee-${canonicalDigest(body)}` });
}
export function declarationError(d, where = 'declaration') { const k = exactKeys(d, DECLARATION_KEYS, where); if (k) return k; if (d.evaluationVersion !== EDGE_EVALUATION_VERSION || d.authority !== 'NONE') return `${where}: version/authority`; const { declarationId, ...body } = d; if (declarationId !== `ee-${canonicalDigest(body)}`) return `${where}: declarationId does not match content`; return null; }
export const splitBoundaries = (d) => { const b1 = d.startTs + Math.floor(d.durationMs * d.fractions.development); const b2 = b1 + Math.floor(d.durationMs * d.fractions.validation); return { development: [d.startTs, b1], validation: [b1, b2], holdout: [b2, d.startTs + d.durationMs] }; };
// dependency-safe assignment: the outcome window [t, t + embargo] must stay inside its own block
export function assignDecision(d, t) {
  if (!isTs(t) || t < d.startTs || t >= d.startTs + d.durationMs) return 'OUT_OF_WINDOW';
  const b = splitBoundaries(d);
  for (const [split, [s, e]] of Object.entries(b)) { if (t >= s && t < e) { if (e - s <= 0) return 'OUT_OF_WINDOW'; return t + d.embargoMs > e ? 'PURGED' : split.toUpperCase(); } }
  return 'OUT_OF_WINDOW';
}
export const decisionPoints = (d) => { const out = []; for (let t = d.startTs; t < d.startTs + d.durationMs; t += d.decisionCadenceMs) out.push(t); return out; };

// ---- baseline features from the EXISTING spot senses at t (knownAtTs <= t) --------------------------------------------------
const asOf = (obs, t) => obs.filter((o) => o.knownAtTs <= t);
const closedCandles = (obs, symbol, intervalMs) => obs.filter((o) => o.kind === 'CANDLE' && o.payload.closed && o.payload.intervalMs === intervalMs && o.subject.nativeSymbol === symbol && isFiniteNum(o.payload.close)).sort((a, b) => a.periodEndTs - b.periodEndTs || a.knownAtTs - b.knownAtTs);
const closeAt = (candles, ts) => { let best = null; for (const c of candles) { if (c.periodEndTs <= ts) best = c; else break; } return best; };
// anchored on the latest candle KNOWN at t (a candle is known only after its close was received), never on t itself
const logReturn = (candles, t, backMs) => { const now = closeAt(candles, t); if (!now) return null; const then = closeAt(candles, now.periodEndTs - backMs); if (!then || now === then || then.periodEndTs !== now.periodEndTs - backMs) return null; return round(Math.log(now.payload.close / then.payload.close)); };
const realizedVol = (candles, t, n) => { const upTo = candles.filter((c) => c.periodEndTs <= t); const last = upTo.slice(-(n + 1)); if (last.length < n + 1) return null; for (let i = 1; i < last.length; i += 1) if (last[i].periodEndTs - last[i - 1].periodEndTs !== last[i].payload.intervalMs) return null; const r = []; for (let i = 1; i < last.length; i += 1) r.push(Math.log(last[i].payload.close / last[i - 1].payload.close)); const m = r.reduce((a, b) => a + b, 0) / r.length; return round(Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / r.length)); };
const signedImbalance = (obs, symbol, t, windowMs) => { let b = 0; let s = 0; let n = 0; for (const o of obs) { if (o.kind !== 'TRADE' || o.subject.nativeSymbol !== symbol) continue; const ts = o.sourceEventTs ?? o.receivedTs; if (ts <= t - windowMs || ts > t) continue; n += 1; if (o.payload.takerSide === 'BUY') b += o.payload.quoteNotional; else if (o.payload.takerSide === 'SELL') s += o.payload.quoteNotional; } return n && b + s > 0 ? round((b - s) / (b + s)) : null; };
const spreadBps = (obs, symbol, t) => { const books = obs.filter((o) => o.kind === 'BOOK_SNAPSHOT' && o.subject.nativeSymbol === symbol && o.receivedTs <= t && o.payload.bids.length && o.payload.asks.length).sort((a, b) => a.receivedTs - b.receivedTs); const b = books.at(-1); if (!b) return null; const bid = b.payload.bids[0][0]; const ask = b.payload.asks[0][0]; const mid = (bid + ask) / 2; return mid > 0 ? round(1e4 * (ask - bid) / mid) : null; };
export function baselineFeatures(observations, { spotSymbol, t }) {
  const obs = asOf(observations, t); const candles = closedCandles(obs, spotSymbol, MINUTE_MS);
  return { log_return_5m: logReturn(candles, t, 5 * MINUTE_MS), log_return_15m: logReturn(candles, t, 15 * MINUTE_MS), realized_volatility_20: realizedVol(candles, t, 20), signed_notional_imbalance_5m: signedImbalance(obs, spotSymbol, t, 5 * MINUTE_MS), spread_bps: spreadBps(obs, spotSymbol, t) };
}
const numOrNull = (v) => (isFiniteNum(v) ? v : null);
export function derivativesFeatures(observations, { futuresSymbol, t, intervalMs }) {
  const obs = asOf(observations, t).filter((o) => o.kind === 'DERIVATIVE_ANALYTIC_BUCKET' && o.subject.instrumentId === futuresSymbol);
  const d = derivativesPressure(obs, { intervalMs, asOfTs: t }); const c = d.components;
  return Object.fromEntries(DERIVATIVES_FEATURES.map((id) => [id, numOrNull(c[id].value)]));
}
export function l3Features(observations, { spotSymbol, t, windowMs }) {
  const obs = asOf(observations, t).filter((o) => ['L3_BOOK_SNAPSHOT', 'L3_ORDER_EVENT', 'L3_BOOK_COVERAGE'].includes(o.kind) && o.subject.nativeSymbol === spotSymbol);
  const m = l3Microstructure(obs, { asOfTs: t, startTs: t - windowMs, endTs: t }); const c = m.components; const v = (id) => c[id].value;
  const dis = v('visible_liquidity_disappearance'); const qc = v('queue_concentration'); const oa = v('order_age_quantiles'); const tc = v('top_level_churn'); const dp = v('depth_persistence'); const ni = v('new_order_impulse'); const rp = v('replenishment_after_pressure');
  return { visible_order_age_imbalance: numOrNull(v('visible_order_age_imbalance')), queue_turnover_imbalance: numOrNull(v('queue_turnover_imbalance')), depth_persistence_bid: numOrNull(dp?.bid), depth_persistence_ask: numOrNull(dp?.ask), new_order_impulse_net: numOrNull(ni?.net), liquidity_disappearance_net: dis && !dis.gap ? round(dis.bid.deleted - dis.ask.deleted) : null, replenishment_ratio: numOrNull(rp?.ratio), queue_concentration_touch_bid: numOrNull(qc?.bid?.touchShare), queue_concentration_touch_ask: numOrNull(qc?.ask?.touchShare), order_age_p50_bid_ms: numOrNull(oa?.bid?.p50Ms), order_age_p50_ask_ms: numOrNull(oa?.ask?.p50Ms), top_level_churn_net: tc && isFiniteNum(tc.bid) && isFiniteNum(tc.ask) ? tc.bid - tc.ask : null, microstructure_pressure_change: numOrNull(v('microstructure_pressure_change')) };
}
// forward log return from closed 1m spot candles known at the evaluation as-of (the label uses the future ONLY here)
export function forwardLabel(candles, t, horizonMs) { const now = closeAt(candles, t); const later = closeAt(candles, t + horizonMs); if (!now || !later || later.periodEndTs <= t) return null; return round(Math.log(later.payload.close / now.payload.close)); }

export function buildEdgeDataset({ declaration, observations, asOfTs }) {
  const e = declarationError(declaration); if (e) fail('INVALID_INPUT', e);
  if (!isTs(asOfTs)) fail('INVALID_REQUEST', 'asOfTs required');
  const { spotSymbol, futuresSymbol } = declaration.subject;
  const labelCandles = closedCandles(asOf(observations, asOfTs), spotSymbol, MINUTE_MS);
  const rows = [];
  for (const t of decisionPoints(declaration)) {
    if (t > asOfTs) break; // a decision point after the as-of does not exist yet
    const split = assignDecision(declaration, t);
    const features = { ...baselineFeatures(observations, { spotSymbol, t }), ...derivativesFeatures(observations, { futuresSymbol, t, intervalMs: declaration.analyticsIntervalMs }), ...l3Features(observations, { spotSymbol, t, windowMs: declaration.l3WindowMs }) };
    const labels = Object.fromEntries(declaration.horizonsMs.map((h) => [String(h), t + h <= asOfTs ? forwardLabel(labelCandles, t, h) : null]));
    rows.push(deepFreeze({ decisionTs: t, split, features, labels }));
  }
  const splitCounts = Object.fromEntries(DECISION_STATES.map((s) => [s, rows.filter((r) => r.split === s).length]));
  return deepFreeze({ datasetVersion: EDGE_EVALUATION_VERSION, declarationId: declaration.declarationId, asOfTs, rows, splitCounts, featureIds: ARM_FEATURES.BASELINE_PLUS_BOTH });
}
// ---- scoring: Spearman rank correlation per feature / horizon / split; arms aggregate their own feature sets --------------------
const ranks = (xs) => { const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k += 1) r[idx[k][1]] = avg; i = j + 1; } return r; };
export function spearman(xs, ys) { const n = xs.length; if (n < 3) return null; const rx = ranks(xs); const ry = ranks(ys); const mx = rx.reduce((a, b) => a + b, 0) / n; const my = ry.reduce((a, b) => a + b, 0) / n; let num = 0; let dx = 0; let dy = 0; for (let i = 0; i < n; i += 1) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return dx > 0 && dy > 0 ? round(num / Math.sqrt(dx * dy)) : null; };
export function scoreEdgeDataset({ declaration, dataset, includeHoldout = false, minN = MIN_SCORED_N }) {
  const e = declarationError(declaration); if (e) fail('INVALID_INPUT', e); if (dataset.declarationId !== declaration.declarationId) fail('INVALID_INPUT', 'dataset belongs to another declaration');
  const splits = includeHoldout ? ['DEVELOPMENT', 'VALIDATION', 'HOLDOUT'] : ['DEVELOPMENT', 'VALIDATION'];
  const scoreSplit = (split) => { const rows = dataset.rows.filter((r) => r.split === split); const arms = {}; for (const arm of EDGE_ARMS) { const horizons = {}; for (const h of declaration.horizonsMs) { const features = {}; const ics = []; for (const f of ARM_FEATURES[arm]) { const pairs = rows.filter((r) => isFiniteNum(r.features[f]) && isFiniteNum(r.labels[String(h)])); const ic = pairs.length >= minN ? spearman(pairs.map((r) => r.features[f]), pairs.map((r) => r.labels[String(h)])) : null; features[f] = { n: pairs.length, spearmanIc: ic, state: pairs.length >= minN ? (ic === null ? 'DEGENERATE' : 'SCORED') : 'INSUFFICIENT_N' }; if (ic !== null) ics.push(Math.abs(ic)); } horizons[String(h)] = { features, scoredFeatures: ics.length, meanAbsIc: ics.length ? round(ics.reduce((a, b) => a + b, 0) / ics.length) : null, maxAbsIc: ics.length ? round(Math.max(...ics)) : null }; } arms[arm] = { featureCount: ARM_FEATURES[arm].length, horizons }; } return { rows: rows.length, arms }; };
  const out = { evaluationVersion: EDGE_EVALUATION_VERSION, recipeSetVersion: EDGE_RECIPE_SET_VERSION, declarationId: declaration.declarationId, evaluationId: declaration.evaluationId, asOfTs: dataset.asOfTs, decisionPoints: dataset.rows.length, splitCounts: dataset.splitCounts, splits: Object.fromEntries(splits.filter((s) => s !== 'HOLDOUT').map((s) => [s, scoreSplit(s)])), holdout: includeHoldout ? { state: 'OPENED', ...scoreSplit('HOLDOUT') } : { state: 'SEALED', rows: dataset.splitCounts.HOLDOUT }, edgeClaim: 'NOT_MADE', promotionCriteria: 'NONE', authority: 'NONE', tradingAuthority: 'NONE', judgeAuthority: 'NONE', socratesConsumption: 'NONE', law: SPLIT_LAW };
  return deepFreeze(out);
}
export function edgeEvaluationError(r, where = 'edge-evaluation') { const k = exactKeys(r, REPORT_KEYS, where); if (k) return k; if (r.evaluationVersion !== EDGE_EVALUATION_VERSION || r.edgeClaim !== 'NOT_MADE' || r.promotionCriteria !== 'NONE' || r.authority !== 'NONE' || r.tradingAuthority !== 'NONE' || r.judgeAuthority !== 'NONE' || r.socratesConsumption !== 'NONE') return `${where}: a dark evaluation never claims edge or authority`; if (!/^ee-[0-9a-f]{64}$/.test(String(r.declarationId)) || !isTs(r.asOfTs)) return `${where}: identity malformed`; if (!['SEALED', 'OPENED'].includes(r.holdout?.state)) return `${where}: holdout state`; for (const s of Object.keys(r.splits)) { if (!['DEVELOPMENT', 'VALIDATION'].includes(s)) return `${where}: split ${s}`; for (const a of Object.keys(r.splits[s].arms)) if (!EDGE_ARMS.includes(a)) return `${where}: arm ${a}`; } return null; }
