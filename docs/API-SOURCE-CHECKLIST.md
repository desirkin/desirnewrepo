# Complete API and source setup checklist

Updated 2026-09-12. This reconciles the repository with the recovered earlier source list. It covers **77 entries**, including duplicate transport layers, internal components and proposals: **not 77 independent feeds and not 77 live connections**. The current generated inventory has 66 capability rows; Snapshot, two assistant paths and eight unimplemented/retired proposals are also included here.

**Current Replit collection is unverified for every row.** “Present” describes inspected code. Session checks below were made from the development environment. A token response, an old receipt or an empty feed does not prove continuous host collection.

Claude should execute [CLAUDE-API-SETUP-HANDOFF.md](CLAUDE-API-SETUP-HANDOFF.md). Exact configuration names and source files are also recorded in [API-SOURCE-CHECKLIST.json](API-SOURCE-CHECKLIST.json), with [runtime setup details](sensor-runtime-configuration.md). Secret values are excluded.

## Work completed in this update

- Added a news-only entry point: `node tools/news-setup.mjs --once` or `--watch`. It saves normal PRESS observations without starting paper or other APIs; selected feeds use the existing ten-minute cadence in watch mode.
- A single development run saved **85 headline observations**: The Block 20, Cointelegraph 30 and Decrypt 35. CoinDesk timed out. CNN is now explicitly listed as blocked instead of omitted.
- Repaired Snapshot transport bounds/cancellation and added regression coverage. Fresh public checks returned 82 valid NOAA alerts, one DefiLlama TVL value, and a valid empty Snapshot response.
- Prepared exact Secret names for the supplied X, Neynar and Twelve Data credentials. Their earlier successful checks do not mean Claude has installed them in Replit.

Evidence: [news checks](evidence/news-connections-2026-09-12.md) and [bounded public checks](evidence/public-feed-checks-2026-09-12.json). No ongoing host collector or new paid subscription was started by these checks.

## Cost and operating constraints

Keep paper stopped and CAGE on. The initial ceiling is **$100/month combined for external data and models**. Existing per-provider governors do not establish a single aggregate cap. Allocate within that ceiling before paid activation. X must have a focused watch scope and explicit caps; its profile REQUEST can override a false enable environment variable, so keep the paper composition stopped during setup. New external text has no direct trading authority.

Configuration blockers in the generated inventory were computed with an empty secret environment. They do **not** establish that a previously reported Replit Secret is absent. Preserve existing FRED, CoinGecko and database configuration; do not reset the exhausted CoinGecko demonstration meter.

## News and official announcements

An LLM can deduplicate, summarize and compare permitted headlines/excerpts with source links. It cannot supply a missing CNN/Reuters/Bloomberg license or turn one web lookup into a continuous feed.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `KRAKEN_OFFICIAL` | Public adapter present | No key. Preserve official-feed configuration; verify saved observations on the host. |
| `SEC_OFFICIAL` | Public adapter present; contact required | Set the real public SERPENT_HTTP_CONTACT identity before a bounded check. |
| `CFTC_OFFICIAL` | Public adapter present | No key. Verify saved official-feed observations on the host. |
| `EDGAR_OFFICIAL` | Adapter present; watch list required | Use existing contact, CIK whitelist and form filters; no invented company scope. |
| `OFAC_OFFICIAL` | Public adapter present | No key. Verify the bounded official sanctions-data update on the host. |
| `REUTERS_NEWS` | Licensed client absent | Obtain an actual licensed interface/payload contract before implementation; no existing secret name. |
| `BLOOMBERG_NEWS` | Licensed client absent | Obtain an actual licensed interface/payload contract before implementation; no existing secret name. |
| `CNBC_NEWS` | RSS adapter present; OFF | Latest bounded check returned 403. Preserve access/terms gate; no bypass or API key needed for this adapter. |
| `FT_NEWS` | RSS adapter present; OFF | Latest check timed out; earlier access denial recorded. Resolve actual route/terms before enabling. |
| `COINDESK_NEWS` | RSS adapter selected; latest check timed out | No key. Run the news-only check on Replit; a timeout does not prove a permanent outage. |
| `THEBLOCK_NEWS` | 20 headlines saved in development run | No key. Verify with the news-only runner on Replit; headline/link use only. |
| `COINTELEGRAPH_NEWS` | 30 headlines saved in development run | No key. Verify with the news-only runner on Replit; headline/link use only. |
| `DECRYPT_NEWS` | 35 headlines saved in development run | No key. Verify with the news-only runner on Replit; headline/link use only. |
| `GOOGLE_NEWS_AGGREGATOR` | RSS adapter present; OFF; 100 items parsed | No key. Preserve existing route/terms review before enabling; individual publishers are separate sources. |
| `CNN_NEWS` | Explicitly blocked; client absent | Legacy feeds returned 502. Need a working documented public route or licensed interface; no key to request yet. |
| `UPBIT_ANNOUNCEMENTS` | Proposed; not implemented | No announcement client or registry row. Confirm documented read-only route, access eligibility and price, then implement bounded adapter if it fits the established combined budget |

