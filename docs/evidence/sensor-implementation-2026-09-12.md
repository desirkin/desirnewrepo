# Sensor implementation — corrective delivery (2026-09-12)

Corrective handoff: "COMPLETE THE MISSING SENSOR IMPLEMENTATIONS". The prior delivery (`6e92db3`) mapped all 56 owner
rows but left P01–P09, I01–I03 and S10 as `NOT_PRESENT`. This pass builds the collectors, their configuration, composition,
readers, tests and evidence; the rows that remain unbuilt are named as such. HEAD before this pass: `6e92db3` (inspected;
no reset; no cancelled-Agent work existed in the tree to recover — the working tree was clean at `6e92db3`).

**Overall result: INCOMPLETE** — two named implementations (P01 Reuters, P02 Bloomberg) cannot be completed without the
owner's licensed distribution interface (external prerequisite; no public route exists; no adapter is invented around an
unknown endpoint). Everything else in the requested scope that has a documented eligible route is implemented and tested.

## A. Counts

| Category | Rows |
| --- | --- |
| Complete, tested code (this pass) | 11 — P03 CNBC, P04 FT, P05 CoinDesk, P06 The Block, P07 Cointelegraph, P08 Decrypt, P09 Google News (aggregator), I01 Cloudflare Radar, I02 NOAA SWPC (experimental), I03 RIPE RIS, S10 YouTube |
| Missing / partial | 2 — P01 Reuters, P02 Bloomberg (`LICENSED_INTERFACE_REQUIRED`; registry names the prerequisite; collector makes zero requests) |
| Implemented, LIVE BLOCKED from this environment | 3 — I01 Cloudflare Radar (no `CLOUDFLARE_API_TOKEN` here; denied path observed: HTTP 400 code 9106), S10 YouTube (no `YOUTUBE_API_KEY` here; denied path observed: HTTP 403 unregistered caller, HTTP 400 malformed key), P04 FT (HTTP 403 to the Node fetch client from this environment while curl answers 301→200: anti-bot client gate; unverified on the host) |
| Production verified (live read through the ACTUAL collector code, this environment) | 8 — P03 CNBC (200, 30 admitted), P05 CoinDesk (25), P06 The Block (20), P07 Cointelegraph (30), P08 Decrypt (35), P09 Google News (100, per-item publishers resolved), I02 NOAA (58 admitted, 4 forecast entries excluded, 0 rejected), I03 RIPE RIS (1 of 1 with the documented example resource `1.1.1.0/24`; the PAPER watch list stays `CONFIG_REQUIRED` until the owner names `INFRA_RIPE_RESOURCES`) |

`docs/sensor-inventory.paper.json` (regenerated): 64 rows — OPERATIONAL_PUBLIC 36, OPERATIONAL_CREDENTIAL_GATED 13,
IMPLEMENTED_NOT_LIVE_SMOKED 2 (Cloudflare Radar, YouTube), CODE_PATH_COMPLETE_EXTERNAL_ACCESS_BLOCKED 4 (incl. FT),
FOUNDATION_ONLY 4, NOT_PRESENT 5 (Reuters, Bloomberg, Farcaster live transport, Meta realtime transport, TikTok realtime
transport). Scope rows whose inventory rows are ALL `NOT_PRESENT`: `P01`, `P02` only (`test/sensor-scope.test.js`).

## B. Architecture decision (stated, not hidden)

The RUMOR-2 core is frozen (`doctrine/RUMOR2.md` "RUMOR-2 IS FROZEN"; `test/rumor2-authority.test.js` bans publisher
tokens in the core and pins exactly one live wiring point) and the RUMOR-2 SOCIAL layer is sealed (`rumor2/social.js`,
providers and settle validators pinned byte-identical at `9b1b405` / `9c17372`; `validateSocialEvent` refuses any provider
not in `rumor2/social-registry.js`). The handoff forbids broadening a closed validator or altering a sealed bundle. So:

- Publishers (P03–P09) live in a SEPARATE, explicitly classified tier `press/` (inventory group `PUBLISHER_NEWS`, snapshot
  group `PUBLISHER_NEWS`), never in the official registry; they reuse only the pure parser `parseFeed` from `rumor2/feed.js`.
