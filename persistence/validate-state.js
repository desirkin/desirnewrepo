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