## Social sources and their transport layers

An LLM can review selected, permitted posts for topics, corroboration and source context after deterministic filtering. It cannot approve an API application, bypass MFA, or turn a ChatGPT plugin into Serpent runtime access.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `RESEARCH_STRAINER` | Internal filtering code present | Consumes admitted social observations; it supplies neither credentials nor source access. |
| `RUMINT_STOCKTWITS_AGGREGATE` | Legacy aggregate client present | Prior one-page success is historical. Verify current availability and permitted use; distinct from Firestream and the ChatGPT plugin. |
| `BLUESKY_OFFICIAL` | Public Jetstream adapter present | No key. Prior live messages were parsed; current host durable delivery remains unverified. |
| `FARCASTER_OFFICIAL` | Neynar key checked: one cast returned | Claude installs NEYNAR_API_KEY; verify the existing free search plan, narrow query scope and request cap on host. |
| `X_OFFICIAL` | Bearer checked: usage endpoint only | Claude installs X_BEARER_TOKEN. Keep collection unstarted until focused watch scope and explicit share of the combined budget are configured. |
| `YOUTUBE_OFFICIAL` | Boundary/fixture path only; OFF | Use the implemented YOUTUBE_DATA_API row below for metadata collection; this is not a second feed. |
| `REDDIT_OFFICIAL` | Collector present; API approval unresolved | Needs approved OAuth app credentials, subreddits, user-agent and request cap. Repeating the failed form or using an LLM cannot grant access. |
| `STOCKTWITS_OFFICIAL` | Licensed Firestream collector present | Needs licensed stream username/password and symbols/cap. Website login and ChatGPT connection do not provide these. |
| `META_PUBLIC` | Collector present; approved access unresolved | Needs META_APP_TOKEN, reviewed Graph API scope and page/hashtag selection plus cap. This is not unrestricted Facebook access. |
| `TIKTOK_PUBLIC` | Foundation only; eligible route unresolved | Do not request template keys as a completion step. Research eligibility is not established; own-account Display access is insufficient. |
| `YOUTUBE_DATA_API` | Metadata collector present; key missing | Needs YOUTUBE_API_KEY plus narrow query list and daily search cap. Google account/MFA step remains external; no transcript/video scraping. |
| `META_REALTIME_TRANSPORT` | Implementation layer of META_PUBLIC | Same Meta credential and scope requirements; do not count as another feed. |
| `FARCASTER_LIVE_TRANSPORT` | Implementation layer of FARCASTER_OFFICIAL | Same Neynar credential and query/cap requirements; do not count as another feed. |
| `TIKTOK_REALTIME_TRANSPORT` | Live route absent | Same unresolved eligibility as TIKTOK_PUBLIC; no automatic workaround claimed. |

## Charts and market data

