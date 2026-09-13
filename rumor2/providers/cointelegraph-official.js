// RUMOR-2 news provider — Cointelegraph's first-party RSS route.  Explicit
// composition is required; this module does not widen the central registry.
export const COINTELEGRAPH_OFFICIAL = Object.freeze({
  id: 'COINTELEGRAPH_OFFICIAL',
  host: 'cointelegraph.com',
  feedUrl: 'https://cointelegraph.com/rss',
  sourceType: 'NEWS_PUBLISHER',
  authorityClass: 'PUBLISHER',
  providerKind: 'NEWS_RSS',
  cadenceSec: 300,
  hourlyBudget: 24,
  requiresContact: false,
});