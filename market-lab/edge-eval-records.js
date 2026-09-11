// MARKET-EDGE closeout — the CLOSED record semantics of the dark edge-evaluation truth chain (research only; never Judge
// release evidence). Six artifact kinds, one append-only chain per evaluation, the SAME validators on write and on read:
//   DECLARED -> EVALUATED (DEVELOPMENT / VALIDATION looks, before the lock) -> SELECTION_LOCKED -> HOLDOUT_OPENED (once)
//   -> DATASET_SEALED (per stage; the holdout dataset binds the open run) -> HOLDOUT_CONSUMED (once; QUALIFIED or
//   CONSUMED_BUT_UNQUALIFIED). A valid digest chain is necessary, never sufficient: a rehashed record with the wrong meaning
//   (a second holdout opening, a lock after the deadline, a dataset for a foreign declaration, a report whose statistics
//   disagree with its manifest) is refused exactly like a record with the wrong hash.
import { deepFreeze, isPlainObject, isTs, isId, exactKeys, canonicalDigest, SHA256_RE, isFiniteNum, isCount } from './contracts.js';

export const EDGE_EVAL_VERSION = 'market-edge-eval-2';
export const EDGE_EVAL_RECORD_KINDS = Object.freeze(['DECLARED', 'EVALUATED', 'SELECTION_LOCKED', 'HOLDOUT_OPENED', 'DATASET_SEALED', 'HOLDOUT_CONSUMED']);
export const EDGE_EVAL_STATES = Object.freeze(['DECLARED', 'DEVELOPMENT_ALLOWED', 'SELECTION_LOCKED', 'HOLDOUT_OPENED', 'HOLDOUT_CONSUMED']);
export const EDGE_STAGES = Object.freeze(['DEVELOPMENT', 'VALIDATION', 'HOLDOUT']);
export const LOOK_STAGES = Object.freeze(['DEVELOPMENT', 'VALIDATION']);
export const EDGE_ARMS = Object.freeze(['EXISTING_MARKET_BASELINE', 'BASELINE_PLUS_DERIVATIVES_PRESSURE', 'BASELINE_PLUS_L3_MICROSTRUCTURE', 'BASELINE_PLUS_BOTH']);
export const QUALIFICATION_STATES = Object.freeze(['QUALIFIED', 'CONSUMED_BUT_UNQUALIFIED']);
export const QUALIFICATION_BLOCKERS = Object.freeze(['DECLARATION_RETROSPECTIVE', 'HOLDOUT_EMPTY', 'HOLDOUT_INSUFFICIENT_N', 'HOLDOUT_UNSCORABLE', 'HOLDOUT_CENSORED']);
export const REPORT_MODES = Object.freeze(['PROSPECTIVE', 'RETROSPECTIVE']);
export const SCORING_LAW = 'spearman-rank-ic per feature / horizon / split over COMPLETE-support rows only; n from the sealed dataset manifest; no threshold, no promotion';
export const SPLIT_LAW = 'chronological blocks in the declared fractions; a decision point whose outcome window (embargo >= max horizon) crosses its block boundary is PURGED; the holdout is sealed until one explicit opening and is consumed by that opening; mirrors the Judge experiment law without importing judge/';
export const FEATURE_STATES = Object.freeze(['COMPLETE', 'PARTIAL', 'MISSING', 'STALE', 'UNVERIFIED']);
export const DECISION_STATES = Object.freeze(['DEVELOPMENT', 'VALIDATION', 'HOLDOUT', 'PURGED', 'OUT_OF_WINDOW']);

const hex64 = (v) => typeof v === 'string' && SHA256_RE.test(v);
const hex64OrNull = (v) => v === null || hex64(v);
const idList = (v, max = 64) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(isId) && new Set(v).size === v.length;
const plain = (v) => isPlainObject(v);

