// SOCIAL-3 — Reddit: CLASSIFICATION-NEUTRAL ACCESS FOUNDATION + RETENTION
// FIREWALL. Fixture-only. This module performs NO network call, NO OAuth
// exchange, NO polling, NO scraping, NO session emulation, holds NO credential
// value, and can NOT become live by flipping any field: there is no transport
// here to flip on. Reddit is NOT an operational ear.
//
// THE FACTS THIS FOUNDATION RECORDS (doctrine/SOCIAL.md §5F):
//   * Serpent is a private, single-user personal prototype — not sold, not
//     offered as a service. Intended uses: personal research, autonomous paper
//     trading, and possibly later automated trading of the owner's OWN funds.
//     That financial objective is disclosed, never hidden.
//   * Reddit's classification of that use is UNRESOLVED. Neither "definitely
//     commercial" nor "private, therefore exempt" is assumed. API data access
//     requires Reddit's explicit approval with honest disclosure [R1]; the
//     published examples do not settle this scenario [R2]; the Developer Terms
//     (4.1) and Data API Terms (2.4/3.1/3.2/6) restrict revenue-related and
//     monetized use and may require a separate agreement [R3][R4]; permission
//     is use-specific — a token is not a license for every downstream use.
//   * RETENTION is a separate boundary from classification. The immutable RUMOR
//     journal cannot erase an individual user's retained content; deleted
//     content and deleted-account identifying data must be removed under [R5].
//     Until the permitted retention is reviewed AND a compatible design exists,
//     no Reddit content or author-identifying data may enter durable Social
//     truth (SOCIAL_RETENTION_PROHIBITED_PROVIDERS in rumor2/social.js).
//   * An approval RECORD is an operator attestation, never machine proof that
//     Reddit issued permission; missing/expired/revoked/out-of-scope/unverified
//     approval confers nothing. Approval for retrieval never silently expands
//     to inference, model training, derived features, or redistribution.
import { classifySourceClock, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_TEXT_CHARS, MAX_SOCIAL_HANDLE_CHARS, MAX_SOCIAL_URL_CHARS } from './social.js';

export const REDDIT_OFFICIAL = Object.freeze({
  id: 'REDDIT_OFFICIAL',
  providerKind: 'SOCIAL_FORUM',
  organization: 'REDDIT',
  transport: 'REST_POLL',
  apiHost: 'oauth.reddit.com', // Data API host (OAuth-authenticated requests only)
  tokenHost: 'www.reddit.com', // OAuth2 token endpoint host
  tokenPath: '/api/v1/access_token',
  hosts: Object.freeze(['oauth.reddit.com', 'www.reddit.com']),
  credentialEnvs: Object.freeze(['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET']), // NAMES only; a credential is not an approval
  freeEligibleQpmReference: 100, // [R5] technical context per OAuth client id, 10-min average — NOT an entitlement
  sourcesAccessedOn: '2026-09-06',
});

// What THIS module is and is not — pinned so a test can prove no live path exists.
export const REDDIT_FOUNDATION = Object.freeze({ fixtureOnly: true, liveTransport: false, oauthExchange: false, pollingLoop: false, scraping: false, sessionEmulation: false, modelCalls: false, persistentCache: false });

