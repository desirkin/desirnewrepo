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

// ---- CONTROL STATE: {kill, cage, vetoes} ---------------------------------
// kill/cage: null OR {active: true, ts: valid ISO}. Anything else is invalid
// and must never be read as CLEAR. Vetoes: array of {prediction_id, ts}.
export function validateControlState(s) {
  const errors = [];
  if (!isPlainObject(s)) return { ok: false, errors: ['not an object'] };
  if (!allNumbersFinite(s)) errors.push('non-finite number present');
  for (const latch of ['kill', 'cage']) {
    const v = s[latch];
    if (v === null || v === undefined) continue;
    if (!isPlainObject(v) || v.active !== true || !isIsoTs(v.ts)) {
      errors.push(`${latch} is neither null nor {active:true, valid ts}`);
    }
  }
  if (!Array.isArray(s.vetoes)) {
    errors.push('vetoes is not an array');
  } else {
    for (const v of s.vetoes) {
      if (!isPlainObject(v) || !isNonEmptyString(v.prediction_id) || !isIsoTs(v.ts)) {
        errors.push('veto without valid prediction_id + timestamp');
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

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
// Identity, timestamps and the numeric fields the rollups actually consume
// must be sane before a row may enter operational ledger state.
export function validateLedgerRow(kind, row) {
  const errors = [];
  if (!isPlainObject(row)) return { ok: false, errors: ['not an object'] };
  if (!isNonEmptyString(row.prediction_id)) errors.push('missing prediction_id');
  if (!allNumbersFinite(row)) errors.push('non-finite number present');
  if (kind === 'prediction') {
    if (!isIsoTs(row.timestamp_prediction_persisted)) errors.push('invalid prediction timestamp');
    if (!isNonEmptyString(row.coin)) errors.push('missing coin');
    if (row.size_usd !== undefined && !isFiniteNum(row.size_usd)) errors.push('invalid size_usd');
  } else if (kind === 'fill') {
    if (!isIsoTs(row.ts)) errors.push('invalid fill ts');
    if (!isNonEmptyString(row.coin)) errors.push('missing coin');
    if (!isFiniteNum(row.size_usd)) errors.push('invalid size_usd');
    if (!isFiniteNum(row.avg_price)) errors.push('invalid avg_price');
    if (!isFiniteNum(row.fee_usd)) errors.push('invalid fee_usd');
  } else if (kind === 'exit') {
    if (!isIsoTs(row.ts)) errors.push('invalid exit ts');
    if (!isNonEmptyString(row.coin)) errors.push('missing coin');
    if (!isNonEmptyString(row.reason_code)) errors.push('missing reason_code');
    if (!isFiniteNum(row.realized_net_usd)) errors.push('invalid realized_net_usd');
    if (!isFiniteNum(row.proceeds_usd)) errors.push('invalid proceeds_usd');
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
