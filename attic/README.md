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
