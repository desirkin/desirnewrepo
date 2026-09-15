// Pure, offline law for the first-week retrospective move study. It selects
// cases after a local market day has ended, but preserves strict decision-time
// prefixes for later simulations. It has no runtime, provider, order, Judge,
// promotion, or persistence authority.
import {
  AUTHORITY, PURPOSE, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
  recipeSealError, stableStringify,
} from './shadow-contracts.js';
import {
  acceptedCatalogSnapshotError, marketIdentityDigest,
} from './shadow-catalog-snapshot.js';

export const DAILY_MOVE_STUDY_VERSION = 'daily-move-study-1';
export const DAILY_MOVE_MANIFEST_VERSION = 'daily-move-study-manifest-1';
export const DAILY_MOVE_MANIFEST_VERSION_V2 = 'daily-move-study-manifest-2';
// L-1 (David's daily-study selection widening): v3 is v2 + one additive rule,
// topMoversPerDay, pinned to 30. It widens the selected population to the union
// of the >8% threshold cohort and the 30 largest |close/open-1| markets, deduped
// (see TOP_MOVER_CASE below). The threshold law itself is unchanged (rise/fall
// stay strict >8%); no upstream DATA-1/catalog change.
export const DAILY_MOVE_MANIFEST_VERSION_V3 = 'daily-move-study-manifest-3';
export const DEFAULT_TOP_MOVERS_PER_DAY = 30;
export const DEFAULT_STUDY_TIME_ZONE = 'America/New_York';
export const SUPPORT_FAMILIES = Object.freeze([
  'PRICE', 'CANDLES', 'BASE_VOLUME', 'QUOTE_VOLUME', 'TRADES', 'TRADE_FLOW', 'SPREAD', 'DEPTH', 'CATALYST',
]);
export const SUPPORT_STATES = Object.freeze(['COMPLETE', 'PARTIAL', 'GAP', 'MISSING', 'UNSUPPORTED', 'INVALID', 'DEFERRED']);
export const DISPOSITIONS = Object.freeze([
  'SURGE_CASE', 'AMBIGUOUS_INTRABAR', 'FAILED_BREAKOUT_CONTROL', 'FALLING_CONTROL', 'FLAT_CONTROL',
  // TOP_MOVER_CASE (L-1, v3 only): a top-30 mover by |close/open-1| that did NOT
  // cross the intraday threshold and is not already a threshold cohort row — the
  // additive half of the widened selection. It is never emitted for v1/v2.
  'TOP_MOVER_CASE',
  'OTHER_OBSERVED', 'MISSING_DATA', 'INVALID_DATA',
]);

const DAY = 24 * 60 * 60_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = Object.freeze([
  'manifestVersion', 'manifestId', 'manifestDigest', 'analysisBasis', 'createdTs', 'timeZone', 'localDay',
  'dayStartTs', 'dayEndTs', 'catalogSnapshot', 'catalogProvenance', 'recipeSeals', 'rules', 'authority', 'purpose',
]);
const CATALOG_PROVENANCE_KEYS = Object.freeze(['state', 'provenanceVerified', 'durableFullDayEpochUnionVerified', 'warning']);
const CATALOG_PROVENANCE_V2_KEYS = Object.freeze([
  'provenanceVersion', 'state', 'provenanceVerified', 'durableFullDayEpochUnionVerified',
  'sourceDatasetVersion', 'sourceDatasetId', 'sourceDatasetDigest', 'sourceArchiveVersion',
  'catalogEpochDigest', 'catalogUnionContentDigest', 'durability', 'republishSafe', 'warning',
]);
const RULE_KEYS = Object.freeze([
  'riseThresholdPct', 'comparison', 'failedRiseFloorPct', 'failedRetracePct', 'fallingThresholdPct',
  'flatRangePct', 'preWindowMs', 'decisionGridMs', 'controlsPerClass', 'episodeUnit',
  'sameCandleExtrema', 'maxObservationsPerMarket', 'maxDecisionFramesPerMarket',
]);
// v3 carries exactly one more rule than v1/v2: topMoversPerDay. v1/v2 rules must
// NOT carry it (exactKeys rejects the extra key), which keeps their digests and
// behavior byte-identical.
const RULE_KEYS_V3 = Object.freeze([...RULE_KEYS, 'topMoversPerDay']);
const ruleKeysFor = (version) => (version === DAILY_MOVE_MANIFEST_VERSION_V3 ? RULE_KEYS_V3 : RULE_KEYS);
const MARKET_DAY_KEYS = Object.freeze(['marketIdentityDigest', 'priceEvents', 'candles', 'support']);
const PRICE_KEYS = Object.freeze(['observationId', 'kind', 'price', 'sourceEventTs', 'receivedTs', 'knownAtTs', 'sourceDigest']);
const CANDLE_KEYS = Object.freeze([
  'observationId', 'periodStartTs', 'periodEndTs', 'open', 'high', 'low', 'close',
  'volumeBase', 'volumeQuote', 'closed', 'receivedTs', 'knownAtTs', 'sourceDigest',
]);
const SUPPORT_KEYS = Object.freeze(['state', 'observedCount', 'coverageStartTs', 'coverageEndTs', 'gapCount', 'sourceDigests', 'reason']);
const PRICE_KINDS = Object.freeze(['TRADE', 'TICKER_UPDATE']);

const DEFAULT_RULES = Object.freeze({
  riseThresholdPct: 8,
  comparison: 'STRICT_GREATER_THAN',
  failedRiseFloorPct: 4,
  failedRetracePct: 4,
  fallingThresholdPct: 8,
  flatRangePct: 2,
  preWindowMs: 60 * 60_000,
  decisionGridMs: 60_000,
  controlsPerClass: 1,
  episodeUnit: 'ONE_VENUE_MARKET_LOCAL_DAY',
  sameCandleExtrema: 'AMBIGUOUS_NEVER_QUALIFYING_BY_THEMSELVES',
  maxObservationsPerMarket: 100_000,
  maxDecisionFramesPerMarket: 1_500,
});

