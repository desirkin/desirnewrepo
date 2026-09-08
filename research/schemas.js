// SOCIAL-5B §11c — THE CLOSED SCHEMAS OF THE ARTIFACT METADATA ITSELF.
//
// Row validation and output checksums say nothing about the METADATA that frames them. A dataset whose manifest
// declared `inputs: null` — no snapshot digest, no archive identity, no provenance at all — was sealed and reopened
// without complaint, because only the top-level key set was checked and `null` is a value. Nested structures were
// reached with optional chaining and defaults, so a missing object read as "absent" rather than "corrupt".
//
// This module states the shapes the CURRENT producers actually emit, closed and exactly, so that every nested
// identity, digest, clock, count and recipe copy has to be there and has to agree with the others. It reconciles
// repeated facts (a manifest digest recorded twice, a creation clock recorded as both ISO text and milliseconds)
// rather than trusting either copy: two matching but wrong copies satisfy nothing.
//
// Where a fact genuinely cannot be recovered from a portable artifact, this module does NOT pretend otherwise. It
// checks provenance and internal consistency, and leaves the honest limitation in place.
import { COVERAGE_REASONS, ENTRANCE_LABELS, isCode, AUTHORITY, PURPOSE, LIMITS, PIPELINE_VERSION, SNAPSHOT_VERSION, PREFIX_DIGEST_VERSION, FEATURE_RECIPE_VERSION, LABEL_RECIPE_VERSION, DATASET_MANIFEST_VERSION, EVALUATION_VERSION, SPLIT_RECIPE_VERSION, LABEL_HORIZONS_MIN, LOG_RETURN_HORIZONS_MIN, MAX_HORIZON_MS, SPLITS, CALIBRATION_BLOCKERS, GROUPING_DEPENDENCY_KINDS, NON_GROUPING_DEPENDENCY_KINDS, LABEL_STATES, COHORTS, ARRAY_CATALOGUE, FEATURE_NAMES, NOTICE_SUPPORT_MS, PARTICIPATION_SUPPORT_WINDOW_MS, WIDEEYE_BASELINE_SUPPORT_MS, isPlainObject, isTs, isCount, isCoin, isFiniteNum, exactKeys, isoOf, parseUtcInstant, safeType } from './contracts.js';
import { IDENTITY_LAWS, identityLaw } from './identity.js';
import { RESEARCH_STATES, RESEARCH_SOCIAL_COVERAGE_STATES } from '../rumor2/social-research-dossier.js';
import { splitOfGroup } from './evaluation.js';

const SHA256 = /^[0-9a-f]{64}$/;
const err = (where, what) => `${where}: ${what}`;
const isNonEmptyString = (v, max = 400) => typeof v === 'string' && v.length > 0 && v.length <= max;
// a dynamic map: bounded key domain, bounded size, nonnegative safe-integer counts, no duplicates by construction
function countMapError(v, where, { maxKeys = 256, keyOk = null } = {}) {
  if (!isPlainObject(v)) return err(where, 'is not an object');
  const keys = Object.keys(v);
  if (keys.length > maxKeys) return err(where, `carries more than ${maxKeys} entries`);
  for (let i = 0; i < keys.length; i += 1) {
    if (keyOk && !keyOk(keys[i])) return err(where, `entry ${i + 1} is not a recognized key`);
    if (!isCount(v[keys[i]])) return err(where, `entry ${i + 1} is not a nonnegative safe integer count`);
  }
  return null;
}
// the RECORDED limits describe the producing artifact. They are validated as data; they never raise the reader's own.
export function limitsError(v, where) {
  const k = exactKeys(v, Object.keys(LIMITS)); if (k) return err(`${where} limits`, k);
  for (const name of Object.keys(LIMITS)) if (!Number.isSafeInteger(v[name]) || v[name] <= 0) return err(`${where} limits`, `${name} is not a positive safe integer`);
  return null;
}
export function codeIdentityError(v, where) {
  const k = exactKeys(v, ['pipelineVersion', 'sourceTreeSha256', 'sourceFiles', 'sourceClosure', 'roots', 'gitCommit', 'gitSourceDirty', 'law', 'note']); if (k) return err(`${where} codeIdentity`, k);
  if (v.pipelineVersion !== PIPELINE_VERSION) return err(`${where} codeIdentity`, 'unsupported pipeline version');
  if (!SHA256.test(v.sourceTreeSha256 ?? '')) return err(`${where} codeIdentity`, 'source tree digest malformed');
  if (!Array.isArray(v.sourceClosure) || v.sourceClosure.length === 0 || v.sourceFiles !== v.sourceClosure.length) return err(`${where} codeIdentity`, 'source closure disagrees with its own file count');
  if (v.sourceClosure.some((f) => typeof f !== 'string' || f.length === 0 || f.length > 200)) return err(`${where} codeIdentity`, 'a source closure entry is malformed');
  if (!Array.isArray(v.roots) || v.roots.length === 0 || v.roots.some((f) => !v.sourceClosure.includes(f))) return err(`${where} codeIdentity`, 'a declared root is not inside the closure it produced');
  if (new Set(v.sourceClosure).size !== v.sourceClosure.length) return err(`${where} codeIdentity`, 'the source closure repeats a path');
  if (v.sourceClosure.some((f) => f.startsWith('/') || f.includes('..'))) return err(`${where} codeIdentity`, 'a source closure entry is not a plain repository-relative path');
  if (v.gitCommit !== null && !/^[0-9a-f]{40}$/.test(v.gitCommit)) return err(`${where} codeIdentity`, 'git commit malformed');
  if (v.gitSourceDirty !== null && typeof v.gitSourceDirty !== 'boolean') return err(`${where} codeIdentity`, 'source cleanliness malformed');
  if (!IDENTITY_LAWS.includes(v.law)) return err(`${where} codeIdentity`, 'identity law is not one of the declared states');
  // AND IT IS THE RIGHT ONE. Membership in the vocabulary proves nothing: a recorded dirty closure beside a clean
  // commit label must not be able to claim PRODUCED_BY_COMMITTED_SOURCE. The law is a function of the identity,
  // so it is recomputed from the very fields recorded next to it.
  if (v.law !== identityLaw(v)) return err(`${where} codeIdentity`, 'the recorded identity law is not the law its own commit and cleanliness produce');
  if (!isNonEmptyString(v.note)) return err(`${where} codeIdentity`, 'note malformed');
  return null;
}
const clockRangeError = (v, where) => {
  const k = exactKeys(v, ['minDecisionKnownAtTs', 'maxDecisionKnownAtTs']); if (k) return err(`${where} clockRange`, k);
  const lo = v.minDecisionKnownAtTs; const hi = v.maxDecisionKnownAtTs;
  if (lo === null || hi === null) return lo === null && hi === null ? null : err(`${where} clockRange`, 'one bound is absent while the other is not');
  if (!isTs(lo) || !isTs(hi) || lo > hi) return err(`${where} clockRange`, 'bounds malformed');
  return null;
};

