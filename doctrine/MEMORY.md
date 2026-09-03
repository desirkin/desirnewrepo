# MEMORY DOCTRINE — one nervous system (MEMORY-0)

> **Serpent must never confuse having more data with having more evidence.**
>
> **Every sense may observe. No sense may manufacture certainty.**
>
> **UNKNOWN is not FALSE. MISSING is not NEGATIVE. NEUTRAL is not
> CONTRADICTORY.**
>
> **Evidence must preserve origin, knowledge time, freshness, and
> independence.**
>
> **MEMORY-0 does not decide whether Serpent should bite. It merely gives
> every future decision-maker a truthful common view of what Serpent
> knows.**
>
> **Historical memory and live memory must use compatible semantics so that
> Serpent cannot learn one language and hunt in another.**
>
> **A new sensor does not become a new gate merely because it has been
> connected to memory.**

MEMORY-0 is not intelligence. It is what makes intelligence possible. It
carries signals; it does not decide what they mean. Nothing in it says BUY,
nothing says SELL, nothing lowers a gate, nothing grants a strike.

## ARCHITECTURE

```
SENSES (tape, wide eye, rumint, gateway, cost, state — UNCHANGED)
  |
  |  (each sensor's own append-only event stream, exactly as before)
  v
ADAPTERS (memory/adapters.js — thin, pure, one-way)
  |
  v
CANONICAL MEMORY BUS (memory/bus.js — validate, dedupe, order)
  |
  +----> LIVE APPEND-ONLY MEMORY (data/memory/events.jsonl + manifest)
  |
  +----> READ-ONLY SUBSCRIBERS (future; deep-frozen envelopes, contained errors)

CHILDHOOD (immutable archive)
  |
  v
READ-ONLY CHILDHOOD INTERFACE (memory/childhood.js)

NO PATH FROM MEMORY-0 TO EXECUTION.
```

## THE CANONICAL ENVELOPE — `serpent-memory-1`

```
{ id,                // deterministic: sourceModule|symbol|eventType|(sourceEventId or ts)
                     // sha1 — a restart cannot duplicate the same source event
  schemaVersion,     // 'serpent-memory-1'
  ts,                // the market/event time the observation applies to (NOT retrievedTs)
  symbol,            // canonical Kraken/Serpent symbol, or null — never invented
  sourceModule,      // documented enum below
  eventType,         // UPPER_SNAKE, descriptive, never directional beyond the source
                     //   good: WIDEEYE_RIPPLE, MARKET_SNAPSHOT, GATEWAY_STATUS
                     //   forbidden shape: COIN_ABOUT_TO_PUMP
  evidenceFamily,    // one family or a small coherent set — ONE source observation,
                     //   never N independent confirmations
  observationState,  // KNOWN | UNKNOWN | UNAVAILABLE | STALE | DEGRADED (data quality, never direction)
  payload,           // the observation itself; JSON-clean (no NaN/Infinity/undefined/functions)
  dataAvailability,  // per-field availability states — true/false is NOT a state
  provenance,        // { source, sourceTs, availableTs, retrievedTs, kind: live|historical,
                     //   form: raw|derived, sourceInputs (required when derived) }
  correlation,       // { eventId, parentEventId, sourceEventId, clusterId } — nullable
  lifecycle }        // { createdTs, lastUpdatedTs, expiresTs|null, ttlSec|null, supersedesId|null }
```

**Identity (MEMORY-0A):** where an upstream natural id exists it is
incorporated; otherwise identity derives from a stable FINGERPRINT of the
original source record (canonical key-sorted hash plus stream identity) —
never the whole-second timestamp alone. Two different records inside the
same second get distinct memories; the byte-identical record replayed after
a restart deduplicates. No randomness, no Date.now(), no observation time
in identity.

**Source modules:** TAPE · WIDEEYE · RUMINT · GATEWAY · COST · STATE ·
CHILDHOOD — reserved for future senses (names only, nothing implemented):
MICROSTRUCTURE · GOVERNANCE · GHOST · INFRASTRUCTURE · FLOW · PHILOSOPHER.

