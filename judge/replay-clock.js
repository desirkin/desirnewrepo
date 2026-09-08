// JUDGE — the replay clock: wall time is SET from each recorded receipt clock (never from the machine), the monotonic
// counter advances with it; the permission clock's qualification is bypassed because a replay is by definition a
// hypothetical account. Shape-compatible with the permission clock used by the dispatcher / Watch / Judge.
export function fakeReplayClock(start) {
  let wall = start; let mono = 0; let last = start;
  return { now: () => wall, monotonic: () => mono, setWall: (v) => { if (v > last) mono += v - last; last = Math.max(last, v); wall = v; }, advance: (ms) => { wall += ms; mono += ms; last = wall; return wall; }, observeWall: () => null, qualify: () => ({ trusted: true, reason: 'REPLAY' }), status: () => ({ kind: 'REPLAY', wall, monotonic: mono }), expired: (deadlineTs) => wall > deadlineTs };
}