// ---- SNAPSHOT MANIFEST ---------------------------------------------------------------------------------------
export function snapshotManifestError(m) {
  const W = 'snapshot manifest';
  if (m.version !== SNAPSHOT_VERSION || m.pipelineVersion !== PIPELINE_VERSION) return err(W, 'unsupported versions');
  if (!['LIVE_JOURNAL', 'FIXTURE'].includes(m.origin)) return err(W, 'origin is not a declared source kind');
  if (m.origin === 'FIXTURE' ? m.stream !== null : !isNonEmptyString(m.stream, 64)) return err(W, 'stream disagrees with the declared origin');
  let e = exactKeys(m.prefix, ['upperSeq', 'digest', 'digestRecipe']); if (e) return err(`${W} prefix`, e);
  if (!isCount(m.prefix.upperSeq) || m.prefix.upperSeq > LIMITS.maxSourceEvents) return err(`${W} prefix`, 'upperSeq malformed or beyond the source-event bound');
  e = exactKeys(m.prefix.digest, ['version', 'sha256', 'payloadBytes']); if (e) return err(`${W} prefix digest`, e);
  if (m.prefix.digest.version !== PREFIX_DIGEST_VERSION || !SHA256.test(m.prefix.digest.sha256 ?? '') || !isCount(m.prefix.digest.payloadBytes)) return err(`${W} prefix digest`, 'recipe / digest / payload size malformed');
  if (!isNonEmptyString(m.prefix.digestRecipe, 600)) return err(`${W} prefix`, 'digest recipe text malformed');
  const c = m.counts;
  e = exactKeys(c, ['events', 'byType', 'byDossierVersion', 'socialObservations', 'dossierV2', 'dossierV2Projected', 'dossierLegacy', 'dossierContinued', 'shadowSamples', 'shadowRowsSelected', 'unrelated', 'retainedSets', 'selectedRecords']); if (e) return err(`${W} counts`, e);
  for (const n of ['events', 'socialObservations', 'dossierV2', 'dossierV2Projected', 'dossierLegacy', 'dossierContinued', 'shadowSamples', 'shadowRowsSelected', 'unrelated', 'selectedRecords']) if (!isCount(c[n])) return err(`${W} counts`, `${n} is not a nonnegative safe integer`);
  // the SOURCE journal legitimately carries event types beyond the projected kinds: its census is bounded, not narrowed
  e = countMapError(c.byType, `${W} counts.byType`, { maxKeys: 128, keyOk: (k) => /^[A-Z0-9_]{1,64}$/.test(k) }); if (e) return e;
  e = countMapError(c.byDossierVersion, `${W} counts.byDossierVersion`, { maxKeys: 16, keyOk: (k) => k.length > 0 && k.length <= 64 }); if (e) return e;
  if (c.events !== m.prefix.upperSeq) return err(`${W} counts`, 'the event total disagrees with the prefix upper sequence');
  if (Object.values(c.byType).reduce((a, b) => a + b, 0) !== c.events) return err(`${W} counts`, 'the per-type census does not add up to the event total');
  if (c.dossierV2Projected > c.dossierV2 || c.dossierContinued > c.dossierV2) return err(`${W} counts`, 'more dossiers were projected or continued than were seen');
  if (c.selectedRecords !== c.dossierV2Projected + c.shadowSamples) return err(`${W} counts`, 'the selected record total is not the projected dossiers plus shadow samples');
  e = exactKeys(c.retainedSets, ['durableSocialIds', 'dossierSummaries', 'shadowSummaries']); if (e) return err(`${W} counts.retainedSets`, e);
  for (const n of Object.keys(c.retainedSets)) if (!isCount(c.retainedSets[n])) return err(`${W} counts.retainedSets`, `${n} is not a nonnegative safe integer`);
  e = clockRangeError(m.clockRange, W); if (e) return e;
  const pr = m.projectionRecipe;
  e = exactKeys(pr, ['snapshotVersion', 'featureLeaves', 'arrays', 'dossierVersions', 'shadowVersions', 'law']); if (e) return err(`${W} projectionRecipe`, e);
  if (pr.snapshotVersion !== SNAPSHOT_VERSION || pr.featureLeaves !== FEATURE_NAMES.length) return err(`${W} projectionRecipe`, 'recipe identity disagrees with this build');
  if (!Array.isArray(pr.arrays) || pr.arrays.length !== Object.keys(ARRAY_CATALOGUE).length || pr.arrays.some((a) => !(a in ARRAY_CATALOGUE))) return err(`${W} projectionRecipe`, 'the declared array set is not the catalogue');
  if (!isPlainObject(pr.dossierVersions) || !Array.isArray(pr.dossierVersions.projected) || !Array.isArray(pr.dossierVersions.countedOnly)) return err(`${W} projectionRecipe`, 'dossier versions malformed');
  if (!isPlainObject(pr.shadowVersions) || !Array.isArray(pr.shadowVersions.population) || !isNonEmptyString(pr.shadowVersions.recipe, 80)) return err(`${W} projectionRecipe`, 'shadow versions malformed');
  if (!isNonEmptyString(pr.law, 600)) return err(`${W} projectionRecipe`, 'law text malformed'); // repository-defined explanatory text, not input echo
  const p = m.readOnlyProof;
  e = exactKeys(p, ['firstStatement', 'transactionReadOnly', 'transactionIsolation']); if (e) return err(`${W} readOnlyProof`, e);
  if (m.origin === 'FIXTURE') { if (p.firstStatement !== null || p.transactionReadOnly !== 'NOT_APPLICABLE_FIXTURE' || p.transactionIsolation !== 'NOT_APPLICABLE_FIXTURE') return err(`${W} readOnlyProof`, 'a fixture snapshot cannot carry a database read-only proof'); }
  else if (!isNonEmptyString(p.firstStatement, 200) || !isNonEmptyString(p.transactionReadOnly, 40) || !isNonEmptyString(p.transactionIsolation, 40)) return err(`${W} readOnlyProof`, 'a live snapshot must record its server-proved read-only transaction');
  e = codeIdentityError(m.codeIdentity, W); if (e) return e;
  e = limitsError(m.limits, W); if (e) return e;
  if (m.authority !== AUTHORITY || m.purpose !== PURPOSE || !isNonEmptyString(m.note, 400)) return err(W, 'authority / purpose / note law');
  return null;
}

