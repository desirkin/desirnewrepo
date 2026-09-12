# Sensor completion and paper-start repair — 56-row scope report, 2026-09-12

**Environment split.** `DEV` = this Claude Code development container (no `REPL*` variables, no `DATABASE_URL`, no provider
credential of any kind, outbound HTTPS through the build proxy). `PROD` = the Replit deployment (`0bf4facd-0e3c-4540-b57f-43398a032d45`
as previously reported) — **not reachable from this session**; every PROD cell below is NOT_VERIFIED unless a dated host
artifact says otherwise. A DEV result never implies a PROD result.

**Definitions** (owner ticket §2): CODE VERIFIED = a real supported collector, production composition, failure handling and
meaningful tests that passed on the final code; CONFIGURATION VERIFIED = effective settings + entitlement checked in the named
environment; LIVE VERIFIED = a dated actual response / stream receipt in that environment; RECORDING VERIFIED = the intended
stored result (isolated PostgreSQL harness for DEV; restart evidence where the source persists); CONSUMER VERIFIED = the intended
runtime reader received correctly classified evidence. A successful empty response proves access only.

## 1. Baseline and refs

| | value |
|---|---|
| Repository | `github.com/desirkin/desirnewrepo` (origin; token redacted) |
| Baseline commit / tree | `e720e1fd852ded39a99a1aacdcc9370636a535c9` / `43c697afea603925436733c60e4e46826f8d74b2` |
| Branch | `claude/cobra-phase-c1-setup-n9yy6r`; `origin/main` at `a17a035` (fast-forward ancestor) |
| Successors preserved | `e89d29f` (Replit Agent: `.replit` `[userenv.shared]` names only — `COBRA_DATA_DIR`, `COBRA_PROFILE`, `PORT`; no secret) and `e720e1f` (owner: `.agents/memory/*` PostgreSQL test note). Verified byte-free of secrets before fast-forward. |
| Unfinished merge / rebase | none in this checkout. The owner's screenshot showed a host-side merge with conflicts in `docs/JUDGE-PAPER-AUDIT.md` and `judge/composition.js`; the pushed successors do not touch either file, so the host resolved (or abandoned) it in favour of `a17a035`. **Any uncommitted collector work left by the cancelled Replit Agent task lives only on the host workspace and is not visible here** — inspect `git status` there before discarding anything. |
| Prior repairs confirmed on this source | `execution/feed.js` book-snapshot recovery (`requestBookSnapshot` ×6), instrument precision cache (`precisions`), admission-clock trade coverage; `judge/readiness.js` + `judge/composition.js` `nominationLastSeenTs` rank/expiry split; `paper/preflight.js` `probeFacts` (failed-vs-empty). `git diff a17a035 e720e1f` touches only `.replit` and `.agents/`. |

## 2. Repairs made in this pass (plain language)

1. **The requested scope is now accounted for inside the app, not only in a report.** `paper/scope.js` is the checked-in 56-row
   map (stable ids → inventory rows); `paper/inventory.js` gained the rows the repository does not implement — nine publisher
   rows, Cloudflare Radar, NOAA space weather, RIPE RIS, YouTube — each `NOT_PRESENT` with its exact blocker and dated route
   evidence, plus two present-but-unlisted capabilities (`KRAKEN_OHLC_HISTORY`, `HISTORICAL_CAPTURE_REPLAY`). The fence
   `test/sensor-scope.test.js` refuses a scope id that maps nowhere, a NOT_PRESENT row without an exact blocker, or a
   publisher row that hides the frozen-core rule conflict; `test/paper-runtime.test.js` P-03 now pins the exact NOT_PRESENT set.
2. **Dated receipts refreshed through the repository's own clients** (no credential, one bounded read each): Kraken official
   RSS, CFTC RSS, OFAC SDN CSV, the four gateway doors, the RUMINT StockTwits aggregate page, Kraken OHLC history, and the
   read-only preflight smoke on `e720e1f` (§4). `SMOKE_FACTS` and `docs/sensor-inventory.paper.json` carry them.
