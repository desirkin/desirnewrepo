// PERSIST-0A — strict pure validators for durable structured safety state.
// "Database rows are storage, not magical truth": controls, posture, sim/lock
// and ledger rows returned by PostgreSQL must re-earn their way through these
// gates before they may be applied or served. An invalid safety row is NEVER
// interpreted as permission (never as CLEAR, never as "no lock").
import { POSTURES } from '../state/posture.js';
import { LOCK_LEVELS, lockLevelForPnlPct } from '../state/locks.js';
import { sessionDate } from '../lib/time.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIsoTs = (v) => typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

// No NaN/Infinity anywhere in a durable safety object. (JSON cannot carry
// them, but a compromised or hand-edited row must still be refused, and this
// validator is also applied to LOCAL files before they are pushed durable.)
function allNumbersFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allNumbersFinite);
  if (isPlainObject(v)) return Object.values(v).every(allNumbersFinite);
  return v !== undefined;
}

// ---- CONTROL STATE -------------------------------------------------------
// PERSIST-0C: the control-state validator is PURE and lives BELOW
// persistence (state/control-validate.js) so the local control store can
// judge its own truth without PostgreSQL existing. Re-exported here so the
// persistence layer keeps one import surface.
export { validateControlState } from '../state/control-validate.js';

// ---- POSTURE: {posture: known enum, ts: valid ISO, cause?} ---------------
export function validatePostureState(s) {
  const errors = [];
  if (!isPlainObject(s)) return { ok: false, errors: ['not an object'] };
  if (!POSTURES.includes(s.posture)) errors.push(`unknown posture ${String(s.posture)}`);
  if (!isIsoTs(s.ts)) errors.push('invalid posture timestamp');
  if (s.cause !== undefined && s.cause !== null && typeof s.cause !== 'string' && !isPlainObject(s.cause)) {
    errors.push('invalid cause shape');
  }
  if (!allNumbersFinite(s)) errors.push('non-finite number present');
  return { ok: errors.length === 0, errors };
}

// ---- SIM / LOCK STATE: the actual current schema (state/locks.js) --------
// Either an injected simulation {date, pnlPct, ts, simulated:true} or the
// cleared marker {cleared:true, ts}. Invalid is NEVER read as "no lock".
export function validateSimState(s) {
  const errors = [];
  if (!isPlainObject(s)) return { ok: false, errors: ['not an object'] };
  if (s.simulated === true) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) errors.push('invalid sim date');
    if (!isFiniteNum(s.pnlPct)) errors.push('invalid sim pnlPct');
    if (!isIsoTs(s.ts)) errors.push('invalid sim ts');
  } else if (s.cleared === true) {
    if (!isIsoTs(s.ts)) errors.push('invalid cleared ts');
  } else {
    errors.push('neither a simulation row nor a cleared marker');
  }
  if (!allNumbersFinite(s)) errors.push('non-finite number present');
  return { ok: errors.length === 0, errors };
}

// ---- LEDGER ROWS by kind --------------------------------------------------
// The CURRENT canonical fields written by ledger.js and consumed by
// openPositions/realizedPnlUsd/dailyRollup/ledgerSummary must all be sane
// before a row may enter operational ledger state (PERSIST-0B §13). No
// future fields are invented; fields the writer sometimes records as null
// (prediction horizon/move via the CLI) accept null but never NaN/garbage.
const nullOrFinite = (v) => v === undefined || v === null || isFiniteNum(v);

export function validateLedgerRow(kind, row) {
  const errors = [];
  if (!isPlainObject(row)) return { ok: false, errors: ['not an object'] };
  if (!isNonEmptyString(row.prediction_id)) errors.push('missing prediction_id');
  if (!allNumbersFinite(row)) errors.push('non-finite number present');
  if (kind === 'prediction') {
    if (!isIsoTs(row.timestamp_prediction_persisted)) errors.push('invalid prediction timestamp');
    if (!isNonEmptyString(row.coin)) errors.push('missing coin');
    if (!isNonEmptyString(row.thesis)) errors.push('missing thesis — no thesis, no trade');
    if (!isFiniteNum(row.size_usd)) errors.push('invalid size_usd');
    if (!nullOrFinite(row.predicted_horizon_min)) errors.push('invalid predicted_horizon_min');
    if (!nullOrFinite(row.predicted_net_move_pct)) errors.push('invalid predicted_net_move_pct');
  } else if (kind === 'fill') {
    if (!isIsoTs(row.ts)) errors.push('invalid fill ts');
    if (!isNonEmptyString(row.coin)) errors.push('missing coin');
    if (!isFiniteNum(row.size_usd)) errors.push('invalid size_usd');
    if (!isFiniteNum(row.base_qty)) errors.push('invalid base_qty');
    if (!isFiniteNum(row.avg_price)) errors.push('invalid avg_price');
    if (!isFiniteNum(row.fee_usd)) errors.push('invalid fee_usd');
  } else if (kind === 'exit') {
    if (!isIsoTs(row.ts)) errors.push('invalid exit ts');
    if (!isNonEmptyString(row.coin)) errors.push('missing coin');
    if (!isNonEmptyString(row.reason_code)) errors.push('missing reason_code');
    if (!isFiniteNum(row.base_qty)) errors.push('invalid base_qty');
    if (!isFiniteNum(row.avg_price)) errors.push('invalid avg_price');
    if (!isFiniteNum(row.proceeds_usd)) errors.push('invalid proceeds_usd');
    if (!isFiniteNum(row.fee_usd)) errors.push('invalid fee_usd');
    if (!isFiniteNum(row.realized_net_usd)) errors.push('invalid realized_net_usd');
    if (!isFiniteNum(row.realized_net_pct)) errors.push('invalid realized_net_pct');
  } else {
    errors.push(`unknown ledger kind ${String(kind)}`);
  }
  return { ok: errors.length === 0, errors };
}

// ---- reconciliation semantics: LESS PERMISSION WINS ----------------------
// Posture permission ranking (doctrine/PERSISTENCE.md): RETREAT grants the
// least permission, STRIKE the most. When two VALID current postures
// disagree and no revision proves freshness, the lower-permission one wins.
// STRIKE/DIGESTING remain fail-closed by the posture machine itself
// (unreachable outside demo; only RETREAT exits them in real code).
export const POSTURE_PERMISSION_RANK = Object.freeze({
  RETREAT: 0,
  COILED: 1,
  DIGESTING: 2,
  STALKING: 3,
  STRIKE: 4,
});

export function lessPermissivePosture(a, b) {
  return POSTURE_PERMISSION_RANK[a.posture] <= POSTURE_PERMISSION_RANK[b.posture] ? a : b;
}

// Sim/lock disagreement resolves toward the state that trips the HIGHER lock
// level for TODAY's session (a sim row for another date is inert — rank 0,
// same as a cleared marker). Ties keep the first argument, so callers pass
// the durable authority first.
export function lessPermissiveSim(a, b, today = sessionDate()) {
  const rank = (s) =>
    s?.simulated === true && s.date === today ? LOCK_LEVELS.indexOf(lockLevelForPnlPct(s.pnlPct)) : 0;
  return rank(b) > rank(a) ? b : a;
}