// ---- DATASET MANIFEST + COVERAGE ------------------------------------------------------------------------------
function snapshotInputError(v, where) {
  const k = exactKeys(v, ['manifestSha256', 'snapshotsSha256', 'origin', 'upperSeq', 'prefixDigest']); if (k) return err(where, k);
  if (!SHA256.test(v.manifestSha256 ?? '') || !SHA256.test(v.snapshotsSha256 ?? '')) return err(where, 'snapshot digests malformed');
  if (!['LIVE_JOURNAL', 'FIXTURE'].includes(v.origin) || !isCount(v.upperSeq)) return err(where, 'snapshot origin / upper sequence malformed');
  const dk = exactKeys(v.prefixDigest, ['version', 'sha256', 'payloadBytes']); if (dk) return err(`${where}.prefixDigest`, dk);
  if (v.prefixDigest.version !== PREFIX_DIGEST_VERSION || !SHA256.test(v.prefixDigest.sha256 ?? '') || !isCount(v.prefixDigest.payloadBytes)) return err(`${where}.prefixDigest`, 'prefix digest malformed');
  return null;
}
// ONE consumed-file schema, used by BOTH recorded copies (the dataset's declared archive input and the archive
// census beside it) so the two can never drift into different laws. It preserves the archive's own
// 16-character declared-checksum convention and requires it to agree with the full digest recorded next to it.
// `manifestSha256` is the digest of the archive manifest this inventory is supposed to describe. When it is
// supplied, the inventory must contain that manifest's OWN entry and its digest must be that value — the reader
// consumes manifest.json before any track, so an inventory without it is describing an archive it never opened.
// Two matching inventories that BOTH omit the manifest are still invalid: agreement is not evidence.
export function consumedFilesError(v, where, { manifestSha256 = null } = {}) {
  if (!isPlainObject(v)) return err(where, 'is not an object');
  const names = Object.keys(v);
  if (names.length === 0 || names.length > 64) return err(where, 'consumed-file inventory is empty or unbounded');
  if (manifestSha256 !== null) {
    const own = v['manifest.json'];
    if (own === undefined) return err(where, 'a present archive does not inventory the manifest it was read from');
    if (own !== null && isPlainObject(own)) {
      if (own.sha256 !== manifestSha256) return err(where, 'the inventoried manifest digest is not the archive manifest this artifact declares');
      // the reader records no declared 16-character checksum for the manifest itself — it is not one of its own tracks
      if (own.declaredSha256_16 !== null) return err(where, 'the inventoried manifest carries a declared track checksum it can never have');
    }
  }
  for (let i = 0; i < names.length; i += 1) {
    const f = v[names[i]];
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(names[i]) || names[i].includes('..')) return err(where, `entry ${i + 1} is not a plain file name`);
    const fk = exactKeys(f, ['sha256', 'bytes', 'declaredSha256_16']); if (fk) return err(where, `entry ${i + 1} ${fk}`);
    if (!SHA256.test(f.sha256 ?? '') || !isCount(f.bytes)) return err(where, `entry ${i + 1} digest / size malformed`);
    if (f.declaredSha256_16 !== null && (typeof f.declaredSha256_16 !== 'string' || !/^[0-9a-f]{16}$/.test(f.declaredSha256_16) || f.sha256.slice(0, 16) !== f.declaredSha256_16)) return err(where, `entry ${i + 1} declared checksum disagrees with the recorded digest`);
  }
  return null;
}
function childhoodInputError(v, where) {
  const k = exactKeys(v, ['manifestSha256', 'archiveCreatedTs', 'consumedFiles']); if (k) return err(where, k);
  if (!SHA256.test(v.manifestSha256 ?? '')) return err(where, 'archive manifest digest malformed');
  if (v.archiveCreatedTs !== null && parseUtcInstant(v.archiveCreatedTs) === null) return err(where, `archive creation clock is not a lawful UTC instant (a ${safeType(v.archiveCreatedTs)} was recorded)`);
  return consumedFilesError(v.consumedFiles, `${where}.consumedFiles`, { manifestSha256: v.manifestSha256 });
}
const RECONCILIATION_KEYS = ['dossierRecords', 'primaryRows', 'continued', 'afterAsOf', 'sum', 'legacyDossiersInPrefix'];
const COUNTS_KEYS = ['dossierRecords', 'dossierAfterAsOf', 'dossierContinued', 'primaryRows', 'shadowSamples', 'shadowSamplesAfterAsOf', 'shadowRows', 'episodes', 'coinsPrimary', 'coinsShadow', 'overlapCoins', 'rows', 'labelled', 'reconciliation'];
export function datasetCountsError(c, where) {
  const k = exactKeys(c, COUNTS_KEYS); if (k) return err(where, k);
  for (const n of COUNTS_KEYS) if (n !== 'reconciliation' && !isCount(c[n])) return err(where, `${n} is not a nonnegative safe integer`);
  const rk = exactKeys(c.reconciliation, RECONCILIATION_KEYS); if (rk) return err(`${where}.reconciliation`, rk);
  for (const n of RECONCILIATION_KEYS) if (!isCount(c.reconciliation[n])) return err(`${where}.reconciliation`, `${n} is not a nonnegative safe integer`);
  const r = c.reconciliation;
  if (r.sum !== r.primaryRows + r.continued + r.afterAsOf) return err(`${where}.reconciliation`, 'the selection reconciliation does not add up');
  if (r.sum !== r.dossierRecords) return err(`${where}.reconciliation`, 'selected, continued and excluded dossiers do not account for every dossier record');
  if (r.dossierRecords !== c.dossierRecords || r.primaryRows !== c.primaryRows || r.continued !== c.dossierContinued || r.afterAsOf !== c.dossierAfterAsOf) return err(`${where}.reconciliation`, 'the reconciliation disagrees with the counts beside it');
  if (c.rows !== c.primaryRows + c.shadowRows) return err(where, 'the row total is not the primary plus shadow rows');
  if (c.labelled !== c.rows) return err(where, 'labelled rows and selected rows disagree');
  if (c.episodes > c.primaryRows) return err(where, 'more episodes than primary rows');
  if (c.coinsPrimary > c.primaryRows || c.coinsShadow > c.shadowRows) return err(where, 'more assets than rows carrying them');
  if (c.overlapCoins > Math.min(c.coinsPrimary, c.coinsShadow)) return err(where, 'the cohort asset overlap exceeds either cohort');
  return null;
}
export function coverageStateError(v, where) {
  const k = exactKeys(v, ['state', 'reasons']); if (k) return err(where, k);
  if (!['AVAILABLE', 'PARTIAL', 'UNAVAILABLE'].includes(v.state)) return err(where, 'coverage state is not a declared verdict');
  if (!Array.isArray(v.reasons) || v.reasons.length > 32) return err(where, 'coverage reasons malformed');
  if (v.reasons.some((r) => !COVERAGE_REASONS.includes(r))) return err(where, 'a coverage reason is not a value of its authoritative vocabulary');
  if (v.reasons.some((r, i) => i > 0 && v.reasons[i - 1] >= r)) return err(where, 'coverage reasons are not a sorted unique set');
  return null;
}
const HORIZON_STATE_KEYS = [...LABEL_STATES];
function cohortHorizonsError(v, where) {
  if (!isPlainObject(v)) return err(where, 'is not an object');
  const cohorts = Object.keys(v);
  if (cohorts.some((c) => !COHORTS.includes(c))) return err(where, 'a cohort key is not a declared cohort');
  for (const c of cohorts) {
    const entry = v[c];
    const k = exactKeys(entry, ['rows', 'horizons']); if (k) return err(`${where}.${c}`, k);
    if (!isCount(entry.rows)) return err(`${where}.${c}`, 'row count malformed');
    const hk = exactKeys(entry.horizons, LABEL_HORIZONS_MIN.map((h) => `${h}m`)); if (hk) return err(`${where}.${c}.horizons`, hk);
    for (const h of LABEL_HORIZONS_MIN) {
      const t = entry.horizons[`${h}m`];
      const tk = exactKeys(t, HORIZON_STATE_KEYS); if (tk) return err(`${where}.${c}.horizons.${h}m`, tk);
      let total = 0; for (const s of HORIZON_STATE_KEYS) { if (!isCount(t[s])) return err(`${where}.${c}.horizons.${h}m`, `${s} is not a nonnegative safe integer`); total += t[s]; }
      if (total !== entry.rows) return err(`${where}.${c}.horizons.${h}m`, 'the four state counts do not add up to the cohort row count');
    }
  }
  return null;
}
export function datasetCensusError(v, where, { archiveExpected }) {
  const k = exactKeys(v, ['snapshot', 'archive', 'overlap', 'decisionAnchor', 'rowAvailability', 'unavailableReasons', 'horizons']); if (k) return err(where, k);
  const sk = exactKeys(v.snapshot, ['origin', 'upperSeq', 'events', 'byType', 'dossierV2', 'dossierLegacy', 'dossierContinued', 'shadowSamples', 'clockRange', 'decisionDates']); if (sk) return err(`${where}.snapshot`, sk);
  if (!['LIVE_JOURNAL', 'FIXTURE'].includes(v.snapshot.origin)) return err(`${where}.snapshot`, 'origin malformed');
  for (const n of ['upperSeq', 'events', 'dossierV2', 'dossierLegacy', 'dossierContinued', 'shadowSamples']) if (!isCount(v.snapshot[n])) return err(`${where}.snapshot`, `${n} is not a nonnegative safe integer`);
  let e = countMapError(v.snapshot.byType, `${where}.snapshot.byType`, { maxKeys: 128, keyOk: (x) => /^[A-Z0-9_]{1,64}$/.test(x) }); if (e) return e;
  e = clockRangeError(v.snapshot.clockRange, `${where}.snapshot`); if (e) return e;
  if (v.snapshot.decisionDates !== null) { const dk = exactKeys(v.snapshot.decisionDates, ['from', 'to']); if (dk) return err(`${where}.snapshot.decisionDates`, dk); if (!/^\d{4}-\d{2}-\d{2}$/.test(v.snapshot.decisionDates.from) || !/^\d{4}-\d{2}-\d{2}$/.test(v.snapshot.decisionDates.to)) return err(`${where}.snapshot.decisionDates`, 'dates malformed'); }
  if (archiveExpected ? v.archive === null : v.archive !== null) return err(`${where}.archive`, 'the archive census disagrees with the declared inputs');
  if (v.archive !== null) {
    const a = v.archive;
    const ak = exactKeys(a, ['identity', 'source', 'tracks', 'oneMinuteSymbols', 'observations', 'outcomes', 'consumedFiles', 'limitations']); if (ak) return err(`${where}.archive`, ak);
    const ik = exactKeys(a.identity, ['schemaVersion', 'childhoodVersion', 'archiveCreatedTs', 'archiveCreatedTsMs', 'codeCommit', 'manifestSha256']); if (ik) return err(`${where}.archive.identity`, ik);
    const id = a.identity;
    if (!isNonEmptyString(id.schemaVersion, 80) || !isNonEmptyString(id.childhoodVersion, 80)) return err(`${where}.archive.identity`, 'archive versions malformed');
    if (id.codeCommit !== null && !isNonEmptyString(id.codeCommit, 64)) return err(`${where}.archive.identity`, 'archive code commit malformed');
    if (!SHA256.test(id.manifestSha256 ?? '')) return err(`${where}.archive.identity`, 'manifest digest malformed');
    // the SAME creation clock is recorded twice, as text and as milliseconds: both must be lawful AND agree
    if (id.archiveCreatedTsMs === null ? id.archiveCreatedTs !== null : (!isTs(id.archiveCreatedTsMs) || id.archiveCreatedTs !== isoOf(id.archiveCreatedTsMs))) return err(`${where}.archive.identity`, 'the archive creation clock disagrees with its own millisecond copy');
    // THE PROVENANCE DESCRIPTION IS A CLOSED RECORD TOO. Its declared fields are legitimate bounded provenance text
    // from the Childhood contract and stay allowed; an UNDECLARED key beside them is not the same thing and is
    // refused. (This closes the shape, not "every string".)
    const sk = exactKeys(a.source, ['historicalSourceType', 'sourceLatestTs', 'universeCoverageStatus', 'fastMemoryParityStatus', 'universeToday', 'deepUniverseCount']); if (sk) return err(`${where}.archive.source`, sk);
    for (const [f, max] of [['historicalSourceType', 120], ['sourceLatestTs', 64], ['universeCoverageStatus', 80], ['fastMemoryParityStatus', 80]]) {
      if (a.source[f] !== null && !isNonEmptyString(a.source[f], max)) return err(`${where}.archive.source`, `${f} is neither an explicit null nor bounded provenance text`);
    }
    for (const f of ['universeToday', 'deepUniverseCount']) if (a.source[f] !== null && !isCount(a.source[f])) return err(`${where}.archive.source`, `${f} is neither an explicit null nor a nonnegative safe integer`);
    // every track entry has the shape its reader produces; the track key and its file name must agree
    if (!isPlainObject(a.tracks)) return err(`${where}.archive.tracks`, `is a ${safeType(a.tracks)}, not the per-track census object`);
    const trackKeys = Object.keys(a.tracks);
    if (trackKeys.length === 0 || trackKeys.length > 16) return err(`${where}.archive.tracks`, 'the track census is empty or unbounded');
    let oneMinute = null;
    for (let i = 0; i < trackKeys.length; i += 1) {
      const key = trackKeys[i]; const t = a.tracks[key];
      const mt = /^(\d{1,4})m$/.exec(key); if (!mt) return err(`${where}.archive.tracks`, `entry ${i + 1} is not a <interval>m track key`);
      const tk = exactKeys(t, ['declared', 'present', 'symbols', 'candles', 'fromSec', 'toSec', 'role']); if (tk) return err(`${where}.archive.tracks.${key}`, tk);
      if (typeof t.declared !== 'boolean' || typeof t.present !== 'boolean') return err(`${where}.archive.tracks.${key}`, 'declaration / presence malformed');
      if (t.present && !t.declared) return err(`${where}.archive.tracks.${key}`, 'a present track that the manifest never declared');
      if (!isCount(t.symbols) || !isCount(t.candles)) return err(`${where}.archive.tracks.${key}`, 'symbol / candle counts malformed');
      if (!t.present && (t.symbols !== 0 || t.candles !== 0 || t.fromSec !== null || t.toSec !== null)) return err(`${where}.archive.tracks.${key}`, 'an absent track cannot carry counts or coverage bounds');
      for (const f of ['fromSec', 'toSec']) if (t[f] !== null && (!Number.isSafeInteger(t[f]) || t[f] <= 0)) return err(`${where}.archive.tracks.${key}`, `${f} is neither an explicit null nor epoch seconds`);
      if ((t.fromSec === null) !== (t.toSec === null)) return err(`${where}.archive.tracks.${key}`, 'one coverage bound is absent while the other is not');
      if (t.fromSec !== null && t.fromSec > t.toSec) return err(`${where}.archive.tracks.${key}`, 'coverage bounds are inverted');
      if (t.role !== null && !isNonEmptyString(t.role, 64)) return err(`${where}.archive.tracks.${key}`, 'role is neither an explicit null nor a bounded role name');
      // a declared, present track is a consumed file of the same name; a track that is not present is not
      const file = `candles-${Number(mt[1])}m.jsonl`;
      const consumed = Object.prototype.hasOwnProperty.call(a.consumedFiles ?? {}, file);
      if (t.present !== consumed) return err(`${where}.archive.tracks.${key}`, 'the track presence disagrees with the consumed-file inventory');
      if (key === '1m') oneMinute = t;
    }
    let e2 = consumedFilesError(a.consumedFiles, `${where}.archive.consumedFiles`, { manifestSha256: id.manifestSha256 }); if (e2) return e2;
    // THE 1m SYMBOL INVENTORY is what every label depends on: unique, canonical, sorted, and consistent with the
    // track census that produced it. An empty inventory means no series were loaded — never "some, unrecorded".
    if (!Array.isArray(a.oneMinuteSymbols) || a.oneMinuteSymbols.some((x) => !isCoin(x))) return err(`${where}.archive`, 'the 1m symbol inventory carries a value that is not a canonical asset identity');
    if (a.oneMinuteSymbols.some((x, i) => i > 0 && a.oneMinuteSymbols[i - 1] >= x)) return err(`${where}.archive`, 'the 1m symbol inventory is not a sorted unique set');
    if (oneMinute === null) { if (a.oneMinuteSymbols.length !== 0) return err(`${where}.archive`, 'a 1m symbol inventory exists although no 1m track is recorded'); }
    else if (a.oneMinuteSymbols.length !== oneMinute.symbols) return err(`${where}.archive`, `the 1m symbol inventory lists ${a.oneMinuteSymbols.length} assets but its track census counts ${oneMinute.symbols}`);
    if (a.observations !== null && !isCount(a.observations)) return err(`${where}.archive`, 'observation count malformed');
    if (a.outcomes !== null && !isCount(a.outcomes)) return err(`${where}.archive`, 'outcome count malformed');
    if (!Array.isArray(a.limitations) || a.limitations.some((l) => !/^[A-Z0-9_]{1,64}$/.test(l))) return err(`${where}.archive`, 'limitations malformed');
    if (a.limitations.includes('NO_1M_TRACK') !== (a.oneMinuteSymbols.length === 0)) return err(`${where}.archive`, 'the NO_1M_TRACK limitation disagrees with the recorded 1m inventory');
  }
  const ok = exactKeys(v.overlap, ['rowCoins', 'rowCoinsWithOneMinuteSeries', 'archiveOneMinuteSymbols', 'primaryShadowOverlapCoins', 'temporalOverlap']); if (ok) return err(`${where}.overlap`, ok);
  for (const n of ['rowCoins', 'rowCoinsWithOneMinuteSeries', 'archiveOneMinuteSymbols']) if (!isCount(v.overlap[n])) return err(`${where}.overlap`, `${n} is not a nonnegative safe integer`);
  if (v.overlap.rowCoinsWithOneMinuteSeries > v.overlap.rowCoins) return err(`${where}.overlap`, 'more row assets have series than there are row assets');
  if (!Array.isArray(v.overlap.primaryShadowOverlapCoins) || v.overlap.primaryShadowOverlapCoins.some((c) => !isCoin(c))) return err(`${where}.overlap`, 'the cohort overlap list is malformed');
  if (v.overlap.temporalOverlap !== null && typeof v.overlap.temporalOverlap !== 'boolean') return err(`${where}.overlap`, 'temporal overlap malformed');
  e = exactKeys(v.decisionAnchor, ['KNOWN', 'NOT_YET_KNOWN', 'OUTCOME_UNAVAILABLE']); if (e) return err(`${where}.decisionAnchor`, e);
  for (const n of Object.keys(v.decisionAnchor)) if (!isCount(v.decisionAnchor[n])) return err(`${where}.decisionAnchor`, `${n} is not a nonnegative safe integer`);
  e = exactKeys(v.rowAvailability, ['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']); if (e) return err(`${where}.rowAvailability`, e);
  for (const n of Object.keys(v.rowAvailability)) if (!isCount(v.rowAvailability[n])) return err(`${where}.rowAvailability`, `${n} is not a nonnegative safe integer`);
  e = countMapError(v.unavailableReasons, `${where}.unavailableReasons`, { maxKeys: 32, keyOk: (x) => /^[A-Z0-9_]{1,64}$/.test(x) }); if (e) return e;
  return cohortHorizonsError(v.horizons, `${where}.horizons`);
}
export function datasetManifestError(m) {
  const W = 'dataset manifest';
  if (m.version !== DATASET_MANIFEST_VERSION || m.pipelineVersion !== PIPELINE_VERSION || m.featureRecipeVersion !== FEATURE_RECIPE_VERSION || m.labelRecipeVersion !== LABEL_RECIPE_VERSION) return err(W, 'unsupported versions');
  if (!isTs(m.asOfTs) || m.asOf !== isoOf(m.asOfTs)) return err(W, 'the as-of clock disagrees with its own text copy');
  // INPUTS ARE REQUIRED PROVENANCE. `inputs: null` erases every source identity; a lawful archive-free dataset still
  // records its snapshot input and states inputs.childhood === null explicitly. The two are not the same fact.
  let e = exactKeys(m.inputs, ['snapshot', 'childhood']); if (e) return err(`${W} inputs`, e);
  e = snapshotInputError(m.inputs.snapshot, `${W} inputs.snapshot`); if (e) return e;
  if (m.inputs.childhood !== null) { e = childhoodInputError(m.inputs.childhood, `${W} inputs.childhood`); if (e) return e; }
  e = datasetCountsError(m.counts, `${W} counts`); if (e) return e;
  e = coverageStateError(m.coverage, `${W} coverage`); if (e) return e;
  e = datasetCensusError(m.census, `${W} census`, { archiveExpected: m.inputs.childhood !== null }); if (e) return e;
  // repeated provenance must AGREE: the archive identity in the census is the archive named in the inputs
  if (m.inputs.childhood !== null) {
    const id = m.census.archive.identity;
    if (id.manifestSha256 !== m.inputs.childhood.manifestSha256) return err(`${W} census`, 'the archive census names a different archive than the declared input');
    if (id.archiveCreatedTs !== m.inputs.childhood.archiveCreatedTs) return err(`${W} census`, 'the archive creation clock disagrees between the inputs and the census');
  }
  if (m.census.snapshot.origin !== m.inputs.snapshot.origin || m.census.snapshot.upperSeq !== m.inputs.snapshot.upperSeq) return err(`${W} census`, 'the snapshot census disagrees with the declared snapshot input');
  e = codeIdentityError(m.codeIdentity, W); if (e) return e;
  e = limitsError(m.limits, W); if (e) return e;
  if (m.authority !== AUTHORITY || m.purpose !== PURPOSE || !isNonEmptyString(m.note, 400)) return err(W, 'authority / purpose / note law');
  return null;
}
export function coverageReportError(cov, m) {
  const W = 'dataset coverage report';
  const k = exactKeys(cov, ['version', 'asOfTs', 'state', 'counts', 'census', 'limitations', 'authority', 'purpose']); if (k) return err(W, k);
  if (cov.version !== DATASET_MANIFEST_VERSION) return err(W, 'unsupported version');
  if (cov.asOfTs !== m.asOfTs) return err(W, 'the coverage as-of disagrees with the manifest');
  let e = coverageStateError(cov.state, `${W} state`); if (e) return e;
  e = datasetCountsError(cov.counts, `${W} counts`); if (e) return e;
  e = datasetCensusError(cov.census, `${W} census`, { archiveExpected: m.inputs.childhood !== null }); if (e) return e;
  if (!Array.isArray(cov.limitations) || cov.limitations.length === 0 || cov.limitations.some((l) => !/^[A-Z0-9_]{1,64}$/.test(l))) return err(W, 'limitations malformed');
  if (cov.limitations.some((l, i) => i > 0 && cov.limitations[i - 1] >= l)) return err(W, 'limitations are not a sorted unique set');
  if (cov.authority !== AUTHORITY || cov.purpose !== PURPOSE) return err(W, 'authority law');
  return null;
}