// ---- DECLARATION ---------------------------------------------------------------------------------------------------------------
export const DECLARATION_KEYS = Object.freeze(['evaluationVersion', 'declarationId', 'evaluationId', 'createdTs', 'knownAtTs', 'prospective', 'startTs', 'endTs', 'durationMs', 'fractions', 'embargoMs', 'decisionCadenceMs', 'horizonsMs', 'analyticsIntervalMs', 'l3WindowMs', 'seed', 'policyDigest', 'codeDigest', 'recipeSetVersion', 'recipeDigest', 'subject', 'arms', 'features', 'scoringLaw', 'splitLaw', 'selectionDeadlineTs', 'holdout', 'sourceRoots', 'authority']);
export const SUBJECT_KEYS = Object.freeze(['canonicalCoin', 'spotSymbol', 'futuresSymbol']);
export const HOLDOUT_KEYS = Object.freeze(['startTs', 'endTs', 'fraction', 'oneShot']);
export const SOURCE_ROOT_KEYS = Object.freeze(['bundleKind', 'bundleId', 'manifestSha256']);
export const declarationDigestOf = (d) => { const { declarationId, ...body } = d; void declarationId; return canonicalDigest(body); };
export function declarationError(d, where = 'DECLARED') {
  const k = exactKeys(d, DECLARATION_KEYS, where); if (k) return k;
  if (d.evaluationVersion !== EDGE_EVAL_VERSION || d.authority !== 'NONE') return `${where}: version/authority`;
  if (!isId(d.evaluationId) || !isTs(d.createdTs) || d.knownAtTs !== d.createdTs) return `${where}: identity / creation clock malformed`;
  if (!isTs(d.startTs) || !isTs(d.durationMs) || d.endTs !== d.startTs + d.durationMs) return `${where}: window malformed`;
  if (typeof d.prospective !== 'boolean' || d.prospective !== (d.createdTs <= d.startTs)) return `${where}: prospective disagrees with the creation clock`;
  const fk = exactKeys(d.fractions, ['development', 'validation', 'holdout'], `${where}.fractions`); if (fk) return fk;
  const fs = [d.fractions.development, d.fractions.validation, d.fractions.holdout]; if (!fs.every((f) => isFiniteNum(f) && f >= 0 && f <= 1) || Math.abs(fs[0] + fs[1] + fs[2] - 1) > 1e-9 || fs[0] <= 0 || fs[1] <= 0 || fs[2] <= 0) return `${where}: fractions must be positive unit fractions summing to 1`;
  if (!Array.isArray(d.horizonsMs) || !d.horizonsMs.length || d.horizonsMs.length > 16 || d.horizonsMs.some((h) => !isTs(h)) || new Set(d.horizonsMs).size !== d.horizonsMs.length || d.horizonsMs.some((h, i) => i > 0 && h <= d.horizonsMs[i - 1])) return `${where}: horizons malformed`;
  if (!isTs(d.embargoMs) || d.embargoMs < Math.max(...d.horizonsMs)) return `${where}: embargo must cover the longest horizon`;
  if (!isTs(d.decisionCadenceMs) || d.decisionCadenceMs < 60_000 || !isTs(d.analyticsIntervalMs) || !isTs(d.l3WindowMs)) return `${where}: cadence/interval/window malformed`;
  if (!isId(d.seed) || !hex64(d.policyDigest) || !hex64OrNull(d.codeDigest) || !isId(d.recipeSetVersion) || !hex64(d.recipeDigest)) return `${where}: bindings malformed`;
  const sk = exactKeys(d.subject, SUBJECT_KEYS, `${where}.subject`); if (sk) return sk; if (!/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(String(d.subject.canonicalCoin)) || !isId(d.subject.spotSymbol) || !isId(d.subject.futuresSymbol)) return `${where}: subject malformed`;
  if (!Array.isArray(d.arms) || d.arms.join('|') !== EDGE_ARMS.join('|')) return `${where}: arms must be the four declared feature-set arms`;
  if (!plain(d.features) || Object.keys(d.features).join('|') !== EDGE_ARMS.join('|') || !EDGE_ARMS.every((a) => idList(d.features[a], 64))) return `${where}: per-arm feature sets malformed`;
  if (d.scoringLaw !== SCORING_LAW || d.splitLaw !== SPLIT_LAW) return `${where}: law text`;
  const hk = exactKeys(d.holdout, HOLDOUT_KEYS, `${where}.holdout`); if (hk) return hk;
  const b1 = d.startTs + Math.floor(d.durationMs * d.fractions.development); const b2 = b1 + Math.floor(d.durationMs * d.fractions.validation);
  if (d.holdout.startTs !== b2 || d.holdout.endTs !== d.endTs || d.holdout.fraction !== d.fractions.holdout || d.holdout.oneShot !== true) return `${where}: holdout definition disagrees with the fractions`;
  if (d.selectionDeadlineTs !== b2) return `${where}: the selection deadline is the holdout start`;
  if (!Array.isArray(d.sourceRoots) || d.sourceRoots.length > 32) return `${where}: sourceRoots malformed`;
  for (let i = 0; i < d.sourceRoots.length; i += 1) { const e = exactKeys(d.sourceRoots[i], SOURCE_ROOT_KEYS, `${where}.sourceRoots[${i}]`); if (e) return e; const s = d.sourceRoots[i]; if (!['CAPTURE', 'EDGE_CAPTURE'].includes(s.bundleKind) || !/^mb-[0-9a-f]{64}$/.test(String(s.bundleId)) || !hex64(s.manifestSha256)) return `${where}.sourceRoots[${i}]: malformed`; }
  if (d.declarationId !== `ee-${declarationDigestOf(d)}`) return `${where}: declarationId does not match content`;
  return null;
}

