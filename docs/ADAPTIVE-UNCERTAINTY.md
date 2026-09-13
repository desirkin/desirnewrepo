# Adaptive uncertainty — shadow experiment 1

## Status and authority

This slice is implemented as a bounded, local-filesystem, **shadow-only diagnostic**. It is not wired into the
runtime, Judge, Watch, paper accounts, sizing, setup selection, vetoes, or any order path. Every procedure and
store status says `authority: NONE`, `purpose: RESEARCH_ONLY`, and `paperInfluence: false`. The local store is
not republish-durable.

There was no existing numerical return forecast suitable for conformalization:

- `learning/service.js` calls `abs(zVol) + abs(zRet)` a `baselineScore`; this is a heuristic score, not a
  numerical forecast of a stated future target.
- `learning/features.js` produces a threshold-gate classification.
- Judge scenario targets are marked `SCENARIO_NOT_FORECAST`, and setup calibration is marked
  `UNVALIDATED_HYPOTHESIS`.
- retrospective estimator group means are not immutable, per-opportunity, pre-outcome predictions.

This module therefore does not rename any of those outputs. It accepts either:

1. `SHADOW_ZERO_RETURN_BASELINE`: a newly declared null predictor of exactly 0, explicitly labeled
   `EXPLICIT_NEW_NULL_PREDICTOR_NOT_MARKET_ALPHA`; or
2. `EXTERNAL_NUMERIC_FORECAST`: a caller-supplied finite point forecast with a version, state digest, and
   `knownAtTs` no later than the sealed information cutoff.

The single target is `LOG_RETURN_PERCENT_60M` in percent units using the existing
`learning-candle-labels-1` clock: `anchorTs = ceil(decisionTs / 60,000) * 60,000`, the reference is the close
of the one-minute bar closing at that anchor, and `horizonEndTs = anchorTs + 60 minutes`. It is therefore not
misstated as direct `decisionTs + 60 minutes` when a decision falls between candle boundaries. Censored and
unavailable labels remain nonnumeric and are never replaced by zero.

The store assigns the durable `issuedTs` and refuses a forecast arriving more than 5 seconds after its declared
`decisionTs` or at/after its target horizon. This is an engineering custody bound, not a zero-lag claim. Because
the candle anchor can equal the decision instant, the bound does not prove that no tick on the eventual target
path was observable before the forecast fsync completed. Evaluation must use the actual durable `issuedTs`; it
must never backdate the forecast to the caller's intended `decisionTs`.

## Selected published method

The method is the direct-radius Scale-Free Online Gradient Descent (SF-OGD) comparator from Algorithm 2 of
Bhatnagar, Wang, Xiong, and Bai (ICML 2023), not the more complex SAOCP expert meta-algorithm.

Primary references:

