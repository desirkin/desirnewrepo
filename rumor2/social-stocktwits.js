// SOCIAL-4B — StockTwits: ROUTE-SPECIFIC INVENTORY TRUTH + ENTITLEMENT-GATED
// ACCESS SUMMARY + FIXTURE-ONLY FIRESTREAM MESSAGE PREVIEW.
//
// This module is pure. It performs NO network call, NO credential exchange, NO
// stream, NO archive download, NO legacy poll, NO timer, NO filesystem or
// database access, NO model call. It cannot become live by flipping a field:
// there is no transport here to flip on. It is NOT a second collector.
//
// TWO DIFFERENT THINGS EXIST FOR STOCKTWITS (doctrine/SOCIAL.md §5G):
//   1. The LEGACY aggregate RUMINT ear (rumint/*): config-enabled in the
//      committed cobra.config.json, overridable by RUMINT_ENABLED, polling the
//      legacy symbol REST route into hourly statistics with a bounded message-id
//      cache and NO stored post bodies or author profiles. Its documented
//      nomination (stalk set) and canonical HYPED outputs are preserved
//      exactly. Deployment state is UNOBSERVED; its route entitlement is
//      UNRESOLVED. This module neither switches it on nor endorses it.
//   2. The NEW raw Social path (this foundation): fixture-only preview, zero
//      nomination/attention/HYPED/claim/order/execution output, zero durable
//      retention (SOCIAL_RETENTION_PROHIBITED_PROVIDERS in rumor2/social.js).
//
// Serpent is a private single-user personal prototype — not sold or offered to
// customers; personal research, autonomous paper trading, possibly later
// automated trading of the owner's own funds; no claimed affiliation. Its
// classification under the applicable StockTwits offering is UNRESOLVED:
// neither commercial nor exempt is assumed.
import { classifySourceClock, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_TEXT_CHARS, MAX_SOCIAL_HANDLE_CHARS } from './social.js';

export const STOCKTWITS_OFFICIAL = Object.freeze({
  id: 'STOCKTWITS_OFFICIAL',
  providerKind: 'SOCIAL_FINANCE',
  organization: 'STOCKTWITS',
  // documentation hosts are NOT data hosts; no host entry confers permission to send a request
  documentationHosts: Object.freeze(['firestream-portal.stocktwits.com', 'api.stocktwits.com', 'stocktwits.com']),
  candidateDataHosts: Object.freeze(['firestream.stocktwits.com', 'api.stocktwits.com']),
  credentialEnvs: Object.freeze(['STOCKTWITS_STREAM_USER', 'STOCKTWITS_STREAM_PASS']), // NAMES only (Firestream HTTP Basic); presence is not entitlement
  sourcesAccessedOn: '2026-09-06',
});

export const STOCKTWITS_FOUNDATION = Object.freeze({ fixtureOnly: true, liveTransport: false, credentialExchange: false, streamClient: false, archiveDownloader: false, legacyPoller: false, pollingLoop: false, resumeCursor: false, sseFraming: false, filesystem: false, database: false, modelCalls: false, secondCollector: false });