Use actual candles, trades and books for calculations. An LLM can explain selected recorded anomalies; it cannot invent prices, fill unknown gaps or prove instrument entitlement.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `TAPE` | Kraken public market-data core present | No data key. Prior live book/trade evidence exists; leave paper composition stopped during API setup. |
| `WIDEEYE` | Market survey code present | Uses public market data and configured resource limits; no separate account. |
| `UNIVERSE_EXPANSION` | Observation selection code present | Uses actual market catalog and resource caps; no separate API key. |
| `COST_EXECUTABILITY` | Internal numerical calculation present | Needs fresh actual book data; an LLM cannot replace missing numerical observations. |
| `KRAKEN_SPOT` | Public adapter present; latest check timed out | No key. Existing receipt is historical; current host connectivity still needs verification. |
| `COINBASE_SPOT` | Public adapter present; latest check timed out | No key. Existing receipt is historical; current host connectivity still needs verification. |
| `KRAKEN_DERIVATIVES` | Public adapter present | No key for configured public data; current host verification outstanding. |
| `DERIBIT` | Public adapter present; latest check timed out | No key for configured public data; current host verification outstanding. |
| `BYBIT` | Public adapter present; OFF for access/geography | REST and liquidation/ticker WebSocket code exist. Do not bypass observed access restrictions. |
| `GECKOTERMINAL` | Public adapter present | No key. Verify configured pool coverage and host response within current allowance. |
| `TWELVEDATA` | Key checked: two EUR/USD bars | Claude installs TWELVEDATA_API_KEY. Basic free allowance is configured; verify other instruments before claiming entitlement. |
| `KRAKEN_CHARTS_DARK` | Public derivatives chart adapter present | No key. Separate research path; prior open-interest response does not establish current host coverage. |
| `KRAKEN_L3_DARK` | Data-key-gated L3 adapter present | Requires a dedicated data-only pair and SAFE_L3_DATA_KEY proof; never reuse order/withdrawal credentials. |
| `KRAKEN_OHLC_HISTORY` | Public OHLC/history adapter present | No key. Preserve recorded history and verify actual candle clocks/gaps. |
| `BINANCE_CROSS_VENUE` | Proposed; not implemented | No Binance market provider; a name in vocabulary/tests and a doctrine not-watched status note are not a collector. Confirm documented read-only route, access eligibility and price, then implement bounded adapter if it fits the established combined budget |

## Macro, on-chain and market research

An LLM can explain actual releases, on-chain metrics and unlock observations with their units and timestamps. It cannot supply missing paid coverage or infer unavailable release values.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `COINGECKO` | Demo adapter present; reported existing key | Preserve existing key and exhausted two-call demonstration meter. Do not reset it for another check. |
| `DEFILLAMA` | Fresh HTTP 200; one valid TVL scalar | No key. One response validated; continuous host collection remains unverified. |
| `COINGLASS` | Credentialed adapter present; plan/budget blocked | Needs entitled COINGLASS_API_KEY and allocated budget; no paid subscription created. |
| `CRYPTOQUANT` | Credentialed adapter present; plan/budget blocked | Needs entitled CRYPTOQUANT_API_KEY and allocated budget; no paid subscription created. |
| `SANTIMENT` | Credentialed adapter present; plan/budget blocked | Needs entitled SANTIMENT_API_KEY and allocated budget; no paid subscription created. |
| `COINMETRICS` | Community adapter present; latest check timed out | No key for the implemented community route. Verify current host availability. |
| `FRED` | Adapter present; reported existing key | Preserve FRED_API_KEY and existing series scope. Earlier 240 observations are historical evidence, not a new host check. |
| `TOKENOMIST` | Credentialed adapter present; plan/budget blocked | Needs entitled TOKENOMIST_API_KEY and allocated budget; no paid subscription created. |
| `POLYMARKET_PUBLIC_DATA` | Proposed; not implemented | No public market-data client or registry row; no trading integration requested. Confirm documented read-only route, access eligibility and price, then implement bounded adapter if it fits the established combined budget |
| `KALSHI_PUBLIC_DATA` | Proposed; not implemented | No public market-data client or registry row; no trading integration requested. Confirm documented read-only route, access eligibility and price, then implement bounded adapter if it fits the established combined budget |

## Governance

An LLM can summarize bounded proposal text with links. An off-chain vote does not prove execution, treasury movement or an inevitable outcome.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `GOVERNANCE_TALLY` | Collector present; credentials/mappings unverified | Needs TALLY_API_KEY and verified governor mappings. No live request made in this check. |
| `GOVERNANCE_SNAPSHOT` | Transport repaired; HTTP 200, valid empty result | No key. Preserve OFF profile until selected governance scope is reviewed. Empty Aave result is not a proposal observation. |

## Infrastructure

