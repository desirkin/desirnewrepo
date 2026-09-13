# Sidebar API setup evidence — 2026-09-12

## Outcome

This ledger records only what was actually inspected or executed during the bounded setup session. PAPER stayed stopped, real-order authority stayed disabled, no continuous collector was activated, Replit Agent was not used, no purchase or upgrade was made, and no credential value is recorded here.

The broad social-research universe is the live WideEye catalog, not a hand-picked list. The bounded WideEye run observed 1,449 Kraken AssetPairs entries and admitted 612 supported USD spot assets after applying the same shared exclusions to every asset. The ordering is deterministic and lexicographic. XBT→BTC and XDG→DOGE are normalization aliases, not priority rules. A separate small market-source probe is not a social watchlist and must not be used to give BTC, ETH, SOL, or any other named coin priority.

Equal treatment here means the same eligibility, exclusion, normalization, rotation, and request-cap rules for every admitted catalog asset. It does not mean identical depth on every asset: the existing deep-tape subsystem is separately capped at 30 markets and may select by liquidity.

## Neynar and Farcaster

### Account facts verified in the signed-in Developer Portal

- Page title: `Neynar usage`.
- Existing app: `Desirkin's App`; it was visible and active. No app was created and no key was regenerated or exposed.
- Plan: Beginner / Free at $0 per month.
- Included allowance: 10,000,000 credits per monthly cycle.
- Current cycle shown: 2026-09-12 through 2026-10-12.
- Usage shown: 0.00%. The page did not expose a more precise consumed-credit count in the inspected view, so the exact used and remaining integer counts are not asserted. At displayed precision, the remaining allowance is approximately 10,000,000 credits.
- Cast search price shown by the dashboard: 10 credits per returned cast/result.
- No payment method and no enabled overage or automatic-credit-purchase control was observed. This is evidence of the inspected state, not a guarantee about every hidden account setting.
- The official Search Casts API is a read endpoint for public Farcaster casts. Its documentation permits a query string, OR/AND/phrase operators, sort modes, a cursor, and a result limit from 1 through 100: <https://docs.neynar.com/reference/search-casts>.
- Neynar's public Developer page advertises all read APIs on the free plan: <https://neynar.com/developer>.

### Existing code path, completed commissioning, and remaining activation state

`rumor2/collector.js` already composes `createFarcasterRuntime` from `rumor2/social-farcaster-runtime.js`. That runtime uses the existing normalized social journal/replay path and the access policy in `rumor2/social-farcaster-access.js`. No second Neynar client is needed or authorized.

The existing path was extended without adding a second client or weakening any approval, scope, credit, request, response-size, durability, or authority gate. `rumor2/social-farcaster-query.js` now plans one deterministic catalog window at a time from the durable WideEye catalog. Every admitted asset uses the same rule; a busy query cannot consume cursors indefinitely and starve later assets. The request ordinal is derived from durable Farcaster request receipts, so rotation resumes consistently after restart. `RUMOR2_SOCIAL_FARCASTER_RESULT_LIMIT` remains configurable, defaults to 10, is rejected outside 1–100, is sent to Neynar, is exposed in status, and rejects an oversized response page.

Neynar replied to the exact written access/retention question on 2026-09-12 at 16:39 America/New_York with `No issues`. This is recorded only as a scoped provider response for the described low-volume Search Casts use: public retrieval, personal/internal research, temporary raw caching, derived features, and retaining those derived features after the raw cache is deleted. It is not treated as a blanket approval for unrelated products, posting, redistribution, wallets, identities, or trading.

The one-shot commissioning tool records that review as `neynar-support-email-2026-09-12T16:39:00-04:00`, Free plan, credits available, `SEARCH_POLLING`, and permitted `RETRIEVAL`, `PERSONAL_RESEARCH`, and `DERIVED_FEATURES`. It uses the existing access evaluator and runtime. The broader focused host regression suite passes 90/90.

Commissioning had two bounded stages:

1. At 2026-09-12T21:08Z the first attempt made the one permitted public WideEye catalog request, then stopped before the Neynar wire with `SCOPE_NOT_ACTIVE`. It consumed zero Neynar requests and zero Neynar credits. This confirmed the intended first-run durable-scope reconciliation requirement.
2. After correcting only the one-shot harness to let the existing `settle()` path activate that durable scope, the run at 2026-09-12T21:15Z made exactly one Neynar search request. One durable request receipt was recorded; the response was valid with `SEARCH_QUERY_EXHAUSTED`, zero returned casts, zero durable cast observations, and `lastError: null`. The runtime then stopped. Because the verified dashboard charges 10 credits per returned cast, this zero-result response has zero priced search results; the enforced request envelope nevertheless capped exposure at 10 credits.