// ---- DATASET MANIFEST ---------------------------------------------------------------------------------------------------------
export const MANIFEST_KEYS = Object.freeze(['manifestVersion', 'manifestDigest', 'evaluationId', 'declarationId', 'declarationDigest', 'stage', 'runId', 'asOfTs', 'sealedTs', 'sources', 'codeDigest', 'policyDigest', 'recipeSetVersion', 'recipeDigest', 'timeRange', 'rowCount', 'rowIdentityDigest', 'splitCounts', 'featureIds', 'horizonsMs', 'availability', 'supportCounts', 'censored', 'coverageSummary']);
export const manifestDigestOf = (m) => { const { manifestDigest, ...body } = m; void manifestDigest; return canonicalDigest(body); };
export function manifestError(m, declaration, where = 'DATASET_SEALED') {
  const k = exactKeys(m, MANIFEST_KEYS, where); if (k) return k;
  if (m.manifestVersion !== EDGE_EVAL_VERSION) return `${where}: version`;
  if (!declaration || m.evaluationId !== declaration.evaluationId || m.declarationId !== declaration.declarationId || m.declarationDigest !== declarationDigestOf(declaration)) return `${where}: not bound to this declaration`;
  if (!EDGE_STAGES.includes(m.stage) || !(m.runId === null || isId(m.runId)) || (m.stage === 'HOLDOUT') !== (m.runId !== null)) return `${where}: stage/run binding`;
  if (!isTs(m.asOfTs) || !isTs(m.sealedTs) || m.sealedTs < m.asOfTs || m.asOfTs < declaration.startTs) return `${where}: clocks outside the declaration`;
  if (!Array.isArray(m.sources) || !m.sources.length || m.sources.length > 32) return `${where}: sources`;
  for (let i = 0; i < m.sources.length; i += 1) { const e = exactKeys(m.sources[i], SOURCE_ROOT_KEYS, `${where}.sources[${i}]`); if (e) return e; const s = m.sources[i]; if (!['CAPTURE', 'EDGE_CAPTURE'].includes(s.bundleKind) || !/^mb-[0-9a-f]{64}$/.test(String(s.bundleId)) || !hex64(s.manifestSha256)) return `${where}.sources[${i}]: malformed`; }
  if (new Set(m.sources.map((s) => s.bundleId)).size !== m.sources.length) return `${where}: duplicate source`;
  if (!hex64OrNull(m.codeDigest) || m.codeDigest !== declaration.codeDigest || m.policyDigest !== declaration.policyDigest || m.recipeSetVersion !== declaration.recipeSetVersion || m.recipeDigest !== declaration.recipeDigest) return `${where}: code/policy/recipe bindings disagree with the declaration`;
  const tk = exactKeys(m.timeRange, ['startTs', 'endTs'], `${where}.timeRange`); if (tk) return tk; if (!isTs(m.timeRange.startTs) || !isTs(m.timeRange.endTs) || m.timeRange.endTs < m.timeRange.startTs || m.timeRange.startTs < declaration.startTs || m.timeRange.endTs > m.asOfTs) return `${where}: time range outside the declaration / as-of`;
  if (!isCount(m.rowCount) || !hex64(m.rowIdentityDigest)) return `${where}: row identity`;
  const sk = exactKeys(m.splitCounts, DECISION_STATES, `${where}.splitCounts`); if (sk) return sk; if (!DECISION_STATES.every((s) => isCount(m.splitCounts[s])) || DECISION_STATES.reduce((a, s) => a + m.splitCounts[s], 0) !== m.rowCount) return `${where}: split counts disagree with the row count`;
  if (!idList(m.featureIds, 64) || m.featureIds.join('|') !== declaration.features.BASELINE_PLUS_BOTH.join('|')) return `${where}: featureIds are not the declared full set`;
  if (!Array.isArray(m.horizonsMs) || m.horizonsMs.join('|') !== declaration.horizonsMs.join('|')) return `${where}: horizons disagree with the declaration`;
  // availability: per split x feature x horizon the count of COMPLETE rows with a known label — the ONLY n a report may claim
  if (!plain(m.availability) || Object.keys(m.availability).join('|') !== EDGE_STAGES.join('|')) return `${where}: availability splits`;
  for (const s of EDGE_STAGES) { const a = m.availability[s]; if (!plain(a) || Object.keys(a).join('|') !== m.featureIds.join('|')) return `${where}: availability features (${s})`; for (const f of m.featureIds) { if (!plain(a[f]) || Object.keys(a[f]).join('|') !== m.horizonsMs.map(String).join('|')) return `${where}: availability horizons (${s}.${f})`; for (const h of m.horizonsMs) { const n = a[f][String(h)]; if (!isCount(n) || n > m.splitCounts[s]) return `${where}: availability count exceeds the split (${s}.${f}.${h})`; } } }
  if (!plain(m.supportCounts) || Object.keys(m.supportCounts).join('|') !== m.featureIds.join('|')) return `${where}: supportCounts`;
  for (const f of m.featureIds) { const c = m.supportCounts[f]; if (!plain(c) || Object.keys(c).join('|') !== FEATURE_STATES.join('|') || !FEATURE_STATES.every((st) => isCount(c[st])) || FEATURE_STATES.reduce((a, st) => a + c[st], 0) !== m.rowCount) return `${where}: supportCounts disagree with the row count (${f})`; }
  if (!plain(m.censored) || Object.keys(m.censored).join('|') !== m.horizonsMs.map(String).join('|') || !m.horizonsMs.every((h) => isCount(m.censored[String(h)]) && m.censored[String(h)] <= m.rowCount)) return `${where}: censored counts`;
  const ck = exactKeys(m.coverageSummary, ['publicObservations', 'darkObservations', 'darkCoverageRecords', 'darkGapRecords'], `${where}.coverageSummary`); if (ck) return ck; if (!Object.values(m.coverageSummary).every(isCount)) return `${where}: coverage summary`;
  if (m.manifestDigest !== manifestDigestOf(m)) return `${where}: manifestDigest does not match content`;
  return null;
}

