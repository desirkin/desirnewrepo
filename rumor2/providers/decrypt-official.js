// RUMOR-2 news provider — Decrypt's first-party RSS route.  Explicit
// composition is required; this module does not widen the central registry.
export const DECRYPT_OFFICIAL = Object.freeze({
  id: 'DECRYPT_OFFICIAL',
  host: 'decrypt.co',
  feedUrl: 'https://decrypt.co/feed',
  sourceType: 'NEWS_PUBLISHER',
  authorityClass: 'PUBLISHER',
  providerKind: 'NEWS_RSS',
  cadenceSec: 300,
  hourlyBudget: 24,
  requiresContact: false,
});