const clone = (value) => JSON.parse(stableStringify(value));
const pct = (later, earlier) => ((later / earlier) - 1) * 100;
const declinePct = (earlier, later) => (1 - later / earlier) * 100;
const strictlyExceedsRise = (later, earlier, thresholdPct) => {
  const lhs = later * 100; const rhs = earlier * (100 + thresholdPct);
  return lhs - rhs > Number.EPSILON * Math.max(Math.abs(lhs), Math.abs(rhs), 1) * 32;
};
const strictlyExceedsDecline = (earlier, later, thresholdPct) => {
  const lhs = (earlier - later) * 100; const rhs = earlier * thresholdPct;
  return lhs - rhs > Number.EPSILON * Math.max(Math.abs(lhs), Math.abs(rhs), 1) * 32;
};
const localDayAt = (ts, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

function timeBoundaryError({ timeZone, localDay, dayStartTs, dayEndTs }) {
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 80) return 'timeZone malformed';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDay)) || !isTs(dayStartTs) || !isTs(dayEndTs) || dayEndTs <= dayStartTs) return 'numeric day boundary malformed';
  if (dayEndTs - dayStartTs < 23 * 60 * 60_000 || dayEndTs - dayStartTs > 25 * 60 * 60_000) return 'local day must be a real 23-25 hour civil day';
  try {
    if (localDayAt(dayStartTs, timeZone) !== localDay || localDayAt(dayEndTs - 1, timeZone) !== localDay
      || localDayAt(dayStartTs - 1, timeZone) === localDay || localDayAt(dayEndTs, timeZone) === localDay) return 'numeric boundaries do not enclose exactly the declared local day/timezone';
  } catch { return 'timeZone unsupported'; }
  return null;
}

const manifestDigestOf = (m) => canonicalDigest({
  manifestVersion: m.manifestVersion, analysisBasis: m.analysisBasis, createdTs: m.createdTs,
  timeZone: m.timeZone, localDay: m.localDay, dayStartTs: m.dayStartTs, dayEndTs: m.dayEndTs,
  catalogSnapshot: m.catalogSnapshot, catalogProvenance: m.catalogProvenance, recipeSeals: m.recipeSeals, rules: m.rules,
  authority: m.authority, purpose: m.purpose,
});

export function dailyMoveStudyManifestError(manifest) {
  const keys = exactKeys(manifest, MANIFEST_KEYS); if (keys) return `manifest: ${keys}`;
  if (![DAILY_MOVE_MANIFEST_VERSION, DAILY_MOVE_MANIFEST_VERSION_V2, DAILY_MOVE_MANIFEST_VERSION_V3].includes(manifest.manifestVersion)
      || manifest.analysisBasis !== 'RETROSPECTIVE_COHORT_STUDY') return 'manifest: version/basis malformed';
  if (!isTs(manifest.createdTs) || manifest.createdTs < manifest.dayEndTs) return 'manifest: retrospective declaration must be at/after the completed day';
  const terr = timeBoundaryError(manifest); if (terr) return `manifest: ${terr}`;
  const cerr = acceptedCatalogSnapshotError(manifest.catalogSnapshot); if (cerr) return `manifest: catalog ${cerr}`;
  if (manifest.catalogSnapshot.knownAtTs > manifest.createdTs || manifest.catalogSnapshot.knownAtTs >= manifest.dayEndTs || manifest.catalogSnapshot.observedTs >= manifest.dayEndTs
      || manifest.dayStartTs - manifest.catalogSnapshot.observedTs > manifest.catalogSnapshot.maxAgeMs) return 'manifest: catalog snapshot cannot identify the population monitored during this day';
  if (manifest.manifestVersion === DAILY_MOVE_MANIFEST_VERSION) {
    const pk = exactKeys(manifest.catalogProvenance, CATALOG_PROVENANCE_KEYS); if (pk) return `manifest: catalog provenance ${pk}`;
    if (manifest.catalogProvenance.state !== 'SEALED_SNAPSHOT_ONLY_UNVERIFIED_FULL_DAY_UNION'
        || manifest.catalogProvenance.provenanceVerified !== false || manifest.catalogProvenance.durableFullDayEpochUnionVerified !== false
        || typeof manifest.catalogProvenance.warning !== 'string') return 'manifest: this version must disclose unverified catalog epoch provenance';
  } else {
    const pk = exactKeys(manifest.catalogProvenance, CATALOG_PROVENANCE_V2_KEYS); if (pk) return `manifest: catalog provenance ${pk}`;
    const p = manifest.catalogProvenance;
    if (p.provenanceVersion !== 'daily-broad-archive-provenance-1'
        || p.state !== 'VERIFIED_LOCAL_V2_ARCHIVE_FULL_DAY' || p.provenanceVerified !== true
        || p.durableFullDayEpochUnionVerified !== true
        || p.sourceDatasetVersion !== 'broad-day-dataset-v1'
        || !SHA256_RE.test(String(p.sourceDatasetDigest)) || p.sourceDatasetId !== `bdd-${p.sourceDatasetDigest}`
        || p.sourceArchiveVersion !== 'broad-day-archive-local-v2'
        || !SHA256_RE.test(String(p.catalogEpochDigest))
        || p.catalogUnionContentDigest !== manifest.catalogSnapshot.contentDigest
        || p.durability !== 'LOCAL_FILESYSTEM_ONLY' || p.republishSafe !== false
        || typeof p.warning !== 'string' || p.warning.length < 1 || p.warning.length > 400) return 'manifest: v2 local archive provenance malformed or unbound';
  }
  if (!Array.isArray(manifest.recipeSeals) || manifest.recipeSeals.length > 64 || manifest.recipeSeals.some((s) => recipeSealError(s))) return 'manifest: recipe seals malformed or exceed 64';
  const recipeDigests = manifest.recipeSeals.map((s) => s.recipeDigest);
  if (new Set(recipeDigests).size !== recipeDigests.length || recipeDigests.join('\n') !== [...recipeDigests].sort().join('\n')) return 'manifest: recipe seals duplicated or not canonical-sorted';
  if (new Set(manifest.recipeSeals.map((s) => s.recipe.recipeVersion)).size !== manifest.recipeSeals.length) return 'manifest: one recipeVersion cannot name multiple study seals';
  const rk = exactKeys(manifest.rules, ruleKeysFor(manifest.manifestVersion)); if (rk) return `manifest: rules ${rk}`;
  const r = manifest.rules;
  if (![r.riseThresholdPct, r.failedRiseFloorPct, r.failedRetracePct, r.fallingThresholdPct, r.flatRangePct].every((n) => isFiniteNum(n) && n > 0)
      || r.riseThresholdPct !== 8 || r.comparison !== 'STRICT_GREATER_THAN' || r.failedRiseFloorPct >= r.riseThresholdPct
      || !Number.isSafeInteger(r.preWindowMs) || r.preWindowMs < 60_000
      || !Number.isSafeInteger(r.decisionGridMs) || r.decisionGridMs < 60_000
      || !Number.isSafeInteger(r.controlsPerClass) || r.controlsPerClass < 1 || r.controlsPerClass > 10
      || r.episodeUnit !== DEFAULT_RULES.episodeUnit || r.sameCandleExtrema !== DEFAULT_RULES.sameCandleExtrema
      || !Number.isSafeInteger(r.maxObservationsPerMarket) || r.maxObservationsPerMarket < 1
      || !Number.isSafeInteger(r.maxDecisionFramesPerMarket) || r.maxDecisionFramesPerMarket < 1) return 'manifest: rules violate the bounded >8% study law';
  // v3 pins topMoversPerDay to exactly 30, the same way every version pins the
  // rise threshold to 8 — a config that names any other value is refused.
  if (manifest.manifestVersion === DAILY_MOVE_MANIFEST_VERSION_V3
      && (!Number.isSafeInteger(r.topMoversPerDay) || r.topMoversPerDay !== DEFAULT_TOP_MOVERS_PER_DAY)) return 'manifest: v3 pins topMoversPerDay to 30';
  if (manifest.authority !== AUTHORITY || manifest.purpose !== PURPOSE) return 'manifest: authority must remain NONE / RESEARCH_ONLY';
  if (!SHA256_RE.test(String(manifest.manifestDigest)) || manifest.manifestDigest !== manifestDigestOf(manifest)
      || manifest.manifestId !== `dmstudy-${manifest.manifestDigest.slice(0, 24)}`) return 'manifest: content identity forged';
  return null;
}

