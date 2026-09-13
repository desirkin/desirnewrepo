# PAPER RUNTIME — BOUNDED SOAK AND CLEAN EXIT (2026-09-11)

Environment: the closeout container (loopback PostgreSQL 16 on a dedicated `cobra_soak` database, real public network
through the environment proxy, no credential of any kind in the environment). Each soak: fresh data dir, fresh
database, `npm run paper:preflight` (expected NOT_READY before the account exists), `init-paper` with owner intent,
`npm run paper:preflight` (READY_FOR_PAPER), `npm run paper:preflight --smoke --json`, `npm run paper` for 120 s,
SIGTERM, exit.

| Soak | Result | Finding |
|---|---|---|
| 1 (03:05 UTC) | exit 0 within 2 s of SIGTERM, no leftover process | DARK CAPTURE segment refused: `INVALID_REQUEST: the parent of the output directory does not exist` — the runner never created its segments directory. Repaired in `paper/dark-capture.js` (regression P-06). The sensor snapshot also read the charts family as DARK_CAPTURE_OPERATIONAL from a fresh heartbeat while the runner's own state was BLOCKED_EXTERNAL — repaired in `paper/readiness.js` (regression P-04). |
| 2 (03:10 UTC) | exit 0 within 2 s, no leftover process | DARK CAPTURE segment refused: `PERMISSION_FAILURE: the provider quota journal is locked by another owner` — the runner shared the research owner's root and its single-owner quota lock. Repaired: the dark families capture under a SIBLING root `<research root>-dark` (`market-lab/paths.js` darkResearchRootOf, `paper/launch.js`, `paper/readiness.js`; regression P-06). |
| 3 (03:14 UTC) | exit 0 within 2 s, no leftover process | The first dark segment sealed at shutdown (capture COMPLETE, 135 observations, charts 72 calls, 12 PROVIDER_ERROR failures on `charts-analytics` with 12 gaps → DARK_CAPTURE_DEGRADED, truthfully; L3 CREDENTIAL_MISSING → BLOCKED_NO_SAFE_L3_DATA_KEY). A started-but-unsealed runner now reads NOT_OBSERVED ("first segment in flight") instead of OPERATIONAL (regression P-04). |

Third soak, composition as logged: profile banner with the seven authority lines → persistence (schema 9) → cockpit on
port 3999 → memory mirror → RUMINT → gateway (Kraken / Coinbase / OKX status doors observed) → wide eye (633 USD pairs)
→ market research owner + Socrates case runtime → Judge PAPER account `paper-reference-usd500` (startup uncertain 0,
exposed 0) → RUMOR2 official ears (SEC and EDGAR withheld: CONFIG_REQUIRED contact / whitelist, by design in this
environment) → Bluesky social stream open → X not started (CREDENTIAL_MISSING) → Tape LIVE on 13 pairs → SIGTERM → Tape
OFFLINE → social / X runtimes stopped → dark segment sealed → exit 0.

Live sensor snapshot at SIGTERM (`/api/sensors`, 42 rows, zero UNKNOWN): ACTIVE 11 (TAPE, WIDEEYE, RUMINT aggregate,
four gateway doors, BLUESKY_OFFICIAL, SOCRATES_CASE_RUNTIME, JUDGE, WATCH); NOT_OBSERVED 12 (research providers and
official ears with no status record yet within the window); CONFIG_REQUIRED 2 (SEC contact, EDGAR whitelist);
BLOCKED_CREDENTIAL 2 (X, FRED); FOUNDATION_ONLY / BLOCKED_RETENTION / BLOCKED_TERMS ×2 / BLOCKED_EXTERNAL_APPROVAL
(Farcaster, Reddit, StockTwits, TikTok, Meta); DISABLED_BY_PAPER_POLICY 8 (paid providers, Bybit geography, Socrates
model); dark: charts in flight, L3 BLOCKED_NO_SAFE_L3_DATA_KEY. Authority in every snapshot: real money DISABLED, live
orders DISABLED, withdraw / funding DISABLED, judge mode PAPER, dark Kraken Judge / Socrates authority NONE.

Preflight after `init-paper` (soak 3): `L. FINAL READY_FOR_PAPER`; blockers: CORE 0 / 0, EXTERNAL_OPTIONAL 9,
PAID_NOT_AUTHORIZED 2, DARK_RESEARCH 1; `paidCalls 0`, `readOnly true`; the `--smoke` charts probe returned 2 COMPLETE
observations for PF_XBTUSD and the L3 proof reported CREDENTIAL_MISSING.
