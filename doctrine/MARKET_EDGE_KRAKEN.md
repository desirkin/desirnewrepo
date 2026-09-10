# MARKET EDGE KRAKEN (MARKET-EDGE-KRAKEN-1) — two dark market-truth senses

> **Status: `MARKET-EDGE-KRAKEN-1: IMPLEMENTED_DARK_NOT_EVALUATED`.**
> Trading authority: NONE. Judge authority: NONE. Socrates consumption: NONE in this ticket.
> Paper/live changes: NONE. Threshold changes: NONE. Edge claim: NOT MADE.
>
> **A sense is not a strategy. A descriptor is not a signal. A measured correlation is not an edge.**

Documentation checked on **2026-09-10** (docs.kraken.com: Charts / Market Analytics, WebSocket v2 `level3`,
the Level 3 checksum guide, `GetApiKeyInfo`, `GetWebSocketsToken`, the 2025-12 changelog moving Level 3 to
`wss://ws-l3.kraken.com/v2`).

## 1. What was added, and where it lives

Two dark research families inside the EXISTING market-lab, on the EXISTING providers (no duplicate provider):

| Family | Kind(s) | Provider / endpoint | Module |
|---|---|---|---|
| `DERIVATIVES_PRESSURE` | `DERIVATIVE_ANALYTIC_BUCKET` | `KRAKEN_DERIVATIVES` / `charts-analytics` (`GET https://futures.kraken.com/api/charts/v1/analytics/{symbol}/{analytics_type}`) | `market-lab/providers/kraken-charts.js` |
| `L3_MICROSTRUCTURE` | `L3_BOOK_SNAPSHOT`, `L3_ORDER_EVENT`, `L3_BOOK_COVERAGE` | `KRAKEN_SPOT` / `ws-l3` (`wss://ws-l3.kraken.com/v2`, channel `level3`) behind `rest-private-key-info` + `rest-private-ws-token` | `market-lab/l3-book.js` (pure state), `market-lab/providers/kraken-l3-auth.js` (narrow auth), `market-lab/providers/kraken-l3.js` (stream) |

Supporting modules: `market-lab/edge-recipes.js` (dark features, pure), `market-lab/edge-evaluation.js` (the
prospective evaluation harness, pure), `market-lab/edge-capture.js` (the bounded capture runner + the offline
evaluation entry), the `EDGE_CAPTURE` bundle layout in `market-lab/store.js`, the `charts` / `l3` policy blocks in
`market-lab/policy.js`, and the CLI commands `edge-capture` / `edge-evaluate` in `bin/market-research.js`.

The public Level 2 path (`providers/kraken-spot.js createStream`, endpoint `ws-v2`) is unchanged and is never called
"L3". The existing derivatives endpoints (instruments, tickers, funding history) are unchanged.

## 2. The dark-family law (the exclusion fence)

`DERIVATIVES_PRESSURE` and `L3_MICROSTRUCTURE` are declared in `market-lab/contracts.js` as `DARK_FAMILIES`, NOT as
members of `FAMILIES`. Every generic consumer of the decision vocabulary iterates `FAMILIES` / `FAMILY_REGISTRY` — the
Socrates broker metric registry, the evidence `METRIC_MAP`, readiness, the coverage matrix, the context builder, the
Socrates v2 contract — and therefore never sees them. On top of the structural separation there are explicit fences:

- `evidence/research-builder.js` throws at import if a dark family or a dark kind ever enters `METRIC_MAP`;
  `metricMapping()` answers `null` for a dark family; a dark detail request is refused.
- `socrates/broker.js` refuses a dark-family request before any dispatch (`dark family: Socrates consumes no dark
  research sense`).
- A coverage record may name a dark family, but a dark kind belongs to a dark family and to nothing else
  (`coverageRecordError`).
- The dark capture is its own bundle layout (`EDGE_CAPTURE`: `analytics.jsonl`, `l3-snapshots.jsonl`,
  `l3-events.jsonl`, `coverage.jsonl`, `policy.json`, `code-identity.json`). The context builder, the Judge intake and
  the Socrates runtime open `CAPTURE` / `CASE` bundles only.
- `test/market-kraken-edge-fences.test.js` proves the absence downstream positively (broker, builder, context,
  readiness, coverage matrix, Socrates contract) and statically (no order verb in any new module, no import of
  `execution/`, `judge/`, `watch/`, `tape/`; `judge/`, `execution/`, `watch/` and the adapters never mention a dark
  family, kind or module).

