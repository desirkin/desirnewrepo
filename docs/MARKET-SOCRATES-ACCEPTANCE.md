# MARKET LAB + SOCRATES v2 — acceptance matrix

Every D / H / G / A / B / C / L identifier of the ticket mapped to the implemented path, the named test, the measured
result and the remaining limitation. Results are from the deterministic suite (`node --test --test-concurrency=1`,
loopback fixtures and scripted responses only: zero provider calls, zero model calls, zero spend) unless the row says
LIVE. Code completion and live coverage are stated separately at the end; a blocked live check is a blocker for a
live-ready claim, not a code defect, and is never relabelled.

Test files: `test/market-lab-transport.test.js` (6), `test/market-lab-providers.test.js` (17),
`test/market-lab-recipes.test.js` (13), `test/market-lab-contracts.test.js` (8), `test/market-lab-owner.test.js` (3),
`test/evidence-v2.test.js` (4), `test/socrates-v2.test.js` (10), `test/market-research-cli.test.js` (4),
`test/market-lab-fences.test.js` (6) — 71 tests, all passing at the sealed commit. Fence suites updated for the new
composition: `test/rumor2-authority.test.js`, `test/social-4f-scope.test.js`, `test/socrates-contract*.test.js`,
`test/ui-drawers.test.js`, `test/ui-peek.test.js`, `test/memory-mirror.test.js`.

## D — real data clients (production transport path, loopback fixtures shaped like the source)

| ID | Path | Test | Result | Limitation |
|---|---|---|---|---|
| D01 | `market-lab/providers/kraken-spot.js` (AssetPairs, OHLC, Trades, Ticker, ws v2 instrument/book/trade) | providers D01, D01b; transport A04; owner A09 | PASS: exact URL/method/query, XBT alias, ws `BTC/USD` vs REST `XBT/USD`, last bar PROVISIONAL, tradeless bar MISSING, taker side kept, ticker labelled PARTIAL; stream ack→precision→snapshot→update, snapshot trades never re-recorded | LIVE: see L01 |
| D02 | `market-lab/providers/coinbase.js` (products, trades, level-2 book, candles, ws feed) | providers D02; owner A09 | PASS: USD/USDC alias group, explicit product id, maker side inverted to taker, l2 book labelled | LIVE: see L01 |
| D03 | `market-lab/providers/kraken-derivatives.js` (instruments, tickers, funding history) | providers D03 | PASS: contract size / linearity / alias, absolute hourly funding unit kept, OI unit | LIVE: see L01 |
| D04 | `market-lab/providers/deribit.js` (instrument census, ticker, book summary by currency) | providers D04; recipes G07 | PASS: census before aggregates, mark IV percent→fraction labelled PARTIAL | LIVE: see L01 |
| D05 | `market-lab/providers/bybit.js` (instruments cursor pagination, tickers, allLiquidation stream) | providers D05; providers A05/A06 | PASS: two pages without duplicate identity, retCode envelope, fractional funding per interval | LIVE: `api.bybit.com` answers 403 (CloudFront geo block) from this environment → BLOCKED / GEO_RESTRICTED coverage, never an invented liquidation |
| D06 | `market-lab/providers/coingecko.js` (coins list / markets / detail; GeckoTerminal pools) | providers D06 | PASS: id-based resolution refuses symbol mismatch, supply methodology retained, pool observation | LIVE: public CoinGecko / GeckoTerminal reached in L01 |
| D07 | `market-lab/providers/defillama.js` (tvl, protocol chain TVL, fees, chains, stablecoins) | providers D07 | PASS: daily period law, large-bound route explicit | LIVE: stablecoins reached in L01 |
| D08 | `market-lab/providers/coinglass.js` (vesting, liquidation history, OI / funding, ETF flows, economic calendar) | providers D08 | PASS: `CG-API-KEY`, code "0" envelope, UNTRACKED allocations kept, liquidations by side | LIVE: BLOCKED — no entitled key here (L02) |
| D09 | `market-lab/providers/cryptoquant.js` (exchange flows / reserve, catalog) | providers D09 | PASS: Bearer JWT, entity + window, 403 → ENTITLEMENT_DENIED | LIVE: BLOCKED (L02) |
| D10 | `market-lab/providers/santiment.js` (GraphQL getMetric) | providers D10 | PASS: variables never string-spliced, `Apikey` header, plan restriction → ACCESS_BLOCKED | LIVE: BLOCKED (L02) |
| D11 | `market-lab/providers/coinmetrics.js` (community catalog + timeseries) | providers D11 | PASS: catalog gates support, 600 ms spacing, paged series | LIVE: community API reached in L01 |
| D12 | `market-lab/providers/fred.js` (series, observations, vintage dates, release dates) | providers D12; recipes G12/G14 | PASS: metadata before observations, date-only precision, vintage, "." missing | LIVE: BLOCKED — `FRED_API_KEY` absent (free key, still a key) |
| D13 | `market-lab/providers/twelvedata.js` (symbol search, quote, time series) | providers D13 | PASS: explicit exchange, closed session STALE, provisional bar law | LIVE: BLOCKED (L02) |
| D14 | `market-lab/providers/settled.js` — injected read-only settled accessors → INFRASTRUCTURE / OFFICIAL_SOCIAL_EVENTS observations; `evidence/social-projection.js` — settled Social dossier → projection → packet | providers D14; evidence-v2 B04; owner A12/B06 | PASS: no new Social connection is opened; an absent accessor is NOT_CONNECTED, never a zero | Social provider activation stays out of scope |
| D15 | `market-lab/providers/tokenomist.js` (token list, unlock events, allocations) | providers D15 | PASS: `x-api-key`, credit metadata kept, slug mismatch refused, allocations PARTIAL when fields are missing | LIVE: BLOCKED (L02) |

Shared: `market-lab/transport.js` (planRequest, HTTP client, ws client) — transport A01, A01/A03, A01/A09, A06, A04, A12.

## H — hypotheses

