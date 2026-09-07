// SOCIAL-5B §10 — CHRONOLOGICAL, DEPENDENCY-AWARE EVALUATION (auditable description, NOT model training).
// The split-at boundary B is explicit and recorded before any outcome is read; there is no random split, shuffle,
// fitted cutoff, outcome-selected date, grid search or classifier. Rows are grouped conservatively by episode
// identity and by shared CONCRETE provenance refs (namespaced kind+id, transitive); generic DOSSIER_FIELD /
// COVERAGE_BOUNDARY / SOCIAL_FEATURE_WINDOW labels never connect rows. A group is not proof of statistical
// independence, and truncated dependency coverage or an undocumented feature support makes a group DESCRIPTIVE_ONLY.
// Feature support starts at the EARLIEST applicable clock: the recorded episode onset, the earliest retained concrete
// dependency clock, and featureAsOfTs minus each non-null feature's documented lookback (participation windows
// 8,100,000 ms; wide-eye z-scores seven days; 24h volume one day; ...). Outcome support ends at anchor + 240 min for
// every primary row. A group crossing B on those intervals is EMBARGOED as a whole. Per-row / per-horizon as-of
// learnability (label knowable at B for discovery; at the dataset as-of for validation) is tracked SEPARATELY from
// retrospective availability: an archive acquired after B supports descriptive tables, never a claim that a model
// could have learned those labels at B. Shadow rows form separate descriptive tables. No causal or significance claim.
import { EVALUATION_VERSION, SPLIT_RECIPE_VERSION, LABEL_HORIZONS_MIN, LOG_RETURN_HORIZONS_MIN, MAX_HORIZON_MS, FEATURE_CATALOGUE, NOTICE_SUPPORT_MS, GROUPING_DEPENDENCY_KINDS, SPLITS, CALIBRATION_BLOCKERS, LIMITS, AUTHORITY, PURPOSE, fail, isTs, isFiniteNum, summarize, deepFreeze, isoOf, PARTICIPATION_SUPPORT_WINDOW_MS, WIDEEYE_BASELINE_SUPPORT_MS } from './contracts.js';
import { anchorOf } from './outcomes.js';
import { validateFeatureRow } from './features.js';
import { validateOutcomeRow } from './outcomes.js';

const TRIGGER_KIND_TO_DEPENDENCY = { PARTICIPATION_LED: 'SOCIAL_SOURCE', MARKET_LED: 'WIDE_EYE_NOTICE', INFORMATION_LED: 'CLAIM' };
const SPEC_BY_NAME = new Map(FEATURE_CATALOGUE.map((f) => [f.name, f]));
class UnionFind { constructor() { this.p = new Map(); } find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; } return r; } union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); } }

// the conservative feature-support start of ONE primary row, plus whether every non-null feature has documented finite support
export function featureSupportOf(row) {
  const f = row.features; const starts = []; let unknown = [];
  const onset = f['episode.onsetKnownAtTs']; if (isTs(onset)) starts.push(onset);
  for (const n of row.arrays.dependencyNodes ?? []) if (GROUPING_DEPENDENCY_KINDS.includes(n.kind) && isTs(n.knownAtTs)) starts.push(n.knownAtTs);
  for (const [name, v] of Object.entries(f)) {
    if (v === null) continue; const spec = SPEC_BY_NAME.get(name); if (!spec) continue;
    const s = spec.support;
    if (s.kind === 'FIXED_MS') starts.push(row.featureAsOfTs - s.ms);
    else if (s.kind === 'ROW_CLOCK') { const c = f[s.leaf]; if (isTs(c)) starts.push(c); else unknown.push(name); }
    else if (s.kind === 'UNKNOWN') unknown.push(name);
  }
  for (const nt of row.arrays.notices ?? []) for (const [k, ms] of Object.entries(NOTICE_SUPPORT_MS)) if (nt[k] !== null && nt[k] !== undefined) starts.push(row.featureAsOfTs - ms);
  unknown = [...new Set(unknown)].sort();
  return { featureSupportStartTs: starts.length ? Math.min(...starts) : row.featureAsOfTs, supportKnown: unknown.length === 0, unknownSupportFeatures: unknown.slice(0, 32) };
}
export const outcomeSupportEndOf = (row) => anchorOf(row.decisionKnownAtTs).anchorTsMs + MAX_HORIZON_MS;

