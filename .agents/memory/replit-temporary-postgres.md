---
name: Replit temporary PostgreSQL process
description: How to keep a disposable loopback PostgreSQL test server alive for long guarded suites on this host.
---

Run a disposable PostgreSQL test server as a managed background shell process, not as a daemon launched by `pg_ctl`
from a foreground shell.

**Why:** On this host, the daemon started by `pg_ctl` was reaped when its launching shell ended, causing delayed
`ECONNREFUSED` failures during the long PostgreSQL-backed suite.

**How to apply:** Initialize the cluster under `/tmp`, start `postgres` directly with a background shell on a loopback
address, set only the repository's dedicated test-database variable, and stop/remove the temporary cluster after tests.
Never point tests at the paper runtime database.