- Infrastructure (I01–I03) live in `infra/` (inventory / snapshot group `INFRASTRUCTURE`), with no trading authority.
- YouTube (S10) lives in `video/` — a social-VIDEO observation tier classified in the SOCIAL inventory / snapshot group,
  metadata only, NOT a RUMOR-2 social provider (the sealed registry gained no entry; joining it is an owner doctrine
  change). This is the one place the delivery deliberately does not put the collector inside `rumor2/`; the reason is the
  seal, and the decision is recorded here and in `paper/inventory.js`.
- The outdated doctrine statement ("No Reuters/Bloomberg/… any publisher") is amended precisely in `doctrine/RUMOR2.md`
  (old rule unchanged for the core / new scope in a separate tier / unchanged authority). No safety assertion was deleted.

## C. Evidence per repaired capability

Common law (all three tiers): dark unless the paper profile derives the enable; zero network before the gate holds; polite
cadence with floors; shared bounded HTTPS transport `lib/bounded-fetch.js` (pinned host, closed redirect set, byte / time
bounds, Retry-After surfaced); one observation appended to JSONL BEFORE the checkpoint advances; exponential backoff capped
at 1 h; retention cap 50 MiB; status file rewritten after every poll; SIGINT / SIGTERM stop; `authority: NONE`; the reader
re-validates every reopened record through the closed shape (exact keys, re-derived identity).

### P03–P09 publishers — `press/`

| Aspect | Evidence |
| --- | --- |
| Collector + entry point | `press/collector.js` `startPress({ env, dataDir, fetchImpl, clock, timers, signals })` → handle `{ stop, pollOnce(id), status(), sourceIds }` |
| Registry | `press/registry.js` `PRESS_SOURCES` (9 rows; kind PUBLISHER / AGGREGATOR; route RSS / LICENSED_INTERFACE_REQUIRED; dated docs; `pressRegistryError`) |
| Configuration | `PRESS_ENABLED`, `PRESS_SOURCES` derived by `paper/profile.js profileEnvironment()` from `config/paper-runtime.json` group `publisherNews` (ON: CoinDesk, The Block, Cointelegraph, Decrypt; OFF with reasons: FT `BLOCKED_TERMS`, CNBC `BLOCKED_TERMS`, Google News `BLOCKED_TERMS`, Reuters / Bloomberg `BLOCKED_EXTERNAL_APPROVAL`); `SERPENT_HTTP_CONTACT` in the user-agent when set |
| Start / stop callers | `fly.js` `startPress();` after `startGateway()`; stop via the handle / process signals |
| Validation / mapping | `press/parse.js` `itemToObservation` (headline / summary / link / publisher clock; identity `sha256(sourceId\|itemKey)`; future-dated skipped; aggregator per-item `<source>` publisher via `extractItemSources`), `pressObservationError` (exact keys, re-derived id, `bodyFetched:false`, authority NONE) |
| Settlement / checkpoint | `<data>/press/observations.jsonl` (append) then `<data>/press/checkpoint-<ID>.json` (etag / last-modified / seen ids ≤ 500 / lastSuccessTs); status `<data>/press/status.json` (`press-status-1`) |
| Reader / consumer | `press/reader.js` `readPressStatus`, `readPressObservations({ sourceId, sinceReceiptTs, limit })`; `paper/readiness.js` rows `PRESS_<ID>` (group `PUBLISHER_NEWS`); CLI `cobra press status \| tail`; `paper/inventory.js` rows |
| Tests | `test/press.test.js` PRESS-1…5 (registry law; mapping; composed collector: valid feed → observations, 304, 429 + Retry-After floor, HTML → PARSE_FAILED, empty feed, licensed zero calls, unselected zero calls, containment, restart continuity, same-handle; reader corrupt handling; snapshot states; composition + authority fences) |
| Live receipts (through the collector) | CoinDesk OBSERVED 25 / 625 ms; The Block 20 / 350 ms; Cointelegraph 30 / 189 ms; Decrypt 35 / 258 ms; Google News 100 (publishers e.g. CryptoPotato resolved, transport `GOOGLE_NEWS_AGGREGATOR`); CNBC 30 / 226 ms; FT FAILED HTTP 403 (curl on the same URL: 301→200); Reuters `LICENSED_INTERFACE_REQUIRED`, 0 requests |

