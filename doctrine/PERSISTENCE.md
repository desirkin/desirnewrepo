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

## WHEN DURABILITY IS REQUIRED (PERSIST-0A)

`durabilityRequired()` is TRUE when `REPLIT_DEPLOYMENT=1` (a published
Replit deployment) or `SERPENT_DURABLE_REQUIRED=1` (explicit override for
development/testing). **A published deployment can never override this to
false — no disable knob exists.** A durability-required process without
`DATABASE_URL` is *PERSISTENCE REQUIRED BUT UNCONFIGURED*
(`PERSISTENCE_REQUIRED_UNCONFIGURED`): health `UNAVAILABLE`,
`permissionLock: true`, CLEAR / RE-ARM and every future
permission-increasing action refuse, while KILL/CAGE/VETO still restrict
the current process and read-only research continues. Only an explicitly
local development workspace (no `DATABASE_URL`, durability not required)
keeps pre-PERSIST-0 local-only behavior — honest development mode with
health `UNAVAILABLE` and `databaseConfigured: false`; no durable authority
exists to disagree with. Production setup therefore REQUIRES
`DATABASE_URL`.

## STARTUP SAFETY & THE PERMISSION LOCK

On startup, durable protective state is restored BEFORE anything that
could ever grant permission. **PERSISTENCE_PERMISSION_LOCK** holds
whenever a CONFIGURED database is unreachable or its state has not been
restored this run: CLEAR / RE-ARM refuses, future permission-increasing
behavior refuses, while defensive KILL/CAGE/VETO still restrict the
current process and read-only research continues.

**No boot window exists (PERSIST-0A).** `getPersistence()` is never null:
from module import onward a fail-closed BOOTING state answers, refusing
CLEAR whenever durability is required or a database is configured;
`fly.js` starts persistence BEFORE the cockpit begins listening; and
`startPersistence()` never throws past installing a fail-closed API — a
migration/restore failure leaves a valid locked persistence state behind
with a safe `failureCategory` (never connection details). The startup
retry loop stops only after connect + migration compatibility + migration
application + durable state validation + restore/reconciliation ALL
succeed, at a bounded 30s interval (no reconnect storm); `connect()`
re-probes the existing pool on every retry, so an outage that ends is
actually noticed. A durable content conflict
(`LEDGER_ID_CONTENT_CONFLICT`) also locks permission until manually
resolved.

## RESTRICTIVE STATE RECOVERS BY ITSELF (PERSIST-0B)