// ---- routes / products — ONE originating platform, six delivery routes ----------
export const STOCKTWITS_ROUTE_IDS = Object.freeze(['SELF_SERVE_REGISTRATION', 'LEGACY_SYMBOL_REST', 'FIRESTREAM_MESSAGES', 'FIRESTREAM_SYMBOL_ACTIVITY', 'FIRESTREAM_REFERENCE', 'FIRESTREAM_BACKUPS']);
export const STOCKTWITS_ROUTES = Object.freeze({
  SELF_SERVE_REGISTRATION: Object.freeze({ kind: 'REGISTRATION', host: 'api.stocktwits.com', path: '/developers', status: 'PAUSED', statement: 'new registrations paused pending review (S1); does not establish revocation of existing entitlements or unavailability of other products', source: 'S1' }),
  LEGACY_SYMBOL_REST: Object.freeze({ kind: 'DATA', host: 'api.stocktwits.com', path: '/api/2/streams/symbol/<symbol>.json', delivers: 'MESSAGE_PAGES', usedBy: 'LEGACY_RUMINT', documentation: 'UNVERIFIED_IN_THIS_ENVIRONMENT', entitlement: 'UNRESOLVED', permittedUse: 'UNRESOLVED', source: null }),
  FIRESTREAM_MESSAGES: Object.freeze({ kind: 'DATA', host: 'firestream.stocktwits.com', path: '/stream', delivers: 'MESSAGE_LIFECYCLE_ENVELOPES', envelope: Object.freeze(['object', 'action', 'data', 'time', 'seq_id']), objects: Object.freeze(['Message', 'Friendship', 'Block', 'LikeMessage']), actions: Object.freeze(['create', 'destroy']), resume: 'seq_id (opaque string; recovery up to 24 hours, not unconditional replay)', auth: 'HTTP_BASIC_STREAM_AUTHORIZED_ACCOUNT', completeness: 'UNSTATED', editSemantics: 'UNRESOLVED', deletionDelivery: 'DESTROY_SIGNAL_DOCUMENTED_COMPLETENESS_UNPROVEN', entitlement: 'UNRESOLVED', source: 'S3' }),
  FIRESTREAM_SYMBOL_ACTIVITY: Object.freeze({ kind: 'DATA', host: 'firestream.stocktwits.com', path: '/symbols/stream', delivers: 'ACTIVITY_EVENTS_NOT_MESSAGES', note: 'activity metrics (pageview/watchlist/message/like) are not originating posts and not corroboration', entitlement: 'UNRESOLVED', source: 'S5' }),
  FIRESTREAM_REFERENCE: Object.freeze({ kind: 'REFERENCE', host: 'firestream.stocktwits.com', path: '/symbols/reference.{csv,json}', delivers: 'CURRENT_STATE_SYMBOL_SNAPSHOT', historical: false, note: 'a current snapshot; never used to improve an earlier observation retroactively', entitlement: 'UNRESOLVED', source: 'S4' }),
  FIRESTREAM_BACKUPS: Object.freeze({ kind: 'ARCHIVE', host: 'firestream.stocktwits.com', path: '/backups/{activity|message}/{y}/{m}/{d}', delivers: 'DAILY_GZIP_NDJSON', seqIdPresent: false, completeness: 'UNSTATED', lifecycleCoverage: 'UNSTATED', messageIdEquivalence: 'UNVERIFIED', entitlement: 'UNRESOLVED', source: 'S6' }),
});

// ---- the LEGACY aggregate ear, described (reporting only; NO imports of rumint/state/ui/persistence) ----
export const STOCKTWITS_LEGACY_RUMINT = Object.freeze({
  subsystem: 'RUMINT',
  present: true,
  route: 'LEGACY_SYMBOL_REST',
  committedConfigEnabled: true, // cobra.config.json rumint.enabled
  environmentOverride: 'RUMINT_ENABLED', // when defined it wins (rumint/stocktwits.js)
  aggregateDurability: 'PRESENT', // durable checkpoint + poll evidence mirrored to Memory
  storesRawText: false,
  storesAuthorProfiles: false,
  storesMessageIds: 'BOUNDED_RECENT_SEEN_CACHE', // identifiers are not permission-free merely because text is discarded
  deploymentState: 'UNOBSERVED',
  accessEntitlement: 'UNRESOLVED',
  implementationChanged: false,
  legacyOutputs: 'STATISTICAL_PER_RUMINT_DOCTRINE', // documented in doctrine/SOCIAL.md §5G, preserved, NOT inherited by the new raw Social path
  inheritedByNewSocial: false,
  status: 'CONFIG_ENABLED_LEGACY_IMPLEMENTATION_DEPLOYED_STATE_UNOBSERVED',
});

