// RUMOR-2A provider — the official SEC press-release feed (www.sec.gov,
// HTTPS, first-party RSS 2.0). The SEC's automated-access policy expects a
// contact-bearing User-Agent: if no SERPENT_HTTP_CONTACT is configured this
// provider is truthfully NOT_QUERIED — Serpent never invents a contact and
// never impersonates a browser.
export const SEC_OFFICIAL = Object.freeze({
  id: 'SEC_OFFICIAL',
  host: 'www.sec.gov',
  feedUrl: 'https://www.sec.gov/news/pressreleases.rss',
  sourceType: 'REGULATOR',
  authorityClass: 'OFFICIAL',
  providerKind: 'REGULATOR',
  cadenceSec: 120,
  hourlyBudget: 45,
  requiresContact: true,
});
