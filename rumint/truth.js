// RUMINT-R1 — the pure truth core of the StockTwits ear. No network, no
// filesystem, no configuration reads: exact math and validation over
// explicit inputs, so the poller stays an orchestrator and every statistical
// claim here is unit-drillable. Three principles rule this file:
//   1. OBSERVED ZERO is evidence; UNOBSERVED is missing evidence — never
//      backfill an hour the ear did not actually listen through.
//   2. Identity is content, never wall-clock luck: message IDs are canonical
//      decimal strings compared exactly (BigInt), event identities are
//      sha1 over canonical key-sorted JSON of stable meaning.
//   3. Hard bounds everywhere — no unbounded set, cache, or history.
import { createHash } from 'node:crypto';
import { sessionDate, etHour } from '../lib/time.js';

export const RUMINT_CHECKPOINT_VERSION = 1;
export const PROVIDER = 'STOCKTWITS';

// ---- hard bounds (§91) ----------------------------------------------------
export const MAX_SYMBOLS = 64; // provider symbols carried in one checkpoint
export const MAX_BUCKET_HOURS = 176; // ~7 days + slack of hourly buckets/symbol
export const MAX_SEEN_IDS = 256; // durable recent-seen message-ID cache/symbol
export const MAX_PENDING_EVENTS = 256; // owed source-event debt (GOV-style)
export const MAX_REQUEST_STAMPS = 600; // persisted rolling-hour request clocks
export const MAX_ERROR_CHARS = 200; // any persisted error text
export const BASELINE_RETENTION_MS = 7 * 86_400_000; // existing ~7-day doctrine
// Provider message age: single-page sampling at 5–20min cadence means a
// genuinely NEW message surfaces within minutes; 24h generously admits late
// but legitimate messages into their correct historical hour while rejecting
// ancient replay that would distort history (§31).
export const MAX_MESSAGE_AGE_MS = 24 * 3_600_000;
export const MAX_FUTURE_SKEW_MS = 5 * 60_000; // provider clock ahead of ours

export const COVERAGE_SAMPLED = 'SAMPLED_SINGLE_PAGE';
export const COVERAGE_BOOTSTRAPPED = 'BOOTSTRAPPED_FROM_DURABLE_RUMINT_POLL';
const COVERAGES = new Set([COVERAGE_SAMPLED, COVERAGE_BOOTSTRAPPED]);
export const HYPED_STATES = Object.freeze(['BUILDING', 'READY', 'EMPTY', 'PARTIAL', 'UNAVAILABLE']);
const PENDING_KINDS = new Set(['POLL', 'NOMINATION', 'HYPED']);

export const boundedError = (msg) => String(msg ?? 'unknown').slice(0, MAX_ERROR_CHARS);

// ---- canonical identity ---------------------------------------------------
export const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`))
    .filter(Boolean)
    .join(',')}}`;
};

export const rumintIdentity = (basis) => createHash('sha1').update(canonicalJson(basis)).digest('hex');

// ---- canonical message IDs (§25) ------------------------------------------
// Positive integral IDs only, persisted as canonical decimal strings and
// compared exactly via BigInt — never lexicographically, never through
// floating-point coercion. Everything else is rejected AND counted.
export function canonicalMessageId(v) {
  try {
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v <= 0) return null; // unsafe numeric representation is unknowable, not guessable
      return String(v);
    }
    if (typeof v === 'bigint') return v > 0n ? v.toString(10) : null;
    if (typeof v === 'string') {
      const t = v.trim();
      if (!/^[0-9]{1,30}$/.test(t)) return null;
      const b = BigInt(t);
      return b > 0n ? b.toString(10) : null;
    }
    return null;
  } catch {
    return null;
  }
}

export const idGreater = (a, b) => BigInt(a) > BigInt(b);

// ---- unambiguous hour identity (§92) --------------------------------------
// Buckets are keyed by ABSOLUTE UTC hour ("YYYY-MM-DDTHH" in UTC), so the
// duplicated 01:00 ET hour of a DST fall-back night stays two distinct
// buckets. ET session date / hour-of-day are DERIVED per instant for
// HYPED/session semantics only.
export const utcHourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
export const hourKeyMs = (key) => Date.parse(`${key}:00:00.000Z`);
const HOUR_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

export const PROVIDER_SYMBOL_RE = /^[A-Z0-9]{1,15}\.X$/;
export const COIN_RE = /^[A-Z0-9]{1,15}$/;

// Provider symbol mapping (§53, hardened by R1A): the `${coin}.X` convention
// plus ONE bounded explicit verified override table. No fuzzy matching,
// ever. The SAME mapping is the checkpoint-validation invariant: a stored
// baseline claiming providerSymbol BTC.X with canonicalCoin ETH is an
// identity violation and is refused, so BTC.X evidence can never become
// HYPED ETH or ETH attention.
export const PROVIDER_SYMBOL_OVERRIDES = Object.freeze({});
export function providerSymbolFor(coin) {
  if (typeof coin !== 'string' || !COIN_RE.test(coin)) return null;
  return PROVIDER_SYMBOL_OVERRIDES[coin] ?? `${coin}.X`;
}
export const mappingConsistent = (coin, providerSymbol) => providerSymbolFor(coin) === providerSymbol;

export function emptyBaseline(providerSymbol, canonicalCoin) {
  return {
    providerSymbol,
    canonicalCoin,
    lastMsgId: null, // null = watermark UNKNOWN (not zero) until initialized
    recentSeenMessageIds: [],
    seenIdEvictions: 0,
    baselineRevision: 0,
    buckets: {},
  };
}

// An hour is OBSERVED only when the ear actually listened through it: a
// successful provider poll landed in it, or durable bootstrap proved it.
export const bucketObserved = (b) => Boolean(b && (b.successfulPolls > 0 || b.coverage === COVERAGE_BOOTSTRAPPED));