### I01–I03 infrastructure — `infra/`

| Aspect | Evidence |
| --- | --- |
| Collector + entry point | `infra/collector.js` `startInfra({...})` → `{ stop, pollOnce(id), status(), sourceIds }` |
| Registry | `infra/registry.js` `INFRA_SOURCES`: `NOAA_SWPC` (experimental, KP + SCALES products, 600 s), `RIPE_RIS` (configEnv `INFRA_RIPE_RESOURCES`, ≤ 16 resources, 900 s), `CLOUDFLARE_RADAR` (credentialEnv `CLOUDFLARE_API_TOKEN`, scope envs `INFRA_CLOUDFLARE_ASN` / `_PREFIX` / `_DATE_RANGE`, 3600 s); dated docs |
| Configuration | `INFRA_OBS_ENABLED`, `INFRA_SOURCES` derived from profile group `infrastructure` (NOAA ON; RIPE REQUEST gate `INFRA_RIPE_RESOURCES`; Cloudflare REQUEST credentialEnv); `.env.paper.example` documents the names; `CLOUDFLARE_API_TOKEN` added to `SECRET_ENV_NAMES` (never derived) |
| Start / stop callers | `fly.js` `startInfra();` after `startPress()` |
| Validation / mapping | `infra/parse.js`: `noaaKpObservations` (UTC no-zone clocks; Kp 0..9; non-negative integer counts; future rejected), `noaaScalesObservation` (current entry "0" only; forecasts excluded and counted), `ripeRoutingStatusObservation` (day precision; integer peer counts; a supported status without data is no measurement), `cloudflareBgpTimeseriesObservation` (numeric strings → numbers; invalid points dropped; error envelope → code surfaced, no observation); `infraObservationError` (re-derived id + kind value laws) |
| Gates | `CONFIG_REQUIRED` (RIPE without resources) and `CREDENTIAL_REQUIRED` (Cloudflare without token) make ZERO requests; token only in the `authorization` header; token-refused codes 10000 / 9106 / 9109 park the source 1 h as `CREDENTIAL_REQUIRED` |
| Settlement / checkpoint | `<data>/infra/observations.jsonl`, `checkpoint-<ID>.json`, `status.json` (`infra-status-1`) |
| Reader / consumer | `infra/reader.js` `readInfraStatus`, `readInfraObservations({ sourceId, kind, sinceReceiptTs, limit })`; snapshot rows `INFRA_<ID>` (group `INFRASTRUCTURE`, NOAA named EXPERIMENTAL); CLI `cobra infra status \| tail`; inventory rows `NOAA_SWPC_SPACE_WEATHER`, `RIPE_RIS_BGP`, `CLOUDFLARE_RADAR` |
| Tests | `test/infra.test.js` INFRA-1…5 (registry law; parsers incl. rejections / exclusions / envelopes; composed collector: gates zero calls, header-only token, partial coverage, refused token parks, containment, restart; reader + profile + snapshot; composition + authority fences, no order verbs) |
| Live receipts (through the collector) | NOAA OBSERVED 58 admitted (2 requests, 4 forecasts excluded, 0 rejected), 216 ms; RIPE `1.1.1.0/24` OBSERVED 1 (documented example, one-off), 1200 ms; Cloudflare `CREDENTIAL_REQUIRED`, 0 requests |

### S10 YouTube — `video/`