export function sealDailyMoveStudyManifest({
  createdTs, timeZone = DEFAULT_STUDY_TIME_ZONE, localDay, dayStartTs, dayEndTs,
  acceptedCatalogSnapshot, recipeSeals = [], rules = {},
}) {
  if (!Array.isArray(recipeSeals) || recipeSeals.length > 64) throw new Error('daily move study: manifest recipe seals malformed or exceed 64');
  const manifest = {
    manifestVersion: DAILY_MOVE_MANIFEST_VERSION, manifestId: '', manifestDigest: '',
    analysisBasis: 'RETROSPECTIVE_COHORT_STUDY', createdTs, timeZone, localDay, dayStartTs, dayEndTs,
    catalogSnapshot: clone(acceptedCatalogSnapshot),
    catalogProvenance: {
      state: 'SEALED_SNAPSHOT_ONLY_UNVERIFIED_FULL_DAY_UNION',
      provenanceVerified: false,
      durableFullDayEpochUnionVerified: false,
      warning: 'A content-valid snapshot does not prove the union of every catalog epoch monitored throughout this civil day; operational full-day claims require durable epoch controls.',
    },
    recipeSeals: recipeSeals.map(clone).sort((a, b) => a.recipeDigest.localeCompare(b.recipeDigest)),
    rules: { ...DEFAULT_RULES, ...rules }, authority: AUTHORITY, purpose: PURPOSE,
  };
  manifest.manifestDigest = manifestDigestOf(manifest);
  manifest.manifestId = `dmstudy-${manifest.manifestDigest.slice(0, 24)}`;
  const err = dailyMoveStudyManifestError(manifest); if (err) throw new Error(`daily move study: ${err}`);
  return deepFreeze(manifest);
}

export function sealDailyMoveStudyManifestV2({
  createdTs, timeZone = DEFAULT_STUDY_TIME_ZONE, localDay, dayStartTs, dayEndTs,
  acceptedCatalogSnapshot, catalogProvenance, recipeSeals = [], rules = {},
}) {
  if (!Array.isArray(recipeSeals) || recipeSeals.length > 64) throw new Error('daily move study: manifest recipe seals malformed or exceed 64');
  const manifest = {
    manifestVersion: DAILY_MOVE_MANIFEST_VERSION_V2, manifestId: '', manifestDigest: '',
    analysisBasis: 'RETROSPECTIVE_COHORT_STUDY', createdTs, timeZone, localDay, dayStartTs, dayEndTs,
    catalogSnapshot: clone(acceptedCatalogSnapshot), catalogProvenance: clone(catalogProvenance),
    recipeSeals: recipeSeals.map(clone).sort((a, b) => a.recipeDigest.localeCompare(b.recipeDigest)),
    rules: { ...DEFAULT_RULES, ...rules }, authority: AUTHORITY, purpose: PURPOSE,
  };
  manifest.manifestDigest = manifestDigestOf(manifest);
  manifest.manifestId = `dmstudy-${manifest.manifestDigest.slice(0, 24)}`;
  const err = dailyMoveStudyManifestError(manifest); if (err) throw new Error(`daily move study: ${err}`);
  return deepFreeze(manifest);
}

// v3: the v2 verified-local-archive manifest plus the additive topMoversPerDay
// rule (pinned to 30). Everything else — the >8% threshold law, the catalog
// provenance shape, the digest identity — is exactly v2.
export function sealDailyMoveStudyManifestV3({
  createdTs, timeZone = DEFAULT_STUDY_TIME_ZONE, localDay, dayStartTs, dayEndTs,
  acceptedCatalogSnapshot, catalogProvenance, recipeSeals = [], rules = {},
}) {
  if (!Array.isArray(recipeSeals) || recipeSeals.length > 64) throw new Error('daily move study: manifest recipe seals malformed or exceed 64');
  const manifest = {
    manifestVersion: DAILY_MOVE_MANIFEST_VERSION_V3, manifestId: '', manifestDigest: '',
    analysisBasis: 'RETROSPECTIVE_COHORT_STUDY', createdTs, timeZone, localDay, dayStartTs, dayEndTs,
    catalogSnapshot: clone(acceptedCatalogSnapshot), catalogProvenance: clone(catalogProvenance),
    recipeSeals: recipeSeals.map(clone).sort((a, b) => a.recipeDigest.localeCompare(b.recipeDigest)),
    rules: { ...DEFAULT_RULES, topMoversPerDay: DEFAULT_TOP_MOVERS_PER_DAY, ...rules }, authority: AUTHORITY, purpose: PURPOSE,
  };
  manifest.manifestDigest = manifestDigestOf(manifest);
  manifest.manifestId = `dmstudy-${manifest.manifestDigest.slice(0, 24)}`;
  const err = dailyMoveStudyManifestError(manifest); if (err) throw new Error(`daily move study: ${err}`);
  return deepFreeze(manifest);
}