What the dark families MAY do: be captured, stored, validated, retained, replayed as-of, and evaluated offline.
What they MUST NOT do in this ticket: enter Judge intake / features, Socrates broker requests, decision evidence,
readiness, thresholds, execution, the Watch, or the paper / live adapters.

## 3. Sense A — Kraken Futures Charts / Market Analytics

**Request.** `since` (epoch seconds, required), `interval` (seconds, one of 60, 300, 900, 1800, 3600, 14400, 43200,
86400, 604800, required), `to` (epoch seconds, optional, default now). **Response.** `result.timestamp[]` (epoch
seconds), `result.data` (shape per type), `result.more` ("true if there are more candles in time range").

**Closed per-type schemas** (`ANALYTICS_VALUE_KEYS`): scalar series (`open-interest`, `aggressor-differential`,
`trade-volume`, `trade-count`, `liquidation-volume`, `rolling-volatility`, `long-short-ratio`) → `{ value }`;
`cvd` → `{ buyVolume, sellVolume, cvd }`; `future-basis` → `{ basis }`; `funding` → `{ rate, relativeRate }` OHLC
arrays → `{ rateOpen, rateHigh, rateLow, rateClose, relativeRateOpen, ..., relativeRateClose }`. The nested types
(`long-short-info`, `top-traders`, `orderbook`, `spreads`, `liquidity`, `slippage`) are
`NOT_SUPPORTED_WITH_CURRENT_SCHEMA`: their documented shapes are nested tables whose semantics the page does not pin
down; the parser refuses them instead of guessing.

**Time truth.** The provider bucket timestamp is `periodStartTs`; `periodEndTs = bucketTs + interval`; the bucket is
`FINAL` only when `periodEndTs <= receivedTs`, otherwise `PROVISIONAL` with quality `PROVISIONAL` and reason
`UNCOMMITTED_BAR`. `knownAtTs = receivedTs` for every observation of every vintage. Vintage is declared by the caller:
`LIVE_FORWARD_CAPTURE` (a poll reaching back at most three buckets) or `HISTORICAL_FETCH` (a backfill). A historical
fetch is known when it was fetched — never at the bucket's own time; a re-fetch is a NEW observation (new
`sourceRevision`, new identity) and never overwrites the earlier one. The envelope validator enforces all of it
(`observationError`: period = [bucketTs, bucketTs + interval], FINAL never ends after receipt, PROVISIONAL never closed
before receipt, provenance vintage = payload vintage).

**Pagination.** `result.more` drives the next page with `since = last bucket + interval`; a page that does not advance
the cursor stops the acquisition (`PAGINATION_INCOMPLETE`, nothing re-requested); the policy page cap yields
`PAGINATION_INCOMPLETE` with the data kept; buckets before the cursor are never admitted as forward data; timestamps
that do not strictly increase fail closed; misaligned buckets are dropped and counted.

**Units.** The Charts page documents no unit for any type. Every value is carried as `normalizedUnit: NATIVE`,
`normalization: NONE`, `nativeUnit` = a per-type label, quality reason `UNIT_UNVERIFIED`. Nothing infers percent vs
fraction from magnitude; nothing converts contracts without a contract specification; nothing adds values of two
types. `oi_bucket_change` etc. are differences within ONE native series.

**Manipulation-risk metadata** (documentation only, never a weight): LOWER — `future-basis`, `funding`; MEDIUM —
`open-interest`, `cvd`, `aggressor-differential`, `liquidation-volume`, `trade-volume`, `trade-count`,
`rolling-volatility`; HIGHER — `long-short-ratio` (and the unsupported positioning tables).

**Policy** (`providers.KRAKEN_DERIVATIVES.charts`, shipped `enabled: false`): `analyticsTypes`, `intervalsS`,
`maxLookbackMs`, `maxPagesPerRequest`, `pollingCadenceMs` (floor 60 s), `maxCallsPerDay`. Ceilings are fixed in
`CHARTS_CEILINGS`. Every request is admitted through the same accounting guard as the public capture.

## 4. Sense B — Kraken Spot Level 3

**Documented facts.** Channel `level3`, authenticated, `wss://ws-l3.kraken.com/v2`; `depth` 10 | 100 | 1000
(default 10); at most 200 symbols per connection; the subscription rate counter grows by 5 / 25 / 100 per symbol by
depth; snapshot orders `{ order_id, limit_price, order_qty, timestamp }`; updates carry `event: add | modify |
delete` and a `checksum`; the book must be truncated to the subscribed depth after every update; the venue sends
NO delete for orders that fall out of scope; when orders leave the depth, the next level's orders arrive as `add`.
The feed excludes in-flight orders, unmatched market orders, untriggered stops and hidden iceberg quantity.

