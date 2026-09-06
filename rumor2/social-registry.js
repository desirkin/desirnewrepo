// SOCIAL-1 — the social provider registry + ACCESS CENSUS. Deliberately
// SEPARATE from the frozen rumor2/registry.js: the official-ear registry is
// what the frozen checkpoint validator keys its required-provider set on, and
// §38 forbids forcing inactive social providers into that durable set. Social
// providers therefore live here with truthful, machine-readable access states,
// and only a durably-ACTIVE social provider is ever migrated into the
// checkpoint's provider set (see the checkpoint v5 migration).
//
// The census below is verified against CURRENT official documentation (see
// doctrine/SOCIAL.md for citations, gathered 2026-09-05). The system knows WHY
// each ear is or is not available — never a vague "disabled". (§2/§33)
import { SOCIAL_PROVIDER_KINDS } from './social.js';

// §2 access taxonomy — the closed set of truthful states.
export const SOCIAL_ACCESS_STATES = Object.freeze([
  'AVAILABLE_AUTHORIZED', // usable now with no credential/review (Bluesky Jetstream)
  'AVAILABLE_REQUIRES_CREDENTIAL', // usable with an API key/token we do not necessarily hold
  'AVAILABLE_REQUIRES_APP_REVIEW', // usable only after a platform app-review/approval
  'AVAILABLE_RESTRICTED_RESEARCH', // usable only under non-commercial/research or a commercial contract
  'NOT_ACCEPTING_NEW_ACCESS', // program paused/closed to new consumers
  'NOT_AUTHORIZED', // this system is categorically ineligible
  'NOT_SUITABLE_REALTIME', // an API exists but cannot serve timely organic signal
  'UNAVAILABLE', // no legitimate machine path at all
]);

// Whether an access state can, in principle, back a live durable ear NOW
// without a credential we must obtain. Only AVAILABLE_AUTHORIZED qualifies for
// unattended activation; everything else is dark until access is arranged.
export const isLiveActivatable = (state) => state === 'AVAILABLE_AUTHORIZED';
// SOCIAL-2B: three DISTINCT questions (§7). A. platform access capability — the
// access state says whether a legitimate machine path exists at all (with or
// without a credential we must hold). B. implementation/durable capability —
// `implemented`/`durable` say whether THIS codebase can write durable truth for
// it. C. runtime authorization RIGHT NOW — decided only by the provider runtime
// (explicit enable gate + credential present + hard budget + usage preflight +
// reconciled rules + collector writer fence). A static registry flag NEVER
// implies a credential exists.
export const isPlatformCapable = (state) => state === 'AVAILABLE_AUTHORIZED' || state === 'AVAILABLE_REQUIRES_CREDENTIAL';

