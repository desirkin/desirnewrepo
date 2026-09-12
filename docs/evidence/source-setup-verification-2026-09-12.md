# Source setup verification — 2026-09-12

[PR #4](https://github.com/desirkin/desirnewrepo/pull/4) was merged after the required full PostgreSQL and outbound-guard check passed.

| Evidence | Result |
|---|---|
| Tested source commit | `dd3228fdb08ce8bc91a51fc7e51f6f27e5a7fd80` |
| Tested source tree | `78c5d7b656f9ddaa97969f0d9b72f57d0939eaa3` |
| Merge commit | `b39af8b7bc26dbd37f1b8e8875ae23b1d209c35c` |
| Workflow | [34708352533](https://github.com/desirkin/desirnewrepo/actions/runs/34708352533) |
| Job | [103592423921](https://github.com/desirkin/desirnewrepo/actions/runs/34708352533/job/103592423921) |
| Full serial suite | 2,225 passed; 0 failed, cancelled, skipped or todo |
| Test duration | 395863.294905 ms |
| Unexpected outbound requests | 0 |
| Environment | Node 24, isolated PostgreSQL 16; guarded serial npm test |

The subsequent documentation-only update adds this record, restores exact audited credential names in the checklist JSON, preserves Snapshot configuration fields, and distinguishes the NOAA alerts endpoint probe from the composed Kp/scales collector. It changes no runtime or test files. The full gate applies to the code tree identified above; these source-checklist prose/JSON corrections are not claimed to be a second test run.

Focused local integration verification passed 78 tests with no failures and one PostgreSQL-dependent skip; the full isolated PostgreSQL gate above ran with zero skips.

The source setup adds a news-only runner and repairs Snapshot HTTP bounds/cancellation. See [the full checklist](../API-SOURCE-CHECKLIST.md), [news observations](news-connections-2026-09-12.md), [bounded public probes](public-feed-checks-2026-09-12.json), and [Claude setup instructions](../CLAUDE-API-SETUP-HANDOFF.md).

The rescue commit `89e1f9800fb24307d6784ae2844574593dffee9f` remains an ancestor. No force push, paper startup, paid stream, account reset or production deployment was performed. Supplied credential values were excluded from GitHub and placed only in the separate owner-authorized private Claude handoff. Replit Secret installation and continuous host collection remain unverified.
