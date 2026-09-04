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
| emission cadence | one observation/symbol/5 s |
| emission hard cap | 144 observations/minute |

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

## 12. Failure isolation

A tracker failure never kills tape: the failing symbol is isolated, MICRO
health degrades, the fault is logged safely (rate-limited), the OrderBook
is untouched, the WebSocket keeps running, and no observation is
fabricated. Tape remains the primary transport.