function pruneBuckets(buckets, nowMs) {
  const cutoff = nowMs - BASELINE_RETENTION_MS;
  const keys = Object.keys(buckets).filter((k) => hourKeyMs(k) >= cutoff);
  keys.sort(); // oldest first; drop from the front if still over the hard cap
  const keep = keys.length > MAX_BUCKET_HOURS ? keys.slice(keys.length - MAX_BUCKET_HOURS) : keys;
  const out = {};
  for (const k of keep) out[k] = buckets[k];
  return out;
}

// ---- page ingestion (§15, §25–§31) ----------------------------------------
// Pure: returns a NEW candidate baseline plus exact rejection accounting.
// The caller adopts the candidate only after the poll evidence is durably
// represented (§45). Accepts RAW provider message entries (id, created_at,
// entities.sentiment.basic) as well as pre-normalized {id, created_at,
// sentiment} fixtures — the raw path is the tested truth (§32).
export function ingestPage(baseline, messages, nowMs) {
  const stats = {
    returned: Array.isArray(messages) ? messages.length : 0,
    accepted: 0,
    acceptedIds: [], // the EXACT canonical ids counted — bound into the R1A poll transaction
    duplicateSamePage: 0,
    alreadySeen: 0,
    invalidId: 0,
    invalidTimestamp: 0,
    ancientRejected: 0,
    bootstrappedHourRejected: 0,
    watermarkInitialized: false,
  };
  const next = {
    ...baseline,
    recentSeenMessageIds: [...baseline.recentSeenMessageIds],
    buckets: Object.fromEntries(Object.entries(baseline.buckets).map(([k, b]) => [k, { ...b }])),
  };
  const seenCache = new Set(next.recentSeenMessageIds);
  const pageSeen = new Set();
  const remember = (id) => {
    if (seenCache.has(id)) return;
    seenCache.add(id);
    next.recentSeenMessageIds.push(id);
    while (next.recentSeenMessageIds.length > MAX_SEEN_IDS) {
      // bounded cache: evict the OLDEST remembered id and count the
      // degradation — beyond this horizon, re-appearing ids could be
      // re-accepted (a documented bounded imprecision, never unbounded)
      const evicted = next.recentSeenMessageIds.shift();
      seenCache.delete(evicted);
      next.seenIdEvictions += 1;
    }
  };

  const watermarkUnknown = next.lastMsgId === null;
  if (watermarkUnknown) stats.watermarkInitialized = true;

  for (const m of Array.isArray(messages) ? messages : []) {
    const id = canonicalMessageId(m?.id);
    if (id === null) {
      stats.invalidId += 1;
      continue;
    }
    if (pageSeen.has(id)) {
      stats.duplicateSamePage += 1; // same provider response repeating an id (§26)
      continue;
    }
    pageSeen.add(id);
    // diagnostic high-water mark: max valid id ever seen (never the sole
    // dedupe authority under SAMPLED_SINGLE_PAGE coverage — §30)
    if (next.lastMsgId !== null && idGreater(id, next.lastMsgId)) next.lastMsgId = id;

    if (watermarkUnknown) {
      // WATERMARK_INITIALIZED (§15): the first live page after an unknown
      // watermark establishes a starting point only. Its already-existing
      // messages are NOT counted as fresh chatter.
      remember(id);
      continue;
    }
    if (seenCache.has(id)) {
      stats.alreadySeen += 1;
      continue;
    }
    const ts = typeof m?.created_at === 'string' ? Date.parse(m.created_at) : NaN;
    if (!Number.isFinite(ts) || ts > nowMs + MAX_FUTURE_SKEW_MS) {
      stats.invalidTimestamp += 1;
      remember(id);
      continue;
    }
    if (nowMs - ts > MAX_MESSAGE_AGE_MS) {
      stats.ancientRejected += 1; // ancient replay never becomes chatter (§31)
      remember(id);
      continue;
    }
    const key = utcHourKey(ts);
    const existing = next.buckets[key];
    if (existing && existing.coverage === COVERAGE_BOOTSTRAPPED) {
      // a bootstrapped hour's count is a proven fact from durable history;
      // a live message may already be inside it — never double-count into it
      stats.bootstrappedHourRejected += 1;
      remember(id);
      continue;
    }
    const b = (next.buckets[key] ??= {
      count: 0,
      bull: 0,
      bear: 0,
      successfulPolls: 0,
      firstPollTs: null,
      lastPollTs: null,
      coverage: COVERAGE_SAMPLED,
    });
    b.count += 1;
    const sentiment = m?.entities?.sentiment?.basic ?? m?.sentiment ?? null;
    if (b.bull !== null) {
      if (sentiment === 'Bullish') b.bull += 1;
      else if (sentiment === 'Bearish') b.bear += 1;
    }
    remember(id);
    stats.accepted += 1;
    stats.acceptedIds.push(id);
  }

  if (watermarkUnknown) {
    let max = null;
    for (const id of pageSeen) if (max === null || idGreater(id, max)) max = id;
    next.lastMsgId = max; // may remain null on an empty/invalid page — still unknown, still honest
  }

  // A successful provider poll happened NOW: this hour is OBSERVED even when
  // zero messages were accepted (§16). Only genuine success reaches here.
  const nowKey = utcHourKey(nowMs);
  const nowBucket = (next.buckets[nowKey] ??= {
    count: 0,
    bull: 0,
    bear: 0,
    successfulPolls: 0,
    firstPollTs: null,
    lastPollTs: null,
    coverage: COVERAGE_SAMPLED,
  });
  const iso = new Date(nowMs).toISOString();
  nowBucket.successfulPolls += 1;
  nowBucket.firstPollTs ??= iso;
  nowBucket.lastPollTs = iso;

  next.buckets = pruneBuckets(next.buckets, nowMs);
  next.baselineRevision = (baseline.baselineRevision ?? 0) + 1;
  return { baseline: next, stats };
}