// ---- closed state model (§5) — separate questions, separate answers -----------
export const REDDIT_PLATFORM_PATHS = Object.freeze(['DOCUMENTED_OFFICIAL_PATH']);
export const REDDIT_USE_CASE_CLASSIFICATIONS = Object.freeze(['UNRESOLVED', 'APPROVED_NON_COMMERCIAL_PERSONAL', 'APPROVED_WITH_ADDITIONAL_TERMS', 'APPROVED_COMMERCIAL', 'DENIED']);
export const REDDIT_APPROVAL_STATUSES = Object.freeze(['NOT_VERIFIED', 'OPERATOR_ATTESTED', 'EXPIRED', 'REVOKED', 'DENIED', 'OUT_OF_SCOPE']);
export const REDDIT_AGREEMENT_STATES = Object.freeze(['UNRESOLVED', 'NOT_REQUIRED', 'REQUIRED_UNSATISFIED', 'REQUIRED_SATISFIED']);
export const REDDIT_RETENTION_STATES = Object.freeze(['UNRESOLVED', 'COMPATIBLE_REVIEWED', 'INCOMPATIBLE']);
export const REDDIT_LIVE_STATES = Object.freeze(['DISABLED']);
// closed vocabulary of downstream uses; retrieval permission never implies the others
export const REDDIT_PERMITTED_USES = Object.freeze(['RETRIEVAL', 'PERSONAL_RESEARCH', 'PAPER_TRADING', 'OWN_FUNDS_TRADING', 'DERIVED_FEATURES', 'MODEL_INFERENCE', 'MODEL_TRAINING', 'REDISTRIBUTION']);
// the operator record's own closed fields
export const REDDIT_RECORD_STATUSES = Object.freeze(['APPROVED', 'PENDING', 'DENIED', 'REVOKED']);
export const REDDIT_RECORD_CLASSIFICATIONS = Object.freeze(['NON_COMMERCIAL_PERSONAL', 'REQUIRES_ADDITIONAL_TERMS', 'COMMERCIAL', 'UNRESOLVED']);
export const REDDIT_RECORD_AGREEMENTS = Object.freeze(['NOT_REQUIRED', 'REQUIRED', 'UNRESOLVED']);
export const REDDIT_APPLICATION_ID = 'SERPENT_PRIVATE_SINGLE_USER';
export const REDDIT_USE_CASE_VERSION = 'serpent-reddit-use-case-v1';

// The truthful use case Reddit must actually review (DRAFT text lives in doctrine;
// this is the machine-readable pin). Personal trading is disclosed, never omitted.
export const REDDIT_USE_CASE = Object.freeze({
  version: REDDIT_USE_CASE_VERSION,
  application: REDDIT_APPLICATION_ID,
  audience: 'PRIVATE_SINGLE_USER',
  offeredToCustomers: false,
  soldAsService: false,
  intendedUses: Object.freeze(['PERSONAL_RESEARCH', 'PAPER_TRADING', 'POSSIBLE_OWN_FUNDS_AUTOMATED_TRADING']),
  affiliationClaimed: 'NONE', // no business, academic, nonprofit, research-program, or moderator status is claimed
  classificationSource: 'REDDIT_USE_CASE_REVIEW', // only Reddit's review classifies this use
  dataScope: 'BOUNDED_CRYPTO_RELATED_PUBLIC_POSTS_AND_COMMENTS',
});

const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const REF_RE = /^[A-Za-z0-9._:/-]{1,120}$/; // a bounded non-sensitive reference label, never correspondence or contract text
const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

// Read the bounded operator approval record from env-like input. Every field is
// a NAME, enum, date, or short reference — never a secret, never correspondence.
// Returns null when no record is present at all.
export function redditApprovalRecordFromEnv(env = process.env) {
  const p = 'RUMOR2_SOCIAL_REDDIT_APPROVAL_';
  const keys = ['REF', 'STATUS', 'APPLICATION', 'USE_CASE_VERSION', 'CLASSIFICATION', 'PERMITTED_USES', 'ADDITIONAL_AGREEMENT', 'ADDITIONAL_AGREEMENT_SATISFIED', 'VALID_UNTIL', 'RETENTION_COMPATIBILITY', 'REVIEWED_ON'];
  if (!keys.some((k) => typeof env?.[p + k] === 'string' && env[p + k].length > 0)) return null;
  const g = (k) => (typeof env?.[p + k] === 'string' && env[p + k].length > 0 ? env[p + k] : null);
  return {
    approvalRef: g('REF'),
    status: g('STATUS'),
    application: g('APPLICATION'),
    useCaseVersion: g('USE_CASE_VERSION'),
    classification: g('CLASSIFICATION') ?? 'UNRESOLVED',
    permittedUses: csv(g('PERMITTED_USES')),
    additionalAgreement: g('ADDITIONAL_AGREEMENT') ?? 'UNRESOLVED',
    additionalAgreementSatisfied: g('ADDITIONAL_AGREEMENT_SATISFIED') === 'true',
    validUntil: g('VALID_UNTIL'),
    retentionCompatibility: g('RETENTION_COMPATIBILITY') ?? 'UNRESOLVED',
    reviewedOn: g('REVIEWED_ON'),
  };
}