| ID | Path | Test | Result |
|---|---|---|---|
| H01 pressure / response change | `market-lab/recipes.js` (`pressureResponse`), `market-lab/context.js` | recipes H01 | PASS: rising signed pressure with falling efficiency is a measured change carrying its alternative explanations, never a direction |
| H02 local vs common move | `market-lab/recipes.js` (`peerResidual`, `basis`, OI change) | recipes G03, G06/H02 | PASS: target never joins its peers; comparison refused across spec / unit |
| H03 price progress vs displayed exit capacity | `market-lab/recipes.js` (`bookMetrics`, `roundTrip`, liquidation totals) | recipes G04/G05, H03 | PASS: partial liquidity stays PARTIAL, no full-round-trip claim from a thin ask |

## G — independent numeric and temporal oracles (`test/market-lab-recipes.test.js`, expected values hand-derived)

| ID | Test | Result |
|---|---|---|
| G01 | recipes G01 | PASS: qty 3, notional 302, VWAP 302/3, signed 98, imbalance 98/302, unknown side changes support only |
| G02 | recipes G02 | PASS: mid 100, spread 200 bps, microprice 100.5 |
| G03 | recipes G03 | PASS: median 100, residual 200, MAD 100, 3/5 positive |
| G04 | recipes G04/G05 | PASS: q 1, proceeds 99, loss 198.0198 bps; ask qty 0.5 → PARTIAL |
| G05 | recipes G04/G05 | PASS: 100 → 50 bps/million, change −50, S=0 → null |
| G06 | recipes G06/H02 | PASS: basis 100 bps, OI +100 / +10 %, wrong unit rejected |
| G07 | recipes G07 | PASS: RR −0.10, butterfly +0.10, put/call OI 1.5 |
| G08 | recipes G08 | PASS: median 100, dispersion 200 bps, fiat name alone refused |
| G09 | recipes G09/G10 | PASS: 0.8, 2/3, 1.5, 0.25; unknown max → only its ratio null |
| G10 | recipes G09/G10 | PASS: net +50; changed provider / entity / unit / window / chain cannot recompute |
| G11 | recipes G11 | PASS: SMA 100, stdev 0, bands 100, RSI FLAT/null, constant returns → correlation undefined |
| G12 | recipes G12/G14 | PASS: +0.3 percentage points; a forecast learned after release refuses |
| G13 | recipes G13; socrates-v2 C03/G13 | PASS: new packet at Q1 ≥ result receipt, P0 preserved byte-for-byte |
| G14 | recipes G12/G14 | PASS: floor −1 ms / floor / floor +1 ms for every input, provenance and receipt floor |

## A — market boundaries

| ID | Path | Test | Result | Limitation |
|---|---|---|---|---|
| A01 | transport + every provider | transport A01×3, providers D01–D15 | PASS | live proof per L01/L02 |
| A02 | provider catalogs, pagination; owner content dedup (`market-lab/owner.js` `record`) | providers D01, D02, D05, D06, D11, D15; owner A09 (forced re-poll) | PASS: >1 page, duplicate identity refused, dotted / delisted / mapped symbols, inverse vs linear; re-polled identical source records are counted as duplicates and never re-recorded | — |
| A03 | transport failure law | transport A01/A03 | PASS: 401/403/429/5xx, content type, malformed / duplicate-key JSON, body too large, slow stream, redirect refused, missing key, key-bearing URL redacted, extra upstream fields dropped / extra DTO fields fail | — |
| A04 | Kraken ws v2 / Coinbase feed state machines (`tape/book.js` reuse) | transport A04; owner A09 | PASS: snapshot / delta / ack / checksum / reset / reconnect; no crossed book, no false currentness | — |
| A05 | `market-lab/contracts.js` observation law | contracts A05/A06 ×2; providers A05/A06 | PASS per kind: positive, zero, lawful null, wrong enum / unit, unsafe number, nested extra key, future input | — |
| A06 | clocks (`market-lab/time.js`, quality law) | transport A06; contracts A05/A06; recipes G13, G14 | PASS: late arrival never repairs a sealed view; replay is network-free (`test/socrates-v2` C05) | — |
| A07 | recipes | recipes G01–G14 | PASS, tolerances declared per recipe | — |
| A08 | `market-lab/hot-state.js` | contracts A08 | PASS: per-symbol cap, hot-set eviction, byte pressure, deterministic under the same prefix | — |
| A09 | capture → build → evidence → reopen | owner A09/B02; cli pipeline | PASS: identical `contextId` and canonical bytes across directories; later as-of differs | — |
| A10 | `market-lab/store.js` JSONL law | contracts A10 | PASS: multibyte chunk split, exact / over limits, early iterator exit, write / fsync / close failures, no manifest on failure | — |
| A11 | semantic corruption | contracts A11/A09; socrates-v2 C05/A11; cli (tampered report) | PASS: resealed hashes still reject on the semantic validator | — |
| A12 | import / lifecycle isolation | contracts A12; fences A12; transport A12; owner A12/B06 | PASS: no I/O on import (child process tripwires), stopped owner ignores, full queue drops with DROPPED coverage, observer exception contained | — |

## B — evidence and authority

| ID | Path | Test | Result |
|---|---|---|---|
| B01 | `evidence/contract.js`, `socrates/contract.js` untouched; `evidence/contract-v2.js` dispatch | evidence-v2 B01 | PASS: v1 files byte-identical to baseline; v2 refuses unknown versions / keys |
| B02 | `evidence/research-builder.js` | evidence-v2 B02/B03; owner A09/B02 | PASS: provider sources, MARKET sense only, no invented Social claim; Social round-trip keeps ids |
| B03 | context reference graph | evidence-v2 B02/B03; contracts A11 | PASS: no cycles, dangling ids, wrong subject / as-of |
| B04 | `evidence/social-projection.js` | evidence-v2 B04 | PASS: NOT_CONNECTED / NO_DOSSIER / AVAILABLE; no fabricated counts |
| B05 | packet bounds | evidence-v2 B05 | PASS: full coverage fits; over-cap is declared, contrary evidence never dropped silently |
| B06 | `market-lab/deep-market-adapter.js` → `createResearchStrainer` | owner A12/B06 | PASS: the REAL strainer consumer builds a dossier whose marketDeep features come from the owner's window; incomplete / empty / non-USD → honest null |
| B07 | `market-lab/identity.js` | contracts B07 | PASS: closure over every effective module; clean / dirty / missing / no git / failed status |
| B08 | fences both directions | fences B08 ×2, §12 seams; rumor2-authority; social-4f-scope; socrates-contract ×3 | PASS: exact allowlists, no broad removal |

