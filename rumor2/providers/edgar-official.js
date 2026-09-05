// RUMOR-2B1 provider — SEC EDGAR primary filings over the SEC's own
// documented machine-readable API (data.sec.gov/submissions/CIK##########.json,
// listed on www.sec.gov "EDGAR application programming interfaces"; verified
// first-party over HTTPS). This ear is EVIDENCE ONLY and DARK: a filing's
// form type is metadata, never a conclusion; no coin, sentiment, or market
// implication is ever inferred from it. The deterministic classifier has no
// pattern table for this provider kind, so every accepted filing becomes a
// plain RUMOR2_SOURCE_OBSERVED record through the one authoritative
// prepared-transaction path — unresolved, entity-level evidence. The SEC's
// automated-access policy expects a contact-bearing User-Agent, so like the
// existing SEC ear this provider is truthfully NOT_QUERIED without
// SERPENT_HTTP_CONTACT. Parsing/whitelist logic lives in rumor2/edgar.js.
export const EDGAR_OFFICIAL = Object.freeze({
  id: 'EDGAR_OFFICIAL',
  host: 'data.sec.gov',
  feedUrl: 'https://data.sec.gov/submissions/', // base; the polled URL is one whitelisted CIK's document
  adapter: 'EDGAR_SUBMISSIONS',
  organization: 'US_SEC', // stable source-family identity for future propagation reasoning
  sourceType: 'REGULATOR',
  authorityClass: 'OFFICIAL',
  providerKind: 'SEC_FILINGS', // no classifier pattern table => evidence only, never a typed claim
  cadenceSec: 300, // one bounded request per 5 minutes (one whitelisted CIK per cycle)
  hourlyBudget: 12,
  requiresContact: true,
  // data.sec.gov serves no ETag and the polled URL rotates across the CIK
  // whitelist, so conditional caching is deliberately OFF: a cursor from one
  // CIK's document must never suppress another CIK's response.
  noConditional: true,
});
