# Data-only runtime coordination — 2026-09-12

Codex owns the data-only activation slice until this note is updated. No active Claude Code edit session was visible when the slice began.

Files in this slice:

- `tools/data-only-runtime.mjs`, `tools/data-only-status.mjs`
- `lib/data-only-budget.js`
- `survey/wideeye.js`, `survey/reader.js`
- `gateway/collector.js`
- `.replit`, `package.json`
- `test/data-only-budget.test.js`, `test/data-only-runtime.test.mjs`

Claude should not edit these files concurrently. Safe independent work includes provider-specific collectors that remain disabled, documentation, or UI display code, provided it does not change the data-only composition root.

Safety contract: paper and live trading remain OFF; no Tape/Paper/Judge/Watch/execution/order composition; WideEye nominations are disabled; paid request allowance is $0; Farcaster remains disabled pending storage minimization to the scope Neynar approved.
