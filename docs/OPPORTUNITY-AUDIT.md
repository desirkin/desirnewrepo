# Prospective opportunity audit

## What this module establishes

`learning/opportunity-audit.js` defines one bounded probability sample of the
complete accepted Kraken discovery catalog. The sample is selected before a
ticker result, WideEye interestingness verdict, cooldown, nomination, refusal,
Judge decision, action, or future outcome can enter the call. The complete
catalog denominator and the durable seed are part of the sealed frame.

The audit answers an observation question: what happened to a probability
sample of opportunities that existed before the normal interesting-asset
filter? It does not authorize training, paper decisions, live decisions,
orders, provider calls, or a new trading simulator.

Each population member uses the existing primary identity:

```js
opportunityIdOf({
  canonicalCoin,
  decisionTs: frameTs,
  captureRecipeVersion: 'opportunity-audit-capture-1',
  datasetId: catalog.contentId,
})
```

Horizons, strategy variants, post-filter decisions, and outcomes never mint a
new primary opportunity.

## Sampling law and its limit

The population is first sorted by a digest of the venue-native catalog market
identity. A SHA-256 counter stream drives Fisher-Yates selection. Each bounded
integer draw uses rejection sampling, not `%` alone, so there is no uint32
modulo bias. A fixed sample of size `k` is taken without replacement from `N`
catalog members. Under the recorded design assumption, every member has the
same positive observation-inclusion probability `k / N`. A zero-sized sample
is refused rather than represented as probability zero.

This is a pseudorandom design, not an unconditional theorem that the finite
SHA-256 mapping is exactly random. Its probability interpretation is
conditional on an unpredictable, uniformly generated 256-bit seed and the
recorded SHA-256 PRF assumption. When `sealAuditFrame` generates the seed with
`crypto.randomBytes(32)`, the frame records:

```text
seedProvenance: CRYPTO_RANDOM_BYTES_32
designInferenceEligible: true
```

An explicit seed is supported for deterministic tests and exact replay. Such a
frame records `CALLER_SUPPLIED_REPLAY` and
`designInferenceEligible: false`. It still replays the selected set and shows
the mechanical `k / N` design probability, but it is not a receipt of genuine
random assignment and must not be used for design-based inference.

The input surface is closed. Nomination lists, outcomes, named-coin overrides,
or unknown fields are refused. Catalog response order and unsealed catalog
alias metadata cannot change a selection.

## Observation probability is not action propensity

Every population and annotation row carries both concepts separately:

```js
observationInclusionProbability: k / N,
actionPropensity: {
  state: 'NOT_LOGGED',
  value: null,
  policyVersion: null,
}
```

No code copies `k / N` into action propensity. The current deterministic
downstream policy does not log a prospective randomized action probability,
so this module cannot support inverse-action-propensity or off-policy causal
claims. Observation weights can only describe the sampled catalog population,
and missing outcome response must remain separately visible.

## Records

### Frame

`sealAuditFrame({ catalog, frameTs, knownAtTs, sampleSize, seedHex?, horizonsMs })`
validates the accepted catalog, seals its complete market inventory, performs
selection, and returns a deeply frozen frame. `auditFrameError(frame)` performs
an independent replay and digest check.

The frame contains the full population, selected opportunity IDs, exact
catalog identity and clocks, seed and sampling law, requested horizons,
positive inclusion probability, and `authority: NONE` /
`trainingAuthority: NONE`.

The frame also seals `maxDurableCreationLagMs: 5000`. The store refuses first
creation after that deadline. An annotation's observation `knownAtTs` must be
at or after the store's durable frame-creation clock. Restart therefore cannot
manufacture a historical prospective frame after ticker facts or outcomes may
already be known.

It also seals one target before outcomes exist:

```text
targetVersion: opportunity-audit-simple-return-target-1
metric: SIMPLE_RETURN_PCT
anchor: first verified closed 1m candle open at/after frameTs
terminal: last verified closed 1m candle close at/before frameTs+horizon
classification: favorable > +0.25%, adverse < -0.25%, otherwise neutral
feasibility: DESCRIPTIVE_ONLY_EXECUTION_FEASIBILITY_UNSUPPORTED
```

This is arithmetic percent return, `100 * (terminal / anchor - 1)`, not log
return and not an executable P&L claim. A source implementing a different
target must record `UNSUPPORTED`; it may not silently translate another label.

### Post-filter annotation

`annotateAuditOpportunity({ frame, opportunityId, recordedTs, observation,
nomination, decision, components })` accepts selected opportunities only. It
records evaluated, missing ticker, invalid price, warmup, and unavailable
observation states; nominated, rejected, and not-nominated states; and whether
the later decision boundary was reached. Rejection is therefore retained
instead of disappearing from the learning denominator.

An `EVALUATED` observation must carry a bounded, content-digested feature
evidence record produced with `sealAuditObservationEvidence`. That record
binds the source snapshot digest, feature-recipe version, and exact sorted
feature summaries. Unknown, warmup, invalid, and unavailable features carry a
null value rather than zero. A genuinely absent observation may carry null
evidence; it may not pretend that missing inputs were evaluated.

Component entries contain only sealed component/version/config identity and
availability. They are instrumentation, not component-attribution results.

### Horizon outcome

`attachAuditOutcome({ frame, opportunityId, horizonMs, status, ... })` retains
one of:

- `PENDING`
- `MATURED`
- `MISSING`
- `CENSORED`
- `DELISTED_OR_UNAVAILABLE`
- `UNSUPPORTED`