| Aspect | Evidence |
| --- | --- |
| Collector + entry point | `video/collector.js` `startVideo({...})` → `{ stop, pollOnce(), status(), gate(), intervalMs }` |
| Registry | `video/registry.js` `YOUTUBE_DATA_API` (host `www.googleapis.com`; endpoints search / videos; quota facts read 2026-09-12: default 100 search.list calls / day + 10,000 units for other endpoints, videos.list 1 unit; API-key request header documented; terms URL) |
| Configuration | `SOCIAL_VIDEO_ENABLED` derived from profile `social.YOUTUBE_DATA_API` (REQUEST); gate `videoGate`: `YOUTUBE_API_KEY` → `SOCIAL_VIDEO_YOUTUBE_QUERIES` (owner's own, ≤ 8) → `SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES` (explicit; no default budget is ever read); `YOUTUBE_API_KEY` added to `SECRET_ENV_NAMES`; `.env.paper.example` documents the names |
| Start / stop callers | `fly.js` `startVideo();` after `startInfra()` |
| Validation / mapping | `video/parse.js` `searchItemsToObservations` (title / description snippet / channel / publish clock / live state; future-dated and malformed rejected; error envelopes → code + reason, no observation), `videoStatisticsById` (public counters), `videoObservationError` (exact keys: captions / transcripts / comments / media refused; re-derived id; `transcript:false`) |
| Budget governor | one search per poll in query rotation; interval = max(900 s, day / budget); budget spent BEFORE the request leaves; counted per America/Los_Angeles accounting day in the checkpoint (survives restarts); `BUDGET_STOPPED` at the cap; `QUOTA_EXCEEDED` parks until the next day; `CREDENTIAL_REFUSED` parks 1 h; Retry-After floored 60 s; key redacted from every error |
| Settlement / checkpoint | `<data>/video/observations.jsonl`, `checkpoint-YOUTUBE_DATA_API.json`, `status.json` (`video-status-1`) |
| Reader / consumer | `video/reader.js` `readVideoStatus`, `readVideoObservations({ query, sinceReceiptTs, limit })`; snapshot row `YOUTUBE_DATA_API` (group `SOCIAL`); CLI `cobra video status \| tail`; inventory row `YOUTUBE_DATA_API` (`IMPLEMENTED_NOT_LIVE_SMOKED`) |
| Tests | `test/video.test.js` VIDEO-1…5 (registry + gate order + interval floor + accounting day; mapping incl. refusals; composed collector: dark, gated zero calls, valid page + counters, header-only key, redaction, budget across restart, BUDGET_STOPPED, quotaExceeded, refused key, 429, malformed, same-handle; reader + profile + snapshot; composition fences incl. "sealed social registry gained no provider") |
| Live denied path (this environment) | no key → gate `CREDENTIAL_MISSING`, poll `null`, 0 requests; malformed key in the header → `CREDENTIAL_REFUSED` "provider error 400: API key not valid", key not present in the status file; unauthenticated → HTTP 403 "unregistered callers" (curl) |

## D. Rows not completed, with the external prerequisite

- **P01 Reuters / P02 Bloomberg — INCOMPLETE.** No public feed (reuters.com/tools/rss HTTP 401; bloomberg.com/feeds HTTP 403
  anti-bot; 2026-09-12). Only the owner's licensed distribution agreement can supply the interface (Reuters Connect;
  Bloomberg Terminal / B-PIPE / Enterprise). `press/registry.js` names the prerequisite; `startPress` answers
  `LICENSED_INTERFACE_REQUIRED` with zero requests. No adapter was invented around an unknown endpoint.
- **S04 StockTwits official** — no eligible route: self-service registration paused, entitlement + terms unresolved
  (`AVAILABLE_REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW`). Unchanged; the legacy aggregate route (S03) stays operational.
- **S05 Reddit** — the documented Data API route needs Reddit's approval and use classification; own-account / ads /
  academic routes are not public intel (per the handoff). Unchanged (`BLOCKED_RETENTION`).
- **S06 TikTok** — `NOT_AUTHORIZED` (research route needs an eligible institutional affiliation). Unchanged.
- **S07 / S08 Meta (Facebook / Instagram)** — Page Public Content Access needs Meta App Review + Business Verification.
  Unchanged (`BLOCKED_EXTERNAL_APPROVAL`).
- **S09 Farcaster / Neynar** — the only documented route is Neynar's keyed API (`NEYNAR_API_KEY`; sign-up = a new
  subscription, refused by the handoff's no-new-subscriptions rule) and a live transport would have to join the sealed
  RUMOR-2 social runtime. The mapper foundation stays; `FARCASTER_LIVE_TRANSPORT` stays `NOT_PRESENT`.

