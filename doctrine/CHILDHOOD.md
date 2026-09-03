# CHILDHOOD DOCTRINE — point-in-time memory construction (B-0 · B-0A · B-0B)

## Charter (B-0, controlling)

"B-0 is not a backtest whose purpose is to prove Serpent works. It is a point-in-time memory-construction system whose purpose is to let Serpent wake with calibrated expectations. At every historical timestamp, Serpent may see only information that existed at that timestamp. Future price action is used exclusively to label the frozen observation afterward. Preserve failures, missing data, delisted/changed markets, market context, and provenance. Never infer unavailable historical features. Thirty days is the dense-market warm-start window; rare-event modules use deeper reliable history where available. Historical and live observations must share the same schema so that Serpent cannot learn under rules different from those it will actually trade under."

> **Serpent is allowed to remember only what he could have known. The future
> may judge a memory, but it may never help create one.**
>
> **Historical Serpent must also think with the same definitions as Live
> Serpent. A leak-free replay that measures a different phenomenon is not
> parity.**
>
> **When exact historical reconstruction of a live feature is impossible,
> record the feature as unavailable. Never substitute a different timescale
> or metric and give it the same name.**
>
> Childhood is not evidence of intelligence. Childhood is the evidence from
> which intelligence may later be tested.

---

## THE AUTHORITATIVE SCHEMA (one, current: `childhood-observation-3-b0b`)

Everything older is obsolete. There is no second schema.

**Observation** — `data/childhood/observations.jsonl`, one per frozen moment:

```
{ id, ts, symbol, track,                    // ts = the moment values became knowable (bar close / sample time)
  trackRole,                                // PARITY_SCOUT | CONTEXT_ONLY
  population,                               // TRIGGER | NEAR_MISS | BASELINE
  wouldEmitLive,                            // PARITY triggers only: false = COOLDOWN_SUPPRESSED, not a live event
  eventId, eventSymbol, firstTriggerTs, triggerTs, triggerSequence,
  eligibleAtTime,                           // TRADED_AT_TS (candle-evidenced) | UNKNOWN.
                                            // KNOWN_ONLINE_AT_TS / LIVE_RULES_ELIGIBLE_AT_TS are NOT historically
                                            // establishable and are never claimed.
  priceState,                               // PARITY: {close, ret1, ret5, extensionPct} — LIVE definitions at true minutes.
                                            // CONTEXT: {close, retTick1, retTick5, trackTickMinutes} — named by TRACK TICKS,
                                            // never by live feature names. Five hours is never called five minutes.
  volumeState,                              // PARITY: {volRate (live definition), rolling24hVolume | UNKNOWN_INSUFFICIENT_WARMUP, barVolume}
                                            // CONTEXT: {barVolume} only — raw candle volume is NOT volRate.
  marketContext: { btcRet, ethRet, universeMedianRet, atHorizon },   // trailing closed bars only
  scoutSignals,                             // PARITY: {zVol, zRet, extensionPct} via the SHARED live core.
                                            // CONTEXT: the string 'UNAVAILABLE_ON_CONTEXT_TRACK'.
  nearMissDetail?,                          // NEAR_MISS only: promotionScore/threshold/distance, failed/passed requirements
  samplingMeta?,                            // BASELINE only: {stratum, inclusionProbability, seed}
  externalSignals: { rumint, gateway },     // UNAVAILABLE_HISTORICALLY
  microstructure: { absorption, refill, cancels, aggressionImbalance },  // UNKNOWN_HISTORICALLY unless trades-enriched
  dataAvailability: { <field>: KNOWN|UNKNOWN|UNAVAILABLE },
  provenance: { <field>: { source, sourceTs, availableTs, retrievedTs, kind: historical|live, form: raw|derived } },
  setupClassification,                      // PARITY: RIPPLE | MISSED | NEAR_MISS | COOLDOWN_SUPPRESSED | BASELINE_SAMPLE
                                            // CONTEXT: CONTEXT_SAMPLE — a context track can NEVER carry a wide-eye classification
  split }                                   // DISCOVERY | EMBARGOED | VALIDATION (event-level, embargoed 4h around the boundary)
```