A restrictive control action taken during a database outage becomes
durable AUTOMATICALLY after recovery — no second human action, no restart,
no republish. The pump runs `syncCurrentControls()` every cycle: local
`controls.json` and the durable control row are both strictly validated,
merged MOST RESTRICTIVE (kill/cage active anywhere is active everywhere;
vetoes union), a durable restriction missing locally is adopted locally
(this is also how a restriction propagates across overlapping instances —
no leader election, just "another process discovered a durable
restriction", which may never be ignored), and a local restriction missing
durably is persisted transactionally with its revision tracked. While a
restrictive snapshot remains pending (`pendingControlSync`), persistence
health never claims complete durability. Disagreement never resolves
toward more permission.

## LOCAL CONTROL INTEGRITY & ATOMICITY (PERSIST-0C)

**Local control corruption is uncertainty about permission. Uncertainty
resolves toward restriction.** A corrupt `controls.json` never crashes
KILL, is never read as CLEAR, and is never silently repaired toward
permission: the raw evidence is quarantined, a VALID fail-closed KILL is
materialized (audited explicitly as `INTEGRITY_FAIL_CLOSED`, never
presented as a human KILL), an integrity marker
(`state/control_integrity.json`, reason `LOCAL_CONTROL_STATE_INVALID`)
engages the persistence integrity/permission lock, and the fail-closed
restriction becomes durable through normal reconciliation. Defensive
controls keep working on top of the fail-closed state; CLEAR refuses until
the marker is resolved (inspect the quarantine, then remove the marker —
the documented recovery condition).

**Local control mutations are serialized across processes before
read-modify-write. Database transactions protect durable state; the local
control lock protects the current-process mirror. Both are required.**
`state/control-store.js` is the ONE local authority (reads, validation,
mutation, locking, atomic replacement, corruption fail-closed); the
public functions in `state/controls.js` are compatibility wrappers, and
persistence coordinates through the same store. The inter-process lock is
an exclusive lock directory with an inspectable owner record; only the
tiny local mutation section is locked (never a database/network wait);
stale recovery is conservative (a provably dead owner AND an aged lock) —
a live lock is never casually deleted. If even the lock fails during a
restriction, the current process still restricts itself (emergency KILL
overlay) and reports honestly — a control action never disappears.

**Concurrent permission-reducing actions merge. A restriction may never
be lost because another restriction arrived simultaneously.** KILL+CAGE
racing becomes KILL+CAGE; KILL+VETO becomes KILL+VETO; CAGE+VETO becomes
CAGE+VETO. A mutation returns the EXACT snapshot it produced, and that
snapshot — not a later re-read — is what gets persisted durably.

**Concurrent restriction beats CLEAR.** CLEAR is two-phase: the state it
approves is fingerprinted before the durable transaction and re-checked
under the local lock afterward; any change refuses with
`CLEAR_RACED_WITH_RESTRICTION` and the restrictive truth is immediately
reasserted durably. A local latch-write failure after a durable CLEAR is
`LOCAL_CLEAR_FAILED`, never success — the restrictive state stands and is
reasserted. Malformed CURRENT posture/sim state discovered mid-run is
likewise quarantined and locks permission — current safety state is not
ordinary evidence.

**Fixed temporary filenames are forbidden for atomic state replacement.**
Every atomic write uses a unique same-directory temp (pid + counter +
random) renamed into place; a writer cleans up only its own temp. Unique
temps prevent rename collisions; the control lock prevents lost updates —
both are required.

## ONE CONTROL DOOR (PERSIST-0B)

`persistence/control-plane.js` is THE control-coordination layer: the
authenticated HTTP cockpit and the local CLI both walk through it, so the
durable permission-increase gate cannot be bypassed by picking a different
door. The requirement is DURABILITY, not HTTP authentication — the CLI
keeps its local trust model. CLI KILL/CAGE/VETO: local latch FIRST, then
durable attempt; failure leaves the restriction standing for the control
sync. CLI CLEAR: persistence decision FIRST — outage, boot, and
required-unconfigured all refuse; only explicit local-only development
(no DATABASE_URL, durability not required) keeps documented local CLEAR.
The simulated-P&L drill hook (`cobra state simulate`) is development-only:
it refuses outright whenever durability is required (published
deployment), with no override.

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

**Validation precedes application (PERSIST-0A).** Every durable
structured safety row (controls, posture, sim/lock, ledger rows) re-earns
its way through a strict pure validator before it may be applied or
served. An invalid durable CONTROL row is NEVER interpreted as CLEAR — it
fails the restore, locks permission, and is never silently repaired; an
invalid durable posture/sim row is never written locally and permission
stays restricted; invalid durable ledger rows are withheld and counted.

**Local files never automatically override durable current state.** The
exact startup rules for posture and sim/lock: durable invalid → restore
fails, permission locked; no local + durable valid → adopt durable; local
valid + no durable → push local durable; both valid and equal → nothing
rewritten; both valid and different → **LESS PERMISSION WINS** and the
winner becomes both truths via a revision-guarded write; local
malformed/invalid → quarantined (`*.quarantine-<ts>` copy, nothing
deleted) and durable truth adopted. Posture permission ranking:
RETREAT < COILED < DIGESTING < STALKING < STRIKE (RETREAT grants least
permission and wins any ambiguity; unreachable STRIKE/DIGESTING remain
fail-closed by the posture machine itself). Sim/lock ambiguity resolves to
whichever state trips the HIGHER lock level for today's session; a sim row
for another date is inert; ties keep the durable authority.

**Runtime state has no last-write-wins path.** `saveRuntimeState`
requires a proven-fresh `expectedRevision` for a trusted overwrite;
anything stale or unproven reconciles toward less permission inside the
row-locked transaction and is counted (`runtimeStateConflicts`). After
startup, a bounded snapshot watcher in the pump keeps the durable CURRENT
`posture.json` / `sim_pnl.json` true: content-digest change detection (no
gratuitous writes), validation before persisting, and DURABLE_CONFIRMED
only after the database acks.

## DURABLE EVENT IDENTITY (schema 2)

Local file line numbers restart at 1 on every fresh deployment, so
`(source_file, line_no)` can never be global durable identity — a new
deployment's line 1 must not vanish as the old deployment's "duplicate".
Control/security audit rows and posture transitions are identified by a
deterministic `event_id = sha1(streamType | canonical key-sorted JSON)`
computed with node:crypto before insert (an upstream event id, where one
exists, is preserved as the identity); `source_file`/`line_no` survive as
provenance/debug metadata only. Same event_id + identical content →
deterministic duplicate; same event_id + different content →
`EVENT_ID_CONTENT_CONFLICT`, refused, counted, health degraded. Ledger
rows follow the same truth: an `prediction_id` collision with different
content is `LEDGER_ID_CONTENT_CONFLICT` — corruption, not replay; first
durable truth stands, permission locks pending manual resolution.

## THE OPERATIONAL LEDGER SEES ITS DURABLE HISTORY

The running app's ledger consumers (allPredictions/allFills/allExits,
openPositions, realized P&L, daily locks, the cockpit summary) read local
JSONL. A durable database Serpent does not consult is an archive — so on
startup the COMPLETE validated durable ledger (chunked keyset pagination,
never truncated to the 500 display bound) is merged with validated local
pending rows and atomically materialized into the reconciled canonical
local mirror files BEFORE ledger consumers run. Merge rule per
`prediction_id`: identical content → one truth; durable-only → restored
locally; valid local-only → preserved and queued for durable persistence;
different content → conflict (above). Pre-reconciliation local files with
malformed/invalid/conflicting rows are preserved as quarantine copies —
local pending evidence is never blindly overwritten, and nothing is
deleted.