// ---- EVALUATION MANIFEST -------------------------------------------------------------------------------------
export function evaluationManifestError(m) {
  const W = 'evaluation manifest';
  if (m.version !== EVALUATION_VERSION || m.pipelineVersion !== PIPELINE_VERSION || m.splitRecipeVersion !== SPLIT_RECIPE_VERSION) return err(W, 'unsupported versions');
  if (!SHA256.test(m.datasetManifestDigest ?? '')) return err(W, 'dataset manifest digest malformed');
  if (!isTs(m.asOfTs) || !isTs(m.splitAtTs) || m.splitAt !== isoOf(m.splitAtTs) || m.splitAtTs >= m.asOfTs) return err(W, 'the split / as-of clocks are malformed or out of order');
  let e = exactKeys(m.inputs, ['dataset']); if (e) return err(`${W} inputs`, e);
  e = exactKeys(m.inputs.dataset, ['manifestSha256', 'featuresSha256', 'outcomesSha256', 'asOf']); if (e) return err(`${W} inputs.dataset`, e);
  const d = m.inputs.dataset;
  if (!SHA256.test(d.manifestSha256 ?? '') || !SHA256.test(d.featuresSha256 ?? '') || !SHA256.test(d.outcomesSha256 ?? '')) return err(`${W} inputs.dataset`, 'dataset digests malformed');
  if (parseUtcInstant(d.asOf) !== m.asOfTs) return err(`${W} inputs.dataset`, 'the recorded dataset as-of disagrees with the evaluation as-of');
  if (d.manifestSha256 !== m.datasetManifestDigest) return err(W, 'the dataset digest disagrees with its own copy in the inputs');
  e = codeIdentityError(m.codeIdentity, W); if (e) return e;
  e = limitsError(m.limits, W); if (e) return e;
  if (m.authority !== AUTHORITY || m.purpose !== PURPOSE || !isNonEmptyString(m.note, 400)) return err(W, 'authority / purpose / note law');
  return null;
}

