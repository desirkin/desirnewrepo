// SOCIAL-1 — the social provider registry + ACCESS CENSUS. Deliberately
// SEPARATE from the frozen rumor2/registry.js: the official-ear registry is
// what the frozen checkpoint validator keys its required-provider set on, and
// §38 forbids forcing inactive social providers into that durable set. Social
// providers therefore live here with truthful, machine-readable access states,
// and only a durably-ACTIVE social provider ever joins the checkpoint's provider
// set. (SOCIAL-4E correction: this checkout retains checkpoint v4 — the Social
// resume position lives in journal RUMOR2_SOCIAL_CURSOR events; no v5 migration
// exists or is required.)
//
// The census below is verified against CURRENT official documentation (see
// doctrine/SOCIAL.md for citations, gathered 2026-09-05). The system knows WHY
// each ear is or is not available — never a vague "disabled". (§2/§33)
import { SOCIAL_PROVIDER_KINDS, SOCIAL_RETENTION_PROHIBITED_PROVIDERS } from './social.js';
import { STOCKTWITS_LEGACY_RUMINT, STOCKTWITS_ROUTES, STOCKTWITS_SOURCES, STOCKTWITS_USE_CASE, STOCKTWITS_OFFICIAL as ST } from './social-stocktwits.js';

// §2 access taxonomy — the closed set of truthful states.
export const SOCIAL_ACCESS_STATES = Object.freeze([
  'AVAILABLE_AUTHORIZED', // usable now with no credential/review (Bluesky Jetstream)
  'AVAILABLE_REQUIRES_CREDENTIAL', // usable with an API key/token we do not necessarily hold
  'AVAILABLE_REQUIRES_APP_REVIEW', // usable only after a platform app-review/approval
  'AVAILABLE_RESTRICTED_RESEARCH', // usable only under non-commercial/research or a commercial contract
  'AVAILABLE_REQUIRES_APPROVAL_AND_CLASSIFICATION', // SOCIAL-3: a documented official path exists, but the platform must approve THIS use case and classify it; nothing is assumed either way
  'AVAILABLE_REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW', // SOCIAL-4B: documented routes exist; whether THIS account is entitled to a route and whether the applicable offering terms permit this use are unresolved; implies no live/durable capability
  'NOT_ACCEPTING_NEW_ACCESS', // program paused/closed to new consumers
  'NOT_AUTHORIZED', // no authorized route for this system's intended use is established on the supplied facts (SOCIAL-4D wording; not a claim of platform denial)
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
    // SOCIAL-4D census correction: mapper present; live transport / collector wiring ABSENT; a
    // configured key is configuration only, never proof a feed runs or an account is entitled
    account: Object.freeze({ publishedPlan: 'FREE_PLAN_DOCUMENTED', thisProjectPlan: 'UNKNOWN', credits: 'UNKNOWN', entitlement: 'UNVERIFIED', termsRetrieval: 'FAILED_2026-09-06', retention: 'UNRESOLVED' }),
    // SOCIAL-4E foundation stage (pure, non-live): a readiness boundary that separates key presence,
    // published limits, account plan/credits, terms, retention, acquisition-path approval, coverage,
    // lag, and webhook guarantees. NOT operational access; `implemented`/`durable` keep their meanings.
    foundation: Object.freeze({ ticket: 'SOCIAL-4E', stage: 'ACCESS_BOUNDARY_ONLY', module: 'rumor2/social-farcaster-access.js', fixtureOnly: true, live: false, durable: false, operationalAccess: false, docsAccessedOn: '2026-09-07', docsUnverified: Object.freeze(['N3_PRICING', 'N4_TERMS']) }),
    reason: 'Neynar hosted API (x-api-key) documents event webhooks, cast search, a Kafka stream, and gRPC hub access; Neynar publishes a Free plan with per-endpoint limits (docs, 2026-09-06). This project\'s plan, credits, entitlement, terms (retrieval failed), retention, and actual cost are UNKNOWN/UNVERIFIED. The hub/Snapchain path needs a full node (not lightweight). The normalization mapper exists; NO live transport or collector wiring exists; NEYNAR_API_KEY presence is configuration only. Acquisition path selection (search polling vs webhooks) is a PROPOSAL pending terms, plan, recovery, and scope.',
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
  // Legacy YouTube source boundary. This is a pure request/fixture
  // descriptor retained for backward compatibility; the live metadata
  // collector is the separate video/ tier and never enters this registry.
  Object.freeze({
    id: 'YOUTUBE_OFFICIAL',
    providerKind: 'SOCIAL_MICROBLOG',
    accessState: 'AVAILABLE_REQUIRES_CREDENTIAL',
    transport: 'REST_SEARCH_LIST',
    hosts: Object.freeze(['www.googleapis.com']),
    streamPath: null,
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'YOUTUBE_API_KEY',
    implemented: true,
    durable: false,
    runtimeGated: true,
    highPriority: false,
    cost: Object.freeze({
      model: 'QUOTA_UNITS',
      searchListUnits: 100,
      dailyBudgetEnv: 'RUMOR2_SOCIAL_YOUTUBE_MAX_DAILY_QUOTA_UNITS',
      monthlyBudgetEnv: 'RUMOR2_SOCIAL_YOUTUBE_MAX_MONTHLY_QUOTA_UNITS',
      maxWatchlistAssets: 25,
      maxResults: 50,
      observedOn: '2026-09-12',
    }),
    docUrl: 'https://developers.google.com/youtube/v3/docs/search/list',
    reason: 'Official YouTube Data API v3 search.list read-only request/fixture boundary. No RUMOR-2 collector, durable social journal, posting, OAuth account mutation, or authority path exists; the composed metadata collector remains separate under video/.',
  }),
  Object.freeze({
    id: 'REDDIT_OFFICIAL',
    providerKind: 'SOCIAL_FORUM',
    // SOCIAL-3 (corrected): a documented official path exists (OAuth2 Data API);
    // whether THIS private single-user personal-trading use is permitted, how
    // Reddit classifies it, whether a separate agreement is required, and what
    // retention it permits are all UNRESOLVED until Reddit's actual review.
    // Neither "definitely commercial" nor "private, so exempt" is assumed.
    accessState: 'AVAILABLE_REQUIRES_APPROVAL_AND_CLASSIFICATION',
    transport: 'REST_POLL',
    hosts: Object.freeze(['oauth.reddit.com', 'www.reddit.com']), // API host; OAuth token endpoint host
    streamPath: null,
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'REDDIT_CLIENT_ID', // + REDDIT_CLIENT_SECRET; a credential is NOT an approval
    implemented: true, // SOCIAL-3: fixture-only preview adapter + pure request/limit helpers (rumor2/social-reddit.js); NO live transport
    durable: false,
    runtimeGated: false, // no runtime exists that could open a live path by flipping fields
    retentionProhibited: true, // SOCIAL-3: no durable content / author-identifying journal until retention compatibility is reviewed
    highPriority: false,
    // separate questions, separate closed answers (§5) — none is inferred from another
    access: Object.freeze({
      platformPath: 'DOCUMENTED_OFFICIAL_PATH',
      useCaseClassification: 'UNRESOLVED',
      approvalStatus: 'NOT_VERIFIED',
      additionalAgreementRequirement: 'UNRESOLVED',
      retentionCompatibility: 'UNRESOLVED',
      liveStatus: 'DISABLED',
      durableContentAllowed: false,
      durableAuthorIdentityAllowed: false,
    }),
    // the truthful description Reddit must actually review (see doctrine/SOCIAL.md §5F)
    useCase: Object.freeze({ audience: 'PRIVATE_SINGLE_USER', offeredToCustomers: false, soldAsService: false, intendedUses: Object.freeze(['PERSONAL_RESEARCH', 'PAPER_TRADING', 'POSSIBLE_OWN_FUNDS_AUTOMATED_TRADING']), affiliationClaimed: 'NONE', classificationSource: 'REDDIT_USE_CASE_REVIEW', version: 'serpent-reddit-use-case-v1' }),
    // technical context only — NOT an entitlement and NOT proof this system qualifies for free access
    cost: Object.freeze({ model: 'QPM', freeEligibleQpmReference: 100, window: '10min-avg', entitlement: 'NOT_ESTABLISHED', reference: 'R5', observedOn: '2026-09-06' }),
    sources: Object.freeze([
      Object.freeze({ ref: 'R1', title: 'Responsible Builder Policy', url: 'https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy', accessedOn: '2026-09-06' }),
      Object.freeze({ ref: 'R2', title: 'Developer Platform & Accessing Reddit Data', url: 'https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data', accessedOn: '2026-09-06' }),
      Object.freeze({ ref: 'R3', title: 'Developer Terms (esp. 4.1)', url: 'https://redditinc.com/policies/developer-terms', accessedOn: '2026-09-06' }),
      Object.freeze({ ref: 'R4', title: 'Data API Terms (esp. 2.4, 3.1, 3.2, 6)', url: 'https://redditinc.com/policies/data-api-terms', accessedOn: '2026-09-06' }),
      Object.freeze({ ref: 'R5', title: 'Reddit Data API Wiki', url: 'https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki', accessedOn: '2026-09-06' }),
    ]),
    docUrl: 'https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data',
    reason: 'Official OAuth2 Data API exists (documented path); API data access requires explicit Reddit approval with honest disclosure of purpose and scope. Serpent is a private single-user personal project with intended personal research, paper trading, and possibly automated trading of the owner\'s own funds — its classification, any separate-agreement requirement, and retention compatibility are UNRESOLVED pending Reddit review. Scraping is prohibited. Fixture-only foundation; not an operational ear.',
  }),
  Object.freeze({
    id: 'STOCKTWITS_OFFICIAL',
    providerKind: 'SOCIAL_FINANCE',
    // SOCIAL-4B (corrected): ONE originating platform with several documented
    // routes/products. Self-service registration is paused (route-specific);
    // the Firestream routes are documented and need a stream-authorized
    // account; the applicable offering terms and this account's entitlement
    // are unresolved. NOT "docs offline", NOT blanket NOT_ACCEPTING_NEW_ACCESS.
    accessState: 'AVAILABLE_REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW',
    transport: 'FIRESTREAM_HTTP',
    hosts: ST.candidateDataHosts, // candidate DATA hosts — no host entry confers permission to send a request
    documentationHosts: ST.documentationHosts, // documentation only; the portal is NOT the data stream
    streamPath: '/stream', // FIRESTREAM_MESSAGES (documented; not implemented here)
    subprotocol: null,
    requiresCredential: true,
    credentialEnv: 'STOCKTWITS_STREAM_USER', // + STOCKTWITS_STREAM_PASS (Firestream HTTP Basic); presence is not entitlement
    implemented: true, // the NEW Social foundation only: fixture-only Firestream preview + access summary (rumor2/social-stocktwits.js); NOT the legacy RUMINT ear, NOT a transport
    durable: false,
    runtimeGated: false, // no runtime exists that an environment flag could activate
    retentionProhibited: true, // SOCIAL-4B: the NEW raw Social path retains nothing until entitlement, permitted use, and retention are established
    highPriority: true, // a high-value intended ear — blocked by entitlement/terms review, not by importance
    routes: STOCKTWITS_ROUTES, // SELF_SERVE_REGISTRATION (paused) · LEGACY_SYMBOL_REST · FIRESTREAM_MESSAGES · FIRESTREAM_SYMBOL_ACTIVITY · FIRESTREAM_REFERENCE · FIRESTREAM_BACKUPS — routes, not six sources
    legacy: STOCKTWITS_LEGACY_RUMINT, // the EXISTING aggregate ear, described (reporting only, no authority bridge)
    access: Object.freeze({
      platformPath: 'DOCUMENTED_FIRESTREAM_PATH',
      useCaseClassification: 'UNRESOLVED',
      entitlementStatus: 'NOT_VERIFIED',
      additionalTermsRequirement: 'UNRESOLVED',
      retentionCompatibility: 'UNRESOLVED',
      liveStatus: 'DISABLED',
      durableContentAllowed: false,
      durableAuthorIdentityAllowed: false,
    }),
    useCase: STOCKTWITS_USE_CASE,
    sources: STOCKTWITS_SOURCES,
    docUrl: 'https://firestream-portal.stocktwits.com/documentation/stream',
    reason: 'One platform, several routes. Self-service registration is paused (S1, route-specific). Firestream message/activity/reference/backup routes are documented (S2-S6) for stream-authorized accounts under HTTP Basic; general Terms (S7, revised 2026-07-10) require authorized API/developer access and let offering-specific terms prevail. This account\'s entitlement, Serpent\'s permitted use, additional terms, and raw-content/author retention are UNRESOLVED. A legacy aggregate RUMINT ear exists separately (config-enabled; deployment unobserved; entitlement unresolved). New raw Social path: fixture-only, retention-blocked, not an operational ear.',
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
    // SOCIAL-4D census correction (first-party docs, 2026-09-06): routes have DIFFERENT
    // prerequisites and scopes; none is a firehose; latency is unmeasured; eligibility for THIS
    // project is NOT ESTABLISHED (no app, token, Page, professional account, or institutional
    // affiliation supplied). No application was made and none was denied. Utility is a hypothesis.
    routes: Object.freeze({
      PAGE_PUBLIC_CONTENT: 'public posts/comments of Pages the app does not manage; App Review + Business Verification (+ possible contracts); use limited to analysis/display',
      PAGE_PUBLIC_METADATA: 'Page metadata only — never feed or comments',
      MANAGED_PAGES: 'content of Pages the operator administers (Page permissions) — not platform listening',
      INSTAGRAM_LOGIN: 'own professional-account media/comments/mentions only',
      INSTAGRAM_FACEBOOK_LOGIN: 'own media + hashtag search (30 unique hashtags / 7 days) + business discovery; professional account + Page linkage + App Review; no realtime delivery documented',
      CONTENT_LIBRARY: 'FB/IG/Threads research archive in a controlled environment; academic or not-for-profit affiliation reviewed by a partner (CASD/ICPSR) — NOT ESTABLISHED FOR THIS PROJECT',
      AD_LIBRARY: 'archived ads only — promotion data, not organic evidence',
      GROUPS: 'Groups API deprecated (v19.0, removed 2024-04-22) — no sanctioned route',
    }),
    eligibilityForThisProject: 'NOT_ESTABLISHED', retention: 'UNRESOLVED_ROUTE_SPECIFIC_REVIEW_REQUIRED', latencyMeasured: false,
    // SOCIAL-4E foundation stage (pure, non-live): ten route descriptors in two namespaces (FACEBOOK /
    // INSTAGRAM — not checkpoint providers), route-bound readiness evaluators, and fixture-only Page-post /
    // Page-comment / Instagram-media previews. NOT operational access; `implemented: false` and
    // `durable: false` keep their meanings (no acquisition adapter into the shared contract, no durable truth).
    foundation: Object.freeze({ ticket: 'SOCIAL-4E', stage: 'DESCRIPTORS_READINESS_AND_FIXTURE_PREVIEWS', module: 'rumor2/social-meta.js', namespaces: Object.freeze(['FACEBOOK', 'INSTAGRAM']), fixtureOnly: true, live: false, durable: false, operationalAccess: false, docsAccessedOn: '2026-09-07', docsUnverified: Object.freeze(['COMMENT_MESSAGE_CREATED_TIME_FROM']) }),
    reason: 'Route-specific (SOCIAL-4D): Page Public Content Access reads public Page posts/comments only after Meta App Review + Business Verification; Page Public Metadata Access is metadata only; Instagram routes read an authorizing professional account (Instagram Login) or add capped hashtag search and business discovery (Facebook Login) with no realtime delivery documented; the Meta Content Library requires an academic/not-for-profit affiliation reviewed by a partner — not established for this project. No route is a firehose; latency is unmeasured; delete/retention and inference permissions need their own route-specific review. See doctrine/SOCIAL.md §2/§5H.',
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
    // SOCIAL-4D census correction (first-party docs, 2026-09-06): the CURRENT decision is
    // inactive because no authorized minutes-scale organic route is established on the supplied
    // facts. No application was made and none was denied; this is not a permanent exclusion
    // approved by the operator, and it classifies Serpent neither as commercial nor as exempt.
    currentDecision: 'INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED',
    decisionStatus: 'OPERATOR_REVIEW_PENDING',
    routes: Object.freeze({
      RESEARCH: 'Research Tools/API: affiliation with an eligible academic or not-for-profit institution, non-commercial public-interest research, ethics review, project approval — NOT ESTABLISHED FOR THIS PROJECT; on THIS route new videos take up to 48 h to enter search and some metrics up to 10 days to refresh (route-specific)',
      DISPLAY: 'Display API: the authorizing user\'s own videos only — not organic discovery',
      COMMERCIAL_CONTENT: 'Commercial Content API: paid ads, advertiser data, and other commercial content (EU data in this phase, open application) — an ad/commercial dataset, not the organic feed and not a classification of Serpent\'s use',
    }),
    docUrl: 'https://developers.tiktok.com/products/research-api/',
    // SOCIAL-4E foundation stage (pure, non-live): three product descriptors, product-bound readiness
    // evaluators, and a fixture-only Research/Display video preview (documented epoch seconds parsed only
    // as seconds; no identity from labels). The decision above is preserved unchanged. NOT operational access.
    foundation: Object.freeze({ ticket: 'SOCIAL-4E', stage: 'DESCRIPTORS_READINESS_AND_FIXTURE_PREVIEWS', module: 'rumor2/social-tiktok.js', credentialEnvs: Object.freeze(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']), fixtureOnly: true, live: false, durable: false, operationalAccess: false, docsAccessedOn: '2026-09-07', docsUnverified: Object.freeze(['COMMERCIAL_CONTENT_SCHEMA']) }),
    reason: 'Product-by-product (SOCIAL-4D): Research Tools require an eligible institutional affiliation and project approval this project has not supplied, and that route indexes new videos with up to 48 h delay; the Display API reads only an authorizing user\'s own videos; the Commercial Content API is an ads/commercial dataset. No appropriate authorized minutes-scale organic route is established on the supplied facts. Inactive; operator review of any permanent decision is pending.',
  }),
]);

export const SOCIAL_PROVIDER_IDS = Object.freeze(SOCIAL_PROVIDERS.map((p) => p.id));
export const socialProviderById = (id) => SOCIAL_PROVIDERS.find((p) => p.id === id) ?? null;

// Providers that are durably ACTIVE (write social truth into the event root now).
// Only these may join the checkpoint provider set (v4 retained; cursor in journal).
export const ACTIVE_SOCIAL_PROVIDER_IDS = Object.freeze(SOCIAL_PROVIDERS.filter((p) => p.durable).map((p) => p.id));

// Structural invariants — asserted by tests too, so drift is caught.
for (const p of SOCIAL_PROVIDERS) {
  if (!SOCIAL_ACCESS_STATES.includes(p.accessState)) throw new Error(`social-registry: ${p.id} has an unknown accessState`);
  // SOCIAL-3: the registry flag and the closed code constant must agree, and a
  // retention-prohibited provider can never be durable, live, or content-allowed
  const prohibited = SOCIAL_RETENTION_PROHIBITED_PROVIDERS.includes(p.id);
  if (prohibited !== (p.retentionProhibited === true)) throw new Error(`social-registry: ${p.id} retentionProhibited disagrees with SOCIAL_RETENTION_PROHIBITED_PROVIDERS`);
  if (prohibited && (p.durable || p.access?.durableContentAllowed !== false || p.access?.durableAuthorIdentityAllowed !== false || p.access?.liveStatus !== 'DISABLED')) throw new Error(`social-registry: ${p.id} is retention-prohibited but claims durable/live capability`);
  if (!SOCIAL_PROVIDER_KINDS.includes(p.providerKind)) throw new Error(`social-registry: ${p.id} has a non-social providerKind`);
  if (p.durable && !isPlatformCapable(p.accessState)) throw new Error(`social-registry: ${p.id} is durable but the platform is not capable`);
  if (p.durable && !isLiveActivatable(p.accessState) && p.runtimeGated !== true) throw new Error(`social-registry: ${p.id} needs a credential — it must be runtime-gated`);
}
