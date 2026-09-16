# PAPER-FLIP — turning the data-only deployment into the PAPER runtime

This is the one page for the flip: what changes on the run-line, which secret **NAMES**
must be present (never their values), the boot lines a healthy PAPER start prints, and
what "green on the page" looks like. The general paper-day readiness checklist lives in
`READINESS.md`; this page is only the difference between the two runtimes and the exact
sequence a live flip produces. Nothing here flips anything — PAPER is a decision David
makes by changing the run command; the composition refuses to trade regardless (real
money, live orders and withdraw/funding are DISABLED by the forced authority, always).

## 1. The run-line change

| | Data-only (today) | PAPER (the flip) |
| --- | --- | --- |
| Run command | `npm run data:only-ui` | `npm run paper` (`node bin/cobra.js paper run`) |
| Composition | observation only — collectors, wide-eye, market-research owner, cockpit | the same observation spine **plus** the Judge (decisions), the Watch (post-entry supervision) and the paper execution journal |
| `COBRA_PROFILE` | unset | `config/paper-runtime.json` (the one profile the runtime, CLI and cockpit read — a **path**, not a bare name) |
| Journal authority | none | PostgreSQL (`DATABASE_URL`) — the account and its append-only event journal |

The paper composition is exactly `data-only + { judge/, execution/, watch/ }`. That diff
is fenced from both sides in `test/paper-vs-data-only-composition.test.js`.

## 2. Secret NAMES (presence only — never a value here or in any log)

Required for PAPER:
- `DATABASE_URL` — the PostgreSQL journal authority (account + execution events). Not a provider key.
- `SERPENT_CONTROL_PASSWORD` — gates owner intent (the one-time account init) and the cockpit KILL / CAGE / CLEAR controls. Without it, `init-paper` refuses (`CONTROL_AUTH_UNCONFIGURED`) and the cockpit controls stay observe-only.

Optional — each only **widens** the sense set, none flips its own budget/plan gate on, and a preflight reports each present/absent by NAME:
- `COINGECKO_DEMO_API_KEY` (CoinGecko demo quota) · `SERPENT_HTTP_CONTACT` (SEC / EDGAR user-agent law) · `RUMOR2_EDGAR_CIKS` (your own EDGAR CIK whitelist).
- Paid providers, off until plan + budget are attested in `config/market-research.paper.json`: `COINGLASS_API_KEY`, `CRYPTOQUANT_API_KEY`, `SANTIMENT_API_KEY`, `TOKENOMIST_API_KEY`.
- `ANTHROPIC_API_KEY` **plus** the durable SOCRATES toggle **plus** `SERPENT_SOCRATES_DAILY_USD` and the `model.*` USD caps in the policy — the model is never enabled from a key alone.
- `X_BEARER_TOKEN` **plus** `RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS`, `RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS`, `RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD`, then an explicit paid smoke envelope.
- `KRAKEN_L3_DATA_API_KEY` / `KRAKEN_L3_DATA_API_SECRET` — a DEDICATED data-only key (create-ws-token only; never trade / withdraw / funding, never an execution key) for the dark L3 capture.
- `SERPENT_OBJECT_STORE_PROVIDER` (+ its `SERPENT_OBJECT_STORE_*` settings) — durable object-store backing for the bulk streams.

`DATABASE_URL` is the journal authority only; it is never handed to a market provider (no `DATABASE_URL` leak into the research owner or any transport).

## 3. One-time owner init (before the first PAPER launch)

```
node bin/judge.js init-paper --policy config/judge.paper.json --owner-stdin true
```

Requires `SERPENT_CONTROL_PASSWORD` set and the password on stdin (owner intent). It
creates the `paper-reference-usd500` account at $500 and refuses to reset an existing one.
It applies migrations 1–10 and prints `durable core connected (schema 10)`.

## 4. Preflight (read-only, zero paid calls)

```
npm run paper:preflight        # cobra paper preflight
```

The only `CORE_RUNTIME_BLOCKER` before init is the uninitialized account. Everything else
is `EXTERNAL_OPTIONAL_SENSE_BLOCKER` / `PAID_SENSE_NOT_AUTHORIZED` / `DARK_RESEARCH_BLOCKER`
— reported, never blocking a paper run. After `init-paper` the account line reads
initialized and `L. FINAL` clears its core blocker.

## 5. Expected boot lines (a healthy `npm run paper` start, in order)

```
SERPENT PAPER PROFILE paper (serpent-paper-profile-1) — JUDGE_MODE PAPER
  REAL MONEY: DISABLED / LIVE ORDERS: DISABLED / WITHDRAW/FUNDING: DISABLED
PROFILE config/paper-runtime.json — JUDGE_MODE PAPER · allowPrivate false · allowOrders false
[boot bN] PERSISTENCE: durable core connected (schema 10); restore complete; pump running
CONTROL AUTH: CONFIGURED
MEMORY-0 dark mirror open …
EARS ON — rumint … / GATEWAY watching the doors … / [press] watching 4 publisher feed(s) …
COBRA SHELL — http://localhost:<port>  (cockpit; controls can only remove permission to trade)
WIDE EYE open — surveying <N> USD pairs …
COLLECTOR OWNERSHIP: pid <p> owns the PAPER collector additions …
broad Kraken writer owned by pid <p> (boot <uuid>)
MARKET RESEARCH active (research only, authority NONE) …
JUDGE active: PAPER account paper-reference-usd500 mode PAPER (NOT REAL MONEY); startup {…}
LEARNING DATA CLOCK active (dormant, authority NONE) …
RUMOR2 RUMOR-2A2 — dark multi-source ear armed …
universe (startup): <N> pairs via kraken REST AssetPairs+Ticker
tape starting: <N> pairs …
connected wss://ws.kraken.com/v2
TAPE LIVE
```

The two lines that prove the flip took: **`JUDGE active: PAPER account paper-reference-usd500
mode PAPER`** (the decision engine composed and started) and **`TAPE LIVE`** (the execution
feed is receiving the live Kraken tape). The PERSISTENCE line reads `schema 10` with **no
`schema repair` line** on a healthy boot (PUBLISH-FIX-6 — a repeated boot no longer
re-applies the store-anchor DDL).

### Expected boot noise (not a blocker)

`KRAKEN_DERIVATIVES: record rejected (observation.quality: … PROVISIONAL … UNCOMMITTED_BAR
/ coverage interval malformed)` lines are the market-research owner's derivatives-analytics
quality gate refusing in-progress buckets; they are research-owner observations, hold zero
Judge / Watch / execution authority, and do not gate the paper run.

## 6. Green on the page

Open the cockpit (the URL the boot prints) and the SENSES sheet:
- **JUDGE** row `ACTIVE` — PAPER, NOT REAL MONEY.
- **The Watch** row `ACTIVE` (follows the Judge composition; flat until a position exists).
- **TAPE** `LIVE`, the **UNIVERSE** tile `<total> · <live> LIVE`, **WIDE EYE** scanning.
- Optional / paid senses show `BLOCKED_CREDENTIAL` / `DISABLED_BY_PAPER_POLICY` until their
  NAMES and plan/budget are supplied — expected, never a paper-run blocker.

The default answer is always NO TRADE: a green PAPER page means the system is observing and
deciding under paper authority, not that it is trading real money — it cannot.
