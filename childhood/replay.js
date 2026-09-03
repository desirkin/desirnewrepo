// Replay engines, B-0B. Two roles, never confused:
//
// PARITY_SCOUT (replayParity): a true one-minute sampling grid measuring the
//   SAME features live Wide Eye measures — real 1m/5m returns, real 15m
//   extension, volume-rate as max(0, delta of reconstructed rolling 24h
//   volume), exact live minSamples, live add-then-score ordering (shared
//   core), 7-day baseline retention, live cooldown semantics. Only this
//   role may emit RIPPLE / MISSED / NEAR_MISS / COOLDOWN_SUPPRESSED.
//
// CONTEXT_ONLY (replayContext): coarse tracks (60m/15m/5m) preserved for
//   context, regime memory, and outcome labeling at horizons they honestly
//   resolve. Their features are named by TRACK TICKS, never by live Wide-Eye
//   names, and they can never produce a Wide-Eye classification. Five hours
//   is not five minutes here, or anywhere.
//
// No Outcome field exists anywhere in this file. The future is unreachable:
// both engines consume forward iterators / frozen grids, never a store.
import { randomUUID, createHash } from 'node:crypto';
import { retBetween } from './store.js';
import { knowableAt } from './knowledge.js';
import { evaluateTick, zScore, pooledStats, pruneBaselineBuckets } from '../survey/eyecore.js';
import { etHourKey, sessionDate } from '../lib/time.js';

export const RANDOM_SEED = 'B0A-seed-1'; // deterministic; recorded in manifest
export const EVENT_GAP_FACTOR = 2;
export const EVENT_GAP_MIN_SEC = 30 * 60;
const DAY_MIN = 1440; // minutes in the rolling 24h volume window

// ---- stratified baseline sampling (unchanged from B-0A; deterministic).
export const BASELINE_STRATA = {
  nearThreshold: { probability: 0.02, rule: 'zVol in [1,3) or |zRet| in [0.67,2)' },
  offHours: { probability: 0.004, rule: 'ET hour in [0,6)' },
  marketMoving: { probability: 0.008, rule: '|universe median 1-tick ret| >= 0.2%' },
  ordinary: { probability: 0.002, rule: 'everything else' },
};

export function baselineStratum({ zVol, zRet, etHour, medianRet }) {
  if ((zVol !== null && zVol >= 1 && zVol < 3) || (zRet !== null && Math.abs(zRet) >= 0.67 && Math.abs(zRet) < 2)) {
    return 'nearThreshold';
  }
  if (etHour >= 0 && etHour < 6) return 'offHours';
  if (medianRet !== null && Math.abs(medianRet) >= 0.002) return 'marketMoving';
  return 'ordinary';
}

export function sampleDecision({ symbol, ts, stratum }, seed = RANDOM_SEED) {
  const h = createHash('sha1').update(`${seed}:${symbol}:${ts}`).digest();
  const u = h.readUInt32BE(0) / 0xffffffff;
  const p = BASELINE_STRATA[stratum].probability;
  return { sampled: u < p, inclusionProbability: p };
}

// ---- NEAR_MISS (unchanged): frozen T-state only; live gates untouched.
export function nearMissAssessment({ zVol, zRet, extensionPct }, cfg) {
  if (zVol === null || zRet === null) return { nearMiss: false };
  const reqs = [
    { name: `zVol>=${cfg.zVolThreshold}`, score: zVol / cfg.zVolThreshold, passed: zVol >= cfg.zVolThreshold },
    { name: `|zRet|>=${cfg.zRetThreshold}`, score: Math.abs(zRet) / cfg.zRetThreshold, passed: Math.abs(zRet) >= cfg.zRetThreshold },
  ];
  const promotionScore = Math.min(...reqs.map((r) => r.score));
  const failedHard = reqs.filter((r) => !r.passed).map((r) => r.name);
  const passed = reqs.filter((r) => r.passed).map((r) => r.name);
  const extKnown = extensionPct !== null;
  const softExtension = extKnown && Math.abs(extensionPct) > cfg.extensionCapPct;
  const nearMiss = failedHard.length > 0 && promotionScore >= 2 / 3;
  return {
    nearMiss,
    promotionScore: Number(promotionScore.toFixed(3)),
    promotionThreshold: 1,
    distanceToPromotion: Number((1 - promotionScore).toFixed(3)),
    failedHardRequirements: failedHard,
    failedSoftRequirements: softExtension ? [`|ext|<=${cfg.extensionCapPct}%`] : [],
    passedRequirements: passed,
  };
}