function supportError(support, manifest) {
  if (!isPlainObject(support) || exactKeys(support, SUPPORT_FAMILIES)) return 'support families incomplete';
  for (const family of SUPPORT_FAMILIES) {
    const row = support[family]; const keys = exactKeys(row, SUPPORT_KEYS); if (keys) return `${family} support ${keys}`;
    if (!SUPPORT_STATES.includes(row.state) || !Number.isSafeInteger(row.observedCount) || row.observedCount < 0
      || !Number.isSafeInteger(row.gapCount) || row.gapCount < 0 || !Array.isArray(row.sourceDigests)
      || row.sourceDigests.some((d) => !SHA256_RE.test(String(d))) || new Set(row.sourceDigests).size !== row.sourceDigests.length
      || !(row.reason === null || (typeof row.reason === 'string' && row.reason.length > 0 && row.reason.length <= 240))) return `${family} support malformed`;
    if (row.state === 'COMPLETE') {
      if (row.gapCount !== 0 || !isTs(row.coverageStartTs) || !isTs(row.coverageEndTs)
        || row.coverageStartTs > manifest.dayStartTs || row.coverageEndTs < manifest.dayEndTs || row.sourceDigests.length < 1 || row.reason !== null) return `${family} COMPLETE support does not prove the full day`;
    } else if (row.state === 'PARTIAL' || row.state === 'GAP') {
      if ((row.state === 'PARTIAL' && row.observedCount < 1) || !isTs(row.coverageStartTs) || !isTs(row.coverageEndTs) || row.coverageEndTs < row.coverageStartTs
        || row.sourceDigests.length < 1 || (row.state === 'GAP' && row.gapCount < 1)) return `${family} partial/gap support malformed`;
    } else if (row.observedCount !== 0 || row.coverageStartTs !== null || row.coverageEndTs !== null || row.sourceDigests.length !== 0 || row.reason === null) return `${family} absent support must remain explicit and empty`;
  }
  return null;
}

function validateMarketDay(day, manifest, expectedDigest) {
  const keys = exactKeys(day, MARKET_DAY_KEYS); if (keys) return `market day ${keys}`;
  if (day.marketIdentityDigest !== expectedDigest) return 'market identity digest mismatch';
  if (!Array.isArray(day.priceEvents) || !Array.isArray(day.candles)
    || day.priceEvents.length + day.candles.length > manifest.rules.maxObservationsPerMarket) return 'market observation inventory malformed or over cap';
  const ids = new Set();
  for (const event of day.priceEvents) {
    const ek = exactKeys(event, PRICE_KEYS); if (ek) return `price event ${ek}`;
    if (typeof event.observationId !== 'string' || !event.observationId.length || ids.has(event.observationId)
      || !PRICE_KINDS.includes(event.kind) || !isFiniteNum(event.price) || event.price <= 0
      || !isTs(event.sourceEventTs) || event.sourceEventTs < manifest.dayStartTs || event.sourceEventTs >= manifest.dayEndTs
      || !isTs(event.receivedTs) || !isTs(event.knownAtTs) || event.receivedTs < event.sourceEventTs
      || event.knownAtTs < event.receivedTs || event.knownAtTs > manifest.createdTs || !SHA256_RE.test(String(event.sourceDigest))) return 'price event malformed, duplicated, outside day, or future-known';
    ids.add(event.observationId);
  }
  for (const candle of day.candles) {
    const ck = exactKeys(candle, CANDLE_KEYS); if (ck) return `candle ${ck}`;
    if (typeof candle.observationId !== 'string' || !candle.observationId.length || ids.has(candle.observationId)
      || !isTs(candle.periodStartTs) || !isTs(candle.periodEndTs) || candle.periodStartTs < manifest.dayStartTs || candle.periodEndTs > manifest.dayEndTs
      || candle.periodEndTs <= candle.periodStartTs || candle.closed !== true
      || !isTs(candle.receivedTs) || !isTs(candle.knownAtTs) || candle.receivedTs < candle.periodEndTs
      || candle.knownAtTs < candle.receivedTs || candle.knownAtTs > manifest.createdTs || !SHA256_RE.test(String(candle.sourceDigest))) return 'candle malformed, duplicated, outside day, unclosed, or future-known';
    for (const field of ['open', 'high', 'low', 'close']) if (!isFiniteNum(candle[field]) || candle[field] <= 0) return `candle ${field} malformed`;
    if (candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.high < candle.low) return 'candle OHLC envelope malformed';
    for (const field of ['volumeBase', 'volumeQuote']) if (!(candle[field] === null || (isFiniteNum(candle[field]) && candle[field] >= 0))) return `candle ${field} malformed`;
    ids.add(candle.observationId);
  }
  const serr = supportError(day.support, manifest); if (serr) return serr;
  const observed = {
    PRICE: day.priceEvents.length,
    CANDLES: day.candles.length,
    BASE_VOLUME: day.candles.filter((c) => c.volumeBase !== null).length,
    QUOTE_VOLUME: day.candles.filter((c) => c.volumeQuote !== null).length,
  };
  for (const [family, count] of Object.entries(observed)) if (day.support[family].observedCount !== count) return `${family} support count differs from validated observations`;
  return null;
}

const absentSupport = (reason = 'NO_ACCEPTED_MARKET_DAY_SOURCE') => Object.fromEntries(SUPPORT_FAMILIES.map((family) => [family, {
  state: 'MISSING', observedCount: 0, coverageStartTs: null, coverageEndTs: null,
  gapCount: 0, sourceDigests: [], reason,
}]));

function priceCandidates(day) {
  const lows = []; const highs = [];
  for (const e of day.priceEvents) {
    const point = { price: e.price, earliestTs: e.sourceEventTs, latestTs: e.sourceEventTs, ref: e.observationId, evidence: e.kind };
    lows.push(point); highs.push(point);
  }
  for (const c of day.candles) {
    // A bar extreme may have happened anywhere in [start,end). Encoding
    // latest=end-1 makes extrema from adjacent bars orderable, but never lets
    // one bar's own low/high establish their order.
    lows.push({ price: c.low, earliestTs: c.periodStartTs, latestTs: c.periodEndTs - 1, ref: c.observationId, evidence: 'OHLC_LOW_INTERVAL' });
    highs.push({ price: c.high, earliestTs: c.periodStartTs, latestTs: c.periodEndTs - 1, ref: c.observationId, evidence: 'OHLC_HIGH_INTERVAL' });
  }
  return { lows, highs };
}

function bestOrderedMove(earlier, later, direction = 'UP') {
  const a = [...earlier].sort((x, y) => x.latestTs - y.latestTs || x.price - y.price || x.ref.localeCompare(y.ref));
  const b = [...later].sort((x, y) => x.earliestTs - y.earliestTs || x.ref.localeCompare(y.ref));
  let cursor = 0; let extreme = null; let best = null;
  for (const end of b) {
    while (cursor < a.length && a[cursor].latestTs < end.earliestTs) {
      const candidate = a[cursor];
      if (extreme === null || (direction === 'UP' ? candidate.price < extreme.price : candidate.price > extreme.price)) extreme = candidate;
      cursor += 1;
    }
    if (!extreme) continue;
    const movePct = direction === 'UP' ? pct(end.price, extreme.price) : declinePct(extreme.price, end.price);
    if (movePct > (best?.movePct ?? -Infinity)) best = { earlier: extreme, later: end, movePct };
  }
  return best;
}

