# Adaptive core v1

This module is a bounded, state-only learner for research and, only after a
separate trusted qualification, a possible PAPER ranking input. It does not
start collectors, call providers, submit orders, change risk, activate Judge,
or grant itself authority. It is not wired into the runtime by this change.

## Frozen procedure and target

`sealAdaptiveProcedure` binds the parent policy, consumer contract, feature
recipe, strategy registry, target, update algorithm, numerical limits, and
effect registry into one immutable procedure digest. Changing any of those
values creates a different procedure and cannot reuse the existing journal.

The v1 forecast is an actual number in `[0,1]`: the estimated probability that
the existing candle-label recipe's 60-minute log return is positive,
conditional on an existing strategy being eligible at the saved decision.
It is explicitly uncalibrated until evaluated prospectively. It is not the
probability of an executable fill, strategy profit, or after-cost success.

The target follows `learning-candle-labels-1` exactly:

- anchor = `ceil(decisionTs / 60,000) * 60,000`;
- reference = close of the one-minute candle ending at that anchor;
- target end = anchor plus 60 minutes;
- target = one only when the matured 60-minute log return is positive;
- known-at = the label producer's maximum of horizon end, archive creation,
  and series retrieval clocks.

The forecast is persisted before the outcome and does not claim that the
anchor reference price is known at forecast time. Only an outcome carrying
the exact sealed target end can be scored. A missing label is retained without
an update; a label outside the frozen maximum-delay window is also retained
but cannot update state.

The procedure also seals a five-second maximum decision-to-persistence delay.
A prediction cannot reference model state newer than its decision, and its
feature-recipe digest must equal the procedure's exact parent recipe. This
limits backdating and stale writes. The core still receives only a fact digest:
it does not by itself prove the raw facts' first-write custody. Integration must
bind that digest to the source-owned, as-of prepared-fact record before calling
the core.

## Numerical update

Each eligible strategy's saved probability is scored with Brier loss before
the update. The immutable procedure applies a bounded residual step and then
projects the probability into a bounded reward/risk-point rank offset. Per
strategy, per primary episode, and lifetime cumulative movement ceilings are
all explicit. Exhaustion remains visible in status and is never reset because
of restart.

The primary identity comes from the existing `opportunityIdOf` law. V1 has one
sealed horizon, so `(procedure, opportunityId, 60m)` can produce at most one
prediction, one outcome, and one update. Variant names and account identities
are not accepted inputs and therefore cannot multiply evidence. Additional
horizons require a new target/procedure version; they do not create a new
primary market episode.

## Store and restart behavior

`createAdaptiveStore` owns one dedicated directory containing only
`writer.lock`, `journal.jsonl`, and `head.json`. It uses an exclusive, non-expiring writer
lock and never guesses that a lock is stale from its age or PID. Each journal
event has a sequence, previous digest, content digest, and bounded byte size.
Replay validates the complete chain and deterministically recomputes every
state transition. A partial line, malformed event, changed procedure, custody
loss, or external file mutation fails the whole store closed; records are not
skipped or repaired.

An update event stores the immutable outcome, pre-update scores, bounded
update, and expected next-state digest. After the journal fsync, the store
atomically replaces and directory-syncs an acknowledged head binding the event
count, terminal digest, journal bytes, and state digest. Replay must agree with
that head. A clean whole-event suffix truncation, or a crash leaving the journal
ahead of the acknowledged head, therefore fails closed instead of appearing as
a legitimate older state. It does not append the complete growing
history or a complete state snapshot. Replayed state is fixed-size for a fixed
strategy registry, while the journal and in-memory identity indexes remain
explicitly bounded by configured event and byte ceilings. Reaching a ceiling
latches the store; no evidence is silently forgotten and no empty replacement
history is commissioned.

Durability is `LOCAL_FILESYSTEM_ONLY`: file and directory syncs protect normal
local restart, but the store is not safe across a Replit republish and requires
a separately commissioned production-durable owner before deployment.
The local head cannot detect rollback of the entire directory to one mutually
consistent older journal/head pair; a production external monotonic anchor is
still required for that threat.

## API

```js
const store = createAdaptiveStore({ rootDir, procedure, clock });
const core = createAdaptiveCore({ store, procedure, clock });

core.recordPrediction(input); // immutable pre-outcome probability
core.recordOutcome(input);    // missing/late retention or exactly-one score/update
core.snapshot({ mode: 'SHADOW', nowTs, qualification: null });
core.status();
store.close();
```

All snapshots have `application.enabled === false` and `authority === 'NONE'`.
Supplying a truthy or signature-shaped `qualification` value does not enable
the result. The existing promotion owner must later verify a versioned,
procedure-bound qualification and an after-cost policy comparison before a
ranking offset can affect PAPER.

Only `RANKING_SELECTION` has a future integration shape. `ENTRY`, `EXIT`, and
`SIZING` are explicitly unsupported until each has its own registry,
prospective evidence, after-cost qualification, and consumer contract.

## Operational constraint

The v1 store performs synchronous append and fsync for deterministic local
durability. It must run on a dedicated learner worker or otherwise outside the
collector, Watch, and Judge ingestion loops. Direct hot-path composition is an
activation blocker, not an optimization to postpone.

Relevant existing review references are `docs/ADAPTIVE-IMPLEMENTATION-MAP.md`,
`docs/JUDGE-PAPER-AUDIT.md`, and `docs/JUDGE-CLOSEOUT-ACCEPTANCE.md`. Those
documents reinforce that learned ranking is a default-off, bounded consumer
port and that qualification must be re-derived rather than inferred from a
flag or record digest.
