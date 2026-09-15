// STRATEGY 6 / 7 WIRING (SHADOW_ONLY, 2026-09-15) — the PURE shadow recorder. It runs a cross-venue detector (IFR or SDR)
// on an assembled episode and produces ONE shadow record: the verdict (fire / refuse + reasons), the frozen episode, and a
// COUNTERFACTUAL (what the decision would have been, the entry reference it would have used, and — once a forward path is
// supplied — how it would have matured). Authority NONE, purpose SHADOW_ONLY_RESEARCH: it can never reach an order, the
// Judge, Watch or execution. Pure and deterministic; imports only the two pure detectors. Live composition into the runtime
// stays gated behind the paper publish (docs/serpent/PHILOSOPHY.md §Strategy 6/7) — this is the recording machinery, ready.
import { detectIsolatedFlushReversal, IFR_SETUP } from './isolated-flush-reversal.js';
import { detectSpotConfirmedDeleveragingReclaim, SDR_SETUP } from './spot-confirmed-deleveraging-reclaim.js';

export const CROSS_VENUE_SHADOW_VERSION = 'cross-venue-shadow-1';
export const OUTCOME_LABELS = Object.freeze(['PENDING_NO_PATH', 'MATURED_FAVORABLE', 'MATURED_ADVERSE', 'MATURED_NEUTRAL']);
const DETECTORS = Object.freeze({ [IFR_SETUP]: detectIsolatedFlushReversal, [SDR_SETUP]: detectSpotConfirmedDeleveragingReclaim });
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// classify a would-have-fired counterfactual against the observed forward path. A path is
// { maxFavorablePct, maxAdversePct } (magnitudes as observed after the decision instant). No path -> PENDING (never a zero).
export function maturedOutcome(forwardPath, { neutralBandPct = 0.5 } = {}) {
  if (!forwardPath || !finite(forwardPath.maxFavorablePct) || !finite(forwardPath.maxAdversePct)) return 'PENDING_NO_PATH';
  const fav = forwardPath.maxFavorablePct; const adv = Math.abs(forwardPath.maxAdversePct);
  if (fav < neutralBandPct && adv < neutralBandPct) return 'MATURED_NEUTRAL';
  if (fav > adv) return 'MATURED_FAVORABLE';
  if (adv > fav) return 'MATURED_ADVERSE';
  return 'MATURED_NEUTRAL';
}

// The entry reference a fire WOULD have used: the size-aware executable bid (IFR) or the recovered spot bid basis (SDR).
const entryReferenceOf = (setup, episode) => (setup === IFR_SETUP ? (finite(episode.krakenExecutableBid) ? episode.krakenExecutableBid : null) : null);

// Record one shadow decision. `setup` selects the detector; `episode` is an assembled episode; `forwardPath` (optional) is
// the observed forward move for counterfactual maturation; `cfg` is passed to the detector; `recordedAtTs` stamps the record.
export function recordCrossVenueShadow({ setup, episode, forwardPath = null, cfg = undefined, recordedAtTs = null } = {}) {
  const detect = DETECTORS[setup];
  if (!detect) throw new Error(`cross-venue shadow: unknown setup ${setup}`);
  const verdict = cfg === undefined ? detect(episode) : detect(episode, cfg);
  const outcome = verdict.fire ? maturedOutcome(forwardPath) : 'PENDING_NO_PATH';
  return Object.freeze({
    lane: 'CROSS_VENUE_SHADOW', recordVersion: CROSS_VENUE_SHADOW_VERSION,
    setup, family: verdict.family, detectorVersion: verdict.detectorVersion,
    canonicalCoin: verdict.canonicalCoin ?? null, decisionKnownAtTs: verdict.decisionKnownAtTs ?? null, recordedAtTs,
    fire: verdict.fire, reasons: verdict.reasons, measurements: verdict.measurements,
    episode,
    counterfactual: Object.freeze({
      wouldHaveFired: verdict.fire,
      entryReference: verdict.fire ? entryReferenceOf(setup, episode) : null,
      refusalReasons: verdict.fire ? Object.freeze([]) : verdict.reasons,
      forwardPath: forwardPath ? Object.freeze({ ...forwardPath }) : null,
      outcome,
    }),
    authority: 'NONE', purpose: 'SHADOW_ONLY_RESEARCH', edgeClaim: 'NOT_MADE',
    fenced: 'NEVER_REACHES_JUDGE_WATCH_EXECUTION_OR_ORDER',
  });
}