// The closed social provider set for SOCIAL-1. `implemented` means an adapter
// exists in this codebase (normalization + transport or normalization-only).
// `durable` means it is wired to write durable social truth in THIS ticket
// (only Bluesky). Everything else is contract/access-prepared and DARK.
export const SOCIAL_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'BLUESKY_OFFICIAL',
    providerKind: 'SOCIAL_MICROBLOG',
    accessState: 'AVAILABLE_AUTHORIZED',
    transport: 'WEBSOCKET_JETSTREAM_V2',
    hosts: Object.freeze(['jetstream.us-east.bsky.network', 'jetstream.us-west.bsky.network']),
    streamPath: '/xrpc/network.bsky.jetstream.subscribeEvents',
    subprotocol: 'xrpc.v1.json',
    requiresCredential: false,
    credentialEnv: null,
    implemented: true,
    durable: true, // the one live durable social ear in SOCIAL-1
    highPriority: true,
    docUrl: 'https://bsky.network/docs/jetstream/',
    reason: 'Free, public, unauthenticated official real-time firehose with collection/DID filtering and replay; ideal first social ear.',
  }),
  Object.freeze({
    id: 'FARCASTER_OFFICIAL',
    providerKind: 'SOCIAL_MICROBLOG',
    accessState: 'AVAILABLE_REQUIRES_CREDENTIAL',
    transport: 'NEYNAR_WEBHOOK_REST',
    hosts: Object.freeze(['api.neynar.com', 'hub.neynar.com']),
    streamPath: null,
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'NEYNAR_API_KEY',
    implemented: true, // normalization adapter + fixtures; live transport gated on a key
    durable: false,
    highPriority: true,
    docUrl: 'https://docs.neynar.com/',
    reason: 'Neynar hosted API (free tier, x-api-key) gives real-time webhooks + cast search; the hub/Snapchain path needs a full node (not lightweight). Dark until NEYNAR_API_KEY is configured.',
  }),
  Object.freeze({
    id: 'X_OFFICIAL',
    providerKind: 'SOCIAL_MICROBLOG',
    accessState: 'AVAILABLE_REQUIRES_CREDENTIAL',
    transport: 'FILTERED_STREAM',
    hosts: Object.freeze(['api.x.com']),
    streamPath: '/2/tweets/search/stream',
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'X_BEARER_TOKEN',
    implemented: true, // SOCIAL-2B: filtered-stream mapper, rule compiler, HTTP transport, cost governor
    durable: true, // writes durable social truth ONLY when the runtime gates pass (never by this flag alone)
    runtimeGated: true, // C: authorization is decided at runtime — enable gate + bearer + hard budget + usage preflight + rules + writer fence
    highPriority: true,
    // pay-per-use cost census (observed 2026-09-06, docs.x.com pricing) — the cost governor pins these
    cost: Object.freeze({ model: 'PAY_PER_USE', postReadUsd: 0.005, userReadUsd: 0.01, monthlyPostReadCap: 3_000_000, usageEndpoint: '/2/usage/tweets', creditsEndpoint: '/2/usage/credits', dedupeWindowHours: 24, dedupeGuarantee: 'SOFT', observedOn: '2026-09-06' }),
    docUrl: 'https://docs.x.com/x-api/getting-started/pricing',
    reason: 'Pay-per-use filtered stream (~4-5s P99), 1 connection / 1,000 rules / 1,024 chars per rule. Requires OAuth2 App-Only bearer + an explicit hard read/dollar budget under the 3M/month self-serve cap; DARK by default, no paid connection without every runtime gate.',
  }),
  Object.freeze({
    id: 'REDDIT_OFFICIAL',
    providerKind: 'SOCIAL_FORUM',
    accessState: 'AVAILABLE_RESTRICTED_RESEARCH',
    transport: 'REST_POLL',
    hosts: Object.freeze(['oauth.reddit.com']),
    streamPath: null,
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'REDDIT_CLIENT_ID', // + REDDIT_CLIENT_SECRET
    implemented: false,
    durable: false,
    highPriority: false,
    cost: Object.freeze({ model: 'QPM', qpmPerClient: 100, window: '10min-avg', commercialContractRequired: true }),
    docUrl: 'https://support.reddithelp.com/hc/en-us/articles/14945211791892',
    reason: 'Official Data API (OAuth2, 100 QPM/client) is technically usable but COMMERCIAL use requires a written contract; unauthorized scraping is prohibited. Contract-gated for this system.',
  }),
  Object.freeze({
    id: 'STOCKTWITS_OFFICIAL',
    providerKind: 'SOCIAL_FINANCE',
    accessState: 'NOT_ACCEPTING_NEW_ACCESS',
    transport: 'FIRESTREAM_HTTP',
    hosts: Object.freeze(['api.stocktwits.com', 'firestream-portal.stocktwits.com']),
    streamPath: null,
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'STOCKTWITS_STREAM_USER', // + STOCKTWITS_STREAM_PASS (Firestream HTTP Basic)
    implemented: false,
    durable: false,
    highPriority: true, // a high-value intended ear — unavailable by ACCESS, not by judgement
    docUrl: 'https://api.stocktwits.com/developers',
    reason: 'Self-serve dev program paused ("won\'t be accepting new registrations"); public API docs offline (404). The Firestream enterprise firehose is partner-gated with no self-serve terms. High priority, blocked by access.',
  }),
  Object.freeze({
    id: 'META_PUBLIC',
    providerKind: 'SOCIAL_MICROBLOG',
    accessState: 'AVAILABLE_REQUIRES_APP_REVIEW',
    transport: 'GRAPH_API',
    hosts: Object.freeze(['graph.facebook.com']),
    streamPath: null,
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'META_APP_TOKEN',
    implemented: false,
    durable: false,
    highPriority: false,
    docUrl: 'https://developers.facebook.com/docs/features-reference/page-public-content-access/',
    reason: 'Facebook Page Public Content Access reads public Page posts but only after Meta App Review + Business Verification. Instagram Graph has no realtime public firehose (NOT_SUITABLE_REALTIME); the Meta Content Library is non-profit research only (AVAILABLE_RESTRICTED_RESEARCH). See doctrine/SOCIAL.md.',
  }),
  Object.freeze({
    id: 'TIKTOK_PUBLIC',
    providerKind: 'SOCIAL_MICROBLOG',
    accessState: 'NOT_AUTHORIZED',
    transport: null,
    hosts: Object.freeze([]),
    streamPath: null,
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: null,
    implemented: false,
    durable: false,
    highPriority: false,
    // a FINISHED architectural decision, not a TODO (§3/§32)
    finalDecision: 'EXCLUDED_FROM_REALTIME_RUMOR',
    docUrl: 'https://developers.tiktok.com/products/research-api/',
    reason: 'The only organic-content API (Research API) bars commercial use and is archival/day-granular with no streaming; Commercial Content API is ads/EU only; Display API is own-content only. No authorized, commercial, real-time organic path exists. Excluded — a final decision, not a pending task.',
  }),
]);

export const SOCIAL_PROVIDER_IDS = Object.freeze(SOCIAL_PROVIDERS.map((p) => p.id));
export const socialProviderById = (id) => SOCIAL_PROVIDERS.find((p) => p.id === id) ?? null;

// Providers that are durably ACTIVE in this ticket (write social truth into the
// event root now). Only these join the checkpoint provider set via v5.
export const ACTIVE_SOCIAL_PROVIDER_IDS = Object.freeze(SOCIAL_PROVIDERS.filter((p) => p.durable).map((p) => p.id));

// Structural invariants — asserted by tests too, so drift is caught.
for (const p of SOCIAL_PROVIDERS) {
  if (!SOCIAL_ACCESS_STATES.includes(p.accessState)) throw new Error(`social-registry: ${p.id} has an unknown accessState`);
  if (!SOCIAL_PROVIDER_KINDS.includes(p.providerKind)) throw new Error(`social-registry: ${p.id} has a non-social providerKind`);
  if (p.durable && !isPlatformCapable(p.accessState)) throw new Error(`social-registry: ${p.id} is durable but the platform is not capable`);
  if (p.durable && !isLiveActivatable(p.accessState) && p.runtimeGated !== true) throw new Error(`social-registry: ${p.id} needs a credential — it must be runtime-gated`);
}
