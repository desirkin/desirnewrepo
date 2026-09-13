// RUMOR-2B1 provider — the U.S. Treasury / OFAC Specially Designated
// Nationals list through the official Sanctions List Service
// (sanctionslistservice.ofac.treas.gov, documented at
// ofac.treasury.gov/sanctions-list-service; verified first-party over
// HTTPS). The SLS serves list downloads through one 302 redirect to
// Treasury's own fixed publication bucket, so that exact host — and ONLY
// that host — is pinned as an explicit closed redirect allowlist; if
// Treasury ever moves the bucket this ear fails closed and truthfully
// instead of following an unknown host. This ear is EVIDENCE ONLY and
// DARK: it records what OFAC itself published (entity added / modified /
// removed, digital-currency addresses exactly as supplied) and never
// concludes market impact, ownership, or clustering. Snapshot/diff logic
// lives in rumor2/ofac.js.
export const OFAC_OFFICIAL = Object.freeze({
  id: 'OFAC_OFFICIAL',
  host: 'sanctionslistservice.ofac.treas.gov',
  feedUrl: 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv',
  redirectHosts: Object.freeze(['wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com']),
  adapter: 'OFAC_SDN_CSV',
  organization: 'US_TREASURY_OFAC', // stable source-family identity for future propagation reasoning
  sourceType: 'REGULATOR',
  authorityClass: 'OFFICIAL',
  providerKind: 'SANCTIONS_LIST', // no classifier pattern table => evidence only, never a typed claim
  cadenceSec: 3600, // the SDN list publishes infrequently — one bounded request per hour
  hourlyBudget: 4,
  requiresContact: false,
  maxBytes: 16_777_216, // the full SDN.CSV is several MiB — explicit per-provider stream cap
  timeoutMs: 30_000, // a multi-MiB official download needs a longer, still-bounded watchdog
});
