// JUDGE — the closed semantics of the experiment records (holdout truth closeout HR09): every lifecycle record kind has ONE
// closed shape (no unknown key, no missing key, no null where a value is required) and closed semantics against the records
// before it (the declaration it belongs to, the evaluations a lock names, the lock an opening names, the opening an
// evaluation consumes, the clocks in order, the digests re-derived, the qualification re-derived from the content). The
// store runs this on every append and on every read: a rehashed row with the wrong meaning is refused exactly like a row
// with the wrong hash. Nothing here is advisory; a refusal is a RECORD_INVALID error.
import { digestOf, T, isPlainObject, shapeError, nullable, canonicalJson } from '../execution/contract.js';
import { ARM_NAMES, REPLAY_ENGINE_VERSION } from './experiment-replay.js';
import { BUNDLE_VERSION, TIE_ORDER_VERSION } from './experiment-bundle.js';

export const EXPERIMENT_VERSION = 'judge-experiment-1';
export const EXPERIMENT_RECORD_KINDS = Object.freeze(['DECLARED', 'EVALUATED', 'SELECTION_LOCKED', 'HOLDOUT_OPENED', 'HOLDOUT_EVALUATED']);
export const STAGE_SPLITS = Object.freeze(['DEVELOPMENT', 'VALIDATION']);
export const QUALIFICATION_STATES = Object.freeze(['QUALIFIED', 'CONSUMED_BUT_UNQUALIFIED']);
export const QUALIFICATION_BLOCKERS = Object.freeze(['DECLARATION_UNQUALIFIABLE', 'HOLDOUT_UNSCORABLE', 'HOLDOUT_PENDING', 'HOLDOUT_EMPTY', 'HOLDOUT_CENSORED', 'HOLDOUT_NO_CLOSED_OUTCOME']);
const iso = (ms) => new Date(ms).toISOString();
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const armList = (v, where) => (Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every((a) => ARM_NAMES.includes(a)) && new Set(v).size === v.length ? null : `${where}: declared arms`);
const counts = (v, where) => (isPlainObject(v) && Object.values(v).every((n) => T.count(n)) ? null : `${where}: counts`);
const version = T.en([EXPERIMENT_VERSION]);
const lawText = (v, where) => (typeof v === 'string' && v.length > 0 && v.length <= 1000 ? null : `${where}: law text`);
export const HORIZONS_SCHEMA = Object.freeze({ lookbackMs: T.count, decisionMs: T.count, maxOutcomeMs: T.count, publicationFloorMs: T.count });
export const BINDING_SCHEMA = Object.freeze({ policyDigest: T.hex64, codeDigest: T.hex64OrNull, strategyVersion: T.id, armVersion: T.en([REPLAY_ENGINE_VERSION]), arms: armList, seed: T.id, sourceBinding: { sourcePrefix: T.id, accountId: T.id } });
export const DECLARED_SCHEMA = Object.freeze({ experimentVersion: version, experimentId: T.id, declaredTs: T.ts, prospective: T.bool, qualifiable: T.bool, binding: BINDING_SCHEMA, windows: { startTs: T.ts, developmentEndTs: T.ts, validationEndTs: T.ts, endTs: T.ts, selectionDeadlineTs: T.ts, utc: { start: T.text, developmentEnd: T.text, validationEnd: T.text, end: T.text, selectionDeadline: T.text } }, fractions: { developmentFraction: T.fraction, validationFraction: T.fraction, holdoutFraction: T.fraction }, embargoMs: T.count, selectionGraceMs: T.count, horizons: HORIZONS_SCHEMA, law: lawText, declarationDigest: T.hex64 });
export const EVIDENCE_SCOPE_SCHEMA = Object.freeze({ stage: T.en(STAGE_SPLITS), boundaryTs: T.ts, lastAppliedSeq: T.count, lastAppliedReceiptTs: T.tsOrNull, recordsBeyond: T.count });
export const REPORT_BINDING_SCHEMA = Object.freeze({ engine: T.en([REPLAY_ENGINE_VERSION]), bundleVersion: T.en([BUNDLE_VERSION]), tieOrderVersion: T.en([TIE_ORDER_VERSION]), experimentId: T.id, policyDigest: T.hex64, codeDigest: T.hex64, strategyVersion: T.id, sourcePrefix: T.id, seed: T.id, reportDigest: T.hex64, bundleDigest: T.hex64OrNull, holdoutOpening: T.hex64OrNull, evidenceScope: nullable(EVIDENCE_SCOPE_SCHEMA), bundle: T.textOrNull, lastSeq: T.count });
const ARM_SCORED = Object.freeze({ arm: T.id, outcome: T.en(['SCORED']), split: T.en(['DEVELOPMENT', 'VALIDATION', 'HOLDOUT']), decisions: T.count, byState: counts, entries: T.count, closed: T.count, censored: T.count, netPnl: T.dec, wins: T.count, losses: T.count, headDigest: T.hex64, accountId: T.id, calibrationState: T.en(['UNVALIDATED_HYPOTHESIS']), eligibleEpisodes: T.idList });
const ARM_UNSCORABLE = Object.freeze({ arm: T.id, outcome: T.en(['UNSCORABLE']), reason: T.text });
const armsMap = (v, where) => { if (!isPlainObject(v)) return `${where}: arm evaluations`; for (const [k, a] of Object.entries(v)) { if (!ARM_NAMES.includes(k)) return `${where}.${k}: unknown arm`; if (!isPlainObject(a) || a.arm !== k) return `${where}.${k}: arm name`; const e = shapeError(a, a.outcome === 'SCORED' ? ARM_SCORED : ARM_UNSCORABLE, `${where}.${k}`); if (e) return e; } return null; };
const evaluatedSchema = (splits) => Object.freeze({ experimentVersion: version, experimentId: T.id, split: T.en(splits), evaluatedTs: T.ts, declarationDigest: T.hex64, assignmentDigest: T.hex64, reportBinding: REPORT_BINDING_SCHEMA, groups: T.count, late: T.idList, arms: armsMap, evaluationDigest: T.hex64 });
export const EVALUATED_SCHEMA = evaluatedSchema(STAGE_SPLITS);
const HOLDOUT_LOOK_SCHEMA = evaluatedSchema(['HOLDOUT']);
const EVAL_REF = Object.freeze({ seq: T.count, digest: T.hex64, evaluationDigest: T.hex64, reportDigest: T.hex64 });
export const SELECTION_LOCKED_SCHEMA = Object.freeze({ experimentVersion: version, experimentId: T.id, arm: T.id, lockedTs: T.ts, selectionDeadlineTs: T.ts, binding: BINDING_SCHEMA, developmentEvaluation: EVAL_REF, validationEvaluation: EVAL_REF, law: lawText });
export const HOLDOUT_OPENED_SCHEMA = Object.freeze({ experimentVersion: version, experimentId: T.id, runId: T.id, openedTs: T.ts, lockDigest: T.hex64, lockSeq: T.count, arm: T.id, declarationDigest: T.hex64, holdoutWindow: { startTs: T.ts, endTs: T.ts }, evidenceCompleteTs: T.ts, law: lawText });
export const QUALIFICATION_SCHEMA = Object.freeze({ status: T.en(QUALIFICATION_STATES), blockers: (v, where) => (Array.isArray(v) && v.every((b) => QUALIFICATION_BLOCKERS.includes(b)) && new Set(v).size === v.length ? null : `${where}: named qualification blockers`) });
export const HOLDOUT_EVALUATED_SCHEMA = Object.freeze({ experimentVersion: version, experimentId: T.id, runId: T.id, evaluatedTs: T.ts, lockDigest: T.hex64, openingDigest: T.hex64, arm: T.id, reportDigest: T.hex64, bundleDigest: T.hex64OrNull, assignmentDigest: T.hex64, holdoutGroups: T.count, purged: T.count, pending: T.count, late: T.idList, evaluation: HOLDOUT_LOOK_SCHEMA, evaluationDigest: T.hex64, netPnl: T.decOrNull, closed: T.count, censored: T.count, qualification: QUALIFICATION_SCHEMA, law: lawText });
const SCHEMAS = Object.freeze({ DECLARED: DECLARED_SCHEMA, EVALUATED: EVALUATED_SCHEMA, SELECTION_LOCKED: SELECTION_LOCKED_SCHEMA, HOLDOUT_OPENED: HOLDOUT_OPENED_SCHEMA, HOLDOUT_EVALUATED: HOLDOUT_EVALUATED_SCHEMA });

