# MICROSTRUCTURE (MICRO-1) — the dark microstructure sense

> **MICROSTRUCTURE is a sense, not a strategy.**
>
> **Aggregate Level-2 changes do not identify exact cancellations, exact new
> orders, queue position, hidden liquidity, or liquidity providers.**
>
> **Absorption, replenishment and refill are proxies unless stronger data
> later makes them directly observable.**
>
> **Strong measured microstructure does not authorize a trade.**

## 1. What it is

MICRO-1 teaches Serpent to feel the market's internal pressure for a small
bounded set of symbols: who is aggressively hitting the market, whether
price gives way, which side is losing visible liquidity, how fast that
liquidity returns, and whether the market refuses to move despite
aggressive flow. It observes and remembers. It does not trade, and history
will decide when anything may.

Module: `tape/microstructure.js`. It is fed by the existing tape runner —
**one** Kraken WebSocket v2 connection, the existing `trade` and `book`
channels, the existing `OrderBook` synchronization/checksum truth. No new
transport, no credentials, no new data provider, no new dependency.

## 2. Aggressor-side truth

Kraken trade messages carry the taker side directly: `side = buy` is
aggressive/taker buying; `side = sell` is aggressive/taker selling. MICRO-1
records this verbatim and never replaces it with a tick rule, Lee-Ready, or
price-vs-mid inference.

## 3. The L2 limitation (non-negotiable)

The book is **aggregate Level 2**. It does not reveal order IDs, queue
position, provider identity, hidden liquidity, or whether a negative
quantity change was an execution, a cancellation, a replacement, or several
orders at once. Therefore MICRO-1 speaks only in proxies —
`visibleBidDepletionPct`, `visibleAskDepletionPct`, `depthRecovery50Ms`
(a **depth recovery proxy**), `absorptionProxy` — and every observation
carries the attribution `AGGREGATE_L2_UNATTRIBUTED`. Fields such as
`exactCancelVolume`, `confirmedAbsorption`, or `makerIdentity` are
forbidden and tested against.

## 4. Timing limitation

Trades carry Kraken timestamps; book samples carry **local application
time** (`OrderBook.lastUpdateTs`). Transport batching and processing
latency mean exact causal trade→book sequencing is not exchange-time truth.
Observations carry both clocks in provenance
(`LOCAL_BOOK_APPLICATION_CLOCK`) and never pretend millisecond causal
certainty.

## 5. Tracking bound

A symbol is tracked only while **all three** hold:

    ACTIVE STALKING (state/stalking.json, unexpired)
    ∩ SUBSCRIBED on the tape (in the universe, not UNAVAILABLE/shed)
    ∩ SYNCHRONIZED order book

This is a sensing set, not the UI attention set — `ui/attention-view.js`
is never consulted, and fallback majors on the cockpit are not MICRO
targets. When a symbol leaves the set its process-local tracker state is
kept for a **30 s grace interval** and then discarded. Durable MICRO
observations already written to Memory remain.

## 6. Bounded state (documented limits)

Per `MICRO_LIMITS` in `tape/microstructure.js`:

