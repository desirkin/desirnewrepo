# RUMINT DOCTRINE — social chatter intelligence

**Status: ARMED + DURABLE (RUMINT-R1).** `rumint.enabled: true` in config
(env `RUMINT_ENABLED=false` force-disables regardless of config; when
disabled the module makes **zero network calls**). The tiered poller runs
inside `fly.js` within the S-1 budget, with its statistical memory anchored
in the durable core. Exactly two consumers exist:

1. **Nomination** — `zVelocity KNOWN AND ≥ 3 AND acceleration KNOWN AND
   > 0` arms that symbol into the stalk set (60-min TTL; an unconfirmed
   rumor decays). The global posture shows STALKING while the set is
   non-empty. Logged as `RUMINT NOMINATION <symbol> z=<x>`.
2. **HYPED** — top-decile of *fully observed* overnight chatter, finalized
   at 06:00 ET as ONE canonical session snapshot; strictness marker for the
   future confirmation engine.

STRIKE and DIGESTING remain unreachable (`NotYetImplemented`); a unit test
statically proves no strike-capable module imports RUMINT or the stalk set.

## What RUMINT may and may not do

**Rumor arms. Order flow fires.** (Doctrine #5.)

- RUMINT may only ever **nominate arming** — a candidate for
  COILED → STALKING. Nomination is not permission: the state machine's own
  rules still govern the transition.
- RUMINT may **raise confirmation strictness** via the HYPED flag.
  **Tier C + HYPED = stricter confirmation, never looser** (Doctrine #6).
- RUMINT must **never contribute to a STRIKE decision**. No strike sizing,
  no strike timing, no entry price, no exit logic may read a RUMINT field.
- No confidence, rumor score, AI score, weighted vote, authority score or
  any other synthesized conviction number exists here. Sentiment shift is
  descriptive only. RUMOR-2 (multi-source ears) is a separate future phase;
  this detector is StockTwits-only and stores no post bodies or authors.

## RUMINT-R1 — the truth and durability architecture

The R1 repair exists because Production proved the old ear could mostly not
evaluate itself: 93% of polls had `zVelocity = null` because local-disk
baselines vanished on every republish, unobserved hours were confused with
quiet hours, and HYPED kept two diverging truths (header H1 over an empty
Rumor Room). The repair changes NO thresholds — it makes the evidence good
enough to evaluate.

### Module layout

- `rumint/truth.js` — the pure core: canonical message IDs, page ingestion,
  signal math, HYPED snapshot, event identities, strict checkpoint
  validation, all hard bounds. No I/O.
- `rumint/stocktwits.js` — the ONLY network path (dark-gated first), plus
  read-only local-checkpoint views for the cockpit.
- `rumint/poller.js` — orchestration: durable init gate, evidence-first
  ACK, pending debt, canonical HYPED roll, failure recovery, CANCEL
  shutdown, status.
- `persistence/rumint-checkpoint.js` — the injected tri-state durable store
  (`serpent_rumint_checkpoint`, migration 4) and the one-time bootstrap
  reader over durable RUMINT_POLL Memory. Wired in `fly.js`; `rumint/`
  never imports persistence or Memory machinery.

### Observed hours, never invented hours

Buckets are keyed by **absolute UTC hour** (`YYYY-MM-DDTHH` in UTC) so the
duplicated 01:00 ET hour of a DST fall-back night can never collapse; ET
session date and hour-of-day are derived per instant for HYPED semantics.
An hour is OBSERVED only when a provider poll genuinely succeeded in it
(`successfulPolls > 0`) or durable bootstrap proved it. An observed hour
with zero accepted messages is **evidence** (count = 0); an hour RUMINT did
not listen through is **UNKNOWN** and is never backfilled as zero.

- `historyBucketCount` = observed historical hours. `< 24` →
  `zVelocity = null`, reason `INSUFFICIENT_HISTORY`.
- `≥ 24` with zero standard deviation → `null`, reason `ZERO_VARIANCE`
  (explicitly distinct).
- Acceleration (`vNow − 2·vPrev + vPrev2`, formula unchanged) is KNOWN only
  when all three hours are observed; otherwise `null`, reason
  `INSUFFICIENT_CONTIGUOUS_OBSERVATION`. An outage never manufactures
  positive acceleration.
- Every poll records the full gate: `zAvailable / zPass /
  accelerationAvailable / accelerationPass` and one controlled decision
  reason (`INSUFFICIENT_HISTORY`, `ZERO_VARIANCE`, `Z_BELOW_THRESHOLD`,
  `ACCELERATION_UNAVAILABLE`, `ACCELERATION_NOT_POSITIVE`, `NOMINATED`).

### Message identity and provider truth

Provider message IDs are canonical positive-integral **decimal strings**
compared exactly via BigInt — no lexicographic ordering, no float
precision, no coercion. Missing/nonnumeric/negative/fractional/unsafe IDs
are rejected AND counted. A per-response seen-set collapses same-page
duplicates; a bounded durable recent-seen-ID cache (256/symbol, evictions
counted) is the dedupe authority, so a valid unseen message below the
diagnostic high-water mark is not silently rejected —
`coverage: SAMPLED_SINGLE_PAGE` is stated, never "COMPLETE". The public
symbol-stream endpoint exposes no documented cursor; none is invented (no
Firestream, no new credentials). Messages older than 24h are rejected as
ancient replay (counted); late-but-legitimate messages update their correct
historical hour. HTTP-200 with an unusable body is
`PROVIDER_SCHEMA_ERROR` — never a successful zero-message poll, never an
observed-zero hour. Mapping is the explicit `${coin}.X` convention plus a
bounded override table; no fuzzy matching, unmappable coins get
`UNMAPPED_PROVIDER_SYMBOL`.

### Durable checkpoint and the initialization gate

One bounded revisioned checkpoint (validated strictly on load — §10 of the
ticket: versions, enums, bounds, `bull + bear ≤ count`, canonical IDs,
hour keys, pending identities) carries: per-symbol baselines with buckets,
watermarks and seen-ID caches, the canonical HYPED session state, provider
health (failure streaks, bounded cooldowns), the global backoff and rolling
request budget, and pending source-event debt. It is saved locally
(atomic `rumint/checkpoint.json`) AND durably (PostgreSQL) every tick;
`localDurability` and `deploymentDurability` are separate truths — a
durable-save miss is `AT_RISK` and degrades RUMINT even when local disk
succeeded.

Before initialization, RUMINT emits nothing authoritative. Tri-state load:
LOADED (validated → adopt), NOT_FOUND (adopt a valid local checkpoint, else
one-time bootstrap, else honest FRESH_START), UNAVAILABLE (WITHHOLD:
`WITHHELD_DURABLE_UNAVAILABLE`, retry every tick — an unreadable history is
NEVER an empty history), NOT_CONFIGURED (local development mode). A
malformed checkpoint is `WITHHELD_INVALID_CHECKPOINT` — degrade, retry,
never guess.

**Bootstrap** (first deployment of the fix): when the durable row is
honestly NOT_FOUND, proven facts are reconstructed from durable
RUMINT_POLL Memory — the max cumulative hourly velocity actually observed
per symbol-hour, marked `BOOTSTRAPPED_FROM_DURABLE_RUMINT_POLL`, bull/bear
honestly null. No retroactive nominations, no retroactive HYPED. The
watermark stays unknown until the first live page initializes it
(`WATERMARK_INITIALIZED`) — that page's pre-existing messages are never
counted as fresh chatter, and live messages never double-count into
bootstrapped hours.

### Evidence-first ACK, pending debt, stalking order

A poll's candidate baseline is adopted only after its evidence is appended
to `rumint/events.jsonl` or held as bounded pending debt (256, descriptive
polls evicted before nominations/HYPED; drops are counted data loss). A
pending record replays with its EXACT prepared content and semantic
`sourceEventId` — never a regenerated timestamp. Nomination evidence lands
(or is durably owed) BEFORE `stalk()`; an unrecorded nomination never arms
stalking, and a restart never resurrects stalking from historical
nomination evidence (stalking stays SAFE_TO_FORGET). If source, local and
durable writes ALL fail with evidence in RAM: `FAILED_DURABILITY` with
`unpersistedPendingEvidence` — the documented catastrophic boundary, never
a silent claim.

Identities are semantic sha1 over canonical key-sorted JSON: a poll is
unique to its actual provider observation; a nomination is deterministically
linked to (and distinct from) its triggering poll; a finalized HYPED
session hashes provider + sessionDate + state + set, so a same-date restart
dedupes and a genuinely different set is new evidence.

### The ONE canonical HYPED snapshot

`{sessionDate, state, symbols, finalizedTs, identity, coverage}` drives
`status.json`, `hyped.json`, the header H count, the Rumor Room, Attention
Tier-3 and the checkpoint — no consumer recomputes its own array (the
Production H1-vs-empty-room divergence is structurally impossible).
Overnight window: 00:00:00–05:59:59 ET; before 06:00 ET the state is
`BUILDING` and never promoted. At/after 06:00 ET it finalizes: a symbol is
eligible only with observation in ALL six overnight ET hour labels;
eligible-and-nonzero symbols rank (sum overnight chatter, top
`ceil(n/10)`, min 1). No eligible symbols → `PARTIAL`
(`INSUFFICIENT_OVERNIGHT_COVERAGE`); eligible but all quiet → a truthful
`EMPTY` (real H0); computation failure → `UNAVAILABLE` (§93: never a fake
H0 — the header shows `H?`, `H…` while BUILDING). The finalized set holds
unless the observed evidence itself legitimately changes (late messages in
observed overnight hours), in which case every consumer moves together
under a new identity. ET date rollover returns to `BUILDING` — yesterday's
HYPED is never worn as today's.

### Failure recovery, budget, shutdown

Three consecutive transient failures mark a symbol
`TEMPORARILY_UNAVAILABLE` with a bounded cooldown ladder (15m → 30m → 60m
max); at expiry the next poll is the probe — success clears the streak and
emits `RUMINT_RECOVERED`, failure extends the bounded cooldown. Never
permanent deafness; the state persists across republish. A 429 honors
Retry-After within [60s, 60m] (else the configured 15m), and both the
backoff and the rolling-hour request budget (120/hr, 2.1s spacing,
cadences hot 300s / warm 1200s — all unchanged) survive republish, so a
fresh deployment cannot hammer the provider. Shutdown is CANCEL:
`stopped` is set first, in-flight provider work is aborted, a response
landing after stop mutates nothing, and the final checkpoint is the exact
restart truth.

### Status and the Rumor Room

`status.json` carries the ear's real readiness: symbols
tracked/ready/warming/unavailable with per-symbol reasons (`READY`,
`WARMING_HISTORY`, `ZERO_VARIANCE`, `TEMPORARILY_UNAVAILABLE`,
`UNMAPPED_PROVIDER_SYMBOL`, `PROVIDER_SCHEMA_ERROR`,
`BASELINE_UNAVAILABLE`), poll/success clocks, budget and backoff, local vs
deployment durability, pending evidence and failure counters, init state,
and the canonical HYPED snapshot. The Rumor Room states `EARS ON · N
POLLED`, `BASELINES READY · X/N`, warming/unavailable counts and the HYPED
state, labels HYPED coins as **OVERNIGHT ATTENTION** (distinct from a
nomination), and says `NO QUALIFYING SOCIAL SIGNAL` only when the ear is
healthy and HYPED is a known READY/EMPTY state — "quiet" and "unable to
calculate" can no longer be confused.

## Signal contract

```json
{
  "symbol": "SOL.X",
  "velocity": 14,
  "zVelocity": 2.7,
  "zReason": "KNOWN",
  "acceleration": 14,
  "accelerationReason": "KNOWN",
  "sentimentShift": 0.18,
  "historyBucketCount": 41,
  "gates": { "zAvailable": true, "zPass": false, "accelerationAvailable": true, "accelerationPass": true },
  "decision": "Z_BELOW_THRESHOLD"
}
```

- `zVelocity` — current-hour velocity vs the symbol's OWN trailing observed
  hourly baseline (null until ≥24 observed hours; null on zero variance —
  each null carries its reason). A symbol is compared with itself, never
  with BTC's firehose.
- `sentimentShift` — bull share of self-labeled messages, last 2 hours
  minus trailing baseline (null below minimum label counts).
- Credibility remains `"RUMINT"` — self-labeled retail chatter is the
  lowest rung of the credibility ladder.

## Budget (S-1, unchanged)

≤120 requests/hour total, ≥2.1s spacing, 429 → full bounded back-off.
Hot (majors + stalking): 5 min. Warm (rest of universe): 20 min.