3. **Identified rule conflict (not bypassed):** `doctrine/RUMOR2.md` §"What RUMOR-2A is not" — "No Reuters/Bloomberg/CNBC/FT/CoinDesk/
   any publisher" — and `test/rumor2-authority.test.js:156` (the frozen core may not even contain those tokens) forbid publisher
   ears in the evidence tier. Affected action: implementing P01–P09 as RUMOR ears. Everything else in the ticket proceeded.
   Owner decision needed before any publisher code (§7).

No trading logic, threshold, authority, Judge / Watch / Socrates behaviour, dependency, runtime enum or profile value changed.

## 3. Rule conflicts and non-implementable rows

| Rows | Rule / fact | Affected action | Status |
|---|---|---|---|
| P01–P09 | `doctrine/RUMOR2.md` "No … any publisher"; `test/rumor2-authority.test.js:156` bans publisher tokens in the frozen core | adding publisher ears to RUMOR-2 | not built; routes verified and recorded (§4) |
| P01, P02 | no public documented feed; licensed distribution only (Reuters Connect; Bloomberg Terminal / B-PIPE) | any collector | NO_ELIGIBLE_DOCUMENTED_ROUTE |
| I01–I03 | no existing consumer tier for internet-radar / space-weather / routing observations; the gateway is a venue-door model (`gateway/parse.js`) | placing a collector | owner placement decision; routes verified |
| I04 | `governance/tally.js`: collector not implemented (`UNAVAILABLE_COLLECTOR_NOT_IMPLEMENTED`), key absent, no verified governor mapping | Tally collection | foundation only |
| S04–S09 | terms / retention / app-review / transport gaps recorded in `rumor2/social-*.js` with dated doc refs | live collection | blocked as recorded |
| S10 | no repository reference to YouTube existed | collector | NOT_PRESENT (route verified) |

## 4. The 56 rows — CODE / CONFIGURATION / LIVE ACCESS / RECORDING / CONSUMER CONNECTION

Legend: V = VERIFIED, NV = NOT_VERIFIED, B = BLOCKED, NA = NOT_APPLICABLE. Each cell is `DEV` unless prefixed; `PROD` is NV
for every row (no host access in this session). "tests" = the named suites passed in the full serial gate on the final code
(§6). Times are UTC, 2026-09-12.

### Market and financial