const prov = (source, sourceTs, availableTs, retrievedTs, form = 'derived') => ({
  source,
  sourceTs,
  availableTs,
  retrievedTs,
  kind: 'historical',
  form,
});

// ---- 1-minute sampling grid (B-0B §7). Kraken OHLCVT omits minutes with no
// trades, but live Wide Eye still surveys every minute. Grid minutes without
// a bar become explicit NO_TRADE_SAMPLING_POINTs: last price carries
// (unchanged), traded volume is zero, nothing is invented. candles must be
// COMPLETED 1m bars; sample ts is the minute's CLOSE time.
export function buildMinuteGrid(candles) {
  if (!candles.length) return [];
  const byClose = new Map(candles.map((c) => [c[0] + 60, c]));
  const first = candles[0][0] + 60;
  const last = candles.at(-1)[0] + 60;
  const grid = [];
  let lastPrice = candles[0][4];
  for (let ts = first; ts <= last; ts += 60) {
    const bar = byClose.get(ts);
    if (bar) {
      lastPrice = bar[4];
      grid.push({ ts, price: bar[4], barVolume: bar[5], form: 'REAL_OHLCVT_BAR', barOpenTs: bar[0] });
    } else {
      grid.push({ ts, price: lastPrice, barVolume: 0, form: 'NO_TRADE_SAMPLING_POINT', barOpenTs: null });
    }
  }
  return grid;
}