**Outcome** — `data/childhood/outcomes.jsonl`, written by the labeler only,
keyed by observation id, never readable during Observation construction:

```
{ id, eventId,
  mfe: {1m,3m,5m,15m,30m,1h,4h}, mae: {same},   // null where the track's resolution cannot honestly resolve the horizon
  ret1hPct, ret4hPct,
  moveAlreadySpentPct,                          // the frozen extensionPct at T (parity tracks only; else null) — trailing anchor,
                                                // provably invariant to whatever the future does
  moveRemainingPct,                             // MFE 1h
  abnormalReturn: { vsBtc, vsEth, vsUniverseMedian },
  outcomeTags[] }                               // multi-label, deterministic, numeric fields are the primary truth
```

**Outcome tags** (mechanical; precedence-free, independent predicates; FIZZLE
only when nothing else applies): RUN (MFE₁ₕ≥2 ∧ ret₁ₕ≥1) · PUMP_LIKE
(MFE₁ₕ≥3 ∧ ret₄ₕ≤0.5) · REVERSAL (MFE₁ₕ≥1.5 ∧ (ret₁ₕ≤−0.5 ∨ ret₄ₕ≤−0.5)) ·
BETA_DRAG (ret₁ₕ≥1 ∧ abnormal-vs-median<0.3) · FIZZLE.

---

## KNOWLEDGE TIME

`sourceTs` = when a fact happened. `availableTs` = the earliest defensible
moment it was **publicly observable**. Never silently equated. Replay
consumes a field only when `availableTs ≤ replayTs`; unestablishable
availability ⇒ the field is UNKNOWN/UNAVAILABLE, never guessed. Applied to:
OHLC bars (knowable at bar close), trades buckets (at bucket elapse),
incidents (at the **earliest** public publication timestamp across creation
and every update — never array position), governance (proposal existence at
creation; final scores and any lock analysis at voting close; each vote at
its own public timestamp; un-retrieved timelines → UNAVAILABLE).

## CLOSED BARS, AT THE SOURCE

Kraken's REST OHLC ends with the current **uncommitted** candle. It is
excluded at ingestion, defensively: the documented final row is dropped AND
any row whose close time exceeds retrieval time is rejected as not yet
knowable. `CandleStore` never sees an unfinished row. Visibility everywhere
is judged by bar **close** time; intrabar ordering is never inferred.

## LIVE/REPLAY PARITY (B-0B)

Live Wide Eye is the source of truth for feature semantics. Live and
parity replay share ONE pure calculation module (`survey/eyecore.js`):

- **1m/5m returns and 15m extension at true minutes** — only a genuine
  1-minute grid may produce them.
- **volRate** = max(0, Δ rolling-24h base volume between consecutive 1m
  samples), reconstructed from real 1m bars; **raw candle volume is never
  called volRate**. Until a full 24h of prior samples exists: UNKNOWN,
  zVol null, no signal.
- **minSamples**: the exact live configured value. History gets no easier
  standard.
- **Ordering**: the current sample joins its baseline BEFORE the z-score is
  computed — the live ordering, mirrored exactly. (Whether that ordering is
  ideal is a separate, later question; B-0B changes nothing live.)
- **7-day baseline retention**, identical pruner.
- **Cooldown**: a co-fire inside `rippleCooldownMin` is archived as
  `COOLDOWN_SUPPRESSED` with `wouldEmitLive=false` — never counted as a
  live-equivalent RIPPLE; the cooldown timer refreshes only on emission,
  as live does.
- **Warm-up**: replay never has more trailing information at its first
  scored point than live would; nothing scores before the 24h volume window
  and the live minimum-sample baseline are both genuinely earned.

**Track roles.** Only `PARITY_SCOUT` (true 1m) may emit RIPPLE / MISSED /
NEAR_MISS / COOLDOWN_SUPPRESSED. `CONTEXT_ONLY` (60m/15m/5m) exists for
context, regime memory, and outcome labeling at horizons it honestly
resolves — with tick-named features and no wide-eye output, ever.

