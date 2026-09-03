// The labeler — the only code allowed to open the future, and only AFTER
// observations are frozen. Writes Outcomes to a separate file keyed by
// observation id. Horizons the track cannot honestly resolve stay null.
import { mfeMae, retBetween } from './store.js';

export const HORIZONS_MIN = [1, 3, 5, 15, 30, 60, 240];

export function labelObservation(obs, store, contextStores) {
  const entry = obs.priceState.close;
  const mfe = {};
  const mae = {};
  for (const h of HORIZONS_MIN) {
    if (h * 60 < store.intervalSec) {
      // a 15m track cannot resolve a 1m horizon — null, never interpolated
      mfe[`${h}m`] = null;
      mae[`${h}m`] = null;
      continue;
    }
    const fut = store.future(obs.ts, h * 60);
    const r = mfeMae(entry, fut);
    mfe[`${h}m`] = r.mfe === null ? null : round4(r.mfe);
    mae[`${h}m`] = r.mae === null ? null : round4(r.mae);
  }

  const retAtMin = (min) => {
    const fut = store.future(obs.ts, min * 60);
    if (!fut.length) return null;
    const r = retBetween(fut.at(-1)[4], entry);
    return r === null ? null : r * 100;
  };
  const ret1h = retAtMin(60);
  const ret4h = retAtMin(240);

  const ctxRet = (sym) => {
    const s = contextStores[sym];
    if (!s) return null;
    const now = s.atOrBefore(obs.ts);
    const later = s.future(obs.ts, 3600).at(-1);
    if (!now || !later) return null;
    const r = retBetween(later[4], now[4]);
    return r === null ? null : r * 100;
  };
  const btc1h = ctxRet('BTC');
  const eth1h = ctxRet('ETH');
  const median1h = contextStores.median1hAt ? contextStores.median1hAt(obs.ts) : null;

  const abnormalVsMedian = ret1h !== null && median1h !== null ? ret1h - median1h : null;
  const outcomeTags = classifyOutcome({ mfe1h: mfe['60m'], ret1h, ret4h, abnormalVsMedian });

  return {
    id: obs.id,
    eventId: obs.eventId,
    mfe,
    mae,
    ret1hPct: ret1h === null ? null : round4(ret1h),
    ret4hPct: ret4h === null ? null : round4(ret4h),
    moveAlreadySpentPct: obs.priceState.extensionPct,
    moveRemainingPct: mfe['60m'],
    abnormalReturn: {
      vsBtc: ret1h !== null && btc1h !== null ? round4(ret1h - btc1h) : null,
      vsEth: ret1h !== null && eth1h !== null ? round4(ret1h - eth1h) : null,
      vsUniverseMedian: abnormalVsMedian === null ? null : round4(abnormalVsMedian),
    },
    outcomeTags,
  };
}

// B-0A §2: numeric outcome fields are the primary truth; tags are
// convenience metadata, MULTI-LABEL, each with a deterministic mechanical
// definition (doctrine/CHILDHOOD.md). No narrative labeling, ever.
// A move can RUN in the first hour and REVERSE by the fourth.
export function classifyOutcome({ mfe1h, ret1h, ret4h, abnormalVsMedian }) {
  if (mfe1h === null || ret1h === null) return ['UNLABELED_INSUFFICIENT_FUTURE'];
  const tags = [];
  if (mfe1h >= 2 && ret1h >= 1) tags.push('RUN');
  if (mfe1h >= 3 && ret4h !== null && ret4h <= 0.5) tags.push('PUMP_LIKE');
  if (mfe1h >= 1.5 && (ret1h <= -0.5 || (ret4h !== null && ret4h <= -0.5))) tags.push('REVERSAL');
  if (ret1h >= 1 && abnormalVsMedian !== null && abnormalVsMedian < 0.3) tags.push('BETA_DRAG');
  return tags.length ? tags : ['FIZZLE'];
}

const round4 = (v) => Number(v.toFixed(4));