**Evidence families (controlled taxonomy):** MARKET_PRICE · MARKET_VOLUME ·
ORDER_FLOW · LIQUIDITY · SOCIAL_ATTENTION · RUMOR ·
EXCHANGE_INFRASTRUCTURE · EXECUTION_QUALITY · STATE_CONTROL ·
HISTORICAL_CONTEXT. Reserved names for later: DERIVATIVES, ON_CHAIN,
CAPITAL_FLOW, GOVERNANCE, EXCHANGE_INTEGRATION, NETWORK_INFRASTRUCTURE,
OFFICIAL_NEWS, DEVELOPER_ACTIVITY, BLOCKSPACE, MACRO, EXPERIMENTAL.
zVol and zRet are two fields of one Wide-Eye observation — one source, two
families at most, never two independent facts.

**Availability states** describe data quality/availability only. A failed
RUMINT poll is `UNAVAILABLE`, never `bearish=false`. The distinction
survives serialization and is enforced by the validator.

## PROVENANCE — THE CHILDHOOD TRUTH STANDARD, UNWEAKENED

The B-0B.2A clock doctrine is controlling here too: a derived field may not
claim knowledge earlier than any actual contributor, and must not inherit
later timing from sources that did not contribute. `sourceTs`,
`availableTs`, `retrievedTs` keep their three distinct meanings; nothing is
retrieved before it was available; evidence never retrieved carries the
honest sentinels (`UNKNOWN`, `NOT_RETRIEVED`), never fabricated clocks.

## CORRELATION — RELATED IS NOT INDEPENDENT

