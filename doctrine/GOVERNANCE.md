# GOVERNANCE — THE DARK GOVERNANCE SENSE (GOV-1)

**GOVERNANCE is a sense, not a strategy.**

**A passed vote is not the same thing as an executed protocol change.**

**Snapshot is off-chain voting evidence unless independently linked to
execution.**

**Quorum is UNKNOWN when provider semantics do not support a defensible
calculation.**

**Governance identity is explicitly mapped, never guessed from ticker/name
similarity.**

**Governance observations have zero trading authority in GOV-1.**

Serpent listens. Memory remembers. The Brain earns the right to care later.

## 1. What GOV-1 is

A dark sensor that observes governance mechanisms that may matter to crypto
assets before price fully reflects them: proposals appearing, voting
starting, tallies moving, quorum becoming reachable, voting-power
concentrating, proposals passing/failing/being cancelled. It records what
we know, when we knew it, how complete the evidence is, and what remains
unknown. It does not predict, trade, nominate prey, or change stalking.

## 2. Architecture

The established dark-sensor pattern, unchanged:

    provider (Snapshot Hub GraphQL; Tally behind a key)
      -> governance/collector.js  (polling, budgets, lifecycle, emission)
      -> data/governance/events.jsonl  (append-only source truth)
      -> memory mirror tail  ->  pure fromGovernanceEvent adapter
      -> MemoryBus validation -> MemoryStore -> durable PostgreSQL

The collector owns source truth; Memory owns canonicalization. The
collector never publishes into the MemoryBus and imports nothing from
memory/, state/, trading, or the UI. Health lives in
`data/governance/status.json` (atomic writes, no secrets).

## 3. Schema promotion

GOV-1 deliberately promoted the reserved `GOVERNANCE` evidence family into
the accepted enum, and activated the reserved `GOVERNANCE` sourceModule.
One governance observation carrying several correlated metrics — quorum,
margin, concentration, state — is still ONE evidence family, never four
independent confirmations. Canonical event type: `GOVERNANCE_OBSERVATION`
(lifecycle carried in the payload, not as new event types).

## 4. The verified registry (`governance/registry.js`)

Version 1, hard-capped at 64 mapped entities. A symbol reaches a
space/governor ONLY through an explicit `verified: true` entry carrying
provider, spaceId/governorId, scope, and mappingVersion; the mapping
version travels into provenance. The initial set is exactly the five
Snapshot spaces the Childhood deep-memory build already verified (UNI,
CRV, AAVE, ARB, OP) — Childhood itself is untouched and its historical
stream is NOT mirrored into live Memory. Malformed entries are rejected
loudly, never repaired. Governance that cannot be defensibly attached to
one tradable asset keeps `symbol: null`. No ticker guessing, ever.

## 5. Providers

**Snapshot** (first usable provider): bounded GraphQL against
`hub.snapshot.org`. Off-chain governance/voting data, and its provenance
says so. Proposal text is UNTRUSTED DATA: stored as a bounded title
(256B) + bounded body excerpt (2KB) + content hash + provider URL, never
executed or interpreted.

**Tally**: implemented behind `TALLY_API_KEY` only. Missing key ⇒ status
`UNAVAILABLE_MISSING_CREDENTIAL` and ZERO Tally network calls; Snapshot
continues independently. Even with a key, Tally observes nothing until a
verified governorId lands in the registry (none in v1). The key is never
logged, persisted, or placed in config/status/JSONL/Memory/errors. Tally
data is INDEXED on-chain governance — provenance says "indexed", never
"chain-verified".

## 6. Cadence and budgets (named in `GOV_DEFAULTS`)

Governance moves slowly; the sensor polls like it. Discovery ~every 180s,
active-proposal refresh ~every 300s, at most one unchanged-state snapshot
per active proposal per 360s. Hard limits: 60 requests/hour (far under the
provider ceiling), 3s minimum spacing, 15s request timeout, 25-proposal
pages (max 2/cycle), 100-vote pages (max 2/proposal), 24 active proposals
inspected, 40 events/poll, single-flight polling (no overlap), no boot
burst (first poll waits for the first timer tick). Failures: bounded
exponential backoff (30s → 30min); 429 honors Retry-After else 15min.
Provider failure fails dark — nothing else in Serpent is affected. Bad
config bounds fail closed: the sensor disables itself and says why.