// ---- documentation sources (short paraphrase; retrieved 2026-09-06) --------------
export const STOCKTWITS_SOURCES = Object.freeze([
  Object.freeze({ ref: 'S1', title: 'Self-service registration notice', url: 'https://api.stocktwits.com/developers', accessedOn: '2026-09-06', supports: 'new registrations paused pending review; contact by email', uncertainty: 'silent on existing entitlements, other products, pricing, terms' }),
  Object.freeze({ ref: 'S2', title: 'Firestream portal index', url: 'https://firestream-portal.stocktwits.com/', accessedOn: '2026-09-06', supports: 'HTTP Basic with a stream-authorized StockTwits account', uncertainty: 'how authorization is obtained, pricing, terms not stated' }),
  Object.freeze({ ref: 'S3', title: 'Firestream message stream', url: 'https://firestream-portal.stocktwits.com/documentation/stream', accessedOn: '2026-09-06', supports: 'envelope {object, action create|destroy, data, time, seq_id}; Message/Friendship/Block/LikeMessage; seq_id opaque, 24h recovery; reshares{reshared_count,user_ids}; reshare_message; conversation{parent_message_id,in_reply_to_message_id,parent,replies}; entities.sentiment.basic', uncertainty: 'no completeness/SLA; destroy documented but complete deletion delivery unproven; edit semantics not documented' }),
  Object.freeze({ ref: 'S4', title: 'Firestream symbol reference', url: 'https://firestream-portal.stocktwits.com/documentation/symbols-reference', accessedOn: '2026-09-06', supports: 'symbol_id, ticker, exchange, country, asset_class, delisted (+isin/cusip); current-state snapshot, not historical', uncertainty: 'no point-in-time history' }),
  Object.freeze({ ref: 'S5', title: 'Firestream symbol activity stream', url: 'https://firestream-portal.stocktwits.com/documentation/symbols-stream', accessedOn: '2026-09-06', supports: 'activity events (pageview, watchlist add/remove, message, like) with seq_id', uncertainty: 'activity is not message content' }),
  Object.freeze({ ref: 'S6', title: 'Firestream backups', url: 'https://firestream-portal.stocktwits.com/documentation/backups', accessedOn: '2026-09-06', supports: 'daily gzip NDJSON by activity|message, 302 to a presigned link; seq_id absent', uncertainty: 'retention window, completeness, lifecycle coverage, id equivalence unstated' }),
  Object.freeze({ ref: 'S7', title: 'StockTwits Terms of Service (Last Revised July 10, 2026)', url: 'https://stocktwits.com/about/legal/terms/', accessedOn: '2026-09-06', supports: '§1 offering-specific additional terms prevail; §5 no unauthorized automated/scraping access, authorized APIs/developer offerings permitted; §8 users own content, platform holds a broad license and may license public content (incl. usernames where applicable) to institutions; deletion does not remove prior grants from backups/archives/deidentified datasets; §18 suspension/termination', uncertainty: 'general terms are not this account\'s Firestream entitlement nor a license for Serpent storage/inference; offering terms may control' }),
  Object.freeze({ ref: 'S8', title: 'StockTwits Privacy Policy (July 2026)', url: 'https://stocktwits.com/about/legal/privacy', accessedOn: '2026-09-06', supports: 'public content may be visible to API users/partners; platform retains as reasonably necessary; deletion requests via privacy contact', uncertainty: 'the platform\'s own retention never authorizes Serpent to retain the same data' }),
]);

// ---- private use, recorded (classification UNRESOLVED) ----------------------------
export const STOCKTWITS_APPLICATION_ID = 'SERPENT_PRIVATE_SINGLE_USER';
export const STOCKTWITS_USE_CASE_VERSION = 'serpent-stocktwits-use-case-v1';
export const STOCKTWITS_USE_CASE = Object.freeze({
  version: STOCKTWITS_USE_CASE_VERSION, application: STOCKTWITS_APPLICATION_ID, audience: 'PRIVATE_SINGLE_USER', offeredToCustomers: false, soldAsService: false,
  intendedUses: Object.freeze(['PERSONAL_RESEARCH', 'PAPER_TRADING', 'POSSIBLE_OWN_FUNDS_AUTOMATED_TRADING']), affiliationClaimed: 'NONE',
  classification: 'UNRESOLVED', classificationSource: 'APPLICABLE_STOCKTWITS_OFFERING_TERMS_AND_ENTITLEMENT_REVIEW',
});

// ---- closed access model — separate questions, separate answers ----------------
export const STOCKTWITS_ENTITLEMENT_STATES = Object.freeze(['NOT_VERIFIED', 'OPERATOR_ATTESTED', 'EXPIRED', 'REVOKED', 'DENIED', 'OUT_OF_SCOPE']);
export const STOCKTWITS_TERMS_STATES = Object.freeze(['UNRESOLVED', 'NOT_REQUIRED', 'REQUIRED_UNSATISFIED', 'REQUIRED_SATISFIED']);
export const STOCKTWITS_RETENTION_STATES = Object.freeze(['UNRESOLVED', 'COMPATIBLE_REVIEWED', 'INCOMPATIBLE']);
export const STOCKTWITS_PERMITTED_USES = Object.freeze(['RETRIEVAL', 'PERSONAL_RESEARCH', 'PAPER_TRADING', 'OWN_FUNDS_TRADING', 'DERIVED_FEATURES', 'MODEL_INFERENCE', 'MODEL_TRAINING', 'REDISTRIBUTION']);
export const STOCKTWITS_RECORD_STATUSES = Object.freeze(['ATTESTED', 'PENDING', 'DENIED', 'REVOKED']);
export const STOCKTWITS_RECORD_TERMS = Object.freeze(['NOT_REQUIRED', 'REQUIRED', 'UNRESOLVED']);
const REF_RE = /^[A-Za-z0-9._:/-]{1,120}$/;
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const CLOCK_MIN_MS = Date.parse('2000-01-01T00:00:00Z');
const CLOCK_MAX_MS = Date.parse('2200-01-01T00:00:00Z');
export const isSupportedClock = (ms) => Number.isSafeInteger(ms) && ms >= CLOCK_MIN_MS && ms <= CLOCK_MAX_MS;

