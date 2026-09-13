// RUMOR-2A provider registry — the closed set of ears this layer may use.
// Every entry names a FIXED official HTTPS host; the collector may request
// only these hosts, ever. RUMOR-2B may add adapters (X via sanctioned
// access, authorized Reddit, official exchange/project feeds) by adding
// entries here — nothing else in the layer changes shape. There is
// deliberately NO X, NO Reddit, and NO news-media entry in 2A.
import { KRAKEN_OFFICIAL } from './providers/kraken-official.js';
import { SEC_OFFICIAL } from './providers/sec-official.js';
import { CFTC_OFFICIAL } from './providers/cftc-official.js';
// RUMOR-2B1: two additional DARK official-primary-evidence ears — SEC EDGAR
// filings and the OFAC sanctions list. Evidence only: no claims, no coins,
// no Attention/HYPED/trading authority, config-gated OFF by default.
import { EDGAR_OFFICIAL } from './providers/edgar-official.js';
import { OFAC_OFFICIAL } from './providers/ofac-official.js';

export const PROVIDERS = Object.freeze([KRAKEN_OFFICIAL, SEC_OFFICIAL, CFTC_OFFICIAL, EDGAR_OFFICIAL, OFAC_OFFICIAL]);
export const PROVIDER_IDS = Object.freeze(PROVIDERS.map((p) => p.id));
export const providerById = (id) => PROVIDERS.find((p) => p.id === id) ?? null;

// SEC asks automated clients to identify an operator. Treat that value as
// header material, not merely a truthy configuration string: blank/control
// text or a value without a usable e-mail address keeps contact-gated ears
// dark. The normalized value is the only form allowed into User-Agent.
const EMAIL_IN_CONTACT_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const HEADER_CONTROL_RE = /[\u0000-\u001f\u007f]/;
export function normalizeHttpContact(contact) {
  if (typeof contact !== 'string') return null;
  const normalized = contact.trim();
  if (!normalized || normalized.length > 200 || HEADER_CONTROL_RE.test(normalized) || !EMAIL_IN_CONTACT_RE.test(normalized)) return null;
  return normalized;
}

// The one User-Agent policy: a clear research identity, with the operator
// contact appended when configured. Never a browser string, never personal
// data hardcoded.
export function userAgentFor(provider, contact) {
  const base = 'SerpentResearch/1.0 (automated public-feed research; read-only)';
  const normalizedContact = normalizeHttpContact(contact);
  return normalizedContact ? `${base} contact: ${normalizedContact}` : base;
}
