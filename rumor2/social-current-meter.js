import { createHash } from 'node:crypto';
export const CURRENT_REQUEST_TYPE = 'RUMOR2_SOCIAL_CURRENT_REQUEST_RESERVED';
const LANES = ['REDDIT_OFFICIAL','STOCKTWITS_OFFICIAL','META_PUBLIC'];
export function currentRequestEvent(provider, day, ordinal, knownAtTs) {
  return { type: CURRENT_REQUEST_TYPE, provider, day, ordinal, knownAtTs, ts: new Date(knownAtTs).toISOString(), sourceEventId: `r2cr-${createHash('sha256').update(JSON.stringify([provider,day,ordinal])).digest('hex')}` };
}
export function currentRequestError(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join(',') !== 'day,knownAtTs,ordinal,provider,sourceEventId,ts,type') return 'current request shape';
  if (e.type !== CURRENT_REQUEST_TYPE || !LANES.includes(e.provider) || !Number.isSafeInteger(e.ordinal) || e.ordinal < 1 || e.ordinal > 10000 || !Number.isSafeInteger(e.knownAtTs) || e.knownAtTs < 0 || e.knownAtTs > 8640000000000000) return 'current request values';
  const expected = currentRequestEvent(e.provider,e.day,e.ordinal,e.knownAtTs);
  return e.ts !== expected.ts || e.day !== e.ts.slice(0,10) || e.sourceEventId !== expected.sourceEventId ? 'current request identity/clock' : null;
}