## 7. Truth rules

- Lifecycle transitions come only from observed provider state:
  PROPOSAL_DISCOVERED, VOTING_STARTED, STATE_CHANGED, VOTING_ENDED,
  FINAL_TALLY_OBSERVED, PROPOSAL_CANCELLED. Nothing is invented.
- A closed Snapshot proposal with a leading tally is
  PASSED_OFFCHAIN_VOTE-shaped evidence — never EXECUTED. `timelock` and
  `executionState` are UNKNOWN in GOV-1 (no such evidence exists in
  Snapshot data).
- Quorum: only when the provider supplies a positive quorum in the same
  voting-power units as the tally (`quorumRequired`, `quorumObserved`,
  `quorumProgressRatio`). Otherwise UNKNOWN — never zero, never a
  vote-sum invention.
- Trajectory: descriptive measurements only (per-choice scores, total
  observed power, voter count, time remaining, deltas vs the prior
  observation). Support/opposition ratios exist only for exactly
  canonical For/Against(/Abstain) choice labels. No momentumSignal, no
  bullish/bearish, no confidence, no edge, no prediction.
- Concentration (top1/top5 voting-power share, observed voter count)
  describes the votes actually FETCHED under the page budget. Incomplete
  pagination ⇒ `coverage: PARTIAL` with a reason; missing vote power ⇒
  UNAVAILABLE. Never labeled exhaustive when it is not.
- Every bounded retrieval preserves coverage truth
  (COMPLETE / PARTIAL_PAGE_LIMIT / UNAVAILABLE).
- Duplicate unchanged polls are suppressed and counted, not re-written.
  Deterministic identity (source-record fingerprint) makes replay
  deduplicate while any meaningful state change mints a new identity.

## 8. Point-in-time truth

`ts`/`retrievedTs` on every source record mark when Serpent could actually
know; the adapter carries them as sourceTs/availableTs, and Memory
ingestion time stays separate. A proposal is never visible before
retrieval; a final tally never appears before final provider
availability; queued/executed states never appear before a provider
reports them (and no GOV-1 provider does). No hindsight leakage.

## 9. Darkness (non-negotiable)

GOVERNANCE has zero influence on attention tiers, Wide Eye, RUMINT,
stalking, posture, STRIKE/DIGESTING, prediction, ledger, cost, sizing,
entries, exits, execution eligibility, or controls. No trading-side module
imports GOVERNANCE output (enforced by import-scan tests). No UI work: no
button, no orbit change, no drawer. GOV-1 listens and remembers; it does
not vote.

## 10. Enabling

The sensor ships dark: `cobra.config.json` carries no `governance` section
and the sha-sealed config is untouched, so `governance.enabled !== true`
and startGovernance() is a zero-network no-op. To enable in an
environment that owns its config, add `"governance": { "enabled": true }`
(all other bounds default from `GOV_DEFAULTS` and validate fail-closed).

## 11. Known limitations (v1)

- Snapshot only in practice; Tally is keyed, dark, and has no verified
  governor mapping yet.
- Quorum semantics are provider-declared; spaces without a declared
  quorum stay UNKNOWN forever.
- Concentration reflects up to 200 top-power votes per proposal per
  refresh (2 pages x 100, ordered by voting power descending).
- Closed/cancelled proposals stop being polled once final truth is
  captured; retention/compaction of governance Memory is the global
  Memory retention ticket, not GOV-1.
- At the GOV-1 development drill (2026-09-04) the hub no longer resolves
  `aave.eth` (Aave has migrated off Snapshot); the mapping remains the
  verified historical identity and the provider truthfully returns
  nothing for it. A future registry version may retire it or add an
  on-chain (Tally) governor mapping instead.
