#!/usr/bin/env node
// One-shot commissioning check for the existing WideEye -> RUMOR2 -> Neynar path.
// It performs one public catalog request and at most ONE Neynar Search Casts request,
// writes through the existing durable RUMOR2 journal, starts no timer, and holds no
// PAPER, trading, wallet, signing, posting, or identity authority.
import { loadConfig } from '../lib/config.js';
import { startPersistence } from '../persistence/runtime.js';
import { rumor2JournalStore } from '../persistence/rumor2-journal.js';
import { startWideEye } from '../survey/wideeye.js';
import { parseSocialResearchConfig, createResearchScopeSource } from '../rumor2/social-catalog.js'; import { createFarcasterRuntime, farcasterConfigFromEnv } from '../rumor2/social-farcaster-runtime.js';
import { FARCASTER_REQUEST_TYPE } from '../rumor2/social-farcaster-meter.js';
import { SOCIAL_OBSERVATION_TYPES } from '../rumor2/social-settle.js';

const log = (message) => process.stderr.write(`${String(message).slice(0, 300)}\n`);
const inertInterval = () => ({ unref() { }, refresh() { } });
const approval = Object.freeze({
  approvalRef: 'neynar-support-email-2026-09-12T16:39:00-04:00',
  // These closed identifiers are deliberately supplied as audited account-record
  // data; the access boundary itself remains consumed only by the runtime.
  status: 'ATTESTED', application: 'SERPENT_PRIVATE_SINGLE_USER', useCaseVersion: 'serpent-farcaster-use-case-v1',
  plan: 'FREE', credits: 'AVAILABLE', termsReview: 'REVIEWED_PERMITS',
  permittedUses: ['RETRIEVAL', 'PERSONAL_RESEARCH', 'DERIVED_FEATURES'],
  acquisitionPath: 'SEARCH_POLLING', acquisitionApproved: true,
  additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null,
  retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-12',
});

let persistence = null;
let wideEye = null;
let journal = null;
let runtime = null;
let writer = false;
try {
  if (typeof process.env.NEYNAR_API_KEY !== 'string' || process.env.NEYNAR_API_KEY.length === 0) throw new Error('NEYNAR_API_KEY is not present');
  const config = loadConfig();
  const researchCfg = parseSocialResearchConfig(config);
  if (!researchCfg.ok || researchCfg.research.localAdmission.mode !== 'CATALOG_BACKED') throw new Error(`catalog-backed research config required (${researchCfg.reason ?? researchCfg.research.localAdmission.mode})`);

  persistence = await startPersistence({ log });
  const health = persistence.health();
  if (!health.databaseConfigured || !health.restored) throw new Error(`durable journal unavailable (${health.failureCategory ?? health.status})`);
  journal = rumor2JournalStore();
  const acquired = await journal.acquireWriter();
  if (!acquired.ok) throw new Error(`RUMOR2 writer unavailable (${acquired.reason})`);
  writer = true;
  const before = await journal.read();
  if (!Array.isArray(before.events)) throw new Error(`durable journal read failed (${before.corrupt ?? before.unavailable ?? 'unknown'})`);

  wideEye = startWideEye({ config, log, setIntervalImpl: inertInterval, clearIntervalImpl: () => { }, setTimeoutImpl: () => null, clearTimeoutImpl: () => { }, registerSignals: false });
  if (!wideEye) throw new Error('WideEye is disabled');
  await wideEye._refreshCatalog();
  const catalog = wideEye.catalogSnapshot();
  if (catalog.status !== 'ACCEPTED' || !catalog.fresh || !catalog.catalog) throw new Error(`fresh accepted catalog unavailable (${catalog.lastError ?? catalog.status})`);
  const now = () => Date.now();
  const scopeSource = createResearchScopeSource({ research: researchCfg.research, source: { snapshot: () => wideEye.catalogSnapshot(), notices: () => wideEye.researchNotices() }, now });  // Use the normal installed account record and polling envelope. Only the
  // enable bit is overridden for this process. No timer is started.
  const commissioningEnv = { ...process.env, RUMOR2_SOCIAL_FARCASTER_ENABLED: 'true' };
  const commissioningConfig = farcasterConfigFromEnv(commissioningEnv);
  runtime = createFarcasterRuntime({
    env: commissioningEnv, now, scopeSource, fetchImpl: fetch, log, config: commissioningConfig,
  });
  const hydrated = runtime.hydrate(before.events); if (!hydrated.ok) throw new Error(`Farcaster hydrate failed (${hydrated.error})`);
  const beforeRequestsToday = runtime.status().quota.requests;

  const started = runtime.start();
  // A new catalog-backed installation must first journal its scope. The existing
  // runtime deliberately reports SCOPE_NOT_ACTIVE until settle() commits that
  // scope, then it opens the same ear under the held writer fence.
  if (!started.ok && started.reason !== 'SCOPE_NOT_ACTIVE') throw new Error(`Farcaster gate refused (${started.reason})`);
  const hooks = { fenceHeld: () => journal.writerHeld() === true, append: (events) => journal.append(events), lookup: (type, ids) => journal.hasEventIds(type, ids) };
  for (let i = 0; i < 6; i += 1) {
    const settled = await runtime.settle(hooks);
    if (!settled.ok) throw new Error(`Farcaster settle failed (${settled.reason})`);
    const state = runtime.status(); if (state.quota.requests === beforeRequestsToday + 1 && ['SEARCH_QUERY_EXHAUSTED', 'SEARCH_PAGE_PARTIAL', 'REQUEST_FAILED', 'PARSE_FAILED', 'ADMISSION_FAILED'].includes(state.coverage)) break;
  }

  const after = await journal.read();
  if (!Array.isArray(after.events)) throw new Error(`durable journal readback failed (${after.corrupt ?? after.unavailable ?? 'unknown'})`);
  const prior = new Set(before.events.map((event) => `${event.type}:${event.sourceEventId ?? ''}`));
  const fresh = after.events.filter((event) => !prior.has(`${event.type}:${event.sourceEventId ?? ''}`));
  const requests = fresh.filter((event) => event.type === FARCASTER_REQUEST_TYPE && event.provider === 'FARCASTER_OFFICIAL');
  const observations = fresh.filter((event) => SOCIAL_OBSERVATION_TYPES.includes(event.type) && event.provider === 'FARCASTER_OFFICIAL');
  const status = runtime.status();
  const ok = requests.length === 1 && ['SEARCH_QUERY_EXHAUSTED', 'SEARCH_PAGE_PARTIAL'].includes(status.coverage) && status.lastError === null;
  process.stdout.write(`${JSON.stringify({
    ok,
    command: 'farcaster-setup-smoke',
    paperStarted: false,
    continuousPollingStarted: false,
    authority: status.authority ?? 'NONE',
    catalog: { contentId: catalog.contentId, supported: catalog.counts?.supported ?? null }, request: { durableReceipts: requests.length, priorRequestsToday: beforeRequestsToday, requestsToday: status.quota.requests, dailyCap: status.quota.maxDailyRequests, resultLimit: status.quota.resultLimit, maximumCredits: status.quota.resultLimit * 10, coverage: status.coverage, lastError: status.lastError },
    fairScope: status.queryPolicy,
    durableObservations: observations.length,
  }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
} finally {
  if (runtime) runtime.stop();
  if (wideEye) wideEye.stop();
  if (writer && journal) await journal.releaseWriter();
  if (persistence) await persistence.stop();
}
