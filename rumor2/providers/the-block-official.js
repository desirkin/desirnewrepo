// RUMOR-2 news provider — The Block's first-party RSS route.  Explicit
// composition is required; this module does not widen the central registry.
export const THE_BLOCK_OFFICIAL = Object.freeze({
  id: 'THE_BLOCK_OFFICIAL',
  host: 'www.theblock.co',
  feedUrl: 'https://www.theblock.co/rss.xml',
  sourceType: 'NEWS_PUBLISHER',
  authorityClass: 'PUBLISHER',
  providerKind: 'NEWS_RSS',
  cadenceSec: 300,
  hourlyBudget: 24,
  requiresContact: false,
});