| ID | inventory row | CODE | CONFIG | LIVE | RECORDING | CONSUMER | evidence / blocker |
|---|---|---|---|---|---|---|---|
| M01 | TAPE | V (`judge-operational-repair` OR-1a–d, `judge-feed-clock`, `judge-composition` P03) | V — profile ON, no credential | V 00:12–00:17 real Kraken WS v2, OBSERVE composition: **34 231 CRC-verified books → Judge**, 0 CRC failures (feed/tape bytes identical between `a17a035` and `e720e1f`) | V (ephemeral by contract): fresh venue snapshot on demand, CRC, `synced` law tested; durable capture is C03 | V — `judge.onBook` counters, `BOOK_FRESH` satisfied on 5 of 6 candidates; the sixth (LINK/USD) refused as stale, never invented | — |
| M02 | TAPE | V | V | V same run: 537 trades, coverage `continuous` from the admission clock | V (contract) | V — `FLOW_21MIN` accumulating (301 059 / 1 260 000 ms at stop) | — |
| M03 | KRAKEN_OHLC_HISTORY | V (`judge-composition` J01/J11-history, `judge-experiment-bundle`) | V — shared transport with the Judge | V 04:06:23 `refresh(XBT/USD)`: ok, 721 rows, 720 closed bars, 61-bar block complete | V — HISTORY rows captured into input bundles (tests) | V — Judge indicator block (`missingOf61 0`) | — |
| M04 | TAPE + KRAKEN_SPOT | V | V | V — instrument precision applied (CRC verified on the first post-admission snapshot; live run 0 failures); `KRAKEN_SPOT` PROBED_OK **622 markets** 04:03:51 | V (contract) | V | — |
| M05 | KRAKEN_DERIVATIVES | V (`market-lab-providers`, `market-closeout-*`) | V — policy enabled, FREE | V 04:03:52 PROBED_OK **295 records** (instruments / tickers); `rest-funding-history` **not separately probed → NV** | V by tests (research store); NV live | V by tests (research context, authority NONE); NV live | partial: funding endpoint unprobed |
| M06 | KRAKEN_CHARTS_DARK | V (`market-kraken-charts`, `market-kraken-edge-*`) | V — dark capture ON | V 04:03 PF_XBTUSD open interest, 60 s, 2 observations, acquisition COMPLETE, coverage OBSERVED | NV — the smoke writes to a scratch root, not the deployment's | NA — EDGE_CAPTURE only, authority NONE | — |
| M07 | KRAKEN_L3_DARK | V (`market-kraken-l3`) | B — no `KRAKEN_L3_DATA_API_KEY/SECRET`; verdict CREDENTIAL_MISSING | B | NV | NA (authority NONE); **not on the Judge book route** | dedicated data-only key required |
| M08 | COINBASE_SPOT | V | V — FREE | V 04:03:51 PROBED_OK (products; endpoint reports no count); `rest-book/trades/candles/ws-feed` **not individually probed → NV** | V by tests; NV live | V by tests; NV live | partial |
| M09 | DERIBIT | V | V | V 04:03:53 PROBED_OK **950 records** (instruments); `ticker`, `get-book-summary-by-currency` NV individually | V by tests | V by tests | partial |
| M10 | BYBIT | V (code path complete) | B — DISABLED_BY_PAPER_POLICY; BLOCKED_GEOGRAPHY (HTTP 403, 2026-09-11) | B | NA | NA | no unofficial mirror |
| M11 | COINGECKO | V (`coins-list`, `coins-markets`, `coin-detail`) | B in DEV — `COINGECKO_DEMO_API_KEY` absent here; policy plan attestation absent (paid-call gate). **PROD: the owner placed the key in Replit Secrets — effective availability NV from here; the preflight on the host will say** | unauthenticated `/ping` HTTP 200 (access proof only; configured path NOT_PROBED: PROVIDER_DISABLED) | NV | NV | attest plan + billing in `config/market-research.paper.json`, then enable |
| M12 | GECKOTERMINAL | V | V | V 04:03:53 PROBED_OK 1 record | V by tests | V by tests | — |
| M13 | DEFILLAMA | V | V | V 04:03:53 PROBED_OK 1 record | V by tests | V by tests | — |
| M14 | COINMETRICS | V | V (community) | V 04:03:53 PROBED_OK | V by tests | V by tests | — |
| M15 | FRED (+ ALFRED vintages) | V — `realtime_start/end`, `vintageDates`, `releaseDates`; revised vs then-known preserved per observation | B in DEV — `FRED_API_KEY` absent; **PROD key reportedly placed — NV from here** | B: PROBED_FAILED `CREDENTIAL_MISSING`, coverage `ACCESS_BLOCKED` (named, not blank) | NV | NV | verify on host preflight |
| M16 | COINGLASS | V — 7 endpoints (`oi-exchange-list`, `funding-exchange-list`, `liquidation-aggregated-history`, `coin-unlock-list`, `coin-vesting`, `economic-data`, `article-list`); each individually NV live | B — METERED; CREDENTIAL_MISSING + BLOCKED_BUDGET | B — no billable smoke under an invented allowance | NV | NV | owner plan decision |
| M17 | CRYPTOQUANT | V (4 endpoints) | B — METERED | B | NV | NV | owner plan decision |
| M18 | SANTIMENT | V | B — METERED | B | NV | NV | owner plan decision |
| M19 | TWELVEDATA | V | B — METERED | B | NV | NV | owner plan decision |
| M20 | TOKENOMIST | V (`unlock-events`, `upcoming-unlock-events`, `allocations`, `token-list`) | B — METERED | B | NV | NV | owner plan decision |

### Social

