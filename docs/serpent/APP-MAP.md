# Serpent — the map

Read from the actual code, branch `serpent/baseline` @ `7abf365`, 2026-09-14. Short sections on purpose. Anything marked **VERIFY** was found by a reviewer and I have not yet reproduced it myself.

---

## 1. One root, two modes (runtime unification step 3, 2026-09-14)

`fly.js` is the one composition root, mode-switched by a DERIVED `SERPENT_MODE` (never trusted from the environment
alone): DATA_ONLY iff the data-only launcher pinned the safety posture, PAPER iff the paper launcher applied the
profile and every forced authority name holds; a bare `node fly.js` refuses (exit 1). Both modes share the spine
(`lib/serpent-runtime.js`): ONE single-instance lock per data dir — a second instance refuses in either mode — one
status file, one persistence pump, one external-quota restore. PAPER = today's ship sequence PLUS the collector
additions the split kept away from it (market catalogs, broad Kraken capture, public discovery).

The launchers still exist as entries: `cobra paper run` (applies the profile, imports fly.js);
`tools/data-only-with-ui.mjs` (what Replit runs — pins the safety posture, enters fly.js: spine + IN-PROCESS cockpit,
one process, step 4); `tools/data-only-runtime.mjs` (headless collector, pins + spine directly, fenced) until step 6
retires the shims.

---

## 2. The decision path (the ship)

**Feed.** `tape/run.js` — Kraken WebSocket, trades + order books, checksum-verified, for the daily universe (5 configured coins, deep cap 30). This is the only thing the Judge decides on.

**Judge.** `judge/judge.js` — rule engine, no LLM. Four setups in `judge/setups.js`. When a trigger crosses: freeze references → write `HYPOTHESIS_LOCKED` to Postgres *before* any cost check → crossing must persist 3 updates / 2 s → price the trade by walking the real book (`judge/cost.js`) → R/R ≥ 1.5 after fees → risk caps 1% / 2% / 3 slots.

**Permission.** `execution/authority.js entryPermission()` — one pure function: account initialized, DB writer held, KILL, CAGE, vetoes, latched restrictions, mode, valuation known. Called before commit and twice more before send.

**Commit.** One Postgres transaction: `DECISION_RECORDED`, `RESERVATION_OPENED`, `POSITION_OPENED` (shell), `FEED_PIN`, `ORDER_INTENT`.

**Paper fill.** `execution/paper-adapter.js` — first real book ≥ 250 ms after dispatch, walk the asks, deplete displayed size, taker fee, remainder expires. No book → `UNFILLED_COVERAGE_UNKNOWN`, never an invented fill.

**Watch.** `watch/watch.js` — finalizes R, trails the stop, exits on stop / deterioration / target / 180 s no-progress / 4 h max / KILL. Protective exit is a market walk of the bids.

**Ledger.** Append-only event journal in Postgres (`execution/journal.js`, `reducer.js`), replayed and digest-checked on every restart.

---

## 3. The sensors (mostly dark)

"Dark" = writes files that nothing in the decision path reads.

- **Tape** — feeds the Judge. ON.
- **Wide eye** (`survey/wideeye.js`) — sweeps every Kraken USD pair each minute, nominates candidates into tomorrow's universe. ON. Indirectly feeds.
- **Broad-kraken** (`market-lab/broad-kraken.js`) — all 612 markets, ticker + 1-min candles, ~1 GiB rolling ring that evicts. Runs only in the collector. Dark. Cannot hold a full day.
- **Deep capture** BTC/ETH/SOL — sealed into research captures. Consumed only by Socrates cases, which are never built (no `enqueueCase` caller; model budget $0). Dark.
- **Rumor2 official** (SEC, CFTC, EDGAR, OFAC, Kraken status) — durable in Postgres. Reaches the Judge only through cases → dark in practice.
- **Rumor2 social** — Bluesky ON; X, Farcaster, Reddit, StockTwits, Meta, YouTube, TikTok need keys / are off. Dark.
- **Discovery** (GDELT, Polymarket, Kalshi), **press**, **infra** (NOAA, RIPE, Cloudflare), **video**, **gateway** — observation files only. Dark.

Consequence: the `CATALYST_TRANSMISSION` setup is permanently `NEEDS_DATA` because no case ever exists. Effectively three setups are live, not four.

---

## 4. Persistence — what survives a Replit republish

