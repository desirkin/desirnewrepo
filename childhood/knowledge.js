// KNOWLEDGE TIME (B-0A §1): sourceTs is when a fact happened; availableTs is
// the earliest defensible moment the fact was PUBLICLY OBSERVABLE. They are
// different concepts and are never silently equated. Replay may consume a
// field only when availableTs <= replayTs; a field whose availableTs cannot
// be established is unavailable for point-in-time reconstruction — UNKNOWN,
// never guessed.
export function knowableAt(availableTs, replayTs) {
  if (availableTs === null || availableTs === undefined || availableTs === 'UNKNOWN') return false;
  return availableTs <= replayTs;
}

// Filter a map of {field: {value, availableTs}} down to what replay at
// replayTs may see. Unknowable fields come back with the given placeholder,
// never their value.
export function visibleFields(fields, replayTs, placeholder = 'UNAVAILABLE_AT_REPLAY_TS') {
  const out = {};
  for (const [name, f] of Object.entries(fields)) {
    out[name] = knowableAt(f.availableTs, replayTs) ? f.value : placeholder;
  }
  return out;
}