Live API response access is therefore verified. A non-empty normalized Farcaster cast observation is not yet verified. Continuous runtime remains intentionally dark because `RUMOR2_ENABLED` and `RUMOR2_SOCIAL_FARCASTER_ENABLED` are unset and the reviewed account-record environment fields have not been installed for normal collector composition.

### Smallest practical fair collection envelope — proposed, not activated

Assumptions: the eligible catalog remains close to 612 assets; each generated literal OR query represents eight catalog assets using cashtags (or a quoted `BASE/USD` identity for numeric-only symbols); Search Casts returns at most ten casts per request; dashboard pricing remains ten credits per returned cast; and a month is estimated as 30 days.

- Query design: one literal OR query from the next deterministic eight-asset catalog window. No named seed list and no market-cap or popularity priority.
- Polling: one request every 90 minutes, or 16 requests per day.
- Normal requests: 16 requests/day, 480 requests/month.
- Hard cap: 20 requests/day, 600 requests/month, leaving a 25% retry/commissioning margin.
- Normal worst-case results: 480 × 10 = 4,800 casts/month.
- Normal worst-case credits: 4,800 × 10 = 48,000 credits/month.
- Hard-cap worst case: 600 × 10 × 10 = 60,000 credits/month, 0.6% of the included 10,000,000-credit plan allowance.
- Catalog coverage cadence: `ceil(612 / 8) = 77` requests, so one full fair sweep takes about 4.8 days at 16 requests/day.
- Dollar cost on the verified current plan: $0 incremental, provided the free allowance and pricing remain unchanged and no overages or automatic purchases are enabled.

The fair rotation is implemented and tested but this envelope was not activated. Continuous polling stays off until the normal collector environment has the reviewed account record plus the exact interval/result/request caps, followed by an explicit controlled start decision.

### Official clarification route and exact question

The official routes are Neynar's Developer Portal `Support` link, the official Support Slack linked from <https://neynar.com/>, or Neynar's official Contact Us route. A clarification email was sent during this session only after explicit owner confirmation. Neynar's `No issues` reply is recorded as the scoped provider response described above, not as a substitute for terms outside that question.

Question sent for written clarification:

> We use Neynar's Search Casts endpoint only to read a small, rate-limited sample of public Farcaster posts for internal cryptocurrency research. We do not post, create identities, use wallets, sign transactions, or redistribute a raw Farcaster feed. May we (1) cache the returned public cast text and metadata temporarily for deduplication and audit, (2) create research features, scores, and aggregate statistics from those casts, and (3) retain those derived features after the temporary raw cache is deleted? Please identify any required raw-data retention limit, deletion/edit propagation duty, restriction on internal model analysis or feature extraction, and any plan or contract requirement that applies to this use. Please cite the controlling Neynar terms or policy section. We will not treat silence or a general statement that Farcaster data is public as approval.

## Fresh bounded evidence

| Area | Evidence actually obtained |
|---|---|
| Safety state | PAPER not started; continuous polling not started; authority `NONE`; live orders and real-money authority disabled. |
| WideEye | One public Kraken AssetPairs request; 1,449 observed, 612 supported, 837 excluded, 0 unresolved; catalog content ID `42d820ef87f09fcb10471c3990c66226740c0641`. |
| Bluesky | Bounded existing WideEye→RUMOR2→Bluesky smoke; `CATALOG_BACKED`, 612 scope terms, 524,428 received, 869 enqueued, 523,559 filtered, 200 appended, no last error. Status sampled `connected:false`; this was not continuous verification. |
| Market coverage | Kraken Spot 622; Kraken Derivatives 295; Deribit 946; GeckoTerminal 1; DefiLlama 1; Coinbase Spot, CoinMetrics, and FRED endpoint probes succeeded. |
| Twelve Data | One guarded SPY@NYSE verification returned ETF, MIC `ARCX`; accounting admitted/dispatched/settled 1, credits 1. SPY/QQQ/TLT exchange ambiguity was corrected in configuration. |
| CoinGecko | Refused before the wire with `DAY_CAP`, `MONTH_CAP`, and `ENTITLEMENT_EXHAUSTED`; no additional request or reset was made. |
| News | Durable readback: CoinDesk 25, The Block 20, Cointelegraph 30, Decrypt 35; total 110, corrupt 0, truncated false. |
| NOAA | One bounded poll, two requests, 63 durable records; `NOAA_KP` and `NOAA_SCALES`; corrupt 0, truncated false. Forecast records excluded: 4. |
| Official feeds | One bounded tick selected Kraken, SEC, CFTC, OFAC; each returned HTTP 304 against prior conditional state, confirming transport and persisted validators. Provider-tagged durable-event counts observed: 15, 32, 12, and 1 respectively. These counts are not asserted to be all content observations. |
| Gateway | One bounded cycle, then stopped; 2 new lifecycle rows, no current-cycle source error, 16-coin matrix, current incident data parsed from Kraken and Coinbase. Kraken System and OKX completed the cycle without a stored current incident. |
| Farcaster | Existing runtime path used; key presence and scoped provider reply verified; deterministic equal catalog rotation implemented; host suite 90/90; one durable live request receipt at 2026-09-12T21:15Z; valid empty response (`SEARCH_QUERY_EXHAUSTED`), zero casts, zero observations, no error; stopped. |

