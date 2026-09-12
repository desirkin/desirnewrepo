# COBRA operational repair — 2026-09-12

Baseline commit `2ee8e2252ba6280280098c49d2f83901cdae67c8`, tree `121a624f08e42e30e628c18e414933afbcb96d70`,
branch `claude/cobra-phase-c1-setup-n9yy6r`. `origin/main` and `origin/claude/cobra-phase-c1-setup-n9yy6r` both stood at
that commit and **0 commits existed after it**, so there were no later Replit successors to preserve. Node v22.22.2.

## 0. Mandatory operating restriction — paper trading stays paused

> "I don't want any paper trades until social and financial are up and running."

- **No paper order was created or executed by any work in this pass.** The only live run was `OBSERVE` mode
  (§1.4): memory journal, hypothetical uninitialized account, `entries 0`, `decisions 0` at stop.
- **The $500 paper account was not touched.** It lives in the deployment's PostgreSQL journal. This container has no
  `DATABASE_URL` (see §5 B. STORAGE: `PostgreSQL NOT CONFIGURED`), so no balance, position or history could be read or
  written from here. Nothing was reinitialized, reset, deleted, liquidated, and no transaction was fabricated.
- **`HOST_PAUSE_UNVERIFIED`.** This is a development container, not the Replit host: `0` `REPL*` environment variables are
  present. A changed configuration or this report is not proof that a running process stopped, so the pause on the host is
  **NOT VERIFIED HERE**. The exact remaining host check is in §7.

## 1. Defect 1 — "Judge books: zero received, despite trade messages"

Reported by Replit as a separate operational blocker. Reproduced first, then repaired.

### 1.1 The configured route, traced end to end

`tape/run.js` owns the ONE public Kraken WS v2 socket. It subscribes `instrument`, and per symbol `ticker`, `trade` and
`book` (depth is a subscription parameter, `snapshot: true`). Every accepted socket frame is fanned verbatim into
`execution/feed.js` (`executionFeed.ingest(raw, receiptTs)`), which parses exact numeric lexemes, applies the book, verifies
the Kraken CRC over the top ten levels at exact source precision, and emits ONE detached immutable snapshot per applied
message. `judge/judge.js` subscribes to that feed and counts `counters.books` in `onBook`. `judge/composition.js` admits
candidates into the feed's bounded hot set from the tape universe.

**The Kraken L3 research feed is not on this route.** No module under `judge/`, `execution/`, `watch/` or `tape/` names L3
at all; `market-lab/providers/kraken-l3.js` is reached only through `bin/market-research.js` edge capture with authority
`NONE`. The missing L3 credential therefore cannot explain this failure — and the repaired run below carries book evidence
to the Judge with **zero credentials of any kind**.

### 1.2 Root cause

The venue sends a book **snapshot** only in answer to a subscription. The tape subscribes its whole universe when the
socket opens; the Judge admits a candidate later (first nomination pass is 250 ms after `start()`, and in a cold
deployment the universe file does not exist until the tape has written it and the instrument specs are still loading). The
feed applied book messages only for symbols already in `admitted`, so:

1. the one `type:"snapshot"` for that symbol was **discarded** — it arrived before the admission;
2. every later `type:"update"` hit `if (!b.synced) { counters.ignored += 1; return; }` — **books stay at zero forever**;
3. the same admission gate dropped the `instrument` precision snapshot, so `crcVerified` could never become `true` and
   `BOOK_FRESH` (`setups.js`: CRC-verified book at most 1 s old) could never pass even if a book arrived;
4. the same gate dropped the `trade` subscription acknowledgement, so `coverage()` answered `NOT_SUBSCRIBED` for the whole
   run and `FLOW_21MIN` could never pass.

Trades were unaffected because each trade message is self-contained. That is exactly the reported asymmetry.

### 1.3 Deterministic witness (offline, `execution/feed.js` seam)

Production order — connect, instrument snapshot, one book snapshot, trade acknowledgement, **then** admit the candidate,
then 180 seconds of updates and trades:

| | baseline `2ee8e22` | after repair |
|---|---|---|
| BOOK events delivered to the Judge | **0** | 181 |
| TRADE events delivered | 180 | 180 |
| `counters.ignored` | **180** | 0 (the venue's answer arrived before the next update; the regression test OR-1a forces one update in between and sees exactly 1) |
| `feed.health().usable` | `false` | `true` |
| `feed.health().crcVerified` of the first book | n/a (no book) | `true` |
| `coverage()` | `NOT_SUBSCRIBED` | `continuous: true` |
| book-snapshot requests to the tape | — | 1 |

### 1.4 Live witness (local dev container, real public Kraken WS v2, no credentials, no orders)

The exact `fly.js` composition path — `composeJudge({ mode: 'OBSERVE' })` + `runTape({ executionFeed: run.tapeFeed })` —
with nominations taken from the tape's own universe selection.

**Baseline `2ee8e22`** (3 minutes): feed `books 2262`, **`ignored 21299`**, and for every one of the six Judge candidates
`books: 0`, `synced: false`, `BOOK_FRESH` detail `age nullms`, `tradeCoverage NOT_SUBSCRIBED`. The prepared set also
differed between samples (`ADA ETH HYPE LAPTOP LINK NEAR` → `PUMP SOL SUI TAO UNI USELESS`) — defect 2 in the same run.

**After repair** (5 minutes, 5 samples):

```
judge   books 34231  trades 537  candidates 6  decisions 0  entries 0
feed    epoch 1  connected  admitted 6  books 34231  trades 537  ignored 12
        bookSnapshotsRequested 2  refused 0  seamMissing 0  crcFailures 0
candidates (all five samples, unchanged): ADA/USD ETH/USD HYPE/USD LAPTOP/USD LINK/USD USELESS/USD
  ADA/USD      books 3206  BOOK_FRESH SATISFIED  age 14 ms   coverage continuous  flow 301059 / 1260000 ms
  ETH/USD      books 3873  BOOK_FRESH SATISFIED  age 52 ms   coverage continuous
  HYPE/USD     books 1484  BOOK_FRESH SATISFIED  age 111 ms  coverage continuous
  LAPTOP/USD   books  607  BOOK_FRESH SATISFIED  age 54 ms   coverage continuous
  USELESS/USD  books 1363  BOOK_FRESH SATISFIED  age 708 ms  coverage continuous
  LINK/USD     books  849  BOOK_FRESH "age 239322ms"  — the venue sent no book update for four minutes on this pair;
               a quiet book is correctly REFUSED by the 1 s freshness law, never refreshed by invention
lifecycle START → RECONCILED → RUNNING → PRODUCERS_STOPPED → DRAINED → WRITER_RELEASED
```

Acceptance: valid book evidence reaches the **actual Judge consumer** with symbol, receipt clock and freshness status;
`entries 0` and `decisions 0` — no simulated order was created.

### 1.5 The repair

- `execution/feed.js` — `requestBookSnapshot(symbol, reason)` asks the bound tape for a REAL venue snapshot when an
  admitted symbol has no synchronized book: once at admission for a CARRIED symbol, and again on an ignored update, at
  most once per `bookSnapshotRetryMs` (15 s) per symbol, never while disconnected (the next connect re-subscribes every
  carried symbol with `snapshot: true` and the venue answers by itself). Refusals are counted
  (`bookSnapshotsRefused`, `bookSnapshotSeamMissing`) and named. Public instrument **precision** is remembered for every
  announced pair (two integers each, bounded at 1024, oldest dropped) so a later admission verifies its CRC. A carried
  symbol's trade coverage starts at the **admission clock** — never backdated to an acknowledgement the feed did not
  observe — while a freshly ADOPTED symbol still waits for the venue's own acknowledgement.
- `tape/run.js` — `bookSnapshotRequest(...)` (pure, exported, tested) decides what a request may do and returns exactly
  one `unsubscribe` plus one `subscribe … snapshot: true` **at the pair's own depth**; it refuses an unknown pair, a shed
  pair, a closed socket and a repeat inside `BOOK_SNAPSHOT_MIN_INTERVAL_MS` (15 s). The tape desynchronizes its own book
  for the round trip (the documented resynchronisation path — the same venue snapshot re-establishes it) and writes
  `BOOK_SNAPSHOT_REQUESTED`. No wider venue, no deeper book, no new credential.
- Nothing manufactures depth, reuses stale depth as current, or bypasses a readiness check. `maxBookAgeMs`, the CRC law
  and the `synced` law are unchanged.

## 2. Defect 2 — six candidates alternating every ten seconds

### 2.1 Reproduced against current source

`judge/composition.js` `admitNominations()` at the real cadence (`ticks % 40` ≈ 10 s), 14 nominations that carry **no**
nomination clock — exactly what `readCurrentUniverse()` yields — and 6 preparation slots:

```
t+  0s selected=[ADA ALGO ATOM AVAX BTC DOGE] lost=[]
t+ 10s selected=[DOT ETH FIL LINK LTC NEAR]   lost=[ADA…DOGE PREEMPTED_BY_NEWER_NOMINATION preparedMs 10000]
t+ 20s selected=[ADA ALGO ATOM AVAX BTC DOGE] lost=[DOT…NEAR PREEMPTED_BY_NEWER_NOMINATION preparedMs 10000]
… two disjoint groups alternate forever; max preparation kept = 10000 ms; 12 of 14 assets ever hold a slot
after +1h of CONTINUOUS nomination: lost=[DOT ETH FIL LINK LTC NEAR NOMINATION_EXPIRED]
```

No candidate can ever reach the 61 closed bars or the 21 minutes of continuous flow the setups require.

### 2.2 Root cause

`nominationKnownAtTs` carried two meanings at once. A standing list is re-affirmed every pass, and the composition
re-stamped every not-currently-prepared asset with the **current** clock; the documented newest-first rank then placed
those re-affirmations ahead of the six candidates already warming. The same conflation force-expired a continuously
affirmed nomination at the one-hour TTL measured from its first sighting.

### 2.3 The repair and its result

`judge/readiness.js` `selectPreparation` now reads two clocks: `nominationKnownAtTs` (when THIS nomination became known —
the rank) and the optional `nominationLastSeenTs` (when it was last affirmed — expiry). `judge/composition.js` stamps a
clockless nomination ONCE, at the first pass that observed it, and re-affirms it afterwards (bounded map, 4096 entries,
least-recently-affirmed evicted).

```
t+0s … t+70s selected=[ADA ALGO ATOM AVAX BTC DOGE] lost=[]  (every pass)
after +1h of continuous nomination: unchanged, lost=[]
```

Preserved, and covered by regressions: genuine new nominations still preempt (a new universe member takes a slot and the
loser reports its real `preparedMs`); a source that carries a real nomination clock still ranks by it; legitimate expiry
still removes a nomination that stopped being affirmed; an affirmation clock in the future is refused; capacity limits and
held-position protection are untouched. **No warmup was shortened and no eligibility clause was relaxed.**

## 3. Defect 3 — a failed probe that read as "nothing happened"

`paper/preflight.js` extracted only `{ state, reason, receivedTs, endpointId }` from each provider probe and dropped the
`failure { kind, reasonCode, coverageState, status }` object the probe layer records. A real authentication refusal
therefore printed as `PROBED_FAILED` with `reason: null`:

```
before   FRED  PROBED_FAILED  reason null
after    FRED  PROBED_FAILED  reason CREDENTIAL_MISSING:CREDENTIAL_MISSING
               failure { kind CREDENTIAL_MISSING, reasonCode CREDENTIAL_MISSING, coverageState ACCESS_BLOCKED, status null }
```

`probeFacts()` now carries the failure facts through verbatim, derives a reason when the probe layer left it unset, and
also keeps the POSITIVE receipt (`count`, `requestId`) so a **successful empty response** (`PROBED_OK`, `count 0`) is
distinguishable from a failed collection. The rendered line says so in words.

Audited and found sound: no silent `catch {}` exists in the live collection paths, and `market-lab/contracts.js` already
separates `OBSERVED / GAP / NOT_QUERIED / FAILED / ACCESS_BLOCKED` with reason codes including `NO_TRADES_IN_PERIOD`
(a genuinely empty period) and `RATE_LIMITED` / `ENTITLEMENT_DENIED` / `GEO_RESTRICTED`.

## 4. Source-by-source status — social AND financial

All receipts below are **local dev container** evidence (see §5 for the split). "Delivered to consumer" means the payload
reached the module that consumes it; where the durable consumer is the PostgreSQL event root, local delivery is NOT proven
because this container has no `DATABASE_URL`, and the row says so.

### 4.1 Social

| Source | Implemented | Enabled (effective config) | Credentials / permissions / budget | Real receipt evidence (2026-09-12, local) | Validated + delivered | Freshness / coverage limits | Exact blocker | Next action |
|---|---|---|---|---|---|---|---|---|
| Bluesky (`BLUESKY_OFFICIAL`) | yes — `rumor2/providers/bluesky-official.js` + `social-stream.js` | ON | none (public Jetstream v2) | **yes**: socket open 461 ms, 200 messages in 3.26 s, **200/200** mapped to valid shared-contract observations (112 posts / 88 reposts), 0 skips, provider sequence 25754477318 | parse + contract validation proven; durable settle to the RUMOR2 event root NOT proven locally (no `DATABASE_URL`) | at-least-once with a monotonic `seq` resume cursor; `providerEventTs` + receipt witness per observation | none for collection | prove durable settle on the host (§7) |
| StockTwits — legacy aggregate ear (`RUMINT_STOCKTWITS_AGGREGATE`) | yes — `rumint/` | ON | none (public aggregate endpoint) | not re-probed in this pass | n/a this pass | polite polling cadence; aggregate only, never per-user retention | none known; last host state `ACTIVE_DEGRADED` | re-check on the host with the runbook |
| StockTwits — official API (`STOCKTWITS_OFFICIAL`) | yes, code path complete — `rumor2/social-stocktwits.js` | OFF | entitlement + terms review | none (never requested) | n/a | — | **BLOCKED_TERMS** — entitlement + terms review unresolved | owner decision on the official terms; the aggregate ear runs separately meanwhile |
| X / Twitter (`X_OFFICIAL`) | yes, complete — `rumor2/x-runtime.js`, `x-stream.js` | REQUEST (dark) | `X_BEARER_TOKEN` + 3 explicit budgets (`RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS`, `_MONTHLY_POST_READS`, `_ESTIMATED_DAILY_USD`) + an explicit paid smoke envelope | none — **never spent** | n/a | paid per-read budgets; the stream never opens before the paid smoke | **CREDENTIAL_MISSING** (then `BUDGET_NOT_CONFIGURED`, then `READY_REQUIRES_EXPLICIT_PAID_SMOKE`) | owner supplies the token via the host's secret entry and sets the three budgets; no purchase made here |
| Reddit (`REDDIT_OFFICIAL`) | yes, code path complete — `rumor2/social-reddit.js` | OFF | Reddit OAuth app + data-use classification | none | n/a | — | **BLOCKED_RETENTION** — use classification / approval / retention unresolved | resolve the retention decision first; credentials afterwards |
| Facebook / Meta (`META_PUBLIC`) | descriptors only — `rumor2/social-meta.js` (FOUNDATION_ONLY); `META_REALTIME_TRANSPORT` **NOT_PRESENT** | OFF | Meta app review for organic content | none | n/a | — | **BLOCKED_EXTERNAL_APPROVAL** — app review unresolved | app review is an owner/external step; a live transport must then be built |
| TikTok (`TIKTOK_PUBLIC`) | fixture-only — `rumor2/social-tiktok.js` (FOUNDATION_ONLY); `TIKTOK_REALTIME_TRANSPORT` **NOT_PRESENT** | OFF | no authorized organic route exists | none | n/a | — | **BLOCKED_TERMS** — no authorized organic route | none available without an authorized route; not bypassed |
| Farcaster (`FARCASTER_OFFICIAL`) | access boundary only — `rumor2/social-farcaster-access.js` declares `liveTransport: false`; `FARCASTER_LIVE_TRANSPORT` **NOT_PRESENT** | OFF | Neynar key = configuration only, not entitlement | none | n/a | — | **FOUNDATION_ONLY** — no live transport composed | build the transport, then an entitlement decision |
| YouTube | **NOT_IMPLEMENTED** — zero references anywhere in the repository | — | — | — | — | — | not implemented | a build ticket, if David wants it; no substitute provider was used |

### 4.2 Financial

| Source | Implemented | Enabled | Credentials / budget | Real receipt evidence (2026-09-12, local) | Validated + delivered | Freshness / coverage limits | Blocker | Next action |
|---|---|---|---|---|---|---|---|---|
| Kraken public WS v2 — the exchange market-data feed the Judge uses (`TAPE`) | yes — `tape/run.js` → `execution/feed.js` | ON (always) | none | **yes**: 34 231 CRC-verified book snapshots + 537 trades in 5 minutes, 0 CRC failures | **yes — delivered to the Judge consumer** with symbol, receipt clock, freshness (§1.4) | book ≤ 1 s for a decision; CRC per message; reconnect = new epoch | none | keep the host run under observation |
| `KRAKEN_SPOT` (market-lab) | yes | ON | none | `PROBED_OK`, **622 markets** | coverage matrix | catalog + WS depth bounds | none | — |
| `COINBASE_SPOT` | yes | ON | none | `PROBED_OK` (endpoint reports no record count) | coverage matrix | — | none | — |
| `KRAKEN_DERIVATIVES` | yes | ON | none | `PROBED_OK`, **295 records** | coverage matrix | — | none | — |
| `DERIBIT` | yes | ON | none | `PROBED_OK`, **950 records** | coverage matrix | — | none | — |
| `GECKOTERMINAL` | yes | ON | none | `PROBED_OK`, 1 record | coverage matrix | — | none | — |
| `DEFILLAMA` | yes | ON | none | `PROBED_OK`, 1 record | coverage matrix | — | none | — |
| `COINMETRICS` (community) | yes | ON | none | `PROBED_OK` | coverage matrix | community-tier metrics only | none | — |
| `SETTLED_RECORDS` | yes | ON | none | `NOT_PROBED: NO_NETWORK_SOURCE` (local records by design) | local | — | none | — |
| Kraken Futures Charts (dark, `KRAKEN_CHARTS_DARK`) | yes | ON | none | **yes**: PF_XBTUSD open interest, 60 s, 2 observations, acquisition COMPLETE | sealed EDGE_CAPTURE bundle | authority **NONE** | none | — |
| **FRED** | yes — `market-lab/providers/fred.js` | REQUEST | free `FRED_API_KEY` | **`PROBED_FAILED`** — `CREDENTIAL_MISSING`, coverage `ACCESS_BLOCKED` (named, not blank — §3) | n/a | — | **CREDENTIAL_MISSING** | owner registers the free key and enters it through the host's secret mechanism |
| **CoinGecko** | yes — `market-lab/providers/coingecko.js` | OFF (paper policy) | `COINGECKO_DEMO_API_KEY`; plan attestation absent | unauthenticated public `/ping` reachable (HTTP 200); the **configured** path stays `NOT_PROBED: PROVIDER_DISABLED` | n/a | demo-plan rate limits, unattested | **CREDENTIAL_MISSING + BLOCKED_BUDGET** (no plan attestation) | owner attests the plan + billing in `config/market-research.paper.json`, then re-enable |
| `BYBIT` | yes, code path complete | OFF | none | `NOT_PROBED: PROVIDER_DISABLED`; HTTP 403 from this environment on 2026-09-11 | n/a | — | **BLOCKED_GEOGRAPHY** | none; no unofficial mirror was used |
| `COINGLASS`, `CRYPTOQUANT`, `SANTIMENT`, `TWELVEDATA`, `TOKENOMIST` | yes, all five | OFF | paid; no entitled plan, no attestation | `NOT_PROBED: PROVIDER_DISABLED` | n/a | — | **CREDENTIAL_MISSING + BLOCKED_BUDGET** | an owner purchase decision; **nothing was bought and no spending allowance was invented** |
| **Kraken L3 (reported separately)** | yes — `market-lab/providers/kraken-l3.js` + `kraken-l3-auth.js` + `l3-book.js` | REQUEST | a DEDICATED data-only Kraken key (`create-ws-token`, no trade / withdraw / funding) | probe verdict `CREDENTIAL_MISSING` | n/a | authority **NONE**; EDGE_CAPTURE only | **BLOCKED_NO_SAFE_L3_DATA_KEY** | owner creates a data-only key; **not on the Judge book route and not the cause of defect 1** |
| Official-evidence ears (`KRAKEN_OFFICIAL`, `CFTC_OFFICIAL`, `OFAC_OFFICIAL`) | yes | ON | none | not re-probed in this pass | — | polite polling | none | — |
| `SEC_OFFICIAL` / `EDGAR_OFFICIAL` | yes | ON | none (SEC user-agent contact required) | not probed — gated | — | SEC fair-access user agent | **CONFIG_REQUIRED**: `SERPENT_HTTP_CONTACT`; `RUMOR2_EDGAR_CIKS` whitelist | owner sets the contact string and its own CIK whitelist |
| Gateway status doors (Kraken status, Kraken system, Coinbase status, OKX status) | yes | ON | none | not re-probed in this pass | — | public status pages | none | — |

**Overall readiness is NOT declared.** Requested social sources (Meta, Reddit, TikTok, X, official StockTwits, Farcaster)
and financial sources (FRED, CoinGecko, the five paid providers, Kraken L3) remain blocked exactly as listed. David's
requirement has not been narrowed: every source he named appears above with its own row, including the one that does not
exist (YouTube → NOT_IMPLEMENTED).

## 5. Local evidence vs Replit-host evidence

**Local (this container, 2026-09-12)** — everything in §1–§4: the deterministic witnesses, the two live OBSERVE runs, the
read-only preflight smoke (`paidCalls 0`), the Bluesky Jetstream read, and the test gates in §6. Preflight verdict here is
`NOT_READY_FOR_PAPER` for one core reason: `DATABASE_URL` is not configured in this container.

**Replit host** — NOT re-verified in this pass. `0` `REPL*` variables are visible, so nothing about the host's running
processes, its `DATABASE_URL`, its paper account, or its live sensor states could be observed or changed from here. Every
host claim in §4 is marked "not re-probed in this pass" rather than assumed.

## 6. Gates

Commands and counters are recorded in §6 of the delivery report accompanying this evidence file; regressions for the three
repaired defects live in `test/judge-operational-repair.test.js` (6 tests: OR-1a book snapshot delivery, OR-1b bounded and
honest requests, OR-1c coverage clocks, OR-1d the tape seam, OR-2a the composition, OR-2b the two nomination clocks) and
in the updated `docs/sensor-inventory.paper.json` derivation fence. All six fail on the baseline source and pass on the
repaired source.

## 7. Replit handoff

1. **Verify the paper pause on the host (this is the `HOST_PAUSE_UNVERIFIED` item).** On the Replit host run, in order:
   - `ps -ef | grep -E "npm run paper|node (fly|bin/cobra)\.js|bin/judge\.js run-paper" | grep -v grep` — **expect no
     matching process.**
   - `node bin/judge.js inspect --policy config/judge.paper.json` — read `account.journal`: `positions` should be `0` and
     `restrictions` should not contain a new entry. This is read-only.
   - `cat $COBRA_DATA_DIR/execution/projection.json | head -40` — check `ts` is old (not advancing) and
     `exposure.openPositions` is `0`. A live projection timestamp means a process is still running.
   - If a paper process IS running, stop it the way the deployment starts it (stop the Replit deployment / `npm run paper`
     owner), then repeat the first check. Do not reinitialize the account.
2. `git pull` this branch and run `node bin/cobra.js paper preflight --smoke` on the host. Expect the same provider
   receipts plus a configured `DATABASE_URL`; the FRED row should now name `CREDENTIAL_MISSING` instead of a blank reason.
3. When David wants the Judge book route observed on the host without any paper order: run the OBSERVE path, not
   `run-paper`. Books should appear within a second of the first candidate admission, and `bookSnapshotsRequested` should
   be small (one per admission), with `bookSnapshotsRefused 0`.
4. Credentials still needed, all through Replit Secrets (never in code, commits, logs or chat): `FRED_API_KEY` (free),
   `X_BEARER_TOKEN` + the three `RUMOR2_SOCIAL_X_MAX_*` budgets, `SERPENT_HTTP_CONTACT`, `RUMOR2_EDGAR_CIKS`, and — only
   if David decides to — a dedicated data-only Kraken L3 key. Nothing was purchased and no budget was invented here.
5. `COINGECKO_DEMO_API_KEY` and `FRED_API_KEY` values that were removed from `.replit` in commit `397549d` remain in git
   history and **still need rotation by their owners**.
6. Paper trading is paused at delivery and must stay paused until the social and financial sources above are up.