Replit wipes the filesystem on publish. Nothing has been republish-tested.

**Durable (Postgres):** controls, posture, audit, paper ledger mirror, memory events, rumor2 journal + checkpoints, execution journal, experiment records, four quota counters. Schema version 10.

**Local-only — LOST on republish:** broad-kraken segments, deep market captures, all of `data/learning/`, tape sessions, survey/gateway/infra/discovery/video files.

**The pump** (`persistence/runtime.js`): every 5 s tails seven small spool files into Postgres. Store anchors (schema 10) can snapshot ≤1 MiB files — but zero stores are commissioned; the guard reports `UNCOMMISSIONED`.

**PERSIST-1 needs:** an object-store bucket for the bulk streams plus an uploader, manifest, and restore-on-boot. **There is no S3/GCS adapter, stub, or env name anywhere in the repo.** That's a build, not a config.

---

## 5. Learning — built in pieces, not one wire connected

Two unrelated systems:

- **LEARN-1** (`learning/service.js`) — learns from wide-eye sweeps against the Childhood archive. Not linked to Judge decisions. Off in paper (profile never sets `LEARNING_ENABLED`).
- **Adaptive** — the real one. Registry (Brier score, ±0.15 RR rank offset, cap 2) ✓. Core record/score/update ✓. Local store ✓. Durable store: **contract only, no implementation**. Candle outcome labeler ✓. Qualification law ✓. Judge hook ✓. **Zero runtime callers for any of it.** `composeJudge` passes `adaptiveRanking = null`. Always.

**Correction to what I told David:** wiring learning into go-live is a *build*, not a plug. The Judge hook only fires for fully qualified candidates and expects a synchronous durable capture receipt that nothing produces. Recording a prediction on every decision needs a new seam in `judge.js`, params through `composition.js`, a runtime module, a maturity worker, and fence updates. About five files. Days, not hours. Dormancy is already enforced, so recording-without-effect is safe by construction.

**SIM-1/2, DATA-1:** planner exists, archive writer exists (v2), reader exists. No runtime opens the archive. No simulator exists as code. Design only.

---

## 6. Two ledgers that disagree

Legacy JSONL ledger (`ledger/`, float math, CLI-only writer) and the Postgres journal (exact decimals, live in PAPER). They compute the daily lock three different ways. The cockpit can show "no lock" while the Judge refuses. Retiring legacy touches `state/locks.js`, `state/machine.js`, `ui/server.js`, `paper/preflight.js`, `paper/readiness.js`, persistence `LEDGER_KINDS`.

---

## 7. Risks found — ranked

1. **VERIFY — reservations never released after a normal fill.** Reviewer reports `RESERVATION_OPENED` stays open forever after a fill; cash double-debits, slots exhaust after N trades, the asset can never be re-entered. Tests hand-write the release event, hiding it. If true, this stops paper trading after three trades. Reproducing next.
2. Two processes, no coexistence plan (§1).
3. No durable raw storage (§4). Every day of capture so far can be lost by one publish.
4. Learning unwired (§5) — the data clock hasn't started.
5. Restriction codes defined but never latched by any production path: `WRITER_LOST`, `DB_UNAVAILABLE`, `GAIN_LOCK_*`, `FEE_BOUND_MISMATCH`, `ARM_EXPIRED`, `PAPER_LIQUIDITY_UNCERTAIN`. They exist on paper only.
6. Legacy vetoes keyed by prediction id; composition passes asset ids — a veto only works if the operator types the coin symbol.
7. Paper fill is optimistic in known ways: full displayed size assumed, tombstoned levels reset depletion, no exchange latency, stop walks the whole visible bid side.
8. Broad-kraken's 1 GiB ring cannot hold a 612-market day even locally.

---

## 8. What's actually good (unchanged)

Fail-closed everywhere. Corrupt control state → KILL. Price-blind ordering enforced twice. One permission law checked three times. Exact-decimal money. Honest fills. Digest-chained records. The mission is falsifiable.

---

## 9. What this changes in the plan

- **Ticket 0 (new, first):** reproduce the reservation bug. If real, fix before anything else.
- Go-live release = collector/ship coexistence decision + PERSIST-1 (object store) + learning seam + PAPER publish.
- Estimate for "paper live with learning recording" moves from 3–5 days to **roughly 7–10 working days**. I under-called it earlier because I hadn't read the wiring.