// ---- the ONE nomination rule (R1B §blocker-1) -----------------------------
// The single pure predicate shared by the live producer (signal decision /
// shouldNominate) and the source-record validator. A record that does not
// satisfy this is NOT a nomination, whatever its shape claims. UNCHANGED
// semantics: z KNOWN and >= threshold AND acceleration KNOWN and > 0.
export function nominationQualifies(z, acceleration, zThreshold = 3) {
  return (
    z !== null &&
    z !== undefined &&
    Number.isFinite(z) &&
    acceleration !== null &&
    acceleration !== undefined &&
    Number.isFinite(acceleration) &&
    Number.isFinite(zThreshold) &&
    z >= zThreshold &&
    acceleration > 0
  );
}

// ---- signal math (§16–§21) ------------------------------------------------
export function signalFromBaseline(baseline, nowMs, { zThreshold = 3 } = {}) {
  const buckets = baseline?.buckets ?? {};
  const kNow = utcHourKey(nowMs);
  const kPrev = utcHourKey(nowMs - 3_600_000);
  const kPrev2 = utcHourKey(nowMs - 2 * 3_600_000);
  const obs = (k) => bucketObserved(buckets[k]);

  const currentHourCount = obs(kNow) ? buckets[kNow].count : null;
  const previousHourCount = obs(kPrev) ? buckets[kPrev].count : null;
  const twoHoursPriorCount = obs(kPrev2) ? buckets[kPrev2].count : null;
  const velocity = currentHourCount; // msgs in the current absolute hour, or null if unobserved

  // History = OBSERVED hours strictly before the in-progress hour. An
  // observed zero hour counts; an unobserved hour never does (§17, §18).
  const history = Object.entries(buckets)
    .filter(([k, b]) => k !== kNow && bucketObserved(b))
    .map(([, b]) => b.count);
  const historyBucketCount = history.length;

  let historyMean = null;
  let historyStd = null;
  let zVelocity = null;
  let zReason;
  if (historyBucketCount < 24) {
    zReason = 'INSUFFICIENT_HISTORY';
  } else {
    historyMean = history.reduce((s, v) => s + v, 0) / historyBucketCount;
    const variance = history.reduce((s, v) => s + (v - historyMean) ** 2, 0) / historyBucketCount;
    historyStd = Math.sqrt(variance);
    if (historyStd === 0) {
      zReason = 'ZERO_VARIANCE'; // explicit, never conflated with thin history (§19)
    } else if (velocity === null) {
      zReason = 'UNOBSERVED_CURRENT_HOUR';
    } else {
      zVelocity = (velocity - historyMean) / historyStd;
      zReason = 'KNOWN';
    }
  }

  // Acceleration is KNOWN only across three contiguous OBSERVED hours —
  // an outage never manufactures a second derivative (§20).
  let acceleration = null;
  let accelerationReason;
  if (currentHourCount !== null && previousHourCount !== null && twoHoursPriorCount !== null) {
    acceleration = currentHourCount - 2 * previousHourCount + twoHoursPriorCount;
    accelerationReason = 'KNOWN';
  } else {
    accelerationReason = 'INSUFFICIENT_CONTIGUOUS_OBSERVATION';
  }

  // Sentiment shift stays descriptive: recent labeled share vs trailing
  // baseline share, null below the existing minimum label counts. Buckets
  // with bull=null (bootstrapped) carry no label detail and are skipped.
  const labeled = (b) => b && b.bull !== null && b.bear !== null;
  const recent = [buckets[kNow], buckets[kPrev]].filter(labeled);
  const recentBull = recent.reduce((s, b) => s + b.bull, 0);
  const recentBear = recent.reduce((s, b) => s + b.bear, 0);
  const recentLabeled = recentBull + recentBear;
  const all = Object.values(buckets).filter(labeled);
  const allBull = all.reduce((s, b) => s + b.bull, 0);
  const labeledTotal = all.reduce((s, b) => s + b.bull + b.bear, 0);
  let sentimentShift = null;
  if (recentLabeled >= 5 && labeledTotal >= 20) {
    sentimentShift = recentBull / recentLabeled - allBull / labeledTotal;
  }

  const zAvailable = zVelocity !== null;
  const zPass = zAvailable && zVelocity >= zThreshold;
  const accelerationAvailable = acceleration !== null;
  const accelerationPass = accelerationAvailable && acceleration > 0;
  let decision;
  if (!zAvailable) decision = zReason; // INSUFFICIENT_HISTORY | ZERO_VARIANCE | UNOBSERVED_CURRENT_HOUR — never disguised
  else if (nominationQualifies(zVelocity, acceleration, zThreshold)) decision = 'NOMINATED'; // the ONE rule, shared with the validator
  else if (!zPass) decision = 'Z_BELOW_THRESHOLD';
  else if (!accelerationAvailable) decision = 'ACCELERATION_UNAVAILABLE';
  else decision = 'ACCELERATION_NOT_POSITIVE';

  return {
    providerSymbol: baseline?.providerSymbol ?? null,
    velocity,
    currentHourCount,
    previousHourCount,
    twoHoursPriorCount,
    historyBucketCount,
    historyMean,
    historyStd,
    zVelocity,
    zReason,
    zThreshold,
    acceleration,
    accelerationReason,
    recentBull,
    recentBear,
    labeledTotal,
    sentimentShift,
    gates: { zAvailable, zPass, accelerationAvailable, accelerationPass },
    decision,
  };
}

