# News connections — 2026-09-12

The news collector can now run independently of paper trading. No account,
paper runtime, tape, order gateway, paid API, or LLM is started by this command:

```sh
node tools/news-setup.mjs --once
```

This selects only `ON` RSS rows from `config/paper-runtime.json` (or the existing
`COBRA_PROFILE` override), makes one bounded pass, saves ordinary PRESS records
under the configured data directory, prints each source's result, and exits.
Exit status 1 means one or more selected sources failed or no sources are ON;
partial success is still saved and is never reported as all sources working.
The command does not read or write API keys. These public RSS routes do not need
keys. `COBRA_DATA_DIR` and optional public `SERPENT_HTTP_CONTACT` are supported.

For continuous **news only** collection, use:

```sh
node tools/news-setup.mjs --watch
```

It makes the initial pass, then uses the existing 600-second per-source cadence,
conditional GETs, timeout/byte limits, rate-limit backoff, item deduplication and
50 MiB observation cap. Stop with Ctrl-C. A shared PRESS writer lock prevents
this command and `fly.js` from writing the same news files concurrently. Normal
stop and startup failure release the lock. A lock left by a killed process is
not automatically stolen: establish that its process has stopped before removal.
Existing `node bin/cobra.js press status` and `press tail` commands read the data.
Paper trading remains stopped and the existing CAGE setting is untouched.

## All publisher paths checked

These are development-host readings, not a claim that Replit is running them.
Earlier evidence remains historical; a later timeout does not establish permanent
provider unavailability. No linked article body was fetched.

| Publisher | Implemented path | Fresh bounded read on 2026-09-12 UTC | Setup still required |
|---|---|---|---|
| CoinDesk | Public RSS, profile ON | 17:08:01 timeout at 10 seconds; independent composed run also timed out at 17:11:56 | Retry from Replit with the new one-pass command; no key |
| The Block | Public RSS, profile ON | 17:08:06 HTTP 200, 20 parsed items; composed run admitted 20 at 17:12:01 | Run the news-only process on Replit; no key |
| Cointelegraph | Public RSS, profile ON | 17:08:12 HTTP 200, 30 parsed items; composed run admitted 30 at 17:12:06 | Run the news-only process on Replit; no key |
| Decrypt | Public RSS, profile ON | 17:08:18 HTTP 200, 35 parsed items; composed run admitted 35 at 17:12:11 | Run the news-only process on Replit; no key |
| CNBC | Public RSS adapter, profile OFF | 17:07:41 HTTP 403 | Existing publisher terms gate and working host access; no key for this RSS route |
| Financial Times | Public RSS adapter, profile OFF | 17:07:51 timeout at 10 seconds | Existing publisher terms gate and working host access; no key for this RSS route |
| Google News | Aggregator RSS adapter, profile OFF | 17:11:23 HTTP 200, 100 parsed items | Existing RSS terms gate; preserve actual per-item publisher separately from Google transport |
| Reuters | No licensed client composed, profile OFF | No licensed request attempted | Actual licensed distribution contract and documented interface/payload |
| Bloomberg | No licensed client composed, profile OFF | No licensed request attempted | Actual licensed distribution contract and documented interface/payload |
| CNN | Explicit blocked entry added, profile OFF | Legacy top-stories and money RSS each returned HTTP 502; former RSS index redirected to homepage | Working officially documented public feed, or actual licensed CNN Newsource interface/payload |

The composed one-pass run finished at **2026-09-12T17:12:11.750Z** with three
observed sources, one timed-out source, 85 admitted headline observations, and
zero paid API calls. It ran in an isolated temporary verification directory,
with no continuous collector left running. Missing prerequisites on the six
unselected sources remain visible in its report.

Primary routes used by the existing adapters:

- [CoinDesk RSS](https://www.coindesk.com/arc/outboundfeeds/rss/)
- [The Block RSS](https://www.theblock.co/rss.xml)
- [Cointelegraph RSS](https://cointelegraph.com/rss)
- [Decrypt RSS](https://decrypt.co/feed)
- [CNBC Top News RSS](https://www.cnbc.com/id/100003114/device/rss/rss.html)
- [Financial Times RSS](https://www.ft.com/rss/home)
- [Google News RSS](https://news.google.com/rss/search?q=bitcoin%20OR%20crypto%20OR%20ethereum&hl=en-US&gl=US&ceid=US:en)

[CNN Newsource](https://www.cnnnewsource.com/) documents licensed syndication of
text, photos and video. It does not supply a public API contract or self-service
key on that page. The [CNN Business page](https://www.cnn.com/business) was also
attempted through web lookup, which refused access under robots.txt. An on-demand
LLM reading of CNN business news was therefore **not verified** in this session.
No reader, account or scrape-based substitute is presented as a working CNN feed.

## Verification

14 focused tests passed, 0 failed, 0 skipped, under the offline guard:

```sh
node --import ./test/helpers/offline-guard.mjs --test --test-concurrency=1 test/news-setup.test.mjs test/press.test.js test/sensor-scope.test.js
```

Coverage includes exactly one request per selected source, credentials excluded,
OFF/licensed sources never requested, durable observation composition, partial
failure reporting, a competing writer refused before HTTP, watch-mode shutdown,
startup-failure and malformed-history lock cleanup, lock acquisition before
checkpoint/history hydration, and the existing publisher authority fences.