| bound | value |
| --- | --- |
| max tracked symbols | 12 |
| trade horizon | 300 s (ring cap 4000 trades/symbol; overflow counted) |
| book sample interval | ≥ 500 ms |
| sample horizon | 90 s (ring cap 240 samples/symbol) |
| completed episodes kept | 12/symbol |
| episode max age | 120 s (then closed EXPIRED, milestones stay null) |
| grace after leaving set | 30 s |
| internal evaluation tick | 5 s (transition detection — NOT a write cadence) |
| durable periodic baseline | one observation/symbol/**30 s** (≤2/min/symbol) |
| transition emissions | ≤6/min/symbol, latched queue capped at 12 (overflow counted) |
| global durable ceiling | **36 observations/minute** — an emergency cap, not a target |

## 7. What is measured

- **Aggressive flow** over 5 s / 15 s / 60 s / 300 s windows:
  `aggressiveBuyQty`, `aggressiveSellQty`, notionals (price × qty), trade
  counts, `signedQty`, `signedNotionalUsd` (buys positive), quantity and
  notional imbalances (null when no flow — never zero). These are
  explicitly named rolling fields; the existing process-lifetime `cvd`
  field is untouched and is **not** a 5-minute CVD.
- **Price response** over 5 s / 15 s / 60 s: `startMid`, `endMid`,
  `midReturnPct`, plus the window's flow, and
  `priceResponsePerSignedNotional` (pct per $1M signed notional) — a
  **historical measured response**, never alpha/edge/prediction/confidence.
  Insufficient history is `UNKNOWN_INSUFFICIENT_HISTORY`.
- **Flow/price divergence** is preserved as its underlying facts (strong
  flow beside small response) — never reduced to one opaque signal.
- **Spread dynamics** over 60 s: `spreadBps`, `spreadChangeBps`,
  widening/compression magnitudes. Measurements only.
- **Depth pressure** per labeled band (top / 5 / 10 / 25 bps): depth deltas
  (USD and %), `obiDelta`, visible depletion percentages. Bands are never
  mixed into one unlabeled number.
- **Band coverage**: each band on each side reports `COMPLETE` (subscribed
  levels extend past the band boundary) or `PARTIAL` (the subscribed book
  ends inside the band — a lower-bound observation, never presented as
  complete depth).
- **Book age**: `bookAgeMs` from `OrderBook.lastUpdateTs` — never general
  pair freshness. A book older than the tape's stale doctrine marks all
  book-derived measurements `STALE`.

## 8. Depletion and recovery (proxies)

A **visible depletion episode** opens on one side of the 10 bps band when a
sample-to-sample drop removes ≥ 35 % of a band that held ≥ $2,000 visible
notional. It records depletion time, pre/post depth, depleted amount, side,
band, and coverage. Recovery milestones `depthRecovery50Ms` /
`depthRecovery90Ms` are the elapsed time until 50 % / 90 % of the measured
visible depletion has returned — a **depth recovery proxy** that does not
prove the same order, maker, or provider returned. Episodes expire after
120 s with unreached milestones left null (honest, not zero).

**Recovery asymmetry** compares median `depthRecovery50Ms` across completed
episodes only when both sides have at least one; value
`(ask − bid)/(ask + bid)` (positive = bid side recovers faster). Otherwise
`UNKNOWN` — never an invented zero.

## 9. absorptionProxy

`ABSORPTION_PROXY`, never `ABSORPTION_CONFIRMED`. Its buy-side definition
(inverse for selling): 60 s notional imbalance ≥ 0.6 with dominant-side
notional ≥ $25k, |60 s mid return| ≤ 0.05 %, opposing 10 bps visible depth
change ≥ −10 %, with a fresh book and COMPLETE opposing-band coverage.
These constants define the *observation*, not a trading rule. Every proxy
observation preserves the flow magnitude, signed notional, price response,
depth state, coverage, book age and the L2 attribution — a future Brain can
disagree with it. Prerequisites missing → `UNAVAILABLE`; stale book →
`DEGRADED`.

## 10. Memory integration

Flow: existing Kraken WS → existing tape OrderBook/TradeFlow →
`MicrostructureTracker` → append-only `micro/observations.jsonl` → pure
adapter `fromMicrostructureObservation()` → MemoryBus validation →
MemoryStore → durable PostgreSQL pump. Nothing bypasses the validator,
digest rules, ID/content conflict behavior, or persistence.

- `sourceModule: MICROSTRUCTURE` (already reserved in the canonical enum)
- `eventType: MICROSTRUCTURE_OBSERVATION`
- families: `ORDER_FLOW`, `LIQUIDITY`, plus `MARKET_PRICE` only when the
  observation carries an actual measured price-response window
- availability: KNOWN / UNKNOWN / UNAVAILABLE / STALE / DEGRADED preserved;
  insufficient history is never zero
- provenance: channels, clocks, window definitions, subscribed depth,
  episode/depletion definitions, tracker version, `AGGREGATE_L2_UNATTRIBUTED`
- payload carries measured evidence only — no BUY/SELL/entry/exit/
  size/confidence/edge fields exist

## 11. Zero trading weight (non-negotiable)

MICROSTRUCTURE has **zero** influence on posture, stalking, STRIKE,
DIGESTING, prediction creation, ledger, cost, KILL/CAGE/VETO/CLEAR, trade
eligibility, entry, exit, or sizing. No trading or control module imports
it; no subscriber turns it into permission. MICRO listens and remembers.

## 12. Durable cadence and storage (MICRO-1A)

**Serpent may watch fast. He does not write the same thought into permanent
memory every five seconds.** Sensing cadence and Memory cadence are
explicitly different things:

- **Internal sensing** stays fast: book samples up to 2/s, rolling
  5/15/60/300 s windows continuously maintained, episodes tracked live.
- **Durable periodic baseline**: one observation per tracked symbol every
  **30 s** (`emitReason.kind = PERIODIC`), still describing the current
  rolling windows — future learning sees ordinary conditions, not only
  drama.
- **Transition observations** (`emitReason.kind = TRANSITION`) emit
  promptly when something real changes: a depletion episode opens, the 50 %
  recovery milestone is first reached, an episode closes (recovered or
  window-expired), `absorptionProxy` enters or leaves PRESENT, or the book
  crosses FRESH↔STALE. Each transition is latched exactly once, carries a
  deterministic `transitionKey` (`symbol|kind|side|anchor-clock`), and a
  persisting condition **never re-emits** — periodic baselines describe its
  persistence. A transition record also resets that symbol's periodic clock.
- **Rate caps**: ≤6 transition emissions/min/symbol; global ceiling **36
  durable observations/minute**. A suppressed record is counted
  (`observationsSuppressedByRateLimit`) and surfaced in MICRO health —
  never silently pretended persisted. Suppressed transitions stay latched
  (bounded queue, overflow counted) for the next tick.
- **Storage health counters**: `durableObservationsEmitted`,
  `periodicObservationsEmitted`, `transitionObservationsEmitted`,
  `observationsSuppressedByRateLimit`, `transitionsDroppedAtCap`,
  `approxBytesWritten`.

**Approximate storage projection** (representative records measured at
~3.8 KB source JSONL + ~4.7 KB canonical envelope ≈ 8.5 KB combined before
database overhead — an estimate, not an exact figure):

- typical (2 tracked symbols, quiet): ~4/min ≈ **~1.5 GB/month combined**
- full saturation (12 symbols, 24/min periodic + transitions):
  ≈ 24–36/min ⇒ **~8.8–13.2 GB/month combined** at the ceiling
- versus MICRO-1's prior worst case of 144/min ≈ ~53 GB/month combined

The one-hour deterministic simulation in `test/micro-emission.test.js`
measured 242 observations for two symbols (240 periodic, 2 transition),
avg 3.97/min, max 4/min — two orders of magnitude below internal sensing.

Broader canonical Memory retention/archive/compaction remains a **separate
architecture issue**; MICRO-1A's responsibility is that this sensor does
not unnecessarily accelerate it.

### 12b. Durable acknowledgement boundary (MICRO-1B)

**Serpent may say "I remembered this" only after it actually hit durable
storage.** Emission is two-phase: PREPARE freezes at most one record per
symbol; only a SUCCESSFUL append acknowledges it. Durable counters, byte
accounting and the periodic baseline clock move on ACK alone. A failed
append keeps the frozen record pending and retries it VERBATIM on later
ticks — so even an ambiguous outcome cannot duplicate: the identical
content carries one Memory identity and collapses. Write failures are
counted (`durableWriteFailures`, `lastDurableWriteError`,
`lastDurableWriteFailureTs`), degrade MICRO health, and never touch the
Kraken tape or the other tracked symbols.

**MICRO-1C — prepared evidence is HISTORY.** The PREPARE snapshot is a
deeply frozen structured clone, fully detached from live episodes, depth,
flow and coverage: once Serpent prepares a memory of what it saw at time
T, the market changing at T+5 cannot change it. Serialized bytes at the
first write attempt are identical at every retry — a retry retries
history, never rewrites it. New transitions occurring behind a failed
write queue separately and get their own truthful record afterwards.

**Durability drain (MICRO-1D lifecycle).** The lifecycle is explicit and
zombie-free: **ACTIVE** (the only state that senses) → **DRAINING** (a
departed symbol's owed evidence, held in a separate bounded debt ledger —
it senses nothing; its first 30 s is the grace phase of cleanup) →
**REMOVED**. Sensing stops the INSTANT eligibility ends — the grace
interval is never an extra sensing period; no trade, sample, episode or
transition may originate after departure. Old durable debt and new active
sensing are SEPARATE OBJECTS: a re-stalked symbol receives a brand-new
clean active state (no stale buffers, no manufactured continuity across
the observation gap) while its old frozen debt drains untouched beside
it. The ACTIVE cap (12) and the DRAIN cap (6) are separate bounds — drain
debt never occupies an active tracking slot. Latched-but-unprepared
transitions freeze into one final minimal record marked
`SENSING_STOPPED_BEFORE_EMISSION`. Debts live at most grace+120 s; beyond
capacity or age, evidence is dropped EXPLICITLY — `pendingEvidenceDropped`
counts it, the reason is recorded, health degrades — never silently. The
per-symbol transition limit (≤6/min) counts successful durable ACKs
through ONE shared accounting path covering both the active evaluate()
path and the drain path — no cross-path escape exists.

**Write-health recovery.** Historical failure counts never erase; current
health is separate: `writeImpaired` is true while the latest write outcome
is a failure or any failed record still awaits its ACK, and clears when
writes succeed again with nothing failed left pending — MICRO then returns
HEALTHY while `durableWriteFailures` keeps its history. The per-symbol
transition window (≤6/min) counts successful ACKs — preparing or retrying
an unacknowledged record is not an emission.
`observationsSuppressedByRateLimit` counts suppressed ATTEMPTS (a blocked
retry counts each time), not unique observations lost. Repeated identical
write-failure logging is coalesced (≥60 s apart) while counting never
stops.

## 12a. Episode clock and window (MICRO-1A/1B)

Every time field of one episode — depletion, 50 %/90 % milestones and
closure — derives from the SAME supplied observation/replay clock;
`Date.now()` never appears inside episode handling, so historical replay is
deterministic. The episode window is an **observation-window policy** with
an **inclusive** endpoint: a sample at exactly `episodeMaxAgeMs` may still
record a milestone; a sample strictly later closes the episode FIRST with
outcome `RECOVERY_UNOBSERVED_WITHIN_WINDOW` — meaning recovery was not
observed inside the defined window, never that the market definitely never
recovered. No milestone is ever manufactured from a sample outside the
window. **An observation window ends when its clock ends** (MICRO-1B): the
evaluation path closes an overdue episode on the same supplied clock even
if the book has fallen silent — the market does not get to keep an episode
"active" by simply not sending another message. One episode closes once;
one `EPISODE_WINDOW_EXPIRED` transition latches once; a later
recovery-shaped sample neither reopens it nor retroactively counts.

## 13. Failure isolation

A tracker failure never kills tape: the failing symbol is isolated, MICRO
health degrades, the fault is logged safely (rate-limited), the OrderBook
is untouched, the WebSocket keeps running, and no observation is
fabricated. Tape remains the primary transport.
