// SOCIAL-4E — ONE small PURE primitive shared by the non-live social access
// foundations added in this ticket (rumor2/social-meta.js, rumor2/social-tiktok.js,
// rumor2/social-farcaster-access.js). It exists only because three new modules
// would otherwise carry three copies of the same clock guard, closed record
// vocabulary, operator-date judgement, and "no live path" facts. The earlier
// forum/finance foundations keep their own byte-identical copies — nothing here
// changes them, and nothing here is imported by any production runtime.
//
// This module imports ONLY the sealed temporal boundary (rumor2/social-time.js)
// and performs no network, timer, storage, wall-clock, or model call. It holds
// no credential value and can never become live: there is no transport to flip.
//
// SHARED LAWS (doctrine/SOCIAL.md §5P):
//   * An access RECORD is an operator attestation, never machine proof that a
//     platform approved anything. Missing/expired/revoked/out-of-scope/unverified
//     approval confers nothing. Approval for retrieval never silently expands to
//     inference, training, derived features, or redistribution.
//   * Readiness = every prerequisite satisfied AND zero blockers. A blocker can
//     never coexist with readiness; informational notes go to advisories.
//   * Every output says: liveAllowed false, durableContentAllowed false,
//     durableAuthorIdentityAllowed false, liveStatus DISABLED,
//     FOUNDATION_ONLY_NO_LIVE_PATH — whatever the record says.
//   * The evaluation clock is a caller-supplied epoch-ms integer in a supported
//     range; operator dates use the sealed `accessDate` interpretation (ABSENT /
//     INSTANT / DATE_ONLY / INVALID — never the host zone, never repaired).
import { accessDate, utcDayStart } from './social-time.js';

export const SOCIAL_FOUNDATION_VERSION = 1;
export const SOCIAL_FOUNDATION_APPLICATION_ID = 'SERPENT_PRIVATE_SINGLE_USER';

// ---- the caller-supplied evaluation clock -------------------------------------------
const CLOCK_MIN_MS = 946_684_800_000; // 2000-01-01T00:00:00Z
const CLOCK_MAX_MS = 7_258_118_400_000; // 2200-01-01T00:00:00Z
export const isSupportedFoundationClock = (ms) => Number.isSafeInteger(ms) && ms >= CLOCK_MIN_MS && ms <= CLOCK_MAX_MS;

// ---- closed vocabularies (shared by every 4E foundation) ----------------------------
export const FOUNDATION_RECORD_STATUSES = Object.freeze(['ATTESTED', 'PENDING', 'DENIED', 'REVOKED']);
export const FOUNDATION_APPROVAL_STATUSES = Object.freeze(['NOT_VERIFIED', 'OPERATOR_ATTESTED', 'EXPIRED', 'REVOKED', 'DENIED', 'OUT_OF_SCOPE']);
export const FOUNDATION_RECORD_AGREEMENTS = Object.freeze(['NOT_REQUIRED', 'REQUIRED', 'UNRESOLVED']);
export const FOUNDATION_AGREEMENT_STATES = Object.freeze(['UNRESOLVED', 'NOT_REQUIRED', 'REQUIRED_UNSATISFIED', 'REQUIRED_SATISFIED']);
export const FOUNDATION_RETENTION_STATES = Object.freeze(['UNRESOLVED', 'COMPATIBLE_REVIEWED', 'INCOMPATIBLE']);
export const FOUNDATION_PERMITTED_USES = Object.freeze(['RETRIEVAL', 'PERSONAL_RESEARCH', 'PAPER_TRADING', 'OWN_FUNDS_TRADING', 'DERIVED_FEATURES', 'MODEL_INFERENCE', 'MODEL_TRAINING', 'REDISTRIBUTION']);
export const FOUNDATION_DOC_STATUSES = Object.freeze(['VERIFIED', 'DOCUMENTATION_UNVERIFIED']);
export const FOUNDATION_LIVE_STATES = Object.freeze(['DISABLED']);
export const FOUNDATION_IMPLEMENTATION_STAGES = Object.freeze(['NO_SANCTIONED_ROUTE', 'DESCRIPTOR_ONLY', 'DESCRIPTOR_AND_FIXTURE_PREVIEW', 'ACCESS_BOUNDARY_ONLY']);
export const FOUNDATION_EVIDENCE = 'OPERATOR_ATTESTATION_NOT_PLATFORM_PROOF';