// Closed validation of the record SHAPE. Any unknown enum fails closed (§7 J).
export function validateRedditApprovalRecord(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return 'approval record: not an object';
  const allowed = ['approvalRef', 'status', 'application', 'useCaseVersion', 'classification', 'permittedUses', 'additionalAgreement', 'additionalAgreementSatisfied', 'validUntil', 'retentionCompatibility', 'reviewedOn'];
  for (const k of Object.keys(r)) if (!allowed.includes(k)) return `approval record: undeclared field '${k}'`;
  if (r.approvalRef !== null && r.approvalRef !== undefined && (typeof r.approvalRef !== 'string' || !REF_RE.test(r.approvalRef))) return 'approval record: approvalRef must be a bounded reference label';
  if (!REDDIT_RECORD_STATUSES.includes(r.status)) return `approval record: unknown status '${r.status}'`;
  if (!isStr(r.application, 100)) return 'approval record: application missing';
  if (!isStr(r.useCaseVersion, 100)) return 'approval record: useCaseVersion missing';
  if (!REDDIT_RECORD_CLASSIFICATIONS.includes(r.classification)) return `approval record: unknown classification '${r.classification}'`;
  if (!Array.isArray(r.permittedUses) || r.permittedUses.length > REDDIT_PERMITTED_USES.length || r.permittedUses.some((u) => !REDDIT_PERMITTED_USES.includes(u))) return 'approval record: permittedUses outside the closed vocabulary';
  if (!REDDIT_RECORD_AGREEMENTS.includes(r.additionalAgreement)) return `approval record: unknown additionalAgreement '${r.additionalAgreement}'`;
  if (typeof r.additionalAgreementSatisfied !== 'boolean') return 'approval record: additionalAgreementSatisfied must be boolean';
  if (r.validUntil !== null && r.validUntil !== undefined && (typeof r.validUntil !== 'string' || !Number.isFinite(Date.parse(r.validUntil)))) return 'approval record: validUntil is not a parseable date';
  if (!REDDIT_RETENTION_STATES.includes(r.retentionCompatibility)) return `approval record: unknown retentionCompatibility '${r.retentionCompatibility}'`;
  if (r.reviewedOn !== null && r.reviewedOn !== undefined && (typeof r.reviewedOn !== 'string' || !Number.isFinite(Date.parse(r.reviewedOn)))) return 'approval record: reviewedOn is not a parseable date';
  // internal consistency: a classification that carries additional terms cannot claim none are required
  if ((r.classification === 'REQUIRES_ADDITIONAL_TERMS' || r.classification === 'COMMERCIAL') && r.additionalAgreement === 'NOT_REQUIRED') return 'approval record: classification requires additional terms but additionalAgreement says NOT_REQUIRED';
  if (r.classification === 'NON_COMMERCIAL_PERSONAL' && r.additionalAgreement === 'REQUIRED' && r.status === 'APPROVED') return null; // representable: an approved personal use that still carries a separate agreement
  return null;
}

// Whether a credential PAIR is present (booleans only; values never returned).
export function redditCredentialsPresent(env = process.env) {
  return REDDIT_OFFICIAL.credentialEnvs.every((k) => typeof env?.[k] === 'string' && env[k].length > 0);
}