`eventId` groups observations of one continuous episode (a gateway
incident's transitions share its incident key). `clusterId` marks
repetitions of one underlying item (five messages repeating one rumor are
one cluster, not five rumors). `sourceEventId` preserves the upstream
source's own identity. MEMORY-0 provides the fields and preserved identity;
it builds no association logic and computes NO independence score — BRAIN-1
will later decide whether five signals are five facts or one fact repeated
five ways, from this raw structure.

## PERSISTENCE — `data/memory/` (gitignored, zero-dependency)

Append-only `events.jsonl`: one record per line, one synchronous append per
record (no partial lines; SIGTERM-clean). `manifest.json` (atomic
temp+rename, throttled) records schemaVersion, memoryVersion, record count,
counts by module/family/availability, duplicates suppressed, invalid
rejected, and known gaps. **Deduplication** is deterministic-id based and
restart-safe: the id index is rebuilt from the file at startup, so a
restart can never write the same source event twice. **Recovery is
streamed** (MEMORY-0A): fixed-size chunks split only at newline bytes —
lines and multibyte characters spanning chunk boundaries reassemble
exactly, and the full JSONL store is never materialized into RAM; only the
id index and the 500-record recent cache are retained. **Every recovered
record is RE-VALIDATED** through the same canonical validator new evidence
faces: valid JSON with an invalid envelope is quarantined as
`SCHEMA_INVALID` (with its validator errors), a torn line as
`JSON_PARSE_CORRUPT` — either way COPIED to `events.quarantine.jsonl` with
its position, the original file untouched, health DEGRADED, the failure
logged. Quarantined records never enter indexes, counts, or query results
(query fallbacks are gated on the validated id index). Evidence is never
silently repaired and never silently discarded. **Manifest identity
survives restarts:** `createdTs`, `lastWriteTs`, and the lifetime counters
(`duplicateSuppressedCount`, `invalidRejectedCount`) are cumulative and
preserved via the manifest; evidence-derived counts are always rebuilt from
the events themselves; if records exist but the manifest is lost, the
creation time is honestly `null` — never invented. `persistenceErrors` and
ingestion counters are session-local. **Retention:** nothing is
auto-deleted; retention/compaction is a later operational ticket, and the
id-only dedup index remains the documented growth limitation until then (no
probabilistic dedup — a false positive would silently lose evidence).

## FAILURE — MEMORY FAILS DARK

A memory persistence failure logs loudly, sets health to DEGRADED/FAILED,
and refuses to fake success — and it never crashes market collection, never
touches trading state, never alters a sensor. One bad subscriber cannot
corrupt the publisher (exceptions contained and counted). The mirror's
timer is unref'd: memory cannot even keep the process alive.

## HEALTH

`bus.health()` (read-only, frozen): status, lastAcceptedTs,
lastPersistedTs, queueDepth, acceptedCount, rejectedCount,
duplicateSuppressedCount, persistenceErrors, subscriberErrors,
schemaVersion, memoryVersion.

## QUERY INTERFACE — ALWAYS BOUNDED

`getRecent({symbol, sourceModule, limit})`, `getByEventId`,
`getByClusterId`, `getSince(ts, filters)`, `getLatestBySource`. Default
limit 50; hard maximum 500 — larger requests are clamped, never honored.
Search order (MEMORY-0A): the recent cache first; only when the match set
is unsaturated AND older records exist does the query widen to at most the
last 8MB of file tail — results merge without duplication, ordered
deterministically ascending by ts, newest N kept. An event older than the
recent 500 but inside the tail window IS found. There is no "load entire
memory into RAM" call, deliberately.

## CHILDHOOD BRIDGE — READ-ONLY

`memory/childhood.js`: `getChildhoodManifest()`, `getObservationById(id)`,
`getOutcomeForObservation(id)`, `queryObservations({symbol, fromTs, toTs,
population, trackRole, limit})` (same bounds). Files are opened for reading
only; results are frozen; the module exports no write capability. The
archive remains immutable evidence. No similarity search, no analog
ranking, no learning here.

## THE DARK-MIRROR BOUNDARY

Existing behavior is authoritative. Adapters observe the sensors' own
already-written event streams (file tails); they import nothing from any
sensor and feed nothing back into nomination, posture, stalking, risk,
strike, UI decision state, or thresholds. **Startup capture boundary
(MEMORY-0A):** the mirror opens BEFORE the live sensors start writing, so
their startup records are remembered; streams that already existed at
mirror open are anchored at EOF (pre-existing history is Childhood's
domain), while a file born after the mirror opened — a new daily tape
session, say — is new live evidence and is read from byte zero.
**Ingestion honesty:** a malformed sensor line is skipped (sensor-owned
files are never rewritten or quarantined by memory), counted
(`sourceParseErrors`, alongside `adapterErrors` and `mirrorReadErrors` in
health), logged loudly, and degrades memory health — ingestion loss is
never pretended away, and it never alters trading state. The architectural test asserts,
from source, that no module outside `memory/` (except the `fly.js`
composition root) references memory, and that no `memory/` module imports
any sensor or state-mutating module. Memory observes state; it can never
cause a state transition — no such path exists to misuse.

## EVIDENCE IS DATA, NEVER INSTRUCTIONS

Raw social text may contain anything — as a string value it is stored
verbatim and never interpreted as program instructions. Envelopes whose
STRUCTURE carries trading verbs (order/side/size keys) are refused at
validation. Nothing in memory is executable.

## RELATIONSHIP TO WHAT COMES NEXT (doctrine only — none of it built here)

- **BRAIN-1** will read canonical memory and decide what evidence means —
  support, contradiction, independence — contextually. MEMORY-0 stores the
  raw identity structure it will need and no conclusions.
- **PHILOSOPHER-0** (a future LLM counsel) will receive BOUNDED evidence
  packets assembled from these query interfaces. It will never hold Kraken
  or trading credentials, and its words will be advice-shaped data, not
  commands. No LLM integration exists in MEMORY-0.
- Setup classification, edge decay, rumor propagation graphs, independence
  scoring: all later tickets, all designed to plug into this contract.

## VERSIONS

Memory system: **MEMORY-0** · envelope schema: **serpent-memory-1** — both
recorded in `data/memory/manifest.json` and here.
