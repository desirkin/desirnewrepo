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
