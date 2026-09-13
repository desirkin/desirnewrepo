# FULL-SUITE FLAKE FAMILY — ROOT CAUSE, PROOF, FIX (2026-09-11)

Scope: the failures that appeared only in full `npm test` runs and passed in isolation (ticket §16). Nothing here was
rerun until green; every run's TAP output is preserved in the closeout scratch evidence and summarized below.

## 1. Exact failures (from the pre-edit full suite, 1999 tests / 3 failed)

| Test | File:line | Assertion | Duration |
|---|---|---|---|
| CLOSE-P3 (an approved in-process watch change with queued old work …) | `test/social-4f-closeout.test.js:473` (assert at `:481`) | `deepStrictEqual` X sources: `[]` expected `['$LINK queued under A']` | 187 ms |
| 4FCOL-M (X plan change through configuration …) | `test/social-4f-collector.test.js:263` (assert at `:288`) | `notStrictEqual` ruleSetHash unchanged (`5cc44ebb…`) | 251 ms |
| T01 (collector seam, real DB) | `test/social-5b-durable.test.js:75` (assert at `:95`) | restart profile `'null'` expected the byte-identical profile | 259 ms |

The same family in the mid-point full suite: 0 of these failed (2014 tests, 1 unrelated fence failure fixed separately).
Ticket-named suites `rumor2-eventroot`, `social-5-durable`, `judge-repair-runtime` never failed in any run of this closeout.

## 2. Reproduction

- Alone (each suite by itself, 3 rounds, PostgreSQL loopback): 18 / 18 runs green — `social-4f-closeout` 41 s each,
  the others 0.8–2.3 s.
- Focused cluster under load (the three suspect tests looped 12× while three background `node --test` processes ran the
  `judge-repair-*`, `social-6-durable` and `rumor2-*` suites against the same database): iterations 9–12 failed —
  7 failures in 4 iterations, with VARYING assertions (`STANDBY` vs `ACTIVE`, missing X source, dossier count 0,
  `socialAuthorId` of undefined, unchanged rule set hash). Varying symptoms from one cause: the collector under test
  silently lost writer authority mid-test.

## 3. Shared resource inspected: PostgreSQL advisory-lock sessions

`node --test` runs test files in parallel processes against ONE database. Fifteen test files simulate "the writer
session died" with:

```
SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()
… SELECT pg_terminate_backend(pid)
```

That selects EVERY granted advisory-lock session in the database — including the RUMOR-2 collectors of OTHER test
files running at the same moment. The terminated collector's `fenceHeld()` turns false, it stands by
(`STANDBY_WRITER`), stops its ears, and the untouched suite fails at whatever assertion came next. The PostgreSQL log
shows the terminations clustered exactly at the failing full-suite run's tail (21 × `terminating connection due to
administrator command` at 01:29 UTC; 28 during the load reproduction).

Other shared resources checked and cleared: schema names (randomized per file), `process.env` (per-process), data
directories (`mkdtemp` per file), ports (none opened by these suites), timers (X and Bluesky stream timers are either
neutered or ≥ 40 s), pool exhaustion (no `too many clients` in the server log), unawaited shutdown (one instance, below).

## 4. Fix (root cause, not a rerun)

1. `persistence/db.js`: every session names its owner — `application_name = 'serpent'` in production and
   `'serpent-test:<schema>'` for a schema-scoped Db (the test seam). Exported as `applicationNameOf(schema)`.
2. `test/helpers/pg-fence.js`: ONE shared helper (`ownAdvisoryHolders`, `killOwnAdvisoryBackends`) whose selection joins
   `pg_stat_activity` on that name; it refuses an unscoped Db. All 15 kill sites now use it
   (`rumor2-epoch`, `rumor2-fence`, `rumor2-freeze`, `social-4d-*` ×5, `social-4f-closeout`, `social-4f-collector`,
   `social-5a-durable`, `social-7-durable`, `social-collector`, `social-runtime`, `x-collector`). `judge-repair-pg`
   already scoped by its schema-qualified lock key and is unchanged.
3. `test/social-5b-durable.test.js` T01: the restart over the same journal now AWAITS the previous collector's `stop()`
   (the writer-fence hand-off is part of shutdown); the successor was booted before the hand-off completed.
4. Regression: `test/pg-fence-isolation.test.js` — two schema-scoped families hold advisory locks at once; killing
   family A terminates exactly one session and family B's lock is still granted and its handle still `held()`.

No assertion or timeout was weakened; no `--test-force-exit`; no test skipped.

## 5. Proof after the fix

- The modified suites together (19 files): 227 / 227 green.
- The same load reproduction that failed 4 of 12 iterations before the fix: 12 / 12 iterations green after it.
- Two clean full suites at closeout (back to back, parallel files, offline guard, loopback PostgreSQL): 2028 / 2028 and
  2028 / 2028, 0 skipped, 0 cancelled, 0 unexpected network records, ~132 s each. An earlier pair after the same fix
  still failed four STATIC import fences deterministically (the new `paper/` layer was not yet enumerated in
  `rumor2-authority`, `social-4f-scope`, `social-5b-fences`); those were resolved by enumeration and by reading the
  collector's published readiness projection instead of importing the runtime module — no timing flake remained.