// Bounded operator record from env-like input: labels, enums, dates only — never credentials, correspondence, account identity, or contract text.
export function stocktwitsAccessRecordFromEnv(env = process.env) {
  const p = 'RUMOR2_SOCIAL_STOCKTWITS_ACCESS_';
  const keys = ['REF', 'ROUTE', 'STATUS', 'APPLICATION', 'USE_CASE_VERSION', 'PERMITTED_USES', 'ADDITIONAL_TERMS', 'ADDITIONAL_TERMS_SATISFIED', 'VALID_UNTIL', 'RETENTION_COMPATIBILITY', 'REVIEWED_ON'];
  if (!keys.some((k) => typeof env?.[p + k] === 'string' && env[p + k].length > 0)) return null;
  const g = (k) => (typeof env?.[p + k] === 'string' && env[p + k].length > 0 ? env[p + k] : null);
  return { ref: g('REF'), route: g('ROUTE'), status: g('STATUS'), application: g('APPLICATION'), useCaseVersion: g('USE_CASE_VERSION'), permittedUses: csv(g('PERMITTED_USES')), additionalTerms: g('ADDITIONAL_TERMS') ?? 'UNRESOLVED', additionalTermsSatisfied: g('ADDITIONAL_TERMS_SATISFIED') === 'true', validUntil: g('VALID_UNTIL'), retentionCompatibility: g('RETENTION_COMPATIBILITY') ?? 'UNRESOLVED', reviewedOn: g('REVIEWED_ON') };
}

export function validateStocktwitsAccessRecord(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return 'access record: not an object';
  const allowed = ['ref', 'route', 'status', 'application', 'useCaseVersion', 'permittedUses', 'additionalTerms', 'additionalTermsSatisfied', 'validUntil', 'retentionCompatibility', 'reviewedOn'];
  for (const k of Object.keys(r)) if (!allowed.includes(k)) return `access record: undeclared field '${k}'`;
  if (r.ref !== null && r.ref !== undefined && (typeof r.ref !== 'string' || !REF_RE.test(r.ref))) return 'access record: ref must be a bounded reference label';
  if (!STOCKTWITS_ROUTE_IDS.includes(r.route) || STOCKTWITS_ROUTES[r.route].kind === 'REGISTRATION') return `access record: route must name a data/reference/archive route, got '${r.route}'`;
  if (!STOCKTWITS_RECORD_STATUSES.includes(r.status)) return `access record: unknown status '${r.status}'`;
  if (!isStr(r.application, 100) || !isStr(r.useCaseVersion, 100)) return 'access record: application/useCaseVersion missing';
  if (!Array.isArray(r.permittedUses) || r.permittedUses.length > STOCKTWITS_PERMITTED_USES.length || r.permittedUses.some((u) => !STOCKTWITS_PERMITTED_USES.includes(u))) return 'access record: permittedUses outside the closed vocabulary';
  if (!STOCKTWITS_RECORD_TERMS.includes(r.additionalTerms)) return `access record: unknown additionalTerms '${r.additionalTerms}'`;
  if (typeof r.additionalTermsSatisfied !== 'boolean') return 'access record: additionalTermsSatisfied must be boolean';
  if (r.validUntil !== null && r.validUntil !== undefined && (typeof r.validUntil !== 'string' || !Number.isFinite(Date.parse(r.validUntil)))) return 'access record: validUntil is not a parseable date';
  if (!STOCKTWITS_RETENTION_STATES.includes(r.retentionCompatibility)) return `access record: unknown retentionCompatibility '${r.retentionCompatibility}'`;
  if (r.reviewedOn !== null && r.reviewedOn !== undefined && (typeof r.reviewedOn !== 'string' || !Number.isFinite(Date.parse(r.reviewedOn)))) return 'access record: reviewedOn is not a parseable date';
  return null;
}

export function stocktwitsCredentialsPresent(env = process.env) {
  return STOCKTWITS_OFFICIAL.credentialEnvs.every((k) => typeof env?.[k] === 'string' && env[k].length > 0);
}