// ---- EVALUATION PAYLOAD (C2) ---------------------------------------------------------------------------------
// A REPORT RENDERER IS NOT A VALIDATOR. `report.txt` being the exact rendering of `evaluation.json` proves only that
// the two agree — it renders a negative population or a false "PERFORMED" calibration just as faithfully as a true
// one. This validator therefore runs FIRST and completely, and only then is the rendering required to match it.
const SUMMARY_KEYS = ['n', 'p25', 'median', 'p75', 'min', 'max'];
function summaryError(v, where, { known, sign = null }) {
  const k = exactKeys(v, SUMMARY_KEYS); if (k) return err(where, k);
  if (v.n !== known) return err(where, `summarizes ${v.n} values but its table reports ${known} KNOWN outcomes`);
  const nums = ['p25', 'median', 'p75', 'min', 'max'];
  if (v.n === 0) { if (nums.some((f) => v[f] !== null)) return err(where, 'an empty summary exposes values'); return null; }
  for (const f of nums) if (!isFiniteNum(v[f])) return err(where, `${f} is not a finite number`);
  if (!(v.min <= v.p25 && v.p25 <= v.median && v.median <= v.p75 && v.p75 <= v.max)) return err(where, 'the quantiles are not ordered');
  // ONE observation has ONE value: every order statistic of it is that value. A spread over a single KNOWN outcome
  // is not a summary of anything the recipe could have produced.
  if (v.n === 1 && nums.some((f) => v[f] !== v.median)) return err(where, 'a one-observation summary reports a spread its single value cannot produce');
  if (sign === 'NON_NEGATIVE' && v.min < 0) return err(where, 'a maximum favourable excursion cannot be negative');
  if (sign === 'NON_POSITIVE' && v.max > 0) return err(where, 'a maximum adverse excursion cannot be positive');
  return null;
}
function tableError(t, where, { population = null } = {}) {
  const hk = exactKeys(t, LABEL_HORIZONS_MIN.map((h) => `${h}m`)); if (hk) return err(where, hk);
  for (const h of LABEL_HORIZONS_MIN) {
    const w = `${where}.${h}m`; const v = t[`${h}m`];
    const k = exactKeys(v, ['n', 'counts', 'mfePct', 'maePct', 'logReturnPct']); if (k) return err(w, k);
    if (!isCount(v.n)) return err(w, 'n is not a nonnegative safe integer');
    if (population !== null && v.n !== population) return err(w, `covers ${v.n} rows but its cohort holds ${population}`);
    const ck = exactKeys(v.counts, HORIZON_STATE_KEYS); if (ck) return err(`${w}.counts`, ck);
    let total = 0; for (const s of HORIZON_STATE_KEYS) { if (!isCount(v.counts[s])) return err(`${w}.counts`, `${s} is not a nonnegative safe integer`); total += v.counts[s]; }
    if (total !== v.n) return err(`${w}.counts`, 'the four state counts do not add up to n');
    let e = summaryError(v.mfePct, `${w}.mfePct`, { known: v.counts.KNOWN, sign: 'NON_NEGATIVE' }); if (e) return e;
    e = summaryError(v.maePct, `${w}.maePct`, { known: v.counts.KNOWN, sign: 'NON_POSITIVE' }); if (e) return e;
    const logH = LOG_RETURN_HORIZONS_MIN.includes(h);
    if (!logH) { if (v.logReturnPct !== null) return err(w, 'a non-log horizon carries a log-return summary'); continue; }
    e = summaryError(v.logReturnPct, `${w}.logReturnPct`, { known: v.counts.KNOWN }); if (e) return e;
  }
  return null;
}
// THE COMPOSITE BREAKDOWN GRAMMARS, exactly as the producer builds them.
// `byEntrance` is the row's recorded entrance labels joined with '+'. Its SOURCE ORDER is preserved — the producer
// joins the order the row records, so no new sort is imposed — but every component must be a declared entrance and
// no component may repeat or be empty.
export function entranceCompositeOk(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 96) return false;
  const parts = key.split('+');
  if (parts.length === 0 || parts.length > ENTRANCE_LABELS.length) return false;
  if (parts.some((p) => !ENTRANCE_LABELS.includes(p))) return false;
  return new Set(parts).size === parts.length;
}
// `byProviderContext` is each coverage-provider member rendered `provider:state`, sorted lexically and joined with
// ',', or exactly 'NONE' for an empty provider list. The tokens obey the catalogue's own member law (isCode), the
// member count obeys its bound, and the two forms never mix. Member REPETITION is not forbidden here: the input
// contract does not require unique providers, and this repair closes the composite structure only — it does not
// turn a bounded code domain into an independent provider attestation.
export function providerContextOk(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 400) return false;
  if (key === 'NONE') return true;
  const members = key.split(',');
  if (members.length === 0 || members.length > ARRAY_CATALOGUE.coverageProviders.max) return false;
  for (const m of members) {
    const parts = m.split(':');
    if (parts.length !== 2) return false;
    if (!isCode(parts[0]) || !isCode(parts[1])) return false; // the catalogue's own provider / state token law
  }
  // the producer sorts the rendered members lexically before joining
  for (let i = 1; i < members.length; i += 1) if (members[i - 1] > members[i]) return false;
  return true;
}

