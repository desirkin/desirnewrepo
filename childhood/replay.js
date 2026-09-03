// Replay engine, B-0A hardened. Consumes CandleStore.replayViews() — a
// forward iterator of CLOSED bars — and never holds the store itself, so
// the future is structurally unreachable. Every provenance entry carries
// availableTs (knowledge time), and no field is consumed before it. No
// Outcome field exists anywhere in this file.
import { randomUUID, createHash } from 'node:crypto';
import { retBetween } from './store.js';
import { knowableAt } from './knowledge.js';
import { bucketAdd, pooledStats, zScore, classifyRipple } from '../survey/wideeye.js';
import { etHourKey } from '../lib/time.js';

export const RANDOM_SEED = 'B0A-seed-1'; // deterministic; recorded in manifest
export const EVENT_GAP_FACTOR = 2; // same event while trigger gaps <= max(30min, 2 bars)
export const EVENT_GAP_MIN_SEC = 30 * 60;

// ---- stratified baseline sampling (B-0A §9): deterministic under the seed,
// with per-stratum inclusion probabilities recorded on every sampled row so
// later analysis can undo the weighting. Never fed by outcome information.
export const BASELINE_STRATA = {
  // near-threshold quiet moments are the most instructive "almost" examples
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

// ---- NEAR_MISS (B-0A §7): determined ENTIRELY from the frozen state at T.
// Hard requirements are the live wide-eye promotion gates, unchanged.
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
  // near miss: at least 2/3 of the way to every hard gate, but not promoted
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
  availableTs, // earliest defensible PUBLIC observability — never silently sourceTs
  retrievedTs,
  kind: 'historical',
  form,
});