An LLM can summarize recorded incidents and routing changes. Correlation and missing observations do not become trading instructions.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `GATEWAY_KRAKEN_STATUS` | Public status adapter present; latest timeout | No key. Current host incident collection requires verification; keep existing spacing/backoff. |
| `GATEWAY_KRAKEN_SYSTEM` | Public system-status adapter present; latest timeout | No key. Current host status collection requires verification; keep existing spacing/backoff. |
| `GATEWAY_COINBASE_STATUS` | Public status adapter present; latest timeout | No key. Current host incident collection requires verification; keep existing spacing/backoff. |
| `GATEWAY_OKX_STATUS` | Public status adapter present; latest timeout | No key. Current host incident collection requires verification; keep existing spacing/backoff. |
| `NOAA_SWPC_SPACE_WEATHER` | Kp/scales adapter present; separate alerts endpoint checked | No key. A separate NOAA alerts.json request returned 82 valid alerts; that does not verify the composed Kp/scales routes or continuous host collection. |
| `RIPE_RIS_BGP` | Public adapter present; resource scope missing | Set real monitored prefixes/ASNs in INFRA_RIPE_RESOURCES; do not invent a list. |
| `CLOUDFLARE_RADAR` | Adapter present; token/scope unverified | Needs CLOUDFLARE_API_TOKEN and actual ASN/prefix/date-range or reviewed global scope. |
| `HELIUS_SOLANA` | Proposed; not implemented | No Helius client, RPC/WebSocket configuration or runtime secret name. Confirm documented read-only route, access eligibility and price, then implement bounded adapter if it fits the established combined budget |
| `DOUBLEZERO_EDGE` | Proposed; not implemented | No client/config/runtime secret name; intended data contract requires clarification from the recovered proposal and first-party documentation. Confirm documented read-only route, access eligibility and price, then implement bounded adapter if it fits the established combined budget |
| `JITO_SHREDSTREAM` | Retired | Recovered prior decision marks this target dead; no implementation. JITOSOL in risk asset groups is unrelated. Keep retired; do not reactivate by default |

## Models and assistant answers

Selective model calls need an explicit allocation within the combined budget. No generic always-running news/social LLM agent has been verified by this audit.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `SOCRATES` | Anthropic client present; policy disabled | ANTHROPIC_API_KEY plus explicit model caps required. Keep selective; data and models share the combined ceiling. |
| `ASK_SERPENT_CHAT` | Anthropic chat client present; budget gated | Same Anthropic key; explicit chat request/day caps. This does not create a news collection agent. |
| `ASK_SERPENT_RECORDED_ANSWERS` | Local recorded-state answers present | No model key. Needs actual saved runtime state; cannot report unseen live feeds. |
| `GEMINI_TRIAGE` | Proposed; not implemented | Current implemented model clients use Anthropic only; forbidden-marker tests mentioning gemini are not an integration. Confirm documented read-only route, access eligibility and price, then implement bounded adapter if it fits the established combined budget |

## Internal components (not source subscriptions)

These preserve, calculate or consume observations. They do not require another news/social subscription. Keep existing paper and account holds intact.

| Source / capability ID | Current code and evidence | What can be completed / what remains |
|---|---|---|
| `MEMORY_MIRROR` | Internal storage code present | Preserve authoritative database and records; no separate source account. |
| `SETTLED_RECORDS` | Local recorded-observation adapter present | No network/key. Preserve existing settled records and clocks. |
| `JUDGE` | Decision core present | Preserve DATABASE_URL and journal; no new external text authority or paper start during setup. |
| `WATCH` | Position monitoring core present | Preserve DATABASE_URL and existing account state; keep setup separate from paper startup. |
| `PAPER_EXECUTION` | Execution core present; owner hold | Keep paper stopped and CAGE on until requested feeds are connected and verified. |
| `HISTORICAL_CAPTURE_REPLAY` | Offline capture/replay code present | No separate API key. Uses saved observations; replay is not live connectivity. |

## What is still external

Claude must have a supported Secrets write capability in its own Replit session and receive the credential values securely. This repository document is a handoff, not proof that Claude was invoked. No callable Stocktwits plugin data tool was exposed to this session; the connected plugin has not been verified as a continuous app feed. Reddit and Google identity/approval loops remain external account steps. An LLM can help analyze permitted material, but it cannot grant those permissions.