// The evaluation clock is an explicit input: a safe-integer epoch-ms timestamp
// inside a supported range. Anything else (missing, wrong type, NaN, Infinity,
// negative, out of range) is rejected; this pure helper never substitutes a
// wall clock of its own.
const CLOCK_MIN_MS = Date.parse('2000-01-01T00:00:00Z');
const CLOCK_MAX_MS = Date.parse('2200-01-01T00:00:00Z');
export const isSupportedClock = (ms) => Number.isSafeInteger(ms) && ms >= CLOCK_MIN_MS && ms <= CLOCK_MAX_MS;

// The closed access evaluation. Inputs are the operator record (or null), the
// credential presence, and the clock. Output never contains a secret and never
// grants a live path: this foundation has none.
//
// READINESS LAW: `activationPrerequisitesMet` is a summary of THIS foundation's
// recorded prerequisites (never permission to run Reddit) and is derived from
// one coherent rule — every prerequisite true AND zero blockers. A blocking
// reason can never coexist with readiness; intentionally informational notes
// go to `advisories`, never `blockers`.
export function evaluateRedditAccess({ record = null, env = process.env, nowMs = null, description = null } = {}) {
  const blockers = [];
  const advisories = [];
  const clockKnown = isSupportedClock(nowMs);
  if (!clockKnown) blockers.push(nowMs === null || nowMs === undefined ? 'CLOCK_UNAVAILABLE' : 'CLOCK_INVALID');
  const credentialPresent = redditCredentialsPresent(env);
  let approvalStatus = 'NOT_VERIFIED';
  let useCaseClassification = 'UNRESOLVED';
  let additionalAgreement = 'UNRESOLVED';
  let retentionCompatibility = 'UNRESOLVED';
  let permittedUses = [];
  let recordError = null;
  let reviewOk = false;
  // a self-description (private, single-user, theoretical, research, ...) is never permission — advisory, not a blocker
  if (description !== null) advisories.push('SELF_DESCRIPTION_IS_NOT_PERMISSION');
  if (record === null) blockers.push('APPROVAL_RECORD_MISSING');
  else {
    recordError = validateRedditApprovalRecord(record);
    if (recordError) blockers.push(`APPROVAL_RECORD_INVALID: ${recordError}`);
    else if (!clockKnown) { /* nothing time-dependent (expiry, review date) can be judged: the attestation stays NOT_VERIFIED */ }
    else {
      // a supplied review date must already have happened relative to the evaluation clock; it is never rewritten
      const reviewedMs = record.reviewedOn ? Date.parse(record.reviewedOn) : null;
      reviewOk = reviewedMs === null || reviewedMs <= nowMs;
      if (!reviewOk) blockers.push('REVIEW_DATE_IN_FUTURE');
      const inScope = record.application === REDDIT_APPLICATION_ID && record.useCaseVersion === REDDIT_USE_CASE_VERSION;
      if (!inScope) { approvalStatus = 'OUT_OF_SCOPE'; blockers.push('APPROVAL_OUT_OF_SCOPE: the record covers another application or use-case version'); }
      else if (record.status === 'REVOKED') { approvalStatus = 'REVOKED'; blockers.push('APPROVAL_REVOKED'); }
      else if (record.status === 'DENIED') { approvalStatus = 'DENIED'; useCaseClassification = 'DENIED'; blockers.push('APPROVAL_DENIED'); }
      else if (record.status === 'PENDING') { approvalStatus = 'NOT_VERIFIED'; blockers.push('APPROVAL_PENDING'); }
      else if (record.status === 'APPROVED') {
        const exp = record.validUntil ? Date.parse(record.validUntil) : null; // null = no supplied expiry (never invented)
        if (exp !== null && !(nowMs < exp)) { approvalStatus = 'EXPIRED'; blockers.push('APPROVAL_EXPIRED'); }
        else if (record.classification === 'UNRESOLVED') { approvalStatus = 'NOT_VERIFIED'; blockers.push('APPROVAL_WITHOUT_CLASSIFICATION: Reddit\'s classification of the use is not recorded'); }
        else if (!reviewOk) { approvalStatus = 'NOT_VERIFIED'; }
        else {
          approvalStatus = 'OPERATOR_ATTESTED'; // an attestation that Reddit approved — never machine proof
          useCaseClassification = record.classification === 'NON_COMMERCIAL_PERSONAL' ? 'APPROVED_NON_COMMERCIAL_PERSONAL' : record.classification === 'COMMERCIAL' ? 'APPROVED_COMMERCIAL' : 'APPROVED_WITH_ADDITIONAL_TERMS';
          permittedUses = [...record.permittedUses];
        }
      }
      if (approvalStatus === 'OPERATOR_ATTESTED') {
        additionalAgreement = record.additionalAgreement === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : record.additionalAgreement === 'REQUIRED' ? (record.additionalAgreementSatisfied ? 'REQUIRED_SATISFIED' : 'REQUIRED_UNSATISFIED') : 'UNRESOLVED';
        if (additionalAgreement === 'REQUIRED_UNSATISFIED') blockers.push('ADDITIONAL_AGREEMENT_REQUIRED_UNSATISFIED');
        if (additionalAgreement === 'UNRESOLVED') blockers.push('ADDITIONAL_AGREEMENT_UNRESOLVED');
        retentionCompatibility = record.retentionCompatibility;
        if (retentionCompatibility !== 'COMPATIBLE_REVIEWED') blockers.push(retentionCompatibility === 'INCOMPATIBLE' ? 'RETENTION_INCOMPATIBLE' : 'RETENTION_COMPATIBILITY_UNRESOLVED');
        if (!permittedUses.includes('RETRIEVAL')) blockers.push('RETRIEVAL_NOT_PERMITTED');
      }
    }
  }
  if (!credentialPresent) blockers.push('CREDENTIAL_MISSING');
  const prerequisites = Object.freeze({
    clock: clockKnown,
    review: clockKnown && (record === null ? false : reviewOk),
    approval: approvalStatus === 'OPERATOR_ATTESTED',
    agreement: additionalAgreement === 'NOT_REQUIRED' || additionalAgreement === 'REQUIRED_SATISFIED',
    retention: retentionCompatibility === 'COMPATIBLE_REVIEWED',
    retrieval: permittedUses.includes('RETRIEVAL'),
    credential: credentialPresent,
  });
  // ONE derivation: all prerequisites AND no blocker — a blocker can never coexist with readiness
  const activationPrerequisitesMet = blockers.length === 0 && Object.values(prerequisites).every(Boolean);
  return Object.freeze({
    provider: REDDIT_OFFICIAL.id,
    platformPath: 'DOCUMENTED_OFFICIAL_PATH',
    useCaseClassification, approvalStatus, additionalAgreement, retentionCompatibility,
    credentialPresent, permittedUses: Object.freeze(permittedUses),
    // downstream uses are SEPARATE permissions — retrieval never implies them
    downstream: Object.freeze({ inference: permittedUses.includes('MODEL_INFERENCE'), training: permittedUses.includes('MODEL_TRAINING'), derivedFeatures: permittedUses.includes('DERIVED_FEATURES'), redistribution: permittedUses.includes('REDISTRIBUTION') }),
    prerequisites, activationPrerequisitesMet,
    // THIS ticket: no live path and no durable content, whatever the record says
    liveStatus: 'DISABLED', liveAllowed: false, liveReason: 'FOUNDATION_ONLY_NO_LIVE_PATH',
    durableContentAllowed: false, durableAuthorIdentityAllowed: false, durableReason: prerequisites.retention ? 'RETENTION_COMPATIBLE_DESIGN_NOT_IMPLEMENTED' : 'RETENTION_COMPATIBILITY_UNRESOLVED',
    evidence: 'OPERATOR_ATTESTATION_NOT_PLATFORM_PROOF',
    blockers: Object.freeze(blockers), advisories: Object.freeze(advisories),
  });
}

