// Supervise the existing data-only collector and read-only web UI as separate
// processes. Neither runtime is modified or imported into the other.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const safetyEnv = {
  ...process.env,
  COBRA_PROFILE: '',
  SERPENT_DATA_ONLY: 'true',
  JUDGE_ENABLED: 'false',
  JUDGE_ALLOW_PRIVATE: 'false',
  JUDGE_ALLOW_ORDERS: 'false',
  MARKET_RESEARCH_ENABLED: 'false',
  RUMINT_ENABLED: 'false',
  // Price/volume coverage is public Kraken data, not a paid X firehose.
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
  // Preserve only an exact operator/deployment opt-in. The collector still
  // enforces the key, query-scope, and explicit daily-quota gates itself.
  SOCIAL_VIDEO_ENABLED: process.env.SOCIAL_VIDEO_ENABLED === 'true' ? 'true' : 'false',
  RUMOR2_EDGAR_ENABLED: 'false',
};


const children = new Map();
let shuttingDown = false;
let terminalExitCode = null;
// Rumor2 has a bounded 30 s official-feed request and market closeout can use
// its own 10 s drain before persisting unresolved accounting and sealing.
const SHUTDOWN_GRACE_MS = 60_000;


function start(name, file) {
  const child = spawn(process.execPath, [file], {
    env: safetyEnv,
    stdio: 'inherit',
  });
  children.set(name, child);
  return child;
}


function stopChildren(signal = 'SIGTERM') {
  for (const child of children.values()) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}


function finishWhenStopped(exitCode) {
  if ([...children.values()].some((child) => child.exitCode === null && child.signalCode === null)) return;
  process.exit(exitCode);
}


function handleExit(name, code, signal) {
  children.delete(name);
  if (shuttingDown) {
    if (children.size === 0) process.exit(terminalExitCode ?? 0);
    return;
  }


  shuttingDown = true;
  const exitCode = Number.isInteger(code) && code !== 0 ? code : 1;
  terminalExitCode = exitCode;
  console.error(`[DATA-ONLY SUPERVISOR] ${name} exited unexpectedly (${signal ?? `code ${code}`}); stopping sibling process`);
  stopChildren();
  if (children.size === 0) process.exit(exitCode);
  for (const child of children.values()) child.once('exit', () => finishWhenStopped(exitCode));
  setTimeout(() => {
    stopChildren('SIGKILL');
    process.exit(exitCode);
  }, SHUTDOWN_GRACE_MS).unref();
}


const collector = start('collector', fileURLToPath(new URL('./data-only-runtime.mjs', import.meta.url)));
const ui = start('ui', fileURLToPath(new URL('../ui/server.js', import.meta.url)));


collector.once('exit', (code, signal) => handleExit('collector', code, signal));
ui.once('exit', (code, signal) => handleExit('ui', code, signal));


for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shuttingDown = true;
    terminalExitCode ??= 0;
    stopChildren(signal);
    if (children.size === 0) process.exit(0);
    for (const child of children.values()) {
      child.once('exit', () => {
        if ([...children.values()].every((entry) => entry.exitCode !== null || entry.signalCode !== null)) process.exit(0);
      });
    }
    setTimeout(() => {
      stopChildren('SIGKILL');
      process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
  });
}