## Canonical inventory status (77 entries)

Status words describe the strongest evidence obtained without implying continuous operation.

| # | Canonical ID | Status | Evidence or exact blocker |
|---:|---|---|---|
| 1 | KRAKEN_OFFICIAL | API_RESPONSE_VERIFIED | Bounded tick returned 304 using persisted validator; provider-tagged durable events exist. |
| 2 | SEC_OFFICIAL | API_RESPONSE_VERIFIED | Bounded tick returned 304 using persisted validator; provider-tagged durable events exist. |
| 3 | CFTC_OFFICIAL | API_RESPONSE_VERIFIED | Bounded tick returned 304 using persisted validator; provider-tagged durable events exist. |
| 4 | EDGAR_OFFICIAL | BLOCKED_SCOPE | Owner-selected CIK whitelist is missing; not queried. |
| 5 | OFAC_OFFICIAL | API_RESPONSE_VERIFIED | Bounded tick returned 304; at least one provider-tagged durable event exists. |
| 6 | REUTERS_NEWS | BLOCKED_PROVIDER_APPROVAL | Licensing/provider approval unresolved. |
| 7 | BLOOMBERG_NEWS | BLOCKED_PROVIDER_APPROVAL | Licensing/provider approval unresolved. |
| 8 | CNBC_NEWS | CONFIGURED_NOT_TESTED | Terms gate remains off. |
| 9 | FT_NEWS | CONFIGURED_NOT_TESTED | Terms gate remains off. |
| 10 | COINDESK_NEWS | HOST_OBSERVATION_VERIFIED | Durable readback 25. |
| 11 | THEBLOCK_NEWS | HOST_OBSERVATION_VERIFIED | Durable readback 20. |
| 12 | COINTELEGRAPH_NEWS | HOST_OBSERVATION_VERIFIED | Durable readback 30. |
| 13 | DECRYPT_NEWS | HOST_OBSERVATION_VERIFIED | Durable readback 35. |
| 14 | GOOGLE_NEWS_AGGREGATOR | CONFIGURED_NOT_TESTED | Off pending terms review. |
| 15 | CNN_NEWS | PROPOSED_NOT_IMPLEMENTED | No approved collector/licensing path. |
| 16 | UPBIT_ANNOUNCEMENTS | PROPOSED_NOT_IMPLEMENTED | No implemented collector. |
| 17 | RESEARCH_STRAINER | CONFIGURED_NOT_TESTED | Internal evidence transform; not activated. |
| 18 | RUMINT_STOCKTWITS_AGGREGATE | RETIRED | Legacy aggregate remains disabled; official path is separately gated. |
| 19 | BLUESKY_OFFICIAL | HOST_OBSERVATION_VERIFIED | Bounded durable catalog-backed smoke appended 200; not continuously verified. |
| 20 | FARCASTER_OFFICIAL | ACCOUNT_READY; SECRET_PRESENT; API_RESPONSE_VERIFIED; EMPTY_RESULT | Scoped provider reply and existing app/key verified; one live request produced a valid empty response and durable receipt; no cast observation yet; continuous mode off. |
| 21 | X_OFFICIAL | SECRET_PRESENT; BLOCKED_SCOPE; BLOCKED_PAYMENT | Bearer secret present; no approved query and paid-smoke budget; zero calls. |
| 22 | YOUTUBE_OFFICIAL | RETIRED | Not a separate active source; use the separately gated metadata API entry. |
| 23 | REDDIT_OFFICIAL | BLOCKED_PROVIDER_APPROVAL | Access/retention approval unresolved; client credentials missing. |
| 24 | STOCKTWITS_OFFICIAL | BLOCKED_PROVIDER_APPROVAL | Entitlement/terms unresolved; stream credentials missing. |
| 25 | META_PUBLIC | BLOCKED_ACCESS | App token and approved Meta review/scope missing. |
| 26 | TIKTOK_PUBLIC | BLOCKED_PROVIDER_APPROVAL | Research API eligibility not established. |
| 27 | YOUTUBE_DATA_API | API_ENABLED; SECRET_PRESENT; HOST_OBSERVATION_VERIFIED | Restricted key stored in Replit; existing durable metadata collector returned `OBSERVED` with 16 clean observations from one accepted bounded search plus enrichment; authority `NONE`; continuous mode off. |
| 28 | META_REALTIME_TRANSPORT | BLOCKED_ACCESS | Same unresolved Meta entitlement and token as source 25. |
| 29 | FARCASTER_LIVE_TRANSPORT | API_RESPONSE_VERIFIED; EMPTY_RESULT | Existing transport made exactly one bounded live search request through the durable runtime; valid empty response; stopped. |
| 30 | TIKTOK_REALTIME_TRANSPORT | BLOCKED_PROVIDER_APPROVAL | Same unresolved institutional eligibility as source 26. |
| 31 | TAPE | INTERNAL_NOT_A_SUBSCRIPTION | Stopped. |
| 32 | WIDEEYE | API_RESPONSE_VERIFIED | One bounded public request; full 612-asset eligible catalog; stopped. |
| 33 | UNIVERSE_EXPANSION | INTERNAL_NOT_A_SUBSCRIPTION | Stopped. |
| 34 | COST_EXECUTABILITY | INTERNAL_NOT_A_SUBSCRIPTION | Internal control, no external subscription. |
| 35 | KRAKEN_SPOT | API_RESPONSE_VERIFIED | 622 usable records. |
| 36 | COINBASE_SPOT | API_RESPONSE_VERIFIED | Endpoint probe succeeded. |
| 37 | KRAKEN_DERIVATIVES | API_RESPONSE_VERIFIED | 295 usable records. |
| 38 | DERIBIT | API_RESPONSE_VERIFIED | 946 usable records. |
| 39 | BYBIT | BLOCKED_ACCESS | Geographic/access review unresolved; disabled. |
| 40 | GECKOTERMINAL | API_RESPONSE_VERIFIED | One bounded record. |
| 41 | TWELVEDATA | SECRET_PRESENT; API_RESPONSE_VERIFIED | One guarded SPY@NYSE call; one settled credit. |
| 42 | KRAKEN_CHARTS_DARK | CONFIGURED_NOT_TESTED | No separate fresh durable verification in this bounded session. |
| 43 | KRAKEN_L3_DARK | BLOCKED_OWNER_ACTION | Dedicated safe L3 credential not configured. |
| 44 | KRAKEN_OHLC_HISTORY | CONFIGURED_NOT_TESTED | Public path exists; PAPER remains stopped. |
| 45 | BINANCE_CROSS_VENUE | PROPOSED_NOT_IMPLEMENTED | Access/geography review needed. |
| 46 | COINGECKO | SECRET_PRESENT; BLOCKED_PAYMENT | Existing allowance exhausted; guard refused before wire. |
| 47 | DEFILLAMA | API_RESPONSE_VERIFIED | One bounded record. |
| 48 | COINGLASS | BLOCKED_PAYMENT | Missing key; no paid budget allocation. |
| 49 | CRYPTOQUANT | BLOCKED_PAYMENT | Missing key; no paid budget allocation. |
| 50 | SANTIMENT | BLOCKED_PAYMENT | Missing key; no paid budget allocation. |
| 51 | COINMETRICS | API_RESPONSE_VERIFIED | Endpoint probe succeeded. |
| 52 | FRED | SECRET_PRESENT; API_RESPONSE_VERIFIED | Endpoint probe succeeded. |
| 53 | TOKENOMIST | BLOCKED_PAYMENT | Missing key; no paid budget allocation. |
| 54 | POLYMARKET_PUBLIC_DATA | PROPOSED_NOT_IMPLEMENTED | No collector. |
| 55 | KALSHI_PUBLIC_DATA | PROPOSED_NOT_IMPLEMENTED | No collector. |
| 56 | GOVERNANCE_TALLY | BLOCKED_SCOPE | Missing Tally key and verified governor mappings. |
| 57 | GOVERNANCE_SNAPSHOT | BLOCKED_SCOPE | Disabled with no approved spaces; a valid empty response would not prove observations. |
| 58 | GATEWAY_KRAKEN_STATUS | API_RESPONSE_VERIFIED | Bounded current cycle parsed incidents. |
| 59 | GATEWAY_KRAKEN_SYSTEM | API_RESPONSE_VERIFIED | Bounded cycle completed without a stored current incident. |
| 60 | GATEWAY_COINBASE_STATUS | API_RESPONSE_VERIFIED | Bounded current cycle parsed an incident. |
| 61 | GATEWAY_OKX_STATUS | API_RESPONSE_VERIFIED | Bounded cycle completed without a stored current incident. |
| 62 | NOAA_SWPC_SPACE_WEATHER | HOST_OBSERVATION_VERIFIED | 63 durable records from one bounded poll. |
| 63 | RIPE_RIS_BGP | BLOCKED_SCOPE | No prefixes or ASNs configured. |
| 64 | CLOUDFLARE_RADAR | BLOCKED_OWNER_LOGIN | Google sign-in was rejected because the existing account uses another login provider; no password reset, token, request, or enable flag. |
| 65 | HELIUS_SOLANA | PROPOSED_NOT_IMPLEMENTED | No collector. |
| 66 | DOUBLEZERO_EDGE | PROPOSED_NOT_IMPLEMENTED | No collector. |
| 67 | JITO_SHREDSTREAM | PROPOSED_NOT_IMPLEMENTED | No collector. |
| 68 | SOCRATES | INTERNAL_NOT_A_SUBSCRIPTION | Stopped. |
| 69 | ASK_SERPENT_CHAT | INTERNAL_NOT_A_SUBSCRIPTION | Internal interface. |
| 70 | ASK_SERPENT_RECORDED_ANSWERS | INTERNAL_NOT_A_SUBSCRIPTION | Internal records. |
| 71 | GEMINI_TRIAGE | BLOCKED_PAYMENT | Model disabled; no approved paid budget/configuration. |
| 72 | MEMORY_MIRROR | INTERNAL_NOT_A_SUBSCRIPTION | Stopped. |
| 73 | SETTLED_RECORDS | INTERNAL_NOT_A_SUBSCRIPTION | Internal durable records. |
| 74 | JUDGE | INTERNAL_NOT_A_SUBSCRIPTION | Stopped. |
| 75 | WATCH | INTERNAL_NOT_A_SUBSCRIPTION | Stopped. |
| 76 | PAPER_EXECUTION | INTERNAL_NOT_A_SUBSCRIPTION | Stopped. |
| 77 | HISTORICAL_CAPTURE_REPLAY | CONFIGURED_NOT_TESTED | Internal replay path exists; no new run. |

