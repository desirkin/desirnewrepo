// RUMOR-2A provider — the official CFTC press-release feed (www.cftc.gov,
// HTTPS, first-party RSS 2.0). Clear Serpent research User-Agent; contact
// appended when configured.
export const CFTC_OFFICIAL = Object.freeze({
  id: 'CFTC_OFFICIAL',
  host: 'www.cftc.gov',
  feedUrl: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',
  sourceType: 'REGULATOR',
  authorityClass: 'OFFICIAL',
  providerKind: 'REGULATOR',
  cadenceSec: 120,
  hourlyBudget: 45,
  requiresContact: false,
});