// READINESS LAW: every prerequisite true AND zero blockers; informational notes are
// advisories; the clock is an explicit validated input; even a fully permissive record
// leaves live/durable false — this foundation has no transport and no writer.
export function evaluateStocktwitsAccess({ record = null, env = process.env, nowMs = null, description = null } = {}) {
  const blockers = []; const advisories = [];
  const clockKnown = isSupportedClock(nowMs);
  if (!clockKnown) blockers.push(nowMs === null || nowMs === undefined ? 'CLOCK_UNAVAILABLE' : 'CLOCK_INVALID');
  const credentialPresent = stocktwitsCredentialsPresent(env);
  let entitlementStatus = 'NOT_VERIFIED'; let additionalTerms = 'UNRESOLVED'; let retentionCompatibility = 'UNRESOLVED'; let permittedUses = []; let route = null; let reviewOk = false;
  if (description !== null) advisories.push('SELF_DESCRIPTION_IS_NOT_PERMISSION');
  if (record === null) blockers.push('ACCESS_RECORD_MISSING');
  else {
    const err = validateStocktwitsAccessRecord(record);
    if (err) blockers.push(`ACCESS_RECORD_INVALID: ${err}`);
    else if (!clockKnown) { /* nothing time-dependent can be judged */ }
    else {
      route = record.route;
      const reviewedMs = record.reviewedOn ? Date.parse(record.reviewedOn) : null;
      reviewOk = reviewedMs === null || reviewedMs <= nowMs;
      if (!reviewOk) blockers.push('REVIEW_DATE_IN_FUTURE');
      const inScope = record.application === STOCKTWITS_APPLICATION_ID && record.useCaseVersion === STOCKTWITS_USE_CASE_VERSION;
      if (!inScope) { entitlementStatus = 'OUT_OF_SCOPE'; blockers.push('ENTITLEMENT_OUT_OF_SCOPE: the record covers another application or use-case version'); }
      else if (record.status === 'REVOKED') { entitlementStatus = 'REVOKED'; blockers.push('ENTITLEMENT_REVOKED'); }
      else if (record.status === 'DENIED') { entitlementStatus = 'DENIED'; blockers.push('ENTITLEMENT_DENIED'); }
      else if (record.status === 'PENDING') { blockers.push('ENTITLEMENT_PENDING'); }
      else if (record.status === 'ATTESTED') {
        const exp = record.validUntil ? Date.parse(record.validUntil) : null; // null = no supplied expiry, never invented
        if (exp !== null && !(nowMs < exp)) { entitlementStatus = 'EXPIRED'; blockers.push('ENTITLEMENT_EXPIRED'); }
        else if (!reviewOk) { /* stays NOT_VERIFIED */ }
        else { entitlementStatus = 'OPERATOR_ATTESTED'; permittedUses = [...record.permittedUses]; }
      }
      if (entitlementStatus === 'OPERATOR_ATTESTED') {
        additionalTerms = record.additionalTerms === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : record.additionalTerms === 'REQUIRED' ? (record.additionalTermsSatisfied ? 'REQUIRED_SATISFIED' : 'REQUIRED_UNSATISFIED') : 'UNRESOLVED';
        if (additionalTerms === 'REQUIRED_UNSATISFIED') blockers.push('ADDITIONAL_TERMS_REQUIRED_UNSATISFIED');
        if (additionalTerms === 'UNRESOLVED') blockers.push('ADDITIONAL_TERMS_UNRESOLVED');
        retentionCompatibility = record.retentionCompatibility;
        if (retentionCompatibility !== 'COMPATIBLE_REVIEWED') blockers.push(retentionCompatibility === 'INCOMPATIBLE' ? 'RETENTION_INCOMPATIBLE' : 'RETENTION_COMPATIBILITY_UNRESOLVED');
        if (!permittedUses.includes('RETRIEVAL')) blockers.push('RETRIEVAL_NOT_PERMITTED');
      }
    }
  }
  if (!credentialPresent) blockers.push('CREDENTIAL_MISSING');
  const prerequisites = Object.freeze({
    clock: clockKnown, review: clockKnown && record !== null && reviewOk, entitlement: entitlementStatus === 'OPERATOR_ATTESTED',
    terms: additionalTerms === 'NOT_REQUIRED' || additionalTerms === 'REQUIRED_SATISFIED', retention: retentionCompatibility === 'COMPATIBLE_REVIEWED', retrieval: permittedUses.includes('RETRIEVAL'), credential: credentialPresent,
  });
  const activationPrerequisitesMet = blockers.length === 0 && Object.values(prerequisites).every(Boolean);
  return Object.freeze({
    provider: STOCKTWITS_OFFICIAL.id, route, useCaseClassification: 'UNRESOLVED', entitlementStatus, additionalTerms, retentionCompatibility, credentialPresent,
    permittedUses: Object.freeze(permittedUses),
    downstream: Object.freeze({ inference: permittedUses.includes('MODEL_INFERENCE'), training: permittedUses.includes('MODEL_TRAINING'), derivedFeatures: permittedUses.includes('DERIVED_FEATURES'), redistribution: permittedUses.includes('REDISTRIBUTION') }),
    prerequisites, activationPrerequisitesMet,
    liveStatus: 'DISABLED', liveAllowed: false, liveReason: 'FOUNDATION_ONLY_NO_LIVE_PATH',
    durableContentAllowed: false, durableAuthorIdentityAllowed: false, durableReason: prerequisites.retention ? 'RETENTION_COMPATIBLE_DESIGN_NOT_IMPLEMENTED' : 'RETENTION_COMPATIBILITY_UNRESOLVED',
    transport: null, writer: null, evidence: 'OPERATOR_ATTESTATION_NOT_PLATFORM_PROOF',
    blockers: Object.freeze(blockers), advisories: Object.freeze(advisories),
  });
}

