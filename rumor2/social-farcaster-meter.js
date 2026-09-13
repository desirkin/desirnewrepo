// S09 request accounting is Social-side journal evidence, never a source or trading signal.
import { createHash } from 'node:crypto';
export const FARCASTER_REQUEST_TYPE = 'RUMOR2_FARCASTER_SEARCH_RESERVED';
const KEYS = ['type', 'ts', 'sourceEventId', 'provider', 'day', 'ordinal', 'knownAtTs'];
export function farcasterRequestEvent(day, ordinal, knownAtTs) {
  const sourceEventId = `r2fr-${createHash('sha256').update(JSON.stringify([day, ordinal])).digest('hex')}`;
  return { type: FARCASTER_REQUEST_TYPE, ts: new Date(knownAtTs).toISOString(), sourceEventId, provider: 'FARCASTER_OFFICIAL', day, ordinal, knownAtTs };
}
export function farcasterRequestError(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(k => !KEYS.includes(k)) || KEYS.some(k => !Object.hasOwn(e, k))) return 'Farcaster meter shape';
  if (e.type !== FARCASTER_REQUEST_TYPE || e.provider !== 'FARCASTER_OFFICIAL' || !Number.isSafeInteger(e.knownAtTs) || e.knownAtTs < 0 || e.knownAtTs > 8640000000000000 || !Number.isSafeInteger(e.ordinal) || e.ordinal < 1 || e.ordinal > 10000) return 'Farcaster meter values';
  const expected = farcasterRequestEvent(e.day, e.ordinal, e.knownAtTs);
  if (e.day !== expected.ts.slice(0, 10) || e.ts !== expected.ts || e.sourceEventId !== expected.sourceEventId) return 'Farcaster meter identity/clock';
  return null;
}