// ---- fixture-only preview adapter (§10-§12) ----------------------------------------
// Maps ONE official-API-shaped "thing" ({ kind: 't3'|'t1', data }) to an IN-MEMORY
// preview. The preview is deliberately NOT the shared durable observation shape:
// it may carry an UNKNOWN author identity (the shared contract requires one), it
// is never normalized into durable truth (the retention firewall refuses the
// provider), and nothing here fetches, caches, or fabricates.
export const REDDIT_THING_KINDS = Object.freeze({ t1: 'COMMENT', t3: 'POST' });
const FULLNAME_RE = /^t[1-6]_[a-z0-9]{1,20}$/;
const SHORT_ID_RE = /^[a-z0-9]{1,20}$/;
export const REDDIT_REMOVAL_CATEGORIES = Object.freeze(['deleted', 'moderator', 'reddit', 'automod_filtered', 'author', 'content_takedown', 'copyright_takedown', 'community_ops', 'anti_evil_ops']);
const PREVIEW_TEXT_CHARS = 280;
const derivePreviewText = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_TEXT_CHARS) : null);
const secondsToMs = (v) => (Number.isFinite(v) && v > 0 && v < 1e11 ? Math.floor(v * 1000) : null);
const nnInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

export function redditThingToPreview(thing, { retrievedTs } = {}) {
  if (!Number.isFinite(retrievedTs)) return { skip: true, reason: 'retrievedTs (acquisition clock) is required; the adapter never reads the wall clock' };
  if (thing === null || typeof thing !== 'object' || Array.isArray(thing)) return { skip: true, reason: 'not an object' };
  const kind = REDDIT_THING_KINDS[thing.kind];
  const d = thing.data;
  if (!kind || d === null || typeof d !== 'object' || Array.isArray(d)) return { skip: true, reason: 'unsupported kind or missing data' };
  // identity: the provider-native fullname (post and comment namespaces stay distinct)
  let nativeThingId = null;
  if (typeof d.name === 'string' && FULLNAME_RE.test(d.name) && d.name.startsWith(`${thing.kind}_`)) nativeThingId = d.name;
  else if (typeof d.id === 'string' && SHORT_ID_RE.test(d.id)) nativeThingId = `${thing.kind}_${d.id}`;
  if (!nativeThingId || nativeThingId.length > MAX_NATIVE_ID_CHARS) return { skip: true, reason: 'no native thing identity' };
  const community = { name: isStr(d.subreddit, 100) ? d.subreddit : null, id: typeof d.subreddit_id === 'string' && /^t5_[a-z0-9]{1,20}$/.test(d.subreddit_id) ? d.subreddit_id : null };
  // author: the immutable account fullname when supplied; a username is display metadata only
  const authorId = typeof d.author_fullname === 'string' && /^t2_[a-z0-9]{1,20}$/.test(d.author_fullname) ? d.author_fullname : null;
  const authorName = isStr(d.author, MAX_SOCIAL_HANDLE_CHARS) && d.author !== '[deleted]' ? d.author : null;
  // deletion / removal: reveal that content is gone; never reconstruct it, never infer why
  const removedCategory = typeof d.removed_by_category === 'string' && REDDIT_REMOVAL_CATEGORIES.includes(d.removed_by_category) ? d.removed_by_category : null;
  const bodyRaw = kind === 'COMMENT' ? d.body : d.selftext;
  const bodyMarker = bodyRaw === '[deleted]' || bodyRaw === '[removed]';
  const contentGone = bodyMarker || removedCategory !== null;
  const text = !contentGone && typeof bodyRaw === 'string' ? bodyRaw.slice(0, MAX_SOCIAL_TEXT_CHARS) : null;
  // a title is provider-supplied as-is (it may remain on a removed post); a marker title is not content
  const title = kind === 'POST' && isStr(d.title, 300) && d.title !== '[deleted]' && d.title !== '[removed]' ? d.title : null;
  // relationships: comment => REPLY to parent_id; crosspost => CROSSPOST of crosspost_parent; else ORIGINAL; ambiguity => UNKNOWN
  let relation = 'UNKNOWN'; let parentNativeThingId = null; let linkNativeThingId = null;
  if (kind === 'COMMENT') {
    linkNativeThingId = typeof d.link_id === 'string' && /^t3_[a-z0-9]{1,20}$/.test(d.link_id) ? d.link_id : null;
    if (typeof d.parent_id === 'string' && /^t[13]_[a-z0-9]{1,20}$/.test(d.parent_id)) { relation = 'REPLY'; parentNativeThingId = d.parent_id; }
  } else if (typeof d.crosspost_parent === 'string') {
    if (/^t3_[a-z0-9]{1,20}$/.test(d.crosspost_parent) && d.crosspost_parent !== nativeThingId) { relation = 'CROSSPOST'; parentNativeThingId = d.crosspost_parent; }
  } else if (d.crosspost_parent === undefined || d.crosspost_parent === null) relation = 'ORIGINAL';
  // clocks: created_utc is the SOURCE-DECLARED clock (seconds); classified against the acquisition clock
  const sourceDeclaredTs = secondsToMs(d.created_utc);
  const clock = classifySourceClock({ sourceDeclaredTs, retrievedTs: Math.floor(retrievedTs) });
  // edit state: provider-supplied; no native version identifier is ever invented
  const editedTs = typeof d.edited === 'number' ? secondsToMs(d.edited) : null;
  const editState = contentGone ? (removedCategory === 'deleted' || d.author === '[deleted]' ? 'DELETED' : 'TOMBSTONED') : (editedTs !== null || d.edited === true ? 'EDITED' : 'ORIGINAL');
  const engagement = { score: Number.isSafeInteger(d.score) ? d.score : null, upvotes: nnInt(d.ups), replies: kind === 'POST' ? nnInt(d.num_comments) : null, upvoteRatio: kind === 'POST' && Number.isFinite(d.upvote_ratio) && d.upvote_ratio >= 0 && d.upvote_ratio <= 1 ? d.upvote_ratio : null };
  const permalink = typeof d.permalink === 'string' && d.permalink.startsWith('/') && d.permalink.length < MAX_SOCIAL_URL_CHARS - 30 ? `https://www.reddit.com${d.permalink}` : null;
  return {
    preview: Object.freeze({
      provider: REDDIT_OFFICIAL.id, providerKind: REDDIT_OFFICIAL.providerKind, kind,
      nativeThingId, community: Object.freeze(community),
      author: Object.freeze({ nativeAuthorId: authorId, identityStatus: authorId ? 'NATIVE_FULLNAME' : 'UNKNOWN', displayName: authorName }),
      title, originalText: text, previewText: derivePreviewText(text), contentAvailable: !contentGone,
      removal: Object.freeze({ gone: contentGone, providerCategory: removedCategory, reason: removedCategory ?? 'UNKNOWN', textReconstructed: false }),
      relation, parentNativeThingId, linkNativeThingId,
      sourceDeclaredTs, sourceCreatedTs: clock.sourceCreatedTs, sourceClockStatus: clock.sourceClockStatus, sourceClockSkewMs: clock.sourceClockSkewMs,
      retrievedTs: Math.floor(retrievedTs), knownAtTs: Math.floor(retrievedTs),
      editState, editedTs, nativeVersionId: null, providerEventSeq: null,
      engagement: Object.freeze(engagement),
      flags: Object.freeze({ isSelf: d.is_self === true, over18: d.over_18 === true, locked: d.locked === true, stickied: d.stickied === true }),
      canonicalUrl: permalink,
      durable: false, // a preview is never durable Social truth
    }),
  };
}