| ID | inventory row | CODE | CONFIG | LIVE | RECORDING | CONSUMER | evidence / blocker |
|---|---|---|---|---|---|---|---|
| S01 | BLUESKY_OFFICIAL | V (`bluesky-ear`, `social-*`, `social-5-durable`) | V — profile ON, public | V 00:13 Jetstream v2, closed contract: open 461 ms, **200/200** messages → valid observations, 0 skips, seq 25754477318 | V in the isolated PG harness (durable settle, resume cursor, failure before/after settle); **NV PROD** (no `DATABASE_URL` here) | V by tests (RUMOR social projection); NV live | — |
| S02 | X_OFFICIAL | V (`x-*` suites) | B — `X_BEARER_TOKEN` + 3 budgets + explicit paid smoke | B — never spent | NV | NV | owner credential + budgets |
| S03 | RUMINT_STOCKTWITS_AGGREGATE | V (`rumint*` suites) | V — `cobra.config.json` rumint enabled, budget 120/h, spacing 2.1 s | V 04:05:04 `fetchSymbolPage(BTC.X)`: ok, 30 messages, cursor | V by tests (checkpoint / baseline / interrupted-poll recovery) | V by tests (nominate-and-warn, RUMINT-R1) | — |
| S04 | STOCKTWITS_OFFICIAL | V (code path complete) | B — BLOCKED_TERMS (entitlement + terms review) | B | NA | NA | owner terms review |
| S05 | REDDIT_OFFICIAL | V (code path complete, fixture-only) | B — BLOCKED_RETENTION | B | NA | NA | retention decision first |
| S06 | TIKTOK_PUBLIC (+ transport NOT_PRESENT) | NV — foundation only | B — BLOCKED_TERMS (no authorized organic route) | B | NA | NA | none available |
| S07 | META_PUBLIC (FACEBOOK) (+ transport NOT_PRESENT) | NV — descriptors only | B — BLOCKED_EXTERNAL_APPROVAL (app review) | B | NA | NA | Meta App Review |
| S08 | META_PUBLIC (INSTAGRAM) (+ transport NOT_PRESENT) | NV — descriptors only; docs M3–M6M (hashtag search requires App Review; professional accounts only) | B — same | B | NA | NA | Meta App Review |
| S09 | FARCASTER_OFFICIAL (+ transport NOT_PRESENT) | NV — access boundary + mapper; `liveTransport: false` declared | B — no live transport composed | B | NA | NA | transport build + entitlement decision |
| S10 | YOUTUBE_DATA_API | NV — NOT_PRESENT | B — CREDENTIAL_REQUIRED (API key), TERMS_REVIEW, query scope | NA | NA | NA | route verified 04:03: `search.list`, default quota 10 000 units/day (search = 100 units); metadata only |

### Official and news

