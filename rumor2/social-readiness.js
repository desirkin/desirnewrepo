// SOCIAL-7 §48 — the PROVIDER READINESS TRUTH MATRIX (pure). ONE machine-readable, bounded projection of
// operational readiness per provider / source family, derived from the EXISTING registry, the retention
// capability law, the live runtime statuses the collector already exposes, and (optionally) the existing
// access evaluators' results — never a second manually maintained registry, never a new legal conclusion,
// never new web/terms research. Readiness is operational truth: it is NOT evidence corroboration and NOT a
// trade permission. Nothing here flattens to one `implemented: true`; the tree wins over prose.
import { SOCIAL_PROVIDERS, socialProviderById } from './social-registry.js';
import { retentionCapability, SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER } from './social-research-profile.js';

export const READINESS_MATRIX_VERSION = 'social-readiness-matrix-2'; // -2: historical smoke and current activation are separate dimensions (LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE + RUNTIME_NOT_ACTIVE)
export const READINESS_STATES = Object.freeze(['OPERATIONAL_LIVE_PROVEN', 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', 'IMPLEMENTED_NOT_LIVE_SMOKED', 'READY_REQUIRES_EXPLICIT_PAID_SMOKE', 'AVAILABLE_REQUIRES_APPROVAL', 'FIXTURE_ONLY', 'ACCESS_UNRESOLVED', 'RETENTION_BLOCKED', 'NOT_CONFIGURED', 'DISABLED', 'UNAVAILABLE']);
export const READINESS_BLOCKERS = Object.freeze(['RETENTION_NOT_APPROVED', 'APPROVAL_NOT_OBTAINED', 'ENTITLEMENT_UNRESOLVED', 'TERMS_UNRESOLVED', 'CREDENTIAL_MISSING', 'BUDGET_NOT_CONFIGURED', 'PAID_SMOKE_NOT_PERFORMED', 'WATCH_SCOPE_NOT_CONFIGURED', 'TRANSPORT_NOT_IMPLEMENTED', 'NO_SANCTIONED_ROUTE', 'PLATFORM_DECISION_PENDING', 'RUNTIME_DISABLED', 'RUNTIME_WITHHELD', 'RUNTIME_NOT_ACTIVE', 'PRODUCTION_GATE_UNOBSERVED', 'EXTERNAL_VERIFICATION_DEFERRED', 'EVALUATION_CLOCK_UNAVAILABLE', 'DEPLOYMENT_UNOBSERVED', 'OTHER_EVALUATOR_BLOCKER']);
export const READINESS_LIVE_SMOKE_STATES = Object.freeze(['PERFORMED_PRIOR_SESSION', 'NOT_PERFORMED', 'NOT_APPLICABLE']);
export const READINESS_REPLAY_CAPABILITIES = Object.freeze(['JOURNAL_REPLAY', 'FIXTURE_REPLAY_ONLY', 'AGGREGATE_CHECKPOINT_ONLY', 'NONE']);
export const READINESS_ROW_KEYS = Object.freeze(['provider', 'family', 'foundationPresent', 'transportImplemented', 'accessState', 'entitlementOrApprovalState', 'retentionState', 'historicalReplayCapability', 'liveSmokeState', 'productionGateState', 'currentlyEnabledState', 'durableRawContentAllowed', 'durableAuthorIdentityAllowed', 'operationalEvidenceAvailable', 'statusKnownAtTs', 'latestVerifiedKnownAtTs', 'readiness', 'blockers', 'blockerDetail', 'basis', 'authority']);
// repository-known smoke facts (doctrine/SOCIAL.md §5B: one real Bluesky live smoke informed the clock law; §5D/§5E/§7:
// the authorized paid X smoke has NOT been performed) — status, never a new claim
export const PROVIDER_SMOKE_FACTS = Object.freeze({ BLUESKY_OFFICIAL: Object.freeze({ liveSmokeState: 'PERFORMED_PRIOR_SESSION', ref: 'doctrine/SOCIAL.md §5B' }), X_OFFICIAL: Object.freeze({ liveSmokeState: 'NOT_PERFORMED', ref: 'doctrine/SOCIAL.md §5D-§5E, §7' }) });
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const uniq = (xs) => [...new Set(xs)];
const WITHHELD_RUNTIME_STATES = Object.freeze(['WITHHELD', 'WITHHELD_GAP', 'STANDBY', 'BUDGET_STOPPED']);
const CONFIG_BLOCKERS = Object.freeze(['CREDENTIAL_MISSING', 'BUDGET_NOT_CONFIGURED', 'WATCH_SCOPE_NOT_CONFIGURED']);

// map an access evaluator's blocker string (its own vocabulary) onto the closed readiness blocker codes
export function closedBlocker(raw) {
  const s = String(raw);
  if (/^CLOCK_/.test(s)) return 'EVALUATION_CLOCK_UNAVAILABLE';
  if (/RETENTION/.test(s)) return 'RETENTION_NOT_APPROVED';
  if (/^APPROVAL_|PREREQUISITE_NOT_ATTESTED|ACQUISITION_PATH_NOT_APPROVED|RETRIEVAL_NOT_PERMITTED|AGREEMENT/.test(s)) return 'APPROVAL_NOT_OBTAINED';
  if (/^ENTITLEMENT_|PLAN_|CREDITS_|ACCESS_RECORD|ACCOUNT_RECORD|VALID_UNTIL/.test(s)) return 'ENTITLEMENT_UNRESOLVED';
  if (/TERMS/.test(s)) return 'TERMS_UNRESOLVED';
  if (/KEY_MISSING|CREDENTIAL/.test(s)) return 'CREDENTIAL_MISSING';
  if (/NO_SANCTIONED_ROUTE|ROUTE_UNKNOWN/.test(s)) return 'NO_SANCTIONED_ROUTE';
  return 'OTHER_EVALUATOR_BLOCKER';
}

// ONE provider row. `runtime` is the collector's live status object for that provider (null when the
// collector exposes none in this process); `evaluation` an existing access evaluator result (optional).
export function providerReadinessRow(providerId, { runtime = null, evaluation = null, knownAtTs = null } = {}) {
  const p = socialProviderById(providerId);
  if (!p) return null;
  const retention = retentionCapability(providerId);
  const blockers = []; const detail = [];
  const push = (code, why) => { if (READINESS_BLOCKERS.includes(code)) { blockers.push(code); if (why) detail.push(`${code}: ${String(why).slice(0, 140)}`); } };
  const transportImplemented = p.durable === true || typeof p.runtimeTransport === 'string'; // transport existence is separate from durable retention permission
  const foundationPresent = p.implemented === true || !!p.foundation;
  const rt = runtime && typeof runtime === 'object' ? runtime : null;
  const enabled = rt ? rt.enabled !== false && rt.state !== undefined : null;
  let entitlement = 'NOT_REQUIRED'; let gate = rt ? (rt.gate ?? (rt.state === 'ACTIVE' ? 'OPEN' : rt.state ?? 'UNOBSERVED')) : 'UNOBSERVED_IN_THIS_PROCESS';
  let currentlyEnabledState = rt ? (rt.enabled === false ? 'DISABLED' : rt.state ?? 'UNKNOWN') : 'UNOBSERVED_IN_THIS_PROCESS';
  let readiness; let operational = false; let replay = 'FIXTURE_REPLAY_ONLY';
  // HISTORICAL SMOKE — derived ONCE, BEFORE any disabled / withheld / current-gate branching, because a performed smoke is a
  // fact about the past and current enablement is a separate dimension. Bluesky keeps its repository-known fact (§5B). X starts
  // from its repository-known NOT_PERFORMED fact (§5D-§5E, §7) and is upgraded ONLY by the represented run's DURABLE completion:
  // smoke.status alone is `pendingSmokeTerminal` (a terminal awaiting append), and configured/ok flags, target counts, an ACTIVE
  // stream or a pending terminal never substitute for it. This API recovers no history a supplied runtime does not carry.
  const rtSmoke = rt && rt.smoke && typeof rt.smoke === 'object' ? rt.smoke : null;
  const durableSmokeComplete = rtSmoke !== null && rtSmoke.durableStatus === 'COMPLETE';
  let smoke = PROVIDER_SMOKE_FACTS[providerId]?.liveSmokeState ?? 'NOT_APPLICABLE';
  if (providerId === 'X_OFFICIAL' && durableSmokeComplete) smoke = 'PERFORMED_PRIOR_SESSION';
  const explicitGate = rt !== null && rt.gate !== undefined && rt.gate !== null; // a fixture/runtime that states its gate is believed; an absent gate stays unobserved
  if (evaluation && Array.isArray(evaluation.blockers)) for (const b of evaluation.blockers.slice(0, 16)) push(closedBlocker(b), b);
  if (rt?.gateReason) push(closedBlocker(rt.gateReason), rt.gateReason);
  if (p.retentionProhibited === true) {
    const approvalPath = /APPROVAL/.test(p.accessState); // the registry census names the path (approval + classification vs entitlement + terms review)
    entitlement = approvalPath ? 'REQUIRES_APPROVAL_AND_CLASSIFICATION' : 'REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW';
    push('RETENTION_NOT_APPROVED', 'durable content / author-identifying retention not approved'); push(approvalPath ? 'APPROVAL_NOT_OBTAINED' : 'ENTITLEMENT_UNRESOLVED', p.accessState); if (!transportImplemented) push('TRANSPORT_NOT_IMPLEMENTED', 'fixture-only preview adapter; no live transport');
    readiness = 'RETENTION_BLOCKED';
  } else if (!transportImplemented) {
    entitlement = p.accessState === 'AVAILABLE_REQUIRES_APP_REVIEW' ? 'REQUIRES_APP_REVIEW' : p.accessState === 'AVAILABLE_REQUIRES_CREDENTIAL' ? 'REQUIRES_CREDENTIAL_PLAN_AND_TERMS' : 'UNRESOLVED';
    push('TRANSPORT_NOT_IMPLEMENTED', p.foundation?.stage ?? 'no transport'); if (p.decisionStatus === 'OPERATOR_REVIEW_PENDING') push('PLATFORM_DECISION_PENDING', p.decisionStatus);
    if (p.accessState === 'AVAILABLE_REQUIRES_APP_REVIEW') push('APPROVAL_NOT_OBTAINED', 'platform app review not obtained'); if (Array.isArray(p.foundation?.docsUnverified) && p.foundation.docsUnverified.length) push('EXTERNAL_VERIFICATION_DEFERRED', p.foundation.docsUnverified.join(','));
    if (providerId === 'FARCASTER_OFFICIAL') { push('CREDENTIAL_MISSING', 'key presence is configuration, not entitlement'); push('ENTITLEMENT_UNRESOLVED', 'plan / credits / terms unknown'); }
    readiness = 'FIXTURE_ONLY';
  } else if (p.runtimeTransport) {
    // These bounded routes were added after the original fixture census. Their
    // existence does not change the registry's durable-retention capability.
    entitlement = providerId === 'META_PUBLIC' ? 'REQUIRES_APP_REVIEW' : 'REQUIRES_CREDENTIAL_PLAN_AND_TERMS';
    replay = 'NONE';
    if (!rt) { push('PRODUCTION_GATE_UNOBSERVED', 'bounded transport exists; no runtime status supplied'); readiness = 'ACCESS_UNRESOLVED'; }
    else if (rt.enabled === false) { push('RUNTIME_DISABLED', rt.gateDetail ?? 'runtime disabled'); readiness = 'DISABLED'; }
    else {
      // The original closed row describes durable research readiness. Keep its
      // retention boundary explicit even if a bounded current transport succeeds.
      push('RETENTION_NOT_APPROVED', 'bounded transport is implemented; durable research capability remains unavailable in the registry');
      readiness = 'RETENTION_BLOCKED';
    }
  } else if (providerId === 'X_OFFICIAL') {
    entitlement = 'PAY_PER_USE_CREDENTIAL_AND_BUDGET_REQUIRED'; replay = 'JOURNAL_REPLAY';
    // the paid smoke is owed exactly while the represented run has NOT durably completed — including while disabled or withheld
    if (!durableSmokeComplete) push('PAID_SMOKE_NOT_PERFORMED', PROVIDER_SMOKE_FACTS.X_OFFICIAL.ref);
    if (!rt) { push('PRODUCTION_GATE_UNOBSERVED', 'no X runtime status in this process'); readiness = 'IMPLEMENTED_NOT_LIVE_SMOKED'; }
    else if (rt.enabled === false) { push('RUNTIME_DISABLED', rt.gateDetail ?? 'RUMOR2_SOCIAL_X_ENABLED'); readiness = 'DISABLED'; }
    else {
      if (!rt.credentialPresent) push('CREDENTIAL_MISSING', 'X_BEARER_TOKEN');
      if (rt.gate && rt.gate !== 'OPEN' && /BUDGET/.test(rt.gate)) push('BUDGET_NOT_CONFIGURED', rt.gate);
      if (rt.watch && rt.watch.ok === false) push('WATCH_SCOPE_NOT_CONFIGURED', rt.watch.reason ?? rt.watch.mode);
      // PRECEDENCE: known withheld state, then configuration / gate / evaluator blockers, then active-vs-not and performed-vs-not.
      // A final label never overrides an already established blocker, and an unclassified runtime never defaults to operational.
      const configBlocked = blockers.some((b) => CONFIG_BLOCKERS.includes(b));
      if (WITHHELD_RUNTIME_STATES.includes(rt.state)) { push('RUNTIME_WITHHELD', rt.state); readiness = 'UNAVAILABLE'; }
      else if (configBlocked) readiness = 'NOT_CONFIGURED';
      else if (explicitGate && rt.gate !== 'OPEN') { push('RUNTIME_WITHHELD', `production gate ${String(rt.gate).slice(0, 60)}`); readiness = 'UNAVAILABLE'; }
      else if (rt.state !== 'ACTIVE' && durableSmokeComplete) { push('RUNTIME_NOT_ACTIVE', rt.state ?? 'unknown'); readiness = 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE'; }
      else if (!durableSmokeComplete) readiness = 'READY_REQUIRES_EXPLICIT_PAID_SMOKE'; // ACTIVE or not, an unproven paid smoke is still owed
      else if (gate !== 'OPEN') { push('RUNTIME_WITHHELD', `production gate ${String(gate).slice(0, 60)}`); readiness = 'UNAVAILABLE'; }
      else if (blockers.length > 0) readiness = 'UNAVAILABLE'; // an access-evaluator blocker keeps its own code and still prevents an operational label
      else { readiness = 'OPERATIONAL_LIVE_PROVEN'; operational = true; }
    }
  } else { // BLUESKY_OFFICIAL — the authorized, live-smoked, durable ear. Its ONE real prior smoke (§5B) is never erased by a
    // disabled, withheld or merely-hydrated runtime: those describe CURRENT activation, a separate dimension from smoke history.
    replay = 'JOURNAL_REPLAY';
    const evidence = () => (rt?.durableIndexSize ?? 0) > 0;
    if (!rt) { push('PRODUCTION_GATE_UNOBSERVED', 'no Bluesky runtime status in this process'); readiness = 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE'; }
    else if (rt.enabled === false) { push('RUNTIME_DISABLED', rt.gateDetail ?? 'RUMOR2_SOCIAL_BLUESKY_ENABLED'); readiness = 'DISABLED'; }
    else if (rt.state === 'ACTIVE') { // ACTIVE = the runtime holds a connected stream in THIS process under its gates
      operational = evidence();
      if (gate !== 'OPEN') { push('RUNTIME_WITHHELD', `production gate ${String(gate).slice(0, 60)}`); readiness = 'UNAVAILABLE'; }
      else if (blockers.length > 0) readiness = 'UNAVAILABLE';
      else readiness = 'OPERATIONAL_LIVE_PROVEN';
    } else if (rt.state === 'HYDRATED' || rt.state === 'DARK') {
      operational = evidence();
      if (!explicitGate) { push('PRODUCTION_GATE_UNOBSERVED', `runtime ${rt.state} (not yet connected in this process)`); readiness = 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE'; } // no gate was supplied: neither OPEN nor closed is invented
      else if (rt.gate === 'OPEN') { push('RUNTIME_NOT_ACTIVE', rt.state); readiness = 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE'; } // an explicitly OPEN gate is a true fact about the gate, not about activation
      else { push('RUNTIME_WITHHELD', `production gate ${String(rt.gate).slice(0, 60)}`); readiness = 'UNAVAILABLE'; }
    } else { push('RUNTIME_WITHHELD', rt.state ?? 'unknown'); readiness = 'UNAVAILABLE'; operational = evidence(); }
  }
  return deepFreeze({
    provider: providerId, family: p.providerKind, foundationPresent, transportImplemented, accessState: p.accessState, entitlementOrApprovalState: entitlement, retentionState: retention.state, historicalReplayCapability: replay,
    liveSmokeState: smoke, productionGateState: gate, currentlyEnabledState, durableRawContentAllowed: p.retentionProhibited === true ? false : p.durable === true, durableAuthorIdentityAllowed: p.retentionProhibited === true ? false : p.durable === true, operationalEvidenceAvailable: operational,
    statusKnownAtTs: isTs(knownAtTs) ? knownAtTs : null, latestVerifiedKnownAtTs: evaluation && isTs(evaluation.evaluatedAtTs) ? evaluation.evaluatedAtTs : null,
    readiness, blockers: uniq(blockers).sort(), blockerDetail: uniq(detail).slice(0, 16), basis: `registry accessState ${p.accessState}; retention ${retention.state}; runtime ${rt ? (rt.state ?? 'unknown') : 'unobserved'}${evaluation ? '; access evaluator' : ''}`, authority: 'NONE',
  });
}

// the legacy aggregate RUMINT path is a separate source family (aggregate-only; never per-author)
export function legacyAggregateReadinessRow({ knownAtTs = null, configured = null } = {}) {
  const retention = retentionCapability(SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER);
  return deepFreeze({ provider: SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER, family: 'AGGREGATE_RUMINT', foundationPresent: true, transportImplemented: true, accessState: 'AVAILABLE_REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW', entitlementOrApprovalState: 'ROUTE_ENTITLEMENT_UNRESOLVED', retentionState: retention.state, historicalReplayCapability: 'AGGREGATE_CHECKPOINT_ONLY', liveSmokeState: 'NOT_APPLICABLE', productionGateState: configured === null ? 'UNOBSERVED_IN_THIS_PROCESS' : configured ? 'CONFIG_ENABLED' : 'CONFIG_DISABLED', currentlyEnabledState: configured === null ? 'UNOBSERVED_IN_THIS_PROCESS' : configured ? 'ENABLED' : 'DISABLED', durableRawContentAllowed: false, durableAuthorIdentityAllowed: false, operationalEvidenceAvailable: false, statusKnownAtTs: isTs(knownAtTs) ? knownAtTs : null, latestVerifiedKnownAtTs: null, readiness: 'ACCESS_UNRESOLVED', blockers: ['DEPLOYMENT_UNOBSERVED', 'ENTITLEMENT_UNRESOLVED'], blockerDetail: ['ENTITLEMENT_UNRESOLVED: route entitlement unresolved (doctrine §5G)', 'DEPLOYMENT_UNOBSERVED: deployment unobserved here'], basis: 'legacy aggregate RUMINT poller (rumint/) — aggregate history only; never converted into per-author profiles', authority: 'NONE' });
}

// closed-row law: every row carries exactly the readiness keys, a closed readiness state, closed blocker codes and authority NONE
export function validateReadinessRow(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'readiness row: not an object';
  const keys = Object.keys(r).sort(); const want = [...READINESS_ROW_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return 'readiness row: keys are not the closed readiness keys';
  if (!READINESS_STATES.includes(r.readiness)) return `readiness row: ${r.provider} readiness ${r.readiness} is not a closed state`;
  if (!Array.isArray(r.blockers) || r.blockers.some((b) => !READINESS_BLOCKERS.includes(b))) return `readiness row: ${r.provider} carries a blocker outside the closed codes`;
  if (r.readiness !== 'OPERATIONAL_LIVE_PROVEN' && r.blockers.length === 0) return `readiness row: ${r.provider} is not operational yet names no blocker`;
  if (r.readiness === 'OPERATIONAL_LIVE_PROVEN' && r.blockers.length > 0) return `readiness row: ${r.provider} is called operational while blocked`;
  if (!READINESS_LIVE_SMOKE_STATES.includes(r.liveSmokeState) || !READINESS_REPLAY_CAPABILITIES.includes(r.historicalReplayCapability)) return `readiness row: ${r.provider} smoke / replay state is not closed`;
  // SMOKE-HISTORY vs CURRENT-ACTIVATION implications (explicit, never a substring trick). DISABLED / UNAVAILABLE /
  // NOT_CONFIGURED may each coexist with a performed smoke, and an OPEN configuration gate may coexist with enabled=false:
  // current enablement is a separate dimension and is not denied here. operationalEvidenceAvailable is likewise NOT asserted
  // to imply ACTIVE — retained durable evidence survives a hydrated or withheld runtime, and an ACTIVE runtime may hold none.
  if (r.readiness === 'IMPLEMENTED_NOT_LIVE_SMOKED' && r.liveSmokeState !== 'NOT_PERFORMED') return `readiness row: ${r.provider} is called not-live-smoked while its smoke state is ${r.liveSmokeState}`;
  if (r.readiness === 'READY_REQUIRES_EXPLICIT_PAID_SMOKE') {
    if (r.provider !== 'X_OFFICIAL') return `readiness row: ${r.provider} is not the pay-per-use ear and cannot require an explicit paid smoke`;
    if (r.liveSmokeState !== 'NOT_PERFORMED') return `readiness row: ${r.provider} requires a paid smoke while recording one as performed`;
    if (!r.blockers.includes('PAID_SMOKE_NOT_PERFORMED')) return `readiness row: ${r.provider} requires a paid smoke yet names no PAID_SMOKE_NOT_PERFORMED blocker`;
  }
  if (r.readiness === 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE') {
    if (r.liveSmokeState !== 'PERFORMED_PRIOR_SESSION') return `readiness row: ${r.provider} claims a live-smoked history while its smoke state is ${r.liveSmokeState}`;
    if (r.currentlyEnabledState === 'ACTIVE') return `readiness row: ${r.provider} is currently ACTIVE and is not merely live-smoked-without-current-proof`;
  }
  if (r.readiness === 'OPERATIONAL_LIVE_PROVEN') {
    if (r.transportImplemented !== true) return `readiness row: ${r.provider} is called operational without an implemented transport`;
    if (r.liveSmokeState !== 'PERFORMED_PRIOR_SESSION') return `readiness row: ${r.provider} is called operational while its smoke state is ${r.liveSmokeState}`;
    if (r.currentlyEnabledState !== 'ACTIVE') return `readiness row: ${r.provider} is called operational while its runtime is ${r.currentlyEnabledState}`;
    if (r.productionGateState !== 'OPEN') return `readiness row: ${r.provider} is called operational while its production gate is ${r.productionGateState}`;
  }
  if (r.blockers.includes('PAID_SMOKE_NOT_PERFORMED') && r.liveSmokeState === 'PERFORMED_PRIOR_SESSION') return `readiness row: ${r.provider} names a missing paid smoke while recording one as performed`;
  if (r.authority !== 'NONE') return `readiness row: ${r.provider} authority must be NONE`;
  if ('implemented' in r) return 'readiness row: a single implemented flag is refused (readiness never flattens)';
  return null;
}

export function readinessMatrix({ runtimes = {}, evaluations = {}, knownAtTs = null, legacyAggregateConfigured = null } = {}) {
  const providers = SOCIAL_PROVIDERS.map((p) => providerReadinessRow(p.id, { runtime: runtimes[p.id] ?? null, evaluation: evaluations[p.id] ?? null, knownAtTs }));
  const rows = [...providers, legacyAggregateReadinessRow({ knownAtTs, configured: legacyAggregateConfigured })];
  const counts = {}; for (const r of rows) counts[r.readiness] = (counts[r.readiness] ?? 0) + 1;
  return deepFreeze({ version: READINESS_MATRIX_VERSION, knownAtTs: isTs(knownAtTs) ? knownAtTs : null, providers: rows, counts, operationalProviders: rows.filter((r) => r.readiness === 'OPERATIONAL_LIVE_PROVEN').map((r) => r.provider), authority: 'NONE', purpose: 'OPERATIONAL_STATUS_ONLY', note: 'readiness is operational truth — never evidence corroboration, never a trade permission; external access / terms / entitlement verification stays deferred and is listed as a blocker, never assumed' });
}

// Meta's registry family contains two independent routes. Neither route may
// stand in for the other; retain both states in the family status description.
export function currentReadinessRuntimes(current) {
  const off = { enabled: false, state: 'DARK' };
  const source = id => {
    if (current?.enabled === false || !current) return off;
    const value = current.sources?.[id] ?? off;
    return current.state === 'DARK' ? { ...value, state: 'DARK' } : value;
  };
  const facebook = source('META_FACEBOOK'), instagram = source('META_INSTAGRAM');
  return {
    REDDIT_OFFICIAL: source('REDDIT_OFFICIAL'),
    STOCKTWITS_OFFICIAL: source('STOCKTWITS_OFFICIAL'),
    META_PUBLIC: { enabled: facebook.enabled !== false || instagram.enabled !== false,
      state: `FACEBOOK:${facebook.state};INSTAGRAM:${instagram.state}`,
      gateReason: [facebook.gateReason, instagram.gateReason].filter(Boolean).join(';') || null },
  };
}