// ---- REPORT ----------------------------------------------------------------------------------------------------------------------
export const REPORT_KEYS = Object.freeze(['reportVersion', 'reportDigest', 'evaluationId', 'declarationId', 'declarationDigest', 'mode', 'stage', 'runId', 'asOfTs', 'generatedTs', 'datasetDigest', 'codeDigest', 'policyDigest', 'recipeSetVersion', 'recipeDigest', 'scoringLaw', 'splitLaw', 'decisionPoints', 'splitCounts', 'scoredSplit', 'scoredRows', 'minN', 'arms', 'holdout', 'edgeClaim', 'promotionCriteria', 'releaseEvidence', 'authority', 'tradingAuthority', 'judgeAuthority', 'socratesConsumption']);
export const FEATURE_SCORE_KEYS = Object.freeze(['n', 'spearmanIc', 'state']);
export const FEATURE_SCORE_STATES = Object.freeze(['SCORED', 'DEGENERATE', 'INSUFFICIENT_N']);
export const reportDigestOf = (r) => { const { reportDigest, ...body } = r; void reportDigest; return canonicalDigest(body); };
const round8 = (v) => Number(v.toFixed(8));
// closed + recursive + reconciled against the declaration, the sealed manifest and (for the holdout) the lock
export function reportError(r, { declaration, manifest, lock = null }, where = 'REPORT') {
  const k = exactKeys(r, REPORT_KEYS, where); if (k) return k;
  if (r.reportVersion !== EDGE_EVAL_VERSION) return `${where}: version`;
  if (!declaration || r.evaluationId !== declaration.evaluationId || r.declarationId !== declaration.declarationId || r.declarationDigest !== declarationDigestOf(declaration)) return `${where}: not bound to this declaration`;
  if (!REPORT_MODES.includes(r.mode) || (r.mode === 'PROSPECTIVE') !== declaration.prospective) return `${where}: mode disagrees with the declaration`;
  if (!EDGE_STAGES.includes(r.stage) || r.scoredSplit !== r.stage) return `${where}: stage / scored split`;
  if (!manifest || r.datasetDigest !== manifest.manifestDigest || manifest.stage !== r.stage) return `${where}: dataset digest / stage disagree with the sealed manifest`;
  if (!(r.runId === null || isId(r.runId)) || r.runId !== manifest.runId) return `${where}: run binding`;
  if (!isTs(r.asOfTs) || r.asOfTs !== manifest.asOfTs || !isTs(r.generatedTs) || r.generatedTs < manifest.sealedTs) return `${where}: clocks disagree with the manifest`;
  if (r.codeDigest !== declaration.codeDigest || r.policyDigest !== declaration.policyDigest || r.recipeSetVersion !== declaration.recipeSetVersion || r.recipeDigest !== declaration.recipeDigest) return `${where}: bindings disagree with the declaration`;
  if (r.scoringLaw !== SCORING_LAW || r.splitLaw !== SPLIT_LAW) return `${where}: law text`;
  if (r.decisionPoints !== manifest.rowCount) return `${where}: decision points disagree with the manifest`;
  const sk = exactKeys(r.splitCounts, DECISION_STATES, `${where}.splitCounts`); if (sk) return sk; if (DECISION_STATES.some((s) => r.splitCounts[s] !== manifest.splitCounts[s])) return `${where}: split counts disagree with the manifest`;
  if (r.scoredRows !== manifest.splitCounts[r.stage]) return `${where}: scored rows disagree with the manifest`;
  if (!isCount(r.minN) || r.minN < 3) return `${where}: minN`;
  const arms = r.stage === 'HOLDOUT' ? [lock?.arm].filter(Boolean) : [...EDGE_ARMS];
  if (r.stage === 'HOLDOUT' && !lock) return `${where}: a holdout report needs the selection lock`;
  if (!plain(r.arms) || Object.keys(r.arms).join('|') !== arms.join('|')) return `${where}: arms are not the locked selection`;
  const avail = manifest.availability[r.stage];
  for (const arm of arms) {
    const a = r.arms[arm]; const ak = exactKeys(a, ['featureCount', 'horizons'], `${where}.arms.${arm}`); if (ak) return ak;
    const feats = declaration.features[arm]; if (a.featureCount !== feats.length) return `${where}.arms.${arm}: featureCount`;
    if (!plain(a.horizons) || Object.keys(a.horizons).join('|') !== declaration.horizonsMs.map(String).join('|')) return `${where}.arms.${arm}: horizons`;
    for (const h of declaration.horizonsMs) {
      const hz = a.horizons[String(h)]; const hk = exactKeys(hz, ['features', 'scoredFeatures', 'meanAbsIc', 'maxAbsIc'], `${where}.arms.${arm}.${h}`); if (hk) return hk;
      if (!plain(hz.features) || Object.keys(hz.features).join('|') !== feats.join('|')) return `${where}.arms.${arm}.${h}: feature set`;
      const ics = [];
      for (const f of feats) {
        const x = hz.features[f]; const xk = exactKeys(x, FEATURE_SCORE_KEYS, `${where}.arms.${arm}.${h}.${f}`); if (xk) return xk;
        if (x.n !== avail[f][String(h)]) return `${where}.arms.${arm}.${h}.${f}: n disagrees with the sealed manifest`;
        if (!FEATURE_SCORE_STATES.includes(x.state)) return `${where}.arms.${arm}.${h}.${f}: state`;
        if (x.state === 'INSUFFICIENT_N' && (x.n >= r.minN || x.spearmanIc !== null)) return `${where}.arms.${arm}.${h}.${f}: INSUFFICIENT_N contradiction`;
        if (x.state === 'DEGENERATE' && (x.n < r.minN || x.spearmanIc !== null)) return `${where}.arms.${arm}.${h}.${f}: DEGENERATE contradiction`;
        if (x.state === 'SCORED' && (x.n < r.minN || !isFiniteNum(x.spearmanIc) || x.spearmanIc < -1 || x.spearmanIc > 1)) return `${where}.arms.${arm}.${h}.${f}: SCORED contradiction`;
        if (x.spearmanIc !== null) ics.push(Math.abs(x.spearmanIc));
      }
      if (hz.scoredFeatures !== ics.length) return `${where}.arms.${arm}.${h}: scoredFeatures disagree with the features`;
      const mean = ics.length ? round8(ics.reduce((p, q) => p + q, 0) / ics.length) : null; const max = ics.length ? round8(Math.max(...ics)) : null;
      if (hz.meanAbsIc !== mean || hz.maxAbsIc !== max) return `${where}.arms.${arm}.${h}: aggregate statistics disagree with the features`;
    }
  }
  const hk = exactKeys(r.holdout, ['state', 'rows'], `${where}.holdout`); if (hk) return hk;
  if (!['SEALED', 'OPENED'].includes(r.holdout.state) || (r.holdout.state === 'OPENED') !== (r.stage === 'HOLDOUT') || r.holdout.rows !== manifest.splitCounts.HOLDOUT) return `${where}: holdout state disagrees with the stage`;
  if (r.edgeClaim !== 'NOT_MADE' || r.promotionCriteria !== 'NONE' || r.authority !== 'NONE' || r.tradingAuthority !== 'NONE' || r.judgeAuthority !== 'NONE' || r.socratesConsumption !== 'NONE') return `${where}: a dark evaluation never claims edge or authority`;
  if (r.releaseEvidence !== (r.mode === 'RETROSPECTIVE' ? 'NEVER' : 'NONE')) return `${where}: release evidence class`;
  if (r.reportDigest !== reportDigestOf(r)) return `${where}: reportDigest does not match content`;
  return null;
}

