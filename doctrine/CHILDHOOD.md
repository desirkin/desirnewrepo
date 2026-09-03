# CHILDHOOD DOCTRINE — point-in-time memory construction (B-0)

## Charter

"B-0 is not a backtest whose purpose is to prove Serpent works. It is a point-in-time memory-construction system whose purpose is to let Serpent wake with calibrated expectations. At every historical timestamp, Serpent may see only information that existed at that timestamp. Future price action is used exclusively to label the frozen observation afterward. Preserve failures, missing data, delisted/changed markets, market context, and provenance. Never infer unavailable historical features. Thirty days is the dense-market warm-start window; rare-event modules use deeper reliable history where available. Historical and live observations must share the same schema so that Serpent cannot learn under rules different from those it will actually trade under."

## The wall, in code

`childhood/store.js` exposes candles only through an `asOf(T)` view whose
every accessor refuses timestamps beyond T. The replay engine
(`childhood/replay.js`) builds and freezes Observations through that view —
it cannot see the future even by bug, because the future is not reachable
from the object it holds. A separate labeler (`childhood/labeler.js`) opens
the full store afterward and writes Outcomes to a different file. The wall
is unit-tested: view access beyond T throws; frozen Observations contain no
Outcome fields.

## Shared schema

**Observation** `data/childhood/observations.jsonl` (one per frozen moment):

```
{ id, ts, symbol, track,                      // track: 60m|15m|5m|1m replay lane
  eligibleAtTime,                             // TRADED_AT_TS (candle-evidenced) | UNKNOWN — never today's universe assumed backward
  priceState:  { close, ret1, ret5m?, ret15m?, ret1h?, extensionPct },
  volumeState: { vol, volRateZ },
  marketContext: { btcRet, ethRet, universeMedianRet, atHorizon },
  scoutSignals: { zVol, zRet, extensionPct }, // the wide-eye math, replayed point-in-time
  externalSignals: { rumint: "UNAVAILABLE_HISTORICALLY", gateway: "UNAVAILABLE_HISTORICALLY" },
  microstructure: { absorption: "UNKNOWN_HISTORICALLY", refill: "UNKNOWN_HISTORICALLY", cancels: "UNKNOWN_HISTORICALLY",
                    aggressionImbalance }     // real value only where trades enrichment covers the ts; else UNKNOWN_HISTORICALLY
  dataAvailability: { <field>: KNOWN|UNKNOWN|UNAVAILABLE },
  provenance: { <field>: { source, sourceTs, retrievedTs, kind: historical|live, form: raw|derived } },
  setupClassification }                       // RIPPLE | MISSED | BASELINE_SAMPLE
```

**Outcome** `data/childhood/outcomes.jsonl` (separate object, written by the
labeler only, keyed by observation id — never readable during construction):

```
{ id, mfe: {1m,3m,5m,15m,30m,1h,4h}, mae: {same horizons},   // null where the track's resolution cannot honestly resolve the horizon
  moveAlreadySpentPct, moveRemainingPct,
  abnormalReturn: { vsBtc, vsEth, vsUniverseMedian },        // at 1h
  label }                                                    // run | fizzle | reversal | pump | beta-drag
```

**Label rules** (precedence: pump → reversal → run → beta-drag → fizzle), on
the 1h/4h horizon where the track resolves it:

- **pump**: MFE₁ₕ ≥ 3% and ret₄ₕ ≤ 0.5% — the spike that round-trips.
- **reversal**: MFE₁ₕ ≥ 1.5% and ret₁ₕ ≤ −0.5% — beautiful, then betrayed.
- **run**: MFE₁ₕ ≥ 2% and ret₁ₕ ≥ 1% — the real thing.
- **beta-drag**: ret₁ₕ ≥ 1% but abnormal-vs-universe-median < 0.3% — the tide, not the fish.
- **fizzle**: everything else — the jar must be large, and it is.

## Layered density (a venue fact, not a choice)

Kraken's public OHLC endpoint returns **at most ~720 candles per interval
regardless of `since`** (verified live 2026-09-03: 721 candles at every
interval). The venue therefore does not serve 30 days of 1m history, and
reconstructing it from the Trades endpoint for 600+ pairs would take days of
polite polling. Per this charter, the gap is preserved, not papered over:

| Track | Span served | Coverage |
|---|---|---|
| 60m | ~30 days | full point-in-time USD universe |
| 15m | ~7.5 days | full point-in-time USD universe |
| 5m | ~2.5 days | deep-tape universe |
| 1m | ~12 hours | deep-tape universe |
| Trades (time-and-sales) | bounded request budget | majors only, coverage window recorded per symbol |

**KNOWN GAP: no 1m density beyond ~12h, no 5m density beyond ~2.5d.** L2
depth/absorption/refill/cancel history does not exist publicly at all →
those fields are UNKNOWN_HISTORICALLY everywhere trades enrichment does not
reach. Point-in-time listing status is not served by any public Kraken
endpoint → `eligibleAtTime` is TRADED_AT_TS only where candles evidence
actual trading at that timestamp, UNKNOWN otherwise; today's universe is
never assumed backward.

## Deep memory (rare events)