## Provider commissioning addendum - 2026-09-12

- Snapshot governance: one bounded pass through the existing collector used the five verified spaces (`uniswapgovernance.eth`, `curve.eth`, `aave.eth`, `arbitrumfoundation.eth`, `opcollective.eth`). Four requests succeeded with zero failures; two proposals were observed and one durable `SNAPSHOT` observation was written for an active ARB proposal. The temporary runtime stopped with authority `NONE`.
- YouTube metadata: YouTube Data API v3 was enabled in the existing `Dinder App` project (`dinder-app-448902`). A key named `Serpent YouTube metadata (Replit)` was restricted to that API and stored as the masked Replit Secret `YOUTUBE_API_KEY`; its value is not recorded. The existing `video/collector.js` path was run with four neutral, non-coin-named queries and a four-search/day ceiling in a temporary, one-shot runtime. The final accepted poll returned `OBSERVED`, admitted 16 durable metadata observations, used one Search Queries call plus one `videos.list` enrichment unit, had zero corrupt observations and no error, then stopped. Two earlier attempts followed the credential-refused path because the browser Copy control had left stale shell text in the first Secret value; it was corrected before success. Continuous configuration was not installed.
- Cloudflare Radar: the owner confirmed the sign-in/token attempt, but Cloudflare rejected Google sign-in because the existing account uses another login provider. No password reset or guessed login was attempted. No token was created and the source remains off.
- Safety: PAPER stayed stopped, continuous polling stayed stopped, no purchase was made, and no credential value was written to this ledger.

## Exact next Farcaster step

The remaining evidentiary step is to obtain one non-empty real Search Casts response through the same existing runtime and read back its normalized durable observation together with its request receipt. Do not repeat the commissioning request merely to force a result. The next request should occur only after the reviewed non-secret account record and the proposed one-request-per-90-minutes / 20-request-daily-hard-cap configuration are installed for the normal collector, and only as a bounded manual tick while PAPER and continuous polling remain stopped.

The existing free plan is sufficient for the proposed research envelope and the scoped provider reply permits the described use. The present blockers are configuration and evidence, not account access: normal collector environment fields remain unset, and the sole live response was empty. Continuous collection remains off.
