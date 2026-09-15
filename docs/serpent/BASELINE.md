# Serpent baseline — 2026-09-14

Branch `serpent/baseline` on `desirkin/desirnewrepo`. GitHub tip = this branch (the repo-attached session pushes after every green ticket). orphan history (no common ancestor with `main`; `main` is the 2026-09-12 state, the Replit data-only series lived only in Replit and was recovered from bundles).

## Suite: GREEN — 3,039 tests, 0 fail, 0 cancelled, 0 outbound (serial, offline guard, real PostgreSQL 16) — confirmed at 5afee32 by the working session, 2026-09-14

## Commits since the assembled release candidate (29b0d7a), one ticket each
- `fdf93d3` — durable-store timeout timer was unref'd; a stalled port never timed out (hang).
- `7abf365` — six architecture fences red since the Replit series: X provider routed through the social-time boundary (`utcDayLabel`); live wiring points named once (`test/helpers/composition-roots.js`); R2A-76+77 now catches dynamic imports.
- `cbe2de5` — **reservation never released after a paper fill** (availableCash −368 on a $500 account after one trade; a second trade was impossible). Fixed at the dispatcher; `test/judge-reservation-settlement.test.js`.
- `f6978cf` … `c90f053` — test glob scoped to real tests; JUDGE-PAPER-AUDIT §4.5 written and FROZEN_FOR_PAPER re-pinned; sensor inventory regenerated from its derivation; fence pins moved to the audited laws; the Judge differential keeps its behavioral proof (the 2026-09-12 Judge and today's Judge make identical decisions on identical inputs with the new ports absent).
- `0f752f2` `7dca1f8` `1b7e7a8` — docs in the repo (docs/serpent/): philosophy, map, plan, baseline, the learning/ finding (no superseded drafts; nothing atticked), and the runtime-unification design.
- `5dbe8d9` `af77a84` — runtime unification step 1: the data-only composition body moved verbatim to lib/serpent-runtime.js; entry keeps the safety pins. No behavior change; fences name the spine.
- `679f358` — runtime unification step 2: spine → lib/external-quota.js + lib/collectors.js with injectable starters; test/serpent-runtime-composition.test.js RC-1..3 (order, options, status, reverse stop, lock, fail-closed). Targeted fences green; full run to be confirmed by the worker.
- `65a48eb` — lean trim step 1: one bankroll, one daily-lock law; legacy JSONL ledger retired to `attic/`; `execution/ledger-view.js` + projection `dailyLock`/`ledger`; audit §4.6.
- `5afee32` — worker standing orders + queue (docs/serpent/README.md); baseline at 679f358.
- `cc17c9c` — runtime unification step 3: fly.js is the mode-switched root (`SERPENT_MODE` derived fail-closed; bare start refuses); PAPER runs on the spine — one lock per data dir any mode, runtime-owned persistence signals, external-quota restore, collector additions (market catalogs + broad Kraken + public discovery); DATA_ONLY delegates to the spine. Audit §4.7; frozen digests unchanged. `test/serpent-paper-spine.test.js`, `test/serpent-mode-law.test.js`.
- `0533251` — runtime unification step 4: in-process cockpit. `data:only-ui` is ONE process — the shim pins the full DATA-ONLY posture and enters fly.js; the DATA_ONLY branch serves ui/server.js in-process after the spine (PERSIST-0A §2), judgeRun null; the two-process supervisor is retired; honest `entrypoint` in the status file.
- `b0f5373` — runtime unification step 5: mode-agnostic paths. Canonical `serpent/runtime.lock` + `serpent/runtime-status.json` in both modes; byte-equal `data-only/` mirrors for one release; readers prefer canonical with mirror fallback; a pre-step-5 legacy lock still refuses. PR-4.
- `839bb62` — PERSIST-1 step 1: object-store substrate (adapter contract + FILESYSTEM backend + env-NAME fail-closed config gate). `test/object-store.test.js`.
- `7cab55e` — PERSIST-1 steps 2+3: the self-describing manifest, the changed-only uploader (never prunes durable evidence), restore-on-boot (digest-verified, never clobbers a newer local append), and the spine wiring (restore before any consumer reads, mirror on a 60 s timer, `collectors.objectStore` in the status) for both modes. `test/object-manifest`/`object-uploader`/`object-restore`, spine PR-5.
- `f7f65b8` — docs: David's decided doctrine (learning target, exit law, sizing, cadence, paper realism, venue, Strategy 6 IFR + Strategy 7 SDR) added to PHILOSOPHY.md.
- `179c127` — Ticket 3 step 1: the decision yardstick — pure 5m bite + 15m continuation log-return scorer (labels.js discipline). `test/decision-yardstick.test.js`.
- `e060db5` — Ticket 3 step 2: the dormant decision-outcome recorder + durable idempotent store; matures DECISION_RECORDED via the journal's public page() (no frozen change), sources injected. `test/decision-outcome-recorder.test.js`.
- (this commit) — Ticket 3 step 3: the broad-Kraken 1m series source + always-on PAPER wiring in fly.js (the data clock records every PAPER decision, dormant). `test/broad-kraken-series.test.js`.

## Test recipe
```
PERSIST_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/cobra_test \
PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY \
NODE_OPTIONS=--import=$PWD/test/helpers/offline-guard.mjs \
COBRA_OFFLINE_GUARD_LOG=/tmp/guard.jsonl COBRA_OFFLINE_GUARD_RUN=suite \
npm test -- --test-concurrency=1 ; node tools/offline-gate.mjs /tmp/guard.jsonl
```
