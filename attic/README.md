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
