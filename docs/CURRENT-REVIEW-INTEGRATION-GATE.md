# Current-review gate before isolated integration

Date: 2026-09-13. The user's corrected instructions control; the older 627-file
ZIP review is evidence, not a repair specification.

The root reviewed current source, the independent account/input, sensor and
tests/performance reports, and the supplied critique before integrating any
adaptive branch. A complete review-received Git bundle was verified before
these review-driven changes. The original source34 mirror remains untouched.

The detailed user-facing assessment is
`outputs/SERPENT-current-checkout-review-2026-09-13.md` in the parent task
workspace. Its initial assessed version has SHA-256
`0df93d37ada403a46943b4fd45cf3eecf6ed4d5503c45830f7a13a06428bf612`.
The deliverable will be updated with subsequent repair and integration results;
this digest identifies the version assessed before this integration.

## Findings affecting this integration

- CONFIRMED: named major-coin floor/cap/depth/snapshot/health privileges in the
  older deep path. Isolated root repair `947a750` uses equal evidence-based
  eligibility and protects actual held/pending exposure; 49 focused tests pass.
- CONFIRMED: current spec construction drops normalized BTC/DOGE aliases;
  initialized accounts are not bound to current policy digest/version; dormant
  BASE-fee costing mixes units. Reviewed candidate `02d8ac7` fixes aliases,
  refuses mismatched initialized accounts and refuses non-QUOTE compositions.
  Fee rates, account rows and stored policy bindings are not rewritten.
- UNSUPPORTED: public first-tier fee must be reduced to 0.40% taker; fees must
  be subtracted from modeled reward/loss a second time; capital alone repairs
  negative percentage expectancy. Official public first-tier spot schedule
  checked 13 September is 0.40% maker / 0.80% taker. Actual account/pair schedule
  remains NEEDS VERIFICATION. QUOTE reference remains unchanged.
- CONFIRMED: synchronous tape writes; UNSUPPORTED: normal book path always
  fsyncs. Target-host impact remains NEEDS VERIFICATION. Direct audit durable
  writes have a measured local stall and require the independently reviewed
  fixed worker before any runtime composition. The worker is still unwired.
- ALREADY FIXED: scripted WebSocket acknowledgement predicate barrier. Missing
  Git-history objects and Windows shell/EOL prerequisites are not equivalent to
  failed application behavior. No assertions, digests or history checks were
  weakened. Original runtime/integration cobra.config bytes match the protected
  digest; separate worktree CRLF conversion explains that branch-only mismatch.
- CONFIRMED: some access/licensing/commissioning gaps persist. The old static
  inventory is UNSUPPORTED as a current census. Preview evidence is historical;
  current preview is stopped, source-sync conflict unresolved, deployed source
  identity/current production health NEEDS VERIFICATION. No collector stopped,
  restarted or reconfigured by this review.
- CONFIRMED: account-separated journal primitives and market-neutral episode
  identity exist. Three named running household ledgers are UNSUPPORTED; their
  commissioning/orchestration is a separate outstanding slice.
- NEEDS VERIFICATION: external durable custody, intended-state crash recovery,
  actual joined end-to-end latency, prospective after-cost adaptive efficacy.

## Integration is not activation

Reviewed branches may be combined serially in this isolated integration repo.
This gate grants no live or PAPER order authority, running-app merge, publish,
restart, new paid account, stale-lock takeover or rewriting of an account's
policy/history. All existing mode controls remain fixed.

The full saved forecast -> matured label -> score -> bounded update -> qualified
later PAPER decision -> durable restart chain is not finished. Core state and
uncertainty snapshots remain authority NONE. Forecast significance cannot
self-qualify a trading policy. Existing promotion and position-management laws
must remain intact while the missing connection is implemented and tested.

Resolve confirmed input, fee-mode, account, durability, recovery and performance
blockers before activation. Documentation cleanup and migration stay separate.
