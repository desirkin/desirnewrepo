// RUMOR-2A provider — the official Kraken blog feed. Endpoint verified as
// operated by Kraken itself (blog.kraken.com, HTTPS, first-party RSS 2.0);
// no mirror, no cache, no third-party generator. Transport only: the
// provider description says WHERE to listen and WHO is speaking — claim
// interpretation, graph logic, and packet construction live elsewhere.
export const KRAKEN_OFFICIAL = Object.freeze({
  id: 'KRAKEN_OFFICIAL',
  host: 'blog.kraken.com',
  feedUrl: 'https://blog.kraken.com/feed',
  sourceType: 'EXCHANGE_OFFICIAL',
  authorityClass: 'OFFICIAL',
  providerKind: 'EXCHANGE_OFFICIAL',
  cadenceSec: 60,
  hourlyBudget: 90,
  requiresContact: false, // clear research User-Agent permitted
});