// ---- identifiers — no precision loss, no coercion --------------------------------
const DECIMAL_ID_RE = /^[1-9][0-9]{0,29}$/;
// message / user / symbol ids: canonical decimal strings; numeric fixtures only when positive safe integers
export function canonicalDecimalId(v) {
  if (typeof v === 'string') return DECIMAL_ID_RE.test(v) ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null; // an unsafe number is already rounded: reject, never stringify
  return null;
}
const SEQ_ID_RE = /^[0-9A-Za-z._:-]{1,128}$/;
// Firestream seq_id: an OPAQUE string preserved byte-for-byte within a syntax bound.
// Never Number(), never incremented, never a timestamp, never trimmed or normalized.
export function opaqueSeqId(v) {
  return typeof v === 'string' && SEQ_ID_RE.test(v) ? v : null;
}

// ---- fixture-only Firestream preview ------------------------------------------------
export const FIRESTREAM_OBJECTS = Object.freeze(['Message', 'Friendship', 'Block', 'LikeMessage']);
export const FIRESTREAM_ACTIONS = Object.freeze(['create', 'destroy']);
export const STOCKTWITS_PREVIEW_KINDS = Object.freeze(['MESSAGE', 'MESSAGE_REMOVAL']);
const MAX_SYMBOL_REFS = 16; const MAX_CLASSIFICATIONS = 8;
const TICKER_RE = /^[A-Za-z0-9._-]{1,20}$/;
const PREVIEW_TEXT_CHARS = 280;
const derivePreviewText = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_TEXT_CHARS) : null);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const nnInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
// a declared source clock: full instant => ms; date-only => declaration preserved, instant unknown; malformed => null
function declaredClock(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return { declared: null, instantMs: null, precision: 'ABSENT' };
  if (DATE_ONLY_RE.test(v)) return { declared: v, instantMs: null, precision: 'DATE_ONLY' };
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? { declared: v, instantMs: ms, precision: 'INSTANT' } : { declared: v, instantMs: null, precision: 'MALFORMED' };
}
function symbolRefs(list) {
  if (!Array.isArray(list)) return Object.freeze([]);
  const out = [];
  for (const s of list) {
    if (out.length >= MAX_SYMBOL_REFS) break;
    if (s === null || typeof s !== 'object') continue;
    const symbolId = canonicalDecimalId(s.id);
    const ticker = typeof s.symbol === 'string' && TICKER_RE.test(s.symbol) ? s.symbol : null;
    if (symbolId === null && ticker === null) continue;
    out.push(Object.freeze({ symbolId, ticker }));
  }
  return Object.freeze(out);
}
function userContext(u, retrievedTs) {
  if (u === null || typeof u !== 'object' || Array.isArray(u)) return Object.freeze({ nativeAuthorId: null, identityStatus: 'UNKNOWN', handle: null, joinDeclared: null, joinTs: null, followers: null, following: null, official: null, identity: null, classification: null });
  const nativeAuthorId = canonicalDecimalId(u.id);
  const handle = typeof u.username === 'string' && u.username.length > 0 && u.username.length <= MAX_SOCIAL_HANDLE_CHARS ? u.username : null;
  const join = declaredClock(u.join_date);
  const joinTs = join.instantMs !== null && join.instantMs <= retrievedTs ? join.instantMs : null;
  const classification = Array.isArray(u.classification) ? Object.freeze(u.classification.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 40).slice(0, MAX_CLASSIFICATIONS)) : null;
  return Object.freeze({
    nativeAuthorId, identityStatus: nativeAuthorId ? 'NATIVE_USER_ID' : 'UNKNOWN', handle, joinDeclared: join.declared, joinTs,
    followers: nnInt(u.followers), following: nnInt(u.following),
    official: typeof u.official === 'boolean' ? u.official : null, // a provider flag — never verified-source status or corroboration
    identity: typeof u.identity === 'string' && u.identity.length <= 40 ? u.identity : null, classification,
  });
}
const base = ({ envelope, retrievedTs, action }) => ({
  provider: STOCKTWITS_OFFICIAL.id, providerKind: STOCKTWITS_OFFICIAL.providerKind, route: 'FIRESTREAM_MESSAGES',
  fixtureOnly: true, durable: false, authority: 'NONE', readinessToken: false,
  delivery: Object.freeze({ seqId: opaqueSeqId(envelope.seq_id), envelopeTs: declaredClock(envelope.time).instantMs, envelopeAction: action, completeFeedClaimed: false }),
  retrievedTs: Math.floor(retrievedTs), knownAtTs: Math.floor(retrievedTs), editSemantics: 'UNRESOLVED',
});