// ---- HYPED canonical snapshot (§35–§37, §42) ------------------------------
// ONE pure computation produces the single HYPED truth every consumer shares.
// ET overnight window for session date D: 00:00:00–05:59:59 ET on D. Before
// 06:00 ET the session is BUILDING (never promoted); at/after 06:00 the set
// finalizes from COMPLETE observed overnight evidence and holds unless the
// underlying observed evidence itself legitimately changes.
// The exact observation facts a finalized HYPED snapshot is derived from —
// per considered symbol: which overnight ET hour labels were genuinely
// observed, and the summed observed overnight chatter. R1B persists this
// bounded immutable basis alongside pending HYPED debt so a restored owed
// snapshot can be PROVEN by recomputation, and a legitimate older
// transition stays provable even after the canonical set later changed.
export function hypedBasisFromBaselines({ baselines, atMs }) {
  const date = sessionDate(new Date(atMs));
  const entries = [];
  for (const baseline of Object.values(baselines ?? {})) {
    const labels = new Set();
    let overnight = 0;
    for (const [key, b] of Object.entries(baseline.buckets ?? {})) {
      if (!bucketObserved(b)) continue;
      const ms = hourKeyMs(key);
      const instant = new Date(ms);
      const h = etHour(instant);
      if (sessionDate(instant) !== date || h > 5) continue;
      labels.add(h);
      overnight += b.count;
    }
    entries.push({ coin: baseline.canonicalCoin, observedLabels: [...labels].sort((a, b) => a - b), overnight });
  }
  entries.sort((a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));
  return { v: 1, sessionDate: date, entries };
}

// The ONE finalized-HYPED formula, computed from a basis — used by the live
// snapshot AND by pending-debt proof, so the rule cannot fork.
export function hypedSnapshotFromBasis(basis) {
  // Full eligibility requires observation in EACH of the six overnight ET
  // hour labels (a fall-back duplicate 01:00 satisfies label 1 via either
  // of its two distinct absolute hours). Partial coverage never ranks and
  // its missing hours are never imagined as zero (§36).
  const scored = basis.entries.filter((e) => e.observedLabels.length === 6).map((e) => ({ coin: e.coin, overnight: e.overnight }));
  const insufficientSymbols = basis.entries.length - scored.length;
  const eligibleSymbols = scored.length;
  const nonzero = scored.filter((s) => s.overnight > 0).sort((a, b) => b.overnight - a.overnight || (a.coin < b.coin ? -1 : 1));
  let state;
  let symbols = [];
  if (eligibleSymbols === 0) {
    state = 'PARTIAL'; // insufficient overnight coverage — NOT a valid H0
  } else if (nonzero.length === 0) {
    state = 'EMPTY'; // a truthful H0: eligible symbols existed and none chattered
  } else {
    state = 'READY';
    symbols = nonzero.slice(0, Math.max(1, Math.ceil(nonzero.length / 10))).map((s) => s.coin);
  }
  const coverage = {
    eligibleSymbols,
    insufficientSymbols,
    nonzeroEligible: nonzero.length,
    reason: eligibleSymbols === 0 ? 'INSUFFICIENT_OVERNIGHT_COVERAGE' : null,
  };
  const identity = hypedSessionIdentity({ sessionDate: basis.sessionDate, state, symbols });
  return { sessionDate: basis.sessionDate, state, symbols, finalizedTs: null, identity, coverage };
}

export function validateHypedBasis(basis) {
  if (!basis || typeof basis !== 'object') return 'hyped basis not an object';
  if (basis.v !== 1) return 'hyped basis: unknown version';
  if (typeof basis.sessionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(basis.sessionDate)) return 'hyped basis: invalid sessionDate';
  if (!Array.isArray(basis.entries) || basis.entries.length > MAX_SYMBOLS) return 'hyped basis: entries invalid or over bound';
  for (const e of basis.entries) {
    if (!e || typeof e !== 'object') return 'hyped basis: entry not an object';
    if (typeof e.coin !== 'string' || !COIN_RE.test(e.coin)) return 'hyped basis: invalid coin';
    if (!Array.isArray(e.observedLabels) || e.observedLabels.length > 6) return 'hyped basis: invalid observedLabels';
    if (new Set(e.observedLabels).size !== e.observedLabels.length) return 'hyped basis: duplicate labels';
    for (const l of e.observedLabels) if (!Number.isInteger(l) || l < 0 || l > 5) return 'hyped basis: label out of range';
    if (!Number.isInteger(e.overnight) || e.overnight < 0) return 'hyped basis: invalid overnight count';
  }
  return null;
}

export function hypedSnapshot({ baselines, atMs }) {
  const at = new Date(atMs);
  const date = sessionDate(at);
  if (etHour(at) < 6) {
    return { sessionDate: date, state: 'BUILDING', symbols: [], finalizedTs: null, identity: null, coverage: null };
  }
  return hypedSnapshotFromBasis(hypedBasisFromBaselines({ baselines, atMs }));
}

// ---- semantic source identities (§43) -------------------------------------
export const pollEventIdentity = ({ providerSymbol, retrievedTs, baselineRevision }) =>
  rumintIdentity({ kind: 'RUMINT_POLL', v: 1, provider: PROVIDER, providerSymbol, retrievedTs, baselineRevision });

export const nominationEventIdentity = ({ pollSourceEventId }) =>
  rumintIdentity({ kind: 'RUMINT_NOMINATION', v: 1, provider: PROVIDER, pollSourceEventId });

export const hypedSessionIdentity = ({ sessionDate, state, symbols }) =>
  rumintIdentity({ kind: 'HYPED_SESSION', v: 1, provider: PROVIDER, sessionDate, state, symbols });

// Poll-level coverage labels (R1A §blocker-5): each names EXACTLY why
// retrieval stopped — a continuation failure is never disguised as a page
// cap, and a page cap is claimed only when the cap was genuinely reached.
export const POLL_COVERAGES = Object.freeze([
  COVERAGE_SAMPLED, // intentionally one page (watermark-init / no cursor)
  'COMPLETE_TO_WATERMARK', // prior boundary proven
  'SAMPLED_PAGE_CAP', // hard page cap reached with more still available
  'PARTIAL_CONTINUATION_SCHEMA_FAILURE',
  'PARTIAL_CONTINUATION_NETWORK_FAILURE',
  'PARTIAL_CONTINUATION_RATE_LIMIT',
  'PARTIAL_CONTINUATION_BUDGET_EXHAUSTED',
]);