- [Bhatnagar et al., 2023, PMLR paper and PDF](https://proceedings.mlr.press/v202/bhatnagar23a.html)
- [Official Salesforce `online_conformal` repository](https://github.com/salesforce/online_conformal)
- [Pinned official release `v1.0.2` SF-OGD source](https://github.com/salesforce/online_conformal/blob/v1.0.2/online_conformal/ogd.py)
- [Pinned official release `v1.0.2` pinball gradient](https://github.com/salesforce/online_conformal/blob/v1.0.2/online_conformal/utils.py)
- [Gibbs and Candès, 2024, online conformal distribution-shift comparison](https://jmlr.org/papers/v25/22-1218.html)
- [Barber et al., limits of distribution-free conditional predictive inference](https://doi.org/10.1093/imaiai/iaaa017)

For point forecast `p_t`, target `y_t`, true radius `s_t = |y_t - p_t|`, desired coverage `q`, declared
scale `D`, current radius `delta_t`, and cumulative squared gradient `G_t`, the implemented update is:

```text
g_t = -q                  if s_t > delta_t
      1-q                 if s_t < delta_t
      0                   otherwise
G_t = G_(t-1) + g_t^2
delta_(t+1) = max(0, delta_t - D / sqrt(3 * G_t) * g_t)   when G_t > 0
```

The emitted interval before the outcome is `[p_t - delta_t, p_t + delta_t]`. The implementation matches the
official `ScaleFreeOGD.update` and `pinball_loss_grad` equations. The frozen parity vector in
`test/adaptive-uncertainty.test.js` checks nine consecutive radii at `q=.9, D=5` to (10^{-12}).

The paper assumes the true radii are bounded by the selected `D`. An observed residual larger than `D` is
recorded as a bound-assumption violation; it is not clipped or discarded. A declared unbounded comparison interval
is represented by null bounds/width/score, not by large invented finite endpoints.

## Delayed-label extension and custody

The paper and official code use an online predict-then-observe-then-update step. Serpent’s 60-minute labels overlap,
arrive later, and may be missing. This implementation therefore changes the feedback protocol:

1. append and fsync an immutable `FORECAST` carrying the exact predictor, information cutoff, original interval,
   procedure digest, and calibrator-state digest;
2. only after the horizon, append and fsync a terminal `SCORE` joined to that exact forecast;
3. update only the contiguous prefix of forecast issue order, appending a durable `UPDATE` after its score.

An unresolved earlier forecast blocks later scored forecasts. No later label jumps the queue, no missing label is
zero-filled, and variants/accounts cannot mint another forecast for the same primary `opportunityId`.
`CENSORED` and `UNAVAILABLE` terminal scores advance the ordered prefix without changing SF-OGD state.
Every state-changing update records an `availableAtTs` at or after the durable score timestamp. A later forecast
can use that state only when `availableAtTs <= informationCutoffTs`, preventing learned calibrator state from
being backdated into an earlier decision.

The journal is capped at 64 MiB, 200,000 rows, 50,000 primary forecasts, and 64 KiB per line. It is hash chained,
fully replayed before writes, protected by a single `wx` writer lock, and paired with a head record that detects
suffix truncation. There is no age-based or automatic stale-lock takeover. A crash can leave the lock in place;
operator-verified dead-writer recovery is a prerequisite before production-grade composition. This is deliberate
fail-closed behavior, not liveness inference.

## Diagnostics

For known outcomes the diagnostic reports:

- marginal empirical coverage;
- interval width;
- the standard two-sided interval score
  `width + 2/alpha * distance outside the interval`;
- known/censored/unavailable support;
- declared-`D` assumption violations.

These are aggregate marginal diagnostics only. They are not per-coin, per-regime, or conditional coverage
guarantees. One market episode remains one primary opportunity even if it has multiple variants or accounts.

## Explicit limitations

- **No theorem claim:** issue-order buffering with overlapping delayed and missing labels is not the immediate
  feedback protocol analyzed in the cited paper. The store therefore states
  `NONE_FOR_DELAYED_MISSING_OR_CENSORED_IMPLEMENTATION`.
- **No alpha claim:** the zero-return predictor is a null research baseline. An external predictor must earn its own
  prospective evidence; supplying one does not make it valid.
- **Point-forecast custody is not raw-feature custody:** the external port seals the supplied scalar value,
  predictor version/state digest, and `knownAtTs`; it does not independently capture or reproduce every raw fact
  or formula used by the caller. That evidence boundary remains an integration prerequisite.
- **No profitability or execution claim:** return coverage says nothing about fill probability, spread, fees,
  slippage, market impact, realized P&L, or safe size.
- **No behavioral authority:** diagnostics cannot veto, promote, size, trade, or modify paper behavior.
- **Local custody only:** no external checkpoint binding or runtime composition exists in this slice.
- **No advanced early-hint method:** that work remains queued. It is not required for this bounded reference
  implementation and must not be implied by these outputs.

Before any consumer integration, the shared owner must bind the existing account-independent
`opportunityIdOf`, provide an audited 60-minute label adapter, add explicit externally durable custody or a
verified recovery procedure, and run prospective calibration/coverage diagnostics without promoting the result.
