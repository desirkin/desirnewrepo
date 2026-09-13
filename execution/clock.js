// EXECUTION — one clock law for permission, duration and recovery (ticket §3.4). Runtime intervals use injected monotonic
// elapsed time; cross-restart time uses durable UTC deadlines plus a verified anchor / uncertainty record. The effective
// time is anchorUtc + monotonic elapsed since the anchor; its durable watermark never moves backwards. A wall-clock
// rollback within a run cannot extend anything; a forward discontinuity restricts early (requalify); an expired clock
// evidence sample or a rollback beyond the persisted bound yields CLOCK_UNTRUSTED (no new entry / canary authority; existing
// safety handling continues). Never a fresh process's monotonic zero as elapsed time from an older run.
export const CLOCK_EVIDENCE_MAX_AGE_MS = 300_000;
export const DEFAULT_MAX_UNCERTAINTY_MS = 1_500;
export const FORWARD_JUMP_RESTRICT_MS = 5_000;
export const ROLLBACK_TOLERANCE_MS = 250;
const hr = () => Number(process.hrtime.bigint() / 1_000_000n);

export function createPermissionClock({ wall = Date.now, monotonic = hr, maxEvidenceAgeMs = CLOCK_EVIDENCE_MAX_AGE_MS, maxUncertaintyMs = DEFAULT_MAX_UNCERTAINTY_MS, restored = null, log = () => {} } = {}) {
  const startWall = wall(); const startMono = monotonic();
  let anchor = { anchorUtcTs: startWall, monotonicMs: startMono, uncertaintyMs: 0, source: 'LOCAL_WALL', evidenceMono: null, trusted: false, reason: 'UNQUALIFIED' };
  let watermark = startWall; let rollbackDetected = null; let forwardJump = null; let untrustedReason = 'UNQUALIFIED';
  const restart = { restored: Boolean(restored), watermarkBefore: restored?.watermarkTs ?? null, wallAtStart: startWall, consistent: null, reason: null };
  if (restored) {
    if (typeof restored.watermarkTs === 'number' && startWall < restored.watermarkTs) { restart.consistent = false; restart.reason = `wall ${startWall} behind the persisted watermark ${restored.watermarkTs}: rollback beyond the persisted bound`; untrustedReason = 'CLOCK_UNTRUSTED_ROLLBACK_BEYOND_WATERMARK'; watermark = restored.watermarkTs; }
    else { restart.consistent = true; restart.reason = 'wall at or after the persisted watermark'; watermark = Math.max(startWall, restored.watermarkTs ?? startWall); }
  }
  function effective() { const elapsed = monotonic() - anchor.monotonicMs; const t = anchor.anchorUtcTs + Math.max(0, elapsed); if (t > watermark) watermark = t; return watermark === t ? t : Math.max(t, watermark); }
  function observeWall() { const w = wall(); const t = effective(); if (w < t - ROLLBACK_TOLERANCE_MS - anchor.uncertaintyMs) { rollbackDetected = rollbackDetected ?? { wall: w, effective: t, mono: monotonic() }; } else if (w > t + FORWARD_JUMP_RESTRICT_MS + anchor.uncertaintyMs) { forwardJump = { wall: w, effective: t, mono: monotonic() }; anchor = { ...anchor, trusted: false, reason: 'FORWARD_DISCONTINUITY' }; untrustedReason = 'CLOCK_UNTRUSTED_FORWARD_JUMP'; } return { wall: w, effective: t }; }
  // qualify from a documented venue time response: bracket server UTC by the full observed round trip + source precision
  function qualify({ serverUtcTs, sentMono, receivedMono, precisionMs, source, requestIdMatched = true, responseConsistent = true }) {
    if (!requestIdMatched || !responseConsistent) { untrustedReason = 'CLOCK_EVIDENCE_INCONSISTENT'; anchor = { ...anchor, trusted: false, reason: untrustedReason }; return { ok: false, reason: untrustedReason }; }
    if (!Number.isSafeInteger(serverUtcTs) || !(receivedMono >= sentMono) || !Number.isFinite(precisionMs)) { untrustedReason = 'CLOCK_EVIDENCE_MALFORMED'; anchor = { ...anchor, trusted: false, reason: untrustedReason }; return { ok: false, reason: untrustedReason }; }
    const rtt = receivedMono - sentMono; const uncertaintyMs = Math.ceil(rtt + precisionMs); // asymmetric delay is NOT assumed: the whole round trip bounds the placement
    if (uncertaintyMs > maxUncertaintyMs) { untrustedReason = 'CLOCK_UNCERTAINTY_TOO_WIDE'; anchor = { ...anchor, trusted: false, reason: untrustedReason, lastRejected: { rtt, precisionMs, uncertaintyMs } }; return { ok: false, reason: untrustedReason, uncertaintyMs }; }
    const midMono = sentMono + rtt / 2; const proposed = serverUtcTs + Math.ceil(rtt / 2); // server time is placed at the receipt end of its bracket (conservative: never earlier than the sample allows)
    const elapsedSinceMid = monotonic() - midMono; const nowUtc = proposed + elapsedSinceMid;
    if (nowUtc + uncertaintyMs < watermark) { untrustedReason = 'CLOCK_UNTRUSTED_ROLLBACK_BEYOND_WATERMARK'; anchor = { ...anchor, trusted: false, reason: untrustedReason }; return { ok: false, reason: untrustedReason }; }
    anchor = { anchorUtcTs: proposed, monotonicMs: midMono, uncertaintyMs, source, evidenceMono: receivedMono, trusted: true, reason: null, proof: { serverUtcTs, sentMono, receivedMono, precisionMs, rtt } }; untrustedReason = null; forwardJump = null;
    effective(); return { ok: true, uncertaintyMs, anchorUtcTs: proposed };
  }
  function evidenceAgeMs() { return anchor.evidenceMono === null ? null : monotonic() - anchor.evidenceMono; }
  function status() { const age = evidenceAgeMs(); const expired = age === null || age > maxEvidenceAgeMs; const trusted = anchor.trusted && !expired && !rollbackDetected && restart.consistent !== false && !forwardJump; return { trusted, reason: trusted ? null : rollbackDetected ? 'CLOCK_UNTRUSTED_ROLLBACK' : restart.consistent === false ? 'CLOCK_UNTRUSTED_ROLLBACK_BEYOND_WATERMARK' : expired ? (age === null ? 'CLOCK_UNQUALIFIED' : 'CLOCK_EVIDENCE_EXPIRED') : untrustedReason ?? 'CLOCK_UNTRUSTED', evidenceAgeMs: age, uncertaintyMs: anchor.uncertaintyMs, source: anchor.source, watermarkTs: watermark, rollbackDetected, forwardJump, restart, needsRequalify: age === null || age > maxEvidenceAgeMs * 0.8 }; }
  return {
    now: () => effective(), monotonic, observeWall, qualify, status, evidenceAgeMs,
    watermark: () => watermark,
    // a deadline is expired when the effective clock reaches it; equality expires (never extends authority); untrusted clocks report the doubt
    expired: (deadlineTs) => effective() >= deadlineTs, remainingMs: (deadlineTs) => Math.max(0, deadlineTs - effective()),
    // elapsed within THIS run only (monotonic); a restart cannot claim elapsed time from an older run
    elapsedSince: (mono) => Math.max(0, monotonic() - mono),
    anchorRecord: () => ({ anchorUtcTs: anchor.anchorUtcTs, monotonicMs: anchor.monotonicMs, uncertaintyMs: anchor.uncertaintyMs, source: anchor.source, watermarkTs: watermark, trusted: status().trusted }),
    // durable deadline reconciliation after a restart: a deadline is judged against trustworthy UTC, never paused while offline
    reconcileDeadline: (deadlineTs) => { const s = status(); const t = effective(); return { deadlineTs, expired: t >= deadlineTs, remainingMs: Math.max(0, deadlineTs - t), trusted: s.trusted, reason: s.reason }; },
  };
}