- **Governance**: Snapshot hub (public GraphQL) proposals for universe
  tokens with curated, verified space mappings; full proposal timelines
  (created/start/end/state, scores, quorum). Lock analysis:
  **MATHEMATICALLY_LOCKED** requires knowing remaining eligible voting
  power, which Snapshot does not expose → where that basis is absent the
  label is **STATISTICALLY_NEAR_CERTAIN** (with the margin basis recorded)
  or **LOCK_TIME=UNKNOWN** — never an estimate dressed as fact. Tally
  requires an API key; this project holds no keys → **UNAVAILABLE**,
  recorded as a gap.
- **Exchange incidents**: Kraken's public status archive (recent incident
  history) under the same Observation/Outcome discipline where incident
  windows overlap candle coverage.

## Splits

All archived memory is partitioned temporally per track: first ~70%
**DISCOVERY**, last ~30% **VALIDATION**, boundaries recorded in
`data/childhood/manifest.json`. Live paper trading remains a further,
untouched test. **No analysis in B-0 may report "performance." B-0 builds
memory; it proves nothing.**

---

# B-0A HARDENING AMENDMENT

> **Serpent is allowed to remember only what he could have known. The future
> may judge a memory, but it may never help create one.**
>
> Childhood is not evidence of intelligence. Childhood is the evidence from
> which intelligence may later be tested.

## KNOWLEDGE TIME

`sourceTs` is when a fact happened. `availableTs` is the earliest defensible
moment it was **publicly observable**. They are different concepts and are
never silently equated (an incident that began 10:01 but was first posted
10:07 reaches replay at 10:07, not 10:01). Replay may consume a field only
when `availableTs <= replayTs`; where the source cannot establish first
public observability, the field is UNKNOWN/UNAVAILABLE for point-in-time
reconstruction — never guessed. Applied to: OHLC bars (available at bar
close), trades buckets (available when the bucket fully elapses), incident
history (anchored at the first public status update), governance (proposal
existence at creation; final scores and any lock claim at voting close;
un-retrieved vote timelines → UNKNOWN).

## CLOSED-BAR REPLAY

An OHLCV candle does not reveal its intrabar sequence, so replay decisions
use **fully closed bars only**: at 10:32:00 the replay may consume the
closed 10:31 bar, never the still-forming one. The store's `asOf` views
judge visibility by bar **close** time, and replay code consumes a forward
iterator of closed bars — it never holds the store. No intrabar ordering is
ever interpolated. Trades-level enrichment uses true trade timestamps.

## OBSERVATION/OUTCOME WALL

Unchanged and strengthened: observation builders receive only the closed-bar
iterator (the future is unreachable, not filtered); the labeler alone opens
post-T history, into a separate file. Adversarially tested.

## EVENT CLUSTERING

Repeated triggers during one continuous episode share one `eventId`
(deterministic rule: same symbol+track, successive trigger/near-miss
observations within `max(30min, 2 bars)`; baselines stand alone). Future
profitability plays no part in clustering. Analysis must distinguish
observation counts from **unique event** counts; one event never splits
across partitions.

## SPLIT EMBARGO

The maximum labeling horizon is 4h, so a DISCOVERY event's entire horizon
must end **before** the nominal boundary: events whose window + 4h crosses
it are **EMBARGOED** (archived, excluded from both learning populations).
The manifest records nominal split, discovery-last-usable, embargo start/end,
and validation-first-usable timestamps per track.

## NEAR MISSES

A third population beside TRIGGER and BASELINE: observations at least 2/3 of
the way to **every** live promotion gate that still failed one or more.
Stored with promotionScore/threshold/distance and the exact failed/passed
requirements — determined entirely from the frozen state at T; outcome
information can never define a near miss. **No live threshold was changed to
collect them.**

## OUTCOME TAGS

Numeric outcome fields (MFE/MAE ladder, returns, abnormal returns, move
spent/remaining) are the primary truth. Tags are multi-label convenience
metadata with deterministic mechanical definitions — no narrative labeling:

- **RUN**: MFE₁ₕ ≥ 2 and ret₁ₕ ≥ 1
- **PUMP_LIKE**: MFE₁ₕ ≥ 3 and ret₄ₕ ≤ 0.5
- **REVERSAL**: MFE₁ₕ ≥ 1.5 and (ret₁ₕ ≤ −0.5 or ret₄ₕ ≤ −0.5)
- **BETA_DRAG**: ret₁ₕ ≥ 1 and abnormal-vs-universe-median < 0.3
- **FIZZLE**: no other tag applies

One outcome may validly carry several tags (a move can RUN in hour one and
REVERSE by hour four). `moveAlreadySpent` anchors to the close of the last
bar fully closed 15 minutes before replayTs — trailing information only,
provably invariant to whatever the future does.

## UNKNOWN DISCIPLINE

Reinforced everywhere: no manufactured absorption, no cancel velocity
inferred from OHLCV, no eligibility projected backward, no lock time
estimated, no first-public timestamp substituted by event timestamp. No
fallback converts UNKNOWN into YES or NO. A smaller honest childhood beats a
larger fictional one.

## REPRODUCIBILITY

Every archive's manifest records schema/childhood/wide-eye/labeler/universe/
provenance rule versions, source dataset identifiers and checksums, the
deterministic random seed and sampling strata table, the code commit, split
and embargo boundaries, counts by population/tag/availability, observation
and unique-event counts, and known gaps — so "did Serpent improve, or did
his childhood change?" is always answerable. Sampling is stratified
(near-threshold / off-hours / market-moving / ordinary) with per-row
inclusion probabilities stored; prevalence is never pretended. Superseded
archives are renamed as development artifacts and never merged.