**The checksum** (verified against the documented worked example, fixture
`test/fixtures/kraken-l3-checksum-snapshot.json`, expected 1063832831): CRC32 over the top 10 price levels per side
iterating INDIVIDUAL orders in queue order, asks low→high then bids high→low, each order contributing `limit_price`
then `order_qty` with the decimal point removed and leading zeros stripped; `order_id` and `timestamp` excluded. It is
NOT the Level 2 algorithm (which aggregates a level); it verifies queue priority.

**State model** (`market-lab/l3-book.js`, pure):

- persisted order identity = `sha256(symbol | order_id)` (24 hex) — stable, never the venue id itself;
- per order: side, price, remaining quantity, provider timestamp, `firstSeenTs` (our receipt, the only age basis),
  `modifiedTs`, visibility;
- a snapshot REPLACES the state for its symbol; `add` appends to its level queue; `modify` keeps identity and reports
  the previous quantity (a price move joins the back of the new level); `delete` removes;
- after every update the book is truncated to `depth` price levels per side; every evicted order is a
  `SCOPE_EVICTED` event — it left OUR window; it was NOT cancelled;
- `DELETE` means "left the visible book": fill, cancel and expiry are indistinguishable. Nothing here says "proven
  cancel";
- an unknown order in `modify` / `delete`, a duplicate `add`, a checksum mismatch, a crossed book or the per-book
  order cap (`OVERFLOW`) desynchronizes the book; the stream records a `GAP` / `DESYNCHRONIZED` / `DEGRADED` /
  `OVERFLOW` coverage fact and resubscribes for a fresh snapshot (an overflowed symbol is dropped, explicitly);
- a disconnect opens a new epoch: every book resets, `EPOCH_GAP` coverage is recorded, no age bridges the gap, a new
  token is fetched for the new epoch.

**The narrow auth helper** (`kraken-l3-auth.js`): it can sign EXACTLY two documented read endpoints
(`/0/private/GetApiKeyInfo`, `/0/private/GetWebSocketsToken`) with the form body `nonce=<n>`; there is no generic
"sign any private request" function, no order path is reachable, and `execution/kraken-adapter.js` is never imported.
Sequence: prove the DEDICATED data key (documented permission vocabulary: `query-funds`, `add-funds`,
`withdraw-funds`, `earn-funds`, `query-open-trades`, `query-closed-trades`, `modify-trades`, `close-trades`,
`query-ledger`, `export-data`, `create-ws-token`, `add-withdraw-address`, `update-withdraw-address`); FAIL CLOSED on
any authority-capable permission (`modify-trades`, `close-trades`, `add-funds`, `withdraw-funds`, `earn-funds`,
`add-withdraw-address`, `update-withdraw-address`) and on any undocumented value; only a `SAFE_DATA_KEY` fetches a
token; only then does a socket open; the subscription is `level3` only. The key, secret, token, signed payload and
nonce are never logged, never persisted, never in `status()`; the transport marks the two endpoints `sensitive` so the
recorder receives a redacted body and redacted `API-Key` / `API-Sign` headers. The only retained key fact is a
fingerprint (sha256 prefix).

**Resource bounds** (`providers.KRAKEN_SPOT.l3`, shipped `enabled: false`; dedicated env NAMES
`KRAKEN_L3_DATA_API_KEY` / `KRAKEN_L3_DATA_API_SECRET`, which must differ from every other credential name in the
policy): `depth` (default 10), `maxSymbols`, `maxSubscriptionsPerSecond`, `maxQueueMessages` (messages per wall
second; beyond it the stream DROPS with `QUEUE_DROPPED` coverage and resyncs), `maxInMemoryOrders` (split per book;
beyond it `OVERFLOW`), `maxRunBytes`, `maxSegmentBytes`, `maxReconnectAttempts`, `reconnectBackoffMaxMs`.

## 5. Dark features (`market-lab/edge-recipes.js`)

Pure and deterministic; every output carries `support` (COMPLETE / PARTIAL / MISSING with reasons and counts),
its window clocks and `inputKnownAtMax`; the as-of wall is `knownAtTs <= asOfTs`; PROVISIONAL buckets are excluded
unless asked for; a missing bucket is a gap (never a zero); one native field of one series per recipe.