// Map ONE Firestream-shaped envelope to an IN-MEMORY preview. Dispatches on BOTH
// object and action. Returns { preview } | { unsupported } | { skip }.
export function firestreamEnvelopeToPreview(envelope, { retrievedTs } = {}) {
  if (!isSupportedClock(retrievedTs)) return { skip: true, reason: 'retrievedTs (acquisition clock) must be a supported epoch-ms timestamp; the adapter never reads a wall clock' };
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return { skip: true, reason: 'not an object' };
  const object = envelope.object; const action = envelope.action;
  if (typeof object !== 'string' || typeof action !== 'string') return { skip: true, reason: 'object/action missing' };
  if (!FIRESTREAM_OBJECTS.includes(object) || !FIRESTREAM_ACTIONS.includes(action)) return { unsupported: Object.freeze({ object: object.slice(0, 40), action: action.slice(0, 40), reason: 'UNKNOWN_OBJECT_OR_ACTION', affectsMessage: false }) };
  if (object !== 'Message') return { unsupported: Object.freeze({ object, action, reason: 'NOT_A_MESSAGE_LIFECYCLE_EVENT', affectsMessage: false }) };
  const d = envelope.data;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return { skip: true, reason: 'Message without data' };
  const messageId = canonicalDecimalId(d.id);
  if (messageId === null) return { skip: true, reason: 'Message without a canonical native id' };
  const author = userContext(d.user, retrievedTs);
  if (action === 'destroy') {
    // a removal event: the message id is known; nothing about the prior body, thread, or creation time is recreated
    const created = declaredClock(d.created_at);
    return { preview: Object.freeze({
      ...base({ envelope, retrievedTs, action }), kind: 'MESSAGE_REMOVAL', nativeMessageId: messageId,
      author, contentAvailable: false, originalText: null, previewText: null, priorCreateRequired: false,
      sourceDeclared: created.declared, sourceDeclaredTs: created.instantMs, sourceClockStatus: created.instantMs === null ? 'UNKNOWN' : classifySourceClock({ sourceDeclaredTs: created.instantMs, retrievedTs: Math.floor(retrievedTs) }).sourceClockStatus,
      removal: Object.freeze({ signal: 'PROVIDER_DESTROY', deletionDeliveryGuarantee: 'UNPROVEN', textReconstructed: false }),
    }) };
  }
  // Message/create
  const text = typeof d.body === 'string' ? d.body.slice(0, MAX_SOCIAL_TEXT_CHARS) : null;
  const created = declaredClock(d.created_at);
  const clock = created.instantMs === null ? { sourceCreatedTs: null, sourceClockStatus: 'UNKNOWN', sourceClockSkewMs: null } : classifySourceClock({ sourceDeclaredTs: created.instantMs, retrievedTs: Math.floor(retrievedTs) });
  const conv = d.conversation !== null && typeof d.conversation === 'object' && !Array.isArray(d.conversation) ? d.conversation : null;
  const replyToId = conv ? canonicalDecimalId(conv.in_reply_to_message_id) : null;
  const rootId = conv ? canonicalDecimalId(conv.parent_message_id) : null;
  const replyMalformed = conv !== null && conv.in_reply_to_message_id !== undefined && conv.in_reply_to_message_id !== null && replyToId === null;
  const rm = d.reshare_message !== null && typeof d.reshare_message === 'object' && !Array.isArray(d.reshare_message) ? d.reshare_message : null;
  const resharedMessageId = rm ? canonicalDecimalId(rm.id) : null;
  const reshareMalformed = rm !== null && resharedMessageId === null;
  const reshares = d.reshares !== null && typeof d.reshares === 'object' && !Array.isArray(d.reshares) ? d.reshares : null;
  const propagation = Object.freeze({ resharedCount: reshares ? nnInt(reshares.reshared_count) : null, resharerIdCount: reshares && Array.isArray(reshares.user_ids) ? reshares.user_ids.filter((id) => canonicalDecimalId(id) !== null).length : null, replies: conv ? nnInt(conv.replies) : null });
  let relation;
  if (replyMalformed || reshareMalformed) relation = 'UNKNOWN';
  else if (replyToId !== null && resharedMessageId !== null) relation = 'UNKNOWN'; // conflicting evidence — no guessed precedence
  else if (replyToId !== null) relation = 'REPLY';
  else if (resharedMessageId !== null) relation = 'RESHARE';
  else relation = 'ORIGINAL';
  const sentiment = d.entities?.sentiment?.basic;
  return { preview: Object.freeze({
    ...base({ envelope, retrievedTs, action }), kind: 'MESSAGE', nativeMessageId: messageId,
    author, originalText: text, previewText: derivePreviewText(text), contentAvailable: text !== null,
    relation, replyToMessageId: replyToId, rootMessageId: rootId, resharedMessageId,
    propagation, // metadata only — never new observations, never corroboration
    symbols: symbolRefs(d.symbols), sentiment: sentiment === 'Bullish' || sentiment === 'Bearish' ? sentiment : null, // the author's label, descriptive only
    sourceDeclared: created.declared, sourceDeclaredPrecision: created.precision, sourceDeclaredTs: created.instantMs, sourceCreatedTs: clock.sourceCreatedTs, sourceClockStatus: clock.sourceClockStatus, sourceClockSkewMs: clock.sourceClockSkewMs,
    nativeVersionId: null, providerEventSeq: null, // never invented; seq_id lives in delivery, never in the shared numeric seq
  }) };
}

