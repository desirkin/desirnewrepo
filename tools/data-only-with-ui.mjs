// Serpent DATA-ONLY deployment entry (`npm run data:only-ui`) — ONE process (runtime unification step 4, 2026-09-14).
// The two-process supervisor (collector child + separate ui/server.js child) is retired: this shim pins the DATA-ONLY
// safety posture — the same names tools/data-only-runtime.mjs pins, plus this deployment's attested Farcaster account
// facts — and then enters the one composition root, fly.js, which derives SERPENT_MODE=DATA_ONLY, runs the spine, and
// serves the cockpit IN-PROCESS after the persistence bootstrap (judgeRun stays null; the shell's data-only surface is
// read-only). The safety posture is established before any project module is evaluated.
delete process.env.COBRA_PROFILE;
Object.assign(process.env, {
  SERPENT_DATA_ONLY: 'true',
  JUDGE_ENABLED: 'false',
  JUDGE_ALLOW_PRIVATE: 'false',
  JUDGE_ALLOW_ORDERS: 'false',
  MARKET_RESEARCH_ENABLED: 'false',
  RUMINT_ENABLED: 'false',
  // Price/volume coverage is public Kraken data, not a paid X firehose. Paid X stays disabled during broad-market
  // rollout; existing caps are not authorization to create stream rules or consume the funded account.
  RUMOR2_SOCIAL_X_ENABLED: 'false',
  RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '100',
  RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS: '3000',
  RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD: '0.50',
  RUMOR2_SOCIAL_X_MAX_SESSION_POST_READS: '100',
  RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10',
  RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '35',
  RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID: 'serpent-x-smoke-2026-09-13-v1',
  RUMOR2_SOCIAL_FARCASTER_ENABLED: 'true',
  RUMOR2_SOCIAL_FARCASTER_QUERY_MODE: 'CATALOG_ROTATION',
  RUMOR2_SOCIAL_FARCASTER_MAX_DAILY_REQUESTS: '96',
  RUMOR2_SOCIAL_FARCASTER_RESULT_LIMIT: '10',
  RUMOR2_SOCIAL_FARCASTER_INTERVAL_SEC: '900',
  RUMOR2_SOCIAL_FARCASTER_ASSETS_PER_QUERY: '6',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_REF: 'neynar-support-email-2026-09-12T16:39:00-04:00',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_STATUS: 'ATTESTED',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_APPLICATION: 'SERPENT_PRIVATE_SINGLE_USER',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_USE_CASE_VERSION: 'serpent-farcaster-use-case-v1',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_PLAN: 'FREE',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_CREDITS: 'AVAILABLE',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_TERMS_REVIEW: 'REVIEWED_PERMITS',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_PERMITTED_USES: 'RETRIEVAL,PERSONAL_RESEARCH,DERIVED_FEATURES',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_ACQUISITION_PATH: 'SEARCH_POLLING',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_ACQUISITION_APPROVED: 'true',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_ADDITIONAL_AGREEMENT: 'NOT_REQUIRED',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_ADDITIONAL_AGREEMENT_SATISFIED: 'false',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_RETENTION_CONTENT: 'COMPATIBLE_REVIEWED',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_RETENTION_IDENTITY: 'COMPATIBLE_REVIEWED',
  RUMOR2_SOCIAL_FARCASTER_ACCOUNT_REVIEWED_ON: '2026-09-12',
  RUMOR2_SOCIAL_CURRENT_ENABLED: 'false',
  // YouTube is opt-in even in DATA-ONLY mode. Preserve only an exact explicit
  // enable; absent, malformed, or differently-cased values stay fail-closed.
  SOCIAL_VIDEO_ENABLED: process.env.SOCIAL_VIDEO_ENABLED === 'true' ? 'true' : 'false',
  RUMOR2_EDGAR_ENABLED: 'false',
  RUMOR2_OFAC_ENABLED: 'true',
});

await import('../fly.js');