// namespaced grouping keys of a primary row (episode identity + concrete provenance refs)
export function groupingKeysOf(row) {
  const keys = new Set([`EPISODE:${row.episodeId}`]);
  for (const n of row.arrays.dependencyNodes ?? []) if (GROUPING_DEPENDENCY_KINDS.includes(n.kind)) keys.add(`${n.kind}:${n.id}`);
  for (const t of row.arrays.triggers ?? []) { const k = TRIGGER_KIND_TO_DEPENDENCY[t.kind]; if (k) keys.add(`${k}:${t.ref}`); }
  return [...keys].sort();
}
const dependenciesTruncated = (row) => row.features['dependencies.truncated'] === true || (row.features['dependencies.omitted.socialSources'] ?? 0) > 0 || (row.features['dependencies.omitted.edges'] ?? 0) > 0;
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const stateCounts = () => ({ KNOWN: 0, CENSORED: 0, NOT_YET_KNOWN: 0, OUTCOME_UNAVAILABLE: 0 });

// THE DATASET AS-OF WALL AND THE ONE-TO-ONE ROW LAW.
// Generation masks correctly for the as-of it was given; REOPENING must prove the saved rows still belong to that
// as-of. A dataset is only meaningful under the clock it was frozen for, so a row whose decision, inputs, reference
// price or KNOWN horizon reaches past the supplied as-of — or which masks a value that clock could already see — is
// a CORRUPT INPUT. Rows are never silently re-dated and an archive clock is never adjusted to make a bad row valid.
// Identity is exact SET equality (unique feature ids, unique outcome ids, a bijection), never equal counts: two
// copies of one feature beside an orphan label must not balance the books.
export function datasetJoinError({ featureRows, outcomeRows, asOfTs }) {
  if (!Array.isArray(featureRows) || !Array.isArray(outcomeRows)) return { error: 'dataset: feature and outcome rows must be lists' };
  if (!isTs(asOfTs)) return { error: 'dataset: an as-of clock is required to reopen a dataset' };
  const byId = new Map();
  for (const o of outcomeRows) {
    const e = validateOutcomeRow(o); if (e) return { error: e };
    if (byId.has(o.rowId)) return { error: `dataset: duplicate outcome row ${o.rowId}` };
    byId.set(o.rowId, o);
  }
  const seen = new Set(); const rows = [];
  for (const r of featureRows) {
    const e = validateFeatureRow(r); if (e) return { error: e };
    if (seen.has(r.rowId)) return { error: `dataset: duplicate feature row ${r.rowId}` };
    seen.add(r.rowId);
    const o = byId.get(r.rowId); if (!o) return { error: `dataset: feature row ${r.rowId} has no outcome row` };
    if (o.canonicalCoin !== r.canonicalCoin || o.decisionKnownAtTs !== r.decisionKnownAtTs || o.cohort !== r.cohort) return { error: `dataset: outcome row ${r.rowId} disagrees with its feature row` };
    if (r.featureAsOfTs > asOfTs || r.decisionKnownAtTs > asOfTs) return { error: `dataset: feature row ${r.rowId} decides at ${isoOf(r.decisionKnownAtTs)}, after the dataset as-of ${isoOf(asOfTs)}` };
    if (r.cohort === 'PRIMARY' && r.features['decision.latestInputKnownAtTs'] > asOfTs) return { error: `dataset: feature row ${r.rowId} carries an input known after the dataset as-of ${isoOf(asOfTs)}` };
    const ref = o.reference;
    if (ref.state === 'KNOWN' && ref.knownAtTs > asOfTs) return { error: `dataset: outcome row ${r.rowId} exposes a reference price knowable only at ${isoOf(ref.knownAtTs)}, after the as-of ${isoOf(asOfTs)}` };
    if (ref.state === 'NOT_YET_KNOWN' && ref.knownAtTs <= asOfTs) return { error: `dataset: outcome row ${r.rowId} masks a reference price already knowable at the dataset as-of` };
    for (const h of LABEL_HORIZONS_MIN) {
      const x = o.horizons[`${h}m`];
      if ((x.state === 'KNOWN' || x.state === 'CENSORED') && x.outcomeKnownAtTs > asOfTs) return { error: `dataset: outcome row ${r.rowId} horizon ${h}m is ${x.state} although it becomes knowable only at ${isoOf(x.outcomeKnownAtTs)}` };
      if (x.state === 'NOT_YET_KNOWN' && x.outcomeKnownAtTs <= asOfTs) return { error: `dataset: outcome row ${r.rowId} horizon ${h}m is masked although it was knowable at the dataset as-of` };
    }
    rows.push({ f: r, o });
  }
  if (byId.size !== rows.length) return { error: 'dataset: outcome rows exist without a feature row' };
  return { rows };
}