## C — Socrates (`test/socrates-v2.test.js`, production client over a scripted HTTP stub)

| ID | Path | Result |
|---|---|---|
| C01 | `socrates/client.js`, `socrates/prompt.js` | PASS: envelope (host, version, key by NAME, pinned model, max_tokens, cached system + schema, json_schema output config); refusal / truncation / non-text / invalid JSON / unknown enum / bad refs / oversize / model mismatch are distinct failures with no second call |
| C02 | `socrates/runtime.js` validity gate, `socrates/contract-v2.js` host ids | PASS: invalid packet → zero calls; empty packet → INSUFFICIENT_EVIDENCE; fabricated fact refused; model-supplied ids refused; report JSON and rendering agree |
| C03 | `socrates/broker.js` closed graph | PASS: REFRESH through the real broker to the owner, P0 preserved, revised report over its own packet; every refusal class honest |
| C04 | attempt / follow-up ceilings | PASS: INITIAL_REPORT_ONLY, no repair call, no fallback model |
| C05 | seal / reopen / replay | PASS: clock mutations with valid hashes reject; replay never acquires |
| C06 | cancellation / queue / duplicate / shutdown | PASS: release before dispatch, no double publish, no hang |
| C07 | `socrates/budget.js` | PASS: zero caps → zero calls; reserve-before-send; failed reservation → zero calls; timeout / 5xx UNRESOLVED; 4xx settles at zero; restart keeps spent quota; rollover; cache-token arithmetic |
| C08 | prompt injection | PASS: only host `api.anthropic.com`; obeying model refused; key never in the report — technical boundary only, not semantic immunity |
| C09 | fresh-case isolation, exact-request cache | PASS: REUSED discloses original age; policy / packet / source byte changes invalidate |
| C10 | `socrates/evaluate.js` + `socrates/corpus.js` | PASS: citations resolve mechanically, 999 bps fails; twelve cases, DEVELOPMENT 8 / HELD_OUT 4 reported separately as IMPLEMENTATION_ASSESSMENT |

Corpus (scripted, `evaluate --cases builtin`): 12/12 validated; rubric dimensions 11; DEVELOPMENT 88/88, HELD_OUT 44/44
rubric checks pass on the scripted responses. This is an implementation assessment of the pipeline and rubric, not a
measure of a live model's reasoning quality (that needs L03 with a budget).

## L — live checks (opt-in commands; NOT part of `node --test`)

All live checks ran through the shipped CLIs with a scratch policy that enables ONLY free / public providers (Kraken spot,
Coinbase, Kraken derivatives, Deribit, Bybit, CoinGecko public API, GeckoTerminal, DefiLlama, Coin Metrics community),
per-provider caps `maxCallsPerDay 120 / maxCallsPerMonth 500` (CoinGecko 60 / 300), every paid provider disabled, the
model disabled, every dollar cap 0. Subjects: BTC, ETH, SOL and **SUI** (a non-legacy catalog asset outside the
execution universe, resolved by the native catalogs: Kraken `SUI/USD`, Coinbase `SUI-USD`, Kraken derivatives
`PF_SUIUSD`, CoinGecko `sui`, Coin Metrics `sui`). Secret values: none present, none printed.