function firstStrictRise(earlier, later, thresholdPct) {
  const a = [...earlier].sort((x, y) => x.latestTs - y.latestTs || x.price - y.price || x.ref.localeCompare(y.ref));
  const b = [...later].sort((x, y) => x.earliestTs - y.earliestTs || x.ref.localeCompare(y.ref));
  let cursor = 0; let minimum = null;
  for (const end of b) {
    while (cursor < a.length && a[cursor].latestTs < end.earliestTs) {
      if (minimum === null || a[cursor].price < minimum.price) minimum = a[cursor];
      cursor += 1;
    }
    if (minimum && strictlyExceedsRise(end.price, minimum.price, thresholdPct)) return { earlier: minimum, later: end, movePct: pct(end.price, minimum.price) };
  }
  return null;
}

function declineAfter(point, lows) {
  let laterLow = null;
  for (const low of lows) if (point.latestTs < low.earliestTs && (laterLow === null || low.price < laterLow.price)) laterLow = low;
  return laterLow ? { earlier: point, later: laterLow, movePct: declinePct(point.price, laterLow.price) } : null;
}

function phaseSummary(day, startTs, endTs) {
  const events = day.priceEvents.filter((e) => e.sourceEventTs >= startTs && e.sourceEventTs < endTs);
  const candles = day.candles.filter((c) => c.periodStartTs >= startTs && c.periodEndTs <= endTs);
  const prices = [...events.map((e) => e.price), ...candles.flatMap((c) => [c.open, c.high, c.low, c.close])];
  const sumIfComplete = (field) => candles.length > 0 && candles.every((c) => c[field] !== null)
    ? candles.reduce((n, c) => n + c[field], 0) : null;
  let priceMin = null; let priceMax = null;
  for (const price of prices) { priceMin = priceMin === null ? price : Math.min(priceMin, price); priceMax = priceMax === null ? price : Math.max(priceMax, price); }
  return {
    startTs, endTs,
    observationRefs: [...events.map((e) => e.observationId), ...candles.map((c) => c.observationId)].sort(),
    priceMin, priceMax,
    volumeBase: sumIfComplete('volumeBase'), volumeQuote: sumIfComplete('volumeQuote'),
    missingVolumeBaseBars: candles.filter((c) => c.volumeBase === null).length,
    missingVolumeQuoteBars: candles.filter((c) => c.volumeQuote === null).length,
  };
}

function classifyMarketDay(day, manifest) {
  const candidates = priceCandidates(day);
  let observedMin = null; let observedMax = null;
  for (const item of [...candidates.lows, ...candidates.highs]) { observedMin = observedMin === null ? item.price : Math.min(observedMin, item.price); observedMax = observedMax === null ? item.price : Math.max(observedMax, item.price); }
  const globalObservedRangePct = observedMin === null ? null : pct(observedMax, observedMin);
  const bestRise = bestOrderedMove(candidates.lows, candidates.highs, 'UP');
  const bestDecline = bestOrderedMove(candidates.highs, candidates.lows, 'DOWN');
  const firstBreach = firstStrictRise(candidates.lows, candidates.highs, manifest.rules.riseThresholdPct);
  const ambiguousBars = day.candles.filter((c) => strictlyExceedsRise(c.high, c.low, manifest.rules.riseThresholdPct)).map((c) => c.observationId);
  let disposition = 'OTHER_OBSERVED';
  if (firstBreach) disposition = 'SURGE_CASE';
  else if (ambiguousBars.length > 0) disposition = 'AMBIGUOUS_INTRABAR';
  else if (bestRise && bestRise.movePct >= manifest.rules.failedRiseFloorPct
      && !strictlyExceedsRise(bestRise.later.price, bestRise.earlier.price, manifest.rules.riseThresholdPct)
      && (declineAfter(bestRise.later, candidates.lows)?.movePct ?? 0) >= manifest.rules.failedRetracePct) disposition = 'FAILED_BREAKOUT_CONTROL';
  else if (bestDecline && strictlyExceedsDecline(bestDecline.earlier.price, bestDecline.later.price, manifest.rules.fallingThresholdPct)) disposition = 'FALLING_CONTROL';
  else if (day.priceEvents.length === 0 && day.candles.length === 0) disposition = 'MISSING_DATA';
  else if ((day.support.PRICE.state === 'COMPLETE' || day.support.CANDLES.state === 'COMPLETE')
      && globalObservedRangePct !== null && globalObservedRangePct <= manifest.rules.flatRangePct) disposition = 'FLAT_CONTROL';

  const anchor = firstBreach?.later.earliestTs ?? null;
  const troughTs = firstBreach?.earlier.earliestTs ?? null;
  const breachEvidenceEndTs = firstBreach ? Math.min(manifest.dayEndTs, firstBreach.later.latestTs + 1) : null;
  const phaseBoundaries = firstBreach ? {
    pre: [manifest.dayStartTs, troughTs],
    acceleration: [troughTs, breachEvidenceEndTs],
    peakAndReversal: [breachEvidenceEndTs, manifest.dayEndTs],
  } : { observedDay: [manifest.dayStartTs, manifest.dayEndTs] };
  const phases = Object.fromEntries(Object.entries(phaseBoundaries).map(([name, [start, end]]) => [name, phaseSummary(day, start, end)]));
  return {
    disposition, firstBreach, bestOrderedRise: bestRise, bestOrderedDecline: bestDecline, globalObservedRangePct,
    ambiguousIntrabarRefs: ambiguousBars, anchorTs: anchor,
    chronology: {
      phases, chronologyDigest: canonicalDigest({ priceEvents: day.priceEvents, candles: day.candles, support: day.support }),
      sourceDigests: [...new Set(SUPPORT_FAMILIES.flatMap((family) => day.support[family].sourceDigests))].sort(),
      rawSourceRetentionRequired: true,
      peakIsDescriptiveNotExit: true,
    },
  };
}

function frameEvidence(marketDay) {
  const entries = [];
  for (const e of marketDay.priceEvents) entries.push({
    availableTs: e.knownAtTs, kind: 'PRICE', observationId: e.observationId,
    digest: canonicalDigest({ observationId: e.observationId, kind: e.kind, price: e.price, sourceEventTs: e.sourceEventTs, receivedTs: e.receivedTs, knownAtTs: e.knownAtTs, sourceDigest: e.sourceDigest }),
  });
  for (const c of marketDay.candles) entries.push({
    availableTs: c.knownAtTs, kind: 'CANDLE', observationId: c.observationId,
    digest: canonicalDigest({ observationId: c.observationId, periodStartTs: c.periodStartTs, periodEndTs: c.periodEndTs, open: c.open, high: c.high, low: c.low, close: c.close, volumeBase: c.volumeBase, volumeQuote: c.volumeQuote, receivedTs: c.receivedTs, knownAtTs: c.knownAtTs, sourceDigest: c.sourceDigest }),
  });
  entries.sort((a, b) => a.availableTs - b.availableTs || a.kind.localeCompare(b.kind) || a.observationId.localeCompare(b.observationId));
  return entries;
}

