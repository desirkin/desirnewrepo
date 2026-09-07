// SOCIAL-5B §9 — the SEPARATE, PREDETERMINED CANDLE-ONLY LABEL RECIPE (social-research-candle-labels-1).
// Labels are computed from the EXISTING raw Childhood 1m track only, anchored to the decision clock:
//   anchorTsMs = ceil(D / 60000) * 60000; anchorLagMs = anchorTsMs - D in [0, 60000)
//   reference price p = close of the 1m bar opening at anchorTsMs/1000 - 60 (fully closed at the anchor; no stale substitute)
//   for H in [1,3,5,15,30,60,240] minutes: bars at EVERY open from the anchor through anchor + H*60 - 60 s, and source
//   coverage through the final close; mfePct = max(0,(max(high)/p - 1)*100), maePct = min(0,(min(low)/p - 1)*100);
//   for 60/240 also logReturnPct = 100 * ln(finalClose / p) (LOG_RETURN_PERCENT, Childhood's ret1hPct convention)
//   horizonEndTs = anchor + H*60000; outcomeKnownAtTs = max(horizonEndTs, archiveCreatedTs, series retrievedTs)
// The anchor / reference price is LABEL-SIDE only: when D falls between minutes it was not yet available at decision
// time — a delayed candle reference, never an entry fill, a signal price or a performance claim at D. Missing bars are
// CENSORED, never zero return; an absent archive / track / reference bar is OUTCOME_UNAVAILABLE; a value whose knowledge
// floor is after the dataset as-of is NOT_YET_KNOWN with every value null (never a zero, never a loss). Nothing here
// resolves high/low ordering, fees, slippage, liquidity, fills or edge, and no tag / threshold / stage label exists.
import { LIMITS, LABEL_RECIPE_VERSION, LABEL_HORIZONS_MIN, LOG_RETURN_HORIZONS_MIN, OUTCOME_ROW_KEYS, OUTCOME_HORIZON_KEYS, LABEL_STATES, LABEL_REASONS, COHORTS, AUTHORITY, PURPOSE, fail, isPlainObject, isTs, isCoin, isFiniteNum, round4, exactKeys, deepFreeze } from './contracts.js';

export const anchorOf = (decisionKnownAtTs) => { const anchorTsMs = Math.ceil(decisionKnownAtTs / 60_000) * 60_000; return { anchorTsMs, anchorLagMs: anchorTsMs - decisionKnownAtTs }; };
// pure excursion arithmetic over COMPLETE, validated bars ([openSec,o,h,l,c,v]) relative to a reference price
export function excursions(bars, referencePrice) {
  if (!Array.isArray(bars) || bars.length === 0 || !isFiniteNum(referencePrice) || referencePrice <= 0) fail('VALIDATION_FAILURE', 'excursions require complete bars and a positive reference price');
  let hi = -Infinity; let lo = Infinity;
  for (const b of bars) { if (b[2] > hi) hi = b[2]; if (b[3] < lo) lo = b[3]; }
  return { mfePct: round4(Math.max(0, (hi / referencePrice - 1) * 100)), maePct: round4(Math.min(0, (lo / referencePrice - 1) * 100)), finalClose: bars[bars.length - 1][4], logReturnPct: round4(100 * Math.log(bars[bars.length - 1][4] / referencePrice)) };
}
const hz = (state, reason, horizonEndTs, outcomeKnownAtTs, values = {}, logHorizon = false) => ({ state, reason, horizonEndTs, outcomeKnownAtTs, mfePct: values.mfePct ?? null, maePct: values.maePct ?? null, logReturnPct: logHorizon ? (values.logReturnPct ?? null) : null, logReturnUnit: logHorizon ? 'LOG_RETURN_PERCENT' : null });