| ID | Command (paths are the owner's placeholders) | Measured result | Status |
|---|---|---|---|
| L01 | `node bin/market-research.js capture --policy policy-public.json --subjects subjects-btc-eth-sol-sui.json --duration-seconds 90 --out cap` | exit 0, sealed CAPTURE `mb-58a37bf5…`, 90 s, 11,905 observations / 68 coverage records / 23.8 MB; providers: Kraken spot 29 req (5,309 obs: ws trades 97, ws book samples 692, OHLC 4,512, catalog 4, ticker 4), Coinbase 9 req (2,608: ws trades 450, ws book 750, candles 1,400, book 4, products 4), Kraken derivatives 9 req (491), Deribit 10 req (5,114: instruments 1,720, option ticks 1,696, ticker 2), CoinGecko 5 req (4), GeckoTerminal 1 req (1), DefiLlama 3 req (69), Coin Metrics 6 req (300); **Bybit 1 req → 403 CloudFront geo block → runtime BLOCKED, coverage ACCESS_BLOCKED / GEO_RESTRICTED, zero observations**; Coin Metrics community: 18 of 20 requested metrics NOT_IN_CATALOG (honest NOT_SUPPORTED coverage), 2 OBSERVED; LIQUIDATIONS family NOT_QUERIED (no liquidation feed reachable: no event was invented); zero rejected records; the two stream close handshakes timed out and were terminated after the bounded grace | RUN — partial (Bybit geo-blocked) |
| L01 → build | `build --capture cap --as-of 2026-09-08T09:02:56Z --subject SUI --out ctx-sui` (and `--subject BTC`) | exit 0, SUI context `mctx-9ddc1dae…`: 11,905 admissible / 0 late; families SPOT_PRICE_CHART / SPOT_FLOW / DISPLAYED_LIQUIDITY / CROSS_VENUE / DERIVATIVES_FUNDING_OI / SUPPLY_UNLOCKS OBSERVED, NETWORK_ACTIVITY MISSING (metrics not in the community catalog), OPTIONS_TERM_SKEW NOT_QUERIED (Deribit lists no SUI), LIQUIDATIONS / DEX_DEFI / ONCHAIN_ENTITY_FLOW / STABLECOIN_LIQUIDITY / ETF_FLOWS / MACRO_RELEASES / CROSS_ASSET NOT_QUERIED; BTC context additionally OPTIONS_TERM_SKEW and NETWORK_ACTIVITY OBSERVED | RUN |
| L01 → packet | `node bin/socrates-research.js packet --context ctx-sui --out pk-sui` | exit 0, `sep2-42b08b82…`, 18 evidence items, 4 provider sources, social false, mode LIVE_OBSERVATION, entrances MARKET_LED | RUN |
| L01 → run | `run --packet pk-sui --policy policy-public.json --out case-sui --context ctx-sui --capture cap` | exit 0, case `case-512e63a3…` sealed as **BUDGET_BLOCKED / MODEL_DISABLED**, attempts 1 on path NONE, usage 0 / 0 / 0 USD, zero model calls (the model is disabled by policy; this is the honest terminal state, not a report) | RUN (no model by design) |
| L01 → verify | `verify --case case-sui` | exit 0, ok true, reasons [], packets 1, analyses 0, attempts 1 | RUN |
| L02 | for each primary paid family, one bounded request with the owner's entitled key and a supplied plan record establishing prepaid / included calls, remaining quota and zero incremental charge: `COINGLASS_API_KEY=… node bin/market-research.js coverage --policy policy-with-coinglass-plan.json --subjects subjects.json --out probe-coinglass --probe true` (likewise `CRYPTOQUANT_API_KEY`, `SANTIMENT_API_KEY`, `TWELVEDATA_API_KEY`, `TOKENOMIST_API_KEY`, `FRED_API_KEY`); then `capture` with those providers enabled | not run: no entitled key and no plan record exist in this environment; the readiness probe reports every paid route `NOT_PROBED / PROVIDER_DISABLED`. The alternative clients (D10 Santiment for D09, D13 Twelve Data) are contract-tested; their live status is NOT_RUN | **BLOCKED** (required: plan record + key by NAME + owner-supplied dollar ceiling for any metered smoke) |
| L03 | `ANTHROPIC_API_KEY=… node bin/socrates-research.js run --packet pk-btc --policy policy-model.json --out case-live --context ctx-btc --capture cap --budget-dir budget` with `model.enabled true`, positive `maxEstimatedUsdPerCase / PerDay / PerMonth` and an explicit owner ceiling; then `verify --case case-live`; a follow-up acquisition needs the live owner (`serve`) | not run: `ANTHROPIC_API_KEY` is absent and no dollar ceiling was supplied. The real client, broker and revised-report path are proven with the production client over a scripted HTTP stub (C01–C10); a scripted response is never relabelled as live | **BLOCKED** (required: key by NAME + explicit budget) |
| L04 | `node bin/market-research.js coverage --policy policy-public.json --subjects subjects.json --out readiness --probe true` | exit 0, `coverage-matrix.json` (probe true): PROBED_OK for Kraken spot (OHLC / ticker / ws-v2, 640 pairs in the catalog), Coinbase (book / candles / feed), Kraken derivatives (295 instruments), Deribit (906 BTC instruments), CoinGecko (19,669 markets), GeckoTerminal, DefiLlama, Coin Metrics; PROBED_FAILED for Bybit (403 GEO_RESTRICTED → ACCESS_BLOCKED); NOT_PROBED / PROVIDER_DISABLED for CoinGlass, CryptoQuant, Santiment, FRED, Twelve Data, Tokenomist; SETTLED_RECORDS NO_NETWORK_SOURCE (standalone CLI has no settled accessors). Families: 12 COVERED_BY_DECLARED_POLICY, 6 UNCOVERED (ONCHAIN_ENTITY_FLOW, ETF_FLOWS, MACRO_RELEASES, CROSS_ASSET, OFFICIAL_SOCIAL_EVENTS, INFRASTRUCTURE_STATUS); cheapest supplied combination: none of the paid families has a supplied plan record | overall readiness **BLOCKED** (narrower working coverage shown; never presented as complete) |

What the live run does NOT establish: a witnessed liquidation (no feed reached), any paid family, any model output,
readiness GREEN. What it does establish: the production transport, catalogs, streams, REST parsers, the segment law,
the capture → context → packet → case → verify chain and the honest BLOCKED states all work against the real public
sources from this environment.

## Code completion vs live coverage

- **Code completion**: every D01–D15, H01–H03, G01–G14, A01–A12, B01–B08, C01–C10 row above is implemented and covered
  by a named passing test at the sealed commit. The deterministic suite spends nothing and reaches no provider.
- **Live coverage**: stated per row in the L section. Paid families (D08, D09, D10, D13, D15) and the live model (L03)
  are BLOCKED here for lack of owner-supplied entitled keys, plan records and a dollar ceiling; FRED is BLOCKED for a
  missing (free) key; Bybit is BLOCKED by a geo restriction of this environment. Overall live readiness is therefore
  BLOCKED, and no LIVE_COMPLETE or READINESS_GREEN claim is made. Nothing in this document is an independent acceptance
  seal.


## MARKET / SOCRATES closeout (R01–R07) — traceability

The coordinated repair of the seven review findings. Every row names the production boundary that now carries the law,
the deterministic test that proves it (`MC-` ids are local to this closeout; suites `test/market-closeout-witnesses.test.js`,
`test/market-closeout-r01-r03.test.js`, `test/market-closeout-r04-r06.test.js`, `test/market-closeout-r07-e2e.test.js`,
fixtures in `test/helpers/market-closeout.js`) and the measured result. Every fixture is offline: fake HTTP / WebSocket
over loopback, a scripted Messages transport, fake clocks, temp directories — zero provider calls, zero model calls, zero
spend. The fourteen witness tests were run against the baseline commit before the repair (14 of 14 RED) and are GREEN on
the candidate; the acceptance tests were written against the repaired boundaries.

### R01 — one accounting authority before every dispatch

Production boundary: `market-lab/quota.js` (durable journal `<research-root>/accounting/quota.jsonl` + `quota.lock`,
`createDispatchGuard`: precheck before queueing, atomic reservation at the dispatch boundary, native charge units,
purposes ACQUIRE / CATALOG / BROKER / PROBE / SMOKE), `market-lab/transport.js` (the guard is bound once; refused or
unreserved requests never touch the wire; shared in-flight requests reserve once; ambiguous failures stay UNRESOLVED),
`market-lab/owner.js` (usage = dispatched / credits / refused / unresolved / reasons per acquisition, precheck refusals
included), `socrates/budget.js` + `socrates/runtime.js` (the model reservation covers the worst enabled billed input
class; an exact provider token count is required; malformed usage is UNRESOLVED).

| ID | Boundary | Test | Result |
|---|---|---|---|
| Q01 | guard: DAY_CAP_ZERO / MONTH_CAP_ZERO / SMOKE caps refuse before queueing | MC-Q01/MC-Q02 | PASS: zero wire requests |
| Q02 | guard: ENTITLEMENT_EXHAUSTED at the atomic reservation; concurrent race admits one | MC-Q01/MC-Q02, MC-Q04 (shared) | PASS: at most one dispatch |
| Q03 | native charge units (credit per symbol, credit on success), page / retry reservations, per-provider slot | MC-Q03 | PASS |
| Q04 | probe / catalog / acquire / broker / shared through one guard; truthful usage under refusal | MC-Q04 | PASS: BROKER / CATALOG / PROBE purposes in the journal |
| Q05 | restart, changed output directory, day / month rollover, repeated attestation, clock rollback | MC-Q05 | PASS: nothing re-granted |
| Q06 | reservation write failure, corrupt journal, second owner; proven non-dispatch vs ambiguous | MC-Q06 | PASS |
| Q07 | cache-price witness: 10 000 in + 256 out with cache creation reserves USD 0.02756; ceiling 0.024 refuses before dispatch | MC-Q07 | PASS |
| Q08 | token-count failure cannot authorise inference (no bytes/3 fallback); malformed usage UNRESOLVED; late count after close | MC-Q08, MC-L03 | PASS |

### R02 — positive window coverage and a real options census

Production boundary: `market-lab/recipes.js` (`intervalCoverage`, `tradeWindow` consumes a positive coverage fact;
`optionsSurface` takes census completeness as an input, dedupes summary + ticker, labels ratio scope, counts unticked
census members), providers `kraken-spot.js` / `coinbase.js` (SUBSCRIBED on the trade-channel ACK, GAP with
SUBSCRIPTION_ENDED on close), `deribit.js` (census coverage record), `market-lab/context.js`,
`market-lab/deep-market-adapter.js` (trade aggregates withheld unless the interval is COMPLETE).

| ID | Boundary | Test | Result |
|---|---|---|---|
| W01 | one book, no trade coverage ⇒ UNKNOWN_COVERAGE, never COMPLETE_NO_TRADES | MC-W01 | PASS |
| W02 | proven quiet interval is a valid zero; traded interval keeps the OHLCV / flow oracle | MC-W02 | PASS (notional 60.2, vwap 100.333, signed +19.8) |
| W03 | startup, gaps (overlapping / not), foreign subject, dropped, late, evicted affect exactly their scope | MC-W03 | PASS |
| W04 | support survives capture / reopen / restart / as-of replay / packet / deep-market adapter | MC-W04 | PASS |
| W05 | one tick without census is incomplete; a complete census succeeds | MC-W05, MC-W06 | PASS |
| W06 | summary + ticker is one contract; put / call counts reconcile; unticked census member ⇒ ADMITTED_SUBSET / TICKS_MISSING | MC-W06 | PASS |

### R03 — acquisition → context → packet connections

Production boundary: `evidence/research-builder.js` (`METRIC_MAP`: every registered metric of the 17 families has one
bounded mapping or a declared `unsupported` reason; default summaries include exit liquidity and multi-venue; absent
inputs are MISSING items with `value: null`; omissions reconciled), `market-lab/owner.js` (bounded Deribit ticker
enrichment `optionsTickerEnrichmentPerSweep`; NETWORK_ACTIVITY routed to CryptoQuant network-data / market-indicator
or Santiment; `acquire` accepts `metricIds` and a window).

| ID | Boundary | Test | Result |
|---|---|---|---|
| J01 | 198.01980198 bps exit loss as numeric evidence (summary and DETAIL) inside the serialized request | MC-J01 | PASS |
| J02 | venue dispersion reaches the packet without a peer cohort | MC-J02 | PASS |
| J03 | mapping table for every registered metric; reconciled omission reasons / counts | MC-J03 | PASS |
| J04 | bounded ticker enrichment; Greeks reach the surface; RR −0.12 / BF 0.01 oracle | MC-J04 | PASS |
| J05 | missing / denied Greeks and an off-census tick stay PARTIAL | MC-J05 | PASS |
| J06 | Coin Metrics disabled + CryptoQuant entitled ⇒ mapped network requests, parsed value in context | MC-J06, MC-B06 (packet + model request + follow-up) | PASS |
| J07 | Santiment-only fixture; exhausted primary + fallback stays within R01; no duplicate paid request | MC-J07 | PASS |
| J08 | H01 / H02 / H03, market-led and Social-led entries populated, labelled, bounded | MC-J08 | PASS |

### R04 — broker satisfaction matches the actual question

Production boundary: `socrates/broker.js` (per-metric evaluation against `METRIC_MAP`, GLOBAL scope, freshness on
source / knowledge clocks, HISTORY thin rule, recipe-compatible constituents for derived metrics, evidence cache
rebinding with freshness recheck, semantic round de-duplication, usage from the guard, bounded id lists with a digest
over every admitted id).

| ID | Boundary | Test | Result |
|---|---|---|---|
| B01 | active_addresses with only exchange_reserve ⇒ not SATISFIED | MC-B01 | PASS |
| B02 | exact positive, multi-metric partial, missing constituent, null value, incompatible unit, stale | MC-B02 | PASS |
| B03 | age boundary exact; HISTORY thin / satisfied; source period in coverage; late knowledge at Q0 / Q1 | MC-B03 | PASS |
| B04 | cache hit is a fresh binding, zero usage, freshness rechecked; later as-of never contaminates an earlier replay | MC-B04 | PASS |
| B05 | same semantic question under a new key ⇒ no duplicate paid work; different request dispatches | MC-B05 | PASS |
| B06 | the actual owner receives metric / window; parsed data enters P1 and the second model request; wrong sibling never satisfies | MC-B06, MC-E02 | PASS |
| B07 | usage and bounded id lists reconcile to guarded wire requests and unique inputs | MC-B07 | PASS |

### R05 — bounded recording and resolvable case inputs

Production boundary: `market-lab/retention.js` (bounded retained store, ordinal + membership chain, EVICTED /
COVERAGE_OVERFLOW facts), `market-lab/owner.js` (segment rotation before the bound, per-segment seal with ordinal range,
run / root quota, explicit recording failure with the first error preserved, `snapshotPrefix`), `market-lab/prefix.js`
(`market-capture-prefix-1`, id bound to content, `resolvePrefix` replays sealed segments through the same retention law;
`sealedCapturePrefix` for the single-capture CLI path), `market-lab/service.js` (case inputs carry the derivation
params), `socrates/runtime.js` (`verifyCase --resolve-inputs`).

| ID | Boundary | Test | Result |
|---|---|---|---|
| S01 | tiny segments rotate before overflow; records once; read back through capture / build; prefix resolves COMPLETE | MC-S01 | PASS |
| S02 | over-cap row rejected and counted; run bound stops with the first error, no manifest, no later admission; seal / validation failure never publishes | MC-S02 | PASS |
| S03 | the 4000-byte / two-trade witness rotates lawfully or stops explicitly; retention bounded | MC-S03 | PASS |
| S04 | fake-clock long operation bounds retention, coverage, broker cache, case descriptors | MC-S04 | PASS |
| S05 | actual service case cites a resolvable prefix; offline reopen recomputes the context identity | MC-S05, MC-E06 | PASS |
| S06 | partial file, altered hash, missing segment, tampered prefix in a resealed case fail semantic verification | MC-S06 | PASS |
| S07 | concurrent intake / rotation / snapshots and repeated stop: deterministic membership, no unowned deletion, no leaked timers | MC-S07 | PASS |

### R06 — close is an ownership barrier

Production boundary: `socrates/runtime.js` (`close()` is an idempotent asynchronous barrier: admission stopped, owned
requests aborted through one controller, bounded drain `closeDrainMs`, open reservations preserved UNRESOLVED, lock
released once; every continuation is fenced), `socrates/budget.js` (`close({ openReason })`), `market-lab/service.js`
(stop awaits the runtime barrier before the owner seal; a recording failure closes the runtime), `socrates/evaluate.js`
and `socrates/commands.js` await the barrier.

| ID | Boundary | Test | Result |
|---|---|---|---|
| L01 | held Messages response, close aborts, lock held until the drain, no late COMPLETED | MC-L01 | PASS |
| L02 | late valid response / rejection after drain mutate nothing; no unhandled rejection | MC-L02 | PASS |
| L03 | close during count (no reservation), during Messages (UNRESOLVED), during broker acquisition (initial SETTLED, no second attempt); caller abort before dispatch (no reservation) | MC-L03 | PASS — see note 1 |
| L04 | abort-ignoring transport drains within the test deadline; unresolved spend retained; lock released once | MC-L04 | PASS |
| L05 | repeated / concurrent close, runCase after close, a completed case unchanged | MC-L05 | PASS |
| L06 | service.stop awaits both lifecycles; recording failure stops admission and closes the runtime; the error survives stop | MC-L06, MC-E05 | PASS |

### R07 — one source of schema truth

Production boundary: `market-lab/context-schema.js` (closed per-metric value and support schemas: required keys, no
undeclared keys, enums, finite numbers, nullability, nested recipe sub-schemas), `market-lab/context.js`
(`market-context-2`; every component validated by the shared schema inside `contextError`; legacy `market-context-1`
rejected explicitly), `market-lab/commands.js` (`contextBundleError` shared by the unsealed candidate and the reader;
`readContext` with the capture recomputes the derivation), `market-lab/store.js` (exact-byte bounds, no seal on any
failure), `market-lab/identity.js` (closure through the four roots covers the new modules).

| ID | Boundary | Test | Result |
|---|---|---|---|
| V01 | string spreadBps with recomputed identities rejects at contextError / candidate / reader | MC-V01, MC-V06 | PASS |
| V02 | missing key, invalid null, unknown key / enum, wrong nested type, bad reference / clock, duplicate, inconsistent support / count, raw-content sentinel | MC-V02 | PASS |
| V03 | lawful populated and partial contexts pass all four boundaries | MC-V03 | PASS |
| V04 | resealed mutations: omitted member, false counts, wrong prefix, packet-map mismatch, inconsistent status / report | MC-V04 | PASS |
| V05 | valid numeric mutation resealed rejects with the capture; without it the reader labels its proof honestly | MC-V05 | PASS |
| V06 | invalid candidate never publishes; exact-byte / multibyte / occupied path / closed descriptor / double close | MC-V06 | PASS — see note 2 |
| V07 | code identity covers the new modules; clean / dirty / unknown / no-git truthful | MC-V07 | PASS |

### Readiness and joined cases

Production boundary: `market-lab/readiness.js` (`market-live-readiness-2`: a family is LIVE only from obtained family
evidence; a null / non-PASSED model verification is BLOCKED), `market-lab/coverage.js` (17-family matrix).

| ID | Boundary | Test | Result |
|---|---|---|---|
| RD01 | unrelated-endpoint smoke never makes a family LIVE | MC-RD01/MC-RD02 | PASS |
| RD02 | null / blocked model verification prevents READINESS_GREEN | MC-RD01/MC-RD02 | PASS |
| RD03 | explicit partial family keeps overall non-green; a fully supported synthetic case is GREEN | MC-RD03 | PASS |
| RD04 | counts from the 17-family artifact; a disabled / unauthorised alternative never overrides the qualified source | MC-RD04 | PASS — public policy: 12 COVERED_BY_DECLARED_POLICY, 1 ENABLED_BUT_BLOCKED (SUPPLY_UNLOCKS: CoinGecko needs its demo key), 4 UNCOVERED (ONCHAIN_ENTITY_FLOW, ETF_FLOWS, MACRO_RELEASES, CROSS_ASSET: paid or keyed sources only) |
| E01 | production owner + fake HTTP/WS → guarded acquisition → sealed prefix → context → packet → actual client → validated report → sealed case → reopen; numbers / support / citations in the serialized request | MC-E01 | PASS |
| E02 | real follow-up through the guarded owner; new prefix and P1; second request carries the new evidence; P0 byte-identical; wrong-metric data never satisfies | MC-E02, MC-B06 | PASS |
| E03 | depleted provider and model allowances refuse before the wire; no synthetic evidence; no misleading completion | MC-E03 | PASS |
| E04 | book-only startup, capped census, absent Greeks, paid access refusal, quiet interval reach context / packet / case correctly | MC-E04 | PASS |
| E05 | recording failure with an active model request: admission stopped, ownership drained, error and prefix preserved, in-flight charge UNRESOLVED | MC-E05 | PASS |
| E06 | restart / reopen from files only; recorded replay makes zero network calls; the account journal never resets | MC-E06 | PASS |
| E07 | Social-led and market-led packets, the deep-market adapter's valid input and withheld aggregate, protected v1 contracts and config byte-identical | MC-E07 | PASS |

Notes.
1. The runtime's reserve → dispatch sequence has no `await` between the reservation and the wire, so a close or a caller
   abort can only land before the reservation (proven non-dispatch, nothing to release) or during the wire (ambiguous,
   UNRESOLVED). The release-before-dispatch path exists for a signal already aborted at that instant and is exercised
   at the provider transport (`CANCELLED_BEFORE_DISPATCH` in MC-Q06's refusal path); it is not observable as a separate
   runtime stage without an artificial await, and none was added.
2. An fsync failure is not injectable from a test without mocking `node:fs`; write / open / close / validation failures
   are injected through real conditions (an occupied member path, a closed descriptor, a double close, a refusing
   candidate validator). The fsync failure branch keeps the same no-seal law by construction.
3. The INTEGRATED seam (the application Tape) carries accepted trades but no subscription-continuity fact for the
   interval, so its trade windows are UNKNOWN_COVERAGE and the deep-market adapter withholds the trade aggregate
   (`trades: null`, `TRADE_COVERAGE_UNKNOWN`) while the accepted book still supports the window. The former A12/B06
   expectation of a supplied aggregate was the review's false-completeness finding and was changed to this law.
4. The broker's constituent compatibility groups by provider, entity set, chain, unit, window and period; a
   methodology-family mismatch between an inflow and an outflow is refused by the context recipe
   (`exchangeNetFlow` RECIPE_MISMATCH), not additionally by the broker.
5. The sample policy ships unchanged (every provider disabled, model disabled, zero caps); the optional plan key
   `meteredAuthorization` and the new resource bounds default in `validatePolicy`, so an owner's existing policy file
   loads without edits and no spending permission is created by default.

### Remaining closeout, revision 2 (P1–P5) — traceability

The five remaining owner findings, repaired together on baseline `0c61508` (parent `1f6f211`). The owner's acceptance
file `test/market-socrates-remaining-owner.test.js` is installed byte-for-byte (SHA-256
`b6438b26c4f3a83b7ed22afad87faeaba58e36f9f66c4a9db295f1e8dfa7cded`); against the unmodified baseline it ran RED as the
author documented (12 tests: 3 controls pass, 9 fail, natural exit 1) and it is GREEN on the candidate. The linked
variants live in `test/market-socrates-rev2-variants.test.js`. Every fixture is offline (scripted fetch, injected
timers, temp journals); no provider, model or database call, no paid smoke, no purchase.

| ID | Boundary | Law on the candidate | Test | Result |
|---|---|---|---|---|
| P1 | `market-lab/readiness.js` (`market-live-readiness-3`, `qualifyFamilyEvidence`, `qualifyModelDemonstration`) | a family is LIVE only from QUALIFIED evidence: the selected required provider (enabled, live-PASSED, usable access), a family-relevant REGISTRY endpoint, requested / obtained assets and REGISTERED metrics, the measured interval, the knowledge clock fresh under the family's own `ALLOWED_MAX_AGE_MS` (no invented universal threshold), a support / census basis; counts, historical smokes (reported separately) and unrelated endpoints never qualify; the model needs a supported demonstration (clock, model, request, real usage); absent or incomplete proof is a non-green family with named `missingProof`, never a throw | OA-P1, OA-C01, MC-RD01/RD02, MC-RD03 (qualified positive + legacy negative), P1-R01/R02/R03 | PASS |
| P2 | `socrates/budget.js`, `market-lab/quota.js` (validate → append + fsync + close → commit; first failure latched; `failed()`), `market-lab/transport.js` (`ACCOUNTING_FAILED`), `socrates/runtime.js` (`ACCOUNTING_FAILED` attempt), `market-lab/owner.js` (`ACCOUNTING_FAILED` result, `ACCOUNTING_UNAVAILABLE` refusal) | a rejected transition writes nothing; a failed or uncertain durable write commits nothing, latches the journal and refuses every later admission; a failed reservation append never dispatches; a failed settle after the wire is a named failure with no admitted data and a conservatively charged reservation; restart resolves RESERVED as UNRESOLVED; a failed open releases the startup lock | OA-P2, OA-C02, MC-Q05/Q06, P2-B01..B05, P2-Q01..Q03 | PASS |
| P3 | `market-lab/owner.js` (`closeDrainMs`, default `CLOSE_DRAIN_MS` = 10 000 ms, zero permitted; owned controller, generation fence, `fenced`, in-flight acquisition set, `drainInFlight` on injected timers), `market-lab/transport.js` (`active` set apart from the coalescing map; `inFlight`, `stop`, `fence`, `drained`), `market-lab/service.js` (forwards `closeDrainMs` to both lifecycle owners) | stop admission → track every in-flight acquisition and request (shared, share:false, coalesced consumers, queued) → abort and drain within the bounded deadline → fence: open reservations preserved UNRESOLVED while the journal is still owned, every late continuation detached → seal only the admitted prefix → release the journal last; the lock is held DURING the drain; a late success or rejection mutates nothing | OA-P3, MC-L04, MC-L06, MC-S07, P3-S01..S06 | PASS |
| P4 | `socrates/broker.js` (`evaluate` with identity dedupe, `metricSupport`, `periodGrid`, `coverageSpan`, `INDICATOR_WARMUP`) | support is demonstrated, never counted: a HISTORY interval needs the observations' own period grid complete (no missing period, interval ≥ one period, aligned, one period length; each native constituent separately) or, for point observations, OBSERVED coverage records spanning the interval; derived candle metrics need the ACTUAL `indicators()` warmup over a contiguous same-interval bar series; a cache hit re-runs the same law and cannot erase a gap; duplicates count once; useful PARTIAL points stay reported | OA-P4a/P4b, MC-B02, MC-B03 (period-grid positive + unsupported interval negative + sub-period negative), P4-D01..D04 | PASS |
| P5 | `market-lab/context-schema.js` (own-key DSL; `nonneg` / `price` magnitudes; signed metrics keep `num`), `market-lab/context.js` (closed family entries, coverage rows, subjects, omitted, resourceState, limits, captureRef, component scalars, limitations; safe diagnostics) | every container of the saved shape is closed with typed scalars at the pure validator, the candidate, the reader and the verifier; membership is own-property membership (an inherited name is never declared nor present); quantities, notionals, counts and fills are non-negative while returns, imbalances, basis, net flows and changes stay signed; a diagnostic names the schema path or key position, never the untrusted text; the strict parser is untouched | OA-P5a/b/c/d, OA-C03, MC-V01..V06, P5-E01..E03 | PASS |

Changed paths (revision 2) and why. `socrates/budget.js`, `market-lab/quota.js` (P2 validate → persist → commit, latch,
`failed()`, lock release on failed initialization); `market-lab/transport.js` (P2 `ACCOUNTING_FAILED`; P3 ownership set,
`fence` / `drained` / `inFlight`); `market-lab/providers/base.js` (`ACCOUNTING_FAILED` failure mapping);
`socrates/runtime.js` (P2 accounting failure after the wire is an `ACCOUNTING_FAILED` attempt, never a success);
`market-lab/owner.js` (P3 stop ownership + `closeDrainMs`; P2 accounting failure surfaced per acquisition);
`market-lab/service.js` (P3 forwarding); `socrates/broker.js` (P4 support law); `market-lab/context-schema.js`,
`market-lab/context.js` (P5 closure); `market-lab/readiness.js` (P1 qualification); tests:
`test/market-socrates-remaining-owner.test.js` (owner file, unchanged bytes), `test/market-socrates-rev2-variants.test.js`
(new), `test/helpers/market-closeout.js` (`SEALED_REF`, a lawful sealed capture reference for in-memory fixtures),
`test/market-closeout-r04-r06.test.js` (MC-B03 adapted to the period-grid law per the ticket),
`test/market-closeout-r07-e2e.test.js` (MC-RD03 rewritten around a qualified fixture with the legacy form as the
negative; MC-V02 / MC-V06 expect the positional diagnostic; the MC-V06 candidate carries the full sealed reference),
`test/market-closeout-r01-r03.test.js`, `test/market-closeout-witnesses.test.js`, `test/socrates-v2.test.js`
(placeholder capture references replaced by `SEALED_REF`; no expectation weakened); docs: this file,
`docs/MARKET-RESEARCH-CLI.md`, the revision-2 appendix in `doctrine/SOCRATES.md` with its exact-line fence in
`test/social-4f-scope.test.js`. No protected file changed; no profit target, return quota or forced-trade objective
exists anywhere in configuration, prompts, code, tests or these claims.

Relation chains reviewed together (one consistency pass): (1) reservation → dispatch → settle / release / unresolved →
restart in both journals, with the latch checked before every later admission and the owner / transport / runtime
surfacing the failure; (2) stop admission → in-flight tracking → bounded drain → fence → seal → journal release, with
the service forwarding one deadline to both owners; (3) observation identity → dedupe → per-metric support → broker
state → cache rebinding; (4) builder candidate → pure validator → reader → verifier over one closed schema; (5)
provider row → family evidence qualification → family state → overall readiness, with the historical smoke and the
model demonstration kept as separate facts.

### Judge handoff

What the candidate claims: the seven repairs above are implemented at the named production boundaries and proven by the
named deterministic tests; the full serial suite passes with zero fail / skip / todo / cancelled (see the final report
of the delivering session); `cobra.config.json`, `config.universe`, dependencies and lockfiles, the v1 contracts
(`evidence/contract.js`, `socrates/contract.js`), the trading ledger / cost / state / controls / risk, the Tape truth and
collection semantics and the Social foundation are byte-identical to the baseline commit.

What the candidate does NOT claim: no live provider or model demonstration was run in this repair (LIVE VERIFICATION per
step: NOT RUN); no paid smoke, activation, subscription or data acquisition happened; readiness stays BLOCKED until the
owner supplies entitled keys, attested plan records and a dollar ceiling; nothing here is an independent acceptance seal
(INDEPENDENT ACCEPTANCE: PENDING). The Judge should re-run `node --test --test-concurrency=1` with the PostgreSQL test
URL, `node --check` over every tracked script, diff the protected files against the baseline, and read the closeout
suites against the ticket's acceptance ids before any seal.