// ---- ONE strict RUMINT source contract (R1A §blocker-2) -------------------
// The single validator for every truth-bearing RUMINT source record — newly
// prepared events, restored pending debt, crash-transaction reconciliation,
// and any source-log record used to settle a transaction. Event-specific
// semantics are validated INCLUDING identity recomputation: parseable JSON
// with a plausible 40-hex id is not trusted social evidence.
const Z_REASONS = new Set(['KNOWN', 'INSUFFICIENT_HISTORY', 'ZERO_VARIANCE', 'UNOBSERVED_CURRENT_HOUR']);
const ACCEL_REASONS = new Set(['KNOWN', 'INSUFFICIENT_CONTIGUOUS_OBSERVATION']);
const DECISIONS = new Set([
  'INSUFFICIENT_HISTORY',
  'ZERO_VARIANCE',
  'UNOBSERVED_CURRENT_HOUR',
  'Z_BELOW_THRESHOLD',
  'ACCELERATION_UNAVAILABLE',
  'ACCELERATION_NOT_POSITIVE',
  'NOMINATED',
]);
const isIsoTs = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nni = (v) => Number.isInteger(v) && v >= 0;
const numOrNull = (v) => v === null || Number.isFinite(v);
const SEID_RE = /^[0-9a-f]{40}$/;

export function validateSourceRecord(rec) {
  if (!rec || typeof rec !== 'object') return 'record not an object';
  if (!isIsoTs(rec.ts)) return 'invalid ts';
  if (typeof rec.sourceEventId !== 'string' || !SEID_RE.test(rec.sourceEventId)) return 'invalid sourceEventId';
  if (rec.type === 'RUMINT_POLL') {
    if (rec.provider !== PROVIDER) return 'poll: wrong provider';
    if (typeof rec.canonicalCoin !== 'string' || !COIN_RE.test(rec.canonicalCoin)) return 'poll: invalid canonicalCoin';
    if (!mappingConsistent(rec.canonicalCoin, rec.providerSymbol)) return 'poll: provider/coin mapping violation';
    if (!isIsoTs(rec.retrievedTs)) return 'poll: invalid retrievedTs';
    if (!POLL_COVERAGES.includes(rec.coverage)) return 'poll: invalid coverage';
    if (!Number.isInteger(rec.pagesFetched) || rec.pagesFetched < 1) return 'poll: invalid pagesFetched';
    for (const k of ['messagesReturned', 'accepted', 'duplicateSamePage', 'alreadySeen', 'invalidId', 'invalidTimestamp', 'ancientRejected', 'bootstrappedHourRejected']) {
      if (!nni(rec[k])) return `poll: invalid counter ${k}`;
    }
    if (typeof rec.watermarkInitialized !== 'boolean') return 'poll: invalid watermarkInitialized';
    if (!(rec.velocity === null || nni(rec.velocity))) return 'poll: invalid velocity';
    for (const k of ['currentHourCount', 'previousHourCount', 'twoHoursPriorCount']) {
      if (!(rec[k] === null || nni(rec[k]))) return `poll: invalid ${k}`;
    }
    if (!nni(rec.historyBucketCount)) return 'poll: invalid historyBucketCount';
    if (!numOrNull(rec.historyMean) || !numOrNull(rec.historyStd)) return 'poll: invalid history stats';
    if (!Z_REASONS.has(rec.zReason)) return 'poll: invalid zReason';
    if ((rec.z === null) !== (rec.zReason !== 'KNOWN')) return 'poll: z/zReason null semantics violated';
    if (rec.z !== null && !Number.isFinite(rec.z)) return 'poll: invalid z';
    if (!Number.isFinite(rec.zThreshold)) return 'poll: invalid zThreshold';
    if (!ACCEL_REASONS.has(rec.accelerationReason)) return 'poll: invalid accelerationReason';
    if ((rec.acceleration === null) !== (rec.accelerationReason !== 'KNOWN')) return 'poll: acceleration null semantics violated';
    if (rec.acceleration !== null && !Number.isFinite(rec.acceleration)) return 'poll: invalid acceleration';
    if (!rec.gates || typeof rec.gates !== 'object') return 'poll: gates missing';
    for (const g of ['zAvailable', 'zPass', 'accelerationAvailable', 'accelerationPass']) {
      if (typeof rec.gates[g] !== 'boolean') return `poll: invalid gate ${g}`;
    }
    if (!DECISIONS.has(rec.decision)) return 'poll: invalid decision';
    // R1B: gates and decision are FUNCTIONS of the record's own numbers —
    // recompute them through the one shared rule and demand agreement, so a
    // fabricated NOMINATED poll (or forged gates) cannot validate.
    const zAvailable = rec.z !== null;
    const zPass = zAvailable && rec.z >= rec.zThreshold;
    const accelerationAvailable = rec.acceleration !== null;
    const accelerationPass = accelerationAvailable && rec.acceleration > 0;
    if (
      rec.gates.zAvailable !== zAvailable ||
      rec.gates.zPass !== zPass ||
      rec.gates.accelerationAvailable !== accelerationAvailable ||
      rec.gates.accelerationPass !== accelerationPass
    )
      return 'poll: gates contradict the record numbers';
    const expectedDecision = !zAvailable
      ? rec.zReason
      : nominationQualifies(rec.z, rec.acceleration, rec.zThreshold)
        ? 'NOMINATED'
        : !zPass
          ? 'Z_BELOW_THRESHOLD'
          : !accelerationAvailable
            ? 'ACCELERATION_UNAVAILABLE'
            : 'ACCELERATION_NOT_POSITIVE';
    if (rec.decision !== expectedDecision) return 'poll: decision contradicts the record numbers';
    if (!Number.isInteger(rec.baselineRevision) || rec.baselineRevision < 1) return 'poll: invalid baselineRevision';
    const expected = pollEventIdentity({ providerSymbol: rec.providerSymbol, retrievedTs: rec.retrievedTs, baselineRevision: rec.baselineRevision });
    if (rec.sourceEventId !== expected) return 'poll: sourceEventId does not match its semantic basis';
    return null;
  }
  if (rec.type === 'RUMINT_NOMINATION') {
    if (rec.provider !== PROVIDER) return 'nomination: wrong provider';
    if (typeof rec.symbol !== 'string' || !COIN_RE.test(rec.symbol)) return 'nomination: invalid symbol';
    if (!mappingConsistent(rec.symbol, rec.providerSymbol)) return 'nomination: provider/coin mapping violation';
    if (typeof rec.pollSourceEventId !== 'string' || !SEID_RE.test(rec.pollSourceEventId)) return 'nomination: invalid pollSourceEventId';
    if (!Number.isFinite(rec.z) || !Number.isFinite(rec.acceleration)) return 'nomination: invalid numbers';
    if (!Number.isFinite(rec.zThreshold) || rec.zThreshold <= 0) return 'nomination: invalid zThreshold';
    // R1B blocker-1: a record that does not satisfy the ONE nomination rule
    // is NOT a nomination — it is rejected, never downgraded into a
    // nomination-shaped observation.
    if (!nominationQualifies(rec.z, rec.acceleration, rec.zThreshold)) return 'nomination: does not satisfy the nomination rule';
    if (rec.sourceEventId !== nominationEventIdentity({ pollSourceEventId: rec.pollSourceEventId })) return 'nomination: sourceEventId does not match its poll';
    return null;
  }
  if (rec.type === 'HYPED_SESSION') {
    if (rec.provider !== PROVIDER) return 'hyped: wrong provider';
    if (typeof rec.sessionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rec.sessionDate)) return 'hyped: invalid sessionDate';
    if (!['READY', 'EMPTY', 'PARTIAL'].includes(rec.state)) return 'hyped: invalid finalized state';
    if (!Array.isArray(rec.symbols) || rec.symbols.length > MAX_SYMBOLS) return 'hyped: symbols invalid or over bound';
    for (const s of rec.symbols) if (typeof s !== 'string' || !COIN_RE.test(s)) return 'hyped: invalid symbol';
    if (rec.coverage !== null && (typeof rec.coverage !== 'object' || Array.isArray(rec.coverage))) return 'hyped: invalid coverage';
    if (rec.sourceEventId !== hypedSessionIdentity({ sessionDate: rec.sessionDate, state: rec.state, symbols: rec.symbols }))
      return 'hyped: sourceEventId does not match its semantic basis';
    return null;
  }
  return `unknown truth-bearing type ${rec.type}`;
}