// Facts every 4E output carries. Frozen constants, spread into results — never
// computed from any record, so no input can flip them.
export const FOUNDATION_LIVE_FACTS = Object.freeze({
  liveStatus: 'DISABLED', liveAllowed: false, liveReason: 'FOUNDATION_ONLY_NO_LIVE_PATH',
  durableContentAllowed: false, durableAuthorIdentityAllowed: false,
  measuredLatency: 'UNKNOWN', productionObservation: 'UNOBSERVED',
});
export const FOUNDATION_PREVIEW_FACTS = Object.freeze({ fixtureOnly: true, durable: false, authority: 'NONE', readinessToken: false });

// ---- small total helpers ---------------------------------------------------------
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isBoundedString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const REF_RE = /^[A-Za-z0-9._:/-]{1,120}$/; // a bounded non-sensitive reference label, never correspondence or contract text
export const isReferenceLabel = (v) => typeof v === 'string' && REF_RE.test(v);
export const csvList = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
export const nonNegativeInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
export function deepFreeze(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) deepFreeze(o[k]);
  return o;
}

// A dated first-party documentation reference. `status` is VERIFIED only when the
// page was actually read on `accessedOn`; a fetch failure is DOCUMENTATION_UNVERIFIED
// (a retrieval limit is not an access decision). `note` is a bounded summary of what
// the page established — never a claim beyond it.
export function docRef({ id, url, accessedOn, status, note }) {
  if (!isBoundedString(id, 12) || !isBoundedString(url, 300) || !url.startsWith('https://')) throw new TypeError('docRef: id/url required');
  if (accessDate(accessedOn).kind !== 'DATE_ONLY') throw new TypeError('docRef: accessedOn must be a YYYY-MM-DD label');
  if (!FOUNDATION_DOC_STATUSES.includes(status)) throw new TypeError('docRef: unknown status');
  if (!isBoundedString(note, 600)) throw new TypeError('docRef: note required');
  return Object.freeze({ id, url, accessedOn, status, note });
}

// ---- operator-supplied dates (sealed `accessDate` semantics, parsed ONCE) -------------
export function foundationDates(record) {
  return Object.freeze({ reviewedOn: accessDate(record?.reviewedOn), validUntil: accessDate(record?.validUntil) });
}

// The generic part of every record shape: reference label, closed status, scope
// strings, closed permitted-use vocabulary, agreement fields, retention fields,
// and the two operator dates. Returns an error string or null. Callers validate
// their own route/prerequisite fields on top and reject undeclared keys.
export function validateFoundationRecordCore(r, dates, { retentionFields = ['retentionContent', 'retentionIdentity'] } = {}) {
  if (!isPlainObject(r)) return 'access record: not an object';
  if (r.approvalRef !== null && r.approvalRef !== undefined && !isReferenceLabel(r.approvalRef)) return 'access record: approvalRef must be a bounded reference label';
  if (!FOUNDATION_RECORD_STATUSES.includes(r.status)) return `access record: unknown status '${r.status}'`;
  if (!isBoundedString(r.application, 100)) return 'access record: application missing';
  if (!isBoundedString(r.useCaseVersion, 100)) return 'access record: useCaseVersion missing';
  if (!Array.isArray(r.permittedUses) || r.permittedUses.length > FOUNDATION_PERMITTED_USES.length || r.permittedUses.some((u) => !FOUNDATION_PERMITTED_USES.includes(u))) return 'access record: permittedUses outside the closed vocabulary';
  if (new Set(r.permittedUses).size !== r.permittedUses.length) return 'access record: permittedUses repeats a value';
  if (!FOUNDATION_RECORD_AGREEMENTS.includes(r.additionalAgreement)) return `access record: unknown additionalAgreement '${r.additionalAgreement}'`;
  if (typeof r.additionalAgreementSatisfied !== 'boolean') return 'access record: additionalAgreementSatisfied must be boolean';
  for (const f of retentionFields) if (!FOUNDATION_RETENTION_STATES.includes(r[f])) return `access record: unknown ${f} '${r[f]}'`;
  if (dates.validUntil.kind === 'INVALID') return `access record: validUntil ${dates.validUntil.error}`;
  if (dates.reviewedOn.kind === 'INVALID') return `access record: reviewedOn ${dates.reviewedOn.error}`;
  return null;
}