// label ONE row. `archive` is the readChildhoodArchive() result or null; `asOfTs` the FROZEN dataset as-of clock.
export function labelRow({ rowId, cohort, canonicalCoin, decisionKnownAtTs }, { archive = null, asOfTs, limits = LIMITS } = {}) {
  if (typeof rowId !== 'string' || !COHORTS.includes(cohort) || typeof canonicalCoin !== 'string' || !isTs(decisionKnownAtTs) || !isTs(asOfTs)) fail('VALIDATION_FAILURE', 'labelRow: identity / clocks malformed');
  const { anchorTsMs, anchorLagMs } = anchorOf(decisionKnownAtTs);
  const base = { rowId, labelRecipeVersion: LABEL_RECIPE_VERSION, cohort, canonicalCoin, decisionKnownAtTs, anchorTsMs, anchorLagMs, sourceTrack: '1m', authority: AUTHORITY, purpose: PURPOSE };
  const unavailable = (reason) => deepFreeze({ ...base, availability: { state: 'UNAVAILABLE', reason }, reference: { state: 'OUTCOME_UNAVAILABLE', barOpenSec: null, price: null, knownAtTs: null }, horizons: Object.fromEntries(LABEL_HORIZONS_MIN.map((h) => [`${h}m`, hz('OUTCOME_UNAVAILABLE', reason, anchorTsMs + h * 60_000, null, {}, LOG_RETURN_HORIZONS_MIN.includes(h))])) });
  if (!archive) return unavailable('ARCHIVE_ABSENT');
  if (!isTs(archive.archiveCreatedTsMs)) return unavailable('PROVENANCE_CLOCK_MISSING');
  if (!(archive.oneMinute instanceof Map) || archive.oneMinute.size === 0) return unavailable('NO_1M_TRACK');
  const series = archive.oneMinute.get(canonicalCoin);
  if (!series) return unavailable('SERIES_ABSENT_FOR_ASSET');
  if (!isTs(series.retrievedTsMs)) return unavailable('PROVENANCE_CLOCK_MISSING');
  const anchorSec = anchorTsMs / 1000; const refOpenSec = anchorSec - 60;
  if (series.firstOpenSec === null || refOpenSec < series.firstOpenSec || refOpenSec > series.lastOpenSec) return unavailable('NO_TEMPORAL_OVERLAP');
  const refIdx = series.index.get(refOpenSec);
  if (refIdx === undefined) return unavailable('REFERENCE_BAR_MISSING');
  const referenceKnownAtTs = Math.max(anchorTsMs, archive.archiveCreatedTsMs, series.retrievedTsMs); // the reference bar closes at the anchor, but Cobra learns it only through the archive
  const p = series.candles[refIdx][4];
  const horizons = {};
  for (const h of LABEL_HORIZONS_MIN) {
    const key = `${h}m`; const logH = LOG_RETURN_HORIZONS_MIN.includes(h);
    const horizonEndTs = anchorTsMs + h * 60_000;
    const outcomeKnownAtTs = Math.max(horizonEndTs, archive.archiveCreatedTsMs, series.retrievedTsMs);
    if (asOfTs < outcomeKnownAtTs) { horizons[key] = hz('NOT_YET_KNOWN', 'NOT_YET_KNOWN_AT_AS_OF', horizonEndTs, outcomeKnownAtTs, {}, logH); continue; }
    if (series.coverageEndSec < anchorSec + h * 60) { horizons[key] = hz('CENSORED', 'SOURCE_COVERAGE_ENDS_BEFORE_HORIZON', horizonEndTs, outcomeKnownAtTs, {}, logH); continue; }
    const start = series.index.get(anchorSec);
    let complete = start !== undefined && start + h - 1 < series.count;
    if (complete) for (let k = 0; k < h; k += 1) if (series.candles[start + k][0] !== anchorSec + 60 * k) { complete = false; break; }
    if (!complete) { horizons[key] = hz('CENSORED', 'INTERIOR_BAR_MISSING', horizonEndTs, outcomeKnownAtTs, {}, logH); continue; }
    const x = excursions(series.candles.slice(start, start + h), p);
    horizons[key] = hz('KNOWN', 'COMPLETE', horizonEndTs, outcomeKnownAtTs, x, logH);
  }
  const reference = asOfTs < referenceKnownAtTs ? { state: 'NOT_YET_KNOWN', barOpenSec: null, price: null, knownAtTs: referenceKnownAtTs } : { state: 'KNOWN', barOpenSec: refOpenSec, price: p, knownAtTs: referenceKnownAtTs };
  const states = Object.values(horizons).map((x) => x.state);
  const availability = states.some((s) => s === 'KNOWN' || s === 'NOT_YET_KNOWN') ? { state: states.every((s) => s === 'KNOWN' || s === 'NOT_YET_KNOWN') ? 'AVAILABLE' : 'PARTIAL', reason: 'COMPLETE' } : { state: 'PARTIAL', reason: 'INTERIOR_BAR_MISSING' };
  return deepFreeze({ ...base, availability, reference, horizons });
}