## E. M06 and M10, explicitly

- **M06 Kraken Futures Charts** → `KRAKEN_CHARTS_DARK`: `OPERATIONAL_PUBLIC`, profile ON, `DARK_RESEARCH` (EDGE_CAPTURE
  only; never Socrates / Judge / Watch / execution). Live receipt 2026-09-12: PF_XBTUSD open-interest 60 s, 2 observations,
  acquisition COMPLETE. Unchanged by this pass.
- **M10 Bybit** → `BYBIT`: `CODE_PATH_COMPLETE_EXTERNAL_ACCESS_BLOCKED`, profile OFF (`BLOCKED_GEOGRAPHY`; HTTP 403 from
  this environment on 2026-09-11; NOT_PROBED on 2026-09-12 because the paper policy disables it). Unchanged by this pass.

## F. Preserved repairs and fences

`a17a035` (operational repair) and `6e92db3` (scope accounting) are intact: no file under `judge/`, `execution/`, `watch/`,
`tape/` or `rumor2/` changed (FROZEN_FOR_PAPER digests and the 9c17372 / 9b1b405 pins hold). The only fence edits: the
`press/collector.js → rumor2/feed.js parseFeed` allowance in `test/rumor2-authority.test.js` (documented; the "exactly one
LIVE wiring point" rule and every token ban stay), the `NOT_PRESENT` sets in `test/paper-runtime.test.js` P-03 and
`test/sensor-scope.test.js` (replaced by implementations, never deleted), and the profile / snapshot group lists that now
include `publisherNews` / `PUBLISHER_NEWS`. No test was skipped, disabled or quarantined; no secret value appears in any
code, fixture, report or committed file.

## G. Code changed in this pass

New: `press/{registry,parse,collector,reader}.js`, `infra/{registry,parse,collector,reader}.js`,
`video/{registry,parse,collector,reader}.js`, `lib/bounded-fetch.js`, `test/press.test.js`, `test/infra.test.js`,
`test/video.test.js`, this document. Modified: `fly.js` (three `start*()` calls after the gateway), `paper/profile.js`
(`publisherNews` group; derived `PRESS_*`, `INFRA_*`, `SOCIAL_VIDEO_ENABLED`; two secret NAMES), `config/paper-runtime.json`
(infrastructure + publisherNews + social rows), `paper/readiness.js` (PUBLISHER_NEWS group, PRESS_/INFRA_/YOUTUBE rows),
`paper/inventory.js` (implemented rows replace NOT_PRESENT), `bin/cobra.js` (`press` / `infra` / `video` readers),
`.env.paper.example`, `docs/sensor-inventory.paper.json` (regenerated), `docs/PAPER-RUNBOOK.md`, `doctrine/RUMOR2.md`
(scope note), `test/rumor2-authority.test.js`, `test/paper-runtime.test.js`, `test/sensor-scope.test.js`.

## H. Gates on the final code

Run after the last relevant code change (isolated PostgreSQL 16 on 127.0.0.1:55432, `PERSIST_TEST_DATABASE_URL`;
`NODE_OPTIONS=--import=test/helpers/offline-guard.mjs`, `COBRA_OFFLINE_GUARD_RUN=suite`; `npm test -- --test-concurrency=1`):

| Gate | Result |
| --- | --- |
| Full serial suite | tests 2154, pass 2154, fail 0, cancelled 0, skipped 0, todo 0 (414.8 s), npm exit 0 |
| Offline guard (`node tools/offline-gate.mjs`) | records 0, unexpected 0 |
| New suites inside it | `test/press.test.js` 5, `test/infra.test.js` 5, `test/video.test.js` 5 — all pass |
| Fences re-run | rumor2-authority, social-4f-scope, social-4e-foundation, market-lab-fences, market-kraken-edge-fences, judge-arming, judge-focused-fences, paper-runtime (P-01…P-08), sensor-scope, paper-cockpit — all pass |

Paper trading stays PAUSED (the owner's standing instruction); this pass started no paper run and placed no order.
