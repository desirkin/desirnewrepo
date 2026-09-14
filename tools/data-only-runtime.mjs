// Serpent DATA-ONLY composition root. This file deliberately does not import
// fly.js, Tape, Paper, Judge, Watch, execution, UI controls, or any order
// client. It collects and stores observations only.
import path from 'node:path';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// Establish the safety posture before any project module is evaluated.
delete process.env.COBRA_PROFILE;
Object.assign(process.env, {
  SERPENT_DATA_ONLY: 'true',
  JUDGE_ENABLED: 'false',
  JUDGE_ALLOW_PRIVATE: 'false',
  JUDGE_ALLOW_ORDERS: 'false',
  MARKET_RESEARCH_ENABLED: 'false',
  RUMINT_ENABLED: 'false',
  // Paid X stays disabled during broad-market rollout; existing caps are not
  // authorization to create stream rules or consume the funded account.
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
  RUMOR2_SOCIAL_CURRENT_ENABLED: 'false',
  // YouTube is opt-in even in DATA-ONLY mode. Preserve only an exact explicit
  // enable; absent, malformed, or differently-cased values stay fail-closed.
  SOCIAL_VIDEO_ENABLED: process.env.SOCIAL_VIDEO_ENABLED === 'true' ? 'true' : 'false',
  RUMOR2_EDGAR_ENABLED: 'false',
  RUMOR2_OFAC_ENABLED: 'true',
});


// Everything after the pins lives in lib/serpent-runtime.js (runtime unification step 1). The dynamic import keeps the
// ordering law: no project module is evaluated before the safety posture above is established.
const { startDataOnlyRuntime } = await import('../lib/serpent-runtime.js');
await startDataOnlyRuntime();