// ---- symbol reference matching (in-memory, snapshot-aware) ---------------------------
// reference = { knownAtTs, rows: [{ symbol_id, ticker, asset_class?, delisted? }] }. A snapshot
// only known LATER than the observation is refused for that observation. No tradeable label.
export function resolveSymbolReference(symbols, reference, { asOfTs } = {}) {
  const refs = Array.isArray(symbols) ? symbols : [];
  if (!isSupportedClock(asOfTs)) return Object.freeze(refs.map((s) => Object.freeze({ ...s, status: 'UNRESOLVED', reason: 'AS_OF_CLOCK_INVALID' })));
  if (reference === null || reference === undefined) return Object.freeze(refs.map((s) => Object.freeze({ ...s, status: 'UNRESOLVED', reason: 'NO_REFERENCE' })));
  if (!isSupportedClock(reference.knownAtTs) || !Array.isArray(reference.rows)) return Object.freeze(refs.map((s) => Object.freeze({ ...s, status: 'UNRESOLVED', reason: 'REFERENCE_MALFORMED' })));
  if (reference.knownAtTs > asOfTs) return Object.freeze(refs.map((s) => Object.freeze({ ...s, status: 'UNRESOLVED', reason: 'REFERENCE_KNOWN_LATER' })));
  const byId = new Map();
  for (const r of reference.rows) { const id = r && canonicalDecimalId(r.symbol_id); if (id && typeof r.ticker === 'string' && TICKER_RE.test(r.ticker)) byId.set(id, r); }
  return Object.freeze(refs.map((s) => {
    if (s.symbolId === null) return Object.freeze({ ...s, status: 'UNRESOLVED', reason: 'NO_SYMBOL_ID' });
    const row = byId.get(s.symbolId);
    if (!row) return Object.freeze({ ...s, status: 'UNRESOLVED', reason: 'NOT_IN_REFERENCE' });
    if (s.ticker !== null && s.ticker !== row.ticker) return Object.freeze({ ...s, status: 'UNRESOLVED', reason: 'TICKER_CONFLICT', referenceTicker: row.ticker });
    return Object.freeze({ ...s, status: 'MATCHED', referenceTicker: row.ticker, assetClass: typeof row.asset_class === 'string' ? row.asset_class.slice(0, 40) : null, delisted: typeof row.delisted === 'boolean' ? row.delisted : null, referenceKnownAtTs: reference.knownAtTs, tradeable: null });
  }));
}