function frameRecord(decisionTs, state) {
  return deepFreeze({
    decisionTs,
    prefixDigest: canonicalDigest({ chainVersion: 'daily-study-prefix-chain-1', chainDigest: state.chainDigest, observedPriceEvents: state.prices, observedClosedCandles: state.candles }),
    observedPriceEvents: state.prices, observedClosedCandles: state.candles,
    knownAtCeilingTs: state.knownAtCeilingTs,
    analysisBasis: 'RETROSPECTIVE_REPLAY_FRAME_SELECTED_FROM_A_FULL_DAY_COHORT',
    retrospectiveLabelsIncluded: false, promotionEligible: false,
  });
}

function decisionFrame(manifest, marketDay, decisionTs) {
  if (!isTs(decisionTs) || decisionTs < manifest.dayStartTs || decisionTs >= manifest.dayEndTs) throw new Error('daily move study frame: decision clock outside declared day');
  const state = { chainDigest: 'GENESIS', prices: 0, candles: 0, knownAtCeilingTs: 0 };
  for (const entry of frameEvidence(marketDay)) {
    if (entry.availableTs > decisionTs) break;
    state.chainDigest = canonicalDigest({ previous: state.chainDigest, evidenceDigest: entry.digest });
    if (entry.kind === 'PRICE') state.prices += 1; else state.candles += 1;
    state.knownAtCeilingTs = entry.availableTs;
  }
  return frameRecord(decisionTs, state);
}

export function buildDailyDecisionFrame({ manifest, marketDay, decisionTs }) {
  const merr = dailyMoveStudyManifestError(manifest); if (merr) throw new Error(`daily move study frame: ${merr}`);
  const market = manifest.catalogSnapshot.markets.find((m) => marketIdentityDigest(m) === marketDay?.marketIdentityDigest);
  if (!market) throw new Error('daily move study frame: market is outside the sealed catalog');
  const derr = validateMarketDay(marketDay, manifest, marketIdentityDigest(market));
  if (derr) throw new Error(`daily move study frame: invalid market day (${derr})`);
  return decisionFrame(manifest, marketDay, decisionTs);
}

// Exact existing control-matching prefix law, exported for the sharded
// retrospective aggregator. Callers must supply an already validated market
// day and manifest. The strict-before clocks intentionally remain unchanged.
export function dailyMoveControlPrefixFacts(day, manifest, anchorTs) {
  const from = anchorTs - manifest.rules.preWindowMs;
  const prices = day.priceEvents.filter((e) => e.sourceEventTs >= from && e.sourceEventTs < anchorTs && e.knownAtTs < anchorTs)
    .sort((a, b) => a.sourceEventTs - b.sourceEventTs || a.observationId.localeCompare(b.observationId)).map((e) => e.price);
  const candles = day.candles.filter((c) => c.periodEndTs >= from && c.periodEndTs < anchorTs && c.knownAtTs < anchorTs)
    .sort((a, b) => a.periodEndTs - b.periodEndTs);
  const series = prices.length >= 2 ? prices : candles.map((c) => c.close);
  if (series.length < 2) return null;
  const returns = series.slice(1).map((p, i) => Math.log(p / series[i]));
  const realizedVolPct = Math.sqrt(returns.reduce((n, x) => n + x * x, 0) / returns.length) * 100;
  const quoteVolume = candles.length > 0 && candles.every((c) => c.volumeQuote !== null) ? candles.reduce((n, c) => n + c.volumeQuote, 0) : null;
  // Full-day COMPLETE/GAP states are retrospective outcomes. Matching may use
  // only prefix content known by the anchor; detailed-family content is not
  // present in this pure planner, so it is not guessed from end-of-day status.
  const supportSignature = [
    `PRICE:${prices.length > 0}`, `CANDLES:${candles.length > 0}`,
    `BASE_VOLUME:${candles.some((c) => c.volumeBase !== null)}`,
    `QUOTE_VOLUME:${candles.some((c) => c.volumeQuote !== null)}`,
  ].join('|');
  return { realizedVolPct, logQuoteVolume: quoteVolume === null ? null : Math.log1p(quoteVolume), supportSignature, sampleCount: series.length };
}

export function dailyMoveControlMatchDistance(a, b) {
  if (!a || !b || a.supportSignature !== b.supportSignature || (a.logQuoteVolume === null) !== (b.logQuoteVolume === null)) return null;
  return Math.abs(a.realizedVolPct - b.realizedVolPct) + (a.logQuoteVolume === null ? 0 : Math.abs(a.logQuoteVolume - b.logQuoteVolume));
}

function materializeFrames(row, day, manifest, anchorTs) {
  const offset = Math.max(0, anchorTs - manifest.rules.preWindowMs - manifest.dayStartTs);
  const first = manifest.dayStartTs + Math.floor(offset / manifest.rules.decisionGridMs) * manifest.rules.decisionGridMs;
  const frames = []; const entries = frameEvidence(day);
  const state = { chainDigest: 'GENESIS', prices: 0, candles: 0, knownAtCeilingTs: 0 }; let cursor = 0;
  for (let ts = first; ts < manifest.dayEndTs && frames.length < manifest.rules.maxDecisionFramesPerMarket; ts += manifest.rules.decisionGridMs) {
    while (cursor < entries.length && entries[cursor].availableTs <= ts) {
      const entry = entries[cursor]; state.chainDigest = canonicalDigest({ previous: state.chainDigest, evidenceDigest: entry.digest });
      if (entry.kind === 'PRICE') state.prices += 1; else state.candles += 1;
      state.knownAtCeilingTs = entry.availableTs; cursor += 1;
    }
    frames.push(frameRecord(ts, state));
  }
  row.decisionFrames = frames;
  const requested = Math.ceil((manifest.dayEndTs - first) / manifest.rules.decisionGridMs);
  row.framePlan = { requested, materialized: frames.length, truncated: frames.length < requested, firstDecisionTs: frames[0]?.decisionTs ?? null, lastDecisionTs: frames.at(-1)?.decisionTs ?? null };
}