export const PENDING_KIND_TYPES = Object.freeze({ POLL: 'RUMINT_POLL', NOMINATION: 'RUMINT_NOMINATION', HYPED: 'HYPED_SESSION' });

// R1B: the exact agreement a nomination must have with its triggering poll.
// Used wherever a nomination is BOUND to a poll — the write-ahead
// transaction and persisted pending debt. An arbitrary 40-hex link is not
// proof; the cause itself must be a valid NOMINATED poll and every shared
// number must agree.
export function nominationBindingError(nom, poll) {
  const pollErr = validateSourceRecord(poll);
  if (pollErr) return `binding: triggering poll invalid (${pollErr})`;
  if (poll.type !== 'RUMINT_POLL') return 'binding: cause is not a poll';
  if (poll.decision !== 'NOMINATED') return 'binding: triggering poll did not decide NOMINATED';
  if (nom.pollSourceEventId !== poll.sourceEventId) return 'binding: nomination does not point at its cause';
  if (nom.symbol !== poll.canonicalCoin || nom.providerSymbol !== poll.providerSymbol) return 'binding: symbol disagrees with cause';
  if (nom.z !== poll.z || nom.zThreshold !== poll.zThreshold || nom.acceleration !== poll.acceleration) return 'binding: numbers disagree with cause';
  return null;
}

// R1B: one strict validator for a pending debt ENTRY — the record through
// the source contract, PLUS its proof: a nomination carries the exact
// triggering poll (cause); a HYPED session carries the immutable semantic
// basis it was derived from, and the snapshot must RECOMPUTE from that
// basis exactly — so a self-consistent fabrication that contradicts its
// own evidence can never append, while a legitimate OLDER transition stays
// provable even after the canonical set later changed.
export function validatePendingEntry(p) {
  if (!p || typeof p !== 'object') return 'pending entry not an object';
  if (!PENDING_KINDS.has(p.kind)) return 'invalid pending kind';
  if (!p.record || typeof p.record !== 'object') return 'pending record missing';
  if (p.record.type !== PENDING_KIND_TYPES[p.kind]) return 'pending kind/type mismatch';
  const err = validateSourceRecord(p.record);
  if (err) return `pending ${p.kind}: ${err}`;
  if (p.kind === 'NOMINATION') {
    if (!p.cause || typeof p.cause !== 'object') return 'pending NOMINATION: missing its triggering poll proof';
    const bindErr = nominationBindingError(p.record, p.cause);
    if (bindErr) return `pending NOMINATION: ${bindErr}`;
  }
  if (p.kind === 'HYPED') {
    const basisErr = validateHypedBasis(p.basis);
    if (basisErr) return `pending HYPED: ${basisErr}`;
    const proven = hypedSnapshotFromBasis(p.basis);
    if (
      proven.sessionDate !== p.record.sessionDate ||
      proven.state !== p.record.state ||
      canonicalJson(proven.symbols) !== canonicalJson(p.record.symbols) ||
      canonicalJson(proven.coverage ?? null) !== canonicalJson(p.record.coverage ?? null) ||
      proven.identity !== p.record.sourceEventId
    ) {
      return 'pending HYPED: snapshot contradicts its own semantic basis';
    }
  }
  return null;
}