const sumStates = (t, s) => LABEL_HORIZONS_MIN.reduce((a, h) => a + t[`${h}m`].counts[s], 0);
export function evaluationPayloadError(e0) {
  const W = 'evaluation';
  if (!isPlainObject(e0)) return err(W, 'is not an object');
  const k = exactKeys(e0, ['version', 'splitRecipeVersion', 'asOfTs', 'splitAtTs', 'state', 'rows', 'grouping', 'supportRule', 'splits', 'learnability', 'tables', 'byEntrance', 'byResearchState', 'byProviderContext', 'byCoverageState', 'shadowSweeps', 'laws', 'authority', 'purpose']); if (k) return err(W, k);
  if (e0.version !== EVALUATION_VERSION || e0.splitRecipeVersion !== SPLIT_RECIPE_VERSION) return err(W, 'unsupported versions');
  if (!isTs(e0.asOfTs) || !isTs(e0.splitAtTs) || e0.splitAtTs >= e0.asOfTs) return err(W, 'the split / as-of clocks are malformed or out of order');
  if (e0.authority !== AUTHORITY || e0.purpose !== PURPOSE) return err(W, 'authority law');
  // ---- state: for THIS no-model, no-calibration implementation these are CONSTANTS, not merely uppercase strings
  const s = e0.state;
  let e = exactKeys(s, ['pipelineExecution', 'dataCoverage', 'evaluation', 'fittedModel', 'stageCalibration', 'currentRuntimeStage', 'calibrationBlockers']); if (e) return err(`${W} state`, e);
  if (s.pipelineExecution !== 'COMPLETE') return err(`${W} state`, 'pipelineExecution is not COMPLETE');
  if (s.evaluation !== 'RETROSPECTIVE_DESCRIPTIVE_ONLY') return err(`${W} state`, 'this pipeline is retrospective and descriptive only');
  if (s.fittedModel !== 'NONE') return err(`${W} state`, 'this pipeline fits no model');
  if (s.stageCalibration !== 'NOT_PERFORMED') return err(`${W} state`, 'this pipeline performs no stage calibration');
  if (s.currentRuntimeStage !== 'UNKNOWN') return err(`${W} state`, 'the live stage is uncalibrated and stays UNKNOWN');
  e = coverageStateError(s.dataCoverage, `${W} state.dataCoverage`); if (e) return e;
  if (!Array.isArray(s.calibrationBlockers) || s.calibrationBlockers.some((b) => !CALIBRATION_BLOCKERS.includes(b))) return err(`${W} state`, 'a calibration blocker is not a declared blocker');
  if (s.calibrationBlockers.some((b, i) => i > 0 && s.calibrationBlockers[i - 1] >= b)) return err(`${W} state`, 'calibration blockers are not a sorted unique set');
  // the permanently-unimplemented blockers can never be dropped while this pipeline has no stage labels or seams
  for (const must of ['NO_INDEPENDENTLY_DEFINED_STAGE_LABELS', 'CLAIM_ASSOCIATION_SEAM_ABSENT', 'SOURCE_PROFILE_HISTORY_NOT_IN_DOSSIER', 'EFFECTIVE_SAMPLE_SUPPORT_UNKNOWN']) if (!s.calibrationBlockers.includes(must)) return err(`${W} state`, `the standing blocker ${must} is missing`);
  // ---- populations
  e = exactKeys(e0.rows, ['total', 'primary', 'shadow']); if (e) return err(`${W} rows`, e);
  for (const n of ['total', 'primary', 'shadow']) if (!isCount(e0.rows[n])) return err(`${W} rows`, `${n} is not a nonnegative safe integer`);
  if (e0.rows.total !== e0.rows.primary + e0.rows.shadow) return err(`${W} rows`, 'the row total is not primary plus shadow');
  if (e0.rows.total > LIMITS.maxSelectedRows) return err(`${W} rows`, 'the row total exceeds the selected row bound');
  // ---- grouping
  const g = e0.grouping;
  e = exactKeys(g, ['law', 'groupingKinds', 'nonGroupingKinds', 'groups', 'edges', 'keysUsed', 'uncertainty', 'groupSummaries', 'groupSummariesTruncated']); if (e) return err(`${W} grouping`, e);
  if (g.law !== 'TRANSITIVE_EPISODE_AND_CONCRETE_PROVENANCE_REFS' || g.uncertainty !== 'A_GROUP_IS_NOT_PROOF_OF_STATISTICAL_INDEPENDENCE') return err(`${W} grouping`, 'the grouping law text is not this recipe');
  if (JSON.stringify(g.groupingKinds) !== JSON.stringify([...GROUPING_DEPENDENCY_KINDS]) || JSON.stringify(g.nonGroupingKinds) !== JSON.stringify([...NON_GROUPING_DEPENDENCY_KINDS])) return err(`${W} grouping`, 'the grouping vocabularies are not the authoritative ones');
  if (!isCount(g.groups) || !isCount(g.edges) || g.edges > LIMITS.maxGroupingEdges) return err(`${W} grouping`, 'group / edge counts malformed');
  if (e0.rows.primary === 0 ? g.groups !== 0 : (g.groups < 1 || g.groups > e0.rows.primary)) return err(`${W} grouping`, 'the group count is impossible for this primary population');
  e = countMapError(g.keysUsed, `${W} grouping.keysUsed`, { maxKeys: 32, keyOk: (x) => /^[A-Z0-9_]{1,64}$/.test(x) }); if (e) return e;
  if (typeof g.groupSummariesTruncated !== 'boolean' || !Array.isArray(g.groupSummaries) || g.groupSummaries.length > 500) return err(`${W} grouping`, 'group summaries malformed or beyond their declared ceiling');
  if (g.groupSummariesTruncated !== (g.groups > 500)) return err(`${W} grouping`, 'the truncation flag disagrees with the group count');
  if (g.groupSummaries.length !== Math.min(g.groups, 500)) return err(`${W} grouping`, 'the number of group summaries disagrees with the group count and its ceiling');
  let summedRows = 0; const bySplit = {}; const rowsBySplit = {};
  for (let i = 0; i < g.groupSummaries.length; i += 1) {
    const w = `${W} grouping.groupSummaries[${i + 1}]`; const gs = g.groupSummaries[i];
    const gk = exactKeys(gs, ['rows', 'split', 'minDecisionKnownAtTs', 'maxDecisionKnownAtTs', 'featureSupportStartTs', 'outcomeSupportEndTs', 'dependenciesTruncated', 'unknownSupport', 'coins']); if (gk) return err(w, gk);
    if (!isCount(gs.rows) || gs.rows < 1 || gs.rows > e0.rows.primary) return err(w, 'a group represents at least one row and never more than the cohort');
    if (!SPLITS.includes(gs.split)) return err(w, 'split is not a declared split');
    if (!isTs(gs.minDecisionKnownAtTs) || !isTs(gs.maxDecisionKnownAtTs) || gs.minDecisionKnownAtTs > gs.maxDecisionKnownAtTs) return err(w, 'decision bounds malformed');
    if (!isTs(gs.featureSupportStartTs) || !isTs(gs.outcomeSupportEndTs)) return err(w, 'support bounds malformed');
    if (gs.featureSupportStartTs > gs.minDecisionKnownAtTs) return err(w, 'feature support starts after the earliest decision it supports');
    if (gs.outcomeSupportEndTs !== Math.max(...[gs.outcomeSupportEndTs]) || gs.outcomeSupportEndTs < gs.maxDecisionKnownAtTs) return err(w, 'outcome support ends before the latest decision it covers');
    if (gs.outcomeSupportEndTs > gs.maxDecisionKnownAtTs + 60_000 + MAX_HORIZON_MS) return err(w, 'outcome support extends beyond the recipe horizon');
    if (typeof gs.dependenciesTruncated !== 'boolean' || typeof gs.unknownSupport !== 'boolean') return err(w, 'truncation / support disclosure malformed');
    if ((gs.dependenciesTruncated || gs.unknownSupport) && gs.split !== 'DESCRIPTIVE_ONLY') return err(w, 'a truncated or unsupported group is not DESCRIPTIVE_ONLY');
    // the recorded split IS the split law applied to this group's own recorded chronology
    const want = splitOfGroup(gs, e0.splitAtTs);
    if (gs.split !== want) return err(w, `is recorded as ${gs.split} although its own chronology places it in ${want}`);
    bySplit[gs.split] = (bySplit[gs.split] ?? 0) + 1; rowsBySplit[gs.split] = (rowsBySplit[gs.split] ?? 0) + gs.rows;
    if (!Array.isArray(gs.coins) || gs.coins.length === 0 || gs.coins.length > 16 || gs.coins.some((c) => !isCoin(c))) return err(w, 'the capped asset list is malformed'); // capped: never the whole universe
    summedRows += gs.rows;
  }
  if (!g.groupSummariesTruncated && summedRows !== e0.rows.primary) return err(`${W} grouping`, 'the complete group summaries do not account for every primary row');
  if (g.groupSummariesTruncated && summedRows > e0.rows.primary) return err(`${W} grouping`, 'the truncated group summaries already exceed the primary population');
  // ---- support rule: authoritative constants, never attacker-supplied numbers
  const sr = e0.supportRule;
  e = exactKeys(sr, ['participationWindowMs', 'wideEyeBaselineMs', 'noticeSupportMs', 'outcomeSupportMs', 'law']); if (e) return err(`${W} supportRule`, e);
  if (sr.participationWindowMs !== PARTICIPATION_SUPPORT_WINDOW_MS || sr.wideEyeBaselineMs !== WIDEEYE_BASELINE_SUPPORT_MS || sr.outcomeSupportMs !== MAX_HORIZON_MS) return err(`${W} supportRule`, 'the support windows are not the recipe constants');
  if (JSON.stringify(sr.noticeSupportMs) !== JSON.stringify({ ...NOTICE_SUPPORT_MS })) return err(`${W} supportRule`, 'the notice support windows are not the recipe constants');
  if (!isNonEmptyString(sr.law, 600)) return err(`${W} supportRule`, 'law text malformed');
  // ---- splits
  const sp = e0.splits;
  e = exactKeys(sp, ['primaryRows', 'groupsBySplit', 'shadowRowsByPeriod']); if (e) return err(`${W} splits`, e);
  e = exactKeys(sp.primaryRows, [...SPLITS]); if (e) return err(`${W} splits.primaryRows`, e);
  e = exactKeys(sp.groupsBySplit, [...SPLITS]); if (e) return err(`${W} splits.groupsBySplit`, e);
  e = exactKeys(sp.shadowRowsByPeriod, ['BEFORE_SPLIT', 'AT_OR_AFTER_SPLIT']); if (e) return err(`${W} splits.shadowRowsByPeriod`, e);
  let primarySum = 0; let groupSum = 0;
  for (const x of SPLITS) {
    if (!isCount(sp.primaryRows[x]) || !isCount(sp.groupsBySplit[x])) return err(`${W} splits`, `${x} counts are not nonnegative safe integers`);
    if (sp.groupsBySplit[x] > sp.primaryRows[x]) return err(`${W} splits`, `${x} claims more groups than rows`);
    primarySum += sp.primaryRows[x]; groupSum += sp.groupsBySplit[x];
  }
  if (primarySum !== e0.rows.primary) return err(`${W} splits`, 'the primary split counts do not add up to the primary population');
  if (groupSum !== g.groups) return err(`${W} splits`, 'the group split counts do not add up to the group total');
  // THE VISIBLE GROUP SUMMARIES AND THE DECLARED SPLIT COUNTS DESCRIBE THE SAME GROUPS. When the summaries are
  // complete, both counts must agree exactly. When they are truncated, only the checkable bound applies — the
  // visible prefix is never treated as if it contained every group.
  for (const x of SPLITS) {
    const seen = bySplit[x] ?? 0; const seenRows = rowsBySplit[x] ?? 0;
    if (!g.groupSummariesTruncated) {
      if (seen !== sp.groupsBySplit[x]) return err(`${W} grouping`, `${seen} recorded group summaries fall in ${x} but the split census declares ${sp.groupsBySplit[x]}`);
      if (seenRows !== sp.primaryRows[x]) return err(`${W} grouping`, `the recorded ${x} groups hold ${seenRows} rows but the split census declares ${sp.primaryRows[x]}`);
    } else if (seen > sp.groupsBySplit[x] || seenRows > sp.primaryRows[x]) return err(`${W} grouping`, `the visible ${x} group summaries already exceed the split census`);
  }
  let shadowSum = 0; for (const p of ['BEFORE_SPLIT', 'AT_OR_AFTER_SPLIT']) { if (!isCount(sp.shadowRowsByPeriod[p])) return err(`${W} splits.shadowRowsByPeriod`, `${p} is not a nonnegative safe integer`); shadowSum += sp.shadowRowsByPeriod[p]; }
  if (shadowSum !== e0.rows.shadow) return err(`${W} splits`, 'the shadow period counts do not add up to the shadow population');
  // ---- tables
  const t = e0.tables;
  e = exactKeys(t, ['primaryAll', 'primaryBySplit', 'shadowByPeriod']); if (e) return err(`${W} tables`, e);
  e = tableError(t.primaryAll, `${W} tables.primaryAll`, { population: e0.rows.primary }); if (e) return e;
  e = exactKeys(t.primaryBySplit, [...SPLITS]); if (e) return err(`${W} tables.primaryBySplit`, e);
  for (const x of SPLITS) { e = tableError(t.primaryBySplit[x], `${W} tables.primaryBySplit.${x}`, { population: sp.primaryRows[x] }); if (e) return e; }
  e = exactKeys(t.shadowByPeriod, ['BEFORE_SPLIT', 'AT_OR_AFTER_SPLIT']); if (e) return err(`${W} tables.shadowByPeriod`, e);
  for (const p of ['BEFORE_SPLIT', 'AT_OR_AFTER_SPLIT']) { e = tableError(t.shadowByPeriod[p], `${W} tables.shadowByPeriod.${p}`, { population: sp.shadowRowsByPeriod[p] }); if (e) return e; }
  // the all-primary table is the SUM over the splits it partitions — not an independently authored total
  for (const h of LABEL_HORIZONS_MIN) for (const st of HORIZON_STATE_KEYS) {
    const parts = SPLITS.reduce((a, x) => a + t.primaryBySplit[x][`${h}m`].counts[st], 0);
    if (t.primaryAll[`${h}m`].counts[st] !== parts) return err(`${W} tables.primaryAll.${h}m`, `the ${st} count is not the sum over the splits it partitions`);
  }
  // ---- learnability
  const l = e0.learnability;
  e = exactKeys(l, ['law', 'horizons']); if (e) return err(`${W} learnability`, e);
  if (!isNonEmptyString(l.law, 400)) return err(`${W} learnability`, 'law text malformed');
  e = exactKeys(l.horizons, LABEL_HORIZONS_MIN.map((h) => `${h}m`)); if (e) return err(`${W} learnability.horizons`, e);
  for (const h of LABEL_HORIZONS_MIN) {
    const w = `${W} learnability.horizons.${h}m`; const v = l.horizons[`${h}m`];
    const lk = exactKeys(v, ['discoveryKnownRetrospectively', 'discoveryTrainableAtSplit', 'validationKnownAtAsOf']); if (lk) return err(w, lk);
    for (const n of Object.keys(v)) if (!isCount(v[n])) return err(w, `${n} is not a nonnegative safe integer`);
    if (v.discoveryTrainableAtSplit > v.discoveryKnownRetrospectively) return err(w, 'more labels are trainable at the split than are known retrospectively');
    // retrospective discovery availability IS that split's KNOWN population; trainability is a subset of it
    if (v.discoveryKnownRetrospectively !== t.primaryBySplit.DISCOVERY[`${h}m`].counts.KNOWN) return err(w, 'retrospective discovery availability disagrees with the DISCOVERY table');
    // EQUALITY, not a one-sided bound. Under the enforced as-of wall every KNOWN validation outcome is by
    // definition available at the evaluation as-of, so this count IS its table's KNOWN count — an undercount is
    // just as false as an overcount, and the previous `>` check let one through.
    if (v.validationKnownAtAsOf !== t.primaryBySplit.VALIDATION[`${h}m`].counts.KNOWN) return err(w, 'the validation labels known at the as-of disagree with the VALIDATION table');
  }
  // ---- breakdowns
  // A BREAKDOWN KEY IS A PROJECTION OF A CLOSED SOURCE VALUE, so it is checked against the domain the producer
  // actually grouped by — never against a character shape. Uppercase is not a vocabulary.
  for (const [name, keyOk, max] of [['byEntrance', entranceCompositeOk, 16], ['byResearchState', (x) => RESEARCH_STATES.includes(x), 16], ['byProviderContext', providerContextOk, 64], ['byCoverageState', (x) => RESEARCH_SOCIAL_COVERAGE_STATES.includes(x), 32]]) {
    e = countMapError(e0[name], `${W} ${name}`, { maxKeys: max, keyOk }); if (e) return e;
    const total = Object.values(e0[name]).reduce((a, b) => a + b, 0);
    if (total !== e0.rows.primary) return err(`${W} ${name}`, `the breakdown covers ${total} rows but the primary cohort holds ${e0.rows.primary}`);
  }
  if (!isCount(e0.shadowSweeps) || (e0.rows.shadow === 0 && e0.shadowSweeps !== 0) || e0.shadowSweeps > e0.rows.shadow) return err(W, 'the shadow sweep count is impossible for this shadow population');
  if (!Array.isArray(e0.laws) || e0.laws.length === 0 || e0.laws.some((x) => !/^[A-Z0-9_]{1,64}$/.test(x))) return err(`${W} laws`, 'the declared laws are malformed');
  for (const must of ['NO_RANDOM_SPLIT', 'NO_FITTED_CUTOFF', 'NO_CLASSIFIER', 'NO_CAUSAL_CLAIM', 'NO_SIGNIFICANCE_CLAIM', 'NO_PROFITABILITY_HEADLINE']) if (!e0.laws.includes(must)) return err(`${W} laws`, `the standing law ${must} is missing`);
  // KNOWN outcomes require a coverage state that admits them
  if (sumStates(t.primaryAll, 'KNOWN') > 0 && s.dataCoverage.state === 'UNAVAILABLE') return err(`${W} state`, 'coverage is UNAVAILABLE while primary outcomes are KNOWN');
  return null;
}
