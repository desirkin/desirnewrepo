// S04/S05/S07/S08 current observations: erasable RAM only, no journal/history/model input.
// Retrieval rights do not authorize an immutable archive. Expiry and stop erase all content
// and identities. The owner cockpit reads a detached snapshot through the composition root.
export const CURRENT_SOCIAL_PROVIDERS = Object.freeze(['STOCKTWITS_OFFICIAL', 'REDDIT_OFFICIAL', 'META_FACEBOOK', 'META_INSTAGRAM']);
export const CURRENT_SOCIAL_TTL_MS = 300000;
const KEYS = ['v','provider','nativeId','authorId','text','title','link','sourceTs','knownAtTs','expiresAtTs','authority'];
export function currentSocialError(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => !KEYS.includes(k)) || KEYS.some(k => !Object.hasOwn(o,k))) return 'shape';
  if (o.v !== 'social-current-1' || !CURRENT_SOCIAL_PROVIDERS.includes(o.provider) || o.authority !== 'NONE') return 'provider/authority';
  if (typeof o.nativeId !== 'string' || !o.nativeId || o.nativeId.length > 256 || (o.authorId !== null && (typeof o.authorId !== 'string' || o.authorId.length > 256))) return 'identity';
  if (typeof o.text !== 'string' || o.text.length > 4096 || (o.title !== null && (typeof o.title !== 'string' || o.title.length > 300))) return 'content';
  if (!Number.isSafeInteger(o.knownAtTs) || o.knownAtTs < 0 || o.expiresAtTs !== o.knownAtTs + CURRENT_SOCIAL_TTL_MS || (o.sourceTs !== null && (!Number.isSafeInteger(o.sourceTs) || o.sourceTs < 0 || o.sourceTs > o.knownAtTs))) return 'clock';
  if (o.link !== null) { try { const u = new URL(o.link); if (u.protocol !== 'https:' || u.username || u.password || o.link.length > 2048) return 'link'; } catch { return 'link'; } }
  return null;
}
export function currentSocialRecord(provider, input, knownAtTs) {
  const o = { v: 'social-current-1', provider, nativeId: input.nativeId, authorId: input.authorId ?? null, text: typeof input.text === 'string' ? input.text.slice(0,4096) : '', title: typeof input.title === 'string' ? input.title.slice(0,300) : null, link: input.link ?? null, sourceTs: Number.isSafeInteger(input.sourceTs) && input.sourceTs >= 0 && input.sourceTs <= knownAtTs ? input.sourceTs : null, knownAtTs, expiresAtTs: knownAtTs + CURRENT_SOCIAL_TTL_MS, authority: 'NONE' };
  return currentSocialError(o) ? null : o;
}
export function createCurrentSocialStore({ now = Date.now, maxRows = 500 } = {}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) throw new Error('current social row cap');
  const rows = new Map(), key = (p,id) => JSON.stringify([p,id]);
  const purge = () => { for (const [k,o] of rows) if (o.expiresAtTs <= now() || o.knownAtTs > now()) rows.delete(k); };
  return { upsert(o) { purge(); if (currentSocialError(o) || o.knownAtTs > now() || o.expiresAtTs <= now()) return false; const k = key(o.provider,o.nativeId); rows.delete(k); rows.set(k,Object.freeze({...o})); while (rows.size > maxRows) rows.delete(rows.keys().next().value); return true; },
    remove: (provider,id) => rows.delete(key(provider,id)), clear(provider = null) { for (const [k,o] of rows) if (provider === null || o.provider === provider) rows.delete(k); },
    snapshot() { purge(); return { v: 'social-current-view-1', authority: 'NONE', retention: 'RAM_ONLY_MAX_5_MINUTES', historicalCoverage: 'NONE', observations: [...rows.values()].map(o => ({...o})) }; } };
}