// ---- strict checkpoint validation (§10) -----------------------------------
const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nonNegInt = (v) => Number.isInteger(v) && v >= 0;
const HEX40 = /^[0-9a-f]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function baselineError(sym, b) {
  if (!b || typeof b !== 'object') return 'baseline not an object';
  if (b.providerSymbol !== sym) return 'providerSymbol key mismatch';
  if (typeof sym !== 'string' || !/^[A-Za-z0-9._-]{1,20}$/.test(sym)) return 'invalid provider symbol';
  if (typeof b.canonicalCoin !== 'string' || !COIN_RE.test(b.canonicalCoin)) return 'invalid canonicalCoin';
  // R1A identity invariant (§2B): the checkpoint must prove the SAME mapping
  // the live collector uses — BTC.X evidence may never wear another coin
  if (!mappingConsistent(b.canonicalCoin, b.providerSymbol)) return 'provider/coin mapping violation';
  if (b.lastMsgId !== null && canonicalMessageId(b.lastMsgId) !== b.lastMsgId) return 'invalid lastMsgId';
  if (!Array.isArray(b.recentSeenMessageIds) || b.recentSeenMessageIds.length > MAX_SEEN_IDS) return 'seen-ID cache invalid or over bound';
  for (const id of b.recentSeenMessageIds) if (canonicalMessageId(id) !== id) return 'non-canonical seen id';
  if (!nonNegInt(b.seenIdEvictions)) return 'invalid seenIdEvictions';
  if (!nonNegInt(b.baselineRevision)) return 'invalid baselineRevision';
  if (!b.buckets || typeof b.buckets !== 'object') return 'buckets missing';
  const keys = Object.keys(b.buckets);
  if (keys.length > MAX_BUCKET_HOURS) return 'buckets over bound';
  for (const k of keys) {
    if (!HOUR_KEY_RE.test(k) || !Number.isFinite(hourKeyMs(k))) return `invalid bucket key ${k}`;
    const bk = b.buckets[k];
    if (!bk || typeof bk !== 'object') return 'bucket not an object';
    if (!nonNegInt(bk.count)) return 'invalid bucket count';
    const nullPair = bk.bull === null && bk.bear === null;
    if (!nullPair) {
      if (!nonNegInt(bk.bull) || !nonNegInt(bk.bear)) return 'invalid bull/bear';
      if (bk.bull + bk.bear > bk.count) return 'bull+bear exceeds count';
    }
    if (!nonNegInt(bk.successfulPolls)) return 'invalid successfulPolls';
    if (!COVERAGES.has(bk.coverage)) return 'invalid bucket coverage';
    if (bk.firstPollTs !== null && !isIso(bk.firstPollTs)) return 'invalid firstPollTs';
    if (bk.lastPollTs !== null && !isIso(bk.lastPollTs)) return 'invalid lastPollTs';
  }
  return null;
}

export function validateHypedState(h) {
  if (!h || typeof h !== 'object') return 'hyped not an object';
  if (h.sessionDate !== null && (typeof h.sessionDate !== 'string' || !DATE_RE.test(h.sessionDate))) return 'invalid hyped sessionDate';
  if (!HYPED_STATES.includes(h.state)) return 'invalid hyped state';
  if (!Array.isArray(h.symbols) || h.symbols.length > MAX_SYMBOLS) return 'hyped symbols invalid or over bound';
  for (const s of h.symbols) if (typeof s !== 'string' || !COIN_RE.test(s)) return 'invalid hyped symbol';
  if (h.finalizedTs !== null && !isIso(h.finalizedTs)) return 'invalid hyped finalizedTs';
  if (h.identity !== null && !(typeof h.identity === 'string' && HEX40.test(h.identity))) return 'invalid hyped identity';
  return null;
}