§7.1 `DERIVATIVES_PRESSURE`: `oi_bucket_level`, `oi_bucket_change`, `oi_bucket_acceleration`, `aggressor_bucket_level`, `aggressor_bucket_change`,
`aggressor_bucket_slope`, `cvd_bucket_change`, `cvd_bucket_slope`, `liquidation_bucket_burst` (current / trailing median), `basis_bucket_level`,
`basis_bucket_change`, `funding_bucket_level`, `funding_bucket_change`, and `pressure_combinations` — NAMED boolean descriptors
(`oi_rising_aggressor_positive`, `oi_rising_aggressor_negative`, `oi_falling_cvd_negative`,
`liquidation_burst_with_oi_drop`, `basis_widening_with_oi_rise`); an unavailable component yields `null`, never
`false`. None of them is a buy or sell signal.

§7.2 `L3_MICROSTRUCTURE`: `visible_order_age_imbalance`, `queue_turnover_imbalance`, `depth_persistence`,
`new_order_impulse`, `visible_liquidity_disappearance` (DELETE vs SCOPE_EVICTED vs GAP — three different things),
`replenishment_after_pressure`, `queue_concentration`, `order_age_quantiles`, `top_level_churn`,
`microstructure_pressure_change`. A coverage break or an epoch change inside the window lowers support to PARTIAL.

## 6. The prospective evaluation harness (`market-lab/edge-evaluation.js`)

Arms are FEATURE SETS: `EXISTING_MARKET_BASELINE`, `BASELINE_PLUS_DERIVATIVES_PRESSURE`,
`BASELINE_PLUS_L3_MICROSTRUCTURE`, `BASELINE_PLUS_BOTH`. Horizons: 1, 5, 15, 30, 60 minutes. A declaration
(`declareEdgeEvaluation`) fixes the window, the fractions, the embargo (>= the longest horizon), the cadence, the
subject and the seed and is `prospective` only when declared at or before its start. Splits are chronological blocks;
a decision point whose outcome window crosses its block boundary is PURGED (dependency-safe); the holdout stays SEALED
unless opened explicitly. The law mirrors `judge/experiment.js` without importing it (market-lab never imports
`judge/`). Features at `t` see only `knownAtTs <= t`; labels are forward log returns from closed 1-minute spot candles
known at the evaluation's own as-of; a label beyond the as-of is censored (`null`). Scores are Spearman rank
correlations per feature / horizon / split with a minimum n; arms aggregate their own features. The report carries
`edgeClaim: NOT_MADE`, `promotionCriteria: NONE`, `authority: NONE`; there is no threshold and no promotion path.

## 7. What this ticket does NOT do

No Judge decision threshold changed; no gate lowered; no paper or live order admission touched; no paper or live
trading activated; no order placed, amended, cancelled or simulated; nothing funded; no subscription purchased; no
execution semantics modified; no direct or indirect trading authority for the new senses; no Socrates or Judge
consumption of the new senses; no silent reinterpretation of historical data as real-time knowledge; no new
provider outside Kraken; no new npm dependency (the CRC32 comes from `node:zlib`).

## 8. Live smoke

Automated tests are mock-only. A Level 3 network smoke may run ONLY with an explicitly dedicated non-trading key
that `proveDataKey()` reports as `SAFE_DATA_KEY`; otherwise the closeout reports `NOT_RUN_NO_SAFE_DATA_KEY`. The
Charts public smoke is optional. There is no order smoke of any kind.

```
# both dark senses, bounded, sealed EDGE_CAPTURE bundle (policy: charts.enabled / l3.enabled true, provider enabled)
KRAKEN_L3_DATA_API_KEY=... KRAKEN_L3_DATA_API_SECRET=... \
node bin/market-research.js edge-capture --policy <policy.json> --subjects <subjects.json> --duration-seconds 120 --out <DIR>/edge --research-root <ROOT>
# offline evaluation against a sealed public capture (baseline + labels); measures, never promotes
node bin/market-research.js edge-evaluate --edge-capture <DIR>/edge --capture <DIR>/cap --subject BTC --spot-symbol BTC/USD --futures-symbol PF_XBTUSD \
  --evaluation-id e1 --declared-at <UTC> --start <UTC> --duration-seconds 7200 --embargo-seconds 3600 --as-of <UTC> --seed s1
```

## 9. Tests

`test/market-kraken-charts.test.js`, `test/market-kraken-l3.test.js`, `test/market-kraken-edge-truth.test.js`,
`test/market-kraken-edge-fences.test.js`, `test/market-kraken-edge-evaluation.test.js`.