export function evaluateDataset({ featureRows, outcomeRows, asOfTs, splitAtTs, coverageState = null, limits = LIMITS } = {}) {
  if (!isTs(asOfTs) || !isTs(splitAtTs)) fail('INVALID_REQUEST', 'as-of and split-at clocks are required');
  if (splitAtTs >= asOfTs) fail('INVALID_REQUEST', 'split-at must be earlier than the dataset as-of');
  const joined = datasetJoinError({ featureRows, outcomeRows, asOfTs }); if (joined.error) fail('CORRUPT_INPUT', joined.error);
  const rows = joined.rows;
  const primary = rows.filter((x) => x.f.cohort === 'PRIMARY'); const shadow = rows.filter((x) => x.f.cohort === 'SHADOW');
  // ---- grouping (primary only) ----
  const uf = new UnionFind(); const keyOwner = new Map(); let edges = 0; const keysUsed = {};
  for (const x of primary) {
    const rid = `ROW:${x.f.rowId}`; uf.find(rid);
    for (const k of groupingKeysOf(x.f)) { bump(keysUsed, k.split(':')[0]); const owner = keyOwner.get(k); if (owner) { uf.union(rid, owner); edges += 1; if (edges > limits.maxGroupingEdges) fail('RESOURCE_LIMIT_EXCEEDED', 'dependency grouping exceeds the edge limit'); } else keyOwner.set(k, rid); }
  }
  const groups = new Map();
  for (const x of primary) { const g = uf.find(`ROW:${x.f.rowId}`); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
  // ---- split assignment per group ----
  const splitOfRow = new Map(); const groupSummaries = [];
  for (const [gid, members] of groups) {
    const supports = members.map((x) => featureSupportOf(x.f));
    const minDecision = Math.min(...members.map((x) => x.f.decisionKnownAtTs)); const maxDecision = Math.max(...members.map((x) => x.f.decisionKnownAtTs));
    const minSupport = Math.min(...supports.map((s) => s.featureSupportStartTs)); const maxOutcomeEnd = Math.max(...members.map((x) => outcomeSupportEndOf(x.f)));
    const truncated = members.some((x) => dependenciesTruncated(x.f)); const unknownSupport = supports.some((s) => !s.supportKnown);
    let split;
    if (truncated || unknownSupport) split = 'DESCRIPTIVE_ONLY';
    else if (maxDecision < splitAtTs && maxOutcomeEnd <= splitAtTs) split = 'DISCOVERY';
    else if (minDecision >= splitAtTs && minSupport >= splitAtTs) split = 'VALIDATION';
    else split = 'EMBARGOED';
    for (const x of members) splitOfRow.set(x.f.rowId, split);
    groupSummaries.push({ rows: members.length, split, minDecisionKnownAtTs: minDecision, maxDecisionKnownAtTs: maxDecision, featureSupportStartTs: minSupport, outcomeSupportEndTs: maxOutcomeEnd, dependenciesTruncated: truncated, unknownSupport, coins: [...new Set(members.map((x) => x.f.canonicalCoin))].sort().slice(0, 16) });
  }
  groupSummaries.sort((a, b) => a.minDecisionKnownAtTs - b.minDecisionKnownAtTs || a.rows - b.rows);
  // ---- tables ----
  const table = () => Object.fromEntries(LABEL_HORIZONS_MIN.map((h) => [`${h}m`, { n: 0, counts: stateCounts(), mfePct: [], maePct: [], logReturnPct: LOG_RETURN_HORIZONS_MIN.includes(h) ? [] : null }]));
  const finalize = (t) => Object.fromEntries(Object.entries(t).map(([h, v]) => [h, { n: v.n, counts: v.counts, mfePct: summarize(v.mfePct), maePct: summarize(v.maePct), logReturnPct: v.logReturnPct === null ? null : summarize(v.logReturnPct) }]));
  const add = (t, o) => { for (const h of LABEL_HORIZONS_MIN) { const k = `${h}m`; const x = o.horizons[k]; t[k].n += 1; bump(t[k].counts, x.state); if (x.state === 'KNOWN') { t[k].mfePct.push(x.mfePct); t[k].maePct.push(x.maePct); if (t[k].logReturnPct) t[k].logReturnPct.push(x.logReturnPct); } } };
  const primaryTables = Object.fromEntries(SPLITS.map((s) => [s, table()])); const allPrimary = table();
  const learn = Object.fromEntries(LABEL_HORIZONS_MIN.map((h) => [`${h}m`, { discoveryKnownRetrospectively: 0, discoveryTrainableAtSplit: 0, validationKnownAtAsOf: 0 }]));
  const byEntrance = {}; const byResearchState = {}; const byProviderContext = {}; const byCoverageState = {}; const bySplit = Object.fromEntries(SPLITS.map((s) => [s, 0]));
  for (const x of primary) {
    const s = splitOfRow.get(x.f.rowId); bySplit[s] += 1; add(primaryTables[s], x.o); add(allPrimary, x.o);
    bump(byEntrance, x.f.entrances.join('+')); bump(byResearchState, x.f.researchState); bump(byCoverageState, x.f.features['participation.coverage.state']);
    const provs = (x.f.arrays.coverageProviders ?? []).map((p) => `${p.provider}:${p.state}`).sort(); bump(byProviderContext, provs.length ? provs.join(',') : 'NONE');
    for (const h of LABEL_HORIZONS_MIN) { const k = `${h}m`; const hx = x.o.horizons[k]; if (hx.state !== 'KNOWN') continue; if (s === 'DISCOVERY') { learn[k].discoveryKnownRetrospectively += 1; if (hx.outcomeKnownAtTs <= splitAtTs) learn[k].discoveryTrainableAtSplit += 1; } if (s === 'VALIDATION' && hx.outcomeKnownAtTs <= asOfTs) learn[k].validationKnownAtAsOf += 1; }
  }
  const shadowTables = { BEFORE_SPLIT: table(), AT_OR_AFTER_SPLIT: table() }; const shadowBySweep = {};
  for (const x of shadow) { add(shadowTables[x.f.decisionKnownAtTs < splitAtTs ? 'BEFORE_SPLIT' : 'AT_OR_AFTER_SPLIT'], x.o); bump(shadowBySweep, x.f.sweepId); }
  // ---- state dimensions ----
  const known = LABEL_HORIZONS_MIN.reduce((s, h) => s + allPrimary[`${h}m`].counts.KNOWN, 0);
  const blockers = new Set(['NO_INDEPENDENTLY_DEFINED_STAGE_LABELS', 'CLAIM_ASSOCIATION_SEAM_ABSENT', 'SOURCE_PROFILE_HISTORY_NOT_IN_DOSSIER', 'EFFECTIVE_SAMPLE_SUPPORT_UNKNOWN']);
  if (primary.length === 0) blockers.add('NO_RESEARCH_HISTORY');
  if (known === 0) blockers.add('INSUFFICIENT_TEMPORAL_COVERAGE');
  if (Object.values(learn).every((l) => l.discoveryTrainableAtSplit === 0)) blockers.add('NO_AS_OF_TRAINABLE_LABELS');
  if (coverageState && coverageState.reasons?.includes('CHILDHOOD_ARCHIVE_NOT_SUPPLIED')) blockers.add('ARCHIVE_NOT_SUPPLIED');
  const evaluation = deepFreeze({
    version: EVALUATION_VERSION, splitRecipeVersion: SPLIT_RECIPE_VERSION, asOfTs, splitAtTs,
    state: { pipelineExecution: 'COMPLETE', dataCoverage: coverageState ?? { state: primary.length ? (known ? 'PARTIAL' : 'UNAVAILABLE') : 'UNAVAILABLE', reasons: [] }, evaluation: 'RETROSPECTIVE_DESCRIPTIVE_ONLY', fittedModel: 'NONE', stageCalibration: 'NOT_PERFORMED', currentRuntimeStage: 'UNKNOWN', calibrationBlockers: [...blockers].filter((b) => CALIBRATION_BLOCKERS.includes(b)).sort() },
    rows: { total: rows.length, primary: primary.length, shadow: shadow.length },
    grouping: { law: 'TRANSITIVE_EPISODE_AND_CONCRETE_PROVENANCE_REFS', groupingKinds: [...GROUPING_DEPENDENCY_KINDS], nonGroupingKinds: ['DOSSIER_FIELD', 'COVERAGE_BOUNDARY', 'SOCIAL_FEATURE_WINDOW'], groups: groups.size, edges, keysUsed, uncertainty: 'A_GROUP_IS_NOT_PROOF_OF_STATISTICAL_INDEPENDENCE', groupSummaries: groupSummaries.slice(0, 500), groupSummariesTruncated: groupSummaries.length > 500 },
    supportRule: { participationWindowMs: PARTICIPATION_SUPPORT_WINDOW_MS, wideEyeBaselineMs: WIDEEYE_BASELINE_SUPPORT_MS, noticeSupportMs: { ...NOTICE_SUPPORT_MS }, outcomeSupportMs: MAX_HORIZON_MS, law: 'featureSupportStart = min(episode onset, earliest concrete dependency clock, featureAsOfTs - each non-null feature\'s documented lookback); undocumented support => DESCRIPTIVE_ONLY' },
    splits: { primaryRows: bySplit, groupsBySplit: Object.fromEntries(SPLITS.map((s) => [s, groupSummaries.filter((g) => g.split === s).length])), shadowRowsByPeriod: { BEFORE_SPLIT: shadowTables.BEFORE_SPLIT['1m'].n, AT_OR_AFTER_SPLIT: shadowTables.AT_OR_AFTER_SPLIT['1m'].n } },
    learnability: { law: 'discovery labels are trainable at split only when outcomeKnownAtTs <= splitAt; retrospective availability is reported separately and never backdated', horizons: learn },
    tables: { primaryAll: finalize(allPrimary), primaryBySplit: Object.fromEntries(SPLITS.map((s) => [s, finalize(primaryTables[s])])), shadowByPeriod: { BEFORE_SPLIT: finalize(shadowTables.BEFORE_SPLIT), AT_OR_AFTER_SPLIT: finalize(shadowTables.AT_OR_AFTER_SPLIT) } },
    byEntrance, byResearchState, byProviderContext, byCoverageState, shadowSweeps: Object.keys(shadowBySweep).length,
    laws: ['NO_RANDOM_SPLIT', 'NO_FITTED_CUTOFF', 'NO_OUTCOME_SELECTED_DATE', 'NO_CLASSIFIER', 'NO_CAUSAL_CLAIM', 'NO_SIGNIFICANCE_CLAIM', 'NO_PROFITABILITY_HEADLINE', 'NO_COMPOSITE_RANKING', 'SHADOW_ROWS_ARE_A_SEPARATE_DESCRIPTIVE_COHORT', 'NO_ROW_WEIGHTING'],
    authority: AUTHORITY, purpose: PURPOSE,
  });
  return { evaluation, report: renderReport(evaluation) };
}

const fmt = (v) => (v === null || v === undefined ? 'null' : String(v));
export function renderReport(e) {
  const L = [];
  L.push('SOCIAL-5B RESEARCH EVALUATION — RETROSPECTIVE DESCRIPTIVE ONLY (no fitted model, no stage calibration)');
  L.push(`version ${e.version} | split recipe ${e.splitRecipeVersion} | as-of ${new Date(e.asOfTs).toISOString()} | split-at ${new Date(e.splitAtTs).toISOString()}`);
  L.push(`pipeline ${e.state.pipelineExecution} | data coverage ${e.state.dataCoverage.state} [${(e.state.dataCoverage.reasons ?? []).join(',')}] | evaluation ${e.state.evaluation} | stage calibration ${e.state.stageCalibration} | current runtime stage ${e.state.currentRuntimeStage}`);
  L.push(`calibration blockers: ${e.state.calibrationBlockers.join(', ')}`);
  L.push(`rows: total ${e.rows.total} primary ${e.rows.primary} shadow ${e.rows.shadow} | groups ${e.grouping.groups} (edges ${e.grouping.edges}; ${e.grouping.uncertainty})`);
  L.push(`primary rows by split: ${Object.entries(e.splits.primaryRows).map(([k, v]) => `${k}=${v}`).join(' ')} | shadow rows: before ${e.splits.shadowRowsByPeriod.BEFORE_SPLIT} at/after ${e.splits.shadowRowsByPeriod.AT_OR_AFTER_SPLIT}`);
  L.push(`by entrance: ${Object.entries(e.byEntrance).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'} | by research state: ${Object.entries(e.byResearchState).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  const tbl = (name, t) => { L.push(`-- ${name}`); for (const [h, v] of Object.entries(t)) L.push(`  ${h.padStart(4)}: n=${v.n} known=${v.counts.KNOWN} censored=${v.counts.CENSORED} notYetKnown=${v.counts.NOT_YET_KNOWN} unavailable=${v.counts.OUTCOME_UNAVAILABLE} | mfe% p25/med/p75 ${fmt(v.mfePct.p25)}/${fmt(v.mfePct.median)}/${fmt(v.mfePct.p75)} | mae% ${fmt(v.maePct.p25)}/${fmt(v.maePct.median)}/${fmt(v.maePct.p75)}${v.logReturnPct ? ` | logret% ${fmt(v.logReturnPct.p25)}/${fmt(v.logReturnPct.median)}/${fmt(v.logReturnPct.p75)}` : ''}`); };
  tbl('PRIMARY (all rows, descriptive)', e.tables.primaryAll);
  for (const s of Object.keys(e.tables.primaryBySplit)) tbl(`PRIMARY ${s}`, e.tables.primaryBySplit[s]);
  tbl('SHADOW before split (separate descriptive cohort; not a matched control)', e.tables.shadowByPeriod.BEFORE_SPLIT);
  tbl('SHADOW at/after split', e.tables.shadowByPeriod.AT_OR_AFTER_SPLIT);
  L.push('-- as-of learnability (labels a model COULD have used; never backdated archive availability)');
  for (const [h, v] of Object.entries(e.learnability.horizons)) L.push(`  ${h.padStart(4)}: discovery known retrospectively ${v.discoveryKnownRetrospectively}, trainable at split ${v.discoveryTrainableAtSplit}; validation known at as-of ${v.validationKnownAtAsOf}`);
  L.push(`laws: ${e.laws.join(', ')}`);
  L.push(`authority ${e.authority} / ${e.purpose}`);
  return `${L.join('\n')}\n`;
}