export function validateCheckpoint(state) {
  if (!state || typeof state !== 'object') return 'checkpoint not an object';
  if (state.version !== RUMINT_CHECKPOINT_VERSION) return `unknown checkpoint version ${state.version}`;
  if (!isIso(state.savedTs)) return 'invalid savedTs';
  if (state.provider !== PROVIDER) return `unknown provider ${state.provider}`;
  if (!state.baselines || typeof state.baselines !== 'object') return 'baselines missing';
  const syms = Object.keys(state.baselines);
  if (syms.length > MAX_SYMBOLS) return 'baselines over symbol bound';
  for (const sym of syms) {
    const err = baselineError(sym, state.baselines[sym]);
    if (err) return `baseline ${sym}: ${err}`;
  }
  const hypedErr = validateHypedState(state.hyped);
  if (hypedErr) return hypedErr;
  // R1A §2A: restored HYPED cannot be trusted from shape alone. Recompute
  // the snapshot from the validated restored baselines at the checkpoint's
  // own saved instant and demand exact semantic agreement — sessionDate,
  // state, ordered symbols, coverage AND identity. A fake READY ["DOGE"]
  // riding one BTC.X baseline, or a plausible-looking wrong 40-hex
  // identity, is refused here, before anything could be published.
  // UNAVAILABLE (a recorded compute failure) and the never-rolled
  // placeholder carry no semantic claim and are exempt; runtime re-rolls.
  const h = state.hyped;
  const neverRolled = h.sessionDate === null && h.state === 'BUILDING' && h.symbols.length === 0;
  if (h.state !== 'UNAVAILABLE' && !neverRolled) {
    let expected;
    try {
      expected = hypedSnapshot({ baselines: state.baselines, atMs: Date.parse(state.savedTs) });
    } catch {
      return 'hyped semantic recompute failed';
    }
    // canonical (key-sorted) comparison: a jsonb round-trip reorders object
    // keys without changing meaning — key order is never semantic truth
    if (
      h.sessionDate !== expected.sessionDate ||
      h.state !== expected.state ||
      canonicalJson(h.symbols) !== canonicalJson(expected.symbols) ||
      canonicalJson(h.coverage ?? null) !== canonicalJson(expected.coverage ?? null) ||
      h.identity !== expected.identity
    ) {
      return 'hyped snapshot contradicts its own baselines (semantic recompute mismatch)';
    }
  }
  const ph = state.providerHealth;
  if (!ph || typeof ph !== 'object') return 'providerHealth missing';
  if (!nonNegInt(ph.globalBackoffUntil)) return 'invalid globalBackoffUntil';
  if (!Array.isArray(ph.recentRequestTimestamps) || ph.recentRequestTimestamps.length > MAX_REQUEST_STAMPS) return 'request stamps invalid or over bound';
  for (const t of ph.recentRequestTimestamps) if (!nonNegInt(t)) return 'invalid request stamp';
  if (!ph.symbols || typeof ph.symbols !== 'object') return 'providerHealth.symbols missing';
  if (Object.keys(ph.symbols).length > MAX_SYMBOLS) return 'providerHealth.symbols over bound';
  for (const [sym, h] of Object.entries(ph.symbols)) {
    if (typeof sym !== 'string' || sym.length > 20) return 'invalid health symbol';
    if (!h || typeof h !== 'object') return 'health entry not an object';
    if (!nonNegInt(h.failureStreak)) return 'invalid failureStreak';
    if (!nonNegInt(h.unavailableUntil)) return 'invalid unavailableUntil';
    if (!Number.isInteger(h.cooldownLevel) || h.cooldownLevel < 0 || h.cooldownLevel > 2) return 'invalid cooldownLevel';
    if (h.lastError !== null && (typeof h.lastError !== 'string' || h.lastError.length > MAX_ERROR_CHARS)) return 'invalid lastError';
    if (h.lastErrorTs !== null && !isIso(h.lastErrorTs)) return 'invalid lastErrorTs';
    if (h.lastContinuationFailure !== undefined && h.lastContinuationFailure !== null) {
      const c = h.lastContinuationFailure;
      if (!c || typeof c !== 'object') return 'invalid lastContinuationFailure';
      if (typeof c.kind !== 'string' || c.kind.length > 64) return 'invalid continuation failure kind';
      if (!nonNegInt(c.tsMs)) return 'invalid continuation failure tsMs';
      if (c.error !== null && (typeof c.error !== 'string' || c.error.length > MAX_ERROR_CHARS)) return 'invalid continuation failure error';
    }
  }
  // R1A §2C / R1B: pending debt is validated by the ONE strict source
  // contract PLUS its proof — a nomination must carry its exact triggering
  // poll; a HYPED session must carry (and recompute from) its immutable
  // semantic basis. A record shaped only like {ts, type, 40-hex id} is not
  // owed truth, and a kind/type mismatch is refused before it could append.
  if (!Array.isArray(state.pendingEvents) || state.pendingEvents.length > MAX_PENDING_EVENTS) return 'pendingEvents invalid or over bound';
  for (const p of state.pendingEvents) {
    const err = validatePendingEntry(p);
    if (err) return err;
  }
  // R1A §blocker-1: the prepared poll transaction, when present, binds one
  // exact recoverable advancement — validated as strictly as everything else.
  const txnErr = validatePollTransaction(state.pollTransaction);
  if (txnErr) return txnErr;
  if (!state.counters || typeof state.counters !== 'object') return 'counters missing';
  for (const [k, v] of Object.entries(state.counters)) if (!nonNegInt(v)) return `invalid counter ${k}`;
  return null;
}

export function validatePollTransaction(t) {
  if (t === null || t === undefined) return null;
  if (typeof t !== 'object') return 'pollTransaction not an object';
  if (t.version !== 1) return 'pollTransaction: unknown version';
  if (t.state !== 'PREPARED') return 'pollTransaction: invalid state';
  if (t.provider !== PROVIDER) return 'pollTransaction: wrong provider';
  if (typeof t.canonicalCoin !== 'string' || !COIN_RE.test(t.canonicalCoin)) return 'pollTransaction: invalid canonicalCoin';
  if (!mappingConsistent(t.canonicalCoin, t.providerSymbol)) return 'pollTransaction: provider/coin mapping violation';
  if (!nonNegInt(t.prePollBaselineRevision)) return 'pollTransaction: invalid prePollBaselineRevision';
  if (t.candidateBaselineRevision !== t.prePollBaselineRevision + 1) return 'pollTransaction: revision progression violated';
  if (!Array.isArray(t.acceptedIds) || t.acceptedIds.length > 512) return 'pollTransaction: acceptedIds invalid or over bound';
  for (const id of t.acceptedIds) if (canonicalMessageId(id) !== id) return 'pollTransaction: non-canonical accepted id';
  const recErr = validateSourceRecord(t.record);
  if (recErr) return `pollTransaction record: ${recErr}`;
  if (t.record.type !== 'RUMINT_POLL') return 'pollTransaction: record is not a poll';
  if (t.record.sourceEventId !== t.sourceEventId) return 'pollTransaction: identity mismatch with its record';
  if (t.record.providerSymbol !== t.providerSymbol) return 'pollTransaction: symbol mismatch with its record';
  if (t.record.baselineRevision !== t.candidateBaselineRevision) return 'pollTransaction: revision mismatch with its record';
  const bErr = baselineError(t.providerSymbol, t.candidateBaseline);
  if (bErr) return `pollTransaction candidate baseline: ${bErr}`;
  if (t.candidateBaseline.baselineRevision !== t.candidateBaselineRevision) return 'pollTransaction: candidate revision mismatch';
  // R1B cross-consistency: a nomination exists in the transaction exactly
  // when its poll decided NOMINATED, and every shared value must agree —
  // a corrupt checkpoint cannot attach a fabricated nomination to a valid
  // poll, and cannot strip a real one from a nominating poll.
  if (t.record.decision === 'NOMINATED') {
    if (!t.nominationRecord || typeof t.nominationRecord !== 'object') return 'pollTransaction: nominating poll is missing its bound nomination';
    const nErr = validateSourceRecord(t.nominationRecord);
    if (nErr) return `pollTransaction nomination: ${nErr}`;
    if (t.nominationRecord.type !== 'RUMINT_NOMINATION') return 'pollTransaction: nomination record wrong type';
    const bindErr = nominationBindingError(t.nominationRecord, t.record);
    if (bindErr) return `pollTransaction: ${bindErr}`;
  } else if (t.nominationRecord !== null && t.nominationRecord !== undefined) {
    return 'pollTransaction: nomination bound to a poll that did not decide NOMINATED';
  }
  return null;
}