**NO-TRADE MINUTES.** Kraken 1m data omits minutes without trades; live Wide
Eye still surveys them. The grid represents them as explicit
`NO_TRADE_SAMPLING_POINT`s: last price carries unchanged, traded volume is
zero, rolling-24h volume may decay, provenance distinguishes them from
`REAL_OHLCVT_BAR`s. A sampling representation — never a fabricated trade.

**Parity source status:** `FAST_MEMORY_PARITY_STATUS =
UNAVAILABLE_WITH_CURRENT_SOURCE`. REST 1m (~12h) is below the 24h volume
warm-up; Kraken's downloadable OHLCVT (1m, full history) is distributed as a
multi-GB Google Drive ZIP updated **quarterly**, so its freshest data ends at
the prior quarter boundary and cannot cover a current 30-day window (nor is
that retrieval operationally reasonable here). The parity engine is
implemented and fixture-proven; a true parity childhood (≈8 days warm-up +
30 days archive) awaits an adequate source. **No coarse-track substitute is
permitted.**

## EVENT CLUSTERING & SPLIT EMBARGO

Repeated triggers within `max(30min, 2 bars)` share one `eventId`
(deterministic; future-blind). Analysis distinguishes observations from
unique events. One event never straddles partitions; a DISCOVERY event's
full 4h labeling horizon must end before the nominal boundary, else
EMBARGOED (archived, excluded from both). Boundaries recorded per track.

## NEAR MISSES

≥2/3 of the way to every unchanged live gate, still failing at least one —
with promotionScore/distance and exact failed/passed requirements, from the
frozen T-state only. No threshold was changed to collect them.

## UNIVERSE / SURVIVORSHIP HONESTY

The pair list starts from TODAY's AssetPairs, so pairs delisted before today
are invisible: `universeCoverageStatus =
SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET`, stated in plain English in the
manifest. `TRADED_AT_TS` proves trading occurred at that timestamp — it does
NOT prove online status or live-rules eligibility, which are historically
unavailable → UNKNOWN. Today's universe is never projected backward as a
claim of completeness.

## GOVERNANCE HONESTY

Snapshot proposals are **paginated to exhaustion** (or a documented ceiling,
manifested as a gap — never silent truncation). Vote timelines are retrieved
where the public API serves them, each vote timestamped as its own
availableTs; `QUORUM_REACHED_TS` is reconstructed deterministically where
quorum and per-vote power permit. **`STATISTICALLY_NEAR_CERTAIN` is not
produced** — the old final-margin heuristic was uncalibrated and is gone;
inevitability is `INEVITABILITY_UNKNOWN` unless `MATHEMATICALLY_LOCKED` can
actually be proven (it cannot, from Snapshot data alone). Descriptive final
facts (margin, margin % of cast power, quorum met,
`FINAL_MARGIN_DECISIVE_UNCALIBRATED`) are preserved as facts, never as
probabilities. Tally: UNAVAILABLE (no keys).

## UNKNOWN DISCIPLINE

No manufactured absorption; no cancel velocity from OHLCV; no eligibility
projected backward; no lock time estimated; no first-public timestamp
substituted by event timestamp; no fallback converting UNKNOWN into YES or
NO. A smaller honest childhood beats a larger fictional one.

## THE WALL, IN CODE

Observation builders receive forward iterators / frozen grids — the future
is structurally unreachable, not filtered. The labeler alone opens post-T
history, into a separate file. Adversarially tested.

## STAGING, VALIDATION, PROMOTION

A new childhood builds in `data/childhood-staging-<runId>` while the
authoritative archive stays untouched. A post-build validator checks parse
integrity, id uniqueness, outcome references, wall violations, knowledge
time, uncommitted-candle absence, event/split isolation, embargo rules,
context-track output prohibition, governance honesty, manifest-vs-content
counts, and schema version. **Promotion fails closed.** On success the old
archive is superseded (clearly named, never merged); a failed promotion
rolls back. The reproducibility manifest records versions, sources,
checksums, seed, commit, boundaries, counts, parity status, and gaps — so
"did Serpent improve, or did his childhood change?" is always answerable.
