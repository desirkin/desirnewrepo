# PERSISTENCE DOCTRINE — the durable core (PERSIST-0)

> **The deployment filesystem is a cache and workspace, not the durable
> authority for safety-critical state.**
>
> **A new deployment may replace Serpent's body. It must not erase
> Serpent's durable memory, ledger, or protective controls.**
>
> **Loss of durable persistence may reduce permission. It may never
> increase permission.**
>
> **KILL and other defensive restrictions must remain possible when the
> database is unavailable. CLEAR / RE-ARM and new trading permission must
> fail closed.**
>
> **Database state is authoritative for the durable core.**
>
> **Local mirrors may exist for observability or compatibility, but may
> never silently override newer durable truth.**
>
> **Authentication sessions are NEVER durable. CONTROL-0 sessions remain
> in-memory and disappear on restart by design.**

## THE ONE DEPENDENCY

The zero-dependency doctrine yields, deliberately and only here: `pg`, the
minimal standard PostgreSQL driver. No ORM, no migration framework, no
queue, nothing else. `DATABASE_URL` comes only from the environment; it is
never logged, never echoed, never reachable from browser JavaScript. The
frontend talks to the Serpent server; only `persistence/db.js` talks to
PostgreSQL.

## ARCHITECTURE

```
BROWSER -> SERPENT SERVER -> persistence/repository.js -> persistence/db.js -> POSTGRESQL
                                (ALL SQL lives here)        (pool, timeouts)
LOCAL data/ (spool + mirror) --> DURABILITY PUMP --> POSTGRESQL (authority)
```

`persistence/`: `db.js` (bounded pool: max 5, 5s connect timeout, 10s
query/statement timeout, idle cleanup, bounded startup retry, no reconnect
storm) · `schema.js` + `migrate.js` (numbered transactional migrations in
`serpent_schema_migrations`; an unknown FUTURE schema is refused, never
downgraded) · `repository.js` (the persistence interface; no ad-hoc SQL
anywhere else) · `health.js` · `runtime.js` (startup restore + pump) ·
`migrate-local.js` (the explicit one-time import tool).

## THE DURABLE CORE (schema 1)

Control state (single revision-guarded row) · control/security audit ·
current posture and sim/lock state (revision-guarded rows) · posture
transitions · paper ledger predictions/fills/exits (keyed by their existing
deterministic `prediction_id`) · canonical Memory events (the COMPLETE
envelope as its exact canonical JSON text plus the MEMORY-0C digest;
extracted columns exist only to bound queries, never as the truth) ·
Childhood manifest identity (metadata only). NOT in the database: bulk
Childhood archives, tape books/ticks, raw sensor streams — PERSIST-1 / App
Storage territory. Auth sessions: never.

## STARTUP SAFETY & THE PERMISSION LOCK

On startup, durable protective state is restored BEFORE anything that
could ever grant permission. **PERSISTENCE_PERMISSION_LOCK** holds
whenever a CONFIGURED database is unreachable or its state has not been
restored this run: CLEAR / RE-ARM refuses, future permission-increasing
behavior refuses, while defensive KILL/CAGE/VETO still restrict the
current process and read-only research continues. An UNCONFIGURED
database (no `DATABASE_URL`) preserves pre-PERSIST-0 local-only behavior —
honest development mode with health `UNAVAILABLE` and
`databaseConfigured: false`; no durable authority exists to disagree with.
Production setup therefore REQUIRES `DATABASE_URL`.

## THE CONTROL ASYMMETRY (non-negotiable)

Permission-REDUCING (KILL/CAGE/VETO): applied to the current process
immediately, then persisted durably; a failed durable write leaves the
restriction ACTIVE locally, marks health degraded, and the write retries —
durable success is never claimed falsely, and a restriction is never
cleared because a write failed. Permission-INCREASING (CLEAR): the durable
transaction (row-locked, revision-advanced) must succeed BEFORE the server
reports success; a failed write means CLEAR failed and the latches stand.

## RECONCILIATION — MOST RESTRICTIVE STATE WINS

Local file vs durable row always merge toward less permission: KILL or
CAGE active in either place is active everywhere; vetoes union. Local says
CLEAR while the database says KILL → KILL. Local says KILL while the
database says CLEAR → KILL, until durable synchronization explicitly
succeeds. Disagreement never resolves toward more permission
automatically. Revision-guarded compare-and-update prevents concurrent
mutations from silently overwriting each other; a lost race re-merges
toward restriction and retries.

## DURABILITY STATES & THE PUMP

The local JSONL streams (memory events, posture transitions, control and
security audit, ledger rows) remain as validated spool + observability
mirror; the durability pump tails them one-way into PostgreSQL with
idempotent inserts and a persisted cursor. A local record is
**PENDING_DURABLE** until the database confirms it, **DURABLE_CONFIRMED**
when the insert succeeds (cursor advances), **DURABILITY_FAILED** when a
write fails — the cursor rolls back, health degrades, the record retries;
nothing is dropped, and nothing is reported durable until the database
says so. The spool is disk-bounded (no unbounded in-memory queue); its
limitation is honest: durability lags local write by up to one pump cycle,
and future consumers (Brain, Philosopher) must treat only
DURABLE_CONFIRMED evidence as durably remembered.

## MEMORY IN THE DATABASE — MEMORY-0C, UNWEAKENED

Insert rule: new id → insert; same id + identical digest → deterministic
duplicate, no new record; same id + different content →
`ID_CONTENT_CONFLICT`, refused, health degraded, first truth never
overwritten. Restore rule: rows returned by PostgreSQL are storage, not
magical truth — every restored envelope re-earns its way through the
recomputed digest AND the canonical Memory validator before it is served;
invalid durable Memory is withheld and counted. All durable queries are
bounded (limit clamp 500, indexed by ts/symbol/module/event/cluster);
there is no "select the lifetime of Memory into RAM."

## DEVELOPMENT vs PRODUCTION

PERSIST-0 is exercised against DEVELOPMENT PostgreSQL only. Tests isolate
themselves in their own uniquely named schema and clean up only what they
own; the database is never assumed disposable. Production PostgreSQL is a
separate later provisioning step, and the durable era begins at the first
deployment connected to it — nothing is claimed migrated from the old
published VM's private ephemeral filesystem, because it never was
retrievable. Continuity is never fabricated.

## THE EXPLICIT MIGRATION TOOL

`node persistence/migrate-local.js` — never automatic. It inspects
existing local `data/state`, `data/ledger`, `data/memory`, validates every
record (Memory through the canonical validator), imports idempotently
(re-run safe), refuses invalid rows, reports counts per subsystem, and
deletes nothing.

## FAIL CLOSED, ALWAYS

Rows are validated before being applied; an internally inconsistent
durable safety row means less permission, never a silent repair, never a
downgrade of a safety state. Persistence health
(HEALTHY/DEGRADED/UNAVAILABLE plus clocks, error counters, migration
version, configured/reachable flags) is internal, surfaced through one
safe status field — no circular dependency: persistence reads Memory's
files and validator; Memory never reads persistence.