export function validateOutcomeRow(r) {
  const k = exactKeys(r, OUTCOME_ROW_KEYS); if (k) return `outcome row: ${k}`;
  if (r.labelRecipeVersion !== LABEL_RECIPE_VERSION) return 'outcome row: unsupported label recipe';
  if (typeof r.rowId !== 'string' || r.rowId.length === 0 || !COHORTS.includes(r.cohort) || !isCoin(r.canonicalCoin) || !isTs(r.decisionKnownAtTs) || !isTs(r.anchorTsMs) || r.sourceTrack !== '1m') return 'outcome row: identity malformed';
  const a = anchorOf(r.decisionKnownAtTs); if (r.anchorTsMs !== a.anchorTsMs || r.anchorLagMs !== a.anchorLagMs) return 'outcome row: anchor is not the recipe anchor';
  if (r.authority !== AUTHORITY || r.purpose !== PURPOSE) return 'outcome row: authority must be NONE / RESEARCH_ONLY';
  // a CLOSED object, not merely one carrying two recognized fields: an availability verdict is never a place to smuggle a payload
  if (!isPlainObject(r.availability) || exactKeys(r.availability, ['state', 'reason']) || !['AVAILABLE', 'PARTIAL', 'UNAVAILABLE'].includes(r.availability.state) || !LABEL_REASONS.includes(r.availability.reason)) return 'outcome row: availability malformed';
  if (!isPlainObject(r.reference) || exactKeys(r.reference, ['state', 'barOpenSec', 'price', 'knownAtTs']) || !['KNOWN', 'NOT_YET_KNOWN', 'OUTCOME_UNAVAILABLE'].includes(r.reference.state)) return 'outcome row: reference malformed';
  if (r.reference.state !== 'KNOWN' && (r.reference.price !== null || r.reference.barOpenSec !== null)) return 'outcome row: a reference price is exposed before its knowledge floor';
  // the reference bar is the one CLOSING at the anchor, and Cobra learns it no earlier than the anchor itself
  if (r.reference.state === 'KNOWN' && (!isFiniteNum(r.reference.price) || r.reference.price <= 0 || r.reference.barOpenSec !== r.anchorTsMs / 1000 - 60 || !isTs(r.reference.knownAtTs) || r.reference.knownAtTs < r.anchorTsMs)) return 'outcome row: a KNOWN reference must name the bar closing at the anchor and its own knowledge floor';
  if (r.reference.state === 'NOT_YET_KNOWN' && (!isTs(r.reference.knownAtTs) || r.reference.knownAtTs < r.anchorTsMs)) return 'outcome row: a masked reference still carries its knowledge floor';
  if (r.reference.state === 'OUTCOME_UNAVAILABLE' && r.reference.knownAtTs !== null) return 'outcome row: an unavailable reference carries no knowledge floor';
  if (!isPlainObject(r.horizons)) return 'outcome row: horizons malformed';
  const keys = Object.keys(r.horizons); if (keys.length !== LABEL_HORIZONS_MIN.length) return 'outcome row: horizon set is not the recipe set';
  for (const h of LABEL_HORIZONS_MIN) {
    const x = r.horizons[`${h}m`]; if (!isPlainObject(x)) return `outcome row: horizon ${h}m missing`;
    const hk = exactKeys(x, OUTCOME_HORIZON_KEYS); if (hk) return `outcome row: horizon ${h}m ${hk}`;
    if (!LABEL_STATES.includes(x.state) || !LABEL_REASONS.includes(x.reason) || x.horizonEndTs !== r.anchorTsMs + h * 60_000) return `outcome row: horizon ${h}m state / clock malformed`;
    // the knowledge floor can never precede the horizon it describes, and an unavailable horizon has no floor at all
    if (x.state === 'OUTCOME_UNAVAILABLE') { if (x.outcomeKnownAtTs !== null) return `outcome row: horizon ${h}m is unavailable yet carries a knowledge floor`; }
    else if (!isTs(x.outcomeKnownAtTs) || x.outcomeKnownAtTs < x.horizonEndTs) return `outcome row: horizon ${h}m knowledge floor precedes the horizon end`;
    // AND its own reference's floor: an excursion measured against a reference price Cobra could not read until the
    // archive existed is not learnable before that archive, whatever the horizon's own end says
    else if (isTs(r.reference.knownAtTs) && x.outcomeKnownAtTs < r.reference.knownAtTs) return `outcome row: horizon ${h}m knowledge floor precedes its own reference floor`;
    if (x.state === 'KNOWN') {
      if (!isFiniteNum(x.mfePct) || !isFiniteNum(x.maePct) || x.mfePct < 0 || x.maePct > 0) return `outcome row: horizon ${h}m KNOWN values malformed`;
      if (r.reference.state !== 'KNOWN') return `outcome row: horizon ${h}m is KNOWN while its reference price is not`; // an excursion cannot be known before its own reference
    } else if (x.mfePct !== null || x.maePct !== null || x.logReturnPct !== null) return `outcome row: horizon ${h}m exposes values in state ${x.state}`;
    const logH = LOG_RETURN_HORIZONS_MIN.includes(h);
    if (logH ? x.logReturnUnit !== 'LOG_RETURN_PERCENT' : (x.logReturnUnit !== null || x.logReturnPct !== null)) return `outcome row: horizon ${h}m log-return labelling malformed`;
    if (x.state === 'KNOWN' && logH && !isFiniteNum(x.logReturnPct)) return `outcome row: horizon ${h}m log return missing`;
  }
  return null;
}
