# Serpent baseline — 2026-09-14

Branch `serpent/baseline` on `desirkin/desirnewrepo`. GitHub tip `65a48eb` (116 commits); local tip `af77a84` (121 commits) pending the next bundle upload. orphan history (no common ancestor with `main`; `main` is the 2026-09-12 state, the Replit data-only series lived only in Replit and was recovered from bundles).

## Suite: GREEN — 3,036 tests, 0 fail, 0 cancelled, 0 outbound (serial, offline guard, real PostgreSQL 16) — last full run at 5dbe8d9 + the market-lab fence fix

## Commits since the assembled release candidate (29b0d7a), one ticket each
- `fdf93d3` — durable-store timeout timer was unref'd; a stalled port never timed out (hang).
- `7abf365` — six architecture fences red since the Replit series: X provider routed through the social-time boundary (`utcDayLabel`); live wiring points named once (`test/helpers/composition-roots.js`); R2A-76+77 now catches dynamic imports.
- `cbe2de5` — **reservation never released after a paper fill** (availableCash −368 on a $500 account after one trade; a second trade was impossible). Fixed at the dispatcher; `test/judge-reservation-settlement.test.js`.
- `f6978cf` … `c90f053` — test glob scoped to real tests; JUDGE-PAPER-AUDIT §4.5 written and FROZEN_FOR_PAPER re-pinned; sensor inventory regenerated from its derivation; fence pins moved to the audited laws; the Judge differential keeps its behavioral proof (the 2026-09-12 Judge and today's Judge make identical decisions on identical inputs with the new ports absent).
- `0f752f2` `7dca1f8` `1b7e7a8` — docs in the repo (docs/serpent/): philosophy, map, plan, baseline, the learning/ finding (no superseded drafts; nothing atticked), and the runtime-unification design.
- `5dbe8d9` `af77a84` — runtime unification step 1: the data-only composition body moved verbatim to lib/serpent-runtime.js; entry keeps the safety pins. No behavior change; fences name the spine.
- `65a48eb` — lean trim step 1: one bankroll, one daily-lock law; legacy JSONL ledger retired to `attic/`; `execution/ledger-view.js` + projection `dailyLock`/`ledger`; audit §4.6.

## Test recipe
```
PERSIST_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/cobra_test \
PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY \
NODE_OPTIONS=--import=$PWD/test/helpers/offline-guard.mjs \
COBRA_OFFLINE_GUARD_LOG=/tmp/guard.jsonl COBRA_OFFLINE_GUARD_RUN=suite \
npm test -- --test-concurrency=1 ; node tools/offline-gate.mjs /tmp/guard.jsonl
```