| ID | inventory row | CODE | CONFIG | LIVE | RECORDING | CONSUMER | evidence / blocker |
|---|---|---|---|---|---|---|---|
| N01 | KRAKEN_OFFICIAL | V (`rumor2-*` suites) | V — profile ON | V 04:05:00 `fetchProviderFeed` + `parseFeed`: HTTP 200, 10 items, 0 truncated | V isolated PG (event root, journal, writer fence) by tests; NV PROD | V by tests (claim graph / settle) | — |
| N02 | SEC_OFFICIAL | V | B — CONFIG_REQUIRED `SERPENT_HTTP_CONTACT` (SEC user-agent law) → NOT_QUERIED | B (not bypassed) | NV | NV | owner sets the contact string |
| N03 | CFTC_OFFICIAL | V | V | V 04:05:00 HTTP 200, 10 items | V by tests; NV PROD | V by tests | — |
| N04 | EDGAR_OFFICIAL | V | B — CONFIG_REQUIRED `SERPENT_HTTP_CONTACT` + `RUMOR2_EDGAR_CIKS` (owner's own issuer list; none invented) | B | NV | NV | owner config |
| N05 | OFAC_OFFICIAL | V (identity / diff semantics, complete-snapshot law: `rumor2-b1*` tests) | V | V 04:05:02 HTTP 200, SDN CSV 5.69 MB / 19 389 lines within the provider byte bound | V by tests; NV PROD | V by tests | — |
| N06 | COINGLASS (`article-list`, same client + quota as M16) | V | B — as M16 | B | NV | NV | linked to M16; not a second poller |

### Publisher / news connections (all NOT_PRESENT; rule conflict §3)

| ID | inventory row | CODE | CONFIG | LIVE | RECORDING | CONSUMER | route evidence (read-only, 04:03) |
|---|---|---|---|---|---|---|---|
| P01 | REUTERS_NEWS | NV | B | B | NA | NA | `reuters.com/tools/rss` HTTP 401; agency products page 404; licensed only |
| P02 | BLOOMBERG_NEWS | NV | B | B | NA | NA | `bloomberg.com/feeds`, `/professional/products/data` HTTP 403 anti-bot; licensed only |
| P03 | CNBC_NEWS | NV | B | B | NA | NA | `cnbc.com/rss-feeds` and top-news RSS HTTP 403 from this environment — docs unreadable here |
| P04 | FT_NEWS | NV | B | B | NA | NA | `ft.com/rss/home` → 200 text/xml (1 item; headlines, paywalled bodies); `/rss` docs page redirect loop |
| P05 | COINDESK_NEWS | NV | B | B | NA | NA | outbound RSS 200 application/xml, 25 items; `/rss` docs page HTTP 429 checkpoint |
| P06 | THEBLOCK_NEWS | NV | B | B | NA | NA | `theblock.co/rss.xml` 200, 20 items |
| P07 | COINTELEGRAPH_NEWS | NV | B | B | NA | NA | `cointelegraph.com/rss` 200, 30 items |
| P08 | DECRYPT_NEWS | NV | B | B | NA | NA | `decrypt.co/feed` 200, 55 items |
| P09 | GOOGLE_NEWS_AGGREGATOR | NV | B | B | NA | NA | `news.google.com/rss/search` 200 (aggregator; per-item publisher identity); Publisher Center docs cover publishers, not a consumer API |

For every P row: headline / link access is what the reachable feeds offer; no full-text fetch is contemplated; terms unverified; a
generic RSS parser (`rumor2/feed.js`) exists but is NOT a publisher integration.

### Infrastructure, governance and status

| ID | inventory row | CODE | CONFIG | LIVE | RECORDING | CONSUMER | evidence / blocker |
|---|---|---|---|---|---|---|---|
| I01 | CLOUDFLARE_RADAR | NV — NOT_PRESENT | B — API token required (`CLOUDFLARE_API_TOKEN`, free account) | B — unauthenticated `radar/bgp/timeseries` → HTTP 400 `{"code":9106,"message":"Missing X-Auth-Key, X-Auth-Email or Authorization headers"}`; docs page 200 | NA | NA — no consumer tier | old "no key" claim is **false** today |
| I02 | NOAA_SWPC_SPACE_WEATHER | NV — NOT_PRESENT | B — no consumer tier / placement | route V 04:04: `noaa-planetary-k-index.json` 200 rows `{time_tag, Kp, a_running, station_count}`; `noaa-scales.json` 200 R/S/G scales; no key | NA | NA | experimental; owner placement decision |
| I03 | RIPE_RIS_BGP | NV — NOT_PRESENT | B — no monitored prefixes / ASNs configured; no consumer tier | route V 04:04: RIPEstat `routing-status` 200 `status ok`; RIS Live docs 200; no key | NA | NA | owner scope + placement |
| I04 | GOVERNANCE_TALLY | NV — scaffolding (`tallyStatus` → `UNAVAILABLE_COLLECTOR_NOT_IMPLEMENTED`) | B — `TALLY_API_KEY` absent; no verified governor mapping | B (zero Tally calls by design); `docs.tally.xyz` 200 (the API doc path in older notes now 404) | NA | NA | Snapshot governance runs separately |
| I05 | GATEWAY_KRAKEN_STATUS | V (`gateway` suite) | V — profile ON | V 04:05:02 HTTP 200, 7 events parsed (0 unparsed), indicator `minor`, one `identified` DELAYED door | V by tests (transitions / matrix / archive JSONL) | V by tests (memory mirror; market-lab settled reads the door matrix) | — |
| I06 | GATEWAY_KRAKEN_SYSTEM | V | V | V 04:05:03 HTTP 200 `online` | V by tests | V by tests | — |
| I07 | GATEWAY_COINBASE_STATUS | V | V | V 04:05:03 HTTP 200, 1 event; classified `UNKNOWN` door (title not in the door vocabulary — parsed honestly as unparsed) | V by tests | V by tests | — |
| I08 | GATEWAY_OKX_STATUS | V | V | V 04:05:04 HTTP 200 code 0 | V by tests | V by tests | — |

### Internal capabilities

| ID | inventory row | CODE | CONFIG | LIVE | RECORDING | CONSUMER | evidence |
|---|---|---|---|---|---|---|---|
| C01 | WIDEEYE | V (`wideeye` suite) | V — profile ON | NA external; composed runtime: local status file from the 2026-09-11 soak reported ACTIVE_DEGRADED in preflight C | V by tests (survey status + nominations) | V by tests | — |
| C02 | UNIVERSE_EXPANSION | V (`universe` suite) | V | V 00:12 the OBSERVE run selected the universe from the venue and admitted six candidates | V (universe/current.json) | V — nominations → Judge preparation (stable six) | — |
| C03 | HISTORICAL_CAPTURE_REPLAY | V (`judge-composition` P03, `judge-experiment-replay`, `judge-experiment-bundle`, `childhood`) | V | NA | V by tests (sealed segments, rotation, retention) | V by tests (replay arms, experiment store) | — |

## 5. Account continuity and PAPER start

- **No host access in this session** (`0` `REPL*` variables; no `DATABASE_URL`): the source / destination databases, the
  revision-21 account, the recorded migration / binding decision and the running-process state **could not be read**. Nothing
  was migrated, bound, reset, reinitialized or written. PAPER on the host is neither started nor stopped by this pass:
  **HOST_PAUSE_UNVERIFIED**.
- Local preflight on `e720e1f` (04:03): verdict `NOT_READY_FOR_PAPER` for one core reason — `DATABASE_URL` not configured in this
  container. Every other blocker is an optional-sense blocker (§4).
- The startup path already refuses an absent / wrong account (`judge/composition.js`: `ACCOUNT_UNINITIALIZED`, `ACCOUNT_KIND_MISMATCH`,
  `RESTORE_FAILED`, never a fresh USD 500) — verified by `judge-repair-restart` / `judge-e2e-pg` in the isolated harness.

**Smallest exact remaining host actions (read-only first; no Replit Agent):**
1. `git status` on the host workspace — preserve any uncommitted collector work from the cancelled Agent task before pulling.
2. `git pull --ff-only` this branch (`a17a035..<final commit>` is fast-forward from `e720e1f`).
3. `node bin/cobra.js paper preflight --smoke` — confirms `DATABASE_URL`, CoinGecko / FRED key presence (names only), account revision.
4. `node bin/judge.js inspect --policy config/judge.paper.json` — read-only account identity / revision / positions on the effective database.
5. Only if the recorded migration / binding decision is approved and the account reconciles: the established `npm run paper` lifecycle.

## 6. Test results on the final code (DEV container, UTC 2026-09-12)

Final code = the working tree committed as the delivery commit (only this file's §6 was appended after the run; no code, test,
configuration or fenced document changed after the gate).

| gate | command | result |
|---|---|---|
| focused (post-edit) | `node --test test/sensor-scope.test.js test/paper-runtime.test.js test/paper-preflight-storage.test.js test/paper-cockpit.test.js test/rumor2-authority.test.js test/market-lab-fences.test.js test/social-4f-scope.test.js` under the offline guard | 60 / 60 |
| **full serial suite** | `NODE_OPTIONS="--import=$PWD/test/helpers/offline-guard.mjs" COBRA_OFFLINE_GUARD_LOG=… COBRA_OFFLINE_GUARD_RUN=suite PERSIST_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/cobra_test npm test -- --test-concurrency=1` | **2139 tests, 2139 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo; 412.6 s; npm exit 0** |
| offline network guard | `node tools/offline-gate.mjs <guard log>` | `records 0, unexpected 0` |
| syntax | `node --check` over every tracked `.js/.mjs/.cjs` + the two new files | 479 checked, 0 failed |
| hygiene | trailing whitespace / CRLF on changed files; secret-shaped literals in the diff; `package.json` / `package-lock.json` / `cobra.config.json` | clean / none / unchanged |
| test database isolation | dedicated loopback PostgreSQL 16 cluster, database `cobra_test` only; no `DATABASE_URL` in the environment | confirmed before the run |

Unrun gates: none in DEV. Nothing was run on PROD (no host access). The six integration scenarios of the ticket are covered
by existing suites that passed in this gate: (1) disabled / access-blocked sources and import isolation — `market-lab-fences` A12,
`offline-guard`, `paper-runtime` P-04; (2) enabled source with an isolated response reaching the intended reader — `judge-operational-repair`
OR-1a, `judge-composition` P03/E11, `market-closeout-r07-e2e`, `social-5-durable`; (3) access denial / stall / malformed / burst
containment — `judge-feed-clock` E11-a/b, `rumor2-collector`, `x-*`, `market-lab-transport`; (4) reconnect / shutdown / settlement —
`judge-repair-runtime`, `judge-repair-restart`, `rumor2-eventroot*`, `social-5b-*`; (5) pre-change state reopening — `judge-repair-pg`,
`referee-closeout-matrix` W05–W11, `judge-holdout-truth`; (6) unchanged baseline behaviour with new sources inactive —
`judge-decisions`, `judge-evaluation`, `judge-watch`, `judge-repair-accounting`, `paper-e2e-pg` (the intended corrections are the two
named repairs with their own regressions). These are isolated-harness engineering scenarios, not live-provider or trading proof.

## 7. Consolidated owner actions still requiring approval (nothing purchased, no allowance invented)

| Provider / host | Missing permission or configuration | Where | Cost (verified 2026-09-12) | Blocked functionality |
|---|---|---|---|---|
| Replit host | read-only continuity checks; migration / binding decision record | host shell | — | PAPER start (§5) |
| FRED | `FRED_API_KEY` effective on the host (owner says placed) | Replit Secrets | free | M15 live |
| CoinGecko | plan + billing attestation in `config/market-research.paper.json` (key reportedly placed) | policy file + Secrets | Demo plan: unknown here | M11 live |
| CoinGlass / CryptoQuant / Santiment / Twelve Data / Tokenomist | entitled plan + attestation | owner purchase decision | unknown / metered | M16–M20, N06 |
| Kraken L3 | dedicated data-only key (`create-ws-token`, no trade / withdraw / funding) | Kraken + Secrets | free | M07 (dark) |
| X | `X_BEARER_TOKEN` + `RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS` / `_MONTHLY_POST_READS` / `_ESTIMATED_DAILY_USD` + explicit paid smoke | Secrets | paid per read | S02 |
| SEC / EDGAR | `SERPENT_HTTP_CONTACT`; `RUMOR2_EDGAR_CIKS` (owner's own watchlist) | Secrets / config | free | N02, N04 |
| Meta (Facebook, Instagram) | App Review for organic content | Meta | free | S07, S08 (+ transport build) |
| Reddit / official StockTwits / TikTok / Farcaster | retention / terms / entitlement / transport decisions | owner | unknown | S04–S06, S09 |
| YouTube | `YOUTUBE_API_KEY`, Terms review, query scope; then a build | Google Cloud + owner | free tier 10 000 units/day | S10 |
| Cloudflare Radar | `CLOUDFLARE_API_TOKEN` (free account); placement decision | Cloudflare + owner | free | I01 |
| NOAA / RIPE | placement decision (no consumer tier exists); RIPE prefix / ASN scope | owner | free | I02, I03 |
| Tally | `TALLY_API_KEY` + verified governor mapping; collector build | Tally + owner | unknown | I04 |
| Publishers P01–P09 | decision on the frozen RUMOR-2 rule; licences (Reuters / Bloomberg); terms review for the reachable RSS routes | owner | Reuters / Bloomberg: licensed, unknown; others: unknown | P01–P09 |