// The shared approval judgement for a VALID record under a KNOWN clock. Scope is
// application + use-case version + the caller's own binding (a route, a provider);
// a record for another scope is OUT_OF_SCOPE and confers nothing. Returns the
// approval status, whether the review date is admissible, and the blockers/
// advisories this judgement produced. Never reads a wall clock.
export function foundationApprovalOutcome({ record, dates, nowMs, applicationId, useCaseVersion, scopeMatch = true, scopeMismatchBlocker = 'APPROVAL_OUT_OF_SCOPE: the record binds another scope' }) {
  const blockers = []; const advisories = [];
  // reviewedOn: an INSTANT compares exactly; a DATE_ONLY label compares to the UTC calendar day of
  // nowMs (a later day cannot establish readiness); ABSENT keeps its optionality and is labelled.
  const rv = dates.reviewedOn;
  const reviewOk = rv.kind === 'ABSENT' || (rv.kind === 'INSTANT' ? rv.instantMs <= nowMs : rv.dayStartMs <= utcDayStart(nowMs));
  if (rv.kind === 'ABSENT') advisories.push('REVIEW_DATE_NOT_SUPPLIED');
  if (!reviewOk) blockers.push('REVIEW_DATE_IN_FUTURE');
  let approvalStatus = 'NOT_VERIFIED';
  const inScope = record.application === applicationId && record.useCaseVersion === useCaseVersion;
  if (!inScope) { approvalStatus = 'OUT_OF_SCOPE'; blockers.push('APPROVAL_OUT_OF_SCOPE: the record covers another application or use-case version'); }
  else if (scopeMatch !== true) { approvalStatus = 'OUT_OF_SCOPE'; blockers.push(scopeMismatchBlocker); }
  else if (record.status === 'REVOKED') { approvalStatus = 'REVOKED'; blockers.push('APPROVAL_REVOKED'); }
  else if (record.status === 'DENIED') { approvalStatus = 'DENIED'; blockers.push('APPROVAL_DENIED'); }
  else if (record.status === 'PENDING') { blockers.push('APPROVAL_PENDING'); }
  else if (record.status === 'ATTESTED') {
    // validUntil: ABSENT = no supplied expiry (never perpetual authorization, never invented); INSTANT =
    // exact boundary, valid only while nowMs < expiry; DATE_ONLY names no instant or zone => blocked.
    const vu = dates.validUntil;
    if (vu.kind === 'INSTANT' && !(nowMs < vu.instantMs)) { approvalStatus = 'EXPIRED'; blockers.push('APPROVAL_EXPIRED'); }
    else if (vu.kind === 'DATE_ONLY') { blockers.push('VALID_UNTIL_PRECISION_UNRESOLVED'); }
    else if (reviewOk) approvalStatus = 'OPERATOR_ATTESTED'; // an attestation that the platform approved — never machine proof
  }
  return Object.freeze({ approvalStatus, reviewOk, blockers: Object.freeze(blockers), advisories: Object.freeze(advisories) });
}

// Extra-agreement applicability and satisfaction are SEPARATE answers.
export function foundationAgreementState(record) {
  if (record.additionalAgreement === 'NOT_REQUIRED') return 'NOT_REQUIRED';
  if (record.additionalAgreement === 'REQUIRED') return record.additionalAgreementSatisfied ? 'REQUIRED_SATISFIED' : 'REQUIRED_UNSATISFIED';
  return 'UNRESOLVED';
}
export const agreementSatisfied = (state) => state === 'NOT_REQUIRED' || state === 'REQUIRED_SATISFIED';
export const agreementBlocker = (state) => (state === 'REQUIRED_UNSATISFIED' ? 'ADDITIONAL_AGREEMENT_REQUIRED_UNSATISFIED' : state === 'UNRESOLVED' ? 'ADDITIONAL_AGREEMENT_UNRESOLVED' : null);
// Retention for CONTENT and retention for AUTHOR IDENTITY are judged separately.
export const retentionBlocker = (state, label) => (state === 'COMPATIBLE_REVIEWED' ? null : state === 'INCOMPATIBLE' ? `RETENTION_${label}_INCOMPATIBLE` : `RETENTION_${label}_UNRESOLVED`);

// ONE derivation of readiness: every prerequisite true AND no blocker.
export const foundationReadiness = (prerequisites, blockers) => blockers.length === 0 && Object.values(prerequisites).every((v) => v === true);

// Route-summary skeleton: the questions every route summary must answer SEPARATELY.
// Descriptor modules fill these keys; a test asserts each key is present on every route.
export const FOUNDATION_ROUTE_SUMMARY_KEYS = Object.freeze([
  'platformPath', 'payloadScope', 'eligibilityRequirements', 'eligibilityEstablishedForOperator', 'approvalEntitlement',
  'credentialConfiguration', 'permittedUses', 'extraAgreement', 'retentionContent', 'retentionIdentity',
  'implementationStage', 'measuredLatency', 'productionObservation', 'evidence',
]);