// =====================================================================
// PARITY_SCOUT replay — live Wide-Eye semantics on a true 1m grid.
// =====================================================================
export function replayParity({ minuteSamples, symbol, cfg, contextAt, retrievedTs, aggression = null }) {
  const observations = [];
  const baselines = { ret1: {}, ret5: {}, volRate: {} };
  const prices = []; // trailing prices, one per minute
  const volRing = []; // trailing per-minute volumes for the 24h rolling sum
  let roll24 = 0;
  let prevRoll24 = null;
  let lastRippleMs = -Infinity;
  let currentEvent = null;
  let lastPruneDate = null;

  for (let i = 0; i < minuteSamples.length; i++) {
    const s = minuteSamples[i];
    const replayTs = s.ts;
    prices.push(s.price);
    volRing.push(s.barVolume);
    roll24 += s.barVolume;
    if (volRing.length > DAY_MIN) roll24 -= volRing.shift();

    // WARM-UP (B-0B §6/§4J): rolling 24h volume — and therefore volRate —
    // does not exist until a full 24h of prior samples is present. Live
    // Serpent reads the venue's own 24h figure; historical Serpent must
    // earn it. Until then: UNKNOWN, zVol null, no signal.
    const volWarm = volRing.length >= DAY_MIN && prevRoll24 !== null;
    const volRate = volWarm ? Math.max(0, roll24 - prevRoll24) : null;
    if (volRing.length >= DAY_MIN) prevRoll24 = roll24;

    const pAt = (minAgo) => (prices.length > minAgo ? prices[prices.length - 1 - minAgo] : null);
    const ret1 = retBetween(s.price, pAt(1));
    const ret5 = retBetween(s.price, pAt(5));
    const p15 = pAt(15);
    const ret15Pct = p15 ? (s.price / p15 - 1) * 100 : null;
    if (ret1 === null) continue;

    // 7-day retention, live semantics, applied as replay time advances.
    const today = sessionDate(new Date(replayTs * 1000));
    if (today !== lastPruneDate) {
      lastPruneDate = today;
      for (const m of Object.values(baselines)) pruneBaselineBuckets(m, replayTs * 1000, sessionDate);
    }

    // Shared core, exact live ordering and exact live minSamples.
    const hourKey = etHourKey(new Date(replayTs * 1000));
    const { zVol, zRet5, verdict } = evaluateTick({ ret1, ret5, ret15Pct, volRate }, baselines, cfg, hourKey);
    const nm = nearMissAssessment({ zVol, zRet: zRet5, extensionPct: ret15Pct }, cfg);

    // Live cooldown semantics: a co-fire inside the cooldown window is NOT a
    // live-equivalent trigger; archive it, honestly labeled. Cooldown timer
    // refreshes only on emission, as live does.
    let classification = null;
    let wouldEmitLive = null;
    let population = null;
    if (verdict) {
      population = 'TRIGGER';
      const inCooldown = replayTs * 1000 - lastRippleMs < cfg.rippleCooldownMin * 60_000;
      if (inCooldown) {
        classification = 'COOLDOWN_SUPPRESSED';
        wouldEmitLive = false;
      } else {
        classification = verdict;
        wouldEmitLive = true;
        lastRippleMs = replayTs * 1000;
      }
    } else if (nm.nearMiss) {
      population = 'NEAR_MISS';
      classification = 'NEAR_MISS';
    }

    const ctx = contextAt(replayTs);
    let samplingMeta;
    if (!population) {
      const stratum = baselineStratum({ zVol, zRet: zRet5, etHour: Number(hourKey.slice(11)), medianRet: ctx.universeMedianRet });
      const d = sampleDecision({ symbol, ts: replayTs, stratum });
      if (!d.sampled) continue;
      population = 'BASELINE';
      classification = 'BASELINE_SAMPLE';
      samplingMeta = { stratum, inclusionProbability: d.inclusionProbability, seed: RANDOM_SEED };
    }

    // event clustering (unchanged rule); baselines stand alone
    let eventId;
    let firstTriggerTs;
    let triggerSequence;
    if (population === 'BASELINE') {
      eventId = `${symbol}:1m:${replayTs}:baseline`;
      firstTriggerTs = replayTs;
      triggerSequence = 1;
    } else {
      const gapSec = Math.max(EVENT_GAP_MIN_SEC, EVENT_GAP_FACTOR * 60);
      if (currentEvent && replayTs - currentEvent.lastTs <= gapSec) {
        currentEvent.lastTs = replayTs;
        currentEvent.seq += 1;
      } else {
        currentEvent = { id: `${symbol}:1m:${replayTs}`, firstTriggerTs: replayTs, lastTs: replayTs, seq: 1 };
      }
      eventId = currentEvent.id;
      firstTriggerTs = currentEvent.firstTriggerTs;
      triggerSequence = currentEvent.seq;
    }

    // trades enrichment: last FULLY ELAPSED bucket only (knowledge time)
    let aggressionValue = 'UNKNOWN_HISTORICALLY';
    let aggressionAvailable = 'UNAVAILABLE';
    if (aggression) {
      const bucketSec = aggression.bucketSec ?? 900;
      const lastElapsed = Math.floor(replayTs / bucketSec) * bucketSec - bucketSec;
      const v = aggression.imbalance[lastElapsed];
      if (v !== undefined && v !== null && knowableAt(lastElapsed + bucketSec, replayTs)) {
        aggressionValue = v;
        aggressionAvailable = 'KNOWN';
      }
    }

    observations.push({
      id: randomUUID(),
      ts: replayTs,
      symbol,
      track: '1m',
      trackRole: 'PARITY_SCOUT',
      population,
      wouldEmitLive,
      eventId,
      eventSymbol: symbol,
      firstTriggerTs,
      triggerTs: replayTs,
      triggerSequence,
      eligibleAtTime: s.form === 'REAL_OHLCVT_BAR' ? 'TRADED_AT_TS' : 'UNKNOWN',
      priceState: { close: s.price, ret1, ret5, extensionPct: ret15Pct },
      volumeState: {
        volRate,
        rolling24hVolume: volWarm ? roll24 : 'UNKNOWN_INSUFFICIENT_WARMUP',
        barVolume: s.barVolume,
      },
      marketContext: ctx,
      scoutSignals: { zVol, zRet: zRet5, extensionPct: ret15Pct },
      nearMissDetail: population === 'NEAR_MISS' ? nm : undefined,
      samplingMeta,
      externalSignals: { rumint: 'UNAVAILABLE_HISTORICALLY', gateway: 'UNAVAILABLE_HISTORICALLY' },
      microstructure: {
        absorption: 'UNKNOWN_HISTORICALLY',
        refill: 'UNKNOWN_HISTORICALLY',
        cancels: 'UNKNOWN_HISTORICALLY',
        aggressionImbalance: aggressionValue,
      },
      dataAvailability: {
        priceState: 'KNOWN',
        volumeState: volWarm ? 'KNOWN' : 'UNKNOWN',
        marketContext: ctx.universeMedianRet === null ? 'UNKNOWN' : 'KNOWN',
        scoutSignals: zVol === null || zRet5 === null ? 'UNKNOWN' : 'KNOWN',
        externalSignals: 'UNAVAILABLE',
        microstructure: aggressionAvailable,
      },
      provenance: {
        priceState: prov(
          s.form === 'REAL_OHLCVT_BAR' ? 'kraken 1m OHLCVT (closed bar)' : 'NO_TRADE_SAMPLING_POINT (last trade price carried; nothing invented)',
          s.barOpenTs ?? replayTs,
          replayTs,
          retrievedTs,
          s.form === 'REAL_OHLCVT_BAR' ? 'raw' : 'derived'
        ),
        volumeState: prov('rolling 24h sum of 1m traded volume (live-definition volRate)', replayTs, replayTs, retrievedTs),
        marketContext: prov('cross-symbol closed bars, trailing only', replayTs, replayTs, retrievedTs),
        scoutSignals: prov('shared eyecore (live ordering, live minSamples)', replayTs, replayTs, retrievedTs),
        microstructure: prov(
          aggressionAvailable === 'KNOWN' ? 'kraken REST Trades (fully elapsed bucket)' : 'none (no public L2/trades history)',
          replayTs,
          aggressionAvailable === 'KNOWN' ? Math.floor(replayTs / 900) * 900 : 'UNKNOWN',
          retrievedTs
        ),
      },
      setupClassification: classification,
    });
  }
  return observations;
}

