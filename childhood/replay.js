// Replay engine — walks history forward, one timestamp at a time, seeing
// only what existed then. Builds frozen Observations through AsOfView; it
// holds no reference capable of reaching the future. No Outcome field
// exists anywhere in this file.
import { randomUUID, createHash } from 'node:crypto';
import { retBetween } from './store.js';
import { bucketAdd, pooledStats, zScore, classifyRipple } from '../survey/wideeye.js';
import { etHourKey } from '../lib/time.js';

const NON_TRIGGER_SAMPLE = 0.004; // deterministic ~0.4% of quiet moments join the memory

function deterministicSample(symbol, ts) {
  const h = createHash('sha1').update(`${symbol}:${ts}`).digest();
  return h.readUInt16BE(0) / 65535 < NON_TRIGGER_SAMPLE;
}

const prov = (source, sourceTs, retrievedTs, form = 'derived') => ({
  source,
  sourceTs,
  retrievedTs,
  kind: 'historical',
  form,
});

// Replays one symbol along one track. contextAt(ts) -> {btcRet, ethRet,
// universeMedianRet} computed elsewhere from the same track (also
// point-in-time: trailing returns only). Returns frozen observations.
export function replaySymbol({ store, track, cfg, contextAt, retrievedTs, aggressionAt = null }) {
  const observations = [];
  const buckets = { ret: {}, vol: {} };
  const minSamples = Math.min(cfg.minSamples ?? 60, 48); // coarse tracks: 48 ticks of own history
  const candles = store.candles;
  const stepMin = store.intervalSec / 60;

  for (let i = 1; i < candles.length; i++) {
    const [ts, , , , close, vol] = candles[i];
    const view = store.asOf(ts);
    const prevClose = candles[i - 1][4];
    const ret1 = retBetween(close, prevClose); // one-tick return on this track
    const c5 = view.closeAt(stepMin * 5);
    const ret5t = retBetween(close, c5);
    const c15 = view.closeAt(15);
    const extensionPct = c15 ? (close / c15 - 1) * 100 : null;

    const zVol = zScore(vol, pooledStats(buckets.vol), minSamples);
    const zRet = zScore(ret5t, pooledStats(buckets.ret), minSamples);
    const verdict = classifyRipple({ zVol, zRet5: zRet, ret15Pct: extensionPct }, cfg);

    // baselines learn AFTER evaluation — this tick never grades itself
    const hk = etHourKey(new Date(ts * 1000));
    if (ret5t !== null) bucketAdd((buckets.ret[hk] ??= { n: 0, sum: 0, sumSq: 0 }), ret5t);
    bucketAdd((buckets.vol[hk] ??= { n: 0, sum: 0, sumSq: 0 }), vol);

    const isTrigger = verdict !== null;
    if (!isTrigger && !deterministicSample(store.symbol, ts)) continue;

    const ctx = contextAt(ts);
    const aggression = aggressionAt ? aggressionAt(ts) : null;
    observations.push({
      id: randomUUID(),
      ts,
      symbol: store.symbol,
      track,
      eligibleAtTime: 'TRADED_AT_TS', // candle-evidenced; absent candles never reach here
      priceState: { close, ret1, ret5t, extensionPct },
      volumeState: { vol, volRateZ: zVol },
      marketContext: ctx,
      scoutSignals: { zVol, zRet, extensionPct },
      externalSignals: { rumint: 'UNAVAILABLE_HISTORICALLY', gateway: 'UNAVAILABLE_HISTORICALLY' },
      microstructure: {
        absorption: 'UNKNOWN_HISTORICALLY',
        refill: 'UNKNOWN_HISTORICALLY',
        cancels: 'UNKNOWN_HISTORICALLY',
        aggressionImbalance: aggression ?? 'UNKNOWN_HISTORICALLY',
      },
      dataAvailability: {
        priceState: 'KNOWN',
        volumeState: zVol === null ? 'UNKNOWN' : 'KNOWN',
        marketContext: ctx.universeMedianRet === null ? 'UNKNOWN' : 'KNOWN',
        scoutSignals: zVol === null || zRet === null ? 'UNKNOWN' : 'KNOWN',
        externalSignals: 'UNAVAILABLE',
        microstructure: aggression === null ? 'UNAVAILABLE' : 'KNOWN',
      },
      provenance: {
        priceState: prov('kraken REST OHLC', ts, retrievedTs, 'raw'),
        volumeState: prov('kraken REST OHLC', ts, retrievedTs, 'raw'),
        marketContext: prov('kraken REST OHLC (cross-symbol, trailing only)', ts, retrievedTs),
        scoutSignals: prov('wideeye replay (point-in-time baselines)', ts, retrievedTs),
        microstructure: prov(aggression === null ? 'none (no public L2/trades history)' : 'kraken REST Trades', ts, retrievedTs),
      },
      setupClassification: isTrigger ? verdict : 'BASELINE_SAMPLE',
    });
  }
  return observations;
}