A matured outcome is bound to the frame's target version and digest, declares
`SIMPLE_RETURN_PCT`, and its favorable/adverse/neutral class is recomputed from
the sealed neutral band. A pending record may be superseded once by one terminal
record. A terminal
missing/unavailable record is immutable; later data is not silently backfilled
as if it were contemporaneously available. Matured rows require a verified
archive reference and explicit known-at clock. Missing is never converted to
zero.

The only diagnostic states are `UNSUPPORTED` and
`MODEL_BASED_DIAGNOSTIC`. The latter requires sealed model/result identities.
It does not claim that the existing fixed-horizon candle round-trip simulator
models Judge sizing, stop/exit, order-book, portfolio, or shared-liquidity
state.

## Local durable port

`openOpportunityAuditStore({ rootDir, clock?, limits? })` opens one exclusive
writer and returns:

```text
createFrame({ frame })
loadFrame(frameId)
appendAnnotation({ frameId, frameDigest, expectedRevision, annotation })
appendOutcome({ frameId, frameDigest, expectedRevision, outcome })
pending({ asOfTs, limit?, cursor? })
status()
close()
```

Mutations are serialized. Each committed state is content-digested, fsynced,
atomically replaced, revision-CAS checked, and compared with the on-disk prior
state immediately before replacement. The store uses a single exclusive
writer lock and provides no age-based stale-lock takeover. Lock loss,
corruption, unexpected files, read-bound breach, disk custody conflict, and I/O
failure latch the store. A failed write cannot be followed by optimistic
progress.

Creating the same frame is idempotent. A different seed for the same catalog
and frame timestamp is a conflict, not a second sample. An annotation is
first-write-wins per selected opportunity. Outcomes are append-only under the
one pending-to-terminal transition. Every bound refuses excess work; nothing
is silently evicted.

`pending` returns only due selected opportunity/horizon targets that have no
terminal outcome. Its cursor is based on immutable frame/opportunity/horizon
identity, so a target becoming terminal between pages does not reset or skip
later identity space.

The store truthfully reports:

```js
{
  scope: 'LOCAL_FILESYSTEM_ONLY',
  republishSafe: false,
  externalArchive: 'UNKNOWN',
}
```

An empty directory means no durable frames, never zero opportunities or a
completed audit. Replit republish durability requires a separately reviewed
external checkpoint/archive integration.

## Optional WideEye adapter (not runtime-wired)

`learning/opportunity-audit-wideeye-port.js` supplies the collector-facing
two-phase interface without importing or changing WideEye:

```text
createOpportunityAuditWideEyePort({
  store, sampleSize, horizonsMs, minFrameIntervalMs,
  wideEyeComponent, maxRememberedFrames, clock
})

beforeSweep({ catalogSnapshot, frameTs }) -> auditToken | null
afterSweep({ auditToken, observation, recordedTs }) -> receipt
status()
```

`beforeSweep` requires a fresh accepted catalog and awaits durable frame
creation. Calls inside the configured cadence return null rather than throwing
and disabling an unrelated collector. A repeated same-process slot reloads
the durable frame and returns the same token. After restart, an attempt to draw
a different seed for an existing catalog/timestamp slot is refused; an exact
previous token can resume its incomplete frame. There is no retrospective
cadence catch-up.

`afterSweep` validates the complete bounded sweep before its first write, then
annotates every selected opportunity. Missing rows, invalid price, and warmup
remain explicit. Evaluated rows seal the exact sweep/row digest and feature
summaries. A RIPPLE/MISSED verdict, cooldown state, or emitted notice is never
translated into nomination: nomination and decision remain `UNAVAILABLE`
until a real downstream source is supplied.

This adapter is intentionally **not safe to wire directly into the collector
yet**. The current durable store serializes synchronous read/fsync/atomic-
replace work. A JavaScript `Promise.race(..., 250ms)` cannot preempt synchronous
filesystem work. On the 2026-09-13 Windows development host, one offline run
with a 612-market frame took about 81ms for `beforeSweep`; annotating eight
selected rows took about 2450ms (one selected row took about 146ms). These are
measurements, not hard upper bounds. `status()` reports
`directCollectorSafe:false` and `requiresWorkerIsolation:true`. Runtime
activation requires a separately reviewed fixed-worker or batch-commit owner,
shutdown/drain protocol, and target-host benchmark within the collector's
latency budget.

## Runtime integration boundary

The runtime owner should call the frame sealer and durably `createFrame`
immediately after accepting the catalog and before requesting or evaluating
ticker rows. Only after that durable receipt exists may the completed sweep
attach observations, nomination/refusal states, and component identities.

The audit hook must be synchronous or explicitly awaited by the owner; it must
not pass a Promise to a callback that ignores returned promises. Failure may
latch audit claims, but it must not fabricate a frame or turn unrelated sensor
collection into trading authority. Sampling cadence and budget are owned by
the runtime policy, not this module.

Current prerequisites outside these owned files remain:

1. A WideEye adapter that supplies one identity row for every catalog member,
   including exact per-market exclusion reasons rather than aggregate counts.
2. A finalized archive reader that proves retained record continuity and
   catalog membership across each requested horizon.
3. Republish-safe external custody if continuity must survive a deployment.
4. A separately randomized and prospectively logged action policy before any
   action-propensity analysis is claimed.

Until those exist, this is a tested local frame/follow-up building block, not a
claim that the production opportunity audit or adaptive trading loop is live.