// =====================================================================
// CONTEXT_ONLY replay — coarse tracks. Honest names, no Wide-Eye output.
// =====================================================================
export function replayContext({ replayViews, symbol, intervalSec, track, contextAt, retrievedTs }) {
  const observations = [];
  const tickMin = intervalSec / 60;
  let prevCloses = [];

  for (const { replayTs, bar } of replayViews) {
    const close = bar[4];
    prevCloses.push(close);
    if (prevCloses.length > 6) prevCloses.shift();
    if (prevCloses.length < 2) continue;
    const retTick1 = retBetween(close, prevCloses.at(-2));
    const retTick5 = prevCloses.length >= 6 ? retBetween(close, prevCloses[0]) : null;

    const ctx = contextAt(replayTs);
    const hourKey = etHourKey(new Date(replayTs * 1000));
    const stratum = baselineStratum({ zVol: null, zRet: null, etHour: Number(hourKey.slice(11)), medianRet: ctx.universeMedianRet });
    const d = sampleDecision({ symbol, ts: replayTs, stratum });
    if (!d.sampled) continue;

    observations.push({
      id: randomUUID(),
      ts: replayTs,
      symbol,
      track,
      trackRole: 'CONTEXT_ONLY',
      population: 'BASELINE',
      eventId: `${symbol}:${track}:${replayTs}:context`,
      eventSymbol: symbol,
      firstTriggerTs: replayTs,
      triggerTs: replayTs,
      triggerSequence: 1,
      eligibleAtTime: 'TRADED_AT_TS',
      // Track-native names only: a 60m tick return is NOT a live 1m return
      // and is never called one. trackTickMinutes makes the scale explicit.
      priceState: { close, retTick1, retTick5, trackTickMinutes: tickMin },
      volumeState: { barVolume: bar[5] }, // raw candle volume; NOT the live volRate feature
      marketContext: ctx,
      scoutSignals: 'UNAVAILABLE_ON_CONTEXT_TRACK',
      samplingMeta: { stratum, inclusionProbability: d.inclusionProbability, seed: RANDOM_SEED },
      externalSignals: { rumint: 'UNAVAILABLE_HISTORICALLY', gateway: 'UNAVAILABLE_HISTORICALLY' },
      microstructure: {
        absorption: 'UNKNOWN_HISTORICALLY',
        refill: 'UNKNOWN_HISTORICALLY',
        cancels: 'UNKNOWN_HISTORICALLY',
        aggressionImbalance: 'UNKNOWN_HISTORICALLY',
      },
      dataAvailability: {
        priceState: 'KNOWN',
        volumeState: 'KNOWN',
        marketContext: ctx.universeMedianRet === null ? 'UNKNOWN' : 'KNOWN',
        scoutSignals: 'UNAVAILABLE',
        externalSignals: 'UNAVAILABLE',
        microstructure: 'UNAVAILABLE',
      },
      provenance: {
        priceState: prov(`kraken REST OHLC ${track} (closed bar)`, bar[0], replayTs, retrievedTs, 'raw'),
        volumeState: prov(`kraken REST OHLC ${track} raw bar volume (context only)`, bar[0], replayTs, retrievedTs, 'raw'),
        marketContext: prov('cross-symbol closed bars, trailing only', bar[0], replayTs, retrievedTs),
      },
      setupClassification: 'CONTEXT_SAMPLE',
    });
  }
  return observations;
}
