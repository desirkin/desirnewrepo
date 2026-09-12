// RUMOR-2 news provider — CoinDesk's first-party RSS route.  This descriptor
// is intentionally not added to the central RUMOR-2 registry: composition
// must opt in to this source explicitly.
export const COINDESK_OFFICIAL = Object.freeze({
  id: 'COINDESK_OFFICIAL',
  host: 'www.coindesk.com',
  feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  sourceType: 'NEWS_PUBLISHER',
  authorityClass: 'PUBLISHER',
  providerKind: 'NEWS_RSS',
  cadenceSec: 300,
  hourlyBudget: 24,
  requiresContact: false,
});