// ---- LOCK / OPEN / CONSUMED --------------------------------------------------------------------------------------------------
export const LOCK_KEYS = Object.freeze(['evaluationId', 'declarationDigest', 'arm', 'lockedTs', 'selectionDeadlineTs', 'codeDigest', 'policyDigest', 'recipeDigest', 'lookReportDigests', 'lockDigest']);
export const lockDigestOf = (l) => { const { lockDigest, ...body } = l; void lockDigest; return canonicalDigest(body); };
export function lockError(l, declaration, where = 'SELECTION_LOCKED') {
  const k = exactKeys(l, LOCK_KEYS, where); if (k) return k;
  if (!declaration || l.evaluationId !== declaration.evaluationId || l.declarationDigest !== declarationDigestOf(declaration)) return `${where}: not bound to this declaration`;
  if (!EDGE_ARMS.includes(l.arm)) return `${where}: arm`;
  if (!isTs(l.lockedTs) || l.selectionDeadlineTs !== declaration.selectionDeadlineTs || l.lockedTs > l.selectionDeadlineTs) return `${where}: locked after the selection deadline`;
  if (l.codeDigest !== declaration.codeDigest || l.policyDigest !== declaration.policyDigest || l.recipeDigest !== declaration.recipeDigest) return `${where}: bindings`;
  if (!Array.isArray(l.lookReportDigests) || !l.lookReportDigests.length || l.lookReportDigests.length > 32 || !l.lookReportDigests.every(hex64)) return `${where}: look report digests`;
  if (l.lockDigest !== lockDigestOf(l)) return `${where}: lockDigest`;
  return null;
}
export const OPENED_KEYS = Object.freeze(['evaluationId', 'runId', 'openedTs', 'lockDigest', 'arm', 'declarationDigest', 'codeDigest', 'policyDigest', 'recipeDigest', 'sourceRoots', 'openingDigest']);
export const openingDigestOf = (o) => { const { openingDigest, ...body } = o; void openingDigest; return canonicalDigest(body); };
export function openedError(o, declaration, lock, where = 'HOLDOUT_OPENED') {
  const k = exactKeys(o, OPENED_KEYS, where); if (k) return k;
  if (!declaration || !lock || o.evaluationId !== declaration.evaluationId || o.declarationDigest !== declarationDigestOf(declaration) || o.lockDigest !== lock.lockDigest || o.arm !== lock.arm) return `${where}: not bound to this declaration / lock`;
  if (!isId(o.runId) || !isTs(o.openedTs) || o.openedTs < lock.lockedTs) return `${where}: run / clock`;
  if (o.codeDigest !== declaration.codeDigest || o.policyDigest !== declaration.policyDigest || o.recipeDigest !== declaration.recipeDigest) return `${where}: bindings`;
  if (!Array.isArray(o.sourceRoots) || !o.sourceRoots.length || o.sourceRoots.length > 32) return `${where}: sourceRoots`;
  for (let i = 0; i < o.sourceRoots.length; i += 1) { const e = exactKeys(o.sourceRoots[i], SOURCE_ROOT_KEYS, `${where}.sourceRoots[${i}]`); if (e) return e; }
  if (o.openingDigest !== openingDigestOf(o)) return `${where}: openingDigest`;
  return null;
}
export const CONSUMED_KEYS = Object.freeze(['evaluationId', 'runId', 'consumedTs', 'openingDigest', 'datasetDigest', 'reportDigest', 'qualification']);
export function consumedError(c, { declaration, opened, manifest, report }, where = 'HOLDOUT_CONSUMED') {
  const k = exactKeys(c, CONSUMED_KEYS, where); if (k) return k;
  if (!declaration || !opened || c.evaluationId !== declaration.evaluationId || c.runId !== opened.runId || c.openingDigest !== opened.openingDigest) return `${where}: not bound to the opened run`;
  if (!isTs(c.consumedTs) || c.consumedTs < opened.openedTs) return `${where}: clock`;
  if (!manifest || c.datasetDigest !== manifest.manifestDigest || manifest.runId !== opened.runId || manifest.stage !== 'HOLDOUT') return `${where}: dataset is not the holdout dataset of this run`;
  if (!report || c.reportDigest !== report.reportDigest || report.runId !== opened.runId || report.stage !== 'HOLDOUT') return `${where}: report is not the holdout report of this run`;
  const qk = exactKeys(c.qualification, ['status', 'blockers'], `${where}.qualification`); if (qk) return qk;
  if (!QUALIFICATION_STATES.includes(c.qualification.status) || !Array.isArray(c.qualification.blockers) || !c.qualification.blockers.every((b) => QUALIFICATION_BLOCKERS.includes(b)) || new Set(c.qualification.blockers).size !== c.qualification.blockers.length) return `${where}: qualification`;
  if ((c.qualification.status === 'QUALIFIED') !== (c.qualification.blockers.length === 0)) return `${where}: qualification status contradicts its blockers`;
  return null;
}