// The day's absolute move |close/open - 1| for the top-mover ranking (L-1, v3).
// Open = the open of the earliest closed candle; close = the close of the latest
// closed candle. With no candles it falls back to the first/last price event by
// source-event time. A market with fewer than the two anchors needed (or a
// non-positive open) is not rankable (null) — it can never become a top mover.
function dailyMoveMagnitude(day) {
  const candles = [...day.candles].sort((a, b) => a.periodStartTs - b.periodStartTs || a.observationId.localeCompare(b.observationId));
  let open = null; let close = null;
  if (candles.length > 0) { open = candles[0].open; close = candles.at(-1).close; }
  else {
    const events = [...day.priceEvents].sort((a, b) => a.sourceEventTs - b.sourceEventTs || a.observationId.localeCompare(b.observationId));
    if (events.length > 0) { open = events[0].price; close = events.at(-1).price; }
  }
  if (!isFiniteNum(open) || !isFiniteNum(close) || open <= 0) return null;
  return Math.abs(close / open - 1);
}

export function buildDailyMoveStudy({ manifest, acceptedCatalogSnapshot, marketDays }) {
  const merr = dailyMoveStudyManifestError(manifest); if (merr) throw new Error(`daily move study: ${merr}`);
  const cerr = acceptedCatalogSnapshotError(acceptedCatalogSnapshot); if (cerr) throw new Error(`daily move study: catalog ${cerr}`);
  if (acceptedCatalogSnapshot.contentDigest !== manifest.catalogSnapshot.contentDigest) throw new Error('daily move study: supplied catalog differs from sealed manifest denominator');
  if (!Array.isArray(marketDays)) throw new Error('daily move study: marketDays must be an array');

  const supplied = new Map(); const rejected = new Map();
  for (const day of marketDays) {
    const digest = day?.marketIdentityDigest;
    if (typeof digest !== 'string' || supplied.has(digest) || rejected.has(digest)) { if (typeof digest === 'string') rejected.set(digest, 'duplicate market-day input'); continue; }
    supplied.set(digest, day);
  }
  const acceptedDigests = new Set(manifest.catalogSnapshot.markets.map(marketIdentityDigest));
  const unacceptedInputCount = [...supplied.keys()].filter((d) => !acceptedDigests.has(d)).length;
  const rows = []; const dayByDigest = new Map();
  for (const market of manifest.catalogSnapshot.markets) {
    const digest = marketIdentityDigest(market);
    const provided = supplied.get(digest);
    const day = provided ?? { marketIdentityDigest: digest, priceEvents: [], candles: [], support: absentSupport() };
    const error = rejected.get(digest) ?? validateMarketDay(day, manifest, digest);
    dayByDigest.set(digest, day);
    // Invalid input remains one visible denominator row, but none of its
    // caller-supplied support claims are safe to display or credit.  In
    // particular, a plain object may still be structurally incomplete, and a
    // complete-looking support matrix cannot rehabilitate invalid/future
    // observations.
    let visibleSupport;
    if (error) visibleSupport = absentSupport('MARKET_DAY_INPUT_INVALID');
    else {
      try { visibleSupport = clone(day.support); }
      catch { visibleSupport = absentSupport('MARKET_DAY_SUPPORT_INVALID'); }
    }
    const base = {
      studyVersion: DAILY_MOVE_STUDY_VERSION,
      caseId: `dmcase-${canonicalDigest({ manifestId: manifest.manifestId, marketIdentityDigest: digest }).slice(0, 24)}`,
      episodeGroupId: `dmgroup-${canonicalDigest({ venue: market.venue, marketIdentityDigest: digest, dayStartTs: manifest.dayStartTs, dayEndTs: manifest.dayEndTs }).slice(0, 24)}`,
      manifestId: manifest.manifestId, marketIdentityDigest: digest, market,
      retrospectiveLabels: null,
      retrospectiveReplay: { analysisBasis: 'RETROSPECTIVE_FULL_DAY_COHORT_SELECTED', decisionFrames: [], framePlan: null, labelFieldsPresent: false, promotionEligible: false },
      support: visibleSupport, matches: [], authority: AUTHORITY, purpose: PURPOSE,
    };
    if (error) {
      base.retrospectiveLabels = { disposition: 'INVALID_DATA', reason: error, firstBreach: null, bestOrderedRise: null, bestOrderedDecline: null, ambiguousIntrabarRefs: [], chronology: null };
      rows.push(base); continue;
    }
    const classified = classifyMarketDay(day, manifest);
    base.retrospectiveLabels = classified;
    rows.push(base);
  }

  // L-1 top-mover overlay (v3 only): widen the population to the union of the
  // >8% threshold cohort and the 30 largest |close/open-1| markets, deduped. A
  // top-30 mover that already carries a threshold disposition keeps it (dedup);
  // one that was only OTHER_OBSERVED is re-labelled TOP_MOVER_CASE and gets its
  // own full-day decision frames (anchored at the day open) so it is a real
  // selected case, not a bare denominator row. v1/v2 never enter this branch, so
  // their behavior and digests are byte-identical.
  if (manifest.manifestVersion === DAILY_MOVE_MANIFEST_VERSION_V3) {
    const ranked = rows
      .filter((row) => row.retrospectiveLabels.disposition !== 'INVALID_DATA' && row.retrospectiveLabels.disposition !== 'MISSING_DATA')
      .map((row) => ({ row, magnitude: dailyMoveMagnitude(dayByDigest.get(row.marketIdentityDigest)) }))
      .filter((x) => x.magnitude !== null)
      .sort((a, b) => b.magnitude - a.magnitude || a.row.marketIdentityDigest.localeCompare(b.row.marketIdentityDigest));
    for (const { row } of ranked.slice(0, manifest.rules.topMoversPerDay)) {
      if (row.retrospectiveLabels.disposition !== 'OTHER_OBSERVED') continue; // dedup: already in the cohort
      row.retrospectiveLabels = { ...row.retrospectiveLabels, disposition: 'TOP_MOVER_CASE' };
      materializeFrames(row.retrospectiveReplay, dayByDigest.get(row.marketIdentityDigest), manifest, manifest.dayStartTs);
    }
  }

  // Match controls only after every market-day has one exclusive disposition.
  // The full-day outcome chooses the control POOL; the distance sees only facts
  // that were known by the surge's first-breach clock.
  const byDisposition = new Map(DISPOSITIONS.map((d) => [d, rows.filter((row) => row.retrospectiveLabels.disposition === d)]));
  const controlClasses = ['FAILED_BREAKOUT_CONTROL', 'FALLING_CONTROL', 'FLAT_CONTROL'];
  const used = new Set();
  for (const surge of byDisposition.get('SURGE_CASE')) {
    const anchorTs = surge.retrospectiveLabels.anchorTs;
    const surgeDay = dayByDigest.get(surge.marketIdentityDigest);
    const sf = dailyMoveControlPrefixFacts(surgeDay, manifest, anchorTs);
    for (const controlClass of controlClasses) {
      const ranked = [];
      for (const candidate of byDisposition.get(controlClass)) {
        if (used.has(candidate.caseId)) continue;
        const distance = dailyMoveControlMatchDistance(sf, dailyMoveControlPrefixFacts(dayByDigest.get(candidate.marketIdentityDigest), manifest, anchorTs));
        if (distance !== null) ranked.push({ candidate, distance });
      }
      ranked.sort((a, b) => a.distance - b.distance || a.candidate.caseId.localeCompare(b.candidate.caseId));
      for (const hit of ranked.slice(0, manifest.rules.controlsPerClass)) {
        used.add(hit.candidate.caseId);
        surge.matches.push({ controlClass, caseId: hit.candidate.caseId, distance: hit.distance, anchorTs, matchingInputs: 'PREFIX_ONLY_SUPPORT_VOLATILITY_QUOTE_VOLUME' });
        hit.candidate.matches.push({ matchedSurgeCaseId: surge.caseId, controlClass, anchorTs });
        if (hit.candidate.retrospectiveReplay.decisionFrames.length === 0) materializeFrames(hit.candidate.retrospectiveReplay, dayByDigest.get(hit.candidate.marketIdentityDigest), manifest, anchorTs);
      }
    }
    materializeFrames(surge.retrospectiveReplay, surgeDay, manifest, anchorTs);
  }

  const dispositionCounts = Object.fromEntries(DISPOSITIONS.map((d) => [d, byDisposition.get(d).length]));
  const plannedDecisionMoments = rows.reduce((n, row) => n + row.retrospectiveReplay.decisionFrames.length, 0);
  const grossPlannedRecipeVariantSlots = rows.reduce((n, row) => n + row.retrospectiveReplay.decisionFrames.length
    * manifest.recipeSeals.reduce((m, seal) => m + seal.recipe.variants.length, 0), 0);
  const missingControlMatches = byDisposition.get('SURGE_CASE').reduce((n, row) => n
    + controlClasses.reduce((m, cls) => m + Math.max(0, manifest.rules.controlsPerClass - row.matches.filter((x) => x.controlClass === cls).length), 0), 0);
  const completeSupportMatrixCases = rows.filter((row) => row.retrospectiveLabels.disposition !== 'INVALID_DATA'
    && SUPPORT_FAMILIES.every((family) => row.support?.[family]?.state === 'COMPLETE')).length;
  const observedGroupDispositions = new Set(['SURGE_CASE', 'AMBIGUOUS_INTRABAR', 'FAILED_BREAKOUT_CONTROL', 'FALLING_CONTROL', 'FLAT_CONTROL', 'TOP_MOVER_CASE', 'OTHER_OBSERVED']);
  const verifiedLocalV2Archive = manifest.manifestVersion === DAILY_MOVE_MANIFEST_VERSION_V2;

  return deepFreeze({
    studyVersion: DAILY_MOVE_STUDY_VERSION, manifest,
    cases: rows,
    counters: {
      acceptedMarketDays: rows.length,
      exclusiveDispositionRows: Object.values(dispositionCounts).reduce((a, b) => a + b, 0),
      dispositions: dispositionCounts,
      surgeMarketDayEpisodes: dispositionCounts.SURGE_CASE,
      marketDayDependenceGroupsWithObservedData: new Set(rows.filter((row) => observedGroupDispositions.has(row.retrospectiveLabels.disposition)).map((row) => row.episodeGroupId)).size,
      statisticallyIndependentEvidenceGroups: null,
      plannedDecisionMoments,
      grossPlannedRecipeVariantSlots,
      inputEligibleSimulationSlots: null,
      horizonMaturedSimulationSlots: null,
      attemptedSimulations: 0,
      completedSimulations: 0,
      validSimulationOutcomes: 0,
      censoredOrAmbiguous: dispositionCounts.AMBIGUOUS_INTRABAR + dispositionCounts.MISSING_DATA + dispositionCounts.INVALID_DATA,
      completeSupportMatrixCases,
      fullDetailCasesClaimed: 0,
      missingControlMatches,
      unacceptedInputCount,
    },
    laws: {
      qualification: 'ANY STRICTLY ORDERED EARLIER_TO_LATER RISE >8% WITHIN THE DECLARED LOCAL DAY; LATER COLLAPSE DOES NOT UNQUALIFY',
      ...(manifest.manifestVersion === DAILY_MOVE_MANIFEST_VERSION_V3 ? {
        topMoverSelection: `SELECTED POPULATION = THE >8% THRESHOLD COHORT UNION THE TOP ${manifest.rules.topMoversPerDay} MARKETS BY |CLOSE/OPEN-1|, DEDUPED; TOP_MOVER_CASE MARKS A TOP MOVER THAT DID NOT CROSS THE INTRADAY THRESHOLD; THE THRESHOLD LAW IS UNCHANGED`,
      } : {}),
      sameCandle: 'OHLC LOW/HIGH ORDER UNKNOWN; SAME-BAR EXTREMA ALONE ARE AMBIGUOUS',
      denominator: verifiedLocalV2Archive
        ? 'EVERY MARKET IN THE VERIFIED LOCAL V2 ARCHIVE FULL-DAY CATALOG UNION HAS EXACTLY ONE ROW; THIS DOES NOT PROVE EXTERNAL CUSTODY OR PROSPECTIVE ELIGIBILITY'
        : 'EVERY MARKET IN THE SEALED SNAPSHOT HAS EXACTLY ONE ROW; FULL-DAY CATALOG EPOCH UNION IS NOT YET PROVEN',
      catalogProvenance: verifiedLocalV2Archive
        ? 'VERIFIED AGAINST THE CONTENT-BOUND LOCAL V2 ARCHIVE SESSION/CATALOG CONTROLS; durability=LOCAL_FILESYSTEM_ONLY and republishSafe=false'
        : 'CONTENT-VALID SNAPSHOT ONLY; provenanceVerified=false until durable day catalog controls are bound',
      separation: 'RETROSPECTIVE LABELS NEVER ENTER REPLAY-FRAME DIGESTS; GROSS PLANNED SLOTS ARE NOT INPUT-ELIGIBLE, ATTEMPTED, COMPLETED, VALID, OR PROSPECTIVE',
      inference: 'MARKET-DAY GROUPS ARE DEPENDENCE LABELS, NOT STATISTICAL INDEPENDENCE OR CAUSAL PROOF',
      authority: 'NO ORDER/JUDGE/PROMOTION/FULL_DETAIL/CAUSAL/PROSPECTIVE/EXECUTABLE CLAIM',
    },
  });
}
