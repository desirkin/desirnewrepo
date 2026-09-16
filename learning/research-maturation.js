// RESEARCH-HORIZON MATURATION (B-2, 2026-09-16). The pass that FILLS the 1h/4h/24h research columns of every recorded
// PAPER decision once each horizon actually elapses. The L-2 recorder writes a decision-outcome record ONCE at 15-minute
// maturity, so at that moment the three research horizons are NOT_YET_KNOWN and the primary store hard-refuses re-append.
// This pass re-scores those columns — and ONLY those columns — with the SAME pure yardstick against a later, fuller tape
// and a later knowledge clock, and appends the result as a SEPARATE supersede attachment (research-outcome-store.js).
//
// It mirrors learning/maturation.js EXACTLY: the label is never rewritten; readiness is judged by the yardstick's own
// outcomeKnownAtTs against the caller's as-of, never by elapsed wall time; a decision younger than a horizon leaves that
// column explicitly pending (NaN in memory, null on re-read), NEVER a fabricated zero; and an attachment is written only
// when a column newly settles beyond the existing head. Pure and dormant: the series and clocks are injected, it grants
// no authority, and it never touches entry / exit / sizing.
import { scoreDecisionYardstick, RESEARCH_HORIZONS_MIN, RESEARCH_HORIZON_LABEL } from './decision-yardstick.js';
import { RESEARCH_OUTCOME_VERSION, researchOutcomeError } from './research-outcome-store.js';
import { AUTHORITY, PURPOSE, deepFreeze } from './contracts.js';

export const RESEARCH_MATURATION_VERSION = 'research-maturation-1';
const LABELS = Object.freeze(RESEARCH_HORIZONS_MIN.map((m) => RESEARCH_HORIZON_LABEL[m]));

// every column terminal (KNOWN / CENSORED / OUTCOME_UNAVAILABLE) — nothing left to wait for
const allSettled = (rh) => LABELS.every((l) => rh[l] && rh[l].state !== 'NOT_YET_KNOWN');
// a serialization-stable signature of the SETTLED shape: the per-column state, plus the KNOWN log return (null otherwise
// so NaN-in-memory and null-on-re-read compare equal). Two scores with the same signature matured nothing new.
const stateSig = (rh) => JSON.stringify(LABELS.map((l) => [l, rh[l] ? rh[l].state : null, rh[l] && rh[l].state === 'KNOWN' ? rh[l].logReturnPct : null]));

// Re-score the three research horizons for ONE already-recorded decision at a later as-of + fuller series. Returns a
// durable attachment, or null when nothing is settled beyond the existing head — every column still NOT_YET_KNOWN (leave
// it explicitly pending), or the settled shape is unchanged since the head (nothing new matured). Pure: the series and
// both clocks are injected.
export function matureResearchHorizons({ decision, series, asOfTs, attachedTs, existing = null }) {
  const y = scoreDecisionYardstick({ canonicalCoin: decision.assetId, decisionKnownAtTs: decision.decisionKnownAtTs, series, asOfTs });
  const rh = y.researchHorizons;
  if (LABELS.every((l) => rh[l].state === 'NOT_YET_KNOWN')) return null; // still fully pending — never a fabricated zero
  if (existing && stateSig(existing.researchHorizons) === stateSig(rh)) return null; // nothing new matured since the head
  const attach = {
    recordVersion: RESEARCH_OUTCOME_VERSION, decisionId: decision.decisionId, assetId: decision.assetId,
    decisionKnownAtTs: decision.decisionKnownAtTs, attachedTs, asOfTs, supersedes: existing ? existing.attachedTs : null,
    researchHorizons: rh, authority: AUTHORITY, purpose: PURPOSE,
  };
  const err = researchOutcomeError(attach); if (err) throw new Error(`matureResearchHorizons: ${err}`);
  return deepFreeze(attach);
}

// Sweep the recorded decisions, filling the research horizons that have matured. Returns DISTINCT counts, never one
// blended number: `matured` counts attachments carrying a real (non-unavailable) settled column, while an honest
// all-unavailable recording (series never arrived for that asset) is written once and counted apart; `pending` counts
// decisions still fully NOT_YET_KNOWN. A decision whose head is already fully settled is skipped, so the pass cannot
// wedge on a permanently-unavailable or fully-matured decision.
export function researchMaturationSweep({ decisions, latestAttachments, seriesSource, asOfTs, attachedTs, maxPerSweep = 500 }) {
  const attachments = []; let matured = 0; let pending = 0; let unavailable = 0;
  for (const d of decisions) {
    if (attachments.length >= maxPerSweep) break;
    const existing = latestAttachments.get(d.decisionId) ?? null;
    if (existing && allSettled(existing.researchHorizons)) continue; // fully matured already — no more work for this one
    let series = null;
    try { series = seriesSource(d.assetId, { asOfTs }); } catch { series = null; } // an absent series is an honest OUTCOME_UNAVAILABLE
    const attach = matureResearchHorizons({ decision: d, series, asOfTs, attachedTs, existing });
    if (attach === null) { pending += 1; continue; }
    if (LABELS.every((l) => attach.researchHorizons[l].state === 'OUTCOME_UNAVAILABLE')) { unavailable += 1; if (existing) continue; attachments.push(attach); continue; }
    attachments.push(attach); matured += 1;
  }
  return { attachments, matured, pending, unavailable };
}