// ---- the chain law: one record against the verified records before it ------------------------------------------------------------
export const RECORD_KEYS = Object.freeze(['kind', 'record']);
// W2: the declaration's own creation clock must be the runtime clock of the row that carries it (a typed / backdated createdTs
// that claims prospectivity is refused; a small tolerance covers two reads of a live clock)
export const DECLARATION_CLOCK_TOLERANCE_MS = 5_000;
export function chainStateOf(rows) {
  const declared = rows.find((r) => r.kind === 'DECLARED')?.record ?? null; const lock = rows.find((r) => r.kind === 'SELECTION_LOCKED')?.record ?? null; const opened = rows.find((r) => r.kind === 'HOLDOUT_OPENED')?.record ?? null; const consumed = rows.find((r) => r.kind === 'HOLDOUT_CONSUMED')?.record ?? null;
  const state = !declared ? null : consumed ? 'HOLDOUT_CONSUMED' : opened ? 'HOLDOUT_OPENED' : lock ? 'SELECTION_LOCKED' : rows.some((r) => r.kind === 'EVALUATED') ? 'DEVELOPMENT_ALLOWED' : 'DECLARED';
  return { state, declaration: declared, lock, opened, consumed, looks: rows.filter((r) => r.kind === 'EVALUATED').map((r) => r.record), datasets: rows.filter((r) => r.kind === 'DATASET_SEALED').map((r) => r.record) };
}
export function recordSemanticsError(row, prior, where = `record ${row?.seq ?? '?'}`) {
  if (!isPlainObject(row) || !EDGE_EVAL_RECORD_KINDS.includes(row.kind) || !isPlainObject(row.record)) return `${where}: shape`;
  const st = chainStateOf(prior); const d = st.declaration; const rec = row.record;
  if (row.kind === 'DECLARED') { if (d) return `${where}: a second declaration`; if (prior.length) return `${where}: DECLARED must be first`; const e = declarationError(rec, where); if (e) return e; if (isTs(row.createdTs) && (rec.createdTs > row.createdTs || row.createdTs - rec.createdTs > DECLARATION_CLOCK_TOLERANCE_MS)) return `${where}: the declaration clock is not the runtime clock of its record (backdated or future-dated)`; return null; }
  if (!d) return `${where}: nothing declared`;
  if (st.state === 'HOLDOUT_CONSUMED') return `${where}: the holdout is consumed; the chain is closed`;
  if (row.kind === 'DATASET_SEALED') { const e = manifestError(rec, d, where); if (e) return e; if (rec.stage === 'HOLDOUT') { if (!st.opened) return `${where}: a holdout dataset needs the opened run`; if (rec.runId !== st.opened.runId) return `${where}: holdout dataset run mismatch`; if (st.datasets.some((m) => m.stage === 'HOLDOUT')) return `${where}: the holdout dataset is sealed once`; } else if (st.lock) return `${where}: no development / validation dataset after the lock`; if (st.datasets.some((m) => m.manifestDigest === rec.manifestDigest)) return `${where}: duplicate dataset`; return null; }
  if (row.kind === 'EVALUATED') { const ek = exactKeys(rec, ['stage', 'report'], where); if (ek) return ek; if (!LOOK_STAGES.includes(rec.stage)) return `${where}: a look is DEVELOPMENT or VALIDATION`; if (st.lock) return `${where}: no look after the selection lock`; const m = st.datasets.find((x) => x.manifestDigest === rec.report?.datasetDigest); if (!m) return `${where}: the report cites no sealed dataset of this chain`; if (rec.report.stage !== rec.stage) return `${where}: report stage`; return reportError(rec.report, { declaration: d, manifest: m }, `${where}.report`); }
  if (row.kind === 'SELECTION_LOCKED') { if (st.lock) return `${where}: a second selection lock`; if (!st.looks.length) return `${where}: a lock needs at least one look`; const e = lockError(rec, d, where); if (e) return e; const digests = st.looks.map((l) => l.report.reportDigest); if (!rec.lookReportDigests.every((x) => digests.includes(x))) return `${where}: a cited look is not in this chain`; return null; }
  if (row.kind === 'HOLDOUT_OPENED') { if (!st.lock) return `${where}: the holdout opens only after the selection lock`; if (st.opened) return `${where}: the holdout was already opened (one shot)`; const e = openedError(rec, d, st.lock, where); if (e) return e; if (rec.sourceRoots.length !== d.sourceRoots.length || !rec.sourceRoots.every((s, i) => s.bundleId === d.sourceRoots[i].bundleId && s.manifestSha256 === d.sourceRoots[i].manifestSha256)) return `${where}: the opening must name the declared source roots`; return null; }
  if (row.kind === 'HOLDOUT_CONSUMED') { if (!st.opened) return `${where}: nothing opened`; const m = st.datasets.find((x) => x.stage === 'HOLDOUT' && x.runId === st.opened.runId); if (!m) return `${where}: no sealed holdout dataset for the run`; const ck = exactKeys(rec, [...CONSUMED_KEYS, 'report'], where); if (ck) return ck; const { report, ...c } = rec; const re = reportError(report, { declaration: d, manifest: m, lock: st.lock }, `${where}.report`); if (re) return re; return consumedError(c, { declaration: d, opened: st.opened, manifest: m, report }, where); }
  return `${where}: unknown kind`;
}
export function verifyRecordSemantics(rows) { for (let i = 0; i < rows.length; i += 1) { const e = recordSemanticsError(rows[i], rows.slice(0, i)); if (e) return { ok: false, seq: rows[i].seq ?? i + 1, reason: e }; } return { ok: true }; }
export const freezeRecord = (r) => deepFreeze(structuredClone(r));