// ONE qualification law (HR06), re-derived from the content wherever the content is read: a consumed holdout qualifies only when the
// declaration can qualify at all, the locked arm is SCORED, no holdout group is still PENDING, at least one group is IN the holdout,
// no holdout position is CENSORED and at least one eligible outcome CLOSED. Everything else is CONSUMED_BUT_UNQUALIFIED with names.
export function qualificationOf({ qualifiable, armEval, holdoutGroups, pending }) {
  const blockers = []; if (qualifiable !== true) blockers.push('DECLARATION_UNQUALIFIABLE');
  if (!armEval || armEval.outcome !== 'SCORED') blockers.push('HOLDOUT_UNSCORABLE');
  else { if (pending > 0) blockers.push('HOLDOUT_PENDING'); else if (holdoutGroups === 0) blockers.push('HOLDOUT_EMPTY'); if (armEval.censored > 0) blockers.push('HOLDOUT_CENSORED'); else if (holdoutGroups > 0 && pending === 0 && armEval.closed === 0) blockers.push('HOLDOUT_NO_CLOSED_OUTCOME'); }
  return { status: blockers.length ? 'CONSUMED_BUT_UNQUALIFIED' : 'QUALIFIED', blockers };
}
// the declaration's own arithmetic (the windows follow from start + duration + fractions ONCE; the deadline from the grace)
export function declarationSemanticsError(d, where = 'DECLARED') {
  const w = d.windows; const dur = w.endTs - w.startTs; if (!(w.startTs < w.developmentEndTs && w.developmentEndTs < w.validationEndTs && w.validationEndTs < w.endTs)) return `${where}: windows out of order`;
  if (w.developmentEndTs !== w.startTs + Math.round(dur * d.fractions.developmentFraction) || w.validationEndTs !== w.developmentEndTs + Math.round(dur * d.fractions.validationFraction)) return `${where}: windows do not follow from the fractions`;
  if (Math.abs(d.fractions.holdoutFraction - (1 - d.fractions.developmentFraction - d.fractions.validationFraction)) > 1e-9 || d.fractions.developmentFraction <= 0 || d.fractions.validationFraction <= 0 || d.fractions.holdoutFraction <= 0) return `${where}: fractions`;
  if (w.selectionDeadlineTs !== w.validationEndTs + d.selectionGraceMs) return `${where}: selection deadline does not follow from the grace`;
  if (w.utc.start !== iso(w.startTs) || w.utc.developmentEnd !== iso(w.developmentEndTs) || w.utc.validationEnd !== iso(w.validationEndTs) || w.utc.end !== iso(w.endTs) || w.utc.selectionDeadline !== iso(w.selectionDeadlineTs)) return `${where}: utc labels`;
  if (d.prospective && w.startTs < d.declaredTs) return `${where}: a prospective declaration precedes its start`;
  if (d.qualifiable !== (d.prospective && d.binding.codeDigest !== null)) return `${where}: qualifiable does not follow from prospective + known code`;
  if (digestOf({ ...d, declarationDigest: null }) !== d.declarationDigest) return `${where}: declaration digest`;
  return null;
}
const reportBindingError = (rb, d, where) => { const b = d.binding; if (rb.experimentId !== d.experimentId) return `${where}: experiment`; if (rb.policyDigest !== b.policyDigest) return `${where}: policy`; if (b.codeDigest === null || rb.codeDigest !== b.codeDigest) return `${where}: code`; if (rb.strategyVersion !== b.strategyVersion) return `${where}: strategy`; if (rb.seed !== b.seed) return `${where}: seed`; if (rb.sourcePrefix !== b.sourceBinding.sourcePrefix) return `${where}: source prefix`; return null; };
const stageBoundary = (d, split) => (split === 'DEVELOPMENT' ? d.windows.developmentEndTs : d.windows.validationEndTs);
// the semantics of one record given the verified records before it (in sequence order)
export function recordSemanticsError(row, prior, where = `record ${row?.seq ?? '?'}`) {
  if (!isPlainObject(row) || !EXPERIMENT_RECORD_KINDS.includes(row.kind) || !isPlainObject(row.record)) return `${where}: not a lifecycle record`;
  const r = row.record; const kind = row.kind; const e = shapeError(r, SCHEMAS[kind], `${where}.${kind}`); if (e) return e; if (r.experimentId !== row.experimentId) return `${where}: experiment id`;
  const byKind = (k) => prior.filter((p) => p.kind === k); const declared = byKind('DECLARED')[0] ?? null; const d = declared?.record ?? null; const lock = byKind('SELECTION_LOCKED')[0] ?? null; const opening = byKind('HOLDOUT_OPENED')[0] ?? null;
  if (kind === 'DECLARED') { if (prior.length || row.seq !== 1) return `${where}: the declaration is the first record`; return declarationSemanticsError(r, `${where}.DECLARED`); }
  if (!d) return `${where}: ${kind} before the declaration`;
  if (kind === 'EVALUATED') {
    if (opening) return `${where}: a stage look after the holdout opening`; if (r.declarationDigest !== d.declarationDigest) return `${where}: declaration digest`; if (r.evaluatedTs < d.declaredTs) return `${where}: evaluated before the declaration`;
    const rb = r.reportBinding; const be = reportBindingError(rb, d, `${where}.reportBinding`); if (be) return be; if (rb.holdoutOpening !== null) return `${where}: a stage look bound to a holdout opening`; if (!rb.evidenceScope || rb.evidenceScope.stage !== r.split || rb.evidenceScope.boundaryTs !== stageBoundary(d, r.split)) return `${where}: evidence scope is not the ${r.split} stage`;
    if (!same(Object.keys(r.arms).sort(), d.binding.arms.slice().sort())) return `${where}: arms are not the declared arms`; if (digestOf({ ...r, evaluationDigest: null }) !== r.evaluationDigest) return `${where}: evaluation digest`; return null;
  }
  if (kind === 'SELECTION_LOCKED') {
    if (lock) return `${where}: a second lock`; if (opening) return `${where}: a lock after the opening`; if (!d.binding.arms.includes(r.arm)) return `${where}: arm not declared`; if (!same(r.binding, d.binding)) return `${where}: binding differs from the declaration`; if (r.selectionDeadlineTs !== d.windows.selectionDeadlineTs) return `${where}: selection deadline`;
    const ref = (name, split) => { const x = r[name]; const p = prior.find((q) => q.seq === x.seq) ?? null; if (!p || p.kind !== 'EVALUATED' || p.record.split !== split || p.digest !== x.digest || p.record.evaluationDigest !== x.evaluationDigest || p.record.reportBinding.reportDigest !== x.reportDigest) return `${where}.${name}: does not name the ${split} evaluation`; if (r.lockedTs < p.record.evaluatedTs) return `${where}: locked before the ${split} evaluation`; return null; };
    return ref('developmentEvaluation', 'DEVELOPMENT') ?? ref('validationEvaluation', 'VALIDATION') ?? (r.lockedTs > r.selectionDeadlineTs ? `${where}: locked after the selection deadline` : null);
  }
  if (kind === 'HOLDOUT_OPENED') {
    if (!d.prospective) return `${where}: an exploratory declaration has no holdout`; if (!lock) return `${where}: opening before the lock`; if (opening) return `${where}: a second opening`; if (r.lockSeq !== lock.seq || r.lockDigest !== lock.digest || r.arm !== lock.record.arm) return `${where}: does not name the lock`; if (r.declarationDigest !== d.declarationDigest) return `${where}: declaration digest`;
    const complete = d.windows.endTs + d.horizons.maxOutcomeMs; if (r.holdoutWindow.startTs !== d.windows.validationEndTs || r.holdoutWindow.endTs !== d.windows.endTs || r.evidenceCompleteTs !== complete) return `${where}: holdout window`; if (r.openedTs < complete || r.openedTs < lock.record.lockedTs) return `${where}: opened before the evidence was complete`; return null;
  }
  // HOLDOUT_EVALUATED: the one bound look, everything re-derived from the opening, the lock and its own evaluation
  if (!opening || !lock) return `${where}: evaluation before the opening`; if (byKind('HOLDOUT_EVALUATED').length) return `${where}: a second holdout evaluation`; if (r.runId !== opening.record.runId) return `${where}: run id is not the opening run`; if (r.openingDigest !== opening.digest || r.lockDigest !== lock.digest || r.arm !== lock.record.arm) return `${where}: does not name the opening / lock`; if (r.evaluatedTs < opening.record.openedTs) return `${where}: evaluated before the opening`;
  const ev = r.evaluation; if (ev.experimentId !== r.experimentId || ev.declarationDigest !== d.declarationDigest || ev.evaluatedTs !== r.evaluatedTs || ev.assignmentDigest !== r.assignmentDigest || !same(Object.keys(ev.arms), [r.arm])) return `${where}.evaluation: not the bound look of the locked arm`; if (digestOf({ ...ev, evaluationDigest: null }) !== ev.evaluationDigest || ev.evaluationDigest !== r.evaluationDigest) return `${where}: evaluation digest`;
  const rb = ev.reportBinding; const be = reportBindingError(rb, d, `${where}.reportBinding`); if (be) return be; if (rb.evidenceScope !== null || rb.holdoutOpening !== opening.digest || rb.reportDigest !== r.reportDigest || rb.bundleDigest !== r.bundleDigest) return `${where}: the report is not bound to this opening`;
  const armEval = ev.arms[r.arm]; const scored = armEval.outcome === 'SCORED'; if (r.netPnl !== (scored ? armEval.netPnl : null) || r.closed !== (scored ? armEval.closed : 0) || r.censored !== (scored ? armEval.censored : 0)) return `${where}: figures do not follow from the evaluation`;
  if (!same(r.qualification, qualificationOf({ qualifiable: d.qualifiable, armEval, holdoutGroups: r.holdoutGroups, pending: r.pending }))) return `${where}: qualification does not follow from the content`; return null;
}
// the whole chain, in sequence order, each record against the ones before it
export function verifyRecordSemantics(rows) { for (let i = 0; i < rows.length; i += 1) { const e = recordSemanticsError(rows[i], rows.slice(0, i)); if (e) return { ok: false, seq: rows[i].seq ?? i + 1, reason: e }; } return { ok: true, records: rows.length }; }
