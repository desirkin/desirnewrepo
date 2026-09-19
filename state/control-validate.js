// PERSIST-0C — PURE local control-state validation and merge semantics.
// This lives BELOW persistence on purpose: the control system must be able
// to decide whether its own local state is valid, and merge two states
// toward restriction, without PostgreSQL or the persistence layer existing
// at all. Persistence imports these; never the other way round.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIsoTs = (v) => typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

function allNumbersFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allNumbersFinite);
  if (isPlainObject(v)) return Object.values(v).every(allNumbersFinite);
  return v !== undefined;
}

// {kill, cage, vetoes}: kill/cage strictly null OR {active:true, valid ts};
// vetoes an array of {prediction_id, ts}. Anything else is INVALID and must
// never be interpreted as CLEAR.
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
  // PUBLISH-FIX-83 (full review 2026-09-19, item 1): the CLEAR watermark — when the latches were last cleared (ISO). Absent
  // or null on states written before the watermark existed; anything else must be a valid ISO clock.
  if (s.clearedAt !== undefined && s.clearedAt !== null && !isIsoTs(s.clearedAt)) errors.push('clearedAt is neither absent nor a valid ts');
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

// MOST RESTRICTIVE STATE WINS: kill or cage active in either state is
// active in the result; vetoes union. Restrictions merge — they may never
// cancel each other accidentally.
// PUBLISH-FIX-83 (full review 2026-09-19, item 1 — the CAGE that returned at every boot): the merge now honours the CLEAR
// watermark. A latch is live only if it was set AFTER the latest clearedAt either side carries; a latch older than the clear
// is the stale copy of something an owner already cleared (the outgoing instance's controls.json during a republish overlap
// re-asserted the 2026-09-11 CAGE against every CLEAR for eight days). A latch set after the clear still wins, on either side.
const clockOf = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
export function clearWatermark(a = {}, b = {}) {
  const ta = clockOf(a?.clearedAt); const tb = clockOf(b?.clearedAt);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return null;
  if (Number.isNaN(tb) || ta >= tb) return a.clearedAt;
  return b.clearedAt;
}
export function mostRestrictiveControls(a = {}, b = {}) {
  const clearedAt = clearWatermark(a, b); const mark = clockOf(clearedAt);
  const live = (latch) => (latch?.active && !(Number.isFinite(mark) && Number.isFinite(clockOf(latch.ts)) && clockOf(latch.ts) < mark) ? latch : null);
  const kill = live(a.kill) ?? live(b.kill) ?? null;
  const cage = live(a.cage) ?? live(b.cage) ?? null;
  const byId = new Map();
  for (const v of [...(a.vetoes ?? []), ...(b.vetoes ?? [])]) {
    if (v?.prediction_id && !byId.has(v.prediction_id)) byId.set(v.prediction_id, v);
  }
  return clearedAt ? { kill, cage, vetoes: [...byId.values()], clearedAt } : { kill, cage, vetoes: [...byId.values()] };
}

// canonical key-sorted JSON — the stable fingerprint form for control state
export const canonicalControlJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalControlJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalControlJson(v[k])}`))
    .filter(Boolean)
    .join(',')}}`;
};

export function controlFingerprint(s) {
  return canonicalControlJson({ kill: s.kill ?? null, cage: s.cage ?? null, vetoes: s.vetoes ?? [] });
}
