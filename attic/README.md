# attic/

Code that Serpent no longer loads, tests, or ships — kept byte-for-byte for history and for the day someone wants it back.

Law (lean trim, 2026-09-14, approved by David):
- Nothing here is imported by the running application. A fence test refuses any `attic/` import from outside `attic/`.
- Files are moved here with `git mv`, content unchanged, so `git log --follow` still tells their story.
- Tests that only exercised attic code move to `attic/test/` and are outside the `npm test` glob.
- Bringing something back is a `git mv` plus a review, never a rewrite.

## Contents
- `ledger/` — the legacy JSONL paper ledger (predictions / fills / exits, float math, CLI-driven) and its rollup / summary.
  Replaced by the PostgreSQL execution journal (`execution/journal.js`, `execution/reducer.js`) and its read-only
  `execution/ledger-view.js` published in the Judge projection. Retired so there is ONE bankroll and ONE daily-lock law.
- `research/` (+ `research/referee/`), `persistence/social-research-export.js`, `bin/social-research.js` — the SOCIAL-5B
  OFFLINE social-research analysis pipeline and its statistical referee library (LEAN PASS 2, 2026-09-15, approved by
  David). Dead to production: proven by the import graph — reachable only from its own `bin/social-research.js` CLI (never
  in package.json or `.replit`) and from test/. It is NOT the live research: `market-lab/` is the live research owner that
  fly.js composes, and `rumor2/social-research-*.js` is the live social sense — both stay. `learning/` MIRRORS the
  referee's label law rather than importing it (the mirror-parity test that proved the two agreed, in
  `test/learning-maturation.test.js`, retired with the pipeline). Its tests moved to `attic/test/` (the `social-5b-*` and
  `referee-*` suites + their helpers). The rumor2-authority / socrates-contract / social-scope fences that scanned the
  tree were updated to exclude `attic/` and to drop the retired files from their offline-research enumerations.
- `tools/` — four fully-orphaned setup-smoke / recon scripts (LEAN PASS 2 target #4, 2026-09-15): `governance-setup-smoke.mjs`,
  `youtube-setup-smoke.mjs`, `public-discovery-smoke.mjs`, `stocktwits_recon.js`. Proven zero references anywhere (no
  importer, no package.json script, no `.replit`, no doc, no fence, no test) — one-off throwaway diagnostics superseded by
  the unified runtime's own collector status; they moved no sense module. The live operator diagnostics stay
  (`tools/social-storage-diagnose.mjs`, `tools/news-setup.mjs`, the fenced bluesky/farcaster/official setup smokes).
- `lib/data-only-social-config.js` — the data-only composition policy for the bounded X commissioning smoke
  (`composeDataOnlySocialConfig`), orphaned by LEAN PASS 4a (B-5 orphan sweep, 2026-09-16). Proven fully dead by the
  import graph: zero importers of any kind — no runtime root, no test, no sibling — its only remaining trace is the
  data-only fence asserting the entry does NOT compose it. The live data-only social path is gone; nothing replaced it.
- `market-lab/providers/` (+ `market-lab/test/`) — retired market-data provider modules and their tests. `twelvedata.js`
  (+ the CROSS_ASSET family / PER_SYMBOL credit path) from the market-lab providers cut; `fred.js` + `coinmetrics.js`
  from SENSE-CULL-2; `deribit.js`, `bybit.js`, `binance.js` (Binance-global) and `santiment.js` from SENSE-CULL-3. The
  LIVE research owner `market-lab/` stays in the tree and is what fly.js composes — only these retired providers moved.
- `senses/` — the LEAN PASS 4a observation tiers that the sense set no longer runs: `discovery/`
  (GDELT / Polymarket / Kalshi), `gateway-infrastructure/` (Cloudflare Radar), `governance/`, `infra/`, `press/`
  (the licensed news-aggregator machinery), `social/` (Meta / TikTok / StockTwits official), `video/` (YouTube), and
  their `senses/test/`. Retired as observation narrowed to the kept market + social providers.
- `doctrine/` — retired doctrine kept for history: `GOVERNANCE.md` (the retired governance tier) and `SOCIAL.md` (the
  Meta / TikTok social-exclusion doctrine the rumor2-authority fence still points at for its exclusion rationale).
- `docs/` — superseded working docs kept for history (ADAPTIVE-PREMERGE-CHECKPOINT, ADDENDUM-2-INTEGRATION-MAP,
  CURRENT-REVIEW-INTEGRATION-GATE, FOUR-VCPU-PERFORMANCE, JUDGE-CLOSEOUT-ACCEPTANCE, MARKET-SOCRATES-ACCEPTANCE,
  REPLIT-PULL-AND-START) — one-time acceptance / checkpoint / integration notes, replaced by the current `docs/serpent/`.
