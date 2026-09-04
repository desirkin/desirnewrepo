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

## 7b. Collector truth hardening (GOV-1A)

- **Durable acknowledgement.** A governance event counts only after its
  source JSONL append actually succeeded. The per-poll event cap and
  write failures POSTPONE evidence into a bounded pending queue (512
  entries; snapshot-kind entries are evicted before lifecycle evidence)
  — they never erase it, and proposal state/finality never advances past
  evidence that was neither written nor safely queued. A proposal is
  acknowledged final only after its final evidence is appended; only then
  is its heavy state released into a compact bounded final-ID cache
  (256 ids) that also prevents rediscovery.
- **Spacing is not budget.** Minimum request spacing decides WHEN a
  permitted request happens (bounded waits); only the hourly budget and
  backoff deny. Partial vote evidence already retrieved is kept and
  described as PARTIAL with its exact stop reason (PAGE_LIMIT,
  REQUEST_BUDGET, BACKOFF_ACTIVE, PROVIDER_ERROR); UNAVAILABLE means
  nothing usable was retrieved.
- **Restart-safe (GOV-1B).** The SOURCE STREAM IS A WRITE-AHEAD TRUTH
  LOG: every appended event carries a monotonic `seq` cursor and a hashed
  structured `sourceEventId` (canonical key-sorted basis over provider,
  entity, proposal, kind, lifecycle, state, state fingerprint, provider
  update time, observation time — no delimiter joining, so provider ids
  containing separators can never collapse two tuples into one identity).
  The checkpoint (per-proposal state/fingerprint/cadence/measured tallies,
  pending evidence, final-ID cache, and the `lastSeq` cursor) is an
  acceleration snapshot that MAY LAG the log but may never rewrite it: at
  startup the collector restores the checkpoint, then reconciles forward
  by replaying validated source records beyond the cursor (bounded to the
  log tail; torn lines counted; provider truth never invented) before any
  polling. A crash between a successful append and the checkpoint save
  therefore cannot re-create an already-appended lifecycle as a different
  historical record. Checkpoints are STRICTLY validated before use; a
  malformed one is withheld, DEGRADED is reported, and state rebuilds
  from source truth — never guessed, never fatal to the rest of Serpent.
- **Durable checkpoint.** Deployment disk is ephemeral, so the checkpoint
  is also written to the durable PostgreSQL core through a tiny injected
  store (composition-root wiring; the collector knows only load()/save()).
  The durable copy is the restart/redeploy authority when configured and
  valid; the local atomic file remains the fast fallback. STORAGE ONLY —
  it is not, and must never become, a decision return path.
- **Honest durability boundary.** Restart-safe pending debt is guaranteed
  only once at least one durable representation succeeded. When the
  source append, the local checkpoint, AND the durable checkpoint all
  fail while evidence is owed, that evidence exists only in RAM: status
  reports `FAILED_DURABILITY` with `unpersistedPendingEvidence` — GOV
  says "I have unpersisted evidence", never "don't worry, I remembered
  it". No third store exists; a hard crash at that exact moment loses it.
- **Bounded loss is named.** At sustained durability failure the hard
  pending cap may force dropping a lower-priority observation
  (snapshot-kind before lifecycle). That is DATA LOSS even when explicit:
  it is counted, identified by kind and reason (`lastEvidenceDrop`),
  degrades health, is never called successfully remembered, never lets
  tracked state advance past it, and can never create an id/content
  conflict when provider truth is observed again later.
- **Pending proposals are observed.** Discovery covers Snapshot's
  `pending` state as well as `active`, so the ordinary pending → active
  chronology produces a real VOTING_STARTED.
- **Cap honesty.** Proposals skipped at the active-proposal cap mark the
  cycle `PARTIAL_ACTIVE_PROPOSAL_CAP` with explicit
  proposalsObserved/proposalsSkippedAtActiveCap counters — a complete
  provider page never implies complete processing.
- **Exact canonical choice set.** Support/opposition ratios require the
  ENTIRE choice set to be canonical: exactly one FOR-class label, exactly
  one AGAINST-class label, at most one ABSTAIN-class label, no other
  choices, no duplicate semantics, matching choices/scores lengths.
  Anything else keeps verbatim scoresByChoice and ratios UNKNOWN.
- **Numeric truth (GOV-1B).** Vote power, scores, totals, counts, and
  quorum are non-negative quantities: an impossible finite negative from
  the provider is INVALID and becomes UNKNOWN, never preserved or
  repaired. Ratios additionally require internal consistency (powers not
  above the total beyond a 1e-6 relative tolerance, results in [0,1]);
  inconsistent provider totals keep their raw values with ratios UNKNOWN.
  Quorum progress legitimately exceeds 1 when quorum is surpassed — it is
  never clamped.
- **Unique provider identity (GOV-1B).** One Snapshot space or Tally
  governor maps to at most one registry entry; a conflicting duplicate is
  rejected explicitly (first verified mapping stands, deterministically)
  — no silent overwrite, and lookups never depend on input order.
- **Final-cache guarantee, stated exactly.** A finalized proposal is not
  re-discovered WHILE its id is retained in the bounded final-ID cache
  (256). Discovery only queries pending/active states, so a closed
  proposal normally never resurfaces anyway. If a provider resurfaces one
  after eviction, the new observation is a new re-observed fact with its
  own honest identity: old canonical history is never overwritten and no
  id/content conflict can result. Unlimited final-proposal retention does
  not exist and is not claimed.
- **Strict config.** Booleans must be booleans; integer bounds must be
  positive integers inside documented hard maxima;
  `governance.maxMappedSymbols` is enforced on the loaded registry under
  the absolute 64 ceiling. Malformed config fails GOV closed; nothing
  else in Serpent fails.
- **Tally is scaffolding.** No Tally collector exists in GOV-1: with a
  key and a verified governor mapping the status truthfully reads
  `UNAVAILABLE_COLLECTOR_NOT_IMPLEMENTED` — never a suggestion that
  collection will occur.

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