// ---- pure request / limit helpers (§13) — nothing here sends anything -----------------
// Official User-Agent shape: <platform>:<app ID>:<version string> (by /u/<username>)
const UA_PART_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function redditUserAgent({ platform = 'nodejs', appId, version, owner } = {}) {
  if (![platform, appId, version, owner].every((v) => typeof v === 'string' && UA_PART_RE.test(v))) return null;
  return `${platform}:${appId}:${version} (by /u/${owner})`;
}
// A listing request DESCRIPTION (host/path/query/headers) with the credential named, never valued.
export function redditListingRequest({ subreddit, listing = 'new', limit = 25, after = null, userAgent } = {}) {
  if (!isStr(subreddit, 50) || !/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) return { error: 'subreddit invalid' };
  if (!['new', 'hot', 'top', 'rising', 'comments'].includes(listing)) return { error: 'listing invalid' };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be 1..100' };
  if (after !== null && !(typeof after === 'string' && FULLNAME_RE.test(after))) return { error: 'after must be a fullname' };
  if (typeof userAgent !== 'string' || !/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+ \(by \/u\/[A-Za-z0-9._-]+\)$/.test(userAgent)) return { error: 'userAgent must follow the documented descriptive shape' };
  const query = { limit, raw_json: 1, ...(after ? { after } : {}) };
  return Object.freeze({ method: 'GET', host: REDDIT_OFFICIAL.apiHost, path: `/r/${subreddit}/${listing}`, query: Object.freeze(query), headers: Object.freeze({ 'User-Agent': userAgent, Authorization: Object.freeze({ scheme: 'Bearer', tokenEnv: 'REDDIT_ACCESS_TOKEN', value: null }) }), sent: false });
}
// Rate headers -> bounded numbers, or null for anything malformed (no allowance
// from garbage). ACCEPTED raw representations, explicitly: (a) an HTTP header
// string in the documented decimal form — digits with an optional fractional
// part ('96.0', '4', '412'), surrounding whitespace tolerated; (b) a finite
// non-negative plain number (deliberate fixture representation). Everything
// else — booleans, arrays, objects, functions, bigint, symbols, null/missing,
// empty or whitespace-only strings, exponent/hex/signed/partial numeric syntax,
// NaN, Infinity, negatives, and values at or beyond the bound — is rejected.
// Lookup is case-insensitive on plain objects and uses `get` on Headers-like inputs.
const RATE_HEADER_BOUND = 1e7;
const RATE_DECIMAL_RE = /^\d{1,7}(\.\d{1,6})?$/;
const rateHeaderValue = (v) => {
  let n;
  if (typeof v === 'string') { const t = v.trim(); if (!RATE_DECIMAL_RE.test(t)) return null; n = Number(t); }
  else if (typeof v === 'number') n = v;
  else return null;
  return Number.isFinite(n) && n >= 0 && n < RATE_HEADER_BOUND ? n : null;
};
const lookupHeader = (headers, name) => {
  if (typeof headers.get === 'function') { const v = headers.get(name); return v === null || v === undefined ? undefined : v; }
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (typeof k === 'string' && k.toLowerCase() === want) return headers[k];
  return undefined;
};
export function parseRedditRateHeaders(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const remaining = rateHeaderValue(lookupHeader(headers, 'x-ratelimit-remaining'));
  const used = rateHeaderValue(lookupHeader(headers, 'x-ratelimit-used'));
  const reset = rateHeaderValue(lookupHeader(headers, 'x-ratelimit-reset'));
  if (remaining === null || used === null || reset === null) return null;
  return Object.freeze({ remaining: Math.floor(remaining), used: Math.floor(used), resetSeconds: Math.floor(reset) });
}
// The FUTURE runtime's allowance law, pinned now: min(approved scope cap, configured cap, observed remaining).
// Any missing/malformed input => 0. The published 100 QPM reference is never a default.
export function redditRateAllowance({ approvedQpm = null, configuredQpm = null, headers = null } = {}) {
  const rate = parseRedditRateHeaders(headers);
  if (!Number.isSafeInteger(approvedQpm) || approvedQpm <= 0 || !Number.isSafeInteger(configuredQpm) || configuredQpm <= 0 || rate === null) return { allowance: 0, reason: rate === null ? 'RATE_HEADERS_MISSING_OR_MALFORMED' : 'CAP_NOT_CONFIGURED' };
  return { allowance: Math.max(0, Math.min(approvedQpm, configuredQpm, rate.remaining)), reason: null, rate };
}