// Replays one symbol along one track via the closed-bar iterator.
// aggression: optional { imbalance: {bucketTs: value}, bucketSec } — the
// bucket consumed is the last FULLY ELAPSED one (availableTs = bucket end),
// never the bucket still in progress at replayTs.
export function replaySymbol({ replayViews, symbol, intervalSec, track, cfg, contextAt, retrievedTs, aggression = null }) {
  const observations = [];
  const buckets = { ret: {}, vol: {} };
  const minSamples = Math.min(cfg.minSamples ?? 60, 48);
  const stepMin = intervalSec / 60;
  const eventGapSec = Math.max(EVENT_GAP_MIN_SEC, EVENT_GAP_FACTOR * intervalSec);
  let currentEvent = null; // {id, firstTriggerTs, lastTs, seq}
  let prevClose = null;

  for (const { replayTs, bar, view } of replayViews) {
    const [, , , , close, vol] = bar;
    const ret1 = retBetween(close, prevClose);
    prevClose = close;
    if (ret1 === null) continue;
    const ret5t = retBetween(close, view.closeAt(stepMin * 5));
    const anchor15 = view.closeAt(15);
    // moveAlreadySpent anchor (B-0A §5): the close of the last bar fully
    // closed 15 minutes before replayTs — pure trailing information; the
    // future cannot influence it (unit-tested for path invariance).
    const extensionPct = anchor15 ? (close / anchor15 - 1) * 100 : null;

    const zVol = zScore(vol, pooledStats(buckets.vol), minSamples);
    const zRet = zScore(ret5t, pooledStats(buckets.ret), minSamples);
    const verdict = classifyRipple({ zVol, zRet5: zRet, ret15Pct: extensionPct }, cfg);
    const nm = nearMissAssessment({ zVol, zRet, extensionPct }, cfg);

    // baselines learn AFTER evaluation — this bar never grades itself
    const hk = etHourKey(new Date(replayTs * 1000));
    if (ret5t !== null) bucketAdd((buckets.ret[hk] ??= { n: 0, sum: 0, sumSq: 0 }), ret5t);
    bucketAdd((buckets.vol[hk] ??= { n: 0, sum: 0, sumSq: 0 }), vol);

    const isTrigger = verdict !== null;
    const ctx = contextAt(replayTs);
    let population = null;
    let samplingMeta = null;
    if (isTrigger) population = 'TRIGGER';
    else if (nm.nearMiss) population = 'NEAR_MISS';
    else {
      const stratum = baselineStratum({
        zVol,
        zRet,
        etHour: Number(etHourKey(new Date(replayTs * 1000)).slice(11)),
        medianRet: ctx.universeMedianRet,
      });
      const d = sampleDecision({ symbol, ts: replayTs, stratum });
      if (!d.sampled) continue;
      population = 'BASELINE';
      samplingMeta = { stratum, inclusionProbability: d.inclusionProbability, seed: RANDOM_SEED };
    }

    // event clustering (B-0A §4): trigger/near-miss observations within the
    // deterministic gap window share one event; baselines stand alone.
    let eventId;
    let firstTriggerTs;
    let triggerSequence;
    if (population === 'BASELINE') {
      eventId = `${symbol}:${track}:${replayTs}:baseline`;
      firstTriggerTs = replayTs;
      triggerSequence = 1;
    } else {
      if (currentEvent && replayTs - currentEvent.lastTs <= eventGapSec) {
        currentEvent.lastTs = replayTs;
        currentEvent.seq += 1;
      } else {
        currentEvent = { id: `${symbol}:${track}:${replayTs}`, firstTriggerTs: replayTs, lastTs: replayTs, seq: 1 };
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
      const availableTs = lastElapsed + bucketSec;
      const v = aggression.imbalance[lastElapsed];
      if (v !== undefined && v !== null && knowableAt(availableTs, replayTs)) {
        aggressionValue = v;
        aggressionAvailable = 'KNOWN';
      }
    }

    observations.push({
      id: randomUUID(),
      ts: replayTs, // bar CLOSE time: the earliest moment these values were knowable
      symbol,
      track,
      population,
      eventId,
      eventSymbol: symbol,
      firstTriggerTs,
      triggerTs: replayTs,
      triggerSequence,
      eligibleAtTime: 'TRADED_AT_TS',
      priceState: { close, ret1, ret5t, extensionPct },
      volumeState: { vol, volRateZ: zVol },
      marketContext: ctx,
      scoutSignals: { zVol, zRet, extensionPct },
      nearMissDetail: population === 'NEAR_MISS' ? nm : undefined,
      samplingMeta: samplingMeta ?? undefined,
      externalSignals: { rumint: 'UNAVAILABLE_HISTORICALLY', gateway: 'UNAVAILABLE_HISTORICALLY' },
      microstructure: {
        absorption: 'UNKNOWN_HISTORICALLY',
        refill: 'UNKNOWN_HISTORICALLY',
        cancels: 'UNKNOWN_HISTORICALLY',
        aggressionImbalance: aggressionValue,
      },
      dataAvailability: {
        priceState: 'KNOWN',
        volumeState: zVol === null ? 'UNKNOWN' : 'KNOWN',
        marketContext: ctx.universeMedianRet === null ? 'UNKNOWN' : 'KNOWN',
        scoutSignals: zVol === null || zRet === null ? 'UNKNOWN' : 'KNOWN',
        externalSignals: 'UNAVAILABLE',
        microstructure: aggressionAvailable,
      },
      provenance: {
        priceState: prov('kraken REST OHLC (closed bar)', bar[0], replayTs, retrievedTs, 'raw'),
        volumeState: prov('kraken REST OHLC (closed bar)', bar[0], replayTs, retrievedTs, 'raw'),
        marketContext: prov('kraken REST OHLC (cross-symbol, closed bars, trailing only)', bar[0], replayTs, retrievedTs),
        scoutSignals: prov('wideeye replay (point-in-time baselines)', bar[0], replayTs, retrievedTs),
        microstructure: prov(
          aggressionAvailable === 'KNOWN' ? 'kraken REST Trades (fully elapsed bucket)' : 'none (no public L2/trades history)',
          bar[0],
          aggressionAvailable === 'KNOWN' ? Math.floor(replayTs / 900) * 900 : 'UNKNOWN',
          retrievedTs
        ),
      },
      setupClassification: isTrigger ? verdict : population,
    });
  }
  return observations;
}