## THE MEMORY CONSUMER FACADE

`persistence/memory-view.js` is THE canonical Memory read facade for
future consumers (UI-1, BRAIN, PHILOSOPHER); they consume it rather than
choosing a storage implementation. It lives outside closed MEMORY-0C and
rewrites nothing inside it. Durable configured + restored → durable
PostgreSQL Memory is authoritative, merged with validated current-process
PENDING local records, deduped by canonical id, with durability status
preserved separately (`meta.durable` / `meta.pendingLocal`); durable
history is never hidden because a fresh process's local `events.jsonl` is
empty. Explicit local-only development mode → the local MEMORY view.

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

## PRODUCTION PREPARATION WARNING — SHARED DATABASE_URL (PERSIST-0B §18)

**Remove the manually Shared DATABASE_URL before binding/provisioning the
managed Production database. Development will continue receiving its
managed Development DATABASE_URL; Production must receive its own managed
Production DATABASE_URL.** A manually maintained Shared-scoped
DATABASE_URL must never override Replit's environment-specific managed
bindings — the accidental publish from `d6b1814` inherited exactly such a
Shared value, could not resolve it, and (correctly) spent its life inside
PERSISTENCE_PERMISSION_LOCK. The URL itself is never logged or printed.

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

## RESTORED MEANS EVERYTHING STARTED (PERSIST-0B)

`restored` becomes true only after connect, migrations, durable-state
validation, restore/reconciliation AND the durability pump / current-state
sync machinery have ALL initialized. Any startup failure leaves
`restored=false` with the retry loop armed, and a configured/required
durable process carrying an unresolved `failureCategory` can never have
`permissionLock=false` — restored never launders a failure into
permission. The row-locked CLEAR transaction revalidates the durable
control row it is about to clear (a corrupt row refuses CLEAR, engages the
integrity lock, and is never rewritten into permission), and the
restrictive-snapshot path likewise never silently repairs or overwrites a
malformed durable control row. Operational full-ledger restore is
COMPLETE_VALID or locked: a withheld corrupt durable row (which could BE
the open position), a runtime ledger id/content conflict, or unreadable
local pending ledger evidence each engage the integrity/permission lock —
missing or corrupt position history is never interpreted as "no
position". The ephemeral pump cursor file is not durable truth: a
malformed `cursors.json` is quarantined for audit and the spools replay
from byte 0, idempotent identities collapsing the duplicates.

## SPOOL INTEGRITY IS HEALTH

A malformed complete spool line is LOST SOURCE EVIDENCE: it is counted
(`spoolParseErrors`), logged loudly, and the tail advances past it —
never invented, never repaired, never rewritten in the source, and never
pretended durable. A pump read exception counts (`pumpReadErrors`) and
degrades health. `ledgerIdConflicts`, `auditIdConflicts` and
`runtimeStateConflicts` are likewise surfaced; any non-zero
evidence-integrity counter degrades health. Connection failures are
classified by ONE shared classifier across connect/probe, `query()` and
`tx()` — a connection that dies inside a transaction marks the database
unreachable exactly as a dead query does, so the permission lock always
tells the truth. A stopped persistence runtime clears its retry timer and
pump; no background retries or duplicate loops survive `stop()`.

## STALKING / HYPED — SAFE_TO_FORGET (classified)

`state/stalking.json` and `rumint/hyped.json` are explicitly classified
**SAFE_TO_FORGET / RECONSTRUCTABLE_TRANSIENT** and are NOT persisted to
PostgreSQL: forgetting them on redeploy REDUCES trading permission rather
than increasing it (an un-stalked symbol cannot arm anything), entries
carry TTLs and decay by design, and the live RUMINT/WideEye sensors
re-nominate from current evidence. A fresh deployment therefore begins
with an empty stalk set; expired rumors are never restored merely for
continuity.

## FAIL CLOSED, ALWAYS

Rows are validated before being applied; an internally inconsistent
durable safety row means less permission, never a silent repair, never a
downgrade of a safety state. Persistence health
(HEALTHY/DEGRADED/UNAVAILABLE plus clocks, error counters, migration
version, configured/reachable flags) is internal, surfaced through one
safe status field — no circular dependency: persistence reads Memory's
files and validator; Memory never reads persistence.
